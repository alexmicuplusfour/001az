import { state } from './state.js';
import { toItem, toInstance } from './utils.js';

// Batches of uploaded items we're waiting to see fully tagged.
const pendingBatches = []; // [{ ids: Set<id>, n: number }]

document.addEventListener('app:uploads-pending-tag', (e) => {
  pendingBatches.push(e.detail);
});

export function hasPendingUploadTags() {
  return pendingBatches.length > 0;
}

export function pendingUploadTagCount() {
  let n = 0;
  for (const b of pendingBatches) n += b.ids.size;
  return n;
}

// Drop a deleted item from upload-tag batches so the processing toast
// doesn't dismiss early or stall forever on a missing row.
export function dropPendingUploadId(id) {
  for (let i = pendingBatches.length - 1; i >= 0; i--) {
    const batch = pendingBatches[i];
    if (!batch.ids.delete(id)) continue;
    batch.n = batch.ids.size;
    if (batch.ids.size === 0) pendingBatches.splice(i, 1);
  }
  document.dispatchEvent(new Event('app:uploads-pending-changed'));
}

// The in-flight queue split by aliveness: ACTIVE items are being worked right
// now, QUEUED ones are waiting in line. The status filter pills mirror this.
export const ACTIVE = new Set(["processing", "extracting", "facing"]);
export const QUEUED = new Set(["pending", "pending_extract", "pending_face"]);
const IN_FLIGHT = new Set([...ACTIVE, ...QUEUED]);

function needsPoll() {
  return (
    state.uploading.length > 0 ||
    state.items.some((img) => IN_FLIGHT.has(img.status))
  );
}

// First-time tags (no tags yet) show at the top; retags stay in the grid.
// Ordered by aliveness — upload placeholders, then actively-worked items,
// then the waiting queue — so the grid's budgeted lane shows real work first.
export function inProgress() {
  const mine = state.items.filter((img) => IN_FLIGHT.has(img.status) && !img.tags.length);
  return [
    ...state.uploading,
    ...mine.filter((img) => ACTIVE.has(img.status)),
    ...mine.filter((img) => QUEUED.has(img.status)),
  ];
}

// `presentIds` is every entity id currently on the server — used to tell
// "absent because unchanged" apart from "absent because merged/deleted". A
// full-list response IS that set (the default); delta responses carry only
// changed items, so they pass the server's ids list explicitly.
export function reconcile(data, presentIds = null) {
  const freshIds = presentIds || new Set(data.map((d) => d.id));
  const byId = new Map(state.items.map((i) => [i.id, i]));

  for (const d of data) {
    const ex = byId.get(d.id);
    if (ex) {
      const list = Array.isArray(d.tags) ? d.tags : [];
      ex.status = d.status;
      // Server clears tags while re-queuing; keep stale tags until a result lands.
      if (d.status === "tagged" || d.status === "failed" || list.length) {
        ex.tags = list;
        ex.tagSet = new Set(list);
      }
      ex.undecided = !!d.undecided;
      ex.hearts = d.hearts || 0;
      ex.favoritedByMe = !!d.favoritedByMe;
      ex.crateIds = new Set(Array.isArray(d.crateIds) ? d.crateIds : []);
      // Instances change under merges/splits/removals — take the server list
      // wholesale (the lightbox re-resolves its selection by instance id).
      if (Array.isArray(d.instances)) {
        ex.instances = d.instances.map(toInstance);
        ex.fields = d.fields || {};
      }
      ex.identityProvisional = !!d.identity_provisional;
      // Pick up derived identity and display name once extraction resolves them.
      if ((d.identity && d.identity !== ex.identity) || (d.display_name || null) !== ex.display_name || d.name !== ex.name) {
        ex.name = d.name;
        ex.identity = d.identity;
        ex.display_name = d.display_name || null;
        ex.displayLabel = d.display_name || (d.identity !== d.name ? d.identity : (d.label || d.name));
        ex.kind = d.kind || ex.kind;
      }
      // Fresh uploads are created client-side without dimensions; pick them
      // up here so their cards get the computed-height layout path. A merge
      // can also swap the face file — follow the server's dimensions.
      if (d.w && (!ex.w || ex.w !== d.w || ex.h !== d.h)) { ex.w = d.w; ex.h = d.h || 0; }
    } else {
      state.items.unshift(toItem(d));
    }
  }

  // Remove in-flight items that disappeared from the server list — they were
  // merged into another entity (or deleted externally). Notify so the toast
  // can update.
  let mergedCount = 0;
  for (let i = pendingBatches.length - 1; i >= 0; i--) {
    const { ids } = pendingBatches[i];
    for (const id of [...ids]) {
      if (!freshIds.has(id)) {
        ids.delete(id);
        mergedCount++;
      }
    }
    if (ids.size === 0) pendingBatches.splice(i, 1);
  }
  if (mergedCount > 0) {
    state.items = state.items.filter((img) => freshIds.has(img.id) || !IN_FLIGHT.has(img.status));
    document.dispatchEvent(new CustomEvent('app:item-merged', { detail: { count: mergedCount } }));
    document.dispatchEvent(new Event('app:uploads-pending-changed'));
  }

  // Check if any upload batch has finished processing. 'held' is terminal
  // too: on an auto-tag-off board the definition legs (extract/face) run and
  // then park the item in held — that upload is done, tagging waits by design.
  for (let i = pendingBatches.length - 1; i >= 0; i--) {
    const { ids, n } = pendingBatches[i];
    const allDone = [...ids].every((id) => {
      const img = state.items.find((m) => m.id === id);
      return img && (img.status === 'tagged' || img.status === 'failed' || img.status === 'held');
    });
    if (allDone) {
      pendingBatches.splice(i, 1);
      document.dispatchEvent(new CustomEvent('app:uploads-tagged', { detail: { n } }));
      document.dispatchEvent(new Event('app:uploads-pending-changed'));
    }
  }
}

