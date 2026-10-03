# Tagging consistency re-runs: two rules (2026-10-03)

**Status: PLANNED 2026-10-03. Stage 1 close-looked, amended and built
2026-10-03 (go-ahead: "go ahead"). Stage 2, the second pass, done the same
day: five fixes, the worst a failed facet that could never be re-read
(asked: "2nd pass and then push to main"). Pushed to main with this plan.
The real-app check is still owed: the app container needs a rebuild, asked
first.**

Self-contained for a fresh session. Written from a read of the consistency
check's code and its history (facet-diagnosis.js, the retag and reprocess
routes, the worker's scheduled re-tag, the tests, `facet-diagnosis-plan.md`
and `facet-diagnosis-loose-ends.md`), and from the live `logos` board's job
log. Parent: `facet-diagnosis-plan.md`, whose §4 "Staleness" paragraph this
replaces.

The user's method applies (memory: close look, then build, then a second
pass): one close read of the stage before building it, a fresh-eyes pass
after.

Line links show the code as of e313640.

## The ask

"i recently tagged the "logos" board, 2.4k items. then today i've been
deleting a bunch of items, and it seems that every time i delete a batch, it
reruns the tagging consisteny check. that doesn't really make sense ... i know
we'd set it up to re-run when a significant change happened, but that should
count additions only, right?"

The first answer was a patch: stop re-running when the examples change, and
make Reprocess mark findings out of date the way Retag does. The reply: "sounds
like spaghetti...? if we were to rethink it based on what we've learned so far
... ?" This plan is the rethink.

## What happened on logos

Every `diagnose` row in `job_log` on 2026-10-03 (UTC):

| time | facet | cards | agreed | disagreed | verdict |
|---|---|---|---|---|---|
| 00:17 | industry | 2,407 | 1,683 | 30.1% | unclear-definition |
| 17:05 | industry | 2,379 | 1,661 | 30.2% | unclear-definition |
| 17:10 | industry | 2,252 | 1,575 | 30.1% | unclear-definition |
| 17:15 | industry | 2,012 | 1,405 | 30.2% | unclear-definition |
| 17:15 | shape | 2,012 | 1,396 | 30.6% | unclear-definition |
| 17:16 | industry | 1,935 | 1,351 | 30.2% | unclear-definition |
| 17:16 | shape | 1,935 | 1,342 | 30.6% | unclear-definition |
| 17:48 | industry | 1,735 | 1,211 | 30.2% | unclear-definition |

- 00:17 was the first run after the board was tagged. Industry's last finding
  was from 28 cards in September (35.7%), so the % had moved. Legitimate.
- shape at 17:15 was its first run since 2026-09-25, when it stood at 42 cards
  and 42.9%. Also legitimate. It had probably sat just under the 30% floor
  until the deletes nudged it over.
- The other six came from the deletes alone. The % didn't move, and each one
  came back with the same verdict. Each also wrote a new time on its finding,
  which lit the dot again and popped "New tagging consistency finding". (The
  17:48 row landed while this plan was being written. By the close look the
  board was at 1,657 measured cards and shape at 29.9%, under the floor.)

Each call was about 2k tokens on gpt-5.4-mini. The money is small; the noise
isn't.

## Why it happens

