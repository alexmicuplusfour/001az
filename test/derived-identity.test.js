// Derived identity on the entity/instance model: buildFieldsPrompt with the
// identity key, mapping validation for the identity slot, entity helpers
// (create/lookup/rename/re-parent/empty-delete), the instance remove route,
// per-instance reasoning, and entity-level reprocess.
// No live AI — the merge/split paths' worker wiring is exercised in the live
// verify; the DB mechanics they compose are covered here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, seedItem, req } from "./helpers.js";
import { buildFieldsPrompt, resolveIdentity } from "../server/worker.js";
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
  reapEmptyEntities,
  withTx,
  insertItem,
} from "../server/db.js";

// ─── pure: buildFieldsPrompt with derived identity ───────────────────────────

test("buildFieldsPrompt: identity key injected first when mapping.identity.source = 'extract'", () => {
  const mapping = {
    identity: { source: "extract", instruction: "the person's full name" },
    fields: [{ key: "role", kind: "text", source: "extract", instruction: "job title" }],
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

  // The user's instruction is the identity guidance, listed first among the
  // fields — with no competing "unique key" framing to override it.
  assert.match(systemText, /- identity \(text\): the person's full name/);
  assert.ok(systemText.indexOf("- identity") < systemText.indexOf("- role"));
  assert.doesNotMatch(systemText, /unique key/);
});

test("buildFieldsPrompt: instruction-less derived identity falls back to consistency guidance", () => {
  const mapping = { identity: { source: "extract" }, fields: [] };
  const { schema, systemText } = buildFieldsPrompt(mapping);
  assert.match(systemText, /- identity \(text\): .*same subject must always produce the same value/);
  assert.match(schema.properties.identity.description, /consistent name/);
});

test("buildFieldsPrompt: identity key absent when the identity slot is null (filename default)", () => {
  const mapping = {
    identity: null,
    fields: [{ key: "role", kind: "text", source: "extract" }],
  };
  const { schema } = buildFieldsPrompt(mapping);
  assert.equal(schema.properties.identity, undefined);
  assert.deepEqual(schema.required, ["role"]);
});

test("buildFieldsPrompt: identity key absent when identity slot omitted", () => {
  const { schema } = buildFieldsPrompt({ fields: [{ key: "x", kind: "text", source: "extract" }] });
  assert.equal(schema.properties.identity, undefined);
});

// ─── classify mode (Slice 2): options list constrains the identity answer ──

test("buildFieldsPrompt: options turn identity into a closed multi-select enum", () => {
  const mapping = {
    identity: {
      source: "extract",
      instruction: "which Emma this resembles",
      options: [
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
  // The per-option hints ride in the prompt (the enum can't carry them).
  assert.match(systemText, /- Emma Watson: British actress/);
  // Cardinality is stated by the system, not left to the user's prose: multi +
  // conservatism, and an explicit counter to a "closest single match" reading.
  assert.match(systemText, /an item can match more than one/);
  assert.match(systemText, /not only the closest single match/);
});

test("buildFieldsPrompt: empty options array stays open extraction (scalar value)", () => {
  const { schema } = buildFieldsPrompt({ identity: { source: "extract", instruction: "the name", options: [] }, fields: [] });
  assert.deepEqual(schema.properties.identity.properties.value.type, ["string", "null"]);
  assert.equal(schema.properties.identity.properties.values, undefined);
});

test("mapping PATCH: identity options validate, dedup by normalised key, and reject bad shapes", async () => {
  const { json: board } = await createBoardReq("id-candidates");
  // Valid: source:extract + instruction + options.
  assert.equal((await patchBoard(board.id, {
    mapping: { identity: { source: "extract", instruction: "which person", options: [
      { value: "Emma Watson", hint: "British" }, { value: "Emma Roberts" },
    ] }, fields: [] },
  })).status, 200);

  // Duplicate by normalised key ("Emma  Watson" → "emma watson") is rejected.
  const dup = await patchBoard(board.id, {
    mapping: { identity: { source: "extract", instruction: "x", options: [
      { value: "Emma Watson" }, { value: "emma  watson" },
    ] }, fields: [] },
  });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error, /duplicate identity option/);

  // An option without a value is rejected.
  assert.equal((await patchBoard(board.id, {
    mapping: { identity: { source: "extract", instruction: "x", options: [{ hint: "no value" }] }, fields: [] },
  })).status, 400);

  // options require source:"extract" — a sourceless identity object is rejected.
  assert.equal((await patchBoard(board.id, {
    mapping: { identity: { options: [{ value: "x" }] }, fields: [] },
  })).status, 400);
});

test("mapping PATCH: options persist on the board for extraction to read", async () => {
  const { json: board } = await createBoardReq("id-candidates-persist");
  await patchBoard(board.id, {
    mapping: { identity: { source: "extract", instruction: "which person", options: [{ value: "Ada Lovelace" }] }, fields: [] },
  });
  const { rows: [b] } = await db.query("SELECT mapping FROM boards WHERE id=$1", [board.id]);
  assert.deepEqual(b.mapping.identity.options, [{ value: "Ada Lovelace" }]);
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

test("mapping PATCH: identity source:extract with instruction is valid", async () => {
  const { json: board } = await createBoardReq("id-valid");
  const r = await patchBoard(board.id, {
    mapping: { identity: { source: "extract", instruction: "full name" }, fields: [] },
  });
  assert.equal(r.status, 200);
});

test("mapping PATCH: identity null (the filename default) is valid", async () => {
  const { json: board } = await createBoardReq("id-raw");
  const r = await patchBoard(board.id, {
    mapping: { identity: null, fields: [] },
  });
  assert.equal(r.status, 200);
});

test("mapping PATCH: identity source:extract without instruction → 400", async () => {
  const { json: board } = await createBoardReq("id-nohint");
  const r = await patchBoard(board.id, {
    mapping: { identity: { source: "extract" }, fields: [] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /instruction/);
});

test("mapping PATCH: identity source:connector is valid on a connector board", async () => {
  const { json: board } = await createBoardReq("id-connector");
  const r = await patchBoard(board.id, {
    mapping: { input: { connector: "crypto" }, identity: { source: "connector" }, fields: [] },
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

// ── resolveIdentity: 23505 collision recovery ────────────────────────────────
// Extraction runs EXTRACT_CONCURRENCY-wide and classify funnels many items to one
// candidate, so siblings routinely race to first-create/rename the same key; the
// unique (board_id, identity) throws 23505 for the loser, which must ADOPT the
// winner rather than throw the leg into a requeue. The window (existence lookup →
// our write) is too narrow to hit reliably by wall-clock racing, so a db shim
// slips the winning entity in right after resolveIdentity's first query — the
// existence lookup — forcing the recovery path deterministically every run.

// resolveIdentity's first query is always its existence lookup; fire `inject`
// once, right after it returns empty, so our subsequent write hits a live 23505.
function raceAfterLookup(realDb, inject) {
  let fired = false;
  return { query: async (...args) => {
    const res = await realDb.query(...args);
    if (!fired) { fired = true; await inject(); }
    return res;
  } };
}

test("resolveIdentity: create loses the race → adopts the winner (23505 recovery)", async () => {
  const boardId = await seedBoard(db, "resolve-race-create");
  let winnerId = null;
  const racing = raceAfterLookup(db, async () => {
    winnerId = await createEntity(db, boardId, { identity: "emma watson", displayName: "Emma Watson" });
  });
  // No reusable entity → the create branch; the sibling grabbed the key first.
  const id = await resolveIdentity(racing, boardId, "emma watson", "Emma Watson", [], []);
  assert.equal(id, winnerId, "the racer adopts the winner instead of throwing");
  const { rows } = await db.query(
    "SELECT id FROM entities WHERE board_id=$1 AND identity=$2", [boardId, "emma watson"]);
  assert.equal(rows.length, 1, "exactly one entity holds the key — no duplicate minted");
});

test("resolveIdentity: rename-in-place loses the race → adopts winner, provisional untouched", async () => {
  const boardId = await seedBoard(db, "resolve-race-rename");
  const provisional = await createEntity(db, boardId, { identity: "upload.jpg" });
  let winnerId = null;
  const racing = raceAfterLookup(db, async () => {
    winnerId = await createEntity(db, boardId, { identity: "emma watson", displayName: "Emma Watson" });
  });
  const reusable = [provisional];
  // reusable is non-empty → the rename-in-place branch; the sibling grabbed the
  // key between our lookup and our rename.
  const id = await resolveIdentity(racing, boardId, "emma watson", "Emma Watson", reusable, []);

  assert.equal(id, winnerId, "the racer adopts the winner, not its own provisional");
  const ent = await getEntity(db, provisional);
  assert.equal(ent.identity, "upload.jpg", "the rename rolled back — the provisional keeps its key");
  assert.deepEqual(reusable, [provisional], "the un-renamed provisional was handed back for later reuse");
  const { rows } = await db.query(
    "SELECT id FROM entities WHERE board_id=$1 AND identity=$2", [boardId, "emma watson"]);
  assert.equal(rows.length, 1, "exactly one entity holds the key");
});

test("resolveIdentity: five real concurrent racers converge on one entity (no duplicates)", async () => {
  const boardId = await seedBoard(db, "resolve-race-live");
  // The realistic path — genuine wall-clock concurrency, no shim. Whatever
  // interleaving occurs (path-A adopt or 23505 recovery), they must all agree
  // and mint exactly one entity.
  const ids = await Promise.all(
    Array.from({ length: 5 }, () => resolveIdentity(db, boardId, "priya patel", "Priya Patel", [], []))
  );
  assert.equal(new Set(ids).size, 1, "every racer resolved to the same id");
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM entities WHERE board_id=$1 AND identity=$2", [boardId, "priya patel"]);
  assert.equal(rows[0].n, 1, "no duplicate entity minted under concurrency");
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

// ── ghost-entity safety: withTx atomicity + the reaper (deep-dive finding #2) ─

test("extract membership write + reconcile roll back together on failure (no ghost)", async () => {
  const boardId = await seedBoard(db, "ghost-atomic");
  const winner = await createEntity(db, boardId, { identity: "winner", displayName: "Winner" });
  await seedInstance(boardId, winner, { name: "w.png", kind: "image" });
  const provisional = await createEntity(db, boardId, { identity: "prov.png" });
  const instId = await seedInstance(boardId, provisional, { name: "p.png", kind: "image" });

  // The extractOne pattern — move the instance, reconcile the emptied provisional
  // — but the transaction fails before commit (stand-in for a crash mid-write).
  await assert.rejects(
    withTx(db, async (client) => {
      await setItemEntities(client, instId, [winner]);
      await reconcileEntities(client, [provisional, winner]); // would delete the emptied provisional
      throw new Error("crash before commit");
    }),
    /crash before commit/
  );

  // Nothing moved: the provisional still exists and still owns its instance, so
  // re-extraction re-runs cleanly instead of stranding an emptied ghost.
  assert.ok(await getEntity(db, provisional), "the provisional survived the rollback");
  const { rows: [row] } = await db.query("SELECT entity_ids FROM items WHERE id=$1", [instId]);
  assert.deepEqual(row.entity_ids, [provisional], "the instance stayed put");
});

// Backdate an entity's stamp so the reaper's age floor treats it as settled.
const ageEntity = (id, ms) => db.query("UPDATE entities SET updated_at=$1 WHERE id=$2", [Date.now() - ms, id]);

test("reapEmptyEntities: drops a settled zero-instance ghost", async () => {
  const boardId = await seedBoard(db, "reap-ghost");
  const ghost = await createEntity(db, boardId, { identity: "ghost" });
  await ageEntity(ghost, 3600000); // an hour empty
  const n = await reapEmptyEntities(db, 1800000); // floor 30 min
  assert.ok(n >= 1);
  assert.equal(await getEntity(db, ghost), null, "the settled empty entity is reaped");
});

test("reapEmptyEntities: spares a freshly-empty entity (in-flight upload window)", async () => {
  const boardId = await seedBoard(db, "reap-fresh");
  const fresh = await createEntity(db, boardId, { identity: "fresh" }); // updated_at = now
  await reapEmptyEntities(db, 1800000);
  assert.ok(await getEntity(db, fresh), "a just-created empty entity is NOT reaped — its upload may still be inserting the instance");
});

test("reapEmptyEntities: spares entities that still have an instance, even when aged", async () => {
  const boardId = await seedBoard(db, "reap-nonempty");
  const solo = await createEntity(db, boardId, { identity: "solo", displayName: "Solo" });
  await seedInstance(boardId, solo, { name: "a.png", kind: "image" });
  const a = await createEntity(db, boardId, { identity: "a", displayName: "A" });
  const b = await createEntity(db, boardId, { identity: "b", displayName: "B" });
  const shared = await seedInstance(boardId, a, { name: "s.png", kind: "image" });
  await setItemEntities(db, shared, [a, b]); // one instance shared by two entities
  for (const id of [solo, a, b]) await ageEntity(id, 3600000); // aged, but populated

  await reapEmptyEntities(db, 1800000);
  assert.ok(await getEntity(db, solo), "sole-instance entity survives");
  assert.ok(await getEntity(db, a), "shared-instance entity a survives");
  assert.ok(await getEntity(db, b), "shared-instance entity b survives");
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
  await seedInstance(boardId, eid, { name: "m1.png", kind: "image" }, { mapping: { identity: { source: "extract", instruction: "x" }, fields: [] } });
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
