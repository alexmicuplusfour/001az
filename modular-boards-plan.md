# Modular Boards — Universal Comparator Plan

The gallery becomes a universal comparator: a board has a **type** (images, stocks, docs, products, …), and the type decides how items get in, what the AI sees when tagging, and how a card renders. Everything else — facets, tags, filters, crates, hearts, bulk ops, undecided, admin, usage tracking — is core and identical across types. The stocks board is the second type and the proof of the interface.

Why this is cheap: the core is already ~80% type-blind. Boards own their facets/context/glosses, tags are generic `facet/value` strings, and the worker builds its prompt entirely from board config. The image-specific surface is four spots: the `images` table's filename columns, the upload route + sharp pipeline, the worker's "read webp, send image block" step, and the card/lightbox rendering.

---

## Design rules

1. **Core never knows what an item is.** All type-specific data lives in a `payload` JSON column. Core passes payload through to the adapter; it never reads inside it.
2. **One board = one type**, set at creation, immutable. Per-item types would poison every render and filter path for no benefit.
3. **The insulation test:** adding a new type (e.g. docs) touches zero core files — one adapter file on the server, one on the client, one registry line each. If a new type needs a core edit, the interface leaked and should be fixed before the type ships.
4. Types may *suggest* facet presets at board creation, but boards keep owning their facets exactly as today. The per-board facet system in `server/db.js` is already the right ownership model; it does not move into types.
5. **The adapter contract is treated as a public API from day one** — versioned, documented, and reachable only through `ctx` — even while every adapter lives in-repo. That discipline costs nothing now and is the entire difference between "refactor" and "rewrite" if third-party plugins happen later.

---

## Data model

Postgres conventions per `server/schema.sql`: BIGINT IDENTITY ids, JSONB blobs, real booleans, ms-epoch BIGINT timestamps, FKs with ON DELETE CASCADE.

```sql
-- images → items (rename + generalize)
CREATE TABLE IF NOT EXISTS items (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',    -- pending | processing | tagged | failed
  tags          JSONB NOT NULL DEFAULT '[]',        -- latest snapshot, same format as today
  undecided     BOOLEAN NOT NULL DEFAULT FALSE,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  payload       JSONB NOT NULL DEFAULT '{}',        -- type-specific; see below
  refresh_after BIGINT,                             -- next cheap data refresh (NULL = never)
  retag_after   BIGINT,                             -- next AI retag (NULL = never)
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

-- boards gain a type and their own AI config (NULL = inherit global)
ALTER TABLE boards ADD COLUMN IF NOT EXISTS type    TEXT NOT NULL DEFAULT 'image';
ALTER TABLE boards ADD COLUMN IF NOT EXISTS model   TEXT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS api_key TEXT;

-- usage counter becomes per-board. Visibility only — the daily cap is
-- REMOVED (no enforcement anywhere); this just lets admin see spend per board.
CREATE TABLE IF NOT EXISTS ai_usage_v2 (
  day      TEXT NOT NULL,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, board_id)
);

-- judgment history (see Liveness)
CREATE TABLE IF NOT EXISTS tag_snapshots (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id   BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tags      JSONB NOT NULL,
  undecided BOOLEAN NOT NULL DEFAULT FALSE,
  tagged_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item ON tag_snapshots(item_id, tagged_at);
```

Migration mechanics: `schema.sql` stays the fresh-install truth; changes to live instances ride as idempotent guards in `initDb` (`ADD COLUMN IF NOT EXISTS` is native Postgres; the `images` → `items` rename — table plus `favorites.image_id`/`crate_images.image_id` columns — is a one-time function gated on a `to_regclass('items')` check). Postgres DDL is transactional, so each migration step is atomic — a real upgrade over the SQLite try/ALTER style this plan originally assumed.

Payloads:

- **image**: `{ "filename", "original_name", "w", "h" }` — migration moves the existing columns in.
- **stock**: `{ "ticker", "name", "series": {"d": [...daily closes ~1y], "w": [...weekly ~5y]}, "fundamentals": {...}, "fetched_at" }` — a few KB per stock.

Payload being JSONB is a quiet win over the original SQLite plan: core still treats it as opaque, but adapters get real queries through the ctx facade when they need them (`payload->>'ticker'`, expression indexes) instead of parse-everything-in-JS.

`favorites`, `crate_images`, `tag_snapshots` reference `item_id`; existing rows carry over unchanged (ids are preserved by the migration).

---

## Server adapter contract

`server/types/<type>.js`, registered in `server/types/index.js`. Core imports only the registry.

