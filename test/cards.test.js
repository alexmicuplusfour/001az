// Cards, rows and tiles as components (planning/ui-updates-plan.md, Stage 4):
// a card draws from the props the grid hands it, redraws in place when one of
// them changed and not otherwise, keeps its chrome while a menu is pinned on
// it, reads the bulk selection from a whole-value write, and draws nothing,
// once, when its picture fails. Real index.html in jsdom, real modules, real
// events, the cached-counts.test.js way. What app.js's effect would do on a
// write — draw the grid again — the tests do by hand, since app.js isn't
// loaded here. A card's own state (hover, a pin, a broken picture)
// lands a tick later: Preact batches state changes, where the old builder
// appended chrome on the spot.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { window, intersect } from "./jsdom-stub.js";
import { until } from "./helpers.js";

// The page's stylesheet, which the stub doesn't load: bulk mode hides the
// cards' chrome through it (body.bulk-mode), and a test reads that.
const sheet = document.createElement("style");
sheet.textContent = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
document.head.appendChild(sheet);

const listenerErrors = [];
window.addEventListener("error", (e) => listenerErrors.push(e.error ?? e.message));

const routes = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const key = `${opts.method || "GET"} ${url}`;
  if (!routes.has(key)) throw new Error(`unstubbed fetch: ${key}`);
  const h = routes.get(key);
  return { ok: true, status: 200, json: async () => (typeof h === "function" ? h() : h) };
};

const { state } = await import("../public/state.js");
const { itemsChanged } = await import("../public/state-signals.js");
const { toItem } = await import("../public/utils.js");
const { renderGrid, pinWhileOpen, Card, visibleGridItems } = await import("../public/grid.js");
const { setSort, nextSort } = await import("../public/sort.js");
const { showItem } = await import("../public/batches.js");
const { renderRows } = await import("../public/rows.js");
const { renderList } = await import("../public/list.js");
const { toggleBulkSelect, clearBulk, selectAllVisible } = await import("../public/bulk.js");
const { toggle, filterKey, taggedFiltered } = await import("../public/filters.js");
const { applyRoutedEntities } = await import("../public/data.js");

const grid = document.getElementById("grid");
const tick = () => new Promise((r) => setTimeout(r, 0));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const settle = async () => { for (let i = 0; i < 3; i++) await tick(); };
const row = (id, tags, extra = {}) => ({ id, name: `f${id}.png`, status: "tagged", tags, w: 4, h: 3, ...extra });
const draw = (items = state.items, progress = []) => renderGrid("cards|grid", progress, items);
const card = (id) => grid.querySelector(`.card[data-id="${id}"]`);
// What #grid holds: the rows, the settled cards drawn straight into it, and
// List's rows.
const shows = () => ({
  rows: grid.querySelectorAll(":scope > .entity-row").length,
  cards: grid.querySelectorAll(":scope > .card[data-id]").length,
  list: grid.querySelectorAll("tr.list-row[data-id]").length,
});
// A board longer than either view's first batch (the grid draws 60, rows 30).
// Returns the filtered list the way render() passes it: the cached one.
const longBoard = () => {
  state.items = Array.from({ length: 70 }, (_, i) => toItem(row(i + 1, ["color/red"])));
  return taggedFiltered();
};
const enter =async (el) => { el.dispatchEvent(new window.Event("pointerenter")); await tick(); };
const leave = async (el) => { el.dispatchEvent(new window.Event("pointerleave")); await tick(); };
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
    items: [row(1, ["color/red"]), row(2, ["color/blue"]), row(3, [])].map(toItem),
    selected: new Map(),
    showFavorites: false, showUntagged: false, showProcessing: false, showUnprocessed: false,
    selectedCrateId: null, searchResults: null, alertEvent: null, sort: null,
    bulkSelected: new Set(),
    boardMapping: null,
    crates: [],
    uploading: [],
  });
  // Each test starts from freshly mounted cards: a card keyed by the same
  // item id would otherwise carry the last test's state (a broken picture).
  renderGrid("cards|reset", [], []);
  draw();
});

test("a card draws its item: the picture and its size, the select button, and no chrome until the pointer arrives", () => {
  const c = card(1);
  assert.ok(c, "the grid drew the card");
  const img = c.querySelector(".face-media img");
  assert.equal(img.getAttribute("src"), "thumbnails/f1.png.webp");
  assert.equal(img.getAttribute("width"), "4");
  assert.equal(c.dataset.ratio, String(4 / 3), "the masonry gets the ratio instead of measuring");
  assert.equal(c.querySelector(".sel-cb").getAttribute("aria-pressed"), "false");
  assert.equal(c.querySelector(".card-actions"), null);
  assert.equal(c.querySelector(".tag-chip"), null);
  assert.equal(c.querySelector(".heart"), null, "no heart until it has one, or the pointer");
  assert.equal(c.classList.contains("undecided"), false);
  assert.equal(card(3).classList.contains("undecided"), true, "an item with no tags on a board with a taxonomy needs attention");
  assert.deepEqual(listenerErrors, []);
});

test("an item still in flight draws with its spinner", () => {
  state.items = [toItem(row(4, [], { status: "pending" }))];
  draw();
  const c = card(4);
  assert.ok(c.classList.contains("loading"));
  assert.ok(c.querySelector(".spinner"));
});

