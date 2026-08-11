# AI image input — a provider-aware rendition for the tagger, replacing the card thumbnail

**Status: SLICES 1–5 BUILT (2026-08-11) — the feature is COMPLETE and live;
Slice 6 (the optional rendition cache) designed, not built, and gated on
measurement. Self-contained for a fresh session.**

**Slice 5 shipped:** `boardColumn` projected on the feed's config row
(conditional spread — detect's `{ key, value }` shape untouched), so the modal
never hardcodes a column name; `planBoardConfig(cap, board)` in
[capability-present.js](../public/capability-present.js) — pure, one entry per
board-scopable knob, with `planBoardPicker`'s two rules (the unset row names
what the app default resolves to; a retired preset falls back to the default
row rather than being resent); an "Image detail" row in the board modal's
Tagging → Advanced fold, after Web research, with the selected preset's cost
hint in the same trailing-note slot as double-check's, a deviation chip in the
fold summary, and the value riding `aiOverride` on save (blank clears the
column).

**Authority — shipped admin-only, then reversed the same day on review.** A
non-admin board manager already sets every other knob in that fold (including
double-check, which multiplies the same bill 3–5×), so hiding only this one was
incoherent. The fix ran through the stack: `BOARD_BINDING_COLS` split into
`BOARD_PIN_COLS` (admin) + `BOARD_CONFIG_COLS` (manager); the config leg moved
out of `boardBindingPatch` into a pure `boardConfigPatch(body)` that
`buildBoardContentUpdate` calls, so it runs on the manager route too, with the
admin PATCH merging rather than overwriting `update.boardBindings` and the
create route spreading both; `boardConfigCatalog(db)` added to the board
settings payload so a manager (who cannot read admin feeds) gets the options,
labels, hints and the app-wide default; and the row now mounts synchronously
from that payload instead of waiting on the capability feed. See §7 for the
pins-vs-knobs table.

4 pure planner tests in
[capability-present.test.js](../test/capability-present.test.js), the feed
assertion in capabilities.test.js, and a manager round-trip in
board-capabilities.test.js (a non-admin manager sets the knob, is refused a
bogus id by the same rule, sees the knob + vocabulary in their payload, and
never sees the pins). Full suite green (1014).

**Review pass:** consolidated the two config projections behind one
`configFieldView(f, value)` in capabilities.js (the `bindingSettings`
precedent — a pure helper in the data module both readers may import), so the
admin feed and the board payload cannot drift on field names and the client
takes either unchanged; and converted `boardConfigPatch`'s thrown 400 into
`buildBoardContentUpdate`'s returned `{ error }`, since every other check in
that function returns and both PATCH routes already branch on it — the throw
worked only by falling through to the global error handler.

**Live verification (2026-08-11):** image rebuilt and the local instance
restarted twice — migration `0034` applied cleanly to the real database
(`db: applied migration 0034_board_image_preset`), the app boots with the
worker announcing per-board overrides, every existing board reads
`(app default)`, and `boardConfigCatalog` was run in-container against the live
DB, projecting the four presets with their labels/hints and `value: "high"`.
The **browser DOM wiring is unverified** — the house convention for front-end
work: open a board's edit modal → Tagging → Advanced and confirm the "Image
detail" row renders (now for board managers too, not just the admin), its hint
tracks the selection, the fold summary gains `· image: …` when set, and a save
round-trips.

**Slice 4 shipped:** `modelInputFor` + `modelInputForExtract` hoisted out of
`startWorker`'s closure to module scope and exported (the documentTextFor /
imageForDetection convention — pure motion, and what finally makes the parts
builder directly testable); the image branch now calls `aiImageFor` with the
board's preset and the resolved provider's ceiling; `imagePreset` snapshotted
on the prompt-cache entry (board pin only — the app default is read per job,
uncached, to avoid a new cache-invalidation edge); `effectivePreset` /
`imagesFor` helpers in `startWorker`; extraction reuses tagging's preset with
the extract binding's clamp; the `render` bag rides the image part (both wires
ignore unknown part fields) and lands in the tag job-log row as `detail.image`.
9 new pure tests in [model-input.test.js](../test/model-input.test.js) —
including the §6b regression pin that a PDF's preview stays the stored card
face — plus a live integration test in
[job-log.test.js](../test/job-log.test.js) that ingests a real 2400px image,
runs the worker against a stubbed provider, and asserts the bytes ON THE WIRE
decode to 1568px (board preset beating an app default of `thumb`) with the
ledger recording it. Full suite green (1010).

Review pass caught one real defect and two simplifications: `extractOne`
dereferenced `board.tag_image_preset` unguarded where every neighbouring line
uses `board?.` (a board deleted between the row claim and the read would have
thrown instead of falling to the app default); `imagesFor` closed over nothing
and moved to module scope beside the builder (now exported and directly
tested, including the null-binding guard); and the two remaining inline
`{ galleryDir, thumbsDir }` literals in `startWorker` now reuse `DIRS`.

**What is now live:** every image tagged through a board goes to the model at
the board's preset (or the app default, or `high`), clamped by the provider's
declared ceiling, with the card face as the floor. The remaining slices are the
board-modal picker (Slice 5 — until then a board's preset is set via the API
or SQL) and the optional rendition cache (Slice 6).

**Slice 3 shipped:** migration
[0034_board_image_preset.sql](../server/migrations/0034_board_image_preset.sql)
(`boards.tag_image_preset TEXT`, nullable, no FK/enum — an id points at code,
not a deletable row); `boardColumn: "tag_image_preset"` on the tag config def;
`BOARD_BINDING_COLS` extended to derive **both** kinds of board column (pins
from `boardKeys`, knobs from `binding.config[].boardColumn`) — which carried
the column into the `BOARD_COLS` SELECT, `updateBoard`'s allow-list, and the
admin board payload with **zero route edits**; `assertValidConfigValue`
extracted in capability-bind.js and reused by a config leg in
`boardBindingPatch` (absent → untouched, null/"" → cleared, unknown → 400),
which gave create + PATCH the write path and the stores-nothing contract for
free. 1 new test in
[board-capabilities.test.js](../test/board-capabilities.test.js) covering the
derivation, create-with-pin, set/clear/""-clear, whole-body discard on a bogus
id, no-board-on-rejected-create, absent-means-untouched, and survival of key
deletion; the settings-payload test now iterates `BOARD_BINDING_COLS` so every
board-scoped column is covered generically. Full suite green (1000).

