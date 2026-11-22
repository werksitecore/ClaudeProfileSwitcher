const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../src/storage');
const linking = require('../src/linking');

// Architect's final validation: the Clean guard, capture screening, gate 5
// reconciliation, planLinks volume and cloud handling, and the block cache.
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const S1 = '11111111-1111-1111-1111-111111111111', S3 = '33333333-3333-3333-3333-333333333333';
const line = (id, text) => JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), message: { role: 'user', content: text } }) + '\n';
const uuid = n => `${String(n).repeat(8)}-0000-0000-0000-000000000000`;
async function write(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); }
async function env(t) {
  await fs.mkdir(path.join(__dirname, '..', '.test-tmp'), { recursive: true });
  const root = await fs.mkdtemp(path.join(__dirname, '..', '.test-tmp', 'optimize-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = path.join(root, 'switcher');
  const a = { id: uuid(1), name: 'A', directory: path.join(store, 'profiles', uuid(1)) };
  const b = { id: uuid(2), name: 'B', directory: path.join(store, 'profiles', uuid(2)) };
  const proj = (p, name) => path.join(p.directory, 'projects', 'proj', name);
  await write(proj(a, `${S1}.jsonl`), line(S1, 'one'));
  await write(proj(b, `${S1}.jsonl`), line(S1, 'one') + line(S1, 'two'));
  // Diverged transcript and diverged checkpoint.
  await write(proj(a, `${S3}.jsonl`), line(S3, 'a branch'));
  await write(proj(b, `${S3}.jsonl`), line(S3, 'b branch, longer'));
  await write(path.join(a.directory, 'file-history', S3, 'snap'), 'checkpoint A');
  await write(path.join(b.directory, 'file-history', S3, 'snap'), 'checkpoint B');
  for (const p of [a, b]) await write(path.join(p.directory, '.credentials.json'), `secret-${p.name}`);
  // A third version of S3 that exists only in an old backup.
  const snap = path.join(a.directory, '.profile-switch-backups', '1-old');
  await write(path.join(snap, 'previous', 'projects', 'proj', `${S3}.jsonl`), line(S3, 'only in a backup'));
  await write(path.join(snap, 'manifest.json'), JSON.stringify({ state: 'committed' }));
  return { root, store, a, b, proj, snap, profiles: [a, b] };
}

test('Clean Redundant Backups refuses until a complete capture has run since the last change to live history', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: e.profiles };
  assert.equal((await storage.captureStatus(options)).current, false);
  await assert.rejects(storage.cleanup({ ...options, dryRun: true, requireCapture: true }), err => err.code === 'ENOTCAPTURED' && /no complete capture has run yet/.test(err.message) && /every 30 minutes/.test(err.message) && /Claude is stopped or idle/.test(err.message));
  await assert.rejects(storage.cleanup({ ...options, confirm: true, requireCapture: true }), /needs a complete archive capture/);
  assert.equal(await fs.stat(e.snap).then(() => true), true);
  // A capture that stops early (cancelled) is not complete.
  const controller = new AbortController();
  controller.abort();
  assert.equal((await storage.capture({ ...options, signal: controller.signal })).complete, false);
  assert.equal((await storage.captureStatus(options)).current, false);
  const done = await storage.capture(options);
  assert.equal(done.complete, true);
  const status = await storage.captureStatus(options);
  assert.equal(status.current, true);
  assert.ok(status.completed);
  // Live history changes: refused again until the next complete capture.
  await fs.appendFile(e.proj(e.b, `${S1}.jsonl`), line(S1, 'three'));
  const stale = await storage.captureStatus(options);
  assert.deepEqual([stale.current, stale.pending], [false, [e.proj(e.b, `${S1}.jsonl`)]]);
  await assert.rejects(storage.cleanup({ ...options, dryRun: true, requireCapture: true }), /1 file has changed since the last one/);
  await storage.capture(options);
  const plan = await storage.cleanup({ ...options, dryRun: true, requireCapture: true });
  assert.ok(plan.delete.length > 0);
  const result = await storage.cleanup({ ...options, confirm: true, requireCapture: true });
  assert.ok(result.deleted > 0);
});

