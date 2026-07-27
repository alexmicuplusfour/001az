// Dynamic plugin install/uninstall (phase 2, slice 2): resolving a source URL,
// fetching code into place, and the install→register→persist→uninstall lifecycle.
// Hermetic: a dep-free `file:` fixture drives the whole path with no network and
// no npm. GitHub/npm URL parsing is unit-tested; their downloads aren't run here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, adminSession, req } from "./helpers.js";
import { resolveSource } from "../server/plugin-fetch.js";
import { installFromUrl, uninstall, unregister } from "../server/plugin-loader.js";
import { getConnector } from "../server/connectors/index.js";
import { PROVIDERS } from "../server/providers.js";
import { pluginCatalog } from "../server/plugins.js";
import { getExternalPlugin, setExternalLoadError, getSetting, setSetting, listAiKeys, createAiKey } from "../server/db.js";
import { getFaceProducer } from "../server/faces/index.js";
import { getSourceBackend } from "../server/ingestion/sources/index.js";
import { listSources } from "../server/ingestion/files.js";

const FIX = (name) => fileURLToPath(new URL(`./fixtures/plugins/${name}`, import.meta.url));

// --- resolveSource (pure) ---

test("resolveSource: github / npm / tarball / local / errors", () => {
  let s = resolveSource("github:acme/gecko");
  assert.equal(s.kind, "github"); assert.equal(s.owner, "acme"); assert.equal(s.repo, "gecko");
  assert.match(s.tarballUrl, /\/repos\/acme\/gecko\/tarball\//);
  assert.equal(resolveSource("github:acme/gecko@v1.2").ref, "v1.2");
  assert.equal(resolveSource("github:acme/gecko@v1.2").subdir, null);
  assert.equal(resolveSource("https://github.com/acme/gecko").kind, "github");
  assert.equal(resolveSource("https://github.com/acme/gecko/tree/dev").ref, "dev");
  assert.equal(resolveSource("https://github.com/acme/gecko/tree/dev").subdir, null);

  // A plugin living INSIDE a repo (monorepo / examples layout) — both forms.
  s = resolveSource("github:acme/gecko/examples/plugins/ollama@v2");
  assert.equal(s.subdir, "examples/plugins/ollama"); assert.equal(s.ref, "v2");
  s = resolveSource("https://github.com/acme/gecko/tree/main/examples/plugins/ollama");
  assert.equal(s.subdir, "examples/plugins/ollama"); assert.equal(s.ref, "main");
  assert.throws(() => resolveSource("github:acme/gecko/../evil"), /subdirectory/);

  assert.deepEqual(
    (({ kind, name, version }) => ({ kind, name, version }))(resolveSource("npm:left-pad")),
    { kind: "npm", name: "left-pad", version: null });
  assert.equal(resolveSource("npm:left-pad@1.3.0").version, "1.3.0");
  assert.equal(resolveSource("@scope/pkg@2.0.0").name, "@scope/pkg");
  assert.equal(resolveSource("@scope/pkg@2.0.0").version, "2.0.0");
  assert.equal(resolveSource("just-a-package").kind, "npm");

  assert.equal(resolveSource("https://ex.com/p.tgz").kind, "tarball");
  assert.equal(resolveSource("/abs/local/path").kind, "file");
  assert.equal(resolveSource("C:\\Users\\x\\plugin").kind, "file");
  // A bare relative path resolves against the server's cwd (last-resort form —
  // URL-ish strings above always win the parse).
  assert.equal(resolveSource("examples/plugins/ollama").kind, "file");
  assert.ok(path.isAbsolute(resolveSource("examples/plugins/ollama").dir));

  assert.throws(() => resolveSource(""), /required/);
  assert.throws(() => resolveSource("http://example.com/not-a-tarball"), /unrecognized/);
});

// --- install / uninstall (server + db) ---

let srv, db, base, admin, pluginsTmp;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  pluginsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-test-"));
  process.env.PLUGINS_DIR = pluginsTmp; // read lazily by pluginsDir()
});
after(() => {
  srv.close();
  fs.rmSync(pluginsTmp, { recursive: true, force: true });
  delete process.env.PLUGINS_DIR;
});

