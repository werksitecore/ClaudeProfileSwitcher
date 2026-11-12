# History visibility and Default recovery investigation

Date: 2026-11-08. Observer: Codex. Release status: **hold; no replacement VSIX built or offered**.

## User report

After restart, history appeared missing and returning to Default failed. Uninstalling the switcher restored history visibility. The user's working VS Code/Claude settings, credentials, and conversations were not read or changed during this investigation.

## Confirmed defects

1. Version 0.0.6 validates the presence of a Claude editor tab before allowing a destination selection. This blocks using the normal profile picker to return to Default when the editor tab is absent or broken.
2. The recovery command relies solely on `original` in extension storage. With that key missing it reports no saved configuration, leaving the profile-directory override in place, even if a Default snapshot exists.
3. A previously stored Default snapshot pointing at a switcher-managed directory is trusted. Missing registrations or contaminated snapshots can leave Default pointing at a secondary account.
4. Switching changes the history directory. Only histories discovered for open workspace paths are copied. Other projects' histories are not deleted, but are absent from the selected profile's history list.

These defects can explain the report, but the user's exact failure sequence is not confirmed. In particular, no uninstall hook restores settings in our code; history returning after uninstall is a user observation, not proof of a specific mechanism.

## Corrections in source

- Validate the recovery baseline and refuse to adopt directories managed by the switcher as Default, even without saved profile registrations.
- Restore from the validated baseline independently of the `original` key, Claude availability, or active tab. Keep recovery metadata for repeated use.
- Selecting Default uses the recovery path before checking Claude's editor-tab requirements.
- Recovery changes only the directory setting and clears stale resume pointers. It does not copy or overwrite any history files in Default.
- Reject editor switching when no saved workspace conversation was found.

Without an active Claude editor tab, selecting Default is a settings-only recovery operation. With an active Claude editor tab, the ongoing isolated experiment uses the backed-up transfer/reopen path in both directions so returning to Default does not skip the restart or lose the latest messages. The explicit Restore Original Panel Configuration command remains settings-only. Seamless cross-account continuation is **not yet validated** and must not be marketed as reliable.

## Isolated evidence

Environment: real VS Code 1.131.0 extension host, separate `--user-data-dir`, `--extensions-dir`, workspace, USERPROFILE/HOME, APPDATA, and LOCALAPPDATA under `.isolated-vscode`. Only a configuration-schema fixture extension was installed. No real Claude extension, account, or history was used. The production switcher activation and registered restore command ran inside that host, rather than a mocked VS Code API.

- **Reproduced failure:** the source extracted from the existing 0.0.6 VSIX left `CLAUDE_CONFIG_DIR` pointing at a synthetic managed profile when `original` was absent and the saved baseline was contaminated.
- **Pass:** patched source removed the override with no Claude extension/tab present, preserved unrelated settings, and left the synthetic history file byte-for-byte unchanged.
- **Pass:** a separate VS Code process restarted with the same isolated user data and retained the restored settings. Recovery remained usable.
- **Pass:** 23 unit/regression tests, including history backup/rollback tests and contaminated-baseline tests.
- **Unverified:** live authentication, actual Claude history rendering, process shutdown/restart, and cross-account resume. No replacement version is being distributed on the strength of synthetic recovery tests.

Evidence: `isolated-recovery-first.json`, `isolated-recovery-restart.json`, and `isolated-recovery-baseline.json` in this directory.

Repeat the patched-source checks in child shells:

```powershell
pwsh -NoProfile -File tools/isolated-vscode/run.ps1 -Phase first
pwsh -NoProfile -File tools/isolated-vscode/run.ps1 -Phase restart
```

Before any new release, validate real Claude in a similarly isolated environment using dedicated test accounts and test conversations. Keep the user's recovered setup untouched. Existing downloadable prototypes are not a recommendation to reinstall.
