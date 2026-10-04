// The lightbox's buttons and its Details panel, against what happens to their
// item while you look at it (planning/lightbox-panel-plan.md, from Stage 0).
// Before the plan the buttons and the panel drew when you landed on an item
// and after their own clicks, and never followed a change made anywhere else;
// the panel kept its file by position; and its download and file info spoke
// for files a stock item doesn't have. The plan makes the lightbox follow its
// item, one stage at a time, and each stage turns its own tests here into
// tests of the fix: Stage 1's buttons, file and item, Stage 2's panel and
// Stage 3's downloads.
//
// The ui-updates tests' two rules (ui-updates.test.js, the plan's D10):
//
// Real triggers only: a click, a key, or a change made through the API as the
// same user, the way another tab would, or written into the database the way
// the worker writes a retag that lands (`land`), reaching the page through its
// own poll. Both refusals below are the server's own, caused for real.
//
// A test starts by stating what happens TODAY. It checks its setup on the
// way, so it passes only if the setup worked and the bug happened, and its
// "today" line is the one a fix makes fail. The stage that fixes it rewrites
// it to the fixed behavior.
//
// Grouped by the stage that fixes them; the last ones were right from the
// start, and a later stage could break them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, servePixels, panelSettled, holdPolls } from "./harness.js";
import { req } from "../helpers.js";
import { updateBoard, createEntity, insertItem, createCrate, addCrateItems, setItemEntities } from "../../server/db.js";

let app, user;
const boards = {};
const ents = new Map(); // a card's name → its entity id
const files = new Map(); // a card's name → its files' instance ids, oldest first

const photo = (name) => ({ name, w: 1200, h: 800, kind: "image" });
const CHART = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"; // a price chart's stored name

// A change made elsewhere: through the API as the same user, the way another
// tab would. Sent from outside the page, so the page's requests are all its
// own. Answers the status.
const elsewhere = (method, path, body) => req(app.base, method, path, { sid: user.sid, body }).then((r) => r.status);

// A card and its files, the shape an upload takes. `seedInstance` (helpers.js)
// makes items with no file, which draw and open as ticker tiles. `fields` are
// each file's own, `connector` the card's.
async function add(boardId, name, photos, { status = "tagged", tags = ["color/red"], fields = {}, reasoning = null, connector = {} } = {}) {
  const eid = await createEntity(app.db, boardId, { identity: name, fields: connector });
  const ids = [];
  for (const file of photos) {
    const id = await insertItem(app.db, boardId, { identity: name, files: [file], fields }, status, eid);
    await app.db.query("UPDATE items SET tags=$1 WHERE id=$2", [JSON.stringify(tags), id]);
    if (reasoning) await app.db.query("UPDATE items SET tag_reasoning=$1 WHERE id=$2", [JSON.stringify(reasoning), id]);
    ids.push(id);
  }
  ents.set(name, eid);
  files.set(name, ids);
}

