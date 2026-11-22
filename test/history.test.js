const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listSessions, pendingSessions, transferEach, transferSession: transferRaw, transferWorkspace: workspaceRaw, safe } = require('../src/history');
const storage = require('../src/storage');
const id = '12345678-1234-1234-1234-123456789abc';
const project = 'test-project';
const relative = path.join('projects', project, id + '.jsonl');
const transcript = content => JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), message: { role: 'user', content } }) + '\n';
// Every transfer needs the switcher root; tests use a temp one per fixture.
// These tests cover copy-based switching (link: false), the fallback path (T3);
// linked transfers are tested in links.test.js.
const current = {};
const transferSession = (a, b, s) => transferRaw(a, b, s, { switcherRoot: current.store, link: false });
const transferWorkspace = (a, b, s) => workspaceRaw(a, b, s, { switcherRoot: current.store, link: false });
const each = (a, b, s) => transferEach(a, b, s, { switcherRoot: current.store, link: false });
async function fixture(t) {
  const base = path.join(__dirname, '..', '.test-tmp');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  current.store = path.join(root, 'switcher');
  await fs.mkdir(path.join(source, 'projects', project), { recursive: true });
  await fs.mkdir(destination);
  await fs.writeFile(path.join(source, relative), transcript('first'));
  return { root, source, destination, store: current.store, session: { id, project, cwd: process.cwd() } };
}
test('round trip preserves same session ID and source bytes; a superseded prefix is not stored', async t => {
  const { source, destination, store, session } = await fixture(t);
  const first = await transferSession(source, destination, session);
  assert.equal(await fs.readFile(path.join(source, relative), 'utf8'), transcript('first'));
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), transcript('first'));
  assert.equal(JSON.parse(await fs.readFile(first.backup)).state, 'committed');
  const continued = transcript('first') + transcript('continued in second account');
  await fs.writeFile(path.join(destination, relative), continued);
  const second = await transferSession(destination, source, session);
  assert.equal(second.id, id);
  assert.equal(await fs.readFile(path.join(source, relative), 'utf8'), continued);
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), continued);
  const manifest = JSON.parse(await fs.readFile(second.backup));
  assert.equal(manifest.state, 'committed');
  assert.deepEqual(manifest.objects, []);
  assert.equal(manifest.pinned, false);
  assert.deepEqual(await storage.storedObjects(store), []);
});
test('copy-based switching keeps no incoming snapshot and stores a diverged previous once, pinned', async t => {
  const { source, destination, store, session } = await fixture(t);
  await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  const branch = transcript('destination-only branch');
  await fs.writeFile(path.join(destination, relative), branch);
  const first = await transferSession(source, destination, session);
  const manifest = JSON.parse(await fs.readFile(first.backup));
  assert.equal(manifest.pinned, true);
  assert.deepEqual(manifest.objects.map(o => [o.name, o.reason]), [[relative, 'diverged']]);
  assert.equal((await storage.readObject(store, manifest.objects[0].sha256)).toString('utf8'), branch);
  // The same diverged version again is stored once.
  await fs.writeFile(path.join(destination, relative), branch);
  const second = await transferSession(source, destination, session);
  assert.equal(JSON.parse(await fs.readFile(second.backup)).objects[0].sha256, manifest.objects[0].sha256);
  assert.deepEqual(await storage.storedObjects(store), [manifest.objects[0].sha256]);
  // Nothing is staged inside the profile and no temp or aside entries remain.
  await assert.rejects(fs.access(path.join(destination, '.profile-switch-backups')));
  assert.deepEqual(await fs.readdir(path.join(destination, 'projects', project)), [id + '.jsonl']);
  assert.deepEqual(await fs.readdir(destination), ['projects']);
});
test('files only in the destination bundle are kept in the object store', async t => {
  const { source, destination, store, session } = await fixture(t);
  const extra = path.join('file-history', id, 'only-here');
  await fs.mkdir(path.dirname(path.join(destination, extra)), { recursive: true });
  await fs.writeFile(path.join(destination, extra), 'unique checkpoint');
  const result = await transferSession(source, destination, session);
  const manifest = JSON.parse(await fs.readFile(result.backup));
  assert.deepEqual(manifest.objects.map(o => o.name), [extra]);
  assert.equal((await storage.readObject(store, manifest.objects[0].sha256)).toString('utf8'), 'unique checkpoint');
  await assert.rejects(fs.access(path.join(destination, 'file-history', id)));
});
test('every transfer refuses while a migration is in progress', async t => {
  const { source, destination, store, session } = await fixture(t);
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(path.join(store, 'migration.json'), JSON.stringify({ kind: 'migration', state: 'running', profiles: [] }));
  await assert.rejects(transferSession(source, destination, session), /in progress/);
  await assert.rejects(transferWorkspace(source, destination, [session]), /in progress/);
  await assert.rejects(each(source, destination, [session]), /in progress/);
  await assert.rejects(fs.access(path.join(destination, 'projects')));
});
test('copies selected session sidecars and checkpoints, not credentials or other sessions', async t => {
  const { source, destination, session } = await fixture(t);
  for (const file of [path.join('projects', project, id, 'subagents', 'agent-one.jsonl'), path.join('file-history', id, 'snapshot')]) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), 'fixture');
  }
  await fs.writeFile(path.join(source, '.credentials.json'), 'do-not-copy');
  await transferSession(source, destination, session);
  assert.equal(await fs.readFile(path.join(destination, 'file-history', id, 'snapshot'), 'utf8'), 'fixture');
  await assert.rejects(fs.access(path.join(destination, '.credentials.json')));
});
test('invalid partial transcript fails without touching destination history', async t => {
  const { source, destination, session } = await fixture(t);
  await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await fs.writeFile(path.join(destination, relative), 'existing');
  await fs.appendFile(path.join(source, relative), '{partial');
  await assert.rejects(transferSession(source, destination, session), /Incomplete/);
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), 'existing');
  await assert.rejects(fs.access(path.join(destination, '.profile-switch-lock')));
});
test('session picker filters to open project and sorts newest first', async t => {
  const { source } = await fixture(t);
  const sessions = await listSessions(source, [process.cwd()]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, id);
  assert.deepEqual(await listSessions(source, [path.join(os.tmpdir(), 'different-project')]), []);
});
test('session that later cd-ed into a subfolder is still listed for its workspace', async t => {
  const { source } = await fixture(t);
  const moved = JSON.stringify({ type: 'assistant', sessionId: id, cwd: path.join(process.cwd(), 'src'), message: { role: 'assistant', content: 'ok' } }) + '\n';
  await fs.appendFile(path.join(source, relative), moved);
  const sessions = await listSessions(source, [process.cwd()]);
  assert.deepEqual(sessions.map(s => s.id), [id]);
  assert.equal(sessions[0].cwd, process.cwd());
  assert.deepEqual(await listSessions(source, [process.cwd() + '-sibling']), []);
});
test('pending sessions cover every project and only those missing or newer in the destination', async t => {
  const { source, destination, session } = await fixture(t);
  const otherId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', otherProject = 'other-project';
  const other = JSON.stringify({ type: 'user', sessionId: otherId, cwd: path.join(os.tmpdir(), 'elsewhere'), message: { role: 'user', content: 'hi' } }) + '\n';
  await fs.mkdir(path.join(source, 'projects', otherProject), { recursive: true });
  await fs.writeFile(path.join(source, 'projects', otherProject, otherId + '.jsonl'), other);
  assert.deepEqual((await pendingSessions(source, destination)).map(s => s.id).sort(), [id, otherId].sort());
  await transferSession(source, destination, session);
  assert.deepEqual((await pendingSessions(source, destination)).map(s => s.id), [otherId]);
  // A copy is newer on disk but identical: it must not flow back.
  assert.deepEqual((await pendingSessions(destination, source)).map(s => s.id), []);
  // New activity in the source makes the session pending again.
  await fs.appendFile(path.join(source, relative), transcript('continued'));
  const later = new Date(Date.now() + 5000);
  await fs.utimes(path.join(source, relative), later, later);
  assert.deepEqual((await pendingSessions(source, destination)).map(s => s.id).sort(), [id, otherId].sort());
});
test('transferEach copies the rest when one conversation cannot be copied', async t => {
  const { source, destination, session } = await fixture(t);
  const { copied, skipped } = await each(source, destination, [{ ...session, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }, session]);
  assert.deepEqual(copied.map(s => s.id), [id]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /no longer exists/);
});
test('rejects traversal and concurrent transfer locks', async t => {
  const { source, destination, session } = await fixture(t);
  await assert.rejects(transferSession(source, destination, { ...session, project: '..' }), /Invalid/);
  await fs.mkdir(path.join(destination, '.profile-switch-lock'));
  await assert.rejects(transferSession(source, destination, session), /Another transfer/);
});
test('metadata-only startup records do not block copying real workspace conversations', async t => {
  const { source, destination } = await fixture(t);
  const emptyId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const emptyPath = path.join(source, 'projects', project, `${emptyId}.jsonl`);
  const metadata = JSON.stringify({ type: 'system', cwd: process.cwd(), sessionId: emptyId }) + '\n';
  await fs.writeFile(emptyPath, metadata);
  const sessions = await listSessions(source, [process.cwd()]);
  assert.deepEqual(sessions.map(s => s.id), [id]);
  await transferWorkspace(source, destination, sessions);
  assert.equal(await fs.readFile(emptyPath, 'utf8'), metadata);
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), transcript('first'));
});
test('rejects directory junctions without modifying linked history', async t => {
  const { root, source, destination, session } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(destination, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(transferSession(source, destination, session), /Linked history/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('commit failure rolls back the previous destination transcript', async t => {
  const { source, destination, session } = await fixture(t);
  await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await fs.writeFile(path.join(destination, relative), transcript('destination branch'));
  const sidecar = path.join(source, 'projects', project, id);
  await fs.mkdir(sidecar);
  await fs.writeFile(path.join(sidecar, 'data.json'), '{}');
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from).startsWith(`${id}.tmp-`)) throw new Error('Simulated disk failure');
    return originalRename(from, to);
  });
  await assert.rejects(transferSession(source, destination, session), /Simulated/);
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), transcript('destination branch'));
  assert.equal(await fs.readFile(path.join(source, relative), 'utf8'), transcript('first'));
  assert.deepEqual(await fs.readdir(path.join(destination, 'projects', project)), [id + '.jsonl']);
  await assert.rejects(fs.access(path.join(destination, '.profile-switch-lock')));
});
test('workspace switch carries multiple chats without identifying the active tab', async t => {
  const { source, destination, session } = await fixture(t);
  const secondId = '22345678-1234-1234-1234-123456789abc';
  await fs.writeFile(path.join(source, 'projects', project, secondId + '.jsonl'), transcript('second chat').replaceAll(id, secondId));
  const sessions = await listSessions(source, [process.cwd()]);
  const copied = await transferWorkspace(source, destination, sessions);
  assert.equal(copied.length, 2);
  for (const s of sessions) {
    const file = path.join('projects', project, s.id + '.jsonl');
    assert.deepEqual(await fs.readFile(path.join(destination, file)), await fs.readFile(path.join(source, file)));
  }
  assert.equal(session.id, id);
});
test('workspace preflight rejects malformed later history before copying any chat', async t => {
  const { source, destination, session } = await fixture(t);
  const second = { ...session, id: '22345678-1234-1234-1234-123456789abc' };
  await fs.writeFile(path.join(source, 'projects', project, second.id + '.jsonl'), '{bad');
  await assert.rejects(transferWorkspace(source, destination, [session, second]), /Incomplete/);
  assert.deepEqual(await fs.readdir(destination), []);
});

