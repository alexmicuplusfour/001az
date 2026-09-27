// Alerts: the matcher, the tag-landing detection hook, the delivery sweep
// (settle window / daily stamp / record-only), webhook send + retry, and the
// per-user API. The worker loops don't run under test, so every sweep pass
// here is an explicit deliverDueAlerts() call — deterministic by design.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { startServer, adminSession, seedUser, seedItem, req, withLegacyEntityId } from "./helpers.js";
import { createBoard, createEntity, insertItem, setBoardMembers, setItemEntities, reconcileEntities } from "../server/db.js";
import {
  matchesCondition,
  sameCondition,
  nextDailyAt,
  encodeConditionF,
  evaluateItemAlerts,
  deliverDueAlerts,
  createDueFirings,
  deliverFiring,
  webhookBucket,
  buildFiringPayload,
} from "../server/alerts.js";
import { pendingWebhookFirings, crateItemIds } from "../server/db.js";
import { maxFor } from "../server/resource-pool.js";

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

test("matchesCondition: { any, not } entries — exclusion on the server, same rule", () => {
  const tags = new Set(["kind/a", "color/red"]);
  // Exclusion held → no match; clear → match; the any half still binds.
  assert.equal(matchesCondition(tags, { kind: { any: ["a"], not: ["b"] } }), true);
  assert.equal(matchesCondition(tags, { color: { any: [], not: ["red"] } }), false);
  assert.equal(matchesCondition(tags, { color: { any: [], not: ["blue"] } }), true);
  assert.equal(matchesCondition(tags, { kind: { any: ["b"], not: [] } }), false);
  // Unset passes a NOT — an entity with no color tag matches "not red".
  assert.equal(matchesCondition(new Set(["kind/a"]), { kind: ["a"], color: { any: [], not: ["red"] } }), true);
  // Corrupt entries still refuse: both halves empty, or junk.
  assert.equal(matchesCondition(tags, { kind: { any: [], not: [] } }), false);
  assert.equal(matchesCondition(tags, { kind: "a" }), false);
  assert.equal(matchesCondition(tags, { kind: [] }), false);
});

test("alert conditions: the { any, not } form survives the route's cleaning", async () => {
  const alert = await makeAlert({
    name: "clean shape",
    condition: { kind: { any: ["a"], not: ["b"] }, color: ["red"] },
  });
  assert.deepEqual(alert.condition, { kind: { any: ["a"], not: ["b"] }, color: ["red"] },
    "object entry kept, exclusion-free entry stays the legacy array");
  const junk = await req(base, "POST", "/api/alerts", {
    sid: admin.sid,
    body: { board_id: boardId, name: "junk", condition: { kind: { any: [], not: [] } } },
  });
  assert.equal(junk.status, 400, "a condition that cleans to nothing is refused");
  // Remove the object-form alert: the migration-0024 heal test below re-runs
  // that migration's SQL, whose matcher predates the { any, not } form (it
  // only ever ran on array-era data in the wild) — an anachronistic alert in
  // its path is a test artifact, not a product state.
  const del = await req(base, "DELETE", `/api/alerts/${alert.id}`, { sid: admin.sid });
  assert.equal(del.status, 200, del.text);
});

test("nextDailyAt: today when the time is ahead, tomorrow when it passed", () => {
  const noon = new Date(2026, 6, 25, 12, 0, 0, 0).getTime();
  const at9 = 9 * 60, at15 = 15 * 60;
  assert.equal(nextDailyAt(at15, noon), new Date(2026, 6, 25, 15, 0, 0, 0).getTime());
  assert.equal(nextDailyAt(at9, noon), new Date(2026, 6, 26, 9, 0, 0, 0).getTime());
});

test("sameCondition: both wire forms compare, and an array equals its { any } spelling", () => {
  // Regression: canonCondition once spread entries as arrays and threw on an
  // { any, not } entry — on the alert-edit path, deciding re-baselining.
  assert.equal(sameCondition({ kind: { any: ["a"], not: ["c"] } }, { kind: { any: ["a"], not: ["c"] } }), true);
  assert.equal(sameCondition({ kind: ["b", "a"] }, { kind: { any: ["a", "b"], not: [] } }), true);
  assert.equal(sameCondition({ kind: { any: ["a"], not: ["c"] } }, { kind: ["a"] }), false, "an exclusion is a different condition");
});

