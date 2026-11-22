# Claude Profile Switcher

> **Controlled testing only; not Marketplace-ready.** Version 0.0.20 stops switch backups from piling up and adds **Optimize Storage**, which can shrink tens of gigabytes of history and backups to a few (see [Free up space](#free-up-space-step-by-step)). See the [changelog](https://github.com/werksitecore/ClaudeProfileSwitcher/blob/HEAD/CHANGELOG.md). Normal VS Code testing is in progress with settings backed up. See the [investigation and test evidence](https://github.com/werksitecore/ClaudeProfileSwitcher/blob/HEAD/docs/HISTORY_INCIDENT.md).

Switch between Claude Code accounts in VS Code, with profiles for the **Claude chat panel** and **CLI terminals**.

Your existing setup is included as **Default**. Create profiles only for your additional accounts.

**[Download the latest extension](https://github.com/werksitecore/ClaudeProfileSwitcher/raw/refs/heads/main/downloads/claude-profile-switcher.vsix)** · [Report an issue](https://github.com/werksitecore/ClaudeProfileSwitcher/issues)

> **Prototype · v0.0.20:** Windows-first, local VS Code only. Automated tests pass; live account switching and chat restoration are still being validated. Not yet published to the VS Code Marketplace.

## Install

You need VS Code and the official [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code). For profile sign-in and terminal use, also install the [Claude Code CLI](https://code.claude.com/docs/en/setup) and make sure `claude` works in your terminal.

1. Download the VSIX using the link above.
2. In VS Code, open **Extensions** (`Ctrl+Shift+X`).
3. Click **… → Install from VSIX…** and select the downloaded file.
4. Run **Developer: Reload Window** from the Command Palette (`Ctrl+Shift+P`).

To update, install the latest VSIX again and reload. Your saved profiles remain available.

## Add another account

**Already using Claude? Your existing setup is Default—no need to recreate it.**

1. Press `Ctrl+Shift+P` and run **Claude Profiles: Create Profile**.
2. Give it a name, such as **Work** or **Personal**.
3. Click **Sign In** and complete Claude's browser login with that account.

Missed the notification? Run **Claude Profiles: Sign In to Profile**.

## Switch accounts

### Claude chat panel

1. Stop any running Claude work, keep your project folder open, and focus the Claude **editor tab**.
2. Click **Claude: Default** (or your current profile name) in the status bar.
3. Choose the account you want to use.

The extension closes only the selected Claude editor tab, backs up and copies this workspace's saved conversations, switches the account configuration, then uses Claude's Reopen Closed Session command to reopen the same conversation. VS Code and your other editor tabs stay open. You do not need to pick a conversation or enter an ID. Sidebar-only chats are not supported by this quick-switch flow; open the chat as an editor tab first.

**Default** is always in the list, and the selected profile is marked **Current**. Check Claude's **Account & usage** before sending a message—the status-bar label shows the configured profile, not a verified account identity.

### Claude CLI

After switching the panel profile, open a **new terminal** and run `claude` to use that account. Already-open terminals keep their previous environment.

To choose a CLI account independently, run **Claude Profiles: Open CLI with Profile**, then choose an account. A new terminal starts with that profile. Enter `/status` to check the account.

CLI terminals opened through **Claude Profiles** now follow a panel profile switch automatically: the extension closes each idle managed CLI, preserves its saved history, and resumes its exact conversation under the selected account. No conversation picker is needed.

To switch only your CLI, focus its terminal and run **Claude Profiles: Switch CLI Profile and Continue**. Choose the account once.

Finish each profile's one-time Claude CLI setup and project trust prompt before switching. Busy or unsaved conversations stop the switch safely. Ordinary shell terminals are not restarted. After a VS Code reload, open your CLI through Claude Profiles again so it can be tracked. To bring an existing copied chat into a managed CLI once, use **Resume Copied Conversation → Resume in CLI**.

## How history is preserved

- Quick switch carries **all saved chats for the open workspace folders**, not just the visible chat, plus changed conversations of your other projects.
- Transcripts are linked where possible (see below); other files are copied. Existing destination versions that hold anything new are kept in the archive before replacement; conversation branches are not merged.
- Credentials are not copied. Each profile uses Claude's own sign-in.
- Running tools and processes are not transferred. Stop work in both profiles before switching.
- **Carried conversations are shared, not copied.** A carried transcript (`.jsonl`, including subagent transcripts) becomes one file with a name in each profile (an NTFS hard link). What you add in one profile appears in the other: after a carry, the profiles share that conversation. Checkpoints (`file-history`), images and every other file are still copied.
- **Never continue one conversation in two profiles at once.** Switching refuses while the conversation is open in any profile that shares it.
- When Claude deletes an old conversation in one profile (its `cleanupPeriodDays` sweep), only that profile's name goes; other profiles and the archive keep it.
- On a different drive, a FAT or network drive, or a cloud-synced folder (OneDrive, Dropbox, Google Drive, iCloud), transcripts are copied instead, and the switch says so.
- When a destination version holds anything the incoming one lacks, it is kept in the archive (`~/.claude-profile-switcher/backups/archive`, compressed, each line stored once). Older versions that are only a shorter prefix of the new transcript are not stored. **Resume Copied Conversation → Show Backup** exports the kept versions and shows them.

For a single-chat transfer or recovery from another profile, use **Claude Profiles: Advanced Switch**.

## Free up space: step by step

Earlier versions saved a full copy of every changed conversation on every switch, so `~/.claude-profile-switcher` could grow to tens of gigabytes. **Optimize Storage** removes those copies safely. On the first machine it ran on, storage went from 43 GB to 3.4 GB, and every conversation version was kept.

### Before you start

1. Install the latest VSIX (see [Install](#install)) and reload the window.
2. **Close Claude everywhere:** every Claude chat tab in every VS Code window, and every `claude` terminal. The VS Code windows themselves can stay open. Optimize Storage refuses to start while Claude is running, and you should not open Claude again until it finishes.
3. Allow time. The first run can take 30–60 minutes on a large history; most of it is step 5.

### If Manage Storage reports a stale lock

A lock stops two VS Code windows from changing storage at the same time. If a window closed in the middle of an operation, its lock stays behind, and storage actions report that storage is busy, naming a process that no longer exists.

1. Run **Claude Profiles: Manage Storage**.
2. Choose **Release Stale Storage Lock** and confirm. It is listed whenever a storage lock exists, but it releases the lock only when its owner is no longer running; otherwise it refuses and changes nothing.

### Run Optimize Storage

Run **Claude Profiles: Manage Storage → Optimize Storage**. Every step works the same way: a report opens, a notification appears with a button to continue, and a confirmation asks before anything changes. To stop, close the notification or choose Cancel; nothing else changes. If the notification has disappeared, run **Notifications: Show Notifications**.

| Step | What it does | What you do |
| --- | --- | --- |
| **Preview** | Checks that Claude is closed and lists every conversation that has different versions in different profiles, with where each version will be kept. | Read it, then continue. If it says Claude is still running, close it and start again. |
| **1. Move the old backup store** | Moves the whole-file backups of earlier versions into the compressed archive. Skipped when there are none. | Confirm. |
| **2. Archive every conversation** | Copies the current version of every conversation file (transcripts, checkpoints, images) into the archive (`~/.claude-profile-switcher/backups/archive`), compressed, each line stored once. It only reads your conversations. Older versions found only in backups are archived in step 5. | Confirm and wait until it reports *complete*. |
| **3. Verify** | Rebuilds every archived version and checks it byte for byte. Stops if anything is wrong. | Read the report, then continue. |
| **4. Link identical conversations** | Where several profiles hold the same conversation, they keep one file with a name in each profile (an NTFS hard link), which frees that space. Only transcripts are linked. Linked profiles then share that conversation: what you add in one appears in the other. | Choose **Link Conversations**, or **Skip Linking** to keep separate copies. **Undo Conversation Linking** reverses it later. |
| **5. Remove old backups** | Deletes old switch backups whose content is kept elsewhere. Anything unique is first moved into the archive. Old snapshots with no record of being completed (no manifest, or one that is not complete) are kept; anything found only in them is archived and the files stay in place. Runs in batches and can be cancelled between them. | Read the preview (what is deleted, moved and kept), then confirm. This step takes longest. |
| **6. Verify again and compact** | Rebuilds everything again, confirms each different conversation version from the preview, then frees unused space inside the archive. | Confirm the compaction. The final report lists every step. |

If a step stops, the report says why. Completed steps stay done, so run Optimize Storage again to continue. **Clean Redundant Backups** can also run on its own.

### Afterwards

- Switching no longer saves full copies, so storage stays small. A conversation carried to another profile is linked rather than copied when possible. It is copied instead on another drive, in a cloud-synced folder, or while it is open in the profile you are leaving.
- **Never continue one conversation in two profiles at once.** The extension refuses when it can tell.
- **Restore or Export a Version** brings back any archived version. **Undo Conversation Linking** gives each profile its own copies again.
- Snapshots without a manifest that step 5 kept can be removed one at a time with **Clean Redundant Backups**, which asks for each. Snapshots whose manifest is incomplete are always kept.

## Storage

Each profile keeps its own conversation folders (`projects`, `file-history`, `image-cache`). A carried transcript is one file with a name in each profile that has it (see above); everything else is a separate copy. **Claude Profiles: Manage Storage** lists how much space history and backups use, counting each file once however many names it has, then offers these actions. Choosing a size row opens the full analysis.

| Size row | Meaning |
| --- | --- |
| Total | All conversation history and backups for your profiles |
| Private history | History in each profile's own folders |
| Backups | Old switch backups and the archive |
| Archive | The compressed archive of conversation versions |
| Duplicate copies | Extra copies of files that are identical to another copy (estimate) |
| Reclaimable space | Space that Clean Redundant Backups could free (estimate) |

- **Optimize Storage** (recommended) runs the steps in a fixed order, each after its own preview or report and confirmation: move the old recovery store into the archive, capture every conversation until the capture is complete, verify every archived version by rebuilding it, link identical conversations, clean redundant backups, then verify again and compact the archive. It stops at the first failure. Its first preview and its final report list every diverged conversation and checkpoint version and confirm that each one rebuilds from the archive.
- **Link Identical Conversations** turns identical transcript copies across profiles into one file (preview first; Claude must be stopped everywhere). Every version is archived first. **Undo Conversation Linking** gives each profile its own copy again; it covers only the links this action made, not links made later by switching.
- **Clean Redundant Backups** deletes old switch backups whose content is kept elsewhere, moving unique content into the archive first. It refuses until a complete capture has run since the last change to your history; Optimize Storage captures first, and the background capture also completes one.
- **Restore or Export a Version** brings any archived version back, into a profile where that file is missing or to a file you choose. It never overwrites a different file.
- **Remove Leftover Transfer Files** removes the temporary and moved-aside files of interrupted switches, archiving unique content first.
- **Verify Storage Integrity** checks every archive block and rebuilds a sample of versions.
- Each action that changes or deletes something opens a report first. Read it, then choose the button in the notification to continue. Nothing changes until you confirm. If the notification has closed, open Manage Storage again or run Notifications: Show Notifications.
- Resolve Transfer Recovery, Resume Interrupted Migration, Resume Conversation Linking, Undo Conversation Linking, Move Recovery Store into Archive, Clear Migration Marker and Release Stale Storage Lock appear only when they are needed. Roll Back Shared Storage remains for folders shared by an earlier prototype; sharing whole folders is no longer offered.

### Archive

The archive is `~/.claude-profile-switcher/backups/archive`: a compressed store in which each conversation line is kept once. (Older versions kept a whole-file "recovery store" in `backups/objects`; Optimize Storage, or Move Recovery Store into Archive, moves it in.) It also captures changed working copies in the background (every 30 minutes and after each switch), so the newest version of every conversation (Default included) survives Claude's `cleanupPeriodDays` cleanup, and deletion required by a managed or organisation policy, until you discard it in Manage Storage. If a policy requires conversations to be deleted, discard them there too; **Analyze Storage** lists the cleanup periods set by managed or project settings. It keeps every conversation version that would otherwise be lost: a destination version replaced by a switch that the new version does not contain, diverged versions, and unique content from old backups before cleanup deletes them. Identical content is stored once.

- Backups without unique content expire after `claudeProfiles.backupRetentionDays` (default 30).
- Backups with unique content are pinned and kept until you remove them. **Discard Pinned Backups** lists each one with what it holds (for example "Cleanup backup, 20/11/2026, 16:00") before you choose.
- **To remove a conversation completely:** delete it from every profile first (otherwise the background capture archives it again), then discard each of its archived versions with **Restore or Export a Version → Discard This Version**, then discard any pinned backup that still holds it with **Discard Pinned Backups**. The Discard result says what still keeps it. A version that only a backup holds has no Discard option of its own: it goes with that backup.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Commands do not appear | Run **Developer: Reload Window**. |
| Sign-in terminal cannot start | Check that `claude` runs in a terminal, then restart VS Code. |
| Chat history does not reopen | Run **Claude Profiles: Resume Copied Conversation → Resume in Panel**. |
| Wrong account appears | Use **Sign In to Profile** for the intended profile, then reload and verify the account. |
| “Claude is still saving…” | Stop the response, wait a moment, then switch again. |
| Remote window is rejected | This prototype supports local windows only, not WSL, SSH, or containers. |

Panel changes affect your local VS Code user's other windows too. Editor-tab restart and chat restoration depend on the official Claude extension and are not yet verified end to end. Try a short test conversation first. Account limits continue to apply independently.

Before uninstalling, run **Claude Profiles: Restore Original Panel Configuration**. Uninstalling does not delete profiles or backups.

## Development

Use **Node.js 22 or later**.

```sh
npm ci
npm test
npm run check
npm run package
```

Press **F5** in VS Code to launch the extension development window. **Caution:** the development window behaves like an installed extension and works on your real `~/.claude-profile-switcher`, including its background archive capture and the retention cleanup after each switch. The automated tests always use a temporary folder. Packaging replaces the single VSIX in `downloads/`; older VSIX files are excluded from Git.

See [validation results and remaining checks](https://github.com/werksitecore/ClaudeProfileSwitcher/blob/HEAD/VALIDATION.md) and [detailed prototype notes](https://github.com/werksitecore/ClaudeProfileSwitcher/blob/HEAD/docs/PROTOTYPE_NOTES.md).

## License

[MIT](https://github.com/werksitecore/ClaudeProfileSwitcher/blob/HEAD/LICENSE). Independent project, not affiliated with or endorsed by Anthropic. No telemetry. [Privacy details](https://github.com/werksitecore/ClaudeProfileSwitcher/blob/HEAD/PRIVACY.md).