**Slice 2 shipped:** `images` blocks on the five keyed built-ins (each with a
dated survey comment) + `requireValidImages` beside the rate-limit contract in
providers.js `install()`; the `tag_image_preset` enum config def on the tag
capability (vocabulary + admin copy in capabilities.js, numbers in
ai-image.js — label/hint moved out of `IMAGE_PRESETS`, drift pinned by test);
kind-aware `capabilityConfig` (enum passthrough; `Number.isFinite` — a stored
numeric 0 now honored) and `setCapabilityConfig` (+ exported pure
`assertValidCapabilityConfig`, called by the bind route BEFORE `bindCapability`
so the stores-nothing covenant holds for combined bodies); conditional-spread
projection in capability-status.js (detect's `{ key, value }` shape
byte-identical); the kind-aware config row (select for enums) pulled forward
from Slice 5(a) into admin-capabilities.js. 5 new tests (2 in
[provider-pacing.test.js](../test/provider-pacing.test.js): the images
contract + built-in value pins; 3 in
[capabilities.test.js](../test/capabilities.test.js): the drift pin, the
enum/covenant walk, the coercion regressions). Full suite green (999). Nothing
reads `tag_image_preset` or `images` at the pipeline level until Slice 4; the
admin knob is live on the Tagging capability card.

**Slice 1 shipped:** [server/sharp-gate.js](../server/sharp-gate.js) (the
`serializeProcessing` chain extracted verbatim as `sharpGate`, plus the
`sharp.cache(false)`/`sharp.concurrency(1)` globals and the shared
`MAX_DECODE_PIXELS = 40e6` — one OOM policy); `sources/image.js` rewired onto
it (behavior-identical); the optional hardening taken: `imageForDetection`
now decodes through the gate and the duplicate `DETECT_MAX_INPUT_PIXELS`
constant is gone; [server/ai-image.js](../server/ai-image.js) with
`IMAGE_PRESETS`/`DEFAULT_PRESET`/`GENERIC_IMAGES`/`resolvePreset`/`aiImageFor`
per §5 (diagnostics `render` bag included). 14 new pure tests in
[ai-image.test.js](../test/ai-image.test.js) — the full §Slices matrix, with
the byte-cap intermediate rungs asserted as the invariant (never over-cap ∨
thumb). Full suite green (994). The module is dead code until Slice 4, as
planned.

Today the tagger sees the **card face**: a ≤600px-wide, quality-72 WebP thumbnail
(`server/faces/image-thumb.js` THUMB_WIDTH, read back at `worker.js`
modelInputFor). That artifact exists to fill a grid card, and it is the wrong
artifact to show a vision model. Measured on the live "ui" board (4,578 UI
screenshots): 73% of originals are wider than 1200px, average 1775px, so on
average ~9× of the pixels are discarded before the model gets a vote — and the
board's facets (`status-badges`, `kpi-cards`-vs-structural-cards, `code-editor`)
are decided by exactly the small text and small elements a 600px q72 render
destroys. Meanwhile every provider we call accepts far more natively and
**downscales oversized input server-side for free**:

| Provider (checked 2026-08-11) | Tokenization | Accepts before downscaling | Hard input limits |
|---|---|---|---|
| OpenAI gpt-5.x-mini/nano | 32×32 patches × 1.62 (mini) | `high` detail: **1,536 patches or 2048px** (minis have no `original`) | 512MB payload |
| OpenAI gpt-5.4 full | 32×32 patches | `high`: 2,500 patches / 2048px; `original`: 10,000 patches / 6000px (default detail on 5.4 = `high`; 5.5+ = `original`) | 512MB payload |
| Anthropic standard tier | 28×28 patches, ⌈w/28⌉×⌈h/28⌉ | **1568px long edge / 1568 tokens** | 10MB base64, 8000×8000px |
| Anthropic 4.7+ (high-res) | same | 2576px / 4,784 tokens (~3× cost at full res) | same |
| Gemini | 768×768 tiles × 258 tokens (≤384px = flat 258) | tiles up to model context; `media_resolution` knob (not exposed via the compat endpoint we use) | ~20MB inline |
| OpenRouter / compat plugins | pass-through | underlying provider's rules | varies |

A 600×481 thumb on gpt-5.4-mini is ~300 patches ≈ 490 tokens; the model's own
ceiling is ~1,536 patches ≈ 2,500 tokens. We are using less than a third of the
resolution the binding would take, to save tokens nobody chose to save.

**The change:** at tag time, build a dedicated **AI-input rendition** from the
stored original — long edge and quality governed by an admin setting, clamped by
what the resolved provider declares it can use — with a fallback ladder that
lands on the existing thumbnail whenever anything goes wrong. The card face is
untouched; the grid keeps its 600px WebP.

## Design principles

1. **Agnostic in two layers.** *What a provider can accept* is *data on the
   provider descriptor* (the house rule: "quirks are data" — same as `compat`,
   `rpm`, `noTemperature`). *What the admin wants to spend* is a **capability
   config** on `tag` (the `detect_threshold` precedent: belongs to the
   capability, not to whoever serves it). The effective target is
   `min(admin target, provider ceiling)` — so a plugin provider that declares
   nothing still works on conservative generic defaults, and a future provider
   with new limits is one descriptor field, zero core edits.
2. **A rendition failure never fails a tag job.** Every rung of the ladder falls
   back to the next; the floor is the existing thumbnail — i.e. the worst
   possible outcome of this feature is exactly today's behavior, logged once.
3. **One vocabulary: named presets, both levels.** Admins pick a *preset*
   (`thumb` / `standard` / `high` / `max`), not pixel numbers — at the global
   level (the app default, on the capabilities page) and per board (the board
   modal's Tagging → Advanced section, beside the vote-passes select it
   mirrors). The preset→numbers mapping is one data table; raw numeric tuning
   is a deferred extension, not a second UI.
4. **The `thumb` preset is the kill switch.** It sends the card face,
   byte-for-byte today's pipeline.
5. **Board wins, global default, data floor.** `board preset ?? global preset
   ?? "high"` — the same ladder shape every scoped capability already walks.

## Architecture

### 1. Provider descriptor: an optional `images` block

```js
// ai-providers/anthropic.js (and openai/gemini/glm/openrouter)
images: {
  maxEdge: 1568,     // px, long edge, beyond which the provider downscales anyway
  maxBytes: 5e6,     // encoded bytes we allow ourselves to send (their cap / 1.33 for b64, minus headroom)
},
```

- **Semantics: a ceiling, never a request.** The engine clamps the admin's
  target to `maxEdge`; it never upsizes toward it.
- Absent block → generic defaults `{ maxEdge: 2048, maxBytes: 4e6 }` — safe for
  every provider surveyed (all accept ≥2048px and ≥5MB payloads).
