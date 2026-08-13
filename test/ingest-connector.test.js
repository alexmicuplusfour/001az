// The connector-feed ingestion adapter (ingestion phase 2): descriptor
// derivation from a manifest's `browse` block, bounded paging enumeration
// (empty-page stop, NOT short-page — providers clamp pageSize internally),
// cross-page dedupe, admit-then-ledger healing via the entities unique
// constraint, and the sweep running a real crypto feed end-to-end over a
// mocked provider.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, req, installConnectors } from "./helpers.js";
import { registerConnector, unregisterConnector } from "../server/connectors/index.js";
import { getBoard, updateBoard, setIngestNextRun, deleteEntity } from "../server/db.js";
import { feedAdapter, _resetWindowCache, _ageWindowCache } from "../server/ingestion/connector.js";
import { resolveIngestAdapter } from "../server/ingestion/index.js";
import * as files from "../server/ingestion/files.js";
import { manifest as cryptoManifest } from "../server/connectors/crypto/index.js";
import { manifest as stocksManifest } from "../server/connectors/stocks/index.js";
import { startWorker } from "../server/worker.js";
import { createSources } from "../server/sources/index.js";

// ─── a stub bound connector (the connectors/index.js `bind` shape) ───────────

const BROWSE = {
  columns: [
    { key: "name", label: "Name", kind: "text", primary: true },
    { key: "price", label: "Price", kind: "usd" },
    { key: "change", label: "Δ", kind: "percent" },
    { key: "rank", label: "#", kind: "number" },
  ],
  sorts: [{ key: "rank", label: "Rank" }, { key: "price", label: "Price" }],
  defaultSort: "rank",
  pageSize: 50,
};

function stubConn({ pages = [], browse = BROWSE, providerCanList = true } = {}) {
  const listCalls = [];
  return {
    name: "widgets",
    manifest: { browse },
    listCalls,
    activeProvider: async () => ({ name: "acme", provider: providerCanList ? { list: () => {} } : {} }),
    list: async (_db, opts) => {
      listCalls.push(opts);
      return pages[opts.page - 1] || [];
    },
    fetchEntity: async (_db, id) => ({
      identity: id.toLowerCase(),
      display_name: id,
      symbol: id.toUpperCase(),
      source: { provider: "acme", id },
      fields: { price: { v: 1, kind: "number", src: "acme", at: 1 } },
    }),
  };
}

const row = (id, symbol, values = {}) => ({ id, symbol, label: id, values });

// ─── pure: descriptor + enumeration ──────────────────────────────────────────

test("descriptor derives from manifest.browse: display kinds → filter kinds, display kept", () => {
  const a = feedAdapter(stubConn());
  const d = a.descriptor();
  assert.deepEqual(d.source, []);
  assert.deepEqual(d.filters, [
    { fn: "name", kind: "text", label: "Name", display: "text" },
    { fn: "price", kind: "number", label: "Price", display: "usd" },
    { fn: "change", kind: "number", label: "Δ", display: "percent" },
    { fn: "rank", kind: "number", label: "#", display: "number" },
  ], "engine kind narrows usd/percent→number; display preserves the browse kind for formatting");
  assert.deepEqual(d.sorts, [{ by: "rank", label: "Rank" }, { by: "price", label: "Price" }]);
  assert.deepEqual(d.triggerModes, ["manual", "interval", "daily"]);
});

test("descriptor carries a column's preview flag; unflagged columns omit it", () => {
  const a = feedAdapter(stubConn({
    browse: {
      columns: [
        { key: "name",  label: "Name",  kind: "text", primary: true },
        { key: "price", label: "Price", kind: "usd", preview: true },
        { key: "rank",  label: "#",     kind: "number" },
      ],
      sorts: [{ key: "rank", label: "Rank" }],
      defaultSort: "rank",
      pageSize: 50,
    },
  }));
  const byFn = Object.fromEntries(a.descriptor().filters.map((f) => [f.fn, f]));
  assert.equal(byFn.price.preview, true, "a flagged column is marked for the preview list");
  assert.ok(!("preview" in byFn.rank), "an unflagged column omits the key so the catalog stays clean");
});

test("crypto/stocks descriptors flag volume for the preview (regression: volume was missing)", () => {
  for (const [name, manifest] of [["crypto", cryptoManifest], ["stocks", stocksManifest]]) {
    const d = feedAdapter({ name, manifest, activeProvider: async () => ({}) }).descriptor();
    const vol = d.filters.find((f) => f.fn === "volume");
    assert.equal(vol?.preview, true, `${name} preview includes volume`);
  }
});

test("a domain without a browse catalog can't feed", () => {
  assert.equal(feedAdapter(stubConn({ browse: null })), null);
});

test("enumerate: stops on an EMPTY page only, dedupes rank drift across pages", async () => {
  const conn = stubConn({
    pages: [
      // Short page (3 ≪ requested pageSize): providers clamp internally, so
      // this must NOT read as "dry" — page 2 still holds catalog rows.
      [row("alpha", "AAA"), row("beta", "BBB"), row("gamma", "CCC")],
      [row("beta-again", "BBB"), row("delta", "DDD")], // BBB drifted between pages
      [],
    ],
  });
  const a = feedAdapter(conn);
  const { candidates, truncated } = await a.enumerate(null, null, { sort: { by: "price", order: "asc" } });
  assert.deepEqual(candidates.map((c) => c.key), ["aaa", "bbb", "ccc", "ddd"], "page 2 reached; duplicate key dropped");
  assert.equal(truncated, false, "the catalog visibly ended (empty page) → not truncated");
  assert.deepEqual(conn.listCalls.map((c) => c.page), [1, 2, 3]);
  // The window is taken in the configured sort order — provider-side sort is
  // load-bearing for a bounded window.
  assert.equal(conn.listCalls[0].sort, "price");
  assert.equal(conn.listCalls[0].order, "asc");
});

