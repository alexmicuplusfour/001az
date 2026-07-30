// Connector faces (slice 5d): the chart renderer, the provider-gated face
// production (CoinGecko has history, CMC doesn't → fall back), the face leg that
// stores the chart before tagging, and face-slot validation. Provider fetch is
// stubbed. Own throwaway DB per file, so crypto settings start clean.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, adminSession, req, installConnectors } from "./helpers.js";
import { createEntity, insertItem, getEntity, getBoard, setSetting, advanceFaced, listItems } from "../server/db.js";
import { selectFace } from "../server/faces/select.js";
import { renderChart } from "../server/faces/price-chart.js";
import { getFaceProducer, registerFaceProducer, unregisterFaceProducer } from "../server/faces/index.js";
import * as runtime from "../server/connectors/runtime.js";
import * as coingecko from "../server/connectors/crypto/coingecko.js";
import { generateFace, refreshDueEntity } from "../server/worker.js";

let srv, db, base, admin, galleryDir, thumbsDir;
before(async () => {
  srv = await startServer();
  ({ db, base, galleryDir, thumbsDir } = srv);
  admin = await adminSession(db);
  await installConnectors(db, "crypto:coingecko", "crypto:coinmarketcap");
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

test("face registry: getFaceProducer resolves a registered name and rejects unknowns", async () => {
  const p = getFaceProducer("price-chart");
  assert.equal(typeof p, "function", "the built-in chart producer is registered");
  const { webp, w, h } = await p([{ t: 0, price: 1 }, { t: 1, price: 2 }], { symbol: "X", name: "X", period: "1y" });
  assert.ok(Buffer.isBuffer(webp) && w === 600 && h === 360); // same artifact as the direct renderChart
  // Every built-in face producer is in the registry (slice 2 routed the file
  // handlers' thumbnailers through it too — image/pdf/text are producers now).
  for (const name of ["price-chart", "image-thumb", "pdf-page", "text-peek"])
    assert.equal(typeof getFaceProducer(name), "function", `${name} is registered`);
  assert.equal(getFaceProducer("nope"), null);                // unknown name → null (caller keeps the tile)
  assert.equal(getFaceProducer(undefined), null);             // falsy name → null
});

// ── runtime.produceFace: provider gating + producer lookup ───────────────────

test("produceFace: gated on the provider having history and a known producer", async () => {
  const chart = async (series, opts) => ({ webp: Buffer.from([1, 2, 3]), w: 1, h: 1, series, opts });
  registerFaceProducer("facetest-chart", chart); // the connector NAMES it; the registry owns the fn
  const withHist = { label: "P1", async history() { return [{ t: 0, price: 1 }, { t: 1, price: 2 }]; }, async search() { return [{ id: "p1-id", symbol: "ZZ" }]; } };
  const noHist = { label: "P2", async search() { return [{ id: "p2-id", symbol: "ZZ" }]; } };
  const conn = { name: "facetest", providers: { withHist, noHist }, defaultProvider: "withHist", faces: { chart: "facetest-chart" } };
  await installConnectors(db, "facetest:withHist", "facetest:noHist");
  const entity = { symbol: "ZZ", display_name: "Zed" };
  const source = { provider: "withHist", id: "abc" };
  const cfg = { producer: "chart", period: "1y" };

  const ok = await runtime.produceFace(db, conn, entity, source, cfg);
  assert.ok(ok && Buffer.isBuffer(ok.webp));                       // history present → rendered

  assert.equal(await runtime.produceFace(db, conn, entity, source, { producer: "nope", period: "1y" }), null); // unknown producer

  await setSetting(db, "facetest_provider", "noHist");
  assert.equal(await runtime.produceFace(db, conn, entity, source, cfg), null); // active provider has no history → fall back
  await setSetting(db, "facetest_provider", "withHist");
  unregisterFaceProducer("facetest-chart");
});

// ── pure: entityRefreshAt keeps a face-only board on the sweep ───────────────

test("entityRefreshAt: a live face schedules at cadence even before/without a render", () => {
  const mapping = { fields: [], face: { from: "connector", producer: "chart", live: true, every: 5 } };
  // faceAt null (render unavailable / not yet done) → retry one cadence out,
  // NOT null — otherwise a face-only board falls off the sweep entirely.
  assert.equal(runtime.entityRefreshAt({}, null, mapping, 1000), 1000 + 5 * 60000);
  // A rendered face schedules one cadence after its render time.
  assert.equal(runtime.entityRefreshAt({}, 2000, mapping, 9000), 2000 + 5 * 60000);
  // No live face and no live fields → genuinely nothing to schedule.
  assert.equal(runtime.entityRefreshAt({}, null, { fields: [] }, 1000), null);
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

test("a face render error does not block the field refresh (prices keep flowing)", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "face-isolate" } });
  const mapping = {
    input: { connector: "crypto" }, identity: { from: "connector" },
    face: { from: "connector", producer: "chart", period: "1y", live: true, every: 1 },
    fields: [{ key: "price", kind: "number", from: "connector", fn: "price", live: true, every: 1 }],
  };
  assert.equal((await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } })).status, 200);
  const boardRow = await getBoard(db, board.id);
  const eid = await createEntity(db, board.id, { identity: "btc", symbol: "BTC", displayName: "Bitcoin", fields: { price: { v: 100, kind: "number", at: 0 } } });
  await db.query("UPDATE entities SET face_at=0 WHERE id=$1", [eid]); // face due
  const instId = await insertItem(db, board.id, { identity: "btc", files: [], fields: {}, mapping: boardRow.mapping, source: { provider: "coingecko", id: "bitcoin" } }, "tagged", eid);

  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("market_chart")) return { ok: false, status: 500, text: async () => "", json: async () => ({}) };       // face fails
    if (String(url).includes("coingecko.com") && String(url).includes("/coins/"))                                                    // price ok
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "bitcoin", name: "Bitcoin", symbol: "btc", market_data: { current_price: { usd: 130 }, market_cap: { usd: 1e12 }, price_change_percentage_24h: 1 } }) };
    return original(url, opts);
  };
  let r;
  try {
    const entity = await getEntity(db, eid);
    const { rows: [inst] } = await db.query("SELECT id, payload FROM items WHERE id=$1", [instId]);
    r = await refreshDueEntity(db, { entity, inst, board: boardRow }, 10 * 60000, { galleryDir, thumbsDir });
  } finally { globalThis.fetch = original; }

  assert.deepEqual(r.moved, ["price"]);                             // price refreshed despite the face error
  assert.equal(r.faced, false);
  assert.equal((await getEntity(db, eid)).fields.price.v, 130);
});

