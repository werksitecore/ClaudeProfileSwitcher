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

async function activate(context) {
  const cli = new CliContinuation();
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
      const mine = await listSessions(previous, folders);
      recent = mine.some(s => Date.now() - s.modified < BUSY_MS);
      // The switching window copies what it can; make sure this window's own
      // conversations are present and current before its chats reopen.
      const ids = new Set(mine.map(s => s.id));
      await transferEach(previous, directory, (await pendingSessions(previous, directory)).filter(s => ids.has(s.id)));
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
    const directory = path.join(os.homedir(), '.claude-profile-switcher', 'profiles', id);
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
    await assertDestinationAvailable(profile.directory, item.session.id);
    try {
      await cli.stop(item);
      await transferSession(record.profile.directory, profile.directory, item.session);
    } catch (error) {
      await restoreStoppedCli(planned);
      throw error;
    }
    await launch(profile, false, item.session);
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
    const sessions = await listSessions(source, folders);
    if (!sessions.length) throw new Error('No saved conversation was found for this workspace. Switching was cancelled; your account and history are unchanged.');
    if (sessions.some(session => Date.now() - session.modified < 2000)) throw new Error('Claude is still saving workspace history. Stop the response, wait a moment, and switch again.');
    const previous = entries();
    const plannedCli = await cli.plan([...cli.records.values()].filter(record => path.resolve(record.profile.directory).toLowerCase() === path.resolve(source).toLowerCase()));
    for (const item of plannedCli) await assertDestinationReady(profile, item.session.cwd);
    for (const item of plannedCli) await assertDestinationAvailable(profile.directory, item.session.id);
    let copied, skipped = [];
    try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Switching Claude to ${profile.name}`, cancellable: false }, () => switchEditorTab({
      tab,
      close: target => vscode.window.tabGroups.close(target, true),
      reopen: () => vscode.commands.executeCommand(REOPEN),
      prepare: async () => {
        for (const item of plannedCli) await cli.stop(item);
        // Allow Claude's asynchronous tab shutdown to flush its saved transcript.
        await new Promise(resolve => setTimeout(resolve, 1000));
        const saved = await listSessions(source, folders);
        copied = await transferWorkspace(source, profile.directory, saved);
        for (const item of plannedCli) {
          if (!copied.some(session => session.id === item.session.id)) await transferSession(source, profile.directory, item.session);
        }
        // The account setting applies to every VS Code window, so also carry
        // other projects' new or changed conversations, without prompting.
        const done = new Set([...copied.map(s => s.id), ...plannedCli.map(item => item.session.id)]);
        const others = (await pendingSessions(source, profile.directory)).filter(s => !done.has(s.id));
        ({ skipped } = await transferEach(source, profile.directory, others));
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
    await restartClaude(skipped.length ? `Switched to ${profile.name}, but ${skipped.length} conversation(s) from other projects were not copied: ${skipped.map(s => `"${s.session.title.slice(0, 40)}" (${s.reason})`).join('; ')}. Stop Claude in the other window and switch again to copy them.` : undefined);
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
      const sessions = await listSessions(source.directory, folders);
      if (!sessions.length) throw new Error('No saved conversations found for the open project in that profile. Check the source profile and project folder.');
      session = (await vscode.window.showQuickPick(sessions.map(s => ({ label: s.title, description: new Date(s.modified).toLocaleString(), detail: s.id, session: s })), { title: 'Select the conversation (newest first)' }))?.session;
      if (!session) return;
    }
    const accept = await vscode.window.showWarningMessage(session
      ? `Continue this conversation as ${profile.name}? Stop Claude work in BOTH profiles, including CLI/background sessions, before continuing. The selected source replaces the destination copy of this conversation; both versions are backed up. Conversation content will be sent using the destination account when you continue. Other windows share the panel setting.`
      : `Configure the chat panel for ${profile.name}? This updates the local user setting shared by VS Code windows. Finish active Claude work first. Existing sessions are not migrated.`, { modal: true }, session ? 'Stopped — Copy and Switch' : 'Switch Profile');
    if (!accept) return;
    if (session) session = await transferSession(source.directory, profile.directory, session);
    if (!context.globalState.get('original')) {
      await context.globalState.update('original', { directoryEntries: entries().filter(e => e.name === CONFIG) });
    }
    await config().update('environmentVariables', panelEntries(entries(), profile), vscode.ConfigurationTarget.Global);
    // After the restart, the copied conversation opens automatically.
    await context.workspaceState.update('pendingResume', session ? { profile, session, autoResume: true } : undefined);
    refresh();
    knownDirectory = currentDirectory();
    await restartClaude(session ? `Conversation copied to ${profile.name} with the same ID; backups are kept. To continue it in a terminal, run Resume Copied Conversation.` : `Claude now uses ${profile.name}. Existing CLI terminals keep their account until reopened.`);
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
    if (action === 'Show Backup') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(pending.session.backup, 'manifest.json')));
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
  let busy = false;
  for (const [command, run] of Object.entries({ create, switch: quickSwitch, switchCli: async () => switchCliTo(await choose()), advancedSwitch: switchProfile, resume: resumeCopied, terminal: async () => launch(await choose()), login: async () => launch(await choose(), true), restore })) {
    context.subscriptions.push(vscode.commands.registerCommand(`claudeProfiles.${command}`, async () => {
      if (vscode.env.remoteName) return vscode.window.showErrorMessage('This prototype supports local VS Code windows only.');
      if ((!vscode.workspace.isTrusted && command !== 'restore') || busy) return;
      busy = true;
      try { await run(); } catch (error) { await vscode.window.showErrorMessage(`Claude Profiles: ${error.message}`); } finally { busy = false; knownDirectory = currentDirectory(); }
    }));
  }
  context.subscriptions.push(bar, vscode.workspace.onDidChangeConfiguration(event => {
    refresh();
    if (event?.affectsConfiguration?.('claudeCode.environmentVariables')) followAccountChange().catch(error => vscode.window.showErrorMessage(`Claude Profiles: ${error.message}`));
  }), {
    dispose: () => context.environmentVariableCollection?.clear()
  });
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
