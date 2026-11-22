# Privacy

Claude Profile Switcher does not collect telemetry or send account credentials to a server.

The extension stores profile labels, local configuration-directory paths, and transfer metadata in VS Code extension storage. Claude Code manages account sign-in and credentials in its own configuration directories.

When you switch profiles, the extension carries saved conversations, session sidecars, and available checkpoint files into the destination profile. A carried transcript (`.jsonl`) becomes one file with a name in each profile (a hard link), so both profiles share that conversation; checkpoints, images and other files are copied. Versions that a switch would replace are kept in a local archive. Conversation files can contain prompts, code, tool output, and other sensitive information. When you resume a copied conversation, Claude Code uses it under the destination account and that account's provider settings and policies.

**The archive keeps conversations after Claude deletes them.** The extension keeps a compressed archive in `~/.claude-profile-switcher/backups/archive` and captures changed conversations into it in the background. It keeps the newest version of every conversation it has seen, from every profile including Default (`~/.claude`), even after Claude Code's `cleanupPeriodDays` cleanup or a managed or organisation policy would delete it, until you discard it in **Claude Profiles: Manage Storage**. If your organisation requires conversations to be deleted after a period, remove them there as well. **Analyze Storage** lists the cleanup periods set by managed or project settings.

To remove a conversation completely:

1. Delete it from every profile that has it. Otherwise the background capture archives it again.
2. In Manage Storage, choose **Restore or Export a Version**, pick the conversation, and **Discard** each of its archived versions. The result says whether a copy remains and what still keeps it.
3. Choose **Discard Pinned Backups** and discard every backup that still holds it. A version that only a backup holds has no Discard option of its own, because it is part of that backup: it is removed together with the backup.

Profiles and backups remain on your computer until you remove them. Uninstalling the extension does not delete them. Run **Claude Profiles: Restore Original Panel Configuration** before uninstalling to restore the panel setting.

The official Claude Code extension, CLI, VS Code, and any configured providers have their own privacy policies. This extension does not control their data handling.

Report issues at https://github.com/werksitecore/ClaudeProfileSwitcher/issues. Do not post credentials or private conversation files in public issues.
