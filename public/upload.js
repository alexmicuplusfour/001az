import { state } from './state.js';
import { toItem } from './utils.js';
import { toast } from './toast.js';
import { ensurePolling, hasPendingUploadTags, pendingUploadTagCount } from './data.js';

const UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // keep in sync with server MAX_BYTES
const UPLOAD_CHUNK_FILES = 20;
const UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 2;
const UPLOAD_ATTEMPTS = 3;

let uploadQueue = [];
let uploadWorkers = 0;
let inFlight = 0;
let uploadStats = null;
let uploadPill = null;
let processingToast = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isImageFile = (f) => f.type.startsWith("image/") || /\.(avif|heif|heic|svg)$/i.test(f.name);
const isDocFile = (f) => /\.(pdf|docx|txt|md|csv)$/i.test(f.name);

export function handleFiles(fileList) {
  const files = [...fileList].filter((f) => isImageFile(f) || isDocFile(f));
  if (!files.length) return;

  if (!uploadStats) {
    uploadStats = { total: 0, done: 0, uploaded: 0, failed: 0, canceled: 0, failReason: "", skipped: new Map(), pendingIds: [] };
  }
  uploadStats.total += files.length;

  const valid = [];
  for (const f of files) {
    if (f.size === 0) bumpSkip("empty file");
    else if (f.size > UPLOAD_MAX_BYTES) bumpSkip("larger than 10 MB");
    else valid.push(f);
  }

  uploadQueue.push(...chunkFiles(valid));
  pumpUploads();
}

function bumpSkip(reason, n = 1) {
  uploadStats.skipped.set(reason, (uploadStats.skipped.get(reason) || 0) + n);
  uploadStats.done += n;
}

function chunkFiles(files) {
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= UPLOAD_CHUNK_FILES || curBytes + f.size > UPLOAD_CHUNK_BYTES)) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += f.size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function pumpUploads() {
  while (uploadWorkers < UPLOAD_CONCURRENCY && uploadQueue.length) {
    uploadWorkers++;
    uploadWorker();
  }
  renderUploadStatus();
  maybeFinishUploads();
}

async function uploadWorker() {
  while (uploadQueue.length) {
    await uploadChunk(uploadQueue.shift());
    renderUploadStatus();
  }
  uploadWorkers--;
  maybeFinishUploads();
}

// Merge a chunk's server rows into state.items and return the ids to track as
// pending for the processing toast. The 4s poll (data.js) can observe an entity
// the server already committed and insert it before this response's optimistic
// insert runs — the server commits each file mid-chunk but only replies once
// the whole chunk is done — so we skip rows already present to keep that race
// from double-counting them (the header/facet counts read state.items.length).
// Exported for regression testing.
export function mergeUploadedRows(rows) {
  const seen = new Set(state.items.map((it) => it.id));
  const pendingIds = [];
  for (const row of [...rows].reverse()) {
    // Boards with auto-tagging off hold uploads ('held') instead of queueing
    // them — only truly pending items feed the "Processing…" watcher.
    const rowStatus = row.status || "pending";
    if (!seen.has(row.id)) {
      state.items.unshift(toItem({ ...row, status: rowStatus }));
      seen.add(row.id);
    }
    if (rowStatus === "pending" || rowStatus === "pending_extract") pendingIds.push(row.id);
  }
  return pendingIds;
}

async function uploadChunk(chunk) {
  inFlight += chunk.length;
  renderUploadStatus();

  // Doc placeholders get a badge face, not an <img> (no object URL to show).
  const batch = chunk.map((f) => ({
    tempId: ++state.uid,
    name: f.name,
    kind: isImageFile(f) ? "image" : "doc",
    objURL: isImageFile(f) ? URL.createObjectURL(f) : null,
  }));
  state.uploading.push(...batch);
  document.dispatchEvent(new Event('app:render'));

  const fd = new FormData();
  for (const f of chunk) fd.append("files", f);

  let data = null;
  let failReason = "network error";
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`/api/upload?board=${state.boardId}`, { method: "POST", body: fd });
      if (res.ok) { data = await res.json(); break; }
      const body = await res.json().catch(() => null);
      failReason = (body && body.error) || `server error (${res.status})`;
      if (res.status === 429) {
        // Throttled, not broken — wait out the window instead of burning
        // the chunk, so huge drops finish on servers that still cap uploads.
        if (attempt < UPLOAD_ATTEMPTS) await sleep((Number(res.headers.get("Retry-After")) || 30) * 1000);
        continue;
      }
      if (res.status < 500) break;
    } catch {
      failReason = "network error";
    }
    if (attempt < UPLOAD_ATTEMPTS) await sleep(1000 * attempt);
  }

  for (const b of batch) if (b.objURL) URL.revokeObjectURL(b.objURL);
  state.uploading = state.uploading.filter((u) => !batch.includes(u));

  inFlight -= chunk.length;
  uploadStats.done += chunk.length;
  if (data) {
    const rows = Array.isArray(data.uploaded) ? data.uploaded : [];
    uploadStats.pendingIds.push(...mergeUploadedRows(rows));
    uploadStats.uploaded += rows.length;
    for (const r of data.rejected || []) {
      uploadStats.skipped.set(r.reason, (uploadStats.skipped.get(r.reason) || 0) + 1);
    }
  } else {
    uploadStats.failed += chunk.length;
    uploadStats.failReason = failReason;
  }
  document.dispatchEvent(new Event('app:render'));
  ensurePolling();
}