// Tokens only accrue while items are being tagged — exactly when we're already
// polling — so we refresh the board's running total on the same cadence and let
// the toolbar's odometer roll to the new value.
async function refreshTokens() {
  if (!state.boardId) return;
  try {
    const r = await fetch(`/api/boards/${state.boardId}/tokens`, { cache: "no-store" });
    if (!r.ok) return;
    const { token_total } = await r.json();
    if (typeof token_total === 'number') state.boardTokens = token_total;
  } catch { /* leave the last known total */ }
}

// Alert firings happen server-side (the worker sweep), so unseen counts only
// move while arrivals do — exactly when we're already polling. Piggyback the
// tick, throttled: the counts drive an ambient dot, not a live feed. No
// zero-alert skip: this poll is also how a tab DISCOVERS alerts — a first
// alert created in another tab (or missed by a failed boot fetch) must still
// light the dot here, and what the skip saved was one owner-scoped SELECT
// every 30s.
let alertsFetchAt = 0;
async function refreshAlerts() {
  if (!state.boardId) return;
  // Under the tick cadence, not at it: a 30s throttle under the 30s slow poll
  // would alias — ticks landing a hair early skip, and "within 30s" doubles.
  if (Date.now() - alertsFetchAt < 25000) return;
  alertsFetchAt = Date.now();
  try {
    const r = await fetch(`/api/alerts?board=${state.boardId}`, { cache: "no-store" });
    if (r.ok) state.alerts = await r.json();
  } catch { /* keep the last known counts */ }
}

// A live board (connector fields or a live chart face) changes server-side on
// its own cadence: values refresh, and chart faces regenerate under NEW
// filenames — the old webp is deleted, since /gallery caches immutably. A tab
// that never polls keeps pointing at the dead filename and the lightbox 404s.
// So: in-flight work polls fast, a quiet live board polls slowly, anything
// else not at all.
function liveBoard() {
  const m = state.boardMapping;
  if (!m) return false;
  return (m.fields || []).some((f) => f.from === "connector" && f.live) ||
    (m.face?.from === "connector" && !!m.face.live);
}

// Exported for tests: the cadence decision in one place. Ingestion-enabled
// boards keep the slow poll too — the sweep admits items server-side, so a
// quiet tab would otherwise never see them arrive. Alerts hold it for the
// same reason: firings happen in the worker sweep (and off a teammate's
// manual tag), so a tab with alerts but no poll would never light the dot.
// A zero-alert tab still stops — refreshAlerts can only DISCOVER an alert
// created elsewhere while something else keeps the tick alive (or on boot).
export function pollDelay() {
  if (needsPoll()) return 4000;
  if (liveBoard() || state.boardIngest || state.alerts.length) return 30000;
  return 0;
}

