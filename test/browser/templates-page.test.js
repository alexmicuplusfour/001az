// The board templates page (planning/templates-plan.md, Stage 3b): the grid at
// /templates, a template's details at ?template=<slug>, Use this template
// opening the board modal filled from it, and what stops a template being
// used on this server.
//
// The server reads a templates folder this file writes: the repo's own three,
// copied as they are, and three more for what they can't show: a template for
// a type no plugin here adds, one with guidance and nothing else, and one with
// real screenshots. A tagger is bound the way capabilities.test.js binds one,
// to a stand-in that answers its model list, so nothing leaves the machine.
//
// The order matters: Stocks is blocked until a later test adds its provider,
// and the boards made here are read back by the tests after them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { openApp } from "./harness.js";
import { seedUser, installConnectors } from "../helpers.js";
import { setPassword, setSetting, createAiKey, recordPluginHealth } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";
import { presentTrouble } from "../../public/capability-present.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIPBOARD = ["clipboard-read", "clipboard-write"];
// Windows hands clipboard text back with CRLF line breaks.
const clipboardText = (page) => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"));

let app, admin, member, dir, models, keyId;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "templates-page-"));
  fs.cpSync(path.join(REPO, "templates"), dir, { recursive: true });
  const write = (slug, doc, files = {}) => {
    fs.mkdirSync(path.join(dir, slug));
    fs.writeFileSync(path.join(dir, slug, "template.json"), JSON.stringify(doc));
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, slug, name), bytes);
  };
  const genre = { key: "genre", label: "Genre", values: ["drama", "comedy"] };
  write("films", { name: "Films", description: "Films you've seen.", boardType: "films", guidance: { context: "Each card is a film.", facets: [genre] } });
  write("notes", { name: "Notes", description: "A taxonomy and nothing else.", guidance: { context: "Each card is a note.", facets: [{ key: "topic", label: "Topic", values: ["work", "home"] }] } });
  write("shots", {
    name: "Screens", description: "One with screenshots.", guidance: { context: "Each card is a screen.", facets: [genre] },
    screenshots: [{ file: "cover.jpg", caption: "The board" }, { file: "detail.webp", caption: "One card" }],
  }, {
    "cover.jpg": await sharp({ create: { width: 600, height: 360, channels: 3, background: { r: 120, g: 160, b: 210 } } }).jpeg().toBuffer(),
    "detail.webp": await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 210, g: 160, b: 120 } } }).webp().toBuffer(),
  });

  // The tagger's provider, standing in: it answers the model list the board
  // modal asks for, and nothing here makes it tag.
  models = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gpt-stub" }] }));
  });
  await new Promise((r) => models.listen(0, "127.0.0.1", r));

  app = await openApp({ templatesDir: dir });
  admin = await seedUser(app.db, "admin@templates.page");
  await setPassword(app.db, admin.id, await hashPassword("templates-page-pw"));
  await app.db.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [admin.id]);
  member = await seedUser(app.db, "member@templates.page");
  await setPassword(app.db, member.id, await hashPassword("templates-page-pw"));
  await installConnectors(app.db, "ai:openai");
  keyId = await createAiKey(app.db, "Stand-in", "openai", "sk-test", `http://127.0.0.1:${models.address().port}/v1`);
  await setSetting(app.db, "default_key_id", String(keyId));
});

