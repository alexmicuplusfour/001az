// Dynamic model discovery — the app asks the provider what models exist
// instead of trusting the descriptor's hardcoded list. Three layers:
// the compat wire's listModels (GET {base}/models), the engine's
// listProviderModels merge (live ids under the curated picks, descriptor
// fallback on any failure — never a throw), and the per-connection route
// (GET /api/admin/ai-keys/:id/models) with its TTL cache. The descriptor
// `models` list survives as recommendations + offline fallback only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, adminSession, req } from "./helpers.js";
import { PROVIDERS, listProviderModels, registerProvider, unregisterProvider, WIRES } from "../server/providers.js";
import { compatWire } from "../server/ai-providers/wires/compat.js";

// A tiny stand-in for a compat server: counts hits, serves a fixed /models
// list (or an error), like the keyless-providers live-socket tests.
function fakeBox(models, { status = 200 } = {}) {
  const box = http.createServer((rq, rs) => {
    box.hits.push(rq.url);
    rs.writeHead(status, { "Content-Type": "application/json" });
    rs.end(JSON.stringify(status === 200 ? { data: models.map((id) => ({ id })) } : { error: { message: "boom" } }));
  });
  box.hits = [];
  return new Promise((resolve) => box.listen(0, "127.0.0.1", () => resolve(box)));
}
const baseOf = (box) => `http://127.0.0.1:${box.address().port}/v1`;

const COMPAT = { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "models" };

// --- the wire ---

test("compat listModels: GET {base}/models → [{ id }], junk rows dropped", async () => {
  const box = await fakeBox(["beta", "alpha", ""]);
  try {
    const out = await compatWire.listModels({ label: "Fake", compat: COMPAT }, { apiKey: "sk-1", base: baseOf(box) });
    assert.deepEqual(out, [{ id: "beta" }, { id: "alpha" }], "ids as served (engine sorts), empty id dropped");
    assert.deepEqual(box.hits, ["/v1/models"]);
  } finally {
    box.close();
  }
});

test("compat listModels: stripListPrefix normalizes vendor-prefixed ids (Gemini lists models/…, chats with bare ids)", async () => {
  const box = await fakeBox(["models/gem-1", "plain"]);
  try {
    const out = await compatWire.listModels({ label: "G", compat: { ...COMPAT, stripListPrefix: "models/" } }, { apiKey: "k", base: baseOf(box) });
    assert.deepEqual(out, [{ id: "gem-1" }, { id: "plain" }]);
  } finally {
    box.close();
  }
});

test("compat listModels: a provider with no models endpoint (listModels: false) answers null without a network call", async () => {
  const out = await compatWire.listModels({ label: "GLM-ish", compat: { ...COMPAT, listModels: false } }, { apiKey: "sk-1", base: "http://127.0.0.1:9/v1" });
  assert.equal(out, null);
});

test("every wire family serves the same listModels contract", () => {
  assert.equal(typeof WIRES.compat.listModels, "function");
  assert.equal(typeof WIRES.anthropic.listModels, "function");
});

// --- the engine merge ---

test("listProviderModels: live list under the curated picks — retired ids drop, the rest sorts in, notes win", async () => {
  const box = await fakeBox(["zeta", "rec-1", "alpha"]);
  registerProvider("modeltest", {
    label: "Model Test", keyless: true, needsBase: true, rpm: 10, burst: 2,
    wire: WIRES.compat, compat: COMPAT, base: baseOf(box),
    defaultModel: "rec-1", research: false,
    models: [
      { id: "rec-1", note: "curated pick" },
      { id: "retired-0", note: "gone upstream" },
    ],
  });
  try {
    const r = await listProviderModels({ provider: "modeltest", apiKey: null });
    assert.equal(r.source, "live");
    assert.deepEqual(r.models, [
      { id: "rec-1", note: "curated pick", recommended: true }, // curated + alive → pinned first, note kept
      { id: "alpha" }, // the rest of the live list, sorted
      { id: "zeta" },
    ], "retired-0 dropped — the provider owns existence");

    // Wire failure → the curated list serves, flagged as such, no throw.
    box.close();
    const down = await listProviderModels({ provider: "modeltest", apiKey: null });
    assert.equal(down.source, "fallback");
    assert.deepEqual(down.models.map((m) => m.id), ["rec-1", "retired-0"]);
    assert.ok(down.models.every((m) => m.recommended), "fallback = the recommended set");
  } finally {
    box.close();
    unregisterProvider("modeltest");
  }
});

