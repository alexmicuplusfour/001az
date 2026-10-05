// Embedding sweep poison isolation: embedBatch's one-by-one fallback on a
// request-content 4xx, the embed_error skip marker, its clears (fresh tags,
// user edits, later success), and the defensive embedTextFor cap — plus the
// Stage 5a metering: every paid embed call lands on the board it embedded
// for, from the usage the wire actually reported. Then who is due and what
// they're embedded from (field-embedding-plan.md Stage 1). The provider is
// stubbed at the fetch layer (OpenAI-compat /embeddings).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, adminSession, seedUser, seedBoard, req, meterTotals } from "./helpers.js";
import { itemsNeedingEmbedding, markTagged, markExtracted, setItemTags, embeddingStats, createAiKey, setSetting, setPluginState, setItemEmbedding } from "../server/db.js";
import { PROVIDERS, aiKeyBucket, registerProvider, unregisterProvider } from "../server/providers.js";
import { embedBatch, embedTextFor, embedResource } from "../server/worker.js";
import { maxFor } from "../server/resource-pool.js";

let srv, db, boardId;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  boardId = await seedBoard(db, "embed-sweep");
});
after(() => srv.close());

const EMBEDDER = { provider: "openai", apiKey: "k", model: "text-embedding-3-small" };

async function insertTagged(description, board = boardId) {
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO items (board_id, payload, status, tags, tag_reasoning, created_at, updated_at)
     VALUES ($1, $2, 'tagged', '["a/b"]', $3, $4, $4) RETURNING id`,
    [board, JSON.stringify({ identity: "x", files: [], fields: {} }), JSON.stringify({ description }), Date.now()]
  );
  return id;
}
const row = async (id) =>
  (await db.query("SELECT embedding, embed_error FROM items WHERE id=$1", [id])).rows[0];

// Stub the OpenAI-compat embeddings endpoint. `reject` decides per input text;
// a rejected text 400s its whole request (exactly the provider behavior that
// used to wedge the sweep). Usage reports 10 prompt tokens per input, so the
// metering assertions have per-call numbers to check. Returns { restore, calls }.
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
      json: async () => ({
        data: input.map((_, i) => ({ index: i, embedding: [1, 0] })),
        usage: { prompt_tokens: input.length * 10 },
      }),
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

// An own-wire plugin may answer plain arrays of any length: the one funnel
// every embed call goes through (providers.js embedTexts) hands storage unit
// Float32Arrays either way. Before it, a plain array threw at storage AFTER the
// batch was metered, and a vector that wasn't unit length ranked search wrong
// (plugin-contract-plan.md, Stage 5).
test("embedBatch: a wire's plain, unnormalized vectors are stored as unit Float32Arrays", async () => {
  registerProvider("plainvec", {
    label: "PlainVec", onDevice: true,
    wire: { embed: async (_desc, { texts }) => ({ vectors: texts.map(() => [3, 4]), usage: {} }) },
    provides: { embed: { default: "pv-1" } },
  });
  // Its own item only, removed after: the sweep's candidates span every test
  // in this file, and a row embedded for another model counts in theirs.
  const id = await insertTagged("an item a plugin embeds");
  try {
    const rows = (await itemsNeedingEmbedding(db, "pv-1", 64)).filter((x) => x.id === id);
    const r = await embedBatch(db, { provider: "plainvec", apiKey: null, model: "pv-1" }, rows);
    assert.equal(r.embedded, 1, "stored, not thrown at the write");
    const buf = (await row(id)).embedding;
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    assert.deepEqual([...v].map((x) => +x.toFixed(4)), [0.6, 0.8], "(3, 4) scaled to unit length");
  } finally {
    unregisterProvider("plainvec");
    await db.query("DELETE FROM items WHERE id=$1", [id]);
  }
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
  // Out of later tests' sweeps. Marking them failed no longer does that: a
  // failed item with text is due (field-embedding-plan.md D2).
  await db.query("DELETE FROM items WHERE id = ANY($1)", [[a, b]]);
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
  await db.query("DELETE FROM items WHERE id=$1", [a]); // out of later tests' sweeps, as above
});

test("embedTextFor: capped under the tightest provider input limit", () => {
  const text = embedTextFor([], { description: "long ".repeat(5000) }, {});
  assert.ok(text.length <= 8000);
  assert.ok(text.startsWith("long "), "truncated, not mangled");
});

// ── metering (Stage 5a) ──────────────────────────────────────────────────────

test("embedBatch meters per board: the wire's total lands where it was spent", async () => {
  const bA = await seedBoard(db, "embed-meter-a");
  const bB = await seedBoard(db, "embed-meter-b");
  await insertTagged("first on a", bA);
  await insertTagged("second on a", bA);
  await insertTagged("only one on b", bB);
  const rows = await itemsNeedingEmbedding(db, EMBEDDER.model, 64);
  assert.equal(rows.length, 3);
  const { restore, calls } = stubEmbeddings();
  try {
    const r = await embedBatch(db, EMBEDDER, rows);
    assert.equal(r.embedded, 3);
  } finally { restore(); }
  // One wire call per board in the pull — a mixed call would make the split
  // a guess, and the meter doesn't guess.
  assert.equal(calls.length, 2);
  const a = await meterTotals(db, bA, "embed");
  assert.deepEqual([a.calls, a.input, a.provider, a.model], [1, 20, "openai", EMBEDDER.model]);
  const b = await meterTotals(db, bB, "embed");
  assert.deepEqual([b.calls, b.input], [1, 10]);
});

test("the salvage round meters the calls that answered — a failed call invented nothing", async () => {
  const bC = await seedBoard(db, "embed-meter-c");
  await insertTagged("fine", bC);
  await insertTagged("POISON here", bC);
  await insertTagged("also fine", bC);
  const rows = await itemsNeedingEmbedding(db, EMBEDDER.model, 64);
  const { restore, calls } = stubEmbeddings((t) => t.includes("POISON"));
  let r;
  try { r = await embedBatch(db, EMBEDDER, rows); } finally { restore(); }
  assert.deepEqual([r.embedded, r.skipped], [2, 1]);
  assert.equal(calls.length, 4, "the failed batch call, then three singles");
  // Two singles answered with usage; the batch 400 and the poison single
  // reported nothing and so metered nothing.
  const t = await meterTotals(db, bC, "embed");
  assert.deepEqual([t.calls, t.input], [2, 20]);
});

test("a semantic search meters its query embed to the board being searched", async () => {
  const member = await seedUser(db, "embed-searcher@test.local");
  const bQ = await seedBoard(db, "embed-meter-query", [member.id]);
  // Enable the embedder the way access.test.js does: installed plugin + an
  // eligible key; the wire itself stays stubbed.
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "embed-meter", "openai", "sk-test");
  await setSetting(db, "embed_key_id", String(keyId));
  await setSetting(db, "embed_enabled", "1");
  // Something to rank against: a board with no vectors refuses the search
  // before the query is embedded (the next test).
  await setItemEmbedding(db, await insertTagged("a searchable card", bQ), new Float32Array([1, 0]), EMBEDDER.model);
  const { restore } = stubEmbeddings();
  try {
    const r = await req(srv.base, "GET", `/api/search?board=${bQ}&q=hello there`, { sid: member.sid });
    assert.equal(r.status, 200);
  } finally {
    restore();
    await setSetting(db, "embed_enabled", null);
    await setSetting(db, "embed_key_id", null);
  }
  const t = await meterTotals(db, bQ, "embed");
  assert.deepEqual([t.calls, t.input, t.provider], [1, 10, "openai"]);
});

test("a search on a board with nothing embedded is refused before the query is embedded", async () => {
  // field-embedding-plan.md D8: one sentence whatever the cause, no provider
  // call, nothing metered. A vector from another model counts as none — the
  // board is waiting out a model change.
  const member = await seedUser(db, "embed-refused@test.local");
  const bare = await seedBoard(db, "embed-refused-bare", [member.id]);
  await insertTagged("a card with text and no vector", bare);
  const stale = await seedBoard(db, "embed-refused-stale", [member.id]);
  await setItemEmbedding(db, await insertTagged("a card from the old model", stale), new Float32Array([1, 0]), "some-older-model");
  await setPluginState(db, "ai:openai", { installed: true });
  await setSetting(db, "embed_key_id", String(await createAiKey(db, "embed-refused", "openai", "sk-test")));
  await setSetting(db, "embed_enabled", "1");
  const { restore, calls } = stubEmbeddings();
  const answers = [];
  try {
    for (const b of [bare, stale]) {
      answers.push(await req(srv.base, "GET", `/api/search?board=${b}&q=a car`, { sid: member.sid }));
    }
    const empty = await req(srv.base, "GET", `/api/search?board=${bare}&q=`, { sid: member.sid });
    assert.deepEqual([empty.status, empty.json.results], [200, []], "an empty query is still answered first, with nothing");
  } finally {
    restore();
    await setSetting(db, "embed_enabled", null);
    await setSetting(db, "embed_key_id", null);
  }
  for (const r of answers) {
    assert.deepEqual(r.json, { error: "Nothing on this board can be searched by meaning yet.", declined: true });
    assert.equal(r.status, 409);
  }
  assert.deepEqual(calls, [], "no query embed");
  for (const b of [bare, stale]) assert.equal(Number((await meterTotals(db, b, "embed"))?.calls || 0), 0, "nothing metered");
  await db.query("DELETE FROM items WHERE board_id = ANY($1)", [[bare, stale]]); // out of later tests' sweeps
});

test("the embed probe's ping meters at the app scope — no board asked for it", async () => {
  const admin = await adminSession(db);
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "embed-probe", "openai", "sk-test");
  await setSetting(db, "embed_key_id", String(keyId));
  await setSetting(db, "embed_enabled", "1");
  const { restore } = stubEmbeddings();
  try {
    const r = await req(srv.base, "POST", "/api/admin/capabilities/embed/probe", { sid: admin.sid, body: {} });
    assert.equal(r.status, 200);
  } finally {
    restore();
    await setSetting(db, "embed_enabled", null);
    await setSetting(db, "embed_key_id", null);
  }
  // '' is the app scope — a value, not an absence (db.js APP_SCOPE).
  const t = await meterTotals(db, "", "embed");
  assert.deepEqual([t.calls, t.input], [1, 10]);
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

// ── similar by meaning (plan 1b-meaning): the free half of search ───────────
// Item-to-item over stored vectors: no query embed, so no provider call and
// nothing metered. Bounded by RANK (top 50, anchor first), never by score —
// item-anchored cosine has no honest cutoff (measured in the plan).

async function withEmbedderEnabled(fn) {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "similar-key", "openai", "sk-test");
  await setSetting(db, "embed_key_id", String(keyId));
  await setSetting(db, "embed_enabled", "1");
  try { await fn(); } finally {
    // "0", not null: null is "no choice made" and embed declares itself on, so
    // clearing would leave the embedder running — and the assertions that
    // follow these blocks are about the route with NO embedder.
    await setSetting(db, "embed_enabled", "0");
    await setSetting(db, "embed_key_id", null);
  }
}

test("similar route: ranked by stored vectors, anchor first, no score cutoff, nothing metered", async () => {
  const member = await seedUser(db, "similar@test.local");
  const bS = await seedBoard(db, "similar-board", [member.id]);
  await withEmbedderEnabled(async () => {
    const a = await insertTagged("anchor", bS);
    const near = await insertTagged("near", bS);
    const far = await insertTagged("far", bS);
    const un = await insertTagged("never embedded", bS);
    await setItemEmbedding(db, a, new Float32Array([1, 0]), EMBEDDER.model);
    await setItemEmbedding(db, near, new Float32Array([0.8, 0.6]), EMBEDDER.model);
    await setItemEmbedding(db, far, new Float32Array([0, 1]), EMBEDDER.model);
    const r = await req(srv.base, "GET", `/api/search/similar?board=${bS}&item=${a}`, { sid: member.sid });
    assert.equal(r.status, 200);
    // far scores 0.0 and is still there — rank bounds, score never does
    assert.deepEqual(r.json.results.map((x) => String(x.id)), [a, near, far].map(String));
    assert.ok(Math.abs(r.json.results[0].score - 1) < 1e-6, "the anchor leads at ~1.0");
    // A refusal, not an empty win, in words that hold whatever the cause
    // (field-embedding-plan.md D8): a card with nothing to say never gets a vector.
    const refused = await req(srv.base, "GET", `/api/search/similar?board=${bS}&item=${un}`, { sid: member.sid });
    assert.deepEqual([refused.status, refused.json], [409, { error: "This card can't be searched by meaning yet.", declined: true }]);
  });
  const t = await meterTotals(db, bS, "embed");
  assert.equal(Number(t?.calls || 0), 0, "free: no provider call, nothing metered");
  // and with the embedder gone, the route says so like /api/search does
  const off = await req(srv.base, "GET", `/api/search/similar?board=${bS}&item=1`, { sid: member.sid });
  assert.equal(off.status, 404);
});

test("similar route: instances collapse to their entity's best score, and the cap is 50", async () => {
  const member = await seedUser(db, "similar2@test.local");
  const bS = await seedBoard(db, "similar-cap-board", [member.id]);
  await withEmbedderEnabled(async () => {
    const anchor = await insertTagged("anchor", bS);
    await setItemEmbedding(db, anchor, new Float32Array([1, 0]), EMBEDDER.model);
    // one entity, two instances at different similarities — best must win
    const { rows: [{ id: instA }] } = await db.query(
      `INSERT INTO items (board_id, entity_ids, payload, status, tags, created_at, updated_at)
       VALUES ($1, '{9001}', '{"identity":"twin"}', 'tagged', '["a/b"]', $2, $2) RETURNING id`, [bS, Date.now()]);
    const { rows: [{ id: instB }] } = await db.query(
      `INSERT INTO items (board_id, entity_ids, payload, status, tags, created_at, updated_at)
       VALUES ($1, '{9001}', '{"identity":"twin"}', 'tagged', '["a/b"]', $2, $2) RETURNING id`, [bS, Date.now()]);
    await setItemEmbedding(db, instA, new Float32Array([0, 1]), EMBEDDER.model);   // 0.0 to anchor
    await setItemEmbedding(db, instB, new Float32Array([0.6, 0.8]), EMBEDDER.model); // 0.6
    for (let i = 0; i < 55; i++) {
      const id = await insertTagged(`filler ${i}`, bS);
      await setItemEmbedding(db, id, new Float32Array([0.5, 0.866]), EMBEDDER.model); // 0.5 — under the twin's best
    }
    const r = await req(srv.base, "GET", `/api/search/similar?board=${bS}&item=${anchor}`, { sid: member.sid });
    assert.equal(r.status, 200);
    assert.equal(r.json.results.length, 50, "rank-capped at 50");
    const twin = r.json.results.find((x) => String(x.id) === "9001");
    assert.ok(twin, "the entity appears once");
    assert.ok(Math.abs(twin.score - 0.6) < 1e-6, "wearing its best instance's score");
    assert.equal(r.json.results.filter((x) => String(x.id) === "9001").length, 1);
  });
});

// ── clusters by meaning (plan 3-meaning): the server carves ─────────────────

test("meaning-clusters route: carves deterministically, hands out distinct handles, caches, free", async () => {
  const member = await seedUser(db, "carver@test.local");
  const bC = await seedBoard(db, "carve-board", [member.id]);
  await withEmbedderEnabled(async () => {
    // two orthogonal blocks of 10 — every identity is the same string "x"
    // (insertTagged's default), which drives BOTH medoid hashes to the same
    // handle and exercises the collision roll
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const id = await insertTagged(`stock ${i}`, bC);
      ids.push(id);
      await setItemEmbedding(db, id, new Float32Array(i < 10 ? [1, 0] : [0, 1]), EMBEDDER.model);
    }
    const r = await req(srv.base, "GET", `/api/boards/${bC}/meaning-clusters?level=1`, { sid: member.sid });
    assert.equal(r.status, 200);
    assert.equal(r.json.values.length, 2, "two real groups, no unclassified");
    const [a, b] = r.json.values;
    assert.match(a.value, /^[a-z]{5}$/);
    assert.match(b.value, /^[a-z]{5}$/);
    assert.notEqual(a.value, b.value, "identical medoid identities still get distinct handles");
    assert.equal(a.label, a.value, "the handle IS the label");
    assert.match(a.title, /^most typical: /);
    assert.equal(r.json.sets.length, 20, "every embedded item is placed");
    const byValue = new Map();
    for (const [, v] of r.json.sets) byValue.set(v, (byValue.get(v) || 0) + 1);
    assert.deepEqual([...byValue.values()].sort(), [10, 10]);
    // the same ask serves the cached carving — same body, still 200
    const r2 = await req(srv.base, "GET", `/api/boards/${bC}/meaning-clusters?level=1`, { sid: member.sid });
    assert.deepEqual(r2.json, r.json);
  });
  const t = await meterTotals(db, bC, "embed");
  assert.equal(Number(t?.calls || 0), 0, "free: nothing embedded, nothing metered");
  const off = await req(srv.base, "GET", `/api/boards/${bC}/meaning-clusters?level=1`, { sid: member.sid });
  assert.equal(off.status, 404, "no embedder, no carving — like /api/search");
});

test("a vector whose text changed mid-call is dropped, and the row stays due (the gen fence)", async () => {
  // audio-tag-handoff-plan.md Stage 4. A landed transcript wakes the tag leg
  // and the embed sweep together, so the transcript-only embed can still be
  // in the air when the tags land and clear the vector. Unfenced, its answer
  // then stood as the item's vector for good, tags and all missing.
  const board = await seedBoard(db, "embed-fence");
  const clip = async (identity, status) => (await db.query(
    `INSERT INTO items (board_id, payload, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
    [board, JSON.stringify({ identity, files: [{ name: `${identity}.mp3`, kind: "audio" }], fields: {}, transcript: "words" }),
      status, Date.now()])).rows[0].id;
  // Queued for its tags, so due (field-embedding-plan.md D2); the tag leg
  // claims it while the embed call is in the air.
  const racing = await clip("racing", "pending");
  const calm = await clip("calm", "held");
  const rows = (await itemsNeedingEmbedding(db, EMBEDDER.model, 1000)).filter((r) => r.board_id === board);
  assert.equal(rows.length, 2);

  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes("/embeddings")) return original(url, opts);
    await db.query("UPDATE items SET status='processing' WHERE id=$1", [racing]);
    assert.ok(await markTagged(db, racing, ["a/b"], false, {}), "the tags land while the call is in the air");
    const { input } = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({
      data: input.map((_, i) => ({ index: i, embedding: [1, 0] })), usage: { prompt_tokens: input.length } }) };
  };
  let res;
  try { res = await embedBatch(db, EMBEDDER, rows); } finally { globalThis.fetch = original; }

  assert.equal(res.embedded, 1, "only the untouched row counts as embedded");
  assert.equal((await row(racing)).embedding, null, "the transcript-only vector was dropped");
  assert.ok((await row(calm)).embedding, "the untouched row's vector landed");
  const due = (await itemsNeedingEmbedding(db, EMBEDDER.model, 1000)).map((r) => Number(r.id));
  assert.ok(due.includes(Number(racing)), "and the racing row is due again, for its tags");

  // The salvage round (a batch 400 → one call per item) whose calls all answer
  // while every write is fenced out: nothing landed, nothing failed — an
  // empty result, not "config-shaped 400" and not a throw on failures[0].
  // Queued, so the sweep takes both; the stand-in claims them mid-call.
  await db.query("UPDATE items SET status='pending' WHERE board_id=$1", [board]);
  await db.query("UPDATE items SET embedding=NULL, embedding_model=NULL WHERE board_id=$1", [board]);
  const again = (await itemsNeedingEmbedding(db, EMBEDDER.model, 1000)).filter((r) => r.board_id === board);
  assert.equal(again.length, 2, "both rows go into the salvage round");
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes("/embeddings")) return original(url, opts);
    const { input } = JSON.parse(opts.body);
    if (input.length > 1) return { ok: false, status: 400, json: async () => ({ error: { message: "one of these" } }) };
    await db.query("UPDATE items SET status='processing' WHERE board_id=$1", [board]);
    for (const r of again) await markTagged(db, r.id, ["c/d"], false, {});
    return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1 } }) };
  };
  try { res = await embedBatch(db, EMBEDDER, again); } finally { globalThis.fetch = original; }
  assert.deepEqual(res, { embedded: 0, skipped: 0 });

  // A rejection of text that changed under the call marks nothing: no
  // embed_error barring the new text, no failed row lighting the dot, not
  // counted skipped. The innocent beside it lands as ever.
  await db.query("UPDATE items SET embedding=NULL, embedding_model=NULL, embed_error=NULL WHERE board_id=$1", [board]);
  await db.query(`UPDATE items SET payload = jsonb_set(payload, '{transcript}', '"other words"') WHERE id=$1`, [calm]);
  const due3 = (await itemsNeedingEmbedding(db, EMBEDDER.model, 1000)).filter((r) => r.board_id === board);
  const poison = due3.find((r) => Number(r.id) === Number(racing));
  const innocent = due3.find((r) => Number(r.id) === Number(calm));
  const poisonText = embedTextFor(poison.tags, poison.tag_reasoning, poison.payload);
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes("/embeddings")) return original(url, opts);
    const { input } = JSON.parse(opts.body);
    if (input.includes(poisonText)) {
      if (input.length === 1) {
        await db.query("UPDATE items SET status='processing' WHERE id=$1", [poison.id]);
        await markTagged(db, poison.id, ["e/f"], false, {});
      }
      return { ok: false, status: 400, json: async () => ({ error: { message: "rejected input" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1 } }) };
  };
  try { res = await embedBatch(db, EMBEDDER, [poison, innocent]); } finally { globalThis.fetch = original; }
  assert.deepEqual(res, { embedded: 1, skipped: 0 });
  assert.equal((await row(poison.id)).embed_error, null, "the new text is not barred");
  const { rows: failedRows } = await db.query(
    "SELECT 1 FROM job_log WHERE item_id=$1 AND kind='embed' AND outcome='failed'", [poison.id]);
  assert.equal(failedRows.length, 0, "and no failed row lights the dot");
  await db.query("DELETE FROM items WHERE board_id=$1", [board]);
});

