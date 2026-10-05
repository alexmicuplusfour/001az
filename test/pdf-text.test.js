// PDF reading (planning/pdf-conversion-plan.md, Stage 1b): each PDF is read once,
// in its own job, and the text is kept beside the file for the steps to read.
// The reader runs against a stand-in extractor speaking C1 (POST /jobs, then
// GET /jobs/<id> until it settles), the way audio-handoff-worker.test.js stands
// in for the transcriber; the read job's queries and the claim's gate run
// against a real database. The live-worker half is pdf-text-worker.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startServer, seedBoard, seedInstance, adminSession, req } from "./helpers.js";
import {
  createEntity, insertItem, claimFairBatch, pdfsNeedingText, boardLaneQueues, pipelineWork,
  reprocessEntity, reprocessBoard, reextractItem, setPluginState, askPdfText,
} from "../server/db.js";
import { readPdfText, convertOne, laneFailurePolicy } from "../server/worker.js";
import { createSources } from "../server/sources/index.js";

let srv, db, extractor;
// The stand-in's jobs: a job's id is the PDF's bytes (these PDFs are short
// ASCII stand-ins), and its script is the answers its polls get in turn, the
// last one repeating.
const scripts = new Map();
const submits = [];
let submitStatus = 202;
// An answer that stops mid-way, so reading it fails as it does when a connection
// drops partway through a reply: a script step, or the submit's status.
const CUT = "cut";
const cut = (rs) => rs.end('{"status": "runn');

