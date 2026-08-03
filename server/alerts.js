// Alerts: watched facet conditions (planning/alerts-plan.md). This module owns
// the matcher — the server mirror of filters.js matchesExcept — the
// tag-landing evaluation hook, and the delivery sweep the worker's maintenance
// loop ticks. Detection is always immediate (a match row the moment an entity
// enters the set); delivery — webhook now, daily digest, or record-only — is
// just a consumer of those rows. SQL lives in db.js like everything else.
import crypto from "node:crypto";
import {
  boardAlerts,
  entityForAlerts,
  getItemEntity,
  addAlertMatch,
  boardEntityTagUnions,
  addAlertBaselineMatches,
  pruneAlertStaleClaims,
  alertsWithPendingMatches,
  dueDailyAlerts,
  setAlertNextDelivery,
  createAlertFiring,
  pendingWebhookFirings,
  stampFiringWebhook,
  firingMatches,
} from "./db.js";

// The settle window: a bulk ingest tags its items over minutes, and there is
// no run id to hook — so "the job ended" is read as "no new match for a
// while", capped so a steady trickle still delivers. What turns a 500-file
// drop into one notification instead of 500.
const SETTLE_MS = Number(process.env.ALERT_SETTLE_MS) || 60000;
const MAX_WAIT_MS = Number(process.env.ALERT_MAX_WAIT_MS) || 600000;
const WEBHOOK_TIMEOUT_MS = Number(process.env.ALERT_WEBHOOK_TIMEOUT_MS) || 10000;
const WEBHOOK_MAX_ATTEMPTS = 3; // then 'failed' with the error kept
// Spacing between attempts (retry_at). The sweep ticks every POLL_MS (~3s) —
// tick-paced retries would burn all three attempts in seconds, turning any
// endpoint blip longer than that (a restart, a deploy) into a permanent
// 'failed'. Immediate, +1 min, +5 min rides out ~6 minutes of outage.
const WEBHOOK_RETRY_BACKOFF_MS = [60000, 300000];
const PAYLOAD_ENTITY_CAP = 20;  // entity_count carries the real total

// The matchesExcept mirror (filters.js:17): OR within a facet's values, AND
// across facets, membership tested against "facet/value" tag strings. An
// empty condition matches nothing (the API refuses to store one anyway).
export function matchesCondition(tagSet, condition) {
  const keys = Object.keys(condition || {});
  if (!keys.length) return false;
  for (const key of keys) {
    const values = condition[key];
    if (!Array.isArray(values) || !values.length) return false;
    if (!values.some((v) => tagSet.has(`${key}/${v}`))) return false;
  }
  return true;
}

// The detection hook, called wherever condition-relevant data lands: the tag
// landings (worker processOne — real or facet-less — and the manual PATCH
// route), the extract stamp (object detections — the `~objects` system facet —
// land there, not at tagging), and upload admission (ingest.js admitFile: the
// `~uploaders` fact is final at birth, and a held-at-birth upload reaches no
// other landing). Re-reads the item's entity — an instance can be re-parented
// between claim and landing, and a stale entity_id would credit the wrong
// card. Evaluates the ENTITY's union set, not the instance's: entity-level
// membership is the union across instances (the listItems stance), so a
// condition can be satisfied only across instances and a single instance
// would under-match. Never throws — the ledger never breaks the job.
export async function evaluateItemAlerts(db, itemId) {
  try {
    const item = await getItemEntity(db, itemId);
    if (!item || !item.entity_ids?.length) return;
    const alerts = await boardAlerts(db, item.board_id);
    if (!alerts.length) return;
    // An instance can belong to several entities (classify mode) — every one is
    // a card the tags could credit, so evaluate each. Dedupe on (alert, entity)
    // is the once-only key, so this can't double-fire.
    for (const entityId of item.entity_ids) {
      const ent = await entityForAlerts(db, entityId);
      if (!ent) continue;
      for (const a of alerts) {
        if (!matchesCondition(ent.tagSet, a.condition)) continue;
        if (await addAlertMatch(db, a.id, entityId, itemId, ent.label)) {
          console.log(`alert #${a.id} matched entity #${entityId}${ent.label ? ` (${ent.label})` : ""}`);
        }
      }
    }
  } catch (err) {
    console.warn(`alert evaluation failed for item #${itemId}: ${err.message}`);
  }
}

