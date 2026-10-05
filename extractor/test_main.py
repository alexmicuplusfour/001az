"""
The extractor's own tests (planning/pdf-conversion-plan.md, Stages 1a-1b and 4). They
need PyMuPDF and Tesseract, which live in the extractor image, so they run
inside it with this folder mounted over /app:

    docker build -t 001az-extractor-test extractor
    docker run --rm -v "$PWD/extractor:/app" 001az-extractor-test python -m unittest -v

CI does the same (ci.yml, the extractor job). Python's own unittest and urllib
only, so there is nothing to install. OCR takes a second or more a page, so
the tests that need a long job use dense scanned pages against short windows,
and none of them depends on the runner being fast.
"""
import difflib
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

import pymupdf

import main

RECT = pymupdf.Rect(36, 36, 559, 806)


def text_doc(pages, lines=48):
    doc = pymupdf.open()
    for p in range(1, pages + 1):
        doc.new_page().insert_textbox(
            RECT, "\n".join(f"Exhibit {p}, line {l}: the quick brown fox jumps over the lazy dog." for l in range(lines)),
            fontsize=9)
    return doc


def text_pdf(pages, lines=48):
    return text_doc(pages, lines).tobytes()


def scan_pdf(pages, lines=6, tag=""):
    """Pages that are only pictures of text, so each one needs OCR. Every
    picture names its own page ("Page 2 ..."), so the pages OCR read can be told
    from the ones it didn't; `tag` makes otherwise-equal files differ."""
    out = pymupdf.open()
    for p in range(1, pages + 1):
        src = pymupdf.open()
        src.new_page().insert_textbox(
            RECT, "\n".join(f"{tag}Page {p}: the quick brown fox jumps over the lazy dog." for _ in range(lines)),
            fontsize=11)
        png = src[0].get_pixmap(dpi=150, colorspace=pymupdf.csGRAY).tobytes("png")
        page = out.new_page()
        page.insert_image(page.rect, stream=png)
    return out.tobytes()


# A made-up French page, accents and all, for the OCR language (Stage 4).
FRENCH = ("Le procès-verbal de la réunion du comité s'est tenu à Lyon le mardi. "
          "Les élèves ont reçu leurs bulletins trimestriels ; la conformité des "
          "équipements électriques a été vérifiée. Où est passée la clé de l'armoire ? "
          "Ça dépend du gardien, déjà absent depuis la rentrée. Garçon, fenêtre, naïve, "
          "été, Noël, thérapie, fièvre, hôpital, forêt, blé, déjà vu.")
ACCENTED = "éèêàçùôîëïÇ"


def french_scan():
    """One page that is only a picture of French text, as a scanner makes it."""
    src = pymupdf.open()
    src.new_page().insert_textbox(RECT, " ".join([FRENCH] * 8), fontsize=11, fontname="helv")
    out = pymupdf.open()
    page = out.new_page()
    page.insert_image(page.rect, pixmap=src[0].get_pixmap(dpi=200))
    return out.tobytes()


class ExtractorCase(unittest.TestCase):
    """A real server on a free port, with its own worker process."""
    settings = {}

    def setUp(self):
        self.srv = main.make_server("127.0.0.1", 0, **self.settings)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.srv.extractor.close()

    def call(self, method, path, body=None, headers=None, timeout=30):
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def submit(self, pdf, ocr_pages=None, lang=None):
        headers = {} if ocr_pages is None else {"X-OCR-Pages": str(ocr_pages)}
        if lang is not None:
            headers["X-OCR-Lang"] = lang
        return self.call("POST", "/jobs", pdf, headers)

    def until(self, job, statuses, timeout=180):
        """Poll until the job is in one of `statuses`; also returns every
        pages_done seen on the way."""
        seen, t0 = [], time.monotonic()
        while time.monotonic() - t0 < timeout:
            status, out = self.call("GET", f"/jobs/{job}")
            self.assertEqual(status, 200)
            seen.append(out["progress"]["pages_done"])
            if out["status"] in statuses:
                return out, seen
            time.sleep(0.05)
        self.fail(f"job {job} never reached {statuses}")

    def settle(self, job):
        return self.until(job, ("done", "failed"))[0]


