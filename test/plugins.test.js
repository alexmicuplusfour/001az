// The plugin registry (server/plugins.js): the composed catalog over AI
// providers, connector providers, and media source handlers, plus the
// plugins-table state model (absent row = enabled with default config) and
// the served admin catalog. Enforcement (disabled plugins changing behavior)
// is pinned where it bites — worker/runtime/ingest tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, req } from "./helpers.js";
import { pluginDefs, getPluginDef, pluginState, pluginCatalog, mediaLimits, mediaLimitLookup } from "../server/plugins.js";
import { UPLOAD_HARD_CEILING } from "../server/upload-limits.js";
import { setPluginState, setSetting, getSetting, createAiKey, recordPluginHealth, getPluginRow, updateBoard } from "../server/db.js";
import { up as carryConnectorInstalls } from "../server/migrations/0018_carry_connector_installs.js";
import { getConnector } from "../server/connectors/index.js";
import { resolveDefaultAi, resolveBoardAi, resolveEmbedder } from "../server/worker.js";

const FIELD_TYPES = new Set(["secret", "text", "number", "select", "toggle"]);

test("defs: one entry per integration, ids unique and namespaced", () => {
  const ids = pluginDefs().map((d) => d.id);
  assert.deepEqual(ids, [
    "ai:local", "ai:whisper", "ai:localDetector", "ai:anthropic", "ai:openai", "ai:gemini", "ai:glm", "ai:openrouter",
    "crypto:coingecko", "crypto:coinmarketcap", "stocks:financialmodelingprep",
    "media:image", "media:text", "media:pdf", "media:docx", "media:audio",
    "source:folder", "source:ftp", "source:s3",
  ]);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of pluginDefs()) {
    assert.equal(d.id, `${d.segment}:${d.name}`);
    assert.ok(["ai", "connector", "media", "source"].includes(d.kind), d.id);
    // Every card must say what it is: a label and a one-line description.
    assert.ok(d.label && d.label.trim(), `${d.id}: has a label`);
    assert.ok(d.description && d.description.trim(), `${d.id}: has a description`);
    for (const f of d.configSchema) assert.ok(FIELD_TYPES.has(f.type), `${d.id}.${f.key}: known field type`);
  }
  // the on-device cards name both the capability and the engine behind it
  assert.equal(getPluginDef("ai:local").label, "Local Embedder (Xenova)");
  assert.equal(getPluginDef("ai:whisper").label, "Local Transcriber (Whisper)");
  assert.equal(getPluginDef("ai:localDetector").label, "Local Object Detector (LLMDet)");
  // core = the app's own capabilities (always installed, not removable): every
  // media handler, the on-device embedder, and the local-folder source.
  assert.deepEqual(pluginDefs().filter((d) => d.core).map((d) => d.id),
    ["ai:local", "ai:whisper", "ai:localDetector", "media:image", "media:text", "media:pdf", "media:docx", "media:audio", "source:folder"]);
  // exactly one connection is pre-added — the flagship AI provider.
  assert.deepEqual(pluginDefs().filter((d) => d.defaultInstalled).map((d) => d.id), ["ai:anthropic"]);
});

test("defs: capabilities mirror the underlying descriptors", () => {
  const local = getPluginDef("ai:local");
  assert.deepEqual(local.capabilities, { tag: false, embed: true, transcribe: false, detect: false, research: false });
  const whisper = getPluginDef("ai:whisper");
  assert.deepEqual(whisper.capabilities, { tag: false, embed: false, transcribe: true, detect: false, research: false });
  const detector = getPluginDef("ai:localDetector");
  assert.deepEqual(detector.capabilities, { tag: false, embed: false, transcribe: false, detect: true, research: false });
  const anthropic = getPluginDef("ai:anthropic");
  assert.deepEqual(anthropic.capabilities, { tag: true, embed: false, transcribe: false, detect: false, research: true });
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
  assert.deepEqual(pdf.capabilities,
    { extensions: ["pdf"], kinds: ["pdf"], maxBytes: 10 * 1024 * 1024, ceilingBytes: UPLOAD_HARD_CEILING });
});

// --- state + the served catalog ---

let srv, db, base, admin;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});
after(() => srv.close());