test('capture never archives a history file that is the same file as an account file', async t => {
  const e = await env(t);
  const planted = e.proj(e.a, `${uuid(9)}.jsonl`);
  await fs.link(path.join(e.a.directory, '.credentials.json'), planted);
  const result = await storage.capture({ switcherRoot: e.store, profiles: e.profiles });
  assert.ok(result.skipped.some(s => s.path === planted && /account file/.test(s.reason)));
  assert.equal(await storage.objectValid(e.store, sha(Buffer.from('secret-A'))), false);
  const catalog = await storage.archiveOf(e.store).readCatalog();
  assert.ok(!Object.keys(catalog.keys).some(k => k.includes(uuid(9))));
  // It does not hold up the Clean guard either.
  assert.equal((await storage.captureStatus({ switcherRoot: e.store, profiles: e.profiles })).current, true);
});

test('gate 5: every diverged version is listed with where it is kept, and confirmed by full rebuild after the run', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: e.profiles };
  const before = await storage.reconcileDiverged(options);
  const transcript = before.groups.find(g => g.kind === 'transcript');
  const checkpoint = before.groups.find(g => g.kind === 'checkpoint');
  assert.equal(transcript.versions.length, 3);
  assert.equal(checkpoint.versions.length, 2);
  const backupOnly = transcript.versions.find(v => v.sha256 === sha(Buffer.from(line(S3, 'only in a backup'))));
  assert.deepEqual(backupOnly.kept, []);
  assert.match(backupOnly.plan, /cleanup moves it into the archive/);
  assert.equal(before.unkept, 1);
  assert.ok(transcript.versions.filter(v => v !== backupOnly).every(v => v.kept.includes('live')));
  assert.match(storage.renderReconcile(before), /## Diverged versions\n/);
  assert.match(storage.renderReconcile(before), /1 exists only in old backups; cleanup archives it \(pinned\) before anything is deleted/);
  assert.ok(!/gate 5/.test(storage.renderReconcile(before)));
  // The run: capture, clean (moves the backup-only version into the archive), compact.
  await storage.capture(options);
  await storage.cleanup({ ...options, confirm: true, requireCapture: true });
  await storage.gc(e.store, { retentionDays: 30, compact: true });
  const after = await storage.reconcileDiverged({ ...options, expect: before });
  assert.deepEqual([after.versions, after.confirmed, after.missing], [5, 5, 0]);
  assert.match(storage.renderReconcile(after), /5 of 5 versions rebuilt from the archive/);
  // A version that is not in the archive is reported as missing.
  const fake = { groups: [{ rel: 'projects/proj/x.jsonl', kind: 'transcript', versions: [{ sha256: 'f'.repeat(64), size: 3 }] }] };
  const missing = await storage.reconcileDiverged({ ...options, expect: fake });
  assert.deepEqual([missing.confirmed, missing.missing], [0, 1]);
  assert.match(storage.renderReconcile(missing), /not in the archive/);
});

test('planLinks skips cloud-synced folders and reports them; identical copies elsewhere still link', async t => {
  const e = await env(t);
  const c = { id: uuid(3), name: 'C', directory: path.join(e.store, 'profiles', uuid(3)) };
  for (const p of [e.a, e.b, c]) await write(e.proj(p, `${uuid(7)}.jsonl`), line(uuid(7), 'same everywhere'));
  const plan = await linking.planLinks({ switcherRoot: e.store, profiles: [e.a, e.b, c], cloudRoots: [c.directory] });
  const group = plan.groups.find(g => g.rel.includes(uuid(7)));
  assert.equal(group.targets.length, 1);
  assert.ok([group.keeper.abs, group.targets[0].abs].every(p => !p.startsWith(c.directory)));
  assert.ok(plan.skipped.some(s => s.path === e.proj(c, `${uuid(7)}.jsonl`) && /cloud-synced/.test(s.reason)));
});

