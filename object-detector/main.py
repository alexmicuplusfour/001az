"""
Open-vocabulary object detector — POST /detect
  {"image_b64": "...", "queries": ["car", "wheel"], "threshold": 0.3}
  -> {"objects": [{"label", "box": [x0,y0,x1,y1] normalized 0..1, "score"}, ...]}

LLMDet (grounding-DINO family) via HuggingFace transformers: takes an image and a
list of noun-phrase queries and returns a box + score + matched-phrase label per
detected object, with no per-class training. The model is baked into the image at
build (OBJECT_DETECTOR_MODEL), loaded once, and served offline. Synchronous like
the extractor (a detection is seconds, not the minutes a transcription can take),
single-threaded so one memory-heavy inference runs at a time.
"""
import base64
import io
import json
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import torch
from PIL import Image
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

MODEL_ID = os.environ.get("OBJECT_DETECTOR_MODEL") or "iSEE-Laboratory/llmdet_tiny"
DEFAULT_THRESHOLD = float(os.environ.get("OBJECT_DETECTOR_THRESHOLD") or "0.3")
# A near-full-frame box (≥ this fraction of BOTH dims) is the shape a grounding
# detector produces when the queried object is ABSENT and the phrase grounds to
# the whole scene. But a real object CAN legitimately fill the frame (a tightly-
# cropped logo, a close-up, a scanned document), so geometry alone can't tell the
# two apart — confidence can: the absent-query artifact is weak, a genuine fill-
# the-frame detection is confident. So a full-frame box is dropped ONLY when it's
# ALSO below FULL_FRAME_MIN_SCORE; a confident one is a real object and stays. The
# default sits just under LLMDet's real-detection range (~0.47+ in the benchmark)
# so those survive while the barely-over-threshold grounding is culled. Env-
# overridable like the threshold (a per-model tuning knob, not a rebuild).
FULL_FRAME_COVERAGE = 0.95
FULL_FRAME_MIN_SCORE = float(os.environ.get("OBJECT_DETECTOR_FULL_FRAME_MIN_SCORE") or "0.45")

print(f"object-detector: loading {MODEL_ID} ...", flush=True)
_processor = AutoProcessor.from_pretrained(MODEL_ID, local_files_only=True)
_model = AutoModelForZeroShotObjectDetection.from_pretrained(MODEL_ID, local_files_only=True).eval()
print("object-detector: ready", flush=True)


def detect(img, queries, threshold):
    W, H = img.size
    # grounding-DINO text format: lowercase phrases, each period-terminated, in ONE
    # string. The list-of-lists form mis-tokenizes a SINGLE query ("TextEncodeInput
    # must be Union[...]"); the string form is robust for one phrase or many, and
    # is what the labels come back matching (lowercased, for the worker's demux).
    text = " ".join(f"{q.strip().rstrip('.').lower()}." for q in queries)
    inputs = _processor(images=img, text=text, return_tensors="pt")
    with torch.no_grad():
        outputs = _model(**inputs)
    # NOTE: version-sensitive — transformers 5.x mangles the boxes; the image pins
    # transformers>=4.55,<5 (see Dockerfile). input_ids maps boxes → phrases.
    res = _processor.post_process_grounded_object_detection(
        outputs, inputs.input_ids, threshold=threshold, text_threshold=0.25, target_sizes=[(H, W)]
    )[0]
    objects = []
    for box, score, label in zip(res["boxes"].tolist(), res["scores"].tolist(), res["text_labels"]):
        x0, y0, x1, y1 = box
        # Canonical xyxy normalized to 0..1, clamped (models can spill past edges).
        bx0 = min(max(x0 / W, 0.0), 1.0)
        by0 = min(max(y0 / H, 0.0), 1.0)
        bx1 = min(max(x1 / W, 0.0), 1.0)
        by1 = min(max(y1 / H, 0.0), 1.0)
        # Drop a near-full-frame box only when it's ALSO low-confidence — the
        # absent-query "grounds to the whole scene" artifact (see the constants
        # above). A confident box that fills the frame is a real object (a
        # close-up, a tightly-cropped logo) and is kept.
        if (bx1 - bx0) >= FULL_FRAME_COVERAGE and (by1 - by0) >= FULL_FRAME_COVERAGE \
                and float(score) < FULL_FRAME_MIN_SCORE:
            continue
        objects.append({
            "label": label,
            "score": round(float(score), 4),
            "box": [round(bx0, 5), round(by0, 5), round(bx1, 5), round(by1, 5)],
        })
    return objects


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, data):
        payload = json.dumps(data).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client (e.g. the healthcheck) closed the connection early — benign

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": MODEL_ID})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/detect":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
            queries = [q for q in (req.get("queries") or []) if isinstance(q, str) and q.strip()]
            threshold = float(req.get("threshold") or DEFAULT_THRESHOLD)
            if not queries:
                self._json(200, {"objects": []})
                return
            # Decode is bad-input territory: unreadable base64, an unsupported or
            # truncated image. Such a request can never succeed, so return 422
            # (permanent) — the caller parks it on the first attempt instead of
            # reading a 500 as transient and burning its whole retry budget on a
            # file that will never decode. Mirrors the transcriber's bad-input park.
            try:
                img = Image.open(io.BytesIO(base64.b64decode(req["image_b64"]))).convert("RGB")
            except Exception as exc:
                print(f"detect bad image: {exc}", flush=True)
                self._json(422, {"error": f"undecodable image: {exc}"})
                return
            t0 = time.monotonic()
            objects = detect(img, queries, threshold)
            print(f"detect {len(queries)}q -> {len(objects)} obj in {(time.monotonic()-t0)*1000:.0f}ms", flush=True)
            self._json(200, {"objects": objects})
        except Exception as exc:
            # A genuine inference/internal fault — transient; the caller requeues.
            print(f"detect FAILED: {exc}", flush=True)
            self._json(500, {"error": str(exc)})

    def log_message(self, fmt, *args):
        pass  # suppress per-request access logs; the startup line is enough


class Server(HTTPServer):
    def handle_error(self, request, client_address):
        # An aborted client — the compose healthcheck reads the status line but
        # not the body, then closes — is routine, not a fault worth a traceback.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    server = Server(("0.0.0.0", 3004), Handler)
    print("object-detector listening on :3004", flush=True)
    server.serve_forever()
