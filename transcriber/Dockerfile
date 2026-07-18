FROM python:3.12-slim
# No apt layer: faster-whisper decodes via PyAV, whose wheels bundle the ffmpeg
# libraries — unlike the extractor's tesseract, no system codec package needed.
RUN pip install --no-cache-dir faster-whisper

# Bake the model at build so the first request isn't blocked by a HF fetch (and
# the runtime can run fully offline, local_files_only). The build ARG and the
# runtime ENV share ONE value, so the baked model IS the served model — build
# --build-arg WHISPER_MODEL=small to bake a beefier one and the runtime picks up
# the same name. HF_HOME (set before the pre-download) pins the cache to an
# inspectable path. Mirrors the app image's embedder pre-download.
ARG WHISPER_MODEL=base
ENV HF_HOME=/models
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"
ENV WHISPER_MODEL=${WHISPER_MODEL}

WORKDIR /app
COPY main.py .
EXPOSE 3003
CMD ["python", "-u", "main.py"]
