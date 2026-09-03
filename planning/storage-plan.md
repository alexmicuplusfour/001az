# Storage — how full is the server, and why (2026-09-03)

**Status: STAGES 1–3 SHIPPED (2026-09-03). Stage 4 optional, not started.**
Self-contained for a fresh session. Written after a deep dive over every place
bytes accumulate, plus research into how other self-hosted apps surface storage
(Immich, Discourse, Nextcloud) and how the billing ecosystem models it (S3's
daily gauge, GB-month arithmetic). Each stage's section records what the build
corrected about the design — read those notes, not just the design.

## The problem

The app has no storage indication anywhere. Not a number, not a warning — the
only way to know how full the droplet is, is `ssh` and `df -h /`, which is
literally what [deploy.ps1:150](../deploy.ps1#L150) does after every deploy
because the question matters and nothing else answers it.

Disk is the one resource the app consumes that grows monotonically and fails
catastrophically. Every upload adds an original + a thumbnail forever; every
tagged item adds an embedding row; every night adds a backup tarball. When the
disk fills, Postgres stops writing, uploads 500, and the app may not come up
cleanly to be fixed — the classic self-hosted death. The droplet has 12G.

This matters double because the repo is public and headed for real open-source
use: strangers will run this on small VPSes, and today the app gives them no
warning at all. The Usage tab answers "what did the AI spend"; nothing answers
"how full is my server and why."

## The three jobs (what the research says a storage surface is FOR)

Surveyed: Immich's Server Stats page, Discourse's dashboard + its support
forum, Nextcloud's user management. Three jobs recur:

1. **See the disaster coming.** Discourse meta is littered with "Completely
   Out of Disk Space" / "disk too full to update" threads; its dashboard
   grew a disk indicator for exactly this. The headroom gauge — used, total,
   free — is the safety-critical piece.
2. **Know what's safe to delete.** A single total helps nobody (the meta
   thread is titled "Our disk space disappeared — how to find who/where?").
   The useful thing is the breakdown that separates the prunable (backups,
   thumbnails, caches, job logs) from the sacred (originals, the DB). The app
   already owns the levers — backup retention, snapshot/job-log retention
   envs — but nothing shows when to pull them.
3. **Who's the whale.** Immich and Nextcloud both show per-user storage. In
   this app's vocabulary that is per-board. Note the Nextcloud precedent:
   per-user numbers deliberately EXCLUDE thumbnails/metadata — "originals
   only" for attribution is standard practice, not a shortcut.

This is a **health/ops panel**, not a metering feature — which is why it gets
its own admin tab (decided 2026-09-03), not a section under Usage.

## Why this is not a meter (and 5e stays dropped)

[metering-plan.md](metering-plan.md) dropped Stage 5e with the right sentence:
bytes ingested is a **flow**; the question people ask — bytes held — is a
**level**, and an additive meter cannot answer a level. Deletes, prunes, and
recompressions all move the level without any meterable event landing.

The industry confirms the split: S3 reports storage as a **daily-sampled
gauge** (CloudWatch `BucketSizeBytes`, reported once a day) and computes
GB-month billing by time-averaging those levels — never by summing uploads.
Prometheus models disk the same way (gauges, not counters).

So storage is a third mechanism BESIDE the meter, with its own contract:
**the level, measured; its history, sampled.** It never writes `usage_meter`
rows, never touches `model_prices`, never stamps `cost_micros` — self-hosted
disk has no per-byte rate, and pretending otherwise would put a fake $ on the
one tab whose numbers are all real. (If S3-backed storage ever exists,
GB-month = time-average of the daily samples — the table below already
supports that arithmetic. Noted, not built.)

## Where bytes actually accumulate (the inventory)

Six places; no single vantage point sees them all:

