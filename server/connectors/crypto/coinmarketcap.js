// CoinMarketCap provider for the crypto connector — the keyed alternative to
// CoinGecko. Proves the domain/provider split: same canonical crypto fields,
// a different backend. Auth is the X-CMC_PRO_API_KEY header.
//
// CMC has no fuzzy-search endpoint like CoinGecko's /search. Instead it exposes
// /cryptocurrency/map (the full id<->symbol<->name listing), so search fetches
// that once (cached), then filters locally; fetchEntity does an exact quote
// lookup by id. Same provider contract, assembled differently.
import { providerSignal } from "../runtime.js";

const BASE = "https://pro-api.coinmarketcap.com";
const MAP_TTL = 6 * 60 * 60 * 1000; // the id/symbol map barely changes

export const label = "CoinMarketCap";
export const description = "Live crypto prices — needs a key";
export const needsKey = true;
// Truthful request pacing (pacesRequests — see runtime.callProvider): each
// raw request awaits the threaded pace(), so a map-cache-served search pays
// zero tokens and the query-path list() honestly pays for both requests.
export const pacesRequests = true;
export const rpm = 30; // basic plan ~30/min; runtime paces + backs off on 429

// GET + parse, surfacing CMC's structured error (it returns error_message both
// on non-2xx and inline as status.error_code on a 200).
async function cmc(path, apiKey, pace) {
  if (!apiKey) throw new Error("CoinMarketCap needs an API key");
  await pace?.();
  const r = await fetch(`${BASE}${path}`, {
    headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
    signal: providerSignal(),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body?.status?.error_code) {
    const e = new Error(`CoinMarketCap: ${body?.status?.error_message || `HTTP ${r.status}`}`);
    e.status = r.status;
    const ra = r.headers?.get?.("retry-after");
    if (ra != null) e.retryAfter = ra;
    throw e;
  }
  return body;
}

let mapCache = { at: 0, list: null };

async function coinMap(apiKey, pace) {
  if (mapCache.list && Date.now() - mapCache.at < MAP_TTL) return mapCache.list;
  // No limit param: the map is the whole active listing (~10k rows, one
  // request, cached 6 h). A top-N cap here silently made every coin past N
  // unsearchable and unaddable — the catalog's edge belongs to CMC, not us.
  const body = await cmc(
    `/v1/cryptocurrency/map?listing_status=active&sort=cmc_rank`,
    apiKey, pace
  );
  mapCache = { at: Date.now(), list: body.data || [] };
  return mapCache.list;
}

// Up to 10 matching coins, ranked by match quality then market-cap rank.
export async function search(query, { apiKey, pace } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const c of await coinMap(apiKey, pace)) {
    const sym = (c.symbol || "").toLowerCase();
    const name = (c.name || "").toLowerCase();
    let score;
    if (sym === q) score = 0;
    else if (name === q) score = 1;
    else if (sym.startsWith(q)) score = 2;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 4;
    else continue;
    scored.push({ score, rank: c.rank || 1e9, c });
  }
  scored.sort((a, b) => a.score - b.score || a.rank - b.rank);
  return scored.slice(0, 10).map(({ c }) => ({
    id: String(c.id),
    label: c.name,
    symbol: (c.symbol || "").toUpperCase(),
    rank: c.rank || null,
  }));
}

// One coin's canonical crypto fields via the v2 quotes endpoint (data keyed
// by id). Returns { v, kind }; the connector adds identity + `src`.
export async function fetchEntity(id, { apiKey, pace } = {}) {
  const body = await cmc(`/v2/cryptocurrency/quotes/latest?id=${encodeURIComponent(id)}&convert=USD`, apiKey, pace);
  const d = body.data?.[id];
  if (!d) throw new Error(`CoinMarketCap: no data for id ${id}`);
  const usd = d.quote?.USD || {};
  return {
    id: String(d.id),
    symbol: (d.symbol || "").toUpperCase(),
    display_name: d.name,
    fields: {
      price:      { v: usd.price ?? null,              kind: "number" },
      market_cap: { v: usd.market_cap ?? null,         kind: "number" },
      change_24h: { v: usd.percent_change_24h ?? null, kind: "number" },
      url:        { v: d.slug ? `https://coinmarketcap.com/currencies/${d.slug}/` : null, kind: "url" },
    },
  };
}

// Browse-and-add (the ingestion modal): the same canonical columns as CoinGecko,
// assembled from CMC's endpoints. A plain browse uses /listings/latest (sorted +
// paginated server-side, all four domain sorts native). A text query filters the
// cached id/symbol map locally, then /quotes/latest fills the columns for those
// ids — same row shape either way. Row = { id, symbol, label, values }.
const SORT_FIELD = { market_cap: "market_cap", volume: "volume_24h", price: "price", name: "name" };

function quoteRow(d) {
  const usd = d.quote?.USD || {};
  return {
    id: String(d.id),
    symbol: (d.symbol || "").toUpperCase(),
    label: d.name,
    values: {
      rank:       d.cmc_rank ?? null,
      name:       d.name,
      price:      usd.price ?? null,
      change_24h: usd.percent_change_24h ?? null,
      market_cap: usd.market_cap ?? null,
      volume:     usd.volume_24h ?? null,
    },
  };
}

export async function list({ sort, order, page = 1, pageSize = 50, query } = {}, { apiKey, pace } = {}) {
  const dir = order === "asc" ? "asc" : "desc";

  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    // Page the hit list — the modal appends pages, so a fixed first-slice
    // here would render the same rows again on every "Load more".
    const pageNo = Math.max(1, Number(page) || 1);
    const ids = (await coinMap(apiKey, pace))
      .filter((c) => (c.symbol || "").toLowerCase().includes(q) || (c.name || "").toLowerCase().includes(q))
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))
      .slice((pageNo - 1) * pageSize, pageNo * pageSize)
      .map((c) => c.id);
    if (!ids.length) return [];
    const body = await cmc(`/v2/cryptocurrency/quotes/latest?id=${ids.join(",")}&convert=USD`, apiKey, pace);
    return ids.map((id) => body.data?.[id]).filter(Boolean).map(quoteRow);
  }

  const field = SORT_FIELD[sort] || SORT_FIELD.market_cap;
  const start = (page - 1) * pageSize + 1;
  const body = await cmc(
    `/v1/cryptocurrency/listings/latest?start=${start}&limit=${pageSize}&sort=${field}&sort_dir=${dir}&convert=USD`,
    apiKey, pace
  );
  return (body.data || []).map(quoteRow);
}

// Cheap authenticated ping for the admin Test button.
export async function testConnection({ apiKey, pace } = {}) {
  await cmc(`/v1/key/info`, apiKey, pace);
  return true;
}
