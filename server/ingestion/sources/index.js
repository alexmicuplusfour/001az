// The ingestion-source registry: one module per place files come from (folder,
// ftp, s3, …). Each backend exports a static `manifest` (name/label/description/
// connectionSchema/sourceSchema + capability flags) and a `backend({ source,
// conn })` factory returning list / fetch / test. The shared file adapter
// (../files.js) drives them; the plugin catalog (server/plugins.js) reads the
// manifests as the `source` plugin kind. Adding a source = one module + one
// entry here — no adapter, route, sweep or modal edits. Optional error
// contract: a list() throw for a base path that itself doesn't exist should
// carry `err.notFound = true` (see ./folder.js's header) — untagged throws
// degrade to a plain 400, no browse-modal relink.
//
// NOTE: distinct from server/sources/ (MEDIA handlers that read file bytes).
// These are INGESTION sources that fetch the bytes in the first place.
import * as folder from "./folder.js";
import * as ftp from "./ftp.js";
import * as s3 from "./s3.js";

// Live map — built-ins seeded at load; a `source` plugin registers into it at
// install and out at uninstall. The readers below derive from it at call time, so
// a newly installed source appears without a restart (no frozen snapshot).
const BACKENDS = { folder, ftp, s3 };

// Backend modules / their manifests, read live (folder first — it's core). A
// source module is { manifest, backend } — the same shape a built-in exports.
export const sourceModules = () => Object.values(BACKENDS);
export const sourceManifests = () => sourceModules().map((m) => m.manifest);

// The module (with .manifest + .backend) for a source type, or null.
export const getSourceBackend = (name) => BACKENDS[name] || null;

// --- dynamic registration (phase 2): a `source` plugin adds/removes a backend ---
// Keyed by the plugin id (which equals its manifest.name), like the built-ins are
// keyed by their name. The loader calls these register-last (after validation).
export function registerSource(name, mod) {
  BACKENDS[name] = mod;
}

export function unregisterSource(name) {
  delete BACKENDS[name];
}