test("the pointer over a card brings its chrome, and takes it away", async () => {
  const c = card(1);
  await enter(c);
  assert.ok(c.querySelector(".card-actions .act.delete"), "the actions");
  assert.equal(c.querySelector(".tag-chip .tc").textContent, "1", "the tag chip, with the count");
  assert.ok(c.querySelector(".heart"), "the heart");
  await leave(c);
  assert.equal(c.querySelector(".card-actions"), null);
  assert.equal(c.querySelector(".tag-chip"), null);
  assert.equal(c.querySelector(".heart"), null);
  assert.deepEqual(listenerErrors, []);
});

test("a repaint that changed nothing redraws no card; one that changed an item redraws that card, in place", () => {
  const drawn = [];
  const original = Card.prototype.render;
  Card.prototype.render = function (p, s) { drawn.push(p.id); return original.call(this, p, s); };
  try {
    const before = [...grid.querySelectorAll(".card[data-id]")];
    draw();
    assert.deepEqual(drawn, [], "nothing changed, nothing drawn");
    assert.deepEqual([...grid.querySelectorAll(".card[data-id]")], before, "the same elements");
    state.items[0].hearts = 2;
    state.items[0].favoritedByMe = true;
    itemsChanged(); // as every writer does (Stage 3)
    draw();
    assert.deepEqual(drawn, [1], "only the card whose item changed");
    assert.equal(card(1), before[0], "and in place");
    assert.equal(card(1).querySelector(".heart.on .hc").textContent, "2");
  } finally {
    Card.prototype.render = original;
  }
});

test("a heart click: the card redraws in place with its new count, and keeps its chrome", async () => {
  routes.set("POST /api/items/1/favorite", { favorited: true, count: 1 });
  const c = card(1);
  await enter(c);
  c.querySelector(".heart").click();
  await settle();
  assert.equal(state.items[0].favoritedByMe, true, "setup: the heart landed");
  draw(); // what app.js's effect does on the heart's write
  assert.equal(card(1), c, "the same element");
  assert.ok(c.querySelector(".heart.on"), "and it's on");
  assert.equal(c.querySelector(".heart .hc").textContent, "1");
  assert.ok(c.querySelector(".card-actions"), "the pointer never left, so the buttons stayed");
  assert.deepEqual(listenerErrors, []);
});

test("a menu pinned on a card keeps its chrome after the pointer leaves, and drops it when released", async () => {
  // jsdom answers :hover for the last element clicked and its ancestors, and
  // the release below asks the card that question: put the last click
  // somewhere else.
  document.body.click();
  const c = card(1);
  await enter(c);
  const pin = pinWhileOpen(c.querySelector(".act.crate"));
  assert.equal(pin.el, c, "the pin found its card from the button");
  pin.hold({});
  await leave(c);
  assert.ok(c.classList.contains("pop-open"));
  assert.ok(c.querySelector(".card-actions"), "the chrome stays while the menu is up");
  pin.release("keep-card");
  await tick();
  assert.ok(c.querySelector(".card-actions"), "a hand-off to another menu keeps it too");
  pin.release("manual");
  await tick();
  assert.equal(c.classList.contains("pop-open"), false);
  assert.equal(c.querySelector(".card-actions"), null, "the menu closed with the pointer elsewhere: the chrome goes");
});

test("bulk selection is a whole-value write: the card it selects redraws, and no other; the stylesheet hides the chrome", async () => {
  const drawn = [];
  const original = Card.prototype.render;
  Card.prototype.render = function (p, s) { drawn.push(p.id); return original.call(this, p, s); };
  try {
    const before = state.bulkSelected;
    toggleBulkSelect(state.items[0]);
    assert.notEqual(state.bulkSelected, before, "a new set, not the old one edited");
    assert.ok(state.bulkSelected.has(1));
    draw(); // the repaint toggleBulkSelect asked for
    // Bulk mode on is the body's class, not a prop on every card: as a prop it
    // redrew every mounted card on the first selection and the last.
    assert.deepEqual(drawn, [1], "turning bulk mode on redraws the card it selected, and no other");
  } finally {
    Card.prototype.render = original;
  }
  assert.ok(card(1).classList.contains("selected"));
  assert.equal(card(1).querySelector(".sel-cb").getAttribute("aria-pressed"), "true");
  await enter(card(2));
  const actions = card(2).querySelector(".card-actions");
  assert.equal(getComputedStyle(actions).display, "none", "in bulk mode the stylesheet hides the chrome");
  selectAllVisible(state.items);
  assert.equal(state.bulkSelected.size, 3);
  clearBulk();
  draw();
  assert.equal(state.bulkSelected.size, 0);
  assert.equal(grid.querySelector(".card.selected"), null);
  assert.equal(getComputedStyle(actions).display, "flex", "and shows it again after");
  assert.deepEqual(listenerErrors, []);
});

// A Shift-click picks a range (planning/list-view-plan.md, Stage 4): every
// item drawn from the last pick to this one, in the page's order.
const shiftClick = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
// The ids drawn from one to the other, as the page orders them.
const span = (a, b) => {
  const ids = visibleGridItems().map((i) => i.id);
  const [from, to] = [ids.indexOf(a), ids.indexOf(b)].sort((x, y) => x - y);
  return ids.slice(from, to + 1).sort((x, y) => x - y);
};
const picked = () => [...state.bulkSelected].sort((x, y) => x - y);

