// Crypto connector (slice 5b): validateMapping connector extensions, connector
// list endpoint, entity creation route. `crypto` is the domain; CoinGecko is
// its default provider (mocked fetch — no live network calls). Identity is the
// lowercase symbol, provenance is the provider name.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import { createEntity, initDb } from "../server/db.js";
import { manifest } from "../server/connectors/crypto/index.js";

// ─── pure: connector manifest shape ──────────────────────────────────────────

test("crypto manifest: has required fields and a valid template", () => {
  assert.ok(manifest.label);
  assert.equal(manifest.category, "finance"); // groups the picker; display-only
  assert.ok(Array.isArray(manifest.fields) && manifest.fields.length > 0);
  // Every manifest field has key, kind, fn, label
  for (const f of manifest.fields) {
    assert.ok(f.key);
    assert.ok(f.kind);
    assert.ok(f.fn);
    assert.ok(f.label);
  }
  // At least the default provider is advertised.
  assert.ok(manifest.providers.some((p) => p.name === "coingecko" && p.needsKey === false));
  // Template is a valid mapping shape bound to the domain, not the provider.
  const t = manifest.template;
  assert.equal(t.input?.connector, "crypto");
  assert.equal(t.identity?.from, "connector");
  assert.ok(Array.isArray(t.fields));
  for (const f of t.fields) {
    assert.equal(f.from, "connector");
    assert.ok(f.fn);
  }
});

// ─── integration ─────────────────────────────────────────────────────────────

let srv, db, base, admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});

after(() => srv.close());

async function createBoard(name, extra = {}) {
  return req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name, ...extra } });
}
async function patchBoard(id, body) {
  return req(base, "PATCH", `/api/admin/boards/${id}`, { sid: admin.sid, body });
}

// ── validateMapping: connector extensions ────────────────────────────────────

test("mapping PATCH: input { connector: crypto } is valid", async () => {
  const { json: board } = await createBoard("conn-input-valid");
  const r = await patchBoard(board.id, {
    mapping: {
      input: { connector: "crypto" },
      identity: { from: "connector" },
      fields: [{ key: "price", kind: "number", from: "connector", fn: "price" }],
    },
  });
  assert.equal(r.status, 200);
});

