const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../src/storage');
const { listSessions, transferSession } = require('../src/history');

const line = (id, text) => JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), message: { role: 'user', content: text } }) + '\n';
const S1 = '11111111-1111-1111-1111-111111111111', S2 = '22222222-2222-2222-2222-222222222222', S3 = '33333333-3333-3333-3333-333333333333';
const stopped = { detect: async () => [], alive: () => false };
const A_ID = 'aaaaaaaa-0000-0000-0000-00000000000a', B_ID = 'bbbbbbbb-0000-0000-0000-00000000000b';

async function write(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); }
async function read(file) { return fs.readFile(file, 'utf8'); }
async function exists(file) { return !!(await fs.lstat(file).catch(() => null)); }
async function tree(dir) {
  const out = {};
  async function visit(d, base) {
    for (const name of (await fs.readdir(d)).sort()) {
      const p = path.join(d, name), rel = base ? `${base}/${name}` : name, s = await fs.stat(p);
      if (s.isDirectory()) await visit(p, rel); else out[rel] = await read(p);
    }
  }
  await visit(dir, '');
  return out;
}
// Two switcher profiles with overlapping history, plus a Default-like folder.
// With deep, the switcher root sits under nested folders so that ordinary
// history paths are longer than 260 characters (Windows MAX_PATH).
async function env(t, { deep = false } = {}) {
  const base = path.join(__dirname, '..', '.test-tmp');
  await fs.mkdir(base, { recursive: true });
  const top = await fs.mkdtemp(path.join(base, 'storage-'));
  t.after(() => fs.rm(top, { recursive: true, force: true }));
  let root = top;
  while (deep && root.length < 200) root = path.join(root, 'deep-folder-segment-0123456789');
  await fs.mkdir(root, { recursive: true });
  const store = path.join(root, 'switcher');
  const a = { id: A_ID, name: 'A', directory: path.join(store, 'profiles', A_ID) };
  const b = { id: B_ID, name: 'B', directory: path.join(store, 'profiles', B_ID) };
  const proj = (p, ...parts) => path.join(p.directory, 'projects', 'proj', ...parts);
  await write(proj(a, `${S1}.jsonl`), line(S1, 'one'));
  await write(proj(b, `${S1}.jsonl`), line(S1, 'one') + line(S1, 'two'));
  await write(proj(b, `${S2}.jsonl`), line(S2, 'b only'));
  await write(proj(a, `${S3}.jsonl`), line(S3, 'a branch'));
  await write(proj(b, `${S3}.jsonl`), line(S3, 'b branch, longer'));
  await write(path.join(a.directory, 'file-history', S1, 'snap'), 'checkpoint');
  await write(path.join(b.directory, 'file-history', S1, 'snap'), 'checkpoint');
  await write(path.join(a.directory, 'image-cache', S1, 'img.png'), 'png');
  for (const p of [a, b]) {
    await write(path.join(p.directory, '.credentials.json'), `secret-${p.name}`);
    await write(path.join(p.directory, 'settings.json'), JSON.stringify({ cleanupPeriodDays: p === a ? 30 : 14 }));
  }
  return { root, store, a, b, proj };
}
const run = (e, extra = {}) => storage.migrate({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, acknowledgeCleanupPeriod: true, ...stopped, ...extra });
const crash = step => Object.assign(new Error(`crash at ${step}`), { simulatedCrash: true });

test('analysis groups identical, prefix and diverged versions, folds case and reports truncated lines', async t => {
  const e = await env(t);
  if (process.platform === 'win32') {
    await write(path.join(e.a.directory, 'projects', 'C--Git', 'x.jsonl'), line(S1, 'case'));
    await write(path.join(e.b.directory, 'projects', 'c--Git', 'x.jsonl'), line(S1, 'case'));
  }
  const partial = line(S2, 'complete') + '{"type":"user","mess';
  await write(e.proj(e.a, `${S2}.jsonl`), partial);
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b], ...stopped });
  const group = rel => analysis.groups.find(g => g.key === (process.platform === 'win32' ? rel.toLowerCase() : rel));
  assert.equal(group('projects/proj/' + S1 + '.jsonl').classification, 'prefix');
  assert.equal(group('projects/proj/' + S3 + '.jsonl').classification, 'diverged');
  assert.equal(group('file-history/' + S1 + '/snap').classification, 'identical');
  assert.equal(group('image-cache/' + S1 + '/img.png').classification, 'single');
  // A's partial S2 is not a prefix of B's S2 (different content), so it diverges, and its last line is reported.
  assert.deepEqual(analysis.truncated.map(x => x.abs), [e.proj(e.a, `${S2}.jsonl`)]);
  assert.equal(analysis.truncated[0].parses, false);
  if (process.platform === 'win32') {
    const folded = group('projects/C--Git/x.jsonl');
    assert.equal(folded.classification, 'identical');
    assert.equal(folded.versions[0].locations.length, 2);
  }
  // Byte counts: every private file, and the extra identical copies.
  let expected = 0;
  for (const p of [e.a, e.b]) for (const name of storage.SHAREABLE) for (const content of Object.values(await tree(path.join(p.directory, name)).catch(() => ({})))) expected += Buffer.byteLength(content);
  assert.equal(analysis.metrics.profile, expected);
  assert.equal(analysis.metrics.total, expected);
  assert.equal(analysis.metrics.shared, 0);
  assert.equal(analysis.metrics.duplicate, Buffer.byteLength('checkpoint') + (process.platform === 'win32' ? Buffer.byteLength(line(S1, 'case')) : 0));
  // Reclaimable space counts backups only: live copies in separate profiles stay (decision 11).
  assert.equal(analysis.metrics.reclaimable, 0);
  assert.deepEqual(analysis.profiles.map(p => p.cleanup.days), [30, 14]);
  const report = storage.renderReport(analysis);
  assert.match(report, /Conversations stay private to each profile/);
  assert.doesNotMatch(report, /shortest|Migration plan|Already in shared storage|Joining/i);
  assert.match(report, /Diverged conversations/);
});

test('migration shares history, keeps credentials and settings, and lists the plan through the junction', async t => {
  const e = await env(t);
  const before = { a: await tree(e.a.directory), b: await tree(e.b.directory) };
  const result = await run(e);
  assert.deepEqual(result.profiles, ['A', 'B']);
  for (const p of [e.a, e.b]) {
    assert.equal(await read(path.join(p.directory, '.credentials.json')), `secret-${p.name}`);
    assert.equal(await read(path.join(p.directory, 'settings.json')), before[p === e.a ? 'a' : 'b']['settings.json']);
    for (const name of storage.SHAREABLE) assert.equal(await storage.folderStatus(p.directory, name, e.store), 'linked');
    assert.deepEqual((await fs.readdir(path.join(p.directory, 'projects', 'proj'))).sort(), [`${S1}.jsonl`, `${S2}.jsonl`, `${S3}.jsonl`]);
  }
  // Longest prefix chain wins; the diverged shorter branch is pinned in the store.
  assert.equal(await read(e.proj(e.a, `${S1}.jsonl`)), line(S1, 'one') + line(S1, 'two'));
  assert.equal(await read(e.proj(e.a, `${S3}.jsonl`)), line(S3, 'b branch, longer'));
  const { manifests } = await storage.readManifests(e.store);
  const migration = manifests.find(m => m.kind === 'migration');
  assert.equal(migration.pinned, true);
  assert.equal((await storage.readObject(e.store, migration.objects[0].sha256)).toString('utf8'), line(S3, 'a branch'));
  // Nothing was deleted: the preserved folders hold the original bytes.
  const preserved = (await fs.readdir(e.a.directory)).find(n => n.startsWith('projects.pre-shared-'));
  assert.equal(await read(path.join(e.a.directory, preserved, 'proj', `${S1}.jsonl`)), line(S1, 'one'));
  // B had no image-cache: junction only.
  assert.equal((await fs.readdir(e.b.directory)).some(n => n.startsWith('image-cache.pre-shared-')), false);
  // History code reads through the managed junction.
  assert.deepEqual((await listSessions(e.b.directory, [process.cwd()], { switcherRoot: e.store })).map(s => s.id).sort(), [S1, S2, S3]);
  assert.equal((await storage.verify({ switcherRoot: e.store, profiles: [e.a, e.b] })).ok, true);
  assert.equal((await storage.readJournal(e.store)).state, 'committed');
});

test('migration refuses with a live Claude PID or process, and for Default', async t => {
  const e = await env(t);
  await write(path.join(e.a.directory, 'sessions', '4242.json'), '{}');
  await assert.rejects(run(e, { alive: pid => pid === 4242 }), /Stop Claude.*PID 4242/);
  await assert.rejects(run(e, { detect: async () => [{ pid: 7, name: 'claude.exe' }] }), /claude\.exe PID 7/);
  await assert.rejects(run(e, { detect: async () => { throw new Error('no ps'); } }), /Could not confirm/);
  await assert.rejects(storage.migrate({ switcherRoot: e.store, profiles: [{ id: 'builtin-default', name: 'Default', builtin: true, directory: path.join(e.root, '.claude') }], confirm: true, acknowledgeCleanupPeriod: true, ...stopped }), /Default/);
  await assert.rejects(run(e, { confirm: false }), /confirmation/);
  await assert.rejects(run(e, { acknowledgeCleanupPeriod: false }), /cleanupPeriodDays/);
  assert.equal(await exists(path.join(e.store, 'shared')), false);
  assert.equal(await exists(path.join(e.store, 'migration.json')), false);
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'private');
});

