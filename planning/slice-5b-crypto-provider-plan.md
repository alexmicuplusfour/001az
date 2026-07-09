# Slice 5b — Crypto as an agnostic connector with pluggable providers

Self-contained implementation plan. Parent design: `pipeline-boards-plan.md`; supersedes the connector naming in `slice-5-coingecko-plan.md`.

## The problem

Slice 5 shipped "coingecko" as the connector. That conflates two things:

- **The domain** — cryptocurrency: what fields exist (price, market cap, 24h change), what the template looks like, what identity means (the asset).
- **The data source** — CoinGecko: one particular API that can answer those questions. CoinMarketCap, Binance, Kraken could answer the same questions.

Boards and mappings should bind to the domain, not the source. A mapping that says `coingecko:price` breaks the moment you switch providers; a mapping that says `crypto:price` doesn't care where the number comes from. This mirrors the AI-tagger architecture exactly: prompts/facets are provider-agnostic, and anthropic/openai/gemini are swappable backends configured in admin.

## The model

**Connector = domain adapter.** `crypto` defines the canonical field set, the template, the search/fetch contract. Mappings reference it: `input: { connector: "crypto" }`, badges read `crypto:price`. Stable across provider switches.

**Provider = data backend.** `coingecko`, `coinmarketcap`, … implement `search(q)` and `fetchEntity(id)` and normalise their responses into the connector's canonical fields. Selected and configured (API key when needed) in admin. App-global — one active provider per connector (per-board provider override deferred, same as per-board AI keys were once).

**Provenance stays truthful.** `payload.fields[key].src` records the *provider* that produced the value ("coingecko"), not the connector. The mapping is connector-level (stable contract); the data is provider-level (actual source).

## Grouping: `finance` is a category label, not a layer

We considered a third layer — a `finance` connector with `crypto`/`stocks` as sub-kinds — and rejected it. The domain contract (canonical fields, template, search/fetch) lives at the crypto/stocks level; `finance` shares no concrete fields (crypto: 24h change, supply, ATH; stocks: P/E, dividend, exchange) and no provider (CoinGecko never answers a stock query). A layer that carries no contract is a namespace, not a domain adapter.

