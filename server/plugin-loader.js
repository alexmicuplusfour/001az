// Dynamic plugin loader (phase 2). Loads external, dynamically-installed plugins
// — code fetched from a URL and npm-installed onto the /data/plugins volume
// (fetch/install is server/plugin-fetch.js, slice 2) — and registers them into
// the live registries (PROVIDERS / CONNECTORS) so they flow through the same
// catalog (server/plugins.js) as built-ins.
//
// Three invariants make runtime code-loading trustworthy:
//  1. Validate everything BEFORE touching a registry (register-last): a manifest
//     or factory that fails leaves ZERO writes — never a half-registered map.
//  2. The contract carries the protocol: a plugin reaches the network only via
//     `ctx.fetchJson`, whose errors carry .status/.retryAfter, so it inherits
//     core's rate-limit + 429 backoff (runtime.js withRetry) by construction.
//  3. Per-plugin isolation: loadAll try/catches each plugin — a bad one records a
//     structured load_error and shows an errored card; boot never crashes.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerProvider, unregisterProvider } from "./providers.js";
import {
  getConnector,
  registerConnector, unregisterConnector,
  registerConnectorProvider, unregisterConnectorProvider,
} from "./connectors/index.js";
import { resetDefs } from "./plugins.js";
import { providerSignal } from "./connectors/runtime.js";
import { renderChart } from "./connectors/faces/price-chart.js";
import { listExternalPlugins, setExternalLoadError } from "./db.js";

// The contract version. A plugin's manifest.apiVersion major must equal this;
// bump only on a breaking change to the manifest / ctx / return shapes.
export const PLUGIN_API_VERSION = 1;

const KINDS = new Set(["ai-provider", "connector-provider", "connector-domain"]);

// The other catalog segments a connector-domain must not claim — a domain named
// "ai"/"media"/"source" would mint catalog ids that collide with those families.
// (Existing connector domains like crypto are caught separately, at loadDir, by
// the getConnector shadow check.)
const RESERVED_DOMAINS = new Set(["ai", "media", "source"]);

// --- the ctx facade: the whole stable surface a plugin may use ---
// Per-request context (apiKey, abort signal) rides the per-call opts instead
// (provider.search(q, { apiKey, signal })), NOT ctx.

