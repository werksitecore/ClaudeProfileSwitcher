# Workstream 4: Profile-level storage cleanup and retention (queued)

## Extension (user, 2026-11-20): automatic and manual retention per profile
This adds to the brief below; on any conflict, it wins.
- **Ordering:** the user asks for "Profile Settings" to live in the existing profile UI, with no standalone storage UI.
  So the Profiles panel, sidebar and status-bar menu (`PROFILES_UI_BRIEF.md`) become **workstream 3**, and this
  becomes **workstream 4**, built inside them.
- **Depends on the open architecture decision** (`STORAGE_ARCHITECTURE.md` section 5c): what "referenced by another
  profile" and "authoritative copy" mean depends on it.
- **Profile Settings → "Conversation & Storage Retention", per profile:**
  - Automatic Cleanup: **off by default**. Existing users must opt in, and nothing is deleted when the feature
    arrives.
  - Delete Conversations Unused For: 30 / 60 / 90 / 180 / 365 days, or custom.
  - Clean Redundant Backups (on or off).
  - Clean Temporary Files (on or off).
  - Last Cleanup.
  - **Analyze & Clean Now**.
  - A separate **Clean Temporary Files & Backups** action that never deletes unique conversations.
- **Last activity:**
  - It is the latest of these:
    - the last record timestamp inside the transcript;
    - the file's modification time;
    - the last time this extension resumed or switched to the session.
  - **Conservative:** the latest value wins, so a resumed conversation is kept.
  - If no record timestamp can be read, the conversation is **excluded from automatic deletion** and shown as
    "activity unknown" in manual cleanup.
- **Manual flow:**
  1. Analyze.
  2. Candidate list with last activity and size; the user unticks what to keep, or marks it **Protected**
     (persistent).
  3. Warning.
  4. Typed `DELETE`.
  5. Run.
  6. Verify.
  7. Space actually recovered.
- **Automatic runs:**
  - Triggered on activation, or on a schedule; never on a switch.
  - Incremental: it reuses cached per-session metadata instead of a full scan.
  - Skips live sessions and files modified in the last few minutes.
  - Excludes Protected and uncertain conversations.
  - The **first run after enabling needs confirmation** (an approved-policy record). Later runs follow the approved
    policy.
  - Each run is journaled; results go into Last Cleanup and the Output channel.
- **Interaction with Claude Code's own sweep:**
  - Claude deletes a profile's conversations after `cleanupPeriodDays` (default 30) regardless of this setting.
  - The UI must show the profile's effective Claude retention next to the extension's setting.
  - Retention longer than Claude's has effect only if the chosen architecture keeps an archive copy, or if the user
    raises `cleanupPeriodDays` (a documented setting).
- **Backup retention:** independent of conversation retention, and already implemented (deduplicated store,
  retention, pinning, migration and rollback snapshots protected). Automatic cleanup also runs GC.

Requested by the user on 2026-11-20. Starts after workstream 1 (shared storage, in validation) and workstream 2
(automatic initialization and shared configuration). Reuses `src/storage.js` (assertPlainPath, long-path-safe file
operations, the recovery store, manifests, journal, locks, process detection). **No redesign; no duplicated logic.**

Workflow (user instruction for this feature): builder → reviewer (code, security and architecture in one review) →
builder fixes → tester. No parallel agents.

## Fit with decision 11 (conversations private per profile)
- A profile's `projects/`, `file-history/` and `image-cache/` belong to that profile alone. Deleting them never
  changes another profile's files.
- The data that **is** referenced across profiles:
  - the **recovery store** (`backups/objects`), whose objects are referenced by manifests from several profiles;
  - **shared configuration** (`agents/`, `skills/`, `commands/` and the shared `CLAUDE.md`).

  Cleanup is reference-aware for the store (an object is removed only when no remaining manifest references it) and
  never touches shared configuration.
