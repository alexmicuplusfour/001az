# Vote mode — implementation plan

## Why (the short version)

A live experiment (2026-08-06, 2,240 real tagging calls on gpt-5.4-mini across
80 items and six prompt variants) ranked three candidate accuracy levers:

| lever | measured effect on the resulting tags |
| --- | --- |
| **re-running the same prompt** | **18–22% of facet answers change** |
| one call per facet instead of one call | +3.2 pts over that floor (+5.1 for a cached-prefix variant) |
| reordering each facet's value list | ~0 (pooled mean rank 0.488 ±0.018, CI spans 0.5) |

The taxonomy is not the problem — not its size, not its ordering. **The model
not agreeing with itself is.** At `temperature: 0` the rerun disagreement is
18.3%; unset (the app's current state, so 1.0) it is 22.4%. Per-facet stability
is ~82%, which compounds: on a 9-facet board only **16% of items came back
identical across two identical runs** (0.82⁹ ≈ 0.17, matching observation).

Splitting into per-facet calls costs 7–9× the input and ~3× the output to move
answers by an amount the model's own wobble already covers, in a direction
nothing can score. It is not built.

Voting costs a fraction of that because N identical prompts cache and N
different prompts do not — measured, same experiment:

```
identical prompt, rerun     90% cached     380 fresh tokens/call
per-item reordered prompt    4% cached   3,695 fresh tokens/call
```

| per item | fresh input | output |
| --- | --- | --- |
| single call today | 1,149 | 374 |
| **vote of 3** | **~1,750** | ~1,120 |
| one call per facet (9) | ~8,199 | ~1,084 |

Majority-of-3 over ~82% per-facet stability returns the modal answer ~91% of the
time. Approximate, but it is the only lever aimed at the 18-point defect.

The second deliverable matters as much as the first: **vote mode makes
instability observable.** Nothing in the app can currently tell a user which of
their facets is a coin flip. Learning it once took 2,240 ad-hoc calls.

> Note for anyone re-running the experiment: the ordering test is only valid if
> the permutation is per **item**. One permutation per arm leaves a facet's
> dominant value at a fixed index for the whole sample and manufactures a
> significant-looking position bias. That false positive appeared in round 1.

---

## Work item 1 — `temperature: 0` (do this first)

Revives finding #4 of `prompting-review.md`, parked as "cheap insurance, no
longer urgent" on the strength of a stability measurement whose denominator was
empty (`tag_snapshots` records only *changes*, and the board in question had
never been re-tagged). It is now quantified: **~4 points**, and verified live —
320 calls at `temperature: 0` on gpt-5.4-mini, zero failures.

Build it as the original design specified — quirk data, not a global:

**`server/ai-providers/openai.js`** — extend the existing `compat` block:

```js
compat: {
  maxTokensField: "max_completion_tokens", forceToolChoice: "required",
  strictTools: true, disableThinking: false, keyTest: "models",
  temperature: 0,
  // o3 rejects any non-default temperature with a hard 400 ("Only the default
  // (1) value is supported"), and o-series ids pass the tagging modelFilter —
  // a blanket temperature would permanently fail items for anyone picking one.
  noTemperature: "^o\\d",
},
```

**`server/ai-providers/wires/compat.js`**, inside `compatRequest` (line 54),
alongside the existing `disableThinking` spread:

```js
...(compat.temperature !== undefined &&
    !(compat.noTemperature && new RegExp(compat.noTemperature).test(model))
      ? { temperature: compat.temperature } : {}),
```

**`server/ai-providers/wires/anthropic.js`**, in `anthropicRequest` (line 34):
add `temperature: 0` unconditionally — every Claude model accepts it and the app
never enables extended thinking.

GLM and OpenRouter stay unset (GLM's quirks are live-verified by policy).

Pin in `compat.test.js`: `temperature: 0` present for a plain model id, absent
for one matching `noTemperature`.

This does **not** make output deterministic — the 18.3% residual above was
measured *at* temperature 0. It removes one variance source, not the main one.

---

## Work item 2 — vote mode

### 2.1 Migration `server/migrations/0029_vote_mode.sql`

```sql
-- Vote mode: tag an item N times with the identical prompt and keep the
-- majority answer per facet. Default 1 = today's behaviour exactly, so every
-- existing board is untouched until someone opts in.
--
-- tag_confidence is the point as much as the merged tags are: it records what
-- fraction of the runs agreed with the answer that was kept, per facet, making
-- tagger instability visible in the product for the first time. {} on every
-- existing row and on every single-pass tagging — an empty object means "not
-- measured", never "zero confidence".
ALTER TABLE boards ADD COLUMN ai_votes SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE items  ADD COLUMN tag_confidence JSONB NOT NULL DEFAULT '{}'::jsonb;
```

### 2.2 The merge — pure, exported, unit-tested

New in `server/worker.js`, next to `buildPrompt`. Kept free of db/provider
access so it tests without fixtures.

```js
const sameSet = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);

// Merge N independent taggings of ONE item into one answer.
//
// runs: [{ picks: {facetKey: [values]}, reasoning: {facetKey: sentence},
//          description, fit: {verdict, reasoning} }]  — already vocabulary-filtered,
//          values sorted, in call order (runs[0] is the first/cache-warming call).
//
// Confidence has ONE definition for every facet kind: the fraction of runs whose
// selection for that facet exactly equals the selection that was kept. It reads
// the same whether the facet is single- or multi-value, and 1.0 always means
// "every run said this".
export function mergeVotes(facets, runs) {
  if (runs.length === 1) return { ...runs[0], confidence: {} }; // votes=1 is the identity
  const need = Math.ceil(runs.length / 2); // strict majority for odd N
  const picks = {}, reasoning = {}, confidence = {};

  for (const f of facets) {
    const count = new Map(); // insertion order = run order, so ties resolve to the earliest run
    for (const r of runs) for (const v of r.picks[f.key] || []) count.set(v, (count.get(v) || 0) + 1);

    let chosen;
    if (f.single) {
      // argmax, NOT a majority threshold: a 3-way split must still yield a value.
      // Leaving it empty would read downstream as "nothing applies" — a
      // different claim entirely, and one the fit guard would then act on.
      let best = null, bestN = 0;
      for (const [v, n] of count) if (n > bestN) { best = v; bestN = n; }
      chosen = best === null ? [] : [best];
    } else {
      chosen = [...count].filter(([, n]) => n >= need).map(([v]) => v).sort();
    }
    picks[f.key] = chosen;
    confidence[f.key] = runs.filter((r) => sameSet(r.picks[f.key] || [], chosen)).length / runs.length;

    // The justification must belong to the answer that was kept — take it from
    // the earliest run that actually made that selection, not from run 0 blindly.
    const src = runs.find((r) => sameSet(r.picks[f.key] || [], chosen)) || runs[0];
    if (src.reasoning[f.key]) reasoning[f.key] = src.reasoning[f.key];
  }

  // description + fit come from ONE run — the one that most often agreed with
  // the merged result — so the item's prose stays internally coherent rather
  // than stitched from runs that disagreed with each other.
  const score = (r) => facets.filter((f) => sameSet(r.picks[f.key] || [], picks[f.key])).length;
  const best = runs.reduce((a, b) => (score(b) > score(a) ? b : a), runs[0]);

  const undecidedVotes = runs.filter((r) => r.fit?.verdict === "undecided").length;
  return {
    picks, reasoning, confidence,
    description: best.description,
    // tie -> match: the code-side filledFacets guard already arbitrates the
    // real decision (worker.js:1332), and "match" is the recoverable error.
    fit: { verdict: undecidedVotes > runs.length / 2 ? "undecided" : "match", reasoning: best.fit?.reasoning },
  };
}
```

### 2.3 `tagOne` — split into one-run + orchestrator

**The invariant: a vote pass is an internal API call, not a pipeline event.**
Voting lives entirely inside `tagOne`, which keeps returning exactly one result
for exactly one item. Nothing downstream of it learns that more than one call
happened.

| happens ONCE per item, unchanged | happens N times |
| --- | --- |
| `markTagged` — one row write | the provider HTTP call itself |
| `addTagSnapshot` — one history row | `bumpUsage` — see §2.4 |
| `evaluateItemAlerts` — one evaluation | |
| `legLog` — one "ok" line | |
| the embedding clear + re-embed | |
| attempts / `failOrRequeue` bookkeeping | |

`bumpUsage` is the sole deliberate exception, and it is not a pipeline event —
it is the ledger of *paid provider calls*, which is genuinely N. Collapsing it
to one would under-report spend by the vote count and corrupt every per-call
average derived from that table (including the ones this plan's cost case
rests on).

`tagOne` (`worker.js:1267`) currently builds the prompt, makes one call and
parses. Split the parse into a `parseRun` helper and wrap the call:

```js
  async function tagOne(row) {
    const prompt = await getBoardPrompt(db, row.board_id);
    if (!prompt) throw new Error(`board ${row.board_id} has no facets configured`);
    const { systemText, schema, allowed, facets, votes } = prompt;
    const ai = await resolveBoardAi(db, prompt);
    if (!ai) throw noKeyError();

    /* ... entity / parts / fieldLines build is unchanged ... */

    const usages = [];
    const once = async () => {
      const { input, usage } = await trackedTagger(db, {
        provider: ai.provider, apiKey: ai.apiKey, base: ai.base, model: ai.model,
        systemText, schema, parts, research: prompt.research,
      });
      usages.push(usage);
      return parseRun(input, facets, allowed);
    };

    // Run 1 alone, THEN the rest in parallel. The provider-side prompt cache is
    // written by a completed call — firing all N at once makes all N miss and
    // costs ~7,000 extra fresh tokens per item (measured). One call of latency
    // buys that back.
    const runs = [await once()];
    if (votes > 1) {
      const rest = await Promise.allSettled(Array.from({ length: votes - 1 }, once));
      for (const r of rest) {
        if (r.status === "fulfilled") runs.push(r.value);
        else console.warn(`vote run failed for #${row.id}: ${r.reason?.message} — merging ${runs.length}`);
      }
    }

    const merged = mergeVotes(facets, runs);

    const tags = [];
    let filledFacets = 0;
    for (const f of facets) {
      if (merged.picks[f.key].length) filledFacets++;
      for (const v of merged.picks[f.key]) tags.push(`${f.key}/${v}`);
    }
    const reasoning = { ...merged.reasoning };
    if (merged.description) reasoning.description = merged.description;
    if (merged.fit.reasoning) reasoning.fit = merged.fit.reasoning;
    const undecided = merged.fit.verdict === "undecided" && filledFacets < facets.length / 2;

    return { tags, undecided, reasoning, confidence: merged.confidence,
             usages, votes: runs.length, model: ai.model, provider: ai.provider };
  }
