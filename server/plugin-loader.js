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
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { resolveSource, fetchModule } from "./plugin-fetch.js";
import { registerProvider, unregisterProvider } from "./providers.js";
import {
  getConnector,
  registerConnector, unregisterConnector,
  registerConnectorProvider, unregisterConnectorProvider,
} from "./connectors/index.js";
import { resetDefs } from "./plugins.js";
import { providerSignal } from "./connectors/runtime.js";
import { renderChart } from "./connectors/faces/price-chart.js";
import {
  listExternalPlugins, setExternalLoadError, getExternalPlugin,
  upsertExternalPlugin, deleteExternalPlugin, deletePluginRow, setPluginState,
  getSetting, setSetting, listAiKeys, deleteAiKey,
} from "./db.js";

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
  // Opt-in to running npm lifecycle scripts at install (native modules). Default
  // off — nothing executes until the manifest validates and the factory loads.
  if (m.allowScripts !== undefined && typeof m.allowScripts !== "boolean")
    throw new Error("manifest.allowScripts must be a boolean");
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
    // The default provider is named for the plugin so the catalog id
    // (`<domain>:<id>`) is knowable from the manifest ALONE — needed to name the
    // install dir and dedupe reinstalls before the module is ever loaded.
    if (built.defaultProvider !== m.id)
      throw new Error(`connector-domain defaultProvider must equal manifest.id ("${m.id}")`);
    if (!built.manifest) throw new Error("connector-domain must return a domain manifest");
  }
}

// The catalog id a plugin owns: `<segment>:<vendor.name>`. Segment is "ai" or the
// (existing or new) connector domain. One plugin = one primary card = one row.
// Manifest-only (a connector-domain's defaultProvider === id, enforced above), so
// the id is known before the module loads — the install flow needs it to name the
// dir and detect a reinstall.
export function catalogIdFor(m) {
  if (m.kind === "ai-provider") return `ai:${m.id}`;
  return `${m.domain}:${m.id}`; // connector-provider + connector-domain
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
  const catalogId = catalogIdFor(manifest);
  registerBuilt(manifest, built);
  return { catalogId, manifest };
}

// Boot hook: load every recorded external plugin, isolated. A failure records a
// structured load_error (surfaced as an errored card by pluginCatalog) and is
// logged; the next plugin still loads and boot proceeds.
export async function loadAll(db) {
  // Reclaim staging dirs orphaned by a hard kill mid-install — nothing else
  // sweeps them, and installs recreate `.staging` on demand. Safe here: boot runs
  // before any route serves, so no install is ever in flight.
  fs.rmSync(path.join(pluginsDir(), ".staging"), { recursive: true, force: true });
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

// --- install / uninstall (slice 2) ---

const run = promisify(execFile);
const NPM_TIMEOUT_MS = Number(process.env.PLUGIN_NPM_TIMEOUT_MS) || 180000;

// Where installed code lives — a node-owned dir on the persistent /data volume,
// so installs survive restarts AND image rebuilds. Read lazily so tests can point
// it at a temp dir.
export const pluginsDir = () => process.env.PLUGINS_DIR || "/data/plugins";

const sanitizeRef = (ref) => String(ref || "ref").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "ref";

// Run `npm install --omit=dev` in a plugin dir — but ONLY if it declares
// dependencies. A dep-free plugin (the common connector/AI case) skips npm
// entirely, so there's no network when there's nothing to fetch and the install
// path stays offline-testable. Lifecycle scripts are OFF unless the manifest
// opts in (`allowScripts`) — nothing executes before validate + load.
async function npmInstall(dir, { allowScripts }) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); }
  catch { return; } // no package.json → nothing to install
  if (!pkg.dependencies || !Object.keys(pkg.dependencies).length) return;
  const args = ["install", "--omit=dev", "--no-audit", "--no-fund"];
  if (!allowScripts) args.push("--ignore-scripts");
  try {
    // maxBuffer well above execFile's 1 MB default — a chatty-but-successful npm
    // install must not spuriously fail with ENOBUFS.
    await run("npm", args, { cwd: dir, timeout: NPM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NODE_ENV: "production" } });
  } catch (e) {
    const tail = String(e.stderr || e.stdout || e.message || "").split("\n").slice(-8).join("\n").trim();
    throw new Error(`npm install failed: ${tail}`);
  }
}

