// The ingestion-source registry: one module per place files come from (folder,
// ftp, s3, …). Each backend exports a static `manifest` (name/label/description/
// connectionSchema/sourceSchema + capability flags) and a `backend({ source,
// conn })` factory returning list / fetch / test. The shared file adapter
// (../files.js) drives them; the plugin catalog (server/plugins.js) reads the
// manifests as the `source` plugin kind. Adding a source = one module + one
// entry here — no adapter, route, sweep or modal edits.
//
// NOTE: distinct from server/sources/ (MEDIA handlers that read file bytes).
// These are INGESTION sources that fetch the bytes in the first place.
import * as folder from "./folder.js";
import * as ftp from "./ftp.js";
import * as s3 from "./s3.js";

const BACKENDS = { folder, ftp, s3 };

// Backend modules, in registry order (folder first — it's core).
export const SOURCE_MODULES = Object.values(BACKENDS);
export const MANIFESTS = SOURCE_MODULES.map((m) => m.manifest);

// The module (with .manifest + .backend) for a source type, or null.
export const getSourceBackend = (name) => BACKENDS[name] || null;
