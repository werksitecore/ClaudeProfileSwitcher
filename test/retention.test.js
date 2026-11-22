const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loads extension.js against stubbed VS Code, history, CLI and storage modules,
// and records every retention (gc) call.
// Background storage work runs only in Production (1) or Development (2) mode,
// and the harness always injects a root under .test-tmp unless a test says otherwise.
const TEST_ROOT = path.resolve('.test-tmp', 'retention-switcher-root');
const HOME_ROOT = path.join(require('node:os').homedir(), '.claude-profile-switcher');
function load({ requested, mode = 'Switch without copying history', info = async () => undefined, warn = async (message, options, ...actions) => actions[0], storage = {}, extensionMode = 1, root = TEST_ROOT, available = async () => {}, carried = [], linking = null }) {
  const commands = new Map(), gcCalls = [], captureCalls = [], roots = [], executed = [], warnings = [], notices = [], reports = [];
  const base = path.resolve('.test-tmp', 'retention-profiles');
  const work = { id: 'work', name: 'Work', directory: path.join(base, 'work') };
  const personal = { id: 'personal', name: 'Personal', directory: path.join(base, 'personal') };
  let environment = [{ name: 'CLAUDE_CONFIG_DIR', value: personal.directory }];
  let onConfig, gcSeen;
  const gcCalled = new Promise(resolve => { gcSeen = resolve; });
  const state = values => ({ get: (key, fallback) => key in values ? values[key] : fallback, update: async (key, value) => { values[key] = value; } });
  const context = { environmentVariableCollection: { replace() {}, delete() {}, clear() {} }, subscriptions: [], globalState: state({ profiles: [work, personal] }), workspaceState: state({}), extensionMode: extensionMode === null ? undefined : extensionMode, ...(root ? { switcherRootOverride: root } : {}) };
  const terminal = { processId: Promise.resolve(4321), show() {}, dispose() {} };
  const vscode = {
    ExtensionMode: { Production: 1, Development: 2, Test: 3 }, StatusBarAlignment: { Right: 1 }, ProgressLocation: { Notification: 1 }, ConfigurationTarget: { Global: 1 }, TabInputWebview: class {},
    env: {}, extensions: { getExtension: () => ({ isActive: true, activate: async () => {} }) },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: process.cwd() } }], onDidChangeConfiguration: listener => { onConfig = listener; return {}; },
      openTextDocument: async ({ content }) => { reports.push(content); return { content }; },
      getConfiguration: () => ({ get: (key, fallback) => key === 'environmentVariables' ? environment : fallback, update: async (key, value) => { environment = value; } }) },
    window: {
      tabGroups: { activeTabGroup: { activeTab: undefined } },
      createStatusBarItem: () => ({ show() {} }),
      createTerminal: () => terminal,
      activeTerminal: undefined,
      showQuickPick: async items => typeof items[0] === 'string' ? mode : items.find(item => item.label === requested()),
      showTextDocument: async () => {},
      showWarningMessage: async (message, options, ...actions) => { warnings.push({ message, modal: !!options?.modal }); return warn(message, options, ...actions); },
      showInformationMessage: async (message, ...actions) => { notices.push({ message, actions }); return info(message, actions); },
      showErrorMessage: message => { throw new Error(message); },
      withProgress: async (options, run) => run()
    },
    commands: { getCommands: async () => ['workbench.action.restartExtensionHost'], registerCommand: (id, run) => { commands.set(id, run); return {}; }, executeCommand: async id => { executed.push(id); } }
  };
  class CliContinuation {
    constructor() { this.records = new Map(); }
    track(t, profile) { this.records.set(t, { terminal: t, profile }); }
    forget(t) { this.records.delete(t); }
    async plan(records) { return records.map(record => ({ record, state: { pid: 4321 }, session: { id: 'cli-session', cwd: process.cwd() }, stopped: false })); }
    async stop(item) { item.stopped = true; }
  }
  const stubs = {
    vscode,
    './storage': { capture: async options => { captureCalls.push(options); roots.push(options.switcherRoot); return {}; }, ...storage, gc: async (...args) => { gcCalls.push(args); roots.push(args[0]); storage.onGc?.(args); gcSeen(); return { removedManifests: [], removedObjects: [], freed: 0, invalid: [] }; } },
    './history': { listSessions: async () => [{ id: 'one', modified: 0 }], pendingSessions: async () => [{ id: 'one' }], transferEach: async (a, b, items) => { carried.push(items.map(x => x.id)); return { copied: [], skipped: [] }; }, transferSession: async (a, b, s) => s, transferWorkspace: async (a, b, s) => s },
    './cli-continuation': { CliContinuation, assertDestinationAvailable: available, assertDestinationReady: async () => {} },
    './profile-ui': { createProfileProvider: () => ({ refresh() {} }), openProfilePanel: () => {} },
    ...(linking ? { './linking': linking } : {})
  };
  const local = name => stubs[name] || require(name.startsWith('./') ? path.join(__dirname, '..', 'src', name) : name);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8'), { module, setTimeout, AbortController, process: { env: {} }, require: local });
  return { captureCalls, roots, warnings, notices, reports, module, context, commands, gcCalls, gcCalled, executed, terminal, vscode, work, personal, setEnvironment: value => { environment = value; }, fire: () => onConfig({ affectsConfiguration: () => true }) };
}

