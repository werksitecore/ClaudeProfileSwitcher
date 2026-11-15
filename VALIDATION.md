# Prototype validation — 2026-11-08

## 0.0.7 controlled installation

User-reported PASS on 2026-11-08: isolated Default → Test B → Default preserved the conversation, used the expected accounts, and kept other tabs open. Observer: user; not independently verified by Codex. User authorized backing up normal VS Code settings and installing the same tested source for normal-window testing. Only version/packaging/documentation changes were made for this build. Marketplace publishing remains on hold.

**Release hold:** a user reported disappearing history and failed Default recovery with 0.0.6. The investigation reproduced a recovery failure in a real isolated VS Code host; patched recovery passed that scenario and restart persistence. This does not validate live Claude switching. See [incident evidence](docs/HISTORY_INCIDENT.md). No replacement installer was built.

Observer: Codex. Version: 0.0.6.

## Editor-tab switching experiment

- PASS: 20 tests, including selected-tab closure, no reload command, operation ordering, close cancellation, copy failure, setting rollback, and avoiding a second reopen after the first reopen fails.
- SOURCE INSPECTION: installed Claude Code 2.1.319 handles editor panel disposal by retiring its communication object (`shutdown()`), removing its session binding, and recording the session ID in its recently-closed list. `claude-vscode.reopenClosedSession` uses that ID to recreate the panel. These are source observations, not runtime process proof.
- UNVERIFIED: actual process exit/restart, correct destination account, same conversation, no other editor disruption, and back-and-forth switching. The one-second shutdown grace period is not proof of process termination. Test with idle accounts and one Claude editor tab; do not close other Claude tabs during the switch.
- PUBLISHING ON HOLD pending live verification. Advanced Switch still has the explicit reload option; quick switch never invokes it.

Live acceptance: install 0.0.6; open a harmless conversation in a Claude editor tab alongside an ordinary code tab; note the account; stop active work; switch to the second account; verify the code tab stayed open, conversation history is intact, account changed, and a new reply works; repeat back to Default. Check Claude logs/processes for session shutdown and a fresh process. Do not mark these checks passed from mocks alone.

## Prior evidence

- PASS: Default profile configuration tests cover unset directory semantics, custom/inherited directories, and preservation of unrelated settings. Quick-switch regression verifies Default is shown and marked Current.
- UNVERIFIED: live return to Default and account verification in the panel and CLI. No real account configuration was changed during development.

- PASS: configuration tests cover directory replacement, preservation of unrelated configuration edits during restoration, and authentication override detection.
- PASS: history tests cover back-and-forth copying with identical session IDs and retained backups, selected sidecars/checkpoints only, malformed history rejection, workspace filtering, traversal and lock rejection, junction rejection, and rollback after a simulated commit failure.
- USER REPORT: 0.0.3 failed with "Could not identify the active Claude conversation uniquely". Title-based selection did not support the user's chat surface. It has been removed from quick switch.
- PASS: multi-session workspace transfer tests and malformed-batch preflight. A mocked VS Code sidebar flow verifies only one destination picker, no tab dependency, all workspace sessions passed to copying, configuration update, and automatic reload without opening a guessed chat.
- INSPECTED: Claude Code 2.1.319 uses `claudeVSCodePanel` webview tabs, truncated titles, and `claude-vscode.editor.open(sessionId)` to open/focus a conversation. Public tab metadata does not include its session ID.
- UNVERIFIED: live Claude sidebar/tab restoration after workspace-history copying and compatibility with other Claude extension versions. A passing mock is not actual UI verification.
- PASS: JavaScript syntax checks.
- PASS: VSIX packaged with vsce 4.1.0 using Node 24.22.1; no node_modules or credentials included.
- PASS (inspection only): installed official Claude Code extension 2.1.319 declares environmentVariables as machine scoped. This does not prove account switching at runtime.
- UNVERIFIED: installation/activation in the extension host, two-account panel switching, CLI authentication, reload behavior, multiple windows, and rollback in a live VS Code instance.
- UNVERIFIED: actual Claude panel/CLI resume of a transferred transcript. Filesystem fixture tests are not runtime account-switch proof. Manual gate: create a harmless test conversation, switch A → B → A, check history and account each time, and compare backup contents before trying valuable work.
- UNVERIFIED: macOS and Linux. Remote hosts intentionally unsupported.
- PASS (2026-11-08): packaging dependency override updated minimatch to ^11.0.5; npm install/audit reports zero vulnerabilities. The override applies only to the development packaging tool.

Build with Node 22 or later (Node 24 used here). System Node 20.11 is too old for the packaging dependencies.

The extension is a local prototype, not Marketplace-ready. Publisher `local-prototype` is a placeholder. No account credentials were read or changed, no profile was switched, and nothing was published.

## 0.0.8 CLI profile candidate

