# 001az

Self-hosted, board-based collection tool with AI tagging, structured field
extraction, and live-data connectors. Drop in files (images, PDFs, docs,
spreadsheets) or track live entities; AI tags each item against the board's own
facet taxonomy, entities carry structured fields you can extract or pull live
from data sources, and the whole collection slices with faceted filtering and
semantic search. Node + Postgres + vanilla JS, invite-only.

It started as an image-inspiration gallery for a product redesign — bulk-upload
screenshots, auto-tag them into a custom vocabulary, filter by facet — and grew
into a general typed-board tool: each board defines what its items *are* (their
fields and tag facets), and items can be files you upload or entities backed by
a live connector.

## Features

- **Multi-format ingestion** — drag & drop images, PDFs, `.docx`, `.txt`,
  `.md`, and `.csv` anywhere, or use the upload button. Thumbnails and page-1
  previews are generated server-side (sharp for images, poppler for PDFs,
  mammoth for docx), originals type-sniffed and size-capped.
- **Automatic ingestion** — a board can feed itself from a source: a local
  watched folder (under a server-side ingestion root), a **remote file source**
  (FTP/FTPS or S3-compatible object storage, browsable in a modal), or a
  filter-defined slice of a connector's catalog (e.g. "top 50 by market cap")
  for crypto/stocks boards. Remote sources are **plugins** you add on the
  Plugins page, with reusable saved connections (credentials live once, boards
  reference them). Filters over the source's fields (file metadata, or catalog
  columns like price/rank/sector), sorting with a per-run limit, and a trigger
  schedule (continuous watch or interval/daily/manual) with a live results
  preview in the setup modal. One-directional and additive — source files are
  never touched, and a dedup ledger means deleting an item in the app doesn't
  resurrect it on the next run. Adapter-based: adding a file source is one
  backend module (list/fetch/test) in `server/ingestion/sources/`.
- **AI tagging** — a queue worker sends each item to a vision/text model. The
  tag vocabulary is enforced *structurally*: the tool's `input_schema` is
  generated from the board's facets, so the model cannot emit an invalid tag.
  Multi-provider — **Anthropic Claude, OpenAI, Gemini, GLM, and OpenRouter** —
  selectable per board, plus an optional web-research step. Retries, stuck-job
  recovery, and a concurrency cap included.
- **Entities & instances** — an entity is a thin row (its identity + structured
  fields) sitting above one or more per-file *instances*, each with their own
  fields and tags. Merge re-parents instances, split breaks them out, and both
  rename in place.
- **Data connectors** — map a board's fields to a live source and they refresh
  on their own. Domains include **crypto** (CoinGecko / CoinMarketCap) and
  **US stocks** (Financial Modeling Prep):
  per-field liveness (`live` + interval) with a scheduled refresh sweep,
  field-value snapshots, an "updated *N*m ago" stamp, and generated card
  *faces* (e.g. price-history charts). The runtime is domain-agnostic — a new
  domain is a single directory under `server/connectors/`, no runtime edits.
- **Semantic search** — embedding-backed search across the collection,
  alongside plain text search.
- **Faceted filtering** — within-facet OR, across-facet AND, with live counts
  per value. Manual tag editing in each card's tag popover.
- **Boards** — separate collections, each with its own facet taxonomy, field
  schema, tagging context, connector mapping, and member list. Per-board admins
  can edit board content without being global admins.
- **Crates & hearts** — personal per-board collections, plus shared favorites
  with hover attribution.
- **Infinite scroll** — metadata loads in one shot; cards mount and recycle in
  batches as you scroll, so filters, counts, and the lightbox always see the
  full collection.
- **Invite-only auth** — passwordless: an admin mints one-time login links;
  sessions are HttpOnly cookies. No email infrastructure needed.
- **Admin panel** — user management, board management, AI provider/model/key
  config, connector config, and live server logs over SSE.

## Architecture

```
Caddy ── TLS + reverse-proxy ──► Node/Express (server/server.js)
                                   ├── serves public/  (frontend)
                                   ├── serves /gallery + /thumbnails (auth'd)
                                   ├── Postgres (pg)
                                   ├── AI tagging worker (server/worker.js) ──► provider APIs
                                   └── connector runtime (server/connectors/) ──► live data APIs
```

- **Frontend**: dependency-free vanilla JS ES modules under `public/`, custom
  masonry layout, native lazy-loading.
- **Server**: Express + `pg`, single process. The app is the only file server;
  Caddy just terminates TLS and proxies.
- **State**: Postgres holds items, entities, users, sessions, invites,
  favorites, crates, boards, facets/fields, and settings. Uploaded originals and
  thumbnails live on disk (a Docker volume in production).

## Repo layout

