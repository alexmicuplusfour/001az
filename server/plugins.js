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
// (core capabilities + the pre-added flagship = installed, everything else =
// available). `configSchema` declares the modal's fields; `plugins.config`
// stores only those overrides. Secrets never land there: a connector's api_key
// field writes through to the existing `<domain>_key_<provider>` setting, and
// AI keys stay in the ai_keys table.
import { PROVIDERS, providerCatalog } from "./providers.js";
import { getConnector, listConnectors } from "./connectors/index.js";
import { MANIFESTS as MEDIA_MANIFESTS } from "./sources/index.js";
import { MANIFESTS as SOURCE_MANIFESTS } from "./ingestion/sources/index.js";
import { listPluginRows, getPluginRow, getSetting, listAiKeys, listSourceConnections } from "./db.js";

// --- static defs (no db) ---

function aiDefs() {
  return providerCatalog().map((p) => ({
    id: `ai:${p.name}`,
    kind: "ai",
    segment: "ai",
    name: p.name,
    label: p.label,
    description: p.description || "",
    // The on-device embedder (local/Xenova) is a core capability — no account,
    // always installed. Anthropic is the one connection pre-added, since tagging
    // (the product's core value) must work out of the box; it's still removable.
    core: p.name === "local",
    defaultInstalled: p.name === "anthropic",
    capabilities: { tag: !!PROVIDERS[p.name].wire, embed: !!p.embeds, research: p.research },
    configSchema: [],
    // the modal's pickers (models + notes, embed catalog) — same data the
    // board modal reads from /api/admin/ai-providers
    ai: { defaultModel: p.defaultModel, models: p.models, embeds: p.embeds, keyless: p.keyless },
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
    capabilities: { extensions: m.extensions, kinds: m.kinds },
    configSchema: [],
  }));
}

function sourceDefs() {
  return SOURCE_MANIFESTS.map((m) => ({
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

let DEFS = null; // built once — the sub-registries are static
export function pluginDefs() {
  if (!DEFS) DEFS = [...aiDefs(), ...connectorDefs(), ...mediaDefs(), ...sourceDefs()];
  return DEFS;
}

export const getPluginDef = (id) => pluginDefs().find((d) => d.id === id) || null;

// --- state (db) ---

const configDefaults = (def) =>
  Object.fromEntries(def.configSchema.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));

// Whether a plugin is installed (a card on the page, usable) vs available (add
// it first). Core capabilities are always installed; an explicit add/remove row
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

const health = (row) =>
  row && (row.last_ok_at || row.last_fail_at)
    ? { failCount: row.fail_count, lastOkAt: row.last_ok_at, lastFailAt: row.last_fail_at, lastError: row.last_error }
    : null;

// The full admin catalog: every def + its state, secrets masked. Connector
// key presence comes from the settings store; AI key counts from ai_keys.
export async function pluginCatalog(db) {
  const rows = new Map((await listPluginRows(db)).map((r) => [r.id, r]));
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
  return out;
}
