const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CliContinuation } = require('../src/cli-continuation');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readSession, assertDestinationAvailable, assertDestinationReady } = require('../src/cli-continuation');

function setup(overrides = {}) {
  const state = { pid: 123, id: 'exact-session', cwd: '/project' };
  const calls = [];
  const manager = new CliContinuation({ read: async () => state, list: async () => [{ id: 'newer-unrelated', modified: 0 }, { id: 'exact-session', modified: 0 }], alive: () => false, delay: async () => {}, ...overrides });
  const terminal = { dispose: () => calls.push('dispose') };
  manager.track(terminal, { directory: '/source' });
  return { manager, terminal, state, calls };
}
test('tracks and stops the exact managed session, never the newest transcript', async () => {
  const { manager, terminal, calls } = setup();
  const [item] = await manager.plan([...manager.records.values()]);
  assert.equal(item.session.id, 'exact-session');
  await manager.stop(item);
  assert.deepEqual(calls, ['dispose']);
  assert.equal(item.stopped, true);
  assert.equal(manager.records.has(terminal), false);
});
test('refuses an unsaved conversation without closing the CLI', async () => {
  const { manager, calls } = setup({ list: async () => [] });
  await assert.rejects(manager.plan([...manager.records.values()]), /no saved transcript/);
  assert.deepEqual(calls, []);
});
test('rechecks conversation identity before closing', async () => {
  const { manager, calls } = setup();
  const [item] = await manager.plan([...manager.records.values()]);
  manager.read = async () => ({ ...item.state, id: 'different' });
  await assert.rejects(manager.stop(item), /changed/);
  assert.deepEqual(calls, []);
});
test('duplicate managed conversations fail before any CLI closes', async () => {
  const { manager, calls } = setup();
  manager.track({ dispose: () => calls.push('second') }, { directory: '/source' });
  await assert.rejects(manager.plan([...manager.records.values()]), /more than one/);
  assert.deepEqual(calls, []);
});
test('does not mark a process stopped until its exit is verified', async () => {
  const { manager } = setup({ alive: () => true });
  const [item] = await manager.plan([...manager.records.values()]);
  await assert.rejects(manager.stop(item), /has not exited/);
  assert.equal(item.stopped, false);
});
test('busy or unverifiable state prevents any terminal closure', async () => {
  const { manager, calls } = setup({ read: async () => { throw new Error('busy'); } });
  await assert.rejects(manager.plan([...manager.records.values()]), /busy/);
  assert.deepEqual(calls, []);
});

test('native registry identity, idle state, and destination collisions are validated', async t => {
  await fs.mkdir('.test-tmp', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('.test-tmp/cli-registry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'sessions'));
  await assert.rejects(assertDestinationReady({ name: 'Test', directory }), /one-time setup/);
  await fs.writeFile(path.join(directory, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  await assertDestinationReady({ name: 'Test', directory });
  await assert.rejects(assertDestinationReady({ name: 'Test', directory }, process.cwd()), /folder-trust/);
  await fs.writeFile(path.join(directory, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { [process.cwd()]: { hasTrustDialogAccepted: true } } }));
  await assertDestinationReady({ name: 'Test', directory }, process.cwd());
  await assertDestinationReady({ name: 'Test', directory }, path.join(process.cwd(), 'nested'));
  await assert.rejects(assertDestinationReady({ name: 'Test', directory }, `${process.cwd()}-sibling`), /folder-trust/);
  const startedAt = Date.now(), pid = 12345;
  const state = { pid, sessionId: '12345678-1234-1234-1234-123456789abc', kind: 'interactive', status: 'idle', cwd: process.cwd(), startedAt };
  const record = { profile: { directory }, terminal: { processId: Promise.resolve(pid) }, startedAt };
  const write = value => fs.writeFile(path.join(directory, 'sessions', `${pid}.json`), JSON.stringify(value));
  await write(state);
  assert.equal((await readSession(record)).id, state.sessionId);
  await assert.rejects(assertDestinationAvailable(directory, state.sessionId, () => true), /already open/);
  await assertDestinationAvailable(directory, state.sessionId, () => false);
  for (const status of ['busy', 'waiting', 'shell', undefined]) {
    await write({ ...state, status });
    await assert.rejects(readSession(record), /busy or waiting/);
  }
  await write({ ...state, startedAt: startedAt - 10000 });
  await assert.rejects(readSession(record), /identity/);
  await write({ ...state, pid: 9876 });
  await assert.rejects(readSession(record), /identity/);
});

test('a pool destination is unavailable while any pool member has the conversation open', async t => {
  await fs.mkdir('.test-tmp', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('.test-tmp/cli-pool-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = path.join(root, 'switcher'), shared = path.join(store, 'shared');
  const [a, b, c] = ['a', 'b', 'c'].map(n => path.join(store, 'profiles', `${n.repeat(8)}-0000-0000-0000-000000000000`));
  for (const name of ['projects', 'file-history', 'image-cache']) await fs.mkdir(path.join(shared, name), { recursive: true });
  for (const profile of [a, b]) {
    await fs.mkdir(profile, { recursive: true });
    for (const name of ['projects', 'file-history', 'image-cache']) await fs.symlink(path.join(shared, name), path.join(profile, name), 'junction');
  }
  await fs.mkdir(path.join(c, 'sessions'), { recursive: true });
  const id = '12345678-1234-1234-1234-123456789abc';
  await fs.mkdir(path.join(b, 'sessions'));
  await fs.writeFile(path.join(b, 'sessions', '555.json'), JSON.stringify({ pid: 555, sessionId: id }));
  await fs.writeFile(path.join(c, 'sessions', '556.json'), JSON.stringify({ pid: 556, sessionId: id }));
  await assert.rejects(assertDestinationAvailable(a, id, () => true, { switcherRoot: store }), /already open/);
  // Without the pool, or for a profile outside it, only its own sessions count.
  await assertDestinationAvailable(a, id, () => true);
  await assertDestinationAvailable(a, id, () => false, { switcherRoot: store });
  await assert.rejects(assertDestinationAvailable(c, id, () => true, { switcherRoot: store }), /already open/);
  await fs.rm(path.join(c, 'sessions', '556.json'));
  await assertDestinationAvailable(c, id, () => true, { switcherRoot: store });
});
