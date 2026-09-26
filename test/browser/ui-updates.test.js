// What a repaint costs the person using the page (planning/ui-updates-plan.md,
// from Stage 0). A repaint used to rebuild the toolbar and the filter rail from
// nothing, so whatever the browser was keeping on those elements went with
// them: keyboard focus, the caret in the search box, an open menu's hold on
// its button. The plan moves both surfaces onto a library that updates in
// place, one stage at a time. These tests pinned where things stood before it
// did, and each stage turned its own into tests of the fix. The filter rail
// moved in Stage 1 and the toolbar in Stage 2, so each one now holds a fix.
//
// Two rules, both from the plan's close look (D8):
//
// Real triggers only. A repaint here comes from a key press that toggles
// something, or from a new item reaching the page through its own poll, never
// from a hand-fired event. Since Stage 5 nothing listens for `app:render` (the
// page draws on the writes themselves), so firing one would redraw nothing,
// and a test built on it would pass without testing anything. A new item
// changes what both surfaces show (the result count, the chip counts, the
// jobs count), so any version of them has to redraw.
//
// A bug test starts by stating what happens TODAY. It checks its setup on the
// way, then asserts the broken behavior, so it passes only if the setup worked
// and the bug happened, and it fails the moment the bug stops. The stage that
// fixes the bug rewrites it to the fixed behavior. (`todo` was the first idea.
// It keeps the suite green, but a todo that fails because its own setup broke
// looks exactly like one failing on the bug.)
//
// Grouped by the stage that fixed them. The last five were right from the
// start, and a later stage could break them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { seedInstance } from "../helpers.js";
import { updateBoard, createEntity, insertItem, createCrate, addCrateItems } from "../../server/db.js";

let app, user, boardId, clusterBoardId, rowsBoardId, crateBoardId;
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

before(async () => {
  app = await openApp();
  ({ user, boardId } = await app.signIn({ boardName: "Repaint board" }));
  await updateBoard(app.db, boardId, {
    facets: [
      // amber is declared first and held by nothing, so its chip stays hidden
      // until the keys test gives it an item: then it appears ahead of red.
      { key: "color", label: "Color", values: ["amber", "red", "blue", "green"] },
      { key: "size", label: "Size", values: ["big", "small"] },
    ],
  });
  for (const tags of [["color/red", "size/big"], ["color/blue", "size/small"], ["color/green", "size/big"]]) {
    await seedInstance(app.db, boardId, "tagged", { tags });
  }
  // A second board, for the one test that needs the cluster lens: clusters
  // take at least 16 items with three tags each, in groups of 8 or more
  // (cluster-core.js). Ten and ten, alike within and unlike between.
  ({ boardId: clusterBoardId } = await app.signIn({ boardName: "Cluster board" }));
  await updateBoard(app.db, clusterBoardId, {
    facets: [
      { key: "color", label: "Color", values: ["red", "blue"] },
      { key: "shape", label: "Shape", values: ["round", "square"] },
      { key: "size", label: "Size", values: ["big", "small"] },
    ],
  });
  for (let i = 0; i < 10; i++) {
    await seedInstance(app.db, clusterBoardId, "tagged", { tags: ["color/red", "shape/round", "size/big"] });
    await seedInstance(app.db, clusterBoardId, "tagged", { tags: ["color/blue", "shape/square", "size/small"] });
  }
  // A third board, for the view flip. The rows view is offered only where an
  // entity holds more than one file, and a board that has one flips to rows
  // by itself once a filter is on, which the chip tests above don't expect:
  // so it gets a board of its own, one entity with two files and one with one.
  ({ boardId: rowsBoardId } = await app.signIn({ boardName: "Rows board" }));
  await updateBoard(app.db, rowsBoardId, { facets: [{ key: "color", label: "Color", values: ["red", "blue"] }] });
  await seedInstance(app.db, rowsBoardId, "tagged", { tags: ["color/red"] });
  const pair = await createEntity(app.db, rowsBoardId, { identity: "pair" });
  for (const tags of [["color/red"], ["color/blue"]]) {
    const id = await insertItem(app.db, rowsBoardId, { identity: "pair", files: [], fields: {} }, "tagged", pair);
    await app.db.query("UPDATE items SET tags=$1 WHERE id=$2", [JSON.stringify(tags), id]);
  }
  // A fourth, for the crate test: two items, and a crate holding the first.
  ({ boardId: crateBoardId } = await app.signIn({ boardName: "Crate board" }));
  await updateBoard(app.db, crateBoardId, { facets: [{ key: "color", label: "Color", values: ["red", "blue"] }] });
  const { eid: kept } = await seedInstance(app.db, crateBoardId, "tagged", { tags: ["color/red"] });
  await seedInstance(app.db, crateBoardId, "tagged", { tags: ["color/blue"] });
  const crate = await createCrate(app.db, user.id, crateBoardId, "keep");
  await addCrateItems(app.db, user.id, crate.id, [kept]);
});
after(() => app?.close());

