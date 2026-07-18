"""
Audio transcriber — POST /transcribe (raw audio bytes) -> {"text": "..."}

Wraps faster-whisper (Whisper via CTranslate2, CPU int8). Decodes any container
PyAV understands (mp3/m4a/wav/flac/ogg/aac) straight from the request body — no
system ffmpeg, PyAV's wheels bundle the libraries. The model loads once at
startup; the single-threaded server serializes jobs the way the extractor does,
so a long clip holds the one slot until done (the caller's timeout covers the
queue). vad_filter drops silence for a faster, cleaner transcript.
"""
import io
import json
import os
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "base")
BEAM = int(os.environ.get("WHISPER_BEAM", "5"))
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
# Never touch the network at request time: a model that wasn't baked at build
# fails loudly here at startup instead of silently fetching mid-request.
LOCAL_ONLY = os.environ.get("WHISPER_LOCAL_ONLY", "1") == "1"
MAX_CHARS = 200_000  # defensive cap; the app truncates to ~50k for tagging anyway

print(f"loading whisper '{MODEL}' (compute={COMPUTE}, beam={BEAM})...", flush=True)
model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE, local_files_only=LOCAL_ONLY)
print(f"whisper '{MODEL}' ready", flush=True)


def transcribe_bytes(body: bytes) -> str:
    # segments is a generator — iterating it is what actually runs inference.
    segments, _info = model.transcribe(io.BytesIO(body), beam_size=BEAM, vad_filter=True)
    text = "".join(seg.text for seg in segments).strip()
    return text[:MAX_CHARS]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        t0 = time.monotonic()
        try:
            text = transcribe_bytes(body)
            ms = (time.monotonic() - t0) * 1000
            print(f"transcribe {length}b -> {len(text)} chars in {ms:.0f}ms", flush=True)
            self._json(200, {"text": text})
        except Exception as exc:
            print(f"transcribe {length}b FAILED: {exc}", flush=True)
            self._json(500, {"error": str(exc)})

    def _json(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass  # suppress per-request access logs; startup + per-job line is enough


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 3003), Handler)
    print("transcriber listening on :3003", flush=True)
    server.serve_forever()
