# Pattern surfaces — mining the facet combinations (2026-09-05)

Self-contained for a fresh session. Written after measuring the stocks-test
board's tag data directly (503 tagged entities, 15 facets, ~80 chips), mapping
every gallery surface the results could live on, and a conventions survey of
how shipping products present derived pattern data (Baymard's promoted-filter
research, Amplitude Personas, Steam tags, Finviz signal lists, Datadog
Watchdog, Mixpanel Flows). Mockups of all five surfaces, drawn in the app's
own vocabulary with the real numbers below:
https://claude.ai/code/artifact/dbc6ee29-3ca0-4783-b1bf-0e31f48f4a86

**The mockup is stale in two places** and the text below wins: 1a shipped as
in-place multipliers rather than a separate "travels with" strip, and Stage 3
became a stateless nameless lens rather than AI-named archetypes stored as
tags. Both revisions are recorded in their own sections.

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
4. **Derived surfaces never write.** Stages 1 and 3 are pure computation over
   data already in the browser — the only persisted state in either is a
   per-viewer boolean. Stage 2 reads a table nothing else reads. Nothing in
   this arc writes to a board.
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
- **1b. ~~Relatives + Rarity blocks in the lightbox panel~~** — REVISED
  2026-09-06, see "1b revised" below: relatives became a similarity SEARCH
  riding the meaning-search plumbing, no dedicated surface. Only the rarity
  one-liner ("only item holding X with Y") still wants a home in the item
  view someday.