test("installFromUrl: a file: source registers, persists, and shows installed+external", async () => {
  const id = await installFromUrl(db, FIX("acme-gecko"));
  assert.equal(id, "crypto:acme.gecko");
  assert.ok(getConnector("crypto").providers["acme.gecko"], "registered live");

  const row = await getExternalPlugin(db, id);
  assert.ok(row, "install record persisted");
  assert.ok(fs.existsSync(row.dir), "code is on disk");
  assert.match(row.dir, /crypto__acme\.gecko@local-[0-9a-f]{6}$/);

  const entry = (await pluginCatalog(db)).find((p) => p.id === id);
  assert.equal(entry.external, true);
  assert.equal(entry.state.installed, true);
  assert.equal(entry.source.url, FIX("acme-gecko"));

  // uninstall reverses all of it
  await uninstall(db, id);
  assert.equal(getConnector("crypto").providers["acme.gecko"], undefined, "unregistered");
  assert.equal(await getExternalPlugin(db, id), null, "record gone");
  assert.equal(fs.existsSync(row.dir), false, "code removed");
  assert.equal((await pluginCatalog(db)).some((p) => p.id === id), false, "off the catalog");
});

test("installFromUrl: a connector-domain installs the whole domain (dir named from the catalog id)", async () => {
  const id = await installFromUrl(db, FIX("acme-weather"));
  assert.equal(id, "weather:acme.weather");
  assert.ok(getConnector("weather"), "new domain registered live");
  const row = await getExternalPlugin(db, id);
  assert.match(row.dir, /weather__acme\.weather@local-[0-9a-f]{6}$/, "dir carries the domain, not just the vendor.name");

  await uninstall(db, id);
  assert.equal(getConnector("weather"), null, "domain removed on uninstall");
  assert.equal(await getExternalPlugin(db, id), null);
});

test("installFromUrl: a connector-domain brings its OWN face producer (slice 3 bridge)", async () => {
  assert.equal(getFaceProducer("acme.weatherface.tile"), null, "not registered before install");
  const id = await installFromUrl(db, FIX("acme-weatherface"));
  assert.equal(id, "weatherface:acme.weatherface");

  // A from-URL plugin contributed a face producer the app never shipped — it's
  // live in the shared registry and it's the plugin's own function.
  const producer = getFaceProducer("acme.weatherface.tile");
  assert.equal(typeof producer, "function", "plugin-supplied producer registered live");
  const out = await producer([{ t: 0, price: 1 }]);
  assert.ok(Buffer.isBuffer(out.webp) && out.w === 120 && out.h === 90, "it is the plugin's fn");
  // end-to-end: the domain's `tile` face slot names it, so produceFace resolves
  // the plugin's own producer through the registry and renders with it.
  const face = await getConnector("weatherface").produceFace(
    db, { symbol: "WF", display_name: "Weatherville" },
    { provider: "acme.weatherface", id: "wf-1" }, { producer: "tile", period: "1y" });
  assert.ok(face && Buffer.isBuffer(face.webp) && face.w === 120, "produceFace rendered via the plugin's producer");

  await uninstall(db, id);
  assert.equal(getFaceProducer("acme.weatherface.tile"), null, "unregistered on uninstall — no orphan");
  assert.equal(getConnector("weatherface"), null);
});

