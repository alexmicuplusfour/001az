# Audio media type — core support + waveform faces (transcription deferred)

**Status: SHIPPED — COMMITTED + PUSHED to main 2026-07-18 as `157a5d2` (383 tests
green, +13 new; board-modal.js excluded). All four slices done. Both user-resolved forks held: faces are real ffmpeg
waveforms; the upload limit is per-file-type + admin-adjustable (persisted in the
plugin `config` blob). Deviations found while building are marked ✦ below; the
rest of this doc is the as-built design.**

## Deviations from the plan (improvements found while building)
- ✦ **Per-type limits apply DURING the ingestion walk, not only at admit.** Post-
  filtering candidates breaks the folder walk's `limit` counting (a `limit=1`
  scan could return an about-to-be-rejected oversize file). So the source-backend
  `list()` contract changed from a scalar `maxBytes` to a `maxBytesFor(name)`
  function (folder/ftp/s3); the adapter passes the effective per-type resolver,
  and admitFile re-checks as the authority.
- ✦ **multer stays a FIXED absolute ceiling** (`UPLOAD_HARD_CEILING`, 100 MB, env-
  tunable, in `server/upload-limits.js`) — NOT the max per-type limit — so an
  admin override can raise a type without a redeploy. Per-type limits enforce in
  admitFile with a readable `err.reason`, and are **clamped to the ceiling** in
  `mediaLimits` so the client is never offered a size multer would 413 (review
  pass). The ceiling also bounds the worst-case per-request tmp spool.
- ✦ **audioKind WAS added** (the plan considered reusing docKind). Justified: the
  doc face cover-crops (`object-fit: cover`, top center) → it would show only the
  middle ~40% of a 3:1 waveform. audioKind shows the whole waveform (contain), ♪
  badge fallback.
- ✦ **The audio handler is buffer-free** (`parseFile` + `copyFile` + `stat`, not
  `readFile`/`parseBuffer`/`writeFile`) so a 50 MB upload is never held whole in
  node memory (the droplet is small); ffmpeg reads the path, music-metadata
  streams. `music-metadata` is v11.
- ✦ **The override lives in the plugin `config` blob as BYTES** (no bespoke
  setting): the media `configSchema` gained a `maxBytes` number field so the
  EXISTING PATCH route validates + persists it and `mediaLimits` reads it; the
  admin modal shows MB and converts. Clearing (blank → null) restores the
  manifest default.
- ✦ **Zero changes needed (as predicted):** `documentTextFor` falls through to
  `return ""` for audio (the future transcription seam), CSP `media-src` falls
  back to `default-src 'self'`, and `media:audio` auto-appears on the Plugins
  page. Also **no client accept-list edit in Slice 2** — Slice 0 made it data-
  driven, so audio became acceptable the moment its manifest landed.
- Note: the UI (card face + lightbox player + admin knob) was verified by
  field-contract tests + `node --check` + review, NOT a headless screenshot —
  the repo deliberately carries no puppeteer/playwright (same call as the face-
  pipeline slice-3).

## The split (why this is two threads, and what's deferred)

"Audio" is three separable capabilities wearing one coat. The dividing question
is *"would a second, different plugin want this?"* — yes → **core (shared)**;
no, it's one interchangeable choice → **plugin (swappable)**:

1. **Understand an audio file** (accept it, store it, play it) — a transcription
   plugin wants it, a future music-analysis plugin wants it, a "store voice
   memos" board wants it → **core**.
2. **Give it a face** (a waveform) — any audio wants one → **core**, and the
   [face pipeline](../server/faces/index.js) already exists to hold it.
3. **Transcribe it** (audio → text) — whisper is one engine, a cloud API is
   another, a different local model a third → **a slot filled by a plugin**.

**This plan builds #1 and #2 only.** #3 is deliberately out of scope — it is the
swappable slot, and the plan points at exactly where it clips in later so nothing
here blocks it. This mirrors two shapes the app already has: AI tagging (the job
is core; Anthropic/OpenAI are swappable engines) and connectors (the domain is
core; CoinGecko/CoinMarketCap are swappable sources).