- Built-in values:
  - `anthropic`: `maxEdge: 1568` — the standard-tier cap; also deliberately
    avoids paying the 3× high-res token cost on 4.7+ models. `maxBytes: 5e6`
    (their 10MB limit is on the *base64*, ×1.33 + headroom). A per-model
    high-res override is a deferred extension (below), not v1.
  - `openai`: `maxEdge: 2048` (the family-wide dimension cap; minis patch-cap
    lower but the provider trims that itself), `maxBytes: 15e6`.
  - `gemini`, `glm`, `openrouter`: generic `{ 2048, 4e6 }` stated explicitly
    (openrouter is pass-through — conservative is correct).
- **Validation home: `install()` in providers.js**, beside `requireRateLimit` —
  the one registry write that built-ins, plugins (`registerProvider`), and
  test-registered stubs all pass through, which is exactly why the rate-limit
  contract lives there and not in the plugin loader. `requireValidImages(name,
  desc)`: absent block → fine; present → must be a plain object, and each of
  `maxEdge`/`maxBytes`, when present, a positive finite number — anything else
  throws a readable error at registration. (The loader's `validateBuilt` needs
  no edit: registration funnels through `install()`.) Contract test mirrors
  the rate-limit one at provider-pacing.test.js:71.
- Not part of `provides` normalization — it is a quirk block like `compat`, not
  a capability declaration.

### 2. The preset table — one place numbers live

In `server/ai-image.js`, pure data:

```js
export const IMAGE_PRESETS = {
  thumb:    { edge: 0,    quality: 72 },   // the card face — the kill switch
  standard: { edge: 1024, quality: 80 },
  high:     { edge: 1568, quality: 82 },
  max:      { edge: 4096, quality: 85 },   // rides the provider clamp to its true ceiling
};
export const DEFAULT_PRESET = "high";
```

*(Slice 2 refinement: `IMAGE_PRESETS` carries render policy ONLY — numbers.
The admin-facing copy — per-preset label + cost hint — lives on the capability
config def in `capabilities.js` (§3), which is the registry's existing home
for UI copy as data (`rebindWarning` precedent). Slice 1 shipped label/hint
inside the presets; they move out in Slice 2 — no test asserted them. One
concern per file: numbers in ai-image.js, vocabulary + copy in
capabilities.js, drift pinned by a test.)*

- `edge` is a *request*, the provider `images.maxEdge` clamp is the *ceiling* —
  so `max`'s 4096 simply rides the clamp to each provider's true limit
  (1568 Anthropic standard, 2048 OpenAI, …). No preset can exceed what a
  provider takes.
- Rationale for `high` = 1568/q82: the sweet spot across all three majors
  (Anthropic standard-tier cap exactly; ≈ gpt-5-mini's 1,536-patch budget; 4–6
  Gemini tiles). `standard` = 1024 is the budget middle (~3×). The card face's
  q72 stays where it is.
- An unknown stored preset id (downgrade, hand-edited row) resolves to
  `DEFAULT_PRESET` with a warn — never an error.

### 3. Global default: capability config on `tag`

`capabilities.js` is **PURE DATA — no imports** (its header is law), so the
config def can't read `IMAGE_PRESETS`. Instead it owns what it's already the
home for — the vocabulary and the admin-facing copy (the `rebindWarning`
precedent) — and a test pins it against the presets module:

```js
// capabilities.js, tag entry (boardColumn joins in Slice 3 — see §4)
config: [{
  key: "tag_image_preset", default: "high", kind: "enum",
  label: "Image detail sent to the model",
  options: [
    { value: "thumb",    label: "Thumbnail",    hint: "the card face — cheapest, the pre-preset behavior" },
    { value: "standard", label: "Standard",     hint: "≈3× thumbnail image tokens" },
    { value: "high",     label: "High",         hint: "≈5× — text in screenshots stays legible" },
    { value: "max",      label: "Provider max", hint: "whatever the provider accepts — cost varies by model" },
  ],
}],
```

Drift pin (test): `options.map(o => o.value)` deepEqual
`Object.keys(IMAGE_PRESETS)`, and `default === DEFAULT_PRESET`.

- Rides the **existing machinery end to end**: `capabilityConfig(db, "tag")`
  reads it, `setCapabilityConfig` stores it, the bind route
  (`POST /api/admin/capabilities/tag/bind` with `{ config: {...} }`) accepts
  it, and `admin-capabilities.js` already renders `c.config` rows — so the
  app-wide default appears on the Tagging capability card with no new route.
- **`capabilityConfig` goes kind-aware (read side):** today it is
  numeric-only — `Number(v) || f.default`, which also silently folds a stored
  `0` into the default. New rule per field: `enum` → the stored string when it
  is one of `options`, else the default; numeric → `Number.isFinite(n) ? n :
  f.default` (a stored `detect_threshold: 0` now honestly means 0 —
  deliberate behavior fix, covered by a regression test).
- **`setCapabilityConfig` goes kind-aware (write side):** today it stores
  anything (`String(v)`). New rule: `enum` → unknown id throws `bad(400)`
  (null/`""` clears to default); numeric → non-finite throws `bad(400)`.
- **The stores-nothing contract needs one route fix.** capability-bind.js's
  covenant is "a REJECTED bind stores nothing" — but the route runs
  `bindCapability` *then* `setCapabilityConfig`, so a body carrying a valid
  binding + a bogus config would store the binding and then 400. Fix: export
  `assertValidCapabilityConfig(capId, values)` (pure check, no writes) and
  call it at the top of the route, before `bindCapability`. Both halves
  validated before either writes — the covenant holds for the combined body.
  Covered by a combined-body test.
- **Projection (capability-status.js:213) is shape-constrained:** detect's
  tests `deepEqual` the config row as exactly `{ key, value }`, so the new
  fields ride conditional spreads — `{ key, value, ...(f.kind && { kind }),
  ...(f.label && { label }), ...(f.options && { options }) }`. Detect's def is
  deliberately untouched (no label added now), so its payload stays
  byte-identical and its tests stand.
- **UI renderer moves up from Slice 5(a) into Slice 2:** without it, the
  capabilities page would render the string `"high"` in a `type="number"`
  input — a broken-looking state shipped mid-plan. The renderer goes
  kind-aware: `f.options` present → a `<select>` (option label, `title` =
  hint, current `f.value`), committing the *string* on change; else the
  numeric input, unchanged. Row label: `f.label || key.replace(/_/g, " ")`.
  The board modal select (Slice 5) is unaffected by this pull-forward.

### 4. Board override: a column + the Tagging pane select