```

`parseRun` is the existing per-facet parse loop lifted out of `tagOne` — the
`Array.isArray(entry) ? entry : entry.values` tolerance and the `allowed.has()`
filter stay exactly as they are. It also becomes the one place the
**reasoning-off** shape is normalised, so `mergeVotes` never sees two forms:

```js
function parseRun(input, facets, allowed) {
  const picks = {}, reasoning = {};
  for (const f of facets) {
    const e = input[f.key];
    const vals = Array.isArray(e) ? e : e && Array.isArray(e.values) ? e.values : [];
    picks[f.key] = vals.filter((v) => allowed.has(`${f.key}/${v}`)).sort();
    if (e && typeof e.reasoning === "string" && e.reasoning.trim()) reasoning[f.key] = e.reasoning.trim();
  }
  // ai_reasoning:false boards emit fit as a bare enum string and no description
  // at all — normalise here so the merge has exactly one shape to handle.
  const fit = typeof input.fit === "string" ? { verdict: input.fit } : (input.fit || {});
  const description = typeof input.description === "string" && input.description.trim()
    ? input.description.trim() : undefined;
  return { picks, reasoning, description, fit };
}
```

**Only run 1 failing fails the item.** Runs 2..N are `allSettled`, so a timeout
on the third vote must never cost the item its attempts.

### 2.4 Usage accounting — the trap

`bumpUsage` (`db.js:2211`) hardcodes `count = ... + 1`. With N votes it must be
called N times or `ai_board_usage.count` under-reports calls and every per-call
average derived from that table silently breaks — including the token figures
this plan's cost case rests on.

At the tag call site (`worker.js:1660`):

```js
      const { tags, undecided, reasoning, confidence, usages, votes, model } = result;
      const landed = await markTagged(db, row.id, tags, undecided, reasoning, confidence);
      for (const u of usages) await bumpUsage(db, row.board_id, u); // one row per PAID call
