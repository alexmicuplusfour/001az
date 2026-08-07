# Facet diagnosis — implementation plan (rev. 3, 2026-08-07)

Vote mode (`tagging-accuracy-plan.md`, shipped) tells a user **that** a facet is
unreliable. This tells them **why**, proposes a wording fix, and — new in rev. 2
— lets them **verify the fix actually worked**.

That third leg is facet-addressable tagging (`facet-addressable-tagging-plan.md`,
shipped in 65ea508). Rev. 1 of this plan was written before it existed and its
last open question was, in effect, *"once the user takes our advice, how do they
find out whether it helped?"* — which had no good answer, because applying the
fix meant a full retag that re-rolled all nine facets at 18–22% instability. The
edit and the noise were indistinguishable. A scoped retag re-rolls the one facet
you changed, so the next measurement is attributable.

## What changed from rev. 2

A read against the code rather than against the plan. Rev. 2's architecture
stands; what follows are defects in how it said to build it. Six of the seven
would have failed silently.

1. **Gate 5 was unsatisfiable** (§1, §4). `d` folds `scoped` in, so a facet has
   *two* current stamps, and every query took one. Match the full stamp and the
   scoped retag this plan prescribes writes a stamp the gate cannot see, so the
   verification leg never fires; match the scoped one and no board qualifies at
   all, because none has been scope-tagged. Either way the feature reads as
   "quiet today". The gate now resolves a stamp *set* to one segment (§1).
2. **The stored entry could not answer state 5's question** (§3).
   `previous.scoped` existed; the current entry's shape did not, so *"these two
   measurements came from different prompt shapes"* was not computable from what
   was stored.
3. **1b ranked the stable value first** (§1b). Summing the raw tally across
   disagreeing items measures frequency, not tension — a value every run picks
   tops the list precisely because nobody disputed it. It now counts splits.
4. **`setItemTags` deletes the evidence** (§10). A human correction drops the
   confidence entry for the facet it touched, which is the contested facet. A
   curated board under-reports its own instability, and state 5 can read
   "improved" off curation rather than off the user's edit.
5. **`updateBoard` cannot diff** (§3, §8). It never reads the row, and the modal
   sends `facets` on *every* save — so a demotion keyed on `facets !== undefined`
   wipes every finding on the board when someone renames it.
6. **`ICONS.sparkle` is taken** (§6): it is the connector chip on the boards
   page, where it already means "AI-extracted fields".
7. **The probe's agreement figure carries the same caveat as its token figure**
   (§2), and rev. 2 applied it to only one of the two.

## What changed from rev. 1

Read this first if you know the old plan; the rest is written to stand alone.

1. **The loop closes.** Diagnose → edit the gloss → re-tag *that facet* → measure
   again. §0 states it as the product; §7 costs it.
2. **`tag_confidence` entries gain a definition stamp** (§2). Without it, rev. 1
   would re-diagnose a facet using measurements taken under a gloss the user
   already replaced — and print a paragraph complaining about wording that is no
   longer there. Facet scope turns that from an edge case into the normal path.
3. **A facet's diagnosis is demoted, not dropped, on edit** (§3) — the old stats
   are the baseline for "was 60%, now 88%".
4. **Two new UI states** (§6): *awaiting re-measurement* and *improved*. Rev. 1
   could only ever render problems, so a user who fixed a facet saw the finding
   vanish and never learned they had succeeded.
5. **The roll-up must exclude undecided items** (§1). Rev. 1's queries filter
   `status='tagged'`, which does not do that — the same trap that produced
   `facet-scope-loose-ends.md` #8, found again here in a query.
6. **No action lands in the board modal** (§6), per the correction recorded as
   `facet-scope-loose-ends.md` #10.
7. **A contrast set of unanimous items** joins the contested examples (§1d).
   Showing the model only failures makes the `genuinely-ambiguous-items` verdict
   unreachable in practice, so every board would have read as broken.
8. **A discovery path** (§6): a **Tagging consistency** button in the gallery header,
   beside the edit pencil, with an unseen dot. Nobody opens a board modal to
   learn that something is wrong. It carries a prerequisite —
   `vote-mode-loose-ends.md` #6, filed as untidiness, is what makes its gate
   computable.

Points 7 and 8 came out of the question *"where would we display the suggested
fix, and would a per-item diagnostic run even have enough context?"* — the answer
to which is §"What this is not", strengthened below with the argument that
carries it: at n=1 the distinguishing signal is absent, not merely weak.

## 0. Why this is the payoff, not a nice-to-have

Measured on the live instance after vote mode shipped (25 items, 3 passes,
`gpt-5.4-mini`):

```
facet          unanimous   mean agreement
construction        60%             0.85
industry            64%             0.88
shape               72%             0.89
...
mark_type           88%             0.96
presentation       100%             1.00
```

The spread is not random. Facets whose values are **mutually exclusive by
construction** sit near 100%; facets with **values that can both be true of one
item** sit near 60%. `presentation` cannot be two things at once. A wide lockup
is genuinely horizontal *and* rectangular *and* asymmetric.

So instability is a **taxonomy-authoring** defect with one recurring shape, and
one recurring fix: a precedence rule in the facet description. Precedent for the
size of that fix — a single gloss edit on the `ui` board moved 228 of 498
re-tagged items, every one in the same direction.

More passes cannot help. At 5 votes the unresolved multi-value facets get
*emptier*, not settled (construction 20% → 38% empty), because the estimator
sharpens on "the model has no stable opinion". There is nothing to converge on.
The taxonomy has to change.

**The three legs only work together.** Vote mode without diagnosis is a number
with no next step. Diagnosis without scoped retag is advice you cannot check.
Scoped retag without diagnosis is a precise tool with nothing telling you where
to point it.

## What this is not

- **Not a tiebreaker.** Nothing here picks a winner for an item. Shown its own
  contradictory outputs and asked to resolve them, a model reliably produces a
  fluent justification for whichever it lands on. The output would read
  authoritative and mean nothing.
