const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../src/storage');
const archive = require('../src/archive');
const { transferSession } = require('../src/history');

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const line = (id, text) => JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), message: { role: 'user', content: text } }) + '\n';
const S1 = '11111111-1111-1111-1111-111111111111', S2 = '22222222-2222-2222-2222-222222222222', S3 = '33333333-3333-3333-3333-333333333333';
const A_ID = 'aaaaaaaa-0000-0000-0000-00000000000a', B_ID = 'bbbbbbbb-0000-0000-0000-00000000000b';
const UUID = '0f0f0f0f-1111-2222-3333-444444444444';
const crash = step => Object.assign(new Error(`crash at ${step}`), { simulatedCrash: true });
const DAY = 86400000;

async function write(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); }
async function exists(file) { return !!(await fs.lstat(file).catch(() => null)); }
// Everything under .test-tmp only. With deep, every history path is longer
// than 260 characters (Windows MAX_PATH).
async function env(t, { deep = false } = {}) {
  const base = path.join(__dirname, '..', '.test-tmp');
  await fs.mkdir(base, { recursive: true });
  const top = await fs.mkdtemp(path.join(base, 'archive-'));
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
  await write(path.join(a.directory, 'file-history', S1, 'snap'), 'checkpoint');
  for (const p of [a, b]) await write(path.join(p.directory, '.credentials.json'), `secret-${p.name}`);
  return { root, store, a, b, proj, archiveDir: path.join(store, 'backups', 'archive') };
}
const opened = e => storage.archiveOf(e.store);
const samples = {
  crlf: Buffer.from('{"a":1}\r\n{"b":2}\r\n'),
  lf: Buffer.from('{"a":1}\n{"b":2}\n'),
  noFinalNewline: Buffer.from('{"a":1}\n{"b":2'),
  binary: crypto.randomBytes(70000),
  empty: Buffer.alloc(0),
  mixed: Buffer.from('{"x":1}\r\n\n\r\n{"y":2}\n\r'),
  bigLine: Buffer.from('{"big":"' + 'x'.repeat(2 * 1024 * 1024) + '"}\n{"small":1}\n')
};
// Every file under `dir`: content, mtime and file identity.
async function fingerprint(dir) {
  const out = {};
  const visit = async d => {
    for (const name of (await fs.readdir(d)).sort()) {
      const p = path.join(d, name), s = await fs.lstat(p, { bigint: true });
      if (s.isDirectory()) await visit(p);
      else out[p] = { data: (await fs.readFile(p)).toString('base64'), mtime: String(s.mtimeNs), id: `${s.dev}:${s.ino}`, size: String(s.size) };
    }
  };
  await visit(dir);
  return out;
}

// ---- A1-A3: format, round trip, dedup, torn tail, index rebuild ----------

test('archive round trip is byte-exact for CRLF, LF, no final newline, binary, empty and long lines', async t => {
  const e = await env(t);
  for (const [name, data] of Object.entries(samples)) {
    const { sha256, stored } = await storage.putObject(e.store, data);
    assert.equal(stored, true, name);
    assert.ok((await storage.readObject(e.store, sha256)).equals(data), name);
    assert.equal(await storage.objectValid(e.store, sha256, data.length), true, name);
    assert.equal(await storage.objectValid(e.store, sha256, data.length + 1), false, name);
  }
  // Lines keep their own terminators: chunks reassemble exactly.
  assert.deepEqual(archive.splitLines(samples.mixed).map(c => c.toString()), ['{"x":1}\r\n', '\n', '\r\n', '{"y":2}\n', '\r']);
  // putObjectFile from a file, JSONL split by name.
  const file = e.proj(e.b, `${S1}.jsonl`);
  const data = await fs.readFile(file);
  assert.equal((await storage.putObjectFile(e.store, file, sha(data), e.b.directory)).stored, true);
  assert.ok((await storage.readObject(e.store, sha(data))).equals(data));
  // Nothing is written into backups/objects any more.
  assert.equal(await exists(path.join(e.store, 'backups', 'objects')), false);
  const check = await opened(e).check({ full: true });
  assert.deepEqual([check.failed, check.torn], [[], []]);
  assert.equal(check.rebuilt, check.recipes);
});

test('identical lines are stored once across versions, and a newer version is stored as a delta', async t => {
  const e = await env(t);
  const lines = Array.from({ length: 50 }, (_, i) => line(S1, `message ${i} ${'y'.repeat(200)}`));
  const v1 = Buffer.from(lines.slice(0, 40).join('')), v2 = Buffer.from(lines.join(''));
  const a = opened(e);
  await a.putVersions([{ data: v1, name: 'x.jsonl' }]);
  const before = (await a.loadIndex()).chunks.size;
  const [r2] = await a.putVersions([{ data: v2, name: 'x.jsonl', base: sha(v1) }]);
  const state = await a.loadIndex();
  assert.equal(before, 40);
  assert.equal(state.chunks.size, 50);
  assert.equal(r2.delta, true);
  const recipe = await a.readRecipe(sha(v2));
  assert.deepEqual([recipe.base, recipe.take, recipe.own.length / 32], [sha(v1), 40, 10]);
  assert.ok((await a.read(sha(v2))).equals(v2));
  // The same version again writes nothing new.
  const packBytes = (await a.packList()).reduce((n, p) => n + p.size, 0);
  const [again] = await a.putVersions([{ data: v2, name: 'x.jsonl' }]);
  assert.equal(again.stored, false);
  assert.equal((await a.packList()).reduce((n, p) => n + p.size, 0), packBytes);
  // A copy of the same content under another name adds no chunk either.
  await storage.putObject(e.store, Buffer.concat([v2, Buffer.from(line(S1, 'one more'))]));
  assert.equal((await a.loadIndex()).chunks.size, 51);
});

