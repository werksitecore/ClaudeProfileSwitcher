const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('sidebar quick switch asks only for destination and reloads without choosing a chat', async () => {
  const commands = new Map(), executed = [], questions = [], copies = [];
  const target = { name: 'Work', directory: path.resolve('work-profile') };
  const source = path.resolve('personal-profile');
  let environment = [{ name: 'CLAUDE_CONFIG_DIR', value: source }];
  const state = values => ({ get: (key, fallback) => key in values ? values[key] : fallback, update: async (key, value) => { values[key] = value; } });
  const context = { subscriptions: [], globalState: state({ profiles: [target] }), workspaceState: state({}) };
  const sessions = [{ id: 'one', modified: 1 }, { id: 'two', modified: 2 }];
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ProgressLocation: { Notification: 1 }, ConfigurationTarget: { Global: 1 },
    env: {}, extensions: { getExtension: () => ({}) },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: process.cwd() } }], onDidChangeConfiguration: () => ({}), getConfiguration: () => ({ get: () => environment, update: async (key, value) => { environment = value; } }) },
    window: {
      // Deliberately no tabGroups: sidebar switching must not depend on editor tabs.
      createStatusBarItem: () => ({ show() {} }),
      showQuickPick: async items => { questions.push(items); return items.find(item => item.label === 'Work'); },
      showErrorMessage: message => { throw new Error(message); },
      showInformationMessage: () => { throw new Error('Unexpected question'); },
      withProgress: async (options, run) => run()
    },
    commands: { registerCommand: (id, run) => { commands.set(id, run); return {}; }, executeCommand: async id => { executed.push(id); } }
  };
  const module = { exports: {} };
  const code = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
  vm.runInNewContext(code, { module, process: { env: {} }, require: name => name === 'vscode' ? vscode : name === './profiles' ? require('../src/profiles') : name === './history' ? { listSessions: async () => sessions, transferWorkspace: async (from, to, items) => { copies.push({ from, to, items }); return items; } } : require(name) });
  await module.exports.activate(context);
  await commands.get('claudeProfiles.switch')();
  assert.equal(questions.length, 1);
  assert.equal(questions[0][0].label, 'Default');
  assert.match(questions[0][0].description, /Current/);
  assert.equal(copies[0].from, source);
  assert.equal(copies[0].to, target.directory);
  assert.equal(copies[0].items, sessions);
  assert.equal(environment.find(e => e.name === 'CLAUDE_CONFIG_DIR').value, target.directory);
  assert.deepEqual(executed, ['workbench.action.reloadWindow']);
  assert.equal(context.workspaceState.get('pendingResume'), undefined);
});
