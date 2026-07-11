// Connector registry — domain adapters, one per data domain. Each connector is
// a directory of pure data (manifest + providers + defaultProvider); ./runtime.js
// supplies the shared domain×provider dispatch. Explicit imports, no dynamic
// loading. Adding a domain is one import + one map entry — no runtime edits.
import * as crypto from "./crypto/index.js";
import * as stocks from "./stocks/index.js";
import * as runtime from "./runtime.js";

// Compose a data-only connector module with the runtime dispatch. The returned
// object's method names match what the routes already call
// (search/fetchEntity/testConnection/activeProvider), so server.js is untouched
// by the domain/runtime split — db is threaded through as the first argument.
function bind(name, mod) {
  const conn = { name, providers: mod.providers, defaultProvider: mod.defaultProvider, manifest: mod.manifest, faces: mod.faces };
  return {
    name,
    manifest: mod.manifest,
    search: (db, q) => runtime.search(db, conn, q),
    list: (db, opts) => runtime.list(db, conn, opts),
    fetchEntity: (db, id) => runtime.fetchEntity(db, conn, id),
    testConnection: (db, opts) => runtime.testConnection(db, conn, opts),
    activeProvider: (db) => runtime.activeProvider(db, conn),
    refresh: (db, entity, inst, mapping, now) => runtime.refresh(db, conn, entity, inst, mapping, now),
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

// Manifest listing for the client. `providers` is static (descriptors, no key
// material); the active provider + key state is admin-only, resolved by the
// /api/admin/connectors route. `category` groups siblings in the picker.
export function listConnectors() {
  return Object.values(CONNECTORS).map((c) => ({
    name: c.name,
    label: c.manifest.label,
    category: c.manifest.category || null,
    description: c.manifest.description,
    fields: c.manifest.fields,
    faces: c.manifest.faces || [],
    browse: c.manifest.browse || null,
    template: c.manifest.template,
    providers: c.manifest.providers,
  }));
}