| Path | What |
|---|---|
| `public/` | entire frontend — `index.html`/`app.js`/`styles.css` (gallery), `admin.html` (admin panel), `logs.html` (live log viewer), and the JS/CSS modules |
| `server/server.js` | Express routes + static serving |
| `server/db.js` | schema access + all queries |
| `server/worker.js` | AI tagging + connector-refresh queue poller |
| `server/providers.js` | AI provider descriptor registry (add a provider = one descriptor) |
| `server/connectors/` | data-connector runtime + domains (e.g. `crypto/`) |
| `server/ingestion/` | automatic-ingestion adapters (folder watching, connector feeds) + shared filter engine |
| `server/sources/` | per-format file handling (image/PDF/docx/text) |
| `server/auth.js` | session-cookie middleware |
| `server/mintlink.js` | CLI: print a login link for an email |
| `server/migrations/` | versioned schema migrations |
| `test/` | `node:test` suite |
| `scripts/` | one-off utilities (e.g. sqlite→pg import) |

`gallery/` (originals), `thumbnails/`, and the Postgres data are server-owned
runtime state and are not in git.

## Local development

The reference stack is Docker Compose (Caddy + app + Postgres). To run the app
directly against the compose Postgres:

```sh
npm install
docker compose up -d db          # Postgres on 127.0.0.1:5433
ADMIN_EMAIL=you@example.com COOKIE_SECURE=0 BASE_URL=http://127.0.0.1:3001 node server/server.js
```

Then mint yourself a login link:

```sh
BASE_URL=http://127.0.0.1:3001 node server/mintlink.js you@example.com
```

Open http://127.0.0.1:3001 and sign in with the printed link. To enable AI
tagging, set a provider key (`ANTHROPIC_API_KEY`, etc.) or configure one in the
admin panel.

### Tests

```sh
npm test
```

Built-in `node:test` runner (no extra dependency). The suite creates a throwaway
Postgres database per test file, so it needs a reachable Postgres whose role can
`CREATE DATABASE` — the compose `db` (on `127.0.0.1:5433`) works out of the box
locally; point elsewhere with `TEST_ADMIN_URL`. CI runs this against a Postgres
service on every push and PR (`.github/workflows/ci.yml`).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ADMIN_EMAIL` | — | seeded as admin on startup |
| `ANTHROPIC_API_KEY` | — | enables the tagging worker (admin-panel keys, for any provider, override) |
| `MODEL` | per board | tagging model; normally set per board in the admin panel |
| `DATABASE_URL` | `postgres://gallery:gallery@127.0.0.1:5433/gallery` | Postgres connection string |
| `BASE_URL` | `http://127.0.0.1:3001` | used in minted login links |
| `COOKIE_SECURE` | `1` | set `0` for plain-http local dev |
| `PORT` / `HOST` | `3001` / `127.0.0.1` | listen address |
| `STATIC_DIR` | `./public` | frontend assets directory |
| `INGEST_ROOT` | — (compose: `/data/ingest`) | root for watched ingestion folders; unset disables folder ingestion |

Tuning knobs (`TAG_CONCURRENCY`, `POLL_MS`, `MAX_ATTEMPTS`, `STUCK_MS`,
`EMBED_BATCH`, `REFRESH_BATCH`, `INGEST_CONTINUOUS_MS`, `INGEST_SETTLE_MS`,
`INGEST_RUN_CAP`, connector rate limits) have sensible defaults; see the top
of `server/server.js` and `server/worker.js`.

## Deployment

The reference setup is the Docker Compose stack (`docker-compose.yml`): Caddy
terminates TLS and reverse-proxies to the Node app, which serves the frontend
and its own `/gallery` + `/thumbnails` (both require a session), backed by
Postgres. `cp .env.example .env`, fill it in, `docker compose up -d`. Secrets
live in `.env`, never in the repo. `deploy.ps1` builds the image, ships it over
SSH (no registry), and restarts the stack.

## Security & operations

- **Sessions & invites are passwordless bearer credentials**, stored only as
  SHA-256 hashes; the raw value exists in the cookie / login URL. Serve over
  HTTPS in production (`COOKIE_SECURE=1`, a real `SITE_ADDRESS` so Caddy gets a
  cert).
- **Response headers**: the app sets a Content-Security-Policy,
  `X-Content-Type-Options`, and `Referrer-Policy` on every response. Add HSTS at
  Caddy once you're on HTTPS.
- **Rate limits**: `/auth/:token` (30 / 15 min) per client IP; connector calls
  are throttled per provider with a token bucket. `trust proxy` is on, so
  `req.ip` is the real client behind Caddy.
- **Graceful shutdown**: SIGTERM/SIGINT stop the worker, drain connections, and
  close the pool, so `docker stop` / redeploys don't kill a tag mid-flight.
- **AI keys are stored plaintext** in Postgres (only a last-4 hint is ever sent
  to the client). Fine for a single-tenant self-hosted box; if that's not your
  threat model, keep the DB and its backups access-controlled. Envelope
  encryption is a possible future step.
- **Backups**: uploads and database live in the `appdata` and `pgdata` volumes.
  Back them up together — e.g. `docker compose exec -T db pg_dump -U gallery
  gallery | gzip > db.sql.gz` plus a tar of the uploads volume — on whatever
  schedule matches how much you'd hate to re-tag. Restore = load the dump into a
  fresh db and restore the uploads volume.
