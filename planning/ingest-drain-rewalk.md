# The drain re-walk: a metered feed reads the whole catalog once per tick

**Status: SHIPPED 2026-08-13** (slices 1–5; B stays rejected). Found during the
cleanup pass over [connector-full-catalog.md](connector-full-catalog.md); traced
through the code twice the same day, which corrected the arithmetic, the
mechanism, and the recommended fix. Affects METERED catalogs — crypto. Stocks
is structurally immune to the *re-walk*, and the reason why is the whole story.

What landed, against the diagnosis below:

| Slice | Landed as |
|---|---|
| 1 · own loop | `ingestLoop` in `server/worker.js`, `ingestDue()` returns "still draining" |
| 2 · **D** prewarm | `runtime.prefetchIds` + `warmIds`, `conn.prefetchIds` on the bind, adapter `prewarm`, called before the admit loop |
| 3 · **A** drain hold | `enumerate(…, { extend })` + `first`/`at` on the cache entry, `WINDOW_MAX_MS` 6h |
| 4 · **E** page size | `maxPageSize` on CoinMarketCap (5000), `pageSizeFor`/`maxPagesFor` in the adapter |
| 5 · **C** run cap | `descriptor().runCap` = 250 for feeds; `INGEST_RUN_CAP` still overrides both |

Verified by `test/ingest-connector.test.js` — six adapter tests plus a
`drain economics` end-to-end that runs the real worker → runtime → bind →
adapter path over a registered stub domain and asserts a three-tick run costs
**one** catalog walk and **one** batched warm per full tick. Full suite green
(1093). The one thing measurement can't settle in-process is CMC's credit
accounting for a 5,000-row `listings/latest`; the reasoning for why it is safe
under either model is in the provider comment.

## The behaviour

A feed run is not one pass. The worker admits at most `INGEST_RUN_CAP` (25)
items per tick, stores the remainder in `drain_left`, and schedules the next
tick for *now* — so a 5,000-coin board is ~200 back-to-back ticks:

- `server/worker.js:1765` — every tick begins with `adapter.enumerate(...)`
- `server/worker.js:1773` — `batch = picked.slice(0, INGEST_RUN_CAP)`
- `server/worker.js:1800` — `remaining > 0 ? Date.now() : …` (immediate re-run)

`enumerate` walks the entire catalog. For CoinGecko that is ~74 metered
requests (~18,400 coins, `per_page` maxes at 250 — 75 including the empty page
that ends it, since enumeration stops ONLY on an empty page). There is a 60 s
window cache in front of it, and the next tick reliably arrives after it lapses.

**Why it lapses is not what it first looks like.** The entry is stamped at walk
*completion* (`server/ingestion/connector.js:114`), not at its start, so the
walk's own duration never eats its TTL. What eats it is the gap to the next
tick — and that gap is the 25 **admissions**, which are themselves metered:

    admit → addConnectorEntity → conn.fetchEntity → quoteFor
          → quote-cache miss → one single-id /coins/markets call

Those rows were warmed on page 1 of the walk, minutes earlier, against a 60 s
quote TTL. So every admission misses. The token bucket is empty by then too —
the walk spent the burst (`server/provider-pacing.js:30-33`) — so each
admission waits a full 6 s at keyless 10 rpm: **150 s of admissions**, then a
3 s poll. The window has always lapsed, and the walk repeats. With a demo key
(rpm 30) it is ~50 s and hits about half the time, so the cost there is
nondeterministic rather than reliably 74/tick.

### Three cost planes, not one

| | per tick | 5,000-coin run (200 ticks) | default full-catalog drain (736 ticks) |
|---|---|---|---|
| Metered requests | ~74 walk + ~25 admit = **~99** | ~19,800 | **~73,000** |
| Wall clock | ~444 s walk + ~150 s admit = **~9.9 min** | ~33 hours | **~5 days** |
| `maintainLoop` occupancy | the whole tick | continuous for 33 h | continuous for 5 days |

**~4 metered requests per coin ingested**, against a 10,000-credit *monthly*
budget. The admissions are a third of that bill and were missing from the first
draft's arithmetic.