test('process detection matches Claude but not this extension or unrelated paths', () => {
  assert.equal(storage.isClaudeProcess({ name: 'claude.exe', command: '' }), true);
  assert.equal(storage.isClaudeProcess({ name: 'node.exe', command: 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' }), true);
  assert.equal(storage.isClaudeProcess({ name: 'node', command: 'node /usr/local/bin/claude --resume' }), true);
  assert.equal(storage.isClaudeProcess({ name: 'node.exe', command: 'node C:\\Git-Projects\\ClaudeProfileSwitcher\\test' }), false);
  assert.equal(storage.isClaudeProcess({ name: 'Code.exe', command: 'claude' }), false);
});

test('an interrupted migration resumes or rolls back from every journal step', async t => {
  const probe = await env(t);
  const steps = [];
  await run(probe, { interrupt: async step => { steps.push(step); } });
  const resumable = steps.filter(s => s !== 'committed');
  assert.ok(resumable.length > 20);
  for (const [index, step] of resumable.entries()) {
    const e = await env(t);
    const original = { a: await tree(path.join(e.a.directory, 'projects')), b: await tree(path.join(e.b.directory, 'projects')) };
    await assert.rejects(run(e, { interrupt: async s => { if (s === step) throw crash(s); } }), /crash/);
    assert.equal((await storage.readJournal(e.store)).state, 'running');
    // Transfers refuse while the journal shows a run in progress.
    await assert.rejects(transferSession(e.a.directory, path.join(e.root, 'other'), { id: S1, project: 'proj' }, { switcherRoot: e.store }), /in progress/);
    if (index % 2 === 0) {
      await storage.resumeMigration({ switcherRoot: e.store, confirm: true, ...stopped });
      for (const p of [e.a, e.b]) for (const name of storage.SHAREABLE) assert.equal(await storage.folderStatus(p.directory, name, e.store), 'linked', `${step}: ${p.name}/${name}`);
      assert.equal(await read(e.proj(e.a, `${S1}.jsonl`)), line(S1, 'one') + line(S1, 'two'));
      assert.equal((await storage.readJournal(e.store)).state, 'committed');
    } else {
      await storage.rollback({ switcherRoot: e.store, confirm: true, ...stopped });
      for (const p of [e.a, e.b]) assert.equal(await storage.folderStatus(p.directory, 'projects', e.store), 'private', `${step}: ${p.name}`);
      assert.deepEqual(await tree(path.join(e.a.directory, 'projects')), original.a, step);
      assert.deepEqual(await tree(path.join(e.b.directory, 'projects')), original.b, step);
      assert.equal((await fs.readdir(e.a.directory)).some(n => n.includes('.pre-shared-')), false, step);
      assert.equal((await storage.readJournal(e.store)).state, 'rolled-back');
    }
  }
});

test('a folder recreated before the junction (EEXIST) rolls the migration back', async t => {
  const e = await env(t);
  const original = await tree(path.join(e.a.directory, 'projects'));
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'linking:A/projects') await fs.mkdir(path.join(e.a.directory, 'projects')); } }), /Migration stopped.*EEXIST.*restored/s);
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'private');
  assert.deepEqual(await tree(path.join(e.a.directory, 'projects')), original);
  assert.equal(await storage.folderStatus(e.b.directory, 'projects', e.store), 'private');
  assert.equal((await storage.readJournal(e.store)).state, 'rolled-back');
  // shared/ is kept, never deleted.
  assert.equal(await exists(path.join(e.store, 'shared', 'projects', 'proj', `${S1}.jsonl`)), true);
});

test('a preserved folder that changed after analysis aborts and is renamed back', async t => {
  const e = await env(t);
  await assert.rejects(run(e, { interrupt: async step => {
    if (step === 'renamed:A/projects') {
      const preserved = (await fs.readdir(e.a.directory)).find(n => n.startsWith('projects.pre-shared-'));
      await fs.appendFile(path.join(e.a.directory, preserved, 'proj', `${S1}.jsonl`), line(S1, 'late write'));
    }
  } }), /changed since it was analyzed/);
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'private');
  assert.equal(await read(e.proj(e.a, `${S1}.jsonl`)), line(S1, 'one') + line(S1, 'late write'));
});

test('rollback applies the four per-file cases and keeps shared/', async t => {
  const e = await env(t);
  await run(e);
  const preserved = path.join(e.a.directory, (await fs.readdir(e.a.directory)).find(n => n.startsWith('projects.pre-shared-')));
  const result = await storage.rollback({ switcherRoot: e.store, profiles: [e.a], confirm: true, ...stopped });
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'private');
  assert.equal(await exists(preserved), false);
  // Missing: copied in. Prefix: replaced. Identical: unchanged. Diverged: own copy kept.
  assert.equal(await read(e.proj(e.a, `${S2}.jsonl`)), line(S2, 'b only'));
  assert.equal(await read(e.proj(e.a, `${S1}.jsonl`)), line(S1, 'one') + line(S1, 'two'));
  assert.equal(await read(path.join(e.a.directory, 'file-history', S1, 'snap')), 'checkpoint');
  assert.equal(await read(e.proj(e.a, `${S3}.jsonl`)), line(S3, 'a branch'));
  assert.equal(result.diverged.length, 1);
  assert.equal((await storage.readObject(e.store, result.diverged[0].sha256)).toString('utf8'), line(S3, 'b branch, longer'));
  const rollbackManifest = (await storage.readManifests(e.store)).manifests.find(m => m.kind === 'rollback');
  assert.equal(rollbackManifest.pinned, true);
  // The shared target survived the junction removal; B still uses it.
  assert.equal(await read(path.join(e.store, 'shared', 'projects', 'proj', `${S1}.jsonl`)), line(S1, 'one') + line(S1, 'two'));
  assert.equal(await storage.folderStatus(e.b.directory, 'projects', e.store), 'linked');
  // B's junction-only image-cache was used through shared/, so rollback rebuilds it from there.
  await storage.rollback({ switcherRoot: e.store, profiles: [e.b], confirm: true, ...stopped });
  assert.equal(await storage.folderStatus(e.b.directory, 'image-cache', e.store), 'private');
  assert.equal(await read(path.join(e.b.directory, 'image-cache', S1, 'img.png')), 'png');
  assert.equal(await exists(path.join(e.store, 'shared', 'image-cache', S1, 'img.png')), true);
  await assert.rejects(storage.rollback({ switcherRoot: e.store, profiles: [e.a], confirm: false, ...stopped }), /confirmation/);
});

test('rollback after cleanup rebuilds the private folder from shared/', async t => {
  const e = await env(t);
  await run(e);
  const cleaned = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false });
  assert.ok(cleaned.deleted > 0);
  assert.equal((await fs.readdir(e.a.directory)).some(n => n.includes('.pre-shared-')), false);
  // A's diverged S3 branch was already in the store, so deleting it lost nothing.
  const migration = (await storage.readManifests(e.store)).manifests.find(m => m.kind === 'migration');
  assert.equal((await storage.readObject(e.store, migration.objects[0].sha256)).toString('utf8'), line(S3, 'a branch'));
  await storage.rollback({ switcherRoot: e.store, profiles: [e.a], confirm: true, ...stopped });
  assert.deepEqual(Object.keys(await tree(path.join(e.a.directory, 'projects'))).sort(), [`proj/${S1}.jsonl`, `proj/${S2}.jsonl`, `proj/${S3}.jsonl`]);
  assert.equal(await read(path.join(e.a.directory, 'image-cache', S1, 'img.png')), 'png');
});

