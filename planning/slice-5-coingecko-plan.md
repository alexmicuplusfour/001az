# Slice 5 — CoinGecko connector

Self-contained implementation plan. Parent design: `pipeline-boards-plan.md`.
Proves the connector architecture before finnhub/stocks: no API key needed,
real-time data that AI can't fabricate, natural search-as-ingestion.

## What this slice ships

A CoinGecko connector that drives the full connector model end-to-end:

- **Connector registry** — `server/connectors/` with a tiny manifest/search/fetch contract
- **Mapping shape additions** — `input`, `identity.from: "connector"`, field `from: "connector"` with `fn`
- **Search-as-ingestion** — the plus button opens a coin search when the board has a connector input mapping; picking a coin creates an entity with bound fields (no file upload, no extract leg)
- **Bound field provenance** — `payload.fields[key].src = "coingecko"`; Details panel shows a connector badge
- **Mapping modal: template loading** — a "Load template…" button applies the connector's default mapping in one click; connector fields render locked with a badge
- **Number formatting** — price, market cap, and percentage rendered readably in the Details panel

Out of scope for this slice: `gather_every_min` liveness loop, generated chart face, connector settings UI (CoinGecko needs no key), `field_snapshots`, multiple connectors per board.

## CoinGecko API (no auth required for basic endpoints)

```
GET https://api.coingecko.com/api/v3/search?query=bitcoin
→ { coins: [{ id, name, symbol, thumb, market_cap_rank }] }

GET https://api.coingecko.com/api/v3/coins/{id}
    ?localization=false&tickers=false&market_data=true
    &community_data=false&developer_data=false
→ { id, name, symbol, market_data: { current_price, market_cap,
    price_change_percentage_24h }, links: { homepage } }
```

Rate limit: ~30 req/min on the free tier — fine for the use case (one fetch per entity at creation, no liveness yet).

## Mapping shape (additions)

```js
// Full shape for a CoinGecko board:
{
  input: { connector: "coingecko" },   // NEW: plus button opens connector search
  identity: { from: "connector" },      // NEW: identity = connector's entity id
  fields: [
    { key: "price",      kind: "number", from: "connector", fn: "price" },
    { key: "market_cap", kind: "number", from: "connector", fn: "market_cap" },
    { key: "change_24h", kind: "number", from: "connector", fn: "change_24h" },
    { key: "url",        kind: "url",    from: "connector", fn: "url" },
  ],
}
// gather_every_min added to boards table now, liveness loop deferred
```

`validateMapping` additions:
- `mapping.input`: optional; when present, must be `"files"` or `{ connector: string }`; connector name must exist in registry
- `mapping.identity.from`: gains `"connector"` option; when connector, no hint required
- Field `from: "connector"`: gains `fn` string (the connector function name); `hint` disallowed on connector fields

## Data model

New column (already in parent plan schema):
```sql
ALTER TABLE boards ADD COLUMN IF NOT EXISTS gather_every_min INTEGER;
```

`payload` additions — no new columns:
```js
payload = {
  identity,     // connector's normalised id e.g. "bitcoin"
  display_name, // connector's display label e.g. "Bitcoin"
  symbol,       // NEW: short ticker/symbol for display e.g. "BTC" (stored top-level for card face)
  files: [],    // always empty for connector entities (no uploaded files)
  fields: {
    price:      { v: 45123.45, src: "coingecko" },  // src is new — replaces "why" for connector fields
    market_cap: { v: 890000000000, src: "coingecko" },
    change_24h: { v: -2.4, src: "coingecko" },
    url:        { v: "https://www.coingecko.com/en/coins/bitcoin", src: "coingecko" },
  },
  mapping,      // stamped at creation as today
}
```

## Server

### `server/connectors/index.js` (new)

Tiny registry — explicit imports, no dynamic loading:

```js
import * as coingecko from "./coingecko.js";
const CONNECTORS = { coingecko };
export const getConnector = (name) => CONNECTORS[name] || null;
export const listConnectors = () =>
  Object.entries(CONNECTORS).map(([name, c]) => ({ name, ...c.manifest }));
```