```js
export default {
  type: "stock",

  // Mounts ingestion + any type-owned endpoints under /api/types/stock/*.
  // Image adapter takes over /api/upload and thumbnail static serving.
  mountRoutes(app, ctx),

  // The one worker seam. Returns the user-message content blocks for the
  // tagging call, plus optional extra tools (e.g. web_search for stocks).
  // Core keeps: system prompt from facets, tool schema, tag validation,
  // undecided guard, retries, prompt cache.
  async buildModelInput(item, ctx),   // -> { content: [...], extraTools?: [...] }

  // Optional. Cheap non-AI data refresh (stock prices, product availability,
  // doc re-fetch). Mutates payload; core stamps refresh_after. Absent = static type.
  async refresh(item, ctx),

  // Optional cleanup on item delete (image adapter removes files/thumbnails).
  async onDelete(item, ctx),

  // Optional facet presets offered at board creation (suggestion only).
  suggestedFacets,
};
```

`ctx` is a **narrow facade, not the raw DB handle** — this is the plugin discipline (see Plugin architecture below). Roughly:

```js
ctx = {
  items: { create(boardId, payloads), get(id), updatePayload(id, patch) }, // scoped to the adapter's boards
  settings: { get(key), set(key, value) },   // namespaced per type: "stock.api_key"
  storage: { dir },                          // per-type file storage (image adapter's gallery/thumbs)
  log(msg),
}
```

Adapters import nothing from core; core imports only the registry. If an adapter needs something ctx doesn't offer, extend ctx deliberately — never punch through.

### Worker seam (the cut that matters)

In `server/worker.js`, `tagOne()` currently reads the webp and builds the image message inline. That block becomes:

```js
const { content, extraTools } = await adapter.buildModelInput(row, ctx);
const msg = await client.messages.create({
  model, max_tokens, system,
  tools: [tool, ...(extraTools || [])],
  tool_choice: { type: "tool", name: "tag_screenshot" },
  messages: [{ role: "user", content }],
});
```

Everything else in the worker — claim/requeue/stuck recovery, per-board prompt cache, facet→schema building, allowed-tag validation, the undecided-vs-filled-facets guard — is already type-blind and does not move.

### Per-board AI config

Model and API key become board-level with fallback: **board → global settings (admin UI) → env**. Different types want different models (images are fine on Haiku; stock narrative facets want Sonnet), and a separate key per board separates spend per project/collaborator.

Worker changes this forces:

- **Resolve config per item, not per tick.** `resolveWorkerConfig()` currently runs once before claiming; it must run *after* `claimNextPending()`, from the claimed item's board. If resolution yields no key at all, requeue the item (don't fail it — a key can be added later) and skip that board in subsequent claims for the tick.
- **Client cache becomes a map.** `getAiClient` caches one client keyed by the last key; make it `Map<apiKey, client>` (bounded — a handful of keys at most).
- The per-board prompt cache already exists and now also carries the resolved model; invalidate on board PATCH as today.
- **The daily cap goes away entirely.** Remove `DAILY_CAP`, the `usageToday` gate, and the once-a-day cap warning from the worker — a small core deletion. Also drop the `DAILY_CAP` passthrough from `docker-compose.yml` and `.env.example`. Keep `bumpUsage` but count per `(day, board_id)` purely for admin visibility (per-board keys make "which board is spending what" worth seeing). With no cap, the retag cadence is the only thing bounding recurring spend — set per-type defaults conservatively (monthly).

Admin UI: board create/edit gains a model picker and an optional key field. Board API responses never echo the raw key — return `has_key: true` / last-4 masking, same treatment the global ai-config endpoint should get. Keys live in the DB like the current settings-stored key; same trust model.

Note on `tool_choice` + web search: a forced tool choice prevents the model from calling web_search first. For stocks, drop `tool_choice` to `{type: "auto"}` when `extraTools` is present and require the tagging tool call in validation instead (retry path already exists). Also expect stock tagging to want a stronger model than Haiku — model is already a per-install setting; consider making it a per-board override later.

### Route changes

- `/api/images` → `/api/items` (list), `/api/items/:id/tags|favorite|hearts|reprocess`, `DELETE /api/items/:id`. Keep `/api/images*` as thin aliases until the client is migrated, then delete the aliases.
- `POST /api/upload` moves into the image adapter (`mountRoutes`), path unchanged.
- New: `POST /api/types/stock/items` `{ boardId, tickers: ["INTC","MRNA","RIVN"] }` — resolves each ticker via the stocks API, writes items with payload + `status='pending'`, worker picks them up like any upload.

---

## Client adapter contract

`types/<type>/index.js`, registered in `types/index.js`. The board's type is known at load; look the adapter up once and hand it to the render path.

```js
export default {
  type: "stock",
  renderCardBody(item),  // element inside the card frame (image type: the <img>)
  openDetail(item),      // click-through view (image type: openLightbox)
  ingestUI(board),       // how items enter (image type: the dropzone from upload.js)
};
```

