// A board loading in the viewer's sort, on screen (planning/sorted-loading-plan.md,
// Stage 2b): the true top draws at once, and a card on screen never moves
// because more of the board arrived. Every frame, the page records the ids
// of the cards drawn; each list must be the start of the next, so cards are
// only ever added at the end.
//
// Cards arriving in order would pass that on their own: the load fetches in
// the page's order. What the cut is for is a card arriving EARLY, so these
// make that happen: a heart from another member on a card the load hasn't
// reached, which the page's event channel brings at once, and a sort change
// mid-load, which leaves the cards already loaded scattered through the new
// order. And the grid draws its first 60, which a first page of 200 fills, so
// the big board is filtered to a colour one card in ten carries: the drawn
// list then reaches the end of what's loaded. The batch requests are held and
// let go one at a time.
//
// Stage 3 is here too: a search typed mid-load, and a link to one card, fetch
// the cards they need at once. The load's batches stay held while those
// requests, to the same address, go through.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, servePixels } from "./harness.js";
import { seedUser, req } from "../helpers.js";
import { createBoard, setBoardMembers, createEntity, insertItem, deleteEntity } from "../../server/db.js";
import { compareKeys, NEWEST } from "../../public/sort-core.js";

let app, user, fan;
let big; // 1,200 cards, one in ten red: { id, card: i -> entity id, red: Set of ids }
const COLOUR = [{ key: "color", label: "Colour", values: ["red", "blue"] }];
const OLDEST = { by: "created", dir: "asc", label: "Date added" };
const NAME = { by: "name", dir: "asc", label: "Name" };
const RED = 120;

// A raw board of n cards: card i is the i-th added, its original name runs in
// another order (a step through i), and every tenth is red. Out of the embed
// lane, so the page doesn't poll: what arrives early is what a test sends.
async function seedBoard(name, n) {
  const id = await createBoard(app.db, name, COLOUR, "", true, null, null, { enabled: false });
  await setBoardMembers(app.db, id, [user.id, fan.id]);
  const card = [];
  for (let start = 1; start <= n; start += 50) {
    await Promise.all(Array.from({ length: Math.min(50, n - start + 1) }, async (_, k) => {
      const i = start + k;
      const stored = `${name}-${i}.png`;
      const eid = await createEntity(app.db, id, { identity: stored });
      const original = `n${String((i * 7) % n).padStart(4, "0")}.png`;
      const item = await insertItem(app.db, id, { identity: stored, files: [{ name: stored, original_name: original, kind: "image", w: 10, h: 10 }], fields: {} }, "tagged", eid);
      await app.db.query("UPDATE items SET tags=$1, embed_error='none' WHERE id=$2", [JSON.stringify([i % 10 ? "color/blue" : "color/red"]), item]);
      await app.db.query("UPDATE entities SET created_at=$1, updated_at=$1 WHERE id=$2", [1_000_000 + i * 1000, eid]);
      card[i] = eid;
    }));
  }
  return { id, card, red: new Set(card.filter((_, i) => i % 10 === 0).map(String)) };
}

before(async () => {
  app = await openApp();
  ({ user } = await app.signIn());
  fan = await seedUser(app.db, "fan@test.local");
  big = await seedBoard("big", 1200);
  // Every fortieth card has a heart, for the change to Hearts.
  for (let i = 40; i <= 1200; i += 40) {
    await app.db.query("INSERT INTO favorites (user_id, item_id, created_at) VALUES ($1, $2, 1)", [fan.id, big.card[i]]);
  }
});
after(() => app?.close());

