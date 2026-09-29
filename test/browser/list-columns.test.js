// List's columns in a real browser (planning/list-view-plan.md, Stage 3), on
// boards shaped like the built-in stocks and crypto templates and like an
// audio board: which columns a board starts with and how their values print,
// the Columns menu, a sort from a column's header, a live value reaching its
// row, a table wider than the window, and the lightbox printing a card's
// fields the same way.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, servePixels, panelSettled } from "./harness.js";
import { seedUser, req } from "../helpers.js";
import { updateBoard, createBoard, createEntity, insertItem, setBoardMembers } from "../../server/db.js";
import { manifest as stocks } from "../../server/connectors/stocks/index.js";
import { manifest as crypto } from "../../server/connectors/crypto/index.js";

let app, user;
const boards = {};
const ids = new Map(); // a row's name → its entity id

before(async () => {
  app = await openApp();
  let boardId;
  ({ user, boardId } = await app.signIn({ boardName: "Stocks" }));
  boards.stocks = boardId;
  const board = async (name, mapping) => {
    const id = await createBoard(app.db, name, [], "", true, null, null, { enabled: false });
    await setBoardMembers(app.db, id, [user.id]);
    if (mapping) await updateBoard(app.db, id, { mapping });
    return id;
  };
  // The templates' own mappings: every field bound (PLUGIN.md).
  await updateBoard(app.db, boards.stocks, { mapping: { ...stocks.template } });
  boards.wide = await board("Wide stocks", { ...stocks.template });
  boards.crypto = await board("Crypto", { ...crypto.template });
  // A file board with two file fields and an AI one on its mapping, for the
  // lightbox's sections.
  boards.audio = await board("Audio", {
    fields: [
      { key: "modified", kind: "date", source: "file", fn: "modified" },
      { key: "duration", kind: "number", source: "file", fn: "duration" },
      { key: "year", kind: "number", source: "extract", instruction: "the year it was recorded" },
    ],
  });

  const now = Date.now();
  // Values in the shape the providers store them (runtime.fetchEntity).
  const field = (v, src) => ({ v, kind: typeof v === "number" ? "number" : typeof v === "string" && /^https?:/.test(v) ? "url" : "text", src, at: now });
  const connectorItem = async (boardId, name, symbol, values, src) => {
    const fields = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, field(v, src)]));
    const eid = await createEntity(app.db, boardId, { identity: symbol.toLowerCase(), displayName: name, symbol, fields });
    await insertItem(app.db, boardId, { identity: symbol.toLowerCase(), files: [], fields: {} }, "tagged", eid);
    ids.set(name, eid);
  };
  const stock = (price, change_1d, market_cap, volume, pe_ratio, dividend_yield, sector, industry) => ({
    price, change_1d, market_cap, volume, pe_ratio, dividend_yield, sector, industry,
    exchange: "NYSE", currency: "USD", website: "https://example.com",
  });
  const F = "financialmodelingprep";
  await connectorItem(boards.stocks, "Coca-Cola Co", "KO", stock(62.4, -0.84, 268.9e9, 12345678, 24.87, 3.12, "Consumer Defensive", "Beverages - Non-Alcoholic"), F);
  await connectorItem(boards.stocks, "Apple Inc.", "AAPL", stock(227.52, 1.23, 3.45e12, 45234567, 34.7, 0.44, "Technology", "Consumer Electronics"), F);
  await connectorItem(boards.stocks, "NVIDIA Corporation", "NVDA", stock(118.11, 2.51, 2.9e12, 312345678, 55.2, 0.03, "Technology", "Semiconductors"), F);
  for (let i = 1; i <= 40; i++) {
    await connectorItem(boards.wide, `Company ${String(i).padStart(2, "0")}`, `C${i}`, stock(10 + i, i % 3 ? 1 : -1, i * 1e9, i * 1e5, 10 + i / 10, i / 10, "Industrials", "Machinery"), F);
  }
  await connectorItem(boards.crypto, "Bitcoin", "BTC", {
    price: 64123.45, market_cap: 1.264e12, change_1h: 0.12, change_24h: 2.5, change_7d: -3.1, change_30d: 8.4,
    volume: 31.2e9, rank: 1, ath: 73750, circulating_supply: 19712345, url: "https://www.coingecko.com/en/coins/bitcoin",
  }, "coingecko");

  // Audio files with what the audio handler reads at ingest (server/media).
  const clip = async (name, file, meta, modified, extra = {}) => {
    const entry = { name: file, original_name: file, kind: "audio", size: meta.size, addedAt: now, modifiedAt: Date.parse(`${modified}T12:00:00Z`), meta };
    const eid = await createEntity(app.db, boards.audio, { identity: file, displayName: name });
    await insertItem(app.db, boards.audio, {
      identity: file, files: [entry],
      // What the extract leg lands: the file fields as they project, and an
      // AI answer as { v, why } with no kind (worker.js).
      fields: { modified: { v: modified, src: "file", kind: "date" }, duration: { v: meta.duration, src: "file", kind: "number" }, ...extra },
    }, "tagged", eid);
    ids.set(name, eid);
  };
  await clip("Harbor Lights", "harbor.mp3", { size: 88_400_000, duration: 2211.6, bitrate: 320000, sample_rate: 44100, channels: 2, codec: "MPEG 1 Layer 3" },
    "2026-09-14", { year: { v: 2024, why: "The broadcast is dated 2024." } });
  await clip("Voice memo", "memo.m4a", { size: 595_000, duration: 74.4, bitrate: 64000, sample_rate: 48000, channels: 1, codec: "AAC" }, "2026-09-20");
});
after(() => app?.close());

