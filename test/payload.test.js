// The generic item payload ({identity, files, fields}) and the entity layer
// above it: migration 0004 reshapes image-era payloads in place, 0005 hoists
// entities out of items (same ids), and identity uniqueness lives on entities
// per board. The two migrations are exercised directly here (they run once via
// the ledger at boot, so we call their `up` over freshly-seeded legacy rows).
import test from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, seedItem, req, withLegacyEntityId } from "./helpers.js";
import { insertItem, createEntity } from "../server/db.js";
import { up as reshapeImagePayloads } from "../server/migrations/0004_image_payload_reshape.js";
import { up as hoistEntities } from "../server/migrations/0005_items_to_entities.js";

test("payload shape and identity", async (t) => {
  const { base, db, close } = await startServer();
  t.after(close);
  const admin = await adminSession(db);
  const board = await seedBoard(db, "payload-board");

  await t.test("initDb migrates an image-era payload to identity/files/fields + an entity row", async () => {
    const { rows } = await db.query(
      `INSERT INTO items (board_id, status, payload, created_at, updated_at)
       VALUES ($1, 'tagged', $2, 1, 1) RETURNING id`,
      [board, JSON.stringify({ filename: "legacy.png", original_name: "cat.png", w: 12, h: 34 })]
    );
    await reshapeImagePayloads(db); // idempotent — only touches legacy-shaped rows
    await withLegacyEntityId(db, () => hoistEntities(db));
    const { rows: after } = await db.query("SELECT payload, entity_ids FROM items WHERE id=$1", [rows[0].id]);
    assert.deepEqual(after[0].payload, {
      identity: "legacy.png",
      files: [{ name: "legacy.png", original_name: "cat.png", w: 12, h: 34 }],
      fields: {},
    });
    // Entity hoisted with the same id as the item, keyed by the filename.
    assert.deepEqual(after[0].entity_ids, [rows[0].id]);
    const { rows: ents } = await db.query("SELECT * FROM entities WHERE id=$1", [rows[0].id]);
    assert.equal(ents[0].identity, "legacy.png");
    assert.equal(ents[0].board_id, board);
  });

  await t.test("initDb splits a multi-file item into per-file instances under one entity", async () => {
    const files = [
      { name: "one.pdf", original_name: "resume_v1.pdf", kind: "pdf" },
      { name: "two.pdf", original_name: "resume_v2.pdf", kind: "pdf" },
      { name: "three.png", original_name: "photo.png", kind: "image", w: 5, h: 5 },
    ];
    const mapping = { identity: { from: "ai", hint: "the person" }, fields: [] };
    const { rows } = await db.query(
      `INSERT INTO items (board_id, status, payload, created_at, updated_at)
       VALUES ($1, 'tagged', $2, 1, 1) RETURNING id`,
      [board, JSON.stringify({ identity: "maya chen", display_name: "Maya Chen", files, fields: {}, mapping })]
    );
    await withLegacyEntityId(db, () => hoistEntities(db));
    const { rows: ents } = await db.query(
      "SELECT * FROM entities WHERE board_id=$1 AND identity='maya chen'", [board]
    );
    assert.equal(ents.length, 1);
    assert.equal(ents[0].display_name, "Maya Chen");
    const { rows: insts } = await db.query(
      "SELECT id, status, payload FROM items WHERE entity_ids @> ARRAY[$1]::bigint[] ORDER BY created_at ASC, id ASC", [ents[0].id]
    );
    assert.equal(insts.length, 3);
    // The original row keeps files[0] (still the face) and its tagged status;
    // the split-off files queue fresh through the extract leg.
    assert.equal(insts[0].id, rows[0].id);
    assert.deepEqual(insts[0].payload.files, [files[0]]);
    assert.equal(insts[0].status, "tagged");
    assert.deepEqual(insts[1].payload.files, [files[1]]);
    assert.equal(insts[1].status, "pending_extract");
    assert.deepEqual(insts[2].payload.files, [files[2]]);
    // Entity-level keys left the instance payload.
    assert.equal(insts[0].payload.display_name, undefined);
  });

  await t.test("/api/items output keeps face fields and carries instances", async () => {
    const { filename, instanceId } = await seedItem(db, board);
    const list = await req(base, "GET", `/api/items?board=${board}`, { sid: admin.sid });
    assert.equal(list.status, 200);
    const item = list.json.find((i) => i.name === filename);
    assert.ok(item, "seeded item is listed under its identity");
    assert.equal(item.w, 10);
    assert.equal(item.h, 10);
    assert.equal(item.instances.length, 1);
    assert.equal(item.instances[0].id, instanceId);
    assert.equal(item.instances[0].name, filename);
    const legacy = list.json.find((i) => i.name === "legacy.png");
    assert.equal(legacy.w, 12);
    assert.equal(legacy.h, 34);
  });

  await t.test("a split entity lists union tags and aggregate status", async () => {
    const { rows: ents } = await db.query(
      "SELECT id FROM entities WHERE board_id=$1 AND identity='maya chen'", [board]
    );
    await db.query("UPDATE items SET status='tagged', tags='[\"kind/a\"]'::jsonb WHERE entity_ids @> ARRAY[$1]::bigint[] AND payload->'files'->0->>'name'='one.pdf'", [ents[0].id]);
    await db.query("UPDATE items SET status='tagged', tags='[\"kind/b\"]'::jsonb WHERE entity_ids @> ARRAY[$1]::bigint[] AND payload->'files'->0->>'name'='two.pdf'", [ents[0].id]);
    const list = await req(base, "GET", `/api/items?board=${board}`, { sid: admin.sid });
    const ent = list.json.find((i) => i.id === ents[0].id);
    assert.ok(ent);
    assert.equal(ent.instances.length, 3);
    assert.ok(ent.tags.includes("kind/a") && ent.tags.includes("kind/b"), "union tags");
    assert.equal(ent.status, "pending_extract", "any in-flight instance wins the aggregate");
    assert.equal(ent.display_name, "Maya Chen");
    assert.equal(ent.name, "one.pdf", "face = first instance's file");
  });

  await t.test("instances distil detected-object keys; the entity lists their union", async () => {
    const { rows: ents } = await db.query(
      "SELECT id FROM entities WHERE board_id=$1 AND identity='maya chen'", [board]
    );
    // one.pdf saw a car — plus an empty object field and a scalar field, both
    // of which must NOT distil (the discriminator is a NON-EMPTY array v).
    const withCar = {
      car: { v: [{ label: "car", box: [0.1, 0.1, 0.5, 0.5], score: 0.9 }], why: "Detected: car" },
      cat: { v: [], why: "No objects detected" },
      title: { v: "hello", why: "a scalar AI field" },
    };
    const withCat = { cat: { v: [{ label: "cat", box: [0, 0, 1, 0.5], score: 0.8 }], why: "Detected: cat" } };
    await db.query(
      "UPDATE items SET payload = payload || jsonb_build_object('fields', $1::jsonb) WHERE entity_ids @> ARRAY[$2]::bigint[] AND payload->'files'->0->>'name'='one.pdf'",
      [JSON.stringify(withCar), ents[0].id]
    );
    await db.query(
      "UPDATE items SET payload = payload || jsonb_build_object('fields', $1::jsonb) WHERE entity_ids @> ARRAY[$2]::bigint[] AND payload->'files'->0->>'name'='two.pdf'",
      [JSON.stringify(withCat), ents[0].id]
    );
    const list = await req(base, "GET", `/api/items?board=${board}`, { sid: admin.sid });
    const ent = list.json.find((i) => i.id === ents[0].id);
    const byName = new Map(ent.instances.map((i) => [i.name, i]));
    assert.deepEqual(byName.get("one.pdf").objects, ["car"], "boxed key only — empty v and scalar excluded");
    assert.deepEqual(byName.get("two.pdf").objects, ["cat"]);
    assert.equal(byName.get("three.png").objects, undefined, "no detections → key omitted");
    assert.deepEqual(ent.objects, ["car", "cat"], "entity union, instance order");
  });

  await t.test("identity is unique per board on entities, not globally", async () => {
    const other = await seedBoard(db, "payload-board-2");
    await createEntity(db, board, { identity: "dupe.png" });
    await createEntity(db, other, { identity: "dupe.png" }); // same identity, other board: fine
    await assert.rejects(() => createEntity(db, board, { identity: "dupe.png" }), /duplicate key/);
  });

  await t.test("items no longer carry an identity index; entities do", async () => {
    const { rows } = await db.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'items' AND indexname IN ('idx_items_filename','idx_items_board_identity')"
    );
    assert.deepEqual(rows, []);
    const { rows: eidx } = await db.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'entities' AND indexname = 'idx_entities_board_identity'"
    );
    assert.equal(eidx.length, 1);
  });
});