before(async () => {
  app = await openApp();
  ({ user, boardId: boards.main } = await app.signIn({ boardName: "Lightbox board" }));
  await updateBoard(app.db, boards.main, {
    // Two facets: on a one-facet board, a retag of "just this facet" is the
    // whole retag (the route reads a scope of every facet as no scope).
    facets: [
      { key: "color", label: "Color", values: ["red", "blue", "green"] },
      { key: "size", label: "Size", values: ["big", "small"] },
    ],
  });
  await add(boards.main, "Hearted", [photo("hearted.jpg")]);
  await add(boards.main, "Watched", [photo("watched.jpg")]);
  await add(boards.main, "Reasoned", [photo("reasoned.jpg")], {
    fields: { who: { v: "Someone", why: "The person in the photo." }, file_type: { v: "image", src: "file" } },
    reasoning: { description: "A red picture of someone, described at enough length to take a line or two.", color: "It is red." },
  });
  await add(boards.main, "Retagged", [photo("retagged.jpg")]);
  await add(boards.main, "Trio", [photo("trio-a.jpg"), photo("trio-b.jpg"), photo("trio-c.jpg")]);
  await add(boards.main, "Quad", [photo("quad-1.jpg"), photo("quad-2.jpg"), photo("quad-3.jpg"), photo("quad-4.jpg")]);
  await add(boards.main, "Race", [photo("race-a.jpg"), photo("race-b.jpg")]);
  await add(boards.main, "Pair", [photo("pair-a.jpg"), photo("pair-b.jpg")]);
  await add(boards.main, "Queued", [photo("queued.jpg")], { status: "pending" });
  // Three in a row, newest first in the list: open the first, and the second
  // (in the queue) leaves the page before you page on.
  await add(boards.main, "Skip C", [photo("skip-c.jpg")]);
  await add(boards.main, "Skip B", [photo("skip-b.jpg")], { status: "pending" });
  await add(boards.main, "Skip A", [photo("skip-a.jpg")]);
  await add(boards.main, "Steady", [photo("steady.jpg")]);
  await add(boards.main, "Menued", [photo("menued.jpg")]);
  await add(boards.main, "Paged", [photo("paged.jpg")]);
  await add(boards.main, "Calm", [photo("calm.jpg")]);
  await add(boards.main, "Nearby", [photo("nearby.jpg")]);
  await add(boards.main, "Detected", [photo("detected.jpg")], {
    fields: { objects: { v: [{ label: "cat", score: 0.91, box: [0.1, 0.1, 0.6, 0.5] }], why: "Detected: cat" } },
  });
  await add(boards.main, "Pinned", [photo("pinned.jpg")]);
  await add(boards.main, "Unpinned", [photo("unpinned.jpg")]);
  // Stage 2's: retags landing, a failed request, and panels long enough to
  // scroll. Long A and Long B sit side by side in the list, and their own
  // half (thirty connector fields) is long enough to scroll on its own, so a
  // move keeps its place without the file's half, which waits.
  await add(boards.main, "Landed", [photo("landed.jpg")], { reasoning: { color: "It is red." } });
  await add(boards.main, "Queuer", [photo("queuer.jpg")], { reasoning: { color: "It is red." } });
  await add(boards.main, "Failing", [photo("failing.jpg")]);
  const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i).padStart(2, "0")}`, { v: `value ${i}`, why: `Why ${i}.` }]));
  await add(boards.main, "Long", [photo("long.jpg")], { fields: many(30), reasoning: { color: "It is red." } });
  await add(boards.main, "Long B", [photo("long-b.jpg")], { connector: many(30) });
  await add(boards.main, "Long A", [photo("long-a.jpg")], { connector: many(30) });
  // From Stage 2's second pass: three in a row, newest first in the list, the
  // middle one without AI-extracted fields (so without Re-extract); and one
  // to retag elsewhere.
  const who = { who: { v: "Someone", why: "The person in the photo." } };
  await add(boards.main, "Fielded B", [photo("fielded-b.jpg")], { fields: who });
  await add(boards.main, "Plain", [photo("plain.jpg")]);
  await add(boards.main, "Fielded A", [photo("fielded-a.jpg")], { fields: who });
  await add(boards.main, "Scoped", [photo("scoped.jpg")]);
  await add(boards.main, "Scoped too", [photo("scoped-too.jpg")]);
  // Stage 4's: two two-file cards, for the menus another file closes.
  await add(boards.main, "Crated pair", [photo("crated-a.jpg"), photo("crated-b.jpg")]);
  await add(boards.main, "Menu pair", [photo("menu-a.jpg"), photo("menu-b.jpg")]);
  // Stage 3's: a card with one file, and an SVG, which the server stores as
  // WebP (server/sources/image.js).
  await add(boards.main, "Single", [photo("single.jpg")]);
  await add(boards.main, "Vector", [{ name: "vector.webp", original_name: "vector.svg", w: 1200, h: 800, kind: "image" }]);

  // A board with a crate holding one of its two cards.
  ({ boardId: boards.crate } = await app.signIn({ boardName: "Crate board" }));
  await add(boards.crate, "Kept", [photo("kept.jpg")]);
  await add(boards.crate, "Other", [photo("other.jpg")]);
  const crate = await createCrate(app.db, user.id, boards.crate, "keep");
  await addCrateItems(app.db, user.id, crate.id, [ents.get("Kept")]);

  // A board whose card face is the file added last.
  ({ boardId: boards.face } = await app.signIn({ boardName: "Face board" }));
  await app.db.query("UPDATE boards SET mapping=$1 WHERE id=$2", [JSON.stringify({
    card: { by: "identity" },
    face: { source: "file", prefer: "image", pick: "latest" },
    fields: [{ key: "identity", kind: "text", source: "extract", instruction: "the title" }],
  }), boards.face]);
  await add(boards.face, "Duo", [photo("duo-old.jpg"), photo("duo-new.jpg")]);

  // A board where two cards share one file, as a board that classifies puts
  // a file in every card that claimed it: side by side, so paging from one
  // shows the same picture.
  ({ boardId: boards.shared } = await app.signIn({ boardName: "Shared board" }));
  await add(boards.shared, "Shared X", [photo("shared.jpg")], {
    fields: { objects: { v: [{ label: "cat", score: 0.91, box: [0.1, 0.1, 0.6, 0.5] }], why: "Detected: cat" } },
  });
  ents.set("Shared Y", await createEntity(app.db, boards.shared, { identity: "Shared Y" }));
  await setItemEntities(app.db, files.get("Shared X")[0], [ents.get("Shared X"), ents.get("Shared Y")]);

  // A board with a file field that prints by the media catalog's format.
  ({ boardId: boards.timed } = await app.signIn({ boardName: "Timed board" }));
  await updateBoard(app.db, boards.timed, { mapping: { fields: [{ key: "duration", kind: "number", source: "file", fn: "duration" }] } });
  await add(boards.timed, "Timed", [photo("timed.jpg")], { fields: { duration: { v: 2211.6, src: "file", kind: "number" } } });

  // A stocks board with a ticker tile: a card with no file at all.
  ({ boardId: boards.ticker } = await app.signIn({ boardName: "Ticker board" }));
  await app.db.query("UPDATE boards SET mapping=$1 WHERE id=$2", [JSON.stringify({
    input: { connector: "stocks" },
    face: { source: "connector", producer: "price-chart", period: "5y" }, fields: [],
  }), boards.ticker]);
  const nvda = await createEntity(app.db, boards.ticker, { identity: "nvda", displayName: "NVIDIA", symbol: "NVDA" });
  await insertItem(app.db, boards.ticker, { identity: "nvda", files: [], fields: {} }, "tagged", nvda);
  ents.set("NVIDIA", nvda);
  // And one whose face is its price chart, a picture the app drew itself, as
  // the worker stores one (generateFace): a random name with no extension.
  const aapl = await createEntity(app.db, boards.ticker, { identity: "aapl", displayName: "Apple", symbol: "AAPL" });
  await insertItem(app.db, boards.ticker, { identity: "aapl", files: [{ name: CHART, kind: "image", generated: true, w: 600, h: 300 }], fields: {} }, "tagged", aapl);
  ents.set("Apple", aapl);
});
after(() => app?.close());

// The board in a fresh page, with a pixel for every picture the cards and the
// lightbox ask for (`pixels: false` leaves them to the server). The page
// starts on /api/me, so the routes are in place before the board first loads
// (sorted-load.test.js does the same). `before` adds a test's own routes
// there, as `holdPolls` does when no poll may land at all. `polling` checks
// the precondition the tests of changes made elsewhere lean on: the test
// server's embed backlog keeps the page checking every 4s (ui-updates.test.js
// says the same).
async function openBoard(boardId, { pixels = true, polling = false, before = null } = {}) {
  const page = await app.open("/api/me", { sid: user.sid });
  if (pixels) await servePixels(page, { thumbnails: true });
  await before?.(page);
  await page.goto(`${app.base}/?board=${boardId}`);
  await page.waitForSelector("#grid .card[data-id]");
  if (polling) {
    assert.equal(await page.evaluate(() => !!document.querySelector(".jobs-chip.busy")), true,
      "precondition: an embed backlog keeps the page checking every 4s");
  }
  return page;
}

async function openCard(page, name) {
  await page.locator(`#grid .card[data-id="${ents.get(name)}"]`).click();
  await page.waitForSelector("#lightbox:not([hidden])");
}

async function openPanel(page) {
  await page.click("#lightbox-info");
  await panelSettled(page, true);
}

// The picture on the stage, by the address it was asked for at.
const shown = (page) => page.evaluate(() => document.querySelector("#lightbox-stage img")?.getAttribute("src") ?? null);
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll("#toast-wrap .toast-msg")].map((t) => t.textContent));
// Whether a toast saying this comes up in the time given, as a yes or no.
const toastSays = (page, text, timeout = 5000) => page.waitForFunction(
  (text) => [...document.querySelectorAll("#toast-wrap .toast-msg")].some((t) => t.textContent.includes(text)),
  text, { timeout },
).then(() => true, () => false);
// A menu closing: it fades out before it leaves the page.
const menuGone = (page) => page.waitForSelector(".dd-row", { state: "detached", timeout: 10000 }).catch(() => {});
// Every download link in the panel, wherever it sits: its header, the item's
// name, or a file's row (by that file's name).
const downloads = (page) => page.evaluate(() => [...document.querySelectorAll("#lightbox-panel a[download]")].map((a) => ({
  at: a.closest(".lbp-head") ? "header" : a.closest(".lbp-meta-name") ? "name"
    : a.closest(".lbp-file-row")?.querySelector(".lbp-file-name").textContent ?? "elsewhere",
  href: a.getAttribute("href"),
  name: a.download,
})));
// The selected file's info rows, as "key value".
const infoRows = (page) => page.evaluate(() => [...document.querySelectorAll("#lightbox-panel-body .lbp-meta-row")]
  .map((r) => [...r.children].map((c) => c.textContent).join(" ")));