test("enumerate: a window filled to the cap is truncated WITHOUT a probe page past it", async () => {
  // The catalog is exactly the cap (a full page then it would go on) — the
  // FMP self-capped-universe shape. Filling the cap must read "N+", and must
  // not cost the extra page the old `!truncated` loop guard fetched.
  const conn = stubConn({ pages: [[row("a", "A"), row("b", "B")], [row("c", "C")], []] });
  const { candidates, truncated } = await feedAdapter(conn).enumerate(null, null, {}, { limit: 3 });
  assert.equal(candidates.length, 3);
  assert.equal(truncated, true, "cap reached, catalog end unseen → truncated");
  assert.deepEqual(conn.listCalls.map((c) => c.page), [1, 2], "stopped as soon as the cap filled — no page 3 probe");
});

test("enumerate: no sort config falls back to the manifest's default sort", async () => {
  const conn = stubConn({ pages: [[row("a", "A")], []] });
  await feedAdapter(conn).enumerate(null, null, {});
  assert.equal(conn.listCalls[0].sort, "rank");
  assert.equal(conn.listCalls[0].order, "desc");
});

test("enumerate: the preview/window cap marks truncation", async () => {
  const conn = stubConn({ pages: [[row("a", "A"), row("b", "B"), row("c", "C")]] });
  const { candidates, truncated } = await feedAdapter(conn).enumerate(null, null, {}, { limit: 2 });
  assert.equal(candidates.length, 2);
  assert.equal(truncated, true);
});

test("enumerate: a feed reaches the WHOLE catalog — no app-side ration, only an operator's", async () => {
  // 1,250 rows across 5 pages of 250 — past every ration this adapter used to
  // apply by default (1000 for metered catalogs, 5000 declared for stocks).
  const pages = Array.from({ length: 5 }, (_, p) =>
    Array.from({ length: 250 }, (_, i) => row(`w${p * 250 + i}`, `W${p * 250 + i}`)));

  // No declaration, no env: the walk ends where the CATALOG ends, and the
  // empty sixth page proves it — "all of it", never "N+". A capped window
  // would clog (the ledger dedups downstream, so ingested rows keep filling
  // it and everything past the cap is permanently unreachable).
  const plain = feedAdapter(stubConn({ pages }));
  const d = await plain.enumerate(null, null, {});
  assert.equal(d.candidates.length, 1250);
  assert.equal(d.truncated, false);
  assert.equal(plain.windowCap(), 100000, "only an out-of-memory backstop, not a product ceiling");

  // A connector may still declare a window — it's a cost guard, not the norm.
  const guarded = feedAdapter(stubConn({ pages, browse: { ...BROWSE, feedWindow: 500 } }));
  const f = await guarded.enumerate(null, null, {});
  assert.equal(f.candidates.length, 500);
  assert.equal(f.truncated, true);

  // The env knob is the operator's own ration, and it overrides every
  // declaration at once.
  process.env.INGEST_FEED_CAP = "300";
  try {
    const forced = feedAdapter(stubConn({ pages, browse: { ...BROWSE, feedWindow: 5000 } }));
    const g = await forced.enumerate(null, null, {});
    assert.equal(g.candidates.length, 300);
    assert.equal(g.truncated, true);
    assert.equal(forced.windowCap(), 300);
  } finally {
    delete process.env.INGEST_FEED_CAP;
  }
});

test("enumerate: concurrent callers share ONE catalog walk (single-flight)", async () => {
  // The cache only helps callers arriving after a walk finishes. A preview
  // click landing while the sweep is mid-run is the common case, and without
  // single-flight both walk the whole catalog — ~74 metered requests apiece
  // against CoinGecko now that the window reaches all of it.
  let release;
  const gate = new Promise((r) => { release = r; });
  const listCalls = [];
  const conn = {
    name: "widgets",
    manifest: { browse: BROWSE },
    listCalls,
    activeProvider: async () => ({ name: "acme", provider: { list: () => {} } }),
    list: async (_db, opts) => {
      listCalls.push(opts);
      await gate;
      return opts.page === 1 ? [row("a", "A"), row("b", "B")] : [];
    },
  };
  const adapter = feedAdapter(conn);

  const p1 = adapter.enumerate(null, null, {});
  const p2 = adapter.enumerate(null, null, {});
  await new Promise((r) => setTimeout(r, 20)); // both have reached the flight
  assert.equal(listCalls.length, 1, "one walk in progress, not two");
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1.candidates.map((c) => c.key), ["a", "b"]);
  assert.deepEqual(r2.candidates.map((c) => c.key), ["a", "b"]);
  assert.equal(listCalls.filter((c) => c.page === 1).length, 1, "page 1 was fetched once for both");
});

test("enumerate: a failed walk releases the flight instead of wedging the key", async () => {
  let attempt = 0;
  const conn = {
    name: "widgets",
    manifest: { browse: BROWSE },
    activeProvider: async () => ({ name: "acme", provider: { list: () => {} } }),
    list: async (_db, opts) => {
      attempt++;
      if (attempt === 1) throw new Error("provider down");
      return opts.page === 1 ? [row("a", "A")] : [];
    },
  };
  const adapter = feedAdapter(conn);
  await assert.rejects(adapter.enumerate(null, null, {}), /provider down/);
  // The next caller retries rather than joining a dead flight.
  const { candidates } = await adapter.enumerate(null, null, {});
  assert.deepEqual(candidates.map((c) => c.key), ["a"]);
});

