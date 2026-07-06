// The generic item payload ({identity, files, fields} — agnostic-core step 1):
// initDb migrates image-era payloads in place, identity is unique per board
// (not globally), and /api/items keeps its exact pre-migration output shape.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, seedItem, req } from "./helpers.js";
import { initDb, insertItem } from "../server/db.js";

test("payload shape and identity", async (t) => {
  const { base, db, close } = await startServer();
  t.after(close);
  const admin = await adminSession(db);
  const board = await seedBoard(db, "payload-board");

  await t.test("initDb migrates an image-era payload to identity/files/fields", async () => {
    const { rows } = await db.query(
      `INSERT INTO items (board_id, status, payload, created_at, updated_at)
       VALUES ($1, 'tagged', $2, 1, 1) RETURNING id`,
      [board, JSON.stringify({ filename: "legacy.png", original_name: "cat.png", w: 12, h: 34 })]
    );
    await initDb(db); // idempotent — the one-timer only touches legacy-shaped rows
    const { rows: after } = await db.query("SELECT payload FROM items WHERE id=$1", [rows[0].id]);
    assert.deepEqual(after[0].payload, {
      identity: "legacy.png",
      files: [{ name: "legacy.png", original_name: "cat.png", w: 12, h: 34 }],
      fields: {},
    });
  });

  await t.test("/api/items output shape is unchanged (name/w/h from the payload)", async () => {
    const { filename } = await seedItem(db, board);
    const list = await req(base, "GET", `/api/items?board=${board}`, { sid: admin.sid });
    assert.equal(list.status, 200);
    const item = list.json.find((i) => i.name === filename);
    assert.ok(item, "seeded item is listed under its identity");
    assert.equal(item.w, 10);
    assert.equal(item.h, 10);
    const legacy = list.json.find((i) => i.name === "legacy.png");
    assert.equal(legacy.w, 12);
    assert.equal(legacy.h, 34);
  });

  await t.test("identity is unique per board, not globally", async () => {
    const other = await seedBoard(db, "payload-board-2");
    const payload = { identity: "dupe.png", files: [{ name: "dupe.png" }], fields: {} };
    await insertItem(db, board, payload, "tagged");
    await insertItem(db, other, payload, "tagged"); // same identity, other board: fine now
    await assert.rejects(() => insertItem(db, board, payload, "tagged"), /duplicate key/);
  });

  await t.test("the old global filename index is gone", async () => {
    const { rows } = await db.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'items' AND indexname IN ('idx_items_filename','idx_items_board_identity')"
    );
    assert.deepEqual(rows.map((r) => r.indexname), ["idx_items_board_identity"]);
  });
});