test('a torn pack tail is ignored, never appended to, and earlier versions still rebuild', async t => {
  const e = await env(t);
  const a = opened(e);
  const v1 = Buffer.from(line(S1, 'first') + line(S1, 'second'));
  await storage.putObject(e.store, v1);
  const [pack] = await a.packList();
  // A crash mid-write: half a block at the end of the pack.
  const v2 = Buffer.from(line(S1, 'third, never indexed'));
  const encodedTail = Buffer.concat([Buffer.from('CPB1'), Buffer.alloc(16, 7), v2.subarray(0, 10)]);
  await fs.appendFile(pack.file, encodedTail);
  a.forget();
  const state = await a.loadIndex();
  assert.equal(state.packs.get(pack.id).torn, true);
  assert.equal(await storage.objectValid(e.store, sha(v1), v1.length), true);
  // The next write starts a new pack; the torn pack is not rewritten.
  const sizeBefore = (await fs.stat(pack.file)).size;
  await storage.putObject(e.store, v2);
  assert.equal((await fs.stat(pack.file)).size, sizeBefore);
  assert.equal((await a.packList()).length, 2);
  assert.equal(await storage.objectValid(e.store, sha(v2), v2.length), true);
  const check = await a.check({ full: true });
  assert.equal(check.torn.length, 1);
  assert.deepEqual(check.failed, []);
  // A flipped byte inside a block is caught by its CRC: that version no longer verifies.
  const buf = await fs.readFile(pack.file);
  buf[40] ^= 0xff;
  await fs.writeFile(pack.file, buf);
  a.forget();
  assert.equal(await storage.objectValid(e.store, sha(v1), v1.length), false);
});

test('the index is rebuilt from the packs when it is missing, torn or never written', async t => {
  const e = await env(t);
  const a = opened(e);
  const versions = [samples.crlf, samples.lf, samples.noFinalNewline, samples.binary];
  for (const v of versions) await storage.putObject(e.store, v);
  const full = (await a.loadIndex()).chunks.size;
  // Missing index: rebuilt by scanning.
  await fs.unlink(path.join(e.archiveDir, 'index.bin'));
  a.forget();
  for (const v of versions) assert.equal(await storage.objectValid(e.store, sha(v), v.length), true);
  assert.deepEqual(await a.rebuildIndex(), { chunks: full });
  // A torn last record is ignored; the scan recovers the entry.
  await fs.appendFile(path.join(e.archiveDir, 'index.bin'), Buffer.alloc(20, 1));
  a.forget();
  assert.equal((await a.loadIndex()).chunks.size, full);
  for (const v of versions) assert.equal(await storage.objectValid(e.store, sha(v), v.length), true);
  // A write after a torn index rewrites it in full, so every record stays readable.
  const extra = Buffer.from(line(S2, 'after a torn index'));
  await storage.putObject(e.store, extra);
  a.forget();
  const raw = await fs.readFile(path.join(e.archiveDir, 'index.bin'));
  assert.equal((raw.length - 8) % 58, 0);
  assert.equal((await a.loadIndex()).recovered.length, 0);
  // Killed after the pack was flushed, before the index: the blocks are recovered.
  const late = Buffer.from(line(S3, 'pack written, index not'));
  await assert.rejects(a.putVersions([{ data: late, name: 'x.jsonl' }], { interrupt: async step => { if (step === 'pack-flushed') throw crash(step); } }), /crash/);
  a.forget();
  const state = await a.loadIndex();
  assert.ok(state.chunks.has(sha(late)));
  assert.equal(await storage.objectValid(e.store, sha(late)), false); // no recipe yet: not relied on
  await storage.putObject(e.store, late);
  assert.equal(await storage.objectValid(e.store, sha(late), late.length), true);
});

// ---- A4: import of legacy objects, GC and compaction ---------------------

test('importing legacy objects survives a kill at every step and deletes each object only after it rebuilds', async t => {
  const e = await env(t);
  const legacy = [samples.crlf, samples.binary, Buffer.from(line(S1, 'legacy only'))];
  const steps = ['journal-written', 'pack-flushed', 'index-flushed', 'recipe-flushed', `imported:${sha(legacy[0])}`, `deleted:${sha(legacy[0])}`, `imported:${sha(legacy[1])}`, `deleted:${sha(legacy[2])}`];
  for (const step of steps) {
    // Fresh legacy store for each kill point.
    await fs.rm(path.join(e.store, 'backups'), { recursive: true, force: true });
    for (const v of legacy) await write(path.join(e.store, 'backups', 'objects', sha(v)), v);
    await write(path.join(e.store, 'backups', 'objects', 'f'.repeat(64)), 'damaged: does not match its name');
    await storage.writeManifest(e.store, { id: storage.newManifestId(), kind: 'cleanup', state: 'committed', pinned: true, created: new Date().toISOString(), objects: legacy.map(v => ({ name: 'x', sha256: sha(v), size: v.length })) });
    storage.archiveOf(e.store).forget();
    await assert.rejects(storage.importObjects(e.store), /confirmation/);
    let fired = false;
    await assert.rejects(storage.importObjects(e.store, { confirm: true, interrupt: async s => { if (s === step && !fired) { fired = true; throw crash(s); } } }), /crash/, step);
    // After the kill: every version is still readable, from one store or the other.
    for (const v of legacy) assert.ok((await storage.readObject(e.store, sha(v))).equals(v), step);
    assert.equal(await storage.readStoreLock(e.store), null);
    const result = await storage.importObjects(e.store, { confirm: true });
    assert.deepEqual(result.damaged, ['f'.repeat(64)], step);
    for (const v of legacy) assert.equal(await storage.objectValid(e.store, sha(v), v.length), true, step);
    assert.deepEqual((await storage.legacyObjects(e.store)).map(o => o.sha256), ['f'.repeat(64)], step);
    // GC keeps everything the manifest references.
    await storage.gc(e.store, { retentionDays: 30 });
    for (const v of legacy) assert.ok((await storage.readObject(e.store, sha(v))).equals(v), step);
  }
});