test("enumerate: the page backstop can't become the real ceiling", async () => {
  // MAX_PAGES exists for a provider that never returns an empty page. It is
  // derived from the safety cap, so it can never bind FIRST — a 40-page
  // backstop against a 100k-row cap would have quietly capped every feed at
  // 10,000 rows while claiming there was no limit.
  const conn = stubConn({
    pages: Array.from({ length: 60 }, (_, p) =>
      Array.from({ length: 250 }, (_, i) => row(`p${p}-${i}`, `P${p}-${i}`))),
  });
  const { candidates, truncated } = await feedAdapter(conn).enumerate(null, null, {});
  assert.equal(candidates.length, 15000, "60 full pages, none refused — the old 40-page backstop stopped at 10,000");
  assert.equal(truncated, false, "page 61 came back empty, so the catalog genuinely ended");
});

test("enumerate: a warm window is reused across calls; sort change or TTL expiry refetches", async () => {
  const prev = process.env.INGEST_FEED_CACHE_MS;
  process.env.INGEST_FEED_CACHE_MS = "60000"; // opt this test into caching
  try {
    const conn = stubConn({ pages: [[row("a", "A"), row("b", "B")], []] });
    const a = feedAdapter(conn);
    const first = await a.enumerate(null, null, { sort: { by: "rank", order: "desc" } });
    assert.equal(conn.listCalls.length, 2); // page 1 + the empty page
    // Same sort → cache hit, no new provider calls, same candidates.
    const second = await a.enumerate(null, null, { sort: { by: "rank", order: "desc" } });
    assert.equal(conn.listCalls.length, 2, "warm window served without re-paging");
    assert.deepEqual(second.candidates.map((c) => c.key), first.candidates.map((c) => c.key));
    // A filter-only edit reuses the window too (filters apply downstream) —
    // enumerate never sees filters, so this is the same key; still no refetch.
    await a.enumerate(null, null, { sort: { by: "rank", order: "desc" } });
    assert.equal(conn.listCalls.length, 2);
    // Different sort → different window → refetch.
    await a.enumerate(null, null, { sort: { by: "price", order: "asc" } });
    assert.ok(conn.listCalls.length > 2, "a new sort re-pages the provider");
    // TTL 0 disables the cache entirely.
    process.env.INGEST_FEED_CACHE_MS = "0";
    const before = conn.listCalls.length;
    await a.enumerate(null, null, { sort: { by: "rank", order: "desc" } });
    assert.ok(conn.listCalls.length > before, "TTL 0 always refetches");
    // Empty string (compose passes an unset ${VAR:-} through as "") means
    // DEFAULT, not 0 — else the container silently loses the cache.
    process.env.INGEST_FEED_CACHE_MS = "";
    const c2 = stubConn({ pages: [[row("z", "Z")], []] });
    const a2 = feedAdapter(c2);
    await a2.enumerate(null, null, { sort: { by: "rank", order: "desc" } });
    const warmed = c2.listCalls.length;
    await a2.enumerate(null, null, { sort: { by: "rank", order: "desc" } });
    assert.equal(c2.listCalls.length, warmed, "empty-string TTL caches at the 60s default");
  } finally {
    process.env.INGEST_FEED_CACHE_MS = prev;
  }
});