async function legacySnapshot(profile, name, state, files) {
  const dir = path.join(profile.directory, '.profile-switch-backups', name);
  for (const [rel, data] of Object.entries(files)) await write(path.join(dir, rel), data);
  if (state) await write(path.join(dir, 'manifest.json'), JSON.stringify({ state }));
  return dir;
}
test('cleanup never deletes the only copy, re-verifies before each deletion, and skips locked or uncommitted backups', async t => {
  const e = await env(t);
  await assert.rejects(storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b] }), /confirmation/);
  const redundant = await legacySnapshot(e.a, '1-redundant', 'committed', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one'), [`previous/projects/proj/${S2}.jsonl`]: line(S2, 'b') });
  const unique = await legacySnapshot(e.a, '2-unique', 'committed', { [`previous/projects/proj/${S1}.jsonl`]: line(S1, 'lost branch') });
  const changing = await legacySnapshot(e.a, '3-changing', 'committed', { [`incoming/projects/proj/${S3}.jsonl`]: line(S3, 'a branch') });
  const prepared = await legacySnapshot(e.a, '4-prepared', 'prepared', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  const missing = await legacySnapshot(e.a, '5-no-manifest', null, { [`stage/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  const locked = await legacySnapshot(e.b, '6-locked', 'committed', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  await fs.mkdir(path.join(e.b.directory, '.profile-switch-lock'));
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false, beforeDelete: async c => {
    // A write after the first pass makes this copy unique: it must survive.
    if (c.abs.startsWith(changing)) await fs.appendFile(c.abs, line(S3, 'appended later'));
  } });
  // The identical copy goes; content found nowhere else (the S1 branch, and an S2 that is not a prefix of B's) is stored first.
  assert.equal(await exists(redundant), false);
  assert.equal(await exists(unique), false);
  // Cleanup works in batches (N6): one pinned manifest per batch that stored something.
  const cleanups = (await storage.readManifests(e.store)).manifests.filter(m => m.kind === 'cleanup');
  assert.ok(cleanups.length && cleanups.every(m => m.pinned === true));
  const stored = await Promise.all(cleanups.flatMap(m => m.objects).map(o => storage.readObject(e.store, o.sha256).then(b => b.toString('utf8'))));
  assert.ok(stored.includes(line(S1, 'lost branch')));
  assert.ok(stored.includes(line(S2, 'b')));
  assert.equal(await read(path.join(changing, 'incoming', 'projects', 'proj', `${S3}.jsonl`)), line(S3, 'a branch') + line(S3, 'appended later'));
  for (const dir of [prepared, missing, locked]) assert.equal(await exists(dir), true);
  assert.ok(result.skipped.some(s => s.path === e.b.directory && /lock/.test(s.reason)));
  assert.ok(result.skipped.some(s => s.path === prepared && /prepared/.test(s.reason)));
  assert.ok(result.skipped.some(s => s.path === missing));
  // Live history is never a cleanup candidate.
  assert.equal(await read(e.proj(e.a, `${S1}.jsonl`)), line(S1, 'one'));
});

test('gc keeps pinned and newest-per-session manifests and removes unreferenced objects', async t => {
  const e = await env(t);
  const now = Date.now(), old = days => new Date(now - days * 86400000).toISOString();
  const put = async text => (await storage.putObject(e.store, Buffer.from(text))).sha256;
  const [o1, o2, o3] = [await put('pinned'), await put('expired'), await put('orphan')];
  const m = (fields, objects = []) => ({ id: storage.newManifestId(), state: 'committed', pinned: false, objects: objects.map(sha256 => ({ name: 'x', sha256, size: 0 })), ...fields });
  const manifests = [m({ created: old(100), pinned: true, sessionId: 'S' }, [o1]), m({ created: old(90), sessionId: 'S' }, [o2]), m({ created: old(50), sessionId: 'S' }), m({ created: old(80), sessionId: 'T' }), m({ created: old(80), state: 'prepared' }), m({ created: old(1), sessionId: 'U' })];
  for (const x of manifests) await storage.writeManifest(e.store, x);
  const result = await storage.gc(e.store, { retentionDays: 30, now });
  // The old, empty, stuck prepared manifest (4) expires as well.
  assert.deepEqual(result.removedManifests.sort(), [manifests[1].id, manifests[4].id].sort());
  const kept = (await storage.readManifests(e.store)).manifests.map(x => x.id).sort();
  assert.deepEqual(kept, manifests.filter((_, i) => i !== 1 && i !== 4).map(x => x.id).sort());
  assert.deepEqual(await storage.storedObjects(e.store), [o1]);
  assert.ok(![o2, o3].includes((await storage.storedObjects(e.store))[0]));
  // Discarding a pinned manifest needs confirmation, then frees its objects.
  await assert.rejects(storage.discardManifests(e.store, [manifests[0].id]), /confirmation/);
  await storage.discardManifests(e.store, [manifests[0].id], { confirm: true });
  assert.deepEqual(await storage.storedObjects(e.store), []);
});

test('a stale storage lock blocks and is released only for a dead owner with confirmation', async t => {
  const e = await env(t);
  const release = await storage.acquireStoreLock(e.store, 'holder', { wait: 0 });
  await assert.rejects(storage.acquireStoreLock(e.store, 'second', { wait: 0 }), /busy.*holder/);
  await assert.rejects(storage.gc(e.store, { lock: { wait: 0 } }), /busy/);
  await assert.rejects(run(e, { lock: { wait: 0 } }), /busy/);
  await assert.rejects(storage.releaseStaleLock(e.store), /confirmation/);
  await assert.rejects(storage.releaseStaleLock(e.store, { confirm: true, alive: () => true }), /still held/);
  assert.ok(await storage.readStoreLock(e.store));
  assert.equal(await storage.releaseStaleLock(e.store, { confirm: true, alive: () => false }), true);
  assert.equal(await storage.readStoreLock(e.store), null);
  await release(); // The original holder's release no longer touches a lock it does not own.
  const again = await storage.acquireStoreLock(e.store, 'after', { wait: 0 });
  await again();
});

test('cleanup refuses during an interrupted migration, and rollback still restores the history', async t => {
  const e = await env(t);
  const original = await tree(path.join(e.a.directory, 'projects'));
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'linked:A/projects') throw crash(step); } }), /crash/);
  await assert.rejects(storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false }), /in progress/);
  assert.ok((await fs.readdir(e.a.directory)).some(n => n.startsWith('projects.pre-shared-')));
  await storage.rollback({ switcherRoot: e.store, confirm: true, ...stopped });
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'private');
  assert.deepEqual(await tree(path.join(e.a.directory, 'projects')), original);
});

test('rollbackJournal rebuilds from shared/ when a preserved folder is missing', async t => {
  const e = await env(t);
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'linked:A/projects') throw crash(step); } }), /crash/);
  // Simulate the preserved folder being removed outside the journal.
  const preserved = path.join(e.a.directory, (await fs.readdir(e.a.directory)).find(n => n.startsWith('projects.pre-shared-')));
  await storage.removeTree(preserved);
  await storage.rollback({ switcherRoot: e.store, confirm: true, ...stopped });
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'private');
  assert.deepEqual(Object.keys(await tree(path.join(e.a.directory, 'projects'))).sort(), [`proj/${S1}.jsonl`, `proj/${S2}.jsonl`, `proj/${S3}.jsonl`]);
  const journal = await storage.readJournal(e.store);
  assert.equal(journal.profiles[0].folders[0].rebuilt, true);
});

test('cleanup refuses while migration.json is unreadable', async t => {
  const e = await env(t);
  await write(path.join(e.store, 'migration.json'), '{not json');
  await assert.rejects(storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false }), /migration\.json/);
});

test('a rollback of a completed migration resumes from every journal step', async t => {
  const probe = await env(t);
  await run(probe);
  const steps = [];
  await storage.rollback({ switcherRoot: probe.store, profiles: [probe.a, probe.b], confirm: true, ...stopped, interrupt: async step => { steps.push(step); } });
  const expected = { a: await tree(path.join(probe.a.directory, 'projects')), b: await tree(path.join(probe.b.directory, 'image-cache')) };
  const resumable = steps.filter(s => s !== 'committed');
  assert.ok(resumable.length > 15);
  for (const step of resumable) {
    const e = await env(t);
    await run(e);
    await assert.rejects(storage.rollback({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, ...stopped, interrupt: async s => { if (s === step) throw crash(s); } }), /crash/);
    assert.equal((await storage.readJournal(e.store)).state, 'running', step);
    await assert.rejects(storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false }), /in progress/);
    await storage.rollback({ switcherRoot: e.store, confirm: true, ...stopped });
    for (const p of [e.a, e.b]) for (const name of storage.SHAREABLE) assert.equal(await storage.folderStatus(p.directory, name, e.store), 'private', `${step}: ${p.name}/${name}`);
    assert.deepEqual(await tree(path.join(e.a.directory, 'projects')), expected.a, step);
    assert.deepEqual(await tree(path.join(e.b.directory, 'image-cache')), expected.b, step);
    assert.equal((await storage.readJournal(e.store)).state, 'committed', step);
  }
});

test('journal entries outside the switcher profiles are refused', async t => {
  const e = await env(t);
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'objects-stored') throw crash(step); } }), /crash/);
  const journal = await storage.readJournal(e.store);
  journal.profiles[0].directory = path.join(e.root, 'elsewhere');
  await write(path.join(e.store, 'migration.json'), JSON.stringify(journal));
  await assert.rejects(storage.resumeMigration({ switcherRoot: e.store, confirm: true, ...stopped }), /outside the switcher profiles/);
  await assert.rejects(storage.rollback({ switcherRoot: e.store, confirm: true, ...stopped }), /outside the switcher profiles/);
  journal.profiles[0].directory = e.a.directory;
  journal.profiles[0].folders[0].preserved = '..\\..\\x';
  await write(path.join(e.store, 'migration.json'), JSON.stringify(journal));
  await assert.rejects(storage.resumeMigration({ switcherRoot: e.store, confirm: true, ...stopped }), /invalid preserved/);
});

test('joining an existing pool keeps the shared version on a tie', async t => {
  const e = await env(t);
  await storage.migrate({ switcherRoot: e.store, profiles: [e.b], confirm: true, acknowledgeCleanupPeriod: true, ...stopped });
  const sharedS3 = path.join(e.store, 'shared', 'projects', 'proj', `${S3}.jsonl`);
  const c = { id: 'cccccccc-0000-0000-0000-00000000000c', name: 'C', directory: path.join(e.store, 'profiles', 'cccccccc-0000-0000-0000-00000000000c') };
  const rival = line(S3, 'c branch, longer');
  assert.equal(rival.length, line(S3, 'b branch, longer').length);
  await write(path.join(c.directory, 'projects', 'proj', `${S3}.jsonl`), rival);
  const later = new Date(Date.now() + 60000);
  await fs.utimes(path.join(c.directory, 'projects', 'proj', `${S3}.jsonl`), later, later);
  await storage.migrate({ switcherRoot: e.store, profiles: [c], confirm: true, acknowledgeCleanupPeriod: true, ...stopped });
  assert.equal(await read(sharedS3), line(S3, 'b branch, longer'));
  const manifests = (await storage.readManifests(e.store)).manifests.filter(m => m.kind === 'migration');
  assert.ok(manifests.some(m => m.objects.some(o => o.name.endsWith(`${S3}.jsonl`) && o.size === Buffer.byteLength(rival))));
});

test('node processes with an unreadable command line are reported but do not refuse', async t => {
  const e = await env(t);
  const list = async () => [{ pid: 11, name: 'node.exe', command: '' }, { pid: 12, name: 'notepad.exe', command: '' }];
  const rows = await storage.detectClaudeProcesses({ list });
  assert.deepEqual(rows.map(r => [r.pid, !!r.unverified]), [[11, true]]);
  await storage.assertClaudeStopped([e.a], { detect: async () => rows, alive: () => false });
  await assert.rejects(storage.assertClaudeStopped([e.a], { detect: async () => [...rows, { pid: 13, name: 'claude.exe' }], alive: () => false }), /claude\.exe PID 13.*command line unreadable.*node\.exe PID 11/s);
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a], detect: async () => rows, alive: () => false });
  assert.match(storage.renderReport(analysis), /could not be read[\s\S]*node\.exe PID 11/);
});

test('a lock with an unreadable owner file is released only once it is old, with confirmation', async t => {
  const e = await env(t);
  await fs.mkdir(path.join(e.store, '.storage-lock'), { recursive: true });
  await fs.writeFile(path.join(e.store, '.storage-lock', 'owner.json'), '{broken');
  await assert.rejects(storage.acquireStoreLock(e.store, 'x', { wait: 0 }), /unknown owner/);
  await assert.rejects(storage.releaseStaleLock(e.store, { confirm: true }), /still held/);
  assert.equal(await storage.releaseStaleLock(e.store, { confirm: true, now: Date.now() + 120000 }), true);
  assert.equal(await storage.readStoreLock(e.store), null);
});

test('verify reports invalid object hashes and pending transfer recovery', async t => {
  const e = await env(t);
  await storage.writeManifest(e.store, { id: storage.newManifestId(), kind: 'transfer', created: new Date().toISOString(), state: 'committed', pinned: true, objects: [{ name: 'x', sha256: '../../escape', size: 1 }] });
  await storage.recordRecovery(e.store, { destination: e.a.directory, error: 'test' });
  const result = await storage.verify({ switcherRoot: e.store, profiles: [e.a] });
  assert.ok(result.problems.some(p => /invalid object hash/.test(p)));
  assert.ok(result.problems.some(p => /Transfer recovery required/.test(p)));
  await assert.rejects(run(e), /needs recovery/);
  await assert.rejects(storage.resolveRecovery(e.store), /confirmation/);
  await storage.resolveRecovery(e.store, { confirm: true, ids: (await storage.readRecovery(e.store)).map(storage.recoveryId) });
  assert.equal(await storage.readRecovery(e.store), null);
});

test('a rebuild from shared/ interrupted midway resumes and copies only what is missing', async t => {
  const e = await env(t);
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'linked:A/projects') throw crash(step); } }), /crash/);
  const preserved = path.join(e.a.directory, (await fs.readdir(e.a.directory)).find(n => n.startsWith('projects.pre-shared-')));
  await storage.removeTree(preserved);
  // Crash after the first rebuilt file.
  await assert.rejects(storage.rollback({ switcherRoot: e.store, confirm: true, ...stopped, interrupt: async step => { if (step.startsWith('rebuilt-file:A/projects:')) throw crash(step); } }), /crash/);
  const journal = await storage.readJournal(e.store);
  assert.equal(journal.state, 'running');
  assert.equal(journal.profiles[0].folders[0].step, 'rebuilding');
  const partial = Object.keys(await tree(path.join(e.a.directory, 'projects')));
  assert.equal(partial.length, 1);
  const first = path.join(e.a.directory, 'projects', ...partial[0].split('/'));
  const firstStat = await fs.stat(first);
  const copied = [];
  await storage.rollback({ switcherRoot: e.store, confirm: true, ...stopped, interrupt: async step => { if (step.startsWith('rebuilt-file:')) copied.push(step); } });
  // The file already copied is not copied again; the rest is.
  assert.equal(copied.length, 2);
  assert.ok(!copied.some(step => step.endsWith(partial[0].split('/').join(path.sep))));
  assert.equal((await fs.stat(first)).mtimeMs, firstStat.mtimeMs);
  assert.deepEqual(Object.keys(await tree(path.join(e.a.directory, 'projects'))).sort(), [`proj/${S1}.jsonl`, `proj/${S2}.jsonl`, `proj/${S3}.jsonl`]);
  const done = await storage.readJournal(e.store);
  assert.equal(done.state, 'rolled-back');
  assert.equal(done.profiles[0].folders[0].step, 'rolled-back');
  assert.equal(done.profiles[0].folders[0].rebuilt, true);
});

test('resolving transfer recovery removes only the entries shown, under the store lock', async t => {
  const e = await env(t);
  await storage.recordRecovery(e.store, { destination: 'first' });
  const shown = await storage.readRecovery(e.store);
  // Another window records a new failure after the user opened the report.
  await storage.recordRecovery(e.store, { destination: 'second' });
  await assert.rejects(storage.resolveRecovery(e.store, { confirm: true }), /Name the recovery entries/);
  const release = await storage.acquireStoreLock(e.store, 'other window', { wait: 0 });
  await assert.rejects(storage.resolveRecovery(e.store, { confirm: true, ids: shown.map(storage.recoveryId), lock: { wait: 0 } }), /busy/);
  await release();
  assert.deepEqual(await storage.resolveRecovery(e.store, { confirm: true, ids: shown.map(storage.recoveryId) }), { removed: 1, remaining: 1 });
  assert.deepEqual((await storage.readRecovery(e.store)).map(x => x.destination), ['second']);
  await assert.rejects(storage.assertNoRecovery(e.store), /second/);
  // An unreadable marker is resolved only by naming it.
  await write(path.join(e.store, 'transfer-recovery.json'), '{broken');
  const unreadable = await storage.readRecovery(e.store);
  await assert.rejects(storage.recordRecovery(e.store, { destination: 'third' }), /unreadable/);
  assert.deepEqual(await storage.resolveRecovery(e.store, { confirm: true, ids: unreadable.map(storage.recoveryId) }), { removed: 1, remaining: 0 });
  assert.equal(await storage.readRecovery(e.store), null);
});

// ---- Security regressions: links must never be followed --------------------

// An outside folder whose files would look redundant (identical to live history)
// if a link into it were followed, plus a plain victim file.
async function outsideFolder(e, name = 'outside', layout = 'projects') {
  const dir = path.join(e.root, name);
  await write(path.join(dir, 'victim.txt'), 'must survive');
  const transcript = layout === 'projects' ? path.join(dir, 'proj', `${S1}.jsonl`) : path.join(dir, ...layout.split('/'), `${S1}.jsonl`);
  await write(transcript, line(S1, 'one'));
  return { dir, before: await tree(dir) };
}
const junction = (target, at) => fs.symlink(target, at, 'junction');

test('assertPlainPath refuses links anywhere below the root and paths outside it', async t => {
  const e = await env(t);
  const out = await outsideFolder(e);
  await storage.assertPlainPath(e.a.directory, e.proj(e.a, `${S1}.jsonl`));
  await storage.assertPlainPath(e.a.directory, path.join(e.a.directory, 'new', 'file'), { allowMissing: true });
  await assert.rejects(storage.assertPlainPath(e.a.directory, path.join(e.a.directory, 'missing')), /does not exist/);
  await assert.rejects(storage.assertPlainPath(e.a.directory, path.join(e.root, 'outside', 'victim.txt')), /outside/);
  await junction(out.dir, path.join(e.a.directory, 'linked'));
  await assert.rejects(storage.assertPlainPath(e.a.directory, path.join(e.a.directory, 'linked', 'victim.txt')), /link/);
  await assert.rejects(storage.assertPlainPath(e.a.directory, path.join(e.a.directory, 'linked', 'new'), { allowMissing: true }), /link/);
});

test('cleanup never follows a junctioned pre-shared folder', async t => {
  const e = await env(t);
  const out = await outsideFolder(e);
  await junction(out.dir, path.join(e.a.directory, 'projects.pre-shared-1'));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a], ...stopped });
  assert.ok(analysis.links.includes(path.join(e.a.directory, 'projects.pre-shared-1')));
  assert.match(storage.renderReport(analysis), /Unexpected links/);
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false });
  assert.equal(result.deleted, 0);
  assert.deepEqual(await tree(out.dir), out.before);
});

test('cleanup never follows a junctioned snapshot part, even with a committed manifest', async t => {
  const e = await env(t);
  const out = await outsideFolder(e, 'outside', 'projects/proj');
  const snap = path.join(e.a.directory, '.profile-switch-backups', '1-planted');
  await write(path.join(snap, 'manifest.json'), JSON.stringify({ state: 'committed' }));
  await junction(out.dir, path.join(snap, 'incoming'));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a], ...stopped });
  assert.ok(analysis.links.includes(path.join(snap, 'incoming')));
  await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false });
  assert.deepEqual(await tree(out.dir), out.before);
});

test('cleanup never follows a junctioned .profile-switch-backups folder', async t => {
  const e = await env(t);
  const out = await outsideFolder(e, 'outside', 'snap/incoming/projects/proj');
  await write(path.join(out.dir, 'snap', 'manifest.json'), JSON.stringify({ state: 'committed' }));
  const before = await tree(out.dir);
  await junction(out.dir, path.join(e.a.directory, '.profile-switch-backups'));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a], ...stopped });
  assert.ok(analysis.links.includes(path.join(e.a.directory, '.profile-switch-backups')));
  await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false });
  assert.deepEqual(await tree(out.dir), before);
});

test('cleanup re-checks the path before each deletion: a link swapped in afterwards is not followed', async t => {
  const e = await env(t);
  const out = await outsideFolder(e, 'outside', 'projects/proj');
  const snap = await legacySnapshot(e.a, '1-real', 'committed', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false, beforeDelete: async () => {
    if ((await fs.lstat(path.join(snap, 'incoming'))).isSymbolicLink()) return;
    await fs.rename(path.join(snap, 'incoming'), path.join(e.root, 'moved-away'));
    await junction(out.dir, path.join(snap, 'incoming'));
  } });
  assert.equal(result.deleted, 0);
  assert.ok(result.skipped.some(s => /link/.test(s.reason)));
  assert.deepEqual(await tree(out.dir), out.before);
});

test('migration refuses when shared/projects is a junction and writes nothing outside', async t => {
  const e = await env(t);
  const out = await outsideFolder(e);
  await fs.mkdir(path.join(e.store, 'shared'), { recursive: true });
  await junction(out.dir, path.join(e.store, 'shared', 'projects'));
  await assert.rejects(run(e), /link/);
  assert.deepEqual(await tree(out.dir), out.before);
  assert.equal(await exists(path.join(e.store, 'migration.json')), false);
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'private');
  // A junction at shared/ itself is refused the same way.
  await storage.removeLink(path.join(e.store, 'shared', 'projects'));
  await fs.rmdir(path.join(e.store, 'shared'));
  await junction(out.dir, path.join(e.store, 'shared'));
  await assert.rejects(run(e), /link/);
  assert.deepEqual(await tree(out.dir), out.before);
});

test('rollback never renames a junctioned preserved folder into place', async t => {
  const e = await env(t);
  await run(e);
  await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false });
  const out = await outsideFolder(e);
  const planted = path.join(e.a.directory, 'projects.pre-shared-9');
  await junction(out.dir, planted);
  await storage.rollback({ switcherRoot: e.store, profiles: [e.a], confirm: true, ...stopped });
  const projects = await fs.lstat(path.join(e.a.directory, 'projects'));
  assert.equal(projects.isSymbolicLink(), false);
  assert.equal(projects.isDirectory(), true);
  assert.deepEqual(Object.keys(await tree(path.join(e.a.directory, 'projects'))).sort(), [`proj/${S1}.jsonl`, `proj/${S2}.jsonl`, `proj/${S3}.jsonl`]);
  assert.deepEqual(await tree(out.dir), out.before);
  assert.equal((await fs.lstat(planted)).isSymbolicLink(), true);
});

test('undoing a migration refuses a preserved folder that became a junction', async t => {
  const e = await env(t);
  const out = await outsideFolder(e);
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'linked:A/projects') throw crash(step); } }), /crash/);
  const journal = await storage.readJournal(e.store);
  const preserved = path.join(e.a.directory, journal.profiles[0].folders[0].preserved);
  await fs.rename(preserved, path.join(e.root, 'moved-away'));
  await junction(out.dir, preserved);
  await assert.rejects(storage.rollback({ switcherRoot: e.store, confirm: true, ...stopped }), /not a plain folder/);
  assert.deepEqual(await tree(out.dir), out.before);
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'linked');
});

test('a journal whose source points at credentials is refused', async t => {
  const e = await env(t);
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'objects-stored') throw crash(step); } }), /crash/);
  const journal = await storage.readJournal(e.store);
  const good = journal.files[0].source;
  journal.files[0].source = path.join(e.a.directory, '.credentials.json');
  await write(path.join(e.store, 'migration.json'), JSON.stringify(journal));
  await assert.rejects(storage.resumeMigration({ switcherRoot: e.store, confirm: true, ...stopped }), /outside the shared history folders/);
  journal.files[0].source = good;
  journal.files[0].sha256 = 'not-a-hash';
  await write(path.join(e.store, 'migration.json'), JSON.stringify(journal));
  await assert.rejects(storage.resumeMigration({ switcherRoot: e.store, confirm: true, ...stopped }), /invalid hash/);
  assert.equal(await exists(path.join(e.store, 'shared', 'projects', 'proj', `${S1}.jsonl`)), false);
});

test('a junctioned object store is refused by GC and by writes, and its files survive', async t => {
  const e = await env(t);
  const out = path.join(e.root, 'outside-objects');
  const name = 'a'.repeat(64);
  await write(path.join(out, name), 'outside file with a hash-like name');
  await fs.mkdir(path.join(e.store, 'backups'), { recursive: true });
  await junction(out, path.join(e.store, 'backups', 'objects'));
  await assert.rejects(storage.gc(e.store), /link/);
  await assert.rejects(storage.putObject(e.store, Buffer.from('data')), /link/);
  await assert.rejects(storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false }), /link/);
  assert.deepEqual(await fs.readdir(out), [name]);
  const result = await storage.verify({ switcherRoot: e.store, profiles: [e.a] });
  assert.ok(result.problems.some(p => /link/.test(p)));
  // backups/ itself as a junction is refused as well.
  await storage.removeLink(path.join(e.store, 'backups', 'objects'));
  await fs.rmdir(path.join(e.store, 'backups'));
  await junction(out, path.join(e.store, 'backups'));
  await assert.rejects(storage.writeManifest(e.store, { id: storage.newManifestId(), objects: [] }), /link/);
  await assert.rejects(storage.gc(e.store), /link/);
  assert.deepEqual(await fs.readdir(out), [name]);
});

test('verify flags pool members no migration recorded, and the preview lists pool members', async t => {
  const e = await env(t);
  await run(e);
  const okResult = await storage.verify({ switcherRoot: e.store, profiles: [e.a, e.b] });
  assert.equal(okResult.ok, true);
  assert.ok(okResult.notes.some(n => /^2 profiles use shared storage; 1 backup manifest; \d+ stored file references? checked\.$/.test(n)), okResult.notes.join(' | '));
  const c = { id: 'cccccccc-0000-0000-0000-00000000000c', name: 'C', directory: path.join(e.store, 'profiles', 'cccccccc-0000-0000-0000-00000000000c') };
  await fs.mkdir(c.directory);
  for (const name of storage.SHAREABLE) await junction(path.join(e.store, 'shared', name), path.join(c.directory, name));
  const result = await storage.verify({ switcherRoot: e.store, profiles: [e.a, e.b, c] });
  assert.ok(result.problems.some(p => /C uses shared storage, but no recorded migration/.test(p)));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b, c], ...stopped });
  assert.match(storage.renderReport(analysis), /Already in shared storage: A, B, C\./);
});

test('process rows keep no command lines and the lock folder is private', async t => {
  const e = await env(t);
  const rows = await storage.detectClaudeProcesses({ list: async () => [{ pid: 5, name: 'node.exe', command: 'node @anthropic-ai/claude-code/cli.js --token secret' }, { pid: 6, name: 'node.exe', command: '' }] });
  assert.deepEqual(rows, [{ pid: 5, name: 'node.exe' }, { pid: 6, name: 'node.exe', unverified: true }]);
  const release = await storage.acquireStoreLock(e.store, 'mode check', { wait: 0 });
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(e.store, '.storage-lock'))).mode & 0o777, 0o700);
  await release();
});

// ---- Architect recommendations ---------------------------------------------

test('a cleanup dry run lists what would be deleted, moved and skipped, and changes nothing', async t => {
  const e = await env(t);
  const redundant = await legacySnapshot(e.a, '1-redundant', 'committed', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  const unique = await legacySnapshot(e.a, '2-unique', 'committed', { [`previous/projects/proj/${S1}.jsonl`]: line(S1, 'lost branch') });
  const prepared = await legacySnapshot(e.a, '3-prepared', 'prepared', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  const before = { a: await tree(e.a.directory), store: await exists(e.store) ? await tree(e.store) : null };
  const plan = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.delete.map(f => f.path).sort(), [path.join(redundant, 'incoming', 'projects', 'proj', `${S1}.jsonl`), path.join(unique, 'previous', 'projects', 'proj', `${S1}.jsonl`)].sort());
  assert.deepEqual(plan.move.map(f => f.path), [path.join(unique, 'previous', 'projects', 'proj', `${S1}.jsonl`)]);
  assert.ok(plan.skipped.some(s => s.path === prepared && /prepared/.test(s.reason)));
  assert.equal(plan.bytes, plan.delete.reduce((n, f) => n + f.size, 0));
  const report = storage.renderCleanupPlan(plan);
  assert.match(report, /Read-only/);
  assert.match(report, /lost branch|2-unique/);
  // Nothing changed: no deletion, no object store, no lock.
  assert.deepEqual(await tree(e.a.directory), before.a);
  assert.equal(await exists(path.join(e.store, 'backups')), false);
  assert.equal(await exists(path.join(e.store, '.storage-lock')), false);
  // The real run deletes exactly the previewed files.
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false });
  assert.equal(result.deleted, plan.delete.length);
  assert.equal(result.moved, plan.move.length);
  // A dry run still refuses during an interrupted migration.
  await write(path.join(e.store, 'migration.json'), JSON.stringify({ kind: 'migration', state: 'running', profiles: [] }));
  await assert.rejects(storage.cleanup({ switcherRoot: e.store, profiles: [e.a], dryRun: true }), /in progress/);
});

test('gc expires old, empty, stuck prepared manifests but keeps recent, pinned or non-empty ones', async t => {
  const e = await env(t);
  const now = Date.now(), old = days => new Date(now - days * 86400000).toISOString();
  const sha = (await storage.putObject(e.store, Buffer.from('kept'))).sha256;
  const m = fields => ({ id: storage.newManifestId(), state: 'prepared', pinned: false, objects: [], ...fields });
  const stuck = m({ created: old(40), sessionId: 'S' });
  const recent = m({ created: old(5), sessionId: 'S' });
  const withObjects = m({ created: old(40), objects: [{ name: 'x', sha256: sha, size: 4 }] });
  const pinned = m({ created: old(40), pinned: true });
  for (const x of [stuck, recent, withObjects, pinned]) await storage.writeManifest(e.store, x);
  const result = await storage.gc(e.store, { retentionDays: 30, now });
  assert.deepEqual(result.removedManifests, [stuck.id]);
  assert.deepEqual((await storage.readManifests(e.store)).manifests.map(x => x.id).sort(), [recent.id, withObjects.id, pinned.id].sort());
  assert.deepEqual(await storage.storedObjects(e.store), [sha]);
});

test('a copy-based transfer refuses while a migration holds the lock or is being prepared', async t => {
  const e = await env(t);
  const destination = path.join(e.root, 'default-like');
  await fs.mkdir(destination);
  const session = { id: S1, project: 'proj' };
  const options = { switcherRoot: e.store };
  const release = await storage.acquireStoreLock(e.store, 'migration', { wait: 0 });
  await assert.rejects(transferSession(e.a.directory, destination, session, options), /migration is running/);
  await release();
  await write(path.join(e.store, 'migration.json'), JSON.stringify({ state: 'committed', members: {}, preparing: { pid: process.pid } }));
  await assert.rejects(transferSession(e.a.directory, destination, session, options), /being prepared/);
  assert.deepEqual(await fs.readdir(destination), []);
  // A marker left by a process that no longer runs does not block.
  await write(path.join(e.store, 'migration.json'), JSON.stringify({ state: 'committed', members: {}, preparing: { pid: 2147483646 } }));
  await transferSession(e.a.directory, destination, session, options);
  assert.equal(await read(path.join(destination, 'projects', 'proj', `${S1}.jsonl`)), line(S1, 'one'));
});

test('a copy-based transfer re-checks right before staging', async t => {
  const e = await env(t);
  const destination = path.join(e.root, 'default-like');
  await fs.mkdir(destination);
  const original = storage.assertNoMigrationPending;
  let calls = 0;
  t.mock.method(storage, 'assertNoMigrationPending', async root => {
    // A migration starts preparing after the first check.
    if (++calls === 2) await write(path.join(e.store, 'migration.json'), JSON.stringify({ preparing: { pid: process.pid } }));
    return original(root);
  });
  await assert.rejects(transferSession(e.a.directory, destination, { id: S1, project: 'proj' }, { switcherRoot: e.store }), /being prepared/);
  assert.equal(calls, 2);
  assert.deepEqual(await fs.readdir(destination), []);
});

test('migration removes its preparing marker when it stops before starting', async t => {
  const e = await env(t);
  await fs.mkdir(path.join(e.a.directory, '.profile-switch-lock'));
  await assert.rejects(run(e), /Migration refused/);
  assert.equal(await exists(path.join(e.store, 'migration.json')), false);
  // With an earlier journal, that journal is restored unchanged.
  const previous = { version: 1, kind: 'rollback', state: 'committed', members: { x: { projects: { preserved: null, junctionOnly: true } } } };
  await write(path.join(e.store, 'migration.json'), JSON.stringify(previous));
  await assert.rejects(run(e), /Migration refused/);
  assert.deepEqual(await storage.readJournal(e.store), previous);
});

// ---- Designer review: wording and accessibility ----------------------------

test('reports use plain metric names, folder states and local times', async t => {
  const e = await env(t);
  await run(e);
  const c = { id: 'cccccccc-0000-0000-0000-00000000000c', name: 'C', directory: path.join(e.store, 'profiles', 'cccccccc-0000-0000-0000-00000000000c') };
  await write(path.join(c.directory, 'projects', 'proj', `${S2}.jsonl`), line(S2, 'c'));
  await write(path.join(c.directory, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 7 }));
  const d = { id: 'dddddddd-0000-0000-0000-00000000000d', name: 'D', directory: path.join(e.store, 'profiles', 'dddddddd-0000-0000-0000-00000000000d') };
  await write(path.join(d.directory, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3 }));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b, c, d], selected: [c.id], ...stopped });
  const report = storage.renderReport(analysis, { title: 'Migration preview (dry run)' });
  for (const metric of storage.METRICS) assert.ok(report.includes(`| ${metric.label} |`), metric.label);
  assert.match(report, /\| Reclaimable space \|/);
  assert.doesNotMatch(report, /Recoverable|pool|Pool|junction only/);
  assert.ok(report.includes(`Created ${new Date(analysis.created).toLocaleString()}.`));
  // Folder states read as words, not codes.
  assert.match(report, /\| C \| private folder \| not created yet \| not created yet \|/);
  assert.match(report, /\| A \| shared \| shared \| shared \|/);
  // The cleanup period covers the selected profile and those already in shared storage, not D.
  assert.match(report, /Values: A 30 days, B 14 days, C 7 days\./);
  assert.doesNotMatch(report, /D 3 days/);
  assert.match(report, /settings\.json/);
  assert.match(report, /After Clean Redundant Backups, shared storage holds the only copy/);
  assert.match(report, /image-cache \(not created yet; it will use shared storage\)/);
});

test('blocked-migration problems read as sentences', async t => {
  const e = await env(t);
  await fs.mkdir(path.join(e.root, 'elsewhere'));
  await storage.removeTree(path.join(e.a.directory, 'image-cache'));
  await fs.symlink(path.join(e.root, 'elsewhere'), path.join(e.a.directory, 'image-cache'), 'junction');
  await write(path.join(e.b.directory, 'file-history-file'), 'x');
  await fs.rm(path.join(e.b.directory, 'file-history'), { recursive: true });
  await fs.rename(path.join(e.b.directory, 'file-history-file'), path.join(e.b.directory, 'file-history'));
  await fs.mkdir(path.join(e.b.directory, '.profile-switch-lock'));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b], selected: [e.a.id, e.b.id], ...stopped });
  assert.deepEqual(analysis.plan.problems, [
    'In A, the image-cache folder is a link to another location. Only private folders can be moved into shared storage.',
    'In B, file-history is not a folder. Only private folders can be moved into shared storage.',
    'B has an unfinished switch that needs recovery first (.profile-switch-lock).'
  ]);
  assert.match(storage.renderReport(analysis), /\| A \| private folder \| private folder \| link to another location \|/);
  assert.match(storage.renderReport(analysis), /\| B \| private folder \| not a folder \|/);
});

test('the Claude-stopped refusal gives the steps and no session file paths', async t => {
  const e = await env(t);
  await write(path.join(e.a.directory, 'sessions', '4242.json'), '{}');
  const error = await run(e, { alive: pid => pid === 4242 }).catch(x => x);
  assert.match(error.message, /^Stop Claude first: close the Claude chat panels in all VS Code windows and exit claude in every terminal, then try again\./);
  assert.match(error.message, /Still running: A: Claude PID 4242\./);
  assert.doesNotMatch(error.message, /sessions|\.json/);
});

test('backup labels, local times and the recovery report have no codes or empty headings', () => {
  const created = '2026-11-20T10:00:00.000Z';
  assert.equal(storage.backupLabel({ kind: 'cleanup', created }), `Cleanup backup, ${new Date(created).toLocaleString()}`);
  assert.equal(storage.backupLabel({ kind: 'migration', created }), `Migration backup, ${new Date(created).toLocaleString()}`);
  assert.equal(storage.backupLabel({ kind: 'rollback', created }), `Rollback backup, ${new Date(created).toLocaleString()}`);
  assert.equal(storage.localTime('not a date'), 'an unknown time');
  const report = storage.renderRecovery([{ destination: 'X' }, { created, sessionId: 'abc', error: 'boom' }]);
  assert.match(report, /^## Entry 1$/m);
  assert.ok(report.includes(`## ${new Date(created).toLocaleString()}, conversation abc`));
  assert.match(report, /- Error: unknown/);
  assert.match(report, /2\. Choose Mark Resolved in the notification\. If the notification has closed, open Manage Storage again or run Notifications: Show Notifications\./);
  const one = storage.renderVerify({ ok: false, problems: ['x'], notes: [] });
  assert.match(one, /^1 problem found:$/m);
  assert.doesNotMatch(one, /\(s\)/);
  assert.doesNotMatch(report, /^## *$/m);
  assert.doesNotMatch(report, /pool/i);
  assert.equal(storage.folderLabel('foreign-link'), 'link to another location');
});

test('a leftover migration marker is reported by Verify and cleared only with confirmation when stale', async t => {
  const e = await env(t);
  const journalFile = path.join(e.store, 'migration.json');
  const base = { version: 1, kind: 'migration', state: 'committed', members: { keep: { projects: { preserved: null, junctionOnly: true } } } };
  const dead = 2147483646;
  await write(journalFile, JSON.stringify({ ...base, preparing: { pid: dead, started: '2026-11-20T10:00:00.000Z' } }));
  assert.equal((await storage.migrationMarker(e.store)).stale, true);
  const result = await storage.verify({ switcherRoot: e.store, profiles: [] });
  assert.ok(result.problems.some(p => p.startsWith('A leftover migration marker (PID 2147483646') && p.includes(new Date('2026-11-20T10:00:00.000Z').toLocaleString())));
  await assert.rejects(storage.clearMigrationMarker(e.store), /confirmation/);
  assert.equal(await storage.clearMigrationMarker(e.store, { confirm: true }), true);
  assert.deepEqual(await storage.readJournal(e.store), base);
  // A live editor process may still be preparing: not stale, not cleared.
  const host = { alive: () => true, list: async () => [{ pid: 777, name: 'Code.exe' }] };
  await write(journalFile, JSON.stringify({ ...base, preparing: { pid: 777 } }));
  assert.equal((await storage.migrationMarker(e.store, host)).stale, false);
  await assert.rejects(storage.clearMigrationMarker(e.store, { confirm: true, ...host }), /may still be preparing/);
  assert.ok((await storage.verify({ switcherRoot: e.store, profiles: [], ...host })).notes.some(n => /being prepared by PID 777/.test(n)));
  // A live PID that is not an editor process, or this process itself, is a leftover.
  assert.equal((await storage.migrationMarker(e.store, { alive: () => true, list: async () => [{ pid: 777, name: 'notepad.exe' }] })).stale, true);
  await write(journalFile, JSON.stringify({ preparing: { pid: process.pid } }));
  assert.equal((await storage.migrationMarker(e.store)).stale, true);
  // While a migration holds the lock, the marker is current.
  const release = await storage.acquireStoreLock(e.store, 'migration', { wait: 0 });
  assert.equal((await storage.migrationMarker(e.store)).stale, false);
  await release();
  // A journal that only held the marker is removed.
  assert.equal(await storage.clearMigrationMarker(e.store, { confirm: true }), true);
  assert.equal(await exists(journalFile), false);
});

// ---- Windows long paths (260+ characters) ----------------------------------

async function allFiles(dir) {
  const out = [];
  async function visit(d) { for (const name of await fs.readdir(d)) { const p = path.join(d, name), s = await fs.lstat(p); if (s.isDirectory()) await visit(p); else if (s.isFile()) out.push(p); } }
  await visit(dir);
  return out;
}

test('long paths: migrate, verify, cleanup (dry run and real), GC and rollback work past 260 characters', async t => {
  const e = await env(t, { deep: true });
  const live = e.proj(e.a, `${S1}.jsonl`);
  assert.ok(live.length > 260, `live path is ${live.length} characters`);
  // A legacy snapshot with a redundant and a unique transcript, both at long paths.
  const sub = path.join('projects', 'proj', S1, 'subagents', 'agent-a17bb5405ef8f18d8aaaaaaaaaaaaaaa.jsonl');
  await write(path.join(e.a.directory, sub), line(S1, 'sub'));
  const snap = await legacySnapshot(e.a, `1795000000000-${'b'.repeat(36)}`, 'committed', {
    [path.join('incoming', sub)]: line(S1, 'sub'),
    [path.join('previous', 'projects', 'proj', S1, 'subagents', 'agent-unique0000000000000000000000000.jsonl')]: line(S1, 'only in backup')
  });
  const uniqueFile = path.join(snap, 'previous', 'projects', 'proj', S1, 'subagents', 'agent-unique0000000000000000000000000.jsonl');
  assert.ok(uniqueFile.length > 330, `unique path is ${uniqueFile.length} characters`);
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b], ...stopped });
  assert.equal(analysis.links.length, 0);
  // Cleanup preview and run before migration: nothing is skipped for its length.
  const plan = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], dryRun: true });
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.delete.length, 2);
  assert.deepEqual(plan.move.map(f => f.path), [uniqueFile]);
  const cleaned = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false });
  assert.deepEqual([cleaned.deleted, cleaned.moved, cleaned.skipped], [2, 1, []]);
  const manifest = (await storage.readManifests(e.store)).manifests.find(m => m.kind === 'cleanup');
  assert.equal(manifest.state, 'committed');
  assert.equal((await storage.readObject(e.store, manifest.objects[0].sha256)).toString('utf8'), line(S1, 'only in backup'));
  // Migration, Verify and listing through the junction.
  await run(e);
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'linked');
  assert.equal(await read(path.join(e.b.directory, sub)), line(S1, 'sub'));
  assert.deepEqual((await listSessions(e.b.directory, [process.cwd()], { switcherRoot: e.store })).map(s => s.id).sort(), [S1, S2, S3]);
  assert.deepEqual((await storage.verify({ switcherRoot: e.store, profiles: [e.a, e.b] })).problems, []);
  // GC with an old temp file left by an interrupted write.
  const leftover = path.join(e.store, 'backups', 'manifests', `x.json.tmp-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`);
  await write(leftover, '{');
  const old = new Date(Date.now() - 3600000);
  await fs.utimes(leftover, old, old);
  assert.match((await storage.verify({ switcherRoot: e.store, profiles: [e.a, e.b] })).notes.join(' '), /1 leftover temporary file/);
  const collected = await storage.gc(e.store);
  assert.deepEqual(collected.removedTemps.map(x => x.file), [leftover]);
  // Cleanup of the long preserved folders, then rollback rebuilds them from shared/.
  const after = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false });
  assert.deepEqual(after.skipped, []);
  await storage.rollback({ switcherRoot: e.store, profiles: [e.a], confirm: true, ...stopped });
  assert.equal(await storage.folderStatus(e.a.directory, 'projects', e.store), 'private');
  assert.equal(await read(path.join(e.a.directory, sub)), line(S1, 'sub'));
  assert.ok((await allFiles(path.join(e.a.directory, 'projects'))).some(f => f.length > 280));
});

