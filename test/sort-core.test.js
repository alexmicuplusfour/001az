// The board's one sort order (public/sort-core.js,
// planning/sorted-loading-plan.md D4). Pure module, plain import, no browser
// stub: loading it here, bare, is also the proof the server can import it
// (Stage 1, proof 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sortValue, compareItems, newestFirst, labelOf, connectorDefault, settleSort, defaultDir, NEWEST, adoptSort, keyOf, compareKeys,
} from "../public/sort-core.js";

// Only what the order reads. Dated in id order unless a test says otherwise.
const card = (id, over = {}) => ({
  id, displayLabel: `e${id}`, created_at: id * 100, updated_at: id * 100, hearts: 0,
  fields: {}, media: null, instances: [{ kind: "image" }], ...over,
});
const order = (cards, sort) => [...cards].sort(compareItems(sort)).map((c) => c.id);

// The same cards in 50 starting orders, from a seeded shuffle so a failure
// replays: an order that depends on how the cards arrived shows up as two
// different answers.
function* shuffles(cards, n = 50) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const a = [...cards];
    for (let j = a.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [a[j], a[k]] = [a[k], a[j]];
    }
    yield a;
  }
}

test("sortValue: namespaced keys read the right slot", () => {
  const it = card(1, {
    hearts: 7,
    media: { duration: 61.5 },
    fields: { price: { v: 42000, src: "coingecko" } },
    instances: [{ kind: "pdf" }, { kind: "pdf" }],
  });
  assert.equal(sortValue(it, "hearts"), 7);
  assert.equal(sortValue(it, "media:duration"), 61.5);
  assert.equal(sortValue(it, "field:price"), 42000);
  assert.equal(sortValue(it, "instances"), 2);
  assert.equal(sortValue(it, "media:pages"), null, "missing media fn is null");
  assert.equal(sortValue(it, "field:nope"), null);
});

test("numbers by value; empty values last in both directions, newest first among them", () => {
  const cards = [
    card(1, { media: { duration: 5 } }),
    card(2, { media: null }), // a doc on a mixed board: no duration
    card(3, { media: { duration: 30 } }),
    card(4, { media: { duration: null } }),
  ];
  assert.deepEqual(order(cards, { by: "media:duration", dir: "desc" }), [3, 1, 4, 2]);
  assert.deepEqual(order(cards, { by: "media:duration", dir: "asc" }), [1, 3, 4, 2]);
});

test("text by the viewer's language; ISO dates as text are chronological", () => {
  const cards = [
    card(1, { displayLabel: "beta", media: { modified: "2026-03-01" } }),
    card(2, { displayLabel: "Alpha", media: { modified: "2025-12-31" } }),
  ];
  assert.deepEqual(order(cards, { by: "name", dir: "asc" }), [2, 1]);
  assert.deepEqual(order(cards, { by: "media:modified", dir: "desc" }), [1, 2]);
});

test("a field mixing numbers and text sorts the same way from any starting order, numbers first", () => {
  // A plugin's provider can send "N/A" or "10" where another sends 10.
  const v = [10, 9, "9a", "10", 2, "N/A", null, 2];
  const cards = v.map((x, i) => card(i + 1, { fields: { x: { v: x } } }));
  const want = {
    desc: [1, 2, 8, 5, 6, 3, 4, 7], // 10, 9, 2, 2 (newest first) | "N/A", "9a", "10" | empty
    asc: [8, 5, 2, 1, 4, 3, 6, 7], // 2, 2, 9, 10 | "10", "9a", "N/A" | empty
  };
  for (const dir of ["desc", "asc"]) {
    for (const start of shuffles(cards)) {
      assert.deepEqual(order(start, { by: "field:x", dir }), want[dir], dir);
    }
  }
});

test("a card with no date added counts as newest, sorted by date or tied on another key", () => {
  const cards = [card(1), card(2, { created_at: null }), card(3)];
  assert.deepEqual(order(cards, { by: "created", dir: "desc" }), [2, 3, 1]);
  assert.deepEqual(order(cards, { by: "created", dir: "asc" }), [1, 3, 2]);
  assert.deepEqual(order(cards, { by: "hearts", dir: "desc" }), [2, 3, 1], "all tied on hearts");
});

test("ties go newest first, then by id, whatever order the cards arrive in", () => {
  // 2 and 3 share a date (one upload request stamps its files alike).
  const cards = [card(1, { created_at: 100 }), card(2, { created_at: 300 }), card(3, { created_at: 300 }), card(4, { created_at: 200 })];
  for (const start of shuffles(cards)) {
    assert.deepEqual(order(start, { by: "hearts", dir: "desc" }), [3, 2, 4, 1]);
    assert.deepEqual([...start].sort(newestFirst).map((c) => c.id), [3, 2, 4, 1]);
  }
});

// ─── which sort a board opens on (Stage 2a) ─────────────────────────────────

test("defaultDir: text ascends, everything else descends", () => {
  assert.equal(defaultDir("text"), "asc");
  assert.equal(defaultDir("number"), "desc");
  assert.equal(defaultDir("date"), "desc");
});

