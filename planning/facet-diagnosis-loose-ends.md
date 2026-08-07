# Loose ends: facet diagnosis (`facet-diagnosis-plan.md` rev. 3, all four slices built)

First post-implementation sweep, 2026-08-07 — a read of the landed code rather
than of the plan, plus a live pass against the rebuilt instance. 799 tests pass.
Six defects below are already fixed in this pass; the rest are recorded. Two of
them came from the user looking at the running app, and neither was reachable
from the code or the suite.

## Measured on the live instance

Everything here is from the running app, not from a fixture.

- **The state every board is actually in.** Two vote-mode boards (`logos`,
  `ui`), and **zero stamped items** across the whole install — every existing
  measurement predates `d`. `GET /facet-stats` on `logos` returns nine facets at
  `items: 0, d: null, stale: 31`, which is precisely §2's backward-compatibility
  case and precisely what `stale` was added to distinguish. Every facet reads
  *awaiting re-measurement* until something is re-tagged. Nothing is broken; the
  feature simply has no current data to work from yet, and says so.

- **A scoped retag writes the SCOPED stamp — confirmed against the real app.**
  One item on `logos` (#21421), scoped to `construction`:

  ```
  before   { of: 3, agreed: 3, votes: { letter-fusion: 3 } }            no stamp
  after    { of: 3, agreed: 1, votes: { letter-fusion: 2,
                                        negative-space: 2 }, d: 1462dde36d41 }

  facetStamp(construction, false) = 7ba5f84cc83c   <- the full-pass stamp
  facetStamp(construction, true)  = 1462dde36d41   <- what actually landed
  ```

  This is rev. 3's first correction, demonstrated rather than argued. Under
  rev. 2's single stamp the gate would have matched `7ba5f84cc83c`, this
  re-measurement would have been invisible, and the verification leg — the entire
  point of the revision — would never have fired on any board.

- **The scoped landing touched one facet's confidence and left eight alone**
  (`construction` stamped, `aesthetic`/`color`/`industry`/`mark_type`/`motif`/
  `presentation`/`shape`/`typography` untouched). `scopeResult`'s `pick`, in
  production.

- **An incidental datapoint for §0.** That item's `construction` was *unanimous*
  at 3/3 before and split 1-of-3 after — same image, same prompt shape, one
  re-measurement. The plan's 18–22% instability is not an abstraction.

- **The header gate resolves.** `GET /api/boards/:id` now returns
  `ai_votes: 3` alongside `manage: true`, so the button's gate
  evaluates on the live payload. That was `vote-mode-loose-ends.md` #6, filed as
  untidiness — now closed, and it really was a prerequisite.

## Verified sound (checked because a break here would be silent)

- **`BOARD_COLS` names the new column.** Found the hard way during slice 3: it is
  a hand-written list, so `getBoard`/`listBoards` return no column that is not in
  it. The worker's own loop selects explicitly (`boardsWithVotes`) and would have
  kept working perfectly while every UI surface showed nothing, with a green
  suite. This is the `claimFairBatch` hazard the facet-scope sweep went looking
  for and did not find; here it was real, and it is now the note attached to §9.
- **Backups carry `facet_diagnostics` with no special case.** `tableColumns`
  reads the live catalog, so the column is picked up by enumeration rather than
  by a list someone has to remember to edit — the same mechanism the facet-scope
  sweep probed for `TEXT[]`, and JSONB is already exercised by `facets`,
  `mapping` and `ingest_state`. 0031's `NOT NULL DEFAULT` is what keeps a
  pre-0031 archive restorable, for 0029's reason.
- **The client module graph resolves on both pages.** `board-modal.js` is loaded
  by `admin.js` as well as the gallery toolbar, and it now imports
  `/facet-diagnostics.js`, which pulls in `state.js`. All six files serve 200
  from the running app.
- **`bumpUsage` receives the shape it reads.** It takes
  `{ input, output, cacheRead, searches }`; `callTagger` returns exactly that, so
  the production path books tokens correctly. The *test fixture* invented
  `{ input_tokens, output_tokens }`, which books zero while still incrementing
  `count` — so the assertion looked like it verified billing and verified only
  that a row existed. Fixture corrected, and the assertion now checks tokens.
- **`no-problem-found` and a missing entry render identically.** Both resolve to
  `state: "none"`. Absence must never read as "fine", and the converse holds too:
  a measured healthy facet must not get a badge an unmeasured one lacks, or the
  unmeasured one starts reading as the broken one.

## Defects

- [x] **1. A failed diagnosis became a standing order.** *(fixed)*

  Nothing about a failure changed the gates. The items were still there, still
  unstable, still measured under the same stamp — and neither failure path stored
  anything, so the next tick's staleness check had nothing to compare against and
  made the same call again. Both paths: a provider error (caught by
  `diagnoseDue`, logged, discarded) and an unusable verdict (deliberately not
  stored, so that no invented claim about the user's taxonomy could land).

  On the shipped 60-second cadence that is **1,440 paid calls per facet per day**
  for as long as the condition lasts. A board with five unstable facets and a
  provider whose schema adherence is poor bills 7,200 calls a day to produce
  nothing. Every other outbound-I/O path in this app already has the answer —
  `failOrRequeue`'s attempts, `alerts.js`'s `WEBHOOK_MAX_ATTEMPTS` — and this one
  was written without one.

  Fixed by recording the attempt as a fact on the board rather than a line in a
  log: an entry carrying `{ k, at, attempts, error }` and no `verdict`. The skip
  condition widens from "there is a finding for this data" to "there is a finding
  **or** three failures for this data", so `MAX_ATTEMPTS = 3` matches the webhook
  precedent. Attempts are keyed to the freshness string, so the moment the
  measurements actually move the facet gets a clean slate. The UI is unaffected —
  `diagnosisState` requires a `verdict`, so an attempts-only entry is silent —
  and `previous` is carried through untouched, because a provider outage between
  an edit and a successful re-diagnosis must not destroy the only evidence the
  user's edit did anything.

- [x] **2. The staleness check paid for the worked examples it did not need.**
  *(fixed)*

  `diagnoseFacet` fetched the whole sample — split values plus both example
  groups, three queries — and only then computed freshness and bailed. On a
  settled board that is the *normal* path: the question is asked every tick and
  answered "nothing has moved" every time. Five unstable facets on the shipped
  60-second cadence is fifteen queries a minute, forever, to change nothing.

  Only the split values are in the freshness key. `diagnosisSample` now takes
  `{ withExamples: false }` and the examples are fetched on the calling path
  only — which re-runs the split query once, on the one path where a paid API
  call is about to happen anyway.

- [x] **3. `addJobLog` could throw into the job it observes.** *(fixed)* The
  app's standing rule is that writers never do — `worker.js` wraps every call in
  `jobLogWrite` (warn, not throw). This one was bare, and it sits *after*
  `setFacetDiagnostic`: a log failure would have discarded a finding that was
  already stored, made `diagnoseDue` log "diagnose failed" about a success, and
  left `calls` unincremented so the rotation misread the pass. Now `.catch` with
  a warning, matching `jobLogWrite`'s semantics.

- [x] **5. The Tagging consistency button rendered as an empty box.** *(fixed, reported
  from the running app)*

  `.tool-btn` carries no generic `svg` rule — **every icon button sizes its own
  glyph**, per class (`.tool-btn.board-edit-btn svg { width: 15px; height: 15px }`).
  A new icon button that skips that gets an SVG with a `viewBox` and no
  dimensions, which collapses to zero and leaves only the button's padding: a
  narrow empty box sitting where the icon should be.

  Nothing could have caught this. The icon string was correct and served
  correctly, `ICONS.gauge` resolved, the button rendered in the right place with
  the right class and the right gate — and there is no CSS in the test suite.
  The only signal was looking at it.

  Fixed by folding `board-diag-btn` into the pencil's selector list rather than
  copying the block: the two sit side by side and are one cluster, so they should
  be impossible to style apart by accident. The comment there now says the rule
  is load-bearing, because the next icon button will hit exactly this.

- [x] **4. The loop had no coverage at all.** *(fixed)* Every test called
  `diagnoseDue` directly. Cut `diagnoseLoop` out of `startWorker` entirely —
  delete the loop, the deps closure, the wake, all of it — and the whole suite
  still passed. The new test drives a real board through `startWorker` with a
  stubbed `fetch`, so `resolveBoardAi`, `trackedTagger`, the tool name on the
  wire, and the usage ledger are all exercised end to end. It caught the hollow
  usage fixture above on its first run.

- [x] **6. The button was called "Tagging stability".** *(fixed, reported from
  the running app)* A phrase from this plan's own prose that appears nowhere else
  in the product. The user's actual vocabulary for the feature is the switch they
  flipped to create the data — **Double-check tags**, *"tags each item more than
  once and keeps only the answers the AI repeats"* — and the lightbox badge's
  *"2 of 3 passes selected exactly this set"*.

  Now **Tagging consistency**, which is what is literally measured, in a word
  someone would use out loud. "Confidence" and "accuracy" were both ruled out for
  the §10 reason: this reads self-consistency, so a facet applied wrongly but
  consistently scores 100%, and either word would promise otherwise. The survey
  and the per-facet copy now share the word (`60% consistent · 377 items`;
  *"the tagger contradicted itself on 40% of items"*).

## Second sweep, 2026-08-07 — the baseline, and the state that outranks it

A read of the landed code against the states it is supposed to render rather
than against the plan, with the first two reproduced against a live database
before being believed. Four defects, all fixed here. 801 tests pass. The fourth
came from the user looking at the running app again, which is now twice for the
same button and neither time from anything a test could hold.

The theme of the first two is that they destroy the **same thing** — the `stats` that
`demoteFacetDiagnostics` turns into `previous` — by two different routes, and
`previous` is the only operand state 5 has. The feature's whole thesis is
*diagnose → edit → re-tag → find out whether it worked*, and the last step of
that sentence is the one that quietly stops working.

- [x] **10. A failed attempt destroys the stats a later edit would demote.**
  *(fixed)*

  The first sweep's defect 1 carried `previous` through a recorded failure,
  reasoning that an outage between an edit and a re-diagnosis must not destroy
  the evidence the edit did anything. It did not carry `stats` — and `stats` is
  the *next* `previous`. `demoteFacetDiagnostics` skips any entry without them
  (`if (!e?.stats) continue`), so the other order of the same three events:

  ```
  diagnosed          entry { verdict, stats: { items: 21, unanimous: 4 }, k: K1 }
  measurements move  a scheduled retag lands six items -> k becomes K2
  provider blips     attempted() replaces the entry with { k: K2, at, attempts: 1, error }
  user edits         demote finds no stats, writes nothing, previous never exists
  ```

  From there the facet can never reach *improved*, no matter how well the edit
  worked — on precisely the facet the loop had just told the user to fix. The
  measurements moving first is not exotic: any board with a periodic retag does
  it on a schedule, and the `previous`-only guard made the failure look handled.

  Fixed by carrying `stats`/`d`/`scoped` through `attempted()` alongside
  `previous`. The verdict is still dropped, and has to be: it described numbers
  that have since moved, and keeping it would also make the skip check read a
  stale finding as a current one and stop asking forever.

- [x] **11. A finding rendered on a sample too small to have produced it.**
  *(fixed)*

  `diagnosisState` gated *awaiting* on `previous || stale > 0`, and a curated
  board has neither. `setItemTags` **deletes** a corrected facet's confidence
  entry rather than re-stamping it, so those items leave the roll-up entirely
  instead of landing in `stale`. Hand-fix eighteen of twenty-one contested items
  under a standing finding and the row comes back `items: 3, stale: 0,
  previous: null` — every disjunct absent, and the stored paragraph the only
  thing left to render.

  Reproduced end to end rather than argued. What the user saw:

  ```
  Shape                                        100% consistent · 3 items
  !  The tagger contradicted itself on 0% of items.
     round and wide overlap
     Suggested: "prefer wide when both read true"       [add to description]
  ```

  A headline computed from what is left, an explanation computed from what is
  gone, and a suggestion to paste on the strength of it. This is §10's curation
  bias — *the more diligent the curation, the healthier the facet reads* —
  arriving as a rendering bug rather than as a sampling one.

  The existing test named this exact scenario in its comment and seeded
  `stale: 22`, which is what an *edit* leaves behind, not what curation does. It
  passed on a disjunct the scenario never produces. Both cases are pinned now.

  *Awaiting* now also wins on a stored verdict, and the copy splits three ways:
  an edit gets "this description changed", nothing measured gets "not measured
  against the current wording yet", and a shrunken sample gets its own sentence
  — the middle one would have been a plain lie about items that were measured.

- [x] **12. `.fd-note` meant two things.** *(fixed)* It is the state class for a
  whole `genuinely-ambiguous-items` block (`.fd-note, .fd-awaiting { background…
  color… }`) *and* the class on the prompt-shape caveat nested inside an
  `improved` block. Both rules match both elements: the caveat drew a grey panel
  and grey text inside the green one, and every ambiguous block rendered a point
  smaller at 85% opacity. Renamed to `.fd-caveat`. Same family as the first
  sweep's defect 5 — CSS is not in the suite — but unlike that one this was
  legible from the stylesheet, since the two rules sit seven lines apart.

- [x] **13. The button's icon was a smudge in an empty square.** *(fixed,
  reported from the running app — the second time this button's rendering has
  been caught only by looking at it)*

  The first sweep's defect 5 was that `.tool-btn` sizes no glyph generically, so
  the new button rendered at zero. Fixing the declared size did not make the
  icon *look* the size of the pencil beside it, because 15px is the box and not
  the ink: the dial's strokes spanned y 7.5–17.4 of a 24 viewBox, so it drew
  about 7px where the pencil draws 13. Half the ink, in a button of identical
  padding, sitting in the same cluster.

  Replaced with two ticks (`ICONS.doubleCheck`), which also fixes what the dial
  was saying. A gauge is the universal "performance" glyph and this measures
  nothing of the kind; two ticks draw the name of the switch that produces the
  data — **Double-check tags** — so the icon and the setting share a metaphor,
  the way the button's label was made to in the first sweep. A bar chart was the
  other candidate and was ruled out for colliding with `viewRows`, two bars, in
  the same header; two overlapping circles, the runner-up, for sitting one
  button away from the coin chip.

  Drawn three times, and the third came from the user in Illustrator after the
  first two each got half of it. Version one used the offset pair every icon set
  draws — second tick down-right, short arm clipped — which fills the box and
  reads as one big tick trailed by a fragment. Version two made them identical
  twins on one baseline, which is a legible pair but fits only by shrinking both
  to 9.5 units of height and steepening the arms past the 45° of `check`.

  The answer holds both at once: **level corners, one clipped arm.** Both ticks
  sit at y 18.25 and top out at y 5.25 — so the pair is level — and the only
  thing that differs is the second's short arm, 2.7 units against the first's
  5.2, clipped so it tucks behind the first's long arm rather than colliding
  with it. 13 units of height, and unmistakably two of the same mark. The
  coordinates are stored absolute rather than as the relative deltas the export
  emits, so the baseline invariant is readable in the source instead of being
  the sum of two additions.

  The cleanup that matters beyond formatting: the export's `stroke="#000000"`
  became `currentColor`. This button styles at `var(--text-dim)` and brightens
  on hover, and a hard-coded stroke would have quietly ignored both — a fourth
  way for this one button to render wrong, and the only one of the four that
  would have looked deliberate.

  The note in `styles.css` now carries both halves of the lesson, since the next
  icon button will meet the second one too.

## Behaviour worth a decision (no change made)

- **14. A diagnosis in flight can undo the save that demotes it.** The worker
  reads `board.facet_diagnostics` once at the top of a pass and writes with an
  unconditional `facet_diagnostics || jsonb_build_object(...)` merge, and between
  the two sits a provider call. `demoteFacetDiagnostics` takes `FOR UPDATE`, so
  the *demotion* is safe; what is not safe is the worker's write landing after
  it, restoring a finding from a pre-edit read with `previous` absent. The plan
  priced this at "one paragraph that was about to be demoted anyway" and assumed
  a microsecond window; it is actually the whole duration of the call, several
  seconds, once a minute per board. The paragraph itself stays invisible —
  *awaiting* outranks it, since nothing is measured under the new stamp — so the
  cost is again the lost baseline, i.e. defect 10 by a third route. The cheap fix
  is to make `setFacetDiagnostic` conditional on the facet's unscoped stamp still
  matching what the pass read; not done because it wants a decision about whether
  that belongs in the setter or in the caller.

- **15. Nothing renders between a re-measurement and the next diagnosis.** Edit,
  re-tag, and the facet clears the item minimum again with its rate unmoved:
  the verdict is gone (demoted), *improved* needs the rate to have crossed the
  threshold, so `diagnosisState` returns `none` — which renders identically to a
  healthy facet. The settle gate is ten minutes wide and the loop ticks once a
  minute after that, so the user who just did what they were told looks at a
  blank facet for at least that long, with no way to tell "we are re-reading
  this" from "nothing is wrong". A sixth state (*re-measured, waiting on a fresh
  read*, keyed on `previous && !verdict && items >= minItems`) would cover it.

