// Crypto connector (slice 5b): validateMapping connector extensions, connector
// list endpoint, entity creation route. `crypto` is the domain; CoinGecko is
// its default provider (mocked fetch — no live network calls). Identity is the
// lowercase symbol, provenance is the provider name.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, req, installConnectors, withLegacyEntityId } from "./helpers.js";
import { createEntity, setSetting, getSetting, setPluginState } from "../server/db.js";
import { up as coingeckoToCrypto } from "../server/migrations/0007_coingecko_to_crypto.js";
import { manifest } from "../server/connectors/crypto/index.js";
import * as runtime from "../server/connectors/runtime.js";
import * as coingecko from "../server/connectors/crypto/coingecko.js";
import * as coinmarketcap from "../server/connectors/crypto/coinmarketcap.js";

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
  // Add the connectors these tests drive (default posture is available-not-added).
  await installConnectors(db, "crypto:coingecko", "crypto:coinmarketcap", "stocks:financialmodelingprep");
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
  await installConnectors(db, "widgets:acme", "widgets:globex"); // both added

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

// ── runtime: call-class budgets + readable timeouts ──────────────────────────

test("provider budgets: interactive vs bulk, env-tunable per call", () => {
  assert.equal(runtime.providerBudgetMs(), 15000);
  assert.equal(runtime.providerBudgetMs("bulk"), 60000);
  process.env.CONNECTOR_TIMEOUT_MS = "111";
  process.env.CONNECTOR_BULK_TIMEOUT_MS = "222";
  try {
    assert.equal(runtime.providerBudgetMs(), 111);
    assert.equal(runtime.providerBudgetMs("bulk"), 222);
  } finally {
    delete process.env.CONNECTOR_TIMEOUT_MS;
    delete process.env.CONNECTOR_BULK_TIMEOUT_MS;
  }
});

test("callProvider renames a bare TimeoutError after the provider, status-less", async () => {
  const fast = { rpm: 100000, burst: 100 };
  await assert.rejects(
    runtime.callProvider("acme-t", fast, async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }),
    (e) => {
      assert.equal(e.message, "acme-t: request timed out"); // never the bare DOMException text
      assert.equal(e.status, undefined);                    // status-less → withRetry never retries it
      return true;
    }
  );
  // Non-timeout errors pass through untouched (429 retry behavior is covered
  // in faces.test.js).
  await assert.rejects(
    runtime.callProvider("acme-t", fast, async () => { const e = new Error("boom"); e.status = 500; throw e; }),
    /boom/
  );
});

// ── runtime: field-aware refresh (provider fetchFields capability) ───────────