test('GC drops unreferenced recipes, and compaction survives a kill at every step', async t => {
  const e = await env(t);
  archive.limits.blockBytes = 64;
  t.after(() => { archive.limits.blockBytes = 256 * 1024; });
  const keep = [Buffer.from(line(S1, 'keep a') + line(S1, 'keep b')), samples.binary];
  const drop = [Buffer.from(line(S2, 'drop a') + line(S2, 'drop b') + line(S2, 'drop c')), crypto.randomBytes(5000)];
  const steps = ['compact-written', 'compact-index-switched', 'compact-deleted:1', null];
  for (const step of steps) {
    await fs.rm(path.join(e.store, 'backups'), { recursive: true, force: true });
    storage.archiveOf(e.store).forget();
    for (const v of [...keep, ...drop]) await storage.putObject(e.store, v);
    await storage.writeManifest(e.store, { id: storage.newManifestId(), kind: 'cleanup', state: 'committed', pinned: true, created: new Date().toISOString(), objects: keep.map(v => ({ name: 'x', sha256: sha(v), size: v.length })) });
    const result = await storage.gc(e.store, { retentionDays: 30 });
    assert.deepEqual(result.removedObjects.map(o => o.name).sort(), drop.map(sha).sort());
    assert.deepEqual(await storage.storedObjects(e.store), keep.map(sha).sort());
    await assert.rejects(storage.compactArchive(e.store), /confirmation/);
    if (step) {
      await assert.rejects(storage.compactArchive(e.store, { confirm: true, minDeadRatio: 0, interrupt: async s => { if (s === step) throw crash(s); } }), /crash/);
      storage.archiveOf(e.store).forget();
      // Mid-compaction, every referenced version still rebuilds.
      for (const v of keep) assert.ok((await storage.readObject(e.store, sha(v))).equals(v), step);
      assert.equal(await exists(path.join(e.archiveDir, 'compact.json')), true);
      // The next GC finishes or undoes the journaled compaction.
      await storage.gc(e.store, { retentionDays: 30 });
      assert.equal(await exists(path.join(e.archiveDir, 'compact.json')), false);
    }
    const compacted = await storage.compactArchive(e.store, { confirm: true, minDeadRatio: 0 });
    for (const v of keep) assert.equal(await storage.objectValid(e.store, sha(v), v.length), true, String(step));
    // After compaction no pack holds dead data: the dropped chunks are gone.
    const state = await storage.archiveOf(e.store).loadIndex();
    for (const v of drop) assert.equal(state.chunks.has(sha(v)), false, String(step));
    assert.ok(compacted.compacted.length >= 0);
    const check = await storage.archiveOf(e.store).check({ full: true });
    assert.deepEqual([check.failed, check.torn], [[], []]);
  }
});

test('a linked archive folder is refused by writes, GC and verify, and its target survives', async t => {
  const e = await env(t);
  const out = path.join(e.root, 'outside-archive');
  await fs.mkdir(out);
  await fs.mkdir(path.join(e.store, 'backups'), { recursive: true });
  await fs.symlink(out, e.archiveDir, 'junction');
  await assert.rejects(storage.putObject(e.store, Buffer.from('data')), /link/);
  await assert.rejects(storage.gc(e.store), /link/);
  await assert.rejects(storage.capture({ switcherRoot: e.store, profiles: [e.a] }), /link/);
  const result = await storage.verify({ switcherRoot: e.store, profiles: [e.a] });
  assert.ok(result.problems.some(p => /link/.test(p)));
  assert.deepEqual(await fs.readdir(out), []);
  await storage.removeLink(e.archiveDir);
});

// ---- A6: restore and export -----------------------------------------------

test('restore and export verify, never overwrite a different version, and Show Backup exports a manifest', async t => {
  const e = await env(t, { deep: true });
  const version = Buffer.from(line(S2, 'archived') + line(S2, 'version'));
  const { sha256 } = await storage.putObject(e.store, version);
  // Export into a new file.
  const target = path.join(e.root, 'exports-here', 'x'.repeat(40), 'out.jsonl');
  assert.ok(target.length > 260);
  assert.equal((await storage.exportVersion(e.store, sha256, target)).written, true);
  assert.ok((await fs.readFile(target)).equals(version));
  // Identical target: nothing written. Different target: refused and unchanged.
  assert.equal((await storage.exportVersion(e.store, sha256, target)).identical, true);
  await fs.writeFile(target, 'a different version');
  await assert.rejects(storage.exportVersion(e.store, sha256, target), /different version/);
  assert.equal(await fs.readFile(target, 'utf8'), 'a different version');
  // Restore into a profile: only where the file is missing.
  const rel = `projects/proj/${S2}.jsonl`;
  await assert.rejects(storage.restoreVersion(e.store, sha256, { directory: e.b.directory, rel }), /different version/);
  assert.equal(await fs.readFile(e.proj(e.b, `${S2}.jsonl`), 'utf8'), line(S2, 'b only'));
  await fs.unlink(e.proj(e.b, `${S2}.jsonl`));
  const restored = await storage.restoreVersion(e.store, sha256, { directory: e.b.directory, rel });
  assert.equal(restored.written, true);
  assert.ok((await fs.readFile(e.proj(e.b, `${S2}.jsonl`))).equals(version));
  await assert.rejects(storage.restoreVersion(e.store, sha256, { directory: e.b.directory, rel: '../escape.jsonl' }), /only be restored/);
  await assert.rejects(storage.restoreVersion(e.store, sha256, { directory: e.b.directory, rel: '.credentials.json' }), /only be restored/);
  // No temp files are left behind.
  assert.deepEqual((await fs.readdir(path.dirname(target))).filter(n => /\.tmp-/.test(n)), []);
  // Show Backup: a manifest's kept versions are exported under exports/<id>.
  const manifest = { id: storage.newManifestId(), kind: 'transfer', state: 'committed', pinned: true, created: new Date().toISOString(), objects: [{ name: path.join('projects', 'proj', `${S2}.jsonl`), sha256, size: version.length, reason: 'diverged' }] };
  await storage.writeManifest(e.store, manifest);
  const exported = await storage.exportManifest(e.store, storage.manifestPath(e.store, manifest.id));
  assert.equal(exported.files.length, 1);
  assert.ok((await fs.readFile(exported.files[0].target)).equals(version));
  assert.ok(exported.files[0].target.startsWith(path.join(e.store, 'exports', manifest.id)));
});

