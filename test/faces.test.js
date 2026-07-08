// Connector faces (slice 5d): the chart renderer, the provider-gated face
// production (CoinGecko has history, CMC doesn't → fall back), the face leg that
// stores the chart before tagging, and face-slot validation. Provider fetch is
// stubbed. Own throwaway DB per file, so crypto settings start clean.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, adminSession, req } from "./helpers.js";
import { createEntity, insertItem, getEntity, getBoard, setSetting } from "../server/db.js";
import { renderChart } from "../server/connectors/crypto/chart.js";
import * as runtime from "../server/connectors/runtime.js";
import { generateFace, refreshDueEntity } from "../server/worker.js";

let srv, db, base, admin, galleryDir, thumbsDir;
before(async () => {
  srv = await startServer();
  ({ db, base, galleryDir, thumbsDir } = srv);
  admin = await adminSession(db);
});
after(() => srv.close());

// ── pure: the chart renderer ─────────────────────────────────────────────────

test("renderChart: produces a fixed-size webp from a series (and survives empties)", async () => {
  const { webp, w, h } = await renderChart(
    [{ t: 0, price: 100 }, { t: 1, price: 120 }, { t: 2, price: 110 }],
    { symbol: "BTC", name: "Bitcoin", period: "1y" }
  );
  assert.ok(Buffer.isBuffer(webp) && webp.length > 0);
  assert.equal(w, 600);
  assert.equal(h, 360);
  const empty = await renderChart([], { symbol: "X", name: "X", period: "24h" });
  assert.ok(Buffer.isBuffer(empty.webp) && empty.webp.length > 0);
});

// ── runtime.produceFace: provider gating + producer lookup ───────────────────

test("produceFace: gated on the provider having history and a known producer", async () => {
  const chart = async (series, opts) => ({ webp: Buffer.from([1, 2, 3]), w: 1, h: 1, series, opts });
  const withHist = { label: "P1", async history() { return [{ t: 0, price: 1 }, { t: 1, price: 2 }]; }, async search() { return [{ id: "p1-id", symbol: "ZZ" }]; } };
  const noHist = { label: "P2", async search() { return [{ id: "p2-id", symbol: "ZZ" }]; } };
  const conn = { name: "facetest", providers: { withHist, noHist }, defaultProvider: "withHist", faces: { chart } };
  const entity = { symbol: "ZZ", display_name: "Zed" };
  const source = { provider: "withHist", id: "abc" };
  const cfg = { producer: "chart", period: "1y" };

  const ok = await runtime.produceFace(db, conn, entity, source, cfg);
  assert.ok(ok && Buffer.isBuffer(ok.webp));                       // history present → rendered

  assert.equal(await runtime.produceFace(db, conn, entity, source, { producer: "nope", period: "1y" }), null); // unknown producer

  await setSetting(db, "facetest_provider", "noHist");
  assert.equal(await runtime.produceFace(db, conn, entity, source, cfg), null); // active provider has no history → fall back
  await setSetting(db, "facetest_provider", "withHist");
});

// ── integration: the crypto chart via generateFace (stubbed CoinGecko) ───────

function stubHistory(prices) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("market_chart")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({ prices }) };
    }
    return original(url, opts);
  };
  return () => { globalThis.fetch = original; };
}

async function faceBoard(name) {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name } });
  const mapping = {
    input: { connector: "crypto" },
    identity: { from: "connector" },
    face: { from: "connector", producer: "chart", period: "1y" },
    fields: [{ key: "price", kind: "number", from: "connector", fn: "price" }],
  };
  const r = await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } });
  assert.equal(r.status, 200);
  return board;
}

test("generateFace: renders the chart, stores it, stamps face_at, points the instance at it", async () => {
  const board = await faceBoard("face-gen");
  const eid = await createEntity(db, board.id, { identity: "btc", symbol: "BTC", displayName: "Bitcoin", fields: { price: { v: 100, kind: "number" } } });
  const boardRow = await getBoard(db, board.id);
  const instId = await insertItem(db, board.id, { identity: "btc", files: [], fields: {}, mapping: boardRow.mapping, source: { provider: "coingecko", id: "bitcoin" } }, "pending_face", eid);

  const restore = stubHistory([[0, 100], [1, 120], [2, 110]]);
  let face;
  try {
    const entity = await getEntity(db, eid);
    const { rows: [inst] } = await db.query("SELECT id, payload FROM items WHERE id=$1", [instId]);
    face = await generateFace(db, { galleryDir, thumbsDir }, entity, inst, boardRow);
  } finally { restore(); }

  assert.ok(face && face.generated === true && face.kind === "image");
  assert.equal(face.w, 600);
  assert.ok(fs.existsSync(path.join(galleryDir, face.name)));           // full
  assert.ok(fs.existsSync(path.join(thumbsDir, face.name + ".webp")));  // card face

  const e2 = await getEntity(db, eid);
  assert.ok(e2.face_at !== null);                                       // scheduled input stamped
  const { rows: [i2] } = await db.query("SELECT payload FROM items WHERE id=$1", [instId]);
  assert.equal(i2.payload.files[0].generated, true);                   // vehicle points at the chart
});

