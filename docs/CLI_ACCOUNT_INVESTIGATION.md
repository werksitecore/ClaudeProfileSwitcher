# CLI account mismatch investigation — 2026-11-08

Status: unresolved; no replacement extension published or installed.

User reports a newly opened `Claude Profiles: Open CLI with Profile` terminal selected as Personal displays Work. Panel switching and continuation work (user report).

Read-only checks of the normal setup:
- Personal and Work registrations point at distinct directories.
- Standalone Claude 2.1.168 and panel-bundled Claude 2.1.319 `auth status`, launched separately with each selected directory and authentication override variables removed, report distinct accounts consistently across binaries. Account identifiers and credentials are omitted from this record.
- No profile API-key helper or profile-level environment entries were found in the inspected configuration.
- Saved terminal environment collections did not establish an account override. This does not prove the environment of the user's affected live terminal.

Isolated VS Code 1.131.0 process test: PASS (agent observed). A fresh, separate user-data/extensions/home environment launched real terminals using the same `TerminalOptions.env` approach as production. Work → Personal → Work each delivered the selected directory to a child Node process and removed a synthetic inherited API key. This tests terminal environment delivery, not Claude authentication or chat continuation. Evidence: ignored `.isolated-cli-probe/result.json`; harness in the same isolated directory. The first sandboxed launch failed before producing a report; the permitted isolated launch completed successfully.

Outstanding: determine whether `/status` in the affected Personal CLI also reports Work, or only the welcome banner does. The root cause is not established. No production settings, history, login data, or installed extension were changed during this investigation. Do not treat the version difference alone as proof of cause.

## Follow-up: live process inspection

User confirmed `/status` also shows Work, so this is not limited to the welcome banner.

Agent observed, read-only on 2026-11-08:
- Installed 0.0.7 launcher matches repository code: direct `shellPath: claude`, explicit selected `CLAUDE_CONFIG_DIR`, terminal name `Claude: <profile>`.
- Current official panel process has Personal's directory in its process environment.
- The standalone VS Code Claude process (PID 65540 at inspection time) has no `CLAUDE_CONFIG_DIR`. Its parent (PID 5644) is PowerShell, unlike the direct executable launched by the profile command.
- Two unrelated Claude processes belong to another integration and use other directories. They were not changed.
- Only profile aliases and environment variable names were emitted; no credential values were output. No process was modified or terminated.

This narrows the problem to the provenance of the affected terminal, but does not yet prove why it differs from the user's reported command. Requested opening the exact profile command again and leaving `Claude: Personal` open for inspection. Do not claim a launcher fix without reproducing its failure.

## 0.0.8 candidate fix and verification

2026-11-08, agent observed:
- The additional CLI visible after the user's screenshot again had no profile-directory override and was a child of PowerShell. The screenshot showed CLI 2.1.168 and a different account from the panel. Why this differed from the reported explicit profile command remains unproven.
- Confirmed implementation gap: the panel switch previously updated only `claudeCode.environmentVariables`; it did not set the environment of ordinary new VS Code terminals (including shell-based Claude launches).
- Added a nonpersistent terminal environment collection for the currently configured panel directory. Default removes that mutation when its original configuration had no directory override. Existing processes are not rewritten or killed. Remote/untrusted windows do not receive this override.
- Explicit profile terminals use a complete inherited environment with `strictEnv`, then remove authentication overrides and set only the selected profile directory. This prevents the panel's collection from overriding an independently chosen CLI profile. Windows key casing is handled.
- No history-transfer or chat-reopen implementation was changed.

Verification: 25 automated tests pass, including production quick-switch/Default synchronization and explicit CLI environment isolation. `npm test` is now scoped to `test/`, preventing discovery from traversing isolated Windows cache directories.

Actual isolated VS Code 1.131.0 terminals: ten synthetic environment checks pass, plus six real `claude auth status` account checks (Default → Test B → Default, ordinary and explicit terminals). Both panel-bundled Claude 2.1.319 and standalone Claude 2.1.168 passed. The two isolated accounts were confirmed distinct; output contains only booleans and profile labels. Evidence: `isolated-cli-bundled.json` and `isolated-cli-standalone.json` in this directory. Reproduction: `tools/isolated-cli/run.ps1`, requiring the previously signed-in `.isolated-live` test accounts. Set `PROBE_CLAUDE_BINARY` to test a specific CLI binary.

Test correction: the first real-account attempt inherited the intentionally fake API key used by the environment-only test. Explicitly removing that fixture for ordinary-terminal auth checks resolved the mismatch. A temporary diagnostic-output shape also caused assertions to fail; the final reports were produced only after the corrected complete runs exited successfully. This was a test setup failure, not evidence of a Default credential defect.

Limits: auth-status checks prove account selection, not a new paid inference or interactive chat-continuation round trip for this build. Prior user-reported chat continuation remains separate evidence. No normal configuration, history, or installed extension was changed. 0.0.8 is a local candidate, not a Marketplace release.

2026-11-08: User explicitly requested normal VS Code installation of 0.0.8. Settings/keybindings backed up under `.local-backups/vscode-before-0.0.8-20261108-191012`. VS Code CLI reported successful installation; normal extensions registry lists 0.0.8 and installed terminal-profile source matches repository hash. Settings/keybindings hashes unchanged after installation. No Claude history operations performed. Activation in already-open windows and interactive continuation after this installation are not independently verified. User reports CLI Work → Personal → Work is working; that report preceded this installation.
