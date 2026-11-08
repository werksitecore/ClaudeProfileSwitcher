'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
async function safe(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => p === '..' || p === '.')) throw new Error('Unsafe history path');
  const absolute = path.resolve(root, relative);
  // Reject links/junctions anywhere in the path, including the profile root.
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked history paths are not supported'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return absolute;
}
async function capture(root, relative, result = new Map()) {
  const file = await safe(root, relative);
  let stat;
  try { stat = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return result; throw e; }
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(file)).sort()) await capture(root, path.join(relative, name), result);
  } else if (stat.isFile()) {
    if (stat.size > 100 * 1024 * 1024) throw new Error('History file exceeds the prototype 100 MB limit');
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
async function listSessions(root, workspaces) {
  const result = [];
  let projects;
  try { projects = await fs.readdir(await safe(root, 'projects'), { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  for (const project of projects.filter(e => e.isDirectory())) {
    const dir = await safe(root, path.join('projects', project.name));
    for (const file of await fs.readdir(dir)) {
      const id = file.replace(/\.jsonl$/, '');
      if (!file.endsWith('.jsonl') || !UUID.test(id)) continue;
      const relative = path.join('projects', project.name, file);
      const full = await safe(root, relative);
      const stat = await fs.stat(full);
      if (stat.size > 100 * 1024 * 1024) continue;
      const data = await fs.readFile(full, 'utf8');
      let cwd, title, summary, firstPrompt;
      for (const line of data.split('\n')) {
        try {
          const row = JSON.parse(line);
          if (typeof row.cwd === 'string') cwd = row.cwd;
          if (typeof row.customTitle === 'string') title = row.customTitle;
          if (typeof row.summary === 'string') summary = row.summary;
          if (!firstPrompt && row.type === 'user' && !row.isMeta) {
            const content = row.message?.content;
            if (typeof content === 'string') firstPrompt = content;
            else if (Array.isArray(content)) firstPrompt = content.find(item => item.type === 'text')?.text;
          }
        } catch { /* A writer may still be appending; transfer validates later. */ }
      }
      if (!cwd || !workspaces.some(w => path.resolve(w).toLowerCase() === path.resolve(cwd).toLowerCase())) continue;
      const titles = [title, summary, firstPrompt].filter(s => typeof s === 'string' && s.trim()).map(s => s.replace(/\s+/g, ' ').trim());
      result.push({ id, project: project.name, cwd, title: titles[0] || 'Untitled conversation', titles, modified: stat.mtimeMs });
    }
  }
  return result.sort((a, b) => b.modified - a.modified);
}
async function transferSession(source, destination, session) {
  if (!UUID.test(session.id) || !session.project || /[\\/]/.test(session.project) || session.project === '..') throw new Error('Invalid session selection');
  if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) throw new Error('Select a different destination profile');
  const roots = [path.join('projects', session.project, `${session.id}.jsonl`), path.join('projects', session.project, session.id), path.join('file-history', session.id), path.join('image-cache', session.id)];
  const readAll = async root => { const files = new Map(); for (const relative of roots) await capture(root, relative, files); return files; };
  const lock = await safe(destination, '.profile-switch-lock');
  await fs.mkdir(destination, { recursive: true });
  try { await fs.mkdir(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error('Another transfer is active, or an interrupted transfer needs recovery. Inspect .profile-switch-lock before retrying.'); throw e; }
  const archive = path.join('.profile-switch-backups', `${Date.now()}-${crypto.randomUUID()}`);
  const installed = [], moved = [];
  let retainLock = false;
  try {
    const incoming = await readAll(source);
    if (!incoming.has(roots[0])) throw new Error('Selected conversation no longer exists');
    validateTranscript(incoming.get(roots[0]), session.id);
    const previous = await readAll(destination);
    // Keep a permanent, byte-for-byte source snapshot even after future switches.
    for (const [relative, data] of incoming) {
      const snapshot = await safe(destination, path.join(archive, 'incoming', relative));
      await fs.mkdir(path.dirname(snapshot), { recursive: true, mode: 0o700 });
      await fs.writeFile(snapshot, data, { flag: 'wx', mode: 0o600 });
      const staged = await safe(destination, path.join(archive, 'stage', relative));
      await fs.mkdir(path.dirname(staged), { recursive: true, mode: 0o700 });
      await fs.writeFile(staged, data, { flag: 'wx', mode: 0o600 });
    }
    if (fingerprint(incoming) !== fingerprint(await readAll(source)) || fingerprint(previous) !== fingerprint(await readAll(destination))) throw new Error('Conversation changed while copying. Stop Claude in both profiles and retry.');
    const manifest = { sessionId: session.id, project: session.project, created: new Date().toISOString(), state: 'prepared', files: [...incoming].map(([name, data]) => ({ name, sha256: digest(data) })) };
    const manifestPath = await safe(destination, path.join(archive, 'manifest.json'));
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    for (const relative of roots) {
      const target = await safe(destination, relative);
      const backup = await safe(destination, path.join(archive, 'previous', relative));
      try {
        await fs.lstat(target);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.rename(target, backup);
        moved.push({ target, backup });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if ([...incoming.keys()].some(name => name === relative || name.startsWith(relative + path.sep))) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(await safe(destination, path.join(archive, 'stage', relative)), target);
        installed.push(target);
      }
    }
    manifest.state = 'committed';
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return { ...session, backup: path.join(destination, archive) };
  } catch (e) {
    try {
      for (const target of installed.reverse()) await fs.rm(target, { recursive: true, force: true });
      for (const { target, backup } of moved.reverse()) await fs.rename(backup, target);
    } catch { retainLock = true; throw new Error(`Transfer recovery required. Backups retained at ${path.join(destination, archive)}. Do not resume until restored.`); }
    throw e;
  } finally { if (!retainLock) await fs.rmdir(lock); }
}
async function transferWorkspace(source, destination, sessions) {
  // Validate every transcript before the first destination mutation.
  for (const session of sessions) {
    if (!UUID.test(session.id) || /[\\/]/.test(session.project) || session.project === '..') throw new Error('Invalid session selection');
    const file = await safe(source, path.join('projects', session.project, session.id + '.jsonl'));
    validateTranscript(await fs.readFile(file), session.id);
  }
  const copied = [];
  try {
    for (const session of sessions) copied.push(await transferSession(source, destination, session));
  } catch (error) {
    // Earlier transfers remain recoverable; the caller must not change the panel profile.
    throw new Error(`Workspace history copy stopped: ${error.message}. The panel profile was not changed. ${copied.length} conversations were copied with backups; retry after resolving the error.`);
  }
  return copied;
}
module.exports = { listSessions, transferSession, transferWorkspace, validateTranscript };