test("state: install defaults follow the tier; config is schema-default overlaid", async () => {
  // No row yet: connections are available (not installed), the flagship is
  // pre-added, built-ins are always installed.
  assert.equal((await pluginState(db, "crypto:coingecko")).installed, false);
  assert.equal((await pluginState(db, "ai:openai")).installed, false);
  assert.equal((await pluginState(db, "ai:anthropic")).installed, true, "flagship pre-added");
  assert.equal((await pluginState(db, "ai:local")).installed, true, "embedder is core");
  assert.equal((await pluginState(db, "media:pdf")).installed, true, "media is core");

  const fresh = await pluginState(db, "crypto:coingecko");
  assert.equal(fresh.config.rpm, getPluginDef("crypto:coingecko").configSchema.find((f) => f.key === "rpm").default);

  // Partial writes: a config-only write leaves install state alone (NULL → tier
  // default), and an install write never clobbers config.
  await setPluginState(db, "crypto:coingecko", { config: { rpm: 5 } });
  assert.equal((await pluginState(db, "crypto:coingecko")).installed, false, "config write kept the default install state");
  await setPluginState(db, "crypto:coingecko", { installed: true });
  const s = await pluginState(db, "crypto:coingecko");
  assert.equal(s.installed, true);
  assert.equal(s.config.rpm, 5, "install write kept config");
  assert.ok(s.config.burst, "unset fields keep their schema default");

  await setPluginState(db, "crypto:coingecko", { installed: false, config: {} });
});

test("state: a core plugin reads installed no matter what the row says", async () => {
  await setPluginState(db, "media:image", { installed: false });
  assert.equal((await pluginState(db, "media:image")).installed, true);
  await setPluginState(db, "media:image", { installed: true });
});

test("media limits: manifest default, admin override, and per-name lookup", async () => {
  const MB = 1024 * 1024;
  // Defaults come straight from the manifests (all 10 MB today).
  const base0 = await mediaLimits(db);
  const pdf = base0.find((t) => t.name === "pdf");
  assert.equal(pdf.maxBytes, 10 * MB);
  assert.deepEqual(pdf.extensions, ["pdf"]);

  // A stored override on the media plugin's config wins over the manifest default.
  await setPluginState(db, "media:pdf", { config: { maxBytes: 25 * MB } });
  assert.equal((await mediaLimits(db)).find((t) => t.name === "pdf").maxBytes, 25 * MB);
  // A non-positive / garbage override is ignored → back to the manifest default.
  await setPluginState(db, "media:pdf", { config: { maxBytes: -1 } });
  assert.equal((await mediaLimits(db)).find((t) => t.name === "pdf").maxBytes, 10 * MB);
  await setPluginState(db, "media:pdf", { config: {} }); // reset

  // The per-file lookup maps by extension; an unknown extension falls to the
  // image limit, mirroring the ingest dispatcher's image fallback (forUpload).
  const limitFor = await mediaLimitLookup(db);
  assert.equal(limitFor("a.pdf"), 10 * MB);
  assert.equal(limitFor("mystery.qzx"), base0.find((t) => t.name === "image").maxBytes);
});

test("GET /api/media-types serves accepted types + effective limits (public)", async () => {
  const r = await req(base, "GET", "/api/media-types");
  assert.equal(r.status, 200, "public capability metadata — no auth gate");
  assert.deepEqual(r.json.map((t) => t.name).sort(), ["audio", "docx", "image", "pdf", "text"]);
  const image = r.json.find((t) => t.name === "image");
  assert.ok(image.extensions.includes("jpg"));
  assert.equal(typeof image.maxBytes, "number");
});

test("admin PATCH: a media maxBytes override flows to mediaLimits + /api/media-types, and clears", async () => {
  const MB = 1024 * 1024;
  const set = await req(base, "PATCH", "/api/admin/plugins/media:pdf", { sid: admin.sid, body: { config: { maxBytes: 30 * MB } } });
  assert.equal(set.status, 200);
  assert.equal((await mediaLimits(db)).find((t) => t.name === "pdf").maxBytes, 30 * MB);
  const served = await req(base, "GET", "/api/media-types");
  assert.equal(served.json.find((t) => t.name === "pdf").maxBytes, 30 * MB, "the endpoint serves the override");

  // Blank in the modal → null → the route deletes the override → manifest default.
  const clear = await req(base, "PATCH", "/api/admin/plugins/media:pdf", { sid: admin.sid, body: { config: { maxBytes: null } } });
  assert.equal(clear.status, 200);
  assert.equal((await mediaLimits(db)).find((t) => t.name === "pdf").maxBytes, 10 * MB, "cleared → back to the manifest default");
});

