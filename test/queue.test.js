// The unified work queue (worker-queue hole #10): ONE claim across all stages,
// oldest-first — an item flows to completion before newer items start, no
// stage can starve another, and the claimed row's in-flight status names the
// step to run. The key gate skips the AI stages (extract/tag) but not faces.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard } from "./helpers.js";
import { claimNextWork, createEntity, insertItem } from "../server/db.js";
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
