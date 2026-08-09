// The `provides` normal form (capabilities-plan.md, slice 1).
//
// Slice 1 is a read-side normalization with NO behaviour change: every legacy
// capability field stays on the descriptor and in the catalog, and `provides` is
// derived from them. So these tests assert two things and nothing else — that
// the derivation agrees with the legacy fields for every registered provider,
// and that the shapes which have historically been load-bearing (a truthy-but-
// empty catalog, an explicitly-null wire.tag, the JSON boundary) survive it.
//
// No existing test file is touched by this slice; if one needs editing, the
// normalization stopped being read-side.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS, providerCatalog, normalizeProvides, registerProvider, unregisterProvider, WIRES,
} from "../server/providers.js";
import { CAPABILITY_IDS } from "../server/capabilities.js";
import { getPluginDef } from "../server/plugins.js";
import { startServer, adminSession, req } from "./helpers.js";

test("provides agrees with the legacy fields for every registered provider", () => {
  for (const [name, d] of Object.entries(PROVIDERS)) {
    assert.ok(d.provides, `${name}: install() stamped provides`);
    // Tagging is declared by wire.tag EXISTING — local sets it to null, which is
    // not the same as absent, and `"tag" in wire` would get it wrong.
    assert.equal(!!d.provides.tag, !!d.wire?.tag, `${name}: tag`);
    assert.equal(d.provides.embed ?? null, d.embeds ?? null, `${name}: embed`);
    assert.equal(d.provides.transcribe ?? null, d.transcribes ?? null, `${name}: transcribe`);
    assert.equal(d.provides.detect ?? null, d.detects ?? null, `${name}: detect`);
    assert.equal(!!d.provides.research, !!d.research, `${name}: research`);
    if (d.provides.tag) {
      assert.equal(d.provides.tag.default, d.defaultModel, `${name}: tag default is defaultModel`);
      assert.equal(d.provides.tag.filter, d.modelFilter ?? null, `${name}: tag filter is modelFilter`);
    }
  }
});

test("no capability key is ever `undefined` — absent means absent", () => {
  for (const [name, d] of Object.entries(PROVIDERS)) {
    for (const [cap, v] of Object.entries(d.provides))
      assert.notEqual(v, undefined, `${name}: provides.${cap} is undefined rather than absent`);
    // The tag catalog crosses the JSON boundary too.
    if (d.provides.tag)
      for (const [k, v] of Object.entries(d.provides.tag))
        assert.notEqual(v, undefined, `${name}: provides.tag.${k} is undefined`);
  }
});

// providerCatalog() is deep-compared against the route's JSON in
// providers.test.js. JSON drops undefined-valued keys and functions, and
// deepStrictEqual treats { a: undefined } and {} as different objects — so a
// single undefined anywhere in `provides` would break that test in a way whose
// cause is nowhere near its symptom. Assert the invariant at its source.
test("the catalog survives a JSON round-trip unchanged", () => {
  const cat = providerCatalog();
  assert.deepEqual(JSON.parse(JSON.stringify(cat)), cat);
});

test("the whisper sidecar's empty catalog stays truthy — advertising is not the same as offering models", () => {
  const w = PROVIDERS.whisper.provides.transcribe;
  assert.ok(w, "advertises transcription");
  assert.equal(w.default, null, "the model is baked into the sidecar image, not declared here");
  assert.deepEqual(w.models, []);
  // …and it survives into the served catalog the same way.
  assert.ok(providerCatalog().find((p) => p.name === "whisper").transcribes);
});

test("an embed-only on-device provider declares embed and nothing else", () => {
  // local sets wire.tag = null explicitly; that must not read as "tags".
  assert.deepEqual(Object.keys(PROVIDERS.local.provides), ["embed"]);
  assert.deepEqual(getPluginDef("ai:local").capabilities,
    Object.fromEntries(CAPABILITY_IDS.map((c) => [c, c === "embed"])));
});

test("a legacy-shaped and a provides-shaped descriptor produce identical catalog entries", () => {
  const models = [{ id: "m-1", note: "only" }];
  const embeds = { default: "e-1", models: [{ id: "e-1", note: "only" }], filter: "^e-" };
  registerProvider("shape.legacy", {
    label: "Shape", keyless: true, rpm: 10, burst: 2, wire: WIRES.compat,
    defaultModel: "m-1", models, modelFilter: "^m-", research: false, embeds,
  });
  registerProvider("shape.modern", {
    label: "Shape", keyless: true, rpm: 10, burst: 2, wire: WIRES.compat,
    provides: { tag: { models, default: "m-1", filter: "^m-" }, embed: embeds },
  });
  try {
    const strip = (p) => { const { name, ...rest } = p; return rest; };
    const cat = Object.fromEntries(providerCatalog().map((p) => [p.name, p]));
    assert.deepEqual(strip(cat["shape.modern"]), strip(cat["shape.legacy"]));
  } finally {
    unregisterProvider("shape.legacy");
    unregisterProvider("shape.modern");
  }
});

test("a hybrid descriptor keeps both halves — an explicit provides wins per capability, it does not replace the map", () => {
  const p = normalizeProvides({
    wire: { tag: () => {} }, defaultModel: "m-1", models: [],
    embeds: { default: "e-1", models: [] },          // legacy half
    provides: { tag: { models: [], default: "override", filter: null } }, // modern half
  });
  assert.equal(p.tag.default, "override", "the explicit declaration wins for its own capability");
  assert.ok(p.embed, "the legacy declaration for a DIFFERENT capability survives");
});

test("a sidecar's live model lands in both shapes — neither can be read stale", async () => {
  // /api/admin/plugins overrides whisper's and localDetector's catalogs with what
  // the sidecar's /health reports. The legacy field and `provides` must agree, or
  // a reader picks up a stale model depending on which one it happens to read.
  const srv = await startServer();
  try {
    const admin = await adminSession(srv.db);
    const r = await req(srv.base, "GET", "/api/admin/plugins", { sid: admin.sid });
    const byId = Object.fromEntries(r.json.plugins.map((p) => [p.id, p]));
    assert.deepEqual(byId["ai:whisper"].ai.provides.transcribe, byId["ai:whisper"].ai.transcribes);
    assert.deepEqual(byId["ai:localDetector"].ai.provides.detect, byId["ai:localDetector"].ai.detects);
  } finally {
    await srv.close();
  }
});

test("providerCatalog exposes provides without leaking the server-side carving data", () => {
  const openai = providerCatalog().find((p) => p.name === "openai");
  assert.ok(openai.provides.tag.filter, "the descriptor's normal form keeps the filter");
  // …but the UI-facing per-capability entry is narrower: pickers get models +
  // default, never the regex used to carve a live list.
  assert.deepEqual(Object.keys(openai.embeds).sort(), ["default", "models"]);
});
