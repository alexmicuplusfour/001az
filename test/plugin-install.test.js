// Dynamic plugin install/update/uninstall (phase 2, slice 2; update is
// plugin-contract Stage 3): resolving a source URL, fetching code into place, and
// the install→register→persist→update→uninstall lifecycle. Hermetic: a dep-free
// `file:` fixture drives the whole path with no network and no npm; the tarball
// and GitHub downloads run against a local HTTP server. npm's registry lookup is
// the one network path not run here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer, adminSession, req, seedBoard } from "./helpers.js";
import { resolveSource, fetchModule } from "../server/plugin-fetch.js";
import { installFromUrl, updatePlugin, uninstall, unregister, manifestIn } from "../server/plugin-loader.js";
import { makeCtx } from "../server/plugin-ctx.js";
import { getConnector } from "../server/connectors/index.js";
import { PROVIDERS, RENAMED } from "../server/providers.js";
import { pluginCatalog, bundledPlugins } from "../server/plugins.js";
import {
  getExternalPlugin, setExternalLoadError, getSetting, setSetting, listAiKeys, createAiKey, setPluginState,
  createSourceConnection, listSourceConnections, deleteSourceConnection,
} from "../server/db.js";
import { resolveCapability } from "../server/capability-resolve.js";
import { ratesFor } from "../server/pricing.js";
import { TarWriter } from "../server/tarfile.js";
import { getFaceProducer } from "../server/faces/index.js";
import { getSourceBackend } from "../server/ingestion/sources/index.js";
import { listSources } from "../server/ingestion/files.js";

const FIX = (name) => fileURLToPath(new URL(`./fixtures/plugins/${name}`, import.meta.url));
const EXAMPLE = (name) => fileURLToPath(new URL(`../examples/plugins/${name}`, import.meta.url));

// A source an update can find something new at: a temp copy of a fixture or an
// example, installed from, then changed in place.
const copyOf = (dir) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-src-"));
  fs.cpSync(dir, d, { recursive: true });
  return d;
};
const rewrite = (dir, file, from, to) => {
  const f = path.join(dir, file);
  const src = fs.readFileSync(f, "utf8");
  assert.ok(src.includes(from), `${file} holds ${from}`);
  fs.writeFileSync(f, src.replace(from, to));
};

// A gzipped tar built in memory, one [name, content] per file — the archive
// shapes GitHub and npm serve, without a network.
async function tgzOf(files) {
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(c));
  const tw = new TarWriter(out);
  for (const [name, content] of files) await tw.file(name, Buffer.byteLength(content), Buffer.from(content));
  await tw.end();
  return zlib.gzipSync(Buffer.concat(chunks));
}

// Serve one archive on a local port for the length of `fn` — the download half
// of a fetch, hermetically.
async function serving(body, fn) {
  const server = await new Promise((resolve) => {
    const s = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": body.length });
      res.end(body);
    }).listen(0, "127.0.0.1", () => resolve(s));
  });
  try { return await fn(`http://127.0.0.1:${server.address().port}/archive.tgz`); }
  finally { await new Promise((r) => server.close(r)); }
}

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

// The bundled catalog's other half (planning/welcome-plan.md Stage 2b): the
// listing is only worth having if the path it carries actually installs. Driven
// through the ROUTE rather than installFromUrl, because the Add button and the
// welcome chooser both go that way and the path is theirs to hand over.
test("bundled: the listed path installs, and the row leaves the list it came from", async () => {
  const before = await bundledPlugins(db);
  const row = before.find((p) => p.id === "ai:community.ollama");
  assert.ok(row, "listed while not installed");

  const r = await req(base, "POST", "/api/admin/plugins/install",
    { sid: admin.sid, body: { url: row.bundled.path } });
  assert.equal(r.status, 200);
  assert.equal(r.json.plugin.id, "ai:community.ollama");
  // The install is what the chooser learns the provider's SHAPE from — the
  // manifest could not tell it whether to draw a key field or a server URL.
  assert.equal(r.json.plugin.ai.keyless, true);
  assert.equal(r.json.plugin.ai.needsBase, true);
  assert.ok(r.json.plugin.ai.base, "and where to point it by default");

  // One row, not two: the bundled listing is what's NOT installed, so an
  // installed example must hand its place to the real catalog entry.
  const after = await bundledPlugins(db);
  assert.equal(after.some((p) => p.id === "ai:community.ollama"), false, "off the bundled list");
  assert.ok(after.some((p) => p.id === "ai:community.deepseek"), "its sibling is untouched");
  const catalog = await pluginCatalog(db);
  const entry = catalog.find((p) => p.id === "ai:community.ollama");
  assert.equal(entry.external, true);
  assert.equal(entry.state.installed, true);
  assert.equal(catalog.filter((p) => p.id === "ai:community.ollama").length, 1);

  await uninstall(db, "ai:community.ollama");
  assert.ok((await bundledPlugins(db)).some((p) => p.id === "ai:community.ollama"), "removing puts it back on offer");
});