// ---- C1-C3 and A5: capture and retention -----------------------------------

test('capture only reads working copies, captures linked names once, and supersedes a partial last line', async t => {
  const e = await env(t);
  archive.limits.minDelta = 1;
  t.after(() => { archive.limits.minDelta = 4; });
  const partial = line(S3, 'complete') + '{"type":"user","mess';
  await write(e.proj(e.a, `${S3}.jsonl`), partial);
  // A second name for the same file (hard link) and a transfer leftover.
  await fs.link(e.proj(e.b, `${S2}.jsonl`), e.proj(e.b, `${S2}-copy.jsonl`));
  await write(e.proj(e.a, `${S1}.jsonl.tmp-${UUID}`), 'staged');
  const before = { a: await fingerprint(e.a.directory), b: await fingerprint(e.b.directory) };
  const result = await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b], batchFiles: 2 });
  // Read-only towards working copies: same content, mtime and identity, nothing added.
  assert.deepEqual(await fingerprint(e.a.directory), before.a);
  assert.deepEqual(await fingerprint(e.b.directory), before.b);
  assert.equal(result.complete, true);
  assert.ok(result.batches >= 3);
  // The linked pair is one file identity: captured once.
  assert.equal(result.scanned, 5);
  const catalog = await storage.archiveOf(e.store).readCatalog();
  assert.equal(Object.keys(catalog.keys).some(k => /tmp-/.test(k)), false);
  assert.equal(await storage.objectValid(e.store, sha(Buffer.from(partial))), true);
  // Nothing changed: nothing captured again.
  assert.equal((await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b] })).changed, 0);
  // The writer completes the line and appends: the partial version is superseded.
  const complete = line(S3, 'complete') + line(S3, 'finished');
  await fs.writeFile(e.proj(e.a, `${S3}.jsonl`), partial + '"x"}\n');
  await fs.appendFile(e.proj(e.a, `${S3}.jsonl`), complete);
  const now = Date.now();
  await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b], now: () => now + 1000 });
  const key = (process.platform === 'win32' ? `projects/proj/${S3}.jsonl`.toLowerCase() : `projects/proj/${S3}.jsonl`);
  const list = (await storage.archiveOf(e.store).readCatalog()).keys[key];
  assert.equal(list.length, 2);
  assert.equal(list[0].supersededBy, list[1].sha256);
  const newest = await fs.readFile(e.proj(e.a, `${S3}.jsonl`));
  assert.equal((await storage.archiveOf(e.store).readRecipe(sha(newest))).base, sha(Buffer.from(partial)));
});

test('retention keeps the newest and every diverged version after the sweep and drops old prefixes', async t => {
  const e = await env(t);
  const file = e.proj(e.b, `${S1}.jsonl`);
  const t0 = Date.now() - 60 * DAY;
  const cap = at => storage.capture({ switcherRoot: e.store, profiles: [e.b], now: () => at });
  const v1 = await fs.readFile(file);
  await cap(t0);
  await fs.appendFile(file, line(S1, 'three'));
  const v2 = await fs.readFile(file);
  await cap(t0 + DAY);
  // A rewrite (not an append): a diverged version.
  await fs.writeFile(file, line(S1, 'rewritten history'));
  const v3 = await fs.readFile(file);
  await cap(t0 + 2 * DAY);
  await fs.writeFile(file, line(S1, 'rewritten history') + line(S1, 'continued'));
  const v4 = await fs.readFile(file);
  await cap(t0 + 3 * DAY);
  // Claude's sweep deletes the working copy.
  await fs.unlink(file);
  const result = await storage.gc(e.store, { retentionDays: 30 });
  // v1 is a prefix of v2 and old: dropped. v3 is a prefix of v4 and old: dropped.
  assert.deepEqual(result.expiredVersions.map(x => x.sha256).sort(), [sha(v1), sha(v3)].sort());
  // v2 diverged from the newest (v4): kept, pinned. v4 is the newest: kept.
  for (const v of [v2, v4]) assert.ok((await storage.readObject(e.store, sha(v))).equals(v));
  const stored = await storage.storedObjects(e.store);
  assert.ok(stored.includes(sha(v2)) && stored.includes(sha(v4)));
  assert.ok(!stored.includes(sha(v1)) && !stored.includes(sha(v3)));
  // Within retention, prefixes are kept.
  const recent = await env(t);
  const rf = recent.proj(recent.b, `${S1}.jsonl`);
  await storage.capture({ switcherRoot: recent.store, profiles: [recent.b] });
  const r1 = await fs.readFile(rf);
  await fs.appendFile(rf, line(S1, 'more'));
  await storage.capture({ switcherRoot: recent.store, profiles: [recent.b] });
  assert.deepEqual((await storage.gc(recent.store, { retentionDays: 30 })).expiredVersions, []);
  assert.equal(await storage.objectValid(recent.store, sha(r1)), true);
  // A version a pinned manifest lists survives even after its catalog entry expires.
  const versions = await storage.archivedVersions(e.store);
  assert.ok(versions.some(g => g.versions.some(v => v.sha256 === sha(v4) && v.captured)));
  // The user can discard a captured version (confirmation required).
  await assert.rejects(storage.discardVersions(e.store, [{ key: versions[0].key, sha256: sha(v2) }]), /confirmation/);
});

