# Changelog

## 0.0.10 — Fix lost conversations after a switch

- **Fixed:** a conversation could be left behind on a switch, and reopening it showed *"Couldn't load this conversation's saved history"* / `No conversation found with session ID`. This happened when Claude had run `cd` into a subfolder during the conversation. The switcher looked at the last folder the conversation recorded rather than the folder it started in, so it did not treat the conversation as part of the workspace and did not copy it.
- Conversations are now matched by the folder they started in, which is the one Claude uses to resume. Conversations started in a subfolder of an open workspace folder are included too.
- **If you were affected:** the original conversation is still in the previous profile. Switch back to that profile, then use **Advanced Switch → Continue an existing conversation** to copy it to the new profile.
- Added a regression test.

## 0.0.9 — Automatic managed CLI continuation

- Panel profile switches also restart idle CLI terminals opened by Claude Profiles, resuming their exact saved conversation IDs.
- Add Switch CLI Profile and Continue for independent CLI switching with only an account picker.
- Verify live process/session identity, saved history, destination readiness and collisions before stopping a CLI. Confirm process exit before history transfer.
- Prefer the official extension's bundled CLI; keep ordinary shell terminals untouched.
- Tracking is limited to the current extension-host session. Marketplace publishing remains on hold.

## 0.0.8 — CLI profile inheritance

- New VS Code terminals inherit the profile selected for the Claude panel. Existing CLI processes retain their account until reopened.
- Explicit CLI and sign-in commands protect the selected profile from terminal environment collection overrides.
- Default removes the switcher's terminal override; overrides are not persisted across extension-host restarts and are cleared on disposal.
- No history-transfer or panel-reopen logic changed. Marketplace publication remains on hold.

## 0.0.7 — Controlled normal-window test

- Repair contaminated Default recovery metadata and allow settings-only recovery without a Claude tab.
- Reject switching when no saved workspace history is found.
- Use the same editor-tab transfer/reopen flow when switching back to Default.
- User confirmed isolated Default → Test B → Default preserved the conversation, selected the correct accounts, and kept other tabs open. Normal-environment testing remains in progress; Marketplace publishing remains on hold.

## 0.0.6 — Editor-tab switching experiment

- Quick switch closes only the focused Claude editor tab and invokes Claude's Reopen Closed Session after copying history and changing the account configuration.
- No VS Code window reload on quick switch; sidebar-only usage is rejected before changes.
- Restore the previous account configuration when switching fails, and reopen the original chat when possible.
- 20 automated tests pass. Live two-account process restart and conversation continuity remain unverified; Marketplace publishing is on hold.

## 0.0.5 — Prototype

- Include the existing Claude setup as Default.
- Create and sign in to additional account profiles.
- Switch the official Claude Code panel and launch CLI terminals with a selected profile.
- Preserve workspace conversations and back up previous destination history when switching.
- Restore the original panel configuration.

Live account switching and chat restoration are still being validated. This version is not a verified stable release.
