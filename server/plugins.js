// The plugin registry — one composed catalog over the three integration
// layers (AI providers, connector providers, media source handlers). Phase 1
// wraps the existing registries (providers.js PROVIDERS, connectors/,
// sources/ manifests) into a uniform shape; nothing here loads code — the
// catalog entry format IS the future dropped-in-module manifest (phase 2).
//
// Plugin id = "<segment>:<name>" — the segment is the id namespace (and, for a
// connector, its domain); the page itself is a flat list, tagged per card:
//   ai:openai …        (kind "ai")
//   crypto:coingecko … (kind "connector", segment = the domain)
//   media:pdf …        (kind "media")
//
// State model: installed = a card on the page, usable (vs available = add it
// first); slot default = preselected. A plugin's DB row (plugins table) is
// optional — an absent/NULL-installed row falls to the plugin's tier default
// (built-ins + the pre-added flagship = installed, everything else =
// available). `configSchema` declares the modal's fields; `plugins.config`
// stores only those overrides. Secrets never land there: a connector's api_key
// field writes through to the existing `<domain>_key_<provider>` setting, and
// AI keys stay in the ai_keys table.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, providerCatalog } from "./providers.js";
import { CAPABILITY_IDS } from "./capabilities.js";
// A deliberate module cycle: plugin-loader.js imports resetDefs() and
// pluginDefs() from here.
// Both directions are CALLS, never module-eval reads of each other's bindings,
// and both bindings are hoisted function declarations — so whichever module
// loads first, the other's namespace is complete by the time anything runs.
// The alternative was a second copy of the manifest → catalog-id rule, which is
// the one thing catalogIdFor exists to prevent.
import { catalogIdFor, manifestIn } from "./plugin-loader.js";
import { resolveSource } from "./plugin-fetch.js";
import { getConnector, listConnectors } from "./connectors/index.js";
import { MANIFESTS as MEDIA_MANIFESTS, extOf } from "./sources/index.js";
import { sourceManifests } from "./ingestion/sources/index.js";
import { listPluginRows, getPluginRow, getSetting, listAiKeys, listSourceConnections, listExternalPlugins } from "./db.js";
import { UPLOAD_HARD_CEILING } from "./upload-limits.js";

// --- static defs (no db) ---

function aiDefs() {
  return providerCatalog().map((p) => ({
    id: `ai:${p.name}`,
    kind: "ai",
    segment: "ai",
    name: p.name,
    label: p.label,
    description: p.description || "",
    // The on-device embedder (local/Xenova) and the on-device transcriber
    // (whisper sidecar) are always-on built-ins — no account, always installed.
    core: p.name === "local" || p.name === "whisper" || p.name === "localDetector",
    // NOTHING is pre-added (welcome-plan.md 4.4). The welcome screen is the
    // chooser, so a vendor card on a fresh instance would be a choice the app
    // made on someone's behalf. The old default was anthropic, justified as
    // "tagging must work out of the box" — which it never did, because the row
    // it pre-added has no key in it.
    //
    // The exception is not an opinion about vendors, it is reading the
    // operator's: ANTHROPIC_API_KEY is a documented path (.env.example) and
    // tag's env rung is install-gated like every other rung
    // (capability-resolve.js, disqualified), so leaving it uninstalled would
    // mean a key in the compose file that silently does nothing — explained by
    // a Capabilities tab reporting that they removed a plugin they never saw.
    // An explicit `installed: false` still wins, because installedFor checks
    // the row before it gets here; that is what keeps the off-switch.
    //
    // Read once per DEFS build — once per process in production, since env is
    // fixed at boot. A test that MOVES the var must resetDefs() after it.
    defaultInstalled: p.name === "anthropic" && !!process.env.ANTHROPIC_API_KEY,
    // Derived from the descriptor's `provides` normal form over the capability
    // id list — NOT over the provider's own keys, since the card wants an
    // explicit false for what it can't do. Adding a capability adds a key here
    // with no edit to this file.
    capabilities: Object.fromEntries(CAPABILITY_IDS.map((c) => [c, !!p.provides?.[c]])),
    // Rate-limit config, mirroring connectors — networked providers only
    // (on-device local/whisper make no external calls; a keyless-networked
    // provider still paces). Defaults are the descriptor's grounded limits; an
    // admin override for their account tier lands in plugins.config and the
    // pacing bucket picks it up (worker aiRate → paceAi).
    configSchema: PROVIDERS[p.name].onDevice ? [] : [
      { key: "rpm", label: "Requests / minute", type: "number", default: PROVIDERS[p.name].rpm, min: 1, help: "token-bucket pace per API key" },
      { key: "burst", label: "Burst", type: "number", default: PROVIDERS[p.name].burst, min: 1, help: "calls allowed before pacing kicks in" },
    ],
    // the modal's pickers (models + notes, per-capability catalogs via
    // `provides`) — same data the board modal reads from /api/admin/ai-providers
    ai: {
      defaultModel: p.defaultModel, models: p.models,
      provides: p.provides, // the one capability shape on the wire (7b)
      keyless: p.keyless, onDevice: p.onDevice,
      needsBase: !!p.needsBase, base: p.needsBase ? p.base || null : null,
    },
  }));
}