// A board in a fresh page, in List (the viewer's saved choice), with whatever
// else the viewer has saved for it.
async function openList(boardId, { columns, sort, width = 1280, height = 800 } = {}) {
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  await servePixels(page);
  await page.setViewportSize({ width, height });
  await page.evaluate(([id, columns, sort]) => {
    localStorage.setItem(`boardView:${id}`, "list");
    if (columns) localStorage.setItem(`boardColumns:${id}`, JSON.stringify(columns));
    if (sort) localStorage.setItem(`boardSort:${id}`, JSON.stringify(sort));
  }, [boardId, columns, sort]);
  await page.reload();
  await page.waitForSelector("#grid tr.list-row[data-id]");
  return page;
}

// The table as a reader sees it: the column headers (without the sort's
// arrow), and each row's cells by header, keyed by the row's name.
const table = (page) => page.evaluate(() => {
  const t = document.querySelector("#grid table.list-table");
  const heads = [...t.querySelectorAll("thead th")].map((th) => th.textContent.replace(/[↑↓]/g, "").trim());
  const rows = [...t.querySelectorAll("tbody tr[data-id]")].map((tr) =>
    Object.fromEntries([...tr.children].map((td, i) => [heads[i], td.textContent.trim()])));
  return { heads, order: rows.map((r) => r.Name), cell: Object.fromEntries(rows.map((r) => [r.Name, r])) };
});
// The data columns: what sits between the name and the hearts.
const dataHeads = (heads) => heads.slice(heads.indexOf("Name") + 1, heads.indexOf("Hearts"));
const headOf = (page, label) => page.locator("#grid thead th", { hasText: label });

test("a stocks board starts with Date added and the domain's headline numbers, each printed by its format", async () => {
  const page = await openList(boards.stocks);
  // The board's first sort is the domain's (market cap), once the catalog lands.
  await page.waitForSelector('#grid thead th[aria-sort="descending"]:has-text("Market cap")');
  const t = await table(page);
  assert.deepEqual(dataHeads(t.heads), ["Date added", "Price (USD)", "Market cap (USD)", "Volume"], "the defaults (D5)");
  assert.deepEqual(t.order, ["Apple Inc.", "NVIDIA Corporation", "Coca-Cola Co"], "by market cap");
  const ko = t.cell["Coca-Cola Co"];
  assert.equal(ko["Price (USD)"], "$62.40", "dollars, to the cent");
  assert.equal(ko["Market cap (USD)"], "$268.90B");
  assert.equal(ko.Volume, "12,345,678", "a share count, not dollars");
  const align = await page.evaluate(() => {
    const row = document.querySelector("#grid tbody tr[data-id]");
    return [...row.children].map((td) => getComputedStyle(td).textAlign);
  });
  assert.deepEqual(align.slice(3, 7), ["start", "right", "right", "right"], "numbers line up on the right, the date on the left");
  assert.deepEqual(page.errors, []);
});

