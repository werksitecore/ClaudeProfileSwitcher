'use strict';
// The compressed, content-addressed archive of file versions (decision 12,
// constraints A1-A6). It replaces the whole-file objects in backups/objects.
//
// Layout under <switcherRoot>/backups/archive:
//   packs/<8 digits>.pack    append-only blocks of chunks. Only the newest pack
//                            is appended to; sealed packs are never rewritten.
//   index.bin                chunk hash -> pack, block, offset. Append-only
//                            records with a CRC each; rebuildable from the packs.
//   recipes/<aa>/<sha>.json  one version: its ordered chunk hashes (optionally
//                            the first `take` chunks of a base recipe), its size
//                            and whole-file SHA-256.
//   catalog.json             versions captured from working copies (A5).
//   capture-index.json       dev:ino -> size, mtime, last version (C1).
//   compact.json             compaction journal.
//
// A chunk is one JSONL line, byte-exact with its terminator (none on a
// truncated last line), or a whole non-JSONL file. Write order (A3): pack,
// flush, index, flush, recipe, flush; the caller then writes the manifest.
// Every write runs the caller's assertPlainPath first; the caller holds the
// store lock for every write.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const deflateRaw = promisify(zlib.deflateRaw), inflateRaw = promisify(zlib.inflateRaw);
const SHA = /^[a-f0-9]{64}$/;
const PACK_NAME = /^([0-9]{8})\.pack$/;
const TEMP = /\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PACK_MAGIC = Buffer.from('CPSPACK1', 'latin1');
const BLOCK_MAGIC = Buffer.from('CPB1', 'latin1');
const INDEX_MAGIC = Buffer.from('CPSIDX1\n', 'latin1');
// Block: magic(4) flags(1) reserved(3) count(4) storedLength(4) crc(4), then
// count x (hash(32) rawLength(4)), then the stored (deflated or raw) data.
const BLOCK_HEADER = 20, ENTRY = 36;
// Index record: hash(32) pack(4) block(6) blockLength(4) inner(4) length(4) crc(4).
const RECORD = 58;
// Tunable for tests; blocks are compressed per 64 KB to 1 MB (A1).
// maxBlock bounds every block length read from disk (header or index): one
// block holds at most a ~256 KB group of lines or one whole-file chunk, and a
// history file is at most 512 MB, plus headroom for the table and header.
const limits = { packBytes: 128 * 1024 * 1024, blockBytes: 256 * 1024, chainDepth: 32, minDelta: 4, blockCache: 16, maxBlock: 513 * 1024 * 1024 };
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();
function crc32(buf, previous = 0) {
  let crc = ~previous;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (~crc) >>> 0;
}

// Byte-exact lines: each chunk keeps its terminator (\n or \r\n); a last line
// without one is its own chunk.
function splitLines(data) {
  const out = [];
  for (let start = 0; start < data.length;) {
    const newline = data.indexOf(10, start), end = newline < 0 ? data.length : newline + 1;
    out.push(data.subarray(start, end));
    start = end;
  }
  return out;
}
// JSONL is split into lines; other files are one whole-file chunk. Without a
// name (putObject), content that starts with '{' is treated as JSONL. Either
// way the version rebuilds byte-exact; the mode only affects deduplication.
function modeFor(name, data) {
  if (name) return /\.jsonl$/i.test(name) ? 'lines' : 'whole';
  return data.length && data[0] === 0x7b ? 'lines' : 'whole';
}
const chunksOf = (data, mode) => mode === 'lines' ? splitLines(data) : data.length ? [data] : [];

async function encodeBlock(chunks) {
  const raw = Buffer.concat(chunks.map(c => c.data));
  let stored = raw, flags = 0;
  if (raw.length) {
    // Images and other incompressible data are stored raw (A2).
    const packed = await deflateRaw(raw, { level: 6 });
    if (packed.length < raw.length) { stored = packed; flags = 1; }
  }
  const header = Buffer.alloc(BLOCK_HEADER), table = Buffer.alloc(ENTRY * chunks.length);
  BLOCK_MAGIC.copy(header, 0);
  header[4] = flags;
  header.writeUInt32LE(chunks.length, 8);
  header.writeUInt32LE(stored.length, 12);
  let inner = 0;
  const entries = chunks.map((c, i) => {
    Buffer.from(c.hash, 'hex').copy(table, i * ENTRY);
    table.writeUInt32LE(c.data.length, i * ENTRY + 32);
    const entry = { hash: c.hash, inner, len: c.data.length };
    inner += c.data.length;
    return entry;
  });
  header.writeUInt32LE(crc32(stored, crc32(table, crc32(header.subarray(0, 16)))), 16);
  return { bytes: Buffer.concat([header, table, stored]), entries };
}
function parseHeader(h) {
  if (h.length < BLOCK_HEADER || !h.subarray(0, 4).equals(BLOCK_MAGIC) || h[4] > 1) return null;
  const count = h.readUInt32LE(8), storedLength = h.readUInt32LE(12);
  return { flags: h[4], count, storedLength, crc: h.readUInt32LE(16), length: BLOCK_HEADER + count * ENTRY + storedLength };
}
const blockCrcOk = (buf, header) => crc32(buf.subarray(BLOCK_HEADER), crc32(buf.subarray(0, 16))) === header.crc;
function blockEntries(buf, header) {
  const entries = [];
  let inner = 0;
  for (let i = 0; i < header.count; i++) {
    const at = BLOCK_HEADER + i * ENTRY, len = buf.readUInt32LE(at + 32);
    entries.push({ hash: buf.toString('hex', at, at + 32), inner, len });
    inner += len;
  }
  return entries;
}
function encodeRecord(hash, e) {
  const b = Buffer.alloc(RECORD);
  Buffer.from(hash, 'hex').copy(b, 0);
  b.writeUInt32LE(e.pack, 32);
  b.writeUIntLE(e.block, 36, 6);
  b.writeUInt32LE(e.blockLength, 42);
  b.writeUInt32LE(e.inner, 46);
  b.writeUInt32LE(e.len, 50);
  b.writeUInt32LE(crc32(b.subarray(0, 54)), 54);
  return b;
}
const indexBytes = entries => Buffer.concat([INDEX_MAGIC, ...entries.map(([hash, e]) => encodeRecord(hash, e))]);
async function lstatOrNull(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } }

