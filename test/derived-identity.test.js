// Derived identity on the entity/instance model: buildFieldsPrompt with the
// card key (planning/card-key-plan.md), mapping validation for the card slot
// and per-field options, list-field landing, entity helpers
// (create/lookup/rename/re-parent/empty-delete), the instance remove route,
// per-instance reasoning, and entity-level reprocess.
// No live AI — the merge/split paths' worker wiring is exercised in the live
// verify; the DB mechanics they compose are covered here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, seedItem, req, routedStatus } from "./helpers.js";
import { buildFieldsPrompt, resolveIdentity, landListValues, extractFieldsOf, cardFieldOf } from "../server/worker.js";
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
  reprocessBoard,
  reapEmptyEntities,
  withTx,
  insertItem,
  createBoard,
  objectKeysOf,
} from "../server/db.js";

// ─── pure: buildFieldsPrompt with a card key ─────────────────────────────────

const CARD = (instruction, extra = []) => ({
  card: { by: "person" },
  fields: [
    { key: "role", kind: "text", source: "extract", instruction: "job title" },
    { key: "person", kind: "text", source: "extract", ...(instruction ? { instruction } : {}) },
    ...extra,
  ],
});

test("buildFieldsPrompt: the card field is committed to first, wherever it sits in fields[]", () => {
  const { schema, systemText } = buildFieldsPrompt(CARD("the person's full name"));

  assert.deepEqual(schema.required, ["person", "role"]);
  assert.deepEqual(extractFieldsOf(CARD("x")).map((f) => f.key), ["person", "role"]);
  assert.equal(cardFieldOf(CARD("x")).key, "person");

  // Shape: why-before-value, nullable string, the user's instruction as the
  // description — an ordinary field, no `identity` property anywhere.
  const p = schema.properties.person;
  assert.deepEqual(p.required, ["why", "value"]);
  assert.equal(Object.keys(p.properties)[0], "why");
  assert.deepEqual(p.properties.value.type, ["string", "null"]);
  assert.equal(p.description, "the person's full name");
  assert.equal(schema.properties.identity, undefined);

  // The card field's line leads, carries the user's words, and ends with the
  // consistency clause (merge/split needs same subject → same value) — with
  // no competing "unique key" framing to override the user's format.
  assert.match(systemText, /- person \(text\): the person's full name — the same subject must always produce the same value/);
  assert.ok(systemText.indexOf("- person") < systemText.indexOf("- role"));
  assert.doesNotMatch(systemText, /- role \(text\): job title — the same subject/);
  assert.doesNotMatch(systemText, /unique key/);
});

test("buildFieldsPrompt: an instruction-less card field falls back to its key, plus the consistency clause", () => {
  const { systemText, schema } = buildFieldsPrompt(CARD(null));
  assert.match(systemText, /- person \(text\): person — the same subject must always produce the same value/);
  assert.equal(schema.properties.person.description, "person");
});

test("buildFieldsPrompt: no card slot → plain fields in mapping order, no clause", () => {
  const { schema, systemText } = buildFieldsPrompt({ card: null, fields: CARD("x").fields });
  assert.deepEqual(schema.required, ["role", "person"]);
  assert.doesNotMatch(systemText, /same subject/);
  assert.equal(cardFieldOf({ fields: CARD("x").fields }), null);
});

test("buildFieldsPrompt: a card pointing at a non-extract key is ignored (validation refuses it upstream)", () => {
  const mapping = { card: { by: "size" }, fields: [{ key: "size", kind: "number", source: "file", fn: "file_size" }, { key: "x", kind: "text", source: "extract" }] };
  assert.equal(cardFieldOf(mapping), null);
  assert.deepEqual(buildFieldsPrompt(mapping).schema.required, ["x"]);
});

// ─── options on a field (the old classify mode, now generic) ─────────────────

test("buildFieldsPrompt: options turn a field into a closed multi-select enum", () => {
  const mapping = CARD("which Emma this resembles");
  mapping.fields[1].options = [
    { value: "Emma Watson", hint: "British actress" },
    { value: "Emma Roberts" },
    { value: "Emma Stone" },
  ];
  const { schema, systemText } = buildFieldsPrompt(mapping);
  const p = schema.properties.person;
  // why + values[] (not the scalar `value`), values constrained to the enum.
  assert.deepEqual(p.required, ["why", "values"]);
  assert.equal(p.properties.value, undefined);
  assert.equal(p.properties.values.type, "array");
  assert.deepEqual(p.properties.values.items.enum, ["Emma Watson", "Emma Roberts", "Emma Stone"]);
  assert.equal(schema.required[0], "person");
  // The per-option hints ride in the prompt (the enum can't carry them).
  assert.match(systemText, /- Emma Watson: British actress/);
  // Cardinality is stated by the system, not left to the user's prose: multi +
  // conservatism, and an explicit counter to a "closest single match" reading.
  assert.match(systemText, /an item can match more than one/);
  assert.match(systemText, /not only the closest single match/);
  // A list field carries no kind in its line (the options ARE its format) and
  // no consistency clause (the list already makes the answer consistent).
  assert.doesNotMatch(systemText, /- person \(text\)/);
  assert.doesNotMatch(systemText, /same subject/);
});

test("buildFieldsPrompt: options on a NON-card field work the same way", () => {
  const mapping = { fields: [{ key: "genre", kind: "text", source: "extract", instruction: "the genre", options: [{ value: "Jazz" }, { value: "Folk" }] }] };
  const { schema } = buildFieldsPrompt(mapping);
  assert.deepEqual(schema.properties.genre.properties.values.items.enum, ["Jazz", "Folk"]);
});

test("buildFieldsPrompt: an empty options array stays open extraction (scalar value)", () => {
  const mapping = CARD("the name");
  mapping.fields[1].options = [];
  const { schema } = buildFieldsPrompt(mapping);
  assert.deepEqual(schema.properties.person.properties.value.type, ["string", "null"]);
  assert.equal(schema.properties.person.properties.values, undefined);
});

test("landListValues: filters to the options on the normalised key, spells them the option's way, dedupes", () => {
  const field = { options: [{ value: "Emma Watson" }, { value: "Emma Stone" }] };
  assert.deepEqual(landListValues(field, ["emma_watson", "Emma Stone", "Emma Watson", "Emma Roberts", 7]), ["Emma Watson", "Emma Stone"]);
  assert.deepEqual(landListValues(field, "Emma Watson"), [], "a non-array answer is 'matches none'");
  assert.deepEqual(landListValues(field, undefined), []);
});

test("objectKeysOf: a list field's array is NOT a detected-object field (kind: \"list\")", () => {
  const fields = {
    cat: { v: [{ label: "cat", box: [0, 0, 1, 1] }], why: "Detected: cat" },
    empty: { v: [], why: "No objects detected" },
    person: { v: ["Emma Watson"], why: "she is", kind: "list" },
    none: { v: [], why: "nobody", kind: "list" },
    name: { v: "x", why: "y" },
    size: { v: 12, why: "", src: "file", kind: "number" },
  };
  assert.deepEqual(objectKeysOf(fields), ["cat"]);
});

// ─── mapping validation: options on fields ───────────────────────────────────

test("mapping PATCH: field options validate, dedup by normalised key, and reject bad shapes", async () => {
  const { json: board } = await createBoardReq("id-candidates");
  const withOptions = (options, key = "person") => ({
    card: { by: "person" },
    fields: [{ key, kind: "text", source: "extract", instruction: "which person", options }],
  });
  // Valid: a text extract field with options — as the card key or not.
  assert.equal((await patchBoard(board.id, {
    mapping: withOptions([{ value: "Emma Watson", hint: "British" }, { value: "Emma Roberts" }]),
  })).status, 200);
  assert.equal((await patchBoard(board.id, {
    mapping: { fields: [{ key: "genre", kind: "text", source: "extract", options: [{ value: "Jazz" }] }] },
  })).status, 200);

  // Duplicate by normalised key ("Emma  Watson" → "emma watson") is rejected.
  const dup = await patchBoard(board.id, {
    mapping: withOptions([{ value: "Emma Watson" }, { value: "emma  watson" }]),
  });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error, /duplicate option/);

  // An option without a value is rejected.
  assert.equal((await patchBoard(board.id, { mapping: withOptions([{ hint: "no value" }]) })).status, 400);
  // Not an array; too many.
  assert.equal((await patchBoard(board.id, { mapping: withOptions("x") })).status, 400);
  assert.equal((await patchBoard(board.id, {
    mapping: withOptions(Array.from({ length: 201 }, (_, i) => ({ value: `v${i}` }))),
  })).status, 400);
});