// Where each number column's header ends against its values, as a reader sees
// it: each line of the label, and the sort's arrow, by how far its right edge
// is from the values' right edge (0 = flush).
const numberHeads = (page) => page.evaluate(() => {
  const rights = (node) => {
    const r = document.createRange();
    r.selectNodeContents(node);
    return [...r.getClientRects()].filter((b) => b.width > 0).map((b) => b.right);
  };
  const rows = [...document.querySelectorAll("#grid tbody tr[data-id]")];
  return [...document.querySelectorAll("#grid thead th")].flatMap((th, i) => {
    if (!th.classList.contains("num")) return [];
    const button = th.querySelector(".list-sort");
    const arrow = button.querySelector(".list-arrow");
    const values = rows.map((tr) => rights(tr.children[i])[0]);
    const off = (x) => Math.round(x - values[0]);
    return [{
      label: button.firstChild.textContent,
      lines: rights(button.firstChild).map(off),
      arrow: arrow ? off(rights(arrow)[0]) : null,
      values: values.map(off),
    }];
  });
});

test("a number column's header sits over its values: every line of the label ends at their edge, or at the sort's arrow", async () => {
  // Two labels that wrap and one that doesn't, unsorted, and the sort on a
  // fourth: what the user's board showed.
  const page = await openList(boards.stocks, {
    columns: ["field:price", "field:change_1d", "field:market_cap", "field:volume"],
    sort: { by: "field:volume", dir: "desc", label: "Volume" },
  });
  await headOf(page, "Daily change").waitFor();
  const byLabel = async () => Object.fromEntries((await numberHeads(page)).map((c) => [c.label, c]));
  let heads = await byLabel();
  for (const c of Object.values(heads)) assert.ok(c.values.every((v) => v === 0), `setup: ${c.label}'s values line up`);
  assert.deepEqual(heads["Price (USD)"].lines, [0], "an unsorted label ends where its values do");
  assert.deepEqual(heads["Daily change (%)"].lines, [0, 0], "each line of one that wraps, too");
  assert.deepEqual(heads["Market cap (USD)"].lines, [0, 0]);
  assert.equal(heads.Volume.arrow, 0, "the sorted column's arrow ends where its values do");
  assert.ok(heads.Volume.lines[0] < 0, "and its label just before it");
  // The sort on a label that wraps: both lines end at the arrow.
  await headOf(page, "Market cap (USD)").locator(".list-sort").click();
  await page.waitForSelector('#grid thead th[aria-sort="descending"]:has-text("Market cap")');
  heads = await byLabel();
  const cap = heads["Market cap (USD)"];
  assert.equal(cap.arrow, 0, "the arrow is flush with the values");
  assert.equal(cap.lines.length, 2, "setup: still two lines");
  assert.ok(cap.lines[0] < 0 && cap.lines[1] === cap.lines[0], `both lines end just before the arrow (${cap.lines})`);
  assert.deepEqual(heads.Volume.lines, [0], "the column that lost the sort: flush again");
  assert.deepEqual(page.errors, []);
});

