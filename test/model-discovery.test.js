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
import { anthropicWire } from "../server/ai-providers/wires/anthropic.js";

// A tiny stand-in for a compat server: counts hits, serves a fixed /models
// list (or an error), like the keyless-providers live-socket tests.
function fakeBox(models, { status = 200, delay = 0 } = {}) {
  // status is read per request off box.status, so a test can flip a box from
  // erroring to healthy (the failure-isn't-cached test) without a second box.
  const box = http.createServer((rq, rs) => {
    box.hits.push(rq.url);
    setTimeout(() => {
      rs.writeHead(box.status, { "Content-Type": "application/json" });
      rs.end(JSON.stringify(box.status === 200 ? { data: models.map((id) => ({ id })) } : { error: { message: "boom" } }));
    }, delay);
  });
  box.status = status;
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

test("compat testKey 'list': probes the models index — a healthy box with nothing pulled tests green; the box's own error still surfaces", async () => {
  const box = await fakeBox([]); // reachable, zero models — the fresh-Ollama shape
  try {
    await compatWire.testKey({ label: "Fresh", defaultModel: "llama3.1:8b", compat: { ...COMPAT, keyTest: "list" } }, { apiKey: null, base: baseOf(box) });
    assert.deepEqual(box.hits, ["/v1/models"], "the index, not /models/{defaultModel}");
    box.status = 500;
    await assert.rejects(
      () => compatWire.testKey({ label: "Fresh", defaultModel: "llama3.1:8b", compat: { ...COMPAT, keyTest: "list" } }, { apiKey: null, base: baseOf(box) }),
      /boom/,
      "a down box still fails the test with its own message"
    );
  } finally {
    box.close();
  }
});

test("every wire family serves the same listModels contract", () => {
  assert.equal(typeof WIRES.compat.listModels, "function");
  assert.equal(typeof WIRES.anthropic.listModels, "function");
});

// A stand-in for Anthropic's models.list: serves page N by hit count, so the
// cursor mechanics stay the SDK's business — has_more: false ends the walk.
function fakeAnthropicBox(pages) {
  const box = http.createServer((rq, rs) => {
    box.hits.push(rq.url);
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify(pages[Math.min(box.hits.length - 1, pages.length - 1)]));
  });
  box.hits = [];
  return new Promise((resolve) => box.listen(0, "127.0.0.1", () => resolve(box)));
}
const rootOf = (box) => `http://127.0.0.1:${box.address().port}`;