- If the dormant shared-history layout is ever found (a junction), that profile's conversation categories are hidden
  with an explanation. Nothing inside `shared/` is cleaned per profile.

## Categories (shown only when supported safely)
| Category | What exactly | Risk | Confirmation |
|---|---|---|---|
| Temporary files | Switcher leftovers in this profile: `*.tmp-<uuid>`, `.old-*` entries not tied to a recovery marker, legacy `.profile-switch-backups/*/stage` | Low | Modal |
| Redundant backups | This profile's legacy `.profile-switch-backups` content that is kept elsewhere (existing Clean rule, scoped to one profile); unique content is moved to the recovery store first | Low–Medium | Modal |
| Duplicate session copies | **Not shown.** With private storage, a copy in another profile is that profile's own; removing this profile's copy would delete it from this profile's history. Covered by "Old conversations" instead | – | – |
| Old conversations | The transcripts of this profile older than 30, 60 or 90 days or a custom date, chosen from a list. Each session's bundle (transcript, `subagents/`, `file-history/<id>`, `image-cache/<id>`) is deleted together | High | Modal plus typing `DELETE` |
| All profile conversations | Every transcript bundle in this profile | Critical | Modal plus typing `DELETE` |

- **Age** is shown and selected by the transcript's last-modified time, and the list shows that date. Nothing is
  deleted automatically by threshold; the user starts every run.
- Conversations are deleted with **no copy in the recovery store** (this is the point of the action). The dialog says
  so plainly. It names other profiles that hold a copy of the same session ID ("still available in Work"), but
  never treats that as permission.
- Credentials, `.claude.json`, `settings.json`, `plugins/`, `sessions/`, `agents/`, `skills/`, `commands/`,
  `CLAUDE.md`, policy files and Claude's own state files are never candidates (an allow-list of categories, not a
  deny-list).

## Active profile and active sessions
- Analysis is always read-only and allowed.
- Temporary files and redundant backups may be cleaned while Claude runs, except files that a live process
  registered in `sessions/<pid>.json` refers to.
- Conversation categories require that no Claude process uses this profile: no live PID in its `sessions/`, plus the
  process scan. The dialog says what to close. Claude is never terminated.
- The session IDs of live processes are excluded in every case.

## Execution
1. Read-only analysis per profile: the categories, the files, and the bytes per category.
2. Selection.
3. Confirmation dialog in the user's example format, using the existing report → notification → modal gate. For
   conversation categories, an input box where `DELETE` must be typed.
4. Under the store lock: revalidate ownership, references, active use and `assertPlainPath` per file.
5. A journaled run (`profile-cleanup.json`, done entries only), cancellable before the first deletion, with a file
   count shown as progress.
6. File-level errors are reported, not fatal.
7. Afterwards: GC of unreferenced objects, Verify, and recalculated sizes, with a report of the space actually
   recovered.

An interrupted run resumes from the journal or is abandoned. Already-deleted files are recorded; nothing is half
deleted, because each bundle file goes away by unlink and the journal records it.

## UI
- **Global Manage Storage:** a per-profile table (exclusive storage, shared references, reclaimable, last cleanup).
  Shared references are the profile's share of recovery-store objects it references, plus shared configuration,
  counted once in totals. Selecting a profile row opens that profile's storage management.
- **Per-profile entry:** "Claude Profiles: Manage Profile Storage" (choose a profile), plus a "Manage Storage"
  item in the Profiles panel, sidebar and status-bar menu once workstream 4 exists.
- **Last cleanup date:** stored per profile in `storage.json`.

## Tests
- per-profile cleanup;
- **cleaning profile A cannot remove data required by profile B** (shared store objects referenced by B's
  manifests, B's identical and diverged copies, shared configuration);
- different versions across profiles;
- selected old conversations, with exact bundle removal;
- active-session protection;
- paths over 260 characters;
- interrupted cleanup resume;
- accounting without double counting;
- confirmation gating, including `DELETE`;
- unrelated profiles byte-identical before and after.