Today a finding is asked again when any of these changes
([facet-diagnosis.js:512-564](../server/facet-diagnosis.js#L512-L564)):

1. **The question:** the prompt version, and the facet's stamp (its wording,
   its values, one-vs-many, and whether it was measured by a full pass or a
   facet-only retag).
2. **The %:** 5 points or more from what the finding was written about
   (`rateHeld`).
3. **The examples:** a fingerprint of the 12 cards the AI was shown (8 where
   the passes disagreed, 4 where they agreed), with each one's vote tally and
   description.
4. **An "out of date" flag** (`stale`), set when a board Retag or the scheduled
   re-tag queues any of those 12 cards.

Rule 3 is what the deletes trip. The examples are picked oldest first: the 4
agreed ones are the board's 4 oldest, and the 8 disagreed ones go by most
disagreement, oldest first on ties
([db.js:894-911](../server/db.js#L894-L911)). Delete old cards and some
examples go, the next-oldest take their places, the fingerprint changes, and
the check asks again. New cards almost never reach the 12, which is why it
looked like only deletes set it off.

## How it got this way

Rules 3 and 4 were each added for a reason, and each fix opened the next
hole. All of it is in `facet-diagnosis-loose-ends.md`:

- **35** (43b47d6, 2026-08-07): with only the % to go on, a full retag that
  landed on the same 37% went unnoticed. The fingerprint was added.
- **37** (092e0e3): computing it for the screens took the board modal to
  611ms. The key fell back to exact card counts.
- **38** (8256f98): the retag already knew it was re-measuring, so it got to
  say so: the `stale` flag, set by the Retag route and the scheduled re-tag.
  Card-level retags and hand-fixes were left unhooked on purpose, with the
  counts as the backup.
- **7b75f2b:** retagging five cards on a 2,500-card board marked three
  findings out of date. Each finding now stored its 12 cards, the flag was set
  only when a retag touched one of them, and the fingerprint came back, in the
  worker only.
- **39 and 40** (208ed33): a retag armed while a diagnosis was in flight lost
  its flag when the diagnosis landed, so the setter got a compare-and-swap.
  That fix broke the retry cap, which had been leaning on the flag by
  accident.
- **635cb20:** the fingerprint held the 12 cards' ids but not what they said.
- **Today:** deletes trip the fingerprint. And the board's Reprocess button
  re-tags every card without setting the flag, so only the fingerprint
  catches it.

Every piece of that tracks individual cards: which 12 a finding was reasoned
from, and every way one of them can change (deleted, re-tagged, hand-fixed,
reprocessed). Each way needs its own handling, and each one missed has been a
bug.

## What we've learned

- A finding is about the facet's wording, not about particular cards. It
  talks about the facet's values ("these two overlap, here's wording that
  separates them") and never names a card.
- Asking again with the same wording and the same % gets the same answer. The
  five re-runs above show it.
- Any action that has to remember to mark findings out of date is a place to
  miss one.

## The design, plainly

A finding stands while two things hold:

1. **Same question.** Nobody edited the facet (wording, values, one-vs-many),
   its cards are measured the same way as when the finding was written (a
   full pass, or a facet-only retag: going from one to the other counts), and
   no app update changed what we ask the AI.
2. **Same %.** The facet's disagreement % is within 5 points of what the
   finding was written about.

When either breaks, the check asks again once the board settles. Nothing else
re-runs it. Adding, deleting, hand-fixing, retagging, reprocessing and the
scheduled re-tag all count only through the %.

One function answers "does this finding still stand", and both the background
check and the screens call it.

## What changes for you

- Deleting or adding cards doesn't re-run the check unless the % moves 5+
  points.
- Same for hand-fixing tags, a board Retag, Reprocess and the scheduled
  re-tag. Today a Retag always re-runs it, and a board on a timer re-runs it
  after every pass.
- While a retag runs, the modal's banner says which facets are being
  re-tagged and that their figures are partial, as today. A facet's finding
  stays as it was until the retag finishes. (Today a retag hides it behind
  "Re-tagging this facet — N items still queued. A fresh reading follows.")
- The fix loop works as now: edit the facet, retag, and it checks the new
  wording and shows before/after.
- "New tagging consistency finding" pops far less often.
- The findings you have now stay as they are. The update doesn't re-run them
  or light any dots.

## What we give up

- If a retag reshuffles which cards disagree but the % lands in the same
  place, the old explanation stays up. Same wording and same %: the answer
  would be the same, as the five re-runs show.
- If the board's AI model or description changes and a retag lands within 5
  points, no re-run. Already true today for a model change with no retag
  (loose-ends #25).

## The contract

- `questionOf(segment)` returns `` `v${PROMPT_VERSION}|${segment.d}` ``. It is
  stored as `k` on every entry, finding or failed attempt, as today minus the
  fingerprint. Exported (a test fixture writes it).
- `stands(entry, segment)` returns
  `entry?.k === questionOf(segment) && rateHeld(entry, segment)`: the only
  answer anywhere to "is this finding current". An entry with no `k` never
  stands. (Exported in Stage 1; nothing imported it, and the second pass took
  the export off.)
- The roll-up (`facetRollup`): `current = stands(diagnostic, segment)` for
  every facet with an entry, and `remeasuring`: of the queued cards that will
  write the facet, the ones still carrying an answer (Stage 2, D4).
- The check (`candidates`): a facet is asked about only when its entry doesn't
  stand (`current`), or stands with no verdict and fewer than 3 tries, or
  with 3 tries the last of them a day ago or more (Stage 2). That test comes
  BEFORE the 10-facet limit (D8). It reads nothing beyond the roll-up it
  already has.
- The paid half (`diagnoseAnswer(db, deps, board, facet, segment, ai)`): reads
  the examples and the split values itself, once, when a call is going to be
  made. The finding it writes has no `evidence`.
- `setFacetDiagnostic(db, boardId, key, entry)`: a plain merge of one facet's
  entry.
- The screens (`diagnosisState`): while a retag is re-measuring enough of a
  facet's cards to make its % partial, a stored finding is shown as it was,
  at its own rate, not judged against the partial numbers (D4, amended at
  Stage 2). "Couldn't re-read" only while the failed question still stands.
- The boards page (`storedFindingAt`): no `stale` check; otherwise unchanged.
- Nothing marks findings. Only two things write `facet_diagnostics`: the
  check, and the demotion when a facet is edited (plus a backup restore,
  which loads it whole).
- Migration 0058: every stored `v3` key comes down to `v3|<stamp>` (the
  fingerprinted shape, and the older bucket-and-ids shapes, Stage 2), and
  `stale` and `evidence` are removed from every entry. Safe to run twice.

## What's there to build on

- `rateHeld` is already the one 5-point test, shared by the check and the
  roll-up ([facet-diagnosis.js:469-473](../server/facet-diagnosis.js#L469-L473)).
- `facetStamp` and `pickSegment` already give each facet its stamp, full or
  facet-only ([facet-diagnosis.js:76-131](../server/facet-diagnosis.js#L76-L131)).
- The demotion on a facet edit already clears the verdict and keeps the
  before numbers ([db.js:850-875](../server/db.js#L850-L875)).
- `sampleThin` already says when a facet's figures are partial, and the
  modal's banner uses it ([facet-diagnosis.js:159-163](../public/facet-diagnosis.js#L159-L163),
  [facet-diagnostics.js:303-318](../public/facet-diagnostics.js#L303-L318)).
- A finding already stays shown while its own retag drains, on purpose:
  "Partial, but partial of something — the banner is what says so"
  ([facet-diagnostics-ui.test.js:635-639](../test/facet-diagnostics-ui.test.js#L635-L639)).
- The retry cap already resets when the question or the % changes. It keeps
  doing so, with `stands` as the test.
- Migration tests already run a migration's SQL against rows written after
  startup ([alerts.test.js:1090](../test/alerts.test.js#L1090)).

## Decisions (for the close read to confirm or overturn)

- **D1: two rules, one function.**
  - Same question: the prompt version and the facet's stamp `d`, which already
    covers wording, values, one-vs-many and full vs facet-only measurement.
  - Same %: `rateHeld`, a 5-point tolerance measured from the finding's own
    numbers (a tolerance, not a bucket: 786927f). A facet that drifts 3 points
    and then 3 more re-runs, because the comparison is always to the finding.
  - `stands` is used by both the check and the roll-up, so the screens and the
    check can't disagree. Today the screens read the flag and the %, and the
    check reads the key, the %, the flag and the verdict.
  - After a facet-only retag, the new stamp is what makes the old finding
    show "Re-reading this facet" until the check answers. Today the flag does
    that, and the screens never look at the stamp.

- **D2: nothing tracks individual cards.**
  - No fingerprint, no list of the 12 cards on a finding, no flag, and no
    action that marks findings.
  - What goes: questionKey's fingerprint, `exampleKey` and `tallyKey`;
    `evidence` on the entry; `supersedeFacetDiagnostics` and its two callers
    ([server.js:2474-2478](../server/server.js#L2474-L2478),
    [worker.js:2065-2067](../server/worker.js#L2065-L2067)); `queuedAmong`;
    `setFacetDiagnostic`'s compare-and-swap
    ([db.js:776-798](../server/db.js#L776-L798)); the `stale` handling in
    `facetRollup`, `storedFindingAt`, `candidates`' order and
    `diagnoseQuestion`.
  - Why: see "What we've learned".

- **D3: the examples are read only when a call is made.**
  - Today the check ranks the examples for every flagged facet every minute
    (two queries a facet) to compute the fingerprint. After this, the check
    reads nothing beyond the roll-up, and `diagnoseAnswer` reads the examples
    once, for the prompt.
  - `diagnosisSample`'s `examples` parameter goes; it existed so the check
    could hand its read down.
  - How the examples are picked doesn't change.

- **D4: while cards are queued on a facet, its finding is shown as it was.**
  (Amended at the Stage 1 close look. The plan had such a facet show
  `measuring` instead, which would have hidden every finding during any big
  upload, and undone a decision the tests already pin. Close-look finding 1.)
  - When `sampleThin(row)`, a stored finding (or note) isn't judged against
    the partial numbers: the server's `current` and the rate floor are both
    set aside until the queue empties. The modal's banner already says which
    figures are partial.
  - Without it, a full retag would show the finding, "Re-reading this facet"
    or nothing at all by turns, as the % of the cards landed so far wobbled
    around the finding's and the 30% floor.
  - Below 20 measured cards the existing `measuring`/`awaiting` states still
    come first, as today.
  - "A fresh reading follows" (the re-reading text with cards queued) is then
    reachable only for a failed attempt, where the retry is real.
  - Reversed: a finding the flag had superseded, with its retag still
    draining, said "Re-tagging this facet — N items still queued. A fresh
    reading follows." A retag no longer supersedes anything, so that finding
    stays shown.
  - Amended at Stage 2 (second-pass findings 2 and 3): keyed on the cards
    being RE-measured (`remeasuring`: queued cards still carrying an answer),
    not on every queued card, so an upload's cards leave the finding judged
    on whole figures; and shown at its own rate, not the landed cards'.

- **D5: findings from before the update keep standing.**
  - Migration 0058 rewrites each stored key to the new form and removes
    `stale` and `evidence`. No burst of re-runs, no dots lit across boards.
  - `PROMPT_VERSION` stays 3: what we ask the AI doesn't change.
  - Rejected: taking the one-time re-run, as the last two key changes did
    (635cb20, 786927f). It lights a dot on every board with Double-check tags
    on, which is the noise this plan removes.
  - Rejected: comparing only the first two parts of the key from now on. A
    rule for old data that outlives its reason.

- **D6: considered and rejected.**
  - **Re-run when the board grows a lot** (the first instinct: "that should
    count additions only"). Growth that moves the % already re-runs. Growth
    that doesn't barely changes what the AI is shown, since the 4 agreed
    examples are the board's oldest cards and the 8 disagreed ones favor
    older cards on ties, so it would ask nearly the same question again. And
    any count threshold is a guess: 35's 2% proposal had no answer to "where
    does that come from".
  - **Keep the fingerprint but ignore deleted cards** (one fingerprint per
    card). More machinery for the same answer.
  - **Make Reprocess and card-level retags set the flag** (the first proposal,
    2026-10-03). One more place to remember, and the next one forgotten is
    the next bug.
  - **Re-run after every board Retag.** Same wording, same %, same answer
    (D2).

- **D7: not in this plan.**
  - The gates (Double-check tags on, the board quiet for 3 minutes, 20+
    cards, 30%+ disagreement), the 3-try cap, the demotion on a facet edit
    and the before/after, the 10-facet limit and its worst-first order (D8
    only changes what it is taken from).
  - The dot and the toast, lit by when a finding was written. A re-run that
    is supposed to happen still pops "New tagging consistency finding" when
    it says the same thing as before. Under D1 that's rare.
  - The board's AI model and description joining the question (loose-ends
    #25).
  - A "check again" button, for when D1 leaves a finding standing that
    someone wants re-read. Not built until asked.
  - Loose-ends #14 (a diagnosis in flight can undo the save that demotes it):
    about `previous`, not the flag, and unchanged.

- **D8: findings that stand are skipped before the 10-facet limit.**
  (Added at the Stage 1 close look, finding 2.)
  - `candidates` took the 10 worst unstable facets and only then let
    `diagnoseQuestion` skip the ones that stand. On a board with 11 or more
    unstable facets, the 11th was never looked at, even with its % moved,
    while 10 worse ones held the slots. The flag's "out of date goes first"
    order covered retags only; the hole was there for every other change.
  - Whether a finding stands now costs nothing, so `candidates` skips those
    first and takes the worst 10 of what's left. `diagnoseQuestion` goes; the
    key is resolved once per board.

## Stages

### Stage 1: the two rules

(Close-looked 2026-10-03 and amended. Go-ahead the same day: "go ahead".)

**Stage 1 close look (2026-10-03): what the plan assumed vs what the code
does.**

1. Assumed cards queued on a facet meant a retag was running, so such a
   facet would show `measuring` (the old D4). The queued count is every card
   waiting to be tagged, new uploads included (`boardQueuedScopes` counts all
   of `TAG_QUEUE`, and an upload enters `pending`). A 500-card upload to logos
   would have hidden every finding until it was tagged. And a test already
   pins the opposite on purpose: "a facet with a real sample reports it even
   while its own retag drains" (facet-diagnostics-ui.test.js:635). D4 is
   rewritten: while cards are queued, a finding is shown as it was, not
   judged against partial numbers.
2. Assumed dropping the "out of date goes first" order was cleanup. It was
   the only thing keeping a facet past the 10-facet limit from waiting for
   good, and only for retags (D8). Whether a finding stands is now free, so
   standing findings are skipped before the limit.
3. Assumed every stored finding has a key. Every live one does (four `v3`,
   two `v2`), but test/browser/toolbar-fold.test.js stores a finding with
   none and waits for its dot. Under `stands` it would read "Re-reading this
   facet" and the dot would never light. The fixture gets a key, which is why
   `questionOf` is exported.
4. Smaller: logos had a seventh run at 17:48 (in the table); "same question"
   also breaks when a full retag follows a facet-only one, since the
   measurement flips back (wording fixed in "The design, plainly"); the
   real-app check expected six rewritten keys, but only the four `v3` ones
   are (color and typography keep their `v2` keys, an older question, both
   under 30%).

Checked and fine: only `diagnosisState` reads `current`; nothing outside the
module reads `evidence` or calls `questionKey`, `facetEvidence` or
`queuedAmong`; migrations run in a transaction, and a restore runs the ones
an older archive lacks after loading its data (backup.js), so 0058 covers
restored findings; board copies don't carry findings; the edit → retag →
before/after tests and the cap tests don't touch the flag.

**Server.**
- facet-diagnosis.js: `questionOf` and `stands` (D1) replace `questionKey`,
  `exampleKey`, `tallyKey` and `sameQuestion`. `candidates` skips findings
  that stand before taking the worst 10 (D8), and `diagnoseQuestion` goes:
  `diagnoseCandidates` resolves the key once per board. `diagnoseAnswer`
  reads the sample itself and writes no `evidence`. `facetRollup` sets
  `current` from `stands`. `candidates` orders by how bad the facet is,
  nothing else. `storedFindingAt` drops its `stale` check. `diagnosisSample`
  drops `examples`, and `facetEvidence` folds into it.
- db.js: `setFacetDiagnostic` becomes a plain merge.
  `supersedeFacetDiagnostics` and `queuedAmong` go.
- server.js and worker.js: the two `supersedeFacetDiagnostics` calls, their
  comments and their imports go. The Reprocess route
  ([server.js:2490](../server/server.js#L2490)) needs nothing: it was never
  hooked.
- Migration 0058 (D5).

**Page.**
- public/facet-diagnosis.js: D4 in `diagnosisState`'s `current`. Its
  comments that describe the flag or `sampleKey` say what `current` is now.
  (The `stale` it reads elsewhere, `row.stale`, is a different thing, a count
  of cards measured under older wording, and stays.)
- facet-diagnostics.js: nothing. "A fresh reading follows" stays, reachable
  only for a failed attempt with cards queued, where the retry is real
  (confirmed at the close look).

**Comments and docs.**
- The "is a stored finding still current?" block
  ([facet-diagnosis.js:409-456](../server/facet-diagnosis.js#L409-L456)) is
  rewritten as the two rules. Comments that explain the removed machinery go
  with it (`diagnoseAnswer`'s notes on the flag, facetExamples' "these rows
  ARE the freshness key", the setter's compare-and-swap table).
- `facet-diagnosis-plan.md` §4 "Staleness" and `facet-diagnosis-loose-ends.md`
  get a one-line pointer to this plan. Their history stays as written.

**Tests.**
- Go (they test the flag or the fingerprint), all in facet-diagnose.test.js:
  - "a re-measurement of the evidence items re-diagnoses"
  - "arming a retag supersedes the finding immediately, before an item lands"
  - "a retag that misses the twelve leaves the finding alone"
  - "a scoped retag supersedes only the facets it names"
  - "a re-measurement that reproduces the counts is caught by what the twelve SAY"
  - "a retag armed DURING the provider call survives that call's own write"
  - "…but a pass that ANSWERS a stale mark still clears it"
  - "a recorded failure never clears a stale mark either"
  - "…and MAX_ATTEMPTS still bounds a SUPERSEDED finding" (the cap is still
    covered by "a provider error is recorded, retried a bounded number of
    times, then left alone", and its reset by "attempts reset when the
    measurements actually move")
  - "…and a superseded finding outranks severity, because the reader promised it"
  - "…and when a full retag marks ALL of them, the tail waits one tick, not for ever"
  - Plus boards-signals.test.js "a stale entry does not light" and its
    fixture.
- Change:
  - "a retag is a retag on a MAPPED board too" and "…and every in-flight state
    counts": drop the flag assertions. What's left (the board stays busy, and
    the screens are told a pass is running) is still true and still needed.
  - "…and it keeps the stats that are the NEXT baseline": its setup moves the
    % 4.2 points and leaned on the fingerprint to get a re-run. Move it 5+.
  - "…but a change that reaches none of the twelve": folded into new test 2.
  - "a trickle of new items does NOT re-diagnose": its comment, which explains
    it through the 12.
  - "diagnoseCandidates: hands out a real question…": the unit carries `ai`
    itself now.
  - facet-diagnostics-ui.test.js "a superseded finding says a re-reading is
    coming": its draining half shows the finding now (D4's reversal).
  - test/browser/toolbar-fold.test.js: the stored finding gets a key
    (close-look finding 3).
- New, each run with its fix taken out first:
  1. Deleting the cards a finding was reasoned from, at an unmoved %, doesn't
     re-run. Fails with the fingerprint back.
  2. A board Retag that lands at the same % doesn't re-run; one that lands 5+
     points away does. The first half fails on e313640, where the flag
     re-runs it.
  3. A facet-only retag (new stamp) re-runs, and until it does, the roll-up
     calls the old finding not current. Fails with the key taken out of
     `stands`.
  4. A finding stored before the update (three-part key, `stale`, `evidence`)
     still stands after 0058's SQL runs, isn't re-run, and has lost the two
     fields. Fails with the migration skipped.
  5. A tick with nothing changed reads no examples (count the queries). Fails
     with the ranking put back in the check.
  6. `diagnosisState`: with cards queued, a stored finding shows even when
     the server says it doesn't stand and when the landed cards read under
     30%. Fails without D4.
  7. On a board with eleven unstable facets, all diagnosed, the least
     unstable one is re-asked once its % moves (D8). Fails with the skip
     moved back after the limit.
  8. (Added while building.) In a real browser, the Tagging consistency
     modal mid-retag shows the finding under the banner, not "A fresh
     reading follows". Fails without D4.

**Real-app check.**
- Rebuild the app container (asked first), then, read-only on the live
  database: logos' four `v3` findings have two-part keys, color and
  typography keep their `v2` ones, nothing else changed, and no `diagnose`
  row lands in `job_log` after the restart (only industry is over 30%, and
  it stands).
- The user deletes a batch on logos. No `diagnose` row lands and no "New
  tagging consistency finding" pops.
- What the screens show mid-retag is proved in the browser harness
  (test/browser/harness.js, a throwaway database), never with a session in
  the real one.

**Built 2026-10-03, uncommitted.**
- server/facet-diagnosis.js: `questionOf` and `stands`. `candidates` drops
  findings that stand, and questions that used their tries, before the
  10-facet limit, and orders by how unstable a facet is, nothing else.
  `diagnoseCandidates` resolves the key once per board and a unit carries it
  as `ai`. `diagnoseAnswer` reads its own sample. `facetRollup`'s `current` is
  `stands`. `storedFindingAt` lost its `stale` skip. Gone: `questionKey`,
  `exampleKey`, `tallyKey`, `facetEvidence`, `sameQuestion`,
  `diagnoseQuestion`.
- server/db.js: `setFacetDiagnostic` is a plain merge. Gone:
  `supersedeFacetDiagnostics` and `queuedAmong`.
- server/server.js, server/worker.js: the two hooks, their comments and
  imports.
- server/migrations/0058_diagnosis_question_key.sql.
- public/facet-diagnosis.js: D4, in `current`. public/facet-diagnostics.js:
  two comments.
- Pointers in facet-diagnosis-plan.md §4 and facet-diagnosis-loose-ends.md.

Decided while building:
- `facetExamples` no longer selects the item id. Nothing reads it once the
  fingerprint and the stored card list are gone; its ORDER BY still uses it.
- A unit carries `ai` itself rather than a `q` bag, since the key is all that
  was left in it.
- A browser proof of D4 was added (test/browser/tagging-consistency.test.js),
  since the plan's real-app list asked for the mid-retag screens in a real
  browser and the state-function test alone isn't that.

Proofs (new, and the tests changed to fit, listed above). Each new one run
with its fix taken out first, by a script that restored every file
byte-identical after each (checked by sha256):

| removed | failed |
|---|---|
| F1+F2: facet-diagnosis.js and db.js as at e313640 (the fingerprint and the flag) | deleting the cards a finding was reasoned from; a board retag at the same rate (both: 2 calls, expected 1) |
| F3: the key out of `stands` | a facet-only retag is a different question (`current` true, expected false) |
| F4: 0058 a no-op | 0058 keeps a finding from before the update standing |
| F5: the worked examples read in `candidates` again | a pass with nothing to ask reads no worked examples |
| F6: findings that stand skipped after the limit, as before | the tail is diagnosed on the next pass, and re-asked when its rate moves |
| F7: D4 out | with cards queued, a stored finding is shown as it was; the draining half of "a superseded finding says a re-reading is coming" |
| F8: the toolbar fixture's finding without a key | browser: toolbar-fold's ticks' dot never lights (close-look finding 3) |
| F9: D4 out | browser: mid-retag, the finding stays as it was under the banner |

F3's first mutation (`rateHeld` alone) made a missing entry "stand" and
crashed `candidates` on `prior.verdict`: a failure for the wrong reason. The
real `stands` is false for a missing entry by construction, since it has no
key. Rerun as `!!entry && rateHeld(...)`, it failed on the assertion.

Lint clean. Full suite (`npm test`, browser tests included): 2,334 of 2,334,
first run. The new browser file, written while it ran, passed on its own
(1 of 1).

Real-app check: owed. It needs the app container rebuilt, which is asked
first.

### Stage 2: second pass

Fresh eyes on the whole diff, then simplify.

(Asked 2026-10-03: "2nd pass and then push to main". One read-only reviewer,
never shown this plan, compared HEAD with the working copy; I checked the
plan's claims, the test setups and the packaging. Every finding was re-read
in the code before acting.)

**Found and fixed:**
1. A question out of tries never came back. In e313640 a retag rewrote the
   twelve examples, so the fingerprint moved and the facet got a clean slate;
   now a retag that lands at the same rate is the same question, so a dead
   key or an outage fixed since left the facet "Couldn't re-read" for good,
   under copy promising "It will try again when the measurements next
   change". A question out of tries now rests a day (`RETRY_AFTER_MS`), then
   gets one more; a failure that persists costs one call a day. The copy says
   "It tries again within a day."
2. While a retag ran, a finding shown "as it was" sat under the landed
   cards' %: the new browser test's own fixture rendered "contradicted itself
   on 80%" over a paragraph written at 40%, and a facet dipping under the
   floor read 8% in amber. It's shown at its own rate now, which makes "as it
   was" true.
3. D4 keyed on every queued card, so an upload's cards (which take nothing
   out of the sample) brought back a finding that had stopped standing, lit
   the dot and fired "New tagging consistency finding" and its chime on
   every upload. D4 now keys on the cards being re-measured: the roll-up's
   new `remeasuring`, from `boardQueuedScopes`' `measured` (queued cards
   still carrying an answer). An upload leaves the finding judged on whole
   figures. A board Reprocess clears answers, so it isn't counted either;
   its figures are judged as they land, as at e313640.
4. "Couldn't re-read this facet" showed while the loop was about to ask
   again (the question or % had moved, so the tries start over). Older than
   this plan, but `current` is now exactly the loop's test: the state needs
   the failed question to still stand.
5. 0058 rewrote only the fingerprinted `v3` keys. A `v3` key from before
   (a rate bucket and the examples' ids, 635cb20 and 786927f) answers the
   same question and now comes down to `v3|<stamp>` too. This box has none;
   another install might.

**Simplified, behavior unchanged:**
- `candidates` reads the roll-up's `current` instead of calling `stands`
  again; `stands` and `rateHeld` lose their exports (nothing imported them).
- `diagnoseAnswer` takes the finding from the segment, not as a separate
  argument; the unit, `diagnoseDue` and the worker's kind lose `prior`.
- `diagnoseCandidates` no longer checks that a candidate's facet is declared:
  the roll-up is built from the same list.
- `facetRollup` builds each row in one pass instead of a map and a loop.
- Stale words: "sampleKey" and "when the evidence did not move" in the UI
  tests, the "freshness string" comment, `RATE_BUCKET` (now
  `RATE_TOLERANCE`, the server's word for the same five points), and the
  boards-page test's `mood` facet, kept only for the deleted fixture.

**Recorded, not fixed:**
- The modal's banner says "A re-tag is running on X" during a big upload
  too, and the `measuring` state says "Re-tagging this facet" on a first
  pass. Both count every queued card, as before this plan.
- A retag started within minutes of a finding's % moving, before the loop
  re-asks, shows that finding as it was until the retag lands, and lights
  the dot if it's unseen. The loop re-asks once the board settles.
- A finding nobody has opened goes dark when a full retag starts (fewer than
  20 measured cards, `measuring`) and lights again once 20 land, which
  announces it once more.

**Checked and fine:** only the check and the facet-edit demotion write
findings; the production build builds, and toolbar-fold and
tagging-consistency pass against it (`FRONTEND_DIR=public/dist`, 10 of 10);
the image builds the frontend itself and copies the migrations; 0058 handles
every stored shape (findings, failed attempts keep `attempts`/`error`/`asked`,
demotions carry no `k`, `v2` keys stay).

**Proofs added:**
- facet-diagnose.test.js: a question out of tries rests a day, then gets one
  more; a retag's queued cards count as re-measuring and an upload's don't;
  0058 brings a bucket-and-ids `v3` key down to its question; the
  same-rate retag now also checks the pass could reach the facet (the board
  quiet, the finding current), and "lands five points away" became "moves
  the rate" (it moves 14).
- facet-diagnostics-ui.test.js: the finding shown mid-retag carries its own
  40%, not the landed 80%; an upload's queued cards leave it judged; five
  re-measured cards of 2,228 leave it judged (the five-point line, which no
  test pinned); "couldn't re-read" gives way to "re-reading" once the
  question or % moves.
- The browser test checks the headline: "contradicted itself on 40%".

| removed | failed |
|---|---|
| P1: no rest for a question out of tries | rests a day, then gets one more (3 calls, expected 4) |
| P2: the live partial rate under a finding shown as it was | its own numbers with it (0.8, expected 0.4) |
| P2b: the same | browser: mid-retag, the finding stays as it was |
| P3a: every queued card counted as `measured` | a retag's cards count as re-measuring (40, expected 10) |
| P3b: D4 keyed on every queued card again | an upload's queued cards leave it judged (`finding`, expected `rereading`) |
| P4: "couldn't re-read" regardless of `current` | a provider failure does not take the facet silent |
| P5: 0058 matching only the fingerprinted shape | 0058 keeps a finding standing (the bucket-and-ids key left whole) |
| F5', F6', F7', F9': Stage 1's checks on the code this pass restructured | as at Stage 1 |

All twelve failed with their fix out, each on the expected assertion, every
file restored byte-identical (sha256). Lint clean. Full suite (`npm test`,
browser tests included): 2,338 of 2,338, first run.

Real-app check: still owed (the app container needs a rebuild, asked first).

## Gains, plainly

- Deleting, adding or hand-fixing cards doesn't re-run the check unless the %
  moves 5+ points.
- Neither does a Retag, Reprocess or the scheduled re-tag. Boards on a timer
  stop re-running it after every pass.
- One rule in one function, used by the check and the screens.
- Nothing to remember when a new way to change cards is added.
- The check stops ranking examples every minute.
- Less code: the fingerprint, the flag, its hooks and its guard, and about a
  dozen tests about them.

## Risks and edges

- **What we give up** (above): a retag that reshuffles which cards disagree
  at the same % keeps the old explanation.
- **The 5-point tolerance carries more weight**, being the only trigger the
  data can pull. It is measured from the finding's own numbers, so slow drift
  adds up and re-runs once it passes 5.
- **Hand-fixes and deletes that push a facet under 30%** make it go quiet, as
  today. If the facet climbs back over and its % is within 5 points of its
  finding, the old finding shows again, with no re-run.
- **A facet sitting on the 30% line** (logos' industry and shape, at 30.1-30.6%)
  goes quiet and comes back as cards come and go. No calls, since crossing
  the line doesn't change the question, but the finding blinks in and out of
  the modal. As today.
- **Tabs open across the deploy** read `current` from the server and hold no
  key logic of their own, so they show the new answer on their next fetch.
- **Backups from before the update** restore through the migrations
  (backup.js), so 0058 rewrites their keys too.