after(async () => {
  await app?.close();
  await new Promise((r) => models?.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const card = (name) => `#templates-grid .bc-wrap:has(.bc-name:text-is("${name}"))`;
const boardByName = async (name) =>
  (await app.db.query("SELECT id, mapping, facets, context FROM boards WHERE name = $1", [name])).rows[0];
const template = (slug) => JSON.parse(fs.readFileSync(path.join(dir, slug, "template.json"), "utf8"));

// The details' Use this template, and the board modal it opens.
async function use(page, slug) {
  await page.goto(`${app.base}/templates?template=${slug}`);
  await page.click(".tp-actions button");
  await page.waitForSelector("#board-edit-modal");
}

test("a member who opens the templates lands on the boards page", async () => {
  const page = await app.open("/templates", { sid: member.sid });
  await page.waitForURL(/\/boards$/, { timeout: 15000 });
  assert.deepEqual(page.errors, []);
});

test("the grid: Start blank first, then a card per template, a cover or the grey face, and what stops one", async () => {
  const page = await app.open("/templates", { sid: admin.sid });
  await page.waitForSelector("#templates-grid .board-card");
  const names = await page.$$eval("#templates-grid > *", (els) =>
    els.map((e) => e.querySelector(".bc-name")?.textContent || e.querySelector(".bc-new-label")?.textContent));
  assert.deepEqual(names, ["Start blank", "Films", "Notes", "Products", "Screens", "Stock watchlist", "UI screens"]);

  // No screenshot: the grey tile's own colour (styles.css --face-badge-bg).
  // Screenshots: the first, as the cover, loaded.
  const face = (name) => page.$eval(`${card(name)} .bc-face`, (f) => ({
    img: f.querySelector("img")?.getAttribute("src") || null,
    loaded: f.querySelector("img")?.naturalWidth || 0,
    bg: getComputedStyle(f).backgroundColor,
  }));
  await page.waitForFunction(() => document.querySelector(".bc-face img")?.complete);
  assert.deepEqual(await face("Products"), { img: null, loaded: 0, bg: "rgb(241, 242, 244)" });
  const shots = await face("Screens");
  assert.equal(shots.img, "/template-shots/shots/cover.jpg");
  assert.equal(shots.loaded, 600);

  // A board card's resting shadow (styles.css --card-shadow).
  assert.equal(await page.$eval(`${card("Products")} .board-card`, (c) => getComputedStyle(c).boxShadow),
    "rgba(0, 0, 0, 0.08) 0px 1px 3px 0px, rgba(0, 0, 0, 0.06) 0px 4px 12px 0px");

  // The board grid's chips for what each sets up, its type always.
  const chips = (name) => page.$$eval(`${card(name)} .bc-chip`, (cs) => cs.map((c) => c.title));
  assert.deepEqual(await chips("Stock watchlist"), ["Board type: Stocks", "AI-extracted fields", "Tagging — 2 facets"]);
  assert.deepEqual(await chips("Notes"), ["Board type: Files", "Tagging — 1 facet"]);

  // Each card says what stops it, with no links: the card is the link.
  const why = (name) => page.$eval(card(name), (c) => ({
    note: c.querySelector(".warn-box")?.textContent || null, links: c.querySelectorAll(".warn-box a").length,
  }));
  assert.deepEqual(await why("Stock watchlist"), { note: "No Stocks provider is installed.", links: 0 });
  assert.deepEqual(await why("Films"), { note: "Needs the Films plugin.", links: 0 });
  assert.deepEqual(await why("Products"), { note: null, links: 0 });
  // Blocked or not, a card opens its details: reading a template needs nothing.
  const href = (name) => page.$eval(card(name), (c) => c.querySelector("a.board-card")?.getAttribute("href") || null);
  assert.equal(await href("Products"), "/templates?template=products");
  assert.equal(await href("Stock watchlist"), "/templates?template=stock-watchlist");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("a template's details: its screenshots with captions, both sections, the card key; the back button returns to the grid", async () => {
  const page = await app.open("/templates", { sid: admin.sid });
  await page.click(`${card("Screens")} a.board-card`);
  await page.waitForSelector("#template-details .tp-head");
  assert.equal(new URL(page.url()).search, "?template=shots");
  assert.equal(await page.isVisible("#templates-grid"), false);
  const figures = await page.$$eval(".tp-shot", (els) => els.map((f) => ({
    src: f.querySelector("img").getAttribute("src"), caption: f.querySelector("figcaption")?.textContent,
  })));
  assert.deepEqual(figures, [
    { src: "/template-shots/shots/cover.jpg", caption: "The board" },
    { src: "/template-shots/shots/detail.webp", caption: "One card" },
  ]);
  await page.waitForFunction(() => [...document.querySelectorAll(".tp-shot img")].every((i) => i.complete && i.naturalWidth));

  await page.goBack();
  await page.waitForSelector("#templates-grid .board-card");
  assert.equal(await page.isVisible("#template-details"), false);

  // Straight to a template by its address: the keyed one shows its key.
  await page.goto(`${app.base}/templates?template=products`);
  await page.waitForSelector("#template-details .tp-head");
  assert.equal(await page.textContent(".tp-head h1"), "Products");
  assert.equal(await page.textContent(".tp-head .mapping-chip"), "Files");
  const sections = await page.$$eval(".tp-section .section-heading h2", (hs) => hs.map((h) => h.textContent));
  assert.deepEqual(sections, ["Tagging guidance", "AI-extracted fields"]);
  assert.deepEqual(await page.$$eval(".tp-section .tp-values .pill", (ps) => ps.map((p) => p.textContent)),
    ["food", "drink", "household", "personal-care", "electronics", "other"]);
  assert.match(await page.textContent(".tp-section:nth-of-type(2)"), /One card per product/);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("a blocked template's details say why and where to fix it, in place of Use", async () => {
  const page = await app.open("/templates?template=stock-watchlist", { sid: admin.sid });
  await page.waitForSelector("#template-details .tp-head");
  assert.equal(await page.locator(".tp-actions button").count(), 0, "nothing to click");
  assert.equal(await page.textContent(".tp-actions .warn-box"), "No Stocks provider is installed. Fix in Admin → Plugins");
  assert.equal(await page.getAttribute(".tp-actions .warn-box a", "href"), "/admin#plugins");
  // The link in the amber box's own ink, as on the chooser's cards.
  const ink = await page.$eval(".tp-actions .warn-box", (b) => [getComputedStyle(b).color, getComputedStyle(b.querySelector("a")).color]);
  assert.equal(ink[1], ink[0]);

  await page.goto(`${app.base}/templates?template=films`);
  await page.waitForSelector("#template-details .tp-head");
  assert.equal(await page.locator(".tp-actions button").count(), 0);
  assert.equal(await page.textContent(".tp-actions .warn-box"), "Needs the Films plugin. Fix in Admin → Plugins");
  // Its sections still copy: reading a template needs nothing.
  assert.equal(await page.locator('[data-place="template-guidance:copy"]').count(), 1);
  assert.deepEqual(page.errors, []);
});

test("Use this template opens the board modal filled; Create, with the Mapping tab never opened, makes that board", async () => {
  const page = await app.open("/templates", { sid: admin.sid });
  await use(page, "products");
  const t = template("products");

  // Named, so there's a board to create at once, and still once the AI-models
  // strip has landed.
  assert.equal(await page.inputValue("#board-modal-name"), "Products");
  assert.equal(await page.getAttribute("#board-modal-save", "aria-disabled"), null, "live at once");
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.waitForTimeout(300);
  assert.equal(await page.getAttribute("#board-modal-save", "aria-disabled"), null, "live after the strip");
  assert.equal(await page.textContent("#board-modal-type"), "Files");
  assert.equal(await page.inputValue("#board-modal-context"), t.guidance.context);
  assert.deepEqual(await page.$$eval(".fe-label", (els) => els.map((e) => e.value)), ["Category"]);

  await page.click("#board-modal-save");
  await page.waitForURL(/\/\?board=.+&created=1$/, { timeout: 15000 });
  const board = await boardByName("Products");
  assert.equal(new URL(page.url()).searchParams.get("board"), board.id, "it went to the new board");
  assert.equal(board.context, t.guidance.context);
  assert.deepEqual(board.facets, t.guidance.facets);
  assert.deepEqual(board.mapping, {
    card: { by: "product" },
    // The face the Mapping tab shows for a card key, not none.
    face: { source: "file", prefer: "image", pick: "first" },
    fields: t.fields,
  });
});

test("…and its Mapping tab shows the template's fields, its card key and that face", async () => {
  const page = await app.open("/templates", { sid: admin.sid });
  await use(page, "products");
  // The AI-models strip first: its rebase, landing after the tab opened,
  // would take in a pane that wrongly read as edited.
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click('.pane-toggle-btn[data-pane="mapping"]');
  await page.waitForSelector("#board-modal-mapping .tiles");
  const pane = await page.textContent("#board-modal-mapping");
  assert.match(pane, /generate one card per product/);
  assert.match(pane, /the first image added/);
  assert.deepEqual(await page.$$eval("#board-modal-mapping .tile-name", (els) => els.map((e) => e.textContent)), ["product", "brand"]);
  // Opened and left alone, nothing reads as an edit but the name.
  await page.fill("#board-modal-name", "");
  await page.waitForFunction(() => document.querySelector("#board-modal-save").getAttribute("aria-disabled") === "true");
  // And the dead Create says what it's missing.
  assert.equal(await page.getAttribute("#board-modal-save", "title"), "Name the board to create it");
  assert.deepEqual(page.errors, []);
});

test("Copy on the details writes exactly what the board's own Copy writes, for each section", async () => {
  const page = await app.open("/templates", { sid: admin.sid, permissions: CLIPBOARD });
  const board = await boardByName("Products");

  await page.goto(`${app.base}/templates?template=products`);
  await page.waitForSelector("#template-details .tp-head");
  await page.click('[data-place="template-guidance:copy"]');
  const guidance = await clipboardText(page);
  await page.click('[data-place="template-fields:copy"]');
  const fields = await clipboardText(page);

  await page.goto(`${app.base}/boards`);
  await page.click(`.bc-wrap[data-board="${board.id}"] .bc-edit`);
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click('[data-place="guidance-clip:copy"]');
  assert.equal(await clipboardText(page), guidance);
  await page.click('.pane-toggle-btn[data-pane="mapping"]');
  await page.click('[data-place="fields-clip:copy"]');
  assert.equal(await clipboardText(page), fields);
  assert.equal(JSON.parse(fields)[0].key, "product", "the clipboard really held the fields");
  assert.deepEqual(page.errors, []);
});

test("a Stocks template, once Stocks can serve, makes a Stocks board: its starting fields, then the template's", async () => {
  await installConnectors(app.db, "stocks:financialmodelingprep");
  await setSetting(app.db, "stocks_key_financialmodelingprep", "fmp-test-key");
  const page = await app.open("/templates", { sid: admin.sid, permissions: CLIPBOARD });
  await page.waitForSelector(card("Stock watchlist"));
  assert.equal(await page.$eval(card("Stock watchlist"), (c) => c.querySelector(".warn-box")), null, "no longer blocked");

  await use(page, "stock-watchlist");
  assert.equal(await page.textContent("#board-modal-type"), "Stocks");
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click("#board-modal-save");
  await page.waitForURL(/\/\?board=/, { timeout: 15000 });
  const { mapping } = await boardByName("Stock watchlist");
  const { manifest } = await import("../../server/connectors/stocks/index.js");
  assert.deepEqual(mapping.input, { connector: "stocks" });
  assert.deepEqual(mapping.fields.map((f) => f.key), [...manifest.template.fields.map((f) => f.key), "moat"]);
  assert.deepEqual(mapping.face, { source: "connector", producer: "chart", period: "1y" });

  // The fields Copy of a data board takes its AI-extracted fields only: the
  // template's, as the details copy them.
  await page.goto(`${app.base}/templates?template=stock-watchlist`);
  await page.click('[data-place="template-fields:copy"]');
  const fromDetails = await clipboardText(page);
  assert.deepEqual(JSON.parse(fromDetails), template("stock-watchlist").fields);
  const { id } = await boardByName("Stock watchlist");
  await page.goto(`${app.base}/boards`);
  await page.click(`.bc-wrap[data-board="${id}"] .bc-edit`);
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click('.pane-toggle-btn[data-pane="mapping"]');
  await page.click('[data-place="fields-clip:copy"]');
  assert.equal(await clipboardText(page), fromDetails);
});

test("a Files template with guidance only makes a board with no mapping", async () => {
  const page = await app.open("/templates", { sid: admin.sid });
  await use(page, "notes");
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click("#board-modal-save");
  await page.waitForURL(/\/\?board=/, { timeout: 15000 });
  const board = await boardByName("Notes");
  assert.equal(board.mapping, null);
  assert.deepEqual(board.facets, template("notes").guidance.facets);
});

test("with nothing running tagging a template that tags is blocked; a tagger whose last call failed still runs, and blocks nothing", async (t) => {
  t.after(async () => {
    await setSetting(app.db, "default_key_id", String(keyId));
    await recordPluginHealth(app.db, "ai:openai", null);
  });
  await setSetting(app.db, "default_key_id", null);
  const page = await app.open("/templates?template=products", { sid: admin.sid });
  await page.waitForSelector("#template-details .tp-head");
  assert.equal(await page.locator(".tp-actions button").count(), 0);
  assert.equal(await page.textContent(".tp-actions .warn-box"), "Tagging and field extraction — needs a key. Fix in Setup");
  assert.equal(await page.getAttribute(".tp-actions .warn-box a", "href"), "/welcome");
  await page.goto(`${app.base}/templates?template=notes`);
  await page.waitForSelector("#template-details .tp-head");
  assert.equal(await page.textContent(".tp-actions .warn-box"), "Tagging — needs a key. Fix in Setup", "guidance only: tagging only");

  // A tagger that resolves but failed its last call: the boards page's strip
  // would warn about it (presentTrouble), and the template is still usable.
  await setSetting(app.db, "default_key_id", String(keyId));
  await recordPluginHealth(app.db, "ai:openai", new Error("timed out"));
  const tag = await (await fetch(`${app.base}/api/admin/capabilities/tag`, { headers: { cookie: `sid=${admin.sid}` } })).json();
  assert.ok(presentTrouble(tag), "the strip's rule would have blocked it");
  await page.goto(`${app.base}/templates?template=products`);
  await page.waitForSelector("#template-details .tp-head");
  assert.equal(await page.textContent(".tp-actions button"), "Use this template");
  assert.deepEqual(page.errors, []);
});

test("Start blank opens the chooser, without its templates card; elsewhere that card goes to the templates", async () => {
  const page = await app.open("/templates", { sid: admin.sid });
  await page.click("#templates-grid button.bc-new");
  await page.waitForSelector("#new-board-modal .nb-types");
  const names = await page.$$eval("#new-board-modal .nb-name", (els) => els.map((e) => e.textContent));
  assert.equal(names[0], "Files");
  assert.equal(names.includes("Start from a template"), false);
  assert.equal(await page.locator('#new-board-modal a[href="/templates"]').count(), 0);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#new-board-modal", { state: "detached" });

  await page.goto(`${app.base}/boards`);
  await page.click(".tool-btn:has-text('New board')");
  await page.waitForSelector("#new-board-modal .nb-types");
  const last = await page.$eval("#new-board-modal .nb-types > :last-child", (el) => ({
    tag: el.tagName, href: el.getAttribute("href"), name: el.querySelector(".nb-name").textContent,
  }));
  assert.deepEqual(last, { tag: "A", href: "/templates", name: "Start from a template" });
  await page.click("#new-board-modal a.nb-type");
  await page.waitForURL(/\/templates$/, { timeout: 15000 });
  await page.waitForSelector("#templates-grid .board-card");
  assert.deepEqual(page.errors, []);
});

test("a link to a template comes back to it after signing in; one this server lacks shows the grid and says so", async () => {
  const page = await app.open("/templates?template=products");
  await page.waitForURL(/\/login\.html\?next=/, { timeout: 15000 });
  await page.waitForSelector("#login-form:not([hidden])");
  await page.fill("#login-email", "admin@templates.page");
  await page.fill("#login-password", "templates-page-pw");
  await page.click("#login-form button[type=submit]");
  await page.waitForURL(/\/templates\?template=products$/, { timeout: 15000 });
  await page.waitForSelector("#template-details .tp-head");
  assert.equal(await page.textContent(".tp-head h1"), "Products");

  await page.goto(`${app.base}/templates?template=no-such-template`);
  await page.waitForSelector("#templates-grid .board-card");
  assert.equal(new URL(page.url()).search, "", "the address is the grid's again");
  await page.waitForSelector(".toast:has-text(\"That template isn't on this server.\")");
  assert.equal(await page.isVisible("#template-details"), false);
  assert.deepEqual(page.errors, []);
});

test("a blank board's name, typed before the AI-models strip lands, still counts once it has", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  // Hold the strip's feed back, so the name goes in first.
  await page.route("**/api/admin/capabilities", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.click(".tool-btn:has-text('New board')");
  await page.click('#new-board-modal .nb-type:has(.nb-name:text-is("Files"))');
  await page.waitForSelector("#board-modal-name");
  await page.fill("#board-modal-name", "Typed early");
  await page.waitForFunction(() => document.querySelector("#board-modal-save").getAttribute("aria-disabled") === null);
  assert.equal(await page.locator("#board-edit-modal .glyph-btn:not(:empty)").count(), 0, "the strip hadn't landed yet");
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)", { timeout: 15000 });
  await page.waitForTimeout(300);
  assert.equal(await page.getAttribute("#board-modal-save", "aria-disabled"), null, "still live once it had");
  assert.deepEqual(page.errors, []);
});

// The first click opens the board modal at once, and its dialog is narrower
// than the details' column, so the second can land on the modal's overlay,
// whose click-out closed what the first had just opened.
test("a double-click on Use this template leaves the board modal open, even where the button lies outside the dialog", async () => {
  const page = await app.open("/templates?template=products", { sid: admin.sid });
  await page.waitForSelector(".tp-actions button");
  const box = await page.locator(".tp-actions button").boundingBox();
  const x = box.x + 2;
  await page.mouse.dblclick(x, box.y + box.height / 2);
  const state = await (await page.waitForFunction(() => {
    const o = document.getElementById("board-edit-modal");
    if (!o || o.classList.contains("is-closing")) return "closed";
    return o.querySelector(".glyph-btn:not(:empty)") ? "open" : null;
  }, null, { timeout: 15000 })).jsonValue();
  assert.equal(state, "open");
  assert.ok(x < await page.$eval("#board-edit-modal .modal-dialog", (d) => d.getBoundingClientRect().left), "the second click was outside the dialog");
  assert.deepEqual(page.errors, []);
});

test("when the templates won't load, the page says so and Start blank still works", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  await page.route("**/api/admin/templates", (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the folder is gone" }) }));
  await page.goto(`${app.base}/templates`);
  await page.waitForSelector("#templates-grid .boards-note");
  assert.equal(await page.textContent("#templates-grid .boards-note"), "Couldn't load the templates: the folder is gone");
  await page.click("#templates-grid button.bc-new");
  await page.waitForSelector("#new-board-modal .nb-types");
  assert.deepEqual(page.errors, []);
});

// styles.css draws the header as a grid, which beat the hidden attribute: an
// empty card showed above "Checking access…".
test("the page's header stays hidden behind the access check", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/api/me", async (route) => { await held; await route.continue(); });
  await page.goto(`${app.base}/templates`, { waitUntil: "commit" });
  await page.waitForSelector("#gate", { state: "visible" });
  assert.equal(await page.isVisible("header"), false);
  assert.equal(await page.isVisible("#templates-title"), false, "nor the page's title");
  release();
  await page.waitForSelector("#templates-grid .board-card");
  assert.equal(await page.isVisible("header"), true);
  assert.deepEqual(page.errors, []);
});

test("at 320px wide neither the boards page nor the templates page scrolls sideways", async () => {
  const device = { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true };
  for (const [url, ready] of [["/boards", ".board-card"], ["/templates", "#templates-grid .board-card"], ["/templates?template=products", ".tp-head"]]) {
    const page = await app.open(url, { sid: admin.sid, device });
    await page.waitForSelector(ready);
    const width = await page.evaluate(() => ({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.deepEqual(width, { inner: 320, scroll: 320 }, url);
    await page.close();
  }
});

// Each grid has the page's title over it, in the title list's serif (type.css):
// 32px, and 26px on a phone, as the welcome page's title. A template's details
// have their own title, its name, so the page's goes with the grid.
test("the boards and templates pages each have a 32px serif title over the grid, 26px on a phone", async () => {
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  for (const [device, size] of [[undefined, "32px"], [phone, "26px"]]) {
    for (const [url, id, text] of [["/boards", "boards-title", "Boards"], ["/templates", "templates-title", "Templates"]]) {
      const page = await app.open(url, { sid: admin.sid, device });
      await page.waitForSelector(".bc-grid > *");
      const title = await page.$eval(`#${id}`, (h) => {
        const s = getComputedStyle(h);
        const grid = document.querySelector(".bc-grid").firstElementChild.getBoundingClientRect();
        return {
          text: h.textContent, shown: h.checkVisibility(), size: s.fontSize, face: s.fontFamily.split(",")[0], weight: s.fontWeight,
          over: h.getBoundingClientRect().bottom <= grid.top, aligned: h.getBoundingClientRect().left === grid.left,
        };
      });
      assert.deepEqual(title, { text, shown: true, size, face: '"Source Serif 4"', weight: "600", over: true, aligned: true }, `${url} ${size}`);
      assert.deepEqual(page.errors, []);
      await page.close();
    }
  }
  const page = await app.open("/templates?template=products", { sid: admin.sid });
  await page.waitForSelector(".tp-head");
  assert.equal(await page.isVisible("#templates-title"), false, "the details have their own");
});
