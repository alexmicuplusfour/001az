# Field sources — one source model for the mapping

**Status: ALL THREE SLICES SHIPPED locally 2026-08-22 (uncommitted), full
suite green (1180).** Server core, client call-sites, and the pane rebuilt
(tiles + bottom drawer + per-capability bands) per this contract. Notable
as-built deviations: the pane's dirty flag flips on drawer COMMITS rather than
drawer keystrokes (drafts are discardable); connector boards' collect() always
emits `identity: {source:"connector"}`; detect is offered on file boards only
(no client-side media-kind gating); `setBands` replaced `setExtractionBand`
outright — no alias kept, board-modal (its only caller) converted in the same
commit. Prototype agreed (see the artifact
iterations, 2026-08-20); this document is the implementation contract.
Self-contained for a fresh session.

**Consolidation pass, same day.** The pane's client `SOURCES` table absorbed the
structural facts it had been branching around (`catalog`, `kinds`, `ask`,
`refreshable`, `filesOnly`, `cap`), so the three remaining places that
enumerated sources by name now read the table instead: `collect()` emits each
field's wire shape from its row, the field drawer composes its controls from it,
and the add menu lists the open sources by looping it. A new source is a row
here plus a row in `field-sources.js`. Alongside that: the pane's eight parallel
`connectorX` variables became one `conn` row from `/api/connectors` bound
through a single `bindConnector()` (the fetch, a template apply and a template
clear had each carried their own copy of that assignment block), the four
drawer commits share one `commit(write)`, and `instructionGroup`/`objectsGroup`
became one `askGroup` reading the source's own copy.

## Why

