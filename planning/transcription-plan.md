# Transcription slot — audio → text for provider-agnostic tagging (local whisper sidecar)

**Status: Slices 1–3 BUILT & VERIFIED (2026-07-19) — the `transcriber/` sidecar
exists and transcribes, the server transcribes audio → tags on the transcript,
and provider transcription is a capability-advertised slot (OpenAI ships; any
provider or plugin advertising `transcribes` slots in). Full suite green (397
pass). This is the deferred
"transcription slot" from [audio-media-plan.md](audio-media-plan.md) — the
swappable half of the media tier. Design + engine locked via research below.
Builds on the audio media tier (committed `157a5d2`): core already ingests,
faces, and plays audio; this teaches it to turn audio into TEXT so it can be
tagged. Self-contained for a fresh session.**

## The split, and why transcribe-to-text (not send-audio-to-the-tagger)

Audio tagging can't ride provider-native audio, because provider support is
uneven — and the app's default tagger (Claude) has none:

- **Anthropic / Claude — no audio.** Accepts text, images, and PDFs/documents
  only; no audio modality, no transcription.
- **OpenAI — yes, via a dedicated path** (`/audio/transcriptions`: `whisper-1`,
  `gpt-4o-transcribe`, …), plus audio-capable chat models — not "any GPT reads
  audio."
- **Gemini — yes, natively** (pass audio straight into Gemini 2.5/3.x Flash).

So "just send the audio to the tagger" would break on Claude boards and differ
per provider. This is the **exact** problem the app already solved for documents:
only Anthropic supports PDF document-blocks, so instead of relying on it the app
**extracts text via the `extractor` sidecar** and every provider tags the text
uniformly. Transcription is the audio version of that: **normalize audio → text,
then it rides the existing text-tagging path** ([worker.js](../server/worker.js)
`documentTextFor` → the `audio` branch this plan fills in). Provider-agnostic,
works on Claude, and a native-audio provider (Gemini) can later be an optional
enhancement on top — mirroring how PDFs get an Anthropic-only document-block
fallback layered over extracted text today.

The shape is the same slot the app already has three times — tagger
(Anthropic/OpenAI/Gemini), embedder (local Xenova / provider), connectors
(CoinGecko/CMC): a job (**audio → text**) with interchangeable engines. **v1
ships the local engine only** (a whisper sidecar), exactly how the embedder
shipped local-first; provider transcription engines are the deferred swappable
layer.

## Repo context (skim if you know the app)

