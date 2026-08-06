# Facet-addressable tagging — implementation plan

Make the facet set a **parameter of a tagging pass** rather than a fixed
property of the board: a pass can be told "only `construction`", and only that
facet's answers land. Everything else about the pass is unchanged.

## Why (and why the obvious reason is the weak one)

`tagging-accuracy-plan.md` rejected one-call-per-facet, but only ever asked one
question of it — *does splitting tag better?* (+3.2/+5.1 pts, direction
unscoreable, 7–9× input). It never asked whether splitting makes a facet
**addressable**. That is a different question and the rejection does not cover
it.

Three things want addressability, and they arrived independently:

1. **Fixing one facet shouldn't shake the other eight.** A full retag re-rolls
   every facet at 18–22% instability. Editing `construction`'s gloss today
   means re-rolling `typography`, `motif` and `industry` for nothing.
2. **The alert ratchet.** A match is recorded once and **never retracted**
   (`db.js:2369` dedupes on `(alert_id, entity_id)`; the only DELETE is
   `pruneAlertStaleClaims`, which fires on condition edits and deliberately
   leaves fired rows). Every re-roll of a facet is a fresh chance at a
   permanent false entry. Re-rolling eight facets to fix one is eight
   unnecessary chances.
3. **A gloss edit is currently unmeasurable.** The plan cites "a single gloss
   edit moved 228 of 498 re-tagged items, every one in the same direction" —
   that number is confounded, because everything else moved in the same pass.
   Scoped retagging is the only way to get a clean before/after.

`tagging-accuracy-plan.md`'s own open questions already want the same
machinery for a fourth reason — "voting only the unstable facets would cut cost
sharply, but it reintroduces the per-facet call machinery this plan rejects."

**Cost is the weakest argument, and the plan should not lean on it.** From the
measured table: one call for all nine facets is 1,149 fresh input / 374 output;
nine per-facet calls are 8,199 / 1,084, so ~911 / ~120 each. The per-call input
floor is the **image**, paid once per call whatever you ask about — which is why
nine calls cost nine images, not one image plus eight small asks. Scoping saves
~21% of input (just the facet-block text, shrinking further as `systemText`
caches) and ~68% of output. Call it 30–50% of a retag depending on the output
price multiple — **essentially all of it output**. Worth having; not worth
risking accuracy for. See §2.6.

---

## The split that makes this cheap

The capability divides at a seam that turns out to be very favourable:

| | what the model is asked | what is written | prompt risk |
| --- | --- | --- | --- |
| **Stage 1 — write scope** | all facets, exactly as today | only the scoped facets | **none** |
| **Stage 2 — prompt scope** | only the scoped facets | only the scoped facets | needs a probe |

Stage 1 delivers **all three motivating wins** — undisturbed facets, no extra
alert exposure, clean before/after — at **zero prompt change**, therefore zero
accuracy risk. It costs exactly what a full retag costs today.

Stage 2 adds the 30–50% saving and nothing else, and it carries the one measured
hazard below. It is optional, and it is gated on a probe.

**Backward compatibility differs between them, and the difference matters.**
Stage 1 is inert by construction: a nullable column that is NULL everywhere,
a merge whose first line is `if (!scope?.length) return next`, and an optional
route field. Nothing reads the scope except the scoped path. Stage 2 edits
`buildPrompt`, which runs for every board on every call — its no-op-when-unscoped
property is an *intention*, not a structure, which is why §2.3 makes pinning the
current prompt a prerequisite rather than a hope.

Stage 1 is also a strict prerequisite: both stages need the same merge, the
same scope plumbing, the same UI. Build it first, ship it, then decide whether
Stage 2 earns its risk.

### The hazard Stage 2 has to clear first

`tagging-accuracy-plan.md` recorded that the cached-prefix per-facet variant
**broke single-value compliance, 97.5% → 68.8% picking exactly one.** That is
possible because `single: true` is prompt-only — `buildPrompt` emits

```js
values: { type: "array", items: { type: "string", enum: f.values } }   // worker.js:253
```

with **no `maxItems`**, so nothing structurally prevents three values coming
back for a "pick exactly one" facet.

The measured variant declared all nine facets in a cached prefix and asked for
one, which is a genuinely confusing ask; a clean single-facet prompt is a
different shape and may not reproduce it. **Step zero of Stage 2 is to find
out**, on the logos board, before any of Stage 2 is written (§2.8).