before(async () => {
  srv = await startServer();
  db = srv.db;
  extractor = await new Promise((resolve) => {
    const s = http.createServer((rq, rs) => {
      const chunks = [];
      rq.on("data", (c) => chunks.push(c));
      rq.on("end", () => {
        rs.setHeader("Content-Type", "application/json");
        const body = Buffer.concat(chunks).toString();
        if (rq.method === "POST") {
          submits.push({ body, ocrPages: rq.headers["x-ocr-pages"], ocrLang: rq.headers["x-ocr-lang"] });
          if (submitStatus === CUT) return cut(rs);
          rs.statusCode = submitStatus;
          return rs.end(JSON.stringify(submitStatus === 202 ? { job: body, status: "queued" } : { error: "no" }));
        }
        const script = scripts.get(rq.url.slice("/jobs/".length));
        if (!script) { rs.statusCode = 404; return rs.end(JSON.stringify({ error: "unknown job" })); }
        const answer = script.length > 1 ? script.shift() : script[0];
        if (answer === CUT) return cut(rs);
        rs.end(JSON.stringify(answer));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  // Read on every call (worker.js extractorUrl), so setting it here is enough.
  process.env.EXTRACTOR_URL = `http://127.0.0.1:${extractor.address().port}`;
});

after(async () => {
  await new Promise((r) => extractor.close(r));
  await srv.close();
});

const queued = { status: "queued", progress: { pages_done: 0, pages_total: null } };
const running = (done, total = 10) => ({ status: "running", progress: { pages_done: done, pages_total: total } });
const finished = (markdown, report = {}) => ({
  status: "done", progress: { pages_done: 1, pages_total: 1 }, markdown,
  report: { pages: 1, text_pages: 1, ocr_pages: 0, skipped: [], ocr_failed: [], chars: markdown.length, ...report },
});
const failed = (permanent, error) => ({ status: "failed", progress: { pages_done: 0, pages_total: 1 }, error, permanent });

// A PDF item as an upload leaves it, its bytes on disk under `body`.
async function seedPdf(boardId, body, { status = "pending", extra = {}, age = 0 } = {}) {
  const name = `${body}.pdf`;
  fs.writeFileSync(path.join(srv.galleryDir, name), body);
  const eid = await createEntity(db, boardId, { identity: name });
  const id = await insertItem(db, boardId,
    { identity: name, files: [{ name, original_name: `${body}.pdf`, kind: "pdf" }], fields: {}, ...extra }, status, eid);
  if (age) await db.query("UPDATE items SET created_at=$1 WHERE id=$2", [Date.now() - age, id]);
  return { id, eid, name };
}
const rowOf = async (id) => (await db.query("SELECT * FROM items WHERE id=$1", [id])).rows[0];
const jobsOf = async (itemId) =>
  (await db.query("SELECT * FROM job_log WHERE item_id=$1 AND kind='convert' ORDER BY id", [itemId])).rows;
// Each test owns the PDFs it reads: the read job's queue spans every board.
const fresh = () => db.query("DELETE FROM items");
// Boards in the order the read job's query walks them.
const boardsInIdOrder = async (...boards) =>
  (await db.query("SELECT id FROM boards WHERE id = ANY($1) ORDER BY id", [boards])).rows.map((r) => r.id);
// A reader test that regresses into polling forever fails here instead of hanging.
const READ = { timeout: 30000 };

// --- the reader ---

test("a read that keeps finishing pages runs on past the stall window", READ, async () => {
  scripts.set("slow", [running(1), running(2), running(3), finished("slow but sure")]);
  const seen = [];
  const t0 = Date.now();
  const out = await readPdfText(Buffer.from("slow"), { stallMs: 300, onProgress: (d, t) => seen.push([d, t]) });
  assert.equal(out.markdown, "slow but sure");
  assert.ok(Date.now() - t0 > 3 * 300, "several stall windows went by");
  assert.deepEqual(seen, [[1, 10], [2, 10], [3, 10]], "each page reaches the running row");
});

test("time queued behind another job is not a stall", READ, async () => {
  // After an app restart the extractor can still be busy with a PDF the app
  // lost track of; the next one waits queued for as long as that takes, and the
  // extractor times that one itself.
  scripts.set("behind", [queued, queued, queued, running(1), finished("my turn")]);
  const out = await readPdfText(Buffer.from("behind"), { stallMs: 300 });
  assert.equal(out.markdown, "my turn");
});

test("a read that stops finishing pages while running is this PDF's stall", READ, async () => {
  scripts.set("stuck", [running(1)]);
  await assert.rejects(readPdfText(Buffer.from("stuck"), { stallMs: 300 }), (e) => {
    assert.match(e.message, /extractor stalled/);
    assert.equal(laneFailurePolicy(e, 0), "backoff-item", "this PDF retries; the lane moves on");
    assert.equal(laneFailurePolicy(e, 4, 5), "park-capped", "until it's out of tries");
    return true;
  });
});

test("each extractor answer maps to the lane's rules", READ, async (t) => {
  const policyOf = async (body) => {
    try { await readPdfText(Buffer.from(body), { stallMs: 300 }); } catch (e) { return [laneFailurePolicy(e, 0), e.message]; }
    return ["ok"];
  };
  t.after(() => { submitStatus = 202; });

  scripts.set("locked", [failed(true, "the PDF is password-protected")]);
  assert.deepEqual(await policyOf("locked"), ["park", "extractor: the PDF is password-protected"],
    "a file it can't open is parked at once");
  scripts.set("crashed", [failed(false, "the PDF worker stopped on page 3")]);
  assert.equal((await policyOf("crashed"))[0], "backoff-item", "a failure that may not recur retries this PDF");

  submitStatus = 503;
  assert.equal((await policyOf("full"))[0], "backoff-lane", "a full queue waits for the extractor");
  submitStatus = 404;
  const [old, why] = await policyOf("old");
  assert.equal(old, "backoff-lane", "an image without /jobs waits, nothing fails");
  assert.match(why, /extractor image is older than the app/);
  submitStatus = 202;

  const live = process.env.EXTRACTOR_URL;
  process.env.EXTRACTOR_URL = "http://127.0.0.1:1";
  try {
    assert.equal((await policyOf("down"))[0], "backoff-lane", "the extractor down waits");
  } finally { process.env.EXTRACTOR_URL = live; }
});

test("an answer cut off mid-way is the extractor's blip, never this PDF's", READ, async (t) => {
  // A poll's answer dropped mid-way counts as a poll that failed: the read goes on.
  scripts.set("cut", [running(1), CUT, finished("whole again")]);
  assert.equal((await readPdfText(Buffer.from("cut"), { stallMs: 5000 })).markdown, "whole again");
  // A submit's, as an extractor that didn't answer: the lane waits, nothing parks.
  t.after(() => { submitStatus = 202; });
  submitStatus = CUT;
  await assert.rejects(readPdfText(Buffer.from("cut-submit")), (e) => laneFailurePolicy(e, 0) === "backoff-lane");
});

// --- one read, end to end ---

test("a read keeps the text beside its file and stamps how it was read", READ, async (t) => {
  await fresh();
  const b = await seedBoard(db, "pdf-ok");
  const { id, name } = await seedPdf(b, "kept");
  const text = "# Report\n\n[Pages 2–3 are scanned and weren't read (OCR limit 1).]";
  scripts.set("kept", [running(2, 3), finished(text, { pages: 3, ocr_pages: 1, skipped: [[2, 3]], chars: 8 })]);
  const retry = new Map([[id, { attempts: 2, until: 0 }]]);
  // The PDF card's page setting, as the read finds it.
  await setPluginState(db, "media:pdf", { config: { ocrPages: 1 } });
  t.after(() => setPluginState(db, "media:pdf", { config: {} }));

  assert.equal(await convertOne(db, srv.galleryDir, await rowOf(id), retry), "ok");
  assert.equal(fs.readFileSync(path.join(srv.galleryDir, name + ".md"), "utf8"), text);
  const row = await rowOf(id);
  assert.ok(row.payload.pdf_text.at > 0);
  assert.deepEqual({ ...row.payload.pdf_text, at: 0 }, {
    pages: 3, text_pages: 1, ocr_pages: 1, skipped: [[2, 3]], ocr_failed: [], chars: 8, ocr_limit: 1, lang: "eng", at: 0,
  }, "the report, and the settings it was read with");
  assert.equal(row.awaiting_pdf_text, false);
  assert.equal(submits.at(-1).ocrPages, "1", "the card's setting, sent");
  assert.equal(retry.has(id), false, "a landed read forgets its retries");
  const [job] = await jobsOf(id);
  assert.equal(job.outcome, "ok");
  assert.equal(job.target, "kept.pdf");
  assert.deepEqual([job.detail.pages, job.detail.skipped, job.detail.ocr_limit, job.detail.chars], [3, [[2, 3]], 1, 8]);
  assert.deepEqual([job.detail.pages_done, job.detail.pages_total], [2, 3], "the pages it reported while running");
});

test("with no page setting, a read sends no limit and stamps every page", READ, async () => {
  // Sent as a value, "every page" would read "null", which the extractor
  // refuses — every PDF would park.
  await fresh();
  const b = await seedBoard(db, "pdf-every");
  const { id } = await seedPdf(b, "every");
  scripts.set("every", [finished("all of it", { pages: 2, ocr_pages: 2 })]);
  assert.equal(await convertOne(db, srv.galleryDir, await rowOf(id), new Map()), "ok");
  assert.equal(submits.at(-1).ocrPages, undefined, "no X-OCR-Pages header");
  assert.equal((await rowOf(id)).payload.pdf_text.ocr_limit, null, "null: every scanned page");
});

test("a page setting that isn't a whole number reads every page instead of parking every PDF", READ, async (t) => {
  // The card only stores whole numbers; a row edited by hand might not.
  await fresh();
  const b = await seedBoard(db, "pdf-odd");
  const { id } = await seedPdf(b, "odd");
  scripts.set("odd", [finished("read anyway")]);
  await setPluginState(db, "media:pdf", { config: { ocrPages: "abc" } });
  t.after(() => setPluginState(db, "media:pdf", { config: {} }));
  assert.equal(await convertOne(db, srv.galleryDir, await rowOf(id), new Map()), "ok");
  assert.equal(submits.at(-1).ocrPages, undefined, "not sent: the extractor would refuse it");
});

test("a read sends the card's OCR language, none for English, and stamps the one the extractor used", READ, async (t) => {
  // pdf-conversion-plan.md Stage 4. The stamp records the language OCR used, as
  // the extractor says: English when its image lacked the one asked for, which
  // the read's row says too.
  await fresh();
  t.after(() => setPluginState(db, "media:pdf", { config: {} }));
  const b = await seedBoard(db, "pdf-lang");
  const readIn = async (body, setting, report) => {
    const { id } = await seedPdf(b, body);
    scripts.set(body, [finished("lu", { pages: 1, text_pages: 0, ocr_pages: 1, ...report })]);
    await setPluginState(db, "media:pdf", { config: setting === undefined ? {} : { ocrLang: setting } });
    assert.equal(await convertOne(db, srv.galleryDir, await rowOf(id), new Map()), "ok");
    return { sent: submits.at(-1).ocrLang, stamp: (await rowOf(id)).payload.pdf_text, row: (await jobsOf(id))[0].detail };
  };
  let r = await readIn("lang-fr", "fra", { lang: "fra" });
  assert.deepEqual([r.sent, r.stamp.lang, r.row.lang], ["fra", "fra", "fra"]);
  r = await readIn("lang-en", undefined, { lang: "eng" });
  assert.equal(r.sent, undefined, "English: no X-OCR-Lang header, the extractor's default");
  assert.equal(r.stamp.lang, "eng");
  r = await readIn("lang-gone", "fra", { lang: "eng", lang_missing: "fra" });
  assert.deepEqual([r.stamp.lang, r.stamp.lang_missing, r.row.lang_missing], ["eng", "fra", "fra"], "read in English, and said");
  r = await readIn("lang-odd", "FRA", { lang: "eng" });
  assert.equal(r.sent, undefined, "a hand-edited value that isn't a code reads as English, not sent");
  r = await readIn("lang-old", "fra", {});
  assert.equal(r.stamp.lang, "eng", "an image older than the setting names no language: it read English");
});

test("a database blip while reading the page setting doesn't park the PDF", READ, async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-setting");
  const { id } = await seedPdf(b, "setting");
  const blip = {
    query: (sql, args) => (/FROM plugins WHERE id=\$1/.test(sql)
      ? Promise.reject(new Error("Connection terminated unexpectedly")) : db.query(sql, args)),
  };
  const retry = new Map();
  await assert.rejects(convertOne(blip, srv.galleryDir, await rowOf(id), retry), /Connection terminated/,
    "thrown to the loop, which tries the PDF again next tick");
  const row = await rowOf(id);
  assert.equal("pdf_text_error" in row.payload, false, "not parked");
  assert.equal(row.awaiting_pdf_text, true, "still waiting for its read");
  assert.deepEqual([retry.size, (await jobsOf(id)).length], [0, 0], "no attempt spent, no job row");
});

test("a PDF the extractor can't open is parked, its reason on the job row", READ, async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-parked");
  const { id, name } = await seedPdf(b, "parked");
  scripts.set("parked", [failed(true, "the PDF is password-protected")]);
  assert.equal(await convertOne(db, srv.galleryDir, await rowOf(id), new Map()), "parked");
  const row = await rowOf(id);
  assert.equal(row.payload.pdf_text_error, "extractor: the PDF is password-protected");
  assert.equal(row.awaiting_pdf_text, false, "an answer: the steps go ahead without the text");
  assert.equal(fs.existsSync(path.join(srv.galleryDir, name + ".md")), false);
  const [job] = await jobsOf(id);
  assert.deepEqual([job.outcome, job.error], ["failed", "extractor: the PDF is password-protected"]);
});

test("a PDF that keeps stalling is parked once out of tries", READ, async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-capped");
  const { id } = await seedPdf(b, "capped");
  scripts.set("capped", [running(1)]);
  const retry = new Map([[id, { attempts: 4, until: 0 }]]);
  assert.equal(await convertOne(db, srv.galleryDir, await rowOf(id), retry, { stallMs: 300 }), "parked");
  assert.match((await rowOf(id)).payload.pdf_text_error, /^gave up after 5 attempts: extractor stalled/);
  assert.equal(retry.has(id), false);
});

test("a disk or database failure after a good read retries the PDF; it never parks it", READ, async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-local");
  const { id, name } = await seedPdf(b, "local");
  scripts.set("local", [finished("read fine")]);
  const kept = path.join(srv.galleryDir, name + ".md");
  const retry = new Map();

  // The kept text can't be written: a folder stands where it goes.
  fs.mkdirSync(kept);
  assert.equal(await convertOne(db, srv.galleryDir, await rowOf(id), retry), "backoff-item");
  fs.rmdirSync(kept);
  // The database drops the stamp's write, and only that.
  const dropsTheStamp = {
    query: (sql, args) => (/^UPDATE items SET payload = payload \|\| \$1::jsonb WHERE id=\$2/.test(sql)
      ? Promise.reject(new Error("Connection terminated unexpectedly")) : db.query(sql, args)),
  };
  assert.equal(await convertOne(dropsTheStamp, srv.galleryDir, await rowOf(id), retry), "backoff-item");
  assert.equal("pdf_text_error" in (await rowOf(id)).payload, false, "not parked");
  assert.equal(retry.get(id).attempts, 2, "each spends an attempt, so a failure that lasts still stops");

  // All well again: the next go lands, from the result the extractor kept.
  assert.equal(await convertOne(db, srv.galleryDir, await rowOf(id), retry), "ok");
  assert.equal(fs.readFileSync(kept, "utf8"), "read fine");
});

test("with the extractor unable to serve, a PDF waits: no error, no attempt, one job row", async (t) => {
  await fresh();
  const b = await seedBoard(db, "pdf-lane");
  const { id } = await seedPdf(b, "lane");
  submitStatus = 404;
  t.after(() => { submitStatus = 202; });
  const retry = new Map();
  for (let i = 0; i < 3; i++) assert.equal(await convertOne(db, srv.galleryDir, await rowOf(id), retry), "backoff-lane");
  const row = await rowOf(id);
  assert.equal("pdf_text_error" in row.payload, false, "nothing parked");
  assert.equal(row.awaiting_pdf_text, true, "still waiting for its read");
  assert.equal(retry.has(id), false, "the extractor's trouble costs this PDF no attempt");
  const jobs = await jobsOf(id);
  assert.equal(jobs.length, 1, "three waits are one story, not three rows");
  assert.deepEqual([jobs[0].outcome, jobs[0].detail.attempts], ["requeued", 3]);
  assert.match(jobs[0].error, /older than the app/);
});

test("a read that lands after its item was deleted leaves no text behind, and cleanup takes the text with its file", async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-gone");
  const { id, name } = await seedPdf(b, "gone");
  scripts.set("gone", [finished("too late")]);
  const row = await rowOf(id); // the read job's snapshot
  await db.query("DELETE FROM items WHERE id=$1", [id]); // deleted while the extractor read it
  assert.equal(await convertOne(db, srv.galleryDir, row, new Map()), "gone");
  assert.equal(fs.existsSync(path.join(srv.galleryDir, name + ".md")), false, "no orphaned text");

  // The ordinary way out: the item goes, and its files go with it.
  const sources = createSources({ galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
  fs.writeFileSync(path.join(srv.galleryDir, "kept2.pdf.md"), "text");
  sources.cleanup([{ name: "kept2.pdf", kind: "pdf" }]);
  assert.equal(fs.existsSync(path.join(srv.galleryDir, "kept2.pdf.md")), false);
});

// --- the queue ---

test("a PDF waits unclaimed for its text, then claims — untouched meanwhile", async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-claim");
  const tag = await seedPdf(b, "claim-tag", { status: "pending" });
  const extract = await seedPdf(b, "claim-extract", { status: "pending_extract" });
  const image = await seedInstance(db, b, "pending", { payload: { files: [{ name: "i.png", kind: "image" }] } });

  const first = await claimFairBatch(db, true, undefined, 10, [], [b]);
  assert.deepEqual(first.map((r) => r.id), [image.id], "only the item whose input exists");
  const { rows } = await db.query(
    "SELECT status, attempts, retry_at FROM items WHERE id = ANY($1) ORDER BY id", [[tag.id, extract.id]]);
  assert.deepEqual(rows, [
    { status: "pending", attempts: 0, retry_at: null },
    { status: "pending_extract", attempts: 0, retry_at: null },
  ], "left queued, not claimed — so not holding its file in memory either");

  // Text landed, or a parked read: either is an answer.
  await db.query(`UPDATE items SET payload = payload || '{"pdf_text": {"chars": 0}}' WHERE id=$1`, [tag.id]);
  await db.query(`UPDATE items SET payload = payload || '{"pdf_text_error": ""}' WHERE id=$1`, [extract.id]);
  const second = await claimFairBatch(db, true, undefined, 10, [], [b]);
  assert.deepEqual(second.map((r) => [r.id, r.status]).sort(), [[tag.id, "processing"], [extract.id, "extracting"]].sort());
});

test("the read job takes queued PDFs missing their text, boards taking turns", async () => {
  await fresh();
  // Board ids are random. A is whichever sorts first, so the cursor starts on it
  // and B's PDF must come second — and its three PDFs are all older than B's one.
  const [a, b] = await boardsInIdOrder(await seedBoard(db, "turns-1"), await seedBoard(db, "turns-2"));
  const a1 = await seedPdf(a, "turn-a1", { age: 40000 });
  const a2 = await seedPdf(a, "turn-a2", { age: 30000 });
  const a3 = await seedPdf(a, "turn-a3", { age: 20000, status: "pending_extract" });
  const b1 = await seedPdf(b, "turn-b1", { age: 1000 });
  // Not for reading: not queued for a step, or already answered.
  await seedPdf(a, "turn-held", { status: "held", age: 50000 });
  await seedPdf(a, "turn-tagged", { status: "tagged", age: 50000 });
  await seedPdf(a, "turn-failed", { status: "failed", age: 50000 });
  await seedPdf(a, "turn-read", { extra: { pdf_text: { chars: 3 } }, age: 50000 });
  await seedPdf(a, "turn-parked", { extra: { pdf_text_error: "x" }, age: 50000 });

  // As the kind does it: one read at a time, the cursor on the board read last.
  const order = [];
  let after = null;
  for (let i = 0; i < 4; i++) {
    const [next] = await pdfsNeedingText(db, order, after, 1);
    order.push(next.id);
    after = next.board_id;
  }
  assert.deepEqual(await pdfsNeedingText(db, order, after, 8), [], "nothing else qualifies");
  assert.deepEqual(order, [a1.id, b1.id, a2.id, a3.id],
    "board B's PDF second, not after all of A's; oldest first within a board");

  // A paused board's PDFs wait, like every other spend.
  await db.query("UPDATE boards SET paused=TRUE WHERE id=$1", [b]);
  assert.deepEqual((await pdfsNeedingText(db, [], null, 8)).map((r) => r.id), [a1.id, a2.id, a3.id]);
});

test("PDFs waiting for their text count under PDF to text, not under the step that will take them", async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-lanes");
  await seedPdf(b, "lane-tag", { status: "pending" });
  await seedPdf(b, "lane-extract", { status: "pending_extract" });
  await seedPdf(b, "lane-held", { status: "held" }); // read only once queued again
  await seedPdf(b, "lane-ready", { status: "pending", extra: { pdf_text: { chars: 5 } } }); // the tag leg's to take
  const being = await seedPdf(b, "lane-running", { status: "pending" }); // its read's running row names it

  assert.deepEqual(await boardLaneQueues(db, b, [{ kind: "convert" }]), [{ kind: "convert", n: 3, pull: 3 }]);
  assert.deepEqual(await boardLaneQueues(db, b, [{ kind: "convert" }], [being.id]), [{ kind: "convert", n: 2, pull: 2 }],
    "a PDF being read is running, not also waiting");
  assert.deepEqual((await pipelineWork(db, b, [])).queued, [{ kind: "tag", n: 1 }], "only the PDF with its text waits on tagging");

  // On the wire, labelled from the kind vocabulary.
  const { sid } = await adminSession(db);
  const { json } = await req(srv.base, "GET", `/api/boards/${b}/jobs/errors`, { sid });
  const lane = json.work.queued.find((q) => q.kind === "convert");
  assert.deepEqual([lane.n, lane.label, lane.pull], [3, "PDF to text", 3]);
});

test("with the switch off, an unread PDF is its step's to take — unless a step asked for its text", async (t) => {
  // Off, a step sends the file itself where its provider reads one, so no PDF
  // waits for a read until a step asks (planning/pdf-conversion-plan.md, C4).
  await fresh();
  const b = await seedBoard(db, "pdf-switch-off");
  const tag = await seedPdf(b, "off-tag", { status: "pending" });
  const extract = await seedPdf(b, "off-extract", { status: "pending_extract" });
  const asked = await seedPdf(b, "off-asked", { status: "pending", extra: { pdf_text_wanted: true } });

  assert.deepEqual((await pdfsNeedingText(db, [], null, 8, false)).map((r) => r.id), [asked.id], "read: only the one a step asked about");
  assert.deepEqual(await boardLaneQueues(db, b, [{ kind: "convert", all: false }]), [{ kind: "convert", n: 1, pull: 1 }]);
  const waits = Object.fromEntries((await pipelineWork(db, b, [], false)).queued.map((q) => [q.kind, q.n]));
  assert.deepEqual(waits, { tag: 1, extract: 1 }, "the rest wait on their step");
  // On, every unread PDF is the read's, as before.
  assert.equal((await pdfsNeedingText(db, [], null, 8, true)).length, 3);
  assert.deepEqual((await pipelineWork(db, b, [], true)).queued, []);

  // On the wire, off the PDF card's own switch.
  await setPluginState(db, "media:pdf", { config: { convert: false } });
  t.after(() => setPluginState(db, "media:pdf", { config: {} }));
  const { sid } = await adminSession(db);
  const { json } = await req(srv.base, "GET", `/api/boards/${b}/jobs/errors`, { sid });
  assert.equal(json.work.queued.find((q) => q.kind === "convert")?.n, 1, "PDF to text: the asked one");
  assert.equal(json.work.queued.find((q) => q.kind === "tag")?.n, 1, "tagging: the unread one no step asked about");

  // The claim takes the two, and holds the asked one for its text.
  const claimed = await claimFairBatch(db, true, undefined, 10, [], [b], false);
  assert.deepEqual(claimed.map((r) => r.id).sort(), [tag.id, extract.id].sort());
});

test("asking for a PDF's text puts it back with no retry wait; the claim holds it until the text lands", async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-ask");
  const pdf = await seedPdf(b, "ask-me", { status: "pending" });
  const [claimed] = await claimFairBatch(db, true, undefined, 10, [], [b], false);
  assert.equal(claimed.id, pdf.id, "the switch is off: a step takes it unread");

  assert.equal(await askPdfText(db, pdf.id, "pending"), true);
  const row = await rowOf(pdf.id);
  assert.deepEqual([row.status, row.retry_at, row.attempts, row.payload.pdf_text_wanted, row.pdf_text_wanted],
    ["pending", null, 0, true, true], "back in its queue: no retry to wait out, no attempt spent");
  assert.deepEqual(await claimFairBatch(db, true, undefined, 10, [], [b], false), [], "held until its text lands");
  assert.deepEqual((await pdfsNeedingText(db, [], null, 8, false)).map((r) => r.id), [pdf.id], "and read");

  await db.query(`UPDATE items SET payload = payload || '{"pdf_text": {"chars": 5}}' WHERE id=$1`, [pdf.id]);
  assert.deepEqual((await claimFairBatch(db, true, undefined, 10, [], [b], false)).map((r) => r.id), [pdf.id],
    "taken the moment its text lands");
  // Fenced on the step it was claimed for: a row moved meanwhile stays put.
  assert.equal(await askPdfText(db, pdf.id, "pending_extract"), false);
  assert.equal((await rowOf(pdf.id)).status, "processing");
});