The third row is the one nobody had noticed. `ingestDue()` is awaited inside
`maintainLoop` (`server/worker.js:2387`) with no yield, and the walk sits inside
it — so while a crypto board drains, `recoverStuck`, `retagDue`,
`pruneSnapshots`, `reapGhostEntities` and `autoBackup` run **once per ~10
minutes instead of every 3 seconds, for days**. Stuck-item recovery is the one
that hurts. Two draining boards serialize in the same `for` loop, so it adds.

The worst case is the DEFAULT config, not a big one. `ingest.limit` is `null`
by default and `null` means "all" (`server/ingestion/index.js:96-104`), so a
plain crypto feed drains the whole catalog: **~73,000 requests — 7× the monthly
credit budget — over ~5 days, with recovery stalled throughout.**

## Why stocks doesn't have this

Not because the stocks code is better — because FMP's API is a different shape.

| | Bulk endpoint? | Full catalog costs |
|---|---|---|
| **FMP** (stocks) | `company-screener` returns the whole universe with market data, ≤10k rows per response | **3 requests** (one per venue), cached, then every page free |
| **CoinGecko** | none — `/coins/markets` caps at 250 rows/page. `/coins/list` returns all ~18.4k coins but carries **no market data**, so it can't back a table sorted by market cap | **~74 requests** |
| **CoinMarketCap** | `listings/latest` takes `limit` up to 5000 | ~2 requests *in principle* — **~32 today**, see slice 4 |

The CMC row is a capability we don't use: `ENUM_PAGE` is hardcoded at 250 for
every provider (`server/ingestion/connector.js:52`) while CMC's `list` passes
`pageSize` straight through to `limit=`. The comment there claims 250 "is also
the ceiling the catalogs themselves impose on a page" — true for CoinGecko,
false for CMC.

So the snapshot pattern that makes stocks free is *available* to FMP, mostly
available to CMC, and genuinely unavailable on CoinGecko. The feed adapter's
design — "enumerate everything, then filter and limit downstream" — quietly
assumes the FMP shape, where enumerating everything is one cached call.

Crypto predates that assumption: it was built as pass-through paging, which is
the right trade for a human clicking browse pages (one request per page you
actually look at) and the wrong one for a feed that wants the whole catalog.

**Removing the feed-window ration is what surfaced this.** While the window was
rationed to 1,000 rows the walk was 4 requests and nobody noticed; at full
catalog depth it is 74. [ingestion-plan.md](ingestion-plan.md) still carried the
belief from that era — "Drain ticks within a run therefore don't re-page
either" — true at 4 requests / 5 s, false at 74 / 7 min. It has a correction
line now; this document is the reason.

Stocks is immune to the re-walk, not to admissions: FMP's `fetchEntity` is
`Promise.allSettled([quote, profile, ratios])` — **3 requests cold**, 1 warm on
the 6 h caches. Every symbol in a fresh drain is cold, so a 1,000-stock feed
costs ~3,000 requests, at rpm 240 against a far more generous tier. Same seam
slice 2 opens, without the urgency.

## Already mitigated (do not re-fix)

The cleanup pass made every path that buys market rows warm the shared quote
cache, so **browse-then-bulk-add is now free** — that was 100 requests for a
100-row add and is 0. It does *not* rescue the drain: the walk takes minutes
while a warmed row is fresh for 60 seconds, so the coins admitted first (top of
the sort order, warmed at the start of the walk) have gone stale by the time
they are admitted. That staleness IS the ~25 requests/tick above, and slice 2
is what collects the win the warming was reaching for.

---

# The plan

Four slices, in dependency order. Each is independently shippable and
independently valuable; **3 must not ship before 2**, and 1 should go first
because it is the highest-severity finding and de-risks everything after it.

| | Slice | Size | Buys |
|---|---|---|---|
| 1 | Ingestion gets its own loop | small | recovery stops stalling for days |
| 2 | Batch the admission warm (**D**) | small | ~4 → ~0.5 requests/coin; incidentally restores the cache hit |
| 3 | Window survives a drain (**A**) | small | one walk per logical run instead of ~200 |
| 4 | Per-provider page size (**E**) | tiny | ~16× on CMC's walk |
| 5 | Per-adapter run cap (**C**) | tiny | amortizes the walk 10× further — **after 2** |

