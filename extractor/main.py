"""
PDF text extractor — PyMuPDF turns each page into markdown, reconstructing the
document's hierarchy from font size and bold flags (large/bold spans become
headings, body text stays flat) and keeping links. Pages with no usable text
layer (scans, outlined text) are read with Tesseract OCR.

    POST /jobs      (raw PDF bytes)  -> 202 {"job": <id>, "status": ...}
                    X-OCR-Pages: n   how many scanned pages OCR reads (absent: all)
                    X-OCR-Lang: fra  the language OCR reads in (absent: English)
    GET  /jobs/<id>                  -> {"status": "queued"|"running"|"done"|"failed", ...}
    GET  /health                     -> {"ok": true, "queued": n, "running": bool, "langs": [...]}

A job API, like the transcriber's: OCR of a long scan takes minutes, and no
caller should hold a request open that long — the synchronous call's timeout
aborted the socket while the work went on, and the retry started it all over.
Here the submit answers at once and the caller polls. The job id hashes the
bytes and the settings, so a resubmit joins the job instead of redoing it, and
a finished result stays claimable for RETAIN_S, within RETAIN_MAX_CHARS.

The work runs in ONE separate worker PROCESS, not a thread. PyMuPDF holds
Python's lock for the whole of a page's OCR (measured: a thread ticking every
20ms froze for 4.7s during a 4.8s page), so a worker thread would freeze every
poll and health check for as long as a page takes, and a page that never
finished would freeze any watchdog with it. A process leaves this server free,
and it can be killed: a page that hasn't finished in PAGE_STALL_S fails its job
(not permanently — the caller's attempt cap decides), and a fresh worker takes
the next one. planning/pdf-conversion-plan.md, C1.
"""
import hashlib
import json
import multiprocessing as mp
import os
import re
import sys
import threading
import time
from collections import Counter, deque
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import pymupdf

MIN_PAGE_CHARS = 64      # under this, with a picture or drawing on it, the page is a scan -> OCR
OCR_DPI = 200
# Text without the page's pictures. Each page's dict is kept until the job ends,
# and read the default way it carried every picture on the page too: 264–608 KB
# for a scanned page OCR didn't read (measured 2026-10-05), so a limit of 20 on
# a 600-page scan held a few hundred MB. Rendering skips picture blocks anyway.
TEXT_FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
RETAIN_S = 3600          # finished jobs stay claimable this long (app restarts, poll blips)
# …and all of them together hold at most this much text. Nothing cuts a result,
# and a 1,000-page report is ~5M characters, so an hour of a board's long PDFs
# could otherwise sit here by the gigabyte. Past it the oldest finished go first,
# never the newest: the app hasn't collected that one yet.
RETAIN_MAX_CHARS = 64 * 1024 * 1024
QUEUE_MAX = 4            # queued jobs; the app sends one at a time, so deeper means something is wrong
# How long one page may take before its job is declared stuck. A dense page OCRs
# in ~5s; this is room for a huge page on a slow host, not a target.
PAGE_STALL_S = float(os.environ.get("EXTRACTOR_PAGE_STALL_S") or "300")

# The statuses of a page nobody read: its job's text says so in place, so the AI
# can't mistake a gap for "not in the document" (D3).
UNREAD = ("ocr-skipped", "ocr-failed")

# The language OCR reads in when none is asked for, and what a language this
# image doesn't have falls back to (the Dockerfile always bakes it).
DEFAULT_LANG = "eng"
# A Tesseract language code: three letters, then any parts naming a script or a
# variant (chi_sim, deu_latf, chi_sim_vert).
LANG_CODE = re.compile(r"[a-z]{3}(_[a-z]+)*")


class BadPdf(Exception):
    """The file itself can't be read. Permanent: a retry gets the same answer."""


def ocr_languages():
    """The OCR languages this image has — PyMuPDF's own tessdata lookup (it reads
    TESSDATA_PREFIX), without `osd`, which is Tesseract's page-orientation data,
    and without a file whose name isn't a language code, which a read couldn't
    ask for (X-OCR-Lang)."""
    try:
        folder = pymupdf.get_tessdata()
        names = sorted(f[: -len(".traineddata")] for f in os.listdir(folder) if f.endswith(".traineddata"))
    except Exception:
        return []
    return [n for n in names if n != "osd" and LANG_CODE.fullmatch(n)]


