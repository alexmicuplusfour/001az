# Full-catalog connectors — no app-side ceiling on what a user can browse or add

**Status: IMPLEMENTED (2026-08-13; second pass same day — see below, which
takes the same ceiling off the crypto side). Supersedes the latency premise of
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
| `INGEST_FEED_CAP` default 1000 < universe | window depth became **per-connector** (`browse.feedWindow`): stocks 5000, metered catalogs 1000. **Superseded in the third pass below — both were still app-side rations, and the 5000 was the one the product owner caught.** |
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
- ~~**Browse = listed US equities** — ETFs/OTC arrive through search-by-intent
  rather than diluting the default ranked browse.~~ **Reversed in the third
  pass.** "Dilution" was the app deciding what a user may browse, and
  search-by-intent is no substitute: a FEED can't search, so ETFs and ADRs
  were unreachable by the boards that enumerate. See below.
- **mcapRank semantics** — now spans the WHOLE universe, so "top N" feed
  filters are exact, not top-N-of-a-truncation. The screener's mcap-desc
  default ordering no longer matters: nothing is truncated by it.

Also removed as dead: the standalone `/api/connectors/:name/search` route —
no client called it since the browse modal replaced the search flyout, and the
modal's query path now folds real catalog search in. Provider `search` remains
a contract method (the FMP bridge and plugin-health tracking consume it).

## Second pass (2026-08-13) — the crypto half, priced the same way

The first pass took the ceiling off *stocks* (one snapshot serves any depth)
and left crypto as it was. Re-reading both vendors' current docs said the
crypto side was still rationing in three places the APIs don't.