// An item row straight into the table, its text pieces as given.
const insertRow = async (board, status, { payload = {}, tags = [], reasoning = {} } = {}) => Number((await db.query(
  `INSERT INTO items (board_id, payload, status, tags, tag_reasoning, created_at, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
  [board, JSON.stringify({ identity: "x", files: [], fields: {}, ...payload }), status,
    JSON.stringify(tags), JSON.stringify(reasoning), Date.now()])).rows[0].id);

test("due: whatever has text, unless a step holds it — a keyless install searches by speech and by fields", async () => {
  // field-embedding-plan.md D2. A queued row can wait in its step's queue for
  // good (no key, a backoff, a credit wait), so a queued row with text is due:
  // audio-tag-handoff-plan.md Stage 4's reason, now for every kind of text. A
  // claimed row's landing changes its text, so it waits for that landing.
  const board = await seedBoard(db, "embed-due-matrix");
  const kinds = {
    transcript: { payload: { files: [{ name: "c.mp3", kind: "audio" }], transcript: "words" } },
    field: { payload: { fields: { icon: { v: "a car", why: "One car." } } } },
    list: { payload: { fields: { season: { v: ["summer"], why: "Light.", kind: "list" } } } },
    detect: { payload: { fields: { boat: { v: [{ box: [0, 0, 1, 1], label: "boat" }], why: "Detected: boat" } } } },
    tags: { tags: ["a/b"] },
    reasoning: { reasoning: { description: "A car." } },
    nothing: { payload: { files: [{ name: "x.png", original_name: "x.png", kind: "image" }],
      fields: { brand: { v: null, why: "Not found." }, snow: { v: [], why: "No objects detected" }, w: { v: 1920, src: "file" } } } },
  };
  const claimed = ["processing", "extracting", "facing", "fetching"];
  const resting = ["held", "failed", "tagged", "pending", "pending_extract", "pending_face", "pending_fetch"];
  const seeded = [];
  for (const status of [...resting, ...claimed]) {
    for (const [kind, k] of Object.entries(kinds)) seeded.push({ id: await insertRow(board, status, k), status, kind });
  }
  const due = new Set((await itemsNeedingEmbedding(db, EMBEDDER.model, 1000))
    .filter((r) => r.board_id === board).map((r) => Number(r.id)));
  const wrong = seeded.filter((x) => due.has(x.id) !== (!claimed.includes(x.status) && x.kind !== "nothing"));
  assert.deepEqual(wrong.map((x) => `${x.kind} in ${x.status} is ${due.has(x.id) ? "due" : "not due"}`), []);
  await db.query("DELETE FROM items WHERE board_id=$1", [board]); // out of later tests' sweeps and stats
});

test("the sweep's rule and the text builder agree, row for row, on every shape", async () => {
  // field-embedding-plan.md D9: items.has_embed_text (migration 0061) decides
  // who is due and embedTextFor what is sent; they're two spellings of one
  // rule. Every shape here sits in `held`, so only the text decides.
  const board = await seedBoard(db, "embed-agreement");
  const shapes = {
    "tags": { tags: ["a/b"] },
    "a description": { reasoning: { description: "A car." } },
    "a facet's reason": { reasoning: { mood: "Calm." } },
    "blank reasoning": { reasoning: { description: "   ", mood: "" } },
    "a number as reasoning": { reasoning: { score: 5 } },
    "a transcript": { payload: { transcript: "words" } },
    "a blank transcript": { payload: { transcript: " \n " } },
    "a number as transcript": { payload: { transcript: 5 } },
    "a text answer": { payload: { fields: { a: { v: "x", why: "y" } } } },
    "a whitespace answer": { payload: { fields: { a: { v: " " } } } },
    "an empty answer": { payload: { fields: { a: { v: "", why: "y" } } } },
    "a null answer": { payload: { fields: { a: { v: null, why: "Not found." } } } },
    "zero": { payload: { fields: { a: { v: 0 } } } },
    "a list answer": { payload: { fields: { a: { v: ["x"], kind: "list" } } } },
    "a list of one empty string": { payload: { fields: { a: { v: [""], kind: "list" } } } },
    "an empty list": { payload: { fields: { a: { v: [], kind: "list", why: "None apply." } } } },
    "boxes": { payload: { fields: { a: { v: [{ box: [0, 0, 1, 1], label: "boat" }], why: "Detected: boat" } } } },
    "boxes, no why": { payload: { fields: { a: { v: [{ box: [0, 0, 1, 1] }] } } } },
    "no boxes": { payload: { fields: { a: { v: [], why: "No objects detected" } } } },
    "a file field": { payload: { fields: { a: { v: 1920, src: "file", kind: "number" } } } },
    "a file field with a list": { payload: { fields: { a: { v: ["x"], src: "file", kind: "list" } } } },
    "a file field beside an answer": { payload: { fields: { w: { v: 1, src: "file" }, a: { v: "x" } } } },
    "an object answer": { payload: { fields: { a: { v: { n: 1 } } } } },
    "a bare string entry": { payload: { fields: { a: "x" } } },
    "fields as null": { payload: { fields: null } },
    "fields as a list": { payload: { fields: ["x"] } },
    "fields as a list of entries": { payload: { fields: [{ v: "x" }] } },
    "nothing": {},
  };
  const ids = {};
  for (const [name, k] of Object.entries(shapes)) ids[name] = await insertRow(board, "held", k);
  const due = new Set((await itemsNeedingEmbedding(db, EMBEDDER.model, 1000))
    .filter((r) => r.board_id === board).map((r) => Number(r.id)));
  const { rows } = await db.query("SELECT id, tags, tag_reasoning, payload FROM items WHERE board_id=$1", [board]);
  const text = new Map(rows.map((r) => [Number(r.id), embedTextFor(r.tags, r.tag_reasoning, r.payload)]));
  const disagree = Object.entries(ids)
    .filter(([, id]) => due.has(id) !== (text.get(id) !== ""))
    .map(([name, id]) => `${name}: ${due.has(id) ? "due" : "not due"}, text ${JSON.stringify(text.get(id))}`);
  assert.deepEqual(disagree, []);
  // …and the shapes with something to say really are the ones that say it.
  assert.deepEqual(Object.keys(ids).filter((n) => due.has(ids[n])),
    ["tags", "a description", "a facet's reason", "a transcript", "a text answer", "a whitespace answer",
      "zero", "a list answer", "a list of one empty string", "boxes", "boxes, no why", "a file field beside an answer"]);
  await db.query("DELETE FROM items WHERE board_id=$1", [board]);
});

test("an extraction that parks clears the vector; one handed on to tagging leaves it standing", async () => {
  // field-embedding-plan.md D3. The parked clip was embedded from its
  // transcript while it waited to be extracted; its fields are its last text
  // change, so the vector goes and the sweep makes a new one. The other is an
  // explicit re-extract (no park): markTagged clears its vector when the tags
  // land, and until then it stays searchable.
  const board = await seedBoard(db, "embed-park");
  await db.query("UPDATE boards SET auto_tag=false WHERE id=$1", [board]);
  const parked = await insertRow(board, "extracting", { payload: { park: true, files: [{ name: "c.mp3", kind: "audio" }], transcript: "words" } });
  const handed = await insertRow(board, "extracting", { tags: ["a/b"] });
  for (const id of [parked, handed]) await setItemEmbedding(db, id, new Float32Array([1, 0]), EMBEDDER.model);
  const gen = async (id) => (await db.query("SELECT embed_gen FROM items WHERE id=$1", [id])).rows[0].embed_gen;
  const [parkedGen, handedGen] = [await gen(parked), await gen(handed)];
  const fields = { icon: { v: "a car", why: "One car." } };

  assert.ok(await markExtracted(db, parked, fields));
  assert.ok(await markExtracted(db, handed, fields));
  const state = async (id) => (await db.query("SELECT status, embedding IS NOT NULL AS vec FROM items WHERE id=$1", [id])).rows[0];
  assert.deepEqual(await state(parked), { status: "held", vec: false }, "parked: the vector is cleared");
  assert.equal(await gen(parked), parkedGen + 1, "…and a vector still in the air from before is fenced out");
  assert.deepEqual(await state(handed), { status: "pending", vec: true }, "handed on: the vector stands");
  assert.equal(await gen(handed), handedGen);
  const due = (await itemsNeedingEmbedding(db, EMBEDDER.model, 1000)).map((r) => Number(r.id));
  assert.ok(due.includes(Number(parked)), "the parked item is due again, for its fields");
  assert.ok(!due.includes(Number(handed)), "the other waits for its tags to clear it");
  assert.equal(await markExtracted(db, parked, fields), false, "a stale landing still lands nothing");
  await db.query("DELETE FROM items WHERE board_id=$1", [board]);
});

test("a row with nothing to embed, or whose text can't be built, is marked, not sent — no call, no History row", async () => {
  // field-embedding-plan.md D4. The claim never hands embedBatch such a row
  // unless the SQL rule and the builder disagree; if they ever do, the row is
  // marked instead of sending an empty string, and kept out of the batch row.
  // A tag that isn't a string (no writer makes one) is a tag to the claim and
  // a throw to the builder; unmarked, it would fail every batch it's claimed into.
  const board = await seedBoard(db, "embed-nothing");
  const empty = await insertRow(board, "tagged");
  const broken = await insertRow(board, "tagged", { tags: [1] });
  const good = await insertTagged("a fine description", board);
  const due = await itemsNeedingEmbedding(db, EMBEDDER.model, 1000);
  const goodRow = due.find((r) => Number(r.id) === Number(good));
  const brokenRow = due.find((r) => Number(r.id) === Number(broken));
  assert.ok(brokenRow, "the claim takes the broken row");
  const emptyRow = { ...goodRow, id: empty, tags: [], tag_reasoning: {}, payload: { identity: "x", files: [], fields: {} }, embed_gen: 0 };
  const { restore, calls } = stubEmbeddings();
  let r;
  try { r = await embedBatch(db, EMBEDDER, [emptyRow, brokenRow, goodRow]); } finally { restore(); }
  assert.deepEqual(calls, [1], "one call, carrying only the row with text");
  assert.deepEqual(r, { embedded: 1, skipped: 2 });
  assert.match((await row(empty)).embed_error, /nothing to embed/);
  assert.match((await row(broken)).embed_error, /can't be built/);
  const { rows: jobs } = await db.query("SELECT outcome, detail FROM job_log WHERE board_id=$1 AND kind='embed'", [board]);
  assert.deepEqual(jobs.map((j) => [j.outcome, j.detail.items]), [["ok", 1]], "the batch's row counts the one it sent, and nothing failed");
  await db.query("DELETE FROM items WHERE board_id=$1", [board]);
});

test("the admin numbers count what the sweep would embed, whatever the item's status", async () => {
  // embeddingStats used to count `tagged` items only, so a held item with
  // fields, or transcribed audio on a board that doesn't tag, was never in them.
  const board = await seedBoard(db, "embed-stats");
  const before = await embeddingStats(db, EMBEDDER.model);
  await insertRow(board, "held", { payload: { fields: { icon: { v: "a car" } } } });
  await insertRow(board, "pending_extract", { payload: { files: [{ name: "c.mp3", kind: "audio" }], transcript: "words" } });
  const embedded = await insertRow(board, "tagged", { tags: ["a/b"] });
  await setItemEmbedding(db, embedded, new Float32Array([1, 0]), EMBEDDER.model);
  await insertRow(board, "tagged"); // nothing to say: not counted
  await insertRow(board, "held", { payload: { fields: { w: { v: 1920, src: "file" } } } }); // file fields only: not counted
  const after = await embeddingStats(db, EMBEDDER.model);
  assert.deepEqual([after.total - before.total, after.embedded - before.embedded, after.failed - before.failed], [3, 1, 0]);
  await db.query("DELETE FROM items WHERE board_id=$1", [board]);
});

test("0061 rebuilds the vectors made without their fields or from a name, and keeps the rest", async () => {
  // field-embedding-plan.md D7, against the rows it was written for: wardrobe's
  // file-fields-only items keep their vectors, cars' tagged-with-fields ones are
  // rebuilt, boats' name-only ones are cleared for good.
  const board = await seedBoard(db, "embed-0061");
  const answered = { fields: { icon: { v: "a car", why: "One car." } } };
  const ids = {
    tagsOnly: await insertRow(board, "tagged", { tags: ["a/b"] }),
    tagsAndFields: await insertRow(board, "tagged", { tags: ["a/b"], payload: answered }),
    fileFieldsOnly: await insertRow(board, "tagged", { tags: ["a/b"], payload: { fields: { w: { v: 1920, src: "file" } } } }),
    nameOnly: await insertRow(board, "tagged", { payload: { files: [{ name: "x.jpg", original_name: "x.jpg" }], fields: { boat: { v: [], why: "No objects detected" } } } }),
    clipAndFields: await insertRow(board, "held", { payload: { ...answered, files: [{ name: "c.mp3", kind: "audio" }], transcript: "words" } }),
  };
  for (const id of Object.values(ids)) await setItemEmbedding(db, id, new Float32Array([1, 0]), EMBEDDER.model);
  const markedWithFields = await insertRow(board, "tagged", { tags: ["a/b"], payload: answered });
  const markedTagsOnly = await insertRow(board, "tagged", { tags: ["c/d"] });
  await db.query("UPDATE items SET embed_error='rejected' WHERE id = ANY($1::bigint[])", [[markedWithFields, markedTagsOnly]]);
  const gens = async () => new Map((await db.query("SELECT id, embed_gen FROM items WHERE board_id=$1", [board])).rows.map((r) => [Number(r.id), r.embed_gen]));
  const genBefore = await gens();

  const { readFileSync } = await import("node:fs");
  await db.query(readFileSync(new URL("../server/migrations/0061_fields_embed_text.sql", import.meta.url), "utf8"));

  const vec = async (id) => (await db.query("SELECT embedding IS NOT NULL AS v, embed_error FROM items WHERE id=$1", [id])).rows[0];
  assert.equal((await vec(ids.tagsOnly)).v, true, "tags only: the text didn't change");
  assert.equal((await vec(ids.fileFieldsOnly)).v, true, "file fields aren't embed text");
  assert.equal((await vec(ids.tagsAndFields)).v, false, "made without its fields: rebuilt");
  assert.equal((await vec(ids.clipAndFields)).v, false, "a clip's transcript-only vector: rebuilt");
  assert.equal((await vec(ids.nameOnly)).v, false, "made from a name: cleared");
  assert.equal((await vec(markedWithFields)).embed_error, null, "a rejection of text without its fields: lifted");
  assert.equal((await vec(markedTagsOnly)).embed_error, "rejected", "a rejection of text that hasn't changed: kept");
  const genAfter = await gens();
  const bumped = [...genAfter].filter(([id, g]) => g !== genBefore.get(id)).map(([id]) => id).sort();
  assert.deepEqual(bumped, [ids.tagsAndFields, ids.clipAndFields, ids.nameOnly, markedWithFields].sort(), "cleared the way CLEAR_EMBEDDING clears");
  const due = new Set((await itemsNeedingEmbedding(db, EMBEDDER.model, 1000)).map((r) => Number(r.id)));
  assert.deepEqual([ids.tagsAndFields, ids.clipAndFields, ids.nameOnly, markedWithFields].map((id) => due.has(id)), [true, true, false, true],
    "the sweep rebuilds what has text; the name-only item stays without a vector");
  await db.query("DELETE FROM items WHERE board_id=$1", [board]);
});

// ── the embedder as a resource (queue-by-resource-plan.md Stage 4b) ──────────

test("rows already being embedded are withheld — a second tick must not pay for them twice", async () => {
  // A row stops qualifying only when its VECTOR lands, so it stays due for the
  // whole length of the call that is embedding it. The sweep this replaced ran
  // one batch and awaited it, which is the only reason it could ask the same
  // question twice for free.
  const id = await insertTagged("still in flight");
  const mine = (rows) => rows.some((r) => Number(r.id) === Number(id));
  assert.ok(mine(await itemsNeedingEmbedding(db, EMBEDDER.model, 64)), "due before anything holds it");
  assert.ok(!mine(await itemsNeedingEmbedding(db, EMBEDDER.model, 64, [id])),
    "and withheld while this process is mid-call on it");
  await setItemEmbedding(db, id, new Float32Array([1, 0]), EMBEDDER.model); // settle it for later reads
});

test("a paid embedder contends for its key; the on-device one contends for the box", async () => {
  // The split that makes 4b safe. A keyed provider is counted at the WIRE, on
  // the same string tagging on that key uses — one quota, one pool. The
  // on-device model has no key at all, so it gets a class of its own, and the
  // ceiling there is 1 because it is one model in one process.
  assert.equal(embedResource(EMBEDDER), aiKeyBucket("openai", "k"),
    "a paid embedder buckets exactly as the rate limiter does");
  assert.equal(maxFor(embedResource(EMBEDDER)), 8, "and draws on the key's ordinary ceiling");

  assert.equal(PROVIDERS.local.onDevice, true, "the built-in embedder runs in-process");
  assert.equal(embedResource({ provider: "local", apiKey: null }), "local:local");
  assert.equal(maxFor("local:local"), 1, "one model, one batch at a time");
  assert.notEqual(embedResource({ provider: "local" }), embedResource(EMBEDDER),
    "two different pools, so a paid embedder is never capped by the on-device one");
});
