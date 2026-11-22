'use strict';
// Shared storage: the pool of junctioned history folders, the store-wide lock,
// the content-addressed recovery store, and migration, rollback and cleanup.
// Every function takes its roots as parameters; nothing here knows the user's
// home directory, so tests can never touch real data.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const archiveLib = require('./archive');

const SHAREABLE = ['projects', 'file-history', 'image-cache'];
const WIN = process.platform === 'win32';
const SHA = /^[a-f0-9]{64}$/;
const MANIFEST_ID = /^[0-9]+-[a-f0-9-]{36}$/;
const PRESERVED = /^(projects|file-history|image-cache)\.pre-shared-([0-9]+)$/;
const DAY = 24 * 60 * 60 * 1000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
// NTFS compares names case-insensitively, and realpath may return a \\?\ prefix.
const normalize = value => { const resolved = path.resolve(String(value).replace(/^\\\\\?\\/, '')); return WIN ? resolved.toLowerCase() : resolved; };
const fold = relative => { const p = relative.split(/[\\/]/).join('/'); return WIN ? p.toLowerCase() : p; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isJsonl = name => name.toLowerCase().endsWith('.jsonl');

function paths(switcherRoot) {
  if (typeof switcherRoot !== 'string' || !switcherRoot) throw new Error('Storage root is required');
  const root = path.resolve(switcherRoot);
  const backups = path.join(root, 'backups');
  return { root, profiles: path.join(root, 'profiles'), shared: path.join(root, 'shared'), backups, objects: path.join(backups, 'objects'), archive: path.join(backups, 'archive'), exports: path.join(root, 'exports'), manifests: path.join(backups, 'manifests'), lock: path.join(root, '.storage-lock'), journal: path.join(root, 'migration.json'), links: path.join(root, 'link-migration.json'), recovery: path.join(root, 'transfer-recovery.json') };
}
async function lstatOrNull(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } }
// fs.promises.realpath fails with ENOENT on Windows for paths of 260 or more
// characters (Node 20). The callback form of the native call handles them, and
// the JavaScript implementation is the fallback if it is unavailable.
function realpath(file) {
  return new Promise((resolve, reject) => {
    const native = fsSync.realpath.native || fsSync.realpath;
    native(file, (error, value) => {
      if (!error) return resolve(value);
      if (error.code !== 'ENOENT' || native === fsSync.realpath) return reject(error);
      fsSync.realpath(file, (again, resolved) => again ? reject(again) : resolve(resolved));
    });
  });
}
async function realOrNull(file) { try { return await realpath(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } }
const inside = (dir, abs) => { const rel = path.relative(normalize(dir), normalize(abs)); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
// Every component from `root` (a profile root, the Default root or the
// switcher root) down to `abs` must be a plain folder (or, last, a plain
// file), never a link, and the real path must stay under the real root. With
// allowMissing, components that do not exist yet are accepted (for writes).
async function assertPlainPath(root, abs, { allowMissing = false } = {}) {
  const base = path.resolve(root), target = path.resolve(abs);
  if (!inside(base, target)) throw Object.assign(new Error(`${abs} is outside ${root}`), { code: 'EOUTSIDE' });
  const parts = path.relative(base, target).split(path.sep).filter(Boolean);
  let current = base, deepest = null;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    const stat = await lstatOrNull(current);
    if (!stat) { if (allowMissing) break; throw Object.assign(new Error(`${current} does not exist`), { code: 'ENOENT' }); }
    if (stat.isSymbolicLink()) throw Object.assign(new Error(`Refusing to follow a link: ${current}`), { code: 'ELINKED' });
    if (i < parts.length - 1 && !stat.isDirectory()) throw Object.assign(new Error(`${current} is not a folder`), { code: 'ENOTDIR' });
    if (i === parts.length - 1 && !stat.isDirectory() && !stat.isFile()) throw Object.assign(new Error(`${current} is not a plain file or folder`), { code: 'EINVAL' });
    deepest = current;
  }
  if (deepest && !inside(await realpath(base), await realpath(deepest))) throw Object.assign(new Error(`${abs} resolves outside ${root}`), { code: 'EOUTSIDE' });
  return target;
}
// shared/ and each shared/<name> must be plain folders before anything is written there.
async function assertSharedPlain(switcherRoot) {
  const p = paths(switcherRoot);
  for (const dir of [p.shared, ...SHAREABLE.map(name => path.join(p.shared, name))]) await assertPlainPath(p.root, dir, { allowMissing: true });
}
// backups/, backups/objects and backups/manifests must be plain folders.
async function assertStorePlain(switcherRoot) {
  const p = paths(switcherRoot);
  for (const dir of [p.backups, p.objects, p.manifests, p.archive, ...['packs', 'recipes', 'tmp'].map(n => path.join(p.archive, n))]) await assertPlainPath(p.root, dir, { allowMissing: true });
}
// The archive (decision 12) behind the object-store API.
const archiveOf = switcherRoot => archiveLib.open(paths(switcherRoot).archive, { root: paths(switcherRoot).root, assertPlainPath, renameReplacing });
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// ---- Links -----------------------------------------------------------------

// The only link history code may follow: <profiles>/<uuid>/<name> whose real
// path is <switcherRoot>/shared/<name>, with no link at shared/ or below it.
async function managedLink(link, profileRoot, name, switcherRoot) {
  if (!switcherRoot || !SHAREABLE.includes(name)) return false;
  const p = paths(switcherRoot);
  // Default (~/.claude) cannot join the pool in 0.0.13.
  if (normalize(path.dirname(path.resolve(profileRoot))) !== normalize(p.profiles)) return false;
  if (normalize(link) !== normalize(path.join(profileRoot, name))) return false;
  const stat = await lstatOrNull(link);
  if (!stat?.isSymbolicLink()) return false;
  for (const part of [p.shared, path.join(p.shared, name)]) {
    const s = await lstatOrNull(part);
    if (!s || s.isSymbolicLink() || !s.isDirectory()) return false;
  }
  const real = await realOrNull(link), base = await realOrNull(p.root);
  return !!real && !!base && normalize(real) === normalize(path.join(base, 'shared', name));
}
async function folderStatus(profileRoot, name, switcherRoot) {
  const stat = await lstatOrNull(path.join(profileRoot, name));
  if (!stat) return 'missing';
  if (stat.isSymbolicLink()) return (await managedLink(path.join(profileRoot, name), profileRoot, name, switcherRoot)) ? 'linked' : 'foreign-link';
  return stat.isDirectory() ? 'private' : 'other';
}
async function isPoolMember(profileRoot, switcherRoot) {
  return (await folderStatus(profileRoot, 'projects', switcherRoot)) === 'linked';
}
async function poolMembers(switcherRoot) {
  const p = paths(switcherRoot);
  let names;
  try { names = await fs.readdir(p.profiles); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const members = [];
  for (const name of names) {
    const directory = path.join(p.profiles, name);
    if ((await lstatOrNull(directory))?.isDirectory() && await isPoolMember(directory, switcherRoot)) members.push(directory);
  }
  return members;
}
// Removes a link itself; never follows it, so the shared target survives.
async function removeLink(file) {
  const stat = await fs.lstat(file);
  if (!stat.isSymbolicLink()) throw new Error(`Refusing to remove ${file}: it is not a link`);
  try { await fs.unlink(file); } catch (e) { if (!['EPERM', 'EISDIR', 'EACCES'].includes(e.code)) throw e; await fs.rmdir(file); }
}
// A non-following recursive delete for folders this module created or already
// verified. Links found inside are removed as links, never entered.
async function removeTree(file) {
  const stat = await lstatOrNull(file);
  if (!stat) return;
  if (stat.isSymbolicLink()) return removeLink(file);
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(file)) await removeTree(path.join(file, name));
    return fs.rmdir(file);
  }
  return fs.unlink(file);
}
// On Windows a rename that replaces a file fails briefly (EPERM/EBUSY) while
// another process, such as an antivirus scanner, has the target open.
async function renameReplacing(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); }
    catch (e) { if (!WIN || attempt >= 10 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e; await pause(25 * (attempt + 1)); }
  }
}
// Migration and rollback rename whole history folders; a scanner or indexer
// holding a file inside briefly causes the same transient errors.
const renameFolder = (from, to) => renameReplacing(from, to);
async function writeAtomic(file, data, root) {
  if (root) await assertPlainPath(root, path.dirname(file), { allowMissing: true });
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (root) await assertPlainPath(root, path.dirname(file));
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  try { await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 }); await renameReplacing(temp, file); }
  catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
}
// Copies a file next to the target, checks its hash, then renames it in.
// `root` bounds the destination and `fromRoot` the source (see assertPlainPath).
async function copyVerified(from, to, sha256, { root, fromRoot } = {}) {
  if (fromRoot) await assertPlainPath(fromRoot, from);
  if (root) await assertPlainPath(root, path.dirname(to), { allowMissing: true });
  await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  if (root) await assertPlainPath(root, path.dirname(to));
  const temp = `${to}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.copyFile(from, temp, fsSync.constants.COPYFILE_EXCL);
    const got = (await hashFile(temp)).sha256;
    if (got !== sha256) throw new Error(`Content of ${from} changed since it was analyzed`);
    await renameReplacing(temp, to);
  } catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
}

// ---- Hashing ---------------------------------------------------------------

// One read gives the hash, size, the hashes of requested prefixes and whether
// the last line is complete (Claude may have crashed mid-write).
function hashFile(file, { prefixes = [] } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const wanted = [...new Set(prefixes)].filter(n => n >= 0).sort((a, b) => a - b);
    const prefixHashes = {};
    let offset = 0, tail = Buffer.alloc(0), next = 0;
    while (next < wanted.length && wanted[next] === 0) prefixHashes[wanted[next++]] = digest(Buffer.alloc(0));
    const stream = fsSync.createReadStream(file);
    stream.on('data', chunk => {
      let start = 0;
      while (next < wanted.length && wanted[next] <= offset + chunk.length) {
        const cut = wanted[next] - offset;
        hash.update(chunk.subarray(start, cut));
        start = cut;
        prefixHashes[wanted[next++]] = hash.copy().digest('hex');
      }
      hash.update(chunk.subarray(start));
      offset += chunk.length;
      const newline = chunk.lastIndexOf(10);
      tail = newline >= 0 ? Buffer.from(chunk.subarray(newline + 1)) : Buffer.concat([tail, chunk]).subarray(-65536);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), size: offset, prefixHashes, truncated: tail.length > 0, tailParses: tail.length ? (() => { try { JSON.parse(tail.toString('utf8')); return true; } catch { return false; } })() : true }));
  });
}
async function prefixHash(file, size) { return (await hashFile(file, { prefixes: [size] })).prefixHashes[size]; }

// ---- Store-wide lock -------------------------------------------------------

async function readStoreLock(switcherRoot) {
  const p = paths(switcherRoot);
  const stat = await lstatOrNull(p.lock);
  if (!stat) return null;
  try { return { ...JSON.parse(await fs.readFile(path.join(p.lock, 'owner.json'), 'utf8')), mtime: stat.mtimeMs }; }
  catch { return { unreadable: true, mtime: stat.mtimeMs }; }
}
const localTime = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? 'an unknown time' : d.toLocaleString(); };
const describeOwner = owner => !owner ? 'nobody' : owner.unreadable ? 'an unknown owner' : `PID ${owner.pid} (${owner.purpose}, since ${localTime(owner.started)})`;
// mkdir is atomic across processes, so one lock serves every VS Code window.
async function acquireStoreLock(switcherRoot, purpose, { wait = 10000, delay = 200 } = {}) {
  const p = paths(switcherRoot);
  await fs.mkdir(p.root, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + wait;
  for (;;) {
    try { await fs.mkdir(p.lock, { mode: 0o700 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        const owner = await readStoreLock(switcherRoot);
        throw Object.assign(new Error(`Shared storage is busy: locked by ${describeOwner(owner)}. If that process no longer runs, release the lock in Claude Profiles: Manage Storage.`), { code: 'ESTORELOCKED', owner });
      }
      await pause(delay);
    }
  }
  const token = crypto.randomUUID(), ownerFile = path.join(p.lock, 'owner.json');
  try { await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), purpose, token }), { flag: 'wx', mode: 0o600 }); }
  catch (e) { await fs.rmdir(p.lock).catch(() => {}); throw e; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const owner = await readStoreLock(switcherRoot);
    if (owner?.token !== token) return;
    await fs.unlink(ownerFile);
    await fs.rmdir(p.lock);
  };
}
async function withStoreLock(switcherRoot, purpose, run, options) {
  const release = await acquireStoreLock(switcherRoot, purpose, options);
  // Each locked run (or batch) starts with an empty archive block cache and
  // keeps it for its own rebuilds; another window may have changed the packs.
  archiveOf(switcherRoot).startRun();
  try { return await run(); } finally { await release(); }
}
// Never automatic: only for a dead owner, and only after the user confirmed.
async function releaseStaleLock(switcherRoot, { confirm, alive = processAlive, now = Date.now() } = {}) {
  if (confirm !== true) throw new Error('Releasing the storage lock requires confirmation');
  const owner = await readStoreLock(switcherRoot);
  if (!owner) return false;
  if (owner.unreadable ? now - owner.mtime < 60000 : !Number.isSafeInteger(owner.pid) || alive(owner.pid)) throw new Error(`The storage lock is still held by ${describeOwner(owner)}. It was not released.`);
  const p = paths(switcherRoot);
  const stat = await fs.lstat(p.lock);
  if (stat.isSymbolicLink()) { await removeLink(p.lock); return true; }
  await fs.unlink(path.join(p.lock, 'owner.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await fs.rmdir(p.lock);
  return true;
}

// ---- Migration journal -----------------------------------------------------

async function readJournal(switcherRoot) {
  try { return JSON.parse(await fs.readFile(paths(switcherRoot).journal, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Cannot read migration.json (${e.message}). Fix or remove it before switching.`); }
}
const writeJournal = (switcherRoot, journal) => writeAtomic(paths(switcherRoot).journal, JSON.stringify(journal, null, 2), paths(switcherRoot).root);
async function assertNoMigration(switcherRoot) {
  const journal = await readJournal(switcherRoot);
  if (journal?.state === 'running') throw new Error(`A shared-storage ${journal.kind || 'migration'} is in progress or was interrupted. Open Claude Profiles: Manage Storage to resume or roll it back. Nothing was copied.`);
  // Linking identical conversations (decision 12, M1-M5) has its own journal.
  let links = null;
  try { links = JSON.parse(await fs.readFile(paths(switcherRoot).links, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot read link-migration.json (${e.message}). Fix or remove it before switching.`); }
  if (links?.state === 'running') throw new Error('Linking identical conversations is in progress or was interrupted. Open Claude Profiles: Manage Storage to resume or undo it. Nothing was copied.');
}
// Decision 13: only transcripts are ever hard-linked: projects/<project>/<id>.jsonl
// and projects/<project>/<id>/subagents/<name>.jsonl. Everything else is copied.
function isLinkable(rel) {
  const parts = String(rel).split(/[\\/]/);
  if (parts[0] !== 'projects' || !/\.jsonl$/i.test(parts[parts.length - 1]) || parts.some(p => !p || p === '.' || p === '..')) return false;
  return parts.length === 3 || (parts.length === 5 && parts[3] === 'subagents');
}
// A migration is being prepared while it holds the store lock or while the
// journal carries a 'preparing' marker from a live process. Copy-based
// transfers, which do not take the store lock, check this before staging.
async function assertNoMigrationPending(switcherRoot, { alive = processAlive } = {}) {
  await assertNoMigration(switcherRoot);
  const journal = await readJournal(switcherRoot);
  if (journal?.preparing && Number.isSafeInteger(journal.preparing.pid) && alive(journal.preparing.pid)) throw new Error('A shared-storage migration is being prepared. Switch again when it has finished. Nothing was copied.');
  const owner = await readStoreLock(switcherRoot);
  if (owner && /^(migration|rollback)/.test(owner.purpose || '')) throw new Error(`A shared-storage ${owner.purpose} is running. Switch again when it has finished. Nothing was copied.`);
}
const EDITOR_HOSTS = /^(code|code - insiders|codium|vscodium|cursor|windsurf)(\.exe)?$/i;
// A 'preparing' marker is current only while a migration holds the store lock.
// Otherwise it is a leftover, unless its PID is another live editor process
// (that window may still be finishing). This process never prepares without
// the lock, so its own PID always counts as a leftover.
async function migrationMarker(switcherRoot, { alive = processAlive, list = listProcesses, self = process.pid } = {}) {
  const marker = (await readJournal(switcherRoot))?.preparing;
  if (!marker) return null;
  const owner = await readStoreLock(switcherRoot);
  let stale;
  if (owner && /^migration/.test(owner.purpose || '')) stale = false;
  else if (!Number.isSafeInteger(marker.pid) || !alive(marker.pid) || marker.pid === self) stale = true;
  else {
    const rows = await list().catch(() => null);
    const row = rows?.find(x => x.pid === marker.pid);
    stale = !!rows && !(row && EDITOR_HOSTS.test(path.basename(String(row.name || ''))));
  }
  return { pid: marker.pid, started: marker.started, stale };
}
async function clearMigrationMarker(switcherRoot, { confirm, lock, ...options } = {}) {
  if (confirm !== true) throw new Error('Clearing the migration marker requires confirmation');
  return withStoreLock(switcherRoot, 'clear migration marker', async () => {
    const marker = await migrationMarker(switcherRoot, options);
    if (!marker) return false;
    if (!marker.stale) throw new Error(`The migration marker belongs to PID ${marker.pid}, which may still be preparing a migration. It was not cleared.`);
    const { preparing: _gone, ...rest } = await readJournal(switcherRoot);
    if (Object.keys(rest).length) await writeJournal(switcherRoot, rest);
    else await fs.unlink(paths(switcherRoot).journal);
    return true;
  }, lock);
}
// Journal entries name folders that are later renamed and unlinked: accept only
// switcher profiles and the known folder names.
// The root a journal source must lie under: shared/<name>, or a listed profile's
// shareable folder or its preserved copy. Anything else is refused.
function journalSourceRoot(switcherRoot, journal, source) {
  const p = paths(switcherRoot);
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error(`migration.json names an invalid source: ${source}`);
  const within = dir => inside(dir, source) && normalize(dir) !== normalize(source);
  if (SHAREABLE.some(name => within(path.join(p.shared, name)))) return p.root;
  for (const x of journal.profiles || []) for (const f of x.folders || []) {
    if (within(path.join(x.directory, f.name)) || (f.preserved && within(path.join(x.directory, f.preserved)))) return x.directory;
  }
  throw new Error(`migration.json names a source outside the shared history folders: ${source}`);
}
function assertJournal(switcherRoot, journal) {
  const base = normalize(paths(switcherRoot).profiles);
  for (const x of journal.profiles || []) {
    if (typeof x.directory !== 'string' || normalize(path.dirname(path.resolve(x.directory))) !== base) throw new Error(`migration.json names a folder outside the switcher profiles: ${x.directory}`);
    for (const f of x.folders || []) {
      if (!SHAREABLE.includes(f.name)) throw new Error(`migration.json names an unknown folder: ${f.name}`);
      if (f.preserved != null && !(PRESERVED.test(f.preserved) && f.preserved.startsWith(`${f.name}.`))) throw new Error(`migration.json names an invalid preserved folder: ${f.preserved}`);
    }
  }
  for (const item of [...(journal.files || []), ...(journal.diverged || [])]) {
    if (!SHA.test(String(item.sha256))) throw new Error(`migration.json names an invalid hash for ${item.rel}`);
    journalSourceRoot(switcherRoot, journal, item.source);
  }
}

// A pool transfer whose own rollback failed leaves this durable marker. It
// blocks shared-storage transfers, migration and rollback until resolved.
async function readRecovery(switcherRoot) {
  try { return JSON.parse(await fs.readFile(paths(switcherRoot).recovery, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; return [{ id: 'unreadable', unreadable: true, error: `transfer-recovery.json is unreadable (${e.message})` }]; }
}
// Entries carry an id so that resolving removes exactly what the user saw.
// Callers hold the store lock (a pool transfer records while holding it).
const recoveryId = entry => entry.id || digest(JSON.stringify(entry));
async function recordRecovery(switcherRoot, entry) {
  const entries = (await readRecovery(switcherRoot)) || [];
  if (entries.some(e => e.unreadable)) throw new Error('transfer-recovery.json is unreadable');
  entries.push({ id: crypto.randomUUID(), created: new Date().toISOString(), ...entry });
  await writeAtomic(paths(switcherRoot).recovery, JSON.stringify(entries, null, 2), paths(switcherRoot).root);
}
async function assertNoRecovery(switcherRoot) {
  const entries = await readRecovery(switcherRoot);
  if (entries?.length) throw new Error(`A shared-storage transfer needs recovery (${entries.map(e => e.destination || e.error).join('; ')}). Restore the files it lists, then resolve it in Claude Profiles: Manage Storage. Nothing was copied.`);
}
// Removes only the entries with the given ids (those the user was shown); an
// entry another window recorded meanwhile survives.
async function resolveRecovery(switcherRoot, { confirm, ids, lock } = {}) {
  if (confirm !== true) throw new Error('Resolving a transfer recovery requires confirmation');
  if (!Array.isArray(ids) || !ids.length) throw new Error('Name the recovery entries to resolve');
  return withStoreLock(switcherRoot, 'resolve transfer recovery', async () => {
    const file = paths(switcherRoot).recovery;
    const entries = (await readRecovery(switcherRoot)) || [];
    const wanted = new Set(ids);
    const left = entries.filter(e => !wanted.has(recoveryId(e)));
    const removed = entries.length - left.length;
    if (!left.length) await fs.unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
    else if (removed) await writeAtomic(file, JSON.stringify(left, null, 2), paths(switcherRoot).root);
    return { removed, remaining: left.length };
  }, lock);
}

// ---- Object store and manifests ---------------------------------------------

// A version is valid when it rebuilds from the archive to its SHA-256 (A3), or,
// until it is imported, when a legacy whole-file object holds it.
async function legacyObjectValid(switcherRoot, sha256, size) {
  const file = path.join(paths(switcherRoot).objects, sha256);
  // A linked store could vouch for content kept outside it: refuse instead.
  await assertPlainPath(paths(switcherRoot).root, file, { allowMissing: true });
  const stat = await lstatOrNull(file);
  if (!stat?.isFile() || (size !== undefined && stat.size !== size)) return false;
  return (await hashFile(file)).sha256 === sha256;
}
async function objectValid(switcherRoot, sha256, size) {
  if (!SHA.test(String(sha256))) return false;
  await assertPlainPath(paths(switcherRoot).root, path.join(paths(switcherRoot).objects, sha256), { allowMissing: true });
  await assertStorePlain(switcherRoot);
  if (await archiveOf(switcherRoot).verify(sha256, size)) return true;
  return legacyObjectValid(switcherRoot, sha256, size);
}
// Cheap presence check for estimates (Analyze); never used before a delete.
async function objectPresent(switcherRoot, sha256, size) {
  if (!SHA.test(String(sha256))) return false;
  await assertStorePlain(switcherRoot);
  if (await archiveOf(switcherRoot).present(sha256, size)) return true;
  const stat = await lstatOrNull(path.join(paths(switcherRoot).objects, sha256));
  return !!stat?.isFile() && (size === undefined || stat.size === size);
}
async function putObject(switcherRoot, data, sha256 = digest(data), { name } = {}) {
  if (!SHA.test(sha256) || digest(data) !== sha256) throw new Error('Object hash mismatch');
  if (await objectValid(switcherRoot, sha256, data.length)) return { sha256, stored: false };
  await archiveOf(switcherRoot).putVersions([{ data, sha256, name }]);
  if (!(await objectValid(switcherRoot, sha256, data.length))) throw new Error('Object store write did not verify');
  return { sha256, stored: true };
}
// The source is first copied into the archive's temp folder, so the content
// that is hashed is exactly the content that is archived.
async function putObjectFile(switcherRoot, source, sha256, fromRoot) {
  if (!SHA.test(sha256)) throw new Error('Invalid object hash');
  if (!fromRoot) throw new Error('The source root is required');
  if (await objectValid(switcherRoot, sha256)) return { sha256, stored: false };
  await assertPlainPath(fromRoot, source);
  const a = archiveOf(switcherRoot);
  await a.ensureDir(a.dir);
  await a.ensureDir(a.tmp);
  const temp = a.tempPath();
  try {
    await fs.copyFile(source, temp, fsSync.constants.COPYFILE_EXCL);
    const data = await fs.readFile(temp);
    if (digest(data) !== sha256) throw new Error(`Content of ${source} changed since it was analyzed`);
    await a.putVersions([{ data, sha256, name: source }]);
  } finally { await fs.unlink(temp).catch(() => {}); }
  if (!(await objectValid(switcherRoot, sha256))) throw new Error('Object store write did not verify');
  return { sha256, stored: true };
}
// Rebuilds a stored version (archive first, then a legacy object).
async function readObject(switcherRoot, sha256) {
  if (!SHA.test(String(sha256))) throw new Error('Invalid object hash');
  await assertStorePlain(switcherRoot);
  const a = archiveOf(switcherRoot);
  if (await a.hasRecipe(sha256)) return a.read(sha256);
  const file = path.join(paths(switcherRoot).objects, sha256);
  await assertPlainPath(paths(switcherRoot).root, file);
  const data = await fs.readFile(file);
  if (digest(data) !== sha256) throw new Error(`Stored object ${sha256} is damaged`);
  return data;
}
// Every stored version: archive recipes and legacy objects.
async function storedObjects(switcherRoot) {
  await assertStorePlain(switcherRoot);
  const found = new Set((await archiveOf(switcherRoot).listRecipes()).map(r => r.sha256).filter(Boolean));
  try { for (const name of await fs.readdir(paths(switcherRoot).objects)) if (SHA.test(name)) found.add(name); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return [...found].sort();
}
const newManifestId = () => `${Date.now()}-${crypto.randomUUID()}`;
function manifestPath(switcherRoot, id) {
  if (!MANIFEST_ID.test(id)) throw new Error('Invalid manifest id');
  return path.join(paths(switcherRoot).manifests, `${id}.json`);
}
const writeManifest = (switcherRoot, manifest) => writeAtomic(manifestPath(switcherRoot, manifest.id), JSON.stringify(manifest, null, 2), paths(switcherRoot).root);
async function readManifests(switcherRoot) {
  const dir = paths(switcherRoot).manifests, manifests = [], invalid = [];
  await assertPlainPath(paths(switcherRoot).root, dir, { allowMissing: true });
  let names;
  try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return { manifests, invalid }; throw e; }
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    try {
      const m = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!MANIFEST_ID.test(m.id) || `${m.id}.json` !== name) throw new Error('id mismatch');
      manifests.push({ ...m, file });
    } catch (e) { invalid.push({ file, reason: e.message }); }
  }
  return { manifests, invalid };
}
const objectsOf = m => (m.objects || []).map(o => o.sha256).filter(s => SHA.test(s));
// Hashes held by manifests GC can never expire (pinned, or not committed).
// Only these count as content kept in the recovery store.
const durableReferences = manifests => new Set(manifests.filter(m => m.pinned || m.state !== 'committed').flatMap(objectsOf));
const blockedMessage = invalid => `Cleanup is blocked: ${invalid.length === 1 ? 'a backup manifest is' : 'backup manifests are'} unreadable (${invalid.map(x => x.file).join(', ')}). Fix or remove ${invalid.length === 1 ? 'it' : 'them'} first; nothing was deleted.`;
async function removeUnreferenced(switcherRoot, manifests) {
  const referenced = new Set(manifests.flatMap(objectsOf));
  const dir = paths(switcherRoot).objects, removed = [];
  await assertStorePlain(switcherRoot);
  let names;
  try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return removed; throw e; }
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile()) continue;
    // Temp files are interrupted writes; under the lock none is in progress.
    if ((SHA.test(name) && !referenced.has(name)) || /\.tmp-/.test(name)) { await fs.unlink(file); removed.push({ name, size: stat.size }); }
  }
  return removed;
}
// Archive GC (A4): recipes that no manifest and no catalog entry references
// (directly or as a base) are dropped. Chunks they alone used stay in their
// pack until compaction.
async function removeUnreferencedRecipes(switcherRoot, manifests) {
  const a = archiveOf(switcherRoot);
  if (!(await a.exists())) return [];
  const catalog = await a.readCatalog();
  const keep = new Set(manifests.flatMap(objectsOf));
  for (const list of Object.values(catalog.keys)) for (const v of list) if (SHA.test(String(v.sha256))) keep.add(v.sha256);
  return a.sweep(keep);
}
// writeAtomic leaves <file>.tmp-<uuid> when the process is killed mid-write.
// Leftovers older than a few minutes are removed under the store lock.
const TEMP = /\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function staleTemps(switcherRoot, { olderThan = 5 * 60 * 1000, now = Date.now() } = {}) {
  const p = paths(switcherRoot), found = [];
  for (const dir of [p.root, p.manifests]) {
    try { await assertPlainPath(p.root, dir); } catch { continue; }
    for (const name of await fs.readdir(dir)) {
      if (!TEMP.test(name)) continue;
      const file = path.join(dir, name), stat = await lstatOrNull(file);
      if (stat?.isFile() && now - stat.mtimeMs > olderThan) found.push({ file, size: stat.size });
    }
  }
  return found;
}
async function removeStaleTemps(switcherRoot, options) {
  const removed = [];
  for (const t of await staleTemps(switcherRoot, options)) {
    await assertPlainPath(paths(switcherRoot).root, t.file);
    await fs.unlink(t.file).catch(e => { if (e.code !== 'ENOENT') throw e; });
    removed.push(t);
  }
  return removed;
}
// Retention: unpinned, committed manifests past the retention period go, except
// the newest one per session; then every object no manifest references.
// Archive retention (A5) on the capture catalog, per file:
// - the newest captured version is always kept until the user discards it;
// - a version no other version extends (diverged) is kept: it is pinned;
// - a version that is a byte prefix of a newer one still in the catalog is
//   dropped once it is older than retentionDays.
// Recipes referenced by a manifest stay regardless (removeUnreferencedRecipes).
async function applyCatalogRetention(switcherRoot, { retentionDays = 30, now = Date.now() } = {}) {
  const a = archiveOf(switcherRoot);
  if (!(await a.exists())) return [];
  const catalog = await a.readCatalog(), dropped = [], verified = new Map();
  for (const [key, list] of Object.entries(catalog.keys)) {
    if (!Array.isArray(list) || !list.length) { delete catalog.keys[key]; continue; }
    const newest = list.reduce((x, v) => (Date.parse(v.captured) || 0) > (Date.parse(x.captured) || 0) ? v : x, list[0]);
    const bySha = new Map(list.map(v => [v.sha256, v]));
    const gone = new Map();
    // Oldest first, so a superseding version dropped in this run still counts.
    const ordered = [...list].sort((x, y) => (Date.parse(x.captured) || 0) - (Date.parse(y.captured) || 0));
    const kept = new Set(list);
    for (const v of ordered) {
      if (v === newest || v.pinned || !v.supersededBy) continue;
      let target = v.supersededBy;
      for (let i = 0; i < list.length && gone.has(target); i++) target = gone.get(target);
      if (!bySha.has(target) || !kept.has(bySha.get(target))) continue;
      if (now - (Date.parse(v.captured) || now) <= retentionDays * DAY) continue;
      // The superseding version must rebuild before the prefix it covers goes.
      if (!verified.has(target)) verified.set(target, await a.verify(target, bySha.get(target).size));
      if (!verified.get(target)) continue;
      kept.delete(v);
      gone.set(v.sha256, v.supersededBy);
      dropped.push({ key, sha256: v.sha256, size: v.size });
    }
    catalog.keys[key] = list.filter(v => kept.has(v));
  }
  if (dropped.length) await a.writeCatalog(catalog);
  return dropped;
}
async function gc(switcherRoot, { retentionDays = 30, now = Date.now(), lock, tempAge, compact = false, minDeadRatio = 0.5, interrupt } = {}) {
  return withStoreLock(switcherRoot, 'garbage collection', async () => {
    const removedTemps = await removeStaleTemps(switcherRoot, { now, olderThan: tempAge });
    await assertStorePlain(switcherRoot);
    const archive = archiveOf(switcherRoot);
    // An interrupted compaction is finished or undone first (journaled).
    if (await archive.exists()) await archive.recoverCompaction();
    const { manifests, invalid } = await readManifests(switcherRoot);
    // The newest committed manifest per session is always kept.
    const newest = new Map();
    for (const m of manifests) if (m.state === 'committed' && m.sessionId && (!newest.has(m.sessionId) || Date.parse(m.created) > Date.parse(newest.get(m.sessionId).created))) newest.set(m.sessionId, m);
    const removedManifests = [], kept = [];
    for (const m of manifests) {
      const old = now - Date.parse(m.created) > retentionDays * DAY;
      // A transfer that stopped before committing leaves a 'prepared' manifest;
      // with no objects it records nothing worth keeping.
      const stuck = !m.pinned && m.state === 'prepared' && !(m.objects || []).length && old;
      const expired = stuck || (!m.pinned && m.state === 'committed' && newest.get(m.sessionId) !== m && old);
      if (expired) { await fs.unlink(m.file); removedManifests.push(m.id); } else kept.push(m);
    }
    // An unreadable manifest might reference anything: keep every object.
    const expiredVersions = invalid.length ? [] : await applyCatalogRetention(switcherRoot, { retentionDays, now });
    const removedObjects = invalid.length ? [] : [...await removeUnreferenced(switcherRoot, kept), ...await removeUnreferencedRecipes(switcherRoot, kept)];
    // Compaction only runs when asked for (after a confirmed cleanup or discard).
    const compaction = compact && !invalid.length && await archive.exists() ? await archive.compact({ minDeadRatio, interrupt }) : { compacted: [], freed: 0 };
    return { removedManifests, removedObjects, removedTemps, expiredVersions, compaction, freed: removedObjects.reduce((n, o) => n + o.size, 0) + compaction.freed, invalid };
  }, lock);
}
// Compacts the archive packs (journaled, under the store lock).
async function compactArchive(switcherRoot, { confirm, lock, minDeadRatio = 0.5, interrupt } = {}) {
  if (confirm !== true) throw new Error('Compacting the archive requires confirmation');
  return withStoreLock(switcherRoot, 'archive compaction', async () => {
    await assertStorePlain(switcherRoot);
    const archive = archiveOf(switcherRoot);
    if (!(await archive.exists())) return { compacted: [], freed: 0 };
    return archive.compact({ minDeadRatio, interrupt });
  }, lock);
}

// ---- Archive: import, capture, restore and export ----------------------------

async function legacyObjects(switcherRoot) {
  const dir = paths(switcherRoot).objects;
  await assertPlainPath(paths(switcherRoot).root, dir, { allowMissing: true });
  let names;
  try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const name of names.filter(n => SHA.test(n)).sort()) { const stat = await lstatOrNull(path.join(dir, name)); if (stat?.isFile()) out.push({ sha256: name, size: stat.size }); }
  return out;
}
// Moves every legacy whole-file object into the archive (A4), journaled in
// backups/archive/import.json: import, verify by rebuild, delete the object.
// A rerun after an interruption continues from the journal.
async function importObjects(switcherRoot, { confirm, lock, interrupt = async () => {} } = {}) {
  if (confirm !== true) throw new Error('Moving the recovery store into the archive requires confirmation');
  return withStoreLock(switcherRoot, 'archive import', async () => {
    await assertStorePlain(switcherRoot);
    const p = paths(switcherRoot), a = archiveOf(switcherRoot);
    await a.ensureDir(a.dir);
    const journalFile = path.join(p.archive, 'import.json');
    let journal = await a.readJson(journalFile);
    if (journal?.state !== 'running') {
      journal = { state: 'running', started: new Date().toISOString(), items: (await legacyObjects(switcherRoot)).map(o => ({ sha256: o.sha256, size: o.size, step: 'pending' })) };
      await a.writeDurable(journalFile, JSON.stringify(journal));
    }
    const save = async step => { await a.writeDurable(journalFile, JSON.stringify(journal)); await interrupt(step); };
    await interrupt('journal-written');
    const result = { imported: 0, deleted: 0, damaged: [] };
    for (const item of journal.items) {
      if (!SHA.test(String(item.sha256))) throw new Error('import.json names an invalid hash');
      const file = path.join(p.objects, item.sha256);
      if (item.step === 'pending') {
        if (!(await a.verify(item.sha256))) {
          await assertPlainPath(p.root, file);
          const data = await fs.readFile(file);
          if (digest(data) !== item.sha256) { item.step = 'damaged'; result.damaged.push(item.sha256); await save(`damaged:${item.sha256}`); continue; }
          await a.putVersions([{ data, sha256: item.sha256 }], { interrupt });
        }
        if (!(await a.verify(item.sha256))) throw new Error(`Object ${item.sha256} did not rebuild from the archive; it was kept`);
        item.step = 'imported';
        result.imported++;
        await save(`imported:${item.sha256}`);
      }
      if (item.step === 'imported') {
        // Verified by rebuild immediately before the object is deleted.
        if (!(await a.verify(item.sha256))) { item.step = 'pending'; await save(`reverted:${item.sha256}`); throw new Error(`Object ${item.sha256} did not rebuild from the archive; it was kept`); }
        if (await lstatOrNull(file)) { await assertPlainPath(p.root, file); await fs.unlink(file); }
        item.step = 'deleted';
        result.deleted++;
        await save(`deleted:${item.sha256}`);
      }
    }
    journal.state = 'committed';
    journal.finished = new Date().toISOString();
    await save('committed');
    return result;
  }, lock);
}

const LEFTOVER = /^(.+)\.(tmp|old)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Captures changed working copies into the archive (C1-C3). The enumeration
// only lists and stats; files are only ever read. Work runs in batches under
// the store lock, which is released between batches. When another window
// holds the lock, this run stops (busy) and the next scheduled run continues.
// Identities of the account files (credentials, settings, policy) in the
// given profile folders, plus extra files such as ~/.claude.json. A history
// file with one of these identities is a planted link: never carried or archived.
const ACCOUNT_FILE = /^(\.credentials\.json|\.claude\.json|settings.*\.json|policy-limits.*|remote-settings.*)$/i;
async function accountIdentities(directories, extraFiles = []) {
  const ids = new Set();
  const add = async file => { try { const s = await fs.lstat(file, { bigint: true }); if (s.isFile()) ids.add(`${s.dev}:${s.ino}`); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; } };
  for (const dir of directories) {
    let names = [];
    try { names = await fs.readdir(dir); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    for (const name of names.filter(n => ACCOUNT_FILE.test(n))) await add(path.join(dir, name));
  }
  for (const file of extraFiles) await add(file);
  return ids;
}
async function profileDirectories(switcherRoot) {
  const base = paths(switcherRoot).profiles, out = [];
  let names = [];
  try { names = await fs.readdir(base); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const n of names) if ((await lstatOrNull(path.join(base, n)))?.isDirectory()) out.push(path.join(base, n));
  return out;
}
// The working copies capture reads: private history folders of profiles
// without a pending transfer recovery, one entry per file identity (C1),
// never transfer leftovers and never an account file's identity.
async function captureCandidates(switcherRoot, profiles) {
  const files = [], seen = new Map(), skipped = [];
  const accounts = await accountIdentities([...await profileDirectories(switcherRoot), ...profiles.map(p => p.directory)]);
  for (const profile of profiles) {
    if (await lstatOrNull(path.join(profile.directory, '.profile-switch-lock'))) { skipped.push({ path: profile.directory, reason: 'transfer recovery pending (.profile-switch-lock)' }); continue; }
    for (const name of SHAREABLE) {
      if ((await folderStatus(profile.directory, name, switcherRoot)) !== 'private') continue;
      for (const f of (await walk(path.join(profile.directory, name))).files) {
        // Staged and moved-aside entries of a transfer are not working copies.
        if (f.rel.split(path.sep).some(part => LEFTOVER.test(part))) continue;
        if (accounts.has(f.id)) { skipped.push({ path: f.abs, reason: 'the same file as an account file (credentials or settings); never archived' }); continue; }
        // C1: one entry per file identity; linked names are captured once.
        if (seen.has(f.id)) { seen.get(f.id).names++; continue; }
        const record = { ...f, names: 1, profile: profile.id, root: profile.directory, key: fold(path.join(name, f.rel)) };
        seen.set(f.id, record);
        files.push(record);
      }
    }
  }
  return { files, seen, skipped };
}
const captureUnchanged = (f, entry) => !!entry && entry.size === f.size && entry.mtime === f.mtimeNs;
// Whether a complete capture has run since the last change to live history:
// the capture index records a completed run, and every working copy capture
// reads matches its entry (size and modification time).
async function captureStatus({ switcherRoot, profiles, maxBytes = 512 * 1024 * 1024 }) {
  const { files } = await captureCandidates(switcherRoot, profiles);
  const a = archiveOf(switcherRoot);
  const index = (await a.exists()) ? await a.readCaptureIndex() : { files: {} };
  const pending = files.filter(f => f.size <= maxBytes && !captureUnchanged(f, index.files[f.id]));
  return { current: !files.length || (!!index.completed && !pending.length), completed: index.completed || null, pending: pending.map(f => f.abs) };
}
async function assertCaptureCurrent(options) {
  const status = await captureStatus(options);
  if (!status.current) throw Object.assign(new Error(`Clean Redundant Backups needs a complete archive capture of your current history first (${status.completed ? `${plural(status.pending.length, 'file has', 'files have')} changed since the last one` : 'no complete capture has run yet'}). Choose Capture Now, or run Optimize Storage. The background capture runs every 30 minutes, and it can complete only while Claude is stopped or idle in every window. Nothing was deleted.`), { code: 'ENOTCAPTURED', status });
  return status;
}
async function capture({ switcherRoot, profiles, batchFiles = 200, batchMs = 5000, maxBytes = 512 * 1024 * 1024, lock = { wait: 2000 }, signal, onBatch, between = async () => {}, interrupt, now = () => Date.now() }) {
  const { files, seen, skipped } = await captureCandidates(switcherRoot, profiles);
  const a = archiveOf(switcherRoot);
  let index = await a.readCaptureIndex().catch(() => ({ version: 1, files: {} }));
  const unchanged = captureUnchanged;
  const queue = files.filter(f => !unchanged(f, index.files[f.id]));
  const result = { scanned: files.length, changed: queue.length, captured: 0, versions: 0, bytes: 0, batches: 0, skipped, busy: false, cancelled: false, complete: false };
  while (queue.length) {
    if (signal?.aborted) { result.cancelled = true; break; }
    let release;
    try { release = await acquireStoreLock(switcherRoot, 'archive capture', lock); }
    catch (e) { if (e.code === 'ESTORELOCKED') { result.busy = true; break; } throw e; }
    try {
      await assertStorePlain(switcherRoot);
      // Reloaded under the lock: another window may have captured meanwhile.
      const catalog = await a.readCatalog();
      index = await a.readCaptureIndex();
      const writer = await a.beginWrite({ interrupt });
      try {
        const deadline = Date.now() + batchMs;
        for (let n = 0; queue.length && n < batchFiles && Date.now() < deadline; n++) await captureOne(queue.shift(), { a, writer, catalog, index, result, maxBytes, now });
        await writer.commit();
      } finally { await writer.close(); }
      // Write order: recipes are flushed; the catalog (the reference) follows.
      await a.writeCatalog(catalog);
      await a.writeCaptureIndex(index);
    } finally { await release(); }
    result.batches++;
    onBatch?.({ done: files.length - queue.length, total: files.length, ...result });
    await between(result);
  }
  if (!queue.length && !result.busy && !result.cancelled) {
    result.complete = true;
    // Entries for files that no longer exist are dropped from the capture index.
    const release = await acquireStoreLock(switcherRoot, 'archive capture', lock).catch(() => null);
    if (release) {
      try {
        if (await a.exists()) {
          const current = await a.readCaptureIndex();
          const stale = Object.keys(current.files).filter(id => !seen.has(id));
          for (const id of stale) delete current.files[id];
          // The marker Clean Redundant Backups checks (with every file's entry).
          current.completed = new Date(now()).toISOString();
          await a.writeCaptureIndex(current);
        }
      } finally { await release(); }
    }
  }
  return result;
}
async function captureOne(f, { a, writer, catalog, index, result, maxBytes, now }) {
  let stat;
  try { stat = await fs.lstat(f.abs, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!stat.isFile() || `${stat.dev}:${stat.ino}` !== f.id) return;
  const entry = index.files[f.id];
  if (entry && entry.size === Number(stat.size) && entry.mtime === String(stat.mtimeNs)) return;
  if (Number(stat.size) > maxBytes) { result.skipped.push({ path: f.abs, reason: 'larger than the capture limit' }); return; }
  await assertPlainPath(f.root, f.abs);
  const data = await fs.readFile(f.abs);
  const after = await fs.lstat(f.abs, { bigint: true }).catch(() => null);
  // A file written while it was read is archived as read, but stays marked as
  // changed so the next capture supersedes it (for example a partial last line).
  const stable = !!after && after.size === stat.size && after.mtimeNs === stat.mtimeNs && Number(after.size) === data.length;
  const sha = digest(data);
  const list = catalog.keys[f.key] ||= [];
  let version = list.find(v => v.sha256 === sha);
  if (!version) {
    let base = null;
    for (const head of list.filter(v => !v.supersededBy)) {
      if (head.size <= data.length && digest(data.subarray(0, head.size)) === head.sha256) { head.supersededBy = sha; base = head.sha256; }
    }
    base ||= entry?.sha256 || list[list.length - 1]?.sha256 || null;
    await writer.put({ data, sha256: sha, name: f.abs, base });
    version = { sha256: sha, size: data.length, captured: new Date(now()).toISOString(), profiles: [] };
    list.push(version);
    result.versions++;
    result.bytes += data.length;
  }
  version.lastSeen = new Date(now()).toISOString();
  if (!version.profiles.includes(f.profile)) version.profiles.push(f.profile);
  if (stable) index.files[f.id] = { size: data.length, mtime: String(stat.mtimeNs), sha256: sha, key: f.key };
  result.captured++;
}
// Every archived version, grouped by file: captured versions (catalog) and
// versions recorded in backup manifests.
async function archivedVersions(switcherRoot) {
  await assertStorePlain(switcherRoot);
  const a = archiveOf(switcherRoot), out = new Map();
  const add = (key, v) => { if (!out.has(key)) out.set(key, []); const list = out.get(key); const found = list.find(x => x.sha256 === v.sha256); if (found) Object.assign(found, { manifests: [...found.manifests, ...v.manifests], pinned: found.pinned || v.pinned }); else list.push(v); };
  if (await a.exists()) for (const [key, list] of Object.entries((await a.readCatalog()).keys)) for (const v of list) add(key, { key, sha256: v.sha256, size: v.size, time: v.captured, captured: true, superseded: !!v.supersededBy, pinned: !v.supersededBy, manifests: [] });
  const { manifests } = await readManifests(switcherRoot);
  for (const m of manifests) for (const o of m.objects || []) if (SHA.test(String(o.sha256))) add(fold(String(o.name || o.sha256)), { key: fold(String(o.name || o.sha256)), sha256: o.sha256, size: o.size, time: m.created, captured: false, superseded: false, pinned: !!m.pinned, manifests: [m.id] });
  return [...out].map(([key, versions]) => ({ key, versions: versions.sort((x, y) => (Date.parse(y.time) || 0) - (Date.parse(x.time) || 0)) })).sort((x, y) => x.key.localeCompare(y.key));
}
// Removes captured versions from the catalog (the user's discard, A5).
async function discardVersions(switcherRoot, items, { confirm, lock } = {}) {
  if (confirm !== true) throw new Error('Discarding archived versions requires confirmation');
  await withStoreLock(switcherRoot, 'discard archived versions', async () => {
    const a = archiveOf(switcherRoot);
    if (!(await a.exists())) return;
    const catalog = await a.readCatalog();
    for (const { key, sha256 } of items) if (catalog.keys[key]) catalog.keys[key] = catalog.keys[key].filter(v => v.sha256 !== sha256);
    await a.writeCatalog(catalog);
  }, lock);
  return gc(switcherRoot, { retentionDays: Infinity, lock });
}
// What remains of a version after the user discarded it: whether the archive
// can still rebuild it, which backups (manifests) still keep it, and which
// profiles still have this file in their history (capture would archive it
// again). Read-only.
async function discardOutcome(switcherRoot, { key, sha256, size, profiles = [] }) {
  const { manifests } = await readManifests(switcherRoot);
  const keptBy = manifests.filter(m => (m.objects || []).some(o => o.sha256 === sha256)).map(m => ({ id: m.id, label: backupLabel(m), pinned: !!m.pinned }));
  const inArchive = await objectValid(switcherRoot, sha256).catch(() => false);
  // Its content may still be the start of a newer archived version of the same file.
  const a = archiveOf(switcherRoot);
  const catalog = (await a.exists()) ? await a.readCatalog() : { keys: {} };
  const inNewer = !inArchive && Number.isSafeInteger(size) && await insideNewer(switcherRoot, { sha256, size }, catalog.keys[fold(String(key || ''))] || []);
  const presentIn = [];
  const parts = String(key || '').split(/[\\/]/);
  if (SHAREABLE.includes(parts[0]) && !parts.some(x => !x || x === '..' || x === '.')) {
    for (const p of profiles) { const s = await lstatOrNull(path.join(p.directory, ...parts)); if (s?.isFile()) presentIn.push(p.name); }
  }
  return { inArchive, inNewer, keptBy, presentIn };
}
// Restore or Export (A6): rebuild into a temp file next to the target, verify
// its SHA-256, rename it in. An existing target is never replaced by a
// different version; an identical one is left as it is.
async function exportVersion(switcherRoot, sha256, target, { root, lock } = {}) {
  if (!SHA.test(String(sha256))) throw new Error('Invalid version hash');
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('The export target must be an absolute path');
  const bound = root || path.dirname(target);
  await assertPlainPath(bound, target, { allowMissing: true });
  return withStoreLock(switcherRoot, 'restore or export', async () => {
    await assertStorePlain(switcherRoot);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await assertPlainPath(bound, path.dirname(target));
    await assertPlainPath(bound, target, { allowMissing: true });
    const a = archiveOf(switcherRoot);
    if (await a.hasRecipe(sha256)) return a.exportTo(sha256, target);
    // Not imported yet: the legacy object, under the same rules.
    const data = await readObject(switcherRoot, sha256);
    const existing = await lstatOrNull(target);
    if (existing) {
      if (existing.isFile() && (await hashFile(target)).sha256 === sha256) return { written: false, identical: true, target };
      throw Object.assign(new Error(`${target} already holds a different version. Nothing was overwritten; export to another location instead.`), { code: 'EEXIST' });
    }
    const temp = `${target}.tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 });
      if ((await hashFile(temp)).sha256 !== sha256) throw new Error('The exported file did not verify');
      // Never a rename over the target: a link (or exclusive copy) refuses one that appeared.
      await archiveLib.placeNew(temp, target);
    } catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
    return { written: true, identical: false, target };
  }, lock);
}
// Restores a version into a profile's history folder (missing file only).
async function restoreVersion(switcherRoot, sha256, { directory, rel, lock } = {}) {
  const parts = String(rel || '').split(/[\\/]/);
  if (!SHAREABLE.includes(parts[0]) || parts.length < 2 || parts.some(x => !x || x === '..' || x === '.')) throw new Error('A version can only be restored into projects, file-history or image-cache');
  return exportVersion(switcherRoot, sha256, path.join(path.resolve(directory), ...parts), { root: path.resolve(directory), lock });
}
// Show Backup: exports what a transfer manifest kept into exports/<id>/.
async function exportManifest(switcherRoot, manifestFile, { lock } = {}) {
  const id = path.basename(String(manifestFile)).replace(/\.json$/, '');
  const file = manifestPath(switcherRoot, id);
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  const folder = path.join(paths(switcherRoot).exports, id), written = [];
  for (const o of manifest.objects || []) {
    if (!SHA.test(String(o.sha256))) continue;
    const parts = String(o.name || o.sha256).split(/[\\/]/).filter(x => x && x !== '.' && x !== '..');
    const target = path.join(folder, ...(parts.length ? parts : [o.sha256]));
    written.push(await exportVersion(switcherRoot, o.sha256, target, { root: paths(switcherRoot).root, lock }));
  }
  return { folder, manifest: file, files: written };
}
async function discardManifests(switcherRoot, ids, { confirm, lock } = {}) {
  if (confirm !== true) throw new Error('Discarding pinned backups requires confirmation');
  await withStoreLock(switcherRoot, 'discard backups', async () => {
    for (const id of ids) await fs.unlink(manifestPath(switcherRoot, id)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }, lock);
  return gc(switcherRoot, { retentionDays: Infinity, lock });
}

// ---- Process detection -----------------------------------------------------

function listProcesses() {
  return new Promise((resolve, reject) => {
    // The command text must not contain the word we search for, or the query
    // would find itself.
    const done = (error, out, parse) => { if (error) return reject(error); try { resolve(parse(out)); } catch (e) { reject(e); } };
    // Full path: a powershell.exe earlier on PATH must not run instead.
    if (WIN) execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
      (error, out) => done(error, out, text => [].concat(JSON.parse(text)).map(r => ({ pid: r.ProcessId, name: r.Name || '', command: r.CommandLine || '' }))));
    else execFile('ps', ['-axo', 'pid=,comm=,args='], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
      (error, out) => done(error, out, text => text.split('\n').map(line => line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/)).filter(Boolean).map(m => ({ pid: Number(m[1]), name: m[2], command: m[3] }))));
  });
}
function isClaudeProcess({ name, command }) {
  const base = path.basename(String(name || '')).toLowerCase();
  if (base === 'claude' || base === 'claude.exe') return true;
  if (!/^node(\.exe)?$/.test(base)) return false;
  return /@anthropic-ai[\\/]claude-code/i.test(command || '') || /(^|[\s"'\\/])claude(\.exe|\.cmd|\.js|\.mjs)?(?=["'\s]|$)/i.test(command || '');
}
// Node processes whose command line cannot be read (often another user's or an
// elevated process) are returned as unverified: reported, but not a refusal.
async function detectClaudeProcesses({ list = listProcesses, self = process.pid } = {}) {
  // Command lines may hold secrets: classify, then keep only the PID and name.
  return (await list()).filter(row => row.pid !== self).flatMap(row => isClaudeProcess(row) ? [{ pid: row.pid, name: row.name }]
    : /^node(\.exe)?$/i.test(path.basename(String(row.name || ''))) && !row.command ? [{ pid: row.pid, name: row.name, unverified: true }] : []);
}
async function livePids(directory, alive = processAlive) {
  let names;
  try { names = await fs.readdir(path.join(directory, 'sessions')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => /^[1-9][0-9]*\.json$/.test(n)).map(n => Number(n.slice(0, -5))).filter(pid => alive(pid));
}
// One wording for every refusal that needs Claude stopped: what to do, then what was found.
function stopClaudeMessage(found, note = '') {
  return `Stop Claude first: close the Claude chat panels in all VS Code windows and exit claude in every terminal, then try again. Still running: ${found.join('; ')}.${note} Nothing was changed.`;
}
// Migration and rollback rename folders Claude writes into, and Claude does not
// hold them open, so any running Claude anywhere is a refusal.
async function assertClaudeStopped(profiles, { detect = detectClaudeProcesses, alive = processAlive } = {}) {
  const found = [];
  for (const profile of profiles) for (const pid of await livePids(profile.directory, alive)) found.push(`${profile.name || 'a profile'}: Claude PID ${pid}`);
  let running;
  try { running = await detect(); } catch (e) { throw new Error(`Could not confirm that Claude is stopped (${e.message}). Nothing was changed.`); }
  for (const row of running.filter(row => !row.unverified)) found.push(`${row.name} PID ${row.pid}`);
  const unverified = running.filter(row => row.unverified).map(row => `${row.name} PID ${row.pid}`);
  const note = unverified.length ? ` Also running, command line unreadable (not checked): ${unverified.join(', ')}.` : '';
  if (found.length) throw Object.assign(new Error(stopClaudeMessage(found, note)), { processes: found, unverified });
}

// ---- Scanning and analysis -------------------------------------------------

// Lists regular files without following links; links are reported separately.
// The starting folder is checked too: a link there is reported, not read,
// unless the caller already verified it (followStart, for managed junctions).
async function walk(dir, base = '', out = { files: [], links: [] }, followStart = false) {
  if (!base && !followStart) {
    const start = await lstatOrNull(dir);
    if (!start) return out;
    if (start.isSymbolicLink()) { out.links.push(dir); return out; }
    if (!start.isDirectory()) return out;
  }
  let entries;
  try { entries = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const name of entries.sort()) {
    const abs = path.join(dir, name), rel = base ? path.join(base, name) : name;
    // bigint: the file identity (dev:ino) is exact, so hard-linked names are
    // recognized as one file (accounting, capture).
    const stat = await fs.lstat(abs, { bigint: true });
    if (stat.isSymbolicLink()) out.links.push(abs);
    else if (stat.isDirectory()) await walk(abs, rel, out);
    else if (stat.isFile()) out.files.push({ abs, rel, size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), mtimeNs: String(stat.mtimeNs), id: `${stat.dev}:${stat.ino}`, nlink: Number(stat.nlink) });
  }
  return out;
}
async function readCleanupPeriod(directory) {
  try {
    const file = path.join(directory, 'settings.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return { days: 30, source: 'default' };
    const value = JSON.parse(await fs.readFile(file, 'utf8')).cleanupPeriodDays;
    return Number.isFinite(value) ? { days: value, source: 'settings.json' } : { days: 30, source: 'default' };
  } catch { return { days: 30, source: 'default' }; }
}
// cleanupPeriodDays set outside the profiles: managed (organisation) settings
// apply to every profile, project settings to every profile used in that
// project. Reported by Analyze; the archive keeps the newest version anyway.
async function readCleanupOverrides({ managed = [], projects = [] } = {}) {
  const found = [];
  const read = async (file, kind) => {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return;
      const value = JSON.parse(await fs.readFile(file, 'utf8')).cleanupPeriodDays;
      if (Number.isFinite(value)) found.push({ kind, source: file, days: value });
    } catch { /* Missing or unreadable: not set. */ }
  };
  for (const file of managed) await read(file, 'managed');
  for (const dir of projects) for (const name of ['settings.json', 'settings.local.json']) await read(path.join(dir, '.claude', name), 'project');
  return found;
}
async function snapshotState(snapshot) {
  const stat = await lstatOrNull(path.join(snapshot, 'manifest.json'));
  if (!stat?.isFile()) return stat ? 'not a plain file' : 'none';
  try { return JSON.parse(await fs.readFile(path.join(snapshot, 'manifest.json'), 'utf8')).state || 'unknown'; } catch { return 'none'; }
}
// Which backup records Clean Redundant Backups may consider. Cleanup, analyze
// and measure all use this, so the reclaimable figure and the preview agree.
// Returns null when eligible, otherwise the reason it is skipped.
function cleanupSkipReason(record, profileLocked) {
  if (record.kind !== 'preserved' && record.kind !== 'backup') return 'not a backup';
  if (profileLocked) return 'transfer recovery pending (.profile-switch-lock)';
  if (record.kind === 'backup' && record.snapshotState === 'none') return 'snapshot has no manifest: removable only after you confirm this snapshot, and only once every file rebuilds from the archive';
  if (record.kind === 'backup' && record.snapshotState !== 'committed') return `snapshot manifest is ${record.snapshotState}`;
  return null;
}
// Net saving: bytes deleted minus the content moved into the recovery store,
// counted once per distinct content (the store keeps one copy).
function netSaving(deletedBytes, moved) {
  const kept = new Map();
  for (const m of moved) kept.set(m.sha256, m.size);
  return deletedBytes - [...kept.values()].reduce((n, size) => n + size, 0);
}
// Collects every history file a profile holds: live folders, preserved
// pre-shared folders and old .profile-switch-backups snapshots.
async function collect(profile, switcherRoot) {
  const records = [], links = [], folders = {};
  for (const name of SHAREABLE) {
    folders[name] = await folderStatus(profile.directory, name, switcherRoot);
    if (folders[name] === 'private') {
      const found = await walk(path.join(profile.directory, name));
      links.push(...found.links);
      for (const f of found.files) records.push({ ...f, profile: profile.id, root: profile.directory, kind: 'live', rel: path.join(name, f.rel), folder: name });
    } else if (folders[name] === 'foreign-link') links.push(path.join(profile.directory, name));
  }
  let names = [];
  try { names = await fs.readdir(profile.directory); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Links are never entered: walk() reports a linked starting folder, and the
  // backup folders are checked here, so Analyze and Preview list them.
  for (const entry of names.filter(n => PRESERVED.test(n))) {
    const name = entry.match(PRESERVED)[1];
    const found = await walk(path.join(profile.directory, entry));
    links.push(...found.links);
    for (const f of found.files) records.push({ ...f, profile: profile.id, root: profile.directory, kind: 'preserved', rel: path.join(name, f.rel), container: path.join(profile.directory, entry) });
  }
  const backups = path.join(profile.directory, '.profile-switch-backups');
  const backupsStat = await lstatOrNull(backups);
  let snapshots = [];
  if (backupsStat?.isSymbolicLink()) links.push(backups);
  else if (backupsStat?.isDirectory()) snapshots = await fs.readdir(backups);
  for (const snap of snapshots.sort()) {
    const dir = path.join(backups, snap), stat = await lstatOrNull(dir);
    if (stat?.isSymbolicLink()) { links.push(dir); continue; }
    if (!stat?.isDirectory()) continue;
    const state = await snapshotState(dir);
    for (const part of ['incoming', 'previous', 'stage']) {
      const found = await walk(path.join(dir, part));
      links.push(...found.links);
      for (const f of found.files) records.push({ ...f, profile: profile.id, root: profile.directory, kind: 'backup', part, rel: f.rel, container: dir, snapshotState: state });
    }
  }
  return { records, links, folders };
}
// Groups versions of one relative path. Transcripts are append-only, so a
// version that is a byte prefix of a longer one holds nothing extra.
async function groupVersions(records, isCandidate, signal) {
  const groups = new Map();
  for (const r of records) {
    const key = fold(r.rel);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const result = [];
  for (const [key, list] of groups) {
    const versions = new Map();
    for (const r of list) {
      if (!versions.has(r.sha256)) versions.set(r.sha256, { sha256: r.sha256, size: r.size, records: [], mtimeMs: 0 });
      const v = versions.get(r.sha256);
      v.records.push(r);
      v.mtimeMs = Math.max(v.mtimeMs, r.mtimeMs);
    }
    const all = [...versions.values()];
    const jsonl = isJsonl(key);
    let candidates = all.filter(v => v.records.some(isCandidate));
    const live = candidates.length > 0;
    if (!live) candidates = [all.reduce((a, b) => (b.size > a.size ? b : a))];
    for (const c of candidates) {
      checkCancelled(signal);
      c.covers = new Set([c.sha256]);
      if (!jsonl) continue;
      const smaller = all.filter(v => v !== c && v.size <= c.size);
      if (!smaller.length) continue;
      const { prefixHashes } = await hashFile(c.records[0].abs, { prefixes: smaller.map(v => v.size) });
      for (const v of smaller) if (prefixHashes[v.size] === v.sha256) c.covers.add(v.sha256);
    }
    // Canonical: the longest byte-prefix chain, then size, then newest.
    // Ties prefer the version already in shared/, so joining an existing pool does not replace it.
    const inShared = v => v.records.some(r => r.kind === 'shared') ? 1 : 0;
    const rank = v => [v.covers.size, v.size, inShared(v), v.mtimeMs];
    const better = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
    const canonical = candidates.reduce((a, b) => better(b, a) ? b : a);
    const coveredByAny = new Set(candidates.flatMap(c => [...c.covers].filter(s => s !== c.sha256)));
    const unique = all.filter(v => v === canonical || !coveredByAny.has(v.sha256));
    // Exact or (transcripts) prefix matches of live content: the cleanup rule.
    const coveredByLive = live ? new Set(candidates.flatMap(c => [...c.covers])) : new Set();
    const classification = all.length === 1 ? (list.length > 1 ? 'identical' : 'single') : all.every(v => canonical.covers.has(v.sha256)) ? 'prefix' : 'diverged';
    result.push({ key, rel: canonical.records.find(isCandidate)?.rel || canonical.records[0].rel, live, classification, canonical, versions: all, unique, coveredByLive, records: list });
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}
// Cancelling is checked between files; analysis writes nothing, so stopping
// early leaves nothing behind.
function checkCancelled(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Analysis cancelled. Nothing was changed.'), { code: 'ABORT_ERR', cancelled: true });
}
async function hashRecords(records, { signal, onProgress } = {}) {
  let done = 0;
  for (const r of records) {
    checkCancelled(signal);
    if (done % 25 === 0) onProgress?.({ done, total: records.length });
    done++;
    const h = await hashFile(r.abs);
    Object.assign(r, { sha256: h.sha256, size: h.size, truncated: isJsonl(r.rel) && h.truncated, tailParses: h.tailParses });
  }
}
// Bytes of the recovery store: legacy objects plus the whole archive (packs,
// index, recipes, catalog and capture index).
// Accounting: every size counts each file identity (bigint dev:ino) once.
function identityBytes(records) {
  const seen = new Set();
  let n = 0;
  for (const r of records) { const id = r.id || r.abs; if (seen.has(id)) continue; seen.add(id); n += r.size; }
  return n;
}
// Bytes that Link Identical Conversations would save: live transcripts with the
// same path and content but different identities become one file. An identity
// counts only when all its names are in the scan (nlink), as in linking.planLinks.
function linkSaving(records, lockedProfiles = new Set()) {
  const ids = new Map();
  for (const r of records) {
    if (r.kind !== 'live' || !r.id || !r.sha256 || !isLinkable(r.rel)) continue;
    if (!ids.has(r.id)) ids.set(r.id, { size: r.size, nlink: r.nlink || 1, names: 0, mtimeMs: r.mtimeMs, locked: false, key: `${fold(r.rel)}|${r.sha256}` });
    ids.get(r.id).names++;
    // As in planLinks: a name in a profile with a pending transfer recovery is never replaced.
    if (lockedProfiles.has(r.profile)) ids.get(r.id).locked = true;
  }
  const groups = new Map();
  for (const x of ids.values()) { if (!groups.has(x.key)) groups.set(x.key, []); groups.get(x.key).push(x); }
  let saved = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keeper = list.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    if (keeper.nlink > keeper.names || keeper.locked) continue;
    for (const x of list) if (x !== keeper && x.nlink <= x.names && !x.locked) saved += x.size;
  }
  return saved;
}
// Files with more names (hard links) than the scan found: counted once, and marked.
function externalNames(records) {
  const names = new Map();
  for (const r of records) if (r.id) names.set(r.id, { count: (names.get(r.id)?.count || 0) + 1, nlink: r.nlink || 1, abs: r.abs });
  return [...names.values()].filter(x => x.nlink > x.count).map(x => x.abs);
}
async function sumObjects(switcherRoot) {
  const found = await walk(paths(switcherRoot).objects);
  const archive = await walk(paths(switcherRoot).archive);
  return found.files.reduce((n, f) => n + f.size, 0) + archive.files.reduce((n, f) => n + f.size, 0);
}
// Read-only. `selected` (profile ids) adds a migration plan for those profiles.
async function analyze({ switcherRoot, profiles, selected = [], detect = detectClaudeProcesses, alive = processAlive, processes = true, signal, onProgress, cleanupSources }) {
  const p = paths(switcherRoot);
  archiveOf(switcherRoot).startRun();
  const records = [], links = [], perProfile = [];
  for (const profile of profiles) {
    checkCancelled(signal);
    const found = await collect(profile, switcherRoot);
    records.push(...found.records);
    links.push(...found.links);
    perProfile.push({ id: profile.id, name: profile.name, directory: profile.directory, builtin: !!profile.builtin, folders: found.folders, cleanup: await readCleanupPeriod(profile.directory), pids: processes ? await livePids(profile.directory, alive) : [], locked: !!(await lstatOrNull(path.join(profile.directory, '.profile-switch-lock'))) });
  }
  for (const name of SHAREABLE) {
    const found = await walk(path.join(p.shared, name));
    links.push(...found.links);
    for (const f of found.files) records.push({ ...f, profile: null, kind: 'shared', rel: path.join(name, f.rel), folder: name });
  }
  await hashRecords(records, { signal, onProgress });
  onProgress?.({ done: records.length, total: records.length });
  const groups = await groupVersions(records, r => r.kind === 'live' || r.kind === 'shared', signal);
  const bytes = kinds => identityBytes(records.filter(r => kinds.includes(r.kind)));
  const objectBytes = await sumObjects(switcherRoot);
  // Reclaimable space is what Clean Redundant Backups frees, with conversations
  // kept private per profile: every backup copy whose content is in live history
  // (this profile's or another's), and all but one copy of content found only
  // in backups (that one copy moves into the recovery store).
  const lockedIds = new Set(perProfile.filter(x => x.locked).map(x => x.id));
  const eligible = r => !cleanupSkipReason(r, lockedIds.has(r.profile));
  // As in cleanup: only live files capture archives count as covering a backup
  // (not those over the capture limit or in a profile with a pending recovery).
  const capturable = r => r.kind === 'shared' || (r.kind === 'live' && !lockedIds.has(r.profile) && r.size <= CAPTURE_LIMIT);
  const coverGroups = records.some(r => r.kind === 'live' && !capturable(r)) ? await groupVersions(records, capturable, signal) : groups;
  let eligibleBytes = 0;
  const moved = [];
  for (const g of coverGroups) for (const v of g.versions) {
    const copies = v.records.filter(eligible);
    if (!copies.length) continue;
    eligibleBytes += copies.length * v.size;
    // Content kept in live history needs no move. Content whose object is already
    // in the store (referenced or not) adds no bytes; cleanup records it in its
    // manifest. So this counts exactly the bytes cleanup adds to the store.
    if (!g.coveredByLive.has(v.sha256) && !(await objectPresent(switcherRoot, v.sha256, v.size).catch(() => false))) moved.push({ sha256: v.sha256, size: v.size });
  }
  const { invalid: unreadable } = await readManifests(switcherRoot).catch(() => ({ invalid: [{ file: paths(switcherRoot).manifests }] }));
  // Blocked, not a number: the real cleanup refuses while a manifest is unreadable.
  const reclaimable = unreadable.length ? null : netSaving(eligibleBytes, moved);
  // Extra copies only: hard-linked names of one file are not copies.
  const duplicate = groups.reduce((n, g) => n + g.versions.reduce((m, v) => m + (new Set(v.records.map(r => r.id || r.abs)).size - 1) * v.size, 0), 0);
  const metrics = { total: bytes(['live', 'shared', 'preserved', 'backup']) + objectBytes, shared: bytes(['shared']), profile: bytes(['live']), backup: bytes(['preserved', 'backup']) + objectBytes, archive: objectBytes, duplicate, reclaimable, reclaimableBlocked: unreadable.map(x => x.file), externalNames: externalNames(records), linkSaving: linkSaving(records, lockedIds) };
  metrics.afterLinking = metrics.profile - metrics.linkSaving;
  let running = [], processError = null;
  if (processes) { try { running = await detect(); } catch (e) { processError = e.message; } }
  const analysis = {
    created: new Date().toISOString(), switcherRoot: p.root, metrics, profiles: perProfile, links,
    groups: groups.map(g => ({ key: g.key, rel: g.rel, classification: g.classification, live: g.live, versions: g.versions.map(v => ({ sha256: v.sha256, size: v.size, locations: v.records.map(r => r.abs) })) })),
    duplicateFiles: groups.filter(g => g.records.length > 1).length,
    diverged: groups.filter(g => g.classification === 'diverged').map(g => ({ rel: g.rel, versions: g.versions.length })),
    truncated: records.filter(r => r.truncated).map(r => ({ abs: r.abs, rel: r.rel, parses: r.tailParses })),
    running, processError, cleanupOverrides: await readCleanupOverrides(cleanupSources)
  };
  if (selected.length) analysis.plan = await planMigration(records, perProfile.filter(x => selected.includes(x.id)), signal);
  return analysis;
}
async function planMigration(records, chosen, signal) {
  const ids = new Set(chosen.map(x => x.id));
  const mine = records.filter(r => r.kind === 'shared' || (r.kind === 'live' && ids.has(r.profile)));
  const groups = await groupVersions(mine, () => true, signal);
  const files = [], diverged = [];
  for (const g of groups) {
    const source = g.canonical.records.find(r => r.kind === 'live') || g.canonical.records[0];
    const shared = g.records.find(r => r.kind === 'shared');
    if (!(shared && shared.sha256 === g.canonical.sha256)) files.push({ rel: g.rel, sha256: g.canonical.sha256, size: g.canonical.size, source: source.abs, replaces: shared?.sha256 || null });
    for (const v of g.versions) if (!g.canonical.covers.has(v.sha256)) diverged.push({ rel: g.rel, sha256: v.sha256, size: v.size, source: v.records[0].abs, locations: v.records.map(r => r.abs) });
  }
  const profiles = chosen.map(x => ({ id: x.id, name: x.name, directory: x.directory, folders: SHAREABLE.map(name => ({ name, status: x.folders[name], files: Object.fromEntries(mine.filter(r => r.profile === x.id && r.folder === name).map(r => [path.relative(name, r.rel), r.sha256])) })) }));
  const problems = [];
  for (const x of chosen) {
    if (x.builtin) problems.push(`${x.name} is the Default profile, which cannot join shared storage in this version.`);
    for (const name of SHAREABLE) {
      if (x.folders[name] === 'foreign-link') problems.push(`In ${x.name}, the ${name} folder is a link to another location. Only private folders can be moved into shared storage.`);
      else if (x.folders[name] === 'other') problems.push(`In ${x.name}, ${name} is not a folder. Only private folders can be moved into shared storage.`);
    }
    if (x.locked) problems.push(`${x.name} has an unfinished switch that needs recovery first (.profile-switch-lock).`);
  }
  return { files, diverged, profiles, problems, bytes: files.reduce((n, f) => n + f.size, 0) };
}
// Size-only scan for the Manage Storage overview; duplicates are estimated by
// name and size (exact numbers come from Analyze).
async function measure({ switcherRoot, profiles }) {
  const p = paths(switcherRoot), records = [];
  for (const profile of profiles) {
    const locked = !!(await lstatOrNull(path.join(profile.directory, '.profile-switch-lock')));
    for (const r of (await collect(profile, switcherRoot)).records) records.push({ ...r, locked });
  }
  for (const name of SHAREABLE) for (const f of (await walk(path.join(p.shared, name))).files) records.push({ ...f, kind: 'shared', rel: path.join(name, f.rel) });
  const bytes = kinds => identityBytes(records.filter(r => kinds.includes(r.kind)));
  const objectBytes = await sumObjects(switcherRoot);
  const groups = new Map();
  for (const r of records) { const k = fold(r.rel); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  let duplicate = 0, reclaimable = 0;
  for (const list of groups.values()) {
    const sizes = new Map();
    for (const r of list) { if (!sizes.has(r.size)) sizes.set(r.size, new Set()); sizes.get(r.size).add(r.id || r.abs); }
    for (const [size, ids] of sizes) duplicate += (ids.size - 1) * size;
    // Estimate by size: a backup copy no larger than a live copy of the same
    // path is taken as covered; otherwise one copy per size is kept.
    const backups = list.filter(r => !cleanupSkipReason(r, r.locked));
    const liveMax = Math.max(-1, ...list.filter(r => r.kind === 'live' || r.kind === 'shared').map(r => r.size));
    const uncovered = new Set();
    for (const r of backups) {
      if (r.size <= liveMax || uncovered.has(r.size)) reclaimable += r.size;
      else uncovered.add(r.size);
    }
  }
  const { invalid: unreadable } = await readManifests(switcherRoot).catch(() => ({ invalid: [{ file: paths(switcherRoot).manifests }] }));
  return { estimated: true, total: bytes(['live', 'shared', 'preserved', 'backup']) + objectBytes, shared: bytes(['shared']), profile: bytes(['live']), backup: bytes(['preserved', 'backup']) + objectBytes, archive: objectBytes, duplicate, externalNames: externalNames(records), reclaimable: unreadable.length ? null : reclaimable, reclaimableBlocked: unreadable.map(x => x.file) };
}

// ---- Reports ---------------------------------------------------------------

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(2) : n} ${units[i]}`;
}
// Metric names and meanings, shared by the Manage Storage quick pick and the reports.
const METRICS = [
  { key: 'total', label: 'Total', description: 'All conversation history and backups for these profiles' },
  { key: 'shared', label: 'Shared storage', description: 'History in shared storage from an earlier migration (none when conversations are private)' },
  { key: 'profile', label: 'Private history', description: "Conversation history in each profile's own folders" },
  { key: 'backup', label: 'Backups', description: 'Old switch backups, preserved pre-shared folders and the archive' },
  { key: 'archive', label: 'Archive', description: 'The compressed archive of conversation versions (and the old recovery store, until it is moved in); included in Backups' },
  { key: 'duplicate', label: 'Duplicate copies', description: 'Extra copies of files that are identical to another copy' },
  { key: 'reclaimable', label: 'Reclaimable space', description: 'Space that Clean Redundant Backups could free: backup copies whose content is kept elsewhere' }
];
const FOLDER_STATES = { private: 'private folder', linked: 'shared', missing: 'not created yet', 'foreign-link': 'link to another location', other: 'not a folder' };
const folderLabel = status => FOLDER_STATES[status] || status;
const BACKUP_KINDS = { cleanup: 'Cleanup backup', migration: 'Migration backup', rollback: 'Rollback backup', transfer: 'Switch backup' };
const backupLabel = manifest => `${BACKUP_KINDS[manifest.kind] || 'Backup'}, ${localTime(manifest.created)}`;
// A metric value for display: 'blocked' when cleanup cannot run.
const metricValue = (metrics, key) => metrics[key] === null && key === 'reclaimable' ? 'blocked' : formatBytes(metrics[key]);
const inSharedStorage = x => SHAREABLE.some(name => x.folders[name] === 'linked');
function renderReport(analysis, { title = 'Storage analysis' } = {}) {
  const m = analysis.metrics, lines = [`# ${title}`, '', `Created ${localTime(analysis.created)}. Read-only: nothing was changed.`, '', '## Current usage', '', '| Metric | Size | Meaning |', '|---|---|---|'];
  for (const metric of METRICS) lines.push(`| ${metric.label} | ${metricValue(m, metric.key)} | ${metric.description} |`);
  if (m.reclaimableBlocked?.length) lines.push('', `Reclaimable space is blocked: ${m.reclaimableBlocked.length === 1 ? 'a backup manifest is' : 'backup manifests are'} unreadable (${m.reclaimableBlocked.join(', ')}). Clean Redundant Backups refuses until ${m.reclaimableBlocked.length === 1 ? 'it is' : 'they are'} fixed or removed.`);
  lines.push('', '## Profiles', '', '| Profile | projects | file-history | image-cache | cleanupPeriodDays | Running Claude PIDs |', '|---|---|---|---|---|---|');
  for (const x of analysis.profiles) lines.push(`| ${x.name}${x.builtin ? ' (Default, cannot join)' : ''} | ${folderLabel(x.folders.projects)} | ${folderLabel(x.folders['file-history'])} | ${folderLabel(x.folders['image-cache'])} | ${x.cleanup.days} (${x.cleanup.source}) | ${x.pids.join(', ') || 'none'} |`);
  const joined = analysis.profiles.filter(inSharedStorage);
  if (analysis.plan || joined.length) lines.push('', `Already in shared storage: ${joined.map(x => x.name).join(', ') || 'no profile'}.`);
  if (Number.isFinite(m.linkSaving)) lines.push('', `Projected after Link Identical Conversations: private history ${formatBytes(m.afterLinking)} (saves ${formatBytes(m.linkSaving)}); with backups and the archive (${formatBytes(m.backup)}), total ${formatBytes(m.total - m.linkSaving)}. Only .jsonl transcripts are linked; checkpoints and images stay separate copies.`);
  lines.push('', `Paths with more than one copy: ${analysis.duplicateFiles}. Sizes count each file once, however many names (hard links) it has.`);
  if (m.externalNames?.length) lines.push('', `Files that also have names outside the scanned folders (counted once): ${m.externalNames.length}.`, ...m.externalNames.slice(0, 20).map(f => `- ${f}`));
  // With a plan, only the profiles that would share history matter: the
  // selected ones and those already in shared storage.
  const chosen = analysis.plan ? new Set(analysis.plan.profiles.map(x => x.id)) : null;
  const relevant = analysis.profiles.filter(x => !chosen || chosen.has(x.id) || inSharedStorage(x));
  const periods = new Set(relevant.map(x => x.cleanup.days));
  const values = `Claude deletes transcripts older than cleanupPeriodDays, set in each profile's settings.json (default 30). Values: ${relevant.map(x => `${x.name} ${x.cleanup.days} days`).join(', ') || 'none'}.`;
  const overrides = analysis.cleanupOverrides || [];
  const overrideLines = overrides.length ? ['', 'Set outside the profiles (these apply to every profile used with them):', ...overrides.map(o => `- ${o.kind === 'managed' ? 'Managed (organisation) setting' : 'Project setting'} ${o.source}: ${o.days} days`)] : [];
  const archiveNote = ['', 'The archive keeps the newest version of every conversation (Default included), even after Claude\'s cleanup (cleanupPeriodDays) or a managed or organisation policy would delete it, until you discard it in Manage Storage.'];
  if (!analysis.plan) lines.push('', '## Claude cleanup period', '', values, ...overrideLines, '', 'Conversations stay private to each profile, so each profile\'s value applies only to its own copies. Storage savings come from cleaning up backups.', ...archiveNote);
  else lines.push('', '## Claude cleanup period', '', values, '', periods.size > 1
    ? 'These values differ. In shared storage the **shortest** period deletes old transcripts for every profile that joined. After Clean Redundant Backups, shared storage holds the only copy.'
    : 'In shared storage this period applies to every profile that joined. After Clean Redundant Backups, shared storage holds the only copy.');
  if (analysis.plan) {
    const plan = analysis.plan;
    lines.push('', '## Migration plan', '', `Files to copy into shared storage: ${plan.files.length} (${formatBytes(plan.bytes)}).`, `Diverged versions kept in the archive (pinned): ${plan.diverged.length}.`);
    for (const x of plan.profiles) lines.push(`- ${x.name}: ${x.folders.map(f => `${f.name} ${f.status === 'missing' ? '(not created yet; it will use shared storage)' : f.status === 'linked' ? '(already shared)' : `(${Object.keys(f.files).length} files)`}`).join(', ')}`);
    if (plan.problems.length) lines.push('', '**Migration is blocked:**', ...plan.problems.map(s => `- ${s}`));
  }
  lines.push('', '## Diverged conversations', '');
  lines.push(...(analysis.diverged.length ? analysis.diverged.map(d => `- ${d.rel} (${d.versions} versions)`) : ['None.']));
  lines.push('', '## Incomplete last lines', '', 'Reported only; these files are copied byte-exact.', '');
  lines.push(...(analysis.truncated.length ? analysis.truncated.map(t => `- ${t.abs}${t.parses ? '' : ' (last line is not valid JSON)'}`) : ['None.']));
  lines.push('', '## Running Claude processes', '');
  if (analysis.processError) lines.push(`Could not check (${analysis.processError}). Migration refuses until this check succeeds.`);
  else {
    const sure = analysis.running.filter(r => !r.unverified), unsure = analysis.running.filter(r => r.unverified);
    lines.push(...(sure.length ? sure.map(r => `- ${r.name} PID ${r.pid}`) : ['None detected.']));
    if (unsure.length) lines.push('', 'Node processes whose command line could not be read (not counted as Claude; stop them if they are):', ...unsure.map(r => `- ${r.name} PID ${r.pid}`));
  }
  if (analysis.links.length) lines.push('', '## Unexpected links (not followed)', '', ...analysis.links.map(l => `- ${l}`));
  if (analysis.plan) lines.push('', '## Risks', '',
    '- Joining means these accounts can read each other\'s conversations. Keep accounts under different policies out of shared storage.',
    '- Claude must be stopped in every VS Code window and terminal during migration and rollback.',
    '- Nothing is deleted by migration. Preserved folders are removed only by Clean Redundant Backups.',
    '- The Default profile keeps copy-based switching.');
  else lines.push('', '## Backups', '',
    '- Reclaimable space counts backup copies whose content is kept in live history (this profile\'s or another\'s), and extra copies of content found only in backups.',
    '- Clean Redundant Backups shows a preview first. Content found only in backups moves into the archive before anything is deleted.');
  return lines.join('\n') + '\n';
}

// ---- Migration -------------------------------------------------------------

function assertSwitcherProfiles(switcherRoot, profiles) {
  const base = normalize(paths(switcherRoot).profiles);
  for (const x of profiles) if (x.builtin || normalize(path.dirname(path.resolve(x.directory))) !== base) throw new Error(`${x.name || x.directory} cannot join shared storage: only switcher profiles can, not Default.`);
}
async function migrate({ switcherRoot, profiles, confirm, acknowledgeCleanupPeriod, detect, alive, interrupt, lock }) {
  if (confirm !== true) throw new Error('Migration requires confirmation');
  if (acknowledgeCleanupPeriod !== true) throw new Error('Migration requires acknowledging the shared cleanupPeriodDays');
  if (!profiles?.length) throw new Error('Select at least one profile');
  assertSwitcherProfiles(switcherRoot, profiles);
  await assertNoMigration(switcherRoot);
  await assertNoRecovery(switcherRoot);
  await assertClaudeStopped(profiles, { detect, alive });
  return withStoreLock(switcherRoot, 'migration', async () => {
    await assertNoMigration(switcherRoot);
    await assertNoRecovery(switcherRoot);
    await assertSharedPlain(switcherRoot);
    await assertStorePlain(switcherRoot);
    // Mark the preparation so copy-based transfers refuse before staging; the
    // marker is removed again if preparation stops before the run starts.
    const previous = await readJournal(switcherRoot), ts = Date.now();
    await writeJournal(switcherRoot, { ...(previous || {}), preparing: { pid: process.pid, started: new Date().toISOString() } });
    let started = false;
    try {
      const analysis = await analyze({ switcherRoot, profiles, selected: profiles.map(x => x.id), processes: false });
      const plan = analysis.plan;
      if (plan.problems.length) throw new Error(`Migration refused: ${plan.problems.join(' ')}`);
      const journal = {
        version: 1, kind: 'migration', id: crypto.randomUUID(), state: 'running', started: new Date().toISOString(), manifest: newManifestId(),
        members: previous?.members || {}, sharedCopied: false, files: plan.files, diverged: plan.diverged,
        profiles: plan.profiles.map(x => ({ ...x, folders: x.folders.map(f => ({ ...f, preserved: `${f.name}.pre-shared-${ts}`, junctionOnly: f.status === 'missing', step: f.status === 'linked' ? 'done' : 'pending' })) }))
      };
      assertJournal(switcherRoot, journal);
      await writeJournal(switcherRoot, journal);
      started = true;
      return await runMigration(switcherRoot, journal, { interrupt });
    } finally {
      if (!started) {
        if (previous) await writeJournal(switcherRoot, previous);
        else await fs.unlink(paths(switcherRoot).journal).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
    }
  }, lock);
}
async function resumeMigration({ switcherRoot, confirm, detect, alive, interrupt, lock }) {
  if (confirm !== true) throw new Error('Resuming requires confirmation');
  const journal = await readJournal(switcherRoot);
  if (journal?.state !== 'running' || journal.kind !== 'migration') throw new Error('No interrupted migration to resume');
  assertJournal(switcherRoot, journal);
  await assertClaudeStopped(journal.profiles, { detect, alive });
  return withStoreLock(switcherRoot, 'migration (resume)', async () => {
    await removeStaleTemps(switcherRoot);
    const current = await readJournal(switcherRoot);
    if (current?.state !== 'running' || current.id !== journal.id) throw new Error('The interrupted migration changed while waiting. Open Manage Storage again.');
    assertJournal(switcherRoot, current);
    return runMigration(switcherRoot, current, { interrupt });
  }, lock);
}
async function runMigration(switcherRoot, journal, { interrupt = async () => {} } = {}) {
  const save = async step => { await writeJournal(switcherRoot, journal); await interrupt(step, journal); };
  try {
    assertJournal(switcherRoot, journal);
    await assertSharedPlain(switcherRoot);
    if (!journal.sharedCopied) {
      // Diverged non-canonical versions are recorded and stored before shared/ changes.
      const manifest = { id: journal.manifest, kind: 'migration', created: journal.started, state: 'prepared', pinned: true, objects: journal.diverged.map(d => ({ name: d.rel, sha256: d.sha256, size: d.size, reason: 'diverged', locations: d.locations })) };
      await writeManifest(switcherRoot, manifest);
      for (const d of journal.diverged) await putObjectFile(switcherRoot, d.source, d.sha256, journalSourceRoot(switcherRoot, journal, d.source));
      manifest.state = 'committed';
      await writeManifest(switcherRoot, manifest);
      await save('objects-stored');
      for (const file of journal.files) await copyToShared(switcherRoot, file, journal);
      journal.sharedCopied = true;
      await save('shared-copied');
    }
    for (const profile of journal.profiles) for (const folder of profile.folders) await joinFolder(switcherRoot, journal, profile, folder, save);
    for (const profile of journal.profiles) journal.members[normalize(profile.directory)] = Object.fromEntries(profile.folders.map(f => [f.name, journal.members[normalize(profile.directory)]?.[f.name] || { preserved: f.junctionOnly ? null : f.preserved, junctionOnly: f.junctionOnly }]));
    journal.state = 'committed';
    journal.finished = new Date().toISOString();
    await save('committed');
    return { copied: journal.files.length, diverged: journal.diverged.length, profiles: journal.profiles.map(x => x.name), manifest: journal.manifest };
  } catch (error) {
    if (error.simulatedCrash) throw error;
    let note;
    try { await rollbackJournal(switcherRoot, journal); note = 'Every selected profile was restored; shared/ was kept and nothing was deleted.'; }
    catch (e) { note = `Automatic rollback did not finish (${e.message}). Run Roll Back Shared Storage after resolving it; migration.json records every step.`; }
    throw new Error(`Migration stopped: ${error.message}. ${note}`);
  }
}
async function copyToShared(switcherRoot, file, journal) {
  if (file.rel.split(/[\\/]/).some(part => part === '..' || !part) || !SHAREABLE.includes(file.rel.split(/[\\/]/)[0])) throw new Error('Invalid planned path');
  const target = path.join(paths(switcherRoot).shared, file.rel);
  const fromRoot = journalSourceRoot(switcherRoot, journal, file.source);
  await assertPlainPath(fromRoot, file.source);
  await assertPlainPath(paths(switcherRoot).root, target, { allowMissing: true });
  const stat = await lstatOrNull(target);
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) throw new Error(`Unexpected entry in shared storage: ${target}`);
  if (stat) {
    const current = (await hashFile(target)).sha256;
    if (current === file.sha256) return;
    // Only replace a shared version the plan accounted for: superseded by the
    // canonical prefix chain, or already stored as a diverged object.
    const known = current === file.replaces || journal.diverged.some(d => d.sha256 === current);
    if (!known && !(isJsonl(target) && stat.size <= file.size && await prefixHash(file.source, stat.size) === current)) throw new Error(`Shared file changed since analysis: ${file.rel}`);
  }
  await copyVerified(file.source, target, file.sha256, { root: paths(switcherRoot).root, fromRoot });
}
async function verifyPreserved(dir, expected) {
  const found = await walk(dir);
  if (found.links.length) throw new Error(`Preserved folder contains links: ${dir}`);
  const actual = {};
  for (const f of found.files) actual[f.rel] = (await hashFile(f.abs)).sha256;
  const a = Object.keys(actual).sort(), b = Object.keys(expected).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i] || actual[k] !== expected[k])) throw new Error(`${dir} changed since it was analyzed`);
}
async function verifyListing(switcherRoot, journal, folder, link) {
  const listed = new Set((await walk(link, '', undefined, true)).files.map(f => fold(path.join(folder.name, f.rel))));
  const expected = [...journal.files.map(f => f.rel).filter(rel => fold(rel).startsWith(fold(folder.name) + '/')), ...Object.keys(folder.files).map(rel => path.join(folder.name, rel))];
  const missing = expected.filter(rel => !listed.has(fold(rel)));
  if (missing.length) throw new Error(`Listing through ${link} is missing ${plural(missing.length, 'planned file', 'planned files')}, for example ${missing[0]}`);
}
async function joinFolder(switcherRoot, journal, profile, folder, save) {
  const link = path.join(profile.directory, folder.name), preserved = path.join(profile.directory, folder.preserved), target = path.join(paths(switcherRoot).shared, folder.name);
  const where = `${profile.name}/${folder.name}`;
  if (folder.step === 'done') return;
  await assertPlainPath(paths(switcherRoot).root, target, { allowMissing: true });
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  await assertPlainPath(paths(switcherRoot).root, target);
  if (folder.step === 'pending') {
    if (folder.junctionOnly) { if (await lstatOrNull(link)) throw new Error(`${link} appeared after analysis`); folder.step = 'renamed'; await save(`renamed:${where}`); }
    else {
      folder.step = 'renaming';
      await save(`renaming:${where}`);
      await renameFolder(link, preserved);
      folder.step = 'renamed';
      await save(`renamed:${where}`);
    }
  } else if (folder.step === 'renaming') {
    // Resume: the journal was written before the rename; find out whether it happened.
    const a = await lstatOrNull(link), b = await lstatOrNull(preserved);
    if (!b && a?.isDirectory() && !a.isSymbolicLink()) await renameFolder(link, preserved);
    else if (!(b && !a)) throw new Error(`Cannot tell whether ${link} was preserved; both or neither exist`);
    folder.step = 'renamed';
    await save(`renamed:${where}`);
  }
  if (folder.step === 'renamed') {
    if (!folder.junctionOnly) await verifyPreserved(preserved, folder.files);
    folder.step = 'verified';
    await save(`verified:${where}`);
  }
  if (folder.step === 'verified') {
    folder.step = 'linking';
    await save(`linking:${where}`);
    await fs.symlink(target, link, 'junction');
    folder.step = 'linked';
    await save(`linked:${where}`);
  } else if (folder.step === 'linking') {
    const a = await lstatOrNull(link);
    if (!a) await fs.symlink(target, link, 'junction');
    else if (!(a.isSymbolicLink() && await managedLink(link, profile.directory, folder.name, switcherRoot))) throw Object.assign(new Error(`${link} already exists`), { code: 'EEXIST' });
    folder.step = 'linked';
    await save(`linked:${where}`);
  }
  if (folder.step === 'linked') {
    if (!(await managedLink(link, profile.directory, folder.name, switcherRoot))) throw new Error(`${link} does not point to shared storage`);
    await verifyListing(switcherRoot, journal, folder, link);
    folder.step = 'done';
    await save(`done:${where}`);
  }
}
// Exact undo of an interrupted or failed migration: remove the junctions we
// made and rename the preserved folders back. shared/ is kept.
// Copies every shared file that is still missing from the private folder.
// Each copy is verified and renamed into place, so a file that exists is
// complete; rerunning after an interruption copies only the rest.
async function rebuildFromShared(switcherRoot, name, link, onFile = async () => {}) {
  const p = paths(switcherRoot), source = path.join(p.shared, name), profileRoot = path.dirname(link);
  await assertPlainPath(p.root, source).catch(e => { throw new Error(`Cannot rebuild ${link}: ${e.message}`); });
  const own = await lstatOrNull(link);
  if (!own) await fs.mkdir(link, { mode: 0o700 });
  else if (own.isSymbolicLink() || !own.isDirectory()) throw new Error(`Cannot rebuild ${link}: it is not a plain folder`);
  await assertPlainPath(profileRoot, link);
  let copied = 0;
  for (const f of (await walk(source)).files) {
    const target = path.join(link, f.rel);
    if (await lstatOrNull(target)) continue;
    await copyVerified(f.abs, target, (await hashFile(f.abs)).sha256, { root: profileRoot, fromRoot: p.root });
    copied++;
    await onFile(f.rel);
  }
  return copied;
}
async function rollbackJournal(switcherRoot, journal, interrupt = async () => {}) {
  assertJournal(switcherRoot, journal);
  for (const profile of [...journal.profiles].reverse()) {
    for (const folder of [...profile.folders].reverse()) {
      if (folder.status === 'linked' || folder.step === 'pending' || folder.step === 'rolled-back') continue;
      const link = path.join(profile.directory, folder.name), preserved = path.join(profile.directory, folder.preserved);
      const where = `${profile.name}/${folder.name}`;
      const rebuild = async () => {
        await rebuildFromShared(switcherRoot, folder.name, link, rel => interrupt(`rebuilt-file:${where}:${rel}`, journal));
        folder.rebuilt = true;
      };
      if (folder.step === 'rebuilding') {
        // Resume an interrupted rebuild: only the files still missing are copied.
        await rebuild();
        folder.step = 'rolled-back';
        await writeJournal(switcherRoot, journal);
        continue;
      }
      // A preserved entry is renamed back only when it is a plain folder.
      const kept = await lstatOrNull(preserved);
      if (kept && (kept.isSymbolicLink() || !kept.isDirectory())) throw new Error(`${preserved} is not a plain folder; it was left unchanged and nothing was restored`);
      const a = await lstatOrNull(link);
      if (a?.isSymbolicLink()) {
        if (!(await managedLink(link, profile.directory, folder.name, switcherRoot))) throw new Error(`${link} is a link this migration did not create`);
        await removeLink(link);
      }
      if (!folder.junctionOnly && kept) {
        const now = await lstatOrNull(link);
        if (now) {
          // A process created the folder in the meantime. Remove it only when empty.
          if (now.isDirectory() && !(await fs.readdir(link)).length) await fs.rmdir(link);
          else throw new Error(`${link} was recreated while migrating; the original is kept at ${preserved}`);
        }
        await renameFolder(preserved, link);
      } else if (!folder.junctionOnly && folder.step !== 'renaming' && !(await lstatOrNull(link))) {
        // The preserved folder is gone (removed outside the journal): rebuild
        // the private folder from shared/ rather than leave the profile empty.
        folder.step = 'rebuilding';
        await writeJournal(switcherRoot, journal);
        await interrupt(`rebuilding:${where}`, journal);
        await rebuild();
      } else if (!folder.junctionOnly && !(await lstatOrNull(link))) throw new Error(`Neither ${link} nor its preserved copy exists`);
      folder.step = 'rolled-back';
      await writeJournal(switcherRoot, journal);
    }
  }
  journal.state = 'rolled-back';
  journal.finished = new Date().toISOString();
  await writeJournal(switcherRoot, journal);
}

