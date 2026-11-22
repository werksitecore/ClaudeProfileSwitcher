# Workstream 2: Automatic shared-storage initialization and migration

Queued: starts only after the shared-storage workstream has passed final validation. Reuse `src/storage.js` (analyze,
measure, migrate, resumeMigration, rollback, cleanup, verify, locks, journal); do not duplicate or redesign it.

Order of queued workstreams: 1. shared storage (in validation) → **2. this** → 3. Profiles panel, sidebar and status-bar
menu (`docs/PROFILES_UI_BRIEF.md`; it shows the migration status that this workstream produces).

## Superseding note: decision 11 (2026-11-20)
Conversation history stays private to each profile (`STORAGE_ARCHITECTURE.md` section 5b). In this workstream:
- **"Centralized storage" now means:**
  - the deduplicated recovery store and its retention (`backups/`);
  - `storage.json`;
  - shared configuration (`agents/`, `skills/`, `commands/`, the `CLAUDE.md` import);
  - **not** `projects/`, `file-history/` or `image-cache/`.
- **Fresh install:** create `backups/`, `shared/config/` and `storage.json`; new profiles join shared configuration.
- **Existing install:**
  - read-only analysis;
  - a one-time offer to clean legacy `.profile-switch-backups` (the existing Clean flow, behind confirmation);
  - the automatic shared-configuration join when every file is identical.
- Any text below about joining history or "Migrate to Shared Storage" is superseded.

Queue order: 1. shared storage (in validation) → **2. this** → 3. Profiles panel, sidebar and status-bar menu
(`docs/PROFILES_UI_BRIEF.md`) → 4. profile-level cleanup and retention (`docs/PROFILE_CLEANUP_BRIEF.md`).
Workstreams 2 and 4 wait for the architecture decision in `STORAGE_ARCHITECTURE.md` section 5c.

## User decision recorded (2026-11-20)
"New installations use centralized storage by default." This supersedes the opt-in default of
`STORAGE_ARCHITECTURE.md` for **newly created profiles**: Create Profile joins the pool by default, with a visible
"Keep this profile's history private" option. Unchanged:
- Default (`~/.claude`) still cannot join (reliability rule).
- Existing profiles join only through the approved one-time migration.
- Credentials and settings always stay isolated.

## Shared configuration (user decision, 2026-11-20)
The user's own working configuration is not account data, and keeping a copy per profile made it drift apart.
Profile `3e830fe1` had no role agents and no governance import, so sessions on it lost the governance. Add an
optional **"share my configuration"** set, separate from shared history, that profiles opt into:

| Item | Mechanism | Why |
|---|---|---|
| `agents/`, `skills/`, `commands/` | Directory junction to `shared/config/<name>`, using the same `managedLink` and `assertPlainPath` rules as history | Plain folders of user-authored files |
| `CLAUDE.md` | **No link.** The shared content lives in `shared/config/CLAUDE.md`, and each joined profile's `CLAUDE.md` gets one line `@<switcherRoot>/shared/config/CLAUDE.md` (Claude Code's supported import, already used for the governance file). Content that exists only in that profile stays below the import line | File links need privileges or break when editors replace files; the import is supported and visible |
| Never shared | `settings.json` (per-account options such as `cleanupPeriodDays`), `plugins/` (install state tied to `settings.json`), `.credentials.json`, `.claude.json`, policy and remote-settings files | Account-specific or unsafe |

- **Joining a profile:**
  - A file that is identical everywhere is kept once.
  - Where versions differ, the version already in `shared/config` wins; on first creation, the newest version wins.
  - Every other version goes into the recovery store under a pinned manifest and is listed in the preview. Nothing is merged inside a file.
- **Migration:** it reuses the existing journal, rollback and preview, and is offered alongside the history migration. The two are separate checkboxes.
- **New profiles:** a profile created with Create Profile joins shared configuration automatically, with no prompt.
- **Always on (user decision, 2026-11-20):** "once installed it should always do the shared agents".
  - On the first activation of each storage schema, every existing profile **and Default** joins shared
    configuration automatically, **when every version of every file is identical (hash-equal)**. Nothing is
    copied, so no data changes; the step is journaled and can be rolled back.
  - If any versions differ, it asks once and shows the differences. It never chooses silently.
  - A profile the user later removes from shared configuration stays out; this is recorded in `storage.json`.
- **Default joins configuration, not history:** the history-pool exclusion of Default does not apply to `agents/`,
  `skills/`, `commands/` or the `CLAUDE.md` import. These are read-mostly user files, not concurrently appended
  transcripts.
- **Governance installer:** `~/.claude/governance/install.sh` keeps working. Copying into `<profile>/agents/` lands in `shared/config/agents` for joined profiles. Verify Storage Integrity reports a joined profile whose `CLAUDE.md` lacks the import line.

## Storage schema
- `<switcherRoot>/storage.json`, written atomically: `{ schema: 1, state: "fresh" | "legacy-pending" | "migrated" |
  "postponed" | "declined-profiles", migratedAt, analyzedAt, analysis: <cached summary>, postponedUntil }`.
- Activation reads it once. A missing file plus no profiles means a fresh install: create `shared/` and `storage.json`
  (`schema 1, fresh`). A missing file plus existing profiles means `legacy-pending`. An unknown or newer schema means
  read-only mode, with a message.
- Migration runs at most once per schema version. Extension updates with the same schema never prompt again; a future
  schema 2 gets its own one-time step.

## Activation flow (existing install)
1. Never block activation. After activation, at low priority, run the size-only `measure()`. If the user doesn't
   cancel, then run the hashing `analyze()` in the background, throttled and cancellable. Cache the summary in
   `storage.json`.
2. A one-time notification shows the profile count, duplicate files and estimated recoverable space, with the
   buttons Preview Migration, Migrate…, Remind Me Later (postpones 7 days) and Don't Ask Again.
3. Migrate… uses the existing confirmed flow:
   - choose profiles, acknowledge `cleanupPeriodDays`, and pass the "Claude stopped everywhere" precondition;
   - when that precondition fails, the notice says exactly what to close and offers Retry, and nothing changes.
4. After migration, cleanup is offered separately and always behind confirmation.
5. Interrupted migration: on the next activation, the journal is detected and the user is offered Resume or Roll
   Back. Never act silently.
6. Status and errors: a status-bar state ("Claude storage: migration available / in progress / needs attention"), the
   Manage Storage report, and an Output channel "Claude Profiles" for errors.

## Migration safety
These requirements are already met by `storage.js`; this workstream must not weaken them:
- SHA-256 hashing.
- The canonical version is the longest prefix chain.
- Diverged versions are never merged; they are kept, pinned.
- The process precondition.
- Journal and rollback.
- Cleanup only with confirmation.

## Tests
- Unit tests:
  - fresh install;
  - legacy detection;
  - once per schema (an upgrade with the same schema does not prompt);
  - postpone and don't-ask;
  - an unknown schema is read-only;
  - interrupted migration on activation;
  - a new profile joins the pool by default;
  - the private option.
- Lifecycle in the isolated VS Code harness (`tools/isolated-vscode`): fresh install → create profiles → switch → restart
  → upgrade the VSIX (same schema) → verify integrity; storage stays stable over 20 switches.
- With real Claude (`docs/ISOLATED_LIVE_TEST.md`; needs dedicated test accounts): resume sessions through a junction.
- 35 GB legacy data: the read-only analysis on the real folder (safe). An actual migration on the real data only with
  the user's explicit go-ahead, with Claude closed. Alternatively, on a copy of the data with credentials excluded,
  if disk space allows.