- **Not per item — and the reason is identifiability, not cost.** A facet that
  fails on 18 items is one broken facet observed 18 times. But the decisive
  argument is that a single item cannot carry the finding: three runs splitting
  between `monoline-linework` and `gradient-blend` on one logo is *equally*
  consistent with "these two values overlap definitionally" (fixable, a taxonomy
  bug) and "this particular mark genuinely is both" (not a bug at all).
  Recurrence across items is the only thing that separates them, so at n=1 the
  signal is absent rather than weak — and the model, asked anyway, returns a
  confident paragraph either way.

  It also has nowhere to live. A per-item diagnosis renders in the lightbox side
  panel, differs on every item, and forces the user to read eighteen of them
  before the pattern appears — when the pattern **is** the finding. Board-level
  rendering is not an optimisation of per-item rendering; it is the only place
  the reported thing exists.
- **Not automatic editing.** The model proposes wording. The user owns the
  taxonomy.
- **Not a measurement of tagging *correctness*.** Everything here reads
  self-consistency. A facet the model applies wrongly but consistently scores
  100% and is invisible to this feature. Say so in the copy.

## 1. The data it reads

No images, no human inspection — four queries over `tag_confidence`, which vote
mode already writes per item as `{of, agreed, votes}` with `votes` carrying the
full tally *including the values that lost*.