// ---- Rollback of shared storage --------------------------------------------

async function rollback({ switcherRoot, profiles, confirm, detect, alive, interrupt = async () => {}, lock }) {
  if (confirm !== true) throw new Error('Rollback requires confirmation');
  const existing = await readJournal(switcherRoot);
  if (existing?.state === 'running') assertJournal(switcherRoot, existing);
  else if (profiles?.length) assertSwitcherProfiles(switcherRoot, profiles);
  await assertNoRecovery(switcherRoot);
  const targets = existing?.state === 'running' ? existing.profiles : profiles;
  if (!targets?.length) throw new Error('Select at least one profile');
  await assertClaudeStopped(targets, { detect, alive });
  return withStoreLock(switcherRoot, 'rollback', async () => {
    await removeStaleTemps(switcherRoot);
    await assertNoRecovery(switcherRoot);
    const current = await readJournal(switcherRoot);
    if (current?.state === 'running') assertJournal(switcherRoot, current);
    if (current?.state === 'running' && current.kind === 'migration') { await rollbackJournal(switcherRoot, current, interrupt); return { interruptedMigration: true, restored: current.profiles.map(x => x.name), diverged: [] }; }
    const journal = current?.state === 'running' && current.kind === 'rollback' ? current : {
      version: 1, kind: 'rollback', id: crypto.randomUUID(), state: 'running', started: new Date().toISOString(), manifest: newManifestId(), members: current?.members || {},
      profiles: profiles.map(x => ({ id: x.id, name: x.name, directory: x.directory, folders: SHAREABLE.map(name => ({ name, step: 'pending' })) }))
    };
    const save = async step => { await writeJournal(switcherRoot, journal); await interrupt(step, journal); };
    await save('started');
    const diverged = [], restored = [];
    for (const profile of journal.profiles) {
      for (const folder of profile.folders) {
        if (folder.step === 'done') continue;
        const result = await rollbackFolder(switcherRoot, journal, profile, folder, save);
        diverged.push(...result.diverged);
        if (result.restored) restored.push(`${profile.name}/${folder.name}`);
      }
      delete journal.members[normalize(profile.directory)];
    }
    journal.state = 'committed';
    journal.finished = new Date().toISOString();
    await save('committed');
    return { restored, diverged, manifest: diverged.length ? journal.manifest : null };
  }, lock);
}
const plainFolder = async file => { const s = await lstatOrNull(file); return !!s && s.isDirectory() && !s.isSymbolicLink(); };
// The newest preserved copy that is a plain folder; links are never chosen.
async function newestPreserved(directory, name) {
  let names = [];
  try { names = await fs.readdir(directory); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const m of names.map(n => n.match(PRESERVED)).filter(m => m && m[1] === name).sort((a, b) => Number(b[2]) - Number(a[2]))) {
    if (await plainFolder(path.join(directory, m[0]))) return m[0];
  }
  return null;
}
async function rollbackFolder(switcherRoot, journal, profile, folder, save) {
  const link = path.join(profile.directory, folder.name), source = path.join(paths(switcherRoot).shared, folder.name);
  const member = journal.members[normalize(profile.directory)]?.[folder.name];
  const where = `${profile.name}/${folder.name}`;
  if (folder.step === 'pending') {
    const stat = await lstatOrNull(link);
    if (!stat?.isSymbolicLink()) { folder.step = 'done'; folder.skipped = 'not shared'; await save(`skipped:${where}`); return { diverged: [], restored: false }; }
    if (!(await managedLink(link, profile.directory, folder.name, switcherRoot))) throw new Error(`${link} is not a shared-storage junction; it was left unchanged`);
    folder.preserved = member?.preserved && PRESERVED.test(member.preserved) && await plainFolder(path.join(profile.directory, member.preserved)) ? member.preserved : await newestPreserved(profile.directory, folder.name);
    folder.junctionOnly = !!member?.junctionOnly;
    folder.step = 'unlinking';
    await save(`unlinking:${where}`);
  }
  if (folder.step === 'unlinking') {
    const stat = await lstatOrNull(link);
    if (stat?.isSymbolicLink()) await removeLink(link);
    folder.step = 'unlinked';
    await save(`unlinked:${where}`);
  }
  if (folder.step === 'unlinked') {
    // A junction-only folder had no private copy; the profile used shared/
    // through it, so it is rebuilt from shared/ like a cleaned-up one.
    if (!(await lstatOrNull(link))) {
      if (folder.preserved && await plainFolder(path.join(profile.directory, folder.preserved))) await renameFolder(path.join(profile.directory, folder.preserved), link);
      else await fs.mkdir(link, { mode: 0o700 }); // Cleanup removed it: rebuild from shared/.
    }
    await assertPlainPath(profile.directory, link);
    folder.step = 'restored';
    await save(`restored:${where}`);
  }
  const diverged = [];
  if (folder.step === 'restored') {
    const root = paths(switcherRoot).root, bounds = { root: profile.directory, fromRoot: root };
    await assertPlainPath(root, source);
    await assertPlainPath(profile.directory, link);
    for (const f of (await walk(source)).files) {
      const mine = path.join(link, f.rel), stat = await lstatOrNull(mine);
      const theirs = await hashFile(f.abs);
      if (!stat) { await copyVerified(f.abs, mine, theirs.sha256, bounds); continue; }
      if (!stat.isFile()) { diverged.push({ name: path.join(folder.name, f.rel), sha256: theirs.sha256, size: theirs.size, reason: 'not a file in profile', source: f.abs, kept: mine }); continue; }
      const own = (await hashFile(mine)).sha256;
      if (own === theirs.sha256) continue;
      if (isJsonl(f.rel) && stat.size <= theirs.size && await prefixHash(f.abs, stat.size) === own) { await copyVerified(f.abs, mine, theirs.sha256, bounds); continue; }
      diverged.push({ name: path.join(folder.name, f.rel), sha256: theirs.sha256, size: theirs.size, reason: 'diverged', source: f.abs, kept: mine });
    }
    if (diverged.length) {
      const manifestFile = manifestPath(switcherRoot, journal.manifest);
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); } catch { manifest = { id: journal.manifest, kind: 'rollback', created: journal.started, pinned: true, objects: [] }; }
      manifest.state = 'prepared';
      manifest.objects.push(...diverged.map(({ source: _s, ...rest }) => ({ ...rest, profile: profile.name })));
      await writeManifest(switcherRoot, manifest);
      for (const d of diverged) await putObjectFile(switcherRoot, d.source, d.sha256, paths(switcherRoot).root);
      manifest.state = 'committed';
      await writeManifest(switcherRoot, manifest);
    }
    folder.step = 'done';
    await save(`done:${where}`);
  }
  return { diverged, restored: true };
}

