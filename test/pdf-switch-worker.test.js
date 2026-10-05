// "Convert PDFs to text" switched off, through a live worker
// (planning/pdf-conversion-plan.md, Stage 3). Off, a step sends a PDF file
// itself to a provider that reads them and it fits, with no read at all; a
// provider that can't asks for the text, which is read and then sent; and a
// provider that refuses a file it declared it takes gets the text instead, in
// the same try once the text is there.
//
// A stand-in Claude reads PDF files (Anthropic declares them) and refuses one,
// as it refuses a PDF too long for the model; a stand-in OpenAI-compatible
// server stands for GLM, which can't read them, and for OpenAI, which reads
// them as its `file` part (Stage 5); a stand-in extractor reads every PDF at
// once. Its own file for the reason pdf-text-worker.test.js has one: a live
// worker and the env it reads stay contained in one process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startServer, until } from "./helpers.js";
import { createBoard, createEntity, insertItem, setSetting, setPluginState, createAiKey } from "../server/db.js";
import { startWorker } from "../server/worker.js";

let srv, db, stopWorker, extractor, claude, openai, pdf, claudeBoard;
const submits = []; // every PDF the extractor was sent (its body is the PDF's bytes)
const claudeCalls = []; // { tool, file: the PDF a document block carried, or null, text }
const openaiCalls = []; // { tool, text, file: the PDF a file part carried, or null, filename }
const ids = {};
// Claude's board tags and extracts a field, so its PDFs pass through both steps.
const mapping = { fields: [{ key: "note", kind: "text", source: "extract" }] };
const flip = { done: false, seen: null }; // the switch turned on during a call (the last test)

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
const answerFor = (tool) => (tool === "record_fields"
  ? { note: { why: "stub", value: "noted" } }
  : { mood: { values: ["happy"], reasoning: "stub" } });
const TOO_LONG = "prompt is too long: 215000 tokens > 200000 maximum";
const BROKE = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const refuse = (rs, message) => {
  rs.statusCode = 400;
  rs.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
};

