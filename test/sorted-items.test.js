// GET /api/items/sorted and POST /api/items/batch
// (planning/sorted-loading-plan.md, Stage 2a): a board's first page in the
// viewer's sort, every entity's sort key, and whole items by id. Small
// hand-built boards with the expected order written out: the server sorts
// with sort-core.js, so checking it against sort-core.js would prove nothing
// about the order.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard, seedUser, adminSession, req } from "./helpers.js";
import { createEntity, insertItem, deleteEntity, listItemsSorted } from "../server/db.js";
import { toItem } from "../public/utils.js";
import { sortValue } from "../public/sort-core.js";

let srv, db, admin, fans, raw, keyed, stocks, stocksNoCap;
const at = {}; // card name -> entity id

// A card on a raw board (one per file), every sort value set by hand. Its
// Name is the file's original name, as for an upload.
async function fileCard(boardId, name, { created, updated, size = null, modified = null, hearts = 0, status = "tagged" }) {
  const stored = `f-${name}.png`;
  const id = await createEntity(db, boardId, { identity: stored });
  await insertItem(db, boardId, {
    identity: stored,
    files: [{ name: stored, original_name: name, kind: "image", size, modifiedAt: modified, w: 10, h: 10 }],
    fields: {},
  }, status, id);
  // Hearts go straight in: toggleFavorite stamps updated_at, and that's set below.
  for (const fan of fans.slice(0, hearts)) {
    await db.query("INSERT INTO favorites (user_id, item_id, created_at) VALUES ($1, $2, 1)", [fan.id, id]);
  }
  await db.query("UPDATE entities SET created_at=$1, updated_at=$2 WHERE id=$3", [created, updated, id]);
  at[name] = id;
  return id;
}

// A connector card: no file, its fields as the connector lands them.
async function stockCard(boardId, symbol, created, fields) {
  const id = await createEntity(db, boardId, { identity: symbol });
  await insertItem(db, boardId, { identity: symbol, files: [], fields: {} }, "tagged", id);
  await db.query("UPDATE entities SET created_at=$1, fields=$2 WHERE id=$3", [created, JSON.stringify(fields), id]);
  at[`${boardId}:${symbol}`] = id;
  return id;
}

const day = (iso) => Date.parse(`${iso}T12:00:00Z`);

before(async () => {
  srv = await startServer();
  ({ db } = srv);
  admin = await adminSession(db);
  fans = [await seedUser(db, "fan1@test.local"), await seedUser(db, "fan2@test.local")];

  raw = await seedBoard(db, "sorted raw");
  await fileCard(raw, "Zebra", { created: 100, updated: 600, size: 500, modified: day("2026-01-05") });
  await fileCard(raw, "apple", { created: 200, updated: 500, size: 100, modified: day("2025-06-01"), hearts: 2 });
  await fileCard(raw, "Mango", { created: 300, updated: 400, size: 300, hearts: 1 });
  await fileCard(raw, "Åsa", { created: 400, updated: 300, modified: day("2024-12-31"), hearts: 1 });
  await fileCard(raw, "Aerger", { created: 500, updated: 200, size: 200, modified: day("2026-03-01") });
  await fileCard(raw, "kiwi", { created: 600, updated: 100, size: 400, modified: day("2025-06-01"), hearts: 2 });

  // A card-key board: one card per value, several files each.
  keyed = await seedBoard(db, "sorted keyed");
  await db.query("UPDATE boards SET mapping=$1 WHERE id=$2", [
    { card: { by: "who" }, fields: [{ key: "who", kind: "text", source: "extract" }] }, keyed,
  ]);
  for (const [who, files, created] of [["one", 1, 10], ["three", 3, 20], ["two", 2, 30]]) {
    const id = await createEntity(db, keyed, { identity: who });
    for (let i = 0; i < files; i++) {
      await insertItem(db, keyed, { identity: who, files: [{ name: `${who}${i}.png`, original_name: `${who}${i}.png`, kind: "image", w: 10, h: 10 }], fields: {} }, "tagged", id);
    }
    await db.query("UPDATE entities SET created_at=$1 WHERE id=$2", [created, id]);
    at[who] = id;
  }

  // Stock boards: the manifest opens them by market cap, when it's bound.
  const field = (key, kind) => ({ key, fn: key, kind, source: "connector" });
  stocks = await seedBoard(db, "sorted stocks");
  await db.query("UPDATE boards SET mapping=$1 WHERE id=$2", [
    { input: { connector: "stocks" }, fields: [field("market_cap", "number"), field("sector", "text")] }, stocks,
  ]);
  await stockCard(stocks, "aapl", 10, { market_cap: { v: 3000 }, sector: { v: "Technology" } });
  await stockCard(stocks, "xom", 20, { market_cap: { v: 400 }, sector: { v: "Energy" } });
  await stockCard(stocks, "jpm", 30, { market_cap: { v: 500 }, sector: { v: "Financials" } });
  await stockCard(stocks, "nee", 40, { sector: { v: "Utilities" } });

  stocksNoCap = await seedBoard(db, "sorted stocks, no market cap");
  await db.query("UPDATE boards SET mapping=$1 WHERE id=$2", [
    { input: { connector: "stocks" }, fields: [field("sector", "text")] }, stocksNoCap,
  ]);
  await stockCard(stocksNoCap, "aapl", 10, { sector: { v: "Technology" } });
  await stockCard(stocksNoCap, "xom", 20, { sector: { v: "Energy" } });
});
after(() => srv.close());