// ── Fixed in Stage 1: the lightbox's buttons, its file and its item ────────

test("Fixed in Stage 1: a heart made elsewhere reaches the lightbox's heart", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Hearted");
  assert.equal(await page.textContent("#lightbox-fav span"), "0", "setup: no hearts");
  assert.equal(await elsewhere("POST", `/api/items/${ents.get("Hearted")}/favorite`), 200, "setup: hearted elsewhere");
  await page.waitForFunction((id) => document.querySelector(`#grid .card[data-id="${id}"] .heart.on .hc`)?.textContent === "1",
    ents.get("Hearted"), { timeout: 15000 }); // the poll brought it: the card's heart is lit
  assert.deepEqual(await page.evaluate(() => {
    const b = document.getElementById("lightbox-fav");
    return { on: b.classList.contains("on"), count: b.textContent.trim() };
  }), { on: true, count: "1" }, "the lightbox's heart reads 1, lit, with the card's");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 1: taking the item out of the filtered crate, from the lightbox, turns its crate button off", async () => {
  const page = await openBoard(boards.crate);
  await page.click(".crates-btn");
  await page.locator(".crate-pop .dd-row").filter({ hasText: "keep" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#grid .card[data-id]").length === 1);
  await openCard(page, "Kept");
  await page.waitForSelector(".crate-pop", { state: "detached" }); // the toolbar's, faded out
  const button = () => page.evaluate(() => {
    const b = document.getElementById("lightbox-crate");
    return { on: b.classList.contains("on"), count: b.textContent.trim() };
  });
  assert.deepEqual(await button(), { on: true, count: "1" }, "setup: in one crate");
  await page.click("#lightbox-crate");
  const row = page.locator(".crate-pop .dd-row").filter({ hasText: "keep" });
  assert.equal(await row.locator(".cb-input").isChecked(), true, "setup: its box is ticked");
  await holdPolls(page); // the click's own write, not a poll's
  await row.click(); // out of the crate: its card leaves the filtered grid
  // The same write turns the button off; a card that stays fails the line below.
  await page.waitForFunction(() => !document.querySelector("#grid .card[data-id]"), null, { timeout: 10000 }).catch(() => {});
  assert.deepEqual(await button(), { on: false, count: "" }, "the crate button turns off");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 1: on a board whose face is the file added last, opening the card shows that file", async () => {
  const page = await openBoard(boards.face);
  const face = await page.evaluate((id) => document.querySelector(`#grid .card[data-id="${id}"] img`)?.getAttribute("src"), ents.get("Duo"));
  assert.match(face || "", /duo-new/, "setup: the card shows the file added last");
  await openCard(page, "Duo");
  await page.waitForFunction(() => document.querySelector("#lightbox-stage img"));
  assert.equal(await shown(page), "gallery/duo-new.jpg", "the lightbox opens on the file the card shows");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 1: looking at the second of three files, removing the first stays on the second", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Trio");
  await openPanel(page);
  await page.locator("#lightbox-panel-body .lbp-file-name", { hasText: "trio-b.jpg" }).click();
  await page.waitForFunction(() => document.querySelector("#lightbox-stage img")?.getAttribute("src") === "gallery/trio-b.jpg");
  assert.equal(await page.textContent(".lbp-file-active .lbp-file-name"), "trio-b.jpg", "setup: on the second file");
  await page.locator(".lbp-file-row", { hasText: "trio-a.jpg" }).locator(".lbp-file-remove").click();
  await page.waitForFunction(() => document.querySelectorAll(".lbp-file-row").length === 2, null, { timeout: 5000 });
  assert.deepEqual({ shown: await shown(page), active: await page.textContent(".lbp-file-active .lbp-file-name") },
    { shown: "gallery/trio-b.jpg", active: "trio-b.jpg" }, "the picture and the panel stay on the second file");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 1: looking at the last of four files, removing it shows the new last", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Quad");
  await openPanel(page);
  await page.locator("#lightbox-panel-body .lbp-file-name", { hasText: "quad-4.jpg" }).click();
  await page.waitForFunction(() => document.querySelector("#lightbox-stage img")?.getAttribute("src") === "gallery/quad-4.jpg");
  await page.locator(".lbp-file-row", { hasText: "quad-4.jpg" }).locator(".lbp-file-remove").click();
  await page.waitForFunction(() => document.querySelectorAll(".lbp-file-row").length === 3, null, { timeout: 5000 });
  assert.deepEqual({ shown: await shown(page), active: await page.textContent(".lbp-file-active .lbp-file-name") },
    { shown: "gallery/quad-3.jpg", active: "quad-3.jpg" }, "the new last file, not the first");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 1: an item in the queue, deleted elsewhere, closes the lightbox as it leaves the page", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Queued");
  assert.equal(await elsewhere("DELETE", `/api/items/${ents.get("Queued")}`), 200, "setup: deleted elsewhere");
  // Two polls: data.js waits one more before sweeping an item this page
  // didn't upload itself.
  await page.waitForFunction((id) => !document.querySelector(`#grid .card[data-id="${id}"]`), ents.get("Queued"), { timeout: 20000 });
  assert.equal(await page.evaluate(() => document.getElementById("lightbox").hidden), true, "the lightbox closed with it");
  assert.ok((await toasts(page)).includes("That card isn't on this board any more"), "and says why");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 1: paging skips a card that has left the page since the lightbox opened", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Skip A");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getAttribute("#lightbox", "aria-label"), "Skip B", "setup: Skip B is next in the list you page through");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await elsewhere("DELETE", `/api/items/${ents.get("Skip B")}`), 200, "setup: the next card deleted elsewhere");
  await page.waitForFunction((id) => !document.querySelector(`#grid .card[data-id="${id}"]`), ents.get("Skip B"), { timeout: 20000 });
  assert.equal(await page.getAttribute("#lightbox", "aria-label"), "Skip A", "setup: still on the card it opened on");
  await page.keyboard.press("ArrowRight");
  assert.deepEqual(await page.evaluate(() => ({
    open: !document.getElementById("lightbox").hidden,
    on: document.getElementById("lightbox").getAttribute("aria-label"),
  })), { open: true, on: "Skip C" }, "paging went past the card that left, to the one after it");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 1: a card that leaves the page closes the menu open on the lightbox too", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Menued");
  await openPanel(page);
  await page.locator("#lightbox-panel-body button", { hasText: "Retag" }).click();
  await page.locator(".dd-row", { hasText: "Everything" }).waitFor();
  // Elsewhere, queued for a retag and then deleted: the page sweeps only a
  // card it has seen in the queue, so the delete waits for the poll to bring
  // the queued state.
  assert.equal(await elsewhere("POST", `/api/instances/${files.get("Menued")[0]}/retag`), 200, "setup: queued elsewhere");
  await page.waitForSelector(`#grid .card[data-id="${ents.get("Menued")}"].loading`, { timeout: 15000 });
  assert.equal(await page.locator(".dd-row", { hasText: "Everything" }).count(), 1, "setup: the Retag menu is still open");
  assert.equal(await elsewhere("DELETE", `/api/items/${ents.get("Menued")}`), 200, "setup: deleted elsewhere");
  await page.waitForFunction((id) => !document.querySelector(`#grid .card[data-id="${id}"]`), ents.get("Menued"), { timeout: 20000 });
  assert.equal(await page.evaluate(() => document.getElementById("lightbox").hidden), true, "setup: the lightbox closed with the card");
  await menuGone(page);
  assert.equal(await page.locator(".dd-row").count(), 0, "and the Retag menu went with it");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 1: paging with the Retag menu open closes the menu, so a pick can't retag the card you left", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Paged");
  await openPanel(page);
  await page.locator("#lightbox-panel-body button", { hasText: "Retag" }).click(); // drawn with the file's details (D11)
  await page.locator(".dd-row", { hasText: "Everything" }).waitFor();
  await page.keyboard.press("ArrowRight"); // the menu takes only up, down, Enter, Space and Escape
  assert.notEqual(await page.getAttribute("#lightbox", "aria-label"), "Paged", "setup: paged on");
  await menuGone(page);
  assert.equal(await page.locator(".dd-row").count(), 0, "the Retag menu closed with the move");
  assert.deepEqual(page.errors, []);
});

