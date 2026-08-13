// Financial Modeling Prep provider for the stocks connector: US-LISTED
// securities in USD — companies including foreign issuers' ADRs, ETFs and
// closed-end funds, i.e. everything this tier can actually quote. FMP's stable
// API supplies search, screening, quotes, company profiles, and end-of-day
// price history.
//
// Scale posture (planning/connector-scale-plan.md has the 2026-08-03 numbers;
// re-measured 2026-08-13, planning/connector-full-catalog.md): the
// `company-screener` is the one bulk fact — it answers in under a second and
// carries price/market cap/volume/sector/industry/exchange for the whole
// universe. It caps a RESPONSE at 10,000 rows however large a limit you send,
// and its page param returns overlapping pages, so depth comes from asking in
// disjoint slices (one per venue) and unioning them — never from pagination.
// Batch-quote endpoints stay premium-gated and comma-list `quote` still
// silently returns [] — so the screener snapshot, cached and revalidated
// below, is what makes a 1000-entity board cheap: browse, feeds, and the bulk
// of the refresh sweep all read from it, and only change_1d costs a per-symbol
// quote. Symbols outside the venue list are reachable through the list()
// search bridge, each served by one quote.
import { providerSignal, providerBudgetMs, num } from "../runtime.js";

const BASE = "https://financialmodelingprep.com/stable";
const PROFILE_TTL = 6 * 60 * 60 * 1000;
// Universe freshness: inside BROWSE_TTL serve as-is; past it serve stale and
// revalidate in the background; past SCREENER_MAX_AGE block on a fresh fetch
// so the data can't go silently ancient (an hour of drift in a market-cap
// ordering is fine; a day is not).
const BROWSE_TTL = 5 * 60 * 1000;
const SCREENER_MAX_AGE = 60 * 60 * 1000;
// The venues this tier can actually quote (verified 2026-08-13): the three
// listed exchanges plus OTC. Non-US venue symbols (SAP.DE) are premium-gated
// at the quote endpoint — their US listings/ADRs are the servable path, and
// search surfaces those.
const QUOTABLE_EXCHANGE = /NASDAQ|NYSE|AMEX|OTC/i;

// The `limit` each screener slice asks for. Depth is free — the universe is
// one cached fill however deep — so the default is set well above what the
// catalog holds rather than tuned to it, and the knob exists to SHRINK memory
// and response size, not to protect the API. It cannot raise the real ceiling:
// FMP caps any single response at SCREENER_MAX_ROWS whatever this says, which
// is why the fill is partitioned by venue below. Read per call so tests can
// steer it.
const universeRows = () =>
  Math.max(100, Math.min(100000, Number(process.env.FMP_UNIVERSE_ROWS) || 30000));

// The venues the universe covers. This IS a real boundary — a non-US venue
// symbol (SAP.DE) is premium-gated at the quote endpoint, so listing one in
// browse would only produce rows that fail on add. It's a knob rather than a
// constant because OTC is the judgement call: this tier quotes OTC (verified
// 2026-08-13, SAPX), so adding it is supported — it's just thousands more
// rows on every screener fill, which is bandwidth an operator's plan meters
// (FMP caps trailing-30-day bandwidth per tier). Default stays the three
// major venues; set FMP_EXCHANGES to widen. OTC symbols remain addable by
// search either way — this governs what BROWSE and FEEDS enumerate.
const universeExchanges = () =>
  (process.env.FMP_EXCHANGES || "NASDAQ,NYSE,AMEX")
    .split(",").map((v) => v.trim()).filter(Boolean);

export const label = "Financial Modeling Prep";
export const description = "US stock quotes, fundamentals, and price history — needs a key";
export const needsKey = true;
// Credit shown wherever this provider's rows are. Unlike CoinGecko's — whose
// demo ToS explicitly requires visible attribution — FMP's display terms
// could NOT be verified from here (their site refuses automated fetches, and
// what is readable suggests displaying or redistributing their data may need
// a separate data-display agreement rather than a credit line). Crediting
// them is the conservative default; whether this deployment's use needs a
// licence is the operator's question to settle with FMP, not one this
// constant answers.
export const attribution = { text: "Data by Financial Modeling Prep", url: "https://financialmodelingprep.com" };
// Truthful request pacing: this provider awaits ctx.pace() before every raw
// HTTP request (pacesRequests — see runtime.callProvider), so rpm meters what
// FMP actually meters. 240 sustained + burst 20 stays under the 300/min
// paid-tier ceiling with headroom for retries; a cold fetchEntity honestly
// pays 3 tokens (quote + profile + ratios), a warm cache-served list() pays 0.
// (Free-tier *daily* quotas are a separate limit this bucket doesn't model.)
export const pacesRequests = true;
export const rpm = 240;
export const burst = 20;

