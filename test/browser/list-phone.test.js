// List on a phone and on a touch tablet, in a real browser
// (planning/list-view-plan.md, Stage 4). Only a browser in its phone mode
// shows the trouble: a page wider than a touch screen doesn't scroll there, it
// widens, and the header card, fixed to the page, widens with it, its toggles
// and sort off the screen. So there List draws its compact table, which fits:
// the picture, the name, and under the name the sorted column's value.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { updateBoard, createBoard, createEntity, insertItem, setBoardMembers } from "../../server/db.js";
import { manifest as stocks } from "../../server/connectors/stocks/index.js";

// Chromium's phone mode: a touch screen with a phone's viewport.
const touch = (width, height) => ({ viewport: { width, height }, isMobile: true, hasTouch: true });
const PHONE = touch(390, 844);
// A turn or a resize redraws List at once, not at the page's next refresh.
const AT_ONCE = { timeout: 1000 };

let app, user;
const boards = {};

before(async () => {
  app = await openApp();
  let boardId;
  ({ user, boardId } = await app.signIn({ boardName: "Stocks" }));
  boards.stocks = boardId;
  await updateBoard(app.db, boards.stocks, { mapping: { ...stocks.template } });
  const now = Date.now();
  const field = (v) => ({ v, kind: "number", src: "financialmodelingprep", at: now });
  const ticker = async (name, symbol, price, change_1d, market_cap, volume) => {
    const fields = Object.fromEntries(Object.entries({ price, change_1d, market_cap, volume }).map(([k, v]) => [k, field(v)]));
    const eid = await createEntity(app.db, boards.stocks, { identity: symbol.toLowerCase(), displayName: name, symbol, fields });
    await insertItem(app.db, boards.stocks, { identity: symbol.toLowerCase(), files: [], fields: {} }, "tagged", eid);
  };
  await ticker("Coca-Cola Co", "KO", 62.4, -0.84, 268.9e9, 12345678);
  await ticker("Apple Inc.", "AAPL", 227.52, 1.23, 3.45e12, 45234567);
  await ticker("NVIDIA Corporation", "NVDA", 118.11, 2.51, 2.9e12, 312345678);
  // An audio board: its table (Date added alone) fits a tablet.
  boards.audio = await createBoard(app.db, "Audio", [], "", true, null, null, { enabled: false });
  await setBoardMembers(app.db, boards.audio, [user.id]);
  for (const name of ["Harbor Lights", "Voice memo"]) {
    const file = `${name}.mp3`;
    const eid = await createEntity(app.db, boards.audio, { identity: file, displayName: name });
    await insertItem(app.db, boards.audio, { identity: file, files: [{ name: file, original_name: file, kind: "audio", size: 2e6 }], fields: {} }, "tagged", eid);
  }
});
after(() => app?.close());

// A board in List (the viewer's saved choice) on a device, with a saved sort.
async function openList(boardId, { device, sort } = {}) {
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid, device });
  await page.evaluate(([id, sort]) => {
    localStorage.setItem(`boardView:${id}`, "list");
    if (sort) localStorage.setItem(`boardSort:${id}`, JSON.stringify(sort));
  }, [boardId, sort]);
  await page.reload();
  await page.waitForSelector("#grid tr.list-row[data-id]");
  return page;
}

// What the screen shows: how wide the page is against it, where the toolbar's
// view toggle and sort end, whether there's a Columns button, and each row by
// its name: its cells and the line under its name.
const shape = (page) => page.evaluate(() => {
  const right = (sel) => Math.round(document.querySelector(sel)?.getBoundingClientRect().right ?? -1);
  return {
    screen: document.documentElement.clientWidth,
    page: Math.max(window.innerWidth, document.documentElement.scrollWidth),
    toggle: right('.view-btn[aria-label="Toggle list view"]'),
    sort: right(".sort-btn"),
    columns: !!document.querySelector(".columns-btn"),
    heads: [...document.querySelectorAll("#grid thead th")].map((th) => th.textContent.trim()),
    rows: Object.fromEntries([...document.querySelectorAll("#grid tbody tr[data-id]")].map((tr) => [
      tr.querySelector(".list-open").textContent,
      { cells: [...tr.children].map((td) => td.className.split(" ")[0]), sub: tr.querySelector(".list-sub")?.textContent ?? null },
    ])),
  };
});