**Every query excludes undecided items.** `status='tagged'` does not do this: the
verdict rides its own column, so an undecided item is a tagged one
(`facet-scope-loose-ends.md` #8, the same mistake in the queue). It matters more
here than it did there, and in the direction that flatters us. An undecided item
has most facets empty, every run picked `[]`, so `agreed === of` and the facet
scores **unanimous** — items the model explicitly declined to place would be
counted as evidence that the taxonomy is working, and would crowd the contrast
set in 1d with items that have nothing in them. `AND NOT i.undecided`, four
times.

**Every query is also confined to one prompt shape.** `$3` below is a single
stamp, and it is *not* "the facet's current stamp" — §2 gives a facet two
current stamps, full and scoped, and the whole point of folding the flag in is
that they must never pool. So the reader resolves which one it is working in
before it asks anything else: compute both, count items under each with 1a, and
take the segment with more items, ties to the scoped one (it is the shape the
loop keeps writing). Everything downstream — 1b, 1c, 1d, gates 3–5, the stored
entry — uses that stamp alone, and §3 records which shape it was.

The two segments are rarely close, because a scoped retag replaces that facet's
confidence entry on every item it lands on: the old segment drains as the new one
fills. What the retag cannot reach — failed, held and undecided rows — keeps the
old stamp, which is why the rule is "more items" rather than "any scoped item
wins".

**1a. Per-facet health** (drives the gate and the "18% of items" line in the UI):

```sql
SELECT count(*) AS items,
       count(*) FILTER (WHERE (e.value->>'agreed')::int = (e.value->>'of')::int) AS unanimous
FROM items i, jsonb_each(i.tag_confidence) AS e(key, value)
WHERE i.board_id = $1 AND i.status = 'tagged' AND NOT i.undecided
  AND e.key = $2 AND e.value->>'d' = $3;   -- $3 = the chosen segment's stamp (§2, and above)
```

Run twice per facet, once per stamp, to choose the segment. It is the same query
that then gates and populates the UI, so choosing costs nothing extra.

**1b. Where the runs actually parted** — the values some runs picked and others
didn't, counted once per item rather than summed:

```sql
SELECT v.key AS value, count(*) AS split_on
FROM items i, jsonb_each(i.tag_confidence) AS e(key, value),
     jsonb_each(e.value->'votes') AS v(key, value)
WHERE i.board_id = $1 AND i.status = 'tagged' AND NOT i.undecided
  AND e.key = $2 AND e.value->>'d' = $3
  AND (e.value->>'agreed')::int < (e.value->>'of')::int
  AND v.value::text::int < (e.value->>'of')::int  -- not every run picked it
GROUP BY 1 ORDER BY 2 DESC;
```

**Do not sum the raw tally.** Rev. 2 did, and it ranks the *stable* value first.
Three runs, kept set `{monoline-linework}`, tally
`{monoline-linework: 3, gradient-blend: 1}`: the item is non-unanimous and
contributes 3 to monoline and 1 to gradient — so across eighteen such items the
model is told the facet is "torn between monoline-linework (54) and
gradient-blend (18)", when monoline is the one value nobody disputed. Frequency
is not tension. A value is in tension on an item when some runs chose it and some
didn't, which is `0 < votes[v] < of`; the lower bound is free, since a value no
run picked is absent from the tally entirely.

**1c. Worked examples** — the most-contested items, with the description the
tagger itself wrote. This is what stops the diagnosis being abstract:

```sql
SELECT i.tag_reasoning->>'description' AS description, e.value->'votes' AS votes
FROM items i, jsonb_each(i.tag_confidence) AS e(key, value)
WHERE i.board_id = $1 AND i.status = 'tagged' AND NOT i.undecided
  AND e.key = $2 AND e.value->>'d' = $3
  AND (e.value->>'agreed')::int < (e.value->>'of')::int
  AND i.tag_reasoning ? 'description'
ORDER BY (e.value->>'agreed')::numeric / (e.value->>'of')::int ASC, i.id
LIMIT 8;
```

The ratio, not `agreed` alone: `of` is how many runs *completed*, not the
configured `ai_votes`, so a board with a failed vote here and there carries a mix
of 2-, 3- and 5-run items. Sorting on the numerator puts 1-of-2 (a coin flip)
ahead of 2-of-5 (worse), which is backwards on exactly the axis the ordering
exists to express.

Without 1c the model reasons about label strings in a vacuum and can only guess
at overlap. With it, it sees "a thin-stroke wordmark over a colour blend" next to
`{monoline-linework: 1, gradient-blend: 1, 3d-dimensional: 1}` and has evidence.

**Do not "improve" 1c to use the per-facet sentence** (`tag_reasoning->>$2`).
It looks like the better source and is systematically absent exactly where it is
needed: `mergeVotes` takes the sentence from the earliest run that selected what
was *kept*, and takes it from nowhere when no single run proposed that set
(`worker.js`, and deliberately — runs[0]'s sentence would argue for values that
were just dropped). On a multi-value facet the merge routinely keeps a set no run
proposed, and multi-value facets are precisely the unstable ones. Reaching for it
would bias the worked examples toward the items that agreed.

**1d. The contrast set** — items where the same facet was unanimous:

```sql
SELECT i.tag_reasoning->>'description' AS description, e.value->'votes' AS votes
FROM items i, jsonb_each(i.tag_confidence) AS e(key, value)
WHERE i.board_id = $1 AND i.status = 'tagged' AND NOT i.undecided
  AND e.key = $2 AND e.value->>'d' = $3
  AND (e.value->>'agreed')::int = (e.value->>'of')::int
  AND i.tag_reasoning ? 'description'
ORDER BY i.id LIMIT 4;
```

**Without this the `genuinely-ambiguous-items` escape hatch is unreachable in
practice.** Show a model eight disagreements and ask why the facet is
inconsistent and it has no way to see the facet *working* — the frame contains
only failure, so "your taxonomy is fine, these particular items really are mixed"
is available in the schema and never selected. Every board would look broken.
Four working examples, labelled as such, are what make the comparison possible:
the question becomes "what do the contested items have that these don't?", which
is answerable, instead of "what is wrong with this facet?", which presupposes.

If the model cannot tell the two groups apart from the descriptions, that is
itself the finding, and `genuinely-ambiguous-items` is the correct answer to it.

Note the `ai_reasoning: false` case: no descriptions exist, so 1c and 1d return
nothing and the diagnosis runs on labels alone. Degraded but not broken — and
degraded specifically in the direction of over-diagnosis, since the contrast set
goes first. Say so in the prompt so the model doesn't over-claim.

## 2. The definition stamp — the one schema change to `tag_confidence`

```
tag_confidence: { construction: { of: 3, agreed: 2, votes: {…}, d: "7f3a1c0b91e4" } }
```

`d` is a short hash over **the facet's definition and the shape of the prompt
that measured it**: `(description, values sorted, single, scoped)`. Twelve hex
chars, following `providers.js`'s key fingerprint, and longer than the space
needs because a collision here does not fail loudly — it reads pre-edit
measurements as post-edit ones, which is the exact bug the stamp exists to
prevent. The inputs are JSON-serialised rather than concatenated for the same
reason: no gloss may forge the boundary between itself and the value list.

### Why this is required, not defensive

Before facet scope, every entry on an item came from one pass, so the map was a
coherent snapshot and the only open question was how old it was. Now facet A's
entry can come from yesterday's scoped pass and facet B's from last month's full
one — and after the user takes our advice and re-tags one facet, that is the
*expected* state, not a corner case.

The concrete failure without `d`, which rev. 1 would have shipped:

```
user reads:  "this description doesn't say which of the two wins"
user edits:  appends the suggested precedence rule, saves
updateBoard: drops the diagnostic entry (rev. 1's invalidation rule)
diagnoseLoop: gates still pass — every measurement on the board is pre-edit —
              spends a call, and writes the same finding again, now quoting
              a description that already contains the fix
```

With `d`, the edit changes the hash, zero items match it, gate 5 fails, and no
call is spent until a retag has actually re-measured something. The bug does not
need to be guarded against; it cannot arise.

### Why a hash and not a timestamp

A timestamp answers *when*. The question is *against which wording* — and a user
who edits a gloss and reverts it should keep their measurements, which a
timestamp would discard and a hash correctly retains.

### Why `scoped` is inside the hash

The live probe (`scripts/probe-facet-scope.mjs`) measured scoped-vs-full
agreement at 72.5% against a full-vs-full control of 85.0% — a 12.5pt gap at
~1.5 SE on n=40, suggestive and not established. If it is real, a scoped
measurement is not interchangeable with a full one, and pooling them to reach the
item minimum is exactly the quiet compromise that produces a confident wrong
paragraph. Folding the flag into `d` makes the two never silently pool.

**And that figure is narrower than it sounds** — §7 is careful that the probe's
token numbers came from text stand-ins and must not be generalised, and rev. 2
spared this one the same treatment. It was measured on `shape`, a `single: true`
facet and one of the *stable* ones (72% unanimous); on text stand-ins rather than
images; and its scoped arm asked about two facets where the loop's scoped retag
asks about one. Read it as a reason to keep the shapes apart, not as a
measurement of how far apart they are. Keeping them apart costs a segment rule
(§1); pooling them cannot be undone once a paragraph has been written off the
pooled sample.

The cost is a transitional one: the first delta a user sees after adopting the
loop straddles a shape change (baseline full, re-measurement scoped) and is
confounded. Every cycle after that is scoped-vs-scoped and clean. §5 says this
in one clause rather than suppressing the number.

### Where it is computed

`getBoardPrompt` already builds and caches per board **and per scope**
(`worker.js:655`), which is exactly the granularity `d` needs — so the hash is
computed once per cache entry, not once per item, and rides on the same entry as
`facets`/`allFacets`, as a `{ facetKey: hash }` map. `mergeVotes` stamps it onto
each facet's confidence object as it walks `facets`.

The diagnose loop needs **both** shapes for the same facet, and must not go
through the cache to get them: a board's scoped entry does not exist until
someone has actually run a scoped pass, so the cache can only ever offer the
shape that has already happened — which is the one shape a segment rule has no
need to be told. It computes the pair directly from the board's facet list. Same
inputs, no I/O: `d` is a hash of `(description, values sorted, single, scoped)`
and nothing else, which is also what makes it the right trigger for the demotion
in §3.

### Backward compatibility

Entries written before this ships have no `d`. **Missing must not match the
current hash** — that recreates the exact bug. It counts as "measured under an
unknown definition", so an existing board shows *awaiting re-measurement* until
its next tagging pass. Since diagnosis does not exist yet there is nothing to
regress; but the UI has to name that state rather than let it read as breakage.

Also unchanged and still true: `tag_confidence = {}` means NOT MEASURED, never
zero. A single-pass board has no `d` anywhere because it has no confidence.

## 3. Storage — its own column, not `boards.facets`

```sql
ALTER TABLE boards ADD COLUMN facet_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb;
```

`NOT NULL DEFAULT` for 0029's reason, and it is load-bearing rather than tidy:
`backup.js loadTable` INSERTs only the columns an archive's manifest names, so a
pre-migration archive relies on the default to restore into the new schema. Say
so in the migration header the way 0029 and 0030 do — the note is what stops the
next person "simplifying" it.

```json
{ "construction": {
    "verdict": "overlapping-values",
    "explanation": "monoline-linework and gradient-blend are not mutually exclusive…",
    "values": ["monoline-linework", "gradient-blend"],
    "rewrite": "The construction methods visible in the mark. When a mark has both a uniform stroke and a colour blend, prefer gradient-blend.",
    "stats": { "items": 25, "unanimous": 15 },
    "split": ["gradient-blend", "monoline-linework"],
    "d": "7f3a1c0b91e4", "scoped": true, "k": "7f3a1c0b91e4|40|gradient-blend,monoline-linework",
    "at": 1754500000000,
    "previous": { "stats": { "items": 25, "unanimous": 15 }, "description": "the construction methods visible in the mark",
                  "d": "0b91e47f3a1c", "scoped": false, "at": 1754400000000 } } }
```

Three of those fields exist because writing §4 and §5 against the schema found
them missing, and each covers a hole that would have been silent:

- **`split`** is the measured tension (1b), distinct from `values`, which is what
  the model *asserted*. §4's staleness key compares "the top-5 contested values"
  against something, and rev. 2 stored nothing to compare against.
- **`k`** is the staleness key itself, so the comparison is one string equality
  rather than a re-derivation that can drift from what was stored.
- **`previous.description`** is the wording being replaced. §5 asks the prompt to
  "tell the model what the wording used to be" — and `d` is a hash, so without
  keeping the text at demotion time there is nothing to tell it. The demotion is
  the only moment that text still exists.

`scoped` is on **both** halves, and rev. 2 had it only on `previous` — which
left §6 state 5 rendering a clause ("these two measurements came from different
prompt shapes") off a comparison it had no second operand for. It is the segment
§1 chose, stored rather than re-derived: `d` is a hash, so recovering the shape
from it means recomputing both candidates and testing which one matches, at
every render, against a definition that may since have changed.

**Not written into `boards.facets`.** That column is user data, rewritten
wholesale by `updateBoard` on every modal save — a worker writing into it would
race the user and one would clobber the other. The precedent exists:
`ingest_state` is worker-owned and deliberately excluded from `updateBoard`
(`db.js:882` says so in as many words), written only by its own setter.
`facet_diagnostics` follows it, with `setFacetDiagnostic(db, boardId, key,
entry)` doing a jsonb merge so two facets diagnosed in the same pass cannot
overwrite each other — and with one departure, named two paragraphs down: the
demotion means the user's save writes here too, so this is not quite
`ingest_state`'s single-writer discipline.

**Demote, don't drop.** Rev. 1 dropped a facet's entry when `updateBoard` changed
its description or values. That is still right for the *finding* — a paragraph
quoting deleted wording is worse than no paragraph — but the `stats` are the
baseline for "was 60%, now 88%", and dropping them throws away the only evidence
the user's edit helped. So on edit: move `stats`/`d`/`scoped`/`at` into
`previous`, clear `verdict`/`explanation`/`values`/`suggestion`. One `previous`
deep, not a history: two edits before a re-measurement means the older baseline
is stale anyway, and a growing array in a board column is a different feature.

**The demotion has to diff, and `updateBoard` cannot.** It is a flat `UPDATE`
that never reads the row (`db.js:860`), and the board modal sends `facets` on
*every* save whether or not the taxonomy was touched (`board-modal.js:576`) — so
a demotion keyed on `facets !== undefined` clears every finding on the board the
first time someone renames it or toggles auto-tag. It needs the old facet list:
read `facets` and `facet_diagnostics` in the same transaction as the write, and
demote exactly the facets whose **`d` inputs moved**. That is the hash §2 already
computes, so the rule is `d_new !== d_old` rather than a hand-written comparison
of description/values/`single` that can drift out of step with the hash the gate
uses. Compare the unscoped hash — `scoped` is a property of a measurement, not of
the definition the user just edited. The test that catches the naive version is
the negative one (§8).

That does make `facet_diagnostics` a column with two writers — the worker appends
findings, the user's save demotes them — which is a weaker claim than
`ingest_state`'s and should be stated as such. The isolation that matters
survives: nothing the worker writes can touch `boards.facets`, which is the race
that would lose *user* data. What is left is a diagnosis landing between the read
and the write of a save that demotes the same facet, costing one paragraph that
was about to be demoted anyway. Do the demotion in a transaction and stop there;
a lock buys nothing worth its cost.

## 4. When it runs

A `diagnoseLoop` alongside `embedLoop` / `refreshLoop` / `alertsLoop`
(`worker.js:2376-2434`), for the reason those exist: this is outbound provider
I/O and must not sit inside the maintenance tick delaying recovery, ingestion or
scheduled retags. Nothing here creates claimable work, so no `wake()` — the
`alertsLoop` precedent.

Five gates, all of which must pass:

1. **Board has vote mode on** (`ai_votes > 1`). Without it there is no confidence
   data at all, so there is nothing to read.
2. **Settled.** No pending/processing items on the board, and nothing tagged in
   the last `DIAGNOSE_SETTLE_MS` (default 10 min). A bulk retag lands items over
   minutes and the tally moves the whole time; diagnosing mid-sweep burns a call
   on a moving target and immediately restales. Same reasoning as
   `alerts.js:29`'s `SETTLE_MS`, longer because a retag is slower than an ingest.
   *Deliberately board-level, not facet-level:* a scoped retag on `construction`
   invalidates only `construction`, so this is more conservative than it needs to
   be. Left that way — the window is ten minutes and the extra precision buys a
   per-facet "last landed" timestamp we would otherwise not need.
3. **Enough signal.** At least `DIAGNOSE_MIN_ITEMS` (20) items carrying
   confidence for that facet. Below that the tally is noise and a confident
   paragraph about it is worse than silence.
4. **Actually unstable.** Non-unanimous on ≥ `DIAGNOSE_MIN_RATE` (15%) of those
   items. `presentation` at 100% unanimous must never generate a paragraph
   explaining what is wrong with it.
5. **Measured under the current definition, in one prompt shape** (new). A facet
   has two current stamps, full and scoped (§2), so gates 3 and 4 count within
   the segment §1 chose and never across both. Below the minimum in *every*
   segment the facet is *awaiting re-measurement*, which is a UI state (§6), not
   a diagnosis.

   Rev. 2 wrote this as a single stamp, and getting it wrong in either direction
   breaks the loop with nothing failing loudly. Match only the full stamp and the
   scoped retag this plan tells the user to run writes a stamp the gate cannot
   see — the verification leg never fires and state 4 is permanent. Match only
   the scoped stamp and no board qualifies at all, since none has been
   scope-tagged. Both failures present as "diagnosis is quiet today", which is
   also what a healthy board looks like.

**The question is versioned.** A stored finding answers one specific question,
so a finding produced by a *different* question is not current however unchanged
the measurements are — the same logic that puts the prompt shape inside `d`, one
level up. `PROMPT_VERSION` rides in the freshness key, so changing what is asked
re-diagnoses every facet on its next settled tick. Without it, entries written
against an older schema sit unactionable forever, because staleness only ever
looks at the data. (1 → 2 was append-a-sentence → rewrite-the-description.)

**Staleness** is the stored `d` plus the bucketed instability rate (5-point
steps, so one more tagged item doesn't invalidate a good paragraph) and the top-5
split values sorted (1b). Skip when all three match. Note that `d` now does most
of this work — the definition half of rev. 1's hash *is* `d`, and it now lives on
the measurements as well as the diagnosis, which is what makes gate 5 possible.
It also carries the prompt shape, so a facet re-measured scoped is never mistaken
for the same facet still sitting on its full-pass numbers.

**Bounded per pass:** one board, at most 10 facets, so a fleet of newly
vote-enabled boards cannot fan out into a burst of calls.

*Which* board is a rotation, not "the first one that qualifies". Nothing here
creates claimable work, so there is no queue to drain and no row that stops
matching once it has been served — a board whose staleness check keeps passing
would be re-picked every tick and every board behind it would starve, silently
and indefinitely. Round-robin on board id from the last one visited, the cursor
held in the loop's own closure: it is an ordering, not state worth a column, and
a restart re-starting at the lowest id costs one redundant staleness check.

## 5. The prompt

Text only — no images, so the call is small. Runs on the board's own tagger
(`resolveBoardAi`), inheriting the key, model and rate-limit bucket.

Tool `record_diagnosis`, following `buildFieldsPrompt`'s precedent of overriding
`DEFAULT_TOOL` per call:

```js
const DIAGNOSE_TOOL = { name: "record_diagnosis", description: "Record why this facet's tagging is inconsistent." };

const schema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: [
      "overlapping-values",        // two values can both be true; needs a precedence rule
      "unclear-definition",        // the description doesn't pin down the judgement
      "genuinely-ambiguous-items", // the taxonomy is fine; these items really are mixed
      "no-problem-found",          // nothing actionable
    ] },
    explanation: { type: "string", description: "Two sentences at most, naming the specific values involved." },
    values: { type: "array", items: { type: "string" }, description: "The values in tension, or empty." },
    rewrite: { type: "string", description: "A COMPLETE replacement for the facet description — not an addition to it. Keep every judgement the current description already establishes; three sentences at most; empty when there is nothing worth changing." },
  },
  required: ["verdict", "explanation", "values", "rewrite"],
  additionalProperties: false,
};
```

**The last two enum values are the load-bearing part.** Asked "why is this
inconsistent", a model will always find a reason — that is what it is for. Given
no way to say "the values are fine, these items really are mixed" or "nothing
here", it will invent a taxonomy flaw and phrase it convincingly. The escape
hatches must exist, the system text must say they are acceptable answers, and the
UI must render them differently from an actionable finding.

System text, in the style of `buildFieldsPrompt`: state the board's context, the
facet's definition and values, the split counts (1b, and phrase them as what they
are — "the runs parted on *gradient-blend* in 12 of the 18 items where they
disagreed", not a raw vote total, which invites the model to read the most
frequent value as the most troublesome), **the contested examples and the
unanimous ones as two labelled groups** (1c and 1d), and ask what the contested
items have that the unanimous ones don't — then for a REWRITTEN description in the
style of the strongest existing glosses ("where each could stand alone"). Ask the
comparative question, not "what is wrong with this facet", which presupposes its
own answer. Say explicitly that the tagger saw images and the diagnosis does not,
so a claim about what the images contain must rest on the supplied descriptions.

**One sentence rev. 1 did not have:** when `previous` exists, tell the model what
the wording used to be and what the rate used to be. A facet that went 60% → 78%
after an edit is a *partially successful* fix, and "the precedence rule helped
but does not cover the case where neither stroke dominates" is a far more useful
second paragraph than a fresh diagnosis pretending the first never happened.

## 6. The UI

Three surfaces, each with one job: a **Tagging consistency** button in the gallery header
is the door and the attention signal; the **Tagging consistency** modal is the survey and
is read-only; the **facet editor** is where the fix is typed and is the only
writer. Taken in that order below, after the editor half that most of this plan
has been building toward.

`buildFacetEditor(textarea)` (`board-modal.js:48`) gains a second argument — the
diagnostics map — and renders under the existing description textarea
(`board-modal.js:142`), which is exactly where the fix gets typed.

**Display only. No action.** `facet-scope-loose-ends.md` #10 recorded why the
per-facet retag control lives on the boards-list row and not in here: outside the
modal, retagging against a gloss the user has edited but not saved is
*impossible* rather than guarded against. A "re-tag this facet" button next to
the suggestion would walk straight back into that. The copy names the control by
its label instead; the user saves, closes, and uses the dropdown that already
exists.

### Discovery — a Tagging consistency button in the gallery header

The facet editor is where the fix gets *typed*, but nobody opens a board modal to
find out whether anything is wrong. Without a door, a finding sits unread until
the user is already suspicious — by which time it has told them nothing they
didn't know.

The door is a third icon button in the toolbar's `board-group`, between the edit
pencil and the jobs chip (`toolbar.js` `renderToolbar`), opening a **Tagging
consistency** modal. It needs an icon of its own. `sparkle` is not free, as rev. 2 had it — it
is the connector chip on the boards page (`boards.js:195`), where it already
means "AI-extracted fields", and a user would meet the two senses one click
apart. `activity` is jobs. Add a glyph rather than overload either — `ICONS.gauge`,
a dial reading somewhere short of full.

**Gated on `state.boardManage && ai_votes > 1`.** Both halves are load-bearing:

- `boardManage` because the pencil is, and this is the same cluster — reading a
  facet suggestion is only useful to someone who can edit facets. `jobsChip()`
  is deliberately ungated ("the log is transparency, not management"); this is
  the opposite kind of thing and sits on the other side of the pencil.
- `ai_votes > 1` because a single-pass board has no confidence data at all, so
  the modal would be permanently empty. **This needs `vote-mode-loose-ends.md` #6
  fixed first** — `GET /api/boards/:id` returns `ai_reasoning` but not
  `ai_votes` (`server.js:810-826`), so the client cannot currently evaluate the
  gate. That item was filed as untidiness; it is a prerequisite. Add `ai_votes`
  to the payload and `state.boardVotes` beside `state.aiReasoning`
  (`app.js:110-111`).

**Always present when the gate passes — not only when there is a finding.** A
button that appears only when something is wrong costs three things: a user who
took the advice has no way back in to check whether it worked; the button's
*appearance* becomes the notification, conflating "there is a finding" with
"there is a **new** finding", which is the dot's job and it does it better; and
the header reflows as it comes and goes.

**The dot** is `attachBtnDot()`, exactly the `plus-caret` unseen-alert precedent
(`toolbar.js:302`), lit when a finding is newer than this board's last-opened
stamp. Unlike alerts, the stamp is `localStorage` per board rather than
server-side: this is advisory, not a ledger, and it does not need to survive a
device change. Lit by states 1 and 5 only — `genuinely-ambiguous-items` is
information, not a task, and must not raise a signal that reads as a to-do.

### Why not a tab in the jobs modal

The jobs modal is a **ledger**: reverse-chronological, one row per event,
organised by time. A diagnosis is not an event — it is a standing assessment of a
definition, keyed by facet, replaced rather than appended. Tabbing them together
makes that modal's identity "where board meta lives", which is a container with
no thesis, and those collect everything.

The split that *is* right: the diagnose **run** writes a `kind: 'diagnose'` row
into the job log (§7). The event belongs there; the finding does not.

### The modal surveys; the facet editor edits

Two surfaces, and only one of them may write:

- **Tagging consistency** modal — every facet with confidence data, its stability, and
  its finding if it has one. Read-only. Each finding offers *Edit this facet*,
  which closes the modal and opens the board modal at that facet. `openBoardModal`
  (`board-modal.js:303`) has no such anchor today, so this is one more option on
  it plus a scroll-into-view in `buildFacetEditor` — small, but it is the hinge
  between the two surfaces and the only thing making the split navigable.
- **Facet editor** — the same finding repeated inline under the description being
  edited, with `[add to description]`, because that is where the text needs to be
  while the user types.

The repetition is deliberate. If that modal could apply a suggestion
itself it would become a second writer into `boards.facets` — the exact race §3
excludes by keeping diagnostics in a worker-owned column. One editor, always the
board modal.

### The five states in the facet editor

```
CONSTRUCTION TECHNIQUES                     [single value: off]
  the construction methods visible in the mark...

  !  The AI disagreed with itself on 40% of items.
     monoline-linework and gradient-blend are being applied to the same
     marks — a thin even stroke can also carry a colour blend, and this
     description doesn't say which wins.
     Suggested: "when a mark has both a uniform stroke and a colour
     blend, prefer gradient-blend."                        [add to description]
```

1. **finding** — `overlapping-values` / `unclear-definition`, as above.
   `[replace description]` puts the proposed wording into the textarea: a text
   edit the user can undo, retype or ignore before saving. The model never
   writes to the board.

   **A replacement, not an appendage** — rev. 3 asked for one sentence to append
   and the first live run showed why that is wrong. On `shape` the model
   reported that *"the facet wording says to judge the symbol rather than the
   full lockup, but several examples still invite layout-based readings"* — the
   current text already tries to draw the distinction and fails, so a second
   sentence saying it harder is worse than saying it once properly. And the
   damage compounds: two or three diagnose-and-apply cycles leave a description
   that is one original plus three appendages, each written without sight of the
   next. Applied through `execCommand("insertText")` rather than by assigning
   `.value`, because this overwrites words the user wrote and a programmatic
   assignment does not go on the textarea's native undo stack.
2. **`genuinely-ambiguous-items`** — a muted note, no suggestion. Information,
   not a task.
3. **`no-problem-found`, or no entry** — nothing. **Absence must never read as
   "fine"**: a single-pass board has no diagnostics at all and its empty state has
   to stay visually identical to today.

   States 4 and 5 are decided against `DIAGNOSE_MIN_ITEMS` and `DIAGNOSE_MIN_RATE`,
   so **the thresholds have to reach the client** — served with the roll-up
   rather than re-declared in the browser. A second copy drifts the first time
   either is retuned, and the symptom (a facet stuck *awaiting re-measurement*
   while the loop happily re-diagnoses it) reads as a bug in neither half.
4. **awaiting re-measurement** (new) — *"This description changed. Re-tag this
   board on **Construction techniques** to measure whether it helped."* Shown when
   `previous` exists and fewer than `DIAGNOSE_MIN_ITEMS` items carry the current
   `d`. This is also what every pre-`d` board shows until its next pass, so the
   sentence has to work as a first impression and not only as a follow-up.
5. **improved** (new) — *"Was 60% unanimous before your edit, 88% now."* Shown
   when the current stats clear the stability threshold and `previous` did not.
   When `scoped` differs between the entry and its `previous` (§3), one appended
   clause: *"(re-measured on this facet alone, which is a slightly different
   prompt — the next comparison will be like-for-like.)"* The copy says
   *agreement*, never *accuracy*, and never claims the edit is what moved the
   number — hand-corrections between the two measurements move it the same way,
   and nothing here can tell the two apart (§10).

**The order these are tested in is load-bearing, and only one pair actually
collides.** *Awaiting* has to outrank a live finding: an entry can carry a
verdict while its segment has fallen under the minimum — not only after an edit
(which clears the verdict anyway) but through ordinary curation, since
`setItemTags` deletes the confidence entry for every facet a user corrects
(§10). Rendering the paragraph there shows a rate computed from noise. *Improved*
outranks a finding for the same reason in reverse: when both are available the
movement is the news.

State 5 is the point of the revision. Rev. 1 could only render problems, so a
user who successfully fixed a facet watched the finding disappear and was never
told they had won.

## 7. Cost, logging, failure

- **The diagnosis call:** 3–4 per board, only when facets are unstable and stale,
  ~1–2k input and ~200 output each. Negligible against what vote mode itself
  spends — which is why it runs automatically rather than behind a button.
- **The verify step is the real cost, and scoping is what makes it affordable.**
  Re-measuring one facet across 500 items at `ai_votes: 3` is 1,500 calls either
  way; scoping does not reduce the call count (see `vote-mode-loose-ends.md` #5 —
  it does not relieve the `AI_INFLIGHT` question either). It reduces the size of
  each. The probe measured 1,097 vs 3,615 input and 76 vs 345 output tokens.
  **Do not generalise that ratio to an image board:** the probe used text
  stand-ins, so the prompt *was* the call. With an image the input floor is the
  image, and the same ~2,500-token saving is a much smaller fraction of a much
  larger call. The output saving (~270/call) holds either way. State the estimate
  in calls, and the saving in tokens-per-call, not as a percentage.
- **Usage:** `bumpUsage` like any other paid call, so it appears in the board's
  token figures rather than vanishing.
- **Job log:** `kind: 'diagnose'`, `target` = the facet key, detail
  `{ items, unanimous, verdict, scoped }`. The ledger discipline the app already
  applies to tag/extract/face/transcribe/ingest. A new kind is not free on the
  client and the plan should carry where it lands: `KIND_LABELS`
  (`jobs-modal.js:16`) names the badge *and* generates the filter pills, so the
  pill comes along for one line; `summaryFor` (`jobs-modal.js:48`) needs a branch
  or the row renders with an empty summary, since a diagnose detail matches none
  of its fall-throughs. No CSS: `.job-kind` is styled once for every kind, and
  the per-kind class the badge also sets has never had a rule behind it.
- **Failure is never load-bearing.** Wrapped like `evaluateItemAlerts` — a
  provider error logs and moves on. A missing diagnosis costs nothing; a
  diagnosis pass that breaks tagging would be a serious regression.

## 8. Tests

Roll-up and gates:

- Given fabricated `tag_confidence` rows, the per-facet stats and the split
  counts come out right, including the `agreed = of` filter.
- **An undecided item is excluded from all three queries** — seed one whose runs
  unanimously picked nothing and assert it does not raise the unanimity rate.
  This is the regression that would silently make every facet look healthy.
- **1b counts splits, not frequency** — seed contested items whose tallies all
  read `{stable: 3, contested: 1}` of 3 and assert `stable` is absent (no run
  parted on it) while `contested` is present. Summing the tally ranks them the
  other way round and reads plausible while doing so, which is why this needs an
  assertion rather than a reviewer.
- **A hand-corrected item leaves the tally rather than counting as agreement** —
  `setItemTags` already deletes the facet's confidence entry (`db.js:363-367`),
  so assert the denominator drops by one. Pinning it makes the sampling bias in
  §10 visible to whoever next touches either side.
- No diagnosis below the item minimum; none below the instability rate; none on a
  single-pass board; none while items are pending.
- **The contrast set is present and correctly separated** — 1d returns only
  `agreed = of` items and 1c only `agreed < of`, with no overlap, and the prompt
  labels them as distinct groups. A facet with no unanimous items at all yields an
  empty contrast set rather than silently reusing contested ones.

The definition stamp:

- A facet's `d` changes when its description, its values, or `single` changes,
  and **when the pass is scoped rather than full** — four separate assertions, so
  a refactor cannot quietly drop one input.
- `mergeVotes` stamps every facet it writes; a scoped landing stamps only the
  facets it wrote and leaves the others' stamps alone (this is `scopeResult`'s
  `pick`, already tested for the object as a whole — extend it to `d`).