function fail(message, status) {
  const e = new Error(`Financial Modeling Prep: ${message}`);
  if (status != null) e.status = status;
  return e;
}

// One raw FMP request: paced (when the runtime threaded a pacer in), bounded
// by the call class's budget, and with timeouts renamed from the bare
// DOMException text to something an operator can act on. The timeout error
// stays status-less on purpose — withRetry must not retry a slow endpoint.
async function fmp(endpoint, params, apiKey, { bulk = false, pace } = {}) {
  if (!apiKey) throw fail("needs an API key");
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("apikey", apiKey);

  await pace?.();
  let r;
  try {
    r = await fetch(url, { signal: providerSignal(bulk ? "bulk" : undefined) });
  } catch (e) {
    if (e?.name === "TimeoutError")
      throw fail(`${endpoint} timed out after ${Math.round(providerBudgetMs(bulk ? "bulk" : undefined) / 1000)}s`);
    throw e;
  }
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw fail(`invalid response (HTTP ${r.status})`, r.status); }

  const apiMessage = body?.["Error Message"] || body?.error || body?.message;
  if (!r.ok || apiMessage) {
    const safe = String(apiMessage || `HTTP ${r.status}`).replaceAll(apiKey, "[redacted]");
    const e = fail(safe, r.status);
    const retryAfter = r.headers?.get?.("retry-after");
    if (retryAfter != null) e.retryAfter = retryAfter;
    throw e;
  }
  return body;
}

const symbolOf = (row) => String(row?.symbol || "").trim().toUpperCase();
const exchangeOf = (row) => row?.exchangeShortName || row?.exchange || row?.stockExchange || "";
// What kind of listing a screener row is. The screener carries isEtf/isFund
// flags; they used to be exclusion criteria and are now just a column and a
// filter, so an ETF is something a user can narrow to (or away from) instead
// of something the app decided they couldn't see.
const typeOf = (row) => (row?.isEtf ? "ETF" : row?.isFund ? "Fund" : "Stock");
const isQuotableListing = (row) =>
  (!row?.currency || String(row.currency).toUpperCase() === "USD") &&
  QUOTABLE_EXCHANGE.test(exchangeOf(row));

export async function search(query, { apiKey, pace } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  // FMP splits ticker and company-name lookup into separate endpoints. Merge
  // both so one connector search box behaves naturally for either input — and
  // tolerate one being unavailable (tier-gated / rate-limited) rather than
  // failing the whole search; only a total failure (both rejected) propagates.
  const [symRes, nameRes] = await Promise.allSettled([
    fmp("search-symbol", { query: q, limit: 25 }, apiKey, { pace }),
    fmp("search-name", { query: q, limit: 25 }, apiKey, { pace }),
  ]);
  if (symRes.status === "rejected" && nameRes.status === "rejected") throw symRes.reason;
  const rowsOf = (res) => (res.status === "fulfilled" && Array.isArray(res.value) ? res.value : []);
  const unique = new Map();
  for (const row of [...rowsOf(symRes), ...rowsOf(nameRes)]) {
    const symbol = symbolOf(row);
    if (symbol && !unique.has(symbol)) unique.set(symbol, row);
  }
  return [...unique.values()]
    .filter((row) => symbolOf(row) && isQuotableListing(row))
    .slice(0, 10)
    .map((row) => ({
      id: symbolOf(row),
      symbol: symbolOf(row),
      label: row.name || row.companyName || symbolOf(row),
      exchange: exchangeOf(row) || null,
    }));
}

const profileCache = new Map();
const ratiosCache = new Map();