const sorted = (board, query = "", sid = admin.sid) => req(srv.base, "GET", `/api/items/sorted?board=${board}${query}`, { sid });
const firstIds = (r) => r.json.items.map((i) => i.id);
const ids = (...names) => names.map((n) => at[n]);
const stock = (board, ...symbols) => symbols.map((s) => at[`${board}:${s}`]);

test("each kind of sort answers its own first page, and says which sort it applied", async () => {
  const cases = [
    [raw, "", ids("kiwi", "Aerger", "Åsa"), null, "newest first, with no pick"],
    [raw, "&by=created&dir=asc", ids("Zebra", "apple", "Mango"), { by: "created", dir: "asc" }, "date added, oldest first"],
    [raw, "&by=updated&dir=desc", ids("Zebra", "apple", "Mango"), { by: "updated", dir: "desc" }, "date updated"],
    [raw, "&by=hearts&dir=desc", ids("kiwi", "apple", "Åsa"), { by: "hearts", dir: "desc" }, "hearts, a tie newest first"],
    [raw, "&by=media:file_size&dir=desc", ids("Zebra", "kiwi", "Mango"), { by: "media:file_size", dir: "desc" }, "a file number"],
    [raw, "&by=media:modified&dir=asc", ids("Åsa", "kiwi", "apple"), { by: "media:modified", dir: "asc" }, "a file date, a tie newest first"],
    [raw, "&by=name&dir=asc&locale=en", ids("Aerger", "apple", "Åsa"), { by: "name", dir: "asc" }, "Name"],
    [keyed, "&by=instances&dir=desc", ids("three", "two", "one"), { by: "instances", dir: "desc" }, "files per card"],
    [stocks, "&by=field:market_cap&dir=desc", stock(stocks, "aapl", "jpm", "xom"), { by: "field:market_cap", dir: "desc" }, "a connector number, the empty one last"],
    [stocks, "&by=field:sector&dir=asc", stock(stocks, "xom", "jpm", "aapl"), { by: "field:sector", dir: "asc" }, "a connector text"],
  ];
  for (const [board, query, want, sort, what] of cases) {
    const r = await sorted(board, `${query}&limit=3`);
    assert.equal(r.status, 200, what);
    assert.deepEqual(firstIds(r), want, what);
    assert.deepEqual(r.json.sort, sort, `${what}: the sort applied, no label on the viewer's own pick`);
    assert.equal(typeof r.json.now, "number", what);
    assert.ok(r.json.work, what);
  }
});

