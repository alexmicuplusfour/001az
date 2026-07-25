// Alerts: the matcher, the tag-landing detection hook, the delivery sweep
// (settle window / daily stamp / record-only), webhook send + retry, and the
// per-user API. The worker loops don't run under test, so every sweep pass
// here is an explicit deliverDueAlerts() call — deterministic by design.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { startServer, adminSession, seedUser, seedItem, req } from "./helpers.js";
import { createBoard, createEntity, insertItem, setBoardMembers, reparentInstance } from "../server/db.js";
import {
  matchesCondition,
  nextDailyAt,
  encodeConditionF,
  evaluateItemAlerts,
  deliverDueAlerts,
  buildFiringPayload,
} from "../server/alerts.js";

let srv, db, base, admin, boardId;

// A local webhook receiver the sweep can actually hit. `status` is mutable so
// a test can turn it into a failing endpoint; every request is captured.
let hook, hookUrl;
const hookState = { status: 200, requests: [] };

const FACETS = [
  { key: "kind", label: "Kind", single: false, values: ["a", "b"] },
  { key: "color", label: "Color", single: false, values: ["red", "blue"] },
];

before(async () => {
  process.env.BASE_URL = ""; // links assertions below assume no base is set
  srv = await startServer();
  db = srv.db;
  base = srv.base;
  admin = await adminSession(db);
  boardId = await createBoard(db, "Alerts board", FACETS, "", true, null, null, { enabled: true });

  hook = http.createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      hookState.requests.push({ headers: rq.headers, body });
      rs.statusCode = hookState.status;
      rs.end();
    });
  });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;
});

after(async () => {
  await new Promise((r) => hook.close(r));
  await srv.close();
});

// --- helpers ---

// What detection recorded (pending + delivered). Baseline rows — the
// already-matching set seeded at create/edit, claimed under firing_id 0 —
// are the silent floor, asserted through baselineOf instead.
const matchesOf = async (alertId) =>
  (await db.query("SELECT * FROM alert_matches WHERE alert_id=$1 AND (firing_id IS NULL OR firing_id <> 0) ORDER BY entity_id", [alertId])).rows;
const baselineOf = async (alertId) =>
  (await db.query("SELECT * FROM alert_matches WHERE alert_id=$1 AND firing_id = 0 ORDER BY entity_id", [alertId])).rows;
const firingsOf = async (alertId) =>
  (await db.query("SELECT * FROM alert_firings WHERE alert_id=$1 ORDER BY id", [alertId])).rows;
const backdate = (alertId, ms) =>
  db.query("UPDATE alert_matches SET matched_at = matched_at - $2 WHERE alert_id=$1", [alertId, ms]);

async function makeAlert(body) {
  const r = await req(base, "POST", "/api/alerts", { sid: admin.sid, body: { board_id: boardId, ...body } });
  assert.equal(r.status, 200, r.text);
  return r.json.alert;
}

// A tagged entity: one instance whose tags land via the manual PATCH route —
// exercising the real detection hook, not a shortcut.
async function taggedEntity(tags) {
  const { id, instanceId } = await seedItem(db, boardId);
  const r = await req(base, "PATCH", `/api/instances/${instanceId}/tags`, { sid: admin.sid, body: { tags } });
  assert.equal(r.status, 200, r.text);
  return { id, instanceId };
}

// --- the matcher ---

test("matchesCondition: OR within a facet, AND across facets", () => {
  const tags = new Set(["kind/a", "color/red"]);
  assert.equal(matchesCondition(tags, { kind: ["a"] }), true);
  assert.equal(matchesCondition(tags, { kind: ["b", "a"] }), true); // OR within
  assert.equal(matchesCondition(tags, { kind: ["b"] }), false);
  assert.equal(matchesCondition(tags, { kind: ["a"], color: ["red"] }), true); // AND across
  assert.equal(matchesCondition(tags, { kind: ["a"], color: ["blue"] }), false);
  assert.equal(matchesCondition(tags, {}), false); // empty matches nothing
  assert.equal(matchesCondition(new Set(), { kind: ["a"] }), false);
});

test("nextDailyAt: today when the time is ahead, tomorrow when it passed", () => {
  const noon = new Date(2026, 6, 25, 12, 0, 0, 0).getTime();
  const at9 = 9 * 60, at15 = 15 * 60;
  assert.equal(nextDailyAt(at15, noon), new Date(2026, 6, 25, 15, 0, 0, 0).getTime());
  assert.equal(nextDailyAt(at9, noon), new Date(2026, 6, 26, 9, 0, 0, 0).getTime());
});

test("encodeConditionF mirrors the client's encodeSelected", () => {
  assert.equal(encodeConditionF({ kind: ["b", "a"], color: ["red"] }), "color:red;kind:a,b");
});