test("media limits clamp to the absolute upload ceiling", async () => {
  const huge = 10 * 1024 * 1024 * 1024; // 10 GB — far over the ceiling
  await setPluginState(db, "media:pdf", { config: { maxBytes: huge } });
  assert.equal((await mediaLimits(db)).find((t) => t.name === "pdf").maxBytes, UPLOAD_HARD_CEILING,
    "an over-large override caps at the ceiling, so the client never offers what multer would 413");
  await setPluginState(db, "media:pdf", { config: {} });
});

test("state: a health-only row (NULL installed) falls to the tier default", async () => {
  // recordPluginHealth writes a row WITHOUT installed — a plugin that was merely
  // called must not read as explicitly installed.
  await recordPluginHealth(db, "ai:gemini", new Error("boom"));
  const row = await getPluginRow(db, "ai:gemini");
  assert.equal(row.installed, null, "health write leaves installed NULL");
  assert.equal((await pluginState(db, "ai:gemini")).installed, false, "still available, not installed");
  await recordPluginHealth(db, "ai:gemini"); // heal, leaving the NULL row
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

test("GET /api/admin/plugins: admin-only; the payload is the plugin list — slots retired in 7c", async () => {
  const anon = await req(base, "GET", "/api/admin/plugins");
  assert.equal(anon.status, 403);

  const r = await req(base, "GET", "/api/admin/plugins", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.plugins.length, pluginDefs().length);
  // The slot/domain state these lines used to pin lives on the capabilities
  // feed (fresh-instance states are asserted in capabilities.test.js); the
  // absence is pinned so the parallel projection can't quietly come back.
  assert.equal("slots" in r.json, false);
});

// --- slice 3: writes + enforcement ---

test("PATCH /api/admin/plugins/:id: the validation matrix", async () => {
  const p = (id, body) => req(base, "PATCH", `/api/admin/plugins/${id}`, { sid: admin.sid, body });
  assert.equal((await p("crypto:nope", { installed: false })).status, 404);
  assert.equal((await req(base, "PATCH", "/api/admin/plugins/crypto:coingecko")).status, 403); // anon

  const core = await p("media:image", { installed: false });
  assert.equal(core.status, 400);
  assert.match(core.json.error, /can't be removed/);

  assert.equal((await p("crypto:coingecko", { installed: "yes" })).status, 400);
  assert.equal((await p("crypto:coingecko", { config: { bogus: 1 } })).status, 400);
  assert.equal((await p("crypto:coingecko", { config: { rpm: 0 } })).status, 400);
  assert.equal((await p("crypto:coingecko", { config: { rpm: "abc" } })).status, 400);
  // nothing half-applied by the failures above (coingecko is available by default)
  assert.equal((await pluginState(db, "crypto:coingecko")).installed, false);

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

test("slots/:domain: starring validates installed + key, then writes the setting", async () => {
  const star = (domain, provider) => req(base, "POST", `/api/admin/plugins/slots/${domain}`, { sid: admin.sid, body: { provider } });
  assert.equal((await star("movies", "x")).status, 404);
  assert.equal((await star("crypto", "nope")).status, 400);

  // an available (not-installed) provider can't be starred — add it first
  const notAdded = await star("crypto", "coinmarketcap");
  assert.equal(notAdded.status, 400);
  assert.match(notAdded.json.error, /not installed/);

  // install it (its settings key was set earlier in this file); now it stars
  await setPluginState(db, "crypto:coinmarketcap", { installed: true });
  const ok = await star("crypto", "coinmarketcap");
  assert.equal(ok.status, 200);
  assert.equal(await getSetting(db, "crypto_provider"), "coinmarketcap");

  // install coingecko so the rest of the suite has a live crypto provider
  await setPluginState(db, "crypto:coingecko", { installed: true });
  await star("crypto", "coingecko"); // leave coingecko starred for later tests

  // fmp installed but keyless → the key guard fires (installed check passes first)
  await setPluginState(db, "stocks:financialmodelingprep", { installed: true });
  await setSetting(db, "stocks_key_financialmodelingprep", null);
  const nokey = await star("stocks", "financialmodelingprep");
  assert.equal(nokey.status, 400);
  assert.match(nokey.json.error, /API key/);
});

test("activeProvider: not-installed default falls forward; none-installed throws readably", async () => {
  const conn = getConnector("crypto");
  // both installed + coingecko starred from the previous test
  assert.equal((await conn.activeProvider(db)).name, "coingecko");

  await setPluginState(db, "crypto:coingecko", { installed: false });
  assert.equal((await conn.activeProvider(db)).name, "coinmarketcap");

  await setPluginState(db, "crypto:coinmarketcap", { installed: false });
  await assert.rejects(conn.activeProvider(db), /no crypto provider is installed/);
  // the capabilities feed reports the domain as unavailable instead of erroring
  const r = await req(base, "GET", "/api/admin/capabilities", { sid: admin.sid });
  const crypto = r.json.capabilities.find((c) => c.id === "crypto");
  assert.equal(crypto.running, null);
  assert.equal(crypto.state, "unavailable");

  await setPluginState(db, "crypto:coingecko", { installed: true });
  await setPluginState(db, "crypto:coinmarketcap", { installed: true });
});

test("activeProvider: config rpm/burst overrides ride the returned descriptor", async () => {
  await setPluginState(db, "crypto:coingecko", { config: { rpm: 7, burst: 2 } });
  const { provider } = await getConnector("crypto").activeProvider(db);
  assert.equal(provider.rpm, 7);
  assert.equal(provider.burst, 2);
  assert.equal(typeof provider.search, "function"); // methods survive the merge
  await setPluginState(db, "crypto:coingecko", { config: {} });
});

test("resolvers: a not-installed AI plugin drops out; fallbacks stay graceful", async () => {
  const savedEnv = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    // openai is available by default — a default key on a not-installed provider
    // resolves to nothing until it's added.
    const keyId = await createAiKey(db, "main", "openai", "sk-t1");
    await setSetting(db, "default_key_id", String(keyId));
    assert.equal(await resolveDefaultAi(db), null, "not installed → drops out");

    await setPluginState(db, "ai:openai", { installed: true });
    assert.equal((await resolveDefaultAi(db)).provider, "openai");

    // a board pinned to an available (not-installed) provider falls through to
    // the default — gemini is never added here.
    const gkey = await createAiKey(db, "g", "gemini", "sk-t2");
    const viaBoard = await resolveBoardAi(db, { aiKeyId: gkey, aiModel: "gemini-2.5-pro" });
    assert.equal(viaBoard.provider, "openai");

    // env fallback honors the anthropic install state (pre-added by default)
    process.env.ANTHROPIC_API_KEY = "sk-env";
    await setSetting(db, "default_key_id", null);
    assert.equal((await resolveDefaultAi(db)).provider, "anthropic");
    await setPluginState(db, "ai:anthropic", { installed: false });
    assert.equal(await resolveDefaultAi(db), null);

    // embedder: local is core (always installed); the sweep is gated by the
    // embed_enabled setting, not install state.
    await setSetting(db, "embed_enabled", "1");
    await setSetting(db, "embed_provider", "local");
    assert.equal((await resolveEmbedder(db)).provider, "local");
    await setSetting(db, "embed_enabled", null);
    assert.equal(await resolveEmbedder(db), null, "off via the setting, not a removal");
  } finally {
    if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv;
    else delete process.env.ANTHROPIC_API_KEY;
    await setPluginState(db, "ai:anthropic", { installed: true });
    await setPluginState(db, "ai:openai", { installed: false });
    await setSetting(db, "embed_enabled", null);
    await setSetting(db, "embed_provider", null);
    await setSetting(db, "default_key_id", null);
  }
});

// (GET /api/admin/ai-default was deleted in 7b — the board modal's "App default"
// rows read the capabilities feed's `running`, whose ladder and secrets
// discipline are pinned in capabilities.test.js.)

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

test("migration 0018: carries in-use connectors over on upgrade", async () => {
  // A crypto board (its default is in use) + a stored FMP key (adopted).
  const boardId = await seedBoard(db, "carry-crypto");
  await updateBoard(db, boardId, {
    mapping: { input: { connector: "crypto" }, identity: { source: "connector" }, fields: [] },
  });
  await setSetting(db, "stocks_key_financialmodelingprep", "fmp-carry");
  // Reset to the post-0017 "available" posture so 0018's restore is observable.
  // Clear cmc's key (set by an earlier test) so it's the clean negative case:
  // a non-default provider with no key and no board of its own.
  await setSetting(db, "crypto_key_coinmarketcap", null);
  await setPluginState(db, "crypto:coingecko", { installed: false });
  await setPluginState(db, "crypto:coinmarketcap", { installed: false });
  await setPluginState(db, "stocks:financialmodelingprep", { installed: false });

  await carryConnectorInstalls(db);

  assert.equal((await pluginState(db, "crypto:coingecko")).installed, true, "keyless default of a domain with boards");
  assert.equal((await pluginState(db, "stocks:financialmodelingprep")).installed, true, "adopted via a stored key");
  assert.equal((await pluginState(db, "crypto:coinmarketcap")).installed, false, "no key, not the default → stays available");

  await setSetting(db, "stocks_key_financialmodelingprep", null);
});
