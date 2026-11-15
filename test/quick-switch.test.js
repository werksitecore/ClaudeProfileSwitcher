const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('editor quick switch closes only Claude and reopens through its session command without reloading VS Code', async () => {
  const commands = new Map(), executed = [], questions = [], copies = [], carried = [];
  let requested = 'Work';
  const target = { name: 'Work', directory: path.resolve('work-profile') };
  const source = path.resolve('personal-profile');
  let environment = [{ name: 'CLAUDE_CONFIG_DIR', value: source }];
  const state = values => ({ get: (key, fallback) => key in values ? values[key] : fallback, update: async (key, value) => { values[key] = value; } });
  const terminalDirectories = [];
  const context = { environmentVariableCollection: { replace: (key, value) => terminalDirectories.push(value), delete: () => terminalDirectories.push(null), clear() {} }, subscriptions: [], globalState: state({ profiles: [target] }), workspaceState: state({}) };
  const sessions = [{ id: 'one', modified: 1 }, { id: 'two', modified: 2 }];
  class TabInputWebview { constructor() { this.viewType = 'claudeVSCodePanel'; } }
  const tab = { input: new TabInputWebview() };
  const closed = [];
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ProgressLocation: { Notification: 1 }, ConfigurationTarget: { Global: 1 },
    TabInputWebview,
    env: {}, extensions: { getExtension: () => ({ activate: async () => {} }) },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: process.cwd() } }], onDidChangeConfiguration: () => ({}), getConfiguration: () => ({ get: () => environment, update: async (key, value) => { environment = value; } }) },
    window: {
      tabGroups: { activeTabGroup: { activeTab: tab }, close: async target => { closed.push(target); return true; } },
      createStatusBarItem: () => ({ show() {} }),
      showQuickPick: async items => { questions.push(items); return items.find(item => item.label === requested); },
      showErrorMessage: message => { throw new Error(message); },
      showInformationMessage: () => { throw new Error('Unexpected question'); },
      withProgress: async (options, run) => run()
    },
    commands: { getCommands: async () => ['claude-vscode.reopenClosedSession', 'workbench.action.restartExtensionHost'], registerCommand: (id, run) => { commands.set(id, run); return {}; }, executeCommand: async id => { executed.push(id); } }
  };
  const module = { exports: {} };
  const code = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
  vm.runInNewContext(code, { module, setTimeout: callback => callback(), process: { env: {} }, require: name => name === 'vscode' ? vscode : name === './cli-continuation' ? require('../src/cli-continuation') : name === './terminal-profile' ? require('../src/terminal-profile') : name === './recovery' ? require('../src/recovery') : name === './account-refresh' ? require('../src/account-refresh') : name === './tab-switch' ? require('../src/tab-switch') : name === './profiles' ? require('../src/profiles') : name === './history' ? { listSessions: async () => sessions, transferWorkspace: async (from, to, items) => { copies.push({ from, to, items }); return items; }, pendingSessions: async () => [...sessions, { id: 'other-project', title: 'Other window chat', modified: 3 }], transferEach: async (from, to, items) => { carried.push({ from, to, ids: items.map(s => s.id) }); return { copied: items, skipped: [] }; } } : require(name) });
  await module.exports.activate(context);
  await commands.get('claudeProfiles.switch')();
  assert.equal(terminalDirectories.at(-1), target.directory);
  assert.equal(questions.length, 1);
  assert.equal(questions[0][0].label, 'Default');
  assert.match(questions[0][0].description, /Current/);
  assert.equal(copies[0].from, source);
  assert.equal(copies[0].to, target.directory);
  assert.equal(copies[0].items, sessions);
  // Other windows' projects follow the shared account setting, once each.
  assert.deepEqual(carried[0], { from: source, to: target.directory, ids: ['other-project'] });
  assert.equal(environment.find(e => e.name === 'CLAUDE_CONFIG_DIR').value, target.directory);
  assert.deepEqual(closed, [tab]);
  // Every chat in the window restarts on the new account, without reloading VS Code.
  assert.deepEqual(executed, ['claude-vscode.reopenClosedSession', 'workbench.action.restartExtensionHost']);
  assert.equal(context.workspaceState.get('pendingResume'), undefined);
  requested = 'Default';
  await commands.get('claudeProfiles.switch')();
  assert.equal(copies.length, 2);
  assert.equal(copies[1].from, target.directory);
  assert.equal(copies[1].to, source);
  assert.deepEqual(closed, [tab, tab]);
  assert.deepEqual(executed, ['claude-vscode.reopenClosedSession', 'workbench.action.restartExtensionHost', 'claude-vscode.reopenClosedSession', 'workbench.action.restartExtensionHost']);
  assert.equal(environment.find(e => e.name === 'CLAUDE_CONFIG_DIR').value, source);
  assert.equal(terminalDirectories.at(-1), source);
});
