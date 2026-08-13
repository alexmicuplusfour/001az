# The drain re-walk: a metered feed reads the whole catalog once per tick

**Status: OPEN, not urgent, worth doing properly.** Found during the cleanup
pass over [connector-full-catalog.md](connector-full-catalog.md) (2026-08-13).
Affects METERED catalogs only — crypto. Stocks is structurally immune, and the
reason why is the whole story.

## The behaviour

A feed run is not one pass. The worker admits at most `INGEST_RUN_CAP` (25)
items per tick, stores the remainder in `drain_left`, and schedules the next
tick for *now* — so a 5,000-coin board is ~200 back-to-back ticks:

- `server/worker.js:1765` — every tick begins with `adapter.enumerate(...)`
- `server/worker.js:1773` — `batch = picked.slice(0, INGEST_RUN_CAP)`
- `server/worker.js:1800` — `remaining > 0 ? Date.now() : …` (immediate re-run)

`enumerate` walks the entire catalog. For CoinGecko that is ~74 metered
requests (~18,400 coins, `per_page` maxes at 250). There is a window cache in
front of it, but its TTL is a 60-second **clock**, while the walk's duration is
set by the **rate limiter** — ~7 minutes at the keyless 10 rpm. The cache is
therefore reliably expired by the next tick, and the walk repeats.

Cost shape: **~74 requests of setup per 25 items admitted, i.e. ~3 metered
requests per coin ingested**, against a 10,000-credit *monthly* budget.

## Why stocks doesn't have this

Not because the stocks code is better — because FMP's API is a different shape.

| | Bulk endpoint? | Full catalog costs |
|---|---|---|
| **FMP** (stocks) | `company-screener` returns the whole universe with market data, ≤10k rows per response | **3 requests** (one per venue), cached, then every page free |
| **CoinGecko** | none — `/coins/markets` caps at 250 rows/page. `/coins/list` returns all ~18.4k coins but carries **no market data**, so it can't back a table sorted by market cap | **~74 requests** |
| **CoinMarketCap** | `listings/latest` takes `limit` up to 5000 | **~2 requests** for its ~8k ranked coins |

So the snapshot pattern that makes stocks free is *available* to FMP and mostly
available to CMC, and genuinely unavailable on CoinGecko. The feed adapter's
design — "enumerate everything, then filter and limit downstream" — quietly
assumes the FMP shape, where enumerating everything is one cached call.

Crypto predates that assumption: it was built as pass-through paging, which is
the right trade for a human clicking browse pages (one request per page you
actually look at) and the wrong one for a feed that wants the whole catalog.

**Removing the feed-window ration is what surfaced this.** While the window was
rationed to 1,000 rows the walk was 4 requests and nobody noticed; at full
catalog depth it is 74.

## Already mitigated (do not re-fix)

The cleanup pass made every path that buys market rows warm the shared quote
cache, so **browse-then-bulk-add is now free** — that was 100 requests for a
100-row add and is 0. It does *not* rescue the drain: the walk takes minutes
while a warmed row is fresh for 60 seconds, so the coins admitted first (top of
the sort order, warmed at the start of the walk) have gone stale by the time
they are admitted.

## Candidate fixes

**A. Window per logical run, not per clock.** Read the catalog when a run
begins; hold it until `drain_left` hits zero; drop it then. Turns ~200 walks
into 1. Needs answers for: what if the catalog shifts mid-drain (a run becomes
a point-in-time snapshot — arguably correct, and matches "top-N stays exact"),
and how a run that never completes releases the memory.

**B. Stop early instead of walking everything.** The walk is *already in the
feed's sort order*, so a "top 500 by market cap" feed needs 2 pages, not 74.
Push the per-run limit — and ideally the filters — into the enumeration loop so
it can stop once it has enough matches. Biggest win, and the one that removes
the FMP-shaped assumption rather than working around it. Cost: filters
currently apply downstream precisely so the cached window survives a
filter-only edit (`server/ingestion/connector.js`), so this trades cache reuse
for early exit. Probably worth it — a filter tweak re-walking is the rare case;
every drain tick re-walking is the common one.

**C. Per-adapter `INGEST_RUN_CAP`.** The 25 is a *tick-latency budget* inherited
from file ingestion, where an admission decodes an image and the cost is
per-item ([ingestion-plan.md](ingestion-plan.md): "a full 25-admission tick of
images can hold the tick a few seconds"). Connector feeds have the opposite
cost shape — cheap items, expensive setup — so one number serving both is the
root of the ratio. Smallest change; helps proportionally (batch 250 → ~0.3
requests/coin). Does not fix the underlying re-walk.

**Recommendation: B, with A as the fallback if pushing filters down proves
messy.** C is a legitimate stopgap and needs no code — `INGEST_RUN_CAP` is
already an env override.

## Today's workaround

Raise `INGEST_FEED_CACHE_MS` above the typical tick duration, or raise
`INGEST_RUN_CAP`. Both are blunt: the first serves a staler catalog to
everything, the second holds the shared worker tick longer.

## Scope note

Only bites on large drains against metered catalogs. A 50-coin board finishes
in two ticks and never notices; stocks never notices at all.