// A provider serving the due keys from fetchFields spares the whole-object
// fetch; a partial answer (any due key missing) falls back to fetchEntity so
// a field can never be stranded due-forever.
test("refresh: fetchFields serves the due keys; partial coverage falls back whole-object", async () => {
  const ffCalls = [], feCalls = [];
  const meter = {
    label: "Meter",
    async fetchFields(id, keys, { apiKey }) {
      ffCalls.push([id, [...keys]]);
      return { fields: { price: { v: 2, kind: "number" }, volume: { v: 9, kind: "number" } } };
    },
    async fetchEntity(id) {
      feCalls.push(id);
      return {
        id, symbol: "GG", display_name: "Gauge",
        fields: {
          price: { v: 3, kind: "number" }, volume: { v: 8, kind: "number" },
          sector: { v: "Widgets", kind: "text" },
        },
      };
    },
  };
  const conn = { name: "gauges", providers: { meter }, defaultProvider: "meter", manifest: {} };
  await installConnectors(db, "gauges:meter");

  const entity = {
    id: 1, symbol: "GG",
    fields: {
      price: { v: 1, kind: "number", at: 0 },
      volume: { v: 7, kind: "number", at: 0 },
      sector: { v: "old", kind: "text", at: 0 },
    },
  };
  const inst = { payload: { source: { provider: "meter", id: "gg" } } };
  const live = (keys) => ({
    fields: keys.map((key) => ({ key, from: "connector", fn: key, live: true, every: 1 })),
  });
  const now = 120000; // both fields due (at=0, every=1min)

  // Full coverage → fetchFields path, no whole-object fetch.
  const r1 = await runtime.refresh(db, conn, entity, inst, live(["price", "volume"]), now);
  assert.deepEqual(ffCalls, [["gg", ["price", "volume"]]]);
  assert.equal(feCalls.length, 0);
  assert.deepEqual(r1.merged.price, { v: 2, kind: "number", src: "meter", at: now });
  assert.deepEqual(r1.moved.price, { v: 2, kind: "number", src: "meter", at: now }); // 1 → 2 moved
  assert.equal(r1.merged.sector.v, "old"); // non-due fields untouched
  assert.equal(r1.next, now + 60000);

  // sector due too, but fetchFields doesn't produce it → whole-object fallback.
  const r2 = await runtime.refresh(db, conn, entity, inst, live(["price", "volume", "sector"]), now);
  assert.equal(feCalls.length, 1);
  assert.deepEqual(r2.merged.sector, { v: "Widgets", kind: "text", src: "meter", at: now });
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

// The template picker lists every domain, so it needs to know which of them can
// actually serve — and a domain that can't must not take the catalog down with
// it, which is exactly what un-added FMP once did (activeProvider throws; the
// route 500'd; the client toasted "No connectors available" at a Crypto that
// was fine all along).
test("GET /api/connectors: an un-added domain reports unavailable without sinking the catalog", async () => {
  await setPluginState(db, "stocks:financialmodelingprep", { installed: false });
  try {
    const r = await req(base, "GET", "/api/connectors", { sid: admin.sid });
    assert.equal(r.status, 200);
    const st = r.json.find((c) => c.name === "stocks");
    assert.equal(st.available, false);
    assert.equal(st.reason, "no Stocks provider is installed");
    assert.equal(st.activeProvider, null);
    assert.ok(st.template, "still listed with its template — a shape you may pick");
    // The whole point: the sibling domain is untouched.
    const cg = r.json.find((c) => c.name === "crypto");
    assert.equal(cg.available, true);
    assert.equal(cg.reason, undefined); // nothing to explain about a healthy domain
  } finally {
    await setPluginState(db, "stocks:financialmodelingprep", { installed: true });
  }
});

test("GET /api/connectors: an installed-but-keyless provider is unavailable too", async () => {
  // FMP resolves as the active provider (activeProvider ignores keys), so
  // `activeProvider != null` is NOT the availability question — every call
  // would still fail on the missing key.
  const r = await req(base, "GET", "/api/connectors", { sid: admin.sid });
  const st = r.json.find((c) => c.name === "stocks");
  assert.equal(st.activeProvider, "financialmodelingprep");
  assert.equal(st.available, false);
  assert.equal(st.reason, "Financial Modeling Prep needs an API key");
});

// `available` is a fact about the board (its data isn't flowing); the reason is
// a fact about the deployment (which provider is installed, whether it holds a
// key). The second belonged to /api/admin/* before this route learned to answer
// the first, and it stays there.
test("GET /api/connectors: the outage REASON is admin-only, the availability isn't", async () => {
  const member = await seedUser(db, "conn-avail-member@test.local");
  const r = await req(base, "GET", "/api/connectors", { sid: member.sid });
  assert.equal(r.status, 200);
  const st = r.json.find((c) => c.name === "stocks");
  assert.equal(st.available, false, "a member still learns the board can't fetch");
  assert.equal(st.reason, undefined, "but not which provider, nor that it wants a key");
  // Nothing anywhere in the member's payload names the key state.
  assert.ok(!JSON.stringify(r.json).includes("needs an API key"));
});

// ── domainState: the shared ladder ───────────────────────────────────────────
// Pure, so the four rungs are pinned here rather than inferred from two
// surfaces. Both the capabilities card and /api/connectors read this.

test("domainState: the four rungs, and which of them can still serve", () => {
  const domain = { label: "Stocks", providers: [{ name: "fmp", label: "FMP" }, { name: "alt", label: "Alt" }] };
  const eff = (name, needsKey, apiKey) => ({ name, provider: { needsKey }, apiKey });

  assert.deepEqual(runtime.domainState({ setting: null, effective: null }, domain),
    { state: "unavailable", reason: "no Stocks provider is installed", available: false });

  assert.deepEqual(runtime.domainState({ setting: null, effective: eff("fmp", true, "k") }, domain),
    { state: "active", reason: null, available: true });

  // The sibling scan took over: still serving, so still a usable template —
  // the dead star is the Plugins page's story, not the picker's.
  assert.deepEqual(runtime.domainState({ setting: "fmp", effective: eff("alt", false, null) }, domain),
    { state: "degraded", reason: "FMP can't serve — Alt took over", available: true });

  assert.deepEqual(runtime.domainState({ setting: "fmp", effective: eff("fmp", true, null) }, domain),
    { state: "blocked", reason: "FMP needs an API key", available: false });
});

test("domainState: an unknown provider name falls back to itself as the label", () => {
  const domain = { label: "Stocks", providers: [] };
  const { reason } = runtime.domainState(
    { setting: null, effective: { name: "ghost", provider: { needsKey: true }, apiKey: null } },
    domain
  );
  assert.equal(reason, "ghost needs an API key");
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

    // One file-less instance is the tag vehicle; it carries the provider handle
    // for a future liveness re-fetch. It starts at the FACE leg because the
    // template faces the price chart (the symbol tile is only its fallback), so
    // the chart is rendered before the tagger ever sees the card.
    const { rows } = await db.query("SELECT payload, status FROM items WHERE id=$1", [r.json.instances[0].id]);
    assert.equal(rows[0].status, "pending_face");
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

// ── browse-and-add: the agnostic ingestion contract ──────────────────────────

test("crypto manifest + /api/connectors expose the browse descriptor", async () => {
  assert.ok(manifest.browse);
  assert.ok(manifest.browse.columns.length && manifest.browse.sorts.length);
  assert.ok(manifest.browse.columns.every((c) => c.key && c.label && c.kind));
  assert.ok(manifest.browse.sorts.every((s) => s.key && s.label));

  const r = await req(base, "GET", "/api/connectors", { sid: admin.sid });
  const cg = r.json.find((c) => c.name === "crypto");
  assert.ok(cg.browse, "browse descriptor served to the client");
  assert.deepEqual(cg.browse.columns.map((c) => c.key), manifest.browse.columns.map((c) => c.key));
});

test("GET /api/connectors: face availability follows the active provider's capabilities", async () => {
  const prev = await getSetting(db, "crypto_provider");
  try {
    // CoinGecko (has history) → chart face available; CMC (no history) → not.
    await setSetting(db, "crypto_provider", "coingecko");
    let r = await req(base, "GET", "/api/connectors", { sid: admin.sid });
    let cg = r.json.find((c) => c.name === "crypto");
    assert.equal(cg.activeProvider, "coingecko");
    let chart = cg.faces.find((f) => f.name === "chart");
    assert.equal(chart.available, true);
    assert.deepEqual(chart.supportedBy, ["coingecko"]); // only the history-capable provider

    await setSetting(db, "crypto_provider", "coinmarketcap");
    r = await req(base, "GET", "/api/connectors", { sid: admin.sid });
    cg = r.json.find((c) => c.name === "crypto");
    assert.equal(cg.activeProvider, "coinmarketcap");
    chart = cg.faces.find((f) => f.name === "chart");
    assert.equal(chart.available, false); // CMC has no history() → tile fallback
  } finally {
    await setSetting(db, "crypto_provider", prev);
  }
});

test("runtime.list: dispatches with opts + key; a provider without list() yields []", async () => {
  const seen = [];
  const withList = {
    label: "WL",
    async list(opts, { apiKey }) { seen.push([opts, apiKey]); return [{ id: "a", symbol: "A", label: "Ay", values: { x: 1 } }]; },
    async search() { return []; }, async fetchEntity() { return {}; },
  };
  const conn = { name: "listconn", providers: { withList }, defaultProvider: "withList", manifest: {} };
  await installConnectors(db, "listconn:withList");
  await setSetting(db, "listconn_key_withList", "K");
  const rows = await runtime.list(db, conn, { sort: "x", order: "desc", page: 1, pageSize: 5, query: "" });
  assert.deepEqual(rows, [{ id: "a", symbol: "A", label: "Ay", values: { x: 1 } }]);
  assert.equal(seen[0][1], "K");        // apiKey threaded
  assert.equal(seen[0][0].sort, "x");

  const noList = { label: "NL", async search() { return []; }, async fetchEntity() { return {}; } };
  const conn2 = { name: "nolistconn", providers: { noList }, defaultProvider: "noList", manifest: {} };
  await installConnectors(db, "nolistconn:noList");
  assert.deepEqual(await runtime.list(db, conn2, {}), []); // no list() → graceful empty
});

test("coingecko.list: normalizes market rows and maps sort→order", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push(String(url));
    if (String(url).includes("/coins/markets")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ([
        { id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 65000, market_cap: 1.2e12, total_volume: 3e10, market_cap_rank: 1, price_change_percentage_24h: -1.5 },
      ]) };
    }
    return original(url, opts);
  };
  try {
    const rows = await coingecko.list({ sort: "market_cap", order: "desc", page: 1, pageSize: 50 });
    assert.deepEqual(rows[0], {
      id: "bitcoin", symbol: "BTC", label: "Bitcoin",
      values: { rank: 1, name: "Bitcoin", price: 65000, change_24h: -1.5, market_cap: 1.2e12, volume: 3e10 },
    });
    assert.ok(seen.some((u) => u.includes("order=market_cap_desc")));

    seen.length = 0;
    await coingecko.list({ sort: "volume", order: "asc", page: 1, pageSize: 50 });
    assert.ok(seen.some((u) => u.includes("order=volume_asc")));

    seen.length = 0;
    await coingecko.list({ sort: "price", order: "desc", page: 1, pageSize: 50 }); // unsupported → default
    assert.ok(seen.some((u) => u.includes("order=market_cap_desc")));
  } finally { globalThis.fetch = original; }
});

test("coingecko.list: a text query bridges /search → /coins/markets?ids", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push(String(url));
    if (String(url).includes("/search?query=")) return { ok: true, status: 200, text: async () => "", json: async () => ({ coins: [{ id: "bitcoin" }, { id: "bitcoin-cash" }] }) };
    if (String(url).includes("/coins/markets")) return { ok: true, status: 200, text: async () => "", json: async () => ([{ id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 1, market_cap: 2, total_volume: 3, market_cap_rank: 1, price_change_percentage_24h: 0 }]) };
    return original(url, opts);
  };
  try {
    const rows = await coingecko.list({ query: "bit", pageSize: 50 });
    assert.ok(seen.some((u) => u.includes("/search?query=")));
    assert.ok(seen.some((u) => u.includes("ids=bitcoin")));
    assert.equal(rows[0].symbol, "BTC");
  } finally { globalThis.fetch = original; }
});

