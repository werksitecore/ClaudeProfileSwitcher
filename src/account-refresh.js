'use strict';
// Claude Code reads CLAUDE_CONFIG_DIR only when it starts a chat process, and
// (verified in 2.1.325) does not restart running chats when the setting
// changes: it only refreshes its views. Running chats, the sidebar and the
// usage panel therefore stay on the previous account until restarted.
// Restarting the extension host stops every Claude process in the window;
// VS Code then revives each Claude tab on its same conversation, now started
// with the new setting. Editors and terminals are untouched.
const RESTART = 'workbench.action.restartExtensionHost';
const RELOAD = 'workbench.action.reloadWindow';
const BUSY_MS = 10000;

// What a window should do after the account setting changed.
// - none: Claude is not running here, nothing to refresh.
// - ask: restarting now would interrupt work (a reply or a debug session).
// - restart: safe to restart silently.
function refreshAction({ claudeActive, debugging, busy }) {
  if (!claudeActive) return 'none';
  return debugging || busy ? 'ask' : 'restart';
}
function restartCommand(available) {
  return available.includes(RESTART) ? RESTART : RELOAD;
}
module.exports = { RESTART, RELOAD, BUSY_MS, refreshAction, restartCommand };
