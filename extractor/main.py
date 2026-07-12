"""
PDF structured-text extractor — POST /extract (raw PDF bytes) -> {"markdown": "..."}

Uses PyMuPDF (fitz) to extract text with bounding boxes + font metadata, then
reconstructs document hierarchy from font size and bold flags: large/bold spans
become headings, body text stays flat. Pages with no usable text layer
(scans, outlined text) fall back to Tesseract OCR — budget-capped so a huge
scanned doc can't wedge the single-threaded server for minutes.
"""
import json
import os
import time
from collections import Counter
from http.server import HTTPServer, BaseHTTPRequestHandler

import fitz  # pymupdf

MAX_CHARS = 60_000       # ~15k tokens; generous for any single document
MIN_PAGE_CHARS = 64      # under this, the page has no real text layer -> OCR
OCR_MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "20"))
OCR_DPI = 200

def page_text_dict(page, ocr_allowed):
    """The page's text dict, OCRing when the text layer is missing/thin.
    Returns (dict, status) with status in 'text' | 'ocr' | 'ocr-skipped'."""
    d = page.get_text("dict")
    chars = sum(
        len(s["text"].strip())
        for b in d["blocks"] if b["type"] == 0
        for l in b["lines"] for s in l["spans"]
    )
    if chars >= MIN_PAGE_CHARS:
        return d, "text"
    if not ocr_allowed:
        return d, "ocr-skipped"
    try:
        tp = page.get_textpage_ocr(language="eng", dpi=OCR_DPI, full=True)
        return page.get_text("dict", textpage=tp), "ocr"
    except Exception as exc:
        print(f"ocr failed on page {page.number}: {exc}", flush=True)
        return d, "text"

def pdf_to_markdown(pdf_bytes: bytes) -> str:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    # Extract each page's dict exactly once (OCR fallback per page), then run
    # both passes (body-size vote, markdown render) over the stored dicts.
    page_dicts = []
    ocr_used = skipped = 0
    for page in doc:
        d, status = page_text_dict(page, ocr_used < OCR_MAX_PAGES)
        if status == "ocr":
            ocr_used += 1
        elif status == "ocr-skipped":
            skipped += 1
        page_dicts.append(d)
    if ocr_used:
        print(f"ocr: {ocr_used} page(s)", flush=True)
    if skipped:
        print(f"ocr cap ({OCR_MAX_PAGES}) reached — {skipped} textless page(s) left unread", flush=True)

    # Pass 1: collect all non-empty span sizes to find the body-text size
    # (the most common size across the whole document).
    sizes = []
    for d in page_dicts:
        for b in d["blocks"]:
            if b["type"] != 0:
                continue
            for line in b["lines"]:
                for span in line["spans"]:
                    if span["text"].strip():
                        sizes.append(round(span["size"] * 2) / 2)  # bin to 0.5 pt

    if not sizes:
        return ""

    base = Counter(sizes).most_common(1)[0][0]

    # Pass 2: render structured markdown — one block per text block, lines
    # tagged as ## heading / ### subheading / plain text by relative size + bold.
    # Link annotations are collected per-page so linked spans get the URI
    # appended: "Dribbble" -> "[Dribbble](https://dribbble.com/...)" — this
    # is how hyperlinked labels (portfolio, LinkedIn) survive extraction.
    out = []
    for page_num, page in enumerate(doc):
        blocks = page_dicts[page_num]["blocks"]
        # Sort top-to-bottom then left-to-right so reading order is preserved
        # for single-column and most two-column layouts.
        blocks.sort(key=lambda b: (round(b["bbox"][1] / 10), b["bbox"][0]))

        # External URI links on this page: list of (Rect, uri) for overlap checks.
        page_links = [
            (fitz.Rect(lk["from"]), lk["uri"])
            for lk in page.get_links()
            if lk.get("kind") == fitz.LINK_URI and lk.get("uri")
        ]

        def uri_for_span(bbox):
            # Center-point containment, not intersects(): adjacent spans that
            # merely graze a link rect must not inherit its URL (a contact
            # line's every span would otherwise get wrapped).
            center = fitz.Point((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
            for link_rect, uri in page_links:
                if link_rect.contains(center):
                    return uri
            return None

        prev_had_content = False
        for b in blocks:
            if b["type"] != 0:
                continue

            block_lines = []
            for line in b["lines"]:
                # Coalesce adjacent spans sharing a URI into one run so a
                # label split across spans renders as a single [label](url).
                runs = []  # (uri_or_None, [texts])
                max_size = 0.0
                bold = False
                for span in line["spans"]:
                    t = span["text"]
                    if not t:
                        continue
                    uri = uri_for_span(span["bbox"])
                    if runs and runs[-1][0] == uri:
                        runs[-1][1].append(t)
                    else:
                        runs.append((uri, [t]))
                    if span["size"] > max_size:
                        max_size = span["size"]
                    if span["flags"] & 16:  # bold flag
                        bold = True

                parts = []
                for uri, texts in runs:
                    joined = "".join(texts)
                    label = joined.strip()
                    if uri:
                        parts.append(f"[{label}]({uri})" if label else uri)
                    else:
                        parts.append(joined)
                text = "".join(parts).strip()
                if not text:
                    continue

                if max_size >= base * 1.35:
                    block_lines.append(f"## {text}")
                elif max_size >= base * 1.1 or (bold and max_size >= base * 0.9):
                    block_lines.append(f"### {text}")
                else:
                    block_lines.append(text)

            if block_lines:
                if prev_had_content:
                    out.append("")
                out.extend(block_lines)
                prev_had_content = True

        if page_num < len(doc) - 1:
            out.append("")

    return "\n".join(out)[:MAX_CHARS]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/extract":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        t0 = time.monotonic()
        try:
            md = pdf_to_markdown(body)
            ms = (time.monotonic() - t0) * 1000
            print(f"extract {length}b -> {len(md)} chars in {ms:.0f}ms", flush=True)
            self._json(200, {"markdown": md})
        except Exception as exc:
            print(f"extract {length}b FAILED: {exc}", flush=True)
            self._json(500, {"error": str(exc)})

    def _json(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass  # suppress per-request access logs; startup line is enough


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 3002), Handler)
    print("extractor listening on :3002", flush=True)
    server.serve_forever()
