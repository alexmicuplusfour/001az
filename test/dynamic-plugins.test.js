// Dynamic plugin loading (phase 2, slice 1): the loader that takes an external
// plugin's on-disk dir, validates its manifest, calls its factory with the ctx
// facade, and registers it into the live registries — provable offline from
// fixtures under test/fixtures/plugins (no network fetch; that's slice 2).
//
// The three invariants: validate-before-any-write (register-last), ctx.fetchJson
// carries the retry protocol so a plugin is callable through the runtime, and a
// bad plugin becomes an errored catalog card instead of crashing boot.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, adminSession, jsonBox } from "./helpers.js";
import { validateManifest, validateBuilt, loadDir, loadAll, unregister, catalogIdFor } from "../server/plugin-loader.js";
import { PLUGIN_API_VERSION, makeCtx } from "../server/plugin-ctx.js";
import { getConnector } from "../server/connectors/index.js";
import { getFaceProducer } from "../server/faces/index.js";
import { PROVIDERS, providerCatalog, WIRES } from "../server/providers.js";
import { pluginCatalog } from "../server/plugins.js";
import { setPluginState, setSetting, upsertExternalPlugin } from "../server/db.js";

const FIX = (name) => fileURLToPath(new URL(`./fixtures/plugins/${name}`, import.meta.url));
const manifestOf = (name) => JSON.parse(fs.readFileSync(path.join(FIX(name), "manifest.json"), "utf8"));

// --- pure loader tests (no db) ---

test("validateManifest: rejects bad manifests with a readable reason", () => {
  const ok = { id: "acme.x", apiVersion: 1, kind: "connector-provider", domain: "crypto", label: "X", main: "index.js" };
  assert.doesNotThrow(() => validateManifest(ok));
  assert.throws(() => validateManifest({ ...ok, id: "nodot" }), /namespaced/);
  assert.throws(() => validateManifest({ ...ok, apiVersion: PLUGIN_API_VERSION + 1 }), /unsupported apiVersion/);
  assert.throws(() => validateManifest({ ...ok, kind: "weird" }), /kind must be/);
  assert.throws(() => validateManifest({ ...ok, main: "../evil.js" }), /relative path/);
  assert.throws(() => validateManifest({ ...ok, domain: undefined }), /requires manifest.domain/);
  assert.throws(() => validateManifest({ ...ok, id: "no:colons.here" }), /manifest.id may contain/);
});

test("validateManifest: a connector-domain cannot claim a reserved or non-slug domain", () => {
  const base = { id: "acme.x", apiVersion: 1, kind: "connector-domain", label: "X", main: "index.js" };
  assert.doesNotThrow(() => validateManifest({ ...base, domain: "weather" }));
  assert.throws(() => validateManifest({ ...base, domain: "ai" }), /reserved/);
  assert.throws(() => validateManifest({ ...base, domain: "media" }), /reserved/);
  assert.throws(() => validateManifest({ ...base, domain: "bad/slug" }), /simple slug/);
  // `<domain>_provider` is already the AI embedder's, transcriber's and
  // detector's election: starring or removing a domain of that name would
  // rewrite it (plugin-contract-plan.md, Stage 5).
  for (const domain of ["embed", "transcribe", "detect", "Embed"])
    assert.throws(() => validateManifest({ ...base, domain }), /reserved/, domain);
});

test("ctx.fetchJson: a failed call names its URL without the query — a key passed there stays out", async () => {
  // The message reaches the health ledger, the admin's error banner and a board
  // member's browse error (plugin-contract-plan.md, Stage 5).
  const box = await jsonBox({ error: "nope" }, { status: 401 });
  try {
    await assert.rejects(makeCtx({ id: "acme.x" }).fetchJson(box.url("/v1/quote?symbol=BTC&apikey=SECRET-KEY")), (e) => {
      assert.equal(e.status, 401);
      assert.match(e.message, /^HTTP 401 for http:\/\/127\.0\.0\.1:\d+\/v1\/quote$/);
      assert.ok(!e.message.includes("SECRET"), "the key never reaches the message");
      return true;
    });
  } finally {
    box.close();
  }
});