// ---- Cleanup ---------------------------------------------------------------

// Live history by folded relative path (every profile's live folders and shared/).
// Live files that capture never archives (larger than its limit, or in a
// profile with a pending transfer recovery) do not count as covering a
// backup: they go to `uncapturable` instead, and such backups are unique.
async function liveMap(switcherRoot, profiles, collected, { maxBytes = CAPTURE_LIMIT, uncapturable } = {}) {
  const live = new Map();
  const add = (map, rel, abs) => { const k = fold(rel); if (!map.has(k)) map.set(k, []); map.get(k).push(abs); };
  for (const name of SHAREABLE) for (const f of (await walk(path.join(paths(switcherRoot).shared, name))).files) add(live, path.join(name, f.rel), f.abs);
  for (const profile of profiles) {
    const locked = !!(await lstatOrNull(path.join(profile.directory, '.profile-switch-lock')));
    for (const r of (collected?.get(profile) || await collect(profile, switcherRoot)).records.filter(r => r.kind === 'live')) {
      if (locked || r.size > maxBytes) { if (uncapturable) add(uncapturable, r.rel, r.abs); continue; }
      add(live, r.rel, r.abs);
    }
  }
  return live;
}
const CAPTURE_LIMIT = 512 * 1024 * 1024;
// The cleanup safety rule: content is covered when it is in the store under a
// manifest GC can never expire (B1), or at a different live location (exactly,
// or for transcripts as a byte prefix). `referenced` is reloaded per batch.
// `liveOk` (with the capture guard) accepts only live files whose current
// state the archive captured.
function coverage(switcherRoot, live, referenced, liveOk = async () => true) {
  const cache = new Map();
  const inStore = async (sha, size) => {
    if (!referenced.has(sha)) return false;
    if (!cache.has(sha)) cache.set(sha, await objectValid(switcherRoot, sha, size));
    return cache.get(sha);
  };
  const covered = async (c, sha, size) => {
    if (await inStore(sha, size)) return true;
    const self = normalize((await realOrNull(c.abs)) || c.abs);
    for (const abs of live.get(fold(c.rel)) || []) {
      const real = await realOrNull(abs);
      if (!real || normalize(real) === self) continue;
      const stat = await lstatOrNull(abs);
      if (!stat?.isFile() || stat.size < size) continue;
      if (!(await liveOk(abs))) continue;
      if (stat.size === size ? (await hashFile(abs)).sha256 === sha : isJsonl(c.rel) && await prefixHash(abs, size) === sha) return true;
    }
    return false;
  };
  return { covered, cache };
}
// The capture guard per batch: a live file covers a backup only while its
// current size and modification time are the ones the archive captured.
async function capturedNow(switcherRoot) {
  const a = archiveOf(switcherRoot);
  const index = (await a.exists()) ? await a.readCaptureIndex() : { files: {} };
  return async abs => {
    const s = await fs.lstat(abs, { bigint: true }).catch(() => null);
    return !!s && captureUnchanged({ size: Number(s.size), mtimeNs: String(s.mtimeNs) }, index.files[`${s.dev}:${s.ino}`]);
  };
}
// Deletes preserved pre-shared folders and old snapshots file by file. A file
// goes only when its content is in the object store, at a different live
// location, or (transcripts) is a prefix of live content; unique content is
// moved into the object store first.
// dryRun is read-only (no lock, no writes) and returns what a real run would
// delete, move into the store first, and skip, with reasons.
// N6: a real run works in batches of one snapshot (or about batchMs). Each
// batch takes the store lock, reloads the durable references, stores, writes
// its manifest, deletes and releases the lock, so transfers can run in
// between. `signal` cancels between batches; onProgress reports each batch.
// N7: `snapshots` lists manifest-less snapshots the user confirmed one by one;
// each is removed only when every file in it rebuilds from the archive under
// a pinned manifest.
async function cleanup({ switcherRoot, profiles, confirm, dryRun = false, beforeDelete = async () => {}, lock, signal, onProgress, between = async () => {}, batchMs = 30000, snapshots = [], requireCapture, maxBytes = CAPTURE_LIMIT }) {
  if (!dryRun && confirm !== true) throw new Error('Cleanup requires confirmation');
  // The architect's order: backups go only after a complete capture of the
  // current history. On by default for a real run; a caller opts out only
  // explicitly (requireCapture: false).
  const guard = requireCapture ?? !dryRun;
  // An interrupted migration or rollback still needs the preserved folders.
  await assertNoMigration(switcherRoot);
  await assertStorePlain(switcherRoot);
  const confirmed = new Set(snapshots.map(s => normalize(s)));
  const skipped = [], candidates = [], collected = new Map(), manifestless = new Map(), lockOf = new Map();
  // Backup files cleanup keeps (skipped snapshots, or every backup of a profile
  // with a pending recovery). Content found only there is archived under a
  // pinned manifest, and the files themselves are left in place.
  const kept = [];
  // A path is reported once per reason (the same refusal can come from several steps).
  const skip = (p, reason) => { if (!skipped.some(s => s.path === p && s.reason === reason)) skipped.push({ path: p, reason }); };
  for (const profile of profiles) collected.set(profile, await collect(profile, switcherRoot));
  // As in capture: a backup file that is an account file's identity, or has
  // more names than the scan found, is a planted link. It is never read,
  // archived or deleted; it is only reported.
  const accounts = await accountIdentities([...await profileDirectories(switcherRoot), ...profiles.map(p => p.directory)]);
  const names = new Map();
  for (const found of collected.values()) for (const r of found.records) if (r.id) names.set(r.id, (names.get(r.id) || 0) + 1);
  const unsafe = r => !r.id ? null
    : accounts.has(r.id) ? 'the same file as an account file (credentials or settings); never read, archived or deleted'
      : (r.nlink || 1) > 1 && r.nlink > (names.get(r.id) || 0) ? 'has names outside the scanned folders; never read, archived or deleted' : null;
  for (const profile of profiles) {
    const found = collected.get(profile);
    const lockFile = path.join(profile.directory, '.profile-switch-lock');
    const all = found.records.filter(r => r.kind === 'preserved' || r.kind === 'backup');
    const isUnsafe = r => { const why = unsafe(r); if (why) skip(r.abs, why); return !!why; };
    if (await lstatOrNull(lockFile)) { skipped.push({ path: profile.directory, reason: cleanupSkipReason({ kind: 'backup' }, true) }); kept.push(...all.filter(r => !isUnsafe(r))); continue; }
    for (const r of all) {
      lockOf.set(r, lockFile);
      // Counted first, so a snapshot without a manifest that holds a planted
      // file is still offered to N7, which then keeps it whole with a reason.
      if (r.kind === 'backup' && r.snapshotState === 'none') {
        if (!manifestless.has(r.container)) manifestless.set(r.container, { path: r.container, root: r.root, lock: lockFile, files: 0, bytes: 0 });
        const m = manifestless.get(r.container);
        m.files++; m.bytes += r.size;
      }
      if (isUnsafe(r)) continue;
      if (r.kind === 'backup' && r.snapshotState === 'none' && confirmed.has(normalize(r.container))) continue;
      const reason = cleanupSkipReason(r, false);
      if (reason) { if (!skipped.some(s => s.path === r.container)) skipped.push({ path: r.container, reason }); kept.push(r); continue; }
      candidates.push(r);
    }
  }
  const uncapturable = new Map();
  const live = await liveMap(switcherRoot, profiles, collected, { maxBytes, uncapturable });
  // Content counts as kept in the store only when a readable manifest
  // references it: an unreferenced object (left by an interrupted run) is
  // removed by the next GC. If any manifest is unreadable, nothing counts:
  // the preview reports cleanup as blocked and the real run refuses.
  const first = await readManifests(switcherRoot);
  if (first.invalid.length) {
    if (dryRun) return { dryRun: true, blocked: true, unreadable: first.invalid.map(x => x.file), delete: [], move: [], skipped: [], manifestless: [], bytes: 0, movedBytes: 0, net: null };
    throw Object.assign(new Error(blockedMessage(first.invalid)), { code: 'EBLOCKED', unreadable: first.invalid.map(x => x.file) });
  }
  if (guard) await assertCaptureCurrent({ switcherRoot, profiles, maxBytes });
  // Distinct content found only in backups cleanup keeps (not covered, and
  // not already being moved by this run). Read-only; plain paths only.
  const keptUnique = async (covered, exclude) => {
    const out = [], seen = new Set(exclude);
    for (const r of kept) {
      try { await assertPlainPath(r.root, r.abs); } catch (e) { skip(r.abs, e.message); continue; }
      const sha256 = (await hashFile(r.abs)).sha256;
      if (seen.has(sha256) || await covered(r, sha256, r.size)) continue;
      seen.add(sha256);
      out.push({ ...r, sha256 });
    }
    return out;
  };
  if (dryRun) {
    const { covered } = coverage(switcherRoot, live, durableReferences(first.manifests), guard ? await capturedNow(switcherRoot) : undefined);
    // Only to explain the preview: content a live file holds that capture never archives.
    const { covered: heldUncaptured } = coverage(switcherRoot, uncapturable, new Set());
    const unique = [];
    for (const c of candidates) { c.sha256 = (await hashFile(c.abs)).sha256; if (!(await covered(c, c.sha256, c.size))) unique.push(c); }
    const remove = [];
    for (const c of candidates) {
      try { await assertPlainPath(c.root, c.abs); } catch (e) { skip(c.abs, e.message); continue; }
      const reason = !unique.includes(c) ? 'content is kept elsewhere'
        : await heldUncaptured(c, c.sha256, c.size) ? 'covered only by a live file the archive does not capture (larger than the capture limit, or its profile has a pending transfer recovery); moved into the archive first'
          : 'unique content, moved into the archive first';
      remove.push({ path: c.abs, size: c.size, reason });
    }
    const move = unique.map(c => ({ path: c.abs, size: c.size, sha256: c.sha256 }));
    const bytes = remove.reduce((n, f) => n + f.size, 0);
    // Bytes a unique file adds to the store: none if it is already there.
    const added = [];
    for (const m of move) if (!(await objectPresent(switcherRoot, m.sha256, m.size).catch(() => false))) added.push(m);
    const movedBytes = bytes - netSaving(bytes, added);
    // Kept backups are not deleted; their unique content is archived (pinned) too.
    const archiveKept = (await keptUnique(covered, unique.map(c => c.sha256))).map(r => ({ path: r.abs, size: r.size, sha256: r.sha256 }));
    let archiveKeptBytes = 0;
    for (const k of archiveKept) if (!(await objectPresent(switcherRoot, k.sha256, k.size).catch(() => false))) archiveKeptBytes += k.size;
    return { dryRun: true, delete: remove, move, skipped, manifestless: [...manifestless.values()].map(({ path: p, files, bytes: b }) => ({ path: p, files, bytes: b })), archiveKept, archiveKeptBytes, bytes, movedBytes, net: bytes - movedBytes };
  }
  const result = { deleted: 0, deletedBytes: 0, freed: 0, moved: 0, movedBytes: 0, manifest: null, manifests: [], skipped, batches: 0, cancelled: false, snapshots: [] };
  // Batches: one container (snapshot or preserved folder), split by time.
  const byContainer = new Map();
  for (const c of candidates) { if (!byContainer.has(c.container)) byContainer.set(c.container, []); byContainer.get(c.container).push(c); }
  const total = candidates.length;
  let done = 0;
  const pause = async () => {
    result.batches++;
    onProgress?.({ done, total, batches: result.batches, deleted: result.deleted });
    await between(result);
    if (signal?.aborted) { result.cancelled = true; return true; }
    return false;
  };
  outer: for (const [container, list] of byContainer) {
    let i = 0;
    while (i < list.length) {
      if (signal?.aborted) { result.cancelled = true; break outer; }
      await withStoreLock(switcherRoot, 'cleanup', async () => {
        await assertNoMigration(switcherRoot);
        await assertStorePlain(switcherRoot);
        const { manifests, invalid } = await readManifests(switcherRoot);
        if (invalid.length) throw Object.assign(new Error(blockedMessage(invalid)), { code: 'EBLOCKED', unreadable: invalid.map(x => x.file) });
        const referenced = durableReferences(manifests);
        // The capture guard, re-checked for this batch: a live file counts as
        // covering only while it is exactly what the archive captured.
        const { covered, cache } = coverage(switcherRoot, live, referenced, guard ? await capturedNow(switcherRoot) : undefined);
        const deadline = Date.now() + batchMs, batch = [];
        while (i < list.length && (!batch.length || Date.now() < deadline)) batch.push(list[i++]);
        done += batch.length;
        // A transfer may have started in this profile since the scan.
        if (await lstatOrNull(lockOf.get(batch[0]))) {
          if (!skipped.some(s => s.path === container)) skipped.push({ path: container, reason: cleanupSkipReason({ kind: 'backup' }, true) });
          return;
        }
        // Store first, then record: an interrupted batch leaves at most
        // unreferenced objects (removed by GC), never a pinned manifest
        // without its objects. Under the lock no GC runs in between.
        const unique = [];
        for (const c of batch) { c.sha256 = (await hashFile(c.abs)).sha256; if (!(await covered(c, c.sha256, c.size))) unique.push(c); }
        const stored = [], failed = new Set();
        for (const c of unique) {
          try {
            const r = await putObjectFile(switcherRoot, c.abs, c.sha256, c.root);
            if (r.stored) result.movedBytes += c.size;
            stored.push(c); cache.set(c.sha256, true);
          } catch (e) { failed.add(c); skipped.push({ path: c.abs, reason: `could not be stored in the archive (${e.message}); kept` }); }
        }
        if (stored.length) {
          const manifest = { id: newManifestId(), kind: 'cleanup', created: new Date().toISOString(), state: 'committed', pinned: true, objects: stored.map(c => ({ name: c.rel, sha256: c.sha256, size: c.size, reason: 'unique backup content', location: c.abs })) };
          await writeManifest(switcherRoot, manifest);
          for (const c of stored) referenced.add(c.sha256);
          result.manifest = manifest.id;
          result.manifests.push(manifest.id);
          result.moved += stored.length;
        }
        for (const c of batch) {
          // Already reported as kept: it could not be stored.
          if (failed.has(c)) continue;
          await beforeDelete(c);
          // Never delete through a link: every component from the profile root down
          // to the file must still be plain, and the file must resolve inside it.
          try { await assertPlainPath(c.root, c.abs); } catch (e) { skip(c.abs, e.message); continue; }
          const stat = await lstatOrNull(c.abs);
          if (!stat?.isFile()) continue;
          // Re-verify immediately before removing: the file or its copies may have changed.
          cache.clear();
          const sha = (await hashFile(c.abs)).sha256;
          if (!(await covered(c, sha, stat.size))) { skipped.push({ path: c.abs, reason: 'content is not stored anywhere else' }); continue; }
          await fs.unlink(c.abs);
          result.deleted++; result.deletedBytes += stat.size;
        }
        if (i >= list.length) await pruneEmpty(container, true);
      }, lock);
      if (await pause()) break outer;
    }
  }
  if (!result.cancelled) for (const snapshot of snapshots) {
    const entry = [...manifestless.values()].find(m => normalize(m.path) === normalize(snapshot));
    if (!entry) { skipped.push({ path: snapshot, reason: 'not a snapshot without a manifest; left unchanged' }); continue; }
    result.snapshots.push(await removeManifestless(switcherRoot, entry, { lock, skipped, result, unsafe }));
    if (await pause()) break;
  }
  // Content found only in backups cleanup keeps (prepared or other uncommitted
  // snapshots, unconfirmed snapshots without a manifest, a profile with a
  // pending recovery) is archived under a pinned manifest. Those files are
  // left in place; nothing of them is deleted.
  result.archivedKept = 0; result.archivedKeptBytes = 0;
  if (!result.cancelled && kept.length) {
    await withStoreLock(switcherRoot, 'cleanup', async () => {
      await assertNoMigration(switcherRoot);
      await assertStorePlain(switcherRoot);
      const { manifests, invalid } = await readManifests(switcherRoot);
      if (invalid.length) throw Object.assign(new Error(blockedMessage(invalid)), { code: 'EBLOCKED', unreadable: invalid.map(x => x.file) });
      const { covered } = coverage(switcherRoot, live, durableReferences(manifests), guard ? await capturedNow(switcherRoot) : undefined);
      const stored = [];
      for (const item of await keptUnique(covered, [])) {
        try { const r = await putObjectFile(switcherRoot, item.abs, item.sha256, item.root); if (r.stored) result.archivedKeptBytes += item.size; stored.push(item); }
        catch (e) { skipped.push({ path: item.abs, reason: `could not be archived (${e.message}); left in place` }); }
      }
      if (stored.length) {
        const manifest = { id: newManifestId(), kind: 'cleanup', created: new Date().toISOString(), state: 'committed', pinned: true, objects: stored.map(c => ({ name: c.rel, sha256: c.sha256, size: c.size, reason: 'only in a backup that cleanup keeps; archived, the backup is left in place', location: c.abs })) };
        await writeManifest(switcherRoot, manifest);
        result.manifests.push(manifest.id);
        result.archivedKept = stored.length;
      }
    }, lock);
  }
  // freed is the net saving: deleted bytes minus what was newly stored.
  result.freed = result.deletedBytes - result.movedBytes;
  return result;
}
// N7: archives every file of a snapshot that has no manifest under a pinned
// manifest, checks that each one rebuilds from the archive, and only then
// deletes the files. If any file does not rebuild, nothing is deleted.
async function removeManifestless(switcherRoot, entry, { lock, skipped, result, unsafe = () => null }) {
  return withStoreLock(switcherRoot, 'cleanup', async () => {
    await assertNoMigration(switcherRoot);
    await assertStorePlain(switcherRoot);
    const keep = reason => { skipped.push({ path: entry.path, reason }); return { path: entry.path, removed: false, reason }; };
    if (await lstatOrNull(entry.lock)) return keep(cleanupSkipReason({ kind: 'backup' }, true));
    try { await assertPlainPath(entry.root, entry.path); } catch (e) { return keep(e.message); }
    if (await lstatOrNull(path.join(entry.path, 'manifest.json'))) return keep('a manifest appeared; left unchanged');
    const found = await walk(entry.path);
    if (found.links.length) return keep('contains links; left unchanged');
    // A planted hard link (an account file, or names outside the scan) keeps the whole snapshot.
    const planted = found.files.map(f => unsafe(f)).find(Boolean);
    if (planted) return keep(`holds a file that ${planted.replace(/; never read, archived or deleted$/, '')}; the snapshot is left unchanged`);
    const { invalid } = await readManifests(switcherRoot);
    if (invalid.length) throw Object.assign(new Error(blockedMessage(invalid)), { code: 'EBLOCKED', unreadable: invalid.map(x => x.file) });
    const files = [];
    for (const f of found.files) {
      const sha256 = (await hashFile(f.abs)).sha256;
      try { const r = await putObjectFile(switcherRoot, f.abs, sha256, entry.root); if (r.stored) result.movedBytes += f.size; }
      catch (e) { return keep(`could not be archived (${e.message}); nothing was deleted`); }
      files.push({ ...f, sha256 });
    }
    const manifest = { id: newManifestId(), kind: 'cleanup', created: new Date().toISOString(), state: 'committed', pinned: true, objects: files.map(f => ({ name: f.rel, sha256: f.sha256, size: f.size, reason: 'snapshot without a manifest', location: f.abs })) };
    if (files.length) { await writeManifest(switcherRoot, manifest); result.manifests.push(manifest.id); result.manifest = manifest.id; result.moved += files.length; }
    // Every file must rebuild from the archive under a pinned manifest before anything goes.
    const durable = durableReferences((await readManifests(switcherRoot)).manifests);
    for (const f of files) if (!durable.has(f.sha256) || !(await objectValid(switcherRoot, f.sha256, f.size))) return keep(`${f.abs} does not rebuild from the archive; nothing was deleted`);
    let deleted = 0;
    for (const f of files) {
      try { await assertPlainPath(entry.root, f.abs); } catch (e) { skipped.push({ path: f.abs, reason: e.message }); continue; }
      if ((await hashFile(f.abs)).sha256 !== f.sha256) { skipped.push({ path: f.abs, reason: 'changed after it was archived; kept' }); continue; }
      await fs.unlink(f.abs);
      deleted++; result.deleted++; result.deletedBytes += f.size;
    }
    await pruneEmpty(entry.path, true);
    return { path: entry.path, removed: !(await lstatOrNull(entry.path)), deleted, manifest: files.length ? manifest.id : null };
  }, lock);
}