### `server/connectors/coingecko.js` (new)

```js
export const manifest = {
  label: "CoinGecko",
  description: "Cryptocurrency prices and market data",
  fields: [   // what this connector can bind; drives the mapping modal
    { key: "price",      kind: "number", fn: "price",      label: "Price (USD)" },
    { key: "market_cap", kind: "number", fn: "market_cap", label: "Market cap (USD)" },
    { key: "change_24h", kind: "number", fn: "change_24h", label: "24h change (%)" },
    { key: "url",        kind: "url",    fn: "url",        label: "CoinGecko page" },
  ],
  template: {   // default mapping applied by "Load template"
    input: { connector: "coingecko" },
    identity: { from: "connector" },
    fields: [
      { key: "price",      kind: "number", from: "connector", fn: "price" },
      { key: "market_cap", kind: "number", from: "connector", fn: "market_cap" },
      { key: "change_24h", kind: "number", from: "connector", fn: "change_24h" },
      { key: "url",        kind: "url",    from: "connector", fn: "url" },
    ],
  },
};

export async function search(query) { ... }  // returns [{ id, label, symbol, thumb }]
export async function fetchEntity(id) { ... } // returns { identity, display_name, symbol, fields }
```

`search` hits the CoinGecko search endpoint. `fetchEntity` hits the coins detail endpoint, builds the `fields` object with `src: "coingecko"` on each value.

### `server/server.js` — new routes

Mount alongside existing routes:

**`GET /api/connectors`** (requireAuth) — returns `listConnectors()`.

**`GET /api/connectors/:name/search`** (requireAuth) — proxies `connector.search(req.query.q)`. Board access not required for search (no board data involved).

**`POST /api/boards/:id/entities`** (requireAuth + board access) — creates a connector entity:
```
body: { connector: "coingecko", id: "bitcoin" }
```
- Validates board has `mapping.input = { connector }` matching the request
- Calls `connector.fetchEntity(id)`
- Builds payload: `{ identity, display_name, symbol, files: [], fields, mapping: board.mapping }`
- `insertItem(db, boardId, payload, board.auto_tag ? "pending" : "held")`
- Returns the new item row (same shape as upload response)
- On duplicate identity (unique index violation): 409 "entity already on this board"

No extract leg — connector fields are pre-populated. Goes straight to `pending` → tagger.

### `server/schema.sql`

