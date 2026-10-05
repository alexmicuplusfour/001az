// What a job-log row SAYS — the presentation half of the jobs view, pure and
// node-testable (public/capability-present.js's planners are the precedent).
//
// The case that matters here is the AI image rendition (ai-image-input-plan.md).
// Its ladder is built to be invisible: on a missing original, a corrupt file,
// or a payload over the provider's cap it quietly sends the ≤600px card face
// and tags anyway. That is the right behaviour and it is exactly why a board
// running on the OLD input is indistinguishable from a working one — unless
// this row says so. These tests pin the two halves of that: when it speaks up,
// and when it must stay quiet.
import test from "node:test";
import assert from "node:assert/strict";
import "./browser-stub.js"; // globals first — jobs-modal.js pulls in client modules

const { summaryFor, imageTitle, titleFor, runningStatus, labelFor } = await import("../public/jobs-modal.js");

const tagRow = (image) => ({ kind: "tag", outcome: "ok", detail: { tags: 7, model: "gpt-5-mini", ...(image ? { image } : {}) } });

// --- the visible line: speak up only on deviation ---

test("a row whose model got the full rendition says nothing about it", () => {
  const s = summaryFor(tagRow({ source: "original", edge: 1568, quality: 82, bytes: 94208, ms: 130 }));
  assert.equal(s, "7 tags", "the normal case spends no width");
});

test("a legitimately small image is not a warning", () => {
  // An original no bigger than the card face has nothing to gain from a render,
  // and that is a FIFTH of a real gallery (measured: 8 of 40 sampled files).
  // Surfacing `source: "thumb"` as trouble would cry wolf on one row in five
  // until the field is worth nothing.
  assert.equal(summaryFor(tagRow({ source: "thumb", bytes: 8400, ms: 1 })), "7 tags");
});

test("a rendition that fell back says so, and why", () => {
  assert.equal(
    summaryFor(tagRow({ source: "thumb", bytes: 8400, ms: 44, fallback: "render-error" })),
    "7 tags · thumbnail fallback (render failed)"
  );
  assert.equal(
    summaryFor(tagRow({ source: "thumb", bytes: 8400, ms: 512, fallback: "byte-cap" })),
    "7 tags · thumbnail fallback (too large to send)"
  );
});

test("an unrecognized fallback reason is shown, not swallowed", () => {
  // A reason this client doesn't know is still the news; dropping it would
  // hide the one thing the row exists to report.
  assert.equal(
    summaryFor(tagRow({ source: "thumb", bytes: 10, ms: 1, fallback: "some-new-rung" })),
    "7 tags · thumbnail fallback (some-new-rung)"
  );
});

test("rows from before the rendition shipped still summarize", () => {
  assert.equal(summaryFor(tagRow(null)), "7 tags");
  assert.equal(summaryFor({ kind: "tag", outcome: "ok", detail: { tags: 1 } }), "1 tag");
});

// --- the IN PROGRESS rows: a long pass says how far along it is ---

test("a feed run in progress counts, instead of saying 'running' for three minutes", () => {
  assert.equal(runningStatus({ kind: "ingest", detail: { planned: 200, admitted: 47 } }), "importing 47 of 200");
  assert.equal(runningStatus({ kind: "ingest", detail: { planned: 200 } }), "importing 0 of 200",
    "the row appears before the first admission lands");
});

test("rows with nothing to count keep the plain word", () => {
  assert.equal(runningStatus({ kind: "ingest", detail: { trigger: "daily" } }), "running",
    "a run from before progress shipped, or one still enumerating");
  assert.equal(runningStatus({ kind: "ingest", detail: { planned: 0 } }), "running", "zero is not a countdown");
  assert.equal(runningStatus({ kind: "diagnose", detail: {} }), "running", "a kind with no verb of its own");
  assert.equal(runningStatus({ kind: "transcribe" }), "transcribing", "a kind with one");
});

// --- the cancel row: honest about both what it did and what it could not reach ---

test("a cancel that pulled work names the verb and the counts", () => {
  assert.equal(
    summaryFor({ kind: "cancel", outcome: "ok", detail: { mode: "queued", restored: 2, parked: 3, removed: 1, finishing: 0 } }),
    "cancelled: 2 restored · 3 parked · 1 removed"
  );
  assert.equal(
    summaryFor({ kind: "cancel", outcome: "ok", detail: { mode: "queued", parked: 3, finishing: 2 } }),
    "cancelled: 3 parked — 2 still running will finish"
  );
});

