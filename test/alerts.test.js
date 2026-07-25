// Alerts: the matcher, the tag-landing detection hook, the delivery sweep
// (settle window / daily stamp / record-only), webhook send + retry, and the
// per-user API. The worker loops don't run under test, so every sweep pass
// here is an explicit deliverDueAlerts() call — deterministic by design.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { startServer, adminSession, seedUser, seedItem, req } from "./helpers.js";
import { createBoard, createEntity, insertItem, setBoardMembers } from "../server/db.js";
import {
  matchesCondition,
  nextDailyAt,
  encodeConditionF,
  evaluateItemAlerts,
  deliverDueAlerts,
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

const matchesOf = async (alertId) =>
  (await db.query("SELECT * FROM alert_matches WHERE alert_id=$1 ORDER BY entity_id", [alertId])).rows;
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
  // Oldest past MAX_WAIT, newest just now: the trickle still delivers.
  await db.query(
    `UPDATE alert_matches SET matched_at = matched_at - 700000
     WHERE alert_id=$1 AND entity_id = (SELECT MIN(entity_id) FROM alert_matches WHERE alert_id=$1)`,
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

test("a failing webhook retries once per sweep and lands on 'failed' with the error kept", async () => {
  const alert = await makeAlert({ name: "failing", condition: { kind: ["a"], color: ["red"] }, webhook_url: hookUrl });
  await taggedEntity(["kind/a", "color/red"]);
  await backdate(alert.id, 120000);

  hookState.status = 500;
  try {
    await deliverDueAlerts(db);
    let [f] = await firingsOf(alert.id);
    assert.equal(f.webhook_status, "pending");
    assert.equal(f.attempts, 1);
    assert.equal(f.webhook_error, "HTTP 500");

    await deliverDueAlerts(db);
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
  assert.equal(payload.alert.name, "testfire");

  const bare = await makeAlert({ name: "no-hook", condition: { kind: ["a"] } });
  const r2 = await req(base, "POST", `/api/alerts/${bare.id}/test`, { sid: admin.sid });
  assert.equal(r2.status, 400);
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
  assert.equal(firings.json.length, 1);
  const firingId = firings.json[0].id;

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