test("refreshDueEntity: a face-only board stays scheduled when the render is unavailable (CMC)", async () => {
  await setSetting(db, "crypto_provider", "coinmarketcap"); // no history() → face can't render
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "face-only-cmc" } });
  const mapping = {
    input: { connector: "crypto" }, identity: { from: "connector" },
    face: { from: "connector", producer: "chart", period: "1y", live: true, every: 1 },
    fields: [{ key: "price", kind: "number", from: "connector", fn: "price" }], // NOT live → face is the only live term
  };
  assert.equal((await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } })).status, 200);
  const boardRow = await getBoard(db, board.id);
  const eid = await createEntity(db, board.id, { identity: "eth", symbol: "ETH", displayName: "Ethereum", fields: { price: { v: 100, kind: "number", at: 0 } } });
  const instId = await insertItem(db, board.id, { identity: "eth", files: [], fields: {}, mapping: boardRow.mapping, source: { provider: "coinmarketcap", id: "1027" } }, "tagged", eid);

  const entity = await getEntity(db, eid);
  const { rows: [inst] } = await db.query("SELECT id, payload FROM items WHERE id=$1", [instId]);
  const now = 10 * 60000;
  const r = await refreshDueEntity(db, { entity, inst, board: boardRow }, now, { galleryDir, thumbsDir });
  assert.equal(r.faced, false);                                       // CMC couldn't render
  const e2 = await getEntity(db, eid);
  assert.equal(e2.face_at, null);                                     // still no face
  assert.equal(Number(e2.refresh_at), now + 60000);                  // but retried one cadence out, not dormant
  await setSetting(db, "crypto_provider", null);
});

// ── rate limiter / 429 backoff ───────────────────────────────────────────────

