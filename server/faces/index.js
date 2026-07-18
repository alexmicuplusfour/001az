// Face producers — the one place "make a card face" lives. Every material type
// (uploaded files, connector entities) shows itself in the grid as the same
// artifact: a { webp, w, h } image stored at thumbsDir/<name>.webp, which the
// client (public/kinds.js) renders generically from the file's name + w/h. The
// OUTPUT and the client are already unified; this module unifies the PRODUCTION
// side, which was otherwise reinvented per handler/connector.
//
// A face producer is `async (input, opts) => ({ webp, w, h }) | null` — input is
// producer-specific (a series, a buffer, a file path), null means "can't render"
// (the caller keeps its fallback: a symbol tile / extension badge). Producers are
// named and looked up here, so a connector references one by NAME (not by an
// imported fn) and a future plugin can register one (phase-2 media/source tier).
//
// The two TRIGGERS stay where they are: file handlers render at ingest, connector
// faces render on the refresh cadence (worker.js generateFace). This module owns
// only the producer registry + the shared write step, not the orchestration.
import fs from "node:fs";
import path from "node:path";
import { renderChart } from "./price-chart.js";
import { imageThumb } from "./image-thumb.js";
import { pdfPage } from "./pdf-page.js";
import { textPeek } from "./text-peek.js";
import { waveform } from "./waveform.js";

// The complete catalogue of face producers. Built-in handlers/connectors import
// their producer directly (below); this map is the named registry the connector
// face slot resolves against (`cfg.producer`) and the seam a dynamically-loaded
// media/source plugin registers into (slice 3).
const FACE_PRODUCERS = {
  "price-chart": renderChart, // connector price-history chart (crypto/stocks)
  "image-thumb": imageThumb,  // uploaded image → oriented ≤600px webp
  "pdf-page": pdfPage,        // pdf page 1 → webp (poppler)
  "text-peek": textPeek,      // text/docx first lines → webp page peek
  "waveform": waveform,       // audio → ffmpeg showwavespic waveform webp
};

// Resolve a producer by name. A falsy/unknown name → null, so callers gate on it
// (an absent producer falls back to the tile/badge, never throws).
export function getFaceProducer(name) {
  return (name && FACE_PRODUCERS[name]) || null;
}

// Live-mutation seams, mirroring registerProvider/registerConnector — a
// dynamically-loaded media/source plugin registers its face producer here
// (register-last; the loader validates the module first). Unused by built-ins.
export function registerFaceProducer(name, fn) {
  FACE_PRODUCERS[name] = fn;
}

export function unregisterFaceProducer(name) {
  delete FACE_PRODUCERS[name];
}

// The one write step for a rendered face. Writes the webp to thumbsDir/<name>.webp
// (the card face) and, for a `generated` face (a connector chart — it is its own
// original, there's no uploaded file), also to galleryDir/<name>. Returns the
// { name, w, h } fragment the caller merges into its file entry.
export async function storeFace({ galleryDir, thumbsDir }, name, rendered, { generated = false } = {}) {
  await fs.promises.writeFile(path.join(thumbsDir, name + ".webp"), rendered.webp);
  if (generated) await fs.promises.writeFile(path.join(galleryDir, name), rendered.webp);
  return { name, w: rendered.w, h: rendered.h };
}
