FROM python:3.12-slim
# tesseract-ocr backs the scanned-page fallback (PyMuPDF's get_textpage_ocr);
# the eng traineddata ships with the base package.
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
RUN pip install --no-cache-dir pymupdf
WORKDIR /app
COPY main.py .
EXPOSE 3002
CMD ["python", "-u", "main.py"]
