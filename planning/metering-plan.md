# Metering — what the app consumed, what it cost, and who spent it (2026-08-31)

**Status: DESIGNED, NOT STARTED.** Self-contained for a fresh session. Written
after a deep dive on the current token accounting plus research into how the
observability/metering ecosystem models this. Both product calls are made
(2026-08-31, see "Decided"): money is shown where a price rung answers, and
spend is visible to the app admin and board managers.

## The problem

The Boards page says `ui — 26.7M in · 6.4M out`. That is a true number that
answers no question anybody actually asks:

- **Which model spent it?** A board's model can change (board pin, app default,
  the on-device model axis). Totals silently blend a cheap model's history with
  an expensive one's.
- **Which kind of work spent it?** `tag`, `extract` and facet-diagnosis all bump
  the same counter with nothing to tell them apart.
- **What did it cost?** Tokens are not money. 26.7M in is somewhere between a
  couple of dollars and eighty, depending on a binding nobody recorded.
- **What did that one retag pass cost?** Board-per-day is the finest grain in
  existence, so there is no answer.
- **Is the cache earning its keep?** `cache_read_tokens` is recorded and appears
  only inside a `title=` attribute.

And the coin chip in the toolbar shows `SUM(input + output)` — adding two
quantities that bill at 3–5× different rates. It is the one piece of arithmetic
in the feature that is actually wrong.

The load-bearing point: **history you don't attribute today can never be priced
later.** Every day without a model/capability dimension is a day that is
permanently uncostable. That is why Stage 1 comes before the dashboard, the
prices, and everything else people would rather build first.

## What already exists (and why it isn't enough)

