// The field-source model (planning/field-sources-plan.md): the source table's
// aiWork gate, migration 0038's old-shape → new-shape transform (pure — the
// transform is exported from the migration file itself, since migrations never
// import app code), and the two pieces that need the database: 0038's `up`
// rewriting boards AND the per-item stamped copies, and validateMapping's
// per-def rules exercised over the live PATCH route.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FIELD_SOURCE, FIELD_SOURCE_DEFS, aiWork } from "../server/field-sources.js";
import { transformMapping, up } from "../server/migrations/0038_field_sources.js";
import { startServer, adminSession, req } from "./helpers.js";
import { createEntity, insertItem } from "../server/db.js";

let srv, db, base, admin;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});
after(() => srv.close());

// ─── the table ───────────────────────────────────────────────────────────────

test("field-source table: ids unique, capability ids only on inferred sources", () => {
  const ids = FIELD_SOURCE_DEFS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(FIELD_SOURCE.connector.capability, null);
  assert.equal(FIELD_SOURCE.file.capability, null);
  assert.equal(FIELD_SOURCE.extract.capability, "extract");
  assert.equal(FIELD_SOURCE.detect.capability, "detect");
});

test("aiWork: extract identity, extract/detect fields yes; connector/file no", () => {
  assert.equal(aiWork(null), false);
  assert.equal(aiWork({ fields: [] }), false);
  assert.equal(aiWork({ identity: { source: "extract", instruction: "x" }, fields: [] }), true);
  assert.equal(aiWork({ identity: { source: "connector" }, fields: [] }), false);
  assert.equal(aiWork({ fields: [{ key: "a", kind: "text", source: "extract" }] }), true);
  assert.equal(aiWork({ fields: [{ key: "a", source: "detect" }] }), true);
  assert.equal(aiWork({
    fields: [
      { key: "p", kind: "number", source: "connector", fn: "price" },
      { key: "s", kind: "number", source: "file", fn: "file_size" },
    ],
  }), false);
});

// ─── migration 0038 transform ────────────────────────────────────────────────

test("0038: full old-shape board converts — every rename in one mapping", () => {
  const old = {
    input: { connector: "crypto" },
    identity: { from: "ai", hint: "which person", candidates: [{ value: "Ada" }, { value: "Grace", hint: "the other one" }] },
    face: { from: "connector", producer: "chart", period: "1y", live: true, every: 60 },
    fields: [
      { key: "price", kind: "number", from: "connector", fn: "price", live: true, every: 15 },
      { key: "rank", kind: "number", from: "connector", fn: "rank" },
      { key: "pages", kind: "number", from: "file", fn: "pages" },
      { key: "role", kind: "text", from: "ai", hint: "job title" },
      { key: "cat", kind: "object", from: "ai", hint: "cat, kitten" },
    ],
  };
  assert.deepEqual(transformMapping(old), {
    input: { connector: "crypto" },
    identity: { source: "extract", instruction: "which person", options: [{ value: "Ada" }, { value: "Grace", hint: "the other one" }] },
    face: { source: "connector", producer: "chart", period: "1y", refresh: { every: 60 } },
    fields: [
      { key: "price", kind: "number", source: "connector", fn: "price", refresh: { every: 15 } },
      { key: "rank", kind: "number", source: "connector", fn: "rank" },
      { key: "pages", kind: "number", source: "file", fn: "pages" },
      { key: "role", kind: "text", source: "extract", instruction: "job title" },
      { key: "cat", source: "detect", instruction: "cat, kitten" }, // kind:"object" dies with the disguise
    ],
  });
});

test("0038: raw slots and input:'files' become absence, not pseudo-sources", () => {
  const out = transformMapping({
    input: "files",
    identity: { from: "raw" },
    face: { from: "raw" },
    fields: [],
  });
  assert.deepEqual(out, { fields: [] });
  assert.ok(!("identity" in out) && !("face" in out) && !("input" in out));
});

test("0038: file face keeps prefer/pick; ai identity without candidates gets no options", () => {
  assert.deepEqual(transformMapping({
    identity: { from: "ai", hint: "the invoice month" },
    face: { from: "file", prefer: "image", pick: "latest" },
    fields: [],
  }), {
    identity: { source: "extract", instruction: "the invoice month" },
    face: { source: "file", prefer: "image", pick: "latest" },
    fields: [],
  });
});

test("0038: idempotent — a new-shape mapping passes through unchanged", () => {
  const fresh = {
    input: { connector: "stocks" },
    identity: { source: "connector" },
    face: { source: "connector", producer: "chart", period: "1y" },
    fields: [
      { key: "price", kind: "number", source: "connector", fn: "price", refresh: { every: 5 } },
      { key: "thesis", kind: "text", source: "extract", instruction: "one sentence" },
      { key: "logo", source: "detect", instruction: "logo" },
    ],
  };
  assert.deepEqual(transformMapping(fresh), fresh);
  assert.deepEqual(transformMapping(transformMapping(fresh)), fresh);
});

