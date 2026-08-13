// The connector-feed ingestion adapter: a connector board mirrors a
// filter-defined bucket of its domain's catalog ("top 50 by market cap").
// Built per board from the connector manifest's `browse` block — columns
// become the filter catalog, sorts come across as-is — so the sweep, routes,
// modal, engine and ledger stay adapter-blind (they already speak this
// interface; see folder.js for the pinned contract).
//
// Admission is NOT transactional across entity + ledger: if the ledger write
// is lost after the entity lands, the next run re-adds, hits the entities
// (board_id, identity) unique constraint, and the sweep ledgers the
// `.duplicate` — self-healing by construction.
import { getConnector } from "../connectors/index.js";
import { addConnectorEntity } from "../connectors/add.js";
import { recordIngest } from "../db.js";
import { SAFETY_CAP, cacheTtl, readWindow, writeWindow, resetWindow, ageWindow } from "./window-cache.js";

// Browse column kinds are display vocabulary (usd/percent drive client
// formatting); the filter engine only knows text/number/date.
const FILTER_KIND = { text: "text", number: "number", usd: "number", percent: "number", date: "date" };

// How deep into the catalog a feed can see: ALL of it. There is no app-side
// reach limit, for the reason files.js already spells out — a capped window
// CLOGS. The ledger dedups downstream, not during the walk, so once the first
// N are ingested they still fill the window and everything past N becomes
// permanently invisible. A "top 5000" ration doesn't mean "the first 5000 are
// enough", it means the 5001st never arrives, ever.
//
// Depth is priced by FREQUENCY, not size: the window cache below means one
// fill per TTL is reused by back-to-back preview pages and drain ticks, and
// FMP serves any depth from one cached screener call (zero marginal HTTP).
// A metered catalog (CoinGecko/CMC, one request per 250 rows) genuinely costs
// more to walk in full — an operator who wants that rationed sets
// INGEST_FEED_CAP, which is a budget guard they chose, not a ceiling the app
// picked for them. SAFETY_CAP is only an out-of-memory backstop, shared with
// the file adapter so the two can't drift.
// The preview route reads this same bound through the adapter's windowCap, so
// a preview count and a real run can never disagree on depth.
//
// `browse.feedWindow` survives as a per-connector ration with no bundled
// producer: crypto and stocks both declare none. It stays for plugin domains
// (registerConnector) whose catalog is metered enough to want one out of the
// box — an escape hatch, not a default.
export const ENUM_CAP = (browse) =>
  Number(process.env.INGEST_FEED_CAP) || browse?.feedWindow || SAFETY_CAP;
// Requested page size, per provider. Providers may clamp internally, but keep
// their offset math consistent with their own clamp, so a short-but-nonempty
// page is normal paging — enumeration stops ONLY on an empty page. Treating a
// short page as "dry" would silently miss everything past a provider's first
// clamped page.
//
// A provider states its own ceiling with `maxPageSize`; 250 is only what to ask
// one that hasn't said. It used to be a hardcoded 250 for everyone, which was
// CoinGecko's per_page cap wearing the costume of a limit every API imposed:
// CoinMarketCap's listings/latest takes 5000, so asking it for 250 turned a
// ~2-request walk into ~32. Both bundled crypto providers declare theirs now.
// FMP deliberately doesn't — its slices are cache-served, so a bigger page
// saves nothing (financialmodelingprep.js `list`).
const ENUM_PAGE_DEFAULT = 250;
// Clamped at both ends, and both ends earn it: the floor protects maxPagesFor's
// divisor (a negative would yield a negative page budget — a silently empty
// window, the exact class of bug this block exists to prevent), and the ceiling
// bounds one page's peak memory, since a plugin domain can declare this too.
const ENUM_PAGE_MAX = 10000;
const pageSizeFor = (provider) =>
  Math.max(1, Math.min(ENUM_PAGE_MAX, Number(provider?.maxPageSize) || ENUM_PAGE_DEFAULT));
// Backstop for a provider that never returns an empty page. Derived from the
// safety cap and the page size ACTUALLY in use, so the two can't disagree — a
// page budget smaller than the row budget would silently become the real
// ceiling, which is the bug this whole block exists to not have. It is a
// function rather than a constant for exactly that reason: a per-provider page
// against a global page budget is the same drift in a new place.
const maxPagesFor = (pageSize) => Math.ceil(SAFETY_CAP / pageSize);

