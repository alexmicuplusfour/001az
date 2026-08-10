// Provider registry: descriptor integrity, the capabilities-as-data that
// replaced the old `if (provider === …)` branches, and the catalog callers
// read through PROVIDERS directly. compat/anthropic request *shapes* are
// pinned separately in compat.test.js / research.test.js / extraction.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import { PROVIDERS, providerCatalog } from "../server/providers.js";

test("every descriptor is well-formed and self-named", () => {
  assert.deepEqual(Object.keys(PROVIDERS), ["local", "whisper", "localDetector", "anthropic", "openai", "gemini", "glm", "openrouter"]);
  for (const name of Object.keys(PROVIDERS)) {
    const d = PROVIDERS[name];
    assert.equal(d.name, name, `${name}: self-reference stamped`);
    assert.equal(typeof d.label, "string");
    assert.equal(typeof d.research, "boolean");
    if (d.onDevice) continue; // local/whisper: on-device, no tagger models (local's wire is embed-only)
    assert.ok(d.wire && typeof d.wire.tag === "function", `${name}: has a wire family`);
    assert.ok(Array.isArray(d.models) && d.models.length, `${name}: has a model catalog`);
    for (const m of d.models) assert.equal(typeof m.note, "string", `${name}/${m.id}: note is a string`);
    assert.ok(d.models.some((m) => m.id === d.defaultModel), `${name}: default ${d.defaultModel} is in models`);
  }
});

test("capabilities-as-data: compat quirks match what the wire code reads", () => {
  // openai forces via "required" (2026-07-29: the gpt-5 family flags the
  // NAMED force as invalid_prompt; with one tool the guarantee is the same),
  // accepts strict, keeps thinking, probes /models
  // …and samples tagging at temperature 0, except on the families that hard-400
  // on any non-default value: the o-series and the gpt-5 BASE family (gpt-5-mini
  // included — this descriptor's own defaultModel). noTemperature is a model-id
  // regex and both families' ids pass the tagging modelFilter. It is a fast
  // path, not the safety net — compat.js recovers from the rejection at call
  // time for ids no regex anticipated.
  assert.deepEqual(PROVIDERS.openai.compat, {
    maxTokensField: "max_completion_tokens", forceToolChoice: "required", strictTools: true, disableThinking: false, keyTest: "models",
    temperature: 0, noTemperature: "^(o\\d|gpt-5(-|$))",
  });
  // gemini additionally normalizes its compat layer's "models/…" listing ids,
  // and takes temperature 0 with no guard — no Gemini family rejects it
  assert.deepEqual(PROVIDERS.gemini.compat, {
    maxTokensField: "max_tokens", forceToolChoice: true, strictTools: true, disableThinking: false, keyTest: "models", stripListPrefix: "models/",
    temperature: 0,
  });
  // GLM is the divergent one — every field flips, the completion key-test, and
  // no models endpoint at all (listModels: false → the picker gets the curated
  // fallback). Distinct from OpenRouter below: keyTest "completion" only means
  // no per-model GET; OpenRouter lists fine.
  assert.deepEqual(PROVIDERS.glm.compat, {
    maxTokensField: "max_tokens", forceToolChoice: false, strictTools: false, disableThinking: true, keyTest: "completion", listModels: false,
  });
  // OpenRouter fills a new cell: forces the tool call like openai but skips
  // strict (backends vary), max_tokens, completion key-test (no per-model GET).
  // Deliberately NO temperature — like GLM above, for the opposite reason: GLM
  // could not be probed, OpenRouter fronts too many backends (including
  // openai/o-series) for one passing probe to generalise.
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
  assert.equal(glm.provides.embed, undefined); // no embeddings
  const openai = cat.find((p) => p.name === "openai");
  assert.equal(openai.provides.embed.default, "text-embedding-3-small");
  // no wire functions / compat internals cross the boundary. `base` crosses
  // ONLY as a needsBase provider's suggested default (the connection form's
  // placeholder); every built-in is fixed-endpoint, so it stays null here.
  for (const p of cat) {
    assert.equal(p.wire, undefined);
    assert.equal(p.compat, undefined);
    assert.equal(p.needsBase, false);
    assert.equal(p.base, null);
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
  assert.deepEqual(installed, ["anthropic", "local", "localDetector", "whisper"]);
});
