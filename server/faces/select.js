// Which instance of an entity supplies its card face. A derived-identity board
// bundles several instances under one entity (possibly of different kinds — a
// board is kind-blind); this picks one per the board's `mapping.face`
// { prefer, pick }. Absent config (a null face slot), or a connector face,
// falls through to the first (oldest) instance — the slot's default lives
// here, with the renderer, not as a pseudo-source in the mapping.
//
// Pure + deterministic: same instances + same faceCfg → same face, so the board
// listing re-running on every poll/delta never changes the chosen card.
//
// MIRROR: public/face-select.js carries a byte-identical copy (build-less
// frontend, no shared import). Change both together — test/faces.test.js
// asserts parity.

// The three "prefer" families group the granular file kinds into the face shapes
// (thumbnail / page-or-peek / waveform) users actually choose between.
export const FACE_FAMILY = { image: "image", pdf: "document", docx: "document", text: "document", audio: "audio" };

// instances are pre-ordered oldest→newest (created_at ASC).
export function selectFace(instances, faceCfg) {
  if (!instances || !instances.length) return null;
  const isFile = faceCfg?.source === "file";
  const prefer = isFile ? faceCfg.prefer || "any" : "any";
  const pick = isFile ? faceCfg.pick || "first" : "first";
  let pool = instances;
  if (prefer !== "any") {
    const matched = instances.filter((i) => FACE_FAMILY[i.kind] === prefer);
    if (matched.length) pool = matched; // a preference, not a filter — else keep all
  }
  return pick === "latest" ? pool[pool.length - 1] : pool[0];
}
