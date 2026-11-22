'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('./storage');
const linking = require('./linking');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
// Links are rejected anywhere in the path, including above the profile root.
// The one exception is the managed shared-storage junction (see storage.js).
async function safe(root, relative, { switcherRoot } = {}) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p === '.')) throw new Error('Unsafe history path');
  const absolute = path.resolve(root, relative);
  const first = relative.split(/[\\/]/)[0];
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (stat.isSymbolicLink() && !(await storage.managedLink(current, path.resolve(root), first, switcherRoot))) throw new Error('Linked history paths are not supported');
  }
  return absolute;
}
async function capture(root, relative, result = new Map(), options) {
  const file = await safe(root, relative, options);
  let stat;
  try { stat = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return result; throw e; }
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(file)).sort()) await capture(root, path.join(relative, name), result, options);
  } else if (stat.isFile()) {
    if (stat.size > MAX_BYTES) throw new Error('History file exceeds the 512 MB limit');
    result.set(relative, await fs.readFile(file));
  } else throw new Error('Unsupported history file type');
  return result;
}
function fingerprint(files) { return [...files].map(([name, data]) => `${name}:${digest(data)}`).sort().join('\n'); }
function validateTranscript(data, id) {
  let messages = 0;
  for (const line of data.toString('utf8').split('\n').filter(s => s.trim())) {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('Incomplete or invalid history. Stop the conversation and retry.'); }
    if (!row || typeof row !== 'object') throw new Error('Invalid history record');
    if (row.sessionId && row.sessionId !== id) throw new Error('History contains a different session ID');
    if (row.type === 'user' || row.type === 'assistant') messages++;
  }
  if (!messages) throw new Error('No resumable messages found');
}
function insideWorkspace(workspace, cwd) {
  const base = path.resolve(workspace).toLowerCase(), target = path.resolve(cwd).toLowerCase();
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}
// Transcripts grow quickly (one reached 75 MB in a day); a low cap silently
// stops copying a conversation once it crosses the limit.
const MAX_BYTES = 512 * 1024 * 1024;
async function listSessions(root, workspaces, { include, switcherRoot } = {}) {
  const options = { switcherRoot };
  const result = [];
  let projects;
  try { projects = await fs.readdir(await safe(root, 'projects', options), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  for (const project of projects.filter(e => e.isDirectory())) {
    const dir = await safe(root, path.join('projects', project.name), options);
    for (const file of await fs.readdir(dir)) {
      const id = file.replace(/\.jsonl$/, '');
      if (!file.endsWith('.jsonl') || !UUID.test(id)) continue;
      const relative = path.join('projects', project.name, file);
      const full = await safe(root, relative, options);
      const stat = await fs.stat(full);
      if (stat.size > MAX_BYTES) continue;
      if (include && !(await include(project.name, file, stat))) continue;
      const data = await fs.readFile(full, 'utf8');
      let cwd, title, summary, firstPrompt, hasMessages = false;
      for (const line of data.split('\n')) {
        try {
          const row = JSON.parse(line);
          if (row.type === 'user' || row.type === 'assistant') hasMessages = true;
          // The first cwd is the launch folder Claude resumes from; later rows
          // follow Bash `cd` into subfolders and must not hide the session.
          if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;
          if (typeof row.customTitle === 'string') title = row.customTitle;
          if (typeof row.summary === 'string') summary = row.summary;
          if (!firstPrompt && row.type === 'user' && !row.isMeta) {
            const content = row.message?.content;
            if (typeof content === 'string') firstPrompt = content;
            else if (Array.isArray(content)) firstPrompt = content.find(item => item.type === 'text')?.text;
          }
        } catch { /* A writer may still be appending; transfer validates later. */ }
      }
      if (!hasMessages || !cwd || (workspaces && !workspaces.some(w => insideWorkspace(w, cwd)))) continue;
      const titles = [title, summary, firstPrompt].filter(s => typeof s === 'string' && s.trim()).map(s => s.replace(/\s+/g, ' ').trim());
      result.push({ id, project: project.name, cwd, title: titles[0] || 'Untitled conversation', titles, modified: stat.mtimeMs });
    }
  }
  return result.sort((a, b) => b.modified - a.modified);
}
// Real path of a profile's projects folder: two profiles in the shared pool
// resolve to the same folder and have nothing to copy.
async function projectsReal(root) {
  const folder = path.join(root, 'projects');
  try { return storage.normalize(await storage.realpath(folder)); } catch (e) { if (e.code === 'ENOENT') return storage.normalize(folder); throw e; }
}
async function sameStore(source, destination) { return (await projectsReal(source)) === (await projectsReal(destination)); }
function requireRoot(options) {
  if (!options?.switcherRoot) throw new Error('Storage root is required for transfers');
  return { switcherRoot: options.switcherRoot };
}
const noop = session => ({ ...session, backup: null, shared: true });
async function statOrNull(file) { try { return await fs.lstat(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } }
// T1: same transcript file identity, and every other bundle file identical.
async function sameBundle(source, destination, roots, readAll, ctx) {
  const a = await statOrNull(await safe(source, roots[0], ctx)), b = await statOrNull(await safe(destination, roots[0], ctx));
  if (!a?.isFile() || !b?.isFile() || linking.identity(a) !== linking.identity(b)) return false;
  const from = await readAll(source), to = await readAll(destination);
  if (from.size !== to.size) return false;
  for (const [name, data] of from) {
    if (!to.has(name)) return false;
    if (storage.isLinkable(name)) {
      const x = await statOrNull(await safe(source, name, ctx)), y = await statOrNull(await safe(destination, name, ctx));
      if (!x || !y || linking.identity(x) !== linking.identity(y)) return false;
    } else if (!to.get(name).equals(data)) return false;
  }
  return true;
}
async function installedMatches(destination, readAll, incoming, linkedIds, ctx) {
  const got = await readAll(destination);
  if (got.size !== incoming.size) return false;
  for (const [name, data] of incoming) {
    const now = got.get(name);
    if (!now) return false;
    if (linkedIds.has(name)) {
      const stat = await statOrNull(await safe(destination, name, ctx));
      if (!stat || linking.identity(stat) !== linkedIds.get(name) || now.length < data.length || !now.subarray(0, data.length).equals(data)) return false;
    } else if (!now.equals(data)) return false;
  }
  return true;
}
async function transferSession(source, destination, session, options) {
  if (!UUID.test(session.id) || !session.project || /[\\/]/.test(session.project) || session.project === '..') throw new Error('Invalid session selection');
  if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) throw new Error('Select a different destination profile');
  const ctx = requireRoot(options), { switcherRoot } = ctx;
  await storage.assertNoMigrationPending(switcherRoot);
  if (await sameStore(source, destination)) return noop(session);
  const roots = [path.join('projects', session.project, `${session.id}.jsonl`), path.join('projects', session.project, session.id), path.join('file-history', session.id), path.join('image-cache', session.id)];
  const readAll = async root => { const files = new Map(); for (const relative of roots) await capture(root, relative, files, ctx); return files; };
  // T1: the destination already holds the source's files (the same linked
  // transcripts, identical copies of everything else): nothing to do, before
  // any lock or backup.
  if (await sameBundle(source, destination, roots, readAll, ctx)) return { ...session, backup: null, linked: [], copiedInstead: [], unchanged: true };
  // Transcripts are installed as hard links unless the caller asks for copies
  // or a fallback applies (T2, T3; decision 13: only .jsonl transcripts).
  // Never into shared storage (dormant, decision 11): pool members share one folder.
  const linkMode = options?.link !== false && !(await storage.isPoolMember(destination, switcherRoot)) && !(await storage.isPoolMember(source, switcherRoot));
  const linkedIds = new Map(), copiedInstead = [];
  // A pool destination is shared by every member, so the store-wide lock
  // replaces the per-profile lock.
  const pool = await storage.isPoolMember(destination, switcherRoot);
  const touchesPool = pool || await storage.isPoolMember(source, switcherRoot);
  if (touchesPool) await storage.assertNoRecovery(switcherRoot);
  let lock = null, releaseStore = null;
  if (pool) {
    releaseStore = await storage.acquireStoreLock(switcherRoot, `transfer ${session.id}`);
    try {
      // Re-check under the lock: a migration, rollback or failed recovery may have started while waiting.
      await storage.assertNoMigration(switcherRoot);
      await storage.assertNoRecovery(switcherRoot);
      if (!(await storage.isPoolMember(destination, switcherRoot))) throw new Error('Shared storage changed while waiting. Switch again.');
    } catch (e) { await releaseStore(); throw e; }
  } else {
    lock = await safe(destination, '.profile-switch-lock', ctx);
    await fs.mkdir(destination, { recursive: true });
    try { await fs.mkdir(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error('Another transfer is active, or an interrupted transfer needs recovery. Inspect .profile-switch-lock before retrying.'); throw e; }
  }
  let checked = false;
  const underStore = run => pool ? run() : storage.withStoreLock(switcherRoot, `backup ${session.id}`, async () => {
    if (!checked) {
      // The first store write precedes every destination change: refuse if storage changed meanwhile.
      await storage.assertNoMigration(switcherRoot);
      if (await storage.isPoolMember(destination, switcherRoot)) throw new Error('The destination joined shared storage during the switch. Switch again.');
      if (touchesPool) await storage.assertNoRecovery(switcherRoot);
      checked = true;
    }
    return run();
  });
  const staged = new Map(), swaps = [];
  let retainLock = false, manifest;
  // Files under `at` (a destination path standing for `relative`) whose bytes
  // differ from `expected`: content written after it was read.
  const drift = async (at, relative, expected) => {
    const found = new Map(), changed = [];
    await capture(destination, at, found, ctx);
    for (const [key, data] of found) {
      const name = relative + key.slice(at.length);
      if (!expected.get(name)?.equals(data)) changed.push({ name, data, sha256: digest(data), size: data.length });
    }
    return changed;
  };
  // Stores content in the object store under this transfer's pinned manifest.
  const preserve = async (items, reason, state) => {
    if (!items.length) return;
    manifest ||= { id: storage.newManifestId(), kind: 'transfer', sessionId: session.id, project: session.project, source: path.resolve(source), destination: path.resolve(destination), created: new Date().toISOString(), state: state || 'prepared', files: [], objects: [] };
    manifest.pinned = true;
    manifest.objects.push(...items.map(({ name, sha256, size }) => ({ name, sha256, size, reason })));
    if (state) manifest.state = state;
    await underStore(async () => { await storage.writeManifest(switcherRoot, manifest); for (const item of items) await storage.putObject(switcherRoot, item.data, item.sha256); });
  };
  let incoming = new Map();
  try {
    incoming = await readAll(source);
    if (!incoming.has(roots[0])) throw new Error('Selected conversation no longer exists');
    validateTranscript(incoming.get(roots[0]), session.id);
    // I1: a bundle file that is the same file as an account file (credentials,
    // settings, policy) is never carried. A transcript with names outside the
    // profile folders is carried (copied, never linked) only when it is a
    // transcript of this conversation. Either is skipped with a reason; the rest carries.
    const known = await linking.knownDirectories(switcherRoot, [source, destination, ...(options.profiles || [])]);
    const accounts = await linking.accountIdentities(known, options.home ? [path.join(options.home, '.claude.json')] : []);
    const excluded = new Map(), outside = new Set();
    for (const name of [...incoming.keys()]) {
      const stat = await statOrNull(await safe(source, name, ctx));
      if (stat && accounts.has(linking.identity(stat))) {
        if (name === roots[0]) throw new Error('The conversation transcript is the same file as an account file (credentials or settings). Nothing was copied.');
        excluded.set(name, 'the same file as an account file (credentials or settings); not carried');
        continue;
      }
      if (stat && storage.isLinkable(name) && await linking.hasUnknownNames(await safe(source, name, ctx), name, known)) {
        outside.add(name);
        if (!linking.isSessionTranscript(incoming.get(name), session.id)) excluded.set(name, 'has names outside the Claude profile folders and is not a transcript of this conversation; not carried');
      }
    }
    for (const name of excluded.keys()) incoming.delete(name);
    const readSource = async () => { const files = await readAll(source); for (const name of excluded.keys()) files.delete(name); return files; };
    const previous = await readAll(destination);
    // The source is never modified, so no copy of it is kept. Of the destination's
    // old version only what the incoming one lacks is kept: a transcript that is
    // a byte prefix of its replacement, or an identical file, holds nothing new.
    const kept = [];
    for (const [name, data] of previous) {
      const next = incoming.get(name);
      if (next && (next.equals(data) || (name.endsWith('.jsonl') && data.length <= next.length && next.subarray(0, data.length).equals(data)))) continue;
      kept.push({ name, data, sha256: digest(data), size: data.length, reason: next ? 'diverged' : 'only in destination' });
    }
    // A copy-based transfer does not hold the store lock: refuse before staging
    // when a migration started preparing meanwhile.
    if (!pool) await storage.assertNoMigrationPending(switcherRoot);
    // T5: only files safe() accepted inside the session bundle are linked, and
    // never one with more names than the profile folders hold (a planted link,
    // or Claude's own link in its temp folder): that file is copied instead
    // (see the I1 screening above).
    const stage = async (name, out) => {
      if (linkMode && storage.isLinkable(name) && outside.has(name)) copiedInstead.push({ name, reason: linking.OUTSIDE_NAMES });
      else if (linkMode && storage.isLinkable(name)) {
        const result = await linking.tryLink(await safe(source, name, ctx), out, { destinationDir: destination, cloud: options.cloudRoots });
        if (result.linked) { linkedIds.set(name, result.id); return; }
        copiedInstead.push({ name, reason: result.reason });
      }
      await fs.writeFile(out, incoming.get(name), { flag: 'wx', mode: 0o600 });
    };
    // Stage next to each target, so a failed transfer leaves nothing behind.
    for (const relative of roots) {
      const names = [...incoming.keys()].filter(name => name === relative || name.startsWith(relative + path.sep));
      if (!names.length) continue;
      const temp = await safe(destination, `${relative}.tmp-${crypto.randomUUID()}`, ctx);
      staged.set(relative, temp);
      if (names.length === 1 && names[0] === relative) {
        await fs.mkdir(path.dirname(temp), { recursive: true, mode: 0o700 });
        await stage(relative, temp);
      } else for (const name of names) {
        const out = path.join(temp, path.relative(relative, name));
        await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
        await stage(name, out);
      }
    }
    if (fingerprint(incoming) !== fingerprint(await readSource()) || fingerprint(previous) !== fingerprint(await readAll(destination))) throw new Error('Conversation changed while copying. Stop Claude in both profiles and retry.');
    // The manifest is written before the objects it names, so garbage
    // collection in another window can never remove them in between.
    manifest = { id: storage.newManifestId(), kind: 'transfer', sessionId: session.id, project: session.project, source: path.resolve(source), destination: path.resolve(destination), created: new Date().toISOString(), state: 'prepared', pinned: kept.length > 0,
      files: [...incoming].map(([name, data]) => ({ name, sha256: digest(data), size: data.length })), objects: kept.map(({ name, sha256, size, reason }) => ({ name, sha256, size, reason })) };
    await underStore(async () => { await storage.writeManifest(switcherRoot, manifest); for (const item of kept) await storage.putObject(switcherRoot, item.data, item.sha256); });
    for (const relative of roots) {
      const target = await safe(destination, relative, ctx);
      const swap = { relative, target, aside: null, asideRelative: null, installed: false };
      if (await fs.lstat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) {
        swap.asideRelative = `${relative}.old-${crypto.randomUUID()}`;
        const aside = await safe(destination, swap.asideRelative, ctx);
        await fs.rename(target, aside);
        swap.aside = aside;
      }
      if (swap.aside || staged.has(relative)) swaps.push(swap);
      if (staged.has(relative)) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        // A writer that recreated the target after the move must not be overwritten.
        if (await fs.lstat(target).catch(() => null)) throw new Error('Claude wrote to the conversation while switching. Stop Claude in both profiles and retry.');
        await fs.rename(staged.get(relative), target);
        staged.delete(relative);
        swap.installed = true;
      }
    }
    // Copies must match exactly. Linked transcripts must be the source's file
    // (identity) and hold at least what was read (appends since are the same conversation).
    if (!(await installedMatches(destination, readAll, incoming, linkedIds, ctx))) throw new Error('The copied conversation did not verify. Stop Claude in both profiles and retry.');
    // Re-check each moved-aside version: anything appended after it was read
    // (for example while waiting for the store lock) is stored before removal.
    const late = [];
    for (const swap of swaps) if (swap.aside) late.push(...await drift(swap.asideRelative, swap.relative, previous));
    await preserve(late, 'written during transfer');
    manifest.state = 'committed';
    await underStore(() => storage.writeManifest(switcherRoot, manifest));
    for (const swap of swaps) if (swap.aside) await storage.removeTree(swap.aside).catch(() => { /* A leftover .old- entry is harmless; Claude ignores it. */ });
    return { ...session, backup: storage.manifestPath(switcherRoot, manifest.id), linked: [...linkedIds.keys()], copiedInstead, skippedFiles: [...excluded].map(([name, reason]) => ({ name, reason })) };
  } catch (e) {
    try {
      for (const swap of swaps.reverse()) {
        if (await fs.lstat(swap.target).catch(() => null)) {
          // Whatever is at the target and is not our staged copy was written by
          // Claude meanwhile: store it before the target is replaced.
          await preserve(await drift(swap.relative, swap.relative, swap.installed ? incoming : new Map()), 'written during failed transfer', 'rolled-back');
          await storage.removeTree(swap.target);
        }
        if (swap.aside) await fs.rename(swap.aside, swap.target);
      }
      for (const temp of staged.values()) await storage.removeTree(temp);
    } catch (recoveryError) {
      retainLock = true;
      const message = `Transfer recovery required. The previous destination files are kept next to them (${swaps.filter(s => s.aside).map(s => s.aside).join(', ') || 'none moved'})${manifest ? ` and listed in ${storage.manifestPath(switcherRoot, manifest.id)}` : ''}. Do not resume until restored.`;
      // In the pool, a durable marker blocks pool transfers until it is resolved in Manage Storage.
      if (pool) {
        try {
          await storage.recordRecovery(switcherRoot, { sessionId: session.id, project: session.project, source: path.resolve(source), destination: path.resolve(destination), asides: swaps.filter(s => s.aside).map(s => s.aside), manifest: manifest ? storage.manifestPath(switcherRoot, manifest.id) : null, error: e.message, recoveryError: recoveryError.message });
          retainLock = false;
        } catch { /* Keep the store lock instead: it blocks every shared-storage write. */ }
      }
      throw new Error(message);
    }
    throw e;
  } finally {
    if (!retainLock) { if (lock) await fs.rmdir(lock); if (releaseStore) await releaseStore(); }
  }
}
async function transferWorkspace(source, destination, sessions, options) {
  const ctx = requireRoot(options);
  await storage.assertNoMigrationPending(ctx.switcherRoot);
  if (await sameStore(source, destination)) return sessions.map(noop);
  // Validate every transcript before the first destination mutation.
  for (const session of sessions) {
    if (!UUID.test(session.id) || /[\\/]/.test(session.project) || session.project === '..') throw new Error('Invalid session selection');
    const file = await safe(source, path.join('projects', session.project, session.id + '.jsonl'), ctx);
    validateTranscript(await fs.readFile(file), session.id);
  }
  const copied = [];
  try {
    for (const session of sessions) copied.push(await transferSession(source, destination, session, { ...options, ...ctx }));
  } catch (error) {
    // Earlier transfers remain recoverable; the caller must not change the panel profile.
    throw new Error(`Workspace history copy stopped: ${error.message}. The panel profile was not changed. ${copied.length} conversations were copied with backups; retry after resolving the error.`);
  }
  return copied;
}
// Every project's conversations that are missing from the destination or newer
// in the source. The panel setting is shared by all VS Code windows, so a switch
// in one window must carry the other windows' conversations too.
async function pendingSessions(source, destination, options = {}) {
  if (await sameStore(source, destination)) return [];
  const ctx = { switcherRoot: options.switcherRoot };
  return listSessions(source, null, { ...ctx, include: async (project, file, stat) => {
    const relative = path.join('projects', project, file);
    let other;
    try { other = await fs.stat(await safe(destination, relative, ctx), { bigint: true }); }
    catch (e) { if (e.code === 'ENOENT') return true; throw e; }
    // A linked transcript is the same file in both profiles: nothing to carry.
    const mine = await fs.stat(await safe(source, relative, ctx), { bigint: true });
    if (linking.identity(mine) === linking.identity(other)) return false;
    other = { size: Number(other.size), mtimeMs: Number(other.mtimeMs) };
    // A copy is always newer on disk than its original, so identical content
    // must not count as a change (it would re-copy and back up every switch).
    if (other.size === stat.size && digest(await fs.readFile(await safe(source, relative, ctx))) === digest(await fs.readFile(await safe(destination, relative, ctx)))) return false;
    return stat.mtimeMs > other.mtimeMs;
  } });
}
// Copy each session independently; one busy or invalid conversation must not
// block the others. Returns what was copied and what was skipped, with reasons.
async function transferEach(source, destination, sessions, options) {
  const ctx = requireRoot(options);
  await storage.assertNoMigrationPending(ctx.switcherRoot);
  if (await sameStore(source, destination)) return { copied: [], skipped: [], shared: true };
  const copied = [], skipped = [];
  for (const session of sessions) {
    try { copied.push(await transferSession(source, destination, session, { ...options, ...ctx })); }
    catch (error) {
      if (/recovery required/i.test(error.message)) throw error;
      skipped.push({ session, reason: error.message });
    }
  }
  return { copied, skipped };
}
module.exports = { MAX_BYTES, safe, listSessions, pendingSessions, transferSession, transferEach, transferWorkspace, validateTranscript };