test("the Columns menu turns a column on and off, keeps the pick for the board, and resets it", async () => {
  // A saved sort, so the catalog these columns need comes from the board's
  // own load, not from the sort's seeding.
  const page = await openList(boards.stocks, { sort: { by: "name", dir: "asc", label: "Name" } });
  await headOf(page, "Price (USD)").waitFor();
  await page.click(".columns-btn");
  await page.waitForSelector(".columns-pop");
  const menu = () => page.evaluate(() => [...document.querySelectorAll(".columns-pop .dd-head, .columns-pop .dd-check")].map((el) =>
    el.classList.contains("dd-head") ? `# ${el.textContent}` : `${el.querySelector("input").checked ? "on" : "off"} ${el.textContent.trim()}`));
  const items = await menu();
  assert.deepEqual(items.filter((s) => s.startsWith("#")), ["# Board", "# Stocks"], "the board's sections");
  assert.deepEqual(items.filter((s) => s.startsWith("on")), ["on Date added", "on Price (USD)", "on Market cap (USD)", "on Volume"], "what shows is checked");
  await page.locator(".columns-pop .dd-check", { hasText: "Daily change (%)" }).click();
  await headOf(page, "Daily change").waitFor();
  const t = await table(page);
  assert.deepEqual(dataHeads(t.heads), ["Date added", "Price (USD)", "Daily change (%)", "Market cap (USD)", "Volume"], "in the catalog's order");
  const change = await page.evaluate(() => [...document.querySelectorAll("#grid tbody td.num")]
    .filter((td) => /%$/.test(td.textContent)).map((td) => [td.textContent, td.className.includes("change-down") ? "down" : "up", getComputedStyle(td).color]));
  assert.deepEqual(change.map(([text, tone]) => [text, tone]), [["+1.23%", "up"], ["-0.84%", "down"], ["+2.51%", "up"]],
    "a change, signed (Apple, Coca-Cola, NVIDIA: by name)");
  assert.equal(change[1][2], "rgb(220, 38, 38)", "a fall in red");
  assert.equal(change[0][2], "rgb(22, 163, 74)", "a rise in green");
  const saved = await page.evaluate((id) => JSON.parse(localStorage.getItem(`boardColumns:${id}`)), boards.stocks);
  assert.deepEqual(saved, ["created", "field:price", "field:change_1d", "field:market_cap", "field:volume"], "kept for the board, in catalog order");
  await page.keyboard.press("Escape");
  await page.reload();
  await headOf(page, "Daily change").waitFor();
  assert.ok(dataHeads((await table(page)).heads).includes("Daily change (%)"), "still there after a reload");
  await page.click(".columns-btn");
  await page.waitForSelector(".columns-pop");
  await page.locator(".columns-pop .dd-action", { hasText: "Reset to the board's defaults" }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll("#grid thead th")].some((th) => th.textContent.includes("Daily change")));
  assert.deepEqual(dataHeads((await table(page)).heads), ["Date added", "Price (USD)", "Market cap (USD)", "Volume"], "the defaults again");
  assert.equal(await page.evaluate((id) => localStorage.getItem(`boardColumns:${id}`), boards.stocks), null, "and nothing kept");
  await page.click(".view-btn.active"); // back to the grid
  await page.waitForSelector("#grid .card");
  assert.equal(await page.locator(".columns-btn").count(), 0, "the menu is List's alone");
  assert.deepEqual(page.errors, []);
});

test("a data column's header sorts by it, and the toolbar says so", async () => {
  const page = await openList(boards.stocks);
  await page.waitForSelector('#grid thead th[aria-sort="descending"]:has-text("Market cap")');
  await headOf(page, "Price (USD)").locator(".list-sort").click();
  await page.waitForSelector('#grid thead th[aria-sort="descending"]:has-text("Price")');
  assert.deepEqual((await table(page)).order, ["Apple Inc.", "NVIDIA Corporation", "Coca-Cola Co"], "highest price first");
  assert.equal((await page.locator(".sort-btn").textContent()).trim(), "Price (USD) ↓");
  await headOf(page, "Price (USD)").locator(".list-sort").click();
  await page.waitForSelector('#grid thead th[aria-sort="ascending"]:has-text("Price")');
  assert.deepEqual((await table(page)).order, ["Coca-Cola Co", "NVIDIA Corporation", "Apple Inc."], "and flipped");
  assert.deepEqual(page.errors, []);
});

test("a value that changes reaches its row", async () => {
  const page = await openList(boards.stocks);
  await headOf(page, "Price (USD)").waitFor();
  assert.equal((await table(page)).cell["Coca-Cola Co"]["Price (USD)"], "$62.40", "setup: the price before");
  // A refresh lands a new price (what the connector's refresh writes), and a
  // heart from another member, on ANOTHER row, is the nudge that brings the
  // page to look. On the same row the heart's count would redraw it anyway.
  const ko = ids.get("Coca-Cola Co");
  const nvda = ids.get("NVIDIA Corporation");
  await app.db.query(`UPDATE entities SET fields = jsonb_set(fields, '{price,v}', '70.5'), updated_at = $2 WHERE id = $1`, [ko, Date.now()]);
  const other = await seedUser(app.db, "prices@test.local");
  await setBoardMembers(app.db, boards.stocks, [user.id, other.id]);
  const hearted = await req(app.base, "POST", `/api/items/${nvda}/favorite`, { sid: other.sid });
  assert.equal(hearted.status, 200, "setup: the other member's heart");
  // The nudge has landed once the heart shows in its own row.
  await page.waitForFunction((id) => document.querySelector(`#grid tr[data-id="${id}"] .heart .hc`)?.textContent === "1", nvda, { timeout: 12000 });
  assert.equal((await table(page)).cell["Coca-Cola Co"]["Price (USD)"], "$70.50", "the new price, in its row");
  await req(app.base, "DELETE", `/api/items/${nvda}/favorite`, { sid: other.sid });
  await app.db.query(`UPDATE entities SET fields = jsonb_set(fields, '{price,v}', '62.4') WHERE id = $1`, [ko]);
  assert.deepEqual(page.errors, []);
});

