// PDF reading through a live worker (planning/pdf-conversion-plan.md, Stage 1b).
// Every step used to send the whole PDF to the extractor and wait, one call per
// step per pass, and a queue of PDFs was claimed at once, each holding its file
// in memory and a tagging slot while it waited its turn. Now each PDF is read
// once, in its own job, one at a time with boards taking turns, and the steps
// take it only once its text has landed.
//
// POLL_MS is a minute on purpose: a step inside the windows below can only come
// from a landing's wake, never from a poll. A stand-in extractor holds each read
// until the test releases it, the way audio-handoff-worker.test.js holds
// whisper's jobs, and a stand-in Anthropic answers whatever it is asked.
//
// Its own file for the reason that one is: a live worker and the env it reads
// stay contained in one process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startServer, until } from "./helpers.js";
import { createBoard, createEntity, insertItem, setSetting, setPluginState, retagItem, reextractItem } from "../server/db.js";
import { startWorker } from "../server/worker.js";

let srv, db, stopWorker, extractor, ai;
const released = new Set(); // reads allowed to finish
// Every read finishes from here on — set before any worker stop, so a test that
// fails while a read is held fails instead of hanging on the drain.
let draining = false;
const submits = []; // every PDF the extractor was sent, in order (a job's id is its bytes)
const limits = []; // each submit's X-OCR-Pages, beside it
const prompts = []; // every AI request: { tool, text }
const boards = {};
const ids = {};

const serve = (handler) => {
  const server = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      rs.setHeader("Content-Type", "application/json");
      handler(rq, rs, Buffer.concat(chunks).toString());
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
};
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