```

and add `votes` to the `legLog` detail so the job log shows what an item cost.
The extract call site (`worker.js:1908`) is single-call and unchanged.

### 2.5 `markTagged` — carry confidence

`db.js:2019`, one new parameter and one new column in the UPDATE:

```js
export async function markTagged(db, id, tags, undecided = false, reasoning = {}, confidence = {}) {
  const { rowCount } = await db.query(
    "UPDATE items SET status='tagged', tags=$1, undecided=$2, tag_reasoning=$3, tag_confidence=$4, " +
    "error=NULL, retry_at=NULL, embedding=NULL, embedding_model=NULL, embed_error=NULL, updated_at=$5 " +
    "WHERE id=$6 AND status='processing'",
    [JSON.stringify(tags), undecided, JSON.stringify(reasoning || {}), JSON.stringify(confidence || {}), Date.now(), id]
  );
  if (rowCount) await addTagSnapshot(db, id, "ai", tags, reasoning, undecided);
  return rowCount > 0;
}
```

`addTagSnapshot` is deliberately left alone — confidence is current-state, not
history, and adding it would change the snapshot dedupe comparison.

### 2.6 Board plumbing

- **`db.js:818`** — add `ai_votes` to `BOARD_COLS`.
- **`db.js:824`** `createBoard` — new `extras.aiVotes ?? 1`, one more column and
  placeholder in the INSERT.
- **`db.js:852`** `updateBoard` — follow the `aiReasoning` line exactly:
  ```js
  if (aiVotes !== undefined) { vals.push(Number(aiVotes)); sets.push(`ai_votes=$${vals.length}`); }
  ```
- **`worker.js:441`** `getBoardPrompt` — carry it on the cached entry so
  `tagOne` needs no second board fetch:
  ```js
  const entry = { systemText, schema, allowed, facets, research,
                  votes: Math.max(1, board.ai_votes || 1),
                  aiKeyId: board.ai_key_id, aiModel: board.ai_model };
  ```
  `invalidateBoardCache` already fires on board PATCH, so a votes change takes
  effect on the next item.
- **`server.js:813` and `:916`** — expose `ai_votes: b.ai_votes || 1` on both
  board response shapes.

### 2.7 Route validation

In the PATCH body reader (`server.js:1128`, beside `ai_reasoning`):

```js
  if (body.ai_votes !== undefined) {
    const v = Number(body.ai_votes);
    if (![1, 3, 5].includes(v)) return { error: "ai_votes must be 1, 3 or 5" };
    // Research bills up to 5 web searches per CALL on top of tokens; multiplying
    // that by the vote count is a cost trap, not a feature.
    const research = body.ai_research ?? prev.ai_research;
    if (v > 1 && research) return { error: "vote mode cannot be combined with web research" };
    update.aiVotes = v;
  }
