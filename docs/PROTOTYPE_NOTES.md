# Claude Profile Switcher — prototype

An independent extension for named Claude Code configuration directories. Supports the official Claude Code chat panel and separately launched CLI sessions. Not affiliated with Anthropic. No telemetry, credential copying, or account rotation.

## Try it

Version 0.0.5 includes **Default — Existing Claude setup** automatically in every profile picker, marked **Current** when selected. You do not need to recreate or sign in again to your existing account. Create profiles only for additional accounts. Default uses the original configuration saved before the first switch (including a custom configuration directory if one was configured). Returning to the standard Default removes the directory override instead of explicitly pointing it at `~/.claude`, preserving Claude's original login-file location. CLI launch uses the same default behavior. An existing signed-out setup will still require Claude's normal sign-in.

1. Install the official Claude Code extension and the standalone `claude` CLI. The CLI must be on VS Code's PATH.
2. Install the provided VSIX through Extensions → … → Install from VSIX, or open this project and press F5.
3. Run **Claude Profiles: Create Profile** for Personal and Work. Use **Sign In to Profile** for each and complete Claude's browser login.
4. Run **Switch Chat Panel Profile**, finish any running work, and accept the switch. Reload when offered. Open a new Claude conversation and check its account.
5. Run **Open CLI with Profile** and choose the same profile. Use `/status` to verify the account. Repeat with the other profile.
6. Use **Restore Original Panel Configuration** to undo the panel directory change before uninstalling.

Profiles are stored beneath `~/.claude-profile-switcher/profiles/` with UUID directory names. Claude manages the authentication and history there. The switcher stores only labels and paths in VS Code extension state. Uninstalling does not delete profile data or automatically restore settings.

## Continue the same conversation on another account (0.0.2)

### Quick switch (0.0.4)

Stop any active Claude work, click the account indicator, and choose the destination profile. The normal switch copies the currently configured profile's saved conversations for the open workspace folders, preserving every session ID and keeping backups, then reloads VS Code. There are no mode, source-profile, session-ID, confirmation, or reload questions in this path.

Version 0.0.3's title matching has been removed: it failed for sidebar chats. Quick switch no longer needs to know which conversation is active. Claude retains responsibility for restoring its existing sidebar and editor tabs after reload. No new or guessed conversation is opened. This means all saved chats for the open workspace folders are carried into the destination profile, not just the visible one. Sessions for other project folders are not copied. Destination-only conversations are retained; same-ID conversations are replaced with the source version and their previous versions backed up. Use Advanced Switch to limit copying to a single conversation.

Actual sidebar/tab restoration still requires live validation and depends on Claude's own restore behavior. If Claude does not restore a chat, **Resume Copied Conversation** lists the transferred chats as a recovery action. A multi-session copy validates all transcripts first; if a later filesystem failure occurs, the panel setting remains unchanged, but earlier copied sessions and their backups remain in the destination. The following explicit flow is available under **Claude Profiles: Advanced Switch** for recovery or choosing another source.

1. Stop the conversation and any related CLI/background work in both profiles. Open the conversation's project folder in VS Code.
2. Run **Advanced Switch**, choose the destination account, then **Continue an existing conversation**.
3. Choose the source profile and conversation. Newest conversations appear first; the session ID is shown to distinguish them. The extension cannot infer which of several Claude tabs you mean.
4. Confirm **Stopped — Copy and Switch**. The selected conversation and its session sidecars/checkpoints are copied with the **same session ID**, without rewriting message records or copying credentials.
5. Choose **Reload Window**. The existing tab may reopen with its history; otherwise run **Claude Profiles: Resume Copied Conversation → Resume in Panel**. Use **Resume in CLI** for a terminal with `claude --resume <session-id>`.
6. Check the destination account before sending your next message. To switch back, repeat with the profile containing the latest conversation as the source.

Before replacing a destination conversation, the extension saves the incoming transcript and moves the previous destination version into a unique `.profile-switch-backups/` directory within that destination profile. **Show Backup** reveals its manifest. Backups are retained without automatic cleanup. The source is read only during the transfer. Branches are not merged: the selected source becomes the working conversation, and the previous destination branch remains in its backup.

This is an experimental saved-history handoff, not a live process transfer. No automatic quota detection or account rotation is included. Account limits still apply. Conversation content becomes available to the destination account when resumed. Interrupted tools, external images/temp files, global memory, plans, credentials, and provider settings are not migrated. Resume requires a compatible Claude version and the same project folder. Claude's transcript format is internal and may change. The official panel URI handler is used to resume by ID; it can open a blank chat if Claude cannot find the session. Verify visible history before sending.

Keep both profiles idle during copying. The switcher checks for changes during the snapshot and rejects malformed records, directory links, oversized files, and concurrent switcher transfers, but cannot lock out Claude's own writers. Ordinary commit failures roll back; a process crash or failed rollback may need manual restoration from the recorded backup. Do not delete backup folders or a retained `.profile-switch-lock` until recovery is complete.

## Prototype limits

- Local desktop windows only; remote/WSL/SSH/container windows are rejected.
- The panel environment setting is machine scoped in the inspected Claude extension 2.1.319. Changes affect this VS Code user's windows; independent panel profiles per workspace are not supported.
- Running sessions are not migrated; saved history can be copied explicitly. The status bar displays configured directory, not verified account identity. Reload and inspect Claude's account before use.
- CLI sessions launch `claude` directly with the selected directory and common inherited authentication/provider overrides removed. Missing CLI errors appear in the terminal.
- Panel switching blocks common conflicting environment variables. Claude settings, managed policies, shell wrappers, and other authentication sources still require manual verification.
- Subscription accounts are the target. Console sign-ins without API keys are not guaranteed isolated by Claude's directory mechanism.
- No live two-account verification has been performed yet. Do not treat configuration checks as proof of account isolation.

## Development and validation

`npm install`, `npm test`, `npm run check`, `npm run package`.

Manual acceptance: sign into two accounts; verify each in a fresh panel conversation and CLI; confirm an existing CLI retains its original account; check reload behavior, multiple windows, expired login, missing CLI, and restoration preserving unrelated settings. Windows is the initial target; macOS/Linux are unverified.

Documentation: [Claude authentication](https://code.claude.com/docs/en/authentication), [Claude VS Code integration](https://code.claude.com/docs/en/vs-code).