- **Storage: `boards.tag_image_preset text` (nullable), migration
  `0034_board_image_preset.sql`** (0033 is the latest — the board capability
  pins). Null = "use the app default" — the same null-means-unpinned contract
  as every board binding column. No FK, no DB-level enum check (preset ids
  evolve in code; the read path resolves an unknown id to the default, pinned
  by Slice 1's tests). A text column (not jsonb) because it's one enum value
  and the board row is already column-shaped for exactly this kind of pin.
- **The column name lives on the config field def** —
  `config: [{ key: "tag_image_preset", boardColumn: "tag_image_preset", … }]`
  — NOT as a fourth `boardKeys` field. `boardKeys`' three named fields carry
  pin semantics walked by real machinery (provider XOR keyId in
  `boardBindingPatch`, `countBoardOverrides` counting provider/keyId, the
  deleteAiKey/uninstall cleanup loops clearing pins); config is the thing
  those loops deliberately never touch, and keeping it off `boardKeys` keeps
  that rule structural rather than by-convention.
- **One derivation edit does most of the plumbing.** `BOARD_BINDING_COLS`
  (db.js ~1207) is registry-derived and feeds three things at once: the
  `BOARD_COLS` SELECT list (so every board read — `getBoard`, `req.board`,
  the worker's rows — carries the column), `updateBoard`'s allow-list, and
  the board payload spread (server.js ~980). Extend its flatMap with
  `(c.binding.config || []).map((f) => f.boardColumn).filter(Boolean)` — the
  column then reads, writes, and serializes with **zero route edits**.
  *(Superseded by Slice 5: the list splits into `BOARD_PIN_COLS` +
  `BOARD_CONFIG_COLS` so the payload can gate pins behind `is_admin` while
  knobs stay manager-visible — see §7.)*
- **Write path: a config leg in `boardBindingPatch`.** Both write routes
  already funnel through it (create ~1329, admin PATCH ~1541), so one loop
  covers both: for each config field with a `boardColumn`, `undefined` →
  untouched, `null`/`""` → column nulled (back to app default), else
  validated against the def's `options` → stored, unknown id → `bad(400)`.
  *(Superseded by Slice 5: the leg moved to a pure `boardConfigPatch(body)`
  called from `buildBoardContentUpdate`, so the MANAGER route accepts knobs
  too — see §7.)*
  Validation reuses the single-field rule shared with
  `assertValidCapabilityConfig` (extract `assertValidConfigValue(f, v)` so
  the global and board legs cannot drift). The PATCH route's ordering
  already gives stores-nothing for free: `boardBindingPatch` throws before
  `updateBoard` runs, discarding the whole body — same contract as a bad pin.
  Admin-only by construction (the preset rides the pins' routes), matching
  "pins are admin-written".
- **Read path (Slice 4's seam):** the worker's prompt cache entry
  (worker.js ~651) snapshots `aiKeyId`/`aiModel` off the board row — it gains
  `imagePreset: board.tag_image_preset`; `invalidateBoardCache` on PATCH
  already covers staleness. Effective preset = `entry.imagePreset ??
  capabilityConfig("tag").tag_image_preset` (which already defaults), then
  `resolvePreset` — resolved once per tag job. `resolveBoardAi`'s fragment is
  untouched: it is a *binding* adapter and the preset is not a binding.
- **UI: the board modal's Tagging → Advanced section** — see §7 for the full
  Slice 5 spec (placement, the authority question, and the pure planner).
- **Cleanup: none needed, by design** — the column holds a preset id, not a
  key/model pointer; nothing to FK, nothing for the delete loops to clear.
  (This is the material difference from `detect_threshold`'s "deliberately
  global" note: an enum carries no dangling-binding risk, and boards genuinely
  differ — a logos board and a screenshots board want different spend.)

### 5. The rendition module: `server/ai-image.js`

A single top-level module (the `provider-pacing.js` shape — one concern; its
only imports are sharp, fs, path, and the gate — no db, no worker, which is
what keeps its tests pure and fast). It owns `IMAGE_PRESETS`, the generic
provider defaults, and the renderer:

```js
export const GENERIC_IMAGES = { maxEdge: 2048, maxBytes: 4e6 };
export const resolvePreset = (id) => IMAGE_PRESETS[id] ?? IMAGE_PRESETS[DEFAULT_PRESET]; // unknown id → warn + default

export async function aiImageFor({ galleryDir, thumbsDir }, file, { preset, images = GENERIC_IMAGES })
  → { b64, mediaType: "image/webp", render: { source, edge, quality, bytes, fallback? } }
```

`render` is the diagnostics bag — `source: "original" | "thumb"`, the final
edge/quality/bytes, and `fallback: "<reason>"` when a rung fell through. It
exists for the tests *and* for Slice 4's job-log detail ("what did the model
actually see"), so it is part of the contract from day one.

The ladder, in order — each rung falls through on failure:

1. **Thumb mode:** preset `edge === 0` (the `thumb` preset), or `edge ≤
   THUMB_WIDTH (600)` after clamping → read `thumbsDir/<name>.webp`, return
   it with `source: "thumb"`. (Today's behavior, the kill switch.)
2. **Clamp:** `target = min(preset.edge, images.maxEdge)`.
3. **Skip pointless work — no decode:** original long edge from the stored
   entry (`file.meta.width/height` — present on everything ingested since file
   fields; **legacy entries may lack `meta`**, they're enriched lazily by the
   list route via `sources.metaFor`) or, when `meta` is absent, a sharp
   `.metadata()` header read on `galleryDir/<name>` (cheap, no pixel decode).
   If the original's long edge ≤ the stored thumb's long edge
   (`max(file.w, file.h)`, default 600), the thumb already carries full
   fidelity → rung 1. This also catches **generated connector faces** with no
   special-casing: their galleryDir copy IS the webp face
   (`storeFace { generated: true }` writes the same bytes to both dirs), so
   original == thumb dims. Note a mid-size original (e.g. 800px, above the
   600px thumb but below target) IS rendered — `withoutEnlargement` makes it a
   full-fidelity re-encode at q`preset.quality`, still better than the q72
   thumb.
4. **Render** (inside one gate acquisition covering rungs 4–5):
   `sharp(path, { pages: 1, limitInputPixels: MAX_DECODE_PIXELS })` —
   `pages: 1` takes a gif/animated-webp's first frame, matching ingest —
   `.timeout({ seconds: 20 })` so a pathological file can never wedge the gate,
   `.rotate()` (EXIF orientation baked in, the imageForDetection lesson),
   `.resize({ width: target, height: target, fit: "inside",
   withoutEnlargement: true })` (long-edge semantics — note the card face caps
   *width* only; providers cap the long edge, so `fit: "inside"` is the
   correct shape here), `.webp({ quality: preset.quality })`. No `.flatten()`
   — WebP carries alpha fine (the detector needed it only because JPEG
   doesn't).
5. **Byte-cap ladder:** if encoded bytes > `images.maxBytes`: re-encode at
   `quality − 15` (floor 40); still over → re-render at `target × 0.75`; still
   over → rung 1 with `fallback: "byte-cap"` and a `console.warn`. Two retries
   max — bounded work, all inside the same gate slot.
6. **Any error** (missing/corrupt original, sharp throw/timeout, format
   surprise): `console.warn` with the file name and reason → rung 1 with
   `fallback` set. If even the thumb read fails, the error propagates — that
   is today's failure mode and means the item's files are genuinely gone (the
   tag job requeues, correctly).

**`server/sharp-gate.js` — the gate, and sharp's global config.** Extract the
`serializeProcessing` promise-chain verbatim from `sources/image.js` (including
its failure isolation — `run.then(() => {}, () => {})` keeps a rejected job
from poisoning the chain) into a module exporting `sharpGate(fn)` plus a shared
`MAX_DECODE_PIXELS = 40e6`. Two ownership moves ride along:

- **`sharp.cache(false)` / `sharp.concurrency(1)` move to this module's scope**
  (from the `imageSource()` factory). Today they're only applied once the image
  source is constructed; after the move, *any* importer — ingest, ai-image, a
  test file — gets the droplet-safe config. `sources/image.js` imports the gate
  and deletes its local copy; behavior-identical for ingest.
- **`MAX_DECODE_PIXELS` dedupes the 40e6 constant** currently written twice
  (`sources/image.js` MAX_PIXELS, `worker.js` DETECT_MAX_INPUT_PIXELS) — one
  OOM policy, imported by all three.

Why the gate matters here: `AI_INFLIGHT` defaults to 8 concurrent tag jobs; 8
simultaneous multi-MP decodes would OOM the 458MB droplet. With the gate, one
decode is in flight process-wide, matching `sharp.concurrency(1)`. Rendition
latency (~100–300ms) is noise next to the paid AI call it precedes.

**Decoder inventory (gate scope, for the record):** heavy in-process decoders
are (a) image ingest — gated today, stays gated via the import; (b) tag-time
renditions — gated by this slice; (c) `imageForDetection` (worker.js ~1185) —
**ungated today**, runs at `EXTRACT_CONCURRENCY` (2) and decodes up to 40MP.
Wrapping (c) in `sharpGate` is a one-line hardening once the module exists —
worth doing in Slice 1's PR since the gate is right there, but it touches
worker.js, so it's optional if the slice wants to stay file-local. The face
producers (pdf-page/text-peek/price-chart/waveform) only encode small
already-rendered buffers — out of scope.

### 6. Worker wiring

**The enabling move: hoist `modelInputFor` to module scope.** It is currently a
closure inside `startWorker` (worker.js ~1351) over `galleryDir`/`thumbsDir`
and nothing else — which is why the parts builder has never had a direct test.
The file already has the pattern for exactly this: `documentTextFor(galleryDir,
file)`, `imageForDetection(buf)`, and `generateFace(db, { galleryDir,
thumbsDir }, …)` are all module-level and exported "for tests", with the
closure reduced to a call site that binds the dirs. Hoist both siblings
(`modelInputFor` and `modelInputForExtract`) the same way:

```js
export async function modelInputFor(dirs, payload, { entity = null, mode = "tag", preset, images } = {})
export async function modelInputForExtract(galleryDir, payload)
```

An options object rather than more positionals — `mode` is already the third
argument and two more would make every call site unreadable. This is the bulk
of the slice's diff and it is pure motion: no behavior change.

**Preset resolution — board pin, then the app default, resolved per job.**

```js
const effectivePreset = async (db, boardPresetId) =>
  resolvePreset(boardPresetId ?? (await capabilityConfig(db, "tag")).tag_image_preset);
```

- **tagOne** reads the board's pin off the prompt-cache entry: `getBoardPrompt`
  (worker.js ~651) already snapshots `aiKeyId`/`aiModel` from the board row and
  gains `imagePreset: board.tag_image_preset`. `invalidateBoardCache` on board
  PATCH already covers staleness.
- **extractOne** has the full board row in hand (`getBoard`, ~1977) — it reads
  `board.tag_image_preset` directly, no cache involved.
- **The global default is read per job, never cached.** One single-row SELECT
  beside a multi-second paid call is noise, and the alternative is a real trap:
  caching the *effective* preset in the board entry would need the capability
  bind route to call `invalidateAllBoardCaches()`, which today fires only on
  key deletion (server.js ~1755). Correct-by-construction beats a new
  invalidation edge. The `??` short-circuit also skips the read entirely when
  the board pins one.
- **Extraction deliberately reuses tagging's preset.** `tag_image_preset` is a
  knob on the tag capability, and extraction rides tagging's declaration, wire,
  and binding delegation — a separate extract preset would be a second dial for
  one decision. The `images` clamp, however, comes from the **extract**
  binding's provider (it can resolve to a different one).

**The clamp** is `PROVIDERS[ai.provider]?.images ?? GENERIC_IMAGES` (worker.js
must add `PROVIDERS` to its providers.js import — it currently takes only the
dispatchers).

**Image branch** (~1425): replace the raw thumb read with `aiImageFor`. `parts`
is built once per item and shared across all N vote calls, so a `×3` board
still renders once. **Never wrap the call in `sharpGate`** — it gates
internally and the gate is not reentrant (the warning lives in sharp-gate.js).

**Job-log visibility.** `aiImageFor` already returns its `render` bag; attach it
to the part (`{ kind: "image", mediaType, b64, render }`). Both wires map parts
by `kind` and ignore unknown fields (`compatRequest`, `anthropicRequest`), so
this rides along invisibly. `tagOne` lifts it —
`parts.find((p) => p.kind === "image")?.render` — onto its result, and
`processOne`'s existing `legLog(row, "tag", …)` detail (~1917) spreads
`...(image ? { image } : {})`. That makes "what did the model actually see"
answerable from the jobs view, which is the only way to tell a `high` board
from one silently falling back to thumbnails.

**No-ops worth stating** (each is a rung already built, not a special case):
generated connector faces resolve to the thumb because their galleryDir copy IS
the face; text/docx/audio parts never touch the module; the Anthropic-only
whole-PDF document block already sends original bytes; the object-detection
pass already reads the gallery original.

### 6b. PDF page-1 previews — deliberately OUT of scope

The preview riding along with a PDF's extracted text (worker.js ~1371) keeps
reading the stored 600px q72 face, unchanged by this plan. That is a decision,
not an oversight — record it so a later session doesn't rediscover "PDFs are
still 600px" and re-litigate:

- **A PDF is text-first material.** `documentTextFor` extracts the text and
  that is what the model reads; the page-1 image is an *anchor* that keeps
  visual/style facets from going blind, not the evidence the tags rest on.
  The screenshot problem this whole plan exists to fix — illegible small text
  in the only material there is — does not apply when the text arrives as text.
- **It is a different mechanism wearing the same words.** There is no stored
  original image to resize: a bigger preview means rasterizing the PDF again
  through a poppler subprocess (`pdftoppm -scale-to`) on every tag job, for a
  garnish. `aiImageFor`'s whole shape — stored original, metadata skip rung,
  sharp resize — buys nothing there.
- **The preset would be lying.** "Image detail sent to the model" would mean
  two different things on two board types, and the expensive one would be the
  one where it matters least.

If a PDF-heavy board ever shows style facets failing on preview resolution,
the shape is known and small: parameterize `pdfPage({ scaleTo, quality })`
(both are hardcoded today), extract `aiImageFor`'s byte-cap ladder into an
internal `withinBudget(renderAt, …)` taking a render callback, and add a
poppler-sourced sibling. Nothing in this plan forecloses it. Until that
evidence exists, it is cost and surface for no measured gain.

### 7. The board picker (Slice 5)

**Placement: Tagging → Advanced, after Web research, before RE-TAGGING.** A
labelled row mirroring the double-check sub-row it sits near — `Image detail
[High ▾] — ≈5× thumbnail image tokens` — with the selected option's `hint` in
the same trailing-note slot as "— roughly 3× the tagging cost". That fold is
already where this board's cost dials live (votes multiplies tagging cost 3–5×
right above it), which is what makes it the honest home rather than the
AI-models strip: the strip's rows are *bindings* (which key, which model),
planned by `planBoardPicker`, and a spend dial is not a binding.

**Authority: any board MANAGER, not admin-only.** (Shipped admin-only first;
reversed the same day on the right objection — a non-admin manager already sets
every other knob in this fold, including double-check, which multiplies the
same bill 3–5×. Excluding only this one is incoherent, and a knob is a
cost/quality dial, not a credential.) The split now runs through the whole
stack:

| | PINS (`boardKeys`) | KNOBS (`config[].boardColumn`) |
|---|---|---|
| What | which key / which model | how much to spend per image |
| Who | admin (`BOARD_PIN_COLS`) | any board manager (`BOARD_CONFIG_COLS`) |
| Write | `boardBindingPatch`, admin routes | `boardConfigPatch`, **both** routes |
| Payload | behind `is_admin` | always |
| Cleanup | cleared on key delete / uninstall | nothing to dangle |

Concretely: `BOARD_BINDING_COLS` splits into `BOARD_PIN_COLS` +
`BOARD_CONFIG_COLS` (the union still drives the SELECT list and `updateBoard`'s
allow-list); the config leg moves out of `boardBindingPatch` into a pure
`boardConfigPatch(body)` that `buildBoardContentUpdate` calls — so it runs on
the manager route too — with the admin PATCH now **merging** rather than
overwriting `update.boardBindings`, and the create route spreading both.

**The vocabulary rides the board settings payload, not the admin feed.** A
manager cannot read `/api/admin/capabilities`, so `boardConfigCatalog(db)`
(capability-resolve.js) projects `[{ key, boardColumn, label, value, options }]`
onto `GET /api/boards/:id/settings` — same registry, scoped to what the modal
needs, and `value` is the app-wide effective preset the "App default (…)" row
names. The feed keeps its `boardColumn` too: a NEW board has no settings
payload, and board creation is admin-only, so the create path lifts the same
field shape off `cap.config`.

**The logic goes in a pure planner, the modal only mounts it.** House
convention (`planBoardPicker`, `planSection` — pure, node-tested, no DOM):

```js
// public/capability-present.js
export function planBoardConfig(fields, board)
  → [{ key, column, label, rows: [{ value, label, hint }], preselect, hintFor(sel), payload(sel) }]
```

- Takes the field array directly, so the settings payload and the feed slice
  both feed it unchanged.
- One entry per field that has a `boardColumn` (data-driven — a second
  board-scoped knob gets a row with no edit here).
- `rows[0]` is the unset row: `App default (<label of the option matching
  cap.config[].value>)` — so the row answers "what does blank mean" instead of
  raising it, exactly as `planBoardPicker`'s unset row does.
- `preselect` = the board's stored value **if it is still a declared option**,
  else `""` — the planBoardPicker rule: a retired preset falls to the default
  row rather than sending a dead value back on save.
- `payload(sel)` = `{ [column]: sel || null }` — `null` clears to the app
  default, which is precisely what Slice 3's write path accepts.

**Wiring notes.** For an existing board everything needed is in the settings
payload the modal already fetched, so the row mounts **synchronously** with the
rest of the fold (after the `at` state exists — `syncAdvSummary` reads it). Only
the new-board path waits on the feed. Save rides the existing `aiOverride`
object but **outside** the `canEditAI && aiLoaded` pin gate; `capConfigs` is
empty until the rows mount, so an early save leaves the columns untouched. The
Advanced summary gains a chip only when the board deviates: `· image: Provider
max`.

**Tests.** Pure, in capability-present.test.js beside `planBoardPicker`'s:
unset board → preselect `""` and an "App default (High)" first row; a pinned
board → that option preselected; a board holding a retired id → falls back to
`""`; `payload("")` → `{ tag_image_preset: null }`, `payload("max")` → the id;
a capability with no board-scoped config → `null`. Plus one server assertion
that the feed exposes `boardColumn`. The DOM wiring is live-verified in the
browser (front-end convention — no DOM tests).

### 8. Rendition cache (own slice — ship after measuring)

Periodic boards (`auto_tag_periodic`) re-tag every item on a cadence; without a
cache each pass re-renders every image on a 1-vCPU box. Design, if measurement
says it's needed:

- Path: `thumbsDir/<name>.ai-<edge>q<quality>.webp` — parameters in the name,
  so a settings change naturally misses the old file and writes a new one.
- On write, unlink sibling `<name>.ai-*.webp` variants (one live rendition per
  file).
- Cleanup: `sources/image.js` owns deletion of the files it wrote — extend its
  remove path to also unlink `<name>.ai-*.webp`. (Image handler only: PDFs
  produce no rendition — §6b.)
- Backups: renditions are derivable artifacts; exclude the `*.ai-*` glob from
  the backup manifest the way generated content is handled, or accept the
  bytes — decide in the slice.
- v1 ships **without** the cache: render per job, log render duration in the
  existing job-log detail, and let the numbers decide. (A tag job already costs
  seconds of paid API latency; ~200ms of sharp is unlikely to matter outside
  periodic boards.)

## Failure modes → behavior

| Failure | Behavior |
|---|---|
| Gallery original missing/corrupt | warn once, send card thumbnail |
| Original smaller than thumb target | send thumbnail (no upscale, no waste) |
| Generated face (chart) | metadata rung detects original==thumb → thumbnail |
| Encoded bytes over provider cap | quality−15 → edge×0.75 → thumbnail |
| Provider declares no `images` | generic `{2048, 4e6}` clamp |
| Board/global preset is `thumb` | byte-identical to today (kill switch) |
| Unknown preset id stored (downgrade, hand edit) | warn once, resolve to `DEFAULT_PRESET` |
| Board deleted / column null | falls to the global preset — nothing to clean up |
| Sharp/poppler throws | warn once, thumbnail |
| Thumb also unreadable | error propagates → tag job requeues (today's contract) |
| 8 concurrent tag jobs | decodes serialized via shared sharp gate — one in flight |
| Stored numeric config `0` (detect_threshold) | honored (after the `Number.isFinite` coercion fix) |

## Deferred extensions (the seams are the point)

- **Numeric fine-tuning.** If a preset ever isn't enough, a `custom` preset
  whose edge/quality come from two more config keys — the preset table is the
  seam; the UI stays a select with one more option. Not v1: presets cover the
  real decisions (cheap / balanced / legible / ceiling).
- **Per-model ceilings.** Anthropic's 2576px high-res tier is model-dependent
  (4.7+). Extension: `images.tiers: [{ modelPattern, maxEdge }]` consulted with
  the resolved model id — one descriptor field, engine reads it in the clamp.
  Not v1: the global 1568 default is the right spend answer today anyway.
- **Compat `detail` quirk.** The OpenAI-compat wire sends `image_url` with no
  `detail`. A `compat.imageDetail` quirk field could pin `"high"` explicitly
  (today's default on gpt-5.4) or `"original"` where supported. Deferred until
  a provider actually needs it.
- **PDF page-1 previews.** Excluded on the merits, not merely deferred — the
  reasoning and the (small) shape it would take live in §6b.
- **Multi-page PDF input / image crops.** Out of scope; the seam is that
  `modelInputFor` already returns an ordered parts array.

## Slices

**Slice 1 — the module + the gate.** Two new files, one edit, no behavior
change anywhere else:

- `server/sharp-gate.js`: `sharpGate(fn)` (the promise chain from
  `sources/image.js`, verbatim, failure isolation included),
  `MAX_DECODE_PIXELS = 40e6`, and the `sharp.cache(false)` /
  `sharp.concurrency(1)` globals at module scope.
- `server/sources/image.js`: delete the local gate + MAX_PIXELS + sharp
  globals; import them. (Optional hardening in the same PR: wrap
  `imageForDetection`'s decode in `sharpGate` and point
  `DETECT_MAX_INPUT_PIXELS` at the shared constant.)
- `server/ai-image.js`: `IMAGE_PRESETS`, `DEFAULT_PRESET`, `GENERIC_IMAGES`,
  `resolvePreset`, `aiImageFor` per §5.

Tests (`test/ai-image.test.js` — pure, no `startServer`, the
`imageForDetection` tests in detect.test.js are the template). Fixtures are
sharp-generated buffers (`sharp({ create: {...} })`) written into an
`fs.mkdtemp` gallery/thumbs pair per test file; a helper builds the pair
(original at W×H + a 600px q72 thumb via the real `imageThumb`) and the file
entry `{ name, kind: "image", w, h, meta: { width, height } }`:

1. **Landscape 4000×3000, `high`** → `render.source === "original"`, long
   edge 1568, aspect preserved (±0.01), format webp, `render.bytes` matches.
2. **Portrait 1200×3000** → *height* is the capped edge (fit "inside", not
   width-only like the card face).
3. **Clamp:** same fixture, `images: { maxEdge: 1000 }` → long edge 1000.
4. **Mid-size 800×500** → rendered from the original at 800 (no enlargement),
   not the thumb — asserts the q72→q82 re-encode branch.
5. **Small 300×200 (≤ thumb)** → byte-identical thumb, `source: "thumb"`,
   and the gallery file was never decoded (assert via a `meta`-carrying entry
   pointing at a *deleted* gallery path — rung 3 must decide from stored meta
   alone).
6. **Legacy entry (no `meta`)** → header-read fallback still renders.
7. **`thumb` preset** → thumb returned even with a huge original.
8. **EXIF orientation 6 jpeg** (300×200 + `.withMetadata({ orientation: 6 })`)
   → rendered dims swap (rotate() baked in).
9. **Byte cap:** `images: { maxBytes: 1 }` → falls all the way to thumb,
   `fallback: "byte-cap"`; a generous cap → no fallback. (The intermediate
   q−15 / ×0.75 rungs are asserted structurally — `render.quality` /
   `render.edge` on a mid-tight cap chosen from the fixture's measured sizes;
   if that proves flaky across libvips versions, assert only
   `bytes ≤ maxBytes ∨ source === "thumb"` — the invariant that matters.)
10. **Corrupt original** (text bytes named .png) → thumb + `fallback`.
11. **Missing original AND missing thumb** → throws (today's contract).
12. **`resolvePreset`:** unknown id → default; every declared id resolves.
13. **Gate:** two `sharpGate` jobs enqueued together run strictly in order
    (instrumented begin/end array); a rejecting job doesn't break the next.

No worker wiring, no settings, no routes — the module is dead code until
Slice 4, which is what makes this slice safely mergeable on its own.

**Slice 2 — declarations + config plumbing.** File by file:

- `server/ai-providers/{anthropic,openai,gemini,glm,openrouter}.js`: the
  `images` block, each with a dated rationale comment — anthropic
  `{ maxEdge: 1568, maxBytes: 5e6 }` (standard-tier cap; dodges the 3×
  high-res token tier; 10MB limit is on the *base64*), openai
  `{ maxEdge: 2048, maxBytes: 15e6 }` (family dimension cap; minis patch-cap
  below it but the provider trims that itself), gemini/glm/openrouter
  `{ maxEdge: 2048, maxBytes: 4e6 }` (generic stated explicitly; openrouter
  is pass-through so conservative is correct). local/whisper/localDetector:
  none — no tag wire.
- `server/providers.js`: `requireValidImages` in `install()` (see §1).
- `server/ai-image.js`: label/hint move OUT of `IMAGE_PRESETS` (see §2).
- `server/capabilities.js`: the `tag` config def with kind/label/options
  (see §3).
- `server/capability-resolve.js`: kind-aware `capabilityConfig` (enum
  passthrough validated against options; `Number.isFinite` for numerics).
- `server/capability-bind.js`: kind-aware `setCapabilityConfig` +
  exported pure `assertValidCapabilityConfig`.
- `server/server.js`: the bind route calls `assertValidCapabilityConfig`
  before `bindCapability` (the stores-nothing covenant, §3).
- `server/capability-status.js`: conditional-spread projection of
  kind/label/options (detect's payload byte-identical).
- `public/admin-capabilities.js`: the kind-aware config row (select for
  enums, string commit) — pulled forward from Slice 5(a).

Tests:

1. **Images contract** (beside provider-pacing.test.js:71): non-object /
   negative / zero / non-finite `images` fields rejected at `registerProvider`
   with a readable error; absent block accepted; valid block accepted
   (unregister in `finally`). Spot-check two built-ins' declared values
   (anthropic 1568/5e6, openai 2048/15e6) so a fat-finger edit can't ship.
2. **Config plumbing** (capabilities.test.js, mirroring the detect_threshold
   tests at :101/:241): the tag card's projection carries
   `{ key: "tag_image_preset", value: "high", kind, label, options }` when
   unset; bind round-trip stores `"max"` and the feed reflects it; unknown id
   → 400 AND `getSetting` still null; `null` clears back to the default;
   combined body (valid `keyId` + bogus config) → 400 and NEITHER stored.
3. **Drift pins**: options values === `Object.keys(IMAGE_PRESETS)`; def
   default === `DEFAULT_PRESET`.
4. **Coercion regressions**: stored `detect_threshold` `"0"` reads as 0 (was:
   folded to 0.3); `"abc"` reads as the default; unset reads as the default;
   detect's projected config row is still exactly `{ key, value }`.

Still dead code at the pipeline level — nothing reads `tag_image_preset` or
`images` until Slice 4 — but the admin knob is live (and harmless) from here.

**Slice 3 — the board column.** File by file (full detail in §4):

- `server/migrations/0034_board_image_preset.sql`: `ALTER TABLE boards ADD
  COLUMN IF NOT EXISTS tag_image_preset TEXT;` — nullable, no FK, no DB enum.
- `server/capabilities.js`: `boardColumn: "tag_image_preset"` on the config
  field def.
- `server/db.js`: `BOARD_BINDING_COLS` derivation gains the config-column leg
  (+ comment update) — flows the column into `BOARD_COLS`, `updateBoard`, and
  the admin board payload with zero route edits.
- `server/capability-bind.js`: extract `assertValidConfigValue(f, v)` (shared
  by `assertValidCapabilityConfig` and the new leg); `boardBindingPatch` gains
  the config-column loop (undefined → untouched, null/"" → cleared, unknown →
  400, valid → stored).
- No route edits, no cleanup edits, no worker edits (the prompt-cache
  `imagePreset` snapshot is Slice 4's first line).

Tests (test/board-capabilities.test.js, beside the pin rules they mirror):
create with a preset → stored + exposed in the admin board payload; create
with a bogus id → 400 and no board row; PATCH set → stored, PATCH null →
cleared, PATCH bogus → 400 with the whole body discarded (the pins'
stores-nothing contract); pure: `BOARD_BINDING_COLS` includes
`tag_image_preset` (the derivation edit can't silently regress).

**Slice 4 — worker wiring.** File by file (full detail in §6):

- `server/worker.js`: hoist `modelInputFor` + `modelInputForExtract` to module
  scope and export them (pure motion, the bulk of the diff); import `PROVIDERS`
  and `aiImageFor`/`resolvePreset`/`GENERIC_IMAGES`; add
  `imagePreset: board.tag_image_preset` to the prompt-cache entry; add the
  `effectivePreset` helper; image branch calls `aiImageFor`; `tagOne` and
  `extractOne` pass `{ preset, images }` and lift `render`; `processOne`'s tag
  `legLog` detail spreads `image`.
- Nothing else — no routes, no schema, no UI.

Tests. **Direct** (new `test/model-input.test.js`, pure — the hoist is what
makes it possible; `docs.test.js`'s tmpdir style is the template):

1. Large image + `high` → the image part carries `render.source === "original"`
   and a 1568px long edge; the text part still closes with `record_tags`.
2. `thumb` preset → `render.source === "thumb"`, bytes identical to the face.
3. A tight `images.maxEdge` clamps below the preset (provider ceiling wins).
4. `mode: "extract"` → same rendition, and the ask says `record_fields`
   (guarding the wrong-tool-name trap job-log.test.js already pins).
5. Generated connector face → thumb, and the anchor still reads as a chart.
6. Fileless entity vehicle → unchanged text-only part (no image, no throw).

**Integration** (extend `test/job-log.test.js`, which already drives the real
worker against a stubbed fetch and inspects sent bodies): one tagged image item
asserts the sent `image_url` payload decodes to the preset's long edge **and**
the tag job-log row carries `detail.image.preset`/`.source`. Plus one board-vs-
global assertion: with the app default at `thumb` and the board pinned to
`high`, the sent image is the rendition.

Plus one **regression pin**: a PDF item's parts still carry the stored 600px
face (§6b is a decision, and an accidental future change to the pdf branch
should fail a test, not ship quietly).

**Slice 5 — the board picker.** (The capabilities-page half shipped early with
Slice 2 — the kind-aware config row renderer.) Full spec in §7; file by file:

- `server/capability-status.js`: project `boardColumn` on the config row
  (conditional spread — detect's shape stays `{ key, value }`).
- `public/capability-present.js`: `planBoardConfig(cap, board)` — pure, the
  `planBoardPicker` shape.
- `public/board-modal.js`: a placeholder div in the Advanced fold (after Web
  research, before RE-TAGGING); mount the row inside the existing
  `if (canEditAI)` feed `.then()`; state + `syncAdvSummary` chip; the value
  rides `aiOverride` on save.

Tests: the pure planner cases in capability-present.test.js + the feed
assertion; live browser verify on the local "ui" board.

**Slice 6 (measured, optional) — rendition cache** as specified above. Note
the cache key already carries edge+quality, so per-board presets need no extra
key material (a file belongs to one item → one board → one preset).

**Verification (live, after Slice 4):** on the local instance, retag a handful
of "ui" board items at the `high` preset and diff `tag_confidence`/picks on the
fine-grained facets (`viz`, `core_components`) against the current tags; spot
the request payload sizes in the provider dashboard. The board's
`facet_diagnostics` machinery is the existing lens for before/after.

## Cost expectation (so nobody is surprised)

At 1568px on gpt-5.4-mini: ~1,300–1,500 patches ≈ 2,100–2,400 image tokens per
call vs ~490 today (~5×). On Anthropic standard tier: ~1,500 tokens vs ~570.
Gemini: 4–6 tiles (~1,000–1,500) vs ~260–520. Text/prompt tokens dominate the
bill on small-facet boards, so the blended increase is well under 5×. The
preset is the budget dial: `high` ≈ 5× image tokens, `standard` ≈ 3×,
`thumb` = today — and double-check passes multiply whatever you pick (the ui
board's ×3 votes make the preset choice a real budget decision, which is
exactly why it's per-board).