test("webhook links ride BASE_URL — the invite-link knob, not a new one", () => {
  process.env.BASE_URL = "http://x.local/";
  try {
    const p = buildFiringPayload(
      { id: 9, alert_id: 1, name: "n", board_id: "b", fired_at: 1, entity_count: 1, condition: { kind: ["a"] } },
      [{ entity_id: 5, live_entity_id: 5, label: "L" }]
    );
    assert.equal(p.firing_id, 9); // the at-least-once dedupe key, first-class
    assert.equal(p.links.event, "http://x.local/?board=b&event=9");
    assert.equal(p.links.filter, "http://x.local/?board=b&f=" + encodeURIComponent("kind:a"));
    assert.equal(p.entities[0].url, "http://x.local/?board=b&item=5");
  } finally {
    process.env.BASE_URL = "";
  }
});

// --- detection ---

test("manual tagging into a watched set records a match; re-tagging doesn't duplicate", async () => {
  const alert = await makeAlert({ name: "watch a", condition: { kind: ["a"] } });
  const { id: entityId, instanceId } = await taggedEntity(["kind/a"]);

  let rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, entityId);
  assert.equal(rows[0].item_id, instanceId);
  assert.ok(rows[0].label); // display label frozen at match time

  // Same entity, tags land again — the (alert, entity) key dedupes.
  await req(base, "PATCH", `/api/instances/${instanceId}/tags`, { sid: admin.sid, body: { tags: ["kind/a", "color/red"] } });
  rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);

  // A non-matching entity records nothing.
  await taggedEntity(["kind/b"]);
  assert.equal((await matchesOf(alert.id)).length, 1);
});

test("the union tag set across instances is what matches, not one instance's tags", async () => {
  const alert = await makeAlert({ name: "union", condition: { kind: ["a"], color: ["red"] } });

  const entityId = await createEntity(db, boardId, { identity: "union-entity" });
  const inst1 = await insertItem(db, boardId, { identity: "union-entity", files: [], fields: {} }, "tagged", entityId);
  const inst2 = await insertItem(db, boardId, { identity: "union-entity", files: [], fields: {} }, "tagged", entityId);

  // First instance alone satisfies only half the condition.
  await db.query(`UPDATE items SET tags='["kind/a"]'::jsonb WHERE id=$1`, [inst1]);
  await evaluateItemAlerts(db, inst1);
  assert.equal((await matchesOf(alert.id)).length, 0);

  // The second instance's tags complete the union — the entity now matches.
  await db.query(`UPDATE items SET tags='["color/red"]'::jsonb WHERE id=$1`, [inst2]);
  await evaluateItemAlerts(db, inst2);
  const rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, entityId);
});

test("creating an alert baselines the already-matching set — a retag re-landing stays silent", async () => {
  // This entity is on the board BEFORE the alert exists — the backlog a
  // periodic retag (retagBoard -> markTagged -> evaluateItemAlerts) would
  // otherwise re-announce wholesale.
  const { id: oldEntity, instanceId } = await taggedEntity(["kind/a", "color/blue"]);
  const alert = await makeAlert({ name: "baseline", condition: { kind: ["a"], color: ["blue"] }, webhook_url: hookUrl });

  // Seeded claimed, not pending: invisible to the sweep and to history.
  assert.equal((await matchesOf(alert.id)).length, 0);
  const seeded = await baselineOf(alert.id);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].entity_id, oldEntity);

  // Tags land again on the old entity (what a board retag does) — the
  // baseline row absorbs the re-landing, and the sweep has nothing to say.
  await req(base, "PATCH", `/api/instances/${instanceId}/tags`, { sid: admin.sid, body: { tags: ["kind/a", "color/blue"] } });
  assert.equal((await matchesOf(alert.id)).length, 0);
  hookState.requests.length = 0;
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 0);
  assert.equal(hookState.requests.length, 0);

  // A genuinely new arrival is still news.
  await taggedEntity(["kind/a", "color/blue"]);
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);
  const firings = await firingsOf(alert.id);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].entity_count, 1);
});

test("a condition edit re-baselines: widening doesn't announce the newly-covered backlog", async () => {
  const { id: oldEntity, instanceId } = await taggedEntity(["kind/b", "color/red"]);
  // kind/b doesn't match yet — the alert watches kind/a.
  const alert = await makeAlert({ name: "widen", condition: { kind: ["a"], color: ["red"] } });
  assert.ok(!(await baselineOf(alert.id)).some((m) => m.entity_id === oldEntity));

  // Widen kind to cover b — the old entity now matches, but it isn't news.
  const r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { condition: { kind: ["a", "b"], color: ["red"] } } });
  assert.equal(r.status, 200, r.text);
  assert.ok((await baselineOf(alert.id)).some((m) => m.entity_id === oldEntity));
  assert.equal((await matchesOf(alert.id)).length, 0);

  // Its next landing stays silent; a fresh arrival under the widened
  // condition still records.
  await req(base, "PATCH", `/api/instances/${instanceId}/tags`, { sid: admin.sid, body: { tags: ["kind/b", "color/red"] } });
  assert.equal((await matchesOf(alert.id)).length, 0);
  const fresh = await taggedEntity(["kind/b", "color/red"]);
  const rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, fresh.id);
});

