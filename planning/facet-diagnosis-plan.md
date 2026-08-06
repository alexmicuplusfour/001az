# Facet diagnosis — implementation plan

Vote mode (`planning/tagging-accuracy-plan.md`, shipped) tells a user **that** a
facet is unreliable. This tells them **why**, and puts the explanation where the
fix is made — already written, inside the facet editor, before they ask.

## Why this is the payoff, not a nice-to-have

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

More passes cannot help here. At 5 votes the unresolved multi-value facets get
*emptier*, not settled (construction 20% → 38% empty), because the estimator
sharpens on "the model has no stable opinion". There is nothing to converge on.
The taxonomy has to change.

## What this is not

- **Not a tiebreaker.** Nothing here picks a winner for an item. Shown its own
  contradictory outputs and asked to resolve them, a model reliably produces a
  fluent justification for whichever it lands on. The output would read
  authoritative and mean nothing.
- **Not per item.** A facet that fails on 18 items is one broken facet observed
  18 times. Per-item diagnosis buys 18 near-identical paragraphs, each attached
  to one image, none of which changes how anything is tagged.
- **Not automatic editing.** The model proposes wording. The user owns the
  taxonomy.

## 1. The data it reads

No images, no human inspection — three queries over `tag_confidence`, which vote
mode already writes per item as `{of, agreed, votes}` with `votes` carrying the
full tally *including the values that lost*.

**1a. Per-facet health** (drives the gate and the "18% of items" line in the UI):

```sql
SELECT e.key AS facet, count(*) AS items,
       count(*) FILTER (WHERE (e.value->>'agreed')::int = (e.value->>'of')::int) AS unanimous
FROM items i, jsonb_each(i.tag_confidence) AS e(key, value)
WHERE i.board_id = $1 AND i.status = 'tagged'
GROUP BY 1;
```

**1b. What it was torn between** — summed across the disagreeing items only:

```sql
SELECT v.key AS value, sum(v.value::text::int) AS n
FROM items i, jsonb_each(i.tag_confidence) AS e(key, value),
     jsonb_each(e.value->'votes') AS v(key, value)
WHERE i.board_id = $1 AND e.key = $2
  AND (e.value->>'agreed')::int < (e.value->>'of')::int
GROUP BY 1 ORDER BY 2 DESC;
```

**1c. Worked examples** — the most-contested items, with the description the
tagger itself wrote. This is what stops the diagnosis being abstract:

```sql
SELECT i.tag_reasoning->>'description' AS description, e.value->'votes' AS votes
FROM items i, jsonb_each(i.tag_confidence) AS e(key, value)
WHERE i.board_id = $1 AND e.key = $2
  AND (e.value->>'agreed')::int < (e.value->>'of')::int
  AND i.tag_reasoning ? 'description'
ORDER BY (e.value->>'agreed')::int ASC, i.id
LIMIT 8;
```

Without 1c the model is reasoning about label strings in a vacuum and can only
guess at overlap. With it, it sees "a thin-stroke wordmark over a colour blend"
next to `{monoline-linework: 1, gradient-blend: 1, 3d-dimensional: 1}` and has
actual evidence.

Note the `ai_reasoning: false` case: no descriptions exist, so 1c returns
nothing and the diagnosis runs on labels alone. Degraded but not broken — worth
saying so in the prompt so the model doesn't over-claim.

## 2. Storage — a worker-owned column

```sql
ALTER TABLE boards ADD COLUMN facet_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb;
```

Keyed by facet key:

```json
{ "construction": {
    "verdict": "overlapping-values",
    "explanation": "monoline-linework and gradient-blend are not mutually exclusive…",
    "values": ["monoline-linework", "gradient-blend"],
    "suggestion": "when a mark has both a uniform stroke and a colour blend, prefer gradient-blend",
    "stats": { "items": 25, "unanimous": 15 },
    "hash": "…", "at": 1754500000000 } }
```

**Not written into `boards.facets`.** That column is user data, rewritten
wholesale by `updateBoard` on every modal save — a worker writing into it would
race the user and one would clobber the other. The precedent already exists:
`ingest_state` is worker-owned and deliberately excluded from `updateBoard`
(`db.js:878`), written only by its own setter. `facet_diagnostics` follows it
exactly, with `setFacetDiagnostic(db, boardId, key, entry)` doing a jsonb merge
so two facets diagnosed in the same pass can't overwrite each other.

Being derived data, it is safe to drop and regenerate — which matters for the
invalidation rule below.

## 3. When it runs

A `diagnoseLoop` alongside `embedLoop` / `refreshLoop` / `alertsLoop`, for the
reason those exist: this is outbound provider I/O and must not sit inside the
maintenance tick delaying recovery, ingestion or scheduled retags. Nothing here
creates claimable work, so no `wake()` (the `alertsLoop` precedent).

Four gates, all of which must pass:

1. **Board has vote mode on** (`ai_votes > 1`). Without it there is no
   confidence data at all, so there is nothing to read.
2. **Settled.** No pending/processing items on the board, and nothing tagged in
   the last `DIAGNOSE_SETTLE_MS` (default 10 min). A bulk retag lands items over
   minutes and the tally moves the whole time; diagnosing mid-sweep would burn a
   call on a moving target and then immediately restale. Same reasoning as the
   alerts settle window (`alerts.js:25`), longer because a retag is slower than
   an ingest.
3. **Enough signal.** At least `DIAGNOSE_MIN_ITEMS` (20) items carrying
   confidence for that facet. Below that the tally is noise and a confident
   paragraph about it is worse than silence.
