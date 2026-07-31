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
  setItemEntities,
  reconcileEntities,
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

  // The user's hint is the identity instruction, listed first among the
  // fields — with no competing "unique key" framing to override it.
  assert.match(systemText, /- identity \(text\): the person's full name/);
  assert.ok(systemText.indexOf("- identity") < systemText.indexOf("- role"));
  assert.doesNotMatch(systemText, /unique key/);
});

test("buildFieldsPrompt: hint-less derived identity falls back to consistency guidance", () => {
  const mapping = { identity: { from: "ai" }, fields: [] };
  const { schema, systemText } = buildFieldsPrompt(mapping);
  assert.match(systemText, /- identity \(text\): .*same subject must always produce the same value/);
  assert.match(schema.properties.identity.description, /consistent name/);
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

// ─── classify mode (Slice 2): candidate list constrains the identity answer ──

test("buildFieldsPrompt: candidates turn identity into a closed multi-select enum", () => {
  const mapping = {
    identity: {
      from: "ai",
      hint: "which Emma this resembles",
      candidates: [
        { value: "Emma Watson", hint: "British actress" },
        { value: "Emma Roberts" },
        { value: "Emma Stone" },
      ],
    },
    fields: [],
  };
  const { schema, systemText } = buildFieldsPrompt(mapping);
  const id = schema.properties.identity;
  // why + values[] (not the scalar `value`), values constrained to the enum.
  assert.deepEqual(id.required, ["why", "values"]);
  assert.equal(id.properties.value, undefined);
  assert.equal(id.properties.values.type, "array");
  assert.deepEqual(id.properties.values.items.enum, ["Emma Watson", "Emma Roberts", "Emma Stone"]);
  assert.equal(schema.required[0], "identity");
  // The per-candidate hints ride in the prompt (the enum can't carry them).
  assert.match(systemText, /- Emma Watson: British actress/);
  // Cardinality is stated by the system, not left to the user's prose: multi +
  // conservatism, and an explicit counter to a "closest single match" reading.
  assert.match(systemText, /an item can match more than one/);
  assert.match(systemText, /not only the closest single match/);
});

test("buildFieldsPrompt: empty candidates array stays open extraction (scalar value)", () => {
  const { schema } = buildFieldsPrompt({ identity: { from: "ai", hint: "the name", candidates: [] }, fields: [] });
  assert.deepEqual(schema.properties.identity.properties.value.type, ["string", "null"]);
  assert.equal(schema.properties.identity.properties.values, undefined);
});

test("mapping PATCH: identity candidates validate, dedup by normalised key, and reject bad shapes", async () => {
  const { json: board } = await createBoardReq("id-candidates");
  // Valid: from:ai + hint + candidates.
  assert.equal((await patchBoard(board.id, {
    mapping: { identity: { from: "ai", hint: "which person", candidates: [
      { value: "Emma Watson", hint: "British" }, { value: "Emma Roberts" },
    ] }, fields: [] },
  })).status, 200);

  // Duplicate by normalised key ("Emma  Watson" → "emma watson") is rejected.
  const dup = await patchBoard(board.id, {
    mapping: { identity: { from: "ai", hint: "x", candidates: [
      { value: "Emma Watson" }, { value: "emma  watson" },
    ] }, fields: [] },
  });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error, /duplicate identity candidate/);

  // A candidate without a value is rejected.
  assert.equal((await patchBoard(board.id, {
    mapping: { identity: { from: "ai", hint: "x", candidates: [{ hint: "no value" }] }, fields: [] },
  })).status, 400);

  // candidates require from:"ai".
  assert.equal((await patchBoard(board.id, {
    mapping: { identity: { from: "raw", candidates: [{ value: "x" }] }, fields: [] },
  })).status, 400);
});

test("mapping PATCH: candidates persist on the board for extraction to read", async () => {
  const { json: board } = await createBoardReq("id-candidates-persist");
  await patchBoard(board.id, {
    mapping: { identity: { from: "ai", hint: "which person", candidates: [{ value: "Ada Lovelace" }] }, fields: [] },
  });
  const { rows: [b] } = await db.query("SELECT mapping FROM boards WHERE id=$1", [board.id]);
  assert.deepEqual(b.mapping.identity.candidates, [{ value: "Ada Lovelace" }]);
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

// ── merge = membership change: the instance keeps its fields and tags ────────

test("setItemEntities moves an instance (data intact); the emptied entity is deleted", async () => {
  const boardId = await seedBoard(db, "reparent");
  const winner = await createEntity(db, boardId, { identity: "jordan okafor", displayName: "Jordan Okafor" });
  await seedInstance(boardId, winner, { name: "a.pdf", original_name: "resume_v1.pdf", kind: "pdf" });

  const provisional = await createEntity(db, boardId, { identity: "upload2.pdf" });
  const instId = await seedInstance(boardId, provisional, { name: "b.pdf", original_name: "resume_v2.pdf", kind: "pdf" });
  await db.query("UPDATE items SET tags='[\"kind/b\"]'::jsonb, payload = jsonb_set(payload,'{fields}','{\"email\":{\"v\":\"j@x.com\",\"why\":\"header\"}}'::jsonb) WHERE id=$1", [instId]);

  await setItemEntities(db, instId, [winner]);
  assert.equal(await deleteEntityIfEmpty(db, provisional), true);
  assert.equal(await entityInstanceCount(db, winner), 2);

  // The moved instance kept everything it had earned.
  const { rows: [row] } = await db.query("SELECT tags, payload, entity_ids FROM items WHERE id=$1", [instId]);
  assert.deepEqual(row.entity_ids, [winner]);
  assert.deepEqual(row.tags, ["kind/b"]);
  assert.equal(row.payload.fields.email.v, "j@x.com");

  // Not-empty entities survive deleteEntityIfEmpty.
  assert.equal(await deleteEntityIfEmpty(db, winner), false);
});

test("setItemEntities can place one instance under several entities (classify multi-membership)", async () => {
  const boardId = await seedBoard(db, "multi-member");
  const watson = await createEntity(db, boardId, { identity: "emma watson", displayName: "Emma Watson" });
  const roberts = await createEntity(db, boardId, { identity: "emma roberts", displayName: "Emma Roberts" });
  const provisional = await createEntity(db, boardId, { identity: "photo.jpg" });
  const instId = await seedInstance(boardId, provisional, { name: "photo.jpg", kind: "image", w: 4, h: 3 });

  // The one photo resolves to both known people.
  await setItemEntities(db, instId, [watson, roberts]);
  await reconcileEntities(db, [provisional, watson, roberts]);

  assert.equal(await getEntity(db, provisional), null, "the emptied provisional entity is gone");
  assert.equal(await entityInstanceCount(db, watson), 1);
  assert.equal(await entityInstanceCount(db, roberts), 1);

  // The gallery lists the same instance under BOTH entities.
  const list = await req(base, "GET", `/api/items?board=${boardId}`, { sid: admin.sid });
  const w = list.json.find((e) => e.id === watson);
  const r = list.json.find((e) => e.id === roberts);
  assert.deepEqual(w.instances.map((i) => i.id), [instId]);
  assert.deepEqual(r.instances.map((i) => i.id), [instId]);
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
  const { rows } = await db.query("SELECT id FROM items WHERE entity_ids @> ARRAY[$1]::bigint[]", [eid]);
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
  const { rows } = await db.query("SELECT 1 FROM items WHERE entity_ids @> ARRAY[$1]::bigint[]", [eid]);
  assert.equal(rows.length, 0);

  assert.equal(await deleteEntity(db, eid), null, "already gone → null");
});

test("entity delete keeps an instance shared with another entity (orphan-only cleanup)", async () => {
  const boardId = await seedBoard(db, "entity-delete-shared");
  const doomed = await createEntity(db, boardId, { identity: "doomed", displayName: "Doomed" });
  const keeper = await createEntity(db, boardId, { identity: "keeper", displayName: "Keeper" });
  const soleId = await seedInstance(boardId, doomed, { name: "sole.png", kind: "image" });
  const sharedId = await seedInstance(boardId, doomed, { name: "shared.png", kind: "image" });
  await setItemEntities(db, sharedId, [doomed, keeper]); // shared belongs to both

  const result = await deleteEntity(db, doomed);
  // Only the sole-member instance is orphaned and reported for cleanup.
  assert.deepEqual(result.files.map((f) => f.name), ["sole.png"]);
  const { rows: gone } = await db.query("SELECT 1 FROM items WHERE id=$1", [soleId]);
  assert.equal(gone.length, 0, "the orphaned instance is deleted");
  // The shared instance survives, now solely under keeper.
  const { rows: [row] } = await db.query("SELECT entity_ids FROM items WHERE id=$1", [sharedId]);
  assert.deepEqual(row.entity_ids, [keeper]);
  assert.equal(await entityInstanceCount(db, keeper), 1);
});

// ── membership reconcile: merge empties, split survives ──────────────────────
// (The old transactional reparentInstance and its FK-cascade lock test are gone
// with the FK: an item now carries entity_ids, so merge/split are just "the
// array changed" followed by reconcileEntities tidying emptied entities.)

test("reconcileEntities: merge deletes the entity this instance emptied", async () => {
  const boardId = await seedBoard(db, "reconcile-merge");
  const winner = await createEntity(db, boardId, { identity: "amara diallo", displayName: "Amara Diallo" });
  await seedInstance(boardId, winner, { name: "w.pdf", kind: "pdf" });
  const provisional = await createEntity(db, boardId, { identity: "upload9.pdf" });
  const instId = await seedInstance(boardId, provisional, { name: "n.pdf", kind: "pdf" });

  await setItemEntities(db, instId, [winner]);              // instance leaves provisional for winner
  await reconcileEntities(db, [provisional, winner]);
  assert.equal(await getEntity(db, provisional), null, "emptied provisional deleted");
  assert.ok(await getEntity(db, winner), "winner survives");
  assert.equal(await entityInstanceCount(db, winner), 2);
});

test("reconcileEntities: split leaves the old entity standing", async () => {
  const boardId = await seedBoard(db, "reconcile-split");
  const old = await createEntity(db, boardId, { identity: "pile", displayName: "Pile" });
  await seedInstance(boardId, old, { name: "s1.png", kind: "image" });
  const instId = await seedInstance(boardId, old, { name: "s2.png", kind: "image" });
  const target = await createEntity(db, boardId, { identity: "solo", displayName: "Solo" });

  await setItemEntities(db, instId, [target]);             // one instance detaches to target
  await reconcileEntities(db, [old, target]);
  assert.ok(await getEntity(db, old), "old kept its other instance → survives");
  assert.equal(await entityInstanceCount(db, old), 1);
  assert.equal(await entityInstanceCount(db, target), 1);
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
  const { rows } = await db.query("SELECT status FROM items WHERE entity_ids @> ARRAY[$1]::bigint[]", [eid]);
  assert.deepEqual(rows.map((x) => x.status), ["pending", "pending"]);
  assert.ok(await reprocessEntity(db, eid));
});

test("reprocess restarts mapped instances at the extract leg, plain ones at tagging", async () => {
  const boardId = await seedBoard(db, "reprocess-mapped");
  const eid = await createEntity(db, boardId, { identity: "mixed", displayName: "Mixed" });
  // Mapped instance re-derives identity + fields (pending_extract); a plain one
  // (no stamped mapping) just re-tags (pending).
  await seedInstance(boardId, eid, { name: "m1.png", kind: "image" }, { mapping: { identity: { from: "ai", hint: "x" }, fields: [] } });
  await seedInstance(boardId, eid, { name: "m2.png", kind: "image" });

  await req(base, "POST", `/api/items/${eid}/reprocess`, { sid: admin.sid });
  const { rows } = await db.query("SELECT payload->'files'->0->>'name' AS name, status FROM items WHERE entity_ids @> ARRAY[$1]::bigint[] ORDER BY id", [eid]);
  assert.deepEqual(rows, [
    { name: "m1.png", status: "pending_extract" },
    { name: "m2.png", status: "pending" },
  ]);
});

// ── per-instance retag ───────────────────────────────────────────────────────

test("retag resets one instance to the tag leg, leaving the entity identity intact", async () => {
  const boardId = await seedBoard(db, "retag-one");
  const eid = await createEntity(db, boardId, { identity: "volvo amazon", displayName: "Volvo Amazon" });
  const instId = await seedInstance(boardId, eid, { name: "v1.png", kind: "image" });
  await db.query("UPDATE items SET tags='[\"category/blue\"]'::jsonb WHERE id=$1", [instId]);

  const r = await req(base, "POST", `/api/instances/${instId}/retag`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "pending");

  const { rows: [item] } = await db.query("SELECT status, tags FROM items WHERE id=$1", [instId]);
  assert.equal(item.status, "pending");
  assert.deepEqual(item.tags, []);
  // Identity is the extract leg's job — retag must not touch it.
  const { rows: [ent] } = await db.query("SELECT identity, display_name FROM entities WHERE id=$1", [eid]);
  assert.equal(ent.identity, "volvo amazon");
  assert.equal(ent.display_name, "Volvo Amazon");
});
