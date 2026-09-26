// The rail's chip counts and the filtered list, cached
// (planning/ui-updates-plan.md, Stage 3): worked out again only when something
// they read has changed, not on every repaint. The items change in place, so
// every writer announces with itemsChanged(), and the selection is replaced,
// never edited. A writer that forgot would leave the rail's numbers wrong
// without a sound. So each writer whose change can reach the page is driven
// here through its own code path, and checkCached() compares the cached
// values with a fresh count afterwards. It's the same check the browser tests
// run on every repaint, and three tests at the end are the check itself
// failing: a net nobody has seen catch anything proves nothing.
//
// Real index.html in jsdom, real modules, real clicks where a writer sits
// behind a control, and a route-keyed fetch stub, the crate-pop.test.js way.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { window } from "./jsdom-stub.js";

// jsdom reports an exception inside an event listener as a window "error"
// event, not to the dispatcher: collected, so a crash in a click handler
// fails the test instead of passing silently past it.
const listenerErrors = [];
window.addEventListener("error", (e) => listenerErrors.push(e.error ?? e.message));

// "METHOD /path" -> response body (or a function returning one).
const routes = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const key = `${opts.method || "GET"} ${url}`;
  if (!routes.has(key)) throw new Error(`unstubbed fetch: ${key}`);
  const h = routes.get(key);
  return { ok: true, status: 200, json: async () => (typeof h === "function" ? h() : h) };
};

const { state } = await import("../public/state.js");
const { toItem } = await import("../public/utils.js");
const { selEntry } = await import("../public/facet-match.js");
const { taggedFiltered, favoritesInContext, checkCached, toggle, toggleNeg } = await import("../public/filters.js");
const { reconcile, applyRoutedEntities, drainItems, refreshItemsOnce } = await import("../public/data.js");
const { mergeUploadedRows } = await import("../public/upload.js");
const { toggleClusters, stepClusters } = await import("../public/patterns.js");
const { openCratePop, closeCratePop } = await import("../public/crates.js");
const { renderGrid } = await import("../public/grid.js");
const { initLightbox, openLightbox, closeLightbox } = await import("../public/lightbox.js");
const { renderRows } = await import("../public/rows.js");
const { openTagEditor } = await import("../public/tag-editor.js");
const { openConnectorBrowse } = await import("../public/connector-browse.js");
const { updateBulkBar } = await import("../public/bulk.js");
initLightbox();

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const row = (id, tags, extra = {}) => ({ id, name: `f${id}.png`, status: "tagged", tags, ...extra });
const ids = () => taggedFiltered().map((i) => i.id);
// An item with two files: 101 tagged red, 102 tagged blue.
const twoFiles = () => toItem(row(1, ["color/red", "color/blue"], {
  instances: [
    { id: 101, name: "a.png", status: "tagged", tags: ["color/red"], w: 4, h: 3 },
    { id: 102, name: "b.png", status: "tagged", tags: ["color/blue"], w: 4, h: 3 },
  ],
}));

beforeEach(() => {
  routes.clear();
  listenerErrors.length = 0;
  Object.assign(state, {
    me: { id: 1, name: "tester" },
    boardId: "b1",
    facets: [{ key: "color", label: "Color", values: ["red", "blue"] }],
    items: [row(1, ["color/red"]), row(2, ["color/blue"]), row(3, ["color/red"])].map(toItem),
    selected: new Map(),
    showFavorites: false, showUntagged: false, showProcessing: false, showUnprocessed: false,
    selectedCrateId: null, searchResults: null, alertEvent: null, sort: null,
    showClusters: 0, showMeaningClusters: 0,
    crates: [],
  });
  checkCached(); // reads, and so caches, all three: each test starts from a cache
});

test("a quiet poll tick leaves the cached list as it was: nothing is counted again", async () => {
  // The real tick, not reconcile() alone: refreshItemsOnce also stores a new
  // cursor and a new work object every time, and refreshTokens beside it
  // (data.js pollTick, not exported) writes the board's totals. None of them
  // may reach the cache.
  state.itemsSince = 100;
  routes.set("GET /api/items?board=b1&since=100", { items: [], ids: [1, 2, 3], now: 101, work: { running: [], queued: [] } });
  const list = taggedFiltered();
  await refreshItemsOnce();
  Object.assign(state, { boardUnits: { tokens: 5 }, boardUnitDefs: [], boardCost: null }); // refreshTokens's three
  assert.equal(state.itemsSince, 101, "setup: the tick ran");
  assert.equal(taggedFiltered(), list, "the same list, not a recount");
  checkCached();
});