test('Advanced Switch runs retention before restarting Claude', async () => {
  const h = load({ requested: () => 'Work' });
  await h.module.exports.activate(h.context);
  await h.commands.get('claudeProfiles.advancedSwitch')();
  assert.equal(h.gcCalls.length, 1);
  assert.equal(h.gcCalls[0][1].retentionDays, 30);
  assert.deepEqual(h.executed, ['workbench.action.restartExtensionHost']);
});

test('CLI switch runs retention after the new CLI starts', async () => {
  let pick = 'Personal';
  const h = load({ requested: () => pick });
  await h.module.exports.activate(h.context);
  await h.commands.get('claudeProfiles.terminal')();
  h.vscode.window.activeTerminal = h.terminal;
  pick = 'Work';
  await h.commands.get('claudeProfiles.switchCli')();
  assert.equal(h.gcCalls.length, 1);
});

test('following an account change from another window runs retention', async () => {
  const h = load({ requested: () => 'Work' });
  await h.module.exports.activate(h.context);
  h.setEnvironment([{ name: 'CLAUDE_CONFIG_DIR', value: h.work.directory }]);
  h.fire();
  await h.gcCalled;
  assert.equal(h.gcCalls.length, 1);
});

// Clean Redundant Backups: report, then a non-modal notification; only its
// button opens the confirmation modal, and nothing changes before that.
function cleanupStubs(calls) {
  return {
    formatBytes: n => `${n} B`,
    metricValue: (metrics, key) => `${metrics[key]} B`,
    renderCleanupPlan: () => '# Clean Redundant Backups (preview)',
    cleanup: async options => { calls.push(options); return options.dryRun ? { dryRun: true, delete: [{ path: 'x', size: 1, reason: 'kept elsewhere' }], move: [], skipped: [], bytes: 1 } : { deleted: 1, freed: 1, moved: 0, manifest: null, skipped: [] }; },
    measure: async () => ({ total: 0, shared: 0, profile: 0, backup: 0, duplicate: 0, reclaimable: 0 }),
    readStoreLock: async () => null, readJournal: async () => null, readRecovery: async () => null, migrationMarker: async () => null,
    METRICS: [{ key: 'total', label: 'Total', description: 'All' }]
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function openClean(h) {
  await h.module.exports.activate(h.context);
  h.vscode.window.showQuickPick = async items => items.find(item => /Clean Redundant Backups/.test(item.label));
  await h.commands.get('claudeProfiles.storage')();
  for (let i = 0; i < 5; i++) await settle();
}
test('cleanup waits for the notification button before showing the modal', async () => {
  const calls = [];
  const h = load({ requested: () => 'Work', info: async () => undefined, storage: cleanupStubs(calls) });
  await openClean(h);
  assert.ok(h.reports[0].startsWith('# Clean Redundant Backups (preview)'));
  // The retention and batching notes are in the preview report, not the modal.
  assert.match(h.reports[0], /backupRetentionDays \(30 days\) also expire/);
  assert.match(h.reports[0], /short batches, one snapshot at a time/);
  assert.deepEqual(h.notices.map(n => n.actions), [['Clean Redundant Backups…']]);
  assert.match(h.notices[0].message, /^Read the cleanup preview, then choose Clean Redundant Backups/);
  assert.match(h.notices[0].message, /If the notification has closed, open Manage Storage again or run Notifications: Show Notifications\.$/);
  // Dismissed: no modal, only the read-only dry run.
  assert.deepEqual(h.warnings, []);
  assert.deepEqual(calls.map(c => !!c.dryRun), [true]);
});
test('choosing the notification button opens the modal, and only confirming deletes', async () => {
  const calls = [];
  let confirm = undefined;
  const h = load({ requested: () => 'Work', info: async (message, actions) => actions[0], warn: async () => confirm, storage: cleanupStubs(calls) });
  await openClean(h);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.warnings[0].modal, true);
  assert.match(h.warnings[0].message, /moved into the archive \(.*archive\)/);
  assert.ok(!/recovery store/.test(h.warnings[0].message));
  assert.ok(!/backupRetentionDays|short batches/.test(h.warnings[0].message));
  assert.deepEqual(calls.map(c => !!c.dryRun), [true]);
  confirm = 'Delete Redundant Backups';
  await h.commands.get('claudeProfiles.storage')();
  for (let i = 0; i < 5; i++) await settle();
  assert.deepEqual(calls.map(c => !!c.dryRun), [true, true, false]);
});
test('Manage Storage rows have meanings, a placeholder, and metrics open the analysis', async () => {
  const h = load({ requested: () => 'Work', storage: { ...cleanupStubs([]), analyze: async () => ({}), renderReport: () => '# Storage analysis' } });
  await h.module.exports.activate(h.context);
  let shown;
  h.vscode.window.showQuickPick = async (items, options) => { shown = { items, options }; return items.find(item => item.label.startsWith('Total:')); };
  await h.commands.get('claudeProfiles.storage')();
  assert.equal(shown.options.placeHolder, 'Choose a storage action');
  assert.equal(shown.items.find(item => item.label.startsWith('Total:')).description, 'All');
  assert.deepEqual(h.reports, ['# Storage analysis']);
});
test('cancelling an analysis stops it, reports that nothing changed, and opens no report', async () => {
  let seen;
  const analyze = async ({ signal, onProgress }) => {
    onProgress({ done: 0, total: 4 });
    await new Promise(resolve => setImmediate(resolve));
    seen = signal.aborted;
    if (signal.aborted) throw Object.assign(new Error('Analysis cancelled. Nothing was changed.'), { cancelled: true });
    return {};
  };
  const h = load({ requested: () => 'Work', storage: { ...cleanupStubs([]), analyze, renderReport: () => '# Storage analysis' } });
  await h.module.exports.activate(h.context);
  const reports = [];
  h.vscode.window.withProgress = async (options, run) => {
    if (!/^Analyzing/.test(options.title)) return run();
    assert.equal(options.cancellable, true);
    let cancel;
    const pending = run({ report: value => reports.push(value) }, { onCancellationRequested: listener => { cancel = listener; } });
    cancel();
    return pending;
  };
  h.vscode.window.showQuickPick = async items => items.find(item => /Analyze Storage/.test(item.label));
  await h.commands.get('claudeProfiles.storage')();
  assert.equal(seen, true);
  assert.equal(reports[0].message, '0 of 4 files checked');
  assert.deepEqual(h.reports, []);
  assert.ok(h.notices.some(n => n.message === 'Analysis cancelled. Nothing was changed.'));
});


// One gate for every background storage operation: with no extension mode, or
// in Test mode, neither retention (gc) nor capture ever runs, whatever the
// root, and the default home root is never passed to storage.
for (const [label, extensionMode, root] of [['no mode, no injected root', null, null], ['Test mode, no injected root', 3, null], ['no mode, injected root', null, TEST_ROOT], ['Test mode, injected root', 3, TEST_ROOT]]) {
  test('no background storage work with ' + label, async () => {
    let pick = 'Work';
    const h = load({ requested: () => pick, extensionMode, root });
    await h.module.exports.activate(h.context);
    await h.commands.get('claudeProfiles.advancedSwitch')();
    await h.commands.get('claudeProfiles.terminal')();
    h.vscode.window.activeTerminal = h.terminal;
    pick = 'Personal';
    await h.commands.get('claudeProfiles.switchCli')();
    h.setEnvironment([{ name: 'CLAUDE_CONFIG_DIR', value: h.work.directory }]);
    h.fire();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual([h.gcCalls.length, h.captureCalls.length], [0, 0]);
    assert.ok(!h.roots.some(r => path.resolve(r).toLowerCase() === HOME_ROOT.toLowerCase()));
    for (const s of h.context.subscriptions) s?.dispose?.();
  });
}
test('in Production mode retention and capture run against the injected root only', async () => {
  let done;
  const captured = new Promise(resolve => { done = resolve; });
  const h = load({ requested: () => 'Work', storage: { capture: async options => { done(options); return {}; } } });
  await h.module.exports.activate(h.context);
  await h.commands.get('claudeProfiles.advancedSwitch')();
  const options = await Promise.race([captured, new Promise(resolve => setTimeout(() => resolve(null), 2000))]);
  assert.equal(h.gcCalls.length, 1);
  assert.equal(h.gcCalls[0][0], TEST_ROOT);
  assert.equal(options?.switcherRoot, TEST_ROOT);
  for (const s of h.context.subscriptions) s?.dispose?.();
});
test('a relative root override is ignored, and the gate still holds outside a real host', async () => {
  const h = load({ requested: () => 'Work', extensionMode: null, root: 'relative/root' });
  await h.module.exports.activate(h.context);
  await h.commands.get('claudeProfiles.advancedSwitch')();
  assert.equal(h.gcCalls.length, 0);
  for (const s of h.context.subscriptions) s?.dispose?.();
});

// P1 for conversations carried along: one open in a profile that shares it
// is skipped and reported, not carried.
test('following another window skips a conversation that is open in a profile sharing it, and reports it', async () => {
  const carried = [];
  const h = load({ requested: () => 'Work', carried, available: async () => { throw new Error('This conversation is open in another profile that shares it.'); } });
  await h.module.exports.activate(h.context);
  h.setEnvironment([{ name: 'CLAUDE_CONFIG_DIR', value: h.work.directory }]);
  h.fire();
  await h.gcCalled;
  assert.equal(JSON.stringify(carried), '[[]]');
  assert.ok(h.warnings.some(w => /Not carried/.test(w.message) && /open in another profile that shares it/.test(w.message)));
  for (const s of h.context.subscriptions) s?.dispose?.();
});

// ---- Architect's final validation -----------------------------------------------

// Records every storage and linking call Optimize Storage makes, in order.
function optimizeStubs(calls, { verifyOk = true, missing = 0, legacy = [{ sha256: 'a'.repeat(64), size: 1 }], claudeRunning = false, notCapturedOnce = false, captures = [{ complete: false, versions: 1 }, { complete: true, versions: 2 }] } = {}) {
  let capture = 0, refusedOnce = false;
  const record = (name, value) => async (...args) => { calls.push({ name, args }); return typeof value === 'function' ? value(...args) : value; };
  const storage = {
    ...cleanupStubs([]),
    renderVerify: () => '# Storage integrity', renderReconcile: () => '## Diverged versions', renderCleanupPlan: () => '# Clean Redundant Backups (preview)',
    localTime: value => new Date(value).toLocaleString(),
    reconcileDiverged: record('reconcileDiverged', options => options.expect ? { groups: [], versions: missing, confirmed: 0, missing } : { groups: [], versions: 0, unkept: 0 }),
    legacyObjects: record('legacyObjects', legacy),
    assertClaudeStopped: async () => { if (claudeRunning) throw new Error('Stop Claude first: close the Claude chat panels in all VS Code windows and exit claude in every terminal, then try again. Still running: claude.exe PID 9. Nothing was changed.'); },
    importObjects: record('importObjects', { imported: 1, deleted: 1, damaged: [] }),
    captureStatus: record('captureStatus', { current: false, pending: ['x'], completed: null }),
    capture: async options => { calls.push({ name: 'capture', args: [options] }); return captures[Math.min(capture++, captures.length - 1)]; },
    verify: record('verify', { ok: verifyOk, problems: verifyOk ? [] : ['broken'], notes: [] }),
    cleanup: record('cleanup', options => {
      if (notCapturedOnce && !refusedOnce) { refusedOnce = true; throw Object.assign(new Error('Clean Redundant Backups needs a complete archive capture of your current history first (no complete capture has run yet). Choose Capture Now, or run Optimize Storage. The background capture runs every 30 minutes, and it can complete only while Claude is stopped or idle in every window. Nothing was deleted.'), { code: 'ENOTCAPTURED' }); }
      return options.dryRun ? { dryRun: true, delete: [{ path: 'x', size: 1 }], move: [], skipped: [], bytes: 1, net: 1, movedBytes: 0 } : { deleted: 1, freed: 1, deletedBytes: 1, moved: 0, movedBytes: 0, cancelled: false, skipped: [] };
    }),
    onGc: args => calls.push({ name: 'gc', args })
  };
  const linking = {
    readLinkJournal: async () => null,
    renderLinkPlan: () => '# Link identical conversations (preview)',
    linkIdentical: record('linkIdentical', options => options.dryRun ? { groups: [{}], saved: 10 } : { linked: 1, saved: 10, groups: 1 })
  };
  return { storage, linking };
}
async function openStorageAction(h, label) {
  await h.module.exports.activate(h.context);
  let shown;
  h.vscode.window.showQuickPick = async items => { shown = items; h.menuShown = true; return label ? items.find(item => item.label?.includes(label)) : undefined; };
  await h.commands.get('claudeProfiles.storage')();
  return shown;
}
// The Manage Storage menu itself reads the old store (legacyObjects) before
// it is shown; only calls made after the choice belong to the action.
const afterMenu = calls => calls.slice(calls.findIndex(c => c.name === 'legacyObjects') + 1);
test('B1: Manage Storage never offers the shared-folder migration', async () => {
  const { storage, linking } = optimizeStubs([]);
  const h = load({ requested: () => 'Work', storage, linking });
  const shown = await openStorageAction(h, null);
  const labels = shown.map(item => item.label);
  assert.ok(!labels.some(l => /Preview Migration|Migrate/.test(l)), labels.join(' | '));
  assert.ok(labels.some(l => /Optimize Storage/.test(l)));
  assert.ok(labels.some(l => /Verify Storage Integrity/.test(l)));
  // Nothing uses shared storage here: its size row and Roll Back are hidden.
  assert.ok(!labels.some(l => /Roll Back Shared Storage|^Shared storage/.test(l)));
  // With a profile still in shared storage, both appear.
  const { storage: pooled, linking: l2 } = optimizeStubs([]);
  pooled.poolMembers = async () => ['some-profile'];
  pooled.METRICS = [{ key: 'total', label: 'Total', description: 'All' }, { key: 'shared', label: 'Shared storage', description: 'Shared' }];
  const p = load({ requested: () => 'Work', storage: pooled, linking: l2 });
  const pooledLabels = (await openStorageAction(p, null)).map(item => item.label);
  assert.ok(pooledLabels.some(l => /Roll Back Shared Storage/.test(l)));
  assert.ok(pooledLabels.some(l => /^Shared storage/.test(l)));
});
test('Optimize Storage runs the steps in the architect\'s order, confirming each one', async () => {
  const calls = [];
  const { storage, linking } = optimizeStubs(calls);
  const h = load({ requested: () => 'Work', storage, linking, info: async (message, actions) => actions[0] });
  await openStorageAction(h, 'Optimize Storage');
  const order = afterMenu(calls).map(c => c.name === 'linkIdentical' || c.name === 'cleanup' ? `${c.name}:${c.args[0].dryRun ? 'preview' : 'run'}` : c.name === 'reconcileDiverged' ? `${c.name}:${c.args[0].expect ? 'confirm' : 'list'}` : c.name);
  assert.deepEqual(order, ['reconcileDiverged:list', 'legacyObjects', 'importObjects', 'captureStatus', 'capture', 'capture', 'verify', 'linkIdentical:preview', 'linkIdentical:run', 'cleanup:preview', 'cleanup:run', 'verify', 'reconcileDiverged:confirm', 'gc']);
  // Verify runs with full rebuilds, cleanup always requires a complete capture, and compaction follows.
  assert.ok(calls.filter(c => c.name === 'verify').every(c => c.args[0].full === true));
  assert.ok(calls.filter(c => c.name === 'cleanup').every(c => c.args[0].requireCapture === true));
  assert.equal(h.gcCalls.length, 1);
  assert.equal(h.gcCalls[0][1].compact, true);
  // Every step was confirmed through a modal.
  assert.equal(h.warnings.filter(w => w.modal).length, 5);
  assert.ok(h.reports.some(r => r.startsWith('# Optimize Storage (preview)')));
  assert.ok(h.reports.at(-1).startsWith('# Optimize Storage'));
});
test('Optimize Storage stops at the first failure and when a step is not confirmed', async () => {
  const calls = [];
  const { storage, linking } = optimizeStubs(calls, { verifyOk: false });
  const h = load({ requested: () => 'Work', storage, linking, info: async (message, actions) => actions[0] });
  await openStorageAction(h, 'Optimize Storage');
  assert.ok(!calls.some(c => c.name === 'linkIdentical' || c.name === 'cleanup'));
  assert.match(h.reports.at(-1), /Stopped:\*\* Verify Storage Integrity found problems/);
  // Declining the first step's notification changes nothing.
  const declined = [];
  const stubs = optimizeStubs(declined);
  const d = load({ requested: () => 'Work', storage: stubs.storage, linking: stubs.linking, info: async () => undefined });
  await openStorageAction(d, 'Optimize Storage');
  assert.deepEqual(afterMenu(declined).map(c => c.name), ['reconcileDiverged', 'legacyObjects']);
  assert.match(d.reports.at(-1), /Stopped:\*\* not confirmed at step 1/);
});
test('Optimize Storage confirms every diverged version before compaction, and stops without compacting if one is missing', async () => {
  const calls = [];
  const { storage, linking } = optimizeStubs(calls, { missing: 1 });
  const h = load({ requested: () => 'Work', storage, linking, info: async (message, actions) => actions[0] });
  await openStorageAction(h, 'Optimize Storage');
  assert.equal(calls.at(-1).name, 'reconcileDiverged');
  assert.equal(h.gcCalls.length, 0);
  assert.match(h.reports.at(-1), /Stopped:\*\* 1 diverged version does not rebuild from the archive; garbage collection and compaction were not run/);
});
test('Clean Redundant Backups always asks the library for a complete capture first', async () => {
  const calls = [];
  const { storage, linking } = optimizeStubs(calls);
  const h = load({ requested: () => 'Work', storage, linking, info: async (message, actions) => actions[0] });
  await openStorageAction(h, 'Clean Redundant Backups');
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  const cleanups = calls.filter(c => c.name === 'cleanup');
  assert.deepEqual(cleanups.map(c => [!!c.args[0].dryRun, c.args[0].requireCapture]), [[true, true], [false, true]]);
});

// ---- Designer review ---------------------------------------------------------------

test('Optimize Storage refuses at the start while Claude runs, and the Stopped report says what still works', async () => {
  const calls = [];
  const { storage, linking } = optimizeStubs(calls, { claudeRunning: true });
  const h = load({ requested: () => 'Work', storage, linking, info: async (message, actions) => actions[0] });
  await assert.rejects(openStorageAction(h, 'Optimize Storage'), /Stop Claude first/);
  assert.deepEqual(afterMenu(calls), []);
  assert.match(h.reports.at(-1), /Stopped:\*\* Stop Claude first/);
  assert.match(h.reports.at(-1), /Completed steps stay done/);
  assert.match(h.reports.at(-1), /Clean Redundant Backups can also run on its own/);
});
test('Optimize Storage: every step notice has the notification hint, step 1 has no modal without old files, and linking can be skipped', async () => {
  const calls = [];
  const { storage, linking } = optimizeStubs(calls, { legacy: [] });
  const h = load({ requested: () => 'Work', storage, linking, info: async (message, actions) => actions[0], warn: async (message, options, ...actions) => actions.includes('Skip Linking') ? 'Skip Linking' : actions[0] });
  await openStorageAction(h, 'Optimize Storage');
  const order = afterMenu(calls).map(c => c.name === 'linkIdentical' || c.name === 'cleanup' ? `${c.name}:${c.args[0].dryRun ? 'preview' : 'run'}` : c.name);
  assert.ok(!order.includes('importObjects'));
  assert.ok(order.includes('linkIdentical:preview') && !order.includes('linkIdentical:run'));
  assert.ok(order.includes('cleanup:run'));
  // Steps 2, 4, 5 and 6 asked; step 1 had nothing to move.
  assert.equal(h.warnings.filter(w => w.modal).length, 4);
  const stepNotices = h.notices.filter(n => /^Step \d of 6/.test(n.message));
  assert.equal(stepNotices.length, 4);
  assert.ok(stepNotices.every(n => /If the notification has closed, open Manage Storage again or run Notifications: Show Notifications\.$/.test(n.message)));
  assert.match(h.reports.at(-1), /Step 4: linking skipped/);
});
test('while Optimize waits for a notification, other commands say what is running instead of doing nothing', async () => {
  const calls = [];
  const { storage, linking } = optimizeStubs(calls);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = load({ requested: () => 'Work', storage, linking, info: async (message, actions) => /^Step 1 of 6/.test(message) ? waiting.then(() => undefined) : actions?.[0] });
  await h.module.exports.activate(h.context);
  h.vscode.window.showQuickPick = async items => items.find(item => item.label?.includes('Optimize Storage'));
  const running = h.commands.get('claudeProfiles.storage')();
  for (let i = 0; i < 20 && !h.notices.some(n => /^Step 1 of 6/.test(n.message)); i++) await new Promise(resolve => setImmediate(resolve));
  await h.commands.get('claudeProfiles.switch')();
  assert.ok(h.notices.some(n => n.message === 'Another Claude Profiles action is still running or waiting for you (Optimize Storage, step 1 of 6). Open Notifications: Show Notifications to continue or close it.'));
  release();
  await running;
});
test('Clean Redundant Backups offers Capture Now when the capture is not complete, then continues', async () => {
  const calls = [];
  const { storage, linking } = optimizeStubs(calls, { notCapturedOnce: true, captures: [{ complete: true, versions: 1 }] });
  const h = load({ requested: () => 'Work', storage, linking, info: async (message, actions) => actions[0] });
  await openStorageAction(h, 'Clean Redundant Backups');
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  const order = afterMenu(calls).map(c => c.name === 'cleanup' ? `cleanup:${c.args[0].dryRun ? 'preview' : 'run'}` : c.name);
  assert.deepEqual(order, ['cleanup:preview', 'capture', 'cleanup:preview', 'cleanup:run', 'gc']);
  const refusal = h.warnings.find(w => /Capture Now/.test(w.message));
  assert.match(refusal.message, /every 30 minutes/);
  assert.match(refusal.message, /Claude is stopped or idle/);
  assert.ok(!/file\(s\)/.test(refusal.message));
});

test('Restore or Export shows title, project and date, a short version id, and Discard reports what still keeps the version', async () => {
  const calls = [];
  const { storage, linking } = optimizeStubs(calls);
  const id = 'abcdef12-0000-0000-0000-000000000000';
  storage.archivedVersions = async () => [{ key: `projects/myproj/${id}.jsonl`, versions: [{ key: `projects/myproj/${id}.jsonl`, sha256: 'c'.repeat(64), size: 10, time: new Date().toISOString(), captured: true, superseded: false, manifests: [] }] }];
  storage.discardVersions = async (...args) => { calls.push({ name: 'discardVersions', args }); return {}; };
  storage.discardOutcome = async () => ({ inArchive: false, inNewer: false, keptBy: [{ label: 'Cleanup backup, 20/11/2026', pinned: true }, { label: 'Switch backup, 19/11/2026', pinned: false }], presentIn: ['Work'] });
  const h = load({ requested: () => 'Work', storage, linking });
  await h.module.exports.activate(h.context);
  const shown = [];
  let round = 0;
  h.vscode.window.showQuickPick = async (items, options) => {
    shown.push({ items, options });
    if (round++ === 0) return items.find(item => /Restore or Export/.test(item.label));
    if (round === 2) return items[0];
    if (round === 3) return items[0];
    return 'Discard This Version…';
  };
  await h.commands.get('claudeProfiles.storage')();
  const fileItem = shown[1].items[0], versionItem = shown[2].items[0];
  assert.equal(fileItem.label, `Conversation ${id.slice(0, 8)}`);
  assert.match(fileItem.description, /^project myproj · .+ · 1 version$/);
  assert.equal(versionItem.detail, 'version cccccccccccc');
  const displayed = shown.slice(1).flatMap(s => s.items.map(item => typeof item === 'string' ? item : [item.label, item.description, item.detail].join(' ')));
  assert.ok(!displayed.join(' ').includes('c'.repeat(13)));
  // The modal gives the full procedure; the result states the real outcome.
  const modal = h.warnings.find(w => w.modal && /Discard this captured version/.test(w.message));
  assert.match(modal.message, /delete it from every profile first/);
  assert.match(modal.message, /discard any pinned backup that still holds it with Discard Pinned Backups/);
  assert.match(modal.message, /This cannot be undone\.$/);
  const outcome = h.notices.at(-1).message;
  assert.match(outcome, /still kept by Cleanup backup, 20\/11\/2026; discard it with Discard Pinned Backups/);
  // An unpinned backup is not discarded by hand: it expires.
  assert.match(outcome, /still kept by Switch backup, 19\/11\/2026, which expires after backupRetentionDays \(30 days\)/);
  assert.match(outcome, /still present in Work; it will be archived again unless you delete it there/);
  assert.ok(!/No copy of it remains/.test(outcome));
});
test('a version kept only by a backup has no Discard option, and the picker says why', async () => {
  const { storage, linking } = optimizeStubs([]);
  storage.archivedVersions = async () => [{ key: 'projects/p/x.jsonl', versions: [{ key: 'projects/p/x.jsonl', sha256: 'd'.repeat(64), size: 1, time: new Date().toISOString(), captured: false, superseded: false, manifests: ['m'] }] }];
  const h = load({ requested: () => 'Work', storage, linking });
  await h.module.exports.activate(h.context);
  let round = 0, actions;
  h.vscode.window.showQuickPick = async (items, options) => {
    if (round++ === 0) return items.find(item => /Restore or Export/.test(item.label));
    if (round <= 3) return items[0];
    actions = { items, options };
    return undefined;
  };
  await h.commands.get('claudeProfiles.storage')();
  assert.deepEqual([...actions.items], ['Export to File…', 'Restore into a Profile…']);
  assert.match(actions.options.placeHolder, /kept by a backup, so it has no Discard option here: remove it with Discard Pinned Backups/);
});

test('Discard says when the content is still inside a newer archived version, and Restore names the conversation', async () => {
  const { storage, linking } = optimizeStubs([]);
  const id = 'abcdef12-0000-0000-0000-000000000000';
  storage.archivedVersions = async () => [{ key: `projects/myproj/${id}.jsonl`, versions: [{ key: `projects/myproj/${id}.jsonl`, sha256: 'e'.repeat(64), size: 10, time: new Date().toISOString(), captured: true, superseded: true, manifests: [] }] }];
  storage.discardVersions = async () => ({});
  storage.discardOutcome = async () => ({ inArchive: false, inNewer: true, keptBy: [], presentIn: [] });
  const pick = action => async (items) => {
    if (items.some(item => /Restore or Export/.test(item.label || ''))) return items.find(item => /Restore or Export/.test(item.label));
    if (typeof items[0] === 'string') return action;
    return items[0];
  };
  const h = load({ requested: () => 'Work', storage, linking });
  await h.module.exports.activate(h.context);
  h.vscode.window.showQuickPick = pick('Discard This Version…');
  await h.commands.get('claudeProfiles.storage')();
  const outcome = h.notices.at(-1).message;
  assert.match(outcome, /Its content is still part of a newer archived version of this conversation; discard that version too\./);
  assert.ok(!/No copy of it remains/.test(outcome));
  // Restore: the modal names the conversation, not the stored path.
  h.vscode.window.showQuickPick = async (items) => {
    if (items.some(item => /Restore or Export/.test(item.label || ''))) return items.find(item => /Restore or Export/.test(item.label));
    if (typeof items[0] === 'string') return 'Restore into a Profile…';
    if (items[0]?.profile) return undefined;
    return items[0];
  };
  h.warnings.length = 0;
  let restoreModal;
  h.vscode.window.showWarningMessage = async (message, options) => { if (options?.modal) restoreModal = message; return undefined; };
  h.vscode.window.showQuickPick = (orig => async (items, options) => (items[0]?.profile ? items[0] : orig(items, options)))(h.vscode.window.showQuickPick);
  await h.commands.get('claudeProfiles.storage')();
  assert.match(restoreModal, new RegExp(`^Restore "Conversation ${id.slice(0, 8)}" into `));
  assert.ok(!restoreModal.includes('projects/myproj'));
});
test('the transfer recovery texts speak of switching, not shared storage', async () => {
  const storage = require('../src/storage');
  const report = storage.renderRecovery([{ id: 'x', destination: 'D', error: 'e' }]);
  assert.match(report, /Switching and carrying conversations between the affected profiles are blocked/);
  assert.ok(!/shared storage/.test(report));
});