// ---- Leftover transfer entries (N5) ------------------------------------------

// This extension's exact staged (.tmp-<uuid>) and moved-aside (.old-<uuid>)
// names in profile history folders and shared/, older than `olderThan`.
// Profiles with a .profile-switch-lock or a pending transfer recovery are skipped.
async function findLeftovers(switcherRoot, profiles, { olderThan = DAY, now = Date.now() } = {}) {
  const p = paths(switcherRoot), found = [], skipped = [];
  const recovery = (await readRecovery(switcherRoot)) || [];
  const pending = new Set(recovery.map(e => e.destination && normalize(e.destination)).filter(Boolean));
  const roots = [];
  for (const profile of profiles) {
    if (await lstatOrNull(path.join(profile.directory, '.profile-switch-lock'))) { skipped.push({ path: profile.directory, reason: cleanupSkipReason({ kind: 'backup' }, true) }); continue; }
    if (pending.has(normalize(profile.directory))) { skipped.push({ path: profile.directory, reason: 'a transfer recovery is pending for this profile' }); continue; }
    for (const name of SHAREABLE) if ((await folderStatus(profile.directory, name, switcherRoot)) === 'private') roots.push({ root: profile.directory, dir: path.join(profile.directory, name), rel: name });
  }
  if (recovery.length) skipped.push({ path: p.shared, reason: 'a transfer recovery is pending' });
  else for (const name of SHAREABLE) if ((await lstatOrNull(path.join(p.shared, name)))?.isDirectory()) roots.push({ root: p.root, dir: path.join(p.shared, name), rel: name });
  const newest = async (abs, stat) => {
    if (!stat.isDirectory()) return stat.mtimeMs;
    const inner = await walk(abs);
    return Math.max(stat.mtimeMs, ...inner.files.map(f => f.mtimeMs));
  };
  const scan = async (root, dir, rel) => {
    let names;
    try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const name of names.sort()) {
      const abs = path.join(dir, name), stat = await lstatOrNull(abs);
      if (!stat || stat.isSymbolicLink()) continue;
      const m = name.match(LEFTOVER);
      if (m) {
        if (now - await newest(abs, stat) > olderThan) found.push({ abs, root, rel: path.join(rel, m[1]), kind: m[2], folder: stat.isDirectory() });
      } else if (stat.isDirectory()) await scan(root, abs, path.join(rel, name));
    }
  };
  for (const r of roots) await scan(r.root, r.dir, r.rel);
  return { found, skipped };
}
// Removes leftovers with the full safety rule: a file whose content is not
// kept elsewhere is archived under a pinned manifest first. dryRun is read-only.
async function cleanLeftovers({ switcherRoot, profiles, dryRun = false, confirm, olderThan, now, lock }) {
  if (!dryRun && confirm !== true) throw new Error('Removing leftover files requires confirmation');
  await assertStorePlain(switcherRoot);
  const { found, skipped } = await findLeftovers(switcherRoot, profiles, { olderThan, now });
  const items = [];
  for (const leftover of found) {
    const inner = leftover.folder ? await walk(leftover.abs) : { files: [{ abs: leftover.abs, rel: '', size: (await fs.lstat(leftover.abs)).size }], links: [] };
    if (inner.links.length) { skipped.push({ path: leftover.abs, reason: 'contains links; left unchanged' }); continue; }
    items.push({ ...leftover, files: inner.files.map(f => ({ abs: f.abs, size: f.size, rel: f.rel ? path.join(leftover.rel, f.rel) : leftover.rel, root: leftover.root })) });
  }
  if (dryRun) return { dryRun: true, leftovers: items.map(x => ({ path: x.abs, kind: x.kind, files: x.files.length, bytes: x.files.reduce((n, f) => n + f.size, 0) })), skipped };
  const live = await liveMap(switcherRoot, profiles);
  const result = { removed: 0, deleted: 0, deletedBytes: 0, moved: 0, manifests: [], skipped };
  for (const item of items) {
    await withStoreLock(switcherRoot, 'leftover cleanup', async () => {
      await assertStorePlain(switcherRoot);
      const { manifests, invalid } = await readManifests(switcherRoot);
      if (invalid.length) throw Object.assign(new Error(blockedMessage(invalid)), { code: 'EBLOCKED', unreadable: invalid.map(x => x.file) });
      const referenced = durableReferences(manifests);
      const { covered, cache } = coverage(switcherRoot, live, referenced);
      const stored = [];
      for (const f of item.files) {
        f.sha256 = (await hashFile(f.abs)).sha256;
        if (await covered(f, f.sha256, f.size)) continue;
        await putObjectFile(switcherRoot, f.abs, f.sha256, f.root);
        stored.push(f); cache.set(f.sha256, true);
      }
      if (stored.length) {
        const manifest = { id: newManifestId(), kind: 'maintenance', created: new Date().toISOString(), state: 'committed', pinned: true, objects: stored.map(f => ({ name: f.rel, sha256: f.sha256, size: f.size, reason: `leftover .${item.kind}- entry`, location: f.abs })) };
        await writeManifest(switcherRoot, manifest);
        for (const f of stored) referenced.add(f.sha256);
        result.manifests.push(manifest.id);
        result.moved += stored.length;
      }
      let kept = 0;
      for (const f of item.files) {
        try { await assertPlainPath(f.root, f.abs); } catch (e) { skipped.push({ path: f.abs, reason: e.message }); kept++; continue; }
        const stat = await lstatOrNull(f.abs);
        if (!stat?.isFile()) continue;
        cache.clear();
        const sha = (await hashFile(f.abs)).sha256;
        if (!(await covered(f, sha, stat.size))) { skipped.push({ path: f.abs, reason: 'content is not stored anywhere else' }); kept++; continue; }
        await fs.unlink(f.abs);
        result.deleted++; result.deletedBytes += stat.size;
      }
      if (item.folder) await pruneEmpty(item.abs);
      if (!kept && !(await lstatOrNull(item.abs))) result.removed++;
    }, lock);
  }
  return result;
}
function renderCleanupPlan(plan) {
  const list = (items, empty, line) => items.length ? items.map(line) : [empty];
  if (plan.blocked) return ['# Clean Redundant Backups (preview)', '', 'Read-only: nothing was changed.', '', '**Cleanup is blocked.** These backup manifests are unreadable, and one of them might hold the only record of some content:', '', ...plan.unreadable.map(f => `- ${f}`), '', 'Fix or remove them, then run Clean Redundant Backups again.'].join('\n') + '\n';
  return ['# Clean Redundant Backups (preview)', '', 'Read-only: nothing was changed. Each file is checked again immediately before it is deleted.', '',
    `Files to delete: ${plan.delete.length} (${formatBytes(plan.bytes)}).`, `Unique content moved into the archive first: ${plan.move.length} (${formatBytes(plan.movedBytes)}).`, `Net space freed: ${formatBytes(plan.net)}.`, `Skipped: ${plan.skipped.length}.`,
    '', '## To delete', '', ...list(plan.delete, 'Nothing.', f => `- ${f.path} (${formatBytes(f.size)}): ${f.reason}`),
    '', '## Moved into the archive first', '', ...list(plan.move, 'Nothing.', f => `- ${f.path} (${formatBytes(f.size)})`),
    '', '## Archived and kept', '', `Content found only in backups that cleanup does not delete (not committed, without a manifest, or in a profile with a pending recovery) is archived under a pinned backup; the backup files stay where they are. Files: ${(plan.archiveKept || []).length} (${formatBytes(plan.archiveKeptBytes || 0)} added to the archive).`, ...list(plan.archiveKept || [], 'Nothing.', f => `- ${f.path} (${formatBytes(f.size)})`),
    '', '## Snapshots without a manifest', '', ...list(plan.manifestless || [], 'None.', f => `- ${f.path} (${plural(f.files, 'file', 'files')}, ${formatBytes(f.bytes)}): removed only if you confirm this snapshot separately; every file is archived first and must rebuild from the archive`),
    '', '## Skipped', '', ...list(plan.skipped, 'Nothing.', f => `- ${f.path}: ${f.reason}`)].join('\n') + '\n';
}
function renderLeftovers(plan) {
  return ['# Leftover transfer files (preview)', '', 'Read-only: nothing was changed. Content that is not kept elsewhere is archived under a pinned backup before anything is deleted.', '',
    ...(plan.leftovers.length ? plan.leftovers.map(x => `- ${x.path} (.${x.kind}-, ${plural(x.files, 'file', 'files')}, ${formatBytes(x.bytes)})`) : ['Nothing to remove.']),
    '', '## Skipped', '', ...(plan.skipped.length ? plan.skipped.map(x => `- ${x.path}: ${x.reason}`) : ['Nothing.'])].join('\n') + '\n';
}
// Removes empty folders bottom-up with rmdir only. A snapshot's manifest.json
// goes once nothing else is left in that snapshot.
async function pruneEmpty(dir, snapshotRoot = false) {
  const stat = await lstatOrNull(dir);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  for (const name of await fs.readdir(dir)) { const child = path.join(dir, name); if ((await fs.lstat(child)).isDirectory()) await pruneEmpty(child); }
  let left = await fs.readdir(dir);
  if (snapshotRoot && left.length === 1 && left[0] === 'manifest.json' && path.basename(path.dirname(dir)) === '.profile-switch-backups') { await fs.unlink(path.join(dir, 'manifest.json')); left = []; }
  if (!left.length) await fs.rmdir(dir).catch(e => { if (e.code !== 'ENOTEMPTY') throw e; });
}