test("coinmarketcap.list: normalizes rows and maps sort field", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push(String(url));
    if (String(url).includes("/listings/latest")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({ status: { error_code: 0 }, data: [
        { id: 1, name: "Bitcoin", symbol: "BTC", cmc_rank: 1, quote: { USD: { price: 65000, market_cap: 1.2e12, volume_24h: 3e10, percent_change_24h: -1.5 } } },
      ] }) };
    }
    return original(url, opts);
  };
  try {
    const rows = await coinmarketcap.list({ sort: "volume", order: "desc", page: 1, pageSize: 50 }, { apiKey: "k" });
    assert.deepEqual(rows[0], {
      id: "1", symbol: "BTC", label: "Bitcoin",
      values: { rank: 1, name: "Bitcoin", price: 65000, change_24h: -1.5, market_cap: 1.2e12, volume: 3e10 },
    });
    assert.ok(seen.some((u) => u.includes("sort=volume_24h")));
  } finally { globalThis.fetch = original; }
});

test("GET /api/boards/:id/connector-list: rows, on_board flag, 502, auth", async () => {
  const { json: board } = await createBoard("conn-browse");
  await patchBoard(board.id, { mapping: manifest.template });

  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/coins/markets")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ([
        { id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 65000, market_cap: 1.2e12, total_volume: 3e10, market_cap_rank: 1, price_change_percentage_24h: -1.5 },
        { id: "ethereum", symbol: "eth", name: "Ethereum", current_price: 3000, market_cap: 4e11, total_volume: 1e10, market_cap_rank: 2, price_change_percentage_24h: 1.2 },
      ]) };
    }
    return original(url, opts);
  };
  try {
    let r = await req(base, "GET", `/api/boards/${board.id}/connector-list`); // no session
    assert.equal(r.status, 401);

    r = await req(base, "GET", `/api/boards/${board.id}/connector-list?sort=market_cap`, { sid: admin.sid });
    assert.equal(r.status, 200);
    assert.equal(r.json.rows.length, 2);
    assert.equal(r.json.hasMore, false);
    assert.deepEqual(Object.keys(r.json.rows[0].values).sort(), ["change_24h", "market_cap", "name", "price", "rank", "volume"]);
    assert.equal(r.json.rows.every((x) => x.on_board === false), true);

    // an existing entity marks only its own row
    await createEntity(db, board.id, { identity: "btc", symbol: "BTC", displayName: "Bitcoin" });
    r = await req(base, "GET", `/api/boards/${board.id}/connector-list?sort=market_cap`, { sid: admin.sid });
    assert.equal(r.json.rows.find((x) => x.symbol === "BTC").on_board, true);
    assert.equal(r.json.rows.find((x) => x.symbol === "ETH").on_board, false);
  } finally { globalThis.fetch = original; }

  // provider error → 502
  const orig2 = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/coins/markets")) return { ok: false, status: 500, text: async () => "", json: async () => ({}) };
    return orig2(url, opts);
  };
  try {
    const r = await req(base, "GET", `/api/boards/${board.id}/connector-list`, { sid: admin.sid });
    assert.equal(r.status, 502);
  } finally { globalThis.fetch = orig2; }
});