test("a cancel that could reach nothing leads with that, not with the verb", () => {
  // The 2026-09-10 postmortem: nineteen rows read "cancelled: 106 left to
  // finish" while nothing had been cancelled at all.
  assert.equal(
    summaryFor({ kind: "cancel", outcome: "ok", detail: { mode: "queued", finishing: 106 } }),
    "nothing was queued — 106 still running will finish"
  );
  assert.equal(
    summaryFor({ kind: "cancel", outcome: "ok", detail: { mode: "queued" } }),
    "cancelled — nothing was queued"
  );
});

test("a cancel that only stopped the feed says exactly that", () => {
  // The Stage 5 case, and the common one on a feed board: the queue was empty
  // at that instant because the run had not refilled it yet.
  assert.equal(
    summaryFor({ kind: "cancel", outcome: "ok", detail: { mode: "queued", stopped_run: true, drain_dropped: 750 } }),
    "cancelled: feed run stopped (750 to drain dropped)"
  );
  assert.equal(
    summaryFor({ kind: "cancel", outcome: "ok", detail: { mode: "queued", parked: 4, stopped_run: true } }),
    "cancelled: 4 parked · feed run stopped"
  );
});

test("an abort row is distinguishable and counts its discards", () => {
  assert.equal(
    summaryFor({ kind: "cancel", outcome: "ok", detail: { mode: "abort", parked: 4, discarding: 2, finishing: 0 } }),
    "aborted: 4 parked · 2 discarding"
  );
});

test("a transcribe row counts turns only when the engine produced them", () => {
  assert.equal(summaryFor({ kind: "transcribe", outcome: "ok", detail: { chars: 134, turns: 3 } }),
    "134 chars · 3 turns");
  // 0 is real news (structure produced, no speech) — not the same as absent.
  assert.equal(summaryFor({ kind: "transcribe", outcome: "ok", detail: { chars: 0, turns: 0 } }),
    "0 chars · 0 turns");
  // Rows from a turnless engine (older sidecar, plain provider model) stay as before.
  assert.equal(summaryFor({ kind: "transcribe", outcome: "ok", detail: { chars: 134 } }), "134 chars");
});

test("a transcribe row names its speaker count when diarization produced one", () => {
  assert.equal(summaryFor({ kind: "transcribe", outcome: "ok", detail: { chars: 134, turns: 3, speakers: 2 } }),
    "134 chars · 3 turns · 2 speakers");
  assert.equal(summaryFor({ kind: "transcribe", outcome: "ok", detail: { chars: 134, turns: 3, speakers: 1 } }),
    "134 chars · 3 turns · 1 speaker");
  // The stamp omits speakers when zero — an undiarized row reads as before.
  assert.equal(summaryFor({ kind: "transcribe", outcome: "ok", detail: { chars: 134, turns: 3 } }),
    "134 chars · 3 turns");
});

// --- the hover: the full facts, and the cache's measurement ---

test("the title names the resolution actually sent, its size, and its cost", () => {
  assert.equal(
    imageTitle({ preset: "high", source: "original", edge: 1568, quality: 82, bytes: 94208, ms: 130 }),
    "high · 1568px q82 · 92 KB · 130ms"
  );
});

test("the preset asked for rides the title, because the size can't imply it", () => {
  // Same 1568px on the wire, two different board settings — on a provider
  // whose ceiling is 1568, `max` clamps to exactly what `high` requests. The
  // outcome is identical; the setting is not.
  const shot = { source: "original", edge: 1568, quality: 82, bytes: 94208, ms: 130 };
  assert.equal(imageTitle({ ...shot, preset: "high" }), "high · 1568px q82 · 92 KB · 130ms");
  assert.equal(imageTitle({ ...shot, preset: "max" }), "max · 1568px q82 · 92 KB · 130ms");
  // And the pairing that matters: asked high, sent the card face.
  assert.equal(
    imageTitle({ preset: "high", source: "thumb", bytes: 8400, ms: 44, fallback: "render-error" }),
    "high · thumbnail (render failed) · 8 KB · 44ms"
  );
});

test("a queue behind the decode gate rides the title — the rendition cache's evidence", () => {
  // ms is the WHOLE call, so the queued portion has to be named or a slow row
  // is ambiguous between "sharp is slow" and "eight jobs are waiting" — and
  // only the second one argues for the cache.
  assert.equal(
    imageTitle({ source: "original", edge: 1568, quality: 82, bytes: 94208, ms: 740, waitMs: 610 }),
    "1568px q82 · 92 KB · 740ms (610ms queued)"
  );
});

test("the title tells a deliberate thumbnail from a failed one", () => {
  assert.equal(imageTitle({ source: "thumb", bytes: 8400, ms: 1 }), "thumbnail · 8 KB · 1ms");
  assert.equal(
    imageTitle({ source: "thumb", bytes: 8400, ms: 44, fallback: "render-error" }),
    "thumbnail (render failed) · 8 KB · 44ms"
  );
});

