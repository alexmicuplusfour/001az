# Backup & restore — deep-dive findings

Review of the backup/restore implementation (uncommitted work on top of
`9e1c79f`, 2026-07-26): `server/backup.js`, `server/backup-routes.js`,
`server/tarfile.js`, `public/admin-backups.js`, `test/backup.test.js`, plus the
touched files. The backup test suite passed 12/12 at review time. Items are
ordered by severity within each section; check them off as they're fixed.

Priority: #1 and #2 are small, certain fixes; #3/#4 make backups robust
against normal life; #5 is the one that turns a bad night into a disaster and
deserves the pre-validation pass.

## Bugs

- [x] **1. `source_connections` sequence never fixed after restore — next
  insert collides.** Every table uses `GENERATED ALWAYS AS IDENTITY` except
  `server/migrations/0019_source_connections.sql` (`BIGSERIAL`). Serial columns
  have `attidentity = ''`, so `tableColumns` marks them `identity: false` and
  the setval loop in `restoreBackup` (server/backup.js ~486-494) skips them.
  After a restore the sequence sits at 1 while restored rows occupy those ids;
  the app inserts without an explicit id (server/db.js ~1020), so the next
  "add source connection" throws duplicate-key until nextval grinds past the
  restored max. **Fix:** setval every column with an owned sequence
  (`pg_get_serial_sequence(...) IS NOT NULL`), not just identity columns.
  (The test harness desyncs only the entities/items sequences — that's why
  this slipped through.)

- [x] **2. Uploaded archives can become invisible, un-restorable, and
  un-deletable.** Upload accepts `/\.tar$/i` (`backup.TAR` passes) but the
  minted name must satisfy `ARCHIVE_NAME_RE`, which requires lowercase `.tar`
  (server/backup-routes.js ~25, ~141-153). Degenerate names lose the suffix
  entirely (`😀.tar` sanitizes to `uploaded-tar`). The upload reports success,
  but the file never appears in the list and can't be restored or deleted via
  the API — a permanent orphan in the backups dir. **Fix:** normalize the
  extension when minting and reject (unlink + 400) any minted name that fails
  `validName`.

- [x] **3. A file deleted mid-backup fails the entire backup.**
  `boundedStream` handles grow/shrink but not deletion: `createReadStream`
  ENOENTs and the whole archive dies (server/backup.js ~176-191); same for the
  `stat` race in `collectFiles` / the archive loop. Deletion mid-backup is
  real — the worker unlinks old derived files when regenerating
  (server/worker.js ~553-554). One regenerated waveform late in a 20 GB
  archive kills the run. **Fix:** treat ENOENT as full-length zero padding +
  warning, consistent with the shrink philosophy. Related: the header
  comment's claim that drift can never produce "a row pointing at a missing
  original" is inverted for deletions — a file removed between the DB snapshot
  and the file scan produces exactly that in the archive.

- [x] **4. Disk-full during a backup can crash the whole server, not just the
  backup.** In `dumpTable`, `done = pipeline(gz, out)` is only awaited at the
  end (server/backup.js ~120-142). If the write stream errors (ENOSPC) while
  the loop is awaiting a FETCH — or while `once(gz, "drain")` throws first —
  `done` rejects with no handler attached → unhandled rejection → process
  death on modern Node. Same family in `TarWriter`: the output stream has no
  `'error'` listener, so a write error can surface as an uncaught `'error'`
  event (server/tarfile.js ~88-92). **Fix:** attach a no-op `.catch()` to
  `done` at creation (the real error still propagates through the write path)
  and an error listener on the tar output stream.

## Restore failure path (biggest design gap)