test("a Shift-click in the grid picks every card drawn from the last pick to it, on a select button or, in bulk mode, a card", () => {
  const items = longBoard();
  try {
    renderGrid(`${filterKey()}|grid`, [], items);
    card(3).querySelector(".sel-cb").click();
    assert.deepEqual(picked(), [3], "setup: one picked");
    shiftClick(card(7).querySelector(".sel-cb"));
    assert.deepEqual(picked(), span(3, 7), "the select button: the range to it");
    draw(items);
    shiftClick(card(12));
    assert.deepEqual(picked(), span(3, 12), "a card in bulk mode: the range on from the last pick");
    card(20).click();
    assert.deepEqual(picked(), [...span(3, 12), 20], "a plain click still picks one");
    shiftClick(card(18));
    assert.deepEqual(picked(), [...span(3, 12), ...span(18, 20)], "and a range runs back up the page as well as down");
    assert.deepEqual(listenerErrors, []);
  } finally {
    clearBulk();
    renderGrid("range|grid", [], []);
  }
});

test("a Shift-click in List and in the rows view picks a range too: a List row's select button or the row, a rows card or tile", () => {
  const items = longBoard();
  state.view = "list";
  try {
    renderList(`${filterKey()}|list`, [], items);
    lrow(5).querySelector(".sel-cb").click();
    shiftClick(lrow(9).querySelector(".sel-cb"));
    assert.deepEqual(picked(), span(5, 9), "List: the select button");
    renderList(`${filterKey()}|list`, [], items);
    shiftClick(lrow(14).querySelector(".list-open"));
    assert.deepEqual(picked(), span(5, 14), "List: the row's name, in bulk mode");
    clearBulk();
    state.view = "rows";
    // Item 6 with two files, so its row has a strip of tiles.
    const file = (id) => ({ id, name: `${id}.png`, status: "tagged", tags: ["color/red"], w: 4, h: 3 });
    state.items = state.items.map((i) => (i.id === 6 ? toItem(row(6, ["color/red"], { instances: [file(601), file(602)] })) : i));
    renderRows(`${filterKey()}|rows`, [], taggedFiltered());
    const rowCard = (id) => grid.querySelector(`.entity-row .card[data-id="${id}"]`);
    rowCard(2).querySelector(".sel-cb").click();
    shiftClick(rowCard(4));
    assert.deepEqual(picked(), span(2, 4), "rows: a card in bulk mode");
    shiftClick(grid.querySelector(`.entity-row[data-eid="6"] .inst-tile`));
    assert.deepEqual(picked(), span(2, 6), "rows: a tile stands for its card");
    assert.deepEqual(listenerErrors, []);
  } finally {
    clearBulk();
    state.view = null;
    renderRows("range|rows", [], []);
  }
});

test("a Shift-click with nothing to run from picks one: nothing picked yet, or the last pick no longer drawn", () => {
  draw();
  card(1).querySelector(".sel-cb").click();
  clearBulk();
  shiftClick(card(3).querySelector(".sel-cb"));
  assert.deepEqual(picked(), [3], "nothing picked since the selection was cleared");
  clearBulk();
  card(1).querySelector(".sel-cb").click();
  state.items = state.items.filter((i) => i.id !== 1); // gone, deleted elsewhere
  draw();
  shiftClick(card(3).querySelector(".sel-cb"));
  assert.ok(state.bulkSelected.has(3) && !state.bulkSelected.has(2), "the last pick isn't drawn: this one alone");
  clearBulk();
  assert.deepEqual(listenerErrors, []);
});

test("a picture that fails to load: the card draws nothing, and stays gone on the next repaint", async () => {
  const img = card(2).querySelector("img");
  img.dispatchEvent(new window.Event("error"));
  await tick();
  assert.equal(card(2), null, "gone");
  assert.equal(grid.querySelectorAll(".card[data-id]").length, 2);
  draw();
  assert.equal(card(2), null, "not asked for again");
  assert.equal(grid.querySelectorAll('img[src="thumbnails/f2.png.webp"]').length, 0);
  assert.deepEqual(listenerErrors, []);
});

test("a new picture starts over: a loaded card shimmers until it loads, and a broken one comes back", async () => {
  // The item's face moved to another file, or a chart was drawn again under
  // a new name (the old file deleted): the name changes, the card stays.
  card(1).querySelector("img").dispatchEvent(new window.Event("load"));
  await tick();
  assert.ok(card(1).classList.contains("loaded"), "setup: the first picture loaded");
  card(2).querySelector("img").dispatchEvent(new window.Event("error"));
  await tick();
  assert.equal(card(2), null, "setup: the second one failed");
  const kept = card(1);
  state.items[0].name = "f1b.png";
  state.items[1].name = "f2b.png";
  itemsChanged();
  draw();
  assert.equal(card(1), kept, "the same card");
  assert.equal(card(1).classList.contains("loaded"), false, "not loaded: the shimmer, not a blank face");
  assert.equal(card(1).querySelector("img").classList.contains("loaded"), false, "its picture fades in when it lands");
  assert.equal(card(2)?.querySelector("img").getAttribute("src"), "thumbnails/f2b.png.webp", "the broken card is back, with the new picture");
  card(1).querySelector("img").dispatchEvent(new window.Event("load"));
  await tick();
  assert.ok(card(1).classList.contains("loaded"));
  assert.deepEqual(listenerErrors, []);
});