test("a merge re-parent completes the union — evaluating at the move records the match", async () => {
  const alert = await makeAlert({ name: "merge-across", condition: { kind: ["a"], color: ["red"] } });
  // Two entities, each holding half the condition — neither landing records.
  const half1 = await taggedEntity(["kind/a"]);
  const half2 = await taggedEntity(["color/red"]);
  assert.equal((await matchesOf(alert.id)).length, 0);

  // The extract leg derives the same identity for half2's instance and merges
  // it into half1's entity; the instance keeps its tags through the move, so
  // the union now satisfies the condition. This is the reparentInstance +
  // evaluateItemAlerts sequence extractOne runs on a merge/split.
  const { rows: [target] } = await db.query("SELECT id, identity, display_name FROM entities WHERE id=$1", [half1.id]);
  await reparentInstance(db, half2.instanceId, target, target.display_name, half2.id);
  await evaluateItemAlerts(db, half2.instanceId);

  const rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, half1.id);
  assert.equal(rows[0].item_id, half2.instanceId);
});

test("a disabled alert stops matching", async () => {
  const alert = await makeAlert({ name: "toggled", condition: { kind: ["a"] } });
  const r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { enabled: false } });
  assert.equal(r.status, 200);
  await taggedEntity(["kind/a"]);
  assert.equal((await matchesOf(alert.id)).length, 0);
});

// --- delivery: settle window ---

test("fresh matches sit through the settle window; settled ones group into one firing and the webhook fires", async () => {
  const alert = await makeAlert({ name: "settled", condition: { color: ["blue"] }, webhook_url: hookUrl });
  await taggedEntity(["color/blue"]);
  await taggedEntity(["color/blue"]);

  // Still settling: nothing groups.
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 0);

  // Past the settle window: one firing for both matches, webhook delivered.
  hookState.requests.length = 0;
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);
  const firings = await firingsOf(alert.id);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].entity_count, 2);
  assert.equal(firings[0].webhook_status, "ok");
  assert.equal(firings[0].attempts, 1);

  assert.equal(hookState.requests.length, 1);
  const payload = JSON.parse(hookState.requests[0].body);
  assert.equal(payload.firing_id, firings[0].id); // resend-stable dedupe key
  assert.equal(payload.alert.name, "settled");
  assert.equal(payload.board, boardId);
  assert.equal(payload.entity_count, 2);
  assert.equal(payload.entities.length, 2);
  assert.ok(payload.entities[0].label);
  assert.equal(payload.links, undefined); // no APP_URL under test

  // Matches are claimed — a second sweep fires nothing.
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 1);
});

test("the max-wait cap fires a trickle even while its newest match is fresh", async () => {
  const alert = await makeAlert({ name: "trickle", condition: { kind: ["b"] }, webhook_url: hookUrl });
  await taggedEntity(["kind/b"]);
  await taggedEntity(["kind/b"]);
  // Oldest PENDING past MAX_WAIT, newest just now: the trickle still
  // delivers. (Pending only — the baseline rows seeded at creation carry
  // lower entity ids and aren't the sweep's to see.)
  await db.query(
    `UPDATE alert_matches SET matched_at = matched_at - 700000
     WHERE alert_id=$1 AND entity_id = (SELECT MIN(entity_id) FROM alert_matches WHERE alert_id=$1 AND firing_id IS NULL)`,
    [alert.id]
  );
  await deliverDueAlerts(db);
  const firings = await firingsOf(alert.id);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].entity_count, 2);
});

test("record-only groups identically but never sends", async () => {
  const alert = await makeAlert({ name: "recorder", condition: { kind: ["a"], color: ["blue"] }, delivery: "record", webhook_url: hookUrl });
  await taggedEntity(["kind/a", "color/blue"]);
  hookState.requests.length = 0;
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);
  const firings = await firingsOf(alert.id);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].webhook_status, null);
  assert.equal(hookState.requests.length, 0);
});

// --- delivery: daily stamp ---

