// The rules a board mapping is held to — one implementation, two readers.
// Every board save runs a mapping through it (server.js buildBoardAdminUpdate:
// the board create and both PATCH routes); the plugin loader runs a
// connector-domain plugin's template and field catalog through it at install
// (plugin-loader.js), so a plugin is refused at install exactly when a board
// save would refuse what it ships, with the same sentence. A template IS a
// mapping: the mapping pane applies one wholesale, and a board saves it
// verbatim.
//
// `connectorFor` is the domain lookup, a parameter for the loader's sake: at
// install the candidate domain is not registered yet (register-last), so the
// loader hands in a lookup that answers with the module being validated.
import { getConnector } from "./connectors/index.js";
import { getMediaField } from "./media/index.js";
import { FIELD_SOURCE, FIELD_SOURCE_DEFS, keysCards, normaliseIdentity } from "./field-sources.js";

// The kinds a scalar field can hold, for the sources that don't narrow it
// further with their own `kinds`. Detect fields carry NO kind — their output is
// located hits, not a scalar (field-sources.js `output`).
const MAPPING_KINDS = ["text", "number", "url", "date"];
// The mapping's top-level keys — anything else is refused (validateMapping).
const MAPPING_KEYS = new Set(["input", "card", "face", "fields"]);

// Shared by fields and the face slot: a `refresh: { every }` cadence in
// minutes. Returns an error string or null.
function validateRefresh(refresh, what) {
  if (!refresh || typeof refresh !== "object" || !Number.isInteger(refresh.every) ||
      refresh.every < 1 || refresh.every > 43200)
    return `${what} needs an integer refresh.every in minutes (1–43200)`;
  return null;
}

// Which sources may bind a slot, for the refusal message — derived from the
// defs so the message can't drift from the rule.
const slotSources = (slot) =>
  FIELD_SOURCE_DEFS.filter((d) => (d.slots || []).includes(slot))
    .map((d) => `"${d.id}"`).join(" or ");

