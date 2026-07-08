// Crypto connector (slice 5b): validateMapping connector extensions, connector
// list endpoint, entity creation route. `crypto` is the domain; CoinGecko is
// its default provider (mocked fetch — no live network calls). Identity is the
// lowercase symbol, provenance is the provider name.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, req } from "./helpers.js";
import { createEntity, initDb, setSetting } from "../server/db.js";
import { manifest } from "../server/connectors/crypto/index.js";
import * as runtime from "../server/connectors/runtime.js";

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

// ── runtime: domain-agnostic dispatch (not crypto-shaped) ─────────────────────
// Drive a throwaway connector with two in-memory providers through the shared
// runtime the same way crypto does. Proves adding a domain needs zero runtime
// edits: settings are namespaced by the connector's own name, keys live in
// per-provider slots, and an unknown/unset provider falls back to the default.
test("runtime: generic domain×provider dispatch over an arbitrary connector", async () => {
  const calls = [];
  const mk = (label, needsKey) => ({
    label, needsKey,
    async search(q, { apiKey }) { calls.push(["search", label, q, apiKey]); return [{ id: q }]; },
    async fetchEntity(id, { apiKey }) {
      calls.push(["fetch", label, id, apiKey]);
      return { id, symbol: id.toUpperCase(), display_name: id, fields: { qty: { v: 1, kind: "number" } } };
    },
    async testConnection({ apiKey }) { calls.push(["test", label, apiKey]); return true; },
  });
  const acme = mk("Acme", false);
  const globex = mk("Globex", true);
  const conn = { name: "widgets", providers: { acme, globex }, defaultProvider: "acme", manifest: {} };

  // Unset provider → the connector's own default; an unknown value falls back too.
  assert.equal((await runtime.activeProvider(db, conn)).name, "acme");
  await setSetting(db, "widgets_provider", "nope");
  assert.equal((await runtime.activeProvider(db, conn)).name, "acme");
  await setSetting(db, "widgets_provider", "globex");
  assert.equal((await runtime.activeProvider(db, conn)).name, "globex");

  // Keys live in per-provider slots (<name>_key_<provider>) and don't bleed.
  await setSetting(db, "widgets_key_acme", "acme-key");
  assert.equal((await runtime.activeProvider(db, conn)).apiKey, null); // active=globex, no key yet
  await setSetting(db, "widgets_key_globex", "globex-key");
  const active = await runtime.activeProvider(db, conn);
  assert.equal(active.apiKey, "globex-key");

  // search/fetch dispatch to the active provider with its key; the runtime
  // derives identity from the symbol and stamps src + at on every field.
  await runtime.search(db, conn, "gizmo");
  const now = 1234;
  const e = await runtime.fetchEntity(db, conn, "gizmo", now);
  assert.equal(e.identity, "gizmo");                              // "GIZMO".toLowerCase()
  assert.deepEqual(e.source, { provider: "globex", id: "gizmo" });
  assert.deepEqual(e.fields.qty, { v: 1, kind: "number", src: "globex", at: now });
  assert.ok(calls.some(([op, l, , k]) => op === "search" && l === "Globex" && k === "globex-key"));
  assert.ok(calls.some(([op, l, , k]) => op === "fetch" && l === "Globex" && k === "globex-key"));

  // testConnection honours a provider override with that provider's stored key,
  // regardless of which one is active.
  const t = await runtime.testConnection(db, conn, { provider: "acme" });
  assert.equal(t.provider, "acme");
  assert.ok(calls.some(([op, l, k]) => op === "test" && l === "Acme" && k === "acme-key"));
});

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

// ── slice-5b Phase 2: second provider + admin connector config ────────────────
// These mutate app-global settings (crypto_provider/crypto_api_key), so they run
// last; earlier tests rely on the unset default (coingecko).

test("crypto manifest advertises CoinMarketCap as a keyed provider", () => {
  const cmc = manifest.providers.find((p) => p.name === "coinmarketcap");
  assert.ok(cmc, "coinmarketcap in providers");
  assert.equal(cmc.label, "CoinMarketCap");
  assert.equal(cmc.needsKey, true);
});

test("GET /api/admin/connectors: shape, default provider, no key echo", async () => {
  const r = await req(base, "GET", "/api/admin/connectors", { sid: admin.sid });
  assert.equal(r.status, 200);
  const cx = r.json.find((c) => c.name === "crypto");
  assert.ok(cx);
  assert.equal(cx.category, "finance");
  assert.equal(cx.activeProvider, "coingecko"); // default when the setting is unset
  assert.equal(cx.keys.coingecko, false);
  assert.equal(cx.keys.coinmarketcap, false);
  assert.ok(cx.providers.some((p) => p.name === "coinmarketcap" && p.needsKey));
  assert.ok(!JSON.stringify(r.json).includes("api_key")); // presence only, never the value
});