A failure is not automatically fatal: `mergeVotes`' argmax already collapses a
multi-value answer on a single-value facet, so the risk is covered on voting
boards and uncovered only on single-pass ones. The fallback is to gate Stage 2
on `ai_votes > 1` rather than drop it — see §2.7, including why the obvious
schema fix (`maxItems: 1`) probably is not available.

> **RESOLVED 2026-08-06 — the probe passed, 40/40 on both arms.** The fallback
> above was not needed and Stage 2 ships ungated. Kept here because it is the
> right response if the result ever stops holding (a model change, a new
> provider). Full results and the one residual finding are in §2.8.

---

## Stage 1 — write scope

### 1.1 Migration `server/migrations/0030_facet_scope.sql`

```sql
-- Which facets a queued tagging pass is allowed to WRITE. NULL = all of them,
-- which is every existing row and every ordinary pass — so nothing changes
-- until something sets it.
--
-- Nullable with no default on purpose: a pre-0030 archive restores into this
-- schema with NULL everywhere, which is exactly "unscoped" (backup.js loadTable
-- INSERTs only the columns the archive names). A NOT NULL column would have
-- needed a default to stay restorable; NULL already carries the meaning.
ALTER TABLE items ADD COLUMN tag_facets TEXT[];
```

A column, not a `payload` key, despite `park` / `extracted_at` setting the
transient-flag precedent: `payload` is the item's *definition* (identity, files,
fields) and this is queue state. It also rides `claimFairBatch`'s `RETURNING *`
into `row` for free, survives `failOrRequeue` and `recoverStuck` untouched
(neither writes it), and dumps/restores with no `backup.js` change.

### 1.2 The merge — pure, exported, unit-tested

Next to `mergeVotes` in `worker.js`, same discipline: no db, no provider. Both
sides arrive in the same shape — the call site adapts the DB row's snake_case,
so the pure function never has to know which argument came from where.

```js
// Fold a scoped tagging result into what the item already has.
//
// `facets` is the board's ORDERED facet list, and rebuilding through it is not
// cosmetic: tagOne emits tags in board-facet order, so a lexicographic sort
// here would make a scoped landing store a different array order than a full
// one, flipping with whichever path wrote last.
//
// Nothing special is needed for `description` and `fit`: they are reserved keys
// in tag_reasoning, never facet keys, so they are never in `keep` and ride
// through untouched on the spread. (A board MAY declare a facet literally named
// `description` — buildPrompt gives it the facet slot — and in that case
// scoping to it SHOULD replace it, which is what falling through does.)
export function scopeResult(facets, scope, prev, next) {
  if (!scope?.length) return next;                        // unscoped = identity
  const keep = new Set(scope);

  // Group both sides once, then emit in board order — same discipline as
  // db.js tagsByFacet, including its `i <= 0` guard against a malformed tag.
  const group = (tags = []) => {
    const m = new Map();
    for (const t of tags) {
      const i = t.indexOf("/");
      if (i <= 0) continue;
      if (!m.has(t.slice(0, i))) m.set(t.slice(0, i), []);
      m.get(t.slice(0, i)).push(t.slice(i + 1));
    }
    return m;
  };
  const prevBy = group(prev.tags);
  const nextBy = group(next.tags);
  const tags = [];
  for (const f of facets) {
    for (const v of (keep.has(f.key) ? nextBy : prevBy).get(f.key) || []) tags.push(`${f.key}/${v}`);
  }

  const pick = (a = {}, b = {}) => {
    const out = { ...a };
    for (const k of keep) { delete out[k]; if (b[k] !== undefined) out[k] = b[k]; }
    return out;
  };
  return {
    tags,
    reasoning: pick(prev.reasoning, next.reasoning),
    confidence: pick(prev.confidence, next.confidence),
  };
}
```

`prev` is the **claim-time row**, and that is safe without a re-read — see the
fence note in the blast radius.

Note what this deliberately does NOT preserve: a tag whose facet key is no
longer on the board is dropped, because the rebuild walks `facets`. That is the
right answer (the facet is gone, its tags are orphaned) but it means a scoped
pass also quietly garbage-collects stale facet keys. Worth a test so it is a
decision rather than a surprise.