| Ceiling (after pass 1) | Now |
|---|---|
| **Refresh cost was per-coin.** CoinGecko's `fetchEntity` bought `/coins/{id}` (the ~50× heavier detail payload) per entity, per cadence; CMC bought one `quotes/latest` per entity. A 100-coin board's refresh = 100 metered calls, against monthly budgets of 10k credits (CG demo) / 15k (CMC Basic) — the real meter, which nothing modelled | Both providers keep a 60 s market-row cache (the vendors' own cache cadence — polling faster buys nothing) and export `prefetch(ids)`. The worker warms the whole due batch **before** the per-entity loop: one request per provider per sweep, 250 ids for CG / 100 for CMC. A 100-coin board's cycle: **100 calls → 1**. `fetchFields` then serves every key from that row, and the browse/query paths warm the same cache, so bulk-adding straight out of the modal re-buys nothing |
| **4 canonical fields** (price, mcap, 24h change, url) while the same row already carried the rest | 11: multi-window change (1h/24h/7d/30d), volume, rank, ATH, circulating supply. `price_change_percentage=1h,24h,7d,30d` is one param on a request the board already pays for — zero marginal cost. `ath` is CoinGecko-only (CMC's quote has none) and serves an honest null there. The 7d column joins browse, and every column is a feed filter, so "7d change > 20%" is now expressible |
| **CMC boards had no chart face** — the provider had no `history()`, so every card fell back to the tile | CMC's Basic tier serves historical quotes as of 2026 (intraday 1 month, daily 1 year). `history()` implemented per-period so point count stays proportionate. The `requires` face gate now bites only for plugin providers |
| **Crypto browse had no filters at all** while CoinGecko exposes **857 categories** server-side | `browse.filters` gains `from: "provider"`: the manifest declares the filter, the active backend supplies the vocabulary (`filterOptions()`, cached 24 h), and `runtime.browseFilters` is the ONE resolver both the filters route and the browse route's whitelist read. Crypto gets Category; stocks gains Industry (~150 values, from FMP's `available-industries` — too many to freeze). A provider that can't supply one renders no control, same rule as the face gate. Verified live: `category` **intersects** with `ids`, so a filtered search stays a real search |
| **Keyless CoinGecko paced as if keyed** (25 rpm against a 5–15/min shared-IP pool) — and CG counts *failed* requests against the limit, so overpacing burnt quota to learn nothing | `keylessRpm` (10) applies when no key is stored; a stored demo key unlocks 50 (half the documented 100/min — it was 30 until recently). Plugins-page override still beats both |
| **A gated FMP screener killed browse entirely** — the free tier doesn't include `company-screener` at all | A *query* degrades to bridge-only (search + quote ARE free-tier), so search still works; a plain browse still surfaces the real error. The failed fill is negative-cached 60 s — the free tier's budget is 250 requests **a day**, so retrying a known answer per keystroke is quota spent on nothing |
| A cached bridge row could double after a universe refill (the two 5-min TTLs don't tick together) | Bridge rows dedupe against the universe **served this call**, not the one the bridge saw at fill time |
| CG's query path re-emitted rows in the endpoint's market-cap order, so search relevance was lost and paging wobbled | Re-emitted in hit order, matching the CMC path |

Also: providers declare `attribution` (CoinGecko's demo ToS **requires** visible
credit; FMP asks for it), rendered in the browse modal's footer for whichever
provider filled the rows.

## Third pass (2026-08-13) — the feed window was still a ration

Caught by the product owner looking at a preview: *"i don't want any limit? why
are stocks capped at 5k?"* Correct. Passes 1 and 2 moved the number (2000 →
5000, per-connector instead of global) without questioning that there was one.

**The argument against it was already written down in this repo** — by the file
adapter, which refuses a reach cap for a reason that applies verbatim to
connectors:

> A capped window would "clog": once the first N files are ingested they still
> fill the window (the ledger dedups DOWNSTREAM, not during the walk), so files
> added afterwards would never be seen — breaking the whole point of watching a
> growing source.

So a `feedWindow: 5000` on a 6,000-row universe doesn't mean "5,000 is plenty",
it means **the 5,001st row can never be admitted, ever** — and once the first
5,000 are on the board, the feed is dead while looking healthy. That's a latent
bug, not just a limitation.

| Ration (before) | Now |
|---|---|
| `browse.feedWindow` 5000 (stocks) / 1000 default (crypto) | **Neither.** A feed walks to the catalog's end. `SAFETY_CAP` (100,000) is an out-of-memory backstop — same role and same number the file adapter uses — not a product ceiling |
| `MAX_PAGES = 40` — a *second*, quieter ceiling at 40 × 250 = 10,000 rows, which would have silently bound every "uncapped" feed | Derived: `ceil(SAFETY_CAP / ENUM_PAGE)`. A page budget smaller than the row budget can't become the real limit by accident |
| `ingest.limit` validated 1–5000, so "top 5000" was the largest expressible run | 1–100,000 (the safety backstop; past it a limit couldn't be honored anyway). `null` = "all", still the default |
| Preview's capped note hardcoded **"Showing the first 1000 scanned"** — untrue for stocks since the day feedWindow landed | The server ships `scanned` (the depth actually reached); the client states that number |
| `INGEST_FEED_CAP` = an override on the app's ration | The *only* ration, and it's the operator's. Unset = no limit |

Cost, stated rather than decided: stocks is free at any depth (one cached
screener call serves every slice). A full CoinGecko pass is ~74 metered
requests — real money against a 10k/month budget, which is why the env knob
exists, and why it's the operator's call rather than a default.

### …and the universe itself was the bigger one

Removing the window exposed that ~4.6k wasn't the universe's size — it was the
size of the *question we were asking*. The screener call carried four narrowing
params and only one of them was a tier gate:

| Param | Removed | Why it was wrong |
|---|---|---|
| `country=US` | ✅ | Filtered company **domicile**, not listing venue — so every ADR (BABA, TSM, ASML, NVO) vanished, though they trade on NYSE/NASDAQ and quote fine on this tier. Never justified anywhere; it just read like it belonged next to the exchange filter |
| `isEtf=false` | ✅ | ~6.3k ETFs — SPY, QQQ, VOO — excluded by a product opinion about "diluting browse" |
| `isFund=false` | ✅ | Closed-end funds, same |
| `exchange=NASDAQ,NYSE,AMEX` | **kept**, now `FMP_EXCHANGES` | A real boundary: non-US venue quotes are premium-gated (SAP.DE → 402), so listing them would only produce rows that fail on add. OTC *is* quotable, so widening is a knob, not a code change — it costs bandwidth, which the operator's plan meters |

What replaced the exclusions: a `type` column and filter (Stock / ETF / Fund)
off the screener's own `isEtf`/`isFund` flags. The user narrows; the manifest
doesn't narrow for them. The type column also stops an ETF's blank Sector from
reading as missing data when it's simply not a thing an ETF has.

`FMP_UNIVERSE_ROWS` default 10000 → **30000** (clamp 100000): the old default
was sized to a 4,609-row answer and would have silently truncated the real one.

### …and then FMP's own 10k response cap

With the exclusions gone the preview read exactly **10000**, which is not a
number a real catalog ends on. `limit=30000` came back with 10,000 rows and the
response genuinely ended there — **FMP caps a screener response at 10,000
however large a `limit` you send** (their 2025-04-09 changelog calls it
"request limit capping"). Paging isn't the escape either: the `page` param
returns overlapping pages, measured at the top of this document.

A cap on one *response* is not a cap on the *catalog*, though — so the universe
is now assembled from **disjoint slices and unioned**:

- **One request per venue.** A listing has exactly one exchange, so venue
  partitions cleanly and completely. Default three requests per fill, still
  single-flighted, still SWR-cached, still zero marginal HTTP per browse slice.
- **A venue at the cap re-splits by listing type** — ETF / fund / neither,
  which is again disjoint and complete. Only the saturated venue pays.
- **Saturation past that is logged, not swallowed**: if a sub-slice is still at
  10,000 the provider warns that listings are out of reach, rather than serving
  a quietly truncated universe.
- Symbols are deduped on merge, so a listing FMP reports under two venues
  can't become two rows with two market-cap ranks.

The ceiling is now the API's shape rather than a number the app accepted.
`scripts/verify-fmp-live.mjs` reports the real universe size, its
Stock/ETF/Fund composition, and flags a count that's a multiple of 10,000 as
probably-still-truncated.

The search bridge still matters — it reaches symbols outside the venue list —
but it is no longer load-bearing for whole asset classes.

### Fourth pass — reviewing the third

Fresh-eyes read of the work above, which found four things:

- **A saturated venue threw away the rows it had just bought.** The type
  re-split returned only its sub-slices, so a sub-slice that FMP refused took
  the venue's 10,000 valid listings down with it (`Promise.all`), and a param
  FMP chose not to honour would have silently *lost* rows. The split is now
  additive — the capped response is unioned with the slices, `allSettled` so
  one refusal costs only itself — which makes it strictly more coverage than
  not splitting, never less.
- **The `type` filter guessed.** A bridge row carries no `isEtf`/`isFund`
  flags, so `typeOf` read it as "Stock" — meaning SPY reached by search
  displayed "—" and still passed a `type=Stock` filter. It now reads the same
  value the row renders, so a type filter excludes bridge rows honestly, the
  rule the sector filter already followed.
- **The feed window had no single-flight.** The cache only helps callers
  arriving *after* a walk; a preview click landing mid-sweep started a second
  full walk. That was 4 duplicated requests under the old ration and is ~74
  now — the removal of the cap is exactly what made it worth fixing. Same
  mechanism the FMP screener already used.
- **Two comments had gone stale**: the window-cache note still priced a fill at
  "≈4 CoinGecko fetches", and the FMP `attribution` asserted a ToS clause that
  can't be verified (their site refuses automated fetches; what is readable
  suggests displaying their data may need a data-display agreement, which is a
  bigger question than a credit line and the operator's to settle).

### What now binds, and it isn't the app

Batching moved the crypto meter off entity count and onto **cadence**, which is
the honest place for it — a board's cost is now what the user asked to be told,
not how many coins they added:

| Cadence | Requests/month (any board size) | vs CoinGecko demo 10k credits/mo | vs CMC Basic 15k/mo |
|---|---|---|---|
| 1 min | ~43,200 | 4.3× over | 2.9× over |
| 5 min | ~8,640 | fits | fits |
| 15 min | ~2,880 | comfortable | comfortable |
| 1 hour | ~720 | trivial | trivial |

Deliberately **not** capped: a paid tier makes 1-minute fine, and the app has no
business overruling an operator about their own plan. The knob that matters is
the mapping modal's per-field cadence, and the caches make the whole board ride
one request either way. (Before this pass the same table would have read
"× the number of coins on the board" — which is what made it a ceiling.)

## Verification

- `test/stocks.test.js` — bridge merge/dedup/cache, filters, volume-null,
  default depth in the screener URL, bridge-vs-refill dedupe, gated-screener
  degradation, provider-supplied industry vocabulary.
- `test/crypto-quotes.test.js` — the batched quote plane: prefetch chunking
  (250 CG / 100 CMC), zero-HTTP `fetchFields`, browse paths warming the cache,
  category composition, CMC history shapes.
- `test/connectors.test.js` — `browseFilters` resolution + degradation, the
  filters route and its whitelist, `prefetchRefresh` grouping, keyless tiering,
  CoinGecko + CMC query paging.
- `scripts/verify-fmp-live.mjs` — asc-sort shows true micro-caps, GEVO
  reachable via the bridge, sector filter clean. Run with `FMP_KEY`.
- `scripts/verify-coingecko-live.mjs` — **run 2026-08-13, keyless, 7 requests
  total**: 857 categories; multi-window change present on browse rows;
  `category=meme-token` narrows server-side; category+query returns the
  intersection (bitcoin correctly excluded); prefetch of 3 ids = 1 request;
  `fetchFields` off the warm cache = **0 requests**; 30d history = 721 points.