test("bundled: every listing hint matches the descriptor it stands in for", async () => {
  // The one risk the hints carry. A manifest can be read without running
  // anything, which is why `keyless`/`needsBase` are declared there — and it is
  // also why they are a SECOND copy of something the factory already says. This
  // is the drift pin: install each bundled example for real and hold the box's
  // blurb to what is in the box.
  //
  // Not a lint over examples/: the assertion needs the loaded descriptor, so it
  // needs the install, which is why it lives in this file and not plugins.test.
  for (const row of await bundledPlugins(db)) {
    const r = await req(base, "POST", "/api/admin/plugins/install",
      { sid: admin.sid, body: { url: row.bundled.path } });
    assert.equal(r.status, 200, `${row.id}: installs`);
    const { ai } = r.json.plugin;
    assert.equal(row.bundled.keyless, !!ai.keyless, `${row.id}: manifest keyless hint`);
    assert.equal(row.bundled.needsBase, !!ai.needsBase, `${row.id}: manifest needsBase hint`);
    await uninstall(db, row.id);
  }
});

test("bundled: each example declares what it does in `provides` alone — the shape the doc teaches", async () => {
  // The examples are the reference PLUGIN.md points at (D2): the legacy
  // capability fields stay accepted but go unwritten, so an example that
  // drifted back to one would teach a shape the doc doesn't have. Read off the
  // factory's own return, BEFORE install() — its backfill writes the legacy
  // fields onto every registered descriptor for the readers that still take
  // them, so a registered one proves nothing. The examples directory is read
  // directly rather than through bundledPlugins, which lists only what isn't
  // installed.
  const legacy = ["defaultModel", "models", "modelFilter", "research", ...Object.values(RENAMED)];
  let seen = 0;
  for (const e of fs.readdirSync(EXAMPLE(""), { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const manifest = manifestIn(EXAMPLE(name));
    if (manifest.kind !== "ai-provider") continue;
    const make = (await import(pathToFileURL(path.join(EXAMPLE(name), manifest.main)).href)).default;
    const built = make(makeCtx(manifest));
    assert.ok(built.provides, `${name}: declares provides`);
    assert.deepEqual(legacy.filter((k) => k in built), [], `${name}: no legacy capability field`);
    seen++;
  }
  assert.equal(seen, 2, "both examples were read");
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

  // Its saved connections go with it, as every other kind's do — and only its
  // own: a built-in source's connection stays (plugin-contract-plan.md,
  // Stage 5, decided with the user).
  await createSourceConnection(db, "acme.filedrop", "Drop A", { host: "a" });
  await createSourceConnection(db, "acme.filedrop", "Drop B", { host: "b" });
  const ftp = await createSourceConnection(db, "ftp", "Someone else's", { host: "ftp" });

  await uninstall(db, id);
  assert.equal(getSourceBackend("acme.filedrop"), null, "unregistered on uninstall");
  assert.equal((await listSources(db)).some((s) => s.type === "acme.filedrop"), false, "gone from the source list");
  assert.equal((await pluginCatalog(db)).some((p) => p.id === id), false, "off the catalog");
  assert.deepEqual(await listSourceConnections(db, "acme.filedrop"), [], "its connections, secrets and all, are gone");
  assert.deepEqual((await listSourceConnections(db, "ftp")).map((c) => c.label), ["Someone else's"], "another source's stays");
  await deleteSourceConnection(db, ftp);
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

test("a domain plugin that never loaded: Retry can't take the domain another plugin holds, and Remove leaves it alone", async () => {
  const domainPlugin = (id) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      id, apiVersion: 1, kind: "connector-domain", domain: "weatherx", label: id, main: "index.js",
    }));
    fs.writeFileSync(path.join(dir, "index.js"),
      `export default () => ({ providers: { "${id}": { label: "${id}", rpm: 30, burst: 15,` +
      " async search() { return []; }, async fetchEntity(x) { return { id: x, fields: {} }; } } }," +
      ` defaultProvider: "${id}", manifest: { label: "${id}" } });\n`);
    return dir;
  };
  const dirA = domainPlugin("acme.wa");
  const dirB = domainPlugin("acme.wb");
  const a = await installFromUrl(db, dirA);
  // A fails to load at boot, and B claims the domain it would have held.
  unregister((await getExternalPlugin(db, a)).manifest);
  await setExternalLoadError(db, a, new Error("failed at boot"));
  const b = await installFromUrl(db, dirB);
  await setSetting(db, "weatherx_provider", "acme.wb");
  const heldByB = getConnector("weatherx");

  // A's Retry gets a fresh install's shadow check: the domain is B's now.
  await assert.rejects(updatePlugin(db, a), /domain "weatherx" already exists/);
  assert.equal(getConnector("weatherx"), heldByB, "B's domain is untouched");
  assert.match((await getExternalPlugin(db, a)).load_error.message, /already exists/, "A's card says why");

  await uninstall(db, a);
  assert.deepEqual(Object.keys(getConnector("weatherx")?.providers || {}), ["acme.wb"], "the domain stays with B");
  assert.equal(await getSetting(db, "weatherx_provider"), "acme.wb", "and so does B's star");
  assert.equal((await pluginCatalog(db)).find((p) => p.id === b).state.loadError, undefined, "B's card is healthy");

  await uninstall(db, b);
  assert.equal(getConnector("weatherx"), null);
  assert.equal(await getSetting(db, "weatherx_provider"), null, "a live domain's uninstall still clears its star");
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test("uninstall: an ai-provider's registered keys are removed", async () => {
  const id = await installFromUrl(db, FIX("acme-ai")); // ai:acme.model, provider "acme.model"
  await createAiKey(db, "acme key", "acme.model", "sk-acme");
  assert.ok((await listAiKeys(db)).some((k) => k.provider === "acme.model"), "key exists before uninstall");

  await uninstall(db, id);
  assert.equal((await listAiKeys(db)).some((k) => k.provider === "acme.model"), false, "no orphan keys for a gone provider");
});

// --- update (plugin-contract Stage 3) ---

test("updatePlugin: a new version swaps in; keys, the election, a board pin and config all stay", async () => {
  const src = copyOf(EXAMPLE("ollama"));
  const id = await installFromUrl(db, src);
  assert.equal(id, "ai:community.ollama");
  const keyId = await createAiKey(db, "ollama box", "community.ollama", "", "http://127.0.0.1:11434/v1");
  await setSetting(db, "embed_key_id", String(keyId)); // elected embedder, through its connection
  const board = await seedBoard(db, "tagged by ollama");
  await db.query("UPDATE boards SET ai_key_id=$1 WHERE id=$2", [keyId, board]); // a board's tagging pinned to it
  await setPluginState(db, id, { config: { rpm: 7 } });
  const before = await getExternalPlugin(db, id);
  const running = PROVIDERS["community.ollama"];

  rewrite(src, "index.js", 'description: "Self-hosted models', 'description: "Updated. Self-hosted models');
  await updatePlugin(db, id);

  assert.notEqual(PROVIDERS["community.ollama"], running, "the new version is the one registered");
  const entry = (await pluginCatalog(db)).find((p) => p.id === id);
  assert.match(entry.description, /^Updated\. /, "the card reads the new code");
  assert.equal(entry.state.keyCount, 1, "its connection survives");
  assert.equal(entry.state.config.rpm, 7, "its config survives");
  assert.equal(await getSetting(db, "embed_key_id"), String(keyId), "the election survives");
  assert.equal((await resolveCapability(db, "embed"))?.provider, "community.ollama", "and still resolves to it");
  const { rows: [pin] } = await db.query("SELECT ai_key_id FROM boards WHERE id=$1", [board]);
  assert.equal(Number(pin.ai_key_id), keyId, "the board pin survives");

  const after = await getExternalPlugin(db, id);
  assert.equal(after.source_url, before.source_url, "from the stored source");
  assert.notEqual(after.dir, before.dir, "into a fresh dir");
  assert.ok(fs.existsSync(after.dir));
  assert.equal(fs.existsSync(before.dir), false, "the prior dir is removed once the new one serves");
  assert.equal(after.load_error, null);

  await uninstall(db, id);
  await setSetting(db, "embed_key_id", null);
  fs.rmSync(src, { recursive: true, force: true });
});

test("updatePlugin: a version that fails leaves the running one exactly as it was", async () => {
  const src = copyOf(FIX("acme-ai"));
  const id = await installFromUrl(db, src);
  const before = await getExternalPlugin(db, id);
  const running = PROVIDERS["acme.model"];
  const good = fs.readFileSync(path.join(src, "index.js"), "utf8");

  // A factory that throws — refused while building, before any registry write.
  fs.writeFileSync(path.join(src, "index.js"), "export default function () { throw new Error('v2 is broken'); }\n");
  await assert.rejects(updatePlugin(db, id), /v2 is broken/);
  // A descriptor only the registry refuses (install()'s price rule): refused at
  // the register write, which throws before it writes.
  fs.writeFileSync(path.join(src, "index.js"), good.replace("rpm: 60,", 'prices: { "acme-1": { input: -1 } }, rpm: 60,'));
  await assert.rejects(updatePlugin(db, id), /prices/);

  assert.equal(PROVIDERS["acme.model"], running, "the running version never left the registry");
  const after = await getExternalPlugin(db, id);
  assert.equal(after.dir, before.dir, "the prior dir is still the one on record");
  assert.ok(fs.existsSync(before.dir), "and still on disk");
  assert.equal(after.load_error, null, "no stored error — the plugin is still serving");
  assert.deepEqual(fs.readdirSync(pluginsTmp).filter((n) => n.startsWith("ai__acme.model@")), [path.basename(before.dir)],
    "the failed versions' dirs are gone");

  await uninstall(db, id);
  fs.rmSync(src, { recursive: true, force: true });
});

test("updatePlugin: Retry on an errored plugin — a failure refreshes its reason, a fix loads it", async () => {
  const src = copyOf(FIX("acme-gecko"));
  const id = await installFromUrl(db, src);
  const before = await getExternalPlugin(db, id);
  // As boot leaves a plugin whose load failed: code on disk, a reason, nothing registered.
  unregister(before.manifest);
  await setExternalLoadError(db, id, new Error("boot load failed once"));

  const good = fs.readFileSync(path.join(src, "index.js"), "utf8");
  fs.writeFileSync(path.join(src, "index.js"), "export default function () { throw new Error('retry still broken'); }\n");
  await assert.rejects(updatePlugin(db, id), /retry still broken/);
  let row = await getExternalPlugin(db, id);
  assert.equal(row.dir, before.dir, "the prior dir is still the one on record");
  assert.ok(fs.existsSync(before.dir), "prior code still on disk");
  assert.match(row.load_error.message, /retry still broken/, "the card says why THIS attempt failed");
  assert.deepEqual(fs.readdirSync(pluginsTmp).filter((n) => n.startsWith("crypto__acme.gecko@")), [path.basename(before.dir)],
    "the failed attempt's dir is gone");

  fs.writeFileSync(path.join(src, "index.js"), good);
  await updatePlugin(db, id);
  row = await getExternalPlugin(db, id);
  assert.equal(row.load_error, null, "loaded, so the reason clears");
  assert.ok(getConnector("crypto").providers["acme.gecko"], "registered");
  assert.equal(fs.existsSync(before.dir), false, "the version that failed at boot is removed");

  await uninstall(db, id);
  fs.rmSync(src, { recursive: true, force: true });
});

test("updatePlugin: a source that now names another plugin, or the same id as another kind, is refused", async () => {
  const src = copyOf(FIX("acme-gecko"));
  const id = await installFromUrl(db, src);
  const before = await getExternalPlugin(db, id);
  const running = getConnector("crypto").providers["acme.gecko"];

  rewrite(src, "manifest.json", '"id": "acme.gecko"', '"id": "acme.other"');
  await assert.rejects(updatePlugin(db, id), /names a different plugin \(connector-provider crypto:acme\.other\)/);
  // The two connector kinds share `<domain>:<id>` — the kind must match too.
  rewrite(src, "manifest.json", '"id": "acme.other"', '"id": "acme.gecko"');
  rewrite(src, "manifest.json", '"kind": "connector-provider"', '"kind": "connector-domain"');
  await assert.rejects(updatePlugin(db, id), /names a different plugin \(connector-domain crypto:acme\.gecko\)/);

  assert.equal(getConnector("crypto").providers["acme.gecko"], running, "still the running version");
  assert.deepEqual(await getExternalPlugin(db, id), before, "the record is untouched");
  await uninstall(db, id);
  fs.rmSync(src, { recursive: true, force: true });
});

test("updatePlugin: a domain plugin's face producers follow the new version", async () => {
  const src = copyOf(FIX("acme-weatherface"));
  const id = await installFromUrl(db, src);
  const tile = "acme.weatherface.tile";

  // v2 draws its tile at a new size: the registered producer is v2's function.
  rewrite(src, "index.js", "w: 120, h: 90", "w: 60, h: 45");
  await updatePlugin(db, id);
  assert.equal((await getFaceProducer(tile)([{ t: 0, price: 1 }])).w, 60, "the new producer is the registered one");

  // v3 stops declaring the producer, but its faces map still names it. v2's is
  // still registered while v3 is checked, and must not count for v3.
  rewrite(src, "manifest.json", '"faceProducers": ["acme.weatherface.tile"]', '"faceProducers": []');
  await assert.rejects(updatePlugin(db, id), /faces\.tile names face producer "acme\.weatherface\.tile"/);
  assert.equal(typeof getFaceProducer(tile), "function", "the running version keeps its producer");

  // v4 drops it for real (the slot moves to the built-in chart): it's unregistered.
  rewrite(src, "index.js", 'faces: { tile: "acme.weatherface.tile" }', 'faces: { tile: "price-chart" }');
  await updatePlugin(db, id);
  assert.equal(getFaceProducer(tile), null, "a producer the new version dropped is unregistered");
  assert.ok(getConnector("weatherface"), "and the domain is still registered");

  await uninstall(db, id);
  fs.rmSync(src, { recursive: true, force: true });
});

test("updatePlugin: a domain plugin's update keeps the providers other plugins added to it", async () => {
  const domain = await installFromUrl(db, FIX("acme-weather"));
  const provDir = fs.mkdtempSync(path.join(os.tmpdir(), "wprov-"));
  fs.writeFileSync(path.join(provDir, "manifest.json"), JSON.stringify({
    id: "acme.wprov", apiVersion: 1, kind: "connector-provider", domain: "weather", label: "Acme W provider", main: "index.js",
  }));
  fs.writeFileSync(path.join(provDir, "index.js"),
    'export default () => ({ label: "Acme W provider", rpm: 30, burst: 15,' +
    " async search() { return []; }, async fetchEntity(id) { return { id, fields: {} }; } });\n");
  const provider = await installFromUrl(db, provDir);
  await setSetting(db, "weather_provider", "acme.wprov"); // the domain's star is the other plugin's provider
  const theirs = getConnector("weather").providers["acme.wprov"];
  assert.equal((await getConnector("weather").activeProvider(db)).name, "acme.wprov");

  await updatePlugin(db, domain);
  assert.equal(getConnector("weather").providers["acme.wprov"], theirs, "their provider moved into the new version's domain");
  assert.equal((await getConnector("weather").activeProvider(db)).name, "acme.wprov", "so the star still resolves to it");
  assert.equal((await pluginCatalog(db)).find((p) => p.id === provider).state.loadError, undefined, "and its card stays healthy");

  await uninstall(db, provider);
  await uninstall(db, domain);
  fs.rmSync(provDir, { recursive: true, force: true });
});

test("a plugin's declared rates reach the meter at install, follow an update, and leave with it", async () => {
  const src = copyOf(FIX("acme-ai"));
  const good = fs.readFileSync(path.join(src, "index.js"), "utf8");
  const priced = (input, output) =>
    fs.writeFileSync(path.join(src, "index.js"), good.replace("rpm: 60,", `prices: { "acme-1": { input: ${input}, output: ${output} } }, rpm: 60,`));
  priced(3, 15);
  const id = await installFromUrl(db, src);
  assert.deepEqual(ratesFor("acme.model", "acme-1"), { input: 3, output: 15 }, "stamped from the first call, not after the next restart");
  priced(5, 25);
  await updatePlugin(db, id);
  assert.deepEqual(ratesFor("acme.model", "acme-1"), { input: 5, output: 25 }, "the new version's rates, not the old one's");
  await uninstall(db, id);
  assert.deepEqual(ratesFor("acme.model", "acme-1"), {}, "gone with the plugin");
  fs.rmSync(src, { recursive: true, force: true });
});

test("installFromUrl: an installed id is refused — an errored one is pointed at Retry", async () => {
  const id = await installFromUrl(db, FIX("acme-gecko"));
  unregister((await getExternalPlugin(db, id)).manifest);
  await setExternalLoadError(db, id, new Error("failed at boot"));
  await assert.rejects(installFromUrl(db, FIX("acme-gecko")), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /failed to load — Retry it from its card/);
    return true;
  });
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
  assert.equal(ok.json.plugin.source.version, "1.0.0", "the manifest's version rides the card's source line");

  const dup = await req(base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: { url: FIX("acme-gecko") } });
  assert.equal(dup.status, 409);

  assert.equal((await req(base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: {} })).status, 400);
});