```

Odd values only — ties are the one genuinely ambiguous merge case, and odd N
avoids them for single-value facets. Mirror the same check in the create route
(`server.js:1206`).

### 2.8 UI

`board-modal.js:395`, immediately after the **AI reasoning** switch, inside the
existing Tagging Settings block:

```js
  let aiVotes = isNew ? 1 : (board.ai_votes || 1);
  const voteSel = document.createElement("select");
  for (const [n, label] of [[1, "single pass"], [3, "best of 3"], [5, "best of 5"]]) {
    const o = document.createElement("option");
    o.value = String(n); o.textContent = label; voteSel.appendChild(o);
  }
  voteSel.value = String(aiVotes);
  voteSel.onchange = () => { aiVotes = Number(voteSel.value); };
```

wrapped in a labelled row reading:

> **Agreement passes** — *(tag each item more than once and keep the answer the
> AI repeats; costs roughly one extra pass each, and records how often it agreed
> with itself)*

Disable the select with an inline note when Web research is on, matching the
route guard. Add `ai_votes: aiVotes` to the save payload (`board-modal.js:527`).

### 2.9 Surfacing confidence

The reason to build this. Two places:

1. **Lightbox** — next to each facet's reasoning sentence, a muted marker when
   `tag_confidence[facetKey] < 1` (e.g. "2/3 passes agreed"). Absent when the
   object is empty, so single-pass boards look exactly as they do today.
2. **Board tag stats** — mean confidence per facet across the board. This is the
   readout that tells a user *which of their own facets is unreliable*, on any
   board, without anyone running an experiment.

Both read a column that is `{}` everywhere until vote mode is switched on, so
neither needs a backfill.

### 2.10 Tests

New `test/votes.test.js`, all against `mergeVotes` directly:

- unanimous → that answer, confidence 1.0 on every facet
- 2-of-3 on a single-value facet → the majority value, confidence 0.67
- 3-way split on a single-value facet → run 1's value, confidence 0.33, **not
  empty**
- multi-value at exactly the threshold → value kept; one below → dropped
- reasoning sentence comes from a run that actually made the kept selection
- `runs.length === 1` → byte-identical to the input run, `confidence: {}`

Plus:
- `prompt.test.js` — `ai_votes: 1` board produces today's request unchanged.
- `job-log.test.js` style — three votes produce three `bumpUsage` calls.
- `board-manage.test.js` — PATCH rejects `ai_votes: 2` and rejects votes>1 with
  research on.

---

## Blast radius — what else this touches

Traced through the codebase after the plan above was drafted. Everything here is
required, not optional; several would be silent bugs rather than loud ones.

### Manual tag edits must drop stale confidence

`setItemTags` (`db.js:354`) already deletes the `tag_reasoning` entry for any
facet whose values the user changed — otherwise the stored justification would
describe an answer the AI never gave. **Confidence has exactly the same
problem** and needs the same treatment in the same loop, or a hand-corrected tag
keeps a "2 of 3 passes agreed" badge attached to a value no pass ever chose:

```js
export async function setItemTags(db, id, tags) {
  const { rows } = await db.query("SELECT tags, tag_reasoning, tag_confidence FROM items WHERE id=$1", [id]);
  const reasoning = { ...(rows[0]?.tag_reasoning || {}) };
  const confidence = { ...(rows[0]?.tag_confidence || {}) };
  /* ... existing before/after diff ... */
    if (b.size !== a.size || [...b].some((v) => !a.has(v))) { delete reasoning[key]; delete confidence[key]; }
  /* ... UPDATE gains tag_confidence=$N ... */
}
```

### The lightbox reads a different query than the items list

Confidence must ride `getItemReasoning` (`db.js:398`), which currently selects
`board_id, tag_reasoning, payload`, and the `/api/instances/:id/reasoning`
response (`server.js:2382`). It does **not** belong on the items list payload —
reasoning is deliberately kept off it and fetched lazily when the panel opens.

`lightbox.js` already distinguishes three empty states carefully (lines
589–594): no tags, tagged-before-reasoning-was-captured, and reasoning-off. A
fourth is now needed and it is the one that matters: **`{}` means *not
measured*, never *zero agreement*.** A single-pass board must render nothing at
all — not "1/1 passes agreed".

### Boards with reasoning off need normalising before the merge

With `ai_reasoning: false` the schema drops `description` entirely and `fit`
becomes a bare string enum rather than an object. `tagOne` already tolerates
both shapes (`worker.js:1312`, `:1324`); that tolerance must move into
`parseRun` so `mergeVotes` only ever sees the normalised form. `mergeVotes` must
not assume `r.fit.verdict` exists — hence `r.fit?.verdict` in §2.2, and
`description` simply being `undefined` for such boards. At least one board in
this instance runs with reasoning off.

### Backup/restore: the migration's defaults are load-bearing

`backup.js` discovers columns from the live catalog, so new columns dump
automatically with no code change. Restore is the constraint: `loadTable`
(`backup.js:447`) INSERTs **only the columns the archive's manifest names**, so
a pre-0029 archive restored into a post-0029 schema leaves `ai_votes` and
`tag_confidence` to their column DEFAULTs.

That works **only because both are `NOT NULL DEFAULT`.** A `NOT NULL` column
without a default would make every existing archive unrestorable. Keep the
defaults in §2.1 exactly as written. (The reverse direction is already refused —
the manifest's `migrationId` is checked against known migrations, so a newer
archive into an older app fails loudly at `backup.js:344`.)

### Worker lanes multiply, and the rate bucket absorbs it by blocking

`AI_INFLIGHT` defaults to 8 (`worker.js:1128`). Vote mode makes each lane slot
hold up to N concurrent provider calls, so peak in-flight requests go to 8×3=24
at three votes and 8×5=40 at five — against OpenAI's descriptor `burst: 25`.

`provider-pacing.js` is a token bucket that **waits** rather than fails, so
nothing breaks; the bucket simply becomes the bottleneck and per-item latency
grows beyond the 2× the sequencing already implies. Either divide the effective
lane count by the vote count when claiming, or document that a high-vote board
wants `AI_INFLIGHT` lowered. Worth a decision, not a surprise in production.

### Bulk retag becomes an N× cost event

`/api/admin/boards/:id/retag` (`server.js:1507`) re-queues an entire board. At
three votes on a 4.5k-item board that is ~13,700 paid calls from one click. The
admin confirm should show the multiplied call estimate, not the item count.
Same for `retag_on_refresh` and scheduled retags, which the board modal copy
must state.

### Alerts: instability is a one-way ratchet, and vote mode is the only brake

Alerts do **not** key off tag changes — that reading is wrong and worth stating
plainly, because it inverts the conclusion. Detection is a *state* test
(`matchesCondition(ent.tagSet, condition)`, `alerts.js:78`), and `addAlertMatch`
(`db.js:2369`) dedupes on `(alert_id, entity_id)` with `ON CONFLICT DO NOTHING`.
An entity fires an alert **at most once, ever**. Tag churn cannot produce repeat
firings; that was never the exposure.

The real exposure is that a match is **never retracted**. The only `DELETE` on
`alert_matches` is `pruneAlertStaleClaims` (`db.js:2433`), which runs only when
an alert's *condition* is edited, and deliberately leaves already-fired rows
("Fired rows stay — history, announced under the reading of their day").

So a single noisy tag that momentarily lands an entity in the matching set
fires once, is recorded permanently, and **no later correction undoes it**. With
18–22% per-facet instability, every re-tagging pass is a fresh opportunity for
an irreversible false entry, and the false-positive set only ever grows.

Two consequences for this plan:

- This is an argument **for** vote mode on any board carrying alerts, not a
  caveat against it. Suppressing a spurious flip is the only available mechanism
  — there is no un-match path by design.
- The ratchet is barely exercised today: `auto_tag_periodic` is armed on no
  board and `job_log` has recorded no `retag` runs. It becomes real the moment
  someone enables scheduled retagging, which is exactly when per-item cost also
  multiplies by the vote count. Those two settings should be considered
  together in the board modal copy.

The once-ever semantics themselves are intentional and are not in scope to
change here.

### Not affected (checked)

- `embedTextFor` reads tags + reasoning in their existing shapes, and
  `markTagged` already clears the vector, so re-embedding behaves exactly as
  today.
- `addTagSnapshot` is untouched by design — confidence is current state, not
  history, and adding it would change the snapshot dedupe comparison.
- The `ai_usage` table (day, count) has **no writer** anywhere in the server —
  only `ai_board_usage` is live. Do not wire votes into it.

---

## Work item 3 — diagnose broken facets automatically

Vote mode explains *that* a facet is unreliable. This explains *why*, and lands
the explanation where the fix is made — inside the facet editor, already written
when the user opens it.

### The cause is always the same shape

Instability is not vagueness. It is two values that are **simultaneously true**
with no rule for which wins: a wide lockup is genuinely horizontal *and*
rectangular *and* asymmetric; a two-colour blend is genuinely both duotone and
gradient. Facets whose values are mutually exclusive by construction measured at
2.5% instability; facets with overlapping values at 42%.

So the output that fixes it is always the same shape too — a precedence rule
appended to the facet description, in the style the strongest existing glosses
already use ("where each could stand alone").

### Where the data comes from

Nobody inspects images. The roll-up is a query over `tag_confidence`, which
§2.2 already writes per item as `{of, agreed, votes}` — `votes` being the full
tally *including the values that lost*. Group by facet across the board:

```
construction  inconclusive on 15 of 80 items  ->  monoline-linework (12),
                                                  letter-fusion (4),
                                                  3d-dimensional (2)
