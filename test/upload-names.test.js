// Upload names keep their UTF-8. multer read a browser's filename as Latin-1
// until ingest.js set defParamCharset, so "this？" landed as "thisï¼\x9F" on
// the card and in History; migration 0055 repairs the names stored before.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, seedUser } from "./helpers.js";
import { createEntity, insertItem, addJobLog, addAlertMatch } from "../server/db.js";
import { repairName, up } from "../server/migrations/0055_utf8_upload_names.js";

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

// Exactly what multer did: the UTF-8 bytes, read one char per byte.
const misread = (s) => Buffer.from(s, "utf8").toString("latin1");

test("repairName undoes the Latin-1 misread and leaves every other name alone", () => {
  for (const name of ["Are moms still like this？ #comedy.mp3", "That’s what they’re not prized for.mp3", "café.png", "日本語.pdf"]) {
    assert.equal(repairName(misread(name)), name, `repairs ${name}`);
  }
  assert.equal(repairName("plain.png"), "plain.png", "ASCII has nothing to repair");
  assert.equal(repairName("café.png"), "café.png", "a genuine Latin-1 name isn't UTF-8 as bytes");
  assert.equal(repairName("日本語.pdf"), "日本語.pdf", "past U+00FF can't be a misread byte");
  // …even when the chars' low bytes happen to spell valid UTF-8 (C3 A9 = "é").
  assert.equal(repairName("ǃ©.png"), "ǃ©.png");
  assert.equal(repairName(null), null);
});

test("an upload keeps its UTF-8 name — on the card and in the response", async () => {
  const admin = await adminSession(srv.db);
  const board = await seedBoard(srv.db, "utf8-names");
  const name = "this？ café’s notes.txt";
  const fd = new FormData();
  fd.append("files", new File(["hello"], name, { type: "text/plain" }));
  const res = await fetch(`${srv.base}/api/upload?board=${board}`, {
    method: "POST", headers: { Cookie: `sid=${admin.sid}` }, body: fd,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.uploaded[0]?.label, name, JSON.stringify(body));
  const { rows: [row] } = await srv.db.query(
    "SELECT payload->'files'->0->>'original_name' AS n FROM items WHERE board_id=$1", [board]);
  assert.equal(row.n, name);
});

test("0055 repairs uploads' names — the card, History, alert labels — and nothing else", async () => {
  const db = srv.db;
  const board = await seedBoard(db, "utf8-repair");
  const eid = await createEntity(db, board, { identity: "clip" });
  const id = await insertItem(db, board, { identity: "clip", fields: {}, files: [
    { name: "a.mp3", original_name: misread("this？.mp3"), kind: "audio" },
    { name: "b.png", original_name: "café.png", kind: "image" },
    { name: "c.png", kind: "image" },
  ] }, "tagged", eid);
  await addJobLog(db, { boardId: board, entityId: eid, itemId: id, target: misread("this？.mp3"), kind: "tag", outcome: "ok" });
  const user = await seedUser(db, "utf8-repair@example.com");
  const { rows: [alert] } = await db.query(
    "INSERT INTO alerts (user_id, board_id, name, created_at) VALUES ($1, $2, 'a', 0) RETURNING id", [user.id, board]);
  await addAlertMatch(db, alert.id, eid, id, misread("this？.mp3"));

  // Left alone: a folder-ingested file (provenance) whose genuine name would
  // pass repairName — D7 BD is valid UTF-8 — and a History label that isn't a
  // repaired upload's, with the same shape.
  const peid = await createEntity(db, board, { identity: "scan" });
  const scanned = await insertItem(db, board, { identity: "scan", fields: {}, provenance: { key: "k", hash: "h" },
    files: [{ name: "s.png", original_name: "3×½ scale.png", kind: "image" }] }, "tagged", peid);
  assert.equal(repairName("3×½ scale.png"), "3\u05FD scale.png", "the name repairName alone would mangle");
  await addJobLog(db, { boardId: board, entityId: null, itemId: null, target: "3×½ scale", kind: "fetch", outcome: "ok" });

  const read = async () => ({
    files: (await db.query("SELECT payload->'files' AS f FROM items WHERE id=$1", [id])).rows[0].f.map((f) => f.original_name),
    history: (await db.query("SELECT target FROM job_log WHERE item_id=$1", [id])).rows.map((r) => r.target),
    label: (await db.query("SELECT label FROM alert_matches WHERE item_id=$1", [id])).rows[0].label,
    scanned: (await db.query("SELECT payload->'files'->0->>'original_name' AS n FROM items WHERE id=$1", [scanned])).rows[0].n,
    other: (await db.query("SELECT target FROM job_log WHERE board_id=$1 AND item_id IS NULL", [board])).rows[0].target,
  });
  await up(db);
  const once = await read();
  assert.deepEqual(once, {
    files: ["this？.mp3", "café.png", undefined],
    history: ["this？.mp3"],
    label: "this？.mp3",
    scanned: "3×½ scale.png",
    other: "3×½ scale",
  });
  await up(db);
  assert.deepEqual(await read(), once, "a re-run changes nothing");
});