// A switcher root with two profiles joined to shared storage through junctions.
async function pool(t) {
  const { root, source, store } = await fixture(t);
  const shared = path.join(store, 'shared');
  const [a, b] = ['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'].map(n => path.join(store, 'profiles', n));
  for (const name of storage.SHAREABLE) await fs.mkdir(path.join(shared, name), { recursive: true });
  await fs.mkdir(path.join(shared, 'projects', project));
  await fs.writeFile(path.join(shared, relative), transcript('shared'));
  for (const profile of [a, b]) {
    await fs.mkdir(profile, { recursive: true });
    for (const name of storage.SHAREABLE) await fs.symlink(path.join(shared, name), path.join(profile, name), 'junction');
  }
  return { root, store, shared, a, b, source, session: { id, project, cwd: process.cwd() } };
}
async function snapshot(dir) {
  const out = [];
  async function visit(d) {
    for (const name of (await fs.readdir(d)).sort()) {
      const p = path.join(d, name), s = await fs.lstat(p);
      out.push(`${path.relative(dir, p)}:${s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : `${s.size}:${s.mtimeMs}`}`);
      if (s.isDirectory() && !s.isSymbolicLink()) await visit(p);
    }
  }
  await visit(dir);
  return out.join('\n');
}
test('switching between pool profiles copies nothing, even after 20 switches', async t => {
  const { store, a, b, session } = await pool(t);
  const before = await snapshot(store);
  const options = { switcherRoot: store };
  for (let i = 0; i < 20; i++) {
    const [from, to] = i % 2 ? [b, a] : [a, b];
    assert.deepEqual(await pendingSessions(from, to, options), []);
    assert.equal((await transferRaw(from, to, session, options)).shared, true);
    assert.deepEqual((await workspaceRaw(from, to, [session], options)).map(s => s.backup), [null]);
    assert.deepEqual(await transferEach(from, to, [session], options), { copied: [], skipped: [], shared: true });
  }
  assert.equal(await snapshot(store), before);
  // Both members list the shared conversation through their junction.
  assert.deepEqual((await listSessions(a, [process.cwd()], options)).map(s => s.id), [id]);
  assert.deepEqual((await listSessions(b, [process.cwd()], options)).map(s => s.id), [id]);
});
test('a copy into a pool member writes shared storage under the store lock', async t => {
  const { store, shared, a, b, source, session } = await pool(t);
  await fs.writeFile(path.join(source, relative), transcript('shared') + transcript('more from Default'));
  const release = await storage.acquireStoreLock(store, 'test holder', { wait: 0 });
  const blocked = transferRaw(source, a, session, { switcherRoot: store });
  // While another holder has the lock the transfer waits, then completes.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await fs.readFile(path.join(shared, relative), 'utf8'), transcript('shared'));
  await release();
  await blocked;
  assert.equal(await fs.readFile(path.join(shared, relative), 'utf8'), transcript('shared') + transcript('more from Default'));
  assert.equal(await fs.readFile(path.join(b, relative), 'utf8'), transcript('shared') + transcript('more from Default'));
  await assert.rejects(fs.access(path.join(a, '.profile-switch-lock')));
  await assert.rejects(fs.access(path.join(store, '.storage-lock')));
});
test('safe() accepts only the exact managed junction', async t => {
  const { root, store, shared, a } = await pool(t);
  const options = { switcherRoot: store };
  assert.equal(await safe(a, relative, options), path.join(a, relative));
  // Without the switcher root, or for a different root, links stay rejected.
  await assert.rejects(safe(a, relative), /Linked/);
  await assert.rejects(safe(a, relative, { switcherRoot: path.join(root, 'elsewhere') }), /Linked/);
  // projects pointing at shared/file-history.
  const c = path.join(store, 'profiles', 'cccccccc-0000-0000-0000-000000000003');
  await fs.mkdir(c);
  await fs.symlink(path.join(shared, 'file-history'), path.join(c, 'projects'), 'junction');
  await assert.rejects(safe(c, relative, options), /Linked/);
  // A wrong target outside shared/.
  const d = path.join(store, 'profiles', 'dddddddd-0000-0000-0000-000000000004');
  await fs.mkdir(path.join(d), { recursive: true });
  await fs.mkdir(path.join(root, 'outside'));
  await fs.symlink(path.join(root, 'outside'), path.join(d, 'projects'), 'junction');
  await assert.rejects(safe(d, relative, options), /Linked/);
  // A deeper link inside a private projects folder.
  const e = path.join(store, 'profiles', 'eeeeeeee-0000-0000-0000-000000000005');
  await fs.mkdir(path.join(e, 'projects'), { recursive: true });
  await fs.symlink(path.join(shared, 'projects', project), path.join(e, 'projects', project), 'junction');
  await assert.rejects(safe(e, relative, options), /Linked/);
  // A link inside shared/ is rejected even through the managed junction.
  await fs.symlink(path.join(root, 'outside'), path.join(shared, 'projects', 'linked-project'), 'junction');
  await assert.rejects(safe(a, path.join('projects', 'linked-project', 'x.jsonl'), options), /Linked/);
  // The managed junction is only accepted for switcher profiles, not Default-like roots.
  const outsider = path.join(root, 'default-like');
  await fs.mkdir(outsider);
  await fs.symlink(path.join(shared, 'projects'), path.join(outsider, 'projects'), 'junction');
  await assert.rejects(safe(outsider, relative, options), /Linked/);
});