test("encodeConditionF: both halves, one per param — links reproduce exclusions", () => {
  const cond = { kind: { any: ["b", "a"], not: ["c"] }, color: ["red"] };
  assert.equal(encodeConditionF(cond), "color:red;kind:a,b", "the any half is the ?f= value");
  assert.equal(encodeConditionF(cond, "not"), "kind:c", "the not half is the ?fx= value");
  assert.equal(encodeConditionF({ color: ["red"] }, "not"), "", "no exclusions, no fx");
});

test("a firing payload's filter link carries fx when the condition excludes", () => {
  process.env.BASE_URL = "http://app.test";
  const target = { id: 7, alert_id: 1, name: "n", board_id: "b1", fired_at: 1, entity_count: 0,
    condition: { kind: { any: ["a"], not: ["c"] } } };
  const link = buildFiringPayload(target, []).links.filter;
  assert.ok(link.includes("f=" + encodeURIComponent("kind:a")), link);
  assert.ok(link.includes("fx=" + encodeURIComponent("kind:c")), link);
  const bare = buildFiringPayload({ ...target, condition: { kind: ["a"] } }, []).links.filter;
  assert.ok(!bare.includes("fx="), "no exclusions, no fx param");
  process.env.BASE_URL = "";
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

test("~objects conditions: detections are a third landing; baseline records pre-existing matches", async () => {
  const carFields = { car: { v: [{ label: "car", box: [0.1, 0.1, 0.5, 0.5], score: 0.9 }], why: "Detected: car" } };

  // An entity ALREADY carrying car boxes when the alert is born → baseline,
  // not a pending match (boardEntityTagUnions projects objects too).
  const preEntity = await createEntity(db, boardId, { identity: "pre-car" });
  await insertItem(db, boardId, { identity: "pre-car", files: [], fields: carFields }, "tagged", preEntity);
  const alert = await makeAlert({ name: "watch cars", condition: { "~objects": ["car"] } });
  assert.deepEqual((await baselineOf(alert.id)).map((r) => r.entity_id), [preEntity]);
  assert.equal((await matchesOf(alert.id)).length, 0);

  // A NEW entity's detection lands (what the extract stamp triggers) → a match.
  const freshEntity = await createEntity(db, boardId, { identity: "fresh-car" });
  const freshInst = await insertItem(db, boardId, { identity: "fresh-car", files: [], fields: carFields }, "tagged", freshEntity);
  await evaluateItemAlerts(db, freshInst);
  const rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, freshEntity);

  // An empty-v object field ("No objects detected") is NOT a detection.
  const noneEntity = await createEntity(db, boardId, { identity: "no-car" });
  const noneInst = await insertItem(db, boardId,
    { identity: "no-car", files: [], fields: { car: { v: [], why: "No objects detected" } } }, "tagged", noneEntity);
  await evaluateItemAlerts(db, noneInst);
  assert.equal((await matchesOf(alert.id)).length, 1);
});

test("~uploaders conditions match — the uploader projection rides every landing and the baseline", async () => {
  const uploader = await seedUser(db, "uploader-alerts@example.com");

  // An entity uploaded by them BEFORE the alert exists → baseline.
  const preEntity = await createEntity(db, boardId, { identity: "pre-upload", uploadedBy: uploader.id });
  await insertItem(db, boardId, { identity: "pre-upload", files: [], fields: {} }, "tagged", preEntity);
  const alert = await makeAlert({ name: "watch uploader", condition: { "~uploaders": [String(uploader.id)] } });
  assert.deepEqual((await baselineOf(alert.id)).map((r) => r.entity_id), [preEntity]);

  // A NEW upload by them: the first landing (tags here) sees the projection.
  const freshEntity = await createEntity(db, boardId, { identity: "fresh-upload", uploadedBy: uploader.id });
  const freshInst = await insertItem(db, boardId, { identity: "fresh-upload", files: [], fields: {} }, "tagged", freshEntity);
  await evaluateItemAlerts(db, freshInst);
  const rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, freshEntity);

  // Someone else's upload doesn't match.
  const otherEntity = await createEntity(db, boardId, { identity: "other-upload" });
  const otherInst = await insertItem(db, boardId, { identity: "other-upload", files: [], fields: {} }, "tagged", otherEntity);
  await evaluateItemAlerts(db, otherInst);
  assert.equal((await matchesOf(alert.id)).length, 1);
});