// The birth certificate: record every entity that ALREADY matches as a
// claimed baseline row (ALERT_BASELINE_FIRING), so only entities entering
// the set after this moment read as news. Without it, detection-at-landing
// plus once-ever dedupe has a hole at birth — the next board retag
// (periodic auto-tag, admin retag, retag-on-refresh) re-lands every old
// entity's tags and fires the entire pre-existing matching set as one giant
// "N new items". Runs at create and on any condition change (widening
// re-covers old ground); idempotent — ON CONFLICT leaves real match rows
// alone, so re-seeding never demotes a recorded detection. A condition
// change also prunes the claims the old condition strands OUTSIDE the new
// matching set (pruneAlertStaleClaims): a narrowed alert must not deliver
// the old backlog, and a stale baseline must not swallow a real entry
// later. At create there is nothing to prune — the pass is a no-op.
export async function seedAlertBaseline(db, alertId, boardId, condition) {
  const t0 = Date.now(); // fences the prune: claims from before this pass only
  const unions = await boardEntityTagUnions(db, boardId);
  const ids = [];
  for (const [entityId, tagSet] of unions) {
    if (matchesCondition(tagSet, condition)) ids.push(entityId);
  }
  const pruned = await pruneAlertStaleClaims(db, alertId, ids, t0);
  if (pruned) console.log(`alert #${alertId} pruned ${pruned} stale claims outside the edited condition`);
  if (ids.length) {
    await addAlertBaselineMatches(db, alertId, ids);
    console.log(`alert #${alertId} baseline: ${ids.length} already-matching entities recorded`);
  }
  return ids.length;
}

// Canonical condition equality — JSONB reorders object keys and the client
// may reorder values, neither of which changes what matches. Decides whether
// an edit needs a fresh baseline pass.
const canonCondition = (c) =>
  JSON.stringify(Object.keys(c || {}).sort().map((k) => [k, [...c[k]].sort()]));
export function sameCondition(a, b) {
  return canonCondition(a) === canonCondition(b);
}

