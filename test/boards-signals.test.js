// The boards index's attention dots (planning/boards-signals-plan.md): GET
// /api/boards/signals, one entry per accessible board carrying the three stamps
// the gallery's header dots are built from.
//
// Two things here are worth more than the rest. The alert half is PER USER and
// the boards are shared, so a GROUP BY that lost its user filter would hand one
// member another's counts — which is why two users are seeded on one board
// rather than one. And the diagnostics half is a DISCLOSURE gate: /facet-stats
// is requireBoardManager, so "there is a finding on this board" must not reach a
// plain member by way of a dot.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";
import {
  addJobLog, createAlert, createBoard, setBoardMembers,
  setFacetDiagnostic, latestJobFailureAt, BOARD_FAILURES_SQL, BOARD_ALERT_UNSEEN_SQL,
} from "../server/db.js";

let srv, db, base;
let admin, member, other, outsider;
let boardA, boardB, boardVotes, boardQuiet;

const FAILED_AT = 1_700_000_000_000;

// A stored finding in the shape diagnose() writes: an ACTIONABLE verdict and an
// explanation are what reach the `finding` state the dot is about.
const finding = (at, over = {}) => ({
  verdict: "overlapping-values", explanation: "a and b overlap",
  values: [], rewrite: "", stats: { items: 40, unanimous: 10 }, at, ...over,
});

const alertWith = async (userId, boardId, name, firings) => {
  const id = await createAlert(db, userId, boardId, {
    name, condition: {}, delivery: "immediate", daily_at_min: null,
    next_delivery_at: null, webhook_url: null, webhook_secret: null,
  });
  for (const { count, seen } of firings) {
    await db.query(
      "INSERT INTO alert_firings (alert_id, fired_at, entity_count, seen) VALUES ($1,$2,$3,$4)",
      [id, Date.now(), count, seen]
    );
  }
  return id;
};

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  member = await seedUser(db, "member@test.local");
  other = await seedUser(db, "other@test.local");
  outsider = await seedUser(db, "outsider@test.local");

  // A — member is a plain member. One real failure plus every outcome that is
  // deliberately NOT news, all newer than it.
  boardA = await seedBoard(db, "A", [member.id, other.id]);
  await addJobLog(db, { boardId: boardA, kind: "tag", outcome: "failed", startedAt: FAILED_AT });
  for (const outcome of ["requeued", "discarded", "interrupted", "running", "ok"]) {
    await addJobLog(db, { boardId: boardA, kind: "tag", outcome, startedAt: FAILED_AT + 10_000 });
  }

  // B — member is a plain member, no failures of any kind.
  boardB = await seedBoard(db, "B", [member.id]);
  await addJobLog(db, { boardId: boardB, kind: "tag", outcome: "ok", startedAt: FAILED_AT });

  // Votes — vote mode on, member is board-admin. Four stored entries, one of
  // each disposition, so the filter is exercised rather than described. Note
  // `gone` is NOT among the board's declared facets: a stored key whose facet
  // has left the board is a real state, and its stamp is the loudest here.
  boardVotes = await createBoard(
    db, "Votes",
    ["kind", "mood", "era"].map((key) => ({ key, label: key, values: ["a", "b"] })),
    "", true, null, null, {}, false, { aiVotes: 3 }
  );
  await setBoardMembers(db, boardVotes, [member.id], [member.id]);
  await setFacetDiagnostic(db, boardVotes, "kind", finding(5_000));
  await setFacetDiagnostic(db, boardVotes, "mood", finding(9_000, { stale: true }));
  await setFacetDiagnostic(db, boardVotes, "era", finding(8_000, { verdict: "genuinely-ambiguous-items" }));
  await setFacetDiagnostic(db, boardVotes, "gone", finding(7_000));

  // Quiet — accessible to member, nothing to report about it at all.
  boardQuiet = await seedBoard(db, "Quiet", [member.id]);

  // Alerts: two users holding alerts on ONE board, with different unseen sums.
  await alertWith(member.id, boardA, "mine", [{ count: 3, seen: false }, { count: 2, seen: false }, { count: 9, seen: true }]);
  await alertWith(other.id, boardA, "theirs", [{ count: 100, seen: false }]);
  // …and an alert whose firings are all acknowledged: a row that exists but is 0.
  await alertWith(member.id, boardB, "read", [{ count: 4, seen: true }]);
});

after(() => srv.close());

const signals = async (sid) => req(base, "GET", "/api/boards/signals", sid ? { sid } : {});
const find = (r, id) => r.json.find((b) => b.board_id === id);

test("unauthenticated is denied", async () => {
  assert.equal((await signals()).status, 401);
});

test("a member sees exactly their boards, and an outsider none", async () => {
  const r = await signals(member.sid);
  assert.equal(r.status, 200);
  const ids = r.json.map((b) => b.board_id).sort();
  assert.deepEqual(ids, [boardA, boardB, boardVotes, boardQuiet].sort());
  assert.equal((await signals(outsider.sid)).json.length, 0);
});

test("a board with nothing to say is present with nulls, not absent", async () => {
  // Absence would mean both "nothing here" and "not in this response", which is
  // the conflation `landed` and state.facetStats each had to be rescued from.
  const q = find(await signals(member.sid), boardQuiet);
  assert.deepEqual(q, { board_id: boardQuiet, failed_at: null, alerts_unseen: 0, diagnostic_at: null });
});

test("failed_at agrees with the gallery's own stamp, and is board-scoped", async () => {
  const r = await signals(member.sid);
  assert.equal(find(r, boardA).failed_at, FAILED_AT);
  assert.equal(find(r, boardA).failed_at, await latestJobFailureAt(db, boardA));
  // B has a job log and no failures: a failure on A must not light B.
  assert.equal(find(r, boardB).failed_at, null);
});