### 1.3 `markTagged` — carry the scope, and clear it

Two things a first draft gets wrong here.

**`undecided` must not move on a scoped pass** — the verdict is a whole-item
judgment and this pass spoke for part of the item. An item flagged undecided
while eight facets keep their tags is incoherent either way.

**…and the snapshot must then be told the STORED flag, not the fresh verdict.**
`addTagSnapshot` dedupes on `last.undecided === undecided && sameTagSet(...)`
(`db.js:395`). Handing it a verdict that was never written makes the comparison
test fiction — it spuriously appends when the flag "changed" and spuriously
skips when it "matched". So a scoped call passes the item's existing flag
through.

```js
export async function markTagged(db, id, tags, undecided, reasoning, confidence, scope = null) {
  const scoped = !!scope?.length;
  const sets = ["status='tagged'", "tags=$1", "tag_reasoning=$2", "tag_confidence=$3",
                "tag_facets=NULL", "error=NULL", "retry_at=NULL",
                "embedding=NULL", "embedding_model=NULL", "embed_error=NULL"];
  if (!scoped) sets.push("undecided=$5");   // built, not interpolated around a $N
  /* … UPDATE items SET <sets>, updated_at=$4 WHERE id=$6 AND status='processing' … */
  if (rowCount) await addTagSnapshot(db, id, "ai", tags, reasoning, undecided);
  return rowCount > 0;
}
```

with the caller passing the item's current flag on a scoped pass:

```js
await markTagged(db, row.id, merged.tags, scope ? row.undecided : result.undecided,
                 merged.reasoning, merged.confidence, scope);
```

**`tag_facets=NULL` on every landing is load-bearing** — see the blast radius.

### 1.4 Queueing a scoped pass

```js
// Only 'tagged' rows: an item that never landed has no other facets to
// preserve, and one that is held/failed needs its whole pass, not a slice.
// Straight to 'pending' — a facet retag must never turn into a re-extraction
// or a re-face, which is the trap retagBoard's status CASE exists to handle.
export async function retagBoardFacets(db, boardId, facetKeys) {
  const { rowCount } = await db.query(
    `UPDATE items SET status='pending', tag_facets=$3::text[], attempts=0,
       error=NULL, retry_at=NULL, updated_at=$1
     WHERE board_id=$2 AND status='tagged'`,
    [Date.now(), boardId, facetKeys]
  );
  return rowCount;
}
```

### 1.5 `tagOne` / `processOne`

`tagOne` is **unchanged** in Stage 1 — it still asks for every facet and still
returns every facet's answers. The scope is applied at the landing:

```js
const scope = row.tag_facets;                       // null on an ordinary pass
const merged = scopeResult(facets, scope, {         // row IS the claim-time state
  tags: row.tags, reasoning: row.tag_reasoning, confidence: row.tag_confidence,
}, result);
```

and `legLog` gains `...(scope?.length ? { facets: scope } : {})`, so the job log
says which facets a pass was for.

**The facet-less early return needs a guard.** `processOne` currently answers a
board with no facets by landing the item empty (`worker.js:1775`):

```js
if (!(await getBoardPrompt(db, row.board_id))) {
  if (await markTagged(db, row.id, [], false, {})) { … }
```

On a scoped pass over a board whose facets were all deleted, that erases
**every** tag on the item, not just the scoped one — the exact opposite of what
scoping promises. A scoped row here must land unchanged (clearing only its
scope), and say so in the job log.

### 1.6 Routes

- `POST /api/admin/boards/:id/retag` gains an optional `{ facets: [...] }`.
  Validate every key against the board's current facets and 400 on an unknown
  one — a typo silently retagging nothing is the worst outcome here.
- `POST /api/instances/:id/retag` gains the same, for the lightbox.

### 1.7 UI

The facet editor (`board-modal.js`, `buildFacetEditor`, the `.fe-facet` head at
line ~106) — a "retag this facet" control per facet, which is also where work
item 3's diagnosis lands. Two hard requirements, both from the blast radius:
**save before retagging**, and **no button on an unsaved or renamed facet.**

The confirm carries the multiplied estimate the same way the board retag now
does (`admin-boards.js`), including the vote count.

### 1.8 Tests

`test/facet-scope.test.js`, against `scopeResult` directly:

- `scope: null` → byte-identical to the unscoped result, on all three fields
- one facet in scope → its tags replaced, every other facet's tags preserved
- **the merged array is in board-facet order, identical to what an unscoped
  landing would have produced** — the one a lexicographic sort gets wrong
- a scoped facet that comes back empty → its old tags **removed**, not kept
- `description` and `fit` survive a scoped merge; a board that declares a facet
  literally named `description` has it replaced when scoped to it
- confidence follows tags: replaced in scope, preserved out of scope
- a stored tag whose facet is no longer on the board is dropped (documented
  garbage collection, not a surprise)
- a malformed tag with no `/` does not corrupt the merge

Integration: a scoped retag on a 2-facet board writes one facet, leaves the
other, **leaves `undecided` and writes a snapshot consistent with it**, appends
exactly one snapshot, and clears `tag_facets`.

And the site guard — seven small tests, one per row of the blast-radius table,
each asserting `tag_facets IS NULL` afterwards. These are what hold the set
together, since six other writers are exempt only by their current WHERE
clauses.

---

## Stage 2 — prompt scope (only if the probe clears)

What Stage 2 actually buys, stated precisely: **Stage 1 pays for a whole-item
description and eight facets' reasoning sentences and then throws them away.**
Stage 2 stops buying what it discards.

`buildPrompt(facets, context, withReasoning, subject, withResearch)` already
takes a facet array, so the prompt is nearly free. What it needs:

### 2.1 `getBoardPrompt` must carry TWO facet lists

The sharpest trap in this plan, and it is created by Stage 1's own fix.
`scopeResult` rebuilds merged tags by walking the **board's ordered facet
list**. Stage 2 makes `getBoardPrompt` return the **scoped** list, because that
is what builds the prompt and drives `parseRun`.

Hand `scopeResult` the scoped list and it emits one facet and **silently drops
the other eight facets' tags on every scoped pass** — the exact opposite of what
scoping promises. The cache entry carries both:

```js
const entry = { systemText, schema, allowed, facets: scoped, allFacets: board.facets, /* … */ };
```

`allowed` stays board-wide rather than scoped: `parseRun` iterates `facets` and
only asks `allowed.has()`, so a wider set is harmless while a narrower one
silently filters valid answers.

### 2.2 Cache keying — nest the map, don't sweep it

Keying on `boardId + sorted scope` means `invalidateBoardCache` must stop being
a single `delete`. If it doesn't, a facet edit leaves the scoped variants live
and the board keeps tagging against the **old gloss** — precisely the bug this
feature exists to let users fix.