def page_text_dict(page, ocr_allowed, lang=DEFAULT_LANG):
    """The page's text dict, OCRing (in `lang`) when the text layer is missing/thin.
    Returns (dict, status), status one of 'text' | 'ocr' | 'ocr-skipped' | 'ocr-failed'."""
    d = page.get_text("dict", flags=TEXT_FLAGS)
    chars = sum(
        len(s["text"].strip())
        for b in d["blocks"] if b["type"] == 0
        for l in b["lines"] for s in l["spans"]
    )
    if chars >= MIN_PAGE_CHARS:
        return d, "text"
    # Little text and nothing drawn — a blank page, a heading on its own: not a
    # scan. OCR would find nothing there, so it spends none of the OCR limit and
    # no line calls the page unread. get_image_info lists the page's pictures
    # without their bytes.
    if not page.get_image_info() and not page.get_cdrawings():
        return d, "text"
    if not ocr_allowed:
        return d, "ocr-skipped"
    try:
        # The OCR text page's own default flags hold no pictures already.
        tp = page.get_textpage_ocr(language=lang, dpi=OCR_DPI, full=True)
        return page.get_text("dict", textpage=tp), "ocr"
    except Exception as exc:
        # Kept as a status, not folded into "text": it used to pass silently as
        # a text page, and its gap read to the AI as absence.
        print(f"ocr failed on page {page.number + 1}: {exc}", flush=True)
        return d, "ocr-failed"


def unread_line(status, first, last, ocr_limit):
    """The line that stands in for a run of unread pages."""
    one = first == last
    pages = f"Page {first}" if one else f"Pages {first}–{last}"
    if status == "ocr-skipped":
        why = "OCR is off" if ocr_limit == 0 else f"OCR limit {ocr_limit}"
        return f"[{pages} {'is' if one else 'are'} scanned and {'was' if one else 'were'}n't read ({why}).]"
    return f"[{pages} {'is' if one else 'are'} scanned, but OCR couldn't read {'it' if one else 'them'}.]"


def page_runs(statuses, status):
    """[[first, last], …] (1-based) for each run of pages in `status`."""
    out = []
    for i, s in enumerate(statuses, 1):
        if s != status:
            continue
        if out and out[-1][1] == i - 1:
            out[-1][1] = i
        else:
            out.append([i, i])
    return out


