# Object detection slot — open-vocab boxes on images (local OWLv2 default)

**Status: SLICES 1–3 BUILT (2026-08-01); Slice 4 designed, not built. Slices 1–2
fully verified; Slice 3 (front-end overlay) has its geometry unit-tested — the
visual wiring is pending a live browser verify.
Adds a fourth on-device/provider capability slot — **detector** — beside tagger,
embedder, and transcriber, plus a new **`object` AI-field kind** (Slice 2) that
draws the detected boxes in the lightbox (Slice 3). v1 ships the **local engine
only** (an OWLv2 zero-shot detector on the Transformers.js runtime the embedder
already uses), exactly how the embedder and transcriber shipped local-first; a
paid provider override (`wire.detect` → Gemini / DINO-X) is the deferred
swappable layer (Slice 4). Engine + model locked via research below.
Self-contained for a fresh session.**

**Slice 1 shipped:** the `localDetector` built-in (`Xenova/owlv2-base-patch16-ensemble`
via a real `wire.detect`, mirroring the embedder), the `detectObjects` dispatcher
+ `detect` catalog kind + `resolveDetector(db)` + loader validation + `detect_*`
settings/`ai-config` routes + `detect-test` probe + `detectSection` admin UI.
Capability-driven throughout — a paid detector slots in with zero core change.
6 new tests ([detect.test.js](../test/detect.test.js), stubbed wire — no model
download); full suite green (609). No `object` field consumes it yet (Slice 2).

**Slice 2 shipped:** the `object` field kind end to end. `KINDS += "object"`
+ a kind-tracking placeholder in the mapping modal; object fields excluded from
`buildFieldsPrompt`; a `needsLLM` gate in `extractOne` so an object-only board
skips the model entirely (ai/usage null, tail guarded); a **detector pass** that
reads the ORIGINAL image (`galleryDir`, not the tag thumbnail), splits the
field hint into queries, and stores canonical boxes in `payload.fields[key] =
{ v: [...boxes], why: "Detected: …" }`. Cross-cutting: boxes kept out of the
tagger's text distillation (`typeof v !== "object"`); inference **serialized**
through a promise-chain in `local-detector.js` (extract runs 2-wide); an interim
`"N objects detected"` lightbox render (`Array.isArray(v)`) until the Slice 3
overlay. Decisions taken: detector failure **throws → requeue** (matches
extractor downtime); **global** `detect_threshold` (per-field deferred);
non-image items → empty, not error. 2 new pure tests in
[extraction.test.js](../test/extraction.test.js); full suite green (611). The
live extract→boxes path follows the file's convention (manual verify), atop the
Slice 1 engine smoke test.

**Model settled — one field per object type (refinement 2026-08-01):** an `object`
field IS one object type; the hint's commas are **synonyms for the same thing**
(better OWLv2 recall), not a list of different types — so the per-field overlay
colour is per-type. No hint → the **de-snaked field key** is the query (`license_plate`
→ "license plate"). All object fields' queries run in **ONE** OWLv2 pass (it takes
a candidate list natively) and each box is routed back to its field by the matched
query (OWLv2 echoes the query as the box label; demux is normalized, first-field
wins on a shared query). Placeholder reworded to teach this. Also fixed post-push:
the server's `MAPPING_KINDS` validation whitelist didn't include `object` (board
save was rejected — `5a4a770`), and the detector is now labelled by its model
("Local Object Detector (OWLv2)", not the runtime).