test("mapping PATCH: options persist on the field for extraction to read", async () => {
  const { json: board } = await createBoardReq("id-candidates-persist");
  await patchBoard(board.id, {
    mapping: { card: { by: "person" }, fields: [{ key: "person", kind: "text", source: "extract", instruction: "which person", options: [{ value: "Ada Lovelace" }] }] },
  });
  const { rows: [b] } = await db.query("SELECT mapping FROM boards WHERE id=$1", [board.id]);
  assert.deepEqual(b.mapping.card, { by: "person" });
  assert.deepEqual(b.mapping.fields[0].options, [{ value: "Ada Lovelace" }]);
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

// ── validateMapping: the card slot ───────────────────────────────────────────

test("mapping PATCH: a card key naming an extract field is valid, with or without an instruction", async () => {
  const { json: board } = await createBoardReq("id-valid");
  assert.equal((await patchBoard(board.id, {
    mapping: { card: { by: "name" }, fields: [{ key: "name", kind: "text", source: "extract", instruction: "full name" }] },
  })).status, 200);
  assert.equal((await patchBoard(board.id, {
    mapping: { card: { by: "name" }, fields: [{ key: "name", kind: "text", source: "extract" }] },
  })).status, 200, "the instruction is optional on a field, card key or not");
});

test("mapping PATCH: card null / absent (one card per file) is valid", async () => {
  const { json: board } = await createBoardReq("id-raw");
  assert.equal((await patchBoard(board.id, { mapping: { card: null, fields: [] } })).status, 200);
  assert.equal((await patchBoard(board.id, { mapping: { fields: [] } })).status, 200);
});

test("mapping PATCH: a connector board carries no card slot — the connector owns the card", async () => {
  const { json: board } = await createBoardReq("id-connector");
  assert.equal((await patchBoard(board.id, {
    mapping: { input: { connector: "crypto" }, fields: [] },
  })).status, 200);
  const r = await patchBoard(board.id, {
    mapping: { input: { connector: "crypto" }, card: { by: "x" }, fields: [{ key: "x", kind: "text", source: "extract" }] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not allowed with an input/);
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

test("reprocessBoard: every instance on the board re-enters the pipeline, board-scoped; the admin route wraps it", async () => {
  const boardId = await seedBoard(db, "reprocess-board");
  const other = await seedBoard(db, "reprocess-board-other");
  const a = await createEntity(db, boardId, { identity: "a", displayName: "A" });
  const b = await createEntity(db, boardId, { identity: "b", displayName: "B" });
  const o = await createEntity(db, other, { identity: "o" });
  const mapping = { card: { by: "who" }, fields: [{ key: "who", kind: "text", source: "extract", instruction: "x" }] };
  await seedInstance(boardId, a, { name: "a1.png", kind: "image" }, { mapping });
  await seedInstance(boardId, b, { name: "b1.png", kind: "image" }); // no stamp → tag leg
  await seedInstance(other, o, { name: "o1.png", kind: "image" }, { mapping });

  assert.equal(await reprocessBoard(db, boardId), 2);
  const { rows } = await db.query("SELECT payload->'files'->0->>'name' AS name, status FROM items WHERE board_id=$1 ORDER BY id", [boardId]);
  assert.deepEqual(rows, [{ name: "a1.png", status: "pending_extract" }, { name: "b1.png", status: "pending" }]);
  const { rows: [untouched] } = await db.query("SELECT status FROM items WHERE board_id=$1", [other]);
  assert.equal(untouched.status, "tagged", "the other board is not swept");
  assert.equal(await reprocessBoard(db, "00000000-0000-4000-8000-000000000000"), null);

  // The route: admin only, 404 for a board that isn't there.
  await db.query("UPDATE items SET status='tagged' WHERE board_id=$1", [boardId]);
  const r = await req(base, "POST", `/api/admin/boards/${boardId}/reprocess`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.queued, 2);
  // …and the answer carries the queue it just filled, leg by leg, in the
  // shape every other work carrier serves (instance-work-plan.md): the
  // stamped instance waits to extract, the unstamped one to tag.
  assert.deepEqual(r.json.work, {
    running: [],
    queued: [
      { kind: "extract", n: 1, label: "Extraction", leg: true },
      { kind: "tag", n: 1, label: "Tagging", leg: true },
    ],
  });
  assert.equal((await req(base, "POST", `/api/admin/boards/00000000-0000-4000-8000-000000000000/reprocess`, { sid: admin.sid })).status, 404);
});

test("reprocess restarts mapped instances at the extract leg, plain ones at tagging", async () => {
  const boardId = await seedBoard(db, "reprocess-mapped");
  const eid = await createEntity(db, boardId, { identity: "mixed", displayName: "Mixed" });
  // Mapped instance re-derives identity + fields (pending_extract); a plain one
  // (no stamped mapping) just re-tags (pending).
  await seedInstance(boardId, eid, { name: "m1.png", kind: "image" }, { mapping: { card: { by: "who" }, fields: [{ key: "who", kind: "text", source: "extract", instruction: "x" }] } });
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
  assert.equal(routedStatus(r, eid), "pending");

  const { rows: [item] } = await db.query("SELECT status, tags FROM items WHERE id=$1", [instId]);
  assert.equal(item.status, "pending");
  assert.deepEqual(item.tags, []);
  // Identity is the extract leg's job — retag must not touch it.
  const { rows: [ent] } = await db.query("SELECT identity, display_name FROM entities WHERE id=$1", [eid]);
  assert.equal(ent.identity, "volvo amazon");
  assert.equal(ent.display_name, "Volvo Amazon");
});

test("entity retag (3c): every instance re-enters the tag leg; scoped takes only settled+decided", async () => {
  // Two facets on purpose: readFacetScope normalises an every-facet scope to a
  // full pass, so a one-facet board can never exercise the scoped arm.
  const boardId = await createBoard(db, "retag-entity", [
    { key: "category", label: "Category", values: ["blue", "red"] },
    { key: "mood", label: "Mood", values: ["calm", "loud"] },
  ], "", true, null, null, { enabled: true });
  const eid = await createEntity(db, boardId, { identity: "card", displayName: "Card" });
  const settled = await seedInstance(boardId, eid, { name: "a.png", kind: "image" });
  await db.query("UPDATE items SET tags='[\"category/blue\"]'::jsonb WHERE id=$1", [settled]);
  const inflight = await seedInstance(boardId, eid, { name: "b.png", kind: "image" });
  await db.query("UPDATE items SET status='processing' WHERE id=$1", [inflight]);

  // Scoped: only the settled, decided instance moves; the in-flight one is untouched.
  const scoped = await req(base, "POST", `/api/items/${eid}/retag`, { sid: admin.sid, body: { facets: ["category"] } });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.json.facets, ["category"]);
  const st = async (id) => (await db.query("SELECT status, tag_facets FROM items WHERE id=$1", [id])).rows[0];
  assert.deepEqual(await st(settled), { status: "pending", tag_facets: ["category"] });
  assert.equal((await st(inflight)).status, "processing", "an in-flight instance is not yanked");

  // Full: everything re-enters the tag leg (no status fence — scope dies too).
  const full = await req(base, "POST", `/api/items/${eid}/retag`, { sid: admin.sid });
  assert.equal(full.status, 200);
  assert.equal(full.json.entities.find((e) => e.id === eid).status, "pending");
  assert.deepEqual(await st(settled), { status: "pending", tag_facets: null });

  // Scoped with nothing settled+decided → 409, matching the instance route.
  const none = await req(base, "POST", `/api/items/${eid}/retag`, { sid: admin.sid, body: { facets: ["category"] } });
  assert.equal(none.status, 409);
});

test("tag edit reports the server aggregate — a failed sibling outranks the fresh tag", async () => {
  const boardId = await seedBoard(db, "tagedit-agg");
  const eid = await createEntity(db, boardId, { identity: "agg" });
  const a = await seedInstance(boardId, eid, { name: "a.png", kind: "image" });
  const b = await seedInstance(boardId, eid, { name: "b.png", kind: "image" });
  await db.query("UPDATE items SET status='failed' WHERE id=$1", [b]);

  const r = await req(base, "PATCH", `/api/instances/${a}/tags`, { sid: admin.sid, body: { tags: ["kind/a"] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.tags, ["kind/a"]);
  // STATUS_PRIORITY says failed outranks tagged; the client rule this route's
  // report replaced called all-tagged-plus-one-failed "tagged".
  assert.equal(routedStatus(r, eid), "failed");
});

test("retag: the routed report covers every entity sharing the instance (classify mode)", async () => {
  // One instance claimed by two entities: re-queuing it moves BOTH cards'
  // aggregates, and the response must say so — reporting one card would
  // rebuild the client's status guessing one level up.
  const boardId = await seedBoard(db, "retag-shared");
  const e1 = await createEntity(db, boardId, { identity: "sedan", displayName: "Sedan" });
  const e2 = await createEntity(db, boardId, { identity: "blue", displayName: "Blue" });
  const shared = await seedInstance(boardId, e1, { name: "s1.png", kind: "image" });
  await setItemEntities(db, shared, [e1, e2]); // the write classify mode itself uses
  // A second, settled instance only on e2 — its status must ride into e2's report untouched.
  await seedInstance(boardId, e2, { name: "s2.png", kind: "image" });

  const r = await req(base, "POST", `/api/instances/${shared}/retag`, { sid: admin.sid });
  assert.equal(r.status, 200);
  const byId = new Map(r.json.entities.map((e) => [e.id, e]));
  assert.deepEqual([...byId.keys()].sort(), [e1, e2].sort(), "both sharing entities are reported");
  assert.equal(byId.get(e1).status, "pending");
  assert.equal(byId.get(e2).status, "pending", "an in-flight instance outranks a settled sibling");
  assert.deepEqual(
    byId.get(e2).instances.map((i) => i.status).sort(),
    ["pending", "tagged"],
    "e2's report carries the untouched sibling too"
  );
});
