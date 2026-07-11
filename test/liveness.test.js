// Per-field liveness (slice 5c): the refresh runtime (which fields are due, at
// advances, moved-only history, provider re-resolution), the refresh_at
// scheduling, the opt-in retag cascade, and mapping validation. Provider fetch
// is stubbed — no live network. Each file gets its own throwaway DB, so app-
// global settings (crypto_provider) start clean here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import {
  getEntity, getBoard, createEntity, initDb,
  setSetting, setEntityRefreshAt, dueLiveEntities,
  addFieldSnapshot, pruneFieldSnapshots,
} from "../server/db.js";
import { up as stampFieldAt } from "../server/migrations/0008_stamp_field_at.js";
import * as runtime from "../server/connectors/runtime.js";
import { refreshDueEntity } from "../server/worker.js";

let srv, db, base, admin;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});
after(() => srv.close());

// ── pure: live-field selection + scheduling ──────────────────────────────────

test("liveFields selects live connector fields; nextRefreshAt = soonest due", () => {
  const mapping = { fields: [
    { key: "price", from: "connector", fn: "price", live: true, every: 1 },
    { key: "cap",   from: "connector", fn: "market_cap", live: true, every: 60 },
    { key: "url",   from: "connector", fn: "url" },                 // not live
    { key: "note",  from: "ai", live: true, every: 5 },             // not connector → excluded
  ]};
  const live = runtime.liveFields(mapping);
  assert.deepEqual(live.map((f) => f.key), ["price", "cap"]);
  const fields = { price: { at: 1000 }, cap: { at: 1000 } };
  assert.equal(runtime.nextRefreshAt(fields, live, 0), 61000); // min(1000+60000, 1000+3.6e6)
  assert.equal(runtime.nextRefreshAt({}, [], 0), null);
});

// ── runtime.refresh ──────────────────────────────────────────────────────────

test("runtime.refresh: rewrites only due fields, advances at, reports moved", async () => {
  let price = 100;
  const p1 = {
    label: "P1",
    async search() { return [{ id: "x", symbol: "XYZ" }]; },
    async fetchEntity(id) {
      return { id, symbol: "XYZ", display_name: "X",
        fields: { price: { v: price, kind: "number" }, cap: { v: 5, kind: "number" } } };
    },
    async testConnection() { return true; },
  };
  const conn = { name: "livetest", providers: { p1 }, defaultProvider: "p1", manifest: {} };
  const mapping = { fields: [
    { key: "price", from: "connector", fn: "price", live: true, every: 1 },
    { key: "cap",   from: "connector", fn: "cap",   live: true, every: 60 },
  ]};
  const fields0 = { price: { v: 100, kind: "number", src: "p1", at: 0 }, cap: { v: 5, kind: "number", src: "p1", at: 0 } };
  const inst = { id: 1, payload: { source: { provider: "p1", id: "x" }, mapping } };

  // t=90s: price (1m) due, cap (60m) not; price unchanged → no movement.
  let r = await runtime.refresh(db, conn, { symbol: "XYZ", fields: fields0 }, inst, mapping, 90000);
  assert.deepEqual(Object.keys(r.moved), []);
  assert.equal(r.merged.price.at, 90000);   // advanced (last-checked, even unchanged)
  assert.equal(r.merged.cap.at, 0);         // untouched — not due
  assert.equal(r.next, 150000);             // min(90000+60000, 0+3.6e6)

  // price moves; next due tick writes it and reports the movement.
  price = 200;
  r = await runtime.refresh(db, conn, { symbol: "XYZ", fields: r.merged }, inst, mapping, 150000);
  assert.deepEqual(Object.keys(r.moved), ["price"]);
  assert.equal(r.merged.price.v, 200);
  assert.equal(r.provider, "p1");
});

test("runtime.refresh: re-resolves the id by symbol after a provider switch", async () => {
  const calls = [];
  const mk = (label) => ({
    label,
    async search(q) { calls.push([label, "search", q]); return [{ id: label + "-id", symbol: "ZZZ" }]; },
    async fetchEntity(id) { calls.push([label, "fetch", id]); return { id, symbol: "ZZZ", display_name: "Z", fields: { price: { v: 9, kind: "number" } } }; },
    async testConnection() { return true; },
  });
  const p1 = mk("p1"), p2 = mk("p2");
  const conn = { name: "switchtest", providers: { p1, p2 }, defaultProvider: "p1", manifest: {} };
  await setSetting(db, "switchtest_provider", "p2"); // active != the source provider

  const mapping = { fields: [{ key: "price", from: "connector", fn: "price", live: true, every: 1 }] };
  const inst = { id: 1, payload: { source: { provider: "p1", id: "p1-id" }, mapping } };
  const r = await runtime.refresh(db, conn, { symbol: "ZZZ", fields: { price: { v: 9, at: 0 } } }, inst, mapping, 120000);

  assert.equal(r.provider, "p2");
  assert.ok(calls.some(([l, op]) => l === "p2" && op === "search"));               // re-resolved by symbol
  assert.ok(calls.some(([l, op, id]) => l === "p2" && op === "fetch" && id === "p2-id"));
  assert.ok(!calls.some(([l]) => l === "p1"));                                     // the stale provider is never touched
});

