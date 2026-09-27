// The transcript → tag handoff, through a live worker (audio-tag-handoff-plan.md
// Stages 1-2). A clip used to be claimed by the tag leg before its transcript
// existed, bounced onto the 60s retry, and then sat out the rest of that minute
// after the transcript landed — nothing cleared the retry or woke the leg.
//
// POLL_MS is a minute here on purpose: a tag inside the 5s windows below can
// only come from the transcription kind's wake, never from a poll. A stand-in
// whisper holds each job until the test releases it, and a stand-in Anthropic
// tags whatever it is asked (alerts-worker.test.js's pattern).
//
// Its own file for the same reason alerts-worker.test.js is: a live worker and
// the env it reads stay contained in one process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startServer, primeSidecars } from "./helpers.js";
import { createBoard, createEntity, insertItem, setSetting } from "../server/db.js";
import { startWorker } from "../server/worker.js";

let srv, db, boardId, stopWorker, whisper, ai;
const released = new Set(); // whisper jobs allowed to finish
const prompts = []; // every tagging request body the stand-in AI saw
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
  // The job id is the clip's bytes ("speech" / "noise"). Held jobs report
  // advancing progress so the client's stall check stays quiet.
  let progress = 0;
  whisper = await serve((rq, rs, body) => {
    if (rq.method === "POST") { rs.statusCode = 202; return rs.end(JSON.stringify({ job: body })); }
    const job = rq.url.match(/^\/jobs\/(.+)$/)?.[1];
    if (!job) return rs.end(JSON.stringify({ model: "base" })); // /health
    if (!released.has(job)) return rs.end(JSON.stringify({ status: "running", progress: { done_s: ++progress } }));
    if (job === "speech") return rs.end(JSON.stringify({ status: "done", text: "hello from the clip", model: "stub" }));
    rs.end(JSON.stringify({ status: "failed", permanent: true, error: "undecodable" }));
  });
  ai = await serve((_rq, rs, body) => {
    prompts.push(body);
    rs.end(JSON.stringify({
      content: [{ type: "tool_use", id: "tu_stub", name: "record_tags",
        input: { mood: { values: ["happy"], reasoning: "stub" } } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  process.env.ANTHROPIC_BASE_URL = urlOf(ai);
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.POLL_MS = "60000";

  srv = await startServer();
  db = srv.db;
  primeSidecars();
  process.env.TRANSCRIBER_URL = urlOf(whisper);
  await setSetting(db, "embed_enabled", "0"); // no on-device model load in this file
  boardId = await createBoard(db, "Handoff board",
    [{ key: "mood", label: "Mood", single: false, values: ["happy", "sad"] }], "", true, null, null, { enabled: true });

  // Transcription takes the NEWEST clip first, so "noise" goes in first to
  // make "speech" the one the whisper slot holds during the first test.
  const clip = async (name, age) => {
    fs.writeFileSync(path.join(srv.galleryDir, `${name}.mp3`), name);
    const eid = await createEntity(db, boardId, { identity: name });
    const id = await insertItem(db, boardId,
      { identity: name, files: [{ name: `${name}.mp3`, original_name: `${name}.mp3`, kind: "audio" }], fields: {} }, "pending", eid);
    await db.query("UPDATE items SET created_at=$1 WHERE id=$2", [Date.now() - age, id]);
    return id;
  };
  ids.noise = await clip("noise", 20000);
  ids.speech = await clip("speech", 10000);
  // A file-less row queued beside them: once it is tagged, the tag leg has
  // run a claim that could have taken the clips and didn't.
  const eid = await createEntity(db, boardId, { identity: "control" });
  ids.control = await insertItem(db, boardId, { identity: "control", files: [], fields: {} }, "pending", eid);

  stopWorker = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
});

after(async () => {
  released.add("speech").add("noise"); // let any held job finish so the drain can't hang
  await stopWorker?.();
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "POLL_MS", "TRANSCRIBER_URL"]) delete process.env[k];
  await new Promise((r) => whisper.close(r));
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
const row = async (id) => (await db.query(
  "SELECT status, attempts, retry_at, error, payload ? 'transcript' AS has_text, payload ? 'transcript_error' AS parked FROM items WHERE id=$1", [id])).rows[0];

test("a clip is left alone while it transcribes, then tagged the moment its transcript lands", async () => {
  await until(async () => (await row(ids.control)).status === "tagged", 15000, "the control row was tagged");
  assert.deepEqual(await row(ids.speech), {
    status: "pending", attempts: 0, retry_at: null, error: null, has_text: false, parked: false,
  }, "still queued behind its transcript, untouched — no bounce, no retry stamped");

  released.add("speech");
  await until(async () => (await row(ids.speech)).has_text, 15000, "the transcript landed");
  await until(async () => (await row(ids.speech)).status === "tagged", 5000, "tagged after the transcript");
  assert.ok(prompts.some((p) => p.includes("hello from the clip")), "the tag read the speech");
});

test("a clip whose transcription fails for good is tagged from its name, just as promptly", async () => {
  // "speech" too: the whisper slot is one clip wide, so if the test above
  // stopped before letting its clip go, this one would never be submitted and
  // would fail for the wrong reason.
  released.add("speech").add("noise");
  await until(async () => (await row(ids.noise)).parked, 15000, "the failure parked");
  await until(async () => (await row(ids.noise)).status === "tagged", 5000, "tagged after the park");
  assert.ok(prompts.some((p) => p.includes("noise.mp3") && p.includes("no discernible speech")),
    "anchored on the filename");
});
