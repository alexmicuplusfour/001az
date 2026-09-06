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
const { refreshClusters, clusterValues, clusterSet, toggleClusters, saveClusters, restoreClusters, stepClusters, toggleMeaningClusters, restoreMeaningClusters, LEVEL_MAX } =
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
  state.showClusters = 0;
  restoreClusters();
  assert.equal(state.showClusters, 1);

  state.boardId = "b2";
  restoreClusters();
  assert.equal(state.showClusters, 0);
  state.boardId = "b1";
  state.showClusters = false;
  saveClusters();
  assert.equal(store.has("boardClusters:b1"), false);
});

test("clusters: 'more' buys centers — a carving too coarse at level 1 resolves at level 2", () => {
  // Ten blocks with nothing in common and only eight centers: the leftover
  // blocks land somewhere they can't win a majority, so level 1 shows fewer
  // than ten groups. Level 2 (K=12) has a center to spare for every block.
  state.items = [];
  for (let b = 0; b < 10; b++) {
    for (let i = 0; i < 12; i++) {
      state.items.push(item(b * 12 + i, [`f1/a${b}`, `f2/b${b}`, `f3/c${b}`]));
    }
  }
  state.showClusters = 1;
  refreshClusters();
  const coarse = clusterValues().filter((v) => v.value !== "unclassified");
  assert.ok(coarse.length <= 8, `at most k groups (got ${coarse.length})`);
  assert.ok(coarse.length < 10, "ten blocks cannot all have their own group at K=8");

  state.showClusters = 2;
  refreshClusters();
  const fine = clusterValues();
  assert.equal(fine.length, 10, "every block earns its own group, none unclassified");
  // same board, same level: still deterministic
  state.items = [...state.items].reverse();
  refreshClusters();
  assert.equal(clusterValues().length, 10);
});

test("clusters: a level change recomputes even while the board churns", () => {
  // The stale-serve gate holds WITHIN a level; a step is the viewer asking
  // for a different carving right now.
  state.showClusters = 1;
  state.items = seedBlocks();
  refreshClusters();
  const before = clusterValues().length;
  state.items.push(item(900, [], "processing"));
  state.showClusters = 2;
  refreshClusters();
  assert.ok(clusterValues().length >= before, "recomputed at the new level, not served stale");
});

test("stepClusters: clamps to [1, LEVEL_MAX], clears only the lens's selection, persists the level", () => {
  store.clear();
  state.boardId = "b1";
  state.items = seedBlocks();
  state.showClusters = 1;
  state.selected = new Map([["~clusters", new Set(["c0"])], ["color", new Set(["red"])]]);
  stepClusters(1);
  assert.equal(state.showClusters, 2);
  assert.equal(state.selected.has("~clusters"), false, "old group names no longer name those groups");
  assert.ok(state.selected.has("color"), "real facets untouched");
  assert.equal(store.get("boardClusters:b1"), "2", "the level IS the stored lens value");

  for (let i = 0; i < 10; i++) stepClusters(1);
  assert.equal(state.showClusters, LEVEL_MAX, "clamped high");
  for (let i = 0; i < 10; i++) stepClusters(-1);
  assert.equal(state.showClusters, 1, "clamped low — stepping down never turns the lens off");

  state.showClusters = 0;
  stepClusters(1);
  assert.equal(state.showClusters, 0, "no stepping while the lens is off");

  // a stored level round-trips
  state.showClusters = 3;
  saveClusters();
  state.showClusters = 0;
  restoreClusters();
  assert.equal(state.showClusters, 3);
});

test("the two cluster flavors are mutually exclusive, in state and in storage", () => {
  store.clear();
  state.boardId = "b1";
  state.selected = new Map([["~clusters", new Set(["c0"])], ["color", new Set(["red"])]]);
  toggleClusters(true);
  toggleMeaningClusters(true); // flips tags OFF, itself ON
  assert.equal(state.showClusters, 0);
  assert.equal(state.showMeaningClusters, 1);
  assert.equal(store.has("boardClusters:b1"), false, "the losing flavor's storage clears too");
  assert.equal(store.get("boardClustersM:b1"), "1");
  assert.equal(state.selected.has("~clusters"), false, "the other carving's values can't match");
  assert.ok(state.selected.has("color"), "real facets untouched");

  toggleClusters(true); // and back the other way
  assert.equal(state.showMeaningClusters, 0);
  assert.equal(state.showClusters, 1);
  assert.equal(store.has("boardClustersM:b1"), false);

  // a restore where both somehow stored a level (two tabs): meaning wins
  store.set("boardClusters:b1", "2");
  store.set("boardClustersM:b1", "3");
  restoreClusters();
  restoreMeaningClusters();
  assert.equal(state.showMeaningClusters, 3);
  assert.equal(state.showClusters, 0);

  // stepping steps the ACTIVE flavor
  state.selected = new Map();
  stepClusters(-1);
  assert.equal(state.showMeaningClusters, 2);
  assert.equal(store.get("boardClustersM:b1"), "2");

  toggleMeaningClusters(false);
  state.showClusters = 0;
});