function connectorDefs() {
  return listConnectors().flatMap((c) => {
    const conn = getConnector(c.name);
    return c.providers.map((p) => {
      const raw = conn.providers[p.name] || {};
      return {
        id: `${c.name}:${p.name}`,
        kind: "connector",
        segment: c.name,
        name: p.name,
        label: p.label,
        description: p.description || "",
        core: false,
        capabilities: {
          search: !!raw.search,
          list: !!raw.list,
          history: !!raw.history,
          test: !!raw.testConnection,
        },
        configSchema: [
          {
            key: "api_key", label: "API key", type: "secret", required: !!p.needsKey,
            help: p.needsKey ? `${p.label} needs an API key` : "optional — raises rate limits",
          },
          { key: "rpm", label: "Requests / minute", type: "number", default: raw.rpm ?? 30, min: 1, help: "token-bucket pace for calls to this provider" },
          { key: "burst", label: "Burst", type: "number", default: raw.burst ?? 15, min: 1, help: "calls allowed before pacing kicks in" },
        ],
        connector: { domain: c.name, domainLabel: c.label, needsKey: !!p.needsKey },
      };
    });
  });
}

function mediaDefs() {
  return MEDIA_MANIFESTS.map((m) => ({
    id: `media:${m.name}`,
    kind: "media",
    segment: "media",
    name: m.name,
    label: m.label,
    description: m.description || "",
    // Media handlers are capabilities the app has, not connections you opt into
    // — all core (always installed, not removable). "Don't want .docx? just
    // don't upload one." poppler/mammoth already degrade gracefully when absent.
    core: true,
    // maxBytes is the manifest default; the effective per-type limit (default ⊕
    // admin override) is composed by mediaLimits() below. ceilingBytes rides
    // along so the admin modal can show the cap an over-large override clamps to.
    capabilities: { extensions: m.extensions, kinds: m.kinds, maxBytes: m.maxBytes, ceilingBytes: UPLOAD_HARD_CEILING },
    // The one adjustable knob: the per-type upload limit, stored in bytes (the
    // admin modal shows MB). No `default` here — an absent override falls to the
    // manifest maxBytes in mediaLimits(), so the manifest stays the single default.
    configSchema: [{ key: "maxBytes", label: "Max upload size", type: "number", min: 1 }],
  }));
}

function sourceDefs() {
  return sourceManifests().map((m) => ({
    id: `source:${m.name}`,
    kind: "source",
    segment: "source",
    name: m.name,
    label: m.label,
    description: m.description || "",
    // The local folder is a capability (always installed, uses INGEST_ROOT);
    // ftp/s3 are connections you Add. A source has no global plugins.config —
    // its state is the saved connections (source_connections). The
    // connectionSchema drives the connection-add form in the gear modal.
    core: !!m.core,
    defaultInstalled: false,
    capabilities: { browsable: !!m.browsable, needsConnection: !!m.needsConnection },
    connectionSchema: m.connectionSchema || [],
    configSchema: [],
    source: { needsConnection: !!m.needsConnection, browsable: !!m.browsable },
  }));
}

