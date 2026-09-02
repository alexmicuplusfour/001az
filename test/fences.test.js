// Value fences (worker-queue hole #7): the advance/failure stamps land only
// while the row still holds the claim's in-flight status. A per-card route
// (reprocess / re-extract / retag / tag edit) that re-routes a row mid-call
// wins — the stale result is discarded: no status flip, no snapshot, no error
// stamp. The per-card routes stay unfenced ON PURPOSE; that's the mechanism by
// which the user wins the race.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard } from "./helpers.js";
import {
  claimNextWork,
  createEntity,
  insertItem,
  markTagged,
  markExtracted,
  advanceFaced,
  advanceFetched,
  failOrRequeue,
  retagItem,
  requeueItemForTag,
} from "../server/db.js";

let srv, db, boardId;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  boardId = await seedBoard(db, "fences");
});
after(() => srv.close());

let seq = 0;
async function seed(status) {
  const identity = `f${++seq}`;
  const eid = await createEntity(db, boardId, { identity });
  return insertItem(db, boardId, { identity, files: [], fields: {} }, status, eid);
}
const row = async (id) =>
  (await db.query("SELECT status, tags, attempts, error, retry_at, payload FROM items WHERE id=$1", [id])).rows[0];
const snapCount = async (id) =>
  Number((await db.query("SELECT COUNT(*) AS c FROM tag_snapshots WHERE item_id=$1", [id])).rows[0].c);
// Park out of claimable states so later tests' claims can't grab strays.
const park = (ids) => db.query("UPDATE items SET status='failed' WHERE id = ANY($1)", [ids]);

test("markTagged lands on a claimed row, discards on a re-routed one", async () => {
  const id = await seed("processing");
  assert.equal(await markTagged(db, id, ["a/x"], false, {}), true);
  assert.equal((await row(id)).status, "tagged");
  assert.equal(await snapCount(id), 1);

  // Re-routed mid-flight (the user hit re-extract): the stale stamp must not land.
  await db.query("UPDATE items SET status='pending_extract' WHERE id=$1", [id]);
  assert.equal(await markTagged(db, id, ["b/y"], false, {}), false);
  const r = await row(id);
  assert.equal(r.status, "pending_extract", "the user's routing survives");
  assert.deepEqual(r.tags, ["a/x"], "stale tags discarded");
  assert.equal(await snapCount(id), 1, "no snapshot for a result that never landed");
  await park([id]);
});

test("markExtracted / advanceFaced discard on re-routed rows", async () => {
  const ex = await seed("pending"); // not 'extracting'
  assert.equal(await markExtracted(db, ex, { k: { v: 1, why: "w" } }), false);
  const r1 = await row(ex);
  assert.equal(r1.status, "pending");
  assert.equal(r1.payload.extracted_at, undefined, "no definition stamp");

  const fc = await seed("pending"); // not 'facing'
  assert.equal(await advanceFaced(db, fc), false);
  assert.equal((await row(fc)).status, "pending");

  const ft = await seed("pending"); // not 'fetching'
  assert.equal(await advanceFetched(db, ft, "pending_face", { source: { provider: "x", id: "y" } }), false);
  const r2 = await row(ft);
  assert.equal(r2.status, "pending", "a stale fetch can't re-route the row");
  assert.equal(r2.payload.source, undefined, "…or splat provider data onto it");
  await park([ex, fc, ft]);
});

test("a stale failure can't stamp error/retry_at over a user's re-route", async () => {
  const id = await seed("pending_extract"); // the user re-extracted mid-tag-flight
  const failed = await failOrRequeue(db, id, new Error("boom"), 3, "pending");
  assert.equal(failed, false);
  const r = await row(id);
  assert.equal(r.status, "pending_extract", "not yanked back to the tag leg");
  assert.equal(r.attempts, 0, "no attempt burned");
  assert.equal(r.error, null);
  assert.equal(r.retry_at, null);
  await park([id]);
});

test("user wins the whole race: claim → retag flips it → stale stamp discards → re-claimable", async () => {
  const id = await seed("pending");
  const claimed = await claimNextWork(db, true);
  assert.equal(claimed?.id, id);
  assert.equal(claimed.status, "processing");

  await retagItem(db, id); // the user's mid-flight action → pending, counters reset
  assert.equal(await markTagged(db, id, ["stale/tag"], false, {}), false);
  const r = await row(id);
  assert.equal(r.status, "pending");
  assert.deepEqual(r.tags, [], "the user's reset survives the stale stamp");

  const again = await claimNextWork(db, true);
  assert.equal(again?.id, id, "the user's queued run proceeds untouched");
  await park([id]);
});

test("the refresh cascade only requeues settled items", async () => {
  const tagged = await seed("tagged");
  assert.equal(await requeueItemForTag(db, tagged), true);
  assert.equal((await row(tagged)).status, "pending");

  const midExtract = await seed("pending_extract");
  assert.equal(await requeueItemForTag(db, midExtract), false);
  assert.equal((await row(midExtract)).status, "pending_extract", "not yanked out of the definition leg");
  await park([tagged, midExtract]);
});