before(async () => {
  extractor = await serve((rq, rs, body) => {
    if (rq.method === "POST") {
      submits.push(body);
      rs.statusCode = 202;
      return rs.end(JSON.stringify({ job: body, status: "queued" }));
    }
    const job = decodeURIComponent(rq.url.slice("/jobs/".length));
    const markdown = `The text of ${job}.`;
    rs.end(JSON.stringify({
      status: "done", progress: { pages_done: 1, pages_total: 1 }, markdown,
      report: { pages: 1, text_pages: 1, ocr_pages: 0, skipped: [], ocr_failed: [], chars: markdown.length },
    }));
  });
  claude = await serve((_rq, rs, body) => {
    const call = JSON.parse(body);
    const tool = call.tool_choice?.name || "record_tags";
    const doc = call.messages[0].content.find((b) => b.type === "document");
    const file = doc ? Buffer.from(doc.source.data, "base64").toString() : null;
    const text = JSON.stringify(call.messages);
    claudeCalls.push({ tool, file, text });
    if (file === "pdf-dense") return refuse(rs, TOO_LONG);
    // An empty balance refuses every call, its file or its text.
    if (text.includes("pdf-broke")) return refuse(rs, BROKE);
    if (file === "pdf-flip" && !flip.done) {
      // The switch turned on while this call is out. The worker's maintenance
      // pass reads it, and its read job then takes the probe: a PDF no step
      // asked about, that no claim can take.
      flip.done = true;
      return (async () => {
        await setPluginState(db, "media:pdf", { config: {} });
        flip.seen = await until(() => submits.includes("pdf-probe"), 5000).then(() => true, () => false);
        refuse(rs, TOO_LONG);
      })();
    }
    rs.end(JSON.stringify({
      content: [{ type: "tool_use", id: "tu_stub", name: tool, input: answerFor(tool) }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  openai = await serve((_rq, rs, body) => {
    const call = JSON.parse(body);
    const tool = call.tools?.[0]?.function?.name || "record_tags";
    const part = call.messages.at(-1).content.find?.((p) => p.type === "file")?.file;
    const data = part?.file_data?.match(/^data:application\/pdf;base64,(.*)$/)?.[1];
    openaiCalls.push({ tool, text: JSON.stringify(call.messages), file: data ? Buffer.from(data, "base64").toString() : null, filename: part?.filename });
    rs.end(JSON.stringify({
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c1", type: "function", function: { name: tool, arguments: JSON.stringify(answerFor(tool)) } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  process.env.ANTHROPIC_BASE_URL = urlOf(claude);
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.POLL_MS = "200";

  srv = await startServer();
  db = srv.db;
  process.env.EXTRACTOR_URL = urlOf(extractor); // read per call, so after the helpers' dead default
  await setSetting(db, "embed_enabled", "0"); // no on-device model load in this file
  await setPluginState(db, "media:pdf", { config: { convert: false } }); // the switch, off
  await setPluginState(db, "ai:openai", { installed: true });
  await setPluginState(db, "ai:glm", { installed: true });

  const facets = [{ key: "mood", label: "Mood", single: false, values: ["happy", "sad"] }];
  // The GLM and OpenAI boards, each pinned to its own key on the stand-in, only tag.
  claudeBoard = await createBoard(db, "Reads files", facets, "", true, null, null, { enabled: true }, false, { mapping });
  const glmKey = await createAiKey(db, "stand-in", "glm", "glm-test", urlOf(openai));
  const glmBoard = await createBoard(db, "Reads text", facets, "", true, glmKey, null, { enabled: true });
  const openaiKey = await createAiKey(db, "stand-in", "openai", "sk-test", urlOf(openai));
  const openaiBoard = await createBoard(db, "OpenAI reads files", facets, "", true, openaiKey, null, { enabled: true });
  pdf = async (board, body, extra = {}, status = extra.mapping ? "pending_extract" : "pending") => {
    const name = `${body}.pdf`;
    fs.writeFileSync(path.join(srv.galleryDir, name), body);
    const eid = await createEntity(db, board, { identity: name });
    return insertItem(db, board,
      { identity: name, files: [{ name, original_name: name, kind: "pdf", size: body.length, meta: { pages: 3 } }], fields: {}, ...extra },
      status, eid);
  };
  ids.file = await pdf(claudeBoard, "pdf-file", { mapping });
  ids.dense = await pdf(claudeBoard, "pdf-dense", { mapping });
  ids.text = await pdf(glmBoard, "pdf-text");
  ids.openai = await pdf(openaiBoard, "pdf-openai");

  stopWorker = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
});

after(async () => {
  await stopWorker?.();
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "POLL_MS", "EXTRACTOR_URL"]) delete process.env[k];
  for (const s of [extractor, claude, openai]) await new Promise((r) => s.close(r));
  await srv.close();
});

const rowsOf = async (kind, id) => (await db.query(
  "SELECT outcome, detail FROM job_log WHERE kind=$1 AND item_id=$2 ORDER BY id", [kind, id])).rows;
// Its tag row, not its status: the landing writes the status, then the row.
const tagged = (id) => until(async () => (await rowsOf("tag", id)).some((r) => r.outcome === "ok"), 15000);

test("a provider that reads PDF files gets the file for both steps, and nothing is read", async () => {
  await tagged(ids.file);
  const calls = claudeCalls.filter((c) => c.file === "pdf-file");
  assert.deepEqual(calls.map((c) => c.tool).sort(), ["record_fields", "record_tags"], "both steps sent the file itself");
  assert.equal(submits.includes("pdf-file"), false, "the extractor never saw it");
  for (const kind of ["extract", "tag"]) {
    const rows = await rowsOf(kind, ids.file);
    assert.deepEqual(rows.map((r) => [r.outcome, r.detail.pdf]), [["ok", { as: "file" }]], kind);
  }
});

test("a provider that can't read PDF files asks for the text, which is read once and sent, with no retry wait", async () => {
  // Fifteen seconds is well inside the minute a retry wait would add.
  await tagged(ids.text);
  assert.equal(submits.filter((s) => s === "pdf-text").length, 1, "read once");
  const { rows: [item] } = await db.query("SELECT attempts, payload FROM items WHERE id=$1", [ids.text]);
  assert.equal(item.payload.pdf_text_wanted, true, "marked as asked");
  assert.equal(item.attempts, 0, "asking spent no attempt");
  assert.ok(openaiCalls.some((c) => c.text.includes("The text of pdf-text.")), "tagged from its text");
  assert.equal(openaiCalls.some((c) => c.text.includes("pdf-text") && c.file != null), false, "never the file");
  assert.deepEqual((await rowsOf("tag", ids.text)).map((r) => [r.outcome, r.detail.pdf]),
    [["ok", { as: "text", why: "GLM can't read PDF files" }]]);
});

test("OpenAI gets the PDF file itself, named, and nothing is read", async () => {
  // pdf-conversion-plan.md Stage 5: OpenAI declares PDF files, which the
  // OpenAI-style wire sends as OpenAI's file part.
  await tagged(ids.openai);
  const calls = openaiCalls.filter((c) => c.file === "pdf-openai");
  assert.equal(calls.length, 1, "the file itself, once");
  assert.equal(calls[0].filename, "pdf-openai.pdf");
  assert.equal(submits.includes("pdf-openai"), false, "the extractor never saw it");
  assert.deepEqual((await rowsOf("tag", ids.openai)).map((r) => [r.outcome, r.detail.pdf]), [["ok", { as: "file" }]]);
});

test("a file the provider refuses goes as its text: asked for, then sent in the same try", async () => {
  await tagged(ids.dense);
  assert.equal(submits.filter((s) => s === "pdf-dense").length, 1, "read once, when the first refusal asked");
  const why = `Anthropic refused the file: ${TOO_LONG}`;
  for (const [kind, tool] of [["extract", "record_fields"], ["tag", "record_tags"]]) {
    assert.deepEqual((await rowsOf(kind, ids.dense)).map((r) => [r.outcome, r.detail.pdf]), [["ok", { as: "text", why }]],
      `${kind}: one row, no failure — the refusals cost no attempt`);
    const calls = claudeCalls.filter((c) => c.tool === tool && (c.file === "pdf-dense" || c.text.includes("The text of pdf-dense.")));
    assert.equal(calls.at(-1).file, null, `${kind}: its last call carried the text, not the file`);
  }
  const { rows: [item] } = await db.query("SELECT attempts FROM items WHERE id=$1", [ids.dense]);
  assert.equal(item.attempts, 0);
  // Refusing the file was the input's trouble, not Claude's: its card keeps no
  // error for it, even for the moment before the text went.
  const { rows: [health] } = await db.query("SELECT last_fail_at FROM plugins WHERE id='ai:anthropic'");
  assert.equal(health?.last_fail_at ?? null, null, "no failure recorded on the provider");
});

test("an account's refusal isn't the file's: the step waits on the account, with no ask and no read", async () => {
  // An empty balance is a 400 too, and its wire marks it a wait. Taken for the
  // file's refusal, it would ask for the text — reading every unread PDF while
  // the balance is empty — and then fail the text the same way.
  ids.broke = await pdf(claudeBoard, "pdf-broke", { mapping });
  const row = async () => (await db.query("SELECT attempts, retry_at, payload FROM items WHERE id=$1", [ids.broke])).rows[0];
  await until(async () => (await row()).retry_at != null, 15000);
  const item = await row();
  assert.ok(item.retry_at - Date.now() > 200e3, "the account's five-minute pace");
  assert.equal(item.payload.pdf_text_wanted, undefined, "not asked for its text");
  assert.equal(submits.includes("pdf-broke"), false, "not read");
  assert.equal(item.attempts, 0, "a wait, not a failure");
  assert.equal(claudeCalls.filter((c) => c.text.includes("pdf-broke")).length, 1, "one call: the file, and not then the text");
});

test("the switch turned on while the worker runs: the read job follows it, and a step goes by its claim's", async (t) => {
  t.after(() => setPluginState(db, "media:pdf", { config: { convert: false } }));
  // The probe: unread and queued, but held from every claim by a retry an hour
  // out, so only the read job can take it, and only once the worker has read
  // the switch on. Queued and held in one write, so no claim gets between.
  ids.probe = await pdf(claudeBoard, "pdf-probe", { mapping }, "tagged");
  await db.query("UPDATE items SET status='pending_extract', retry_at=$1 WHERE id=$2", [Date.now() + 3600e3, ids.probe]);
  // Claimed with the switch off, so it goes as the file; the switch is turned
  // on while Claude is answering, and then Claude refuses the file. The step
  // asks for the text by its claim's switch: with today's, on, it would meet an
  // unread PDF the claim can't have handed it, and wait out a minute.
  ids.flip = await pdf(claudeBoard, "pdf-flip", { mapping });
  await tagged(ids.flip);
  assert.equal(flip.seen, true, "the worker read the switch on while running: its read job took the probe");
  const { rows: [item] } = await db.query("SELECT attempts, payload FROM items WHERE id=$1", [ids.flip]);
  assert.equal(item.payload.pdf_text_wanted, true, "asked for its text by its claim's switch, off");
  assert.equal(item.attempts, 0);
  assert.equal(submits.filter((s) => s === "pdf-flip").length, 1, "read once");
  for (const kind of ["extract", "tag"])
    assert.deepEqual((await rowsOf(kind, ids.flip)).map((r) => [r.outcome, r.detail.pdf]), [["ok", { as: "text" }]], `${kind}: claimed again with the switch on, the text`);
});
