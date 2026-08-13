# Automatic ingestion — the third leg (folder watching first)

Shipped 2026-07-13 (phase 1: agnostic core + folder adapter + modal).
Phase 2 (connector-feed adapter) shipped 2026-07-14 — see the bottom section
for what was built and the semantics it settled.

## What this is

The app had two AI legs (extraction, tagging) fed only by manual input: file
upload, or browse-and-add on connector boards. This adds the upstream third
leg: **automatic ingestion** — a board feeds itself from a source (a watched
folder for file boards; later, filter-defined feeds for stocks/crypto/news),
with filters, sorting, a per-run limit and a trigger schedule, configured in a
descriptor-driven modal with a live results preview.

Agnostic at every level, in the app's registry style: an ingestion **adapter**
per input type declares a descriptor (source schema, filter catalog, sorts,
trigger modes) and implements `enumerate`/`admit`; a shared pure filter engine,
one dedup ledger, one worker sweep, one modal. Adding an ingestible domain =
one adapter file, zero core edits.

## Design decisions

- **No fs.watch/chokidar.** "Watching" = periodic scan; the worker tick is the
  cron (the established pattern). `continuous` trigger = rescan every 30s.
  Reliable through Docker bind mounts where inotify isn't.
- **Config** in `boards.ingest` JSONB (mirrors `mapping`), timer in
  `boards.ingest_next_run_at` (mirrors `auto_tag_next_run_at`), sweep-owned
  status in `boards.ingest_state` (separate column so user saves never clobber
  sweep writes; updateBoard deliberately can't touch it).
- **Dedup ledger** `ingest_log(board_id, source_key)` — one row per key ever
  admitted. Entity deletion does NOT remove the row: a feed never resurrects a
  user-deleted item ("user wins"). Files: key = relative path; an edited file
  (changed mtime) does not re-ingest in v1.
- **Folder jail**: `INGEST_ROOT` env (compose bind-mounts `./ingest-root` →
  `/data/ingest`); boards store a subpath; `resolveJailed` rejects escapes.
  One-directional and additive-only: source files never touched, deletions
  don't propagate either way ("mirror deletes" = possible future toggle).
- **Birth paths are shared, not duplicated**: the upload route's per-file block
  became `admitFile()` (server/ingest.js, exported) and both doors call it —
  status/park/mapping-stamp logic can't drift. Ingested items enter the normal
  queue (`pending_extract`/`pending`/`held`), ride the existing legs, delta
  poll and processing UI.
- **Unprocessable content is skip-and-ledger**: a handler throw (bad decode,
  page cap) is a deterministic function of the file's bytes — `admitFile` tags
  it `err.unprocessable`, the folder adapter converts to `err.skip`, the sweep
  ledgers it and stops rescanning. Infra failures stay retryable. Without this
  a pile of corrupt files would permanently clog the per-tick admission cap.

## Config shape

```js
board.ingest = {
  enabled: true,
  source: { folder: "sub/path", recursive: true },   // adapter-specific
  filters: [ { fn, op, value } ],                    // AND semantics
  sort: { by: "modified", order: "desc" },           // decides who wins under a limit
  limit: 50,                                         // per-logical-run admission cap
  trigger: { mode: "continuous"|"interval"|"daily"|"manual", every?: min, at?: "HH:MM" },
}
```

Filter ops by kind (single source of truth: `OPS_BY_KIND` in
server/ingestion/filter-engine.js — served in the descriptor, enforced by
validateIngest, evaluated by the engine):

| kind | ops | value |
|---|---|---|
| text | contains, equals, starts_with | string ≤200, case-insensitive |
| number | gte, lte, eq | finite number |
| date | within_days, before, after | int 1–3650 / "YYYY-MM-DD" |

## Adapter interface (pinned)

```js
descriptor() → { source: [{key,type,label,default?}], filters: [{fn,kind,label}],
                 sorts: [{by,label}], triggerModes: [...] }
async enumerate(db, board, cfg, { limit = Infinity }) → { candidates: [{key,label,values}], truncated }
async admit(db, board, candidate, { sources }) → { entityId, itemId }
  // throws; err.duplicate → ledger + stop retrying; err.skip → ledger-and-forget
```

`key` is the stable ledger source_key; `values` is a flat bag the shared
engine filters/sorts on, described by the descriptor's filter catalog.

## Where everything lives

- `server/migrations/0015_ingestion.sql` — the three board columns + ingest_log.
- `server/ingestion/index.js` — registry (`resolveIngestAdapter`: null
  input.connector → folder; a connector name → the phase-2 feed adapter,
  or null for a connector the registry doesn't know), trigger math
  (`nextIngestRunAt`, sibling of `nextAutoTagRun`, server-local TZ),
  `validateIngest`.
- `server/ingestion/filter-engine.js` — pure evaluate/applyFilters/applySort
  (stable, nulls last)/applyLimit.
- `server/ingestion/folder.js` — the folder adapter: `resolveJailed`, scan
  (dotfiles/symlinks skipped, upload-extension allowlist, 10MB cap, settle
  window `INGEST_SETTLE_MS` so half-copied files wait a scan), admit =
  copy-to-tmp → `withTx(admitFile + recordIngest)` (ledger atomic with birth;
  tmp copy so the source is never consumed). Folder ingestion stamps
  `createdAt` from fs birthtime — the `created` file field browsers can't fill.
- `server/worker.js` — `ingestDue()` in the tick after refreshDue: per due
  board, enumerate → dedup vs ledger → filter/sort → budget → admit up to
  `INGEST_RUN_CAP` (25) per tick. Bigger runs drain across ticks with
  `next_run_at = now`, resuming from `ingest_state.drain_left` so the run's
  `limit` stays exact (never re-sliced). Per-board failures → `last_error` +
  5-min backoff for scheduled triggers, never the loop; a failed MANUAL run
  disarms instead (asked once, answered once — Run now re-arms it).
  `startWorker` gained an optional `sources`.
- `server/server.js` — validateIngest wired into `buildBoardContentUpdate`
  (arm on off→on / trigger change = immediate first run; disarm on off/manual);
  routes: `GET /api/boards/:id/ingest` (descriptor+config+state),
  `GET /api/ingest/folders` (picker, depth ≤3), `POST …/ingest/preview`
  (dry-run body, never saved; count / new / capped by default, and
  `sample: { offset, limit }` opts into a page of rows + hasMore — each page a
  fresh stateless enumerate, like connector-browse paging; pages skip the
  ledger-wide `new` accounting and instead flag each row `ingested` via a PK
  probe on just its keys),
  `POST …/ingest/run` (arm now; 409 when disabled). All board-scoped routes
  `requireBoardManager`. Board payload: `ingest_enabled` on `GET /api/boards/:id`,
  full `ingest`+`ingest_state` on `/settings`.
- `public/ingest-modal.js` — descriptor-driven modal (toolbar chevron →
  "Automatic ingestion…"): enable, source (folder picker + recursive), filter
  rows (fn→op-by-kind→typed value), sort & limit, trigger, last-run status
  line, Save + Run now. Preview is manual and two-stage: a Preview button
  fetches the count; clicking the count swaps the modal to a read-only
  results list (connector-browse-style table, Load more, Back to settings —
  same modal, so buffered edits survive). Config edits hide a shown count so
  the results view can never open on stale numbers (a seq guard also discards
  in-flight count responses that an edit outran). Rows the ledger holds are
  marked "Ingested"; Save refuses an unfinished filter row by name instead of
  silently dropping it.
- `public/data.js` also owns `stampBoardIngest`/`refreshBoardIngest` — the
  single fetch-and-stamp path for `ingest_enabled`+`ingest_next_run_at` used
  by boot, the modal and the toolbar countdown chip (which backs off 5s→60s
  while the stamp refuses to advance, e.g. worker down or a long drain).
- `public/data.js` — `pollDelay()` counts `state.boardIngest` into the 30s
  slow poll (same stale-tab cure as live faces; without it a quiet board never
  shows auto-ingested items).
- Compose: `INGEST_ROOT=/data/ingest` + `./ingest-root` bind + knob
  passthroughs (`INGEST_CONTINUOUS_MS`/`INGEST_SETTLE_MS`/`INGEST_RUN_CAP`);
  Dockerfile mkdir; .env.example.

## Ops notes

- Drop files into `./ingest-root/<subfolder>` on the host (the modal's folder
  picker lists subfolders; files at the root itself are reachable via an
  empty-string folder only through the API, the picker wants a subfolder).
- Prod: the bind resolves to `/opt/001az/ingest-root` on the droplet;
  deploy.ps1 creates it (mode 777 so scp/sftp can land files as any user)
  before `up`. Pushing files onto the droplet stays manual (scp/rsync) until
  a remote source lands.
- Client files are baked into the image → `docker compose up -d --build` +
  hard refresh after client changes.
- A board's very first Save with a non-manual trigger runs immediately (timer
  armed at `Date.now()`), then follows the trigger.

## Known-benign / deferred

- Sweep is read-then-work like retagDue — fine single-process; a second app
  container would want a claim-style UPDATE on `ingest_next_run_at`.
- Gallery-file orphan window on tx rollback (disk writes precede COMMIT) —
  mitigated with `sources.cleanup` in admit's catch; same window the upload
  route has always had.
- `ingest_log` reset ("re-sync everything") has no UI — `DELETE FROM
  ingest_log WHERE board_id=…` by hand, or a trivial route later.
- Preview counts total matches (`count`) and not-yet-ingested (`new`); it
  doesn't subtract the limit — the sample's top rows are what a run would take.
- Admissions run inside the worker tick, serially, before claims — a full
  25-admission tick of images can hold the tick a few seconds (image decode is
  process-gated). `INGEST_RUN_CAP` is the knob if that ever matters.
- `ingestedKeys` loads the whole per-board ledger each run — fine at folder
  scale; a `NOT EXISTS` join against `ingest_log` is the upgrade for huge feeds.
- An error tick preserves `ingest_state.drain_left`, so a transient failure
  mid-drain can't hand the retry a fresh `limit` (pinned in
  test/ingest-sweep.test.js).
