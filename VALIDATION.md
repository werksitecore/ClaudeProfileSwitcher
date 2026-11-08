# Prototype validation — 2026-11-08

Observer: Codex. Version: 0.0.5.

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
- OPEN: npm audit reports two moderate development-tool findings (vsce via minimatch; GHSA-g3hv-75wg-m249). These dependencies are excluded from the VSIX. Resolve before public release.

Build with Node 22 or later (Node 24 used here). System Node 20.11 is too old for the packaging dependencies.

The extension is a local prototype, not Marketplace-ready. Publisher `local-prototype` is a placeholder. No account credentials were read or changed, no profile was switched, and nothing was published.
