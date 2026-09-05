# Pattern surfaces — mining the facet combinations (2026-09-05)

Self-contained for a fresh session. Written after measuring the stocks-test
board's tag data directly (503 tagged entities, 15 facets, ~80 chips), mapping
every gallery surface the results could live on, and a conventions survey of
how shipping products present derived pattern data (Baymard's promoted-filter
research, Amplitude Personas, Steam tags, Finviz signal lists, Datadog
Watchdog, Mixpanel Flows). Mockups of all five surfaces, drawn in the app's
own vocabulary with the real numbers below:
https://claude.ai/code/artifact/dbc6ee29-3ca0-4783-b1bf-0e31f48f4a86

## What the data says (measured, not guessed)

A board's tags are a joint distribution the app currently reads only one
marginal at a time (the rail's per-chip counts). Measured across the full
stocks-test board:

- **Full fingerprints are almost all unique**: 497 distinct among 503. The
  six shared ones are each held by exactly two stocks — and every pair is a
  real-world business twin (GOOG/GOOGL, MA/V, HLT/MAR, PSX/MPC, MU/AMAT,
  MS/TD). Nobody told the tagger that. Grouping by exact profile is useless
  as a feature; the twins are a scheme-validation result.
- **The signal lives in pairs and triples.** Cross-facet chip pairs bind far
  beyond chance: `dilution-grind × lottery-like` 9.6× (13 stocks),
  `micro × no-visible-anchor` 9.7×, `healthcare × biotech-frontier` 8.7×
  (38 stocks). Triples run to 90× (`trough-capitulation × micro ×
  no-visible-anchor`, 10 stocks). Coherent archetypes fall out: a "fading
  microcap" cluster, a biotech-binary cluster, a sleepy-utility cluster, and
  one huge default ("large, pre-internet, slow-drift, fresh-move" — ~40% of
  the board pairwise).
- **Avoidances are near-perfect zeros** where stories would contradict:
  `fast-grower × pre-internet-institution` 0 observed vs ~44 expected,
  `not-fallen × deep-shadow` 0 vs ~40, `darling × quiet-reassessment` 2 vs
  ~39. The facets are not independent dice; they describe one story per
  entity. A tagging that lands an "impossible" pair is either a mistag or
  genuinely strange — both worth surfacing.
- **Similarity works and is legible.** Shared-chip overlap weighted by chip
  rarity puts SNAP (13/18 shared), HOOD, OPEN, PINS, AMC next to GPRO — the
  post-hype consumer-web family, cutting across sector.
- **Rarity has one-line explanations.** GPUS is the board's most unusual
  fully-tagged entity, and the reason is statable: the only stock where
  `punching-bag` meets `micro`. That statability is the whole trick (below).
- **Coverage caveat**: a handful of entities carry 1–2 chips (NFLX, AAL) and
  score "unusual" artificially. Rarity ranking needs a chip-count floor —
  excluded, not ranked weird.

None of this is stocks-specific. It is pure tag arithmetic and applies to any
board with facets.

## The grammar the surfaces must speak

Everything needed already exists as vocabulary or precedent:

- **All tags are already in browser memory.**
  [computeFacetStats()](../public/filters.js#L153) makes one pass over
  `state.items` per render for totals + leave-one-out counts. ~80 chips means
  the full pair matrix is ~3k cells — trivially cheap client-side.
- **Chips are [pill()](../public/utils.js#L475)**, system facet rows
  (`~objects`, [filters.js:396](../public/filters.js#L396)) are the precedent
  for derived rows, and dead-end suppression already exists (`.muted` on
  zero-count chips).
- **The read-only-stats shell exists**: facet diagnostics — toolbar door with
  unseen dot ([toolbar.js:130](../public/toolbar.js#L130)), read-only modal
  ([facet-diagnostics.js:490](../public/facet-diagnostics.js#L490)), announce
  channel. A patterns surface is the same species.
- **Sorts are a derived client-side catalog**
  ([sort.js:67](../public/sort.js#L67)) — a new entry is a registry row, not
  an architecture change.
- **The lightbox details panel** ([paintPanel, lightbox.js:327](../public/lightbox.js#L327))
  already renders per-facet chip cells with reasoning; new blocks reuse
  `panel-label`/`panel-chip`/`panelCell`.
- **tag_snapshots is a change ledger read by nothing.**
  [addTagSnapshot](../server/db.js#L572) diffs against the previous snapshot
  in the same transaction and writes only on change — it has recorded every
  tag movement since day one; no route reads it
  ([modular-boards-plan.md](modular-boards-plan.md): "no UI yet").
- **Alerts fire at exactly the tag-landing moments**
  ([evaluateItemAlerts, alerts.js:65](../server/alerts.js#L65)) but the
  condition is static set-membership with a once-per-entity ledger — a
  *change* is invisible by construction. The delivery/settle/webhook machinery
  below it is condition-agnostic.

## Design rules (pinned)

1. **Never a bare score.** Every derived number ships with the ingredient
   that produced it: `×9.6` next to a companion chip, "only stock holding
   X with Y", "shares 13 of 18". The multiplier/ratio IS the trust device;
   an opaque "weirdness 0.87" is a gimmick. (Every credible product surveyed
   — Barchart, Steam250, Watchdog — shows the ratio and baseline.)
2. **Generic or nothing.** No stocks-specific anything; all five surfaces
   work on resumes and boats. Names, floors, and copy stay domain-neutral.
3. **Reuse the shells.** New chips are `pill()`, new panel blocks are
   `panel-chip` cells, new modals ride the diagnostics-door pattern, menus
   are `dd-*` rows. No new component vocabulary.
4. **Derived surfaces never write.** Stages 1–2 are read-only computation
   over existing data. (Stage 3 stores type membership as tags — its own
   decision, taken there.)
5. **Unset ≠ weird.** Entities below a chip floor are excluded from rarity
   ranking and relatives denominators, not penalized. Absence stays absence.

## Stage 1 — the client trio (zero server work)

One new module (`public/patterns.js`) owning the derived numbers, computed
lazily from `state.items` and cached until the item list changes: per-chip
counts, per-entity rarity (mean −log2 of chip frequency, over the floor),
per-entity relatives on demand (shared chips weighted by rarity). No standing
pair matrix — 1a needs only a division on numbers the rail already has, and
1b computes the opened entity's pairs on demand. Three consumers:

- **1a. In-place multipliers** (revised 2026-09-05 from an earlier separate
  "travels with" strip — the mockup still shows the strip variant). While a
  selection exists, chips in the rail carry a small `×N` beside the count:
  how over/under-represented that chip is GIVEN the current selection.
  The chip's leave-one-out count is already "items matching selection + this
  chip" ([computeFacetStats](../public/filters.js#L153)), so the multiplier
  is `ctxCount / (total × resultCount / N)` — one division per chip per
  render, multi-select handled by construction because the conditioning is
  the whole selection, not a chip pair. Salience gates (all three must
  pass; ink is the scarce resource):
  - meaningful in either direction: `×N ≥ 2` or `≤ 0.5` — the depleted side
    is the avoidance signal and matters as much as the enriched side
    (muting is just its ×0 endpoint);
  - enough evidence: observed ≥ 5 AND expected ≥ 3 (scale with board size);
  - enough selection: current result count above a floor, else every ratio
    is jumpy — show nothing.
  With nothing selected the rail is unchanged. The whole lens sits behind a
  **toggle in the Filters caret menu, off by default**, persisted per viewer
  like sort (localStorage) — a way of looking, not a board property.
- **1b. Relatives + Rarity blocks** in the lightbox panel: top ~5 relatives
  as rows (ticker/name, overlap bar, "shares N of M"), then a rarity block —
  rank among floor-qualified entities plus the one or two rarest pairs this
  entity holds ("only item holding X with Y" / "1 of 3 holding…"). Computed
  for the opened entity only; O(board) per open.
- **1c. "Unusualness" sort** — one catalog entry in
  [sort.js](../public/sort.js#L67) (facet boards only); below-floor entities
  sort to the end regardless of direction. The 1b rarity block is what makes
  the ordering answerable.

Ships as one coherent change; suite gets a patterns unit file (pair lift,
floor behavior, relatives ordering pinned against a small fixture board).

## Stage 2 — movement (needs history depth)

Prerequisite that costs nothing today: **turn the stocks board's daily retag
on** (auto_tag_periodic; currently off — history is one layer deep: 826
snapshots / 503 items). Every day it runs, the ledger deepens, whether or not
the UI ships this month.

- **2a. Read route** — `GET /api/boards/:id/tag-changes?since=` reading
  [tag_snapshots](../server/db.js#L572) pairwise per item: emit
  (entity, facet, from, to, at) transition rows, newest first, capped. The
  diffing is trivial because the table only holds changes already.
- **2b. "Changed this cycle" feed** — a patterns door + read-only modal on
  the diagnostics shell: transition rows as `from-pill → to-pill`, grouped by
  cycle, top-N per cycle (movers-list convention: extremes, never the full
  population). Unseen dot on new events since last view.
- **2c. "Changed" alert kind (later leg)** — a discriminated condition shape
  (today's `{facetKey: [values]}` stays the membership kind) plus a per-event
  match key instead of [once-per-entity](../server/alerts.js#L102). The
  natural first predicate: "entity ENTERS value X of facet F" — which is
  membership evaluated on a transition edge. Delivery machinery unchanged.
- Later: per-entity tag timeline in the lightbox (the jobs modal already does
  this dance for field_snapshots under `kind=refresh`); an aggregate
  per-facet flow view (Mixpanel-style) only if the feed proves appetite.

## Stage 3 — types (the big one, last)

Archetypes become a system facet row (`~types`): a worker job clusters
entities by chip profile, one AI call names each cluster from its
differential evidence, membership lands as ordinary tags so filtering,
counts, alerts, and URLs all work unchanged. The honesty device is the
evidence card: over/under-represented chips vs board average (×N per chip),
name editable, cluster dissolvable. Machine finds, human names — never the
reverse presented as truth.

Deliberately unresolved until the trio has proven appetite: clustering
algorithm (greedy growth around high-lift pair cores vs k-modes), stability
across retags (clusters must not churn names every cycle), whether `~types`
is per-board opt-in, and where re-clustering triggers live. This stage gets
its own mechanism-design pass before any code.

## Open questions

- 1a's salience gates are guesses off one 503-item board (×2 / observed ≥5 /
  expected ≥3 / result floor): they should scale with board size, and want
  retuning the first time the lens runs on a small board, where they may
  never fire.
- How the `×N` renders on the pill without crowding the count — same slot,
  second slot, or replacing the count while the lens is on.
- Chip floor for rarity (≥12 is right for 15-facet stocks-test; needs to
  derive from the board's facet count, e.g. ~80% of single-valued facets).
- Whether the patterns door (Stage 2) and the diagnostics door merge into one
  "board intelligence" door once both exist.

## Deep dive for 1a (2026-09-05, pre-build)

What reading the real code corrected or pinned:

- **Chip counts condition on facet selections only.** computeFacetStats'
  `counts` never gate on favorites/crate — only the status tallies do (via
  `inContext`, [filters.js:202](../public/filters.js#L202)). So the odds
  condition on pill selections alone; no favorites/crate story needed.
- **Leave-one-out shapes the denominator per facet.** `counts[t]` for a chip
  in facet F counts items matching every OTHER selected facet — so F's
  context size is `ctxAll + ctxFail[F]` (items failing zero active facets,
  plus items failing only F). Two new counters in the existing pass, which
  already computes `fails`/`failKey`.
- **Chips in the only-selected facet self-neutralize.** With just F selected,
  F's leave-one-out context is the whole board, so every chip in F computes
  ×1.0 and the distance gate hides it — no special case needed. With 2+
  facets selected, F's chips read against the rest of the selection, which is
  exactly the wanted question.
- **The salience gates changed shape.** The plan's flat "expected ≥ 3" floor
  kills the flagship signal (select `dilution-grind`: `lottery-like` has
  exp 1.4, obs 13, ×9.6 — hidden). Replaced with a deviation test: show when
  the ratio is ≥×2 or ≤×0.5 AND (obs−exp)²/exp ≥ 4 (χ²-ish, ≈ p&lt;.05) AND
  context ≥ 10. Active chips and muted chips never carry odds — chosen and
  impossible are already communicated.
- **The toggle rides the saved-filters pop** (the Filters chevron,
  [filterconfigs.js](../public/filterconfigs.js)) as a
  [ddCheckRow](../public/dropdown.js#L347) — the component exists. The pop
  is per-user (chevron only when logged in); the lens inherits that gate,
  fine for a per-viewer way of looking.
- **Persistence mirrors boardSort**: `boardOdds:<boardId>` in localStorage,
  owned by patterns.js, restored in the board-boot path beside
  [restoreSort()](../public/app.js#L149).
- **Testing**: the browser-stub + dynamic-import pattern
  ([instance-rows.test.js](../test/instance-rows.test.js) precedent);
  computeFacetStats gets exported for it. The gates/format are pure functions
  in patterns.js, tested without DOM.
