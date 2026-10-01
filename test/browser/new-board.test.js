// New board picks the board's type first (planning/templates-plan.md, Stage
// 2a). Every New board door opens a chooser, one card per type, and the board
// modal opens once the chooser is gone, showing the type as a chip it can't
// change. The Mapping tab's old Template selector is gone. A type this server
// can't feed can't be picked, and says why. A fresh server has no data
// provider added at all; this one gets CoinGecko, the way an admin adds it on
// the Plugins page, so Crypto can be picked and Stocks can't.
//
// The order matters: the first test needs the empty boards page, which only
// shows while no board exists at all, and it makes the first board.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { seedUser, installConnectors } from "../helpers.js";
import { createBoard, setBoardMembers, updateBoard, setPassword, setSetting } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";
import { manifest as crypto } from "../../server/connectors/crypto/index.js";
import { manifest as stocks } from "../../server/connectors/stocks/index.js";

let app, admin;

before(async () => {
  app = await openApp();
  admin = await seedUser(app.db, "admin@test.local");
  await setPassword(app.db, admin.id, await hashPassword("browser-test-pw"));
  await app.db.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [admin.id]);
  // No model is connected here, so without this the boot ladder sends a
  // boardless admin to /welcome instead of the empty boards page. The value
  // the welcome screen's Skip writes.
  await setSetting(app.db, "welcome_skipped", "1");
  await installConnectors(app.db, "crypto:coingecko");
});
after(() => app?.close());

const chooser = "#new-board-modal";
const typeCard = (name) => `${chooser} .nb-type:has(.nb-name:text-is("${name}"))`;
const boardByName = async (name) =>
  (await app.db.query("SELECT id, mapping FROM boards WHERE name = $1", [name])).rows[0];

// Whether the chooser and the board modal were ever in the page together. The
// board modal must wait for the chooser's fade to finish (D17): one after the
// other, never one on top of the other.
const watchOverlap = (page) => page.evaluate(() => {
  window.__bothOpen = false;
  new MutationObserver(() => {
    if (document.getElementById("new-board-modal") && document.getElementById("board-edit-modal")) window.__bothOpen = true;
  }).observe(document.body, { childList: true });
});

// Name the new board and create it, once the AI-models strip has landed, so
// the create carries what the strip shows.
async function nameAndCreate(page, name) {
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.fill("#board-modal-name", name);
  await page.click("#board-modal-save");
  await page.waitForSelector("#board-modal-save", { state: "detached" });
}

test("the empty grid's card opens the chooser; Files makes a board with no mapping, and the page stays", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  await page.click("button.bc-new");
  await page.waitForSelector(`${chooser} .nb-types`);

  const names = await page.$$eval(`${chooser} .nb-name`, (els) => els.map((e) => e.textContent));
  assert.equal(names[0], "Files", "Files first");
  assert.deepEqual(names.slice(1, -1).sort(), ["Crypto", "Stocks"], "then every data type");
  assert.equal(names.at(-1), "Start from a template", "and the templates last (Stage 3b)");

  // Stocks has no provider on this server: it says so, points at where that
  // gets fixed, and picking it does nothing.
  const stocksCard = await page.$eval(typeCard("Stocks"), (el) => ({
    tag: el.tagName, blocked: el.classList.contains("blocked"),
    why: el.querySelector(".warn-box")?.textContent, fix: el.querySelector(".warn-box a")?.getAttribute("href"),
  }));
  assert.equal(stocksCard.tag, "DIV", "not a button");
  assert.equal(stocksCard.blocked, true);
  assert.equal(stocksCard.why, "No Stocks provider is installed. Fix in Admin → Plugins");
  assert.equal(stocksCard.fix, "/admin#plugins");
  await page.click(`${typeCard("Stocks")} .nb-name`);
  assert.equal(await page.$eval(chooser, (el) => el.classList.contains("is-closing")), false, "a blocked type can't be picked");
  assert.equal(await page.locator("#board-edit-modal").count(), 0);
  assert.equal(await page.$eval(typeCard("Crypto"), (el) => el.tagName), "BUTTON", "Crypto has its provider");

  await watchOverlap(page);
  await page.click(typeCard("Files"));
  await page.waitForSelector("#board-edit-modal");
  await page.waitForSelector(chooser, { state: "detached" });
  assert.equal(await page.evaluate(() => window.__bothOpen), false, "the chooser was gone before the board modal opened");
  assert.equal(await page.textContent("#board-modal-type"), "Files");

  // A blank type's Create board stays off until the board has a name.
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  assert.equal(await page.getAttribute("#board-modal-save", "aria-disabled"), "true");
  await nameAndCreate(page, "Plain files");

  // The boards page stays where it is, and the new card is its answer.
  await page.waitForSelector('.bc-name:text-is("Plain files")');
  assert.equal(new URL(page.url()).pathname, "/boards");
  assert.equal((await boardByName("Plain files")).mapping, null, "a Files board has no mapping, as before");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("the dropdown's New board: Crypto, then Create without the Mapping tab, lands on a Crypto board", async () => {
  const { id } = await boardByName("Plain files");
  const page = await app.open(`/?board=${id}`, { sid: admin.sid });
  await page.click("#toolbar .board-btn");
  await page.click(".board-pop .dd-action:has-text('New board')");
  await page.waitForSelector(`${chooser} .nb-types`);

  await watchOverlap(page);
  await page.click(typeCard("Crypto"));
  await page.waitForSelector("#board-edit-modal");
  await page.waitForSelector(chooser, { state: "detached" });
  assert.equal(await page.evaluate(() => window.__bothOpen), false, "the chooser was gone before the board modal opened");
  assert.equal(await page.textContent("#board-modal-type"), "Crypto");
  await nameAndCreate(page, "Coins");

  // The dropdown's own after-step: the new board, and its created toast there.
  const made = await boardByName("Coins");
  await page.waitForURL(`${app.base}/?board=${made.id}`);
  await page.waitForSelector('.toast-msg:text-is("Board \\"Coins\\" created")');
  // The type's starting mapping rode the create, the Mapping tab never opened.
  assert.deepEqual(made.mapping, crypto.template);
  assert.deepEqual(page.errors, []);
});

test("the boards page's button: Crypto with the Mapping tab opened and left alone makes the same board", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  await page.click('#toolbar .auth .tool-btn:has-text("New board")');
  await page.click(typeCard("Crypto"));
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click('#board-edit-modal .pane-toggle-btn[data-pane="mapping"]');
  await page.waitForSelector('#board-modal-mapping .tile-name:text-is("price")');
  assert.equal(await page.locator("#board-modal-mapping .mm-template-row").count(), 0, "no Template row");
  await page.click('#board-edit-modal .pane-toggle-btn[data-pane="tagging"]');
  await nameAndCreate(page, "More coins");

  await page.waitForSelector('.bc-name:text-is("More coins")');
  assert.equal(new URL(page.url()).pathname, "/boards");
  assert.deepEqual((await boardByName("More coins")).mapping, crypto.template);
  assert.deepEqual(page.errors, []);
});

