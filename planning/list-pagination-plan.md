# Gallery list: keyset pagination + delta polling + hearts-join fix

STATUS: shipped 2026-07-13 — 240 tests green, live-verified (page walk ≡ legacy
order on a 308-entity board, quiet delta = 0 items + full ids, 400 on bad
cursors). Follow-up hardening same day: pollTick delta-shape guard, drain
single-retry, presentIds client tests, crate-stamp test.

## Context

`GET /api/items?board=X` returns every entity on the board as one bare JSON array. The client waits for the full query + transfer + parse before first paint (thousands of items ≈ MBs raw), and while anything is processing, `pollTick` re-downloads the entire list every 4s. This is the "API pagination / delta poll" item left open from gallery scale hardening. Additionally, `listItems` computes hearts via a correlated `(SELECT COUNT(*) FROM favorites …)` subquery per entity row — an N+1 inside the hottest query.

Plan: (1) keyset pagination so boot paints the first ~200 items immediately and drains the rest in background; (2) `?since=` delta polling so the 4s tick fetches only changed entities plus a compact id list for removal detection; (3) replace the hearts subquery with grouped joins.

Facts that shape the design (verified):
- `entities` and `items` both have `created_at`/`updated_at` as **BIGINT ms-epoch**, and `updated_at` is already stamped by every status/tag/identity/fields write path (`markTagged`, `markExtracted`, `advanceFaced`, `failOrRequeue`, claims, `setItemTags`, `reparentItem`, `setEntityIdentity`, `updateEntityFields`, …). **No schema change needed for change-tracking** — only indexes.
- `pg.types.setTypeParser(20, Number)` in server/db.js — BIGINTs arrive as JS Numbers; ms epochs are < 2^53 so cursors are exact. No timestamp round-trip problems.
- Server + worker share one Node process → one clock; a 2s margin on returned `now` + idempotent `reconcile` covers stamp-before-commit races.
- Sole `listItems` caller is the route; all existing `/api/items` consumers use the no-param form → keep bare-array shape there, zero back-compat breakage.
- Client grid already windows rendering (60-card batches + IntersectionObserver sentinel); `state.items` must stay newest-first (`created_at DESC, id DESC`), so draining older pages **appended at the end** preserves order. No item-id deep links; board switch is a full page navigation (no drain cancellation needed).

## API contract (one route, three shapes)

`GET /api/items?board=X` — unchanged: bare array (back-compat).
`GET /api/items?board=X&limit=200[&after=<created_at>_<id>]` → `{ items, nextCursor, now }`. `nextCursor` = `"<created_at>_<id>"` of the last row, emitted only when `rows.length === limit` (an exact-multiple total yields one final empty page — fine). `limit` clamped 1..500; malformed `after` (`!/^\d+_\d+$/`) → 400.
`GET /api/items?board=X&since=<ms>` → `{ items, ids, now }` — entities changed since `<ms>` (own stamp or any instance's), `ids` = all current entity ids on the board (removal/merge detection), `now` = `Date.now()` **captured before the query** minus 2000ms (next poll's cursor). `since` takes precedence over limit/after.

## Server changes

**1. Migration `server/migrations/0014_list_indexes.sql`**: composite indexes
`entities(board_id, created_at DESC, id DESC)`, `entities(board_id, updated_at)`, `items(board_id, updated_at)`.

**2. `listItems` rework (server/db.js)**:
- Signature `listItems(db, userId, boardId, { limit, after, since } = {})`, returns `{ items, nextCursor }`. Route unwraps `.items` for the legacy shape.
- Entity query: keyset mode adds `AND (e.created_at, e.id) < ($a::bigint, $b::bigint)` + `LIMIT`; delta mode adds `AND (e.updated_at > $s OR e.id IN (SELECT entity_id FROM items WHERE board_id=$1 AND updated_at > $s))`.
- Hearts/fav in ALL modes: grouped `LEFT JOIN (SELECT item_id, COUNT(*)::int … GROUP BY item_id)` with `COALESCE(…, 0)` (byte-identical payload), and `LEFT JOIN favorites fme ON … user_id = $1` → `(fme.user_id IS NOT NULL) AS fav` (PK prevents row multiplication).
- Instances query: paged/delta modes use `WHERE entity_id = ANY($pageIds::bigint[])` (`aggregateStatus` and face-first mirroring need ALL of an entity's instances). Legacy mode unchanged; crates query unchanged board-wide.

**3. Delta-visibility stamps** — writes that change what the list shows but didn't touch `entities.updated_at` (delta polls would miss them): new `touchEntity(db, id)`; `deleteInstance` stamps the parent via CTE in the same statement; `reparentInstance` split path stamps the surviving old entity inside the tx; the worker's explicit-split branch stamps too; `toggleFavorite`/`toggleCrateItem` stamp (hearts/crateIds ride the entity payload). Skipped on purpose: crate-visibility flips (fan-out too wide), payload-only merges / embedding writes / refresh_at scheduling (invisible to the list).

**4. Route (server/server.js /api/items)**: parse/validate params, capture `now` before querying, emit the three shapes; `ids` via `listEntityIds`.

## Client changes

**5. public/state.js**: `itemsSince: null` — the since-cursor; null = pre-delta server, full-fetch fallback.

**6. public/data.js**:
- `reconcile(data, presentIds = new Set(data.map(d => d.id)))` — the merged-away detection reads presentIds (a full list IS that set; deltas pass the server's ids). Guard: an object response missing items/ids arrays skips the tick — an empty presentIds set would read as "everything merged away".
- `drainItems(cursor)`: background loop, `&limit=500&after=`, appends via id-deduped push (append preserves DESC order; dedupe covers delta-unshifted undrained items), `ensurePolling()` per page (a late page may hold the only in-flight items), one spaced retry per failed page then stop (partial beats empty; reload resumes).
- `pollTick`: delta fetch when `itemsSince` set; bare-array response (rollback skew) falls back to legacy semantics.

**7. public/app.js boot**: items fetch `&limit=200`; `Array.isArray` normalize for old servers; set `itemsSince` from `now`; render + ensurePolling, then `drainItems(nextCursor)`.

## Known-benign / deferred

- During drain, facet counts / toolbar count / hearts-sort settle progressively; a filtered share-link boot can flash "No items match" briefly. Accepted (no loading indicator).
- A delta poll can unshift a changed-but-not-yet-drained item to the top; position self-heals on reload; drain dedupe prevents duplicates. Page data can briefly be fresher than a poll-updated card — the next delta heals it.
- Deleted **tagged** items still don't vanish mid-session for other viewers (same as before — polling only prunes in-flight ids); the `ids` list supports fixing this later.
- `deleteInstance`'s CTE takes items-then-entity locks while `deleteEntity` locks entity-then-cascade — a theoretical AB/BA deadlock on concurrent instance-delete vs entity-delete of the same entity; Postgres's detector errors one side, ms-scale window, accepted.

## Tests

`test/list-pagination.test.js` (server): page walk disjoint/complete/ordered incl. created_at ties and exact-multiple empty final page; delta entity-level + instance-level changes; stamp coverage for instance delete, split re-parent, favorite and crate toggles; hearts joins (2 users, 0-not-null, favoritedByMe per user); route shapes + 400s.
`test/delta-reconcile.test.js` (client): quiet delta keeps an unchanged in-flight item waiting; absence from the ids list still reads as merged away.
