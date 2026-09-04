// Instance rows (planning/instance-rows-plan.md), the pure client pieces:
// phase 1's tag-pop per-tag instance counts, phase 2's view-mode selection
// and per-board persistence. The board-sort pattern — shims, then dynamic
// import of the public modules.
import { localStore as store } from "./browser-stub.js";
import { test } from "node:test";
import assert from "node:assert/strict";

// The SHARED stub, not a local copy (its header explains why). filters.js
// also grabs container elements at module level — none of it touched by the
// pure functions under test.
globalThis.document.getElementById ||= () => null;

const { state } = await import("../public/state.js");
const { toItem, toInstance, instanceTagCounts, mappingHasAiWork } = await import("../public/utils.js");
const { effectiveView, resolveView, rowsRelevant, saveView, restoreView } = await import("../public/view.js");
const { instanceMatches } = await import("../public/filters.js");

const inst = (id, tags) => ({ id, name: `${id}.webp`, kind: "image", status: "tagged", tags });

// The emma-board shape: one entity, four photos, per-photo facet judgments.
test("instanceTagCounts: union tags count the instances that carry them", () => {
  const item = toItem({
    id: 1, name: "a.webp", identity: "emma roberts", display_name: "Emma Roberts",
    status: "tagged",
    tags: ["which-emma/emma-roberts", "hair-length/medium", "hair-length/long", "hair-length/short"],
    instances: [
      inst(11, ["which-emma/emma-roberts", "hair-length/medium"]),
      inst(12, ["which-emma/emma-roberts", "hair-length/medium"]),
      inst(13, ["which-emma/emma-roberts", "hair-length/long"]),
      inst(14, ["which-emma/emma-roberts", "hair-length/short"]),
    ],
  });
  const counts = instanceTagCounts(item);
  assert.equal(counts.get("which-emma/emma-roberts"), 4);
  assert.equal(counts.get("hair-length/medium"), 2);
  assert.equal(counts.get("hair-length/long"), 1);
  assert.equal(counts.get("hair-length/short"), 1);
});

test("instanceTagCounts: single instance counts 1 per tag (the display gate lives in the grid)", () => {
  const item = toItem({
    id: 2, name: "b.webp", status: "tagged",
    tags: ["color/red"], instances: [inst(21, ["color/red"])],
  });
  assert.deepEqual([...instanceTagCounts(item)], [["color/red", 1]]);
});

test("instanceTagCounts: untagged instances contribute nothing", () => {
  const item = toItem({
    id: 3, name: "c.webp", status: "tagged",
    tags: ["color/red"], instances: [inst(31, ["color/red"]), inst(32, [])],
  });
  assert.deepEqual([...instanceTagCounts(item)], [["color/red", 1]]);
});

test("instanceTagCounts: no instances (transient reconcile shape) is an empty map", () => {
  const item = toItem({ id: 4, name: "d.webp", status: "tagged", tags: [], instances: [] });
  assert.equal(instanceTagCounts(item).size, 0);
});

// ── view mode (phase 2): explicit choice wins, null falls back to grid ──────

test("effectiveView: null and 'grid' render grid; 'rows' renders rows", () => {
  state.view = null;
  assert.equal(effectiveView(), "grid");
  state.view = "grid";
  assert.equal(effectiveView(), "grid");
  state.view = "rows";
  assert.equal(effectiveView(), "rows");
  state.view = null;
});

test("saveView/restoreView: round-trips per board, isolated between boards", () => {
  state.boardId = "b1";
  state.view = "rows";
  saveView();
  state.boardId = "b2";
  restoreView();
  assert.equal(state.view, null, "b2 has no stored choice");
  state.boardId = "b1";
  restoreView();
  assert.equal(state.view, "rows", "b1 restores its own choice");
});

test("saveView: a null choice removes the stored key (back to auto)", () => {
  state.boardId = "b3";
  state.view = "grid";
  saveView();
  state.view = null;
  saveView();
  state.view = "rows"; // junk in state to prove restore overwrites it
  restoreView();
  assert.equal(state.view, null);
});

