# Build-time download of the diarization models (structured-transcripts-plan.md
# slice 3) — the diarization peer of the Dockerfile's whisper pre-download, and
# python-only like everything else in this image (python:slim has no curl/wget,
# and we keep the no-apt property). The segmentation tarball's fp32 model.onnx
# is extracted (int8 skipped — it's 5.7MB, accuracy is worth it); the embedding
# model is a bare .onnx. Both land at fixed paths main.py reads, and a bad URL
# fails the BUILD, never a request.
#
# NB the upstream release tag really is spelled "recongition" — [sic], theirs.
import os
import sys
import tarfile
import tempfile
import urllib.request

SEG_URL = os.environ["DIARIZE_SEGMENTATION_URL"]
EMB_URL = os.environ["DIARIZE_EMBEDDING_URL"]
DEST = "/models/diarize"

os.makedirs(DEST, exist_ok=True)

print(f"fetching segmentation model: {SEG_URL}", flush=True)
with tempfile.TemporaryDirectory() as tmp:
    tar_path = os.path.join(tmp, "seg.tar.bz2")
    urllib.request.urlretrieve(SEG_URL, tar_path)
    with tarfile.open(tar_path) as tar:
        tar.extractall(tmp, filter="data")
    # The tarball wraps one directory holding model.onnx (+ model.int8.onnx).
    hits = [os.path.join(root, f) for root, _, files in os.walk(tmp)
            for f in files if f == "model.onnx"]
    if len(hits) != 1:
        sys.exit(f"expected exactly one model.onnx in {SEG_URL}, found {len(hits)}")
    os.replace(hits[0], os.path.join(DEST, "segmentation.onnx"))

print(f"fetching embedding model: {EMB_URL}", flush=True)
urllib.request.urlretrieve(EMB_URL, os.path.join(DEST, "embedding.onnx"))

for f in ("segmentation.onnx", "embedding.onnx"):
    size = os.path.getsize(os.path.join(DEST, f))
    print(f"{f}: {size / 1e6:.1f}MB", flush=True)