test("generateFace: no history (CMC active) leaves the tile", async () => {
  await setSetting(db, "crypto_provider", "coinmarketcap");
  const board = await faceBoard("face-cmc");
  const eid = await createEntity(db, board.id, { identity: "eth", symbol: "ETH", displayName: "Ethereum" });
  const boardRow = await getBoard(db, board.id);
  const instId = await insertItem(db, board.id, { identity: "eth", files: [], fields: {}, mapping: boardRow.mapping, source: { provider: "coinmarketcap", id: "1027" } }, "pending_face", eid);
  const entity = await getEntity(db, eid);
  const { rows: [inst] } = await db.query("SELECT id, payload FROM items WHERE id=$1", [instId]);
  const face = await generateFace(db, { galleryDir, thumbsDir }, entity, inst, boardRow);
  assert.equal(face, null);                                            // CMC has no history() → tile stays
  const { rows: [i2] } = await db.query("SELECT payload FROM items WHERE id=$1", [instId]);
  assert.deepEqual(i2.payload.files, []);
  await setSetting(db, "crypto_provider", null);
});

// ── route + validation ───────────────────────────────────────────────────────

test("POST entities on a chart-face board → the vehicle starts at pending_face", async () => {
  const board = await faceBoard("face-route");
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("coingecko.com") && String(url).includes("/coins/")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "bitcoin", name: "Bitcoin", symbol: "btc", market_data: { current_price: { usd: 50000 }, market_cap: { usd: 1e12 }, price_change_percentage_24h: -1 } }) };
    }
    return original(url, opts);
  };
  try {
    const r = await req(base, "POST", `/api/boards/${board.id}/entities`, { sid: admin.sid, body: { connector: "crypto", id: "bitcoin" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "pending_face");
    assert.equal(r.json.instances[0].status, "pending_face");
  } finally { globalThis.fetch = original; }
});

test("refreshDueEntity regenerates a due face (new filename) and folds it into refresh_at", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "face-regen" } });
  const mapping = {
    input: { connector: "crypto" }, identity: { from: "connector" },
    face: { from: "connector", producer: "chart", period: "24h", live: true, every: 1 },
    fields: [{ key: "price", kind: "number", from: "connector", fn: "price" }], // price NOT live → no /coins/ fetch
  };
  assert.equal((await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } })).status, 200);
  const boardRow = await getBoard(db, board.id);
  const eid = await createEntity(db, board.id, { identity: "btc", symbol: "BTC", displayName: "Bitcoin", fields: { price: { v: 100, kind: "number", at: 0 } } });
  const instId = await insertItem(db, board.id, { identity: "btc", files: [], fields: {}, mapping: boardRow.mapping, source: { provider: "coingecko", id: "bitcoin" } }, "pending", eid);

  const restore = stubHistory([[0, 100], [1, 120]]);
  let f1, r;
  try {
    let entity = await getEntity(db, eid);
    let { rows: [inst] } = await db.query("SELECT id, payload FROM items WHERE id=$1", [instId]);
    f1 = await generateFace(db, { galleryDir, thumbsDir }, entity, inst, boardRow, 1000);
    await db.query("UPDATE entities SET face_at=1000 WHERE id=$1", [eid]); // stale
    entity = await getEntity(db, eid);
    ({ rows: [inst] } = await db.query("SELECT id, payload FROM items WHERE id=$1", [instId]));
    const now = 1000 + 5 * 60000; // 5 min later → face (1m) due
    r = await refreshDueEntity(db, { entity, inst, board: boardRow }, now, { galleryDir, thumbsDir });
    assert.equal(r.faced, true);
    const e2 = await getEntity(db, eid);
    assert.equal(Number(e2.face_at), now);
    assert.equal(Number(e2.refresh_at), now + 60000);                 // face cadence folded in
    const { rows: [i2] } = await db.query("SELECT payload FROM items WHERE id=$1", [instId]);
    assert.notEqual(i2.payload.files[0].name, f1.name);              // new filename (cache-bust)
    assert.ok(!fs.existsSync(path.join(thumbsDir, f1.name + ".webp"))); // old unlinked
  } finally { restore(); }
});

test("validateMapping: face slot rules", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "face-validate" } });
  const patch = (mapping) => req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } });
  const crypto = (face) => ({ input: { connector: "crypto" }, identity: { from: "connector" }, face, fields: [] });

  assert.equal((await patch(crypto({ from: "connector", producer: "chart", period: "5y", live: true, every: 60 }))).status, 200);
  assert.equal((await patch(crypto({ from: "raw" }))).status, 200);

  let r = await patch(crypto({ from: "connector", producer: "nope", period: "1y" }));
  assert.equal(r.status, 400); assert.match(r.json.error, /face producer/);

  r = await patch(crypto({ from: "connector", producer: "chart", period: "3h" }));
  assert.equal(r.status, 400); assert.match(r.json.error, /period/);

  // face on a non-connector board → rejected (no connector input).
  r = await patch({ identity: { from: "raw" }, face: { from: "connector", producer: "chart", period: "1y" }, fields: [] });
  assert.equal(r.status, 400); assert.match(r.json.error, /connector/);
});