What stays core, verified against current code:

- `grid.js` masonry layout measures `offsetHeight` — content-agnostic. Card **chrome** (hover actions, tag chip, heart, bulk checkbox, crate popover) is all id/tag-based — core. Only `cardFor()`'s `<img>` guts and the lightbox click move into the image adapter.
- `data.js` polling/reconcile is generic apart from the endpoint name and `toImage()` (rename `toItem`, keep payload opaque).
- `filters.js`, `toolbar.js`, `bulk.js`, `crates.js`, `tag-editor.js`, `state.js` — untouched.
- `upload.js` and `lightbox.js` stop being core; they become the image adapter's `ingestUI`/`openDetail`.

### Stock card

Half chart / half text. The chart is drawn client-side on a canvas from `payload.series` — no charting library needed for a line + fill. The **period selector (5y / 1y / YTD / 3mo) is board-level**, not per-card: comparing cards is the point, and mixed periods across cards defeats it. The selector lives in the stock adapter's toolbar contribution; core never learns periods exist. Text half: ticker, name, price + period delta, and 2–3 headline tags.

---

## Plugin architecture (community modules, self-hosted instances)

The model if this takes off: the app is an open-source project people **deploy themselves**, and board types are **modules published on GitHub/npm** that a deployer installs into their own instance. The adapter contract above *is* the module API — no second interface gets designed later.

This trust model is the easy one, and it's worth being explicit about why: a module runs only on the instance of whoever chose to install it. That's the ordinary open-source dependency relationship (same standing as any npm package you add), so there is **no sandboxing, marketplace, signing, or permission system to build** — the deployer vets what they install, on their own box, with their own keys. The hard problems of a hosted plugin platform simply don't exist here.

### In the refactor (costs almost nothing, hard to retrofit)

- **Manifest + version.** Each adapter (server and client) exports `{ apiVersion: 1, type, name, version, capabilities: { refresh?, extraTools? } }` next to its hooks. The registry validates on load and refuses adapters with an unknown `apiVersion` instead of failing at runtime mid-tag. `apiVersion` is the compatibility mechanism across an ecosystem you don't control — bump it consciously, document breaking changes.
- **Namespaced type ids.** Built-ins get bare ids (`image`, `stock`); community types are `vendor.name` (e.g. `alex.crypto`). `boards.type` stores the full id, so two modules can't collide — critical because a board's items carry that module's payload shape forever.
- **ctx is the only door.** No raw DB handle, no core imports (see the ctx facade above). This is what makes a module's behavior knowable from its own repo: everything it can touch is in the contract.
- **Registry reads a config list, not hardcoded imports.** A module = one npm package (or a folder dropped next to the app) exporting the server adapter; the instance's config lists installed types. The client half is one ES module served statically — the app is build-less vanilla JS, which is accidentally a great module story: no bundler, a community type's UI is literally one file.
- Hooks stay **async and JSON-serializable** (payload in, content blocks out; no live objects or callbacks). Cheap discipline that keeps every future door open — including running a module out-of-process someday if anyone ever wants shared hosting.

### For the ecosystem (when the repo goes public / first outside builder)

- **The deploy story is mostly already built.** The Postgres/Docker migration shipped it: the compose stack (Caddy + app + Postgres, `.env.example`, healthchecks, volumes) means a stranger's path is `cp .env.example .env && docker compose up`. What remains is README polish — quickstart, first-admin/invite bootstrap, where uploaded data lives. `deploy.py` stays personal.
- **`PLUGIN.md` + a reference module.** The docs describe the two adapter shapes, ctx, payload rules, and lifecycle; a minimal example type (or a `create-board-type` template repo) is the highest-leverage artifact for getting anyone to actually build. Write both only after the stock adapter proves the interface.
- **Discovery by convention, not infrastructure:** an npm keyword / GitHub topic (e.g. `comparator-board-type`) and a list in the README. A registry website is a someday-problem.

## Liveness (core feature, not a stock feature)

Anything live decays: stock prices move, product prices/availability change, docs get edited upstream. Images just opt out. So liveness is core machinery that any adapter can plug into, as **two loops with very different costs**:

1. **Data refresh** — cheap, no AI. Core sweeps items where `refresh_after <= now` and the board's adapter has `refresh()`; calls it, bumps `refresh_after` by the board's cadence. Stocks: daily/weekly price series update. Products: price/stock check. Docs: re-fetch source URL, diff.
2. **AI retag** — expensive, goes through the normal worker. Core sweeps items where `retag_after <= now` and flips them to `pending`. Existing claim/retry machinery handles the rest with zero new code — and `claimNextPending` already uses `FOR UPDATE SKIP LOCKED` under Postgres, so the sweeps and any future second worker are concurrency-safe for free. Refresh runs before retag is due, so the AI always judges fresh data.