// The board in a fresh page, with the precondition every test leans on checked
// first. The search box and a busy jobs chip both exist only because the test
// server has an embedder. Tagged items waiting for an embedding are a backlog
// the suite never clears (no worker runs here), and that backlog is also what
// keeps the page checking for changes every 4s: the poll these tests wait on.
// work-cadence.test.js leans on the same fact.
//
// Timing, which every test below depends on: the page's first poll comes about
// 4s after it first draws, and nothing else repaints it before then. The event
// stream doesn't refresh on its first connection, only on a reconnect
// (events.js), and the header's dots first tick at 20s (signals.js). So each
// test does its setup inside those 4s, in as few steps as it can. A setup that
// ran long would have the poll repaint under it and fail on a setup line.
async function openBoard(id = boardId) {
  const page = await app.open(`/?board=${id}`, { sid: user.sid });
  try {
    await page.waitForSelector("#grid .card");
    await page.waitForSelector("#filters .pill");
  } catch (e) {
    // When the board doesn't draw, say what the page had. The bare wait said
    // only "Timeout 30000ms" the one time it happened (a full run of the
    // browser suite on the built frontend; forty opens since were clean).
    const grid = await page.evaluate(() => {
      const cards = document.querySelectorAll("#grid .card");
      const r = cards[0]?.getBoundingClientRect();
      return `${cards.length} cards${r ? `, the first ${Math.round(r.width)}x${Math.round(r.height)}` : ""}, ${document.querySelectorAll("#filters .pill").length} chips`;
    }).catch(() => "the page couldn't be read");
    throw new Error(`setup: the board didn't draw (${e.message.split("\n")[0]}; ${grid}). Page errors: ${JSON.stringify([...new Set(page.errors)])}. Failed requests: ${JSON.stringify(page.failures)}`);
  }
  const ready = await page.evaluate(() => ({
    searchBox: !!document.querySelector(".search-box input"),
    jobsBusy: !!document.querySelector(".jobs-chip.busy"),
  }));
  assert.deepEqual(ready, { searchBox: true, jobsBusy: true },
    "precondition: the test server has an embedder, so the board has a search box and an embed backlog that keeps the page checking every 4s");
  return page;
}

// What has keyboard focus, in words a failure message can use.
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "<body>";
  const value = el.dataset.value ? `[${el.dataset.value}]` : "";
  return `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}${value}`;
});

// A real repaint: an item is written to the database, and the page's own poll
// brings it in. Resolves once the item's card is on the grid, so the poll has
// landed and the page has repainted. It watches the grid, not the toolbar or
// the rail, because those are what the tests are about: a test that needs one
// of them to have redrawn checks that itself, so a surface that stopped
// redrawing fails on its own line instead of reading as a missing poll. (The
// item is red, so the red chip's count moves; it's one more item waiting to
// embed, so the jobs count moves; and the result count moves.)
async function pollBringsAnItem(page) {
  const before = await page.evaluate(() => document.querySelectorAll("#grid .card[data-id]").length);
  await seedInstance(app.db, boardId, "tagged", { tags: ["color/red", "size/small"] });
  try {
    await page.waitForFunction((n) => document.querySelectorAll("#grid .card[data-id]").length > n, before, { timeout: 12000 });
  } catch {
    throw new Error(`the new item's card didn't reach the grid within 12s (still ${before} cards). Is the page still checking every 4s?`);
  }
}

// The result count, for the tests whose only proof the toolbar redrew is that
// it moved.
const resultCount = (page) => page.textContent(".result-count");

// Press Enter on whatever has focus, and wait for what it should have done.
// Short, with its own message: if a repaint took the focus first, Enter lands
// on <body> and does nothing, and the default 30s wait would only say
// "timeout".
async function pressEnter(page, selector, what) {
  await page.keyboard.press("Enter");
  try {
    await page.waitForSelector(selector, { timeout: 5000 });
  } catch {
    throw new Error(`setup: ${what} didn't happen within 5s of pressing Enter. If a repaint took the focus first, Enter landed on <body> (see openBoard's timing note).`);
  }
}

