// The unified work queue (worker-queue hole #10): ONE claim across all stages,
// oldest-first — an item flows to completion before newer items start, no
// stage can starve another, and the claimed row's in-flight status names the
// step to run. The key gate skips the AI stages (extract/tag) but not faces.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard } from "./helpers.js";
import { claimNextWork, claimFairBatch, createEntity, insertItem } from "../server/db.js";
import { startWorker } from "../server/worker.js";

let srv, db, boardId, galleryDir, thumbsDir;
before(async () => {
  srv = await startServer();
  ({ db, galleryDir, thumbsDir } = srv);
  boardId = await seedBoard(db, "queue");
});
after(() => srv.close());

let seq = 0;
async function seed(status, ageMs) {
  const identity = `q${++seq}`;
  const eid = await createEntity(db, boardId, { identity });
  const id = await insertItem(db, boardId, { identity, files: [], fields: {} }, status, eid);
  await db.query("UPDATE items SET created_at=$1 WHERE id=$2", [Date.now() - ageMs, id]);
  return id;
}
// Park out of claimable states so later tests' claims can't grab strays.
const park = (ids) => db.query("UPDATE items SET status='failed' WHERE id = ANY($1)", [ids]);

// Seed one PENDING item on a specific board, aged, for the board-fairness batch test.
async function seedOn(bid, ageMs) {
  const identity = `f${++seq}`;
  const eid = await createEntity(db, bid, { identity });
  const id = await insertItem(db, bid, { identity, files: [], fields: {} }, "pending", eid);
  await db.query("UPDATE items SET created_at=$1 WHERE id=$2", [Date.now() - ageMs, id]);
  return id;
}

test("one queue: oldest work claims first across stages; in-flight status names the step", async () => {
  const tag = await seed("pending", 30000); // oldest
  const extract = await seed("pending_extract", 20000);
  const face = await seed("pending_face", 10000); // newest

  const claims = [await claimNextWork(db, true), await claimNextWork(db, true), await claimNextWork(db, true)];
  assert.deepEqual(
    claims.map((c) => [c.id, c.status]),
    [[tag, "processing"], [extract, "extracting"], [face, "facing"]]
  );
  assert.equal(await claimNextWork(db, true), null, "queue drained");
  await park([tag, extract, face]);
});

test("an item flows to completion before newer items start", async () => {
  const a = await seed("pending_extract", 30000); // older
  const b = await seed("pending_extract", 20000); // newer

  const first = await claimNextWork(db, true);
  assert.equal(first.id, a);
  // A's extraction finished — it re-enters the queue with its original age.
  await db.query("UPDATE items SET status='pending' WHERE id=$1", [a]);
  const second = await claimNextWork(db, true);
  assert.equal(second.id, a, "A's tag step outranks B's extract — trickle completion");
  assert.equal(second.status, "processing");
  await park([a, b]);
});

test("no key anywhere: AI stages wait unclaimed, faces still claim", async () => {
  const ext = await seed("pending_extract", 30000);
  const tg = await seed("pending", 25000);
  const fc = await seed("pending_face", 10000);

  const c = await claimNextWork(db, false); // no default key; the board has none
  assert.equal(c?.id, fc, "face claims despite no key — a render needs no model");
  assert.equal(c.status, "facing");
  assert.equal(await claimNextWork(db, false), null, "extract/tag stay queued, never failed");
  await park([ext, tg, fc]);
});

test("a spaced retry_at parks one item without blocking younger work", async () => {
  const throttled = await seed("pending_extract", 30000);
  const fresh = await seed("pending", 10000);
  await db.query("UPDATE items SET retry_at=$1 WHERE id=$2", [Date.now() + 60000, throttled]);

  const c = await claimNextWork(db, true);
  assert.equal(c?.id, fresh, "younger ready work claims past the throttled row");
  await park([throttled, fresh]);
});

// worker-rework Stage 1: the dispatcher passes only the stages whose lane has room,
// so a full lane (e.g. the single-threaded sidecar) doesn't block other work.
test("capacity-aware claim: a stages filter skips other lanes' work", async () => {
  const ext = await seed("pending_extract", 30000); // oldest overall
  const tag = await seed("pending", 10000); // newer

  // Only the tag lane open → the older extract row is skipped, the tag row claims.
  const c = await claimNextWork(db, true, ["pending"]);
  assert.equal(c?.id, tag, "claims the pending item, not the older pending_extract");
  assert.equal(c.status, "processing");
  assert.equal(await claimNextWork(db, true, ["pending"]), null, "extract work stays queued while its lane is closed");

  // Reopen the extract lane → it claims.
  assert.equal((await claimNextWork(db, true, ["pending_extract", "pending"]))?.id, ext);
  await park([ext, tag]);
});

// The loop itself: nothing else in the suite runs startWorker, so the
// claim → STEP-dispatch wiring in tick() would otherwise ship untested. The
// face step needs no AI key (and no connector → renders nothing → advances),
// which makes a real end-to-end pass cheap.
test("the worker loop claims a queued item and drives it through its step", async () => {
  const id = await seed("pending_face", 5000);
  process.env.POLL_MS = "50";
  const stop = startWorker({ db, galleryDir, thumbsDir });
  try {
    let status;
    for (let i = 0; i < 100; i++) {
      ({ rows: [{ status }] } = await db.query("SELECT status FROM items WHERE id=$1", [id]));
      if (status !== "pending_face" && status !== "facing") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Faced (no connector → tile) and advanced to tagging, where it waits —
    // no key anywhere, so the loop must leave it pending, never failed.
    assert.equal(status, "pending");
  } finally {
    delete process.env.POLL_MS;
    await stop();
    await park([id]);
  }
});

// Stage 1: the continuous dispatcher drains a backlog — fill lanes, process, refill on
// completion, and stop() awaits the in-flight pipelines. Faces need no key/sidecar, so
// several of them exercise the loop without stubbing a provider.
test("the dispatcher drains a backlog of queued items through their steps", async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await seed("pending_face", 5000 + i));
  process.env.POLL_MS = "50";
  const stop = startWorker({ db, galleryDir, thumbsDir });
  try {
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      const { rows } = await db.query("SELECT status FROM items WHERE id = ANY($1)", [ids]);
      done = rows.every((r) => r.status === "pending"); // all faced (no connector → tile) → tag leg
      if (!done) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(done, "every face item advanced through the dispatcher");
  } finally {
    delete process.env.POLL_MS;
    await stop();
    await park(ids);
  }
});

// Stage 2 — THE ORIGINAL GOAL. A big board's backlog no longer buries a small board's
// work: one fair batch draws from both, round-robin, not the N oldest (all one board).
test("board-fair batch: a small board interleaves ahead of a big board's backlog", async () => {
  const A = await seedBoard(db, "fair-A");
  const B = await seedBoard(db, "fair-B");
  const a = [], b = [];
  for (let i = 0; i < 6; i++) a.push(await seedOn(A, 60000 - i)); // 6 OLDER items
  for (let i = 0; i < 2; i++) b.push(await seedOn(B, 10000 - i)); // 2 NEWER items

  // Plain FIFO would take a[0..3] (all A). Fair batching must interleave the boards.
  const batch = await claimFairBatch(db, true, ["pending"], 4);
  assert.equal(batch.length, 4);
  const fromB = batch.filter((r) => String(r.board_id) === String(B)).length;
  const fromA = batch.filter((r) => String(r.board_id) === String(A)).length;
  assert.equal(fromB, 2, "both of the small board's items are served in the first batch");
  assert.equal(fromA, 2, "the big board takes the rest, not all 4 slots");
  await park([...a, ...b]);
});
