// Source handlers: whoever brings a file into the app stores it, generates
// its face (thumbnail), and describes it as a payload file entry. The ingest
// route picks a handler per file and stays format-blind. All handlers share
// one storage convention — original in galleryDir/<name>, face in
// thumbsDir/<name>.webp — which is what makes cleanup generic.
//
// One handler per dependency stack (image/sharp, text/dep-free, pdf/poppler,
// docx/mammoth); each module exports a static `manifest` (name, label,
// extensions, kinds) alongside its factory. The manifests are the registry
// the plugin catalog reads — adding a media type is one module + one entry in
// HANDLER_MODULES.
import fs from "node:fs";
import path from "node:path";
import * as image from "./image.js";
import * as text from "./text.js";
import * as pdf from "./pdf.js";
import * as docx from "./docx.js";
import * as audio from "./audio.js";

const HANDLER_MODULES = [image, text, pdf, docx, audio];
export const MANIFESTS = HANDLER_MODULES.map((m) => m.manifest);

export const extOf = (name) => (name?.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();

// Name-level pre-filter for folder feeds: every extension some handler
// declares. Upload has no such gate — unknown extensions fall to the image
// handler, whose sharp sniff rejects non-images.
const KNOWN_EXTS = new Set(MANIFESTS.flatMap((m) => m.extensions));
export const acceptsName = (name) => KNOWN_EXTS.has(extOf(name));

export function createSources({ galleryDir, thumbsDir }) {
  const handlers = {
    image: image.imageSource({ galleryDir, thumbsDir }),
    text: text.textSource({ galleryDir, thumbsDir }),
    pdf: pdf.pdfSource({ galleryDir, thumbsDir }),
    docx: docx.docxSource({ galleryDir, thumbsDir }),
    audio: audio.audioSource({ galleryDir, thumbsDir }),
  };
  const byExt = new Map();
  const byKind = new Map();
  for (const m of MANIFESTS) {
    for (const e of m.extensions) byExt.set(e, m.name);
    for (const k of m.kinds) byKind.set(k, handlers[m.name]);
  }

  return {
    // Picked by extension; everything unmatched goes to the image handler,
    // whose sharp sniff is the real gate (non-images come back null). Media
    // handlers are core capabilities (always present), so there's no
    // disabled-type refusal here.
    forUpload(originalName) {
      return handlers[byExt.get(extOf(originalName)) || "image"];
    },

    // Remove everything a payload's files put on disk.
    cleanup(files) {
      for (const f of files || []) {
        if (!f.name) continue;
        fs.rmSync(path.join(galleryDir, f.name), { force: true });
        fs.rmSync(path.join(galleryDir, f.name + ".txt"), { force: true }); // docx text sidecar (+ legacy audio-transcript files)
        fs.rmSync(path.join(galleryDir, f.name + ".html"), { force: true }); // docx html sidecar
        fs.rmSync(path.join(thumbsDir, f.name + ".webp"), { force: true });
      }
    },

    backfillDims: handlers.image.backfillDims,

    // Re-derive size + kind-specific metadata for a legacy file entry from disk
    // (file-field backfill). Dispatch by kind; very old entries predate `kind`
    // and are images. Returns { size, meta } or null.
    metaFor(entry) {
      if (!entry || !entry.name) return Promise.resolve(null);
      return (byKind.get(entry.kind || "image") || handlers.image).metaFor(entry);
    },

    // Release handler-owned resources (the docx extraction worker pool) on
    // graceful shutdown.
    close: () => Promise.all(Object.values(handlers).map((h) => h.close?.())),
  };
}