async function profileFor(symbol, apiKey, pace) {
  const cached = profileCache.get(symbol);
  if (cached && Date.now() - cached.at < PROFILE_TTL) return cached.value;
  const rows = await fmp("profile", { symbol }, apiKey, { pace });
  const value = Array.isArray(rows) ? rows[0] : null;
  if (value) profileCache.set(symbol, { at: Date.now(), value });
  return value;
}

async function ratiosFor(symbol, apiKey, pace) {
  const cached = ratiosCache.get(symbol);
  if (cached && Date.now() - cached.at < PROFILE_TTL) return cached.value;
  const rows = await fmp("ratios-ttm", { symbol }, apiKey, { pace });
  const value = Array.isArray(rows) ? rows[0] : null;
  if (value) ratiosCache.set(symbol, { at: Date.now(), value });
  return value;
}

// FMP zeroes `volume` outside trading sessions (verified 2026-08-13, even for
// AAPL) — a 0 here means "no prints reported yet", never a real reading.
// Serve null so the UI shows "—" instead of a false zero.
const tradedVolume = (value) => num(value) || null;

export async function fetchEntity(id, { apiKey, pace } = {}) {
  const requested = String(id || "").trim().toUpperCase();
  if (!requested) throw fail("symbol is required");
  // quote is the required core (price / market cap / volume / change). profile
  // and ratios are enrichment — a tier that gates or rate-limits them shouldn't
  // sink the add, so they degrade to null while quote still yields an entity. A
  // quote failure keeps its status (via allSettled's reason) so the runtime can
  // still recognise and retry a 429.
  const [quoteRes, profileRes, ratiosRes] = await Promise.allSettled([
    fmp("quote", { symbol: requested }, apiKey, { pace }),
    profileFor(requested, apiKey, pace),
    ratiosFor(requested, apiKey, pace),
  ]);
  if (quoteRes.status === "rejected") throw quoteRes.reason;
  const quote = Array.isArray(quoteRes.value) ? quoteRes.value[0] : null;
  if (!quote) throw fail(`no quote for ${requested}`);
  const profile = profileRes.status === "fulfilled" ? profileRes.value : null;
  const ratios = ratiosRes.status === "fulfilled" ? ratiosRes.value : null;

  const symbol = symbolOf(quote) || symbolOf(profile) || requested;
  const change = quote.changePercentage ?? quote.changesPercentage ?? profile?.changePercentage ?? profile?.changesPercentage;
  const exchange = exchangeOf(quote) || exchangeOf(profile) || null;
  const dividendYield = num(ratios?.dividendYieldTTM);
  return {
    id: symbol,
    symbol,
    display_name: quote.name || profile?.companyName || symbol,
    fields: {
      price:      { v: num(quote.price ?? profile?.price), kind: "number" },
      change_1d:  { v: num(change), kind: "number" },
      market_cap: { v: num(quote.marketCap ?? profile?.marketCap), kind: "number" },
      volume:     { v: tradedVolume(quote.volume ?? profile?.volume), kind: "number" },
      pe_ratio:   { v: num(quote.pe ?? ratios?.priceToEarningsRatioTTM), kind: "number" },
      dividend_yield: {
        v: dividendYield == null ? null : dividendYield * 100,
        kind: "number",
      },
      sector:     { v: profile?.sector || null, kind: "text" },
      industry:   { v: profile?.industry || null, kind: "text" },
      exchange:   { v: exchange, kind: "text" },
      currency:   { v: profile?.currency || "USD", kind: "text" },
      website:    { v: profile?.website || null, kind: "url" },
    },
  };
}

// Browse row from a screener row. The screener carries name / price / market
// cap / volume / sector / exchange but no intraday change — so `change_1d` is
// deliberately absent here (and from browse.columns); boards still get it live
// from the quote-fed field refresh.
function browseRow(row) {
  const symbol = symbolOf(row);
  const name = row?.companyName || row?.name || symbol;
  return {
    id: symbol,
    symbol,
    label: name,
    values: {
      rank: row?.mcapRank ?? null,
      name,
      price: num(row?.price),
      market_cap: num(row?.marketCap),
      volume: tradedVolume(row?.volume),
      // Bridge rows (quote-filled, no screener row) have no flags to read, so
      // they carry no type rather than a guessed "Stock".
      type: row?.assetType ?? null,
      sector: row?.sector || null,
      exchange: exchangeOf(row) || null,
    },
  };
}

