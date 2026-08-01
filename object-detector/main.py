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

MODEL_ID = os.environ.get("OBJECT_DETECTOR_MODEL", "iSEE-Laboratory/llmdet_tiny")
DEFAULT_THRESHOLD = float(os.environ.get("OBJECT_DETECTOR_THRESHOLD", "0.3"))

print(f"object-detector: loading {MODEL_ID} ...", flush=True)
_processor = AutoProcessor.from_pretrained(MODEL_ID, local_files_only=True)
_model = AutoModelForZeroShotObjectDetection.from_pretrained(MODEL_ID, local_files_only=True).eval()
print("object-detector: ready", flush=True)


def detect(image_bytes, queries, threshold):
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    W, H = img.size
    # grounding-DINO / mm-grounding-dino: text is a per-image list of noun phrases.
    inputs = _processor(images=img, text=[queries], return_tensors="pt")
    with torch.no_grad():
        outputs = _model(**inputs)
    # NOTE: this call is version-sensitive — transformers 5.x mangles the boxes;
    # the image pins transformers>=4.55,<5 (see Dockerfile).
    res = _processor.post_process_grounded_object_detection(
        outputs, threshold=threshold, target_sizes=[(H, W)]
    )[0]
    objects = []
    for box, score, label in zip(res["boxes"].tolist(), res["scores"].tolist(), res["text_labels"]):
        x0, y0, x1, y1 = box
        # Canonical xyxy normalized to 0..1, clamped (models can spill past edges).
        bx0 = min(max(x0 / W, 0.0), 1.0)
        by0 = min(max(y0 / H, 0.0), 1.0)
        bx1 = min(max(x1 / W, 0.0), 1.0)
        by1 = min(max(y1 / H, 0.0), 1.0)
        # Grounding detectors emit a near-full-frame box when the queried object
        # is ABSENT (the phrase grounds to the whole scene). Such a "detection"
        # carries no localization — a box over the entire image is meaningless —
        # so drop it. A real object almost never spans >95% of BOTH dimensions.
        if (bx1 - bx0) >= 0.95 and (by1 - by0) >= 0.95:
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
            image = base64.b64decode(req["image_b64"])
            queries = [q for q in (req.get("queries") or []) if isinstance(q, str) and q.strip()]
            threshold = float(req.get("threshold") or DEFAULT_THRESHOLD)
            if not queries:
                self._json(200, {"objects": []})
                return
            t0 = time.monotonic()
            objects = detect(image, queries, threshold)
            print(f"detect {len(queries)}q -> {len(objects)} obj in {(time.monotonic()-t0)*1000:.0f}ms", flush=True)
            self._json(200, {"objects": objects})
        except Exception as exc:
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