test("GET /api/boards/:id/connector-list: 400 when the board has no connector input", async () => {
  const { json: board } = await createBoard("conn-browse-nomap");
  const r = await req(base, "GET", `/api/boards/${board.id}/connector-list`, { sid: admin.sid });
  assert.equal(r.status, 400);
});

test("POST /api/boards/:id/entities/bulk: adds many, skips duplicates, caps, mismatch", async () => {
  const { json: board } = await createBoard("conn-bulk");
  await patchBoard(board.id, { mapping: manifest.template });

  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("coingecko.com") && u.includes("/coins/") && !u.includes("markets")) {
      const id = u.match(/\/coins\/([^?]+)/)[1];
      const map = { bitcoin: { symbol: "btc", name: "Bitcoin", price: 65000 }, ethereum: { symbol: "eth", name: "Ethereum", price: 3000 } };
      const m = map[id] || { symbol: id, name: id, price: 1 };
      return { ok: true, status: 200, text: async () => "", json: async () => ({ id, name: m.name, symbol: m.symbol, market_data: { current_price: { usd: m.price }, market_cap: { usd: 1e11 }, price_change_percentage_24h: 0 } }) };
    }
    return original(url, opts);
  };
  try {
    let r = await req(base, "POST", `/api/boards/${board.id}/entities/bulk`, { sid: admin.sid, body: { connector: "crypto", ids: ["bitcoin", "ethereum"] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.added.length, 2);
    assert.equal(r.json.skipped.length, 0);

    r = await req(base, "POST", `/api/boards/${board.id}/entities/bulk`, { sid: admin.sid, body: { connector: "crypto", ids: ["bitcoin"] } });
    assert.equal(r.json.added.length, 0);
    assert.deepEqual(r.json.skipped, [{ id: "bitcoin", reason: "duplicate" }]);

    r = await req(base, "POST", `/api/boards/${board.id}/entities/bulk`, { sid: admin.sid, body: { connector: "crypto", ids: Array.from({ length: 101 }, (_, i) => String(i)) } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /at most/);

    r = await req(base, "POST", `/api/boards/${board.id}/entities/bulk`, { sid: admin.sid, body: { connector: "stocks", ids: ["x"] } });
    assert.equal(r.status, 400);
  } finally { globalThis.fetch = original; }
});

// ── slice-5b migration (0007_coingecko_to_crypto, idempotent) ─────────────────

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
    "INSERT INTO items (board_id, entity_ids, payload, status, created_at, updated_at) VALUES ($1,ARRAY[$2]::bigint[],$3,'tagged',$4,$4)",
    [board.id, eid, JSON.stringify({ identity: "litecoin", files: [], fields: {}, mapping: cgMapping }), Date.now()]
  );

  await withLegacyEntityId(db, () => coingeckoToCrypto(db)); // re-applies the crypto migration over the seeded rows

  const { rows: [b] } = await db.query("SELECT mapping FROM boards WHERE id=$1", [board.id]);
  assert.equal(b.mapping.input.connector, "crypto"); // board mapping renamed
  const { rows: [e] } = await db.query("SELECT identity FROM entities WHERE id=$1", [eid]);
  assert.equal(e.identity, "ltc"); // identity re-keyed to the lowercase symbol
  const { rows: [i] } = await db.query("SELECT payload FROM items WHERE entity_ids @> ARRAY[$1]::bigint[]", [eid]);
  assert.deepEqual(i.payload.source, { provider: "coingecko", id: "litecoin" }); // handle captured

  // Idempotent: a second pass changes nothing.
  await withLegacyEntityId(db, () => coingeckoToCrypto(db));
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

