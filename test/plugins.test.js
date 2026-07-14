// The plugin registry (server/plugins.js): the composed catalog over AI
// providers, connector providers, and media source handlers, plus the
// plugins-table state model (absent row = enabled with default config) and
// the served admin catalog. Enforcement (disabled plugins changing behavior)
// is pinned where it bites — worker/runtime/ingest tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, req } from "./helpers.js";
import { pluginDefs, getPluginDef, pluginState, pluginCatalog } from "../server/plugins.js";
import { setPluginState, setSetting, getSetting, createAiKey, recordPluginHealth, getPluginRow } from "../server/db.js";
import { getConnector } from "../server/connectors/index.js";
import { resolveDefaultAi, resolveBoardAi, resolveEmbedder } from "../server/worker.js";

const FIELD_TYPES = new Set(["secret", "text", "number", "select", "toggle"]);

test("defs: one entry per integration, ids unique and namespaced", () => {
  const ids = pluginDefs().map((d) => d.id);
  assert.deepEqual(ids, [
    "ai:local", "ai:anthropic", "ai:openai", "ai:gemini", "ai:glm", "ai:openrouter",
    "crypto:coingecko", "crypto:coinmarketcap", "stocks:financialmodelingprep",
    "media:image", "media:text", "media:pdf", "media:docx",
  ]);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of pluginDefs()) {
    assert.equal(d.id, `${d.segment}:${d.name}`);
    assert.ok(["ai", "connector", "media"].includes(d.kind), d.id);
    for (const f of d.configSchema) assert.ok(FIELD_TYPES.has(f.type), `${d.id}.${f.key}: known field type`);
  }
  // core = images only (sharp is shared infra; everything else may toggle)
  assert.deepEqual(pluginDefs().filter((d) => d.core).map((d) => d.id), ["media:image"]);
});

test("defs: capabilities mirror the underlying descriptors", () => {
  const local = getPluginDef("ai:local");
  assert.deepEqual(local.capabilities, { tag: false, embed: true, research: false });
  const anthropic = getPluginDef("ai:anthropic");
  assert.deepEqual(anthropic.capabilities, { tag: true, embed: false, research: true });
  assert.ok(anthropic.ai.models.some((m) => m.id === anthropic.ai.defaultModel));

  const gecko = getPluginDef("crypto:coingecko");
  assert.equal(gecko.connector.domain, "crypto");
  assert.equal(gecko.connector.needsKey, false); // keyless tier exists
  const schemaKeys = gecko.configSchema.map((f) => f.key);
  assert.deepEqual(schemaKeys, ["api_key", "rpm", "burst"]);
  const rpm = gecko.configSchema.find((f) => f.key === "rpm");
  assert.equal(rpm.type, "number");
  assert.ok(rpm.default >= 1, "rpm default comes from the provider descriptor");

  const pdf = getPluginDef("media:pdf");
  assert.deepEqual(pdf.capabilities, { extensions: ["pdf"], kinds: ["pdf"] });
});

// --- state + the served catalog ---

let srv, db, base, admin;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});
after(() => srv.close());

test("state: absent row = enabled with schema defaults; writes are partial", async () => {
  const fresh = await pluginState(db, "crypto:coingecko");
  assert.equal(fresh.enabled, true);
  assert.equal(fresh.config.rpm, getPluginDef("crypto:coingecko").configSchema.find((f) => f.key === "rpm").default);

  await setPluginState(db, "crypto:coingecko", { config: { rpm: 5 } });
  await setPluginState(db, "crypto:coingecko", { enabled: false }); // must not clobber config
  const s = await pluginState(db, "crypto:coingecko");
  assert.equal(s.enabled, false);
  assert.equal(s.config.rpm, 5);
  assert.ok(s.config.burst, "unset fields keep their schema default");

  await setPluginState(db, "crypto:coingecko", { enabled: true, config: {} });
});