class JobsTest(ExtractorCase):
    def test_a_submit_answers_at_once_and_pages_climb(self):
        t0 = time.monotonic()
        status, out = self.submit(scan_pdf(3))
        self.assertEqual(status, 202)
        self.assertLess(time.monotonic() - t0, 1.0, "the submit waited for the work")
        done, seen = self.until(out["job"], ("done", "failed"))
        self.assertEqual(done["status"], "done")
        self.assertEqual((done["report"]["pages"], done["report"]["ocr_pages"]), (3, 3))
        self.assertTrue(any(0 < n < 3 for n in seen), f"pages never climbed: {sorted(set(seen))}")
        for p in (1, 2, 3):
            self.assertIn(f"Page {p}:", done["markdown"])

    def test_health_answers_while_a_page_is_read_by_ocr(self):
        _, out = self.submit(scan_pdf(2, lines=48))
        self.until(out["job"], ("running",))
        slowest, while_running = 0.0, 0
        for _ in range(10):
            t0 = time.monotonic()
            status, health = self.call("GET", "/health", timeout=60)
            slowest = max(slowest, time.monotonic() - t0)
            self.assertEqual(status, 200)
            while_running += health["running"]
            time.sleep(0.1)
        self.assertLess(slowest, 1.0, "health waited on the OCR")
        self.assertGreater(while_running, 0, "the OCR was over before health was asked")

    def test_the_same_file_and_settings_join_one_job(self):
        pdf = scan_pdf(1)
        _, a = self.submit(pdf)
        record = self.srv.extractor.jobs[a["job"]]
        _, b = self.submit(pdf)
        self.assertEqual(a["job"], b["job"])  # the id is a hash: equal whatever happened
        self.assertIn(b["status"], ("queued", "running"))
        self.assertIs(self.srv.extractor.jobs[a["job"]], record, "joined, not queued a second time")
        self.settle(a["job"])
        self.assertEqual(self.submit(pdf)[1], {"job": a["job"], "status": "done"}, "a finished job is served from cache")
        self.assertNotEqual(self.submit(pdf, ocr_pages=0)[1]["job"], a["job"], "other settings are another job")

    def test_a_failed_job_runs_again_when_resubmitted(self):
        bad = b"this is not a pdf " * 20
        _, a = self.submit(bad)
        self.assertEqual(self.settle(a["job"])["status"], "failed")
        _, b = self.submit(bad)
        self.assertEqual(b, {"job": a["job"], "status": "queued"})

    def test_bad_requests(self):
        self.assertEqual(self.call("POST", "/jobs", b"")[0], 422)
        self.assertEqual(self.submit(text_pdf(1), ocr_pages="x")[0], 400)
        self.assertEqual(self.submit(text_pdf(1), ocr_pages="-1")[0], 400)
        self.assertEqual(self.call("GET", "/jobs/nope")[0], 404)

    def test_an_upload_cut_short_is_not_a_job(self):
        # The sender hung up mid-upload (its timeout, a restart): those bytes are
        # part of a file, and nobody will ever ask for the job.
        with socket.create_connection(("127.0.0.1", self.srv.server_address[1])) as s:
            s.sendall(b"POST /jobs HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n" + text_pdf(1)[:1000])
            s.shutdown(socket.SHUT_WR)
            reply = s.recv(4096)
        self.assertIn(b" 400 ", reply.split(b"\r\n")[0])
        self.assertEqual(self.srv.extractor.jobs, {})

    def test_unreadable_files_fail_for_good(self):
        locked = text_doc(1).tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="o", user_pw="u")
        truncated = text_pdf(3)[:400]
        for pdf, why in ((locked, "password-protected"), (truncated, "not a readable PDF"),
                         (b"hello " * 50, "not a readable PDF")):
            _, out = self.submit(pdf)
            done = self.settle(out["job"])
            self.assertEqual((done["status"], done.get("permanent")), ("failed", True), done)
            self.assertIn(why, done["error"])

    def test_a_long_text_pdf_comes_back_whole(self):
        _, out = self.submit(text_pdf(30))
        done = self.settle(out["job"])
        self.assertGreater(len(done["markdown"]), 60_000)
        self.assertIn("Exhibit 30, line 47", done["markdown"])
        self.assertEqual(done["report"]["text_pages"], 30)

    def test_an_ocr_limit_marks_the_unread_pages_in_place(self):
        _, out = self.submit(scan_pdf(3), ocr_pages=1)
        done = self.settle(out["job"])
        md = done["markdown"]
        self.assertIn("Page 1:", md)
        self.assertNotIn("Page 2:", md)
        line = "[Pages 2–3 are scanned and weren't read (OCR limit 1).]"
        self.assertIn(line, md)
        self.assertLess(md.index("Page 1:"), md.index(line), "the line stands where the pages were")
        self.assertEqual((done["report"]["ocr_pages"], done["report"]["skipped"]), (1, [[2, 3]]))

    def test_ocr_off_marks_every_scanned_page(self):
        _, out = self.submit(scan_pdf(2), ocr_pages=0)
        done = self.settle(out["job"])
        self.assertEqual(done["markdown"], "[Pages 1–2 are scanned and weren't read (OCR is off).]")
        self.assertEqual(done["report"]["chars"], 0)

    def test_a_short_page_with_nothing_drawn_is_not_a_scan(self):
        # A blank page and a heading on its own have little text, but no picture
        # and no drawing: OCR has nothing to find there, so no page went unread,
        # and the OCR budget goes to the real scan behind them.
        doc = pymupdf.open()
        doc.new_page()
        doc.new_page().insert_text((72, 72), "Part Two", fontsize=24)
        doc.insert_pdf(pymupdf.open(stream=scan_pdf(1, tag="Scanned "), filetype="pdf"))
        _, out = self.submit(doc.tobytes(), ocr_pages=1)
        done = self.settle(out["job"])
        self.assertNotIn("[Page", done["markdown"])
        self.assertIn("Part Two", done["markdown"])
        self.assertIn("Scanned Page 1:", done["markdown"])
        r = done["report"]
        self.assertEqual((r["text_pages"], r["ocr_pages"], r["skipped"]), (2, 1, []))