// ---- Verify ----------------------------------------------------------------

async function verify({ switcherRoot, profiles, alive, list, full = false }) {
  archiveOf(switcherRoot).startRun();
  const result = await verifyStore({ switcherRoot, profiles, alive, list });
  // A3: every pack block's CRC, plus a sample of rebuilds (all with full).
  try {
    await assertStorePlain(switcherRoot);
    const a = archiveOf(switcherRoot);
    if (await a.exists()) {
      const check = await a.check({ full });
      for (const t of check.torn) result.notes.push(`Archive file ${t}: ends with an incomplete write from an interruption; that part is ignored and nothing is lost.`);
      for (const f of check.failed) result.problems.push(`Archived version ${f.sha256} does not rebuild: ${f.error}`);
      result.notes.push(`Archive: ${plural(check.packs, 'pack', 'packs')}, ${plural(check.blocks, 'block', 'blocks')} checked by CRC; ${check.rebuilt} of ${plural(check.recipes, 'version', 'versions')} rebuilt${full ? '' : ' (sample)'}.`);
      const legacy = await legacyObjects(switcherRoot);
      if (legacy.length) result.notes.push(`${plural(legacy.length, 'object is', 'objects are')} still in the old recovery store; Manage Storage can move them into the archive.`);
    }
  } catch (e) { result.problems.push(`Archive: ${e.message}`); }
  result.ok = !result.problems.length;
  return result;
}
async function verifyStore({ switcherRoot, profiles, alive, list }) {
  const p = paths(switcherRoot), problems = [], notes = [];
  const marker = await migrationMarker(switcherRoot, { alive, list }).catch(() => null);
  if (marker?.stale) problems.push(`A leftover migration marker (PID ${marker.pid}, started ${localTime(marker.started)}) blocks switching. Clear it with Manage Storage, Clear Migration Marker.`);
  else if (marker) notes.push(`A migration is being prepared by PID ${marker.pid} (started ${localTime(marker.started)}).`);
  const owner = await readStoreLock(switcherRoot);
  if (owner) notes.push(`Storage lock held by ${describeOwner(owner)}.`);
  const journal = await readJournal(switcherRoot).catch(e => { problems.push(e.message); return null; });
  if (journal?.state === 'running') problems.push(`A ${journal.kind} is in progress or was interrupted; resume or roll it back.`);
  for (const entry of (await readRecovery(switcherRoot)) || []) problems.push(`Transfer recovery required: ${entry.destination || ''} ${entry.error || ''} (kept: ${(entry.asides || []).join(', ') || 'see manifest'}).`);
  let members = 0;
  for (const profile of profiles) {
    const statuses = {};
    for (const name of SHAREABLE) {
      const link = path.join(profile.directory, name), stat = await lstatOrNull(link);
      statuses[name] = await folderStatus(profile.directory, name, switcherRoot);
      if (stat?.isSymbolicLink() && statuses[name] !== 'linked') problems.push(`${profile.name}: ${name} is a link that does not resolve to ${path.join(p.shared, name)} (missing target or link to another location). Claude would start with an empty history.`);
    }
    const linked = SHAREABLE.filter(n => statuses[n] === 'linked');
    if (linked.length) members++;
    if (linked.length && !journal?.members?.[normalize(profile.directory)]) problems.push(`${profile.name} uses shared storage, but no recorded migration joined it.`);
    if (linked.length && linked.length < SHAREABLE.length) problems.push(`${profile.name}: only ${linked.join(', ')} ${linked.length === 1 ? 'is' : 'are'} shared.`);
  }
  if (members) {
    for (const name of SHAREABLE) { const s = await lstatOrNull(path.join(p.shared, name)); if (!s?.isDirectory() || s.isSymbolicLink()) problems.push(`shared/${name} is missing or not a plain folder.`); }
    const found = { links: [] };
    for (const name of SHAREABLE) found.links.push(...(await walk(path.join(p.shared, name))).links);
    for (const l of found.links) problems.push(`Link inside shared storage: ${l}`);
  }
  for (const dir of [p.shared, ...SHAREABLE.map(name => path.join(p.shared, name)), p.backups, p.objects, p.manifests]) {
    try { await assertPlainPath(p.root, dir, { allowMissing: true }); } catch (e) { problems.push(e.message); }
  }
  const temps = await staleTemps(switcherRoot).catch(() => []);
  if (temps.length) notes.push(`${plural(temps.length, 'leftover temporary file', 'leftover temporary files')} from an interrupted write (${temps.map(t => path.basename(t.file)).join(', ')}); the next garbage collection removes ${temps.length === 1 ? 'it' : 'them'}.`);
  const { manifests, invalid } = await readManifests(switcherRoot).catch(e => { problems.push(e.message); return { manifests: [], invalid: [] }; });
  for (const bad of invalid) problems.push(`Unreadable manifest ${bad.file}: ${bad.reason}`);
  let objects = 0;
  for (const m of manifests) for (const o of m.objects || []) {
    objects++;
    if (!SHA.test(String(o.sha256))) { problems.push(`Manifest ${m.id}: invalid object hash for ${o.name}.`); continue; }
    if (!(await objectValid(switcherRoot, o.sha256, o.size).catch(() => false))) problems.push(`Manifest ${m.id}: object ${o.sha256} for ${o.name} is missing or damaged.`);
  }
  notes.push(`${plural(members, 'profile uses', 'profiles use')} shared storage; ${plural(manifests.length, 'backup manifest', 'backup manifests')}; ${plural(objects, 'stored file reference', 'stored file references')} checked.`);
  return { ok: !problems.length, problems, notes };
}
function renderRecovery(entries) {
  const known = value => value || 'unknown';
  return ['# Transfer recovery required', '', 'Carrying a conversation failed and could not undo itself. Switching and carrying conversations between the affected profiles are blocked until this is resolved.', '',
    ...entries.flatMap((e, i) => [`## ${e.created ? localTime(e.created) : `Entry ${i + 1}`}${e.sessionId ? `, conversation ${e.sessionId}` : ''}`, '',
      `- Destination: ${known(e.destination)}`, `- Error: ${known(e.error)}`, `- Recovery error: ${known(e.recoveryError)}`, `- Previous files kept at: ${(e.asides || []).join(', ') || 'none'}`, `- Backup manifest: ${e.manifest || 'none'}`, '']),
    '## What to do', '', '1. Rename each kept .old- entry back to its original name, or check that the current file is correct.', '2. Choose Mark Resolved in the notification. If the notification has closed, open Manage Storage again or run Notifications: Show Notifications.'].join('\n') + '\n';
}
function renderVerify(result) {
  return ['# Storage integrity', '', result.ok ? 'No problems found.' : `${plural(result.problems.length, 'problem', 'problems')} found:`, '', ...result.problems.map(s => `- ${s}`), '', ...result.notes.map(s => `- ${s}`)].join('\n') + '\n';
}

