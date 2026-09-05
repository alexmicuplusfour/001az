// The clusters lens (planning/pattern-surfaces-plan.md, stage 3), the pure
// pieces: the deterministic partition, the floors that decide what is SHOWN,
// the tags-reference cache with its in-flight gate, and the per-board
// persistence. The board-sort pattern — shared browser stub, then dynamic
// import of the public modules.
import { localStore as store } from "./browser-stub.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { state } = await import("../public/state.js");
const { toItem } = await import("../public/utils.js");
const { refreshClusters, clusterValues, clusterSet, toggleClusters, saveClusters, restoreClusters } =
  await import("../public/patterns.js");

const item = (id, tags, status = "tagged") => toItem({ id, name: `${id}.webp`, status, tags });
const valueOf = (id) => clusterSet({ id })?.values().next().value;

// Two blocks with nothing in common: the partition every method must find.
function seedBlocks() {
  const items = [];
  for (let i = 0; i < 30; i++) items.push(item(i, ["f1/ra", "f2/rb", "f3/rc"]));
  for (let i = 30; i < 60; i++) items.push(item(i, ["f1/sa", "f2/sb", "f3/sc"]));
  return items;
}

test("clusters: two clean blocks come out as two clusters wearing their signatures", () => {
  state.showClusters = true;
  state.items = seedBlocks();
  refreshClusters();
  const values = clusterValues();
  assert.equal(values.length, 2, "two real groups, no unclassified");
  // every A member shares a value, every B member the other
  const a = valueOf(0), b = valueOf(30);
  assert.ok(a && b && a !== b);
  for (let i = 0; i < 30; i++) assert.equal(valueOf(i), a);
  for (let i = 30; i < 60; i++) assert.equal(valueOf(i), b);
  // the label IS the signature — the group's own majority chips
  const labels = values.map((v) => v.label.split(" · ").sort().join(","));
  assert.ok(labels.includes("ra,rb,rc"), labels.join(" | "));
  assert.ok(labels.includes("sa,sb,sc"));
  assert.match(values[0].title, /^most typical: /);
});

test("clusters: the partition does not depend on arrival order", () => {
  // state.items grows by unshift/push, so an order-seeded partition would
  // re-shuffle under the viewer. Same board reversed must give the same
  // groups — this is the requirement the data-derived seeding exists for.
  state.showClusters = true;
  state.items = seedBlocks();
  refreshClusters();
  const before = state.items.map((it) => [it.id, valueOf(it.id)]);
  state.items = [...state.items].reverse();
  refreshClusters();
  for (const [id, v] of before) assert.equal(valueOf(id), v, `item ${id}`);
});

test("clusters: a stray handful fails the floor and lands in unclassified", () => {
  state.showClusters = true;
  state.items = seedBlocks();
  for (let i = 60; i < 65; i++) state.items.push(item(i, ["f1/ta", "f2/tb", "f3/tc"]));
  refreshClusters();
  const values = clusterValues();
  assert.equal(values.length, 3);
  assert.equal(values.at(-1).value, "unclassified", "unclassified renders last");
  for (let i = 60; i < 65; i++) assert.equal(valueOf(i), "unclassified");
});

test("clusters: too few tags means absent, not unclassified", () => {
  // Rule 5 of the plan: unset is absence. An item with 1-2 chips has too
  // little signal to place — it gets NO value, unlike a placed-and-rejected
  // participant.
  state.showClusters = true;
  state.items = seedBlocks();
  state.items.push(item(60, ["f1/ra"]));
  refreshClusters();
  assert.equal(clusterSet({ id: 60 }), undefined);
});

test("clusters: a board too small to partition shows nothing", () => {
  state.showClusters = true;
  state.items = [];
  for (let i = 0; i < 10; i++) state.items.push(item(i, ["f1/ra", "f2/rb", "f3/rc"]));
  refreshClusters();
  assert.equal(clusterValues().length, 0);
});

test("clusters cache: unchanged tag references serve the same result", () => {
  state.showClusters = true;
  state.items = seedBlocks();
  refreshClusters();
  const before = clusterSet({ id: 0 });
  refreshClusters(); // nothing changed — must be a no-op, not a recompute
  assert.equal(clusterSet({ id: 0 }), before, "same Set object = cache hit");
});

test("clusters cache: a replaced tags array recomputes, and membership follows", () => {
  state.showClusters = true;
  state.items = seedBlocks();
  refreshClusters();
  const a = valueOf(0), b = valueOf(30);
  // every writer replaces the array (data.js reconcile, tag-editor.js,
  // refreshEntityTags) — this is that signal, moving item 0 across blocks
  state.items[0].tags = ["f1/sa", "f2/sb", "f3/sc"];
  refreshClusters();
  assert.equal(valueOf(0), b, "moved item re-clusters with its new block");
  assert.equal(valueOf(1), a, "the rest stay put");
});

test("clusters cache: mid-churn serves the stale partition until the board settles", () => {
  state.showClusters = true;
  state.items = seedBlocks();
  refreshClusters();
  const a = valueOf(0);
  state.items[0].tags = ["f1/sa", "f2/sb", "f3/sc"];
  state.items[5].status = "processing"; // board still moving
  refreshClusters();
  assert.equal(valueOf(0), a, "stale partition while in flight");
  state.items[5].status = "tagged";
  refreshClusters();
  assert.notEqual(valueOf(0), a, "settled board recomputes");
});

test("clusters: toggling off clears the lens's own selection", () => {
  // A ~clusters selection can only match while the lens computes — left
  // behind it would filter the board to nothing.
  store.clear();
  state.boardId = "b1";
  state.selected = new Map([["~clusters", new Set(["c0"])], ["color", new Set(["red"])]]);
  toggleClusters(false);
  assert.equal(state.selected.has("~clusters"), false);
  assert.ok(state.selected.has("color"), "other selections untouched");
  assert.equal(store.has("boardClusters:b1"), false);

  toggleClusters(true);
  assert.equal(store.get("boardClusters:b1"), "1");
  state.showClusters = false;
  restoreClusters();
  assert.equal(state.showClusters, true);

  state.boardId = "b2";
  restoreClusters();
  assert.equal(state.showClusters, false);
  state.boardId = "b1";
  state.showClusters = false;
  saveClusters();
  assert.equal(store.has("boardClusters:b1"), false);
});
