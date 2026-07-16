# Face pipeline — one pluggable pipeline for card-face generation

**Status: PLANNED (not started). A behavior-identical refactor that pulls "make
a card face" out of the four places it currently lives into one registry of
named face producers — the enabling substrate for the deferred media/source
plugin tier (audio → whisper, etc.). Self-contained for a fresh session.**

## The insight

Every kind of material in the app shows itself in a card the same way: a
**face** — a `{ webp, w, h }` image stored at `thumbsDir/<name>.webp`, which the
client renders generically from `item.name` + `item.w/h`. The OUTPUT side is
already unified (one storage convention, one generic client renderer in
`public/kinds.js`). What is NOT unified is the PRODUCTION side: the code that
turns material into that webp is reinvented in four unrelated places, reached
through three different layers, with no shared contract.

Pulling "face production" out as its own axis:
- kills a real scattering (four bespoke webp-makers → one registry);
- is the **precondition for media plugins**: if a face is always "a
  server-produced webp from a named, registered producer," a plugin can
  contribute a producer and have it reach the client with **zero client-side
  code** — which is exactly what keeps the plugin tier "server-only" (the
  property that made the existing three plugin kinds safe and simple). See
  `planning/phase-2-dynamic-loading-plan.md` for that tier's constraints.

This is architectural/enabling work. It adds no user-visible feature on its own;
its payoff is the media tier and the cleanup. It is small and low-risk (slices
1–2 are behavior-identical). Do it as the foundation when committing to media
plugins, or as a cheap standalone tidy — not urgent on its own. Weigh against
[[flexibility-over-guardrails]] / "keep it lean": this is indirection that only
pays off later, so it is explicitly optional until the media tier is real.

## Repo context (skim if you know the app)

001az: agnostic boards/entities app. Node/Express + Postgres, build-less
vanilla-JS frontend, docker compose on :8001, tests `npm test` (node:test).
An **item** = `{ identity, files, fields }`; a file entry = `{ name,
original_name, kind, w, h, … }`. The card face is `thumbsDir/<name>.webp`; the
original (when there is one) is `galleryDir/<name>`. `public/kinds.js` renders
the face from the file entry — `imageKind`/`docKind`/`connectorKind`, dispatched
by `kindFor(item)`. None of that changes here (the output contract is already
what we want).

## The as-is map — four producers, two triggers, one output

| producer | where | input | writes | trigger |
|---|---|---|---|---|
| image thumbnail | `sources/image.js:83` (inline in `ingest`) | decoded buffer | `sharp(...).toFile(thumbsDir/<name>.webp)` | **ingest** (sync, one-shot) |
| pdf page-1 | `sources/pdf.js:87` `renderPdfPreview(pdfPath, thumbPath)` | file on disk | pdftoppm→png→`sharp.toFile(thumb)` | **ingest** |
| text page-peek | `sources/shared.js` `renderTextPreview(text, thumbPath)` | extracted text | svg→`sharp.toFile(thumb)` | **ingest** |
| connector chart | `connectors/faces/price-chart.js` `renderChart(series, opts)` | live price series | returns `{ webp, w, h }` bytes; **caller** writes | **refresh** (cadence, via `worker.js:508 generateFace`) |

Observations that shape the design:
- **Output is already standard** everywhere: `{ webp, w, h }` → `thumbsDir/
  <name>.webp` → generic client. The client needs **no change**.
- **Two legitimately different triggers.** File faces are produced once, synchronously,
  at ingest from bytes on disk. Connector faces are produced on a cadence, from
  live data re-fetched per render (re-resolved by symbol on a provider switch),
  stored as a `generated: true` file, tracked via `entities.face_at`, regenerated
  under a new random name. **Do NOT try to unify the triggers** — only the
  producer contract, the storage step, and the registry.
- **Two output styles today** (an inconsistency the pipeline resolves): three
  producers write-to-path (`toFile`), one returns bytes. Standardize on
  **returns `{ webp, w, h }` bytes**; a shared `storeFace` writes. (Bytes compose
  better: a generated connector face writes to `galleryDir` AND `thumbsDir`;
  webp thumbnails are tens of KB, so buffering vs. streaming is a non-issue on
  the small droplet.)