test("enumerate: an active provider without list() throws a readable error", async () => {
  const a = feedAdapter(stubConn({ providerCanList: false }));
  await assert.rejects(() => a.enumerate(null, null, {}), /can't browse its catalog/);
});

// ─── the drain hold: a run's window outlives the clock, nobody else's does ────

test("enumerate: a drain tick holds its window past the TTL; a preview never does", async () => {
  const prev = process.env.INGEST_FEED_CACHE_MS;
  process.env.INGEST_FEED_CACHE_MS = "60000";
  try {
    _resetWindowCache();
    const conn = stubConn({ pages: [[row("a", "A"), row("b", "B")], []] });
    const a = feedAdapter(conn);
    const sort = { by: "rank", order: "desc" };
    await a.enumerate(null, null, { sort });
    const walked = conn.listCalls.length;

    // Past the clock TTL, an ordinary caller re-walks — the preview route's
    // behaviour is deliberately unchanged.
    _ageWindowCache(90_000);
    await a.enumerate(null, null, { sort });
    assert.equal(conn.listCalls.length, walked * 2, "a lapsed window re-pages for a non-drain caller");

    // A drain tick is the same logical run coming back for its next batch. It
    // reads the window it is draining instead of re-walking a metered catalog
    // ~200 times per run.
    _ageWindowCache(90_000);
    const held = await a.enumerate(null, null, { sort }, { drain: true });
    assert.equal(conn.listCalls.length, walked * 2, "a drain tick held the window past the TTL");
    assert.deepEqual(held.candidates.map((c) => c.key), ["a", "b"], "and got the same snapshot");

    // The hold is bounded from the FILL, not from the last touch — otherwise a
    // long drain slides a stale catalog along forever.
    _ageWindowCache(7 * 60 * 60 * 1000);
    await a.enumerate(null, null, { sort }, { drain: true });
    assert.ok(conn.listCalls.length > walked * 2, "past WINDOW_MAX_MS even a drain re-walks");
  } finally {
    process.env.INGEST_FEED_CACHE_MS = prev;
    _resetWindowCache();
  }
});

test("enumerate: TTL 0 disables the cache for a drain too, not just for everyone else", async () => {
  const prev = process.env.INGEST_FEED_CACHE_MS;
  try {
    _resetWindowCache();
    process.env.INGEST_FEED_CACHE_MS = "60000";
    const conn = stubConn({ pages: [[row("a", "A")], []] });
    const a = feedAdapter(conn);
    const sort = { by: "rank", order: "desc" };
    await a.enumerate(null, null, { sort });
    const walked = conn.listCalls.length;
    // Turning the cache off mid-run must not leave a drain reading the entry it
    // left behind: nothing writes while the cache is off, so nothing prunes it
    // either, and the hold would outlive the switch that was meant to end it.
    process.env.INGEST_FEED_CACHE_MS = "0";
    await a.enumerate(null, null, { sort }, { drain: true });
    assert.ok(conn.listCalls.length > walked, "a disabled cache is disabled for the drain as well");
  } finally {
    process.env.INGEST_FEED_CACHE_MS = prev;
    _resetWindowCache();
  }
});

test("enumerate: extending keeps a live drain's window off the prune path", async () => {
  const prev = process.env.INGEST_FEED_CACHE_MS;
  process.env.INGEST_FEED_CACHE_MS = "60000";
  try {
    _resetWindowCache();
    const conn = stubConn({ pages: [[row("a", "A")], []] });
    const a = feedAdapter(conn);
    const sort = { by: "rank", order: "desc" };
    await a.enumerate(null, null, { sort });
    const walked = conn.listCalls.length;
    // Age past the TTL, then let a drain tick touch it. pruneExpired runs on
    // every window WRITE, so a second board filling its own window would drop
    // an entry whose `at` is stale — the touch is what stops that.
    _ageWindowCache(90_000);
    await a.enumerate(null, null, { sort }, { drain: true });
    const other = stubConn({ pages: [[row("z", "Z")], []] });
    await feedAdapter(other).enumerate(null, null, { sort }); // writes → prunes
    await a.enumerate(null, null, { sort }, { drain: true });
    assert.equal(conn.listCalls.length, walked, "the touched entry survived another window's prune");
  } finally {
    process.env.INGEST_FEED_CACHE_MS = prev;
    _resetWindowCache();
  }
});

// ─── stopping early when it's a proof, not a preference ──────────────────────

// A provider that orders `rank` exactly, server-side, and hands back rows in
// that order — the shape the threshold exit is allowed to reason about.
function rankedConn(rows, { honorsSorts = ["rank"] } = {}) {
  const conn = stubConn();
  conn.activeProvider = async () => ({ name: "acme", provider: { list: () => {}, honorsSorts } });
  conn.list = async (_db, opts) => {
    conn.listCalls.push(opts);
    return rows.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize)
      .map((v) => row(`r${v}`, `R${v}`, { rank: v }));
  };
  return conn;
}
// 1000 rows descending by rank, 250/page → 4 pages plus the empty one.
const DESC = Array.from({ length: 1000 }, (_, i) => 1000 - i);

test("enumerate: a filter on the sort key stops the walk — and the result is complete, not capped", async () => {
  // rank >= 900, walking rank descending: the first row under 900 proves every
  // later row is under it. That lands on page 1, so pages 2-4 are never bought.
  const conn = rankedConn(DESC);
  const cfg = { sort: { by: "rank", order: "desc" }, filters: [{ fn: "rank", op: "gte", value: 900 }] };
  const { candidates, truncated } = await feedAdapter(conn).enumerate(null, null, cfg);
  assert.deepEqual(conn.listCalls.map((c) => c.page), [1], "stopped on the page that proved it");
  assert.equal(truncated, false, "the MATCHING set ended — 'capped' would be a lie");
  // Everything at or above the bound is present; the engine drops the rest.
  const kept = candidates.filter((c) => c.values.rank >= 900);
  assert.equal(kept.length, 101, "ranks 1000..900 all survived the early stop");
});

test("enumerate: ascending stops on the mirror-image bound", async () => {
  const conn = rankedConn([...DESC].reverse());
  const cfg = { sort: { by: "rank", order: "asc" }, filters: [{ fn: "rank", op: "lte", value: 100 }] };
  const { truncated } = await feedAdapter(conn).enumerate(null, null, cfg);
  assert.deepEqual(conn.listCalls.map((c) => c.page), [1]);
  assert.equal(truncated, false);
});

test("enumerate: the stop needs the sort's OWN key, its own direction, and a provider that means it", async () => {
  const full = [1, 2, 3, 4, 5]; // pages walked when nothing may stop the walk
  const cases = [
    ["a filter on another column proves nothing about rank order",
      ["rank"], { sort: { by: "rank", order: "desc" }, filters: [{ fn: "price", op: "gte", value: 900 }] }],
    ["the wrong direction — `lte` while descending is a floor the walk hasn't reached",
      ["rank"], { sort: { by: "rank", order: "desc" }, filters: [{ fn: "rank", op: "lte", value: 900 }] }],
    ["a sort the provider only APPROXIMATES (CoinGecko's price → market_cap order)",
      [], { sort: { by: "rank", order: "desc" }, filters: [{ fn: "rank", op: "gte", value: 900 }] }],
  ];
  for (const [why, honorsSorts, cfg] of cases) {
    const conn = rankedConn(DESC, { honorsSorts });
    const { truncated } = await feedAdapter(conn).enumerate(null, null, cfg);
    assert.deepEqual(conn.listCalls.map((c) => c.page), full, why);
    assert.equal(truncated, false, "the catalog's own end, reached the long way");
  }
});