- **16. Gate 2 can never pass on a board that never goes quiet**, and it is
  measuring more than it says. `boardTagActivity` reads
  `max(updated_at) FILTER (WHERE status='tagged')`, but `updated_at` is bumped by
  writers that are not tagging — `setItemEntities` on every face/entity
  assignment, entity deletion — so face work on a settled board pushes the
  window while the tally does not move at all. Combined with the board-level
  `busy > 0` check, a board that ingests faster than (drain + ten minutes) is
  silently ineligible forever, and the surface that would say so shows healthy
  numbers with no findings, which is indistinguishable from a healthy board.
  Cheap version: read the tagging lane's own stamp rather than `updated_at`.

- **17. The roll-up is a whole-board jsonb expansion, run per board per tick.**
  `candidates` calls `facetRollup` for every vote board it scans (up to eight a
  minute), each one a `jsonb_each` over every tagged row, plus `facetSplitValues`
  per unstable facet. At `logos`'s 2,406 items this is nothing; nobody has looked
  at what it costs at 100k. Same family as #6 and worth measuring together.

- **18. `state.facetStats` is fetched once per board and never invalidated.**
  `ensureFacetStats` keys on `state.boardId`, so a save that demotes a finding
  leaves the toolbar reading the pre-save roll-up — the dot can stay lit for a
  finding that no longer exists until the user switches boards. A failed fetch is
  also never retried: `statsFetchedFor` is set *before* the request and the catch
  does not clear it. One line each, both in `ensureFacetStats`.