let polling = false;
let pollTimer = null;

function schedule(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollTick, delay);
}

async function pollTick() {
  if (!pollDelay()) {
    polling = false;
    // The last item's tokens land just after its status flips to tagged, so
    // catch that final bump once the queue has drained.
    await refreshTokens();
    document.dispatchEvent(new Event('app:render'));
    return;
  }
  try {
    // Delta poll when we have a cursor: only entities changed since the last
    // tick, plus the board's full id list for merge/delete detection.
    const url = state.itemsSince != null
      ? `/api/items?board=${state.boardId}&since=${state.itemsSince}`
      : `/api/items?board=${state.boardId}`;
    const data = await fetch(url, { cache: "no-store" }).then((r) => r.json());
    if (Array.isArray(data)) {
      // Bare array = a server without delta support — full-list semantics.
      state.itemsSince = null;
      reconcile(data);
    } else if (Array.isArray(data.items) && Array.isArray(data.ids)) {
      reconcile(data.items, new Set(data.ids));
      if (typeof data.now === 'number') state.itemsSince = data.now;
    }
    // Any other shape (proxy error body, partial JSON): skip the tick rather
    // than feed reconcile an empty presentIds set — that reads as "everything
    // merged away" and would wrongly drop in-flight items.
    await refreshTokens();
    await refreshAlerts();
    document.dispatchEvent(new Event('app:render'));
  } catch {
    /* keep polling */
  }
  schedule(pollDelay()); // recomputed — the queue may have settled or refilled
}

export function ensurePolling() {
  const delay = pollDelay();
  if (!delay) return;
  if (!polling) {
    polling = true;
    schedule(4000);
  } else if (delay === 4000) {
    // Work just queued while on the slow live cadence — don't wait out the
    // long timer.
    schedule(4000);
  }
}

// The board payload's ingestion flags, stamped into state in exactly one
// place — the boot path, the ingest modal and the toolbar chip all funnel
// through here so they can't drift on what "refreshed" means.
export function stampBoardIngest(b) {
  state.boardIngest = !!b.ingest_enabled;
  state.boardIngestNextRun = b.ingest_next_run_at ?? null;
}

// Re-learn the flags after something changed them server-side (save, run-now,
// countdown expiry), then let the poll cadence and toolbar follow. Resolves
// true only when a fresh payload actually landed — callers back off on false.
export async function refreshBoardIngest() {
  try {
    const b = await fetch(`/api/boards/${state.boardId}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    if (!b) return false;
    stampBoardIngest(b);
    ensurePolling(); // the slow poll follows the flag
    document.dispatchEvent(new Event("app:render"));
    return true;
  } catch {
    return false;
  }
}

// Background-drain append: pages walk newest→oldest, so pushing each one at
// the END keeps state.items newest-first. A delta poll may already have
// unshifted one of these ids mid-drain — skip those.
function appendItems(rows) {
  const have = new Set(state.items.map((i) => i.id));
  for (const d of rows) {
    if (!have.has(d.id)) state.items.push(toItem(d));
  }
}

// After a paginated boot: fetch the rest of the board page by page, rendering
// as each lands. Board switches are full page navigations, so the only guards
// needed are against a duplicate kick-off and (belt-and-braces) a boardId
// swap mid-flight. A failed page gets one spaced retry, then the drain stops —
// a partial gallery beats an empty one, and a reload resumes cleanly.
let draining = false;
export async function drainItems(cursor) {
  if (!cursor || draining) return;
  draining = true;
  const board = state.boardId;
  let retried = false;
  try {
    while (cursor && state.boardId === board) {
      const page = await fetch(`/api/items?board=${board}&limit=500&after=${cursor}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!page || !Array.isArray(page.items)) {
        if (retried) break;
        retried = true;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      retried = false;
      appendItems(page.items);
      cursor = page.nextCursor;
      // A late page may hold the only in-flight items — needsPoll() scans
      // state.items, so re-arm after every append.
      ensurePolling();
      document.dispatchEvent(new Event('app:render'));
    }
  } finally {
    draining = false;
  }
}