test("validateBuilt: an embed-only plugin on a shared wire declares embed in provides, and nothing else", () => {
  // A shared wire carries a tag method; with `provides`, only `provides`
  // declares, so this is an embedder — not a tagger with no default
  // (plugin-contract-plan.md, Stage 5). Saying `tag: null` stays legal.
  const manifest = { id: "acme.embed", kind: "ai-provider" };
  const embedOnly = () => ({ label: "E", wire: WIRES.compat, rpm: 10, burst: 2, provides: { embed: { default: "e-1" } } });
  assert.doesNotThrow(() => validateBuilt(manifest, embedOnly()));
  assert.doesNotThrow(() => validateBuilt(manifest, { ...embedOnly(), provides: { tag: null, embed: { default: "e-1" } } }));
});

test("catalogIdFor: the segment is 'ai' or the domain, the name is the vendor.name", () => {
  assert.equal(catalogIdFor({ kind: "ai-provider", id: "acme.model" }), "ai:acme.model");
  assert.equal(catalogIdFor({ kind: "connector-provider", domain: "crypto", id: "acme.gecko" }), "crypto:acme.gecko");
  assert.equal(catalogIdFor({ kind: "connector-domain", domain: "weather", id: "acme.weather" }), "weather:acme.weather");
});

test("loadDir: a valid connector-provider registers into the live domain map", async () => {
  const { catalogId, manifest } = await loadDir(FIX("acme-gecko"));
  assert.equal(catalogId, "crypto:acme.gecko");
  const conn = getConnector("crypto");
  assert.ok(conn.providers["acme.gecko"], "provider is in the live map");
  // single source of truth: it also shows in the derived descriptor list
  assert.ok(conn.providerList().some((p) => p.name === "acme.gecko"), "appears in providerList()");
  unregister(manifest);
  assert.equal(conn.providers["acme.gecko"], undefined, "unregister removes it");
});

test("loadDir: a valid ai-provider registers into PROVIDERS and the served catalog", async () => {
  const { catalogId, manifest } = await loadDir(FIX("acme-ai"));
  assert.equal(catalogId, "ai:acme.model");
  assert.equal(PROVIDERS["acme.model"].label, "Acme AI");
  assert.equal(PROVIDERS["acme.model"].external, true, "stamped external for uninstall");
  // It brought only a descriptor and reused the shared compat wire via ctx.wires —
  // the same object core's built-in compat providers dispatch through, not a copy.
  assert.equal(PROVIDERS["acme.model"].wire, WIRES.compat, "reuses the shared compat wire");
  assert.ok(providerCatalog().some((p) => p.name === "acme.model"), "flows through providerCatalog");
  unregister(manifest);
  assert.equal(PROVIDERS["acme.model"], undefined, "unregister removes it");
});

test("loadDir: an embed-only ai-provider (embeds + wire.embed, no defaultModel) is accepted", async () => {
  const { catalogId, manifest } = await loadDir(FIX("acme-embed"));
  assert.equal(catalogId, "ai:acme.embed");
  assert.equal(PROVIDERS["acme.embed"].embeds.default, "acme-embed-1");
  assert.ok(providerCatalog().find((p) => p.name === "acme.embed")?.provides?.embed, "embed capability flows through the catalog");
  unregister(manifest);
  assert.equal(PROVIDERS["acme.embed"], undefined, "unregister removes it");
});

test("loadDir: a provides-only ai-provider loads, with the legacy fields backfilled", async () => {
  const { catalogId, manifest } = await loadDir(FIX("acme-provides"));
  assert.equal(catalogId, "ai:acme.provides");
  // The fixture declares NO legacy fields; install()'s backfill means every
  // reader that still consumes them sees the declaration anyway.
  assert.equal(PROVIDERS["acme.provides"].embeds.default, "acme-p-1");
  assert.ok(providerCatalog().find((p) => p.name === "acme.provides")?.provides?.embed, "flows through the catalog");
  unregister(manifest);
  assert.equal(PROVIDERS["acme.provides"], undefined, "unregister removes it");
});

