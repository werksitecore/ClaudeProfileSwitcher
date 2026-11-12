# Actual Claude extension test — 2026-11-08

Status: in progress; no new installer or Marketplace submission.

The official installed Claude Code extension 2.1.319 was copied as application code only into `.isolated-live/extensions`. No working credentials, settings, or conversations were copied. VS Code 1.131.0 uses a synthetic home, separate APPDATA/LOCALAPPDATA, separate user-data and extensions directories, and an isolated workspace. Guard assertions check these paths before activating the switcher.

The real bundled CLI reported **not logged in** using that synthetic home. The user agreed to sign in manually to two isolated test accounts; that step is pending.

## Observations so far

- Real extension-host lifecycle test completed A → B → A with a synthetic transcript.
- The Claude editor tab reopened in both directions. The extension-host process ID and unrelated editor-tab object remained unchanged.
- The synthetic transcript and transfer backups remained present.
- Real Claude logs recorded channel closures and resume requests. Authentication/config probes also start without a resume ID. These logs do not prove account identity or successful rendered conversation continuity.
- The tab-existence check is deliberately insufficient for release: a reopened blank/error/login tab can satisfy it.
- Updated regression coverage ensures an active editor tab returning to Default also uses the transfer/reopen flow. Settings-only recovery is reserved for the explicit restore command or Default selection without an active Claude tab.

## Remaining gates

1. User signs in to Default/test A and Test B inside the window titled ISOLATED CLAUDE TEST.
2. Confirm the accounts are distinct using Claude account status; do not infer identity from the switcher label.
3. Generate a harmless conversation with a unique marker, then switch A → B → A while idle.
4. Check rendered prior messages, marker recall, new replies under the intended account, unchanged VS Code window/code tabs, and backups at every step.
5. Restart the isolated VS Code instance and repeat Default recovery and history visibility checks.

Do not use the user's working accounts' local credential files or working history to bypass these gates. No build will be offered as safe until these checks pass.
