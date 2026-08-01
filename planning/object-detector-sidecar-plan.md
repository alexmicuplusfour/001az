# Object-detector sidecar — real open-vocab detection in a Docker container (LLMDet)

**Status: BUILT (2026-08-01). Replaces the in-process Transformers.js OWLv2 engine
(Slice 1 of [object-detection-plan.md](object-detection-plan.md)) with a Python
Docker sidecar running LLMDet — the fourth sidecar after `extractor` (:3002) and
`transcriber` (:3003). The detector SLOT, the `object` field kind, and the lightbox
overlay ([object-detection-plan.md](object-detection-plan.md) Slices 2–3) are
UNCHANGED — engine-agnostic by design; only the local engine swaps. Model +
correctness BENCHMARKED on real hardware before building (see below). Full suite
green (618). Self-contained for a fresh session.**

## Why a sidecar, not the in-process JS engine

The first cut ran OWLv2 in-process via `@huggingface/transformers` (the embedder's
runtime) to avoid a new service. It was **mediocre and CPU-heavy**, and the JS/
onnxruntime-CPU path has a hard ceiling I verified empirically: **fp16 won't load
on CPU** (no fp16 kernels), int8 breaks (ConvInteger), q8 runs but quantization
softens the boxes, and fp32 is ~4–5× slower. There is no good local-CPU option in
JS. Meanwhile the established pattern here is a **Docker sidecar** (`extractor` =
PyMuPDF, `transcriber` = faster-whisper). A Python sidecar unlocks the *real*
models — full PyTorch, no JS crippling — so it delivers **keyless + local + genuinely
good**, which the JS path could not. This dissolves the earlier "keyless-local
can't be good" wall: that was a JS limitation, not a fundamental one.

## Engine decision (researched + benchmarked 2026-08-01)

**LLMDet-tiny (`iSEE-Laboratory/llmdet_tiny`), Apache-2.0, via HuggingFace
`transformers` (pinned `>=4.55,<5`).** LLMDet is MM-Grounding-DINO fine-tuned under
LLM supervision; the LLM is training-time only and **not shipped in the weights**,
so the served detector is cleanly Apache-2.0 (decisive for an open-source project).
Loads as a native transformers architecture (`AutoModelForZeroShotObjectDetection`
+ `AutoProcessor`) — **no OpenMMLab / MMDetection**.

**Benchmarked on this host (12-core CPU, no GPU) before committing:**
- **~6.5s/image** — acceptable for a background job (the research's one unverified
  risk, now measured).
- **Tight, deduplicated boxes** matching the published HF example (`a cat @
  [342,23,637,375]` vs documented `[344,23,637,374]`), **47–54% confidence** (vs
  OWLv2-base's 10–31%), no duplicate pile-up, no hallucination ("car" on a cat
  photo → nothing). LVIS 50.7 AP vs OWLv2-base's ~34–42 — clearly, obviously
  better.
- **THE gotcha, caught by testing:** pin **`transformers>=4.55,<5`**. v5.14 has a
  grounding-DINO post-processing regression that produces exactly the garbage
  boxes (out-of-bounds, ~10px-wide) — 4.55–4.57 are correct. Documented in the
  Dockerfile and `main.py`.

Fallbacks (same loader + Apache-2.0, swap `OBJECT_DETECTOR_MODEL`): **MM-Grounding-DINO
tiny** (`openmmlab-community/mm_grounding_dino_tiny_o365v1_goldg_v3det`) and, for
speed, **OmDet-Turbo tiny**. **Rejected: Ultralytics YOLO-World / YOLOE** — AGPL-3.0
(network-copyleft, wrong for an open-source served sidecar), and loose boxes.

## The design — three parts (mirrors the transcriber)

### 1. The sidecar — `object-detector/` (:3004)
- [`object-detector/main.py`](../object-detector/main.py): stdlib `HTTPServer`,
  **synchronous** `POST /detect {image_b64, queries, threshold} → {objects:
  [{label, box:[x0,y0,x1,y1] normalized 0..1, score}]}` (a detection is seconds,
  not the minutes a transcription can take — no job queue like the transcriber;
  modelled on the extractor). Loads LLMDet once at startup; **single-threaded** so
  one memory-heavy inference runs at a time. `GET /health → {ok, model}`. Boxes
  normalized + clamped to 0..1 at the boundary (the canonical format the slot
  already expects). The version-sensitive `post_process_grounded_object_detection`
  call is the exact one verified on 4.57.
