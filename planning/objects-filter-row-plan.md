# OBJECTS filter row — detections as a system facet in the unified filter model

**Status: SLICES 1–6 BUILT (2026-08-03); remaining: 7 (in-app verify),
8 (optional lightbox tie-in). Closes the last product
gap from the object-detection deep dive (#8): the detector card promises
"images can be searched by object" and nothing implements it. Adds an OBJECTS
pill row to the filter strip as a SYSTEM FACET — a reserved `~objects` key
inside the one filter model (`state.selected`, saved configs, `?f=`, alert
conditions) — FOLDS the existing uploader row into the same model as
`~uploaders` (retiring its parallel slot), and adds the taxonomy gate the
Untagged pill was missing. Self-contained for a fresh session; builds on
[object-detection-plan.md](object-detection-plan.md) (the `object` field kind)
and the shipped
[object-detector-sidecar-plan.md](object-detector-sidecar-plan.md).**

## The gap, and the shape of the fix

Object detections land as instance fields (`payload.fields[key].v` = boxes) and
render only in the lightbox overlay. You cannot filter "images with a car". The
natural surface is the filter strip: an `OBJECTS  car 7  cat 5` row in the same
pill grammar as facets — OR within the row, AND against everything else, counts
that respect the other active filters, rows-mode dimming, shareable URLs, saved
configs, and (eventually) alert conditions.

**The one structural obstacle (found in the deep dive):** the whole filter
engine is client-side over `state.items`, but extracted fields are deliberately
kept OUT of the `/api/items` list payload — fetched lazily per instance when the
lightbox panel opens ([server.js](../server/server.js) `GET
/api/instances/:id/reasoning`). Instances in the list carry only tags
([db.js](../server/db.js) `instanceEntry`). So the feature needs a data plan
before a UI plan.

**Data decision: ship a distilled summary, not the boxes.** Each instance entry
in the list payload gains `objects: ["car", ...]` — just the field KEYS that
have ≥1 stored box (`Array.isArray(v) && v.length > 0`, the same discriminator
the lightbox's `objectFieldsOf` already uses). Each entity row gains the union,
beside the tags union it already computes. A few bytes per item; boxes, scores
and whys stay lazy. This follows the "tags ride the list, reasoning is lazy"
precedent, and `instanceEntry` already holds `r.payload` — pure JS, no SQL
change, no migration.

## The model: unify the SELECTION, keep the TRUTH separate

Two different questions hide in "are detections filters or tags?", and they
have opposite answers:

**Truth model — detections are NOT tags.** Tags are the judgment layer:
human-editable, snapshotted into judgment history, wholesale-replaced by `PATCH
/api/instances/:id/tags`, validated against the board's facet allowlist
([server.js](../server/server.js) tag PATCH), and the basis of "untagged".
Writing detections into the `tags` array gives one field two owners with
stomping writers: a human tag edit would strip them (the PATCH replaces the
array and drops values outside the allowlist), re-extract would have to
reconcile around human tags, an object-only board would read "tagged", and
snapshots would record machine output as judgment. Detections stay fields.

**Filter model — detections ARE filters, first-class.** The selection lives in
`state.selected` itself under a reserved SYSTEM FACET key, `~objects`, whose
values are the board's object field keys. `~` cannot appear in a mapping field
key (`/^[a-z][a-z0-9_]*$/`) and the admin facet UI produces word-like keys, so
the prefix is collision-proof in practice — the one load-bearing convention,
stated once at the constant.

The ONLY new mechanism is a membership router: for a real facet key, membership
is `tagSet.has("facet/value")`; for a system key, it's the capability's own
membership source. A small table keyed by prefix, each entry naming an
entity-level source and an (optional) instance-level source:

    const SYSTEM_FACETS = {
      "~objects":   { entity: (e) => e.objectSet,  instance: (i) => i.objects },
      "~uploaders": { entity: (e) => uploaderIdSet(e), instance: null },
    };

consulted at the three places that test membership (`matchesExcept`,
`instanceMatches`, the `computeFacetStats` pass). `instanceMatches` SKIPS keys
with no instance source — which is what preserves today's behavior (an uploader
filter never dimmed rows tiles; instances carry no uploader) while giving
`~objects` its per-instance dimming. Everything else consolidates NATIVELY:

- **Saved configs**: `{"~objects": ["car"]}` is a facet-shaped entry; the
  server's shape-based cleaning (POST /api/filter-configs) admits it verbatim.
  Old configs load unchanged.
- **URL**: `?f=~objects:car` rides `encodeSelected`/`decodeSelected` untouched.
- **`filterKey`, `activeCount`, `clearAll`, `toggle`, `configMatchesCurrent`,
  the Clear button, the alert-event reset, the grid empty-state clear, the
  rows walk-in session** ([view.js](../public/view.js) keys off
  `activeCount() > 0`) — all free, because the selection lives where they
  already look.
- **Alert conditions** (`{facetKey: [values]}`, the same cleaning) admit
  `~objects` today. What alerts need later is EVALUATION, not modeling — see
  slice 5.
- **Persons / voice / face later**: one more `SYSTEM_FACETS` entry pointing at
  a different membership set (`~persons`). Every consumer already works. This
  is the reason the unified model wins: a separate slot per dimension costs
  per-consumer × per-capability forever; the system-facet model costs one
  router, once.
- **The uploader row is the proof.** It IS the separate-slot pattern today —
  `state.selectedUploaderIds`, its own `?u=` param, its own `passesUploader`
  gate and `uploaderTotals`/`uploaderCounts` carve-out in `computeFacetStats`,
  its own branches in `taggedFiltered`/`filterKey`/`activeCount`/`clearAll` and
  the alert-event reset — and saved configs SILENTLY DROP an active uploader
  selection (`selectedAsConfig` is facet-only). Folding it into `~uploaders`
  deletes all of those branches and fixes the config gap (slice 4).

**Rejected:** full fields in the list payload (boxes × instances × items —
heavy, only the lightbox wants them); server-side filtering (foreign to the
fully client-side engine; the board streams into `state.items` completely via
`drainItems`, so client filtering is complete); storing detections as tags
(truth-model conflict above); a separate `state.selectedObjects` slot (the
first draft of this plan — the uploader precedent it copied is exactly the
divergence being retired).

## Placement — and the Untagged bug hiding under the question

The instinct that prompted this ("OBJECTS above everything, even Untagged")
comes from the objects-test screenshot, where **"Untagged 11" is noise**: the
board has no facets, so every item is permanently untagged and the pill filters
to everything. fd71f6f gated the dotted needs-tags treatment on
`boardHasTaxonomy()` ([filters.js](../public/filters.js) `needsTags`) but never
gated the pill itself (`computeFacetStats` counts it and `statusPills` shows it
unconditionally).

**Decision: gate the Untagged pill on `boardHasTaxonomy()` and keep the status
row on top.** On an object-only board the strip then leads with OBJECTS
naturally (Processing/Unprocessed still surface above while a queue is active —
transient, universally relevant). On mixed boards OBJECTS heads the labeled
band: status row → **OBJECTS** → UPLOADED BY → facet rows. (If literal-first is
still wanted after seeing it, it's a one-line move in `renderFacetsInto`.)

## Semantics (mirrors facets exactly)

- **Chip universe** = the mapping's declared object fields
  (`state.boardMapping.fields`, `kind === "object"` — the client already has
  the mapping), plus any selected-but-gone key. Per-chip visibility: `total > 0
  || active`; the whole row hides when no chip is visible. Deriving the
  universe from the mapping (not the data) means a REMOVED field's stale keys
  don't grow chips, mirroring how facet rows only render `state.facets`.
- **Chips are field keys, not detection labels** — hint synonyms (`car,
  automobile`) demux into one field; the key is the user's declared name.
- **Entity matches** if ANY instance has ≥1 box for a selected key (entity
  `objectSet` is a union, the `tagSet` shape). OR within the row, AND against
  facets/status/search/favorites/crates/uploaders — the standard cross-facet
  contract, now including this facet.
- **Counts** keep the `matchesExcept` contract: a chip counts items matching
  every OTHER active filter but not the OBJECTS row's own selection — free,
  since `matchesExcept(img, "~objects")` is the existing mechanism.
- **Instances match** (rows-mode dimming) via the same router over the
  instance's own `objects` set — an entity whose car is only in photo 2 of 3
  renders photos 1 and 3 dimmed, never hidden.
- **Counts drift upward while the extract queue drains** — same truth-lag tags
  have; pending items simply have no `objects` yet.

## Slices

### 1. Server — the distilled summary rides the list payload
[db.js](../server/db.js): `instanceEntry` adds `objects` (keys of
`r.payload.fields` where `Array.isArray(f.v) && f.v.length > 0`; omitted when
empty to keep rows lean). The entity assembly in `listItems` unions them beside
the tags union (dedup, insertion order). Both ride full listings, pages, and
`?since=` delta rows identically. **Test**: seed an item whose `payload.fields`
holds an object field with boxes, an object field with `v: []`, and a scalar
field → the instance entry carries exactly the boxed key; the entity row
carries the union across instances.

### 2. Client — the system-facet router + membership sets
- [utils.js](../public/utils.js): `toInstance` gains `objects: new
  Set(i.objects || [])`; `toItem` gains `objectSet: new Set(d.objects || [])`.
- [data.js](../public/data.js) `reconcile`: follow `d.objects` on every delta
  row (like status/hearts — extraction rewrites fields only at `markExtracted`,
  so no stale-keep guard needed, unlike tags).
- [filters.js](../public/filters.js): the `SYSTEM_FACETS` table + a
  `hasValue(imgOrInst, key, value)` router; `matchesExcept`,
  `instanceMatches`, and the `computeFacetStats` totals/counts pass route
  through it (counts keyed `~objects/car` in the existing maps — `tag(key,
  value)` composes fine, `~objects` contains no slash). NO changes to
  `filterKey`/`activeCount`/`clearAll`/`toggle`/config/URL code — the point of
  the model.
- App boot ([app.js](../public/app.js)) already parses `?f=` into
  `state.selected`; board switch is a page load, so boot parsing IS the reset
  path. Nothing to add.

### 3. Client — the OBJECTS row
[filters.js](../public/filters.js) `renderFacetsInto`: the OBJECTS row (label
`OBJECTS`, `facet` row class, `pill(...)` chips via `toggle("~objects", key)`)
between the status row and UPLOADED BY, gated on any visible chip. Chip
universe per Semantics. Mobile drawer comes free (same function renders both).
Client filter code is DOM-coupled at import and has no node tests today —
status quo; the server payload (slice 1) is where the tests live.

### 4. Fold the uploader row into the model (`~uploaders`)
Deletion-heavy. [filters.js](../public/filters.js): retire
`state.selectedUploaderIds` + `toggleUploader`; the uploader clause in
`taggedFiltered`, the `passesUploader` gate and
`uploaderTotals`/`uploaderCounts` carve-out in `computeFacetStats`, and the
per-slot lines in `filterKey`/`activeCount`/`clearAll` +
[alert-event.js](../public/alert-event.js) all collapse into the unified path.
The row renderer keeps its two specifics: the "2+ distinct uploaders"
visibility rule and name resolution (from items, fallback to the id); chips
call `toggle("~uploaders", String(uid))`. Values normalize to STRING ids at the
boundary (`state.selected` values are strings — configs and `?f=` assume it).
[app.js](../public/app.js): stop writing `?u=`; keep a one-line boot shim
mapping old `?u=5,7` links into the `~uploaders` selection.
**Two deliberate behavior changes, both gains:** (a) saved configs now CAPTURE
an active uploader selection instead of silently dropping it; (b) count
semantics converge on the documented `matchesExcept` contract — facet chips
start respecting an active uploader selection (today they ignore it), uploader
chips stop respecting favorites/crates (today's asymmetric carve-out).

### 5. The Untagged gate
[filters.js](../public/filters.js) `statusPills`: the Untagged entry only when
`boardHasTaxonomy()` (keep the `|| state.showUntagged` escape so an active pill
stays clearable if facets are deleted mid-session).

### 6. (Follow-up, designed-for now) Alerts on objects — the third landing
The condition schema already admits `{"~objects": ["car"]}` (same shape
cleaning as filter configs). Making it FIRE needs: (a) the alerts modal
offering the OBJECTS dimension beside facets when the board has object fields;
(b) the server matcher ([alerts.js](../server/alerts.js)) routing `~`-prefixed
condition keys to the entity's object projection instead of tags; (c) an
evaluation hook at the EXTRACT landing (objects land at extract, not at the two
tag landings the matcher hooks today), with the same baseline discipline
("already-matching entities recorded"). Separable from the row; the model
change in this plan is what makes it an evaluation hook rather than a schema
fork. BUILT for `~uploaders` too (the review pass caught that the fold let the
modal store uploader conditions the matcher couldn't see — both set builders
now project `~uploaders/<uploaded_by>`), so "alert when X uploads a car"
composes from two system facets in one condition today; `~persons` later rides
the same steps.

**Landing coverage (post-review fix).** The three landings missed uploads
whose pipeline never reaches them: a facet-less board's tag leg completed
items without evaluating (processOne's no-facet branch — box-less uploads on
the objects-test board shape were never seen), and an unmapped auto-tag-off
board admits straight to `held`, running no leg at all — so an
`~uploaders`-only alert never fired there. Two hooks close it: the no-facet
tag landing now evaluates like the real one, and upload admission
([ingest.js](../server/ingest.js) `admitFile`) evaluates at birth, gated on
`uploadedBy` the way the extract stamp gates on boxes (the folder door admits
with none; nothing else in a newborn item can match). Birth evaluation on a
derived-identity board can match a provisional entity that a later merge
deletes — the ledger's merge-following (`live_entity_id`) and frozen labels
already cover exactly that.

### 7. Verify in the app (objects-test board)
Chips `car`/`cat` appear with counts once extraction lands; clicking filters
the grid and flips a multi-instance result into rows with non-matching
instances dimmed; the URL carries `?f=~objects:car` and a reload restores it;
save → clear → apply round-trips a config containing objects + facets + an
uploader; an old `?u=` link still lands on the uploader filter; "Untagged 11"
is gone from that board (still present on facet boards); counts respect an
active facet and vice versa; an uploader selection does NOT dim rows tiles
(entity-only), an object selection does.

### 8. (Optional) Lightbox tie-in
With an object filter active, opening the lightbox pre-highlights that field's
boxes (`highlightDet`) — closes the loop from chip to pixels. Small, separable.

## Risks / notes
- **Payload growth is negligible** (short key strings, only on instances that
  have detections), but it rides EVERY items response — keep the
  omit-when-empty discipline.
- **`~` is reserved by schema now, not just convention.** Board create/PATCH
  reject a `~`-prefixed facet key (`facetsReservedKeyError`) — with alert
  conditions and saved configs durably storing system keys, a shadowing facet
  could no longer be tolerated as a theoretical case. The only facet-key
  constraint enforced server-side.
- **A selected `~objects` key with no data** renders like a selected-but-empty
  facet value (chip shown active at 0) — the existing convention; no special
  case.
- **Chip counts are extraction-lagged** — a chip can read 3 while the queue
  still holds 5 more cars. Same truth-lag tags have; the Processing pill is
  the existing tell.
- **Where the model's boundary sits.** System facets are board-objective
  CONTENT dimensions — worth saving, sharing, alerting on (`~objects`,
  `~uploaders`, `~persons` later). Favorites, crates, search, and the status
  pills stay outside: viewer-relative or transient-workflow state
  ([view.js](../public/view.js) already draws this line — favorites/crates/
  search don't start rows sessions or count as filters). Untagged sits with
  status. Don't fold those.
- Aligns with [[feedback_flexibility_over_guardrails]] (one router, not a
  parallel subsystem per capability) and the detection plan's standing rule:
  detection annotates pixels; it never touches tags or identity — the
  system-facet projection happens at the filter boundary, never in storage.

## Pointer
After this, the remaining deep-dive items are #1 (single-field demux fallback —
detectionDemux is staged for it), #4 (threshold=0 unreachable), #7 (box cap),
and #12 (the untracked scripts/logos-board.json). The router ships with two
consumers (`~objects`, `~uploaders`); the `~persons` system facet (face/voice
capabilities) is the planned third.
