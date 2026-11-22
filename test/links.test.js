const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../src/storage');
const linking = require('../src/linking');
const { transferSession, transferEach, transferWorkspace, pendingSessions, listSessions } = require('../src/history');
const { assertDestinationAvailable } = require('../src/cli-continuation');

// Decision 12 part 2 and decision 13: hard-linked transcripts. Every test
// works under .test-tmp only.
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const ID = '12345678-1234-1234-1234-123456789abc', OTHER = '87654321-4321-4321-4321-cba987654321';
const PROJECT = 'proj';
const line = (text, id = ID) => JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), message: { role: 'user', content: text } }) + '\n';
const stopped = { detect: async () => [], alive: () => false };
const crash = step => Object.assign(new Error(`crash at ${step}`), { simulatedCrash: true });
const DAY = 86400000;
const uuid = n => `${String(n).repeat(8)}-0000-0000-0000-000000000000`;

async function write(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); }
async function exists(file) { return !!(await fs.lstat(file).catch(() => null)); }
async function id(file) { return linking.identity(await fs.lstat(file, { bigint: true })); }
async function env(t, { deep = false, profiles = 2 } = {}) {
  const base = path.join(__dirname, '..', '.test-tmp');
  await fs.mkdir(base, { recursive: true });
  const top = await fs.mkdtemp(path.join(base, 'links-'));
  t.after(() => fs.rm(top, { recursive: true, force: true }));
  let root = top;
  while (deep && root.length < 200) root = path.join(root, 'deep-folder-segment-0123456789');
  await fs.mkdir(root, { recursive: true });
  const store = path.join(root, 'switcher');
  const list = Array.from({ length: profiles }, (_, i) => ({ id: uuid(i + 1), name: 'ABCDEF'[i], directory: path.join(store, 'profiles', uuid(i + 1)) }));
  for (const p of list) { await fs.mkdir(p.directory, { recursive: true }); await write(path.join(p.directory, '.credentials.json'), `secret-${p.name}`); }
  const rel = (...parts) => path.join('projects', PROJECT, ...parts);
  const file = (p, ...parts) => path.join(p.directory, rel(...parts));
  return { root, store, profiles: list, a: list[0], b: list[1], c: list[2], rel, file, options: { switcherRoot: store } };
}
// A conversation in profile `p`: transcript, subagent transcript, title file, checkpoint.
async function conversation(e, p, text = 'hello') {
  await write(e.file(p, `${ID}.jsonl`), line(text));
  await write(e.file(p, ID, 'subagents', 'agent-1.jsonl'), 'subagent line\n');
  await write(e.file(p, ID, 'custom-title.json'), '{"title":"t"}');
  await write(path.join(p.directory, 'file-history', ID, 'snap'), 'checkpoint');
}
const session = { id: ID, project: PROJECT, cwd: process.cwd() };

// ---- T1, T2: carry by link ---------------------------------------------------

test('a carry links .jsonl transcripts and copies every other file; appends show through both names', async t => {
  const e = await env(t);
  await conversation(e, e.a);
  const result = await transferSession(e.a.directory, e.b.directory, session, e.options);
  assert.deepEqual(result.linked.sort(), [e.rel(`${ID}.jsonl`), e.rel(ID, 'subagents', 'agent-1.jsonl')].sort());
  assert.deepEqual(result.copiedInstead, []);
  // Transcripts: one file identity. Everything else: separate copies (decision 13).
  assert.equal(await id(e.file(e.b, `${ID}.jsonl`)), await id(e.file(e.a, `${ID}.jsonl`)));
  assert.equal(await id(e.file(e.b, ID, 'subagents', 'agent-1.jsonl')), await id(e.file(e.a, ID, 'subagents', 'agent-1.jsonl')));
  assert.notEqual(await id(e.file(e.b, ID, 'custom-title.json')), await id(e.file(e.a, ID, 'custom-title.json')));
  assert.notEqual(await id(path.join(e.b.directory, 'file-history', ID, 'snap')), await id(path.join(e.a.directory, 'file-history', ID, 'snap')));
  assert.equal(await fs.readFile(e.file(e.a, `${ID}.jsonl`), 'utf8'), line('hello'));
  // No temp or aside names are left.
  assert.deepEqual((await fs.readdir(path.join(e.b.directory, 'projects', PROJECT))).sort(), [ID, `${ID}.jsonl`].sort());
  // One conversation: an append through B shows through A.
  await fs.appendFile(e.file(e.b, `${ID}.jsonl`), line('continued in B'));
  assert.equal(await fs.readFile(e.file(e.a, `${ID}.jsonl`), 'utf8'), line('hello') + line('continued in B'));
  // Nothing is pending in either direction.
  assert.deepEqual(await pendingSessions(e.a.directory, e.b.directory, e.options), []);
  assert.deepEqual(await pendingSessions(e.b.directory, e.a.directory, e.options), []);
});