test("callProvider retries a 429 (honoring Retry-After) and surfaces other errors", async () => {
  const fast = { rpm: 100000, burst: 100 }; // effectively unthrottled for the test
  let calls = 0;
  const res = await runtime.callProvider("rl-retry", fast, async () => {
    calls++;
    if (calls === 1) { const e = new Error("rate limited"); e.status = 429; e.retryAfter = "0"; throw e; }
    return "ok";
  });
  assert.equal(res, "ok");
  assert.equal(calls, 2); // retried once

  await assert.rejects(
    runtime.callProvider("rl-other", fast, async () => { const e = new Error("boom"); e.status = 500; throw e; }),
    /boom/
  ); // non-429 propagates immediately
});

test("withRetry caps a huge Retry-After instead of honoring it verbatim", async () => {
  const fast = { rpm: 100000, burst: 100 };
  process.env.CONNECTOR_RETRY_CAP_MS = "30";
  try {
    let calls = 0;
    const t0 = Date.now();
    const res = await runtime.callProvider("rl-cap", fast, async () => {
      calls++;
      if (calls === 1) { const e = new Error("rate limited"); e.status = 429; e.retryAfter = "3600"; throw e; }
      return "ok";
    });
    assert.equal(res, "ok");
    assert.equal(calls, 2);
    assert.ok(Date.now() - t0 < 5000, "an hour of Retry-After must not be slept out inside the tick");
  } finally {
    delete process.env.CONNECTOR_RETRY_CAP_MS;
  }
});

test("connector fetches carry an outbound deadline", async () => {
  const original = globalThis.fetch;
  let signal;
  globalThis.fetch = async (url, opts) => {
    signal = opts?.signal;
    return { ok: true, status: 200, json: async () => ({ coins: [] }) };
  };
  try {
    await coingecko.search("btc", {});
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(signal instanceof AbortSignal, "provider fetch must pass an AbortSignal");
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

test("POST entities with auto-tag off → face leg anyway, parked", async () => {
  // The face is part of the item's definition — it renders even when tagging
  // is off; `park` makes the face leg park the item in held afterwards.
  const board = await faceBoard("face-route-off");
  await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { auto_tag: false } });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("coingecko.com") && String(url).includes("/coins/")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id: "ethereum", name: "Ethereum", symbol: "eth", market_data: { current_price: { usd: 3000 }, market_cap: { usd: 1e11 }, price_change_percentage_24h: 1 } }) };
    }
    return original(url, opts);
  };
  try {
    const r = await req(base, "POST", `/api/boards/${board.id}/entities`, { sid: admin.sid, body: { connector: "crypto", id: "ethereum" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "pending_face");
    const { rows: [row] } = await db.query("SELECT payload FROM items WHERE id=$1", [r.json.instances[0].id]);
    assert.equal(row.payload.park, true);
  } finally { globalThis.fetch = original; }
});

test("reprocess: a connector vehicle restarts at the face leg (rendered or not)", async () => {
  // The chart is part of the definition — the card-level "full pipeline"
  // reprocess must re-enter the face leg, not skip to extract/tag. This is
  // also the only manual re-render path for a non-live face.
  const board = await faceBoard("face-reprocess");
  const { mapping } = await getBoard(db, board.id);

  // Unrendered vehicle (zero files — e.g. the provider had no history).
  const eid1 = await createEntity(db, board.id, { identity: "rp1", displayName: "RP1" });
  const bare = await insertItem(db, board.id, { identity: "rp1", files: [], fields: {}, mapping, extracted_at: 1, source: { provider: "coingecko", id: "rp1" } }, "tagged", eid1);
  // Rendered vehicle (generated chart file).
  const eid2 = await createEntity(db, board.id, { identity: "rp2", displayName: "RP2" });
  const rendered = await insertItem(db, board.id, { identity: "rp2", files: [{ name: "x", kind: "image", generated: true }], fields: {}, mapping, extracted_at: 1, source: { provider: "coingecko", id: "rp2" } }, "tagged", eid2);

  for (const eid of [eid1, eid2]) {
    assert.equal((await req(base, "POST", `/api/items/${eid}/reprocess`, { sid: admin.sid })).status, 200);
  }
  const status = async (id) => (await db.query("SELECT status FROM items WHERE id=$1", [id])).rows[0].status;
  assert.equal(await status(bare), "pending_face");
  assert.equal(await status(rendered), "pending_face");
});