// How long a drain may keep reading the window it is draining, past the clock
// TTL (`drain` in enumerate). Six hours comfortably covers a full-catalog drain
// (~27 minutes at the current caps) with room for a slow provider; a run that
// outlives it re-walks once and carries on, which is merely the old behaviour
// rather than a failure.
//
// It is a staleness ceiling, not a memory bound — and the held entry is exactly
// the one pruneExpired can't reclaim, because each tick's touch keeps it fresh
// by design. Residency is therefore one window (a full CoinGecko catalog is
// ~7-10 MB) per CONCURRENTLY DRAINING key, released by the next prune once the
// run stops touching it. Bounded by how many boards drain at once, not by this.
const WINDOW_MAX_MS = 6 * 60 * 60 * 1000;

// Enumerated-window cache. Filling the window is the expensive part, and it
// got more expensive when the window stopped being rationed: one metered
// request per 250 rows, so a full CoinGecko pass is ~74 of them (minutes,
// serialized through the per-provider rate limiter and competing with the
// live refresh sweep), where the old 1000-row ration made it 4. FMP is the
// other extreme — its whole universe is served from one cached screener fill,
// so the walk costs nothing. That spread is why the cache and the flight
// below matter more than the page count does, and why an operator who wants
// the metered case rationed sets INGEST_FEED_CAP rather than the app guessing
// a number for them. But filters and the per-run limit are applied DOWNSTREAM by the
// shared engine; only the sort reaches the provider. So a count, its result
// pages, repeated previews, and filter tweaks in one session all want the SAME
// window — cache it briefly, keyed by connector + active provider + sort + cap,
// so only the first call pays. The catalog is a point-in-time snapshot either
// way, and the sweep tolerates a few seconds of staleness. Entries are pruned
// on write (window-cache.js), which matters more here than it looks: one key
// can now pin a whole catalog, so a stale sort/order combination left behind
// by a config edit is megabytes, not kilobytes.
//
// The TTL is a CLOCK, and a clock is the wrong bound for one caller: a drain
// tick is the same logical run coming back for its next 250 items, and it holds
// the window past the TTL rather than re-walking (`extend`, in enumerate).
// Everyone else keeps the clock.
const windowCache = new Map();
// In-flight fills, keyed like the cache. The cache alone only helps callers
// who arrive AFTER a walk finishes; concurrent ones (a preview click while
// the sweep is mid-run, two people on the same board) each used to walk the
// whole catalog and then race to write the same key. That was 4 requests
// apiece when the window was rationed to 1000 rows and is ~74 now that it
// reaches all of CoinGecko — so the second walk is the expensive one to not
// make. Same single-flight the FMP screener uses, for the same reason.
const windowFlights = new Map();

// When can the walk stop early? Only when stopping is a PROOF, never when it is
// a preference. A filter on the SORT key, in the sort's own direction, is such
// a proof: walking market_cap descending under `market_cap >= 10M`, the first
// row below 10M guarantees every later row is below it too. The rows skipped
// are rows the engine would have dropped anyway, so the count stays exact,
// nothing becomes permanently unreachable (the clog `ENUM_CAP` exists to avoid),
// and a preview and a run still agree — they run this same rule.
//
// That is the whole difference from stopping at "enough matches", which this
// file deliberately does NOT do (planning/ingest-drain-rewalk.md rejects it):
// a row cap silently loses rows the ledger would later need, decays as a board
// fills, and turns a count into a lower bound. A threshold loses nothing.
//
// Gated on the provider honoring the sort SERVER-side (`honorsSorts`), because
// the ordering is the entire proof. CoinGecko silently serves market_cap order
// for a `price` sort, and stopping early on an order the provider never applied
// would return confidently wrong rows.
const STOP_OP = { desc: "gte", asc: "lte" };
function exhaustedBy(cfg, sortBy, order, provider) {
  if (!(provider?.honorsSorts || []).includes(sortBy)) return null;
  const op = STOP_OP[order];
  const bound = Number((cfg.filters || []).find((f) => f.fn === sortBy && f.op === op)?.value);
  if (!Number.isFinite(bound)) return null;
  return {
    // Rides in the cache key. An early-exited window is a PARTIAL catalog, and
    // the key otherwise omits filters on purpose (a filter-only edit reuses the
    // window) — serving this one to a lower bound would silently lose rows.
    tag: `${op}${bound}`,
    // A non-finite value proves nothing about the ordering, so it never stops
    // the walk; the engine drops it downstream for failing the filter anyway.
    test: (values) => {
      const v = Number(values?.[sortBy]);
      return Number.isFinite(v) && (order === "asc" ? v > bound : v < bound);
    },
  };
}