// A two-file card open on its second file, which is then removed elsewhere:
// the poll brings the removal, and the lightbox moves on to the first.
async function onSecondFile(page, card, second) {
  await openCard(page, card);
  await openPanel(page);
  await page.locator("#lightbox-panel-body .lbp-file-name", { hasText: second }).click();
  await page.waitForFunction((b) => document.querySelector(".lbp-file-active .lbp-file-name")?.textContent === b, second);
}
async function secondRemovedElsewhere(page, card, first) {
  assert.equal(await elsewhere("DELETE", `/api/instances/${files.get(card)[1]}`), 200, "setup: its second file removed elsewhere");
  const moved = await page.waitForFunction((src) => document.querySelector("#lightbox-stage img")?.getAttribute("src") === src,
    `gallery/${first}`, { timeout: 15000 }).then(() => true, () => false);
  assert.equal(moved, true, "setup: the poll brought it, and the lightbox shows the first file");
}

test("Fixed in Stage 1: another file of the open item closes the Retag menu, which was for the file it left", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await onSecondFile(page, "Menu pair", "menu-b.jpg");
  await page.locator("#lightbox-panel-body button", { hasText: "Retag" }).click();
  await page.locator(".dd-row", { hasText: "Everything" }).waitFor();
  await secondRemovedElsewhere(page, "Menu pair", "menu-a.jpg");
  await menuGone(page);
  assert.equal(await page.locator(".dd-row").count(), 0, "the Retag menu closed with its file");
  assert.deepEqual(page.errors, []);
});

// ── Fixed in Stage 2: the panel ─────────────────────────────────────────────

// The file's half of the panel: its chips, and the reasons under them.
const chips = (page) => page.evaluate(() => [...document.querySelectorAll("#lightbox-panel-body .panel-chip")].map((c) => c.textContent));
const reasons = (page) => page.evaluate(() => [...document.querySelectorAll("#lightbox-panel-body .lbp-why")].map((p) => p.textContent));
// Whether the panel comes to show these chips in the time given, as a yes or no.
const comesToShow = (page, want, timeout = 10000) => page.waitForFunction(
  (want) => [...document.querySelectorAll("#lightbox-panel-body .panel-chip")].map((c) => c.textContent).join() === want,
  want.join(), { timeout },
).then(() => true, () => false);
// The Retag button, by what it says.
const retagButton = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll("#lightbox-panel-body button")].find((x) => /^(Queued|Retag)/.test(x.textContent.trim()));
  return { label: b.textContent.trim(), disabled: b.disabled };
});

// A retag landing, written the way the worker writes one (db.js), for the
// page's next poll to bring.
const land = (file, tags, reasoning) => app.db.query(
  "UPDATE items SET status='tagged', tags=$1, tag_reasoning=$2, tag_confidence='{}'::jsonb, undecided=FALSE, updated_at=$3 WHERE id=$4",
  [JSON.stringify(tags), JSON.stringify(reasoning), Date.now(), file],
);

// The page's next item poll asked from now on: back, merged and drawn. Asked
// after this is called, so it carries whatever the server held by then. A
// poll asks for the board's token count once its merge has drawn (data.js,
// pollTick), and nothing else asks for it, so that request is the sign.
function nextPoll(page) {
  let polled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { page.off("request", seen); reject(new Error("setup: no poll in 15s")); }, 15000);
    const seen = (r) => {
      if (/\/api\/items\?board=[^&]+&since=/.test(r.url())) polled = true;
      else if (polled && /\/api\/boards\/[^/]+\/tokens/.test(r.url())) {
        clearTimeout(timer);
        page.off("request", seen);
        resolve();
      }
    };
    page.on("request", seen);
  });
}