// The starting mapping rides a create only while the pane is as it opened: an
// edit made there is what gets made.
test("a field removed in a new Crypto board's Mapping tab stays removed", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  await page.click('#toolbar .auth .tool-btn:has-text("New board")');
  await page.click(typeCard("Crypto"));
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click('#board-edit-modal .pane-toggle-btn[data-pane="mapping"]');
  await page.click('#board-modal-mapping .tile-rm[aria-label="Remove url"]');
  await page.waitForSelector('#board-modal-mapping .tile-name:text-is("url")', { state: "detached" });
  await nameAndCreate(page, "Coins without links");

  await page.waitForSelector('.bc-name:text-is("Coins without links")');
  const { mapping } = await boardByName("Coins without links");
  assert.equal(mapping.input.connector, "crypto");
  assert.deepEqual(mapping.fields.map((f) => f.key), crypto.template.fields.map((f) => f.key).filter((k) => k !== "url"));
  assert.deepEqual(page.errors, []);
});

// Two quick clicks on New board both reach the chooser, the second while the
// first is still fetching the types. It used to open a second chooser by
// throwing the first away, which skipped the first's close: its hold on the
// page's scroll was never let go, and the page stayed unscrollable once the
// chooser closed by × or a click outside. The types are held back a moment
// here so both clicks are sure to land before the chooser opens.
test("a double click on New board opens one chooser, and closing it gives the page its scroll back", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  const asked = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/connectors")) asked.push(r.url()); });
  await page.route("**/api/connectors", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page.dblclick('#toolbar .auth .tool-btn:has-text("New board")');
  await page.waitForSelector(`${chooser} .nb-types`);
  assert.equal(asked.length, 1, "the second click didn't start another chooser");

  await page.click(`${chooser} .modal-close`);
  await page.waitForSelector(chooser, { state: "detached" });
  assert.equal(await page.evaluate(() => document.body.style.overflow), "", "the page scrolls again");
  assert.deepEqual(page.errors, []);
});

// A type is picked on its card's first click, and the chooser fades from
// there. A closing modal lets clicks through to the page (modal.css
// .is-closing), so a double click's second click used to land on whatever the
// chooser covered: on the boards page, a board card, which is a link.
test("a double-clicked type card picks once, and its second click stays in the chooser", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  await page.click('#toolbar .auth .tool-btn:has-text("New board")');
  await page.waitForSelector(`${chooser} .nb-types`);
  await page.evaluate(() => {
    window.__leaked = [];
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".modal-overlay")) window.__leaked.push(e.target.tagName);
    }, true);
  });
  await page.dblclick(typeCard("Files"));
  await page.waitForSelector("#board-edit-modal");
  assert.deepEqual(await page.evaluate(() => window.__leaked), [], "no click reached the page under the chooser");
  assert.equal(new URL(page.url()).pathname, "/boards");
  assert.deepEqual(page.errors, []);
});