test('capture stops when another window holds the lock and continues on the next run', async t => {
  const e = await env(t);
  const release = await storage.acquireStoreLock(e.store, 'transfer elsewhere', { wait: 0 });
  const busy = await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b], lock: { wait: 0 } });
  assert.deepEqual([busy.busy, busy.captured], [true, 0]);
  await release();
  const done = await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b], lock: { wait: 0 } });
  assert.equal(done.complete, true);
  assert.equal(done.captured, done.changed);
});

// ---- Accounting ---------------------------------------------------------

test('accounting counts each file identity once and marks names outside the scanned folders', async t => {
  const e = await env(t);
  const file = e.proj(e.b, `${S2}.jsonl`), size = (await fs.stat(file)).size;
  const before = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b], processes: false });
  await fs.link(file, e.proj(e.a, `${S2}.jsonl`));
  await fs.link(file, path.join(e.root, 'outside-name.jsonl'));
  const after = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b], processes: false });
  assert.equal(after.metrics.profile, before.metrics.profile);
  assert.equal(after.metrics.duplicate, before.metrics.duplicate);
  assert.equal(after.metrics.externalNames.length, 1);
  const measured = await storage.measure({ switcherRoot: e.store, profiles: [e.a, e.b] });
  assert.equal(measured.profile, before.metrics.profile);
  // The archive counts packs, index and recipes.
  await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b] });
  const withArchive = await storage.measure({ switcherRoot: e.store, profiles: [e.a, e.b] });
  assert.ok(withArchive.archive > 0);
  assert.equal(withArchive.archive, await storage.archiveOf(e.store).bytes());
  assert.equal(withArchive.backup, withArchive.archive);
  assert.ok(size > 0);
});

// ---- N6: batched cleanup ------------------------------------------------------

async function legacySnapshot(profile, name, state, files) {
  const dir = path.join(profile.directory, '.profile-switch-backups', name);
  for (const [rel, data] of Object.entries(files)) await write(path.join(dir, rel), data);
  if (state) await write(path.join(dir, 'manifest.json'), JSON.stringify({ state }));
  return dir;
}
test('cleanup works in batches, releases the lock between them, and a transfer runs in between', async t => {
  const e = await env(t);
  const snaps = [];
  for (let i = 0; i < 3; i++) snaps.push(await legacySnapshot(e.a, `${i}-snap`, 'committed', { [`previous/projects/proj/${S3}.jsonl`]: line(S3, `unique ${i}`), [`incoming/projects/proj/${S1}.jsonl`]: line(S1, 'one') }));
  const destination = path.join(e.root, 'default-like');
  await write(path.join(destination, 'projects', 'proj', `${S1}.jsonl`), line(S1, 'destination branch'));
  const seen = [];
  const progress = [];
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true, requireCapture: false, onProgress: p => progress.push(p), between: async () => {
    // The lock is free between batches: a transfer that writes a backup completes.
    seen.push(await storage.readStoreLock(e.store));
    if (seen.length === 1) {
      const copied = await transferSession(e.b.directory, destination, { id: S1, project: 'proj' }, { switcherRoot: e.store });
      assert.ok(copied.backup);
    }
  } });
  assert.equal(result.batches, 3);
  assert.deepEqual(seen, [null, null, null]);
  assert.deepEqual(progress.map(p => p.done), [2, 4, 6]);
  for (const s of snaps) assert.equal(await exists(s), false);
  assert.equal(result.manifests.length, 3);
  for (let i = 0; i < 3; i++) assert.ok((await storage.storedObjects(e.store)).includes(sha(Buffer.from(line(S3, `unique ${i}`)))));
  // The transfer's own backup of the destination branch is intact.
  assert.ok((await storage.storedObjects(e.store)).includes(sha(Buffer.from(line(S1, 'destination branch')))));
});

test('cancelling cleanup stops between batches and keeps the rest', async t => {
  const e = await env(t);
  const snaps = [];
  for (let i = 0; i < 3; i++) snaps.push(await legacySnapshot(e.a, `${i}-snap`, 'committed', { [`previous/projects/proj/${S3}.jsonl`]: line(S3, `unique ${i}`) }));
  const controller = new AbortController();
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false, signal: controller.signal, between: async () => controller.abort() });
  assert.deepEqual([result.cancelled, result.batches, result.deleted], [true, 1, 1]);
  assert.equal(await exists(snaps[0]), false);
  assert.equal(await exists(snaps[1]), true);
  assert.equal(await exists(snaps[2]), true);
});

// ---- N7: snapshots without a manifest ---------------------------------------