test('T1: a carry to a profile that already has the same file does nothing, before any lock or backup', async t => {
  const e = await env(t);
  await conversation(e, e.a);
  await transferSession(e.a.directory, e.b.directory, session, e.options);
  const manifests = (await storage.readManifests(e.store)).manifests.length;
  // A held profile lock and store lock would block any real transfer.
  await fs.mkdir(path.join(e.b.directory, '.profile-switch-lock'));
  const release = await storage.acquireStoreLock(e.store, 'test', { wait: 0 });
  try {
    const result = await transferSession(e.a.directory, e.b.directory, session, e.options);
    assert.deepEqual([result.unchanged, result.backup], [true, null]);
    // Back the other way as well.
    await fs.rmdir(path.join(e.b.directory, '.profile-switch-lock'));
    await fs.mkdir(path.join(e.a.directory, '.profile-switch-lock'));
    assert.equal((await transferSession(e.b.directory, e.a.directory, session, e.options)).unchanged, true);
  } finally { await release(); }
  assert.equal((await storage.readManifests(e.store)).manifests.length, manifests);
});

test('T2: a diverged destination version is archived, then replaced by the link; the source is untouched', async t => {
  const e = await env(t);
  await conversation(e, e.a, 'from A');
  await write(e.file(e.b, `${ID}.jsonl`), line('B branch'));
  const result = await transferSession(e.a.directory, e.b.directory, session, e.options);
  const manifest = JSON.parse(await fs.readFile(result.backup, 'utf8'));
  assert.equal(manifest.pinned, true);
  assert.equal((await storage.readObject(e.store, sha(Buffer.from(line('B branch'))))).toString(), line('B branch'));
  assert.equal(await id(e.file(e.b, `${ID}.jsonl`)), await id(e.file(e.a, `${ID}.jsonl`)));
  assert.equal(await fs.readFile(e.file(e.a, `${ID}.jsonl`), 'utf8'), line('from A'));
  assert.equal((await fs.lstat(e.file(e.a, `${ID}.jsonl`))).nlink, 2);
});

test('T2: a failed carry removes only the names it installed; the source file and the old destination survive', async t => {
  const e = await env(t);
  await conversation(e, e.a, 'from A');
  await write(e.file(e.b, `${ID}.jsonl`), line('B branch'));
  // Fail when the subagent folder (the second bundle root) is installed.
  const original = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(from).startsWith(`${ID}.tmp-`) && !from.endsWith('.jsonl') && !path.basename(from).includes('.jsonl')) throw new Error('Simulated disk failure');
    return original(from, to);
  });
  await assert.rejects(transferSession(e.a.directory, e.b.directory, session, e.options), /Simulated disk failure/);
  t.mock.restoreAll();
  assert.equal(await fs.readFile(e.file(e.a, `${ID}.jsonl`), 'utf8'), line('from A'));
  assert.equal((await fs.lstat(e.file(e.a, `${ID}.jsonl`))).nlink, 1);
  assert.equal((await fs.lstat(e.file(e.a, ID, 'subagents', 'agent-1.jsonl'))).nlink, 1);
  assert.equal(await fs.readFile(e.file(e.b, `${ID}.jsonl`), 'utf8'), line('B branch'));
  assert.deepEqual((await fs.readdir(path.join(e.b.directory, 'projects', PROJECT))).filter(n => /\.(tmp|old)-/.test(n)), []);
});

// ---- T3: copy fallbacks, reported ------------------------------------------

for (const code of ['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK']) {
  test(`T3: ${code} from the link falls back to a verified copy and is reported`, async t => {
    const e = await env(t);
    await conversation(e, e.a);
    t.mock.method(fs, 'link', async () => { throw Object.assign(new Error(code), { code }); });
    const result = await transferEach(e.a.directory, e.b.directory, [session], e.options);
    t.mock.restoreAll();
    const carried = result.copied[0];
    assert.deepEqual(carried.linked, []);
    assert.equal(carried.copiedInstead.length, 2);
    assert.ok(carried.copiedInstead.every(c => typeof c.reason === 'string' && c.reason.length));
    assert.notEqual(await id(e.file(e.b, `${ID}.jsonl`)), await id(e.file(e.a, `${ID}.jsonl`)));
    assert.equal(await fs.readFile(e.file(e.b, `${ID}.jsonl`), 'utf8'), line('hello'));
  });
}
test('T3: a cloud-synced folder gets copies, never links', async t => {
  const e = await env(t);
  await conversation(e, e.a);
  const result = await transferSession(e.a.directory, e.b.directory, session, { ...e.options, cloudRoots: [e.b.directory] });
  assert.deepEqual(result.linked, []);
  assert.ok(result.copiedInstead.every(c => c.reason === 'cloud-synced folder'));
  assert.notEqual(await id(e.file(e.b, `${ID}.jsonl`)), await id(e.file(e.a, `${ID}.jsonl`)));
  assert.equal(linking.cloudSynced(path.join(e.root, 'Dropbox', 'x')), true);
  assert.equal(linking.cloudSynced(path.join(e.root, 'OneDrive - Contoso', 'x')), true);
  assert.equal(linking.cloudSynced(e.b.directory), false);
});

// ---- T5: planted links ---------------------------------------------------------