**Slice 3 shipped:** the lightbox overlay + panel list. Object fields render in
the existing **AI-extracted fields** section (they already route there — `from:"ai"`,
no `src`) as a hoverable list — one row per detection (colour swatch · label ·
score), an `object` badge on the field key (mirroring the `file` badge), and a
"No objects detected" empty state; the redundant synthesized `why` is dropped. On
the image, a `pointer-events:none` overlay draws per-field-coloured boxes with
label chips, positioned as percentages of a container sized to the displayed
image content rect (contain-aware). Hovering a list row highlights its box
(linked by a `key:idx` handle). Repositions on image load / window resize / panel
toggle (the `.panel-open` padding shift resizes the stage); clears on
media-switch / panel-close. The contain-fit math + per-field colour live in a
pure [det-geometry.js](../public/det-geometry.js) — 6 unit tests
([det-geometry.test.js](../test/det-geometry.test.js)); full suite green (617).
The DOM wiring (overlay placement, hover, toggle) is front-end — **pending a live
browser verify** (the codebase convention for the lightbox, which has no DOM
tests).

## Scope, and the one boundary that governs everything

The user's ask, precisely: an `object` field where a user types a text
instruction ("every visible logo", "faces"), and the lightbox **overlays boxes**
on the image for each detected object. Multiple objects per image → multiple
boxes on the one image. **No cropping, no per-entity face regions, no membership
side effects.** An `object` field is a **descriptive/visual field** — it
annotates pixels, exactly like `text`/`number` annotate content. It does **not**
decide which entities an item belongs to.

That scope call matters because this feature landed in the same conversation as
the new *match-to-list identity* + *multi-entity membership* work
([identity-classify-mode-plan.md](identity-classify-mode-plan.md)), and it's
tempting to wire them together. **Don't.** Detection annotates; identity decides
entities. They compose only by staying in separate lanes. If "detected a dog →
file under the Dog entity" is ever wanted, it's a deliberate opt-in bolted on
later (a detector could then produce `identity.values` the same way the LLM
classifier does) — not something the overlay feature implies. v1 keeps them
fully decoupled.

### Detection ≠ recognition (why the instruction is a noun, not a name)

Open-vocab detection grounds a text prompt to a visual **category** seen in
training — "person", "face", "dog", "logo", "collar". It finds and boxes every
instance. It **cannot** identify a specific named individual: "Emma Watson" vs
"Emma Roberts" is *recognition*, and OWLv2 has no idea who Emma Watson is —
prompting it with a proper noun fires on any face or nothing. Recognition of
famous people already works today via the vision **LLM** (Claude/Gemini have
world knowledge of faces) in the identity lane; recognition of *arbitrary*
people (your uncle Bob) would need a whole separate subsystem (face detector →
face **embedder** → reference gallery → threshold) and is explicitly **out of
scope**. So an `object` field's instruction is a category/noun the detector can
ground — never a name. This is the single constraint to hold onto: **the
detector localizes, it never names.**

## Engine decision (researched 2026-08-01)

**`Xenova/owlv2-base-patch16-ensemble` (OWLv2 base), run via the Transformers.js
`zero-shot-object-detection` pipeline on `onnxruntime-node`, `q8` (~155 MB) or
`fp16` (~308 MB) weights.** It's the best open-vocab detector that runs headless
on CPU *in the runtime we already ship* — the embedder drives the exact same
`pipeline()` from `@huggingface/transformers ^4.2.0`
([local.js](../server/ai-providers/local.js), [package.json](../package.json)).
Same loader, same on-disk cache, same process — **no new runtime, no sidecar,
no new dependency.**

- **Text-promptable at runtime** — arbitrary noun queries, no re-export. Returns
  `{ score, label, box: {xmin,ymin,xmax,ymax} }` in **absolute pixels** of the
  image fed. Boxes + scores + labels; **no masks** (fine — we only draw boxes).
- **Never the `int8` variant** of the OWL family — it fails to load in ONNX
  Runtime (missing `ConvInteger` kernel for the vision-embedding conv); that's
  why the repo ships `q8`/`uint8`/`fp16` instead. Use `q8` (lean) or `fp16` (box
  quality); keep the visual backbone ≥ fp16.
