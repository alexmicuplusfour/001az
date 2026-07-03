import { state } from './state.js';
import { toImage } from './utils.js';

// Batches of uploaded images we're waiting to see fully tagged.
const pendingBatches = []; // [{ ids: Set<id>, n: number }]

document.addEventListener('app:uploads-pending-tag', (e) => {
  pendingBatches.push(e.detail);
});

export function inProgress() {
  return [
    ...state.uploading,
    ...state.images.filter((img) => img.status === "pending" || img.status === "processing"),
  ];
}

export function reconcile(data) {
  const byId = new Map(state.images.map((i) => [i.id, i]));
  for (const d of data) {
    const ex = byId.get(d.id);
    if (ex) {
      const list = Array.isArray(d.tags) ? d.tags : [];
      ex.status = d.status;
      ex.tags = list;
      ex.tagSet = new Set(list);
      ex.hearts = d.hearts || 0;
      ex.favoritedByMe = !!d.favoritedByMe;
      ex.crateIds = new Set(Array.isArray(d.crateIds) ? d.crateIds : []);
    } else {
      state.images.unshift(toImage(d));
    }
  }

  // Check if any upload batch has finished tagging.
  for (let i = pendingBatches.length - 1; i >= 0; i--) {
    const { ids, n } = pendingBatches[i];
    const allDone = [...ids].every((id) => {
      const img = state.images.find((m) => m.id === id);
      return !img || img.status === 'tagged' || img.status === 'failed';
    });
    if (allDone) {
      pendingBatches.splice(i, 1);
      document.dispatchEvent(new CustomEvent('app:uploads-tagged', { detail: { n } }));
    }
  }
}

let polling = false;

async function pollTick() {
  if (inProgress().length === 0) {
    polling = false;
    return;
  }
  try {
    const data = await fetch(`/api/images?board=${state.boardId}`, { cache: "no-store" }).then((r) => r.json());
    reconcile(data);
    document.dispatchEvent(new Event('app:render'));
  } catch {
    /* keep polling */
  }
  setTimeout(pollTick, 4000);
}

export function ensurePolling() {
  if (!polling && inProgress().length > 0) {
    polling = true;
    setTimeout(pollTick, 4000);
  }
}