industry      inconclusive on 18 of 80 items  ->  hospitality-retail (5),
                                                  tech-saas (5),
                                                  industrial-trade (4)
```

That table is the entire input to the diagnosis. It is text, no images, so the
call is small.

### One call per facet, not per item

A facet that fails to converge on 18 items is one broken facet observed 18
times, not 18 puzzles. Per-item diagnosis would buy 18 near-identical
paragraphs, each attached to one image, none of which changes how anything is
tagged. Per-facet diagnosis buys one paragraph that fixes every future item.

Cost is then 3-4 calls per board (only the unstable facets qualify) against the
thousands vote mode itself spends — a rounding error, which is why it runs
automatically instead of behind a button.

### When it runs

**Not on page load** — that would block the modal on an AI call every time it
opens. The worker generates it in the background after a tagging run and stores
it on the facet; the editor only ever reads stored text.

Regenerate only when its inputs change, keyed on a hash of (facet description +
the disagreement tally). Without that guard every retag re-pays for the same
paragraph. Editing the description naturally invalidates it, so a fresh
diagnosis appears after the next retag — which is exactly the feedback loop the
user wants.

Gate on having enough signal: below ~20 items carrying confidence for that
facet, the tally is noise and no call should be made.

### What the user sees

Nothing to click, nothing to discover. Opening the board's facet editor:

```
CONSTRUCTION TECHNIQUES                     [single value: off]
  the construction methods visible in the mark...

  !  The AI disagreed with itself on 18% of items.
     monoline-linework and gradient-blend are being applied to the same
     marks - a thin even stroke can also carry a colour blend, and this
     description doesn't say which wins.
     Try adding: "when a mark has both a uniform stroke and a colour
     blend, prefer gradient-blend."

