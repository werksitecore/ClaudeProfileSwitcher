'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { listSessions } = require('./history');
const storage = require('./storage');
const linking = require('./linking');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function readSession(record) {
  let timer;
  const pid = await Promise.race([
    record.terminal.processId,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude CLI did not report its process ID. Reopen the CLI and try again.')), 5000); })
  ]).finally(() => clearTimeout(timer));
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Claude CLI process is not available yet.');
  const file = path.join(record.profile.directory, 'sessions', `${pid}.json`);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('This Claude CLI does not expose its current session safely. Reopen it with Claude Profiles using an updated official Claude extension.');
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new Error('Claude CLI is updating its session state. Try switching again in a moment.'); }
  if (state.pid !== pid || !UUID.test(state.sessionId || '') || typeof state.cwd !== 'string' || !path.isAbsolute(state.cwd) || state.kind !== 'interactive' || !Number.isFinite(state.startedAt) || state.startedAt < record.startedAt - 5000) throw new Error('Claude CLI session identity could not be verified. No CLI was closed.');
  if (state.status !== 'idle') throw new Error('Claude CLI is busy or waiting for a response. Finish or stop its work before switching profiles.');
  return { pid, id: state.sessionId, cwd: state.cwd };
}

// In the shared pool every member reads the same transcripts, so a conversation
// open under any member counts as open under the destination.
// P1: with hard-linked transcripts, every profile that holds a name for the
// same transcript file (the destination's, or the source's that the carry
// will link) shares the conversation, so it counts as open there too.
// `profiles` adds folders outside <switcherRoot>/profiles (Default);
// `ignorePids` are the CLIs this switch stops itself.
async function assertDestinationAvailable(directory, id, alive = processAlive, { switcherRoot, profiles = [], source, ignorePids = [], allowSource = false } = {}) {
  const check = (dir, shared) => assertSessionsFree(dir, id, alive, ignorePids, shared);
  if (switcherRoot && await storage.isPoolMember(directory, switcherRoot)) {
    const members = await storage.poolMembers(switcherRoot);
    if (!members.some(member => storage.normalize(member) === storage.normalize(directory))) members.push(directory);
    for (const member of members) await check(member, false);
    return;
  }
  await check(directory, false);
  if (!switcherRoot || !UUID.test(String(id))) return;
  const ids = new Set();
  for (const dir of [directory, source].filter(Boolean)) for (const f of await transcriptNames(dir, id)) ids.add(f.identity);
  if (!ids.size) return { liveInSource: false };
  let liveInSource = false;
  const dirs = await linking.knownDirectories(switcherRoot, [...profiles, source].filter(Boolean));
  for (const dir of dirs) {
    if (storage.normalize(dir) === storage.normalize(directory)) continue;
    if (!(await transcriptNames(dir, id)).some(f => ids.has(f.identity))) continue;
    // With allowSource (conversations carried along), a session live only in
    // the source is reported, not refused: the caller copies it instead of linking.
    if (allowSource && source && storage.normalize(dir) === storage.normalize(source)) {
      try { await check(dir, true); } catch (error) { if (error.code !== 'ELIVE') throw error; liveInSource = true; }
      continue;
    }
    await check(dir, true);
  }
  return { liveInSource };
}
// Every projects/<project>/<id>.jsonl in a profile, with its file identity. Links are not followed.
async function transcriptNames(directory, id) {
  const projects = path.join(directory, 'projects'), out = [];
  const top = await fs.lstat(projects).catch(() => null);
  if (!top?.isDirectory()) return out;
  for (const name of await fs.readdir(projects)) {
    const dir = await fs.lstat(path.join(projects, name)).catch(() => null);
    if (!dir?.isDirectory()) continue;
    const stat = await fs.lstat(path.join(projects, name, `${id}.jsonl`), { bigint: true }).catch(() => null);
    if (stat?.isFile()) out.push({ project: name, identity: linking.identity(stat) });
  }
  return out;
}
async function assertSessionsFree(directory, id, alive, ignorePids = [], shared = false) {
  const root = path.join(directory, 'sessions');
  let files;
  try { files = await fs.readdir(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of files.filter(name => /^[1-9][0-9]*\.json$/.test(name))) {
    const pid = Number(name.slice(0, -5));
    if (!alive(pid) || ignorePids.includes(pid)) continue;
    const file = path.join(root, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Cannot verify destination CLI activity safely.');
    let state;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new Error('Destination Claude is updating its session state. Try again in a moment.'); }
    if (state.sessionId === id) throw Object.assign(new Error(shared ? `This conversation is open in another profile that shares it (${directory}). Never continue one conversation in two profiles at once: close it there before switching.` : 'This conversation is already open under the destination profile. Close that Claude session before switching.'), { code: 'ELIVE' });
  }
}

async function assertDestinationReady(profile, cwd) {
  const base = profile.builtin && !profile.configValue ? path.dirname(profile.directory) : profile.directory;
  let settings;
  try {
    const file = path.join(base, '.claude.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid configuration');
    settings = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { /* Missing or unreadable onboarding state must not interrupt the source CLI. */ }
  if (settings?.hasCompletedOnboarding !== true) throw new Error(`First open a CLI with ${profile.name} and finish Claude's one-time setup. The current conversation was not closed.`);
  if (cwd) {
    const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const trusted = Object.entries(settings.projects || {}).some(([directory, project]) => {
      const relative = path.relative(normalize(directory), normalize(cwd));
      return project?.hasTrustDialogAccepted === true && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    });
    if (!trusted) throw new Error(`First open a CLI with ${profile.name} in this project and complete Claude's folder-trust prompt. The current conversation was not closed.`);
  }
}

class CliContinuation {
  constructor({ read = readSession, list = listSessions, alive = processAlive, delay = pause } = {}) {
    this.records = new Map();
    Object.assign(this, { read, list, alive, delay });
  }
  track(terminal, profile) { this.records.set(terminal, { terminal, profile, startedAt: Date.now() }); }
  forget(terminal) { this.records.delete(terminal); }
  async plan(records) {
    const planned = [];
    for (const record of records) {
      const state = await this.read(record);
      const sessions = await this.list(record.profile.directory, [state.cwd]);
      const session = sessions.find(item => item.id === state.id);
      if (!session) throw new Error('The active CLI conversation has no saved transcript yet. Send a message before switching.');
      if (Date.now() - session.modified < 2000) throw new Error('Claude CLI is still saving. Wait a moment before switching.');
      if (planned.some(item => item.session.id === session.id)) throw new Error('This conversation is open in more than one managed CLI. Close the duplicate CLI before switching.');
      planned.push({ record, state, session, stopped: false });
    }
    return planned;
  }
  async stop(item) {
    const state = await this.read(item.record);
    if (state.pid !== item.state.pid || state.id !== item.state.id || state.cwd !== item.state.cwd) throw new Error('The CLI conversation changed during switching. Switch cancelled.');
    item.record.terminal.dispose();
    for (let i = 0; i < 100; i++) {
      if (!this.alive(state.pid)) { item.stopped = true; this.forget(item.record.terminal); return; }
      await this.delay(100);
    }
    throw new Error('Claude CLI has not exited. Its history was not copied and no replacement CLI was started.');
  }
}

module.exports = { CliContinuation, readSession, assertDestinationAvailable, assertDestinationReady };
