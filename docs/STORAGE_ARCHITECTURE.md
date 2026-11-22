# Shared storage architecture

Status: design for 0.0.13. Date: 2026-11-20.

## 1. Findings (Phase 1)

### Measured storage (read-only scan, 2026-11-20)

| Profile | Total | Backups `incoming` | Backups `previous` | `stage` leftovers | `projects` | Snapshots |
|---|---|---|---|---|---|---|
| 3e830fe1 | 5.02 GB | 2.21 GB | 1.57 GB | – | 1.20 GB | 49 |
| 411fcf92 | 12.30 GB | 5.69 GB | 5.36 GB | 0.13 GB | 1.05 GB | 209 |
| b7fc4b6e | 5.09 GB | 2.25 GB | 1.60 GB | – | 1.20 GB | 57 |
| cf0c04bd | 15.05 GB | 7.12 GB | 6.58 GB | 0.06 GB | 1.20 GB | 241 |
| **Total** | **37.45 GB** | **17.27 GB** | **15.11 GB** | **0.19 GB** | **4.65 GB** | **556** |

4,211 `.jsonl` files, of which 3,914 are extra copies of a file with the same name and size elsewhere (26.8 GB).
Backups are 87% of all storage. Live transcripts are ~1.2 GB of unique data held four times.

### How the current implementation stores data

Each profile is a complete `CLAUDE_CONFIG_DIR` (`~/.claude-profile-switcher/profiles/<uuid>`). Claude Code keeps
everything under that directory: `.credentials.json` (OAuth tokens), `.claude.json` (account, onboarding, per-project
trust), `settings.json`, `CLAUDE.md`, `agents/`, `skills/`, `plugins/`, `projects/<project>/<session>.jsonl` and
`<session>/subagents/…` (transcripts), `file-history/<session>/` (checkpoints), `sessions/<pid>.json` (live process
registry), `shell-snapshots/`, `session-env/`, `history.jsonl` (prompt history). Claude Code has no supported setting to
relocate `projects/` separately from the configuration directory.

### Root cause of the duplication

`history.transferSession` (called for every changed conversation on every switch, from `quickSwitch`,
`followAccountChange`, `switchCliTo` and Advanced Switch):

1. Writes a full **`incoming`** snapshot of the source transcript and sidecars. This duplicates data that is still
   intact in the source and, after commit, in the destination.
2. Writes a full **`stage`** copy, then renames it into place (leftovers remain when a transfer stops part-way).
3. Moves the destination's old version to **`previous`**. Transcripts are append-only, so the old version is almost
   always a byte prefix of the new one and contains nothing the new one lacks.
4. Never deletes any snapshot. A transcript that grows between switches is stored again in full each time, in both
   `incoming` and `previous`. With 0.0.11+ every project's changed conversations are carried on every switch, which
   multiplied snapshot growth (a 75 MB transcript switched 20 times ≈ 3 GB).

Separately, each profile holds its own full copy of every carried transcript (the copies themselves are by design:
each profile is a separate `CLAUDE_CONFIG_DIR`).

### What genuinely needs isolation

