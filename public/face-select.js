// MIRROR of server/faces/select.js — which instance backs an entity's card
// face, per the board's mapping.face { prefer, pick }. Kept byte-identical to
// the server so the client re-derives the same face the listing computed
// (build-less frontend, no shared import); change both together —
// test/faces.test.js asserts parity. Consumers: lightbox.js (face re-pick
// after an instance removal), rows.js (the face marker on instance tiles).
export const FACE_FAMILY = { image: "image", pdf: "document", docx: "document", text: "document", audio: "audio" };

// instances are pre-ordered oldest→newest (created_at ASC).
export function selectFace(instances, faceCfg) {
  if (!instances || !instances.length) return null;
  const isFile = faceCfg?.from === "file";
  const prefer = isFile ? faceCfg.prefer || "any" : "any";
  const pick = isFile ? faceCfg.pick || "first" : "first";
  let pool = instances;
  if (prefer !== "any") {
    const matched = instances.filter((i) => FACE_FAMILY[i.kind] === prefer);
    if (matched.length) pool = matched; // a preference, not a filter — else keep all
  }
  return pick === "latest" ? pool[pool.length - 1] : pool[0];
}