The mapping expresses one idea — *where a value comes from* — four separate
times with three different value sets: `identity.from` (raw/ai/connector),
`face.from` (raw/connector/file), `fields[].from` (ai/connector/file), plus a
fourth source hiding inside a kind (`kind:"object"` = the detector). Everything
that actually varies by source (cadence, catalog-locked keys, entity vs instance
scope, which capability runs it) is re-derived by hand at ~50 sites across 15
files. This is the last unconverted switch→table in the codebase — the same
conversion `capabilities.js` documents for capabilities ("NO consumer may name a
capability; they iterate this table"), which exists because hand-enumerated
switches *demonstrably* rot (detect was missed by both cleanup loops).

User-visible symptoms fixed: the Mapping pane's "Using <model>" band claims the
extraction model runs object detection (it doesn't — the detect capability
does); three sections with three different add/remove affordances; `raw`
meaning a different thing per slot.

## The new shape

```js
mapping = {
  input:    { connector } | (absent = files),
  identity: { source: "extract", instruction, options?: [{value, hint?}] }
          | { source: "connector" }
          | null,                                  // = the filename (was from:"raw")
  face:     { source: "connector", producer, period, refresh?: {every} }
          | { source: "file", prefer, pick }
          | null,                                  // = symbol tile fallback (was from:"raw")
  fields: [
    { key, kind, source: "connector", fn, refresh?: {every} },
    { key, kind, source: "file",      fn },
    { key, kind, source: "extract",   instruction? },
    { key,       source: "detect",    instruction? },   // no kind — output is boxes
  ],
}
```

Renames, uniformly: `from` → `source` (`"ai"` splits into `"extract"` /
`"detect"`), `hint` → `instruction`, `candidates` → `options`,
`live: true, every: N` → `refresh: { every: N }` (`live` was always just
`every > 0`). `from:"raw"` dies: it was never a source — it meant "this slot's
default", a different thing per slot. `kind:"object"` dies: detection is a
source, not a shape of text. `MAPPING_KINDS` shrinks to text/number/url/date
(`url` keeps its id; the UI labels it "link"). **`input: "files"` dies too** —
the same two-spellings disease as `raw` (absent and the literal string both
mean files, accepted at 5 sites in server.js); the migration normalizes it
away and the validator accepts only absent | `{connector}`.

**What `null` means (so `raw`'s ambiguity doesn't sneak back in):** a null slot
is *absence of configuration* — the renderer's per-slot default applies
(identity: the filename; face on a file board: the file preview; face on a
connector board: the symbol tile). The difference from `raw` is that nothing
pretends to be a source, no slot stores a word whose meaning shifts per slot,
and the defaults live with the renderers that implement them
(`selectFace` already treats a non-`file` face cfg exactly this way).
The `identity` reserved-key rule (a field may not claim the key `identity`)
is unchanged.

Payload VALUES are untouched: `payload.fields` stays `{v, why}` / `{v, src,
kind}`, `entities.fields` stays `{v, src, at}`. Field keys don't change, so no
item data moves. Only mapping JSON (boards + stamps) is rewritten.

## The source table — `server/field-sources.js`

New pure-data module, sibling and stylistic twin of `capabilities.js` (no
imports; consumers iterate, never name):

```js
export const FIELD_SOURCE_DEFS = [
  { id: "connector", scope: "entity",   catalog: "connector", needsFn: true,
    refreshable: true,  capability: null },
  { id: "file",      scope: "instance", catalog: "media",     needsFn: true,
    refreshable: false, capability: null, filesOnly: true },
  { id: "extract",   scope: "instance", catalog: null, takesInstruction: true,
    refreshable: false, capability: "extract", cap: 12,
    kinds: ["text", "number", "url", "date"] },
  { id: "detect",    scope: "instance", catalog: null, takesInstruction: true,
    refreshable: false, capability: "detect", appliesTo: ["image"],
    output: "occurrences", locator: "box" },
];
export const FIELD_SOURCE = Object.fromEntries(DEFS.map(s => [s.id, s]));
```

`capability` is a foreign key into `CAPABILITY_DEFS` — that's what makes
provenance generic (the pane asks the registry who runs each source in use).
`output`/`locator` are forward declarations for face/voice matching: a future
source is one row here + one entry in `CAPABILITY_DEFS`. **No new endpoint**:
the defs drive server validation; the pane keeps its own small presentation map
(labels, helpers, glyphs — UI copy and SVG don't belong on the wire), and
availability comes from feeds that already exist (`/api/connectors`, the
capability feed the board modal already consumes). A `GET /api/field-sources`
becomes worth it only when a plugin can install a source; note it there, don't
build it now.

The cap moves into the defs and gets honest: `cap: 12` on **extract** counts
extract fields only — today's validator counts object fields against the 12
even though they never reach the extraction schema (worker.js:506 excludes
them), which was accidental over-strictness. `detect` gets its own `cap: 12`
(each field adds detector queries; same order of sanity).

Domain manifests gain identity copy in the domain's own words (users never see
the word "connector"):

```js
// crypto/index.js manifest
identity: { label: "Coin",   blurb: "each coin is its own card" },
// stocks/index.js manifest
identity: { label: "Ticker", blurb: "each stock is its own card" },
```

## Migration — `0038_field_sources.js`

JS migration (precedent: 0007 rewrote mappings AND stamps; 0035 rewrote faces).
One pure `transformMapping(m)` defined IN the migration file (migrations never
import app code), old→new per the table above. Idempotent: a mapping already
carrying `source` keys passes through untouched.

1. `SELECT id, mapping FROM boards WHERE mapping IS NOT NULL` → transform in JS
   → `UPDATE`. (Row count is small.)
2. The stamped copies: `SELECT id, payload->'mapping' FROM items WHERE payload
   ? 'mapping'` → transform → `UPDATE items SET payload = jsonb_set(payload,
   '{mapping}', $2)`, batched. **This is the step that bites if missed** — the
   worker's extract replay ([worker.js:2042](../server/worker.js#L2042)) and
   four SQL routing predicates in db.js read the stamp.
3. Face-slot special case: `face:{from:"raw"}` → `null` (0035 already coerced
   finance boards onto the chart; only file boards can still carry it).
4. `input: "files"` → key removed (absent = files).

Restore compatibility is free: archives from older versions rebuild at their
recorded schema version then migrate forward, so 0038 converts them on restore.

## Server call-site conversion (complete inventory)

A small helper in field-sources.js keeps conversions honest:
`aiWork(mapping)` = `identity?.source === "extract" || fields.some(f =>
FIELD_SOURCE[f.source]?.capability)` — replaces the four hand-copies of the
"has AI work" gate.

- **server.js** — `validateMapping` (1602-1711) rewritten as a loop over
  `FIELD_SOURCE_DEFS`: per-def checks replace the if-chain (needsFn, kinds set,
  instruction length, refreshable gate, filesOnly gate, cap). Slot validation
  reads the same defs. Also: 834-835 / 926 / 1072 (passthroughs, unchanged),
  1157 (schedule args unchanged), 1159, 1540-1541, 1719, 1749, 2602-2679
  (`input.connector` reads unchanged).
- **worker.js** — 506 (`f.source === "extract"`), 507-513 (`identity?.source
  === "extract"`, `.instruction`, `.options`), 514/527/586 (`instruction`),
  1155 (detect queries off `f.instruction`), 2042-2061 (`aiWork(mapping)`;
  aiFields split becomes `source === "extract"` vs `source === "detect"`),
  2121, 2124-2135 (drop the `kind === "object"` skip — detect fields aren't in
  the LLM loop at all anymore), 2178-2187 (`identity.source`, `options`).
- **db.js** — 779-784 `aiMappingJson` → uses `aiWork`; SQL predicates at
  1486-1489, 1551-1554, 1578-1581, 2611-2614:
  `payload->'mapping'->'face'->>'from' = 'connector'` → `->>'source'`.
  Opportunistic consolidation while touching them: 1486/1551/1578 are three
  *identical* copies of the face-routing predicate — extract one shared SQL
  fragment constant. 2611 stays separate on purpose (its `COALESCE($3, stamp)`
  + generated-file check is a documented divergence, preserved as-is).
- **connectors/schedule.js** — `liveFields`: `f.source === "connector" &&
  f.refresh`, `every` reads `f.refresh.every`; `faceSchedule`:
  `face?.source === "connector"` → `face.refresh ? {every} : {first: true}`.
  Consumers (db.js 54-56/2549-2581, runtime 392, worker 767/776/790/2303,
  add.js 46) are shape-blind through these two — no change.
- **connectors/add.js** — 22: `face?.source === "connector"`.
- **connectors/runtime.js** — 431-440 reads `faceCfg.producer/period`
  (names unchanged). 271/283 `from:"provider"` is manifest-filter namespace,
  NOT mapping — untouched.
- **media/index.js** — 79: `f.source === "file"`. (Output `{v, src:"file"}` is
  payload-value namespace — untouched.)
- **faces/select.js** — 21: `faceCfg?.source === "file"`.
- **ingest.js** — 72 (unchanged), 80-82 → `aiWork(board.mapping)`.
- **connectors/{crypto,stocks}/index.js** — templates rewritten to the new
  shape; `identity: {label, blurb}` added to both manifests, and shipped to the
  client on the existing `/api/connectors` payload (the pane's locked identity
  row reads it — users never see the word "connector").

## Client call-site conversion

- **data.js** 206-209 — `f.source === "connector" && f.refresh`;
  `face?.source === "connector" && face.refresh`.
- **utils.js** 95-97 — `mappingHasAiWork`: `identity?.source === "extract" ||
  fields.some(f => f.source === "extract" || f.source === "detect")`.
- **view.js** 79 — `identity?.source === "extract"`.
- **filters.js** 398-400 — declared object keys: `f.source === "detect"`.
- **face-select.js** 12-14 — `source === "file"` (keep byte-parity with the
  server mirror).
- **sort.js** 31/71-76/178/200-206 — `identityFrom()` becomes
  `identity?.source ?? null`; the three modes are `null` (was "raw"),
  `"connector"`, `"extract"` (was "ai"); connector field filter reads
  `f.source`.
- **app.js/state.js/toolbar.js/rows.js/lightbox.js/boards.js** — shape-blind
  (passthroughs, `input.connector`, derived columns) — no change.

## The pane rebuild — `mapping-modal.js`

Wholesale rewrite to the agreed prototype (zero direct test coverage; the only
contract is the host API). Preserved contract with board-modal.js:
`buildMappingPane({container, isAdmin, mapping, hasItems, onExtractionChange})`
→ `{isDirty, collect, setExtractionBand}`; `collect()` → `{ok, payload:{mapping}}`
emitting the NEW shape; host save fold untouched.

Agreed design (from the prototype iterations):
- **identity + face**: definition rows above the fields — glyph, small mono
  label, plain-language value line. One click opens the drawer; source cards
  (horizontal) live INSIDE it. Connector boards: identity is locked prose in
  the domain's words ("each coin is its own card"), no chevron, no drawer.
  Face offers no symbol-tile option (the tile is the fallback, not a choice).
- **fields**: uniform tiles — source glyph, mono key, one-line summary,
  always-visible ×. Violet tint + glyph = a model produces it (extract,
  detect); grey = deterministic (file, connector). Selection states are the
  app's black (`--pill-active`); violet is ONLY the AI marker.
- **add flow**: `+ Add field` → dark `openDropdown` menu (source name left,
  "AI reads…"/"no AI —…" helper right; catalog sources expand fn chips that
  add instantly; open sources proceed to the drawer, ended by **Add field**).
- **the drawer**: full-width, bottom-aligned sheet inside the modal body, over
  a scrim; edits buffer a draft; commit buttons only ("Add field" / "Done");
  Esc/scrim/Cancel discard. Drawer titles mono. Groups: "Key", "Format"
  (chips), "AI instruction", "Object to detect", "Match to a list" (switch —
  reuse `.switch`/`switch-row`), "Prefer (when available)" (chips + select),
  cadence, chart range.
- **provenance**: one line per capability in use, derived by walking bindings
  → `FIELD_SOURCE[..].capability` — never hardcoded. Requires: capabilities.js
  `detect` gains `mappingBand: true`; board-modal's band push generalizes from
  `caps.find(c => c.mappingBand)` to a filter, and the pane API becomes
  `setBands(map)` (setExtractionBand kept as an alias during the change).

CSS: new classes only, no overrides — `.mm-row--ai` tint, source glyph set
(extend `ICONS`), format/prefer chips, horizontal source cards. **One
deliberate recolor**: `.mm-connector-badge` (#4f46e5 indigo) goes neutral grey
— purple now means "AI", and the connector is the one source with none. Add
`--ai-ink`/`--ai-bg` tokens next to the `--pill-*` tokens rather than
scattering hex. `dropdown.js` `ddRow` gains an optional right-aligned
`trailing` note.

## The drawer — a generic component, not pane furniture

The bottom sheet is a reusable primitive in `modal.js`, sibling of
`createModal`/`provBand`/`keepPlace` (every prospective user is a modal, and
both pages already load modal.css, where its styles go — `.drawer`, `.drawer-
scrim`, head/body/foot). Dependency-free vanilla DOM like everything else in
`public/`. The pane is its first consumer, not its owner.

```js
// modal.js
export function createDrawer(hostEl)   // once per modal body; hostEl becomes
                                       // position:relative, gets scrim + sheet
// returns:
{
  open({ head,            // Node(s) for the header row — caller supplies
                          // glyph + mono title; the component owns chrome only
         build,           // (bodyEl) => void — fills the scrollable body
         primary,         // { label, onClick } — the commit button; the CALLER
                          // applies its draft and calls close(); the component
                          // never touches the caller's state
         onDismiss }),    // called on Cancel / scrim / Esc — never on commit
  refresh(),              // clear body, re-run build (option rows add/remove)
  close(),
  isOpen(),
}
```

Contract decisions, so they don't get re-litigated in code review:
- **Draft/commit semantics stay caller-side.** The component guarantees only
  the shape of the interaction: one primary action, dismissal paths that never
  half-apply (Cancel button, scrim click, Esc), footer chrome, slide + scrim
  transitions honoring `prefers-reduced-motion`.
- **Esc layering**: the drawer's keydown handler registers on `document` in
  capture phase and stops propagation while open — otherwise Esc would fall
  through and close the host modal underneath it. This is the one integration
  hazard; it gets a comment at the handler.
- **Focus**: on open, focus the first focusable in the sheet; on close, return
  focus to the element that opened it. `role="dialog"`, `aria-modal` on the
  sheet.
- **No direct test** (DOM component, dependency-free repo has no jsdom); its
  behavior is pinned by the pane using it, like `createModal` today.

Plausible later consumers (not promised, just why generic is right): the
alerts-modal condition editor, ingest-modal filter editing — both currently
inline-expand inside scrolling modals, the exact problem the drawer solves.

## Tests

Wire-shape pinners to update mechanically alongside their slice:
`extraction.test.js` (~53 sites incl. 8 stamped-payload deepEquals),
`faces.test.js` (~67), `derived-identity.test.js` (~28), `liveness.test.js`
(~21), `connectors.test.js`, `media.test.js`, `boards-overview.test.js`
(construct only). Client-module tests: `board-sort.test.js`,
`instance-rows.test.js`, `delta-reconcile.test.js`. Fixture-only files
(ingest-*, audio, job-log, plugins, payload, board-manage) get find/replace
fixture updates.

New coverage: a migration test (old-shape board + stamped items in →
transformed out, idempotent on re-run, `from:"raw"` slots → null,
`kind:"object"` → detect) and a validateMapping table test (per-def rejection
cases, replacing the current hand-enumerated ones).

## Slices (each lands green on its own)

1. **Server core** — field-sources.js, migration 0038, validateMapping rewrite,
   every server call-site, SQL predicate updates (+ the three-way predicate
   consolidation), template + manifest identity copy on `/api/connectors`,
   server-side test updates + new tests.
   Biggest slice; app is fully functional at its end (old pane still posts the
   old shape — so this slice ALSO includes a request-shim? **No.** Break, don't
   layer: slices 1+2+3 land as one PR; 1 and 2 are commits that keep the suite
   green via their test updates, 3 restores the UI. The deploy boundary is the
   PR, not the commit.)
2. **Client call-sites** — the 6 modules above + their module tests.
3. **Pane rebuild** — first commit: `createDrawer` in modal.js + its CSS
   (standalone, reviewable alone); then mapping-modal.js rewrite on top of it,
   board-modal band generalization, dropdown.js `trailing`, connector-badge
   recolor, capabilities.js `mappingBand` on detect.

## Out of scope, recorded for next

- Occurrence value shape (`{v: boxes}` → a pinned shape shared by future
  face/voice matching) — deliberately untouched here; this plan only makes the
  *mapping* speak sources. See the conversation's occurrence-axis notes.
- Face/voice matching sources themselves (each: one FIELD_SOURCE_DEFS row, one
  CAPABILITY_DEFS entry, an engine).
- Alerts over field values / embeddings reading fields — real gaps, separate
  plans.

## Checked and clear

- `scripts/logos-board.json` — facets + context only, no mapping; no action.
- No public module beyond the six listed reads the shape (connector-browse,
  ingest-modal, upload, bulk, search, crates, grid: zero `boardMapping` reads).
- README line ~70 documents "per-field liveness (`live` + interval)" — update
  the wording with slice 1 so the docs don't describe a dead key.
