# Loose ends: facet-addressable tagging (`facet-addressable-tagging-plan.md`, shipped in 65ea508)

Second post-implementation sweep, 2026-08-07 — a re-read of the landed code
rather than of the plan. Stage 1 (scope column, `scopeResult`, the seven
`tag_facets=NULL` sites, `retagBoardFacets`/`retagItemFacets`, routes), stage 2
(the scoped prompt) and the admin UI are all built, and the live probe stands.
What follows is what the sweep turned up around them.

Baseline: 703 tests pass. Two items below are already fixed in this pass.

**Third sweep, 2026-08-07** — this one went after the plan's *premises* rather
than its checklist, and found two the code inherited without checking. Both are
fixed below (defects 7 and 8), with the third sweep's own verified-sound list
folded into the section beneath. 708 tests pass.

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

Added by the third sweep, all measured rather than read:

- **The backup round-trip really does survive `TEXT[]`.** The second sweep
  reasoned this from `dumpTable`'s `::text` cast and `loadTable`'s `$n::c.type`;
  it now has a probe behind it. `{mood,kind}` re-casts exactly, and so does a
  key set containing a comma, a double quote and braces — `{"a,b","c\"d","{e}"}`
  — which is the case that would have quietly corrupted an archive, since facet
  keys are only sanitised in the modal and not server-side.
- **A facet added or removed between queueing and landing merges correctly**, in
  both directions. A facet that arrives mid-flight is absent from the prompt and
  contributes nothing to the merge (rather than landing empty); one that leaves
  is garbage-collected exactly as a full pass would.
- **`releaseHeld` and `markExtracted` are genuinely unreachable** for an armed
  row, not merely unreached. `held` is only entered through `markExtracted`,
  which is fenced on `status='extracting'`, and every path into that leg
  (`reExtract`, `reextractItem`, `reprocessEntity`) clears the scope first.

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

- [x] **7. The scope outlived its pass on `failed` rows, and three "exempt"
  writers inherited it.** *(fixed, third sweep)*

  The plan's blast radius rests on one sentence — *"A scoped row exists only
  while `status` is `pending` or `processing`"* — and that sentence is what
  exempts `retagBoard`, `queueUntagged` and `requeueItemForTag` from the
  seven-site table. 0030's header asserted it too. It was not true.

  `failOrRequeue`'s terminal branch and `recoverStuck`'s ceiling branch both
  write `status='failed'` while preserving `tag_facets` — correct on their own
  terms, since a *retry* of a scoped pass is still scoped, and the second sweep
  pinned exactly that. But when the retries run out the scope stayed armed on a
  row all three of those writers can see:

  | site | filter | reached from |
  | --- | --- | --- |
  | `retagBoard` (`db.js:1027`) | `('tagged','failed','held')` | the retag button; `retagDue`'s scheduled pass |
  | `queueUntagged` (`db.js:1110`) | `('held','tagged','failed') AND tags='[]'` | the auto-tag off→on sweep |
  | `requeueItemForTag` (`db.js:1963`) | `('tagged','failed')` | the connector `retag_on_refresh` cascade |

  Measured before the fix: seed a tagged item, arm `['mood']`, fail it
  permanently, call `retagBoard`. The model is asked about `mood` alone — stage 2
  makes this a *prompt* narrowing, not just a write filter — and `kind` keeps its
  old answer.

  ```
  -> before: tags = ["kind/a","mood/calm"]
  -> the model was asked about: ["mood"]
  -> after:  tags = ["kind/a","mood/loud"]      # kind/b never landed
  ```

  Usually one pass, since `markTagged` nulls the scope on landing. Not always: if
  whatever failed the item is still broken, the narrowed pass fails too,
  `failOrRequeue` re-parks the scope, and **every** later full retag is narrowed.
  `queueUntagged` is the worst of the three — its filter is `tags='[]'`, so it
  targets precisely the items with nothing to preserve.

  Fixed at the two failure sites rather than the three consumers: a terminally
  failed pass is over, so it drops its scope. That restores the invariant instead
  of growing the table from seven entries to ten, and it keeps the remaining
  exemptions honest. Tests: the terminal branch of each failure site, a guard
  running all three consumers over a genuinely-failed row, and the user-visible
  end-to-end — a full retag after a failed scoped pass asks about all four
  properties and lands both facets.

  Worth noting *why* the second sweep missed it: `facet-scope.test.js` already
  asserted the scope survives `failOrRequeue`, which is right, and never then ran
  a full retag over the resulting row. The test encoded half a rule.