test("~uploaders alerts fire at the upload door — a held-at-birth upload reaches no other landing", async () => {
  // The shape with NO later landing: no facets (the tag leg would no-op), no
  // mapping (no extract leg), auto-tag off — admitted straight to held. Birth
  // is the only place the uploader fact can ever be seen.
  const heldBoard = await createBoard(db, "held-at-birth", [], "", true, null, null, { enabled: false });
  const uploader = await seedUser(db, "door-landing@example.com");
  await setBoardMembers(db, heldBoard, [uploader.id]);
  const r = await req(base, "POST", "/api/alerts", {
    sid: admin.sid,
    body: { board_id: heldBoard, name: "watch the door", condition: { "~uploaders": [String(uploader.id)] } },
  });
  assert.equal(r.status, 200, r.text);
  const alert = r.json.alert;

  const fd = new FormData();
  fd.append("files", new File(["hello from the door"], "note.txt", { type: "text/plain" }));
  const up = await fetch(`${base}/api/upload?board=${heldBoard}`, {
    method: "POST", headers: { Cookie: `sid=${uploader.sid}` }, body: fd,
  });
  assert.equal(up.status, 200);
  const body = await up.json();
  assert.equal(body.rejected.length, 0, JSON.stringify(body.rejected));
  const [u] = body.uploaded;
  assert.equal(u.status, "held", "precondition: no worker leg will ever run for this item");

  const rows = await matchesOf(alert.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_id, u.id);

  // Someone else through the same door stays silent.
  const fd2 = new FormData();
  fd2.append("files", new File(["not them"], "other.txt", { type: "text/plain" }));
  const up2 = await fetch(`${base}/api/upload?board=${heldBoard}`, {
    method: "POST", headers: { Cookie: `sid=${admin.sid}` }, body: fd2,
  });
  assert.equal(up2.status, 200);
  assert.equal((await matchesOf(alert.id)).length, 1);
});

test("a mixed tags+objects condition settles at whichever landing completes it", async () => {
  const alert = await makeAlert({ name: "red cars", condition: { color: ["red"], "~objects": ["car"] } });
  const entityId = await createEntity(db, boardId, { identity: "red-car" });
  const inst = await insertItem(db, boardId,
    { identity: "red-car", files: [], fields: { car: { v: [{ label: "car", box: [0, 0, 1, 1], score: 0.8 }], why: "" } } },
    "tagged", entityId);

  // Extract landing: boxes alone satisfy ~objects but not color — no match yet.
  await evaluateItemAlerts(db, inst);
  assert.equal((await matchesOf(alert.id)).length, 0);

  // The tag landing (the real PATCH route) completes the set — and its
  // evaluation sees the object projection, so the entity matches now.
  const r = await req(base, "PATCH", `/api/instances/${inst}/tags`, { sid: admin.sid, body: { tags: ["color/red"] } });
  assert.equal(r.status, 200, r.text);
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
  await setItemEntities(db, half2.instanceId, [target.id]);
  await reconcileEntities(db, [half2.id, target.id]);
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

test("a pending send freezes while the webhook is off or delivery is record-only, and thaws when it's back", async () => {
  const alert = await makeAlert({ name: "hook-off", condition: { kind: ["a"], color: ["blue"] }, webhook_url: hookUrl });
  await taggedEntity(["kind/a", "color/blue"]);
  await backdate(alert.id, 120000);

  hookState.status = 500;
  try {
    await deliverDueAlerts(db);
  } finally {
    hookState.status = 200;
  }
  let [f] = await firingsOf(alert.id);
  assert.equal(f.webhook_status, "pending");
  assert.equal(f.attempts, 1);

  // Neither state spends an attempt: no fetch at a null URL burning the
  // retries into "failed" for a hook the user turned off.
  const due = () => db.query("UPDATE alert_firings SET retry_at = NULL WHERE alert_id=$1", [alert.id]);
  for (const off of [{ webhook_url: "" }, { delivery: "record" }]) {
    await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: off });
    await due();
    await deliverDueAlerts(db);
    [f] = await firingsOf(alert.id);
    assert.equal(f.webhook_status, "pending", JSON.stringify(off));
    assert.equal(f.attempts, 1, JSON.stringify(off));
    await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { webhook_url: hookUrl, delivery: "immediate" } });
  }

  await due();
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
  const r = await req(base, "POST", "/api/alerts/test", { sid: admin.sid, body: { id: alert.id } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(hookState.requests.length, 1);
  const payload = JSON.parse(hookState.requests[0].body);
  assert.equal(payload.test, true);
  assert.equal(payload.firing_id, undefined); // a sample has no firing row
  assert.equal(payload.alert.name, "testfire");

  const bare = await makeAlert({ name: "no-hook", condition: { kind: ["a"] } });
  const r2 = await req(base, "POST", "/api/alerts/test", { sid: admin.sid, body: { id: bare.id } });
  assert.equal(r2.status, 400);
});

