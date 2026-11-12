# Privacy

Claude Profile Switcher does not collect telemetry or send account credentials to a server.

The extension stores profile labels, local configuration-directory paths, and transfer metadata in VS Code extension storage. Claude Code manages account sign-in and credentials in its own configuration directories.

When you switch profiles, the extension copies saved conversations for the open workspace folders, session sidecars, and available checkpoint files into the destination profile. It retains backups of incoming and replaced history there. Conversation files can contain prompts, code, tool output, and other sensitive information. When you resume a copied conversation, Claude Code uses it under the destination account and that account's provider settings and policies.

Profiles and backups remain on your computer until you remove them. Uninstalling the extension does not delete them. Run **Claude Profiles: Restore Original Panel Configuration** before uninstalling to restore the panel setting.

The official Claude Code extension, CLI, VS Code, and any configured providers have their own privacy policies. This extension does not control their data handling.

Report issues at https://github.com/werksitecore/ClaudeProfileSwitcher/issues. Do not post credentials or private conversation files in public issues.