test("loadDir: a connector-domain registers a whole new domain", async () => {
  assert.equal(getConnector("weather"), null, "domain absent to start");
  const { catalogId, manifest } = await loadDir(FIX("acme-weather"));
  assert.equal(catalogId, "weather:acme.weather");
  assert.ok(getConnector("weather"), "new domain is registered");
  assert.ok(getConnector("weather").providers["acme.weather"]);
  unregister(manifest);
  assert.equal(getConnector("weather"), null, "unregister drops the whole domain");
});

test("loadDir: an unsupported apiVersion refuses to load", async () => {
  await assert.rejects(loadDir(FIX("bad-apiversion")), /unsupported apiVersion/);
});

test("loadDir: a throwing factory leaves the registries untouched (register-last)", async () => {
  await assert.rejects(loadDir(FIX("throwing-factory")), /kaboom/);
  assert.equal(getConnector("crypto").providers["acme.boom"], undefined, "no partial registration");
});

test("loadDir: a connector-domain cannot shadow an existing domain", async () => {
  await assert.rejects(loadDir(FIX("domain-clash")), /already exists/);
  assert.ok(getConnector("crypto").providers.coingecko, "the built-in crypto domain is intact");
});

test("loadDir: a connector-provider for an unknown domain fails cleanly", async () => {
  await assert.rejects(loadDir(FIX("unknown-domain")), /unknown connector domain/);
});

test("loadDir: advertising embed without wire.embed is rejected at install, not at first use", async () => {
  // acme-embed's pre-7a shape: it used to load and then throw at the first
  // embedTexts call. The install-time error names the fix instead.
  await assert.rejects(loadDir(FIX("embed-no-wire")), /needs wire\.embed/);
  assert.equal(PROVIDERS["acme.nowire"], undefined, "register-last: nothing was registered");
});

test("loadDir: a modifier alone is not a capability — research-only is still rejected", async () => {
  await assert.rejects(loadDir(FIX("research-only")), /at least one capability/);
  assert.equal(PROVIDERS["acme.research"], undefined, "register-last: nothing was registered");
});

test("loadDir: a domain whose template a board save would refuse is refused at install, leaving nothing behind", async () => {
  // The board save's own sentence (mapping-rules.js), naming the field.
  await assert.rejects(loadDir(FIX("bad-domain-template")),
    /domain manifest\.template: unknown connector field fn "humidity" for "humidity"/);
  assert.equal(getConnector("badtemplate"), null, "no domain registered");
  assert.equal(getFaceProducer("acme.badtemplate.tile"), null, "and none of its face producers — register-last");
});

// --- the contract, rule by rule (planning/plugin-contract-plan.md, Stage 2) ---
//
// One good built object per kind, then one change per rule and the sentence it
// must throw. Each rule is there because breaking it throws inside the host,
// fails silently, or leaves a card nameless — the test's name says which.

const goodProvider = () => ({
  label: "Acme", needsKey: false, rpm: 30, burst: 15,
  async search() { return []; },
  async fetchEntity() { return {}; },
});
const goodDomain = () => ({
  providers: { "acme.table": goodProvider() },
  defaultProvider: "acme.table",
  manifest: {
    label: "Table",
    fields: [{ key: "temp", kind: "number", fn: "temp", label: "Temperature" }],
    faces: [{ name: "chart", label: "Chart", periods: ["1y"], requires: "history" }],
    template: {
      input: { connector: "tabletest" },
      face: { source: "connector", producer: "chart", period: "1y" },
      fields: [{ key: "temp", kind: "number", source: "connector", fn: "temp" }],
    },
    browse: {
      columns: [{ key: "name", label: "Name", kind: "text", primary: true }],
      sorts: [{ key: "name", label: "Name" }],
      filters: [{ key: "type", label: "Type", options: ["a"] }, { key: "region", label: "Region", from: "provider" }],
    },
    chart: { ranges: ["1y"], kinds: ["area"] },
  },
  faces: { chart: "price-chart" },
});
const goodSource = () => ({
  manifest: {
    name: "acme.table", label: "Table", needsConnection: true, browsable: true,
    connectionSchema: [{ key: "host", type: "text", label: "Host" }, { key: "password", type: "secret", label: "Password" }],
    sourceSchema: [{ key: "path", type: "text", label: "Folder" }],
  },
  backend: () => ({}),
});
const goodAi = () => ({
  label: "Acme", keyless: true, onDevice: true,
  wire: { tag: async () => ({}), embed: async () => ({}) },
  provides: { tag: { default: "m", models: [{ id: "m" }] }, embed: { default: "e", models: [{ id: "e" }] } },
});