test("Fixed in Stage 2: with the panel open, tags changed elsewhere reach it", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Watched");
  await openPanel(page);
  await page.waitForFunction(() => document.querySelector("#lightbox-panel-body .panel-chip"));
  assert.deepEqual(await chips(page), ["red"], "setup: red");
  assert.equal(await elsewhere("PATCH", `/api/instances/${files.get("Watched")[0]}/tags`, { tags: ["color/green"] }), 200,
    "setup: retagged green elsewhere");
  await page.waitForSelector('#filters .pill[data-value="green"]', { timeout: 15000 }); // the poll brought it
  // With the file's details, which its new tags ask for again (D6, D11).
  assert.equal(await comesToShow(page, ["green"]), true, "the panel says green");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 2: the panel waits for the file's details, and draws the tags once, under them", async () => {
  const page = await openBoard(boards.main);
  let release;
  const held = new Promise((r) => (release = r));
  await page.route("**/api/instances/*/reasoning", async (route) => {
    await held;
    await route.continue().catch(() => {}); // a page closed in the meantime
  });
  await openCard(page, "Reasoned");
  await openPanel(page);
  const tagsTop = () => page.evaluate(() => [...document.querySelectorAll("#lightbox-panel-body .section-heading h2")]
    .find((h) => h.textContent === "Tags")?.getBoundingClientRect().top ?? null);
  assert.equal(await page.locator("#lightbox-panel-body .lbp-fields").count(), 0, "setup: no fields before the details");
  assert.equal(await tagsTop(), null, "no Tags heading before the details land");
  assert.equal(await page.textContent("#lightbox-panel-body .lbp-hint"), "Loading…", "but Loading…, under the file info");
  // Where the heading is the moment it's drawn, against where it ends up.
  await page.evaluate(() => {
    window.__tagsFirstTop = null;
    const body = document.getElementById("lightbox-panel-body");
    new MutationObserver((_, seen) => {
      const h = [...body.querySelectorAll(".section-heading h2")].find((x) => x.textContent === "Tags");
      if (!h) return;
      seen.disconnect();
      window.__tagsFirstTop = h.getBoundingClientRect().top;
    }).observe(body, { childList: true, subtree: true });
  });
  release();
  await page.waitForSelector("#lightbox-panel-body .lbp-desc", { timeout: 5000 });
  const first = await page.evaluate(() => window.__tagsFirstTop);
  assert.notEqual(first, null, "setup: the Tags heading was drawn");
  assert.equal(await tagsTop(), first, "and stays where it was drawn: the details came with it, not after");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 2: a Retag the server refuses gives the button back", async () => {
  // Elsewhere, a full retag is queued, so the file is no longer tagged and
  // decided, which a retag of some facets needs. The page doesn't hear of it
  // before the click (no poll lands from the start), so the panel still
  // offers one.
  const page = await openBoard(boards.main, { before: holdPolls });
  await openCard(page, "Retagged");
  await openPanel(page);
  const retag = page.locator("#lightbox-panel-body button", { hasText: "Retag" });
  await retag.waitFor(); // drawn with the file's details (D11)
  assert.equal(await elsewhere("POST", `/api/instances/${files.get("Retagged")[0]}/retag`), 200, "setup: a full retag queued elsewhere");
  const answer = page.waitForResponse((r) => r.request().method() === "POST" &&
    r.url().endsWith(`/api/instances/${files.get("Retagged")[0]}/retag`));
  await retag.click();
  await page.locator(".dd-row", { hasText: "Color" }).click();
  assert.equal((await answer).status(), 409, "setup: the server refused the retag of one facet");
  // The server's sentence, which requeueToast puts in a toast.
  assert.equal(await toastSays(page, "re-tagged on some facets"), true, "setup: the server's sentence, in a toast");
  assert.deepEqual(await retagButton(page), { label: "Retag", disabled: false }, "refused, and the button is Retag again");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 2: a removal the server refuses toasts the server's reason", async () => {
  // Elsewhere, the other file is removed: race-b is now the item's only one,
  // and the page doesn't hear of it before the click (no poll lands from the
  // start).
  const page = await openBoard(boards.main, { before: holdPolls });
  await openCard(page, "Race");
  await openPanel(page);
  assert.equal(await elsewhere("DELETE", `/api/instances/${files.get("Race")[0]}`), 200, "setup: race-a removed elsewhere");
  assert.equal(await page.locator(".lbp-file-row").count(), 2, "setup: the panel still lists both");
  const answer = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/api/instances/${files.get("Race")[1]}`));
  await page.locator(".lbp-file-row", { hasText: "race-b.jpg" }).locator(".lbp-file-remove").click();
  assert.equal((await answer).status(), 409, "setup: the server refused");
  // The route's own sentence (server.js).
  const reason = await toastSays(page, "cannot remove the only instance — delete the item instead");
  assert.equal(reason, true, `the server's reason (${JSON.stringify(await toasts(page))})`);
  assert.ok(!(await toasts(page)).includes("Couldn't remove file"), "not the panel's own words");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 2: a retag that lands elsewhere reaches the open panel, its chips with their reasons", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Landed");
  await openPanel(page);
  assert.equal(await comesToShow(page, ["red"]), true, "setup: red");
  assert.deepEqual(await reasons(page), ["It is red."], "setup: and why");
  // What the panel says why the moment its chip turns blue.
  await page.evaluate(() => {
    window.__turned = null;
    const body = document.getElementById("lightbox-panel-body");
    new MutationObserver((_, seen) => {
      if (body.querySelector(".panel-chip")?.textContent !== "blue") return;
      seen.disconnect();
      window.__turned = [...body.querySelectorAll(".lbp-why")].map((p) => p.textContent);
    }).observe(body, { childList: true, subtree: true, characterData: true });
  });
  await land(files.get("Landed")[0], ["color/blue"], { color: "It is blue." });
  assert.equal(await comesToShow(page, ["blue"], 15000), true, "the poll brought the retag to the panel");
  assert.deepEqual(await page.evaluate(() => window.__turned), ["It is blue."], "with its reasons, in the same draw");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 2: a retag queued from the panel keeps the panel as it was while it runs, and redraws once it lands", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Queuer");
  await openPanel(page);
  assert.equal(await comesToShow(page, ["red"]), true, "setup: red");
  const asked = [];
  page.on("request", (r) => { if (r.url().endsWith("/reasoning")) asked.push(r.url()); });
  await page.locator("#lightbox-panel-body button", { hasText: "Retag" }).click();
  await page.locator(".dd-row", { hasText: "Everything" }).click();
  assert.equal(await toastSays(page, "Retag queued"), true, "setup: queued");
  assert.deepEqual(await retagButton(page), { label: "Queued", disabled: true }, "Queued, while it runs");
  // The server cleared the file's tags and reasons as it queued the retag,
  // and a poll asked after that brings the cleared file.
  await nextPoll(page);
  assert.deepEqual({ chips: await chips(page), reasons: await reasons(page) }, { chips: ["red"], reasons: ["It is red."] },
    "the panel keeps what it showed while the retag runs");
  assert.deepEqual(asked, [], "and asks for nothing until it lands");
  assert.deepEqual(await retagButton(page), { label: "Queued", disabled: true }, "still Queued");
  await land(files.get("Queuer")[0], ["color/green"], { color: "It is green." });
  assert.equal(await comesToShow(page, ["green"], 15000), true, "the retag landed");
  assert.deepEqual(await reasons(page), ["It is green."], "with its reasons");
  assert.deepEqual(await retagButton(page), { label: "Retag", disabled: false }, "and Retag is back");
  assert.deepEqual(page.errors, []);
});

