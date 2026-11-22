# Workstream 3: Profiles panel, sidebar and status-bar menu (NEXT after 1b, user decision 2026-11-22)

**Order:** 1b → **this** → workstream 2 (automatic setup and shared agents) → workstream 4 (on hold).

**Reference:** a side panel Copilot built on 2026-11-21, saved in
`.local-backups/copilot-2026-11-21/` (`src/profile-ui.js`, its `extension.js`, `package.json` and `README.md`).
It is a reference only:
- Reuse ideas, not code, unless the code passes review.
- It must not bring back the rejected shared-folder migration (decisions 11 and 12).
- Storage actions must call the existing Manage Storage functions (Optimize Storage and the others).
- Per the brief below, the panel adds the "Optimize Storage" action and the storage metrics.

# Original brief: Manage Profiles panel

User decisions (2026-11-20):
- Form: a **webview panel** ("Claude Profiles"), opened by a new command `claudeProfiles.manage` and from the
  status-bar menu.
- Remove profile: unregister it, and **offer to delete its folder too** after a second confirmation.
- **Both views:** the webview panel above, and a **sidebar view**: an Activity Bar container "Claude Profiles" with
  a tree view. Both show **storage utilization**.

## Status-bar item ("Claude: <profile>")
- **Hover:** a rich tooltip (`MarkdownString`, trusted only for this extension's own `claudeProfiles.*` command links,
  each with validated arguments). It shows:
  - the current profile and the storage summary (total and recoverable), and
  - clickable options: each other profile ("Switch to X"), Add Profile, Manage Profiles (panel), Manage Storage, Open
    CLI with Profile.
- **Click:** a quick-pick menu with the same options, grouped with separators:
  - the profiles (current marked), then
  - Add Profile, Manage Profiles, Manage Storage, Open CLI, Sign In.

  Picking a profile runs the existing switch flow unchanged.
- The status-bar label and its accessibility label say what clicking does, for screen readers.
- Profiles section: one row per profile with the Current marker, the shared-pool badge and the folder size. Inline
  actions: Switch and Sign In. Context menu: Open CLI, Rename, Reveal Folder, Remove. Title-bar buttons: Add Profile
  (`+`), Refresh, and Open Panel.
- Storage section: rows for total, shared, profile, backup, duplicate and recoverable, plus a per-profile breakdown
  that can be expanded. Clicking a row opens the panel's storage section. Storage actions are in the section's
  context menu.
- Both views use the same data provider and the same command handlers. An action in either view refreshes both.
- Sizes are computed asynchronously and cached, with a "Calculating…" state and a manual Refresh. A full hash
  analysis only runs on Analyze Storage, never on view open.

## Scope
- A table of profiles: name, Current marker, a sign-in state read from Claude's own files (no token contents are ever
  read or shown), shared-history membership, and folder size.
- **Add Profile** form: name only, with the same validation as the `create` command. After adding, a Sign In action
  for the new profile.
- Row actions: Switch, Sign In, Open CLI, Rename, Reveal Folder, Remove.
- Remove:
  - Default and the current profile cannot be removed.
  - The first confirmation unregisters the profile.
  - The optional second confirmation deletes the folder. It is refused when the profile is in the shared pool (roll
    back first), has a `.profile-switch-lock`, has a live process, or holds a conversation that exists nowhere else
    (checked with the storage module's only-copy rule).
  - Deletion never follows junctions.
- A storage section on the same page shows the six metrics, with buttons that run the Manage Storage actions (reuse
  `src/storage.js`, no duplicated logic).
- Design: VS Code theme tokens only (`--vscode-*` CSS variables), so the panel follows light, dark and high-contrast
  themes. Native-looking buttons, keyboard accessible, readable at narrow widths. A strict CSP with a nonce and no
  remote resources. Messages from the webview are validated, and profile IDs are checked against the saved registry
  before any action runs.

## Roles
Architect (pre) → builder → reviewer → designer → security (webview message handling, folder deletion) → architect
(final) → tester.
