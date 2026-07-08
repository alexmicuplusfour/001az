// CoinMarketCap provider for the crypto connector — the keyed alternative to
// CoinGecko. Proves the domain/provider split: same canonical crypto fields,
// a different backend. Auth is the X-CMC_PRO_API_KEY header.
//
// CMC has no fuzzy-search endpoint like CoinGecko's /search. Instead it exposes
// /cryptocurrency/map (the full id<->symbol<->name listing), so search fetches
// that once (cached), then filters locally; fetchEntity does an exact quote
// lookup by id. Same provider contract, assembled differently.
const BASE = "https://pro-api.coinmarketcap.com";
const MAP_LIMIT = 5000;            // top-N by rank; covers anything searchable
const MAP_TTL = 6 * 60 * 60 * 1000; // the id/symbol map barely changes

export const label = "CoinMarketCap";
export const needsKey = true;
export const rpm = 30; // basic plan ~30/min; runtime paces + backs off on 429

// GET + parse, surfacing CMC's structured error (it returns error_message both
// on non-2xx and inline as status.error_code on a 200).
async function cmc(path, apiKey) {
  if (!apiKey) throw new Error("CoinMarketCap needs an API key");
  const r = await fetch(`${BASE}${path}`, {
    headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
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

async function coinMap(apiKey) {
  if (mapCache.list && Date.now() - mapCache.at < MAP_TTL) return mapCache.list;
  const body = await cmc(
    `/v1/cryptocurrency/map?listing_status=active&sort=cmc_rank&limit=${MAP_LIMIT}`,
    apiKey
  );
  mapCache = { at: Date.now(), list: body.data || [] };
  return mapCache.list;
}

// Up to 10 matching coins, ranked by match quality then market-cap rank.
export async function search(query, { apiKey } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const c of await coinMap(apiKey)) {
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
export async function fetchEntity(id, { apiKey } = {}) {
  const body = await cmc(`/v2/cryptocurrency/quotes/latest?id=${encodeURIComponent(id)}&convert=USD`, apiKey);
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

// Cheap authenticated ping for the admin Test button.
export async function testConnection({ apiKey } = {}) {
  await cmc(`/v1/key/info`, apiKey);
  return true;
}
