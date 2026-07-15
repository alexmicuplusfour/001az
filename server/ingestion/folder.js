// Compatibility shim. The folder adapter is now the shared file adapter
// (./files.js) dispatching to the folder backend (./sources/folder.js) — this
// module preserves the historical import surface (enumerate/admit/descriptor/
// resolveJailed) that existing callers and tests use. No logic lives here; a
// file board resolves to ./files.js directly (see ./index.js).
export { resolveJailed } from "./sources/folder.js";
export { descriptor, enumerate, admit } from "./files.js";