test("mapping PATCH: unknown connector → 400", async () => {
  const { json: board } = await createBoard("conn-unknown");
  const r = await patchBoard(board.id, {
    mapping: { input: { connector: "fakecoin" }, identity: { from: "connector" }, fields: [] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /unknown connector/);
});

test("mapping PATCH: connector field without fn → 400", async () => {
  const { json: board } = await createBoard("conn-no-fn");
  const r = await patchBoard(board.id, {
    mapping: {
      input: { connector: "crypto" },
      identity: { from: "connector" },
      fields: [{ key: "price", kind: "number", from: "connector" }], // no fn
    },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /fn/);
});

test("mapping PATCH: full crypto template shape saves successfully", async () => {
  const { json: board } = await createBoard("conn-full-template");
  const r = await patchBoard(board.id, { mapping: manifest.template });
  assert.equal(r.status, 200);

  const got = await req(base, "GET", `/api/boards/${board.id}`, { sid: admin.sid });
  assert.equal(got.json.mapping?.input?.connector, "crypto");
  assert.equal(got.json.mapping?.identity?.from, "connector");
});

// ── GET /api/connectors ───────────────────────────────────────────────────────

test("GET /api/connectors: returns connector list with manifest", async () => {
  const r = await req(base, "GET", "/api/connectors", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  const cg = r.json.find((c) => c.name === "crypto");
  assert.ok(cg, "crypto connector in list");
  assert.equal(cg.label, "Crypto");
  assert.equal(cg.category, "finance");
  assert.ok(Array.isArray(cg.fields));
  assert.ok(cg.providers.some((p) => p.name === "coingecko"));
});

test("GET /api/connectors: requires auth", async () => {
  const r = await req(base, "GET", "/api/connectors");
  assert.equal(r.status, 401);
});

// ── POST /api/boards/:id/entities ────────────────────────────────────────────

test("POST /api/boards/:id/entities: creates connector entity with bound fields", async () => {
  const { json: board } = await createBoard("conn-entity-create");
  await patchBoard(board.id, { mapping: manifest.template });

  // Stub fetch so no real network call goes out.
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.includes("coingecko.com")) {
      return { ok: true, status: 200,
        json: async () => ({
          id: "bitcoin", name: "Bitcoin", symbol: "btc",
          market_data: {
            current_price: { usd: 50000 },
            market_cap: { usd: 1e12 },
            price_change_percentage_24h: -1.5,
          },
        }),
        text: async () => "",
      };
    }
    return original(url, opts);
  };

  try {
    const r = await req(base, "POST", `/api/boards/${board.id}/entities`, {
      sid: admin.sid,
      body: { connector: "crypto", id: "bitcoin" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.identity, "btc"); // lowercase symbol, not the provider id
    assert.equal(r.json.display_name, "Bitcoin");
    assert.equal(r.json.symbol, "BTC");
    assert.equal(r.json.kind, "connector");

    // Bound fields live on the entity row; src is the provider name.
    const { rows: [ent] } = await db.query("SELECT * FROM entities WHERE id=$1", [r.json.id]);
    assert.equal(ent.identity, "btc");
    assert.equal(ent.symbol, "BTC");
    assert.deepEqual(Object.keys(ent.fields).sort(), ["change_24h", "market_cap", "price", "url"]);
    assert.equal(ent.fields.price.src, "coingecko");
    assert.equal(ent.fields.price.kind, "number");
    assert.equal(ent.fields.price.v, 50000);

    // One file-less instance is the tag vehicle, queued straight to the tag leg;
    // it carries the provider handle for a future liveness re-fetch.
    const { rows } = await db.query("SELECT payload, status FROM items WHERE id=$1", [r.json.instances[0].id]);
    assert.equal(rows[0].status, "pending");
    assert.deepEqual(rows[0].payload.files, []);
    assert.deepEqual(rows[0].payload.fields, {});
    assert.deepEqual(rows[0].payload.source, { provider: "coingecko", id: "bitcoin" });
  } finally {
    globalThis.fetch = original;
  }
});

test("POST /api/boards/:id/entities: 409 on duplicate identity", async () => {
  const { json: board } = await createBoard("conn-entity-dup");
  await patchBoard(board.id, { mapping: manifest.template });

  // An entity keyed by the same symbol ("eth") already holds the slot.
  await createEntity(db, board.id, { identity: "eth" });

  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.includes("coingecko.com")) {
      return { ok: true, status: 200,
        json: async () => ({
          id: "ethereum", name: "Ethereum", symbol: "eth",
          market_data: { current_price: { usd: 3000 }, market_cap: { usd: 4e11 }, price_change_percentage_24h: 1.2 },
        }),
        text: async () => "",
      };
    }
    return original(url, opts);
  };
  try {
    const r = await req(base, "POST", `/api/boards/${board.id}/entities`, {
      sid: admin.sid,
      body: { connector: "crypto", id: "ethereum" },
    });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /already on this board/);
  } finally {
    globalThis.fetch = original;
  }
});

test("POST /api/boards/:id/entities: 400 when board has no connector mapping", async () => {
  const { json: board } = await createBoard("conn-entity-no-mapping");
  const r = await req(base, "POST", `/api/boards/${board.id}/entities`, {
    sid: admin.sid,
    body: { connector: "crypto", id: "bitcoin" },
  });
  assert.equal(r.status, 400);
});

// ── slice-5b migration (idempotent, run in initDb) ────────────────────────────

test("migration: coingecko boards + entities re-key to crypto/symbol", async () => {
  // Seed the pre-5b shape directly (validateMapping now rejects "coingecko",
  // so write the rows rather than going through the API): a board mapped to the
  // coingecko connector, an entity keyed by the CoinGecko id with a symbol set,
  // and its tag-vehicle instance carrying the stamped coingecko mapping.
  const { json: board } = await createBoard("mig-coingecko");
  const cgMapping = {
    input: { connector: "coingecko" },
    identity: { from: "connector" },
    fields: [{ key: "price", kind: "number", from: "connector", fn: "price" }],
  };
  await db.query("UPDATE boards SET mapping=$1 WHERE id=$2", [JSON.stringify(cgMapping), board.id]);
  const eid = await createEntity(db, board.id, { identity: "litecoin", symbol: "LTC", displayName: "Litecoin" });
  await db.query(
    "INSERT INTO items (board_id, entity_id, payload, status, created_at, updated_at) VALUES ($1,$2,$3,'tagged',$4,$4)",
    [board.id, eid, JSON.stringify({ identity: "litecoin", files: [], fields: {}, mapping: cgMapping }), Date.now()]
  );

  await initDb(db); // idempotent; re-applies the crypto migration over the seeded rows

  const { rows: [b] } = await db.query("SELECT mapping FROM boards WHERE id=$1", [board.id]);
  assert.equal(b.mapping.input.connector, "crypto"); // board mapping renamed
  const { rows: [e] } = await db.query("SELECT identity FROM entities WHERE id=$1", [eid]);
  assert.equal(e.identity, "ltc"); // identity re-keyed to the lowercase symbol
  const { rows: [i] } = await db.query("SELECT payload FROM items WHERE entity_id=$1", [eid]);
  assert.deepEqual(i.payload.source, { provider: "coingecko", id: "litecoin" }); // handle captured

  // Idempotent: a second pass changes nothing.
  await initDb(db);
  const { rows: [e2] } = await db.query("SELECT identity FROM entities WHERE id=$1", [eid]);
  assert.equal(e2.identity, "ltc");
});
