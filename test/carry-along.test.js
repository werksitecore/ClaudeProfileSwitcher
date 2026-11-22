const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

// Conversations carried along without being chosen (Quick Switch's other
// projects, and following another window's switch), checked with the REAL
// assertDestinationAvailable against real files under .test-tmp:
// (a) open only in the source profile: carried as a copy, reported;
// (b) open in a third profile that shares the file: skipped, reported;
// (c) open nowhere: linked (carried normally).
const S_SOURCE = '11111111-1111-1111-1111-111111111111', S_THIRD = '22222222-2222-2222-2222-222222222222', S_FREE = '33333333-3333-3333-3333-333333333333';
const uuid = n => `${String(n).repeat(8)}-0000-0000-0000-000000000000`;
const line = id => JSON.stringify({ type: 'user', sessionId: id, cwd: process.cwd(), message: { role: 'user', content: 'hi' } }) + '\n';

async function setup(t) {
  await fsp.mkdir(path.join(__dirname, '..', '.test-tmp'), { recursive: true });
  const top = await fsp.mkdtemp(path.join(__dirname, '..', '.test-tmp', 'carry-'));
  t.after(() => fsp.rm(top, { recursive: true, force: true }));
  const store = path.join(top, 'switcher');
  const [source, destination, third] = [1, 2, 3].map(n => path.join(store, 'profiles', uuid(n)));
  for (const dir of [source, destination, third]) await fsp.mkdir(path.join(dir, 'projects', 'proj'), { recursive: true });
  for (const id of [S_SOURCE, S_THIRD, S_FREE]) await fsp.writeFile(path.join(source, 'projects', 'proj', `${id}.jsonl`), line(id));
  // The third profile shares S_THIRD's file (a hard link) and has it open.
  await fsp.link(path.join(source, 'projects', 'proj', `${S_THIRD}.jsonl`), path.join(third, 'projects', 'proj', `${S_THIRD}.jsonl`));
  for (const [dir, id] of [[source, S_SOURCE], [third, S_THIRD]]) {
    await fsp.mkdir(path.join(dir, 'sessions'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id }));
  }
  const sessions = [S_SOURCE, S_THIRD, S_FREE].map((id, i) => ({ id, project: 'proj', title: `chat ${i}`, modified: 1, cwd: process.cwd() }));
  return { store, source, destination, third, sessions };
}
// Loads extension.js with stubbed VS Code and history, and the real
// cli-continuation, linking and storage modules.
function load(f, { workspace, pending, linked = false }) {
  const commands = new Map(), carried = [], warnings = [], infos = [], executed = [];
  let environment = [{ name: 'CLAUDE_CONFIG_DIR', value: f.source }], onConfig;
  const state = values => ({ get: (key, fallback) => key in values ? values[key] : fallback, update: async (key, value) => { values[key] = value; } });
  const target = { id: uuid(2), name: 'Work', directory: f.destination };
  const context = { switcherRootOverride: f.store, environmentVariableCollection: { replace() {}, delete() {}, clear() {} }, subscriptions: [], globalState: state({ profiles: [target] }), workspaceState: state({}) };
  class TabInputWebview { constructor() { this.viewType = 'claudeVSCodePanel'; } }
  const tab = { input: new TabInputWebview() };
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ProgressLocation: { Notification: 1 }, ConfigurationTarget: { Global: 1 }, TabInputWebview,
    env: {}, extensions: { getExtension: () => ({ isActive: true, activate: async () => {} }) },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: process.cwd() } }], onDidChangeConfiguration: listener => { onConfig = listener; return {}; }, getConfiguration: () => ({ get: () => environment, update: async (key, value) => { environment = value; } }) },
    window: {
      tabGroups: { activeTabGroup: { activeTab: tab }, close: async () => true },
      createStatusBarItem: () => ({ show() {} }),
      showQuickPick: async items => items.find(item => item.label === 'Work'),
      showErrorMessage: message => { throw new Error(message); },
      showWarningMessage: async message => { warnings.push(message); },
      showInformationMessage: async message => { infos.push(message); },
      withProgress: async (options, run) => run()
    },
    commands: { getCommands: async () => ['claude-vscode.reopenClosedSession', 'workbench.action.restartExtensionHost'], registerCommand: (id, run) => { commands.set(id, run); return {}; }, executeCommand: async id => { executed.push(id); } }
  };
  const history = {
    listSessions: async () => workspace,
    pendingSessions: async () => pending,
    transferWorkspace: async (from, to, items) => linked ? items.map(s => ({ ...s, linked: [`projects/proj/${s.id}.jsonl`] })) : items,
    transferEach: async (from, to, items, options) => { carried.push({ ids: items.map(s => s.id), link: options.link === false ? 'copy' : 'link' }); return { copied: items.map(s => ({ ...s })), skipped: [] }; }
  };
  const local = name => name === 'vscode' ? vscode : name === './history' ? history : name === './profile-ui' ? { createProfileProvider: () => ({ refresh() {} }), openProfilePanel: () => {} } : require(name.startsWith('./') ? path.join(__dirname, '..', 'src', name) : name);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8'), { module, setTimeout: callback => callback(), process: { env: {} }, require: local });
  return { module, context, commands, carried, warnings, infos, executed, fire: () => onConfig({ affectsConfiguration: () => true }), setEnvironment: value => { environment = value; } };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('Quick Switch carries other projects: copies one open in the source, skips one open in a sharing profile, links the rest', async t => {
  const f = await setup(t);
  const h = load(f, { workspace: [{ id: 'workspace-chat', modified: 1 }], pending: f.sessions });
  await h.module.exports.activate(h.context);
  await h.commands.get('claudeProfiles.switch')();
  assert.deepEqual(plain(h.carried), [{ ids: [S_FREE], link: 'link' }, { ids: [S_SOURCE], link: 'copy' }]);
  const notice = h.context.workspaceState.get('pendingNotice');
  assert.match(notice, /Not carried: "chat 1" \(This conversation is open in another profile that shares it/);
  assert.match(notice, /Carried as a separate copy instead of shared: "chat 0": open in the source profile/);
  assert.ok(!notice.includes(S_FREE));
});

test('following another window carries this window\'s chats: open in the source is copied, open in a sharing profile is skipped, the rest is linked', async t => {
  const f = await setup(t);
  const h = load(f, { workspace: f.sessions, pending: f.sessions });
  await h.module.exports.activate(h.context);
  h.setEnvironment([{ name: 'CLAUDE_CONFIG_DIR', value: f.destination }]);
  h.fire();
  // followAccountChange runs in the background; it ends by restarting Claude.
  for (let i = 0; i < 500 && !h.executed.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(h.executed.length, 'followAccountChange did not finish');
  assert.deepEqual(plain(h.carried), [{ ids: [S_FREE], link: 'link' }, { ids: [S_SOURCE], link: 'copy' }]);
  assert.ok(h.warnings.some(w => /Not carried: "chat 1" \(This conversation is open in another profile that shares it/.test(w)));
  assert.ok(h.infos.some(m => m.includes('"chat 0": open in the source profile')));
});

test('with nothing open anywhere, every carried-along conversation is linked', async t => {
  const f = await setup(t);
  for (const dir of [f.source, f.third]) await fsp.rm(path.join(dir, 'sessions'), { recursive: true });
  const h = load(f, { workspace: [{ id: 'workspace-chat', modified: 1 }], pending: f.sessions });
  await h.module.exports.activate(h.context);
  await h.commands.get('claudeProfiles.switch')();
  assert.deepEqual(plain(h.carried), [{ ids: [S_SOURCE, S_THIRD, S_FREE], link: 'link' }]);
  assert.equal(h.context.workspaceState.get('pendingNotice'), undefined);
});

test('the rule "never continue one conversation in two profiles at once" is shown once, on the first switch that shares a conversation', async t => {
  const f = await setup(t);
  for (const dir of [f.source, f.third]) await fsp.rm(path.join(dir, 'sessions'), { recursive: true });
  const h = load(f, { workspace: [{ id: 'workspace-chat', title: 'Workspace chat', modified: 1 }], pending: [], linked: true });
  await h.module.exports.activate(h.context);
  await h.commands.get('claudeProfiles.switch')();
  assert.match(h.context.workspaceState.get('pendingNotice'), /Never continue one conversation in two profiles at once/);
  assert.equal(h.context.globalState.get('sharingRuleShown'), true);
  // The next switch that shares a conversation does not repeat it.
  await h.context.workspaceState.update('pendingNotice', undefined);
  h.setEnvironment([{ name: 'CLAUDE_CONFIG_DIR', value: f.source }]);
  await h.commands.get('claudeProfiles.switch')();
  assert.ok(!/Never continue one conversation/.test(h.context.workspaceState.get('pendingNotice') || ''));
});
