# Full-catalog connectors — no app-side ceiling on what a user can browse or add

**Status: IMPLEMENTED (2026-08-13). Supersedes the latency premise of
[connector-scale-plan.md](connector-scale-plan.md) (its architecture — snapshot
+ SWR + truthful pacing + fetchFields — stands; its cost model was stale within
ten days). The requirement, verbatim from the product owner: full access to
what the APIs have to offer — no limitation a user has to "put up with" that
the API itself doesn't impose.**

## What re-measurement said (2026-08-13, same key, live probes)

The 2026-08-03 plan was built on one load-bearing measurement: `company-screener`
costs a flat ~13–18 s. That number is DEAD — FMP evidently fixed their screener:

| Probe | Result |
|---|---|
| `company-screener` US NASDAQ+NYSE+AMEX, non-ETF, active, limit=5000 | **1.2 s cold, 0.3–0.5 s warm — 4,609 rows** |
| Same at limit=10000 | 4,609 rows — **that IS the whole US-listed equity universe** (NASDAQ 2834 + NYSE 1603 + AMEX 172, sub-counts sum exactly) |
| Ordering | market-cap desc, verified monotone over all 4,609 rows |
| Screener `page` param | **broken/overlapping** (page 0 and 1 share symbols, ordering jumps) — never paginate it; one deep `limit` is the way |
| `volume` in screener rows | **0 on 3,432 / 4,609 (74%)**; stable `quote` also zeroes volume outside sessions (AAPL volume=0 pre-open) |
| `search-symbol` GEVO (~$385M, below the old universe floor) | found; `quote` serves it |
| OTC quote (SAPX) | **works on this tier** |
| Non-US venue quote (SAP.DE) | **premium-gated** — US listings/ADRs are the tier's true boundary |
| Screener server-side filters (sector + mcap band) | work, 0.2 s |
| `available-sectors` | the standard 11-sector taxonomy |
| Batch quote endpoints | still 402 — change_1d stays a per-symbol quote |
| Catalog directory | `stock-list` 38,692 · `actively-trading-list` 26,204 · `etf-list` 6,299 · 63 exchanges |

## What was app-side limitation, and what replaced it

| Ceiling (before) | Now |
|---|---|
| `FMP_UNIVERSE_ROWS` default 2000, clamp ≤5000 — browse's whole world was the top-2000 by mcap; asc sort started at rank 2,000 / $1.27B | default **10000** (whole 4,609-row universe + growth headroom), clamp ≤25000 |
| Modal search = substring filter over that snapshot; **no path at all** to a symbol outside it (the real `search()` route was dead code since the browse modal replaced the search flyout) | `list({query})` = universe matches (free full columns) **+ search bridge**: `search()` hits outside the snapshot, each filled by one quote — OTC and ETFs included. Per-query cached (5 min) so paging doesn't re-buy it; a dead search endpoint degrades to universe-only and heals on retry |
| `search()` scope: NASDAQ/NYSE/AMEX only | + OTC (verified quotable). Non-USD/non-US venues stay out — that's FMP's tier gate, not ours |
| No filtering at all | manifest `browse.filters` (sector = FMP's 11, exchange) → modal dropdowns → route whitelists values → provider filters the snapshot. Declarative: connectors without filters render no controls |
| Volume column: rendered 0 down the page | 0 → null everywhere (screener, quote, fetchFields) — FMP's outside-session zeroing is "no reading", not a reading of zero. Same for `marketCap` 0 on unpriced fringe listings, nulled at universe fill so ascending market-cap starts at real micro-caps (verified live: $34.5k first, not a run of $0 rows) |
| Select-all + bulk add >100 → one 400, zero adds | client chunks by the server's `BULK_ADD_MAX` (100), flips rows per chunk, shows `Adding i–j of N…` |
| `INGEST_FEED_CAP` default 1000 < universe | window depth is **per-connector** (`browse.feedWindow`): stocks declares 5000 — snapshot-served, zero marginal HTTP, so a feed honestly says "all of it" — while metered catalogs (crypto) keep the 1000 default (≈4 paged requests per cold fill; a global raise would have 5×'d CoinGecko's window cost on a 30 rpm tier). `INGEST_FEED_CAP` env overrides all connectors at once; the preview reads the same bound via the adapter's `windowCap` |
| CMC search/browse-query world = top-5000 map | full active map (no limit param, ~10k, 6 h cache) |
| CoinGecko + CMC query paths ignored `page` → "Load more" appended the same rows forever | both slice hits by page; empty slice ends paging |

## Deliberately unchanged

- **Snapshot + SWR + single-flight + hard bar** — still the right data plane:
  refresh of price/mcap/volume/sector/industry/exchange is 0 HTTP warm; only
  change_1d pays a quote. Fast screener makes the SWR refill invisible instead
  of merely rare.
- **Bulk budget class (60 s)** — a hang detector is priced for the bad days;
  today's sub-second screener doesn't argue it down.
- **`BULK_ADD_MAX=100` per request** — the client chunks; the 300 s request
  window stays comfortable.
- **Browse = listed US equities** — ETFs/OTC arrive through search-by-intent
  rather than diluting the default ranked browse with 6k ETFs and OTC shells.
  (If an ETF browse tab is ever wanted: same screener minus `isEtf=false`,
  measured 10k+ rows for US listed all-types.)
- **mcapRank semantics** — now spans the WHOLE universe, so "top N" feed
  filters are exact, not top-N-of-a-truncation. The screener's mcap-desc
  default ordering no longer matters: nothing is truncated by it.

Also removed as dead: the standalone `/api/connectors/:name/search` route —
no client called it since the browse modal replaced the search flyout, and the
modal's query path now folds real catalog search in. Provider `search` remains
a contract method (the FMP bridge and plugin-health tracking consume it).

## Verification

- `test/stocks.test.js` — bridge merge/dedup/cache, filters, volume-null,
  default depth in the screener URL; suite green.
- `test/connectors.test.js` — CoinGecko + CMC query paging, CMC unlimited map.
- `scripts/verify-fmp-live.mjs` — extended: asc-sort shows true micro-caps,
  GEVO reachable via the bridge, sector filter clean. Run with `FMP_KEY` from
  the deployment DB.