// Memoized across reads, but NO LONGER "built once": a dynamically-loaded plugin
// mutates the live registries (PROVIDERS / CONNECTORS), so the loader calls
// resetDefs() after every register/unregister to force a lazy rebuild. Because
// aiDefs()/connectorDefs() derive from those live maps, a registered external
// plugin appears here with no special-casing — the single-source payoff.
let DEFS = null;
export function pluginDefs() {
  if (!DEFS) DEFS = [...aiDefs(), ...connectorDefs(), ...mediaDefs(), ...sourceDefs()];
  return DEFS;
}

// Drop the memo after the live registries change (plugin install/uninstall).
export function resetDefs() { DEFS = null; }

export const getPluginDef = (id) => pluginDefs().find((d) => d.id === id) || null;

// --- state (db) ---

const configDefaults = (def) =>
  Object.fromEntries(def.configSchema.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));

// Whether a plugin is installed (a card on the page, usable) vs available (add
// it first). Built-ins are always installed; an explicit add/remove row
// wins; otherwise the per-tier default (the flagship AI provider is pre-added,
// everything else is available). A NULL `installed` means no explicit choice —
// a row that exists only for health telemetry must fall to the default, NOT
// read as installed. Pure (def + row) so callers with a row in hand reuse it.
export function installedFor(def, row) {
  if (def.core) return true;
  if (row && row.installed != null) return row.installed;
  return def.defaultInstalled ?? false;
}

// Convenience: install state for one plugin id (reads its row). Used by the
// AI-resolution and slot-star gates.
export async function pluginInstalled(db, id) {
  const def = getPluginDef(id);
  return def ? installedFor(def, await getPluginRow(db, id)) : false;
}

// The effective { installed, config } for one plugin — install state per the
// tier rule, config = schema defaults overlaid with stored overrides.
export async function pluginState(db, id) {
  const def = getPluginDef(id);
  if (!def) return null;
  const row = await getPluginRow(db, id);
  return {
    installed: installedFor(def, row),
    config: { ...configDefaults(def), ...(row?.config || {}) },
  };
}

// A stored per-type size override (Plugins page → media card gear, Slice 3),
// read straight off the plugin row's config. Only a positive finite number
// counts; anything else falls through to the manifest default.
const overrideMaxBytes = (row) => {
  const v = Number(row?.config?.maxBytes);
  return Number.isFinite(v) && v > 0 ? v : null;
};

// The effective per-media-type upload limits — the SINGLE source read by both
// the ingest gate (admitFile, via mediaLimitLookup) and GET /api/media-types
// (the client's accept + size pre-filter). Manifest default ⊕ admin override.
// One listPluginRows read; callers resolve once per request/sweep, not per file.
export async function mediaLimits(db) {
  const rows = new Map((await listPluginRows(db)).map((r) => [r.id, r]));
  return pluginDefs()
    .filter((d) => d.kind === "media")
    .map((d) => ({
      name: d.name,
      label: d.label,
      extensions: d.capabilities.extensions,
      kinds: d.capabilities.kinds,
      // Clamp to the absolute ceiling so the client is never offered a size multer
      // would 413 (an over-large admin override caps here, not at an upload error).
      maxBytes: Math.min(overrideMaxBytes(rows.get(d.id)) ?? d.capabilities.maxBytes, UPLOAD_HARD_CEILING),
    }));
}

// A per-file limit resolver built from mediaLimits(): originalName → effective
// maxBytes for its type. Unknown extensions fall to the image limit, mirroring
// the ingest dispatcher's image fallback (sources/index.js forUpload). Returns
// null only if there are no media types at all (→ admitFile skips the gate).
export async function mediaLimitLookup(db) {
  const limits = await mediaLimits(db);
  const byExt = new Map();
  for (const l of limits) for (const e of l.extensions) byExt.set(e, l.maxBytes);
  const fallback = limits.find((l) => l.name === "image")?.maxBytes ?? null;
  return (originalName) => byExt.get(extOf(originalName)) ?? fallback;
}

const health = (row) =>
  row && (row.last_ok_at || row.last_fail_at)
    ? { failCount: row.fail_count, lastOkAt: row.last_ok_at, lastFailAt: row.last_fail_at, lastError: row.last_error }
    : null;

