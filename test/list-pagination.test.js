// The list endpoint's three modes: keyset pagination (?limit/&after walks
// (created_at DESC, id DESC) without skips or dups, ties included), delta
// polling (?since= returns only entities whose own or instance stamps moved,
// plus the board's full id list), and the hearts/fav joins that replaced the
// per-row correlated subqueries. Also pins the delta-visibility stamps: writes
// that change an entity's list payload from OTHER rows (instance delete,
// split re-parent, favorite toggles) must bump entities.updated_at.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard, seedItem, seedUser, adminSession, req } from "./helpers.js";
import {
  listItems,
  insertItem,
  deleteInstance,
  setItemEntities,
  reconcileEntities,
  setEntityIdentity,
  toggleFavorite,
  createCrate,
  toggleCrateItem,
} from "../server/db.js";

let srv, db, admin;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  admin = await adminSession(db);
});
after(() => srv.close());

// Delta tests set every stamp on a board to a known past value, act, then ask
// "what changed since SINCE?" — deterministic, no sleeps or clock races.
const PAST = 1000;
const SINCE = 2000;
async function rewind(boardId) {
  await db.query("UPDATE entities SET updated_at=$1 WHERE board_id=$2", [PAST, boardId]);
  await db.query("UPDATE items SET updated_at=$1 WHERE board_id=$2", [PAST, boardId]);
}

const ids = (items) => items.map((i) => i.id);

test("keyset pages are disjoint, complete, ordered — ties crossed by id", async () => {
  const boardId = await seedBoard(db, "pages");
  const seeded = [];
  for (let i = 0; i < 5; i++) seeded.push(await seedItem(db, boardId));
  // Newest-first target order: a(50), b(40), then a created_at tie broken by
  // id DESC, then e(10). seedItem returns ascending ids.
  const [e10, tieLow, tieHigh, b40, a50] = seeded;
  const stamps = [[a50, 50], [b40, 40], [tieHigh, 30], [tieLow, 30], [e10, 10]];
  for (const [ent, ts] of stamps) await db.query("UPDATE entities SET created_at=$1 WHERE id=$2", [ts, ent.id]);
  const expected = [a50.id, b40.id, tieHigh.id, tieLow.id, e10.id];

  // limit=1 walk: every boundary is a page boundary, including the tie. Five
  // full pages then one empty page (exact multiple), then the cursor dies.
  // listItems takes the parsed cursor; splitting the emitted "<ts>_<id>"
  // token mirrors what the route does.
  const parseCursor = (c) => c && { createdAt: Number(c.split("_")[0]), id: Number(c.split("_")[1]) };
  const walked = [];
  let cursor = null, pages = 0;
  do {
    const page = await listItems(db, admin.id, boardId, { limit: 1, after: parseCursor(cursor) });
    walked.push(...ids(page.items));
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 10, "cursor must terminate");
  } while (cursor);
  assert.deepEqual(walked, expected);
  assert.equal(pages, 6, "exact-multiple total ends with one empty page");

  // limit=2 spot-check: the tie pair lands on one page, cursor mid-tie works.
  const p1 = await listItems(db, admin.id, boardId, { limit: 2 });
  assert.deepEqual(ids(p1.items), [a50.id, b40.id]);
  assert.equal(p1.nextCursor, `40_${b40.id}`);
  const p2 = await listItems(db, admin.id, boardId, { limit: 2, after: { createdAt: 40, id: b40.id } });
  assert.deepEqual(ids(p2.items), [tieHigh.id, tieLow.id]);
  const p3 = await listItems(db, admin.id, boardId, { limit: 2, after: { createdAt: 30, id: tieLow.id } });
  assert.deepEqual(ids(p3.items), [e10.id]);
  assert.equal(p3.nextCursor, null, "short page ends the walk");
});

test("since returns entity-level and instance-level changes, nothing else", async () => {
  const boardId = await seedBoard(db, "delta");
  const [eA, eB, eC] = [await seedItem(db, boardId), await seedItem(db, boardId), await seedItem(db, boardId)];
  await rewind(boardId);

  const quiet = await listItems(db, admin.id, boardId, { since: SINCE });
  assert.deepEqual(quiet.items, [], "nothing changed → empty delta");

  await setEntityIdentity(db, eA.id, "renamed-key", "Renamed"); // entity-level stamp
  await db.query("UPDATE items SET updated_at=$1 WHERE id=$2", [Date.now(), eB.instanceId]); // instance-level
  const delta = await listItems(db, admin.id, boardId, { since: SINCE });
  assert.deepEqual(ids(delta.items).sort(), [eA.id, eB.id].sort());
  assert.ok(!ids(delta.items).includes(eC.id), "untouched entity stays out of the delta");
});