class LanguageTest(ExtractorCase):
    """The OCR language (planning/pdf-conversion-plan.md, Stage 4, D11)."""

    def read(self, pdf, lang=None):
        status, out = self.submit(pdf, lang=lang)
        self.assertEqual(status, 202)
        done = self.settle(out["job"])
        self.assertEqual(done["status"], "done")
        return done

    def test_a_french_scan_reads_right_in_french_and_not_in_english(self):
        # Measured at the close look: 344 of 464 words and 206 of 280 accented
        # letters in English; every one of both in French.
        pdf, truth = french_scan(), " ".join([FRENCH] * 8).split()
        want = sum(" ".join(truth).count(c) for c in ACCENTED)
        scores = {}
        for lang in ("fra", None):
            done = self.read(pdf, lang)
            # Words matched in order, the markdown's heading marks aside.
            got = [w for w in done["markdown"].split() if not w.startswith("#")]
            words = difflib.SequenceMatcher(None, truth, got, autojunk=False).ratio()
            accents = sum(done["markdown"].count(c) for c in ACCENTED)
            scores[lang] = (words, accents / want, done["report"]["lang"])
        self.assertEqual(scores["fra"][2], "fra")
        self.assertEqual(scores[None][2], "eng", "no header: English")
        self.assertGreater(scores["fra"][0], 0.97, f"French words: {scores}")
        self.assertGreater(scores["fra"][1], 0.97, f"French accents: {scores}")
        self.assertLess(scores[None][1], 0.9, f"English gets the accents wrong: {scores}")

    def test_a_language_the_image_lacks_is_read_in_english_and_said(self):
        # A saved choice an image rebuilt with fewer languages doesn't have:
        # Tesseract can't load it, which would fail every scanned page.
        done = self.read(scan_pdf(1), "xho")
        self.assertIn("Page 1:", done["markdown"])
        self.assertEqual((done["report"].get("lang"), done["report"].get("lang_missing")), ("eng", "xho"))
        self.assertEqual(done["report"]["ocr_failed"], [])
        self.assertNotIn("lang_missing", self.read(scan_pdf(1, tag="B"), "fra")["report"])

    def test_a_language_header_that_is_not_a_code_is_refused(self):
        for bad in ("fr", "FRA", "fra+eng", "../eng", "fra-CA", "chi_SIM"):
            status, out = self.submit(text_pdf(1), lang=bad)
            self.assertEqual(status, 400, bad)
            self.assertIn("X-OCR-Lang", out["error"])

    def test_another_language_is_another_job_and_english_is_one(self):
        pdf = text_pdf(1)
        _, plain = self.submit(pdf)
        _, english = self.submit(pdf, lang="eng")
        _, french = self.submit(pdf, lang="fra")
        self.assertEqual(plain["job"], english["job"], "English, asked for or not, is one job")
        self.assertNotEqual(plain["job"], french["job"])

    def test_the_image_has_its_languages_and_not_the_program_or_osd(self):
        # English, always, and the Dockerfile's others, by package name (chi-sim
        # is the chi_sim language).
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "Dockerfile")) as f:
            others = re.search(r'ARG OCR_LANGS="([^"]+)"', f.read()).group(1).split()
        _, health = self.call("GET", "/health")
        self.assertEqual(sorted(health["langs"]), sorted(["eng"] + [l.replace("-", "_") for l in others]))
        self.assertEqual(len(others), 27)
        # PyMuPDF's own Tesseract reads the language files; the program and its
        # libraries would be about 90 MB nothing runs, and osd 10 MB nothing reads.
        self.assertIsNone(shutil.which("tesseract"), "the tesseract-ocr program is installed")
        self.assertFalse(os.path.exists(os.path.join(pymupdf.get_tessdata(), "osd.traineddata")), "osd is installed")

    def test_the_languages_listed_are_the_codes_a_read_can_ask_for(self):
        # Not osd (the image has none, so a folder that does), nor a file named
        # otherwise, which X-OCR-Lang would refuse: the card would offer it.
        with tempfile.TemporaryDirectory() as folder:
            for name in ("eng", "chi_sim", "osd", "Fraktur", "eng.best"):
                open(os.path.join(folder, name + ".traineddata"), "w").close()
            saved = os.environ["TESSDATA_PREFIX"]
            os.environ["TESSDATA_PREFIX"] = folder
            try:
                self.assertEqual(main.ocr_languages(), ["chi_sim", "eng"])
            finally:
                os.environ["TESSDATA_PREFIX"] = saved