const GOOD = {
  "connector-provider": [{ id: "acme.table", kind: "connector-provider", domain: "crypto" }, goodProvider],
  "connector-domain": [{ id: "acme.table", kind: "connector-domain", domain: "tabletest" }, goodDomain],
  source: [{ id: "acme.table", kind: "source" }, goodSource],
  "ai-provider": [{ id: "acme.table", kind: "ai-provider" }, goodAi],
};

test("validateBuilt: the good object of each kind passes, so each rule below refuses exactly its one change", () => {
  for (const [kind, [manifest, good]] of Object.entries(GOOD))
    assert.doesNotThrow(() => validateBuilt(manifest, good()), kind);
});

test("validateBuilt: an optional member that is null counts as absent, as every reader of it treats it", () => {
  // Each change leaves a plugin the runtime serves without a throw (`|| []`,
  // `?.`, `if (!browse)`); refusing it would refuse a plugin that works.
  const NULLED = {
    "connector-domain": [
      (b) => { b.manifest.template = null; },
      (b) => { b.manifest.template = null; b.manifest.fields = null; },
      (b) => { b.manifest.template = null; b.manifest.faces = null; b.faces = null; },
      (b) => { b.manifest.browse = null; },
      (b) => { b.manifest.chart = null; },
      (b) => { b.manifest.browse.sorts = null; b.manifest.browse.filters = null; },
      (b) => { b.manifest.browse.filters[0].from = null; },
      (b) => { b.manifest.faces[0].periods = null; delete b.manifest.template.face.period; },
    ],
    source: [
      (b) => { b.manifest.sourceSchema = null; },
      (b) => { b.manifest.needsConnection = false; b.manifest.connectionSchema = null; },
    ],
    // A null `provides` entry declares nothing, as the catalog counts it — no wire owed.
    "ai-provider": [(b) => { b.provides.transcribe = null; }],
  };
  for (const [kind, changes] of Object.entries(NULLED)) {
    const [manifest, good] = GOOD[kind];
    for (const change of changes) {
      const built = good();
      change(built);
      assert.doesNotThrow(() => validateBuilt(manifest, built), `${kind}: ${change}`);
    }
  }
});