// Every file under `dir` except account files: none may contain `secret`.
async function assertNoSecret(dir, secret) {
  for (const n of await fs.readdir(dir)) {
    const p = path.join(dir, n), st = await fs.lstat(p);
    if (st.isDirectory()) await assertNoSecret(p, secret);
    else if (n !== '.credentials.json') assert.ok(!(await fs.readFile(p, 'utf8')).includes(secret), p);
  }
}
test('I1: a subagent transcript hard-linked to a credentials file is never carried; the rest of the bundle carries', async t => {
  const e = await env(t, { profiles: 3 });
  await conversation(e, e.a);
  const subagent = e.file(e.a, ID, 'subagents', 'agent-1.jsonl');
  await fs.unlink(subagent);
  await fs.link(path.join(e.a.directory, '.credentials.json'), subagent);
  for (const [destination, options] of [[e.b.directory, e.options], [e.c.directory, { ...e.options, link: false }]]) {
    const result = await transferSession(e.a.directory, destination, session, options);
    // The planted file is skipped with a reason: neither linked nor copied.
    assert.deepEqual(result.skippedFiles.map(x => x.name), [e.rel(ID, 'subagents', 'agent-1.jsonl')]);
    assert.match(result.skippedFiles[0].reason, /account file/);
    assert.equal(await exists(path.join(destination, e.rel(ID, 'subagents', 'agent-1.jsonl'))), false);
    await assertNoSecret(destination, 'secret-A');
    // The rest of the bundle carries.
    assert.equal(await fs.readFile(path.join(destination, e.rel(`${ID}.jsonl`)), 'utf8'), line('hello'));
    assert.equal(await fs.readFile(path.join(destination, e.rel(ID, 'custom-title.json')), 'utf8'), '{"title":"t"}');
    assert.equal(await fs.readFile(path.join(destination, 'file-history', ID, 'snap'), 'utf8'), 'checkpoint');
  }
  assert.equal((await fs.lstat(path.join(e.a.directory, '.credentials.json'))).nlink, 2);
  // The transcript itself as a link to credentials: nothing is carried at all.
  await fs.unlink(e.file(e.a, `${ID}.jsonl`));
  await fs.link(path.join(e.a.directory, '.credentials.json'), e.file(e.a, `${ID}.jsonl`));
  await assert.rejects(transferSession(e.a.directory, path.join(e.root, 'other'), session, e.options));
});

test('I1: a transcript with names outside the profile folders is copied only if it belongs to this conversation', async t => {
  const e = await env(t);
  await conversation(e, e.a);
  const subagent = e.file(e.a, ID, 'subagents', 'agent-1.jsonl');
  const outside = path.join(e.root, 'elsewhere', 'agent.output');
  await fs.mkdir(path.dirname(outside), { recursive: true });
  // Not a transcript of this conversation (a foreign JSON object, no session id).
  await fs.writeFile(subagent, '{"claudeAiOauth":{"accessToken":"secret-token"}}\n');
  await fs.link(subagent, outside);
  const result = await transferSession(e.a.directory, e.b.directory, session, e.options);
  assert.deepEqual(result.skippedFiles.map(x => x.name), [e.rel(ID, 'subagents', 'agent-1.jsonl')]);
  assert.match(result.skippedFiles[0].reason, /not a transcript of this conversation/);
  await assertNoSecret(e.b.directory, 'secret-token');
  // Another session's transcript is refused as well.
  await fs.writeFile(subagent, line('other session', OTHER));
  const other = await transferSession(e.a.directory, e.c?.directory || path.join(e.root, 'third'), session, e.options);
  assert.equal(other.skippedFiles.length, 1);
  assert.equal(linking.isSessionTranscript(Buffer.from(line('mine') + '{"type":"summary"}\n'), ID), true);
  assert.equal(linking.isSessionTranscript(Buffer.from('{"type":"summary"}\n'), ID), false);
  assert.equal(linking.isSessionTranscript(Buffer.from(line('mine') + 'not json\n'), ID), false);
});

// ---- P1: one conversation is never live in two profiles ----------------------

test('P1: a shared conversation counts as open in every profile that holds a name for it', async t => {
  const e = await env(t, { profiles: 3 });
  await conversation(e, e.a);
  await write(path.join(e.a.directory, 'sessions', '555.json'), JSON.stringify({ pid: 555, sessionId: ID }));
  // Before the carry: the source holds the file the carry would link.
  await assert.rejects(assertDestinationAvailable(e.b.directory, ID, () => true, { ...e.options, source: e.a.directory }), /Never continue one conversation in two profiles at once/);
  // The CLI this switch stops itself is not counted.
  await assertDestinationAvailable(e.b.directory, ID, () => true, { ...e.options, source: e.a.directory, ignorePids: [555] });
  await transferSession(e.a.directory, e.b.directory, session, e.options);
  // After the carry, B shares the file: continuing in C is refused while A has it open.
  await transferSession(e.b.directory, e.c.directory, session, e.options);
  await assert.rejects(assertDestinationAvailable(e.c.directory, ID, () => true, e.options), /open in another profile that shares it/);
  await assertDestinationAvailable(e.c.directory, ID, () => false, e.options);
  // A profile holding a separate copy does not share it.
  const copy = await env(t);
  await conversation(copy, copy.a);
  await write(path.join(copy.a.directory, 'sessions', '555.json'), JSON.stringify({ pid: 555, sessionId: ID }));
  await transferSession(copy.a.directory, copy.b.directory, session, { ...copy.options, link: false });
  await assertDestinationAvailable(copy.b.directory, ID, () => true, copy.options);
});

