// Connector registry — domain adapters, one per data domain. Each connector is
// a directory of pure data (manifest + providers + defaultProvider); ./runtime.js
// supplies the shared domain×provider dispatch. Explicit imports, no dynamic
// loading. Adding a domain is one import + one map entry — no runtime edits.
import * as crypto from "./crypto/index.js";
import * as stocks from "./stocks/index.js";
import * as runtime from "./runtime.js";

// The provider descriptor list, derived LIVE from a connector's providers map —
// the single source of truth. A dynamically-registered provider (Plugins page /
// an installed plugin) shows up here immediately; nothing keeps a parallel
// manifest snapshot in sync, so the card and the resolver can never drift.
const providerDescriptors = (providers) =>
  Object.entries(providers).map(([name, p]) => ({
    name, label: p.label, description: p.description || "", needsKey: !!p.needsKey,
    // Some data licenses require visible credit (CoinGecko's demo ToS does);
    // a provider declares it and the browse modal renders it for whichever
    // provider actually filled the rows.
    ...(p.attribution ? { attribution: p.attribution } : {}),
  }));

// Compose a data-only connector module with the runtime dispatch. The returned
// object's method names match what the routes already call
// (search/fetchEntity/testConnection/activeProvider), so server.js is untouched
// by the domain/runtime split — db is threaded through as the first argument.
function bind(name, mod) {
  const conn = { name, providers: mod.providers, defaultProvider: mod.defaultProvider, manifest: mod.manifest, faces: mod.faces };
  return {
    name,
    manifest: mod.manifest,
    providers: mod.providers, // raw provider modules (rpm/burst defaults for the plugin registry)
    providerList: () => providerDescriptors(conn.providers), // live descriptors (single source)
    search: (db, q) => runtime.search(db, conn, q),
    list: (db, opts) => runtime.list(db, conn, opts),
    browseFilters: (db) => runtime.browseFilters(db, conn),
    fetchEntity: (db, id) => runtime.fetchEntity(db, conn, id),
    testConnection: (db, opts) => runtime.testConnection(db, conn, opts),
    activeProvider: (db) => runtime.activeProvider(db, conn),
    standing: (db) => runtime.standing(db, conn),
    refresh: (db, entity, inst, mapping, now) => runtime.refresh(db, conn, entity, inst, mapping, now),
    prefetchRefresh: (db, rows) => runtime.prefetchRefresh(db, conn, rows),
    produceFace: (db, entity, source, faceCfg) => runtime.produceFace(db, conn, entity, source, faceCfg),
    // Annotate the declared face producers for a given provider: `available`
    // = that provider can render it (exports the method named by `requires`),
    // `supportedBy` = every provider that can. A producer with no `requires`
    // is always available. Drives the mapping modal's "can't render" hint.
    renderableFaces: (providerName) =>
      (mod.manifest.faces || []).map((f) => ({
        ...f,
        available: !f.requires || !!conn.providers[providerName]?.[f.requires],
        supportedBy: Object.keys(conn.providers).filter((n) => !f.requires || !!conn.providers[n]?.[f.requires]),
      })),
  };
}

const CONNECTORS = {
  crypto: bind("crypto", crypto),
  stocks: bind("stocks", stocks),
};

export function getConnector(name) {
  return CONNECTORS[name] || null;
}

// Batch-warm provider quote caches for a refresh sweep's due rows, grouped by
// connector — the worker calls this once per sweep batch, before the
// per-entity loop, so a whole board's refreshes collapse into one metered
// request per provider (see runtime.prefetchRefresh). Never throws: prefetch
// is an economics move, and a failure only means per-entity retail.
export async function prefetchDueRefreshes(db, rows) {
  const byConn = new Map();
  for (const row of rows) {
    const name = row?.board?.mapping?.input?.connector;
    if (!name || !CONNECTORS[name]) continue;
    if (!byConn.has(name)) byConn.set(name, []);
    byConn.get(name).push(row);
  }
  // Concurrently: the groups are independent by construction — different
  // domains, different providers, separate token buckets — so serialising them
  // only added a provider round-trip to the sweep tick.
  await Promise.all([...byConn].map(([name, group]) =>
    CONNECTORS[name].prefetchRefresh(db, group).catch((e) =>
      console.warn(`${name} refresh prefetch failed (per-entity fallback): ${e.message}`))));
}

// Manifest listing for the client. `providers` is static (descriptors, no key
// material); the active provider + key state is admin-only, resolved by the
// /api/admin/plugins catalog. `category` groups siblings in the picker.
export function listConnectors() {
  return Object.values(CONNECTORS).map((c) => ({
    name: c.name,
    label: c.manifest.label,
    category: c.manifest.category || null,
    description: c.manifest.description,
    fields: c.manifest.fields,
    faces: c.manifest.faces || [],
    // `filters` is deliberately withheld: the manifest's copy is the
    // DECLARATION, and a `from: "provider"` entry carries no options until the
    // filters route resolves it. Shipping both shapes invites a client to read
    // the half-built one — the columns/sorts here are the whole of what this
    // payload can answer for.
    browse: c.manifest.browse ? { ...c.manifest.browse, filters: undefined } : null,
    template: c.manifest.template,
    providers: c.providerList(),
  }));
}

// --- dynamic registration (phase 2) ---
// Adding a domain or a provider is a live mutation of the maps above; because
// listConnectors()/providerList() derive from the live `providers` map, the
// catalog and the resolver update together from a single write. The loader
// (server/plugins/loader.js) calls these AFTER a module is fully built +
// validated, so a half-built plugin never lands here (register-last).

// Register a whole new data domain (a `connector-domain` plugin). `mod` is the
// same pure-data shape a built-in exports: { providers, defaultProvider,
// manifest, faces? }. Idempotent on re-register (a reload replaces the binding).
export function registerConnector(name, mod) {
  CONNECTORS[name] = bind(name, mod);
}

export function unregisterConnector(name) {
  delete CONNECTORS[name];
}

// Add one provider to an existing domain (a `connector-provider` plugin). Writes
// into the domain's LIVE providers map — the same object activeProvider iterates
// and providerList() derives from — so one write reaches both.
export function registerConnectorProvider(domain, name, providerMod) {
  const c = CONNECTORS[domain];
  if (!c) throw new Error(`unknown connector domain: ${domain}`);
  c.providers[name] = providerMod;
}

export function unregisterConnectorProvider(domain, name) {
  const c = CONNECTORS[domain];
  if (c) delete c.providers[name];
}