test("test-fire tries the editor's unsaved URL and secret, and saves neither", async () => {
  const alert = await makeAlert({ name: "try-first", condition: { kind: ["a"] }, webhook_secret: "stored" });
  const fire = (body) => req(base, "POST", "/api/alerts/test", { sid: admin.sid, body: { id: alert.id, ...body } });
  const signedWith = (secret, i) => {
    const { headers, body } = hookState.requests[i];
    return headers["x-alert-signature"] === "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  };
  hookState.requests.length = 0;

  // Secret omitted = the stored one, as a save reads it; typed signs instead;
  // "" sends unsigned.
  assert.equal((await fire({ webhook_url: hookUrl })).json.ok, true);
  assert.ok(signedWith("stored", 0));
  await fire({ webhook_url: hookUrl, webhook_secret: "typed" });
  assert.ok(signedWith("typed", 1));
  await fire({ webhook_url: hookUrl, webhook_secret: "" });
  assert.equal(hookState.requests[2].headers["x-alert-signature"], undefined);

  // The save's URL rule applies, before anything goes out.
  const sent = hookState.requests.length;
  assert.equal((await fire({ webhook_url: "ftp://nope" })).status, 400);
  assert.equal(hookState.requests.length, sent);

  // Nothing was stored: the secret left out still means the stored one, not
  // the one typed a moment ago, and the alert still has no URL.
  await fire({ webhook_url: hookUrl });
  assert.ok(signedWith("stored", 3));
  const list = await req(base, "GET", `/api/alerts?board=${boardId}`, { sid: admin.sid });
  const stored = list.json.find((a) => a.id === alert.id);
  assert.equal(stored.webhook_url, null);
  assert.equal(stored.has_secret, true);
});

test("a new alert test-fires from its board alone, and nothing is created", async () => {
  const count = async () => (await req(base, "GET", `/api/alerts?board=${boardId}`, { sid: admin.sid })).json.length;
  const before = await count();
  hookState.requests.length = 0;
  const r = await req(base, "POST", "/api/alerts/test", { sid: admin.sid, body: {
    board_id: boardId, name: "draft", condition: { kind: ["a"] }, webhook_url: hookUrl, webhook_secret: "fresh",
  } });
  assert.equal(r.json.ok, true);
  const { headers, body } = hookState.requests[0];
  assert.deepEqual(JSON.parse(body).alert, { id: null, name: "draft" });
  assert.equal(headers["x-alert-signature"], "sha256=" + crypto.createHmac("sha256", "fresh").update(body).digest("hex"));
  assert.equal(await count(), before);

  // A board it can't reach reads as not found — the create rule.
  const outsider = await seedUser(db, "test-fire-outsider@test.local");
  for (const [sid, board] of [[admin.sid, "nope"], [outsider.sid, boardId]]) {
    const t = await req(base, "POST", "/api/alerts/test", { sid, body: { board_id: board, webhook_url: hookUrl } });
    assert.equal(t.status, 404, board);
  }
  assert.equal(hookState.requests.length, 1);
});

test("a merged-away match delivers a link to the card that now holds the content", async () => {
  const alert = await makeAlert({ name: "merge-links", condition: { color: ["red"], kind: ["b"] }, webhook_url: hookUrl });
  // E matches and sits pending; T doesn't match on its own.
  const e = await taggedEntity(["color/red", "kind/b"]);
  const t = await taggedEntity(["kind/a"]);
  // The extract leg merges E's instance into T; emptied, E is deleted. The
  // match row keeps the recorded entity_id and frozen label.
  const { rows: [target] } = await db.query("SELECT id, identity, display_name FROM entities WHERE id=$1", [t.id]);
  await setItemEntities(db, e.instanceId, [target.id]);
  await reconcileEntities(db, [e.id, target.id]);
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
  for (const id of ["abc", "0", "1.5", "1e20"]) {
    for (const [method, path] of [
      ["PATCH", `/api/alerts/${id}`],
      ["DELETE", `/api/alerts/${id}`],
      ["GET", `/api/alerts/${id}/firings`],
      ["POST", `/api/alerts/${id}/seen`],
      ["GET", `/api/alert-firings/${id}`],
    ]) {
      const r = await req(base, method, path, { sid: admin.sid, body: method === "PATCH" ? {} : undefined });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
    // The test-fire takes its id in the body, by the same rule.
    const t = await req(base, "POST", "/api/alerts/test", { sid: admin.sid, body: { id, webhook_url: hookUrl } });
    assert.equal(t.status, 404, `test-fire id ${id}`);
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
  ]) {
    const r = await req(base, method, path, { sid: other.sid, body: method === "PATCH" ? {} : undefined });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  // The test-fire too: the stored secret signs for its owner only, or a
  // member could get the owner's signature on a URL of their own.
  hookState.requests.length = 0;
  const t = await req(base, "POST", "/api/alerts/test", { sid: other.sid, body: { id: alert.id, webhook_url: hookUrl } });
  assert.equal(t.status, 404);
  assert.equal(hookState.requests.length, 0);
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
  // The flag `.al-new` bolds on, in both directions — the list is READ before
  // the acknowledgement and must still say so. Untested until now, and the one
  // failure here is silent: a list that stopped carrying `seen` would simply
  // never bold a row, which looks exactly like a reader who is up to date.
  assert.equal(firings.json.firings[0].seen, false);

  await req(base, "POST", `/api/alerts/${alert.id}/seen`, { sid: admin.sid });
  const after = await req(base, "GET", `/api/alerts?board=${boardId}`, { sid: admin.sid });
  assert.equal(after.json.find((a) => a.id === alert.id).unseen, 0);
  const reread = await req(base, "GET", `/api/alerts/${alert.id}/firings`, { sid: admin.sid });
  assert.equal(reread.json.firings[0].seen, true, "…and the acknowledgement is what flips it");

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
  await withLegacyEntityId(db, () => db.query(sql));

  // The kind/a+color/blue backlog from earlier tests comes back as baseline —
  // claimed, invisible to the sweep.
  const seeded = await baselineOf(alert.id);
  assert.ok(seeded.length >= 2, `expected the existing backlog seeded, got ${seeded.length}`);
  assert.equal((await matchesOf(alert.id)).length, 0);

  // And it absorbs a retag re-landing exactly like a route-seeded baseline.
  const { rows: [item] } = await db.query("SELECT id FROM items WHERE entity_ids @> ARRAY[$1]::bigint[] LIMIT 1", [seeded[0].entity_id]);
  await req(base, "PATCH", `/api/instances/${item.id}/tags`, { sid: admin.sid, body: { tags: ["kind/a", "color/blue"] } });
  assert.equal((await matchesOf(alert.id)).length, 0);
});

// ── delivery as a resource (queue-by-resource-plan.md Stage 4a) ──────────────
// Sending was one sequential loop over every pending firing, so an alert to a
// slow endpoint delayed every alert to every OTHER endpoint. Delivery is a kind
// on the resource loop now, keyed by the receiving host.

test("webhookBucket names the receiving host — two endpoints on one host are one resource", () => {
  assert.equal(webhookBucket("https://hooks.example.com/services/abc"), "webhook:hooks.example.com");
  assert.equal(
    webhookBucket("https://hooks.example.com/services/abc"),
    webhookBucket("https://hooks.example.com/a/completely/different/path"),
    "same host, same patience — the path is not a second endpoint");
  assert.notEqual(
    webhookBucket("https://hooks.example.com/x"),
    webhookBucket("https://hooks.other.com/x"),
    "two hosts are two resources, which is the whole point of the stage");
  assert.equal(webhookBucket("port 25"), null, "an unparseable URL contends for nothing");
  // Small, and not for our sake: the endpoint belongs to somebody else.
  assert.equal(maxFor("webhook:hooks.example.com"), 2);
});

test("a delivery already in flight is not handed out again — the at-least-once window", async () => {
  // Send-then-stamp means the row stays `pending` for the whole send. The old
  // sweep re-read it safely because only one send ever existed; a loop that
  // launches without awaiting would post it twice, and this exclusion is the
  // only thing between those two facts.
  const alert = await makeAlert({ name: "in-flight", condition: { color: ["blue"] }, webhook_url: hookUrl });
  await taggedEntity(["color/blue"]);
  await backdate(alert.id, 120000);
  await createDueFirings(db);
  const [firing] = await firingsOf(alert.id);
  assert.equal(firing.webhook_status, "pending", "created, owed a webhook, not yet sent");

  const now = Date.now();
  const due = await pendingWebhookFirings(db, now, 10);
  assert.deepEqual(due.map((f) => Number(f.id)), [Number(firing.id)],
    "due while it is still pending — that is what makes at-least-once work");
  assert.deepEqual(
    await pendingWebhookFirings(db, now, 10, [firing.id]),
    [],
    "and withheld while this process is already sending it");

  // Deliver it for real so the row settles and the file's later reads are clean.
  // The JOINed row is what carries the URL and the secret, which is why the kind
  // hands `run` exactly what `due` returned rather than re-reading the firing.
  await deliverFiring(db, due[0]);
  assert.equal((await firingsOf(alert.id))[0].webhook_status, "ok");
});

// --- crating (planning/alert-crating-plan.md, Stage 3) ---
//
// An alert with a crate puts each NEW match into it, the moment detection
// records the match. Everything here goes through the routes a person uses,
// except where a failure has to be forced: those use a test-only trigger,
// dropped again in a finally.

// A crate through the route a person uses; the admin's on the alerts board
// unless told otherwise.
async function makeCrate(name, { sid = admin.sid, board = boardId } = {}) {
  const r = await req(base, "POST", "/api/crates", { sid, body: { name, board_id: board } });
  assert.equal(r.status, 200, r.text);
  return r.json.crate.id;
}
const crateCards = async (crateId) => [...(await crateItemIds(db, crateId))].sort((x, y) => x - y);
const listedCrate = async (alertId) =>
  (await req(base, "GET", `/api/alerts?board=${boardId}`, { sid: admin.sid })).json.find((a) => a.id === alertId).crate_id;

test("crating: a new match goes into the alert's crate at once, from a Record only alert too", async () => {
  const crate = await makeCrate("record picks");
  const alert = await makeAlert({ name: "crates, records", condition: { kind: ["a"] }, delivery: "record", crate_id: crate });
  assert.equal(alert.crate_id, crate, "create answers with the crate");
  const card = await taggedEntity(["kind/a"]);
  assert.deepEqual(await crateCards(crate), [card.id], "in the crate");
  assert.equal((await firingsOf(alert.id)).length, 0, "with no delivery run: the crate doesn't wait for one");
});

test("crating: a card that already matched when the alert was made never goes in, even re-tagged", async () => {
  const old = await taggedEntity(["color/red"]);
  const crate = await makeCrate("new ones only");
  await makeAlert({ name: "only new", condition: { color: ["red"] }, crate_id: crate });
  // A re-tag re-lands the old card's tags, which is what a board retag does.
  await req(base, "PATCH", `/api/instances/${old.instanceId}/tags`, { sid: admin.sid, body: { tags: ["color/red", "kind/a"] } });
  const fresh = await taggedEntity(["color/red"]);
  assert.deepEqual(await crateCards(crate), [fresh.id], "the new card, not the old one");
});

test("crating: a switched-off alert doesn't fill its crate", async () => {
  const crate = await makeCrate("paused");
  const alert = await makeAlert({ name: "paused crating", condition: { kind: ["a"] }, crate_id: crate });
  const r = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { enabled: false } });
  assert.equal(r.status, 200);
  await taggedEntity(["kind/a"]);
  assert.deepEqual(await crateCards(crate), []);
});

