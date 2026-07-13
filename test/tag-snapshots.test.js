// Judgment-history hygiene (worker-queue hole #9): tag_snapshots records
// CHANGES — addTagSnapshot's dedupe mirrors field_snapshots' moved-only
// discipline (identical tags+verdict append nothing; reasoning re-words every
// model call so it doesn't count) — plus the opt-in age-prune backstop.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startServer, seedBoard, seedItem } from "./helpers.js";
import { markTagged, setItemTags, pruneTagSnapshots } from "../server/db.js";

let srv, db, boardId;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  boardId = await seedBoard(db, "tag-snaps");
});
after(() => srv.close());

const snaps = async (id) =>
  (await db.query("SELECT source, tags, undecided FROM tag_snapshots WHERE item_id=$1 ORDER BY id", [id])).rows;

// markTagged is value-fenced (#7): it only lands on a claimed row, so stamp
// the in-flight status first — an honest simulation of claim → tag.
const tag = async (id, tags, undecided = false, reasoning = {}) => {
  await db.query("UPDATE items SET status='processing' WHERE id=$1", [id]);
  return markTagged(db, id, tags, undecided, reasoning);
};

test("identical re-tag appends nothing; a changed judgment appends", async () => {
  const { instanceId } = await seedItem(db, boardId);
  await tag(instanceId, ["kind/a", "mood/b"], false, { description: "first take" });
  assert.equal((await snaps(instanceId)).length, 1);

  // Same tags, reordered, reasoning re-worded — not a judgment change.
  await tag(instanceId, ["mood/b", "kind/a"], false, { description: "re-worded take" });
  assert.equal((await snaps(instanceId)).length, 1, "unchanged judgment must not re-record");

  await tag(instanceId, ["kind/a"], false, {});
  const rows = await snaps(instanceId);
  assert.equal(rows.length, 2, "a real change appends");
  assert.deepEqual(rows[1].tags, ["kind/a"]);
});

test("an undecided flip is a judgment change", async () => {
  const { instanceId } = await seedItem(db, boardId);
  await tag(instanceId, ["kind/a"], false, {});
  await tag(instanceId, ["kind/a"], true, {});
  assert.equal((await snaps(instanceId)).length, 2);
});

test("a user's no-op save appends nothing; a user change appends as 'user'", async () => {
  const { instanceId } = await seedItem(db, boardId);
  await tag(instanceId, ["kind/a"], false, {});
  await setItemTags(db, instanceId, ["kind/a"]);
  assert.equal((await snaps(instanceId)).length, 1, "no-op save is still a no-op");

  await setItemTags(db, instanceId, ["kind/z"]);
  const rows = await snaps(instanceId);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].source, "user");
});

test("facet-less taggings collapse to one empty row, not one per pass", async () => {
  const { instanceId } = await seedItem(db, boardId);
  // The extraction-only board path: markTagged(id, []) on every advance.
  await tag(instanceId, [], false, {});
  await tag(instanceId, [], false, {});
  await tag(instanceId, [], false, {});
  assert.equal((await snaps(instanceId)).length, 1);
});

test("migration 0013 collapses historical consecutive duplicates, keeping run heads", async () => {
  const { instanceId } = await seedItem(db, boardId);
  const ins = (tags, undecided, at) => db.query(
    "INSERT INTO tag_snapshots (item_id, source, tags, reasoning, undecided, tagged_at) VALUES ($1,'ai',$2,'{}',$3,$4)",
    [instanceId, JSON.stringify(tags), undecided, at]
  );
  const t0 = Date.now() - 10000;
  await ins(["a/x"], false, t0);     // keep — run head
  await ins(["a/x"], false, t0 + 1); // duplicate → collapsed
  await ins(["a/x"], false, t0 + 2); // duplicate → collapsed
  await ins(["b/y"], false, t0 + 3); // keep — judgment changed
  await ins(["a/x"], false, t0 + 4); // keep — changed back is still a change
  await ins(["a/x"], true, t0 + 5);  // keep — verdict flip

  const sql = fs.readFileSync(new URL("../server/migrations/0013_dedupe_tag_snapshots.sql", import.meta.url), "utf8");
  await db.query(sql);

  const rows = await snaps(instanceId);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => [r.tags[0], r.undecided]),
    [["a/x", false], ["b/y", false], ["a/x", false], ["a/x", true]]);
});

test("pruneTagSnapshots drops rows older than the cutoff, keeps the rest", async () => {
  const { instanceId } = await seedItem(db, boardId);
  const now = Date.now();
  await db.query(
    "INSERT INTO tag_snapshots (item_id, source, tags, reasoning, undecided, tagged_at) VALUES ($1,'ai','[\"old/one\"]','{}',FALSE,$2)",
    [instanceId, now - 91 * 86400000]
  );
  await tag(instanceId, ["new/one"], false, {});
  const pruned = await pruneTagSnapshots(db, now - 90 * 86400000);
  assert.equal(pruned, 1);
  const rows = await snaps(instanceId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tags, ["new/one"]);
});