test('long paths: an interrupted migration resumes, and rebuildFromShared works', async t => {
  const resumed = await env(t, { deep: true });
  await assert.rejects(run(resumed, { interrupt: async step => { if (step === 'verified:B/projects') throw crash(step); } }), /crash/);
  await storage.resumeMigration({ switcherRoot: resumed.store, confirm: true, ...stopped });
  for (const p of [resumed.a, resumed.b]) assert.equal(await storage.folderStatus(p.directory, 'projects', resumed.store), 'linked');
  const e = await env(t, { deep: true });
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'linked:A/projects') throw crash(step); } }), /crash/);
  const preserved = path.join(e.a.directory, (await fs.readdir(e.a.directory)).find(n => n.startsWith('projects.pre-shared-')));
  await storage.removeTree(preserved);
  await storage.rollback({ switcherRoot: e.store, confirm: true, ...stopped });
  assert.equal((await storage.readJournal(e.store)).profiles[0].folders[0].rebuilt, true);
  const rebuilt = await allFiles(path.join(e.a.directory, 'projects'));
  assert.equal(rebuilt.length, 3);
  assert.ok(rebuilt.every(f => f.length > 260));
});

test('long paths: the recovery marker records, verifies and resolves long .old- paths', async t => {
  const e = await env(t, { deep: true });
  const aside = path.join(e.store, 'shared', 'projects', 'proj', `${S1}.jsonl.old-${'c'.repeat(8)}-cccc-cccc-cccc-${'c'.repeat(12)}`);
  assert.ok(aside.length > 300);
  await storage.recordRecovery(e.store, { sessionId: S1, destination: e.a.directory, asides: [aside], error: 'test' });
  const entries = await storage.readRecovery(e.store);
  assert.deepEqual(entries[0].asides, [aside]);
  assert.ok(storage.renderRecovery(entries).includes(aside));
  assert.ok((await storage.verify({ switcherRoot: e.store, profiles: [] })).problems.some(p => p.includes(aside)));
  assert.deepEqual(await storage.resolveRecovery(e.store, { confirm: true, ids: entries.map(storage.recoveryId) }), { removed: 1, remaining: 0 });
});