function sortRows(rows, sort, order) {
  const key = { name: "companyName", price: "price", market_cap: "marketCap", volume: "volume" }[sort] || "marketCap";
  const direction = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a?.[key], bv = b?.[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return direction * (typeof av === "string"
      ? av.localeCompare(String(bv))
      : Number(av) - Number(bv));
  });
}

// The screener universe: rows + a symbol index for O(1) refresh lookups +
// per-order sorted views + the in-flight fetch shared by every concurrent
// caller (preview, sweep, and browse race on a cold board — without
// single-flight each would burn its own ~15 s metered request; with it, one
// request, one token, one failure wave).
//
// `sorted` memoizes the ORDERING, not the rows: an unfiltered page is a slice
// of a sorted array, and the ordering is identical for every page of a given
// sort until the next fill. Without it each browse page and each of the ~100
// enumeration slices re-sorted the whole universe — ~11 ms of blocking sort
// per call at 26k rows, so a single window fill spent well over a second
// sorting the same array into the same order. Filtered and queried calls still
// sort their own (smaller) subset.
let screenerCache = { at: 0, rows: null, bySymbol: null, sorted: new Map(), inflight: null };

// The universe in one order, computed once per fill. `rows` is only ever
// replaced wholesale (fetchUniverse builds a new cache object), so a memo can
// never outlive the array it describes.
function sortedUniverse(rows, sort, order) {
  if (rows !== screenerCache.rows) return sortRows(rows, sort, order);
  const key = `${sort || ""}|${order || ""}`;
  let view = screenerCache.sorted.get(key);
  if (!view) {
    view = sortRows(rows, sort, order);
    screenerCache.sorted.set(key, view);
  }
  return view;
}

// FMP caps a screener RESPONSE at 10,000 rows however big a `limit` you send
// (measured 2026-08-13: limit=30000 returned exactly 10,000, and the response
// ended there rather than being paged short). Their `page` param overlaps
// between pages, so paging isn't a way past it either.
//
// A cap on one response is not a cap on the catalog, though: ask in DISJOINT
// pieces and union them. Venue is the natural partition — a listing has
// exactly one exchange — and if a single venue is itself at the cap, split it
// again by listing type, which is also disjoint and also complete (every row
// is an ETF, a fund, or neither). So the ceiling stays the API's shape rather
// than a number the app quietly accepted.
const SCREENER_MAX_ROWS = 10000;

// One screener request. The ONLY narrowing here is what the tier itself
// enforces — venues it can quote, listings that still trade — plus whatever
// partition key the caller is slicing on. What this used to add on top was
// the app deciding what a user may browse: `country=US` excluded every ADR
// (BABA, TSM, ASML all trade on NYSE/NASDAQ and quote fine here — it filtered
// company DOMICILE, which is neither a tier gate nor a venue), and
// isEtf/isFund=false excluded ~6.3k ETFs and the closed-end funds. Those are
// a `type` filter now: the user narrows, not the manifest.
async function screenerRows(params, apiKey, pace) {
  const rows = await fmp("company-screener", {
    isActivelyTrading: true,
    limit: universeRows(),
    ...params,
  }, apiKey, { bulk: true, pace });
  return Array.isArray(rows) ? rows : [];
}

// One venue's listings, re-partitioned if the venue alone saturates the cap.
// The saturated response is KEPT and unioned with the sub-slices rather than
// replaced by them: it is 10,000 real listings already paid for, and the
// caller dedupes, so including it can only add coverage. That also makes the
// split strictly additive — a sub-slice that fails, or that FMP answers in a
// way these params don't actually narrow, costs nothing instead of costing
// the venue. allSettled for the same reason: one refused slice must not throw
// away a venue we could otherwise serve.
async function venueRows(exchange, apiKey, pace) {
  const rows = await screenerRows({ exchange }, apiKey, pace);
  if (rows.length < SCREENER_MAX_ROWS) return rows;
  const settled = await Promise.allSettled([
    screenerRows({ exchange, isEtf: true }, apiKey, pace),
    screenerRows({ exchange, isFund: true }, apiKey, pace),
    screenerRows({ exchange, isEtf: false, isFund: false }, apiKey, pace),
  ]);
  const parts = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  for (const s of settled) {
    if (s.status === "rejected")
      console.warn(`FMP screener: a ${exchange} sub-slice failed (serving the rest): ${s.reason?.message || s.reason}`);
  }
  // Saying so beats silently serving a truncated universe: at this point the
  // venue has more of ONE type than a response can carry, and the next split
  // (market-cap bands) would need care about rows FMP prices at 0.
  if (parts.some((part) => part.length >= SCREENER_MAX_ROWS))
    console.warn(`FMP screener: ${exchange} saturates ${SCREENER_MAX_ROWS} rows even split by type — some listings are out of reach`);
  return [rows, ...parts].flat();
}