test("a poll that brings an item: it joins the list and the counts", () => {
  reconcile([row(4, ["color/blue"])], new Set([1, 2, 3, 4]));
  assert.deepEqual(ids(), [4, 1, 2, 3]);
  checkCached();
});

test("a poll that retags an item: the counts follow", () => {
  toggle("color", "red");
  assert.deepEqual(ids(), [1, 3], "setup: filtering to red");
  reconcile([row(1, ["color/blue"])], new Set([1, 2, 3]));
  assert.deepEqual(ids(), [3], "the retagged item leaves the red list");
  checkCached();
});

test("the requeue mirror sends an untagged item back into the queue: it leaves the list", () => {
  state.items = [...state.items, toItem(row(5, []))];
  assert.ok(ids().includes(5), "setup: a finished item with no tags is in the list");
  applyRoutedEntities([{ id: 5, status: "pending", instances: [] }]);
  assert.ok(!ids().includes(5), "back in the queue, it waits in the lane instead");
  checkCached();
});

test("an upload's rows join the counts", () => {
  mergeUploadedRows([row(6, [], { status: "pending" })]);
  assert.ok(state.items.some((i) => i.id === 6), "setup: the row is on the board");
  checkCached();
});

test("the background drain's next page joins the list", async () => {
  routes.set("GET /api/items?board=b1&limit=500&after=c1", { items: [row(7, ["color/red"])], nextCursor: null });
  await drainItems("c1");
  assert.deepEqual(ids(), [1, 2, 3, 7]);
  checkCached();
});

test("a chip turned on, then excluded: the counts and the list follow, on a new selection each time", () => {
  const was = state.selected;
  toggle("color", "red");
  assert.notEqual(state.selected, was, "a new map, not the old one edited");
  assert.deepEqual(ids(), [1, 3]);
  checkCached();
  toggleNeg("color", "red");
  assert.deepEqual(ids(), [2], "red now excluded");
  checkCached();
});

test("the clusters lens turned off with a cluster chip on: the chip leaves the selection", () => {
  Object.assign(state, { showClusters: 1, selected: new Map([["~clusters", selEntry(["c0"])]]) });
  assert.deepEqual(ids(), [], "setup: a cluster chip with no grouping matches nothing");
  toggleClusters(false);
  assert.equal(state.selected.has("~clusters"), false);
  assert.deepEqual(ids(), [1, 2, 3]);
  checkCached();
});

test("a step to more groups with a cluster chip on: the chip leaves the selection", () => {
  Object.assign(state, { showClusters: 2, selected: new Map([["~clusters", selEntry(["c0"])]]) });
  assert.deepEqual(ids(), [], "setup: nothing matches the chip");
  stepClusters(1);
  assert.equal(state.selected.has("~clusters"), false);
  assert.deepEqual(ids(), [1, 2, 3]);
  checkCached();
  toggleClusters(false);
});

test("unticking an item's crate while filtering by that crate: it leaves the list", async () => {
  state.crates = [{ id: 5, name: "picks", owned: true, public: false, item_count: 2 }];
  state.items = [row(1, ["color/red"], { crateIds: [5] }), row(2, ["color/blue"], { crateIds: [5] }), row(3, ["color/red"])].map(toItem);
  state.selectedCrateId = 5;
  assert.deepEqual(ids(), [1, 2], "setup: the crate's two items");
  routes.set("POST /api/crates/5/items/1", { added: false, count: 1 });
  // A stand-in card with a button in it, outside #grid: Preact draws that
  // container since Stage 4, and would sweep a foreign element away.
  const card = document.createElement("div");
  card.className = "card";
  const btn = document.createElement("button");
  card.appendChild(btn);
  document.body.appendChild(card);
  try {
    openCratePop(btn, state.items[0]);
    document.querySelector(".crate-pop .dd-row").click();
    await settle();
    assert.deepEqual(ids(), [2]);
    checkCached();
    assert.deepEqual(listenerErrors, []);
  } finally {
    closeCratePop();
    card.remove();
  }
});