test("enumerate: a null in the sort column never stops the walk", async () => {
  // Nulls prove nothing about the ordering. The engine fails them downstream
  // (a filter never admits blind), but the walk must carry on past them.
  const conn = rankedConn(DESC);
  const listed = conn.list;
  conn.list = async (db, opts) => {
    const rows = await listed(db, opts);
    if (opts.page === 1) rows[5].values.rank = null;
    return rows;
  };
  const cfg = { sort: { by: "rank", order: "desc" }, filters: [{ fn: "rank", op: "gte", value: 990 }] };
  const { candidates } = await feedAdapter(conn).enumerate(null, null, cfg);
  assert.ok(candidates.length > 6, "the null didn't read as 'below the bound'");
});

test("enumerate: the stop bound is part of the cache key — a partial window can't serve a wider one", async () => {
  const prev = process.env.INGEST_FEED_CACHE_MS;
  process.env.INGEST_FEED_CACHE_MS = "60000";
  try {
    _resetWindowCache();
    const conn = rankedConn(DESC);
    const a = feedAdapter(conn);
    const at = (bound) => ({ sort: { by: "rank", order: "desc" }, filters: [{ fn: "rank", op: "gte", value: bound }] });
    await a.enumerate(null, null, at(900));
    const tight = conn.listCalls.length;
    await a.enumerate(null, null, at(900));
    assert.equal(conn.listCalls.length, tight, "same bound → same window, still reused");
    // The window for `>= 900` stops mid-catalog. Handing it to `>= 100` would
    // silently drop every row between them — the filter key is normally left
    // OUT of the cache key so a filter edit reuses the window, and this is the
    // one filter that changes what the window CONTAINS.
    const wide = await a.enumerate(null, null, at(100));
    assert.ok(conn.listCalls.length > tight, "a lower bound re-walks instead of reusing a shorter window");
    assert.ok(wide.candidates.some((c) => c.values.rank < 900), "and it reaches the rows the first walk never saw");
  } finally {
    process.env.INGEST_FEED_CACHE_MS = prev;
    _resetWindowCache();
  }
});

// ─── page size: 250 was CoinGecko's ceiling, not everyone's ───────────────────

test("enumerate: page size defaults to 250, and a provider may declare a bigger one", async () => {
  const conn = stubConn({ pages: [[row("a", "A")], []] });
  await feedAdapter(conn).enumerate(null, null, {});
  assert.equal(conn.listCalls[0].pageSize, 250, "the default is CoinGecko's per_page cap");

  // CMC's listings/latest takes limit up to 5000; asking it for 250 turned a
  // ~2-request walk into ~32.
  const bulk = stubConn({ pages: [[row("a", "A")], []] });
  bulk.activeProvider = async () => ({ name: "acme", provider: { list: () => {}, maxPageSize: 5000 } });
  await feedAdapter(bulk).enumerate(null, null, {});
  assert.equal(bulk.listCalls[0].pageSize, 5000, "a declared maxPageSize reaches the provider");
});

test("enumerate: a declared page size is clamped, and the page budget follows it", async () => {
  // Two rules at once. A plugin domain can declare maxPageSize, so it is
  // clamped (50k → the 10k ceiling) before anything uses it; and the
  // never-empty-page backstop derives from SAFETY_CAP (100k) over the size
  // ACTUALLY in use, so it lands at 10 pages. Left at the old module-wide
  // 250-row derivation it would have been 400 — a page budget and a row budget
  // disagreeing, which is the bug the derivation exists to prevent.
  const conn = stubConn();
  conn.list = async (_db, opts) => { conn.listCalls.push(opts); return [row(`p${opts.page}`, `P${opts.page}`)]; };
  conn.activeProvider = async () => ({ name: "acme", provider: { list: () => {}, maxPageSize: 50000 } });
  const { candidates, truncated } = await feedAdapter(conn).enumerate(null, null, {});
  assert.equal(conn.listCalls[0].pageSize, 10000, "the declared size is clamped to the ceiling");
  assert.equal(conn.listCalls.length, 10, "ceil(100000 / 10000) pages, then the backstop");
  assert.equal(candidates.length, 10);
  assert.equal(truncated, true, "a page-budget exit is truncated — pages were still coming");
});

// ─── prewarm: one request for a batch, not one per admission ──────────────────

test("prewarm: the admission batch's ids go out as one call; failure is survivable", async () => {
  const calls = [];
  const conn = stubConn();
  conn.prefetchIds = async (_db, ids) => { calls.push(ids); };
  const a = feedAdapter(conn);
  await a.prewarm(null, null, [{ id: "bitcoin" }, { id: "ethereum" }, { id: "dogecoin" }]);
  assert.deepEqual(calls, [["bitcoin", "ethereum", "dogecoin"]], "one batched warm, ids in batch order");

  // Best-effort by contract (the prefetchDueRefreshes rule): a failed warm just
  // means the per-item path pays retail, which is the pre-prewarm behaviour.
  conn.prefetchIds = async () => { throw new Error("provider down"); };
  await a.prewarm(null, null, [{ id: "bitcoin" }, { id: "ethereum" }]);

  // A connector binding without the capability is a no-op all the way down.
  const bare = stubConn();
  await feedAdapter(bare).prewarm(null, null, [{ id: "x" }, { id: "y" }]);
});

test("descriptor: a feed names its own per-tick cap; the file adapter keeps the shared 25", () => {
  assert.equal(feedAdapter(stubConn()).descriptor().runCap, 250,
    "feeds pay per TICK (one walk, one prewarm), not per item");
  assert.equal(files.descriptor().runCap, undefined,
    "the file adapter declares none and falls back to the tick-latency default");
});

