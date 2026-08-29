"""
Audio transcriber — an async job queue around faster-whisper.

    POST /transcribe   (raw audio bytes)  -> 202 {"job": <id>, "status": ...}
    GET  /jobs/<id>                       -> {"status": "queued"|"running"|"done"|"failed", ...}
    GET  /health                          -> {"ok": true, "model": ..., "queued": n}

Why a job API and not one synchronous POST: a 2-hour clip takes ~real-time to
transcribe on CPU, and no caller should hold an HTTP request open that long. The
old sync shape meant the caller's timeout aborted the socket while inference kept
running, the finished text died on a broken pipe, and the retry started the same
41-minute job again — forever. Here the submit returns immediately and the caller
polls; no request ever spans inference, so no timeout can orphan completed work.

The job id is a hash of the audio bytes: a resubmit (worker retry, app restart)
re-joins the existing queued/running job instead of duplicating inference, and a
finished result stays claimable for RETAIN_S, so work is never thrown away.

Decoding rides PyAV (bundled ffmpeg libs — no system codec package); the models
load once at startup. Speaker diarization (sherpa-onnx, WHISPER_DIARIZE) runs as
a pre-ASR phase over the same decoded audio and labels each turn "S1"/"S2".
Inference stays strictly single-threaded (one worker
thread owns both models); the HTTP server is threaded but its handlers only
enqueue and look up. Tiny payloads (admin probes, voice notes) take an express
lane serviced between segments of a long job, so a 2-hour grind never makes the
"Test" button hang for an hour.
"""
import hashlib
import io
import json
import os
import sys
import threading
import time
from collections import deque
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

MODEL = os.environ.get("WHISPER_MODEL", "small")
BEAM = int(os.environ.get("WHISPER_BEAM", "5"))
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
# Optional language pin (e.g. "ro"). Unset = per-file auto-detect, which reads
# the first 30s — a musical or silent intro can misroute a whole transcript, so
# pin it when the library is known to be one language.
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None
# Never touch the network at request time: a model that wasn't baked at build
# fails loudly here at startup instead of silently fetching mid-request.
LOCAL_ONLY = os.environ.get("WHISPER_LOCAL_ONLY", "1") == "1"
MAX_CHARS = 200_000  # defensive cap; the app truncates to ~50k for tagging anyway
RETAIN_S = 3600  # finished jobs stay claimable this long (covers app restarts / poll blips)
EXPRESS_MAX_BYTES = 2_000_000  # payloads at most this big jump the queue (probes, voice notes)
QUEUE_MAX = 4  # per lane; the app submits serially, so deeper means something is wrong
HEARTBEAT_S = 60  # progress log cadence for long jobs
# Self-heal for a truly hung inference (progress frozen while "running"): exit
# the process and let docker's restart policy bring up a fresh model. 0 disables.
WATCHDOG_S = int(os.environ.get("WHISPER_WATCHDOG_S", "1800"))
# Speaker diarization (structured-transcripts-plan.md slice 3): sherpa-onnx
# (pyannote segmentation + voice embeddings + clustering), models baked at
# build like the whisper model. Every job diarizes — the express lane is a
# SIZE cut, not a purpose cut, so skipping there would silently strip speakers
# from small user files (voice notes); a tiny probe diarizes in milliseconds.
# The threshold drives unknown-speaker-count clustering: lower splits more
# readily. 0.8 was derived empirically (2026-08-29) on a two-clip probe — a
# noisy single-voice phone video (fragments into 4+ "speakers" at 0.5, whole
# at 0.8) against a clean two-voice dialog (still cleanly 2 at 0.85, merges at
# 0.9). A default, not a law — re-transcribing after a tweak is the remedy.
DIARIZE = os.environ.get("WHISPER_DIARIZE", "1") == "1"
DIARIZE_THRESHOLD = float(os.environ.get("WHISPER_DIARIZE_THRESHOLD", "0.8"))
# Fixed paths, baked by fetch-diarize-models.py. Swapping models is the
# Dockerfile ARG (a rebuild, like WHISPER_MODEL) — or mount over these paths.
DIARIZE_SEG = "/models/diarize/segmentation.onnx"
DIARIZE_EMB = "/models/diarize/embedding.onnx"