test("runtime.refresh: liveness comes from the board mapping, not the stamped one", async () => {
  // The instance's stamped mapping (frozen at creation) has no live field; the
  // board mapping — passed in — does. Refresh must follow the board mapping,
  // else editing liveness never affects existing entities. (Regression: the
  // sweep first read inst.payload.mapping and silently did nothing.)
  const p1 = {
    label: "P1",
    async search() { return [{ id: "x", symbol: "XYZ" }]; },
    async fetchEntity(id) { return { id, symbol: "XYZ", display_name: "X", fields: { price: { v: 250, kind: "number" } } }; },
    async testConnection() { return true; },
  };
  const conn = { name: "boardmap", providers: { p1 }, defaultProvider: "p1", manifest: {} };
  const stamped = { fields: [{ key: "price", from: "connector", fn: "price" }] };                       // no live
  const boardMapping = { fields: [{ key: "price", from: "connector", fn: "price", live: true, every: 1 }] };
  const inst = { id: 1, payload: { source: { provider: "p1", id: "x" }, mapping: stamped } };
  const r = await runtime.refresh(db, conn, { symbol: "XYZ", fields: { price: { v: 100, at: 0 } } }, inst, boardMapping, 120000);
  assert.deepEqual(Object.keys(r.moved), ["price"]); // board mapping drives it
  assert.equal(r.merged.price.v, 250);
});

// ── integration: crypto board + stubbed CoinGecko ────────────────────────────

function liveMapping() {
  return {
    input: { connector: "crypto" },
    identity: { from: "connector" },
    fields: [
      { key: "price",      kind: "number", from: "connector", fn: "price", live: true, every: 1 },
      { key: "market_cap", kind: "number", from: "connector", fn: "market_cap" }, // not live
    ],
  };
}

function stubCoingecko(price) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("coingecko.com")) {
      return { ok: true, status: 200, text: async () => "",
        json: async () => ({ id: "bitcoin", name: "Bitcoin", symbol: "btc",
          market_data: { current_price: { usd: price }, market_cap: { usd: 1e12 }, price_change_percentage_24h: -1 } }) };
    }
    return original(url, opts);
  };
  return () => { globalThis.fetch = original; };
}

async function createCryptoBoard(name) {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name } });
  const r = await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping: liveMapping() } });
  assert.equal(r.status, 200);
  return board;
}

async function addBitcoin(boardId, price) {
  const restore = stubCoingecko(price);
  try {
    const r = await req(base, "POST", `/api/boards/${boardId}/entities`, { sid: admin.sid, body: { connector: "crypto", id: "bitcoin" } });
    assert.equal(r.status, 200);
    return { eid: r.json.id, instId: r.json.instances[0].id };
  } finally { restore(); }
}

test("entity creation schedules refresh_at from the live mapping", async () => {
  const board = await createCryptoBoard("live-create");
  const { eid } = await addBitcoin(board.id, 50000);
  const e = await getEntity(db, eid);
  assert.ok(e.refresh_at !== null);
  assert.ok(Number(e.refresh_at) > Date.now());     // price @1min → ~now + 60s
  assert.ok(e.fields.price.at !== undefined);
});

test("dueLiveEntities surfaces an entity only once refresh_at is reached", async () => {
  const board = await createCryptoBoard("live-due");
  const { eid } = await addBitcoin(board.id, 50000);
  let due = await dueLiveEntities(db, Date.now(), 20);
  assert.ok(!due.some((r) => r.entity.id === eid));  // not due yet
  await setEntityRefreshAt(db, eid, 1);
  due = await dueLiveEntities(db, Date.now(), 20);
  assert.ok(due.some((r) => r.entity.id === eid));
});