test('long paths: realpath resolves long files and junctions where fs.promises.realpath fails', async t => {
  const e = await env(t, { deep: true });
  const file = e.proj(e.a, `${S1}.jsonl`);
  assert.ok(file.length > 260);
  assert.equal(storage.normalize(await storage.realpath(file)), storage.normalize(file));
  await storage.assertPlainPath(e.a.directory, file);
  await run(e);
  const through = e.proj(e.a, `${S2}.jsonl`);
  assert.equal(storage.normalize(await storage.realpath(through)), storage.normalize(path.join(e.store, 'shared', 'projects', 'proj', `${S2}.jsonl`)));
  assert.equal(await storage.managedLink(path.join(e.a.directory, 'projects'), e.a.directory, 'projects', e.store), true);
});

// ---- Decision 11: conversations stay private; savings come from backups ----

test('cleanup without any migration: backups covered by own or another profile are deleted, every diverged version survives', async t => {
  const e = await env(t);
  // Never migrated: both profiles keep private folders with diverged S3 transcripts.
  const aBranch = line(S3, 'a branch'), bBranch = line(S3, 'b branch, longer'), cBranch = line(S3, 'c branch only in a backup');
  const snapA = await legacySnapshot(e.a, '1-a', 'committed', {
    [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one'),          // same as A's own live S1
    [`previous/projects/proj/${S3}.jsonl`]: bBranch                    // same as B's live S3 (another profile)
  });
  const snapB = await legacySnapshot(e.b, '2-b', 'committed', {
    [`previous/projects/proj/${S1}.jsonl`]: line(S1, 'one'),          // prefix of B's own live S1
    [`previous/projects/proj/${S3}.jsonl`]: cBranch,                   // found only in backups
    [`incoming/projects/proj/${S3}.jsonl`]: cBranch                    // a second copy of it
  });
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b], ...stopped });
  const plan = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], dryRun: true });
  assert.equal(plan.delete.length, 5);
  // Both backup copies of the unique branch are listed; the store keeps it once.
  assert.equal(plan.move.length, 2);
  assert.equal(new Set(plan.move.map(f => f.sha256)).size, 1);
  // Reclaimable space is exactly what cleanup frees: deleted bytes minus the one copy kept in the store.
  assert.equal(analysis.metrics.reclaimable, plan.bytes - Buffer.byteLength(cBranch));
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false });
  assert.deepEqual([result.deleted, result.moved, result.skipped], [5, 2, []]);
  assert.equal((await storage.storedObjects(e.store)).length, 1);
  assert.equal(await exists(snapA), false);
  assert.equal(await exists(snapB), false);
  // All three S3 versions survive: two live, one pinned in the recovery store.
  assert.equal(await read(e.proj(e.a, `${S3}.jsonl`)), aBranch);
  assert.equal(await read(e.proj(e.b, `${S3}.jsonl`)), bBranch);
  const manifest = (await storage.readManifests(e.store)).manifests.find(m => m.kind === 'cleanup');
  assert.equal(manifest.pinned, true);
  assert.equal((await storage.readObject(e.store, manifest.objects[0].sha256)).toString('utf8'), cBranch);
  // No migration happened: profiles are still private and nothing is shared.
  for (const p of [e.a, e.b]) assert.equal(await storage.folderStatus(p.directory, 'projects', e.store), 'private');
  assert.equal(await exists(path.join(e.store, 'shared')), false);
  assert.equal(await exists(path.join(e.store, 'migration.json')), false);
});