// Next "daily at HH:MM" stamp after `from` — the nextIngestRunAt daily case
// (server-local time, so TZ moves delivery too).
export function nextDailyAt(atMin, from = Date.now()) {
  const d = new Date(from);
  d.setHours(Math.floor(atMin / 60), atMin % 60, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// The condition as a shareable ?f= value — the encodeSelected mirror
// (filters.js:231), so webhook links land on the same filtered view the
// client would build itself.
export function encodeConditionF(condition) {
  return Object.keys(condition || {}).sort().map((key) =>
    encodeURIComponent(key) + ":" + [...condition[key]].sort().map(encodeURIComponent).join(",")
  ).join(";");
}

// The same absolute base invite links mint from (server.js BASE_URL) — one
// "where does this app live" knob, not two. Unset/blank → payloads carry
// ids and labels but no links.
const appUrl = () => String(process.env.BASE_URL || "").replace(/\/+$/, "");

// The webhook body. `target` is a pendingWebhookFirings row (alert fields
// flattened in); entities beyond the cap are counted, not listed — the cap is
// stated by entity_count, never silent.
export function buildFiringPayload(target, entities, { test = false } = {}) {
  const base = appUrl();
  const payload = {
    ...(test ? { test: true } : {}),
    // The dedupe key for idempotent receivers: delivery is at-least-once
    // (see the send loop), and firing_id + fired_at are stable across
    // resends. Absent only on test-fires, which have no firing row.
    ...(target.id != null ? { firing_id: target.id } : {}),
    alert: { id: target.alert_id, name: target.name },
    board: target.board_id,
    fired_at: target.fired_at,
    entity_count: target.entity_count,
    // id is the recorded fact; the url follows the content — live_entity_id
    // tracks a merge to the card that now holds it, and a hard-deleted match
    // keeps its frozen label but carries no link to hunt for.
    entities: entities.slice(0, PAYLOAD_ENTITY_CAP).map((e) => ({
      id: e.entity_id,
      label: e.label,
      ...(base && e.live_entity_id != null
        ? { url: `${base}/?board=${encodeURIComponent(target.board_id)}&item=${e.live_entity_id}` }
        : {}),
    })),
  };
  if (base) {
    payload.links = {
      ...(target.id != null ? { event: `${base}/?board=${encodeURIComponent(target.board_id)}&event=${target.id}` } : {}),
      filter: `${base}/?board=${encodeURIComponent(target.board_id)}&f=${encodeURIComponent(encodeConditionF(target.condition))}`,
    };
  }
  return payload;
}

// One POST, one verdict — never throws. The signature lets a receiver verify
// the sender without the URL itself being the only secret.
export async function sendAlertWebhook(target, entities, opts = {}) {
  const body = JSON.stringify(buildFiringPayload(target, entities, opts));
  const headers = { "Content-Type": "application/json", "User-Agent": "001az-alerts" };
  if (target.webhook_secret) {
    headers["X-Alert-Signature"] =
      "sha256=" + crypto.createHmac("sha256", target.webhook_secret).update(body).digest("hex");
  }
  try {
    const r = await fetch(target.webhook_url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// The delivery sweep, ticked by the worker's maintenance loop. Three passes:
// settle-window grouping (immediate + record — record groups identically so
// history and ?event= links stay uniform, it just never sends), stamp-driven
// daily grouping, then webhook send/retry for whatever is owed one.
export async function deliverDueAlerts(db, now = Date.now()) {
  for (const a of await alertsWithPendingMatches(db)) {
    if (a.newest > now - SETTLE_MS && a.oldest > now - MAX_WAIT_MS) continue;
    const withWebhook = a.delivery !== "record" && !!a.webhook_url;
    const firingId = await createAlertFiring(db, a.id, withWebhook);
    if (firingId != null) console.log(`alert #${a.id} fired (firing #${firingId}, ${a.pending} entities)`);
  }
  for (const a of await dueDailyAlerts(db, now)) {
    if (a.pending > 0) {
      const firingId = await createAlertFiring(db, a.id, !!a.webhook_url);
      if (firingId != null) console.log(`alert #${a.id} fired daily (firing #${firingId}, ${a.pending} entities)`);
    }
    // Re-arm even when nothing fired — an overdue stamp left in the past
    // would deliver the moment a match landed, at whatever time that is.
    await setAlertNextDelivery(db, a.id, nextDailyAt(a.daily_at_min, now));
  }
  // Send-then-stamp: a crash between the two resends this firing on the next
  // sweep — at-least-once, deliberately. Stamp-then-send would turn the same
  // crash into a silently LOST delivery, and for an alerting system a
  // repeated notification beats a missing one. Receivers that care dedupe on
  // payload.firing_id, which is stable across resends.
  for (const f of await pendingWebhookFirings(db, now)) {
    const { ok, error } = await sendAlertWebhook(f, await firingMatches(db, f.id));
    if (ok) {
      await stampFiringWebhook(db, f.id, "ok", null);
    } else {
      const final = f.attempts + 1 >= WEBHOOK_MAX_ATTEMPTS;
      const backoff = WEBHOOK_RETRY_BACKOFF_MS[Math.min(f.attempts, WEBHOOK_RETRY_BACKOFF_MS.length - 1)];
      await stampFiringWebhook(db, f.id, final ? "failed" : "pending", error, final ? null : now + backoff);
      console.warn(`alert webhook ${final ? "failed" : `retrying in ${Math.round(backoff / 1000)}s`} (firing #${f.id}, attempt ${f.attempts + 1}): ${error}`);
    }
  }
}