- Handler `err.unprocessable` classification treats any throw inside
  `sources.ingest()` as content-deterministic; a freak infra error there (tmp
  file vanishing mid-read) would ledger-skip a good file. Accepted — the tmp
  copy is made moments earlier by the same process.

## Phase 2 (shipped 2026-07-14): connector-feed adapter

A connector board feeds from a filter-defined bucket of its domain's catalog
(rank ≤ 50, market_cap ≥ X, sector = tech). Built as specced, zero core edits
— the sweep, routes, modal, engine and ledger spoke the interface unchanged:

- `server/connectors/add.js` — `addConnectorEntity` relocated from server.js
  verbatim plus a `db` param (it closed over the module pool); the routes and
  the feed adapter share it, so feeds get charts, live-field scheduling and
  the park policy for free.
- `server/ingestion/connector.js` — `feedAdapter(conn)` (split from
  `forBoard(board)` so tests can drive a stub connector): descriptor from
  `manifest.browse` (columns → filter catalog with usd/percent → number,
  sorts as-is, `triggerModes: manual/interval/daily` — no `continuous`
  against a metered API); `enumerate` pages `connector.list()` in the
  configured sort order into a bounded window (ENUM_CAP 1000 = PREVIEW_CAP,
  pageSize 250, MAX_PAGES 40), dedupes keys across pages (rank drift),
  `truncated` at the cap; `admit` = addConnectorEntity → recordIngest,
  non-transactional and healed by the entities (board_id, identity) unique
  constraint + `err.duplicate` (the sweep ledgers it). Candidate `key` =
  lowercase symbol ‖ provider id — the same derivation as entity identity and
  browse's `on_board`, so all three agree on "already here".
