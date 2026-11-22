'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { CONFIG, restoreDirectory, conflicts, defaultProfile, panelEntries } = require('./profiles');
const { listSessions, pendingSessions, transferSession, transferEach, transferWorkspace } = require('./history');
const { REOPEN, switchEditorTab } = require('./tab-switch');
const { recoveryConfiguration } = require('./recovery');
const { BUSY_MS, refreshAction, restartCommand } = require('./account-refresh');
const { syncTerminalProfile, profileTerminalOptions } = require('./terminal-profile');
const { CliContinuation, assertDestinationAvailable, assertDestinationReady } = require('./cli-continuation');

// The switcher root is only ever derived here; library code takes it as a parameter.
const DEFAULT_ROOT = path.join(os.homedir(), '.claude-profile-switcher');
// Set once per activation: the real root, or an absolute override that only
// test harnesses pass (context.switcherRootOverride), so no harness has to
// fall back to the home folder.
let SWITCHER_ROOT = DEFAULT_ROOT;
let store = { switcherRoot: SWITCHER_ROOT };
function switcherRootFor(context) {
  const override = context?.switcherRootOverride;
  return typeof override === 'string' && path.isAbsolute(override) ? path.resolve(override) : DEFAULT_ROOT;
}
// Loaded on first use: storage is only needed by Manage Storage and retention.
const storageApi = () => require('./storage');

