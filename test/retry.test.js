// Failure routing on the worker queue: failOrRequeue's transient/permanent
// classification, spaced retry_at claim gating, the noCount (missing key)
// path, and explicit requeues clearing the timer. No live AI — everything is
// exercised at the db layer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard } from "./helpers.js";
import { failOrRequeue, claimNextWork, retagItem, recoverStuck } from "../server/db.js";

let srv, db, boardId;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  boardId = await seedBoard(db, "retry-board");
});
after(() => srv.close());

async function insertItem(status = "processing") {
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO items (board_id, payload, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4) RETURNING id`,
    [boardId, JSON.stringify({ identity: "x", files: [], fields: {} }), status, Date.now()]
  );
  return id;
}
const row = async (id) =>
  (await db.query("SELECT status, attempts, error, retry_at FROM items WHERE id=$1", [id])).rows[0];
// Park an item out of claimable states so later tests' claims can't grab it.
const park = (id) => db.query("UPDATE items SET status='failed' WHERE id=$1", [id]);

test("transient error: requeued with a spaced retry_at, invisible to claims until due", async () => {
  const id = await insertItem();
  const failed = await failOrRequeue(db, id, new Error("connection reset"), 3);
  assert.equal(failed, false);
  const r = await row(id);
  assert.equal(r.status, "pending");
  assert.equal(r.attempts, 1);
  assert.ok(Number(r.retry_at) > Date.now() + 30000, "first retry is ~1m out, not instant");

  assert.equal(await claimNextWork(db, true), null, "not claimable while the timer runs");
  await db.query("UPDATE items SET retry_at=$1 WHERE id=$2", [Date.now() - 1, id]);
  const claimed = await claimNextWork(db, true);
  assert.equal(claimed?.id, id, "claimable once retry_at passes");
  await park(id);
});

test("permanent 4xx: failed on the FIRST attempt — no pointless repeats", async () => {
  const id = await insertItem();
  const e = new Error("invalid request");
  e.status = 400;
  assert.equal(await failOrRequeue(db, id, e, 3), true);
  const r = await row(id);
  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 1);
  assert.equal(r.retry_at, null);
  assert.equal(r.error, "invalid request");
});

test("429 is transient despite being 4xx, and a provider Retry-After stretches the wait", async () => {
  const id = await insertItem();
  const e = new Error("rate limited");
  e.status = 429;
  e.retryAfter = "600";
  assert.equal(await failOrRequeue(db, id, e, 3), false);
  const r = await row(id);
  assert.equal(r.status, "pending");
  assert.ok(Number(r.retry_at) >= Date.now() + 590000, "waits at least Retry-After");
  await park(id);
});

test("transient failures get headroom over maxAttempts before hard-failing", async () => {
  const id = await insertItem();
  let failed;
  for (let i = 0; i < 5; i++) failed = await failOrRequeue(db, id, new Error("upstream 502"), 3);
  assert.equal(failed, true, "maxAttempts 3 + 2 headroom → fails on the 5th");
  assert.equal((await row(id)).attempts, 5);
});

test("noCount (missing key): requeued without consuming an attempt, still spaced", async () => {
  const id = await insertItem();
  const e = new Error("no API key configured");
  e.noCount = true;
  assert.equal(await failOrRequeue(db, id, e, 3), false);
  const r = await row(id);
  assert.equal(r.status, "pending");
  assert.equal(r.attempts, 0, "a configuration gap is not the item's failure");
  assert.equal(r.error, "no API key configured");
  assert.ok(Number(r.retry_at) > Date.now(), "spaced so an unconfigured board doesn't hammer");
  await park(id);
});

// ── recoverStuck: interruptions count, route per leg, and can finally fail ──

async function insertStuck(status, { attempts = 0, age = 400000 } = {}) {
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO items (board_id, payload, status, attempts, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
    [boardId, JSON.stringify({ identity: "s", files: [], fields: {} }), status, attempts, Date.now() - age]
  );
  return id;
}

test("recoverStuck: counts the interruption, routes per leg, spaces the retry", async () => {
  const tag = await insertStuck("processing");
  const ext = await insertStuck("extracting");
  const face = await insertStuck("facing");
  const fresh = await insertStuck("processing", { age: 0 }); // in-flight, not stuck

  const n = await recoverStuck(db, 180000, 3);
  assert.equal(n, 3, "fresh in-flight rows are untouched");

  const expect = { [tag]: "pending", [ext]: "pending_extract", [face]: "pending_face" };
  for (const [id, status] of Object.entries(expect)) {
    const r = await row(id);
    assert.equal(r.status, status);
    assert.equal(r.attempts, 1, "a recovery is evidence — it counts");
    assert.ok(Number(r.retry_at) > Date.now() + 30000, "spaced like a transient failure");
  }
  assert.equal((await row(fresh)).status, "processing");
  for (const id of [tag, ext, face, fresh]) await park(id);
});

test("recoverStuck: at the transient ceiling the item finally FAILS (nothing else can fail a crash)", async () => {
  const id = await insertStuck("processing", { attempts: 4 }); // next interruption = 5 = 3 + 2
  await recoverStuck(db, 180000, 3);
  const r = await row(id);
  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 5);
  assert.equal(r.retry_at, null);
  assert.match(r.error, /interrupted mid-flight repeatedly/);
});

test("an explicit requeue clears the timer — the user's hand beats the backoff", async () => {
  const id = await insertItem();
  const e = new Error("overloaded");
  e.status = 529;
  await failOrRequeue(db, id, e, 3);
  assert.ok(Number((await row(id)).retry_at) > Date.now());

  await retagItem(db, id);
  const r = await row(id);
  assert.equal(r.status, "pending");
  assert.equal(r.retry_at, null);
  const claimed = await claimNextWork(db, true);
  assert.equal(claimed?.id, id, "immediately claimable after the explicit retag");
  await park(id);
});