- An entry with no `d` (pre-migration) never counts toward the current hash.
- **A facet has two stamps and the reader commits to one.** Seed items under
  both, and assert the diagnosis counts one segment, records which on the entry,
  and that neither query returns the other segment's items. Then both directions
  separately, because each alone leaves a plausible-looking silence: a board
  whose only measurements are full still diagnoses, and a board whose only
  measurements are scoped still diagnoses.
- **End-to-end, the bug this exists to prevent:** diagnose, apply the suggestion
  via `updateBoard`, run `diagnoseLoop` — assert **zero** provider calls, and
  that the facet reports *awaiting re-measurement*. Then scope-retag the facet and
  assert the next pass does call, and that its prompt carries the `previous`
  stats.

Storage and UI:

- `updateBoard` changing a facet's values demotes that facet's entry to
  `previous` and leaves the other facets' entries untouched.
- **A save that does not touch the taxonomy demotes nothing** — rename the board,
  toggle auto-tag, re-send a byte-identical `facets` array, and assert every
  entry survives whole. This is the assertion the obvious implementation fails,
  and its absence from rev. 2 is why rev. 2 would have shipped the bug: the modal
  sends `facets` unconditionally, so `facets !== undefined` looks like "the
  taxonomy changed" and never is.
- A second edit before any re-measurement overwrites `previous` rather than
  nesting.