Add `gather_every_min` to the `ALTER TABLE` block (even though liveness isn't implemented yet):
```sql
ALTER TABLE boards ADD COLUMN IF NOT EXISTS gather_every_min INTEGER;
```

## Client

### `kinds.js` — connector entity face

Connector entities have `files: []` and `payload.symbol`. The face is a simple styled tile showing the symbol:

```js
const connectorKind = {
  face(item) {
    const tile = document.createElement("div");
    tile.className = "connector-face";
    tile.textContent = item.symbol || "?";
    return tile;
  },
  openDetail(item) { openLightbox(item); },
};
```

`kindFor(img)` returns `connectorKind` when `img.kind === "connector"` (or `img.files.length === 0`).

The `listItems` response exposes `symbol: r.payload.symbol || null` alongside `name`, `identity` etc. `toItem` maps it through.

### `toolbar.js` / `upload.js` — plus button behavior

In `renderToolbar`, the plus button's `onClick` depends on `state.boardMapping?.input`:

```js
const connectorName = state.boardMapping?.input?.connector;
const onPlus = connectorName
  ? () => openConnectorSearch(connectorName)
  : () => triggerFilePicker();
```

The chevron still opens the mapping modal regardless.

### `connector-search.js` (new)

A search popover anchored to the plus button, using the existing `openDropdown` infrastructure:

```js
export function openConnectorSearch(connectorName) {
  // Opens a dropdown with a text input + results list.
  // Debounces input → GET /api/connectors/:name/search?q=...
  // Results: each row shows name, symbol, thumb (if available)
  // Click → POST /api/boards/:id/entities → item added to grid, toast fired
}
```

The search popover:
- Debounced input (300ms) — shows a spinner while in flight
- Results list: coin name, symbol, market cap rank for disambiguation
- Click → creates entity → "Bitcoin added" toast → grid updates (item appears in `inProgress()` then tags)
- Duplicate → "Already on this board" toast (from 409)

### `mapping-modal.js` — connector support

**"Load template…" button** — appears in the modal footer alongside Save. Opens a small dropdown listing available connectors (from `GET /api/connectors`). Selecting one:
1. Sets `identityFrom = "connector"` — identity row shows "Connector (CoinGecko)" locked
2. Replaces `fields` with the connector's template fields — locked rows with a "⟳ CoinGecko" badge instead of the kind/source selects
3. Sets `mapping.input = { connector: "coingecko" }` in the save payload

**Connector field rows** — locked: no key input, no editable selects. Show field label + kind + a small "⟳ coingecko:price" badge. No hint textarea (connector fields have no hint).

**Identity row** — when `identityFrom === "connector"`, the select is fixed to "Connector" and shows which connector.

**Save** — `mapping.input`, `identity: { from: "connector" }`, and connector fields all serialise correctly into the PATCH body.

### `lightbox.js` — connector field provenance

In `paintPanel`, field rows get a small badge when `fields[key].src` is set:

```js
if (fields[key].src) {
  const badge = document.createElement("span");
  badge.className = "lbp-field-src";
  badge.textContent = fields[key].src; // "coingecko"
  kv.appendChild(badge);
}
```

Number formatting: when `f.kind === "number"`, format the value readably:
- price → `$45,123.45` (Intl.NumberFormat with currency if ≥ 1, otherwise scientific)  
- market_cap → `$890B` (compact notation)
- change_24h → `−2.4%` (sign + percent)

But we don't have `f.kind` in the client fields object (it's not returned by the reasoning endpoint). Simpler: detect by key pattern OR return kind alongside `v`/`src` from the server. Add `kind` to the field values: `{ v, src, kind }` — written at entity creation time, alongside the value. `paintPanel` can then format by kind.

### State

`state.boardMapping` already includes `input` once the server returns it from `GET /api/boards/:id`. No state changes needed — the mapping is already in state.

## Tests (extend `test/extraction.test.js` or new `test/connectors.test.js`)

**`validateMapping`**: `input: { connector: "coingecko" }` valid; unknown connector → 400; `identity.from: "connector"` valid; field `from: "connector"` requires `fn`; hint disallowed on connector fields.

**`POST /api/boards/:id/entities`**: creates entity with correct payload shape; identity unique index — second add of same coin → 409; board without connector mapping → 400.

**`GET /api/connectors`**: returns manifest list (unit-testable without network).

**`GET /api/connectors/coingecko/search`**: mocked — asserts correct query forwarding and response shape.

No live CoinGecko calls in tests (same principle as no live AI calls).

## Verify (live)

1. Create a board with any facets (e.g. seniority, industry)
2. Open mapping modal → "Load template…" → CoinGecko → Save
3. Plus button now opens coin search — type "Bitcoin", results appear
4. Pick Bitcoin → entity appears in grid with BTC symbol face, fields populate, tagger runs
5. Pick Ethereum → second entity, separate
6. Try adding Bitcoin again → "Already on this board" toast
7. Open Details panel — Fields section shows price/market_cap/change_24h/url with "coingecko" badge; numbers formatted readably; URL is a clickable link
8. Reopen mapping modal — connector fields show locked rows with CoinGecko badge
9. Confirm a plain board (no connector mapping) still uses file picker as before

## Risks / notes

- CoinGecko free tier: ~30 req/min. Fine for manual use; would need backoff if liveness is ever added at scale.
- `gather_every_min` column ships now so migration is in place when liveness is built.
- Connector entities have no files — `kindFor` must gracefully handle `files: []` without crashing the card face pipeline.
- The unique index (`board_id, payload->>'identity'`) uses the CoinGecko `id` (e.g. "bitcoin") as the key. This is stable — CoinGecko IDs don't change.
- Number formatting for `kind` requires returning `kind` alongside `v`/`src` in the field values. Update `payload.fields[key]` shape to `{ v, src?, kind?, why? }` at entity creation and in the reasoning endpoint response.