test("columns wider than the window: the page scrolls sideways, the names stay pinned and the header stuck", async () => {
  const all = ["created", "updated", ...stocks.fields.filter((f) => f.kind !== "url").map((f) => `field:${f.fn}`)];
  const page = await openList(boards.wide, { columns: all });
  await headOf(page, "Industry").waitFor();
  const at = () => page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const th = document.querySelector("#grid thead th.list-name");
    // A row's name mid-window, clear of both headers.
    const td = [...document.querySelectorAll("#grid tbody td.list-name")].find((el) => box(el).top > innerHeight / 2);
    const hit = (el) => { const r = box(el); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); };
    return {
      wide: document.documentElement.scrollWidth > innerWidth,
      x: scrollX, headLeft: Math.round(box(th).left), cellLeft: Math.round(box(td).left),
      headTop: Math.round(box(th).top), under: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-bottom")),
      headOnTop: hit(th), cellOnTop: hit(td),
      opaque: getComputedStyle(td).backgroundColor,
      edge: getComputedStyle(td).boxShadow,
    };
  });
  const rest = await at();
  assert.ok(rest.wide, "the table is wider than the window, and the page scrolls sideways");
  assert.ok(!/1px 0px 0px/.test(rest.edge), `no edge at rest: ${rest.edge}`);
  // On a loaded runner the wheel's scroll can reach the page seconds late, so
  // the test waits for it and for the page header's fold, not a set time. And
  // sideways moves only left: restating a y read before the wheel's scroll
  // landed could put the page back at the top.
  await page.mouse.wheel(0, 900);
  await page.waitForFunction(() => {
    const header = document.querySelector("header");
    return scrollY >= 900 && header.classList.contains("header-collapsed") && !header.getAnimations().length;
  });
  await page.evaluate(() => window.scrollTo({ left: 700 }));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // drawn there
  const s = await at();
  assert.equal(s.x, 700, "setup: scrolled sideways");
  assert.equal(s.headLeft, 152, "the name's header stays at the left, after the select and the picture");
  assert.equal(s.cellLeft, 152, "and so does a row's name");
  assert.ok(Math.abs(s.headTop - (s.under + 6)) <= 1, `the header still sticks under the page header: ${s.headTop} vs ${s.under + 6}`);
  assert.ok(s.headOnTop, "the pinned header is over the columns sliding under it");
  assert.ok(s.cellOnTop, "and a row's pinned name over its cells");
  assert.equal(s.opaque, "rgb(255, 255, 255)", "a pinned cell hides what slides under it");
  assert.match(s.edge, /1px 0px 0px/, "scrolled, the name draws its edge");
  assert.deepEqual(page.errors, []);
});

test("a row's tint reaches its pinned cells: hovered, and selected over hovered", async () => {
  const page = await openList(boards.stocks);
  await headOf(page, "Price (USD)").waitFor();
  const name = page.locator('#grid .list-open[title="Coca-Cola Co"]');
  const tint = () => name.evaluate((b) => getComputedStyle(b.closest("td")).backgroundColor);
  assert.equal(await tint(), "rgb(255, 255, 255)", "setup: at rest");
  await name.hover();
  assert.equal(await tint(), "rgb(250, 250, 252)", "hovered");
  await page.locator(`#grid tr[data-id="${ids.get("Coca-Cola Co")}"] .sel-cb`).click();
  await name.hover();
  assert.equal(await tint(), "rgb(240, 240, 244)", "selected, over the hover");
  assert.deepEqual(page.errors, []);
});

test("the name keeps its floor: a narrow window scrolls rather than squeezing it", async () => {
  const page = await openList(boards.stocks, { width: 1024 });
  await headOf(page, "Volume").waitFor();
  const m = await page.evaluate(() => ({
    name: document.querySelector("#grid thead th.list-name").getBoundingClientRect().width,
    wide: document.documentElement.scrollWidth > innerWidth,
  }));
  assert.ok(m.name >= 236, `the name column keeps about 240px: ${m.name}`);
  assert.ok(m.wide, "the page scrolls sideways instead");
  assert.deepEqual(page.errors, []);
});