test('a destination write after the fingerprint check is stored before the old version is removed', async t => {
  const { source, destination, store, session } = await fixture(t);
  await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await fs.writeFile(path.join(destination, relative), transcript('first'));
  const late = transcript('first') + transcript('appended while waiting for the store lock');
  const original = storage.writeManifest;
  let calls = 0;
  t.mock.method(storage, 'writeManifest', async (...args) => {
    if (calls++ === 0) await fs.writeFile(path.join(destination, relative), late);
    return original(...args);
  });
  const result = await transferSession(source, destination, session);
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), transcript('first'));
  const manifest = JSON.parse(await fs.readFile(result.backup));
  assert.equal(manifest.pinned, true);
  const entry = manifest.objects.find(o => o.reason === 'written during transfer');
  assert.equal((await storage.readObject(store, entry.sha256)).toString('utf8'), late);
  assert.deepEqual(await fs.readdir(path.join(destination, 'projects', project)), [id + '.jsonl']);
});
test('rollback stores a write into an installed target before removing it', async t => {
  const { source, destination, store, session } = await fixture(t);
  await fs.mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
  await fs.writeFile(path.join(destination, relative), transcript('destination branch'));
  const sidecar = path.join(source, 'projects', project, id);
  await fs.mkdir(sidecar);
  await fs.writeFile(path.join(sidecar, 'data.json'), '{}');
  const written = transcript('first') + transcript('written into the new copy');
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from).startsWith(`${id}.tmp-`)) {
      await fs.writeFile(path.join(destination, relative), written);
      throw new Error('Simulated disk failure');
    }
    return originalRename(from, to);
  });
  await assert.rejects(transferSession(source, destination, session), /Simulated/);
  assert.equal(await fs.readFile(path.join(destination, relative), 'utf8'), transcript('destination branch'));
  const { manifests } = await storage.readManifests(store);
  const entry = manifests.flatMap(m => m.objects).find(o => o.reason === 'written during failed transfer');
  assert.equal((await storage.readObject(store, entry.sha256)).toString('utf8'), written);
  assert.equal(manifests.find(m => m.objects.includes(entry) || m.objects.some(o => o.sha256 === entry.sha256)).state, 'rolled-back');
  await assert.rejects(fs.access(path.join(destination, '.profile-switch-lock')));
});
test('a failed pool-transfer recovery leaves a durable marker that blocks pool transfers', async t => {
  const { store, a, b, source, session } = await pool(t);
  await fs.writeFile(path.join(source, relative), transcript('shared') + transcript('more'));
  const sidecar = path.join(source, 'projects', project, id);
  await fs.mkdir(sidecar);
  await fs.writeFile(path.join(sidecar, 'data.json'), '{}');
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from).startsWith(`${id}.tmp-`)) throw new Error('Simulated disk failure');
    if (from.includes('.old-')) throw new Error('Simulated restore failure');
    return originalRename(from, to);
  });
  await assert.rejects(transferRaw(source, a, session, { switcherRoot: store }), /recovery required/);
  t.mock.restoreAll();
  const marker = await storage.readRecovery(store);
  assert.equal(marker.length, 1);
  assert.match(marker[0].recoveryError, /restore failure/);
  // The store lock is released; the marker blocks pool transfers instead.
  assert.equal(await storage.readStoreLock(store), null);
  await assert.rejects(transferRaw(source, b, session, { switcherRoot: store }), /needs recovery/);
  await assert.rejects(transferRaw(b, source, session, { switcherRoot: store }), /needs recovery/);
  assert.equal((await storage.verify({ switcherRoot: store, profiles: [] })).ok, false);
  await storage.resolveRecovery(store, { confirm: true, ids: marker.map(storage.recoveryId) });
  await assert.rejects(fs.access(path.join(store, 'transfer-recovery.json')));
});