// ─── integration ─────────────────────────────────────────────────────────────

// A countable provider for the drain-economics test: every outbound call the
// feed can make (catalog page, batched warm, per-item fetch) lands in `calls`,
// so a run's cost is an assertion rather than a story.
const WIDGET_ROWS = ["w1", "w2", "w3", "w4", "w5"];
const calls = { list: [], prefetch: [], fetchEntity: [] };
const acme = {
  label: "Acme",
  description: "countable",
  needsKey: false,
  rpm: 100000, // pacing isn't what this test measures
  burst: 100,
  async list({ page = 1, pageSize = 250 } = {}) {
    calls.list.push({ page, pageSize });
    const slice = WIDGET_ROWS.slice((page - 1) * pageSize, page * pageSize);
    return slice.map((id) => ({ id, symbol: id, label: id, values: { name: id, rank: WIDGET_ROWS.indexOf(id) } }));
  },
  async prefetch(ids) { calls.prefetch.push(ids); },
  async fetchEntity(id) {
    calls.fetchEntity.push(id);
    return { id, symbol: id.toUpperCase(), display_name: id, fields: { rank: { v: 1, kind: "number" } } };
  },
};
const WIDGETS = {
  providers: { acme },
  defaultProvider: "acme",
  manifest: {
    label: "Widgets",
    fields: [{ key: "rank", kind: "number", fn: "rank", label: "Rank" }],
    providers: [{ name: "acme", label: "Acme", description: "", needsKey: false }],
    template: {
      input: { connector: "widgets" },
      identity: { from: "connector" },
      fields: [{ key: "rank", kind: "number", from: "connector", fn: "rank" }],
    },
    browse: {
      columns: [{ key: "name", label: "Name", kind: "text", primary: true }, { key: "rank", label: "#", kind: "number" }],
      sorts: [{ key: "rank", label: "Rank" }],
      defaultSort: "rank",
      pageSize: 50,
    },
  },
};

let srv, db, base, admin, sources, stopWorker;

// The mocked CoinGecko universe: /coins/markets pages + /coins/:id details.
// Values chosen so a market_cap filter can split them.
const COINS = [
  { id: "bitcoin", symbol: "btc", name: "Bitcoin", market_cap: 1000, current_price: 50, price_change_percentage_24h: 1, total_volume: 10, market_cap_rank: 1 },
  { id: "ethereum", symbol: "eth", name: "Ethereum", market_cap: 500, current_price: 30, price_change_percentage_24h: 2, total_volume: 8, market_cap_rank: 2 },
  { id: "dogecoin", symbol: "doge", name: "Dogecoin", market_cap: 100, current_price: 1, price_change_percentage_24h: 3, total_volume: 5, market_cap_rank: 3 },
];
let originalFetch;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  await installConnectors(db, "crypto:coingecko"); // the sweep e2e drives the real crypto connector
  // A stub DOMAIN registered through the real registry, so the drain-economics
  // test below runs the actual worker → runtime → bind → adapter path with a
  // provider whose every call is countable. The crypto mock can't answer that
  // question: its walk completes in microseconds, so its quote cache is still
  // warm at admission time and the retail cost the prewarm removes never
  // appears. The bug is a race between a minutes-long walk and a 60s TTL.
  registerConnector("widgets", WIDGETS);
  await installConnectors(db, "widgets:acme");
  sources = createSources({ galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
  process.env.POLL_MS = "50";
  process.env.INGEST_RUN_CAP = "2"; // force multi-tick drains
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes("coingecko.com")) return originalFetch(url, opts);
    if (u.includes("/coins/markets")) {
      const page = Number(new URL(u).searchParams.get("page") || 1);
      return { ok: true, status: 200, json: async () => (page === 1 ? COINS : []), text: async () => "" };
    }
    const m = u.match(/\/coins\/([a-z-]+)\?/);
    const c = COINS.find((x) => x.id === m?.[1]);
    if (!c) return { ok: false, status: 404, json: async () => ({}), text: async () => "", headers: { get: () => null } };
    return {
      ok: true, status: 200, text: async () => "",
      json: async () => ({
        id: c.id, name: c.name, symbol: c.symbol,
        market_data: {
          current_price: { usd: c.current_price },
          market_cap: { usd: c.market_cap },
          price_change_percentage_24h: c.price_change_percentage_24h,
        },
      }),
    };
  };
  stopWorker = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir, sources });
});
after(async () => {
  await stopWorker();
  globalThis.fetch = originalFetch;
  unregisterConnector("widgets");
  delete process.env.INGEST_RUN_CAP;
  delete process.env.POLL_MS;
  sources.close?.();
  await srv.close();
});

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 60));
  }
}

const entityIdentities = async (boardId) => {
  const { rows } = await db.query("SELECT identity FROM entities WHERE board_id=$1 ORDER BY identity", [boardId]);
  return rows.map((r) => r.identity);
};

