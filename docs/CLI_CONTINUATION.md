# Automatic CLI continuation — isolated CLI verification complete

Scope selected by user on 2026-11-08: terminals opened by Claude Profiles first. Ordinary shell terminals are not adopted or terminated.

Implemented locally (not packaged or installed):
- Track owned terminal objects and their native process IDs.
- Prefer the official extension's bundled CLI so that the CLI and panel use the same version.
- Resolve the current conversation from Claude's native `sessions/<pid>.json` registry, rather than from transcript modification order. This also follows conversation changes inside that CLI.
- Require an exact live process/session identity, interactive kind, idle state, and an existing settled transcript. Missing/unknown registry state blocks switching.
- Preflight destination CLI onboarding and live-session collisions before closing any managed terminal.
- Wait for confirmed process exit before copying history with existing backed-up transfer logic. Resume the identical session ID under the new profile. Restore stopped source CLIs if the transfer or panel transaction fails.
- Panel quick-switch includes owned CLIs using its source profile. `Claude Profiles: Switch CLI Profile and Continue` switches only the active owned CLI with one account picker. No conversation picker or Resume confirmation.
- Tracking is in-memory; after an extension-host restart, reopen through Claude Profiles once. No ordinary terminals are discovered or killed.

Evidence and remaining checks (2026-11-08):
- 33 automated tests and all syntax checks pass, including duplicate-session refusal, process identity, recent-write/busy guards, destination collisions, onboarding, and parent-project trust.
- Actual isolated Claude 2.1.319 / VS Code 1.131.0: Default → Test B → Default passed with identical session IDs and confirmed old-process exit before history transfer. Both isolated accounts were authenticated and distinct.
- Actual production `claudeProfiles.switchCli` command passed the same round trip with native VS Code terminals. The test substituted only environment boundaries and picker/notification responses; the source command, session reader, process shutdown, history transfer, and native CLI startup were real.
- Production command test observed exactly two account pickers for two switches and no conversation picker or Resume confirmation. Every original saved user/assistant message remained in the final transcript.
- Evidence: `docs/isolated-cli-continuation.json`, `docs/isolated-cli-command.json`. Reproduction: `tools/isolated-cli/run.ps1 -Mode continuation` or `-Mode command`, after signing into the two isolated accounts and completing their CLI setup.
- No new model response was requested. These checks prove saved-chat reopening and retention, not inference under both accounts.
- Combined live panel-plus-CLI test PASSED on 2026-11-08 using the actual quick-switch command, official panel, and managed native CLI. Both original IDs resumed through Default → Test B → Default, all original messages survived, the unrelated editor object remained, and the extension-host PID did not change. Exactly two account choices and no conversation/Resume prompts. See `docs/isolated-combined-switch.json`; reproduce with `tools/isolated-combined/run.ps1`.
- Version 0.0.9 is being packaged for the user-authorized normal installation after passing the combined test. Marketplace publication remains on hold.
- Native session-registry schema is an implementation dependency verified against 2.1.319; missing/changed fields fail closed. Tracking lasts for the current extension-host session; reopen through Claude Profiles after an extension-host restart.

Test corrections:
- Initial run stopped at the recent-write guard. Tests now let startup writes settle.
- Test B needed its theme/onboarding and folder-trust steps completed manually. The user completed them in the isolated window; no trust or authentication settings were bypassed.
- Added onboarding/trust preflight before source CLI closure. Claude stored trust at the parent Git project; the initial exact-directory check was too strict and now recognizes trusted ancestors without accepting sibling paths.
- Bounded the process-ID wait so a failed terminal startup cannot hang switching indefinitely.
- The first production harness spread all VS Code window properties and hit a proposed-API getter. It now proxies only required stable APIs; no proposed API was enabled.

Combined-test finding: metadata-only Claude startup files were incorrectly included in workspace history transfers, causing a safe abort with “No resumable messages found”. The session list now excludes files without user/assistant messages, with a regression test proving real chats copy and empty records remain untouched. The combined test passed after this fix.

Normal installation completed on 2026-11-08 after the user's conditional authorization was satisfied. VS Code reported successful 0.0.9 installation; the normal extension registry and all installed source hashes match the packaged candidate. User settings/keybindings hashes remained unchanged. Backup and previous 0.0.8 VSIX: `.local-backups/vscode-before-0.0.9-20261108-195838`. Packaged VSIX SHA256: `e239962d90a8f285caeb5ba90738f8e9aba7bfaa402575e1bf06d41b1af1ec3e`. No normal Claude history or credentials were changed by installation. Existing normal windows were not forcibly reloaded. Activation in the user's current window requires a one-time extension/window reload if VS Code requests it; managed CLI tracking begins when opened through the updated extension.
