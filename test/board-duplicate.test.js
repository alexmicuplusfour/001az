// Duplicating a board copies its CONFIGURATION and none of its content
// (planning/board-duplicate-plan.md).
//
// Duplication works by SUBTRACTING NOT_DUPLICATED from BOARD_COL_LIST, so a
// board setting added later travels by default — the inverse of the allow-list
// failure (add a column, forget the second list, duplication silently stops
// carrying it with every test still green). Two tests pin that subtraction
// where it can actually fail: "every exclusion names a real board column"
// cross-checks the deny-list against the column list, and "matches the source
// on every column outside the deny-list" checks the result behaviourally. A
// third test asserting NOT_DUPLICATED equals a hand-copied literal was dropped
// — a list-mirrors-list assertion can only catch an edit to one of its own two
// copies, and locks the duplication in to do it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, seedItem, req } from "./helpers.js";
import {
  BOARD_COL_LIST, NOT_DUPLICATED, setBoardMembers, getBoard, updateBoard,
  getBoardMemberIds, getBoardAdminIds, boardHasItems,
} from "../server/db.js";

let srv, db, base;
let admin, member, boardAdmin, outsider;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  member = await seedUser(db, "dup-member@test.local");
  boardAdmin = await seedUser(db, "dup-boardadmin@test.local");
  outsider = await seedUser(db, "dup-outsider@test.local");
});

after(() => srv.close());

test("every exclusion names a real board column", () => {
  // A typo'd entry would silently exclude nothing and copy the column it meant
  // to block — the one failure this deny-list can still have, and the only one
  // the tests below could not catch on their own.
  for (const col of NOT_DUPLICATED) {
    assert.ok(BOARD_COL_LIST.includes(col), `NOT_DUPLICATED names "${col}", which is not a board column`);
  }
});

// A board with something set in every copyable dimension, so the column-for-
// column assertion below has something to be wrong about.
async function seedConfiguredBoard(name) {
  const id = await seedBoard(db, name, [member.id, boardAdmin.id]);
  await setBoardMembers(db, id, [member.id, boardAdmin.id], [boardAdmin.id]);
  await updateBoard(db, id, {
    facets: [{ key: "season", label: "Season", values: ["summer", "winter"], description: "when it is worn" }],
    context: "Classify these clothing items.",
    aiReasoning: false,
    aiVotes: 3,
    autoTag: false,
    autoTagPeriodic: true,
    autoTagEveryMin: 720,
    autoTagSkipWeekends: true,
    retagOnRefresh: true,
    mapping: { fields: [{ key: "brand", source: "extract", kind: "text", instruction: "the brand name" }] },
  });
  // Non-default values in every column the copy must NOT inherit, so both the
  // "everything else travels" and the "none of this travels" tests run against
  // a source that actually has them set.
  await db.query(
    `UPDATE boards SET auto_tag_next_run_at=$2, ingest_next_run_at=$2, paused=TRUE,
       ingest_state='{"phase":"scanning"}'::jsonb,
       facet_diagnostics='{"season":{"verdict":"contested"}}'::jsonb
     WHERE id=$1`,
    [id, Date.now()]
  );
  return id;
}

test("the copy matches the source on every column outside the deny-list", async () => {
  const srcId = await seedConfiguredBoard("Configured");

  const r = await req(base, "POST", `/api/admin/boards/${srcId}/duplicate`, { sid: admin.sid });
  assert.equal(r.status, 200);

  const src = await getBoard(db, srcId);
  const copy = await getBoard(db, r.json.id);
  const copied = BOARD_COL_LIST.filter((c) => !NOT_DUPLICATED.has(c));
  for (const col of copied) {
    assert.deepEqual(copy[col], src[col], `column "${col}" did not travel`);
  }
  assert.ok(copied.length > 15, "the copied set collapsed — the filter is wrong");
});

test("the copy inherits none of the excluded columns", async () => {
  const srcId = await seedConfiguredBoard("Excluded");

  const r = await req(base, "POST", `/api/admin/boards/${srcId}/duplicate`, { sid: admin.sid });
  const copy = await getBoard(db, r.json.id);

  assert.equal(copy.auto_tag_next_run_at, null);
  assert.equal(copy.ingest_next_run_at, null);
  assert.equal(copy.ingest_state, null);
  assert.equal(copy.paused, false);
  assert.deepEqual(copy.facet_diagnostics, {});
});

