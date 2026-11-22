# Changelog

## 0.0.20 — Storage: from tens of gigabytes to a few

Builds 0.0.13 to 0.0.19 were unreviewed and are withdrawn. Do not install them.

- **Fixed:** each switch saved full extra copies of every changed conversation in `.profile-switch-backups`. On one machine they reached 32 GB.
- Switching no longer saves those copies. An older version is kept only when it isn't an earlier, shorter version of the new one, and it is stored once in a compressed **archive** outside every profile.
- Identical conversations carried between profiles become **one file with a name in each profile** (NTFS hard link). Continuing a carried conversation in one profile continues it in the other. Never continue one conversation in two profiles at once; the extension refuses when it can tell.
- Claude Code's own 30-day cleanup in one profile removes only that profile's name; other profiles and the archive keep the conversation.
- New **Claude Profiles: Manage Storage**, with a guided **Optimize Storage**:
  1. Moves the old backup store into the archive.
  2. Archives every conversation.
  3. Verifies the archive.
  4. Links identical conversations (optional).
  5. Removes redundant old backups.
  6. Verifies again.

  Each step shows a preview and asks first. Claude must be closed in every window and terminal.
- Also new: Restore or Export a Version, Undo Conversation Linking, Release Stale Storage Lock, and Verify Storage Integrity.
- Credentials and account settings are never linked, archived or carried.

## 0.0.12 — The switched account takes effect immediately

- **Fixed:** after a switch, chats that were already open, the sidebar and the usage panel stayed on the previous account until VS Code restarted, and those chats kept using its limits. Claude Code reads the account folder only when it starts a chat process; when the setting changes it refreshes its views but does not restart running chats.
- A switch now restarts Claude in the window: it restarts VS Code's extension host, not the window. Every Claude tab reopens on the same conversation using the new account, and the usage panel shows the new account. Editors and terminals stay open; other extensions restart for a few seconds.
- Other open VS Code windows follow the switch too. They first bring their own conversations into the new profile, then restart Claude. If Claude is replying there, or you are debugging, they ask with **Restart Claude Now** instead of interrupting.
- Advanced Switch and Restore Default restart Claude the same way, instead of asking you to reload the window.

## 0.0.11 — Switching carries every project's conversations

- **Fixed:** a conversation in another VS Code window looked lost after a switch. The account setting is shared by all windows, but a switch only copied the conversations of the window it was made in. A chat open in a second project stayed in the old profile, and that window then pointed to the new one.
- A switch now also copies, without asking, every conversation from any project that is missing in the new profile or newer in the old one. Conversations that are identical in both profiles are skipped, so switching back and forth does not re-copy them or pile up backups.
- If one of those conversations can't be copied (for example, because Claude is still writing to it in another window), the others are still copied. The switch then shows a warning naming it, so you can stop Claude there and switch again.
- Raised the per-conversation size limit from 100 MB to 512 MB. Long conversations above 100 MB were skipped without any warning.

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