- **5. A deleted facet's diagnostic entry lingers forever.** `editedFacets` walks
  the *new* facet list, so a facet that has left the board is never demoted and
  never pruned; its entry sits in `facet_diagnostics` indefinitely. The roll-up
  is driven by `board.facets` so it is invisible, and it is a few hundred bytes.
  Pruning is one line in the same code path — but it would also mean a facet
  deleted and re-added loses a baseline whose measurements may still be sitting
  in `tag_confidence` under the same key. Left alone deliberately; the cheap fix
  is there if a board ever accumulates enough churn to notice.

- **6. A keyless board is re-scanned every tick.** `deps.resolveAi` returning
  null exits before any paid call, so this costs nothing but queries — but it
  also stores nothing, so the board is re-gated and re-sampled every minute
  forever. The same shape as defect 1 without the money. Worth folding into the
  attempt record if it ever shows up in query load.

- **7. `DIAGNOSE_POLL_MS` and the scan bound interact in a way nobody has
  measured.** One board is diagnosed per tick and at most eight are scanned, so
  an install with more than eight vote-mode boards has a rotation whose period
  depends on how many are stale at once. Two boards today; the arithmetic only
  matters at a scale this install is nowhere near.

- **8. The gate thresholds are still one board's guesses**, and the live data now
  makes that concrete: `ui` has 4,577 items and confidence on **8** of them,
  `logos` 2,406 and confidence on **31**. Vote mode was switched on but almost
  nothing has been re-tagged under it, so `DIAGNOSE_MIN_ITEMS = 20` currently
  admits `logos` and excludes `ui` — on sample size alone, before any question of
  stability. The number wants revisiting once a board has actually been swept.

