// Crate places and hearts through the worker's REAL extract leg
// (planning/alert-crating-plan.md, Stage 1). derived-identity.test.js proves
// moveInstance itself; this proves the worker's two moves go through it — the
// merge into the card that owns the derived key, and the split back to one
// card per file. Neither had any automated coverage: extractOne lives inside
// startWorker's closure, so the only door is a live worker, and the model call
// is answered by an in-test stub via ANTHROPIC_BASE_URL (alerts-worker.test.js's
// pattern).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";
import { startServer, adminSession, until, placeCard, placesOf } from "./helpers.js";
import { createBoard, createEntity, insertItem, getEntity } from "../server/db.js";
import { startWorker } from "../server/worker.js";

let srv, db, admin, stopWorker, ai;

before(async () => {
  // Whatever tool the leg asks for, answer it: record_fields names Ada Lovelace
  // (the merge board's card key) and fills the split board's note; any tag call
  // gets nothing.
  ai = http.createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      const tool = JSON.parse(body).tool_choice?.name || "record_tags";
      const input = tool === "record_fields"
        ? { person: { why: "stub", value: "Ada Lovelace" }, note: { why: "stub", value: "a note" } }
        : {};
      rs.setHeader("Content-Type", "application/json");
      rs.end(JSON.stringify({
        content: [{ type: "tool_use", id: "tu_stub", name: tool, input }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => ai.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.POLL_MS = "50";

  srv = await startServer();
  db = srv.db;
  admin = await adminSession(db);
  stopWorker = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
});

after(async () => {
  await stopWorker?.();
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.POLL_MS;
  await new Promise((r) => ai.close(r));
  await srv.close();
});

// The original and its thumbnail — the extract leg's image input reads the
// thumbnail.
async function imageFile(name) {
  const img = () => sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 9, g: 9, b: 9 } } });
  fs.mkdirSync(srv.galleryDir, { recursive: true });
  fs.mkdirSync(srv.thumbsDir, { recursive: true });
  fs.writeFileSync(path.join(srv.galleryDir, name), await img().png().toBuffer());
  fs.writeFileSync(path.join(srv.thumbsDir, `${name}.webp`), await img().webp().toBuffer());
  return { name, original_name: name, kind: "image" };
}

const cardsOf = async (itemId) =>
  (await db.query("SELECT entity_ids FROM items WHERE id=$1", [itemId])).rows[0].entity_ids;
// The worker is a live one, answering at its own pace.
const WORKER_MS = 15000;

test("a merge through the extract leg: the card the file joins takes the crate place and the heart", async () => {
  const mapping = { card: { by: "person" }, fields: [{ key: "person", kind: "text", source: "extract" }] };
  const boardId = await createBoard(db, "places merge", [], "", true, null, null, { enabled: true }, false, { mapping });
  const winner = await createEntity(db, boardId, { identity: "ada lovelace", displayName: "Ada Lovelace" });
  await insertItem(db, boardId, { identity: "w.png", fields: {}, files: [await imageFile("w1a2b3.png")] }, "tagged", winner);

  const upload = await createEntity(db, boardId, { identity: "u9c8d7.png" });
  const crate = await placeCard(db, admin.id, boardId, upload);
  const itemId = await insertItem(db, boardId,
    { identity: "u9c8d7.png", fields: {}, mapping, files: [await imageFile("u9c8d7.png")] }, "pending_extract", upload);

  await until(async () => (await cardsOf(itemId))[0] === winner, WORKER_MS);
  assert.equal(await getEntity(db, upload), null, "the upload's own card merged away");
  assert.deepEqual(await placesOf(db, winner), { crates: [[crate, 1000]], hearts: [[admin.id, 2000]] });
});

test("a split through the extract leg: the file's new card takes the crate place and the heart", async () => {
  const mapping = { fields: [{ key: "note", kind: "text", source: "extract" }] }; // no card key: one card per file
  const boardId = await createBoard(db, "places split", [], "", true, null, null, { enabled: true }, false, { mapping });
  const pile = await createEntity(db, boardId, { identity: "pile", displayName: "Pile" });
  await insertItem(db, boardId, { identity: "p1.png", fields: {}, files: [await imageFile("p1e5f6.png")] }, "tagged", pile);
  const crate = await placeCard(db, admin.id, boardId, pile);
  const itemId = await insertItem(db, boardId,
    { identity: "p2.png", fields: {}, mapping, files: [await imageFile("p2g7h8.png")] }, "pending_extract", pile);

  const [shell] = await until(async () => {
    const ids = await cardsOf(itemId);
    return ids[0] !== pile && ids;
  }, WORKER_MS);
  const want = { crates: [[crate, 1000]], hearts: [[admin.id, 2000]] };
  assert.deepEqual(await placesOf(db, shell), want);
  assert.deepEqual(await placesOf(db, pile), want, "the card it left keeps its own");
});
