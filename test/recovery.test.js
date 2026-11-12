const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { recoveryConfiguration } = require('../src/recovery');
const home = path.resolve('synthetic-home');
const managed = path.join(home, '.claude-profile-switcher', 'profiles', 'work');
const entry = value => ({ name: 'CLAUDE_CONFIG_DIR', value });
test('lost registrations cannot turn a managed profile into Default', () => {
  assert.deepEqual(recoveryConfiguration({ entries: [entry(managed)], home, profiles: [] }).directoryEntries, []);
});
test('repairs a contaminated stored baseline', () => {
  assert.deepEqual(recoveryConfiguration({ defaults: { directoryEntries: [entry(managed)] }, entries: [], home, profiles: [] }).directoryEntries, []);
});
test('preserves original external custom setup', () => {
  const original = [entry(path.join(home, 'existing-custom'))];
  assert.deepEqual(recoveryConfiguration({ original: { directoryEntries: original }, entries: [entry(managed)], home, profiles: [] }).directoryEntries, original);
});
