# Plan: Postgres migration + dockerization

> **Status (2026-07-04):** Phases 1 AND 2 done, tested locally. Phase 1: db.js
> rewritten on pg, all call sites async, `schema.sql` baked, ETL script
> (`scripts/sqlite-to-pg.js`) rehearsed against synthetic data. Phase 2: full
> compose stack under project name **001az** — caddy (:8001 locally) → app image
> (`Dockerfile`, node:22-slim, serves frontend + `/gallery` + `/thumbnails`
> static mounts) → postgres (host port 5433). `.env` (gitignored) holds local
> values, `.env.example` is the template. End-to-end verified through Caddy:
> login, board, upload (sharp in-container → `/data` volume), thumbnail serving,
> persistence across rebuilds. Remaining: cutover (ETL against droplet data +
> hosting decision) and cleanup. ⚠️ Do NOT run `deploy.py` — it would push pg
> code onto the SQLite droplet and restart the service.

## Current state

- **DB layer**: `server/db.js` (~640 lines, ~40 exported functions) on better-sqlite3.
  Everything is **synchronous** — every Express handler, the `attachUser` middleware,
  and the worker loop call the DB inline with no `await`. This is the single biggest
  cost of the migration: pg drivers are async, so async-ness ripples through every
  call site.
- **Schema**: 12 tables (boards, board_members, images, ai_usage, users, invites,
  sessions, favorites, crates, crate_images, settings) plus a stack of legacy
  incremental migrations (try/catch `ALTER TABLE`s in `openDb`, `migrateOrphanImages`,
  `migrateInitialBoardMembers`, `migrateCratesPerBoard`, `seedIfEmpty` from tags.json).
- **Conventions**: `Date.now()` ms epochs in INTEGER columns; JSON blobs
  (`images.tags`, `boards.facets/glosses`) stored as TEXT and `JSON.parse`d in JS;
  booleans as 0/1 INTEGERs; no foreign keys (cascade deletes done manually in
  transactions).
- **SQL outside db.js**: ~10 inline `db.prepare` calls in `server.js` (health,
  user-exists check, board image counts, retag, upload board check, tags PATCH,
  thumb backfill) and one in `worker.js` (pending count for the cap notice).
  `mintlink.js` is a CLI that opens the DB directly.
- **Data**: local `data.db` is empty (4 KB). Production data lives on the droplet
  (1 vCPU / 458 MB, no swap) behind Caddy + systemd; `deploy.py` rsyncs code only.

## Target architecture

docker-compose with three services:

| Service | Image | Role |
|---|---|---|
| `caddy` | `caddy:2` | TLS (ACME) + reverse proxy **everything** to app |
| `app` | custom, `node:22-slim` | API + static frontend via existing `express.static` |
| `db` | `postgres:17-alpine` | Postgres, tuned small |

Decisions baked into this shape:

- **App serves the frontend.** `STATIC_DIR` support already exists
  (`server.js:497`). Caddy becomes TLS-and-proxy only, so the Caddyfile is ~5
  lines, lives in the repo, and `deploy.py`'s per-file artifact list dies with it.
  At this scale the static-file perf difference is irrelevant.
- Volumes: `pgdata` (named), `caddy_data` (certs), `/data` bind or named volume for
  `gallery/` + `thumbnails/` (`GALLERY_DIR`/`THUMBS_DIR` env already exist).
- `db` gets a healthcheck; `app` uses `depends_on: condition: service_healthy`.
- App env: `HOST=0.0.0.0`, `DATABASE_URL=postgres://…@db:5432/gallery`, plus the
  existing `ANTHROPIC_API_KEY` / `MODEL` / `DAILY_CAP` / `ADMIN_EMAIL` / `BASE_URL`
  via a gitignored `.env` (same pattern as `deploy.local.json`).
- better-sqlite3 disappears from package.json, leaving **sharp** as the only native
  module — Linux prebuilds exist, no compiler stage needed. `.dockerignore`:
  `node_modules`, `gallery`, `thumbnails`, `server/data.db*`, `deploy.local.json`,
  `.env`, `pets-test`.

## Code changes

### 1. Driver and conventions

- **Driver: `pg`** (node-postgres) with a single shared `Pool`. Boring and standard.
- **Timestamps: keep ms-epoch BIGINTs.** Zero churn in JS date math. One required
  gotcha fix: pg returns BIGINT as *string* — set
  `pg.types.setTypeParser(20, Number)` once at startup (safe: ms epochs are far
  below 2^53).
- **JSON columns → JSONB** (`images.tags`, `boards.facets`, `boards.glosses`).
  pg auto-parses on read, so the `JSON.parse`/`JSON.stringify` pairs in db.js go
  away. This also sets up server-side tag queries for the modular-boards direction.
- **0/1 INTEGERs → BOOLEAN** (`is_admin`, `permanent`, `undecided`). `!!row.x`
  call sites keep working; `WHERE is_admin=0`-style predicates get rewritten
  inside db.js.
- **Real foreign keys with `ON DELETE CASCADE`** (favorites/sessions/invites → users,
  images/board_members → boards, crate_images → crates/images, favorites/crate_images
  → images). `deleteUser`, `deleteBoard`, `deleteCrate` shrink to single DELETEs
  (deleteBoard still collects filenames first for file cleanup).
- **Bake the final schema** in one `schema.sql` / migration file. All the legacy
  incremental migrations and `seedIfEmpty` are dead code post-ETL — delete them.

### 2. Async conversion (the bulk of the work)

- Every db.js function becomes `async`; parameter style `?`/`@named` → `$1, $2`;
  `info.lastInsertRowid` → `RETURNING id`; `info.changes` → `result.rowCount`.
