// Extracted fields are embedded, once for a normal upload and twice when its
// tags wait — through a live worker (planning/field-embedding-plan.md Stage 1,
// D2). A stand-in Anthropic extracts and tags (audio-handoff-worker.test.js's
// pattern); the embedder is OpenAI's, stubbed at fetch, and every text it is
// sent is recorded.
//
// When a step lands it wakes the other steps, and the embed sweep isn't one of
// them: it looks on its own poll. So an extraction landing is claimed by the
// tag step within milliseconds (6 ms median in the compose app's job log), and
// the sweep finds the item claimed. A sweep left running through those
// milliseconds would make the first test a coin toss, so it switches the
// embedder on only once the tag call is in the air: the window the "no step
// holds it" rule is for.
//
// Its own file, like the other live-worker tests: a live worker and the env it
// reads stay contained in one process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer } from "./helpers.js";
import { createBoard, createEntity, insertItem, setSetting, setPluginState, createAiKey } from "../server/db.js";
import { startWorker } from "../server/worker.js";

const MAPPING = { fields: [{ key: "icon", source: "extract", kind: "text", instruction: "What icons are present?" }] };

let srv, db, boardId, stopWorker, ai, realFetch;
const embedded = []; // every text the embedder was sent, in order
let tagGate = null; // while set, the stand-in holds each tag call until it resolves
let failTags = false; // while true, the stand-in answers every tag call with a 503

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
const answer = (name, input) => JSON.stringify({
  content: [{ type: "tool_use", id: `tu_${name}`, name, input }],
  stop_reason: "tool_use",
  usage: { input_tokens: 1, output_tokens: 1 },
});

before(async () => {
  ai = await serve(async (_rq, rs, body) => {
    if (body.includes("record_fields")) {
      return rs.end(answer("record_fields", { icon: { why: "The sheet shows a red car.", value: "a red car" } }));
    }
    if (failTags) {
      rs.statusCode = 503;
      return rs.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "busy" } }));
    }
    if (tagGate) await tagGate;
    rs.end(answer("record_tags", { mood: { values: ["calm"], reasoning: "Muted colors." } }));
  });
  process.env.ANTHROPIC_BASE_URL = urlOf(ai);
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.POLL_MS = "200";

  srv = await startServer();
  db = srv.db;
  // The embedder is OpenAI's, never the on-device model, and it's off until a
  // test turns it on.
  await setSetting(db, "embed_enabled", "0");
  await setPluginState(db, "ai:openai", { installed: true });
  await setSetting(db, "embed_key_id", String(await createAiKey(db, "field-embed", "openai", "sk-test")));
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes("/embeddings")) return realFetch(url, opts);
    const { input } = JSON.parse(opts.body);
    embedded.push(...input);
    return { ok: true, status: 200, json: async () => ({
      data: input.map((_, i) => ({ index: i, embedding: [1, 0] })), usage: { prompt_tokens: input.length },
    }) };
  };

  boardId = await createBoard(db, "Field embed board",
    [{ key: "mood", label: "Mood", single: false, values: ["calm", "busy"] }], "", true, null, null, { enabled: true },
    false, { mapping: MAPPING });
  stopWorker = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
});

after(async () => {
  failTags = false;
  tagGate = null;
  await stopWorker?.();
  globalThis.fetch = realFetch;
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "POLL_MS"]) delete process.env[k];
  await new Promise((r) => ai.close(r));
  await srv.close();
});

async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`${what} — not within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const row = async (id) => (await db.query(
  "SELECT status, retry_at, embedding IS NOT NULL AS vec FROM items WHERE id=$1", [id])).rows[0];
// An upload as admission makes one on a board that extracts: queued for its
// extraction, the mapping stamped.
async function upload(identity) {
  const eid = await createEntity(db, boardId, { identity });
  return insertItem(db, boardId, { identity, files: [], fields: {}, mapping: MAPPING }, "pending_extract", eid);
}

test("a normal upload is embedded once, after its tags, from its fields and its tags", async () => {
  embedded.length = 0;
  let release;
  tagGate = new Promise((r) => { release = r; });
  try {
    const id = await upload("one");
    await until(async () => (await row(id)).status === "processing", 10000, "the tag call is in the air");
    await setSetting(db, "embed_enabled", "1");
    await pause(1500); // seven or so sweep ticks while the tag step holds the item
    assert.deepEqual(embedded, [], "nothing is embedded while a step holds the item, fields and all");

    release();
    await until(async () => (await row(id)).vec, 10000, "embedded after its tags landed");
    await pause(600); // a few more ticks, for a second embed that shouldn't come
    assert.equal(embedded.length, 1, "one embed");
    assert.match(embedded[0], /icon: a red car/, "from its fields");
    assert.match(embedded[0], /mood: calm/, "and its tags");
  } finally {
    release?.();
    tagGate = null;
    await setSetting(db, "embed_enabled", "0");
  }
});

test("while its tags wait in the queue an item is searchable from its fields, and its tags embed it again", async () => {
  // The tag call fails and the item waits out a retry, as it would behind a
  // backoff, a credit wait or a key that's gone. Waiting must not keep it out
  // of search (D2), and the tags landing must not leave the fields-only
  // vector standing.
  embedded.length = 0;
  failTags = true;
  await setSetting(db, "embed_enabled", "1");
  try {
    const id = await upload("two");
    await until(async () => (await row(id)).retry_at, 20000, "the tag call failed and the item waits to retry");
    await until(async () => (await row(id)).vec, 10000, "embedded while it waits");
    assert.equal(embedded.length, 1);
    assert.match(embedded[0], /icon: a red car/, "from its fields");
    assert.doesNotMatch(embedded[0], /mood/, "it has no tags yet");

    failTags = false;
    await db.query("UPDATE items SET retry_at=NULL WHERE id=$1", [id]); // the wait ends
    await until(async () => (await row(id)).status === "tagged", 10000, "tagged");
    await until(async () => (await row(id)).vec, 10000, "embedded again");
    assert.equal(embedded.length, 2, "the tags cost one more embed, no more");
    assert.match(embedded[1], /icon: a red car/);
    assert.match(embedded[1], /mood: calm/);
  } finally {
    failTags = false;
    await setSetting(db, "embed_enabled", "0");
  }
});