test("a document's new picture fades in afresh too", async () => {
  state.items = [toItem(row(7, ["color/red"], { name: "p1.pdf", kind: "doc", w: 4, h: 3 }))];
  draw();
  const img = () => card(7).querySelector(".doc-preview img");
  img().dispatchEvent(new window.Event("load"));
  await tick();
  assert.ok(img().classList.contains("loaded"), "setup: the first page loaded");
  state.items[0].name = "p2.pdf";
  itemsChanged();
  draw();
  assert.equal(img().getAttribute("src"), "thumbnails/p2.pdf.webp");
  assert.equal(img().classList.contains("loaded"), false);
});

test("the lane: a placeholder draws its own picture, and the tail counts what's past the budget", () => {
  const progress = Array.from({ length: 6 }, (_, i) => ({ tempId: i + 1, name: `up${i}.png`, kind: "image", objURL: `blob:up${i}` }));
  draw(state.items, progress);
  const lane = [...grid.querySelectorAll(".card.loading")];
  assert.equal(lane.length, 4, "two rows of one column in jsdom, and at least four");
  assert.ok(lane.every((c) => !c.dataset.id), "placeholders carry no id");
  assert.equal(lane[0].querySelector("img").getAttribute("src"), "blob:up0");
  assert.equal(grid.querySelector(".lane-more .lane-more-count").textContent, "+2");
  draw(state.items, progress.slice(0, 2));
  assert.equal(grid.querySelectorAll(".card.loading").length, 2);
  assert.equal(grid.querySelector(".lane-more"), null);
});

test("a row draws its files as tiles, dims the ones that don't match, and marks the face", async () => {
  state.items = [twoFiles()];
  toggle("color", "blue");
  renderRows("cards|rows", [], state.items);
  const r = grid.querySelector('.entity-row[data-eid="1"]');
  assert.ok(r.querySelector('.card[data-id="1"]'), "the entity's card");
  const tiles = [...r.querySelectorAll(".inst-tile")];
  assert.deepEqual(tiles.map((t) => t.dataset.instId), ["101", "102"]);
  assert.deepEqual(tiles.map((t) => t.classList.contains("dim")), [true, false], "red doesn't match blue");
  assert.equal(r.querySelectorAll(".inst-face-chip").length, 1, "one file is the face");
  await enter(tiles[1]);
  assert.equal(tiles[1].querySelector(".inst-tag-chip .tc").textContent, "1");
  assert.ok(tiles[1].querySelector(".inst-actions .act.delete"));
  await leave(tiles[1]);
  assert.equal(tiles[1].querySelector(".inst-tag-chip"), null);
  // A repaint keeps the row and its tiles.
  renderRows("cards|rows", [], state.items);
  assert.equal(grid.querySelector('.entity-row[data-eid="1"]'), r);
  assert.deepEqual([...r.querySelectorAll(".inst-tile")], tiles);
  assert.deepEqual(listenerErrors, []);
  renderRows("cards|rows", [], []);
});

test("a flip to the rows view and back draws each view afresh, from its first batch", () => {
  // Both views draw into #grid, and each skips a draw when nothing it reads
  // moved. A flip moves nothing either reads: the key has to tell them.
  const items = longBoard();
  renderGrid("flip|grid", [], items);
  showItem(items[65]);
  assert.deepEqual(shows(), { rows: 0, cards: 66, list: 0 }, "setup: scrolled past the first batch");
  renderRows("flip|rows", [], items);
  assert.deepEqual(shows(), { rows: 30, cards: 0, list: 0 }, "the rows, from their first batch");
  renderGrid("flip|grid", [], items);
  assert.deepEqual(shows(), { rows: 0, cards: 60, list: 0 }, "the grid again, from its first batch");
  renderRows("flip|rows", [], items);
  assert.deepEqual(shows(), { rows: 30, cards: 0, list: 0 }, "and the rows again");
  renderList("flip|list", [], items);
  assert.deepEqual(shows(), { rows: 0, cards: 0, list: 60 }, "List, from its first batch");
  renderGrid("flip|grid", [], items);
  assert.deepEqual(shows(), { rows: 0, cards: 60, list: 0 }, "and the grid over List");
  renderList("flip|list", [], []);
});

// The lightbox pages through the whole filtered list, so the item it closes
// on can sit past everything a view has drawn. Closing asks each view to draw
// far enough to hold it, and only the view showing does
// (planning/list-view-plan.md, Stage 1). The real path: a click on the first
// card, the arrow key n times, Escape. Returns what the close scrolled to in
// #grid, by id.
async function pageAndClose(n) {
  const scrolled = [];
  const plain = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = function () { if (grid.contains(this)) scrolled.push(this.dataset.id); };
  const lightbox = document.getElementById("lightbox");
  const key = (k) => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: k }));
  try {
    grid.querySelector("[data-id]").click(); // the first card, or List's first row
    await until(() => !lightbox.hidden); // every open goes through an async import (lazy-door.js)
    for (let i = 0; i < n; i++) key("ArrowRight");
    key("Escape");
    assert.equal(lightbox.hidden, true, "setup: the lightbox closed");
  } finally {
    if (!lightbox.hidden) key("Escape"); // a failed test leaves no lightbox open, nor its scroll lock
    window.HTMLElement.prototype.scrollIntoView = plain;
  }
  return scrolled;
}