- `no-problem-found` stores without a suggestion and renders nothing.
- The whole pass throwing does not fail tagging (the alerts-ledger rule).

The header gate:

- The button is absent for a viewer without `boardManage`, and absent
  on a board with `ai_votes = 1` — the two halves asserted separately, since each
  alone would leave a button that opens an empty or unusable modal.
- The dot lights for states 1 and 5 and **not** for `genuinely-ambiguous-items`;
  opening the modal clears it; a finding written after that lights it again.

## 9. Build order

Each step is shippable and independently useful.

0. **`ai_votes` in the board payload** (`vote-mode-loose-ends.md` #6). Two lines,
   and the header gate in step 4 cannot be written without it. Doing it first
   also keeps it from being rediscovered as a blocker halfway through the UI.
1. **The stamp.** `d` on confidence entries, computed in `getBoardPrompt`,
   written by `mergeVotes`, preserved by `scopeResult`. No UI, no calls. Ships
   silently and starts accumulating the data everything else needs — so it wants
   to land *first* and by some margin, because gate 5 is worthless until boards
   have been tagged under it at least once.

   *Watch `BOARD_COLS` when step 3 adds its column.* `getBoard`/`listBoards`
   select a hand-written list (`db.js:998`), so a new column is invisible to
   every reader that goes through them until it is named there — the same shape
   as the `claimFairBatch` hazard the facet-scope sweep checked for and did not
   find. The worker's own loop selects explicitly and would keep working, so the
   symptom is "the UI never shows anything" with a green suite.
2. **The roll-up**, exposed as read-only board stats — including the segment
   rule (§1), which belongs here rather than with the gates: the roll-up is the
   first thing that has to answer "which measurements am I looking at", and a
   version that pools the two shapes would be shipped, read, and believed before
   step 3 ever consults it. This alone closes `vote-mode-loose-ends.md` #3 —
   "which of my facets is a coin flip" without hand-written SQL — and is the
   largest single win in the list. It is also the whole content of the
   modal's stable state, so the modal can ship here with no findings
   in it at all and still be worth opening.
3. **The diagnosis call** + `facet_diagnostics` + `diagnoseLoop`, with the
   demotion (§3) landing in the same step as the column it writes to.
4. **The UI**: the header button and modal, then the five states in the facet
   editor.

## 10. Open questions and risks

- **The diagnosis cannot see the images.** It reasons from labels plus the
  tagger's own descriptions, which are themselves model output. It identifies
  definitional overlap well; it cannot verify a claim about what an image
  contains. The copy must frame it as a suggestion, and
  `genuinely-ambiguous-items` is the honest answer when the taxonomy is fine —
  whether the model actually reaches for it is the main thing to watch on the
  first real run.
- **Unstable for non-taxonomy reasons.** A facet can wobble because the board's
  items are heterogeneous, not because two values overlap. Same escape hatch,
  same watch item.
- **Self-consistency is not correctness.** A facet applied wrongly but
  consistently is invisible here, and an "improved" badge on it would be actively
  misleading. The wording in state 5 should say *agreement*, not *accuracy*.
- **Human corrections bias the sample, in the flattering direction, and nothing
  here can see it.** `setItemTags` deletes a facet's confidence entry whenever
  the user changes that facet's values (`db.js:354-368`) — correctly, because a
  surviving "2 of 3 passes agreed" on a hand-picked value would be a lie. But the
  items a user bothers to correct are the contested ones, so a diligently curated
  board loses exactly the evidence that would fire gate 4: the more diligent the
  curation, the healthier the facet reads, and the facets most worth diagnosing
  are the likeliest to fall under the threshold. It also puts a false positive in
  state 5 — enough corrections between two measurements produce "was 60%, now
  88%" with the gloss edit doing none of the work. Nothing to build; the deletion
  is right and the alternative is worse. But the state 5 copy must not attribute
  the improvement to the edit, and §4's thresholds are being calibrated on a
  sample missing its tail.
- **The first delta is confounded** by the full→scoped shape change (§2). Every
  later one is clean, and the entry now records the shape it read (§3), so the UI
  states which case it is rather than inferring it. If the probe's 12.5pt gap
  turns out to be real and large, the cheap fix is to recommend re-measuring the
  baseline scoped once before editing — an extra pass to make the comparison
  honest.
- **Threshold values are guesses.** 20 items / 15% / 10-minute settle come from
  one board's data. They want revisiting once several boards have run — and see
  the curation bias above, which pushes the instability rate the wrong way on
  exactly the boards whose owners care most.
- **Multi-facet interactions are invisible.** Each facet is diagnosed alone, so a
  problem spanning two facets (motif and industry disagreeing about the same
  images for a shared reason) reads as two unrelated findings. Cross-facet
  diagnosis is a larger design and explicitly out of scope.
- **Nothing ever re-tags on its own.** The loop closes only as far as the user's
  next click; there is no auto-remeasure after an edit. That is deliberate — an
  edit silently costing 1,500 paid calls is not a surprise anyone wants — but it
  does mean state 4 can sit on screen indefinitely on a board without scheduled
  retags.