test("a row with no image gets no title of its own", () => {
  // Text items, PDFs, transcriptions — the hover must stay free for `engine`.
  assert.equal(imageTitle(undefined), "");
  assert.equal(imageTitle(null), "");
});

// --- what a row is about: the instance first, its card second (instance-work-plan.md D4) ---

test("a raw board's row is its file alone — the card has no name of its own", () => {
  assert.equal(labelFor({ kind: "tag", target: "photo.png", entity_display: null, item_id: 9 }), "photo.png");
});

test("a derived board's row names the file, then the card", () => {
  assert.equal(labelFor({ kind: "extract", target: "2jNX7ZT.jpg", entity_display: "emma watson", item_id: 5248 }), "2jNX7ZT.jpg · emma watson");
});

test("a connector vehicle reads ticker, then company — that is the vehicle", () => {
  assert.equal(labelFor({ kind: "fetch", target: "snyr", entity_display: "Synergy CHC Corp.", item_id: 1 }), "snyr · Synergy CHC Corp.");
});

test("the same string is shown once; a refresh row (no file) is the card alone", () => {
  assert.equal(labelFor({ kind: "tag", target: "bitcoin", entity_display: "bitcoin", item_id: 2 }), "bitcoin");
  assert.equal(labelFor({ kind: "refresh", target: null, entity_display: "bitcoin", item_id: null }), "bitcoin");
});

test("a board-level row needs no label, a feed run has its own, an orphan names its id", () => {
  assert.equal(labelFor({ kind: "retag", target: null, entity_display: null, item_id: null }), "");
  assert.equal(labelFor({ kind: "ingest", target: null, entity_display: null, item_id: null }), "Feed run");
  assert.equal(labelFor({ kind: "tag", target: null, entity_display: null, item_id: 42 }), "item 42");
});

test("a claimed instance says what its leg is doing, by kind", () => {
  assert.equal(runningStatus({ kind: "extract", leg: true }), "extracting");
  assert.equal(runningStatus({ kind: "tag", leg: true }), "tagging");
  assert.equal(runningStatus({ kind: "face", leg: true }), "rendering chart");
  assert.equal(runningStatus({ kind: "fetch", leg: true }), "fetching data");
  assert.equal(runningStatus({ kind: "diagnose" }), "running");
});

// planning/embed-work-plan.md Stage 2: one row per embed batch.
test("an embed batch: named by its file or its count, says what it skipped and spent, and runs as 'embedding'", () => {
  assert.equal(labelFor({ kind: "embed", target: null, entity_display: null, item_id: null, detail: { items: 64 } }), "64 items",
    "no one file to name, so the count is the name");
  assert.equal(labelFor({ kind: "embed", target: "a.png", entity_display: null, item_id: 7, detail: { items: 1 } }), "a.png",
    "a one-item batch is named by its file, like every other row");
  assert.equal(labelFor({ kind: "embed", target: null, entity_display: null, item_id: 7, detail: { items: 1 } }), "1 item");
  assert.equal(labelFor({ kind: "embed", target: "p.png", entity_display: null, item_id: 9, detail: { model: "m" } }), "p.png",
    "a poison item's own failed row is unchanged");
  assert.equal(summaryFor({ kind: "embed", outcome: "ok", detail: { items: 1, embedded: 1 } }), "",
    "nothing deviates and an on-device engine reports no tokens: nothing to say");
  assert.equal(summaryFor({ kind: "embed", outcome: "ok", detail: { items: 2, embedded: 1, skipped: 1, tokens: { in: 1200, out: 0 } } }),
    "1 skipped · 1.2K in / 0 out");
  assert.equal(summaryFor({ kind: "embed", outcome: "requeued", error: "upstream 503", detail: { attempts: 3 } }),
    "3 attempts · upstream 503", "an engine that's down reads like transcription's");
  assert.equal(runningStatus({ kind: "embed" }), "embedding");
});

// --- a PDF's read (pdf-conversion-plan.md C9) ---

test("a PDF read row says how much there was and which pages went unread, and why", () => {
  const row = (detail) => summaryFor({ kind: "convert", outcome: "ok", detail: { chars: 900, ocr_limit: 20, ...detail } });
  assert.equal(row({ pages: 40, ocr_pages: 20, skipped: [[21, 40]] }), "40 pages · 20 by OCR · pages 21–40 skipped (OCR limit 20)");
  assert.equal(row({ pages: 1 }), "1 page", "a plain text PDF says nothing more");
  assert.equal(row({ pages: 9, skipped: [[2, 2], [5, 9]], ocr_limit: 0 }), "9 pages · pages 2, 5–9 skipped (OCR is off)");
  assert.equal(row({ pages: 3, ocr_pages: 2, ocr_failed: [[7, 7]] }), "3 pages · 2 by OCR · OCR couldn't read page 7");
  assert.equal(row({ pages: 2, chars: 0 }), "2 pages · no readable text");
});