test('the archive block cache lasts one run: repeated rebuilds in a run read each block once', async t => {
  const e = await env(t);
  const v = Buffer.from(line(S1, 'cached'));
  await storage.putObject(e.store, v);
  const a = storage.archiveOf(e.store);
  a.startRun();
  const original = fs.open;
  let packReads = 0;
  t.mock.method(fs, 'open', async (file, ...rest) => { if (String(file).endsWith('.pack')) packReads++; return original(file, ...rest); });
  for (let i = 0; i < 3; i++) assert.equal(await storage.objectValid(e.store, sha(v), v.length), true);
  assert.equal(packReads, 1);
  // A new run (here: taking the store lock) starts with an empty cache.
  await storage.withStoreLock(e.store, 'test', async () => { assert.equal(await storage.objectValid(e.store, sha(v), v.length), true); });
  assert.equal(packReads, 2);
  t.mock.restoreAll();
});

// ---- Reviewer suggestions ----------------------------------------------------------

test('suggestion 1: a real cleanup requires a complete capture by default; opting out must be explicit', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: e.profiles };
  await assert.rejects(storage.cleanup({ ...options, confirm: true }), err => err.code === 'ENOTCAPTURED');
  assert.equal(await fs.stat(e.snap).then(() => true), true);
  // The read-only preview does not need it unless asked.
  assert.ok((await storage.cleanup({ ...options, dryRun: true })).delete.length > 0);
  await assert.rejects(storage.cleanup({ ...options, dryRun: true, requireCapture: true }), err => err.code === 'ENOTCAPTURED');
  // Explicit opt-out still works (used by callers that manage their own order).
  assert.ok((await storage.cleanup({ ...options, confirm: true, requireCapture: false })).deleted > 0);
});

test('suggestion 2: a backup covered only by a live file capture never archives is moved into the archive, not deleted bare', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: e.profiles };
  const maxBytes = 1000;
  // A's live S1 grows past the capture limit; the backup holds its prefix.
  const prefix = line(S1, 'one');
  const big = prefix + line(S1, 'x'.repeat(2000));
  await write(e.proj(e.a, `${S1}.jsonl`), big);
  await write(e.proj(e.b, `${S1}.jsonl`), line(S1, 'b has its own'));
  const snap = path.join(e.a.directory, '.profile-switch-backups', '2-prefix');
  await write(path.join(snap, 'incoming', 'projects', 'proj', `${S1}.jsonl`), prefix);
  await write(path.join(snap, 'manifest.json'), JSON.stringify({ state: 'committed' }));
  const captured = await storage.capture({ ...options, maxBytes });
  assert.ok(captured.skipped.some(s => s.path === e.proj(e.a, `${S1}.jsonl`) && /capture limit/.test(s.reason)));
  assert.equal(captured.complete, true);
  const plan = await storage.cleanup({ ...options, dryRun: true, maxBytes });
  const entry = plan.delete.find(d => d.path === path.join(snap, 'incoming', 'projects', 'proj', `${S1}.jsonl`));
  assert.match(entry.reason, /covered only by a live file the archive does not capture/);
  const result = await storage.cleanup({ ...options, confirm: true, maxBytes });
  assert.ok(result.deleted > 0);
  // It was archived under a pinned manifest before it was deleted.
  assert.equal(await storage.objectValid(e.store, sha(Buffer.from(prefix))), true);
  const { manifests } = await storage.readManifests(e.store);
  assert.ok(manifests.some(m => m.pinned && m.objects.some(o => o.sha256 === sha(Buffer.from(prefix)))));
});

