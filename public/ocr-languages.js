// The PDF extractor's OCR languages are Tesseract's codes, which its image
// reports (extractor/main.py: "fra", "chi_sim"). Said by name wherever a person
// reads them: the PDF card's choices (server/sources/pdf.js) and a read's row in
// the Jobs view (jobs-modal.js). planning/pdf-conversion-plan.md, Stage 4.
//
// The runtime names ISO 639 codes itself ("fra" → "French"); Tesseract adds a
// script or a variant after an underscore ("chi_sim" → "Chinese (Simplified)").
// A code it can't name is said as itself.
const NAMES = new Intl.DisplayNames(["en"], { type: "language" });
const PARTS = { sim: "Simplified", tra: "Traditional", latn: "Latin", cyrl: "Cyrillic", latf: "Fraktur", vert: "vertical" };

export function languageName(code) {
  const [base, ...parts] = String(code).split("_");
  let name;
  try { name = NAMES.of(base); } catch { return String(code); }
  if (!name || name === base) return String(code);
  return parts.length ? `${name} (${parts.map((p) => PARTS[p] || p).join(", ")})` : name;
}

// What a language code looks like — three letters, then any script or variant
// parts — the extractor's own rule (main.py LANG_CODE). A stored value that
// isn't one (a hand-edited row) reads as English rather than being sent.
export const isLanguageCode = (v) => typeof v === "string" && /^[a-z]{3}(_[a-z]+)*$/.test(v);