// A board in a fresh page: the viewer's saved sort, the frame recorder in from
// the first paint, and the batch requests held, but for those `pass` lets
// through by the ids they ask for.
async function openBoard(boardId, { sort, filter, item, pass } = {}) {
  const page = await app.open("/api/me", { sid: user.sid });
  await servePixels(page, { thumbnails: true });
  const held = [];
  await page.route("**/api/items/batch", (route) => {
    if (pass?.(route.request().postDataJSON().ids)) route.continue();
    else held.push(route);
  });
  await page.addInitScript(() => {
    window.__frames = [];
    // The progress lane too: its cards carry no data-id, so by their pictures'
    // names, and the count on its "+N processing…" tail.
    window.__lane = [];
    const look = () => {
      const ids = [...document.querySelectorAll("#grid [data-id]")].map((el) => el.dataset.id).join(",");
      if (window.__frames.at(-1) !== ids) window.__frames.push(ids);
      const lane = [...document.querySelectorAll("#grid .card.loading img")].map((img) => img.alt).join(",") +
        (document.querySelector("#grid .lane-more-count")?.textContent || "");
      if (window.__lane.at(-1) !== lane) window.__lane.push(lane);
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.evaluate(([id, sort]) => { if (sort) localStorage.setItem(`boardSort:${id}`, JSON.stringify(sort)); }, [boardId, sort]);
  await page.goto(`${app.base}/?board=${boardId}${filter ? `&f=${filter}` : ""}${item ? `&item=${item}` : ""}`);
  await page.waitForSelector("#grid [data-id]"); // the first page, drawn while every batch is held
  return { page, held };
}

const frames = (page, n = 2) =>
  page.evaluate((n) => new Promise((done) => {
    const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : done());
    step(n);
  }), n);
const count = (page) => page.evaluate(() => document.querySelector(".result-count")?.textContent);
const sortLabel = async (page) => (await page.locator(".sort-btn").textContent()).trim();

// Let the held batches go one at a time, a couple of frames apart, until the
// count says the whole list is in.
async function drain(page, held, want) {
  const deadline = Date.now() + 20000;
  while ((await count(page)) !== want) {
    if (Date.now() > deadline) throw new Error(`the load never got to ${want}: the count says ${await count(page)}`);
    if (held.length) {
      await held.shift().continue();
      await frames(page);
    } else await new Promise((r) => setTimeout(r, 20));
  }
  await frames(page);
}

// The recorded frames as id lists, and where one wasn't the start of the next.
async function recorded(page) {
  const lists = (await page.evaluate(() => window.__frames)).map((s) => (s ? s.split(",") : []));
  const breaks = [];
  for (let i = 1; i < lists.length; i++) {
    if (!lists[i - 1].every((id, k) => id === lists[i][k])) breaks.push(i);
  }
  return { lists, breaks };
}

// The board's order for a sort, from the server's keys, ordered the way the
// page orders them: the ids as the page's data-id carries them.
async function orderOf(boardId, sort, only = null) {
  const q = sort ? `&by=${sort.by}&dir=${sort.dir}` : "";
  const { json } = await req(app.base, "GET", `/api/items/sorted?board=${boardId}${q}&limit=1`, { sid: user.sid });
  return json.keys.map(([id, created_at, v = created_at]) => ({ id, created_at, v }))
    .sort(compareKeys(sort || NEWEST)).map((k) => String(k.id)).filter((id) => !only || only.has(id));
}

const menuRow = (page, label) => page.locator(".dropdown.sort-pop .dd-row").filter({ hasText: new RegExp(`^${label}$`) });
async function pick(page, label) {
  await page.locator(".sort-btn").click();
  await menuRow(page, label).click();
}

// Someone else hearts a card; resolves once the page's refresh has brought it.
async function heartFromAnother(page, entityId) {
  const arrived = page.waitForResponse(async (r) =>
    r.url().includes("/api/items?") && r.url().includes("since=") &&
    !!(await r.json().catch(() => null))?.items?.some((i) => i.id === entityId));
  assert.equal((await req(app.base, "POST", `/api/items/${entityId}/favorite`, { sid: fan.sid })).status, 200);
  await arrived;
  await frames(page);
}

for (const [sort, deep, what] of [
  [OLDEST, 1100, "oldest first"],
  // The red card with the last name: n1190.png.
  [NAME, 170, "by Name"],
]) {
  test(`${what}: the first cards draw at once, and cards are only ever added at the end, even one that arrives early`, async () => {
    const { page, held } = await openBoard(big.id, { sort, filter: "color:red" });
    assert.ok((await count(page)) !== `${RED} items`, "setup: the first cards drew while the rest was held");
    // A card the load hasn't reached, brought now by someone's heart.
    await heartFromAnother(page, big.card[deep]);
    await drain(page, held, `${RED} items`);

    const { lists, breaks } = await recorded(page);
    assert.deepEqual(breaks, [], "no frame took a card back or moved one");
    const final = lists.at(-1);
    assert.deepEqual(final, (await orderOf(big.id, sort, big.red)).slice(0, final.length));
    assert.deepEqual(page.errors, []);
  });
}

test("a sort change mid-load: the list changes once, when the new sort's first page lands, then only grows", async () => {
  const { page, held } = await openBoard(big.id, { sort: OLDEST, filter: "color:red" });
  await pick(page, "Hearts");
  await page.waitForFunction(() => document.querySelector(".sort-btn")?.textContent.trim() === "Hearts ↓");
  await drain(page, held, `${RED} items`);

  const { lists, breaks } = await recorded(page);
  assert.equal(breaks.length, 1, `one change of order, the swap (breaks at ${breaks})`);
  const hearts = await orderOf(big.id, { by: "hearts", dir: "desc" }, big.red);
  assert.deepEqual(lists[breaks[0]], hearts.slice(0, lists[breaks[0]].length), "the swap draws the top of Hearts");
  assert.deepEqual(lists.at(-1), hearts.slice(0, lists.at(-1).length));
  assert.deepEqual(page.errors, []);
});

test("flipping the direction mid-load never empties the grid", async () => {
  const { page, held } = await openBoard(big.id, { sort: OLDEST, filter: "color:red" });
  await pick(page, "Date added ↑");
  await page.waitForFunction(() => document.querySelector(".sort-btn")?.textContent.trim() === "Date added ↓");
  await drain(page, held, `${RED} items`);

  const { lists, breaks } = await recorded(page);
  const first = lists.findIndex((l) => l.length);
  assert.ok(lists.slice(first).every((l) => l.length), "no empty frame once the first cards drew");
  assert.equal(breaks.length, 1, "one change of order, the swap");
  assert.deepEqual(lists.at(-1), (await orderOf(big.id, null, big.red)).slice(0, lists.at(-1).length));
  assert.deepEqual(page.errors, []);
});

test("two quick sort changes mid-load: the later one wins, even when the earlier answer lands last", async () => {
  const { page, held } = await openBoard(big.id, { sort: OLDEST, filter: "color:red" });
  const heartsHeld = [];
  await page.route(/\/api\/items\/sorted\?.*by=hearts/, (route) => { heartsHeld.push(route); });
  await pick(page, "Hearts");
  await page.waitForFunction(() => document.querySelector(".dropdown.sort-pop") === null);
  await pick(page, "Name");
  await page.waitForFunction(() => document.querySelector(".sort-btn")?.textContent.trim() === "Name ↑");

  assert.equal(heartsHeld.length, 1, "setup: Hearts' answer is still out");
  const late = page.waitForResponse((r) => r.url().includes("by=hearts"));
  await heartsHeld[0].continue();
  await late;
  await frames(page, 4);
  assert.equal(await sortLabel(page), "Name ↑", "the late answer did nothing");

  await drain(page, held, `${RED} items`);
  const { lists } = await recorded(page);
  assert.deepEqual(lists.at(-1), (await orderOf(big.id, NAME, big.red)).slice(0, lists.at(-1).length));
  assert.deepEqual(page.errors, []);
});

test("a card deleted after the keys were taken: the load still gets to the end", async () => {
  const small = await seedBoard("small", 700);
  const { page, held } = await openBoard(small.id);
  assert.equal(await count(page), "200 items", "setup: the first page, the rest held");
  // Newest first, the one batch holds cards 500 to 1: delete one from its middle.
  await deleteEntity(app.db, small.card[300]);
  await drain(page, held, "699 items");
  assert.deepEqual(page.errors, []);
});

test("a connector board with no saved sort opens on its own default: market cap, from the first cards drawn", async () => {
  const id = await createBoard(app.db, "Stocks", [], "", true, null, null, { enabled: false }, false,
    { mapping: { input: { connector: "stocks" }, fields: [{ key: "market_cap", fn: "market_cap", kind: "number", source: "connector" }] } });
  await setBoardMembers(app.db, id, [user.id]);
  const at = {};
  for (const [symbol, cap, created] of [["aapl", 3000, 10], ["xom", 400, 20], ["jpm", 500, 30], ["nvda", 4000, 40], ["nee", null, 50], ["msft", 3500, 60]]) {
    const eid = await createEntity(app.db, id, { identity: symbol, symbol: symbol.toUpperCase() });
    await insertItem(app.db, id, { identity: symbol, files: [], fields: {} }, "tagged", eid);
    await app.db.query("UPDATE items SET embed_error='none' WHERE entity_ids = ARRAY[$1]::bigint[]", [eid]);
    await app.db.query("UPDATE entities SET created_at=$1, fields=$2 WHERE id=$3", [created, JSON.stringify(cap == null ? {} : { market_cap: { v: cap } }), eid]);
    at[symbol] = String(eid);
  }
  const { page } = await openBoard(id);
  const { lists } = await recorded(page);
  const drawn = lists.find((l) => l.length);
  assert.deepEqual(drawn, ["nvda", "msft", "aapl", "jpm", "xom", "nee"].map((s) => at[s]), "biggest first, the one without a value last");
  assert.equal(await sortLabel(page), "Market cap (USD) ↓");
  assert.deepEqual(page.errors, []);
});

// Stage 3. Let n of the load's held batches go, one at a time, as they come.
async function release(page, held, n) {
  const deadline = Date.now() + 20000;
  while (n) {
    if (Date.now() > deadline) throw new Error(`the load sent ${n} batches fewer than expected`);
    if (held.length) {
      await held.shift().continue();
      await frames(page);
      n--;
    } else await new Promise((r) => setTimeout(r, 20));
  }
}

test("a search typed mid-load shows every result at once, in score order, and nothing pops in as the load goes on", async () => {
  // 30 results, best first: five on the first page (newest first, cards
  // 1,200 to 1,001) among 25 the load hasn't reached. The seeded cards have
  // no embeddings, so the test gives the search's answer.
  const hits = [];
  for (let k = 0; k < 25; k++) {
    if (k % 5 === 0) hits.push(big.card[1190 - k * 8]);
    hits.push(big.card[20 + k * 40]);
  }
  const { page, held } = await openBoard(big.id, { pass: (ids) => ids.every((id) => hits.includes(id)) });
  await page.route(/\/api\/search\?/, (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ results: hits.map((id, k) => ({ id, score: 1 - k / 100 })) }),
  }));
  assert.equal(await count(page), "200 items", "setup: the first page, the rest held");
  const box = page.locator(".search-box input");
  await box.fill("red");
  await box.press("Enter");
  const shown = hits.map(String);
  await page.waitForFunction((shown) => {
    const drawn = [...document.querySelectorAll("#grid [data-id]")].map((el) => el.dataset.id);
    return drawn.length > 0 && drawn.every((id) => shown.includes(id));
  }, shown);
  await release(page, held, 2); // the rest of the board, 1,000 cards

  const { lists } = await recorded(page);
  const first = lists.findIndex((l) => l.length && l.every((id) => shown.includes(id)));
  assert.deepEqual(lists[first], shown, "the first frame of results holds every one, best first");
  assert.equal(lists.length, first + 1, "and nothing changed after it while the load finished");
  // The load did finish under it: cleared, the search gives back the whole board.
  await page.click(".search-clear");
  await page.waitForFunction(() => document.querySelector(".result-count")?.textContent === "1200 items");
  assert.deepEqual(page.errors, []);
});