// ---- Sweep isolation (gate 3, synthetic per decision 13) ------------------------

test('sweep isolation: deleting old names in B leaves A whole and resumable, and the archive keeps the newest', async t => {
  const e = await env(t);
  await conversation(e, e.a);
  await transferSession(e.a.directory, e.b.directory, session, e.options);
  await fs.appendFile(e.file(e.a, `${ID}.jsonl`), line('newest turn'));
  await write(e.file(e.b, `${OTHER}.jsonl`), line('only in B', OTHER));
  await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b] });
  // Claude's sweep in B: unlink every old name (transcripts, subagents, checkpoints).
  for (const f of [e.file(e.b, `${ID}.jsonl`), e.file(e.b, ID, 'subagents', 'agent-1.jsonl'), path.join(e.b.directory, 'file-history', ID, 'snap'), e.file(e.b, `${OTHER}.jsonl`)]) await fs.unlink(f);
  assert.equal(await fs.readFile(e.file(e.a, `${ID}.jsonl`), 'utf8'), line('hello') + line('newest turn'));
  assert.equal(await fs.readFile(e.file(e.a, ID, 'subagents', 'agent-1.jsonl'), 'utf8'), 'subagent line\n');
  assert.equal(await fs.readFile(path.join(e.a.directory, 'file-history', ID, 'snap'), 'utf8'), 'checkpoint');
  assert.deepEqual((await listSessions(e.a.directory, null, e.options)).map(s => s.id), [ID]);
  await storage.gc(e.store, { retentionDays: 30 });
  assert.equal((await storage.readObject(e.store, sha(Buffer.from(line('hello') + line('newest turn'))))).toString(), line('hello') + line('newest turn'));
  // The B-only conversation exists only in the archive now.
  assert.equal((await storage.readObject(e.store, sha(Buffer.from(line('only in B', OTHER))))).toString(), line('only in B', OTHER));
  const restored = await storage.restoreVersion(e.store, sha(Buffer.from(line('only in B', OTHER))), { directory: e.b.directory, rel: e.rel(`${OTHER}.jsonl`) });
  assert.equal(restored.written, true);
});

test('sweep isolation, converse: deleting A\'s names leaves B whole and resumable', async t => {
  const e = await env(t);
  await conversation(e, e.a);
  await transferSession(e.a.directory, e.b.directory, session, e.options);
  for (const f of [e.file(e.a, `${ID}.jsonl`), e.file(e.a, ID, 'subagents', 'agent-1.jsonl'), path.join(e.a.directory, 'file-history', ID, 'snap')]) await fs.unlink(f);
  assert.equal(await fs.readFile(e.file(e.b, `${ID}.jsonl`), 'utf8'), line('hello'));
  assert.equal((await fs.lstat(e.file(e.b, `${ID}.jsonl`))).nlink, 1);
  assert.equal(await fs.readFile(path.join(e.b.directory, 'file-history', ID, 'snap'), 'utf8'), 'checkpoint');
  assert.deepEqual((await listSessions(e.b.directory, null, e.options)).map(s => s.id), [ID]);
});

test('a replace-by-rename in one profile detaches the names, and the next capture archives both versions', async t => {
  const e = await env(t);
  await conversation(e, e.a);
  await transferSession(e.a.directory, e.b.directory, session, e.options);
  await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b] });
  // A writer that replaces the file (temp file, then rename) in B.
  const temp = e.file(e.b, `${ID}.jsonl.writer`);
  await fs.writeFile(temp, line('rewritten in B'));
  await fs.rename(temp, e.file(e.b, `${ID}.jsonl`));
  assert.notEqual(await id(e.file(e.b, `${ID}.jsonl`)), await id(e.file(e.a, `${ID}.jsonl`)));
  assert.equal(await fs.readFile(e.file(e.a, `${ID}.jsonl`), 'utf8'), line('hello'));
  await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b] });
  for (const v of [line('hello'), line('rewritten in B')]) assert.equal(await storage.objectValid(e.store, sha(Buffer.from(v))), true);
});

// ---- M1-M5: Link Identical Conversations ---------------------------------------

// Three profiles: A, B and C hold identical copies of one transcript (C's is
// the newest), B also has a diverged copy of another, and checkpoints are
// identical everywhere (never linked).
async function migrationEnv(t, options) {
  const e = await env(t, { profiles: 3, ...options });
  const same = line('same') + line('everywhere');
  for (const p of e.profiles) {
    await write(e.file(p, `${ID}.jsonl`), same);
    await write(e.file(p, ID, 'subagents', 'agent-1.jsonl'), 'same subagent\n');
    await write(path.join(p.directory, 'file-history', ID, 'snap'), 'checkpoint');
    await write(e.file(p, ID, 'custom-title.json'), '{"title":"t"}');
  }
  await write(e.file(e.a, `${OTHER}.jsonl`), line('A version', OTHER));
  await write(e.file(e.b, `${OTHER}.jsonl`), line('B version, diverged', OTHER));
  const later = new Date(Date.now() + 60000);
  await fs.utimes(e.file(e.c, `${ID}.jsonl`), later, later);
  return { ...e, same };
}
const run = (e, extra = {}) => linking.linkIdentical({ switcherRoot: e.store, profiles: e.profiles, confirm: true, ...stopped, ...extra });
const undo = (e, extra = {}) => linking.undoLinks({ switcherRoot: e.store, confirm: true, ...stopped, ...extra });

