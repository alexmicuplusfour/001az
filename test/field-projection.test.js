// Stored = declared (planning/field-projection-plan.md): a connector board
// stores exactly the connector fields its mapping declares — projected at land
// time, stripped on mapping save, converged by refresh, backfilled by the
// sweep when the mapping grows.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req, installConnectors, withFetch } from "./helpers.js";
import { projectConnectorFields } from "../server/connectors/project.js";
import * as runtime from "../server/connectors/runtime.js";
import * as coingecko from "../server/connectors/crypto/coingecko.js";

// ─── pure: the land-time projection ──────────────────────────────────────────

test("projectConnectorFields: subset, fn→key rename, total (v:null for the unanswered)", () => {
  const entity = {
    source: { provider: "p", id: "x" },
    fields: {
      price: { v: 9, kind: "number", src: "p", at: 7 },
      volume: { v: 3, kind: "number", src: "p", at: 7 },
    },
  };
  const mapping = [
    { key: "cost", kind: "number", source: "connector", fn: "price" }, // renamed
    { key: "phantom", kind: "text", source: "connector", fn: "phantom" }, // provider silent
    { key: "note", kind: "text", source: "extract" }, // not connector → not projected
  ];
  const out = projectConnectorFields(entity, mapping, 7);
  assert.deepEqual(out, {
    cost: { v: 9, kind: "number", src: "p", at: 7 },
    // Present-but-empty, never absent: presence is what stops the scheduler's
    // absent-key term from re-buying an unanswerable field forever — and its
    // provenance is derived from the entity, not rebuilt by the land site.
    phantom: { v: null, kind: "text", src: "p", at: 7 },
  });
  assert.deepEqual(projectConnectorFields(null, []), {});
});

// ─── integration ─────────────────────────────────────────────────────────────

let srv, db, base, admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  await installConnectors(db, "crypto:coingecko");
});

after(() => srv.close());

const MARKETS_ROW = {
  id: "bitcoin", name: "Bitcoin", symbol: "btc",
  current_price: 50000, market_cap: 1e12, market_cap_rank: 1,
  total_volume: 3e10, price_change_percentage_24h: -1.5,
  price_change_percentage_1h_in_currency: 0.2,
  price_change_percentage_7d_in_currency: 4.1,
  price_change_percentage_30d_in_currency: 9.9,
  ath: 110000, circulating_supply: 19700000,
};

// A crypto mapping declaring a two-field SUBSET of the provider's catalog.
const subsetMapping = {
  input: { connector: "crypto" },
  identity: { source: "connector" },
  fields: [
    { key: "price", kind: "number", source: "connector", fn: "price" },
    { key: "market_cap", kind: "number", source: "connector", fn: "market_cap" },
  ],
};

async function addBitcoin(boardId) {
  coingecko._resetQuoteCache();
  // req() itself rides fetch, so the stub passes everything but the provider
  // call through to the real one (captured before withFetch swaps it).
  const real = globalThis.fetch;
  return withFetch(
    (url, opts) => url.includes("/coins/markets")
      ? Promise.resolve({ ok: true, status: 200, json: async () => [MARKETS_ROW], text: async () => "" })
      : real(url, opts),
    () => req(base, "POST", `/api/boards/${boardId}/entities`, {
      sid: admin.sid, body: { connector: "crypto", id: "bitcoin" },
    })
  );
}

test("add lands the mapped subset only; static-and-present schedules nothing", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", {
    sid: admin.sid, body: { name: "proj-subset" },
  });
  const p = await req(base, "PATCH", `/api/admin/boards/${board.id}`, {
    sid: admin.sid, body: { mapping: subsetMapping },
  });
  assert.equal(p.status, 200);

  const r = await addBitcoin(board.id);
  assert.equal(r.status, 200);
  // The provider answered its full catalog; only the mapping's two keys land.
  const { rows: [ent] } = await db.query("SELECT fields, refresh_at FROM entities WHERE id=$1", [r.json.id]);
  assert.deepEqual(Object.keys(ent.fields).sort(), ["market_cap", "price"]);
  assert.equal(ent.fields.price.v, 50000);
  assert.equal(ent.fields.price.src, "coingecko");
  // Both wanted keys present, neither live → nothing to sweep.
  assert.equal(ent.refresh_at, null);
});

test("mapping save reconciles: removed field's data stripped, added field stamped due-now", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", {
    sid: admin.sid, body: { name: "proj-reconcile" },
  });
  await req(base, "PATCH", `/api/admin/boards/${board.id}`, {
    sid: admin.sid, body: { mapping: subsetMapping },
  });
  const r = await addBitcoin(board.id);
  assert.equal(r.status, 200);

  // Drop market_cap, pick up volume (previously unmapped).
  const before = Date.now();
  const p = await req(base, "PATCH", `/api/admin/boards/${board.id}`, {
    sid: admin.sid,
    body: {
      mapping: {
        ...subsetMapping,
        fields: [
          { key: "price", kind: "number", source: "connector", fn: "price" },
          { key: "volume", kind: "number", source: "connector", fn: "volume" },
        ],
      },
    },
  });
  assert.equal(p.status, 200);

  const { rows: [ent] } = await db.query("SELECT fields, refresh_at FROM entities WHERE id=$1", [r.json.id]);
  // market_cap's stored value is gone; volume is NOT fabricated — its absence
  // is what marks the entity due for the sweep to buy the real value.
  assert.deepEqual(Object.keys(ent.fields), ["price"]);
  assert.ok(ent.refresh_at !== null && ent.refresh_at >= before - 60000 && ent.refresh_at <= Date.now(),
    `expected due-now refresh_at, got ${ent.refresh_at}`);
});

test("validateMapping refuses a connector fn the domain doesn't declare", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", {
    sid: admin.sid, body: { name: "proj-badfn" },
  });
  const p = await req(base, "PATCH", `/api/admin/boards/${board.id}`, {
    sid: admin.sid,
    body: {
      mapping: {
        ...subsetMapping,
        fields: [{ key: "nope", kind: "number", source: "connector", fn: "not_a_field" }],
      },
    },
  });
  assert.equal(p.status, 400);
  assert.match(p.json.error, /unknown connector field fn/);
});

// ─── runtime.refresh: the sweep side of the invariant ────────────────────────

test("refresh buys an absent wanted key; an unanswerable one lands {v:null} and comes off the sweep", async () => {
  const prov = {
    label: "P",
    async search() { return [{ id: "x", symbol: "AA" }]; },
    async fetchEntity(id) {
      return { id, symbol: "AA", display_name: "A", fields: { price: { v: 9, kind: "number" } } };
    },
    async testConnection() { return true; },
  };
  const conn = { name: "projsweep", providers: { p: prov }, defaultProvider: "p", manifest: {} };
  await installConnectors(db, "projsweep:p");

  const mapping = { fields: [
    { key: "price", kind: "number", source: "connector", fn: "price" },     // static, absent → due
    { key: "phantom", kind: "text", source: "connector", fn: "phantom" },   // provider can't answer it
  ]};
  const inst = { payload: { source: { provider: "p", id: "x" } } };
  const now = 5000;
  const r = await runtime.refresh(db, conn, { symbol: "AA", fields: {} }, inst, mapping, now);
  assert.deepEqual(r.merged.price, { v: 9, kind: "number", src: "p", at: now });
  assert.deepEqual(r.merged.phantom, { v: null, kind: "text", src: "p", at: now });
  // Every wanted key now exists and none is live → off the sweep, NOT due
  // forever: the totality rule doing its job.
  assert.equal(r.next, null);
});
