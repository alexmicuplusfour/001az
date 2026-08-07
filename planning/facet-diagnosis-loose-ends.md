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

## Third sweep, 2026-08-07 — the last mile, and a surface that does not know which board it is on

A read of the landed code against the product it is supposed to be rather than
against either surface on its own. Four defects; the first is fixed here, the
other three are recorded. All but the last were reproduced against a live
database before being believed.

Every one of them lives in a **seam**, which is why the suite is green on all of
it. Two surfaces render the same finding and no test crosses between them, so a
control that exists in one density and is offered only from the other is dead
without a single red assertion. Two gates decide whether this feature applies to
a board and only one of them is written down. A hash and a prompt describe the
same facet and are computed in different files from different fields. Nothing
here is wrong inside any single unit.

- [x] **19. The `[replace description]` control is unreachable, so the loop's
  last step is dead code.** *(fixed)*

  `diagnosisBlock` builds `fd-apply` only when `onApply` is passed **and** the
  block is not compact. Both call sites fail one half, and each fails the other
  one:

  ```
  facet editor   diagnosisBlock(row, gates, onApply, { compact: true })
                 -> returns at the `if (compact)` early exit, before fd-suggestion exists
  the modal      diagnosisBlock(row, gates, null,    { collapsible: true })
                 -> builds fd-suggestion and fd-rewrite, then skips `if (onApply)`
  ```

  Confirmed by driving both through the UI harness: `fd-apply` absent from each,
  `fd-rewrite` present in the modal. Dead as a consequence — the `onApply`
  parameter itself, the whole `execCommand("insertText")` callback in
  `board-modal.js` with its undo-stack reasoning, and `.fd-apply` in `modal.css`.

  e27cbce built this leg (§6 state 1: *"`[replace description]` puts the proposed
  wording into the textarea"*). 888f770 severed it while moving the content to
  the modal, and the severing is invisible from either side: the editor test
  (`no apply control can reach the editor, even if one is offered`) pins its half
  **deliberately and correctly**, and there is no modal test to notice that
  nothing picked the control up.

  The sharper version of the defect is not the missing button but **the missing
  text**. `onEdit` calls `close()` before `openBoardModal`, so the proposed
  description leaves the screen at the exact moment the textarea arrives on it.
  A user who followed the feature's own path — dot, modal, expand, *Edit this
  board's facets* — is now looking at a two-row textarea and a one-line headline,
  asked to reproduce a three-sentence paragraph they can no longer see. The
  model's proposal is the product; this is the one step where it is not on
  screen.

  **Fixed as a copy in the modal, not as an apply in the editor.** The editor
  stays read-only, which is 888f770's decision and still the right one: it is a
  stack of 28px rows, and the argument that a finding cannot be rendered there at
  a size worth reading applies to a proposal at least as strongly. So the control
  goes where the text already is — beside the *Suggested description* label,
  sharing its line — and the clipboard is what crosses the modal boundary. The
  editor remains the only writer into `boards.facets`, which is the split §3
  exists to protect; a control in the survey that wrote the description would
  have dissolved it.

  Three things went with it, and the third is the point:

  - `.fd-apply` became `.fd-copy`, and `.fd-rewrite-cap` gained a flex head so
    the label and the control share a baseline.
  - `board-modal.js`'s `execCommand("insertText")` callback is deleted. Its
    reasoning was sound (a programmatic `.value =` does not go on the textarea's
    native undo stack, so Ctrl+Z would have skipped past the replacement and
    silently lost the user's original) and it was reasoning about a call that
    could never happen. It is recoverable from git if the editor ever writes.
  - **The `onApply` parameter is gone rather than fixed.** It is what made the
    defect possible: a callback that one density honoured, the other silently
    dropped, and that was passed only by the density that dropped it. Removing it
    means the two surfaces can no longer disagree about who writes, because
    neither can. The test that pinned the old behaviour asserted the *letter* of
    the intended rule (`fd-apply` absent from the editor) and passed for the
    whole period the control existed nowhere at all; it now asserts by class in
    both directions, and the modal has a test that the copy carries the proposal
    verbatim — plus one for the no-clipboard path, which over plain HTTP would
    otherwise be a button that does nothing when pressed.

- [ ] **20. The facet editor renders diagnosis states on boards that measure
  nothing.**

  `canSeeDiagnostics` gates the header button on `boardManage && ai_votes > 1`
  and the second half is load-bearing, for the reason the plan gives: a
  single-pass board writes no confidence at all. `buildFacetEditor` renders a
  block per facet with **no votes gate**, and `/settings` serves `facet_stats`
  unconditionally. Reproduced on a fresh `ai_votes: 1` board with five items
  queued:

  ```
  facet_stats     [{ key: "shape", items: 0, unanimous: 0, d: null,
                     stale: 0, queued: 5, diagnostic: null }]
  diagnosisState  { state: "measuring", items: 0, queued: 5 }
  renders         "Re-tagging this facet — 5 items still queued.
                   Its figures return as they land."
  ```

  They do not return. `mergeVotes` short-circuits at `runs.length === 1` and
  writes `confidence: {}`, so the promise is unkeepable on this board by
  construction. Second variant, also reproduced: a board carrying findings from
  when votes were on, switched back to 1, renders *"Not measured against the
  current wording yet. Re-tag this board on Shape to see how stable it is"* —
  advice that cannot be satisfied however many times it is taken.

  This is the second sweep's defect 11 in reverse. That one rendered a finding
  computed from a sample that had gone; this renders a promise about a
  measurement that will never be taken. Both are `diagnosisState` answering a
  question it should have declined.

  Reach is wide and ordinary: any board manager opening the editor from the
  gallery pencil or from the boards page, on any single-pass board with anything
  in the tag queue — which is most boards, most of the time. `/settings` already
  returns `ai_votes`, so the fix is one condition threaded to `buildFacetEditor`,
  and it should be `canSeeDiagnostics`'s own second half rather than a new copy
  of it.

- [ ] **21. The stamp and the prompt disagree about what a facet's gloss is, in
  both directions.**

  ```
  prompt   facetGloss = (f) => (f.description || "").trim() || GLOSS[f.key] || f.label
  stamp    facetStamp hashes  f.description || ""      — untrimmed, and no label
  ```

  Two failures, opposite in sign:

  - A facet with **no description and no `GLOSS` entry** is glossed to the tagger
    by its `label`. Rename it and the prompt changes while `d` does not, so
    pre- and post-rename measurements pool into one segment and `editedFacets`
    demotes nothing. That is exactly the bug §2 says cannot arise.
  - A whitespace-only description edit moves `d` while the prompt is byte
    identical, stranding every measurement into *awaiting re-measurement* for a
    change that altered nothing. The modal's `sync()` trims on save so the UI
    path is safe; a direct PATCH is not, and the guard should not be the caller's.

  Hashing `facetGloss(f)` fixes both and is not available: it lives in
  `worker.js`, and `facet-diagnosis.js` sits below it in the import graph on
  purpose. So either the gloss function moves down into this module and
  `worker.js` imports it (correct, and it is three lines and one `GLOSS` table),
  or `facetStamp` trims the description and adds `label` to the tuple
  (cheaper, and still leaves the `GLOSS` fallback unhashed).

  Either way **every stamp moves once**, so the first pass after the fix puts
  every facet on every board into *awaiting re-measurement*. That is the price
  and it should be stated in the commit rather than discovered in the UI.

- [ ] **22. One path can still bill without recording an attempt.**

  The first sweep's defect 1 wrapped the **provider call** in `attempted()`. The
  two writes after it are bare:

  ```js
  if (usage) await bumpUsage(db, board.id, usage);   // throws -> nothing recorded
  ...
  await setFacetDiagnostic(db, board.id, facet.key, entry);   // same
  ```

  A throw from either leaves the call paid for and the board unchanged, so the
  freshness key is identical a minute later and the same facet is diagnosed
  again. Narrower than defect 1 — it needs a database fault, not a provider one —
  but it is the same standing order, and the whole point of `MAX_ATTEMPTS` was
  that no path reaches the next tick having spent money and recorded nothing.

## Fourth sweep — the prompt asked a multi-value facet the single-value question

- [x] **31. The advice did not branch on `single`, and the damage it caused
  would have scored as a success.** *(fixed, reported from the running app —
  the user read a finding and noticed it was giving the wrong kind of advice)*

  The prompt states the arity in one line — *"the tagger may pick: any number of
  values, including none"* — and then asked, unconditionally:

  > The strongest rewrites carry a **precedence rule** for the case where two
  > values could each stand alone, e.g. *"when a mark has both a uniform stroke
  > and a colour blend, prefer gradient-blend"*.

  That is single-value advice. Given a contradiction the model resolved it the
  way it was instructed to, and the rewrite it produced for `construction`
  (multi-value, 2,406 items, 63% consistent) reads *"if both could apply, prefer
  gradient-blend only when the effect is a true color transition rather than
  simple translucency"* — an instruction to the tagger to discard a value that
  was genuinely present.

  **Why this could not be left to be caught downstream.** Take that advice and
  recall falls, while agreement *rises*: a facet with fewer values in play has
  fewer ways to disagree with itself. So the loop would report the regression as
  a win, state 5 would print *"63% consistent before, 81% now"* over it, and
  nothing in the feature can distinguish that from a real fix — the whole
  apparatus reads self-consistency and §10 already says a facet applied wrongly
  but consistently scores 100%. Here the feature would not merely be blind to
  the damage; it would be the thing that caused it and then certified it.

  The advice now branches. `single: true` still asks for a precedence rule,
  which is correct there — one value survives, so the description has to say
  which. Multi-value is told that a precedence rule is the wrong instrument and
  why, that two values applying at once is the expected outcome rather than a
  conflict, and that what is actually unsettled is each value's **threshold**:
  what earns it, and what near miss does not. Both branches now also carry the
  warning that agreement bought by suppressing a real value is not a fix.

  **The slip is inherited from the plan, not invented in the build.** §0
  observes that the unstable facets are exactly the ones *"with values that can
  both be true of one item"* and then prescribes *"one recurring fix: a
  precedence rule in the facet description"*. Those two sentences only agree for
  `single: true`, and every measurement §0 cites — `construction` at 60%,
  `industry` at 64% — is from a facet where they do not.

- [x] **32. A live headline over a stored paragraph made a re-tag look like a
  re-diagnosis.** *(fixed, reported from the running app — the user retagged 133
  items, saw the percentage move, and correctly guessed the prose had not)*

  `diagnosisBlock` composed two things of different ages and said nothing about
  it. The headline — *"The tagger contradicted itself on 37% of items"* — came
  from `s.rate`, recomputed from the roll-up on every render. Everything under
  it came from `entry.explanation` and `entry.rewrite`, written once against
  `entry.stats`. A tagging run moves the first and not the second, so the box
  reads as a fresh finding.

  **And a re-diagnosis is not necessarily coming.** The staleness key is
  `v{PROMPT_VERSION} | d | rate bucketed to 5 points | top-5 split values`, and
  it holds no notion of the sample's identity. `construction` on the live board
  moved from 2,143 items to 2,276 with the rate landing at 37% either side of
  the retag — same `d`, same bucket, same contested values, therefore the same
  `k` and the loop skips. Bucketing is right for drift (§4 chose it so one more
  tagged item does not invalidate a good paragraph) and blind to a wholesale
  re-measurement, and the two are indistinguishable in the key. Note that 33%
  and 37% bucket together, so the headline can visibly move four points with no
  call due, forever.

  **Fixed twice, and the first fix was wrong.** It made the headline report the
  finding's own rate and added a sentence explaining the gap — *"Written against
  2,143 items; 2,276 now carry a measurement of this wording."* The user's
  verdict on that was the correct one: *"why did you make it so complicated? I
  don't even know what that means. I don't need old irrelevant diagnosis
  messages."* Reconciling two numbers is work the reader should never have been
  handed, and the sentence existed only because the box was still being shown
  when it should not have been.

  A superseded finding is **discarded, not annotated.** `diagnosisState` renders
  a stored finding only while the stored sample equals the live one, exactly —
  and the freshness key was made exact in the same change so the two conditions
  are the same condition. Whatever the loop would re-diagnose, the reader hides;
  whatever the reader hides, the loop re-diagnoses. They have to move together
  or a facet goes silent with nothing coming to replace it, which is the one
  outcome worse than a stale paragraph.

  Dropping the bucket costs re-diagnoses, and less than it looks: the settle
  gate means nothing is diagnosed until the board has been quiet for ten
  minutes, so the counts have stopped moving by the time the key is read. A
  board that is genuinely being re-tagged is a board whose diagnosis genuinely
  is out of date.

  The same change added the plainer half, which had simply never been written: a
  facet whose LIVE rate is under `DIAGNOSE_MIN_RATE` shows nothing. `color` sat
  at 86% consistent against a 70% floor with a warning on it, because
  `diagnosisState` tested the rate for *awaiting* and *improved* and never for a
  finding. The loop would not diagnose such a facet in the first place (gate 4),
  so a stored finding under the floor can only ever be stale — but the reader
  should not have needed that argument to stay quiet.

  The test fixtures had the defect baked in three times over: `bigFinding` and
  both scoped-retag rows paired a live 25/17 with stored stats of 25/15, so
  every headline assertion in that file was quietly also asserting the buggy
  composition. Made coherent, with the supersession and the healthy-facet cases
  pinned on their own.

- [x] **33. `PROMPT_VERSION` was not bumped for the `single` branch.** *(fixed)*
  Defect 31 changed the QUESTION, which is exactly what that constant exists to
  track, and the commit that made the change did not touch it. Every v2 finding
  on a multi-value facet carries advice to discard a co-present value, and
  without the bump they would have sat on screen indefinitely — the measurements
  had not moved, so `k` matched and the loop would never have replaced them,
  with `[copy]` still offering the wording. Found while investigating 32, which
  is the same blindness seen from the other side: the key cannot tell that
  anything needs re-asking. Now 3.

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

- [x] **36. A finding never said when it was written, and a superseded one went
  blank rather than saying why.** *(fixed, from the user reasoning about the
  behaviour rather than from a screenshot)*

  Two gaps left by 35, both of which the user found by thinking through what
  they would see. Their mental model had been *"every tagging job re-diagnoses"*
  — it never did, and after 35 the rule is *"a job re-diagnoses when it changes
  the evidence or the severity"*, which is not something a reader can infer from
  a modal that shows only the result.

  **A timestamp.** `entry.at` has been stored since the column shipped and
  rendered nowhere. It matters more now than it would have before: a finding
  outliving a tagging run is the CORRECT outcome when the evidence did not move,
  so its age is the whole difference between "still true" and "forgotten", and
  the reader had no way to see which. *"Diagnosed 3d ago."*

  **A state for the gap.** `current: false` with no replacement yet — the
  evidence moved, the loop will re-ask on its next settled tick, and until then
  the facet rendered as nothing. Blank is the same rendering as *no problem
  here*, which is exactly how someone ends up asking whether the feature works.
  Now *"The measurements have changed. Re-reading this facet."*, or the queued
  count when a retag is still draining.

  Not a blanket "re-tagging in progress" over the whole modal, which the user
  offered and which the third sweep already rejected for the right reason: a
  scoped retag leaves the other facets' measurements entirely current, and
  hiding them behind a notice was defect 20. The re-reading line is per facet
  and only where the evidence actually moved.

  **A crash, found while writing it.** `current` used to be computed FROM the
  entry, so it could not be true without one; 35 made it the server's answer,
  and the `entry.verdict` lookup under it became a null dereference for any
  facet over the rate floor with no diagnosis yet. That is the commonest row on
  any board — every facet is in it until its first diagnosis — and no test
  covered "unstable, never diagnosed". It does now.

- [x] **35. The freshness key needed two halves, and every version so far shipped
  one.** *(fixed — found by the user asking "I have thousands of items and a
  diagnosis, then I add 20 more; does that re-diagnose?")*

  It did, and the re-read was worthless. The sample is read WHOLE, with no
  recency filter anywhere: the worked examples are the eight most-contested
  items on the board and the four **oldest** unanimous ones (`ORDER BY i.id`),
  so twenty arrivals reach neither group, the split values do not move, and the
  model is asked the same question for money. On a board with steady ingestion
  the settle gate is the only bound — three minutes' quiet, up to ten facets —
  so this is defect 1's shape returning through a door defect 32 opened.

  The history, because each fix broke the case the previous one was fixing:

  | key | 2,143 → 2,276 items, 37% both sides | +20 items on 3,000 |
  |---|---|---|
  | rate, bucketed to 5 pts | missed — finding stood forever | correctly ignored |
  | counts, exact (32) | caught | re-read all 3,020 for nothing |
  | **rate bucket + evidence hash** | caught | correctly ignored |

  **The bucket was never the mistake.** Keying on a *summary* and nothing else
  was: with no term for the evidence, a re-measurement that preserved the
  average was invisible. Making the summary sharper (exact counts) was the wrong
  axis — a count is not evidence either, it just moves more often.

  So both terms, each answering what it can. **Evidence**: the split values plus
  the identity and vote tallies of the worked examples, hashed — moves when the
  items the model reasons from change, whatever the average does. **Rate**:
  bucketed to five points — moves when the severity changes, whatever the
  individual items do, because 81% inconsistent and 40% inconsistent are
  different questions over the same eight examples, and the second is far
  likelier to be *"these items really are mixed"*.

  I proposed a 2% relative tolerance on the item count first. It was a round
  number picked between the only two figures in front of me, and the user asked
  where it came from, which was the right question — there was no answer. The
  five-point rate bucket needs no such defence: it is an absolute step on a
  bounded quantity, "the rate moved enough to read differently", not a guess
  about how much churn is too much.

  The reader now takes `current` from the roll-up rather than comparing stats
  itself. Defect 32 had the client recomputing its own version of "has this
  moved", which was correct only while the two implementations agreed — and they
  stop agreeing the moment either is touched, with a facet going silent and
  nothing coming to replace it as the symptom. One function, `sampleKey`, used
  by the loop and by the two read routes; `{ fresh: true }` is off by default so
  the loop's own per-tick roll-up does not pay for an answer it is about to
  compute anyway.

- [x] **34. `DIAGNOSE_SETTLE_MS` 10 min → 3 min.** *(changed, and the reason the
  plan gave for ten turned out not to be a reason)*

  §4 justified ten minutes as *"a bulk retag lands items over minutes and the
  tally moves the whole time"*. That is the OTHER half of the same gate, not
  this half: `retagBoardFacets` arms every eligible row in a single `UPDATE`, so
  `busy > 0` holds for the whole run and drops only when the last item lands,
  and `failOrRequeue` puts a transient failure back into `pending` rather than
  out of the queue. The window never had that job. What it genuinely covers is
  the tail `busy` cannot see: a human correcting items one at a time, where
  `setItemTags` moves the counts with nothing ever queued, and arrivals
  trickling in between batches.

  Against which ten minutes actively starves boards — #16 below, now partly
  answered. Auto-tag's tightest cadence is 15 minutes, so a board on it with a
  five-minute drain never sees a ten-minute quiet spell and is silently never
  diagnosed. Three fits in the gap.

  One thing did get more expensive in the other direction, and it is worth
  naming rather than discovering: defect 32 made the freshness key exact, so a
  diagnosis taken while the counts are still moving is now *guaranteed* to be
  superseded and re-asked, where the old 5-point bucket would often have
  absorbed it. A shorter window therefore buys freshness with the occasional
  wasted call, at roughly 1–2k input and 200 output each. Right side to err on,
  but if diagnose spend ever looks high this is the first knob.

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

Added by the third sweep:

- **23. `MAX_FACETS` takes the first ten qualifying facets, not the worst ten.**
  `candidates` walks `facetRollup` in board order and breaks at ten, so on a
  board with more than ten unstable facets the tail is never diagnosed — not
  "later", never, because the bound is re-applied identically every tick. The
  bound itself is right (§4: a fleet of newly vote-enabled boards must not fan
  out into a burst); ordering the candidates by instability before slicing would
  make it a priority rather than a truncation. No board is near ten today.

- **24. The roll-up is now on an interactive path.** #17 priced `facetRollup` as
  a worker cost. `GET /api/boards/:id/settings` calls it too, so opening the
  board editor runs a whole-board `jsonb_each` plus a queue group-by, on a click,
  synchronously, on every board — including single-pass ones that can never have
  a row in it (see 20). Measure it with #17 and #6.

- **25. `d` covers the facet and nothing around it.** The board `context` sits in
  the same system turn as the facet list, and the model and provider decide what
  the numbers mean at all — none of the three is hashed, so changing any of them
  re-measures under a different tagger with no stamp moving and nothing demoting.
  §2 scoped `d` to the facet deliberately and that is defensible; what is missing
  is anywhere that says so. It is the failure mode the stamp exists to prevent,
  one level up, and the honest answer may be that a model switch is simply out of
  scope — but it should be written rather than implied.

- **26. `updateBoard` and `demoteFacetDiagnostics` are two statements.** Both the
  board-manager PATCH and the admin PUT write the new facets, then demote. A
  crash between them leaves the new wording beside an undemoted finding. It is
  benign today only by accident: `items` collapses under the new stamp, so
  *awaiting* outranks the stale paragraph and the user sees the right thing for
  the wrong reason. The baseline is lost either way, which is defect 10's family
  again.

- **27. `MAX_ATTEMPTS` has no backoff.** Three attempts on the 60-second cadence
  is three calls in three minutes, then silence until the measurements move. The
  webhook precedent it cites (`WEBHOOK_MAX_ATTEMPTS`) spaces its retries; this
  does not. Cheap and probably fine — the cap is what mattered — but the
  precedent is only half-adopted.

- **28. Naming drift the first sweep's rename did not reach.** `KIND_LABELS` in
  `jobs-modal.js` still badges the run **"Facet review"**, a phrase that now
  appears nowhere else in the product; everything else says *Tagging
  consistency*. The row's own label is `j.target`, which for this kind is the
  facet **key** (`mark_type`), not its label — every other kind resolves to a
  display name.

- **29. 0031's header documents a field that no longer exists.** It describes the
  entry shape with `suggestion`, which `PROMPT_VERSION` 2 replaced with
  `rewrite`. The migration comment is the most durable description of this
  column's shape and it is now wrong about it.

- **30. `openDiagnosticsModal` swallows a failed fetch.** `catch { return; }` —
  the button is clicked and nothing happens at all, no toast, no empty modal.
  Every other fetch in this file's neighbourhood degrades visibly; this one is
  indistinguishable from a dead button.

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