test('linking identical conversations: preview with exact bytes, archive first, link only identical .jsonl', async t => {
  const e = await migrationEnv(t);
  const size = Buffer.byteLength(e.same), sub = Buffer.byteLength('same subagent\n');
  const before = await storage.analyze({ switcherRoot: e.store, profiles: e.profiles, processes: false });
  const plan = await linking.linkIdentical({ switcherRoot: e.store, profiles: e.profiles, dryRun: true });
  assert.equal(plan.saved, 2 * size + 2 * sub);
  assert.equal(before.metrics.linkSaving, plan.saved);
  assert.match(storage.renderReport(before), /Projected after Link Identical Conversations/);
  assert.match(linking.renderLinkPlan(plan), /saving/);
  assert.equal(plan.groups.length, 2);
  // The keeper is the newest copy (C), so no name looks older to the sweep.
  assert.equal(plan.groups.find(g => g.rel.endsWith(`${ID}.jsonl`)).keeper.abs, e.file(e.c, `${ID}.jsonl`));
  await assert.rejects(linking.linkIdentical({ switcherRoot: e.store, profiles: e.profiles }), /confirmation/);
  // Claude-stopped precondition.
  await assert.rejects(linking.linkIdentical({ switcherRoot: e.store, profiles: e.profiles, confirm: true, detect: async () => [{ pid: 9, name: 'claude.exe' }], alive: () => false }), /Stop Claude first/);
  const result = await run(e);
  assert.deepEqual([result.linked, result.saved], [4, plan.saved]);
  const keeper = await id(e.file(e.c, `${ID}.jsonl`));
  for (const p of e.profiles) {
    assert.equal(await id(e.file(p, `${ID}.jsonl`)), keeper);
    assert.equal(await fs.readFile(e.file(p, `${ID}.jsonl`), 'utf8'), e.same);
  }
  // Never linked: checkpoints, title files, and diverged transcripts.
  assert.notEqual(await id(path.join(e.a.directory, 'file-history', ID, 'snap')), await id(path.join(e.b.directory, 'file-history', ID, 'snap')));
  assert.notEqual(await id(e.file(e.a, ID, 'custom-title.json')), await id(e.file(e.b, ID, 'custom-title.json')));
  assert.notEqual(await id(e.file(e.a, `${OTHER}.jsonl`)), await id(e.file(e.b, `${OTHER}.jsonl`)));
  // M1: every distinct version is in the archive under a pinned manifest.
  for (const v of [e.same, 'same subagent\n', line('A version', OTHER), line('B version, diverged', OTHER)]) assert.equal(await storage.objectValid(e.store, sha(Buffer.from(v))), true);
  assert.ok((await storage.readManifests(e.store)).manifests.some(m => m.kind === 'link-migration' && m.pinned && m.state === 'committed'));
  // Accounting by identity: the profiles' history shrank by exactly the planned bytes.
  const after = await storage.analyze({ switcherRoot: e.store, profiles: e.profiles, processes: false });
  assert.equal(after.metrics.profile, before.metrics.profile - plan.saved);
  assert.equal(after.metrics.linkSaving, 0);
  // While it runs, transfers refuse; after it, they work again.
  assert.equal((await linking.readLinkJournal(e.store)).state, 'committed');
  // Undo gives every name its own copy again.
  await assert.rejects(undo(e, { freeSpace: async () => 0 }), /Not enough free disk space/);
  assert.equal(await id(e.file(e.a, `${ID}.jsonl`)), keeper);
  const undone = await undo(e);
  assert.equal(undone.restored, 4);
  const ids = new Set();
  for (const p of e.profiles) { ids.add(await id(e.file(p, `${ID}.jsonl`))); assert.equal(await fs.readFile(e.file(p, `${ID}.jsonl`), 'utf8'), e.same); }
  assert.equal(ids.size, 3);
  const final = await storage.analyze({ switcherRoot: e.store, profiles: e.profiles, processes: false });
  assert.equal(final.metrics.profile, before.metrics.profile);
});

