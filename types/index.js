// Client-side board-type registry (see modular-boards-plan.md). A type owns
// how a card's body renders, what its detail view is, and how items enter.
// Unlike the server registry, client adapters may import the shared UI kit
// (state.js, utils.js, toast.js) — imports point adapter -> core only, so a
// new type still touches zero core files.
const types = new Map();
const API_VERSION = 1;

export function registerType(adapter) {
  const m = adapter?.manifest;
  if (!m || m.apiVersion !== API_VERSION || !m.type) throw new Error("bad type adapter manifest");
  if (typeof adapter.renderCardBody !== "function" || typeof adapter.openDetail !== "function")
    throw new Error(`type "${m.type}": renderCardBody and openDetail hooks are required`);
  types.set(m.type, adapter);
}

// Unknown types fall back to the image adapter so an older client still shows
// something rather than a blank board.
export function getType(id) {
  return types.get(id) || types.get("image");
}