- Every call site in `server.js` gets `await`; the ~10 inline `db.prepare` calls
  move into db.js as named functions.
- `attachUser` becomes async middleware.
- **Express 4 does not catch rejected promises from async handlers** — an
  unhandled rejection kills the process. Add a tiny `wrap(fn)` helper applied to
  every route (or bump to Express 5, which auto-forwards; the bump is small but
  is its own change — default: `wrap()` now, Express 5 later).
- `worker.js`: `tick()` is already async; just `await` the db calls.
  `resolveWorkerConfig`/`getBoardPrompt` become async (one extra await in tick).
- `mintlink.js`: connect via `DATABASE_URL`; run as
  `docker compose exec app node server/mintlink.js <email>`.

### 3. Transactions and the queue claim

- better-sqlite3's sync `db.transaction(fn)` → an async helper:
  `withTx(pool, async (client) => {…})` doing checkout + BEGIN/COMMIT/ROLLBACK.
  Needed in: `mintPermanentInvite`, `setBoardMembers`, `deleteBoard` (and the ETL).
  The manual-cascade transactions mostly disappear thanks to FKs.
- **`claimNextPending` must change shape.** The current SELECT-then-UPDATE inside
  a transaction is only safe because SQLite has one writer. Postgres idiom, safe
  under any concurrency:

  ```sql
  UPDATE images SET status='processing', updated_at=$1
  WHERE id = (
    SELECT id FROM images WHERE status='pending'
    ORDER BY created_at ASC, id ASC LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
  ```

- `ON CONFLICT` clauses (`seedAdmin`, `bumpUsage`, `setSetting`) port as-is —
  SQLite copied Postgres syntax. `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`.
- Identity columns: `INTEGER PRIMARY KEY AUTOINCREMENT` →
  `BIGINT GENERATED ALWAYS AS IDENTITY`.

## Data migration (one-time ETL)

Small script (`scripts/sqlite-to-pg.js`, kept out of the image): opens the droplet's
`data.db` read-only with better-sqlite3, inserts into Postgres table by table.

- **Preserve IDs verbatim** — `favorites`, `crate_images` reference `images.id`;
  `sessions`/`invites`/`crates` reference `users.id`. Use
  `OVERRIDING SYSTEM VALUE`, then `setval()` each identity sequence to `MAX(id)`.
- Convert 0/1 → boolean, TEXT JSON → JSONB in the script.
- **Copy `sessions` too** — everyone stays logged in through the cutover.
- Order: users → boards → board_members → images → invites → sessions → favorites
  → crates → crate_images → ai_usage → settings (respects FKs).
- Rehearse locally first against a copy of the production `data.db` (scp it down);
  verify with row counts per table + spot-check `/api/images` output diff between
  old and new servers.

## Rollout sequence

1. **Code first, local.** Rewrite db.js on pg + async-ify call sites. Run Postgres
   alone via compose for dev; app on host. Everything testable locally before any
   Docker packaging.
2. **Package.** Dockerfile (`npm ci` inside the image — local `node_modules` has
   win32 sharp binaries, never COPY it), compose file, Caddyfile, `.env.example`.
3. **Droplet prep.** 458 MB with no swap will not run Docker + Postgres + Node +
   Caddy — see risks. Resize or add swap *before* cutover.
4. **Cutover** (order matters, downtime ~minutes):
   stop the systemd service → snapshot the droplet → copy `data.db` +
   `gallery/`/`thumbnails/` into the compose volumes → run ETL → `compose up -d` →
   verify health/login/upload/tagging → point DNS/ports at compose-Caddy →
   disable old systemd unit + host Caddy site.
5. **Cleanup.** Drop better-sqlite3 dep, delete legacy migration code, retire
   `deploy.py` (replaced by image deploys), nightly `pg_dump` cron into the volume
   (the old "copy the db file" backup no longer works).

Deploy story after this: build the image in GitHub Actions on push → push to GHCR
(repo is already private on GitHub) → droplet runs `compose pull && compose up -d`.
Building on the droplet itself is the fallback if Actions feels like overkill, but
image builds on a 458 MB box are asking for OOM.

## Risks / gotchas

- **Droplet memory is the #1 practical risk.** Node was already OOM-killed once
  under bulk upload on this box. Postgres (even tuned: `shared_buffers=32MB`,
  `max_connections=20`) + dockerd (~70 MB) + Node + Caddy won't fit in 458 MB.
  Plan on resizing to 1 GB, or at minimum adding a 1 GB swapfile and keeping the
  sharp serialization guards exactly as they are.
- **Express 4 async error handling** — miss one `wrap()` and a DB error becomes a
  process crash instead of a 500. Grep-able, but be systematic.
- **BIGINT-as-string** silently breaks every `expires_at < Date.now()` comparison
  if the type parser isn't set. Set it in the pool module, day one.
- Per-request latency: `attachUser` does 1–2 queries per request, now a socket
  round-trip instead of an in-process call. Localhost-in-compose is sub-ms;
  irrelevant at this scale, just don't add per-request connections (use the pool).
- ETL id/sequence mistakes surface later as duplicate-key errors on insert —
  the `setval()` step is easy to forget and must cover every identity column.
- WAL files: copy `data.db` for the ETL only after stopping the service (or use
  `sqlite3 .backup`) so the `-wal` contents are included.

## Effort

Roughly 2–3 focused days: db.js rewrite + async conversion is a solid day, ETL
script and local rehearsal half a day, Docker/compose/Caddy half a day, droplet
prep + cutover + verification half a day.