Cumulative, on the 5,000-coin run:

| | requests | wall clock |
|---|---|---|
| Today | ~19,800 | ~33 h |
| + slice 2 | ~2,700 | ~4.7 h |
| + slice 3 | ~274 | ~41 min |
| + slice 5 | ~94 | ~13 min |

The default full-catalog drain goes from ~73,000 requests / ~5 days to
**~148 requests / ~27 minutes.**

## Slice 1 — ingestion moves to its own loop

`maintainLoop` already lost its two heavy sweeps for exactly this reason; its
own header says the split exists "so a big embed backlog or a slow connector
can't delay recovery or ingestion" (`server/worker.js:2375-2379`). Ingestion is
now the slow one, so it belongs beside them by the same argument.

- `server/worker.js`: add `ingestLoop`, modelled on `refreshLoop`
  (`:2426-2438`) — its own `ingestWake`, `wake()` after each pass (admissions
  create claimable work: `insertItem` lands `pending`/`pending_face`), and the
  `more ? 200 : POLL_MS` cadence.
- `ingestDue()` returns whether any board still has `drain_left`, so a drain
  paces at 200 ms instead of waiting out `POLL_MS` between ticks.
- Remove the `await ingestDue()` call from `maintainLoop` (`:2387`) and add
  `ingestLoop` to the drain `Promise.all` (`:2606`) and the shutdown wake block
  (`:2600-2601`).
- Update the `maintainLoop` header comment: it now describes what it no longer
  does.

Contention is unchanged — `refreshLoop` and ingestion already competed for the
same per-provider token bucket. What changes is that a 7-minute walk stops
holding recovery hostage. Per-board serialization inside `ingestDue` stays: a
bounded number of concurrent walks against a metered API is the feature.

## Slice 2 — batch the admission warm (**D**)

Those 25 ids can be warmed in ONE request, and every piece already exists.
Providers export `prefetch(ids, ctx)` (`crypto/coingecko.js:126`,
`crypto/coinmarketcap.js:148`), the runtime has `prefetchRefresh`
(`connectors/runtime.js:334`), and the refresh sweep already does exactly this
at `server/worker.js:1706` for exactly this reason. The only gap is that
`prefetchRefresh` reads ids out of `inst.payload.source`, while an ingest
candidate carries `.id` directly.

- `server/connectors/runtime.js`: extract the warm into `prefetchIds(db, conn,
  ids)` — resolve the active provider, bail unless it exports `prefetch`, dedupe
  to strings, skip when fewer than 2 (nothing a batch would save), call through
  `callProvider`. Re-express `prefetchRefresh` as "map rows → ids belonging to
  the active provider, delegate" so the machinery exists once. The quote-cache
  header is the standing argument for not writing this twice.
- `server/connectors/index.js:41`: expose `prefetchIds: (db, ids) =>
  runtime.prefetchIds(db, conn, ids)` on the bind.
- `server/ingestion/connector.js`: add an optional adapter method
  `prewarm(db, board, batch)` → `conn.prefetchIds(db, batch.map(c => c.id))`,
  best-effort with a `console.warn` on failure (the `prefetchDueRefreshes`
  contract: a failure only means the per-item path pays retail).
- `server/worker.js`: call it immediately after `const batch = …` (`:1773`),
  guarded `if (adapter.prewarm && batch.length > 1)`.
- `server/ingestion/folder.js`: the pinned adapter contract gains `prewarm` as
  optional — the file adapter doesn't implement it and nothing changes for it.

Why this is first among the cost fixes: it cuts a tick from ~99 to ~75
requests, and it collapses the inter-tick gap from ~150 s to ~10 s — which is
*under* the 60 s window TTL, so the next ~6 ticks hit the cache. **It buys most
of slice 3 as a side effect**, before slice 3 exists.

FMP exports no `prefetch`, so stocks keeps paying retail per admission. That is
the same seam and a separate, lower-priority piece of work.