test("crating: an alert whose owner left the board doesn't fill its crate, and does again once they're back", async () => {
  const owner = await seedUser(db, "crater@test.local");
  await setBoardMembers(db, boardId, [owner.id]);
  try {
    const crate = await makeCrate("left behind", { sid: owner.sid });
    const r = await req(base, "POST", "/api/alerts", {
      sid: owner.sid,
      body: { board_id: boardId, name: "leaver", condition: { kind: ["a"] }, crate_id: crate },
    });
    assert.equal(r.status, 200, r.text);

    await setBoardMembers(db, boardId, []);
    await taggedEntity(["kind/a"]);
    assert.deepEqual(await crateCards(crate), [], "nothing while they're off the board");

    await setBoardMembers(db, boardId, [owner.id]);
    const back = await taggedEntity(["kind/a"]);
    assert.deepEqual(await crateCards(crate), [back.id], "the next new match once they're back");
  } finally {
    await setBoardMembers(db, boardId, []);
  }
});

test("crating: the save refuses another person's crate, another board's, and a crate id that isn't one", async () => {
  const other = await seedUser(db, "not-mine@test.local");
  await setBoardMembers(db, boardId, [other.id]);
  const theirs = await makeCrate("theirs", { sid: other.sid });
  await setBoardMembers(db, boardId, []);
  const elsewhere = await makeCrate("elsewhere", {
    board: await createBoard(db, "Elsewhere board", FACETS, "", true, null, null, { enabled: true }),
  });
  const alert = await makeAlert({ name: "refusals", condition: { kind: ["a"] } });

  for (const crate_id of [theirs, elsewhere, 999999, "5", 1.5, -1, 0, 2 ** 53]) {
    const created = await req(base, "POST", "/api/alerts", {
      sid: admin.sid,
      body: { board_id: boardId, name: `refused ${crate_id}`, condition: { kind: ["a"] }, crate_id },
    });
    assert.equal(created.status, 400, `create with ${crate_id}`);
    assert.equal(created.json.error, "crate not found");
    const edited = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { crate_id } });
    assert.equal(edited.status, 400, `edit with ${crate_id}`);
    assert.equal(edited.json.error, "crate not found");
  }
  assert.equal(await listedCrate(alert.id), null, "no edit landed");
});