test("installFromUrl: a plugin can't register a face producer outside its namespace (no clobbering built-ins)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-clobber-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    id: "acme.evil", apiVersion: 1, kind: "connector-domain", domain: "evilface",
    label: "Evil", main: "index.js", faceProducers: ["price-chart"], // tries to hijack the built-in chart
  }));
  fs.writeFileSync(path.join(dir, "index.js"),
    'export default () => ({ providers: { "acme.evil": { async search(){return[];}, async fetchEntity(){return{};} } },' +
    ' defaultProvider: "acme.evil", manifest: { label: "Evil" }, faces: {},' +
    ' faceProducers: { "price-chart": async () => ({ webp: Buffer.from([1]), w: 1, h: 1 }) } });\n');

  await assert.rejects(installFromUrl(db, dir), /namespaced under the plugin id/);
  assert.equal(typeof getFaceProducer("price-chart"), "function", "the built-in producer is untouched");
  assert.equal(await getExternalPlugin(db, "evilface:acme.evil"), null, "nothing persisted");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installFromUrl: a source plugin installs as the 4th kind (registers live; uninstall reverses)", async () => {
  assert.equal(getSourceBackend("acme.filedrop"), null, "not registered before install");
  const id = await installFromUrl(db, FIX("acme-source"));
  assert.equal(id, "source:acme.filedrop");

  // registered live in the ingestion-source registry — the loader learned a 4th kind
  const mod = getSourceBackend("acme.filedrop");
  assert.ok(mod && typeof mod.backend === "function", "backend registered live");
  // shows up as an installed source (listSources reads the live registry)
  assert.ok((await listSources(db)).some((s) => s.type === "acme.filedrop"), "in the source list");
  // and as an external source card in the plugin catalog
  const entry = (await pluginCatalog(db)).find((p) => p.id === id);
  assert.equal(entry.kind, "source");
  assert.equal(entry.external, true);
  assert.equal(entry.state.installed, true);

  await uninstall(db, id);
  assert.equal(getSourceBackend("acme.filedrop"), null, "unregistered on uninstall");
  assert.equal((await listSources(db)).some((s) => s.type === "acme.filedrop"), false, "gone from the source list");
  assert.equal((await pluginCatalog(db)).some((p) => p.id === id), false, "off the catalog");
});

test("installFromUrl: an external source can't make itself un-removable via core:true", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "src-core-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    id: "acme.sticky", apiVersion: 1, kind: "source", label: "Sticky", main: "index.js",
  }));
  fs.writeFileSync(path.join(dir, "index.js"),
    'export default () => ({ manifest: { name: "acme.sticky", label: "Sticky", core: true }, backend: () => ({ async list(){return{entries:[]};} }) });\n');
  const id = await installFromUrl(db, dir);
  const entry = (await pluginCatalog(db)).find((p) => p.id === id);
  assert.equal(entry.core, false, "an installed-from-URL plugin is never core (stays removable)");
  await uninstall(db, id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installFromUrl: a source whose manifest.name != id is rejected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "src-bad-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    id: "acme.wrong", apiVersion: 1, kind: "source", label: "Wrong", main: "index.js",
  }));
  fs.writeFileSync(path.join(dir, "index.js"),
    'export default () => ({ manifest: { name: "mismatch" }, backend: () => ({ async list(){return{entries:[]};} }) });\n');
  await assert.rejects(installFromUrl(db, dir), /manifest\.name must equal manifest\.id/);
  assert.equal(getSourceBackend("mismatch"), null, "nothing registered");
  assert.equal(await getExternalPlugin(db, "source:acme.wrong"), null, "nothing persisted");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installFromUrl: an ai-provider registers into PROVIDERS and shows as an external AI card", async () => {
  const id = await installFromUrl(db, FIX("acme-ai"));
  assert.equal(id, "ai:acme.model");
  assert.ok(PROVIDERS["acme.model"], "registered live into PROVIDERS");
  assert.equal(PROVIDERS["acme.model"].external, true, "stamped external");

  const entry = (await pluginCatalog(db)).find((p) => p.id === id);
  assert.equal(entry.kind, "ai");
  assert.equal(entry.external, true);
  assert.equal(entry.state.installed, true);

  await uninstall(db, id);
  assert.equal(PROVIDERS["acme.model"], undefined, "unregistered");
  assert.equal(await getExternalPlugin(db, id), null);
  assert.equal((await pluginCatalog(db)).some((p) => p.id === id), false, "off the catalog");
});

