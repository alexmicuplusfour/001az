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

- [x] **5. A post-drop restore failure leaves an empty instance running on an
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
  - [x] Pre-validate the extracted db members before touching the DB — the
    `verify` phase gunzips, parses, and counts every dump pre-drop.
  - [x] On post-drop failure, migrate forward (`initDb` + `seedAdmin`) so the
    instance comes back empty-but-consistent with the error in the job state.
  - [x] Automatic db-only safety backup before the wipe (`prerestore-*`, last
    two kept, pruned only after a successful restore; a failed safety dump
    warns and continues — a broken instance must stay restorable).

- [ ] **6. No integrity story.** The manifest records sizes and counts but no
  digests, and `readTar` doesn't verify header checksums. A flipped bit in a
  stored archive either fails at the worst moment (see #5) or restores a
  silently corrupt gallery file. **Fix:** per-member sha256 in the manifest —
  even just for the db members — is cheap insurance. *Progress: the verify
  pass now catches any corrupt DB member pre-drop (gzip CRC + full parse), so
  what remains open is file members (gallery/thumbnails/plugins) and header
  checksums.*

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
- [x] **14.** `loadTable` only compares row counts at EOF — a corrupt file
  claiming 10 rows but containing millions inserts them all (inside the txn)
  before failing; aborting as soon as `loaded > rows` bounds the damage.
  (Fixed twice over: the verify pass refuses a surplus pre-drop, and the load
  loop aborts within one batch as defense in depth.)
- [ ] **15.** `readTar` ignores PAX `size` records (only `path`), so a
  hand-repacked pax archive with a >8 GB member would desync the stream
  mid-parse; throwing on unknown PAX size records would fail loudly instead.
  The reader also doesn't verify header checksums (see #6).
- [ ] **16.** `collectFiles` silently drops symlinks — correct for
  server-owned state, but a plugin tree using symlinked deps would quietly
  lose content in a full backup.
- [ ] **17.** `setval(seq, GREATEST(max, 1))` on an empty table makes the
  first post-restore id 2 — harmless, just untidy.

## Round two (hardening deep dive, 2026-07-26, post-4dbc6b9)

- [x] **18. One oversized JSONL line OOMs the restore after the wipe.**
  `loadTable` reads through `readline` with no line-length bound
  (server/backup.js ~390-394); gzip expands ~1000:1, so a corrupt or crafted
  db member holding a single multi-GB line materializes the whole line as one
  V8 string before `JSON.parse` ever sees it — OOM / string-length throw
  mid-load, i.e. the #5 disaster path, reachable from a few MB of archive.
  Note the planned #5 pre-validation pass inherits the exact same hazard
  unless it bounds lines too. **Fix:** a tiny transform ahead of readline that
  aborts when bytes-since-last-newline pass a generous cap (say 64 MB).

- [x] **19. Cheap manifest refusals that currently fail post-drop.**
  `validateManifest` accepts: duplicate table entries (same file loads twice →
  unique violation inside the load txn), duplicate column names within a
  table, and negative `rows` (`Number.isInteger(-1)` passes; `rows: -1` skips
  the existsSync guard but not `loadTable`, which then ENOENTs — all after the
  drop). `loadTable` also trusts JSON cell values — a nested array/object
  rides through node-pg's serialization quirks instead of being refused.
  **Fix:** reject dup tables/columns and `rows < 0` in `validateManifest`;
  in `loadTable`, require every cell to be `string | null`.

- [x] **20. A manifest that omits tables restores them as silently empty.**
  The load checks every manifest table exists in the rebuilt schema
  (server/backup.js ~505-514) but never the reverse; a truncated table list
  (tampering, or a future dump bug) is silent data loss dressed as success.
  **Fix:** after the `upTo` rebuild, diff live table set vs manifest and
  refuse on any live table the manifest doesn't carry.

- [ ] **21. Every archive carries plaintext credentials; a full archive is
  also executable code.** *Progress: the restore dialog now warns that archive
  plugins run as the app (full archives) and README documents both hazards;
  passphrase encryption of archives remains open, tracked with the envelope
  encryption note in README's security section.* `ai_keys.api_key`, `source_connections` credentials,
  and alert `webhook_secret` are plaintext rows, so every archive — including
  the nightly auto-dump, on by default — is a complete secret-exfil artifact
  in /data/backups; download doubly so. The UI warning is good; consider
  optional passphrase encryption (even db members only). Separately: a full
  archive's `plugins/` tree plus its `external_plugins` rows is code the app
  loads on the post-restore boot — restoring an untrusted archive is arbitrary
  code execution by design. Say that in the restore confirm dialog, not just
  here.

- [x] **22. Restore resurrects every session and unspent invite in the
  archive.** *(Fixed for sessions: the load skips the table, so every
  pre-backup cookie stays dead. Invites are left restored deliberately — an
  invite spent after the backup resurrects alongside a user table that no
  longer holds the account it created, which is self-consistent, and pending
  invites expire on their own 30-day clock.)* Sessions are hashed at rest, but a restored `sessions` row
  re-arms any cookie minted before the backup — including sessions revoked
  since (logout-all after a stolen device, then restore from before = the
  thief is logged back in; same story for old invite/reset URLs). Everyone
  re-authenticates after a restore anyway. **Fix:** `TRUNCATE sessions` (and
  arguably expire pending invites) after the load, before COMMIT.

- [x] **23. `DROP SCHEMA` waits on locks forever — a straggler request turns
  restore into an indefinite 503.** The gate blocks new requests, not
  in-flight ones, and the worker drain races a 30 s timeout
  (server/backup-routes.js ~193-196) — anything still holding a table lock
  blocks `DROP SCHEMA public CASCADE` (server/backup.js ~489) with the whole
  instance gated. **Fix:** `SET lock_timeout = '15s'` on the drop client
  (retry once); converts a hang into a clean pre-drop refusal. Related: the
  failure path's `restartWorker` can launch a second worker while a
  timed-out drain is still mid-leg — benign today (the old loop exits at its
  next `running` check) but worth a comment.

- [x] **24. Nits.** Two concurrent uploads of the same filename both pass the
  `existsSync` check and the second rename silently clobbers the first;
  aborted uploads leave multer temps until the next boot (sweep is boot-only);
  auto-backup failures reach only the console — the app has an alerts/webhook
  subsystem that could carry them; `readNum` on garbage octal yields NaN and
  dies as a bare `Buffer.alloc` RangeError instead of "corrupt archive".
  (Fixed: atomic `link()` claim on upload, daily debris sweep with a 24 h age
  floor, named tar error. Accepted: auto-backup failure alerting stays
  console + the admin tab's job state — the alerts subsystem is per-board and
  user-configured, not a system channel.)

## Test gaps

- [x] The upload endpoint has no coverage at all (bug #2 lives there) — now
  covered: .TAR normalization, degenerate-name fallback, API reachability of
  minted names, refusal cleanup.
- [ ] `autoBackupSweep`: due-time math, retention pruning, claim-slot-first
  behavior — untested.
- [x] The post-drop failure path (#5) — untested. (Now the heal drill: the
  omitted-table test drives a post-drop refusal, asserts the forward heal,
  and restores the prerestore safety dump to win the state back.)
- [x] A db-archive restore onto a genuinely fresh instance (#1) — covered via
  the seeded source connection + post-restore insert in the replay test (the
  rebuilt schema's sequences start at 1 either way, so same-instance restore
  exercises the same collision).
