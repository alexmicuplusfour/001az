# Hardening Plan

Findings from a full review (2026-07-05) of the server core, client, schema, and
deploy stack, ordered by what to fix first. Context: the app generalizes beyond
images (see `modular-boards-plan.md`), so "generalization pre-work" items are
scoped to land before the second board type.

Tier 1 (the authorization holes) was fixed and verified 2026-07-05 — safe to
publish as a changelog of closed issues.

## Tier 1 — Authorization gaps (fix first)

Threat model: the two gates are `requireAuth` (any valid session) and
`requireAdmin`. Board-level access is `canAccessBoard` — true for admins, or a
row in `board_members`. The realistic attacker is therefore a **non-admin,
invited member of board A acting on board B** (which they can't see in their
board list). Everything below is reachable by any such user. It's enforced on
`GET /api/items`, `PATCH /api/items/:id/tags`, and `GET /api/items/:id/reasoning`
already — the pattern exists, it just wasn't applied to the mutation/side-channel
routes.

Ranked by severity — **all fixed 2026-07-05**, verified live against the compose
stack with an authenticated zero-membership user (every attack 404/400/401,
admin controls all still 200):

- [x] **Delete any item on any board** — `DELETE /api/items/:id` now goes through
      `requireItemAccess` (see fix shape below).
- [x] **Static assets bypass the board ACL** — `/gallery` and `/thumbnails` now
      require a session (`ctx.auth.requireAuth` on the static mounts). Documented
      residual: *within* a session the 64-bit random filenames are the per-board
      barrier — filenames only surface through the board-ACL'd `/api/items`, so
      cross-board fetch requires a leaked filename. Full per-file board ACL
      (filename → item lookup per request) deliberately skipped: one extra DB
      round-trip per image request for a marginal gain. Revisit if boards ever
      hold genuinely sensitive material. ⚠️ Applies to the compose stack (Caddy
      proxies everything to the app); the legacy droplet serves these dirs from
      disk via Caddy and stays world-readable until its pg cutover.
- [x] **Upload to any board** — ctx gained `boards.canAccess(id, user)`
      (the one deliberate type-contract addition); the image adapter checks it
      before ingest, same 400 for missing and inaccessible boards, and now also
      unlinks multer's tmp spool files on refusal (pre-existing leak).
- [x] **Reprocess any item** — `requireItemAccess`.
- [x] **Heart / list hearts / crate-toggle any item id** — favorite + hearts on
      `requireItemAccess`; `POST /api/crates` checks board existence (admins
      previously got an FK 500) + access; the crate item-toggle route checks item
      access, and `toggleCrateImage` additionally enforces
      `item.board_id = crate.board_id` (a crate only holds items from its own board).

**Fix shape as shipped:** one `requireItemAccess` middleware in `server.js` —
validates `:id` is a positive integer (also fixing `NaN → Postgres 500`), loads
the item's `board_id`, checks `canAccessBoard`, answers 404 for missing and
forbidden alike (no id probing), attaches `req.itemId`/`req.itemBoardId`.
Applied to favorite / hearts / reasoning / tags / delete / reprocess; the
previously-inline checks in tags + reasoning (which answered 403) are gone.

Not an authz bug (reclassified to Tier 2 robustness): **facet-shape validation.**
Board create/PATCH are `requireAdmin`, so only an admin can submit a malformed
facet (missing `values`), and the worst case is that admin crashing their own
worker at `f.values.join` in `buildPrompt`. Still worth validating at the write
boundary (key/label strings, `values` = string array, unique keys, `fit`
reserved), but it's robustness, not a privilege gap.

## Tier 2 — Legitimacy table stakes

What devs check before reading a line of logic:

- [ ] **Tests + `npm test`.** Currently zero. Highest-leverage targets: the queue
      state machine (`held/pending/processing/tagged/failed`, `cancelBoardQueue`,
      `queueUntagged`), `buildPrompt` schema generation, tag validation in
      `tagOne`, and the auth/access matrix (would have caught Tier 1). Node's
      built-in `node:test` = no new dependency; route tests via supertest against
      the compose Postgres. A **contract test for board-type adapters** (register
      a fake type; assert core never reads payload; assert hooks fire) is worth
      more than any doc once outside builders arrive.
- [ ] **CI.** No `.github/`. One workflow: lint + test + `docker build` on
      push/PR. ~40 lines.