test("uninstall: a connector plugin's key + active-provider selection are cleared (nothing left behind)", async () => {
  const id = await installFromUrl(db, FIX("acme-gecko")); // crypto:acme.gecko
  await setSetting(db, "crypto_key_acme.gecko", "secret-key");
  await setSetting(db, "crypto_provider", "acme.gecko"); // it's the active crypto provider

  await uninstall(db, id);
  assert.equal(await getSetting(db, "crypto_key_acme.gecko"), null, "api-key setting cleared");
  assert.equal(await getSetting(db, "crypto_provider"), null, "active-provider pointer cleared (would re-activate on reinstall)");
});

test("uninstall: a connector uninstall leaves a DIFFERENT domain provider's selection intact", async () => {
  const id = await installFromUrl(db, FIX("acme-gecko"));
  await setSetting(db, "crypto_provider", "coingecko"); // a built-in is the active one, not the plugin
  await uninstall(db, id);
  assert.equal(await getSetting(db, "crypto_provider"), "coingecko", "another provider's selection is untouched");
  await setSetting(db, "crypto_provider", null); // tidy up
});

test("uninstall: an ai-provider's registered keys are removed", async () => {
  const id = await installFromUrl(db, FIX("acme-ai")); // ai:acme.model, provider "acme.model"
  await createAiKey(db, "acme key", "acme.model", "sk-acme");
  assert.ok((await listAiKeys(db)).some((k) => k.provider === "acme.model"), "key exists before uninstall");

  await uninstall(db, id);
  assert.equal((await listAiKeys(db)).some((k) => k.provider === "acme.model"), false, "no orphan keys for a gone provider");
});

test("installFromUrl: a failed errored-retry preserves the prior install and refreshes the reason", async () => {
  // Set up an errored plugin the way boot does: code on disk + a row, but
  // load_error set and NOT registered (so a retry is allowed, not 409'd).
  const id = await installFromUrl(db, FIX("acme-gecko"));
  const before = await getExternalPlugin(db, id);
  unregister(before.manifest);
  await setExternalLoadError(db, id, new Error("boot load failed once"));

  // A same-id retry source whose factory throws (built inline so it shares the
  // catalog id but fails to load).
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "acme-gecko-bad-"));
  fs.writeFileSync(path.join(badDir, "manifest.json"), JSON.stringify({
    id: "acme.gecko", apiVersion: 1, kind: "connector-provider", domain: "crypto", label: "Acme Gecko", main: "index.js",
  }));
  fs.writeFileSync(path.join(badDir, "index.js"), "export default function () { throw new Error('retry still broken'); }\n");

  await assert.rejects(installFromUrl(db, badDir), /retry still broken/);

  const after = await getExternalPlugin(db, id);
  assert.ok(after, "install record survives the failed retry");
  assert.equal(after.dir, before.dir, "prior dir unchanged");
  assert.ok(fs.existsSync(before.dir), "prior code still on disk");
  assert.match(after.load_error.message, /retry still broken/, "reason refreshed to this attempt");
  const geckoDirs = fs.readdirSync(pluginsTmp).filter((n) => n.startsWith("crypto__acme.gecko@"));
  assert.deepEqual(geckoDirs, [path.basename(before.dir)], "the failed retry's dir was cleaned; only the prior one remains");

  fs.rmSync(badDir, { recursive: true, force: true });
  await uninstall(db, id);
});