print(f"loading whisper '{MODEL}' (compute={COMPUTE}, beam={BEAM}, language={LANGUAGE or 'auto'})...", flush=True)
model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE, local_files_only=LOCAL_ONLY)
print(f"whisper '{MODEL}' ready", flush=True)

diarizer = None
if DIARIZE:
    import sherpa_onnx
    # Missing model files throw HERE, at startup — the same fail-loud property
    # as the whisper local_files_only bake, never a mid-request surprise.
    diarizer = sherpa_onnx.OfflineSpeakerDiarization(
        sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=DIARIZE_SEG)),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=DIARIZE_EMB),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=DIARIZE_THRESHOLD),
            min_duration_on=0.3, min_duration_off=0.5,
        ))
    # One decode serves whisper AND the diarizer, so their rates must agree.
    if diarizer.sample_rate != 16000:
        raise RuntimeError(f"diarizer wants {diarizer.sample_rate}Hz, whisper decode is 16000Hz")
    print(f"diarizer ready (threshold={DIARIZE_THRESHOLD})", flush=True)

# All job state lives here, keyed by content hash. body is held only until the
# job runs (dedupe means one copy per unique file), then dropped for the text.
jobs = {}
lock = threading.Lock()
main_q = deque()
express_q = deque()
wake = threading.Event()


def _is_permanent(exc: Exception) -> bool:
    # Bad input (undecodable/truncated audio) — parking it beats requeueing it
    # forever. PyAV surfaces unreadable containers as av.* errors; a truncated
    # stream can also end in a bare EOFError. ValueError is deliberately NOT
    # here: it can escape inference internals too, and misreading an internal
    # fault as "bad input" would permanently fail a good file — transient +
    # the caller's attempt cap handles those.
    return type(exc).__module__.split(".", 1)[0] == "av" or isinstance(exc, EOFError)


def _drain_express():
    # Service the express lane between ASR segments of a long job — a tiny
    # probe answers in seconds instead of queueing behind hours of audio.
    # Express jobs run with drain_express=False, so nesting stops at depth one.
    while True:
        with lock:
            nxt = express_q.popleft() if express_q else None
        if nxt is None:
            break
        _run_job(nxt, drain_express=False)


def _diarize(job_id: str, audio, duration: float):
    # Who-spoke-when as sorted (start, end, speaker-int) ranges. Runs BEFORE
    # the ASR pass and reports its own monotonic progress (diarized_s): the
    # app's stall detector sums done_s + diarized_s, so neither phase can look
    # frozen while it advances — a 2h clip diarizes for many minutes with
    # done_s still 0, which would otherwise trip the 15-minute stall window.
    #
    # The callback is progress-ONLY — deliberately no express drain here: that
    # would re-enter diarizer.process() on the same native object from inside
    # its own callback, which sherpa gives no re-entrancy guarantee for. (The
    # ASR loop's drain is different in kind — there the outer whisper GENERATOR
    # is merely a paused Python frame, and the nested job builds a fresh one.)
    # Express jobs wait out this phase, same as they always waited out the
    # pre-segment decode+VAD stretch — bounded minutes, not hours.
    def on_progress(done_chunks, total_chunks):
        with lock:
            jobs[job_id]["diarized_s"] = round(done_chunks / max(total_chunks, 1) * duration, 1)
            jobs[job_id]["advanced"] = time.monotonic()
        return 0

    t0 = time.monotonic()
    ranges = [(r.start, r.end, int(r.speaker))
              for r in diarizer.process(audio, callback=on_progress).sort_by_start_time()]
    with lock:
        jobs[job_id]["diarized_s"] = round(duration, 1)
    print(f"job {job_id}: diarized {duration:.0f}s -> {len(ranges)} ranges, "
          f"{len({s for _, _, s in ranges})} speakers in {time.monotonic() - t0:.0f}s", flush=True)
    return ranges