Use a nested map, `boardId -> Map<scopeKey, entry>`, so `invalidateBoardCache`
stays `.delete(boardId)` **unchanged** and the bug is impossible rather than
remembered. (Unlike Stage 1's structural options, this one is free — take it.)

### 2.3 Prerequisite: pin the unscoped prompt first

`buildPrompt` builds the system prompt for **every board on every call**, and
Stage 2 rewrites four places in it. The intent is that unscoped output is
byte-identical — but nothing currently proves that. Every `systemText`
assertion in `prompt.test.js` and `research.test.js` is a regex *fragment*
match:

```js
assert.match(systemText, /description of the item as a whole/);
assert.doesNotMatch(systemText, /image/i);
```

So this refactor could reword or drop a sentence of the tagging prompt for every
board and the suite would stay green — on a codebase whose whole recent history
is measuring 4-point effects from prompt wording.

**Before touching `buildPrompt`:** a golden-snapshot test of the unscoped
`systemText` and `schema` for a fixed facet set, in both `ai_reasoning` modes.
Then any Stage 2 edit that changes the unscoped prompt fails loudly and on
purpose, and the snapshot diff is the review.

### 2.4 The scoped prompt is four edits, not two

Dropping `properties.description` and `properties.fit` is not enough. The prose
references both:

- the fit paragraph in `systemText` ("Also decide whether the item is the kind
  of material…")
- **`selectPara` — both variants** end with "when the fit verdict is
  'undecided', leave every facet's values empty", and the reasoning variant
  opens with "Start with a freeform description of the item as a whole"
- `properties.description` (already conditional on a facet not claiming the key)
- `properties.fit`

Miss `selectPara` and the scoped prompt instructs the model about a verdict and
a description its schema no longer has.

### 2.5 Edge cases

- **scope == every facet** normalises to unscoped, so "retag everything" through
  the scoped path is byte-identical to an ordinary pass.
- **scope ∩ board facets = ∅** (the facet was deleted after queueing) lands the
  item unchanged with no call — the Stage 1 facet-less guard covers this.
- **a facet named `fit`** is clobbered by the reserved verdict today and that is
  deliberate (`prompt.test.js`, "a facet named 'fit' cannot clobber the reserved
  fit verdict"). Scoped mode drops `properties.fit`, which would hand the slot
  back — so that facet behaves differently scoped and unscoped. Refuse scoping
  to it at the route, rather than growing a second behaviour.

### 2.6 What it saves, and why the number is what it is

The per-call input floor is **the image**, paid once per call regardless of how
many facets are asked about — which is why nine per-facet calls measured ~9 ×
911 rather than anything like 1,149 + 8 × small. So:

- input 1,149 → ~911 is only the facet-block text, and it shrinks further once
  `systemText` caches across items (a scoped retag is one prompt shape for the
  whole board, so it caches as well as today's does)
- output 374 → ~120 is the real saving

At a 4× output premium that is ~47% of a retag; at parity, ~32%. **Call it
30–50%, essentially all output**, larger on boards with many facets and on text
boards where input is not image-dominated.

`outputBudget` is `max(2048, min(1024 + 128·props, 8192))` (`wires/tool.js:17`),
so a one-facet schema moves the **cap** only 2432 → 2048. The saving is in
tokens actually emitted, not in the budget.

### 2.7 If the probe fails, the obvious mitigation may not exist

The reflex fix for degraded single-value compliance is `maxItems: 1` on `single`
facets. The app sends `strict: true` for openai and gemini
(`wires/compat.js:87`), and OpenAI's strict schema subset is believed **not** to
support `minItems`/`maxItems` — verify before relying on it.

If that holds, the only backstop is `mergeVotes`' argmax, which already collapses
a multi-value answer on a single-value facet to one value. Which means the
compliance risk **is covered on voting boards and uncovered on single-pass
ones** — so a failed probe would not necessarily kill Stage 2, but it would
restrict it to `ai_votes > 1`. Record that as the fallback rather than a
straight no.

### 2.8 Step zero — the probe — RUN 2026-08-06, PASSED

```
gpt-5.4-mini, 40 items, text stand-ins, votes=1

single-value compliance ("shape", 40 raw runs per arm)
  scoped   100.0%  (40/40)
  full     100.0%  (40/40)

agreement, scoped vs full          72.5%  (29/40)
agreement, full vs full (CONTROL)  85.0%  (34/40)

tokens per call     input    output
  scoped             1097        76
  full               3615       345
```

**The gate passed decisively.** The 97.5% → 68.8% collapse did not reproduce at
all. The hypothesis in the hazard note above holds: that collapse belonged to a
variant that declared all nine facets in a cached prefix and asked for one, and
a clean single-facet prompt is simply not that prompt.

**The control was necessary and is worth keeping.** 72.5% scoped-vs-full is
unreadable alone, because the model disagrees with ITSELF on a rerun. Asking the
same full prompt twice agrees 85% of the time — which independently reproduces
the ~82% per-facet stability measured over 2,240 calls in
`tagging-accuracy-plan.md`, from a different harness.

**Residual finding, recorded rather than chased:** scoping moves the answer
~12.5 points beyond that noise floor. Two limits on it — at n=40 the gap is
roughly 1.5 standard errors, so it is suggestive and not established; and the
direction is unscoreable (no ground truth), with the earlier per-facet
measurement scoring +3.2 points, i.e. slightly better. Stage 2 ships on that
basis. What must NOT be claimed is that scoped and unscoped answers are the
same — the data does not support it. Settle it with n≈120 if it ever matters.

**On the token figures:** this probe uses text stand-ins, so the 70% input
saving is not a refutation of §2.6's ~21%. That estimate is for the image board,
where the image dominates input and never caches. The output saving (~78%) is
the part that carries over, exactly as §2.6 predicted.

### 2.8.1 Re-running it

`scripts/probe-openai-flag.mjs` is the precedent and already imports
`buildPrompt` and `scripts/logos-board.json`, so this is a short script, not a
feature branch.

- ask `shape` (single-value) and `construction` (multi-value) **alone**, and the
  same two **inside the full nine**, over ~80 logos-board items
- measure: (a) share of `shape` answers carrying exactly one value, (b)
  scoped-vs-full answer agreement, (c) fresh input / output tokens per call
- **pass** if single-value compliance stays near the measured 97.5%; **fail**
  near 68.8%. On a fail, re-run with `ai_votes: 3` merging to test the argmax
  backstop in §2.7 before abandoning the stage.

---

## Blast radius

### A stale scope narrows a full retag — seven sites, and only seven

A scoped row exists only while `status` is `pending` or `processing`, so the
sites that matter are the ones whose WHERE clause can *see* such a row. Every
`UPDATE items` in `db.js` was enumerated and classified:

| must clear `tag_facets` | why it can see a scoped row |
| --- | --- |
| `markTagged` (`db.js:2030`) | fenced on `status='processing'` |
| `setItemTags` (`db.js:370`) | `WHERE id=$` — **no status filter** |
| `retagItem` (`db.js:453`) | `WHERE id=$` — **no status filter** |
| `reprocessEntity` (`db.js:1998`) | `WHERE entity_ids @>` — **no status filter** |
| `reExtract` (`db.js:437`) | `WHERE id=$ AND (mapping…)` — **no status filter** |
| `cancelBoardQueue` ×2 (`db.js:2301`, `:2308`) | filter `status='pending'` — the window itself |

| must NOT clear | why |
| --- | --- |
| `claimFairBatch` (`db.js:1452`) | the claim must hand the scope to the worker |
| `failOrRequeue` (`db.js:2159`) | a retry of a scoped pass stays scoped |
| `recoverStuck` (`db.js:2193`) | ditto after a crash |

Unreachable by their own status filters, and therefore **not** on the list:
`retagBoard` (`tagged/failed/held`), `releaseHeld` (`held`), `queueUntagged`
(`held/tagged/failed`), `requeueItemForTag` (`tagged/failed`), `markExtracted`
(`extracting`), `advanceFaced` (`facing`). Their exemption is an accident of
their WHERE clauses rather than a design guarantee, so a test per site is what
holds the whole set in place.

**Severity, stated accurately:** a missed site narrows exactly **one** pass.
`markTagged` nulls the scope on landing, so the item self-heals on the next
retag. It is a real bug and it is silent, but it is not the permanent
eight-facet blackout it first looks like.

### Why not make it structural

Two stronger designs were costed and rejected:

- **A `pending_retag_facet` / `retagging_facet` status pair**, following the
  existing `pending_extract`/`extracting` pattern, would make a stale scope
  inert by construction — the status becomes the authority and an orphaned
  column cannot narrow anything. But the status vocabulary is threaded through
  **47 sites in `db.js` alone**, plus `grid.js`, `data.js`, `rows.js`,
  `lightbox.js` and `upload.js`, which would render an unknown status as a
  broken state. Too much surface for the size of the bug.
- **A self-invalidating scope** (`tag_facets_at = updated_at`, so any requeue
  makes it inert) does not work: `claimFairBatch` bumps `updated_at` itself, so
  the marker breaks before `tagOne` ever reads it.
- **Consuming the scope in the claim** removes all seven sites, but
  `recoverStuck` then has nothing to restore after a crash and the recovered
  item silently full-writes. Both failure modes are one-pass and self-healing,
  so this trades an equal bug for more moving parts.

### The value fence already makes a claim-time merge safe — do not re-read

The obvious implementation reads the item's current tags immediately before
writing. That is both unnecessary and worse.

`claimFairBatch` returns `RETURNING *`, so `row` carries `tags`,
`tag_reasoning` and `tag_confidence` as of the claim. `markTagged` is fenced on
`AND status='processing'`, and **every** competing writer moves the row out of
that status — `setItemTags` sets `'tagged'` (`db.js:369`), `retagItem` sets
`'pending'`, `reprocessEntity` sets its own leg. So either nobody wrote and the
claim-time state is still current, or somebody did and the fence discards the
whole result exactly as it does today.

A re-read would *weaken* this: it would widen the window between reading `prev`
and writing the merge, and it would happily merge onto a user's hand edit that
the fence is supposed to protect.

### The facet editor is an unsaved modal

`buildFacetEditor` mutates a local `facets` array and `sync()`s it into a hidden
textarea; nothing reaches the server until Save. A "retag this facet" button
sitting under a description the user just rewrote would retag with the **old**
gloss — the exact inverse of the feature's purpose, and invisible until the
results come back wrong.

The button must save first, or be disabled while the modal is dirty. Related:
`f.key` is derived live from the label while `f._new` is set, and renaming a
facet's key orphans its existing tags — so no retag control on a new or renamed
facet either.

### Two scoped retags racing

One status column and one scope column per item, so a second scoped retag
queued while the first is pending overwrites its scope and the first facet is
never written. Either union the scopes on queueing (`tag_facets = COALESCE(tag_facets,'{}') || $new`)
or refuse while `status='pending' AND tag_facets IS NOT NULL`. Union is
friendlier and costs one call either way.

### It is not free — embeddings ride along, and most of them are wasted

`markTagged` clears the vector unconditionally, so a scoped retag over 4,512
items buys 4,512 re-embeddings. But `construction` measured 60% unanimous, so
~2,700 of those items land byte-identical tags and re-embed for nothing.

`addTagSnapshot` computes exactly the "did anything actually change" test one
line later (`sameTagSet`, `db.js:395`), and already declines to write when the
answer is no. The same comparison could gate `embedding=NULL`. This is a
general win — every full retag pays the same waste today — so it is worth
splitting out rather than smuggling in under this plan.

### Composes with vote mode unchanged

Voting happens inside `tagOne`; scoping happens at the landing. A scoped pass at
3 votes is 3 calls for the same item, exactly as an unscoped one. This is also
the machinery `tagging-accuracy-plan.md`'s open question wanted for per-facet
vote counts — vote 5 on `construction`, 1 on `presentation` — which becomes
reachable once Stage 2 exists.

### Not affected (checked)

- `addTagSnapshot` compares whole tag sets via `sameTagSet` (order-insensitive),
  so a scoped change appends exactly when it changed something.
- `recoverStuck` (`db.js:2189`) rewrites only status/attempts/error/retry_at — a
  scope survives a crash-recovery requeue.
- `failOrRequeue` (`db.js:2140`) likewise; a scoped pass keeps its scope across
  retries.
- `evaluateItemAlerts` reads the merged tag set, which is the item's real state.
- `setItemTags` needs no change — a human edit already drops reasoning and
  confidence per changed facet, and has no notion of scope.

---

## Order

0. **Probe** — one facet asked alone on the logos board vs the same facet inside
   the full nine, ~80 items. Compare single-value compliance and answer
   agreement. This gates Stage 2 only; Stage 1 does not wait for it.
1. **Stage 1** — migration, `scopeResult`, the seven `tag_facets=NULL` sites,
   `markTagged` (+ the snapshot's `undecided`), the facet-less guard,
   `retagBoardFacets`, routes. Shippable and testable with no UI.
2. **Stage 1 UI** — the facet-editor control, with the save-first rule.
3. **Stage 2** — if the probe clears, and if the saving is wanted. If it fails,
   the fallback is Stage 2 gated on `ai_votes > 1` (§2.7), not no Stage 2.
   Order within the stage matters: §2.1's two facet lists before anything else,
   since getting it wrong deletes tags rather than mis-tagging them.

## Open questions

- **Should a scoped retag be offered on `undecided` items?** They have no tags
  to preserve, and writing one facet's answers to an item still flagged
  undecided is incoherent. Simplest rule: `retagBoardFacets` targets
  `status='tagged'` and leaves undecided items to a full pass. Revisit if
  someone wants it.
- **Per-facet vote counts** (from `tagging-accuracy-plan.md`) become buildable
  once Stage 2 lands. Worth deciding whether the vote count belongs on the facet
  or stays on the board.
- **Should Stage 1 honour the fit verdict it paid for?** A write-scoped pass has
  all nine answers in hand, so `filledFacets` is exactly computable — unlike a
  prompt-scoped one. Recorded as "leave `undecided` alone" for coherence across
  both stages, but Stage 1 alone could justify honouring it.
- **Skip the embedding clear when nothing changed** — deliberately NOT folded in
  here. It is a general saving (every full retag pays it too), it touches the
  embedding sweep rather than tagging, and bundling it would make a scoped-retag
  regression and an embedding regression share one commit. Its own small change,
  reusing `sameTagSet`.