// One catalog walk, page by page, into the cache. Split out of `enumerate` so
// the flight bookkeeping around it stays three readable lines and the body
// keeps its own scope.
async function fillWindow(db, conn, { ck, cap, sortBy, order, ttl, pageSize, stop }) {
  const startedAt = Date.now();
  const seen = new Set();
  const candidates = [];
  let dry = false;    // the catalog itself ended (an empty page)
  let proven = false; // nothing further CAN match (see exhaustedBy)
  const maxPages = maxPagesFor(pageSize);
  for (let page = 1; page <= maxPages && candidates.length < cap && !proven; page++) {
    const rows = await conn.list(db, { sort: sortBy, order, page, pageSize });
    if (!rows.length) { dry = true; break; }
    for (const r of rows) {
      if (candidates.length >= cap) break;
      // Candidate key = the entity identity derivation (lowercase symbol,
      // falling back to the provider id) so the ledger, on_board flags and
      // the unique constraint all agree on what "already here" means.
      const key = (r.symbol || "").toLowerCase() || String(r.id);
      if (seen.has(key)) continue; // rank drift between pages
      seen.add(key);
      const c = { key, id: r.id, label: r.label, values: r.values || {} };
      candidates.push(c);
      // Finish the page rather than breaking here: these rows are already
      // bought, and rank drift means the first failing row is a signal, not a
      // hard boundary — keeping the rest of the page is free margin.
      if (stop?.test(c.values)) proven = true;
    }
  }
  // Truncated unless the walk reached a real end. Two count as real: the
  // catalog visibly ended (an empty page), or the filter's matching set did
  // (`proven`). What ISN'T an end is a window filled to the cap — it can't
  // know what lies past it, so a provider whose universe is exactly the cap
  // must still read "N+" — nor a page-budget exit (maxPagesFor), which means
  // pages were still coming.
  return writeWindow(windowCache, ck, ttl, { candidates, truncated: !(dry || proven) }, startedAt);
}

export function forBoard(board) {
  const name = board?.mapping?.input?.connector;
  const conn = name ? getConnector(name) : null;
  return conn ? feedAdapter(conn) : null;
}