// ── Fixed in Stage 1: the filter rail ───────────────────────────────────────
// Each of these pinned the bug until Stage 1 moved the rail onto Preact; they
// now hold the fix.

test("Fixed in Stage 1: Enter on a focused filter chip turns it on, and focus stays on it", async () => {
  const page = await openBoard();
  await page.locator('#filters .pill[data-value="red"]').focus();
  assert.equal(await focused(page), "button.pill[red]", "setup: the chip has focus");
  await pressEnter(page, '#filters .pill.active[data-value="red"]', "the chip turning on");

  assert.equal(await focused(page), "button.pill.active[red]", "focus stays on the chip it just turned on");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Fixed in Stage 1: a poll that brings an item keeps the filter chips as the same elements", async () => {
  const page = await openBoard();
  const redCount = async () => Number(await page.textContent('#filters .pill[data-value="red"] .count'));
  const before = await redCount();
  await page.evaluate(() => { window.__chip = document.querySelector('#filters .pill[data-value="red"]'); });

  await pollBringsAnItem(page);
  assert.equal(await redCount(), before + 1, "setup: the chip counts the new item, so any rail had to redraw it");

  const same = await page.evaluate(() => window.__chip === document.querySelector('#filters .pill[data-value="red"]'));
  assert.equal(same, true, "the same chip element, now showing the new count");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Fixed in Stage 1: in the phone drawer, Enter on a focused chip turns it on, and focus stays on it", async () => {
  // The drawer is the rail's second copy (#filters-mobile), drawn by the same
  // code. At phone width the toolbar's Filters button opens it.
  const page = await openBoard();
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.waitForSelector(".filter-drawer.is-open", { state: "attached" });
  await page.locator('#filters-mobile .pill[data-value="red"]').focus();
  assert.equal(await focused(page), "button.pill[red]", "setup: the drawer's chip has focus");
  await pressEnter(page, '#filters-mobile .pill.active[data-value="red"]', "the drawer's chip turning on");

  assert.equal(await focused(page), "button.pill.active[red]", "focus stays on the drawer's chip");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Fixed in Stage 1: a poll that adds a row above the focused chip, and a chip before it, leaves focus where it was", async () => {
  // Runs last in its group: the item it adds waits to be tagged forever (no
  // worker here), so every later test also sees the status row it brings.
  const page = await openBoard();
  await page.locator('#filters .pill[data-value="red"]').focus();
  assert.equal(await focused(page), "button.pill[red]", "setup: the chip has focus");
  const before = await page.evaluate(() => {
    window.__chip = document.querySelector('#filters .pill[data-value="red"]');
    return {
      statusRow: !!document.querySelector("#filters .facet-untagged"),
      amber: !!document.querySelector('#filters .pill[data-value="amber"]'),
    };
  });
  assert.deepEqual(before, { statusRow: false, amber: false }, "setup: no status row yet, and no amber chip");

  // An item waiting to be tagged, tagged amber by hand. The next poll brings
  // the status row ("Unprocessed") above every facet row, and the amber chip
  // ahead of red in red's own row: the two changes that need keys (rows keyed
  // by facet, chips by value) to leave red's element where it is.
  await seedInstance(app.db, boardId, "pending", { tags: ["color/amber"] });
  try {
    await page.waitForSelector('#filters .pill[data-value="amber"]', { timeout: 12000 });
  } catch {
    throw new Error("the amber chip didn't reach the rail within 12s. Is the page still checking every 4s?");
  }
  assert.ok(await page.$("#filters .facet-untagged"), "setup: the status row appeared above");

  const after = await page.evaluate(() => window.__chip === document.querySelector('#filters .pill[data-value="red"]'));
  assert.deepEqual({ focus: await focused(page), sameElement: after }, { focus: "button.pill[red]", sameElement: true },
    "focus stays on red, and red is the same element");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

// ── Fixed in Stage 2: the toolbar ───────────────────────────────────────────
// Each of these pinned the bug until Stage 2 moved the toolbar onto Preact;
// they now hold the fix.

test("Fixed in Stage 2: Enter on the focused favorites button turns it on, and focus stays on it", async () => {
  const page = await openBoard();
  await page.locator(".tool-btn.fav").focus();
  assert.equal(await focused(page), "button.tool-btn.fav", "setup: the button has focus");
  await pressEnter(page, ".tool-btn.fav.active", "the favorites button turning on");

  assert.equal(await focused(page), "button.tool-btn.fav.active", "focus stays on the button it just turned on");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Fixed in Stage 2: a poll that brings an item leaves the search caret where it was, and keeps the jobs chip", async () => {
  const page = await openBoard();
  const box = page.locator(".search-box input");
  // Two steps, not one keystroke per character: this is the longest setup in
  // the file, and it has to finish before the page's first poll (see openBoard).
  await box.fill("red chairs");
  await box.evaluate((el) => el.setSelectionRange(3, 3));
  const caret = await box.evaluate((el) => ({ focused: el === document.activeElement, caret: el.selectionStart }));
  assert.deepEqual(caret, { focused: true, caret: 3 }, "setup: the box has focus, with the caret after 'red'");
  const jobsCount = async () => Number(await page.textContent(".jobs-chip .jobs-chip-count"));
  const before = await jobsCount();
  await page.evaluate(() => { window.__chip = document.querySelector(".jobs-chip"); });

  await pollBringsAnItem(page);
  assert.equal(await jobsCount(), before + 1, "setup: the jobs chip counts the new item, so any toolbar had to redraw it");

  // The box is the same element and its text already matches state, so the
  // repaint leaves the text, the focus and the caret alone.
  const search = await page.evaluate(() => {
    const el = document.querySelector(".search-box input");
    return { focused: el === document.activeElement, text: el.value, caret: el.selectionStart };
  });
  assert.deepEqual(search, { focused: true, text: "red chairs", caret: 3 }, "the caret stays after 'red'");
  // The same chip, which is what lets its tooltip stay open. The tooltip
  // itself is something no test can see.
  const same = await page.evaluate(() => window.__chip === document.querySelector(".jobs-chip"));
  assert.equal(same, true, "the same jobs chip, now counting the new item");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Fixed in Stage 2: with the plus menu open, a poll leaves its caret reading open, and Escape hands focus back to it", async () => {
  const page = await openBoard();
  await page.locator(".plus-caret").focus();
  await pressEnter(page, ".dropdown", "the plus menu opening");
  assert.equal(await page.locator('.plus-caret[aria-expanded="true"]').count(), 1, "setup: the open menu marks its caret open");
  const count = await resultCount(page);

  await pollBringsAnItem(page);
  assert.notEqual(await resultCount(page), count, "setup: the result count moved, so any toolbar had to redraw");
  assert.equal(await page.locator(".dropdown").count(), 1, "setup: the menu is still open after the poll");
  assert.equal(await page.locator('.plus-caret[aria-expanded="true"]').count(), 1, "still marked open: it's still the same button");

  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".dropdown").count(), 0, "setup: Escape closed the menu");
  assert.equal(await focused(page), "button.tool-btn.plus-caret.dd-caret", "focus goes back to the caret");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Fixed in Stage 2: with the sort menu open, a poll leaves the sort button, so a second click just closes the menu", async () => {
  const page = await openBoard();
  await page.locator(".sort-btn").click();
  await page.waitForSelector(".dropdown.sort-pop");
  await page.evaluate(() => { window.__menu = document.querySelector(".dropdown.sort-pop"); });
  const count = await resultCount(page);

  await pollBringsAnItem(page);
  assert.notEqual(await resultCount(page), count, "setup: the result count moved, so any toolbar had to redraw");
  assert.equal(await page.evaluate(() => window.__menu.isConnected), true, "setup: the menu is still open after the poll");

  // The click lands on the menu's own button, which closes it. Before Stage 2
  // it landed on the button's replacement: outside the menu, which closed it,
  // and on a button with no menu, which opened another. The close happens in
  // the same call that would otherwise have opened the new one, so once the
  // first menu is gone there's nothing left to wait for.
  await page.locator(".sort-btn").click();
  await page.waitForFunction(() => !window.__menu.isConnected, null, { timeout: 5000 });
  assert.equal(await page.locator(".dropdown.sort-pop").count(), 0, "no new menu opened");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

// ── Fixed in Stage 4: the cards ─────────────────────────────────────────────
// Each of these pinned the bug until Stage 4 made the cards components that
// persist across repaints; they now hold the fix.

test("Fixed in Stage 4: a heart click keeps the card as the same element, with its buttons", async () => {
  // Before Stage 4 a heart changed the card's signature, so the repaint
  // rebuilt the card under the pointer: its buttons and tag chip vanished
  // until the next mouse move.
  const page = await openBoard();
  const card = page.locator("#grid .card[data-id]").first();
  await card.hover();
  await page.waitForSelector("#grid .card[data-id] .card-actions");
  await page.evaluate(() => { window.__card = document.querySelector("#grid .card[data-id]"); });
  await card.locator(".heart").click();
  await page.waitForSelector("#grid .card[data-id] .heart.on");
  const after = await page.evaluate(() => {
    const c = document.querySelector("#grid .card[data-id]");
    return { sameElement: c === window.__card, buttons: !!c.querySelector(".card-actions"), chip: !!c.querySelector(".tag-chip") };
  });
  assert.deepEqual(after, { sameElement: true, buttons: true, chip: true });
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
  // Hearts outlive the page; the next test starts with none.
  await card.locator(".heart").click();
  await page.waitForFunction(() => !document.querySelector("#grid .card .heart.on"));
});

test("Fixed in Stage 4: a poll that retags a card keeps its open tag pop", async () => {
  // Before Stage 4 the retag rebuilt the card, the pop's chip went with it,
  // and a new pop opened under the pointer (or none, if the pointer was on
  // the pop). The pop keeps the list it opened with: menus are built when
  // opened and thrown away when closed (D9), like the sort menu under a
  // changed button.
  const page = await openBoard();
  const card = page.locator("#grid .card[data-id]").first();
  await card.hover();
  await card.locator(".tag-chip").hover();
  await page.waitForSelector(".dropdown.tag-pop");
  const before = await page.evaluate(() => {
    window.__pop = document.querySelector(".dropdown.tag-pop");
    return document.querySelector("#grid .card[data-id] .tag-chip .tc").textContent;
  });
  // Someone retags the item through the API the tag editor uses (one more
  // tag: amber, which nothing else holds); the page's own poll brings it.
  // The first card is the newest item, so that's the row to retag.
  const { rows: [row] } = await app.db.query("SELECT id, tags FROM items WHERE board_id=$1 ORDER BY id DESC LIMIT 1", [boardId]);
  const was = typeof row.tags === "string" ? JSON.parse(row.tags) : (row.tags || []);
  assert.equal(before, String(was.length), "setup: the first card is the newest row");
  const res = await page.request.patch(`${app.base}/api/instances/${row.id}/tags`, { data: { tags: [...was, "color/amber"] } });
  assert.equal(res.status(), 200, "setup: the retag went through");
  try {
    await page.waitForFunction((n) => document.querySelector("#grid .card[data-id] .tag-chip .tc")?.textContent !== n, before, { timeout: 12000 });
  } catch {
    throw new Error(`the retag didn't reach the card within 12s (chip still ${before}). Is the page still checking every 4s?`);
  }
  // The same pop, and its button is the chip on the card: before Stage 4 the
  // pop could outlive its chip by holding its last place under a detached
  // button (dropdown.js), which looked the same until the next scroll.
  const after = await page.evaluate(() => ({
    open: !!document.querySelector(".dropdown.tag-pop"),
    samePop: document.querySelector(".dropdown.tag-pop") === window.__pop,
    chipOpen: document.querySelector("#grid .card[data-id] .tag-chip")?.getAttribute("aria-expanded"),
    chip: document.querySelector("#grid .card[data-id] .tag-chip .tc").textContent,
  }));
  assert.deepEqual(after, { open: true, samePop: true, chipOpen: "true", chip: String(was.length + 1) });
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
  // Put the tags back for the tests after this one.
  await page.request.patch(`${app.base}/api/instances/${row.id}/tags`, { data: { tags: was } });
});

test("Fixed in Stage 4: a poll that brings an item keeps keyboard focus on a card's select button", async () => {
  // Before Stage 4 any change to the grid re-inserted every card, and a
  // re-inserted element loses focus.
  const page = await openBoard();
  await page.focus("#grid .card[data-id] .sel-cb");
  assert.equal(await focused(page), "button.sel-cb", "setup: the select button has focus");
  await pollBringsAnItem(page);
  assert.equal(await focused(page), "button.sel-cb");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Fixed in Stage 4: a thumbnail that fails is asked for once, not on every tick", async () => {
  // Before Stage 4 a failed picture removed its card, the next repaint found
  // the element gone and built it again, and the picture was requested on
  // every tick for as long as the page was open.
  const page = await openBoard();
  let requests = 0;
  await page.route("**/thumbnails/broken.png.webp", (r) => { requests++; r.fulfill({ status: 404, body: "" }); });
  const before = await page.evaluate(() => document.querySelectorAll("#grid .card[data-id]").length);
  const { eid } = await seedInstance(app.db, boardId, "tagged", {
    tags: ["color/red", "size/small"],
    payload: { files: [{ name: "broken.png", original_name: "broken.png", w: 10, h: 10 }] },
  });
  try {
    // The poll brings the card and its picture is asked for; it fails, and
    // the card draws nothing, so the count is back where it was.
    const deadline = Date.now() + 12000;
    while (requests === 0 && Date.now() < deadline) await page.waitForTimeout(200);
    assert.equal(requests, 1, "setup: the poll brought the item and its picture was asked for");
    await page.waitForTimeout(9000); // two more ticks
    assert.equal(requests, 1, "asked for once");
    assert.equal(await page.evaluate(() => document.querySelectorAll("#grid .card[data-id]").length), before, "and its card draws nothing");
    assert.deepEqual(page.errors, []);
  } finally {
    // The item outlives the page, and every page after this one would ask
    // the real server for its picture and get a 404 it didn't expect.
    await page.request.delete(`${app.base}/api/items/${eid}`);
  }
});

// ── Fixed in Stage 5: the repaints ──────────────────────────────────────────
// Each write below changed state without asking for a repaint, so the page
// showed it only at the next poll tick or the header's 20s tick. Since Stage 5
// the write is the repaint. Each reads its answer in the moment the write
// lands (a poll tick landing first would otherwise hide the bug).

test("Fixed in Stage 5: re-adding an item from the lightbox to the crate you're filtered on brings its card back at once", async () => {
  // Before Stage 5 a crate toggle in the lightbox repainted the page only
  // when the item LEFT the crate the board is filtered on: adding it back
  // changed nothing on screen until the next poll, so its card stayed gone.
  const page = await openBoard(crateBoardId);
  // The seeded items have no files: the lightbox's picture gets a pixel.
  await page.route("**/gallery/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
  await page.click(".crates-btn");
  await page.locator(".crate-pop .dd-row").filter({ hasText: "keep" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#grid .card[data-id]").length === 1);
  await page.locator("#grid .card[data-id]").first().click();
  await page.waitForSelector("#lightbox-crate:not([hidden])");
  await page.click("#lightbox-crate");
  const row = page.locator(".crate-pop .dd-row").filter({ hasText: "keep" });
  assert.equal(await row.locator(".cb-input").isChecked(), true, "setup: the item is in the crate");
  await row.click(); // out: the card leaves the filtered grid
  await page.waitForFunction(() => !document.querySelector("#grid .card[data-id]"), null, { timeout: 5000 });
  // The row ticks its box on the click, before the server answers. The
  // lightbox hears about the rejoin once it has landed (crates.js), so the
  // grid is read then.
  await page.evaluate(() => {
    window.__rejoined = null;
    document.addEventListener("app:lightbox-crate-changed", () => {
      window.__rejoined = { cards: document.querySelectorAll("#grid .card[data-id]").length };
    }, { once: true });
  });
  await row.click(); // and back in
  const back = await page.waitForFunction(() => window.__rejoined, null, { timeout: 5000 }).then((h) => h.jsonValue());
  assert.deepEqual(back, { cards: 1 }, "the card is back in the moment the item rejoined");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Fixed in Stage 5: Find similar by meaning takes a typed search's spinner down at once", async () => {
  // Before Stage 5 it cleared the search's loading flag without a repaint,
  // so the typed search's spinner stayed up until the similar results came.
  const page = await openBoard();
  const hold = async (r) => { await new Promise((res) => setTimeout(res, 3000)); await r.continue().catch(() => {}); };
  await page.route("**/api/search?**", hold);
  await page.route("**/api/search/similar?**", hold);
  const box = page.locator(".search-box input");
  await box.fill("red");
  await box.press("Enter");
  await page.waitForSelector(".search-spinner");
  const card = page.locator("#grid .card[data-id]").first();
  await card.hover();
  await card.locator(".tag-chip").hover();
  await page.getByText("Find similar by meaning").click();
  assert.equal(await page.evaluate(() => !!document.querySelector(".search-spinner")), false,
    "the spinner went with the search it belonged to");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 5: a crate made from a card's crate menu draws the toolbar's Crates button the moment it exists", async () => {
  // The board has no crate, so no Crates button: the first one draws it.
  // Before Stage 5 the crate was pushed onto the list and the button came
  // with the repaint after the card's membership landed. The crate joins the
  // list as a new list now, a write the page draws on its own, so the button
  // is read the moment the crate exists: when the page asks to put the card
  // in it. (A crate pushed onto the old list would be drawn only by whatever
  // repaints next.)
  const page = await openBoard(rowsBoardId);
  assert.equal(await page.$(".crates-btn"), null, "setup: no crate, no button");
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = function (url, ...rest) {
      if (/\/api\/crates\/\d+\/items\//.test(String(url)) && !window.__atJoin) {
        window.__atJoin = { button: !!document.querySelector(".crates-btn") };
      }
      return real.call(this, url, ...rest);
    };
  });
  const card = page.locator("#grid .card[data-id]").first();
  await card.hover();
  await card.locator(".act.crate").click();
  const input = page.locator(".crate-pop .dd-input");
  await input.fill("picks");
  await input.press("Enter");
  const drawn = await page.waitForFunction(() => window.__atJoin, null, { timeout: 5000 }).then((h) => h.jsonValue());
  assert.deepEqual(drawn, { button: true });
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

// ── Stays true: right today, and a later stage could break it ───────────────

test("Stays true: a poll that brings an item leaves every card already on the grid in place", async () => {
  const page = await openBoard();
  const before = await page.evaluate(() => {
    window.__cards = [...document.querySelectorAll("#grid .card[data-id]")].map((c) => [c, c.dataset.id]);
    return window.__cards.length;
  });
  assert.ok(before > 0, "setup: the grid has cards");

  await pollBringsAnItem(page);
  const after = await page.evaluate(() => {
    const now = new Set(document.querySelectorAll("#grid .card[data-id]"));
    return { cards: now.size, kept: window.__cards.filter(([c, id]) => now.has(c) && c.dataset.id === id).length };
  });
  assert.equal(after.cards, before + 1, "setup: the new item has a card");
  // Stage 4 rewrote the cards as components keyed by item id, and keeps this.
  // Each element must still show its item: without the keys the elements
  // would survive too, shifted one item along.
  assert.equal(after.kept, before, "every card that didn't change is still the same element, showing the same item");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Stays true: flipping to the rows view and back shows each view, every time", async () => {
  // Right before Stage 4, broken by it, fixed in its second pass: each view
  // skips a draw when nothing it reads has moved, and a flip moves nothing
  // either reads, so each kept its own key and a flip back left the view you
  // had just left on the page (the rows, under the grid's button).
  const page = await openBoard(rowsBoardId);
  const shows = () => page.evaluate(() => ({
    rows: document.querySelectorAll("#grid > .entity-row").length,
    cards: document.querySelectorAll("#grid > .card[data-id]").length,
  }));
  assert.deepEqual(await shows(), { rows: 0, cards: 2 }, "setup: the grid, a card per entity");
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await page.click(".view-btn");
    seen.push(await shows());
  }
  assert.deepEqual(seen, [{ rows: 2, cards: 0 }, { rows: 0, cards: 2 }, { rows: 2, cards: 0 }]);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Stays true: turning a lens on from the saved-filters menu keeps the menu open on its button", async () => {
  // The toggle repaints the toolbar with the menu open. Until Stage 2 the
  // menu kept its button only because it was opened with a function that
  // found the button's replacement; since Stage 2 the button stays put, and
  // that function is gone.
  const page = await openBoard();
  await page.locator(".split-arrow").click();
  await page.waitForSelector(".dropdown");
  const lens = page.getByRole("switch", { name: "Show pattern odds" });
  assert.equal(await lens.isChecked(), false, "setup: the lens starts off");

  await page.getByText("Show pattern odds").click();
  assert.equal(await lens.isChecked(), true, "setup: the lens turned on");

  assert.equal(await page.locator(".dropdown").count(), 1, "the menu is still open");
  assert.equal(await page.locator('.split-arrow[aria-expanded="true"]').count(), 1, "its button still reads open");
  const gap = await page.evaluate(() => {
    const button = document.querySelector(".split-arrow").getBoundingClientRect();
    const menu = document.querySelector(".dropdown").getBoundingClientRect();
    return Math.round(menu.top - button.bottom);
  });
  assert.ok(gap >= 0 && gap < 20, `the menu still sits just under its button (gap ${gap}px)`);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Stays true: a menu's button changes under the open menu, and still reads open with the menu under it", async () => {
  // Turning the cluster lens off clears a cluster selection (patterns.js), so
  // the Filters count drops: the saved-filters arrow loses its dark look and
  // moves left, while its menu stays open by design. Until Stage 2 the rebuilt
  // arrow was found, re-marked open, and the menu moved under it. Now the
  // arrow stays, marked through aria-expanded (plan D10): a class set from
  // outside would be erased the moment Preact rewrites the button's classes.
  // And the lens row moves the menu itself (filterconfigs.js).
  const page = await openBoard(clusterBoardId);
  await page.locator(".split-arrow").click();
  await page.waitForSelector(".dropdown");
  await page.getByText("Clusters by tags").click();
  await page.keyboard.press("Escape"); // the menu hangs over the rail's new row
  await page.locator('#filters .pill[data-facet="~clusters"]').first().click();
  assert.equal(await page.locator(".split-arrow.active").count(), 1, "setup: a cluster chip is on, so the arrow is dark");

  await page.locator(".split-arrow").click();
  await page.waitForSelector(".dropdown");
  const arrowLeft = () => page.$eval(".split-arrow", (el) => Math.round(el.getBoundingClientRect().left));
  const before = await arrowLeft();
  await page.getByText("Clusters by tags").click();
  assert.equal(await page.locator(".split-arrow.active").count(), 0, "setup: the lens went off, taking the chip and the arrow's dark look with it");
  assert.equal(await page.locator(".dropdown").count(), 1, "setup: the menu is still open");
  assert.ok(await arrowLeft() < before, "setup: the Filters label lost its count, so the arrow moved left");

  await page.waitForTimeout(250); // the caret turns over 0.12s
  const arrow = await page.evaluate(() => {
    const el = document.querySelector(".split-arrow");
    return {
      expanded: el.getAttribute("aria-expanded"),
      caret: getComputedStyle(el.querySelector("svg")).transform,
      // The menu lines its left edge up with the arrow's (align: "start").
      menuOffBy: Math.round(document.querySelector(".dropdown").getBoundingClientRect().left - el.getBoundingClientRect().left),
    };
  });
  assert.deepEqual(arrow, { expanded: "true", caret: "matrix(-1, 0, 0, -1, 0, 0)", menuOffBy: 0 }, "the arrow still reads open, caret turned, and the menu still hangs from it");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Stays true: a heart on a card moves the favorites count at once", async () => {
  // Since Stage 3 the favorites count is cached, and a heart writes the item
  // in place, so it has to announce the change (itemsChanged). Without that,
  // the count would stay put, quietly. The check this harness switches on
  // (filters.js checkCached) would throw on the same repaint too.
  const page = await openBoard();
  const favorites = () => page.textContent(".tool-btn.fav .count");
  assert.equal(await favorites(), "0", "setup: no favorites yet");
  const card = page.locator("#grid .card[data-id]").first();
  await card.hover(); // a card's heart comes with the hover
  await card.locator(".heart").click();
  await page.waitForSelector("#grid .card .heart.on");
  assert.equal(await favorites(), "1", "the count moved with the heart");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
  // Hearts outlive the page; the next test starts with none.
  await card.locator(".heart").click();
  await page.waitForFunction(() => !document.querySelector("#grid .card .heart.on"));
});

test("Stays true: clearing a search with its × puts the caret back in the box", async () => {
  // The × goes as the search clears, and a click had given it the focus.
  // Before Stage 2 the rebuilt box took the focus back because the × had
  // held it; since Stage 2 the × hands it to the box itself (toolbar.js).
  const page = await openBoard();
  await page.locator(".search-box input").fill("red");
  await pressEnter(page, ".search-clear", "the search running");
  await page.click(".search-clear");
  await page.waitForSelector(".search-clear", { state: "detached" });

  const box = await page.evaluate(() => {
    const input = document.querySelector(".search-box input");
    return { focused: input === document.activeElement, text: input.value };
  });
  assert.deepEqual(box, { focused: true, text: "" }, "the search cleared, and the caret is in the box");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});
