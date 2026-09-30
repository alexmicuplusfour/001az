// The board's load (planning/sorted-loading-plan.md, Stages 2b and 3),
// through data.js, sort.js and search.js against a fetch stub: which cards it
// asks for and in what order, what the list draws meanwhile, how a sort
// change during it lands, and when a search's results show.
// test/browser/sorted-load.test.js proves the same on screen; this is the
// bookkeeping underneath, one piece at a time.
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import "./jsdom-stub.js";

// Every request, and an answer each test sets: a body, a promise of one (the
// test holds it), or null for a server error.
const requests = [];
let answer = () => new Promise(() => {});
globalThis.fetch = async (url, opts = {}) => {
  const req = { method: opts.method || "GET", url: String(url), body: opts.body ? JSON.parse(opts.body) : undefined };
  requests.push(req);
  const body = await answer(req);
  if (body == null) return { ok: false, status: 500, json: async () => ({ error: "down" }) };
  return { ok: true, status: 200, json: async () => body };
};

const { state } = await import("../public/state.js");
const { toItem } = await import("../public/utils.js");
const { taggedFiltered, checkCached } = await import("../public/filters.js");
const { loadRest, reconcile, fetchItems } = await import("../public/data.js");
const { setSort, restoreSort } = await import("../public/sort.js");
const { runSearch, runSimilarMeaning } = await import("../public/search.js");
const { compareItems, sortValue, NEWEST } = await import("../public/sort-core.js");

// A board of 1,203 cards: newer ids are newer cards, the names run in another
// order (a step through the ids), and every third card has hearts.
const N = 1203;
const board = new Map();
for (let id = 1; id <= N; id++) {
  board.set(id, {
    id, name: `f${id}.png`, display_name: `c${String((id * 7) % N).padStart(4, "0")}`, status: "tagged", tags: [],
    created_at: 10000 + id, updated_at: 10000 + id, hearts: id % 3 ? 0 : Math.floor(id / 100),
  });
}
const gone = new Set(); // deleted after the keys were taken

const NAME = { by: "name", dir: "asc", label: "Name" };
const HEARTS = { by: "hearts", dir: "desc", label: "Hearts" };
const OLDEST = { by: "created", dir: "asc", label: "Date added" };
const FIRST = 3; // the server's first page, kept small

// The whole board in a sort, as the page orders it.
const orderOf = (sort) => [...board.values()].map(toItem).sort(compareItems(sort || NEWEST)).map((i) => i.id);

// The server's answers. The keys come in reverse, so the page's order is
// its own.
function sortedAnswer(sort) {
  const order = orderOf(sort).filter((id) => !gone.has(id));
  const keyOf = (id) => {
    const r = board.get(id);
    return sort ? [id, r.created_at, sortValue(toItem(r), sort.by)] : [id, r.created_at];
  };
  return {
    items: order.slice(0, FIRST).map((id) => board.get(id)),
    keys: order.map(keyOf).reverse(),
    sort: sort && { by: sort.by, dir: sort.dir },
    now: 1, work: { running: [], queued: [] },
  };
}
const sortOfUrl = (url) => {
  const q = new URL(url, "http://localhost").searchParams;
  return q.get("by") ? { by: q.get("by"), dir: q.get("dir") } : null;
};
const batchAnswer = (req) => ({ items: req.body.ids.filter((id) => !gone.has(id)).map((id) => board.get(id)) });
const isSorted = (req) => req.url.startsWith("/api/items/sorted");
const isBatch = (req) => req.url === "/api/items/batch";
// A batch asking only for some of these cards: a search's, not the load's.
const isFor = (ids) => (req) => isBatch(req) && req.body.ids.every((id) => ids.includes(id));
// A search's answer: these cards, best first.
const ranked = (ids) => ({ results: ids.map((id, k) => ({ id, score: 1 - k / 100 })) });

