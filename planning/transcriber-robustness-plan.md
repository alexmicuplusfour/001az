# Transcriber robustness — async jobs so long audio can't orphan its own work

**Status: BUILT (2026-07-21). Rework of the sync sidecar from
[transcription-plan.md](transcription-plan.md) after 2+ hour Romanian clips
failed in production. Deploy needs an image rebuild for BOTH `transcriber`
(new main.py + `small` bake) and `app` (new client), same compose up.**

## The failure this fixes (observed 2026-07-21)

A 2h clip transcribes fine (~41 min on `base`) — but the worker's synchronous
POST aborted at `TRANSCRIBER_TIMEOUT_MS` (4 min), so the sidecar finished into a
dead socket (`BrokenPipeError`), the finished text was thrown away, and the
retry started the same 41-minute job again. Forever. Compounding it:

- The retry every ~5 min queued behind the single-threaded server and was
  itself aborted → the `ConnectionResetError` storms in the log.
- The transcribe loop's backoff was GLOBAL, and the queue picks newest-first —
  one stuck clip froze every other audio item, with no attempt cap.
- The worker read the abort as "transcriber unreachable", indistinguishable
  from real downtime in the Jobs modal.
- Two completed runs of the same bytes differed (30,327 vs 22,382 chars):
  `base` leans hard on temperature fallback for Romanian.

## The design

**The exchange is now asynchronous** ([transcriber/main.py](../transcriber/main.py)):
`POST /transcribe` returns `202 {"job": <hash>}` immediately; the worker polls
`GET /jobs/<id>` (250ms → 30s backoff). No HTTP request ever spans inference, so
no timeout can orphan completed work — the whole broken-pipe class is gone.

- **Content-addressed jobs.** The id is `sha256(bytes)[:16]`: a retry or an app
  restart re-joins the queued/running job instead of duplicating 40 minutes of
  inference; a finished result stays claimable for 1h (`RETAIN_S`). A resubmit
  onto a FAILED record re-runs it (a cached failure must not poison retries).
- **One inference thread, threaded HTTP.** The model still runs strictly
  serially; the `ThreadingHTTPServer` handlers only enqueue and look up, so
  polls answer instantly during a long job.
- **Express lane.** Payloads ≤2MB (the admin Test probe, voice notes) jump the
  queue and are serviced BETWEEN segments of a long job — seconds, not hours.
  The probe additionally passes `deadlineMs: 30000` so it degrades to an honest
  "busy" rather than hanging the admin UI.
- **Progress, not wall-time, is liveness.** Jobs report `done_s/total_s`
  (updated per segment; heartbeat-logged every 60s). The worker client declares
  a job hung only if progress freezes for `TRANSCRIBER_STALL_MS` (15 min —
  covers the silent decode+VAD prelude of a long clip). The sidecar's own
  watchdog (`WHISPER_WATCHDOG_S`, 30 min) exits the process on a truly frozen
  model so `restart: unless-stopped` brings up a fresh one; a compose
  healthcheck covers plain process death.
- **Failure taxonomy** ([worker.js](../server/worker.js) `whisperTranscriber` +
  `transcribeFailurePolicy`, pure + tested):
  - lane-scope transient (down / queue full / 429) → global 60s backoff, as before;
  - job-scope transient (stalled / lost after sidecar restart / inference
    fault) → PER-ITEM 60s backoff — the query skips clips in backoff
    (`oneAudioNeedingTranscription(db, excludeIds)`), so the lane moves on —
    capped at `TRANSCRIBE_MAX_ATTEMPTS` (5) → parks with `transcript_error`
    (reprocess un-parks, granting fresh attempts);
  - permanent (sidecar 422 undecodable / provider 4xx) → park, as before.
- **`TRANSCRIBER_TIMEOUT_MS` is retired.** Its successors bound single HTTP
  exchanges (`TRANSCRIBER_HTTP_TIMEOUT_MS`, 30s) and the stall window — never
  the job, whose duration is unbounded by design.

## Quality (the Romanian half)

- **`WHISPER_MODEL` default `base` → `small`** (Dockerfile arg + compose + the
  app's stamp default). `base` is measurably weak on non-English speech; the
  nondeterministic outputs were its fallback sampling. Cost: ~2.5–3× the CPU
  time (a 2h clip ≈ 1.5–2h; fine for a background lane), ~1.5 GB resident.
  The engine stamp (`whisper:small`) makes every cached transcript re-transcribe
  on next touch — intended.
- **`WHISPER_LANGUAGE` pin** (new, optional, `.env` → compose → sidecar): a
  deployment whose library is one language can pin it (e.g. `ro`) so
  auto-detect can't misroute a transcript off a musical/silent first 30s.
  Default is unset = auto-detect per file — the right default for a
  general-purpose deployment.
- **`condition_on_previous_text=False`**: window independence beats the
  repetition death-loops whisper is known for on long recordings.
- **`ValueError` is no longer "undecodable input"** — it can escape inference
  internals; misreading it permanently failed good files. Permanent is now only
  av-module errors + `EOFError`; everything else is transient and the attempt
  cap contains it.

## Verified

- `test/audio.test.js`: submit→poll→text protocol, the full failure taxonomy
  (lane vs job scope vs permanent), stall detection, probe deadline, the
  `transcribeFailurePolicy` matrix, and per-item queue exclusion. Full suite
  green.
- Real 2h+ clip end-to-end is a compose-stack manual run (rebuild both images,
  upload, watch `job <id>: <n>/<total>s` heartbeats in the transcriber log).

## Notes / future

- Job state is in-memory by design (the ledger of record is `payload.transcript`
  + the job log app-side); a sidecar restart costs at most one redo of the
  in-flight clip, and the 404-on-poll → resubmit path covers it.
- The job log could stamp live `progress` into the running row's detail for the
  Jobs modal — deliberately not done here to keep the modal's contract
  untouched.
- The extractor still uses the sync 240s POST. Fine for its workload today; if
  OCR of huge PDFs ever hits the same wall, this sidecar is the template.
