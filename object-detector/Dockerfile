FROM python:3.12-slim
# Torch (CPU wheel) + transformers PINNED to the 4.5x line, + pillow. The pin is
# load-bearing: transformers 5.x has a grounding-DINO post-processing regression
# that mangles boxes (out-of-bounds, ~10px-wide) — 4.55–4.57 are correct. No
# OpenMMLab needed (LLMDet loads as a native transformers architecture).
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir "transformers>=4.55,<5" pillow

# Bake the model at build so the first request isn't blocked by a HF fetch and
# runtime is fully offline (local_files_only). The build ARG and runtime ENV share
# ONE value, so the baked model IS the served model — build --build-arg
# OBJECT_DETECTOR_MODEL=iSEE-Laboratory/llmdet_base for a beefier one and the
# runtime picks up the same name. HF_HOME (set before the pre-download) pins the
# cache to an inspectable path. Mirrors the transcriber/embedder bake.
# llmdet_tiny (default): ~6.5s/image on CPU, tight boxes, clearly beats OWLv2-base;
# _base / _large are more accurate and slower (a rebuild, not an .env flip).
ARG OBJECT_DETECTOR_MODEL=iSEE-Laboratory/llmdet_tiny
ENV HF_HOME=/models
RUN python -c "from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor; AutoProcessor.from_pretrained('${OBJECT_DETECTOR_MODEL}'); AutoModelForZeroShotObjectDetection.from_pretrained('${OBJECT_DETECTOR_MODEL}')"
ENV OBJECT_DETECTOR_MODEL=${OBJECT_DETECTOR_MODEL}

WORKDIR /app
COPY main.py .
EXPOSE 3004
# start-period covers the model load (~25s CPU) that precedes the server bind
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=180s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3004/health', timeout=5)"]
CMD ["python", "-u", "main.py"]
