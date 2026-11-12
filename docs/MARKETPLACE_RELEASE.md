# Marketplace release preparation

Status: **not submitted**. Evidence date: 2026-11-08. Observer: Codex.

## Publisher setup

1. Sign in at https://marketplace.visualstudio.com/manage with your Microsoft account.
2. Create or select your publisher. Suggested display name: **WerkSitecore**; suggested ID: `werksitecore`, subject to availability.
3. Confirm the exact ID before replacing `local-prototype` in package.json.
4. For GitHub OIDC publishing, create a Trusted Publishing policy with repository owner `werksitecore`, repository `ClaudeProfileSwitcher`, workflow `publish.yml`, and no environment unless one is configured in the workflow.

Reference: https://code.visualstudio.com/api/working-with-extensions/publishing-extension

## Release gates

| Check | Status | Evidence / next step |
| --- | --- | --- |
| Publisher ownership and exact ID | Unverified | Requires Microsoft Marketplace account access. |
| Package metadata | Fail | Publisher is still the local placeholder. |
| Source tests | Pass | 15 tests passed for 0.0.5; see VALIDATION.md. |
| Installable VSIX | Pass | Packaged locally with vsce. |
| Default → second account → Default | Unverified | Verify account identity in panel and CLI. |
| Same conversation after switching | Unverified | Verify live sidebar/editor restoration and CLI resume. |
| Original and destination history backups | Pass for fixtures | Actual account/session run remains unverified. |
| Migration from local prototype identity | Unverified | Changing publisher changes extension ID/storage. Export/import or document recovery of existing profile registrations before installing the Marketplace build. |
| Privacy and support information | Prepared | PRIVACY.md and repository issue tracker. |
| Marketplace listing and installation | Unverified | Only verifiable after submission. |

Keep required unverified checks visible. A packaged VSIX is not proof of successful account switching or Marketplace availability. Publish the initial listing as a preview once the account and runtime checks are resolved.
