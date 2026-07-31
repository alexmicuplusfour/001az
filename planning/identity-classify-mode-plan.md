# Identity classify mode — "Match to a list"

Status: **PLANNED, not built.** Design settled 2026-07-31 after a long thread. Parent: `slice-4-derived-identity-plan.md` (extract-mode identity), `entity-instances-plan.md` (the entity/instance model this restructures).

## The bug that started it

Derived-identity boards (`mapping.identity.from === "ai"`) extract a single string per item and resolve it to one entity. When an item genuinely maps to **more than one** known identity — a photo of two people, a contract with two parties, a headline naming two tickers — the model has nowhere to put the second:

- Scalar schema (`value: ["string","null"]` in `buildFieldsPrompt`) forces exactly one → it picks one, drops the other.
- Loosen the prompt to "one or more" → the model returns a joined string (`"Emma Watson, Emma Roberts"`), which `normaliseIdentity` keys as a bogus composite entity.

It's a **cardinality** bug. Also wrong on open-ended extract: the answer space is unbounded even when the user *knows* the valid answers, so the model drifts (`"Emma Watson"` vs `"E. Watson"` fork into separate entities) with no way to forbid off-set answers.

## The design (two independent decisions)

1. **A classify mode on the identity field**, toggled by one control: **"Match to a list."**
   - **Off** → today's open extraction. AI derives any string; find-or-create; new values create new entities. Required for "extract the applicant's name" where the user *cannot* enumerate answers.
   - **On** → the AI's answer is **constrained to a user-declared list** of allowed strings (+ optional per-value hint). Multi by default. No match → nothing.
2. **A native multi-membership entity model** (this is the restructure — user chose it 2026-07-31 over a join-table bolt-on): an item **carries its identities** and an entity is the **grouping over every item that carries it**. Single-membership is just the length-1 case; multi-membership falls out for free.

### Non-negotiable principles (each killed a heavier idea)

1. **The candidate list is CONFIG, not entities.** It only narrows the AI's answer space (open → closed). It never creates, seeds, or materialises entities; nothing in it appears in the gallery until real content matches it. Rejected: seeding provisional entities from the list (matched entities must stay AI-authored and expendable, not hard user-created things).
2. **Entity grouping stays — it's the spine of the app** (the row view, hearts, crate, faces, alerts all hang off it). We restructure *how membership is stored*, not *whether items group into entities*.
3. **Extract and classify are the SAME code path**, differing only in the answer space (one derived value vs. one-or-more from a list). The resolution logic doesn't branch on mode — it resolves a *set* of derived values, which happens to have size 1 in extract mode.
4. **Candidates are user-declared and pre-exist extraction** (cold-start: they cannot be bootstrapped from already-extracted entities).
5. **Multi by default, no single/multiple control.** "Multiple" is a superset; "zero or more" absorbs the no-match case. A `single` option is deferred.
6. **No explicit "classify vs extract" mode label** — prior art (Airtable/Notion field types, JSON-Schema enum, Instructor `Literal`) always expresses this as presence/absence of an options list. The toggle is for legibility; mode = "is a non-empty candidate list bound."
7. **Reuse the tagging value-editor UI**, flattened one level (the identity field *is* the one facet), with an optional per-value hint.

## Data model — the restructure

### Before → after

```
items:     entity_id  bigint          →   entity_ids  bigint[]     (GIN-indexed)
entities:  UNCHANGED  (id, board_id, identity UNIQUE per board, display_name,
                       symbol, fields, identity_provisional, timestamps)
```

- An item **carries** the ids of every entity it belongs to. Length 1 = today's norm. Length N = classify multi. Length 0 = truly unmatched (rare — upload seeds a provisional, see below).
- An entity's instances: `SELECT … FROM items WHERE entity_ids @> ARRAY[$1]::bigint[]` (GIN index on `entity_ids`).
- **Everything that hangs off `entity.id` is structurally untouched** — hearts, crate membership, faces, alerts baselines still reference entity rows exactly as today. Entities are still rows with stable ids and a unique `(board_id, identity)`. The *only* thing that moved is the item→entity link: scalar FK → carried array. This is the key reason the restructure is contained rather than total. (Confirmed by grep: >half the `entity_id` occurrences are on *other* tables — `job_log`, `alert_matches`, `field_snapshots` — that reference `entities.id` directly and do NOT move.)