// external_plugins.kind (the manifest kind) → catalog kind (the card's family).
const CATALOG_KIND = { "ai-provider": "ai", "connector-provider": "connector", "connector-domain": "connector", "source": "source" };

// A catalog row built from a MANIFEST ALONE — no live descriptor behind it.
// Three rows are in that position and they are the same shape for the same
// reason: a plugin whose factory failed to run, and one whose factory has not
// been asked to — a bundled example, or a community listing (plugin-index.js,
// which imports this for it). Everything a descriptor declares (capabilities,
// config fields, the ai/connector blocks) is therefore absent, and every
// reader of these rows has to survive the absence — which is why they are
// empty rather than missing.
export const manifestEntry = (id, m, extra) => ({
  id,
  kind: CATALOG_KIND[m.kind] || "connector",
  segment: id.split(":")[0],
  name: m.id || id,
  label: m.label || id,
  description: m.description || "",
  core: false,
  capabilities: {},
  configSchema: [],
  ...extra,
});

// An external plugin's provenance, as its card prints it: where it was
// installed from, the ref that actually ran, and the version its manifest
// names. The version is the author's label, shown as written and never
// compared — nothing here orders versions. `bundled` says the source is one of
// the image's own examples, which an installed row no longer says otherwise:
// its Update runs without the install confirm, and the operator's lock leaves
// it open.
const sourceOf = (ext) => ({
  url: ext.source_url, ref: ext.resolved_ref, version: ext.manifest?.version ?? null,
  bundled: isBundledSource(ext.source_url),
});

// An external plugin that FAILED to load never reaches the live registries, so
// pluginDefs() can't see it — but it's installed (code on disk) and must show as
// an errored card with its reason + a Retry. Built from the stored manifest +
// the recorded load_error (health row, if any, carries prior runtime failures).
const erroredExternalEntry = (ext, row) =>
  manifestEntry(ext.id, ext.manifest || {}, {
    external: true,
    source: sourceOf(ext),
    state: { installed: true, config: {}, loadError: ext.load_error || { message: "failed to load", at: null }, health: health(row) },
  });

// --- bundled examples (planning/welcome-plan.md Stage 2b) ---

// Where the image's own example plugins live. Resolved off THIS FILE rather
// than the working directory: installFromUrl resolves a bare path against cwd
// (plugin-fetch resolveSource), which is the right rule for an admin typing one
// into the URL box and the wrong one for a scan that has to find the same
// directory however node was started.
const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "plugins");

// Whether an install source is one of those examples: a local path under
// BUNDLED_DIR, however it was spelled (relative, or through `..`). The one
// source the Add modal installs without its confirm — the image's own code,
// with no dependencies to fetch — and so the one the operator's lock
// (PLUGIN_INSTALL_DISABLE) leaves open, like the built-ins.
export function isBundledSource(url) {
  let source;
  try { source = resolveSource(url); } catch { return false; }
  return source.kind === "file" && source.dir.startsWith(BUNDLED_DIR + path.sep);
}

// Catalog rows for every bundled plugin this instance has NOT installed.
//
// The gap this closes is DISCOVERY, not capability: examples/plugins/* ships in
// the image and installs with no network at all, but nothing lists it, so the
// only way to find one is to read a README in the source tree — which makes a
// bundled example strictly harder to install than a random GitHub repo.
//
// Deliberately NOT part of pluginDefs(). That array is what getPluginDef
// searches, and it is how PATCH /api/admin/plugins/:id and .../test find their
// target; a bundled row in there would make `PATCH { installed: true }` answer
// 200 and record installed:true for code that has never been loaded. Nothing
// would crash — resolution reports the provider as not installed, since
// PROVIDERS has no such entry — but the page would show an installed card for
// a provider that cannot serve. The install verb is not a toggle and must not
// be reachable through the toggle's route, so these rows are a READ, composed
// into the payload beside the catalog and never into the def list.
//
// `bundled.path` is what POST /api/admin/plugins/install takes. Absolute, for
// the same reason BUNDLED_DIR is: the install runs in the same process but its
// path rule is cwd-relative, and an absolute one needs no agreement about where
// that is.
export async function bundledPlugins(db) {
  const examples = bundledManifests();
  if (!examples.length) return [];
  const onDisk = new Set((await listExternalPlugins(db)).map((r) => r.id));
  const out = [];
  for (const { dir, manifest } of examples) {
    const id = catalogIdFor(manifest);
    // Installed already (healthy or errored) — the real catalog owns the row,
    // and offering "Add" for something on disk would 409 at the install route.
    if (onDisk.has(id)) continue;
    // The hints live on `bundled`, deliberately NOT on an `ai` block. `ai` means
    // "this is what the descriptor says", and half of one would read as a
    // descriptor that declares `keyless: false` rather than as a row whose
    // descriptor has never run — which is the difference between "bring a key"
    // and "we don't know yet". `bundled` is already the block that means
    // "true of a row that isn't installed", and it disappears when it is.
    out.push(manifestEntry(id, manifest, {
      bundled: { path: dir, keyless: !!manifest.keyless, needsBase: !!manifest.needsBase },
      state: { installed: false, config: {}, health: null },
    }));
  }
  return out;
}