test("listProviderModels: a descriptor with no curated models array (embed-only plugin) merges without crashing", async () => {
  const box = await fakeBox(["m2", "m1"]);
  registerProvider("nomodels", {
    label: "No Models", keyless: true, needsBase: true, rpm: 10, burst: 2,
    wire: WIRES.compat, compat: COMPAT, base: baseOf(box), research: false,
  });
  try {
    const r = await listProviderModels({ provider: "nomodels", apiKey: null });
    assert.equal(r.source, "live");
    assert.deepEqual(r.models, [{ id: "m1" }, { id: "m2" }], "live list alone — the plugin contract never required `models`");
  } finally {
    box.close();
    unregisterProvider("nomodels");
  }
});

test("capability kinds: a declared filter carves the live list; a capability catalog WITHOUT one stays curated (an unfiltered dump would be noise)", async () => {
  const box = await fakeBox(["chat-1", "embed-large", "embed-small"]);
  registerProvider("kinds", {
    label: "Kinds", keyless: true, needsBase: true, rpm: 10, burst: 2,
    wire: WIRES.compat, compat: COMPAT, base: baseOf(box), research: false,
    defaultModel: "chat-1", models: [{ id: "chat-1", note: "chat" }],
    modelFilter: "^chat-",
    embeds: { default: "embed-small", models: [{ id: "embed-small", note: "curated" }], filter: "^embed-" },
    transcribes: { default: "t-1", models: [{ id: "t-1", note: "curated only" }] }, // no filter on purpose
  });
  try {
    const tag = await listProviderModels({ provider: "kinds", apiKey: null });
    assert.deepEqual(tag.models.map((m) => m.id), ["chat-1"], "tagging filter drops the embedders");
    const em = await listProviderModels({ provider: "kinds", apiKey: null, kind: "embed" });
    assert.equal(em.source, "live");
    assert.deepEqual(em.models, [
      { id: "embed-small", note: "curated", recommended: true },
      { id: "embed-large" },
    ]);
    const tr = await listProviderModels({ provider: "kinds", apiKey: null, kind: "transcribe" });
    assert.equal(tr.source, "fallback", "no filter → the live dump is never poured into a capability picker");
    assert.deepEqual(tr.models.map((m) => m.id), ["t-1"]);
  } finally {
    box.close();
    unregisterProvider("kinds");
  }
});

test("listProviderModels: no listing wire (on-device local) and unknown providers both fall back quietly", async () => {
  const local = await listProviderModels({ provider: "local" });
  assert.equal(local.source, "fallback");
  const gone = await listProviderModels({ provider: "uninstalled-plugin" });
  assert.deepEqual(gone, { source: "fallback", models: [] }, "a row whose plugin was uninstalled serves empty, not a crash");
});

// --- the route + cache ---

let srv, db, admin, box;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  admin = await adminSession(db);
  box = await fakeBox(["pulled:latest", "rec-1", "nomic-embed-text"]);
  registerProvider("modelbox", {
    label: "Model Box", keyless: true, needsBase: true, rpm: 10, burst: 2,
    wire: WIRES.compat, compat: COMPAT, base: null,
    defaultModel: "rec-1", research: false,
    models: [{ id: "rec-1", note: "curated pick" }],
    modelFilter: "^(?!.*embed)",
    embeds: { default: "nomic-embed-text", models: [{ id: "nomic-embed-text", note: "embedder" }], filter: "embed" },
  });
});
after(() => {
  unregisterProvider("modelbox");
  box.close();
  srv.close();
});

