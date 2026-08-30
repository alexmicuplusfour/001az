FROM python:3.12-slim
# No apt layer: faster-whisper decodes via PyAV, whose wheels bundle the ffmpeg
# libraries — unlike the extractor's tesseract, no system codec package needed.
# sherpa-onnx (speaker diarization) is likewise a self-contained manylinux
# wheel — it bundles its onnxruntime, no system package.
RUN pip install --no-cache-dir faster-whisper sherpa-onnx

# Diarization models, baked like the whisper model below (offline at runtime; a
# bad URL fails the build, never a request). ARG-swappable — the same one-knob
# deploy story as WHISPER_MODEL: pyannote-segmentation-3.0 is the segmenter,
# nemo titanet_small the voice-embedding extractor (sherpa's fastest documented
# pairing; English-trained, but voice embeddings generalize across languages —
# swap the URL to trade). Rev's reverb model rejected on license
# (non-commercial). Runtime opt-out: WHISPER_DIARIZE=0. This layer sits BEFORE
# the whisper bake so flipping WHISPER_MODEL (the common knob) doesn't
# invalidate it and re-download these.
ARG DIARIZE_SEGMENTATION_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
ARG DIARIZE_EMBEDDING_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx
COPY fetch-diarize-models.py /tmp/
RUN python /tmp/fetch-diarize-models.py && rm /tmp/fetch-diarize-models.py

# Bake the model at build so the first request isn't blocked by a HF fetch (and
# the runtime can run fully offline, local_files_only). The build ARG and the
# runtime ENV share ONE value, so the baked model IS the served model — build
# --build-arg WHISPER_MODEL=small to bake a beefier one and the runtime picks up
# the same name. HF_HOME (set before the pre-download) pins the cache to an
# inspectable path. Mirrors the app image's embedder pre-download.
# `small` default: `base` proved too weak for non-English speech (unstable,
# fallback-heavy output on Romanian); small is the lean end of usable. Still one
# knob — --build-arg WHISPER_MODEL=base to go back to the lighter model.
ARG WHISPER_MODEL=small
# Every model to bake, comma-separated (model-axis-plan.md). Defaults to just
# WHISPER_MODEL, so an existing build is byte-identical; add a second and the
# board modal grows a model picker offering exactly what is baked here —
# --build-arg BAKE_MODELS=small,medium. Each model costs its own download and
# image weight (small ~0.5GB, medium ~1.5GB), which is why this is opt-in.
ARG BAKE_MODELS=
ENV HF_HOME=/models
ENV WHISPER_MODEL=${WHISPER_MODEL}
ENV BAKE_MODELS=${BAKE_MODELS:-${WHISPER_MODEL}}
RUN python -c "import os; from faster_whisper import WhisperModel; [WhisperModel(m.strip(), device='cpu', compute_type='int8') for m in os.environ['BAKE_MODELS'].split(',') if m.strip()]"

WORKDIR /app
COPY main.py .
EXPOSE 3003
CMD ["python", "-u", "main.py"]