test('the size estimate counts backups only, not live copies across profiles', async t => {
  const e = await env(t);
  assert.equal((await storage.measure({ switcherRoot: e.store, profiles: [e.a, e.b] })).reclaimable, 0);
  await legacySnapshot(e.a, '1-a', 'committed', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  assert.equal((await storage.measure({ switcherRoot: e.store, profiles: [e.a, e.b] })).reclaimable, Buffer.byteLength(line(S1, 'one')));
});

test('reclaimable space equals the dry-run net and the real net freed, with skipped backups excluded', async t => {
  const e = await env(t);
  const unique = line(S3, 'only in backups');
  // Eligible: a committed snapshot (one covered file, one unique file), a second
  // committed copy of the unique file, and a preserved folder whose content is
  // only in B's live S2. B has a pending recovery, and capture never archives a
  // locked profile, so that copy is moved into the archive first.
  await legacySnapshot(e.a, '1-committed', 'committed', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one'), [`previous/projects/proj/${S3}.jsonl`]: unique });
  await legacySnapshot(e.a, '2-committed-copy', 'committed', { [`previous/projects/proj/${S3}.jsonl`]: unique });
  await write(path.join(e.a.directory, 'projects.pre-shared-5', 'proj', `${S2}.jsonl`), line(S2, 'b only'));
  // Skipped: prepared, no manifest (legacy stage/), and every backup of a locked profile.
  const prepared = await legacySnapshot(e.a, '3-prepared', 'prepared', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  const noManifest = await legacySnapshot(e.a, '4-no-manifest', null, { [`stage/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  const locked = await legacySnapshot(e.b, '5-locked', 'committed', { [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') + line(S1, 'two') });
  await fs.mkdir(path.join(e.b.directory, '.profile-switch-lock'));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b], ...stopped });
  const plan = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], dryRun: true });
  const deletedBytes = Buffer.byteLength(line(S1, 'one')) + 2 * Buffer.byteLength(unique) + Buffer.byteLength(line(S2, 'b only'));
  const movedBytes = Buffer.byteLength(unique) + Buffer.byteLength(line(S2, 'b only'));
  assert.equal(plan.bytes, deletedBytes);
  assert.equal(plan.movedBytes, movedBytes);
  assert.equal(plan.net, deletedBytes - movedBytes);
  assert.equal(analysis.metrics.reclaimable, plan.net);
  assert.match(storage.renderCleanupPlan(plan), /Net space freed: /);
  assert.match(plan.delete.find(d => d.path.includes('projects.pre-shared-5')).reason, /covered only by a live file the archive does not capture/);
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false });
  assert.equal(result.deletedBytes, deletedBytes);
  assert.equal(result.movedBytes, movedBytes);
  assert.equal(result.freed, plan.net);
  assert.equal(result.freed, analysis.metrics.reclaimable);
  // Skipped backups are untouched; nothing is reported twice.
  for (const dir of [prepared, noManifest, locked]) assert.equal(await exists(dir), true);
  assert.equal(new Set(result.skipped.map(x => x.path)).size, result.skipped.length);
  // After cleanup, nothing reclaimable is left among the eligible backups.
  const after = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b], ...stopped });
  assert.equal(after.metrics.reclaimable, 0);
});

test('a unique file that cannot be stored is reported once and kept', async t => {
  const e = await env(t);
  const snap = await legacySnapshot(e.a, '1-a', 'committed', { [`previous/projects/proj/${S3}.jsonl`]: line(S3, 'unique') });
  t.mock.method(fs, 'copyFile', async () => { throw new Error('Simulated store failure'); });
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false });
  t.mock.restoreAll();
  const file = path.join(snap, 'previous', 'projects', 'proj', `${S3}.jsonl`);
  assert.deepEqual(result.skipped.filter(x => x.path === file).length, 1);
  assert.match(result.skipped[0].reason, /could not be stored/);
  assert.equal(await read(file), line(S3, 'unique'));
  assert.deepEqual([result.deleted, result.freed, result.movedBytes], [0, 0, 0]);
});

// ---- Unreferenced recovery-store objects --------------------------------

test('an unreferenced object does not count as kept: cleanup records it, and GC keeps it', async t => {
  const e = await env(t);
  const unique = line(S3, 'only here');
  const snap = await legacySnapshot(e.a, '1-a', 'committed', { [`previous/projects/proj/${S3}.jsonl`]: unique });
  // An object no manifest references, as an interrupted cleanup leaves it.
  const { sha256 } = await storage.putObject(e.store, Buffer.from(unique));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a], ...stopped });
  const plan = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], dryRun: true });
  assert.deepEqual(plan.move.map(m => m.sha256), [sha256]);
  // The object is already there, so moving adds no bytes.
  assert.equal(plan.movedBytes, 0);
  assert.equal(plan.net, Buffer.byteLength(unique));
  assert.equal(analysis.metrics.reclaimable, plan.net);
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false });
  assert.equal(result.freed, plan.net);
  assert.ok(result.manifest);
  assert.equal(await exists(snap), false);
  await storage.gc(e.store, { retentionDays: 30 });
  assert.equal((await storage.readObject(e.store, sha256)).toString('utf8'), unique);
  const manifest = (await storage.readManifests(e.store)).manifests.find(m => m.id === result.manifest);
  assert.equal(manifest.pinned, true);
  assert.deepEqual(manifest.objects.map(o => o.sha256), [sha256]);
});

test('a cleanup interrupted between storing and the manifest loses nothing after a rerun and GC', async t => {
  const e = await env(t);
  const unique = line(S3, 'only here');
  const file = path.join(await legacySnapshot(e.a, '1-a', 'committed', { [`previous/projects/proj/${S3}.jsonl`]: unique }), 'previous', 'projects', 'proj', `${S3}.jsonl`);
  // Simulate a kill after the object is stored and before its manifest is written.
  const originalWrite = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (target, ...rest) => {
    if (String(target).includes(`${path.sep}manifests${path.sep}`)) throw new Error('killed');
    return originalWrite(target, ...rest);
  });
  await assert.rejects(storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false }), /killed/);
  t.mock.restoreAll();
  assert.equal(await read(file), unique);
  assert.equal((await storage.storedObjects(e.store)).length, 1);
  assert.deepEqual((await storage.readManifests(e.store)).manifests, []);
  await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false });
  await storage.gc(e.store, { retentionDays: 30 });
  const sha = (await storage.storedObjects(e.store))[0];
  assert.equal((await storage.readObject(e.store, sha)).toString('utf8'), unique);
  assert.ok((await storage.readManifests(e.store)).manifests.some(m => m.pinned && m.objects.some(o => o.sha256 === sha)));
});

test('an unreadable manifest blocks reclaimable space and cleanup, and names the manifest', async t => {
  const e = await env(t);
  const unique = line(S3, 'only here');
  const snap = await legacySnapshot(e.a, '1-a', 'committed', { [`previous/projects/proj/${S3}.jsonl`]: unique, [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') });
  // The unique content is recorded in a pinned manifest, but another manifest is unreadable.
  const { sha256 } = await storage.putObject(e.store, Buffer.from(unique));
  await storage.writeManifest(e.store, { id: storage.newManifestId(), kind: 'cleanup', state: 'committed', pinned: true, created: new Date().toISOString(), objects: [{ name: 'x', sha256, size: Buffer.byteLength(unique) }] });
  const broken = path.join(e.store, 'backups', 'manifests', `${storage.newManifestId()}.json`);
  await write(broken, '{broken');
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a], ...stopped });
  assert.equal(analysis.metrics.reclaimable, null);
  assert.deepEqual(analysis.metrics.reclaimableBlocked, [broken]);
  const report = storage.renderReport(analysis);
  assert.match(report, /\| Reclaimable space \| blocked \|/);
  assert.ok(report.includes(`Reclaimable space is blocked: a backup manifest is unreadable (${broken})`));
  const measured = await storage.measure({ switcherRoot: e.store, profiles: [e.a] });
  assert.equal(storage.metricValue(measured, 'reclaimable'), 'blocked');
  const plan = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], dryRun: true });
  assert.deepEqual([plan.blocked, plan.unreadable, plan.net], [true, [broken], null]);
  assert.match(storage.renderCleanupPlan(plan), /Cleanup is blocked/);
  await assert.rejects(storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false }), /Cleanup is blocked: a backup manifest is unreadable/);
  // Nothing was deleted, including the unique-but-recorded file and the redundant one.
  assert.deepEqual(Object.keys(await tree(snap)).sort(), ['incoming/projects/proj/' + S1 + '.jsonl', 'manifest.json', 'previous/projects/proj/' + S3 + '.jsonl'].sort());
});

test('only manifests GC can never expire make content count as kept in the store', async t => {
  const e = await env(t);
  const unique = line(S3, 'only here');
  await legacySnapshot(e.a, '1-a', 'committed', { [`previous/projects/proj/${S3}.jsonl`]: unique });
  const { sha256 } = await storage.putObject(e.store, Buffer.from(unique));
  // An unpinned, committed manifest (retention can expire it) references the object.
  await storage.writeManifest(e.store, { id: storage.newManifestId(), kind: 'transfer', state: 'committed', pinned: false, created: new Date().toISOString(), objects: [{ name: 'x', sha256, size: Buffer.byteLength(unique) }] });
  const plan = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], dryRun: true });
  assert.deepEqual(plan.move.map(m => m.sha256), [sha256]);
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false });
  const pinned = (await storage.readManifests(e.store)).manifests.find(m => m.id === result.manifest);
  assert.equal(pinned.pinned, true);
  assert.deepEqual(pinned.objects.map(o => o.sha256), [sha256]);
  // Even after the unpinned manifest expires, GC keeps the content.
  await storage.gc(e.store, { retentionDays: 0, now: Date.now() + 1000 });
  assert.equal((await storage.readObject(e.store, sha256)).toString('utf8'), unique);
});

// ---- Transient errors on folder renames (reviewer suggestion 3) ------------------

// Fails the first rename of each history folder with a transient Windows
// error (a scanner holding a file), as EPERM, EBUSY and EACCES in turn.
function flakyFolderRenames(t) {
  const original = fs.rename, seen = new Set(), codes = ['EPERM', 'EBUSY', 'EACCES'];
  let injected = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    const folder = /(projects|file-history|image-cache)(\.pre-shared-\d+)?$/.test(String(from)) && /(projects|file-history|image-cache)(\.pre-shared-\d+)?$/.test(String(to));
    if (folder && !seen.has(from)) { seen.add(from); const code = codes[injected++ % codes.length]; throw Object.assign(new Error(`${code}: simulated`), { code }); }
    return original(from, to);
  });
  return () => injected;
}
test('migration and rollback folder renames are retried after transient EPERM, EBUSY and EACCES', { skip: process.platform !== 'win32' && 'retries apply on Windows' }, async t => {
  const e = await env(t);
  let injected = flakyFolderRenames(t);
  await run(e);
  assert.ok(injected() >= 2);
  for (const p of [e.a, e.b]) assert.equal(await storage.isPoolMember(p.directory, e.store), true);
  t.mock.restoreAll();
  injected = flakyFolderRenames(t);
  await storage.rollback({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, ...stopped });
  assert.ok(injected() >= 2);
  t.mock.restoreAll();
  for (const p of [e.a, e.b]) assert.equal(await storage.isPoolMember(p.directory, e.store), false);
  assert.equal(await read(e.proj(e.a, `${S1}.jsonl`)), line(S1, 'one') + line(S1, 'two'));
  // An interrupted migration is undone (rollbackJournal) through the same retries.
  const f = await env(t);
  await assert.rejects(run(f, { interrupt: async step => { if (step === 'verified:A/projects') throw crash(step); } }), /crash/);
  injected = flakyFolderRenames(t);
  const undone = await storage.rollback({ switcherRoot: f.store, confirm: true, ...stopped });
  t.mock.restoreAll();
  assert.equal(undone.interruptedMigration, true);
  assert.ok(injected() >= 1);
  assert.equal(await read(f.proj(f.a, `${S1}.jsonl`)), line(S1, 'one'));
});
