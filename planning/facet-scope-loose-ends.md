# Loose ends: facet-addressable tagging (`facet-addressable-tagging-plan.md`, shipped in 65ea508)

Second post-implementation sweep, 2026-08-07 — a re-read of the landed code
rather than of the plan. Stage 1 (scope column, `scopeResult`, the seven
`tag_facets=NULL` sites, `retagBoardFacets`/`retagItemFacets`, routes), stage 2
(the scoped prompt) and the admin UI are all built as specified, and the live
probe stands. What follows is what the sweep turned up around them.

Baseline: 703 tests pass. Two items below are already fixed in this pass.

## Verified sound (checked because a break here would be silent)

- **`claimFairBatch` returns `*`**, so `tag_facets` reaches `processOne`. A
  hand-written column list is the classic way this feature would evaporate into
  "every pass is unscoped" with a green suite; there isn't one.
- **Backups round-trip the scope.** `dumpTable` casts every column `::text` and
  `loadTable` casts back with `$n::c.type`, both driven by the live catalog — so
  `TEXT[]` needs no special case and `checkRow`'s string-or-null rule is
  satisfied by `{mood}`. An archive taken mid-scoped-pass restores an item still
  armed, which is correct.
- **`markTagged`'s snapshot is fed the stored flag.** On a scoped landing the
  caller passes `row.undecided`, so `addTagSnapshot`'s dedupe compares against
  what is actually in the column rather than a verdict nobody saved.
- **A scoped pass preserves `description` and `fit`.** They are reserved keys in
  `tag_reasoning`, never in `keep`, so they ride through `pick`'s spread —
  which matters because the scoped schema no longer asks for either.
- **A scoped pass with `ai_votes=1` deletes the scoped facet's confidence entry
  rather than keeping the old one.** Correct under the `{}` = NOT MEASURED rule:
  the retained figure would describe an answer that has just been replaced.

## Defects

- [x] **1. The golden snapshot pinned only the unscoped prompt.** *(fixed)*

  `prompt-snapshot.test.js` exists because every other `systemText` assertion in
  the suite is a regex fragment, so a `buildPrompt` refactor could reword the
  prompt for every board and stay green. It captured four variants — reasoning
  on/off × research on/off — all with `scoped` defaulting to `false`. The two
  scoped `selectPara` strings, four sentences each, written last and probed
  least, had no golden coverage at all. The only scoped-prose assertions in the
  suite are `facet-scope.test.js:240-243`: three `doesNotMatch` negatives and
  one `- mood \(` positive. A reword of the scoped instruction would have
  sailed through.

  Now eight entries (`scoped` × reasoning × research — the combination is
  reachable: scoping is orthogonal to research). Re-recording produced **196
  insertions and 0 deletions**, which independently confirms the claim stage 2
  rested on and nothing pinned: the `scoped` parameter leaves all four unscoped
  prompts byte-for-byte identical.

- [x] **2. `htmlToMarkdown`'s doc comment was orphaned.** *(fixed)* The vote-mode
  banner landed between the comment and its function; the facet-scope block then
  landed between them too, leaving three lines about mammoth HTML sitting above
  `sameSet` and `htmlToMarkdown` (`worker.js:514`) undocumented. Comment moved
  back onto its function.

## Behaviour worth a decision (no change made)

- **3. A single-facet board's scope picker is a trap.** `readFacetScope`
  normalises scope-is-every-facet to `null`, so on a one-facet board picking
  that facet routes to `retagBoard`, not `retagBoardFacets`. The difference is
  not cosmetic: `retagBoard` carries a status `CASE` that can send items back to
  `pending_extract`, so the user picks "Mood", is promised "Every other facet
  keeps its current tags," and gets a full reprocess including paid
  re-extraction. Vacuously true promise, materially different action.

  Cheapest fix is UI-side: don't render the per-facet list when
  `facets.length === 1` — there is nothing to scope away from.

- **4. The confirm dialog overstates what a scoped retag touches.**
  `admin-boards.js:127` says `Re-tag all ${b.item_count} item(s)`, but
  `retagBoardFacets` targets `status='tagged'` only — no `failed`, no `held`,
  unlike `retagBoard`. On a board mid-ingest the number can be well above what
  queues. The button's `title` already says "up to" and explains why; the
  confirm doesn't. The cost sentence is also unscoped-only: a scoped pass still
  bills N votes but at roughly a third of the input tokens (probe: 1,097 vs
  3,615 in, 76 vs 345 out), so the estimate is honest about call count and
  silent about the saving that is the point of the feature.

- **5. A second scoped retag while the first is still queued is a silent
  no-op.** `retagBoardFacets` takes `status='tagged'` rows, and an armed row is
  `pending` — so asking for facet B while facet A is in flight skips every armed
  item and re-arms nothing. The plan flagged this and offered union-on-queue
  (`tag_facets = COALESCE(tag_facets,'{}') || $new`) or an explicit refusal;
  neither was built, so the third option — skip — happened by default. The
  returned `queued` count is numerically truthful, but the toast reads "Queued 0
  item(s)" with no explanation, which looks like a broken button rather than a
  busy queue.

- **6. `POST /api/instances/:id/retag` accepts `facets` but nothing sends it.**
  The per-item scoped route is built, fenced (409 on a non-`tagged` row) and
  tested; `lightbox.js:507` posts with no body, so every UI path through it is a
  full retag. Either wire a scope picker into the lightbox or record that the
  route is deliberately API-only — right now it reads as an unfinished half.

## Still open from the previous sweep (`vote-mode-loose-ends.md`)

Unchanged by this work, restated so one list is current:

- **#3, the board-level confidence roll-up.** Still the biggest gap. The
  vote-mode plan called it "the reason to build this," and answering "which of
  my facets is a coin flip" still needs hand-written SQL. Facet scope makes it
  *more* valuable, not less: the roll-up names the facet, and a scoped retag is
  now the tool that acts on the answer.
- **#5** the `AI_INFLIGHT` decision (8 lanes × 5 votes = 40 against OpenAI's
  `burst: 25`), never made or written down. Note that scoping does not relieve
  it — a scoped pass is the same number of calls, just cheaper ones.
- **#6** `GET /api/boards/:id` still doesn't expose `ai_votes`.
- **#7** modal copy silent on scheduled retagging.
- **#8–#12** research-pair carve-out dead against its own UI; degraded vote
  rounds invisible; tag sort; migration comment drift; plugin-health noise.
- Optional: skip the embedding clear when a landing changed nothing. Scope makes
  this more visible — a scoped pass that re-confirms the same value still nulls
  `embedding` and books the item for a re-embed it doesn't need.