test("admit: entity + tag vehicle + ledger row; a duplicate identity propagates tagged", async () => {
  const boardId = await seedBoard(db, "feed-admit");
  await updateBoard(db, boardId, {
    mapping: { input: { connector: "widgets" }, identity: { from: "connector" }, fields: [] },
  });
  const board = await getBoard(db, boardId);
  const a = feedAdapter(stubConn());

  await a.admit(db, board, { key: "gz", id: "Gizmo", label: "Gizmo", values: {} });
  assert.deepEqual(await entityIdentities(boardId), ["gizmo"]);
  const { rows: [item] } = await db.query("SELECT payload, status FROM items WHERE board_id=$1", [boardId]);
  assert.equal(item.status, "pending", "auto-tag on, no face → straight to the tag leg");
  assert.deepEqual(item.payload.source, { provider: "acme", id: "Gizmo" });
  const { rows: ledger } = await db.query("SELECT source_key FROM ingest_log WHERE board_id=$1", [boardId]);
  assert.deepEqual(ledger.map((r) => r.source_key), ["gz"]);

  // Same identity again (ledger row lost, or a manual add raced the feed):
  // the entities unique constraint answers, tagged for the sweep to ledger.
  await assert.rejects(
    () => a.admit(db, board, { key: "gz2", id: "gizmo", label: "Gizmo", values: {} }),
    (err) => err.duplicate === true
  );
});

test("sweep e2e: a crypto feed admits its filter-defined bucket, once", async () => {
  const boardId = await seedBoard(db, "feed-sweep");
  await updateBoard(db, boardId, { mapping: cryptoManifest.template });
  await updateBoard(db, boardId, {
    ingest: {
      enabled: true,
      source: {},
      filters: [{ fn: "market_cap", op: "gte", value: 200 }], // btc + eth; doge out
      sort: { by: "market_cap", order: "desc" },
      trigger: { mode: "manual" },
    },
  });
  await setIngestNextRun(db, boardId, Date.now() - 1);

  // Manual trigger: the timer disarms once the run completes.
  const b1 = await until(async () => {
    const b = await getBoard(db, boardId);
    return b.ingest_state?.last_run_at && b.ingest_next_run_at === null ? b : null;
  });
  assert.equal(b1.ingest_state.last_error, null);
  assert.equal(b1.ingest_state.last_added, 2);
  assert.deepEqual(await entityIdentities(boardId), ["btc", "eth"], "the filter held doge out");
  const { rows: [ent] } = await db.query("SELECT fields FROM entities WHERE board_id=$1 AND identity='btc'", [boardId]);
  assert.equal(ent.fields.price.v, 50, "admitted through the full fetchEntity path — bound fields landed");

  // Second run: everything already ledgered — nothing re-admitted.
  await setIngestNextRun(db, boardId, Date.now() - 1);
  const b2 = await until(async () => {
    const b = await getBoard(db, boardId);
    return b.ingest_state?.last_run_at > b1.ingest_state.last_run_at ? b : null;
  });
  assert.equal(b2.ingest_state.last_added, 0);
  assert.deepEqual(await entityIdentities(boardId), ["btc", "eth"]);

  // Deleting a fed entity is a user judgment the feed must not overturn.
  const { rows: [eth] } = await db.query("SELECT id FROM entities WHERE board_id=$1 AND identity='eth'", [boardId]);
  await deleteEntity(db, eth.id);
  await setIngestNextRun(db, boardId, Date.now() - 1);
  const b3 = await until(async () => {
    const b = await getBoard(db, boardId);
    return b.ingest_state?.last_run_at > b2.ingest_state.last_run_at ? b : null;
  });
  assert.equal(b3.ingest_state.last_added, 0, "the ledger outlives the entity — no resurrection");
  assert.deepEqual(await entityIdentities(boardId), ["btc"]);

  // The shared preview route runs the same enumerate: count is the filtered
  // window, `new` subtracts the ledger (both coins ledgered — only doge would
  // be new if the filter allowed it, so new = 0 here).
  const prev = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { source: {}, filters: [], sort: { by: "market_cap", order: "desc" }, trigger: { mode: "manual" } },
  });
  assert.equal(prev.status, 200);
  assert.deepEqual(prev.json, { count: 3, new: 1, capped: false, scanned: 3 },
    "filterless preview sees the full universe; only doge is unledgered");

  const page = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { source: {}, filters: [], sort: { by: "market_cap", order: "desc" }, trigger: { mode: "manual" }, sample: { offset: 0, limit: 50 } },
  });
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.sample.map((c) => [c.key, c.ingested]), [["btc", true], ["eth", true], ["doge", false]]);
});

test("drain economics: one catalog walk per RUN, one batched warm per tick", async () => {
  // The shape this whole change is about. A run bigger than the per-tick cap
  // drains across back-to-back ticks, and each tick used to re-walk the whole
  // catalog and then re-buy every row it admitted one at a time: for a metered
  // catalog that was ~74 requests of setup plus ~25 retail admissions per 25
  // items admitted, ~200 times over for a 5,000-row run.
  //
  // A 1ms window TTL is the minutes-long walk in miniature: the clock has
  // always lapsed by the next tick, so anything that re-walks here would
  // re-walk in production too. Only a DRAIN tick holds the window.
  const prevTtl = process.env.INGEST_FEED_CACHE_MS;
  process.env.INGEST_FEED_CACHE_MS = "1";
  try {
    calls.list.length = calls.prefetch.length = calls.fetchEntity.length = 0;
    const boardId = await seedBoard(db, "widget-drain");
    await updateBoard(db, boardId, { mapping: WIDGETS.manifest.template });
    await updateBoard(db, boardId, {
      ingest: {
        enabled: true, source: {}, filters: [],
        sort: { by: "rank", order: "asc" }, trigger: { mode: "manual" },
      },
    });
    await setIngestNextRun(db, boardId, Date.now() - 1);

    const b = await until(async () => {
      const row = await getBoard(db, boardId);
      return row.ingest_state?.last_run_at && row.ingest_next_run_at === null ? row : null;
    });
    assert.equal(b.ingest_state.last_error, null);
    assert.equal((await entityIdentities(boardId)).length, 5, "all five admitted across the drain");

    // 5 rows at a cap of 2 = three ticks. One walk for the run: page 1 (250
    // wide, so the whole catalog) plus the empty page that ends it.
    assert.deepEqual(calls.list.map((c) => c.page), [1, 2],
      "one walk for the whole run — three ticks would have paid for three");
    assert.equal(calls.list[0].pageSize, 250);

    // Two full batches warm in one call each; the last tick's single item is
    // below the batch threshold and pays retail, which is correct — a batch of
    // one is just a fetch with extra steps.
    assert.deepEqual(calls.prefetch, [["w1", "w2"], ["w3", "w4"]],
      "one batched warm per full tick, ids in admission order");
    assert.deepEqual(calls.fetchEntity, WIDGET_ROWS,
      "admissions still fetch per item — the warm is what makes that free");
  } finally {
    process.env.INGEST_FEED_CACHE_MS = prevTtl;
  }
});

