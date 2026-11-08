'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { CONFIG, AUTH, restoreDirectory, conflicts, defaultProfile, panelEntries } = require('./profiles');
const { listSessions, transferSession, transferWorkspace } = require('./history');

async function activate(context) {
  const savedProfiles = () => context.globalState.get('profiles', []).filter(p => !p.builtin);
  const config = () => vscode.workspace.getConfiguration('claudeCode');
  const entries = () => config().get('environmentVariables', []);
  let defaults = context.globalState.get('defaultConfiguration');
  if (!defaults) {
    const original = context.globalState.get('original');
    const current = entries().filter(e => e.name === CONFIG);
    const managed = savedProfiles().some(p => p.directory === current[0]?.value);
    defaults = { directoryEntries: original?.directoryEntries ?? (managed ? [] : current), inheritedDirectory: process.env[CONFIG] || null };
    await context.globalState.update('defaultConfiguration', defaults);
  }
  const builtin = defaultProfile(defaults.directoryEntries, defaults.inheritedDirectory, os.homedir());
  const profiles = () => [builtin, ...savedProfiles()];
  const currentDirectory = () => entries().find(e => e.name === CONFIG)?.value || process.env[CONFIG] || path.join(os.homedir(), '.claude');
  const isCurrent = profile => path.resolve(profile.directory).toLowerCase() === path.resolve(currentDirectory()).toLowerCase();
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  bar.command = 'claudeProfiles.switch';
  function refresh() {
    const directory = currentDirectory();
    const selected = profiles().find(isCurrent);
    bar.text = `$(account) Claude: ${selected?.name || (directory ? 'External' : 'Default')}`;
    bar.tooltip = 'Configured panel profile; existing conversations and CLI processes may use an earlier profile. Click to switch.';
    bar.show();
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
    const env = { [CONFIG]: profile.builtin ? profile.configValue : profile.directory };
    for (const name of AUTH) env[name] = null;
    const terminal = vscode.window.createTerminal({ name: `Claude: ${profile.name}${login ? ' (login)' : ''}`, shellPath: 'claude', shellArgs: login ? ['auth', 'login'] : session ? ['--resume', session.id] : [], cwd: session?.cwd, env });
    terminal.show();
  }
  async function quickSwitch() {
    const claude = vscode.extensions.getExtension('anthropic.claude-code');
    if (!claude) throw new Error('Install the official Anthropic Claude Code extension first.');
    const source = entries().find(e => e.name === CONFIG)?.value || process.env[CONFIG] || path.join(os.homedir(), '.claude');
    const profile = (await vscode.window.showQuickPick(profiles().map(p => ({ label: p.name, description: `${isCurrent(p) ? 'Current · ' : ''}${p.builtin ? 'Existing Claude setup' : 'Keep this workspace’s chat history'}`, profile: p })), { title: 'Switch Claude account and continue chat' }))?.profile;
    if (!profile || isCurrent(profile)) return;
    const found = conflicts(entries(), process.env);
    if (found.length) throw new Error(`Conflicting authentication/provider variables: ${found.join(', ')}. Remove them before switching subscription accounts.`);
    const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    if (!folders.length) throw new Error('Open the conversation’s project folder before switching.');
    const sessions = await listSessions(source, folders);
    if (sessions.some(session => Date.now() - session.modified < 2000)) throw new Error('Claude is still saving workspace history. Stop the response, wait a moment, and switch again.');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Switching Claude to ${profile.name}`, cancellable: false }, async () => {
      const copied = await transferWorkspace(source, profile.directory, sessions);
      if (!context.globalState.get('original')) await context.globalState.update('original', { directoryEntries: entries().filter(e => e.name === CONFIG) });
      await config().update('environmentVariables', panelEntries(entries(), profile), vscode.ConfigurationTarget.Global);
      // Claude owns sidebar/tab selection and restores its existing session IDs after reload.
      // Never guess a current session from titles or open a different chat automatically.
      await context.workspaceState.update('pendingResume', undefined);
      await context.workspaceState.update('lastWorkspaceTransfer', { profile, sessions: copied });
      refresh();
    });
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
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
    await context.workspaceState.update('pendingResume', session ? { profile, session } : undefined);
    refresh();
    const action = await vscode.window.showInformationMessage(session ? `Conversation copied with the same ID. Original and destination backups are safe. Reload to resume in the panel, or resume in a new CLI terminal. Verify the destination account before sending.` : `Panel configured for ${profile.name}. Reload, start a new conversation, and verify the account in Claude. Existing CLI sessions are unchanged.`, 'Reload Window', session ? 'Resume in CLI' : 'Open CLI');
    if (action === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    if (action === 'Open CLI' || action === 'Resume in CLI') await launch(profile, false, session);
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
    const original = context.globalState.get('original');
    if (!original) return vscode.window.showInformationMessage('No original panel configuration has been saved.');
    await config().update('environmentVariables', restoreDirectory(entries(), original.directoryEntries), vscode.ConfigurationTarget.Global);
    await context.globalState.update('original', undefined);
    refresh();
    await vscode.window.showInformationMessage('Original panel directory configuration restored. Reload before starting a new Claude conversation. Profile files have been retained.');
  }
  let busy = false;
  for (const [command, run] of Object.entries({ create, switch: quickSwitch, advancedSwitch: switchProfile, resume: resumeCopied, terminal: async () => launch(await choose()), login: async () => launch(await choose(), true), restore })) {
    context.subscriptions.push(vscode.commands.registerCommand(`claudeProfiles.${command}`, async () => {
      if (vscode.env.remoteName) return vscode.window.showErrorMessage('This prototype supports local VS Code windows only.');
      if (!vscode.workspace.isTrusted || busy) return;
      busy = true;
      try { await run(); } catch (error) { await vscode.window.showErrorMessage(`Claude Profiles: ${error.message}`); } finally { busy = false; }
    }));
  }
  context.subscriptions.push(bar, vscode.workspace.onDidChangeConfiguration(refresh));
  refresh();
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