before(async () => {
  // A held read keeps finishing pages, so the reader's stall check stays quiet.
  let page = 0;
  extractor = await serve((rq, rs, body) => {
    if (rq.method === "POST") {
      submits.push(body);
      limits.push(rq.headers["x-ocr-pages"]);
      rs.statusCode = 202;
      return rs.end(JSON.stringify({ job: body, status: "queued" }));
    }
    const job = rq.url.match(/^\/jobs\/(.+)$/)?.[1];
    if (!released.has(job) && !draining) return rs.end(JSON.stringify({ status: "running", progress: { pages_done: ++page, pages_total: 1e6 } }));
    const markdown = `The text of ${job}.`;
    rs.end(JSON.stringify({
      status: "done", progress: { pages_done: 1, pages_total: 1 }, markdown,
      report: { pages: 1, text_pages: 1, ocr_pages: 0, skipped: [], ocr_failed: [], chars: markdown.length },
    }));
  });
  ai = await serve((_rq, rs, body) => {
    const call = JSON.parse(body);
    const tool = call.tool_choice?.name || "record_tags";
    prompts.push({ tool, text: JSON.stringify(call.messages) });
    const input = tool === "record_fields"
      ? { note: { why: "stub", value: "noted" } }
      : { mood: { values: ["happy"], reasoning: "stub" } };
    rs.end(JSON.stringify({
      content: [{ type: "tool_use", id: "tu_stub", name: tool, input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  process.env.ANTHROPIC_BASE_URL = urlOf(ai);
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.POLL_MS = "60000";

  srv = await startServer();
  db = srv.db;
  process.env.EXTRACTOR_URL = urlOf(extractor); // read per call, so after the helpers' dead default
  await setSetting(db, "embed_enabled", "0"); // no on-device model load in this file
  await setPluginState(db, "media:pdf", { config: { ocrPages: 7 } }); // the PDF card's page setting

  const facets = [{ key: "mood", label: "Mood", single: false, values: ["happy", "sad"] }];
  // Board A extracts a field as well as tagging, so its PDFs pass through both
  // steps; board B only tags. A's three PDFs are all older than B's one. Board
  // ids are random, so A is whichever sorts first: the read job starts there,
  // and B's PDF must come second.
  const mapping = { fields: [{ key: "note", kind: "text", source: "extract" }] };
  const made = [
    await createBoard(db, "Turns 1", facets, "", true, null, null, { enabled: true }, false, { mapping }),
    await createBoard(db, "Turns 2", facets, "", true, null, null, { enabled: true }, false, { mapping }),
  ];
  [boards.a, boards.b] = (await db.query("SELECT id FROM boards WHERE id = ANY($1) ORDER BY id", [made])).rows.map((r) => r.id);
  await db.query("UPDATE boards SET mapping=NULL WHERE id=$1", [boards.b]);
  const pdf = async (board, body, age, extra = {}) => {
    const name = `${body}.pdf`;
    fs.writeFileSync(path.join(srv.galleryDir, name), body);
    const eid = await createEntity(db, board, { identity: name });
    const id = await insertItem(db, board,
      { identity: name, files: [{ name, original_name: name, kind: "pdf" }], fields: {}, ...extra },
      extra.mapping ? "pending_extract" : "pending", eid);
    await db.query("UPDATE items SET created_at=$1 WHERE id=$2", [Date.now() - age, id]);
    return id;
  };
  ids.a1 = await pdf(boards.a, "pdf-a1", 40000, { mapping });
  ids.a2 = await pdf(boards.a, "pdf-a2", 30000, { mapping });
  ids.a3 = await pdf(boards.a, "pdf-a3", 20000, { mapping });
  ids.b1 = await pdf(boards.b, "pdf-b1", 1000);
  // A file-less row queued beside them: once it is tagged, the tag leg has run
  // a claim that could have taken the PDFs and didn't.
  const eid = await createEntity(db, boards.b, { identity: "control" });
  ids.control = await insertItem(db, boards.b, { identity: "control", files: [], fields: {} }, "pending", eid);

  stopWorker = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
});

after(async () => {
  draining = true;
  await stopWorker?.();
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "POLL_MS", "EXTRACTOR_URL"]) delete process.env[k];
  await new Promise((r) => extractor.close(r));
  await new Promise((r) => ai.close(r));
  await srv.close();
});

const PDFS = () => [ids.a1, ids.a2, ids.a3, ids.b1];
const bodyOf = (id) => `pdf-${Object.keys(ids).find((k) => ids[k] === id)}`;
const row = async (id) => (await db.query(
  "SELECT status, attempts, retry_at, payload ? 'pdf_text' AS has_text FROM items WHERE id=$1", [id])).rows[0];
const legRuns = async (kind, id) => Number((await db.query(
  "SELECT COUNT(*) AS n FROM job_log WHERE kind=$1 AND outcome='ok' AND item_id=$2", [kind, id])).rows[0].n);
const told = (text, tool = "record_tags") => prompts.some((p) => p.tool === tool && p.text.includes(text));

test("PDFs stay queued while one is read; it is taken the moment its text lands, and tagged from it", async () => {
  await until(async () => (await row(ids.control)).status === "tagged", 15000);
  await until(() => submits.length === 1, 5000);
  // Hold the first read a moment longer: nothing else may start, or be claimed.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(submits.length, 1, "one read at a time across the app");
  assert.equal(limits[0], "7", "read with the PDF card's page setting");
  // Not even started and left waiting for the extractor: that would hold the
  // PDF in memory and show it converting while it only waits.
  const { rows: converting } = await db.query("SELECT item_id FROM job_log WHERE kind='convert' AND outcome='running'");
  assert.equal(converting.length, 1, "one PDF converting");
  for (const id of PDFS()) {
    const r = await row(id);
    assert.deepEqual([r.attempts, r.retry_at, r.has_text], [0, null, false], `#${id} untouched while it waits`);
    assert.ok(["pending", "pending_extract"].includes(r.status), `#${id} still queued, so not holding its file (${r.status})`);
  }
  assert.equal(prompts.some((p) => p.text.includes("pdf-")), false, "no step has seen a PDF yet");

  const first = submits[0];
  const id = PDFS().find((i) => bodyOf(i) === first);
  released.add(first);
  // Inside the minute's poll: only the landing's wake can have done it.
  await until(async () => (await row(id)).status === "tagged", 5000);
  assert.ok(told(`The text of ${first}.`), "tagged from the kept text");
  if (id !== ids.b1) assert.ok(told(`The text of ${first}.`, "record_fields"), "and its field extracted from it");
});

// The most convert rows running at once over a short while. A PDF started while
// another holds the extractor shows here as a second one, opened and waiting.
async function mostConverting(ms = 500) {
  let most = 0;
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 25))) {
    const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM job_log WHERE kind='convert' AND outcome='running'");
    most = Math.max(most, rows[0].n);
  }
  return most;
}

test("boards take turns: board B's PDF is read second, not after all of A's", async () => {
  for (let n = 2; n <= 4; n++) {
    await until(() => submits.length === n, 5000);
    // A landing wakes the read job twice (its own wake, then its run settling),
    // and the second tick must find the extractor taken, not free.
    assert.equal(await mostConverting(), 1, `one PDF converting after read ${n - 1} landed`);
    released.add(submits[n - 1]);
  }
  for (const id of PDFS()) await until(async () => (await row(id)).status === "tagged", 5000);
  assert.deepEqual(submits, ["pdf-a1", "pdf-b1", "pdf-a2", "pdf-a3"], "B second; oldest first within a board");
});

test("retag and re-extract use the kept text: the extractor sees one submit per PDF, ever", async () => {
  for (const id of PDFS()) await retagItem(db, id);
  for (const id of [ids.a1, ids.a2, ids.a3]) await reextractItem(db, id);
  // The buttons behind those verbs leave the pickup to the worker's poll, and
  // this file's is a minute (the first test's point), so a worker at the usual
  // pace takes over — a fresh one, which must not read anything again either.
  draining = true;
  await stopWorker();
  process.env.POLL_MS = "200";
  stopWorker = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });

  for (const id of PDFS()) await until(async () => (await legRuns("tag", id)) >= 2, 8000);
  for (const id of [ids.a1, ids.a2, ids.a3]) await until(async () => (await legRuns("extract", id)) >= 2, 8000);
  assert.deepEqual([...submits].sort(), ["pdf-a1", "pdf-a2", "pdf-a3", "pdf-b1"], "each PDF read once, ever");
  const retold = (body) => prompts.filter((p) => p.tool === "record_tags" && p.text.includes(`The text of ${body}.`)).length;
  for (const body of ["pdf-a1", "pdf-a2", "pdf-a3", "pdf-b1"]) assert.ok(retold(body) >= 2, `${body} retagged from its kept text`);
  // "Convert PDFs to text" is on (the default): every step got the text, so no
  // step asked for a read and none sent a file — though Anthropic reads them
  // (planning/pdf-conversion-plan.md, Stage 3).
  assert.equal(prompts.some((p) => p.text.includes('"type":"document"')), false, "never the file");
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM items WHERE pdf_text_wanted");
  assert.equal(rows[0].n, 0, "no step asked for a read");
  const { rows: told } = await db.query(
    "SELECT DISTINCT detail->'pdf' AS pdf FROM job_log WHERE kind IN ('tag', 'extract') AND outcome='ok' AND item_id = ANY($1)", [PDFS()]);
  assert.deepEqual(told.map((r) => r.pdf), [{ as: "text" }], "every row: the text, as the switch says");
});