### Two consequences found on reading the code (2026-07-31)

- **The `ON DELETE CASCADE` FK is lost — `deleteEntity` must clean up orphans explicitly.** Today `items.entity_id REFERENCES entities(id) ON DELETE CASCADE`, and `deleteEntity` (db.js 1522) relies on that cascade to drop instances. A Postgres array can't carry an FK, and it *must not* cascade anyway — deleting one entity must not delete an instance that still belongs to another. So `deleteEntity` becomes explicit: pull the deleted id out of every instance's `entity_ids`, delete only the instances left **orphaned** (empty array) and return *their* files for cleanup, leave shared instances alone. This is the trickiest single change in Slice 1.
- **"Primary" survives as a canonical-for-attribution convention, `entity_ids[0]`.** Membership has no primary/secondary — but several readers want a *single* entity for non-membership reasons: job-log attribution (worker 458/1336/1835), the entity the worker resolves while rendering a face (worker 1010/1461/1626/1622), semantic-search result attribution (db.js 1948), the touch in `deleteInstance` (db.js 1540). Convention: keep the array **ordered** (first = the primary-derived / first-matched value) and use `entity_ids[0]` as the canonical entity for logging/faces/search. So "primary" returns — not as a membership tier, but as an ordering convention.

### Why carry entity **ids**, not identity strings

Carrying ids keeps the common op cheap: **rename** (extract mode re-derives a slightly different spelling) is a single `entities` row update — the id is stable, items need no rewrite. Only **merge** (fold entity A into B) becomes a bulk array rewrite (swap A's id for B's across its items, then delete A), and merge is rare. Carrying identity strings would invert that trade (cheap merge, bulk rename) — worse, because rename is the frequent one.

### Mapping shape (config)

```js
identity: {
  from: "ai",
  hint: "Which person does this face resemble?",   // field-level instruction (unchanged)
  candidates?: [                                     // NEW — presence ⇒ classify mode
    { value: "Emma Watson",  hint?: "British actress, warmer tone" },
    { value: "Emma Roberts", hint?: "darker hair" },
    { value: "Emma Stone" },
  ],
}
```

- `candidates` absent/`[]` ⇒ extract mode (byte-for-byte today). Non-empty ⇒ classify mode.
- `value` required non-empty; `hint` optional ≤500 chars. A candidate `hint` is **prompt-only** — never stored on the resulting entity (keeps config/entity decoupled per principle 1).

### Validation (`validateMapping`, server.js ~1202)

```js
if (id.candidates !== undefined) {
  if (id.from !== "ai") return `mapping.identity.candidates requires from "ai"`;
  if (!Array.isArray(id.candidates)) return `mapping.identity.candidates must be an array`;
  const seen = new Set();
  for (const c of id.candidates) {
    if (!c || typeof c.value !== "string" || !c.value.trim())
      return `each identity candidate needs a non-empty "value"`;
    if (c.hint !== undefined && (typeof c.hint !== "string" || c.hint.length > 500))
      return `identity candidate hint must be a string ≤500 chars`;
    const k = normaliseIdentity(c.value);
    if (seen.has(k)) return `duplicate identity candidate: "${c.value}"`;
    seen.add(k);
  }
  // optional cap, e.g. ≤200 candidates (mirrors the 12-AI-field cap rationale)
}
```

`hint` stays required for `from:"ai"` (the field instruction) regardless of candidates.

## Extraction schema (`buildFieldsPrompt`, worker.js 316)

The one behavioral fork. Today's identity slot is `{ why, value: ["string","null"] }`.

**Classify branch** (`mapping.identity.candidates?.length`) mirrors the proven facet enum-array pattern (worker.js 251):

```js
const values = mapping.identity.candidates.map(c => c.value);
properties.identity = {
  type: "object",
  description: identityHint || "Which of the listed options this item matches.",
  properties: {
    why:    { type: "string" },
    values: { type: "array", items: { type: "string", enum: values } },   // multi, closed → no drift
  },
  required: ["why", "values"],
  additionalProperties: false,
};
```