test("the lightbox closing on a row past the ones drawn draws it and scrolls to it, in the rows view", async () => {
  // Rows used to give up here and leave you where you opened the lightbox.
  const items = longBoard();
  state.view = "rows";
  try {
    renderRows(`${filterKey()}|rows`, [], items);
    assert.deepEqual(shows(), { rows: 30, cards: 0, list: 0 }, "setup: the first batch of rows");
    const scrolled = await pageAndClose(65);
    assert.deepEqual(shows(), { rows: 66, cards: 0, list: 0 }, "drawn far enough to hold the item it closed on");
    assert.deepEqual(scrolled, [String(items[65].id)], "and scrolled to it");
    assert.deepEqual(listenerErrors, []);
  } finally {
    state.view = null;
    renderRows("reveal|rows", [], []);
  }
});

test("the lightbox closing on a card past the ones drawn draws it and scrolls to it, in the grid view, and draws no rows", async () => {
  // Not a bug fix, the grid always did this: the guard is that the rows' step
  // stays out of it.
  const items = longBoard();
  try {
    renderGrid(`${filterKey()}|grid`, [], items);
    assert.deepEqual(shows(), { rows: 0, cards: 60, list: 0 }, "setup: the first batch of cards");
    const scrolled = await pageAndClose(65);
    assert.deepEqual(shows(), { rows: 0, cards: 66, list: 0 }, "the grid drew far enough, and the rows' step stayed out");
    assert.deepEqual(scrolled, [String(items[65].id)], "and scrolled to it");
    assert.deepEqual(listenerErrors, []);
  } finally {
    renderGrid("reveal|grid", [], []);
  }
});

test("the page reaching the end of what's drawn draws the next batch, in the view showing and no other", () => {
  // Every view watches the same marker under the gallery (batches.js); only
  // the one showing may answer it.
  const items = longBoard();
  const marker = document.getElementById("grid-sentinel");
  renderGrid(`${filterKey()}|grid`, [], items);
  intersect(marker);
  assert.deepEqual(shows(), { rows: 0, cards: 70, list: 0 }, "the grid drew its next batch, up to the end of the list");
  state.view = "rows";
  try {
    renderRows(`${filterKey()}|rows`, [], items);
    intersect(marker);
    assert.deepEqual(shows(), { rows: 60, cards: 0, list: 0 }, "rows drew their next 30, and the grid stayed out");
    state.view = "list";
    renderList(`${filterKey()}|list`, [], items);
    intersect(marker);
    assert.deepEqual(shows(), { rows: 0, cards: 0, list: 70 }, "List drew its next batch, and the others stayed out");
  } finally {
    state.view = null;
    renderRows("more|rows", [], []);
  }
});

// ── List (planning/list-view-plan.md, Stage 2a) ────────────────────────────

const lrow = (id) => grid.querySelector(`tr.list-row[data-id="${id}"]`);
// List drawn the way app.js render() draws it: under the filters' key, from
// the filtered list. A sort or a search changes the key.
const drawList = (progress = []) => renderList(`${filterKey()}|list`, progress, taggedFiltered());
const head = (label) => [...grid.querySelectorAll("thead th")].find((th) => th.textContent.includes(label));

test("List draws a row per item: the select button, a small face, the name as its open button, the date and the heart", () => {
  const added = Date.UTC(2026, 8, 1, 12);
  state.items[0].created_at = added;
  drawList();
  const r = lrow(1);
  assert.ok(r, "a row for the item");
  assert.equal(r.querySelector(".sel-cb").getAttribute("aria-pressed"), "false");
  assert.equal(r.querySelector(".small-face img").getAttribute("src"), "thumbnails/f1.png.webp");
  assert.equal(r.querySelector("button.list-open").textContent, state.items[0].displayLabel);
  assert.equal(r.querySelector(".list-date").textContent, new Date(added).toLocaleDateString());
  assert.equal(lrow(2).querySelector(".list-date").textContent, "—", "no date: an upload before its backfill");
  assert.ok(r.querySelector(".heart"), "the heart, which the stylesheet shows on hover");
  assert.equal(r.querySelector(".tag-chip"), null, "no chrome until the pointer arrives");
  assert.equal(lrow(3).querySelector(".list-flag").textContent, "needs tags");
  assert.ok(lrow(3).classList.contains("undecided"));
  assert.deepEqual(listenerErrors, []);
});

