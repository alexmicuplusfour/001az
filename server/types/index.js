// Board-type registry + the ctx facade — the boundary between core and type
// adapters (see modular-boards-plan.md). Core imports only this file; adapters
// import nothing from core: every capability an adapter has is one its ctx
// hands it, so a type's behavior is knowable from its own module alone.
import { getBoard, insertItem, updateItemPayload, listItemsByType } from "../db.js";
import { requireAuth } from "../auth.js";

const API_VERSION = 1;
// bare ids for built-ins ("image"), vendor.name for community types
const TYPE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/;

export function createRegistry({ db }) {
  const types = new Map();

  function register(adapter) {
    const m = adapter?.manifest;
    if (!m) throw new Error("type adapter has no manifest");
    if (m.apiVersion !== API_VERSION)
      throw new Error(`type "${m.type}": unsupported apiVersion ${m.apiVersion} (host speaks ${API_VERSION})`);
    if (!TYPE_ID.test(m.type || "")) throw new Error(`invalid type id "${m.type}"`);
    if (types.has(m.type)) throw new Error(`type "${m.type}" registered twice`);
    if (typeof adapter.buildModelInput !== "function")
      throw new Error(`type "${m.type}": buildModelInput hook is required`);
    types.set(m.type, adapter);
  }

  const get = (type) => types.get(type) || null;

  function mountAll(app) {
    for (const adapter of types.values()) adapter.mountRoutes?.(app, makeCtx(db, adapter.manifest.type));
  }

  return { register, get, mountAll };
}

// The one door between an adapter and the app. Narrow on purpose: no raw DB
// handle, no core imports. Extend deliberately when a type needs more.
function makeCtx(db, type) {
  return {
    items: {
      // Creates an item, applying core policy the adapter shouldn't know
      // about (uploads to a board with auto-tagging off wait as 'held').
      // Returns { id, status } or null when the board doesn't exist.
      async create(boardId, payload) {
        const board = await getBoard(db, boardId);
        if (!board) return null;
        const status = board.auto_tag ? "pending" : "held";
        const id = await insertItem(db, boardId, payload, status);
        return { id, status };
      },
      async updatePayload(id, patch) {
        await updateItemPayload(db, id, patch);
      },
      // All items on boards of this adapter's type: [{ id, payload }].
      async listAll() {
        return listItemsByType(db, type);
      },
    },
    boards: {
      async get(id) {
        const b = await getBoard(db, id);
        return b ? { id: b.id, name: b.name, type: b.type } : null;
      },
    },
    auth: { requireAuth },
    log: (...args) => console.log(`[${type}]`, ...args),
  };
}
