# Connector & FMP at scale — solid for 1000+ stock boards

**Status: IMPLEMENTED + LIVE-VERIFIED (2026-08-03). Full suite green (638);
live against real FMP: cold fill 18.6 s / 1 request @ depth 2000, warm slices
and universe-served fetchFields 0 HTTP, change_1d exactly 1 quote
(scripts/verify-fmp-live.mjs re-runs the check). Deploy = rebuild the app
container. Supersedes the narrower connector-call-budgets plan (deleted; its
research is folded in).
The requirement: a stocks board holding 1000+ entities where EVERYTHING the
feature set allows actually works — browse, search, single/bulk add, feeds up
to the cap, live field refresh at every offered cadence (1 min – 1 day), chart
faces, alerts — against FMP's real latency, rate limits, and tier gates, all
measured below. Self-contained for a fresh session.**

## What the measurements say (2026-08-03, this deployment's key)

The presenting bug: ingest preview / "Run now" / cold browse all die with
"The operation was aborted due to timeout" — FMP's `company-screener` takes a
flat **~13–18 s** and the one connector-wide HTTP budget is 15 s
([runtime.js:58](../server/connectors/runtime.js#L58)). Because the fetch
never completes, the 5-min screener cache never warms: permanent, not
transient. But the timeout is only the first wall; the probes below drew the
whole map.

| Probe | Result |
|---|---|
| `company-screener` limit=1000 (the code's call), ×3 | 17.2 / 17.6 / 17.9 s |
| `company-screener` limit=250 paged / limit=10 / narrow filters | 16.9–17.5 s each — **flat latency, invariant to size/filters/page** |
| `company-screener` no filters, limit=100 | 14.4 s — straddles the 15 s budget → flaky-by-weather |
| **`company-screener` limit=3000, one call** | **12.9 s, 3000 rows (~1.3 MB)** — depth is FREE; same flat cost |
| `company-screener` page=1&limit=1000 | 12.9 s, rows 1000–2000 — pagination works but each page costs the flat ~17 s |
| `quote?symbol=AAPL` / `search-symbol` | 0.4 s / 0.5 s — interactive class is genuinely fast |
| `quote?symbol=AAPL,MSFT,NVDA` | **HTTP 200, `[]`** — stable quote is single-symbol only and fails SILENTLY on comma lists. Never try to batch it. |
| `batch-quote`, `batch-quote-short`, `batch-exchange-quote` | **402** — all batch quote endpoints are premium-gated on this tier |
| legacy `/api/v3/stock-screener` | **403** — stable-only key; no legacy fallback |

Screener row schema (verified): `symbol, companyName, marketCap, sector,
industry, beta, price, lastAnnualDividend, volume, exchange,
exchangeShortName, country, isEtf, isFund, isActivelyTrading`.
Stable `quote` schema: has `changePercentage` but **no `pe`** (pe_ratio
already really comes from `ratios-ttm`, cached 6 h —
[financialmodelingprep.js:148](../server/connectors/stocks/financialmodelingprep.js#L148)).

**The three structural conclusions:**

1. **On this tier, the screener IS the batch endpoint.** One flat ~15 s call
   returns the whole universe (any depth to ≥3000) carrying
   `price / market_cap / volume / sector / industry / exchange` for every
   symbol. Per-symbol quotes are only genuinely needed for `change_1d` (and
   6-h-cached ratios for `pe_ratio` / `dividend_yield`).
2. **The 15 s budget is right for everything except that one call class.**
   Quotes/search answer in half a second; the screener needs its own budget.
3. **The token bucket meters the wrong thing for scale.** It paces LOGICAL
   calls: a cache-served `list()` slice pays a token for zero HTTP (the feed's
   window fill wastes ~8 s doing nothing), while `fetchEntity` pays one token
   for three HTTP requests (why FMP's rpm sits at 60, a third of the 300/min
   ceiling). At 1000 entities both distortions dominate: a refresh cycle that
   needs zero HTTP would still queue 1000 tokens ≈ 17 minutes.

## Architecture — four pillars

### 1. Call-class budgets (generic)

`providerBudgetMs(kind)` / `providerSignal(kind)` in
[runtime.js](../server/connectors/runtime.js): default (interactive) stays
`CONNECTOR_TIMEOUT_MS || 15000`; `"bulk"` reads
`CONNECTOR_BULK_TIMEOUT_MS || 60000`. The PROVIDER picks the class per call
site (only it knows which HTTP call is a catalog compute; logical entry
points don't map 1:1 to requests); the runtime owns the values. A timeout is
a hang detector — the bulk ceiling binds only on true hangs, not on the ~15 s
screener. `callProvider` rewraps a raw `TimeoutError` as
`` `${name}: request timed out` `` (status-less → `withRetry` never retries
it), so the bare DOMException text can never reach a toast/job-log/health row
again; FMP's own wrapper names the endpoint too.

### 2. Truthful pacing — tokens meter HTTP requests (generic)

The runtime threads a pacing handle into every provider call:
`provider.method(args, { apiKey, pace })` where `pace = () => acquire(name,
rpm, burst)` (same merged rpm/burst as today, Plugins-page overrides
included). A provider that declares `export const pacesRequests = true`
awaits `pace?.()` before EACH fetch, and `callProvider` stops pre-acquiring
its logical token. Providers without the flag (dynamic plugins) keep the old
one-token-per-logical-call behavior — the contract change is purely additive
(`{ apiKey }` grows a key; existing destructuring ignores it, and `pace?.()`
tolerates direct un-paced calls in tests).

Consequences, all load-bearing at N=1000:
- Cache-served calls cost zero tokens → warm `list()` slices are instant; the
  feed window fill drops ~8 s of dead pacing wait.
- `fetchEntity`'s quote+profile+ratios fan-out pays 3 tokens truthfully → FMP
  rpm can rise from 60 to **240** (burst 20), honest against the 300/min
  ceiling with headroom. Cold bulk adds run ~4× faster.
- Retries pay per attempt (they didn't before) — truthful under 429 storms.
- The single-flight universe fetch pays exactly one token for one request no
  matter how many callers share it.

### 3. The universe snapshot as the data plane (FMP)

`stockUniverse` becomes the provider's one bulk fact, fetched and cached with
discipline:

- **Depth knob**: `FMP_UNIVERSE_ROWS` (default **2000**, clamped 100–5000) —
  one screener call regardless of depth (measured: 3000 rows in 12.9 s).
  Market-cap rank spans the whole fetched universe, so "top 1500 by mcap" is
  expressible. ~430 KB/1000 rows in memory — trivial.
- **Bulk budget + endpoint-named timeout**: the screener fetch uses the
  `"bulk"` signal; on timeout the error reads `Financial Modeling Prep:
  company-screener timed out after 60s`, not DOMException prose.
- **Single-flight**: concurrent cold callers (preview + sweep + browse modal
  race on a cold board) share one in-flight fetch — one request, one token,
  one failure wave.
- **Stale-while-revalidate**: past `BROWSE_TTL` (5 min) serve the stale
  universe immediately and refresh in the background (same single-flight; on
  failure keep stale + warn — the next foreground miss puts it on the health
  row). Past a hard bar (`SCREENER_MAX_AGE`, 60 min) block on a fresh fetch so
  data can't go silently ancient. Net effect: the ~15 s is paid once per
  process, then at most ~hourly, and never by an interactive caller.
- **Symbol-keyed row map** built at fill time — O(1) lookups for the refresh
  path below.
- **`list()` page clamp 100 → 250**: it slices this LOCAL array; the old
  clamp only inflated the feed's window fill from 4 logical calls to 10.
  Aligns with the adapter's `ENUM_PAGE`
  ([connector.js:28](../server/ingestion/connector.js#L28)); the browse modal
  is clamped upstream anyway (`BROWSE_PAGE_MAX=100`,
  [server.js:2520](../server/server.js#L2520)).

### 4. Field-aware refresh (generic contract, FMP implementation)

The refresh sweep is per-entity whole-object today: 1000 live stocks = 1000
`fetchEntity` = up to 3000 HTTP per cycle. But which fields are due is KNOWN
(the mapping's live config), and most stock fields live in the universe
snapshot. New optional provider capability:

    fetchFields(id, keys, { apiKey, pace }) → { fields: { key: { v, kind } } }

`runtime.refresh` calls it with the due keys when the provider exports it,
stamps `src`/`at` exactly like `fetchEntity` (at = now, the last-CHECKED
doctrine — [runtime.js:182](../server/connectors/runtime.js#L182)), and
**falls back to whole `fetchEntity` if any due key is missing from the
result** — so a partial answer can never strand a field due-forever, and
providers without the capability are untouched.

FMP's implementation routes each requested key to its cheapest source:

| Due keys | Source | HTTP cost (warm) |
|---|---|---|
| price, market_cap, volume, sector, industry, exchange | universe row (SWR) | **0** |
| change_1d | `quote` per symbol | 1 |
| pe_ratio, dividend_yield | `ratios-ttm` (6 h cache) | ~1 per 6 h |
| website, currency | `profile` (6 h cache) | ~1 per 6 h |
| symbol absent from universe | quote overlay, else runtime falls back | 1–3 |

When a quote is fetched anyway (change_1d due), its fresher
price/market_cap/volume overlay the universe values — never serve older data
than what the call already bought. Universe-served values move at snapshot
granularity (≤ ~5 min under steady polling); `at` honestly records the check
time, matching the existing "last-checked, not last-changed" semantics. A
1-minute cadence on universe-served fields is cheap to honor (zero HTTP per
cycle); its DATA granularity is the TTL — documented, not pretended away.

### The scale math this buys (rpm 240, defaults)

| Operation at N=1000 | Before | After |
|---|---|---|
| Preview / browse, cold | timeout, permanent | one ~15 s fill, then instant (SWR) |
| Feed admitting 1000 | works but ~50+ min, window fill wastes 8 s/tick | ~15–20 min (25/tick × 3 paced HTTP ≈ 19 s/tick), window fill token-free |
| Refresh {price, mcap, volume} @ any cadence | 1000 logical calls ≈ 17 min/cycle | **~0 HTTP/cycle** (snapshot-served) |
| Refresh + change_1d @ 5 min | impossible (17 min floor) | 1000 quotes ≈ 4.2 min/cycle — sustainable; @1 min degrades gracefully to ~4–5 min effective |
| pe/dividend live | 17 min/cycle | amortized ≤ N per 6 h |
| Chart faces @ daily | ~17 min/day | ~4 min/day |
| Bulk add 100 (route cap `BULK_ADD_MAX`) | ~100 s+ | ~75 s (300 paced HTTP) — inside Node's 300 s request window |

Degradation stays graceful by construction: overdue entities refresh at
capacity and re-schedule from `at + every` — a too-tight cadence yields a
slower effective cadence, never a backlog explosion (the sweep's
bounded-batch + backoff discipline, [worker.js:1434](../server/worker.js#L1434)).

## Caps chain — one honest limit

The feed window cap lives twice today (`ENUM_CAP` in
[connector.js:22](../server/ingestion/connector.js#L22), `PREVIEW_CAP` in
[server.js:1006](../server/server.js#L1006)) held equal by a comment. Unify:
`ENUM_CAP` reads `INGEST_FEED_CAP || 1000` and is exported; the preview route
imports it. For a 1500-stock feed the pairing is `INGEST_FEED_CAP=1500` +
`FMP_UNIVERSE_ROWS≥1500` — documented side by side in .env.example.
`MAX_PAGES=40` still backstops (5000/250 = 20 pages).

## What deliberately does NOT change

- **Drain machinery** (`INGEST_RUN_CAP=25`/tick, `drain_left`) — already
  correct for 1000-item runs; only its per-tick cost shrinks.
- **`BULK_ADD_MAX=100`** — with truthful pacing the worst request is ~75 s,
  inside every timeout in the chain; the 1000-stock path is the feed, by
  design.
- **`REFRESH_BATCH=20` + 60 s backoff** — bounded-batch discipline stays; the
  batches just stop paying for phantom HTTP.
- **Engine, ledger, preview sample paging, window cache** — adapter-blind and
  size-indifferent at these Ns.
- **Merge/`at` semantics** in `runtime.refresh` — fetchFields slots in above
  the merge, which stays byte-identical.
- **Snapshot volume note**: `retag_on_refresh` boards write a movement row
  per changed field; 1000 live-priced entities generate real volume — existing
  `SNAPSHOT_RETENTION_DAYS=90` prune covers it; not this plan's problem.

## Rejected

- **Screener pagination for the universe** — measured anti-fix (flat cost per
  page); depth via one big `limit` instead.
- **Batching quotes** — every batch quote endpoint is 402 on this tier, and
  comma-list `quote` silently returns `[]` (the worst failure mode: quiet).
  If the key is ever upgraded, `fetchFields` is the seam a `batch-quote`
  implementation drops into — the runtime contract already fits.
- **Raising the interactive 15 s globally** — the tick-wedge rationale stands;
  only the bulk class earns a longer leash.
- **Worker-side batch refresh orchestration** (collect due symbols → one
  provider batch call): unnecessary once the snapshot serves the bulk fields
  and quotes are the only per-symbol cost; revisit only with a batch-capable
  tier.

## Implementation slices

1. **Runtime** ([runtime.js](../server/connectors/runtime.js)):
   `providerBudgetMs`/`providerSignal(kind)`; `pace` threading + 
   `pacesRequests` gate in `callProvider`; TimeoutError rewrap; `refresh()`
   fetchFields path with full-coverage fallback.
2. **FMP** ([financialmodelingprep.js](../server/connectors/stocks/financialmodelingprep.js)):
   `pacesRequests` + `pace?.()` before every fetch; rpm 240 / burst 20 with
   the honest-metering rationale; universe depth knob + single-flight + SWR +
   hard bar + symbol map; bulk signal + endpoint-named timeout; `fetchFields`;
   list clamp 250; `_resetScreenerCache()` / `_ageScreenerCache(ms)` seams
   (house convention: `_resetBuckets`).
3. **CoinGecko / CMC**: `pacesRequests` + `pace?.()` per fetch (logical ≈ HTTP
   for them today; the flag just keeps the ledger truthful — CMC's map-cached
   search drops to zero tokens warm, its query-list pays 2 honestly).
4. **Caps + knobs**: `ENUM_CAP` env + export, preview imports it;
   .env.example (document `CONNECTOR_TIMEOUT_MS` — missing today — plus
   `CONNECTOR_BULK_TIMEOUT_MS`, `FMP_UNIVERSE_ROWS`, `INGEST_FEED_CAP`);
   docker-compose passthroughs beside line 97.
5. **Tests** (`globalThis.fetch` stubbing as throughout):
   - runtime: budget classes read env per call; TimeoutError rewrap (message,
     no status, 429 still retries); refresh uses fetchFields for due keys,
     falls back whole-object when a due key is missing.
   - FMP pace-truthfulness (spy `pace`): search=2, fetchEntity cold=3 warm=1,
     list cold=1 warm=0, history=1.
   - Universe: single-flight (2 concurrent cold `list()` → 1 request); SWR
     (aged past TTL → old rows served now, exactly one background refresh);
     hard bar blocks; `FMP_UNIVERSE_ROWS` honored in the URL; clamp 250;
     timeout message names company-screener.
   - fetchFields routing per the table (universe keys → 0 fetches; change_1d
     → quote; pe/dividend → ratios; unknown symbol → quote overlay).
   - Existing suites stay green — notably the stocks list test that RELIES on
     intra-test cache persistence ([stocks.test.js:135](../test/stocks.test.js#L135)):
     new tests reset the cache at their own start, never mid-test.
6. **Live verification** (node script against real FMP, key from the running
   DB, nothing board-mutating): cold `list()` fills at the configured depth
   under the bulk budget in ~13–18 s; warm `list()` instant with zero
   requests; `fetchFields(["AAPL"], ["price"])` zero-HTTP warm;
   `fetchFields(..., ["change_1d"])` exactly one quote.

## Acceptance

- [ ] Stocks preview/Run-now/browse: cold ≈ one screener fill, warm instant;
      no timeout toast; job log `ok`.
- [ ] A 1000+ stock feed drains to completion through the existing
      `drain_left` machinery.
- [ ] Refresh cycle for universe-served live fields costs zero marginal HTTP
      (verified by pace/fetch counts in tests); change_1d cycles at ~4 min per
      1000 under rpm 240.
- [ ] A truly hung call still dies: 15 s interactive / 60 s bulk, message
      naming provider (+ endpoint for FMP).
- [ ] Crypto providers behave identically (their pace counts match their HTTP
      counts today); plugin providers without `pacesRequests` keep legacy
      pacing.
- [ ] `node --test` fully green.