test("the pointer over a List row brings the card's tag chip and actions, and a menu opened from them pins the row", async () => {
  document.body.click(); // jsdom answers :hover for the last element clicked, and the release asks
  drawList();
  const r = lrow(1);
  await enter(r);
  assert.equal(r.querySelector(".tag-chip .tc").textContent, "1", "the tag chip, with the count");
  assert.ok(r.querySelector(".card-actions .act.delete"), "the card's actions");
  const pin = pinWhileOpen(r.querySelector(".act.crate"));
  assert.equal(pin.el, r, "the menu's opener finds its row");
  pin.hold({});
  await leave(r);
  assert.ok(r.classList.contains("pop-open"));
  assert.ok(r.querySelector(".card-actions"), "the chrome stays while the menu is up");
  pin.release("manual");
  await tick();
  assert.equal(r.querySelector(".card-actions"), null, "and goes when it closes");
  assert.deepEqual(listenerErrors, []);
});

test("in List, a repaint that changed nothing touches no row, and a heart redraws its own row alone, in place", async () => {
  drawList();
  const before = [...grid.querySelectorAll("tr.list-row")];
  const touched = new Set();
  const watch = new window.MutationObserver((records) => {
    for (const m of records) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      touched.add(el?.closest("tr")?.dataset.id ?? "outside the rows");
    }
  });
  watch.observe(grid, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    drawList();
    await tick();
    assert.deepEqual([...touched], [], "nothing changed, nothing drawn");
    state.items[1].hearts = 3;
    itemsChanged(); // as every writer does
    drawList();
    await tick();
    assert.deepEqual([...touched], ["2"], "only the row whose item changed");
    assert.deepEqual([...grid.querySelectorAll("tr.list-row")], before, "every row the same element");
    assert.equal(lrow(2).querySelector(".heart .hc").textContent, "3");
  } finally {
    watch.disconnect();
  }
});

test("List draws again when what it reads changes: the selection, the viewer, the board's facets and its card mode", () => {
  // None of these changes the filtered list, or the key (filterKey): the
  // stamp is all that notices them.
  const me = state.me;
  try {
    drawList();
    toggleBulkSelect(state.items[0]);
    drawList();
    assert.ok(lrow(1).classList.contains("selected"), "the selection");
    clearBulk();
    drawList();
    state.facets = [];
    drawList();
    assert.equal(lrow(3).classList.contains("undecided"), false, "no facets, so nothing needs tags");
    state.boardMapping = { card: { by: "who" } };
    drawList();
    assert.ok(head("Files"), "a card key: the Files column");
    state.me = null;
    drawList();
    assert.equal(lrow(1).querySelector(".sel-cb"), null, "signed out: no select button");
  } finally {
    state.me = me;
  }
});

test("a click anywhere on a List row opens its item, except at the end of a text selection; in bulk mode it selects", async () => {
  const lightbox = document.getElementById("lightbox");
  drawList();
  lrow(1).querySelector(".list-date").click();
  await until(() => !lightbox.hidden);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(lightbox.hidden, true, "setup: closed again");

  // A drag across a title ends in a click on the row, and leaves the text
  // selected to copy. The drag replaces the selection: closing the lightbox
  // just focused a row's name, and jsdom leaves a caret behind a focus, which
  // addRange alone would keep.
  const range = document.createRange();
  range.selectNodeContents(lrow(2).querySelector("button.list-open"));
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  try {
    lrow(2).querySelector(".list-date").click();
    await settle();
    assert.equal(lightbox.hidden, true, "a text selection doesn't open the item");
  } finally {
    window.getSelection().removeAllRanges();
  }

  toggleBulkSelect(state.items[2]);
  lrow(2).querySelector(".list-date").click();
  await settle();
  assert.deepEqual([...state.bulkSelected].sort(), [2, 3], "in bulk mode the row selects, as a card click does");
  assert.equal(lightbox.hidden, true);
  clearBulk();
  assert.deepEqual(listenerErrors, []);
});

test("List's headers: with no sort chosen, Date added is the sorted column, newest first; a header click sets the one sort and says so", () => {
  const note = document.getElementById("list-note");
  try {
    drawList();
    assert.equal(head("Date added").getAttribute("aria-sort"), "descending", "the server's order is Date added, newest first");
    assert.equal(head("Name").getAttribute("aria-sort"), null);
    head("Date added").querySelector("button").click();
    assert.deepEqual(state.sort, { by: "created", dir: "asc", label: "Date added" }, "so its first click turns it over");
    assert.equal(note.textContent, "Sorted by Date added, ascending");
    drawList(); // what app.js's effect does on the sort's write
    assert.equal(head("Date added").getAttribute("aria-sort"), "ascending");
    head("Name").querySelector("button").click();
    assert.deepEqual(state.sort, { by: "name", dir: "asc", label: "Name" }, "a new column takes its natural direction");
    // The toolbar's menu goes through the same rule, and the headers follow.
    setSort(nextSort({ by: "hearts", label: "Hearts", kind: "number" }));
    drawList();
    assert.equal(head("Hearts").getAttribute("aria-sort"), "descending");
    assert.equal(head("Name").getAttribute("aria-sort"), null);
  } finally {
    setSort(null);
  }
});

test("while a search is on, List's headers show no sort and don't act: relevance is the order", () => {
  state.sort = { by: "name", dir: "asc", label: "Name" };
  state.searchResults = new Map([[1, 0.9], [2, 0.5], [3, 0.1]]);
  drawList();
  assert.deepEqual([...grid.querySelectorAll("thead th[aria-sort]")], [], "no column claims the order");
  assert.ok([...grid.querySelectorAll("thead .list-sort")].every((b) => b.disabled), "and none sorts");
});

