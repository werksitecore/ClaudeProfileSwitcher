# Builder brief: shared storage (0.0.13)

**Specification:** `docs/STORAGE_ARCHITECTURE.md` (architect-approved). Implement it exactly. Raise any deviation as an
open question; do not redesign.

## Files you own
- `src/history.js`: change the backup model, add the link exception and the real-path no-op guard, and take the
  store-wide lock for pool destinations.
- `src/storage.js` (new): paths and the switcher root, the store-wide lock, the object store and manifests
  (retention, pinning, GC), analysis, the preview report, migrate, rollback, cleanup, verify, process detection.
- `src/cli-continuation.js`: pool-wide `assertDestinationAvailable` (small change).
- `src/extension.js`: the `claudeProfiles.storage` (Manage Storage) command, plus small changes so that existing calls
  keep working.
- `package.json`: register the command and add the new file to `check`. **Do not change `version`.**
- Tests: `test/storage.test.js` (new), and updates to `test/history.test.js` and `test/cli-continuation.test.js`.

Do not touch: `downloads/`, `tools/`, the existing docs (except a short README section on storage), CHANGELOG,
anything outside the repository.

## Hard rules
- **Never read or modify the user's real data** (`~/.claude`, `~/.claude-profile-switcher`). Every function takes its
  roots as parameters; the switcher root defaults to `~/.claude-profile-switcher` only inside `extension.js`. Tests
  use temp folders under `.test-tmp/` (the existing pattern) and create junctions there (`fs.symlink(t, p,
  'junction')`, no admin needed).
- Dependencies: Node built-ins only. CommonJS. Follow the existing code style (compact, comments explain *why*).
- Never use a recursive remove on a path that may be a junction. To remove a link, `lstat` it first and then unlink or
  rmdir the link itself.
- Any write that can fail part-way uses a temp file next to the target, then a rename.
- Destructive steps (cleanup, discarding pinned manifests, releasing a stale lock) only happen behind an explicit
  modal confirmation in the UI. Library functions require a `confirm: true` argument.
- Do not commit.

## UI
Use quick picks, modal warnings and a read-only Markdown report (`openTextDocument({ content, language: 'markdown'
})`), consistent with the existing commands. The Manage Storage quick pick shows the six metrics (total, shared,
profile, backup, duplicate, recoverable) as rows, followed by the actions listed in section 4 of the specification.
Migration selection is a multi-select of non-Default profiles. The `cleanupPeriodDays` acknowledgement is a modal.

## Tests required (in addition to keeping all existing tests passing, updated deliberately where the model changed)
- Switching between pool profiles copies nothing (no files written; storage size unchanged after 20 switches).
- Copy-based switching: no `incoming` snapshot; a prefix `previous` is not stored; a diverged `previous` is stored
  once (dedup) and pinned; nothing is left in `stage/`.
- `safe()`: accepts only the exact managed junction; rejects a wrong target, a deeper link, `projects` → `shared/file-history`, a link inside `shared/`.
- Analysis: identical, prefix and diverged groups; case-folded paths; truncated last line reported; byte counts.
- Migrate: credentials and settings untouched; listing through the junction matches; simulated interruption at each
  journal step can resume or roll back; refusal when a live PID is present; EEXIST rollback; re-hash mismatch abort.
- Rollback: the four per-file cases, a rebuild after cleanup, and the `shared/` target surviving the junction removal.
- Cleanup: never deletes the only copy (unique backup content moved to the object store first), skips locked
  profiles and non-committed manifests, and refuses without `confirm`.
- GC: pinned manifests survive retention; the newest manifest per session survives; unreferenced objects are removed.
- Stale lock: blocks; is released only for a dead owner with confirm.

## Hand-off
Report: files changed, functions added, tests run with pass/fail counts (`npm test`, `npm run check`), deviations,
limitations and open questions.
