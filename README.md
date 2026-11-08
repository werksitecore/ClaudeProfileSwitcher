# Claude Profile Switcher

Switch between Claude Code accounts in VS Code, with profiles for the **Claude chat panel** and **CLI terminals**.

Your existing setup is included as **Default**. Create profiles only for your additional accounts.

**[Download the latest extension](https://github.com/werksitecore/ClaudeProfileSwitcher/raw/refs/heads/main/downloads/claude-profile-switcher.vsix)** · [Report an issue](https://github.com/werksitecore/ClaudeProfileSwitcher/issues)

> **Prototype · v0.0.5:** Windows-first, local VS Code only. Automated tests pass; live account switching and chat restoration are still being validated. Not yet published to the VS Code Marketplace.

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

1. Stop any running Claude work and keep your project folder open.
2. Click **Claude: Default** (or your current profile name) in the status bar.
3. Choose the account you want to use.

The extension backs up and copies this workspace's saved conversations to that profile, then reloads VS Code. Session IDs are preserved so Claude can restore its existing chats. You do not need to pick a conversation or enter an ID.

**Default** is always in the list, and the selected profile is marked **Current**. Check Claude's **Account & usage** before sending a message—the status-bar label shows the configured profile, not a verified account identity.

### Claude CLI

Run **Claude Profiles: Open CLI with Profile**, then choose an account. A new terminal starts with that profile. Enter `/status` to check the account.

Existing CLI sessions keep their original account. To resume a copied chat in a new terminal, run **Claude Profiles: Resume Copied Conversation**, select the chat, then choose **Resume in CLI**.

## How history is preserved

- Quick switch copies **all saved chats for the open workspace folders**, not just the visible chat. Other projects are excluded.
- The source files stay unchanged during copying. Existing destination versions are backed up before replacement; conversation branches are not merged.
- Credentials are not copied. Each profile uses Claude's own sign-in.
- Running tools and processes are not transferred. Stop work in both profiles before switching.
- Backups remain in the destination profile's `.profile-switch-backups` folder. **Resume Copied Conversation → Show Backup** opens the backup location.

For a single-chat transfer or recovery from another profile, use **Claude Profiles: Advanced Switch**.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Commands do not appear | Run **Developer: Reload Window**. |
| Sign-in terminal cannot start | Check that `claude` runs in a terminal, then restart VS Code. |
| Chat history does not reopen | Run **Claude Profiles: Resume Copied Conversation → Resume in Panel**. |
| Wrong account appears | Use **Sign In to Profile** for the intended profile, then reload and verify the account. |
| “Claude is still saving…” | Stop the response, wait a moment, then switch again. |
| Remote window is rejected | This prototype supports local windows only, not WSL, SSH, or containers. |

Panel changes affect your local VS Code user's other windows too. Chat restoration depends on the official Claude extension and is not yet verified end to end. Try a short test conversation first. Account limits continue to apply independently.

Before uninstalling, run **Claude Profiles: Restore Original Panel Configuration**. Uninstalling does not delete profiles or backups.

## Development

Use **Node.js 22 or later**.

```sh
npm ci
npm test
npm run check
npm run package
```

Press **F5** in VS Code to launch the extension development window. Packaging replaces the single VSIX in `downloads/`; older VSIX files are excluded from Git.

See [validation results and remaining checks](VALIDATION.md) and [detailed prototype notes](docs/PROTOTYPE_NOTES.md).

## License

[MIT](LICENSE). Independent project, not affiliated with or endorsed by Anthropic. No telemetry.