test('suggestion 2: the capture guard is re-checked per batch for the live files that batch relies on', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: e.profiles };
  // Two snapshots; the second holds a prefix of B's live S1, and only B's
  // (A's own S1 differs).
  await write(e.proj(e.a, `${S1}.jsonl`), line(S1, 'A has its own'));
  await write(path.join(e.a.directory, '.profile-switch-backups', '2-second', 'incoming', 'projects', 'proj', `${S1}.jsonl`), line(S1, 'one'));
  await write(path.join(e.a.directory, '.profile-switch-backups', '2-second', 'manifest.json'), JSON.stringify({ state: 'committed' }));
  await storage.capture(options);
  let changed = false;
  const result = await storage.cleanup({ ...options, confirm: true, between: async () => {
    // Between batches, B's live S1 changes: it no longer matches what was captured.
    if (!changed) { changed = true; await fs.appendFile(e.proj(e.b, `${S1}.jsonl`), line(S1, 'written between batches')); }
  } });
  assert.ok(result.deleted > 0);
  // The second batch relied on B's S1, which had changed: its backup went to the archive first.
  assert.equal(await storage.objectValid(e.store, sha(Buffer.from(line(S1, 'one')))), true);
  const { manifests } = await storage.readManifests(e.store);
  assert.ok(manifests.some(m => m.pinned && m.objects.some(o => o.sha256 === sha(Buffer.from(line(S1, 'one'))))));
});

test('suggestion 4: after retention drops a prefix version, the confirmation finds it inside the newer one, not missing', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: [e.b] };
  const file = e.proj(e.b, `${S1}.jsonl`);
  const t0 = Date.now() - 60 * 86400000;
  const v1 = await fs.readFile(file);
  await storage.capture({ ...options, now: () => t0 });
  await fs.appendFile(file, line(S1, 'three'));
  const v2 = await fs.readFile(file);
  await storage.capture({ ...options, now: () => t0 + 86400000 });
  const dropped = await storage.gc(e.store, { retentionDays: 30 });
  assert.ok(dropped.expiredVersions.some(x => x.sha256 === sha(v1)));
  assert.equal(await storage.objectValid(e.store, sha(v1), v1.length), false);
  const expect = { groups: [{ rel: path.join('projects', 'proj', `${S1}.jsonl`), kind: 'transcript', versions: [{ sha256: sha(v1), size: v1.length }, { sha256: sha(v2), size: v2.length }] }] };
  const result = await storage.reconcileDiverged({ ...options, expect });
  assert.deepEqual([result.confirmed, result.missing], [2, 0]);
  assert.deepEqual(result.groups[0].versions.map(v => v.kept[0]), ['inside a newer version', 'archive']);
  assert.match(storage.renderReconcile(result), /kept inside a newer archived version/);
  // A version that is not a prefix of anything archived is still missing.
  const other = { groups: [{ rel: expect.groups[0].rel, kind: 'transcript', versions: [{ sha256: sha(Buffer.from('nope')), size: 4 }] }] };
  assert.equal((await storage.reconcileDiverged({ ...options, expect: other })).missing, 1);
});

test('discardOutcome reports what still keeps a discarded version: the archive, backups, and profiles that still have it', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: e.profiles };
  const file = e.proj(e.b, `${S1}.jsonl`);
  const data = await fs.readFile(file);
  const key = path.join('projects', 'proj', `${S1}.jsonl`);
  await storage.capture(options);
  // A pinned backup also lists this version.
  const manifest = { id: storage.newManifestId(), kind: 'cleanup', state: 'committed', pinned: true, created: new Date().toISOString(), objects: [{ name: key, sha256: sha(data), size: data.length }] };
  await storage.writeManifest(e.store, manifest);
  const catalogKey = Object.keys((await storage.archiveOf(e.store).readCatalog()).keys).find(k => k.endsWith(`${S1}.jsonl`));
  await storage.discardVersions(e.store, [{ key: catalogKey, sha256: sha(data) }], { confirm: true });
  let left = await storage.discardOutcome(e.store, { key: catalogKey, sha256: sha(data), profiles: e.profiles });
  assert.equal(left.inArchive, true);
  assert.deepEqual(left.keptBy.map(b => b.id), [manifest.id]);
  assert.match(left.keptBy[0].label, /Cleanup backup/);
  assert.deepEqual(left.presentIn.sort(), ['A', 'B']);
  // After the backup is discarded and the conversation deleted everywhere, nothing keeps it.
  await storage.discardManifests(e.store, [manifest.id], { confirm: true });
  for (const p of e.profiles) await fs.unlink(e.proj(p, `${S1}.jsonl`));
  left = await storage.discardOutcome(e.store, { key: catalogKey, sha256: sha(data), profiles: e.profiles });
  assert.deepEqual([left.inArchive, left.keptBy, left.presentIn], [false, [], []]);
});