// The one sanctioned way for a plugin to hit the network. Mirrors the built-in
// providers' error shape (see coingecko.js cgFail) so a plugin's failures speak
// the runtime's retry protocol: a 429/401 with Retry-After backs off instead of
// bubbling as a dead error. A caller may pass its own signal; otherwise the
// standard outbound deadline applies.
async function fetchJson(url, { signal, ...opts } = {}) {
  const r = await fetch(url, { ...opts, signal: signal ?? providerSignal() });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status} for ${url}`);
    e.status = r.status;
    const ra = r.headers?.get?.("retry-after");
    if (ra != null) e.retryAfter = ra;
    throw e;
  }
  return r.json();
}

const makeCtx = (manifest) => ({
  apiVersion: PLUGIN_API_VERSION,
  fetchJson,
  renderChart, // face rendering, for connector plugins that ship a chart face
  log: (...a) => console.log(`[plugin ${manifest.id}]`, ...a),
});

// --- validation (pure — no registry writes) ---

export function validateManifest(m) {
  if (!m || typeof m !== "object") throw new Error("manifest.json is missing or not an object");
  if (typeof m.id !== "string" || !m.id.includes("."))
    throw new Error('manifest.id must be a namespaced "vendor.name" string (a dot separates vendor from name)');
  // The id becomes half of the catalog id (split on ':') and, at install, the
  // on-disk dir name — so keep it to path- and id-safe characters.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(m.id))
    throw new Error("manifest.id may contain only letters, digits, '.', '-', '_'");
  if (typeof m.apiVersion !== "number") throw new Error("manifest.apiVersion must be a number");
  if (Math.trunc(m.apiVersion) !== PLUGIN_API_VERSION)
    throw new Error(`unsupported apiVersion ${m.apiVersion} — this host supports ${PLUGIN_API_VERSION}`);
  if (!KINDS.has(m.kind)) throw new Error(`manifest.kind must be one of: ${[...KINDS].join(", ")}`);
  if (typeof m.label !== "string" || !m.label) throw new Error("manifest.label is required");
  if (typeof m.main !== "string" || !m.main || m.main.includes(".."))
    throw new Error("manifest.main must be a relative path inside the plugin (no '..')");
  if (m.kind === "connector-provider" || m.kind === "connector-domain") {
    if (typeof m.domain !== "string" || !m.domain) throw new Error(`${m.kind} requires manifest.domain`);
    // The domain is a catalog segment (before the ':') and a map key — a simple slug.
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(m.domain))
      throw new Error("manifest.domain must be a simple slug (letters, digits, '-')");
    if (m.kind === "connector-domain" && RESERVED_DOMAINS.has(m.domain.toLowerCase()))
      throw new Error(`manifest.domain "${m.domain}" is reserved`);
  }
}

// Validate the object the factory returned, per kind (the shape the registries
// expect). Kept minimal — enough to fail fast with a readable reason.
function validateBuilt(m, built) {
  if (!built || typeof built !== "object") throw new Error("the plugin factory must return an object");
  if (m.kind === "ai-provider") {
    // `wire` is the dispatch object ({ tag, embed, testKey }); an embed-only
    // provider (like the built-in local one) has wire null + embeds set. Reject
    // only a descriptor that can neither tag nor embed — matches aiDefs' !!wire.
    if (!built.wire && !built.embeds)
      throw new Error("ai-provider must return a descriptor with a wire (tagging) or embeds config");
    if (!built.label) throw new Error("ai-provider descriptor needs a label");
    // defaultModel names the tagging model; only a tagging (wire) provider needs
    // one. An embed-only descriptor (wire null, embeds set) legitimately has none
    // — the built-in `local` is exactly this shape.
    if (built.wire && !built.defaultModel) throw new Error("a tagging ai-provider descriptor needs a defaultModel");
  } else if (m.kind === "connector-provider") {
    if (typeof built.search !== "function" || typeof built.fetchEntity !== "function")
      throw new Error("connector-provider must return a provider with search() and fetchEntity()");
  } else if (m.kind === "connector-domain") {
    if (!built.providers || !Object.keys(built.providers).length)
      throw new Error("connector-domain must return a non-empty providers map");
    if (!built.defaultProvider || !built.providers[built.defaultProvider])
      throw new Error("connector-domain defaultProvider must be a key of providers");
    if (!built.manifest) throw new Error("connector-domain must return a domain manifest");
  }
}

// The catalog id a plugin owns: `<segment>:<vendor.name>`. Segment is "ai" or the
// (existing or new) connector domain. One plugin = one primary card = one row.
export function catalogIdFor(m, built) {
  if (m.kind === "ai-provider") return `ai:${m.id}`;
  if (m.kind === "connector-provider") return `${m.domain}:${m.id}`;
  return `${m.domain}:${built.defaultProvider}`; // connector-domain
}

// --- load / register (the ONE place a registry is mutated) ---

const readManifest = (dir) => {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8"); }
  catch { throw new Error(`no manifest.json in ${dir}`); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`manifest.json is not valid JSON: ${e.message}`); }
};

async function buildModule(dir, manifest) {
  // Per-version dirs (<id>@<ref>) already bust Node's ESM cache across upgrades;
  // the query param covers a same-dir Retry within one process.
  const url = pathToFileURL(path.join(dir, manifest.main)).href + `?t=${Date.now()}`;
  const mod = await import(url);
  if (typeof mod.default !== "function")
    throw new Error("plugin main must default-export a factory: (ctx) => …");
  return mod.default(makeCtx(manifest));
}

function registerBuilt(manifest, built) {
  switch (manifest.kind) {
    case "ai-provider": registerProvider(manifest.id, built); break;
    case "connector-provider": registerConnectorProvider(manifest.domain, manifest.id, built); break;
    case "connector-domain": registerConnector(manifest.domain, built); break;
  }
  resetDefs(); // the live registries changed → rebuild the memoized catalog defs
}

// Undo a registration (uninstall / failed reload). `manifest` is the stored one.
export function unregister(manifest) {
  switch (manifest.kind) {
    case "ai-provider": unregisterProvider(manifest.id); break;
    case "connector-provider": unregisterConnectorProvider(manifest.domain, manifest.id); break;
    case "connector-domain": unregisterConnector(manifest.domain); break;
  }
  resetDefs();
}

// Load ONE plugin from its on-disk dir and register it. Everything before
// registerBuilt is validation/build with no side effects, so a throw here leaves
// the registries untouched. Returns { catalogId, manifest } on success.
export async function loadDir(dir) {
  const manifest = readManifest(dir);
  validateManifest(manifest);
  const built = await buildModule(dir, manifest);
  validateBuilt(manifest, built);
  // A connector-domain must NOT shadow an existing domain (a built-in like crypto,
  // or another plugin's) — replacing a domain wholesale is not what "add a data
  // source" means; adding a provider to an existing domain is connector-provider.
  // A reload unregisters the old domain first, so this still permits re-installing
  // a plugin's own domain.
  if (manifest.kind === "connector-domain" && getConnector(manifest.domain))
    throw new Error(`domain "${manifest.domain}" already exists — use kind "connector-provider" to add a provider to it`);
  const catalogId = catalogIdFor(manifest, built);
  registerBuilt(manifest, built);
  return { catalogId, manifest };
}

// Boot hook: load every recorded external plugin, isolated. A failure records a
// structured load_error (surfaced as an errored card by pluginCatalog) and is
// logged; the next plugin still loads and boot proceeds.
export async function loadAll(db) {
  // Load connector-domain plugins first: a connector-provider may extend a domain
  // another plugin supplies, and registering into an absent domain throws. DB row
  // order is otherwise arbitrary, so pin domains ahead of everything else.
  const rows = (await listExternalPlugins(db))
    .sort((a, b) => (a.kind === "connector-domain" ? 0 : 1) - (b.kind === "connector-domain" ? 0 : 1));
  let ok = 0;
  for (const row of rows) {
    try {
      await loadDir(row.dir);
      if (row.load_error) await setExternalLoadError(db, row.id, null); // heal only if it was errored
      ok++;
    } catch (err) {
      console.error(`plugin ${row.id}: load failed — ${err.message}`);
      await setExternalLoadError(db, row.id, err).catch(() => {});
    }
  }
  if (rows.length) console.log(`plugins: loaded ${ok}/${rows.length} external plugin(s)`);
}
