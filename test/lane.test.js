// The budgeted processing lane and the queue status pills: inProgress()
// orders the lane by aliveness (upload placeholders, then actively-worked,
// then queued) so the grid's budget shows real work first, and
// taggedFiltered() swaps its isTagged gate for the selected status sets so
// the whole queue is browsable through the normal paginated grid. Same
// document stub as upload.test.js, plus getElementById for filters.js's
// module-scope element grabs.
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
globalThis.document = {
  body: elem("body"),
  createElement: elem,
  getElementById: () => elem("div"),
  addEventListener() {},
};

const { state } = await import("../public/state.js");
const { inProgress } = await import("../public/data.js");
const { taggedFiltered, filterKey } = await import("../public/filters.js");
const { toItem } = await import("../public/utils.js");

const row = (id, status, tags = [], extra = {}) => toItem({ id, name: `${id}.png`, status, tags, ...extra });
// Which cards show, in id order: these tests are about the status gate. The
// order the grid draws them in is sort-core.js's (sort-core.test.js).
const ids = () => taggedFiltered().map((i) => i.id).sort((a, b) => a - b);

test("inProgress: uploads first, then active, then queued, each newest first; retags stay out of the lane", () => {
  state.uploading = [{ tempId: 99, name: "up.png", kind: "image", objURL: null }];
  state.items = [
    row(1, "pending", [], { created_at: 600 }),
    row(2, "processing", [], { created_at: 200 }),
    row(3, "tagged", ["a/b"], { created_at: 300 }),
    row(4, "pending", ["a/b"], { created_at: 400 }), // retag: in-flight but keeps its stale tags
    row(5, "extracting", [], { created_at: 500 }),
    row(6, "pending_face", [], { created_at: 100 }),
  ];
  // By date, not by arrival (5 came after 2) and not by id (1 is the newer of 1 and 6).
  assert.deepEqual(inProgress().map((p) => p.tempId ?? p.id), [99, 5, 2, 1, 6]);
});

test("taggedFiltered: without status pills, in-flight items stay out of the grid", () => {
  state.uploading = [];
  state.showProcessing = false;
  state.showUnprocessed = false;
  state.items = [
    row(1, "tagged", ["a/b"]),
    row(2, "processing"),
    row(3, "pending"),
    row(4, "held"),
    row(5, "pending", ["a/b"]),
  ];
  assert.deepEqual(ids(), [1, 4, 5], "tagged, held, and the retag show; the queue doesn't");
});

test("taggedFiltered: status pills swap the gate for their sets and OR together", () => {
  state.showProcessing = true;
  assert.deepEqual(ids(), [2], "Processing = actively worked only");

  state.showProcessing = false;
  state.showUnprocessed = true;
  assert.deepEqual(ids(), [3, 5], "Unprocessed = queued, including the retag");

  state.showProcessing = true;
  assert.deepEqual(ids(), [2, 3, 5], "both pills = the whole in-flight queue");
});

test("filterKey: the status flags participate, so toggling one resets pagination", () => {
  state.showProcessing = false;
  state.showUnprocessed = false;
  const base = filterKey();
  state.showProcessing = true;
  const withProcessing = filterKey();
  assert.notEqual(withProcessing, base);
  state.showUnprocessed = true;
  assert.notEqual(filterKey(), withProcessing);
  state.showProcessing = false;
  state.showUnprocessed = false;
});