// Every bundled example, as { dir, manifest } — the one scan of the image's
// examples, shared by bundledPlugins and the community index's reviewer, which
// keeps their ids out of the index (community-index-plan.md, D11). One
// malformed example must not take the Plugins page with it — skipped and
// logged, the same isolation loadAll() gives a plugin that won't load.
export function bundledManifests() {
  let entries;
  try { entries = fs.readdirSync(BUNDLED_DIR, { withFileTypes: true }); }
  catch { return []; } // no examples/ in this deployment — nothing is bundled
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(BUNDLED_DIR, e.name);
    try { out.push({ dir, manifest: manifestIn(dir) }); }
    catch (err) { console.log(`bundled plugin ${e.name}: not listable — ${err.message}`); }
  }
  return out;
}

// The full admin catalog: every def + its state, secrets masked. Connector
// key presence comes from the settings store; AI key counts from ai_keys.
export async function pluginCatalog(db) {
  const rows = new Map((await listPluginRows(db)).map((r) => [r.id, r]));
  const externals = new Map((await listExternalPlugins(db)).map((r) => [r.id, r]));
  const aiKeys = await listAiKeys(db);
  const connections = await listSourceConnections(db);
  const out = [];
  for (const def of pluginDefs()) {
    const row = rows.get(def.id);
    const entry = {
      ...def,
      state: {
        installed: installedFor(def, row),
        config: { ...configDefaults(def), ...(row?.config || {}) },
        health: health(row),
      },
    };
    delete entry.state.config.api_key; // never echo secrets, even by accident
    // A successfully-loaded external plugin: mark it + carry its provenance so the
    // page can show source/version + a real Remove (uninstall), not just a toggle.
    const ext = externals.get(def.id);
    if (ext) {
      entry.external = true;
      entry.source = sourceOf(ext);
      entry.state.installed = true; // installed-from-URL: present ⇒ installed (Remove = uninstall)
      // Never core: an installed-from-URL plugin is always removable, even if its
      // manifest claims core (which would otherwise disable Remove in the admin UI).
      entry.core = false;
      // A connector-domain plugin brings its domain, and its Remove takes the
      // domain with it — which the confirm has to say (plugin-contract-plan.md,
      // Stage 5 second pass). A copy: `connector` is the memoized def's own.
      if (ext.manifest?.kind === "connector-domain") entry.connector = { ...entry.connector, addsDomain: true };
      externals.delete(def.id); // consumed — the rest are errored (below)
    }
    if (def.kind === "connector") {
      entry.state.hasKey = !!(await getSetting(db, `${def.connector.domain}_key_${def.name}`));
    }
    if (def.kind === "ai") {
      entry.state.keyCount = aiKeys.filter((k) => k.provider === def.name).length;
    }
    if (def.kind === "source" && def.capabilities.needsConnection) {
      entry.state.connectionCount = connections.filter((c) => c.type === def.name).length;
    }
    out.push(entry);
  }
  // Externals still in the map failed to register → surface them as errored cards.
  for (const ext of externals.values()) out.push(erroredExternalEntry(ext, rows.get(ext.id)));
  return out;
}