test("initDb reconciles refresh_at for entities on already-live boards", async () => {
  const board = await createCryptoBoard("live-reconcile");
  const { eid } = await addBitcoin(board.id, 50000);
  await db.query("UPDATE entities SET refresh_at=NULL WHERE id=$1", [eid]); // simulate pre-deploy state
  await initDb(db);                                                          // idempotent; reconciles schedules
  const e = await getEntity(db, eid);
  assert.ok(e.refresh_at !== null, "entity on a live board gets scheduled at boot");
});

test("retag_on_refresh gates the cascade AND the movement snapshot", async () => {
  for (const retag of [false, true]) {
    const board = await createCryptoBoard(`live-cascade-${retag}`);
    if (retag) await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { retag_on_refresh: true } });
    const { eid, instId } = await addBitcoin(board.id, 50000);
    // Pretend the tag-vehicle already tagged, so a re-queue is observable.
    await db.query("UPDATE items SET status='tagged' WHERE id=$1", [instId]);

    const entity = await getEntity(db, eid);
    const { rows: [inst] } = await db.query("SELECT id, payload FROM items WHERE id=$1", [instId]);
    const boardRow = await getBoard(db, board.id);
    const restore = stubCoingecko(60000); // price moved
    let res;
    try {
      res = await refreshDueEntity(db, { entity, inst, board: boardRow }, Date.now() + 2 * 60000);
    } finally { restore(); }

    assert.deepEqual(res.moved, ["price"]);
    assert.equal(res.requeued, retag);

    const e2 = await getEntity(db, eid);
    assert.equal(e2.fields.price.v, 60000);          // data updates either way
    const { rows: [i2] } = await db.query("SELECT status FROM items WHERE id=$1", [instId]);
    assert.equal(i2.status, retag ? "pending" : "tagged");

    // Movement history rides the retag opt-in: plain live boards write none.
    const { rows: snaps } = await db.query("SELECT fields FROM field_snapshots WHERE entity_id=$1", [eid]);
    assert.equal(snaps.length, retag ? 1 : 0);
    if (retag) assert.ok(snaps[0].fields.price);
  }
});

test("pruneFieldSnapshots drops rows older than the cutoff, keeps the rest", async () => {
  const board = await createCryptoBoard("live-prune");
  const { eid } = await addBitcoin(board.id, 50000);
  const now = Date.now();
  await addFieldSnapshot(db, eid, { price: { v: 1 } }, "coingecko", now - 91 * 86400000);
  await addFieldSnapshot(db, eid, { price: { v: 2 } }, "coingecko", now - 1000);
  const pruned = await pruneFieldSnapshots(db, now - 90 * 86400000);
  assert.equal(pruned, 1);
  const { rows } = await db.query("SELECT fields FROM field_snapshots WHERE entity_id=$1", [eid]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields.price.v, 2);
});

test("retag_on_refresh round-trips through board settings", async () => {
  const board = await createCryptoBoard("live-setting");
  await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { retag_on_refresh: true } });
  const b = await getBoard(db, board.id);
  assert.equal(b.retag_on_refresh, true);
});

// ── validation ────────────────────────────────────────────────────────────────

test("validateMapping: live only on connector fields, with a valid cadence", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "live-validate" } });
  const patch = (mapping) => req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } });

  let r = await patch({ input: { connector: "crypto" }, identity: { from: "connector" },
    fields: [{ key: "price", kind: "number", from: "connector", fn: "price", live: true, every: 5 }] });
  assert.equal(r.status, 200);

  r = await patch({ identity: { from: "raw" },
    fields: [{ key: "name", kind: "text", from: "ai", live: true, every: 5 }] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /only connector fields can be live/);

  r = await patch({ input: { connector: "crypto" }, identity: { from: "connector" },
    fields: [{ key: "price", kind: "number", from: "connector", fn: "price", live: true, every: 0 }] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /every/);
});

// ── migration: `at` backfill ─────────────────────────────────────────────────

test("migration: stamps `at` on connector fields that predate liveness", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "live-migrate" } });
  const eid = await createEntity(db, board.id, {
    identity: "xrp", symbol: "XRP", displayName: "XRP",
    fields: { price: { v: 1, kind: "number", src: "coingecko" } }, // no `at` (pre-5c)
  });

  await stampFieldAt(db); // backfills `at` from updated_at
  const e = await getEntity(db, eid);
  assert.ok(e.fields.price.at !== undefined && Number(e.fields.price.at) > 0);

  const at1 = e.fields.price.at;
  await stampFieldAt(db); // second pass is a no-op
  const e2 = await getEntity(db, eid);
  assert.equal(e2.fields.price.at, at1);
});