function fetchUniverse(apiKey, pace) {
  if (!screenerCache.inflight) {
    const p = (async () => {
      const perVenue = await Promise.all(universeExchanges().map((v) => venueRows(v, apiKey, pace)));
      // Partitions are disjoint by construction; dedupe anyway, so a symbol
      // FMP reports under two venues can't become two rows (and two ranks).
      // Keyed by symbol, so this Map IS the refresh index — no second pass to
      // rebuild the same thing (26k rows and 26k symbolOf calls, per fill).
      const bySymbol = new Map();
      for (const row of perVenue.flat()) {
        const symbol = symbolOf(row);
        if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, row);
      }
      const list = [...bySymbol.values()];
      // FMP leaves marketCap 0 on unpriced fringe listings and zeroes volume
      // outside sessions — both are missing data, not measurements. Null them
      // at fill time so ascending sorts show real micro-caps first, not a run
      // of $0 rows (sortRows places nulls last in either direction).
      for (const row of list) {
        if (!num(row?.marketCap)) row.marketCap = null;
        if (!num(row?.volume)) row.volume = null;
        row.assetType = typeOf(row);
      }
      // Market-cap rank within the universe, computed here rather than trusted
      // from response order — it makes "top 50 stocks" expressible as a feed
      // filter (rank ≤ 50), mirroring crypto's market_cap_rank.
      [...list]
        .sort((a, b) => (num(b?.marketCap) ?? 0) - (num(a?.marketCap) ?? 0))
        .forEach((row, i) => { row.mcapRank = i + 1; });
      screenerCache = { at: Date.now(), rows: list, bySymbol, sorted: new Map(), inflight: null };
      return list;
    })();
    screenerCache.inflight = p;
    // A failed fill releases the flight so the next caller retries fresh;
    // the stale rows (if any) stay served meanwhile.
    p.catch(() => { screenerCache.inflight = null; });
  }
  return screenerCache.inflight;
}

// Negative cache for the cold path: a failed fill (plan-gated screener on the
// free tier, an outage) is not re-bought for a minute — FMP counts every
// request against the plan budget (the free tier's is 250/DAY), so each
// retried failure is quota spent on a known answer. SWR refreshes bypass this
// (they already have rows to serve and log their own failures).
let screenerDown = { until: 0, error: null };

async function stockUniverse(apiKey, pace) {
  const age = Date.now() - screenerCache.at;
  if (screenerCache.rows) {
    if (age < BROWSE_TTL) return screenerCache.rows;
    if (age < SCREENER_MAX_AGE) {
      // Stale-while-revalidate: serve now, refresh behind the request. The
      // background fetch runs outside callProvider/withPluginHealth — one
      // request per TTL window (noise against rpm 240), and a failure keeps
      // the stale rows; the next hard miss surfaces it on the health row.
      fetchUniverse(apiKey, pace).catch((e) =>
        console.warn(`FMP screener refresh failed (serving stale universe): ${e.message}`));
      return screenerCache.rows;
    }
  }
  if (Date.now() < screenerDown.until) throw screenerDown.error;
  try {
    return await fetchUniverse(apiKey, pace);
  } catch (e) {
    screenerDown = { until: Date.now() + 60000, error: e };
    throw e;
  }
}