test('linking refuses a transcript with names outside the profile folders, and transfers wait while it runs', async t => {
  const e = await migrationEnv(t);
  await fs.link(e.file(e.a, `${ID}.jsonl`), path.join(e.root, 'outside-name.jsonl'));
  const plan = await linking.linkIdentical({ switcherRoot: e.store, profiles: e.profiles, dryRun: true });
  assert.ok(plan.skipped.some(s => s.path === e.file(e.a, `${ID}.jsonl`) && /names/.test(s.reason)));
  assert.ok(plan.groups.every(g => g.targets.every(x => x.abs !== e.file(e.a, `${ID}.jsonl`))));
  // An interrupted run blocks every transfer until it is resumed or undone.
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'archived') throw crash(step); } }), /crash/);
  await write(path.join(e.root, 'dest', 'x'), '');
  await assert.rejects(transferSession(e.a.directory, path.join(e.root, 'dest'), session, e.options), /Linking identical conversations is in progress/);
  await assert.rejects(storage.cleanup({ switcherRoot: e.store, profiles: e.profiles, dryRun: true }), /Linking identical conversations is in progress/);
  await linking.resumeLinks({ switcherRoot: e.store, confirm: true, ...stopped });
  // T5 still holds for transfers: A's transcript has an outside name, so it is copied, not linked.
  const carried = await transferSession(e.a.directory, path.join(e.root, 'dest'), session, e.options);
  assert.ok(carried.copiedInstead.some(c => c.name === e.rel(`${ID}.jsonl`) && c.reason === 'has names outside the Claude profile folders'));
  assert.notEqual(await id(path.join(e.root, 'dest', 'projects', PROJECT, `${ID}.jsonl`)), await id(e.file(e.a, `${ID}.jsonl`)));
});

// Records every journal step of a complete run, then kills a fresh run at
// each one and either resumes or undoes it.
test('linking survives a kill at every journal step: resume links everything, undo restores separate copies', async t => {
  const probe = await migrationEnv(t);
  const steps = [];
  await run(probe, { interrupt: async step => { steps.push(step); } });
  const undoSteps = [];
  await undo(probe, { interrupt: async step => { undoSteps.push(step); } });
  assert.ok(steps.length >= 10);
  for (let k = 0; k < steps.length; k++) {
    const e = await migrationEnv(t);
    let n = 0;
    await assert.rejects(run(e, { interrupt: async () => { if (n++ === k) throw crash(steps[k]); } }), /crash/);
    assert.equal(await storage.readStoreLock(e.store), null);
    // Content is intact at every point.
    for (const p of e.profiles) assert.equal(await fs.readFile(e.file(p, `${ID}.jsonl`), 'utf8'), e.same);
    if (k % 2 === 0) {
      if ((await linking.readLinkJournal(e.store)).state === 'running') await linking.resumeLinks({ switcherRoot: e.store, confirm: true, ...stopped });
      const keeper = await id(e.file(e.c, `${ID}.jsonl`));
      for (const p of e.profiles) assert.equal(await id(e.file(p, `${ID}.jsonl`)), keeper, steps[k]);
    } else {
      await undo(e);
      const ids = new Set();
      for (const p of e.profiles) ids.add(await id(e.file(p, `${ID}.jsonl`)));
      assert.equal(ids.size, 3, steps[k]);
    }
    for (const p of e.profiles) {
      assert.equal(await fs.readFile(e.file(p, `${ID}.jsonl`), 'utf8'), e.same);
      assert.deepEqual((await fs.readdir(path.join(p.directory, 'projects', PROJECT))).filter(x => /\.tmp-/.test(x)), [], steps[k]);
    }
  }
  // A kill during the undo itself: the next undo (via resume) finishes it.
  for (let k = 0; k < undoSteps.length; k += 2) {
    const e = await migrationEnv(t);
    await run(e);
    let n = 0;
    await assert.rejects(undo(e, { interrupt: async () => { if (n++ === k) throw crash(undoSteps[k]); } }), /crash/);
    if ((await linking.readLinkJournal(e.store)).state === 'running') await linking.resumeLinks({ switcherRoot: e.store, confirm: true, ...stopped });
    const ids = new Set();
    for (const p of e.profiles) { ids.add(await id(e.file(p, `${ID}.jsonl`))); assert.equal(await fs.readFile(e.file(p, `${ID}.jsonl`), 'utf8'), e.same); }
    assert.equal(ids.size, 3, undoSteps[k]);
    assert.equal((await linking.readLinkJournal(e.store)).state, 'rolled-back');
  }
});

test('the link journal accepts only linkable transcripts inside the listed profiles', async t => {
  const e = await migrationEnv(t);
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'archived') throw crash(step); } }), /crash/);
  const file = storage.paths(e.store).links;
  const journal = JSON.parse(await fs.readFile(file, 'utf8'));
  journal.groups[0].targets[0].abs = path.join(e.a.directory, '.credentials.json');
  await fs.writeFile(file, JSON.stringify(journal));
  await assert.rejects(linking.resumeLinks({ switcherRoot: e.store, confirm: true, ...stopped }), /may not be linked/);
  journal.groups[0].targets[0].abs = path.join(e.root, 'elsewhere', `${ID}.jsonl`);
  await fs.writeFile(file, JSON.stringify(journal));
  await assert.rejects(linking.resumeLinks({ switcherRoot: e.store, confirm: true, ...stopped }), /may not be linked|outside the listed profiles/);
  assert.equal((await fs.lstat(path.join(e.a.directory, '.credentials.json'))).nlink, 1);
});

// ---- Long paths ------------------------------------------------------------

