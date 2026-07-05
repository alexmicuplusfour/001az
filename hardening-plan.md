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

- [x] **Tests + `npm test`** (2026-07-05). `node:test`, no new runtime dep.
      `test/helpers.js` spins up a throwaway Postgres db + in-process server per
      test file (made possible by an entry-point guard in `server.js` — it
      exports `app`/`db` and only listens when run directly). Shipped:
      `test/access.test.js` (the full board-access matrix — the Tier 1 behaviors,
      now regression-locked: outsider/foreign-member/anon denials, member+admin
      allows, cross-board crate, static-asset auth, NaN-id, tag-value filtering)
      and `test/prompt.test.js` (`buildPrompt` schema generation, incl. the
      `fit`-clobber edge). 16 tests, green. Still open: queue state-machine tests
      (`cancelBoardQueue`/`queueUntagged`/`failOrRequeue`) and a board-type
      adapter contract test (register a fake type; assert core never reads
      payload) — both higher-value once the second type lands.
- [x] **CI** (2026-07-05). `.github/workflows/ci.yml`: `test` job (Postgres 17
      service, `npm ci && npm test`) + `build` job (`docker build`). Lint step to
      add once a linter is chosen.
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

Deep-dived 2026-07-05. Ordered by leverage (cheap correctness first). Nothing
here is fixed yet.

- [x] **Graceful shutdown** (2026-07-05). `server.js` keeps the `startWorker`
      return value and installs `SIGTERM`/`SIGINT` handlers: stop claiming, close
      the listener, end SSE `logClients`, `closeAllConnections()`, race the
      in-flight tick against a 5s cap, then `db.end()`. `startWorker`'s stop fn now
      returns the loop promise and its poll sleep is interruptible, so shutdown
      doesn't wait out a poll. Verified in-container: `docker compose stop app`
      dropped from ~10s (SIGKILL) to **460ms**, logging `SIGTERM: shutting down`.
- [x] **`app.set('trust proxy', 1)`** (2026-07-05). In place; `req.ip` is now the
      real client behind Caddy.
- [x] **Security headers / CSP** (2026-07-05). One Express middleware sets CSP +
      `X-Content-Type-Options: nosniff` + `Referrer-Policy: same-origin` on every
      response (covers compose and droplet uniformly; verified through Caddy).
      Both inline page scripts were externalized so `script-src 'self'` holds
      with no hash/nonce: `logs.html` → `logs.js`, and `admin.html` → `admin.js`
      (the initial per-page inline-script count missed `<script type="module">`;
      admin's block tripped CSP in the browser and was moved out after the fact).
      Policy allows Google Fonts
      (`style-src`/`font-src`), `img-src 'self' data: blob:` (admin chevron SVG +
      upload object URLs), `'unsafe-inline'` styles (admin's inline attrs), and
      `object-src/frame-ancestors 'none'`. Regression-tested in `access.test.js`.
      HSTS still belongs at Caddy where TLS terminates — not yet added.
- [x] **Hash session + invite tokens at rest** (2026-07-05). `db.js` stores only
      `sha256(token)` (hex) for sessions and invites and hashes the incoming value
      on lookup; raw tokens live only in the cookie / minted URL. The one-time
      in-place migration in `initDb` (`UPDATE … SET id = encode(sha256(id::bytea),
      'hex') WHERE length <> 64`) proved non-breaking against the live DB: 16
      sessions + 2 invites hashed, yet the pre-existing session cookie still
      authenticated and the already-minted invite link still redeemed. Round-trip
      regression-tested (`access.test.js`).
- [x] **Stopped handing every user's token to the admin page** (2026-07-05).
      `listUsers` no longer returns `link_token` (it's a hash now anyway);
      `admin.html` mints on demand via the existing `POST /users/:id/link`.
- [~] **AI keys plaintext in Postgres** (`ai_keys.api_key`). Raw key never leaves
      the server (list endpoint returns only a last-4 hint — good), but it's
      readable in any dump. **README now documents the caveat** (2026-07-05).
      Envelope encryption (AES-256-GCM, master key from an env var, decrypt in
      `getAiKey`/`resolveDefaultAi`/`testKey`) is the real fix, still deferred —
      low urgency for single-tenant self-hosted.
- [x] **Rate limiting** (2026-07-05). `server/ratelimit.js` — dependency-free
      fixed-window limiter keyed on `req.ip` (real client via `trust proxy`), lazy
      pruning so no cleanup timer. `/auth/:token` at 30/15min, `/api/upload` at
      60/min. Verified in-container (31st `/auth` hit → 429 + `Retry-After`) and
      unit-tested (`ratelimit.test.js`: cap, per-IP isolation, window reset).
- [x] **Request logging** (2026-07-05). Middleware logs one line per request
      (`METHOD status ms path`) through the console patch, so it reaches the SSE
      viewer; skips the SSE stream itself and successful static-asset noise.
      `pino`/`pino-http` remains the upgrade path if structured logs are wanted.
- [~] **Backups.** README now documents the approach (`pg_dump` + uploads-volume
      tar of `appdata`/`pgdata`, with a restore path) (2026-07-05). Actually
      wiring a scheduled job is still an ops task, not code.

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
