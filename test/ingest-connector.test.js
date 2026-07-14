// The connector-feed ingestion adapter (ingestion phase 2): descriptor
// derivation from a manifest's `browse` block, bounded paging enumeration
// (empty-page stop, NOT short-page — providers clamp pageSize internally),
// cross-page dedupe, admit-then-ledger healing via the entities unique
// constraint, and the sweep running a real crypto feed end-to-end over a
// mocked provider.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, req } from "./helpers.js";
import { getBoard, updateBoard, setIngestNextRun, deleteEntity } from "../server/db.js";
import { feedAdapter } from "../server/ingestion/connector.js";
import { resolveIngestAdapter } from "../server/ingestion/index.js";
import { manifest as cryptoManifest } from "../server/connectors/crypto/index.js";
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

test("enumerate: an active provider without list() throws a readable error", async () => {
  const a = feedAdapter(stubConn({ providerCanList: false }));
  await assert.rejects(() => a.enumerate(null, null, {}), /can't browse its catalog/);
});

// ─── integration ─────────────────────────────────────────────────────────────

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
  sources = createSources({ galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
  process.env.POLL_MS = "50";
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
  assert.deepEqual(prev.json, { count: 3, new: 1, capped: false }, "filterless preview sees the full universe; only doge is unledgered");

  const page = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { source: {}, filters: [], sort: { by: "market_cap", order: "desc" }, trigger: { mode: "manual" }, sample: { offset: 0, limit: 50 } },
  });
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.sample.map((c) => [c.key, c.ingested]), [["btc", true], ["eth", true], ["doge", false]]);
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
