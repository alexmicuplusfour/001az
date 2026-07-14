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

// Browse column kinds are display vocabulary (usd/percent drive client
// formatting); the filter engine only knows text/number/date.
const FILTER_KIND = { text: "text", number: "number", usd: "number", percent: "number", date: "date" };

// The enumeration window: how deep into the catalog a feed can see. Matches
// the preview route's PREVIEW_CAP; past it `truncated` renders as "N+".
const ENUM_CAP = 1000;
// Requested page size. Providers clamp internally (FMP caps at 100) but keep
// their offset math consistent with their own clamp, so a short-but-nonempty
// page is normal paging — enumeration stops ONLY on an empty page. Treating
// a short page as "dry" would silently miss everything past a provider's
// first clamped page.
const ENUM_PAGE = 250;
const MAX_PAGES = 40; // backstop for a provider that never returns empty

// Enumerated-window cache. Filling the window is the expensive part — up to
// ENUM_CAP/ENUM_PAGE metered provider calls (≈4 CoinGecko fetches, ~9s cold),
// serialized through the per-provider rate limiter and competing with the live
// refresh sweep. But filters and the per-run limit are applied DOWNSTREAM by the
// shared engine; only the sort reaches the provider. So a count, its result
// pages, repeated previews, and filter tweaks in one session all want the SAME
// window — cache it briefly, keyed by connector + active provider + sort + cap,
// so only the first call pays. The catalog is a point-in-time snapshot either
// way, and the sweep tolerates a few seconds of staleness. TTL is read per call
// (not frozen at import) so tests can disable it; 0 = always fresh.
const windowCache = new Map();
const cacheTtl = () =>
  process.env.INGEST_FEED_CACHE_MS != null ? Number(process.env.INGEST_FEED_CACHE_MS) : 60000;

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
      })),
      sorts: (browse.sorts || []).map((s) => ({ by: s.key, label: s.label })),
      // No "continuous": that mode is the folder adapter's 30s rescan, which
      // would be rude against a metered API. Interval still allows 1 minute —
      // the per-provider token bucket is the real guardrail, not this list.
      triggerModes: ["manual", "interval", "daily"],
    }),

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
      const cap = Math.min(limit, ENUM_CAP);
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
      // cap — FMP's 1000-row screener — must still read "N+", not "all of it"),
      // and a MAX_PAGES exit means pages were still coming.
      const result = { candidates, truncated: !dry };
      if (ttl > 0) windowCache.set(ck, { at: Date.now(), ...result });
      return result;
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
