# Slice 5c — Agnostic connector runtime + per-field liveness

Self-contained implementation plan. Parent design: `pipeline-boards-plan.md`; continues the connector track from `slice-5b-crypto-provider-plan.md`. This is the back half of slice 5's original scope (the `gather_every_min` refresh loop, `field_snapshots`, and the dirty cascade were always slice 5; the cascade lands here as an **opt-in board setting**, not a default) — it is **not** slice 6 (the research resolver).

## The two things this ships

1. **Pull the agnostic machinery out of `crypto`.** Today `crypto/index.js` hand-rolls the whole domain×provider dispatch — `activeProvider`, per-provider key lookup, `search`/`fetchEntity`/`testConnection` ([crypto/index.js:46-93](server/connectors/crypto/index.js#L46-L93)). A second domain (stocks, movies, pokémon) would copy all of it against `stocks_*` settings. Extract it into a shared `server/connectors/runtime.js`; the connector module shrinks to pure data (manifest + a providers map + a default). Adding a domain becomes one directory, zero runtime edits — the same win the AI tagger got when its providers became descriptors (`3dd5212`→`dfc331e`).

2. **Per-field liveness.** Each connector field (identity excluded) gets a `live` toggle + a `refresh` cadence, meaning *how often that field updates in the app*. A background sweep re-fetches the entity and writes back the fields whose cadence has elapsed; the rest stay frozen. Moved values accrue a `field_snapshots` history. Which fields a board binds, and their liveness, is configured against the connector's **field catalog** in the mapping modal (below).

**Retagging is decoupled, opt-in per board.** By default a data refresh does **not** re-tag — tagging keeps its own clock (the board's periodic schedule / manual retag). But because fresh data can make tags stale, board settings gain a **"Retag on new data"** toggle alongside the existing retag options; when on, a *moved* value re-queues the entity for tagging. Off by default (a `price` on a 1-minute cadence shouldn't drive a tag call every minute unless the board asks for it).

### The layer model (locked, from the design chat)

- **Runtime** — agnostic, *no user-facing noun*; just `runtime.js` that every connector uses. Owns domain×provider dispatch, settings/key storage (`<domain>_provider`, `<domain>_key_<provider>`), and the liveness sweep.
- **Connector = domain** — `crypto`, later `stocks`, `movies`. What boards bind to (`mapping.input.connector` — unchanged). Pure data: canonical fields, template, identity rule, `category`, providers map.
- **Provider = backend** — `coingecko`, `coinmarketcap`. Implements the domain's search/fetch contract; unchanged.

`finance` stays a display-only `category` grouping crypto + stocks (the slice-5b decision holds — no third structural layer). Stocks is a *sibling domain*, not a parent.

---

## Phase 1 — Runtime extraction (pure refactor, no behaviour change)

### `server/connectors/runtime.js` (new)

Holds the behaviour that lives in crypto/index.js today, generalised over a connector descriptor `conn = { name, providers, defaultProvider, manifest }`:

```js
import { getSetting } from "../db.js";

const providerKey = (db, conn, name) => getSetting(db, `${conn.name}_key_${name}`);

export async function activeProvider(db, conn) {
  const set = await getSetting(db, `${conn.name}_provider`);
  const name = conn.providers[set] ? set : conn.defaultProvider;   // unknown/unset → default
  return { name, provider: conn.providers[name], apiKey: (await providerKey(db, conn, name)) || null };
}

export async function search(db, conn, q) {
  const { provider, apiKey } = await activeProvider(db, conn);
  return provider.search(q, { apiKey });
}

// identity = lowercase symbol (portable across providers), source = { provider, id },
// src = provider name on every field, at = now on every field (liveness baseline).
export async function fetchEntity(db, conn, id, now = Date.now()) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  const e = await provider.fetchEntity(id, { apiKey });
  const symbol = e.symbol || null;
  const identity = (symbol || "").toLowerCase() || e.id;
  const fields = {};
  for (const [k, v] of Object.entries(e.fields || {})) fields[k] = { ...v, src: name, at: now };
  return { identity, display_name: e.display_name, symbol, source: { provider: name, id: e.id }, fields };
}

export async function testConnection(db, conn, { provider: pOverride, apiKey: kOverride } = {}) { /* as crypto's today, keyed off conn */ }
```

The only new thing vs. today's crypto dispatch is `at` stamped per field in `fetchEntity` (Phase 2 reads it; harmless in Phase 1).

### `server/connectors/crypto/index.js` (shrinks to data)

Drops `activeProvider`/`providerKey`/`search`/`fetchEntity`/`testConnection` entirely. Keeps:

```js
import * as coingecko from "./coingecko.js";
import * as coinmarketcap from "./coinmarketcap.js";

export const providers = { coingecko, coinmarketcap };
export const defaultProvider = "coingecko";
export const manifest = { label, category: "finance", description, fields, template, providers: /* descriptors */ };
```

The provider modules (`coingecko.js`, `coinmarketcap.js`) are untouched — their contract already lives at the right layer.

### `server/connectors/index.js` (registry binds behaviour to data)

Each registry entry composes its data module with the runtime, so callers keep calling `connector.search(db, q)` verbatim — the routes in server.js don't change:

```js
import * as crypto from "./crypto/index.js";
import * as runtime from "./runtime.js";

function bind(name, mod) {
  const conn = { name, providers: mod.providers, defaultProvider: mod.defaultProvider, manifest: mod.manifest };
  return {
    name, manifest: mod.manifest,
    search:         (db, q)    => runtime.search(db, conn, q),
    fetchEntity:    (db, id)   => runtime.fetchEntity(db, conn, id),
    testConnection: (db, opts) => runtime.testConnection(db, conn, opts),
    activeProvider: (db)       => runtime.activeProvider(db, conn),
    refresh:        (db, e, i) => runtime.refresh(db, conn, e, i),   // Phase 2
  };
}
const CONNECTORS = { crypto: bind("crypto", crypto) };
export const getConnector = (name) => CONNECTORS[name] || null;
export function listConnectors() { /* unchanged: reads .manifest */ }
```

`getConnector`/`listConnectors` keep their current shape; the admin + entity routes ([server.js:791-850](server/server.js#L791-L850), [server.js:988-1051](server/server.js#L988-L1051)) call the same method names and need no edits.

### Phase 1 tests (`test/connectors.test.js`)

- Register a throwaway second connector against the runtime and assert dispatch is generic: `activeProvider` reads `<name>_provider`, unknown/unset → its `defaultProvider`, key reads `<name>_key_<provider>`, keys don't bleed between providers or connectors. This is the proof the machinery is no longer crypto-shaped.
- Re-green the existing crypto suite unchanged (identity = lowercase symbol, `source`, `src` per field) — the refactor is behaviour-preserving; the only diff is `at` now present on fetched fields.

Ship Phase 1 on its own: it's a safe, reviewable no-op that unlocks stocks and Phase 2.

---

## Phase 2 — Per-field liveness

### Mapping shape (additions)

Connector fields gain two optional keys; identity never does.

```js
{ key: "price", kind: "number", from: "connector", fn: "price",
  live: true, every: 5 }   // every = minutes between app-updates for THIS field
```

`validateMapping` ([server.js:529](server/server.js#L529)) additions, inside the field loop:
- `live` (if present) must be boolean; only allowed on `from: "connector"` fields.
- `every` required when `live` is true: a positive integer, floored at a sane minimum (`MIN_REFRESH_MIN`, e.g. 1) and capped (e.g. ≤ 43200 = 30 days) — defaults not laws, but no zero/negative cadences.
- `live`/`every` on identity or on `from: "ai"` fields → rejected (AI-field liveness is deferred; see below).

The stamped `payload.mapping` on the connector instance already carries these (it's the whole board mapping, stamped at creation — [server.js:1028](server/server.js#L1028)); the sweep reads them from there.

### Data model

**Per-field write timestamp.** Each value object grows `at`: `{ v, src, kind, at }`. Written by `runtime.fetchEntity` (Phase 1) at creation and by the sweep on each refresh. Non-live fields keep their creation `at` forever.

**`entities.refresh_at` (new column).** Next due time across the entity's live fields — mirrors `boards.auto_tag_next_run_at`. NULL = nothing live. Lets the sweep select due entities with an index instead of scanning every connector entity each tick.

```sql
ALTER TABLE entities ADD COLUMN IF NOT EXISTS refresh_at BIGINT;
CREATE INDEX IF NOT EXISTS idx_entities_refresh ON entities(refresh_at) WHERE refresh_at IS NOT NULL;
```

Set at creation and after each refresh to `min(field.at + field.every*60000)` over live fields.

**`field_snapshots` (new table).** History behind the live values — shaped like `tag_snapshots` ([schema.sql:146](server/schema.sql#L146)) but keyed to the **entity** (connector fields live on `entities.fields`, not on the instance):

```sql
CREATE TABLE IF NOT EXISTS field_snapshots (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id    BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  fields       JSONB  NOT NULL DEFAULT '{}',  -- only the values written this refresh
  source       TEXT,                          -- provider that produced them
  refreshed_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_snapshots_entity ON field_snapshots(entity_id, refreshed_at);
```

**`boards.retag_on_refresh` (new column).** The opt-in cascade flag, sitting beside the existing `auto_tag_*` retag settings.

```sql
ALTER TABLE boards ADD COLUMN IF NOT EXISTS retag_on_refresh BOOLEAN NOT NULL DEFAULT FALSE;
```

**`gather_every_min`** (per-board column, [schema.sql:68](server/schema.sql#L68), never wired) is superseded by per-field `every`. Leave the dead column; don't build on it. (A drop is a later schema-cleanup pass, alongside the legacy `boards.type`.)

### `server/db.js` — new helpers

- `dueLiveEntities(db, now, limit)` → connector entities with `refresh_at <= now` (joined to their file-less instance for `payload.source` + `payload.mapping`, and to the board for the active connector). Bounded by `limit` per tick.
- `updateEntityFields(db, entityId, fields, refreshAt)` → writes merged `entities.fields`, sets `refresh_at`, bumps `updated_at`.
- `addFieldSnapshot(db, entityId, fields, source, at)` → one history row (private, like `addTagSnapshot`).
- `setEntityRefreshAt(db, entityId, at)` → set/clear `refresh_at` when a board's mapping changes (see the mapping-edits note below).

### `server/connectors/runtime.js` — the refresh

```js
// Re-fetch one entity and write back only its DUE live fields. `inst` is the
// file-less connector instance (carries source + the stamped live mapping).
export async function refresh(db, conn, entity, inst, now = Date.now()) {
  const liveCfg = (inst.payload.mapping?.fields || []).filter((f) => f.from === "connector" && f.live);
  const due = liveCfg.filter((f) => now - (entity.fields[f.key]?.at ?? 0) >= f.every * 60000);
  if (!due.length) return { merged: null, moved: {}, next: nextRefreshAt(entity.fields, liveCfg, now) };

  // Whole-object fetch (one API call) even though only some fields are due —
  // you can't fetch a single field. Re-resolve by symbol when the active
  // provider isn't the one that created the entity (its id isn't portable).
  const src = inst.payload.source;
  const active = await activeProvider(db, conn);
  const id = active.name === src?.provider ? src.id : await resolveBySymbol(db, conn, entity.symbol);
  const fetched = await fetchEntity(db, conn, id, now);

  const merged = { ...entity.fields };
  const moved = {};               // only values that actually changed (for history)
  for (const f of due) {
    const nv = fetched.fields[f.key];
    if (!nv) continue;
    if (merged[f.key]?.v !== nv.v) moved[f.key] = nv;
    merged[f.key] = nv;           // always rewritten so `at` advances → refresh_at recomputes
  }
  return { merged, moved, next: nextRefreshAt(merged, liveCfg, now), provider: active.name };
}
```

`at` is always bumped on a refresh (last-checked, not last-changed) — otherwise an unchanged field would read "due" forever and re-fetch every tick. `nextRefreshAt` = `min(field.at + every*60000)` over live fields, or `null` if none. `resolveBySymbol` re-runs the active provider's `search(symbol)` and takes the exact-ticker hit — this is the "provider re-resolution by symbol" that slice-5b deferred *to* liveness. If the entity has no symbol (shouldn't happen for crypto), skip refresh and log.

### `server/worker.js` — the sweep

A `refreshDue()` alongside `retagDue()`/`embedDue()` in `tick()` ([worker.js:622](server/worker.js#L622)), same discipline (bounded batch, error backoff so a provider outage doesn't hammer the API):

```js
async function refreshDue() {
  if (Date.now() < refreshBackoffUntil) return;
  const rows = await dueLiveEntities(db, Date.now(), REFRESH_BATCH);
  for (const { entity, inst, board } of rows) {
    const conn = getConnector(board.mapping?.input?.connector);
    if (!conn?.refresh) { await setEntityRefreshAt(db, entity.id, null); continue; }
    try {
      const r = await conn.refresh(db, entity, inst);
      if (r.merged) {
        await updateEntityFields(db, entity.id, r.merged, r.next);
        if (Object.keys(r.moved).length) {
          // History records movement only — a flat minute writes no row.
          await addFieldSnapshot(db, entity.id, r.moved, r.provider, Date.now());
          // Opt-in cascade: only boards with retag_on_refresh re-tag on a move.
          if (board.retag_on_refresh && board.auto_tag) await requeueForTag(db, inst.id);
        }
      } else {
        await setEntityRefreshAt(db, entity.id, r.next);
      }
    } catch (e) {
      console.error(`refresh error (entity ${entity.id}):`, e.message);
      refreshBackoffUntil = Date.now() + 60000;
      await setEntityRefreshAt(db, entity.id, Date.now() + 60000); // retry, don't wedge the queue
      break;
    }
  }
}
```

`requeueForTag` sets the instance back to `pending` (reuse the existing requeue path). `REFRESH_BATCH`/backoff mirror `EMBED_BATCH`/`embedBackoffUntil`. `dueLiveEntities` loads `board` for both the active connector and its `retag_on_refresh`/`auto_tag` flags.

**Entity creation** ([server.js:1016-1029](server/server.js#L1016-L1029)) sets `refresh_at` from the stamped mapping's live fields (compute the same `nextRefreshAt` from the just-fetched `at` values). Nothing else in the route changes.

**Mapping edits** — when an admin PATCHes a board's mapping, existing entities' `refresh_at` should re-derive (a field turned live/idle, or `every` changed). Simplest: on mapping PATCH for a connector board, recompute `refresh_at` for its entities from the new mapping. Small helper call in the PATCH handler; keep it O(entities) and only when `mapping` actually changed.

### Client

**`mapping-modal.js` — the connector field catalog.** Today "Load template" swaps the whole field list to the template's fields as locked rows ([mapping-modal.js:273-282](mapping-modal.js#L273-L282)); a connector board can't see or choose the other fields the connector exposes. Replace that with a catalog view driven by the connector manifest:

- The catalog is **connector-global** — `manifest.fields` (already returned by `listConnectors()`: `{ key, kind, fn, label }`). The **selection + liveness is per-board** — it's what this board's `mapping.fields` records. Catalog on the left, board choice on the right.
- When a connector is active (`inputConnector` set), render one row per catalog field: an **include** checkbox, the field `label` + `crypto:fn` badge + `kind` badge (the locked identity of the field), and — enabled only when included — a **Live** toggle + cadence `<select>` (Off / 1m / 5m / 15m / 1h / 6h / 1d; writes `every` in minutes). Identity is its own locked row as today, with no liveness.
- Seed from `manifest.template`: template fields start included (that's what "load template" meant); their `live`/`every` default off unless the template sets them. The user then toggles includes + liveness per field.
- `save()` serialises only the included catalog fields into `mapping.fields`, each carrying `{ key, kind, from: "connector", fn, ...(live ? { live, every } : {}) }`. Connector fields already pass straight through `save()` ([mapping-modal.js:309-311](mapping-modal.js#L309-L311)); the change is building the list from catalog+includes instead of the template blob.
- Keep it inside the mapping modal (not a new modal): binding fields *is* defining the mapping, and liveness is per-board, so it belongs where the board's mapping is edited. A separate "connector fields" modal would fragment one decision across two surfaces.

**`board-modal.js` — the retag toggle.** Add a **"Retag on new data"** checkbox in the existing auto-tag/retag block (near the periodic-retag controls), bound to `retag_on_refresh`. It PATCHes with the other board-content fields — no new endpoint.

**`lightbox.js`** — `fieldsSection` renders `{ v, why, src, kind }` per row ([lightbox.js:87](lightbox.js#L87)); add a subtle **"· updated 3m ago"** from `at`, and a small live ⟳ marker on fields with `live`. `img.fields` already carries the whole value object (incl. `at`) via `listItems` reading `entities.fields`, so nothing new flows through — the timestamp is already there. Number formatting (`formatFieldNumber`) is untouched. Card-face "live" pulse: cosmetic, deferred.

### `server/server.js` — board settings

`buildBoardContentUpdate` ([server.js:448](server/server.js#L448)) gains one line next to the `auto_tag_*` handling: `if (body.retag_on_refresh !== undefined) update.retagOnRefresh = !!body.retag_on_refresh;`. Wire `retagOnRefresh` through `updateBoard`/`createBoard` and add `retag_on_refresh` to `BOARD_COLS` ([db.js:745](server/db.js#L745)) so `getBoard` returns it (the sweep reads it). Members-vs-admin gating rides the existing content-edit path — no special handling.

### Phase 2 tests

- `validateMapping`: `live`/`every` accepted on connector fields; `every` zero/negative/oversize rejected; `live` on identity or an AI field rejected.
- `runtime.refresh` (fetch stubbed): only due fields rewritten (`at` advances even when the value is unchanged), non-live and not-yet-due fields untouched, `refresh_at` recomputed to the soonest live field, `moved` holds only value-changed fields. Provider-switch path re-resolves by symbol.
- `dueLiveEntities` returns only `refresh_at <= now`; creation sets `refresh_at` from the stamped mapping.
- Snapshot gating: a moved value writes a `field_snapshots` row; a flat refresh writes none.
- Opt-in cascade: with `retag_on_refresh` off (default), a moved value re-queues nothing; with it on (and `auto_tag` on), a moved value sets the instance back to `pending`, and a flat refresh still re-queues nothing.
- `buildBoardContentUpdate` accepts `retag_on_refresh`; `getBoard` returns it.
- Migration idempotency (below).

### Migration (one-time, in `initDb`, idempotent — alongside the existing one-shots at [db.js:26-131](server/db.js#L26))

Existing connector entities predate `at`/`refresh_at`. Backfill so the sweep has a baseline:

```sql
-- Stamp `at` on every connector field value that lacks it, from the entity's updated_at.
UPDATE entities SET fields = (
  SELECT jsonb_object_agg(k, CASE WHEN v ? 'at' THEN v ELSE v || jsonb_build_object('at', updated_at) END)
  FROM jsonb_each(fields) AS f(k, v)
)
WHERE fields <> '{}'::jsonb
  AND EXISTS (SELECT 1 FROM jsonb_each(fields) e(k,v) WHERE NOT (e.v ? 'at'));
```

`refresh_at` stays NULL until a board's mapping marks fields live (no board does yet, since liveness is new), so no backfill needed for it — it populates naturally on the next mapping save or entity add. Idempotent via the `NOT (v ? 'at')` guard; a second `initDb` pass is a no-op.

---

## Verify (live, throwaway board)

**Phase 1:** existing crypto board unchanged — mapping modal still shows `Connector: crypto`, `crypto:price` badges; add a coin, Details fields badged `coingecko`; admin Connectors tab still switches provider + Test. Pure refactor, nothing visibly moves.

**Phase 2:**
1. On a crypto board, open the mapping modal → the connector **catalog** lists every `crypto:*` field with include checkboxes; include `price`/`market_cap`/`url`, drop `change_24h`, set `price` live @ 1m and `market_cap` live @ 1h, leave `url` static → Save. Reopen: selection + liveness persist.
2. Add BTC. Details shows the included fields with "updated just now"; `change_24h` is absent (unchecked).
3. Watch: `price` refreshes ~every minute (timestamp + value move), `market_cap` holds for an hour even though every price fetch pulls it too, `url` never changes.
4. With **Retag on new data** off (default): the entity's tags stay put across refreshes. Turn it on in board settings → a subsequent price move re-queues the entity and tags re-run; a flat minute doesn't.
5. `field_snapshots` accrues a row only when a value actually moved (a flat minute writes nothing).
6. Switch the active provider to CoinMarketCap → next refresh re-resolves BTC by symbol and keeps updating (identity `btc` stable, `src` flips to `coinmarketcap`).
7. Plain file board and a connector board with nothing live: sweep touches neither (`refresh_at` NULL).

## Status — both phases SHIPPED (local, not pushed)

- **Phase 1** (commit `c5c8981`) — runtime extraction. `runtime.js` holds the dispatch; `crypto/index.js` is pure data; the registry `bind()`s them. A throwaway two-provider connector in `connectors.test.js` proves genericity. Behaviour-preserving; 125 tests green.
- **Phase 2** (commit `67658a4`) — per-field liveness + the opt-in retag. 134 tests green (9 new in `test/liveness.test.js`).
- **Fix** (commit `d512774`) — two bugs caught in live verify (an existing board's 1-min-live price never refreshed): (1) `refresh()` read the live config from the instance's *stamped* mapping (frozen at creation), so a field toggled live afterwards was invisible to the sweep — now it reads the **board mapping** (passed through `refreshDueEntity`); (2) entities on boards configured live *before* this deployed had `refresh_at = NULL` and were never scheduled — `reconcileLiveSchedules` at `initDb` recomputes them each boot (idempotent). 136 green. Live-verified: price refreshes each minute, non-live `market_cap` stays frozen, symbol re-resolution across the provider switch works.

### Deviations from the plan above

- **`refreshDueEntity` is exported from `worker.js`** (module scope), with the sweep closure a thin batch/backoff loop over it — extracted so the cascade gating is unit-testable without running the worker. The plan had the logic inline in `refreshDue`.
- **Cadence UI is a fixed select** (Off / 1m / 5m / 15m / 1h / 6h / 1d), writing `every` in minutes — as floated in the plan, chosen over a raw minutes box.
- **Mapping modal fallback:** if `GET /api/connectors` fails, the catalog can't render, so it falls back to the saved connector fields as locked rows (cadence still editable). The catalog is the primary path.
- **`at` is last-*checked*, not last-*changed*** — always bumped on a refresh so an unchanged field doesn't read "due" every tick; `moved` carries the value changes for history.
- **`rescheduleEntityRefreshes`** recomputes `refresh_at` for all of a board's entities on a mapping edit (turning fields live/idle or moving cadence); the plan noted this as a "small helper call" — it landed in `db.js`.
- **Not verified live:** the multi-minute price-watch (real CoinGecko, worker running) is a wall-clock manual step; the mechanics are covered deterministically by stubbed-fetch tests.

## Deferred

- **Stocks connector** — the payoff of Phase 1: one directory (`connectors/stocks/`), `stocks_provider`/`stocks_key_*` for free, zero runtime edits. Its own slice.
- **Liveness on AI fields** (periodic re-extraction) — coherent (`live` = re-run extraction on a cadence) but out of scope; validation rejects it for now. Revisit if a real board wants a self-refreshing AI field.
- **Per-provider rate-limit/backoff** beyond the single sweep-level backoff — manual adds + a bounded batch keep volume low; add token buckets if a large live board pushes CoinGecko's ~30/min.
- **Charts over `field_snapshots`** — price-over-time is now recorded; a detail-view chart is a later visual slice.
- **Per-board provider override** (mirror of `ai_key_id`) — still deferred to a real need.