test("a PDF read row names OCR's language when it isn't English, and says when the image lacked the one chosen", () => {
  // pdf-conversion-plan.md Stage 4. Either only matters where OCR read, or
  // failed on, a page.
  const row = (detail) => summaryFor({ kind: "convert", outcome: "ok", detail: { chars: 900, ocr_limit: null, pages: 3, ...detail } });
  assert.equal(row({ ocr_pages: 2, lang: "eng" }), "3 pages · 2 by OCR", "English, the default, goes unsaid");
  assert.equal(row({ ocr_pages: 2, lang: "fra" }), "3 pages · 2 by OCR in French");
  assert.equal(row({ ocr_pages: 2, lang: "chi_sim" }), "3 pages · 2 by OCR in Chinese (Simplified)");
  assert.equal(row({ ocr_pages: 2, lang: "eng", lang_missing: "fra" }),
    "3 pages · 2 by OCR · French isn't in the extractor image, so OCR read English");
  assert.equal(row({ ocr_failed: [[1, 3]], lang: "eng", lang_missing: "fra" }),
    "3 pages · OCR couldn't read pages 1–3 · French isn't in the extractor image, so OCR read English");
  assert.equal(row({ text_pages: 3, lang: "eng", lang_missing: "fra" }), "3 pages", "no OCR: the language didn't matter");
  assert.equal(row({}), "3 pages", "a row from before Stage 4");
});

test("a PDF read in progress names the page it is on", () => {
  assert.equal(runningStatus({ kind: "convert", detail: { pages_done: 11, pages_total: 40 } }), "converting page 12 of 40");
  assert.equal(runningStatus({ kind: "convert", detail: { pages_done: 40, pages_total: 40 } }), "converting page 40 of 40",
    "every page read, the text being assembled");
  assert.equal(runningStatus({ kind: "convert", detail: {} }), "converting", "before its first page lands");
});

// --- what a PDF went to the model as (pdf-conversion-plan.md C8) ---

test("a step's row says what a PDF went as when it isn't the text the switch on sends, and why", () => {
  const tag = (pdf) => summaryFor({ kind: "tag", outcome: "ok", detail: { tags: 3, ...(pdf ? { pdf } : {}) } });
  const extract = (pdf) => summaryFor({ kind: "extract", outcome: "ok", detail: { fields: 2, pdf } });
  assert.equal(tag({ as: "text" }), "3 tags", "the switch on, as it says: nothing to add");
  assert.equal(tag({ as: "file" }), "3 tags · as file");
  assert.equal(tag({ as: "file", why: "no readable text" }), "3 tags · as file: no readable text");
  assert.equal(tag({ as: "text", why: "GLM can't read PDF files" }), "3 tags · as text: GLM can't read PDF files");
  assert.equal(tag({ as: "text", why: "140 pages, over Anthropic's 100" }), "3 tags · as text: 140 pages, over Anthropic's 100");
  assert.equal(tag({ as: "picture", why: "no readable text; GLM can't read PDF files" }),
    "3 tags · as picture and name: no readable text; GLM can't read PDF files");
  assert.equal(extract({ as: "file" }), "2 fields · as file", "field extraction's row says it too");
  assert.equal(extract({ as: "text", why: "Anthropic refused the file: prompt is too long" }),
    "2 fields · as text: Anthropic refused the file: prompt is too long");
  assert.equal(tag(null), "3 tags", "a row from before Stage 3, or not a PDF");
  for (const odd of [{}, { why: "x" }]) assert.equal(tag(odd), "3 tags", `nothing said for ${JSON.stringify(odd)}`);
});

test("a step's row hover repeats what the PDF went as, which the one-line cell can cut", () => {
  // A provider's own reason is long: the cell ends in an ellipsis, and the
  // hover is where the rest is read.
  const why = "Anthropic refused the file: prompt is too long: 385347 tokens > 200000 maximum";
  const row = { kind: "tag", outcome: "ok", detail: { tags: 3, tokens: { in: 36229, out: 120, cache: 900 }, pdf: { as: "text", why } } };
  assert.equal(titleFor(row), `900 cached reads · as text: ${why}`);
  assert.equal(titleFor({ ...row, detail: { ...row.detail, pdf: { as: "text" } } }), "900 cached reads", "the switch on's text: nothing to add");
  assert.equal(titleFor({ kind: "tag", outcome: "ok", detail: { tags: 3 } }), "", "not a PDF: no hover");
});