- [ ] **5. A post-drop restore failure leaves an empty instance running on an
  old schema, with no error shown to anyone.** Load failures roll back the
  load transaction, but the drop + rebuild-at-`upTo` stands. On that path
  `initDb` never runs and `restartWorker` brings the worker back — so the live
  process (code expecting the latest migration) serves a database at the
  archive's older migration id; everything 500s until a reboot. Reachable by
  honest means: gzip corruption / bit-rot in a stored archive is only detected
  during load, after the wipe. The admin sees none of it — sessions were
  wiped, the status poll goes 403, the overlay says "server restarting", and
  they land on a login page for an empty instance; the error exists only in
  server logs (test file notes this blind spot). **Fixes, cheapest first:**
  - Pre-validate the extracted db members before touching the DB (streaming
    gunzip + `JSON.parse` + row-count check against the manifest — the data is
    already fully extracted in staging). Converts nearly every post-drop
    failure into a clean refusal.
  - On post-drop failure, still run the remaining migrations forward (or exit
    like the success path so boot's `initDb` heals it), instead of leaving
    old-schema + new-code serving.
  - Consider an automatic db-only safety backup before the wipe — the
    machinery already exists.

- [ ] **6. No integrity story.** The manifest records sizes and counts but no
  digests, and `readTar` doesn't verify header checksums. A flipped bit in a
  stored archive either fails at the worst moment (see #5) or restores a
  silently corrupt gallery file. **Fix:** per-member sha256 in the manifest —
  even just for the db members — is cheap insurance.

## Operational loose ends

- [ ] **7. `.old-` trees leak on every full restore.** `swapDir`'s `rm(old)`
  is fire-and-forget (server/backup.js ~393), and success exits the process
  1.5 s later — a large old gallery won't finish deleting. The debris lives
  next to the live dirs (`/data/gallery.old-ab12…`); the boot sweep only
  cleans the backups dir, so nothing ever removes it. **Fix:** await the
  removals before scheduling exit, and/or sweep `*.old-*` siblings of
  gallery/thumbnails/plugins at boot.

- [ ] **8. The EXDEV fallback isn't crash-safe and its assumption is
  undocumented.** If `BACKUPS_DIR` is on a different filesystem than the data
  dirs, every restore takes the non-atomic `cp` branch, and a mid-copy failure
  leaves the live dir partial with the old tree stranded under a random
  `.old-` name, no rollback (server/backup.js ~383-393). **Fix:** at minimum
  document "keep backups on the same volume"; better, roll back (remove
  partial copy, rename old back) when `cp` fails.

- [ ] **9. The nightly backup blocks worker maintenance, including once at
  boot.** `autoBackup` is awaited inline in the maintain loop
  (server/worker.js ~1696), so stuck-item recovery and ingest scheduling pause
  for the dump's duration — minutes on a big DB. `backup_auto_last` starts
  unset, so the first boot after this ships runs a backup within ~a minute of
  starting. **Fix (or accept):** own loop like embed/refresh, or document the
  behavior.

- [ ] **10. Schedule time is server-local TZ (container = UTC) and the UI
  doesn't say so.** An admin setting "03:30" gets 03:30 UTC. **Fix:** say
  "server time" in the label.

- [ ] **11. No free-space awareness anywhere.** Full backups write spool +
  archive into the same volume as the data (each archive ≈ another copy of the
  gallery), restores stage a full extraction, manual archives accumulate
  unbounded (retention only prunes `auto-*`), no preflight check. Disk-full is
  the most probable real failure and currently manifests as #4/#5. **Fix:**
  even a coarse "refuse if free < estimated size" would help.

- [ ] **12. During a restore the gate 503s `/api/health`,** so the compose
  healthcheck marks the container unhealthy mid-restore. Cosmetic under
  `restart: unless-stopped`, but anything health-gated (deploy scripts,
  monitoring) will see it flap.

## Nits

- [ ] **13.** Same-second backups silently overwrite: `stamp()` has 1-second
  resolution and the final `rename` clobbers an existing archive of the same
  name.
- [ ] **14.** `loadTable` only compares row counts at EOF — a corrupt file
  claiming 10 rows but containing millions inserts them all (inside the txn)
  before failing; aborting as soon as `loaded > rows` bounds the damage.
- [ ] **15.** `readTar` ignores PAX `size` records (only `path`), so a
  hand-repacked pax archive with a >8 GB member would desync the stream
  mid-parse; throwing on unknown PAX size records would fail loudly instead.
  The reader also doesn't verify header checksums (see #6).
- [ ] **16.** `collectFiles` silently drops symlinks — correct for
  server-owned state, but a plugin tree using symlinked deps would quietly
  lose content in a full backup.
- [ ] **17.** `setval(seq, GREATEST(max, 1))` on an empty table makes the
  first post-restore id 2 — harmless, just untidy.

## Test gaps

- [x] The upload endpoint has no coverage at all (bug #2 lives there) — now
  covered: .TAR normalization, degenerate-name fallback, API reachability of
  minted names, refusal cleanup.
- [ ] `autoBackupSweep`: due-time math, retention pruning, claim-slot-first
  behavior — untested.
- [ ] The post-drop failure path (#5) — untested.
- [x] A db-archive restore onto a genuinely fresh instance (#1) — covered via
  the seeded source connection + post-restore insert in the replay test (the
  rebuilt schema's sequences start at 1 either way, so same-instance restore
  exercises the same collision).
