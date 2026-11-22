'use strict';
// Hard-linked transcripts (decision 12: T1-T5, M1-M5; decision 13: only
// .jsonl transcripts and subagent transcripts are ever linked; every other
// file is copied). Transcripts are append-only, so the names of one linked
// file always show one conversation. Deleting a name (Claude's sweep, the
// user) leaves the other names and the archive intact.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('./storage');

const UUID_TEMP = /\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identity = stat => `${stat.dev}:${stat.ino}`;
async function statId(file) { try { return await fs.lstat(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } }
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- Link or copy (T3, T5) ---------------------------------------------------

// Cloud-synced folders (OneDrive from the environment; Dropbox, Google Drive,
// iCloud and OneDrive folders by name) get copies, never links.
const CLOUD_NAMES = /^(dropbox|google ?drive|icloud ?drive|onedrive( - .+)?)$/i;
function cloudRoots(env = process.env) { return ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'].map(k => env[k]).filter(v => typeof v === 'string' && path.isAbsolute(v)); }
function cloudSynced(abs, roots = cloudRoots()) {
  const target = storage.normalize(abs);
  if (roots.some(r => { const base = storage.normalize(r); return target === base || target.startsWith(base + path.sep); })) return true;
  return path.resolve(abs).split(path.sep).some(part => CLOUD_NAMES.test(part));
}
const FALLBACK = { EXDEV: 'different volume', EPERM: 'links are not permitted here', EACCES: 'links are not permitted here', ENOTSUP: 'the file system does not support links', ENOSYS: 'the file system does not support links', EMLINK: 'the file has too many links' };
// Creates `temp` as a new name of `source`. Returns { linked: true, id } or
// { linked: false, reason } when the caller must copy instead (T3).
async function tryLink(source, temp, { destinationDir, cloud = cloudRoots() } = {}) {
  const s = await fs.lstat(source, { bigint: true });
  const d = await fs.lstat(destinationDir, { bigint: true });
  if (s.dev !== d.dev) return { linked: false, reason: FALLBACK.EXDEV };
  if (cloudSynced(source, cloud) || cloudSynced(temp, cloud)) return { linked: false, reason: 'cloud-synced folder' };
  try { await fs.link(source, temp); }
  catch (e) { if (FALLBACK[e.code]) return { linked: false, reason: FALLBACK[e.code] }; throw e; }
  const t = await fs.lstat(temp, { bigint: true });
  if (identity(t) !== identity(s)) { await fs.unlink(temp).catch(() => {}); throw new Error(`The link for ${source} did not resolve to the same file`); }
  return { linked: true, id: identity(s) };
}
// Profile folders whose names for `rel` count as known: every switcher
// profile plus the given ones (Default, source, destination).
async function knownDirectories(switcherRoot, extra = []) {
  const dirs = new Set(extra.filter(Boolean).map(d => path.resolve(d)));
  const base = storage.paths(switcherRoot).profiles;
  let names = [];
  try { names = await fs.readdir(base); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const n of names) { const s = await statId(path.join(base, n)); if (s?.isDirectory()) dirs.add(path.join(base, n)); }
  return [...dirs];
}
async function knownNames(rel, id, directories) {
  let n = 0;
  const seen = new Set();
  for (const dir of directories) {
    const file = path.join(dir, rel), key = storage.normalize(file);
    if (seen.has(key)) continue;
    seen.add(key);
    const s = await statId(file);
    if (s?.isFile() && identity(s) === id) n++;
  }
  return n;
}
// T5: a file with more names than the known profile folders hold may be a
// planted link to something else (a credentials file), or a name Claude Code
// keeps elsewhere (it links subagent transcripts into its temp tasks folder).
// Such a file is never linked; transfers copy it instead.
async function hasUnknownNames(file, rel, directories) {
  const s = await fs.lstat(file, { bigint: true });
  if (!s.isFile()) throw new Error(`${file} is not a plain file`);
  if (s.nlink <= 1n) return false;
  return BigInt(await knownNames(rel, identity(s), directories)) < s.nlink;
}
const OUTSIDE_NAMES = 'has names outside the Claude profile folders';
// I1: identities of the account files in each known profile folder (and any
// extra files, such as ~/.claude.json). A bundle file with one of these
// identities is a planted link and is never carried.
// One implementation, shared with capture (storage.js).
const accountIdentities = (directories, extraFiles) => storage.accountIdentities(directories, extraFiles);
// The rule of validateTranscript, for a transcript carried by copy because it
// has names elsewhere: every non-empty line is a JSON object, any sessionId is
// this session's, and at least one line carries it.
function isSessionTranscript(data, id) {
  let matched = false;
  for (const text of data.toString('utf8').split('\n')) {
    if (!text.trim()) continue;
    let row;
    try { row = JSON.parse(text); } catch { return false; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (row.sessionId !== undefined) { if (row.sessionId !== id) return false; matched = true; }
  }
  return matched;
}
async function assertKnownNames(file, rel, directories) {
  const s = await fs.lstat(file, { bigint: true });
  if (!s.isFile()) throw new Error(`${file} is not a plain file`);
  if (s.nlink <= 1n) return s;
  const known = await knownNames(rel, identity(s), directories);
  if (BigInt(known) < s.nlink) throw Object.assign(new Error(`${file} has ${s.nlink} names, but only ${known} of them are in Claude profile folders. It is not linked or copied; check where the other names come from.`), { code: 'EUNKNOWNLINK' });
  return s;
}

// ---- Plan (read-only) ----------------------------------------------------------

// Groups the profiles' linkable transcripts by path and content. Identical
// copies with different identities can become one file; bytes saved count each
// identity once, and only when every one of its names is replaced.
// Names on another volume cannot share a file, and cloud-synced folders are
// never linked (T3): those are grouped per volume, or skipped and reported.
async function planLinks({ switcherRoot, profiles, cloudRoots: cloud = cloudRoots() }) {
  const records = [], skipped = [], all = [];
  for (const profile of profiles) {
    const status = await storage.folderStatus(profile.directory, 'projects', switcherRoot);
    const locked = !!(await statId(path.join(profile.directory, '.profile-switch-lock')));
    for (const name of storage.SHAREABLE) {
      if ((await storage.folderStatus(profile.directory, name, switcherRoot)) !== 'private') continue;
      for (const f of (await storage.walk(path.join(profile.directory, name))).files) all.push(f);
    }
    if (status !== 'private') continue;
    if (locked) { skipped.push({ path: profile.directory, reason: 'transfer recovery pending (.profile-switch-lock)' }); }
    for (const f of (await storage.walk(path.join(profile.directory, 'projects'))).files) {
      const rel = path.join('projects', f.rel);
      if (!storage.isLinkable(rel) || f.rel.split(path.sep).some(p => storage.LEFTOVER.test(p))) continue;
      if (cloudSynced(f.abs, cloud)) { skipped.push({ path: f.abs, reason: 'in a cloud-synced folder; never linked' }); continue; }
      records.push({ ...f, rel, root: profile.directory, profile: profile.id, locked });
    }
  }
  const ids = new Map();
  for (const r of records) {
    if (!ids.has(r.id)) ids.set(r.id, { id: r.id, size: r.size, mtimeMs: r.mtimeMs, nlink: r.nlink, names: [] });
    ids.get(r.id).names.push(r);
  }
  for (const x of ids.values()) x.sha256 = (await storage.hashFile(x.names[0].abs)).sha256;
  const groups = new Map(), versions = new Map();
  const volumes = new Map();
  for (const x of ids.values()) {
    const content = `${fold(x.names[0].rel)}\0${x.sha256}`, dev = x.id.split(':')[0];
    // Only names on the same volume can become one file.
    const key = `${content}\0${dev}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
    if (!volumes.has(content)) volumes.set(content, new Set());
    volumes.get(content).add(dev);
    if (!versions.has(content)) versions.set(content, { rel: x.names[0].rel, sha256: x.sha256, size: x.size, source: x.names[0].abs, root: x.names[0].root });
  }
  for (const [content, devs] of volumes) if (devs.size > 1) skipped.push({ path: versions.get(content).rel, reason: `identical copies are on ${devs.size} volumes; they are linked only within each volume` });
  const plan = [];
  let saved = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keeper = list.reduce((a, b) => (b.mtimeMs > a.mtimeMs || (b.mtimeMs === a.mtimeMs && b.names.length > a.names.length) ? b : a));
    const rel = keeper.names[0].rel;
    if (keeper.nlink > keeper.names.length) { skipped.push({ path: keeper.names[0].abs, reason: `has ${keeper.nlink} names, only ${keeper.names.length} in profile folders; not linked` }); continue; }
    if (keeper.names.some(n => n.locked)) { skipped.push({ path: keeper.names[0].abs, reason: 'its profile has a pending transfer recovery' }); continue; }
    const targets = [];
    for (const x of list.filter(x => x !== keeper)) {
      if (x.nlink > x.names.length) { skipped.push({ path: x.names[0].abs, reason: `has ${x.nlink} names, only ${x.names.length} in profile folders; not linked` }); continue; }
      if (x.names.some(n => n.locked)) { skipped.push({ path: x.names[0].abs, reason: 'its profile has a pending transfer recovery' }); continue; }
      for (const n of x.names) targets.push({ abs: n.abs, root: n.root, id: x.id, size: x.size, step: 'pending' });
      saved += x.size;
    }
    if (targets.length) plan.push({ rel, sha256: keeper.sha256, size: keeper.size, keeper: { abs: keeper.names[0].abs, root: keeper.names[0].root, id: keeper.id }, targets });
  }
  const before = storage.identityBytes(all);
  const archive = await storage.archiveOf(switcherRoot).bytes().catch(() => 0);
  return { created: new Date().toISOString(), groups: plan, versions: [...versions.values()], files: records.length, identities: ids.size, saved, before, after: before - saved, archive, skipped };
}
const fold = rel => { const p = rel.split(/[\\/]/).join('/'); return process.platform === 'win32' ? p.toLowerCase() : p; };
function renderLinkPlan(plan) {
  const f = storage.formatBytes;
  const names = plan.groups.reduce((n, g) => n + g.targets.length, 0);
  return ['# Link identical conversations (preview)', '', 'Read-only: nothing was changed.', '',
    `Identical transcript copies that become one file: ${plural(names, 'name', 'names')} in ${plural(plan.groups.length, 'group', 'groups')}.`,
    `Profile history now: ${f(plan.before)} (each file counted once). After linking: ${f(plan.after)}, saving ${f(plan.saved)}. The archive currently uses ${f(plan.archive)}; every distinct version is archived first.`, '',
    'Only `.jsonl` transcripts and subagent transcripts are linked. Checkpoints (file-history), images and every other file stay separate copies.',
    'After linking, those profiles share each linked conversation: never continue one conversation in two profiles at once.', '',
    '## Groups', '', ...(plan.groups.length ? plan.groups.map(g => `- ${g.rel} (${f(g.size)}): keeps ${g.keeper.abs}; links ${g.targets.map(t => t.abs).join(', ')}`) : ['Nothing to link.']),
    '', '## Skipped', '', ...(plan.skipped.length ? plan.skipped.map(s => `- ${s.path}: ${s.reason}`) : ['Nothing.'])].join('\n') + '\n';
}

// ---- Journaled linking and undo (M1-M5) ---------------------------------------

const readLinkJournal = async switcherRoot => {
  try { return JSON.parse(await fs.readFile(storage.paths(switcherRoot).links, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Cannot read link-migration.json (${e.message}). Fix or remove it first.`); }
};
const writeLinkJournal = (switcherRoot, journal) => storage.writeAtomic(storage.paths(switcherRoot).links, JSON.stringify(journal, null, 2), storage.paths(switcherRoot).root);
// Every path in the journal must be a linkable transcript inside a listed
// profile's projects folder; temps must be this module's exact names (M5).
// I2: profile folders must be direct children of <switcherRoot>/profiles or
// the Default root; versions and groups must stay inside listed profiles.
const DEFAULT_ROOT = () => path.join(require('node:os').homedir(), '.claude');
function assertLinkJournal(journal, switcherRoot, defaultRoot = DEFAULT_ROOT()) {
  const base = storage.normalize(storage.paths(switcherRoot).profiles);
  if (!Array.isArray(journal.profiles) || !Array.isArray(journal.groups) || !Array.isArray(journal.versions)) throw new Error('link-migration.json is incomplete');
  for (const p of journal.profiles) {
    if (typeof p.directory !== 'string' || !path.isAbsolute(p.directory)) throw new Error(`link-migration.json names an invalid profile folder: ${p.directory}`);
    const dir = storage.normalize(p.directory);
    if (storage.normalize(path.dirname(path.resolve(p.directory))) !== base && dir !== storage.normalize(defaultRoot)) throw new Error(`link-migration.json names a folder that is not a Claude profile: ${p.directory}`);
  }
  const dirs = journal.profiles.map(p => path.resolve(p.directory));
  const check = (abs, root) => {
    if (typeof abs !== 'string' || !path.isAbsolute(abs) || !dirs.some(d => storage.normalize(d) === storage.normalize(root))) throw new Error(`link-migration.json names a path outside the listed profiles: ${abs}`);
    const rel = path.relative(path.resolve(root), path.resolve(abs));
    if (rel.startsWith('..') || path.isAbsolute(rel) || !storage.isLinkable(rel)) throw new Error(`link-migration.json names a file that may not be linked: ${abs}`);
  };
  for (const v of journal.versions) {
    if (!/^[a-f0-9]{64}$/.test(String(v.sha256)) || !Number.isSafeInteger(v.size) || v.size < 0) throw new Error('link-migration.json names an invalid version');
    check(v.source, v.root);
  }
  for (const g of journal.groups) {
    if (!/^[a-f0-9]{64}$/.test(String(g.sha256))) throw new Error('link-migration.json names an invalid hash');
    check(g.keeper.abs, g.keeper.root);
    for (const t of g.targets) {
      check(t.abs, t.root);
      for (const temp of [t.temp, t.copyTemp]) if (temp != null && !(temp.startsWith(`${t.abs}.tmp-`) && UUID_TEMP.test(temp))) throw new Error(`link-migration.json names an invalid temporary file: ${temp}`);
    }
  }
}
async function removeName(file, root) {
  await storage.assertPlainPath(root, file);
  await fs.unlink(file);
}
async function linkIdentical({ switcherRoot, profiles, dryRun = false, confirm, detect, alive, interrupt, lock, defaultRoot }) {
  if (dryRun) return planLinks({ switcherRoot, profiles });
  if (confirm !== true) throw new Error('Linking identical conversations requires confirmation');
  await storage.assertNoMigration(switcherRoot);
  await storage.assertNoRecovery(switcherRoot);
  await storage.assertClaudeStopped(profiles, { detect, alive });
  return storage.withStoreLock(switcherRoot, 'migration (link identical conversations)', async () => {
    await storage.assertNoMigration(switcherRoot);
    await storage.assertStorePlain(switcherRoot);
    const plan = await planLinks({ switcherRoot, profiles });
    const journal = { version: 1, kind: 'link', id: crypto.randomUUID(), state: 'running', started: new Date().toISOString(), manifest: storage.newManifestId(), archived: false,
      profiles: profiles.map(p => ({ id: p.id, name: p.name, directory: path.resolve(p.directory) })), versions: plan.versions, groups: plan.groups, saved: plan.saved };
    assertLinkJournal(journal, switcherRoot, defaultRoot);
    await writeLinkJournal(switcherRoot, journal);
    return runLinks(switcherRoot, journal, { interrupt });
  }, lock);
}
async function resumeLinks({ switcherRoot, confirm, detect, alive, interrupt, lock, defaultRoot }) {
  if (confirm !== true) throw new Error('Resuming requires confirmation');
  const journal = await readLinkJournal(switcherRoot);
  if (journal?.state !== 'running') throw new Error('No interrupted linking to resume');
  assertLinkJournal(journal, switcherRoot, defaultRoot);
  await storage.assertClaudeStopped(journal.profiles, { detect, alive });
  return storage.withStoreLock(switcherRoot, 'migration (link identical conversations, resume)', async () => {
    const current = await readLinkJournal(switcherRoot);
    if (current?.id !== journal.id || current.state !== 'running') throw new Error('The interrupted linking changed while waiting. Open Manage Storage again.');
    assertLinkJournal(current, switcherRoot, defaultRoot);
    return current.undo ? runUndo(switcherRoot, current, { interrupt }) : runLinks(switcherRoot, current, { interrupt });
  }, lock);
}
async function runLinks(switcherRoot, journal, { interrupt = async () => {} } = {}) {
  const save = async step => { await writeLinkJournal(switcherRoot, journal); await interrupt(step, journal); };
  try {
    if (!journal.archived) {
      // M1: every distinct version is archived under a pinned manifest and
      // verified by rebuild before any name is replaced.
      const manifest = { id: journal.manifest, kind: 'link-migration', created: journal.started, state: 'prepared', pinned: true, objects: journal.versions.map(v => ({ name: v.rel, sha256: v.sha256, size: v.size, reason: 'archived before linking', location: v.source })) };
      await storage.writeManifest(switcherRoot, manifest);
      for (const v of journal.versions) await storage.putObjectFile(switcherRoot, v.source, v.sha256, v.root);
      for (const v of journal.versions) if (!(await storage.objectValid(switcherRoot, v.sha256, v.size))) throw new Error(`${v.source} did not rebuild from the archive`);
      manifest.state = 'committed';
      await storage.writeManifest(switcherRoot, manifest);
      journal.archived = true;
      await save('archived');
    }
    let linked = 0;
    for (const group of journal.groups) for (const target of group.targets) { if (await linkTarget(group, target, save, interrupt)) linked++; }
    // Bytes saved count each replaced identity once, only when every one of its
    // names was linked; a kept name (changed since the plan) saves nothing.
    const kept = journal.groups.flatMap(g => g.targets.filter(t => t.step === 'kept'));
    const keptIds = new Set(kept.map(t => t.id));
    const saved = [...new Map(journal.groups.flatMap(g => g.targets.filter(t => !keptIds.has(t.id)).map(t => [t.id, t.size]))).values()].reduce((n, s) => n + s, 0);
    journal.state = 'committed';
    journal.finished = new Date().toISOString();
    journal.saved = saved;
    await save('committed');
    return { linked, groups: journal.groups.length, saved, kept: kept.map(t => ({ path: t.abs, reason: t.reason })), manifest: journal.manifest };
  } catch (error) {
    if (error.simulatedCrash) throw error;
    let note;
    try { await runUndo(switcherRoot, journal, {}); note = 'Every name that was linked was given its own copy again; nothing was deleted.'; }
    catch (e) { note = `Automatic undo did not finish (${e.message}). Run Undo Conversation Linking; link-migration.json records every step.`; }
    throw new Error(`Linking stopped: ${error.message}. ${note}`);
  }
}
// One replacement (M2): link the keeper to a temp name, rename it over the
// target, then confirm the file identity and the hash.
async function linkTarget(group, t, save, interrupt) {
  if (t.step === 'done' || t.step === 'kept') return false;
  const keeper = group.keeper;
  await storage.assertPlainPath(keeper.root, keeper.abs);
  await storage.assertPlainPath(t.root, t.abs, { allowMissing: true });
  const k = await statId(keeper.abs);
  if (!k?.isFile() || identity(k) !== keeper.id) throw new Error(`${keeper.abs} changed since it was planned`);
  if (t.step === 'pending') {
    const cur = await statId(t.abs);
    if (!cur?.isFile()) throw new Error(`${t.abs} is missing or not a plain file`);
    if (identity(cur) !== keeper.id) {
      if (identity(cur) !== t.id || (await storage.hashFile(t.abs)).sha256 !== group.sha256) throw new Error(`${t.abs} changed since it was planned`);
    }
    t.temp = `${t.abs}.tmp-${crypto.randomUUID()}`;
    t.step = 'linking';
    await save(`linking:${t.abs}`);
  }
  if (t.step === 'linking') {
    const cur = await statId(t.abs), temp = await statId(t.temp);
    if (cur && identity(cur) === keeper.id) {
      if (temp) { if (identity(temp) !== keeper.id) throw new Error(`Unexpected file at ${t.temp}`); await removeName(t.temp, t.root); }
    } else {
      if (!cur || identity(cur) !== t.id) throw new Error(`${t.abs} changed while linking`);
      if (!temp) { await fs.link(keeper.abs, t.temp); await interrupt(`temp-linked:${t.abs}`); }
      else if (identity(temp) !== keeper.id) throw new Error(`Unexpected file at ${t.temp}`);
      // The target still has its own identity: re-check its content right
      // before the rename. Anything written since the plan (for example an
      // append between a crash and the resume) keeps the target as it is.
      if ((await storage.hashFile(t.abs)).sha256 !== group.sha256) {
        await removeName(t.temp, t.root);
        t.step = 'kept';
        t.reason = 'changed since it was planned; kept as its own file';
        await save(`kept:${t.abs}`);
        return false;
      }
      await storage.assertPlainPath(t.root, t.temp);
      await storage.renameReplacing(t.temp, t.abs);
      await interrupt(`renamed:${t.abs}`);
    }
    const after = await statId(t.abs);
    if (!after || identity(after) !== keeper.id) throw new Error(`${t.abs} is not linked to ${keeper.abs}`);
    if ((await storage.hashFile(t.abs)).sha256 !== group.sha256) throw new Error(`${t.abs} does not hold the planned content`);
    t.step = 'done';
    await save(`done:${t.abs}`);
    return true;
  }
  return false;
}
// M4: each linked name becomes a separate copy again (temp file, verify,
// rename), after a free-space check. Claude must be stopped.
async function undoLinks({ switcherRoot, confirm, detect, alive, interrupt, lock, freeSpace, defaultRoot }) {
  if (confirm !== true) throw new Error('Undoing conversation linking requires confirmation');
  const journal = await readLinkJournal(switcherRoot);
  if (!journal || !['running', 'committed'].includes(journal.state)) throw new Error('There is no conversation linking to undo');
  assertLinkJournal(journal, switcherRoot, defaultRoot);
  await storage.assertClaudeStopped(journal.profiles, { detect, alive });
  return storage.withStoreLock(switcherRoot, 'rollback (linked conversations)', async () => {
    const current = await readLinkJournal(switcherRoot);
    if (current?.id !== journal.id) throw new Error('Conversation linking changed while waiting. Open Manage Storage again.');
    assertLinkJournal(current, switcherRoot, defaultRoot);
    return runUndo(switcherRoot, current, { interrupt, freeSpace });
  }, lock);
}
async function available(dir) { const s = await fs.statfs(dir, { bigint: true }); return Number(s.bavail * s.bsize); }
async function runUndo(switcherRoot, journal, { interrupt = async () => {}, freeSpace = available } = {}) {
  const save = async step => { await writeLinkJournal(switcherRoot, journal); await interrupt(step, journal); };
  const pending = journal.groups.flatMap(g => g.targets.filter(t => !t.undone && t.step !== 'pending').map(t => ({ g, t })));
  const need = pending.reduce((n, x) => n + x.t.size, 0);
  for (const dir of new Set(journal.profiles.map(p => p.directory))) {
    const free = await freeSpace(dir);
    if (free < need * 1.1 + 64 * 1024 * 1024) throw new Error(`Not enough free disk space to give each linked conversation its own copy again: ${storage.formatBytes(need)} needed, ${storage.formatBytes(free)} free. Nothing was changed.`);
  }
  journal.state = 'running';
  journal.undo = true;
  await save('undo-started');
  for (const { g, t } of pending.reverse()) {
    if (t.temp && await statId(t.temp)) {
      const temp = await statId(t.temp);
      if (identity(temp) !== g.keeper.id) throw new Error(`Unexpected file at ${t.temp}`);
      await removeName(t.temp, t.root);
    }
    if (t.copyTemp && await statId(t.copyTemp)) await removeName(t.copyTemp, t.root);
    const cur = await statId(t.abs);
    if (cur && identity(cur) === g.keeper.id) {
      await storage.assertPlainPath(t.root, t.abs);
      t.copyTemp = `${t.abs}.tmp-${crypto.randomUUID()}`;
      await save(`materializing:${t.abs}`);
      const expected = (await storage.hashFile(t.abs)).sha256;
      await fs.copyFile(t.abs, t.copyTemp, require('node:fs').constants.COPYFILE_EXCL);
      if ((await storage.hashFile(t.copyTemp)).sha256 !== expected) { await removeName(t.copyTemp, t.root); throw new Error(`The copy of ${t.abs} did not verify`); }
      await interrupt(`copied:${t.abs}`, journal);
      await storage.renameReplacing(t.copyTemp, t.abs);
      const after = await statId(t.abs);
      if (!after || identity(after) === g.keeper.id || (await storage.hashFile(t.abs)).sha256 !== expected) throw new Error(`${t.abs} did not become a separate copy`);
    }
    t.copyTemp = null;
    t.undone = true;
    await save(`undone:${t.abs}`);
  }
  journal.state = 'rolled-back';
  journal.finished = new Date().toISOString();
  await save('rolled-back');
  return { restored: pending.length };
}

module.exports = { identity, statId, cloudRoots, cloudSynced, tryLink, knownDirectories, knownNames, assertKnownNames, hasUnknownNames, OUTSIDE_NAMES, accountIdentities, isSessionTranscript, planLinks, renderLinkPlan, linkIdentical, resumeLinks, undoLinks, readLinkJournal };