function cancelQueuedUploads() {
  const dropped = uploadQueue.splice(0).reduce((n, c) => n + c.length, 0);
  if (!uploadStats || !dropped) return;
  uploadStats.canceled += dropped;
  uploadStats.done += dropped;
  renderUploadStatus();
  maybeFinishUploads();
}

function maybeFinishUploads() {
  if (!uploadStats || uploadWorkers > 0 || uploadQueue.length) return;
  if (uploadStats.done < uploadStats.total) return;
  const s = uploadStats;
  uploadStats = null;
  renderUploadStatus();

  const parts = [];
  if (s.uploaded) parts.push(`Uploaded ${s.uploaded} file${s.uploaded === 1 ? "" : "s"}`);
  for (const [reason, n] of s.skipped) parts.push(`${n} skipped (${reason})`);
  if (s.failed) parts.push(`${s.failed} failed (${s.failReason}) — drop them again to retry`);
  if (s.canceled) parts.push(`${s.canceled} canceled`);
  if (parts.length) {
    if (s.failed) {
      // Failures stay up until dismissed — after a long upload the user may
      // not be looking when the run ends.
      const t = toast.error(parts.join(" · "), {
        duration: null,
        actions: [{ label: "Dismiss", onClick: () => t?.remove() }],
      });
    } else {
      toast(parts.join(" · "), { duration: s.total > 20 ? 'long' : 'short' });
    }
  }

  if (s.pendingIds.length) {
    document.dispatchEvent(new CustomEvent('app:uploads-pending-tag', {
      detail: { ids: new Set(s.pendingIds), n: s.pendingIds.length },
    }));
  }
}

function processingMsg(n) {
  return n === 1 ? "Processing 1 item…" : `Processing ${n} items…`;
}

function syncProcessingToast() {
  if (!hasPendingUploadTags()) {
    processingToast?.remove();
    processingToast = null;
    return;
  }
  const msg = processingMsg(pendingUploadTagCount());
  if (!processingToast) {
    processingToast = toast(msg, { loading: true });
  } else {
    processingToast.update(msg);
  }
}

function renderUploadStatus() {
  if (!uploadStats) {
    uploadPill?.remove();
    uploadPill = null;
    return;
  }
  const { done, total } = uploadStats;
  const effective = Math.min(done + inFlight, total);
  const pct = total ? Math.round((effective / total) * 100) : 0;
  const msg = inFlight
    ? `Uploading ${done} / ${total} (${inFlight} sending…)`
    : `Uploading ${Math.min(done, total)} / ${total}`;
  if (!uploadPill) {
    uploadPill = toast(msg, {
      duration: null,
      progress: pct,
      actions: [{ label: "Cancel", onClick: cancelQueuedUploads }],
    });
  }
  uploadPill?.update(msg, { progress: pct, showActions: uploadQueue.length > 0 });
}

export function triggerFilePicker() {
  document.getElementById("file-input").click();
}

document.addEventListener('app:uploads-pending-tag', syncProcessingToast);
document.addEventListener('app:uploads-tagged', syncProcessingToast);
document.addEventListener('app:uploads-pending-changed', syncProcessingToast);
document.addEventListener('app:item-merged', (e) => {
  const n = e.detail?.count || 1;
  toast(n === 1 ? "Merged into an existing entity" : `${n} files merged into existing entities`);
});

export function initUpload() {
  const elFileInput = document.getElementById("file-input");
  const elDropOverlay = document.getElementById("drop-overlay");

  elFileInput.addEventListener("change", () => {
    handleFiles(elFileInput.files);
    elFileInput.value = "";
  });

  let dragDepth = 0;
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (!state.me) return;
    dragDepth++;
    elDropOverlay.hidden = false;
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; elDropOverlay.hidden = true; }
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    elDropOverlay.hidden = true;
    if (state.me && e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });
}