test('long paths: carry by link, failed-carry rollback, linking and undo past 260 characters', async t => {
  const e = await migrationEnv(t, { deep: true });
  assert.ok(e.file(e.a, ID, 'subagents', 'agent-1.jsonl').length > 260);
  const d = { id: uuid(4), name: 'D', directory: path.join(e.store, 'profiles', uuid(4)) };
  await fs.mkdir(d.directory, { recursive: true });
  const result = await transferSession(e.a.directory, d.directory, session, e.options);
  assert.equal(result.linked.length, 2);
  assert.equal(await id(e.file(d, ID, 'subagents', 'agent-1.jsonl')), await id(e.file(e.a, ID, 'subagents', 'agent-1.jsonl')));
  // A failed carry into a fifth profile removes only its own names.
  const f = { directory: path.join(e.store, 'profiles', uuid(5)) };
  await fs.mkdir(f.directory, { recursive: true });
  const original = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => { if (path.basename(from).startsWith(`${ID}.tmp-`) && !path.basename(from).includes('.jsonl')) throw new Error('Simulated disk failure'); return original(from, to); });
  await assert.rejects(transferSession(e.a.directory, f.directory, session, e.options), /Simulated/);
  t.mock.restoreAll();
  assert.equal(await exists(e.file(f, `${ID}.jsonl`)), false);
  assert.equal((await fs.lstat(e.file(e.a, `${ID}.jsonl`))).nlink, 2);
  const profiles = [...e.profiles, d];
  await linking.linkIdentical({ switcherRoot: e.store, profiles, confirm: true, ...stopped });
  const keeper = await id(e.file(e.c, `${ID}.jsonl`));
  for (const p of profiles) assert.equal(await id(e.file(p, `${ID}.jsonl`)), keeper);
  await undo(e);
  for (const p of profiles) assert.equal(await fs.readFile(e.file(p, `${ID}.jsonl`), 'utf8'), e.same);
});


test('a subagent transcript Claude also keeps in its temp tasks folder is copied; the rest is linked and the switch goes ahead', async t => {
  const e = await env(t);
  await conversation(e, e.a);
  // Real subagent transcript rows carry the session id.
  await fs.writeFile(e.file(e.a, ID, 'subagents', 'agent-1.jsonl'), line('subagent turn'));
  // Claude Code hard-links subagent transcripts into %TEMP%\claude\...\tasks\*.output.
  const tasks = path.join(e.root, 'Temp', 'claude', 'abc', 'tasks');
  await fs.mkdir(tasks, { recursive: true });
  await fs.link(e.file(e.a, ID, 'subagents', 'agent-1.jsonl'), path.join(tasks, 'agent-1.output'));
  const result = await transferWorkspace(e.a.directory, e.b.directory, [session], e.options);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].linked, [e.rel(`${ID}.jsonl`)]);
  assert.deepEqual(result[0].copiedInstead, [{ name: e.rel(ID, 'subagents', 'agent-1.jsonl'), reason: 'has names outside the Claude profile folders' }]);
  assert.equal(await id(e.file(e.b, `${ID}.jsonl`)), await id(e.file(e.a, `${ID}.jsonl`)));
  assert.notEqual(await id(e.file(e.b, ID, 'subagents', 'agent-1.jsonl')), await id(e.file(e.a, ID, 'subagents', 'agent-1.jsonl')));
  assert.equal(await fs.readFile(e.file(e.b, ID, 'subagents', 'agent-1.jsonl'), 'utf8'), line('subagent turn'));
  assert.equal((await fs.lstat(path.join(tasks, 'agent-1.output'))).nlink, 2);
});

test('a target appended to between a crash and the resume keeps its content and is not linked', async t => {
  const e = await migrationEnv(t);
  const target = e.file(e.a, `${ID}.jsonl`);
  await assert.rejects(run(e, { interrupt: async step => { if (step === `linking:${target}`) throw crash(step); } }), /crash/);
  // The user appends to A's copy before the resume.
  await fs.appendFile(target, line('written after the crash'));
  const result = await linking.resumeLinks({ switcherRoot: e.store, confirm: true, ...stopped });
  assert.equal(await fs.readFile(target, 'utf8'), e.same + line('written after the crash'));
  assert.notEqual(await id(target), await id(e.file(e.c, `${ID}.jsonl`)));
  assert.equal(await fs.readFile(e.file(e.c, `${ID}.jsonl`), 'utf8'), e.same);
  assert.deepEqual((await fs.readdir(path.dirname(target))).filter(x => /\.tmp-/.test(x)), []);
  const journal = await linking.readLinkJournal(e.store);
  assert.ok(journal.groups.some(g => g.targets.some(x => x.abs === target && x.step === 'kept')));
  assert.equal(journal.state, 'committed');
  assert.deepEqual(result.kept.map(k => k.path), [target]);
  // B's unchanged copy was still linked; A's bytes are not counted as saved.
  assert.equal(await id(e.file(e.b, `${ID}.jsonl`)), await id(e.file(e.c, `${ID}.jsonl`)));
  assert.equal(result.saved, Buffer.byteLength(e.same) + 2 * Buffer.byteLength('same subagent\n'));
  // Also when the change lands after the temp link exists (right before the rename).
  const e2 = await migrationEnv(t);
  const target2 = e2.file(e2.a, `${ID}.jsonl`);
  await assert.rejects(run(e2, { interrupt: async step => { if (step === `temp-linked:${target2}`) throw crash(step); } }), /crash/);
  await fs.appendFile(target2, line('late write'));
  await linking.resumeLinks({ switcherRoot: e2.store, confirm: true, ...stopped });
  assert.equal(await fs.readFile(target2, 'utf8'), e2.same + line('late write'));
  assert.notEqual(await id(target2), await id(e2.file(e2.c, `${ID}.jsonl`)));
  assert.deepEqual((await fs.readdir(path.dirname(target2))).filter(x => /\.tmp-/.test(x)), []);
  // Undo after a kept target leaves its content alone.
  await undo(e2);
  assert.equal(await fs.readFile(target2, 'utf8'), e2.same + line('late write'));
});

