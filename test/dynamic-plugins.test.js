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
import { startServer, adminSession } from "./helpers.js";
import { PLUGIN_API_VERSION, validateManifest, loadDir, loadAll, unregister, catalogIdFor } from "../server/plugin-loader.js";
import { getConnector } from "../server/connectors/index.js";
import { PROVIDERS, providerCatalog } from "../server/providers.js";
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
  assert.ok(providerCatalog().some((p) => p.name === "acme.model"), "flows through providerCatalog");
  unregister(manifest);
  assert.equal(PROVIDERS["acme.model"], undefined, "unregister removes it");
});

test("loadDir: an embed-only ai-provider (wire null, embeds set, no defaultModel) is accepted", async () => {
  const { catalogId, manifest } = await loadDir(FIX("acme-embed"));
  assert.equal(catalogId, "ai:acme.embed");
  assert.equal(PROVIDERS["acme.embed"].embeds.default, "acme-embed-1");
  assert.ok(providerCatalog().find((p) => p.name === "acme.embed")?.embeds, "embed capability flows through the catalog");
  unregister(manifest);
  assert.equal(PROVIDERS["acme.embed"], undefined, "unregister removes it");
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