// The adapter for one bound connector (connectors/index.js `bind` shape:
// name/manifest/list/activeProvider/fetchEntity). Split from forBoard so
// tests can drive a stub connector through the full interface.
export function feedAdapter(conn) {
  const browse = conn.manifest?.browse;
  if (!browse) return null; // a domain without a catalog can't feed

  return {
    descriptor: () => ({
      source: [], // the connector's universe IS the source — nothing to configure
      // `kind` is the filter engine's vocabulary; `display` keeps the column's
      // richer browse kind (usd/percent) so the preview list can format values
      // the way the browse modal does instead of flattening to bare numbers.
      filters: (browse.columns || []).map((c) => ({
        fn: c.key,
        kind: FILTER_KIND[c.kind] || "text",
        label: c.label,
        display: c.kind,
        // `preview: true` opts a column into the ingest preview's column set
        // (see ingest-modal). Kept off the object when unset so the catalog
        // stays clean and a source that flags none falls back to showing all.
        ...(c.preview ? { preview: true } : {}),
      })),
      sorts: (browse.sorts || []).map((s) => ({ by: s.key, label: s.label })),
      // No "continuous": that mode is the folder adapter's 30s rescan, which
      // would be rude against a metered API. Interval still allows 1 minute —
      // the per-provider token bucket is the real guardrail, not this list.
      triggerModes: ["manual", "interval", "daily"],
      // Admissions per tick. The shared default (25) is a tick-latency budget
      // from file ingestion, where an admission decodes an image and the cost
      // is per-ITEM. A feed's cost is per-TICK — one window walk, one prewarm
      // call — so a small batch pays the setup over and over. 250 matches the
      // quote-cache chunk both crypto providers batch at, so a tick stays one
      // prefetch request; it is only safe because `prewarm` exists (before it,
      // 250 serial metered admissions was ~25 minutes of paced HTTP per tick).
      // The ~3KB `ids=` URL that implies is well inside the usual 8KB bar; if a
      // provider ever 414s, the cap is what comes down.
      runCap: 250,
    }),

    // The preview route bounds its enumerate with this so its count and a
    // real run (which calls enumerate unbounded) read the same window.
    windowCap: () => ENUM_CAP(browse),

    // Page the active provider's catalog into candidates, taken in the
    // configured sort order — boundedness makes the provider-side sort
    // load-bearing: "top N by X" must fill the window in X order or rows
    // outside a differently-ordered window are invisible. (A provider that
    // can't honor a sort key falls back to its default order — the shared
    // engine still re-sorts within the window, but the window itself is then
    // approximate. CoinGecko has no price order, for instance.)
    // The options bag says WHO is calling, not what to do about it: `limit`
    // bounds the window (the preview route), `drain` marks a tick continuing a
    // run already in flight (the sweep, when drain_left > 0). What each one
    // buys is this adapter's business — the file adapter reads `drain` and
    // deliberately does nothing with it.
    async enumerate(db, _board, cfg, { limit = Infinity, drain = false } = {}) {
      const active = await conn.activeProvider(db);
      if (!active.provider.list)
        throw new Error(`the active ${conn.name} provider can't browse its catalog — switch providers to use feeds`);
      const cap = Math.min(limit, ENUM_CAP(browse));
      const sortBy = cfg.sort?.by || browse.defaultSort;
      const order = cfg.sort?.order === "asc" ? "asc" : "desc";

      // Serve a warm window (filters/limit are applied by the caller, so a
      // filter-only edit still hits). The candidate objects are read-only
      // downstream (applyFilters/applySort copy), so sharing by reference is safe.
      // The page size doesn't enter the key: it changes how the window is
      // FETCHED, not what it contains, and a provider switch already re-keys.
      // A stop bound DOES change what it contains — see exhaustedBy.
      const stop = exhaustedBy(cfg, sortBy, order, active.provider);
      const ck = `${conn.name}|${active.name}|${sortBy}|${order}|${cap}|${stop?.tag ?? ""}`;
      const ttl = cacheTtl();
      // A drain tick reads the window it IS draining, past the clock TTL. The
      // clock was never the right bound for it: a run admits one cap's worth per
      // tick and re-arms immediately, so a 5,000-coin board was ~200 ticks and —
      // since the walk's own admissions outlast a 60s quote TTL — ~200 full
      // walks of a metered catalog, ~74 requests apiece. Holding it makes a run
      // one point-in-time snapshot, which is also the more correct reading of
      // "top-N stays exact" than re-deciding the catalog every tick. WINDOW_MAX_MS
      // bounds the hold; a preview passes none, so an interactive caller still
      // sees a catalog no older than the TTL.
      const hit = readWindow(windowCache, ck, { ttl, hold: drain ? WINDOW_MAX_MS : 0 });
      if (hit) return hit;
      // Join a walk already in progress rather than starting a second one.
      const flight = windowFlights.get(ck);
      if (flight) return flight;

      // Released on settle either way: a failed walk must not wedge the key,
      // and a successful one is served from the cache from here on.
      const walk = fillWindow(db, conn, { ck, cap, sortBy, order, ttl, pageSize: pageSizeFor(active.provider), stop })
        .finally(() => windowFlights.delete(ck));
      windowFlights.set(ck, walk);
      return walk;
    },

    // Warm the provider's quote cache for a batch about to be admitted, in one
    // request instead of one per item. `admit` below reaches fetchEntity, which
    // reads the same per-provider quote cache the catalog walk warms in passing
    // — but the walk is minutes long against a 60s quote TTL, so by admission
    // time the rows it bought for the top of the sort order are cold and every
    // admission re-buys one retail — a metered request per admitted item, for
    // data the run had already paid for. Batched, a whole tick is one.
    //
    // Best-effort by contract, like the refresh sweep's prefetch leg: a failure
    // means the per-item path pays retail, which is exactly the old behaviour.
    // A provider without `prefetch` is a no-op all the way down.
    async prewarm(db, _board, batch) {
      if (!conn.prefetchIds) return;
      await conn.prefetchIds(db, batch.map((c) => c.id))
        .catch((e) => console.warn(`${conn.name} ingest prewarm failed (per-item fallback): ${e.message}`));
    },

    // One catalog row → one entity + tag vehicle through the same path as a
    // manual add (charts, live-field scheduling, park policy included), then
    // the ledger row. `.duplicate` propagates — the sweep ledgers it.
    async admit(db, board, candidate) {
      await addConnectorEntity(db, board, conn, conn.name, String(candidate.id));
      await recordIngest(db, board.id, candidate.key, Date.now());
    },
  };
}

// Test seams (window-cache.js owns what they know about an entry; the flights
// map is this adapter's own, so clearing it belongs here).
export function _resetWindowCache() {
  resetWindow(windowCache);
  windowFlights.clear();
}
export const _ageWindowCache = (ms) => ageWindow(windowCache, ms);