test("PATCH /api/admin/plugins/:id: an external plugin is removed, never switched off", async () => {
  // (acme.gecko is installed from the previous test.) Its card reads installed
  // off the install record, while resolution and the connector runtime read the
  // plugins row — `false` would make the two disagree.
  const off = await req(base, "PATCH", "/api/admin/plugins/crypto:acme.gecko", { sid: admin.sid, body: { installed: false } });
  assert.equal(off.status, 400);
  assert.match(off.json.error, /removed, not toggled/);
  // `true` is the row install already wrote, and the welcome flow sends it for
  // the bundled plugin it has just installed — it must keep answering 200.
  const on = await req(base, "PATCH", "/api/admin/plugins/crypto:acme.gecko", { sid: admin.sid, body: { installed: true } });
  assert.equal(on.status, 200);
  assert.equal(on.json.state.installed, true);
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

test("POST /api/admin/plugins/:id/update: admin-only; answers the fresh card; refuses a built-in", async () => {
  const id = await installFromUrl(db, FIX("acme-gecko"));
  assert.equal((await req(base, "POST", `/api/admin/plugins/${id}/update`)).status, 403); // anon
  const ok = await req(base, "POST", `/api/admin/plugins/${id}/update`, { sid: admin.sid });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.plugin.id, id);
  assert.equal(ok.json.plugin.source.ref, "local");
  const builtin = await req(base, "POST", "/api/admin/plugins/crypto:coingecko/update", { sid: admin.sid });
  assert.equal(builtin.status, 400);
  assert.match(builtin.json.error, /not an installed plugin/);
  await uninstall(db, id);
});

test("PLUGIN_INSTALL_DISABLE: install and update refuse every source but a bundled one", async () => {
  const typed = await installFromUrl(db, FIX("acme-gecko")); // installed before the lock
  process.env.PLUGIN_INSTALL_DISABLE = "1";
  try {
    const page = await req(base, "GET", "/api/admin/plugins", { sid: admin.sid });
    assert.equal(page.json.installLocked, true, "the page learns its URL box is closed");
    for (const url of ["github:acme/gecko", FIX("acme-weather")]) {
      const r = await req(base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: { url } });
      assert.equal(r.status, 403, url);
      assert.match(r.json.error, /PLUGIN_INSTALL_DISABLE/);
    }
    assert.equal((await req(base, "POST", `/api/admin/plugins/${typed}/update`, { sid: admin.sid })).status, 403,
      "an update from a typed path too");

    // The image's own examples stay open: the welcome flow installs them.
    const row = (await bundledPlugins(db)).find((p) => p.id === "ai:community.ollama");
    const add = await req(base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: { url: row.bundled.path } });
    assert.equal(add.status, 200);
    assert.equal(add.json.plugin.source.bundled, true, "an installed example's card knows where it came from");
    assert.equal((await req(base, "POST", "/api/admin/plugins/ai:community.ollama/update", { sid: admin.sid })).status, 200);
    assert.equal((await pluginCatalog(db)).find((p) => p.id === typed).source.bundled, false);
  } finally {
    delete process.env.PLUGIN_INSTALL_DISABLE;
  }
  assert.equal((await req(base, "GET", "/api/admin/plugins", { sid: admin.sid })).json.installLocked, false);
  await uninstall(db, typed);
  await uninstall(db, "ai:community.ollama");
});