test("GET /api/admin/ai-keys/:id/models: admin-only, per-connection, cached until ?refresh=1 or an edit", async () => {
  const add = await req(srv.base, "POST", "/api/admin/ai-keys", {
    sid: admin.sid, body: { name: "Boxed", provider: "modelbox", base_url: baseOf(box) },
  });
  assert.equal(add.status, 200);
  const id = add.json.id;

  const anon = await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models`);
  assert.equal(anon.status, 403);
  const missing = await req(srv.base, "GET", "/api/admin/ai-keys/999999/models", { sid: admin.sid });
  assert.equal(missing.status, 404);

  // First ask hits the CONNECTION's server and merges under the curated pick.
  let r = await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.source, "live");
  assert.deepEqual(r.json.models, [
    { id: "rec-1", note: "curated pick", recommended: true },
    { id: "pulled:latest" },
  ]);
  assert.equal(box.hits.length, 1);

  // Second ask serves the cache — the box is not asked again.
  r = await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models`, { sid: admin.sid });
  assert.equal(r.json.source, "live");
  assert.equal(box.hits.length, 1, "TTL cache absorbed the repeat");

  // ?refresh=1 busts it — the "I just pulled a model" affordance.
  r = await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models?refresh=1`, { sid: admin.sid });
  assert.equal(box.hits.length, 2);

  // Editing the connection (repoint/rotate) busts it too.
  const patch = await req(srv.base, "PATCH", `/api/admin/ai-keys/${id}`, { sid: admin.sid, body: { name: "Boxed 2" } });
  assert.equal(patch.status, 200);
  r = await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models`, { sid: admin.sid });
  assert.equal(box.hits.length, 3, "edit invalidated the cached list");
});

test("AI_MODELS_TTL_MS=0 turns the cache off — the TTL is read per call, 0 means off (the ingestion cacheTtl idiom)", async () => {
  const add = await req(srv.base, "POST", "/api/admin/ai-keys", {
    sid: admin.sid, body: { name: "Uncached", provider: "modelbox", base_url: baseOf(box) },
  });
  assert.equal(add.status, 200);
  const before = box.hits.length;
  process.env.AI_MODELS_TTL_MS = "0";
  try {
    await req(srv.base, "GET", `/api/admin/ai-keys/${add.json.id}/models`, { sid: admin.sid });
    await req(srv.base, "GET", `/api/admin/ai-keys/${add.json.id}/models`, { sid: admin.sid });
    assert.equal(box.hits.length, before + 2, "every request asks the box — nothing served from cache");
  } finally {
    delete process.env.AI_MODELS_TTL_MS;
  }
});

test("?kind=embed|transcribe: capability catalogs carve the SAME cached raw list — one upstream fetch serves all kinds", async () => {
  const add = await req(srv.base, "POST", "/api/admin/ai-keys", {
    sid: admin.sid, body: { name: "Kinds box", provider: "modelbox", base_url: baseOf(box) },
  });
  assert.equal(add.status, 200);
  let r = await req(srv.base, "GET", `/api/admin/ai-keys/${add.json.id}/models`, { sid: admin.sid });
  assert.deepEqual(r.json.models.map((m) => m.id), ["rec-1", "pulled:latest"], "tagging filter drops the embedder");
  const before = box.hits.length;
  r = await req(srv.base, "GET", `/api/admin/ai-keys/${add.json.id}/models?kind=embed`, { sid: admin.sid });
  assert.equal(r.json.source, "live");
  assert.deepEqual(r.json.models, [{ id: "nomic-embed-text", note: "embedder", recommended: true }]);
  assert.equal(box.hits.length, before, "embed kind rode the tagging fetch's cached raw list");
  // No transcribes catalog on this provider → empty fallback, still 200.
  r = await req(srv.base, "GET", `/api/admin/ai-keys/${add.json.id}/models?kind=transcribe`, { sid: admin.sid });
  assert.deepEqual(r.json, { source: "fallback", models: [] });
});

test("GET /api/admin/ai-keys/:id/models: an unreachable box serves the curated fallback as 200, never an error", async () => {
  const add = await req(srv.base, "POST", "/api/admin/ai-keys", {
    sid: admin.sid, body: { name: "Dark box", provider: "modelbox", base_url: "http://127.0.0.1:9/v1" },
  });
  assert.equal(add.status, 200);
  const r = await req(srv.base, "GET", `/api/admin/ai-keys/${add.json.id}/models`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.source, "fallback");
  assert.deepEqual(r.json.models, [{ id: "rec-1", note: "curated pick", recommended: true }]);
});