test('discardOutcome reports content that is still inside a newer archived version', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: [e.b] };
  const file = e.proj(e.b, `${S1}.jsonl`);
  const v1 = await fs.readFile(file);
  await storage.capture(options);
  await fs.appendFile(file, line(S1, 'three'));
  await storage.capture(options);
  const key = Object.keys((await storage.archiveOf(e.store).readCatalog()).keys).find(k => k.endsWith(`${S1}.jsonl`));
  await storage.discardVersions(e.store, [{ key, sha256: sha(v1) }], { confirm: true });
  const left = await storage.discardOutcome(e.store, { key, sha256: sha(v1), size: v1.length, profiles: [] });
  assert.deepEqual([left.inArchive, left.inNewer, left.keptBy], [false, true, []]);
});

test('D1: versions held only in snapshots cleanup keeps are archived (pinned) and the snapshots stay on disk', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: e.profiles };
  // Two more diverged versions of S3, each only in a snapshot cleanup does not clean.
  const preparedFile = path.join(e.a.directory, '.profile-switch-backups', '2-prepared', 'previous', 'projects', 'proj', `${S3}.jsonl`);
  const noManifestFile = path.join(e.b.directory, '.profile-switch-backups', '3-no-manifest', 'stage', 'projects', 'proj', `${S3}.jsonl`);
  await write(preparedFile, line(S3, 'only in a prepared snapshot'));
  await write(path.join(e.a.directory, '.profile-switch-backups', '2-prepared', 'manifest.json'), JSON.stringify({ state: 'prepared' }));
  await write(noManifestFile, line(S3, 'only in a snapshot without a manifest'));
  const before = await storage.reconcileDiverged(options);
  const transcript = before.groups.find(g => g.kind === 'transcript');
  const planOf = text => transcript.versions.find(v => v.sha256 === sha(Buffer.from(line(S3, text)))).plan;
  // The preview says which backups are moved and which are archived and kept.
  assert.match(planOf('only in a backup'), /cleanup moves it into the archive/);
  assert.match(planOf('only in a prepared snapshot'), /cleanup keeps.*archives it.*leaves those backups in place/);
  assert.match(planOf('only in a snapshot without a manifest'), /cleanup keeps.*leaves those backups in place/);
  await storage.capture(options);
  const plan = await storage.cleanup({ ...options, dryRun: true, requireCapture: true });
  assert.deepEqual(plan.archiveKept.map(k => k.path).sort(), [noManifestFile, preparedFile].sort());
  assert.match(storage.renderCleanupPlan(plan), /## Archived and kept/);
  const result = await storage.cleanup({ ...options, confirm: true, requireCapture: true });
  assert.equal(result.archivedKept, 2);
  // The kept snapshots are untouched, and their versions rebuild from the archive under a pinned manifest.
  assert.equal(await fs.readFile(preparedFile, 'utf8'), line(S3, 'only in a prepared snapshot'));
  assert.equal(await fs.readFile(noManifestFile, 'utf8'), line(S3, 'only in a snapshot without a manifest'));
  const { manifests } = await storage.readManifests(e.store);
  for (const text of ['only in a prepared snapshot', 'only in a snapshot without a manifest']) {
    const digest = sha(Buffer.from(line(S3, text)));
    assert.equal(await storage.objectValid(e.store, digest), true, text);
    assert.ok(manifests.some(m => m.pinned && m.objects.some(o => o.sha256 === digest)), text);
  }
  // Step 6 now completes: every diverged version is confirmed, then GC and compaction run.
  const confirmed = await storage.reconcileDiverged({ ...options, expect: before });
  assert.deepEqual([confirmed.missing, confirmed.confirmed], [0, before.versions]);
  await storage.gc(e.store, { retentionDays: 30, compact: true });
  for (const text of ['only in a prepared snapshot', 'only in a snapshot without a manifest']) assert.equal(await storage.objectValid(e.store, sha(Buffer.from(line(S3, text)))), true);
  // A second run archives nothing new and still leaves the snapshots alone.
  const again = await storage.cleanup({ ...options, confirm: true, requireCapture: true });
  assert.equal(again.archivedKept, 0);
  assert.equal(await fs.readFile(preparedFile, 'utf8'), line(S3, 'only in a prepared snapshot'));
});

