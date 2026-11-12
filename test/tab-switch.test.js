const { test } = require('node:test');
const assert = require('node:assert/strict');
const { switchEditorTab } = require('../src/tab-switch');
function harness(failure) {
  const calls = [];
  const action = name => async () => { calls.push(name); if (failure === name) throw new Error(name); return true; };
  return { calls, options: Object.fromEntries(['close', 'prepare', 'apply', 'reopen', 'rollback'].map(name => [name, action(name)])) };
}
test('closes, snapshots, applies account, and reopens in order', async () => {
  const { calls, options } = harness();
  await switchEditorTab(options);
  assert.deepEqual(calls, ['close', 'prepare', 'apply', 'reopen']);
});
test('cancelled tab closure makes no changes', async () => {
  const { calls, options } = harness();
  options.close = async () => false;
  await assert.rejects(switchEditorTab(options), /unchanged/);
  assert.deepEqual(calls, []);
});
test('copy failure reopens original conversation without applying destination', async () => {
  const { calls, options } = harness('prepare');
  await assert.rejects(switchEditorTab(options), /prepare/);
  assert.deepEqual(calls, ['close', 'prepare', 'reopen']);
});
test('settings failure restores configuration and reopens original conversation', async () => {
  const { calls, options } = harness('apply');
  await assert.rejects(switchEditorTab(options), /apply/);
  assert.deepEqual(calls, ['close', 'prepare', 'apply', 'rollback', 'reopen']);
});
test('failed reopen rolls settings back without consuming another closed tab', async () => {
  const { calls, options } = harness('reopen');
  await assert.rejects(switchEditorTab(options), /reopen/);
  assert.deepEqual(calls, ['close', 'prepare', 'apply', 'reopen', 'rollback']);
});