test("a scheduled feed arrives switched off; a manual one is untouched", async () => {
  const scheduled = {
    enabled: true,
    trigger: { mode: "interval", every: 60 },
    filters: [], source: { kind: "folder", path: "wardrobe" },
  };
  const schedId = await seedBoard(db, "Scheduled feed");
  await db.query("UPDATE boards SET ingest=$2 WHERE id=$1", [schedId, JSON.stringify(scheduled)]);

  const r1 = await req(base, "POST", `/api/admin/boards/${schedId}/duplicate`, { sid: admin.sid });
  const copy1 = await getBoard(db, r1.json.id);
  assert.equal(copy1.ingest.enabled, false, "a scheduled feed must arrive paused");
  // Everything ELSE about the feed survives — it is the schedule that is held,
  // not the configuration.
  assert.deepEqual(copy1.ingest.trigger, scheduled.trigger);
  assert.deepEqual(copy1.ingest.source, scheduled.source);
  assert.equal(r1.json.ingestPaused, true);

  // A manual feed never arms a timer, so there is nothing to hold — and
  // `enabled:false` is meaningless on one (the save trunk normalizes it back).
  const manual = { enabled: true, trigger: { mode: "manual" }, filters: [], source: { kind: "folder", path: "wardrobe" } };
  const manId = await seedBoard(db, "Manual feed");
  await db.query("UPDATE boards SET ingest=$2 WHERE id=$1", [manId, JSON.stringify(manual)]);

  const r2 = await req(base, "POST", `/api/admin/boards/${manId}/duplicate`, { sid: admin.sid });
  const copy2 = await getBoard(db, r2.json.id);
  assert.deepEqual(copy2.ingest, manual, "a manual feed must come across unchanged");
  assert.equal(r2.json.ingestPaused, false);

  // A feed the user had ALREADY paused stays paused, and reports that nothing
  // was switched off — the flag says what this operation did, not what state
  // the copy ended in. (ingestMode reads enabled:false as "paused", not
  // "scheduled", so there is nothing here to hold.)
  const offId = await seedBoard(db, "Already off");
  await db.query("UPDATE boards SET ingest=$2 WHERE id=$1",
    [offId, JSON.stringify({ ...scheduled, enabled: false })]);
  const r3 = await req(base, "POST", `/api/admin/boards/${offId}/duplicate`, { sid: admin.sid });
  assert.equal((await getBoard(db, r3.json.id)).ingest.enabled, false);
  assert.equal(r3.json.ingestPaused, false);

  // A board with no feed at all reports nothing to report.
  const bareId = await seedBoard(db, "No feed");
  const r4 = await req(base, "POST", `/api/admin/boards/${bareId}/duplicate`, { sid: admin.sid });
  assert.equal((await getBoard(db, r4.json.id)).ingest, null);
  assert.equal(r4.json.ingestPaused, false);
});

test("members and their roles come across", async () => {
  const srcId = await seedConfiguredBoard("Shared");
  const r = await req(base, "POST", `/api/admin/boards/${srcId}/duplicate`, { sid: admin.sid });

  const members = await getBoardMemberIds(db, r.json.id);
  const admins = await getBoardAdminIds(db, r.json.id);
  assert.deepEqual([...members].sort(), [member.id, boardAdmin.id].sort());
  assert.deepEqual(admins, [boardAdmin.id], "a board-admin on the original is one on the copy");
  assert.equal(r.json.members, 2);

  // A board nobody is on copies cleanly rather than reporting a phantom.
  const loneId = await seedBoard(db, "Lonely");
  const r2 = await req(base, "POST", `/api/admin/boards/${loneId}/duplicate`, { sid: admin.sid });
  assert.equal(r2.json.members, 0);
  assert.deepEqual(await getBoardMemberIds(db, r2.json.id), []);
});

test("the copy has no content — and is therefore template-unlocked", async () => {
  const srcId = await seedConfiguredBoard("With items");
  await seedItem(db, srcId);
  await seedItem(db, srcId);
  assert.equal(await boardHasItems(db, srcId), true);

  const r = await req(base, "POST", `/api/admin/boards/${srcId}/duplicate`, { sid: admin.sid });
  assert.equal(await boardHasItems(db, r.json.id), false);

  // has_items false is what unlocks the mapping template picker, which is the
  // point of a config-only copy: the mapping arrives editable.
  const settings = await req(base, "GET", `/api/boards/${r.json.id}/settings`, { sid: admin.sid });
  assert.equal(settings.json.has_items, false);
  assert.deepEqual(settings.json.mapping, (await getBoard(db, srcId)).mapping);

  // No history followed it either. (ai_board_usage is absent on purpose — 0040
  // folded it into usage_meter and dropped the table.)
  for (const table of ["items", "entities", "job_log", "ingest_log", "usage_meter"]) {
    const { rows } = await db.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE board_id=$1`, [r.json.id]);
    assert.equal(rows[0].c, 0, `${table} should be empty on the copy`);
  }
});

test("duplicating twice is allowed, and a copy can be copied", async () => {
  const srcId = await seedBoard(db, "Twice");
  const a = await req(base, "POST", `/api/admin/boards/${srcId}/duplicate`, { sid: admin.sid });
  const b = await req(base, "POST", `/api/admin/boards/${srcId}/duplicate`, { sid: admin.sid });
  assert.equal(a.json.name, "Copy of Twice");
  assert.equal(b.json.name, "Copy of Twice");
  assert.notEqual(a.json.id, b.json.id);

  const c = await req(base, "POST", `/api/admin/boards/${a.json.id}/duplicate`, { sid: admin.sid });
  assert.equal(c.json.name, "Copy of Copy of Twice");
});

test("admin only, and a missing board is a 404", async () => {
  const srcId = await seedBoard(db, "Guarded", [boardAdmin.id]);
  await setBoardMembers(db, srcId, [boardAdmin.id], [boardAdmin.id]);
  const url = `/api/admin/boards/${srcId}/duplicate`;

  // A board-admin may edit the board but may not create one from it. Anon is
  // 403 rather than 401 here because requireAdmin answers alone — the same
  // contract every other /api/admin route has.
  assert.equal((await req(base, "POST", url, { sid: boardAdmin.sid })).status, 403);
  assert.equal((await req(base, "POST", url, { sid: outsider.sid })).status, 403);
  assert.equal((await req(base, "POST", url)).status, 403);

  const gone = await req(base, "POST", "/api/admin/boards/does-not-exist/duplicate", { sid: admin.sid });
  assert.equal(gone.status, 404);
});