const panelScroll = (page) => page.evaluate(() => {
  const b = document.getElementById("lightbox-panel-body");
  return { top: b.scrollTop, scrolls: b.scrollHeight > b.clientHeight + 300 };
});

test("Fixed in Stage 2: Retag stops saying it opens a menu once its file can't be scoped", async () => {
  // The button stays through a poll now (the panel before Stage 2 never
  // redrew on one), so the menu's marks, which the menu writes on it as it
  // opens, go when the menu does.
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Scoped");
  await openPanel(page);
  const retag = page.locator("#lightbox-panel-body button", { hasText: "Retag" });
  await retag.click();
  await page.locator(".dd-row", { hasText: "Everything" }).waitFor();
  await page.keyboard.press("Escape"); // the menu, which takes it
  await menuGone(page);
  const marks = () => retag.evaluate((b) => [b.getAttribute("aria-haspopup"), b.getAttribute("aria-expanded")]);
  assert.deepEqual(await marks(), ["menu", "false"], "setup: a menu button, its menu closed");
  // Elsewhere, a full retag: the file is no longer tagged and decided, so
  // there's nothing to scope.
  assert.equal(await elsewhere("POST", `/api/instances/${files.get("Scoped")[0]}/retag`), 200, "setup: queued elsewhere");
  await page.waitForSelector(`#grid .card[data-id="${ents.get("Scoped")}"].loading`, { timeout: 15000 }); // the poll brought it
  assert.equal(await retag.locator(".dd-caret").count(), 0, "setup: its caret went");
  assert.deepEqual(await marks(), [null, null], "and its menu's marks with it");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 2: Retag losing its menu while the menu is up keeps no mark of it once it closes", async () => {
  // The menu marks its button closed as it closes (dropdown.js), and the
  // button had taken the marks off itself while the menu was up.
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Scoped too");
  await openPanel(page);
  const retag = page.locator("#lightbox-panel-body button", { hasText: "Retag" });
  await retag.click();
  await page.locator(".dd-row", { hasText: "Everything" }).waitFor();
  assert.equal(await elsewhere("POST", `/api/instances/${files.get("Scoped too")[0]}/retag`), 200, "setup: queued elsewhere");
  await page.waitForSelector(`#grid .card[data-id="${ents.get("Scoped too")}"].loading`, { timeout: 15000 }); // the poll brought it
  assert.equal(await retag.locator(".dd-caret").count(), 0, "setup: its caret went");
  assert.equal(await page.locator(".dd-row", { hasText: "Everything" }).count(), 1, "setup: with its menu still up");
  await page.keyboard.press("Escape"); // the menu, which takes it
  await menuGone(page);
  assert.deepEqual(await retag.evaluate((b) => [b.getAttribute("aria-haspopup"), b.getAttribute("aria-expanded")]), [null, null],
    "no menu marks once the menu has gone");
  assert.deepEqual(page.errors, []);
});

// ── Fixed in Stage 3: download, and the file info ──────────────────────────

test("Fixed in Stage 3: a ticker tile, having no file, offers no download and its info names none", async () => {
  const page = await openBoard(boards.ticker, { pixels: false });
  await openCard(page, "NVIDIA");
  await openPanel(page);
  const info = await infoRows(page);
  assert.ok(info.includes("kind connector"), `setup: the ticker's own file info (${JSON.stringify(info)})`);
  assert.deepEqual(await downloads(page), [], "no download");
  assert.deepEqual(info.filter((r) => r.startsWith("file ")), [], `no "file" row (${JSON.stringify(info)})`);
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 3: a two-file item has a download on each file's row, and none in the panel's header", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Pair");
  await openPanel(page);
  assert.equal(await page.locator(".lbp-file-row").count(), 2, "setup: two file rows");
  // The second, so a row's link isn't just the selected file's.
  await page.locator("#lightbox-panel-body .lbp-file-name", { hasText: "pair-b.jpg" }).click();
  await page.waitForFunction(() => document.querySelector(".lbp-file-active .lbp-file-name")?.textContent === "pair-b.jpg");
  assert.deepEqual(await downloads(page), [
    { at: "pair-a.jpg", href: "gallery/pair-a.jpg", name: "pair-a.jpg" },
    { at: "pair-b.jpg", href: "gallery/pair-b.jpg", name: "pair-b.jpg" },
  ], "one on each row, for its own file");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 3: a one-file item's download sits at the end of its name", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Single");
  await openPanel(page);
  assert.deepEqual(await downloads(page), [{ at: "name", href: "gallery/single.jpg", name: "single.jpg" }], "on the name");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 3: a stock whose face is its price chart offers no download of the chart", async () => {
  const page = await openBoard(boards.ticker);
  await openCard(page, "Apple");
  await openPanel(page);
  assert.equal(await shown(page), `gallery/${CHART}`, "setup: the lightbox shows the chart");
  const info = await infoRows(page);
  assert.ok(info.includes("kind image"), `setup: the chart's file info (${JSON.stringify(info)})`);
  assert.deepEqual({ downloads: await downloads(page), file: info.filter((r) => r.startsWith("file ")) },
    { downloads: [], file: [] }, "no download, and no file row naming the chart");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 3: a file row's download saves that file and leaves the shown file as it was", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Pair");
  await openPanel(page);
  assert.equal(await shown(page), "gallery/pair-a.jpg", "setup: showing pair-a");
  const saved = page.waitForEvent("download");
  await page.locator(".lbp-file-row", { hasText: "pair-b.jpg" }).locator(".lbp-file-download").click();
  assert.equal((await saved).suggestedFilename(), "pair-b.jpg", "pair-b saved, under its name");
  assert.deepEqual({ shown: await shown(page), active: await page.textContent(".lbp-file-active .lbp-file-name") },
    { shown: "gallery/pair-a.jpg", active: "pair-a.jpg" }, "and the shown file is still pair-a");
  assert.deepEqual(page.errors, []);
});

test("Fixed in Stage 3: an SVG, which the server stores as WebP, saves as WebP", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Vector");
  await openPanel(page);
  assert.deepEqual(await downloads(page), [{ at: "name", href: "gallery/vector.webp", name: "vector.webp" }],
    "not vector.svg");
  assert.equal(await page.getAttribute("#lightbox-panel a[download]", "title"), "Download vector.webp", "and the link says so");
  assert.deepEqual(page.errors, []);
});

// ── Stays true: right today, and a later stage could break it ───────────────

// Whether the panel opens within the slide's time, as a yes or no.
const panelOpens = (page) => page.waitForFunction(
  () => getComputedStyle(document.getElementById("lightbox-panel")).transform === "none", null, { timeout: 10000 },
).then(() => true, () => false);

