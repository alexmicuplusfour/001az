# Modular Boards — Universal Comparator Plan

The gallery becomes a universal comparator: a board has a **type** (images, stocks, docs, products, …), and the type decides how items get in, what the AI sees when tagging, and how a card renders. Everything else — facets, tags, filters, crates, hearts, bulk ops, undecided, admin, usage tracking — is core and identical across types. The stocks board is the second type and the proof of the interface.

Why this is cheap: the core is already ~80% type-blind. Boards own their facets/context/glosses, tags are generic `facet/value` strings, and the worker builds its prompt entirely from board config. The image-specific surface is four spots: the `images` table's filename columns, the upload route + sharp pipeline, the worker's "read webp, send image block" step, and the card/lightbox rendering.

## Status (2026-07-05)

Shipped ahead of the refactor, on the image-only codebase:

- **Per-board AI tagger, multi-provider** — named key registry (`ai_keys`: anthropic | openai) with per-board `ai_key_id`/`ai_model`, app-default pointer + env fallback; per-image resolution after claim; keyless boards hold their images pending; masked keys; `server/providers.js` drives both providers off one strict schema.
- **Reasoning** — the tagger writes a one-sentence justification per facet plus the fit verdict (`boards.ai_reasoning` → `images.tag_reasoning` JSONB), with reasoning declared *before* values in the schema so the model justifies first, selects second.
- **Scheduled retag** — `boards.auto_tag_*`: periodic whole-board requeue every N minutes, optional weekend skip; auto-tagging off = uploads wait as `held`.
- **Facet descriptions** — facets carry an optional `description`; the prompt gloss prefers it over the legacy hardcoded GLOSS table.
- **Per-board token usage** — `ai_board_usage` (call count + input/output/cache-read tokens) with a 14-day sparkline in admin.
- **Tag snapshots (2026-07-05)** — every tagging event appends `{source: 'ai'|'user', tags, reasoning, undecided, tagged_at}` to `tag_snapshots` (AI runs via `markTagged`, manual edits via `setImageTags`), so scheduled retags accrue history instead of overwriting it. Keyed `image_id` until the items rename; no UI yet.
- **Daily cap removed (2026-07-05)** — worker gate, compose/env passthrough, README row all deleted; `ai_board_usage` + the sparkline is the spend visibility, cadence is the control.
- **Migration step 1 (2026-07-05)** — `images` → `items` with the image columns folded into a `payload` JSONB (`{filename, original_name, w, h}`); `favorites.item_id`, `crate_images` → `crate_items.item_id`, `tag_snapshots.item_id`; `boards.type` (default `'image'`); UNIQUE(filename) carried over as an expression index. Live DBs migrate via a guarded transactional rename in `initDb` (verified on the real dev DB, 116 items); the sqlite→pg ETL writes the new shape directly. db.js function names (`listImages` etc.) intentionally unchanged — they get re-homed when the adapter forms in step 2. API shapes untouched; zero frontend changes.