## Slice 3 — the window survives a drain (**A**)

Hold the enumerated window across a drain instead of re-walking it. Not a
run-scoped lease with its own lifecycle — a **slide, scoped to drain ticks**:

- `server/ingestion/connector.js`: `enumerate(db, board, cfg, { limit, extend })`.
  On a cache hit, when `extend` is set and the entry's original fill is younger
  than `WINDOW_MAX_MS`, restamp `at` before returning. Cache entries carry
  `first` (fill time) alongside `at` (last touch); `fillWindow` sets both.
- `server/worker.js`: hoist the `drainLeft` read above the enumerate call
  (currently `:1770`, after it) and pass `{ extend: drainLeft > 0 }`.

The scoping is load-bearing and is the correction to a wrong first draft.
Sliding on *every* caller would let a preview session — Preview, Load more, a
filter tweak (`public/ingest-modal.js:555,677`) — pin the window indefinitely
and serve an ever-staler catalog where today it refreshes after 60 s. Only the
sweep extends, and only mid-drain: tick 1 of a run has `drain_left = 0` and
walks; every tick after it extends. A preview is never affected.

`WINDOW_MAX_MS` (6 h, a local constant — there is no operator use case for a
knob) is a staleness ceiling, not a memory guard. Memory needs no new
machinery: `pruneExpired` already reclaims an entry 60 s after its last touch,
so an abandoned drain releases its ~4 MB catalog on the next write, and a live
drain's entry is pinned precisely because it is in use.

The catalog-shifts-mid-drain question resolves the way the original draft
argued: a run becomes a point-in-time snapshot, which is *more* correct than
today's per-tick re-walk, and entity field values are unaffected because
`admit` re-fetches them.

## Slice 4 — per-provider page size (**E**)

- `server/connectors/crypto/coinmarketcap.js`: `export const maxPageSize = 5000`
  (`listings/latest`'s documented ceiling; `start = (page-1)*pageSize+1` already
  pages correctly at any size). CoinGecko omits it — 250 is its real cap. FMP
  clamps locally and is cache-served either way.
- `server/ingestion/connector.js`: `ENUM_PAGE` becomes a default; `enumerate`
  reads `active.provider.maxPageSize` and threads the size into `fillWindow`.
- **`MAX_PAGES` moves with it.** It is derived module-wide from the constant
  today (`:57`); a per-provider page size against a global page budget is
  precisely the drift that comment exists to prevent. Derive it per walk from
  the page size actually in use.
- The cache key needs no change: page size doesn't alter the logical window, and
  a provider switch already re-keys via `active.name`.

**Verify before shipping:** CMC bills some endpoints per block of returned data
points, not per call. If a 5,000-row `listings/latest` costs ~25 credits rather
than 1, slice 4 is a wall-clock and rate-limit win only, not a credit win. That
changes its priority, not its correctness.

## Slice 5 — per-adapter run cap (**C**) — *after slice 2*

