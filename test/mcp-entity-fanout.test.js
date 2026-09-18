// One instance, several entities (planning/mcp-stage-3.md §1).
//
// Vectors are stored per INSTANCE; every consumer speaks in ENTITY ids. That
// translation used to be `entity_ids[1]`, which is right only in extract mode.
// In classify mode one photo of two people is one instance with two entities,
// and the second one fell off the world: never returned by /api/search, absent
// from the clusters carving, and — loudest — answered "item not embedded yet"
// by /api/search/similar although its instance carries a perfectly good vector.
//
// Every assertion below FAILS against `entity_ids[1]`. The fixture is built so
// that it must: entity B is always SECOND in the array, and the instance it
// shares with A is its ONLY vector. A fixture where B is first, or has a
// private instance too, passes against the bug and proves nothing — the same
// trap stage 2 §12.1 fell into.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedUser, seedBoard, req } from "./helpers.js";
import { createAiKey, setSetting, setPluginState, setItemEmbedding, createEntity } from "../server/db.js";

let srv, db;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
});
after(() => srv.close());

const MODEL = "text-embedding-3-small";

// The OpenAI-compat /embeddings endpoint. Every query embeds to [1, 0], so a
// stored [1, 0] scores 1.0 and a stored [0, 1] scores 0.0 — far enough apart
// that /api/search's relative cutoff keeps only the ones we mean.
function stubEmbeddings() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes("/embeddings")) return original(url, opts);
    const { input } = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({
        data: input.map((_, i) => ({ index: i, embedding: [1, 0] })),
        usage: { prompt_tokens: input.length * 10 },
      }),
    };
  };
  return () => { globalThis.fetch = original; };
}

async function withEmbedder(fn) {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, `fanout-${Date.now()}`, "openai", "sk-test");
  await setSetting(db, "embed_key_id", String(keyId));
  await setSetting(db, "embed_enabled", "1");
  const restore = stubEmbeddings();
  try { await fn(); } finally {
    restore();
    await setSetting(db, "embed_enabled", "0");
    await setSetting(db, "embed_key_id", null);
  }
}

// An instance belonging to exactly the entities named, in the order named.
// `identity` in the payload is a FILENAME on purpose: on a derived board that
// is what an instance carries while its entity is called something readable,
// which is the second half of the fix (§1.3).
async function insertInstance(board, entityIds, vec, file) {
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO items (board_id, entity_ids, payload, status, tags, tag_reasoning, created_at, updated_at)
     VALUES ($1, $2::bigint[], $3, 'tagged', '["a/b"]', $4, $5, $5) RETURNING id`,
    [board, entityIds, JSON.stringify({ identity: file, files: [{ name: file, original_name: file }] }),
     JSON.stringify({ description: "a shared photo" }), Date.now()]
  );
  await setItemEmbedding(db, id, new Float32Array(vec), MODEL);
  return id;
}

test("a shared instance scores for EVERY entity it belongs to, not just the first", async () => {
  const member = await seedUser(db, "fanout@test.local");
  const board = await seedBoard(db, "fanout-board", [member.id]);
  await withEmbedder(async () => {
    const a = await createEntity(db, board, { identity: "alpha person", displayName: "Alpha Person" });
    const b = await createEntity(db, board, { identity: "beta person", displayName: "Beta Person" });
    const solo = await createEntity(db, board, { identity: "gamma person" });
    // B is SECOND, and this is the only instance it has. Under entity_ids[1]
    // it owns no vector anywhere in the system.
    await insertInstance(board, [a, b], [1, 0], "9f3c1d.jpg");
    await insertInstance(board, [solo], [0, 1], "aa11bb.jpg");

    const search = await req(srv.base, "GET", `/api/search?board=${board}&q=two people`, { sid: member.sid });
    assert.equal(search.status, 200);
    const hits = search.json.results.map((x) => Number(x.id)).sort((x, y) => x - y);
    assert.deepEqual(hits, [a, b].sort((x, y) => x - y), "both entities of the shared instance come back");

    // The sharpest symptom: B's own card reports its own photo as missing.
    const sim = await req(srv.base, "GET", `/api/search/similar?board=${board}&item=${b}`, { sid: member.sid });
    assert.equal(sim.status, 200, "B is embedded — through the instance it shares with A");
    const ids = sim.json.results.map((x) => Number(x.id));
    assert.ok(ids.includes(b), "B leads its own results");
    assert.ok(ids.includes(a), "and A rides the same instance at the same score");
    assert.ok(Math.abs(sim.json.results.find((x) => Number(x.id) === b).score - 1) < 1e-6);

    // A's anchor and B's anchor are the same vector, so they see the same world.
    const simA = await req(srv.base, "GET", `/api/search/similar?board=${board}&item=${a}`, { sid: member.sid });
    assert.deepEqual(
      simA.json.results.map((x) => Number(x.id)).sort((x, y) => x - y),
      ids.sort((x, y) => x - y)
    );
  });
});

test("the clusters carving places every entity, and names them from the entity, not the file", async () => {
  const member = await seedUser(db, "fanout-carve@test.local");
  const board = await seedBoard(db, "fanout-carve-board", [member.id]);
  await withEmbedder(async () => {
    // 20 entities out of 19 instances: 18 private, plus one instance shared by
    // two. n >= MIN_GROUP * 2 is what makes the route carve at all.
    const shared = [
      await createEntity(db, board, { identity: "alpha person" }),
      await createEntity(db, board, { identity: "beta person" }),
    ];
    await insertInstance(board, shared, [1, 0], "9f3c1d.jpg");
    const solos = [];
    for (let i = 0; i < 18; i++) {
      const e = await createEntity(db, board, { identity: `person ${i}` });
      solos.push(e);
      await insertInstance(board, [e], i < 9 ? [1, 0] : [0, 1], `file-${i}.jpg`);
    }

    const r = await req(srv.base, "GET", `/api/boards/${board}/meaning-clusters?level=1`, { sid: member.sid });
    assert.equal(r.status, 200);
    const placed = new Set(r.json.sets.map(([id]) => Number(id)));
    assert.equal(placed.size, 20, "20 entities from 19 instances — both halves of the shared one");
    for (const id of [...shared, ...solos]) assert.ok(placed.has(id), `entity ${id} was carved`);

    // Every title names an ENTITY — by its identity, spelled out. Asserting
    // only "not a filename" is too weak: it also passes on a bare entity id,
    // which is what the old naming degrades to once the payload columns go.
    const known = new Set(["alpha person", "beta person", ...solos.map((_, i) => `person ${i}`)]);
    for (const v of r.json.values) {
      if (v.value === "unclassified") continue;
      const named = /^most typical: (.+)$/.exec(v.title)?.[1];
      assert.ok(known.has(named), `title named the entity, got ${JSON.stringify(v.title)}`);
    }
  });
});