test("on a phone, List fits the screen, the toolbar's toggle and sort on it, and the Columns button only once it's turned sideways", async () => {
  const page = await openList(boards.stocks, { device: PHONE });
  // The board's first sort is the domain's (market cap), once the catalog lands.
  await page.waitForFunction(() => document.querySelector("#grid .list-sub")?.textContent.startsWith("Market cap"));
  let s = await shape(page);
  assert.equal(s.screen, 390, "setup: a phone's screen");
  assert.equal(s.page, 390, "the page is as wide as the screen");
  assert.ok(s.toggle > 0 && s.toggle <= 390, `the List toggle, the way back to the grid, is on the screen (ends at ${s.toggle}px)`);
  assert.ok(s.sort > 0 && s.sort <= 390, `and the sort (ends at ${s.sort}px)`);
  assert.equal(s.columns, false, "no Columns button: this table has no columns to choose");
  assert.deepEqual(s.heads, ["Picture", "Name"]);
  assert.deepEqual(s.rows["Apple Inc."], { cells: ["list-face", "list-name"], sub: "Market cap (USD) · $3.45T" },
    "a row: the picture and the name, and under it the sorted column's value");
  assert.equal(await page.evaluate(() => Math.round(document.querySelector("#grid .small-face").getBoundingClientRect().width)), 64,
    "the smaller picture");
  // Turned sideways the table is still too wide for it, and the toolbar has
  // room for the Columns button: taking columns off could make one fit.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator(".columns-btn").waitFor(AT_ONCE);
  s = await shape(page);
  assert.equal(s.page, 844, "turned: still no wider than the screen");
  assert.deepEqual(s.rows["Apple Inc."].cells, ["list-face", "list-name"], "still compact");
  assert.deepEqual(page.errors, []);
});

test("a compact row's second line follows the sort, a change in its color, and says Date added when the sort is the name", async () => {
  const page = await openList(boards.stocks, { device: PHONE, sort: { by: "field:change_1d", dir: "desc", label: "Daily change (%)" } });
  await page.waitForFunction(() => document.querySelector("#grid .list-sub")?.textContent.startsWith("Daily change"));
  const change = await page.evaluate(() => [...document.querySelectorAll("#grid .list-sub")].map((sub) => [sub.textContent, sub.querySelector("span").className]));
  assert.deepEqual(change, [
    ["Daily change (%) · +2.51%", "change-up"],
    ["Daily change (%) · +1.23%", "change-up"],
    ["Daily change (%) · -0.84%", "change-down"],
  ], "the sorted column's value, in its color, highest first");
  const named = await openList(boards.stocks, { device: PHONE, sort: { by: "name", dir: "asc", label: "Name" } });
  const s = await shape(named);
  assert.match(s.rows["Apple Inc."].sub, /^Date added · \d+\/\d+\/\d{4}$/, "sorted by name, the line above says it: Date added instead");
  assert.deepEqual([page.errors, named.errors], [[], []]);
});

test("a touch tablet takes the compact table only when the full one won't fit it, and turned, looks again", async () => {
  const stocksPage = await openList(boards.stocks, { device: touch(820, 1180) });
  await stocksPage.waitForFunction(() => document.querySelector("#grid .list-sub")?.textContent.startsWith("Market cap"));
  let s = await shape(stocksPage);
  assert.equal(s.screen, 820, "setup: a tablet's screen");
  assert.equal(s.page, 820, "the stocks table would be 1,182px: compact, and the page as wide as the screen");
  assert.ok(s.sort > 0 && s.sort <= 820, `the sort on the screen (ends at ${s.sort}px)`);
  assert.equal(s.columns, true, "and the Columns button: taking columns off could make the table fit");
  // The audio board's table is 792px: over the 772px inside the page's
  // margins upright, and well inside them turned on its side.
  const page = await openList(boards.audio, { device: touch(820, 1180) });
  assert.ok(await page.locator("#grid .list-compact").count(), "setup: upright, compact");
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForFunction(() => !document.querySelector("#grid .list-compact"), null, AT_ONCE);
  s = await shape(page);
  assert.deepEqual(s.rows["Voice memo"].cells, ["list-sel", "list-face", "list-name", "list-date", "list-heart", "list-act"],
    "turned, the table fits: the full one");
  assert.equal(s.page, 1180, "the page as wide as the screen");
  assert.equal(s.columns, true, "with its Columns button");
  assert.deepEqual([stocksPage.errors, page.errors], [[], []]);
});

test("a desktop window narrowed past 640px redraws List compact, and back, the Columns button with it", async () => {
  const page = await openList(boards.audio);
  await page.setViewportSize({ width: 1280, height: 800 });
  const cells = () => page.evaluate(() => [...document.querySelector("#grid tbody tr[data-id]").children].map((td) => td.className.split(" ")[0]));
  assert.equal((await cells()).length, 6, "setup: the full table");
  await page.setViewportSize({ width: 600, height: 800 });
  await page.waitForFunction(() => document.querySelector("#grid .list-compact"), null, AT_ONCE);
  assert.deepEqual(await cells(), ["list-face", "list-name"], "narrowed: the compact table");
  assert.equal(await page.locator(".columns-btn").count(), 0, "and no Columns button");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => !document.querySelector("#grid .list-compact"), null, AT_ONCE);
  assert.equal((await cells()).length, 6, "widened: the full table again");
  assert.equal(await page.locator(".columns-btn").count(), 1, "with its Columns button");
  assert.deepEqual(page.errors, []);
});