test("pluginCatalog: an errored external surfaces the shape the errored card renders", async () => {
  // The admin page's errored card (plugin-add slice 3) reads external + source +
  // state.loadError off the catalog entry — an errored plugin never registers, so
  // erroredExternalEntry synthesises it from the stored manifest. Pin those fields
  // (a failed-to-load external once crashed the render, which had no descriptor).
  const id = await installFromUrl(db, FIX("acme-gecko"));
  const row = await getExternalPlugin(db, id);
  unregister(row.manifest); // as boot leaves a load failure: code on disk, not registered
  await setExternalLoadError(db, id, new Error("kaboom on load"));

  const entry = (await pluginCatalog(db)).find((p) => p.id === id);
  assert.ok(entry, "errored external is still a catalog entry");
  assert.equal(entry.external, true);
  assert.equal(entry.kind, "connector", "connector-provider maps to a connector card");
  assert.equal(entry.state.installed, true, "so it lands in the installed list");
  assert.equal(entry.source.url, FIX("acme-gecko"));
  assert.match(entry.state.loadError.message, /kaboom on load/);
  assert.equal(entry.connector, undefined, "no live descriptor — the render must not deref it");

  await uninstall(db, id);
});

test("installFromUrl: reinstalling a healthy id is refused (409)", async () => {
  await installFromUrl(db, FIX("acme-gecko"));
  await assert.rejects(installFromUrl(db, FIX("acme-gecko")), (e) => {
    assert.match(e.message, /already installed/);
    assert.equal(e.status, 409);
    return true;
  });
  await uninstall(db, "crypto:acme.gecko");
});

test("installFromUrl: a fresh install that fails validation persists nothing", async () => {
  await assert.rejects(installFromUrl(db, FIX("bad-apiversion")), /unsupported apiVersion/);
  assert.equal(await getExternalPlugin(db, "crypto:acme.old"), null, "no record");
  assert.equal(getConnector("crypto").providers["acme.old"], undefined, "not registered");
  // no committed dir left behind
  assert.equal(fs.readdirSync(pluginsTmp).some((n) => n.startsWith("acme.old@")), false);
});

test("POST /api/admin/plugins/install: admin-only; installs; 409 on repeat", async () => {
  assert.equal((await req(base, "POST", "/api/admin/plugins/install", { body: { url: FIX("acme-gecko") } })).status, 403);

  const ok = await req(base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: { url: FIX("acme-gecko") } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.plugin.id, "crypto:acme.gecko");
  assert.equal(ok.json.plugin.external, true);

  const dup = await req(base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: { url: FIX("acme-gecko") } });
  assert.equal(dup.status, 409);

  assert.equal((await req(base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: {} })).status, 400);
});

test("DELETE /api/admin/plugins/:id: uninstalls an external; rejects a built-in", async () => {
  // (acme.gecko is installed from the previous test)
  assert.equal((await req(base, "DELETE", "/api/admin/plugins/crypto:acme.gecko")).status, 403); // anon

  const builtin = await req(base, "DELETE", "/api/admin/plugins/crypto:coingecko", { sid: admin.sid });
  assert.equal(builtin.status, 400, "built-ins can't be uninstalled");

  const del = await req(base, "DELETE", "/api/admin/plugins/crypto:acme.gecko", { sid: admin.sid });
  assert.equal(del.status, 200);
  assert.equal(await getExternalPlugin(db, "crypto:acme.gecko"), null);
});

// The real download → tar --strip-components=1 → load path, exercised hermetically
// against a local HTTP server serving a genuine .tgz (built like github/npm: one
// wrapper dir). This is the only test that runs fetchModule's network branch.
test("installFromUrl: a tarball URL downloads, extracts (strip-components), and loads", async () => {
  const tgz = fs.readFileSync(fileURLToPath(new URL("./fixtures/plugin-tarball.tgz", import.meta.url)));
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": tgz.length });
      res.end(tgz);
    }).listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = server.address().port;
  try {
    const id = await installFromUrl(db, `http://127.0.0.1:${port}/plugin.tgz`);
    assert.equal(id, "crypto:acme.gecko");
    assert.ok(getConnector("crypto").providers["acme.gecko"], "registered from the downloaded tarball");
    const row = await getExternalPlugin(db, id);
    assert.ok(fs.existsSync(path.join(row.dir, "manifest.json")), "strip-components unwrapped the top dir");
    await uninstall(db, id);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