| Data | Decision | Reason |
|---|---|---|
| `.credentials.json`, `.claude.json`, `policy-limits*`, `remote-settings*` | **Isolated** | Tokens, account ID, org policy, subscription state |
| `settings.json`, `CLAUDE.md`, `agents/`, `skills/`, `plugins/`, `dev-mods/` | **Isolated** | Account-specific settings (they already differ per profile) |
| `sessions/`, `session-env/`, `shell-snapshots/` | **Isolated** | Per-process live state; CLI continuation reads `sessions/<pid>.json` per profile |
| `history.jsonl`, `cache/`, `telemetry/`, `backups/` (Claude's own) | **Isolated** | Small; not worth the risk |
| `projects/` | **Shareable (opt-in)** | All duplicated transcripts live here |
| `file-history/` | **Shareable (opt-in)** | Checkpoints keyed by session ID, carried today with each session |
| `image-cache/` | **Shareable (opt-in)** | Carried with each session today; must keep following it when transfers stop |

### Active sessions and concurrency

Claude Code is assumed to append to transcripts with open/write/close calls, so **no open handle can be relied on** to
block a directory rename during migration. A process that appends between the rename and the junction would write
into a different version of its conversation. Migration and rollback therefore require that **no Claude process is
running at all** (see section 3). `sessions/<pid>.json` alone is not enough, because panel chats in other windows and
CLIs started outside the extension may not register there. Within one profile Claude Code already supports many concurrent
processes writing to one `projects/`. Sharing makes several profiles behave like that one profile. Opening the **same**
conversation in two processes at once is the same risk as in a single profile today, and the existing
`assertDestinationAvailable` check still blocks it for managed CLIs.

## 2. Architecture (Phase 2)

```text
~/.claude-profile-switcher/
├── profiles/<uuid>/            account-specific CLAUDE_CONFIG_DIR (unchanged)
│   ├── projects   ──junction──▶ shared/projects        (only for profiles that joined)
│   ├── file-history ─junction─▶ shared/file-history
│   └── image-cache ──junction─▶ shared/image-cache
├── shared/
│   ├── projects/               one authoritative copy of each transcript
│   ├── file-history/
│   └── image-cache/
├── backups/
│   ├── objects/<sha256>        content-addressed, deduplicated recovery store
│   └── manifests/<id>.json     one per transfer/migration, with retention or pinned
├── .storage-lock/              store-wide lock (mkdir), held across windows
└── migration.json              migration journal (resume / rollback)
```

**Default profile.** The Default directory (`~/.claude`) is also used by tools outside this extension (plain CLI,
other IDEs) whose processes cannot be detected reliably. In 0.0.13 Default cannot join the pool. It keeps copy-based
switching with the new backup model.

**Mechanism: NTFS directory junctions** (`fs.symlink(target, path, 'junction')`). They need no administrator rights or
Developer Mode, are followed transparently by Node and by Claude Code, and keep Claude's file formats untouched.
Symbolic links (need privilege), hard links (one inode: Claude's appends would also rewrite the preserved originals
and rollback copies) and a single shared `CLAUDE_CONFIG_DIR` with swapped credentials (breaks the concurrent
panel/CLI accounts this tool supports, merges `.claude.json`) were rejected.

**Opt-in and ownership.** Sharing is chosen per profile during migration. A profile that did not join keeps a private
`projects/` and continues to use the existing copy-based switching. Whether a profile has joined is read from the
filesystem (a junction pointing into `shared/`), so there is no settings state to drift. Joining is an explicit statement
that these accounts belong to the same person and may read each other's conversations, which is what switching already
does today when it copies them. Work and personal accounts under different policies should stay out of the pool.

**Link safety.** `history.safe()` keeps rejecting links. The only exception is a link that meets all three conditions:
it is exactly `<profileRoot>/{projects,file-history,image-cache}`; its real path equals `<switcherRoot>/shared/<same
name>` (compared case-insensitively on Windows after removing a `\\?\` prefix); and no other link exists above the
profile root or below `shared/`. Any other link is still rejected.

**Switching (guard in `history.js`, so every caller is covered).** `transferSession`, `transferWorkspace`,
`transferEach` and `pendingSessions` resolve the real path of `projects` for source and destination. When the two are
equal, they copy nothing and return a no-op result. Only the `CLAUDE_CONFIG_DIR` setting changes, and chats restart as
today. When the destination resolves into `shared/`, the transfer takes the store-wide lock instead of the profile lock.
When the destination is in the pool, `assertDestinationAvailable` checks `sessions/` of **every** pool member. While
`migration.json` shows a run in progress, every transfer refuses to run.

**Backups (copy-based switching).**
- No `incoming` snapshot: the source is not modified and the destination is verified by hash after commit.
- The destination's previous version is checked per file across the whole session bundle (transcript, subagents,
  file-history, image-cache). A `.jsonl` that is a byte prefix of its incoming version, or any file identical to its
  incoming version, is not stored. Everything else, including files that exist only in the previous version, goes to
  `backups/objects` by SHA-256 (identical content is stored once).
- Staging goes to a temporary file next to the target and is renamed into place, so nothing is left in `stage/`.
- Retention: unpinned manifests older than `backupRetentionDays` (default 30) are removed. Objects no manifest references
  are then deleted. The newest manifest for each session is always kept.
- **Pinned manifests:** manifests that hold unique diverged content (a `previous` version that is not a prefix, and all
  migration manifests) never expire. They are removed only when the user discards them in Manage Storage.
- Every manifest and object write, and garbage collection, runs under the store-wide lock. A manifest is written before
  an existing object is relied on, so GC in another window cannot remove it.

**Cleanup safety rule.** A file may be deleted only when one of these holds:
- its exact content is in the object store, or
- its exact content is at a different live location, or
- for `.jsonl` only, it is a byte prefix of such content.

A "different live location" is never the file itself, or the same file reached through a junction (compared by real
path). Every deletion re-verifies the rule immediately before removing. Profiles with a `.profile-switch-lock`
(recovery pending) and manifests not in state `committed` are skipped.

**Claude's own cleanup.** Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30) from its
`projects/`. In a shared pool the shortest period among joined profiles deletes for all of them, and the pool holds the
only copy. The preview lists each profile's value, and migration requires an explicit acknowledgement of it.

## 3. Migration (Phase 4)

1. **Analyze (read-only):** every profile's `projects/` and `file-history/` and every `.profile-switch-backups`
   snapshot, hashed with SHA-256. For each relative path: identical copies, versions where one is a prefix of another
   (the longest supersedes), and **diverged** versions (neither is a prefix).
2. **Preview:** the dry-run report (current usage, profiles, duplicate files, recoverable space, files to migrate,
   diverged sessions, live processes, cleanup-period differences, risks). Nothing is changed.
   Relative paths are grouped case-folded on Windows, because project folder names derived from the cwd can differ
   only in case (`C--Git…`, `c--Git…`) and NTFS treats them as one directory. The canonical version is the longest
   byte-prefix chain. Crash-truncated last lines are reported, not rejected, and are copied byte-exact.
3. **Migrate (non-destructive, journaled):**
   - **Hard precondition (migrate and rollback):** Claude is stopped in every VS Code window and terminal.
     Concretely: no live PID in any selected profile's `sessions/`, and no running `claude.exe` (or
     `claude` / `node … claude`) process at all. When in doubt, the run refuses.
   - Copy the canonical version of each file into `shared/` (temp file + rename, hash verified). Diverged
     non-canonical versions go to the object store and are listed in a pinned manifest.
   - For each selected profile:
     1. Rename `projects`, `file-history` and `image-cache` to `<name>.pre-shared-<ts>`.
     2. **Re-hash the preserved folder against the analysis.** On any difference, rename it back and abort.
     3. Create the junction. If the name already exists (`EEXIST`, for example a directory created by a process in the
        meantime), roll back.
     4. Verify that the listing through the junction matches the plan.
   - Every step is journaled in `migration.json`. Nothing is deleted. An interrupted run resumes or rolls back from the
     journal.
4. **Rollback** (same hard precondition; journaled), per joined profile and per shared file, including file-history
   and image-cache:
   - Remove the junction only after `lstat` confirms it is a link, and only by unlinking the link itself (never a
     recursive remove). The `shared/` target survives.
   - Rename the preserved folder back. If cleanup already removed it, rebuild the private folder in full from `shared/`.
   - Preserved copy missing: copy the shared file in.
   - Preserved copy is a byte prefix (`.jsonl`) or identical: replace it with the shared file.
   - Diverged: keep the preserved copy, store the shared version in the object store (pinned manifest) and report it.
   - `shared/` is kept.
5. **Clean up (explicit confirmation, separate step):** delete `projects.pre-shared-*` folders and old
   `.profile-switch-backups` snapshots, file by file, applying the cleanup safety rule. Unique backup content is first
   moved into the object store.

## 4. UI (Phase 5)

The extension has no webview; its UI is commands, quick picks and notifications. A new command, **Claude Profiles:
Manage Storage**, shows the metrics (total, shared, profile, backup, duplicate, recoverable) in a quick pick, with the
actions Analyze Storage, Preview Migration, Migrate to Shared Storage, Clean Redundant Backups, Verify Storage
Integrity and Roll Back Shared Storage. Reports open as a read-only Markdown document. Verify Storage Integrity also
confirms that every junction target exists. A missing `shared/` would make Claude silently start with an empty
history.

## 5. Architectural decisions

1. NTFS junctions for `projects/`, `file-history/` and `image-cache/` of profiles that join; no symlinks, hard links or
   shared `CLAUDE_CONFIG_DIR`.
2. The "same real path → copy nothing" guard lives in `history.js`, not in the callers.
3. One store-wide lock (`.storage-lock`) serializes shared-store transfers, backup writes, GC, migration and rollback
   across VS Code windows.
4. Default (`~/.claude`) cannot join the pool in 0.0.13.
5. `.storage-lock/` records its owner (PID, start time, purpose). It is never released silently. Manage Storage offers
   to release it only when the owner PID is dead, and only after the user confirms. The per-profile
   `.profile-switch-lock` keeps its recovery-required behaviour.
6. Analysis covers `image-cache/` as well. A selected profile that lacks a shareable folder is journaled as
   "junction only", and rollback removes just the junction. The preview and the refusal name the Claude processes that
   were detected. (Superseded for completed migrations by decision 7.)
7. Decisions made during implementation (review round 1):
   - Every destination file a transfer stores (diverged, or present only in the destination) pins its manifest, so
     retention never removes unique content. Before an old destination version is removed, and before a failed
     transfer removes what it installed, the content is read again. Anything written in the meantime is stored under
     the pinned manifest first.
   - A pool transfer whose own rollback fails writes `transfer-recovery.json` in the switcher root. It blocks transfers
     that touch the pool, migration and rollback until the user resolves it in Manage Storage. The store lock is then
     released; it is kept only if the marker cannot be written.
   - Cleanup refuses while `migration.json` is unreadable or shows a run in progress. Undoing an interrupted migration
     renames the preserved folders back, and a missing preserved folder is rebuilt from `shared/`. Rolling back a
     completed migration also rebuilds a "junction only" folder from `shared/`, because the profile used shared content
     through it.
   - Journal entries are accepted only for folders under `<switcherRoot>/profiles` with known folder names.
   - Node processes whose command line cannot be read are listed in the preview and the refusal message, but do not
     cause a refusal on their own.
   - When a profile joins an existing pool and versions tie on prefix chain and size, the version already in `shared/`
     stays canonical.
   - Renames that replace a file are retried briefly on Windows `EPERM`/`EBUSY` (scanners hold new files open).
8. Security review: every write, rename and delete in storage code runs `assertPlainPath(root, path)` first. It checks
   that every component from the profile root, Default root or switcher root down to the path is a plain folder or
   file, and that the real path stays under the real root. Scans report links and never enter them. `shared/`,
   `backups/`, `backups/objects` and `backups/manifests` must be plain folders. A preserved folder is accepted only
   when it is a plain folder. Every source and hash in `migration.json` must lie in a listed profile's shareable or
   preserved folder or in `shared/`. Process rows keep only PID and name, never command lines.
9. Architect recommendations:
   - Clean Redundant Backups first shows a read-only preview (`cleanup({ dryRun: true })`): the files to delete, the
     unique content moved into the store, and what is skipped and why. The confirmation modal follows.
   - Retention runs (best effort) after Quick Switch, Advanced Switch, CLI switch and following another window's switch.
   - Unpinned manifests stuck in `prepared` with no objects expire after the retention period. The newest-per-session
     rule applies to committed manifests only.
   - While a migration prepares, `migration.json` carries a `preparing` marker with the owner PID, and the store lock
     names the migration. Copy-based transfers refuse when they see either, both at the start and right before
     staging. A marker from a dead PID is ignored, and the marker is removed if preparation stops before the run
     starts.
10. Accepted risks (security and review, 2026-11-20):
   - The checks are path-based. A process running as the same user could swap a path component between a check and
     the operation that follows it. Node has no handle-relative file APIs; the re-check sits immediately before each
     destructive call.
   - A Claude write that lands exactly between the target check and the install rename of a copy-based transfer can
     still be replaced. The precondition remains: stop Claude in both profiles.

## 5a. Release gates (user, 2026-11-20)

1. No further architectural redesign. Finish the current fix, then reviewer approval, then tester validation.
2. Before any migration is approved, every file operation must be shown to support Windows paths over 260
   characters: cleanup, migration, recovery and rollback.
3. The signed-in Claude CLI test must specifically validate Claude Code's own conversation retention and cleanup
   against shared storage. One profile must never delete or overwrite another profile's unique conversations,
   checkpoints or resumable sessions.
4. If Claude Code's native 30-day cleanup cannot be isolated safely, either disable cleanup for shared sessions
   through a **documented** mechanism or keep session storage private to each profile. Undocumented behaviour must
   not be relied on.
5. All 12 diverged conversation groups and all 85 diverged checkpoint files (real-data analysis, 2026-11-20) are
   preserved, including every unique version.
6. After all tests pass, provide the final dry-run results and ask the user for approval before any destructive
   migration or cleanup.
7. Fresh VSIX installs initialize shared storage automatically, and existing installs are offered a safe one-time
   migration (`docs/AUTO_MIGRATION_BRIEF.md`).
8. Complete only after the reviewer, the tester and the signed-in integration tests have all passed.

**Gate 8 deferral (user, 2026-11-20):** the signed-in integration test runs once, after workstream 1b, and covers
both workstreams. Until it passes and the user approves the final dry run, there is no release and no real cleanup or
migration on real data. The test must cover gate 3: Claude's own retention sweep in one profile must not delete
another profile's unique data. Until then, workstream 1 is recorded as **VALIDATED, signed-in test pending**, not
complete.

## 5b. Decision 11: conversations stay private to each profile (user, 2026-11-20)

The official documentation (settings reference `cleanupPeriodDays`, and "Explore the .claude directory" → "Cleaned
up automatically") states:
- Claude Code deletes transcripts, subagent logs, `file-history/` and `image-cache/` older than `cleanupPeriodDays` in a
  silent background sweep after any session starts;
- the minimum is 1, and `0` fails validation;
- no value disables the sweep;
- the age basis (modified time or last activity) is not documented;
- project and managed settings can override the value.

In shared storage, one profile's sweep would therefore delete conversations for every profile, and nothing documented
prevents it. Under release gate 4 the user chose to **keep conversation storage private to each profile**:
- `projects/`, `file-history/` and `image-cache/` are not shared. Manage Storage does not offer Preview Migration or
  Migrate to Shared Storage. The shared-history code stays in place but dormant (tested, never offered). Roll Back,
  Verify and recovery stay available.
- Storage is reduced by the new backup model (no `incoming`, no prefix `previous`, deduplicated recovery store,
  retention) and by Clean Redundant Backups for the legacy `.profile-switch-backups`. Real-data projection: about
  38.3 GiB → about 5.7 GiB.
- Switching keeps copying changed conversations, without backup growth (tester check 4).
- Sharing configuration (`agents/`, `skills/`, `commands/` and the `CLAUDE.md` import) is unaffected: none of these is
  covered by the sweep. It goes ahead in the auto-migration workstream.

## 5c. Decision 12: hard-linked working copies plus a compressed archive (user, 2026-11-20)

Supersedes decision 11's "private copies" and the junction-based history sharing. The user's goal is minimum
physical disk use with one authoritative copy of each unique version, isolated authentication, and protection from
Claude Code's documented cleanup sweep.

**Measured on the real data** (read-only; scripts `breakdown.js`, `archive-measure.js` and `hardlink-estimate.js` in the
session scratchpad):

| Option | Disk after cleanup |
|---|---:|
| Today | 38.26 GiB |
| Shared folder (junctions) | 4.28 GiB, rejected (one profile's sweep deletes for all) |
| Private copies, whole-file store | ≈ 8.6 GiB (estimate) |
| Private copies + compressed archive | ≈ 6.1 GiB |
| **Hard-linked working copies + compressed archive** | **≈ 2.9 GiB** (live 2.33 + archive 0.55) |

Inputs:
- Every distinct version: 10.14 GiB raw.
- Storing each JSONL line once: 1.28 GiB. Then zlib: 0.55 GiB.
- Live today: 5.56 GiB across 5 roots. With identical copies hard-linked: 2.33 GiB.
- Live paths with more than one distinct version: 24.
- Filesystem: NTFS (no block cloning).

**Design:**
1. **Working copies:** each profile's `projects/`, `file-history/` and `image-cache/` stay real, private folders that
   Claude Code uses normally.
   - When a conversation is carried to another profile, the destination gets an **NTFS hard link** to the same file,
     not a copy, provided the destination has no different version. If it does, the existing transfer rules apply.
   - Hard links need no administrator rights, and both names must be on the same volume (checked; otherwise the
     transfer falls back to a copy).
2. **Isolation:**
   - Deleting a name, whether by Claude's sweep, per-profile cleanup or the user, removes it from that profile only.
     Other profiles' names and the archive keep the data.
   - Appends through one name are visible through the others, which means one conversation, the same as
     continuing it.
   - A writer that replaces the file detaches that profile's name into its own file. The outcome is divergence, not
     loss, and the archive captures both.
   - Verified on this machine (hard-link probe, 2026-11-20).
3. **Archive** (`backups/archive`, outside every `CLAUDE_CONFIG_DIR`, so the sweep cannot reach it):
   - Immutable and content-addressed: JSONL versions are stored as a list of line hashes; lines and other files are
     stored once, compressed.
   - Every write is verified by rebuilding the version and matching its SHA-256 before anything that relies on it is
     deleted.
   - It replaces whole-file objects in the recovery store.
   - It captures changed working copies on activation, on switch and on a schedule (incremental, using a size and
     mtime index).
4. **Migration of today's data:**
   - Archive every distinct version (all 12 diverged groups and 85 checkpoints included).
   - Replace identical live copies across profiles with hard links. This runs under the existing Claude-stopped
     precondition, journal and rollback; each replacement is verified by hash and done by atomic rename.
   - Legacy backups are then removable by Clean Redundant Backups, because their content is in the archive.
5. **Accounting:** sizes are counted by file identity (`ino`), so hard links are never double counted.
6. **Unchanged:**
   - Credentials and account files are never linked or archived.
   - The `assertPlainPath`, lock and journal rules apply to every new operation.
   - The junction code stays dormant (decision 11) and is not offered.

Workflow: workstream 1 first finishes its current long-path fix with reviewer and tester. Then this becomes
**workstream 1b**: architect pre-review, builder, reviewer, security, architect final, tester, the signed-in
isolated test, the final dry run, and the user's approval before any destructive step.

### 5c amendments (architect pre-review, 2026-11-20; binding constraints for workstream 1b)

**0. Probe first.** Before any hard-link code is built, an isolated signed-in probe records the file identity
(bigint `dev:ino`) and whether the old content is a byte prefix of the new, before and after:
- a normal turn, `/compact`, `/rewind`, editing or forking a message, `/resume`, a title change;
- file-history and image-cache writes;
- the cleanup sweep.

Decision rule:
- Append only: link the file type.
- Temp file and rename: link it; the archive captures any divergence.
- Any in-place truncate or rewrite: that file type is **never linked** (recorded as decision 13).

Archive work may start before the probe.

**A. Archive.**
- **A1 Format:** append-only pack files of records `{hash, raw length, compressed data, CRC}`, compressed per block of
  64 KB to 1 MB.
  - A separate index (hash → pack, offset), rebuildable by scanning the packs.
  - Sealed packs are never rewritten.
  - The 0.55 GiB figure is re-measured with this format before it is reported.
- **A2 Versions:** a chunk is one line, byte-exact including its terminator (`\r\n`, or none on a truncated last line).
  - A JSONL version is a recipe: an ordered list of chunk hashes plus the whole-file SHA-256 and size.
  - Other files are whole-file chunks; images are stored raw when compression doesn't help.
  - A version that is a byte prefix of a newer captured version is dropped unless a manifest pins it.
- **A3 Write order:** pack, flush, index, flush, recipe, flush, then the manifest.
  - Before any delete, cleanup or link that relies on a version, rebuild it and match its SHA-256.
  - A torn pack tail is detected by CRC and ignored.
  - Verify checks CRCs plus a sample of rebuilds, or all of them on request.
- **A4 One engine:** the archive replaces `backups/objects` behind the existing API (`putObject`, `putObjectFile`,
  `objectValid`, manifests keyed by the whole-file SHA-256). history.js, cleanup, GC, `durableReferences` and the
  B1 rule stay unchanged.
  - Existing objects are moved in a journaled step: import, verify by rebuild, delete the object.
  - GC drops recipes no manifest references.
  - Compaction writes a new pack, switches the index, then deletes the old pack; journaled, under the lock.
- **A5 Retention:**
  - The newest version of every conversation the archive has seen is kept until the user discards it, even after
    Claude sweeps every working copy.
  - Diverged versions are pinned.
  - Versions that are a prefix of a newer version and older than `backupRetentionDays` are dropped.
- **A6 Restore or Export:** in the library and in Manage Storage. Temp file, verify, rename; never overwrites a
  different version. Show Backup uses it.

**C. Capture.**
- **C1:** the index is keyed by bigint `dev:ino` (size, mtime, last recipe). Linked names are captured once.
- **C2:** capture runs on activation, on switch and on a schedule, in batches under the store lock, releasing it
  between batches. It is read-only towards working copies; a partial last line is superseded by the next capture.
- **C3:** only the window that holds the store lock runs capture. The index is one atomically written file.

**M. Migration from today's private copies.**
- **M1:** archive every distinct version first and verify each by rebuild (gate 5).
- **M2:** link only SHA-256-identical files, never prefixes.
  - Each replacement: `fs.link(keeper, target.tmp-<uuid>)`, then `renameReplacing` over the target, then confirm
    the file identity and the hash.
  - Journaled, under the Claude-stopped precondition, the store lock and `assertPlainPath`.
- **M3:** the keeper is the name with the newest mtime, or the group's maximum mtime is set on it, so linking never
  makes a conversation look older to the sweep.
- **M4:** rollback materializes each name back into a separate copy (temp file, verify, rename), after a free-space
  check.
- **M5:** a single allowlist: only `projects`, `file-history` and `image-cache` are ever linked.

**T. Transfers.**
- **T1:** if the destination already has the source's file identity, the transfer does nothing, before any lock or
  backup.
- **T2:** install by linking the source to `target.tmp-<uuid>` and renaming it over the target. The aside, drift and
  preserve logic stays; preserve writes to the archive. The post-install check compares identity and content.
  Rollback removes names only.
- **T3:** fall back to a copy, reported in the switch result, on a different volume (compare `dev`; also handle
  `EXDEV`), on `EPERM`/`ENOTSUP` (FAT, network shares), on `EMLINK`, or when the folder is cloud-synced
  (flagged in Analyze).
- **T4:** after a carry, the profiles **share** the conversation. Advanced Switch and the README must say so.
- **T5 (security):**
  - Link only files `safe()` accepted inside the session bundle.
  - Refuse a file whose link count exceeds the names the index knows about (a planted hard link to a credentials
    file).
- **P1–P3 (concurrency):**
  - `assertDestinationAvailable` refuses when the session is live in **any** profile that holds a name for the
    same file.
  - The switch confirmation states the rule "never continue one conversation in two profiles at once".
  - The signed-in test measures the forced case.

**Accounting:**
- Every size counts each `dev:ino` once (bigint).
- The archive counts packs, index and recipes.
- A file with names outside the scanned folders is counted once and marked.

**7. Maintenance.**
- **N5:**
  - Scan `<profile>/{projects,file-history,image-cache}` and `shared/` for this extension's exact `.tmp-<uuid>`
    and `.old-<uuid>` names older than the threshold.
  - Skip profiles with `.profile-switch-lock` or a pending transfer-recovery entry.
  - An `.old-` entry goes through the full safety rule: archive first, delete only if covered.
- **N6:** cleanup runs in batches of one snapshot or about 30 s. Each batch locks, reloads durable references,
  stores, writes the manifest, deletes and unlocks. Progress and cancel are offered between batches.
- **N7:** a manifest-less snapshot is removable only when every file in it rebuilds from the archive under a pinned
  manifest, after an explicit confirmation per snapshot.

**Security review is required for 1b.** Probe results are stored as `docs/isolated-claude-write-pattern.json`.

### Decision 13: write-pattern probe result and no further isolated tests (user, 2026-11-20)

The probe ran with one isolated test account (Claude Code 2.1.329). It covered a normal turn, a file edit, a title
change, `/rewind`, editing an earlier message, `/compact`, exit and `--resume`, and an image session.

**Results:**
- Every transcript write (24 events) was an **append**: same file identity, and the old content a byte prefix of the
  new.
- There was no replace, truncate or in-place rewrite.
- `/rewind` and editing an earlier message wrote nothing at the time.
- A title change created `projects/<p>/<id>/custom-title.json`.
- No file-history or image-cache files were written in this run (the edit used a shell command, and newer versions keep
  images under the temp folder).

**Decisions:**
- `.jsonl` transcripts and subagent transcripts **may be hard-linked**.
- Everything else (`file-history/`, `image-cache/`, `custom-title.json` and any other non-`.jsonl` file) is
  **copied, never linked**, because its write pattern was not observed. These files are small: file-history is about
  0.03 GiB per profile.
- **Gate 8 is changed by the user:** there is no further isolated signed-in test, and the test probe folder and its
  sign-in were deleted.
  - Sweep isolation (gate 3) rests on two things: the documented behaviour that the sweep *deletes* old files, and
    the verified NTFS rule that deleting one hard-link name leaves the others.
  - The archive (outside every config folder) remains the safety net.
  - The tester covers the rest with synthetic tests: a sweep simulated as unlink, carry by link, concurrency guards,
    migration and rollback.
- Gate 6 is unchanged: the final dry run and the user's approval come before any destructive step.

### Decision 14: Default takes part in transcript linking (coordinator default, 2026-11-20; reversible)

Default (`~/.claude`) stays excluded from the dormant shared folder (decision 4), but it **is** included in transcript
linking and in Link Identical Conversations when it is on the same volume. The two cases differ:
- Decision 4 was about swapping whole folders while outside tools might be writing to them. Linking never swaps a
  folder.
- Linking existing copies requires every Claude process to be stopped (process scan).
- Every Claude process, Default's included, registers in its profile's `sessions/`, so the P1 guard covers Default.

Real-data finding (read-only, 2026-11-20): 8 live transcripts have a link count above 1. They are this session's
subagent transcripts, which Claude Code itself hard-links into `%TEMP%\claude\…\tasks\*.output`. T5 correctly skips
them until Claude Code removes those temp names.

### User approval (2026-11-21)
The user gave standing approval: "I approved so no approval required anymore". This covers:
- decision 14 (Default takes part in linking);
- the shared meaning of a carried conversation (T4);
- indefinite archive retention past `cleanupPeriodDays`;
- gate 6, the destructive run on real data.

The final dry run is still produced and shown, for information. The safety mechanisms are unchanged: the
Claude-stopped precondition, previews and journals.

### Incident: outside edits (2026-11-21 to 2026-11-22)
Another tool (GitHub Copilot chat), used between sessions, changed four files:
- `src/extension.js`: re-added the rejected shared-folder migration (`previewSharedMigration` and
  `migrateSharedStorage`, contrary to decisions 11 and 12), then cut the file from 991 to 578 lines, which removed
  Manage Storage and Optimize Storage. 30 tests failed.
- `package.json`: version 0.0.19, plus 13 commands.
- `README.md`.
- A new side panel, `src/profile-ui.js`.

It also built VSIX files 0.0.13 to 0.0.19 in `downloads/`.

Real data was checked read-only:
- No shared-folder migration ran: no junctions, no `migration.json`, no `.pre-shared-*` folders.
- No conversations were linked.
- The installed build (11:24) ran its background capture: an archive of 582 MB, incomplete. It left a stale
  `.storage-lock` (PID 36724, no longer running), which Manage Storage → Release Stale Storage Lock clears.

Recovery:
- `extension.js`, `package.json` and `README.md` were restored from the 11:24 build. It is byte-identical to the
  installed copy and contains the validated code; every other source file matched it exactly. The restored tree passes
  201/201.
- Copilot's files are kept locally in the git-ignored `.local-backups/copilot-2026-11-21/` as reference for the side
  panel (workstream 3).

> **Superseded by Decision 13 (user, 2026-11-20):** no further signed-in tests. The list below is kept for
> reference. The architect's final validation records which criteria rest on synthetic evidence only: sweep isolation,
> resuming across profiles, two profiles appending at once, Default's outside tools, real FAT/network/OneDrive
> fallbacks, Defender, the link limit, and the real-data outcome.

## 6. Signed-in validation after 1b (isolated test accounts, `docs/ISOLATED_LIVE_TEST.md` pattern; gates 3 and 8)

1. **Write-pattern probe (constraint 0):** a normal turn, `/compact`, `/rewind`, editing or forking a message,
   `/resume`, a title change, file-history and image-cache writes, and the cleanup sweep. For each, record the file
   identity and the prefix property.
2. **Carry by link:** A→B; B resumes the same session ID and appends; A sees one consistent conversation. B→A copies
   nothing.
3. **Sweep isolation (gate 3):**
   - Set B to `cleanupPeriodDays: 1`, age a linked conversation and start B.
   - B's name is deleted. A's name, A's checkpoints and A's ability to resume stay intact, and the archive holds the
     newest version.
   - Repeat with only A's copy old, and with a conversation that exists only in B.
4. **Concurrency:**
   - The guard refuses to open the same session live in A and B.
   - When it is forced through a panel chat, record the outcome and check that the archive captured both branches.
5. **Divergence:** a rewrite (if the probe shows one) detaches the names; both versions are archived and restorable.
6. **Restore:** export or restore a swept conversation from the archive and resume it.
7. **Migration and rollback on real-shaped data:**
   - Identical copies become one file identity, and accounting drops as predicted.
   - Rollback gives separate copies back.
   - Every diverged group and checkpoint rebuilds.
8. **Fallback:** a second volume or FAT/USB drive copies instead of linking, and the switch reports it.
9. **Accounts:** each profile keeps its own sign-in; credentials and `.claude.json` are never linked (checked by
   file identity).