// What a plugin's type may lack, stood in for by the real list rewritten on
// its way to the page: Crypto's starting mapping without its face, and a type
// with no starting mapping at all.
test("a starting mapping without a face starts on the first face; a type without one can't be picked, and there's nothing to fix", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  await page.route("**/api/connectors", async (route) => {
    const response = await route.fetch();
    const rows = await response.json();
    for (const r of rows) if (r.name === "crypto") delete r.template.face;
    rows.push({ name: "films", label: "Films", description: "Films from a catalog", available: true, template: null, faces: [] });
    await route.fulfill({ response, json: rows });
  });
  await page.click('#toolbar .auth .tool-btn:has-text("New board")');
  await page.waitForSelector(`${chooser} .nb-types`);
  const films = await page.$eval(typeCard("Films"), (el) => ({
    tag: el.tagName, why: el.querySelector(".warn-box")?.textContent, link: !!el.querySelector(".warn-box a"),
  }));
  assert.deepEqual(films, { tag: "DIV", why: "The Films plugin doesn't set up new boards.", link: false },
    "only its author can give it one, so no link to Admin → Plugins");

  // The Mapping tab would show Crypto's first face at 1y; the board gets that
  // face, the tab never opened.
  await page.click(typeCard("Crypto"));
  await nameAndCreate(page, "Coins by default");
  await page.waitForSelector('.bc-name:text-is("Coins by default")');
  assert.deepEqual((await boardByName("Coins by default")).mapping.face, crypto.template.face);
  assert.deepEqual(page.errors, []);
});

test("Edit board names the board's type, Files included, and has no Template row", async () => {
  const oldStocks = await createBoard(app.db, "Old stocks", [], "", true, null, null, { enabled: false });
  await updateBoard(app.db, oldStocks, { mapping: stocks.template });
  await setBoardMembers(app.db, oldStocks, [admin.id]);

  const page = await app.open(`/?board=${oldStocks}`, { sid: admin.sid });
  await page.click("#toolbar .board-edit-btn");
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  assert.equal(await page.textContent("#board-modal-type"), "Stocks");
  await page.click('#board-edit-modal .pane-toggle-btn[data-pane="mapping"]');
  await page.waitForSelector('#board-modal-mapping .tile-name:text-is("price")');
  assert.equal(await page.locator("#board-modal-mapping .mm-template-row").count(), 0, "no Template row");

  const { id: files } = await boardByName("Plain files");
  await page.goto(`${app.base}/?board=${files}`);
  await page.click("#toolbar .board-edit-btn");
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  assert.equal(await page.textContent("#board-modal-type"), "Files");
  assert.deepEqual(page.errors, []);
});

test("the admin tab's New board opens the chooser and lists the new board; the chip is drawn there too", async () => {
  const page = await app.open("/admin#boards", { sid: admin.sid });
  await page.click('#boards-content button:has-text("New board")');
  await page.click(typeCard("Files"));
  await nameAndCreate(page, "From admin");
  const made = await boardByName("From admin");
  await page.waitForSelector(`#board-row-${made.id}`);

  // The chip's look comes from modal.css, which this page loads; the gallery
  // stylesheet it used to live in isn't loaded here.
  const { id: coins } = await boardByName("Coins");
  await page.click(`#board-row-${coins} button:text-is("edit")`);
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  assert.equal(await page.textContent("#board-modal-type"), "Crypto");
  const look = await page.$eval("#board-modal-type", (el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, height: s.height, size: s.fontSize };
  });
  assert.deepEqual(look, { background: "rgb(241, 241, 243)", height: "28px", size: "12px" });
  assert.deepEqual(page.errors, []);
});

// The toolbar's chips kept their own look when the base rule moved to
// modal.css, which loads after styles.css: the token chip's narrower padding
// has to outweigh the base now, not follow it. The token chip only draws on a
// board with spend, so its classes are measured on a stand-in.
test("the toolbar's chips look as they did, and the type chip says what it is", async () => {
  const { id } = await boardByName("Coins");
  const page = await app.open(`/?board=${id}`, { sid: admin.sid });
  await page.waitForSelector("#toolbar .type-chip");
  const look = await page.$eval("#toolbar .type-chip", (el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, height: s.height, padding: s.padding };
  });
  assert.deepEqual(look, { background: "rgb(241, 241, 243)", height: "28px", padding: "0px 10px" });
  // Stage 2b: the chip names the board's type in the words the board editor
  // uses.
  assert.deepEqual(await page.$eval("#toolbar .type-chip", (el) => [el.textContent, el.title]),
    ["Crypto", "Board type: Crypto"]);
  const tokenPadding = await page.evaluate(() => {
    const b = document.createElement("button");
    b.className = "mapping-chip token-chip";
    document.body.appendChild(b);
    const p = getComputedStyle(b).padding;
    b.remove();
    return p;
  });
  assert.equal(tokenPadding, "0px 8px 0px 6px");
  assert.deepEqual(page.errors, []);
});