test("state: a core plugin reads enabled no matter what the row says", async () => {
  await setPluginState(db, "media:image", { enabled: false });
  assert.equal((await pluginState(db, "media:image")).enabled, true);
  await setPluginState(db, "media:image", { enabled: true });
});

test("health: failures streak, success writes only when healing", async () => {
  await recordPluginHealth(db, "stocks:financialmodelingprep", { message: "x".repeat(900), status: 429 });
  await recordPluginHealth(db, "stocks:financialmodelingprep", new Error("nope"));
  let row = await getPluginRow(db, "stocks:financialmodelingprep");
  assert.equal(row.fail_count, 2);
  assert.equal(row.last_error.message, "nope");
  assert.equal(row.last_error.status, null);
  assert.ok(row.last_error.at <= Date.now());

  await recordPluginHealth(db, "stocks:financialmodelingprep"); // heals
  row = await getPluginRow(db, "stocks:financialmodelingprep");
  assert.equal(row.fail_count, 0);
  assert.equal(row.last_error, null);
  const okAt = row.last_ok_at;

  await recordPluginHealth(db, "stocks:financialmodelingprep"); // steady state: no write
  row = await getPluginRow(db, "stocks:financialmodelingprep");
  assert.equal(row.last_ok_at, okAt);

  // message cap survives the round trip
  await recordPluginHealth(db, "stocks:financialmodelingprep", { message: "y".repeat(900) });
  row = await getPluginRow(db, "stocks:financialmodelingprep");
  assert.equal(row.last_error.message.length, 500);
  await recordPluginHealth(db, "stocks:financialmodelingprep");
});

test("catalog: key presence without key material", async () => {
  await setSetting(db, "crypto_key_coinmarketcap", "cmc-secret");
  await createAiKey(db, "work", "openai", "sk-secret");
  const cat = await pluginCatalog(db);

  const cmc = cat.find((p) => p.id === "crypto:coinmarketcap");
  assert.equal(cmc.state.hasKey, true);
  const gecko = cat.find((p) => p.id === "crypto:coingecko");
  assert.equal(gecko.state.hasKey, false);
  const openai = cat.find((p) => p.id === "ai:openai");
  assert.equal(openai.state.keyCount, 1);

  // no secret ever crosses: not in config, not anywhere in the payload
  const flat = JSON.stringify(cat);
  assert.ok(!flat.includes("cmc-secret") && !flat.includes("sk-secret"));
});

test("GET /api/admin/plugins: admin-only; plugins + slots in one payload", async () => {
  const anon = await req(base, "GET", "/api/admin/plugins");
  assert.equal(anon.status, 403);

  const r = await req(base, "GET", "/api/admin/plugins", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.plugins.length, pluginDefs().length);
  // slot state reads the same settings the legacy routes use
  assert.equal(r.json.slots.tagger.keyId, null);
  assert.equal(r.json.slots.embedder.enabled, false);
  assert.deepEqual(r.json.slots.domains.crypto, { setting: null, effective: "coingecko" });
  assert.deepEqual(r.json.slots.domains.stocks, { setting: null, effective: "financialmodelingprep" });
});

// --- slice 3: writes + enforcement ---