test('a snapshot without a manifest is removed only after its own confirmation and once every file rebuilds', async t => {
  const e = await env(t, { deep: true });
  const files = { [`stage/projects/proj/${S3}.jsonl`]: line(S3, 'only in a manifest-less snapshot'), 'previous/file-history/x/snap': 'checkpoint v0' };
  const snap = await legacySnapshot(e.a, '9-no-manifest', null, files);
  assert.ok(Object.keys(files).every(rel => path.join(snap, rel).length > 260));
  const plan = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], dryRun: true });
  assert.deepEqual(plan.manifestless.map(m => [m.path, m.files]), [[snap, 2]]);
  assert.match(storage.renderCleanupPlan(plan), /Snapshots without a manifest/);
  // Without its own confirmation it stays.
  await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false });
  assert.equal(await exists(snap), true);
  // If a file does not rebuild from the archive, nothing is deleted.
  const a = storage.archiveOf(e.store);
  t.mock.method(a, 'verify', async () => false);
  const refused = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false, snapshots: [snap] });
  t.mock.restoreAll();
  assert.equal(refused.snapshots[0].removed, false);
  for (const [rel, data] of Object.entries(files)) assert.equal(await fs.readFile(path.join(snap, rel), 'utf8'), data);
  // Confirmed and rebuildable: archived under a pinned manifest, then removed.
  const result = await storage.cleanup({ switcherRoot: e.store, profiles: [e.a], confirm: true, requireCapture: false, snapshots: [snap] });
  assert.equal(result.snapshots[0].removed, true);
  assert.equal(await exists(snap), false);
  const pinned = (await storage.readManifests(e.store)).manifests.filter(m => m.pinned && m.objects.some(o => o.reason === 'snapshot without a manifest'));
  assert.ok(pinned.length);
  for (const data of Object.values(files)) assert.equal((await storage.readObject(e.store, sha(Buffer.from(data)))).toString(), data);
});

// ---- N5: leftover transfer entries -----------------------------------------

test('leftover .tmp- and .old- entries are archived if unique, then removed; recent or locked ones stay', async t => {
  const e = await env(t, { deep: true });
  const old = new Date(Date.now() - 3 * DAY);
  const aside = e.proj(e.a, `${S2}.jsonl.old-${UUID}`);
  const staged = path.join(e.b.directory, 'file-history', `${S1}.tmp-${UUID.replace('0f', '1f')}`);
  const recent = e.proj(e.a, `${S1}.jsonl.tmp-${UUID.replace('0f', '2f')}`);
  const lockedLeftover = e.proj(e.b, `${S2}.jsonl.old-${UUID.replace('0f', '3f')}`);
  await write(aside, line(S2, 'unique aside'));
  await write(path.join(staged, 'snap'), 'checkpoint');
  await write(recent, line(S1, 'one'));
  assert.ok(aside.length > 260);
  for (const f of [aside, path.join(staged, 'snap'), staged]) await fs.utimes(f, old, old);
  const plan = await storage.cleanLeftovers({ switcherRoot: e.store, profiles: [e.a, e.b], dryRun: true });
  assert.deepEqual(plan.leftovers.map(x => x.path).sort(), [aside, staged].sort());
  assert.match(storage.renderLeftovers(plan), /Leftover transfer files/);
  await assert.rejects(storage.cleanLeftovers({ switcherRoot: e.store, profiles: [e.a, e.b] }), /confirmation/);
  // A profile with a .profile-switch-lock is skipped entirely.
  await write(lockedLeftover, 'kept');
  await fs.utimes(lockedLeftover, old, old);
  await fs.mkdir(path.join(e.b.directory, '.profile-switch-lock'));
  const lockedPlan = await storage.cleanLeftovers({ switcherRoot: e.store, profiles: [e.a, e.b], dryRun: true });
  assert.deepEqual(lockedPlan.leftovers.map(x => x.path), [aside]);
  await fs.rmdir(path.join(e.b.directory, '.profile-switch-lock'));
  await fs.unlink(lockedLeftover);
  const result = await storage.cleanLeftovers({ switcherRoot: e.store, profiles: [e.a, e.b], confirm: true });
  assert.equal(result.removed, 2);
  assert.equal(await exists(aside), false);
  assert.equal(await exists(staged), false);
  assert.equal(await exists(recent), true);
  // The unique aside content went into the archive under a pinned manifest first;
  // the staged checkpoint was covered by A's live copy and needed no backup.
  const manifests = (await storage.readManifests(e.store)).manifests.filter(m => m.kind === 'maintenance');
  assert.deepEqual(manifests.flatMap(m => m.objects.map(o => o.sha256)), [sha(Buffer.from(line(S2, 'unique aside')))]);
  assert.equal((await storage.readObject(e.store, sha(Buffer.from(line(S2, 'unique aside'))))).toString(), line(S2, 'unique aside'));
  // Live history is untouched.
  assert.equal(await fs.readFile(e.proj(e.b, `${S2}.jsonl`), 'utf8'), line(S2, 'b only'));
});

test('a pending transfer recovery skips that profile for leftovers', async t => {
  const e = await env(t);
  const old = new Date(Date.now() - 3 * DAY);
  const aside = e.proj(e.b, `${S2}.jsonl.old-${UUID}`);
  await write(aside, 'kept');
  await fs.utimes(aside, old, old);
  await storage.recordRecovery(e.store, { destination: e.b.directory, error: 'test' });
  const plan = await storage.cleanLeftovers({ switcherRoot: e.store, profiles: [e.a, e.b], dryRun: true });
  assert.deepEqual(plan.leftovers, []);
  assert.ok(plan.skipped.some(s => s.path === e.b.directory));
});

// ---- Long paths for the new code ----------------------------------------------

