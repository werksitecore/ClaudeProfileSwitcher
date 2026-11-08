const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withDirectory, restoreDirectory, conflicts } = require('../src/profiles');
const { defaultProfile, panelEntries } = require('../src/profiles');
const path = require('node:path');
test('built-in default preserves unset configuration for the original Claude login', () => {
  const profile = defaultProfile([], null, process.cwd());
  assert.equal(profile.name, 'Default');
  assert.equal(profile.directory, path.join(process.cwd(), '.claude'));
  assert.equal(profile.configValue, null);
  assert.deepEqual(panelEntries([{ name: 'CLAUDE_CONFIG_DIR', value: 'work' }, { name: 'OTHER', value: 'keep' }], profile), [{ name: 'OTHER', value: 'keep' }]);
});
test('default preserves an existing custom directory or inherited configuration', () => {
  const original = [{ name: 'CLAUDE_CONFIG_DIR', value: path.resolve('existing') }];
  const profile = defaultProfile(original, 'inherited', process.cwd());
  assert.equal(profile.configValue, original[0].value);
  assert.deepEqual(panelEntries([], profile), original);
  assert.equal(defaultProfile([], 'inherited', process.cwd()).configValue, 'inherited');
});
test('switch replaces duplicate directory settings and preserves unrelated values', () => {
  const initial = [{ name: 'OTHER', value: 'keep' }, { name: 'CLAUDE_CONFIG_DIR', value: 'old' }, { name: 'CLAUDE_CONFIG_DIR', value: 'duplicate' }];
  assert.deepEqual(withDirectory(initial, 'C:\\My Profiles\\work'), [initial[0], { name: 'CLAUDE_CONFIG_DIR', value: 'C:\\My Profiles\\work' }]);
  assert.equal(initial.length, 3);
});
test('restoration retains unrelated edits made after switching', () => {
  assert.deepEqual(restoreDirectory([{ name: 'NEW', value: 'edit' }, { name: 'CLAUDE_CONFIG_DIR', value: 'work' }], []), [{ name: 'NEW', value: 'edit' }]);
});
test('detects inherited and configured authentication overrides without exposing values', () => {
  assert.deepEqual(conflicts([{ name: 'ANTHROPIC_API_KEY', value: 'secret' }], { CLAUDE_CODE_USE_BEDROCK: '1' }), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']);
});
