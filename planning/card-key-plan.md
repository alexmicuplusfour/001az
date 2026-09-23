# Card key — identity becomes a field (2026-09-23)

**Status: Stages 1–5 DONE 2026-09-23, uncommitted. Unit 1862/1862, browser 52/52. Stage 5 not yet seen in the real app (rebuild the compose image first). One commit remains.** Design settled in conversation 2026-09-23
after a deep dive on extraction, identity and derived identity. Parents:
`slice-4-derived-identity-plan.md` (what derived identity does),
`identity-classify-mode-plan.md` (match-to-a-list), `field-sources-plan.md`
(the source table this plan shrinks), `entity-instances-plan.md` (the
entity/instance model, untouched here). Self-contained for a fresh session.

The user's method applies (see memory: close look, then build, then a second
pass): one close read of each stage BEFORE building it, a fresh-eyes pass
after the last one. The close read of Stage 1 is expected to rewrite parts of
this document; that is the point of it.

## Why

The Mapping tab has never felt right, and the deep dive found the reason. The
identity slot is an extract field with its own drawer, its own validation, its
own reserved key and its own client state — and the prompt builder already
admits it ("identity is just another extraction field to the model"). The
runtime treats it as a field too: one value out of the model's answer,
normalised into a key, resolved to an entity. Everything special about it is
in the CONFIG, not the mechanism:

- `mapping.identity` is a second place to write an AI instruction, with a
  drawer that duplicates the field drawer (instruction editor + options rows).
- "Match to a list" exists only on identity, though nothing about it is
  identity-specific — it is a closed answer space for an extract field.
- `identity` is a reserved field key because the slot's answer shares the
  `record_fields` schema with the fields.
- `aiWork` needs a special clause for the slot; `FIELD_SOURCE_DEFS.slots`
  exists mostly so extract can say it may bind identity.
- The slot's `why` sentence is never stored (only the fields' are).

The user's notes, distilled: *extract a field, and group by it — no identity
concept required.* Grouping stays HARD (materialised entities with stable
ids — hearts, crate, alerts, faces, refresh schedules, MCP fanout all hang
off `entities.id`; a view-only group would orphan all of it on every
re-extract). What changes is where the choice lives: the mapping names one
field as the card key instead of carrying a separate identity object.

Vocabulary: not "grouping" (it breaks for one-instance cards — stocks,
résumés) but **the card**. The Mapping pane's Card section already asks the
two questions: what one card IS (now: "one card per ___") and what it SHOWS
(face). "One card per file", "one card per invoice month", "one card per
ticker" read the same; the single-instance case is the degenerate one, not
a broken one.

## The design

Three moves, one mechanism unchanged.

1. **Options become a generic extract-field feature.** Any extract field may
   carry `options: [{ value, hint? }]`. With options the field's value is a
   zero-or-more selection from the list (array of canonical spellings);
   without, a scalar as today. This is exactly what identity's classify mode
   does now, moved onto the field.
2. **The identity slot becomes a pointer.** `mapping.card = { by: "<field
   key>" }` names one extract field as the card key. Absent = one card per
   file. On a connector board the slot is absent and locked: the connector
   defines the card (the manifest's `identity.blurb` is the row's copy, as
   now). The ticker is NOT a field — the user's own verdict ("that's
   confusing") and the runtime agrees: connector identity is the lowercase
   symbol, derived in `runtime.js`, not mapped.