test("plugins catalog: connector shape, default provider, no key echo", async () => {
  const r = await req(base, "GET", "/api/admin/plugins", { sid: admin.sid });
  assert.equal(r.status, 200);
  const gecko = r.json.plugins.find((p) => p.id === "crypto:coingecko");
  assert.ok(gecko);
  assert.equal(gecko.connector.domainLabel, "Crypto");
  assert.equal(gecko.state.hasKey, false);
  const cmc = r.json.plugins.find((p) => p.id === "crypto:coinmarketcap");
  assert.equal(cmc.connector.needsKey, true);
  assert.equal(cmc.state.hasKey, false);
  // default when the setting is unset — the domain's star state lives on the
  // capabilities feed since 7c
  const caps = await req(base, "GET", "/api/admin/capabilities", { sid: admin.sid });
  const crypto = caps.json.capabilities.find((c) => c.id === "crypto");
  assert.equal(crypto.bound.provider, null);
  assert.equal(crypto.running.provider, "coingecko");
  assert.ok(!JSON.stringify(r.json).includes("cmc-test-key")); // presence only, never the value
});

test("plugins catalog: requires admin", async () => {
  const u = await seedUser(db, "member-conn@test.local");
  const r = await req(base, "GET", "/api/admin/plugins", { sid: u.sid });
  assert.equal(r.status, 403);
});