class StallTest(ExtractorCase):
    settings = {"page_stall_s": 0.5}

    def test_a_stalled_page_fails_its_job_and_the_next_job_runs(self):
        _, out = self.submit(scan_pdf(1, lines=48))
        done = self.settle(out["job"])
        self.assertEqual((done["status"], done.get("permanent")), ("failed", False), done)
        self.assertIn("stalled: page 1", done["error"])
        _, out = self.submit(text_pdf(2))
        done = self.settle(out["job"])
        self.assertEqual(done["status"], "done", "a fresh worker took the next job")
        self.assertIn("Exhibit 2, line 47", done["markdown"], "with this job's text, not the stalled one's")


class PageTest(unittest.TestCase):
    def test_a_scanned_page_ocr_did_not_read_holds_no_picture(self):
        # Each page's text is kept until its job ends. Read the default way it
        # carried the page's picture too: hundreds of KB per scanned page.
        doc = pymupdf.open(stream=scan_pdf(1), filetype="pdf")
        d, status = main.page_text_dict(doc[0], ocr_allowed=False)
        self.assertEqual(status, "ocr-skipped", "still found to be a scan")
        self.assertEqual([b["type"] for b in d["blocks"] if b["type"] == 1], [], "no picture held")

    def test_a_scan_drawn_inside_another_object_is_still_a_scan(self):
        # A page that shows a scanned page as a form (how some tools combine
        # or stamp PDFs): the picture sits a level down, and is still seen.
        scan = pymupdf.open(stream=scan_pdf(1), filetype="pdf")
        doc = pymupdf.open()
        page = doc.new_page()
        page.show_pdf_page(page.rect, scan, 0)
        _, status = main.page_text_dict(doc[0], ocr_allowed=False)
        self.assertEqual(status, "ocr-skipped")