test("a link to a card deep in the board opens it at once, while the load is held", async () => {
  const deep = big.card[30]; // newest first, among the last cards to load
  const { page } = await openBoard(big.id, { item: deep, pass: (ids) => ids.length === 1 && ids[0] === deep });
  await page.waitForSelector("#lightbox:not([hidden])", { timeout: 10000 });
  // The lightbox is named for its card: card 30's original name, n0210.png.
  assert.equal(await page.getAttribute("#lightbox", "aria-label"), "n0210.png", "the linked card");
  assert.equal(await count(page), "200 items", "the load is still held");
  assert.equal(new URL(page.url()).searchParams.get("item"), null, "the link is consumed");
  assert.deepEqual(page.errors, []);
});

// Stage 4 (the second pass). The lane is drawn above the grid in its own
// order, newest first; under Name the load brings its cards in name order, so
// without them all in the first answer each batch slotted some in.
test("cards in flight: the progress lane is whole from the first draw, and the load never changes it", async () => {
  // 700 cards by Name, twenty still waiting to be tagged, spread through the
  // order: most of them past the first page.
  const busy = await seedBoard("busy", 700);
  const inFlight = busy.card.filter((_, i) => i % 35 === 0);
  await app.db.query("UPDATE items SET status='pending', tags='[]' WHERE entity_ids && $1::bigint[]", [inFlight]);
  const { page, held } = await openBoard(busy.id, { sort: NAME });
  await drain(page, held, "680 items");

  const lanes = await page.evaluate(() => window.__lane);
  const first = lanes.findIndex((l) => l);
  assert.ok(first >= 0, "setup: the lane shows the cards in flight");
  assert.deepEqual(lanes.slice(first + 1), [], "the lane never changed while the load went on");
  assert.deepEqual(page.errors, []);
});

test("a link to a card that's gone says so, and opens nothing", async () => {
  const tiny = await seedBoard("tiny", 3);
  await deleteEntity(app.db, tiny.card[2]);
  const { page } = await openBoard(tiny.id, { item: tiny.card[2], pass: () => true });
  await page.getByText("That card isn't on this board any more").waitFor({ timeout: 10000 });
  assert.equal(await page.locator("#lightbox").isHidden(), true, "no lightbox");
  assert.equal(new URL(page.url()).searchParams.get("item"), null, "the link is consumed");
  assert.deepEqual(page.errors, []);
});