test('long paths: capture, putObjectFile, GC, compaction and verify work past 260 characters', async t => {
  const e = await env(t, { deep: true });
  const file = e.proj(e.b, `${S1}.jsonl`);
  assert.ok(file.length > 260);
  const before = await fingerprint(e.b.directory);
  const result = await storage.capture({ switcherRoot: e.store, profiles: [e.a, e.b] });
  assert.equal(result.complete, true);
  assert.deepEqual(await fingerprint(e.b.directory), before);
  const data = await fs.readFile(file);
  assert.equal(await storage.objectValid(e.store, sha(data), data.length), true);
  await storage.putObjectFile(e.store, e.proj(e.b, `${S2}.jsonl`), sha(await fs.readFile(e.proj(e.b, `${S2}.jsonl`))), e.b.directory);
  await storage.gc(e.store, { retentionDays: 30, compact: true });
  const verified = await storage.verify({ switcherRoot: e.store, profiles: [e.a, e.b], full: true });
  assert.deepEqual(verified.problems, []);
  assert.ok(verified.notes.some(n => /Archive: /.test(n)));
});

test('pack ids are never reused, and cached blocks are dropped when the packs change', async t => {
  const e = await env(t);
  const a = opened(e);
  const v1 = Buffer.from(line(S1, 'first pack'));
  await storage.putObject(e.store, v1);
  assert.deepEqual((await a.packList()).map(p => p.id), [1]);
  // Nothing references v1 any more: GC drops its recipe, compaction its pack.
  await storage.gc(e.store, { retentionDays: 30 });
  await storage.compactArchive(e.store, { confirm: true, minDeadRatio: 0 });
  assert.deepEqual((await a.packList()).map(p => p.id), []);
  const v2 = Buffer.from(line(S2, 'second pack'));
  await storage.putObject(e.store, v2);
  // A new pack gets a new id, even though pack 1 no longer exists.
  assert.deepEqual((await a.packList()).map(p => p.id), [2]);
  assert.equal(JSON.parse(await fs.readFile(path.join(e.archiveDir, 'meta.json'), 'utf8')).nextPack, 3);
  assert.ok((await a.read(sha(v2))).equals(v2));
  assert.ok(a.blocks.size > 0);
  // Another writer changes the pack: the next index load drops cached blocks.
  await fs.appendFile((await a.packList())[0].file, Buffer.alloc(3));
  await a.loadIndex();
  assert.equal(a.blocks.size, 0);
  assert.ok((await a.read(sha(v2))).equals(v2));
});

test('retention keeps an old prefix when the version that supersedes it does not rebuild', async t => {
  const e = await env(t);
  const file = e.proj(e.b, `${S1}.jsonl`);
  const t0 = Date.now() - 60 * DAY;
  const v1 = await fs.readFile(file);
  await storage.capture({ switcherRoot: e.store, profiles: [e.b], now: () => t0 });
  await fs.appendFile(file, line(S1, 'three'));
  const v2 = await fs.readFile(file);
  await storage.capture({ switcherRoot: e.store, profiles: [e.b], now: () => t0 + DAY });
  // The superseding version is damaged: its recipe is gone.
  await fs.unlink(storage.archiveOf(e.store).recipePath(sha(v2)));
  const result = await storage.gc(e.store, { retentionDays: 30 });
  assert.deepEqual(result.expiredVersions, []);
  assert.ok((await storage.readObject(e.store, sha(v1))).equals(v1));
});

// ---- Security recommendations (1b) ------------------------------------------

test('Rec 2: tampered block lengths are refused without allocating them, and inflate is bounded by the entry lengths', async t => {
  const zlib = require('node:zlib');
  const e = await env(t);
  const a = opened(e);
  const v = Buffer.from(line(S1, 'bounded'));
  await storage.putObject(e.store, v);
  // The index claims a 2 GB block: refused before any allocation of that size.
  const indexFile = path.join(e.archiveDir, 'index.bin');
  const good = await fs.readFile(indexFile), bad = Buffer.from(good);
  for (let pos = 8; pos + 58 <= bad.length; pos += 58) { bad.writeUInt32LE(0x7fffffff, pos + 42); bad.writeUInt32LE(archive.crc32(bad.subarray(pos, pos + 54)), pos + 54); }
  await fs.writeFile(indexFile, bad);
  a.forget();
  const alloc = t.mock.method(Buffer, 'alloc');
  assert.equal(await storage.objectValid(e.store, sha(v), v.length), false);
  assert.ok(alloc.mock.calls.every(c => c.arguments[0] < 16 * 1024 * 1024), 'no large allocation');
  t.mock.restoreAll();
  await fs.writeFile(indexFile, good);
  a.forget();
  assert.equal(await storage.objectValid(e.store, sha(v), v.length), true);
  // A block header claiming a huge stored length ends the scan as a torn tail.
  const [pack] = await a.packList();
  const header = Buffer.alloc(20);
  Buffer.from('CPB1').copy(header);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(0x7ffffff0, 12);
  await fs.appendFile(pack.file, header);
  const scanAlloc = t.mock.method(Buffer, 'alloc');
  await a.rebuildIndex();
  assert.ok(scanAlloc.mock.calls.every(c => c.arguments[0] < 16 * 1024 * 1024), 'no large allocation while scanning');
  t.mock.restoreAll();
  assert.equal(await storage.objectValid(e.store, sha(v), v.length), true);
  // A valid-CRC block whose data inflates far beyond its entry lengths is refused.
  const stored = zlib.deflateRawSync(Buffer.alloc(20 * 1024 * 1024));
  const bomb = Buffer.alloc(20 + 36);
  Buffer.from('CPB1').copy(bomb);
  bomb[4] = 1;
  bomb.writeUInt32LE(1, 8);
  bomb.writeUInt32LE(stored.length, 12);
  const fake = 'ab'.repeat(32);
  Buffer.from(fake, 'hex').copy(bomb, 20);
  bomb.writeUInt32LE(10, 20 + 32);
  bomb.writeUInt32LE(archive.crc32(stored, archive.crc32(bomb.subarray(20), archive.crc32(bomb.subarray(0, 16)))), 16);
  await fs.writeFile(path.join(e.archiveDir, 'packs', '00000099.pack'), Buffer.concat([Buffer.from('CPSPACK1'), bomb, stored]));
  a.forget();
  await assert.rejects(a.readChunk(fake), /Damaged archive block/);
});

