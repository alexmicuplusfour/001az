# Reprocess formalized — derived artifacts + the split button (2026-09-04)

Self-contained for a fresh session. Written after a deep dive spanning the
reprocess/retag/re-extract routes, all four queue routers in db.js, every
worker leg (fetch, face, extract+detect, tag), the out-of-band lanes
(transcription, embedding), and every UI surface that queues AI work.

## The complaint

One button ("Reprocess") whose meaning nobody can state. The grid tooltip
says "re-identify + re-tag" ([grid.js:160](../public/grid.js#L160)), the bulk
bar says "re-tag with AI" ([bulk.js:38](../public/bulk.js#L38)) — same
endpoint, both wrong and each wrong differently. What it actually does
depends on the item's type in ways only the router's SQL knows, and every new
capability (detection was the latest) gets hand-wired into that SQL — or
forgotten. The ask: a concept that makes "what gets redone when" a table you
read, not a diff you archaeology; a main action that genuinely redoes
everything worth redoing; a caret with granular control.

## What reprocess does today (the deep-dive findings)

`POST /api/items/:id/reprocess` ([server.js:2895](../server/server.js#L2895))
→ `reprocessEntity` ([db.js:2843](../server/db.js#L2843)). Every instance of
the entity is cleared (tags, reasoning, confidence, undecided, park,
attempts, `transcript_error`) and re-stamped with the CURRENT board mapping,
then routed by a status CASE:

| instance looks like | routed to | which means |
| --- | --- | --- |
| `payload ? 'unfetched'` (queued connector add that never landed) | `pending_fetch` | buy provider data, then continue |
| connector face in the applying mapping, no files or a generated file | `pending_face` | re-render the chart (live `history()` call), then tag |
| AI work in the applying mapping (derived identity / extract / detect fields) | `pending_extract` | LLM fields + identity + detector pass, then tag |
| anything else | `pending` | tag leg only |

Per content type, that works out to:

- **Images**: re-extract (if mapped), detector pass re-runs, re-tag from the
  AI rendition.
- **Documents**: sidecar text extraction re-runs every pass (OCR included),
  fields re-extracted, re-tagged.
- **Audio**: re-tags from the EXISTING transcript. Only a FAILED
  transcription is retried (`- 'transcript_error'`); a successful transcript
  is never redone — and no path in the app can force it.
- **Connector entities (stocks/crypto)**: chart face re-renders with fresh
  provider history ([runtime.js:476](../server/connectors/runtime.js#L476) —
  the only manual re-render path, e.g. after a period change), but the FIELD
  VALUES are NOT re-fetched — those move only on the liveness cadence
  ([worker.js:803](../server/worker.js#L803)). Fresh chart, stale price,
  re-tagged from the mix.
- **Derived identity**: extraction re-derives, which can re-parent — merge
  into another card or split off a new one.
- **Embedding**: not touched directly; `markTagged` clears it on landing and
  the sweep re-embeds. Self-healing, correct, nothing to do.

The routing CASE exists in FOUR near-copies — `reprocessEntity`,
`retagBoard` ([db.js:1587](../server/db.js#L1587)), `releaseHeld`,
`queueUntagged` ([db.js:1680](../server/db.js#L1680)) — already sharing SQL
fragments (`UNFETCHED`, `STAMPED_CONNECTOR_FACE`,
[db.js:854](../server/db.js#L854)) precisely because they kept threatening to
drift. The code is asking for one declaration.

Surface inconsistencies, beyond the tooltips: after clicking, the client
stamps every instance `"pending"` ([grid.js:143](../public/grid.js#L143))
regardless of the leg the server actually routed to; facet-scoped retag
exists as a route for single instances (`retagItemFacets`,
[db.js:1634](../server/db.js#L1634)) but only the admin board view has a
picker — the lightbox Retag is always all-facets.

## The concept: derived artifacts

Everything the app computes about an item is an **artifact** with three
declared properties: what it is **built from**, what it **costs**, and what
makes it **stale**. One rule replaces all the routing lore:

> **Redo an artifact and everything downstream of it re-derives; "redo
> everything" means "redo everything that could come out different."**

The registry (this table is the deliverable of the plan — code and UI derive
from it):

| artifact | stored | built from | cost | stale when | today | after |
| --- | --- | --- | --- | --- | --- | --- |
| provider fields | `entities.fields` | provider + symbol | provider call | cadence due; **user demand** | cadence only | + reprocess & caret |
| chart face | generated file + `face_at` | provider `history()` + face config | provider call | cadence; face config change; user demand | reprocess re-renders | unchanged |
| transcript | `payload.transcript` | audio bytes + transcriber engine | engine (metered seconds) | **engine changed**; user demand | only failures retried | + engine-change redo & caret |
| extracted fields | `payload.fields` | text/transcript/image + mapping + extract model | LLM call | mapping/model change → user redoes | reprocess/re-extract | unchanged |
| derived identity | entity parentage | same extraction call | (same call) | with extraction | with extraction | unchanged |
| detect boxes | `payload.fields` (detect keys) | image + queries + detector | sidecar | with extraction | with extraction | unchanged |
| file fields | `payload.fields` (file keys) | file metadata + mapping | free | recomputed every extraction | fine | unchanged |
| tags | `items.tags` + reasoning/confidence | material + fields dossier + facets/prompt + tag model | LLM call | any input moved → user redoes | all redo paths | unchanged |
| embedding | `items.embedding` + model stamp | tags+reasoning / transcript + embed model | embed call | text changed; model changed (stamped) | **self-healing — the model citizen** | unchanged |

Deliberately NOT artifacts: document text and AI renditions (recomputed per
pass, never stored — nothing to invalidate), thumbnails (ingest-time,
input never changes).

Two boxes already live by the rule — embedding (model-stamped, sweep
converges) and transcription (absence-keyed lane). The plan moves the rest
toward that shape and fixes the two real gaps the table exposes: provider
fields have no user-demand path, and the transcript has no engine stamp and
no user-demand path.

Cost note: the transcript rule is NOT "expensive things are protected." Its
input (the bytes) never changes, so redoing it buys the same answer twice —
UNLESS the engine changed, which is exactly what the stamp detects. Same
logic embeddings use today.

## Stage 1 — honesty pass (no behavior change) — SHIPPED 2026-09-04

Deep-dived 2026-09-04; the details below are findings, not guesses.
Shipped same day, suite 1365 green (route response pinned in
extraction/faces tests). Implementation notes: `reprocessEntity` returns the
`RETURNING id, status` rows (null when the entity is gone); the client
mirror is one shared `applyRoutedStatuses` in data.js used by grid + bulk;
`queueLegBtn` split into `queueLeg` (the POST, facet-aware) + a button
wrapper that grows the scope picker when handed facets; `.lbp-reextract`
grew inline-flex+gap for the caret.

Cleanup pass (same day): the scope pop was promoted OUT of admin-boards.js
into `dropdown.js` as `openFacetScopePop(anchor, facets, run)` — Stage 1
had copied it, which is exactly what Stage 4 says not to do; both surfaces
now call the one component (admin-boards −38 lines). The caret wears the
shared `.dd-caret` class (12px, dimmed, auto-flips on open via `.dd-open`)
instead of a raw `ICONS.chevron`; the scoped and unscoped Retag collapsed
into ONE button construction, which also restored the `busy()` latch the
scoped arm had dropped; the per-facet message override folded into
`queueLeg` (one `msgs`, the facet suffixes the toast); the carried-over
`if (!img.tags.length) img.tagSet = new Set()` was deleted from
`applyRoutedStatuses` (inert — every site that writes `tags` writes
`tagSet`).

### Deferred out of Stage 1 (raised by the cleanup review, deliberately not done)

1. **The sibling re-queue routes still guess the ENTITY status.**
   `/instances/:id/retag` and `/reextract` answer a hardcoded
   `status: "pending"` / `"pending_extract"` with no `instances`, so
   [rows.js:81](../public/rows.js#L81) and the lightbox stamp the whole card
   with one instance's leg — on a multi-instance entity whose sibling is
   `fetching`, that is the same wrong-pill/wrong-poll-tier harm 1b exists to
   kill. The instance status there IS constant (those UPDATEs write a
   literal), so only the aggregate is a guess. Fix is NOT free the way 1b's
   was: `reprocessEntity` updates every instance so `RETURNING` yields the
   whole set, whereas a per-instance route would need a second query for the
   entity's other instances. **Take it in Stage 2**, where the routers are
   being reworked anyway and `retagBoard`/`releaseHeld`/`queueUntagged` want
   the same `RETURNING` treatment — one response shape everywhere, and
   `status` disappears as a parameter from `queueLeg`/`doRetag`/`doReextract`.
2. **The scope gate re-derives a server rule client-side.**
   `inst.status === "tagged" && !inst.undecided` restates `retagItemFacets`'s
   admission rule, against the house precedent (`domainState`, server.js —
   "the client is written to the absence, not to a role flag, so the two
   can't drift"). It rides two fields already in the payload, so it is
   defensible alone — but Stage 4's caret needs "does this instance have AI
   work / is it audio", and `instanceEntry` ships no mapping and no payload,
   so **Stage 4 must ship per-instance applicability from the server anyway**
   (e.g. a `can: [...]` array computed beside the routes that enforce it).
   When it does, this gate folds into it rather than becoming a second
   opinion.

**1a — one tooltip vocabulary.** Card
([grid.js:160](../public/grid.js#L160)): "Reprocess — redo everything for
this item". Bulk ([bulk.js:38](../public/bulk.js#L38)): "Reprocess selected —
redo everything". Kill "re-identify + re-tag" and "re-tag with AI". (The
admin board confirm's "cleared and reprocessed" wording is board-retag,
a different action — leave it.)

**1b — the route tells the truth about routing.** The client already speaks
the full status vocabulary — `ACTIVE`/`QUEUED` sets
([data.js:40](../public/data.js#L40)) drive the poll tiers
(`needsPoll`/`moving`), the status pills, and `inProgress` ordering, and
jobs-modal has labels for every leg — so a wrong `"pending"` stamp isn't
cosmetic: it puts a fetching stock in the wrong pill bucket and the wrong
poll tier until the first reconcile. The card face itself only shows a
generic spinner for any in-flight status ([grid.js:395](../public/grid.js#L395)),
so nothing else needs to change visually.

- `reprocessEntity` gains `RETURNING id, status` (single UPDATE — free).
  Its return value changes from boolean to rows; the route 404s on empty and
  answers `{ok, status, instances: [{id, status}]}` with the entity-level
  `status` computed by the existing server-side `aggregateStatus`
  ([db.js:162](../server/db.js#L162)) — deliberately NOT duplicating
  `STATUS_PRIORITY` client-side. Tests asserting the boolean return adapt.
- `doReprocess` ([grid.js:137](../public/grid.js#L137)) and
  `doBulkReprocess` ([bulk.js:91](../public/bulk.js#L91)) set `img.status`
  and instance statuses from the response instead of stamping `"pending"`.
  Rows-mode's own retag/reextract handlers
  ([rows.js:80](../public/rows.js#L80)) already stamp the correct single-leg
  status ("aggregate approximation; the poll corrects it") — no change.

**1c — lightbox facet-scoped retag.** The admin pop is already built on the
shared dropdown component (`openDropdown`/`ddRow`/`ddSep`,
[dropdown.js](../public/dropdown.js)) — nothing to promote; the lightbox
imports the same pieces. Follow the admin pattern exactly
([admin-boards.js:206](../public/admin-boards.js#L206)): when facet rows are
on offer the Retag button opens the pop ("Everything" first, then
label+key rows); otherwise it stays a plain full-retag click. Facet rows are
offered only when the instance is eligible for the scoped route —
`status === 'tagged' && !undecided` (the route 409s otherwise;
honest absence beats a 409 toast). Scoped click POSTs the existing route
with `{facets: [key]}`; on success set `inst.status = 'pending'` but do NOT
clear the displayed tags — a scoped pass preserves the other facets, and the
UI should mirror that.

## Stage 2 — one routing declaration + routed statuses everywhere — SHIPPED 2026-09-04

Close-looked 2026-09-04, cell-by-cell across the four routers. Two findings
revise the original sketch; the concrete spec follows. Shipped same day in
the two planned chunks, suite 1366 green: (a) `requeueSettledSql(where)`
template landed with the trio as thin wrappers, suite untouched; (b)
`routedEntities`/`routedEntitiesForItem` in db.js, the three routes answer
`{ok, entities}`, `applyRoutedEntities` in data.js adopted by grid, bulk,
rows-mode and the lightbox (whose `queueLeg`/`queueLegBtn` lost their
`status` parameter; `reprocessEntity` reverted to boolean — the sibling read
supersedes its Stage-1 `RETURNING`). rows.js's "aggregate approximation" is
gone. New classify-mode pin in derived-identity.test.js: one instance in two
entities → both cards' aggregates in the report, settled sibling included;
the classify pin uses `setItemEntities` (the write classify mode itself uses).

Cleanup pass (same day, suite 1366): the review overturned Stage 2's own
"the sibling read supersedes RETURNING" note. It doesn't — the UPDATE's
RETURNed `entity_ids` ARE the complete affected set (an entity's aggregate
moves only if one of ITS instances moved), so every re-queue statement now
RETURNs them and `routedEntities` is ONE query instead of two, with
`affectedEntityIds` folding the union. That also killed `routedEntitiesForItem`
(a third read) and its over-reporting: the per-item routes were expanding one
hop past the changed instance, shipping cards whose aggregate had not moved.
Per click: reprocess −1 query, retag/re-extract −2. Also: the second-degree
exclusion is now spelled `byEntity.has(eid)` with the rule stated (it read as
an optional-chaining shrug); `applyRoutedStatuses` folded into
`applyRoutedEntities` (one export, one contract); a new `requeue(url, body)`
in data.js — built on `api()` — owns the POST→mirror→repaint→poll ritual that
Stage 2 had made identical in four places (Stage 4's caret entries inherit it,
and rows-mode's re-extract now surfaces the server's own 409 sentence);
lightbox `queueLeg` became a closure inside `queueLegBtn` and BOTH arms wear
`busy()` (the faceted one had no latch); `insertItem`'s signature reverted;
retagBoard's stale routing recap removed (the template owns it now).

### Deferred out of Stage 2 (raised by the cleanup review, deliberately not done)

3. **The routing CASE is still two hand-written copies** — `requeueSettledSql`
   and `reprocessEntity` emit the same four arms in the same mandatory order
   (fetch → face → extract → tag) and differ only in per-arm predicates. A 5th
   leg must be added in both, and the "UNFETCHED must come FIRST" invariant is
   enforced by prose in two places rather than by a builder — the inverse of
   this file's own `IN_FLIGHT_FOR` → `CLAIM_CASE`/`REQUEUE_ARMS` precedent,
   whose comment exists because hand-written lists already survived a leg
   addition only by audit. The deeper form is
   `routingCase({ fetch, face, shortCircuit, extract })` emitting the canonical
   order from per-intent predicates. **Do it in Stage 3a**, not now: 3a is the
   change that makes reprocess's fetch predicate diverge (fetched vehicles
   re-enter `pending_fetch`), so the second variation — and therefore the
   evidence for the abstraction's shape — arrives with it. Building it now
   would be guessing at the seam one commit early.
4. **The tag-edit route is the one per-instance status mutation outside the
   contract.** `PATCH /api/instances/:id/tags` returns no `entities`, and
   [tag-editor.js:114](../public/tag-editor.js#L114) hand-stamps a client-side
   aggregate that DISAGREES with the server's `STATUS_PRIORITY` (it calls
   all-tagged-plus-one-failed "tagged"; the server says "failed"). One line on
   the route plus the existing `applyRoutedEntities` closes it. Left out
   because it changes a route this arc never touched — take it as a Stage 4
   ride-along, where the caret makes "what did this do to my tags" a
   user-visible question anyway.

**Finding 1: it's not four routers — it's a trio plus one deliberate
outlier.** `retagBoard` and `queueUntagged` have byte-identical SET clauses
already; `releaseHeld` differs only by omitting the `status='held'` guards
that its own `WHERE status='held'` makes redundant — adopting the guarded
form is semantically identical. So the trio collapses into ONE template:

    const requeueSettledSql = (where) => `UPDATE items SET <payload CASE>,
      <status CASE>, mid_pass=NULL, attempts=0, error=NULL, retry_at=NULL,
      updated_at=$1 WHERE board_id=$2 AND ${where}`

with the three exported functions (and their distinct comments) surviving as
thin wrappers passing their WHERE — same $1/$2/$3 in all three, so nothing
else moves. `reprocessEntity` stays OUT, and its own comment already says
why: its variant "differs ON PURPOSE" on three axes (re-stamps the current
mapping unconditionally + strips park/transcript_error; no
`extracted_at → pending` short-circuit — a full redo re-extracts; a wider
face arm that re-faces rendered generated charts via the COALESCE'd
mapping). Folding one consumer behind four option flags obscures exactly the
distinctions those comments exist to defend. It keeps sharing the
`UNFETCHED` fragment; the intent split IS the artifact-registry distinction
("requeue settled work under the current definition" vs "redo everything").
`requeueItemForTag` (the refresh cascade's narrow settled-only requeue) also
stays out — no definition legs, no client.

**Finding 2 (corrects the Stage-1 deferral note): board-level routers should
NOT get `RETURNING`.** Their consumers are the admin "queued N" buttons and
the auto-tag sweep ([worker.js:1797](../server/worker.js#L1797)) — counts,
with no card UI attached; shipping thousands of rows to answer "how many"
is waste, and the gallery poll already covers open tabs. Counts stay.

**The routed-statuses half** (the Stage-1 deferral, done properly):

- One response contract for every per-card/per-instance re-queue action:
  `{ ok, entities: [{ id, status, instances: [{id, status}] }] }` — reprocess,
  retag (scoped keeps its `facets` field), re-extract. The reprocess route's
  Stage-1 shape is revised to this while the arc is still uncommitted; the
  pinned tests move with it.
- Why a LIST of entities: classify mode. An instance can belong to several
  entities, and re-queuing it moves every one of those cards' aggregates —
  answering for just one card would rebuild the guessing problem one level
  up. New db helper (`routedEntities(db, entityIds)`): read-after-write,
  `entity_ids && $1::bigint[]` (the listItems idiom, [db.js:253](../server/db.js#L253))
  expanded to the affected entities, grouped per entity with the existing
  `aggregateStatus`. Two cheap queries on a user-click route.
- The read-after-write can see a worker claim land first (`pending` →
  `processing`). That's fine — MORE truthful, and every status it can
  observe is already in the client's vocabulary.
- `retagItem` / `reextractItem` / `retagItemFacets` keep their boolean
  returns — the sibling read supersedes `RETURNING` (it must run anyway to
  cover classify-mode overlap, and it sees the same rows).
- Client: `applyRoutedEntities(entities)` beside `applyRoutedStatuses` in
  data.js — walk `state.items`, apply per match. Adopted by grid
  `doReprocess`, bulk, rows-mode `doRetag`/`doReextract`, and the lightbox's
  `queueLeg` — whose `status` parameter dies, along with rows.js's
  "aggregate approximation; the poll corrects it" comment, which is the
  epitaph this stage exists to write.

**Order & risk.** Two independent commits' worth: (a) the trio template —
pure refactor, suite must pass untouched; (b) the response contract — touches
the Stage-1 route tests and four client call sites. Riskiest spot in (b) is
the entity-overlap expansion; pin it with a classify-shaped test (one
instance, two entities, retag → both entities' aggregates in the response).

## Stage 3 — the two missing boxes get their paths — SHIPPED 2026-09-04

Close-looked 2026-09-04 against the actual legs. The original sketch survives
but was missing two traps (the landing rule and the cancel interaction) and
the builder deferral from Stage 2 lands here. The three pieces stay
independent.

Shipped same day exactly per the spec below, suite 1372 green (6 new tests,
first run). Notes: the `routingCase` builder landed with 3a as planned
(`requeueSettledSql` + `reprocessEntity` both consume it; `UNFETCHED` is now
the trio's predicate, `CONNECTOR_VEHICLE` reprocess's); the verb SQL grew
`ITEM_SCOPE`/`ENTITY_SCOPE` templates so item and entity forms share one SET
clause (`retagSql`/`retagFacetsSql`/`reextractSql`); the reprocess route
resolves the transcriber engine conservatively (`id:model` only when both
known) and `reprocessEntity` takes it as `$4`; the faces.test "restarts at
the face leg" pin inverted to the fetch leg; the cancel matrix gained the
fetched-vehicle-survives row (parked, entity kept).

Cleanup pass (same day, suite 1372): the biggest catch was **retranscribe
breaking the verb convention its own stage established** — it was raw
SELECT + `dropTranscript` + `retagItem` composed in the route; now it is one
`retranscribeSql(scope)` verb (audio-only via WHERE, null = the 409,
`dropTranscript` deleted with its only caller) so the Stage-4 entity sibling
is a one-liner like every other. The engine-stamp string — the staleness
comparator itself — was spelled differently in worker and route; one exported
`engineStamp(t)` now feeds both, and the audio test builds its stamps through
it so drift breaks red. Both entity routes (and the reprocess engine block)
read `req.entityBoardId` from the middleware instead of re-running its query;
the instance retag route adopted `req.itemBoardId` the same way. New shared
fragments: `CLEAR_EMBEDDING` (landTranscript + setItemTags + markTagged —
three spellings of "the vector is stale" became one), `APPLYING_MAPPING`
(carries the $3-contract warning `CONNECTOR_VEHICLE` silently relied on),
`restamped(expr)` (the mapping re-stamp CASE, spelled once instead of twice —
`STRIPPED` interpolates once now). `routingCase` re-spelled as a lines array
(the arm order reads as a list). Stale comments fixed: cancel's header rule
table (fetch lane splits per-row on `UNFETCHED` — `cancelDeletes` renamed
`cancelFetchLane` since only its unfetched subset deletes), the abort
"partition" claim, `retagSql`'s per-instance header. `connectorLanding` names
`parked` once instead of spelling the predicate twice. Retranscribe race
answers 409 (was `ok:true` with an empty report). Skipped, noted: an
audio-test clip-seeding helper (5 hand-rolled spellings — test-only churn), a
`{statuses, guard}` cancel declaration (one flagged leg is not enough
instances), the 7×-repeated reset tail (carries no drift risk).

### 3a — provider fields on demand (+ the routingCase builder)

Reprocess routes FETCHED connector vehicles through `pending_fetch` too
(today only `unfetched` ones). The fetch leg is already the right worker —
it lands fields + identity + schedules liveness, `landEntityFetch` is
idempotent on a live entity (re-landing its own identity is a self-update;
23505 stays the true-duplicate arm), and `advanceFetched` stripping
`unfetched` / re-stamping `source` is exactly right for a re-fetch. After
this, reprocess on a stock = fresh fields → fresh chart → fresh tags.

What the sketch missed:

- **The landing rule must read the `unfetched` flag, not the board flags.**
  `processFetchOne` advances to `connectorLanding(board).status`
  ([add.js:15](../server/connectors/add.js#L15)) — the ADD path's rule, which
  lands a face-less auto-tag-off board's vehicle in `held`. A reprocessed
  vehicle is an EXPLICIT run whose park was already stripped; landing it by
  board flags would park it and break the explicit-run promise the other legs
  keep. Rule: first fetch (`payload ? 'unfetched'`) keeps today's landing;
  a re-fetch lands `wantsFace ? pending_face : pending`. Encode both in
  `connectorLanding` (it is the ONE landing rule — that's its charter).
  Deliberately NOT solved by widening `park` to face-less vehicles: park
  interacts with releaseHeld/the extract leg's parking, and repurposing it
  ripples where the flag is "spent".
- **Soft cancel would DELETE re-fetching vehicles.** `cancelBoardQueue`'s
  delete arm takes the whole fetch lane ([db.js:3568](../server/db.js#L3568))
  on the "a vehicle whose data never landed is a name-only shell" rationale,
  and `deleteEmptyEntities` eats the entity — hearts, snapshots, everything.
  After 3a the lane holds REAL vehicles (reprocess sets `mid_pass=NULL`, so
  the soft-cancel gate does not save them). Fix: the delete arm gains
  `AND payload ? 'unfetched'`; fetched vehicles join the pull statement
  (tags were cleared by reprocess → they land `held`, like every other
  pulled bare row). The `cancelDeletes`/`cancelPulls` derivations grow the
  predicate; abort's exact partition survives.
- **The routing predicate**: vehicles are the only items carrying
  `payload.source` (verified: `admitFile` builds none), so reprocess's fetch
  arm becomes `payload->'source'->>'id' IS NOT NULL AND
  COALESCE($3, payload->'mapping')->'input'->>'connector' IS NOT NULL` —
  first arm, subsuming today's `UNFETCHED` for this intent. The face arm
  then never sees vehicles on reprocess; the chart still re-renders because
  the fetch LANDING routes face-boards to `pending_face`.
- **The `routingCase` builder (Stage 2's deferral) lands here**, because this
  is the change that makes the two CASEs' fetch predicates diverge:
  `routingCase({ fetch, face, shortCircuit, extract })` emits the canonical
  arm order (fetch → face → extract-shortcut → extract → tag) once;
  `requeueSettledSql` and `reprocessEntity` both consume it, and a 5th leg
  has one home.
- **Accepted behavior changes, named**: (1) reprocess on a domain with no
  live provider now FAILS the vehicle (visible in the jobs drill) instead of
  silently re-tagging stale data — honest, but a change from today's
  face→tag path; (2) every connector-card reprocess now buys a provider call
  (metered + board-attributed via the existing `tracked()` path — that's the
  feature). The prewarm (`queuedFetchSourceIds`) covers re-fetches with no
  change — it selects by status.
- **Test consequence**: faces.test.js's "a connector vehicle restarts at the
  face leg" pin INVERTS — vehicles now restart at the fetch leg; the face
  assertion moves to the landing. Plus: landing-rule matrix (unfetched × face
  × auto_tag), the cancel-delete guard, and a reprocess-refetches-fresh-fields
  end-to-end.

### 3b — transcript engine stamp + re-transcribe

- **The landing becomes `landTranscript(db, id, {text, turns, engine})`** —
  one UPDATE replacing the raw `updateItemPayload` at
  [worker.js:1199](../server/worker.js#L1199): merge
  `transcript`/`transcript_turns`/`transcript_engine` AND clear
  `embedding`/`embedding_model`/`embed_error`. The embedding clear is the
  transcript→embedding artifact edge: today a transcript lands once, when
  the embedding is already NULL — the moment a SECOND landing exists, an
  audio item on a no-tag board would otherwise keep its stale vector forever
  (the sweep skips non-NULL same-model rows, and untagged audio never passes
  through `markTagged`'s clear).
- **Engine string**: the job log's spelling, `[id, model].join(":")`, stamped
  post-call (whisper self-reports its model in the done payload, so the stamp
  names what actually produced the text). Comparison at reprocess is
  CONSERVATIVE: clear only when the route-time resolution yields a complete
  engine string that differs; unstamped legacy transcripts and a null-model
  resolution never clear — no surprise re-billing, ever. Route resolves via
  `getEntityBoard` + `resolveTranscriber` and passes the string as a new
  nullable param; non-audio payloads carry no stamp, so the arm no-ops.
- **`reextractItem` does NOT get the engine rule** — re-extract is about
  fields; it keeps its existing "retry a FAILED transcription" semantics only.
- **`POST /api/instances/:id/retranscribe`**: audio-only (409 otherwise);
  drops `transcript`/`transcript_turns`/`transcript_engine`/`transcript_error`
  (needs a dedicated `dropTranscript` — `updateItemPayload` is merge-only and
  cannot delete keys) then `retagItem`: the absence-keyed lane refills the
  transcript on its own, and the tag leg's awaiting-transcription wait does
  the sequencing. Response rides the `routedEntities` contract.

### 3c — entity-level verbs

Not just retag: the Stage-4 caret needs the entity-level verb FAMILY, and
each is the same 6-line `reprocessEntity`-pattern sibling (`entity_ids @>`,
`RETURNING entity_ids` → `affectedEntityIds`):

- `retagEntity` + route `POST /api/items/:id/retag` (accepts the `facets`
  body like the instance route; the scoped variant filters per instance on
  `status='tagged' AND NOT undecided`, 409 when nothing qualifies — the
  per-instance semantics, widened).
- `reextractEntity` + `POST /api/items/:id/reextract` (409 when no instance
  has a stamped mapping).
- Entity-level re-transcribe is DEFERRED to Stage 4: audio entities are
  single-instance in practice, and the caret can address the sole instance;
  add the sibling only if a real multi-clip case shows up.

All three respond on the `routedEntities` contract, so `requeue()`
client-side needs nothing new.

## Stage 4 — the split button — SHIPPED 2026-09-05

Shipped per the close-look spec below, suite 1374 green. Implementation
notes: `refreshEntityData` + `retranscribeEntity` verbs and their card
routes landed exactly as specced; `setItemTags` RETURNs entity_ids and the
PATCH answers `{ok, tags, entities}` (tag-editor keeps its tags/undecided
writes, statuses now come from `applyRoutedEntities` — the failed-sibling
pin is in derived-identity.test.js); `.split-btn` child selectors
generalized to direct children and the card wears it with `.act` halves
(`.card-actions .split-arrow { width:auto }` is the one flavor rule); the
caret menu is `openVerbsPop` in grid.js — every row is `requeue()` via a
shared `runVerb` that toasts the server's own 409 sentence on a wrong
guess; the facet chain sets a `chaining` latch BEFORE `close()` so the
menu's unpin can't tear down the anchor the scope pop places against
(`openFacetScopePop` gained an `onClose` pass-through for the unlatch);
the lightbox Re-transcribe button sits in the tags head for audio
instances (head gained `gap:6px`). Visual check of the fused caret +
pop chain on compose still owed to the user's eyeball.

Cleanup pass (2026-09-05, suite 1374): the client's re-queue ritual was in
FIVE spellings with THREE error policies — half swallowed the server's 409
sentence, which is the exact fail-soft the caret's no-`can[]` design leans
on. One `requeueToast(url, ok, fail, body)` in data.js now serves the card,
its caret, rows-mode and the lightbox; a bare status code falls back to the
caller's phrasing. The `chaining` latch is gone: `close("keep-card")` is the
word crates.js already used for handing one pop to another, and a shared
`pinWhileOpen(anchor, {sel, teardown})` (grid.js) replaced FOUR copies of the
pin/unpin dance (card tag pop, caret, crates, rows tiles). Caret entries moved
into a `verbsFor(img)` list, which also answers whether to render the caret at
ALL — a board with no facets, no AI mapping, no connector and no audio used to
open an empty menu. The caret is now `actionBtn("chevron", "split-arrow
dd-caret", …)`, the toolbar's spelling. `scopableInstance`/`facetName` joined
utils beside `mappingHasAiWork` (the scoped-retag mirror was written twice).
db.js gained `touched(result)` (10 verbs, two spellings) plus `REQUEUE_RESET`
and `CLEARED_VERDICT` — the latter makes refresh's keeps-the-verdict
distinction a one-token absence instead of an eyeball diff of two SQL walls.
Efficiency: the reprocess route only resolves the transcriber when some
instance actually carries a stamp (`entityHasTranscriptStamp`) — every image,
doc and connector card was walking the whole capability ladder for an answer
it could not use; the entity retag route reads the board only when a scope was
sent. Lightbox Re-transcribe moved OUT of the facet-gated tags head into its
own Transcript head (it was unreachable on a facetless audio board) and
`queueLegBtn` lost its derivable `failed` string. tag-editor adopted `api()`.
CSS: the `gap: 6px` added for two head buttons was inert (both carry
`margin-left: auto`) and is gone; the card's split halves sit flush, since
`.act` is border-less and the bordered seam's -1px pull only made a hairline.
Tests: `routedStatus(r, id)` helper; board-sort and instance-rows now import
the SHARED browser stub — their hand-rolled copies were exactly the drift
browser-stub.js's header predicted, and they broke the moment data.js needed
`document.createElement`.

Skipped, noted: `mappingHasAiWork` is a hand-enumerated mirror of the
server's table-driven `aiWork` (the server file's own header records that
`detect` was missed by two cleanup loops when it was added) — the deeper fix
is lifting mapping-modal's `SOURCES` table into a shared client module and
defining the mirror off `capability`, which is a restructure of a module this
arc never touched. It is now the strongest argument for the deferred `can[]`,
and the trigger should be read as "the first entry whose hidden-when-it-
should-show case is user-visible", not "when the mirrors multiply".

Close-looked 2026-09-04. One finding overturns an earlier deferral; two
small server verbs are still owed; the rest is UI on rails that exist.

**Finding 1 — no server-shipped `can` array (overturns the Stage-1 deferral
note).** That note claimed "has AI work / is audio are not client-derivable."
Wrong on inspection: every caret entry's applicability rides fields that
ALREADY ship, through mirrors the client already maintains —

- *Retag / Retag one facet…*: `state.facets` + instance `status`/`undecided`
  (the same shipped fields the Stage-1 lightbox gate uses).
- *Re-extract fields*: `mappingHasAiWork(state.boardMapping)` — the exact
  mirror rows-mode's tile button already gates with
  ([utils.js:92](../public/utils.js#L92) owns the keep-in-step duty with the
  server's `aiWork`).
- *Refresh data + chart*: `state.boardMapping?.input?.connector`.
- *Re-transcribe*: any instance `kind === "audio"` (`instanceEntry` ships
  kind).

The one blind spot — an instance whose stamp has AI work on a board whose
mapping lost it — is the same accepted edge rows-mode already lives with,
and a wrong guess now fails soft: `requeue()` surfaces the server's own 409
sentence. A server-computed `can[]` becomes the right move only if these
mirrors multiply; noted as future, not built for five entries.

**Finding 2 — two one-liner verbs owed on Stage-3 machinery.**

- `refreshEntityData(db, entityId)`: `WHERE ${ENTITY_SCOPE} AND
  ${CONNECTOR_VEHICLE}` (same $-order, so the `APPLYING_MAPPING` contract
  holds), SET = strip park + `restamped(...)` + reset counters +
  `tag_facets=NULL`, status `'pending_fetch'` flat (the WHERE admits only
  vehicles — no routingCase needed), and **keeps tags/reasoning/confidence**:
  retag optics, the card holds its tags until fresh ones land. Route
  `POST /api/items/:id/refresh`, 409 "not a connector item" on null,
  entities-contract response. Cancel-safe by 3a (a fetched vehicle in the
  lane pulls, never deletes).
- `retranscribeEntity` = `retranscribeSql(ENTITY_SCOPE)` +
  `POST /api/items/:id/retranscribe` (409 non-audio) — the caret is
  card-level; an entity route beats client-side instance loops.

**Finding 3 — the tag-edit ride-along (from Stage 2's deferral), precisely
scoped.** `setItemTags` gains `RETURNING entity_ids`; the PATCH route answers
`{ok, tags, entities}`. tag-editor.js KEEPS its tags/undecided writes — the
routed report is statuses-only by design — and replaces exactly the two
divergent lines (`live.status = "tagged"` and the `every()` client
aggregate) with `applyRoutedEntities`, killing the client rule that calls
all-tagged-plus-one-failed "tagged" where `STATUS_PRIORITY` says "failed".
Pin with a multi-instance test (one failed sibling → entity reports failed).

**Finding 4 — the control itself.** The fused-pair affordance already exists
as `.split-btn` (toolbar Filters + saved-filters chevron,
[styles.css:236](../public/styles.css#L236)); its child selectors target
`.tool-btn`, so generalize them to direct children (promote, don't copy) and
the card wears it with `.act` children: the reprocess `.act` + a narrow
caret `.act` carrying a `.dd-caret` span (12px, dimmed, auto-flips via
`.dd-open`). The caret opens `openDropdown` with `ddAction` rows; every
row's handler is `requeue(url[, body])` + a toast. "Retag one facet…" chains:
`close()` → `openFacetScopePop` on the same anchor (verify the
one-open-at-a-time dance in implementation). Entries appear only when
applicable — absence is the honest state, no disabled ghosts:

- **Retag** — always (`/api/items/:id/retag`)
- **Retag one facet…** — some instance tagged + decided, board has facets
  (same route, `facets` body)
- **Re-extract fields** — `mappingHasAiWork` (`/api/items/:id/reextract`)
- **Refresh data + chart** — connector boards (`/api/items/:id/refresh`)
- **Re-transcribe** — audio instances (`/api/items/:id/retranscribe`; the
  one entry that re-bills something the main action wouldn't — the label
  says so)

Rows-mode rides along free (shared `cardFor`). Bulk bar keeps
main-action-only. Lightbox: audio instances gain a per-instance
Re-transcribe `queueLegBtn` (the 3b route), title noting the re-bill; its
other buttons stay as the instance-scoped view of the same verbs.

Icon candidates from the existing set: `tag` (retag), `srcSparkle`
(re-extract), `srcGlobe` (refresh), `srcWave` (re-transcribe).

**Order**: server verbs + tag-edit ride-along first (suite-covered), then
the split control + caret, then the lightbox button. Tests: refresh keeps
tags + routes the vehicle + 409 on a file card; entity retranscribe 409 on
non-audio; the tags-PATCH aggregate pin above.

## Non-goals

- No scheduler/DAG engine. The statuses and lanes ARE the execution model
  and they're fine; the registry is a declaration layer over them.
- Embeddings: already converge on their own; nothing changes.
- No per-artifact history UI — the jobs drill already shows every leg run.

## Order & risk

1 (pure UI honesty) → 2 (pure refactor, suite-guarded) → 3a/3b/3c
(independent of each other) → 4 (needs 3x for its entries). Riskiest edge:
3a's fetch-leg idempotence on live entities (identity self-landing,
duplicate arm) — write the fences test before the route change. 3b's
engine-diff clear touches billing; the unstamped-means-current rule is the
guard.