class WhereTest(unittest.TestCase):
    def test_a_job_past_its_last_page_names_the_last_page(self):
        # Every page read, the text being put together: never "page 101 of 100".
        where = main.Extractor._where
        self.assertEqual(where({"pages_done": 100, "pages_total": 100}), "page 100 of 100")
        self.assertEqual(where({"pages_done": 4, "pages_total": 100}), "page 5 of 100")
        self.assertEqual(where({"pages_done": 0, "pages_total": None}), "page 1")


class QueueTest(ExtractorCase):
    settings = {"queue_max": 1}

    def test_a_full_queue_answers_503(self):
        s1, a = self.submit(scan_pdf(1, lines=48, tag="A"))
        self.until(a["job"], ("running",))
        s2, _ = self.submit(scan_pdf(1, lines=48, tag="B"))
        s3, _ = self.submit(scan_pdf(1, lines=48, tag="C"))
        self.assertEqual((s1, s2, s3), (202, 202, 503))


class OcrFailureTest(ExtractorCase):
    """No language data: Tesseract can't start, the way a missing language
    would fail. The worker process is started with this environment."""

    def setUp(self):
        self.prefix = os.environ.get("TESSDATA_PREFIX")
        os.environ["TESSDATA_PREFIX"] = tempfile.mkdtemp()
        super().setUp()

    def tearDown(self):
        super().tearDown()
        os.environ["TESSDATA_PREFIX"] = self.prefix

    def test_a_page_ocr_cannot_read_is_counted_and_marked(self):
        _, out = self.submit(scan_pdf(1))
        done = self.settle(out["job"])
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["report"]["ocr_failed"], [[1, 1]])
        self.assertEqual(done["markdown"], "[Page 1 is scanned, but OCR couldn't read it.]")


class RetainTest(ExtractorCase):
    """Finished results are kept within a size cap, oldest dropped first and
    the newest never: the app hasn't collected that one yet."""

    def read_three(self, cap):
        """Read 1-, 2- and 3-page PDFs under `cap`; their job ids, oldest first."""
        self.srv.extractor.retain_max_chars = cap
        jobs = []
        for pages in (1, 2, 3):
            _, out = self.submit(text_pdf(pages))
            self.assertEqual(self.settle(out["job"])["status"], "done")
            jobs.append(out["job"])
        # The loop applies the cap just after a job settles; apply it now rather
        # than wait for that.
        self.srv.extractor._purge()
        return jobs

    def kept(self, jobs):
        return [self.call("GET", f"/jobs/{job}")[0] == 200 for job in jobs]

    def test_the_oldest_results_go_first(self):
        sizes = [len(main.read_pdf(text_pdf(pages))[0]) for pages in (1, 2, 3)]
        # Room for the two newest: only the oldest has to go.
        self.assertEqual(self.kept(self.read_three(sizes[1] + sizes[2])), [False, True, True])

    def test_the_newest_stays_even_when_it_alone_is_over_the_cap(self):
        jobs = self.read_three(1000)
        self.assertEqual(self.kept(jobs), [False, False, True])
        self.assertIn("Exhibit 3, line 47", self.call("GET", f"/jobs/{jobs[2]}")[1]["markdown"])


if __name__ == "__main__":
    unittest.main()
