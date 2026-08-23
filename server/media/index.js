// Media registry — the file-metadata counterpart to server/connectors/. Each
// module is pure data (a field catalog scoped to a media kind) plus a pure
// extractor; this index composes them and supplies the shared projection.
//
// The model is capture-once, project-many: the ingest path stamps a file's raw
// metadata onto its stored payload entry (size, meta bag, date timestamps), and
// a field's *value* is a pure function of that entry. So the same projection
// runs at ingest, in the AI extract leg, and during a mapping-change backfill —
// no file is ever re-opened. Adding a field = one descriptor in a module;
// adding a whole media type = one module + one line here.
import * as universal from "./universal.js";
import * as image from "./image.js";
import * as document from "./document.js";
import * as audio from "./audio.js";

// Universal always applies; the kind modules are matched per entry by appliesTo.
const KIND_MODULES = [image, document, audio];
const ALL_MODULES = [universal, ...KIND_MODULES];

const kindMatches = (appliesTo, kind) =>
  appliesTo === "*" || appliesTo === kind || (Array.isArray(appliesTo) && appliesTo.includes(kind));

// Flat catalog for the mapping modal + validation: one descriptor per field,
// carrying its group + applicability so the client can section and label them.
export function mediaCatalog() {
  return ALL_MODULES.flatMap((m) =>
    m.fields.map((f) => ({
      key: f.key,
      fn: f.fn,
      kind: f.kind,
      label: f.label,
      group: m.group,
      appliesTo: m.appliesTo,
      ...(f.note ? { note: f.note } : {}),
    }))
  );
}

// Descriptor lookup by fn — for validateMapping (kind check + existence).
const BY_FN = new Map(mediaCatalog().map((d) => [d.fn, d]));
export const getMediaField = (fn) => BY_FN.get(fn) || null;

// Build the extractor ctx from a stored file entry alone, so the projection is
// self-contained (recomputable anywhere the entry is on hand).
function ctxFromEntry(entry) {
  const originalName = entry?.original_name || entry?.name || "";
  const ext = (originalName.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  return {
    entry,
    size: entry?.size ?? null,
    ext,
    // Very old entries predate the `kind` field; the app treats those as images.
    kind: entry?.kind || "image",
    originalName,
    addedAt: entry?.addedAt ?? null,
    modifiedAt: entry?.modifiedAt ?? null,
    createdAt: entry?.createdAt ?? null,
    meta: entry?.meta || {},
  };
}

// Full projection of one stored file entry: universal + every applicable kind
// module, flat { fn: value }. The list payload's sort bag and extractFileFields
// both read from here — one place decides what a file's metadata says.
export function projectEntry(entry) {
  const ctx = ctxFromEntry(entry);
  const values = { ...universal.extract(ctx) };
  for (const m of KIND_MODULES) {
    if (kindMatches(m.appliesTo, ctx.kind)) Object.assign(values, m.extract(ctx));
  }
  return values;
}

// Project the mapping's file fields onto a file entry. `mappingFields` is a
// mapping's `fields` array (source:"file" entries are selected here). Returns
// { key: { v, src:"file", kind } }; a field whose catalog kind doesn't apply to
// this entry's kind yields v:null — the field still shows, just empty.
export function extractFileFields(entry, mappingFields = []) {
  const requested = (mappingFields || []).filter((f) => f.source === "file");
  if (!requested.length) return {};
  const ctx = ctxFromEntry(entry);
  const values = projectEntry(entry);
  const out = {};
  for (const f of requested) {
    const desc = BY_FN.get(f.fn);
    const applies = desc && kindMatches(desc.appliesTo, ctx.kind);
    out[f.key] = { v: applies ? (values[f.fn] ?? null) : null, src: "file", kind: f.kind || desc?.kind || "text" };
  }
  return out;
}