test("daily fires at its stamp and re-arms; an empty due stamp re-arms without firing", async () => {
  const alert = await makeAlert({ name: "digest", condition: { color: ["red"] }, delivery: "daily", daily_at: "09:00", webhook_url: hookUrl });
  await taggedEntity(["color/red"]);

  // Not due yet (the stamp is in the future): the settle sweep must not touch daily alerts.
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 0);

  // Pull the stamp into the past: fires and re-arms.
  await db.query("UPDATE alerts SET next_delivery_at = $2 WHERE id=$1", [alert.id, Date.now() - 1000]);
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 1);
  let { rows: [a] } = await db.query("SELECT next_delivery_at FROM alerts WHERE id=$1", [alert.id]);
  assert.ok(a.next_delivery_at > Date.now());

  // Due again with nothing pending: no firing, but the stamp still re-arms —
  // an overdue stamp must not turn into fire-on-next-match.
  await db.query("UPDATE alerts SET next_delivery_at = $2 WHERE id=$1", [alert.id, Date.now() - 1000]);
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 1);
  ({ rows: [a] } = await db.query("SELECT next_delivery_at FROM alerts WHERE id=$1", [alert.id]));
  assert.ok(a.next_delivery_at > Date.now());
});

// --- delivery: webhook failure, retry, signature ---

test("a failing webhook retries on a spaced schedule and lands on 'failed' with the error kept", async () => {
  const alert = await makeAlert({ name: "failing", condition: { kind: ["a"], color: ["red"] }, webhook_url: hookUrl });
  await taggedEntity(["kind/a", "color/red"]);
  await backdate(alert.id, 120000);

  // Pull the retry stamp into the past — the test's clock control, like
  // backdate() is for the settle window.
  const retryDue = () => db.query("UPDATE alert_firings SET retry_at = retry_at - 700000 WHERE alert_id=$1", [alert.id]);

  hookState.status = 500;
  try {
    const t0 = Date.now();
    await deliverDueAlerts(db);
    let [f] = await firingsOf(alert.id);
    assert.equal(f.webhook_status, "pending");
    assert.equal(f.attempts, 1);
    assert.equal(f.webhook_error, "HTTP 500");
    assert.ok(f.retry_at >= t0 + 60000); // spaced, not tick-paced

    // Not due yet: an immediate next sweep must not burn another attempt —
    // tick-paced retries would exhaust all three inside ~6 seconds.
    await deliverDueAlerts(db);
    [f] = await firingsOf(alert.id);
    assert.equal(f.attempts, 1);

    await retryDue();
    await deliverDueAlerts(db);
    [f] = await firingsOf(alert.id);
    assert.equal(f.attempts, 2);
    assert.equal(f.webhook_status, "pending");
    assert.ok(f.retry_at >= t0 + 300000); // the second gap is the long one

    await retryDue();
    await deliverDueAlerts(db);
    [f] = await firingsOf(alert.id);
    assert.equal(f.webhook_status, "failed");
    assert.equal(f.attempts, 3);

    // Spent: no further attempts.
    hookState.requests.length = 0;
    await deliverDueAlerts(db);
    assert.equal(hookState.requests.length, 0);
  } finally {
    hookState.status = 200;
  }
});

test("disabling an alert freezes its pending webhook; re-enable thaws and delivers", async () => {
  const alert = await makeAlert({ name: "paused-hook", condition: { kind: ["b"], color: ["blue"] }, webhook_url: hookUrl });
  await taggedEntity(["kind/b", "color/blue"]);
  await backdate(alert.id, 120000);

  // First attempt fails — the firing is owed a retry.
  hookState.status = 500;
  try {
    await deliverDueAlerts(db);
  } finally {
    hookState.status = 200;
  }
  let [f] = await firingsOf(alert.id);
  assert.equal(f.webhook_status, "pending");
  assert.equal(f.attempts, 1);

  // Off pauses delivery — due or not, nothing sends while disabled ("off
  // pauses matching and delivery" is the switch's whole promise).
  await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { enabled: false } });
  await db.query("UPDATE alert_firings SET retry_at = NULL WHERE alert_id=$1", [alert.id]);
  hookState.requests.length = 0;
  await deliverDueAlerts(db);
  assert.equal(hookState.requests.length, 0);
  [f] = await firingsOf(alert.id);
  assert.equal(f.attempts, 1);

  // Re-enable thaws it — the send completes.
  await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { enabled: true } });
  await deliverDueAlerts(db);
  [f] = await firingsOf(alert.id);
  assert.equal(f.webhook_status, "ok");
});

test("a secret signs the body with X-Alert-Signature", async () => {
  const alert = await makeAlert({ name: "signed", condition: { kind: ["b"], color: ["red"] }, webhook_url: hookUrl, webhook_secret: "s3cret" });
  await taggedEntity(["kind/b", "color/red"]);
  hookState.requests.length = 0;
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);

  assert.equal(hookState.requests.length, 1);
  const { headers, body } = hookState.requests[0];
  const expect = "sha256=" + crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(headers["x-alert-signature"], expect);
});