test("GET /api/admin/connectors: requires admin", async () => {
  const u = await seedUser(db, "member-conn@test.local");
  const r = await req(base, "GET", "/api/admin/connectors", { sid: u.sid });
  assert.equal(r.status, 403);
});

test("POST /api/admin/connectors: validates provider and enforces the key", async () => {
  let r = await req(base, "POST", "/api/admin/connectors/crypto", { sid: admin.sid, body: { provider: "nope" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /provider must be one of/);

  // Keyed provider with no key stored → rejected.
  r = await req(base, "POST", "/api/admin/connectors/crypto", { sid: admin.sid, body: { provider: "coinmarketcap" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /needs an API key/);

  // Keyed provider with a key → stored (never echoed).
  r = await req(base, "POST", "/api/admin/connectors/crypto", { sid: admin.sid, body: { provider: "coinmarketcap", api_key: "cmc-test-key" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.activeProvider, "coinmarketcap");
  assert.equal(r.json.hasKey, true);

  const g = await req(base, "GET", "/api/admin/connectors", { sid: admin.sid });
  const cx = g.json.find((c) => c.name === "crypto");
  assert.equal(cx.activeProvider, "coinmarketcap");
  assert.equal(cx.keys.coinmarketcap, true);
  assert.equal(cx.keys.coingecko, false); // per-provider slots don't bleed
});

test("POST entities via CoinMarketCap: identical canonical fields, src=coinmarketcap", async () => {
  await req(base, "POST", "/api/admin/connectors/crypto", { sid: admin.sid, body: { provider: "coinmarketcap", api_key: "cmc-test-key" } });
  const { json: board } = await createBoard("conn-cmc");
  await patchBoard(board.id, { mapping: manifest.template });

  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.includes("coinmarketcap.com")) {
      return { ok: true, status: 200,
        json: async () => ({
          status: { error_code: 0 },
          data: { "5426": {
            id: 5426, name: "Solana", symbol: "SOL", slug: "solana",
            quote: { USD: { price: 150, market_cap: 7e10, percent_change_24h: 2.3 } },
          } },
        }),
        text: async () => "",
      };
    }
    return original(url, opts);
  };
  try {
    const r = await req(base, "POST", `/api/boards/${board.id}/entities`, {
      sid: admin.sid, body: { connector: "crypto", id: "5426" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.identity, "sol"); // identity is the symbol regardless of backend
    assert.equal(r.json.symbol, "SOL");

    const { rows: [ent] } = await db.query("SELECT * FROM entities WHERE id=$1", [r.json.id]);
    // Same canonical field set as CoinGecko — the whole point of the split.
    assert.deepEqual(Object.keys(ent.fields).sort(), ["change_24h", "market_cap", "price", "url"]);
    assert.equal(ent.fields.price.src, "coinmarketcap"); // provenance follows the actual source
    assert.equal(ent.fields.price.v, 150);
    assert.equal(ent.fields.url.v, "https://coinmarketcap.com/currencies/solana/");

    const { rows } = await db.query("SELECT payload FROM items WHERE id=$1", [r.json.instances[0].id]);
    assert.deepEqual(rows[0].payload.source, { provider: "coinmarketcap", id: "5426" });
  } finally {
    globalThis.fetch = original;
  }
});

test("POST connectors: CoinGecko takes an optional key; slots stay per-provider", async () => {
  // A CoinMarketCap key is already stored (earlier test). Saving a CoinGecko
  // key must land in its own slot without disturbing CMC's.
  const r = await req(base, "POST", "/api/admin/connectors/crypto", {
    sid: admin.sid, body: { provider: "coingecko", api_key: "cg-demo-key" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.activeProvider, "coingecko"); // keyless provider switches fine, key or not
  assert.equal(r.json.hasKey, true);

  const g = await req(base, "GET", "/api/admin/connectors", { sid: admin.sid });
  const cx = g.json.find((c) => c.name === "crypto");
  assert.equal(cx.keys.coingecko, true);
  assert.equal(cx.keys.coinmarketcap, true); // CMC key preserved, not clobbered
});

test("POST connectors/:name/test: honors the selected provider, not the active one", async () => {
  // Active provider is CoinGecko here; testing CoinMarketCap must ping CMC and
  // name it — the bug was that Test reported whatever was active/saved.
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url.includes("coingecko.com/api/v3/ping"))
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    if (url.includes("coinmarketcap.com") && url.includes("key/info"))
      return { ok: true, status: 200, json: async () => ({ status: { error_code: 0 }, data: {} }), text: async () => "" };
    return original(url, opts);
  };
  try {
    let r = await req(base, "POST", "/api/admin/connectors/crypto/test", { sid: admin.sid, body: { provider: "coingecko" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, "coingecko");

    r = await req(base, "POST", "/api/admin/connectors/crypto/test", { sid: admin.sid, body: { provider: "coinmarketcap", api_key: "typed-key" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, "coinmarketcap");
  } finally {
    globalThis.fetch = original;
  }
});
