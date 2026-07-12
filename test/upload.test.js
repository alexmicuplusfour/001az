// Regression coverage for the upload count doubling to ~2x during a large
// drop: the 4s poll (data.js) inserts an entity the server already committed,
// then the chunk's own response optimistically inserted it again — no dedup —
// so state.items (and the header/facet counts that read its length) inflated
// until a refresh rebuilt state from the server. mergeUploadedRows now skips
// rows already present. upload.js is DOM-coupled only through module-scope
// listeners + toast's #toast-wrap, so the same tiny stub toast.test.js uses is
// enough to import it.
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
// A working event bus: data.js/upload.js coordinate the processing toast via
// document events, so the stub must actually deliver them.
const listeners = {};
globalThis.document = {
  body: elem("body"),
  createElement: elem,
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); return true; },
};

const { mergeUploadedRows } = await import("../public/upload.js");
const { reconcile, hasPendingUploadTags } = await import("../public/data.js");
const { state } = await import("../public/state.js");
const { toItem } = await import("../public/utils.js");

const row = (id, status = "pending") => ({ id, name: `${id}.docx`, label: `${id}.docx`, kind: "docx", status });

test("mergeUploadedRows: a poll-inserted entity is not duplicated by the upload response", () => {
  // The poll got there first and inserted entity #7 into the grid.
  state.items = [toItem(row(7))];
  const pending = mergeUploadedRows([row(7), row(8)]);
  assert.equal(state.items.length, 2, "#7 must not be inserted twice; #8 is new");
  assert.deepEqual(
    state.items.map((i) => i.id).sort((a, b) => a - b),
    [7, 8]
  );
  // Both are still tracked so the processing toast waits on them.
  assert.deepEqual(pending.slice().sort((a, b) => a - b), [7, 8]);
});

test("mergeUploadedRows: fresh rows all insert; only in-flight statuses are tracked", () => {
  state.items = [];
  const pending = mergeUploadedRows([row(1, "pending"), row(2, "held"), row(3, "pending_extract")]);
  assert.equal(state.items.length, 3, "all three insert into an empty grid");
  // Born-held (unmapped board, auto-tag off) doesn't feed the processing
  // watcher; the queued two do.
  assert.deepEqual(pending.slice().sort((a, b) => a - b), [1, 3]);
});

test("reconcile: uploads parked in held complete the processing watcher", () => {
  // Auto-tag off on a mapped board: born pending_extract (tracked), extraction
  // runs, then the items PARK in held — the toast must clear there, not wait
  // for a tagging that deliberately never comes.
  state.items = [];
  mergeUploadedRows([row(21, "pending_extract"), row(22, "pending_extract")]);
  document.dispatchEvent(new CustomEvent("app:uploads-pending-tag", { detail: { ids: new Set([21, 22]), n: 2 } }));
  assert.equal(hasPendingUploadTags(), true, "watcher armed while the extract leg runs");

  reconcile([row(21, "held"), row(22, "held")]);
  assert.equal(hasPendingUploadTags(), false, "held = definition done — the toast clears");
});