def _speaker_matcher(ranges):
    # match(start, end) → the speaker whose range overlaps most, or None
    # (music, a hallucinated segment outside any speech range). Ranges and ASR
    # segments are both time-sorted, so one forward-only anchor serves the
    # whole clip — and it lives here, not threaded through the caller's loop.
    idx = 0

    def match(start, end):
        nonlocal idx
        while idx < len(ranges) and ranges[idx][1] <= start:
            idx += 1
        best, best_ov = None, 0.0
        j = idx
        while j < len(ranges) and ranges[j][0] < end:
            ov = min(end, ranges[j][1]) - max(start, ranges[j][0])
            if ov > best_ov:
                best_ov, best = ov, ranges[j][2]
            j += 1
        return best

    return match


def _transcribe(job_id: str, body: bytes, drain_express: bool):
    # ONE decode serves both passes (float32 16kHz mono). A 2h clip is ~460MB
    # decoded — not new: whisper's internal decode always materialized this
    # same array; now it's shared instead of owned. PyAV errors throw from
    # here instead of inside transcribe() — same av.* types, same permanence
    # taxonomy.
    audio = decode_audio(io.BytesIO(body))
    duration = len(audio) / 16000
    with lock:
        jobs[job_id]["total_s"] = round(duration, 1)

    ranges = _diarize(job_id, audio, duration) if diarizer else []

    # segments is a generator — iterating it is what actually runs inference.
    # transcribe() runs VAD over the array first, so the first segment can
    # still be a while away on a long clip; progress ticks per segment after.
    segments, info = model.transcribe(
        audio, beam_size=BEAM, vad_filter=True, language=LANGUAGE,
        # Feeding each window the previous text helps coherence but lets one bad
        # window snowball into the repetition loops whisper is known for on long
        # recordings; independence per window is the robust trade.
        condition_on_previous_text=False,
    )
    # Both consumers are done with the raw array (whisper turned it into mel
    # features before returning) — drop our reference so a 2h clip's ~460MB
    # doesn't sit pinned through the hours-long segment loop, where nested
    # express jobs decode their own audio on this same thread.
    audio = None
    parts = []
    # The per-segment structure the flat join used to discard: start/end (0.1s,
    # matching done_s precision) + stripped text + the diarizer's speaker slot
    # when one overlaps. Turns stay 1:1 with ASR segments — the client's
    # paragraph planner does the merging; merging same-speaker runs HERE would
    # collapse a monologue into one mega-turn and defeat the planner's length
    # cap. The flat text stays the canonical material — turn texts are stripped
    # individually, so they need not concatenate to it byte-for-byte.
    turns = []
    used = 0  # raw chars accumulated — turns stop at the same cap as the text
    speaker_at = _speaker_matcher(ranges)
    last_beat = time.monotonic()
    for seg in segments:
        parts.append(seg.text)
        if used < MAX_CHARS:
            turn = {"start": round(seg.start, 1), "end": round(seg.end, 1), "text": seg.text.strip()}
            speaker = speaker_at(seg.start, seg.end)
            if speaker is not None:
                turn["speaker"] = f"S{speaker + 1}"
            turns.append(turn)
        used += len(seg.text)
        with lock:
            jobs[job_id]["done_s"] = round(seg.end, 1)
            jobs[job_id]["advanced"] = time.monotonic()
        if time.monotonic() - last_beat >= HEARTBEAT_S:
            print(f"job {job_id}: {seg.end:.0f}/{info.duration:.0f}s", flush=True)
            last_beat = time.monotonic()
        if drain_express:
            _drain_express()
    return "".join(parts).strip()[:MAX_CHARS], turns


def _run_job(job_id: str, drain_express: bool = True):
    with lock:
        job = jobs.get(job_id)
        if job is None or job["status"] != "queued":
            return
        job["status"] = "running"
        job["advanced"] = time.monotonic()
        body = job["body"]
    t0 = time.monotonic()
    try:
        text, turns = _transcribe(job_id, body, drain_express)
        with lock:
            job.update(status="done", text=text, turns=turns, body=None, finished=time.monotonic())
        print(f"job {job_id}: {len(body)}b -> {len(text)} chars in {(time.monotonic() - t0):.0f}s", flush=True)
    except Exception as exc:
        permanent = _is_permanent(exc)
        with lock:
            job.update(status="failed", error=str(exc)[:500], permanent=permanent,
                       body=None, finished=time.monotonic())
        print(f"job {job_id}: FAILED ({'permanent' if permanent else 'transient'}): {exc}", flush=True)