// Reads the blocks of one pack from `from`. Stops at the first block whose
// header, length or CRC does not check out: a torn tail is ignored (A3).
async function scanPack(file, from, size, onBlock) {
  const handle = await fs.open(file, 'r');
  try {
    let pos = from;
    if (pos < PACK_MAGIC.length) {
      const magic = Buffer.alloc(PACK_MAGIC.length);
      const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
      if (bytesRead < magic.length || !magic.equals(PACK_MAGIC)) return { end: 0, torn: size > 0 };
      pos = PACK_MAGIC.length;
    }
    while (pos + BLOCK_HEADER <= size) {
      const head = Buffer.alloc(BLOCK_HEADER);
      await handle.read(head, 0, BLOCK_HEADER, pos);
      const header = parseHeader(head);
      // A length beyond the file or the cap is a torn or tampered block: never allocate it.
      if (!header || header.length > limits.maxBlock || pos + header.length > size) break;
      const buf = Buffer.alloc(header.length);
      await handle.read(buf, 0, header.length, pos);
      if (!blockCrcOk(buf, header)) break;
      await onBlock(pos, header.length, blockEntries(buf, header), buf, header);
      pos += header.length;
    }
    return { end: pos, torn: pos < size };
  } finally { await handle.close(); }
}

// Parsed index per archive folder, reused while the index and the packs are
// unchanged on disk.
const indexCache = new Map();