const RULES = [
  ["connector-provider", "nameless card", (b) => { delete b.label; }, /connector provider "acme\.table" needs a label/],
  ["connector-provider", "no rate limit (D4)", (b) => { delete b.burst; }, /must declare positive rpm and burst/],
  ["connector-provider", "a truthy non-method throws at its first call", (b) => { b.history = true; }, /history must be a function/],
  ["connector-domain", "a second provider (D5)", (b) => { b.providers["acme.other"] = goodProvider(); }, /exactly one provider, keyed by manifest\.id/],
  ["connector-domain", "nameless picker entry", (b) => { delete b.manifest.label; }, /domain manifest needs a label/],
  ["connector-domain", "fields that aren't an array throw in every board save", (b) => { b.manifest.fields = {}; }, /domain manifest\.fields must be an array/],
  ["connector-domain", "a catalog key the menu offers and the save refuses", (b) => { b.manifest.fields[0].key = "Temp"; }, /manifest\.fields\[0\]: invalid field key: "Temp"/],
  ["connector-domain", "a catalog kind no board can map", (b) => { b.manifest.fields[0].kind = "boolean"; }, /manifest\.fields\[0\]: invalid kind "boolean"/],
  ["connector-domain", "a template that binds boards to another domain", (b) => { b.manifest.template.input.connector = "crypto"; }, /must bind boards to its own domain \("tabletest"\), not "crypto"/],
  ["connector-domain", "a template field its catalog lacks", (b) => { b.manifest.template.fields[0].fn = "humidity"; }, /template: unknown connector field fn "humidity"/],
  ["connector-domain", "a template that claims the card slot", (b) => { b.manifest.template.card = { by: "temp" }; }, /template: a connector board's cards are the connector's entries/],
  ["connector-domain", "a period against a face that offers none is refused, not a 500", (b) => { delete b.manifest.faces[0].periods; }, /template: invalid period "1y" for face "chart"/],
  ["connector-domain", "faces that aren't an array take every domain's catalog down", (b) => { b.manifest.faces = { chart: {} }; }, /domain manifest\.faces must be an array/],
  ["connector-domain", "a face with no slot keeps the fallback tile forever", (b) => { b.manifest.faces[0].name = "tile"; }, /faces\[0\] must be named for a slot/],
  ["connector-domain", "periods as a string", (b) => { b.manifest.faces[0].periods = "1y"; }, /faces\[0\]\.periods must be an array/],
  ["connector-domain", "a slot naming a producer that doesn't exist", (b) => { b.faces.chart = "acme.table.nope"; }, /faces\.chart names face producer "acme\.table\.nope"/],
  ["connector-domain", "a faces map that is a producer name, not a map", (b) => { b.faces = "price-chart"; }, /faces map must be an object — face slot → producer name/],
  ["connector-domain", "a template that isn't a mapping", (b) => { b.manifest.template = "tabletest"; }, /template must be a board mapping object/],
  ["connector-domain", "browse without columns throws in the browse modal", (b) => { delete b.manifest.browse.columns; }, /browse\.columns must be an array/],
  ["connector-domain", "a column kind that draws blank cells", (b) => { b.manifest.browse.columns[0].kind = "currency"; }, /columns\[0\] needs a key and a kind — one of: text, number, usd, percent, date/],
  ["connector-domain", "sorts that aren't an array", (b) => { b.manifest.browse.sorts = { name: "Name" }; }, /browse\.sorts must be an array/],
  ["connector-domain", "filters that aren't an array throw in /connector-list", (b) => { b.manifest.browse.filters = { type: ["a"] }; }, /browse\.filters must be an array/],
  ["connector-domain", "a from typo that renders no control", (b) => { b.manifest.browse.filters[1].from = "providers"; }, /filters\[1\]\.from must be "provider"/],
  ["connector-domain", "options that aren't an array", (b) => { b.manifest.browse.filters[0].options = "a"; }, /filters\[0\] needs an options array, or from: "provider"/],
  ["connector-domain", "chart ranges that aren't an array", (b) => { b.manifest.chart.ranges = "1y"; }, /chart needs ranges and kinds arrays/],
  ["connector-domain", "its provider is held to the provider rules", (b) => { delete b.providers["acme.table"].rpm; }, /connector provider "acme\.table" must declare positive rpm and burst/],
  ["source", "nameless card", (b) => { delete b.manifest.label; }, /source manifest needs a label/],
  ["source", "a connection form that is never shown", (b) => { b.manifest.needsConnection = false; }, /only read when needsConnection is on/],
  ["source", "a connection with nothing to hold", (b) => { b.manifest.connectionSchema = []; }, /needsConnection must declare connectionSchema/],
  ["source", "a password echoed unmasked", (b) => { b.manifest.connectionSchema[1].type = "password"; }, /connectionSchema\[1\]\.type must be one of: text, number, secret, toggle — "secret" is the one that's masked/],
  ["source", "a connection field with no key", (b) => { delete b.manifest.connectionSchema[0].key; }, /connectionSchema\[0\] needs a key and a label/],
  ["source", "a sourceSchema the chooser can't search", (b) => { b.manifest.sourceSchema = { path: {} }; }, /sourceSchema must be an array/],
  ["ai-provider", "a legacy name inside provides (D7)", (b) => { b.provides.embeds = b.provides.embed; delete b.provides.embed; }, /provides\.embeds is not a capability a provider declares — did you mean provides\.embed\?/],
  ["ai-provider", "extract, which rides tag's declaration", (b) => { b.provides.extract = {}; }, /provides\.extract is not a capability a provider declares — did you mean provides\.tag\?/],
  ["ai-provider", "a key nothing reads", (b) => { b.provides.summarize = {}; }, /provides\.summarize is not a capability a provider declares \(one of: tag, embed, transcribe, detect, research\)/],
  ["ai-provider", "tagging that can never serve", (b) => { delete b.wire.tag; }, /a tag ai-provider descriptor needs wire\.tag/],
  // The sentences name `provides`, the spelling PLUGIN.md teaches — and with
  // `provides`, the wire's tag method declares nothing, so a plugin that
  // declares nothing there is told so (plugin-contract-plan.md, Stage 5).
  ["ai-provider", "a tagger with no default", (b) => { delete b.provides.tag.default; }, /a tagging ai-provider needs provides\.tag\.default/],
  ["ai-provider", "declaring nothing, beside a wire that could tag", (b) => { b.provides = {}; }, /must declare at least one capability in `provides` — one of: tag, embed, transcribe, detect$/],
  ["ai-provider", "tagging in the legacy fields beside a provides without it", (b) => { delete b.provides.tag; b.defaultModel = "m"; }, /defaultModel declares tagging, but with `provides` only `provides` declares — move it into provides\.tag/],
];

for (const [kind, why, change, sentence] of RULES) {
  test(`validateBuilt (${kind}): ${why}`, () => {
    const [manifest, good] = GOOD[kind];
    const built = good();
    change(built);
    assert.throws(() => validateBuilt(manifest, built), sentence);
  });
}

// --- integration (server + db) ---

let srv, db;
before(async () => { srv = await startServer(); ({ db } = srv); await adminSession(db); });
after(() => srv.close());

test("a loaded connector-provider is callable through the runtime via ctx.fetchJson", async () => {
  await loadDir(FIX("acme-gecko"));
  await setPluginState(db, "crypto:acme.gecko", { installed: true });
  await setSetting(db, "crypto_provider", "acme.gecko"); // make it the active provider

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ coins: [{ id: "btc", name: "Bitcoin", symbol: "BTC" }] }),
  });
  try {
    const hits = await getConnector("crypto").search(db, "bitcoin");
    assert.equal(hits[0].id, "btc", "the plugin ran and returned normalized hits");
  } finally {
    globalThis.fetch = original;
  }

  unregister(manifestOf("acme-gecko"));
  await setSetting(db, "crypto_provider", null);
});

