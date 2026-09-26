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
import { window } from "./jsdom-stub.js";

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
const { renderGrid, pinWhileOpen, Card, scrollToCard } = await import("../public/grid.js");
const { renderRows } = await import("../public/rows.js");
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
const enter = async (el) => { el.dispatchEvent(new window.Event("pointerenter")); await tick(); };
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
  state.items = Array.from({ length: 70 }, (_, i) => toItem(row(i + 1, ["color/red"])));
  const items = taggedFiltered(); // the cached list, what render() passes
  renderGrid("flip|grid", [], items);
  scrollToCard(items[65]);
  const shows = () => ({
    rows: grid.querySelectorAll(":scope > .entity-row").length,
    cards: grid.querySelectorAll(":scope > .card[data-id]").length,
  });
  assert.deepEqual(shows(), { rows: 0, cards: 66 }, "setup: scrolled past the first batch");
  renderRows("flip|rows", [], items);
  assert.deepEqual(shows(), { rows: 30, cards: 0 }, "the rows, from their first batch");
  renderGrid("flip|grid", [], items);
  assert.deepEqual(shows(), { rows: 0, cards: 60 }, "the grid again, from its first batch");
  renderRows("flip|rows", [], items);
  assert.deepEqual(shows(), { rows: 30, cards: 0 }, "and the rows again");
  renderRows("flip|rows", [], []);
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