- [x] **8. A scoped retag swept in undecided items.** *(fixed, third sweep)*

  The plan closed this open question with *"`retagBoardFacets` targets
  `status='tagged'` and leaves undecided items to a full pass."* The
  implementation did target `status='tagged'` — but an undecided item **is**
  `status='tagged'`; the verdict rides its own column. The rule never did what it
  said.

  ```
  -> seeded: status = tagged  undecided = true  tags = []
  -> retagBoardFacets queued: 1
  -> after:  undecided = true  tags = ["mood/loud"]
  ```

  That is the exact incoherence the plan named, and three things make it more
  than cosmetic: the item has nothing to preserve, so the whole rationale for
  scoping is vacuous for it; `filters.js:113` still renders it as needing human
  attention while it now carries an AI tag; and the landing runs
  `evaluateItemAlerts`, so an item the model *declined to place* can permanently
  fire a match — motivation #2 of the plan, pointed the wrong way.

  Fixed with `AND NOT undecided` on both `retagBoardFacets` and
  `retagItemFacets`; the per-instance route's 409 now reads "only a tagged,
  decided item". A full retag is still the right tool for these items and still
  takes them.

  One existing test had to move: it forced `undecided=TRUE` and *then* armed the
  item, which the queue now refuses. Its subject — a scoped landing must not move
  the flag, and must hand `addTagSnapshot` the STORED one — is unchanged and
  still needed, so it now arms first and flips the flag second, which is the only
  order the state can actually arise in.

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
  The per-item scoped route is built, fenced (409 on a non-`tagged`-and-decided
  row) and tested; `lightbox.js:507` posts with no body, so every UI path through
  it is a full retag. Either wire a scope picker into the lightbox or record that
  the route is deliberately API-only — right now it reads as an unfinished half.

Added by the third sweep:

- **9. `cancelBoardQueue` invents an undecided verdict on a tagless row.** Its
  `cleared` branch (`db.js:2365`) flags any `pending` row with `tags='[]'` as
  `undecided=TRUE`, which is right for the never-tagged rows it was written for.
  An item legitimately tagged with nothing — the model judged it a match and
  selected no values — comes back from a cancel flagged for human review.

  **Pre-existing, and correctly attributed:** `retagBoard` does not reset `tags`
  either, so the same item has been reachable through the ordinary retag→cancel
  path since long before this feature. Facet scope only makes it likelier, since
  `retagBoardFacets` arms *only* already-tagged rows. Left alone deliberately: it
  belongs to `cancelBoardQueue`, and fixing it here would bundle an unrelated
  regression risk into a facet-scope commit. The fix, when someone wants it, is
  to gate the flag on the item never having landed rather than on `tags='[]'`.

- **10. The admin UI diverged from §1.7, for the better — record it as a
  decision, not as compliance.** The plan asked for a per-facet "retag this
  facet" control inside `buildFacetEditor`, with two hard requirements it derived
  from the blast radius: save before retagging, and no button on a new or renamed
  facet. What shipped is a dropdown on the boards-list row (`toggleRetagDrop`),
  reading `b.facets` from the list payload — i.e. server state.

  That is the stronger answer: the picker is outside the unsaved modal entirely,
  so retagging against a gloss the user has edited but not saved is *impossible*
  rather than *guarded against*, and the rename hazard goes with it. The second
  sweep recorded the UI as "built as specified", which reads as though §1.7's
  requirements were met when they are actually moot. Corrected above.

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