- Agent-observed: 25 tests and syntax checks pass.
- Agent-observed: actual isolated VS Code terminals follow profile selections, explicit CLI selection overrides the panel selection, and Default restores the inherited environment.
- Agent-observed: two distinct isolated accounts pass Default → Test B → Default using `auth status` through ordinary and explicit terminals, with both Claude 2.1.168 and 2.1.319.
- Unverified for this candidate: interactive CLI inference/chat continuation and normal-window installation. No normal setup/history changes made.
- See `docs/CLI_ACCOUNT_INVESTIGATION.md` and the two `docs/isolated-cli-*.json` reports. Marketplace remains on hold.

## Automatic CLI continuation — isolated verification, 2026-11-08

32 automated tests and syntax checks pass. Actual native CLI Default → Test B → Default resumes the same saved conversation. The actual extension CLI-switch command passes both directions with only account selection, preserving all original saved user/assistant messages. See `docs/CLI_CONTINUATION.md` and `docs/isolated-cli-command.json`. No inference requested; combined live panel-plus-CLI transition remains unverified. Normal installation and downloadable package remain 0.0.8; no new installation or Marketplace publication performed.

## 0.0.9 combined panel and CLI verification — 2026-11-08

PASS: actual official Claude panel plus managed native CLI, two distinct authenticated isolated profiles, Default → Test B → Default. Original panel/CLI session IDs returned in new processes, all original saved messages remained, unrelated editor object and extension-host PID were unchanged. Exactly two account pickers; no conversation picker or Resume confirmation. The harness substituted picker responses only, exercising the real quick-switch implementation and native APIs. See `docs/isolated-combined-switch.json`.

33 regression tests and syntax checks pass. Empty startup records were excluded from resumable conversation lists after the combined test exposed the safe-abort bug. No new inference was requested. User authorized normal installation conditional on these tests passing; Marketplace remains on hold.

0.0.9 normal installation verified: extension registry version and all installed source hashes match; settings/keybindings unchanged from backup. No normal history modified. Existing windows were not reloaded automatically. No Marketplace publication or GitHub push performed.

## 0.0.10 history-listing fix — 2026-11-12

- USER REPORT: after a quick switch, the reopened panel failed with `No conversation found with session ID`. The transcript stayed in the source profile. It recorded later `cwd` values in subfolders such as `Admin\backend` because Claude had changed directory, and `listSessions` compared only the last `cwd` with the workspace folders.
- FIX: match on the first recorded `cwd`, which is the launch folder, and accept a launch folder inside an open workspace folder.
- PASS: 34 tests, including a regression test for a session that changed into a subfolder. Against the affected real profile, the old code listed 2 of 7 workspace conversations and the fix lists all 7 (read-only). The affected conversation was then copied with `transferSession`, with a backup.
- VSIX: vsce 4.1.0 cannot run on system Node 20.11, so the 0.0.10 VSIX was made from the 0.0.9 package. Only `history.js`, `package.json` and the bundled Markdown were replaced, links were rewritten as vsce does, and the manifest version was bumped. UNVERIFIED: a live switch with 0.0.10 installed.

## 0.0.11 cross-project switching — 2026-11-14

- USER REPORT: after switching in the ClaudeProfileSwitcher window, a new RoyalGroup chat (in another window) was missing. The transfer log shows that switch copied only the switching window's session, while the global panel setting moved every window to the new profile.
- FIX: after the strict workspace transfer, `pendingSessions` lists every project's conversations that are missing in the destination or differ in content and are newer. `transferEach` copies each one independently, and failures are reported in a warning rather than aborting the switch.
- PASS: 36 tests. Read-only dry run between the two real profiles: identical copies are excluded, and only new or changed sessions from the RoyalGroup, GN and ClaudeProfileSwitcher projects are listed. The scan took 0.8–1.2 s.
- UNVERIFIED: a live switch with 0.0.11 installed while another window's panel is still running. That window keeps its old process, and so its old profile, until its chat is reopened.

## 0.0.12 immediate account refresh — 2026-11-15

- USER REPORT: after switching, the usage panel showed the previous account and chats kept using it until VS Code restarted.
- LOG EVIDENCE: the Claude Code log shows "CLAUDE_CONFIG_DIR changed … refreshing every webview" at 02:13:21. The chat channel started at 02:12:55 was never closed, and a usage request at 11:31 still went to that channel.
- SOURCE INSPECTION (Claude Code 2.1.325): `refreshEveryHost` invalidates caches and pushes state but does not call `restartSessionsWhenIdle`. That only runs after an organization sign-in or a telemetry change. The sidebar views use `retainContextWhenHidden`, so hiding them does not stop their process. Claude panels register a webview serializer that reopens the saved session.
- FIX: after a switch, run `workbench.action.restartExtensionHost` (present in VS Code 1.131), falling back to a window reload. Other windows react to the setting change: they copy their own workspace conversations, then restart if idle, or ask when busy or debugging.
- PASS: 38 tests.
- UNVERIFIED (live): that every Claude tab reopens on the same conversation after the extension host restarts, and what the sidebar shows afterwards. That the usage panel then reports the new account.