test("restoreView: junk in storage restores as null, not a broken mode", () => {
  state.boardId = "b4";
  globalThis.localStorage.setItem("boardView:b4", "masonry?");
  restoreView();
  assert.equal(state.view, null);
});

// ── phase 3: the Re-extract gate mirrors the worker's aiWork condition ──────

test("mappingHasAiWork: derived identity or any AI field → true", () => {
  assert.equal(mappingHasAiWork({ identity: { source: "extract", instruction: "who" }, fields: [] }), true);
  assert.equal(mappingHasAiWork({
    fields: [{ key: "color", kind: "text", source: "extract" }],
  }), true);
});

test("mappingHasAiWork: connector/file-only mappings and no mapping → false", () => {
  assert.equal(mappingHasAiWork({
    identity: { source: "connector" },
    fields: [{ key: "price", kind: "number", source: "connector" }, { key: "size", kind: "number", source: "file" }],
  }), false);
  assert.equal(mappingHasAiWork({ fields: [] }), false);
  assert.equal(mappingHasAiWork(null), false);
  assert.equal(mappingHasAiWork(undefined), false);
});

// ── phase 4: instance-level filter matching ─────────────────────────────────

const mkInst = (tags) => toInstance({ id: 9, name: "x.webp", status: "tagged", tags });

test("instanceMatches: values within a facet OR, facets AND", () => {
  state.selected = new Map([["hair-length", new Set(["short"])]]);
  assert.equal(instanceMatches(mkInst(["hair-length/short"])), true);
  assert.equal(instanceMatches(mkInst(["hair-length/long"])), false);

  state.selected = new Map([["hair-length", new Set(["short", "long"])]]);
  assert.equal(instanceMatches(mkInst(["hair-length/long"])), true);

  // The cross-instance union case: an instance must satisfy EVERY facet on
  // its own — short alone fails a short+roberts filter even though its
  // entity (via a sibling photo) matches.
  state.selected = new Map([
    ["hair-length", new Set(["short"])],
    ["which-emma", new Set(["emma-roberts"])],
  ]);
  assert.equal(instanceMatches(mkInst(["hair-length/short", "which-emma/emma-roberts"])), true);
  assert.equal(instanceMatches(mkInst(["hair-length/short"])), false);
  state.selected = new Map();
});

test("instanceMatches: empty-value facets and no selections match everything", () => {
  state.selected = new Map([["hair-length", new Set()]]);
  assert.equal(instanceMatches(mkInst([])), true);
  state.selected = new Map();
  assert.equal(instanceMatches(mkInst([])), true);
});

// ── phase 4: the auto rule (resolveView) ────────────────────────────────────

const singleEnt = () => toItem({ id: 21, name: "s.webp", status: "tagged", tags: [], instances: [inst(211, [])] });
const multiEnt = () => toItem({ id: 22, name: "m.webp", status: "tagged", tags: [], instances: [inst(221, []), inst(222, [])] });

test("resolveView: auto-rows needs filters AND a multi-instance entity in the result", () => {
  state.view = null;
  assert.equal(resolveView([singleEnt()], true), "grid", "raw-board guardrail: no multi-instance entity, no flip");
  resolveView([], false); // session boundary — each case starts a fresh session
  assert.equal(resolveView([singleEnt(), multiEnt()], true), "rows");
  resolveView([], false);
  assert.equal(resolveView([singleEnt(), multiEnt()], false), "grid", "no filters, no flip");
  assert.equal(resolveView([], true), "grid");
  resolveView([], false);
});