// The real download → unpack → unwrap → load path, exercised hermetically
// against a local HTTP server serving a genuine .tgz (built like github/npm: one
// wrapper dir). The GitHub test below runs the same branch with GitHub's naming.
test("installFromUrl: a tarball URL downloads, unwraps its top directory, and loads", async () => {
  const tgz = fs.readFileSync(fileURLToPath(new URL("./fixtures/plugin-tarball.tgz", import.meta.url)));
  const id = await serving(tgz, (url) => installFromUrl(db, url));
  assert.equal(id, "crypto:acme.gecko");
  assert.ok(getConnector("crypto").providers["acme.gecko"], "registered from the downloaded tarball");
  const row = await getExternalPlugin(db, id);
  assert.ok(fs.existsSync(path.join(row.dir, "manifest.json")), "the wrapper dir was unwrapped");
  await uninstall(db, id);
});

// One owner for the staging dir (withStage): it goes whether the fetched
// plugin is committed, refused after the fetch, or never fetched at all.
test("installFromUrl: no staging dir outlives an install — committed, refused or failed", async () => {
  const leftover = () => fs.readdirSync(path.join(pluginsTmp, ".staging"));
  const id = await installFromUrl(db, FIX("acme-gecko"));
  assert.deepEqual(leftover(), [], "committed: renamed into place");
  await assert.rejects(installFromUrl(db, FIX("acme-gecko")), /already installed/);
  assert.deepEqual(leftover(), [], "refused after the fetch");
  await assert.rejects(installFromUrl(db, path.join(pluginsTmp, "no-such-plugin")), /not found/);
  assert.deepEqual(leftover(), [], "failed at the fetch");
  await uninstall(db, id);
});