4. **Actually unstable.** Non-unanimous on ≥ `DIAGNOSE_MIN_RATE` (15%) of those
   items. `presentation` at 100% unanimous must never generate a paragraph
   explaining what's wrong with it.

**Staleness** is a hash over `(facet.description, facet.values, facet.single,
bucketed instability rate, top-5 contested values sorted)`. The rate is bucketed
to 5-point steps so one more tagged item doesn't invalidate a good paragraph.
Skip when the stored hash matches.

**Bounded per pass:** one board, at most 10 facets, so a fleet of newly
vote-enabled boards can't fan out into a burst of calls.

**Invalidation on edit** is explicit rather than left to the hash: when
`updateBoard` writes `facets`, drop `facet_diagnostics` entries whose facet's
description or values changed. A stored paragraph quoting wording the user just
deleted is worse than no paragraph, and the hash alone would leave it on screen
until the next tagging run.

## 4. The prompt

Text only — no images, so the call is small. Runs on the board's own tagger
(`resolveBoardAi`), so it inherits the key, model and the rate-limit bucket.

Tool `record_diagnosis`, following the `record_fields` precedent of overriding
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
    suggestion: { type: "string", description: "One sentence to append to the facet description, or empty when there is nothing to suggest." },
  },
  required: ["verdict", "explanation", "values", "suggestion"],
  additionalProperties: false,
};
```

**The last two enum values are the load-bearing part.** Asked "why is this
inconsistent", a model will always find a reason — that is what it is for. Given
no way to say "the values are fine, these images are genuinely mixed" or
"nothing here", it will invent a taxonomy flaw and phrase it convincingly. The
escape hatches must exist, the system text must say they are acceptable answers,
and the UI must render them differently from an actionable finding.

System text, in the style of `buildFieldsPrompt`: state the board's context and
the facet's definition and values, present the tally and the worked examples,
and ask for the ambiguity plus a precedence rule in the style of the strongest
existing glosses ("where each could stand alone"). Say explicitly that the
tagger saw images and the diagnosis does not, so a claim about what the images
contain must rest on the supplied descriptions.

## 5. The UI

`buildFacetEditor(textarea)` gains a second argument — the diagnostics map —
and renders under the existing description textarea (`board-modal.js:144`),
which is exactly where the fix gets typed:

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

- `overlapping-values` / `unclear-definition` render as above.
- `genuinely-ambiguous-items` renders as a muted note with no suggestion — it is
  information, not a task.
- `no-problem-found` renders nothing.
- A facet with no entry renders nothing. **Absence must never read as "fine"** —
  a single-pass board has no diagnostics at all, and the empty state has to stay
  visually identical to today.

`[add to description]` appends the suggestion to the textarea and leaves the
cursor there. It is a text edit the user can undo, retype or ignore before
saving — the model never writes to the board itself.

## 6. Cost, logging, failure

- **Cost:** 3–4 calls per board, only when facets are unstable and stale, ~1–2k
  input and ~200 output each. Against the thousands of calls vote mode itself
  spends, negligible — which is why it runs automatically rather than behind a
  button.
- **Usage:** `bumpUsage` like any other paid call, so it appears in the board's
  token figures rather than vanishing.
- **Job log:** `kind: 'diagnose'`, `target` = the facet key, detail
  `{ items, unanimous, verdict }`. The ledger discipline the app already applies
  to tag/extract/face/transcribe/ingest.
- **Failure is never load-bearing.** Wrapped like `evaluateItemAlerts` — a
  provider error logs and moves on. A missing diagnosis costs nothing; a
  diagnosis pass that breaks tagging would be a serious regression.

## 7. Tests

- Pure roll-up: given fabricated `tag_confidence` rows, the per-facet stats and
  the contested-value tally come out right, including the `agreed = of` filter.
- Gates: no diagnosis below the item minimum; none below the instability rate;
  none on a single-pass board; none while items are pending.
- Staleness: identical inputs → no second call; an edited description → a call;
  one more tagged item that doesn't move the bucket → no call.
- Invalidation: `updateBoard` changing a facet's values drops that facet's entry
  and leaves the others.
- `no-problem-found` stores without a suggestion and renders nothing.
- The whole pass throwing does not fail tagging (the alerts-ledger rule).

## 8. Open questions and risks

- **The diagnosis cannot see the images.** It reasons from labels plus the
  tagger's own descriptions, which are themselves model output. It can identify
  definitional overlap well; it cannot verify a claim about what an image
  contains. The copy must frame it as a suggestion, and the
  `genuinely-ambiguous-items` verdict is the honest answer when the taxonomy is
  fine — whether the model actually reaches for it is the main thing to watch in
  the first real run.
- **Unstable for non-taxonomy reasons.** A facet can wobble because the board's
  items are heterogeneous, not because two values overlap. Same escape hatch,
  same watch item.
- **Threshold values are guesses.** 20 items / 15% / 10-minute settle are
  starting points chosen from one board's data. They want revisiting once
  several boards have run.
- **Does a diagnosis go stale silently?** After the user edits a description the
  entry is dropped, so the facet shows nothing until the next tagging run — which
  may be a long time on a board without scheduled retags. A "re-tag to re-check"
  hint in the empty state may be needed; deferred until it is seen to matter.
- **Multi-facet interactions are invisible.** Each facet is diagnosed alone, so a
  problem that spans two facets (motif and industry disagreeing about the same
  images for a shared reason) reads as two unrelated findings. Cross-facet
  diagnosis is a larger design and explicitly out of scope here.
