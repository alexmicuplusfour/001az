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

export function reconcile(data) {
  const freshIds = new Set(data.map((d) => d.id));
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

  // Check if any upload batch has finished tagging.
  for (let i = pendingBatches.length - 1; i >= 0; i--) {
    const { ids, n } = pendingBatches[i];
    const allDone = [...ids].every((id) => {
      const img = state.items.find((m) => m.id === id);
      return img && (img.status === 'tagged' || img.status === 'failed');
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

let polling = false;

async function pollTick() {
  if (!needsPoll()) {
    polling = false;
    // The last item's tokens land just after its status flips to tagged, so
    // catch that final bump once the queue has drained.
    await refreshTokens();
    document.dispatchEvent(new Event('app:render'));
    return;
  }
  try {
    const data = await fetch(`/api/items?board=${state.boardId}`, { cache: "no-store" }).then((r) => r.json());
    reconcile(data);
    await refreshTokens();
    document.dispatchEvent(new Event('app:render'));
  } catch {
    /* keep polling */
  }
  setTimeout(pollTick, 4000);
}

export function ensurePolling() {
  if (!polling && needsPoll()) {
    polling = true;
    setTimeout(pollTick, 4000);
  }
}