test("test-fire sends a sample payload and reports the verdict", async () => {
  const alert = await makeAlert({ name: "testfire", condition: { kind: ["a"] }, webhook_url: hookUrl });
  hookState.requests.length = 0;
  const r = await req(base, "POST", `/api/alerts/${alert.id}/test`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(hookState.requests.length, 1);
  const payload = JSON.parse(hookState.requests[0].body);
  assert.equal(payload.test, true);
  assert.equal(payload.firing_id, undefined); // a sample has no firing row
  assert.equal(payload.alert.name, "testfire");

  const bare = await makeAlert({ name: "no-hook", condition: { kind: ["a"] } });
  const r2 = await req(base, "POST", `/api/alerts/${bare.id}/test`, { sid: admin.sid });
  assert.equal(r2.status, 400);
});

test("a merged-away match delivers a link to the card that now holds the content", async () => {
  const alert = await makeAlert({ name: "merge-links", condition: { color: ["red"], kind: ["b"] }, webhook_url: hookUrl });
  // E matches and sits pending; T doesn't match on its own.
  const e = await taggedEntity(["color/red", "kind/b"]);
  const t = await taggedEntity(["kind/a"]);
  // The extract leg merges E's instance into T; emptied, E is deleted. The
  // match row keeps the recorded entity_id and frozen label.
  const { rows: [target] } = await db.query("SELECT id, identity, display_name FROM entities WHERE id=$1", [t.id]);
  await reparentInstance(db, e.instanceId, target, target.display_name, e.id);
  assert.equal((await db.query("SELECT 1 FROM entities WHERE id=$1", [e.id])).rowCount, 0);

  hookState.requests.length = 0;
  process.env.BASE_URL = "http://x.local";
  try {
    await backdate(alert.id, 120000);
    await deliverDueAlerts(db);
  } finally {
    process.env.BASE_URL = "";
  }
  assert.equal(hookState.requests.length, 1);
  const payload = JSON.parse(hookState.requests[0].body);
  assert.equal(payload.entities.length, 1);
  assert.equal(payload.entities[0].id, e.id); // the recorded fact
  assert.ok(payload.entities[0].label); // frozen at match time
  assert.equal(payload.entities[0].url, `http://x.local/?board=${boardId}&item=${t.id}`); // the living card

  // The ?event= view follows the merge too.
  const firingId = (await firingsOf(alert.id))[0].id;
  const ev = await req(base, "GET", `/api/alert-firings/${firingId}`, { sid: admin.sid });
  assert.deepEqual(ev.json.entityIds, [t.id]);
});

test("a hard-deleted match keeps its frozen label but drops the link", async () => {
  const alert = await makeAlert({ name: "gone-links", condition: { color: ["blue"], kind: ["b"] }, webhook_url: hookUrl });
  const e = await taggedEntity(["color/blue", "kind/b"]);
  await db.query("DELETE FROM items WHERE id=$1", [e.instanceId]);
  await db.query("DELETE FROM entities WHERE id=$1", [e.id]);

  hookState.requests.length = 0;
  process.env.BASE_URL = "http://x.local";
  try {
    await backdate(alert.id, 120000);
    await deliverDueAlerts(db);
  } finally {
    process.env.BASE_URL = "";
  }
  assert.equal(hookState.requests.length, 1);
  const payload = JSON.parse(hookState.requests[0].body);
  assert.equal(payload.entities.length, 1);
  assert.equal(payload.entities[0].id, e.id);
  assert.ok(payload.entities[0].label); // the payload still says WHAT it was
  assert.equal(payload.entities[0].url, undefined); // no link into an empty hunt

  const firingId = (await firingsOf(alert.id))[0].id;
  const ev = await req(base, "GET", `/api/alert-firings/${firingId}`, { sid: admin.sid });
  assert.deepEqual(ev.json.entityIds, []); // dropped from the view; the count keeps the original truth
  assert.equal(ev.json.firing.entity_count, 1);
});

// --- the API: validation, ownership, history ---

test("create validates its body", async () => {
  const bad = async (body, msg) => {
    const r = await req(base, "POST", "/api/alerts", { sid: admin.sid, body: { board_id: boardId, ...body } });
    assert.equal(r.status, 400, msg);
  };
  await bad({ name: "x" }, "empty condition");
  await bad({ name: "", condition: { kind: ["a"] } }, "empty name");
  await bad({ name: "x", condition: { kind: ["a"] }, delivery: "hourly" }, "bad delivery");
  await bad({ name: "x", condition: { kind: ["a"] }, delivery: "daily" }, "daily needs a time");
  await bad({ name: "x", condition: { kind: ["a"] }, webhook_url: "ftp://nope" }, "non-http url");

  await makeAlert({ name: "dupe", condition: { kind: ["a"] } });
  await bad({ name: "dupe", condition: { kind: ["a"] } }, "duplicate name");

  const r = await req(base, "POST", "/api/alerts", { sid: admin.sid, body: { board_id: "nope", name: "x", condition: { kind: ["a"] } } });
  assert.equal(r.status, 404);
});

test("junk :id params read as not-found, never a bigint cast 500", async () => {
  for (const id of ["abc", "0", "1.5"]) {
    for (const [method, path] of [
      ["PATCH", `/api/alerts/${id}`],
      ["DELETE", `/api/alerts/${id}`],
      ["GET", `/api/alerts/${id}/firings`],
      ["POST", `/api/alerts/${id}/seen`],
      ["POST", `/api/alerts/${id}/test`],
      ["GET", `/api/alert-firings/${id}`],
    ]) {
      const r = await req(base, method, path, { sid: admin.sid, body: method === "PATCH" ? {} : undefined });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
  }
});

test("alerts are private to their owner; the secret never echoes", async () => {
  const other = await seedUser(db, "other@test.local");
  await setBoardMembers(db, boardId, [other.id]);

  const alert = await makeAlert({ name: "mine", condition: { kind: ["a"] }, webhook_secret: "hush" });
  assert.equal(alert.has_secret, true);
  assert.equal(alert.webhook_secret, undefined);

  const list = await req(base, "GET", `/api/alerts?board=${boardId}`, { sid: other.sid });
  assert.equal(list.status, 200);
  assert.equal(list.json.some((a) => a.id === alert.id), false);

  for (const [method, path] of [
    ["PATCH", `/api/alerts/${alert.id}`],
    ["DELETE", `/api/alerts/${alert.id}`],
    ["GET", `/api/alerts/${alert.id}/firings`],
    ["POST", `/api/alerts/${alert.id}/test`],
  ]) {
    const r = await req(base, method, path, { sid: other.sid, body: method === "PATCH" ? {} : undefined });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
});

test("history: unseen counts, seen acknowledgement, and the ?event= fetch by board access", async () => {
  const other = await seedUser(db, "member2@test.local");
  await setBoardMembers(db, boardId, [other.id]);
  const outsider = await seedUser(db, "outsider@test.local");

  const alert = await makeAlert({ name: "history", condition: { color: ["blue"], kind: ["b"] } });
  const { id: entityId } = await taggedEntity(["color/blue", "kind/b"]);
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);

  const list = await req(base, "GET", `/api/alerts?board=${boardId}`, { sid: admin.sid });
  const mine = list.json.find((a) => a.id === alert.id);
  assert.equal(mine.unseen, 1);

  const firings = await req(base, "GET", `/api/alerts/${alert.id}/firings`, { sid: admin.sid });
  assert.equal(firings.status, 200);
  assert.equal(firings.json.firings.length, 1);
  assert.equal(firings.json.nextCursor, null); // one row, no more pages
  const firingId = firings.json.firings[0].id;

  await req(base, "POST", `/api/alerts/${alert.id}/seen`, { sid: admin.sid });
  const after = await req(base, "GET", `/api/alerts?board=${boardId}`, { sid: admin.sid });
  assert.equal(after.json.find((a) => a.id === alert.id).unseen, 0);

  // The firing view opens for any board member — a webhook link pasted in a
  // team channel — but not for an outsider.
  const asMember = await req(base, "GET", `/api/alert-firings/${firingId}`, { sid: other.sid });
  assert.equal(asMember.status, 200);
  assert.equal(asMember.json.firing.name, "history");
  assert.deepEqual(asMember.json.entityIds, [entityId]);
  const asOutsider = await req(base, "GET", `/api/alert-firings/${firingId}`, { sid: outsider.sid });
  assert.equal(asOutsider.status, 404);
});

test("firing history pages on a keyset cursor, newest first", async () => {
  const alert = await makeAlert({ name: "paged", condition: { color: ["blue"], kind: ["a"] } });
  // Three firings, one per settle cycle.
  for (let i = 0; i < 3; i++) {
    await taggedEntity(["color/blue", "kind/a"]);
    await backdate(alert.id, 120000);
    await deliverDueAlerts(db);
  }
  assert.equal((await firingsOf(alert.id)).length, 3);

  const page1 = await req(base, "GET", `/api/alerts/${alert.id}/firings?limit=2`, { sid: admin.sid });
  assert.equal(page1.status, 200);
  assert.equal(page1.json.firings.length, 2);
  assert.ok(page1.json.nextCursor); // exactly full — more behind it

  const page2 = await req(base, "GET", `/api/alerts/${alert.id}/firings?limit=2&after=${page1.json.nextCursor}`, { sid: admin.sid });
  assert.equal(page2.status, 200);
  assert.equal(page2.json.firings.length, 1);
  assert.equal(page2.json.nextCursor, null); // short page — the well is dry

  // Newest first across the walk, no overlap between pages.
  const walked = [...page1.json.firings, ...page2.json.firings];
  assert.equal(new Set(walked.map((f) => f.id)).size, 3);
  for (let i = 1; i < walked.length; i++) {
    assert.ok(walked[i - 1].fired_at > walked[i].fired_at
      || (walked[i - 1].fired_at === walked[i].fired_at && walked[i - 1].id > walked[i].id));
  }
});

test("the unseen badge counts new MATCHES across unseen firings, not firings", async () => {
  const alert = await makeAlert({ name: "badge-sum", condition: { kind: ["b"], color: ["blue"] } });
  // Firing one carries two entities, firing two carries one more.
  await taggedEntity(["kind/b", "color/blue"]);
  await taggedEntity(["kind/b", "color/blue"]);
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);
  await taggedEntity(["kind/b", "color/blue"]);
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 2);

  // "3" — the number of new items the user is owed. A COUNT(firings)
  // regression would say 2; a single-entity single-firing test can't tell
  // the two apart, which is why this one exists.
  const list = await req(base, "GET", `/api/alerts?board=${boardId}`, { sid: admin.sid });
  assert.equal(list.json.find((a) => a.id === alert.id).unseen, 3);
});