test("Ctrl+A in List takes the rows drawn, not the upload lane's", () => {
  drawList([{ tempId: 9, name: "up.png", kind: "image", objURL: "blob:up" }]);
  const lane = grid.querySelector("tr.list-lane");
  assert.equal(lane.dataset.id, undefined, "setup: a lane row carries no id");
  assert.equal(lane.querySelector(".small-face img").getAttribute("src"), "blob:up", "it shows the upload's own picture");
  selectAllVisible(visibleGridItems());
  assert.deepEqual([...state.bulkSelected].sort(), [1, 2, 3]);
  clearBulk();
});

test("the lightbox closing on a row past the ones drawn draws it and scrolls to it, in List", async () => {
  const items = longBoard();
  state.view = "list";
  try {
    renderList(`${filterKey()}|list`, [], items);
    assert.deepEqual(shows(), { rows: 0, cards: 0, list: 60 }, "setup: the first batch of rows");
    const scrolled = await pageAndClose(65);
    assert.deepEqual(shows(), { rows: 0, cards: 0, list: 66 }, "drawn far enough to hold the item it closed on");
    assert.deepEqual(scrolled, [String(items[65].id)], "and scrolled to it");
    assert.deepEqual(listenerErrors, []);
  } finally {
    state.view = null;
    renderList("reveal|list", [], []);
  }
});

test("a small face per kind: a photo cropped, a chart or a waveform whole, and the card's badge when there's no picture", () => {
  state.items = [
    row(1, [], { name: "photo.png" }),
    row(2, [], { name: "chart.png", generated: true }),
    row(3, [], { name: "page.pdf", kind: "document" }),
    row(4, [], { name: "memo.pdf", kind: "document", w: 0, h: 0 }),
    row(5, [], { name: "song.mp3", kind: "audio" }),
    row(6, [], { name: "hum.mp3", kind: "audio", w: 0, h: 0 }),
    row(7, [], { name: "btc", kind: "connector", symbol: "BTC", w: 0, h: 0 }),
  ].map(toItem);
  drawList();
  const face = (id) => {
    const f = lrow(id).querySelector(".small-face");
    return { cls: f.className, pic: !!f.querySelector("img"), text: f.textContent.trim() };
  };
  assert.deepEqual(face(1), { cls: "small-face", pic: true, text: "" }, "a photo, cropped");
  assert.deepEqual(face(2), { cls: "small-face whole", pic: true, text: "" }, "a chart, whole");
  assert.deepEqual(face(3), { cls: "small-face top", pic: true, text: "" }, "a page peek, cropped from its top");
  assert.deepEqual(face(4), { cls: "small-face badge", pic: false, text: "PDF" }, "no page peek: the extension");
  assert.deepEqual(face(5), { cls: "small-face whole", pic: true, text: "" }, "a waveform, whole");
  assert.deepEqual(face(6), { cls: "small-face badge audio", pic: false, text: "♪" }, "no waveform: the note");
  assert.deepEqual(face(7), { cls: "small-face badge symbol", pic: false, text: "BTC" }, "a connector entity: its ticker");
});

test("a rows tile with no picture wears the card's badge too", () => {
  state.items = [toItem(row(1, [], {
    instances: [
      { id: 101, name: "a.png", status: "tagged", tags: [], w: 4, h: 3 },
      { id: 102, name: "b.mp3", kind: "audio", status: "tagged", tags: [], w: 0, h: 0 },
    ],
  }))];
  renderRows("tiles|rows", [], taggedFiltered());
  const tile = grid.querySelector('.inst-tile[data-inst-id="102"]');
  assert.equal(tile.querySelector(".inst-badge").textContent, "♪", "the card's legend, not the file's extension");
  renderRows("tiles|rows", [], []);
});

test("a file sent back to work shows its spinner, when its entity was in work already", () => {
  // A re-queue's answer writes each file's status in place (data.js
  // applyRoutedEntities), so the file list is the same array before and
  // after; here the entity's own status doesn't move either.
  state.items = [toItem(row(1, ["color/red"], {
    status: "pending",
    instances: [
      { id: 101, name: "a.png", status: "pending", tags: ["color/red"], w: 4, h: 3 },
      { id: 102, name: "b.png", status: "tagged", tags: ["color/red"], w: 4, h: 3 },
    ],
  }))];
  const drawRows = () => renderRows(`${filterKey()}|rows`, [], taggedFiltered());
  drawRows();
  const tile = () => grid.querySelector('.inst-tile[data-inst-id="102"]');
  assert.equal(tile().classList.contains("loading"), false, "setup: the second file is settled");
  applyRoutedEntities([{ id: 1, status: "pending", instances: [{ id: 101, status: "pending" }, { id: 102, status: "pending" }] }]);
  drawRows(); // the repaint the re-queue asks for
  assert.equal(tile().classList.contains("loading"), true);
  renderRows("busy|rows", [], []);
});