Not started: adapters/registries, ctx, route renames, the type picker, the stock type, the refresh loop. Sections below are updated where a shipped piece changed the design (marked ✅).

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
-- images → items (rename + generalize). tag_reasoning (✅ shipped) rides along.
CREATE TABLE IF NOT EXISTS items (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',    -- held | pending | processing | tagged | failed
  tags          JSONB NOT NULL DEFAULT '[]',        -- latest snapshot, same format as today
  tag_reasoning JSONB NOT NULL DEFAULT '{}',        -- { facetKey: sentence, fit: sentence }
  undecided     BOOLEAN NOT NULL DEFAULT FALSE,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  payload       JSONB NOT NULL DEFAULT '{}',        -- type-specific; see below
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

-- boards: type is the only structural addition left — per-board AI config
-- (ai_key_id / ai_model / ai_reasoning) and the retag schedule (auto_tag_*)
-- ✅ shipped and are already in schema.sql. Data refresh gets a sibling cadence.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE boards ADD COLUMN IF NOT EXISTS refresh_every_min INTEGER;  -- NULL = static type

-- judgment history — ✅ shipped 2026-07-05 (in schema.sql keyed image_id,
-- with a source column: 'ai' = tagger run, 'user' = manual edit). The
-- image_id → item_id rename rides step 1. Post-rename shape:
CREATE TABLE IF NOT EXISTS tag_snapshots (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id   BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source    TEXT NOT NULL DEFAULT 'ai',
  tags      JSONB NOT NULL DEFAULT '[]',
  reasoning JSONB NOT NULL DEFAULT '{}',
  undecided BOOLEAN NOT NULL DEFAULT FALSE,
  tagged_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item ON tag_snapshots(item_id, tagged_at);
```

✅ **This data model shipped 2026-07-05** (migration step 1) exactly as above, except `refresh_every_min` — that lands with the refresh loop (step 7). Two earlier drafts of this plan are superseded by shipped work: per-item `refresh_after`/`retag_after` timers are gone (retag shipped **board-level** via `auto_tag_next_run_at`, and refresh mirrors that — a board's items share one staleness profile), and the planned `ai_usage_v2` table shipped richer as `ai_board_usage` (token counts split by input/output/cache-read, sparkline in admin) — nothing left to build there.

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

The multi-provider split (✅) already did half the work, and it strengthened the seam: `worker.js` owns prompt/schema building (including the reasoning object shape) and validation, while `providers.js#callTagger` owns wire formats and takes `{ systemText, schema, imageB64 }`. The remaining cut is small — `tagOne()` still reads the webp itself, and `callTagger`'s image parameter is image-specific:

```js
const { parts, research } = await adapter.buildModelInput(row, ctx);
// parts: provider-neutral content, e.g.
//   [{ kind: "image", b64, mediaType }, { kind: "text", text }]
const { input, usage } = await callTagger({ provider, apiKey, model, systemText, schema, parts, research });
```

`providers.js` maps `parts` to each provider's content blocks — it already does exactly this for the fixed image+text pair. Everything else — claim/requeue/stuck recovery, per-board prompt cache, facet→schema building (reasoning included), allowed-tag validation, the undecided-vs-filled-facets guard, the retag scheduler — is type-blind and does not move. The image-worded strings generalize with this cut: `TOOL_NAME`/`TOOL_DESC`/`USER_TEXT` in providers.js and "You tag images…" in `buildPrompt` take a per-type noun from the adapter manifest.

### Per-board AI config (✅ shipped 2026-07-04)

Shipped beyond the original spec: a **named key registry** (`ai_keys`: anthropic | openai) instead of a raw per-board key column, with `boards.ai_key_id` (FK, ON DELETE SET NULL) + `ai_model`, NULL inheriting the app default (settings pointer) with env as final fallback. Resolution runs per image *after* claiming, exactly as planned; boards with no resolvable key keep their images pending rather than failing them. Clients are cached per key in a Map, raw keys never leave the server (masked hints, per-key test buttons), and the board modal has the tagger/model pickers.

One consequence for the stock design: **research capability is per-provider.** The plan's web_search is an Anthropic server tool; OpenAI has its own web-search mechanism. So the adapter declares the *need* (`capabilities: { research: true }` in its manifest) and `providers.js` maps it to each provider's tool — with the adapter's own fetched dossier (e.g. headlines from the stocks API) as the provider-neutral fallback. Forced tool choice blocks research-before-tagging on both providers, so when research is on, tool choice relaxes to auto and validation requires the tagging call (the retry path already exists).

**✅ The daily cap is gone (2026-07-05):** worker gate (`usageToday`/`countPending` deleted with it), compose/env passthrough, README row. Spend visibility lives in `ai_board_usage` + the admin sparkline; retag cadence is the control on recurring work.

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

Anything live decays: stock prices move, product prices/availability change, docs get edited upstream. Images just opt out. Liveness is core machinery that any adapter can plug into, as **two loops with very different costs** — both board-level, since a board's items share one staleness profile:

1. **AI retag — ✅ shipped (2026-07-04), board-level.** `boards.auto_tag_periodic/every_min/skip_weekends/next_run_at`; `retagDue()` in the worker requeues the whole board each run, weekend runs roll forward keeping time-of-day, and queued counts are logged (the cadence-visibility ask from this plan shipped with it). Existing claim/retry machinery handles the rest — `claimNextPending` uses `FOR UPDATE SKIP LOCKED` under Postgres, so a future second worker is safe for free. This replaces the per-item `retag_after` sweep from earlier drafts.
2. **Data refresh — to build, mirroring the shipped pattern.** Cheap, no AI: `boards.refresh_every_min` (NULL = static type); a due board gets `adapter.refresh(item, ctx)` across its items to update payloads. Stocks: price series. Products: price/stock check. Docs: re-fetch source, diff. The one ordering rule: a board due for a scheduled retag refreshes first, so the AI always judges fresh data — cards may tolerate day-old prices, but a retag judging stale data is wasted spend.

Retag cadence UI already exists in the board modal; refresh reuses the same pattern with per-type defaults (stocks: refresh daily, retag ~monthly; images: both off). Once the daily cap is deleted, cadence **is** the spend control for recurring work — the shipped per-run queue logging and the usage sparkline are what make a misconfigured cadence visible.

**Snapshots make retagging valuable instead of destructive — ✅ capture shipped (2026-07-05).** Every tagging result appends `{source, tags, reasoning, undecided, tagged_at}` to `tag_snapshots` — AI runs as `source='ai'`, manual tag edits as `source='user'` (your own corrections are arguably the highest-value entries) — while `images.tags` stays the latest state so no filter/render code changed. Reasoning (✅) makes the history dramatically better than originally planned: thesis-then vs. thesis-now is literal stored sentences ("what did the AI say about RIVN's momentum in July vs. December"), not just facet values flipping. History is accruing from today; the timeline/diff UI stays deferred until there's something to look at.

---

## Stock type spec

- **Data source:** structured basics from a stocks API free tier (Finnhub or Alpha Vantage — pick at implementation time; key stored in settings like the Anthropic key). Fetches: name, sector, market cap, daily closes ~1y, weekly closes ~5y, a few fundamentals.
- **No scraping.** Narrative facets come from a research-capable tagging call — the adapter declares `research: true` and providers.js maps it to each provider's web-search tool (see Per-board AI config), with an adapter-fetched dossier (recent headlines via the stocks API) as the provider-neutral fallback. One call replaces a scraping subsystem; stock boards hold dozens of items, not thousands, so the cost is fine.
- **Model input** (`buildModelInput`): the 5y weekly chart rendered server-side (SVG → sharp rasterize; sharp is already a dep) + a text dossier from payload fundamentals, research enabled. The model sees the chart shape the same way a human does — that's the input the feeling-facets actually run on.
- **Keep `ai_reasoning` on (✅ exists) for stock boards.** The per-facet justification sentences *are* the thesis text — snapshotted over time, "Intel-as-you-saw-it-at-the-bottom" becomes stored prose, not just facet values.
- **Suggested facets** (starting point; boards edit freely). Each preset ships a `description` (✅ facets support them; the prompt prefers them over the legacy GLOSS fallback) — the feeling-facets are exactly the ones that need one, e.g. thesis: "the story you'd be buying — judge from the narrative, not the fundamentals":
  - `thesis` — contrarian-bottom, turnaround, hype-ride, lottery-ticket, quiet-compounder, dividend-hold *(pick exactly one)*
  - `moat` — brand/social-capital, tech, network-effects, scale, none
  - `recognition` — household-name, sector-famous, obscure
  - `momentum` — beaten-down, basing, recovering, steady, extended *(chart-derived)*
  - `conviction-source` — fundamentals, narrative, gut, fomo
  - `cap` / `sector` — derivable from API data; could be stamped without AI at ingest time

---

## Migration sequence

Steps 1–4 are pure refactor — the app must behave identically after each, verified against the running instance before moving on. Features start at step 5.

1. ✅ **Schema (2026-07-05):** `images` → `items` (+ `payload`; `tag_reasoning` rides along), image columns folded into `payload` JSONB, ids and FK cascades preserved, `favorites`/`crate_items`/`tag_snapshots` renamed, `boards.type` added. Fresh installs via `schema.sql`; live DBs via the guarded transactional migration in `initDb`; the sqlite→pg ETL writes the new shape for the droplet cutover.
2. **Server image adapter:** create registry (validates manifest/`apiVersion`) + `server/types/image.js`; move upload route, sharp pipeline, thumbnail serving, delete-cleanup, and the worker's image-message building into it; build the ctx facade. Rename routes with aliases.
3. **Client image adapter:** create registry + `types/image/`; move `upload.js` → `ingestUI`, `lightbox.js` → `openDetail`, the card `<img>` body → `renderCardBody`; switch fetches to `/api/items`, drop server aliases.
4. **Type plumbing:** board creation UI gains a type picker next to the shipped tagger/model pickers (✅ per-board AI config is done, ✅ cap deleted); client resolves the adapter from `board.type`; suggested-facet presets (with descriptions) wired in.
5. **Stock adapter (server):** stocks API client, ingest route, payload shape, chart rasterizer, `buildModelInput` returning provider-neutral parts with research enabled, `refresh()`.
6. **Stock adapter (client):** card body with canvas chart, board-level period selector, ticker ingest UI, detail panel.
7. **Liveness (what's left):** the retag schedule shipped (✅); remaining = the board-level `refresh_every_min` sweep with refresh-before-retag ordering. (Snapshots moved into step 1 — see above.)

Deferred / open:

- Snapshot-diff UI (thesis-then vs. now) — after real history exists.
- Docs/products adapters — only after stocks proves the interface; each should pass the insulation test.
- `PLUGIN.md` + reference module/template repo — write once the interface survives contact with the stock adapter (documenting it before then would freeze mistakes).
- Public deploy story (README quickstart, Dockerfile) — prerequisite for anyone else running an instance; see Plugin architecture.
- `tag_screenshot` tool name and "You tag images…" prompt wording generalize when the worker seam is cut (tool name: `record_tags`; per-type noun from the adapter manifest) — now split between `worker.js#buildPrompt` and the `TOOL_NAME`/`TOOL_DESC`/`USER_TEXT` constants in `providers.js`. The facet-gloss half of this already shipped as facet `description`s (the hardcoded GLOSS table is just the fallback now).