test("only 'failed' is news — a retry, a discard, a restart and a live row are not", async () => {
  // All four sit NEWER than the real failure on board A, so anything that
  // counted them would report their stamp instead of FAILED_AT.
  assert.equal(find(await signals(member.sid), boardA).failed_at, FAILED_AT);
});

test("alerts_unseen is per user, on a board both users can see", async () => {
  // The assertion that catches a GROUP BY which dropped its user filter — a
  // cross-user leak every single-user test passes straight through.
  assert.equal(find(await signals(member.sid), boardA).alerts_unseen, 5);
  assert.equal(find(await signals(other.sid), boardA).alerts_unseen, 100);
});

test("an alert whose firings are all seen reads 0", async () => {
  assert.equal(find(await signals(member.sid), boardB).alerts_unseen, 0);
});

test("diagnostic_at is the newest entry that would reach the `finding` state", async () => {
  // kind (5,000) is the only one of the four that qualifies. The three louder
  // stamps above it are each excluded for their own reason, so a filter that
  // dropped any one of them would report that one's stamp instead.
  assert.equal(find(await signals(member.sid), boardVotes).diagnostic_at, 5_000);
});

test("a stale entry does not light — a retag has already superseded it", async () => {
  const r = await db.query("SELECT facet_diagnostics->'mood' AS d FROM boards WHERE id=$1", [boardVotes]);
  assert.equal(r.rows[0].d.stale, true, "the fixture is what this claims it is");
});

test("a finding for a facet the board no longer declares does not light", async () => {
  // Invisible in the gallery, which drives off board.facets — so a dot lit by
  // one could never be acknowledged from anywhere. Stored at 7,000, above the
  // 5,000 that wins, so a filter missing this rule reports the wrong stamp
  // rather than merely an extra one.
  const { rows } = await db.query("SELECT facet_diagnostics->'gone'->>'at' AS at FROM boards WHERE id=$1", [boardVotes]);
  assert.equal(rows[0].at, "7000", "the fixture is what this claims it is");
  assert.equal(find(await signals(member.sid), boardVotes).diagnostic_at, 5_000);
});

test("diagnostic_at is refused to a member who cannot manage the board", async () => {
  // The disclosure gate. `other` can reach boardA but manages nothing.
  const mine = find(await signals(member.sid), boardVotes);
  assert.equal(mine.diagnostic_at, 5_000, "the manager sees it");
  await setBoardMembers(db, boardVotes, [member.id, other.id], [member.id]);
  const theirs = find(await signals(other.sid), boardVotes);
  assert.equal(theirs.board_id, boardVotes, "…and the plain member still sees the board");
  assert.equal(theirs.diagnostic_at, null, "…but learns nothing about its findings");
});

test("diagnostic_at is null on a board without vote mode, however old the finding", async () => {
  // A single-pass board writes no confidence at all, so there is nothing behind
  // the dot even for the manager who could open it.
  await setFacetDiagnostic(db, boardA, "kind", finding(6_000));
  assert.equal(find(await signals(admin.sid), boardA).diagnostic_at, null);
});

test("a global admin gets every board", async () => {
  const ids = (await signals(admin.sid)).json.map((b) => b.board_id);
  for (const id of [boardA, boardB, boardVotes, boardQuiet]) assert.ok(ids.includes(id));
});

// Both plans are pinned rather than timed, and against the app's own exported
// SQL rather than a copy: the regression each guards is a query drifting off the
// index cut for it, which returns the right answer slowly and is invisible from
// outside. Both seed volume first — on a table of four rows a sequential scan
// really is the cheapest thing available, and asserting otherwise would pin the
// planner being wrong.

test("the failure sweep runs on the partial index, not a sequential scan", async () => {
  // Measured at 100k rows: 0.27 ms on the LATERAL against 10.06 ms for the
  // GROUP BY form, which sorts every failed row on the board to take a MAX.
  const b = await seedBoard(db, "plan-jobs");
  await db.query(
    `INSERT INTO job_log (board_id, kind, outcome, started_at)
     SELECT $1, 'tag', 'ok', 1000000 + g FROM generate_series(1, 500) g`,
    [b]
  );
  await db.query("ANALYZE job_log");
  // A board with NO failures — the case 0032 found was worst and the one a
  // healthy instance is always in.
  const { rows } = await db.query(`EXPLAIN ${BOARD_FAILURES_SQL}`, [[b]]);
  const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
  assert.match(plan, /idx_job_log_failed/, `expected the partial index:\n${plan}`);
  assert.doesNotMatch(plan, /Seq Scan on job_log/, `expected no sequential scan:\n${plan}`);
});

test("the alert sweep does not sequentially scan every user's firings", async () => {
  // 0037, and the failure it guards is DIRECTIONAL: without the index the
  // planner reaches for a sequential scan exactly when a large share of firings
  // are unseen — so the reader with the most unread news pays the most to be
  // told about it. Seeded mostly-seen, which is the healthy shape.
  const u = await seedUser(db, "plan@test.local");
  const id = await alertWith(u.id, boardA, "plan", []);
  await db.query(
    `INSERT INTO alert_firings (alert_id, fired_at, entity_count, seen)
     SELECT $1, 1000000 + g, 1, (g % 25 <> 0) FROM generate_series(1, 800) g`,
    [id]
  );
  await db.query("ANALYZE alert_firings");
  const { rows } = await db.query(`EXPLAIN ${BOARD_ALERT_UNSEEN_SQL}`, [u.id]);
  const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
  assert.match(plan, /idx_alert_firings_unseen/, `expected the partial index:\n${plan}`);
  assert.doesNotMatch(plan, /Seq Scan on alert_firings/, `expected no sequential scan:\n${plan}`);
});