// Search bridge: what the catalog can find that the screener can't carry.
// search() covers every quotable venue — OTC and ETFs included, where the
// screener is listed-equities-only — and each out-of-universe hit costs one
// quote to fill the columns. Cached per query so paging and re-sorting a
// result set don't re-buy it; only a successful search is cached (a dead
// search endpoint degrades to universe-only results and heals on retry).
const BRIDGE_TTL = 5 * 60 * 1000;
const bridgeCache = new Map(); // query -> { at, rows } in screener row shape

async function searchBridge(q, inUniverse, apiKey, pace) {
  const cached = bridgeCache.get(q);
  if (cached && Date.now() - cached.at < BRIDGE_TTL) return cached.rows;
  let hits;
  try { hits = await search(q, { apiKey, pace }); }
  catch { return []; }
  const rows = (await Promise.all(
    hits.filter((h) => !inUniverse?.has(h.symbol)).map(async (h) => {
      try {
        const res = await fmp("quote", { symbol: h.symbol }, apiKey, { pace });
        const quote = Array.isArray(res) ? res[0] : null;
        // No sector/industry and no mcapRank: the screener is their only
        // source, and these rows exist precisely because it lacks them.
        // marketCap gets the same 0-means-missing treatment as the universe
        // fill, so an unpriced OTC row sorts last, not first-ascending.
        return quote && {
          symbol: h.symbol,
          companyName: quote.name || h.label,
          price: quote.price,
          marketCap: num(quote.marketCap) || null,
          volume: quote.volume,
          exchangeShortName: quote.exchange || h.exchange,
        };
      } catch { return null; } // one dead quote drops one row, not the search
    })
  )).filter(Boolean);
  bridgeCache.set(q, { at: Date.now(), rows });
  if (bridgeCache.size > 200) bridgeCache.delete(bridgeCache.keys().next().value);
  return rows;
}

export async function list(
  { sort, order, page = 1, pageSize = 50, query, sector, exchange, industry, type } = {},
  { apiKey, pace } = {}
) {
  // The clamp bounds one logical page of the LOCALLY cached universe — it is
  // not a remote API limit. 250 matches the feed adapter's default page size
  // (ENUM_PAGE_DEFAULT) so a window fill is 4 slices, not 10 (each logical call
  // is otherwise free: cache-served slices pace zero requests). This provider
  // deliberately declares no `maxPageSize`: bigger slices would save nothing
  // when every slice is already served from memory.
  const size = Math.max(1, Math.min(250, Number(pageSize) || 50));
  const pageNo = Math.max(1, Number(page) || 1);
  // The screener is plan-gated (FMP's free tier doesn't include it at all —
  // plan matrix checked 2026-08-13). A plain browse IS the universe, so its
  // absence propagates; a QUERY can still serve through the search bridge
  // (search + per-symbol quote are free-tier endpoints), so a gated screener
  // degrades search to bridge-only instead of a dead modal.
  let universe;
  try {
    universe = await stockUniverse(apiKey, pace);
  } catch (e) {
    if (!query || !String(query).trim()) throw e;
    universe = [];
  }

  // A query filters the screened universe first — those rows carry the full
  // column set for free — then the search bridge appends anything the catalog
  // knows that the screener doesn't. Dedup is against the WHOLE universe (the
  // symbol-keyed map from the same fill), not just the text matches: a hit
  // that's in the universe under a different company name must not double.
  const q = query && String(query).trim().toLowerCase();
  let base = q
    ? universe.filter(
        (row) =>
          symbolOf(row).toLowerCase().includes(q) ||
          String(row?.companyName || "").toLowerCase().includes(q)
      )
    : universe;
  if (q) {
    // Re-check bridge rows against the universe SERVED this call, not just the
    // one the bridge saw at fill time: a cached bridge row outlives a universe
    // refill (both TTLs are 5 min but they don't tick together), and a symbol
    // that newly entered the screener would otherwise render twice.
    const served = new Set(universe.map(symbolOf));
    const bridge = await searchBridge(q, screenerCache.bySymbol, apiKey, pace);
    base = [...base, ...bridge.filter((row) => !served.has(symbolOf(row)))];
  }

  // Filters are exact matches on screener vocabulary (manifest browse.filters
  // whitelists the values upstream). Bridge rows carry no sector, so a sector
  // filter honestly excludes them; exchange applies to both.
  if (sector) base = base.filter((row) => row?.sector === sector);
  if (industry) base = base.filter((row) => row?.industry === industry);
  if (exchange) base = base.filter((row) => exchangeOf(row) === exchange);
  // Read the SAME value the row renders. `typeOf` as a fallback here would
  // read a bridge row — which carries no isEtf/isFund flags to read — as
  // "Stock", so an ETF found by search would show "—" and still pass a
  // type=Stock filter. Bridge rows have no type, so a type filter honestly
  // excludes them, exactly as the sector filter already does.
  if (type) base = base.filter((row) => (row?.assetType ?? null) === type);

  // `base === universe` on the unfiltered path, which is what browse paging
  // and the whole feed enumeration take — those share one memoized ordering
  // instead of re-sorting 26k rows per page. Anything narrowed sorts its own.
  const sorted = sortedUniverse(base, sort, order);
  const pageRows = sorted.slice((pageNo - 1) * size, pageNo * size);
  return pageRows.map(browseRow);
}