test("losing an instance surfaces the parent: delete and split re-parent", async () => {
  const boardId = await seedBoard(db, "delta-stamps");
  const eA = await seedItem(db, boardId);
  const secondId = await insertItem(db, boardId, { identity: eA.filename, files: [], fields: {} }, "tagged", eA.id);
  const eB = await seedItem(db, boardId);
  await rewind(boardId);

  await deleteInstance(db, secondId);
  let delta = await listItems(db, admin.id, boardId, { since: SINCE });
  assert.deepEqual(ids(delta.items), [eA.id], "instance delete stamps the parent");

  // Split: move eA's remaining... give it another instance first, then move
  // one under eB — eA survives minus an instance and must surface too (eB
  // surfaces via the moved row's own stamp).
  const thirdId = await insertItem(db, boardId, { identity: eA.filename, files: [], fields: {} }, "tagged", eA.id);
  await rewind(boardId);
  await setItemEntities(db, thirdId, [eB.id]);      // move the third instance under eB
  await reconcileEntities(db, [eA.id, eB.id]);       // eA keeps its own instance → survives (split)
  delta = await listItems(db, admin.id, boardId, { since: SINCE });
  assert.deepEqual(ids(delta.items).sort(), [eA.id, eB.id].sort());
});

test("favorite toggles stamp the entity; hearts joins count correctly", async () => {
  const boardId = await seedBoard(db, "hearts");
  const eA = await seedItem(db, boardId);
  const eB = await seedItem(db, boardId);
  const other = await seedUser(db, "hearts-other@test.local");
  await rewind(boardId);

  await toggleFavorite(db, admin.id, eA.id);
  const delta = await listItems(db, admin.id, boardId, { since: SINCE });
  assert.deepEqual(ids(delta.items), [eA.id], "heart lands in the delta");

  await toggleFavorite(db, other.id, eA.id);
  const { items } = await listItems(db, admin.id, boardId);
  const a = items.find((i) => i.id === eA.id);
  const b = items.find((i) => i.id === eB.id);
  assert.equal(a.hearts, 2);
  assert.equal(b.hearts, 0, "no hearts must read 0, not null");
  assert.equal(a.favoritedByMe, true);
  assert.equal(b.favoritedByMe, false);
  const asOther = await listItems(db, other.id, boardId);
  assert.equal(asOther.items.find((i) => i.id === eB.id).favoritedByMe, false);

  // Un-heart: count drops and the change is delta-visible again.
  await rewind(boardId);
  await toggleFavorite(db, other.id, eA.id);
  const unheart = await listItems(db, admin.id, boardId, { since: SINCE });
  assert.deepEqual(ids(unheart.items), [eA.id]);
  assert.equal(unheart.items[0].hearts, 1);

  // Crate membership rides the entity payload the same way.
  const crate = await createCrate(db, admin.id, boardId, "delta-crate");
  await rewind(boardId);
  await toggleCrateItem(db, admin.id, crate.id, eB.id);
  const crated = await listItems(db, admin.id, boardId, { since: SINCE });
  assert.deepEqual(ids(crated.items), [eB.id], "crate toggle lands in the delta");
  assert.deepEqual(crated.items[0].crateIds, [crate.id]);
});

test("route shapes: bare array, page object, delta object, 400 on bad cursors", async () => {
  const boardId = await seedBoard(db, "shapes");
  const seeded = [await seedItem(db, boardId), await seedItem(db, boardId), await seedItem(db, boardId)];

  const legacy = await req(srv.base, "GET", `/api/items?board=${boardId}`, { sid: admin.sid });
  assert.equal(legacy.status, 200);
  assert.ok(Array.isArray(legacy.json), "no params keeps the bare-array shape");
  assert.equal(legacy.json.length, 3);

  const page = await req(srv.base, "GET", `/api/items?board=${boardId}&limit=2`, { sid: admin.sid });
  assert.equal(page.status, 200);
  assert.equal(page.json.items.length, 2);
  assert.match(page.json.nextCursor, /^\d+_\d+$/);
  assert.equal(typeof page.json.now, "number");

  const rest = await req(srv.base, "GET", `/api/items?board=${boardId}&after=${page.json.nextCursor}`, { sid: admin.sid });
  assert.equal(rest.status, 200);
  assert.equal(rest.json.items.length, 1, "after without limit drains the rest");
  assert.equal(rest.json.nextCursor, null);
  assert.deepEqual(
    [...ids(page.json.items), ...ids(rest.json.items)].sort(),
    seeded.map((s) => s.id).sort(),
    "pages cover the board exactly"
  );

  const delta = await req(srv.base, "GET", `/api/items?board=${boardId}&since=${Date.now() + 60000}`, { sid: admin.sid });
  assert.equal(delta.status, 200);
  assert.deepEqual(delta.json.items, []);
  assert.deepEqual(delta.json.ids.sort(), seeded.map((s) => s.id).sort(), "ids list is the whole board");
  assert.equal(typeof delta.json.now, "number");

  assert.equal((await req(srv.base, "GET", `/api/items?board=${boardId}&after=nonsense`, { sid: admin.sid })).status, 400);
  assert.equal((await req(srv.base, "GET", `/api/items?board=${boardId}&since=-5`, { sid: admin.sid })).status, 400);
});