- **1c. "Unusualness" sort** — one catalog entry in
  [sort.js](../public/sort.js#L67) (facet boards only); below-floor entities
  sort to the end regardless of direction. The 1b rarity block is what makes
  the ordering answerable.

Status: 1a SHIPPED 2026-09-05 (odds lens; badges 09-06), 1b SHIPPED
2026-09-06 (as revised below; + meaning flavor same day, see 1b-meaning),
1c pending. Known trigger gap: rows mode has no Find-similar entry — its
tag pop (openInstTagPop, rows.js) is per-instance and mutation-focused;
both flavors WORK in rows mode once triggered, only the trigger is absent.

### 1b revised (2026-09-06): similarity is a search, not a surface

Same reframe that shrank clusters, applied again — find the existing
mechanism whose DATA SHAPE the feature already produces, and ship the data
instead of a surface. Meaning-search hands the gallery a ranked
`Map<id, score>` (`state.searchResults`, [search.js:26](../public/search.js#L26));
the grid filters to the map and orders by score
([filters.js](../public/filters.js#L132), search order beats the board
sort); `filterKey` carries `searchQuery` so the render caches key correctly;
clearing restores the board sort. Chip similarity produces exactly that map.
So "find similar" is A SEARCH THE USER DIDN'T TYPE — no panel, no new
lifecycle, and it needs no embeddings, so it works on boards where the
search box itself is hidden.

**Scoring** (patterns.js, one-shot per invocation, O(items × tags)): shared
chips weighted by rarity (−log2 of board share), expressed as a fraction of
the target's own total weight — "how much of this item's identity does the
candidate share". Measured on the stocks board, ranking quality is excellent
(GPRO → SNAP 68%, HOOD 50%, OPEN, PINS, AMC; NVDA → GOOGL, SMH, TSM, ASML),
but a ratio floor ALONE does not bound the result:

| target | ≥25% | ≥33% | ≥40% | character |
|---|---|---|---|---|
| GPRO | 64 | 20 | 9 | distinctive — floor suffices |
| GPUS | 43 | 24 | 12 | distinctive |
| NVDA | 165 | 82 | 45 | mixed |
| GLW | 387 | 312 | 219 | typical — floor useless |

GLW is the board's most typical item; its identity is made of common chips,
so a third of the board legitimately shares a third of it. "Similar to the
most average item" IS most of the board — honest, but not a useful search.
Therefore: **floor ≥ ⅓ of self AND a top-N cap (~50)**, the movers-list
convention. Both are display bounds, tunable at build time; items with fewer
than MIN_TAGS chips don't offer the action at all (too little identity to
match on — the clusters participation rule, same constant).

**Trigger — the tag pop** ([openTagPop, grid.js:278](../public/grid.js#L278)):
a second `ddAction` ("Find similar") beside "Edit tags" in the footer. Right
weight by construction: nothing new on the card face, one row in a hover pop
only reached through the tag badge — and semantically exact, since the
similarity is computed from precisely the chips the pop is showing. Note the
footer's current gate is `state.me && state.facets.length` (editing needs a
user); Find similar needs neither — restructure to per-row gates. Later, the
same row can ride the lightbox tags panel; not needed to ship.

**Mode lifecycle** (search.js owns it, scoring imported from patterns.js):
`runSimilar(img)` sets `searchResults` + a unique `searchQuery`
(`similar:<identity>`, feeds filterKey), leaves `searchDraft` alone (the
input stays clean), and sets a new `state.searchSimilarTo` display label.
The indicator is the [alert-event-chip pattern](../public/toolbar.js#L583)
— a labeled toolbar chip "Similar to DVLT ×" rendered whenever
`searchSimilarTo` is set, independent of `searchAvailable`; its × calls
`clearSearch`. `clearSearch` and a successful `runSearch` both clear
`searchSimilarTo` (typing a real query gracefully replaces the mode). No
spinner — scoring is synchronous. Like meaning-search, the mode is
deliberately not URL-persisted, and new items arriving mid-mode aren't in
the map, exactly as with a typed search.

Open at build time: whether the search box's `active` class + clear button
should suppress while `searchSimilarTo` is set (two clear affordances
otherwise — cosmetic), and the exact floor/cap constants.

BUILT 2026-09-06, as specced. Resolutions of the open points: floor ⅓ and
cap 50 kept as-is; the search box DOES stay quiet while the mode is up (the
chip owns the one clear affordance); ties at the cap break anchor-first then
by identity, so the target always leads its own results. One promote along
the way: the alert-event chip's classes generalized to `.mode-chip` /
`.mode-chip-icon` — two wearers now (alert view, similar view), one grammar.
Scoring tests live in test/pattern-similar.test.js (ratio math, floor, cap +
anchor survival, MIN_TAGS gate, all-universal-chips null).

### 1b-meaning (2026-09-06): a second flavor on the same rails

SHIPPED 2026-09-06, as specced below.

Keep chip-similar exactly as shipped, add a SECOND trigger — "Find similar
by meaning" — riding the stored search embeddings. The two genuinely answer
different questions (measured, stocks board): chip-similar finds items that
ANSWER THE TAXONOMY alike (GPRO → SNAP/HOOD/PINS — fallen consumer
darlings, the narrative archetype), meaning-similar finds items whose
EMBEDDED STORY reads alike (TSLA → TM/HMC/F/GM/LI — automakers; AAL →
LUV/UAL/RYAAY/JBLU — airlines; NVDA → AMD/LSCC/ORCL/AVGO — semis), i.e.
industry kinship finer than the sector facet encodes, because the embed text
(worker.js embedTextFor) is the AI's description + reasoning + tags +
transcript.

**Why it's free**: the paid half of /api/search is embedding the QUERY. An
item's own vector is already on its row (items.embedding, per instance,
Float32Array; stocks board 1115/1115 embedded, local bge-small 384-dim).
Item-to-item is dot products over stored vectors — no provider call, nothing
to meter (doctrine: only paid calls meter).

**The measured design constraint**: the search route's relative cutoff
(top − 0.15) is WRONG for item anchors. Self scores 1.000 but the best real
neighbor is ~0.79 — the rule returns only the anchor; re-anchoring on the
runner-up returns 717 of 1115. And the score curves have NO knee (r1 ~0.75–
0.82 decaying smoothly to p50 ~0.61–0.66, every anchor tried): no honest
threshold exists in bge's compressed cosine range. So the bound is rank, not
score: **top-50 cap, no cutoff**, anchor included (scores 1.0, leads its own
results — the chip-similar convention).

**Route**: `GET /api/search/similar?board=&item=` — requireAuth +
canAccessBoard; resolveEmbedder for the current MODEL name only (no call;
404 "not enabled" when unresolvable, mirroring /api/search);
boardEmbeddings(board, model); anchor rows = those whose (entity_id ?? id)
matches `item` (multi-instance anchors fall out naturally: candidate score =
max over anchor×candidate pairs, then the search route's entity collapse);
no anchor rows → 404 (backfill lag — client toasts). No rate limiter: free
compute, one O(N·D) scan.

**Client**: `runSimilarMeaning(img)` in search.js beside runSimilar — async
(searchReq stale-guard like runSearch, no spinner: local fetch), same
searchResults map, searchQuery `similar-meaning:<id>`, and the mode chip
label carries the flavor at SET time (chip flavor sets "DVLT", meaning sets
"DVLT · meaning" — searchSimilarTo stays one display string, no new state).
Trigger: third ddAction in the tag pop footer — "Find similar by meaning",
ICONS.sparkle (the AI glyph; the two rows explain each other), gated on
state.searchAvailable ONLY — no MIN_TAGS gate, since a barely-tagged item
with a rich description is exactly where this flavor shines.

**Tests**: the route (seeded small vectors: entity collapse, cap, anchor
first, 404s); scoring stays server-side so the patterns unit file is
untouched.

### 3-meaning (2026-09-07): clusters by meaning — the literal carving

SHIPPED 2026-09-07, as revised below (server-side carving).

The clusters lens grows a second flavor over the stored embeddings, as a
THIRD toggle in the filter-options menu — "Clusters by tags" (the shipped
lens, renamed) and "Clusters by meaning", MUTUALLY EXCLUSIVE: turning one on
turns the other off (patterns.js owns the rule — the wrapped toggles clear
the sibling’s state and storage — not the menu). One rail row either way:
same `~clusters` registry entry, same row code, same more/fewer level knob;
patterns.js routes clusterValues/clusterSet to whichever flavor is active.
Each flavor keeps its own boardLens key and level (boardClusters /
boardClustersM); a flavor flip clears the `~clusters` selection like
toggle-off does (the other carving’s values can’t match).

**Measured (stocks test, 1853/1853 embedded, bge-small 384d).** The same
deterministic k-means over embeddings produces strikingly literal groups:
finance (BRK-B, BLK, banks/insurers), biotech (AMGN, AZN, NVS — "clinical
stage"), REITs, aerospace/defense (GE, TDG, RTX + airlines), telecoms
(TMUS, VOD, CHT), a crypto crowd (COIN, MSTR, GEMI), and hardware-vs-
software tech split the sector facet can’t make. Cost: 173–324ms at K=8–16
(one-shot per data/level change; heavier than chips’ ~70ms but fine).

**Labels — two sources measured and REJECTED, one chosen.** Tag signatures
describe the groups well but borrow the wrong vocabulary (and produced
identical twin labels for the two tech clusters) — not kosher for groups
found in meaning-space. Description-word lift labels split the board: half
superb (reit×17, aerospace×22, clinical×8.7), half chart-narration mush
("spike · followed · sharp") because many descriptions narrate the price
chart, not the business. CHOSEN: the label is a HANDLE, not a description
(the arc’s own founding insight) — a gibberish name derived
deterministically from the medoid’s identity hash, rendered as pronounceable
syllables ("damok"). Distinct by construction (one item hearts one group),
stable exactly as long as the group’s heart holds (new arrivals churn the
edges, the name survives; a real reorganization renames — honestly). The
hover title keeps orientation duty: "most typical: TMUS". The hash token is
also the `~clusters` VALUE for this flavor — so a selection survives
recomputes that keep the group’s heart, which c0..c7 never could.

**The server carves; the client gets the carving** (revised 2026-09-07 —
the first draft shipped raw vectors to the browser, ~2.8MB and growing
linearly; rejected). The search-family precedent decides it: like
/api/search and /api/search/similar, the compute runs where the data lives
and the wire carries conclusions. New route
`GET /api/boards/:id/meaning-clusters?level=N` (resolveEmbedder-gated,
unmetered, free): runs the same deterministic k-means over
boardEmbeddings server-side and returns `{ values: [{value, label, size,
title}], sets: {itemId: value} }` — tens of KB at any board size. Entity
with several instances = normalized mean of its instance vectors, collapsed
BEFORE clustering so membership speaks entity ids. Server cache per
(board, level, model, corpus fingerprint: embedded count + max updated_at)
— recompute on the next ask after data moves, at most once per fingerprint;
the ~300ms compute (seconds at 10k items) is absorbed there. Client
contract unchanged from the chip flavor's spirit: fetched on lens-on and on
level change, held until then; items embedded later join on the next fetch
— absent, not unclassified (rule 5).

**Floor fix, BOTH flavors**: the 3%-share floor scales unbounded and at
1853 items (floor 56) it executed a genuinely good 29-member casino/travel
cluster (LVS, RCL, CCL, EXPE, CZR). Cap it: floor = max(MIN_GROUP,
min(N · MIN_SHARE, 30)).

**Build shape**: extract the pure k-means core (seeding, iterations,
medoid — no state, no DOM) from computeClusters into a dependency-free
shared module that BOTH sides import — patterns.js preps chip vectors and
calls it in the browser; the route preps embedding vectors and calls it in
node — so the determinism rules stay written exactly once (the pattern
tests already import public modules into node; the server doing the same
for a pure module is no stretch). Tests: exclusivity, handle
determinism/distinctness, entity-mean collapse, floor cap, the route
(payload shape, cache-hit behavior, gating 404s, nothing metered). Open
niceties, not v1: a color dot from the same hash; a stale-serve variant of
the cache for boards that churn constantly.

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

## Stage 3 — clusters (a second lens, NOT the heavyweight feature)

**Rewritten 2026-09-06 after a deep dive. The mockup page still shows the old
version — named AI archetypes stored as tags — and that design is abandoned.**
It was going to be "the big one"; it is now roughly 1a's size, because
dropping one thing removed everything hard about it.

### The reframe: no names, therefore no state, therefore no lifecycle

The old design's whole cost sat in the *names*: an AI call per cluster, a
stored string, membership persisted as tags — and from that, drift (new items
unclassified, retags moving items out from under their label), a regenerate
button, a staleness signal, name-stability matching across re-clusters, and
metering. All of it downstream of wanting a pretty label.

Measured on the real boards, the names were carrying nothing. A cluster reads
perfectly well as its own signature — the highest-lift chips a majority of its
members hold:

```
[ stable-orbit · plateau-normalcy · not-fallen ]      78   most typical: MCO
[ deep-shadow · recent-vintage · hype-hangover ]      73   most typical: CABA
[ wordmark · linear-horizontal · isolated-mark ]     448   (logos board)
[ vintage-retro · sans-serif · combination-mark ]    279   (logos board)
```

Nobody needs a model to read the first as "the stable compounders", and the
chips have two advantages a generated name can't: they are literally true, and
they are words the user already wrote. **The chips are the name.**

So clusters become a LENS, the same species as 1a: computed from
`state.items`, nothing stored but one boolean, no AI, no server, no drift.
New items classify themselves; a retag moves them automatically; there is
nothing to go stale because nothing is saved.

Names are not gone forever — they are demoted to an optional cosmetic layer
that can be added later *on top of a working stateless feature*. Drift arrives
only with them, scoped to a label rather than the mechanism. Only build it if
someone asks.

### Naming (the term): "clusters", not "types"

The word tracked the design change. "Types" implies an authored, stable
taxonomy sitting alongside SECTOR and SCALE; what this actually is, is a
recomputed statistical grouping with no permanence, and the row label should
set that expectation. "Clusters" reads as *found, not defined* — and now that
the chips are the representation, naming the mechanism is honesty rather than
a leak. ("Groups" is the fallback if it ever tests as jargon; it says less —
every facet makes groups.)

### Mechanism (measured, not assumed)

Spherical k-means over L2-normalised binary chip vectors (cosine similarity).
Chosen over the plan's earlier "greedy growth around high-lift pair cores"
because it yields a clean partition, which is what a facet row wants.

**Cost** (`Float64Array`, flat vectors, ~30 iterations, measured on the real
boards): stocks 496 items/88 chips **17ms**; logos 2406/68 **46ms**; ui
4586/33 **68ms**. Fine cached; NOT fine per render — see the cache below.

**Determinism is a hard requirement, and the naive form fails it.** k-means
seeded from `vecs[0]` gives identical output on identical input but a
DIFFERENT partition when the input array is reordered — which would ship as
"the clusters changed and I didn't touch anything", since `state.items` grows
by `unshift`/`push` on every delta. Fix: seed from the DATA, never from array
position — first seed is the item farthest from the global centroid, each
next is farthest from all chosen seeds, ties broken by `identity` string.
Verified: identical partition on all three boards with the input reversed.

**Signature** per cluster = among chips ≥50% of members hold, the three with
the highest lift vs the board. **Medoid** ("most typical") = the member with
the highest summed similarity to its own group.

### How many clusters — the honest answer

The plan's earlier instinct ("sweep k, pick the best score") **does not
survive the data**. Separation (mean own-centroid minus best-rival similarity)
falls monotonically with k on all three boards — stocks .30/.20/.18/.16…,
logos .16/.16/.16…, ui .21/.17/.14… — so "pick the best k" always degenerates
to **k=2**, i.e. two giant useless halves. Any automatic pick would be an
arbitrary threshold dressed as science, which the plan's rule 1 forbids.

So: **a fixed default k (8 measures well) plus a granularity control**, and
let the DATA decide how many clusters are *shown* rather than how many are
computed. (The control SHIPPED 2026-09-06: "more"/"fewer" chips at the tail
of the clusters row step a per-viewer LEVEL — K = 8 + 4·(level−1), capped at
level 5 / K 24 since the floors bound what can ever be shown anyway. The
level rides the same boardClusters storage the toggle uses ("1" is exactly
what the boolean era stored), a step re-carves the whole row and clears the
lens's own selection like toggle-off does, and a step recomputes even
mid-churn — the stale-serve gate holds only within a level. Prompted by the
real board doubling to 1,115 items: 8 centers re-formed around the bigger
population and a liked niche cluster lost its seat. Deliberately NOT gated
on a saturation heuristic — an all-centers-earned check misses boards whose
unclassified bucket would resolve at higher K; the viewer sees whether a
step found structure, and overshoot is one "fewer" away.) Two floors, both
applied after clustering:

- support: a group under ~3% of the board is not a cluster;
- signature: a group whose best majority-held chip is under ~×1.5 has nothing
  to say.

Anything dropped lands in an honest **unclassified** chip. Measured at k=8
every group on all three boards clears both floors (sizes 4–23%, best lifts
×1.8–×16.9), which is exactly what a safety net should look like — silent on
healthy boards, and firing on the thin ones (few facets, correlated axes)
this is meant to protect against.

### The cache (the deep dive's main find)

`app:render` fires **unconditionally on every poll tick** — every 4s while
anything is in flight, every 20–30s on an idle board with alerts
([data.js:308-341](../public/data.js#L308), plus signals.js's 20s ticker). An
uncached 68ms cluster would run every four seconds. It must be cached, and the
cache key must be exact.

Reference equality on `state.items` is NOT usable: inserts mutate the array in
place (`unshift` at [data.js:179](../public/data.js#L179), `push` at
[data.js:405](../public/data.js#L405)), so the array stays `===` while its
contents change.

But there is an exact, allocation-free signal. **Every writer REPLACES an
item's `tags` array rather than mutating it** — the delta reconcile
([data.js:140-143](../public/data.js#L140)), the tag editor
([tag-editor.js:108](../public/tag-editor.js#L108)) and `refreshEntityTags`
([utils.js:69-78](../public/utils.js#L69)) all assign a fresh array. So:

```
keep the previous list of `item.tags` ARRAY REFERENCES; recompute when the
length differs or any reference differs at its index.
```

O(items) pointer comparisons, no strings, no hashing, and no collision class
at all — strictly better than the content-signature approach `cardSig`
([grid.js:45](../public/grid.js#L45)) uses, which needs strings only because
it compares one item across renders. Order is safe: `state.items` is never
re-sorted in place (`taggedFiltered` sorts a copy).

Two further gates, both cheap: compute only when the lens is ON, and **don't
recompute while the board has items in flight** — a board mid-tagging would
otherwise pay 68ms every 4s to re-cluster data that is still moving. Settle
first, then compute once; the codebase already reasons this way
(`SETTLE_MS`, [facet-diagnosis.js](../server/facet-diagnosis.js)). Nothing
needs clearing on board switch — board changes are full page navigations
([data.js:411-413](../public/data.js#L411)), so module state dies with the
page.

### Where it lands

- `~clusters` joins the [SYSTEM_FACETS registry](../public/filters.js#L30)
  beside `~objects`/`~uploaders`, so chips, counts, `?f=` URLs, saved filter
  configs and alerts all work unchanged — a registry entry, not a new concept.
  The one imperfect fit: those entries are pure functions of one item
  (`entity: (x) => x.objectSet`), while a cluster assignment is a precomputed
  map, so this entry closes over module state. Acceptable; worth a comment.
- The chip renders through the existing `chip()` constructor with a display
  label distinct from its value — exactly how uploader chips already work
  (`chip("~clusters", "c3", "stable-orbit · plateau-normalcy · not-fallen")`).
- Toggle: a second `ddCheckRow` in the Filter options footer beside "Show
  pattern odds", off by default, `boardClusters:<id>` in localStorage.
- The row renders with the other system rows, above the authored facets: it
  is the most compressed view of the board, so it reads first.

### Traps

- **Cluster over the whole board, never over the current selection.** Otherwise
  selecting a cluster narrows the set, which re-clusters, which changes the
  chip just clicked. (Cluster-the-current-filter is a legitimately different
  feature — an explicit mode, never the default.)
- **Determinism** — see above; the naive seeding is order-dependent.
- **Thin boards**: with 2–4 facets the clusters just restate one facet. The
  signature floor catches it after the fact; a warning before generating
  would be kinder. `emma` (2 facets) and `cars` (2) are the local examples.
- Cluster quality tracks facet independence — see the redundancy note below.

### Free consequence: the evidence card already exists

Selecting a cluster chip with the 1a odds lens ON shows every other chip's
multiplier given that cluster — which IS the over/under-represented evidence
table the old design was going to build as a bespoke component. Stage 3's
explanation UI fell out of Stage 1. Ship the two lenses composable and there
is nothing else to build for it.

### Aside: facet independence, measured (2026-09-05)

Normalised mutual information over the stocks board says the 15 axes are not
equally independent — `price_ghost`↔`fall_autopsy` share **46%**,
`sector`↔`story_fuel` 37%, `scale`↔`price_ghost` 35%, `crowd_phase`↔
`price_ghost` 32%; while `tension_clock`↔`story_fuel`, `street_presence`↔
`crowd_phase` and `sector`↔`scale` sit at 4–5%. Most of the correlated
cluster is price-derived (the tagger reads the chart), so a strong odds
reading *within* it is close to a tautology. This matters for two surfaces:
it bounds how interesting clusters can be on a given board, and it is the
caveat any 1a reading should carry.

## Open questions

- 1a's salience gates are guesses off one 503-item board (×2 / observed ≥5 /
  expected ≥3 / result floor): they should scale with board size, and want
  retuning the first time the lens runs on a small board, where they may
  never fire.
- ~~How the `×N` renders on the pill without crowding the count~~ — SETTLED
  2026-09-05: a filled badge in a second slot after the count (plain text was
  unspottable against ~80 chips). Rounded-square against the pill's capsule so
  it reads as a stamp ON the chip; six fixed steps, two arms (×2/×4/×10 out,
  ×0.5/×0.25/×0.1 back — symmetric in log space). Colors are the validated
  blue↔orange diverging pair, NOT green/red: this app already spends those on
  price direction (detail-chart.js `UP`/`DOWN`), and on a board of stock charts
  a green ×4 would read as "up". Every step clears 4.5:1 on the pill and its
  hover tint; the arms sit ΔE 24 apart under protanopia. No warm hue can
  separate from the price red under red-green CVD (they collapse onto one
  axis), which is why the badge always prints its own number — the color is
  reinforcement, never the sole carrier.
- Steps are FIXED, not scaled to the visible set (the user asked): a
  set-relative ramp repaints every chip when the selection changes and paints
  a mild ×2.1 as loudly as a ×40 on a quiet board — the color would describe
  the board, not the chip. Fixed steps are learnable.
- Chip floor for rarity (≥12 is right for 15-facet stocks-test; needs to
  derive from the board's facet count, e.g. ~80% of single-valued facets).
- Whether the patterns door (Stage 2) and the diagnostics door merge into one
  "board intelligence" door once both exist.
- Stage 3's default k (8 measures well on three boards, but all three are
  ≥7 facets). ~~The shape of the granularity control~~ — resolved 2026-09-06:
  "more"/"fewer" chips in the row itself (see Stage 3).
- "Keep this cluster": a liked cluster is still ephemeral at every level —
  only the harden-into-a-saved-filter action (above) would let one be kept.
- Whether the cluster chip should carry the medoid's THUMBNAIL on image
  boards. `[ wordmark · linear-horizontal ]` is legible, but a picture would
  be better, and the board already renders that face. Needs `pill()` to take
  more than a text label — the reason it is not in the first cut.
- Whether Stage 3's row belongs above the authored facets (proposed) or
  directly under the status row.
- An alert saved while a `~clusters` chip is selected carries a condition the
  server can never satisfy — cluster values aren't tags, and the lens is
  client-only, so the alert just never fires. `~objects` has server-side
  handling; `~clusters` can't. Options when it matters: strip `~clusters`
  from the seeded condition, or refuse the save with a reason. (Shipped
  as-is 2026-09-06: the alert modal shows the condition chips, so the dead
  chip is at least visible.)
  The likely real fix is an explicit "harden into a filter" action on a
  cluster chip — expand to its signature chips as an ordinary selection —
  which trades exact membership for a durable, shareable, alertable filter.
  It must stay an explicit act, never a silent substitution: measured
  2026-09-06, AND-of-signature is NOT the membership (85-member cluster →
  33-item filter dropping 58 members; another keeps its count but swaps in
  50% strangers). The signature describes the group; the centroid over all
  chips defines it. A partition also can't be expressed as selections at
  all (overlap, gaps, no "unclassified").

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