- **Tiering, all behind the one capability** (user-selectable like embed models,
  the model is data not code — [[feedback_flexibility_over_guardrails]]):
  - **Default:** OWLv2 base — best local accuracy/speed, text-promptable.
  - **Light:** `Xenova/owlvit-base-patch32` (OWL-ViT, ~127–155 MB) for
    constrained hosts / simple single-object prompts.
  - **Quality:** `onnx-community/grounding-dino-tiny-ONNX` — better on COCO-style
    prompts but **~5 s/image on CPU** (Grounding DINO needs Transformers.js
    ≥ 3.3.0; we're on 4.x). Opt-in, not default.

Rejected: **YOLO-World** (no maintained JS path; its vocabulary freezes at ONNX
export, and the CLIP text encoder isn't in the graph — you'd hand-assemble text
embedding in JS). **`Xenova/yolos-tiny`** (the obvious-looking pick — but it's
fixed 80 COCO classes, **not** open-vocab, so it can't take a user's
instruction). **Sending the image to the tagger LLM for boxes** (Claude/GPT are
unreliable at precise localization; Gemini is decent but that's the deferred
*paid override*, not the local default — same local-first shape as the embedder).

## The design — three parts

### 1. The detector capability — `detects` slot (mirrors `embeds`/`transcribes`)

A fourth capability on the provider descriptor, advertised exactly like the
others — core owns the contract, nothing in core enumerates which providers
detect:

- **Descriptor field** `detects: {default, models[]} | null`, parallel to
  `embeds`/`transcribes` ([providers.js](../server/providers.js)).
- **New built-in** [`server/ai-providers/local-detector.js`](../server/ai-providers/local-detector.js)
  — a dedicated core, keyless, `onDevice` provider "Local Object Detector
  (Transformers.js)", the peer of "Local Embedder (Xenova)". Lazy-singleton
  `pipeline("zero-shot-object-detection", model, { dtype })` cached like the
  embedder's `_localPipeline` ([local.js:13-18](../server/ai-providers/local.js#L13-L18)).
  Registered in [`BUILTIN_PROVIDERS`](../server/ai-providers/index.js).
- **`resolveDetector(db, board?)`** in [worker.js](../server/worker.js), mirroring
  `resolveEmbedder` ([worker.js:113](../server/worker.js#L113)) and
  `resolveTranscriber` ([worker.js:762](../server/worker.js#L762)): local
  selected by name, paid by key id; returns an engine descriptor
  `{ id, model, detect(imageBuf, queries[]) → detections[] }`. `id:model` (e.g.
  `local:owlv2-base`) is the identity any cache would stamp against.
- **Settings** `detect_enabled` / `detect_provider` / `detect_key_id` /
  `detect_model` (+ migration), and config routes in
  [server.js](../server/server.js#L1952) beside embed/transcribe. **No enabled
  toggle needed** if we treat an `object` field's mere presence as opt-in;
  otherwise mirror the embedder's enable flag.
- **Loader validation** ([plugin-loader.js:90](../server/plugin-loader.js#L90)):
  widen the capability reject to "tag, embed, transcribe, **or detect**", and
  require `wire.detect` to be a function when `detects` is set.
- **The local detector rides a real `wire.detect`, mirroring the *embedder*, not
  the whisper sidecar.** Whisper is `wire: null` only because it's an external
  HTTP sidecar with a bespoke resolver ([worker.js:680](../server/worker.js#L680));
  our detector is in-process ONNX — identical to the embedder's `wire.embed`
  ([local.js:29](../server/ai-providers/local.js#L29)) — so it dispatches through
  a `detectObjects()` function ([providers.js](../server/providers.js#L134), the
  clone of `embedTexts`) with no `provider === "local"` branch. This makes
  `resolveDetector` *simpler* than `resolveTranscriber` (both local and paid go
  through the one dispatcher). **Only an actual PAID detector descriptor is
  deferred** — the dispatcher, resolver, and loader validation are built in
  Slice 1, so a Gemini `wire.detect` (`[ymin,xmin,ymax,xmax]/1000`, Y-first) or
  hosted DINO-X slots in later with zero core change. Ship local-only first:
  zero external deps, zero keys.
- **Config UI** mirrors the embedder's per-provider section — a `detectSection`
  in [plugin-modal.js](../public/plugin-modal.js) gated on
  `capabilities.detect`, plus detector defaults in
  [admin-plugins.js `getDefaults`](../public/admin-plugins.js#L29). The Local
  Detector card shows its model as a note; a paid card offers a model picker +
  key + Test.

### 2. The `object` field kind — a separate detection pass, not a tool call

`KINDS += "object"` at [mapping-modal.js:7](../public/mapping-modal.js#L7) (and a
placeholder tweak: "describe the object(s) to find"). Detection is **not** an LLM
tool call, so it does **not** ride the `record_fields` schema — object fields are
**excluded** from `buildFieldsPrompt`
([worker.js:325-420](../server/worker.js#L325-L420)) so the LLM is never asked to
produce boxes.

In `extractOne` ([worker.js:1514](../server/worker.js#L1514)), split the mapping's
AI fields:
- **object-kind fields** → `resolveDetector()`, then `detect(image, queries)` per
  field. The field's `hint` is the query text (comma-split into multiple noun
  queries; a future nicety is reusing the match-to-list `candidates` editor as an
  explicit query set — OWLv2's multi-query input *is* a candidate list). OWLv2
  can take all object-field prompts in one call and demux by label — a batch win
  when a board has several object fields.
- **everything else** → the existing LLM tool-call, unchanged.

Merge both into `payload.fields`, unchanged storage shape:
```jsonc
// payload.fields["logos"]
{ "v": [ { "label": "logo", "box": [0.12,0.44,0.28,0.61], "score": 0.91 },
         { "label": "logo", "box": [0.70,0.10,0.83,0.22], "score": 0.77 } ],
  "why": "2 logos detected" }
```
- **Canonical box format = xyxy, normalized 0–1, top-left origin.** Normalize at
  the boundary: the OWLv2 pipeline returns pixel xyxy → divide by the fed image's
  `w`/`h`. (A paid Gemini adapter divides by 1000 and reorders Y-first → same
  canonical.) Normalized coords map onto both thumbnail and original, so the
  overlay is resolution-independent.
- **Feed the ORIGINAL image, not the AI thumbnail.** The detector runs
  server-side, so it reads the full-res original via `RawImage`/sharp (sharp is
  already a dep) rather than the downscaled webp the LLM gets — small objects
  survive. OWLv2 resizes to ~960px internally anyway; a ~1024px cap is a sane
  input ceiling.

Validation at [worker.js ~1488](../server/worker.js#L1488): for `object`, coerce
to an array of `{ label:string, box:[4 numbers in 0..1], score:number }`, drop
malformed entries; `[]` is a legal "found nothing".

### 3. The lightbox overlay — the only net-new UI surface

The lightbox already shows the image and a fields section
([lightbox.js:160](../public/lightbox.js#L160)). For an `object` field, instead
of rendering text, draw the boxes over the existing `<img>`:
- Absolutely-positioned divs over the image element, each at `box × renderedImgSize`,
  labeled with `label` + `score`; recompute on resize.
- A companion list of `label · score` rows beneath; hover a row → highlight its
  box. Toggle boxes on/off.
- Empty state ("no objects found") matters more than usual — zero-shot whiffs on
  anything niche (see Risks).

Everything upstream (extract pass, storage, capability plumbing) is the existing
machinery; this overlay is the substantial new work.

## Slices

### Slice 1 — the local detector capability (self-contained, no field yet) ✅ BUILT & VERIFIED (2026-08-01)
Twelve mirror-the-embedder/transcriber seams: `local-detector.js` (OWLv2 lazy
singleton with a real `wire.detect` that decodes via `RawImage` and **normalizes
pixel xyxy → canonical 0–1 in the engine**); register in `BUILTIN_PROVIDERS`; the
`detectObjects()` dispatcher + `KIND_CATALOG.detect` + `providerCatalog().detects`
in [providers.js](../server/providers.js); `resolveDetector(db, board)` in
[worker.js](../server/worker.js) (default resolves to local by name — both local
and paid route through the dispatcher, so it's simpler than `resolveTranscriber`);
loader validation ([plugin-loader.js:90](../server/plugin-loader.js#L90) — widen
the reject + require `wire.detect` when `detects` is set); `capabilities.detect =
!!p.detects`; `detect_provider`/`detect_key_id`/`detect_model` settings +
GET/POST `ai-config` + `detect-test` route ([server.js](../server/server.js#L1969));
`detectSection` in [plugin-modal.js](../public/plugin-modal.js) + detector default
in [admin-plugins.js](../public/admin-plugins.js). **No `detect_enabled` flag** —
detection is field-triggered (Slice 2), not a global sweep, so the provider choice
(defaulting to local) is the only knob; a `detect_threshold` setting is worth
adding here (OWLv2 scores run low — start ~0.1). Verify standalone via
`detect-test` and a `resolveDetector(db).detect(imageBuf, ["a cat."])` unit test →
boxes. No external deps, no keys, no field yet.
**Verified 2026-08-01:** 6 stubbed unit tests ([detect.test.js](../test/detect.test.js))
+ full suite green (609); a one-off real-engine smoke test loaded OWLv2 `q8`,
decoded a synthetic image, and returned accurate normalized boxes (a drawn red
circle @ 0.886 and black rectangle @ 0.471, coords matching where they were
drawn) in ~9.4 s cold on CPU — proving the one path the unit tests stub
(`dtype:"q8"` load, `RawImage.fromBlob`, output shape + 0–1 normalization).

### Slice 2 — the `object` field kind + extraction pass ✅ BUILT & VERIFIED (2026-08-01)
`KINDS += "object"` + a kind-tracking hint placeholder ([mapping-modal.js](../public/mapping-modal.js));
object fields excluded from [buildFieldsPrompt](../server/worker.js#L325); a
`needsLLM` gate in [extractOne](../server/worker.js#L1562) (object-only board →
no model call; `ai`/`usage` null, else-branch/`bumpUsage`/return guarded); the
detection pass reads the ORIGINAL image (`galleryDir`), splits the hint into
queries, stores `{ v: [...boxes], why }`. Cross-cutting the close look surfaced:
boxes kept out of the tag distillation ([worker.js tagOne](../server/worker.js)
`typeof v !== "object"`); inference **serialized** via a promise chain in
[local-detector.js](../server/ai-providers/local-detector.js) (extract is 2-wide);
an interim `Array.isArray(v)` → "N objects detected" render in
[lightbox.js](../public/lightbox.js) until Slice 3. Decisions: detector failure
throws → requeue; global `detect_threshold`; non-image → empty. Verified: 2 pure
tests in [extraction.test.js](../test/extraction.test.js) (object fields excluded
from schema/prompt; object-only → empty schema); full suite green (611). An
object field on an image board now populates boxes on first extract.

### Slice 3 — the lightbox overlay UI ✅ BUILT (2026-08-01; visual pending live verify)
Object fields render in the existing **AI-extracted fields** panel section as a
hoverable list (swatch · label · score) with an `object` key badge + empty state
([lightbox.js `fieldsSection`](../public/lightbox.js)); a `pointer-events:none`
box overlay on the image (per-field colour, label chips, % positioning over a
contain-aware content rect); list-row hover → box highlight via a `key:idx`
handle; reposition on load/resize/panel-toggle, clear on media-switch/close. The
contain-fit geometry + colour hash are pure in
[det-geometry.js](../public/det-geometry.js) (6 unit tests); the DOM wiring is
manual-verify. Overlay is panel-tied (detections load with the Details panel).

### Slice 4 (deferred) — paid override
`wire.detect` for Gemini native detection (and/or hosted DINO-X), surfaced
through the same detector-default selector. Better boxes on hard/rare/
compositional prompts; the local default stays the free, keyless floor.
**Must-not-forget (cleanup pointers):** when the first *keyed* detector lands,
extend `deleteAiKey` ([db.js](../server/db.js#L776) — clears `embed_*`/
`transcribe_*` today) to also clear `detect_provider`/`detect_key_id`/
`detect_model`, and `cleanupPluginConfig` ([plugin-loader.js:460](../server/plugin-loader.js#L460))
to clear a name-based `detect_provider` on uninstall — otherwise a deleted key or
uninstalled detector plugin leaves a dangling pointer the UI shows as configured
while `resolveDetector` silently falls back to local. Not reachable in Slice 1
(the only detector is core + keyless), so deferred here on purpose.

## Verify (compose stack)
1. Slice 1: resolve the local detector, `detect(imageBuf, ["logo."])` on a known
   image → plausible boxes+scores; confirm the OWLv2 model loads from the baked/
   cached weights and inference is serialized (one pipeline instance).
2. Slice 2: upload an image to a board with an `object` field ("every face") →
   after extract, `payload.fields["faces"].v` is an array of normalized boxes;
   re-extract is stable.
3. Slice 3: open the lightbox → boxes drawn over the image, labeled; hover a list
   row highlights its box; an image with nothing matching shows the empty state.
4. `npm test` green.

## Risks / notes
- **Zero-shot fails on out-of-distribution domains.** Near-magical on common
  objects; both OWLv2 and every zero-shot detector score under ~2% on medical/
  industrial/thermal imagery. The `object` field will feel great on everyday
  nouns and can whiff on niche domains — the empty state and per-box `score` are
  the honest signal, not a bug.
- **CPU latency is the throughput knob, not correctness.** OWLv2 base is
  sub-second-to-a-few-seconds/image on CPU (unbenchmarked on our hardware —
  measure before promising speed); Grounding DINO ~5 s. Detection runs per-image
  at ingest, so a slow model occupies a worker slot like a big OCR job — same
  shape as the extractor/transcriber. Serialize inference through one pipeline
  instance; **warm the singleton at boot** so the one-time download + graph
  deserialization overlaps idle time; don't load OWLv2 in many workers at once
  (cache race).
- **Memory is runtime, not file size.** OWLv2 has large activations and a large
  fixed input (~960px) — give it real RAM, fix the input resolution, set
  `intraOpNumThreads`. `q8` (~155 MB weights) over `fp16` (~308 MB) if
  RAM-constrained; **never `int8`** (won't load).
- **Offline bundling — decide at Slice 1.** First use pulls OWLv2 from HF Hub to
  `node_modules/@huggingface/transformers/.cache`. For a bundled/offline deploy,
  pre-ship the ONNX and set `env.allowRemoteModels=false` + `env.localModelPath`
  (mirrors how the embedder/whisper models are baked). Affects the Docker image
  size vs cold-start tradeoff.
- **Recognition creep.** The first request to make the detector tell one named
  person from another breaks the design. Keep instructions to grounding-able
  nouns; route "who is this" to the LLM identity lane; treat arbitrary-face
  recognition as a separate future subsystem, never an object-field feature.
- Aligns with [[feedback_flexibility_over_guardrails]] (model is a
  settings/env-level choice, engine tiers are data) and
  [[feedback_dont_inherit_past_decisions]] (reuses the embedder's local-first
  capability shape rather than defaulting to a paid vision API).

## Pointer
This adds the fourth engine slot after the tagger, the embedder
([semantic-search-plan.md](semantic-search-plan.md)), and the transcriber
([transcription-plan.md](transcription-plan.md)) — same contract: a job (image →
boxes) with interchangeable local/provider engines, local-first. The single
integration point on the field side is the `object`-kind branch in `extractOne`;
everything downstream is the existing `payload.fields` storage and the lightbox.
Deliberately **decoupled** from the identity/membership work
([identity-classify-mode-plan.md](identity-classify-mode-plan.md)): detection
annotates pixels, identity decides entities, and v1 keeps the lanes separate.