test("reprocess and re-extract give a parked read another go; kept text stays", async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-again");
  const mapping = { fields: [{ key: "name", source: "extract" }] };
  const parked = await seedPdf(b, "again-parked", { status: "tagged", extra: { pdf_text_error: "gave up after 5 attempts" } });
  const parkedToo = await seedPdf(b, "again-parked2", { status: "tagged", extra: { pdf_text_error: "x", mapping } });
  const read = await seedPdf(b, "again-read", { status: "tagged", extra: { pdf_text: { chars: 9 } } });

  await reprocessEntity(db, parked.eid);
  await reextractItem(db, parkedToo.id);
  await reprocessEntity(db, read.eid);
  for (const { id } of [parked, parkedToo]) {
    const row = await rowOf(id);
    assert.equal("pdf_text_error" in row.payload, false, "the parked error is dropped");
    assert.equal(row.awaiting_pdf_text, true, "so it is read again");
  }
  const kept = await rowOf(read.id);
  assert.deepEqual([kept.payload.pdf_text, kept.awaiting_pdf_text], [{ chars: 9 }, false], "a good read is kept");
});

// --- reprocess's re-read rule (Stage 2) ---

test("reprocess reads a PDF again only when today's page setting would read pages it skipped", async () => {
  await fresh();
  const b = await seedBoard(db, "pdf-reread");
  const item = await seedPdf(b, "reread", { status: "tagged" });
  // A kept read of a 40-page scan: `ocr_pages` read by OCR, the rest skipped.
  const read = (ocrPages, skipped) => db.query("UPDATE items SET payload = payload || $1 WHERE id=$2", [
    JSON.stringify({ pdf_text: { pages: 40, text_pages: 0, ocr_pages: ocrPages, skipped, ocr_failed: [], chars: 99, ocr_limit: ocrPages, lang: "eng", at: 1 } }),
    item.id]);
  const readAgain = async (pdfRead) => {
    await reprocessEntity(db, item.eid, null, pdfRead);
    return (await rowOf(item.id)).awaiting_pdf_text;
  };
  const cases = [
    // [what the last read did, today's setting, read again?, why]
    [[20, [[21, 40]]], { ocrPages: null }, true, "pages were skipped, and every page is wanted"],
    [[20, [[21, 40]]], { ocrPages: 30 }, true, "a higher limit reads more"],
    [[20, [[21, 40]]], { ocrPages: 20 }, false, "the same limit reads the same"],
    [[20, [[21, 40]]], { ocrPages: 5 }, false, "a lower limit would read less"],
    [[20, [[21, 40]]], null, false, "today's setting unknown: never"],
    [[0, [[1, 40]]], { ocrPages: 3 }, true, "OCR was off, and now it isn't"],
    [[0, [[1, 40]]], { ocrPages: 0 }, false, "OCR still off"],
    [[0, []], { ocrPages: null }, false, "nothing was skipped: the same text again"],
    [[0, []], { ocrPages: 3 }, false, "nothing was skipped: a higher limit reads the same"],
    [[20, [[21, 40]]], { ocrPages: 3000000000 }, true, "a limit past a 4-byte integer still compares"],
  ];
  for (const [[ocrPages, skipped], pdfRead, expected, why] of cases) {
    await read(ocrPages, skipped);
    assert.equal(await readAgain(pdfRead), expected, why);
  }
  // The board form, the same rule.
  await read(20, [[21, 40]]);
  await reprocessBoard(db, b, null, { ocrPages: null });
  assert.equal((await rowOf(item.id)).awaiting_pdf_text, true);
});

