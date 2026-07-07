// Derived identity on the entity/instance model: buildFieldsPrompt with the
// identity key, mapping validation for the identity slot, entity helpers
// (create/lookup/rename/re-parent/empty-delete), the instance remove route,
// per-instance reasoning, and entity-level reprocess.
// No live AI — the merge/split paths' worker wiring is exercised in the live
// verify; the DB mechanics they compose are covered here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, seedItem, req } from "./helpers.js";
import { buildFieldsPrompt } from "../server/worker.js";
import {
  createEntity,
  getEntity,
  getEntityByIdentity,
  setEntityIdentity,
  markEntityProvisional,
  reparentItem,
  entityInstanceCount,
  deleteEntityIfEmpty,
  deleteEntity,
  reprocessEntity,
  insertItem,
} from "../server/db.js";

// ─── pure: buildFieldsPrompt with derived identity ───────────────────────────

test("buildFieldsPrompt: identity key injected first when mapping.identity.from = 'ai'", () => {
  const mapping = {
    identity: { from: "ai", hint: "the person's full name" },
    fields: [{ key: "role", kind: "text", from: "ai", hint: "job title" }],
  };
  const { schema, systemText } = buildFieldsPrompt(mapping);

  // identity must be the first required key
  assert.equal(schema.required[0], "identity");
  assert.equal(schema.required[1], "role");

  // identity field shape: why-before-value, nullable string
  const id = schema.properties.identity;
  assert.equal(id.type, "object");
  assert.deepEqual(id.required, ["why", "value"]);
  assert.equal(Object.keys(id.properties)[0], "why");
  assert.deepEqual(id.properties.value.type, ["string", "null"]);
  assert.equal(id.description, "the person's full name");

  // system text mentions identity consistency
  assert.match(systemText, /unique key/);
  assert.match(systemText, /same entity always produces the same value/);
});

test("buildFieldsPrompt: identity key absent when mapping.identity.from = 'raw'", () => {
  const mapping = {
    identity: { from: "raw" },
    fields: [{ key: "role", kind: "text", from: "ai" }],
  };
  const { schema } = buildFieldsPrompt(mapping);
  assert.equal(schema.properties.identity, undefined);
  assert.deepEqual(schema.required, ["role"]);
});

test("buildFieldsPrompt: identity key absent when identity slot omitted", () => {
  const { schema } = buildFieldsPrompt({ fields: [{ key: "x", kind: "text", from: "ai" }] });
  assert.equal(schema.properties.identity, undefined);
});

// ─── integration ─────────────────────────────────────────────────────────────

let srv, db, base, admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});

after(() => srv.close());

async function patchBoard(id, body) {
  return req(base, "PATCH", `/api/admin/boards/${id}`, { sid: admin.sid, body });
}
async function createBoardReq(name, extra = {}) {
  return req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name, ...extra } });
}
// An entity plus one instance carrying one file.
async function seedInstance(boardId, entityId, file, extra = {}) {
  return insertItem(db, boardId, { identity: file.name, files: [file], fields: {}, ...extra }, "tagged", entityId);
}

// ── validateMapping: identity slot ───────────────────────────────────────────

test("mapping PATCH: identity from:ai with hint is valid", async () => {
  const { json: board } = await createBoardReq("id-valid");
  const r = await patchBoard(board.id, {
    mapping: { identity: { from: "ai", hint: "full name" }, fields: [] },
  });
  assert.equal(r.status, 200);
});

test("mapping PATCH: identity from:raw is valid", async () => {
  const { json: board } = await createBoardReq("id-raw");
  const r = await patchBoard(board.id, {
    mapping: { identity: { from: "raw" }, fields: [] },
  });
  assert.equal(r.status, 200);
});