test("advanceFaced: parked item returns to held; unparked flows to tagging", async () => {
  const board = await faceBoard("face-park");
  await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { auto_tag: false } });
  const { mapping } = await getBoard(db, board.id);

  const eid = await createEntity(db, board.id, { identity: "prk", displayName: "PRK" });
  const parked = await insertItem(db, board.id, { identity: "prk", files: [], fields: {}, mapping, source: { provider: "coingecko", id: "prk" }, park: true }, "facing", eid);
  await advanceFaced(db, parked);
  const { rows: [a] } = await db.query("SELECT status, payload FROM items WHERE id=$1", [parked]);
  assert.equal(a.status, "held");
  assert.equal(a.payload.park, undefined, "park is spent once the definition legs finish");
  assert.ok(a.payload.extracted_at > 0, "release must route to the tag leg, not re-extract");

  // No park = an explicit run (release/reprocess) — tags even with auto-tag off.
  const eid2 = await createEntity(db, board.id, { identity: "unp", displayName: "UNP" });
  const released = await insertItem(db, board.id, { identity: "unp", files: [], fields: {}, mapping, source: { provider: "coingecko", id: "unp" } }, "facing", eid2);
  await advanceFaced(db, released);
  const { rows: [b] } = await db.query("SELECT status FROM items WHERE id=$1", [released]);
  assert.equal(b.status, "pending");
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

test("refreshDueEntity renders the first face when a live face has none yet (face_at null)", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "face-firstrender" } });
  const mapping = {
    input: { connector: "crypto" }, identity: { from: "connector" },
    face: { from: "connector", producer: "chart", period: "24h", live: true, every: 5 },
    fields: [{ key: "price", kind: "number", from: "connector", fn: "price" }], // not live
  };
  assert.equal((await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } })).status, 200);
  const boardRow = await getBoard(db, board.id);
  const eid = await createEntity(db, board.id, { identity: "btc", symbol: "BTC", displayName: "Bitcoin", fields: { price: { v: 100, kind: "number", at: 0 } } });
  const instId = await insertItem(db, board.id, { identity: "btc", files: [], fields: {}, mapping: boardRow.mapping, source: { provider: "coingecko", id: "bitcoin" } }, "tagged", eid);

  const restore = stubHistory([[0, 100], [1, 120]]);
  try {
    const entity = await getEntity(db, eid);
    assert.equal(entity.face_at, null);                             // never rendered
    const { rows: [inst] } = await db.query("SELECT id, payload FROM items WHERE id=$1", [instId]);
    const r = await refreshDueEntity(db, { entity, inst, board: boardRow }, 10 * 60000, { galleryDir, thumbsDir });
    assert.equal(r.faced, true);                                    // first face rendered despite null face_at
    const { rows: [i2] } = await db.query("SELECT payload FROM items WHERE id=$1", [instId]);
    assert.equal(i2.payload.files[0].generated, true);
    assert.equal(Number((await getEntity(db, eid)).face_at), 10 * 60000);
  } finally { restore(); }
});

test("validateMapping: face slot rules", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "face-validate" } });
  const patch = (mapping) => req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } });
  const crypto = (face) => ({ input: { connector: "crypto" }, identity: { from: "connector" }, face, fields: [] });

  assert.equal((await patch(crypto({ from: "connector", producer: "chart", period: "1y", live: true, every: 60 }))).status, 200);
  assert.equal((await patch(crypto({ from: "raw" }))).status, 200);

  let r = await patch(crypto({ from: "connector", producer: "nope", period: "1y" }));
  assert.equal(r.status, 400); assert.match(r.json.error, /face producer/);

  r = await patch(crypto({ from: "connector", producer: "chart", period: "3h" }));
  assert.equal(r.status, 400); assert.match(r.json.error, /period/);

  // face on a non-connector board → rejected (no connector input).
  r = await patch({ identity: { from: "raw" }, face: { from: "connector", producer: "chart", period: "1y" }, fields: [] });
  assert.equal(r.status, 400); assert.match(r.json.error, /connector/);
});

// ── file-face selection (face normalization) ─────────────────────────────────