test("reprocess reads a PDF again in another language only where OCR read, or failed on, some of it", async () => {
  // pdf-conversion-plan.md Stage 4: a page read from its text layer reads the
  // same in any language, so a text PDF keeps its text; OCR'd pages don't.
  await fresh();
  const b = await seedBoard(db, "pdf-relang");
  const item = await seedPdf(b, "relang", { status: "tagged" });
  const read = (stamp) => db.query("UPDATE items SET payload = (payload - 'pdf_text') || $1 WHERE id=$2", [
    JSON.stringify({ pdf_text: { pages: 3, text_pages: 0, ocr_pages: 0, skipped: [], ocr_failed: [], chars: 99, ocr_limit: null, at: 1, ...stamp } }),
    item.id]);
  const readAgain = async (pdfRead) => {
    await reprocessEntity(db, item.eid, null, pdfRead);
    return (await rowOf(item.id)).awaiting_pdf_text;
  };
  const cases = [
    // [the last read, today's settings, read again?, why]
    [{ ocr_pages: 3, lang: "eng" }, { ocrPages: null, ocrLang: "fra" }, true, "OCR read it in English, and French is wanted"],
    [{ ocr_pages: 3, lang: "fra" }, { ocrPages: null, ocrLang: null }, true, "…and back to English"],
    [{ ocr_pages: 3, lang: "fra" }, { ocrPages: null, ocrLang: "fra" }, false, "already read in French"],
    [{ text_pages: 3, lang: "eng" }, { ocrPages: null, ocrLang: "fra" }, false, "no OCR: the same text in any language"],
    [{ ocr_failed: [[1, 3]], lang: "eng" }, { ocrPages: null, ocrLang: "fra" }, true, "OCR failed on its pages: another language is another go"],
    [{ ocr_pages: 3 }, { ocrPages: null, ocrLang: "fra" }, true, "a stamp naming no language was read in English"],
    [{ ocr_pages: 3 }, { ocrPages: null, ocrLang: null }, false, "…which is today's"],
    [{ ocr_pages: 3, lang: "eng" }, null, false, "today's settings unknown: never"],
    // Another language re-reads only where today's limit reads as many pages by
    // OCR: a re-read with OCR off, or a lower limit, would lose text it has.
    [{ ocr_pages: 3, lang: "fra" }, { ocrPages: 0, ocrLang: null }, false, "OCR off now: the French text stays"],
    [{ pages: 40, ocr_pages: 40, lang: "eng" }, { ocrPages: 5, ocrLang: "fra" }, false, "a lower limit would read 5 of its 40 pages"],
    [{ ocr_pages: 3, lang: "eng" }, { ocrPages: 3, ocrLang: "fra" }, true, "a limit that reads as many pages"],
    [{ ocr_failed: [[1, 3]], lang: "eng" }, { ocrPages: 0, ocrLang: "fra" }, false, "OCR off: no page would be read in French"],
    [{ ocr_failed: [[1, 3]], lang: "eng" }, { ocrPages: 1, ocrLang: "fra" }, true, "…one page by OCR is another go"],
  ];
  for (const [stamp, pdfRead, expected, why] of cases) {
    await read(stamp);
    assert.equal(await readAgain(pdfRead), expected, why);
  }
});

