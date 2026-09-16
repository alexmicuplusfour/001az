// Stage 2 of ingest-deletions-plan.md, the write side: rejection is RECORDED
// at the one moment intent is known — the three db-level item-deletion sites
// stamp linked ledger rows `deleted` — never inferred from absence. Plus the
// upsert semantics that make the stamps trustworthy (linkless writes can't
// wipe richer facts) and the merge invariant (membership rewrites leave the
// link alone, because the item row never changes).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard, seedInstance } from "./helpers.js";
import {
  createEntity, insertItem, recordIngest, deleteEntity, deleteInstance,
  cancelBoardQueue, setItemEntities, reconcileEntities, itemBySourceKey, withTx,
  updateBoard, ingestLedgerCounts, clearIngestLog,
} from "../server/db.js";

let srv, db;
before(async () => { srv = await startServer(); db = srv.db; });
after(async () => { await srv.close(); });

const ledger = async (boardId, key) =>
  (await db.query("SELECT * FROM ingest_log WHERE board_id=$1 AND source_key=$2", [boardId, key])).rows[0] ?? null;

// One ingested item as the admit paths leave it: entity + instance (the
// shared seeder) + the ledger row linking them.
async function seedIngested(boardId, key) {
  const { eid, id } = await seedInstance(db, boardId, "held");
  await recordIngest(db, boardId, key, Date.now(), { itemId: id });
  return { eid, iid: id };
}

test("recordIngest upsert: reason flips freely, links and provenance never regress to null", async () => {
  const bid = await seedBoard(db, "led-upsert");
  await recordIngest(db, bid, "k", 1000, { itemId: 7, hash: "h", size: 5, modifiedAt: 42 });
  // The sweep's dup path is linkless — COALESCE keeps every richer fact,
  // while created_at refreshes ("when last ledgered").
  await recordIngest(db, bid, "k", 2000);
  let row = await ledger(bid, "k");
  assert.equal(row.reason, "admitted");
  assert.equal(Number(row.item_id), 7);
  assert.equal(row.content_hash, "h");
  assert.equal(Number(row.file_size), 5);
  assert.equal(Number(row.modified_at), 42);
  assert.equal(Number(row.created_at), 2000);
  // A skip write flips the reason; a later re-admission flips it back —
  // the bring-back arc depends on `deleted` not being sticky through the
  // upsert (stage 4 clears marks by re-admitting).
  await recordIngest(db, bid, "k", 3000, { reason: "skipped" });
  assert.equal((await ledger(bid, "k")).reason, "skipped");
  await recordIngest(db, bid, "k", 4000, { itemId: 9 });
  row = await ledger(bid, "k");
  assert.equal(row.reason, "admitted");
  assert.equal(Number(row.item_id), 9);
});

test("deleteEntity stamps its orphans `deleted`; a shared instance survives unstamped", async () => {
  const bid = await seedBoard(db, "led-entity");
  const sole = await seedIngested(bid, "sole.txt");
  await deleteEntity(db, sole.eid);
  assert.equal((await ledger(bid, "sole.txt")).reason, "deleted");

  // An instance shared with another entity survives the delete (it only
  // loses one home) — so its ledger row must NOT read as a rejection.
  const a = await createEntity(db, bid, { identity: "A" });
  const b = await createEntity(db, bid, { identity: "B" });
  const shared = await insertItem(db, bid, { identity: "shared" }, "held", a);
  await setItemEntities(db, shared, [a, b]);
  await recordIngest(db, bid, "shared.txt", Date.now(), { itemId: shared });
  await deleteEntity(db, a);
  assert.equal((await ledger(bid, "shared.txt")).reason, "admitted",
    "the instance lives on under the other entity — not a deletion");
});

test("deleteInstance stamps in its one statement", async () => {
  const bid = await seedBoard(db, "led-instance");
  const { iid } = await seedIngested(bid, "inst.txt");
  await deleteInstance(db, iid);
  assert.equal((await ledger(bid, "inst.txt")).reason, "deleted");
});