The 25 is a *tick-latency budget* inherited from file ingestion, where an
admission decodes an image and the cost is per-item
([ingestion-plan.md](ingestion-plan.md): "a full 25-admission tick of images can
hold the tick a few seconds"). Connector feeds have the opposite cost shape —
cheap items, expensive setup — so one number serving both is the root of the
ratio.

- `server/ingestion/connector.js`: the descriptor gains `runCap: 250` (matched
  to the quote-cache chunk size, so a tick is exactly one prefetch request).
- `server/worker.js:1773`: `Number(process.env.INGEST_RUN_CAP) ||
  adapter.descriptor().runCap || 25`. The env knob stays the operator's last
  word over both — `test/ingest-sweep.test.js:31` relies on it.

**The ordering is a hard dependency, not a preference.** Before slice 2, a
250-admission tick is 250 × 6 s = **25 minutes** of serialized metered
admissions; on today's `maintainLoop` that is 25 minutes without stuck-item
recovery — a worse bug than the one it patches. After slice 2 the same tick is
one HTTP request plus ~750 DB writes, roughly 15 s.

**Verify before raising the cap:** `marketRowsByIds` chunks at 250
(`crypto/coingecko.js:108`), but `prefetchDueRefreshes` only ever sends
`REFRESH_BATCH` = 20 ids — so the 250-id `ids=` URL (~3.2 KB of query string)
has never been exercised in production. Check it against the live endpoint
first; if it 414s, the cap becomes whatever chunk size does work.

---

## What deliberately does NOT change

- **`drain_left` semantics and the ledger.** The budget still resumes so a
  logical run's `limit` stays exact; deletions stay final. Slices 2–5 change the
  cost of a tick, never which items a run admits.
- **`ENUM_CAP` / no app-side depth ration.** A capped window clogs — the ledger
  dedups downstream, so once the first N are ingested everything past N becomes
  permanently unreachable. `INGEST_FEED_CAP` stays the operator's own knob.
- **Filters, sort and limit stay downstream** in the shared engine. See Rejected.
- **The preview↔run "one bound" invariant** (`server/server.js:1173-1177`):
  preview and a run continue to enumerate to the same depth and share a cache
  key. Slice 3 changes only who may *extend* an entry, not who may read one.
- **The 60 s quote TTL and 60 s window TTL.** Both are correct; the bug was
  never the numbers, it was paying retail 25 times between ticks.
- **Per-board serialization inside `ingestDue`.**

## Rejected

- **B — early exit from the enumeration loop.** The instinct is right (the walk
  is already in the feed's sort order, so "top 500" wants 2 pages) and it is
  still the only fix that removes the FMP-shaped assumption rather than working
  around it. It is rejected on five counts:
  - **It can be silently wrong.** `browse.sorts` offers `price` and `name`
    (`connectors/crypto/index.js:104-109`), but CoinGecko's `SORT_ORDER` has no
    `price` and maps `name` to `id_asc/desc`. Today the full walk makes that
    harmless — the engine re-sorts the whole catalog, so top-N by price is
    exact. Early exit turns "top 500 by price" into "top 500 by *market cap*,
    re-sorted by price", and only for the sort keys a user is least likely to
    check. Gating on "the provider honors this key" needs a capability no
    provider declares.
  - **The ledger has to go into the loop, not just the filters.** `fresh` is
    computed after enumerate (`server/worker.js:1766-1767`). Exiting on 500
    *rows* rather than 500 *unledgered matches* re-creates the exact clog
    `ENUM_CAP` exists to prevent: after run 1 the top 500 are all ledgered and
    the feed admits nothing, forever. So `enumerate` grows a `known` Set — and
    the window cache dies for feeds, because its key would have to include a set
    that changes on every admission.
  - **Its savings decay to zero.** `limit` is a per-run admission *rate*, not a
    board target (`server/ingestion/index.js:96-104`). A limit-500 feed takes
    ranks 1–500, then 501–1000, then… Early exit needs 2 pages on run 1, 20 on
    run 10, all 74 by run ~37. Slice 3 is O(1) walks per run at any depth.
  - **It never fires on the default config**, where `limit` is `null` → budget
    `Infinity` — which is the expensive case.
  - **It costs the preview invariant** either way: an early-exiting preview's
    `count` stops being a count (always == limit, always `capped`); a
    non-early-exiting one disagrees with the run on depth.

  After slices 2–5 the residue B would attack is ~74 requests per *logical run*.
  Revisit only if a provider gains a declared sort-capability map, and then for
  the filter push-down, not the limit.
- **`INGEST_FEED_CAP` as the answer.** It shortens the walk by rationing
  *depth*, which is the clog above. Named here so it is rejected on purpose
  rather than reached for by accident — it is the first knob an operator finds
  in `.env.example`.
- **Raising `INGEST_FEED_CACHE_MS` globally.** Serves a staler catalog to
  previews and browse as well; slice 3 does the same thing precisely.
- **Pushing filters to the provider.** CoinGecko offers only `category`, and
  the engine's op vocabulary is richer than any provider's query language. It is
  the B trade in disguise, with a per-provider surface to maintain.

## Tests

`globalThis.fetch` stubbing and stub connectors as throughout. Note
`test/helpers.js:81` sets `INGEST_FEED_CACHE_MS = "0"` globally — cache tests
opt in the way `test/ingest-connector.test.js:249` does.

- **Slice 1**: `ingestDue` reports `more` while a board drains; a board whose
  enumerate hangs does not delay a `recoverStuck` pass (assert via loop
  composition — the maintenance pass no longer awaits ingestion).
- **Slice 2**: a spy `prefetch` receives the batch's ids exactly once, before
  any `fetchEntity`; admissions then make zero further provider fetches; a
  `prefetch` that throws still admits the batch (best-effort contract); a
  single-item batch skips the prefetch; the folder adapter path is untouched.
- **Slice 3**: with a warm window and `drain_left > 0`, an enumerate past the
  TTL makes zero `list` calls; with `drain_left = 0` past the TTL it re-walks;
  an entry older than `WINDOW_MAX_MS` re-walks even with `extend`; the preview
  route never extends (two preview calls straddling the TTL walk twice).
- **Slice 4**: a provider declaring `maxPageSize` is called with it; one that
  doesn't gets 250; `MAX_PAGES` derives from the size actually used.
- **Slice 5**: the adapter's `runCap` is honored; `INGEST_RUN_CAP` still beats
  it (existing sweep tests depend on this); the file adapter still caps at 25;
  a 250-item batch issues exactly one prefetch.
- Existing suites stay green — `ingest-sweep`, `ingest-connector`,
  `ingest-sources`, `job-log`.

## Acceptance

- [ ] A draining crypto board no longer delays `recoverStuck`: recovery keeps
      its ~3 s cadence throughout a multi-hour drain.
- [ ] A 25-item drain tick costs **1** metered request beyond the walk, not 25
      (assert on the pace/fetch spy, the house pattern).
- [ ] A 5,000-coin drain performs **one** catalog walk, not ~200 — visible as a
      single burst of `list` calls in the provider spy across the whole run.
- [ ] Preview behaviour is unchanged: two previews 90 s apart still walk twice.
- [ ] A CMC feed's walk drops from ~32 requests to ~2 (and the credit cost of
      that is measured, not assumed).
- [ ] `INGEST_RUN_CAP=250` on a crypto board: tick under ~20 s, one metered
      request, maintain cadence undisturbed.
- [ ] The 250-id prefetch URL verified against the live CoinGecko endpoint.
- [ ] Measured end to end: default full-catalog drain ≤ ~200 requests and
      ≤ ~45 min, against ~73,000 / ~5 days today.
- [ ] `node --test` fully green.

## The preview pass (2026-08-13, same day)

Reported from use: an ingest preview against CoinGecko took **2 minutes**. Same
root cause as the drain, on the path slice 3 deliberately left alone — and the
arithmetic is exact rather than approximate: a preview walks the full catalog
(75 requests) and every one waits on the token bucket. 134 s at rpm 30, which is
the reported number to the second. The network was doing nothing.

Three fixes, each answering something the diagnosis above had gotten wrong or
left unexamined:

**6 · The limiter learns the tier** (`server/provider-pacing.js`). `rpm` was 30
because the docs had said both 30 and 100 and 30 was safe under either — resting
on "the gap doesn't cost throughput: the caches, not rpm, are what make a board
cheap." That was true at a 4-request walk and false at 75, so the hedge had
quietly become a 3× tax on the most visible path in the product. The number is
100 now, but the real fix is that it no longer has to be right: a 429 halves
that bucket's effective rate (`throttled`), each further refusal halves again to
a floor, and a quiet 5 minutes wins one step back. `withRetry` previously
re-sent at the same pace forever, which for a provider that bills failed
requests spends real money on requests it was denied.

**7 · A window outlives the clock in proportion to what it cost**
(`server/ingestion/window-cache.js`). The sharpest finding of the pass: the TTL
was 60 s and the fill took 134 s, so an entry expired before anything could
reach it. That is not a cache. Lifetime is now `max(ttl, 10 × fill)`, floored so
a cheap fill can't overrule a deliberately short TTL and capped at 15 min so
expensive never means immortal. `pruneExpired` reads the same lifetime, or a
cheap fill would evict the expensive entry it exists to protect.

**8 · A filter on the sort key stops the walk** (`exhaustedBy`, connector.js).
Walking market_cap descending under `market_cap >= 10M`, the first row below the
bound proves every later row is below it. **This is not the B rejected above,
and the distinction is the whole point: B stopped at *enough matches*, this
stops at *provably no more matches*.** Nothing skipped could have been admitted,
so the count stays exact, no row becomes unreachable, and preview and run agree
because they run the same rule. Gated on the provider declaring it orders that
key exactly (`honorsSorts` — CoinGecko has no `price` order and only
approximates `name` by coin id), and the bound rides in the cache key, since an
early-exited window is a partial catalog that must never be served to a wider
one.

Measured for the reported config (`Mkt cap ≥ 10M`, market cap descending):

| | first preview | repeat |
|---|---|---|
| Before | 2.2 min | 2.2 min (TTL < fill) |
| rpm 100 alone | 40 s | 40 s |
| **+ threshold exit** | **4 s** | **<1 s** |
| filterless preview | 40 s | <1 s (entry lives 6.7 min) |

The two caching fixes are not redundant: the threshold exit makes the *bounded*
walk cheap, and the cost-scaled TTL is what saves the *filterless* one, where
nothing can stop the walk and only reuse helps.

## Left open (found in the post-implementation pass)

- **A bigger tick widens an existing `drain_left` hole.** State is written after
  the admit loop, so a worker killed mid-tick loses that tick's budget
  accounting and the next run starts from a fresh `cfg.limit` — it can
  over-admit past the logical run. True before at ≤25 items, now ≤250. Writing
  the budget *before* admitting just swaps it for the opposite error (a crash
  would silently skip the unadmitted remainder), so the real fix is the run
  identity `drain_left` never had ([ingestion-plan.md](ingestion-plan.md), the
  2026-07-14 loose-ends pass). Not widened by choice, but not fixed here.
- **Stocks feeds inherit `runCap: 250` without the prewarm benefit** — FMP
  exports no `prefetch`, so a tick is 250 sequential `fetchEntity` calls
  (~3 min at rpm 240). Total cost is unchanged (same requests, fewer ticks) and
  it is off the maintenance loop now, so nothing stalls; the only real loss is
  progress granularity in the modal. `descriptor()` is static and can't see
  which provider is active, so a per-provider cap would need a different seam.
- **FMP has no `prefetch`.** The `prefetchIds` seam is provider-agnostic and
  ready; a `batch-quote`-capable FMP tier would drop stocks admissions the same
  way. Blocked on the tier, not on the code.
- **The AI wire doesn't learn its tier yet.** `provider-pacing.js` is shared
  with `server/providers.js` (bucket key `ai:<provider>:<keyhash>`), so
  `throttled` is available there for free, but nothing calls it — the AI path
  has its own error classification (`worker.js` transient/permanent) and wiring
  it needs that read properly rather than by analogy. Gemini's free tier is
  10 rpm against a paid tier of ~1,000, which is exactly the guess-the-tier
  problem fix 6 solves for connectors.
- **Only `gte`/`lte` bound a walk.** `eq` on the sort key has the identical stop
  condition and would be one array entry, but an equality filter on market cap
  is not a real query; left out rather than carried untested.
- **A learned penalty is only visible in the log.** `throttled` warns on a
  change, which beats silence, but the Plugins page shows a health dot and no
  pacing state — so "why is this provider slow" is answerable from stdout and
  nowhere else. The value is already on the bucket; surfacing it beside the dot
  is a UI change, not a mechanism one.
- **Two staleness ceilings now govern one cache** — `COST_TTL_MAX` (15 min, for
  passive reuse) and `WINDOW_MAX_MS` (6 h, for a run holding its own snapshot).
  They answer different questions and the gap is deliberate, but a third would
  be a smell.

## Scope note

Only bites on large drains against metered catalogs. A 50-coin board finishes
in two ticks and never notices; stocks never notices the re-walk (it still pays
~3 requests per cold admission, at rpm 240 against a generous tier — the same
seam slice 2 opens, without the urgency).
