// Provider registry: descriptor integrity, the capabilities-as-data that
// replaced the old `if (provider === …)` branches, and the derived views that
// callers import. compat/anthropic request *shapes* are pinned separately in
// compat.test.js / research.test.js / extraction.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import {
  PROVIDERS, PROVIDER_NAMES, PROVIDER_DEFAULT_MODEL,
  EMBED_PROVIDERS, PROVIDER_DEFAULT_EMBED_MODEL, providerCatalog,
} from "../server/providers.js";

test("every descriptor is well-formed and self-named", () => {
  assert.deepEqual(PROVIDER_NAMES, ["anthropic", "openai", "gemini", "glm"]);
  for (const name of PROVIDER_NAMES) {
    const d = PROVIDERS[name];
    assert.equal(d.name, name, `${name}: self-reference stamped`);
    assert.equal(typeof d.label, "string");
    assert.ok(d.wire && typeof d.wire.tag === "function", `${name}: has a wire family`);
    assert.ok(Array.isArray(d.models) && d.models.length, `${name}: has a model catalog`);
    for (const m of d.models) assert.equal(typeof m.note, "string", `${name}/${m.id}: note is a string`);
    // the default is always offered in the catalog
    assert.ok(d.models.some((m) => m.id === d.defaultModel), `${name}: default ${d.defaultModel} is in models`);
    assert.equal(typeof d.research, "boolean");
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
  // Anthropic is the only research-capable provider and has no compat block
  assert.equal(PROVIDERS.anthropic.research, true);
  assert.equal(PROVIDERS.anthropic.compat, undefined);
  for (const name of ["openai", "gemini", "glm"]) assert.equal(PROVIDERS[name].research, false);
});

test("derived views are computed from the registry, not hand-listed", () => {
  assert.equal(PROVIDER_DEFAULT_MODEL.glm, "glm-4.6v");
  assert.equal(PROVIDER_DEFAULT_MODEL.anthropic, "claude-haiku-4-5");
  // only providers with an embeds block are embeddings-capable
  assert.deepEqual(EMBED_PROVIDERS, ["openai", "gemini"]);
  assert.equal(PROVIDERS.anthropic.embeds, null);
  assert.equal(PROVIDERS.glm.embeds, null);
  for (const name of EMBED_PROVIDERS) {
    const def = PROVIDER_DEFAULT_EMBED_MODEL[name];
    assert.ok(PROVIDERS[name].embeds.models.some((m) => m.id === def), `${name}: default embed model is in its list`);
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
  assert.deepEqual(cat.map((p) => p.name), PROVIDER_NAMES);
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

test("GET /api/admin/ai-providers: admin-only, returns the catalog", async () => {
  const anon = await req(base, "GET", "/api/admin/ai-providers");
  assert.equal(anon.status, 403); // requireAdmin rejects anonymous

  const r = await req(base, "GET", "/api/admin/ai-providers", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, providerCatalog());
});