test("a heart on a card: the favorites count follows, over the filtered list", async () => {
  routes.set("POST /api/items/1/favorite", { favorited: true, count: 1 });
  assert.equal(favoritesInContext(), 0, "setup: no favorites");
  renderGrid("cached-counts|grid", [], state.items); // the grid draws the cards (Stage 4)
  const card = document.querySelector('#grid .card[data-id="1"]');
  try {
    card.dispatchEvent(new window.Event("pointerenter"));
    await settle(); // a card's hover is state, drawn a tick later (Stage 4)
    card.querySelector(".heart").click();
    await settle();
    assert.equal(state.items[0].favoritedByMe, true, "setup: the heart landed");
    assert.equal(favoritesInContext(), 1);
    checkCached();
    toggle("color", "blue");
    assert.equal(favoritesInContext(), 0, "the red card is out of the blue list, and so is its heart");
    checkCached();
    assert.deepEqual(listenerErrors, []);
  } finally {
    renderGrid("cached-counts|grid", [], []);
  }
});

test("a heart in the lightbox: the favorites count follows", async () => {
  routes.set("POST /api/items/1/favorite", { favorited: true, count: 1 });
  openLightbox(state.items[0]);
  try {
    document.getElementById("lightbox-fav").click();
    await settle();
    assert.equal(state.items[0].favoritedByMe, true, "setup: the heart landed");
    assert.equal(favoritesInContext(), 1);
    checkCached();
    assert.deepEqual(listenerErrors, []);
  } finally {
    closeLightbox();
  }
});

test("removing a file in the lightbox: its tags leave the counts", async () => {
  state.items = [twoFiles(), toItem(row(2, ["color/blue"])), toItem(row(3, ["color/red"]))];
  toggle("color", "blue");
  assert.deepEqual(ids(), [1, 2], "setup: the two-file item is blue through its second file");
  routes.set("GET /api/instances/101/reasoning", { reasoning: {}, fields: {}, confidence: {} });
  routes.set("DELETE /api/instances/102", {});
  localStorage.setItem("lbPanelPin:b1", "1"); // the Details panel opens with the lightbox
  try {
    openLightbox(state.items[0]);
    await settle();
    const removes = document.querySelectorAll("#lightbox-panel .lbp-file-remove");
    assert.equal(removes.length, 2, "setup: the panel lists both files");
    removes[1].click();
    await settle();
    assert.deepEqual(ids(), [2], "its only blue file gone, the item leaves the blue list");
    checkCached();
    assert.deepEqual(listenerErrors, []);
  } finally {
    closeLightbox();
    localStorage.removeItem("lbPanelPin:b1");
  }
});

test("removing a file in the rows view: its tags leave the counts", async () => {
  state.items = [twoFiles(), toItem(row(2, ["color/blue"])), toItem(row(3, ["color/red"]))];
  toggle("color", "blue");
  assert.deepEqual(ids(), [1, 2], "setup: the two-file item is blue through its second file");
  routes.set("DELETE /api/instances/102", {});
  renderRows("cached-counts|rows", [], taggedFiltered());
  try {
    const tile = document.querySelector('#grid .inst-tile[data-inst-id="102"]');
    tile.dispatchEvent(new window.Event("pointerenter")); // a tile's buttons come with the hover
    await settle(); // drawn a tick later (Stage 4)
    const remove = tile.querySelector(".act.delete");
    assert.ok(remove, "setup: the file's tile carries a remove button");
    remove.click();
    await settle();
    assert.deepEqual(ids(), [2]);
    checkCached();
    assert.deepEqual(listenerErrors, []);
  } finally {
    renderRows("cached-counts|rows", [], []);
  }
});