test("crating: create, edit and the list carry crate_id; left out keeps it, null clears it", async () => {
  const crate = await makeCrate("round trip");
  const alert = await makeAlert({ name: "round trip", condition: { kind: ["b"] }, crate_id: crate });
  assert.equal(alert.crate_id, crate);
  assert.equal(await listedCrate(alert.id), crate, "the list carries it");

  const renamed = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { name: "round trip, renamed" } });
  assert.equal(renamed.json.alert.crate_id, crate, "an edit that leaves it out keeps it");
  assert.equal(await listedCrate(alert.id), crate);

  const cleared = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { crate_id: null } });
  assert.equal(cleared.json.alert.crate_id, null, "null clears it");
  assert.equal(await listedCrate(alert.id), null);

  const set = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { crate_id: crate } });
  assert.equal(set.json.alert.crate_id, crate, "an id sets it");
  assert.equal(await listedCrate(alert.id), crate);
});

test("crating: a crate deleted between the save's check and its write reads as \"crate not found\"", async () => {
  // Forced: a trigger deletes the crate as the alert row is written, after
  // the route has checked it, so the database's link refuses the row. The
  // failed statement takes the delete back with it, so the crate is there
  // again for the edit.
  const crate = await makeCrate("vanishing");
  const alert = await makeAlert({ name: "race", condition: { kind: ["b"] } });
  await db.query(`CREATE FUNCTION vanish_crate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN DELETE FROM crates WHERE id = NEW.crate_id; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER vanish BEFORE INSERT OR UPDATE ON alerts
    FOR EACH ROW WHEN (NEW.crate_id IS NOT NULL) EXECUTE FUNCTION vanish_crate()`);
  try {
    const created = await req(base, "POST", "/api/alerts", {
      sid: admin.sid,
      body: { board_id: boardId, name: "race, created", condition: { kind: ["b"] }, crate_id: crate },
    });
    assert.equal(created.status, 400, created.text);
    assert.equal(created.json.error, "crate not found");
    const edited = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { crate_id: crate } });
    assert.equal(edited.status, 400, edited.text);
    assert.equal(edited.json.error, "crate not found");
  } finally {
    await db.query("DROP TRIGGER vanish ON alerts");
    await db.query("DROP FUNCTION vanish_crate()");
  }
  assert.equal(await listedCrate(alert.id), null, "the edit didn't land");
});