- Enum makes off-list answers structurally impossible; `values: []` is the legal no-match.
- Per-candidate hints render into `systemText` as lines (`- Emma Watson: British actress…`), like facet values at worker.js 204. Extract-mode systemText unchanged.
- `extractOne` reads `input.identity.values` (array) in classify mode, `input.identity.value` (scalar) in extract mode — normalised into a single `derivedValues` array below.

## Runtime resolution (`extractOne`, worker.js ~1502) — now unified

The big win: the ~80-line merge/split/rename block collapses into one set-based reconcile that serves **both** modes.

**Upload** (unchanged in spirit): create the item with `entity_ids = [provisionalEntityId]` — a provisional entity keyed by the filename, so it shows in the gallery immediately, exactly as today's single provisional.

**Extraction:**

```js
const derivedValues = mapping.identity.candidates?.length
  ? (input.identity.values || [])                              // classify: 0..N
  : (input.identity.value ? [input.identity.value] : []);      // extract:  0..1

// Resolve each value to an entity id via the SAME find-or-create as today.
const resolvedIds = [];
for (const v of dedupeByKey(derivedValues)) {
  const key = normaliseIdentity(v), display = v.trim();
  const e = await getEntityByIdentity(db, boardId, key);
  if (e) { await setEntityIdentity(db, e.id, key, display); resolvedIds.push(e.id); }
  else   { resolvedIds.push(await createEntity(db, boardId, { identity: key, displayName: display })); }
}

if (resolvedIds.length === 0) {
  // no identity derived / no match → keep provisional (existing "kept" path)
} else {
  const oldIds = item.entity_ids;
  await setItemEntities(db, item.id, resolvedIds);      // rewrite the array — THE membership write
  await reconcileEntities(db, union(oldIds, resolvedIds));  // delete emptied, rename-in-place, touch survivors
}
```