test("an alert goes dormant when its owner loses board access, and resumes when re-added", async () => {
  const exMember = await seedUser(db, "exmember@test.local");
  await setBoardMembers(db, boardId, [exMember.id]);
  const r = await req(base, "POST", "/api/alerts", {
    sid: exMember.sid,
    body: { board_id: boardId, name: "dormant", condition: { kind: ["a"] } },
  });
  assert.equal(r.status, 200, r.text);
  const alert = r.json.alert;

  // Revoked: a matching arrival records nothing — membership closes the pipe.
  await setBoardMembers(db, boardId, []);
  await taggedEntity(["kind/a"]);
  assert.equal((await matchesOf(alert.id)).length, 0);

  // Re-added: new arrivals match again.
  await setBoardMembers(db, boardId, [exMember.id]);
  await taggedEntity(["kind/a"]);
  assert.equal((await matchesOf(alert.id)).length, 1);

  // Pending matches freeze while revoked — the sweep won't group or deliver
  // them — and thaw on re-add.
  await backdate(alert.id, 120000);
  await setBoardMembers(db, boardId, []);
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 0);
  await setBoardMembers(db, boardId, [exMember.id]);
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 1);
});

test("edit recomputes the daily stamp and can clear the webhook", async () => {
  const alert = await makeAlert({ name: "editable", condition: { kind: ["a"] }, webhook_url: hookUrl, webhook_secret: "keepme" });
  // Absent secret on PATCH means keep — has_secret still true.
  let r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { delivery: "daily", daily_at: "23:59" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.alert.daily_at, "23:59");
  assert.equal(r.json.alert.has_secret, true);
  const { rows: [row] } = await db.query("SELECT next_delivery_at, webhook_secret FROM alerts WHERE id=$1", [alert.id]);
  assert.ok(row.next_delivery_at > Date.now());
  assert.equal(row.webhook_secret, "keepme");

  // Explicit empties clear.
  r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { delivery: "immediate", webhook_url: "", webhook_secret: "" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.alert.webhook_url, null);
  assert.equal(r.json.alert.has_secret, false);
  const { rows: [row2] } = await db.query("SELECT next_delivery_at, webhook_url, webhook_secret FROM alerts WHERE id=$1", [alert.id]);
  assert.equal(row2.next_delivery_at, null);
  assert.equal(row2.webhook_url, null);
  assert.equal(row2.webhook_secret, null);
});