// Field-aware refresh (runtime.refresh calls this with the DUE keys): route
// each key to its cheapest source. Universe-covered keys cost zero HTTP while
// the snapshot is warm; change_1d is the one per-symbol quote; pe/dividend
// ride the 6 h ratios cache, website/currency the 6 h profile cache. Any key
// this can't produce is simply absent — the runtime falls back to the
// whole-object fetchEntity, so a partial answer can never strand a field.
const UNIVERSE_FIELDS = new Set(["price", "market_cap", "volume", "sector", "industry", "exchange"]);

export async function fetchFields(id, keys, { apiKey, pace } = {}) {
  const symbol = String(id || "").trim().toUpperCase();
  if (!symbol) throw fail("symbol is required");
  const want = new Set(keys || []);
  const fields = {};

  let row = null;
  if ([...want].some((k) => UNIVERSE_FIELDS.has(k))) {
    // A universe failure isn't fatal here: the quote overlay below covers the
    // headline numbers, and the runtime's fetchEntity fallback surfaces any
    // real provider fault (bad key, outage) on its usual paths.
    const universe = await stockUniverse(apiKey, pace).catch(() => null);
    row = universe ? screenerCache.bySymbol?.get(symbol) || null : null;
    if (row) {
      if (want.has("price"))      fields.price      = { v: num(row.price), kind: "number" };
      if (want.has("market_cap")) fields.market_cap = { v: num(row.marketCap), kind: "number" };
      if (want.has("volume"))     fields.volume     = { v: tradedVolume(row.volume), kind: "number" };
      if (want.has("sector"))     fields.sector     = { v: row.sector || null, kind: "text" };
      if (want.has("industry"))   fields.industry   = { v: row.industry || null, kind: "text" };
      if (want.has("exchange"))   fields.exchange   = { v: exchangeOf(row) || null, kind: "text" };
    }
  }

  // change_1d needs a per-symbol quote (the screener has no intraday change);
  // a symbol outside the universe depth falls back to the quote for the
  // headline numbers too. When the quote is fetched anyway, its values are
  // fresher than the snapshot — overlay, never serve older data than the call
  // already bought.
  const needQuote = want.has("change_1d") || (!row && [...want].some((k) => UNIVERSE_FIELDS.has(k)));
  if (needQuote) {
    const rows = await fmp("quote", { symbol }, apiKey, { pace });
    const quote = Array.isArray(rows) ? rows[0] : null;
    if (quote) {
      if (want.has("change_1d")) {
        const change = quote.changePercentage ?? quote.changesPercentage;
        fields.change_1d = { v: num(change), kind: "number" };
      }
      if (want.has("price"))      fields.price      = { v: num(quote.price), kind: "number" };
      if (want.has("market_cap")) fields.market_cap = { v: num(quote.marketCap), kind: "number" };
      if (want.has("volume"))     fields.volume     = { v: tradedVolume(quote.volume), kind: "number" };
      if (want.has("exchange"))   fields.exchange   = { v: exchangeOf(quote) || null, kind: "text" };
    }
  }

  // Enrichment keys degrade like fetchEntity's: a gated/failing profile or
  // ratios call yields null values rather than a dead refresh.
  if (want.has("pe_ratio") || want.has("dividend_yield")) {
    const ratios = await ratiosFor(symbol, apiKey, pace).catch(() => null);
    if (want.has("pe_ratio")) fields.pe_ratio = { v: num(ratios?.priceToEarningsRatioTTM), kind: "number" };
    if (want.has("dividend_yield")) {
      const dy = num(ratios?.dividendYieldTTM);
      fields.dividend_yield = { v: dy == null ? null : dy * 100, kind: "number" };
    }
  }
  if (want.has("website") || want.has("currency")) {
    const profile = await profileFor(symbol, apiKey, pace).catch(() => null);
    if (want.has("website"))  fields.website  = { v: profile?.website || null, kind: "url" };
    if (want.has("currency")) fields.currency = { v: profile?.currency || "USD", kind: "text" };
  }

  return { fields };
}