test("crating: any other failure writing the alert is still a server error, not \"crate not found\"", async () => {
  // crateGone answers for the crate link only. Forced with a test-only
  // trigger that refuses every alert row.
  const alert = await makeAlert({ name: "breaks", condition: { kind: ["b"] } });
  await db.query(`CREATE FUNCTION refuse_alert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'refused by the test'; END $$`);
  await db.query(`CREATE TRIGGER refuse BEFORE INSERT OR UPDATE ON alerts
    FOR EACH ROW EXECUTE FUNCTION refuse_alert()`);
  try {
    const created = await req(base, "POST", "/api/alerts", {
      sid: admin.sid,
      body: { board_id: boardId, name: "breaks, created", condition: { kind: ["b"] } },
    });
    assert.equal(created.status, 500, created.text);
    assert.equal(created.json.error, "server error");
    const edited = await req(base, "PATCH", `/api/alerts/${alert.id}`, { sid: admin.sid, body: { name: "breaks, edited" } });
    assert.equal(edited.status, 500, edited.text);
    assert.equal(edited.json.error, "server error");
  } finally {
    await db.query("DROP TRIGGER refuse ON alerts");
    await db.query("DROP FUNCTION refuse_alert()");
  }
});

test("crating: deleting the crate turns the alert's crating off, and the alert keeps watching", async () => {
  const crate = await makeCrate("doomed");
  const alert = await makeAlert({ name: "outlives its crate", condition: { kind: ["a"] }, crate_id: crate });
  const del = await req(base, "DELETE", `/api/crates/${crate}`, { sid: admin.sid });
  assert.equal(del.status, 200);
  assert.equal(await listedCrate(alert.id), null, "crating is off");
  const before = (await matchesOf(alert.id)).length;
  await taggedEntity(["kind/a"]);
  assert.equal((await matchesOf(alert.id)).length, before + 1, "and it still records matches");
});