async function activate(context) {
  SWITCHER_ROOT = switcherRootFor(context);
  store = { switcherRoot: SWITCHER_ROOT };
  // One gate for every background storage operation (retention/GC, archive
  // capture, and any later background maintenance): only in a real extension
  // host, Production or Development mode. Never in Test mode or in a harness
  // without an extension mode, and never against the home folder unless the
  // mode is a real one.
  const realHost = !!vscode.ExtensionMode && [vscode.ExtensionMode.Production, vscode.ExtensionMode.Development].includes(context.extensionMode);
  // Outside a real host this refuses every root, the home folder included.
  const backgroundAllowed = () => realHost;
  const cli = new CliContinuation({ list: (directory, workspaces) => listSessions(directory, workspaces, store) });
  const savedProfiles = () => context.globalState.get('profiles', []).filter(p => !p.builtin);
  const config = () => vscode.workspace.getConfiguration('claudeCode');
  const entries = () => config().get('environmentVariables', []);
  const defaults = recoveryConfiguration({ defaults: context.globalState.get('defaultConfiguration'), original: context.globalState.get('original'), entries: entries(), inherited: process.env[CONFIG], home: os.homedir(), profiles: savedProfiles() });
  await context.globalState.update('defaultConfiguration', defaults);
  const builtin = defaultProfile(defaults.directoryEntries, defaults.inheritedDirectory, os.homedir());
  const profiles = () => [builtin, ...savedProfiles()];
  const currentDirectory = () => entries().find(e => e.name === CONFIG)?.value || process.env[CONFIG] || path.join(os.homedir(), '.claude');
  const isCurrent = profile => path.resolve(profile.directory).toLowerCase() === path.resolve(currentDirectory()).toLowerCase();
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  bar.command = 'claudeProfiles.switch';
  function refresh() {
    const directory = currentDirectory();
    if (vscode.env.remoteName || !vscode.workspace.isTrusted) context.environmentVariableCollection?.clear();
    else syncTerminalProfile(context.environmentVariableCollection, entries().find(e => e.name === CONFIG)?.value || defaults.inheritedDirectory);
    const selected = profiles().find(isCurrent);
    bar.text = `$(account) Claude: ${selected?.name || (directory ? 'External' : 'Default')}`;
    bar.tooltip = 'Configured panel profile; existing conversations and CLI processes may use an earlier profile. Click to switch.';
    bar.show();
  }
  // Claude Code keeps running chats (tabs, sidebar, usage panel) on the account
  // they started with. Restart this window's Claude so every chat follows the
  // switch at once. A notice is shown after the restart, when there is one.
  async function restartClaude(notice) {
    if (vscode.debug?.activeDebugSession) {
      const action = await vscode.window.showWarningMessage(`${notice ? `${notice} ` : ''}Claude chats in this window still use the previous account. Restarting them now would also stop your debug session.`, 'Restart Claude Now');
      if (!action) return;
    } else if (notice) await context.workspaceState.update('pendingNotice', notice);
    await vscode.commands.executeCommand(restartCommand(await vscode.commands.getCommands(true)));
  }
  // Another window switched the shared account setting: bring this window's
  // conversations along, then restart its chats unless that would interrupt work.
  let knownDirectory = currentDirectory();
  async function followAccountChange() {
    const previous = knownDirectory, directory = currentDirectory();
    knownDirectory = directory;
    if (busy || path.resolve(previous).toLowerCase() === path.resolve(directory).toLowerCase()) return;
    if (vscode.env.remoteName || !vscode.workspace.isTrusted) return;
    const claude = vscode.extensions.getExtension('anthropic.claude-code');
    if (!claude?.isActive) return;
    const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    let recent = false;
    if (folders.length) {
      const mine = await listSessions(previous, folders, store);
      recent = mine.some(s => Date.now() - s.modified < BUSY_MS);
      // The switching window copies what it can; make sure this window's own
      // conversations are present and current before its chats reopen.
      const ids = new Set(mine.map(s => s.id));
      const carried = await carryAlong(previous, directory, (await pendingSessions(previous, directory, store)).filter(s => ids.has(s.id)));
      const left = carried.skipped;
      const fallback = fallbackNotice(carried.copied);
      if (fallback) void vscode.window.showInformationMessage(fallback);
      if (left.length) void vscode.window.showWarningMessage(`Not carried: ${left.map(x => `${titleOf(x.session)} (${x.reason})`).join('; ')}.`);
      await collectGarbage();
    }
    const action = refreshAction({ claudeActive: true, debugging: !!vscode.debug?.activeDebugSession, busy: recent });
    if (action === 'restart') return restartClaude();
    const pick = await vscode.window.showWarningMessage('The Claude account was switched in another window. Claude chats here still use the previous account until they restart.', 'Restart Claude Now');
    if (pick) await vscode.commands.executeCommand(restartCommand(await vscode.commands.getCommands(true)));
  }
  async function choose() {
    if (!profiles().length) {
      await vscode.window.showInformationMessage('Create a Claude profile first.');
      return;
    }
    return (await vscode.window.showQuickPick(profiles().map(p => ({ label: p.name, description: `${isCurrent(p) ? 'Current · ' : ''}${p.builtin ? 'Existing Claude setup' : p.directory}`, profile: p })), { title: 'Choose Claude profile' }))?.profile;
  }
  async function create() {
    const name = await vscode.window.showInputBox({ title: 'Create Claude profile', prompt: 'A label such as Personal or Work', validateInput: v => !v.trim() ? 'Enter a name' : profiles().some(p => p.name.toLowerCase() === v.trim().toLowerCase()) ? 'Name already exists' : undefined });
    if (!name) return;
    const id = crypto.randomUUID();
    const directory = path.join(SWITCHER_ROOT, 'profiles', id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await context.globalState.update('profiles', [...savedProfiles(), { id, name: name.trim(), directory }]);
    refresh();
    const action = await vscode.window.showInformationMessage(`Created ${name.trim()}. Sign in using Claude's own login flow.`, 'Sign In');
    if (action) await launch({ name: name.trim(), directory }, true);
  }
  async function launch(profile, login = false, session) {
    if (!profile) return;
    // Launch the executable directly: profile data never becomes shell code.
    const options = profileTerminalOptions(profile, process.env, login, session);
    // Use the panel's matching CLI, whose session registry supports exact tracking.
    const extensionPath = vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath;
    if (extensionPath) {
      const binary = path.join(extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      try { await fs.access(binary); options.shellPath = binary; } catch { /* Standalone CLI remains supported. */ }
    }
    const terminal = vscode.window.createTerminal(options);
    if (!login) cli.track(terminal, profile);
    terminal.show();
    return terminal;
  }
  async function restoreStoppedCli(planned) {
    for (const item of planned.filter(item => item.stopped)) await launch(item.record.profile, false, item.session);
  }
  async function switchCliTo(profile) {
    if (!profile) return;
    const record = cli.records.get(vscode.window.activeTerminal);
    if (!record) throw new Error('Focus a CLI opened with Claude Profiles first. Ordinary shell terminals are not restarted automatically.');
    if (path.resolve(record.profile.directory).toLowerCase() === path.resolve(profile.directory).toLowerCase()) return;
    const planned = await cli.plan([record]);
    const item = planned[0];
    await assertDestinationReady(profile, item.session.cwd);
    await assertDestinationAvailable(profile.directory, item.session.id, undefined, { ...transferOptions(), source: record.profile.directory, ignorePids: [item.state.pid] });
    let carried;
    try {
      await cli.stop(item);
      carried = await transferSession(record.profile.directory, profile.directory, item.session, transferOptions());
    } catch (error) {
      await restoreStoppedCli(planned);
      throw error;
    }
    await launch(profile, false, item.session);
    await collectGarbage();
    const fallback = fallbackNotice([carried]);
    if (fallback) await vscode.window.showInformationMessage(fallback);
  }
  // Profile folders that may hold names of a linked transcript (T5, P1).
  const transferOptions = () => ({ ...store, profiles: profiles().map(p => p.directory), home: os.homedir() });
  // T3: transcripts that were copied instead of linked, with the reason.
  // Named by conversation title; a file inside a conversation also by its name.
  const titleOf = r => `"${String(r.title || r.id || 'conversation').slice(0, 40)}"`;
  const fileOf = (r, name) => /[\\/]subagents[\\/]/.test(name) ? `${titleOf(r)} (subagent ${path.basename(name)})` : titleOf(r);
  function fallbackNotice(results) {
    const items = results.filter(Boolean).flatMap(r => (r.copiedInstead || []).map(c => `${fileOf(r, c.name)}: ${c.reason}`));
    const left = results.filter(Boolean).flatMap(r => (r.skippedFiles || []).map(c => `${fileOf(r, c.name)}: ${c.reason}`));
    const skippedNote = left.length ? ` Not carried: ${left.slice(0, 5).join('; ')}${left.length > 5 ? '; and more' : ''}.` : '';
    return ((items.length ? `Carried as a separate copy instead of shared: ${items.slice(0, 5).join('; ')}${items.length > 5 ? '; and more' : ''}.` : '') + skippedNote).trim();
  }
  // The sharing rule is shown once, on the first switch that shares a conversation.
  async function sharingRuleOnce(results) {
    if (!results.some(r => r?.linked?.length) || context.globalState.get('sharingRuleShown')) return '';
    await context.globalState.update('sharingRuleShown', true);
    return 'Carried conversations are now shared by both profiles: what you add in one appears in the other. Never continue one conversation in two profiles at once.';
  }
  // P1 for conversations carried along without being chosen: one that is open
  // in any profile holding a name for it is skipped and reported, not linked.
  async function notOpenElsewhere(destination, source, sessions, ignorePids = []) {
    const busy = [], copy = [];
    for (const session of sessions) {
      try {
        const result = await assertDestinationAvailable(destination, session.id, undefined, { ...transferOptions(), source, ignorePids, allowSource: true });
        if (result?.liveInSource) copy.push(session);
      } catch (error) { busy.push({ session, reason: error.message }); }
    }
    return { ready: sessions.filter(s => !busy.some(b => b.session === s) && !copy.includes(s)), copy: sessions.filter(s => copy.includes(s)), busy };
  }
  // Carries conversations along without being chosen: linked when free, copied
  // (reported as a fallback) when open only in the source, and skipped (reported)
  // when open in the destination or another profile that shares the file.
  async function carryAlong(source, destination, sessions, ignorePids = []) {
    const { ready, copy, busy } = await notOpenElsewhere(destination, source, sessions, ignorePids);
    const linked = await transferEach(source, destination, ready, transferOptions());
    const copiedResult = copy.length ? await transferEach(source, destination, copy, { ...transferOptions(), link: false }) : { copied: [], skipped: [] };
    const copied = [...linked.copied, ...copiedResult.copied.map(r => ({ ...r, copiedInstead: [...(r.copiedInstead || []), { name: path.join('projects', String(r.project || ''), `${r.id}.jsonl`), reason: 'open in the source profile' }] }))];
    return { copied, skipped: [...busy, ...linked.skipped, ...copiedResult.skipped] };
  }
  async function quickSwitch() {
    const profile = await choose();
    if (!profile) return;
    // With no active Claude tab, Default is a settings-only recovery operation.
    // With an active tab, use the same backed-up transfer/restart in both directions.
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const claudeTab = tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('claudeVSCodePanel');
    if (!claudeTab && cli.records.has(vscode.window.activeTerminal)) return switchCliTo(profile);
    if (isCurrent(profile)) return;
    if (profile.builtin && !claudeTab) return restore();
    const claude = vscode.extensions.getExtension('anthropic.claude-code');
    if (!claude) throw new Error('Install the official Anthropic Claude Code extension first.');
    if (!claudeTab) throw new Error('Open and focus a Claude editor tab before switching. Sidebar-only switching is available through Advanced Switch.');
    await claude.activate();
    if (!(await vscode.commands.getCommands(true)).includes(REOPEN)) throw new Error('Update Claude Code: this version does not expose Reopen Closed Session.');
    const source = entries().find(e => e.name === CONFIG)?.value || process.env[CONFIG] || path.join(os.homedir(), '.claude');
    const found = conflicts(entries(), process.env);
    if (found.length) throw new Error(`Conflicting authentication/provider variables: ${found.join(', ')}. Remove them before switching subscription accounts.`);
    const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    if (!folders.length) throw new Error('Open the conversation’s project folder before switching.');
    const sessions = await listSessions(source, folders, store);
    if (!sessions.length) throw new Error('No saved conversation was found for this workspace. Switching was cancelled; your account and history are unchanged.');
    if (sessions.some(session => Date.now() - session.modified < 2000)) throw new Error('Claude is still saving workspace history. Stop the response, wait a moment, and switch again.');
    const previous = entries();
    const plannedCli = await cli.plan([...cli.records.values()].filter(record => path.resolve(record.profile.directory).toLowerCase() === path.resolve(source).toLowerCase()));
    for (const item of plannedCli) await assertDestinationReady(profile, item.session.cwd);
    for (const item of plannedCli) await assertDestinationAvailable(profile.directory, item.session.id, undefined, { ...transferOptions(), source, ignorePids: plannedCli.map(x => x.state.pid) });
    let copied, skipped = [], carriedOthers = [];
    const carriedCli = [];
    try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Switching Claude to ${profile.name}`, cancellable: false }, () => switchEditorTab({
      tab,
      close: target => vscode.window.tabGroups.close(target, true),
      reopen: () => vscode.commands.executeCommand(REOPEN),
      prepare: async () => {
        for (const item of plannedCli) await cli.stop(item);
        // Allow Claude's asynchronous tab shutdown to flush its saved transcript.
        await new Promise(resolve => setTimeout(resolve, 1000));
        const saved = await listSessions(source, folders, store);
        copied = await transferWorkspace(source, profile.directory, saved, transferOptions());
        for (const item of plannedCli) {
          if (!copied.some(session => session.id === item.session.id)) carriedCli.push(await transferSession(source, profile.directory, item.session, transferOptions()));
        }
        // The account setting applies to every VS Code window, so also carry
        // other projects' new or changed conversations, without prompting.
        const done = new Set([...copied.map(s => s.id), ...plannedCli.map(item => item.session.id)]);
        const others = (await pendingSessions(source, profile.directory, store)).filter(s => !done.has(s.id));
        ({ skipped, copied: carriedOthers } = await carryAlong(source, profile.directory, others, plannedCli.map(x => x.state.pid)));
      },
      apply: async () => {
        if (!context.globalState.get('original')) await context.globalState.update('original', { directoryEntries: previous.filter(e => e.name === CONFIG) });
        await context.workspaceState.update('pendingResume', undefined);
        await context.workspaceState.update('lastWorkspaceTransfer', { profile, sessions: copied });
        await config().update('environmentVariables', panelEntries(entries(), profile), vscode.ConfigurationTarget.Global);
        refresh();
      },
      rollback: async () => {
        await config().update('environmentVariables', restoreDirectory(entries(), previous.filter(e => e.name === CONFIG)), vscode.ConfigurationTarget.Global);
        refresh();
      }
    })); } catch (error) {
      await restoreStoppedCli(plannedCli);
      throw error;
    }
    for (const item of plannedCli) await launch(profile, false, item.session);
    knownDirectory = currentDirectory();
    await collectGarbage();
    const notes = [];
    if (skipped.length) notes.push(`Switched to ${profile.name}. Not carried: ${skipped.map(s => `${titleOf(s.session)} (${s.reason})`).join('; ')}. Stop Claude in the other window and switch again to carry ${skipped.length === 1 ? 'it' : 'them'}.`);
    const carried = [...(copied || []), ...carriedCli, ...carriedOthers];
    const fallback = fallbackNotice(carried);
    if (fallback) notes.push(fallback);
    const rule = await sharingRuleOnce(carried);
    if (rule) notes.push(rule);
    await restartClaude(notes.length ? notes.join(' ') : undefined);
  }
  async function switchProfile() {
    if (!vscode.extensions.getExtension('anthropic.claude-code')) throw new Error('Install the official Anthropic Claude Code extension first.');
    const profile = await choose();
    if (!profile || isCurrent(profile)) return;
    const found = conflicts(entries(), process.env);
    if (found.length) throw new Error(`Conflicting authentication/provider variables: ${found.join(', ')}. Remove them from Claude settings or the VS Code launch environment before switching subscription accounts.`);
    const mode = await vscode.window.showQuickPick(['Continue an existing conversation', 'Switch without copying history'], { title: `Switch to ${profile.name}` });
    if (!mode) return;
    let session, source;
    if (mode === 'Continue an existing conversation') {
      const current = entries().find(e => e.name === CONFIG)?.value || process.env[CONFIG] || path.join(os.homedir(), '.claude');
      const sources = [{ label: 'Currently configured panel profile', directory: current }, ...profiles().map(p => ({ label: p.name, directory: p.directory })), { label: 'Original default Claude directory', directory: path.join(os.homedir(), '.claude') }];
      source = await vscode.window.showQuickPick(sources.filter(p => path.resolve(p.directory).toLowerCase() !== path.resolve(profile.directory).toLowerCase()), { title: 'Which profile contains the conversation to continue?' });
      if (!source) return;
      const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
      if (!folders.length) throw new Error('Open the conversation’s project folder first.');
      const sessions = await listSessions(source.directory, folders, store);
      if (!sessions.length) throw new Error('No saved conversations found for the open project in that profile. Check the source profile and project folder.');
      session = (await vscode.window.showQuickPick(sessions.map(s => ({ label: s.title, description: new Date(s.modified).toLocaleString(), detail: s.id, session: s })), { title: 'Select the conversation (newest first)' }))?.session;
      if (!session) return;
    }
    const accept = await vscode.window.showWarningMessage(session
      ? `Continue this conversation as ${profile.name}? First stop Claude in both profiles, including CLI and background sessions. Afterwards both profiles share this conversation: what you add in one appears in the other, so never continue it in two profiles at once. Anything only the destination's version has is backed up. Messages are sent with ${profile.name}'s account. Other windows share the panel setting.`
      : `Configure the chat panel for ${profile.name}? This updates the local user setting shared by VS Code windows. Finish active Claude work first. Existing sessions are not migrated.`, { modal: true }, session ? 'Stopped — Carry and Switch' : 'Switch Profile');
    if (!accept) return;
    if (session) await assertDestinationAvailable(profile.directory, session.id, undefined, { ...transferOptions(), source: source.directory });
    if (session) session = await transferSession(source.directory, profile.directory, session, transferOptions());
    if (!context.globalState.get('original')) {
      await context.globalState.update('original', { directoryEntries: entries().filter(e => e.name === CONFIG) });
    }
    await config().update('environmentVariables', panelEntries(entries(), profile), vscode.ConfigurationTarget.Global);
    // After the restart, the copied conversation opens automatically.
    await context.workspaceState.update('pendingResume', session ? { profile, session, autoResume: true } : undefined);
    refresh();
    knownDirectory = currentDirectory();
    await collectGarbage();
    await restartClaude(session ? `${titleOf(session)} is now ${session.linked?.length ? `shared with ${profile.name}` : `carried to ${profile.name}`}; backups are kept.${fallbackNotice([session]) ? ` ${fallbackNotice([session])}` : ''} To continue it in a terminal, run Resume Copied Conversation.` : `Claude now uses ${profile.name}. Existing CLI terminals keep their account until reopened.`);
  }
  async function resumeCopied() {
    let pending = context.workspaceState.get('pendingResume');
    if (!pending) {
      const last = context.workspaceState.get('lastWorkspaceTransfer');
      if (last?.sessions.length) {
        const item = await vscode.window.showQuickPick(last.sessions.map(session => ({ label: session.title, description: new Date(session.modified).toLocaleString(), session })), { title: 'Resume a copied conversation' });
        if (!item) return;
        pending = { profile: last.profile, session: item.session };
      }
    }
    if (!pending) return vscode.window.showInformationMessage('No copied conversation for this workspace. Switch profiles and choose Continue an existing conversation.');
    if (!isCurrent(pending.profile)) throw new Error('Panel profile changed. Switch back to the destination profile before resuming.');
    const action = await vscode.window.showInformationMessage(`Resume the copied conversation as ${pending.profile.name}. For the panel, reload the window first. Check the account before sending.`, 'Resume in Panel', 'Resume in CLI', 'Show Backup');
    if (action === 'Resume in Panel') await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://anthropic.claude-code/open?session=${encodeURIComponent(pending.session.id)}`));
    if (action === 'Resume in CLI') await launch(pending.profile, false, pending.session);
    if (action === 'Show Backup') {
      if (pending.session.backup) {
        // The kept versions are rebuilt from the archive into exports/<backup id>
        // (verified, never overwriting a different file); the manifest is shown when nothing was kept.
        const exported = await storageApi().exportManifest(SWITCHER_ROOT, pending.session.backup);
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(exported.files.length ? exported.files[0].target : pending.session.backup));
        if (!exported.files.length) await vscode.window.showInformationMessage('This switch replaced nothing that differed, so the backup record lists no kept versions.');
      }
      else await vscode.window.showInformationMessage('This conversation is in shared storage, so nothing was copied and no backup was needed.');
    }
  }
  async function restore() {
    await config().update('environmentVariables', restoreDirectory(entries(), builtin.directoryEntries), vscode.ConfigurationTarget.Global);
    await context.workspaceState.update('pendingResume', undefined);
    await context.workspaceState.update('lastWorkspaceTransfer', undefined);
    refresh();
    knownDirectory = currentDirectory();
    const notice = 'Default configuration restored. No history files were changed.';
    if (vscode.extensions.getExtension('anthropic.claude-code')?.isActive) await restartClaude(notice);
    else await vscode.window.showInformationMessage(notice);
  }
  const retentionDays = () => {
    const value = vscode.workspace.getConfiguration('claudeProfiles').get('backupRetentionDays', 30);
    return Number.isFinite(value) && value >= 1 ? value : 30;
  };
  // Retention after a switch is best effort; Manage Storage runs it as well.
  // The switch also starts an archive capture in the background.
  async function collectGarbage() {
    if (!backgroundAllowed()) return;
    try { await storageApi().gc(SWITCHER_ROOT, { retentionDays: retentionDays(), lock: { wait: 2000 } }); } catch { /* Runs again after the next switch. */ }
    scheduleCapture(0);
  }
  const storageProfiles = () => profiles().map(p => ({ id: p.id, name: p.name, directory: p.directory, builtin: !!p.builtin }));
  // Archive capture (C2): on activation, after each switch and every 30
  // minutes. It only reads working copies, works in batches under the store
  // lock, and stops when another window holds the lock (C3). Best effort.
  let capturing = false, captureTimer = null, disposed = false;
  const CAPTURE_EVERY = 30 * 60 * 1000;
  async function runCapture() {
    if (capturing || disposed || !backgroundAllowed()) return;
    const s = storageApi();
    if (typeof s.capture !== 'function') return;
    capturing = true;
    try { await s.capture({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles(), lock: { wait: 1000 } }); } catch { /* The next run continues. */ } finally { capturing = false; }
  }
  function scheduleCapture(delay) {
    if (disposed || !backgroundAllowed()) return;
    if (captureTimer && typeof clearTimeout === 'function') clearTimeout(captureTimer);
    captureTimer = setTimeout(async () => {
      captureTimer = null;
      if (capturing) return;
      await runCapture();
      // The next run is scheduled once this one has finished.
      if (!captureTimer) scheduleCapture(CAPTURE_EVERY);
    }, delay);
    captureTimer?.unref?.();
  }
  const progress = (title, run) => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, run);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const ARCHIVE_PATH = path.join(SWITCHER_ROOT, 'backups', 'archive');
  async function showReport(content) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: 'markdown' }), { preview: false });
  }
  // Runs a follow-up step as its own command, so another action cannot start
  // while it runs and the original command did not have to wait for it.
  async function guarded(run, label = 'a storage action') {
    if (busy) return vscode.window.showInformationMessage(busyMessage());
    busy = true;
    busyLabel = label;
    try { await run(); } catch (error) { await vscode.window.showErrorMessage(`Claude Profiles: ${error.message}`); } finally { busy = false; busyLabel = ''; knownDirectory = currentDirectory(); }
  }
  // What holds the extension (an action and, in Optimize Storage, its step).
  let busyLabel = '';
  const busyMessage = () => `Another Claude Profiles action is still running or waiting for you (${busyLabel || 'an earlier action'}). Open Notifications: Show Notifications to continue or close it.`;
  const NOTIFY_HINT = ' If the notification has closed, open Manage Storage again or run Notifications: Show Notifications.';
  // One gate for every destructive storage step: the report is already open,
  // a non-modal notification lets the user (and a screen reader) read it at
  // their own pace, and only its button opens the confirmation modal.
  // Nothing changes until that modal is confirmed.
  function gate(message, action, proceed) {
    void Promise.resolve(vscode.window.showInformationMessage(message, action)).then(choice => choice === action ? guarded(proceed) : undefined);
  }
  async function pickStorageProfiles(title, shared, placeHolder) {
    const s = storageApi(), items = [];
    for (const p of storageProfiles().filter(p => !p.builtin)) {
      const member = await s.isPoolMember(p.directory, SWITCHER_ROOT);
      if (shared === undefined || member === shared) items.push({ label: p.name, description: member ? 'Uses shared storage' : p.directory, profile: p });
    }
    if (!items.length) {
      await vscode.window.showInformationMessage(shared ? 'No profile uses shared storage.' : 'No profile can join shared storage. The Default profile keeps copy-based switching.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { title, canPickMany: true, placeHolder });
    return picked?.length ? picked.map(item => item.profile) : undefined;
  }
  // Analysis can take minutes on large histories. It shows a file count and can
  // be cancelled; it is read-only, so cancelling leaves nothing behind.
  // Returns undefined when cancelled.
  // Where cleanupPeriodDays can be set outside the profiles: Claude Code's
  // managed settings file for this platform, and the open projects' settings.
  function cleanupSources() {
    const managed = process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json'), path.join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-settings.json')]
      : process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode/managed-settings.json'] : ['/etc/claude-code/managed-settings.json'];
    return { managed, projects: (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath) };
  }
  async function analyzeWithProgress(selected = []) {
    const s = storageApi();
    const controller = new AbortController();
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Analyzing Claude storage (read-only)', cancellable: true }, (report, token) => {
        token?.onCancellationRequested?.(() => controller.abort());
        let last = 0;
        return s.analyze({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles(), selected, signal: controller.signal, cleanupSources: cleanupSources(), onProgress: ({ done, total }) => {
          const percent = total ? Math.floor((done / total) * 100) : 100;
          report?.report?.({ message: `${done} of ${plural(total, 'file', 'files')} checked`, increment: Math.max(0, percent - last) });
          last = percent;
        } });
      });
    } catch (error) {
      if (!error.cancelled) throw error;
      await vscode.window.showInformationMessage('Analysis cancelled. Nothing was changed.');
    }
  }
  async function analyzeStorage() {
    const analysis = await analyzeWithProgress();
    if (analysis) await showReport(storageApi().renderReport(analysis));
  }
  // Decision 11 and gate 4: the shared-folder (junction) migration is never
  // offered. Only resuming or rolling back an existing one remains.
  async function resumeMigration() {
    const accept = await vscode.window.showWarningMessage('Resume the interrupted migration? First close the Claude chat panels in all VS Code windows and exit claude in every terminal.', { modal: true }, 'Resume');
    if (!accept) return;
    const result = await progress('Resuming migration', () => storageApi().resumeMigration({ switcherRoot: SWITCHER_ROOT, confirm: true }));
    await vscode.window.showInformationMessage(`Shared storage is ready for ${result.profiles.join(', ')}.`);
  }
  // Runs capture until it reports complete (another window may hold the lock
  // for a while); returns false when it was cancelled or could not complete.
  async function captureUntilComplete(title) {
    const s = storageApi();
    for (let round = 0; round < 20; round++) {
      const result = await cancellable(title, (signal, say) => s.capture({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles(), signal, lock: { wait: 10000 }, onBatch: ({ done: n, total }) => say(`${n} of ${plural(total, 'file', 'files')}`) }));
      if (result.complete) return result;
      if (result.cancelled) return false;
    }
    return false;
  }
  async function cleanStorage(retried = false) {
    const s = storageApi();
    // Read-only preview first, as for migration: the user sees exactly what goes.
    // Refuses unless a complete archive capture has run since the last change
    // to live history (requireCapture), so nothing is deleted before it is archived.
    let plan;
    try { plan = await progress('Checking redundant backups (read-only)', () => s.cleanup({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles(), dryRun: true, requireCapture: true })); }
    catch (error) {
      if (error.code !== 'ENOTCAPTURED' || retried) throw error;
      const choice = await vscode.window.showWarningMessage(error.message, {}, 'Capture Now');
      if (choice !== 'Capture Now') return;
      if (!(await captureUntilComplete('Capturing conversations into the archive'))) return vscode.window.showWarningMessage('The capture did not complete (it was cancelled, or Claude kept changing conversations). Stop Claude in every window and try again. Nothing was deleted.');
      return cleanStorage(true);
    }
    await showReport(s.renderCleanupPlan(plan) + (plan.blocked ? '' : ['', '## How cleanup runs', '',
      `- Unpinned backups older than backupRetentionDays (${retentionDays()} days) also expire.`,
      '- Cleanup runs in short batches, one snapshot at a time, so switching profiles keeps working while it runs. You can cancel between batches; what was deleted by then was checked first.'].join('\n') + '\n'));
    if (plan.blocked) return vscode.window.showWarningMessage('Clean Redundant Backups is blocked by an unreadable backup manifest. The report lists it; fix or remove it, then try again.');
    if (!plan.delete.length) return vscode.window.showInformationMessage('There are no redundant backups to delete.');
    gate('Read the cleanup preview, then choose Clean Redundant Backups to continue. If the notification has closed, open Manage Storage again or run Notifications: Show Notifications.', 'Clean Redundant Backups…', async () => {
      const accept = await vscode.window.showWarningMessage(`Delete the ${plural(plan.delete.length, 'backup file', 'backup files')} (${s.formatBytes(plan.bytes)}) listed in the preview, freeing ${s.formatBytes(plan.net)} net? Each file is deleted only when its exact content is kept elsewhere, checked again just before deletion. ${plural(plan.move.length, 'file with unique content is', 'files with unique content are')} moved into the archive (${ARCHIVE_PATH}) first, using ${s.formatBytes(plan.movedBytes)} there; ${plural(plan.skipped.length, 'item is', 'items are')} skipped.`, { modal: true }, 'Delete Redundant Backups');
      if (!accept) return;
      // N7: each snapshot without a manifest needs its own confirmation.
      const snapshots = [];
      for (const snap of plan.manifestless || []) {
        const choice = await vscode.window.showWarningMessage(`Remove the snapshot ${snap.path} (${plural(snap.files, 'file', 'files')}, ${s.formatBytes(snap.bytes)})? It has no manifest. Every file is archived under a pinned backup first, and the snapshot is deleted only if every file rebuilds from the archive.`, { modal: true }, 'Archive and Remove', 'Keep It', 'Keep All Remaining');
        if (choice === 'Archive and Remove') snapshots.push(snap.path);
        else if (choice !== 'Keep It') break;
      }
      const controller = new AbortController();
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Cleaning redundant backups', cancellable: true }, (report, token) => {
        token?.onCancellationRequested?.(() => controller.abort());
        return s.cleanup({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles(), confirm: true, requireCapture: true, snapshots, signal: controller.signal, onProgress: ({ done, total }) => report?.report?.({ message: `${done} of ${plural(total, 'file', 'files')} checked` }) });
      });
      const collected = await s.gc(SWITCHER_ROOT, { retentionDays: retentionDays(), compact: true });
      await showReport([
        '# Backup cleanup', '',
        ...(result.cancelled ? ['- Cancelled between batches. Everything deleted so far was checked first; run Clean Redundant Backups again to continue.'] : []),
        ...(result.snapshots || []).map(x => `- Snapshot without a manifest ${x.path}: ${x.removed ? 'archived and removed' : `kept (${x.reason || 'not every file could be removed'})`}.`),
        `- Deleted ${plural(result.deleted, 'file', 'files')} (${s.formatBytes(result.deletedBytes)}). Net space freed: ${s.formatBytes(result.freed)}.`,
        `- Moved ${plural(result.moved, 'file', 'files')} with unique content into the archive (${ARCHIVE_PATH}), using ${s.formatBytes(result.movedBytes)} there${result.manifest ? '; kept as a pinned backup' : ''}.`,
        `- Garbage collection freed ${s.formatBytes(collected.freed)} more in the archive.`,
        `- Expired ${plural(collected.removedManifests.length, 'unpinned backup record', 'unpinned backup records')} older than ${retentionDays()} days and removed ${plural(collected.removedObjects.length, 'unreferenced stored file', 'unreferenced stored files')}.`,
        '', '## Skipped', '', ...(result.skipped.length ? result.skipped.map(item => `- ${item.path}: ${item.reason}`) : ['Nothing.'])
      ].join('\n') + '\n');
    });
  }
  // The gate pattern, awaited inside a guided flow: the report is open, a
  // non-modal notification's button opens the modal, and only the modal
  // confirms. Anything else stops the flow.
  // Every notice ends with the hint for reaching it again. With more than one
  // label, the chosen label is returned (false when none was chosen).
  async function confirmStep(notice, button, question, label, ...others) {
    const choice = await vscode.window.showInformationMessage(notice + NOTIFY_HINT, button);
    if (choice !== button) return false;
    const picked = await vscode.window.showWarningMessage(question, { modal: true }, label, ...others);
    if (others.length) return [label, ...others].includes(picked) ? picked : false;
    return picked === label;
  }
  // Runs a long step with progress and Cancel; returns its result.
  async function cancellable(title, run) {
    const controller = new AbortController();
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, (report, token) => {
      token?.onCancellationRequested?.(() => controller.abort());
      return run(controller.signal, message => report?.report?.({ message }));
    });
  }
  // Optimize Storage: the architect's order, one step at a time. Each step
  // shows its preview or report and needs confirmation; the flow stops at the
  // first failure or refusal, and the final report lists every step.
  async function optimizeStorage() {
    const s = storageApi(), l = linkingApi(), root = SWITCHER_ROOT, list = storageProfiles();
    const done = [];
    const step = n => { busyLabel = `Optimize Storage, step ${n} of 6`; };
    const stop = async reason => { await showReport(['# Optimize Storage', '', ...done.map(x => `- ${x}`), '', `**Stopped:** ${reason}`, '', 'Completed steps stay done; run Optimize Storage again to continue from where it stopped. Clean Redundant Backups can also run on its own from Manage Storage.'].join('\n') + '\n'); };
    try {
      // Claude must be stopped everywhere before anything starts (linking needs it).
      step(1);
      await s.assertClaudeStopped(list);
      // 1. Preview: what is diverged and where each version is kept, and the old store.
      const reconcile = await progress('Optimize Storage: checking diverged versions (read-only)', () => s.reconcileDiverged({ switcherRoot: root, profiles: list }));
      const legacy = await s.legacyObjects(root);
      await showReport(['# Optimize Storage (preview)', '', 'Read-only so far. The steps run in this order, each after its own preview and confirmation:', '',
        '1. Move the old recovery store into the archive (only if it still holds files)', '2. Capture every conversation until the capture is complete', '3. Verify storage integrity (every archived version rebuilt)', '4. Link identical conversations (you can skip this)', '5. Clean redundant backups', '6. Verify again, then compact the archive', '',
        `Old recovery store: ${plural(legacy.length, 'file', 'files')} to move into the archive.`, '', s.renderReconcile(reconcile)].join('\n') + '\n');
      if (legacy.length) {
        if (!(await confirmStep('Step 1 of 6: read the preview, then choose Continue to move the old recovery store into the archive.', 'Continue…', `Move ${plural(legacy.length, 'stored file', 'stored files')} into the archive? Each one is deleted from the old recovery store only after it rebuilds from the archive.`, 'Move into Archive'))) return stop('not confirmed at step 1.');
        const moved = await progress('Optimize Storage: moving the old recovery store into the archive', () => s.importObjects(root, { confirm: true }));
        if (moved.damaged.length) return stop(`${plural(moved.damaged.length, 'damaged file was', 'damaged files were')} kept in the old recovery store: ${moved.damaged.join(', ')}.`);
        done.push(`Step 1: moved ${plural(moved.deleted, 'file', 'files')} into the archive.`);
      } else done.push('Step 1: the old recovery store was already empty.');
      // 2. Capture until complete.
      step(2);
      const status = await s.captureStatus({ switcherRoot: root, profiles: list });
      if (!(await confirmStep(`Step 2 of 6: ${status.current ? 'the capture is already complete; it runs once more to confirm' : `${plural(status.pending.length, 'changed file is', 'changed files are')} not in the archive yet`}. Keep Claude stopped until Optimize Storage finishes. Read the preview, then choose Continue.`, 'Continue…', 'Capture every conversation into the archive now? Working copies are only read.', 'Capture'))) return stop('not confirmed at step 2.');
      let captured = null;
      for (let round = 0; round < 20 && !captured?.complete; round++) {
        captured = await cancellable('Optimize Storage: capturing conversations', (signal, say) => s.capture({ switcherRoot: root, profiles: list, signal, lock: { wait: 10000 }, onBatch: ({ done: n, total }) => say(`${n} of ${plural(total, 'file', 'files')}`) }));
        if (captured.cancelled) return stop('capture was cancelled.');
      }
      if (!captured?.complete) return stop('the capture could not complete (another window kept the storage lock). Try again later.');
      done.push(`Step 2: captured ${plural(captured.versions, 'new version', 'new versions')}; the capture is complete.`);
      // 3. Verify with full rebuilds.
      step(3);
      const first = await progress('Optimize Storage: verifying every archived version', () => s.verify({ switcherRoot: root, profiles: list, full: true }));
      await showReport(s.renderVerify(first));
      if (!first.ok) return stop('Verify Storage Integrity found problems (see its report).');
      done.push('Step 3: storage integrity verified with full rebuilds.');
      // 4. Link identical conversations, or skip linking and continue.
      step(4);
      const plan = await progress('Optimize Storage: checking identical conversations (read-only)', () => l.linkIdentical({ switcherRoot: root, profiles: list, dryRun: true }));
      await showReport(l.renderLinkPlan(plan));
      const linkChoice = plan.groups.length
        ? await confirmStep('Step 4 of 6: read the linking preview, then choose Continue.', 'Continue…', `Link the identical conversation copies, saving ${s.formatBytes(plan.saved)}? Afterwards those profiles share each linked conversation: never continue one conversation in two profiles at once. You can also skip linking and continue with cleanup.`, 'Link Conversations', 'Skip Linking')
        : await confirmStep('Step 4 of 6: there is nothing to link. Choose Continue for the next step.', 'Continue…', 'There is nothing to link. Continue with cleanup?', 'Continue');
      if (!linkChoice) return stop('not confirmed at step 4.');
      if (plan.groups.length && linkChoice === 'Link Conversations') {
        const linked = await progress('Optimize Storage: linking identical conversations', () => l.linkIdentical({ switcherRoot: root, profiles: list, confirm: true }));
        done.push(`Step 4: linked ${plural(linked.linked, 'conversation copy', 'conversation copies')}, saving ${s.formatBytes(linked.saved)}.`);
      } else done.push(plan.groups.length ? 'Step 4: linking skipped.' : 'Step 4: nothing to link.');
      // 5. Clean redundant backups (refuses unless the capture is still current).
      step(5);
      const cleanPlan = await progress('Optimize Storage: checking redundant backups (read-only)', () => s.cleanup({ switcherRoot: root, profiles: list, dryRun: true, requireCapture: true }));
      await showReport(s.renderCleanupPlan(cleanPlan));
      if (cleanPlan.blocked) return stop('cleanup is blocked by an unreadable backup manifest (see the preview).');
      if (!(await confirmStep('Step 5 of 6: read the cleanup preview, then choose Continue.', 'Continue…', `Delete the ${plural(cleanPlan.delete.length, 'backup file', 'backup files')} (${s.formatBytes(cleanPlan.bytes)}) listed in the preview, freeing ${s.formatBytes(cleanPlan.net)} net? Each file is deleted only when its exact content is kept elsewhere, checked again just before deletion. Snapshots without a manifest are kept; remove them separately with Clean Redundant Backups.`, 'Delete Redundant Backups'))) return stop('not confirmed at step 5.');
      const cleaned = await cancellable('Optimize Storage: cleaning redundant backups', (signal, say) => s.cleanup({ switcherRoot: root, profiles: list, confirm: true, requireCapture: true, signal, onProgress: ({ done: n, total }) => say(`${n} of ${plural(total, 'file', 'files')} checked`) }));
      if (cleaned.cancelled) return stop('cleanup was cancelled between batches; what was deleted was checked first.');
      done.push(`Step 5: deleted ${plural(cleaned.deleted, 'backup file', 'backup files')}, freeing ${s.formatBytes(cleaned.freed)} net.`);
      // 6. Verify again, confirm every diverged version, then compact.
      step(6);
      const second = await progress('Optimize Storage: verifying again', () => s.verify({ switcherRoot: root, profiles: list, full: true }));
      if (!second.ok) { await showReport(s.renderVerify(second)); return stop('the second verification found problems (see its report).'); }
      // Gate 5 is confirmed before garbage collection and compaction, so a
      // missing version stops the flow while nothing more can be dropped.
      const confirmed = await progress('Optimize Storage: confirming every diverged version', () => s.reconcileDiverged({ switcherRoot: root, profiles: list, expect: reconcile }));
      await showReport([s.renderVerify(second), s.renderReconcile(confirmed)].join('\n'));
      if (confirmed.missing) {
        await vscode.window.showWarningMessage(`${plural(confirmed.missing, 'diverged version does', 'diverged versions do')} not rebuild from the archive. The report lists them.`);
        return stop(`${plural(confirmed.missing, 'diverged version does', 'diverged versions do')} not rebuild from the archive; garbage collection and compaction were not run.`);
      }
      done.push('Step 6: verified again; every diverged version rebuilds from the archive.');
      if (!(await confirmStep('Step 6 of 6: storage verified again and every diverged version confirmed. Choose Continue to compact the archive.', 'Continue…', 'Compact the archive? Packs are rewritten without the data nothing references any more; every referenced version stays.', 'Compact'))) return stop('not confirmed at step 6.');
      const collected = await progress('Optimize Storage: compacting the archive', () => s.gc(root, { retentionDays: retentionDays(), compact: true }));
      done.push(`Compaction freed ${s.formatBytes(collected.freed)}.`);
      await showReport(['# Optimize Storage', '', ...done.map(x => `- ${x}`), '', s.renderReconcile(confirmed)].join('\n') + '\n');
    } catch (error) {
      await stop(error.message);
      throw error;
    }
  }
  async function verifyStorage() {
    const s = storageApi();
    const result = await progress('Verifying storage', () => s.verify({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles() }));
    await showReport(s.renderVerify(result));
  }
  async function rollbackStorage() {
    const s = storageApi();
    const journal = await s.readJournal(SWITCHER_ROOT);
    const chosen = journal?.state === 'running' ? journal.profiles : await pickStorageProfiles('Roll back shared storage: choose profiles', true, 'Select the profiles that should get private history folders again.');
    if (!chosen) return;
    const accept = await vscode.window.showWarningMessage(`Give ${chosen.map(p => p.name).join(', ')} private history folders again? First close the Claude chat panels in all VS Code windows and exit claude in every terminal. Shared storage is kept. Where a private copy differs from the shared one, the private copy is kept and the shared version goes to the archive (${ARCHIVE_PATH}).`, { modal: true }, 'Roll Back');
    if (!accept) return;
    const result = await progress('Rolling back shared storage', () => s.rollback({ switcherRoot: SWITCHER_ROOT, profiles: chosen, confirm: true }));
    await showReport(['# Shared storage rollback', '', result.interruptedMigration ? 'The interrupted migration was undone; every profile was restored.' : `Restored: ${result.restored.join(', ') || 'nothing'}.`,
      '', '## Diverged files', '', ...(result.diverged.length ? result.diverged.map(d => `- ${d.kept}: private copy kept; the shared version is in the archive`) : ['None.'])].join('\n') + '\n');
  }
  async function discardPinned() {
    const s = storageApi();
    const { manifests } = await s.readManifests(SWITCHER_ROOT);
    const pinned = manifests.filter(m => m.pinned);
    if (!pinned.length) return vscode.window.showInformationMessage('There are no pinned backups.');
    const picked = await vscode.window.showQuickPick(pinned.map(m => ({ label: s.backupLabel(m), description: `${plural((m.objects || []).length, 'file', 'files')}, ${s.formatBytes((m.objects || []).reduce((n, o) => n + (o.size || 0), 0))}`, detail: `Holds: ${(m.objects || []).slice(0, 3).map(o => o.name).join(', ') || 'nothing'}${(m.objects || []).length > 3 ? ', and more' : ''}`, manifest: m })), { title: 'Discard pinned backups (content that exists nowhere else)', placeHolder: 'Select the backups to delete permanently', canPickMany: true });
    if (!picked?.length) return;
    const accept = await vscode.window.showWarningMessage(`Permanently delete ${plural(picked.length, 'pinned backup', 'pinned backups')}? They hold conversation versions that exist nowhere else.`, { modal: true }, 'Delete Permanently');
    if (!accept) return;
    const result = await s.discardManifests(SWITCHER_ROOT, picked.map(item => item.manifest.id), { confirm: true });
    await vscode.window.showInformationMessage(`Discarded ${plural(picked.length, 'pinned backup', 'pinned backups')}, freeing ${s.formatBytes(result.freed)}.`);
  }
  // A6: pick a file, then a version, then restore it into a profile (only where
  // that file is missing or identical) or export it to a chosen location.
  async function restoreOrExport() {
    const s = storageApi();
    const groups = await progress('Reading the archive', () => s.archivedVersions(SWITCHER_ROOT));
    if (!groups.length) return vscode.window.showInformationMessage('The archive holds no versions yet.');
    // Conversation titles from the profiles' current history, where it still exists.
    const titles = new Map();
    for (const p of profiles()) {
      try { for (const x of await listSessions(p.directory, null, store)) if (!titles.has(x.id)) titles.set(x.id, x.title); } catch { /* A profile without history. */ }
    }
    const describe = g => {
      const parts = g.key.split(/[\\/]/), id = (parts[2] || '').replace(/\.jsonl$/i, '');
      const newest = g.versions[0]?.time;
      if (parts[0] === 'projects' && parts.length === 3) return { label: titles.get(id) || `Conversation ${id.slice(0, 8)}`, description: `project ${parts[1]} · ${s.localTime(newest)} · ${plural(g.versions.length, 'version', 'versions')}` };
      return { label: parts[0] === 'file-history' ? `Checkpoint ${parts.slice(2).join('/')}` : parts.slice(-1)[0], description: `${parts[0] === 'projects' ? `project ${parts[1]}` : parts[0]} · ${s.localTime(newest)} · ${plural(g.versions.length, 'version', 'versions')}` };
    };
    const group = (await vscode.window.showQuickPick(groups.map(g => ({ ...describe(g), detail: g.key, group: g })), { title: 'Restore or export: choose a conversation or file', matchOnDescription: true, matchOnDetail: true }))?.group;
    if (!group) return;
    const version = (await vscode.window.showQuickPick(group.versions.map(v => ({ label: `${s.localTime(v.time)} · ${s.formatBytes(v.size || 0)}`, description: [v.captured ? 'captured' : 'in a backup', v.superseded ? 'extended by a newer version' : 'kept until discarded'].join(' · '), detail: `version ${v.sha256.slice(0, 12)}`, version: v })), { title: 'Choose a version (newest first)' }))?.version;
    if (!version) return;
    const actions = ['Export to File…', 'Restore into a Profile…', ...(version.captured ? ['Discard This Version…'] : [])];
    // A version held only by a backup is removed with that backup (Discard Pinned Backups), not here.
    const action = await vscode.window.showQuickPick(actions, { title: 'What should happen with this version?', placeHolder: version.captured ? undefined : 'This version is kept by a backup, so it has no Discard option here: remove it with Discard Pinned Backups, which lists what each backup holds.' });
    if (action === 'Export to File…') {
      const uri = await vscode.window.showSaveDialog?.({ defaultUri: vscode.Uri.file(path.join(SWITCHER_ROOT, 'exports', path.basename(group.key))), title: 'Export the version' });
      if (!uri) return;
      const result = await s.exportVersion(SWITCHER_ROOT, version.sha256, uri.fsPath);
      await vscode.window.showInformationMessage(result.identical ? `${uri.fsPath} already holds this exact version; nothing was written.` : `Exported and verified: ${uri.fsPath}`);
    } else if (action === 'Restore into a Profile…') {
      const profile = await choose();
      if (!profile) return;
      const accept = await vscode.window.showWarningMessage(`Restore "${describe(group).label}" into ${profile.name}? It is written only if the file is missing there; a different version is never overwritten.`, { modal: true }, 'Restore');
      if (!accept) return;
      const result = await s.restoreVersion(SWITCHER_ROOT, version.sha256, { directory: profile.directory, rel: group.key });
      await vscode.window.showInformationMessage(result.identical ? `${profile.name} already has this exact version.` : `Restored and verified: ${result.target}`);
    } else if (action === 'Discard This Version…') {
      const name = describe(group).label;
      const accept = await vscode.window.showWarningMessage(`Discard this captured version of "${name}"? To remove a conversation completely: delete it from every profile first (otherwise the background capture archives it again), discard each of its archived versions here, then discard any pinned backup that still holds it with Discard Pinned Backups. This cannot be undone.`, { modal: true }, 'Discard');
      if (!accept) return;
      await s.discardVersions(SWITCHER_ROOT, [{ key: group.key, sha256: version.sha256 }], { confirm: true });
      // The real outcome: what still keeps this version, if anything.
      const left = await s.discardOutcome(SWITCHER_ROOT, { key: group.key, sha256: version.sha256, size: version.size, profiles: storageProfiles() });
      const notes = [];
      const pinned = left.keptBy.filter(b => b.pinned), expiring = left.keptBy.filter(b => !b.pinned);
      if (pinned.length) notes.push(`It is still kept by ${pinned.map(b => b.label).join(', ')}; discard ${pinned.length === 1 ? 'it' : 'them'} with Discard Pinned Backups.`);
      if (expiring.length) notes.push(`It is still kept by ${expiring.map(b => b.label).join(', ')}, which ${expiring.length === 1 ? 'expires' : 'expire'} after backupRetentionDays (${retentionDays()} days).`);
      if (!left.keptBy.length && left.inNewer) notes.push('Its content is still part of a newer archived version of this conversation; discard that version too.');
      else if (!left.keptBy.length && !left.inArchive) notes.push('No copy of it remains in the archive.');
      if (left.presentIn.length) notes.push(`The conversation is still present in ${left.presentIn.join(', ')}; it will be archived again unless you delete it there.`);
      await vscode.window.showInformationMessage(`Discarded this captured version of "${name}". ${notes.join(' ')}`.trim());
    }
  }
  // N5: leftover .tmp-/.old- entries from interrupted transfers.
  async function cleanLeftoverFiles() {
    const s = storageApi();
    const plan = await progress('Looking for leftover transfer files (read-only)', () => s.cleanLeftovers({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles(), dryRun: true }));
    await showReport(s.renderLeftovers(plan));
    if (!plan.leftovers.length) return vscode.window.showInformationMessage('There are no leftover transfer files.');
    gate('Read the preview, then choose Remove Leftover Files to continue. If the notification has closed, open Manage Storage again or run Notifications: Show Notifications.', 'Remove Leftover Files…', async () => {
      const accept = await vscode.window.showWarningMessage(`Remove ${plural(plan.leftovers.length, 'leftover entry', 'leftover entries')} listed in the preview? Content that is not kept elsewhere is archived under a pinned backup first. To get something back later, use Restore or Export a Version.`, { modal: true }, 'Remove Leftover Files');
      if (!accept) return;
      const result = await progress('Removing leftover transfer files', () => s.cleanLeftovers({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles(), confirm: true }));
      await vscode.window.showInformationMessage(`Removed ${plural(result.removed, 'leftover entry', 'leftover entries')} (${s.formatBytes(result.deletedBytes)}); ${plural(result.moved, 'file was', 'files were')} archived first; ${plural(result.skipped.length, 'item', 'items')} skipped.`);
    });
  }
  // M1-M5: replace identical transcript copies across profiles with one
  // hard-linked file. Preview first; Claude must be stopped everywhere.
  const linkingApi = () => require('./linking');
  async function linkConversations() {
    const l = linkingApi(), s = storageApi();
    const plan = await progress('Checking identical conversations (read-only)', () => l.linkIdentical({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles(), dryRun: true }));
    await showReport(l.renderLinkPlan(plan));
    if (!plan.groups.length) return vscode.window.showInformationMessage('There are no identical conversation copies to link.');
    const names = plan.groups.reduce((n, g) => n + g.targets.length, 0);
    gate('Read the preview, then choose Link Identical Conversations to continue. If the notification has closed, open Manage Storage again or run Notifications: Show Notifications.', 'Link Identical Conversations…', async () => {
      const accept = await vscode.window.showWarningMessage(`Link ${plural(names, 'identical transcript copy', 'identical transcript copies')} into shared files, saving ${s.formatBytes(plan.saved)}? First close the Claude chat panels in all VS Code windows and exit claude in every terminal. Every distinct version is archived first. Afterwards those profiles share each linked conversation: never continue one conversation in two profiles at once. Checkpoints and images stay separate copies. To undo, use Undo Conversation Linking.`, { modal: true }, 'Link Conversations');
      if (!accept) return;
      const result = await progress('Linking identical conversations', () => l.linkIdentical({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles(), confirm: true }));
      await vscode.window.showInformationMessage(`Linked ${plural(result.linked, 'transcript copy', 'transcript copies')} in ${plural(result.groups, 'group', 'groups')}, saving ${s.formatBytes(result.saved)}.`);
    });
  }
  async function resumeLinking() {
    const accept = await vscode.window.showWarningMessage('Resume the interrupted conversation linking? First close the Claude chat panels in all VS Code windows and exit claude in every terminal.', { modal: true }, 'Resume');
    if (!accept) return;
    await progress('Resuming conversation linking', () => linkingApi().resumeLinks({ switcherRoot: SWITCHER_ROOT, confirm: true }));
    await vscode.window.showInformationMessage('Conversation linking finished.');
  }
  async function undoLinking() {
    const accept = await vscode.window.showWarningMessage('Give every linked conversation its own copy in each profile again? First close the Claude chat panels in all VS Code windows and exit claude in every terminal. This needs free disk space for the extra copies; it is checked first.', { modal: true }, 'Undo Linking');
    if (!accept) return;
    const result = await progress('Undoing conversation linking', () => linkingApi().undoLinks({ switcherRoot: SWITCHER_ROOT, confirm: true }));
    await vscode.window.showInformationMessage(`${plural(result.restored, 'linked name is', 'linked names are')} a separate copy again.`);
  }
  // A4: journaled move of the old whole-file objects into the archive.
  async function importLegacy(count) {
    const s = storageApi();
    const accept = await vscode.window.showWarningMessage(`Move ${plural(count, 'stored file', 'stored files')} from the old recovery store into the archive? Each one is deleted only after it rebuilds from the archive. An interrupted move continues next time.`, { modal: true }, 'Move into Archive');
    if (!accept) return;
    const result = await progress('Moving the old recovery store into the archive', () => s.importObjects(SWITCHER_ROOT, { confirm: true }));
    await vscode.window.showInformationMessage(`Moved ${plural(result.deleted, 'stored file', 'stored files')} into the archive.${result.damaged.length ? ` ${plural(result.damaged.length, 'damaged file was', 'damaged files were')} kept in the old recovery store.` : ''}`);
  }
  async function resolveRecovery(entries) {
    const s = storageApi();
    await showReport(s.renderRecovery(entries));
    gate('Restore the files listed in the report, then choose Mark Resolved. If the notification has closed, open Manage Storage again or run Notifications: Show Notifications.', 'Mark Resolved…', async () => {
      const accept = await vscode.window.showWarningMessage('Have you restored or checked the files listed in the report? Marking this resolved allows carrying conversations between those profiles again.', { modal: true }, 'Mark Resolved');
      if (!accept) return;
      // Only the entries shown in the report are resolved; one recorded meanwhile stays.
      const result = await s.resolveRecovery(SWITCHER_ROOT, { confirm: true, ids: entries.map(s.recoveryId) });
      await vscode.window.showInformationMessage(result.remaining ? `Resolved ${plural(result.removed, 'transfer recovery entry', 'transfer recovery entries')}. ${plural(result.remaining, 'newer entry remains', 'newer entries remain')}; open Manage Storage again.` : 'Transfer recovery marked as resolved.');
    });
  }
  async function releaseLock(owner) {
    const s = storageApi();
    const accept = await vscode.window.showWarningMessage(`Release the shared-storage lock held by ${owner.unreadable ? 'an unknown owner' : `PID ${owner.pid} (${owner.purpose}, since ${s.localTime(owner.started)})`}? Only do this when that process no longer runs. It is released only if the owner is confirmed to have stopped.`, { modal: true }, 'Release Lock');
    if (!accept) return;
    await s.releaseStaleLock(SWITCHER_ROOT, { confirm: true });
    await vscode.window.showInformationMessage('The storage lock was released.');
  }
  async function clearMarker(marker) {
    const s = storageApi();
    const accept = await vscode.window.showWarningMessage(`Clear the leftover migration marker from PID ${marker.pid} (started ${s.localTime(marker.started)})? No migration is running, and the marker blocks switching. It is cleared only if it is confirmed to be left over.`, { modal: true }, 'Clear Marker');
    if (!accept) return;
    await s.clearMigrationMarker(SWITCHER_ROOT, { confirm: true });
    await vscode.window.showInformationMessage('The migration marker was cleared.');
  }
  async function manageStorage() {
    const s = storageApi();
    const [metrics, owner, journal, recovery, marker, legacy, links] = await progress('Measuring Claude storage', () => Promise.all([s.measure({ switcherRoot: SWITCHER_ROOT, profiles: storageProfiles() }), s.readStoreLock(SWITCHER_ROOT), s.readJournal(SWITCHER_ROOT).catch(() => null), s.readRecovery(SWITCHER_ROOT), s.migrationMarker(SWITCHER_ROOT).catch(() => null), (s.legacyObjects ? s.legacyObjects(SWITCHER_ROOT) : Promise.resolve([])).catch(() => []), linkingApi().readLinkJournal(SWITCHER_ROOT).catch(() => null)]));
    const separator = label => ({ label, kind: vscode.QuickPickItemKind?.Separator });
    // Choosing a metric opens the full analysis with exact numbers.
    const blocked = metric => metric.key === 'reclaimable' && metrics.reclaimableBlocked?.length;
    // Shared storage (decision 11) appears only while some profile still uses it.
    const pool = s.poolMembers ? await s.poolMembers(SWITCHER_ROOT).catch(() => []) : [];
    const sharedInUse = pool.length > 0 || metrics.shared > 0 || journal?.state === 'running';
    const rows = s.METRICS.filter(metric => metric.key !== 'shared' || sharedInUse).map(metric => ({ label: `${metric.label}: ${s.metricValue(metrics, metric.key)}`, description: blocked(metric) ? `Blocked: ${plural(metrics.reclaimableBlocked.length, 'backup manifest is', 'backup manifests are')} unreadable (${metrics.reclaimableBlocked.map(f => path.basename(f)).join(', ')})` : `${metric.description}${['duplicate', 'reclaimable'].includes(metric.key) ? ' (estimate)' : ''}`, run: analyzeStorage }));
    const actions = [
      ...(recovery?.length ? [{ label: '$(warning) Resolve Transfer Recovery', description: `${plural(recovery.length, 'failed transfer blocks', 'failed transfers block')} switching`, run: () => resolveRecovery(recovery) }] : []),
      ...(journal?.state === 'running' && journal.kind === 'migration' ? [{ label: '$(debug-continue) Resume Interrupted Migration', description: 'or roll it back below', run: resumeMigration }] : []),
      ...(marker?.stale ? [{ label: '$(clear-all) Clear Migration Marker', description: `left over by PID ${marker.pid}; it blocks switching`, run: () => clearMarker(marker) }] : []),
      { label: '$(search) Analyze Storage', description: 'Read-only report with exact numbers', run: analyzeStorage },
      { label: '$(rocket) Optimize Storage', description: 'Guided: archive, capture, verify, link, clean, verify, in that order', run: optimizeStorage },
      { label: '$(trash) Clean Redundant Backups', description: 'Shows a preview first; needs a complete capture', run: cleanStorage },
      ...(links?.state === 'running' && !links.undo ? [{ label: '$(debug-continue) Resume Conversation Linking', description: 'or undo it below', run: resumeLinking }] : []),
      { label: '$(link) Link Identical Conversations', description: 'Shows a preview first; archives every version first', run: linkConversations },
      ...(links && ['running', 'committed'].includes(links.state) ? [{ label: '$(debug-step-back) Undo Conversation Linking', description: 'Each profile gets its own copy again', run: undoLinking }] : []),
      { label: '$(history) Restore or Export a Version', description: 'From the archive; never overwrites a different file', run: restoreOrExport },
      { label: '$(clear-all) Remove Leftover Transfer Files', description: 'Shows a preview first', run: cleanLeftoverFiles },
      ...(legacy?.length ? [{ label: '$(archive) Move Recovery Store into Archive', description: plural(legacy.length, 'file in the old store', 'files in the old store'), run: () => importLegacy(legacy.length) }] : []),
      { label: '$(pass) Verify Storage Integrity', run: verifyStorage },
      ...(sharedInUse ? [{ label: '$(discard) Roll Back Shared Storage', description: 'Gives profiles that use shared storage their own folders again', run: rollbackStorage }] : []),
      { label: '$(pinned) Discard Pinned Backups', description: 'Lists what each backup holds', run: discardPinned },
      ...(owner ? [{ label: '$(unlock) Release Stale Storage Lock', description: owner.unreadable ? 'unknown owner' : `PID ${owner.pid}: ${owner.purpose}`, run: () => releaseLock(owner) }] : [])
    ];
    const pick = await vscode.window.showQuickPick([separator('Storage'), ...rows, separator('Actions'), ...actions], { title: 'Claude Profiles: Manage Storage', placeHolder: 'Choose a storage action' });
    if (pick?.run) await pick.run();
  }
  let busy = false;
  const COMMAND_NAMES = { create: 'Create Profile', storage: 'Manage Storage', switch: 'Switch Chat Panel Profile', switchCli: 'Switch CLI Profile', advancedSwitch: 'Advanced Switch', resume: 'Resume Copied Conversation', terminal: 'Open CLI with Profile', login: 'Sign In to Profile', restore: 'Restore Original Panel Configuration' };
  for (const [command, run] of Object.entries({ create, storage: manageStorage, switch: quickSwitch, switchCli: async () => switchCliTo(await choose()), advancedSwitch: switchProfile, resume: resumeCopied, terminal: async () => launch(await choose()), login: async () => launch(await choose(), true), restore })) {
    context.subscriptions.push(vscode.commands.registerCommand(`claudeProfiles.${command}`, async () => {
      if (vscode.env.remoteName) return vscode.window.showErrorMessage('This prototype supports local VS Code windows only.');
      if (!vscode.workspace.isTrusted && command !== 'restore') return;
      // Never silently ignored: say which action holds the extension and how to reach it.
      if (busy) return void vscode.window.showInformationMessage(busyMessage());
      busy = true;
      busyLabel = COMMAND_NAMES[command] || command;
      try { await run(); } catch (error) { await vscode.window.showErrorMessage(`Claude Profiles: ${error.message}`); } finally { busy = false; busyLabel = ''; knownDirectory = currentDirectory(); }
    }));
  }
  context.subscriptions.push(bar, vscode.workspace.onDidChangeConfiguration(event => {
    refresh();
    if (event?.affectsConfiguration?.('claudeCode.environmentVariables')) followAccountChange().catch(error => vscode.window.showErrorMessage(`Claude Profiles: ${error.message}`));
  }), {
    dispose: () => context.environmentVariableCollection?.clear()
  }, {
    dispose: () => { disposed = true; if (captureTimer && typeof clearTimeout === 'function') clearTimeout(captureTimer); }
  });
  // First capture shortly after activation, out of the way of startup.
  if (!vscode.env.remoteName && vscode.workspace.isTrusted) scheduleCapture(60 * 1000);
  if (vscode.window.onDidCloseTerminal) context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => cli.forget(terminal)));
  refresh();
  const notice = context.workspaceState.get('pendingNotice');
  if (notice) void context.workspaceState.update('pendingNotice', undefined).then(() => vscode.window.showInformationMessage(notice));
  const pending = context.workspaceState.get('pendingResume');
  if (pending?.autoResume && !vscode.env.remoteName && vscode.workspace.isTrusted) {
    void (async () => {
      await context.workspaceState.update('pendingResume', { ...pending, autoResume: false });
      if (!isCurrent(pending.profile)) throw new Error('The panel profile changed in another window. Automatic resume was stopped.');
      const claude = vscode.extensions.getExtension('anthropic.claude-code');
      if (!claude) throw new Error('Claude Code is unavailable.');
      await claude.activate();
      // Verified against installed Claude Code 2.1.319. This focuses an existing tab with this ID.
      await vscode.commands.executeCommand('claude-vscode.editor.open', pending.session.id);
    })().catch(error => vscode.window.showErrorMessage(`Claude Profiles: ${error.message} Use Resume Copied Conversation to retry.`));
  }
}
module.exports = { activate };
