# Latest extension

> **Controlled test build.** Back up VS Code settings before testing; Marketplace publication remains on hold. See [the investigation](../docs/HISTORY_INCIDENT.md).

[Download Profile Switcher for Claude Code](https://github.com/werksitecore/ClaudeProfileSwitcher/raw/refs/heads/main/downloads/claude-profile-switcher.vsix)

Current version: **0.0.21** (prototype). 0.0.21 renames the extension to "Profile Switcher for Claude Code"; nothing else changed since 0.0.20. Your profiles and settings are kept when you update.

## New in 0.0.20: free up storage

Earlier versions saved a full copy of every changed conversation on every switch, so `~/.claude-profile-switcher` could grow to tens of gigabytes. 0.0.20 stops that, and **Claude Profiles: Manage Storage → Optimize Storage** cleans up what earlier versions left behind. On the first machine it ran on, storage went from 43 GB to 3.4 GB, and every conversation version was kept in a compressed archive.

1. Install this VSIX and reload the window.
2. Close every Claude chat and `claude` terminal.
3. If Manage Storage reports a stale lock, choose **Release Stale Storage Lock** first.
4. Run **Optimize Storage** and confirm each of its six steps.

The [README](../README.md#free-up-space-step-by-step) explains each step and what to do.

Builds 0.0.13 to 0.0.19 were unreviewed test builds and are withdrawn. Install 0.0.20 instead.

See the [changelog](../CHANGELOG.md) for earlier versions.

In VS Code, choose **Extensions → … → Install from VSIX…**, select this file, then reload the window.

Only the current installer is kept in this folder. `npm run package` replaces it with a build of the version in `package.json`.