test("crating: a crate write that fails doesn't stop the rest of the matching", async () => {
  // One file on two cards ("Match to a list"), and a test-only trigger that
  // refuses the first card's crate place. The second card must still get its
  // match and its place. Two cards rather than two alerts: a file's cards come
  // in a fixed order, and the order alerts are checked in isn't.
  const crate = await makeCrate("half refused");
  const alert = await makeAlert({ name: "refused once", condition: { kind: ["a"], color: ["blue"] }, crate_id: crate });
  const first = await createEntity(db, boardId, { identity: "two-cards-first" });
  const second = await createEntity(db, boardId, { identity: "two-cards-second" });
  const inst = await insertItem(db, boardId, { identity: "two-cards", files: [], fields: {} }, "tagged", first);
  await setItemEntities(db, inst, [first, second]);
  await db.query(`UPDATE items SET tags='["kind/a", "color/blue"]'::jsonb WHERE id=$1`, [inst]);
  await db.query(`CREATE FUNCTION refuse_card() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'refused by the test'; END $$`);
  await db.query(`CREATE TRIGGER refuse BEFORE INSERT ON crate_items
    FOR EACH ROW WHEN (NEW.item_id = ${Number(first)}) EXECUTE FUNCTION refuse_card()`);
  try {
    await evaluateItemAlerts(db, inst);
  } finally {
    await db.query("DROP TRIGGER refuse ON crate_items");
    await db.query("DROP FUNCTION refuse_card()");
  }
  assert.deepEqual((await matchesOf(alert.id)).map((m) => m.entity_id), [first, second], "both matches recorded");
  assert.deepEqual(await crateCards(crate), [second], "the second card went in");
});

test("crating: a card taken out of the crate isn't put back by a re-tag", async () => {
  const crate = await makeCrate("taken out");
  await makeAlert({ name: "stays out", condition: { kind: ["a"] }, crate_id: crate });
  const card = await taggedEntity(["kind/a"]);
  assert.deepEqual(await crateCards(crate), [card.id], "setup: the alert put it in");
  const out = await req(base, "POST", `/api/crates/${crate}/items/${card.id}`, { sid: admin.sid }); // the checkbox
  assert.equal(out.json.added, false, "setup: taken out");
  await req(base, "PATCH", `/api/instances/${card.instanceId}/tags`, { sid: admin.sid, body: { tags: ["kind/a", "color/red"] } });
  assert.deepEqual(await crateCards(crate), [], "the re-tag left it out");
});