- **Merge and split stop being special cases** — they're emergent. Two items resolving to the same key get the same id in both arrays; the losers' provisional entities empty out and `reconcileEntities` deletes them. An item's membership changing is just a new array.
- **Rename-in-place survives as a reconcile heuristic** (the one piece of extract-mode subtlety that carries over): when a sole/provisional old entity is about to empty AND a resolved key had no existing entity, prefer renaming the old entity in place (stable id → its hearts/crate survive) over create-new-then-delete-old. This is the same intent as today's "sole instance: rename in place" branch, now expressed against the array instead of the FK.
- `reconcileEntities(ids)`: for each id, `deleteEntityIfEmpty` (empty = no item's `entity_ids` contains it) else `touchEntity` (delta polls repaint). A merge/split disposition still triggers `evaluateItemAlerts`.

## Migration (`00NN_item_entities_array`)

Mirrors migration 0005 (items→entities) in spirit — additive, idempotent, cut over, then drop:

1. `ALTER TABLE items ADD COLUMN entity_ids bigint[]`.
2. Backfill `entity_ids = ARRAY[entity_id]` (NULL → `'{}'`).
3. `CREATE INDEX … USING GIN (entity_ids)`.
4. `ALTER TABLE items DROP COLUMN entity_id` — this also drops the `ON DELETE CASCADE` FK and `idx_items_entity`. Safe in the same migration because it ships with the code cutover (the new code never references `entity_id`); the migration ledger wraps `up` in a transaction. Losing the cascade is *why* `deleteEntity` gains explicit orphan cleanup.

## Query fan-out — bucketed by difficulty (audited against the code 2026-07-31)

Only the `item.entity_id` sites move; `entity_id` on `job_log` / `alert_matches` / `field_snapshots` references `entities.id` and is untouched.

| Difficulty | Sites | Change |
|---|---|---|
| **Mechanical** `= X` → `@> ARRAY[X]` | entityInstanceCount (1482), deleteEntityIfEmpty (1490→`NOT EXISTS … @>`), first_file (2196), tag-union (2201), source-join (1560), delta subquery (119→`unnest`) | swap predicate |
| **Fan-out bucketing** | listItems (148-167): `= ANY` → `&& $1`, and push each instance into *every* matching entity's bucket | one instance → many buckets |
| **Iterate the set** | alerts.js:65 (evaluate each entity of the item), alert recompute (2237 `unnest`), instance-remove server.js:2290 (check each entity) | loop entities |
| **Canonical `entity_ids[0]`** | worker legLog (458/1336/1835), worker getEntity-for-face (1010/1461/1626/1622), semantic search (1948), deleteInstance touch (1540 → touch all, canonical for label) | pick first / touch all |
| **Rework** | deleteEntity (1522): FK cascade → explicit orphan cleanup (see Data model) | behavior change |
| **Dissolves** | reparentItem (1478), reparentInstance (1502) | delete; replaced by setItemEntities + reconcileEntities |
| **Upload** | insert (255): `entity_id` → `entity_ids = ARRAY[provisionalId]` | array seed |

The row view and gallery are **safe**: they still ask "entity → its instances"; only the predicate changes from `= X` to `@> [X]` / `&& [X]`. No UI change.

## Client UI (`mapping-modal.js`, identity row ~127)

Under the AI-instruction hint (`idHintWrap`), add:

1. A **"Match to a list"** toggle via the existing `switchRow` helper, shown only when `identityFrom === "ai"` (tracks the hint's show/hide at line 172).
2. When on, a **candidate editor** beneath it: a flat list of rows (`value` input + optional `hint` input + `×`) plus a `+ value` button — the `fe-values` pattern from the facet editor (board-modal.js 146–184) with a per-row hint. Reuse the `fe-*` CSS so it matches the Tagging tab.
3. State: `let candidates = mapping?.identity?.candidates || []`.

Serialization (`buildPayload`, ~819):

```js
const identitySlot = identityFrom === "ai"
  ? { from: "ai", hint: identityHint.trim(),
      ...(candidates.length ? { candidates: candidates.filter(c => c.value.trim()) } : {}) }
  : identityFrom === "connector" ? { from: "connector" } : { from: "raw" };
```

Client guard (mirror the hint-required check at 815): toggle on + empty list → block save with a toast. Never persist a toggled-on, listless field (keeps "mode = has a list" true). `applyTemplate` (~779) reads `candidates` too, so connector templates can ship a starter list.

## Slice 1 — AS BUILT (2026-07-31, uncommitted; full suite 592/592 green)

Shipped the whole restructure; extract mode is behavior-identical (length-1 arrays). Deviations found on contact with the code:

- **`bigint[]` needs its own type parser.** The scalar BIGINT→Number parser (db.js:11) doesn't reach array elements, so `entity_ids` came back as `string[]` and broke numeric compares + the `listItems` bucket lookup. Added an OID-1016 parser wrapping the default array parser with `Number` (db.js).
- **`deleteInstance` CTE.** `id = ANY((SELECT entity_ids FROM del))` is `bigint = bigint[]`; flattened with `id IN (SELECT unnest(entity_ids) FROM del)`.
- **Worker-consumed queries return the array, not a scalar alias.** `itemsNeedingEmbedding` / `oneAudioNeedingTranscription` feed rows whose job-log attribution reads `row.entity_ids?.[0]`, so they select `entity_ids`. Only `boardEmbeddings` keeps `entity_ids[1] AS entity_id` (its consumer, the search route, wants the scalar).
- **Historical migration replays.** Tests that re-run 0005/0007/0024 `up` against the HEAD schema broke (those migrations join via the dropped `entity_id`). Added a `withLegacyEntityId(db, fn)` test helper (helpers.js) that resurrects the column from `entity_ids[0]` around the replay and folds back after — single-membership only, which holds for the historical rows.
- **White-box mechanics tests rewritten**, not "kept unchanged": the suite imported `reparentItem`/`reparentInstance` and queried the `entity_id` column directly (both gone). Those became `setItemEntities`/`reconcileEntities` tests; the FK-cascade lock/rollback tests were dropped (no FK now) and replaced with multi-membership + orphan-cleanup tests. Behavioral tests (listItems union, routes, reprocess) stayed and are the parity net.

Files: `server/migrations/0025_item_entities_array.sql`, `server/db.js`, `server/worker.js`, `server/alerts.js`, `server/server.js`; tests `test/helpers.js`, `test/derived-identity.test.js`, `test/alerts.test.js`, `test/list-pagination.test.js`, `test/connectors.test.js`, `test/payload.test.js`.

## Slice 2 — AS BUILT (2026-07-31, uncommitted; full suite 596/596 green)

The classify feature is now reachable end-to-end via the API (no UI yet — Slice 3):

- **`validateMapping`** (server.js) accepts `mapping.identity.candidates`: array of `{ value, hint? }`, requires `from:"ai"`, `value` non-empty, `hint` ≤500, ≤200 candidates, and rejects duplicates by normalised key (using the shared `normaliseIdentity`, so validation dedups exactly the way the runtime resolver does). The mapping persists wholesale as JSONB, so `candidates` rides through the existing board PATCH untouched.
- **`normaliseIdentity`** promoted from a worker closure to a module-level export (worker.js) so server-side validation and the runtime keyer can't drift.
- **`buildFieldsPrompt`** (worker.js) classify branch: when `candidates.length`, the identity slot becomes `{ why, values: [enum of candidate values] }` (mirrors the facet enum-array shape — off-list answers are structurally impossible, `values:[]` is the legal "matches none"); the per-candidate hints render into `systemText` (the enum can't carry them). Empty/absent candidates → the original scalar `{ why, value }` open path, byte-identical.
- **Resolution was already done in Slice 1**: `extractOne` reads `input.identity.values` in classify mode and feeds the set into `setItemEntities` + `reconcileEntities`. So the two-Emmas photo lands as a member of both entities with zero new resolution code.

Not added: a live-AI integration test of the full extract→multi-membership loop — the repo defers worker-AI wiring to live verify (unit tests cover the schema shape, validation, and the reconcile mechanics separately). Slice 3 (the modal toggle + candidate editor) makes it reachable without the API.

## Slice 3 — AS BUILT (2026-07-31, uncommitted; client-only, suite still 596/596)

The modal UI, all in [mapping-modal.js](public/mapping-modal.js) under the identity row:

- **"Match to a list" toggle** via the existing `switchRow` (imported from board-modal.js), shown only under AI instruction. Reveals a candidate editor when on. Presence of a bound list is the mode; `classifyOn` just drives the reveal so an on-with-empty state is distinguishable and blockable.
- **Candidate editor** — a flat list of `value + optional hint` rows + "+ option", reusing the tagging value-editor `fe-*` styling so it reads like the Tagging tab. One level (no facet nesting), per-option hint. `isAdmin`-gated like the AI-field rows.
- **Serialization** (`collect`): trims/keeps options with a value, drops empty hints; emits `candidates` only when the toggle is on and the list is non-empty. **Save guard**: on-but-empty → toast, `{ok:false}` (never persists a listless classifier — matches the server rule).
- **Template apply** reads `candidates`, so a connector template can ship a starter list.

Verification: client JS isn't imported by the node suite, so this is `node --check` + review (matches the repo's no-headless convention). `body === container`, so the pane's capture-phase input/change listener already flips dirty on option edits; explicit `markDirty` on the add/remove/toggle clicks. The full extract→two-Emmas loop is still live-verify territory (unit tests cover schema/validation/reconcile separately).

**Feature complete across Slices 1–3** (uncommitted): a file board can be configured (toggle + option list), the schema constrains the AI to the list, and a multi-match item becomes a first-class member of several entities — the original two-Emmas bug, fixed.

## Review pass (2026-07-31, post-Slice-3; suite 596/596)

Two fixes from an adversarial re-read of Slices 2–3:

- **Drift filter in `extractOne` (correctness).** The schema enum forbids off-list answers only on *strict* providers; a best-effort provider could still return one and mint a rogue entity, breaking the bounded-set guarantee. The **tagging leg already guards this** (`if (allowed.has(t)) tags.push(t)`, worker.js:1085), so classify now mirrors it: an `allowedByKey` map (normalised value → candidate's canonical spelling) filters returned values to the declared set. Bonus: display name is now the **candidate's** spelling, not the model's echo, so "emma watson" from the model still shows as the declared "Emma Watson". Not unit-tested (worker-AI internals are live-verify per repo convention), but it's the same pattern as the tagging filter.
- **Read-only toggle (polish).** `switchRow` has no disabled state, so on a non-admin (read-only) mapping pane the "Match to a list" switch was interactive while every other control was disabled. Frozen with `pointer-events:none` + dim when `!isAdmin`.

Checked and found clean: no other `mapping.identity` consumer needs candidate-awareness (the `from==="ai"` "has AI work" checks in db.js/ingest.js/worker.js are mode-agnostic and correct); `buildFieldsPrompt` isn't board-cached so a candidate edit takes effect immediately; empty-`values` (matches none) correctly falls through to the provisional/unmatched path; backup/restore introspects columns so `candidates` (living in the `mapping` JSONB) needs nothing special.

## Build order

Classify mode is **not exposed in the UI until the backend is done** (no user sees a half-built feature).

- **Slice 1 — the restructure (backend, biggest slice).** The `entity_ids` migration; rewrite `extractOne` to the unified set-based reconcile; the query fan-out cutover; `deleteEntityIfEmpty`/`alerts.js` updates. This is pure model change — **extract mode still behaves identically** (length-1 arrays), which is exactly how it's tested: the full existing `derived-identity` suite must stay green with zero behavior change before any classify work. De-risks by proving the new model is a faithful superset of the old.
- **Slice 2 — classify schema + resolution.** `candidates` in mapping + `validateMapping`; the classify branch in `buildFieldsPrompt`; feed `input.identity.values` into the (already-built) set reconcile. This is where the two-Emmas case actually gets fixed — and it's *small*, because Slice 1 already made membership a set.
- **Slice 3 — the UI.** Toggle + candidate editor + serialization + guard + template support. Feature becomes reachable.
- **Slice 4 — polish (optional).** Per-candidate hint tuning; an explicit "Unmatched" gallery surface if the provisional path proves too invisible; a `single` cardinality option if a mutually-exclusive use case appears.

## Testing

**Slice 1 (parity — the safety net):** the entire existing `test/derived-identity.test.js` must pass unchanged. Add: multi-membership read (an item in two entities' arrays appears in both instance lists), `deleteEntityIfEmpty` respects array membership, rename-in-place preserves entity id/hearts, `alerts.js` evaluates every entity of a multi-membership item.

**Slice 2 (the feature):**
- Classify single match → parity with extract (one-length array).
- **Two-Emmas: one item, two candidates matched → item's `entity_ids` holds both; both entity strips show it; neither is a composite string.** The headline test.
- No match (`values: []`) → item stays provisional, no entity minted.
- Enum enforcement → off-list value rejected by schema (pin the shape).
- Re-extract sheds a match → array shrinks, emptied entity deleted, survivors touched.
- Validation: candidates without `from:"ai"` rejected; duplicate-by-normalised-key rejected; over-long hint rejected.

## Risks & open questions

- **This changes the core items↔entities relationship** — a real migration touching data + every entity query + the delicate extract-mode dynamics. Mitigation: Slice 1 ships the model change alone, gated on the existing suite staying green (extract mode must be behavior-identical). Don't start classify until parity holds.
- **No FK on `entity_ids`** (Postgres arrays can't reference-constrain). Entity deletion must scrub arrays — but `deleteEntityIfEmpty` only fires when no array references the id, and merge does an explicit swap-then-delete, so orphan ids shouldn't arise. Add a guard/test anyway.
- **`alerts.js` and any single-entity assumption** must be found before cutover — a missed `item.entity_id` reader silently sees one entity instead of the set.
- **Rename-in-place heuristic** is the one carried-over subtlety; get its trigger right (sole/provisional old entity emptying + new key with no entity) or hearts/crate get orphaned on re-extract. Covered by a Slice-1 test.
- **Deleting a candidate after entities exist** does nothing to those entities (they're AI data); re-extraction just won't re-match. Document in UI copy.

## Out of scope

- A `single` cardinality option (deferred to Slice 4 if ever needed).
- A dedicated "Unmatched" gallery bucket (the provisional path covers v1).
- Binding the candidate list to a *separate managed table* (Airtable linked-record pattern) — per-field config for now; a shared candidate source is a later idea.
- Seeding/pre-materialising candidate entities in the gallery (rejected — violates principle 1).
