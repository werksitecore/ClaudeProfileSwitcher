# Latest extension

> **Controlled test build.** Back up VS Code settings before testing; Marketplace publication remains on hold. See [the investigation](../docs/HISTORY_INCIDENT.md).

[Download Claude Profile Switcher](https://github.com/werksitecore/ClaudeProfileSwitcher/raw/refs/heads/main/downloads/claude-profile-switcher.vsix)

Current version: **0.0.12** (prototype).

## What's fixed in 0.0.12

The new account now takes effect as soon as you switch, without restarting VS Code. Previously, chats that were already open, the sidebar and the **usage panel** stayed on the old account, and those chats kept using its limits. A switch now restarts Claude in the window: every Claude tab reopens on the same conversation using the new account. Other open windows follow automatically. If Claude is still replying there, or you're debugging, they ask first. Editors and terminals stay open; other extensions restart for a few seconds.

## Fixed in 0.0.11

A switch now copies your conversations from **every project**, not only the window you switched in. Previously, a chat open in another VS Code window, such as a second project, seemed to disappear after a switch, because all windows share the account setting. Conversations that are already identical in both profiles are skipped. If one can't be copied because Claude is still busy in another window, you'll see a warning naming it. Conversations over 100 MB are copied too (the limit is now 512 MB).

**Before switching:** let Claude finish responding in every window. A window that is still running keeps writing to the old profile until you reopen its chat.

## Fixed in 0.0.10

After a profile switch, reopening a conversation could fail with *"Couldn't load this conversation's saved history, so it can't be continued"*. It happened to conversations in which Claude had changed into a subfolder of the project, such as `Admin\backend`, because the switcher did not copy them to the new profile. 0.0.10 copies every conversation started in the open workspace.

**Already hit this?** Nothing was lost. The original conversation is still in the previous profile. Install 0.0.10, switch back to the previous profile, then switch again. Or use **Advanced Switch → Continue an existing conversation** to copy it.

See the [changelog](../CHANGELOG.md) for earlier versions.

In VS Code, choose **Extensions → … → Install from VSIX…**, select this file, then reload the window.

Only the current installer is kept in this folder. `npm run package` replaces it with a build of the version in `package.json`.