// ---- Gate 5: diverged versions ------------------------------------------------

// Read-only. Every unique version of every diverged group (transcripts and
// checkpoints) and where it is kept: live (a working copy), the archive under
// a pinned backup, or the archive's capture catalog. A version kept nowhere
// yet exists only in old backups; cleanup moves it into the archive (pinned)
// before deleting anything. With `expect` (an earlier result), each listed
// version is confirmed by a full rebuild from the archive instead.
async function reconcileDiverged({ switcherRoot, profiles, expect, signal, onProgress }) {
  archiveOf(switcherRoot).startRun();
  if (expect) {
    const groups = [];
    let confirmed = 0, missing = 0;
    const a = archiveOf(switcherRoot);
    const catalog = (await a.exists()) ? await a.readCatalog() : { keys: {} };
    for (const g of expect.groups) {
      const versions = [];
      for (const v of g.versions) {
        checkCancelled(signal);
        let kept = (await objectValid(switcherRoot, v.sha256, v.size).catch(() => false)) ? 'archive' : null;
        // Retention drops a version that is a byte prefix of a newer archived
        // one: it is still kept, inside that newer version (rebuilt and checked).
        if (!kept) kept = (await insideNewer(switcherRoot, v, [...(catalog.keys[fold(g.rel)] || []), ...g.versions])) ? 'inside a newer version' : null;
        if (kept) confirmed++; else missing++;
        versions.push({ ...v, confirmed: !!kept, kept: kept ? [kept] : [] });
      }
      groups.push({ ...g, versions });
    }
    return { created: new Date().toISOString(), confirm: true, groups, versions: confirmed + missing, confirmed, missing };
  }
  const analysis = await analyze({ switcherRoot, profiles, processes: false, signal, onProgress });
  const liveRoots = profiles.flatMap(p => SHAREABLE.map(n => path.join(p.directory, n)));
  const isLive = abs => liveRoots.some(r => inside(r, abs) && normalize(r) !== normalize(abs));
  const a = archiveOf(switcherRoot);
  const inCatalog = new Set();
  if (await a.exists()) for (const list of Object.values((await a.readCatalog()).keys)) for (const v of list) inCatalog.add(v.sha256);
  const pinned = durableReferences((await readManifests(switcherRoot)).manifests);
  // Whether a backup location is one cleanup keeps (an uncommitted or
  // manifest-less snapshot, or any backup of a profile with a pending recovery).
  const keptBackup = async loc => {
    const profile = profiles.find(p => inside(p.directory, loc));
    if (!profile) return false;
    if (await lstatOrNull(path.join(profile.directory, '.profile-switch-lock'))) return true;
    const parts = path.relative(profile.directory, loc).split(path.sep);
    return parts[0] === '.profile-switch-backups' && parts.length > 2 && (await snapshotState(path.join(profile.directory, parts[0], parts[1]))) !== 'committed';
  };
  const groups = [];
  let unkept = 0, count = 0;
  for (const g of analysis.groups.filter(x => x.classification === 'diverged')) {
    const versions = [];
    for (const v of g.versions) {
      const kept = [];
      if (v.locations.some(isLive)) kept.push('live');
      if (pinned.has(v.sha256) && await objectPresent(switcherRoot, v.sha256, v.size).catch(() => false)) kept.push('archive (pinned backup)');
      if (inCatalog.has(v.sha256)) kept.push('archive (captured)');
      if (!kept.length) unkept++;
      count++;
      let plan = null;
      if (!kept.length) {
        const backups = v.locations.filter(l => !isLive(l));
        const allKept = backups.length > 0 && (await Promise.all(backups.map(keptBackup))).every(Boolean);
        plan = allKept ? 'only in backups that cleanup keeps (not committed, or a profile with a pending recovery): cleanup archives it under a pinned backup and leaves those backups in place'
          : 'only in old backups: cleanup moves it into the archive under a pinned backup before deleting them';
      }
      versions.push({ sha256: v.sha256, size: v.size, locations: v.locations, kept, plan });
    }
    groups.push({ rel: g.rel, kind: fold(g.rel).startsWith('file-history/') ? 'checkpoint' : 'transcript', versions });
  }
  return { created: new Date().toISOString(), confirm: false, groups, versions: count, unkept };
}
// Whether `v` is a byte prefix of a larger archived version of the same file:
// that version is rebuilt (verifying its SHA-256) and its first v.size bytes hashed.
async function insideNewer(switcherRoot, v, candidates) {
  const a = archiveOf(switcherRoot), tried = new Set();
  for (const c of candidates) {
    if (!SHA.test(String(c.sha256)) || c.sha256 === v.sha256 || tried.has(c.sha256) || !(c.size > v.size)) continue;
    tried.add(c.sha256);
    if (!(await a.hasRecipe(c.sha256))) continue;
    const hash = crypto.createHash('sha256');
    let taken = 0;
    try {
      await a.rebuild(c.sha256, chunk => {
        if (taken >= v.size) return;
        const part = chunk.subarray(0, Math.min(chunk.length, v.size - taken));
        hash.update(part);
        taken += part.length;
      });
    } catch { continue; }
    if (taken === v.size && hash.digest('hex') === v.sha256) return true;
  }
  return false;
}
function renderReconcile(result) {
  const head = result.confirm
    ? ['## Diverged versions: confirmation', '', `${result.confirmed} of ${plural(result.versions, 'version', 'versions')} rebuilt from the archive to their SHA-256 (directly, or inside a newer archived version).${result.missing ? ` ${result.missing} did not: they are listed below.` : ' Every one is preserved.'}`]
    : ['## Diverged versions', '', `${plural(result.groups.length, 'conversation or checkpoint has', 'conversations or checkpoints have')} diverged versions (${plural(result.groups.filter(g => g.kind === 'transcript').length, 'conversation', 'conversations')}, ${plural(result.groups.filter(g => g.kind === 'checkpoint').length, 'checkpoint', 'checkpoints')}), ${plural(result.versions, 'unique version', 'unique versions')} in all. Each is kept as listed. ${result.unkept === 1 ? '1 exists' : `${result.unkept} exist`} only in old backups; cleanup archives ${result.unkept === 1 ? 'it' : 'each one'} (pinned) before anything is deleted, and leaves backups it does not clean in place.`];
  const lines = [];
  for (const g of result.groups) {
    lines.push('', `- ${g.rel} (${g.kind})`);
    for (const v of g.versions) lines.push(`  - ${v.sha256.slice(0, 12)} (${formatBytes(v.size)}): ${result.confirm ? (v.confirmed ? (v.kept?.[0] === 'inside a newer version' ? 'kept inside a newer archived version (rebuilt and checked)' : 'rebuilt from the archive') : '**not in the archive**') : (v.kept.length ? v.kept.join(', ') : v.plan)}`);
  }
  return [...head, ...(lines.length ? lines : ['', 'None.'])].join('\n') + '\n';
}