def read_pdf(pdf_bytes, ocr_limit=None, progress=None, ocr_lang=None):
    """PDF bytes -> (markdown, report). A line stands where pages went unread.

    ocr_limit: how many scanned pages to read by OCR — None reads them all, 0
    none. ocr_lang: the language OCR reads in, None for English. progress(kind,
    *args) hears about each page of the slow first pass, and a beat now and then
    in the second."""
    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except pymupdf.FileDataError as exc:  # not a PDF, empty (EmptyFileError), truncated
        raise BadPdf(f"not a readable PDF ({exc})") from exc
    # It opens, but reading a page raises a plain ValueError — which used to come
    # back as a 500 and be retried as if the extractor were unwell.
    if doc.needs_pass:
        raise BadPdf("the PDF is password-protected")
    total = doc.page_count

    # A language this image doesn't have (one rebuilt with fewer than the app's
    # saved choice) is read in English, and the report says so. Tesseract can't
    # load a missing one, which would fail every scanned page; refused, the app
    # would park the PDF.
    lang, missing = ocr_lang or DEFAULT_LANG, None
    if lang != DEFAULT_LANG and lang not in ocr_languages():
        lang, missing = DEFAULT_LANG, lang

    # Extract each page's dict exactly once (OCR fallback per page), then run
    # both passes (body-size vote, markdown render) over the stored dicts.
    page_dicts, statuses = [], []
    ocr_used = 0
    for i, page in enumerate(doc):
        d, status = page_text_dict(page, ocr_limit is None or ocr_used < ocr_limit, lang)
        if status == "ocr":
            ocr_used += 1
        page_dicts.append(d)
        statuses.append(status)
        if progress:
            progress("page", i + 1, total)

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

    report = {
        "pages": total,
        "text_pages": statuses.count("text"),
        "ocr_pages": ocr_used,
        "skipped": page_runs(statuses, "ocr-skipped"),
        "ocr_failed": page_runs(statuses, "ocr-failed"),
        "chars": 0,  # the text it rendered (headings, links), not the marker lines
        "lang": lang,  # the language OCR read in
        **({"lang_missing": missing} if missing else {}),  # …and the one asked for, when it fell back
    }

    base = Counter(sizes).most_common(1)[0][0] if sizes else None

    # Pass 2: render structured markdown — one block per text block, lines
    # tagged as ## heading / ### subheading / plain text by relative size + bold.
    # Link annotations are collected per-page so linked spans get the URI
    # appended: "Dribbble" -> "[Dribbble](https://dribbble.com/...)" — this
    # is how hyperlinked labels (portfolio, LinkedIn) survive extraction.
    out = []
    for page_num, page in enumerate(doc):
        if progress and page_num % 100 == 99:
            progress("beat")
        status = statuses[page_num]
        prev_had_content = False
        # The first page of a run of unread pages carries the run's line.
        if status in UNREAD and (page_num == 0 or statuses[page_num - 1] != status):
            last = page_num
            while last + 1 < total and statuses[last + 1] == status:
                last += 1
            out.append(unread_line(status, page_num + 1, last + 1, ocr_limit))
            prev_had_content = True

        blocks = page_dicts[page_num]["blocks"] if base is not None else []
        # Sort top-to-bottom then left-to-right so reading order is preserved
        # for single-column and most two-column layouts.
        blocks.sort(key=lambda b: (round(b["bbox"][1] / 10), b["bbox"][0]))

        # External URI links on this page: list of (Rect, uri) for overlap checks.
        page_links = [
            (pymupdf.Rect(lk["from"]), lk["uri"])
            for lk in page.get_links()
            if lk.get("kind") == pymupdf.LINK_URI and lk.get("uri")
        ]

        def uri_for_span(bbox):
            # Center-point containment, not intersects(): adjacent spans that
            # merely graze a link rect must not inherit its URL (a contact
            # line's every span would otherwise get wrapped).
            center = pymupdf.Point((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
            for link_rect, uri in page_links:
                if link_rect.contains(center):
                    return uri
            return None

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
                report["chars"] += sum(len(l) for l in block_lines)
                prev_had_content = True

        if page_num < total - 1:
            out.append("")

    # A document that is all unread pages is just their lines.
    return "\n".join(out).strip("\n"), report


def _worker_main(conn):
    """The worker process: one job at a time, and the only place PyMuPDF does
    any work. Talks to the server over `conn`."""
    conn.send(("ready",))
    while True:
        try:
            body, settings = conn.recv()
        except (EOFError, OSError):
            return  # the server went away
        try:
            markdown, report = read_pdf(body, progress=lambda *msg: conn.send(msg), **settings)
            conn.send(("done", markdown, report))
        except Exception as exc:
            conn.send(("failed", str(exc)[:500], isinstance(exc, BadPdf)))


class Extractor:
    """The job store, the queue, and the one worker process that serves it."""

    def __init__(self, page_stall_s=PAGE_STALL_S, queue_max=QUEUE_MAX, retain_max_chars=RETAIN_MAX_CHARS):
        self.page_stall_s = page_stall_s
        self.queue_max = queue_max
        self.retain_max_chars = retain_max_chars
        self.jobs = {}
        self.lock = threading.Lock()
        self.queue = deque()
        self.wake = threading.Event()
        self.running = None
        self.closed = False
        self._proc = None
        self._conn = None
        threading.Thread(target=self._loop, daemon=True).start()

    def submit(self, body, settings):
        """-> (job id, status), or (None, None) when the queue is full."""
        # The settings are part of the identity: the same bytes at another OCR
        # limit or language are a DIFFERENT job, or a changed setting would be
        # served the old answer from cache. Two updates rather than `body + …`,
        # which would copy the whole upload to append a few bytes.
        h = hashlib.sha256(body)
        h.update(b"\x00" + json.dumps(settings, sort_keys=True).encode())
        job_id = h.hexdigest()[:16]
        with self.lock:
            job = self.jobs.get(job_id)
            # A queued/running twin is joined and a done result served from
            # cache — but a FAILED record runs again: a resubmit after a failure
            # is the caller asking for another go, and serving the cached
            # failure would poison every retry for RETAIN_S.
            if job is None or job["status"] == "failed":
                if len(self.queue) >= self.queue_max:
                    return None, None
                job = {"status": "queued", "body": body, "size": len(body), "settings": settings,
                       "markdown": None, "report": None, "error": None, "permanent": False,
                       "pages_done": 0, "pages_total": None, "advanced": None, "finished": None}
                self.jobs[job_id] = job
                self.queue.append(job_id)
                self.wake.set()
                print(f"job {job_id}: queued {len(body)}b", flush=True)
            return job_id, job["status"]

    def view(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                return None
            out = {"status": job["status"],
                   "progress": {"pages_done": job["pages_done"], "pages_total": job["pages_total"]}}
            if job["status"] == "done":
                out["markdown"], out["report"] = job["markdown"], job["report"]
            elif job["status"] == "failed":
                out["error"], out["permanent"] = job["error"], job["permanent"]
            return out

    def health(self):
        with self.lock:
            queued, running = len(self.queue), self.running is not None
        return {"ok": True, "queued": queued, "running": running, "langs": ocr_languages()}

    def close(self):
        self.closed = True
        self.wake.set()
        self._kill_worker()

    def _loop(self):
        while not self.closed:
            with self.lock:
                job_id = self.queue.popleft() if self.queue else None
            if job_id is None:
                self.wake.wait(timeout=5)
                self.wake.clear()
                self._purge()
                continue
            try:
                self._run(job_id)
            except Exception as exc:  # belt & braces — a dead loop would strand the queue
                print(f"job {job_id}: loop error: {exc}", flush=True)
                self._settle(self.jobs.get(job_id), status="failed", error=f"extractor error: {exc}")
            self._purge()

    def _run(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None or job["status"] != "queued":
                return
            body, settings = job["body"], job["settings"]
            job.update(status="running", body=None)
            self.running = job_id
        t0 = time.monotonic()
        try:
            conn = self._worker()
            # The page clock starts once the worker is up, so its start-up is
            # never charged to the first page.
            job["advanced"] = time.monotonic()
            conn.send((body, settings))
            poll = max(0.05, min(1.0, self.page_stall_s / 4))
            while True:
                if conn.poll(poll):
                    msg = conn.recv()  # EOFError when the worker died
                    if msg[0] == "page":
                        with self.lock:
                            job.update(pages_done=msg[1], pages_total=msg[2])
                        job["advanced"] = time.monotonic()
                    elif msg[0] == "beat":
                        job["advanced"] = time.monotonic()
                    elif msg[0] == "done":
                        self._settle(job, status="done", markdown=msg[1], report=msg[2])
                        r = msg[2]
                        print(f"job {job_id}: {job['size']}b -> {len(msg[1])} chars, {r['pages']} page(s), "
                              f"{r['ocr_pages']} by OCR in {time.monotonic() - t0:.1f}s", flush=True)
                        return
                    elif msg[0] == "failed":
                        self._settle(job, status="failed", error=msg[1], permanent=msg[2])
                        print(f"job {job_id}: FAILED ({'permanent' if msg[2] else 'transient'}): {msg[1]}", flush=True)
                        return
                elif time.monotonic() - job["advanced"] > self.page_stall_s:
                    self._kill_worker()
                    self._settle(job, status="failed",
                                 error=f"stalled: {self._where(job)} didn't finish within {self.page_stall_s:g}s")
                    print(f"job {job_id}: stalled on {self._where(job)} — worker replaced", flush=True)
                    return
        except (EOFError, OSError) as exc:
            code = self._proc.exitcode if self._proc else None
            self._kill_worker()
            self._settle(job, status="failed",
                         error=f"the PDF worker stopped on {self._where(job)} (exit code {code}): {exc or 'no reply'}")
            print(f"job {job_id}: worker died (exit code {code})", flush=True)
        finally:
            with self.lock:
                self.running = None

    @staticmethod
    def _where(job):
        # Past the last page it is putting the text together: the last page, as
        # the app's running row says it.
        total = job["pages_total"]
        if total:
            return f"page {min(job['pages_done'] + 1, total)} of {total}"
        return f"page {job['pages_done'] + 1}"

    def _worker(self):
        if self._proc is None or not self._proc.is_alive():
            self._kill_worker()
            # spawn, not fork: this process runs threads (the HTTP handlers),
            # and forking a threaded process can deadlock the child.
            ctx = mp.get_context("spawn")
            parent, child = ctx.Pipe()
            proc = ctx.Process(target=_worker_main, args=(child,), daemon=True)
            proc.start()
            child.close()  # so the parent sees EOF the moment the worker dies
            if not parent.poll(60) or parent.recv() != ("ready",):
                proc.kill()
                raise OSError("the PDF worker didn't start")
            self._proc, self._conn = proc, parent
        return self._conn

    def _kill_worker(self):
        proc, conn = self._proc, self._conn
        self._proc = self._conn = None
        if proc is not None:
            proc.kill()
            proc.join(5)
        if conn is not None:
            conn.close()

    def _settle(self, job, **fields):
        if job is None:
            return
        with self.lock:
            job.update(fields, finished=time.monotonic())

    def _purge(self):
        cutoff = time.monotonic() - RETAIN_S
        with self.lock:
            for jid in [j for j, job in self.jobs.items() if job["finished"] and job["finished"] < cutoff]:
                del self.jobs[jid]
            # Then the size cap, oldest first, sparing the newest: the app sends
            # one PDF at a time, so the newest result is the one it is about to
            # collect, and dropping it would only have the PDF read again.
            done = sorted((job["finished"], jid) for jid, job in self.jobs.items() if job["status"] == "done")
            held = sum(len(self.jobs[jid]["markdown"]) for _, jid in done)
            for _, jid in done[:-1]:
                if held <= self.retain_max_chars:
                    break
                held -= len(self.jobs.pop(jid)["markdown"])


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path.split("?", 1)[0] != "/jobs":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else b""
        if not body:
            self._json(422, {"error": "empty body"})
            return
        # The sender hung up mid-upload (its timeout, a restart): these bytes are
        # part of a file, and nobody would ever ask for the job.
        if len(body) < length:
            self._json(400, {"error": f"incomplete body: {len(body)} of {length} bytes"})
            return
        raw = (self.headers.get("X-OCR-Pages") or "").strip()
        if raw and not re.fullmatch(r"[0-9]+", raw):
            self._json(400, {"error": f"X-OCR-Pages must be a whole number, got {raw!r}"})
            return
        lang = (self.headers.get("X-OCR-Lang") or "").strip()
        if lang and not LANG_CODE.fullmatch(lang):
            self._json(400, {"error": f"X-OCR-Lang must be a language code like fra or chi_sim, got {lang!r}"})
            return
        # English, asked for or not, is one job: the settings are its identity,
        # and read_pdf's arguments by name.
        settings = {"ocr_limit": int(raw) if raw else None, "ocr_lang": None if lang in ("", DEFAULT_LANG) else lang}
        job_id, status = self.server.extractor.submit(body, settings)
        if job_id is None:
            self._json(503, {"error": "extractor busy — queue full"})
            return
        self._json(202, {"job": job_id, "status": status})

    def do_GET(self):
        ex = self.server.extractor
        if self.path == "/health":
            self._json(200, ex.health())
            return
        if self.path.startswith("/jobs/"):
            out = ex.view(self.path[len("/jobs/"):])
            if out is None:
                self._json(404, {"error": "unknown job"})
            else:
                self._json(200, out)
            return
        self.send_response(404)
        self.end_headers()

    def _json(self, status, data):
        try:
            payload = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the caller gave up mid-reply — the job state is unaffected

    def log_message(self, fmt, *args):
        pass  # polls would flood the log; job lines are enough


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # An aborted client is routine (a poll or the app's timeout), not a
        # fault worth a traceback.
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


def make_server(host="0.0.0.0", port=3002, **settings):
    server = Server((host, port), Handler)
    server.extractor = Extractor(**settings)
    return server


if __name__ == "__main__":
    server = make_server()
    print(f"extractor listening on :3002 (OCR languages: {', '.join(ocr_languages()) or 'none'})", flush=True)
    server.serve_forever()
