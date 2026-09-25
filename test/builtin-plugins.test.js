// Every built-in provider is written against the plugin contract
// (planning/plugin-contract-plan.md, Stage 1): it reaches core only through the
// ctx a plugin is handed, it passes the rules the loader holds a plugin to, and
// a verbatim copy of one installs as a plugin. The built-in domains and sources
// pass the loader's shape rules too (Stage 2), so no rule can be stricter than
// what core ships. No server and no database — the loader's registration path
// needs neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDir, unregister, validateBuilt, validateDomainModule } from "../server/plugin-loader.js";
import { makeCtx, PLUGIN_API_VERSION } from "../server/plugin-ctx.js";
import { getConnector, listConnectors } from "../server/connectors/index.js";
import { sourceModules } from "../server/ingestion/sources/index.js";
import { BUILTIN_PROVIDERS } from "../server/ai-providers/index.js";

const SERVER = fileURLToPath(new URL("../server/", import.meta.url));

// The built-in data providers, read off the registry before anything else can
// register into it: each domain's provider `<name>` lives at
// connectors/<domain>/<name>.js, and one added later is held to these rules
// without an edit here.
const DATA_PROVIDERS = listConnectors().flatMap((c) =>
  c.providers.map((p) => ({
    domain: c.name,
    name: p.name,
    file: path.join(SERVER, "connectors", c.name, `${p.name}.js`),
  })));

const modulesIn = (dir) =>
  fs.readdirSync(path.join(SERVER, dir))
    .filter((n) => n.endsWith(".js") && n !== "index.js")
    .map((n) => path.join(SERVER, dir, n));

// Every import specifier in a module: static, side-effect, re-export, dynamic.
const IMPORT_FORMS = [
  /\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];
const importsOf = (src) => IMPORT_FORMS.flatMap((re) => [...src.matchAll(re)].map((m) => m[1]));

// What a plugin directory can resolve on its own: node builtins, its own npm
// dependencies, and files beside it. Anything that climbs out is core.
const reachableFromAPluginDir = (spec) =>
  spec.startsWith("node:") ||
  (spec.startsWith("./") && !spec.split("/").includes("..")) ||
  (!spec.startsWith(".") && !spec.startsWith("/") && !spec.includes(":"));

test("the data providers are found where the registry says they live", () => {
  assert.ok(DATA_PROVIDERS.length >= 3, "the built-in domains register their providers");
  for (const { file } of DATA_PROVIDERS) assert.ok(fs.existsSync(file), `${file} exists`);
});

test("no built-in provider imports anything a plugin directory couldn't", () => {
  const dirs = [
    ...new Set(DATA_PROVIDERS.map((p) => path.join("connectors", p.domain))),
    "ingestion/sources",
    "ai-providers",
  ];
  const climbs = [];
  for (const dir of dirs) {
    const files = modulesIn(dir);
    assert.ok(files.length, `${dir}: nothing to scan — the pin would pass vacuously`);
    for (const file of files)
      for (const spec of importsOf(fs.readFileSync(file, "utf8")))
        if (!reachableFromAPluginDir(spec)) climbs.push(`${path.relative(SERVER, file)} imports "${spec}"`);
  }
  assert.deepEqual(climbs, [], "a built-in provider reaches core only through ctx (plugin-ctx.js)");
});

test("every built-in provider passes the rules the loader holds a plugin to", async () => {
  // Built exactly as the loader builds a plugin: the default export, called
  // with a fresh ctx.
  for (const { domain, name, file } of DATA_PROVIDERS) {
    const make = (await import(pathToFileURL(file).href)).default;
    assert.equal(typeof make, "function", `${name}: default-exports its factory`);
    assert.doesNotThrow(() =>
      validateBuilt({ kind: "connector-provider", domain, id: name }, make(makeCtx({ id: name }))), name);
  }
  let checked = 0;
  for (const [name, make] of Object.entries(BUILTIN_PROVIDERS)) {
    const built = make(makeCtx({ id: name }));
    // Sidecar-backed engines advertise a capability with no wire of their own;
    // the loader refuses that shape from a plugin on purpose (its wire check).
    if (built.liveCatalog) continue;
    assert.doesNotThrow(() => validateBuilt({ kind: "ai-provider", id: name }, built), name);
    checked++;
  }
  assert.ok(checked >= 5, "the keyed providers and the in-process embedder were checked");
});

test("the built-in domains and sources pass the shape rules a plugin is held to", async () => {
  // The domain half only: the identity rules can't apply — crypto carries two
  // providers, where a plugin domain carries exactly one, its own (D5).
  const domains = [...new Set(DATA_PROVIDERS.map((p) => p.domain))];
  assert.ok(domains.length >= 2, "the built-in domains were found");
  for (const domain of domains) {
    const mod = await import(pathToFileURL(path.join(SERVER, "connectors", domain, "index.js")).href);
    assert.doesNotThrow(() => validateDomainModule(mod, { domain }), domain);
  }
  const sources = sourceModules();
  assert.ok(sources.length >= 3, "the built-in sources were found");
  for (const mod of sources)
    assert.doesNotThrow(() => validateBuilt({ kind: "source", id: mod.manifest.name }, mod), mod.manifest.name);
});

test("a built-in data provider, copied verbatim into a plugin directory, installs as a plugin", async () => {
  for (const { domain, name, file } of DATA_PROVIDERS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `builtin-copy-${name}-`));
    try {
      fs.copyFileSync(file, path.join(dir, "index.js"));
      const id = `copy.${name}`;
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
        id, apiVersion: PLUGIN_API_VERSION, kind: "connector-provider",
        domain, label: `${name} (a verbatim copy)`, main: "index.js",
      }));
      const { catalogId, manifest } = await loadDir(dir);
      try {
        assert.equal(catalogId, `${domain}:${id}`);
        const { providers } = getConnector(domain);
        assert.ok(providers[id], `${name}: the copy registered into ${domain}`);
        assert.notEqual(providers[id], providers[name], `${name}: its own instance, with its own caches`);
        assert.deepEqual(Object.keys(providers[id]), Object.keys(providers[name]), `${name}: the same surface as the built-in`);
      } finally {
        unregister(manifest);
      }
      assert.equal(getConnector(domain).providers[id], undefined, `${name}: the copy unregisters cleanly`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
