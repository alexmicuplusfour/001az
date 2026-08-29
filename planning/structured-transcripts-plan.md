# Structured transcripts — paragraphs, speaker turns, and a second transcriber engine

**Status: Slices 1–2 BUILT & VERIFIED — slice 1 committed `f5ed190`
(2026-08-29): sidecar emits per-segment `turns`, engine contract
`{ text, turns }` on both paths, loop stores `payload.transcript_turns`
(+ job-log detail). Slice 2 (2026-08-29, uncommitted): the transcript endpoint
serves `turns`, and the lightbox renders click-to-seek paragraphs via the pure
`public/transcript-paragraphs.js` planner. Suite 1225 green; both slices
live-verified end-to-end. Slices 3–5 not started.
Research done (engine landscape + diarization survey below). Successor to
[transcription-plan.md](transcription-plan.md) (slices 1–3 built: the
`transcriber/` sidecar, the transcription loop, the provider slot) and
[transcriber-robustness-plan.md](transcriber-robustness-plan.md) (the async job
API). Self-contained for a fresh session.**

## The problem

A transcript today is one flat string. The sidecar iterates faster-whisper's
timestamped segments and throws the boundaries away
([transcriber/main.py:95-96](../transcriber/main.py#L95-L96) — `parts.append(seg.text)`
→ `"".join(parts)`), the worker stores the join as `payload.transcript`, and
the lightbox renders a wall of text. Three tiers of structure are missing,
in priority order:

1. **Paragraphs** — minimum viable readability. The data (segment timestamps +
   VAD-detected pauses) already exists and is discarded.
2. **Relative speaker turns** — "Speaker 1 / Speaker 2" labels with waveform
   indicators, the standard transcript UI shape.
3. **Absolute speaker identity** — matching turns to enrolled voices (the
   board-modal Mapping-tab idea). Explicitly deferred; this plan only keeps the
   schema ready for it.

Separately, the engine itself is dated: whisper `small` was picked in July 2026
as "the lean end of usable" and the field has moved past it on both accuracy
and speed (research below).

## Locked decisions

### One capability, richer output — diarization is NOT a capability

Transcription stays the app's single audio→text capability. Its output contract
gains an optional structured half; no `diarize` capability, no second lane, no
new sidecar *kind*. Rationale: diarization is meaningless without a transcript,
every engine below bundles or composes it invisibly, and a second capability
would double the binding/pin/cleanup surface for zero user-facing choice.

### How diarization actually works (research, 2026-08-28)

Who-spoke-when is almost always a **separate specialized pipeline**, not part
of the ASR model: VAD/segmentation → per-window **speaker-embedding** vectors
("voice fingerprints") → **clustering** (each cluster = one speaker) → labeled
time ranges. It never reads words; ASR never hears voices. Every "transcription
with speakers" product is two systems merged by timestamp overlap. The
exceptions — single models that emit text + speaker labels in one pass — are
new and few: OpenAI's `gpt-4o-transcribe-diarize` (paid, `diarized_json`),
[MOSS-Transcribe-Diarize 0.9B](https://github.com/OpenMOSS/MOSS-Transcribe-Diarize)
(open, Apache 2.0, 2026-07), and whisper.cpp's English-only "tinydiarize"
experiment. Consequence for us: **the bundle lives inside a sidecar** (or
inside a paid model), behind the one capability.

### The output contract: `turns`

Every transcribe engine returns `{ text, turns }`:

```
text:  string            — the flat transcript, exactly today's contract
turns: [{ start, end, speaker, text }] | null
       start/end  seconds (float)
       speaker    "S1" | "S2" | … | null   — RELATIVE slot labels
       text       that span's text
```

- `turns: null` = engine gave no structure (legacy sidecar, plain provider
  model) → the UI falls back to today's wall of text.
- `speaker: null` on every turn = timestamps but no diarization (tier 1 only)
  → the UI renders paragraphs without speaker chrome.
- Speaker labels are **slots, not identities**. Tier 3 later becomes a
  relabeling layer (slot → person) over the same stored data — a mapping, not
  a schema change. Same for the paid path's `known_speaker_names[]`.

Storage: `payload.transcript` stays the flat string — the tagger
([worker.js:1350-1374](../server/worker.js#L1350-L1374)), extractor leg,
embedder query, and awaiting-transcription wait semantics all key on it and
none of them changes. Turns land beside it as `payload.transcript_turns`
(present only when the engine produced them). Paragraph *grouping* is
presentation: derived client-side from turns at render (pause-gap heuristic),
never stored — formatting defaults stay tunable without re-transcribing
([[feedback_flexibility_over_guardrails]]).

### Engine strategy: sidecars are providers; a second sidecar is a second provider

The capability system already supports multiple local engines: `whisper` is a
registered keyless provider with `wire: null`
([ai-providers/whisper.js](../server/ai-providers/whisper.js)), the transcribe
capability's board pins carry a **provider** column precisely so a board can
pin an engine with no key row
([capabilities.js:164-173](../server/capabilities.js#L164-L173)), and
`resolveTranscriber` ([worker.js:1031](../server/worker.js#L1031)) picks the
engine shape from the resolved binding. So:

- A **second transcriber sidecar** registers as its own keyless provider,
  board-pinnable through existing UI, served by the same sidecar adapter
  pointed at a different URL. One capability, N engines.
- `whisper` **stays the floor** (resolution must never fail, and whisper's 99
  languages are the widest net). The new engine is an upgrade a deploy/board
  opts into, not a replacement ([[feedback_flexibility_over_guardrails]],
  [[feedback_general_purpose_app]] — no assumption about anyone's language).
- The job API (submit/poll, content-hash dedupe, express lane, watchdog) is
  engine-agnostic and battle-tested — the new sidecar reuses it wholesale.

## Engine research (2026-08-28)

| Engine | Languages | Accuracy | CPU speed | Diarization | Weight / friction |
|---|---|---|---|---|---|
| faster-whisper `small` (current) | 99 | weak (unstable on non-English) | ~real-time | none | baked today |
| faster-whisper `large-v3-turbo` | 99 | near-SOTA whisper | ~3× slower than `small` | none | build-arg-only upgrade |
| **Parakeet TDT 0.6B v3** | 25 (European) | **beats whisper large-v3** (≈6.3 vs ≈7.4 WER) | **~20× whisper-large throughput** | none — compose with sherpa | ONNX/GGML runtimes, no torch |
| **sherpa-onnx diarization** (pyannote-seg-3.0 ONNX + 3D-Speaker/CAM++ embeddings) | lang-agnostic | close to pyannote (known small gap, k2-fsa/sherpa-onnx#1708) | well under real-time | **is** the diarizer | ~50MB models, onnxruntime, **no HF gating** — GitHub-release downloads, bakeable offline |
| senko (3D-Speaker pipeline) | lang-agnostic | good | ~42s/hour (Ryzen 9950X) | is the diarizer | torch (~2GB image); speed upgrade path |
| pyannote community-1 | lang-agnostic | best open | ~real-time | is the diarizer | torch + **HF token/terms gating** — fights bake-at-build; rejected |
| **MOSS-Transcribe-Diarize 0.9B** | 50+ | SOTA end-to-end (INTERSPEECH-26 MLC-SLM winner) | **unproven on CPU** (audio-LLM, token-by-token decode) | **bundled** — `[S01]` labels + timestamps in one pass | Apache 2.0, ≤90-min input; a month old |
| transcribe.cpp (GGML runtime: whisper, Parakeet, MOSS, Sortformer…) | per-model | per-model | fast (GGML) | via MOSS/Sortformer | v0.1.0, young bindings; watch, don't ship |
| OpenAI `gpt-4o-transcribe-diarize` (paid) | broad | strong | n/a | **bundled** — `response_format: diarized_json`; `known_speaker_references[]` ≈ tier 3 free | API key; needs `chunking_strategy` >30s |

Sources: [Open ASR leaderboard](https://huggingface.co/blog/open-asr-leaderboard) ·
[Canary/Parakeet paper](https://arxiv.org/pdf/2509.14128) ·
[sherpa-onnx diarization](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html) ·
[senko](https://github.com/narcotic-sh/senko) ·
[MOSS technical report](https://arxiv.org/pdf/2601.01554) ·
[OpenAI STT guide](https://developers.openai.com/api/docs/guides/speech-to-text) ·
prior art [trailofbits/scribe](https://github.com/trailofbits/scribe) (Parakeet + pyannote composed locally).

**Chosen path:** slice the structure work engine-agnostically first (the
current sidecar already has segments), then bundle sherpa-onnx diarization into
the whisper sidecar, then stand up a **Parakeet TDT v3 + sherpa-onnx** sidecar
as the fast-and-accurate opt-in engine. MOSS is a benchmark experiment, not a
commitment — if a quantized build proves droplet-viable it slots into the same
sidecar template later.

## Slices

### Slice 1 — segments out of the sidecar, `turns` through the engine contract ✅ (2026-08-29)

The tier-1 data plumbing, engine-agnostic, no new models. As-built notes:
turn shape is `{start, end, text}` (0.1s rounding, text stripped, `speaker`
omitted until diarization exists — absent = not diarized); turns clip in
lockstep with `MAX_CHARS` (no byte-for-byte concatenation guarantee — `text`
is canonical material, turns are seek/display structure); `[]` turns ARE
stored (structure produced, no speech); `word_timestamps` explicitly rejected
for this arc (segment-level only — slice 2's UI must expect coarse turns);
deploy-order safe both directions via an `Array.isArray` guard; the provider
path passes `turns` through from day one so slice 5 is wire-only. The jobs
modal ok-row gained "· N turns". Loop-level e2e pinned in job-log.test.js
(sidecarOk grew an optional turns arg); contract pinned in audio.test.js.

- **Sidecar** ([transcriber/main.py](../transcriber/main.py)): `_transcribe`
  collects `{start: seg.start, end: seg.end, text: seg.text}` per segment
  (speaker-less) alongside the joined text; the done payload gains
  `"turns": [...]` (capped alongside `MAX_CHARS` — clip the turn list where the
  text clips). Job state carries it like `text`.
- **Engine contract** (worker.js): `whisperTranscriber.transcribe` returns
  `{ text, turns }` (`turns: null` when the payload lacks them — an old sidecar
  image degrades silently). The provider path wraps `transcribeAudio` results
  as `{ text, turns: null }` for now (slice 5 fills it in). All call sites
  (the loop, [capability-probe.js:57-63](../server/capability-probe.js#L57-L63))
  adjust to the object shape.
- **Loop** ([worker.js:2542](../server/worker.js#L2542)): store
  `payload.transcript` as today; additionally `payload.transcript_turns` when
  non-null. Job-log detail gains `turns: n` beside `chars`.
- **Tests**: sidecar-shape fixtures in [test/audio.test.js](../test/audio.test.js)
  — done payload with/without turns; loop stores/omits `transcript_turns`;
  probe still passes on text-only. `transcribeFailurePolicy` untouched.

### Slice 2 — lightbox paragraphs (tier 1 shipped) ✅ (2026-08-29)

As-built notes: the grouping heuristic lives in its own import-free module
`public/transcript-paragraphs.js` (NOT exported from detail-view.js — its
import chain is browser-bound: toast.js touches document.body and grid.js
constructs an IntersectionObserver at module scope, so it cannot load under
test/browser-stub.js; capability-present.js is the precedent). Measured
correction to the design intuition: whisper's VAD only exposes >~2s silences
as timestamp gaps (short spoken pauses produce abutting segments — the live
clip's turns abut exactly), so the LENGTH CAP does most of the paragraphing on
continuous speech and the gap rule fires on real, long pauses. Click-to-seek
sets currentTime only (play state untouched); each paragraph carries a
"Jump to m:ss" title. Precedence: paragraphs → flat transcript → waveform,
so [] turns (silent clip) and legacy flat items degrade correctly.

- **API**: [`GET /api/instances/:id/transcript`](../server/server.js#L2507)
  returns `{ transcript, turns }` (turns null for legacy items — additive, no
  client breakage).
- **Client** ([detail-view.js audio renderer](../public/detail-view.js#L29)):
  with turns, group into paragraphs — break on inter-turn silence gap
  (default ≥ 1.25s) or speaker change (future-proof: speakers are null in this
  slice), cap paragraph length (~600 chars). Render as `<p>` blocks in the
  existing `.lightbox-audio-transcript` panel (extend the component, no new
  vocabulary — [[feedback_no_component_duplication]]). Click a paragraph →
  `player.currentTime = firstTurn.start` (the native `<audio>` element is
  already mounted beside it). No turns → today's flat text, unchanged.
- **No backfill sweep**: existing items keep flat transcripts (a good
  transcript is never re-billed — same principle as
  [db.js:2626-2628](../server/db.js#L2626-L2628)); a manual reprocess of an
  item whose transcript the admin clears re-transcribes with turns. Revisit a
  bulk backfill only if demanded.

### Slice 3 — diarization bundled into the whisper sidecar (tier 2, local floor)

- **Engine**: sherpa-onnx offline diarization — pyannote-segmentation-3.0 ONNX
  (~6.6MB) + a 3D-Speaker embedding model, both plain GitHub-release downloads
  **baked at build** next to the whisper model (same offline discipline; no HF
  token, unlike pyannote-proper — decisive for
  [[feedback_publishing_repos]] / general-purpose deploys).
- **Flow** in `_transcribe`: after ASR yields segments, run the diarization
  pass over the same decoded PCM (PyAV decode once, resample 16k mono for
  sherpa), then assign each ASR segment the speaker whose turn overlaps it
  most; merge adjacent same-speaker segments into turns. Update
  `jobs[id]["advanced"]` from sherpa's progress callback so the watchdog and
  the app-side stall detector ([worker.js:989-998](../server/worker.js#L989-L998))
  keep their progress-based liveness semantics through the extra pass.
- **Express lane skips diarization** — probes and voice notes need text fast,
  not speaker chrome; a `?diarize=0`-style flag on submit (default on for main
  lane) keeps the Test button seconds-fast.
- **Knobs**: `WHISPER_DIARIZE` env (default `1`; `0` restores today's
  behavior), clustering threshold as env with a sane default — a default, not
  a law. Unknown speaker count stays threshold-clustered; occasional
  over-splitting on long recordings is accepted (re-transcribe is the remedy).
- **Client**: paragraphs gain speaker chrome — colored left border + "Speaker
  n" label per block (relative palette keyed on slot), and the waveform face
  gets overlay bands (pure positioned divs: `left/width` from
  `turn.start / meta.duration` — duration is already stored by
  [sources/audio.js](../server/sources/audio.js)). Colors follow the existing
  component vocabulary; nothing new in styles.css beyond the component's own
  block.

### Slice 4 — the second transcriber sidecar (Parakeet TDT v3 + sherpa diarization)

- **Sidecar** `transcriber-parakeet/` (name TBD at build): the job-queue
  harness from [transcriber/main.py](../transcriber/main.py) (submit/poll,
  hash dedupe, express lane, watchdog — copied like extractor/transcriber
  already mirror each other) around Parakeet TDT 0.6B v3 served via an ONNX
  runtime (sherpa-onnx or onnx-asr — **verify the multilingual v3 export
  exists and benchmarks on droplet CPU before committing**; this is the
  slice's research gate), plus the same sherpa diarization pass as slice 3.
  Port 3005. Same API shape, so the app-side adapter is reused verbatim.
- **Registry**: new catalog-only descriptor
  `server/ai-providers/parakeet.js` — `wire: null`, `keyless: true`,
  `onDevice: true`, truthy `transcribes`, self-reported model via `/health`
  (the sidecar owns its model name, exactly like whisper). Vendor naming stays
  confined to its own module ([[provider-agnosticism-constraint]]).
- **Engine selection**: generalize `whisperTranscriber(binding)` →
  `sidecarTranscriber(binding, url)`; the descriptor carries its sidecar
  wiring as data (e.g. `sidecar: { urlEnv: "PARAKEET_URL", defaultUrl:
  "http://transcriber-parakeet:3005" }`) so `resolveTranscriber` maps *any*
  no-wire transcribes-provider to the adapter without naming one — the floor
  branch (`viaFloor` → whisper) becomes just the default case of the same
  rule ([[feedback_dont_inherit_past_decisions]]).
- **Deploy**: optional compose service (profile or commented block — the
  image is a real download/build cost a deploy opts into). A board pinned to
  an absent/down sidecar behaves exactly like transcriber-down today:
  transient lane backoff, nothing breaks. Whisper remains the floor and the
  99-language fallback.
- **Admin**: the Plugins page card rides the existing `sidecarCatalog` path
  ([server.js:2063-2072](../server/server.js#L2063)) — one more call, no new
  mechanism. Capability probe works unchanged through resolution.

### Slice 5 — provider diarized transcription (paid path)

- OpenAI descriptor ([ai-providers/openai.js](../server/ai-providers/openai.js))
  adds `gpt-4o-transcribe-diarize` to the `transcribes` catalog with a
  **descriptor-data flag** on the model entry (e.g. `diarized: true`) — the
  generic path reads the flag, never the provider or model name.
- Compat wire `transcribe` ([wires/compat.js:325](../server/ai-providers/wires/compat.js#L325)):
  when the resolved model entry carries the flag, send
  `response_format: diarized_json` (+ `chunking_strategy: "auto"` for >30s
  input) and map the response's segments (`speaker`, `start`, `end`, text) to
  the `turns` contract, normalizing speaker names to slots. Without the flag,
  today's plain call, `turns: null`.
- Result: a board pinned to the paid diarizing model and a board on the local
  sidecar produce indistinguishable payloads — the client can't tell, which
  is the proof the contract is provider-agnostic.

### Deferred — absolute speaker identity (tier 3)

Out of scope, schema-ready. When wanted: enrollment UI in the board modal
(Mapping tab), local matching = the sidecar's own embedding model comparing
enrolled reference clips against turn embeddings (a future `/identify`
endpoint — same model already loaded), paid path = OpenAI's
`known_speaker_names[]` + `known_speaker_references[]` (≤4 clips). Stored
turns keep slot labels forever; identity is a relabel at render.

### MOSS benchmark (side experiment, any time after slice 1)

Quantized MOSS-Transcribe-Diarize 0.9B (GGML via transcribe.cpp or llama.cpp
lineage) on droplet-class CPU: real-time factor, RAM, output quality on
multi-speaker audio. If viable, it becomes a third sidecar candidate in the
slice-4 template (one model, text + turns in one pass, 50+ languages) and
likely supersedes the Parakeet bundle. Not a dependency of anything above.

## Open questions / risks

- **Parakeet v3 ONNX availability + droplet RTF** — slice 4's gate; benchmark
  before building the image.
- **sherpa vs pyannote accuracy gap** — known small mismatch vs upstream;
  acceptable for relative labels in a gallery app, re-evaluate only if turns
  look wrong in practice.
- **Overlapping speech** — turn assignment picks the dominant speaker of a
  segment; crosstalk-heavy audio will read imperfectly. Accepted.
- **Turn payload size** — a 3-hour clip is ~2–4k turns; fine in jsonb beside a
  200k-char cap, but keep turns clipped in lockstep with `MAX_CHARS`.
- **Legacy items** — no turns until re-transcribed; deliberate (no silent
  re-billing). Surface "re-transcribe" affordance if users ask.
