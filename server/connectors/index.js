// Connector registry — domain adapters, one per data domain. Each connector is
// a directory of pure data (manifest + providers + defaultProvider); ./runtime.js
// supplies the shared domain×provider dispatch. Explicit imports, no dynamic
// loading. Adding a domain is one import + one map entry — no runtime edits.
import * as crypto from "./crypto/index.js";
import * as runtime from "./runtime.js";

// Compose a data-only connector module with the runtime dispatch. The returned
// object's method names match what the routes already call
// (search/fetchEntity/testConnection/activeProvider), so server.js is untouched
// by the domain/runtime split — db is threaded through as the first argument.
function bind(name, mod) {
  const conn = { name, providers: mod.providers, defaultProvider: mod.defaultProvider, manifest: mod.manifest };
  return {
    name,
    manifest: mod.manifest,
    search: (db, q) => runtime.search(db, conn, q),
    fetchEntity: (db, id) => runtime.fetchEntity(db, conn, id),
    testConnection: (db, opts) => runtime.testConnection(db, conn, opts),
    activeProvider: (db) => runtime.activeProvider(db, conn),
    refresh: (db, entity, inst, mapping, now) => runtime.refresh(db, conn, entity, inst, mapping, now),
  };
}

const CONNECTORS = { crypto: bind("crypto", crypto) };

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
    template: c.manifest.template,
    providers: c.manifest.providers,
  }));
}