test("every entity has one key, and its value is what the page makes of the item", async () => {
  const sorts = [
    [raw, null], [raw, "created:asc"], [raw, "updated:desc"], [raw, "hearts:desc"], [raw, "media:file_size:desc"],
    [raw, "media:modified:asc"], [raw, "name:asc"], [keyed, "instances:desc"], [stocks, "field:market_cap:desc"], [stocks, "field:sector:asc"],
  ];
  for (const [board, pick] of sorts) {
    const cut = pick?.lastIndexOf(":");
    const by = pick ? pick.slice(0, cut) : null;
    const query = pick ? `&by=${by}&dir=${pick.slice(cut + 1)}&limit=2` : "&limit=2";
    const { json } = await sorted(board, query);
    // The page's own view of each item: the whole board through toItem.
    const whole = (await req(srv.base, "GET", `/api/items?board=${board}`, { sid: admin.sid })).json.map(toItem);
    assert.deepEqual(json.keys.map((k) => k[0]).sort((a, b) => a - b), whole.map((i) => i.id).sort((a, b) => a - b), `${pick}: one key per entity`);
    for (const item of whole) {
      const key = json.keys.find((k) => k[0] === item.id);
      assert.equal(key[1], item.created_at, `${pick}: #${item.id}'s date added`);
      if (by) assert.deepEqual(key[2], sortValue(item, by), `${pick}: #${item.id}'s value`);
      else assert.equal(key.length, 2, "newest first: the date is the value");
    }
  }
});

test("Name follows the viewer's language: Swedish puts Å after Z, English beside A", async () => {
  const names = async (locale) =>
    (await sorted(raw, `&by=name&dir=asc&locale=${locale}&limit=6`)).json.items.map((i) => toItem(i).displayLabel);
  assert.deepEqual(await names("en"), ["Aerger", "apple", "Åsa", "kiwi", "Mango", "Zebra"]);
  assert.deepEqual(await names("sv"), ["Aerger", "apple", "kiwi", "Mango", "Zebra", "Åsa"]);
});

test("settling: a pick the board can't use falls back to the connector's default, then to newest first", async () => {
  const market = { by: "field:market_cap", dir: "desc", label: "Market cap (USD)" };
  const dropped = await sorted(stocks, "&by=field:gone&dir=asc&limit=3");
  assert.deepEqual(dropped.json.sort, market, "a field the mapping dropped: the manifest's default, with its label");
  assert.deepEqual(firstIds(dropped), stock(stocks, "aapl", "jpm", "xom"));
  assert.deepEqual((await sorted(stocks, "&limit=3")).json.sort, market, "no pick: the default too");

  const unbound = await sorted(stocksNoCap, "&limit=3");
  assert.equal(unbound.json.sort, null, "the board doesn't bind market cap: newest first");
  assert.deepEqual(firstIds(unbound), stock(stocksNoCap, "xom", "aapl"));

  assert.equal((await sorted(raw, "&by=field:market_cap&dir=desc")).json.sort, null, "a field sort on a file board: newest first");
  const garbled = await sorted(raw, "&by=name&dir=asc&locale=!!&limit=3");
  assert.equal(garbled.status, 200, "a garbled language tag still answers");
  assert.deepEqual(firstIds(garbled), ids("Aerger", "apple", "Åsa"));
});

test("a board the viewer can't see answers 404", async () => {
  const stranger = await seedUser(db, "stranger-sorted@test.local");
  assert.equal((await sorted(raw, "", stranger.sid)).status, 404);
  assert.equal((await req(srv.base, "POST", "/api/items/batch", { sid: stranger.sid, body: { board: raw, ids: [at.kiwi] } })).status, 404);
});