test("both reprocess buttons pass the PDF card's own setting", async (t) => {
  await fresh();
  const b = await seedBoard(db, "pdf-reroute");
  const item = await seedPdf(b, "reroute", { status: "tagged" });
  // A read that OCR'd 2 pages and skipped the rest: the card at 2 keeps it, at
  // 3 reads it again — so a route passing anything but the card's value shows.
  const skippedRead = () => db.query("UPDATE items SET payload = payload || $1 WHERE id=$2", [
    JSON.stringify({ pdf_text: { pages: 9, ocr_pages: 2, skipped: [[3, 9]], ocr_failed: [], chars: 5, ocr_limit: 2, lang: "eng", at: 1 } }),
    item.id]);
  const { sid } = await adminSession(db);
  const card = (ocrPages) => setPluginState(db, "media:pdf", { config: { ocrPages } });
  t.after(() => setPluginState(db, "media:pdf", { config: {} }));
  const buttons = [
    ["the card's reprocess", `/api/items/${item.eid}/reprocess`],
    ["the board's reprocess", `/api/admin/boards/${b}/reprocess`],
  ];
  for (const [which, route] of buttons) {
    for (const [ocrPages, again] of [[2, false], [3, true]]) {
      await skippedRead();
      await card(ocrPages);
      assert.equal((await req(srv.base, "POST", route, { sid })).status, 200);
      assert.equal((await rowOf(item.id)).awaiting_pdf_text, again, `${which}, the card at ${ocrPages}`);
    }
  }

  // Any whole number the card takes, past a 4-byte integer too, and on a card
  // with no PDF at all: the setting rides every reprocess.
  const image = await seedInstance(db, b, "tagged", { payload: { files: [{ name: "i.png", kind: "image" }] } });
  await card(3000000000);
  assert.equal((await req(srv.base, "POST", `/api/items/${image.eid}/reprocess`, { sid })).status, 200);
});