const PERIOD_DAYS = { "7d": 7, "30d": 30, "90d": 90, "1y": 365, "5y": 5 * 365 };
export const periods = Object.keys(PERIOD_DAYS);

export async function history(id, period, { apiKey, pace } = {}) {
  const symbol = String(id || "").trim().toUpperCase();
  const days = PERIOD_DAYS[period] || PERIOD_DAYS["1y"];
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const rows = await fmp("historical-price-eod/full", {
    symbol,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }, apiKey, { pace });
  // The stable EOD endpoint returns an (unadjusted) `close` per day — no
  // adjusted-close field — so the chart plots the raw close.
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      t: Date.parse(`${row.date}T00:00:00Z`),
      price: num(row.close),
    }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.price))
    .sort((a, b) => a.t - b.t);
}

// Browse filter vocabularies (runtime.browseFilters). Sector and exchange are
// frozen in the manifest — 11 sectors and 3 venues that don't move. Industry
// is the fine cut under them (~150 values), which FMP publishes, so it's
// fetched rather than transcribed. One request a day.
const INDUSTRY_TTL = 24 * 60 * 60 * 1000;
let industryCache = { at: 0, options: null };

export async function filterOptions(ctx = {}) {
  // Exchange is the venue list this universe was actually built from, so the
  // control can never offer a venue browse doesn't carry — or, as when it was
  // frozen in the manifest, refuse one it does: widening FMP_EXCHANGES used to
  // widen the universe while the dropdown kept the old three and the route's
  // whitelist rejected the new one. Derived, not declared, so the knob is
  // wired end to end.
  const options = { exchange: universeExchanges() };
  // Industries cost a request, so one failing endpoint must not also cost the
  // exchange control (browseFilters drops every provider-supplied filter when
  // filterOptions throws).
  try { options.industry = await industries(ctx); }
  catch (e) { console.warn(`FMP: industry vocabulary unavailable (other filters unaffected): ${e.message}`); }
  return options;
}

async function industries({ apiKey, pace } = {}) {
  if (industryCache.options && Date.now() - industryCache.at < INDUSTRY_TTL)
    return industryCache.options;
  const rows = await fmp("available-industries", {}, apiKey, { pace });
  // Bare strings: browseFilters normalizes a string into {value,label} and
  // owns the ordering, so this only has to unwrap FMP's row shape. (The
  // endpoint answers [{ industry: "Software - Application" }, …]; older
  // shapes answered bare strings. Take either.)
  const options = (Array.isArray(rows) ? rows : [])
    .map((row) => (typeof row === "string" ? row : row?.industry))
    .filter(Boolean);
  industryCache = { at: Date.now(), options };
  return options;
}

export async function testConnection({ apiKey, pace } = {}) {
  const rows = await fmp("search-symbol", { query: "AAPL", limit: 1 }, apiKey, { pace });
  if (!Array.isArray(rows)) throw fail("unexpected search response");
  return true;
}

// Test seams only (house convention: provider-pacing's _resetBuckets). Aging
// lets a test cross the TTL/hard-bar thresholds without waiting them out.
export function _resetScreenerCache() {
  screenerCache = { at: 0, rows: null, bySymbol: null, sorted: new Map(), inflight: null };
  screenerDown = { until: 0, error: null };
  industryCache = { at: 0, options: null };
  bridgeCache.clear();
}
export function _ageScreenerCache(ms) {
  screenerCache.at -= ms;
}