- **Face doubles as model input.** `worker.js modelInputFor` reads
  `thumbsDir/<name>.webp` as the tagger's image part, and a `file.generated`
  chart gets a chart-aware anchor (`worker.js:649`). This coupling is a separate
  axis (model input, not face) and is **left exactly as is** — the pipeline only
  changes *how the webp is produced*, not who reads it afterward.

## The model

### The producer contract
A **face producer** is a pure-ish async function:

```js
// input is producer-specific (a buffer, a file path, a data series);
// opts carries labels/period/etc. Returns null when it can't render
// (unknown series, missing binary) — the caller keeps the fallback (tile/badge).
async (input, opts) => ({ webp: Buffer, w: number, h: number }) | null
```

### The registry — `server/faces/index.js`
A name-keyed map of producers, mirroring the connector/provider registries so it
can later be mutated by the loader (register-last, single-source):

```js
FACE_PRODUCERS = { "image-thumb": fn, "pdf-page": fn, "text-peek": fn, "price-chart": fn }
getFaceProducer(name)               // null if absent
registerFaceProducer(name, fn)      // phase-2 plugin seam (slice 3)
unregisterFaceProducer(name)
```

Optional metadata per producer (label, `requires`) is NOT put here — `requires`
("this face needs the provider's `history()`") stays a **connector-manifest**
concern (file faces have no provider). The registry holds only the fns.

### The shared write step — `storeFace`
One helper replaces the three copies of "write the webp + capture w/h":

```js
// Writes rendered.webp to thumbsDir/<name>.webp (+ galleryDir/<name> when
// `generated`, since a connector face is its own original). Returns a file-entry
// fragment { name, w, h } the caller merges into its file object.
storeFace({ galleryDir, thumbsDir }, name, rendered, { generated = false } = {})
```

### The two orchestrators keep their own shape
- **File handlers** (ingest-time): after storing the original, call
  `getFaceProducer(kindProducer)(input)` → `storeFace(dirs, name, rendered)`.
  Same code, same moment — just sourced from the registry instead of an inline
  block. A handler declares which producer it uses (e.g. image → `image-thumb`).
- **Connector faces** (refresh-time): `worker.js generateFace` already fetches
  the series and writes both files; it swaps its `conn.produceFace` call for
  `getFaceProducer(faceCfg.producer)(series, opts)` + `storeFace(dirs, name,
  rendered, { generated: true })`. The connector keeps declaring `faces:
  [{ name, requires, periods }]` and wiring the input (history()).

**Net:** producers become a shared, named, pluggable pool; the *when* and the
*what input* stay owned by the handler/connector; the *store* is one helper; the
client is untouched.

## Slices

### Slice 1 — registry + extract the chart producer (behavior-identical)
- New `server/faces/index.js` (the map + `getFaceProducer`/`register`/`unregister`)
  and `server/faces/price-chart.js` (**git mv** from `connectors/faces/`; unchanged).
- Register `"price-chart"`. `connectors/runtime.js produceFace` and
  `worker.js generateFace` resolve the producer via `getFaceProducer(faceCfg.producer)`
  instead of `conn.faces?.[…]`. Connector manifests declare `faces: { chart:
  "price-chart" }` (a NAME string, not the imported fn) — the connector no longer
  imports the renderer; the registry owns it.
- Add `storeFace` (in `server/faces/index.js`); route `generateFace`'s two
  `writeFile`s + the `generated:true` entry through it.
- `ctx.renderChart` in `plugin-loader.js` (currently imported straight from
  `connectors/faces/price-chart.js:30`) re-points at the registry — keeps the
  plugin `ctx` surface stable.
- Tests: the existing connector-face tests (`slice-5d`) pass unchanged; add one
  that `getFaceProducer("price-chart")(series)` returns `{ webp, w, h }` and that
  an unknown name returns null. `git mv` keeps history.

### Slice 2 — route the file handlers through the registry (behavior-identical)
- Extract the three inline thumbnail renderers into named producers:
  `server/faces/image-thumb.js` (from `image.js` ingest — resize→webp **toBuffer**),
  `server/faces/pdf-page.js` (from `pdf.js renderPdfPreview` — pdftoppm→sharp toBuffer),
  `server/faces/text-peek.js` (from `shared.js renderTextPreview` — svg→sharp toBuffer).
  Each returns `{ webp, w, h } | null`; storage moves to the caller via `storeFace`.