test("a tile's menu pins the tile it was opened from, when the same file sits in two rows", async () => {
  // In classify mode a file belongs to every entity that claimed it, so the
  // same file is a tile in each of their rows.
  const entity = (id, other) => toItem(row(id, ["color/red"], {
    name: "a.png",
    instances: [
      { id: 101, name: "a.png", status: "tagged", tags: ["color/red"], w: 4, h: 3 },
      { id: other, name: `o${other}.png`, status: "tagged", tags: ["color/red"], w: 4, h: 3 },
    ],
  }));
  state.items = [entity(1, 201), entity(2, 202)];
  renderRows("shared|rows", [], taggedFiltered());
  const tiles = [...grid.querySelectorAll('.inst-tile[data-inst-id="101"]')];
  assert.equal(tiles.length, 2, "setup: the shared file is a tile in both rows");
  document.body.click(); // jsdom's :hover follows the last click
  await enter(tiles[0]);
  tiles[0].querySelector(".inst-tag-chip").click();
  await tick();
  assert.ok(document.querySelector(".dropdown.tag-pop"), "setup: the tile's menu is open");
  assert.deepEqual(tiles.map((t) => t.classList.contains("pop-open")), [true, false]);
  document.body.click(); // an outside click closes it
  await tick();
  assert.deepEqual(tiles.map((t) => t.classList.contains("pop-open")), [false, false]);
  renderRows("shared|rows", [], []);
});

test("a strip is aimed where a rebuilt one was, and otherwise keeps where the hand left it", async () => {
  state.facets = [
    { key: "color", label: "Color", values: ["red", "blue"] },
    { key: "size", label: "Size", values: ["big"] },
  ];
  state.items = [toItem(row(1, ["color/red", "color/blue", "size/big"], {
    instances: [
      { id: 101, name: "a.png", status: "tagged", tags: ["color/red", "size/big"], w: 4, h: 3 },
      { id: 102, name: "b.png", status: "tagged", tags: ["color/blue", "size/big"], w: 4, h: 3 },
    ],
  }))];
  const drawRows = () => renderRows(`${filterKey()}|rows`, [], taggedFiltered());
  // jsdom lays nothing out: the strip keeps a scroll position here, and the
  // blue file sits 300px along it.
  let at = 0;
  const fake = (eid, instId) => {
    Object.defineProperty(grid.querySelector(`.entity-row[data-eid="${eid}"] .inst-strip`), "scrollLeft",
      { configurable: true, get: () => at, set: (v) => { at = v; } });
    Object.defineProperty(grid.querySelector(`.inst-tile[data-inst-id="${instId}"]`), "offsetLeft", { configurable: true, get: () => 300 });
  };
  toggle("color", "blue");
  drawRows();
  fake(1, 102);
  await frame();
  assert.equal(at, 292, "a fresh strip with a dimmed file: aimed at its first match");
  at = 50; // the hand scrolls it
  toggle("size", "big"); // a filter change that leaves this row's files as they were
  drawRows();
  await frame();
  assert.equal(at, 50, "kept where the hand left it");
  toggle("color", "blue"); // off: every file matches now
  drawRows();
  await frame();
  assert.equal(at, 0, "a filter change that moved its dim pattern starts it over: nothing dimmed, so at the start");
  // A strip that appears: a second file arrives, ahead of the matching one.
  toggle("color", "blue");
  state.items = [toItem(row(2, ["color/blue", "size/big"], {
    instances: [{ id: 201, name: "c.png", status: "tagged", tags: ["color/blue", "size/big"], w: 4, h: 3 }],
  }))];
  drawRows();
  const second = grid.querySelector('.entity-row[data-eid="2"]');
  assert.ok(second, "setup: the entity's row");
  assert.equal(second.querySelector(".inst-strip"), null, "setup: one file, no strip");
  // The poll's merge (data.js reconcile): the same item, its files replaced.
  Object.assign(state.items[0], toItem(row(2, ["color/red", "color/blue", "size/big"], {
    instances: [
      { id: 202, name: "d.png", status: "tagged", tags: ["color/red", "size/big"], w: 4, h: 3 },
      { id: 201, name: "c.png", status: "tagged", tags: ["color/blue", "size/big"], w: 4, h: 3 },
    ],
  })));
  itemsChanged();
  drawRows();
  at = 0;
  fake(2, 201);
  await frame();
  assert.equal(at, 292, "a strip that just appeared, with a dimmed file: aimed at its first match");
  renderRows("aim|rows", [], []);
});

test("the lane's budget follows the grid's width, in both views", () => {
  const progress = Array.from({ length: 6 }, (_, i) => ({ tempId: i + 1, name: `up${i}.png`, kind: "image", objURL: `blob:up${i}` }));
  const lane = () => ({
    placeholders: grid.querySelectorAll(".card.loading").length,
    tail: grid.querySelector(".lane-more .lane-more-count")?.textContent ?? null,
  });
  for (const [drawView, key] of [[renderGrid, "lane|grid"], [renderRows, "lane|rows"]]) {
    drawView(key, progress, state.items);
    assert.deepEqual(lane(), { placeholders: 4, tail: "+2" }, `${key}: setup, one column in jsdom`);
    Object.defineProperty(grid, "clientWidth", { configurable: true, get: () => 2000 }); // a wide window
    try {
      drawView(key, progress, state.items); // the next repaint, nothing else changed
      assert.deepEqual(lane(), { placeholders: 6, tail: null }, `${key}: two rows of a wide grid hold them all`);
    } finally {
      delete grid.clientWidth;
    }
  }
  renderRows("lane|rows", [], []);
});