- [`object-detector/Dockerfile`](../object-detector/Dockerfile): `python:3.12-slim`,
  torch **CPU wheel** + `transformers>=4.55,<5` + pillow (no OpenMMLab, no apt
  layer). **Model baked at build** via `OBJECT_DETECTOR_MODEL` build-arg (default
  `iSEE-Laboratory/llmdet_tiny`; `_base`/`_large` = more accurate + slower, a
  rebuild not an .env flip), `HF_HOME=/models`, `local_files_only` at runtime —
  exactly the transcriber's `WHISPER_MODEL` bake. GPU is opportunistic (a host
  with a GPU + the CUDA torch wheel gets it; CPU is the default).
- [docker-compose.yml](../docker-compose.yml): an `object-detector` service beside
  `transcriber`, `OBJECT_DETECTOR_MODEL` build-arg + runtime env in lockstep,
  `/health` healthcheck (180s start_period — the model loads before the port
  binds). App gets `OBJECT_DETECTOR_URL: http://object-detector:3004` +
  `OBJECT_DETECTOR_TIMEOUT_MS`, and `depends_on` it.

### 2. The seam — `resolveDetector` → `objectDetectorSidecar()` (mirrors `whisperTranscriber`)
The `localDetector` provider is now **catalog-only** (`wire: null`,
[local-detector.js](../server/ai-providers/local-detector.js)) — the peer of the
`whisper` provider. `resolveDetector` ([worker.js](../server/worker.js)) resolves
the local branch to an HTTP client `{ id, model, detect(image, queries) }` that
POSTs to `/detect`; unreachable/non-OK throws **transient → the extract leg
requeues** (the extractor/transcriber failure contract), never a silent empty. The
keyed-provider branch (routes through `wire.detect` via `detectObjects`) is
untouched — a paid detector still slots in. `id: "localDetector"` so the admin
slot/badge/tag are unchanged.

### 3. The consumer — unchanged
The `object`-field detection pass in `extractOne` (batched single pass over all
object-field queries, demux by matched label) calls `resolveDetector(db).detect(
originalImage, queries)` exactly as before — it neither knows nor cares the engine
became a sidecar. The lightbox overlay reads the same canonical boxes.

## What changed / what was removed
- **Removed:** the in-process Transformers.js engine in `local-detector.js`
  (pipeline, dtype dial, hand-rolled NMS) — the whole JS quality dead-end. The
  embedder still uses `@huggingface/transformers`; the detector no longer does.
- **Kept:** the detector slot, `detects` capability, `detectObjects` dispatcher
  (paid path), the `object` field kind + extraction pass, the lightbox overlay.

## Verify
1. **Model + correctness (done, pre-build):** a host benchmark (torch-CPU +
   transformers 4.57) loaded `llmdet_tiny` and reproduced the documented box on the
   COCO cats photo — tight, confident, deduplicated; ~6.5s/image. This is the
   evidence the whole decision rests on.
2. **Sidecar (compose stack):** `docker compose build object-detector` bakes the
   model; `curl -s localhost:3004/health` → `{ok, model}`; `POST /detect` a
   base64 image + `["cat"]` → boxes. Then an image board with an `object` field →
   upload → boxes in the lightbox.
3. `npm test` green (618).

## Risks / notes
- **Throughput, not correctness.** ~6.5s/image single-threaded on CPU; the sidecar
  serializes, and `EXTRACT_CONCURRENCY` images queue behind each other — same shape
  as a big OCR job in the extractor. `OBJECT_DETECTOR_TIMEOUT_MS` (180s default)
  covers a queued image + cold load. A host GPU cuts this dramatically.
- **The `transformers<5` pin is load-bearing** — documented at both the Dockerfile
  and the `post_process` call. A future unpin must re-verify boxes against the
  documented example first.
- **Image size.** torch + transformers + a baked Swin-T checkpoint ≈ a couple GB —
  larger than the whisper sidecar. `_base`/`_large` models grow it further.
- **Model card note may drift.** The admin card names `llmdet_tiny` statically; if
  someone swaps `OBJECT_DETECTOR_MODEL`, the note is cosmetically stale (a `/health`
  probe like the transcriber's `transcriberSidecarModel` is the follow-up nicety).
- Aligns with [[feedback_dont_inherit_past_decisions]] (the sidecar reuses the
  extractor/transcriber pattern rather than forcing detection through the
  embedder's JS runtime) and [[feedback_flexibility_over_guardrails]] (model is a
  build-arg, threshold a setting, failure requeues not crashes).

## Pointer
The fourth sidecar after `extractor` and `transcriber` — and the template for the
planned **voice** and **face** capabilities (each its own container behind the same
capability-slot pattern). The paid detector override (Gemini / DINO-X `wire.detect`,
Slice 4 of [object-detection-plan.md](object-detection-plan.md)) is still a valid
quality tier on top, but the local sidecar now clears the "actually usable" bar on
its own.