test("switching a board's mapping input orphans and clears its ingest config", async () => {
  // A file board with a folder ingest config, switched to a connector input:
  // the folder config is meaningless (and dangerous — its empty source would
  // scan INGEST_ROOT) under the feed adapter, so the switch clears it.
  const boardId = await seedBoard(db, "switch-clear");
  await updateBoard(db, boardId, {
    ingest: { enabled: true, source: { folder: "x" }, filters: [], trigger: { mode: "manual" } },
  });
  await setIngestNextRun(db, boardId, Date.now() + 3600_000); // armed, far future
  await db.query("UPDATE boards SET ingest_state=$1 WHERE id=$2",
    [JSON.stringify({ last_run_at: 1, last_added: 3, drain_left: 2 }), boardId]);

  // Switch files → crypto via the admin mapping PATCH.
  const r = await req(base, "PATCH", `/api/admin/boards/${boardId}`, {
    sid: admin.sid, body: { mapping: cryptoManifest.template },
  });
  assert.equal(r.status, 200);
  const b = await getBoard(db, boardId);
  assert.equal(b.ingest, null, "orphaned config cleared");
  assert.equal(b.ingest_next_run_at, null, "timer disarmed");
  assert.equal(b.ingest_state, null, "run state (incl. stale drain_left) wiped");

  // A no-op mapping edit that doesn't change the input leaves a config intact.
  await updateBoard(db, boardId, {
    ingest: { enabled: true, source: {}, filters: [], sort: { by: "market_cap", order: "desc" }, trigger: { mode: "manual" } },
  });
  const r2 = await req(base, "PATCH", `/api/admin/boards/${boardId}`, {
    sid: admin.sid, body: { mapping: { ...cryptoManifest.template, context: "edited" } },
  });
  assert.equal(r2.status, 200);
  assert.ok((await getBoard(db, boardId)).ingest, "same connector input → config survives");
});

test("saving a new config clears a stale drain budget", async () => {
  // Feed board (empty source needs no INGEST_ROOT) so the manager PATCH's
  // validateIngest passes on the config alone.
  const boardId = await seedBoard(db, "drain-clear");
  await updateBoard(db, boardId, { mapping: cryptoManifest.template });
  const feed = (limit) => ({ enabled: true, source: {}, filters: [], sort: { by: "market_cap", order: "desc" }, limit, trigger: { mode: "manual" } });
  await updateBoard(db, boardId, { ingest: feed(5) });
  await db.query("UPDATE boards SET ingest_state=$1 WHERE id=$2",
    [JSON.stringify({ last_run_at: 1, last_added: 2, drain_left: 3 }), boardId]);
  const r = await req(base, "PATCH", `/api/boards/${boardId}`, { sid: admin.sid, body: { ingest: feed(2) } });
  assert.equal(r.status, 200);
  const b = await getBoard(db, boardId);
  assert.equal(b.ingest_state.drain_left ?? null, null, "dead run's budget dropped");
  assert.equal(b.ingest_state.last_added, 2, "run history preserved");
});

test("a failed MANUAL feed run disarms instead of retrying forever", async () => {
  const boardId = await seedBoard(db, "manual-error");
  // An unknown connector → resolveIngestAdapter null → the sweep throws
  // "ingestion is not available". Written directly (validateIngest would
  // refuse to save against a null descriptor), armed for an immediate run.
  await updateBoard(db, boardId, {
    mapping: { input: { connector: "ghost" }, identity: { from: "connector" }, fields: [] },
    ingest: { enabled: true, source: {}, filters: [], trigger: { mode: "manual" } },
  });
  await setIngestNextRun(db, boardId, Date.now() - 1);

  const b = await until(async () => {
    const x = await getBoard(db, boardId);
    return x.ingest_state?.last_error ? x : null;
  });
  assert.match(b.ingest_state.last_error, /not available/);
  assert.equal(b.ingest_next_run_at, null, "manual run asked once, errored once — disarmed, no 5m retry loop");
});

test("resolveIngestAdapter: connector board → feed adapter bound to its manifest", async () => {
  const boardId = await seedBoard(db, "feed-resolve");
  await updateBoard(db, boardId, { mapping: cryptoManifest.template });
  const board = await getBoard(db, boardId);
  const a = resolveIngestAdapter(board);
  assert.ok(a);
  const d = a.descriptor();
  assert.ok(d.filters.some((f) => f.fn === "market_cap" && f.kind === "number"));
  assert.ok(!d.triggerModes.includes("continuous"));
});