test("mapping PATCH: identity from:ai without hint → 400", async () => {
  const { json: board } = await createBoardReq("id-nohint");
  const r = await patchBoard(board.id, {
    mapping: { identity: { from: "ai" }, fields: [] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /hint/);
});

test("mapping PATCH: identity from:connector is valid (connector slice shipped)", async () => {
  const { json: board } = await createBoardReq("id-connector");
  const r = await patchBoard(board.id, {
    mapping: { identity: { from: "connector" }, fields: [] },
  });
  assert.equal(r.status, 200);
});

// ── entity helpers ───────────────────────────────────────────────────────────

test("getEntityByIdentity: finds an entity by its derived identity", async () => {
  const boardId = await seedBoard(db, "get-by-id");
  await createEntity(db, boardId, { identity: "jordan okafor", displayName: "Jordan Okafor" });
  const found = await getEntityByIdentity(db, boardId, "jordan okafor");
  assert.ok(found);
  assert.equal(found.display_name, "Jordan Okafor");
});

test("getEntityByIdentity: returns null when not found", async () => {
  const boardId = await seedBoard(db, "get-by-id-miss");
  const found = await getEntityByIdentity(db, boardId, "nobody");
  assert.equal(found, null);
});

test("setEntityIdentity: updates identity and clears the provisional flag", async () => {
  const boardId = await seedBoard(db, "set-id");
  const id = await createEntity(db, boardId, { identity: "provisional-filename.pdf" });
  await markEntityProvisional(db, id);

  await setEntityIdentity(db, id, "jordan okafor", "Jordan Okafor");

  const ent = await getEntity(db, id);
  assert.equal(ent.identity, "jordan okafor");
  assert.equal(ent.display_name, "Jordan Okafor");
  assert.equal(ent.identity_provisional, false);
});

test("setEntityIdentity: throws 23505 on collision with an existing identity", async () => {
  const boardId = await seedBoard(db, "set-id-collision");
  await createEntity(db, boardId, { identity: "jordan okafor" });
  const provisionalId = await createEntity(db, boardId, { identity: "provisional2.pdf" });

  let caught = null;
  try {
    await setEntityIdentity(db, provisionalId, "jordan okafor");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected an error");
  assert.equal(caught.code, "23505");
});

// ── merge = re-parent: the instance keeps its fields and tags ────────────────

test("re-parent moves an instance (data intact) and the emptied entity is deleted", async () => {
  const boardId = await seedBoard(db, "reparent");
  const winner = await createEntity(db, boardId, { identity: "jordan okafor", displayName: "Jordan Okafor" });
  await seedInstance(boardId, winner, { name: "a.pdf", original_name: "resume_v1.pdf", kind: "pdf" });

  const provisional = await createEntity(db, boardId, { identity: "upload2.pdf" });
  const instId = await seedInstance(boardId, provisional, { name: "b.pdf", original_name: "resume_v2.pdf", kind: "pdf" });
  await db.query("UPDATE items SET tags='[\"kind/b\"]'::jsonb, payload = jsonb_set(payload,'{fields}','{\"email\":{\"v\":\"j@x.com\",\"why\":\"header\"}}'::jsonb) WHERE id=$1", [instId]);

  await reparentItem(db, instId, winner);
  assert.equal(await deleteEntityIfEmpty(db, provisional), true);
  assert.equal(await entityInstanceCount(db, winner), 2);

  // The moved instance kept everything it had earned.
  const { rows: [row] } = await db.query("SELECT tags, payload, entity_id FROM items WHERE id=$1", [instId]);
  assert.equal(row.entity_id, winner);
  assert.deepEqual(row.tags, ["kind/b"]);
  assert.equal(row.payload.fields.email.v, "j@x.com");

  // Not-empty entities survive deleteEntityIfEmpty.
  assert.equal(await deleteEntityIfEmpty(db, winner), false);
});

test("the merged entity lists both instances with per-instance tags", async () => {
  const boardId = await seedBoard(db, "merged-list");
  const eid = await createEntity(db, boardId, { identity: "maya chen", displayName: "Maya Chen" });
  const i1 = await seedInstance(boardId, eid, { name: "p1.png", original_name: "car1.png", kind: "image", w: 4, h: 3 });
  const i2 = await seedInstance(boardId, eid, { name: "p2.png", original_name: "car2.png", kind: "image", w: 4, h: 3 });
  await db.query("UPDATE items SET tags='[\"kind/a\"]'::jsonb WHERE id=$1", [i1]);
  await db.query("UPDATE items SET tags='[\"kind/b\"]'::jsonb WHERE id=$1", [i2]);

  const list = await req(base, "GET", `/api/items?board=${boardId}`, { sid: admin.sid });
  const ent = list.json.find((i) => i.id === eid);
  assert.ok(ent);
  assert.equal(ent.display_name, "Maya Chen");
  assert.equal(ent.name, "p1.png", "face = first instance");
  assert.deepEqual(ent.tags, ["kind/a", "kind/b"], "union in instance order");
  assert.deepEqual(ent.instances.map((i) => i.tags), [["kind/a"], ["kind/b"]]);
});

// ── DELETE /api/instances/:id ────────────────────────────────────────────────

test("instance remove route: removes one instance, entity and siblings stay", async () => {
  const boardId = await seedBoard(db, "route-remove-inst");
  const eid = await createEntity(db, boardId, { identity: "entity x", displayName: "Entity X" });
  const keep = await seedInstance(boardId, eid, { name: "a.txt", original_name: "doc1.txt", kind: "text" });
  const drop = await seedInstance(boardId, eid, { name: "b.txt", original_name: "doc2.txt", kind: "text" });

  const r = await req(base, "DELETE", `/api/instances/${drop}`, { sid: admin.sid });
  assert.equal(r.status, 200);

  assert.equal(await entityInstanceCount(db, eid), 1);
  const { rows } = await db.query("SELECT id FROM items WHERE entity_id=$1", [eid]);
  assert.equal(rows[0].id, keep);
});

test("instance remove route: 409 when trying to remove the only instance", async () => {
  const boardId = await seedBoard(db, "route-remove-only");
  const item = await seedItem(db, boardId);
  const r = await req(base, "DELETE", `/api/instances/${item.instanceId}`, { sid: admin.sid });
  assert.equal(r.status, 409);
});

// ── entity delete cascades instances ─────────────────────────────────────────

test("entity delete removes all instances and reports their files", async () => {
  const boardId = await seedBoard(db, "entity-delete");
  const eid = await createEntity(db, boardId, { identity: "casc", displayName: "Casc" });
  await seedInstance(boardId, eid, { name: "f1.png", kind: "image" });
  await seedInstance(boardId, eid, { name: "f2.png", kind: "image" });

  const result = await deleteEntity(db, eid);
  assert.deepEqual(result.files.map((f) => f.name).sort(), ["f1.png", "f2.png"]);
  const { rows } = await db.query("SELECT 1 FROM items WHERE entity_id=$1", [eid]);
  assert.equal(rows.length, 0);
});

// ── per-instance reasoning ───────────────────────────────────────────────────

test("reasoning endpoint returns the instance's reasoning and fields", async () => {
  const boardId = await seedBoard(db, "reasoning-inst");
  const eid = await createEntity(db, boardId, { identity: "jordan okafor" });
  const instId = await seedInstance(boardId, eid, { name: "a.pdf", original_name: "resume_v1.pdf", kind: "pdf" });
  await db.query(
    "UPDATE items SET tag_reasoning='{\"fit\":\"looks right\"}'::jsonb, payload = jsonb_set(payload,'{fields}','{\"role\":{\"v\":\"designer\",\"why\":\"title line\"}}'::jsonb) WHERE id=$1",
    [instId]
  );

  const r = await req(base, "GET", `/api/instances/${instId}/reasoning`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.reasoning.fit, "looks right");
  assert.equal(r.json.fields.role.v, "designer");
});

// ── entity-level reprocess ───────────────────────────────────────────────────

test("reprocess re-queues every instance of the entity", async () => {
  const boardId = await seedBoard(db, "reprocess-entity");
  const eid = await createEntity(db, boardId, { identity: "multi", displayName: "Multi" });
  await seedInstance(boardId, eid, { name: "r1.png", kind: "image" });
  await seedInstance(boardId, eid, { name: "r2.png", kind: "image" });

  const r = await req(base, "POST", `/api/items/${eid}/reprocess`, { sid: admin.sid });
  assert.equal(r.status, 200);
  const { rows } = await db.query("SELECT status FROM items WHERE entity_id=$1", [eid]);
  assert.deepEqual(rows.map((x) => x.status), ["pending", "pending"]);
  assert.ok(await reprocessEntity(db, eid));
});
