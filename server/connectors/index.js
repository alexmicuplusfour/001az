// Connector registry — domain adapters, one per data domain. Each is a
// directory (its provider backends live beside its index.js). Explicit
// imports, no dynamic loading. Adding a domain is one import + one map entry.
import * as crypto from "./crypto/index.js";

const CONNECTORS = { crypto };

export function getConnector(name) {
  return CONNECTORS[name] || null;
}

// Manifest listing for the client. `providers` is static (descriptors, no
// key material); the active provider + key state is admin-only, resolved by
// the /api/admin/connectors route. `category` groups siblings in the picker.
export function listConnectors() {
  return Object.entries(CONNECTORS).map(([name, c]) => ({
    name,
    label: c.manifest.label,
    category: c.manifest.category || null,
    description: c.manifest.description,
    fields: c.manifest.fields,
    template: c.manifest.template,
    providers: c.manifest.providers,
  }));
}