test("an unrelated edit leaves the daily stamp alone — an overdue digest isn't skipped", async () => {
  const alert = await makeAlert({ name: "steady-digest", condition: { kind: ["a"] }, delivery: "daily", daily_at: "09:00", webhook_url: hookUrl });
  // The digest is overdue — the worker was down over the due minute.
  const overdue = Date.now() - 60000;
  await db.query("UPDATE alerts SET next_delivery_at=$2 WHERE id=$1", [alert.id, overdue]);

  // Rename + webhook tweak: the schedule didn't change, so the stamp must
  // not move — recomputing from "now" would push today's digest to tomorrow.
  const r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { name: "steady digest", webhook_url: hookUrl + "?v2" } });
  assert.equal(r.status, 200, r.text);
  let { rows: [row] } = await db.query("SELECT next_delivery_at FROM alerts WHERE id=$1", [alert.id]);
  assert.equal(row.next_delivery_at, overdue);

  // Pause/resume is schedule-neutral too — the overdue digest stays the
  // sweep's to resolve on resume, like a dormancy thaw.
  await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { enabled: false } });
  await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { enabled: true } });
  ({ rows: [row] } = await db.query("SELECT next_delivery_at FROM alerts WHERE id=$1", [alert.id]));
  assert.equal(row.next_delivery_at, overdue);

  // Changing the time IS a schedule change: re-arm to its next occurrence.
  const r2 = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { daily_at: "23:58" } });
  assert.equal(r2.status, 200, r2.text);
  ({ rows: [row] } = await db.query("SELECT next_delivery_at FROM alerts WHERE id=$1", [alert.id]));
  assert.ok(row.next_delivery_at > Date.now());
});