| store | what's in it | measurable how |
|---|---|---|
| `/data/gallery` | originals, docx `.txt`/`.html` sidecars, generated face images ([faces/index.js:60](../server/faces/index.js#L60)) | fs walk |
| `/data/thumbnails` | item `.webp`s, face crops, waveforms, pdf pages — everything rides `thumbsDir/<name>.webp` | fs walk |
| `/data/backups` | tarballs + `.spool-*`/`.partial` debris | fs walk |
| `/data/plugins` | installed plugin code | fs walk |
| `/data/.npm` | plugin-install npm cache ([Dockerfile:41](../Dockerfile#L41)) — see the env trap in Stage 1 | fs walk |
| `pgdata` volume | the DB: per-item `embedding BYTEA` (KBs each, grows with every tagged item), tag/field snapshots, job_log, usage_meter | **invisible to the app's filesystem** — `pg_database_size(current_database())` over the existing pool |
| the disk | capacity + free | `fs.statfs` (Node 22, [Dockerfile:3](../Dockerfile#L3)) |

The DB row is the sneaky one: Postgres lives in its own container on its own
volume, so any filesystem-only answer silently omits it. `INGEST_ROOT` is
deliberately absent from the walk list: it is the user's own staging dir, a
bind mount outside `/data` — their files, not the app's holdings (`statfs`
still counts it against disk free, which is the honest total).

`statfs` runs against `GALLERY_DIR`'s filesystem. On the droplet both named
volumes live on the host root fs, so the one call reflects the disk that
actually fills; the plan accepts that a split-volume deployment would read
only the appdata volume's fs (a caveat for the tab's tooltip, not a blocker).

## What already exists to build on

- **Per-file sizes are already in the DB.** Every upload stamps
  `size: buf.length` into `payload.files[]`
  ([sources/image.js:92](../server/sources/image.js#L92)); legacy entries are
  enriched via `sources.metaFor`
  ([server.js:2055](../server/server.js#L2055)). Per-board originals =
  one SQL SUM over `items` grouped by `board_id`. No new bookkeeping.
- **The walk exists.** `collectFiles`
  ([backup.js:158](../server/backup.js#L158)) already recursively stats every
  regular file under a root, ENOENT races handled, missing root = empty tree.
  It is module-local today — promote it (export from backup.js), don't copy.
- **The daily slot exists.** The maintain loop runs self-gated sweeps
  ([worker.js:2745](../server/worker.js#L2745)); `autoBackupSweep`
  ([backup.js:771](../server/backup.js#L771)) shows the gating shape. The
  storage sample needs a simpler gate than backup's settings dance (no
  user-facing schedule): an in-memory day stamp, with the table consulted
  only at boot and rollover — details in Mechanism 1.
- **The tab shell exists.** `TAB_NAMES` + one nav button + one module import
  ([admin.js:21](../public/admin.js#L21),
  [admin.html:172-179](../public/admin.html#L172)); hash deep-linking comes
  free. Each tab module self-guards on `/api/me`.
- **A byte formatter exists — locally.** `fmtSize` in
  [admin-backups.js:13](../public/admin-backups.js#L13). Promote it to
  [utils.js](../public/utils.js) beside `fmtTok`/`fmtQty` and re-import it in
  the backups tab; do not write a second one.
- **The sparkline vocabulary exists** ([sparkline.js](../public/sparkline.js))
  for the trend drawing.

## Mechanism 1 — the gauge (`0042_storage_sample.sql`)

```sql
CREATE TABLE storage_sample (
  day    TEXT   NOT NULL,
  store  TEXT   NOT NULL,
  bytes  BIGINT NOT NULL,
  files  BIGINT,              -- NULL where counting files is meaningless
  PRIMARY KEY (day, store)
);
```

The contract is one sentence: **the level of `store`, as measured on `day`.**
Narrow rows, not columns — the meter's own lesson: a new store (an S3 bucket
someday, a new sidecar cache) is a row, not a migration.

`store` values: the five walked roots (`gallery`, `thumbnails`, `backups`,
`plugins`, `npm_cache`), `db` (pg_database_size; `files` NULL), and the disk
pair `disk_total` / `disk_free` (`files` NULL). The disk rows ride the same
table because they are the same kind of fact — a level on a day — and the
series reader would otherwise need a second query shape for them.

`measureStorage(db, dirs)` in a new `server/storage.js`: five `collectFiles`
walks (concurrent — independent I/O), one `pg_database_size` query, one
`fs.promises.statfs`. Returns `[{ store, bytes, files }]`; a sibling
`writeSample(db, dayKey, rows)` upserts — re-measuring a day refreshes it,
never doubles it. **A level is idempotent to record; that is the whole
difference from the meter, whose writes add.** Concurrent measures (tab open
at the exact maintain tick) land the same rows twice — harmless by the same
idempotence. The write borrows `meter`'s exact shape
([db.js](../server/db.js) `jsonb_to_recordset` + `ON CONFLICT`) so that
difference reads straight off the SQL: `meter` sets
`quantity = quantity + EXCLUDED.quantity`, this one sets
`bytes = EXCLUDED.bytes`.

Measurement details, each verified against the running code (2026-09-03):

- **The day key is db.js's `day()`** ([db.js:3011](../server/db.js#L3011)) —
  the meter's own derivation, imported not restated, so "a day" can never
  mean two things across the two tables.
- **`statfs` works on win32** (verified on the dev machine, Node 22). Use
  `bsize * blocks` for total and `bsize * bavail` for free — `bavail` is
  what an unprivileged process can actually use, and the app runs as `node`.
  ENOENT on a not-yet-created gallery dir falls back to `statfs(ROOT)`.
- **Absence has two spellings, deliberately**: a walked root that doesn't
  exist yet is a genuine 0-byte row (`collectFiles` on a missing root = empty
  tree — dev machines have no `/data/plugins`, and the series should show
  the true zero); an UNCONFIGURED store (npm cache with no
  `NPM_CACHE_DIR`, below) writes no row at all — nothing was measured, and a
  fake 0 would claim it was.

Two writers, one function:

- **The maintain loop** — `sampleStorageDue()`: gated by an in-memory
  `lastSampledDay`, not a DB read — the loop ticks every `POLL_MS` (3s,
  [worker.js:1674](../server/worker.js#L1674)), and a point-read every 3s
  for a once-a-day job is the kind of ceremony autoBackup's 60s in-memory
  throttle exists to avoid. The DB is consulted exactly twice per process
  lifetime per day: the first tick after boot (is ANY row for today present?
  — the read path may have written it before a restart) and the first tick
  after midnight rollover. It **self-catches** (log + retry): the maintain
  loop runs all its sweeps inside ONE try
  ([worker.js:2746](../server/worker.js#L2746)), so an uncaught throw here
  would silently skip whatever runs after it — and it goes last, after
  `autoBackup`, so the reverse can't happen either. A missed day is a gap in
  a sparkline, not an incident.
  - **A 60s retry floor, added by the simplify pass.** The stamp is set only
    on success, so retries continue until one lands — but a root the app
    genuinely can't read (an EACCES bind mount; `collectFiles` rethrows
    anything but ENOENT) fails identically forever, and without a floor that
    is a full five-root walk plus a log line every 3 seconds, ~29k times a
    day. Same answer `autoBackupSweep` already gives to the same problem in
    the same loop. `now` joins `dayKey` as an injectable seam so the floor is
    testable without a clock.
- **The read path** (Mechanism 2) — measures live and upserts today's row
  with what it just showed. The user looking IS a sample; free precision.

Boot does nothing special: the maintain loop runs its body before its first
sleep, so a fresh install has its first sample within seconds.

## Mechanism 2 — the read (`GET /api/admin/storage`)

One admin route, no query params to start. It **measures live** — the walk is
readdir+stat over a few thousand files, well under a second at this app's
scale; staleness would be a self-inflicted wound at this size. (If a library
ever hits hundreds of thousands of files, the escape hatch is
last-sample-instantly + refresh-in-background with a "measured Xh ago" stamp
— a problem to have later, not a reason to build stale now.)

Response:

```
{
  now:    [{ store, bytes, files }],          // just measured, includes disk_total/disk_free
  series: [{ day, store, bytes }, ...],       // all sampled history (small: 9 rows/day)
  boards: [{ id, label, bytes, files, unsized }],  // originals attribution, SQL only
}
```

Order inside the handler: measure → `writeSample(today)` → read the series —
so today's point is in the series the tab draws. `now` is the measured rows
themselves, not a re-read.

`boards` is the SUM over `items.payload->'files'` sizes
(`jsonb_array_elements` LATERAL over `COALESCE(payload->'files','[]')`,
`(f->>'size')::bigint`) grouped by `board_id`, JOINed to `boards` for the
label (items cascade on board delete, so the join loses nothing — and it
matches the `?? id` degradation the usage NAMERS use, with no id ever able
to miss). New db.js reader `boardFileBytes(db)` beside its siblings.

Two facts found on close look (2026-09-03) shape this reader:

- **`unsized` is load-bearing, not decoration.** Size-less file entries are
  the NORM, not an edge: the canonical payload shape
  ([0001_baseline.sql](../server/migrations/0001_baseline.sql), items
  comment) doesn't even list `size` — it arrived with file fields, legacy
  entries stay bare until a file-field mapping triggers the enrich backfill,
  and `seedItem` seeds without it. A silent `COALESCE(...,0)` would render
  "0 B" as a CLAIM on a board whose sizes are simply unknown. So the row
  carries `unsized` (`COUNT(*) FILTER (WHERE f->>'size' IS NULL)`) and the
  tab annotates it — the honesty bit of this surface.
- **`SUM(bigint)` returns NUMERIC, not bigint** — and db.js's int8 parser
  ([db.js:17](../server/db.js#L17)) doesn't cover numeric, so the sum comes
  back a string (usageRows pays this same tax with its explicit
  `Number(r.q)`). Cast in the SQL — `SUM(...)::bigint` — so the parser
  applies and the reader ships numbers like everything else.

Deliberately NOT `/api/usage?group=storage`: the usage reader's contract is
"units consumed over a window" and every one of its affordances (windows,
group validation, unit folding) is flow-shaped. Bolting a level onto it would
bend both vocabularies; the 5e drop was protecting exactly this seam.

## Mechanism 3 — the reader (the Storage tab)

A new left-nav tab between Usage and Capabilities: `data-tab="storage"`,
entry in `TAB_NAMES`, a `panel-storage` section in admin.html, module
`public/admin-storage.js`; self-guards on `/api/me` admin like its siblings.

**Rendered on SELECT, not at boot — a deliberate deviation from the sibling
tabs** (close look, 2026-09-03). Every other tab fetches at page load
([admin.js:41-46](../public/admin.js#L41)); this one's GET does server-side
filesystem work and exists to be live ("the user looking IS a sample"), so
admin.js's `selectTab` grows a `renderStorage()` call for `storage` the same
way it already runs `setLogsActive(name === "logs")` — the one established
tab-visibility hook. Boot deep-links (`#storage`) work for free because
`selectTab` fires for hash tabs at boot. Re-opening re-measures; a double
click is two idempotent upserts and a redraw.

Layout, top to bottom (stock `.section` + table vocabulary; the tab earns new
CSS only for what nothing existing says):

1. **Headline strip** — the job-1 gauge: `disk used / total` with free
   called out, and `app holdings` (sum of walked stores + db). Wears the
   usage strip's look via promotion, not copy: `kpi()`
   ([admin-usage.js:272](../public/admin-usage.js#L272)) moves to utils.js,
   and `.usage-kpis`/`.usage-kpi` rename to neutral `.kpi-row`/`.kpi` — the
   exact `.pill-row` precedent ("was .plugin-filters until the second
   wearer", [admin.html:55](../public/admin.html#L55)). `.usage-money` /
   `.usage-deal` stay usage-scoped; money is genuinely that tab's.
2. **Stores table** — one row per store: label, bytes (`fmtSize`), file
   count where present, and a per-store sparkline from `series`
   (`count: 30`; no window picker — the tab has one question, not four).
   Backups labeled prunable in static words ("retention on the Backups
   tab") — the "kept: 7" figure was dropped on close look: it would cost a
   second fetch of another tab's settings for a footnote. This is job 2:
   the prunable/sacred split, visible.
3. **Boards table** — label, originals bytes, file count, sorted desc (the
   route's order), with `unsized` annotated where nonzero ("3 without
   sizes"). Job 3.
4. **The honesty sentence**, stated in words where the numbers meet: the
   stores table is DISK TRUTH (a walk); the boards table is ATTRIBUTION OF
   ORIGINALS ONLY (thumbnails, sidecars, and embeddings belong to no cheap
   per-board sum). They will not add up, and the tab says so instead of
   massaging them into one figure — the `viaFloor` / deal-sentence move.

Close-look facts the build leans on (2026-09-03):

- **Store labels ride the response, not the reader.** The metering arc's
  standing rule — the reader "renders the vocabulary it is handed and
  invents none" — caught two hardcoded-vocab bugs already. `storage.js`
  grows a tiny `STORE_DEFS` (id → label, and which rows are the disk pair),
  the route serves it, an unknown id degrades to itself (the usage NAMERS
  rule).
- **`fmtSize` already handles GB** ([admin-backups.js:8](../public/admin-backups.js#L8))
  — the Stage 1 close-look note underquoted it — but its KB floor
  (`Math.max(1, …)`) renders 0 bytes as "1 KB", a false claim for an empty
  plugins store. Promotion to utils.js adds a true `0 B` case and a bytes
  rung; backup archives are MB-scale, so that tab's display is unchanged.
- **Icon: the set has no fitting glyph** — `database` is worn by Backups,
  and nothing says "disk". Add a `hardDrive` glyph to ICONS (the established
  pattern: glyphs are added as features need them).
- **Level sparklines read near-flat, and that is accepted.** `sparkline`
  scales bars to the drawn window's max, so a store growing 2% over 30 days
  draws 30 nearly-equal bars — honest (the level barely moved), cheap
  (reuse over a new renderer), and it still shows the two things worth
  seeing at a glance: a purge and a growth spurt. The real trend answer is
  Stage 4's projection, not a fourth chart vocabulary.

Trend projection ("full in ~6 weeks") is a **client-side maybe**: with ≥14
days of `disk_free` samples and a climbing slope, one muted line under the
headline. Show nothing otherwise — absence, not a guess. This slice ships
last and can be dropped without touching the mechanisms.

## Stages

Each stage lands alone and is useful alone.

- **Stage 1 — the gauge.** Migration `0042_storage_sample.sql`;
  `server/storage.js` (`measureStorage`, `writeSample`, `sampleStorageDue`);
  export `collectFiles` from backup.js; wire `sampleStorageDue` into the
  maintain loop after `autoBackup`.
  - **The npm-cache env trap (found on close look, 2026-09-03).** The
    container names the cache via `npm_config_cache=/data/.npm`
    ([Dockerfile:41](../Dockerfile#L41)) — but that env CANNOT be what
    `measureStorage` reads: `npm run server` on a dev machine injects
    `npm_config_cache=<user's global npm cache>` (verified:
    `C:\Users\...\npm-cache`), and the walk would report the developer's
    personal cache as app holdings. Add an explicit `NPM_CACHE_DIR=/data/.npm`
    line to the Dockerfile ENV block and read only that; unset (every dev
    run) = store skipped, the absence spelling above. One more line in the
    Dockerfile buys never measuring someone else's files.
  - **Wiring mirrors the backup hook exactly**: server.js binds the dirs
    into a no-arg closure the way `mountBackups` returns
    `() => autoBackupSweep({ db, backupsDir })`
    ([backup-routes.js:242](../server/backup-routes.js#L242)), and
    `startWorker` grows a `sampleStorage` hook beside `autoBackup`
    ([server.js:3182](../server/server.js#L3182)). Dirs: `GALLERY_DIR`,
    `THUMBS_DIR`, `BACKUPS_DIR`, `pluginsDir()`
    ([plugin-loader.js:357](../server/plugin-loader.js#L357)),
    `NPM_CACHE_DIR`. The worker only starts under `isMain`, so tests import
    `server/storage.js` directly — no worker in the loop.
  - **BIGINT is already a Number**: db.js sets the global int8 parser
    ([db.js:17](../server/db.js#L17)), so `pg_database_size` and the table's
    `bytes` come back numeric — no `Number()` seams needed anywhere (byte
    counts sit far below 2^53). (Corrected while building: an earlier draft
    assumed pg's string default.)
  - **Backups-in-flight debris** (`.spool-*`, `.partial`) lands in the walk
    if a backup is running at measure time — counted as-is; it IS on disk,
    and the sweep prunes it within a day. Honest, not a bug.
  - Tests (mkdtemp temp-root pattern per
    [backup.test.js](../test/backup.test.js)): idempotent upsert (measure
    twice, one row set); missing root = 0-byte row; unconfigured npm cache =
    no row; db row present and numeric; disk rows present; `sampleStorageDue`
    skips when today's row exists and re-arms on day rollover (inject the
    day key).
- **Stage 2 — the read.** `boardFileBytes` in db.js;
  `GET /api/admin/storage` in server.js (admin-gated like
  `/api/admin/prices`, `wrap`ped); the live measure upserts today.
  - **Generated faces get a size going forward (found on close look).** A
    connector chart face is its own original — `generateFace` writes real
    gallery bytes ([worker.js:870](../server/worker.js#L870)) — but its file
    entry carried no `size`: `storeFace` returned only `{name, w, h}`
    ([faces/index.js:58](../server/faces/index.js#L58)). `storeFace` now
    returns `size` **on the generated branch only** — the writer is what
    knows how many original bytes landed, and that branch is exactly where
    the webp it wrote IS the original. Existing generated faces stay unsized
    (the `unsized` count carries them honestly; regeneration re-stamps on its
    own cadence).
    - **Corrected by the simplify pass.** This plan first mandated stamping
      at the CALL SITE, reasoning that the five media source handlers spread
      `storeFace`'s fragment into entries whose `size` is the upload's. They
      do not — every one destructures `const { w, h } = …`
      (image/audio/pdf/docx/text), so the hazard was imaginary and the
      knowledge sat one level too shallow, re-derived by a caller for a file
      it did not write. The non-generated branch still says nothing about
      size, so even a future spreading caller stays correct.
  - **One `STORAGE_DIRS` const in server.js**, beside the `*_DIR` consts —
    the route and the worker's `sampleStorage` binding read the same object,
    so the two callers of `measureStorage` cannot drift on what the stores
    are.
  - Tests: response shape (`now` has the disk pair, `series` includes
    today's fresh rows); board sums match seeded payload sizes with `label`
    from boards.name; `seedItem`'s size-less entries land in `unsized`, not
    as fake 0-byte claims; fileless connector vehicles (`files: []`)
    contribute nothing; a second GET refreshes today's row (upsert, no
    doubling); non-admin 403.
- **Stage 3 — the tab.** Nav button (`hardDrive` glyph added to ICONS) +
  `TAB_NAMES` + `panel-storage` section + `public/admin-storage.js`,
  rendered on select via the `selectTab` hook (the logs precedent), not at
  boot. Promotions: `fmtSize` → utils.js with the `0 B` fix (backups tab
  re-imports), `kpi()` → utils.js with the `.usage-kpis` → `.kpi-row`
  rename (both wearers updated). Route addition: `STORE_DEFS` labels served
  in the response. Headline strip, stores table + 30-day sparklines, boards
  table with `unsized` annotations, honesty sentence. Screenshot for
  docs/screens. Tests: the suite is server-side — the route's `labels`
  addition gets an assertion; the tab itself is verified by screenshot like
  its siblings.
- **Stage 4 (optional) — the projection.** Client-side days-until-full line,
  gated on history depth and slope. Droppable.

## Non-goals

- **Quotas / enforcement.** Immich and Nextcloud have them; this app shows
  and never blocks — defaults not laws. A full disk is the OS's law, not ours.
- **Pricing storage.** No rate, no `cost_micros`, no Prices row. The tab is
  the one place in admin where every number is a measured fact.
- **Per-board disk truth.** Attributing thumbnails/sidecars/embeddings per
  board means walking with an ownership map or new bookkeeping on every
  write; the originals sum is the honest cheap answer (Nextcloud does the
  same). Revisit only if a real question needs it.
- **Orphan detection.** The walk's file count vs the DB's entry count is a
  free drift witness (files on disk no item claims) — a future arc, not this
  one.
- **Board-manager storage surface.** Spend is manager-visible; storage stays
  admin-only until someone actually asks — the board modal can grow a line
  later without touching the mechanisms.
- **Retention/prune actions on the tab.** The levers live where they live
  (backups tab, env vars); this tab points, it doesn't pull.

## Status

- Designed 2026-09-03 (this doc).
- **Stage 1 (the gauge) shipped 2026-09-03.** `0042_storage_sample.sql`,
  `server/storage.js`, the worker's daily sample. Suite 1330.
- **Stage 2 (the read) shipped 2026-09-03.** `GET /api/admin/storage`,
  `boardFileBytes`, generated faces stamp their size. Suite 1333.
- **Stage 3 (the tab) shipped 2026-09-03.** The Storage tab, `fmtSize`/`kpi`
  promoted to utils.js, `.kpi-row` rename. Verified in a browser against the
  dev database. Suite 1333.
- **Simplify pass 2026-09-03** (see the section above): `STORE_DEFS` became the
  single store vocabulary the walk derives from, and the reader stopped
  inventing the classifications it said it never invents.
- **Stage 4 (the projection) not started** — it needs ~14 days of samples
  before it could draw anything, so it waits on real history rather than on a
  decision.
- **Open:** the docs/screens screenshot should be taken from the deployed
  instance, where gallery/thumbnails carry real weight — on a dev host they
  read 0 B, because the real files live in the container's volume.

## Simplify pass over Stage 3 (2026-09-03)

- **`STORE_DEFS` became the single store vocabulary** (units.js / capabilities.js
  shape, and for their stated reason). It now carries `dir` — and
  `measureStorage`'s walk DERIVES from it — plus `disk` (the statfs pair, which
  is capacity rather than something held) and `prunable` (job 2's operator
  fact, in words the reader prints without interpreting, the
  `rebindWarning` precedent). Adding a store was three edits across two files;
  it is now one entry.
- **The reader stopped inventing what it said it never invents.** Its header
  claimed it "renders the vocabulary it is handed" while filtering on
  `disk_total`/`disk_free` by id and branching on `=== "backups"` for the
  prunable note. Both now read served fields — which immediately showed its
  cost: thumbnails and the npm cache are prunable too, and a one-id branch
  could never say so.
- **No `/api/me` guard** — the siblings render once at boot (where the guard
  stops an admin request for a non-admin); this renders per tab-select, where
  the shell has already proven admin and the guard is a per-click round trip
  re-answering a settled question. Route stays `requireAdmin`.
- **One render at a time** (`inFlight`): two overlapping opens walked the
  filesystem twice and let the OLDER result paint last.
- **`readSeries` takes a floor** (route passes 90 days) — the table still keeps
  everything; only the wire is windowed, the way `/api/usage`'s `from=` is.
- **`fmtQty` on file counts**, `.store-note` class instead of an inline
  `font-size`, and `fmtSize` finally absorbed the app's THIRD private byte
  formatter (`source-chooser.js`'s `fmtBytes`, which had no GB rung — a 2 GB
  file in a browse listing read "2048.0 MB").