test("Stays true: a pinned panel opens with the lightbox, and closing the panel doesn't unpin it", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Pinned");
  assert.equal(await page.evaluate(() => document.getElementById("lightbox").classList.contains("panel-open")), false,
    "setup: the panel starts closed");
  await openPanel(page); // the pin sits in the panel's header
  await page.click("#lightbox-panel-pin");
  await page.keyboard.press("Escape"); // the panel
  await panelSettled(page, false);
  await page.keyboard.press("Escape"); // the lightbox
  await page.waitForSelector("#lightbox", { state: "hidden" });
  await openCard(page, "Unpinned");
  assert.equal(await panelOpens(page), true, "pinned, the panel opens with the next lightbox");
  await page.click("#lightbox-panel-close");
  await panelSettled(page, false);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#lightbox", { state: "hidden" });
  await openCard(page, "Pinned");
  assert.equal(await panelOpens(page), true, "closing the panel didn't unpin it");
  assert.deepEqual(page.errors, []);
});

test("Stays true: an object field's box draws over the picture with the panel open, and its row lights it", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Detected");
  await openPanel(page);
  const boxes = await page.waitForSelector(".lb-det-overlay:not([hidden]) .lb-det-box", { timeout: 10000 })
    .then(() => page.locator(".lb-det-box").count(), () => 0);
  assert.equal(boxes, 1, "the object's box draws over the picture");
  const lit = () => page.evaluate(() => document.querySelector(".lb-det-box").classList.contains("det-hi"));
  await page.hover(".lbp-det-row");
  assert.equal(await lit(), true, "hovering its row lights it");
  await page.mouse.move(5, 5);
  assert.equal(await lit(), false, "and leaving the row puts it out");
  await page.click("#lightbox-panel-close");
  await panelSettled(page, false);
  assert.equal(await page.evaluate(() => document.querySelector(".lb-det-overlay").hidden), true, "the boxes go with the panel");
  assert.deepEqual(page.errors, []);
});

test("Stays true: a poll that changes the open item leaves the picture on the stage as the same element", async () => {
  // A stage mounted again would restart a clip that's playing and drop a zoom
  // (the plan's D3): only another item or file mounts it.
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Steady");
  await page.waitForFunction(() => document.querySelector("#lightbox-stage img")?.complete);
  await page.evaluate(() => { window.__picture = document.querySelector("#lightbox-stage img"); });
  assert.equal(await elsewhere("POST", `/api/items/${ents.get("Steady")}/favorite`), 200, "setup: hearted elsewhere");
  await page.waitForFunction((id) => document.querySelector(`#grid .card[data-id="${id}"] .heart.on`),
    ents.get("Steady"), { timeout: 15000 }); // the poll brought the change
  assert.equal(await page.textContent("#lightbox-fav span"), "1", "setup: and the lightbox drew it");
  assert.equal(await page.evaluate(() => document.querySelector("#lightbox-stage img") === window.__picture), true,
    "the same picture: the stage wasn't mounted again");
  assert.deepEqual(page.errors, []);
});

test("Stays true: a poll that changes another card leaves the lightbox's buttons as they were", async () => {
  // The buttons are drawn on every change to any card, and their insides are
  // written only when what they show changed, so a tooltip under the pointer
  // (the Details button's) stays up.
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Calm");
  await page.evaluate(() => { window.__insides = [...document.querySelectorAll("#lightbox-controls button > *")]; });
  assert.ok(await page.evaluate(() => window.__insides.length >= 3), "setup: the buttons' icons");
  assert.equal(await elsewhere("POST", `/api/items/${ents.get("Nearby")}/favorite`), 200, "setup: another card hearted elsewhere");
  await page.waitForFunction((id) => document.querySelector(`#grid .card[data-id="${id}"] .heart.on`),
    ents.get("Nearby"), { timeout: 15000 }); // the poll brought it
  assert.equal(await page.evaluate(() => window.__insides.every((n) => n.isConnected)), true,
    "the buttons' insides are the same elements");
  assert.deepEqual(page.errors, []);
});

// Two of Stage 2's own: the panel before it never redrew on a poll, and never
// waited for the details, so these held by themselves; the panel that
// follows its item and waits for its details could break them.

test("Stays true: the panel keeps its place, its elements and its details through a poll that changes its item", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await openCard(page, "Long");
  await openPanel(page);
  await page.waitForSelector("#lightbox-panel-body .lbp-fields"); // the file's details landed
  await page.evaluate(() => {
    const b = document.getElementById("lightbox-panel-body");
    b.scrollTop = 200;
    window.__cell = b.querySelectorAll(".panel-cell")[10];
  });
  const before = await panelScroll(page);
  assert.ok(before.scrolls && before.top > 150, `setup: scrolled down a panel that scrolls (${JSON.stringify(before)})`);
  const asked = [];
  page.on("request", (r) => { if (r.url().endsWith("/reasoning")) asked.push(r.url()); });
  assert.equal(await elsewhere("POST", `/api/items/${ents.get("Long")}/favorite`), 200, "setup: hearted elsewhere");
  await page.waitForFunction((id) => document.querySelector(`#grid .card[data-id="${id}"] .heart.on`),
    ents.get("Long"), { timeout: 15000 }); // the poll brought it
  assert.equal(await page.textContent("#lightbox-fav span"), "1", "setup: and the lightbox drew it");
  assert.deepEqual({ top: (await panelScroll(page)).top, same: await page.evaluate(() => window.__cell.isConnected), asked },
    { top: before.top, same: true, asked: [] }, "the same place, the same elements, and no new request for the details");
  assert.deepEqual(page.errors, []);
});

test("Stays true: a details request that fails still draws the file's half, without them", async () => {
  const page = await openBoard(boards.main);
  await page.route("**/api/instances/*/reasoning", (route) => route.fulfill({ status: 500, body: "" }));
  await openCard(page, "Failing");
  await openPanel(page);
  assert.equal(await comesToShow(page, ["red"]), true, "its tags, without their reasons");
  assert.equal(await page.locator("#lightbox-panel-body .lbp-hint", { hasText: "Loading" }).count(), 0, "not Loading… for good");
  assert.deepEqual(page.errors, []);
});

// Five that Stage 2 broke and its second pass mended. The panel before it
// drew the boxes on every paint, asked for the field formats with every
// file's details, was shown before it was drawn, and gave the keyboard back
// on every paint or not at all, so these held by themselves.