001az: agnostic boards/entities app. Node/Express + Postgres, docker compose.
Heavy text-extraction already runs in a **separate Python sidecar**:
[`extractor/`](../extractor/main.py) (PyMuPDF, `http://extractor:3002`, `POST
/extract` raw bytes → `{markdown}`), wired in [docker-compose.yml](../docker-compose.yml)
and reached from [`documentTextFor`](../server/worker.js#L552) via `EXTRACTOR_URL`
/ `EXTRACTOR_TIMEOUT_MS`. The transcriber is the same pattern for audio. The
audio media tier already stores audio (`kind:"audio"`), and
`documentTextFor(audio)` currently falls through to `return ""`
([worker.js:584](../server/worker.js#L584)) — the seam this plan fills. A
name-only guard in [`modelInputFor`](../server/worker.js) (added with the audio
tier) is the placeholder this plan replaces with the real transcript.

## Engine decision (researched 2026-07-19)

**`faster-whisper` (Whisper via CTranslate2), CPU int8, model `base` default.**
Matches the constraints (no GPU, not ridiculous RAM/CPU, at least modest
accuracy):

- **CPU / no GPU** — int8 CPU is its intended path; CTranslate2 is SIMD C++ under
  a thin Python wrapper (fits the existing Python-extractor pattern). v1.2.1
  (Oct 2025).
- **No system ffmpeg** — decodes via PyAV, which **bundles** the ffmpeg libraries;
  handles mp3/m4a/wav/flac/ogg/aac directly. So the sidecar is *just*
  `pip install faster-whisper` (no apt ffmpeg, unlike extractor's tesseract), and
  it transcribes the raw uploaded bytes of any format we store — pass
  `io.BytesIO(body)` straight to `transcribe()`.
- **API is tiny** — `WhisperModel(size, device="cpu", compute_type="int8")` →
  `segments, info = model.transcribe(audio, vad_filter=True, beam_size=BEAM)` →
  join `segment.text`. `vad_filter=True` drops silence (faster + cleaner).
- **Model = the one knob** (`WHISPER_MODEL` build arg → env, default `base`) —
  the accuracy ↔ CPU/RAM dial, no code change; baked at build, so a change is a
  rebuild, not a UI toggle ([[feedback_flexibility_over_guardrails]]):
  - `base` (multilingual) — modest accuracy, any language, ~400–700 MB runtime,
    ~2× real-time on a modest core. The lean default.
  - `small` — clearly better accuracy, ~1.5 GB runtime, ~3–4× real-time. Good
    default when the box has headroom (transcription is a background job, so the
    extra latency isn't user-facing).
  - `distil-large-v3` / `turbo` (large-v3-turbo) — near-top accuracy, ~6–8×
    faster than large-v3, but multi-GB; only with real RAM.

Rejected alternatives: **whisper.cpp** (leaner but adds a C++ Docker build for
marginal gain over int8), **vosk** (lightest but below the modest-accuracy bar),
**openai-whisper** (the CPU-heavy reference impl we're avoiding).

## The design — three parts

### 1. The sidecar — `transcriber/` (mirrors `extractor/`)
- `transcriber/main.py`: `http.server` `BaseHTTPRequestHandler`, `POST /transcribe`
  (raw audio bytes, content-type ignored — PyAV sniffs the container) →
  `{"text": "..."}`. Load `WhisperModel(WHISPER_MODEL, device="cpu",
  compute_type=WHISPER_COMPUTE, local_files_only=True)` **once** at startup; per
  request wrap the body in `io.BytesIO`, `transcribe(vad_filter=True,
  beam_size=WHISPER_BEAM)` (VAD uses faster-whisper's bundled Silero model — no
  download, so `local_files_only` stays offline-clean), join segment texts,
  return. 500 + `{"error"}` on any failure (drives the caller's requeue).
  Single-threaded like the extractor (jobs queue); mirrors
  [extractor/main.py](../extractor/main.py)'s handler exactly.
- `transcriber/Dockerfile`: `python:3.12-slim`, `pip install faster-whisper` —
  **no `apt` layer** (unlike the extractor's tesseract): faster-whisper decodes
  via PyAV, whose wheels bundle the ffmpeg libraries. **Pre-download the model at
  build** so it's baked in, not fetched at runtime (mirrors the app image's
  embedder pre-download). The model is a **build arg**, not a hardcode, and the
  same value bridges to the runtime env so the baked model IS the served model —
  they can't drift:
  - `ARG WHISPER_MODEL=base` → `RUN python -c "from faster_whisper import
    WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu',
    compute_type='int8')"` → `ENV WHISPER_MODEL=${WHISPER_MODEL}`.
  - `ENV HF_HOME=/models` (set before the pre-download) pins the model cache to an
    inspectable path; at runtime `local_files_only=True` so a request never
    reaches the network — an unbaked model fails loudly at startup instead of
    silently downloading mid-job.
  - Other envs: `WHISPER_BEAM` (default `5`), `WHISPER_COMPUTE` (default `int8`).
  Changing the model is therefore a **rebuild** (`--build-arg WHISPER_MODEL=small`,
  `compose build`), exactly like the baked embedder — a deploy-time knob, not a
  runtime one, and deliberately not a UI setting (Slice 3).
- [docker-compose.yml](../docker-compose.yml): a `transcriber` service beside
  `extractor` whose `build.args.WHISPER_MODEL` and runtime `environment.WHISPER_MODEL`
  both read one `${WHISPER_MODEL:-base}` from `.env`, keeping the baked and served
  model in lockstep. App gets `TRANSCRIBER_URL: http://transcriber:3003` +
  `TRANSCRIBER_TIMEOUT_MS`, and `depends_on` it (like extractor).

### 2. The slot seam — `resolveTranscriber(db, board?)` (mirrors `resolveEmbedder`)
v1 resolves to the **local sidecar** always — no key, always on, like the
extractor (no per-board opt-in; transcription is how audio becomes taggable,
same as doc text extraction is automatic). But the seam is shaped now so neither
flexibility door closes later:
- **Signature takes `board`** (unused in v1) so a future per-board provider
  choice slots in like the tagger *and* an app-wide default slots in like the
  embedder — the two shapes the deferred Slice 3 might want. Costs nothing to
  thread through today.
- **Returns an engine descriptor** `{ id, model, transcribe(bytes) → text }`,
  not a bare function. `id`+`model` (e.g. `local:base`, `openai:gpt-4o-transcribe`,
  `gemini:2.5-flash`) is the identity the cache stamps against (see part 3) — so
  swapping the engine or bumping `WHISPER_MODEL` re-transcribes instead of serving
  a stale `.txt`.
- **Capability fallback:** a provider the board selects that can't do audio
  (Claude — text/images/PDF only) transparently degrades to the local sidecar, so
  "use my board's provider to transcribe" is always safe to offer even on a Claude
  board. Mirrors how the app already layers the Anthropic-only PDF document-block
  over always-available extracted text.

### 3. The wiring — `documentTextFor` audio branch (the seam already stubbed)
Replace [worker.js:584](../server/worker.js#L584)'s `return ""` fall-through with
an `if (file.kind === "audio")` branch:
- **Cache-first, but provenance-stamped:** the transcript writes to
  `galleryDir/<name>.txt` with a one-line header naming the engine that produced
  it (`# engine: <id>:<model>`, e.g. `# engine: local:base`) followed by a blank
  line and the text. On read, if the header's engine ≠ the currently-resolved
  engine's `id:model`, treat the cache as a miss and re-transcribe; otherwise
  return the cached text (strip the header). This is the flexibility guard: a
  later provider swap or a `WHISPER_MODEL` bump re-transcribes automatically
  instead of silently serving stale text — while a plain retag on the *same*
  engine still hits the cache. Transcribe-once; retags/re-extracts read the cache.
  Cleanup is free — [`sources.cleanup`](../server/sources/index.js) already `rm`s
  `galleryDir/<name>.txt` (the docx sidecar path; audio's is `<hex>.mp3.txt`).
- **Downtime = throw, never empty** (mirror the pdf branch exactly): if the
  transcriber is unreachable / non-OK, throw a status-less error → `failOrRequeue`
  spaces the retries and the item **waits** (stays `pending`) rather than tagging
  on empty text. A genuinely speechless clip → empty transcript → treated like a
  textless document (nothing to tag), not a bug.
- **Then audio rides the existing pipeline unchanged.** `modelInputForExtract(audio)`
  → `documentTextFor` returns the transcript (non-empty) → the extract leg uses
  it. `modelInputFor(audio)` → **replace the name-only guard** with the transcript,
  framed as a recording (e.g. `The item is an audio recording named "X".
  Transcript:\n\n<text>\n\nTag this recording using the record_tags tool.`).

**Correctness (the point):** the **first tag uses the transcript**. The upload
returns immediately and the item queues with a spinner (like every image/PDF);
the worker transcribes → tags from content on the first pass. The `.txt` cache is
purely an optimization against re-transcribing on a *manual* retag — never a
"tag empty, then retag" window.

## Slices

### Slice 1 — the whisper sidecar ✅ BUILT & VERIFIED (2026-07-19)
`transcriber/` (main.py + Dockerfile), compose service + envs, model pre-download.
Verify standalone: `POST /transcribe` a WAV/MP3 → `{text}`; confirm no system
ffmpeg needed (PyAV) and the model is baked into the image.
- Shipped on faster-whisper **1.2.1** (av 18.0.0 / ctranslate2 4.8.1 /
  onnxruntime 1.27.0, **no torch**); image `001az-transcriber` ≈ **1.05 GB** with
  `base` baked.
- Verified: wav + mp3 + m4a all returned the exact spoken sentence (~1.2 s each,
  short clips); `which ffmpeg` inside the container = absent (PyAV decodes);
  `--network none` + `local_files_only=True` still loads the model (bake proven);
  wrong path → 404.

### Slice 2 — wire it into the text pipeline (server) ✅ BUILT & VERIFIED (2026-07-19)
`resolveTranscriber(db)` (local), the `documentTextFor` audio branch (cache-first
+ throw-on-downtime), swap the `modelInputFor` name-only guard for the transcript.
After this, an audio item on an AI board is tagged from its speech, first pass.
- Shipped: `resolveTranscriber(db, board=null)` → local engine descriptor
  `{ id, model, transcribe }` ([worker.js](../server/worker.js)); the audio
  branch in `documentTextFor(galleryDir, file, transcriber)` (engine-stamped
  `<name>.txt`); `modelInputFor` builds the transcript prompt (speechless clip →
  name-only fallback); `modelInputForExtract` resolves the transcriber for audio;
  app env `TRANSCRIBER_MODEL: ${WHISPER_MODEL:-base}` for the stamp.
- Verified by 6 new tests in [audio.test.js](../test/audio.test.js) (transcript +
  stamped cache write, same-engine cache hit, different-engine re-transcribe,
  empty-transcript caching, status-less throw on downtime, local engine HTTP
  mapping). Full suite green (393). The real end-to-end (spoken clip → tags from
  speech on a live board) is the compose-stack Verify step 2 below — it needs the
  app image + an AI key, so it's a manual run, not a unit test.
Tests: `documentTextFor(audio)` returns the transcript and writes `<name>.txt`
with the `# engine:` header; a second call on the same engine reads the cache (no
re-transcription); a cache stamped with a *different* engine id is ignored and
re-transcribed (the flexibility guard); transcriber-unreachable throws (requeue,
not empty); an audio item end-to-end tags from a stub transcript.

### Slice 3 — ✅ BUILT & VERIFIED (2026-07-19): capability-advertised transcription engines
Provider transcription is a **capability contract, not a hardcoded provider
list** — the exact shape embeddings already use. Core owns the contract; each
provider (built-in descriptor OR `ai-provider` plugin) advertises whether it
transcribes, and nothing in core enumerates which providers do. Mirrors `embeds`
end to end:
- **Descriptor field** `transcribes: {default, models[]} | null` on the provider
  descriptor, parallel to `embeds` ([providers.js](../server/providers.js)).
- **Shared wire method** `compatWire.transcribe(desc, {apiKey, model, audio}) →
  {text, usage}` — OpenAI-style `POST /audio/transcriptions` (multipart) — the
  parallel to `compatWire.embed`. A compat-family provider whose backend exposes
  that endpoint opts in by *setting `transcribes`*; no per-provider code. A
  provider needing a different shape (a native `generateContent` audio call, a
  separate STT service) ships its own wire and advertises the same flag — the
  endpoint heterogeneity lives in the wire, never in core.
- **Generic everywhere, zero provider names:** a `transcribeAudio()` dispatcher
  (parallel to `embedTexts`) routes provider transcription through the wire;
  `resolveTranscriber` gates on `PROVIDERS[p]?.transcribes` and otherwise falls
  back to the whisper sidecar (resolved directly, not through the dispatcher);
  `providerCatalog()` + the admin surface render the picker from the flag.
- **Loader validation** ([plugin-loader.js:90](../server/plugin-loader.js#L90)):
  widen the "must tag or embed" capability reject to "tag, embed, or transcribe,"
  and require `wire.transcribe` to be a function when `transcribes` is set.
- **Claude → whisper is automatic:** Anthropic's descriptor is `transcribes: null`
  (like its `embeds: null`), so a board on a no-audio provider resolves to the
  whisper sidecar. The capability field IS the fallback — no special-casing.
- **The sidecar is its own plugin:** a dedicated core, keyless `whisper` provider
  — "Local Transcriber (Whisper)", the peer of the Xenova embedder "Local Embedder
  (Xenova)" — advertises `transcribes`, rather than the capability being bolted
  onto the embedder card. Its engine id is `whisper` (the cache stamps
  `whisper:base`); the `transcribe_provider` sentinel and the provider-empty cache
  guard key off it.
Because the Slice 2 seam already takes `board`, returns an engine descriptor, and
engine-stamps the cache, a transcribing provider (built-in or plugin) slots in
with **zero core change** and the `.txt` cache re-transcribes when the engine id
flips.

**Config UI** mirrors the embedder's per-provider "Semantic search" section (a
`transcribeSection` in the plugin modal, gated on `capabilities.transcribe`) —
not a standalone page, and **no enabled toggle**: transcription is always on (the
Whisper sidecar is the default), so the provider choice IS the toggle. A
provider's card offers a model picker (its `transcribes.models`) + key + Test
(a synthesized tiny WAV probes it e2e); the Whisper card shows its baked model as
a note. Selecting Whisper shows no model dropdown: `WHISPER_MODEL` is baked
(Slice 1), a deploy-time knob not a UI setting. The line: UI config is for
runtime-swappable engines (provider + key + model param); the local model lives
in `.env` / `--build-arg`.

Resolution scope (app-wide like the embedder vs per-board like the tagger) is the
one open product call; the seam supports either. Recommended default: **app-wide**
— transcription is content-normalization (audio→text so it's taggable), the same
category as extraction and embedding, not a per-board judgment like tagging.

**What shipped (2026-07-19):**
- `transcribes` descriptor field + shared `compatWire.transcribe` +
  `transcribeAudio()` dispatch + catalog flag ([providers.js](../server/providers.js));
  loader validation ([plugin-loader.js](../server/plugin-loader.js)); `plugins.js`
  capability `transcribe: !!p.transcribes`. **OpenAI advertises** `transcribes`
  (real `/audio/transcriptions`); **local advertises** (the sidecar); Gemini is
  left `null` pending verification that its OpenAI-compat base proxies
  `/audio/transcriptions` (else it ships a native wire — exactly the plugin path).
- **App-wide resolution** chosen: `resolveTranscriber(db, board)` reads a global
  `transcribe_provider` (+ `transcribe_key_id`/`transcribe_model`), gates on the
  capability, and falls back to local for anything unusable — never fails.
- **No enabled toggle** — transcription is always on (local default), so the
  provider *choice* is the toggle. Config is a per-provider **Transcription**
  section in the plugin modal (`transcribeSection`, gated on `capabilities.
  transcribe`), mirroring the embedder's per-provider `embedSection` — not a
  standalone page. `transcribe-test` synthesizes a tiny WAV to probe e2e.
- Verified: 6 backend tests (catalog advertisement, the multipart wire + error
  mapping, provider-engine resolution, local fallback, local-sidecar mapping);
  full suite green (397). Frontend mirrors `embedSection` (no UI test harness;
  syntax-checked).

The compose-stack e2e (a real provider key transcribing a real clip) is a manual
run, same as Slice 2's — it needs an API key.

## Verify (compose stack)
1. Slice 1: `curl -X POST --data-binary @clip.mp3 http://localhost:3003/transcribe`
   → JSON text; try mp3 + m4a + wav (PyAV decodes all); confirm image size is
   reasonable and the model loads from the baked cache offline.
2. Slice 2: upload a spoken-word clip to an AI-tagging board → it shows
   `processing`, then tags derived from the speech (not the filename); the
   `<name>.txt` sidecar exists; retag is instant (cache hit) and produces the
   same tags; stop the transcriber → the item stays `pending` and recovers when
   it's back (never tagged empty); delete the item → the `.txt` is gone.
3. `npm test` green.

## Risks / notes
- **Throughput, not correctness.** A long clip occupies one worker slot for the
  minutes it takes to transcribe (`base` ~2× real-time); other slots keep working
  — same shape as a big PDF OCR job in the extractor. The `TRANSCRIBER_TIMEOUT_MS`
  must cover a queued clip behind others (extractor uses a generous 240 s for the
  same reason).
- **RAM is runtime, not file size.** `base` int8 ≈ 400–700 MB resident, `small`
  ≈ ~1.5 GB (user deprioritized RAM, but size the box for the chosen model).
  `WHISPER_BEAM=1` trades a little accuracy for lower CPU/RAM.
- **Model/engine-swap cache staleness — handled, not deferred.** The `.txt`
  cache is stamped with the producing engine (`# engine: <id>:<model>`, part 3),
  so changing `WHISPER_MODEL` or later routing a board to a provider
  re-transcribes on next touch instead of serving stale text. The cost is one
  header line per file and a string compare on read — cheap insurance for the
  flexibility the plan is deliberately keeping open.
- **Deploy:** a new sidecar service (image rebuild + `docker compose up`), plus
  the app image only needs the `TRANSCRIBER_URL` env — no app-side binary.
- Aligns with [[feedback_flexibility_over_guardrails]] (model is data/env, engine
  degrades to requeue not failure) and [[feedback_dont_inherit_past_decisions]]
  (transcribe-to-text reuses the extractor's provider-agnostic pattern rather
  than betting on uneven provider-native audio).

## Pointer
This completes the media tier started in [audio-media-plan.md](audio-media-plan.md):
that plan built the **core** (understand + face + play, shipped `157a5d2`); this
builds the **swappable slot** (audio → text). The `documentTextFor` audio branch
is the single integration point — everything downstream (extract, tag, embed,
search) already works on text. A future `media`/`source` from-URL plugin kind
could ship an alternative transcriber the same way the face pipeline lets a
plugin ship a face producer.