test("starring a domain default validates provider + key; PATCH stores the key", async () => {
  let r = await req(base, "POST", "/api/admin/plugins/slots/crypto", { sid: admin.sid, body: { provider: "nope" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /provider must be one of/);

  // Keyed provider with no key stored → can't be the default.
  r = await req(base, "POST", "/api/admin/plugins/slots/crypto", { sid: admin.sid, body: { provider: "coinmarketcap" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /needs an API key/);

  // Store the key (write-through PATCH), then star it.
  r = await req(base, "PATCH", "/api/admin/plugins/crypto:coinmarketcap", { sid: admin.sid, body: { config: { api_key: "cmc-test-key" } } });
  assert.equal(r.status, 200);
  r = await req(base, "POST", "/api/admin/plugins/slots/crypto", { sid: admin.sid, body: { provider: "coinmarketcap" } });
  assert.equal(r.status, 200);

  const g = await req(base, "GET", "/api/admin/plugins", { sid: admin.sid });
  const starred = await req(base, "GET", "/api/admin/capabilities", { sid: admin.sid });
  assert.equal(starred.json.capabilities.find((c) => c.id === "crypto").bound.provider, "coinmarketcap");
  assert.equal(g.json.plugins.find((p) => p.id === "crypto:coinmarketcap").state.hasKey, true);
  assert.equal(g.json.plugins.find((p) => p.id === "crypto:coingecko").state.hasKey, false); // per-provider slots don't bleed
});

test("POST entities via CoinMarketCap: identical canonical fields, src=coinmarketcap", async () => {
  await req(base, "PATCH", "/api/admin/plugins/crypto:coinmarketcap", { sid: admin.sid, body: { config: { api_key: "cmc-test-key" } } });
  await req(base, "POST", "/api/admin/plugins/slots/crypto", { sid: admin.sid, body: { provider: "coinmarketcap" } });
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

test("CoinGecko takes an optional key; slots stay per-provider", async () => {
  // A CoinMarketCap key is already stored (earlier test). Saving a CoinGecko
  // key must land in its own slot without disturbing CMC's.
  let r = await req(base, "PATCH", "/api/admin/plugins/crypto:coingecko", {
    sid: admin.sid, body: { config: { api_key: "cg-demo-key" } },
  });
  assert.equal(r.status, 200);
  r = await req(base, "POST", "/api/admin/plugins/slots/crypto", { sid: admin.sid, body: { provider: "coingecko" } });
  assert.equal(r.status, 200); // keyless provider stars fine, key or not

  const g = await req(base, "GET", "/api/admin/plugins", { sid: admin.sid });
  const caps = await req(base, "GET", "/api/admin/capabilities", { sid: admin.sid });
  assert.equal(caps.json.capabilities.find((c) => c.id === "crypto").bound.provider, "coingecko");
  assert.equal(g.json.plugins.find((p) => p.id === "crypto:coingecko").state.hasKey, true);
  assert.equal(g.json.plugins.find((p) => p.id === "crypto:coinmarketcap").state.hasKey, true); // CMC key preserved, not clobbered
});

test("plugins/:id/test: honors the plugin's provider, not the active one", async () => {
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
    let r = await req(base, "POST", "/api/admin/plugins/crypto:coingecko/test", { sid: admin.sid });
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, "coingecko");

    r = await req(base, "POST", "/api/admin/plugins/crypto:coinmarketcap/test", { sid: admin.sid, body: { api_key: "typed-key" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.provider, "coinmarketcap");
  } finally {
    globalThis.fetch = original;
  }
});