test("0038: null/garbage in, unchanged out", () => {
  assert.equal(transformMapping(null), null);
  assert.equal(transformMapping(undefined), undefined);
});

// ─── validateMapping: per-def rules over the live route ─────────────────────
// The rules that exist ONLY in the table-driven validator — the ones the old
// hand-enumerated tests (extraction/media/liveness/faces) never had to state.

test("validateMapping: per-def rejections come from the source table", async () => {
  const { json: b } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "vm-defs" } });
  const patch = (mapping) => req(base, "PATCH", `/api/admin/boards/${b.id}`, { sid: admin.sid, body: { mapping } });

  const cases = [
    ["a source the table doesn't know",
      { fields: [{ key: "x", kind: "text", source: "vibes" }] }, /unsupported source/],
    ["kind on a detect field — occurrences, not a scalar",
      { fields: [{ key: "x", kind: "text", source: "detect" }] }, /carries no kind/],
    ["extract field without a kind",
      { fields: [{ key: "x", source: "extract" }] }, /invalid kind/],
    ["instruction on a source that takes none",
      { input: { connector: "crypto" }, identity: { source: "connector" },
        fields: [{ key: "price", kind: "number", source: "connector", fn: "price", instruction: "why" }] },
      /takes no instruction/],
    ["a 13th detect field — detect carries its own cap",
      { fields: Array.from({ length: 13 }, (_, i) => ({ key: `d${i}`, source: "detect" })) },
      /at most 12 detect/],
    ["refresh on a file face — a static file has nothing to refresh",
      { identity: { source: "extract", instruction: "t" }, face: { source: "file", refresh: { every: 5 } }, fields: [] },
      /file face has no "refresh"/],
    ["a connector identity on a files board — nothing to pull the name from",
      { identity: { source: "connector" }, fields: [] },
      /connector identity requires a connector input/],
    ["a connector field on a files board — the refresh sweep would have no domain to pull from",
      { fields: [{ key: "price", kind: "number", source: "connector", fn: "price" }] },
      /connector field "price" requires a connector input/],
    ["a source that binds fields but not the identity slot (def.slots)",
      { identity: { source: "detect", instruction: "cat" }, fields: [] },
      /identity\.source must be/],
    ["a source that binds fields but not the face slot (def.slots)",
      { face: { source: "extract" }, fields: [] },
      /face\.source must be/],
  ];
  for (const [what, mapping, err] of cases) {
    const r = await patch(mapping);
    assert.equal(r.status, 400, what);
    assert.match(r.json.error, err, what);
  }

  // The deliberate asymmetry: the server ACCEPTS a detect field on a connector
  // board (its def carries no filesOnly — it would collect nothing, not mean
  // nothing); only the pane withholds the offer client-side.
  const ok = await patch({
    input: { connector: "crypto" }, identity: { source: "connector" },
    fields: [{ key: "logo", source: "detect", instruction: "logo" }],
  });
  assert.equal(ok.status, 200);
});

// ─── migration 0038 against the database ────────────────────────────────────
// Kept last in the file: `up` sweeps every board and stamped item in this
// database (cf. faces.test.js's 0035 test, same convention).

test("0038 up(): rewrites boards.mapping AND the per-item stamped copy, idempotently", async () => {
  const OLD = {
    input: "files",
    identity: { from: "ai", hint: "who is this", candidates: [{ value: "Ada" }] },
    face: { from: "file", prefer: "image", pick: "latest" },
    fields: [
      { key: "role", kind: "text", from: "ai", hint: "job title" },
      { key: "cat", kind: "object", from: "ai", hint: "cat" },
      { key: "size", kind: "number", from: "file", fn: "file_size" },
    ],
  };
  const NEW = transformMapping(OLD); // shape pinned by the pure tests above

  const { json: b } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "mig-38" } });
  // Written raw: this is historical data, not a shape the API must still take.
  await db.query("UPDATE boards SET mapping=$1 WHERE id=$2", [JSON.stringify(OLD), b.id]);
  const eid = await createEntity(db, b.id, { identity: "ada" });
  const stamped = await insertItem(db, b.id, { identity: "ada", files: [], fields: {}, mapping: OLD }, "held", eid);
  const plain = await insertItem(db, b.id, { identity: "ada", files: [], fields: {} }, "held", eid);

  await up(db);

  const { rows: [board] } = await db.query("SELECT mapping FROM boards WHERE id=$1", [b.id]);
  assert.deepEqual(board.mapping, NEW);
  const payloadOf = async (id) => (await db.query("SELECT payload FROM items WHERE id=$1", [id])).rows[0].payload;
  const p = await payloadOf(stamped);
  assert.deepEqual(p.mapping, NEW, "the stamp is rewritten too — extract replay and the db.js routing predicates read it");
  assert.equal(p.identity, "ada", "the rest of the payload rides through untouched");
  assert.ok(!("mapping" in (await payloadOf(plain))), "an unstamped item is not visited");

  await up(db); // a re-run (crash replay) must pass the new shape through untouched
  assert.deepEqual((await payloadOf(stamped)).mapping, NEW);
});
