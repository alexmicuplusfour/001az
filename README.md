# 001az

Self-hosted image inspiration gallery with AI auto-tagging. Drop in screenshots, Claude tags them against your own facet taxonomy, then filter, favorite, and collect. Node + SQLite + vanilla JS, invite-only.

Built to mine UI inspiration for a product redesign: upload screenshots in bulk, get them auto-tagged into a custom vocabulary (nav pattern, view type, density, theme, scope, …), and slice the collection with faceted AND/OR filtering.

## Features

- **Bulk upload** — drag & drop anywhere or use the upload button; thumbnails generated server-side (sharp), originals type-sniffed and size-capped.
- **AI vision tagging** — a queue worker sends each thumbnail to the Claude API. The tag vocabulary is enforced structurally: the tool's `input_schema` is generated from the board's facets, so the model *cannot* emit an invalid tag. Retries, stuck-job recovery, and a daily cap included.
- **Faceted filtering** — within-facet OR, across-facet AND, with live counts per value. Manual tag editing available in each card's tag popover.
- **Boards** — separate collections with their own facet taxonomy, tagging context, and member list.
- **Crates & hearts** — personal per-board collections, plus shared favorites with hover attribution.
- **Infinite scroll** — all metadata loads in one shot (it's tiny); cards mount in batches of 60 as you scroll, so filters/counts/lightbox always see the full collection.
- **Invite-only auth** — passwordless: admin mints one-time login links; sessions are HttpOnly cookies. No email infrastructure needed.
- **Admin panel** — user management, board management, AI model/key config, live server logs over SSE.

## Architecture

```
Caddy ── serves index.html/app.js/styles.css + gallery/ + thumbnails/
   └── reverse-proxies /api/* and /auth/*  ──► Node/Express (server/server.js)
                                                 ├── SQLite (better-sqlite3)
                                                 └── tagging worker (server/worker.js) ──► Claude API
```

- **Frontend**: dependency-free vanilla JS (`app.js`), custom JS masonry layout, native lazy-loading.
- **Server**: Express + better-sqlite3, single process, systemd unit in production.
- **State**: one SQLite file (images, users, sessions, invites, favorites, crates, boards, settings).

## Repo layout

| Path | What |
|---|---|
| `index.html`, `app.js`, `styles.css` | gallery frontend |
| `admin.html`, `logs.html` | admin panel + live log viewer |
| `server/server.js` | Express routes |
| `server/db.js` | schema + all queries |
| `server/worker.js` | AI tagging queue poller |
| `server/auth.js` | session cookie middleware |
| `server/mintlink.js` | CLI: print a login link for an email |
| `facets.json` | default facet taxonomy (seeds the first board) |

`gallery/` (originals), `thumbnails/`, and the SQLite DB are server-owned runtime data and are not in git.

## Local development

```sh
npm install
ADMIN_EMAIL=you@example.com COOKIE_SECURE=0 BASE_URL=http://127.0.0.1:3001 node server/server.js
```

Then mint yourself a login link:

```sh
DB_PATH=server/data.db BASE_URL=http://127.0.0.1:3001 node server/mintlink.js you@example.com
```

Open http://127.0.0.1:3001 and sign in with the printed link. To enable AI tagging, set `ANTHROPIC_API_KEY` (or configure a key in the admin panel).

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
| `ANTHROPIC_API_KEY` | — | enables the tagging worker (admin-panel key overrides) |
| `MODEL` | `claude-haiku-4-5` | tagging model (admin-panel setting overrides) |
| `BASE_URL` | `http://127.0.0.1:3001` | used in minted login links |
| `COOKIE_SECURE` | `1` | set `0` for plain-http local dev |
| `PORT` / `HOST` | `3001` / `127.0.0.1` | listen address |
| `DATABASE_URL` | `postgres://gallery:gallery@127.0.0.1:5433/gallery` | Postgres connection string |

## Deployment

The reference setup is the Docker Compose stack (`docker-compose.yml`): Caddy terminates TLS and reverse-proxies to the Node app, which serves the frontend and its own `/gallery` + `/thumbnails` (both require a session), backed by Postgres. `cp .env.example .env`, fill it in, `docker compose up -d`. Secrets live in `.env`, never in the repo.

## Security & operations

- **Sessions & invites are passwordless bearer credentials**, stored only as SHA-256 hashes; the raw value exists in the cookie / login URL. Serve over HTTPS in production (`COOKIE_SECURE=1`, a real `SITE_ADDRESS` so Caddy gets a cert).
- **Response headers**: the app sets a Content-Security-Policy, `X-Content-Type-Options`, and `Referrer-Policy` on every response. Add HSTS at Caddy once you're on HTTPS.
- **Rate limits**: `/auth/:token` (30 / 15 min) per client IP. Uploads are not rate-limited (bulk drops arrive as many chunked requests); auth plus per-request file limits bound abuse. `trust proxy` is on, so `req.ip` is the real client behind Caddy.
- **Graceful shutdown**: SIGTERM/SIGINT stop the tagging worker, drain connections, and close the pool, so `docker stop` / redeploys don't kill a tag mid-flight.
- **AI keys are stored plaintext** in Postgres (only a last-4 hint is ever sent to the client). Fine for a single-tenant self-hosted box; if that's not your threat model, keep the DB and its backups access-controlled. Envelope encryption is a possible future step.
- **Backups**: the uploads and database live in the `appdata` and `pgdata` volumes. Back them up together — e.g. `docker compose exec -T db pg_dump -U gallery gallery | gzip > db.sql.gz` plus a tar of the uploads volume — on whatever schedule matches how much you'd hate to re-tag. Restore = load the dump into a fresh db and restore the uploads volume.