module.exports = {
  SHAREABLE, discardOutcome, reconcileDiverged, renderReconcile, readCleanupOverrides, accountIdentities, profileDirectories, captureStatus, assertCaptureCurrent, renameReplacing, isLinkable, identityBytes, externalNames, walk, collect, DAY, LEFTOVER, paths, normalize, realpath, staleTemps, removeStaleTemps, assertPlainPath, assertSharedPlain, assertStorePlain, managedLink, folderStatus, isPoolMember, poolMembers, removeLink, removeTree, writeAtomic, hashFile,
  acquireStoreLock, withStoreLock, readStoreLock, releaseStaleLock, readJournal, assertNoMigration, assertNoMigrationPending, migrationMarker, clearMigrationMarker, readRecovery, recordRecovery, recoveryId, assertNoRecovery, resolveRecovery,
  putObject, putObjectFile, objectValid, objectPresent, readObject, storedObjects, legacyObjects, importObjects, compactArchive, capture, archivedVersions, discardVersions, exportVersion, restoreVersion, exportManifest, findLeftovers, cleanLeftovers, renderLeftovers, archiveOf, manifestPath, newManifestId, writeManifest, readManifests, gc, discardManifests,
  METRICS, metricValue, folderLabel, backupLabel, localTime, stopClaudeMessage, renderRecovery,
  listProcesses, isClaudeProcess, detectClaudeProcesses, livePids, assertClaudeStopped,
  analyze, measure, renderReport, formatBytes, migrate, resumeMigration, rollback, cleanup, renderCleanupPlan, verify, renderVerify
};