test('the Analyze projection skips profiles with a pending transfer recovery, as the plan does', async t => {
  const e = await migrationEnv(t);
  await fs.mkdir(path.join(e.b.directory, '.profile-switch-lock'));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: e.profiles, processes: false });
  const plan = await linking.linkIdentical({ switcherRoot: e.store, profiles: e.profiles, dryRun: true });
  assert.ok(plan.saved > 0);
  assert.equal(analysis.metrics.linkSaving, plan.saved);
  assert.ok(plan.groups.every(g => g.targets.every(x => !x.abs.startsWith(e.b.directory))));
});

test('P1 with allowSource: open only in the source is reported, open in the destination or a sharing third profile still refuses', async t => {
  const e = await env(t, { profiles: 3 });
  await conversation(e, e.a);
  await write(path.join(e.a.directory, 'sessions', '555.json'), JSON.stringify({ pid: 555, sessionId: ID }));
  const options = { ...e.options, source: e.a.directory, allowSource: true };
  assert.deepEqual(await assertDestinationAvailable(e.b.directory, ID, () => true, options), { liveInSource: true });
  assert.deepEqual(await assertDestinationAvailable(e.b.directory, ID, () => false, options), { liveInSource: false });
  // A third profile sharing the file with the session open: refused.
  await fs.mkdir(path.join(e.c.directory, 'projects', PROJECT), { recursive: true });
  await fs.link(e.file(e.a, `${ID}.jsonl`), e.file(e.c, `${ID}.jsonl`));
  await write(path.join(e.c.directory, 'sessions', '556.json'), JSON.stringify({ pid: 556, sessionId: ID }));
  await assert.rejects(assertDestinationAvailable(e.b.directory, ID, pid => pid === 556, options), /open in another profile that shares it/);
  // Open in the destination itself: refused, as before.
  await write(path.join(e.b.directory, 'sessions', '557.json'), JSON.stringify({ pid: 557, sessionId: ID }));
  await assert.rejects(assertDestinationAvailable(e.b.directory, ID, pid => pid === 557, options), /already open under the destination profile/);
});

test('I2: an edited link journal (outside source, foreign profile folder) is refused and nothing is archived', async t => {
  const e = await migrationEnv(t);
  await assert.rejects(run(e, { interrupt: async step => { if (step === 'archived') throw crash(step); } }), /crash/);
  const file = storage.paths(e.store).links;
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  const outside = path.join(e.root, 'outside', 'secret.jsonl');
  await write(outside, line('outside content'));
  const stored = await storage.storedObjects(e.store);
  const cases = [
    j => { j.versions[0].source = outside; },
    j => { j.versions[0].source = path.join(e.a.directory, '.credentials.json'); j.versions[0].root = e.a.directory; },
    j => { j.versions[0].sha256 = 'not-a-hash'; },
    j => { j.versions[0].root = path.join(e.root, 'outside'); j.versions[0].source = path.join(e.root, 'outside', 'projects', 'p', 'x.jsonl'); },
    j => { j.profiles.push({ id: 'x', name: 'X', directory: path.join(e.root, 'outside') }); j.versions[0].root = path.join(e.root, 'outside'); j.versions[0].source = path.join(e.root, 'outside', 'projects', 'p', 'x.jsonl'); },
    j => { j.groups[0].keeper.abs = outside; }
  ];
  for (const edit of cases) {
    const journal = JSON.parse(JSON.stringify(original));
    journal.archived = false;
    edit(journal);
    await fs.writeFile(file, JSON.stringify(journal));
    await assert.rejects(linking.resumeLinks({ switcherRoot: e.store, confirm: true, ...stopped }), /link-migration\.json/);
    assert.deepEqual(await storage.storedObjects(e.store), stored);
  }
  assert.equal(await storage.objectValid(e.store, sha(Buffer.from(line('outside content')))), false);
});

test('Rec 5: only names ending in .jsonl are linkable', () => {
  assert.equal(storage.isLinkable('projects/p/a.jsonl'), true);
  assert.equal(storage.isLinkable(['projects', 'p', 'a', 'subagents', 'b.JSONL'].join(path.sep)), true);
  assert.equal(storage.isLinkable('projects/p/axjsonl'), false);
  assert.equal(storage.isLinkable('projects/p/a.jsonl.bak'), false);
  assert.equal(storage.isLinkable('projects/p/a/custom-title.json'), false);
  assert.equal(storage.isLinkable('file-history/a/b.jsonl'), false);
});