test("switching delivery away from daily and back remembers the digest time", async () => {
  const alert = await makeAlert({ name: "remembers", condition: { kind: ["a"] }, delivery: "daily", daily_at: "07:45" });

  // The modal omits daily_at on non-daily saves — absent means keep (the
  // secret pattern), so the time is remembered while nothing is scheduled.
  let r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { delivery: "immediate" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.alert.daily_at, "07:45");
  let { rows: [row] } = await db.query("SELECT daily_at_min, next_delivery_at FROM alerts WHERE id=$1", [alert.id]);
  assert.equal(row.daily_at_min, 7 * 60 + 45);
  assert.equal(row.next_delivery_at, null);

  // Back to daily with no time sent: the remembered HH:MM re-arms.
  r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { delivery: "daily" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.alert.daily_at, "07:45");
  ({ rows: [row] } = await db.query("SELECT next_delivery_at FROM alerts WHERE id=$1", [alert.id]));
  assert.ok(row.next_delivery_at > Date.now());
});

test("narrowing a condition drops the no-longer-matching pending backlog", async () => {
  const alert = await makeAlert({ name: "narrowed", condition: { kind: ["a"] }, webhook_url: hookUrl });
  const { id: entityId, instanceId } = await taggedEntity(["kind/a"]);
  assert.equal((await matchesOf(alert.id)).length, 1);

  // Narrow to kind/b before the settle window delivers: the pending kind/a
  // match is stale under the new reading and must not fire.
  const r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { condition: { kind: ["b"] } } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await matchesOf(alert.id)).length, 0);
  // Deleted, not demoted — the freed key is the point (the test below).
  assert.ok(!(await baselineOf(alert.id)).some((m) => m.entity_id === entityId));

  hookState.requests.length = 0;
  await backdate(alert.id, 120000);
  await deliverDueAlerts(db);
  assert.equal((await firingsOf(alert.id)).length, 0);
  assert.equal(hookState.requests.length, 0);

  // The entity is still honest news when it ENTERS the narrowed set.
  await req(base, "PATCH", `/api/instances/${instanceId}/tags`, { sid: admin.sid, body: { tags: ["kind/a", "kind/b"] } });
  const rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, entityId);
});

test("a condition edit releases stale baseline claims — entering the new set later is news", async () => {
  // Already-matching at create: claimed as baseline under kind/a.
  const { id: entityId, instanceId } = await taggedEntity(["kind/a"]);
  const alert = await makeAlert({ name: "released", condition: { kind: ["a"] } });
  assert.ok((await baselineOf(alert.id)).some((m) => m.entity_id === entityId));

  // Rewatch color/red: the kind/a claim is stale — left in place it would
  // squat on the (alert, entity) key and swallow the entity's real entry.
  const r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { condition: { color: ["red"] } } });
  assert.equal(r.status, 200, r.text);
  assert.ok(!(await baselineOf(alert.id)).some((m) => m.entity_id === entityId));

  // The entity genuinely enters the watched set — announced, not swallowed.
  await req(base, "PATCH", `/api/instances/${instanceId}/tags`, { sid: admin.sid, body: { tags: ["kind/a", "color/red"] } });
  const rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, entityId);
});

test("migration 0024 heals a pre-baseline alert by seeding today's matching set", async () => {
  const alert = await makeAlert({ name: "pre-fix", condition: { kind: ["a"], color: ["blue"] } });
  // Simulate an alert born before the fix: strip the baseline the route seeded.
  await db.query("DELETE FROM alert_matches WHERE alert_id=$1", [alert.id]);
  const sql = readFileSync(new URL("../server/migrations/0024_alert_baseline.sql", import.meta.url), "utf8");
  await db.query(sql);

  // The kind/a+color/blue backlog from earlier tests comes back as baseline —
  // claimed, invisible to the sweep.
  const seeded = await baselineOf(alert.id);
  assert.ok(seeded.length >= 2, `expected the existing backlog seeded, got ${seeded.length}`);
  assert.equal((await matchesOf(alert.id)).length, 0);

  // And it absorbs a retag re-landing exactly like a route-seeded baseline.
  const { rows: [item] } = await db.query("SELECT id FROM items WHERE entity_id=$1 LIMIT 1", [seeded[0].entity_id]);
  await req(base, "PATCH", `/api/instances/${item.id}/tags`, { sid: admin.sid, body: { tags: ["kind/a", "color/blue"] } });
  assert.equal((await matchesOf(alert.id)).length, 0);
});