// Install a plugin from a URL: fetch → npm install → validate → move into place →
// register → persist. Atomic — everything happens in a staging dir first, and
// only an atomic rename commits it; any failure cleans up and persists nothing.
// Reinstall policy: a healthy id must be removed first (readable throw); an
// ERRORED one (row present, load_error set, never registered) is retried in place.
// Returns the loaded plugin's catalog id.
export async function installFromUrl(db, url) {
  const source = resolveSource(url);
  const root = pluginsDir();
  fs.mkdirSync(path.join(root, ".staging"), { recursive: true });
  const staging = path.join(root, ".staging", crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(staging, { recursive: true });

  try {
    const { resolvedRef } = await fetchModule(source, staging);
    const manifest = readManifest(staging);
    validateManifest(manifest);
    const catalogId = catalogIdFor(manifest);

    const existing = await getExternalPlugin(db, catalogId);
    if (existing && !existing.load_error) {
      const e = new Error(`${manifest.label} is already installed — remove it first`);
      e.status = 409;
      throw e;
    }

    await npmInstall(staging, { allowScripts: !!manifest.allowScripts });

    // Commit into a fresh, unique dir (`…@<ref>-<nonce>`). Every install lands in
    // its own directory, so a failed (re)install can never overwrite the code
    // that's already on disk — the pre-install state is always recoverable. The
    // dir name is cosmetic: reinstalls dedupe by catalog id (the DB row) and
    // `resolved_ref` is shown from its own column, not parsed from the dir name.
    // The full catalog id (not manifest.id alone) keeps one vendor.name used
    // across two domains from colliding.
    const dir = path.join(root, `${catalogId.replace(/[:/\\]/g, "__")}@${sanitizeRef(resolvedRef)}-${crypto.randomBytes(3).toString("hex")}`);
    fs.renameSync(staging, dir); // atomic commit (same filesystem as PLUGINS_DIR)

    try {
      await loadDir(dir); // validates + registers (register-last)
    } catch (err) {
      // Roll back to exactly the pre-install state: drop only the just-fetched
      // code, leave any existing (even errored) dir + row untouched, and refresh
      // the stored reason so an errored retry's card shows why THIS attempt failed.
      fs.rmSync(dir, { recursive: true, force: true });
      if (existing) await setExternalLoadError(db, catalogId, err).catch(() => {});
      throw err;
    }

    await upsertExternalPlugin(db, { id: catalogId, kind: manifest.kind, sourceUrl: String(url), resolvedRef, dir, manifest });
    await setPluginState(db, catalogId, { installed: true }); // enforcement (pluginRowState) reads this
    // Loaded + persisted — now it's safe to drop the prior dir (a reinstall or an
    // errored retry with a different ref); nothing points at it anymore.
    if (existing?.dir && existing.dir !== dir) fs.rmSync(existing.dir, { recursive: true, force: true });
    console.log(`plugin ${catalogId} installed from ${url}`);
    return catalogId;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true }); // no-op once renamed away
  }
}

// Uninstall an external plugin: unregister → drop both rows → clear its stored
// secrets/selection → remove its code. Built-in ids have no external_plugins row
// → readable throw (they use PATCH installed:false, which is availability, not
// removal, and deliberately keeps their config).
export async function uninstall(db, id) {
  const row = await getExternalPlugin(db, id);
  if (!row) throw new Error("not an installed plugin (built-ins can't be uninstalled)");
  unregister(row.manifest);
  await deleteExternalPlugin(db, id);
  await deletePluginRow(db, id); // its config/health
  await cleanupPluginConfig(db, row.manifest);
  if (row.dir) fs.rmSync(row.dir, { recursive: true, force: true });
  console.log(`plugin ${id} uninstalled`);
}

// A true uninstall leaves NOTHING behind (unlike a built-in's reversible
// installed:false). Runtime paths already degrade gracefully when these linger —
// activeProvider falls back, the worker gates on aiPluginInstalled — but keeping
// them would retain key material after removal AND silently re-activate the
// provider on a later reinstall. Surgical, never prefix-based: a domain name
// could otherwise collide with another setting family (e.g. a domain "embed"
// vs the embed_key_id / embed_model settings).
async function cleanupPluginConfig(db, manifest) {
  if (manifest.kind === "ai-provider") {
    // Every key registered for this provider (deleteAiKey also handles board
    // fallback + clearing the default-tagger pointer).
    for (const k of await listAiKeys(db)) {
      if (k.provider === manifest.id) await deleteAiKey(db, k.id);
    }
    return;
  }
  // connector-provider | connector-domain: the provider's API-key slot, plus the
  // domain's active-provider pointer. A whole-domain uninstall clears the pointer
  // outright; a single-provider uninstall clears it only if it named this one.
  const domain = manifest.domain;
  await setSetting(db, `${domain}_key_${manifest.id}`, null);
  if (manifest.kind === "connector-domain" || (await getSetting(db, `${domain}_provider`)) === manifest.id)
    await setSetting(db, `${domain}_provider`, null);
}