test("selectFace: prefer + pick over an entity's instances", () => {
  // Oldest→newest, as the listing orders them.
  const insts = [
    { name: "a", kind: "pdf" },
    { name: "b", kind: "image" },
    { name: "c", kind: "audio" },
  ];
  const face = (cfg) => selectFace(insts, cfg)?.name;

  // Default (absent / raw / connector cfg) → first (oldest).
  assert.equal(face(undefined), "a");
  assert.equal(face({ from: "file" }), "a");
  assert.equal(face({ from: "raw" }), "a");
  assert.equal(face({ from: "connector" }), "a");

  // pick.
  assert.equal(face({ from: "file", pick: "latest" }), "c");
  assert.equal(face({ from: "file", pick: "first" }), "a");

  // prefer maps granular kinds → families; picks within the matched pool.
  assert.equal(face({ from: "file", prefer: "image" }), "b");
  assert.equal(face({ from: "file", prefer: "document" }), "a"); // pdf ∈ document
  assert.equal(face({ from: "file", prefer: "audio", pick: "latest" }), "c");

  // prefer is a preference, not a filter — no match falls back to the full pool.
  assert.equal(selectFace([{ name: "x", kind: "image" }], { from: "file", prefer: "audio" })?.name, "x");

  // empty / missing.
  assert.equal(selectFace([], { from: "file" }), null);
  assert.equal(selectFace(null, { from: "file" }), null);
});

test("selectFace: the client mirror is byte-identical to the server", () => {
  // public/face-select.js hand-copies FACE_FAMILY + selectFace (build-less
  // frontend, no shared import). Extract both from source and assert they
  // match, so the pair can't silently drift — the one documented hazard of
  // the mirror.
  const pick = (src) => {
    const family = src.match(/const FACE_FAMILY = \{[^}]*\};/)[0];
    const fn = src.match(/function selectFace\(instances, faceCfg\) \{[\s\S]*?\n\}/)[0];
    return `${family}\n${fn}`;
  };
  const server = fs.readFileSync(new URL("../server/faces/select.js", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../public/face-select.js", import.meta.url), "utf8");
  assert.equal(pick(client), pick(server));
});

test("validateMapping: file-face slot rules", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "file-face-validate" } });
  const patch = (mapping) => req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } });
  const files = (face) => ({ identity: { from: "ai", hint: "the title" }, face, fields: [] });

  assert.equal((await patch(files({ from: "file" }))).status, 200);
  assert.equal((await patch(files({ from: "file", prefer: "image", pick: "latest" }))).status, 200);

  let r = await patch(files({ from: "file", prefer: "movie" }));
  assert.equal(r.status, 400); assert.match(r.json.error, /prefer/);

  r = await patch(files({ from: "file", pick: "random" }));
  assert.equal(r.status, 400); assert.match(r.json.error, /pick/);

  // A static file face has no producer/period/cadence.
  r = await patch(files({ from: "file", period: "1y" }));
  assert.equal(r.status, 400); assert.match(r.json.error, /file face/);

  // A file face on a connector board → rejected.
  r = await patch({ input: { connector: "crypto" }, identity: { from: "connector" }, face: { from: "file" }, fields: [] });
  assert.equal(r.status, 400); assert.match(r.json.error, /files board/);
});

test("listing: the item face follows mapping.face over a multi-instance entity", async () => {
  const { json: board } = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "file-face-listing" } });
  await req(base, "PATCH", `/api/admin/boards/${board.id}`, {
    sid: admin.sid, body: { mapping: { identity: { from: "ai", hint: "the title" }, face: { from: "file", prefer: "image", pick: "latest" }, fields: [] } },
  });
  const eid = await createEntity(db, board.id, { identity: "invoice-7", displayName: "Invoice 7" });
  // Two instances, oldest→newest: an image (older) then a pdf (newer).
  await insertItem(db, board.id, { identity: "invoice-7", files: [{ name: "scan.webp", kind: "image", w: 10, h: 10 }] }, "tagged", eid);
  await insertItem(db, board.id, { identity: "invoice-7", files: [{ name: "doc.webp", kind: "pdf", w: 20, h: 20 }] }, "tagged", eid);

  const list = async (mapping) => {
    if (mapping) await req(base, "PATCH", `/api/admin/boards/${board.id}`, { sid: admin.sid, body: { mapping } });
    const { items } = await listItems(db, admin.id, board.id);
    return items.find((i) => i.id === eid);
  };

  // prefer:image → the webp scan wins even though it's the older instance.
  assert.equal((await list()).name, "scan.webp");
  // prefer:document,pick:latest → the newer pdf.
  assert.equal((await list({ identity: { from: "ai", hint: "t" }, face: { from: "file", prefer: "document", pick: "latest" }, fields: [] })).name, "doc.webp");
  // No face config → first (oldest) instance, the legacy default.
  assert.equal((await list({ identity: { from: "ai", hint: "t" }, fields: [] })).name, "scan.webp");
});