def _purge():
    cutoff = time.monotonic() - RETAIN_S
    with lock:
        for jid in [j for j, job in jobs.items() if job["finished"] and job["finished"] < cutoff]:
            del jobs[jid]


def _worker():
    while True:
        with lock:
            job_id = express_q.popleft() if express_q else (main_q.popleft() if main_q else None)
        if job_id is None:
            wake.wait(timeout=5)
            wake.clear()
            _purge()
            continue
        try:
            _run_job(job_id)
        except Exception as exc:  # belt & braces — a worker death would strand the queue
            print(f"worker error on job {job_id}: {exc}", flush=True)
        _purge()


def _watchdog():
    # A running job whose progress hasn't moved in WATCHDOG_S means inference is
    # hung (not slow — segments land every few seconds even at 'medium' on CPU,
    # and the pre-segment decode+VAD phase is minutes, not half an hour). The
    # only cure is a fresh process; the caller's 404-on-poll handles the loss.
    while True:
        time.sleep(60)
        now = time.monotonic()
        with lock:
            hung = [j for j, job in jobs.items()
                    if job["status"] == "running" and now - job["advanced"] > WATCHDOG_S]
        if hung:
            print(f"watchdog: job {hung[0]} frozen for {WATCHDOG_S}s — exiting for a clean restart", flush=True)
            os._exit(1)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        if not body:
            self._json(422, {"error": "empty body"})
            return
        job_id = hashlib.sha256(body).hexdigest()[:16]
        with lock:
            job = jobs.get(job_id)
            # Dedupe by content: a queued/running twin is joined, a done result
            # is served from cache — but a FAILED record re-runs. Serving a
            # cached failure would poison every retry for RETAIN_S; a resubmit
            # after a failure is precisely the caller asking for another go.
            if job is None or job["status"] == "failed":
                q = express_q if length <= EXPRESS_MAX_BYTES else main_q
                if len(q) >= QUEUE_MAX:
                    self._json(503, {"error": "transcriber busy — queue full"})
                    return
                jobs[job_id] = {"status": "queued", "body": body, "text": None, "turns": None,
                                "error": None, "permanent": False, "done_s": 0.0, "diarized_s": 0.0,
                                "total_s": None, "advanced": time.monotonic(), "finished": None}
                q.append(job_id)
                wake.set()
                print(f"job {job_id}: queued {length}b{' (express)' if q is express_q else ''}", flush=True)
            status = jobs[job_id]["status"]
        self._json(202, {"job": job_id, "status": status})

    def do_GET(self):
        if self.path == "/health":
            with lock:
                queued = len(main_q) + len(express_q)
            self._json(200, {"ok": True, "model": MODEL, "queued": queued})
            return
        if self.path.startswith("/jobs/"):
            job_id = self.path[len("/jobs/"):]
            with lock:
                job = jobs.get(job_id)
                if job is None:
                    out, status = {"error": "unknown job"}, 404
                else:
                    out, status = {"status": job["status"],
                                   "progress": {"done_s": job["done_s"], "diarized_s": job["diarized_s"],
                                                "total_s": job["total_s"]}}, 200
                    if job["status"] == "done":
                        out["text"] = job["text"]
                        out["turns"] = job["turns"]
                        # The sidecar owns its model name: callers stamp
                        # transcripts from this (never from a mirrored env),
                        # so the stamp can't drift from the serving model.
                        out["model"] = MODEL
                    elif job["status"] == "failed":
                        out["error"], out["permanent"] = job["error"], job["permanent"]
            self._json(status, out)
            return
        self.send_response(404)
        self.end_headers()

    def _json(self, status, data):
        try:
            payload = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass  # poller gave up mid-reply — the job state is unaffected

    def log_message(self, fmt, *args):
        pass  # polls would flood the log; submit/heartbeat/finish lines are enough


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # An aborted client is routine (a poll timing out), not a fault worth a
        # traceback — the old sync server drowned its log in these.
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    threading.Thread(target=_worker, daemon=True).start()
    if WATCHDOG_S:
        threading.Thread(target=_watchdog, daemon=True).start()
    server = Server(("0.0.0.0", 3003), Handler)
    print("transcriber listening on :3003", flush=True)
    server.serve_forever()
