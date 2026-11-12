const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncTerminalProfile, profileTerminalOptions } = require('../src/terminal-profile');

test('new ordinary terminals follow panel switches and Default removes the override', () => {
  const values = new Map();
  const collection = { replace: (key, value, options) => values.set(key, { value, options }), delete: key => values.delete(key) };
  for (const directory of ['work', 'personal', 'work']) {
    syncTerminalProfile(collection, directory);
    assert.equal(collection.persistent, false);
    assert.deepEqual(values.get('CLAUDE_CONFIG_DIR'), { value: directory, options: { applyAtProcessCreation: true, applyAtShellIntegration: false } });
  }
  syncTerminalProfile(collection, null);
  assert.equal(values.size, 0);
});

test('explicit CLI selection isolates environment from panel and authentication overrides', () => {
  const inherited = { Path: 'executable-path', SystemRoot: 'windows', claude_config_dir: 'work', anthropic_api_key: 'fixture', CLAUDE_CODE_OAUTH_TOKEN: 'fixture' };
  const options = profileTerminalOptions({ name: 'Personal', directory: 'personal' }, inherited, false, { id: 'same-session', cwd: 'project' });
  assert.equal(options.strictEnv, true);
  assert.deepEqual(options.env, { Path: 'executable-path', SystemRoot: 'windows', CLAUDE_CONFIG_DIR: 'personal' });
  assert.deepEqual(options.shellArgs, ['--resume', 'same-session']);
  assert.equal(options.cwd, 'project');
  assert.equal(inherited.claude_config_dir, 'work');
  const defaults = profileTerminalOptions({ name: 'Default', builtin: true, configValue: null }, inherited);
  assert.equal(defaults.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(defaults.env.claude_config_dir, undefined);
});
