// The plugin registry — one composed catalog over the three integration
// layers (AI providers, connector providers, media source handlers). Phase 1
// wraps the existing registries (providers.js PROVIDERS, connectors/,
// sources/ manifests) into a uniform shape; nothing here loads code — the
// catalog entry format IS the future dropped-in-module manifest (phase 2).
//
// Plugin id = "<segment>:<name>" — segments are also the page grouping:
//   ai:openai …        (kind "ai")
//   crypto:coingecko … (kind "connector", segment = the domain)
//   media:pdf …        (kind "media")
//
// State model: enabled = usable, slot default = preselected. A plugin's DB
// row (plugins table) is optional — absent means enabled with default config.
// `configSchema` declares the modal's fields; `plugins.config` stores only
// those overrides. Secrets never land there: a connector's api_key field
// writes through to the existing `<domain>_key_<provider>` setting, and AI
// keys stay in the ai_keys table.
import { PROVIDERS, providerCatalog } from "./providers.js";
import { getConnector, listConnectors } from "./connectors/index.js";
import { MANIFESTS as MEDIA_MANIFESTS } from "./sources/index.js";
import { listPluginRows, getPluginRow, getSetting, listAiKeys } from "./db.js";

// --- static defs (no db) ---

function aiDefs() {
  return providerCatalog().map((p) => ({
    id: `ai:${p.name}`,
    kind: "ai",
    segment: "ai",
    name: p.name,
    label: p.label,
    core: false,
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
    core: !!m.core,
    capabilities: { extensions: m.extensions, kinds: m.kinds },
    configSchema: [],
  }));
}

let DEFS = null; // built once — the sub-registries are static
export function pluginDefs() {
  if (!DEFS) DEFS = [...aiDefs(), ...connectorDefs(), ...mediaDefs()];
  return DEFS;
}

export const getPluginDef = (id) => pluginDefs().find((d) => d.id === id) || null;

// --- state (db) ---

const configDefaults = (def) =>
  Object.fromEntries(def.configSchema.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));

// The effective { enabled, config } for one plugin — absent row = enabled,
// config = schema defaults overlaid with stored overrides. Core plugins are
// always enabled no matter what the row says (belt over the API guard).
export async function pluginState(db, id) {
  const def = getPluginDef(id);
  if (!def) return null;
  const row = await getPluginRow(db, id);
  return {
    enabled: def.core || (row ? row.enabled : true),
    config: { ...configDefaults(def), ...(row?.config || {}) },
  };
}

const health = (row) =>
  row && (row.last_ok_at || row.last_fail_at)
    ? { failCount: row.fail_count, lastOkAt: row.last_ok_at, lastFailAt: row.last_fail_at, lastError: row.last_error }
    : null;

// The media handlers currently switched off — the ingest door's refusal set.
// Core handlers never appear (they can't be disabled). One 13-row read; the
// upload route resolves it once per request, not per file.
export async function disabledMediaSet(db) {
  const rows = await listPluginRows(db);
  return new Set(
    rows
      .filter((r) => !r.enabled && r.id.startsWith("media:"))
      .map((r) => r.id.slice("media:".length))
      .filter((name) => !getPluginDef(`media:${name}`)?.core)
  );
}

// The full admin catalog: every def + its state, secrets masked. Connector
// key presence comes from the settings store; AI key counts from ai_keys.
export async function pluginCatalog(db) {
  const rows = new Map((await listPluginRows(db)).map((r) => [r.id, r]));
  const aiKeys = await listAiKeys(db);
  const out = [];
  for (const def of pluginDefs()) {
    const row = rows.get(def.id);
    const entry = {
      ...def,
      state: {
        enabled: def.core || (row ? row.enabled : true),
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
    out.push(entry);
  }
  return out;
}