class Archive {
  constructor(dir, { root, assertPlainPath, renameReplacing }) {
    this.dir = path.resolve(dir);
    this.root = root;
    this.assertPlainPath = assertPlainPath;
    this.renameReplacing = renameReplacing || ((from, to) => fs.rename(from, to));
    this.packs = path.join(this.dir, 'packs');
    this.recipes = path.join(this.dir, 'recipes');
    this.tmp = path.join(this.dir, 'tmp');
    this.index = path.join(this.dir, 'index.bin');
    this.catalogFile = path.join(this.dir, 'catalog.json');
    this.captureFile = path.join(this.dir, 'capture-index.json');
    this.compactJournal = path.join(this.dir, 'compact.json');
    this.metaFile = path.join(this.dir, 'meta.json');
    this.blocks = new Map();
  }
  async plain(file, allowMissing = true) { await this.assertPlainPath(this.root, file, { allowMissing }); }
  async assertFolders() { for (const dir of [this.dir, this.packs, this.recipes, this.tmp]) await this.plain(dir); }
  async ensureDir(dir) { await this.plain(dir); await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await this.plain(dir, false); }
  async exists() { return !!(await lstatOrNull(this.dir)); }
  packFile(id) { return path.join(this.packs, `${String(id).padStart(8, '0')}.pack`); }
  recipePath(sha) { if (!SHA.test(String(sha))) throw new Error('Invalid version hash'); return path.join(this.recipes, sha.slice(0, 2), `${sha}.json`); }
  tempPath() { return path.join(this.tmp, `put.tmp-${crypto.randomUUID()}`); }
  // Writes a file durably: temp file, flush, rename.
  async writeDurable(file, data) {
    await this.ensureDir(path.dirname(file));
    const temp = `${file}.tmp-${crypto.randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.renameReplacing(temp, file);
    } catch (e) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      throw e;
    }
  }
  async readJson(file) {
    await this.plain(file);
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`${path.basename(file)} in the archive is unreadable (${e.message})`); }
  }

  // ---- Index ---------------------------------------------------------------

  async packList() {
    await this.plain(this.packs);
    let names;
    try { names = await fs.readdir(this.packs); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const name of names) {
      const m = name.match(PACK_NAME);
      if (!m) continue;
      const file = path.join(this.packs, name), stat = await lstatOrNull(file);
      if (stat?.isFile()) out.push({ id: Number(m[1]), file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    return out.sort((a, b) => a.id - b.id);
  }
  // Loads the index. Entries in missing packs are dropped; blocks beyond the
  // indexed end of a pack (written before a crash, never indexed) are
  // recovered by scanning, and a torn tail marks the pack as not appendable.
  async loadIndex() {
    await this.assertFolders();
    await this.plain(this.index);
    const packs = await this.packList();
    const istat = await lstatOrNull(this.index);
    const stamp = JSON.stringify([istat ? [istat.size, istat.mtimeMs, String(istat.ino)] : null, packs.map(p => [p.id, p.size, p.mtimeMs])]);
    const cached = indexCache.get(this.dir);
    if (cached && cached.stamp === stamp) return cached.state;
    // The packs or the index changed on disk: cached blocks may be stale.
    this.blocks.clear();
    const state = { chunks: new Map(), packs: new Map(), recovered: [], indexValid: 0 };
    if (istat?.isFile()) {
      const buf = await fs.readFile(this.index);
      if (buf.length >= INDEX_MAGIC.length && buf.subarray(0, INDEX_MAGIC.length).equals(INDEX_MAGIC)) {
        let pos = INDEX_MAGIC.length;
        for (; pos + RECORD <= buf.length; pos += RECORD) {
          const r = buf.subarray(pos, pos + RECORD);
          if (crc32(r.subarray(0, 54)) !== r.readUInt32LE(54)) break;
          state.chunks.set(r.toString('hex', 0, 32), { pack: r.readUInt32LE(32), block: r.readUIntLE(36, 6), blockLength: r.readUInt32LE(42), inner: r.readUInt32LE(46), len: r.readUInt32LE(50) });
        }
        state.indexValid = pos;
      }
      state.indexSize = buf.length;
    }
    const ids = new Set(packs.map(p => p.id)), ends = new Map();
    for (const [hash, e] of state.chunks) {
      if (!ids.has(e.pack)) { state.chunks.delete(hash); continue; }
      ends.set(e.pack, Math.max(ends.get(e.pack) || 0, e.block + e.blockLength));
    }
    for (const p of packs) {
      const info = { id: p.id, file: p.file, size: p.size, end: ends.get(p.id) || 0, torn: false };
      if (p.size > Math.max(info.end, PACK_MAGIC.length) || !info.end) {
        const scan = await scanPack(p.file, info.end, p.size, async (block, blockLength, entries) => {
          for (const x of entries) if (!state.chunks.has(x.hash)) {
            const e = { pack: p.id, block, blockLength, inner: x.inner, len: x.len };
            state.chunks.set(x.hash, e);
            state.recovered.push([x.hash, e]);
          }
        });
        info.end = scan.end;
        info.torn = scan.torn;
      }
      state.packs.set(p.id, info);
    }
    indexCache.set(this.dir, { stamp, state });
    return state;
  }
  forget() { indexCache.delete(this.dir); this.blocks.clear(); }
  // The block cache lives for one run or batch: cleared when a run starts
  // (store lock taken, verify, compaction) and whenever the packs change.
  startRun() { this.blocks.clear(); }
  // Pack ids are never reused (the block cache is keyed by pack and offset):
  // a counter in meta.json is advanced, durably, before a pack is created.
  async allocatePack(state) {
    const meta = await this.readJson(this.metaFile).catch(() => null);
    const max = Math.max(0, ...state.packs.keys());
    const id = Math.max(Number.isSafeInteger(meta?.nextPack) ? meta.nextPack : 0, max + 1);
    await this.writeDurable(this.metaFile, JSON.stringify({ version: 1, nextPack: id + 1 }));
    return id;
  }
  // Appends records (pack data is already flushed). A missing, torn or
  // foreign index is rewritten in full instead.
  async appendIndex(state, entries) {
    if (!entries.length) return;
    await this.plain(this.index);
    const stat = await lstatOrNull(this.index);
    if (!stat?.isFile() || state.indexValid < INDEX_MAGIC.length || stat.size !== state.indexValid) {
      await this.writeDurable(this.index, indexBytes([...state.chunks]));
      return;
    }
    const handle = await fs.open(this.index, 'a');
    try { await handle.write(Buffer.concat(entries.map(([hash, e]) => encodeRecord(hash, e)))); await handle.sync(); } finally { await handle.close(); }
  }
  // Rebuilds the index from the packs alone and writes it atomically.
  async rebuildIndex() {
    await this.assertFolders();
    const chunks = [];
    const seen = new Set();
    for (const p of await this.packList()) {
      await scanPack(p.file, 0, p.size, async (block, blockLength, entries) => {
        for (const x of entries) if (!seen.has(x.hash)) { seen.add(x.hash); chunks.push([x.hash, { pack: p.id, block, blockLength, inner: x.inner, len: x.len }]); }
      });
    }
    await this.ensureDir(this.dir);
    await this.writeDurable(this.index, indexBytes(chunks));
    this.forget();
    return { chunks: chunks.length };
  }
  async readBlock(e) {
    const key = `${e.pack}:${e.block}`;
    if (this.blocks.has(key)) { const raw = this.blocks.get(key); this.blocks.delete(key); this.blocks.set(key, raw); return raw; }
    const file = this.packFile(e.pack);
    await this.plain(file, false);
    const damaged = () => new Error(`Damaged archive block in ${path.basename(file)} at ${e.block}`);
    const handle = await fs.open(file, 'r');
    let buf;
    try {
      // The length comes from the index: check it against the cap and the file before allocating.
      const size = (await handle.stat()).size;
      if (!Number.isSafeInteger(e.blockLength) || e.blockLength < BLOCK_HEADER || e.blockLength > limits.maxBlock || e.block + e.blockLength > size) throw damaged();
      buf = Buffer.alloc(e.blockLength);
      const { bytesRead } = await handle.read(buf, 0, e.blockLength, e.block);
      if (bytesRead !== e.blockLength) throw damaged();
    } finally { await handle.close(); }
    const header = parseHeader(buf);
    if (!header || header.length !== e.blockLength || !blockCrcOk(buf, header)) throw damaged();
    const stored = buf.subarray(BLOCK_HEADER + header.count * ENTRY);
    const total = blockEntries(buf, header).reduce((n, x) => n + x.len, 0);
    if (total > limits.maxBlock) throw damaged();
    let raw;
    // Inflate never produces more than the entries say the block holds.
    try { raw = header.flags ? await inflateRaw(stored, { maxOutputLength: Math.max(1, total) }) : stored; } catch { throw damaged(); }
    if (raw.length !== total) throw damaged();
    this.blocks.set(key, raw);
    while (this.blocks.size > limits.blockCache) this.blocks.delete(this.blocks.keys().next().value);
    return raw;
  }
  async readChunk(hash, state) {
    const e = (state || await this.loadIndex()).chunks.get(hash);
    if (!e) throw new Error(`Archive chunk ${hash} is missing`);
    const raw = await this.readBlock(e);
    if (e.inner + e.len > raw.length) throw new Error(`Archive chunk ${hash} is damaged`);
    return raw.subarray(e.inner, e.inner + e.len);
  }

  // ---- Recipes -------------------------------------------------------------

  async readRecipe(sha) {
    if (!SHA.test(String(sha))) return null;
    const file = this.recipePath(sha);
    await this.plain(file);
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
    try {
      const r = JSON.parse(text);
      const own = Buffer.from(String(r.chunks || ''), 'base64');
      if (r.sha256 !== sha || !Number.isSafeInteger(r.size) || r.size < 0 || own.length % 32 || (r.base != null && (!SHA.test(r.base) || !Number.isSafeInteger(r.take) || r.take < 0))) return null;
      return { ...r, own, file };
    } catch { return null; }
  }
  async hasRecipe(sha) { return !!(await lstatOrNull(this.recipePath(sha))); }
  // The full ordered list of chunk hashes of a version, following its base.
  async chunkHashes(sha, pending, guard = 0) {
    if (guard > limits.chainDepth + 8) return null;
    const r = pending?.get(sha) || await this.readRecipe(sha);
    if (!r) return null;
    const own = [];
    for (let i = 0; i < r.own.length; i += 32) own.push(r.own.toString('hex', i, i + 32));
    if (!r.base) return own;
    const base = await this.chunkHashes(r.base, pending, guard + 1);
    if (!base || base.length < r.take) return null;
    return base.slice(0, r.take).concat(own);
  }
  // Rebuilds a version chunk by chunk, calling `sink` with each chunk, and
  // checks its size and whole-file SHA-256.
  async rebuild(sha, sink) {
    const r = await this.readRecipe(sha);
    if (!r) throw new Error(`No archived version ${sha}`);
    const list = await this.chunkHashes(sha);
    if (!list) throw new Error(`The recipe of ${sha} is incomplete`);
    const state = await this.loadIndex();
    const hash = crypto.createHash('sha256');
    let size = 0;
    for (const h of list) { const c = await this.readChunk(h, state); hash.update(c); size += c.length; if (sink) await sink(c); }
    if (size !== r.size || hash.digest('hex') !== sha) throw new Error(`Archived version ${sha} did not rebuild to its SHA-256`);
    return r;
  }
  // Verification by rebuild (A3): true only if the version rebuilds exactly.
  async verify(sha, size) {
    if (!SHA.test(String(sha))) return false;
    await this.assertFolders();
    await this.plain(this.recipePath(sha));
    const r = await this.readRecipe(sha);
    if (!r || (size !== undefined && r.size !== size)) return false;
    try { await this.rebuild(sha); return true; } catch { return false; }
  }
  // Recipe present and every chunk indexed, without reading data (estimates only).
  async present(sha, size) {
    if (!SHA.test(String(sha))) return false;
    const r = await this.readRecipe(sha);
    if (!r || (size !== undefined && r.size !== size)) return false;
    const list = await this.chunkHashes(sha), state = await this.loadIndex();
    return !!list && list.every(h => state.chunks.has(h));
  }
  async read(sha) { const parts = []; await this.rebuild(sha, c => { parts.push(Buffer.from(c)); }); return Buffer.concat(parts); }
  async listRecipes() {
    await this.plain(this.recipes);
    const out = [];
    let dirs;
    try { dirs = await fs.readdir(this.recipes); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
    for (const d of dirs.sort()) {
      const dir = path.join(this.recipes, d), stat = await lstatOrNull(dir);
      if (!stat?.isDirectory()) continue;
      for (const name of (await fs.readdir(dir)).sort()) {
        const file = path.join(dir, name), s = await lstatOrNull(file);
        if (!s?.isFile()) continue;
        const sha = name.replace(/\.json$/, '');
        out.push({ name, sha256: SHA.test(sha) && name === `${sha}.json` ? sha : null, file, size: s.size, temp: TEMP.test(name) });
      }
    }
    return out;
  }

  // ---- Writing -------------------------------------------------------------

  async beginWrite({ interrupt = async () => {} } = {}) {
    for (const dir of [this.dir, this.packs, this.recipes, this.tmp]) await this.ensureDir(dir);
    await this.recoverCompaction();
    return new Writer(this, await this.loadIndex(), interrupt);
  }
  // Stores versions in one session: [{ data, sha256?, name?, mode?, base? }].
  async putVersions(items, options) {
    const writer = await this.beginWrite(options);
    try {
      const results = [];
      for (const item of items) results.push(await writer.put(item));
      await writer.commit();
      return results;
    } finally { await writer.close(); }
  }

  // ---- Garbage collection and compaction (A4) ------------------------------

  // Deletes recipes outside `keep` (and their bases), plus temp leftovers.
  async sweep(keep) {
    const live = await this.closure(keep);
    const removed = [];
    for (const r of await this.listRecipes()) {
      if (r.temp || (r.sha256 && !live.has(r.sha256))) {
        await this.plain(r.file, false);
        await fs.unlink(r.file);
        removed.push({ name: r.sha256 || r.name, size: r.size });
      }
    }
    await this.removeTemps();
    return removed;
  }
  async closure(keep) {
    const live = new Set(), queue = [...keep].filter(s => SHA.test(String(s)));
    while (queue.length) {
      const sha = queue.pop();
      if (live.has(sha)) continue;
      live.add(sha);
      const r = await this.readRecipe(sha);
      if (r?.base) queue.push(r.base);
    }
    return live;
  }
  async removeTemps() {
    for (const dir of [this.dir, this.tmp]) {
      let names;
      try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      for (const name of names.filter(n => TEMP.test(n))) {
        const file = path.join(dir, name), stat = await lstatOrNull(file);
        if (stat?.isFile()) { await this.plain(file, false); await fs.unlink(file); }
      }
    }
  }
  async recoverCompaction() {
    const journal = await this.readJson(this.compactJournal);
    if (!journal) return null;
    const ids = list => (Array.isArray(list) ? list : []).filter(Number.isSafeInteger);
    // Only packs this compaction created (ids at or above the nextPack recorded
    // when it started) count as new; a pack is deleted only when the index
    // does not reference it. Without an index nothing is deleted.
    const start = Number.isSafeInteger(journal.nextPack) ? journal.nextPack : Infinity;
    const fresh = ids(journal.new).filter(id => id >= start);
    let step = journal.step;
    if (journal.state === 'running' && step === 'writing') {
      // Find out whether the index switch happened before the crash.
      step = (await this.indexReferences(new Set(fresh))) ? 'switched' : 'writing';
    }
    const indexed = !!(await lstatOrNull(this.index))?.isFile();
    if (journal.state === 'running' && indexed) for (const id of step === 'switched' ? ids(journal.old).filter(id => id < start) : fresh) {
      if (await this.indexReferences(new Set([id]))) continue;
      const file = this.packFile(id);
      await this.plain(file);
      if ((await lstatOrNull(file))?.isFile()) await fs.unlink(file);
    }
    await fs.unlink(this.compactJournal).catch(e => { if (e.code !== 'ENOENT') throw e; });
    this.forget();
    return step;
  }
  async indexReferences(packIds) {
    if (!packIds.size) return false;
    let buf;
    try { buf = await fs.readFile(this.index); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    for (let pos = INDEX_MAGIC.length; pos + RECORD <= buf.length; pos += RECORD) if (packIds.has(buf.readUInt32LE(pos + 32))) return true;
    return false;
  }
  // Rewrites packs whose share of unreferenced data reaches minDeadRatio:
  // write a new pack, switch the index, then delete the old packs.
  async compact({ minDeadRatio = 0.5, interrupt = async () => {} } = {}) {
    for (const dir of [this.dir, this.packs, this.recipes, this.tmp]) await this.ensureDir(dir);
    await this.recoverCompaction();
    const state = await this.loadIndex();
    const live = new Set();
    for (const r of await this.listRecipes()) {
      if (!r.sha256) continue;
      const recipe = await this.readRecipe(r.sha256);
      if (recipe) for (let i = 0; i < recipe.own.length; i += 32) live.add(recipe.own.toString('hex', i, i + 32));
    }
    const totals = new Map();
    for (const p of state.packs.values()) totals.set(p.id, { total: 0, live: 0 });
    for (const [hash, e] of state.chunks) { const t = totals.get(e.pack); t.total += e.len; if (live.has(hash)) t.live += e.len; }
    // A pack with no indexed chunk holds only dead or torn data.
    const old = [...totals].filter(([, t]) => !t.total || (t.total > t.live && (t.total - t.live) / t.total >= minDeadRatio)).map(([id]) => id);
    if (!old.length) return { compacted: [], freed: 0 };
    const oldSet = new Set(old);
    const before = [...state.packs.values()].filter(p => oldSet.has(p.id)).reduce((n, p) => n + p.size, 0);
    const moving = [...state.chunks].filter(([hash, e]) => oldSet.has(e.pack) && live.has(hash));
    let nextId = null;
    // Recovery may delete only packs created by this compaction (ids from here on).
    const meta = await this.readJson(this.metaFile).catch(() => null);
    const startPack = Math.max(Number.isSafeInteger(meta?.nextPack) ? meta.nextPack : 0, Math.max(0, ...state.packs.keys()) + 1);
    const journal = { state: 'running', step: 'writing', old, new: [], nextPack: startPack, started: new Date().toISOString() };
    await this.writeDurable(this.compactJournal, JSON.stringify(journal));
    const remapped = new Map();
    let handle = null, file = null, size = 0, block = [], raw = 0, written = 0;
    const openNew = async () => {
      if (handle) { await handle.sync(); await handle.close(); }
      // A new id is journaled before its pack file is created.
      nextId = await this.allocatePack(state);
      journal.new.push(nextId);
      await this.writeDurable(this.compactJournal, JSON.stringify(journal));
      file = this.packFile(nextId);
      await this.plain(file);
      handle = await fs.open(file, 'wx', 0o600);
      await handle.write(PACK_MAGIC);
      size = PACK_MAGIC.length;
    };
    const flush = async () => {
      if (!block.length) return;
      const enc = await encodeBlock(block);
      if (!handle || (size + enc.bytes.length > limits.packBytes && size > PACK_MAGIC.length)) await openNew();
      await handle.write(enc.bytes);
      for (const x of enc.entries) remapped.set(x.hash, { pack: nextId, block: size, blockLength: enc.bytes.length, inner: x.inner, len: x.len });
      size += enc.bytes.length;
      written += enc.bytes.length;
      block = []; raw = 0;
    };
    try {
      for (const [hash] of moving.sort((a, b) => a[1].pack - b[1].pack || a[1].block - b[1].block || a[1].inner - b[1].inner)) {
        const data = Buffer.from(await this.readChunk(hash, state));
        if (digest(data) !== hash) throw new Error(`Archive chunk ${hash} is damaged; compaction stopped`);
        block.push({ hash, data });
        raw += data.length;
        if (raw >= limits.blockBytes) await flush();
      }
      await flush();
      if (handle) { await handle.sync(); await handle.close(); handle = null; }
    } catch (e) {
      if (handle) await handle.close().catch(() => {});
      await this.recoverCompaction();
      throw e;
    }
    await interrupt('compact-written');
    const entries = [];
    for (const [hash, e] of state.chunks) {
      if (!oldSet.has(e.pack)) entries.push([hash, e]);
      else if (remapped.has(hash)) entries.push([hash, remapped.get(hash)]);
    }
    await this.writeDurable(this.index, indexBytes(entries));
    this.forget();
    await interrupt('compact-index-switched');
    journal.step = 'switched';
    await this.writeDurable(this.compactJournal, JSON.stringify(journal));
    for (const id of old) {
      const f = this.packFile(id);
      await this.plain(f);
      if ((await lstatOrNull(f))?.isFile()) await fs.unlink(f);
      await interrupt(`compact-deleted:${id}`);
    }
    await fs.unlink(this.compactJournal);
    this.forget();
    return { compacted: old, freed: Math.max(0, before - written - (written ? PACK_MAGIC.length : 0)) };
  }

  // ---- Integrity (A3) ------------------------------------------------------

  // Checks every block's CRC, and rebuilds a sample of versions (all with full).
  async check({ full = false, sample = 20 } = {}) {
    this.startRun();
    await this.assertFolders();
    const result = { packs: 0, blocks: 0, torn: [], recipes: 0, rebuilt: 0, failed: [] };
    for (const p of await this.packList()) {
      result.packs++;
      const scan = await scanPack(p.file, 0, p.size, async () => { result.blocks++; });
      if (scan.torn) result.torn.push(`${path.basename(p.file)} (ignored after byte ${scan.end})`);
    }
    const recipes = (await this.listRecipes()).filter(r => r.sha256);
    result.recipes = recipes.length;
    let chosen = recipes;
    if (!full && recipes.length > sample) chosen = [...recipes].sort(() => Math.random() - 0.5).slice(0, sample);
    for (const r of chosen) {
      result.rebuilt++;
      try { await this.rebuild(r.sha256); } catch (e) { result.failed.push({ sha256: r.sha256, error: e.message }); }
    }
    return result;
  }
  // Every file in the archive folder counts: packs, index, recipes, catalog.
  async bytes() {
    let total = 0;
    const visit = async dir => {
      let names;
      try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const name of names) {
        const file = path.join(dir, name), stat = await fs.lstat(file);
        if (stat.isDirectory()) await visit(file); else if (stat.isFile()) total += stat.size;
      }
    };
    if ((await lstatOrNull(this.dir))?.isDirectory()) await visit(this.dir);
    return total;
  }

  // ---- Catalog and capture index (A5, C1) ----------------------------------

  async readCatalog() {
    const c = await this.readJson(this.catalogFile);
    return c && typeof c.keys === 'object' && c.keys ? c : { version: 1, keys: {} };
  }
  async writeCatalog(catalog) { await this.writeDurable(this.catalogFile, JSON.stringify(catalog)); }
  async readCaptureIndex() {
    const c = await this.readJson(this.captureFile);
    return c && typeof c.files === 'object' && c.files ? c : { version: 1, files: {} };
  }
  async writeCaptureIndex(index) { await this.writeDurable(this.captureFile, JSON.stringify(index)); }

  // ---- Restore and export (A6) ---------------------------------------------

  // Rebuilds a version into `${target}.tmp-<uuid>`, checks it, then renames it
  // into place. An existing target is never replaced by a different version.
  async exportTo(sha, target) {
    const existing = await lstatOrNull(target);
    if (existing && !existing.isFile()) throw new Error(`${target} exists and is not a plain file. Nothing was written.`);
    if (existing && (await hashPath(target)) === sha) return { written: false, identical: true, target };
    if (existing) throw Object.assign(new Error(`${target} already holds a different version. Nothing was overwritten; export to another location instead.`), { code: 'EEXIST' });
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.tmp-${crypto.randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await this.rebuild(sha, c => handle.write(c));
      await handle.sync();
      await handle.close();
      handle = null;
      if ((await hashPath(temp)) !== sha) throw new Error('The exported file did not verify');
      // Checked again right before the rename: never replace a file that appeared meanwhile.
      await placeNew(temp, target);
      return { written: true, identical: false, target };
    } catch (e) {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
      throw e;
    }
  }
}

// Puts a verified temp file at the target without ever replacing a file there:
// a hard link fails with EEXIST if the target appeared meanwhile (or an
// exclusive copy where links are unavailable); then the temp name goes.
async function placeNew(temp, target) {
  const appeared = () => Object.assign(new Error(`${target} appeared while exporting. Nothing was overwritten.`), { code: 'EEXIST' });
  try { await fs.link(temp, target); }
  catch (e) {
    if (e.code === 'EEXIST') throw appeared();
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL'].includes(e.code)) throw e;
    try { await fs.copyFile(temp, target, fsSync.constants.COPYFILE_EXCL); } catch (c) { if (c.code === 'EEXIST') throw appeared(); throw c; }
  }
  await fs.unlink(temp);
}
function hashPath(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fsSync.createReadStream(file).on('data', c => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// One write session: chunks are appended to the pack as blocks fill; commit
// flushes the pack, then the index, then the recipes (A3).
class Writer {
  constructor(archive, state, interrupt) {
    this.archive = archive;
    this.state = state;
    this.interrupt = interrupt;
    this.block = [];
    this.raw = 0;
    this.pendingData = new Map();
    this.entries = [];
    this.recipes = new Map();
    this.pack = null;
    this.handle = null;
  }
  async openPack(extra) {
    const s = this.state;
    if (this.pack && this.pack.size + extra > limits.packBytes && this.pack.size > PACK_MAGIC.length) { await this.handle.sync(); await this.handle.close(); this.handle = null; this.pack = null; }
    if (this.pack) return;
    const last = [...s.packs.values()].sort((a, b) => b.id - a.id)[0];
    // Append only to the newest pack, only if its end is exactly what was
    // indexed or recovered and it is below the size limit; otherwise seal it.
    if (last && !last.torn && last.end === last.size && last.size >= PACK_MAGIC.length && last.size + extra <= limits.packBytes) this.pack = last;
    else {
      const id = await this.archive.allocatePack(s), file = this.archive.packFile(id);
      await this.archive.plain(file);
      await fs.writeFile(file, PACK_MAGIC, { flag: 'wx', mode: 0o600 });
      this.pack = { id, file, size: PACK_MAGIC.length, end: PACK_MAGIC.length, torn: false };
      s.packs.set(id, this.pack);
    }
    await this.archive.plain(this.pack.file, false);
    this.handle = await fs.open(this.pack.file, 'a');
  }
  async addChunk(hash, data) {
    if (data.length > limits.maxBlock - 1024 * 1024) throw new Error('A file is too large for the archive');
    if (this.state.chunks.has(hash) || this.pendingData.has(hash)) return;
    this.pendingData.set(hash, data);
    this.block.push({ hash, data });
    this.raw += data.length;
    if (this.raw >= limits.blockBytes) await this.flushBlock();
  }
  async flushBlock() {
    if (!this.block.length) return;
    const enc = await encodeBlock(this.block);
    await this.openPack(enc.bytes.length);
    const at = this.pack.size;
    await this.handle.write(enc.bytes);
    this.pack.size += enc.bytes.length;
    this.pack.end = this.pack.size;
    for (const x of enc.entries) {
      const e = { pack: this.pack.id, block: at, blockLength: enc.bytes.length, inner: x.inner, len: x.len };
      this.state.chunks.set(x.hash, e);
      this.entries.push([x.hash, e]);
      this.pendingData.delete(x.hash);
    }
    this.block = [];
    this.raw = 0;
  }
  // Adds one version. `base` names an earlier version of the same file: the
  // recipe then stores only the chunks after their common prefix.
  async put({ data, sha256, name, mode, base }) {
    const sha = sha256 || digest(data);
    if (!SHA.test(sha) || digest(data) !== sha) throw new Error('Version hash mismatch');
    // A version whose recipe already resolves to available chunks is not
    // written again (a rewrite could also form a base cycle).
    if (this.recipes.has(sha) || await this.archive.hasRecipe(sha)) {
      const known = await this.archive.chunkHashes(sha, this.recipes);
      if (known && known.every(h => this.state.chunks.has(h) || this.pendingData.has(h))) return { sha256: sha, size: data.length, chunks: known.length, delta: false, stored: false };
      base = null;
    }
    const m = mode || modeFor(name, data);
    const chunks = chunksOf(data, m), hashes = chunks.map(c => digest(c));
    for (let i = 0; i < chunks.length; i++) await this.addChunk(hashes[i], chunks[i]);
    let recipeBase = null, take = 0, depth = 0;
    if (base && base !== sha && SHA.test(base)) {
      const b = this.recipes.get(base) || await this.archive.readRecipe(base);
      const list = b && (b.depth || 0) < limits.chainDepth ? await this.archive.chunkHashes(base, this.recipes) : null;
      if (list) {
        let k = 0;
        while (k < list.length && k < hashes.length && list[k] === hashes[k]) k++;
        // The base's chunks must all be available, or this version would not rebuild.
        if (k >= Math.min(limits.minDelta, hashes.length) && k > 0 && list.slice(0, k).every(h => this.state.chunks.has(h) || this.pendingData.has(h))) { recipeBase = base; take = k; depth = (b.depth || 0) + 1; }
      }
    }
    const own = hashes.slice(take);
    const recipe = { v: 1, sha256: sha, size: data.length, mode: m, count: hashes.length, base: recipeBase, take, depth, created: new Date().toISOString(), chunks: Buffer.concat(own.map(h => Buffer.from(h, 'hex'))).toString('base64') };
    this.recipes.set(sha, { ...recipe, own: Buffer.from(recipe.chunks, 'base64') });
    return { sha256: sha, size: data.length, chunks: hashes.length, delta: !!recipeBase, stored: true };
  }
  async commit() {
    await this.flushBlock();
    if (this.handle) { await this.handle.sync(); await this.handle.close(); this.handle = null; }
    await this.interrupt('pack-flushed');
    const appended = [...this.state.recovered, ...this.entries];
    await this.archive.appendIndex(this.state, appended);
    this.state.recovered = [];
    this.entries = [];
    await this.interrupt('index-flushed');
    for (const r of this.recipes.values()) {
      const { own: _own, ...json } = r;
      await this.archive.writeDurable(this.archive.recipePath(r.sha256), JSON.stringify(json));
    }
    this.recipes.clear();
    await this.interrupt('recipe-flushed');
  }
  async close() {
    if (this.handle) { await this.handle.close().catch(() => {}); this.handle = null; }
    // The in-memory index may hold entries that never reached the disk.
    this.archive.forget();
  }
}

const archives = new Map();
function open(dir, options) {
  const key = path.resolve(dir);
  const existing = archives.get(key);
  if (existing && existing.assertPlainPath === options.assertPlainPath && existing.root === options.root) return existing;
  const a = new Archive(dir, options);
  archives.set(key, a);
  return a;
}

module.exports = { open, placeNew, limits, crc32, splitLines, modeFor, scanPack, digest, Archive };
