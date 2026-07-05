import { state } from './state.js';
import { toItem } from './utils.js';

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

function needsPoll() {
  return (
    state.uploading.length > 0 ||
    state.items.some((img) => img.status === "pending" || img.status === "processing")
  );
}

// First-time tags (no tags yet) show at the top; retags stay in the grid.
export function inProgress() {
  return [
    ...state.uploading,
    ...state.items.filter(
      (img) => (img.status === "pending" || img.status === "processing") && !img.tags.length
    ),
  ];
}

export function reconcile(data) {
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
    } else {
      state.items.unshift(toItem(d));
    }
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

let polling = false;

async function pollTick() {
  if (!needsPoll()) {
    polling = false;
    return;
  }
  try {
    const data = await fetch(`/api/items?board=${state.boardId}`, { cache: "no-store" }).then((r) => r.json());
    reconcile(data);
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