// Batches held until the test lets them go, one at a time.
let held = [];
const holdBatch = (req) => new Promise((resolve) => held.push(() => resolve(batchAnswer(req))));

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
// Let the next held batch answer, and wait for it to land.
const release = async () => { held.shift()(); await settle(); };
// A promise, or a note that it didn't settle in time.
const within = (promise, ms = 2000) => Promise.race([promise.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

const ids = () => taggedFiltered().map((i) => i.id);
const isPrefix = (a, b) => a.length <= b.length && a.every((id, i) => id === b[i]);

// Boot as app.js does it, from the first answer: its cards, its sort, then
// the rest of the board.
function boot(sort) {
  const first = sortedAnswer(sort);
  state.items = first.items.map(toItem);
  state.sort = sort;
  return loadRest(first.keys);
}

beforeEach(() => {
  answer = () => new Promise(() => {}); // a loop left from the last test waits for good
  requests.length = 0;
  held = [];
  gone.clear();
  localStorage.clear();
  Object.assign(state, {
    boardId: "b1", boardMapping: null, facets: [], items: [], unloaded: [], sort: null,
    selected: new Map(), showFavorites: false, showUntagged: false, showProcessing: false, showUnprocessed: false,
    selectedCrateId: null, searchResults: null, alertEvent: null, crates: [], showClusters: 0, showMeaningClusters: 0,
    searchQuery: "", searchDraft: "", searchLoading: false, searchSimilarTo: null,
  });
});

test("the load asks for the cards the first page left out, in the page's order, 500 at a time", async () => {
  answer = (req) => batchAnswer(req);
  await boot(NAME);
  const order = orderOf(NAME);
  assert.deepEqual(requests.filter(isBatch).map((r) => r.body.ids), [order.slice(3, 503), order.slice(503, 1003), order.slice(1003)]);
  assert.deepEqual(ids(), order);
  assert.deepEqual(state.unloaded, []);
  checkCached();
});

test("the list is drawn only up to the first card not loaded: a card the poll brings early waits for its batch", async () => {
  answer = holdBatch;
  const order = orderOf(NAME);
  let over = false;
  boot(NAME).then(() => { over = true; });
  const seen = [ids()];
  assert.deepEqual(seen[0], order.slice(0, 3), "the first page, drawn at once");

  // Someone hearts a card near the end of the order: the poll brings it now.
  const deep = order[1100];
  reconcile([{ ...board.get(deep), hearts: 9 }], new Set(board.keys()));
  assert.ok(state.items.some((i) => i.id === deep), "setup: it has loaded");
  seen.push(ids());
  checkCached();

  while (!over) {
    await release();
    seen.push(ids());
    checkCached();
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(isPrefix(seen[i - 1], seen[i]), `step ${i}: cards only ever added at the end`);
  }
  assert.deepEqual(seen.at(-1), order);
});

test("a card deleted after the keys were taken doesn't hold the load up", async () => {
  answer = (req) => new Promise((r) => setTimeout(() => r(batchAnswer(req)), 0));
  const order = orderOf(null);
  const first = sortedAnswer(null);
  gone.add(order[600]);
  state.items = first.items.map(toItem);
  assert.equal(await within(loadRest(first.keys)), true, "the load finishes");
  assert.deepEqual(ids(), order.filter((id) => id !== order[600]));
});

test("a sort change during the load keeps the old order until its first page lands; of two quick ones, the later wins", async () => {
  const heartsHeld = [];
  answer = (req) => {
    if (!isSorted(req)) return holdBatch(req);
    const a = sortedAnswer(sortOfUrl(req.url));
    return sortOfUrl(req.url).by === "hearts" ? new Promise((r) => heartsHeld.push(() => r(a))) : a;
  };
  let over = false;
  boot(NAME).then(() => { over = true; });
  const before = ids();

  const toHearts = setSort(HEARTS);
  await settle();
  assert.equal(state.sort, NAME, "Hearts' answer is out: the old sort stays");
  assert.deepEqual(ids(), before, "…and so does its order");
  checkCached();

  assert.equal(await setSort(OLDEST), true);
  assert.equal(state.sort, OLDEST);
  const oldest = orderOf(OLDEST);
  assert.deepEqual(ids(), oldest.slice(0, 3), "the new first page, in its order, and nothing past it");
  checkCached();

  heartsHeld.shift()();
  assert.equal(await toHearts, false, "Hearts' answer landed last, and does nothing");
  assert.equal(state.sort, OLDEST);
  assert.equal(JSON.parse(localStorage.getItem("boardSort:b1")).by, "created", "the later pick is the one saved");

  // The rest loads in the new order: the old loop's batch is let go and
  // dropped, and every batch asked for after the swap runs oldest first, each
  // card asked for once.
  const swapped = requests.filter(isBatch).length - 1;
  while (!over) await release();
  const after = requests.filter(isBatch).slice(swapped);
  for (const r of after) assert.deepEqual(r.body.ids, [...r.body.ids].sort((a, b) => a - b), "oldest first: ids ascending");
  const asked = after.flatMap((r) => r.body.ids);
  assert.equal(new Set(asked).size, asked.length, "no card asked for twice: the old loop stopped");
  assert.deepEqual(ids(), oldest);
  checkCached();
});

test("flipping the direction during the load never empties the list", async () => {
  const flipHeld = [];
  answer = (req) => (isSorted(req) ? new Promise((r) => flipHeld.push(() => r(sortedAnswer(sortOfUrl(req.url))))) : holdBatch(req));
  boot(OLDEST);
  const before = ids();
  assert.equal(before.length, 3, "setup: the first page shows");

  const flipped = setSort({ ...OLDEST, dir: "desc" });
  await settle();
  assert.deepEqual(ids(), before, "until the new first page lands, the old order stays");
  flipHeld.shift()();
  assert.equal(await flipped, true);
  assert.deepEqual(ids(), orderOf(null).slice(0, 3), "then the newest three");
  checkCached();
});

test("a sort change that fails during the load keeps the old sort, says so, and the load goes on", async () => {
  answer = (req) => (isSorted(req) ? null : holdBatch(req));
  let over = false;
  const loaded = boot(NAME).then(() => { over = true; });
  assert.equal(await setSort(HEARTS), false);
  assert.equal(state.sort, NAME);
  assert.ok([...document.querySelectorAll(".toast-msg")].some((m) => m.textContent === "Couldn't change the sort"));
  answer = (req) => batchAnswer(req);
  while (held.length) held.shift()();
  assert.equal(await within(loaded), true, "the load finishes");
  assert.ok(over);
  assert.deepEqual(ids(), orderOf(NAME));
});

test("a mapping save during the load settles the sort through the same door: the new sort waits for its own keys", async () => {
  const sortedHeld = [];
  answer = (req) => (isSorted(req) ? new Promise((r) => sortedHeld.push(() => r(sortedAnswer(sortOfUrl(req.url))))) : holdBatch(req));
  const duration = { by: "media:duration", dir: "desc", label: "Duration" };
  localStorage.setItem("boardSort:b1", JSON.stringify(duration));
  boot(duration);

  // The board turns into one card per extracted value, where a file's
  // duration isn't a sort: back to newest first, with its own keys.
  state.boardMapping = { card: { by: "who" }, fields: [{ key: "who", kind: "text", source: "extract" }] };
  const settled = restoreSort();
  await settle();
  const asked = requests.filter(isSorted);
  assert.equal(asked.length, 1, "it asked for the new sort's first page");
  assert.deepEqual(sortOfUrl(asked[0].url), { by: "created", dir: "desc" }, "newest first, asked for by name");
  assert.equal(state.sort, duration, "the old sort stays until it lands");
  sortedHeld.shift()();
  await settled;
  assert.equal(state.sort, null);
  assert.deepEqual(ids(), orderOf(null).slice(0, 3));
  checkCached();
});

// A search while the board loads (Stage 3): its results that haven't loaded
// are fetched before any of them show, so none pops in later by score.
test("Find similar by meaning while the board loads: every result is in before the results show, and only the missing ones are asked for", async () => {
  const order = orderOf(null);
  // The anchor first, then cards the first page holds and cards it doesn't.
  const results = [order[0], order[900], order[2], order[1200], order[600]];
  const cardsHeld = [];
  answer = (req) => {
    if (req.url.startsWith("/api/search/similar")) return ranked(results);
    if (isFor(results)(req)) return new Promise((r) => cardsHeld.push(() => r(batchAnswer(req))));
    return holdBatch(req);
  };
  boot(null);
  const shown = runSimilarMeaning(state.items.find((i) => i.id === order[0]));
  await settle();
  assert.equal(cardsHeld.length, 1, "the missing cards were asked for");
  assert.deepEqual(requests.filter(isFor(results)).map((r) => r.body.ids), [[order[900], order[1200], order[600]]], "only the ones not loaded");
  assert.equal(state.searchResults, null, "nothing shows while they're out");
  cardsHeld.shift()();
  await shown;
  assert.deepEqual(ids(), results, "then every result at once, best first");
  checkCached();
});

test("of two quick searches, the later one stays, even when the earlier one's cards land last", async () => {
  const order = orderOf(null);
  const first = [order[800], order[1]]; // one the load hasn't reached
  const second = [order[2], order[0]]; // both on the first page
  const cardsHeld = [];
  answer = (req) => {
    if (req.url.startsWith("/api/search?")) return ranked(new URL(req.url, "http://localhost").searchParams.get("q") === "red" ? first : second);
    if (isFor(first)(req)) return new Promise((r) => cardsHeld.push(() => r(batchAnswer(req))));
    return holdBatch(req);
  };
  boot(null);
  const one = runSearch("red");
  await settle();
  assert.equal(cardsHeld.length, 1, "setup: the first search's cards are out");
  await runSearch("blue");
  assert.equal(state.searchQuery, "blue");
  assert.deepEqual(ids(), second);

  cardsHeld.shift()();
  await one;
  assert.equal(state.searchQuery, "blue", "the first search's late cards changed nothing");
  assert.deepEqual(ids(), second);
  assert.equal(state.searchLoading, false);
  checkCached();
});

// Stage 4 (the second pass).

test("the order already in effect, picked again mid-load, takes effect at once: no request, and the load goes on", async () => {
  answer = (req) => (isSorted(req) ? sortedAnswer(sortOfUrl(req.url)) : holdBatch(req));
  let over = false;
  boot(null).then(() => { over = true; });
  // The menu's Date added, with no sort chosen: newest first, by name.
  const newest = { by: "created", dir: "desc", label: "Date added" };
  assert.equal(await setSort(newest), true);
  assert.equal(state.sort, newest);
  assert.equal(requests.filter(isSorted).length, 0, "no request for the order in hand");
  while (!over) await release();
  assert.deepEqual(ids(), orderOf(null), "the load went on to the end");
  checkCached();
});

// Last in the file: it leaves the poll armed, on timers it then throws away.
test("a card joining the board re-arms the poll, whatever brought it: one in flight, fetched for a link, is followed", async () => {
  const fresh = { id: 9001, name: "f9001.png", display_name: "fresh", status: "pending", tags: [], created_at: 90000, updated_at: 90000, hearts: 0 };
  board.set(fresh.id, fresh);
  answer = (req) => (isBatch(req) ? batchAnswer(req) : null);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(await fetchItems([fresh.id]), true);
    mock.timers.tick(4000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.ok(requests.some((r) => r.url.startsWith("/api/items?board=b1")), "the poll ran for it");
  } finally {
    mock.timers.reset();
    board.delete(fresh.id);
  }
});