test("batch: whole items for the ids on that board, and nothing else", async () => {
  const batch = (body) => req(srv.base, "POST", "/api/items/batch", { sid: admin.sid, body });
  const got = await batch({ board: raw, ids: [at.kiwi, at.apple, at.three] });
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.items.map((i) => i.id).sort((a, b) => a - b), [at.kiwi, at.apple].sort((a, b) => a - b), "another board's card stays out");
  assert.equal(toItem(got.json.items.find((i) => i.id === at.kiwi)).displayLabel, "kiwi", "a whole item, as the listing builds it");

  const gone = await fileCard(raw, "gone", { created: 50, updated: 50 });
  await deleteEntity(db, gone);
  assert.deepEqual((await batch({ board: raw, ids: [gone, at.Zebra] })).json.items.map((i) => i.id), [at.Zebra], "a deleted card is left out");

  assert.deepEqual((await batch({ board: raw, ids: [] })).json, { items: [] });
  const many = Array.from({ length: 501 }, (_, i) => i + 1);
  assert.equal((await batch({ board: raw, ids: many })).status, 400, "more than 500");
  assert.equal((await batch({ board: raw, ids: many.slice(0, 500) })).status, 200, "500 is fine");
  for (const bad of [[String(at.kiwi)], [1.5], [0], [-3], "1,2", undefined]) {
    assert.equal((await batch({ board: raw, ids: bad })).status, 400, `ids ${JSON.stringify(bad)}`);
  }
});

// Stage 4 (the second pass).

test("an explicit Date added, newest first answers as no pick does, from the created_at index", async () => {
  const [picked, none] = [await sorted(raw, "&by=created&dir=desc&limit=3"), await sorted(raw, "&limit=3")];
  assert.deepEqual(picked.json.sort, { by: "created", dir: "desc" }, "the pick, as asked");
  assert.deepEqual(firstIds(picked), firstIds(none));
  assert.deepEqual(picked.json.keys, none.json.keys, "the same keys, the date being the value");
});

test("newest first: the first page is the start of the keys, even when a card lands between the two reads", async () => {
  const board = await seedBoard(db, "sorted race");
  for (let i = 1; i <= 4; i++) await fileCard(board, `race${i}`, { created: i * 10, updated: i * 10 });
  // A card lands just as the keys are read, the way an upload on a busy board can.
  let landed = false;
  const racing = {
    query: async (sql, params) => {
      if (!landed && typeof sql === "string" && sql.startsWith("SELECT id, created_at FROM entities")) {
        landed = true;
        await fileCard(board, "race-late", { created: 1000, updated: 1000 });
      }
      return db.query(sql, params);
    },
  };
  const { items, keys } = await listItemsSorted(racing, admin.id, board, { limit: 3 });
  assert.equal(landed, true, "setup: the card landed");
  assert.deepEqual(items.map((i) => i.id), keys.slice(0, 3).map((k) => k[0]), "the page is the head of the keys");
});

test("every card in flight comes with the first page, whatever the sort: the page's progress lane is whole from the first draw", async () => {
  const busy = await seedBoard(db, "sorted busy");
  for (const [name, created, status] of [["Aa", 1, "pending"], ["Bb", 2, "tagged"], ["Cc", 3, "tagged"], ["Dd", 4, "tagged"], ["Ee", 5, "processing"], ["Ff", 6, "tagged"]]) {
    await fileCard(busy, name, { created, updated: created, status });
  }
  // Newest first reaches Ff and Ee in its first two, by Name Aa and Bb: each
  // leaves one of the two in flight to a later batch.
  for (const [query, first] of [["&limit=2", ids("Ff", "Ee")], ["&by=name&dir=asc&locale=en&limit=2", ids("Aa", "Bb")]]) {
    const got = firstIds(await sorted(busy, query));
    for (const id of [...first, ...ids("Aa", "Ee")]) assert.ok(got.includes(id), `${query}: #${id} in the first answer`);
    assert.equal(got.length, 3, `${query}: the first two, and the one in flight past them`);
  }
});