3. **The identity drawer is deleted.** The Card row becomes a dropdown ("one
   card per: file | <extract fields…> | + new field"); the chosen field's tile
   wears a small mark. One control for a mutually-exclusive choice, visible
   without opening anything.

What does not move: `entities`, `resolveIdentity`, `normaliseIdentity`,
`reconcileEntities`, rename-in-place, the 23505 merge recovery, faces and
`selectFace`, the sort catalogs' three-way split, the job-log `identity`
disposition, MCP, alerts. The extract leg reads the derived value out of
`fields[card.by]` instead of `input.identity`; that is the whole runtime
change.

## Wire shape

```js
// boards.mapping (and the per-item stamp at items.payload.mapping)
{
  input?:  { connector },                       // unchanged
  card?:   { by: "person" },                    // NEW — names a field below; absent = per file
  face?:   { source: "file", prefer, pick }     // unchanged
         | { source: "connector", producer, period, refresh? },
  fields: [
    { key: "person", kind: "text", source: "extract",
      instruction: "which of these people appear in this photo?",
      options: [ { value: "Emma Watson", hint?: "…" }, … ] },   // options now legal on any extract field
    { key: "invoice_amount", kind: "number", source: "extract", instruction: "…" },
    { key: "extension", kind: "text", source: "file", fn: "extension" },
    …
  ]
}
// GONE: mapping.identity (both { source:"extract", instruction, options? } and { source:"connector" }).
```

Stored values (`items.payload.fields`) for an options field: `{ v: ["Emma
Watson"], why, kind: "list" }` — an array, possibly empty, stamped in the
shape column file fields already carry (D11 below, as amended by the
simplify pass). Scalar fields keep `{ v, why }`.
The card field lands in `payload.fields` like any other, so its `why` is
finally kept and visible per instance.

## Decisions (for the Stage 1 close read to confirm or overturn)

- **D1 — slot name `card: { by }`**, not `identity: { field }`. The arc's
  whole point is that "identity" stops being a mapping concept; the slot is
  the Card section's first row and the wire should say so. The entities
  column keeps its name (`entities.identity` is the KEY, a different thing).
- **D2 — options require `kind: "text"` and make the value an array.**
  Multi, zero-or-more, no single/multiple control (the classify plan's
  principle 5 carries over). A field that should hold one answer still works
  — the model picks one — and a `single` cap stays deferred until asked for.
  Number/date/url with options is refused at validation: an enum of dates is
  not a thing anyone asked for.
- **D3 — eligibility for `card.by`: any extract field, options or not.** The
  key is the value's string form (`String(v)` → `normaliseIdentity`), so a
  date field can key cards (identity "can be a date" was already true). Not
  eligible: detect (boxes), file and connector fields (deterministic sources
  would need identity resolution at admission / on the entity — a later
  "one card per extension" is a why-not, not this arc). Refused on a
  connector board: the connector owns the card.
- **D4 — migration names the lifted field `identity`.** `identity` was the
  reserved key, so no existing field can collide with it; the lifted field
  keeps its instruction and options verbatim and goes FIRST in `fields`. The
  user can rename it in the drawer afterwards. (Alternative considered:
  slugify the instruction — produces `extract_the_year_and_month_of…`, worse.)
- **D5 — the 12-field cap stays.** A board at 12 extract fields plus a
  lifted identity holds 13 after migration; it renders, extracts and
  re-extracts fine (validation runs on SAVE), and the next save asks the
  user to drop one. Count such boards on the local DB during Stage 1 — the
  expectation is zero.
- **D6 — removing the card field resets the card to per-file**, client-side,
  with a plain toast ("one card per file again — <key> was the card key"). No
  confirm dialog (defaults, not laws). The server 400s a dangling `card.by`
  so an API caller can't save a pointer at nothing.
- **D7 — the card field shows twice in the lightbox, and that is right.**
  The entity title carries the name; the instance's fields row carries the
  same value with its `why` and `src` badge. Today the identity's reasoning
  is discarded; now it's the row.
- **D8 — prompt: the card field goes first in the schema and its line gains
  the consistency clause** ("— the same subject must always produce the same
  value") when it has no options; with options, the multi/conservatism
  clause identity carries today. The `identity` property leaves the schema;
  `record_fields` is fields only. Snapshot tests change accordingly.
- **D9 — `aiWork` loses its identity clause on both sides.** A card key is
  an extract field, so `fields.some(capability)` already covers it. Same for
  `mappingHasAiWork` in `utils.js`.
- **D10 — file face stays gated on a card key.** `collect()` emits the file
  face only when `card.by` is set (was: extract identity); clearing the key
  drops it, as flipping identity to filename does now.

## Stages

Each stage: close read → build → suite green → short ledger note here.

### Stage 1 — server contract, end to end (one stage on purpose)

The worker reads `mapping.identity` at three sites; validation, the source
table and the templates write it. These cannot ship separately without the
extract leg silently deriving nothing in between, so the server moves as one.

- `server/field-sources.js`: extract row gains `takesOptions: true`;
  `slots` shrinks — extract loses `"identity"`, connector loses
  `"identity"` (keeps `"face"`). Header comment: the card slot names a
  field, it binds no source. `aiWork` = fields only (D9).
- `server/server.js validateMapping`: the identity block becomes the card
  block (D3, D6: `by` must name an extract field in this mapping; refused
  with `input`). The options validation moves INTO the field loop, gated on
  `def.takesOptions` + `kind === "text"` (D2): array, ≤200, each `{value,
  hint?}`, dedup on `normaliseIdentity`. The reserved-key check for
  `identity` is deleted. `slotSources("identity")` has no reader left.
- `server/worker.js buildFieldsPrompt`: no `hasDerivedIdentity`. Fields are
  ordered card-first; each extract field renders one line and one schema
  property — `{why, value}` scalar or `{why, values: enum[]}` with options;
  the card field's line gets its clause (D8).
- `server/worker.js extractOne`: `needsLLM = extractFields.length > 0`. The
  landing loop handles options fields (filter to allowed keys, map to
  canonical spelling, dedupe, array). Identity resolution keys off
  `mapping.card?.by`: `raw = Array.isArray(v) ? v : v != null ? [String(v)]
  : []`, then the existing normalise/dedupe/resolve/reconcile path
  byte-for-byte. Display: canonical option spelling or the verbatim string,
  as now.
- Templates: `stocks/index.js`, `crypto/index.js`, the two test fixtures drop
  `identity: { source: "connector" }`. Manifests keep `identity: { label,
  blurb }` (the locked row's copy). `plugin-contract-plan.md` line ~459 (the
  template `identity` drift check in its Stage 2) needs a one-line update.
- **Migration 0052** (`card_key.js`), modelled on 0038: rewrites
  `boards.mapping` AND `items.payload.mapping` (the worker replays the
  stamp), idempotent (a mapping without `identity` passes through; a
  mapping with `card` passes through). Transform: `identity.source ===
  "extract"` → unshift field `{ key: "identity", kind: "text", source:
  "extract", instruction, options? }` + `card: { by: "identity" }`;
  `identity.source === "connector"` → drop; anything else → drop. The
  transform is defined in the migration file, not imported.
- Tests: `derived-identity.test.js` (13 slot builders + prompt tests),
  `extraction.test.js` (reserved-key test becomes "options on a number
  field → 400"; a new "card.by must name an extract field" pair),
  `field-sources.test.js` (aiWork, per-def rejections; the 0038 tests stay
  frozen), `faces.test.js` (14 builders, mechanical), `board-sort.test.js`
  (6), `connectors.test.js` (4), the rest one-liners. New `0052` tests
  mirroring the 0038 set (full convert, idempotent, both stores).

Close-read questions to answer before building: does anything read
`input.identity.why` (no — confirm); does `job_log` or `legLog` name the slot
(only the `identity` disposition word, which stays); does `backup.js`
carry mapping JSON through a shape check (it copies rows; confirm no
validation on restore).

### Stage 2 — client

- `public/mapping-modal.js`: `identityCfg` → `cardBy` (a string or null).
  `identityDefRow` → `cardDefRow`: connector board = locked row with the
  manifest blurb (unchanged); files board = a `defRow` whose `onOpen` opens
  an `openDropdown` listing "file" (pressed when null), each extract field by
  key, a separator, "+ new field" (opens `openFieldDrawer({mode:"new",
  source:"extract"})` and, on commit, points the card at the new key). No
  drawer for the slot. `openIdentityDrawer` deleted; `matchListBlock` +
  `optionRows` move into the extract arm of `openFieldDrawer` (the stash
  lives on the drawer's editor object, exactly as now), gated on a new
  `SOURCES.extract.options: true` and `draft.kind === "text"`.
  `fieldTile`: the card field's summary line leads with "card key ·".
  `faceDefRow` + `collect()` read `cardBy` (D10). `collect()`: the identity
  block goes; per-field options cleanup + dedup moves into the field loop;
  the `"identity"` reserved-key toast goes; a `cardBy` naming a field that no
  longer exists is dropped (D6 already toasted at removal).
  `applyTemplate`/`clearTemplate`: `identityCfg` lines → `cardBy = null`.
- `public/utils.js mappingHasAiWork`: fields only (D9).
- `public/sort.js identityFrom()`: `"extract"` ↔ `card?.by`, `"connector"`
  ↔ `input`, else null — same three-way catalog split.
- `public/view.js rowsRelevant`: `!!state.boardMapping?.card?.by`.
- CSS: none expected — the dropdown is `dropdown.js`, the mark is the tile
  summary. If the card mark wants a glyph, it's `srcDot`, not a new icon.
- Browser suite: the mapping-pane tests that open the identity drawer
  become "pick a field from the card dropdown" + "options block appears in
  the extract drawer for a text field".

### Stage 3 — verify in the real app

Memory rule: a hand-fed harness proves nothing here. On local compose:

1. Run 0052 against a copy of the local DB; list every board's mapping
   before/after; confirm the invoice board's identity became field
   `identity` first in the list with `card.by = "identity"`, and the stocks
   board lost its slot with no other change.
2. Invoice board: open the modal — Card row reads "one card per identity",
   the tile wears the mark; rename the field to `period`; save; re-extract
   one instance; the card title and the instance field row agree; the field
   row shows the `why`.
3. People board (the screenshot's): the options now live in the `person`
   field drawer; a photo with two people lands under two cards.
4. A new files board: Card row says "one card per file", face row locked;
   pick "+ new field" from the card dropdown, write `company`, confirm the
   card row follows and the face row unlocks; remove `company` — toast, card
   back to file, face row locked again.
5. Stocks board: Card row locked "each stock is its own card"; extract
   still runs for its extract fields if any.
6. Concurrency: upload six invoices for one month at once; one entity.

### Stage 4 — second pass

Fresh eyes on the diff, then a simplify pass. Known candidates: the client
`SOURCES` mirror gains a flag — check the server def and the client row
still line up field-for-field; `slotSources` may have one reader left
(face) and can inline; `hasIdentity(item)` in `utils.js` is entity-level and
should NOT have moved.

## Gains, plainly

- One drawer for one idea. ~130 lines of identity drawer + stash logic
  deleted; the options rows have one wearer.
- No reserved field key. No slot-level AI binding: `aiWork` is one clause.
- The card key's reasoning is stored and shown.
- "Match to a list" works on any text field, which is what the user asked
  for independently of the card.
- The source table's `slots` shrinks to the one slot that really binds a
  source (face).

## Risks and edges

- The migration touches every mapped board and every stamped item. Same
  blast radius as 0038, which shipped clean; same idempotency contract.
- A user who liked writing the identity instruction FIRST now writes a field
  first and points the card at it — two acts instead of one. The "+ new
  field" entry in the card dropdown collapses them back to one.
- D5's 13-field board. Expected count zero; measured in Stage 1.
- Options on a field whose value the tagger reads ("judging from its
  extracted fields below"): the dossier serialises arrays already (detect
  fields are arrays); confirm the field formatter joins strings sensibly.

## Stage 1 close read (2026-09-23)

Read against the code Stage 1 names, plus every reader of a stored field
value. Three findings change the build; the rest confirm it. Measured on the
local compose DB: 4 extract-identity boards (emma with 3 options; cars,
resumes, invoice without), 3 connector boards, 91 stamped items under the
extract boards, 56 under the connector ones, and the widest extract-field set
is 4 — D5's 13-field edge does not exist here.

### Findings that change the build

- **F1 — an array value IS the object-field discriminator today.**
  `objectKeysOf` (db.js:210) marks a field as detected objects when `v` is a
  non-empty array. It feeds the list payload's `objects` summary and both
  alert tag-set builders' `~objects/<key>` projection; the lightbox overlay
  (lightbox.js:148) and its field renderer (387, 406, 455) sniff the same
  shape. D2's "options make the value an array" would turn every answered
  list field into a phantom object field: an alert on `~objects` would fire
  on it, and the lightbox would try to draw its strings as boxes. **D11:** a
  list field's stored entry carries an explicit marker, `{ v: [...], why,
  list: true }`. `objectKeysOf` adds `&& !f.list`; the lightbox reads
  `f.list` to render chips and to keep the overlay away from it (Stage 2).
  A marker, not element-type sniffing, because an EMPTY list must still
  render as "none of the options" rather than fall through to the scalar
  path. Removed-field data lingering with the marker is harmless.
- **F2 — the tag dossier drops every non-scalar field** (worker.js:1911,
  `typeof v !== "object"`, written for box arrays). A list field would
  vanish from the tagger's "Extracted fields" text, and on a classify board
  that is the one field that matters. Stage 1 joins string lists: `key: a,
  b`; box arrays stay excluded (they are objects, lists are strings, and
  D11's marker is the cheaper test).
- **F3 — the landing loop would null an array.** worker.js:2612-2616
  validates by kind (`text → typeof v === "string"`) BEFORE anything looks
  at options, so a list answer would land as `{ v: null }`. The loop
  branches on `f.options` first: filter to the allowed set on
  `normaliseIdentity`, map to the option's canonical spelling, dedupe, land
  the array with `list: true`. The identity-specific `allowedByKey` map
  becomes that per-field helper. Then identity resolution reads the LANDED
  value (`fields[card.by].v`, an array or `[String(v)]`) instead of raw
  `input` — one canonicalisation, in one place, for card and non-card
  fields alike.

### Findings that confirm or sharpen the plan

- **F4 — the old client cannot be allowed to strip a card.** Between Stage 1
  and Stage 2 the pane still emits `identity` and never `card`; a save from
  it would silently reset a board to per-file. `validateMapping` therefore
  REFUSES a stray `identity` key (`mapping.identity moved to mapping.card
  — see planning/card-key-plan.md`) rather than ignoring it. Consequence:
  after Stage 1 the unit suite is green and the browser suite is not (its
  pane tests save through the old collect()); Stages 1 and 2 are one
  commit. The refusal also means every test that builds
  `identity: { source: "connector" }` on a connector board (connectors,
  faces, board-sort, ingest-connector, …) loses that line — one-line edits,
  ~19 files as counted.
- **F5 — backups convert themselves.** Restore replays migrations forward
  from the archive's schema id (backup.js:18-19), and validates nothing on
  the way in; an archive from before 0052 comes up through it. Nothing to
  do.
- **F6 — templates are not validated at load.** plugin-loader.js never looks
  at `template.identity`; the two fixtures still carry the pre-0038
  `identity: { from: "connector" }` and nobody noticed, which is the proof.
  Drop the line from stocks, crypto and both fixtures in the same stage, and
  fix the plugin-contract plan's Stage 2 note (line ~459) that describes the
  template `identity` shape.
- **F7 — the face slot was never server-required under extract identity.**
  The local invoice board has extract identity and NO face slot; the
  renderer's default (first instance) covers it. D10 is a client emission
  rule and stays one.
- **F8 — no other server reader of the slot.** Beyond aiWork, the prompt
  builder, extractOne and validateMapping there is none: connector add
  stamps `board.mapping` whole, the SQL routing predicates read only
  `face`, MCP/alerts/backup never touch `mapping.identity`. `slotSources`
  keeps its face reader — no deletion, the plan's line about it was wrong.
- **F9 — existing items have no value for the lifted field** until they are
  re-extracted (identity never landed in `payload.fields`). The card title
  still shows (it is the entity's name); the instance's fields row just
  lacks the `identity` line. Accepted; no backfill.
- **F10 — the six prompt tests map one-to-one.** `required[0] ===
  "identity"` becomes `required[0] === card.by`; the `- identity (text):`
  matchers become `- period (text): …`; the classify test moves its
  assertions from `properties.identity` to `properties.person`; the
  "options: [] stays scalar" test survives as a field test.

### Stage 1, corrected build list

1. `field-sources.js`: extract `takesOptions: true`; `slots` → extract none,
   connector `["face"]`; `aiWork` fields-only.
2. `validateMapping`: card block (D3, D6, F4 refusal of `identity`);
   per-field options (D2: text only, ≤200, dedup on normalised key).
3. `buildFieldsPrompt`: card field first; per-field `{why, values: enum[]}`
   for options, consistency clause on the card field (D8).
4. `extractOne`: F3 landing (options helper, `list: true`), F2 dossier join
   lives in the tag leg (worker.js:1911), identity resolution from landed
   values.
5. `db.js objectKeysOf`: `!f.list` (F1).
6. Templates + fixtures + plugin-contract plan note (F6).
7. Migration 0052 as planned; add a test that a lifted `identity` field
   lands first and the stamp copy matches the board's.
8. Tests: the prompt six (F10); new — list field lands canonical spellings
   with the marker; `objectKeysOf` ignores a list value; dossier line joins
   a list; validate refuses stray `identity`, options on a number field, a
   dangling `card.by`, `card` on a connector board.

Not pushable on its own (F4). Build Stage 2 on top, then the suite, then
the real-app checks, then one commit.

## Build ledger

**Stage 1 — built 2026-09-23.** As the corrected list, with these as-built notes:

- `extractFieldsOf(mapping)` (card field first) and `cardFieldOf(mapping)`
  are the two exported derivations in worker.js; the prompt builder and the
  extract leg both read them. `landListValues(field, values)` is the list
  landing helper; identity resolution reads the LANDED value (F3).
- `card.by` eligibility is stated off the table: a capability-backed source
  with scalar output — extract today, any future inferred scalar source
  without another branch.
- Options validation moved into the field loop, gated on the extract row's
  new `takesOptions` and on `kind === "text"` (D2).
- The dossier join (F2) tests `f.list`, not element type.
- Templates: stocks + crypto + both fixtures lost their identity line;
  connectors.test.js now asserts the template carries NO slot. The
  plugin-contract plan's template rule now says "no identity, no card".
- Tests: 20 files touched (unit suite 1853/1853 after the stocks manifest assertion followed the template). The identity prompt six became card-field tests;
  new coverage — `landListValues`, `objectKeysOf` with the marker, the card
  slot's six refusals, options refusals (number kind, detect source, dup,
  201), the stray-identity refusal (400 for extract/connector/empty, 200 for
  null), 0052 pure ×3 + `up()` against the DB (both stores, idempotent, and
  the migrated shape re-saves through the API), and one worker integration
  test in job-log.test.js: a list card field through the real extract + tag
  legs — canonical spellings + marker landed, two entities minted (the shell
  renamed in place), the tag request carries `person: Emma Stone, Emma
  Watson`, job row `moved` with 2 fields.
- Client tests that build `identity: { source: "extract" }` into client STATE
  (board-sort.test.js, instance-rows.test.js — sort.js/utils.js readers)
  were left for Stage 2, since the client code they exercise is unchanged
  until then. They pass today.

## Stage 2 close read (2026-09-23)

Read against mapping-modal.js, the three slot readers (utils, sort, view),
the lightbox's four array sites, the pane host, the tests that drive the
pane, and the frontend build. Two findings correct the plan; the rest turn
the stage's bullets into a build list.

### Findings that correct the plan

- **G1 — F4 overstated the suite breakage.** No browser test touches the
  mapping pane (test/browser/ has boot, card-faces, events, lightbox ×2,
  mcp-tab, plugin-modal, upload, welcome). The one pane test is jsdom-level
  ([board-modal-gate.test.js](../test/board-modal-gate.test.js)) with a
  mocked fetch, and it clicks the FACE row and a tile's ×, never the
  identity row. So after Stage 1 the whole suite is green and only the REAL
  app is broken (a pane save 400s). Two consequences: the "one commit" rule
  stands for the app's sake, not the suite's; and Stage 2 must ADD pane
  coverage the arc would otherwise ship without — in the gate test's
  harness: open the card row, pick a field → `mapping.card` rides the
  PATCH; pick file → it doesn't; remove the card field's tile → `card` is
  gone from the PATCH and a toast said so; open an extract tile, flip
  "Match to a list" on, add two options → `fields[i].options` rides.
- **G2 — the lightbox has FOUR array sites, not three, and no chip
  vocabulary to borrow.** `objectFieldsOf` (lightbox.js:148, feeds the box
  overlay) plus the three in `fieldsSection` (387 badge, 406 det-list
  render, 455 why-drop). `.tag-chip` is a card hover control, not a value
  chip; the pane's `.mm-chips` are pressed buttons. So a list value renders
  as joined text — `Emma Stone, Emma Watson`, the same line the tag dossier
  sees — through the existing scalar path, with a `list` badge where the
  `object` badge goes and the why KEPT (it is the model's reasoning, not a
  synthesized echo). An empty list is `—` with its why, like a null scalar.
  No new CSS. The overlay collector skips `f.list`.

### Build list, in order

1. **`public/utils.js`** `mappingHasAiWork`: fields only (D9 mirror).
   `hasIdentity` untouched (entity-level, still right).
2. **`public/view.js`** `rowsRelevant`: `!!state.boardMapping?.card?.by`.
3. **`public/sort.js`**: `identityFrom()` becomes the same three-way answer
   off the new slots — `"extract"` when `card?.by`, `"connector"` when
   `input?.connector`, else null — so `sortCatalog`/`validSort`/
   `restoreSort` don't change. Rename it `cardMode()` and rewrite the
   header comment, which still explains the menu by "identity source".
4. **`public/lightbox.js`**: G2's four sites.
5. **`public/mapping-modal.js`**:
   - state: `identityCfg` → `cardBy` (string | null); `snapshot()` and
     `opened` carry `card: cardBy ? { by: cardBy } : null`; `applyTemplate`
     stops reading `t.identity` (templates never set a card; connector
     boards have none) and `clearTemplate` nulls it.
   - `SOURCES.extract` gains `options: true` (the client mirror of
     `takesOptions` — the mirror comment lists the new column).
   - `identityDefRow` → `cardDefRow`: connector board unchanged (locked,
     manifest blurb); files board = `defRow` whose `onOpen` calls
     `openDropdown(row, { align: "start", width: "anchor", build })`. Rows:
     `file` (active when null, note "each file is its own card"), a
     separator, one `ddRow` per extract field (mono key, `active` on the
     current, trailing note = the format word or "N options" — NOT the
     instruction: `ddNote` has no ellipsis and a long instruction squeezes
     the label; the tile already shows the instruction), a separator, and
     `+ new field`. The def row's value line is "one card per file" /
     "one card per <key>", with the field's instruction (or its options
     joined) on the `more` line, as today's identity row does.
   - `+ new field` → `openFieldDrawer({ mode: "new", source: "extract",
     thenCard: true })`; the drawer's commit sets `cardBy = draft.key`
     when the flag is on. Editing the card field's KEY in the drawer moves
     `cardBy` with it.
   - `fieldTile`: the sum string is prefixed `card key · ` for the card
     field. Plain text — the tile's summary is a string, and no CSS is
     needed for a word.
   - `fieldTile` remove: if the removed field was the card, `cardBy =
     null` and a default (dark) toast: `One card per file again — <key> was
     the card key`.
   - `openIdentityDrawer` deleted. `matchListBlock` + `optionRows` move
     into `openFieldDrawer`'s open-source arm, shown when `def.options &&
     (draft.kind || def.kinds[0]) === "text"`; the drawer's editor becomes
     `ed = { draft, stash }` (the stash is drawer-session scratch, as
     now); the on-flip restore reads the ORIGINAL field's options rather
     than `identityCfg`; picking a non-text format stashes + deletes the
     options and the format hint says why.
   - `faceDefRow`: the file face is configurable when `cardBy` is set.
   - `collect()`: the identity block and the reserved-key toast go;
     connector boards emit no identity; options are cleaned in the field
     loop (trim, drop valueless, dedupe on the normalised key with the
     "two options mean the same thing" toast, hint ≤500, an ON toggle with
     nothing usable blocks); `card` is emitted only when `cardBy` names an
     extract field still in `outFields` (a dangling pointer is dropped
     silently — the removal already toasted); the file face is emitted only
     under `card` (D10).
6. **Tests**: instance-rows.test.js (mappingHasAiWork, rowsRelevant) and
   board-sort.test.js (6 state builders + the raw DB write at :116) move to
   the new shapes; the gate-test additions from G1.
7. **Build output**: `public/dist` is gitignored and the app IMAGE serves it
   (`STATIC_DIR=/app/public/dist`, Dockerfile:50); host dev and the suite
   serve `public/`. Stage 3's real-app checks therefore run after
   `docker compose up -d --build app`, or they verify the old client.

### Confirmations

- The pane host (board-modal.js) reads only `isDirty/snapshot/collect`;
  nothing there names the slot.
- `filters.js` builds `~objects` chips from DECLARED detect fields, so a
  list field never grows a chip client-side either.
- `data.js`, `rows.js`, `grid.js`, `patterns.js`, `search.js` read entity
  fields or the entity's identity string, never instance field values.
- No CSS change is needed anywhere in the stage.
- Changing the card key on a board with items behaves as changing identity
  did: stored cards stay until re-extract (extract's refill is manual).
  Unchanged, and worth a sentence in the toast? No — the pane never said it
  before either; the Re-extract affordance is where that lives.

**Stage 2 — built 2026-09-23.** As the close read's build list, with these
as-built notes:

- The card menu is body-mounted (dropdown.js), OUTSIDE the dialog the host's
  save gate listens on, so a pick dispatches a bubbling `change` on the pane
  container to arm Save. A drawer commit needs none of that — its button is
  inside the dialog. Caught by the new gate test on first run (Save stayed
  dead after a pick).
- `cardField()` is the pane's one dereference of the pointer (a dangling
  `card.by` written by the API reads as per file, and `collect()` drops it).
- `formatGroup` takes the drawer's editor object now: leaving the text
  format stashes the options and hides the list block (refresh); coming back
  restores them. Every other format pick still flips in place.
- The lightbox's list rendering is the joined line through the scalar path,
  `list` badge, why kept; the overlay collector skips `list`. Zero CSS.
- Tests: instance-rows (2) and board-sort (6 + the raw DB write) moved to
  the card shape; board-modal-gate gained a `CARD_BOARD` fixture (`b3`) and
  four tests — pick a field → `card` + file face ride the PATCH; pick file →
  neither; remove the card field → `card` gone, row reads per file; "Match
  to a list" on a tile → `options` ride. The toast on removal is NOT
  asserted: toast.js caps visible toasts at three and the file's earlier
  saves hold the slots for 4.5s, so it queues — the row text is the check.
- Nothing pushed; the arc is one commit after Stage 3.

**Stage 3 — verified 2026-09-23** on the rebuilt compose image (Playwright
driving http://localhost:8001 with a real admin session; zero console
errors across every page; screenshots in the session scratchpad).

1. **Migration.** Boot log: `migration 0052: rewrote 7 board mapping(s)`,
   `147 stamped item mapping(s)`. After: 0 stamps carry `identity`, 91 carry
   `card`; the 4 extract boards (cars, emma, invoice, resumes test) have
   `card: { by: "identity" }` with `identity` first in fields; the connector
   boards have no slot; per-file boards untouched.
2. **Invoice board.** Card row read "one card per identity" with the
   instruction on its detail line; the tile led with "card key ·"; the face
   row was unlocked ("the first image added"). Renamed the field to `period`
   in the drawer — the row followed ("one card per period"), Save went out,
   GET returned `card: { by: "period" }`, `period` first, file face kept.
   Re-extracted ALL 12 entities at once (13 instances, real model): 13
   extract rows `ok`/`derived`, 13 tag rows `ok`; `fields.period` landed
   with its why on every item; the entity set converged to the SAME 12
   (June - 2026 still holding 2) — the concurrency check (D-list item 6) in
   one go. Lightbox: Details shows the `period` row with its reasoning
   under AI-extracted fields.
3. **Emma board.** Card row: "one card per identity · Emma Watson · Emma
   Roberts · Emma Stone"; the tile sum reads "card key · AI extraction · one
   of 3 options · …"; opening the tile shows "Match to a list" ON with the
   three options in the drawer. Re-extracted instance 5243 (real model):
   landed `{ v: ["Emma Watson"], why, list: true }`, membership stayed
   under Emma Watson; job row `derived`, 1 field. Lightbox: the `identity`
   row wears a `list` badge, reads "Emma Watson", keeps the why; no
   `object` badge; the box overlay is empty.
4. **A new files board** (`card-key-verify`, created + deleted via the API).
   Card row "one card per file", face row locked. The menu offered "file /
   + new field" (no extract fields yet); "+ new field" opened the drawer
   headed "AI extraction · the card key"; after `company`, the row read "one
   card per company · the company that issued it", the face row unlocked,
   the tile led with "card key ·". Removing `company` put the row back on
   file, re-locked the face, and toasted "One card per file again — company
   was the card key".
5. **Stocks board.** Card row locked: "each stock is its own card".
6. See 2 — the concurrent re-extract of a whole board is the six-at-once
   check with 13.

Side effect of the check: the user's invoice board's card field is now
named `period` (the plan's own step). Nothing else on the data changed
beyond re-extraction.

**Simplify pass — 2026-09-23** (4 agents: reuse, simplification, efficiency,
altitude; 12 findings applied after dedupe, 4 skipped). Efficiency came back
net-neutral. The two that changed a mechanism:

- **The list marker moved into the `kind` column.** `list: true` was a
  third ad-hoc spelling of "what shape is this value" next to file fields'
  `{ v, src, kind }`. A list lands as `kind: "list"`; `objectKeysOf`, the
  dossier join and the lightbox all read the column that already existed.
  D11 amended accordingly.
- **A closing dropdown tells its anchor.** The card pick's hand-dispatched
  `change` was a bandaid: the template menu and the catalog chips are
  body-mounted too and commit in-menu, and neither could reach the save
  gate. `dropdown.js close()` now dispatches a bubbling `change` on a
  still-connected anchor on every close — the gate re-reads and compares,
  so a menu that changed nothing arms nothing. The pane's dispatch is gone.

One-spelling consolidations: `keysCards(def)` in field-sources.js is the
card-eligibility rule for both validateMapping and `cardFieldOf` (the
validator used to derive it, the worker used to say `"extract"`);
`hasOptions` exported from worker.js and used by the prompt, the landing and
the tests; extractOne reads `extractFieldsOf`; the two schema branches
collapsed to one wrapper around a `value`/`values` slot; the prompt reads
`card.by` directly instead of a second lookup; validateMapping gained the
general `unknown mapping key` rule the stray-identity refusal now rides on
(with its pointer message kept); on the client, `isCardField`/`cardField`/
`cardSlot`/`formatWord`/`menuGlyph` each replace two or three spellings, the
drawer's `ed.kind()` replaces four `(draft.kind || def.kinds[0])`, and the
gate test's `click()` helper serves its twelve older sites too.

Skipped: a client `cardKeyOf(mapping)` helper (three one-line optional
chains are not worth an import), promoting the test fixture literal across
ten files, the double normalisation of a list card value in the extract leg
(one canonicalisation path is the documented design), and the migration's
per-row UPDATE (0038's pattern, narrower predicate, one-time).

After the pass: unit 1857/1857, browser 52/52 (the welcome redirect test
flaked once under the two suites running side by side, as the memory notes
it does, and passed alone). One test needed its intent restated: the
ingest-connector "no-op mapping edit" used a decoy `context` key inside the
mapping to mean "unchanged"; the unknown-key rule refuses that now, so it
drops one field instead — a real edit that keeps the input, which is what
the test was about.

## Stage 5 — the key changed; the cards didn't (planned 2026-09-23)

**Status: PLANNED, nothing built.** Close read first, as every stage.

### What happened

On the emma board the user added a second list field, pointed the card at
it, saved — and the two cards stayed exactly as they were. Reprocessing the
board regenerated them. Then pointing the card back at `identity` and saving
again changed nothing either. Both are the code doing what it does, and the
Stage 1/2 close reads never asked the question: **what happens to the cards
that already exist when the pointer moves?**

Entities are GENERATED: a materialised table, written in exactly two places —
the upload shell at admission, and the extract leg's identity resolution when
the stamped mapping names a card field. A mapping save runs the field
reconcile (file: re-project, connector: strip + sweep, extract: manual) and
never touches membership. So a pointer change is inert until a reprocess
re-derives every instance through the resolver. That is the right model —
cards carry hearts, crate places, alert baselines and faces, and
regenerating them is destructive — so the save must NOT regenerate anything
(one regroup-on-save design was considered and rejected 2026-09-23: a save
that silently merges and splits cards is the wrong place for a destructive
act; reprocess is the explicit one, and it already exists).

What is missing is (a) the reminder, and (b) one branch that makes the
reminder a lie.

### The reminder — a second toast on save

When a save carried a mapping whose `card` differs from the one the modal
opened with, the normal save toast fires as today, and then a SEPARATE info
toast (`toast.info`, the blue one) says what the reader needs to know:

- key → key: `Cards were generated from \`identity\`. Reprocess the board to
  generate them from \`who_is_she\`.`
- key → per file: `Cards were generated from \`identity\`. Reprocess the
  board to make each file its own card.`
- per file → key: `Each file is its own card today. Reprocess the board to
  generate cards from \`who_is_she\`.`

It carries a **Reprocess** action — the toast component's `actions` slot,
the affordance upload.js already uses for Dismiss/Cancel — which fans the
per-entity `POST /api/items/:id/reprocess` out over every entity on the
board, the way bulk.js's `doBulkReprocess` does over a selection (reuse
that fan-out; there is no board-level reprocess route and this stage does
not add one — a client fan-out over the listed entities is what the bulk
bar already is). The action then reports the way the bulk one does
("Reprocessing N items…"). Where it lives: the board modal's save path
(board-modal.js), which owns the save toast and knows the pane's opened vs
collected mapping; the pane exposes nothing new — the host compares
`opened.card` with the saved `card`. Duration: medium-plus or sticky-until-
acted? The close read decides; the default `info` duration (4.5s) is short
for a sentence with a verb in it.

Blue, not the default dark: the memory's toast rule reserves colour for
"genuinely notable events", and "your cards are stale until you act" is one.

### The fix — per file must split

The extract leg's no-card branch (worker.js `else { stampExtracted }`) lands
fields and leaves membership untouched. Under "one card per file" that is
wrong for any item sharing an entity: reprocessing after moving the card to
per file would leave the old groupings standing forever, and there is no
other way back (instance removal is the only split today). The branch
becomes: if the item's entity has other instances, mint it its own entity —
identity = the stored filename, display name null, exactly the upload shell
— move it there, reconcile (the emptied entity is deleted by the same
reconcile the card branch uses). A sole-instance item is already its own
card: nothing to do, hearts and crate place intact. Guarded on `!mapping.
input`: a connector board has no card slot and its vehicles are sole by
construction, so the branch stays a plain stamp there.

The card branch's own "model returned nothing → keep membership"
(`disposition: "kept"`) stays as is: that is one item lacking evidence on a
re-run, not the board's key changing.

### Not doing

- **No regroup on save** (above). **No rename carry**: a renamed key followed
  by a reprocess regenerates the values, so nothing needs moving; the stale
  values under the old key are the pre-existing "renamed extract field
  orphans its values" wart, not this stage's.
- **No confirm dialog, no pending-state warning line** in the pane: the save
  is not destructive any more than it was; the destructive act is the
  reprocess the user chooses, and the toast names it.

### Open for the close read

- **Display-name casing.** Both emma entities now read lowercase: the last
  derivation ran under the open-ended field, the model answered lowercase,
  and "latest derivation wins the display name" overwrote the cased names
  (`setEntityIdentity` COALESCEs only on null). The original derived-identity
  plan kept a cased name when the new answer was all-lowercase and the rule
  was dropped. Decide: restore it (a list field's canonical spelling should
  probably ALWAYS win, since the user typed it), or leave latest-wins.
- The toast's duration/stickiness, and whether the action also closes it.
- Whether the toast should fire when only the card field's OPTIONS changed
  (values may be stale too). Probably not — the pointer is the event.

### Stage 5 close read (2026-09-23)

- **H1 — the casing is not a bug.** The emma board's second list field
  declares its options in lowercase (`emma watson`, …); latest-wins wrote the
  user's own spelling. A list field's display IS its option's spelling,
  always (landListValues), so nothing to restore. Closed.
- **H2 — the Reprocess action wants a board route, not a client fan-out.**
  The board modal also opens from boards.html and admin.html, where no item
  list is loaded, so bulk.js's fan-out has nothing to fan over there. A
  `reprocessBoard(db, boardId, engine)` is `reprocessEntity`'s statement
  under a `board_id = $2` scope (the retag verbs already have a board form);
  the route is `POST /api/admin/boards/:id/reprocess` (admin, beside retag),
  resolving the transcriber once per board the way the entity route does
  when any instance carries a transcript stamp; it answers `{ ok, queued }`.
  The gallery learns of it through a document event (`app:board-reprocessed`,
  beside data.js's `app:uploads-pending-tag`) that starts the status poll —
  board-modal.js must not import data.js's polling into the boards and
  admin pages. bulk.js keeps its own fan-out: it acts on a selection.
- **H3 — the toast is sticky with a Dismiss, like the upload-failure toast.**
  `toast.info(msg, { duration: null, actions: [Reprocess, Dismiss] })`. The
  reminder is the one thing the save needs the reader to see, and the
  precedent for "you may not be looking when it lands" already chose sticky
  + Dismiss (upload.js). Reprocess closes it too.
- **H4 — under per file, sole cards reset to the shell as well.** A card that
  is already alone keeps its id (hearts, crate place intact) but its name
  goes back to the stored filename with no display name — so a per-file
  board looks like one, uniformly (no title strip on some cards and not
  others). One db helper (`resetEntityToShell`: identity = file name,
  display_name null, symbol null, provisional false); the shared case mints
  a shell + moves + reconciles in one tx like the card branch. Disposition
  `moved` when membership changed, else nothing new to log. Guards: no
  input on the stamped mapping, and a file on the item.
- **H5 — when the toast fires.** Only on an existing board WITH items
  (`board.has_items`), only when the mapping rode the save (the pane was
  dirty), and only when `card.by` differs between the mapping the modal
  opened with and the one it saved (null on both sides = per file). A new
  board never; a card-key rename never (same pointer key? — no: a renamed
  key IS a different `by`; the reminder is right there too, the values under
  the new key don't exist until reprocess).
- **H6 — wording**, key in backticks (the toast is plain text; the mono chip
  question is the pane's, not the toast's):
  key→key `Cards were generated from identity. Reprocess the board to
  generate them from who_is_she.` · key→file `Cards were generated from
  identity. Reprocess the board to make each file its own card.` ·
  file→key `Each file is its own card. Reprocess the board to generate
  cards from who_is_she.`
- **H7 — tests.** db: `reprocessBoard` routes mapped items to
  pending_extract and plain ones to pending, board-scoped only. Route: admin
  200 + queued count, non-admin 403, unknown board 404. Worker (job-log
  harness): a no-card mapping with one extract field; one entity holding two
  instances and one sole entity with a derived name; after the run every
  item is its own entity named by its file, display null, the sole one's id
  unchanged. Gate test: change the card on `b3` → after Save an info toast
  names both keys and its Reprocess action POSTs `/api/admin/boards/b3/
  reprocess`; an unchanged card → no info toast; a new board → none.
- **H8 — where in the client.** board-modal.js's save handler: `cardBefore`
  read off `board.mapping` at open; `cardAfter` off the collected payload
  when the pane rode along; the toast after the save toast. mapping-modal.js
  is untouched by this stage.

Build order: db helpers (`reprocessBoard`, `resetEntityToShell`) → the
worker's no-card branch → the route → the client toast + the event → tests.

**Stage 5 — built 2026-09-23.** As the close read's build order, with these
as-built notes:

- `reprocessEntity` and the new `reprocessBoard` share one statement
  (`reprocessSql(scope)`, the reextractSql/retagSql pattern); the board form
  returns the row count. `boardHasTranscriptStamp` mirrors the entity check
  so the route resolves the transcriber only when a stamp exists.
  `resetEntityToShell` is the one new entity write: identity = file name,
  display/symbol null, provisional false, id kept.
- The worker's no-card branch: sole → reset in place when the name isn't
  already the file's; shared → shell + move + reconcile in one tx, logged
  `moved`. Guards: no `input` on the stamped mapping, a file on the item,
  an existing membership.
- Route `POST /api/admin/boards/:id/reprocess` beside retag: admin, 404 on
  a missing board, `{ ok, queued }`, cache invalidated.
- board-modal.js reads `cardBefore` off the opened board and compares with
  the collected mapping's `card.by` only when the pane rode the save
  (`"mapping" in payload`), on an existing board with items. The reminder is
  `toast.info` sticky with Reprocess + Dismiss; Reprocess posts the route,
  toasts "Reprocessing N items…" and dispatches `app:board-reprocessed`,
  which data.js turns into `ensurePolling()` + a render on the gallery.
- Tests: `reprocessBoard` board-scoped + the route (derived-identity);
  worker run with no card over a shared pair and a sole derived card → three
  file-named cards, sole id kept, no ghost (job-log, real text files on disk
  so the extract leg reads material); gate: key→key reminder names both keys
  and Reprocess posts the board route and closes it; key→file wording +
  Dismiss posts nothing; same-pointer edit and a no-items board get none.
  Two toast.js facts the gate tests had to learn: a sticky toast is never
  queued and dedupes a repeated message while one is up, and one with
  actions retires only through them — the drain presses Dismiss.
- Not verified in the real app yet (the compose image predates Stages 4–5;
  rebuild before the next look).
- **Two additions after the first suite run.** (1) The concurrent split
  leaves a ghost: two instances leaving one card at once each see the other
  inside their own transaction, so neither reconcile deletes it and it
  commits empty — the card branch has the same window and leaves it to
  reapEmptyEntities, but a dissolve that shows a blank card until the sweep
  is exactly what this branch exists to prevent, so it runs
  `deleteEmptyEntities(oldIds)` once more after the commit. The test's
  "which file keeps the old id" assertion was dropped as order-dependent
  (nothing hangs on it: a card shared by two files has no one file to carry
  its hearts to). (2) The pane's card row now reads **"generate one card per
  `period`"** / "generate one card per file" — the verb says the dependency
  runs from the field to the cards, and the key wears the tile name's mono
  with no fill (a filled chip inside a row that is itself a button would
  read as a second control). Agreed 2026-09-23, dropped from the first cut
  of the stage by mistake; connector rows keep the manifest's own words.
- **Seen live 2026-09-23, two corrections.** The reminder drops its first
  sentence — "Reprocess the board to generate cards from who_is_she." is the
  whole of it. And the two actions stacked: `.toast-actions` had never been
  styled (every toast carried one action), so as a narrow flex item its
  inline buttons wrapped; it is a flex row now (toast.css).