// ---- Windows long paths (260+ characters) ----------------------------------

// Source, destination and a switcher root under a deep folder, with a long
// project folder name and subagent transcripts, as Claude creates them.
async function deepFixture(t) {
  const base = path.join(__dirname, '..', '.test-tmp');
  await fs.mkdir(base, { recursive: true });
  const top = await fs.mkdtemp(path.join(base, 'history-long-'));
  t.after(() => fs.rm(top, { recursive: true, force: true }));
  let root = top;
  while (root.length < 170) root = path.join(root, 'deep-folder-segment-0123456789');
  const longProject = 'c--Git-Projects-' + 'VeryLongProjectFolderName-'.repeat(3) + 'end';
  const store = path.join(root, 'switcher');
  const source = path.join(root, 'source-profile'), destination = path.join(root, 'destination-profile');
  const transcriptFile = root => path.join(root, 'projects', longProject, `${id}.jsonl`);
  const subagent = root => path.join(root, 'projects', longProject, id, 'subagents', 'agent-a17bb5405ef8f18d8aaaaaaaaaaaaaaa.jsonl');
  const checkpoint = root => path.join(root, 'file-history', id, 'checkpoint-with-a-long-name-0123456789');
  for (const [file, data] of [[transcriptFile(source), transcript('first')], [subagent(source), 'subagent line\n'], [checkpoint(source), 'checkpoint']]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
  await fs.mkdir(destination, { recursive: true });
  return { root, store, source, destination, longProject, transcriptFile, subagent, checkpoint, session: { id, project: longProject, cwd: process.cwd() } };
}

test('long paths: copy-based transfers with a long project folder and subagents', async t => {
  const f = await deepFixture(t);
  assert.ok(f.subagent(f.destination).length > 300, `subagent path is ${f.subagent(f.destination).length} characters`);
  const options = { switcherRoot: f.store, link: false };
  assert.deepEqual((await pendingSessions(f.source, f.destination, options)).map(s => s.id), [id]);
  const first = await transferRaw(f.source, f.destination, f.session, options);
  assert.equal(await fs.readFile(f.transcriptFile(f.destination), 'utf8'), transcript('first'));
  assert.equal(await fs.readFile(f.subagent(f.destination), 'utf8'), 'subagent line\n');
  assert.equal(await fs.readFile(f.checkpoint(f.destination), 'utf8'), 'checkpoint');
  assert.equal(JSON.parse(await fs.readFile(first.backup)).state, 'committed');
  // A diverged destination version at a long path is stored in the recovery store.
  await fs.writeFile(f.subagent(f.destination), 'destination-only subagent line\n');
  const second = await transferRaw(f.source, f.destination, f.session, options);
  const manifest = JSON.parse(await fs.readFile(second.backup));
  assert.equal(manifest.pinned, true);
  assert.equal((await storage.readObject(f.store, manifest.objects[0].sha256)).toString('utf8'), 'destination-only subagent line\n');
  assert.deepEqual((await fs.readdir(path.dirname(f.transcriptFile(f.destination)))).sort(), [id, `${id}.jsonl`].sort());
  assert.deepEqual((await workspaceRaw(f.source, f.destination, [f.session], options)).length, 1);
  assert.deepEqual((await transferEach(f.source, f.destination, [f.session], options)).skipped, []);
});

test('long paths: a copy into shared storage, and a failed recovery with long .old- paths', async t => {
  const f = await deepFixture(t);
  const shared = path.join(f.store, 'shared');
  const member = path.join(f.store, 'profiles', 'aaaaaaaa-0000-0000-0000-000000000001');
  for (const name of storage.SHAREABLE) await fs.mkdir(path.join(shared, name), { recursive: true });
  await fs.mkdir(member, { recursive: true });
  for (const name of storage.SHAREABLE) await fs.symlink(path.join(shared, name), path.join(member, name), 'junction');
  const options = { switcherRoot: f.store };
  await transferRaw(f.source, member, f.session, options);
  assert.equal(await fs.readFile(path.join(shared, 'projects', f.longProject, id, 'subagents', 'agent-a17bb5405ef8f18d8aaaaaaaaaaaaaaa.jsonl'), 'utf8'), 'subagent line\n');
  assert.equal(await fs.readFile(f.subagent(member), 'utf8'), 'subagent line\n');
  // Force a failure whose own rollback also fails: the marker keeps long .old- paths.
  await fs.appendFile(f.transcriptFile(f.source), transcript('more'));
  const originalRename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from).startsWith(`${id}.tmp-`)) throw new Error('Simulated disk failure');
    if (from.includes('.old-')) throw new Error('Simulated restore failure');
    return originalRename(from, to);
  });
  await assert.rejects(transferRaw(f.source, member, f.session, options), /recovery required/);
  t.mock.restoreAll();
  const marker = await storage.readRecovery(f.store);
  assert.equal(marker.length, 1);
  assert.ok(marker[0].asides.length > 0 && marker[0].asides.every(a => a.length > 260 && a.includes('.old-')));
  for (const aside of marker[0].asides) assert.ok((await fs.lstat(aside)).isFile() || (await fs.lstat(aside)).isDirectory());
  assert.equal((await storage.verify({ switcherRoot: f.store, profiles: [] })).ok, false);
  await assert.rejects(transferRaw(f.source, member, f.session, options), /needs recovery/);
  await storage.resolveRecovery(f.store, { confirm: true, ids: marker.map(storage.recoveryId) });
  assert.equal(await storage.readRecovery(f.store), null);
});