- **`ai_board_usage`** (`0001_baseline.sql` ~L262) — `(day, board_id)` →
  `count, input_tokens, output_tokens, cache_read_tokens, search_count`. Written
  by `bumpUsage` ([db.js:2895](../server/db.js#L2895)) from exactly three call
  sites: the tag landing and the extract landing in
  [worker.js](../server/worker.js#L1984) (one call **per paid call**, so N votes
  record as N — the invariant is already right), and
  [facet-diagnosis.js:618](../server/facet-diagnosis.js#L618).
  Four fixed unit columns means every new unit is a migration.
- **`job_log`** ([job-log-plan.md](job-log-plan.md)) — one row per execution
  attempt with a `detail` JSONB already carrying `model`, `votes`, `image`,
  `facets`. The per-request drill-down rung exists; it just has no tokens in it.
- **`CAPABILITY_DEFS`** ([capabilities.js](../server/capabilities.js)) — the
  capability list as pure data, with the standing rule that no consumer may name
  a capability. The meter's `capability` dimension is this table's ids, which is
  what makes "a new capability meters itself" true.
- **The rung chain** ([capability-resolve.js](../server/capability-resolve.js))
  — eight steps, one implementation, `viaFloor` as the honesty bit. The price
  map's resolution is the same shape and should read like a sibling of it.
- **Not metered at all:** embeddings (`embedTexts` **returns** usage and
  [embedBatch](../server/worker.js#L696) drops it on the floor), keyed
  transcription, keyed detection, and connector quota burn — which is real spend:
  [runtime.js:53](../server/connectors/runtime.js#L53) notes CoinGecko charges
  for *failed* requests.

So the column labelled "AI tokens" means "tagger-family tokens". It overpromises
by name.

## The reframe: this is metering, not tokens

Tokens are one unit among several. The moment the mechanism says "tokens" in its
own vocabulary it can only ever serve the tagger. The metering ecosystem
(OpenMeter, Stripe meters) converged on a three-layer split that is exactly the
separation this codebase already prefers:

| layer | knows | does not know |
|---|---|---|
| **the meter** | units consumed, by whom | that prices exist |
| **the rating** | units × price | what produced the units |
| **the reader** | how to aggregate and draw | either of the above |

Three mechanisms, each useful alone, none aware of the others.

## Mechanism 1 — the meter (`0040_usage_meter.sql`)

```sql
CREATE TABLE usage_meter (
  day              TEXT   NOT NULL,
  board_id         TEXT   NOT NULL,   -- '' = app-level (see the sentinel note)
  capability       TEXT   NOT NULL,   -- a CAPABILITY_DEFS id, or a non-AI meter name
  provider         TEXT   NOT NULL,
  model            TEXT   NOT NULL,   -- '' where the unit has no model axis
  unit             TEXT   NOT NULL,
  quantity         BIGINT NOT NULL DEFAULT 0,
  priced_quantity  BIGINT NOT NULL DEFAULT 0,
  cost_micros      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, board_id, capability, provider, model, unit)
);
CREATE INDEX idx_usage_meter_day ON usage_meter (day);
```

The contract is one sentence: **N units of `unit` consumed by this subject.** It
does not know AI exists.

- **Narrow rows, one per unit** — not the four fixed columns we have now. A
  plugin that bills in audio-seconds or images writes a different string and
  `GROUP BY unit` still aggregates it. Chosen over a `units` JSONB: same
  flexibility, plain SQL, no `jsonb_each` in every aggregate.
- **`board_id` is `TEXT NOT NULL` with `''` for app-level, not a nullable FK.**
  Postgres unique indexes treat NULLs as distinct by default, so a nullable PK
  column silently breaks `ON CONFLICT` and turns the rollup into an append-only
  log by accident. Same reasoning for `model`. The cost is losing the ON DELETE
  CASCADE — board deletion prunes the meter explicitly, the `job_log`
  `entity_id` stance (history outlives deletion) applied one level up.
- **`priced_quantity` alongside `cost_micros`** — the honesty column. When part
  of a day's tokens ran on a model with no known price, the UI can say
  "≈$4.12 · 1.2M tokens unpriced" instead of quietly under-reporting the bill.
  `quantity - priced_quantity` is the unpriced remainder.
- **`cost_micros` is stamped at write time** (Mechanism 2), never recomputed at
  display time. A price edit must not rewrite last month's bill.
- **`requests` is a unit like any other**, retiring the special-cased `count`
  column. The one-row-per-paid-call invariant carries over verbatim — N votes
  meter N requests.

`bumpUsage` becomes a thin caller of `meter(db, subject, units)` and keeps its
name and signature at first, so Stage 1 touches no call site.

**The cardinal rule, borrowed from the job log: metering never breaks the job.**
Every meter write is wrapped the way `jobLogWrite` wraps its ledger — a failure
is a `console.warn`. This is also a live bug fix: today a `bumpUsage` throw after
`markTagged` lands in the catch at [worker.js:2002](../server/worker.js#L2002)
and reports a *tagging* failure for what is really a bookkeeping failure
(`worker-queue-holes.md` #11 names this).

**What else this serves,** which is the test of whether it is genuinely generic:
connector quota burn (including the failed calls that still bill), storage bytes,
transcription minutes, ingest scans. None of those are AI; all of them are
"N units consumed".

### Unit vocabulary — OTel names, one deliberate divergence

[OpenTelemetry's GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
already standardize these strings. Borrowing them costs nothing now and means
the meter can export to any observability tool later with no translation layer —
and, more to the point here, it means we are not inventing a private dialect for
something already named.

| unit | source |
|---|---|
| `input_tokens` | OTel `gen_ai.usage.input_tokens` |
| `output_tokens` | OTel `gen_ai.usage.output_tokens` |
| `cache_read_tokens` | OTel `gen_ai.usage.cache_read.input_tokens` |
| `requests` | ours |
| `web_searches` | ours (billed per search on top of tokens) |
| `audio_seconds`, `images`, `bytes` | ours, for Stage 5 |

**The divergence, recorded as a decision rather than discovered later as a
discrepancy:** OTel specifies that `input_tokens` *includes* cached tokens. We
keep the buckets **mutually exclusive** because they bill at different rates, and
a meter that feeds a price must not double-count. The anthropic wire's existing
choice — cache *creation* folded into `input`, cache *reads* held out — is
already this rule and stays. If we ever export to OTel, derive their total there.

## Mechanism 2 — the rate map (`0041_model_prices.sql`)

```sql
CREATE TABLE model_prices (
  provider        TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  unit            TEXT    NOT NULL,
  micros_per_unit NUMERIC NOT NULL,   -- micro-dollars for ONE unit
  source          TEXT    NOT NULL,   -- 'admin'|'provider'|'descriptor'|'community'
  effective_from  BIGINT  NOT NULL,
  fetched_at      BIGINT,
  PRIMARY KEY (provider, model, unit, effective_from)
);
```

`$3/M input tokens` = `3` micros per token; `$0.30/M` cache reads = `0.3`, hence
`NUMERIC` for the price and a round-to-micros only when stamping `cost_micros`.
`effective_from` is what lets a price change without falsifying history.

### The rungs — the reason a vendored file cannot be the source of truth

Plugins extend the provider catalog, so **no price list is ever complete.** The
community map is the last rung, not the answer:

1. **Admin typed it in** — always wins, always available, works for a provider
   that shipped yesterday.
2. **The provider told us** — a `listPrices` wire verb, peer of the `listModels`
   from [dynamic-model-discovery-plan.md](dynamic-model-discovery-plan.md).
   Some publish prices alongside the model list; most return `null`. Plugins
   inherit the verb for free.
3. **The descriptor declares it** — `prices: { "model-id": { input_tokens: 3,
   output_tokens: 15, cache_read_tokens: 0.3 } }` sitting next to the `models`
   array a descriptor already carries
   ([anthropic.js](../server/ai-providers/anthropic.js#L10)). Author-time data,
   same file, no new concept for a plugin author to learn.
4. **The community map** — LiteLLM's
   [`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
   (MIT repo; **confirm the licence covers the data file before shipping it in an
   open-source app**). Its field names map onto our units directly:
   `input_cost_per_token`, `output_cost_per_token`,
   `cache_read_input_token_cost`, and — for Stage 5 —
   `input_cost_per_second`, `input_cost_per_image`.
5. **Nothing** — the row is metered and unpriced. Not an error, not a guess.

**Fetch as needed, not vendored.** An unrecognized `(provider, model)` is the
trigger: pull the map, find the row, store it, never look again. A scheduled
re-pull refreshes what's already stored. A failed fetch keeps the last good rows.
Same posture as model discovery — live where possible, cached fallback, never an
error and never an empty answer.

### The trap: key on `(provider, model)`, never model alone

A plugin pointing the compat wire at a self-hosted box can serve a model id like
`llama3` or `gpt-oss` — ids that also exist in the community map at *hosted*
prices. Matching those invents a bill for something that ran free on the user's
own hardware. That is worse than showing nothing.

So the descriptor says whether a community lookup even applies: a namespace to
match under, or `prices: "free"`. Which means the three on-device engines
(whisper, the local embedder, the detector) report **$0 as a known price, not an
unknown** — on a page about spend, "this ran free on your own hardware" is a real
thing to be able to say. The vendor knowledge lives in each descriptor and never
in shared code, which is the same rule the wires already follow.

## Mechanism 3 — the reader

A dimensioned query — group by any subset of `(day, board, capability, provider,
model, unit)` over any window — plus **one** display component.

There are already three near-miss versions of that component: the sparkline is
inline HTML in [admin-boards.js:39](../public/admin-boards.js#L39),
[odometer.js](../public/odometer.js) rolls a single number, and
[detail-chart.js](../public/detail-chart.js) draws real series. A fourth copy is
the wrong move; promote the sparkline into a shared component and let the Usage
tab, the Boards column and anything later share it.

[detail-chart.js](../public/detail-chart.js) is also the precedent for the
agnosticism, not just the drawing — its header records that the client knows no
provider, tier or range table, because the controls render from what the response
says exists. Same rule here: **the server sends the units, their labels, and
which breakdowns exist; the client renders what it is handed.** A plugin
introducing a unit nobody anticipated then appears in the UI with zero client
changes.

## The boundary rules

- **The spender writes the meter.** No central dispatcher that knows every
  capability — `bumpUsage`'s current call sites are already the right shape.
- **Nothing downstream names a capability.** Iterate `CAPABILITY_DEFS`.
- **Prices are descriptor data**, never a number in shared code.
- **The client renders the server's vocabulary**, never its own list of units.
- **Rating stays out of the meter.** The meter writes units; a separate step
  stamps the cost it computed at that moment. Fusing them welds two layers that
  must age independently.

## Stages (each independently shippable; stop anywhere)

- **Stage 0 — the honesty pass. No schema. ✅ DONE (2026-08-31, suite
  1250/1250 incl. 3 new in test/token-totals.test.js).** Shipped exactly as
  deep-dived:
  - `getBoardTokenTotal` → `getBoardTokenTotals` returning
    `{ input, output, cache_read }` (same one-row query, three sums). Both call
    sites: the board payload's `token_total` becomes a `tokens` object, and
    `/api/boards/:id/tokens` returns the three fields. **No compat shim** — the
    client is the only consumer and no test pins `token_total`.
  - The chip reads **`26,712k / 6,395k`** (compact slash — picked over words and
    ↓/↑ arrows); the tooltip carries the labels + full numbers + cached reads.
    ONE odometer holds the whole string — non-digit cells render static, so both
    numbers roll independently and a shape change rebuilds without rolling,
    exactly today's behavior. The render gate becomes `input + output > 0`
    (summing unlike units is fine for a *visibility* gate, not a figure).
  - The chip is **already manager-only** (inside toolbar.js's `canManage`
    branch) — which is where "spend is management-visible" wants the Stage 3
    cost figure to land. Add a comment so that reads as a decision, not luck.
  - Boards column renamed **"Tagging tokens"** + a header tooltip naming the
    scope (tag + extract + facet diagnosis; embeddings/transcription/detection
    unmetered until Stage 5) — the rename must be honest about scope, not just
    arithmetic. Cache reads promoted out of the tooltip into the cell when
    nonzero (`3.9M in · 575.9K out · 1.2M cached`).
  - Touch list: db.js, server.js (×2), app.js:123, data.js `refreshTokens`
    (the `typeof number` guard becomes a shape check), state.js, toolbar.js,
    admin-boards.js, + a route-shape test. No migration.
- **Stage 1 — the meter. ✅ DONE (2026-08-31, suite 1258/1258 incl. 8 new in
  test/metering.test.js).** Migration 0040 (create + backfill + **drop
  `ai_board_usage`** — the deep dive corrected the plan's keep-it assumption:
  the sqlite importer's coupling is `ai_usage`, the pre-board global counter,
  which stays; nothing else touched the per-board table). Backfilled history
  lands as `capability='tag'`, provider/model `''` — honestly unattributed; the
  unpivot was rehearsed against the old shape in a throwaway DB before
  shipping (totals matched exactly, zero buckets produce no rows).
  Two layers in db.js: generic `meter()` (throws like any helper) and
  `meterAiCall()` (translates the wire shape, adds `requests: 1`, **swallows
  with a warn** — safety is the adapter's contract, not the mechanism's, and
  the swallow is what stops a metering blip being written up as "post-tag
  write failed" by the tag landing's catch, the worker-queue-holes #11
  mislabel). `bumpUsage` retired. Three call sites attributed: tag
  (`result.provider/model`), extract (`ai` — non-null exactly when `usage`
  is), and diagnosis metered as its own kind **`diagnose`** (the capability
  column takes the job-log kind vocabulary, a superset of CAPABILITY_DEFS
  ids). Readers (`getBoardTokenTotals`, `boardAiUsage`) reimplemented as
  unit-pivots with output shapes unchanged — zero client changes.
  `deleteBoard` purges the meter explicitly (the '' sentinel forbids the FK
  the other tables cascade on). `USAGE_METER_RETENTION_DAYS` (default 0 =
  forever) in the hourly prune + .env.example + compose. Tests pin the
  dimension upsert, the sentinel (NULL would append, '' updates), the wire
  translation, the admin read-back shape, the board purge, the prune cutoff,
  and the cardinal rule via the drop-the-table trick — plus votes' N-calls
  assertion now also proves attribution (`provider='openai'` recorded at call
  time, which is Stage 1's whole point). **The clock is stopped: every paid
  call from here on is attributable, so it can be priced later.**
  **Simplification pass (same day, suite 1260/1260):** `meterWrite(fn)` split
  out as the named safe path (the `jobLogWrite` analog) so Stage 5's spenders
  inherit the cardinal rule instead of re-deriving it; `meterAiCalls` folds a
  vote round's N passes into ONE write (identical PK — same stored numbers,
  `requests` still N, 3× fewer round-trips per item on a votes board); a `qty()`
  fragment builder replaced 15 hand-aligned pivot expressions so a new unit
  costs one string; `boardAiUsage` stopped computing `today` in SQL (it is
  already one of the day rows) and now runs its two independent queries
  concurrently; `today()` widened to `day(ms)` as the file's one UTC-day
  derivation; the four retention prunes became a `PRUNES` table (the old
  compound early-return guard had to be edited in two places, and a fifth knob
  that missed the second edit would silently never prune); `cacheRead` →
  `cache_read` so both usage readers speak one spelling; and `meterTotals` in
  test/helpers.js replaced four hand-rolled pivot SELECTs.
  **The Stage 0 column label was reverted to "AI tokens"** — "Tagging tokens"
  enumerated a capability list in a client tooltip, and the reader it labels
  filters on no capability at all, so Stage 5 would have made it a lie with no
  test failing. The label now states the invariant ("all AI usage metered on
  this board"), which is true before and after Stage 5.
- **Stage 2 — tokens on the job rows. ✅ DONE (2026-08-31, suite 1260/1260).**
  `tokens: { in, out, cache }` (cache omitted at zero, whole key omitted when
  nothing was reported) + `provider` on the tag, extract and diagnose rows —
  including **discarded** rows, where the tokens say the quiet part: the fence
  dropped the result, the money was spent anyway. `tokensDetail(usages)` lives
  in db.js next to the meter adapters (it owns the wire-shape knowledge); one
  usage or a vote round's array, summed — the row is per item either way, and
  `votes: N` sits beside the total explaining the multiple. Face rows carry no
  tokens (no LLM); keyed transcription waits for Stage 5's units. Failed rows
  attach nothing — a wire throw returns no usage.
  **Bonus fix folded in: spend metering is now unconditional.** Both meter
  writes were hoisted to the paid call — tag meters above `markTagged`,
  extract meters immediately after `trackedTagger` — so a landing-write throw
  no longer silently drops the bill (worker-queue-holes #11's "usage stays
  unconditional" invariant, previously violated on exactly the "post-tag write
  failed" path; safe now that meter writes never throw).
  Display: `summaryFor` appends `3.2K in / 208 out` to tag/extract/diagnose
  ok-rows, discarded rows read "… spent", cache reads join the row hover (the
  engine + rendition slot). `fmtTok` promoted from admin-boards.js to utils.js
  (the static-label formatter, deliberately distinct from the odometer's
  whole-thousands `formatTokens`). Old rows without the key render exactly as
  before. Pinned: both legs' tokens/provider in job-log.test, the vote round's
  summed bill next to `votes: 3`, diagnose's detail deepEqual including
  model/provider/tokens.
  **Simplification pass (same day):** the `{model, provider, tokens}` trio was
  being hand-assembled at four sites, each naming `(provider, model, usage)`
  twice — once for the meter, once for the row — and had already drifted (the
  diagnose *unusable-verdict* row, the one path that provably burned money for
  nothing, carried no cost at all). Now `spentDetail(dims, usages)` in db.js is
  the single spelling: each leg names its dims ONCE, hands the same object to
  the meter and to `spentDetail`, and spreads the result — so the meter's
  dimensions and the row's claim about them cannot disagree. `sumUsage()` became
  the one place naming the wire's fields (`aiUnits` and `spentDetail` are both
  projections of it), and `meterAiCall` is now a one-line delegate to
  `meterAiCalls([usage])` — one metering path, one answer to "one or many".
  Also: `tokPair(in, out)` joins `fmtTok` in utils (three consumers said the
  same phrase); `summaryFor`'s failure branch uses the `bits` form its
  neighbours use instead of mixing two separator mechanisms; and the **face
  leg's `detail.provider` was renamed `connector`** — it holds a connector id,
  and since the billing legs started stamping `provider` with the AI vendor,
  one JSONB key meant two things across kinds (Stage 4's drill-down joins on
  exactly that).
  **Known shape decision, deferred to Stage 5:** `tokens: {in,out,cache}` and
  `tokensNote`'s "in / out" wording don't extend to `audio_seconds` or
  `images`. The alternative — keying detail by the meter's unit ids and
  rendering from one `unit → {label, format}` map — is the same map Stage 4
  needs for its breakdown labels, so the two decisions should be made together
  rather than forked now. Cost of waiting is one retention window of rows
  (`JOB_LOG_RETENTION_DAYS` default 30) plus a compat read in one renderer.
- **Stage 3 — money.** Deep-dived 2026-08-31 and sliced into three shippable
  pieces. The dive surfaced a layering problem the plan hadn't seen: cost is
  stamped at meter-write time, but rate resolution needs the descriptor
  registry (providers.js), which db.js cannot import without a cycle — and
  passing rates in from call sites would reintroduce the per-site duplication
  `spentDetail` killed. The shape that resolves it:
  ```
  db.js         meter(units, rates)      — mechanism; rates are caller DATA
  pricing.js    ratesFor(provider,model) — rungs + in-memory table, SYNCHRONOUS
  metering.js   meterAiCall(s), spentDetail — moved from db.js; joins the two
  ```
  `ratesFor` answers from a table built at boot and rebuilt on price changes,
  so stamping adds zero round-trips; unknown models go into a *wanted set* for
  3b's fetcher, and rows metered before an answer arrives stay honestly
  unpriced. Verified against the live LiteLLM file: entries carry
  `litellm_provider`, keys are sometimes bare and sometimes prefixed
  (`openrouter/openai/gpt-4-turbo`), costs are dollars-per-token (×1e6 =
  micros); `search_context_cost_per_query` exists for web search. OpenRouter's
  `/models` returns per-model pricing in the listing the picker already
  fetches — the `listPrices` verb's first real customer. Licensing resolves
  via runtime fetch (nothing vendored or redistributed; empty URL disables).
  Decisions: **no retroactive repricing** (write-time stamping, strictly; an
  additive "price unpriced history" admin action is possible later if the
  pain is real); GLM ships without a `priceNamespace` until community
  coverage is verified — unpriced-but-metered beats wrongly-priced.
  - **3a — mechanism + stamping. ✅ DONE (2026-08-31, suite 1267/1267 incl. 7
    new pricing tests).** Migration 0041 (`model_prices`: micros-per-unit
    NUMERIC — numerically the $-per-million a pricing page states; source +
    effective_from in the PK; edits INSERT new effective rows, never update).
    `meter()` gained the `rates = { unit: microsPerUnit, '*': wildcard }`
    parameter — pure arithmetic, cost/priced stamped at write time, rate 0 is
    priced-at-zero (a knowledge claim), no rate is unpriced. pricing.js builds
    the table in ascending rung layers (community < descriptor < provider <
    admin, per-unit overwrite). The anthropic descriptor declares prices for
    its three curated models (verified against current list prices;
    web_searches left unpriced rather than guessed). Boot: `refreshRateTable`
    awaited in server.js's boot sequence after `loadPlugins` — process-wide
    state like `initDb`/`seedAdmin`, not the worker's, since the rate table is
    a singleton and this process also serves the admin price routes. Pinned:
    stamping math incl. rounding, unknown-model blank, on-device $0-known,
    admin rung beats descriptor, a later edit never restamps history,
    future-dated rows wait, the self-hosted trap, descriptor validation, and
    the generic rates param pricing a non-AI unit.

    **The simplification pass reversed one decision and generalized two
    others** — all three the same mistake, *billing facts inferred by agnostic
    code from non-billing signals*:

    - **`onDevice` is no longer read as a price.** It was `if (desc.onDevice)
      → free` inside pricing.js, which fused a billing axis onto the network
      one and left a networked-but-free provider (a plugin pointing at a
      self-hosted Ollama) with no way to say it's free. Now `install()`
      normalizes `onDevice` into an ordinary `prices: { "*": { "*": 0 } }`
      declaration, beside the existing `onDevice ⇒ keyless`. On-device still
      needs no new field; the rating layer now reads only what descriptors
      *say* about prices, never what a provider *is*.
    - **`requests: 0` is declared, not inferred.** metering.js was adding
      known-free requests whenever any rate was known. That is a claim about
      how a vendor bills, made by code that may not know vendors, from
      evidence that doesn't support it — and it was inconsistent inside a
      single descriptor: anthropic.js deliberately leaves `web_searches`
      unpriced "rather than guessed", while the same silence about `requests`
      was read as $0. Now anthropic says `"*": { requests: 0 }` itself, and
      metering.js carries no pricing rules at all. **Consequence for 3b/3c:**
      an admin- or community-priced model meters its requests unpriced unless
      that rung says otherwise — so the LiteLLM importer should write an
      explicit `requests: 0` for chat models (LiteLLM's schema says so; the
      importer is where that vendor knowledge belongs), and 3c's price editor
      should offer per-request as a field.
    - **The model axis got the wildcard the unit axis already had.** A private
      second map held provider-wide rates for the onDevice case only; a stored
      `model='*'` row would have loaded and then never been consulted. Now
      `key(provider, "*")` is an ordinary entry any rung can write, merged
      under the per-model entry — which is what makes both bullets above one
      line each, and gives 3c blanket admin rates for free.

    Also: `requireValidPrices` at the one registry write, beside
    `requireValidImages` — the stakes are higher than any other quirk block,
    since a bad rate is multiplied into `cost_micros` and by design never
    recomputed (a bad image clamp is fixable; a falsified billing record is
    not). `setModelPrice` owns write-then-invalidate so 3b's two learners and
    3c's route can't each forget the rebuild (providers.js's
    invalidate-through-the-owner rule). `meter()` builds one
    `jsonb_to_recordset` row array instead of four index-aligned parallel
    arrays (the file's existing pattern, `updateItemPayloads`). And
    pricing.js's map key held a *literal NUL byte*, which made the whole file
    binary to `git grep` — the new rating layer was invisible to code search.
  - **3b — the learners. ✅ DONE (2026-08-31, suite 1278/1278 incl. 9 new
    learner tests).** `server/price-learner.js` — both fetching rungs in one
    module; rating stays in pricing.js and the learner never answers a rate.
    Pre-build verification pulled the LIVE map (3,408 entries): all four
    namespaces exist (`anthropic`/`openai`/`gemini`/`openrouter`); GLM
    confirmed absent (every glm-* key belongs to an aggregator) so it ships
    namespace-less, as decided; `claude-haiku-4-5` in the map is exactly our
    descriptor's 1/5/0.1 — the ×1e6 identity verified against ground truth;
    `search_context_cost_per_query` is an OBJECT of context sizes, so the
    community rung never prices `web_searches` (picking a size = a guess).
    - **Community fetcher:** rides the worker's hourly maintenance tick;
      gates its own network — pulls when a wanted model is untried or stored
      rows exceed `MODEL_PRICE_REFRESH_DAYS`, and the refresh re-resolves
      wanted ∪ already-community-priced (the drain removes priced models from
      wanted, so without the second half a refresh would update nothing).
      Match under the descriptor's namespace only, bare or `ns/`-prefixed key,
      `litellm_provider` must agree (the trap). `mode:"chat"` → explicit
      `requests: 0` — LiteLLM's own schema claim, declared at the importer
      (the 3a rule). Unchanged rates insert nothing: every `model_prices` row
      stays a real change (the tag-snapshot dedupe principle).
    - **`listPrices` wire verb**, peer of `listModels`: the compat wire reads
      the OPTIONAL `pricing` object off `GET /models` rows (dollars-per-unit
      strings ×1e6; zero kept — free is KNOWN; `-1` variable-pricing dropped);
      no vendor named — vanilla OpenAI has no field and answers null. The
      anthropic wire declares `listPrices: null`. The learner asks only
      CONNECTED providers (an ai_keys row), keyless at the descriptor's base,
      and stores the whole catalog as source='provider' — OpenRouter prices
      ~300 models in one public call, so a newly-picked model is priced from
      its first paid call. (LiteLLM covers only ~100 of them — the provider
      rung sitting above community is why that doesn't matter.)
    - `setModelPrices` (batch, ONE rebuild) joins `setModelPrice` in
      pricing.js; both writers ride the same owner. `modelPriceFreshness`
      (db.js) reads `fetched_at` per source+provider — NULL on admin rows
      keeps hand-typed prices out of "when did we last fetch".
    - Env: `MODEL_PRICE_SOURCE_URL` (default the LiteLLM raw URL; empty
      disables the rung — the air-gapped answer; compose must default it to
      the URL explicitly, since `${VAR:-}` would pass "" = disabled) and
      `MODEL_PRICE_REFRESH_DAYS` (default 7). Nothing vendored — the
      licensing answer holds.
    - Tests: no network — the env knob and descriptor `base` ARE the seams;
      local jsonBoxes serve a hand-written miniature of each schema and the
      whole path runs for real. Pinned: string→micros conversion incl. zero
      and -1, null for a pricing-less listing, air-gap, bare+prefixed match,
      imposter namespace rejected, chat→requests-free, embed-mode not, drain
      + no-repull for map-missing models, weekly refresh of DRAINED models,
      change→one new effective row with history kept, connected-only polling,
      provider-beats-community.
    - `now` is a parameter throughout the learner — tests drive the staleness
      clock instead of resetting module state.

    **The simplification pass caught a wrong price, not a style problem.** The
    build shipped a rule reading LiteLLM's `mode: "chat"` as "this model bills
    tokens, not calls" → `requests: 0`. That is the *same mistake 3a reversed
    twice*, one layer closer to the source: a billing fact inferred from a
    non-billing signal (modality). Checking the live map settled it — LiteLLM
    **declares** `input_cost_per_request`, and all four models that carry it
    are `mode: "chat"` charging **$0.005 per call**. The rule would have
    stamped those $0. Now `input_cost_per_request → requests` is simply
    another `LITELLM_FIELDS` entry and the modality branch is gone; a model
    the map is silent about meters its requests unpriced, which is what the
    remainder column is for. **The rule stands: read what the source
    declares; silence is silence.**

    Also from the pass:
    - **The provider rung was not opt-in, and the trap walked in the other
      door.** `listPrices` hardcoded OpenRouter's `pricing` field names in the
      shared compat wire, so *every* compat descriptor inherited the verb — a
      proxy in front of a self-hosted model, serving an upstream's hosted
      prices, would have been believed. The field map is now
      `compat.priceFields` **descriptor data** (openrouter.js declares it,
      like `stripListPrefix` lives in gemini.js), and a descriptor that
      declares none answers null without a request. Both rungs are now opt-in,
      symmetrically.
    - **The wire answers in the vendor's unit** (`dollarsPerUnit`), not ours.
      A wire translates a vendor's format; the rate map's unit of account is
      the pricing layer's business, so `dollarsToMicros` exists once, in
      price-learner.js, instead of once per rung.
    - **`listPrices` and `listModels` share one fetch + one id normalization**
      (`modelRows`/`modelId`). They had already diverged: `listPrices` skipped
      `stripListPrefix`, so a box that both prefixes and prices would have
      filed rates under ids nothing looks up.
    - **The provider rung asks through a real connection** (`api_key`,
      `base_url`) instead of the descriptor's `base` — which for a
      needs-base provider is only the form's *placeholder*, i.e. a host the
      user never configured. Storage stays provider-keyed (model_prices has no
      connection dimension); only the transport changed. First connection that
      answers wins.
    - **Every restart re-pulled the whole 1.9MB map.** `tried` is per-process
      but `wants` is rebuilt from stored rows, so a fresh process always had
      untried wants and skipped the staleness gate. Being already priced now
      counts as having been tried.
    - **`setModelPrices` was N sequential INSERTs** — 1,140 round-trips for a
      first OpenRouter catalog, inside a maintenance tick. Now one
      `jsonb_to_recordset` INSERT (`addModelPrices`; `addModelPrice` is the
      one-row delegate), the same shape as `meter()`.
    - **The learner is no longer awaited by the maintenance loop**, whose
      stated design is that recovery can't be delayed by slow work — it was
      the one job there making outbound calls (60s map timeout + 30s per
      provider, serially). Providers are now asked concurrently, and a pass
      in flight is tracked so ticks can't stack.
    - `worker.js` grew a fourth hand-rolled `let nextXAt` hourly gate twenty
      lines below the commit that generalized four prune blocks for the same
      reason — now one `hourly(fn)` wrapper.
    - `learnPrices(db, { now, force })` — `force` skips the staleness gates so
      **3c's "refresh prices now" route has somewhere to plug in**; the gates
      pace a background sweep, they shouldn't refuse a person who asked.
    - `jsonBox` promoted to test/helpers.js (it was the third private copy of
      the local-HTTP-stub pattern).
  - **3c — the money shows up. ✅ DONE (2026-08-31, suite 1286/1286 incl. 6
    new tests).** The slice was mostly display-honesty rules; the data had
    been waiting since 3a.
    - **What may be summed:** `cost_micros` is the ONE column that sums
      legally across units (one currency — the point of stamping); the
      unpriced remainder is NOT (tokens + searches is meaningless), so
      `getBoardCost` serves it per unit from a `GROUP BY unit HAVING > 0`
      that bakes in no unit vocabulary — a Stage 5 unit joins for free.
      Booleans stay exempt (the chip's own gate precedent): the admin
      roll-up carries `cost.unpriced` as a flag, per-unit detail is the
      board's endpoint / Stage 4.
    - **$0.00 only when priced:** `getBoardCost` returns null when nothing
      was ever priced — ≈$0.00 out of ignorance would be a claim, not an
      absence. A board that ran free on-device shows its TRUE $0.00 (rate 0
      is priced-at-zero). Pinned both ways.
    - **Gating:** cost rides `/tokens` and the board payload only for
      managers (`canManageBoard` — the board payload reuses the `manage` it
      already resolves; members cost no extra query and get NO cost key —
      absent, not zeroed).
    - **Chip:** the cost folds into the SAME odometer —
      `3.2K / 208 · ≈$0.42` — " · ≈$" renders as static cells exactly like
      " / ", cents roll as spend accrues. Title carries the fine print: "at
      the rates known when each call ran" + per-unit unpriced lines.
    - **Admin cell:** `· ≈$12.40` via `fmtCost`; "some usage unpriced — not
      in the ≈$ figure" in the tooltip; header renamed "AI tokens" → "AI
      usage" (it shows dollars now). `fmtUsd` promoted to utils.js
      (paged-table re-exports so its two importers don't churn); new
      `fmtCost(micros)` owns the ≈ convention.
    - **Admin routes** (requireAdmin; editor UI is Stage 4's tab, as
      recorded): GET /api/admin/prices (stored rungs + the wanted list — what
      the learners know and what they're hunting), PUT (validated like
      requireValidPrices — zero legal, junk 400 — through `setModelPrice`, so
      the rate is live without a restart), POST /refresh
      (`learnPrices({force})`; the learner now RETURNS its learned count —
      null means the pass broke → 502 — because a person who clicked deserves
      the difference between "nothing new" and "it broke").
    - Deliberately absent: DELETE for admin rows (effective-dated model —
      supersede, don't retract; revisit if real), per-day cost in the
      sparkline (Stage 4's breakdown).

    **The simplification pass caught the Stage 0 revert returning in a new
    spelling** — and fixing it properly required the registry this plan kept
    deferring. The chip rendered the unpriced remainder as
    `unit.replace(/_/g, " ")` + `fmtTok`: a client inventing English from
    server ids AND applying a *token* formatter to every unit. Stage 5's
    `audio_seconds` would have read "1.2M audio seconds"; `requests: 1`
    already read "1 requests". Stage 0 shipped a prose capability list in a
    client attribute and Stage 1 reverted it for exactly this reason — a
    client statement about a growing server-side vocabulary cannot be kept
    true. So **`server/units.js` exists now**: `UNIT_DEFS` ({label, format}),
    `describeUnit` (an UNDECLARED unit still renders, falling back to its id —
    a plugin may meter anything), and `validRate`. Pure data + predicates, no
    imports — the `capabilities.js` pattern, chosen so db.js, providers.js,
    pricing.js and the learner can all read it without a cycle. The root cause
    it fixes: a unit id was spelled in five places and NAMED nowhere, so when
    a surface needed a label there was nowhere to get one. `format` is a
    display KIND (paged-table's column trick) — the server never knows what a
    token looks like on screen.

    Also from the pass:
    - **`cost.unpriced` was two types under one name** — a boolean at roll-up
      grade, a map at board grade, both truthy, both silently wrong if crossed
      (`{}` is truthy; `Object.entries(true)` is `[]`). Now ONE shape
      everywhere: a labelled per-unit array, which the roll-up builds from a
      `jsonb_object_agg … FILTER` inside the `GROUP BY` it was already
      running. One renderer reads either grade; Stage 4 inherits one contract.
    - **Three queries became one.** `getBoardTokenTotals` + `getBoardCost`'s
      two legs were three `WHERE board_id=$1` scans of the same five heap
      pages (measured: `shared hit=5` each). `boardUsageSummary` answers all
      of it in one `GROUP BY unit` — which also removes the last unit
      vocabulary from SQL (the three named buckets are a display choice, made
      in JS). The polled `/tokens` route returns to its **pre-slice** cost
      while carrying the new payload (2.43ms → ~1.5ms admin, 3.07 → ~2.2
      manager), and the manager check now runs *concurrently* rather than
      gating a second read: the gate is a disclosure rule, not a computation
      one, and a member still pays exactly one query.
    - **"A rate is a non-negative finite number" existed in four places.** Now
      `validRate` in units.js, held by the descriptor validator, both
      learners, and the admin route — and **enforced at `setModelPrices`**,
      the choke point every rung already funnels through, so a fifth rung
      cannot skip it. Pinned by a test that writes NaN/-3 straight at the
      write.
    - **`fmtCost`'s `≈` is now conditional.** The server reports whether a
      figure is incomplete (`unpriced`), so hedging a complete number was the
      renderer asserting what it wasn't told — the mirror of the ≈$0.00
      refusal this stage is built on. Same fix put the remainder phrase in one
      place (`fmtUnpriced`) instead of two surfaces telling two stories about
      one glyph.
    - `loadModelPrices` was db.js's only reader handing back a raw pg NUMERIC
      string; coerced at the source, deleting a copy in pricing.js and one in
      the route. The `fmtUsd` re-export shim in paged-table.js was dropped —
      both importers already imported from utils.js, so one function had two
      names for no gain.
    - **Noted, not fixed:** `GET /api/admin/prices` answers the *storage*, not
      the resolved rate map — it omits the descriptor rung and the effective
      rate, so Stage 4's editor ("your typed rate overrides the community's")
      will want a `priceState(db)` in pricing.js instead. Also `boardAiUsage`
      still hand-enumerates five `qty()` pivots while its `≈$` sums every
      unit, so a Stage 5 unit will land in the dollars and not the tokens
      under a header claiming completeness — the unit registry now exists to
      fix that when Stage 4 touches the reader. And PUT is body-shaped, not
      `/:provider/:model` as this doc's API section says: model ids contain
      slashes (`openrouter/openai/gpt-4-turbo`), so the body form is correct
      and the API section is what's stale.
- **Stage 4 — the Usage tab.** Sliced 4a (vocabulary + reader), 4b (the tab),
  4c (price editor UI + drill-down).
  - **4a — vocabulary + reader. ✅ DONE (2026-08-31, suite 1296/1296 incl. 9
    new tests).** The prerequisite turned out half-built: `CAPABILITY_DEFS`
    already carried labels, so the promotion was *fill the gap*, not invent —
    `KIND_DEFS` next to it in capabilities.js (pill order, pure data): every
    job-log kind with its display label and **the capability its paid legs
    meter as** (`retag → tag` — the fact the drill-down join has nothing else
    to hold; `null` = spends nothing itself). Kind labels stay the WORK's
    names, deliberately distinct from capability feature names where they
    differ ("Embedding" the job vs "Semantic search" the card) — the id is the
    join, each surface speaks its own language. `capabilityLabel(id)` resolves
    kind-label → capability-label → id for breakdowns (diagnose isn't in
    CAPABILITY_DEFS; detect has no kind — both covered). The /jobs response
    now serves `kinds`, jobs-modal's hardcoded `KIND_LABELS` is DELETED, and
    the modal renders what it is handed (an unnamed kind degrades to its id).
    `usageRows` (db.js): group by any subset of `{day, board, capability,
    provider, model}` (allowlist-mapped columns — what makes the interpolation
    safe; the route 400s the rest), always grouped by unit underneath, folded
    to `{...dims, units: {unit: {quantity, priced_quantity, cost_micros}}}`.
    `GET /api/usage` (admin) + `GET /api/boards/:id/usage`
    (requireBoardManager; the route's board pins the scope — a `?board=` spoof
    changes nothing). Responses are SELF-DESCRIBING: `units` via
    `describeUnit`, `kinds`, `capabilities`, `providers`, `boards` (with the
    `''` sentinel named "outside any board" at the source). **The headline
    needs no special API**: the ungrouped read is one row of folded units, and
    the KPIs are client arithmetic on named buckets it already knows.
    **The simplification pass caught the same mistake one level up.**
    Mechanism 3 promises three things — the units, their labels, and **which
    breakdowns exist** — and 4a shipped two. `USAGE_DIMS` existed only to
    *reject* bad input and was never served, so 4b's group-by control would
    have hardcoded `["day","board","capability","provider","model"]`: exactly
    the prose-capability-list (Stage 0) and unit-id-transform (3c) mistake,
    at the dimension level. The house already had the answer written down —
    `browseFilters`: *"the ONE resolver: the filters route renders from it and
    the browse route whitelists against it, so what the client can offer and
    what the server will accept are the same list by construction."* So
    `USAGE_DIMS` entries gained labels and the response now serves `dims`
    (every dimension with its label; `values` only for the ones grouped, each
    id with its name). A Stage 5 dimension appears in the picker with no
    client edit.
    - **Five hand-built label maps became one rule.** `providers` /
      `capabilities` / `boards` were three accumulation loops in two shapes
      with three degradation policies — an unknown provider was *dropped*
      while unknown capabilities and boards degraded to their id, contradicting
      the comment two lines below. Now one `values()` helper and one policy
      (an id with no name renders as itself), under `dims`.
    - **The `''` sentinel is declared at its source.** `APP_SCOPE` +
      `APP_SCOPE_LABEL` beside `meter()`, which stamps it — the reader was
      naming a schema fact it doesn't own, and `?board=` collapsed `''` to
      null, so the row labelled "outside any board" was the one row nobody
      could filter to. It is a value now, not an absence.
    - **The read is windowed by default** (30 days, echoed in the response).
      Measured unbounded at max grain over a year of plausible data: **950 ms
      in Postgres with a 24 MB hash spill, a 21.8 MB body, 287 MB RSS** —
      grouping collapses only the unit axis, so it bounds nothing, and the
      meter keeps forever. A default window is 54 ms / 1.9 MB. A default, not
      a law: `from=` reaches back as far as asked.
    - **One vocabulary, one wire shape.** `/jobs` projected `{id,label}` while
      `/api/usage` shipped raw `KIND_DEFS` including the internal `capability`
      join column — two shapes of one vocabulary in one commit. Now
      `kindList()` serves both, and `kinds` left the usage response entirely
      (nothing read it; 4c adds it back when the drill-down needs it).
    - `boardUsageSummary` was `usageRows(db, {board})` spelled a second time
      50 lines away — it calls it now, so a Stage 5 unit lands once.
      `capabilityLabel` linear-scanned past the `CAPABILITY` by-id index its
      own file exports. The `{status, body}` envelope both routes unpacked is
      gone: the app's `err.status` channel already does this
      (capability-bind/probe's idiom). Scope no longer defaults — the caller
      states the board out loud, so a third route can't forget it into "every
      board". The test's raw `UPDATE board_members` became `setBoardMembers`.
    - **Dropped a test that couldn't fail on the wrong action**: a literal
      list of the nine kind ids only breaks when someone *correctly* updates
      the table and stays silent when a call site adds a kind and forgets it.
      Replaced with the real properties (unique ids, every kind labelled, the
      `retag → tag` link, `ingest → null`).
    - **Recorded, not fixed:** `KIND_DEFS.capability` is still a *restatement*
      of what meter call sites assert, not their source — nothing derives one
      from the other, so 4c should either have spenders read it (`meterAs`) or
      ship a drift pin before the drill-down joins on it.
  - **4b — the tab. ✅ DONE (2026-08-31, suite 1297/1297 — no new tests: the
    slice is DOM-only, the server contract is pinned by the 4a suite, and no
    admin tab has a DOM rig).** The rail gained `Usage` (the coin — the token
    chip's glyph), `TAB_NAMES` gained the entry, and public/admin-usage.js
    renders it. **Four windowed reads** (`group=day`, `provider,model`,
    `board`, `capability`) — no fifth for the strip, because summing the day
    series per unit is the one legal arithmetic and the chart holds it anyway.
    Headline: spend via `fmtCost` (the client folds units into the same
    `{micros, unpriced[]}` object the board endpoints ship, so the conditional
    `≈` and the null-when-never-priced rule come free), calls under the served
    `requests` label, `tokPair` volume, cache-hit rate and blended $/M (micros
    ÷ in+out tokens IS $/M) — the ratios show only when their inputs exist,
    and the blend inherits the `≈`. Day chart + breakdown tables under
    served-vocabulary headings (`dims.*.label`); window picker 14/30/90/all
    (all = an explicit epoch floor, since an absent `from` MEANS the default).
    - **The breakdown columns are the unit vocabulary.** One column per unit
      in the response, label + format kind from `units` — a Stage 5 unit lands
      as a labelled column with no client edit, where a hand-picked bucket
      list would have re-created the Boards-cell completeness gap on a brand
      new surface.
    - **The sparkline is a component now** (public/sparkline.js): caller
      supplies `value`/`title`/size, rows only need the `day` key; the Boards
      cell swapped its inline copy for the import at identical size. One real
      fix in the promotion: the scale maxes over the days DRAWN, so an
      all-time series can't let an off-screen spike flatten the visible bars.
    - **Two promotions the second wearer forced**: `.plugin-filters` →
      `.pill-row` (admin.html's inlined pill look, now worn by both filter
      rows), and profile.html's `.panel .section + .section` stacking gap
      moved into panel.css (the usage tab is the second page to stack
      sections in a panel). `fmtQty(n, format)` split out of `fmtUnpriced` so
      table cells and phrases format served quantities through one map.
    - Still queued for whichever slice touches the reader: `boardAiUsage`'s
      five hand-enumerated pivots vs its all-unit `≈$` (units.js exists to
      reconcile).
  - **4c — the closers. ✅ DONE (2026-08-31, suite 1299/1299, +2).**
    - **`priceState(db)`** (pricing.js): the resolved rate map WITH per-unit
      provenance — refactored so ONE `resolveAll` walk feeds both the rate
      table and the editor, which is the property that matters: the editor
      cannot show a rate stamping would not use. `GET /api/admin/prices` now
      answers `{ models, wanted, freshness, units }` — resolved pairs with
      `{ micros, source }` per unit (the descriptor rung finally visible; it
      is runtime data and was never stored), `modelPriceFreshness` (computed
      since 3b, served to nobody until now), and the unit vocabulary as the
      REGISTRY ∪ resolved — an editor declares new facts, so its list can't
      be limited to old ones.
    - **The Prices section** (admin-usage.js, bottom of the Usage tab): one
      element built once and re-attached by every draw() — rates aren't
      windowed, so a window click must not refetch them; it also survives the
      empty-window state, where seeding rates matters most. Freshness line +
      "refresh prices" on the force route (toasts the learned count, surfaces
      the 502); the wanted list; a filtered table (a provider-rung catalog is
      hundreds of rows — a filter beats pagination) with click-to-edit cells;
      a set-price form whose unit select is the full served registry. Every
      rate displays and edits in its unit's own $ frame decided by the SERVED
      format kind: tokens as $/M (micros-per-unit ≡ $/M, the number passes
      through), counts as $ each (×1e6, toPrecision-guarded). Known
      limitation, accepted: no un-override — storage is effective-dated
      INSERT-only, so an admin row wins until a new row replaces it; a
      tombstone can come later if it ever hurts.
    - **The drill-down**: the gallery grew its first hash handler — `#jobs`
      (or `#jobs/<kind>`) at the end of boot opens the board's jobs modal and
      is consumed like `?item=`. `openJobsModal({ kind })` preselects the
      history filter, seeding its own pill so a kind with no history still
      leaves a way back to All. The Usage tab's board rows carry the link
      (`/?board=<id>#jobs`) next to the board name — the modal, where every
      row already shows what it spent, IS the job viewer; no admin copy.
    - **The `meterAs` debt, paid at a better altitude than planned.** The
      dive proposed three call-site edits; the build put the derivation in
      metering.js's `meterAiCalls` instead — the one join EVERY spender rides
      — so `dims.capability` is now "the work's id as the spender holds it"
      (kind or capability), mapped through `meterAs(kind)` (capabilities.js:
      KIND_DEFS lookup, unknown/null degrades to the id itself, nothing
      blocked). Call sites unchanged; a fourth spender can't forget the
      vocabulary; KIND_DEFS.capability is live data now, not a parallel
      claim. (The 4a open item closes.)
    - **Rider:** the '' provider is a NAMED sentinel now — `UNATTRIBUTED_LABEL`
      declared beside `meter()` (db.js, next to APP_SCOPE_LABEL), served by
      the usage NAMERS: the pre-meter backfill renders "unattributed" instead
      of the bare dash that prompted the question. The '' MODEL deliberately
      stays blank — under a named provider, "OpenAI · unattributed" would
      read as a claim.
    - **The simplification pass found the recurring mistake WEARING A NEW
      COAT — and this time it could falsify a billing record.** units.js says
      of `format`: *"a display KIND, not a formatter… the server never knows
      what a token looks like on screen"*, and it describes a QUANTITY (it
      feeds `fmtQty`). The editor read it to decide how a RATE is framed, and
      therefore **what number an admin's typed "3" is multiplied by on its way
      into `micros_per_unit`** — a display kind deciding a billing fact,
      restated six times across the client. The failure it opens is the exact
      one units.js calls unfixable: a rate 1e6 out passes `validRate` (1e6 ×
      valid is still valid), stamps into `cost_micros`, and is never
      recomputed. Fixed by declaring it: `UNIT_DEFS[u].rate = { per, label }`
      (PER_MILLION / EACH), shipped by `describeUnit`, with the client left
      holding only arithmetic — `$ = micros × per / 1e6`. Undeclared units
      degrade to per-each, the only frame that needs no agreement with a
      vendor to be true. Verified round-trip against real vendor prices
      (Sonnet 3/15/0.3 $/M, Perplexity $0.005/call).
      - **Same lesson, third level:** `describeUnit` is spread into the
        unpriced remainder, which would have carried a rate frame into a
        statement about quantities. `unpricedList` now names the two fields
        it means.
      - **The sentinel namer was a special case that had already grown a
        second copy** — and the two disagreed (board compared `APP_SCOPE`,
        provider a bare `""`). `USAGE_DIMS` carries `emptyLabel` now, so the
        axis owns what its own '' means and `usageResponse` applies one rule;
        `model` declaring none is how its deliberate blank falls out of the
        same rule. server.js stopped importing the labels at all.
      - **`unitList`/`unitVocabulary` in units.js**, the `kindList` rule
        applied to units: a reader passes the units its rows used, an editor
        asks for the registry ∪ resolved, and no route reaches into
        `UNIT_DEFS`. One vocabulary in the price table too — every served
        unit gets a column, since narrowing to already-priced units hid the
        empty cell that IS how you price one.
      - **Reuse the pass found:** `busy()` (plugin-modal), `fillSelect` with a
        placeholder (select.js — the unit picker had been committing exactly
        the implied-choice error that module exists to prevent), and
        `relTime` **promoted to utils.js**, collapsing five character-identical
        private copies plus the sixth this slice nearly added under a new name.
      - **Efficiency:** the filter hides rows instead of rebuilding the table
        (a 350-model catalog was ~2,100 elements + 1,400 `innerHTML` parses
        per keystroke — the cost scaled with exactly the size the filter
        exists for), one delegated click listener replaces ~1,400 retained
        closures, and the two independent reads behind `GET /api/admin/prices`
        now run concurrently (the pair `learnPrices` already runs that way).
      - **The deep link is bound to the ADDRESS, not to page load**
        (`hashchange`, the admin-capabilities arrangement): a hash changes
        without a navigation, so the boot-only read worked purely by grace of
        the one link that opens a new tab.
      - **Skipped:** having `PUT` answer with the `priceState` payload
        `refreshRateTable` already built (saves a round trip and a walk per
        edit, but trades "write, then read the truth" for a fatter write
        response, on a path a human paces by typing); and `?jobs=` over
        `#jobs` (a hash is right for modal state, and binding to `hashchange`
        settles the objection).
- **Stage 5 — meter the rest.** Sliced by the 2026-08-31 dive: 5a embeddings,
  5b audio seconds (+ the reader reconciliation — first unit the readers can't
  show), 5c detection images, 5d connector quota burn (provider-level floor:
  quota is a provider-global resource, board attribution deliberately
  deferred), 5e storage DROPPED (bytes ingested is a flow; the question people
  ask — bytes held — is a level an additive meter can't answer; shipping the
  flow would look like an answer to the level question without being one).
  - **5a — embeddings. ✅ DONE (2026-08-31, suite 1303/1303, +4).** The
    "two-line fix" had an attribution hole: the sweep's pull is app-wide, so
    one paid batch call could span boards while the wire answers ONE usage
    total — and splitting it would be apportionment, which the meter never
    does. So `embedBatch` (worker.js) now groups rows by board and makes one
    wire call per group — attribution exact by construction, an extra HTTP
    call only when a pull genuinely mixes boards; the sweep (`embedDue`) is
    untouched. Group and salvage paths both meter: the group call before the
    landing (the tag leg's rule), the salvage round as one write whose
    `requests` counts the calls that ANSWERED — a failed call reported no
    usage and nothing is invented for it. The query embed (`/api/search`)
    meters to the board being searched; the admin probe's ping meters at the
    app scope (a probe is a paid call too — it was invisible). The local
    embedder meters `requests` at its on-device rate 0 — true $0.00, volume
    visible. No new units; `meterAs("embed")` was already live; the tag probe
    stays unmetered because `testKey` is a listing, not a paid call.
    Deliberately unfixed: transcribe/detect probes call their ENGINES
    directly, so their probe spend stays invisible until 5b/5c meter at the
    engine layer or the legs.
  - **5b — audio seconds + the reader reconciliation. ✅ DONE (2026-08-31,
    suite 1305/1305, +2).** `UNIT_DEFS.audio_seconds` `{ label: "audio",
    format: "duration", rate: PER_MINUTE { per: 60, label: "$/min" } }` —
    stored micros-per-second, displayed per minute (whisper-1: 100 micros/s →
    the published $0.006/min); client `UNIT_FORMAT` gains `duration →
    fmtDuration`, so the price editor and every breakdown grew their audio
    column/rows with zero client edits. The quantity is the clip's own
    measured duration (`payload.files[0].meta.duration`, stamped at ingest by
    the audio source) — metered at the transcribe leg, engine-agnostic, so
    the on-device sidecar shows true-$0 volume per board (asserted:
    `boardUsageSummary.cost = { micros: 0, unpriced: [] }`); a clip with no
    measured duration meters its call and nothing else. Dims are read AFTER
    the call so the sidecar's self-reported model (a getter, null until the
    first done payload) names what actually ran. `LITELLM_FIELDS +=
    input_cost_per_second → audio_seconds` (NOT output_cost_per_second —
    that prices GENERATED media); compat.transcribe reads `data.usage` when
    the vendor reports tokens (gpt-4o-transcribe does; whisper-1 doesn't; no
    live model prices both, so nothing double-counts) and the keyed engine
    wrapper passes it through. metering.js grew `meterSpend(db, boardId,
    dims, units)` — the bare join — with `meterAiCalls` now a projection over
    it; the transcribe PROBE meters at the app scope (half of 5a's recorded
    gap closed; the detect probe waits for 5c). The transcribe job row states
    `seconds` beside its kind facts and `tokens` via the spentDetail
    projection — the modal renders both with its existing readers.
    - **Readers reconciled**: `boardAiUsage`'s all-time half is a UNITS MAP
      (the day/today pivots stay — they feed the sparkline, a display
      projection); `/api/admin/boards` reshaped from a bare array to
      `{ boards, units }` with the vocabulary riding beside the data (three
      tests read the old array; updated); the cell reads its FEATURED buckets
      from the map — a display choice, the chip's BUCKET precedent — and
      appends anything outside them ("· 1h 30m audio") labelled from the
      served vocabulary. The completeness gap the plan queued in Stage 3 is
      closed.
    - **A latent 4a bug surfaced and fixed**: `jsonb_object_agg` keeps the
      LAST value for a duplicate key, and the meter stores one row per
      attribution — so the unpriced map (and the new units map, which is how
      it was caught) silently REPLACED a unit's tag spend with its diagnose
      spend instead of summing. Both aggregates now ride a per-(board, unit)
      subquery.
    - **`transcribeOne` extracted from the poll loop** (behavior-preserving;
      the loop keeps its lane state and reads the returned action) so the
      integration test runs the real path — stubbed sidecar protocol,
      measured duration on the file entry, meter + cost + job-detail
      assertions — without racing a poll tick. `foldJobRepeat` hoisted to
      module scope on the way (it was closure-bound to startWorker while its
      users now straddle levels).
    - **The simplification pass finished the reconciliation 5b only
      half-did — and the half left undone was hiding real money.**
      `boardUsageSummary` still pivoted to `{input, output, cache_read}`
      while its own comment claimed "a Stage 5 unit joins the cost and the
      remainder with no edit here". Both halves were true and that was the
      problem: audio joined the COST but was unrepresentable in the figure
      beside it, and the chip gates on `input + output > 0` — so **a board
      whose only spend was transcription showed no spend chip at all**,
      dollars included, while the admin table for the same board showed
      "1h 30m audio · $0.02". Two surfaces disagreeing about whether a board
      had usage. Now `boardUsageSummary` answers a units map, `/api/boards/:id`
      and `/tokens` ship `unitDefs` beside it, and the chip leads with tokens
      when there are any and with whatever else was spent when there aren't.
      The `days`/`today` pivots went too — `admin-usage.js` already drives the
      SAME sparkline component off units maps, so "the day rows are a display
      projection" was an argument for projecting in the CALLBACK, which is
      where it happens now.
    - **Both board readers now ride `usageRows`** — `boardAiUsage`'s
      hand-written SQL (including the subquery that the duplicate-key bug
      forced) is gone, and the spend fold both readers duplicated is one
      `costOf`. The reader that hand-rolled its own aggregate is exactly the
      one that had the bug.
    - **`FEATURED` became a RECORDED set, not a restated one**: `q()` remembers
      which units the cell already spoke about, so the appendix is
      "everything I haven't mentioned" rather than a five-id list kept in
      lockstep with the markup above it. Delete a phrase and its unit rejoins
      the appendix instead of vanishing.
    - **Reuse**: the transcribe probe and the transcribe leg both stopped
      re-spelling the wire→units mapping (`callUnits` exported from
      metering.js — `sumUsage` is meant to be the ONE place naming the wire's
      fields, and 5b had made it three); the duration read goes through
      `projectEntry`, the module that DECLARES what a file's metadata says,
      rather than a second reach into the payload bag; `fmtUnit`/`unitDefs`
      promoted to utils.js (the "N label" phrase was written in three files);
      `fmtQty(d.seconds, "duration")` in the modal instead of a second
      seconds→ms conversion added the same day.
    - **`transcribeOne(…, retry)` lost its `= new Map()` default** — a
      throwaway ledger silently disables both the attempt cap and the
      per-clip backoff it exists for.
    - **Skipped**: promoting the `openJobLog` running-row idiom (2 sites, one
      of them pre-existing ingest code) and the sidecar fetch stubs into
      `test/helpers.js` (8 pre-existing hand-rolled variants would have to
      move with them) — both well outside this diff.
  - **5c — detection images. ✅ DONE (2026-08-31, suite 1309/1309, +3).**
    `UNIT_DEFS.images` `{ label:
    "images", format: "count", rate: EACH }`; `LITELLM_FIELDS +=
    input_cost_per_image` — **reverted by the pass below, and the entry is left
    standing here because the field looks exactly like the peer of
    input_cost_per_second and the next reader will want to know why it isn't**
    (118 models carry it live — verified against the map,
    dollars per image SENT, so `dollarsToMicros` applies unchanged). Metered at
    the extract leg's detect call and at the probe, `{ requests: 1, images: 1 }`
    plus whatever the engine reported, capability `detect` — CAPABILITY_DEFS
    already labels it, `unitVocabulary()` already feeds the price editor, and
    `count` already formats, so nothing downstream needed a line. localDetector
    is onDevice → install() normalizes it to a provider-wide $0, which makes
    "4,213 detections · $0.00" a KNOWN zero rather than an absence. Closes the
    last probe still spending in the dark (5a's remainder).
    - **`output_cost_per_image` is deliberately unmapped**, the same trap as
      5b's `output_cost_per_second` one word over: it prices images GENERATED,
      not handed in. The live map carries MORE of the output fields than the
      input ones in both pairs (104 vs 90 seconds; 199 vs 118 images), so the
      wrong pick is easy and silent — and cost_micros is never recomputed.
      Stated once in price-learner.js now that the rule has fired twice.
      `input_cost_per_pixel` / `input_cost_per_image_token` are the same money
      quantized differently and need dimensions the map doesn't state: skipped.
    - **`wire.detect` gained a usage channel** — beyond the line above, and the
      finding that made 5c worth more than a unit id. Every other capability's
      wire answers `{ result, usage }`; detect answered a bare array. That
      matters here more than anywhere because detection is the ONE capability
      with **no built-in wire** — the only shipping detector is the on-device
      sidecar, so every paid detector arrives as a plugin, and a plugin backed
      by a vision model bills in TOKENS. Without the channel its token spend
      could only ever meter as the image we know we sent: invisible money, the
      exact failure this arc exists to prevent, in the one place where the wire
      contract IS the entire paid surface. Now `{ objects, usage }`, read
      tolerantly (`usage || {}`) like transcribe's; the sidecar answers
      `usage: {}` because keyless and on-device has nothing to declare, and
      silence is silence.
    - **The job row stopped lying.** A detect-only board stamped the literal
      string `"detection"` into the job detail's **model** slot — a placeholder
      standing where a model name goes, while `resolveDetector` had returned the
      real `{ id, model }` four lines up. `spent ??= spentDetail(detectDims, …)`
      now names the engine that actually ran. `??=` because the extractor
      spends first when both legs run: one fragment names one engine, and the
      meter has both regardless. When nothing was called at all (detect fields
      on a non-image item) the row now says nothing rather than naming an
      engine that never ran — absent, not empty, the house rule.
    - **Not apportioned, not inferred**: many queries ride ONE detector pass, so
      the image is the quantity and the query is not. `images: 1` is the call
      site declaring what it handed over, the same class of fact as
      `requests: usages.length` — not agnostic code reading a billing model off
      a non-billing signal.
    - The probe meters against `d.model`, NOT the live `/health` model it
      resolves for the toast: the extract leg has no cheap way to ask /health
      per item, and the rate table is keyed on (provider, model), so recording
      the other spelling would split one engine across two rows that price
      separately.
  - **5c SIMPLIFICATION PASS (suite 1309, net ±0; rebuilt, health 200).**
    - **`input_cost_per_image` TAKEN BACK OUT — the pass reversed a decision
      the dive got wrong.** The field looks like the exact peer of
      `input_cost_per_second`, and 5b's safety argument was "no live model
      prices both seconds AND tokens, so nothing double-counts". Measured for
      images: 118 models carry it, **48 alongside a non-zero token price**, and
      of those the 6 that are `mode: "chat"` — the class a vision-model
      detector lands in — are all OpenRouter/Anthropic, where the per-image
      figure **restates the token price**: 1600 image-tokens × $3/M = exactly
      the published $0.0048. (The Opus rows carry the same $0.0048 against a 5×
      higher token rate, so the map's own number isn't self-consistent there
      either.) Metering the image AND the tokens that already contain it bills
      the same money twice into a `cost_micros` nothing recomputes. The other
      42 are embedding and image-generation models where the price IS additive
      — but this app meters `images` on neither path, so importing it there is
      a rate nothing can multiply. No model left where reading it is both safe
      and useful. The narrow fix (skip when a token price exists) is wrong for
      multimodal embedders, and the `mode`-based fix is the inference
      price-learner.js already forbids — **that the only available filters were
      both illegal is the tell that the field, not the filter, was the
      problem.** `openrouter.js` had reached the same verdict from the other
      direction about the same money ("a rate we can't attribute is noise") and
      Stage 5c was the stage that was supposed to change that; it doesn't. The
      `images` UNIT is untouched: the quantity is recorded, and the admin and
      descriptor rungs price it when someone actually knows the rate. The
      fixture now pins the non-import rather than avoiding the live shape.
    - **`{ ...callUnits([usage]), <unit>: n }` had become the third copy of one
      shape** (transcribe leg, detect leg, detect probe) — and worker.js's own
      rule says "the third copy of a shape is where the shape should have
      become a mechanism". `meterAiCall(db, scope, dims, usage, extra)` now
      carries what the SPENDER spent beside what the wire reported, so a leg no
      longer names the wire's fields a second time to add one unit of its own.
      **`callUnits` went back to private** — it was exported by the 5b pass for
      exactly this duplication, and the better mechanism retires the reason.
    - **`|| {}` and `usage ? [usage] : []` were no-ops** at all four sites
      (verified: `sumUsage` reads `Number(u?.input) || 0`, and `spentDetail`
      over `[undefined]` and `[]` are indistinguishable). Removed — a guard
      that implies a distinction there isn't is how the next leg copies a
      fifth.
    - **A pre-5c plugin's bare `wire.detect` array is normalized at the
      dispatcher**, the way `install()` already normalizes the three legacy
      capability-DECLARATION shapes. Without it the old shape does not fail
      loudly: `objects` destructures to undefined, `demux.route()` reads it as
      `|| []`, and the item lands "No objects detected" **while the meter bills
      the image**. A silent wrong answer on a paid path, in the change whose
      own premise is that every paid detector arrives as a plugin.
    - **`meterTotals` was the last reader spelling the meter's aggregate out by
      hand** — it rides `usageRows` now, and answers `units` beside the named
      aliases so a new unit needs no edit. It had already paid twice (5b added
      `audio`, 5c `images`), which is exactly what db.js warns about above
      `boardUsageSummary`. Rider: the old `MIN(provider), MIN(model)` could
      name a pair that never appeared together.
    - `until()` promoted to `test/helpers.js` (nine files hand-roll it; the new
      test is the first caller rather than the tenth copy). The `extractOne`
      doc comment named a `model` key the arc had replaced with `spent, image`.
      The "same shape audio.test.js drives transcribeOne with" comment was
      wrong — audio.test.js calls `transcribeOne` directly, and the reason the
      detect test can't is worth saying instead.
    - **A test deleted for testing nothing under review**: the priced-detector
      test built its units object by hand and would have passed with
      `images: 1` removed from the leg. Its coverage is already at
      metering.test.js (generic non-token rating) and token-totals.test.js
      (remainder shape). Replaced with the legacy-plugin normalization above.
    - **Rejected — `images` should be declared by the ENGINE, not the leg.**
      The argument was that the leg asserts a billing model it can't know.
      It conflates consumed with billed: `images: 1` is a QUANTITY, exactly
      like `requests: 1`, which every call meters whether or not its provider
      bills per request. The rate decides billing, and the unpriced remainder
      is the honest answer when there is none. Also transcribe couldn't follow
      — its `audio_seconds` comes from `projectEntry`, a fact about the stored
      entry that an engine handed a raw buffer does not have.
    - **Skipped**: hoisting `extractOne` out of `startWorker` (the test would
      lose its worker and its poll, but it is a large refactor of pre-existing
      code); migrating the nine `until` copies; `local.js`'s `{ input: 0 }`
      spelling of "nothing to declare" (whisper omits the key, the sidecar
      answers `{}` — three engines, three answers, and only the third is in
      this diff).
  - **5d — connector quota burn. ✅ DONE (2026-08-31, suite 1312/1312, +3).**
    Metered inside `paceFor` (connectors/runtime.js) — the one place BOTH
    pacing modes reach, since `callProvider`'s legacy pre-acquire and the
    `ctx.pace()` a `pacesRequests` provider awaits per raw fetch are the same
    function. A granted token IS a request about to be sent, so counting there
    counts requests SENT (retried and refused included), which is what a quota
    actually charges for; anywhere later would count answers. `db` threaded
    through `paceFor` / `callProvider` / `ctxFor` / `warmIds` (the house style
    — connectors/index.js already says "db is threaded through as the first
    argument"), plus 9 test call sites.
    - **`api_requests` is its own UNIT, not `requests` under a different
      label** — the user's call, and it is the structurally right one. A label
      would have separated them on ONE surface while every total silently
      merged them, and keeping them apart would then have cost a
      capability filter at each reader. Units never sum across each other, so
      one registry entry does it everywhere, permanently, with no reader
      remembering. It is also the honest reading: `requests` counts paid calls
      that ANSWERED, `api_requests` counts requests SENT. Adding those two
      produces a number that means neither.
    - **Board attribution is refused, not deferred, and the plan's old reason
      was the weak one.** "Quota is provider-global" is true but not decisive —
      `refresh` and `produceFace` both have the board row in hand. The
      decisive one is `prefetch`: it batches up to 100 ids that span boards
      into ONE request, on purpose, and splitting that request between them is
      apportionment. Stage 5a could partition the embed sweep per board
      because splitting the batch cost nothing; splitting this one destroys the
      reason it exists. So no row claims a board rather than some rows
      claiming one.
    - **Volume worry dissolved**: a token is what the bucket hands out at
      rpm/min, so one write per token is bounded by the provider's own rate
      limit (default 30/min) rather than by how hard a sweep pushes. The meter
      cannot outrun the thing it meters.
    - `capability: "api"`, labelled **"API"** from a small `WORK_LABELS` table
      in capabilities.js rather than a CAPABILITY_DEFS entry: that table means
      "something a provider can be bound to serve" — every entry needs a wire
      verb, a binding and a floor, and the cleanup loops iterate it, so an
      entry with none of those would be a permanent exception in each. That is
      exactly how `detect` came to be missed by both of them.
    - The usage namer's `provider` axis now consults the connector registry
      after the AI one (the planned one line). Two plugin-extensible registries
      share the axis, so a name collision is possible in principle; the cost is
      a wrong LABEL on a row whose numbers are right, and namespacing the
      stored id would give one family a spelling the other doesn't have.
    - Headline strip: `requests` and `api_requests` are two KPIs side by side,
      built by one small loop rather than a second copy of the block. The
      existing "calls" figure keeps meaning exactly what it meant.
    - **Known limit, pinned by a test rather than left to be discovered**:
      legacy (non-`pacesRequests`) pacing pre-acquires ONE token per logical
      call, so a retried attempt rides free and a fan-out pays once. That is
      the pre-existing property `pacesRequests` was introduced to fix, and all
      three built-in providers declare it; only a plugin that doesn't would
      undercount. **Superseded by the pass below — the retry half was not a
      limit worth pinning, it was a hole.**
  - **5d SIMPLIFICATION PASS (suite 1312, net ±0; rebuilt, health 200).**
    - **The legacy retry was UNPACED, not just unmetered — and metering is what
      exposed it.** `callProvider` acquired its token OUTSIDE `withRetry`, so a
      retried attempt re-sent having spent nothing. Worse: `throttled()` halves
      the bucket on a 429 precisely so the next request waits, but with no
      acquire in the loop that halving only bound the NEXT logical call — the
      one call that had just provoked the refusal re-sent at full speed,
      bypassing the throttle the 429 had armed. That is the exact failure the
      note above `throttled` says it exists to prevent. Moving the acquire
      inside the loop **deletes the pre-acquire branch and the test that pinned
      the undercount**, and makes 5d's own principle ("a quota is spent by what
      was SENT") true in both modes rather than one. Net: fewer lines, one
      fewer special case, and a behaviour change only for a legacy plugin
      provider, in the direction its provider asked for.
    - **The collision comment was wrong, and the pass measured how wrong.** It
      claimed a shared `provider` id costs "a wrong LABEL on a row whose
      numbers are still right". The stored id is also the RATE key
      (`pricing.js key(provider, model)`), and `install()` gives every
      on-device provider a `*`/`*` zero rate that matches ANY model spelling —
      verified: `ratesFor("collide", "")`, `(…, null)` and `(…, undefined)` all
      return `{ "*": 0 }`. So a colliding connector would have its quota
      stamped `priced_quantity = quantity, cost_micros = 0` — a positive
      "known free" claim, which units.js calls the one unfixable kind of wrong.
      **Not fixed, deliberately**: nothing collides today, and the honest fix is
      namespacing the stored id for BOTH families plus a migration of
      `usage_meter.provider` (the 0040 backfill rows carry bare ids and `''`).
      That is a slice, not a pass. The comment now says what the exposure is.
    - **`meterSpend` normalized `model` for the WRITE but not for the RATE
      lookup** — filed under `provider\0''`, priced under `provider\0undefined`.
      Latent since 5b (whisper's model is null until its first done payload) and
      masked because those providers only carry the `*` wildcard, which matches
      either spelling; 5d made it reachable by being the first spender with no
      model at all. One line: normalize once, use it twice.
    - The namer now reads `pluginDefs()` (narrowed to connector defs) instead of
      building its own map from `listConnectors()` per request — plugins.js is
      already "one composed catalog over the three integration layers", it is
      memoized, and the loader's `resetDefs()` invalidates it on every
      register/unregister. The conditional construction went with it: the
      `boardNames` guard it copied exists because that one runs a query.
    - **The day-chart tooltip named three units by hand** while the breakdown
      table beneath it already loops the served ones. A day of pure
      transcription, detection or connector traffic drew an empty bar (height is
      `input_tokens`) under a tooltip that mentioned nothing at all — an
      accumulating 5b/5c gap that `api_requests` made total. Tokens keep the
      compact pair; everything else the day spent names itself, the same
      recorded-not-restated shape the 5b pass gave the boards cell.
    - `countKpi`'s fallback label could never render (any unit with a quantity
      is in the served `units` by construction) and said "requests" where the
      server says "calls" — the module's header promises it "invents none".
      Dropped; both KPIs gained a title, since an AI call is an API call too and
      two labels alone can't carry that.
    - **A test title asserted the opposite of its body**: "a retried attempt
      costs a request" over an assertion that it costs nothing. It is true now.
      `meterTotals` gained a `provider` filter so both tests scope the same way
      through the shared helper rather than one re-spelling `usageRows`.
      "Unpriced by construction" was wrong too — `api_requests` declares
      `rate: EACH` and rides `unitVocabulary()`, so a paid API tier IS
      priceable; the zeros are an unseeded rate.
    - Efficiency measured clean and settled the suite-time question: the meter
      costs **126 writes / 679 ms across the whole suite**, parallelised over 89
      files, against a measured 19% run-to-run variance (36.1 / 37.2 / 42.9 s on
      identical code). The 32→47 s jump was five new test files from earlier
      stages, not this. Production ceiling with all three built-ins saturated:
      385 req/min = 6.4 writes/s = 1.4% of what the pool absorbs. The `await`
      stays — it is what makes read-after-write true for the tests and for any
      "sweep, then show usage" read, and under a binding bucket it costs zero
      wall clock because the refill is by elapsed time.
    - **Skipped**: collapsing `ctxFor(db, name, provider, apiKey)` to
      `ctxFor(db, active)` (8 sites, 6 of which would have to stop destructuring
      `activeProvider` — wider than this diff); exporting the `"api"` id as a
      constant (every AI meter site spells its capability as a literal too, and
      `facet-diagnosis` meters `"diagnose"`, which isn't a CAPABILITY_DEF
      either — the literal is the house pattern).

## API

- `GET /api/usage` — admin. Query: `from`, `to`, `group` (comma-separated
  dimension list), `board`, `capability`. Returns `{ rows: [{ …dimensions,
  units: { unit: { quantity, priced, cost_micros } } }], units: [{ id, label }],
  currency, priced: bool }`. The `units` array is the client's vocabulary — see
  Mechanism 3.
- `GET /api/boards/:id/usage` — the same, board-scoped, `requireBoardManager`
  (spend is management-visible — see "Decided").
- `GET /api/boards/:id/tokens` — unchanged route, now returning
  `{ input, output, cache_read }` for every member plus `cost_micros` when the
  caller manages the board.
- `GET /api/admin/prices`, `PUT /api/admin/prices/:provider/:model` — the
  admin rung, plus `POST /api/admin/prices/refresh` to force a community pull.

## Config

- `USAGE_METER_RETENTION_DAYS` (default `0` = keep forever) — a rollup is small;
  the knob exists because someone will want it. Pruned in the existing hourly
  block.
- `MODEL_PRICE_SOURCE_URL` (default the LiteLLM raw URL; **empty disables the
  community rung entirely** — the air-gapped and don't-phone-home answer).
- `MODEL_PRICE_REFRESH_DAYS` (default `7`).

All three get an `.env.example` entry and a compose passthrough — the standing
lesson that unreachable knobs are dead knobs.

## Tests (`test/metering.test.js`)

- **Meter:** upsert accumulates per dimension; two models on one board on one day
  stay separate rows; N votes meter N `requests`; the `''` sentinel round-trips
  and — the pin that matters — a nullable dimension column would break
  `ON CONFLICT`, so assert the upsert actually updates instead of inserting.
- **Cardinal rule:** stub the meter write to throw → tagging and extraction still
  complete and the job log says `ok`, not a tagging failure.
- **Backfill:** legacy `ai_board_usage` rows land as `capability='tag'` with
  empty provider/model, and totals match pre-migration.
- **Rungs:** admin beats provider beats descriptor beats community; an unknown
  model is **unpriced, never guessed**; an on-device provider is **$0 known, not
  unknown**; a self-hosted `llama3` does not inherit a hosted `llama3` price
  (the collision trap, asserted directly).
- **Effective dating:** a price edit does not change an already-stamped
  `cost_micros`.
- **Endpoint:** grouping, scoping, the `units` vocabulary in the response, and
  that the client fixture renders an unknown unit it has never heard of.

## Decided (2026-08-31)

1. **Money is shown.** Dollars wherever a price rung answers (the community map
   is expected to cover the common case), the honest "unpriced" blank wherever
   none does — never a guess. The admin-typed rung is the fill-in for providers
   no map knows.
2. **Spend is management-visible: the app admin and board managers.** Members
   keep the token/jobs transparency they have today (the coin chip, the job
   log); the dollar figures ride the manager surfaces — `/api/usage` stays
   admin, `/api/boards/:id/usage` is `requireBoardManager`, and
   `/api/boards/:id/tokens` keeps its member-visible token fields but includes
   `cost_micros` only for a manager (`state.boardManage` gates the chip's
   rendering of it, the Clear-button precedent).

## Appendix — what the ecosystem does

- [OpenRouter's activity dashboard](https://openrouter.ai/blog/announcements/activity-dashboard/)
  leads with five numbers — spend, requests, token volume, cache hit rate,
  blended cost per million — each with a sparkline and a prior-period delta, then
  breakdowns by model/app/member, and every chart drills to individual requests.
  That is the Stage 4 shape, arrived at independently.
- [Langfuse's cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
  states the rule worth stealing outright: cost is either **ingested**
  (provider-reported, authoritative) or **inferred** from tokens × a price map,
  ingested always wins, and you store the price that was in effect when the call
  ran. Their named failure mode is double-counting when two paths log one call —
  the one-row-per-paid-call invariant at
  [worker.js:1981](../server/worker.js#L1981) already handles it.
- [OpenMeter](https://openmeter.io/) is where the meter/rating/reader split comes
  from: a meter defines the event and its aggregation, a price links to the meter
  and sets cost per unit, and the advice is to design the internal usage ledger
  first so pricing can evolve without rewriting the measurement layer. That is
  Stage 1 before Stage 3, in someone else's words.
