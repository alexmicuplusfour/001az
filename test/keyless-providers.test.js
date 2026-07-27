// Keyless-networked AI providers — the self-hosted-server shape (Ollama,
// LM Studio, vLLM, …). The design splits what used to be one flag into two
// orthogonal ones: `keyless` = connections carry no secret (auth), `onDevice`
// = no external calls (network). The ai_keys row stays the ONE selection
// handle for tagging/embedding — a keyless connection is a row with
// api_key NULL, and the compat wire simply sends no Authorization header.
//
// Covers the four layers: the descriptor contract (a keyless-networked
// provider still owes rpm/burst; onDevice implies keyless), registration
// (no key OK for keyless, required for keyed, rejected for on-device),
// resolution (tagger/embedder resolve through the row with apiKey null),
// and the wire (header omitted exactly when there is no key).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { startServer, adminSession, req } from "./helpers.js";
import { loadDir, uninstall } from "../server/plugin-loader.js";
import { PROVIDERS, providerCatalog, registerProvider, unregisterProvider } from "../server/providers.js";
import { compatHeaders } from "../server/ai-providers/wires/compat.js";
import { getPluginDef } from "../server/plugins.js";
import { resolveDefaultAi, resolveBoardAi, resolveEmbedder } from "../server/worker.js";
import { setPluginState, upsertExternalPlugin, createAiKey, deleteAiKey, getAiKey, getSetting, setSetting } from "../server/db.js";

const FIX = (name) => fileURLToPath(new URL(`./fixtures/plugins/${name}`, import.meta.url));

// --- pure: the wire ---

test("compatHeaders: Authorization rides only when a key exists", () => {
  assert.equal(compatHeaders("sk-123").Authorization, "Bearer sk-123");
  assert.equal(compatHeaders(null).Authorization, undefined, "no key → no header (not 'Bearer null')");
  assert.equal(compatHeaders(null)["Content-Type"], "application/json", "content type always rides");
});

// --- pure: the descriptor contract ---

test("rate-limit contract: keyless-networked still owes rpm/burst; onDevice is exempt and implies keyless", () => {
  // Keyless but networked (has a wire, not onDevice): no secret ≠ no server to melt.
  assert.throws(
    () => registerProvider("nolimit", { label: "NoLimit", keyless: true, wire: { tag() {} } }),
    /rate-limit contract/,
    "keyless alone no longer exempts a networked provider"
  );
  // On-device: no external calls — exempt, and keyless is normalized on.
  assert.doesNotThrow(() => registerProvider("ondev", { label: "OnDev", onDevice: true, wire: { embed() {} } }));
  assert.equal(PROVIDERS.ondev.keyless, true, "onDevice implies keyless (normalized at install)");
  unregisterProvider("ondev");
});

test("built-ins carry the split flags; the catalog exposes both", () => {
  assert.equal(PROVIDERS.local.onDevice, true);
  assert.equal(PROVIDERS.whisper.onDevice, true);
  assert.equal(PROVIDERS.anthropic.onDevice ?? false, false);
  const local = providerCatalog().find((p) => p.name === "local");
  assert.equal(local.keyless, true);
  assert.equal(local.onDevice, true);
});

// --- loader: the fixture registers as keyless-networked ---

test("loadDir: a keyless-networked ai-provider registers with pacing config intact", async () => {
  // NOTE: deliberately not unregistered — the integration tests below resolve
  // through this same registration (and before() hooks run before ALL tests,
  // so an unregister here would yank it out from under them).
  const { catalogId } = await loadDir(FIX("acme-selfhosted"));
  assert.equal(catalogId, "ai:acme.selfhosted");
  const cat = providerCatalog().find((p) => p.name === "acme.selfhosted");
  assert.equal(cat.keyless, true);
  assert.equal(cat.onDevice, false, "a self-hosted server is networked");
  // Networked → the rpm/burst admin override stays available (on-device gets none).
  const def = getPluginDef("ai:acme.selfhosted");
  assert.deepEqual(def.configSchema.map((f) => f.key), ["rpm", "burst"]);
  assert.equal(getPluginDef("ai:local").configSchema.length, 0, "on-device local still has no rate-limit config");
});

// --- integration: registration + resolution through the row ---

let srv, db, admin;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  admin = await adminSession(db);
  await loadDir(FIX("acme-selfhosted"));
  await setPluginState(db, "ai:acme.selfhosted", { installed: true }); // what installFromUrl records
});
after(() => srv.close());