So `finance` is a one-line `category` string on the manifest that groups connectors in the template picker (`Finance ▸ Crypto`) — display-only. Mappings still bind to `crypto:price`; dispatch is still connector → provider (two layers, mirroring the AI tagger's domain → provider with no family layer between). Crypto and stocks are sibling connectors.

Promoting `finance` to a real connector only pays off for a *mixed-asset board* — one board holding BTC and AAPL, search fanning across both provider sets. That's a distinct capability, deferred until wanted. The asymmetry decides it: adding a grouping label later is a manifest string; removing a structural layer later is a mapping migration. Start with the cheap-to-reverse shape.

## Identity: symbol, not provider id

Provider ids are not portable — CoinGecko's "bitcoin" is CoinMarketCap's "1". If identity were the provider id, switching providers would orphan every existing entity (dedupe breaks, future liveness refresh breaks).

- `identity` = lowercase symbol (`"btc"`) — portable across providers, human-legible, and dedupes the same asset added under two providers.
- `display_name` = coin name ("Bitcoin"), `symbol` = "BTC" as today.
- `source = { provider: "coingecko", id: "bitcoin" }` — the provider-specific handle for the future liveness slice (re-fetch needs it). The `entities` table has no free-form payload column, so this rides on the connector's file-less tag-vehicle instance as `items.payload.source`. If the provider has changed since the entity was created, the refresh path re-resolves by symbol — deferred with liveness.

Symbol collisions across obscure coins exist but are acceptable: per-board, colliding on symbol is arguably correct (same ticker = same asset slot).

## Settings (existing key/value table, no schema change)

```
crypto_provider           = "coingecko"   (active provider; default when unset: "coingecko")
crypto_key_coingecko      = "..."          (optional — CoinGecko demo key, raises rate limits)
crypto_key_coinmarketcap  = "..."          (required — CoinMarketCap)
```

Keys are **per provider** (`crypto_key_<provider>`), not one shared slot: a keyed
and a keyless backend must not clobber each other, and switching providers keeps
each one's key. A second connector adds `stocks_provider` / `stocks_key_<provider>`.

## Server

### Directory shape

```
server/connectors/
  index.js            — connector registry (unchanged contract)
  crypto/
    index.js          — the crypto connector: manifest, template, provider registry + dispatch
    coingecko.js      — provider: search/fetchEntity normalised to crypto's canonical fields
    coinmarketcap.js  — (phase 2) second provider; needs an API key — proves the admin flow
```

### `server/connectors/crypto/index.js`

```js
import * as coingecko from "./coingecko.js";
import * as coinmarketcap from "./coinmarketcap.js";
const PROVIDERS = { coingecko, coinmarketcap };

export const manifest = {
  label: "Crypto",
  category: "finance",           // groups the template picker as "Finance ▸ Crypto"; display-only
  description: "Cryptocurrency prices and market data",
  fields: [ /* canonical: price, market_cap, change_24h, url — as shipped */ ],
  template: { input: { connector: "crypto" }, identity: { from: "connector" }, fields: [...] },
  providers: Object.entries(PROVIDERS).map(([name, p]) => ({
    name, label: p.label, needsKey: !!p.needsKey,
  })),
};

// Resolve active provider + its (per-provider) key from settings; dispatch.
const providerKey = (db, name) => getSetting(db, `crypto_key_${name}`);
async function activeProvider(db) {
  const set = await getSetting(db, "crypto_provider");
  const name = PROVIDERS[set] ? set : "coingecko";   // unknown/unset → default
  return { name, provider: PROVIDERS[name], apiKey: await providerKey(db, name) };
}
export async function search(db, q) { ... }        // provider.search(q, { apiKey })
export async function fetchEntity(db, id) { ... }  // provider.fetchEntity(id, { apiKey })
// Test an arbitrary provider (the admin's current selection) with a typed key,
// each falling back to active / that provider's stored key.
export async function testConnection(db, { provider, apiKey } = {}) { ... }
```

Signature change: connector `search`/`fetchEntity` now take `db` first (they read settings). The two call sites in server.js pass it.

### Provider contract (`crypto/coingecko.js`, `crypto/coinmarketcap.js`)

```js
export const label = "CoinGecko";
export const needsKey = false;                    // true for CoinMarketCap
export async function search(q, { apiKey })       // → [{ id, label, symbol, rank }]
export async function fetchEntity(id, { apiKey }) // → { id, symbol, display_name, fields }
export async function testConnection({ apiKey })  // cheap ping for the admin Test button
```

`fetchEntity` returns the provider id + canonical fields; the crypto connector assembles the entity payload: `identity = symbol.toLowerCase()`, `source = { provider: name, id }`, `src: name` on every field value.

**CoinGecko** is keyless but takes an *optional* demo key (sent as the `x-cg-demo-api-key` header) for higher rate limits. **CoinMarketCap** (`needsKey`) has no fuzzy-search endpoint, so `search` fetches `/cryptocurrency/map` once (cached ~6h) and filters locally; `fetchEntity` is an exact v2 quotes lookup. Both normalise into the identical canonical field set — the whole point.

### Routes

Existing routes keep working, now dispatching through the provider:
- `GET /api/connectors` — manifest now includes `providers` and `activeProvider` (admin UI reads this; harmless for members).
- `GET /api/connectors/:name/search` — unchanged shape.
- `POST /api/boards/:id/entities` — unchanged shape; payload gains `source`.

New admin routes (requireAdmin), matching the ai-config pattern:
- `GET /api/admin/connectors` → `[{ name, label, category, providers, activeProvider, keys }]` where `keys` is per-provider presence `{ coingecko: bool, coinmarketcap: bool }` (never the value).
- `POST /api/admin/connectors/:name` `{ provider, api_key? }` — validates provider exists; writes `crypto_key_<provider>`; key required if `needsKey` and none stored; empty `api_key` clears that provider's slot.
- `POST /api/admin/connectors/:name/test` `{ provider?, api_key? }` — tests the *selected* provider with the *typed* key (each falling back to active / that provider's stored key), so the result reflects the admin's form, not whatever is currently saved. Returns `{ ok, provider }`.

### Migration (one-time, in initDb)

Two rewrites, both idempotent and guarded, run alongside the existing initDb one-shots.

**1. Board mappings — connector rename.** Boards reference `"coingecko"` as the connector name in `boards.mapping`:

```sql
UPDATE boards SET mapping = jsonb_set(mapping, '{input,connector}', '"crypto"')
WHERE mapping->'input'->>'connector' = 'coingecko';
```

**2. Entities — identity re-key + source stamp.** Slice 5 shipped `entities.identity` = the CoinGecko id ("bitcoin"); 5b redefines identity as the lowercase symbol ("btc"). Without this, a coin already on a board and re-added post-5b lands under a different identity, dodges the `idx_entities_board_identity` unique index, and shows as a duplicate card. Post-entities-restructure identity lives on the `entities` table (not `items.payload`), so the rewrite targets entities — joined to the connector instance for the source stamp:

```sql
-- Stamp the provider handle onto the connector instance's payload FIRST,
-- capturing the CoinGecko id before the identity re-key overwrites it.
UPDATE items i
SET payload = i.payload
  || jsonb_build_object('source', jsonb_build_object('provider', 'coingecko', 'id', e.identity))
FROM entities e
WHERE i.entity_id = e.id
  AND i.payload->'mapping'->'input'->>'connector' IN ('coingecko', 'crypto')
  AND NOT i.payload ? 'source'
  AND COALESCE(e.symbol, '') <> '';

-- Re-key identity from the CoinGecko id to the lowercase symbol.
UPDATE entities e
SET identity = lower(e.symbol), updated_at = <now-ms>
WHERE COALESCE(e.symbol, '') <> ''
  AND e.identity <> lower(e.symbol)
  AND EXISTS (SELECT 1 FROM items i WHERE i.entity_id = e.id
              AND i.payload->'mapping'->'input'->>'connector' IN ('coingecko', 'crypto'));
```

Idempotent via `NOT payload ? 'source'` and `identity <> lower(symbol)`; keyed off the stamped connector mapping so file boards never match. Caveat: if a board somehow holds two coins sharing a ticker, the re-key collides with the unique index and aborts initDb — vanishingly unlikely on real data, but the WHERE can exclude would-be duplicates if it ever bites. The connector instance's inert `payload.mapping` ("coingecko") is left as-is — nothing reads it (the entities route validates against the *board* mapping), and its `src` provenance already says "coingecko", which stays true.

## Client

- **`connector-search.js` / `toolbar.js`** — no change; they already work off `mapping.input.connector`, which is now `"crypto"`.
- **`mapping-modal.js`** — badges render `crypto:price` automatically from `inputConnector` (no change). One small addition: the "Load template…" picker groups connectors under their manifest `category` (`Finance ▸ Crypto`), falling back to a flat list for uncategorised connectors. Purely presentational — the selected template still writes `input: { connector: "crypto" }`.
- **`admin.js` / `admin.html` / `admin-connectors.js`** — its *own* Connectors tab (the AI panel was too crowded). One row per connector: label + `category · description`, provider `<select>` (keyless providers annotated "no key needed"), an **always-shown** API key input (placeholder "optional — raises rate limits" for keyless providers, "paste key" otherwise, "•••• stored — leave blank to keep" when that provider already has one), Save + Test. The stored hint and Save/Test bodies key off the *selected* provider, so switching the select follows the per-provider key state. Follows the embedder-config row pattern.

## Tests (extend `test/connectors.test.js`)

- Crypto manifest: providers list present, coingecko in it, template references `connector: "crypto"`.
- Entity creation via `crypto`: identity is the lowercase symbol, `payload.source = { provider, id }`, `src` on fields is the provider name (fetch stubbed as today).
- Settings dispatch: with `crypto_provider` unset → coingecko used; with it set to an unknown name → falls back to coingecko (defaults not laws).
- Admin routes: GET shape (no key echo, per-provider `keys` map), POST validates provider name + enforces `needsKey`, per-provider key round-trip, keys don't bleed between provider slots, CoinGecko accepts an optional key. Test honours the selected provider (testing CMC while CoinGecko is active reports CMC) — the stubbed proof of the form-reflecting fix.
- CoinMarketCap normalisation: an entity added via `crypto` while CMC is active yields the identical canonical field set, `src: "coinmarketcap"`, `source = { provider: "coinmarketcap", id }` (fetch stubbed with the v2 quotes shape).
- Migration: board with `input.connector = "coingecko"` → after initDb, reads `"crypto"`; a pre-5b entity (identity = CoinGecko id, `symbol` set) → identity becomes the lowercase symbol and its connector instance gains `payload.source = { provider, id }`. Idempotent: a second initDb pass is a no-op.

## Verify (live)

1. Restart with migration → existing crypto board's mapping modal shows `Connector: crypto`, badges `crypto:price`.
2. Plus → search "solana" → add → entity identity is `sol`, Details fields badged `coingecko`.
3. Admin → Connectors → Crypto shows CoinGecko active with an optional key field; Test succeeds.
4. (Phase 2) Switch provider to CoinMarketCap, paste key, Test (reports "coinmarketcap"), Save, add a coin → same canonical fields, `src: "coinmarketcap"`. Switching back to CoinGecko keeps CMC's key stored.

## Phases — both SHIPPED

1. **Restructure** (commit `6171f3a`) — crypto connector wrapping the coingecko module, settings dispatch, the migration. Admin UI was deferred to phase 2 (with one keyless provider there was nothing to switch). Live-verified: mapping modal shows `Connector: crypto` with `crypto:*` badges.
2. **Second provider + admin** (commit `322b657`) — CoinMarketCap provider, the Connectors admin tab, and provider select/key/Test. Proves `needsKey`, the key flow, and identical canonical fields across backends. 124 tests green; CMC provider live-probed against the real API.

### Shipped deviations from the plan above

- **Per-provider keys.** The plan first had one shared `crypto_api_key`; that clobbers when two providers each need a key, so keys became `crypto_key_<provider>`. (A short-lived shared-slot migration was added then removed — it only cleaned up uncommitted intra-session state, which doesn't belong in `initDb`.)
- **CoinGecko optional key.** Added on request: the key field shows for keyless providers too and, if filled, is used (demo-key header).
- **Test reflects the form.** The test route/UI test the *selected* provider + typed key rather than the saved config, so the toast can't name the wrong provider.
- **Own admin tab**, not a section inside the AI panel.

## Deferred

- Per-board provider override (mirror of `ai_key_id`) — when a real need appears.
- Provider re-resolution by symbol when the active provider changes (arrives with liveness).
- Rate-limit/backoff handling per provider (arrives with liveness; manual adds are low-volume).
