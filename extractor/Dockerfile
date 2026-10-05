FROM python:3.12-slim
# OCR is PyMuPDF's own Tesseract, built into its wheel, which reads only the
# language files under TESSDATA_PREFIX. So the image installs those and not
# the tesseract-ocr program, which nothing here runs (with its libraries, about
# 90 MB). One Debian package per language, data only, with no dependencies.
# English is always installed: it's what a read falls back to. OCR_LANGS names
# the others by package (chi-sim is the chi_sim language): 27 common languages
# by default, about 75 MB; all 162 Debian has are 670 MB. The PDF card offers
# what's here (GET /health's `langs`). osd, Tesseract's page-orientation data,
# isn't used by this OCR, so it isn't installed. planning/pdf-conversion-plan.md, D11.
ARG OCR_LANGS="fra deu spa ita por nld pol ron ces swe dan nor fin hun tur rus ukr ell ara heb hin jpn kor chi-sim chi-tra vie ind"
RUN apt-get update \
    && apt-get install -y --no-install-recommends $(for l in eng $OCR_LANGS; do echo "tesseract-ocr-$l"; done) \
    && rm -rf /var/lib/apt/lists/*
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
RUN pip install --no-cache-dir pymupdf
WORKDIR /app
COPY main.py .
EXPOSE 3002
# The server process answers /health itself — the PDF work runs in a separate
# worker process — so a long OCR job can't make this check time out.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3002/health', timeout=5)"]
CMD ["python", "-u", "main.py"]