test("an audio board's file columns print their units, and a file's date is its own day west of UTC", async () => {
  const columns = ["created", "media:file_size", "media:modified", "media:duration", "media:bitrate", "media:sample_rate", "media:channels"];
  const page = await openList(boards.audio, { columns });
  await headOf(page, "Duration").waitFor();
  const harbor = (await table(page)).cell["Harbor Lights"];
  assert.deepEqual([harbor["File size"], harbor.Duration, harbor.Bitrate, harbor["Sample rate"], harbor.Channels],
    ["84.3 MB", "36:51", "320 kbps", "44.1 kHz", "stereo"]);
  assert.equal((await table(page)).cell["Voice memo"].Channels, "mono");
  assert.deepEqual(page.errors, []);
  // A viewer in California. The file says 14 September; so does its row.
  const ctx = await app.browser.newContext({ timezoneId: "America/Los_Angeles", locale: "en-US" });
  try {
    await ctx.addCookies([{ name: "sid", value: user.sid, url: app.base }]);
    await ctx.addInitScript(([id, cols]) => {
      localStorage.setItem(`boardView:${id}`, "list");
      localStorage.setItem(`boardColumns:${id}`, cols);
    }, [boards.audio, JSON.stringify(columns)]);
    const west = await ctx.newPage();
    await west.goto(`${app.base}/?board=${boards.audio}`);
    await headOf(west, "Modified").waitFor();
    const t = await table(west);
    assert.equal(t.cell["Harbor Lights"].Modified, "9/14/2026");
    assert.equal(t.cell["Voice memo"].Modified, "9/20/2026");
  } finally {
    await ctx.close();
  }
});

// The lightbox's Details panel, open on a row: each section's fields, as
// "key value".
async function panelFields(page, name) {
  await page.locator(`#grid .list-open[title="${name}"]`).click();
  await page.waitForSelector("#lightbox:not([hidden])");
  await page.click("#lightbox-info");
  await panelSettled(page, true);
  await page.waitForFunction(() => !document.querySelector("#lightbox-panel-body .lbp-hint")?.textContent.includes("Loading"));
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#lightbox-panel-body .lbp-fields")].map((sec) => [
    sec.querySelector(".lbp-fields-head .section-title, .lbp-fields-head")?.textContent.replace("Re-extract", "").trim(),
    [...sec.querySelectorAll(".lbp-field-kv")].map((kv) => `${kv.querySelector(".lbp-field-key-main").firstChild.textContent} ${kv.querySelector(".lbp-field-val").textContent}`),
  ])));
}

test("the lightbox prints a card's fields by their formats, in the mapping's order", async () => {
  let page = await openList(boards.stocks);
  await headOf(page, "Price (USD)").waitFor();
  const apple = await panelFields(page, "Apple Inc.");
  assert.deepEqual(apple["Connector fields"], [
    "price $227.52", "change_1d +1.23%", "market_cap $3.45T", "volume 45,234,567", "pe_ratio 34.7", "dividend_yield 0.44",
    "sector Technology", "industry Consumer Electronics", "exchange NYSE", "currency USD", "website https://example.com",
  ], "the template's order; a P/E, a yield and a share count as plain numbers");
  assert.deepEqual(page.errors, []);

  page = await openList(boards.crypto);
  await headOf(page, "Price (USD)").waitFor();
  const btc = (await panelFields(page, "Bitcoin"))["Connector fields"];
  for (const line of ["price $64,123.45", "change_24h +2.50%", "volume $31.20B", "rank 1", "ath $73,750.00", "circulating_supply 19,712,345"]) {
    assert.ok(btc.includes(line), `${line}: ${btc.join(" | ")}`);
  }
  assert.deepEqual(page.errors, []);

  page = await openList(boards.audio);
  const harbor = await panelFields(page, "Harbor Lights");
  assert.deepEqual(harbor["File fields"], ["modified 9/14/2026", "duration 36:51"], "a file field by the media catalog's format");
  assert.deepEqual(harbor["AI-extracted fields"], ["year 2024"], "an AI answer as it is");
  assert.deepEqual(page.errors, []);
});