- **9. §10's curation bias is now measurable and nobody has measured it.**
  `setItemTags` deletes a corrected facet's confidence entry, so the items a user
  fixes leave the sample. On these two boards the confidence coverage is so thin
  that the effect would dominate. Worth a query before trusting a first
  instability rate.

## Still open from the previous sweeps

Restated so one list is current.

- **`vote-mode-loose-ends.md` #3** — closed by this work. The board-level
  confidence roll-up exists, at `GET /api/boards/:id/facet-stats`.
- **#6** — closed. `GET /api/boards/:id` returns `ai_votes`.
- **#5**, the `AI_INFLIGHT` decision (8 lanes × 5 votes against OpenAI's
  `burst: 25`), still never made or written down. Diagnosis adds one more caller
  to the same bucket, though a rare and small one.
- **`facet-scope-loose-ends.md` #3** (single-facet board's scope picker),
  **#4** (confirm dialog overstates), **#5** (second scoped retag is a silent
  no-op), **#6** (`/retag` accepts `facets` but the lightbox never sends it),
  **#9** (`cancelBoardQueue` invents an undecided verdict) — all unchanged.

  #5 is worth re-reading now that this feature exists: the loop tells a user to
  re-tag one facet, and if they fire a second scoped retag while the first is
  still queued they get "Queued 0 item(s)" with no explanation. That is the
  first step of the flow this plan is built around.

## Note on the live instance

The sweep armed one scoped retag on `logos` item #21421 (`construction` only,
three votes, ~3 paid calls) to confirm the stamp write path in the built image.
The item is tagged and healthy; its `construction` answer moved from
`letter-fusion` to a 2–2 split, which is the model's own instability rather than
anything this feature did. A temporary admin session row was created for the API
checks and has been removed.
