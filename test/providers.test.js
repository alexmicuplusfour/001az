// Provider registry: descriptor integrity, the capabilities-as-data that
// replaced the old `if (provider === …)` branches, and the catalog callers
// read through PROVIDERS directly. compat/anthropic request *shapes* are
// pinned separately in compat.test.js / research.test.js / extraction.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import { PROVIDERS, providerCatalog } from "../server/providers.js";

test("every descriptor is well-formed and self-named", () => {
  assert.deepEqual(Object.keys(PROVIDERS), ["local", "whisper", "anthropic", "openai", "gemini", "glm", "openrouter"]);
  for (const name of Object.keys(PROVIDERS)) {
    const d = PROVIDERS[name];
    assert.equal(d.name, name, `${name}: self-reference stamped`);
    assert.equal(typeof d.label, "string");
    assert.equal(typeof d.research, "boolean");
    if (d.keyless) continue; // local: no wire, no tagger models — embed-only
    assert.ok(d.wire && typeof d.wire.tag === "function", `${name}: has a wire family`);
    assert.ok(Array.isArray(d.models) && d.models.length, `${name}: has a model catalog`);
    for (const m of d.models) assert.equal(typeof m.note, "string", `${name}/${m.id}: note is a string`);
    assert.ok(d.models.some((m) => m.id === d.defaultModel), `${name}: default ${d.defaultModel} is in models`);
  }
});

test("capabilities-as-data: compat quirks match what the wire code reads", () => {
  // openai/gemini force the tool call, accept strict, keep thinking, probe /models
  for (const name of ["openai", "gemini"]) {
    assert.deepEqual(PROVIDERS[name].compat, {
      maxTokensField: name === "openai" ? "max_completion_tokens" : "max_tokens",
      forceToolChoice: true, strictTools: true, disableThinking: false, keyTest: "models",
    }, `${name} compat`);
  }
  // GLM is the divergent one — every field flips, plus the completion key-test
  assert.deepEqual(PROVIDERS.glm.compat, {
    maxTokensField: "max_tokens", forceToolChoice: false, strictTools: false, disableThinking: true, keyTest: "completion",
  });
  // OpenRouter fills a new cell: forces the tool call like openai but skips
  // strict (backends vary), max_tokens, completion key-test (no per-model GET)
  assert.deepEqual(PROVIDERS.openrouter.compat, {
    maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "completion",
  });
  // Anthropic is the only research-capable provider and has no compat block
  assert.equal(PROVIDERS.anthropic.research, true);
  assert.equal(PROVIDERS.anthropic.compat, undefined);
  for (const name of ["openai", "gemini", "glm", "openrouter"]) assert.equal(PROVIDERS[name].research, false);
});

test("defaults and embed capability read straight off the descriptor", () => {
  assert.equal(PROVIDERS.glm.defaultModel, "glm-4.6v");
  assert.equal(PROVIDERS.anthropic.defaultModel, "claude-haiku-4-5");
  // `embeds` is both the capability flag and the config: local + openai + gemini
  const embedNames = Object.keys(PROVIDERS).filter((n) => PROVIDERS[n].embeds);
  assert.deepEqual(embedNames, ["local", "openai", "gemini"]);
  assert.equal(PROVIDERS.anthropic.embeds, null);
  assert.equal(PROVIDERS.glm.embeds, null);
  for (const name of embedNames) {
    const { default: def, models } = PROVIDERS[name].embeds;
    assert.ok(models.some((m) => m.id === def), `${name}: default embed model is in its list`);
  }
});

test("wire family shared: gemini and glm ride the same compat code as openai", () => {
  assert.equal(PROVIDERS.gemini.wire, PROVIDERS.openai.wire);
  assert.equal(PROVIDERS.glm.wire, PROVIDERS.openai.wire);
  assert.notEqual(PROVIDERS.anthropic.wire, PROVIDERS.openai.wire);
  // the compat family has embeddings; the anthropic family does not
  assert.equal(typeof PROVIDERS.openai.wire.embed, "function");
  assert.equal(PROVIDERS.anthropic.wire.embed, null);
});

test("providerCatalog exposes the UI-facing shape and leaks no internals", () => {
  const cat = providerCatalog();
  assert.deepEqual(cat.map((p) => p.name), Object.keys(PROVIDERS));
  const glm = cat.find((p) => p.name === "glm");
  assert.equal(glm.defaultModel, "glm-4.6v");
  assert.ok(glm.models.some((m) => m.id === "glm-5.2" && /text/.test(m.note)));
  assert.equal(glm.embeds, null); // no embeddings
  const openai = cat.find((p) => p.name === "openai");
  assert.equal(openai.embeds.default, "text-embedding-3-small");
  // no wire functions / compat internals cross the boundary
  for (const p of cat) {
    assert.equal(p.wire, undefined);
    assert.equal(p.compat, undefined);
    assert.equal(p.base, undefined);
  }
});

// --- the served endpoint ---

let srv, db, base, admin;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});
after(() => srv.close());

test("GET /api/admin/ai-providers: admin-only, returns the catalog + install flags", async () => {
  const anon = await req(base, "GET", "/api/admin/ai-providers");
  assert.equal(anon.status, 403); // requireAdmin rejects anonymous

  const r = await req(base, "GET", "/api/admin/ai-providers", { sid: admin.sid });
  assert.equal(r.status, 200);
  // the static catalog rides through untouched, plus a per-provider install flag
  assert.deepEqual(r.json.map(({ installed, ...rest }) => rest), providerCatalog());
  // fresh install: the core on-device engines (embedder + whisper transcriber)
  // and the pre-added flagship are installed
  const installed = r.json.filter((p) => p.installed).map((p) => p.name).sort();
  assert.deepEqual(installed, ["anthropic", "local", "whisper"]);
});