test("cancel-queued stamps queued feed adds — the cancel holds against the next tick", async () => {
  const bid = await seedBoard(db, "led-cancel");
  const eid = await createEntity(db, bid, { identity: "q" });
  const iid = await insertItem(db, bid, { identity: "q", unfetched: true }, "pending_fetch", eid);
  await recordIngest(db, bid, "q", Date.now(), { itemId: iid });
  const counts = await cancelBoardQueue(db, bid);
  assert.equal(counts.removed, 1);
  assert.equal((await ledger(bid, "q")).reason, "deleted",
    "unledgered, the next sweep tick would silently un-do the cancel");
});

test("a merge rewrites membership on the same item row — the link survives untouched", async () => {
  const bid = await seedBoard(db, "led-merge");
  const { eid, iid } = await seedIngested(bid, "merge.txt");
  const home = await createEntity(db, bid, { identity: "existing-home" });
  // What the extract leg does (worker.js): rewrite entity_ids, reconcile the
  // emptied shell. The item id never changes, so nothing re-points.
  await withTx(db, async (client) => {
    await setItemEntities(client, iid, [home]);
    await reconcileEntities(client, [eid, home]);
  });
  const row = await ledger(bid, "merge.txt");
  assert.equal(row.reason, "admitted");
  assert.equal(Number(row.item_id), iid);
  const { rows } = await db.query("SELECT 1 FROM entities WHERE id=$1", [eid]);
  assert.equal(rows.length, 0, "the shell died; the item and its link did not");
});

test("remember-deletions off: the delete lands, the stamp doesn't", async () => {
  const bid = await seedBoard(db, "led-forget-toggle");
  await updateBoard(db, bid, {
    ingest: { enabled: true, source: { folder: "x" }, trigger: { mode: "manual" }, rememberDeletions: false },
  });
  const a = await seedIngested(bid, "a.txt");
  await deleteInstance(db, a.iid);
  assert.equal((await ledger(bid, "a.txt")).reason, "admitted",
    "forward-only: nothing is stamped, so nothing holds the key back");
  const b = await seedIngested(bid, "b.txt");
  await deleteEntity(db, b.eid);
  assert.equal((await ledger(bid, "b.txt")).reason, "admitted", "same gate at the entity site");

  // Flipping it back on makes the NEXT deletion stick — the backlog above is
  // the user's separate call (the flip-off prompt's bring-back).
  await updateBoard(db, bid, {
    ingest: { enabled: true, source: { folder: "x" }, trigger: { mode: "manual" }, rememberDeletions: true },
  });
  const c = await seedIngested(bid, "c.txt");
  await deleteInstance(db, c.iid);
  assert.equal((await ledger(bid, "c.txt")).reason, "deleted");
});

test("ledger counts + scoped forget", async () => {
  const bid = await seedBoard(db, "led-counts");
  await recordIngest(db, bid, "a", Date.now());
  await recordIngest(db, bid, "b", Date.now(), { reason: "deleted" });
  await recordIngest(db, bid, "c", Date.now(), { reason: "deleted" });
  await recordIngest(db, bid, "d", Date.now(), { reason: "skipped" });
  assert.deepEqual(await ingestLedgerCounts(db, bid),
    { total: 4, on_board: 1, held: 2, unprocessable: 1 });

  assert.equal(await clearIngestLog(db, bid, "deleted"), 2);
  assert.deepEqual(await ingestLedgerCounts(db, bid),
    { total: 2, on_board: 1, held: 0, unprocessable: 1 });
  assert.equal(await clearIngestLog(db, bid), 2, "the default reach is everything");
  assert.deepEqual(await ingestLedgerCounts(db, bid),
    { total: 0, on_board: 0, held: 0, unprocessable: 0 });
});

test("itemBySourceKey sees only provenance carriers on the right board", async () => {
  const bid = await seedBoard(db, "led-probe");
  const other = await seedBoard(db, "led-probe-other");
  const eid = await createEntity(db, bid, { identity: "p" });
  const iid = await insertItem(db, bid,
    { identity: "p", provenance: { key: "a/b.txt", hash: "h", size: 12, modified: 99 } }, "held", eid);
  assert.deepEqual(await itemBySourceKey(db, bid, "a/b.txt"), { id: iid, size: 12, modified: 99 },
    "the slot's recorded facts ride along — a path is only evidence while they hold");
  assert.equal(await itemBySourceKey(db, bid, "other.txt"), null);
  assert.equal(await itemBySourceKey(db, other, "a/b.txt"), null, "board-scoped");
});
