'use strict';
const REOPEN = 'claude-vscode.reopenClosedSession';
async function switchEditorTab({ tab, close, reopen, prepare, apply, rollback }) {
  if (!await close(tab)) throw new Error('Claude tab could not be closed. Account unchanged.');
  let applying = false;
  let reopening = false;
  try {
    await prepare();
    applying = true;
    await apply();
    reopening = true;
    await reopen();
  } catch (error) {
    if (applying) {
      try { await rollback(); }
      catch { throw new Error(`Switch failed and the previous setting could not be restored. Check the configured account before reopening Claude. ${error.message}`); }
    }
    // Reopening consumes Claude's closed-session entry. Do not invoke it twice on a
    // failed reopen, since a second call could open an unrelated older tab.
    if (!reopening) {
      try { await reopen(); } catch { /* Original history is still on disk. */ }
    }
    throw error;
  }
}
module.exports = { REOPEN, switchEditorTab };