- [ ] **Lint/format config.** Nothing checked in. Biome (one tool, one config)
      fits a build-less vanilla-JS repo; ESLint+Prettier is the classic pick.
- [ ] **LICENSE.** Missing entirely — without it nobody can legally use or
      contribute once public. MIT/Apache-2.0 decision.
- [ ] **Facet-shape validation** (moved from Tier 1 — it's admin-only input, so
      robustness not authz). Board create/PATCH accept any array; a facet missing
      `values` doesn't fail at write time, it crashes the worker later at
      `f.values.join`. Validate at the boundary: key/label strings, `values` =
      string array, unique keys, `fit` reserved.
- [ ] **Repo hygiene:** `package.json` scripts point at `populate.js`/`serve.js`/
      `clear-tags.js` which are gitignored — a cloner's `npm run populate` hits a
      missing file. `better-sqlite3` sits in devDependencies only for the one-time
      ETL; comment or remove post-cutover.

## Tier 3 — Ops & security conventions

- [ ] **Graceful shutdown.** `startWorker` returns a stop fn that's never wired;
      no SIGTERM handler, so every deploy kills mid-tag (stuck-recovery masks it,
      but each deploy burns an in-flight call and strands a `processing` row for
      ~3 min). On SIGTERM: stop claiming, `server.close()`, `db.end()`.
- [ ] **Security headers.** No CSP / `X-Content-Type-Options` / `Referrer-Policy`
      / `frame-ancestors`. Cheapest as a Caddy `header` block; strict CSP is very
      doable since the frontend is dependency-free same-origin modules.
      (CSRF is already mostly covered: SameSite=Lax + all mutations non-GET.)
- [ ] **Hash tokens at rest.** Sessions and invite tokens stored raw — a DB dump
      yields live logins. Store `sha256(token)`, hash on lookup. Extra weight
      here: permanent invites are effectively passwords with a 100-year expiry.
- [ ] **AI keys are plaintext in Postgres.** Fine for self-hosted, but README
      should say so; envelope encryption with an env-provided key is the usual
      next step.
- [ ] **Rate limiting** on `/auth/:token` and `/api/upload`. Tokens are 192-bit
      random so brute force isn't practical, but an unthrottled unauthenticated
      endpoint gets flagged on sight.
- [ ] **Backups.** Nothing dumps Postgres or snapshots the uploads volume.
      `pg_dump` cron + documented restore path.
- [ ] **Request logging.** Console-patch + SSE ring buffer is fine for the live
      viewer, but there's no request logging (status/duration) or levels/structure.
      pino + pino-http; the SSE viewer can consume it just as well.

## Generalization pre-work (before the stock adapter)

Contract violations against the rules in `modular-boards-plan.md` — much cheaper
to fix before a second type exists:

- [ ] **Core reads inside `payload`.** `listImages` in `server/db.js` returns
      `name: r.payload.filename, w, h` — schema comment says core never reads
      inside payload. A stock item has no filename. Either return raw payload and
      let the client adapter project it, or add a `summarize(payload)` hook.
      Breaks on day one of the stock type.
- [ ] **Image-named core functions**: `countImages`, `listImages`,
      `reprocessImage`, `getImageBoard`, `setImageTags`, `boardImageStats`,
      `crates.image_count`, client `state.images`. Pure rename; do it while grep
      is still honest.
- [ ] **Prompt wording is image-hardcoded in the generic worker** —
      `buildPrompt`'s non-reasoning paragraph says "For each image…" and the fit
      descriptions say "the image" even though `subject` is parameterized.
- [ ] **Client unknown-type fallback renders the image adapter**
      (`types/index.js`) — an old client on a stock board requests
      `thumbnails/undefined.webp` per card. Fall back to a neutral
      "unsupported type" card instead.
- [ ] **`/api/upload` is a fixed path an adapter mounts** — two ingest-capable
      types collide. Namespace type routes (`/api/types/image/upload`) or have
      core own ingestion dispatch.

## Deliberately not doing (at this scale)

Pagination, TypeScript migration, a bundler, OpenAPI, Redis. The
load-everything-in-one-shot design is documented and correct for now, and
build-less vanilla JS is the plugin story.

## Suggested order

Tier 1 authz guards → LICENSE + lint + CI skeleton → tests around queue/auth →
graceful shutdown + headers → payload/naming generalization cleanup as the first
commit of the stock-adapter work.
