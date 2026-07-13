// Embedding sweep poison isolation: embedBatch's one-by-one fallback on a
// request-content 4xx, the embed_error skip marker, its clears (fresh tags,
// user edits, later success), and the defensive embedTextFor cap. The
// provider is stubbed at the fetch layer (OpenAI-compat /embeddings).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, seedBoard } from "./helpers.js";
import { itemsNeedingEmbedding, markTagged, setItemTags, embeddingStats } from "../server/db.js";
import { PROVIDERS } from "../server/providers.js";
import { embedBatch, embedTextFor } from "../server/worker.js";

let srv, db, boardId;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  boardId = await seedBoard(db, "embed-sweep");
});
after(() => srv.close());

const EMBEDDER = { provider: "openai", apiKey: "k", model: "text-embedding-3-small" };

async function insertTagged(description) {
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO items (board_id, payload, status, tags, tag_reasoning, created_at, updated_at)
     VALUES ($1, $2, 'tagged', '["a/b"]', $3, $4, $4) RETURNING id`,
    [boardId, JSON.stringify({ identity: "x", files: [], fields: {} }), JSON.stringify({ description }), Date.now()]
  );
  return id;
}
const row = async (id) =>
  (await db.query("SELECT embedding, embed_error FROM items WHERE id=$1", [id])).rows[0];

// Stub the OpenAI-compat embeddings endpoint. `reject` decides per input text;
// a rejected text 400s its whole request (exactly the provider behavior that
// used to wedge the sweep). Returns { restore, calls }.
function stubEmbeddings(reject = () => false, status = 400) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes("/embeddings")) return original(url, opts);
    const { input } = JSON.parse(opts.body);
    calls.push(input.length);
    if (input.some(reject)) {
      return { ok: false, status, json: async () => ({ error: { message: "rejected input" } }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ data: input.map((_, i) => ({ index: i, embedding: [1, 0] })), usage: {} }),
    };
  };
  return { restore: () => { globalThis.fetch = original; }, calls };
}

test("embedBatch: happy path is one call, all vectors stored", async () => {
  const a = await insertTagged("a clean item");
  const b = await insertTagged("another clean item");
  const rows = await itemsNeedingEmbedding(db, EMBEDDER.model, 64);
  const { restore, calls } = stubEmbeddings();
  try {
    const r = await embedBatch(db, EMBEDDER, rows);
    assert.equal(r.embedded, rows.length);
    assert.equal(r.skipped, 0);
    assert.equal(calls.length, 1, "one batched call");
  } finally { restore(); }
  assert.ok((await row(a)).embedding && (await row(b)).embedding);
});

test("embedBatch: a poison input is isolated and marked; innocents embed; the sweep moves on", async () => {
  const good1 = await insertTagged("a fine description");
  const poison = await insertTagged("POISON text the embedder rejects");
  const good2 = await insertTagged("another fine description");
  const rows = await itemsNeedingEmbedding(db, EMBEDDER.model, 64);
  assert.equal(rows.length, 3);

  const { restore } = stubEmbeddings((t) => t.includes("POISON"));
  let r;
  try { r = await embedBatch(db, EMBEDDER, rows); } finally { restore(); }
  assert.equal(r.embedded, 2);
  assert.equal(r.skipped, 1);

  assert.ok((await row(good1)).embedding && (await row(good2)).embedding);
  const p = await row(poison);
  assert.equal(p.embedding, null);
  assert.match(p.embed_error, /rejected input/);

  // The marker takes the item out of the work queue — no more wedge.
  assert.equal((await itemsNeedingEmbedding(db, EMBEDDER.model, 64)).length, 0);
  const stats = await embeddingStats(db, EMBEDDER.model);
  assert.equal(stats.failed, 1);

  // Fresh text is a fresh chance: both re-tag paths clear the marker.
  // (markTagged is fenced to claimed rows — stamp the in-flight status first.)
  await db.query("UPDATE items SET status='processing' WHERE id=$1", [poison]);
  await markTagged(db, poison, ["a/b"], false, { description: "rewritten" });
  assert.equal((await row(poison)).embed_error, null);
  assert.equal((await itemsNeedingEmbedding(db, EMBEDDER.model, 64)).length, 1);
  await db.query("UPDATE items SET embed_error='x' WHERE id=$1", [poison]);
  await setItemTags(db, poison, ["a/b"]);
  assert.equal((await row(poison)).embed_error, null);
  await db.query("UPDATE items SET embedding='\\x00', embedding_model=$1 WHERE id=$2", [EMBEDDER.model, poison]);
});

test("embedBatch: a config-shaped 400 (everything fails alone) throws and marks nothing", async () => {
  const a = await insertTagged("first");
  const b = await insertTagged("second");
  const rows = await itemsNeedingEmbedding(db, EMBEDDER.model, 64);
  const { restore } = stubEmbeddings(() => true); // every request 400s
  try {
    await assert.rejects(embedBatch(db, EMBEDDER, rows), /rejected input/);
  } finally { restore(); }
  for (const id of [a, b]) {
    assert.equal((await row(id)).embed_error, null, "no item wrongly blamed for a config error");
  }
  await db.query("UPDATE items SET status='failed' WHERE id = ANY($1)", [[a, b]]);
});

test("embedBatch: auth/rate statuses skip isolation entirely — straight to backoff", async () => {
  const a = await insertTagged("auth-blocked");
  const rows = await itemsNeedingEmbedding(db, EMBEDDER.model, 64);
  const { restore, calls } = stubEmbeddings(() => true, 401);
  try {
    await assert.rejects(embedBatch(db, EMBEDDER, rows), /rejected input/);
  } finally { restore(); }
  assert.equal(calls.length, 1, "no one-by-one probing on a 401");
  assert.equal((await row(a)).embed_error, null);
  await db.query("UPDATE items SET status='failed' WHERE id=$1", [a]);
});

test("embedTextFor: capped under the tightest provider input limit", () => {
  const text = embedTextFor([], { description: "long ".repeat(5000) }, {});
  assert.ok(text.length <= 8000);
  assert.ok(text.startsWith("long "), "truncated, not mangled");
});

// ── outbound deadline ────────────────────────────────────────────────────────

test("compat embed call aborts on a hung provider instead of wedging the tick", async () => {
  // A server that accepts the connection and never responds — the hang undici
  // would otherwise ride out for its 5-minute headers timeout, single-flight.
  const hung = http.createServer(() => { /* never respond */ });
  await new Promise((r) => hung.listen(0, "127.0.0.1", r));
  process.env.AI_EMBED_TIMEOUT_MS = "100";
  try {
    await assert.rejects(
      PROVIDERS.openai.wire.embed(
        { base: `http://127.0.0.1:${hung.address().port}`, label: "OpenAI", name: "openai" },
        { apiKey: "k", model: "m", texts: ["a"] }
      ),
      /timeout|abort/i
    );
  } finally {
    delete process.env.AI_EMBED_TIMEOUT_MS;
    hung.close();
  }
});