test("anthropic listModels: walks the SDK's pagination, display_name rides as the note", async () => {
  const box = await fakeAnthropicBox([
    { data: [{ id: "c-1", display_name: "C One", type: "model" }, { id: "c-2", display_name: "C Two", type: "model" }], has_more: true, first_id: "c-1", last_id: "c-2" },
    { data: [{ id: "c-3", display_name: "C Three", type: "model" }], has_more: false, first_id: "c-3", last_id: "c-3" },
  ]);
  try {
    const out = await anthropicWire.listModels({}, { apiKey: "sk-ant-wiretest", base: rootOf(box) });
    assert.deepEqual(out, [
      { id: "c-1", note: "C One" },
      { id: "c-2", note: "C Two" },
      { id: "c-3", note: "C Three" },
    ], "both pages walked, ids in listing order (the engine sorts)");
    assert.equal(box.hits.length, 2, "has_more page fetched");
  } finally {
    box.close();
  }
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

test("an EMPTY answer marks the suggestions as absent — a healthy box with nothing pulled can't impersonate an installed setup", async () => {
  const box = await fakeBox([]);
  registerProvider("freshbox", {
    label: "Fresh Box", keyless: true, needsBase: true, rpm: 10, burst: 2,
    wire: WIRES.compat, compat: COMPAT, base: baseOf(box), research: false,
    defaultModel: "rec-1",
    models: [{ id: "rec-1", note: "solid pick" }, { id: "rec-2" }],
    embeds: { default: "emb-1", models: [{ id: "emb-1", note: "embedder" }], filter: "emb" },
  });
  try {
    const r = await listProviderModels({ provider: "freshbox", apiKey: null });
    assert.equal(r.source, "fallback");
    assert.deepEqual(r.models, [
      { id: "rec-1", note: "solid pick · not listed by this connection", recommended: true },
      { id: "rec-2", note: "not listed by this connection", recommended: true },
    ], "the provider ANSWERED (empty) — suggestions still serve, marked");
    const em = await listProviderModels({ provider: "freshbox", apiKey: null, kind: "embed" });
    assert.deepEqual(em.models.map((m) => m.note), ["embedder · not listed by this connection"], "filter-to-zero on an answer marks the same way");
    // Unreachable (null live) stays UNMARKED — no evidence of absence.
    box.close();
    const dark = await listProviderModels({ provider: "freshbox", apiKey: null });
    assert.deepEqual(dark.models.map((m) => m.note), ["solid pick", undefined], "couldn't ask → plain suggestions, no absence claim");
  } finally {
    box.close();
    unregisterProvider("freshbox");
  }
});

test("a filter that doesn't compile degrades to the curated fallback — a plugin typo never errors the picker", async () => {
  const box = await fakeBox(["chat-1", "chat-2"]);
  registerProvider("badfilter", {
    label: "Bad Filter", keyless: true, needsBase: true, rpm: 10, burst: 2,
    wire: WIRES.compat, compat: COMPAT, base: baseOf(box), research: false,
    defaultModel: "chat-1", models: [{ id: "chat-1", note: "curated" }],
    modelFilter: "([", // typo'd regex — must degrade, not throw through the route
  });
  try {
    const r = await listProviderModels({ provider: "badfilter", apiKey: null });
    assert.equal(r.source, "fallback");
    assert.deepEqual(r.models, [{ id: "chat-1", note: "curated", recommended: true }]);
  } finally {
    box.close();
    unregisterProvider("badfilter");
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

test("concurrent refreshers ride ONE upstream fetch — the modal's per-kind pickers open together without stampeding the box", async () => {
  // A slow box keeps the first fetch in flight while the other kinds arrive —
  // the real shape of a modal open, where every section sends refresh=1 in
  // the same tick. Refresh must bust settled entries only.
  const slow = await fakeBox(["rec-1", "pulled:latest", "nomic-embed-text"], { delay: 150 });
  try {
    const add = await req(srv.base, "POST", "/api/admin/ai-keys", {
      sid: admin.sid, body: { name: "Slow box", provider: "modelbox", base_url: baseOf(slow) },
    });
    assert.equal(add.status, 200);
    const id = add.json.id;
    const [tag, em, tr] = await Promise.all([
      req(srv.base, "GET", `/api/admin/ai-keys/${id}/models?refresh=1`, { sid: admin.sid }),
      req(srv.base, "GET", `/api/admin/ai-keys/${id}/models?kind=embed&refresh=1`, { sid: admin.sid }),
      req(srv.base, "GET", `/api/admin/ai-keys/${id}/models?kind=transcribe&refresh=1`, { sid: admin.sid }),
    ]);
    assert.equal(slow.hits.length, 1, "three refreshers coalesced onto one in-flight upstream ask");
    assert.equal(tag.json.source, "live");
    assert.deepEqual(em.json.models.map((m) => m.id), ["nomic-embed-text"], "embed kind carved from the shared fetch");
    assert.deepEqual(tr.json, { source: "fallback", models: [] }, "no transcribes catalog on this provider");
    // A refresh AFTER settle still refetches — riding is for in-flight only.
    await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models?refresh=1`, { sid: admin.sid });
    assert.equal(slow.hits.length, 2);
  } finally {
    slow.close();
  }
});

test("a failed fetch is never cached — the picker re-probes and heals the moment the box is back, no refresh or TTL wait", async () => {
  const flaky = await fakeBox(["rec-1", "pulled:latest"], { status: 500 });
  try {
    const add = await req(srv.base, "POST", "/api/admin/ai-keys", {
      sid: admin.sid, body: { name: "Flaky box", provider: "modelbox", base_url: baseOf(flaky) },
    });
    assert.equal(add.status, 200);
    const id = add.json.id;
    let r = await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models`, { sid: admin.sid });
    assert.equal(r.json.source, "fallback");
    assert.equal(flaky.hits.length, 1);
    // The null did NOT enter the cache — a plain revisit re-probes.
    r = await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models`, { sid: admin.sid });
    assert.equal(r.json.source, "fallback");
    assert.equal(flaky.hits.length, 2, "failure served fallback but wasn't cached");
    // Box recovers → the very next plain ask goes live; success caches again.
    flaky.status = 200;
    r = await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models`, { sid: admin.sid });
    assert.equal(r.json.source, "live");
    assert.equal(flaky.hits.length, 3);
    r = await req(srv.base, "GET", `/api/admin/ai-keys/${id}/models`, { sid: admin.sid });
    assert.equal(r.json.source, "live");
    assert.equal(flaky.hits.length, 3, "the healthy answer is cached as before");
  } finally {
    flaky.close();
  }
});

test("GET /api/admin/ai-keys/env/models: the ANTHROPIC_API_KEY-backed row lists too; ?refresh=0 does not bust", async () => {
  const saveKey = process.env.ANTHROPIC_API_KEY, saveBase = process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const gone = await req(srv.base, "GET", "/api/admin/ai-keys/env/models", { sid: admin.sid });
    assert.equal(gone.status, 404, "no env key configured → no env row to ask");

    const abox = await fakeAnthropicBox([
      { data: [{ id: "claude-x-1", display_name: "Claude X" }], has_more: false, first_id: "claude-x-1", last_id: "claude-x-1" },
    ]);
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-envtest";
      // The built-in anthropic descriptor declares no base, so the SDK reads
      // ANTHROPIC_BASE_URL — pointing the env row at the fake box.
      process.env.ANTHROPIC_BASE_URL = rootOf(abox);
      let r = await req(srv.base, "GET", "/api/admin/ai-keys/env/models?refresh=1", { sid: admin.sid });
      assert.equal(r.status, 200);
      assert.equal(r.json.source, "live");
      assert.deepEqual(r.json.models, [{ id: "claude-x-1", note: "Claude X" }]);
      const hits = abox.hits.length;
      r = await req(srv.base, "GET", "/api/admin/ai-keys/env/models?refresh=0", { sid: admin.sid });
      assert.equal(r.json.source, "live");
      assert.equal(abox.hits.length, hits, "refresh=0 rode the cache — only refresh=1 busts");
    } finally {
      abox.close();
    }
  } finally {
    if (saveKey == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saveKey;
    if (saveBase == null) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = saveBase;
  }
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