- Handlers declare their producer (`image` → `image-thumb`, `pdf` → `pdf-page`,
  `text`/`docx` → `text-peek`) and call `getFaceProducer(name)(input)` +
  `storeFace`. `image.js`'s serialize-processing gate and `pdf.js`'s page-cap stay
  in the handler (orchestration, not production).
- After this, **all four faces are registry producers** and there is exactly one
  write path. Tests: existing ingest/preview tests (image dims, pdf w/h 600-ish,
  text 600×760) pass unchanged; they now also assert the producer is resolvable
  by name.

### Slice 3 — make the registry pluggable (the media-tier seam; defer until needed)
- `registerFaceProducer`/`unregisterFaceProducer` become live-mutation seams the
  dynamic loader calls (register-last, same discipline as
  `registerProvider`/`registerConnector`). A plugin's `ctx` gains
  `ctx.registerFace`? — NO: a plugin does not register faces directly; a **media
  handler plugin** (the deferred kind) *declares* a face producer in its module
  object, and the loader registers it, exactly as connector-domain registers its
  providers. So this slice is really "the loader knows how to register a
  plugin-supplied face producer," and it lands **with** the media/source plugin
  kind, not before it.
- This is where **audio** plugs in: an audio handler ships a `waveform` producer
  (server-side SVG/canvas → webp, like `price-chart`); transcription is a
  separate concern (a sidecar, per the media plan). No client code ships.
- Deferred deliberately — build slices 1–2 as the standalone cleanup/foundation;
  build slice 3 as part of the media-plugin tier when that is actually scoped.

## Verify (compose stack, per slice)
1. After slice 1: a crypto board with a chart face renders identical webps
   (same bytes for the same series), refresh cadence + `face_at` behavior
   unchanged, the symbol-tile fallback still triggers when the provider has no
   `history()`. Plugin `ctx.renderChart` still works (install the reference
   connector plugin if present).
2. After slice 2: upload an image, a pdf, a txt/md/csv, a docx → each gets its
   exact same face as today (image dims preserved, pdf page-1 preview, text
   page-peek, docx badge/peek), byte-for-byte where deterministic; cleanup still
   removes the thumbnail.
3. `npm test` green after each slice (the whole point is behavior-identical).

## Risks / notes
- **Over-abstraction is the main risk.** The value is a real scattering removed +
  the media-tier seam — NOT a grand "everything is a pipeline" framework. Keep
  the contract to `(input) → { webp, w, h } | null` + `storeFace`; do not unify
  the two triggers, do not fold model-input into it, do not add a producer
  base-class. If slices 1–2 don't feel like a net simplification, stop.
- **Output-style change (toFile → toBuffer)** for image/pdf/text is the only
  behavior nuance: a thumbnail is briefly held in memory before `storeFace`
  writes it. Thumbnails are tens of KB; negligible even on the 458 MB droplet.
  If it ever mattered, a producer could opt into streaming — not worth it now.
- **`connectors/faces/` disappears** (moved to `server/faces/`). Update the
  `slice-5d-connector-faces-plan.md` pointer and any comment referencing the old
  path. `git mv` preserves history; check `plugin-loader.js` + `crypto/index.js`
  + `stocks/index.js` imports.
- **No migration, no schema change, no client change.** `entities.face_at`,
  `payload.files[].generated`, `kinds.js`, and the storage convention are all
  untouched — this is purely a server-side reorganization of *how the webp is
  made*.
- **deploy.ps1 is `COPY . .`** (no artifact list) — new `server/faces/*` need no
  deploy edits.

## Pointer
This is the first enabling slice of the media/source plugin tier ("Path B" —
install a file-type handler, e.g. audio + whisper, from a URL). That tier also
needs: a client that stays generic (this pipeline delivers it — server-produced
faces + a mediaType-dispatched detail view, no per-plugin client JS), a binary
story (whisper as a sidecar service, the existing `extractor:3002` pattern), and
the loader learning a `media` kind. See `planning/phase-2-dynamic-loading-plan.md`
for the loader constraints and the media/source deferral note.