test("loadAll registers recorded externals; pluginCatalog surfaces success + errored cards", async () => {
  await upsertExternalPlugin(db, {
    id: "crypto:acme.gecko", kind: "connector-provider", sourceUrl: "https://github.com/acme/gecko",
    resolvedRef: "v1.0.0", dir: FIX("acme-gecko"), manifest: manifestOf("acme-gecko"),
  });
  await upsertExternalPlugin(db, {
    id: "crypto:acme.boom", kind: "connector-provider", sourceUrl: "https://github.com/acme/boom",
    resolvedRef: "v1.0.0", dir: FIX("throwing-factory"), manifest: manifestOf("throwing-factory"),
  });

  await loadAll(db); // the boot hook, run explicitly

  assert.ok(getConnector("crypto").providers["acme.gecko"], "good plugin registered");

  const cat = await pluginCatalog(db);
  const good = cat.find((p) => p.id === "crypto:acme.gecko");
  assert.equal(good.external, true, "marked external");
  assert.equal(good.source.url, "https://github.com/acme/gecko");
  assert.equal(good.source.ref, "v1.0.0");
  assert.equal(good.state.installed, true, "present ⇒ installed, even without a plugins-table row");
  assert.ok(!good.state.loadError, "a loaded plugin has no loadError");

  const bad = cat.find((p) => p.id === "crypto:acme.boom");
  assert.ok(bad, "the failed plugin still shows a card");
  assert.equal(bad.external, true);
  assert.ok(bad.state.loadError, "errored plugin shows a loadError");
  assert.match(bad.state.loadError.message, /kaboom/);

  unregister(manifestOf("acme-gecko"));
});