test("registration: keyless providers register connections (no secret), keyed ones still require the key, on-device has nothing to register", async () => {
  // Keyed provider without a key: unchanged, still a 400.
  let r = await req(srv.base, "POST", "/api/admin/ai-keys", { sid: admin.sid, body: { name: "K", provider: "anthropic" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /key required/);

  // On-device provider: no accounts at all — a readable refusal.
  r = await req(srv.base, "POST", "/api/admin/ai-keys", { sid: admin.sid, body: { name: "L", provider: "local" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /on-device/);

  // Keyless-networked: the row lands with no secret; the list shows it honestly.
  r = await req(srv.base, "POST", "/api/admin/ai-keys", { sid: admin.sid, body: { name: "Homelab", provider: "acme.selfhosted" } });
  assert.equal(r.status, 200);
  const list = (await req(srv.base, "GET", "/api/admin/ai-keys", { sid: admin.sid })).json;
  const row = list.find((k) => k.provider === "acme.selfhosted");
  assert.equal(row.name, "Homelab");
  assert.equal(row.hint, "no key");

  // A keyless provider may still carry a token (reverse proxy in front of the box).
  r = await req(srv.base, "POST", "/api/admin/ai-keys", { sid: admin.sid, body: { name: "Proxied", provider: "acme.selfhosted", key: "tok-9876" } });
  assert.equal(r.status, 200);
  const proxied = (await req(srv.base, "GET", "/api/admin/ai-keys", { sid: admin.sid })).json.find((k) => k.name === "Proxied");
  assert.equal(proxied.hint, "…9876");
});

test("resolution: the default tagger and a board both resolve a keyless connection with apiKey null", async () => {
  const rows = (await req(srv.base, "GET", "/api/admin/ai-keys", { sid: admin.sid })).json;
  const conn = rows.find((k) => k.name === "Homelab");

  const r = await req(srv.base, "POST", "/api/admin/ai-config", { sid: admin.sid, body: { defaultKeyId: conn.id } });
  assert.equal(r.status, 200);

  const def = await resolveDefaultAi(db);
  assert.equal(def.provider, "acme.selfhosted");
  assert.equal(def.apiKey, null, "keyless connection → apiKey null all the way to the wire");
  assert.equal(def.model, "acme-llm");

  const board = await resolveBoardAi(db, { aiKeyId: conn.id, aiModel: "acme-llm" });
  assert.equal(board.provider, "acme.selfhosted");
  assert.equal(board.apiKey, null);
});

test("resolution: a keyless connection backs the embedder slot; on-device stays name-selected", async () => {
  const rows = (await req(srv.base, "GET", "/api/admin/ai-keys", { sid: admin.sid })).json;
  const conn = rows.find((k) => k.name === "Homelab");

  // Key-row path (keyless-networked): picked like any keyed embedder.
  let r = await req(srv.base, "POST", "/api/admin/ai-config", {
    sid: admin.sid,
    body: { embedProvider: null, embedKeyId: conn.id, embedModel: "acme-embedder", embedEnabled: true },
  });
  assert.equal(r.status, 200);
  let em = await resolveEmbedder(db);
  assert.equal(em.provider, "acme.selfhosted");
  assert.equal(em.apiKey, null);
  assert.equal(em.model, "acme-embedder");

  // Name path: only on-device providers qualify (a keyed name is a 400)…
  r = await req(srv.base, "POST", "/api/admin/ai-config", { sid: admin.sid, body: { embedProvider: "anthropic" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /on-device/);

  // …and the local pick still works exactly as before.
  r = await req(srv.base, "POST", "/api/admin/ai-config", { sid: admin.sid, body: { embedProvider: "local", embedEnabled: true } });
  assert.equal(r.status, 200);
  em = await resolveEmbedder(db);
  assert.equal(em.provider, "local");
  assert.equal(em.apiKey, null);
});

test("a connection's server URL overrides the descriptor base — proven on a live socket", async () => {
  // A tiny stand-in for an Ollama box: records what arrives, answers the
  // compat models probe. This exercises the WHOLE chain — row → route →
  // testKey dispatch → compat wire — not just the parsing.
  const hits = [];
  const box = http.createServer((rq, rs) => {
    hits.push({ url: rq.url, auth: rq.headers.authorization || null });
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ id: "acme-llm" }));
  });
  await new Promise((r) => box.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${box.address().port}/v1`;
  try {
    const add = await req(srv.base, "POST", "/api/admin/ai-keys", {
      sid: admin.sid,
      body: { name: "Boxed", provider: "acme.selfhosted", base_url: base + "/" }, // trailing slash normalizes away
    });
    assert.equal(add.status, 200);
    const listed = (await req(srv.base, "GET", "/api/admin/ai-keys", { sid: admin.sid })).json.find((k) => k.name === "Boxed");
    assert.equal(listed.base_url, base);

    const t = await req(srv.base, "POST", `/api/admin/ai-keys/${add.json.id}/test`, { sid: admin.sid });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.equal(hits.length, 1, "the call hit the CONNECTION's server, not the descriptor default");
    assert.equal(hits[0].url, "/v1/models/acme-llm");
    assert.equal(hits[0].auth, null, "keyless → no Authorization header on the wire");

    // The resolved-ai object carries the base wherever a board points at the row.
    const board = await resolveBoardAi(db, { aiKeyId: Number(add.json.id), aiModel: null });
    assert.equal(board.base, base);
    assert.equal(board.apiKey, null);
  } finally {
    box.close();
  }
});

test("PATCH /api/admin/ai-keys/:id: edit in place — rename, repoint, rotate — the row id survives", async () => {
  const boxed = (await req(srv.base, "GET", "/api/admin/ai-keys", { sid: admin.sid })).json.find((k) => k.name === "Boxed");

  // Rename + repoint in one PATCH; trailing slash still normalizes.
  let r = await req(srv.base, "PATCH", `/api/admin/ai-keys/${boxed.id}`, {
    sid: admin.sid, body: { name: "Boxed 2", base_url: "http://10.0.0.9:11434/v1/" },
  });
  assert.equal(r.status, 200);
  let row = (await req(srv.base, "GET", "/api/admin/ai-keys", { sid: admin.sid })).json.find((k) => k.id === boxed.id);
  assert.equal(row.name, "Boxed 2");
  assert.equal(row.base_url, "http://10.0.0.9:11434/v1");

  // Blank URL = back to the descriptor default (acme.selfhosted ships one).
  r = await req(srv.base, "PATCH", `/api/admin/ai-keys/${boxed.id}`, { sid: admin.sid, body: { base_url: "" } });
  assert.equal(r.status, 200);
  row = (await req(srv.base, "GET", "/api/admin/ai-keys", { sid: admin.sid })).json.find((k) => k.id === boxed.id);
  assert.equal(row.base_url, null);

  // A malformed URL refuses readably.
  r = await req(srv.base, "PATCH", `/api/admin/ai-keys/${boxed.id}`, { sid: admin.sid, body: { base_url: "ftp://nope" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /http/);

  // Secret rotation: non-empty replaces, blank keeps.
  const kid = Number(await createAiKey(db, "Rotate me", "anthropic", "sk-old-1234"));
  r = await req(srv.base, "PATCH", `/api/admin/ai-keys/${kid}`, { sid: admin.sid, body: { key: "sk-new-5678" } });
  assert.equal(r.status, 200);
  assert.equal((await getAiKey(db, kid)).api_key, "sk-new-5678");
  r = await req(srv.base, "PATCH", `/api/admin/ai-keys/${kid}`, { sid: admin.sid, body: { name: "Rotated", key: "" } });
  assert.equal(r.status, 200);
  assert.equal((await getAiKey(db, kid)).api_key, "sk-new-5678", "blank key = keep the stored one");
  await deleteAiKey(db, kid);
});

test("registration guard: a needsBase provider with no default base requires the URL up front", async () => {
  registerProvider("nodefault", {
    label: "No Default", keyless: true, needsBase: true, rpm: 1, burst: 1,
    wire: { tag() {} }, defaultModel: "m", models: [{ id: "m", label: "m" }],
  });
  try {
    let r = await req(srv.base, "POST", "/api/admin/ai-keys", { sid: admin.sid, body: { name: "X", provider: "nodefault" } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /server URL required/);
    r = await req(srv.base, "POST", "/api/admin/ai-keys", { sid: admin.sid, body: { name: "X", provider: "nodefault", base_url: "http://127.0.0.1:9/v1" } });
    assert.equal(r.status, 200);
    await deleteAiKey(db, Number(r.json.id));
  } finally {
    unregisterProvider("nodefault");
  }
});

test("deleteAiKey: the transcribe slot pointers clear with their key, like embed's do", async () => {
  const id = Number(await createAiKey(db, "Transcribe key", "anthropic", "sk-test"));
  await setSetting(db, "transcribe_provider", "anthropic");
  await setSetting(db, "transcribe_key_id", String(id));
  await setSetting(db, "transcribe_model", "some-model");
  await deleteAiKey(db, id);
  assert.equal(await getSetting(db, "transcribe_provider"), null, "provider pointer cleared → honest whisper fallback");
  assert.equal(await getSetting(db, "transcribe_key_id"), null);
  assert.equal(await getSetting(db, "transcribe_model"), null);
});

// LAST test — uninstall unregisters acme.selfhosted, which the tests above use.
test("uninstall: name-based slot pointers (on-device selection) clear with the plugin", async () => {
  await upsertExternalPlugin(db, {
    id: "ai:acme.selfhosted",
    kind: "ai-provider",
    sourceUrl: "file:/fixture",
    resolvedRef: "local",
    dir: srv.pluginsDir + "/acme.selfhosted@test", // never created — rmSync(force) no-ops
    manifest: { id: "acme.selfhosted", apiVersion: 1, kind: "ai-provider", label: "Acme Self-Hosted", main: "index.js" },
  });
  // Point both name-selected slots at the plugin, as if it were on-device.
  await setSetting(db, "embed_provider", "acme.selfhosted");
  await setSetting(db, "embed_enabled", "1");
  await setSetting(db, "transcribe_provider", "acme.selfhosted");

  await uninstall(db, "ai:acme.selfhosted");

  assert.equal(await getSetting(db, "embed_provider"), null, "embed name pointer cleared — no silent re-activation on reinstall");
  assert.equal(await getSetting(db, "embed_enabled"), null);
  assert.equal(await getSetting(db, "transcribe_provider"), null, "transcribe name pointer cleared");
  assert.equal(PROVIDERS["acme.selfhosted"], undefined, "provider unregistered");
});