test("PATCH /api/admin/plugins/:id: the validation matrix", async () => {
  const p = (id, body) => req(base, "PATCH", `/api/admin/plugins/${id}`, { sid: admin.sid, body });
  assert.equal((await p("crypto:nope", { enabled: false })).status, 404);
  assert.equal((await req(base, "PATCH", "/api/admin/plugins/crypto:coingecko")).status, 403); // anon

  const core = await p("media:image", { enabled: false });
  assert.equal(core.status, 400);
  assert.match(core.json.error, /core/);

  assert.equal((await p("crypto:coingecko", { enabled: "yes" })).status, 400);
  assert.equal((await p("crypto:coingecko", { config: { bogus: 1 } })).status, 400);
  assert.equal((await p("crypto:coingecko", { config: { rpm: 0 } })).status, 400);
  assert.equal((await p("crypto:coingecko", { config: { rpm: "abc" } })).status, 400);
  // nothing half-applied by the failures above
  assert.equal((await pluginState(db, "crypto:coingecko")).enabled, true);

  const ok = await p("crypto:coingecko", { config: { rpm: 5 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.state.config.rpm, 5);
  // null puts a field back on its schema default
  await p("crypto:coingecko", { config: { rpm: null } });
  const def = getPluginDef("crypto:coingecko").configSchema.find((f) => f.key === "rpm").default;
  assert.equal((await pluginState(db, "crypto:coingecko")).config.rpm, def);
});

test("PATCH: a secret writes through to the settings store, never plugins.config", async () => {
  const p = (body) => req(base, "PATCH", "/api/admin/plugins/stocks:financialmodelingprep", { sid: admin.sid, body });
  await p({ config: { api_key: "  fmp-key-1  " } });
  assert.equal(await getSetting(db, "stocks_key_financialmodelingprep"), "fmp-key-1");
  const row = await getPluginRow(db, "stocks:financialmodelingprep");
  assert.equal(row?.config?.api_key, undefined);

  await p({ config: { api_key: "" } }); // explicit clear
  assert.equal(await getSetting(db, "stocks_key_financialmodelingprep"), null);
});

test("slots/:domain: starring validates enabled + key, then writes the setting", async () => {
  const star = (domain, provider) => req(base, "POST", `/api/admin/plugins/slots/${domain}`, { sid: admin.sid, body: { provider } });
  assert.equal((await star("movies", "x")).status, 404);
  assert.equal((await star("crypto", "nope")).status, 400);

  // coinmarketcap needs a key; its settings key was set earlier in this file
  const ok = await star("crypto", "coinmarketcap");
  assert.equal(ok.status, 200);
  assert.equal(await getSetting(db, "crypto_provider"), "coinmarketcap");

  await setPluginState(db, "crypto:coingecko", { enabled: false });
  const dis = await star("crypto", "coingecko");
  assert.equal(dis.status, 400);
  assert.match(dis.json.error, /disabled/);
  await setPluginState(db, "crypto:coingecko", { enabled: true });
  await star("crypto", "coingecko"); // leave coingecko starred for later tests

  await setSetting(db, "stocks_key_financialmodelingprep", null);
  const nokey = await star("stocks", "financialmodelingprep");
  assert.equal(nokey.status, 400);
  assert.match(nokey.json.error, /API key/);
});

test("activeProvider: disabled default falls forward; all-disabled throws readably", async () => {
  const conn = getConnector("crypto");
  assert.equal((await conn.activeProvider(db)).name, "coingecko");

  await setPluginState(db, "crypto:coingecko", { enabled: false });
  assert.equal((await conn.activeProvider(db)).name, "coinmarketcap");

  await setPluginState(db, "crypto:coinmarketcap", { enabled: false });
  await assert.rejects(conn.activeProvider(db), /every crypto provider is disabled/);
  // the catalog route reports effective=null instead of erroring
  const r = await req(base, "GET", "/api/admin/plugins", { sid: admin.sid });
  assert.equal(r.json.slots.domains.crypto.effective, null);

  await setPluginState(db, "crypto:coingecko", { enabled: true });
  await setPluginState(db, "crypto:coinmarketcap", { enabled: true });
});

test("activeProvider: config rpm/burst overrides ride the returned descriptor", async () => {
  await setPluginState(db, "crypto:coingecko", { config: { rpm: 7, burst: 2 } });
  const { provider } = await getConnector("crypto").activeProvider(db);
  assert.equal(provider.rpm, 7);
  assert.equal(provider.burst, 2);
  assert.equal(typeof provider.search, "function"); // methods survive the merge
  await setPluginState(db, "crypto:coingecko", { config: {} });
});

test("resolvers: a disabled AI plugin drops out; fallbacks stay graceful", async () => {
  const savedEnv = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const keyId = await createAiKey(db, "main", "openai", "sk-t1");
    await setSetting(db, "default_key_id", String(keyId));
    assert.equal((await resolveDefaultAi(db)).provider, "openai");

    await setPluginState(db, "ai:openai", { enabled: false });
    assert.equal(await resolveDefaultAi(db), null); // no env fallback here

    // a board pinned to the disabled provider falls through to the default
    await setPluginState(db, "ai:openai", { enabled: true });
    const gkey = await createAiKey(db, "g", "gemini", "sk-t2");
    await setPluginState(db, "ai:gemini", { enabled: false });
    const viaBoard = await resolveBoardAi(db, { aiKeyId: gkey, aiModel: "gemini-2.5-pro" });
    assert.equal(viaBoard.provider, "openai");

    // env fallback honors the anthropic toggle
    process.env.ANTHROPIC_API_KEY = "sk-env";
    await setSetting(db, "default_key_id", null);
    assert.equal((await resolveDefaultAi(db)).provider, "anthropic");
    await setPluginState(db, "ai:anthropic", { enabled: false });
    assert.equal(await resolveDefaultAi(db), null);

    // embedder: local pauses when ai:local is off
    await setSetting(db, "embed_enabled", "1");
    await setSetting(db, "embed_provider", "local");
    assert.equal((await resolveEmbedder(db)).provider, "local");
    await setPluginState(db, "ai:local", { enabled: false });
    assert.equal(await resolveEmbedder(db), null);
  } finally {
    if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv;
    else delete process.env.ANTHROPIC_API_KEY;
    await setPluginState(db, "ai:anthropic", { enabled: true });
    await setPluginState(db, "ai:gemini", { enabled: true });
    await setPluginState(db, "ai:local", { enabled: true });
    await setSetting(db, "embed_enabled", null);
    await setSetting(db, "embed_provider", null);
    await setSetting(db, "default_key_id", null);
  }
});

test("upload door: a disabled media plugin refuses its extensions readably", async () => {
  const board = await seedBoard(db, "plugin-uploads");
  const send = async (name, content) => {
    const fd = new FormData();
    fd.append("files", new File([content], name, { type: "text/plain" }));
    const res = await fetch(`${base}/api/upload?board=${board}`, {
      method: "POST", headers: { Cookie: `sid=${admin.sid}` }, body: fd,
    });
    return res.json();
  };

  await setPluginState(db, "media:text", { enabled: false });
  const r1 = await send("notes.txt", "hello");
  assert.equal(r1.uploaded.length, 0);
  assert.match(r1.rejected[0].reason, /disabled.*Plugins page/);

  await setPluginState(db, "media:text", { enabled: true });
  const r2 = await send("notes.txt", "hello");
  assert.equal(r2.uploaded.length, 1);
  assert.equal(r2.rejected.length, 0);
});

test("health ledger: connector traffic records failures and heals through the runtime", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { const e = new Error("boom"); e.status = 500; throw e; };
  try {
    await assert.rejects(getConnector("crypto").search(db, "btc"));
  } finally {
    globalThis.fetch = original;
  }
  let row = await getPluginRow(db, "crypto:coingecko");
  assert.equal(row.fail_count >= 1, true);
  assert.ok(row.last_error.message);

  // the served catalog surfaces it for the status dot
  let cat = await req(base, "GET", "/api/admin/plugins", { sid: admin.sid });
  let gecko = cat.json.plugins.find((p) => p.id === "crypto:coingecko");
  assert.ok(gecko.state.health.failCount >= 1);

  // a working call heals the streak
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ coins: [] }), text: async () => "" });
  try {
    await getConnector("crypto").search(db, "btc");
  } finally {
    globalThis.fetch = original;
  }
  row = await getPluginRow(db, "crypto:coingecko");
  assert.equal(row.fail_count, 0);
  assert.equal(row.last_error, null);
});
