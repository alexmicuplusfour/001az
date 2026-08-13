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
import { SAFETY_CAP, cacheTtl, pruneExpired } from "./window-cache.js";

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
// Requested page size. Providers may clamp internally, but keep their offset
// math consistent with their own clamp, so a short-but-nonempty page is
// normal paging — enumeration stops ONLY on an empty page. Treating a short
// page as "dry" would silently miss everything past a provider's first
// clamped page. 250 is also the ceiling the catalogs themselves impose on a
// page (CoinGecko's per_page maxes there), and FMP's local clamp is aligned
// to it, so its whole universe is cache-served slices at zero HTTP warm.
const ENUM_PAGE = 250;
// Backstop for a provider that never returns an empty page. Derived from the
// safety cap so the two can't disagree — a page budget smaller than the row
// budget would silently become the real ceiling, which is the bug this whole
// block exists to not have.
const MAX_PAGES = Math.ceil(SAFETY_CAP / ENUM_PAGE);

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
const windowCache = new Map();
// In-flight fills, keyed like the cache. The cache alone only helps callers
// who arrive AFTER a walk finishes; concurrent ones (a preview click while
// the sweep is mid-run, two people on the same board) each used to walk the
// whole catalog and then race to write the same key. That was 4 requests
// apiece when the window was rationed to 1000 rows and is ~74 now that it
// reaches all of CoinGecko — so the second walk is the expensive one to not
// make. Same single-flight the FMP screener uses, for the same reason.
const windowFlights = new Map();

// One catalog walk, page by page, into the cache. Split out of `enumerate` so
// the flight bookkeeping around it stays three readable lines and the body
// keeps its own scope.
async function fillWindow(db, conn, { ck, cap, sortBy, order, ttl }) {
  const seen = new Set();
  const candidates = [];
  let dry = false; // saw the catalog actually end (an empty page)
  for (let page = 1; page <= MAX_PAGES && candidates.length < cap; page++) {
    const rows = await conn.list(db, { sort: sortBy, order, page, pageSize: ENUM_PAGE });
    if (!rows.length) { dry = true; break; }
    for (const r of rows) {
      if (candidates.length >= cap) break;
      // Candidate key = the entity identity derivation (lowercase symbol,
      // falling back to the provider id) so the ledger, on_board flags and
      // the unique constraint all agree on what "already here" means.
      const key = (r.symbol || "").toLowerCase() || String(r.id);
      if (seen.has(key)) continue; // rank drift between pages
      seen.add(key);
      candidates.push({ key, id: r.id, label: r.label, values: r.values || {} });
    }
  }
  // Truncated unless the catalog visibly ended: a window filled to the cap
  // can't know what lies past it (a provider whose universe is exactly the
  // cap must still read "N+", not "all of it"), and a MAX_PAGES exit means
  // pages were still coming.
  const result = { candidates, truncated: !dry };
  if (ttl > 0) {
    const now = Date.now();
    pruneExpired(windowCache, now, ttl);
    windowCache.set(ck, { at: now, ...result });
  }
  return result;
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
    async enumerate(db, _board, cfg, { limit = Infinity } = {}) {
      const active = await conn.activeProvider(db);
      if (!active.provider.list)
        throw new Error(`the active ${conn.name} provider can't browse its catalog — switch providers to use feeds`);
      const cap = Math.min(limit, ENUM_CAP(browse));
      const sortBy = cfg.sort?.by || browse.defaultSort;
      const order = cfg.sort?.order === "asc" ? "asc" : "desc";

      // Serve a warm window (filters/limit are applied by the caller, so a
      // filter-only edit still hits). The candidate objects are read-only
      // downstream (applyFilters/applySort copy), so sharing by reference is safe.
      const ck = `${conn.name}|${active.name}|${sortBy}|${order}|${cap}`;
      const ttl = cacheTtl();
      const hit = windowCache.get(ck);
      if (hit && ttl > 0 && Date.now() - hit.at < ttl)
        return { candidates: hit.candidates, truncated: hit.truncated };
      // Join a walk already in progress rather than starting a second one.
      const flight = windowFlights.get(ck);
      if (flight) return flight;

      // Released on settle either way: a failed walk must not wedge the key,
      // and a successful one is served from the cache from here on.
      const walk = fillWindow(db, conn, { ck, cap, sortBy, order, ttl })
        .finally(() => windowFlights.delete(ck));
      windowFlights.set(ck, walk);
      return walk;
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