test("a tag edit: the counts follow", async () => {
  state.items = [twoFiles(), toItem(row(2, ["color/blue"])), toItem(row(3, ["color/red"]))];
  toggle("color", "red");
  assert.deepEqual(ids(), [1, 3], "setup: the two-file item is red through its first file");
  routes.set("PATCH /api/instances/101/tags", {
    tags: [],
    entities: [{ id: 1, status: "tagged", instances: [{ id: 101, status: "tagged" }, { id: 102, status: "tagged" }] }],
  });
  openTagEditor(state.items[0], state.items[0].instances[0]);
  const red = [...document.querySelectorAll(".te-val")].find((l) => l.textContent === "red").querySelector("input");
  assert.equal(red.checked, true, "setup: the file is tagged red");
  red.click(); // untick
  await settle();
  document.querySelector(".te-save").click();
  await settle();
  assert.deepEqual(ids(), [3], "the file's red is gone, and with it the item's");
  checkCached();
  assert.deepEqual(listenerErrors, []);
});

test("adding a row from a connector's browser: it joins the list", async () => {
  routes.set("GET /api/connectors", [{
    name: "stocks", label: "Stocks",
    browse: { columns: [{ key: "name", label: "Name", kind: "text", primary: true }], sorts: [{ key: "name", label: "Name" }], defaultSort: "name" },
  }]);
  routes.set("GET /api/boards/b1/connector-list?sort=name&order=desc&page=1", { rows: [{ id: "AAPL", symbol: "AAPL", values: { name: "Apple" } }], hasMore: false });
  routes.set("GET /api/boards/b1/connector-filters", { filters: [] });
  // Arrives tagged: an item still in the queue would start the page's poll.
  routes.set("POST /api/boards/b1/entities/bulk", { added: [row(8, ["color/red"], { connector_id: "AAPL" })], skipped: [], work: { running: [], queued: [] } });
  const { close } = openConnectorBrowse("stocks");
  try {
    await settle();
    const add = document.querySelector(".cb-add");
    assert.ok(add, "setup: the listing drew its row");
    add.click();
    await settle();
    assert.ok(ids().includes(8));
    checkCached();
    assert.deepEqual(listenerErrors, []);
  } finally {
    close();
  }
});

test("the bulk bar adds the picked items to the crate being filtered by: each joins the list as its answer lands", async () => {
  // The selection is pruned against the board, not the filtered list, so
  // cards picked before a crate filter stay picked under it: that's how items
  // outside the crate get added to it while it's the filter (bulk.js
  // addAllToCrate). The second answer is held back, to read the list between
  // the two.
  state.crates = [{ id: 5, name: "picks", owned: true, public: false, item_count: 1 }];
  state.items = [row(1, ["color/red"], { crateIds: [5] }), row(2, ["color/blue"]), row(3, ["color/red"])].map(toItem);
  state.selectedCrateId = 5;
  state.bulkSelected = new Set([2, 3]);
  assert.deepEqual(ids(), [1], "setup: the crate's one item");
  routes.set("POST /api/crates/5/items/2", { added: true, count: 2 });
  let landThird;
  routes.set("POST /api/crates/5/items/3", () => new Promise((r) => { landThird = () => r({ added: true, count: 3 }); }));
  updateBulkBar();
  try {
    document.querySelector("#bulk-bar .bb-btn.crate").click();
    document.querySelector(".crate-pop .dd-row").click();
    await settle();
    assert.deepEqual(ids(), [1, 2], "the first answer is in, the second still in the air");
    checkCached();
    landThird();
    await settle();
    assert.deepEqual(ids(), [1, 2, 3]);
    checkCached();
    assert.deepEqual(listenerErrors, []);
  } finally {
    state.bulkSelected = new Set();
    updateBulkBar();
  }
});

// The check itself, failing: one test per comparison, each brought on by the
// kind of slip it exists to catch.
test("the check fails on a selection edited in place: the cached list is stale", () => {
  state.selected.set("color", selEntry(["blue"]));
  assert.throws(checkCached, /the cached filtered list differs/);
});

test("the check fails on a heart written without an announcement: the cached favorites count is stale", () => {
  state.items[0].favoritedByMe = true;
  assert.throws(checkCached, /the cached favorites count differs/);
});

test("the check fails on a retag written without an announcement: the cached chip counts are stale", () => {
  state.items[0].tags = ["color/blue"]; // the counts read item.tags
  assert.throws(checkCached, /the cached chip counts differ/);
});