test("resolveView: rows ratchets for the session — losing the last stack doesn't yank the view", () => {
  state.view = null;
  assert.equal(resolveView([multiEnt()], true), "rows");
  // The result's only stack just lost an instance (a rows-mode delete) —
  // the very next render must not flip the surface out from under the hand
  // that clicked.
  assert.equal(resolveView([singleEnt()], true), "rows");
  assert.equal(resolveView([], true), "rows");
  // Clearing the filters ends the session and drops the latch: a fresh
  // session over a stackless result starts from the guardrail again.
  assert.equal(resolveView([singleEnt()], false), "grid");
  assert.equal(resolveView([singleEnt()], true), "grid");
  resolveView([], false);
});

test("resolveView: the ratchet still engages late — the stack can stream in behind first paint", () => {
  state.view = null;
  // URL-restored filters render before the board finishes draining: the
  // first paint sees no stacks, a later page delivers one.
  assert.equal(resolveView([singleEnt()], true), "grid");
  assert.equal(resolveView([singleEnt(), multiEnt()], true), "rows");
  resolveView([], false);
});

test("resolveView: filtering flips to rows even over a pinned base; clearing restores it", () => {
  state.view = "grid"; // pinned base preference
  assert.equal(resolveView([multiEnt()], true), "rows", "the filter session overrides the base");
  assert.equal(resolveView([multiEnt()], false), "grid", "clearing filters returns to the previous mode");
  // A standing rows preference survives a filter whose result can't stack —
  // the session falls back to the base, not to grid.
  state.view = "rows";
  assert.equal(resolveView([singleEnt()], true), "rows");
  assert.equal(resolveView([], false), "rows");
  state.view = null;
});

test("effectiveView: reflects the last resolution between renders", () => {
  state.view = null;
  resolveView([multiEnt()], true);
  assert.equal(effectiveView(), "rows", "sentinel/layout callbacks between renders see the auto mode");
  resolveView([multiEnt()], false);
  assert.equal(effectiveView(), "grid");
});

// ── the rows toggle's visibility gate ───────────────────────────────────────

test("rowsRelevant: derived mapping, multi-instance data, or effective rows", () => {
  // Derived mapping alone (no merges yet) → the button shows from boot.
  state.view = null;
  state.boardMapping = { identity: { source: "extract", instruction: "who" }, fields: [] };
  state.items = [singleEnt()];
  assert.equal(rowsRelevant(), true);

  // Classic gallery: raw mapping, single-instance data → no button.
  state.boardMapping = null;
  assert.equal(rowsRelevant(), false);

  // Mapping switched away but multi-instance entities remain → still shown.
  state.items = [singleEnt(), multiEnt()];
  assert.equal(rowsRelevant(), true);

  // Escape hatch: an explicit rows choice keeps the button visible even on
  // a board that stopped being relevant.
  state.items = [singleEnt()];
  state.view = "rows";
  assert.equal(rowsRelevant(), true);

  state.view = null;
  state.items = [];
  state.boardMapping = null;
});

// ── session-scoped vs persistent toggling ───────────────────────────────────

test("toggleView: session-scoped while filtered, persistent otherwise", async () => {
  const { toggleView } = await import("../public/view.js");
  state.boardId = "b5";
  state.view = null;

  // In a filter session: auto-rows engages, a toggle pins grid — for the
  // session only. The base preference and storage stay untouched.
  assert.equal(resolveView([multiEnt()], true), "rows");
  toggleView();
  assert.equal(effectiveView(), "grid", "the session choice wins for the rest of the session");
  assert.equal(state.view, null, "the base preference is untouched");
  assert.equal(globalThis.localStorage.getItem("boardView:b5"), null, "nothing persisted mid-session");
  assert.equal(resolveView([multiEnt()], true), "grid", "chip changes don't re-flip past a session choice");
  assert.equal(resolveView([multiEnt()], false), "grid", "the base (grid) is restored after the session");

  // Outside a session the toggle IS the persisted preference.
  toggleView();
  assert.equal(state.view, "rows");
  assert.equal(globalThis.localStorage.getItem("boardView:b5"), "rows");
  state.view = null;
  saveView();
});