test("fetchModule: a GitHub archive's top directory names the commit that ran", async () => {
  const gecko = ["manifest.json", "index.js"].map((f) => [f, fs.readFileSync(path.join(FIX("acme-gecko"), f), "utf8")]);
  const at = (top) => gecko.map(([f, c]) => [`${top}/${f}`, c]);
  // fetchModule takes a resolved source; a github one aimed at a local server
  // runs GitHub's real path — download, unpack, lift, read the top directory.
  const fetchGithub = async (files, { ref = null, subdir = null } = {}) => {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "gh-staging-"));
    try {
      const { resolvedRef } = await serving(await tgzOf(files),
        (url) => fetchModule({ kind: "github", tarballUrl: url, ref, subdir }, staging));
      return { resolvedRef, files: fs.readdirSync(staging).sort() };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  };

  // The default branch — the case whose card used to say only `default`.
  assert.deepEqual(await fetchGithub(at("acme-gecko-7fd1a60")),
    { resolvedRef: "default@7fd1a60", files: ["index.js", "manifest.json"] });
  // A branch, and a plugin inside a repo: the archive is the whole repo.
  const repo = [["acme-plugins-0badc0f/README.md", "the repo"], ...at("acme-plugins-0badc0f/plugins/gecko")];
  assert.deepEqual(await fetchGithub(repo, { ref: "main", subdir: "plugins/gecko" }),
    { resolvedRef: "main@0badc0f", files: ["index.js", "manifest.json"] });
  // A ref that already is the commit isn't repeated.
  assert.equal((await fetchGithub(at("acme-gecko-7fd1a60"), { ref: "7fd1a60" })).resolvedRef, "7fd1a60");
  // No sha on the directory: the ref alone, as before.
  assert.equal((await fetchGithub(at("acme-gecko-main"), { ref: "v1.2" })).resolvedRef, "v1.2");
});

test("installFromUrl: an archive needs one top-level directory; loose files beside it are dropped", async () => {
  const body = await tgzOf([["manifest.json", "{}"], ["index.js", "export default () => ({});\n"]]);
  await serving(body, (url) => assert.rejects(installFromUrl(db, url), /one top-level directory/));
  // A loose file at the root — a macOS `._` entry beside the plugin, say — was
  // always dropped by --strip-components, and still is.
  const gecko = ["manifest.json", "index.js"].map((f) => [`acme-gecko/${f}`, fs.readFileSync(path.join(FIX("acme-gecko"), f), "utf8")]);
  const id = await serving(await tgzOf([["._acme-gecko", "xattrs"], ...gecko]), (url) => installFromUrl(db, url));
  assert.equal(id, "crypto:acme.gecko");
  assert.deepEqual(fs.readdirSync((await getExternalPlugin(db, id)).dir).sort(), ["index.js", "manifest.json"]);
  await uninstall(db, id);
});