TYPOGRAPHY                                  [single value: off]
  the letterform style...
  OK  stable
```

The AI never edits the taxonomy. It writes a suggestion; the user accepts,
rewrites, or ignores it, then hits the retag button that already exists.

### Consequences worth stating

- This rides on vote mode. A single-pass board records no confidence, so it gets
  no diagnosis. That is a coherent story to tell in the UI: votes buy better
  tags *and* the explanation of why the taxonomy needed fixing.
- The suggestion is model output about model behaviour. It should be framed as a
  suggestion in the copy, never as a finding — the user is the one who knows
  what the facet is for.

Precedent for the size of the win: a single gloss edit on one board moved 228 of
498 re-tagged items, every one in the same direction. Free per item, unlike
everything else in this plan.

---

## Explicitly not building

- **One call per facet.** +3.2/+5.1 pts over the noise floor, direction
  unscoreable, 7–9× input and 3× output. The cached-prefix variant additionally
  broke single-value compliance (97.5% → 68.8% picking exactly one). Literature
  agrees the ceiling is small (≤2.2 pts up to 10 stacked variables for every
  model tested except GPT-5-nano).
- **Reordering or canonicalising value lists.** Zero measured effect.
- **Shrinking taxonomies.** The label-space degradation literature concerns
  50–1000 mutually exclusive classes; per decision this app asks for one of
  3–10, and across all boards exactly one declared value is unused.

## Order

1. **§1 temperature** — smallest diff, ~4 points, and it lowers the noise §2
   then has to vote away.
2. **§2.1–2.7** — migration, `mergeVotes`, `tagOne`, usage. Shippable and
   testable with no UI.
3. **§2.8–2.9** — the select and the confidence readout.
4. **§3** — after confidence data exists to drive it.

## Open questions

- 3 votes or 5 by default? Answerable once §2 ships: run a board at 5 and count
  how often votes 4–5 overturn the majority reached at 3.
- Per-facet vote counts? Instability is very unevenly spread (2.5% to 42% within
  one board), so voting only the unstable facets would cut cost sharply — but it
  reintroduces the per-facet call machinery this plan rejects. Revisit when
  `tag_confidence` shows the spread across several boards.
- The 18.3% residual at temperature 0 was never traced. Candidates: reasoning-
  token variance, MoE routing, batch nondeterminism. One probe against a
  non-reasoning model would establish whether it is really a floor.