Cadences are per-board settings with per-type defaults (stocks: refresh daily, retag monthly; images: both NULL). With the daily cap removed, cadence **is** the spend control for recurring work — the retag sweep should also log how many items it flips, so a misconfigured cadence is visible in the logs rather than only on the bill.

**Snapshots make retagging valuable instead of destructive.** Every tagging result appends to `tag_snapshots`; `items.tags` stays the latest snapshot so all current filter/render code is untouched. History is what buys the interesting feature: thesis-at-buy vs. thesis-now ("what did the AI think of RIVN in July vs. December"). Without it, each retag silently deletes the best data the board produces. UI for viewing history can come much later; capturing it must start with the first retag.

---

## Stock type spec

- **Data source:** structured basics from a stocks API free tier (Finnhub or Alpha Vantage — pick at implementation time; key stored in settings like the Anthropic key). Fetches: name, sector, market cap, daily closes ~1y, weekly closes ~5y, a few fundamentals.
- **No scraping.** Narrative facets come from giving the tagging call the `web_search` tool and letting the model research the ticker itself. One call replaces a scraping subsystem; stock boards hold dozens of items, not thousands, so the cost is fine.
- **Model input** (`buildModelInput`): the 5y weekly chart rendered server-side (SVG → sharp rasterize; sharp is already a dep) + a text dossier from payload fundamentals + web_search enabled. The model sees the chart shape the same way a human does — that's the input the feeling-facets actually run on.
- **Suggested facets** (starting point; boards edit freely):
  - `thesis` — contrarian-bottom, turnaround, hype-ride, lottery-ticket, quiet-compounder, dividend-hold *(pick exactly one)*
  - `moat` — brand/social-capital, tech, network-effects, scale, none
  - `recognition` — household-name, sector-famous, obscure
  - `momentum` — beaten-down, basing, recovering, steady, extended *(chart-derived)*
  - `conviction-source` — fundamentals, narrative, gut, fomo
  - `cap` / `sector` — derivable from API data; could be stamped without AI at ingest time

---

## Migration sequence

Steps 1–4 are pure refactor — the app must behave identically after each, verified against the running instance before moving on. Features start at step 5.

1. **Schema:** `images` → `items` (+ `payload`, `refresh_after`, `retag_after`), move filename/original_name/thumb_w/thumb_h into `payload` JSONB, preserve ids and FK cascades (`favorites`/`crate_images` column renames ride along); add `boards.type` defaulting `'image'`; create `tag_snapshots`. Mechanics: update `schema.sql` for fresh installs + a one-time guarded migration in `initDb` for live DBs (transactional DDL makes it atomic; see Data model). Note the prod droplet is still on the pre-Docker SQLite stack — if the Docker/Postgres cutover hasn't happened there yet, fold this rename into that cutover's ETL and skip the live-DB migration path entirely.
2. **Server image adapter:** create registry (validates manifest/`apiVersion`) + `server/types/image.js`; move upload route, sharp pipeline, thumbnail serving, delete-cleanup, and the worker's image-message building into it; build the ctx facade. Rename routes with aliases.
3. **Client image adapter:** create registry + `types/image/`; move `upload.js` → `ingestUI`, `lightbox.js` → `openDetail`, the card `<img>` body → `renderCardBody`; switch fetches to `/api/items`, drop server aliases.
4. **Type plumbing + per-board AI config:** board creation UI gains a type picker, model picker, and optional API key; worker resolves key/model per claimed item's board (fallback board → global → env); daily cap removed (usage counted per `(day, board_id)` for visibility only); client resolves the adapter from `board.type`; suggested-facet presets wired in.
5. **Stock adapter (server):** stocks API client, ingest route, payload shape, chart rasterizer, `buildModelInput` with web_search, `refresh()`.
6. **Stock adapter (client):** card body with canvas chart, board-level period selector, ticker ingest UI, detail panel.
7. **Liveness:** refresh sweep, retag sweep, per-board cadence settings, snapshot append on every tag. (Snapshot writing can land as early as step 1–2 — it's cheap and starts accruing history immediately.)

Deferred / open:

- Snapshot-diff UI (thesis-then vs. now) — after real history exists.
- Docs/products adapters — only after stocks proves the interface; each should pass the insulation test.
- `PLUGIN.md` + reference module/template repo — write once the interface survives contact with the stock adapter (documenting it before then would freeze mistakes).
- Public deploy story (README quickstart, Dockerfile) — prerequisite for anyone else running an instance; see Plugin architecture.
- `tag_screenshot` tool name and "You tag images…" prompt wording generalize when the worker seam is cut (tool name: `record_tags`; prompt gets a per-type noun from the adapter).
