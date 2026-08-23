// The delta-poll crux in reconcile(data, presentIds): a delta response omits
// UNCHANGED items, so absence from `data` no longer means "gone from the
// server" — that judgment moved to the ids list (presentIds). An in-flight
// item missing from both is merged/deleted (drop it, settle its upload
// batch); missing from data but present in ids is just quiet (keep waiting).
// Same document/toast stubbing as upload.test.js — data.js and upload.js are
// DOM-coupled only through module-scope listeners.
import { test } from "node:test";
import assert from "node:assert/strict";

function elem(tag) {
  return {
    tag,
    children: [],
    style: {},
    parent: null,
    appendChild(c) {
      c.parent = this;
      this.children.push(c);
      return c;
    },
    addEventListener() {},
    remove() {},
  };
}
const listeners = {};
globalThis.document = {
  body: elem("body"),
  createElement: elem,
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); return true; },
};

const { mergeUploadedRows } = await import("../public/upload.js");
const { reconcile, hasPendingUploadTags, pollDelay } = await import("../public/data.js");
const { state } = await import("../public/state.js");

const row = (id, status = "pending") => ({ id, name: `${id}.png`, label: `${id}.png`, kind: "image", status });

test("quiet delta keeps an unchanged in-flight item waiting", () => {
  state.items = [];
  mergeUploadedRows([row(31, "pending")]);
  document.dispatchEvent(new CustomEvent("app:uploads-pending-tag", { detail: { ids: new Set([31]), n: 1 } }));

  // Nothing changed server-side this tick: empty delta, but #31 is still in
  // the ids list. It must neither vanish nor settle its batch.
  reconcile([], new Set([31]));
  assert.deepEqual(state.items.map((i) => i.id), [31], "still queued, still shown");
  assert.equal(hasPendingUploadTags(), true, "the toast keeps waiting");

  // The result lands on a later tick.
  reconcile([row(31, "tagged")], new Set([31]));
  assert.equal(state.items[0].status, "tagged");
  assert.equal(hasPendingUploadTags(), false, "batch settles on the real result");
});

test("absence from the ids list still reads as merged away", () => {
  state.items = [];
  mergeUploadedRows([row(41, "pending"), row(42, "pending")]);
  document.dispatchEvent(new CustomEvent("app:uploads-pending-tag", { detail: { ids: new Set([41, 42]), n: 2 } }));

  // #41 merged into another entity mid-flight: gone from ids entirely, while
  // #42 finished tagging. The batch must settle instead of waiting forever.
  reconcile([row(42, "tagged")], new Set([42]));
  assert.deepEqual(state.items.map((i) => i.id), [42], "merged-away in-flight card is dropped");
  assert.equal(hasPendingUploadTags(), false, "batch settles: one merged, one tagged");
});

// The stuck-spinner bug: a merge can delete a card no upload batch is tracking
// (a re-extract, another tab's upload, ingestion, or a survivor whose batch
// already settled). The card's spinner never repaints (cardSig keys on status
// and the poll never lists a deleted entity again), so it ran forever until a
// reload. The sweep must drop it even with no batch — after a one-tick grace so
// a not-yet-acknowledged fresh upload isn't yanked out from under a live drop.
test("in-flight card gone from ids with no batch is swept after a grace tick", () => {
  state.items = [];
  reconcile([row(51, "processing")], new Set([51]));   // poll inserts an entity, no batch

  reconcile([], new Set([]));   // #51 vanished (merged) — grace tick, keep it
  assert.deepEqual(state.items.map((i) => i.id), [51], "one grace tick before the drop");

  reconcile([], new Set([]));   // still gone — a confirmed ghost now
  assert.deepEqual(state.items.map((i) => i.id), [], "untracked ghost card is swept");
});

test("a fresh card missing from one stale id snapshot then acknowledged survives", () => {
  state.items = [];
  mergeUploadedRows([row(52, "pending")]);   // optimistic upload insert

  // A poll whose id snapshot predates the insert: #52 is momentarily absent.
  reconcile([], new Set([]));
  // Next tick acknowledges it. The grace tick means it was never dropped.
  reconcile([row(52, "processing")], new Set([52]));
  assert.deepEqual(state.items.map((i) => i.id), [52], "live upload card is not flickered away");
});

// Live boards regenerate chart faces server-side under new filenames (the old
// webp is deleted); a tab that stops polling keeps the dead name and 404s in
// the lightbox. The cadence decision must keep quiet live boards on a slow poll.
test("poll cadence: fast while work is in flight, slow on a live board, off otherwise", () => {
  state.uploading = [];
  state.items = [{ id: 1, status: "tagged", tags: [] }];

  state.boardMapping = null;
  assert.equal(pollDelay(), 0, "settled non-live board: no poll");

  state.boardMapping = { fields: [{ key: "price", source: "connector", refresh: { every: 1 } }] };
  assert.equal(pollDelay(), 30000, "live connector fields: slow poll");

  state.boardMapping = { fields: [], face: { source: "connector", producer: "chart", refresh: { every: 60 } } };
  assert.equal(pollDelay(), 30000, "live chart face: slow poll");

  state.boardMapping = { fields: [{ key: "price", source: "connector" }], face: { source: "connector", producer: "chart" } };
  assert.equal(pollDelay(), 0, "connector but nothing live: no poll");

  // Automatic ingestion admits items server-side on quiet boards — same
  // stale-tab problem as live faces, same slow-poll cure.
  state.boardMapping = null;
  state.boardIngestNextRun = Date.now() + 60000;
  assert.equal(pollDelay(), 30000, "a run on the way: slow poll");
  state.boardIngestNextRun = null;
  state.boardIngestMode = "paused";
  assert.equal(pollDelay(), 0, "a held schedule has nothing coming: no poll");
  state.boardIngestMode = null;

  // An alert is a standing statement that arrivals on this board matter, and
  // arrivals are items — a tab holding one keeps listening for them. (Its DOT
  // is signals.js's own timer and does not depend on this.)
  state.alerts = [{ id: 1, name: "watch", unseen: 0 }];
  assert.equal(pollDelay(), 30000, "a held alert: slow poll");
  state.alerts = [];
  assert.equal(pollDelay(), 0, "no alerts, nothing live: back off");

  state.items = [{ id: 1, status: "processing", tags: [] }];
  assert.equal(pollDelay(), 4000, "in-flight work: fast poll wins regardless of liveness");

  state.boardMapping = null;
});