// Returns an error string when mapping is invalid, null when valid. Field AND
// slot rules are read off FIELD_SOURCE_DEFS — which sources a slot takes
// (`slots`), on which board type (`filesOnly`/`connectorOnly`), instruction,
// options and refresh rules — so a new source is validated by its table row,
// not by another branch here. Only a source's own config vocabulary is
// checked by name below (the connector face's producer/period; the file
// face's prefer/pick). The card slot is checked LAST, after the fields, since
// it is a pointer at one of them.
export function validateMapping(mapping, connectorFor = getConnector) {
  // Optional input slot: absent = files. (The literal string "files" died with
  // `from:"raw"` — two spellings of the same absence; migration 0038 normalizes.)
  if (mapping.input !== undefined) {
    if (!mapping.input || typeof mapping.input !== "object" || typeof mapping.input.connector !== "string")
      return `mapping.input must be { connector: name } — omit it for a files board`;
    if (!connectorFor(mapping.input.connector))
      return `unknown connector: "${mapping.input.connector}"`;
  }
  const filesBoard = !mapping.input;

  // A key the mapping doesn't have is refused, not ignored: a client still
  // emitting a slot that moved would otherwise save a mapping missing its
  // replacement and silently change the board (the identity slot, moved to
  // `card` by planning/card-key-plan.md, is the case that taught this — an
  // old pane would have reset every card-key board to one card per file).
  // `identity: null` was that slot's spelling of absence and stays harmless.
  for (const k of Object.keys(mapping)) {
    if (MAPPING_KEYS.has(k) || (k === "identity" && mapping.identity === null)) continue;
    if (k === "identity") return `mapping.identity moved to mapping.card — the card key is one of the fields (planning/card-key-plan.md)`;
    return `unknown mapping key "${k}"`;
  }

  if (!Array.isArray(mapping.fields)) return "mapping.fields must be an array";
  const seen = new Set();
  const perSource = {};
  for (const f of mapping.fields) {
    if (!f.key || typeof f.key !== "string" || !/^[a-z][a-z0-9_]*$/.test(f.key))
      return `invalid field key: ${JSON.stringify(f.key)}`;
    if (seen.has(f.key)) return `duplicate field key: ${f.key}`;
    seen.add(f.key);

    const def = FIELD_SOURCE[f.source];
    if (!def) return `unsupported source "${f.source}" for field "${f.key}"`;
    perSource[def.id] = (perSource[def.id] || 0) + 1;

    // Kind: detect fields carry none (occurrences, not a scalar); everyone
    // else holds one of the scalar kinds, narrowed to the source's own list
    // where it declares one (def.kinds — what a user may pick for extract).
    if (def.output === "occurrences") {
      if (f.kind !== undefined) return `${def.id} field "${f.key}" carries no kind`;
    } else if (!(def.kinds || MAPPING_KINDS).includes(f.kind)) {
      return `invalid kind "${f.kind}" for field "${f.key}"`;
    }

    if (def.needsFn && (!f.fn || typeof f.fn !== "string"))
      return `${def.id} field "${f.key}" requires a fn string`;
    if (def.filesOnly && !filesBoard)
      return `file field "${f.key}" is only valid on a files board`;
    if (def.connectorOnly && filesBoard)
      return `${def.id} field "${f.key}" requires a connector input`;
    // Catalog fields: the fn must name a field the catalog declares, and the
    // kind is the catalog's, not the caller's — ONE rule however many catalogs
    // exist (it was only ever written for media before; a bad connector fn
    // would now be silently dropped by land-time projection, so refuse it at
    // save). connectorOnly above guarantees the input exists and was resolved.
    if (def.catalog) {
      const desc = def.catalog === "media"
        ? getMediaField(f.fn)
        : (connectorFor(mapping.input.connector)?.manifest?.fields || []).find((c) => c.fn === f.fn);
      if (!desc) return `unknown ${def.id} field fn "${f.fn}" for "${f.key}"`;
      if (f.kind !== desc.kind) return `${def.id} field "${f.key}" must have kind "${desc.kind}"`;
    }
    if (f.instruction !== undefined) {
      if (!def.takesInstruction) return `${def.id} field "${f.key}" takes no instruction`;
      if (typeof f.instruction !== "string" || f.instruction.length > 500)
        return `instruction for field "${f.key}" must be a string ≤500 chars`;
    }
    // Match-to-a-list: a declared options list constrains the AI's answer to
    // a closed set and makes the value a zero-or-more selection. Text only —
    // an enum of dates or numbers is not a thing anyone asked for. Config
    // only — never seeds entities, even when the field is the card key.
    if (f.options !== undefined) {
      if (!def.takesOptions) return `${def.id} field "${f.key}" takes no options`;
      if (f.kind !== "text") return `field "${f.key}" needs the text kind to carry options`;
      if (!Array.isArray(f.options)) return `options for field "${f.key}" must be an array`;
      if (f.options.length > 200) return `field "${f.key}" may have at most 200 options`;
      const seenKeys = new Set();
      for (const c of f.options) {
        if (!c || typeof c !== "object" || typeof c.value !== "string" || !c.value.trim())
          return `each option of field "${f.key}" needs a non-empty "value"`;
        if (c.hint !== undefined && (typeof c.hint !== "string" || c.hint.length > 500))
          return `option hint for field "${f.key}" must be a string ≤500 chars`;
        const k = normaliseIdentity(c.value); // same key the landing dedups on
        if (seenKeys.has(k)) return `duplicate option in field "${f.key}": "${c.value}"`;
        seenKeys.add(k);
      }
    }
    if (f.refresh !== undefined) {
      if (!def.refreshable) return `${def.id} field "${f.key}" cannot refresh`;
      const err = validateRefresh(f.refresh, `field "${f.key}"`);
      if (err) return err;
    }
  }
  for (const def of FIELD_SOURCE_DEFS) {
    if (def.cap && (perSource[def.id] || 0) > def.cap)
      return `mapping may have at most ${def.cap} ${def.id} fields`;
  }

  // Card slot: null/absent = one card per file (the default, owned by the
  // renderer). `{ by }` names one of the mapping's extract fields as the key
  // a card is minted per — a pointer, not a binding, so it is checked against
  // the fields above. Refused on a connector board: the connector owns the
  // card there (its identity is derived by the runtime, never mapped).
  if (mapping.card !== undefined && mapping.card !== null) {
    const card = mapping.card;
    if (typeof card !== "object" || typeof card.by !== "string" || !card.by)
      return "mapping.card must be { by: <field key> } or null";
    if (!filesBoard) return "a connector board's cards are the connector's entries — mapping.card is not allowed with an input";
    const target = mapping.fields.find((f) => f.key === card.by);
    if (!target) return `mapping.card.by names no field: "${card.by}"`;
    if (!keysCards(FIELD_SOURCE[target.source]))
      return `mapping.card.by must name an extract field, not the ${target.source} field "${card.by}"`;
  }

  // Face slot: null/absent = the renderer's default (file preview on a files
  // board, symbol tile on a connector board — see faces/select.js).
  if (mapping.face !== undefined && mapping.face !== null) {
    const fc = mapping.face;
    if (typeof fc !== "object") return "mapping.face must be an object or null";
    const def = FIELD_SOURCE[fc.source];
    if (!def || !(def.slots || []).includes("face"))
      return `mapping.face.source must be ${slotSources("face")} (or the slot null)`;
    if (def.filesOnly && !filesBoard) return "a file face is only valid on a files board";
    if (def.connectorOnly && filesBoard) return "a connector face requires a connector input";
    if (fc.refresh !== undefined) {
      if (!def.refreshable) return `a ${def.id} face has no "refresh"`;
      const err = validateRefresh(fc.refresh, "face");
      if (err) return err;
    }
    // Each source's own config vocabulary:
    if (fc.source === "connector") {
      // connectorOnly above guarantees the input exists and was resolved.
      const conn = connectorFor(mapping.input.connector);
      const producer = (conn.manifest.faces || []).find((p) => p.name === fc.producer);
      if (!producer) return `unknown face producer "${fc.producer}"`;
      if (fc.period !== undefined && !producer.periods?.includes(fc.period))
        return `invalid period "${fc.period}" for face "${fc.producer}"`;
    } else if (fc.source === "file") {
      // Selects which instance backs the card (server/faces/select.js).
      if (fc.prefer !== undefined && !["any", "image", "document", "audio"].includes(fc.prefer))
        return `invalid face prefer "${fc.prefer}"`;
      if (fc.pick !== undefined && !["first", "latest"].includes(fc.pick))
        return `invalid face pick "${fc.pick}"`;
      for (const k of ["producer", "period"])
        if (fc[k] !== undefined) return `a file face has no "${k}"`;
    }
  }
  return null;
}