test('Rec 3: a tampered compaction journal cannot delete live packs', async t => {
  const e = await env(t);
  const a = opened(e);
  const v = Buffer.from(line(S1, 'live pack'));
  await storage.putObject(e.store, v);
  await storage.writeManifest(e.store, { id: storage.newManifestId(), kind: 'cleanup', state: 'committed', pinned: true, created: new Date().toISOString(), objects: [{ name: 'x', sha256: sha(v), size: v.length }] });
  const journalFile = path.join(e.archiveDir, 'compact.json');
  const tampered = [
    { state: 'running', step: 'switched', old: [1], new: [], nextPack: 2 },
    { state: 'running', step: 'writing', old: [1], new: [1], nextPack: 0 },
    { state: 'running', step: 'writing', old: [1], new: [1] },
    { state: 'running', step: 'switched', old: [1], new: [5], nextPack: 5 }
  ];
  for (const journal of tampered) {
    await fs.writeFile(journalFile, JSON.stringify(journal));
    await storage.gc(e.store, { retentionDays: 30 });
    assert.deepEqual((await a.packList()).map(p => p.id), [1], JSON.stringify(journal));
    assert.equal(await storage.objectValid(e.store, sha(v), v.length), true);
    assert.equal(await exists(journalFile), false);
  }
});

test('Rec 4: export and restore never overwrite a target that appears at the last moment', async t => {
  const e = await env(t);
  const v = Buffer.from(line(S2, 'export me'));
  const { sha256 } = await storage.putObject(e.store, v);
  const target = path.join(e.root, 'out', 'x.jsonl');
  const link = fs.link, copy = fs.copyFile;
  // A writer creates the target just before the final step (link).
  t.mock.method(fs, 'link', async (from, to) => { if (to === target) await fs.writeFile(target, 'written at the last moment'); return link(from, to); });
  await assert.rejects(storage.exportVersion(e.store, sha256, target), /appeared while exporting/);
  t.mock.restoreAll();
  assert.equal(await fs.readFile(target, 'utf8'), 'written at the last moment');
  assert.deepEqual((await fs.readdir(path.dirname(target))).filter(n => /\.tmp-/.test(n)), []);
  // Where links are not available, the exclusive copy refuses the same way.
  await fs.unlink(target);
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); });
  t.mock.method(fs, 'copyFile', async (from, to, mode) => { if (to === target) await fs.writeFile(target, 'late again'); return copy(from, to, mode); });
  await assert.rejects(storage.exportVersion(e.store, sha256, target), /appeared while exporting/);
  t.mock.restoreAll();
  assert.equal(await fs.readFile(target, 'utf8'), 'late again');
  // Without interference: written, verified, a single name.
  await fs.unlink(target);
  assert.equal((await storage.exportVersion(e.store, sha256, target)).written, true);
  assert.ok((await fs.readFile(target)).equals(v));
  assert.equal((await fs.lstat(target)).nlink, 1);
  // Restore into a profile: the same rule.
  await fs.unlink(e.proj(e.b, `${S2}.jsonl`));
  t.mock.method(fs, 'link', async (from, to) => { if (to === e.proj(e.b, `${S2}.jsonl`)) await fs.writeFile(to, 'Claude wrote first'); return link(from, to); });
  await assert.rejects(storage.restoreVersion(e.store, sha256, { directory: e.b.directory, rel: `projects/proj/${S2}.jsonl` }), /appeared while exporting/);
  t.mock.restoreAll();
  assert.equal(await fs.readFile(e.proj(e.b, `${S2}.jsonl`), 'utf8'), 'Claude wrote first');
});

test('Rec 1: Analyze lists managed and project cleanupPeriodDays and states that the archive keeps the newest version', async t => {
  const e = await env(t);
  const managed = path.join(e.root, 'policy', 'managed-settings.json');
  const project = path.join(e.root, 'some-project');
  await write(managed, JSON.stringify({ cleanupPeriodDays: 7 }));
  await write(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ cleanupPeriodDays: 3 }));
  const analysis = await storage.analyze({ switcherRoot: e.store, profiles: [e.a, e.b], processes: false, cleanupSources: { managed: [managed, path.join(e.root, 'missing.json')], projects: [project] } });
  assert.deepEqual(analysis.cleanupOverrides.map(o => [o.kind, o.days]), [['managed', 7], ['project', 3]]);
  const report = storage.renderReport(analysis);
  assert.ok(report.includes(`Managed (organisation) setting ${managed}: 7 days`));
  assert.ok(report.includes(`Project setting ${path.join(project, '.claude', 'settings.local.json')}: 3 days`));
  assert.match(report, /The archive keeps the newest version of every conversation \(Default included\)/);
  // Without sources nothing outside the profiles is read.
  assert.deepEqual((await storage.analyze({ switcherRoot: e.store, profiles: [e.a], processes: false })).cleanupOverrides, []);
});
