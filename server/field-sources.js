// The field-source registry (planning/field-sources-plan.md).
//
// A SOURCE is where a mapped value comes from — the one idea the mapping used
// to express four different ways (`identity.from`, `face.from`, `fields[].from`,
// and `kind:"object"` smuggling the detector inside "ai"). Everything that
// varies between sources is declared here, once; consumers iterate this table
// instead of naming sources — the same rule capabilities.js states for
// capabilities, and for the same reason: hand-enumerated switches rot (detect
// was missed by BOTH cleanup loops back when it was a naming convention).
//
// This file is PURE DATA — no imports, so anything may read it (db.js included,
// which may not import modules that import it back). Engine code that IS a
// source's implementation (the extract prompt builder, the detector pass) may
// name its own source id; generic paths (validation, gates, cleanup) iterate.
//
// Fields:
//   scope            where values land: "entity" (entities.fields) or
//                    "instance" (items.payload.fields).
//   catalog          closed vocabulary: "connector" (the domain manifest's
//                    field list) or "media" (server/media). null = the user
//                    invents the key.
//   needsFn          a catalog field binds by `fn`; validation requires it.
//   filesOnly        only valid on boards without a connector input.
//   connectorOnly    only valid on boards WITH a connector input — the value is
//                    pulled from the bound domain, so a files board has nowhere
//                    to get it (the dual of filesOnly; without it the scheduler
//                    would sweep for a connector that isn't there).
//   slots            mapping slots this source may bind BESIDES fields[]
//                    ("identity", "face"). Slot validation reads this list —
//                    a source that doesn't declare a slot is refused there.
//   refreshable      may carry `refresh: { every }` (minutes) — the value can
//                    change under us and a sweep re-pulls it.
//   takesInstruction may carry `instruction` (≤500 chars) — the source needs
//                    telling what to do.
//   kinds            the kinds the USER may pick (extract only). Catalog
//                    sources inherit their kind from the catalog; detect
//                    carries no kind at all (its output is located hits, not a
//                    scalar).
//   cap              per-board ceiling on fields of this source.
//   capability       which CAPABILITY_DEFS entry runs it; null = deterministic
//                    (no model, no key, no provenance band). This is what
//                    makes the mapping pane's provenance generic.
//   appliesTo        media kinds the source can act on (detect: images).
//   output/locator   forward declarations for occurrence sources ("scalar" is
//                    one value; "occurrences" is zero-or-more located hits —
//                    boxes in an image, spans in audio). Future face/voice
//                    matching is one row here + one CAPABILITY_DEFS entry.
export const FIELD_SOURCE_DEFS = [
  {
    id: "connector",
    scope: "entity",
    catalog: "connector", needsFn: true, connectorOnly: true,
    refreshable: true,
    capability: null,
    slots: ["identity", "face"],
    output: "scalar",
  },
  {
    id: "file",
    scope: "instance",
    catalog: "media", needsFn: true, filesOnly: true,
    refreshable: false,
    capability: null,
    slots: ["face"],
    output: "scalar",
  },
  {
    id: "extract",
    scope: "instance",
    catalog: null, takesInstruction: true,
    refreshable: false,
    capability: "extract",
    kinds: ["text", "number", "url", "date"],
    cap: 12, // extract fields generate the record_fields schema — the cap is a schema-size bound
    slots: ["identity"],
    output: "scalar",
  },
  {
    id: "detect",
    scope: "instance",
    catalog: null, takesInstruction: true,
    refreshable: false,
    capability: "detect",
    appliesTo: ["image"],
    cap: 12, // each field adds detector queries; same order of sanity as extract
    output: "occurrences", locator: "box",
  },
];

export const FIELD_SOURCE = Object.fromEntries(FIELD_SOURCE_DEFS.map((s) => [s.id, s]));

// Does this mapping involve a model at all? Gates the stamp at ingest, the
// pending_extract route, the Re-extract affordance, and the extract leg itself
// — four sites that used to hand-copy `identity.from === "ai" || fields.some
// (f.from === "ai")` and would each need to learn about every future inferred
// source. `identity.source === "extract"` is the one slot-level AI binding;
// fields ask their def, so a new capability-backed source is covered by its
// table row alone. (public/utils.js mappingHasAiWork mirrors this — the client
// can't import server modules; keep the two in step.)
export const aiWork = (mapping) =>
  mapping?.identity?.source === "extract" ||
  (Array.isArray(mapping?.fields) &&
    mapping.fields.some((f) => !!FIELD_SOURCE[f.source]?.capability));
