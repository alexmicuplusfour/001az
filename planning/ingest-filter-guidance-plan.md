# Ingest filters: guidance, vocabulary, and a total cap

**Status: ALL FOUR STAGES BUILT 2026-09-06 (uncommitted), suite 1424 green.
Simplify pass applied same day** (4 review agents): `membership()` extracted
into filter-engine.js — the preview-set = run-set invariant now holds by
construction instead of by two identical inline chains; the worker's no-total
path subtracts `known` BEFORE filter/sort again (the full-window re-sort every
tick on a mature board was the one hot-path regression); all three new modal
selects now go through the shared `fillSelect` (select.js) — which also fixed
the missing `data-placeholder` dimming on "choose…"; one derived `isCustom`
replaced two equivalent-but-differently-spelled predicates; dead
`within_days` clause dropped from the echo gate; echo reads `input.value`
(self-contained) and formats via the shared `fmtNumber`; `presetsOf` computed
once per column; preview route builds the descriptor once. Skipped by
judgment: a `defaultOp` helper (the two spellings have different semantics —
initial vs override), serving SAFETY_CAP via the descriptor for the client's
max=100000 (soft failure mode, limit's max=500 precedent), folding `capped`
into `membership()` (truncation is the route's knowledge).
Live walkthrough of the manual fixtures (Stage 3's, and the stocks board
reconfigure at the bottom) still to be done on the running app.

Stage 4 landed as planned: `ingest.total` validated beside `limit`
(`ingestion/index.js`), the worker's cap-before-known-subtraction chain
(`worker.js` — byte-identical with total unset), the preview route capping
`matched` with the honest `capped` rule (`server.js`), and the modal's
`Keep top` input between sort and `Limit per run` — invalidates the preview
where `limit` deliberately doesn't, max 100000 not limit's 500 nudge, rides
`previewConfig()` into both preview and save. Tests: preview
count/new/sample/hasMore under total + bounds 400s + the capped
suppress/keep pair (INGEST_FEED_CAP-rationed window), and two folder-board
sweep tests (membership + newcomer/fallen-row semantics; total × limit
drain). One fixture note: preview test files need the backdated mtimes every
other fixture here uses — fresh files sit inside the settle window and
enumerate to zero.

Stage 3 landed as planned (client-only, no new tests by design): `UNITS` +
lossless `unitFor` decomposition at module scope, `buildValueInput` grew the
usd input+unit-select pair (reinterpret-on-flip, build-local unit state, plain
product stored), the thousands echo in a column sub-wrap (`.im-hint`, ≥5
digits, input opts out of the row's flex), percent placeholder `e.g. 2.5`,
`step="any"` on number inputs (2.5 billion is the point), and the
content-sized `.im-filter-val select.im-unit` exception in `modal.css`.
Manual fixture in the Stage 3 section still to be walked on the live app.

Stage 2 landed as planned: `presetsOf` normalization gate + descriptor
passthrough (`server/ingestion/connector.js`), market-cap presets on both
manifests (stocks: the named cap bands; crypto: its own scale, no equity
names), modal preset dropdown with the write-op-and-value + op-resync rule,
transient closure-local custom mode, and the select-stays-beside-the-input
Custom layout (`public/ingest-modal.js`; `.im-filter-val` became its own flex
row in `modal.css`). Tests: descriptor normalization (malformed plugin
entries drop, text columns never carry presets) + a real-manifest test that
also pins the no-shorthand label rule. Grew out of the stocks test board: "top 2000 items, stocks
only" turned out to be half-expressible and the half that works takes typed
magic strings into unguided boxes. Three gaps, one arc.

Stage 1 landed as planned: adapter `filterOptions` with the pre-resolve key
intersection (`server/ingestion/connector.js`), route-time merge into fresh
entry objects (`server/server.js` ingest GET), modal enum select under
`equals` with the prepend-unknown-value and choose… rules + equals default on
options fields (`public/ingest-modal.js`), `.im-filter-val select` width rule
(`public/modal.css` — row select padding kept for the chevron). Tests: three
adapter tests (incl. the never-called metered-resolve guard) + a route e2e
through the registered widgets bind, whose manifest now declares a
column-backed and a filter-only vocabulary.

## The three gaps

**1. "Top 2000 stocks" cannot be said.** `#` (rank) is market-cap rank over
the whole mixed universe — stocks, ETFs and closed-end funds together
(`mcapRank`, `server/connectors/stocks/financialmodelingprep.js` ~392, computed
at screener fill). So `# ≤ 2000` + `Type = Stock` means "stocks that happen to
sit in the top 2000 of *everything*" (~970 today), not the top 2000 stocks.
There is no config that means the latter: filters are per-row predicates, and
the only limit is per-run admission pacing (`cfg.limit`), which drains until
the whole matching set is on the board.

**2. Filter value boxes give no guidance.** Pick "Mkt cap" and you get an
empty `<input type=number>` — the user is left to know that market cap is a
raw dollar integer and to type `2000000000000` without dropping a zero. Pick
"Type" and you get free text where only the exact strings `Stock`/`ETF`/`Fund`
do anything. (`public/ingest-modal.js` `syncValueInput`, ~432.)

**3. The vocabulary exists and gets thrown away.** The browse/add modal has a
proper Type dropdown and an 11-sector dropdown — `browse.filters` declares the
options and `runtime.browseFilters` resolves them (static + provider-supplied,
one resolver, `server/connectors/runtime.js:295`). The feed descriptor is
built from `browse.columns` alone (`server/ingestion/connector.js`
`descriptor()`, ~136) so none of that vocabulary reaches the ingest modal.

## Decisions, and where they came from

Researched 2026-09-06 (Yahoo/Finviz/TradingView screeners; UXmatters "Numeric
Filters: Issues and Best Practices"; Pencil & Paper enterprise-filter survey).
What the established screeners converge on:

- **Named presets with the range spelled out in the label** ("Large
  ($10B–$200B)"), not raw number entry. Yahoo is presets-only; Finviz is
  presets + custom; TradingView is both.
- **People filter with thresholds, not bands** — "above X" vastly more than
  "between X and Y". Double-ended range inputs over-constrain and hit zero
  results.
- Labeled choices beat free input because the consequence is visible before
  the choice is made.

Constraints this plan holds to (from the same conversation):

- **No shorthand typing** (`10B`, `2T`) — abbreviation literacy can't be
  assumed. Spelled-out words only.
- **No data-derived guidance** (histograms, example values from the catalog) —
  filters get configured before data exists, and a plugin catalog may be slow,
  metered, or empty. Everything renders from the *contract*.
- **Presets are presentation sugar.** Picking one writes a plain
  `{fn, op, value}` filter row. The engine, the validator, and the saved
  config shape do not change — a saved config never depends on a manifest's
  preset list still existing.
- **Presets are single-ended** (one op, one value → exactly one filter row).
  This is what the research recommends anyway (thresholds, not bands), and it
  makes round-tripping trivial: a row that exactly matches a preset renders as
  that preset; anything else renders as Custom. A band is two rows, built by
  hand, as today.

### Rejected alternatives (so they stay rejected)

- **Plugin-level type exclusion** (screener drops ETFs/funds by default): this
  exact default existed and was deliberately removed —
  `financialmodelingprep.js` ~323 "the user narrows, not the manifest". A
  connector-global default also can't serve a stocks board and an ETF board
  from the same connector.
- **Board-mapping-level scope** (`input: {connector, scope: {...}}`): a second
  place that says "stocks only", parallel to filters. Every surface (browse,
  sweep, preview, manual add) would consult both, and a scope that blocks a
  manual add is a guardrail where a filter is a default.
- **Rank-within-type column** (`mcapRank` per `assetType`): fixes only this
  instance, provider-specific bookkeeping, and subsumed by the total cap.
- **Shorthand parsing** (`10B` accepted in inputs): rejected per above.
- **A `between` op** (two-value filters): engine + validator + UI surgery to
  express something two rows already say.

## Stage 1 — enum value dropdowns (Type, Sector, Exchange)

The feed filter catalog learns the browse vocabulary where the two overlap.
(Closely examined 2026-09-06; the details below are verified against the code,
not sketched.)

- **Adapter hook** (`server/ingestion/connector.js`): the feed adapter gains an
  optional async `filterOptions(db, board)` built on the bind's
  `browseFilters` (already on the bind that `feedAdapter(conn)` receives —
  `server/connectors/index.js` `bind()`), keeping only entries whose `key` is
  also a **column** — candidate `values` bags carry column keys only, so a
  filter-only vocabulary can never be a feed filter and must not be offered.
  For stocks that yields `type` (static 3), `sector` (static 11), `exchange`
  (provider-supplied). The file adapter declares nothing.
- **Intersect BEFORE resolving, not after.** The hook checks
  `manifest.browse.filters ∩ browse.columns` on declared *keys* first and
  returns null without calling `browseFilters` when the intersection is
  empty. This is load-bearing, not an optimization nicety: crypto declares
  exactly one filter, `category`, which is not a column — but resolving it
  costs a **metered CoinGecko request** (`/coins/categories/list`,
  `coingecko.js` `filterOptions`, 24h-cached) whose result the intersection
  would then throw away. Intersect-after buys a paid answer to a question
  nobody asked, on every cold modal open of every crypto board.
- **Cost story for stocks** (verified): cheap. `exchange` is
  `universeExchanges()` — derived from env, no HTTP. `industry` is one
  request per 24h (`available-industries`, its own cache) and rides along
  unasked-for, but it's the same shared cache the browse modal fills, and its
  failure is already caught per-key inside FMP's `filterOptions` (the
  exchange control survives). No screener fill is triggered. `browseFilters`
  itself catches provider failure and degrades to the static vocabularies
  (`runtime.js` ~311), so the hook never throws; the route needs no extra
  guard.
- **Route** (`server/server.js` GET `/api/boards/:id/ingest`, ~1379): resolve
  the hook and merge `options` onto matching entries of the served
  descriptor's filter catalog — building new entry objects, not mutating.
  The feed descriptor happens to build fresh objects per call, but the file
  adapter serves the module-constant `FILE_FILTERS` through the same
  response shape; a merge helper that mutates would be one refactor away
  from poisoning shared state. The descriptor itself stays sync — options
  are a route-time garnish, same as `sources`. Preview/worker/validation
  never see options and don't need to.
- **Modal** (`public/ingest-modal.js` `filterRow` / `syncValueInput`, ~432):
  when the selected field carries `options` and the op is `equals`, the value
  control is a `<select>`; any other op keeps free text. `catalogByFn` (~87)
  already carries whatever the descriptor entry holds, so options need no
  extra plumbing. Render rules that keep saved configs honest:
  - a field with options defaults its op to `equals` — both on `+ filter` and
    when `fnSel` switches to such a field (today's switch resets
    `f.value = ""` and keeps the op if valid; it must also flip the op here);
  - saved value ∈ options → that option selected;
  - saved value ∉ options and non-empty (stale vocabulary, a hand-typed
    config) → the current value is **prepended as an extra option** and
    selected. The select must never silently blank or rewrite a saved
    config on render;
  - empty value → a disabled `choose…` placeholder entry. (An unchosen
    `equals ""` matches nothing, same as it does today.)
  Options entries submit `value`, display `label` — for stocks the two are
  identical, but provider-supplied vocabularies (`category_id` vs display
  name) split them, and `browseFilters` already normalizes to
  `{value, label}`.
- **Validation**: untouched. `validateIngest` already accepts these as text
  filters; the options are UI vocabulary, not a server whitelist (a saved
  config with a stale option string simply matches nothing, same as today —
  and `evaluate()` lowercases both sides, so option matching is
  case-insensitive like every other text filter).
- **Attribution**: the hook passes `req.board` through, so a provider call it
  does make lands under the board that caused it — same rule as every other
  connector call (the 5d convention).

## Stage 2 — numeric presets from the contract

(Closely examined 2026-09-06; verified against the code.)

- **Contract**: a `browse.columns` entry may carry
  `presets: [{ label, op, value }]` (number-kind columns; `op` ∈ gte/lte).
  The feed descriptor passes them through next to `display` — but
  **normalized, not untouched**: keep only entries with a string label, an op
  in gte/lte, and a finite value. Plugin-domain loading validates no browse
  shapes at all (`plugin-loader.js` `validateBuilt` checks providers/manifest
  presence only), so the descriptor is the one gate between a malformed
  plugin preset and the modal.
- **Why on `columns`, not `browse.filters`** (considered and settled): Stage 1
  built a route-time merge channel for `browse.filters` vocabulary, and
  presets could ride it — but that channel exists because enum options can be
  provider-supplied (async, metered, board-attributed). Presets are app
  vocabulary: static by nature, never resolved from a provider, wanted even
  by the sync descriptor path. Forcing them through the async channel buys
  nothing; extending `browse.filters` would also make the browse-modal
  resolver and its route grow preset-awareness they have no use for
  (`browseFilters` drops entries without options — `runtime.js` ~326 — and
  the connector-browse modal renders a control per resolved entry). Two
  vocabularies, two channels, each minimal.
- **Stocks manifest** declares market-cap presets, Finviz-style cumulative
  thresholds so each is one row:
  - `Mega — over $200 billion` (gte 200e9)
  - `Large — over $10 billion` (gte 10e9)
  - `Mid — over $2 billion` (gte 2e9)
  - `Small — over $300 million` (gte 300e6)
  - `Under $2 billion` (lte 2e9)
  - `Under $300 million` (lte 300e6)
- **Crypto manifest** declares its own scale (`over $10 billion`,
  `over $1 billion`, `over $100 million`, `over $10 million`,
  `under $10 million`). Plugin connectors declare theirs or none — no
  presets, no control, today's inputs. All labels spell the words out — the
  no-shorthand rule applies to what we *show*, not just what we accept.
- **Modal — the row grammar, decided**: the row stays
  `[field][op][value control]`. A field with presets renders the value area
  as a dropdown of ALL its preset labels + `Custom…` — one list, both
  directions, the Yahoo/Finviz shape a beginner can read without touching
  the op control. Picking a preset writes the row's `op` **and** `value` in
  one go, and re-syncs the op select to match (the op select keeps telling
  the truth; direction appears twice — `≥` and "over" — which is redundancy,
  not conflict). The alternative — scoping the preset list to the current op
  so a preset only writes `value` — is cleaner grammar but hides the "under"
  presets behind an op flip; rejected for discoverability.
- **Render + custom rules** (the part that keeps saved configs honest, same
  bar as Stage 1):
  - a row whose `(op, Number(value))` exactly matches a preset renders as
    that preset — including a hand-typed `2000000000` under `gte`, which
    showing as `Mid — over $2 billion` is recognition, not rewriting;
  - no match and a non-empty value → the dropdown sits on `Custom…` and the
    number input renders beside it inside the value area (flex row — the
    select is the way back to the presets, so it never disappears);
  - empty value → disabled `choose…` placeholder entry, as Stage 1;
  - picking `Custom…` sets a **transient, closure-local** custom flag (never
    saved) so the input shows even while the typed value happens to equal a
    preset — without it the row snaps back to the preset label mid-edit. The
    flag resets when the field changes; on modal reopen a preset-equal value
    honestly renders as the preset;
  - the preset select writes `Number(value)` — the saved shape stays exactly
    what the number input produces today; `validateIngest` and the engine
    are untouched;
  - `eq` never matches a preset (declared ops are gte/lte), so it keeps the
    plain input — as does every field without presets.
- **Verified fallout is nil**: the descriptor deepEqual test pins the *stub*
  catalog (`ingest-connector.test.js:63`), not the real manifests;
  `listConnectors` ships `browse` minus `filters` so presets ride to the
  client harmlessly; the connector-browse modal iterates columns only for
  table headers. Nothing else reads column entries by exhaustive shape.

## Stage 3 — the Custom path stops being a raw integer box

(Closely examined 2026-09-06.) Purely client-side — the `display` kind the
descriptor already ships is the whole contract, so there is **zero server
change** and no server test; verification is the manual fixture below. No
existing unit-select vocabulary in `public/` to reuse (checked); the unit
control is new but component-scoped. The echo reuses `.im-hint`.

For number-kind fields, keyed off `display`, inside `buildValueInput`:

- **`display: "usd"`** → number input + unit `<select>` with spelled-out
  words: `dollars / thousand / million / billion / trillion`. Type `10`, pick
  `billion`. Stored value is the plain product (10e9) — validator and engine
  untouched, same bar as Stage 2.
- **Unit semantics, decided**:
  - *Unit change reinterprets*: `10 | billion` → flip to `million` means ten
    million now — `f.value` recomputes as `input × unit`. That is what a
    person changing the unit means; rescaling the input to preserve the
    value would make the control a formatter, not an input.
  - *Unit state is build-local, not sticky*: each (re)build of the control
    decomposes `f.value` into the largest exact unit; typing never rebuilds
    (only field/op/preset changes do), so the chosen unit holds through an
    edit session without any cross-build state — Stage 2's `customMode` has
    no sibling here. An empty input whose unit was flipped and then
    abandoned re-derives `dollars` on the next rebuild; nothing was typed,
    nothing is lost.
  - *Decomposition must be lossless*: pick the largest unit `u` where
    `|v|/u ≥ 1` **and** `(v / u) * u === v` in floats — the second clause is
    the invariant (render must never drift the saved value). `2.5e9` →
    `2.5 | billion`; a hairy `1234567891` falls through to `dollars`, ugly
    but exact.
- **Other number fields** (volume, rank, file size) → keep the single input,
  add a live formatted echo while `|value| ≥ 10000`: `= 20,000,000`
  (`toLocaleString`, class `.im-hint`). Rank's four digits stay quiet.
  *Layout*: the value area is a flex ROW since Stage 2, so "under the input"
  needs the input wrapped in a small column-flex span with the echo below —
  the row itself must not grow a second line for every field.
- **Percent** (`display: "percent"`) → placeholder `e.g. 2.5`; no units, no
  echo (percentages are small numbers — guidance is the placeholder, and
  `within_days`' existing `days` placeholder shows the pattern is at home).
- **Row width**: worst case is a preset field in custom mode —
  `[field][op][preset select][input][unit select][×]`. The unit select must
  NOT take the `.im-filter-val select` `flex: 1` (it would claim a third of
  the value area for the word "billion"); it gets a content-sized width of
  its own. `.im-filter-row` doesn't wrap today; if six controls pinch on a
  narrow viewport that's a pre-existing behavior this stage doesn't fix.
- **Manual fixture**: stocks board → Mkt cap Custom `2.5 | billion` →
  preview must equal a hand-typed `2500000000`; reopen shows `2.5 | billion`
  again (decompose); flip the unit and watch the preview count move; volume
  `1000000` shows the `= 1,000,000` echo; a percent field shows the
  placeholder; price `319.97` stays plain `dollars`.

No shorthand parsing anywhere; the unit select is the friendly equivalent.

## Stage 4 — "Keep top N" (the total cap)

The piece that makes "top 2000 stocks" sayable: `Type = Stock`, sort
`Market cap desc`, keep top `2000`. Drop the `#` filter.
(Closely examined 2026-09-06; findings below verified against the code.)

- **Config**: `ingest.total` (nullable int, 1..SAFETY_CAP — same bounds and
  same constant as `limit`, `server/ingestion/index.js` validateIngest ~159).
  `null` = uncapped, the default.
- **Semantics**: membership, not pacing. The eligible set is the first N of
  the *filtered, sorted* window — **including rows already ingested**, which
  is what keeps it a stable "the board mirrors the top N matching" rather
  than "N more per run" (that's `limit`). As ranks shift, new entrants inside
  the top N get admitted; rows that fall out stay (the ledger never evicts —
  deletion is the user's judgment, unchanged), so a long-lived board can hold
  more than N. Fallen-out rows do NOT consume cap slots — they're simply
  outside the first N.
- **Worker** (`server/worker.js` ingest sweep, ~2006): today the chain is
  `fresh = candidates − known` → filter/sort → `applyLimit(budget)`. The cap
  must land *before* the known-subtraction or it degenerates into per-run:
  `matched = applyLimit(applySort(applyFilters(candidates)), total)` →
  `fresh = matched − known` (a filter of the sorted list — order survives) →
  `applyLimit(fresh, budget)` exactly as now. With `total` unset this is
  byte-identical output to today (filtering all candidates vs. fresh commutes
  with the known-subtraction); filters now run over the full window each
  tick, which is in-memory predicates under the 100k safety cap — noise. The
  drain machinery (`drain_left`, the `{drain}` window hold) is untouched — it
  paces the fresh side, and mid-run the held window keeps `matched` stable
  across a run's ticks.
- **Preview** (`server/server.js` preview route, ~1490): `matched` gets the
  same cap before `count`/`new`/`sample`/`hasMore` are derived, so the
  modal's numbers and a real run keep their one-window guarantee. With the
  user's board: count 2000, new ~1030 → "1030 new matches — 970 already
  ingested".
- **The `capped` flag must stop lying when the total is hit** (found in the
  close look): `capped` means "the walk stopped early, so the count is a
  lower bound" — the client renders `N+` and the results-view "showing the
  first N scanned" note from it. Once `matched.length` hits `total`, the
  count is NOT a lower bound (more matches can't join a full membership), so
  the route serves `capped: enumerated.truncated && matched.length < total`
  when a total is set. A truncated window below the total keeps its honest
  `+`.
- **Modal** (`public/ingest-modal.js` Sort & limit, ~675): a second input —
  `Keep top [all]` placed between the sort selects and `Limit per run`
  (it completes the phrase "top N by X"). Two wiring rules found in the
  close look:
  - `totalInput` must **invalidatePreview()**; `limitInput` deliberately
    does NOT (per-run pacing doesn't change what matches — the total does).
    Two adjacent inputs, one invalidates, one doesn't, each for a reason —
    comment it or it reads as a bug.
  - `limitInput` carries a historical `max="500"` nudge; `totalInput` must
    NOT inherit it (the user's 2000 has to be typeable) — its max is
    SAFETY_CAP's 100000.
  - `previewConfig()` sends only finished fields — total rides as
    `...(cfg.total ? { total: cfg.total } : {})`, like limit.
  - The section hint replaces the current sentence with both roles: "Keep
    top mirrors the first N matching; limit per run paces each run."
- **Generic by construction**: the file adapter shares the whole path —
  "keep top 50 newest by modified" works on folder boards with zero extra
  code, and the sweep tests below use exactly that.
- **Non-interaction with the early-stop proof** (`exhaustedBy`,
  `server/ingestion/connector.js`): the cap applies downstream of a full
  window, so it neither enables nor breaks early exit. This is deliberately
  NOT the "stop at enough matches" walk-cap that
  [ingest-drain-rewalk.md](ingest-drain-rewalk.md) rejects — that one
  silently truncated what a feed could *see*; this one is a stated membership
  semantic evaluated over everything the feed sees. (A total-aware early
  stop for metered walks — "first N matching in a server-honored sort is a
  proof too" — would need the partial window in the cache key like
  exhaustedBy's tag; possible future work, not this stage.)

## Order and size

Stages are independent; 4 is the user-visible payoff and can ship first.
Suggested order: 4 (small, server + one input) → 1 (small) → 2+3 together
(they share the value-control rework in `filterRow`). Each stage lands with
its tests green; suite is at 1414.

## Tests

- `test/ingest-connector.test.js` — Stage 1: `filterOptions` intersects
  vocabulary with columns; a stub domain whose only declared filter is not a
  column must prove `browseFilters` was **never called** (the metered-call
  guard), not merely that the result was dropped. Stage 2: presets ride the
  descriptor normalized (a malformed plugin preset — bad op, non-finite
  value, missing label — is dropped, well-formed siblings survive), and the
  real stocks/crypto descriptors carry their market-cap presets.
- `test/ingest-routes.test.js` — Stage 1: the GET route merges options;
  Stage 4: preview honors `total` for count/new/sample/hasMore, the `capped`
  flag suppresses once the total is hit (and keeps its `+` when the window
  truncates below it), `validateIngest` bounds it (0, non-integer,
  > SAFETY_CAP all 400).
- `test/ingest-sweep.test.js` — Stage 4, on folder boards (the shared-path
  proof): total admits exactly the first N of the sorted set and never the
  rest; already-ingested rows count toward the cap (a full membership admits
  0); a new file that sorts INTO the top N is admitted while the fallen-out
  row stays on the board; total + `limit` drain across ticks stays exact.
- Modal (`public/`) is exercised manually as always: the stocks test board is
  the fixture — reconfigure to `Type = Stock · sort Market cap desc · keep
  top 2000`, preview, run, expect ~2000 stocks and zero funds.