The work is **two threads**:
- **Thread B — per-type upload limits.** A reshape that the audio requirement
  forced into view: the flat 10 MB cap is a global assumption duplicated six
  ways. Audio needs a bigger limit, and the right fix is per-type data, not a
  bigger constant. Do this first; audio then rides it. (Born from
  [[feedback_dont_inherit_past_decisions]].)
- **Thread A — audio understand + faces.** Almost pure mirroring of the
  pdf/docx handlers on top of the reshaped foundation.

## Repo context (skim if you know the app)

001az: agnostic boards/entities app. Node/Express + Postgres, build-less
vanilla-JS frontend, docker compose. Tests: `npm test` (node:test). An **item** =
`{ identity, files, fields }`; a file entry = `{ name, original_name, kind, w, h,
size, meta }`. Card face = `thumbsDir/<name>.webp`; original =
`galleryDir/<name>`. A **source handler** (`server/sources/*.js`) turns an
uploaded file into a stored entry + a face; the ingest route stays format-blind.
A **face producer** (`server/faces/*.js`) is `async (input, opts) => { webp, w, h
} | null`, resolved by name from a registry, stored by `storeFace`. A **media
field module** (`server/media/*.js`) projects metadata off a stored entry.
`public/kinds.js` renders the face generically. Adding a media type is, by the
existing design, "one module + one registry entry" in each of those three
places.

## Thread B — per-type upload limits (do first; behavior-identical for existing types)

### The as-is smell — one flat assumption, six copies

| what | where | value today |
|---|---|---|
| upload door hard limit | [`server/ingest.js:16`](../server/ingest.js) `MAX_BYTES` (multer `limits.fileSize`) | 10 MB |
| client pre-filter | [`public/upload.js:6`](../public/upload.js) `UPLOAD_MAX_BYTES` (+ "keep in sync" comment) | 10 MB |
| folder/remote ingestion | [`server/ingestion/files.js:178`](../server/ingestion/files.js) `MAX_BYTES` fed to the walk | 10 MB |
| accepted extensions | [`public/index.html:25`](../public/index.html) `accept=` attr | hardcoded list |
| accepted extensions | [`public/upload.js:21-22`](../public/upload.js) `isImageFile`/`isDocFile` regexes | hardcoded list |
| accepted extensions | [`server/sources/*.js`](../server/sources/index.js) manifests `extensions` | the real source of truth |

The manifests are already the truth for *extensions*; the client just duplicates
it. And the remote-ingestion backends **already accept a per-call `maxBytes`**
([`folder.js:57`](../server/ingestion/sources/folder.js), s3.js, ftp.js) — the
per-type plumbing is half-built, it's just being handed one constant.

### The design — the manifest owns the limit, everything reads it

- **Manifest default.** Each media handler manifest
  ([`image.js:22`](../server/sources/image.js), pdf, docx, text) gains a
  `maxBytes`. Existing types keep 10 MB → **behavior-identical**. This is the
  same "code owns the default" convention the rest of the stack uses
  (CONNECTOR_*/INGEST_* tunables).
- **Settings override (the "adjustable" part).** A per-type override lives in the
  media plugin's existing **config blob** — media types are already plugin defs
  (`media:image`, `media:audio`, …) with `setPluginState(db, id, { config })`
  state ([`server.js:1181`](../server/server.js)). One helper:
  ```js
  // server/media-limits.js (or fold into sources/index.js)
  effectiveMaxBytes(def) => def.state?.config?.maxBytes ?? manifest.maxBytes
  ```
  Nothing new in the schema — reuses the plugin config store and the PATCH route
  that already persists it.
