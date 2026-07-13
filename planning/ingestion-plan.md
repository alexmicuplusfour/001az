# Automatic ingestion — the third leg (folder watching first)

Shipped 2026-07-13. Phase 1 only (agnostic core + folder adapter + modal);
phase 2 (connector-feed adapter) is specced at the bottom, not built.

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
  input.connector → folder; connector names → null until phase 2), trigger
  math (`nextIngestRunAt`, sibling of `nextAutoTagRun`, server-local TZ),
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
  5-min backoff, never the loop. `startWorker` gained an optional `sources`.
- `server/server.js` — validateIngest wired into `buildBoardContentUpdate`
  (arm on off→on / trigger change = immediate first run; disarm on off/manual);
  routes: `GET /api/boards/:id/ingest` (descriptor+config+state),
  `GET /api/ingest/folders` (picker, depth ≤3), `POST …/ingest/preview`
  (dry-run body, never saved; count / new / capped / 20-row sample),
  `POST …/ingest/run` (arm now; 409 when disabled). All board-scoped routes
  `requireBoardManager`. Board payload: `ingest_enabled` on `GET /api/boards/:id`,
  full `ingest`+`ingest_state` on `/settings`.
- `public/ingest-modal.js` — descriptor-driven modal (toolbar chevron →
  "Automatic ingestion…"): enable, source (folder picker + recursive), filter
  rows (fn→op-by-kind→typed value), sort & limit, trigger, debounced live
  preview with stale-response guard, last-run status line, Save + Run now.
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

## Phase 2 (next slice): connector-feed adapter

"Mirror a filter-defined bucket" for stocks/crypto (top-50-by-market-cap etc.):
relocate `addConnectorEntity` (server.js ~1215 — closes over module `db`, so
the move adds a db param) to `server/connectors/add.js`;
`server/ingestion/connector.js` builds its descriptor from `manifest.browse`
(columns → filter kinds, sorts), enumerates via paged `connector.list()`
(bounded; `truncated` → "N+" preview), `key` = lowercase symbol ‖ id (mirrors
entity identity), admit-then-ledger healed by the entities unique constraint +
`err.duplicate`. `triggerModes: manual/interval/daily`. Zero core edits — the
sweep, routes, modal, engine and ledger already speak the interface. News =
one more adapter (or free via this one once a news connector exists), with the
AI event-identity layer as its own future design.
