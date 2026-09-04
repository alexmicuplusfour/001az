import { state } from './state.js';
import { toItem, toInstance } from './utils.js';
import { api } from './api.js';
import { toast } from './toast.js';

// Batches of uploaded items we're waiting to see fully tagged.
const pendingBatches = []; // [{ ids: Set<id>, n: number }]

// In-flight card ids that were absent from the server's id list last tick.
// A ghost card (an entity merged/deleted server-side) is swept only after a
// SECOND consecutive absence — see the sweep in reconcile() for why.
let ghostSeen = new Set();

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
export const ACTIVE = new Set(["processing", "extracting", "facing", "fetching"]);
export const QUEUED = new Set(["pending", "pending_extract", "pending_face", "pending_fetch"]);
const IN_FLIGHT = new Set([...ACTIVE, ...QUEUED]);

function needsPoll() {
  return (
    state.uploading.length > 0 ||
    state.items.some((img) => IN_FLIGHT.has(img.status))
  );
}

// needsPoll's stricter sibling: work actually MOVING, not merely queued —
// an upload mid-flight or a row a worker is holding. The pair is what lets a
// paused board tell "the queue is waiting" from "something is still running".
function moving() {
  return (
    state.uploading.length > 0 ||
    state.items.some((img) => ACTIVE.has(img.status))
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

// Mirror a routed-status report onto the loaded cards. Every re-queue route
// (reprocess, retag, re-extract) answers `entities: [{id, status, instances}]`
// saying where each instance actually landed (fetch/face/extract/tag differ
// per payload) plus each card's aggregate — and in classify mode ONE click
// can move several cards, since an instance belongs to every entity that
// claimed it. The status pills, poll tiers and lane ordering above all read
// these statuses before the first reconcile, so the guessed "pending" this
// replaces put a fetching stock in the wrong bucket.
export function applyRoutedEntities(entities = []) {
  for (const { id, status, instances = [] } of entities) {
    const img = state.items.find((i) => i.id === id);
    if (!img) continue;
    img.status = status;
    const byId = new Map(instances.map((i) => [i.id, i.status]));
    for (const i of img.instances || []) i.status = byId.get(i.id) ?? i.status;
  }
}

// The whole re-queue click, one call: POST, mirror the report, repaint, and
// make sure the poll is running to follow the work. Every surface that queues
// AI work for a card or instance goes through here — the grid's reprocess,
// rows-mode retag/re-extract, the lightbox's leg buttons — so the contract
// and its mirror stay in one place as Stage 4 adds more entries. Throws on
// failure (api unwraps the server's `{error}`); callers own the toast.
export async function requeue(url, body) {
  const { entities } = await api("POST", url, body);
  applyRoutedEntities(entities);
  document.dispatchEvent(new Event('app:render'));
  ensurePolling();
}

// requeue + the two toasts — the whole click, for every surface that queues
// AI work (card actions and their caret, rows-mode tiles, lightbox buttons).
// The error toast is the SERVER's sentence: `api` throws the route's `{error}`
// message, so a 409 says "not a connector item" / "only audio can be
// re-transcribed" rather than a generic failure. That matters beyond
// politeness — the caret decides which verbs to offer from client-side
// mirrors, and this sentence is what makes a wrong guess self-explaining
// instead of mysterious. A bare status code (no JSON body) falls back to the
// caller's phrasing.
export async function requeueToast(url, okMsg, failMsg, body) {
  try {
    await requeue(url, body);
    toast(okMsg, { duration: "short" });
  } catch (e) {
    toast.error(/^\d+$/.test(e.message) ? failMsg : e.message);
  }
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
      // Server clears tags while re-queuing; keep stale tags until a result
      // lands. held is terminal too (a parked row — e.g. a cancelled retag —
      // may sit indefinitely), so an empty list is its truth, not a transit.
      if (d.status === "tagged" || d.status === "failed" || d.status === "held" || list.length) {
        ex.tags = list;
        ex.tagSet = new Set(list);
      }
      ex.undecided = !!d.undecided;
      ex.hearts = d.hearts || 0;
      ex.favoritedByMe = !!d.favoritedByMe;
      ex.crateIds = new Set(Array.isArray(d.crateIds) ? d.crateIds : []);
      // Detected-object union — follow unconditionally (absent = none): unlike
      // tags, fields are only ever REPLACED whole at extraction landing, so
      // there's no mid-requeue stale window to keep old values through.
      ex.objectSet = new Set(d.objects || []);
      // created_at backfills items uploaded this session (their upload rows
      // predate the entity stamp); updated_at moves on every delta.
      if (d.created_at != null) ex.created_at = d.created_at;
      if (d.updated_at != null) ex.updated_at = d.updated_at;
      // A re-extract or face swap can change the media bag; live refreshes
      // change fields — both ride every delta row, follow them.
      if (d.media !== undefined) ex.media = d.media;
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

  // An in-flight card that vanished from the server's id list was merged into
  // another entity (or deleted elsewhere). Two separate jobs here:
  //
  //  (a) settle upload batches — drop the vanished id so the "Processing N"
  //      toast counts down instead of stalling on a row that never reports
  //      again, and announce the merge to the uploader.
  //  (b) sweep the ghost CARD out of the grid — its spinner runs forever
  //      otherwise: the poll never lists a deleted entity again, and cardSig
  //      keys on status, so nothing repaints it. Crucially this is NOT gated on
  //      a batch tracking the id (the old bug): a merge from a re-extract,
  //      another tab's upload, ingestion, or a batch that already settled left a
  //      spinner only a reload could clear.
  let mergedCount = 0;
  const trackedGone = new Set();
  for (let i = pendingBatches.length - 1; i >= 0; i--) {
    const { ids } = pendingBatches[i];
    for (const id of [...ids]) {
      if (!freshIds.has(id)) {
        ids.delete(id);
        trackedGone.add(id);
        mergedCount++;
      }
    }
    if (ids.size === 0) pendingBatches.splice(i, 1);
  }

  // A tracked id (uploaded by us) is dropped on sight — a batch is minted only
  // once the whole drop finished, by which point its ids have all round-tripped
  // through the id list, so an absence is a real merge. An UNtracked ghost waits
  // for a second consecutive absence: a just-uploaded card the server hasn't
  // acknowledged yet can be momentarily missing from an id snapshot the
  // optimistic insert raced ahead of, and one grace tick lets that resolve so we
  // never yank a live upload's card and flicker it back.
  const absentInFlight = new Set();
  for (const img of state.items) {
    if (IN_FLIGHT.has(img.status) && !freshIds.has(img.id)) absentInFlight.add(img.id);
  }
  const drop = new Set();
  for (const id of absentInFlight) if (trackedGone.has(id) || ghostSeen.has(id)) drop.add(id);
  ghostSeen = absentInFlight;
  if (drop.size > 0) {
    state.items = state.items.filter((img) => !drop.has(img.id));
    document.dispatchEvent(new Event('app:uploads-pending-changed'));
  }
  if (mergedCount > 0) {
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
// polling — so we refresh the board's running totals on the same cadence and
// let the toolbar's odometer roll to the new values.
async function refreshTokens() {
  if (!state.boardId) return;
  try {
    const r = await fetch(`/api/boards/${state.boardId}/tokens`, { cache: "no-store" });
    if (!r.ok) return;
    const { units, unitDefs, cost } = await r.json();
    if (units) {
      state.boardUnits = units;
      state.boardUnitDefs = unitDefs ?? null;
      // cost is a manager-only key and absent when nothing was priced — both
      // read as "no figure", so the chip drops its ≈$ rather than showing $0.
      state.boardCost = cost ?? null;
    }
  } catch { /* leave the last known totals */ }
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
  return (m.fields || []).some((f) => f.source === "connector" && f.refresh) ||
    (m.face?.source === "connector" && !!m.face.refresh);
}

// Exported for tests: the cadence decision in one place. Boards with a run
// COMING keep the slow poll too — the sweep admits items server-side, so a
// quiet tab would otherwise never see them arrive. The armed stamp, not the
// enabled flag, is the right test: a paused schedule and an idle manual board
// have nothing on the way, while a hand-fired run on either one arms the stamp
// and polls until it lands. Alerts hold it for the same reason and NOT for
// their dot: an alert is a standing statement that arrivals on this board
// matter, and the arrivals themselves are items. (The dot is signals.js's, on
// its own timer — it lights whether this poll runs or not.)
export function pollDelay() {
  // A paused board's QUEUE is intact but nothing is on the way, so it doesn't
  // earn the fast tier — only work genuinely moving does: an upload landing
  // (pause gates execution, never intake) or a row pause let finish. Without
  // this a paused backlog would hold the 4s poll open indefinitely.
  if (needsPoll()) return state.boardPaused && !moving() ? 30000 : 4000;
  if (liveBoard() || state.boardIngestNextRun != null || state.alerts.length) return 30000;
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

// The board payload's cadence flags, stamped into state in exactly one
// place — the boot path, the ingest modal and the toolbar chip all funnel
// through here so they can't drift on what "refreshed" means.
export function stampBoard(b) {
  state.boardIngestMode = b.ingest_mode ?? null;
  state.boardIngestNextRun = b.ingest_next_run_at ?? null;
  // ?? false covers payloads without the flag (the boot fallback {}). A save
  // response's false is truthful, not stale: saving an ingest config clears
  // last_error server-side (superseded — the next run judges the new config),
  // so the chip clearing on save agrees with every other surface.
  state.boardIngestError = b.ingest_error ?? false;
  // Board pause rides the same funnel and for the same reason: it drives the
  // jobs chip AND pollDelay below, so a payload arriving anywhere must reach
  // both. Reset semantics like ingest_error — which is why the board PATCH
  // echoes `paused` back, so a save response can't read as "unpaused".
  state.boardPaused = b.paused ?? false;
}

// The user (or another manager's poll) flipped the pause. One setter so the
// three consequences travel together: the flag, the poll cadence it feeds,
// and the render that repaints the chip. refreshBoardIngest's shape exactly.
export function setBoardPaused(v) {
  state.boardPaused = !!v;
  ensurePolling(); // resume drops us back to the fast tier without waiting out the slow timer
  document.dispatchEvent(new Event("app:render"));
}

// Re-learn the flags after something changed them server-side (save, run-now,
// countdown expiry), then let the poll cadence and toolbar follow. Resolves
// true only when a fresh payload actually landed — callers back off on false.
export async function refreshBoardIngest() {
  try {
    const b = await fetch(`/api/boards/${state.boardId}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    if (!b) return false;
    stampBoard(b);
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
