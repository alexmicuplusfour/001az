# PDFs: the hidden limits, a page setting, and a convert switch (2026-10-05)

Self-contained for a fresh session. Written from a deep dive on how the app reads
PDFs, which started from a check of Gemini's "extractor head-of-line" claim the
day before. Line links show the code at commit 4ecb2ae. Measured numbers say
where and when; everything else is read from the code or from the providers'
docs (linked at the end).

## The ask

- "20 pages was an ignorant arbitrary decision. it's opaque. we should allow the
  amount to be set in the pdf plugin config."
- "and also whether the pdfs should be converted (enabled by default) to whatever
  we convert them now, and with a short explanation as to the benefits of
  converting them."
- The user's calls on the first layer, the same day:
  - read every scanned page by default;
  - one text limit for the AI, the app's marked 150,000 characters;
  - the 100-page upload refusal goes;
  - the first draft of the switch's text was turned down: "user needs to know
    that the pdfs can be converted to text because it's cheaper, and also pdf
    might not work with some providers";
  - more providers reading PDF files and an OCR language setting are both in.

## What is actually happening

### How a PDF reaches the AI today

- **Upload.** The app checks the file is a PDF, reads its page count and title
  with poppler (`pdfinfo`), renders page 1 as the card face (`pdftoppm`) and
  stores the file. **A PDF over 100 pages is refused**
  ([sources/pdf.js:12](../server/sources/pdf.js#L12),
  [:51-56](../server/sources/pdf.js#L51-L56)). No text is taken out at upload,
  unlike a Word file, whose text is saved next to it then
  ([sources/docx.js:58-65](../server/sources/docx.js#L58-L65)).
- **Every time the AI needs it**, meaning field extraction, tagging and every
  retag, the worker sends the whole file to the extractor container and waits
  for the text ([worker.js:1681-1709](../server/worker.js#L1681-L1709)).
- **What the extractor does** (PyMuPDF, [extractor/main.py](../extractor/main.py)):
  - It turns each page into markdown. Headings come from font size and bold,
    links are kept as `[label](url)`, and reading order is fixed.
  - A page with under 64 characters of text is treated as a scan and read with
    OCR (Tesseract, English, 200 DPI), but **only the first 20 such pages**. The
    rest are skipped, and that's said only in the extractor's own log.
  - The result is **cut at 60,000 characters with no marker**
    ([main.py:18-23](../extractor/main.py#L18-L23),
    [:164](../extractor/main.py#L164)).
- **What the AI gets.** Tagging gets that text plus the page-1 picture
  ([worker.js:1766-1781](../server/worker.js#L1766-L1781)). Field extraction
  gets the text alone ([worker.js:1857-1878](../server/worker.js#L1857-L1878)).
- **A PDF with no text at all** is sent to the AI as the file itself. Only the
  Anthropic connection can do that. Every other provider fails the item with
  "use an Anthropic tagger for this board"
  ([wires/tool.js:54-63](../server/ai-providers/wires/tool.js#L54-L63),
  [compat.js:189](../server/ai-providers/wires/compat.js#L189),
  [google.js:85](../server/ai-providers/wires/google.js#L85)).
- **The lightbox** shows the PDF itself in the browser's viewer
  ([detail-view.js:188-206](../public/detail-view.js#L188-L206)). Converting
  only changes what the AI reads.
- **The extractor isn't part of the plugin system.** Its address is a constant
  in the worker, it has no health check, and its settings are environment
  variables that the compose file never passes
  ([docker-compose.yml:39-42](../docker-compose.yml#L39-L42)). The PDF card on
  the Plugins page covers the upload side only. Its one setting is the upload
  size ([plugins.js:130-151](../server/plugins.js#L130-L151),
  [plugin-modal.js:933-977](../public/plugin-modal.js#L933-L977)).

### The limits nobody can see

| Limit | Where | Visible? | Settable? |
|---|---|---|---|
| 20 scanned pages read by OCR | extractor, `OCR_MAX_PAGES` | extractor log only | an env var compose never passes, so no |
| 60,000 characters of text (~15 dense pages) | extractor, `MAX_CHARS` | no, cut silently | no |
| 100 pages per PDF | upload, `PDF_MAX_PAGES` | the upload's error | no |
| 4 minutes per extractor call | worker, `EXTRACTOR_TIMEOUT_MS` | no | env var |
| OCR in English only, at 200 DPI | extractor | no | no |
| 10 MB per PDF upload | PDF plugin | Plugins page | yes (today's one setting) |

- **Two text limits.** The app's own limit for what the AI reads is 150,000
  characters, with a marker when it cuts
  ([worker.js:1669-1679](../server/worker.js#L1669-L1679)). Word and text files
  get that one. PDFs never reach it, because the extractor has already cut at
  60,000 without saying so. The app's own comment there names the problem: an
  unmarked cut reads to the AI as "the rest isn't there".
- **The 100-page refusal is one vendor's file limit** (Anthropic: 100 pages per
  request). That limit only matters when the file itself is sent, which today
  happens only for a PDF with no text. So a 150-page report is refused at upload
  even though the text route would read it fine. No test covers the refusal and
  the README doesn't mention it.
- **Wrong labels.** The PDF plugin's description says "Extract text + a page-1
  preview (via poppler)", but the text comes from the extractor. The compose
  comment says the extractor does "PDF/docx text", but Word files never go
  through it.

### Measured (2026-10-04, this machine, the real extractor image, pymupdf 1.28.2)

- One dense scanned page through OCR: 4.9 s. A 600-page scan with the 20-page
  limit: 93 s (20 pages read, 580 skipped).
- Text PDFs: 600 pages in 1.3 s, 3,000 pages in 6.3 s. Every one was cut to
  60,000 characters.
- One PDF stuck in the extractor (the real worker, a throwaway test database,
  the extractor faked):
  - all 40 waiting PDFs were taken off the queue within a second, each holding
    its file in memory (+200 MB for 40 files of 5 MB);
  - a PDF from another board, uploaded afterwards, was read 41st of 41;
  - text files queued behind all 40 still got tagged within about 2 s. Only
    PDFs wait.

### Why the number can't just be raised

At ~5 s per scanned page, the 4-minute extractor call fits about 50 pages here.
It fits fewer on a slower host, or while the transcriber shares the CPU. Past
that:

1. **The extractor doesn't stop.** The call times out, but the extractor keeps
   working on that PDF anyway. The next PDF then waits behind it with its own
   clock already running.
2. **The slow PDF is retried as if the extractor were down.** It counts as
   "extractor unreachable" and runs 5 times in all, with waits of 1, 5, 15 and
   15 minutes between, doing the whole OCR again each time. Then it fails with
   that wrong reason ([db.js:4119-4141](../server/db.js#L4119-L4141)).
3. **Every pass reads it again.** Even when it fits, the same PDF is read 1–3
   times per pass: once for field extraction, once for tagging, and a second
   time inside field extraction for a PDF with no text
   ([worker.js:2634-2653](../server/worker.js#L2634-L2653)). Every retag reads
   it again. At 100 scanned pages, each read is about 8 minutes.
4. **Waiting PDFs are a cost too.** Each one holds its whole file in memory, and
   a long scan holds up every board's PDFs, not just its own board's.

**The transcriber already solved all four for audio**, and its plan says so:
"The extractor still uses the sync 240s POST. Fine for its workload today; if
OCR of huge PDFs ever hits the same wall, this sidecar is the template"
([transcriber-robustness-plan.md:99](transcriber-robustness-plan.md)). How audio
does it:

- Its text is made once and kept (`payload.transcript`).
- The tagging and field-extraction steps don't take a clip until its text
  exists ([migration 0057](../server/migrations/0057_awaiting_transcript.sql),
  [db.js:2867](../server/db.js#L2867)).
- Transcription runs as its own job, one at a time per engine
  ([worker.js:3044-3070](../server/worker.js#L3044-L3070)).
- The sidecar accepts a job and answers at once. The worker then checks on it
  and judges it by progress, not by a clock
  ([worker.js:1109-1255](../server/worker.js#L1109-L1255)).

### Which AI providers can read a PDF file

Checked against each provider's docs on 2026-10-05. None of this was tried with
a live key.

| Provider | Takes a PDF file? | Sent by this app today? | Cost per page as a file |
|---|---|---|---|
| Anthropic | Yes. 32 MB, 100 pages per request (600 with a 1M-token context) | Yes (`document` block) | the page's text (1,500–3,000 tokens, their estimate) plus a picture of the page |
| OpenAI | Yes, on the chat API this app uses (`file` part, vision models, 50 MB) | No | text plus a picture of the page; no per-page number published (Stage 5 measured about what its text costs) |
| OpenRouter | Yes, any model (`file` part). For a model with no PDF support of its own, it parses the file first: a free text parser, or Mistral OCR at $2 per 1,000 pages, which is the default unless the request names the parser (Stage 5 asks for native reading only, and such a model refuses) | No | depends on the model |
| Gemini | Yes on its own API (50 MB or 1,000 pages). On the OpenAI-style endpoint this app tags through: unclear, needs a live check (Stage 5's: refused) | No | 258 tokens per page at the default resolution; the PDF's own text isn't charged (Stage 5 measured 532) |
| GLM | Not documented for its chat API | No | — |
| Self-hosted (Ollama, LM Studio…) | No | No | — |

For comparison, the converted text of a dense page (our 48-line test page,
5,076 characters) is about 1,300 tokens. So on Anthropic, and probably OpenAI,
converting costs roughly half or less of sending the file: the same text, minus
a picture of every page. On Gemini it's the other way round, and sending the
file costs about a fifth of the converted text.

### What converting gives, and what it loses

- **Gives:**
  - it works with every provider, self-hosted ones included;
  - the AI sees where links go. A résumé's portfolio link arrives as
    `[label](url)`; read from the file, the AI probably sees only the label;
  - it costs less on most providers;
  - long PDFs fit: the text is capped and marked, while a 100-page file goes
    over Anthropic's limit.
- **Loses:** pictures, charts, layout, and handwriting that OCR can't read.
  Tagging still gets the page-1 picture to judge the look.

## What changes

At the end of the arc:

1. **Four settings on the PDF card.** The Plugins page's PDF card has:
   - Max upload size, as now;
   - **Convert PDFs to text**, on by default, with a one-line reason;
   - **Scanned pages to read**, all of them by default;
   - **OCR language**, from the languages the extractor image has.

   Every file plugin's card shows its file types in a small gray tile and its
   settings under "PDF settings", "Audio settings" and so on (D12).
2. **A PDF is read once.** It's turned into text in the background, and the
   text is kept beside the file, like a Word file's.
   - Field extraction, tagging and retags read the kept text.
   - The extractor takes one PDF at a time, with boards taking turns.
   - A long scan is judged by its progress, not by a 4-minute clock.
   - The Jobs view shows each read and how many PDFs are waiting.
3. **Skipped pages are reported.** When scanned pages were left unread, the
   AI's text says so where they were, and so does the job's row.
4. **One text limit** for every document: the app's 150,000 characters, marked.
   The extractor's silent cut goes.
5. **No 100-page refusal** at upload.
6. **With conversion off**, providers that can read PDF files get the file:
   Anthropic from Stage 3, and OpenAI, OpenRouter and Gemini from Stage 5. The
   rest get the text, and the job's row says why.

## Decisions (settled 2026-10-05)

- **D1 — Where the settings live.** On the PDF plugin (Plugins page → PDF
  documents), app-wide, next to Max upload size. Not per board for now; that
  could follow the board's image-size setting later.
- **D2 — "Scanned pages to read": every page by default.**
  - A number. Left blank, it reads every scanned page, and the box says so
    ("All pages (default)"), the way Max upload size shows its default.
  - 0 turns OCR off.
  - Help line: "Pages that are only a picture are read with OCR, a few seconds
    each."
  - Pages read past what the AI's text limit holds (about 40 dense pages) cost
    extractor time and are kept, but the AI doesn't see them.
- **D3 — Say when pages were skipped.**
  - Where pages were skipped, the text the AI gets says so in place:
    "[Pages 21–40 are scanned and weren't read (OCR limit 20).]"
  - The job's row says it too.
- **D4 — One text limit.** The extractor stops cutting. The app's marked
  150,000 characters applies, as it already does for Word and text files. A
  long PDF sends up to 2.5× more text per call than today (about 37k tokens
  instead of 15k).
- **D5 — Read once, keep the text.**
  - It's saved beside the PDF and removed with it, the way a Word file's text is.
  - A stamp records how it was read.
  - Field extraction, tagging and retags read it.
  - It's read again only when the item is reprocessed and today's settings
    would read pages the last read skipped. Stage 2's close look narrowed this
    from "differ from the stamp's", which would have re-read every PDF read
    before the default changed, for the same text.
  - PDFs already in the app are read when they next need it (a retag), not all
    at once on deploy.
- **D6 — The extractor works like the transcriber.**
  - It accepts a job and answers at once. The worker checks on it and judges
    it by pages done, not by a clock.
  - Sending the same file again joins the job already running.
  - PDFs waiting for their text don't take a tagging slot.
  - One PDF at a time across the app, with boards taking turns.
- **D7 — The 100-page refusal goes.** With conversion on, nothing needs it.
  With conversion off, the provider's own limit decides (D9).
- **D8 — The switch: "Convert PDFs to text", on by default.**
  - The text has to tell the user that PDFs can be converted to text because
    it's cheaper, and that a PDF might not work with some providers:
    > The AI reads a text copy instead of the PDF file: usually cheaper, and
    > some AI providers can't read PDF files.
  - OK'd with Stage 3's close look. "Usually" because on Gemini, sending the
    PDF file costs less than the text (258 tokens a page), which matters once
    Stage 5 lets Gemini read files.
- **D9 — What "off" does.**
  - A provider that declares it can read PDF files gets the file, for field
    extraction as well as tagging. Field extraction reads only text today, on
    purpose; with conversion off it sends the file like tagging (Stage 3's
    close look). The file goes without the page-1 picture: it has every page.
  - A provider that can't, or a file over the provider's limits, gets the
    text copy, and the job's row says why.
  - A provider that refuses the file anyway (a dense PDF can fill the model's
    context before its page limit) gets the text copy in the same try, and
    the row gives the provider's reason. Nothing is remembered, so a later
    retag tries the file again; a refused call isn't billed.
  - The same rule covers a PDF with no readable text while conversion is on: it
    gets the file where the provider can read it, and otherwise the page-1
    picture and the file name, instead of failing as today.
  - The "use an Anthropic tagger" message stops naming a vendor.
- **D10 — More providers read PDF files.** OpenAI, OpenRouter and Gemini, as
  Stage 5. Each gets a live check with your keys, and I'll ask before using any.
- **D11 — An OCR language setting.** Stage 4. The extractor image bakes a set
  of languages, and the card offers what the image has.
  - The set (your call at Stage 4's close look): English and 27 more —
    French, German, Spanish, Italian, Portuguese, Dutch, Polish, Romanian,
    Czech, Swedish, Danish, Norwegian, Finnish, Hungarian, Turkish, Russian,
    Ukrainian, Greek, Arabic, Hebrew, Hindi, Japanese, Korean, Chinese
    (Simplified and Traditional), Vietnamese and Indonesian. A build setting
    bakes more or fewer.
  - One language at a time, English by default.
  - A language the image lacks (an image rebuilt with fewer) is read in
    English, and the read's row says so.
- **D12 — Every file plugin's card, laid out the same way** (your call at
  Stage 3's close look: "file types doesn't make sense as a big ass title,
  just to display the supported file types").
  - The file types sit in a gray tile titled "File types", the way the AI
    cards show their App defaults, with "built in, always on" beside them.
  - The settings sit under a title naming the type: "Image settings", "PDF
    settings", "Word document settings", "Text file settings", "Audio
    settings". Each type's manifest declares its title.

## Design

What each stage builds against. Names are working names; a stage's close look
may change one, and its entry says so.

### C1 — The extractor's job protocol

Mirrors the transcriber ([transcriber/main.py](../transcriber/main.py)), except
that the work runs in a separate worker process instead of a thread. Stage 1a's
close look measured why.

- **Submit.** `POST /jobs` with the PDF's bytes.
  - An optional `X-OCR-Pages` header sets the OCR limit: a number, 0 or more;
    absent means every page. Stage 4 adds `X-OCR-Lang`: one language code
    (`fra`, `chi_sim`), English when absent. A code the image doesn't have is
    read in English, and the report says so (`lang`, the language used, and
    `lang_missing`); refusing it would park every scanned PDF, and reading in
    it fails every scanned page (Stage 4's close look).
  - Answers `202 {job, status}` at once.
  - `400` for a bad header, or for a body cut short (the sender hung up
    mid-upload); `422` for an empty body; `503` when its queue is full.
- **Job ids.** A job's id is a hash of the bytes plus the settings.
  - Sending the same file with the same settings joins the job already queued
    or running.
  - A finished result is kept for an hour, up to about 64 MB of text in all.
    Past that the oldest finished results go first, but never the newest,
    which the app hasn't collected yet. The cap came with Stage 1b: without
    the 60,000 cut a 1,000-page report is about 5 MB of text, and a retag of a
    board of long PDFs would otherwise keep every one of them for the hour.
  - A failed job runs again when it's resubmitted.
- **Checking a job.** `GET /jobs/<id>` answers
  `{status: queued|running|done|failed, progress: {pages_done, pages_total}}`.
  - When done, it adds `markdown` and `report: {pages, text_pages, ocr_pages,
    skipped: [[from, to], …], ocr_failed: [[from, to], …], chars}`. `chars`
    counts the text it rendered, headings and links included, not the marker
    lines. Stage 4 adds `lang`, and `lang_missing` when it fell back.
  - When failed, it adds `error` and `permanent`. `permanent` is true for a file
    that isn't a readable PDF (PyMuPDF raises FileDataError at open: not a PDF,
    empty, or truncated) or that's password-protected (`needs_pass`).
- **Health.** `GET /health` answers `{ok, queued, running, langs}`. `langs`
  lists the OCR languages the image has, leaving out `osd` (Tesseract's
  page-orientation data). Stage 4 reads it.
- **Where the work runs.** The HTTP server only queues jobs and looks them up.
  - One worker process, started once, does the PyMuPDF work and reports each
    page as it finishes.
  - Why not a thread: PyMuPDF holds Python's lock for the whole of a page's
    OCR. Measured 2026-10-05, a thread ticking every 20 ms froze for 4.66 s
    during a 4.78 s page. In a thread, every poll and health check would hang
    for a page's length, and a page that never finished would hang the
    watchdog too.
  - In a separate process, the server's ticker never paused more than 0.02 s,
    and killing the process mid-page took 0.018 s.
- **Stuck pages.** If a page hasn't finished in `EXTRACTOR_PAGE_STALL_S` (300 s
  by default), the server kills the worker, starts a new one, and fails the job
  as not permanent ("stalled: page N of M …"), so the app retries up to its
  cap. A worker that crashes fails its job the same way.
- **The text is never cut.** Where pages were left unread, a line says so in
  place:
  - "[Pages 21–40 are scanned and weren't read (OCR limit 20).]", or "(OCR is
    off)" at 0;
  - "[Page 7 is scanned, but OCR couldn't read it.]" where Tesseract failed.
    Today those pages silently pass as text pages.
- **What counts as a scan.** A page with under 64 characters of text and a
  picture or a drawing on it. A blank page, or a heading on its own, isn't
  one: OCR would find nothing there, so it spends none of the OCR limit and
  gets no line. Stage 1's second pass narrowed this; before, such pages used
  up the limit and, past it, were called "scanned and weren't read".
- **Pages are read without their pictures.** Each page's text is kept until
  the job ends, and read the default way it carried the page's pictures too:
  264–608 KB for every scanned page OCR didn't read (measured 2026-10-05; an
  OCR'd page holds none). A limit of 20 on a 600-page scan held about
  150–350 MB. From Stage 2 the text is read without pictures, and the scan
  check asks `get_image_info`, which lists a page's pictures without their
  bytes. The text is the same.
- **`POST /extract` lasted through Stage 1a only.** Stage 1b deleted it, with
  `OCR_MAX_PAGES` and the 60,000 cut.
  - Through 1a it answered the old app its old way: synchronous,
    `200 {markdown}`, OCR capped at 20, cut at 60,000 characters, no marker
    lines, and "" for a PDF with no text.
  - Changing it would have broken that app, which read any successful answer
    without `markdown` as "this PDF has no text"
    ([worker.js:1702](../server/worker.js#L1702)).
- **No fallback for older images.** An extractor image older than the app
  answers `POST /jobs` with 404. Stage 1b reads that as "the extractor image is
  older than the app": the lane waits, and nothing fails.

### C2 — The reader (worker.js)

- **Same shape as the whisper engine**
  ([worker.js:1109-1255](../server/worker.js#L1109-L1255)).
  - It holds the `sidecar:extractor` slot for the whole read, and takes it
    before anything else (the job row, the file). The loop starts a read only
    while the slot is free, and a landing wakes the loop twice; taken any
    later, the second wake started another PDF, which sat "converting" with
    its file loaded (Stage 1's second pass).
  - It submits, then checks every 250 ms, backing off to every 30 s.
  - It judges the job by `pages_done`: no new page in 10 minutes **while the
    job is running** is a stall. Time spent queued doesn't count. The app
    sends one PDF at a time, so a queued job is waiting behind one the app
    lost track of when it restarted, and the extractor times that one itself,
    page by page. With every page read (Stage 2), a 600-page scan runs about
    50 minutes, and the PDF queued behind it would otherwise be parked after
    5 "stalls".
  - Each finished page is published on the job's running row.
  - There's no overall clock, so `EXTRACTOR_TIMEOUT_MS` goes.
  - The extractor's address is read on each call, not once when the worker
    loads, so a test can stand in for the extractor.
- **Failures follow transcription's rules, through the same code.** The policy
  ([worker.js:1266-1281](../server/worker.js#L1266-L1281)) and what
  transcription does with its answer
  ([worker.js:1421-1458](../server/worker.js#L1421-L1458): the retry count per
  item, one job row per run of repeats, parking under the lane's error key)
  become one function both lanes call.
  - The extractor down, or its queue full: the whole lane waits a minute, and
    nothing fails.
  - `POST /jobs` answers 404: the extractor image is older than the app. The
    lane waits the same way, and the job row says to update the image.
  - This PDF's job failed or stalled: this PDF waits and tries again, 5 tries
    at most, then it's parked with `pdf_text_error`.
  - A file the extractor can't open: parked at once.
  - An answer that can't be read (a reply cut off mid-way) is the
    extractor's blip, like no answer. A failure writing the kept text or the
    stamp after a good read is this app's disk or database, not the PDF: it
    tries again the same way (Stage 1's second pass).
- **A host with no extractor.** PDFs used to fail after 5 tries ("extractor
  unreachable"). Now they wait, the way audio waits on a host with no
  transcriber, and their job rows say why. From Stage 4 the app hears the
  extractor's health through the sidecar watch; the reads still just retry
  while it's down.

### C3 — What's kept

- **The text** goes in `<file>.md` beside the PDF in the gallery store. It's
  removed with the file, like a Word file's `.txt` and `.html`
  ([sources/index.js:60-61](../server/sources/index.js#L60-L61)). Backups walk
  the whole gallery folder, so it's backed up and restored with no change
  there.
  - It's written in place, not to a temp file renamed over it: a step reads it
    only once the stamp has landed, after the write. Stage 2, which brought
    re-reads, kept it that way: a step reads the text right after its claim,
    and once a reprocess drops the stamp the claim holds the PDF until the new
    stamp lands; a step claimed before the reprocess read the old text before
    the re-read began.
- **The stamp** goes on the item's payload: the extractor's report plus the
  settings it was read with, `pdf_text: {pages, text_pages, ocr_pages,
  skipped, ocr_failed, chars, ocr_limit, lang, at}`. A parked PDF gets
  `pdf_text_error: "<reason>"` instead. `lang` is the language the extractor
  used (from Stage 4; English before), with `lang_missing` when it fell back.
- **Order.** The text file is written first, then the stamp. If the item is
  gone by then, the text file is removed again.

### C4 — When a step waits for the text

- **A stored column** (migration 0059, like 0057's `awaiting_transcript`)
  marks an item whose first file is a PDF with neither `pdf_text` nor
  `pdf_text_error`. Stage 3 adds a second column for a PDF that a step asked
  text for (`pdf_text_wanted`, C8).
- **The claim** ([db.js:2857-2886](../server/db.js#L2857-L2886)) skips a PDF
  that's missing its text when the switch is on, or when a step asked for its
  text. The worker re-reads the switch on its maintenance pass, the way it
  re-reads `hasDefault` ([worker.js:3265](../server/worker.js#L3265)), and the
  steps go by the value the claim used.
- **Asking for the text** (Stage 3) marks the PDF `pdf_text_wanted` and puts
  it back in its step's queue with no retry wait: the claim holds it until
  the text lands. A wait through the usual path would add a minute after the
  read, since its 60-second retry outlives the read and a landing doesn't
  clear it (Stage 3's close look). The mark is never dropped: once asked, a
  PDF is read whenever it's missing its text, as with the switch on.
- **The read job** takes PDFs that are missing their text and waiting in a
  step's queue (tag or field extraction), when the switch is on or a step asked.
  - One at a time, with boards taking turns: it remembers the board it read
    last and starts its next search after it (by board id, wrapping round),
    taking that board's oldest PDF. It moves on when a read starts, not when
    the queue is listed, since a listing while the slot is busy launches
    nothing.
  - Why not the claim's ranking: it ranks each board's items by age, which
    shares a batch fairly, but taken one at a time it becomes first come,
    first served, as its own comment says
    ([db.js:2850-2856](../server/db.js#L2850-L2856)). Board A's 40 PDFs would
    all be read before board B's one.
  - Held, finished and failed items are read only once they're queued again,
    so nothing is read in bulk at deploy.
- **The waiting counts.** A PDF waiting for its text counts under "PDF to
  text", not under the step that will take it, the way audio counts under
  transcription ([db.js:3936](../server/db.js#L3936)). They follow the switch
  too (Stage 3's close look): with it off, an unread PDF that no step asked
  about is the step's, and counts there.
- **Landing a read**, or parking one, wakes the steps, the way a landed
  transcript does.
- **A parked PDF gets another go** when it's reprocessed or re-extracted. Both
  drop `pdf_text_error`, as they drop `transcript_error`
  ([db.js:944](../server/db.js#L944), [db.js:3740](../server/db.js#L3740)).
  Without that, a PDF parked during one bad hour stays parked for good.

### C5 — The steps read the kept text

- For a PDF, `documentTextFor` reads `<file>.md` and no longer calls the
  extractor. The app's marked 150,000-character cut applies
  ([worker.js:1669-1679](../server/worker.js#L1669-L1679)), as for Word and text
  files.
- **"No text" is the stamp's `chars` of 0**, not an empty file: the file can
  hold only the lines for unread pages ("[Pages 1–3 are scanned, but OCR
  couldn't read them.]"). A missing file reads as no text, as a Word file's
  missing text does.
- **A PDF with neither a stamp nor a parked error** can still reach a step: a
  button that drops the text commits inside the claim, between its read and
  its lock. The step waits for the read without spending an attempt, as audio
  does ([worker.js:1811-1817](../server/worker.js#L1811-L1817)).
- Field extraction used to call the extractor a second time for a textless PDF
  ([worker.js:2634-2653](../server/worker.js#L2634-L2653)). That's now a file
  read.

### C6 — The settings

- **Declaring the fields.** A media plugin can declare its own fields beside
  Max upload size (a `config` list on its manifest).
  - The PDF plugin declares `convert` (on/off, default on) and `ocrPages`
    (0 or more; blank = every page). `ocrPages` arrives in Stage 2, `convert`
    in Stage 3, drawn first: it decides whether the page setting matters.
  - On/off fields already draw and save: the shared field function draws a
    switch, and the server checks for true or false. A stored value that
    isn't false reads as on, the default.
  - Stage 4 adds `ocrLang`, a pick from a list ("OCR language", English by
    default). Its choices are what the extractor's `/health` lists, named
    ("French", not `fra`), which the app hears through the sidecar watch
    (sidecar-catalog.js). The watch only knew AI engines, so a file type can
    now declare a sidecar of its own, its address in its manifest; the
    worker reads the extractor's address there too, with `EXTRACTOR_URL`
    still the override (Stage 4's close look).
  - While the extractor isn't answering, the card shows the saved choice and
    says the languages aren't known. A saved choice the image no longer has
    shows as not available.
- **Server checks.** The server checks numbers and on/off values against what
  a plugin declares ([server.js:2805-2812](../server/server.js#L2805-L2812)).
  - Stage 2 adds a whole-number rule (`integer`), and a number field takes only
    a number or a numeric string. Before, its check was `Number(v)` with a
    minimum: 2.5 and 1e21 passed, and the extractor refuses both, which would
    park every PDF; a blank string became 0, which is "OCR off".
  - Stage 4 adds a pick-from-a-list type: a value must be one of the choices,
    and with the choices unknown (the extractor not answering) a save is
    refused, since nothing can check it. The Capabilities page already draws
    such a list (`fillSelect`); the card reuses it.
- **Drawing them.** The media card draws its declared fields with the field
  code the connector card uses, moved into one shared function
  ([plugin-modal.js:221-295](../public/plugin-modal.js#L221-L295)). The shared
  number field also shows a declared placeholder ("All pages (default)"; the
  AI cards declare "default N"). A number box steps by whole numbers anyway,
  so `integer` only matters to the server.
- **Using them.** Each read sends the current `ocrPages` (and later `ocrLang`),
  and the stamp records them.
  - "Every page" sends no `X-OCR-Pages` header at all, and stamps
    `ocr_limit: null`. Sent as a value it would read "null", which the
    extractor refuses.
  - The language goes as `X-OCR-Lang`, none for English. A stored value that
    isn't a language code (a hand-edited row) reads as English, as a stored
    page count that isn't a whole number reads as every page.
  - The read looks the setting up before its job row opens, outside the
    failure handling: a database blip there throws to the loop, which tries
    the PDF again next tick, instead of parking it.
- **Reprocess** drops a PDF's kept text when today's setting would read pages
  the last read skipped: every page, or more than it read. Nothing skipped,
  or a lower setting, keeps the text, since a re-read would give the same
  text or less. From Stage 4 it drops it too when the language changed and
  OCR read pages of it, or failed on some: a PDF read without OCR reads the
  same in any language. Both reprocess routes pass today's setting, the way they pass
  today's transcription engine
  ([db.js:3737-3740](../server/db.js#L3737-L3740)); without it, nothing is
  dropped. Retag and re-extract never drop it.
  - The trade-off: the old text goes when the re-read starts. A re-read that
    fails for good (a page that stalls every time) parks the PDF, which then
    goes as its picture and name, and the earlier text stays unused until the
    card's limit is lowered and the PDF reprocessed again. Rare; written down
    rather than built around.

### C7 — Which providers read PDF files

- **The declaration.** A provider declares it next to its image limits, as
  `documents: {maxBytes, maxPages}`. No declaration means it can't.
  `documentsFor(binding)` reads it, like `imagesFor` does
  ([worker.js:1744](../server/worker.js#L1744)).
  - The registry checks it when a provider loads, as it checks `images`, so
    a plugin's typo can't read as "no limit".
  - A step sends a PDF file only to a provider that declares it, so a wire
    meets a document part only if its descriptor says it takes one.
    PLUGIN.md's descriptor table and its parts list say so.
- **Stage 3:** Anthropic declares it; its document block exists today
  ([wires/anthropic.js:45](../server/ai-providers/wires/anthropic.js#L45)).
  - `maxPages: 100`. Anthropic's limit is per model: 600 pages on a model
    with a 1M-token context (Sonnet 5.5, Opus 5.5, Fable 5.1), 100 under that
    (Haiku 4.5, this app's default Claude model). A declaration holds one
    number, and past 100 pages the text costs less anyway.
  - `maxBytes: 20,000,000`. Anthropic takes 32 MB per request, the file's
    base64 included (a third bigger), with the prompt beside it.
  - Its docs warn that a dense PDF can fill the context before the page
    limit: 1,500–3,000 tokens of text a page plus a picture of it, so Haiku's
    200K holds roughly 40–60 dense pages (an estimate, not measured). That's
    what the fallback to text (D9) is for.
- **Stage 5:**
  - OpenAI and OpenRouter declare it, through a `file` part on the
    OpenAI-compatible wire.
  - OpenRouter's descriptor also names its parser, so a model without PDF
    support doesn't fall back to OpenRouter's paid OCR.
  - Gemini follows once a live check shows how its endpoint takes PDFs.
    (Stage 5's close look: it doesn't, so a PDF goes through Gemini's own
    API, and OpenRouter asks for native reading rather than naming a parser.)
- **The wires' refusal** stops naming a vendor ("<provider> can't read PDF
  files") and becomes a backstop, since the steps check the declaration first.
  It answers like a provider's own refusal (400), so it gets the same
  fallback to the text, where today it has no status and is retried 5 times.

### C8 — What the AI gets

One rule for both steps, checked top to bottom (Stage 3's close look; it was
a table, which missed a case: off, read with no text, a provider that can't
read files):

1. **The read was parked** (the extractor couldn't open it, or gave up): the
   page-1 picture and the file name. Never the file: it's usually one the
   extractor couldn't open (a password, a damaged file), and the AI can't
   open it either. The reason is on the read's job row, not in the AI's text.
2. **Conversion is off, the provider reads PDF files, and this one fits:**
   the file.
3. **There's kept text:** the text, plus the page-1 picture when tagging.
4. **Conversion is off and the PDF hasn't been read:** the step asks for the
   text (`pdf_text_wanted`, C4) and takes it once it lands. With conversion
   on, the claim never hands a step an unread PDF (C5's wait covers the
   race).
5. **Read, but no readable text:** the file, where the provider reads PDF
   files and this one fits; otherwise the page-1 picture and the file name.

- **"Fits"** means at most the provider's `maxBytes` and `maxPages` (C7).
  The page count is the read's, or the one taken at upload (`pdfinfo`); with
  neither, it doesn't fit.
- **A refused file** (the provider answers 400 or 413, and its wire didn't
  mark the answer a wait: an empty balance or a spend limit is the account's,
  not the file's) is sent again in the same try by the same rule, as though
  it didn't fit, the provider's reason in hand (D9). With no text yet, that's step 4: the next try sends the file
  again, is refused again, and then has the text.
- **Until Stage 3** there's no list of which providers read PDF files, so a PDF
  read with no readable text goes as it does today: the file, which only
  Anthropic reads. A parked one follows step 1 from Stage 1b.

Every tagging and field-extraction job row for a PDF records what was sent
and why, and the Jobs view says it when it isn't the text the switch on
sends: "as file", "as text: GLM can't read PDF files", "as text: 140 pages,
over Anthropic's 100", "as picture and name: no readable text; GLM can't read
PDF files".

### C9 — What the Jobs view shows

- **A job kind** for reading, `convert`, labelled "PDF to text"
  ([capabilities.js:321-333](../server/capabilities.js#L321-L333)).
- **Its row:** "converting page 12 of 40" beside the file while it runs (the
  page it's on, from the job's progress, the way a feed run shows "importing
  12 of 40"); "12 pages · 3 by OCR · pages 21–40 skipped (OCR limit 20)" when
  it's done.
- **A lane** for PDFs waiting to be read, counted beside transcription's
  ([db.js:3871-3874](../server/db.js#L3871-L3874),
  [worker.js:1552-1563](../server/worker.js#L1552-L1563)): "3 waiting — PDF to
  text", the Jobs view's own wording for a lane
  ([jobs-modal.js:586](../public/jobs-modal.js#L586)).

## What stays the same

- What converting produces (headings, links, reading order), OCR at 200 DPI,
  and the rule that a page under 64 characters is a scan. Stage 1's second
  pass narrowed the rule to pages with a picture or drawing on them (C1).
- The page-1 card face and its use in tagging
  ([ai-image-input-plan.md §6b](ai-image-input-plan.md)).
- The lightbox showing the PDF itself.
- Max upload size and its 500 MB server ceiling.
- Word, text and audio files.

## Stages

Each stage runs as close look → go ahead → another pass. Its entry here
records what the close look changed, every proof with its removal check, and
the real-app check.

### Stage 1a — The extractor as a job queue (C1)

- **Changes:**
  - extractor/main.py is rewritten around C1;
  - extractor/Dockerfile gets a health check on `/health`, like the
    transcriber's;
  - extractor/test_main.py is new;
  - ci.yml runs it inside the extractor image.
- **Close look (2026-10-05)** changed the stage. All measured in the extractor
  image (pymupdf 1.28.2, Python 3.12.15):
  - **A worker process, not a thread** (C1, "Where the work runs").
  - **New paths for the job API, and `/extract` left as it is** (C1). Pushing
    1a alone would otherwise break PDF tagging.
  - **Password-protected files are permanent failures.** PyMuPDF opens them
    (`needs_pass` = 1), and today's code then raises a plain ValueError, so the
    app gets a 500 and retries it 5 times. Files that aren't PDFs, empty files
    and truncated ones raise FileDataError at open. A PDF with only an owner
    password (printing or copying restrictions) reads fine.
  - **OCR failures are counted and marked**, where today they pass silently as
    text pages ([main.py:41-43](../extractor/main.py#L41-L43)).
  - **The Dockerfile changes:** a health check, since the extractor reports no
    health today. main.py imports `pymupdf` instead of `fitz`, which PyMuPDF
    1.28 says will be removed; the install isn't pinned.
  - **`osd` is left out of `langs`.** Today the image has `eng` and `osd`. OCR
    is MuPDF's built-in Tesseract reading language files from
    `TESSDATA_PREFIX`, so Stage 4's languages are data files.
  - **Where the tests live:** extractor/test_main.py, using Python's built-in
    unittest only. It runs inside the extractor image with the folder mounted
    over `/app`. A ci.yml job builds the image from the Images workflow's
    layer cache and runs it, since CI never ran anything inside an image
    before.
- **Proofs.** Each one gets a removal check, recorded here once it's run.
  - A submit answers at once, and polling shows pages climbing.
  - Health answers within a second while a page is being OCR'd.
  - A page past the stall window: the worker is killed, the job fails as not
    permanent, and the next job still runs.
  - The same file with the same settings joins its job, and a finished one is
    answered from cache. Different settings make a different job.
  - A failed job runs again when resubmitted.
  - A full queue answers 503; an empty body 422; a bad `X-OCR-Pages` 400.
  - A password-protected PDF and a non-PDF both fail as permanent.
  - A long text PDF comes back whole, with no 60,000 cut.
  - An OCR limit of 1 on a 3-page scan marks pages 2–3 in place, and 0 marks
    every scanned page "(OCR is off)".
  - An OCR failure is counted and marked.
  - `/health` lists `eng` and not `osd`.
  - `/extract` still answers today's way: the 60,000 cut, the OCR cap, no
    markers.
- **Real-app check** (rebuilding the local extractor container needs your OK):
  a PDF tagged through today's app, which still uses `/extract`, and
  `docker ps` showing the extractor healthy.
- **Built 2026-10-05, not pushed.**
  - **Files:** extractor/main.py (rewritten), extractor/Dockerfile (a health
    check), extractor/test_main.py (new, 14 tests), and ci.yml (an `extractor`
    job).
  - **Shape:** a threaded HTTP server owning the job store and queue; one
    `Extractor` loop feeding a single spawned worker process over a pipe
    (spawn, not fork, because the server runs threads). The worker sends a
    `ready` when it starts, each page as it finishes, and a beat every hundred
    pages while assembling. The page clock starts after `ready`, so the
    worker's start-up is never charged to page 1.
  - **Suite:** 14/14 in the extractor image (pymupdf 1.28.2), about 15 s.
  - **Removal checks: 20/20 fail.** Each check takes a proof's fix out of a
    scratch copy of main.py.
    - The submit waiting for the work: 1.62 s against the 1 s bound.
    - No page progress.
    - The work in the server's own thread: health took 2.58 s, which is the
      close look's measurement as a test.
    - No stall check: the job came back done.
    - No dedupe; the settings left out of the job id; failed jobs cached.
    - No queue cap; an empty body accepted; the header not checked.
    - The password not checked; open errors not permanent.
    - Jobs cut at 60,000; no unread-page lines, for the limit and for "OCR is
      off"; an OCR failure passed as text; `osd` listed.
    - `/extract` not cut, given marker lines, or not capped.
    - Two checks first failed on the wrong assertion: one when the job had
      already finished, one on a key a finished job doesn't have. Both tests
      now assert the claim first, and both were re-run.
  - **`/extract` matches HEAD byte for byte.** HEAD's main.py and the new code
    were run side by side on five PDFs: dense text, headings with bold and
    links, text and scans mixed under the OCR cap, scans only, and blank pages.
    All five answers were identical.
  - **The image itself:** built from the working copy and run as a container.
    Docker reports it healthy, `/health` lists `["eng"]`, `POST /extract`
    answers today's `{markdown}`, and `POST /jobs` answers 202, then done with
    its report.
  - **Not run:** `npm test`, since no app code changed. Still owed: CI's first
    run of the new job, on push.
  - **Real-app check: done 2026-10-05.**
    - Your local stack's extractor was rebuilt from the working copy and
      restarted, that service only (`docker compose build extractor && docker
      compose up -d extractor`; old image `6701f8789aed`). Docker reports it
      healthy with 0 restarts.
    - The trigger was a real three-page résumé (item 4773 on "resumes
      test"), queued for a retag through the app's own `retagItem`, the call
      the Retag button makes, run inside the app container. No session was
      minted and no browser was driven.
    - The app's worker sent the file to the new extractor through the old
      `/extract` route. The extractor logged one job: 93,843 bytes → 6,070
      characters, 3 pages, none by OCR, 0.2 s.
    - The app then tagged it with gpt-5.4-mini. The job-log row is `tag ok` in
      6.3 s, followed by `embed ok`.
    - One of its four tags changed on the re-tag (system_complexity:
      ecosystem-platform → multi-role-rbac).

### Stage 1b — Each PDF read once, in its own queue (C2–C5, C9)

- **Changes:**
  - worker.js: the reader, the read job, the landing, `documentTextFor` on the
    kept text, a parked PDF answered from its picture and name, transcription's
    failure handling shared, and `EXTRACTOR_TIMEOUT_MS` gone;
  - db.js: migration 0059, the claim's gate, the read job's query, the lane,
    the waiting counts, and reprocess and re-extract dropping
    `pdf_text_error`;
  - sources/index.js: the kept text removed with its file;
  - capabilities.js: the job kind;
  - jobs-modal.js: the row's wording;
  - extractor/main.py: `/extract`, `OCR_MAX_PAGES` and the 60,000 cut are
    deleted, now that nothing calls them, and finished results get a size cap
    (C1).
- **The reader's two readings of an answer:** a 404 on `POST /jobs` means the
  extractor image is older than the app, so the lane waits. `report.chars`
  of 0 means the PDF has no readable text (C8).
- **Settings stay fixed.** OCR limit 20 and English, exactly as today. Stage 2
  makes them settable.
- **Close look (2026-10-05)** changed the stage, all read from the code:
  - **Boards take turns through a cursor, not the claim's ranking** (C4).
    The ranking is first come, first served when the read job takes one PDF
    at a time, so proof 3 would have failed.
  - **Reprocess and re-extract drop `pdf_text_error`** (C4). The plan had no
    way back for a parked PDF.
  - **C8 is split for parked PDFs.** "Its steps go ahead without text (C8)"
    needed Stage 3's list of which providers read PDF files. A parked PDF
    now goes as its picture and name on every provider, never as the file. A
    PDF with no readable text goes as today until Stage 3.
  - **The extractor caps the results it keeps** (C1). Without the 60,000 cut,
    an hour of results from long PDFs could add up to gigabytes.
  - **Transcription's failure handling is shared, not copied** (C2). The plan
    named one function; the copy would have been the whole catch block.
  - **Smaller:** a step meeting a PDF with neither text nor error waits (C5);
    "no text" comes from the stamp (C5); the stall clock runs only while the
    job runs (C2); the running row shows its page (C9); the stamp keeps
    `ocr_failed` (C3); the tagging count leaves out PDFs waiting for text
    (C4); the extractor's address is read per call (C2); a host with no
    extractor now waits instead of failing (C2); the lane reads "3 waiting —
    PDF to text" (C9).
- **Proofs.** A stand-in extractor speaks C1, the way
  [audio-handoff-worker.test.js](../test/audio-handoff-worker.test.js) stands
  in for the transcriber.
  1. A PDF waiting to be tagged isn't claimed until its text lands, and is then
     tagged from it.
  2. Retag and field extraction use the kept text: the stand-in sees one submit
     per PDF, ever.
  3. One read at a time across the app, boards taking turns. Board A has PDFs
     queued and board B one, queued after them. B's is read second, not last:
     the 2026-10-04 measurement, as a test.
  4. While one PDF is read, the rest stay in the queue. None is claimed, so
     none holds its file in memory.
  5. A read that keeps finishing pages runs on past the stall window (the test
     shortens it), and so does one queued behind another job. One that stops
     finishing pages while running fails as a stall, and is parked once out of
     tries.
  6. With the extractor down, PDFs wait and the lane backs off; nothing fails.
     A 404 on `POST /jobs` waits the same way and says to update the image.
  7. A file the extractor can't open is parked, and its steps go ahead from its
     page-1 picture and name, never the file. A PDF read with no text still
     goes as the file, as today.
  8. The kept text is removed with its file. A read that lands after its item
     was deleted leaves no file behind.
  9. A long PDF's text reaches the AI cut at 150,000 characters with the
     marker, and a skipped-pages line reaches it in place. A kept file holding
     only those lines reads as no text.
  10. The Jobs view counts PDFs waiting to be read, under "PDF to text" and not
      under tagging, and a read's row says what it did; a running one, its page.
  11. Reprocess and re-extract drop a parked read's error, and the PDF is read
      again.
  12. A step that meets a PDF with neither text nor a parked error waits
      without spending an attempt.
  13. The extractor drops its oldest finished results past its cap, never the
      newest.
- **Real-app check** (local compose; rebuilding the app and extractor
  containers needs your OK): a text PDF and a scanned PDF on a real board.
  Each is read once (per the extractor's log), a retag doesn't read again, and
  the Jobs view shows the rows.
- **Built 2026-10-05, not pushed.**
  - **Files:**
    - extractor/main.py: `/extract`, its 20-page cap and 60,000 cut, and the
      wait that served it are deleted; finished results are capped at about
      64 MB of text, oldest first, never the newest.
    - extractor/test_main.py: the `/extract` test is gone and a cap test is
      added (14 tests).
    - server/migrations/0059_awaiting_pdf_text.sql: the stored column.
    - server/db.js: one "waiting for its text" test for the claim and the
      steps' counts (audio or PDF); the read job's query with its board
      cursor (`pdfsNeedingText`); the landing (`landPdfText`); the `convert`
      lane; reprocess and re-extract dropping `pdf_text_error`.
    - server/worker.js: the reader (`readPdfText`), one read end to end
      (`convertOne`), transcription's failure handling as one function both
      lanes call (`laneFailed`; the policy renamed `laneFailurePolicy`), the
      steps on the kept text, a parked PDF's picture-and-name parts, the
      `convert` kind and its lane. `EXTRACTOR_URL` is read per call;
      `EXTRACTOR_TIMEOUT_MS` is gone.
    - server/sources/index.js: `<file>.md` goes with its file.
    - server/capabilities.js: the `convert` kind, "PDF to text".
    - public/jobs-modal.js: the done row's wording and the running row's page.
    - Tests: test/pdf-text.test.js (new, 13) and test/pdf-text-worker.test.js
      (new, 3, a live worker); docs, model-input (4 new), jobs-row (2 new)
      and audio (the rename) updated.
  - **Decided while building:**
    - The reader is written in the transcriber's shape rather than sharing
      its loop. The two differ in what counts as progress and in whether time
      queued counts, so a shared loop would have needed hooks to keep
      transcription as it is. The failure handling is shared, as the close
      look said.
    - A temp file renamed over the kept text, and a check that the item still
      holds the same file when the stamp lands, were both written and then
      dropped. In 1b a step reads the text only after the stamp lands, and a
      PDF item's file never changes, so neither could be tested. Stage 2's
      re-reads decide whether the rename is needed (C3).
    - The live test hands its retag round to a worker at the usual poll. A
      button doesn't wake the worker (its poll picks the work up), and the
      test's minute-long poll is what proves a landing wakes the steps.
    - Board ids are random, so both turn-taking tests let Postgres say which
      board sorts first and give that one the older PDFs. Each test then
      checks the exact order, and the cursor's removal check can't pass by
      luck.
    - `LANE_MAX_ATTEMPTS` replaces `TRANSCRIBE_MAX_ATTEMPTS` as the
      environment name; the old one was never documented or set in a compose
      file.
    - **Not changed:** the transcriber's reader still counts time queued as a
      stall, so it has the same restart case as C2 describes. Recorded here,
      not fixed.
  - **Suite:** `npm test`, 2,404 tests: 2,403 pass, none fail, 1 skipped (the
    Linux-only poppler test), on the final code.
  - **Extractor:** 14/14 in the image. **Removal checks: 19/19 fail** —
    1a's seventeen, carried over to the code without `/extract`, and the
    cap's two (no cap; the cap dropping the newest too).
  - **App removal checks: 26/26 fail.** Each takes a proof's fix out of the
    working copy, runs its tests, and puts the file back:
    - the claim's gate; the landing's wake; the steps reading the kept text
      (the stand-in saw repeat submits); the board order; the cursor moved
      when the queue is listed (B came third); one read at a time;
    - time queued counted as a stall; no stall check; progress not published;
      a 404 parked; no fold (transcription's own fold test failed too, since
      the handling is shared); unreadable files not permanent;
    - a parked PDF sent as the file; the text left behind after a delete;
      cleanup keeping the text; the file deciding "no text";
    - no lane; held PDFs counted and read; PDFs counted under tagging; the
      lane not served; no label; the two rows' wording;
    - reprocess, and re-extract, keeping a parked error; the claim's race read
      as "no text".
    - Three first came out wrong and were redone. Two of my patches were
      faulty: an `await` in a function that wasn't `async`, so the worker
      didn't load at all, and a search that matched twice, so it never ran.
      The third, one read at a time, passed with its fix removed. The reader
      also waits for the extractor's one slot, so the stand-in still saw one
      read at a time; what the fix prevents is the next PDFs being started
      anyway, each loading its file and showing as converting while it only
      waits. The live test now checks that only one read is running, and it
      fails without the fix.
  - **Real-app check: done 2026-10-05.**
    - Your local app and extractor were rebuilt from the working copy and
      restarted. Both report healthy with 0 restarts. The app applied
      migration 0059 at boot.
    - **Nothing was read at deploy.** All 31 PDFs on your boards were marked
      as waiting for text, none was queued for a step, and the extractor
      logged no job.
    - **Text PDF:** the same résumé (item 4773, "resumes test"), queued
      for a retag through the app's own `retagItem` inside the app container.
      No session was minted and no browser was driven.
      - The extractor logged one job: 3 pages, 0.2 s.
      - The app logged `converted` (5,966 characters) and the stamp landed.
        `<file>.md` was written (6,173 bytes), and the item was tagged from it
        with gpt-5.4-mini.
      - A second retag tagged it again (4.5 s) with no new extractor job.
    - **Scanned PDF:** none of your 31 PDFs is a scan, so a scanned copy of
      the résumé was made: its 3 pages rendered to 150 dpi grayscale
      pictures, with no text layer. It was added to "resumes test" through
      the upload path's own `storeFile` and `admitStored` (item 9856).
      - Before its read it counted as "1 waiting" under PDF to text. While it
        ran, its job row showed its progress (page 1 of 3, then done).
      - The extractor read all 3 pages by OCR in 6.4 s.
      - Field extraction then took the person's name from the OCR'd text, and
        the item joined the existing card (the board derives cards from the
        name), so that card now holds both files. It was then tagged.
      - A retag tagged it again with no new extractor job.
    - **Not checked:** the Jobs view in a browser, since that needs a login
      session. What the view reads was checked instead: the job rows, the
      lane count and the running row's progress.
- **Second pass on Stage 1 (2026-10-05).** Three read-only reviewers, one
  per area (the extractor; the server's read path; everything else that
  reads what changed), compared the code with HEAD and never saw this plan.
  I checked the plan's claims, the tests' setups and the packaging myself.
  - **Fixed, each with a test that fails without the fix:**
    - **One read at a time broke after every landing.** The slot was taken
      in the reader, after the job row and the file. A landing wakes the
      loop twice, and the second tick found the slot still free and started
      another PDF, which sat "converting" with its file loaded. Measured: 2
      converting right after the first read landed. The read job now takes
      the slot first (C2), and the live test samples the running rows after
      each landing.
    - **A disk or database failure after a good read parked the PDF**, and
      so did an answer cut off mid-way. None of them carried a status, so
      the policy called them the PDF's fault. Now a cut-off answer is the
      extractor's blip, and a failed write retries the PDF, spending an
      attempt so that a failure that lasts still parks (C2).
    - **Blank pages and headings on their own were called scans.** A blank
      page used up the OCR limit, and past it got "[Page N is scanned and
      wasn't read]". A short page now counts as a scan only with a picture
      or drawing on it (C1, "What stays the same").
    - **An upload cut off mid-way became a job** nobody would collect. It's
      refused with 400 (C1).
    - **"page 101 of 100"** in a stall or crash after the last page. It now
      names the last page, as the running row does.
  - **Tests that couldn't fail, fixed:**
    - model-input's check that a long PDF's text is cut "with the marker":
      the template string dropped its backslashes, so the pattern matched
      any text;
    - the extractor's join test: a job's id is a hash, so equal ids proved
      nothing. It now checks that the second submit got the same job;
    - the cap test: every result alone was over the cap, so it couldn't
      tell oldest-first from any other order. It now leaves room for two;
    - the stall test now checks the next job got its own text.
  - **Simplified:** the shared failure handler takes the file name from the
    item instead of a parameter; `documentTextFor` tests the stamp by its
    key, as the column does. Out-of-date comments fixed in worker.js, db.js,
    jobs-modal.js, resource-loop.js, resource-pool.js and test/helpers.js.
    The Abort confirm now names a running PDF read beside a running
    transcription as work it doesn't stop.
  - **Removal checks: extractor 7/7 fail, app 6/6 fail.**
    - Extractor: a twin queued a second time; the cap dropping the newer of
      the older results first; the cap sparing nothing; a stalled worker
      kept for the next job; short pages read as scans; a cut-off upload
      queued; the count running past the last page.
    - App: the slot taken after the row and the file; a poll's answer, and
      the submit's, read outside their error handling; a failed text write,
      and a failed stamp write, parking; a PDF's text not cut.
    - Two first passed with their fix removed: the stand-in dropped its
      connection before the answer left, so the new path never ran. It now
      sends an answer that stops mid-way, and both fail.
    - The new live check first hung instead of failing: a failed assertion
      left a read held, and the next test waited forever for the worker to
      stop. Every read is now let go before any stop.
  - **Recorded, not fixed:**
    - A stamped PDF whose `.md` is gone goes as the whole file, today's
      no-text fallback. It takes the gallery and the database out of step (a
      file deleted by hand, a partial restore); healing it would need a hook
      in the steps' failure handling.
    - Reads don't check that the board has an AI key, unlike the claim. A
      PDF on a board without one is read, and its text waits for a key; a
      check would leave it counted as waiting for a read that never comes.
    - One damaged page fails the whole PDF, as before Stage 1. The unread-page
      lines would let the extractor mark that page instead; that's new
      behaviour.
    - The extractor's last-resort catch settles a job without restarting the
      worker. Nothing in the job's code can raise there today.
    - Transcription has the same late slot and the same cut-off-answer park,
      in the whisper engine's loop. Not this stage's code.
    - Abort, and a restore after its 30-second wait, leave a running read
      alone, and its result lands, as a transcript's does.
    - `TRANSCRIBE_MAX_ATTEMPTS` is now ignored (renamed `LANE_MAX_ATTEMPTS`):
      a deployment that set it sets the new name.
  - **Suites:** `npm test` 2,406 tests: 2,405 pass, none fail, 1 skipped
    (the Linux-only poppler test). Extractor 18/18 in its image.
  - **Not redone:** the real-app check. The fixes change the app and the
    extractor, so a rebuild of both would be needed to see them there.

### Stage 2 — The page setting (C6, D2, D7)

- **Changes:**
  - sources/pdf.js and plugins.js: the PDF manifest declares `ocrPages`, and
    media plugins' declared fields join Max upload size; `PDF_MAX_PAGES` and
    the refusal go; the description says what the plugin does ("Reads PDFs as
    text for the AI, with OCR for scanned pages, and draws the page-1
    preview");
  - server.js: the whole-number rule, and a number field takes only a number;
    both reprocess routes pass today's setting;
  - plugin-modal.js: the shared field function (placeholder, whole-number
    steps), and the PDF card's field;
  - worker.js: each read looks up the setting before its job row, sends it
    (no header for every page) and stamps it; the fixed 20 goes;
  - db.js: reprocess's re-read rule;
  - extractor/main.py: pages are read without their pictures (C1);
  - comments that name the page cap (ingest.js, ingestion/files.js).
- **Close look (2026-10-05)** changed the stage. Read from the code, with one
  measurement in the extractor image:
  - **The number check let bad page counts through** (C6). 2.5 and 1e21 passed
    and would park every PDF; a blank string became "OCR off".
  - **Every page sends no header** (C6). Sent as a value it reads "null", and
    every PDF would park. Found in Stage 1's second pass.
  - **The setting is read outside the failure handling** (C6), or a database
    blip while reading it would park the PDF.
  - **The re-read rule re-reads only for more pages** (C6, D5). "Settings
    differ" would have re-read every PDF read so far once the default changed
    from 20 to every page, for the same text.
  - **Pages are read without their pictures** (C1), measured: 264–608 KB held
    per scanned page OCR didn't read.
  - **The 150-page proof needs a stand-in page count.** The refusal works from
    poppler's page count, and Windows has no poppler here, so it never fired
    on this machine. The stand-in `pdfinfo` is a shell script, so that proof
    runs on Linux only (CI, and a container for its removal check), like the
    poppler hang test.
  - **The connector card's fields had no test.** The proof that they still save
    is written first and run against the code before the move.
  - **docker-compose.yml is left alone.** It holds your own uncommitted edits,
    and its comment fix is cosmetic.
  - **One gap until Stage 3, accepted.** Without the refusal, a PDF over 100
    pages with no readable text is sent whole to Anthropic. Its default model
    (200K context) refuses more than 100 pages, so tagging fails with
    Anthropic's message; Sonnet and Opus (1M context) take up to 600 and bill
    every page, as a textless PDF under 100 pages already is billed. It takes
    OCR off, or OCR failing on every page; every other provider already fails
    a textless PDF. Stage 3's page limits and switch decide it. (Corrected in
    Stage 2's second pass: the note first said Anthropic refuses them all.)
  - **No change for feeds.** A feed that refused a long PDF keeps it skipped;
    the feed modal's Retry is the way back, as it is for any file a handler
    used to refuse.
- **Proofs.** Each one gets a removal check, recorded here once it's run.
  1. The PDF card shows "Scanned pages to read" with "All pages (default)";
     typing 3 saves 3, and clearing it saves the default.
  2. The connector card's fields still save as before the move.
  3. The server accepts 0 and 40, and the default (null); it refuses −1, "x",
     2.5, 1e21 and a blank string.
  4. A read sends the card's setting and stamps it; every page sends no header
     and stamps null. The live worker reads the card's setting.
  5. A database blip while reading the setting doesn't park the PDF.
  6. Reprocess reads a PDF again when today's setting would read pages it
     skipped, and keeps it when nothing was skipped, when the setting is lower,
     or when the setting isn't known; the card and board routes pass it.
  7. A 150-page PDF uploads (Linux).
  8. A scanned page OCR didn't read holds no picture, and scans are still
     found.
- **Real-app check:** set the limit to 3 on the PDF card and read a 6-page
  scan; its job row says pages 4–6 were skipped.
- **Built 2026-10-05, not pushed.**
  - **Files:**
    - server/sources/pdf.js: the manifest declares `ocrPages` and says what the
      plugin does; `PDF_MAX_PAGES` and the refusal are gone.
    - server/plugins.js: media plugins' declared fields join Max upload size;
      `pdfReadSettings`, the one place that reads the PDF card's setting.
    - server/server.js: the whole-number rule, and a number field takes only a
      number; both reprocess routes pass today's setting.
    - server/db.js: reprocess's re-read rule.
    - server/worker.js: the read looks the setting up before its job row,
      sends it (no header for every page) and stamps it; the fixed 20 is gone.
    - public/plugin-modal.js: `configField`, the one field function, draws the
      connector card's fields, the AI cards' rate fields and the PDF card's
      page setting; the autosave fix below.
    - extractor/main.py: pages read without their pictures; scans found by
      `get_image_info`.
    - Comments that named the page cap: ingest.js, ingestion/files.js.
    - Tests: test/browser/plugin-fields.test.js (new, 4); plugins.test.js (1
      new); pdf-text.test.js (4 new, 1 changed); pdf-text-worker.test.js (the
      card's setting reaches the read); docs.test.js (1 new, Linux only);
      extractor test_main.py (1 new).
  - **Decided while building:**
    - The AI cards' rate fields draw through the shared function too: they
      were a third copy of the same number field. (Built with a "default N"
      placeholder on every number box; the second pass took it off connector
      cards, where it was untrue.)
    - The setting is looked up in `convertOne`, before its job row, rather
      than in the read job's `run`: that's what the tests drive, and it's
      still outside the failure handling.
    - Reprocess gets today's setting as `{"ocr_pages": …}`, so "every page"
      (null) stays apart from "not known" (no value), which never re-reads.
    - Reading without pictures was checked on the 32 PDFs in your local
      gallery, OCR off: every one reads exactly as before.
  - **Found while building: the Plugins page's autosave lost a value typed
    while the last one was saving.** Each save marked as saved whatever was
    in the box when the server answered, so a second value typed meanwhile
    (3, then 0) was marked saved and never sent: the box said 0, the server
    kept 3. The full suite's load first showed it, failing the new PDF card
    test once; it passed alone. A save now marks the value it sent. A new
    browser test holds the first save's answer, so it fails every time
    without the fix.
  - **Proof 2's guards first:** the connector and AI card tests were written
    before the move and passed against the code before it; the PDF card's
    test failed there, as it should.
  - **Suites:** `npm test` 2,416 tests: 2,414 pass, none fail, 2 skipped (the
    two Linux-only poppler tests; the 150-page one passes in the app image).
  - **Extractor:** 19/19 in the image.
  - **Removal checks: 20/20 fail.**
    - App, 17: the whole-number rule; a blank string read as 0; the PDF's
      fields not declared; every page sending "null"; the card's setting not
      sent; the setting read inside the failure handling; the re-read rule's
      four parts (settings that merely differ, a lower setting, nothing
      skipped, an unknown setting); each reprocess route not passing the
      setting; the shared field's placeholder, its whole-number step and its
      save; the PDF card drawing no fields of its own; the autosave marking
      the box's value instead of the one it sent.
    - Linux, 1: the refusal put back, run in the app image: the 150-page
      upload fails with "PDF too long (max 100 pages)".
    - Extractor, 2: pages read with their pictures; scans looked for in the
      picture blocks the text no longer has.
  - **Not changed:** docker-compose.yml (your own edits are in it).
  - **Real-app check: done 2026-10-05.**
    - Your local app and extractor were rebuilt with Stage 2 (by you). Both
      report healthy with 0 restarts.
    - The PDF card's page setting was set to 3 from inside the app container,
      merged into its stored config the way the card saves it (your 20 MB
      upload size kept), and cleared again afterwards.
    - A synthetic 6-page scan (made-up text as pictures, no text layer) was
      added to "transcriber test" through the upload path's `storeFile` and
      `admitStored` (item 9857). Before its read it counted as 1 waiting under
      PDF to text.
    - Its read: the running row showed its page (1 of 6); done in 7.8 s with 6
      pages, 3 by OCR, pages 4–6 skipped, OCR limit 3, which the row reads as
      "6 pages · 3 by OCR · pages 4–6 skipped (OCR limit 3)". The kept text
      holds "[Pages 4–6 are scanned and weren't read (OCR limit 3).]" where
      those pages were. The extractor logged 6 pages, 3 by OCR, in 5.6 s. The
      item was then tagged.
    - A synthetic 150-page PDF went through the upload path's `storeFile`:
      pdfinfo counted 150 pages, the preview was drawn, nothing refused it.
      What it stored was removed again.
    - Item 9857 stays on "transcriber test", as item 9856 does on "resumes
      test", until you say.
- **Second pass on Stage 2 (2026-10-05).** Three read-only reviewers (the
  server side; the Plugins page; everything else that reads what changed),
  never shown this plan. I checked the plan's claims, the tests' setups and
  the packaging myself.
  - **Fixed, each with a test that fails without the fix:**
    - **A big page count broke every reprocess.** The card takes any whole
      number JavaScript holds exactly, but the re-read rule compared it as a
      4-byte integer. Postgres works that cast out once per statement, so
      with the card at 3,000,000,000 reprocessing even an image card answered
      500 (measured). It compares as `numeric` now. Found by all three
      reviewers and by me.
    - **The Plugins page's autosave still lost two sequences.** A value set
      back to the saved one while a save was on its way was dropped (an early
      check compared it with a `saved` the save hadn't updated yet), and a
      save the server refused put the box back over a value typed after it,
      which was then never sent.
    - **Text a number box can't read** ("e", a lone "-") reads as blank, and
      Chrome fires the change, so it saved the default: on the PDF card,
      every page. It's refused now and the box goes back. The reviewer
      couldn't settle whether Chrome fires the change; the test showed it
      does.
    - **Connector cards claimed a default they don't use.** The shared field
      put "default N" on every number box; CoinGecko's says 100 while 10
      applies without a key. Placeholders now come only from the field's
      declaration, and the AI cards declare theirs, as before.
    - **A hand-edited page setting that isn't a whole number** would have been
      sent to the extractor, which refuses it — every PDF parked. It now
      reads as every page, the way a bad upload size reads as the default.
  - **Tests that couldn't fail, fixed:** the reprocess routes test (a route
    passing "every page" instead of the card's value passed it; now the card
    at 2 keeps a read and at 3 re-reads it); the re-read cases (no "nothing
    skipped, higher number" case, so a rule that re-read every text PDF
    passed them all); the AI card's "no rebuild" check (it ran before a
    rebuild could happen; it now runs at the end); a stray fixture (a 12-page
    PDF with pages 21–40 skipped). New: the moved key field (save, then the
    confirmed remove) had no test; a scan drawn inside another object.
  - **Simplified:** the OCR call no longer passes the no-pictures flags, which
    its default flags never held anyway (and which would have newly clipped
    OCR text to the page box); `step="1"` is gone, since a number box steps
    by 1 already; the rule's "pages were skipped" test is a plain comparison.
    Out-of-date comments fixed in plugin-modal.js, sources/pdf.js,
    sources/docx.js, sources/index.js and worker.js.
  - **Removal checks: app 11/11 fail; extractor 1 of 2.**
    - App: the 4-byte cast; a higher number re-reading what skipped nothing;
      the routes passing every page; a stored setting used as it is; the
      early unchanged-check; the revert over a newer value; unreadable text
      saved as the default; connector boxes claiming a default; the AI box
      declaring none; a number box that rebuilds the card; a key field that
      doesn't save.
    - One first passed with its fix removed: the "no rebuild" check, which
      ran before the rebuild. Moved to the end, it fails.
    - Extractor: the nested-scan test fails with no scan check at all, but
      not with `get_images()` in place of `get_image_info()` — the older call
      finds nested pictures too. It guards that wrapped scans are found; it
      doesn't single out the newer call.
  - **Decided, not built:**
    - A re-read that fails for good loses the earlier text until the card is
      lowered and the PDF reprocessed (C6, written down).
    - The kept text stays written in place (C3, answered).
    - Two of a card's fields saved at the same instant can overwrite each
      other: the server reads the plugin's config and writes it back whole.
      It takes two saves within a few milliseconds; the PDF card is the first
      media card with two fields.
    - The Stage 3 gap note was wrong and is corrected: Sonnet and Opus take a
      textless PDF of up to 600 pages and bill every page.
    - The PDF card's section is titled "File types" and now holds the page
      setting. Whether the setting gets its own section is your call.
    - Source connections keep their own, looser number check and call their
      placeholder `help`; untouched.
  - **Suites:** `npm test` 2,421 tests: 2,419 pass, none fail, 2 skipped (the
    Linux-only poppler tests). Extractor 20/20 in its image.
  - **Not redone:** the real-app check. The fixes are to reprocess, the
    Plugins page and a guard, and the OCR call is back to its pre-Stage 2
    form; your running containers have the code from before this pass.

### Stage 3 — The switch (C7, C8, D8, D9, D12)

- **Changes:**
  - sources/*.js: `convert` on the PDF card, with D8's text; each file type
    declares its settings title (D12);
  - plugins.js: `pdfReadSettings` reads the switch too;
  - plugin-modal.js: every file plugin's card as D12 lays it out;
  - ai-providers/anthropic.js: Anthropic declares `documents` (C7);
  - providers.js: the registry checks `documents`;
  - worker.js: the steps follow C8's rule, with the fallback to text; the
    worker holds the switch, read on its maintenance pass; the Jobs view's
    lanes carry it;
  - db.js and migration 0060: `pdf_text_wanted` and its column; the claim,
    the read queue and the counts follow the switch; asking puts a PDF back
    with no retry wait;
  - server.js: the counts get the switch;
  - jobs-modal.js: the rows say what was sent and why;
  - wires/tool.js: the refusal stops naming a vendor and answers 400;
  - PLUGIN.md and the DeepSeek and Ollama example READMEs (below).
- **Close look (2026-10-05)** changed the stage, read from the code and
  Anthropic's docs; nothing measured:
  - **Anthropic's page limit is per model, and a long PDF can overflow the
    context first** (C7). Anthropic declares 100 pages, and a refused file
    falls back to the text (D9, your call).
  - **Asking for the text through the usual wait would add a minute** after
    the read lands: its 60-second retry outlives the read (C4).
  - **The counts follow the switch** (C4). The plan changed only the claim
    and the read queue; with the switch off, every unread PDF would have
    shown as waiting under "PDF to text" while it was tagged as a file.
  - **The registry checks the new declaration, and PLUGIN.md documents it**
    (C7). The wires' refusal answers 400, where today it has no status and
    is retried 5 times.
  - **C8's table became one rule**: it missed off, read with no text, a
    provider that can't read files.
  - **Field extraction follows the switch** (D9, your call), and the file
    goes without the page-1 picture.
  - **Already there:** on/off fields draw and save, so the switch is a
    declaration and its wording. The second column is needed: with the
    switch off, the claim would otherwise read every unread PDF's payload on
    every tick, the cost 0057 measured.
  - **Your calls, 2026-10-05:** the fallback, field extraction following the
    switch, D8's text with "usually", and D12: every file plugin's card
    redone, not only the PDF's ("we need to update that for all file
    plugins").
- **Proofs.** Each one gets a removal check, recorded here once it's run.
  1. Switch on: every board gets the text, as today, and no read is asked.
  2. Switch off: a PDF on a board whose provider reads PDF files is tagged
     and its fields extracted from the file, with no read; its rows say "as
     file".
  3. Switch off: a provider without the declaration asks for a read, the PDF
     waits with no retry, is read, and is tagged from the text; its row says
     why.
  4. Switch off: unread PDFs are claimed, the read queue skips them unless a
     step asked, and the Jobs view counts them under their step.
  5. A file over the provider's page or size limit, or with no page count,
     goes as the text, and the row says why.
  6. A refused file: the same try sends the text, and the row gives the
     provider's reason; with no text yet, the step asks for it.
  7. A textless PDF goes as the file where the provider reads PDF files and
     it fits; otherwise as the page-1 picture and the name, instead of
     failing. A parked PDF never goes as the file.
  8. The registry refuses a bad `documents` declaration.
  9. The wires' refusal names no vendor and answers 400.
  10. The PDF card draws its file types in a tile, "PDF settings", the
      switch on by default, saving off and on again; the audio card draws
      "Audio settings" with Max upload size alone.
  11. The Jobs view words each row: "as file", "as text: <why>", "as picture
      and name: <why>", and nothing for the text the switch on sends.
- **Real-app check:** with the switch off, retag a PDF on a board tagging
  with Anthropic and one tagging with OpenAI. The rows say "as file" and "as
  text: OpenAI can't read PDF files" (until Stage 5). It spends a few cents
  on your Anthropic and OpenAI keys, so it waits for your OK.
- **Built 2026-10-05, not pushed.**
  - **Files:**
    - server/sources/*.js: each file type's `settingsTitle`; the PDF's
      `convert` switch, drawn before the page setting.
    - server/plugins.js: `settingsTitle` reaches the card; `pdfReadSettings`
      reads the switch (only a stored false is off).
    - public/plugin-modal.js: `fileTypesTile`, and the settings section
      under the type's title, for every file plugin.
    - server/ai-providers/anthropic.js: `documents: { maxBytes: 20e6,
      maxPages: 100 }`.
    - server/providers.js: `requireValidDocuments` at the registry write.
    - server/worker.js: `pdfRoute` (C8's rule), `pdfMisfit` ("fits"),
      `refusedFile`, `documentsFor`; the PDF branch of `modelInputFor` and
      `modelInputForExtract` follow the rule; tagging and field extraction
      rebuild their parts once on a refused file; both legs answer an ask
      with `askPdfText`; the worker's `convertOn`, its first reading
      awaited by the first claim and read (below); the PDF-reading lane
      carries the switch as `all`.
    - server/db.js: `awaitingTextSql(p)` and `needsPdfReadSql(p)` take the
      switch; the claim, `pipelineWork` and `pdfsNeedingText` pass it;
      `askPdfText`.
    - server/migrations/0060_pdf_text_wanted.sql: the generated column.
    - server/server.js: the steps' counts get the lane's switch.
    - server/ai-providers/wires/tool.js: "<provider> can't read PDF files",
      as a 400.
    - public/jobs-modal.js: `pdfNote` on the tagging and extraction rows.
    - PLUGIN.md, examples/plugins/deepseek/README.md,
      examples/plugins/ollama/README.md.
    - Tests: test/pdf-switch-worker.test.js (new, 3, a live worker);
      model-input (6 new, 1 rewritten); pdf-text (2 new); pdf-text-worker
      (the switch on asks for nothing); plugins (1 new); jobs-row (1 new);
      keyless-providers (1 new); compat (1 new); browser/plugin-fields (1
      new).
  - **Decided while building:**
    - The file types sit in the AI cards' App defaults tile (`tileRow`,
      locked), so no new CSS. The lightbox's gray card with a small title
      (`.panel-cell`) was the other candidate, but it lives in the board
      page's stylesheet, which the admin page doesn't load. "Built in,
      always on" is the Plugins page's own wording for its built-ins.
    - `documents: null` reads as "none", the way `embeds: null` does.
    - The fallback answers only a 400 or a 413. A clipped answer (422) was
      billed, and a key, model, rate or outage error isn't about the file.
    - The file goes with the PDF's name in its sentence ("The item is the PDF
      document above (…)"); the old textless fallback sent the ask alone.
      Field extraction's text for a PDF is word for word as before.
    - `modelInputForExtract` throws the wait and the ask itself, as its
      comment already promised for the wait.
  - **Found while building: the switch was guessed at boot.** Until the
    worker's first maintenance pass read it, it held the default, on, so the
    read job could start on a PDF no step had asked about (the new live test
    caught it on its first run). The first claim and the first read now wait
    for its first reading; a failed reading leaves the default until the
    pass reads it again.
  - **Suites:** `npm test` 2,436 tests: 2,434 pass, none fail, 2 skipped
    (the Linux-only poppler tests). No extractor code changed.
  - **Removal checks: 34/34 fail**, each on the test written for it. Each
    takes one fix out of the working copy, runs that fix's tests, and puts
    the file back (checked byte for byte afterwards).
    - Proof 1: the switch ignored when the provider reads files.
    - Proof 2: the claim, the read queue, or field extraction ignoring the
      switch; the tag row, or the extract row, not saying what went.
    - Proof 3: asking that leaves a retry wait; the tag leg, or the extract
      leg, not marking an ask; the gate ignoring an ask; the extraction
      builder not throwing the wait or the ask.
    - Proof 4: the steps' counts, the lane, or the lane's count ignoring the
      switch.
    - Proof 5: the page limit, the size limit, or an unknown count not
      checked; the upload's page count read before the read's.
    - Proof 6: tagging, or extraction, not falling back; a 413 not counted;
      any 4xx counted; a refusal counted with no file sent.
    - Proof 7: a textless PDF always sent as the file.
    - Proofs 8–9: the registry not checking `documents`; the wires' refusal
      with no status, or naming a vendor.
    - Proof 10: the file types drawn as before; no settings title; the switch
      not on by default; a stored value that isn't false turning it off.
    - Proof 11: the rows' words leaving out the PDF; the switch-on text said
      as news.
    - The boot race: both waits taken out, the live test failed 5 runs of 5.
  - **Real-app check: done 2026-10-05**, with your OK to rebuild and spend.
    - Your local app was rebuilt from the working copy and restarted, the app
      only (old image `588483d5`). Healthy, 0 restarts; migration 0060 applied
      at boot.
    - The switch was turned off inside the app container, merged into the
      card's stored config (your 20 MB upload size kept), and "transcriber
      test" was pointed at your Anthropic key. No session was minted.
    - **Claude, as file:** #9857 (the 6-page synthetic scan, read in Stage 2)
      retagged through `retagItem`. Tagged in 8.0 s by claude-haiku-4-5, row
      "as file", 10,739 input tokens; nothing converted.
    - **OpenAI, as text:** #6468 (a one-page invoice never read) retagged on
      your OpenAI default. The step asked; the PDF was converted (280 ms) and
      tagged 2 s later from its text by gpt-5.4-mini, row "as text: OpenAI
      can't read PDF files"; no attempt spent, no retry wait.
    - **Claude refuses, as text:** a synthetic dense PDF (99 pages, 410 KB,
      about 995,000 characters of made-up text) added to "transcriber test"
      through `storeFile` and `admitStored` (#9858). Claude refused the file,
      "prompt is too long: 385347 tokens > 200000 maximum"; the step asked;
      it was converted (0.8 s) and tagged from its text (36,229 input
      tokens, 6.1 s), the row giving Claude's reason; no attempt spent.
    - **Measured, as a file on Claude:** about 3,900 tokens a dense text page
      (385,347 for 99) and 1,800 a scanned page (10,739 for 6). So Haiku's
      200K holds about 50 dense pages, inside C7's 40–60 estimate.
    - **Put back:** the switch (only the upload size stored), the board's key
      (none), and the app restarted to drop the worker's cached choice for
      that board, which only the app's own routes clear. #6468 and #9858 keep
      their `pdf_text_wanted` mark, as designed (C4). The helper files were
      removed from the container. #9858 stays on "transcriber test", beside
      #9856 and #9857, until you say.
    - Spent: about 5 cents, nearly all on Claude.
- **Docs to update here** (found in Stage 1's second pass): PLUGIN.md's
  compat-wire line and the DeepSeek and Ollama example READMEs say those
  taggers can't do PDFs ("use an Anthropic tagger for PDF boards"). PDFs
  with text already reach them as text. *Only half true, the second pass
  found:* tagging also sends the PDF's first page as an image, which a
  text-only model refuses (below).
- **Second pass (2026-10-05).** Read against a copy of the code as it stood
  just before Stage 3, rebuilt from this session's own edits and checked
  against the hashes saved at the end of Stage 2's second pass. Two reviewers
  who never saw this plan: one on the worker and database, one on the cards,
  providers and docs. Both found the first defect below on their own.
  - **Fixed:**
    1. **An account's refusal was taken for the file's.** Anthropic answers
       an empty balance or a spend limit with a 400, which its wire marks a
       wait. The fallback counted any 400 on a call that carried a file. So
       with the switch off and the credit gone, every unread PDF would have
       been asked for and read (OCR included) and marked for good, and each
       try after made two calls. Now a 400 the wire marked a wait isn't the
       file's: one call, the wire's five-minute wait, nothing read.
    2. **The engine read Anthropic's error shape.** The fallback took the
       provider's sentence out of the Anthropic SDK's error body, one vendor's
       protocol in the engine. Now the Anthropic wire leaves its errors in the
       provider's own words, as the other wires already do, and the engine
       reads the message. Every Anthropic failure reads that way now: a failed
       row, the card's last error, a refused PDF's reason ("Your credit balance
       is too low…", where it was `400 {"type":"error",…}`).
    3. **A refused file showed as Claude failing.** The refusal was recorded
       on the Anthropic card ("Last error: prompt is too long…") until the
       next good call, which is minutes when the step has to ask for a read.
       A refused file is no longer the provider's fault on its card.
    4. **A step could go by a different switch than its claim.** The step
       read the switch afresh, so a maintenance pass landing between a claim
       and its step (likeliest while a refused file was out) could leave it
       holding an unread PDF with the switch on: a minute's wait. The claim
       now leaves its switch on the row and the step goes by it, which is
       what C4 already said.
    5. **A file of unknown size counted as fitting.** Now it doesn't, as an
       unknown page count doesn't.
    6. **The declaration check refused a null limit and let a typo through.**
       `{ maxPages: null }` stopped a plugin loading, though a plugin's null
       is "left out" everywhere else, and `{ maxPage: 100 }` loaded as no
       limit at all (C7 promised a typo couldn't). Now a null is no limit
       and an unknown key is refused by name.
    7. **The Jobs row's reason could be cut with nowhere to read it.** The
       note is in the row's hover too, and an odd stored value prints nothing.
    8. **Two settings saving at once could drop one.** The settings route
       read the stored config, merged, and wrote it all back. On the PDF card,
       clicking the switch blurs the page box, so both save together. Now each
       save writes only its own fields, in one statement. The route is older;
       the switch made it reachable.
    9. **Docs.** The DeepSeek README promised PDFs work. Tagging also sends
       the first page as an image, which DeepSeek refuses, so tagging a PDF
       there fails; field extraction works. PLUGIN.md's `documents` row,
       compat-wire line and text-only advice now say what happens, and the
       Ollama README stops saying chat completions take no PDF files (OpenAI's
       do; the app's wire sends none).
  - **Simplified:** `documentTextFor` no longer repeats the routing rule for
    PDFs (unread, parked, no text): on the one route that reaches it, the PDF
    is read and has text. The wait and the ask are one helper beside
    `pdfRoute`, used by both builders. Two stale comments fixed (a parked PDF
    is read again, with the switch off, only once a step asks; the manifest
    field list in sources/index.js).
  - **Tests that were missing:** nothing proved the maintenance pass re-reads
    the switch (taking the line out left everything green). The new live test
    turns the switch on while the worker runs, with a probe PDF only the read
    job can take, and the same test proves fix 4. A test PDF had no size,
    which no real upload lacks; it has one now.
  - **Suites:** `npm test` 2,441 tests: 2,439 pass, none fail, 2 skipped (the
    Linux-only poppler tests).
  - **Removal checks: 21/21 fail**, each on the test written for it, the files
    put back byte for byte after:
    - This pass's fixes: an account's 400 counted as a refusal; the Anthropic
      wire leaving the SDK's message, on a call and on a research turn's
      continuation; a refused file recorded on the card (the worker's side,
      and the ledger's); a step reading today's switch; the maintenance pass
      not re-reading it; an unknown size fitting; a null limit refused; a
      misspelled limit loading as none; the hover leaving out the PDF; an odd
      note printing; the settings route reading, merging and writing back
      whole (a field lost in 3 of 3 runs).
    - Stage 3's proofs this pass restructured, again on the final code: the
      builders not throwing the wait, or the ask; either builder routing
      without them; a refusal counted with no file sent; the claim, or field
      extraction, ignoring the switch; the boot race (5 of 5 runs).
  - **Declined, with why:**
    - A missing original on the file route fails the item after its retries,
      saying why, with nothing spent; with the switch on, the read parks it
      instead. A broken store either way, and the failure is honest.
    - Waking the read job after an ask saves at most one poll (3 s).
    - The card drawing a hand-edited non-boolean switch differently from the
      server: only a hand edit gets there; the route stores true or false.
    - One shared check for `images` and `documents`: after fix 6 their rules
      differ (the `images` check still refuses a null limit; older than this
      arc, recorded rather than changed here).
    - Folding the two legs' ask branches, or inlining `NEEDS_PDF_TEXT_SQL`
      (the twin of `NEEDS_TRANSCRIPT_SQL`): no clearer.
    - The PDF card's description ("Reads PDFs as text for the AI…") still
      describes the default.
  - **Open, not settled:**
    - Memory with the switch off: one 20 MB PDF in flight holds about 96 MB
      (measured: the file, its base64, the request body and the bytes sent),
      and a key takes up to 8 calls at once, so about 770 MB with big PDFs
      queued.
    - What Anthropic answers for an encrypted or damaged PDF. A 400 gets the
      fallback; anything else is retried.
    - The maintenance pass also runs the daily backup and storage walk, and
      the worker's switch waits for it, so after a flip the Jobs view's counts
      can lead the claim by that long.

### Stage 4 — OCR language (D11)

- **Changes:**
  - extractor/Dockerfile: Tesseract's language files only, English and 27
    more (D11), set by an `OCR_LANGS` build setting; not the `tesseract-ocr`
    program, and not `osd`;
  - extractor/main.py: `X-OCR-Lang`, its fallback to English, and the
    language in the job's identity and its report (C1);
  - public/ocr-languages.js (new): a language code by name, shared by the
    card's choices and the Jobs view's rows;
  - sources/pdf.js: "OCR language", and the extractor's address (its
    sidecar);
  - sidecar-catalog.js: a file type's sidecar is watched beside the AI
    engines';
  - plugins.js: `pdfReadSettings` reads the language; a pick-from-a-list
    field's choices come from its sidecar's answer;
  - server.js: the card gets the choices, named; a save is checked against
    them;
  - plugin-modal.js: the pick-from-a-list field;
  - worker.js: a read sends the language and stamps the one used; the
    extractor's address comes from the PDF plugin's declaration;
  - db.js: reprocess reads a PDF again when the language changed and OCR read
    some of it (C6);
  - jobs-modal.js: a read's row names a language other than English, and
    says when the image didn't have the one chosen.
- **Close look (2026-10-05)** changed the stage. Measured in the extractor
  image with throwaway containers; nothing in the project changed:
  - **The language matters.** A made-up French scan read as English got 344
    of 464 words exact and 206 of 280 accented letters; read as French, all
    of both. The same speed, about 2.5 s a page.
  - **The image installs an OCR program it never runs.** PyMuPDF has its own
    Tesseract built in and reads only the language files; it links none of
    the system's. Removing the `tesseract-ocr` program and its libraries
    freed about 90 MB and OCR still read the French page perfectly. `osd`
    (10 MB) isn't used either: a scan turned 90° read the same with it and
    without. So the plan's risk, a bigger image, turns round: language files
    only, English and 27 more, come to about 420 MB against today's 442 MB
    (estimated from the measured parts).
  - **Each language is small and stands alone:** 0.5–7.7 MB, no other
    packages. The 27 come to about 75 MB; all 162 of Debian's, 670 MB.
  - **The sidecar watch only knew AI engines.** The plan had the PDF plugin
    "declare a live catalog", but the watch read only the AI providers'
    registry, and its catalog is about models (pickers, board pins). It now
    takes a file type's declared address too; the model parts skip an answer
    with no models.
  - **A language the image lacks fails every scanned page** ("Tesseract
    couldn't load any languages"), and a refusal from the extractor would
    park every scanned PDF, since the app parks on any refused request. The
    card refusing it isn't enough: the image can change under a saved
    choice. So the extractor reads in English then, and says so.
  - **Already true:** `/health` lists the image's languages, without `osd`
    (Stage 1a), and every read since Stage 1b stamps its language, English.
  - **The names:** the runtime's own language names cover every code in the
    set but Tesseract's spellings for Chinese (`chi_sim`, `chi_tra`), a base
    code and a script.
  - **Not changing:** one language at a time. "English + French" read the
    French page as well as French alone, so several at once is cheap later.
  - **Your call, 2026-10-05:** "go ahead", with English and the 27 as the
    image's set.
- **Proofs.** Each one gets a removal check, recorded here once it's run.
  1. A French scan read as French gets its words and accents right, and read
     as English it doesn't, in the real image.
  2. `X-OCR-Lang`: a code the image lacks is read in English and reported
     so; one that isn't a code is refused; another language is another job.
  3. The image has the set's languages, and neither the `tesseract-ocr`
     program nor `osd`.
  4. The card lists the image's languages by name, and only those; a choice
     the image no longer has shows as not available.
  5. A save takes only a language the image has, and none while the
     extractor isn't answering; with it not answering, the card says the
     languages aren't known.
  6. A read sends the language (none for English), and the stamp records the
     one the extractor used; a hand-edited language reads as English.
  7. Reprocess reads a PDF again when the language changed and OCR read or
     failed on some of it; not a PDF read without OCR, nor one already read
     in today's language.
  8. The extractor's address is the PDF plugin's declaration, which the
     sidecar watch probes, and `EXTRACTOR_URL` overrides.
  9. The Jobs view names a read's language other than English, and says when
     the image didn't have the one chosen.
- **Real-app check:** rebuild the local extractor (your OK), pick French on
  the card, and read a French scan in it.
- **Built 2026-10-05, not pushed.**
  - **Files:**
    - extractor/Dockerfile: the language packages only, `OCR_LANGS` (28).
    - extractor/main.py: `X-OCR-Lang` (`LANG_CODE`), the fallback to English
      in `read_pdf`, `lang` and `lang_missing` in the report, the language in
      the job's settings.
    - extractor/test_main.py: `LanguageTest`, 5 new tests.
    - public/ocr-languages.js (new): `languageName`, `isLanguageCode`.
    - server/sources/pdf.js: "OCR language" (`type: "select"`, its choices
      from the extractor's `langs`) and `sidecar`, the extractor's address.
    - server/sidecar-catalog.js: `sidecars()` takes file types' sidecars;
      `sidecarUrl` reads either kind.
    - server/plugins.js: `pdfReadSettings` reads `ocrLang`; `fieldChoices`.
    - server/server.js: the Plugins feed gives a list field its choices and
      its saved choice's name; the save checks a list field's value.
    - public/plugin-modal.js: the list field.
    - server/worker.js: the extractor's address from `sidecarUrl`; the
      language sent and the one used stamped; the `OCR_LANG` constant gone.
    - server/db.js: the re-read rule and `pdfReadJson` take the language.
    - public/jobs-modal.js: the read's row names the language and the
      fallback.
    - Tests: plugins (3 new), pdf-text (2 new), sidecar-latency (1 new, 2
      changed), jobs-row (1 new), browser/plugin-fields (1 new, 1 changed).
  - **Decided while building:**
    - English asked for and English by default are one extractor job.
    - The card's choices go in name order, English among them.
    - A list field's choices come from its plugin's sidecar answer
      (`choicesFrom`) and are named by the field's own function
      (`choiceName`), so the shared card code knows nothing of languages.
      The names live in one module the server and the Jobs view share.
    - The read's row names the language only where OCR read or failed on a
      page; on a text PDF the language didn't matter.
    - An extractor image older than the setting names no language: the
      stamp says English, which it was, and a later reprocess reads it again.
    - The held list (extractor not answering) isn't greyed out: there's no
      shared style for a disabled list, and its help line says why it's held.
    - A host without the extractor keeps the sidecar watch on its fast look
      (every 2 s) for its first 3 minutes, as a missing transcriber already
      does. A watch test that assumed every sidecar answered now stands the
      extractor on its stand-in too; the watch's list of sidecars, in another
      test, now includes it.
  - **The image:** 421 MB with 28 languages, against 442 MB today with
    English alone (built from the working copy as `001az-extractor:stage4`;
    your stack is untouched). Its tests: 25/25.
  - **Suites:** `npm test` 2,449 tests: 2,447 pass, none fail, 2 skipped (the
    Linux-only poppler tests).
  - **Removal checks: 30/30 fail**, each on the test written for it, the files
    put back byte for byte after:
    - Proof 1: OCR reading English whatever is asked.
    - Proof 2: a missing language read in anyway; the fallback unreported;
      a header that isn't a code taken; the language out of the job's
      identity; English asked for made another job.
    - Proof 3: the image with the `tesseract-ocr` program, or with `osd`
      (each a rebuild).
    - Proof 4: the card not given the choices; the choices by code, or out of
      name order; a choice the image lacks shown as another; a list it can't
      know offered; Tesseract's spellings unnamed.
    - Proof 5: a save taking any language, or unchecked while the choices
      are unknown.
    - Proof 6: no language sent; the stamp saying the setting rather than
      what OCR used; the fallback left off the stamp and the row; a
      hand-edited language sent; English sent as a language.
    - Proof 7: reprocess ignoring the language; re-reading a PDF read without
      OCR; passing over OCR's failures; not told today's language.
    - Proof 8: the watch knowing only AI engines; the PDF plugin declaring no
      address. The worker's reads taking their address from the same place
      changes no behavior (the address is the same), so it has no check of
      its own.
    - Proof 9: the row leaving out OCR's language, or the fallback, or saying
      the fallback with no OCR.
    - One check first failed by error, not assertion (the test read a field
      the removal left out); the test now asserts it, and the check was
      re-run.
  - **Real-app check: done 2026-10-05**, with your OK.
    - Your local extractor and app were rebuilt from the working copy and
      restarted, those two only (`docker compose build extractor app && docker
      compose up -d --no-deps extractor app`; old images: app `ec809a6dc263`,
      extractor `fdea3b804702`). Both healthy, 0 restarts. The app's log:
      "sidecars: whisper up, localDetector up, media:pdf up"; the extractor's:
      its 28 languages.
    - Checked inside the app container with the app's own functions, no
      session: the card's choices, computed from the real extractor's answer,
      are its 28 languages by name.
    - French was set on the card the way its save writes it, and a made-up
      two-page French scan (306 KB, no text layer) was added to "transcriber
      test" through `storeFile` and `admitStored` (#9859). It was read in
      French (7.8 s, both pages by OCR, row `lang=fra`), every one of its 560
      accented letters right, and tagged from the text by gpt-5.4-mini (row
      "as text"), attempts 0.
    - The real extractor asked for a language it lacks (`xho`) read the same
      scan in English and said so (`lang=eng`, `lang_missing=xho`): 412 of
      560 accented letters, the 74% measured at the close look.
    - **Put back:** the card's language (only your upload size is stored),
      and the helper files removed from both containers. #9859 stays on
      "transcriber test", beside #9856–9858, until you say.
    - Spent: a fraction of a cent, the one tagging call.
    - **Noticed, not changed:** the kept text of an OCR'd page marks some lines
      as subheadings (`### Le procès-verbal…`). The extractor's heading rule
      reads OCR's uneven line heights as larger type; it did before this stage,
      in English too. Left for the arc's second pass.
- **Second pass (2026-10-05).** Read against the copy saved just before Stage 4
  was built. Two reviewers who never saw this plan, one on the extractor and
  one on the app; what reading couldn't settle was measured.
  - **Fixed:**
    1. **A reprocess could swap OCR text for less.** A language change re-read
       a PDF whatever the page setting. With OCR now off, or a lower limit, a
       reprocess dropped the kept text (French, say) and read the pages again
       with OCR off, so they came back unread. Stage 2's rule, that a lower
       setting keeps the text, now covers the language too: another language
       re-reads only where today's limit reads as many pages by OCR, and at
       least one.
    2. **Two quick picks on the language list could save out of order.** The
       list saved by itself, beside the card's shared autosave. Arrow keys on a
       closed list fire a change per step, so two saves went out at once and
       the first could land last. Measured with the first save held: the
       stored language was Finnish while the list showed French, 3 of 3 runs.
       It saves through autosave now, as the number box does: one save at a
       time, and a refused one puts the last saved choice back (where it
       reloaded the card).
    3. **An image built without English would fail every scan.** English is
       what a read falls back to, but a build naming other languages only
       left it out: every scanned page failed, and the row said "OCR read
       English". English is always installed now; `OCR_LANGS` names the
       others (27 by default).
    4. **The extractor could offer a language it would refuse.** /health
       listed any file in the language folder, so a hand-added one whose name
       isn't a code (`Fraktur.traineddata`) would show on the card and save,
       then read English with nothing said. It lists only codes now, by the
       rule `X-OCR-Lang` uses.
  - **Simplified:** the extractor's worker hands a job's settings to
    `read_pdf` by name; one `choiceLabel` names a list's value, for its
    choices and for the saved one.
  - **Tests that couldn't fail:**
    - The extractor's "osd isn't listed" test passed with the filter taken
      out, since the image has no osd any more. It now reads a language folder
      that has osd and a misnamed file.
    - The guard that no page waits on a sidecar never stood the extractor in
      as a host that hangs, so a probe added to the Plugins page's language
      list went unseen (shown below). The hanging host now covers the
      extractor, and the guard times a language save too.
  - **Measured:** each of the image's 28 languages loads and reads a page in
    PyMuPDF's own OCR (0.4–1.3 s each); only English and French had run
    before. Not made a test: about 17 s in CI, for a fault the French test
    catches whole.
  - **Image:** 421 MB, as before (built as `001az-extractor:pass4`; your stack
    is untouched). Its tests: 25/25.
  - **Suites:** `npm test` 2,450 tests: 2,448 pass, none fail, 2 skipped (the
    Linux-only poppler tests).
  - **Removal checks: 9/9 fail**, each on the test written for it, the files
    put back byte for byte after: reprocess re-reading in another language
    whatever the limit; with OCR off, past OCR's failures; not re-reading with
    a limit as high as the last read's; the list saving beside autosave (3 of
    3 runs); a refused pick left on the list; English left to `OCR_LANGS` (a
    rebuild); a misnamed file listed; osd listed; a probe on the Plugins page.
    - One check first passed: the test let the held save go before a second,
      parallel one could land. It now gives a parallel save a second to land
      first; the fixed list never sends one.
    - And one that must pass did: the same probe, with the extractor on the
      instantly refused address the guard used before this pass, unseen.
  - **Declined, with why:**
    - A PDF read in English because the image lacked the chosen language is
      read again on every reprocess, the same text each time, until the image
      has the language. Comparing with the language the image would use
      instead would turn French text into English once the image lost French;
      doing it right needs the image's languages in the reprocess rule. Rare
      (an image rebuilt with fewer languages, which the card marks "not
      available"); it costs OCR time on a reprocess you start, never text.
    - "eng" written in seven places (the field's default, the read, the SQL,
      the Jobs row): it's Tesseract's code for the extractor's fixed fallback,
      and one shared name would add imports to five files.
    - A language file listed but unloadable, or a language folder that can't
      be read: the pages fail and say so, or English is read and said. Both
      need a broken image.
    - A list field with no default, or with no sidecar to ask: none exists;
      the one there is has both.
  - **Not checked:** how well OCR reads right-to-left (Arabic, Hebrew) and
    Chinese, Japanese or Korean scans; that needs real scans.
  - **Your stack:** the local app and extractor rebuilt with this pass, with
    your OK, those two only (old images: app `4a6ab9384770`, extractor
    `4686570d0d64`). Both healthy, 0 restarts; the app's log has "media:pdf
    up", and the extractor lists its 28 languages.

### Stage 5 — More providers read PDF files (D10)

- **Changes:**
  - worker.js: the PDF part carries the file's name;
  - wires/compat.js: a PDF goes as OpenAI's `file` part, its name and a
    `data:` URL; a descriptor's `withDocuments` fields go with it, and only
    with it; the refusal of every PDF goes;
  - wires/google.js: a PDF goes through Gemini's own API, in a plain form
    without the search when research is off; research carries it too. A
    connection with its own server URL can't reach that API, so it refuses
    the PDF as the provider would (400) and the step sends the text;
  - openai.js: `documents: { maxBytes: 35 MB }`;
  - openrouter.js: `documents: { maxBytes: 20 MB, maxPages: 100 }`, and
    `withDocuments` asks for native reading only;
  - gemini.js: `documents: { maxBytes: 35 MB, maxPages: 1,000 }`;
  - tool.js: `rejectDocuments` goes, with no wire left that can't carry a PDF;
  - PLUGIN.md and the Ollama README: the shared wires send PDF files now.
- **Close look (2026-10-05)** changed the stage. Vendor docs read that day,
  then live checks with your OpenAI, OpenRouter and Gemini keys, your OK, on a
  made-up PDF (a dense page of 4,200 characters, and two of them):
  - **Gemini's OpenAI-style endpoint takes no PDFs.** Google's staff say so on
    its forum, and the live check got 400 "Invalid content part type: file".
    So a PDF goes through Gemini's own API, which the app spoke only for
    research, always with Google Search attached. It now has a plain form.
    Research carries the PDF too, so turning research on or off doesn't
    change what a board sends. A 2025 forum trick (the PDF sent as an image)
    is undocumented and the model sometimes ignored the instructions beside
    it; not used.
  - **OpenRouter's parser was the wrong thing to name.**
    - Left unasked, a model that can't read files (your default, Qwen3-VL)
      gets Mistral's OCR at $2 per 1,000 pages, billed on your own key too,
      and the app's meter can't see it.
    - Its free parser (Cloudflare's now; "pdf-text" is redirected there)
      turns every PDF into text first, even for a model that reads files, and
      the docs don't say it reads scans: at best the text the app already has.
    - Asked for native reading only, a model that reads files reads it
      (gpt-5.4-mini: both codes, $0.0007), and one that can't refuses it:
      Qwen3-VL answered 400 "Invalid value: file", which is what sends the
      PDF's text in the same try (D9). Its cost: nothing. The key's usage
      moved by the paid call's $0.0007 alone (it shows minutes late), and not
      at all in the 8 minutes after a second refusal.
  - **OpenAI's file part needs the file's name**, which the PDF part didn't
    carry, and a `data:` URL (its own example shows bare base64, which it
    refuses).
  - **Limits:**
    - OpenAI: 50 MB a request, files combined, and no page limit. Declared
      35 MB: base64 makes a file a third bigger, and OpenAI doesn't say which
      size counts. A PDF too long for the model is refused and goes as text.
    - Gemini: 50 MB or 1,000 pages for a PDF. Declared 35 MB and 1,000.
    - OpenRouter documents none: it hands the file to the model's own
      vendor, so the smallest of those holds, Anthropic's: 20 MB, 100 pages.
  - **What a page costs**, a dense page (measured):
    - OpenAI gpt-5.4-mini: about 920 tokens as a file, 910 as text. The same.
    - Gemini 3.5 Flash: 532 as a file (Google's pages say 258, or 560 for
      Gemini 3), the PDF's own text not charged; 908 as text. The file is
      cheaper, as D8's "usually" allows for.
  - **Already true:** Stage 3's fallback covers a model that can't take a
    file (OpenAI's text-only models, which its live model list can offer,
    answer "This model does not support file content types"). The wire's
    retry without a setting can't take a file's refusal for a temperature or
    schema refusal (its patterns checked).
  - **Not changing:** OpenRouter's reuse of parsed text ("annotations") only
    saves anything over a conversation, and each call here is one turn.
    Gemini recommends its newer Interactions API for new work, but
    generateContent "remains fully supported" and research already speaks it.
  - **Noticed, outside this arc:** OpenAI's changelog says its GPT-6 models
    need the Responses API for tool calls; the app tags through Chat
    Completions.
  - **Your call, 2026-10-05:** "sure": the live checks first, then this
    amendment, then the build.
- **Proofs.** Each one gets a removal check, recorded here once it's run.
  1. The OpenAI-style wire sends a PDF as OpenAI's `file` part, with the
     file's name and a `data:` URL; a request without one is as it was.
  2. A descriptor's `withDocuments` fields go with a PDF and only with one;
     OpenRouter's ask for native reading.
  3. OpenAI, OpenRouter and Gemini declare their limits; GLM declares none.
  4. Gemini: a PDF goes through its own API, without the search tool when
     research is off and with it when on; a call without a PDF goes the
     OpenAI-style way as before; a connection with its own server URL refuses
     the PDF as a 400.
  5. A step sends the file to OpenAI with the switch off, and a provider that
     can't read PDFs still gets the text.
- **Real-app check:** with the switch off, retag a PDF on an OpenAI board and
  on a Gemini board; each row says "as file".
- **Built 2026-10-05, not pushed.**
  - **Files:**
    - server/worker.js: the PDF part carries the file's name.
    - server/ai-providers/wires/compat.js: OpenAI's `file` part;
      `withDocuments`; the refusal of every PDF gone.
    - server/ai-providers/wires/google.js: `googleRequest`'s plain form
      (`research`) and a PDF part as inline data; `googleWire.tag` sends
      research or a PDF through Gemini's own API; `nativeTag` refuses a PDF
      as a 400 where that API can't be reached.
    - server/ai-providers/wires/tool.js: `rejectDocuments` gone.
    - openai.js, openrouter.js, gemini.js: `documents`; OpenRouter's
      `withDocuments`.
    - PLUGIN.md: the `documents` row, the PDF part's `name`, `withDocuments`,
      `nativeBase`, and the paragraph on PDFs over the compat wire. The Ollama
      README.
    - Tests: compat (2 new, and the refusal of every PDF gone), research (2
      new, 1 changed), model-input and providers (1 changed each),
      pdf-switch-worker (1 new; its provider that can't read PDFs is GLM now).
  - **Decided while building:**
    - A PDF on Gemini always goes through its own API, research or not; a
      call without one stays on the OpenAI-style endpoint, as before.
    - That call keeps research's 10-minute deadline with a PDF too: a long
      PDF can take minutes.
    - A Gemini connection with its own server URL refuses a PDF as Gemini
      would (400), so the step sends the text. Research there keeps its own
      message.
    - The PDF part's name is the uploaded file's, else the stored one's.
    - A request's own fields win over a descriptor's `withDocuments`.
  - **Live checks:** above, under the close look. Spent: under a cent in all.
  - **Suites:** `npm test` 2,454 tests: 2,452 pass, none fail, 2 skipped (the
    Linux-only poppler tests).
  - **Removal checks: 17/17 fail**, each on the test written for it, the
    files put back byte for byte after:
    - Proof 1: a PDF sent as a text part; the file part without its name; as
      bare base64; the PDF part carrying no name.
    - Proof 2: `withDocuments` never sent; sent with every request;
      overriding the request's own fields; OpenRouter asking for nothing.
    - Proof 3: OpenAI, Gemini or OpenRouter declaring no PDF files.
    - Proof 4: a PDF on Gemini left on the OpenAI-style endpoint; its plain
      call carrying the search, or the search's flag; the PDF sent to Gemini
      as text; a connection with its own server URL sending it anyway, or
      refusing it without the 400.
    - Proof 5 rides 1 and 3: the worker test's OpenAI board fails with the
      file part or the declaration taken out. GLM's way is Stage 3's,
      unchanged, and its test still passes.
  - **Real-app check: done 2026-10-05**, with your OK.
    - Your app was already running this build (its rebuild reused every
      layer: `8b5d6d99be6d`); healthy, 0 restarts, "media:pdf up".
    - Inside the app container with the app's own functions, no session: the
      switch off the way the card saves it, "transcriber test" pinned to your
      OpenAI key and then your Gemini key, and the made-up French scan
      (#9859, 2 pages) retagged on each.
    - OpenAI: "as file", gpt-5.4-mini, 2,386 tokens in. Gemini: "as file",
      gemini-3.5-flash through its own API, 1,702 tokens in.
    - Two retags missed, for the check's own reasons, not the app's: one
      right after the switch flipped (the worker reads the switch on its
      3-second pass), one after the pin (the worker holds a board's AI
      settings until the board is saved, which a direct database edit
      doesn't do; a restart cleared it). The second went to OpenAI as a file.
    - **Put back:** the board's key (the app default), the switch (only your
      upload size stored), the app restarted so it holds no Gemini setting
      for the board, the helper removed. #9859's tags are Gemini's now.
    - Spent: about a cent, four tagging calls.
- **Second pass (2026-10-05).** Read against a copy of the code as it stood
  just before Stage 5 (rebuilt: the files it first touched from git, the rest
  with its edits reversed). One reviewer who never saw this plan; two live
  calls settled what it couldn't.
  - **Fixed:**
    1. **A PDF on Gemini had research's ten-minute deadline.** Everywhere else
       a PDF call has the chat deadline, three minutes, and a timeout never
       sends the text (it has no status): it waits and tries again. A plain
       call through Gemini's own API now keeps the chat deadline too; research
       keeps its own.
    2. **The guard's messages named the wrong cause.** A google-wire
       descriptor with no native endpoint, asked to research, was told its
       connection's server URL was the problem, and a PDF's refusal read
       "Gemini refused the file: Gemini reads PDF files…" on its row. Each now
       says which: no native endpoint declared, or a server URL that can't
       reach it.
    3. **PLUGIN.md promised too much.** It invited a vendor whose models vary
       to declare PDF files and let the ones that can't refuse. Only a 400 or
       413 sends the text; another answer fails the call, and a server that
       drops a part it doesn't know tags from the name alone. It now says to
       declare them only for a server that reads PDF files, or refuses one
       that way. `withDocuments` carries only fields the wire doesn't send
       itself, and a descriptor that changes `base` changes `nativeBase` too,
       or declares neither research nor documents.
    4. **Comments** in providers.js, wires/index.js, gemini.js and PLUGIN.md
       still had Gemini's own API for research alone, and Gemini's inline
       ceiling at 20 MB (100 MB since 2026-01, 50 MB for a PDF).
  - **Tests that were missing:** a descriptor with no native endpoint (taking
    the clause out left everything green), the plain call's usage, and the
    deadline.
  - **Live, to settle what reading couldn't** (your keys, the made-up PDF,
    a fraction of a cent):
    - Field extraction through Gemini's own API, with the app's real
      `record_fields` schema and a PDF: every field right (only tagging had
      gone native before).
    - OpenAI takes a PDF named "Résumé – catalogue (finale) 2025.PDF".
  - **Suites:** `npm test` 2,455 tests: 2,453 pass, none fail, 2 skipped (the
    Linux-only poppler tests).
  - **Removal checks: 4/4 fail**, each on its test, the file put back byte for
    byte after: a plain PDF call on research's deadline; a descriptor with no
    native endpoint sending the PDF anyway; the refusal naming the provider
    again; the native call's usage misread.
  - **Declined, with why:**
    - Remembering that a model refuses files (OpenRouter's default does, every
      time, so with the switch off each PDF step makes a refused call first,
      unbilled but paced). A refusal can be the file's rather than the
      model's (a PDF too long for it), and D9 chose to remember nothing.
    - One helper for "carries a PDF" (three one-line uses), and the fallback
      names (`|| file.name`, `|| "document.pdf"`) that a stored PDF never
      needs: no clearer.
    - Checking `withDocuments`'s shape at load: no compat quirk is checked;
      PLUGIN.md says what it's for.
  - **Found, older than this arc, fixed after the push** (your "sure"):
    - Gemini's OpenAI-style endpoint answers errors as a list
      (`[{"error":…}]`, seen in the live check), which the compat wire didn't
      read, so its errors said "Gemini HTTP 400" and its refusal retries for
      temperature or a strict schema could never match there. The wire reads
      the list now.
    - "Prepayment credits" (an empty Gemini account) waited only on the
      native leg; on the OpenAI-style leg, which most Gemini calls take, it
      spent attempts and failed items. The Gemini wire reads it on both legs
      now. That leg's wording for it is assumed to be the native one's, as
      its other errors pass Google's own words through; not seen live.
    - Tests for both; with either fix taken out its test fails (3/3).
  - **Open:** with 35 MB declared, one PDF in flight holds about 170 MB (the
    file, its base64, the request), once an admin raises the 10 MB upload
    size; research with a PDF on Gemini isn't checked live; what Gemini and
    OpenAI answer for a damaged or encrypted PDF sent unread.

### Stage 6 — Second pass on the arc

## Not in this plan

- Per-board versions of these settings.
- Searching PDF text, or filling a PDF's word and line counts from it. Both
  become possible once the text is kept.
- A "read again" button for one PDF; reprocess covers it.
- Telling the user on the card when a host has no extractor, beyond its
  languages being unknown. Stage 4's sidecar watch makes that knowable, but
  showing it is cosmetic.
- Sending more than page 1 as a picture when converting.
- Gemini's claim from 2026-10-04 that the extractor freezes all work. Checked:
  only PDFs wait. The parts that were true are the over-claim, the board
  unfairness and the timeout retries, and Stage 1b fixes all three.

## Cost

- **Code:**
  - the extractor grows a job queue, roughly 150 lines in the transcriber's
    shape;
  - the worker gains a reader, a job kind and a landing (roughly 200 lines) and
    loses the waiting call (about 40);
  - the database gets a migration and about 60 lines;
  - the PDF card's fields reuse the connector card's code, moved rather than
    copied;
  - Stage 5 adds a `file` part per wire;
  - every stage brings its own tests.
- **Risk:**
  - Stage 1b changes the claim, the app's busiest query. Its gate rides a
    stored column for the reason 0057 measured: 15 ms against 550 ms on 20k
    queued rows.
  - Stage 4 was to grow the extractor image by the languages it bakes. Its
    close look measured the other way round: dropping the OCR program
    nothing runs pays for 27 languages.
- **Money:**
  - D4 sends more text for long PDFs (up to about 37k tokens a call instead of
    15k);
  - reading every scanned page costs extractor time, not tokens;
  - with the switch off, it costs more on Anthropic, about the same on OpenAI
    and less on Gemini (Stage 5 measured the last two).

## Sources

- OpenAI, file inputs: https://developers.openai.com/api/docs/guides/file-inputs
  (the old pdf-files address redirects here)
- Gemini, document understanding: https://ai.google.dev/gemini-api/docs/document-processing
- Gemini's OpenAI-style endpoint and PDFs (forum):
  https://discuss.ai.google.dev/t/openai-compatibility-for-pdf-file/77388
- OpenRouter, PDF inputs: https://openrouter.ai/docs/guides/overview/multimodal/pdfs
- Anthropic, PDF support: https://platform.claude.com/docs/en/build-with-claude/pdf-support