test('cleanup never reads, archives or deletes a backup file hard-linked to a credentials file, and reports each skip once', async t => {
  const e = await env(t);
  const options = { switcherRoot: e.store, profiles: e.profiles };
  const credentials = path.join(e.a.directory, '.credentials.json');
  // A committed snapshot (a deletion candidate), a prepared one (kept: archive-only path),
  // and a snapshot without a manifest (N7), each with a name for the credentials file.
  const planted = [
    path.join(e.a.directory, '.profile-switch-backups', '5-committed', 'previous', 'projects', 'proj', `${uuid(5)}.jsonl`),
    path.join(e.a.directory, '.profile-switch-backups', '6-prepared', 'previous', 'projects', 'proj', `${uuid(6)}.jsonl`),
    path.join(e.a.directory, '.profile-switch-backups', '7-no-manifest', 'stage', 'projects', 'proj', `${uuid(7)}.jsonl`)
  ];
  for (const file of planted) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.link(credentials, file); }
  await write(path.join(e.a.directory, '.profile-switch-backups', '5-committed', 'manifest.json'), JSON.stringify({ state: 'committed' }));
  await write(path.join(e.a.directory, '.profile-switch-backups', '6-prepared', 'manifest.json'), JSON.stringify({ state: 'prepared' }));
  await storage.capture(options);
  const plan = await storage.cleanup({ ...options, dryRun: true, requireCapture: true });
  for (const file of planted) {
    assert.ok(!plan.delete.some(d => d.path === file), file);
    assert.ok(!(plan.archiveKept || []).some(k => k.path === file), file);
    assert.equal(plan.skipped.filter(s => s.path === file).length, 1, file);
    assert.match(plan.skipped.find(s => s.path === file).reason, /account file .*never read, archived or deleted/);
  }
  // No path is reported twice with the same reason.
  assert.equal(new Set(plan.skipped.map(s => `${s.path}|${s.reason}`)).size, plan.skipped.length);
  // Hashing would read the file: the planted names are never opened for reading.
  const read = [];
  const original = fs.open;
  t.mock.method(fs, 'open', async (file, ...rest) => { if (planted.includes(String(file))) read.push(file); return original(file, ...rest); });
  const result = await storage.cleanup({ ...options, confirm: true, requireCapture: true, snapshots: [path.dirname(path.dirname(path.dirname(path.dirname(planted[2]))))] });
  t.mock.restoreAll();
  for (const file of planted) assert.equal((await fs.stat(file)).isFile(), true, file);
  assert.equal((await fs.lstat(credentials)).nlink, 1 + planted.length);
  assert.equal(await storage.objectValid(e.store, sha(Buffer.from('secret-A'))), false);
  const { manifests } = await storage.readManifests(e.store);
  assert.ok(!manifests.some(m => (m.objects || []).some(o => o.sha256 === sha(Buffer.from('secret-A')))));
  // The snapshot without a manifest was kept whole, with a reason.
  assert.equal(result.snapshots[0].removed, false);
  assert.match(result.snapshots[0].reason, /account file/);
  assert.ok(!read.some(f => f === planted[0] || f === planted[1]));
});
