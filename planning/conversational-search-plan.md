# Conversational search ("ask") — deep dive (2026-09-07)

> **Status: exploration.** Nothing decided, nothing built. Written after a
> full map of the three subsystems this would sit on: the frontend chip/state
> architecture, the server search family, and the provider rails. The feature
> ask, verbatim: "leverage conversational AI for search within the gallery…
> likely a conversational UI… it would probably generate a search chip similar
> to what we do for similarity search now. Not sure how it would work behind
> the scenes. What the AI would have access to."

## The one-sentence answer this doc argues for

The AI should not get a parallel search engine; it should **speak the app's
existing search algebra** — facet selections, the semantic query, similar-to
anchors — and its answer should land as ordinary, visible state (rail pills +
the searchResults slot) under one named mode chip. The conversation is
scaffolding; the chip is the artifact.

## What it sits on (mapped, with references)

The app already has a complete composable query algebra, all client-applied:

- **`state.selected`** — `Map<facetKey, Set<value>>`, OR within a facet, AND
  across ([filters.js:61](../public/filters.js#L61) `matchesExcept`). Holds
  real facets AND system facets `~clusters` / `~objects` / `~uploaders`
  ([filters.js:32](../public/filters.js#L32)). URL-persisted as `?f=`,
  savable as filter configs.
- **`state.searchResults`** — a single slot: `Map<entityId, score>`. Set by
  typed meaning-search ([search.js:22](../public/search.js#L22) →
  `GET /api/search`, [server.js:2788](../server/server.js#L2788)), by
  similar-by-tags (client scorer, [patterns.js:335](../public/patterns.js#L335)),
  or by similar-by-meaning (`GET /api/search/similar`,
  [server.js:2826](../server/server.js#L2826)). Membership intersects, score
  overrides the sort ([filters.js:135](../public/filters.js#L135)).
- **Mode chips** — `modeChip(icon, label, onClear, tail)`
  ([toolbar.js:201](../public/toolbar.js#L201)); the tail (`· meaning`) is
  the part that survives label clipping. Wearers: searchSimilarTo, alertEvent.
  alertEvent is also the precedent for an **id-set** chip
  (`{ id, name, count, ids: Set }`, [alert-event.js](../public/alert-event.js)).
- **Supersede doctrine** — a new search mode clears the draft and the standing
  views (f8c59f9, 677ba80): one ranked slot, one clear affordance.
- **Embeddings** — per-instance vectors on the item row (`items.embedding`,
  BYTEA Float32), local bge-small 384d today, so item-to-item math is free;
  only query embedding is a paid call, metered to the board
  ([server.js:2795](../server/server.js#L2795)). `embedTextFor` =
  description + reasoning + tags + transcript
  ([worker.js:116](../server/worker.js#L116)).
- **Provider rails** — descriptors are data, wires are protocol
  (`ai-providers/wires/{anthropic,compat,google}.js`), refusals negotiate
  params at call time, `tool` is overridable per call (extract=`record_fields`,
  diagnose=`record_diagnosis` — [facet-diagnosis.js:217](../server/facet-diagnosis.js#L217)
  is the model for a non-tagging structured call). **All wires are single-turn,
  single-forced-tool, and drop assistant prose on the floor.** No multi-turn,
  no tool-result loop, no text channel exists anywhere.
- **Capabilities** — `extract` proves a capability can ride `wire.tag`
  unchanged with its own meter dimension and a `delegate → tag` floor
  ([capabilities.js:117](../server/capabilities.js#L117)). `diagnose` proves a
  meter capability can exist without a binding at all.
- **Metering** — `meterAiCall(db, boardId, { capability, provider, model },
  usage)`; board attribution per the /api/search precedent ("the search is
  that board's work"). Rate limiting: `/api/search` wears
  `rateLimit({ windowMs: 60000, max: 30 })` because every call is paid.
- **No chat UI exists.** Closest shells: `openDropdown`/`ddInput`
  (submit-on-Enter single-line input), `createDrawer` (in-modal sheet with
  focus trap), the filter drawer at ≤640px, `busy()` button spinners, and an
  SSE precedent at `/api/logs/stream`.

## The design space — four things "talk to the board" could mean

1. **Find** — "calm airy dashboards, dark only, no tables." Today the user
   composes this by hand: prose into the search box, chips in the rail. The
   AI's value is doing the composition in one utterance — it knows the
   board's vocabulary (facets, values, glosses) and can map "minimal" to
   `density:roomy + theme:light` while sending the mood words to the
   embedding query.
2. **Refine** — "fewer", "only the dark ones", "more like the third one."
   This is where *conversation* beats a smarter search box: it needs the
   previous composition as context, which a one-shot input never has.
3. **Board questions** — "what dominates here?", "what's unusual?", "is
   there a terminal-aesthetic cluster?" The patterns arc already computes
   statable answers (odds ×N, rarity with its ingredient, cluster carvings
   with medoids). An AI narrating those numbers — always showing the
   ingredient, per pattern-rule 1 — is the differentiating half of the
   feature. Support bots do retrieval; a board analyst is the interesting
   species.
4. **Provenance** — "why is this tagged legacy-enterprise?" The reasoning
   sentence already exists and has a surface (lightbox). Low marginal value;
   comes free once `inspect` exists (below).

The retrieval core is 1+2. 3 is a later stage riding the same loop with two
more tools. 4 is a freebie.

## The spine: definitions, not id lists

The AI's answer should be a **composition in the existing algebra**:

```
{ say:   "1–3 sentences",
  chip:  { label:    "dark kanban, terminal mood",   // the AI names it
           selected: { "color-theme": ["dark"], "core-components": ["kanban-board"] },
           query:    "terminal aesthetic, monospace, hacker mood",  // optional
           ids:      [ ... ] } }                     // optional, last resort
```

Three payoffs of definitions over id lists:

- **Live, not frozen** — the facet part recomputes as items arrive/retag; an
  id list is a snapshot that silently staleness-rots.
- **Legible** — applying the answer sets *real rail pills*. The user sees
  exactly what the AI did and can pick it apart chip by chip — the same
  trust device as showing ×9.6 next to the companion chip. No black box.
  (This is also how the no-implied-choices rule stays honest: the selections
  are visible, inspectable acts, just performed on the user's behalf at
  their explicit request.)
- **Persistable for free** — `?f=` round-trips it, saved filter configs can
  hold it, `filterKey` already covers it. Zero new persistence.

The `query` part lands in the one `searchResults` slot exactly like a typed
search (embed once server-side during the ask, return the ranked map with the
answer — the client never re-pays for it). It supersedes similar-mode per the
standing doctrine. The `ids` escape hatch exists because of:

### The negation gap → the exclusion arc (direction set 2026-09-07)

The algebra is positive-only. `matchesExcept` has no NOT; semantic search
can't negate ("no tables" *attracts* tables). Users will say "without X" in
their first session. **Chosen direction: fix it at the root — chip exclusion
as its own small arc, triggered by right-click on a rail pill.** It serves
manual filtering on its own merits, and the ask feature then expresses
negation natively — the composition stays live and legible, no frozen id
fallback needed.

Mechanics:

- **Gesture**: left-click toggles inclusion (unchanged); right-click
  (`contextmenu`, preventDefault) toggles exclusion; each clears the other.
  Two independent toggles, no hidden three-state cycle. Touch (the ≤640px
  drawer): long-press. No discoverability affordance anywhere (pinned
  2026-09-07) — details in
  [chip-exclusion-plan.md](chip-exclusion-plan.md).
- **Representation** (revised 2026-09-07 — the first draft's `!value`
  sentinel was rejected as stringly-typed convention): explicit
  `{ any, not }` per-facet entries in `state.selected`, the same shape in
  saved configs and alert conditions (legacy arrays read as include-only),
  exclusions in the URL as a sibling `?fx=` param with the `?f=` codec
  reused verbatim. No reserved characters; alerts support NOT natively via
  the same shared `facetPass` module. Full census + mechanics in
  [chip-exclusion-plan.md](chip-exclusion-plan.md).
- **Semantics**: within a facet, (holds any included value) AND (holds no
  excluded value); a facet with only exclusions just requires absence.
  Cross-facet stays AND. **Excluding a value keeps unset items** — NOT dark
  includes items with no theme tag at all; absence stays absence (pattern
  rule 5), and the count next to the chip makes the behavior inspectable.
  Works on system facets too, where it's genuinely useful: not-this-cluster,
  no-cars-detected, not-uploaded-by.
- **Counts**: the leave-one-out semantics of `computeFacetStats`
  ([filters.js:161](../public/filters.js#L161)) extend naturally — an
  excluded chip's context count is how many otherwise-matching items hold
  the value, i.e. exactly how many the exclusion removes. Same computation,
  honest number.
- **Rendering**: an excluded pill is visually distinct (struck label or a
  `–`/`≠` prefix and a muted-warm border — decide in the mockup; no green,
  no drama). The selected-but-vanished loop and the odds lens condition on
  the filtered set as before.

Sequencing: the arc is independent of ask and smaller than it looks — the
sentinel rides most plumbing for free; the real work is `matchesExcept`,
`computeFacetStats`, pill rendering, and the gesture. If ask Stage 2 lands
first, the id-allowlist degrade covers the interim.

## What the AI has access to

**In the system prompt (small, static per board — no tool round-trips):**

- The full facet taxonomy with per-value counts (~80 chips at stocks-board
  scale — a few hundred tokens), `boards.glosses`, `boards.context`, facet
  descriptions.
- Board size, kind mix, whether meaning-search is enabled.
- The **current composition** (selected chips, active query/similar mode,
  favorites/crate view) — sent by the client with every ask. This is what
  makes "refine" work, and it doubles as conversation grounding.
- The active cluster carving (labels, sizes, medoid titles) when a lens is on.
- A statement that item-derived text (descriptions, transcripts) is data,
  not instructions.

**As tools (bounded loop, all read-only, all inside canAccessBoard):**

| tool | what it returns | cost |
|---|---|---|
| `search_meaning(q)` | top ~30 ids + scores + display labels | one embedding (≈free on local bge; metered) |
| `preview(selected, query?)` | `{ count, sample: top 8 labels }` for a candidate composition | free (SQL over tags + stored vectors) |
| `inspect(ids)` | description/fit sentences (tag_reasoning) for ≤8 items | free |
| `similar(item, flavor)` | the existing scorers' output | free |
| `stats(selected)` *(stage 3)* | enrichment multipliers / rarity for the selection — the patterns arithmetic, server-side | free |

`preview` is the load-bearing one: it is the dead-end guard (the model checks
"dark ∧ kanban ∧ 'terminal aesthetic'" isn't empty before answering) and the
negation calculator. It needs the AND/OR evaluation server-side — trivial
over `items.tags` JSONB; the client remains the authority for the final view.

**Explicitly not:** raw item dumps (context blowup and pointless — the tools
return conclusions, per the meaning-clusters doctrine: *the compute runs where
the data lives and the wire carries conclusions*), write access of any kind,
cross-board reach, connector calls.

## Behind the scenes

**Route:** `POST /api/boards/:id/ask` — requireAuth + canAccessBoard +
`rateLimit({ windowMs: 60000, max: 10, key: req => req.user.id })` (per-user,
tighter than /api/search: every turn is a paid model call). Body:
`{ turns: [...], utterance, current: { selected, query, mode } }`.

**No conversation persistence v1.** The client keeps the transcript in
`state` (memory only) and sends the last N turns. Refresh loses the chat but
keeps the view — because the chip *is* just filters + query. The mode chip is
the thread handle: clicking it reopens the pop with the in-memory transcript;
× clears mode + selections it set. If threads ever deserve durability, that's
a table later, not a prerequisite.

**Wire cost (measured against the rails, not guessed):**

- Reusable unchanged: paceAi per-key buckets, resolveCapability ladder,
  refusals.js (both loop shapes — `negotiate` takes a closure and is
  turn-agnostic), tool.js clip/error contracts, providerError mapping, the
  `parts` vocabulary, sumUsage/meterAiCalls (already fold N calls into one
  attribution), withPluginHealth, model discovery.
- New: a `wire.chat` method beside `tag` on the three families — messages
  array mapped per protocol (system placement, image blocks, role names
  differ), assistant + tool-result blocks (anthropic `tool_use`/`tool_result`,
  compat `tool_calls`/`role:"tool"`, google `functionCall`/`functionResponse`
  — none exist today), `tools[]` plural + name dispatch (every builder is
  hardcoded to one tool), and a text return channel (every wire currently
  extracts one named call and discards prose). The pause_turn continuation
  ([anthropic.js:106](../server/ai-providers/wires/anthropic.js#L106)) is the
  embryo of the accumulate-and-continue shape.
- Capability: `CAPABILITY_DEFS` entry `ask` — `declaredBy: "tag"`, floor
  `delegate → tag` (the extract precedent), so it works wherever tagging
  works with zero admin setup; own meter id so the Usage tab shows "ask"
  spend per board. Own binding/picker only if someone ever wants a different
  model for chat than for tagging (plausible: chat wants fast + cheap).
- Loop bounds: ≤6 tool rounds, OUTPUT_BUDGET-style cap, per-turn wall clock
  (~60s), usage accumulated across rounds and metered once to the board.

**Progress over SSE, not token streaming.** v1 answers are 1–3 sentences;
what makes the wait legible is *showing the tool steps as they happen* —
"searched: 'terminal aesthetic' → 42 · previewed: dark ∧ kanban → 7". That
line is simultaneously the progress affordance and the trust device (the
ingredient, shown). The `/api/logs/stream` EventSource pattern covers it;
final answer arrives as the closing event. Token streaming can come later if
answers ever grow essays.

## Surfaces

Fin-style floating panels are foreign vocabulary here. Native shells:

- **Trigger**: a srcSparkle button in/beside the search box (the search home;
  the glyph already means "AI-derived"). Opens an anchored pop
  (`openDropdown` width:anchor) on desktop, the drawer pattern at ≤640px.
- **The pop**: transcript (scrollable), tool-step lines as they stream,
  `ddInput`-style submit-on-Enter, `busy()` on the send affordance.
- **The chip**: `modeChip(ICONS.srcSparkle, <AI's label>, clearAsk, "· ask")`
  — the label is the AI's own name for the search ("the pair names itself"
  extended: the *answer* names itself). Click = reopen thread; × = clear.
- Applied facet selections appear as normal active pills in the rail —
  deliberately not hidden inside the chip.

## Cost & limits

Per turn at stocks-board scale: system ~1.5–3k tokens (taxonomy + counts +
current view) + 2–4 tool rounds ~500–1.5k each + short answer ≈ 5–12k in /
<1k out — fractions of a cent on any mid-tier model, and visible in the meter
strip immediately because metering is one line. The expensive failure mode
isn't tokens, it's a runaway loop — hence the round cap, which is a bound,
not a guardrail on the user.

## Staging

- **Stage 1 — the compiler, on today's wires.** No wire.chat, no tools. One
  forced call (`record_answer`, the diagnose pattern) with the taxonomy in
  the system text and the transcript-so-far concatenated into the single
  user part (the wire is single-message; nothing stops the message containing
  the dialogue). The model composes `{ say, chip }` blind — no preview, so
  occasional empty results (the count renders instantly and honestly). The
  query part is embedded server-side in the same request. Ships the whole UI
  (pop, chip, apply/clear) and the whole meter/limit story. This proves or
  kills the feature for the price of one route + one pop.
- **Stage 2 — the loop.** wire.chat on three families, tools
  (`search_meaning`, `preview`, `inspect`, `similar`), SSE tool-step lines.
  Negation: native `{any, not}` exclusions if the exclusion arc has landed,
  the id-allowlist degrade otherwise. This is where "refine" and dead-end-free
  answers arrive.
- **Stage 0 (independent, any time) — the exclusion arc.** Right-click
  exclusion on rail pills, explicit `{any, not}` entries in
  `state.selected` (section above). Not gated on ask at all; ask just inherits it. Deep-dived in its
  own doc: [chip-exclusion-plan.md](chip-exclusion-plan.md).
- **Stage 3 — the analyst.** `stats` tool over the patterns arithmetic;
  board questions ("what's unusual here") answered with ingredients shown.
  Possibly: "save this as a filter config" as an offered action.

## Open forks (decide before Stage 1)

1. **Does the mode chip exist at all**, or does an ask apply pure ordinary
   state (pills + search box text) with no marker? The chip buys one-click
   clear, the AI's label, and thread reopening; the chipless variant is purer
   but loses the conversation handle. (Doc recommends the chip.)
2. **Chip = definition vs id-set** — argued above for definition. With the
   exclusion arc, the last structural reason for id-sets disappears; ids
   remain only as a transitional degrade if ask ships before exclusion.
3. **Model binding** — ride the tag binding via delegate floor (zero setup)
   vs a dedicated ask picker on day one.
4. **Where refinement context lives** — client-sent turns (recommended) vs a
   server thread table.
5. **Scope of "search"** — retrieval only, or greenlight the analyst stage
   as part of the arc.