test("Stays true: paging to a card that shows the same file keeps the object's box over the picture", async () => {
  const page = await openBoard(boards.shared);
  await openCard(page, "Shared X");
  await openPanel(page);
  await page.waitForSelector(".lb-det-overlay:not([hidden]) .lb-det-box", { timeout: 10000 });
  // Two cards: the one arrow there is goes to the other.
  const right = await page.evaluate(() => document.getElementById("lightbox-next").style.visibility === "visible");
  await page.keyboard.press(right ? "ArrowRight" : "ArrowLeft");
  assert.equal(await page.getAttribute("#lightbox", "aria-label"), "Shared Y", "setup: on the other card");
  assert.equal(await shown(page), "gallery/shared.jpg", "setup: showing the same file");
  const boxes = await page.waitForSelector(".lb-det-overlay:not([hidden]) .lb-det-box", { timeout: 5000 })
    .then(() => page.locator(".lb-det-box").count(), () => 0);
  assert.equal(boxes, 1, "the object's box draws over it again");
  assert.deepEqual(page.errors, []);
});

test("Stays true: a pinned panel is open as the lightbox opens on a card with files to list, not slid in", async () => {
  const page = await openBoard(boards.main);
  await openCard(page, "Pair");
  await openPanel(page);
  await page.click("#lightbox-panel-pin");
  await page.keyboard.press("Escape"); // the panel
  await panelSettled(page, false);
  await page.keyboard.press("Escape"); // the lightbox
  await page.waitForSelector("#lightbox", { state: "hidden" });
  await page.evaluate(() => {
    window.__slid = [];
    const panel = document.getElementById("lightbox-panel");
    panel.addEventListener("transitionrun", (e) => { if (e.target === panel) window.__slid.push(e.propertyName); });
  });
  await openCard(page, "Pair");
  assert.equal(await panelOpens(page), true, "setup: pinned, it opens with the lightbox");
  assert.deepEqual(await page.evaluate(() => window.__slid), [], "open as the lightbox opened: nothing slid");
  assert.deepEqual(page.errors, []);
});

test("Stays true: paging on past a file without the button the keyboard was on leaves the keyboard where it is", async () => {
  // Re-extract is there only for a file with AI-extracted fields: the move
  // takes it, and a file further on that has one doesn't take the keyboard.
  const page = await openBoard(boards.main);
  await openCard(page, "Fielded A");
  await openPanel(page);
  const reextract = page.locator("#lightbox-panel-body button", { hasText: "Re-extract" });
  await reextract.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getAttribute("#lightbox", "aria-label"), "Plain", "setup: on the next card");
  await page.locator("#lightbox-panel-body button", { hasText: "Retag" }).waitFor(); // its half, drawn
  assert.equal(await reextract.count(), 0, "setup: no Re-extract on it");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getAttribute("#lightbox", "aria-label"), "Fielded B", "setup: on to one with Re-extract");
  await reextract.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "the keyboard didn't jump onto it");
  assert.deepEqual(page.errors, []);
});

test("Stays true: Escape while the next file's details are on their way puts the keyboard on Details", async () => {
  // A move takes the button the keyboard was on, until the next file's
  // details bring it back (D11). Closing the panel before then hands the
  // keyboard to the button that opens it, as closing from inside it does.
  const page = await openBoard(boards.main);
  await openCard(page, "Fielded A");
  await openPanel(page);
  const retag = page.locator("#lightbox-panel-body button", { hasText: "Retag" });
  await retag.focus();
  await page.route("**/api/instances/*/reasoning", () => {}); // the next file's details, held
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getAttribute("#lightbox", "aria-label"), "Plain", "setup: on the next card");
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "setup: the move took Retag, and the keyboard with it");
  await page.keyboard.press("Escape");
  await panelSettled(page, false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "lightbox-info", "the keyboard is on Details");
  assert.deepEqual(page.errors, []);
});

test("Stays true: a file field prints by its format even when the page's first ask for the formats failed", async () => {
  // The page asks for the media catalog as it loads and keeps it only once it
  // has it; the panel asks again with the file's details.
  let refused = 0;
  const page = await openBoard(boards.timed, {
    before: (p) => p.route("**/api/file-fields", (r) => { refused++; return r.fulfill({ status: 500, body: "" }); }, { times: 1 }),
  });
  assert.equal(refused, 1, "setup: the page's first ask for the formats failed");
  await openCard(page, "Timed");
  await openPanel(page);
  // The half doesn't wait for them, so it can draw first and reprint.
  const formatted = await page.waitForFunction(() => [...document.querySelectorAll("#lightbox-panel-body .panel-cell")]
    .find((c) => c.textContent.includes("duration"))?.querySelector(".lbp-field-val")?.textContent === "36:51", null, { timeout: 10000 })
    .then(() => true, () => false);
  assert.equal(formatted, true, "by the catalog's format");
  assert.deepEqual(page.errors, []);
});

// Right before the plan, broken by a stage and mended at the arc's end:
// Stage 2 put the panel back at its top on every move, Stage 1's second pass
// closed any menu on any move, and Stage 2's second pass had the file's half
// wait for the field formats too.

test("Stays true: a move keeps the panel's place", async () => {
  // Paging through stocks, the field you were reading stays in view. Long A
  // and Long B's own half (thirty connector fields) scrolls by itself, so
  // the place doesn't hang on the file's half waiting for its details.
  const page = await openBoard(boards.main);
  await openCard(page, "Long A");
  await openPanel(page);
  await page.waitForFunction(() => !document.querySelector("#lightbox-panel-body .lbp-hint")?.textContent.includes("Loading"));
  await page.evaluate(() => { document.getElementById("lightbox-panel-body").scrollTop = 300; });
  const before = await panelScroll(page);
  assert.ok(before.top > 250, "setup: scrolled down");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getAttribute("#lightbox", "aria-label"), "Long B", "setup: on the next card");
  await page.waitForFunction(() => !document.querySelector("#lightbox-panel-body .lbp-hint")?.textContent.includes("Loading"));
  assert.deepEqual(await panelScroll(page), { top: before.top, scrolls: true }, "in the same place");
  assert.deepEqual(page.errors, []);
});

test("Stays true: field formats that never come don't keep the file's half from drawing", async () => {
  const page = await openBoard(boards.main, { before: (p) => p.route("**/api/file-fields", () => {}) });
  await openCard(page, "Calm");
  await openPanel(page);
  assert.equal(await comesToShow(page, ["red"]), true, "its tags, and Retag with them");
  assert.deepEqual(page.errors, []);
});

test("Stays true: another file of the open item leaves the crate menu open, which is the item's", async () => {
  const page = await openBoard(boards.main, { polling: true });
  await onSecondFile(page, "Crated pair", "crated-b.jpg");
  await page.click("#lightbox-crate");
  await page.waitForSelector(".crate-pop");
  await secondRemovedElsewhere(page, "Crated pair", "crated-a.jpg");
  assert.equal(await page.locator(".crate-pop:not(.is-closing)").count(), 1, "the crate menu is still open");
  assert.deepEqual(page.errors, []);
});
