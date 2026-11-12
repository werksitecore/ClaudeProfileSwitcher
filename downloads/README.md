# Latest extension

> **Controlled test build.** Back up VS Code settings before testing; Marketplace publication remains on hold. See [the investigation](../docs/HISTORY_INCIDENT.md).

[Download Claude Profile Switcher](https://github.com/werksitecore/ClaudeProfileSwitcher/raw/refs/heads/main/downloads/claude-profile-switcher.vsix)

Current version: **0.0.10** (prototype).

## What's fixed in 0.0.10

After a profile switch, reopening a conversation could fail with *"Couldn't load this conversation's saved history, so it can't be continued"*. It happened to conversations in which Claude had changed into a subfolder of the project, such as `Admin\backend`, because the switcher did not copy them to the new profile. 0.0.10 copies every conversation started in the open workspace.

**Already hit this?** Nothing was lost. The original conversation is still in the previous profile. Install 0.0.10, switch back to the previous profile, then switch again. Or use **Advanced Switch → Continue an existing conversation** to copy it.

See the [changelog](../CHANGELOG.md) for earlier versions.

In VS Code, choose **Extensions → … → Install from VSIX…**, select this file, then reload the window.

Only the current installer is kept in this folder. `npm run package` replaces it with a build of the version in `package.json`.