- **Server enforcement, per type.** multer's global `limits.fileSize` drops to
  just the **ceiling** = max effective limit across all types (an absolute
  backstop → 413). The *precise* per-type check moves into
  [`admitFile`](../server/ingest.js#L29), where the resolved handler/kind is
  known: if `spooledSize > effectiveMaxBytes(kind)`, reject with
  `err.reason = "<Type> files are capped at N MB"` (the upload route already
  surfaces `err.reason` to the user, [`ingest.js:141`](../server/ingest.js)).
  multer has already streamed the file to a tmp path, so we're statting a spooled
  file, not buffering it. Feed the coarse ceiling into
  [`files.js`](../server/ingestion/files.js) walks as the enumeration backstop;
  `admitFile` remains the precise gate for folder/remote ingestion too (one gate,
  no drift).
- **Client reads it, stops hardcoding.** New authed `GET /api/media-types` →
  `[{ kind, label, extensions, maxBytes }]`, derived from the manifests +
  `effectiveMaxBytes` (must be available to any authenticated uploader, not just
  admins — distinct from the admin-only plugin catalog). At boot the app fetches
  it once; [`upload.js`](../public/upload.js) uses it for **both** the accept
  filter (kills the two regexes) and the size pre-filter (kills
  `UPLOAD_MAX_BYTES` + its sync comment), and sets the file-input `accept` attr
  from it (kills the hardcoded attr). Keep a tiny built-in fallback list so a
  failed fetch still lets uploads through (graceful).

**Payoff, realized in Thread A:** once audio's manifest lands, the client accepts
audio *automatically* — Thread A ships **no** client accept-list edit. That is
the "unify, don't add a 4th hardcode" principle paying for itself.

## Thread A — audio understand + faces (mirrors pdf/docx)

### Server

1. **`server/sources/audio.js`** — new handler, copy
   [`pdf.js`](../server/sources/pdf.js). `manifest = { name: "audio", label:
   "Audio files", description: "Accept, play & waveform MP3/M4A/WAV/OGG/FLAC",
   extensions: ["mp3","m4a","aac","wav","ogg","oga","opus","flac"], kinds:
   ["audio"], maxBytes: <default, e.g. 50 MB> }`. `ingest(tmpPath, originalName)`:
   magic-byte sniff → read metadata (music-metadata, below) → store original in
   `galleryDir` → render the waveform face (optional/graceful, exactly like the
   pdf preview: a producer-null OR a `storeFace` throw leaves a badge and the
   file still ingests) → return `{ name, original_name, kind: "audio", size,
   meta: { duration, bitrate, sample_rate, channels, codec }, w, h }`. Plus
   `metaFor(entry)` for legacy backfill. **Register in `HANDLER_MODULES`**
   ([`sources/index.js:19`](../server/sources/index.js)).
2. **Metadata via `music-metadata`** (new dependency; pure-JS ESM, **no native
   build** — unlike sharp, so the Docker/win32 story is untouched). Gives
   duration/bitrate/sampleRate/channels/codec (and embedded cover art, if we ever
   want a richer face). Crucially it needs **no binary**, so the metadata path is
   **hermetically testable** and still works when ffmpeg is absent (only the
   waveform degrades).
3. **`server/faces/waveform.js`** — new producer, copy
   [`pdf-page.js`](../server/faces/pdf-page.js). Uses ffmpeg's built-in
   `showwavespic` filter to render the waveform PNG in one shot (same shape as
   `pdftoppm` rendering pdf page-1): spawn `ffmpeg -i <path> -filter_complex
   "aformat=channel_layouts=mono, showwavespic=s=WxH:colors=<hex>" -frames:v 1
   <tmp>.png`, then `sharp → webp`, unlink tmp. Returns `{ webp, w, h } | null`;
   `null` on any failure (no ffmpeg, unreadable audio) → card falls back to a
   badge. **Register `"waveform"`** in `FACE_PRODUCERS`
   ([`faces/index.js:28`](../server/faces/index.js)).
4. **`server/media/audio.js`** — field module, copy
   [`document.js`](../server/media/document.js). `group: "Audio"`, `appliesTo:
   ["audio"]`, fields `duration` / `bitrate` / `sample_rate` / `channels` /
   `codec`, each read from `ctx.meta`. **Register in `KIND_MODULES`**
   ([`media/index.js:16`](../server/media/index.js)). (`duration` wants a
   readable formatter in [`lightbox.js formatFieldNumber`](../public/lightbox.js)
   — mm:ss — a small add there.)
5. **Dockerfile** — `apt-get install -y --no-install-recommends ffmpeg` beside
   poppler ([`Dockerfile:8`](../Dockerfile)), with the same graceful-degradation
   comment: no ffmpeg → no waveform (badge), file still ingests; metadata is
   unaffected (music-metadata is pure-JS).

### Client

6. **`public/kinds.js`** — add `audioKind`. The waveform is a `{webp,w,h}` at
   `thumbnails/<name>.webp`, so the grid face can reuse the doc-style
   waveform-or-badge face ([`docKind.face`](../public/kinds.js#L102) already
   renders exactly that). What audio needs of its own is the **detail view**
   (playback). Add `if (item?.kind === "audio") return audioKind` to
   [`kindFor`](../public/kinds.js#L174). Consider a card-friendly waveform aspect
   and, optionally, a ♪ glyph instead of the "MP3" text badge (polish).
7. **`public/lightbox.js`** — [`showMedia`](../public/lightbox.js#L495) currently
   branches image-vs-doc(iframe). Add an `audio` branch: show the waveform image
   (when present) above an `<audio controls src=fullUrl(name)>`; teardown in
   [`closeLightbox`](../public/lightbox.js#L580) (pause + clear src so it stops on
   close/navigate). `showInstance`/`preloadFull` gain trivial audio awareness.
8. **`public/index.html`** — add `<audio id="lightbox-audio" hidden>` next to
   [`#lightbox-img`/`#lightbox-doc`](../public/index.html#L30). The file-input
   `accept` is now set from `/api/media-types` (Thread B), so no static edit.

### Seams that are already correct (no change needed)

- **Extraction/tagging degrade cleanly.**
  [`documentTextFor`](../server/worker.js#L552) ends in `return ""`
  ([worker.js:584](../server/worker.js#L584)), so an audio file yields "no
  extractable text" today with zero change → `modelInputForExtract` returns null
  → audio skips the extract leg. (Minor: the tag leg's
  [`modelInputFor`](../server/worker.js#L601) tail would send the waveform webp as
  an image part for audio — harmless but meaningless pre-transcription. Optional
  one-liner: audio-with-no-text → a name-only text part, like the connector-entity
  fallback. Low priority; note it.)
- **The plugin catalog card is free.**
  [`mediaDefs()`](../server/plugins.js#L83) auto-generates a `media:audio` core
  capability card from the manifest — appears on the Plugins page with no work.
- **CSP is fine.** No `media-src` in the [CSP](../server/server.js#L174) → it
  falls back to `default-src 'self'`; audio is same-origin (`gallery/<name>`) →
  allowed.

## The deferred boundary — transcription (NOT this plan)

The transcription slot is the swappable part → a plugin, delivered as a
**sidecar** mirroring the existing [`extractor:3002`](../docker-compose.yml#L19)
(PDF text extraction). When built, it clips in at exactly one place: an
`if (file.kind === "audio")` branch in
[`documentTextFor`](../server/worker.js#L584) that POSTs the audio to the
transcription sidecar and returns the transcript — after which audio rides the
**existing** text pipeline for tagging/extraction, unchanged. Whisper is one
sidecar; a cloud API is another. Nothing in this plan needs to change for that to
land — which is the point of building the shared core first.

## Slices (each independently shippable)

### Slice 0 — per-type limits (Thread B)
Manifest `maxBytes` (existing types = 10 MB), `effectiveMaxBytes` helper, multer
ceiling + per-type reject in `admitFile`, `files.js` fed the ceiling,
`GET /api/media-types`, client reads it for accept + size. **Behavior-identical**
for existing types. Tests: existing upload tests pass unchanged; a new test that a
per-type limit rejects an over-limit file with a reason; `/api/media-types`
returns the manifest values (and reflects a config override).

### Slice 1 — audio server
`sources/audio.js` + `faces/waveform.js` + `media/audio.js` + `music-metadata` +
ffmpeg in the Dockerfile; register in the three registries; `audio.maxBytes`
default in the manifest. After this, audio ingests via the API, the waveform card
renders in the grid (docKind renders the webp with **no client change**),
metadata + audio file-fields land. Tests mirror
[`docs.test.js`](../test/docs.test.js)/[`faces.test.js`](../test/faces.test.js):
metadata is deterministic (music-metadata, no binary); the waveform producer
degrades to null/badge when ffmpeg is absent on the host (the exact pattern the
pdf tests use for poppler — "can't reach storeFace without the binary").

### Slice 2 — audio client
`audioKind`, the lightbox audio branch + `<audio>` element, duration formatter.
Playback works end-to-end; the accept-list already admits audio (Slice 0).

### Slice 3 — admin-adjustable limits (the "adjustable" UI)
A **Max upload size** input in the media branch of the plugin config modal
([`plugin-modal.js`](../public/plugin-modal.js), opened by the gear that already
exists on every media card, [`admin-plugins.js:173`](../public/admin-plugins.js)),
saved into the plugin `config` blob via the **existing**
[PATCH route](../server/server.js#L1181) — no new endpoint. `effectiveMaxBytes`
already reads `config.maxBytes` (Slice 0), so this slice is just the control +
wiring. Reset-to-default = clear the override.

## Verify (compose stack)
1. Slice 0: uploading images/pdf/docx/text behaves exactly as today; an
   over-limit file is refused client-side with the right message and, if forced,
   server-side with `err.reason`; folder ingestion respects the same limit.
2. Slice 1: `POST /api/upload` an mp3 → item created, `meta` has duration/bitrate,
   a waveform card shows in the grid (or an extension badge when ffmpeg is absent
   locally), file-fields populate in the mapping modal.
3. Slice 2: open the audio item → it plays; navigation/close stops playback; a
   multi-instance entity switches audio correctly.
4. Slice 3: set audio to e.g. 80 MB in the gear modal → a 60 MB file that was
   refused now uploads; reset restores the manifest default.
5. `npm test` green after each slice.

## Risks / notes
- **ffmpeg is a real system dependency** (like poppler). Graceful everywhere it's
  absent (waveform→badge; metadata unaffected). It's also the only image-size
  bump — `apt-get ffmpeg` is not tiny; acceptable for the capability.
- **Thread B must stay behavior-identical for existing types.** The whole reshape
  is only safe because every current type keeps its 10 MB default; the ceiling
  math and the `admitFile` gate must reproduce today's 10 MB refusal exactly.
- **`music-metadata` is a new dep** — pure-JS, ESM, no native build; verify it
  imports cleanly under the repo's ESM setup and doesn't balloon the bundle
  (server-only, so bundle isn't a concern; `npm ls` after).
- **Raising the effective ceiling raises DISK use**, not memory: multer streams
  uploads to a tmp file and ffmpeg `showwavespic` streams from the path, so the
  458 MB droplet's RAM is fine; the appdata volume grows with larger files —
  worth a word in the README when the audio default lands.
- **Waveform card aspect.** A waveform is wide-and-short; docKind's 200 px
  top-crop peek may clip it. Render the producer at a card-friendly aspect, or
  give `audioKind` a dedicated face that shows the whole waveform. Polish, not
  blocking.
- **`modelInputFor` audio-no-text edge** (above) — decide waveform-as-image vs
  name-only text part; minor, pre-transcription only.
- **deploy is `COPY . .`** — new `server/**`/`public/**` files need no deploy
  edits; the ffmpeg install requires an **image rebuild** (not just a code sync).
- Aligns with [[feedback_flexibility_over_guardrails]] (limits are data +
  adjustable + degrade, never a hard guardrail) and is the concrete first payoff
  of [[feedback_dont_inherit_past_decisions]] (the per-type reshape instead of a
  bigger constant).

## Pointer
Builds directly on the shipped face pipeline (`server/faces/` registry +
`storeFace`) — see [`planning/face-pipeline-plan.md`](face-pipeline-plan.md),
whose slice-3 note already anticipates "audio plugs in here." This plan is the
**core** half of the media tier (understand + face); the **plugin** half
(transcription slot + a whisper sidecar, and eventually a from-URL `media` plugin
kind) is a separate, later plan. Keep them separate: shipping core audio now costs
nothing in the future plugin design and gives the app a real audio feature today.
