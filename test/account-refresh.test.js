const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RESTART, RELOAD, refreshAction, restartCommand } = require('../src/account-refresh');
test('account change restarts idle Claude, asks when it would interrupt work, skips when Claude is not running', () => {
  assert.equal(refreshAction({ claudeActive: false, debugging: false, busy: false }), 'none');
  assert.equal(refreshAction({ claudeActive: true, debugging: false, busy: false }), 'restart');
  assert.equal(refreshAction({ claudeActive: true, debugging: true, busy: false }), 'ask');
  assert.equal(refreshAction({ claudeActive: true, debugging: false, busy: true }), 'ask');
});
test('restart prefers the extension host and falls back to a window reload', () => {
  assert.equal(restartCommand([RESTART, RELOAD]), RESTART);
  assert.equal(restartCommand([RELOAD]), RELOAD);
});