- One client edit: the modal's unsaved-config trigger default was hardcoded
  `continuous`; now it prefers `continuous` when offered, else the
  descriptor's first mode (a feed board's Save used to 400 out of the box).

Semantics settled by the build:

- **`limit` is per-RUN admission** (the modal's own label), not a mirror
  size: each run takes up to N *new* candidates, so successive runs walk down
  the catalog. "Mirror the top 50" is a FILTER (`rank ≤ 50`); a filter-bounded
  feed drains to last_added 0 once the bucket is ledgered.
- **Stop paging on an EMPTY page only.** Providers clamp pageSize internally
  (FMP caps at 100) but keep offset math consistent with their own clamp — a
  short-but-nonempty page is normal paging, and treating it as "dry" would
  silently miss everything past a provider's first clamped page.
- **Provider-side sort is load-bearing** for the bounded window: "top N by X"
  must fill the window in X order. A provider that can't honor a sort key
  falls back to its default order (CoinGecko has no price order) — the engine
  still re-sorts within the window, but the window itself is approximate then.
- An active provider without `list()` throws a readable "can't browse its
  catalog" instead of enumerating an empty universe as count 0.

Verified: 288 tests (9 new in test/ingest-connector.test.js: descriptor
derivation, empty-vs-short page, cross-page dedupe, cap/truncated, list-less
provider, admit+ledger+duplicate, sweep e2e over a mocked CoinGecko;
ingest-routes' phase-1 pin flipped to assert the served descriptor). Live on
the compose stack against keyless CoinGecko: preview count (capped 1000-row
window, ~5s paced), top-2 run admitted btc+eth with real fields, second run
took the next 2 (per-run limit semantics), rank≤4 config drained to 0,
deleted entity not resurrected, board delete cascaded the ledger. Browser DOM
not automated (as ever) — the modal is descriptor-driven and the results view
was exercised only via the preview API shapes.

Tick-hold note (known-benign family): each admit is a real `fetchEntity`
(FMP cold = 3 HTTP calls at rpm 60/burst 2), so a 25-admit tick on a cold
FMP board can spend ~1–2 min inside the rate limiter, delaying the tag queue
behind the single-flight tick. Bounded by INGEST_RUN_CAP + drain.

### Loose-ends pass (2026-07-14, same day)

A multi-lens review of the slice surfaced and fixed:

- **Mapping input switch orphaning the ingest config** (the real bug of the
  pass): editing a board's mapping from files→connector (or back, or between
  connectors) left the saved ingest config running under the wrong adapter —
  a folder config on a feed board re-enumerated the metered catalog on its
  `continuous` 30s cadence forever (admitting nothing under unknown filters,
  or EVERYTHING with none), and a feed config on a files board resolved its
  empty `source.folder` to INGEST_ROOT itself and ingested the whole root.
  The admin mapping PATCH now clears config + timer + run state when
  `input.connector` changes; the ledger stays (deletions remain final).
- **Stale drain budgets**: `drain_left` had no run identity — saving a new
  config mid-drain handed the next run the dead config's remaining budget as
  its limit. Config saves now clear it (`clearIngestDrain`, the one
  sweep-state field a save may touch; run history stays).
- **Manual error retry loop**: the error path re-armed every trigger mode at
  +5 min, so a failed manual Run-now silently retried forever until the
  source healed. Manual now disarms on error (outcome visible in the modal
  status); scheduled modes keep the 5-min backoff.
- **enumerate honesty + cost**: window filled to the cap now reports
  `truncated` without fetching the probe page beyond it (FMP's self-capped
  1000-row universe used to read "1000, complete"); a MAX_PAGES exit is
  truncated too. Stop condition is still an empty page only.
- **Results-view formatting**: feed descriptors now carry the column's
  `display` kind (usd/percent) and the preview list formats through the same
  fmtUsd/fmtPercent as connector-browse (moved to paged-table.js, shared) —
  sub-cent prices no longer flatten to "0". Number filter inputs also lost
  their `min="0"` clamp (change_24h ≤ −5 is the bread-and-butter feed
  filter); within_days keeps min 1.
- **Stocks rank**: FMP browse rows gain `rank` (market-cap position computed
  at screener load), so "top 50 stocks" is expressible as `rank ≤ 50` like
  crypto — previously stocks had no rank column at all.

Reviewed and left alone (known-benign, by design or too narrow):

- Cold enumerate cost stands (a preview against a fresh sort pages the metered
  catalog — ~4 CoinGecko calls, ~5-9s keyless) but is now paid ONCE per
  (connector, provider, sort): the feed adapter caches the enumerated window
  (`INGEST_FEED_CACHE_MS`, default 60s). Filters and the per-run limit apply
  downstream, so a count, its result pages, repeated previews, and filter-only
  edits in one session all reuse the window (measured ~5s cold → ~8ms warm).
  A sort change or a provider switch re-fetches (different key); the sweep
  reuses it too and tolerates the staleness. Drain ticks within a run therefore
  don't re-page either. (FMP additionally caches its screener for 5 min under
  the window cache.)
  **Superseded 2026-08-13** — the last sentence is no longer true for metered
  catalogs. It held while the window was rationed to 1,000 rows (walk ≈ 4
  requests, ≈5 s, well inside the 60 s TTL). At full catalog depth the walk is
  ~74 requests and the 25 admissions between ticks are metered too, so the
  window has always lapsed by the next drain tick and every tick re-walks.
  See [ingest-drain-rewalk.md](ingest-drain-rewalk.md).
- CoinGecko can't honor a `price` sort provider-side and FMP's whole
  universe is top-1000-by-mcap — bounded windows are approximate for
  off-default sorts, documented in the adapter header.
- A candidate that deterministically fails `fetchEntity` (delisted coin
  still in the catalog) is retried every run and keeps `last_error` set; it
  self-resolves when the catalog drops the row. Ledgering 404s would block
  re-adds if the asset returns.
- Symbol-less rows key by provider id (not portable across a provider
  switch) — same identity rule as manual adds. Provider re-resolution
  mid-enumerate can interleave catalogs if an admin switches backends inside
  a ~5s window. The sweep's `!sources` guard also blocks feeds on a worker
  started without sources — never the case in prod.
- Ghost entity if the process dies between createEntity and insertItem —
  pre-existing, shared with the manual add path.

News = one more adapter (or free via this one once a news connector exists),
with the AI event-identity layer as its own future design.