test("the Name rule: the AI's casing, else a derived identity, else the original filename, else the stored one", () => {
  const row = { name: "a1b2.webp", identity: "a1b2.webp", label: "Beach.PNG" };
  assert.equal(labelOf({ ...row, display_name: "Maya Chen", identity: "maya chen" }), "Maya Chen");
  assert.equal(labelOf({ ...row, identity: "maya chen" }), "maya chen", "a derived identity");
  assert.equal(labelOf(row), "Beach.PNG", "an upload: its original filename");
  assert.equal(labelOf({ ...row, label: null }), "a1b2.webp", "no original name: the stored one");
});

// A stocks-shaped manifest: it names its fields (fn), and opens on market cap.
const STOCKS = [{
  name: "stocks",
  fields: [{ fn: "market_cap", label: "Market cap (USD)" }, { fn: "sector", label: "Sector" }],
  browse: { defaultSort: "market_cap" },
}];
const stockBoard = (fields) => ({ input: { connector: "stocks" }, fields });
const bound = (key, fn, kind = "number") => ({ key, fn, kind, source: "connector" });

test("the connector default finds its field by the manifest's name and sorts by the board's key for it", () => {
  assert.deepEqual(
    connectorDefault(stockBoard([bound("cap", "market_cap")]), STOCKS),
    { by: "field:cap", dir: "desc", label: "Market cap (USD)" },
    "a renamed key",
  );
  assert.equal(connectorDefault(stockBoard([bound("sector", "sector", "text")]), STOCKS), null, "the board doesn't bind it");
  assert.equal(connectorDefault({ fields: [bound("market_cap", "market_cap")] }, STOCKS), null, "not a connector board");
  assert.equal(connectorDefault(stockBoard([bound("market_cap", "market_cap")]), []), null, "no manifest");
});

test("settling: the viewer's pick if it fits, as asked with no label; else the connector's default; else newest first", () => {
  const board = stockBoard([bound("market_cap", "market_cap"), bound("sector", "sector", "text")]);
  assert.deepEqual(settleSort({ by: "field:sector", dir: "asc", label: "Sector" }, board, STOCKS), { by: "field:sector", dir: "asc" });
  const market = { by: "field:market_cap", dir: "desc", label: "Market cap (USD)" };
  assert.deepEqual(settleSort({ by: "field:gone", dir: "asc" }, board, STOCKS), market, "a field the mapping dropped");
  assert.deepEqual(settleSort({ by: "name", dir: "sideways" }, board, STOCKS), market, "a direction that isn't one");
  assert.deepEqual(settleSort(null, board, STOCKS), market, "no pick");
  assert.deepEqual(settleSort({ by: "media:width", dir: "desc" }, board, STOCKS), market, "a file field on a connector board isn't a fit");
  assert.equal(settleSort(null, null, STOCKS), null, "a file board with no pick: newest first");
  assert.deepEqual(settleSort({ by: "media:width", dir: "desc" }, null, STOCKS), { by: "media:width", dir: "desc" });
});

test("adopting a settled sort: the pick as asked, with its label, when it was kept; else what was settled", () => {
  const pick = { by: "field:sector", dir: "asc", label: "Sector" };
  const market = { by: "field:market_cap", dir: "desc", label: "Market cap (USD)" };
  assert.equal(adoptSort(pick, { by: "field:sector", dir: "asc" }), pick, "kept: the page's own, label and all");
  assert.equal(adoptSort(pick, market), market, "dropped for the connector's default, named by its manifest");
  assert.equal(adoptSort(pick, null), null, "dropped for newest first");
  assert.equal(adoptSort(null, market), market, "no pick: the default");
  assert.equal(adoptSort(null, null), null);
  // Newest first asked for by name, so no connector default can take its place.
  assert.equal(adoptSort(null, { by: "created", dir: "desc" }), null, "newest first stays no sort chosen");
  assert.deepEqual(NEWEST, { by: "created", label: "Date added", kind: "date", dir: "desc" });
});

// ─── keys: a card's place in a sort (Stage 2b) ──────────────────────────────

test("a card compares as its key does, in every kind of sort, from any starting order", () => {
  // The page cuts its list at the first card not loaded by comparing a loaded
  // card's key with it; the list itself is sorted by compareItems. The two
  // have to agree, or the cut would fall in the middle of a run.
  const cards = [
    card(1, { displayLabel: "beta", hearts: 2, media: { duration: 5 }, fields: { x: { v: 10 } } }),
    card(2, { displayLabel: "Alpha", media: null, fields: { x: { v: "N/A" } }, instances: [{}, {}] }),
    card(3, { displayLabel: "gamma", hearts: 2, media: { duration: 30 }, created_at: 200 }),
    card(4, { displayLabel: "Åsa", updated_at: 50, media: { duration: null } }),
    card(5, { displayLabel: "", hearts: 1, fields: { x: { v: 2 } }, created_at: 200 }),
  ];
  const sorts = ["name", "created", "updated", "hearts", "instances", "media:duration", "field:x"]
    .flatMap((by) => [{ by, dir: "asc" }, { by, dir: "desc" }]);
  for (const sort of [NEWEST, ...sorts]) {
    for (const start of shuffles(cards, 10)) {
      const byKeys = start.map((c) => keyOf(c, sort)).sort(compareKeys(sort)).map((k) => k.id);
      assert.deepEqual(byKeys, order(start, sort), `${sort.by} ${sort.dir}`);
    }
  }
});
