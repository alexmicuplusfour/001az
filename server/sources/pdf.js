// The PDF source handler. Stores the original in the gallery store; the card
// face is page 1 rendered into the thumbnail store via poppler (pdftoppm +
// sharp), so it rides the exact same path as an image thumbnail. Poppler is a
// system dependency (poppler-utils in the Dockerfile) — no poppler on the box
// and the doc still ingests, just without a preview or page count.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pdfPage, poppler } from "../faces/pdf-page.js";
import { storeFace } from "../faces/index.js";
import { languageName } from "../../public/ocr-languages.js";

export const manifest = {
  name: "pdf",
  label: "PDF documents",
  settingsTitle: "PDF settings", // the card's, over its settings; see sources/image.js
  description: "Reads PDFs as text for the AI, with OCR for scanned pages, and draws the page-1 preview",
  extensions: ["pdf"],
  kinds: ["pdf"],
  maxBytes: 10 * 1024 * 1024, // per-type upload limit (bytes); see sources/image.js
  // The PDF card's own fields, beside Max upload size (plugins.js mediaDefs;
  // planning/pdf-conversion-plan.md, C6). Whether the AI reads a PDF's text or
  // the file itself, where its provider can read one (worker.js pdfRoute,
  // C8). Then how many scanned pages a read sends to OCR: absent reads every
  // one, 0 none (worker.js convertOne). Then the language OCR reads them in:
  // its choices are what the extractor's image has (its /health `langs`, by
  // name), as the sidecar watch last heard them (plugins.js fieldChoices).
  config: [{
    key: "convert", label: "Convert PDFs to text", type: "toggle", default: true,
    help: "The AI reads a text copy instead of the PDF file: usually cheaper, and some AI providers can't read PDF files.",
  }, {
    key: "ocrPages", label: "Scanned pages to read", type: "number", min: 0, integer: true,
    placeholder: "All pages (default)",
    help: "Pages that are only a picture are read with OCR, a few seconds each.",
  }, {
    key: "ocrLang", label: "OCR language", type: "select", default: "eng",
    help: "The language scanned pages are written in.",
    choicesFrom: "langs", choiceName: languageName,
    unknown: "The extractor isn't answering, so its languages aren't known.",
  }],
  // The extractor that reads PDFs (extractor/main.py), watched beside the AI
  // engines' sidecars (sidecar-catalog.js). The worker sends it each PDF here;
  // EXTRACTOR_URL overrides it, read when asked so a test can stand one in.
  sidecar: { url: () => process.env.EXTRACTOR_URL || "http://extractor:3002" },
};

export function pdfSource({ galleryDir, thumbsDir }) {
  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

  return {
    // Re-derive size + pdf metadata for a legacy entry from the stored file
    // (pdfinfo is cheap — header/xref only).
    async metaFor(entry) {
      try {
        const p = path.join(galleryDir, entry.name);
        const stat = await fs.promises.stat(p);
        return { size: stat.size, meta: await pdfInfo(p) };
      } catch {
        return null;
      }
    },

    // tmpPath -> stored original + page-1 preview; returns the payload file
    // entry, or null when the bytes don't match the claimed type.
    async ingest(tmpPath, originalName) {
      const ext = (originalName?.match(/\.(\w+)$/)?.[1] || "").toLowerCase();
      if (ext !== "pdf") return null;
      const buf = await fs.promises.readFile(tmpPath);
      if (!buf.subarray(0, 5).equals(Buffer.from("%PDF-"))) return null;

      const filename = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
      const entry = { name: filename, original_name: originalName || filename, kind: "pdf", size: buf.length, meta: {} };

      // No page cap: the AI reads a PDF's text, cut and marked at its own limit
      // (worker.js clipText). The file itself goes only to a provider that
      // declares it takes one this long (worker.js pdfRoute), which reads this
      // count until the PDF is read (planning/pdf-conversion-plan.md, C8).
      const { pages, title } = await pdfInfo(tmpPath);
      entry.meta = { pages, title };
      // The preview is optional: a render (pdfPage → null) OR a write failure
      // leaves the card an extension badge and the doc still ingests — never a
      // rejection over a missing thumbnail (graceful degradation).
      const rendered = await pdfPage(tmpPath);
      if (rendered) {
        try {
          const { w, h } = await storeFace({ galleryDir, thumbsDir }, filename, rendered);
          entry.w = w; entry.h = h;
        } catch (e) { console.warn(`pdf preview store failed for ${filename}: ${e.message} (badge)`); }
      }

      await fs.promises.writeFile(path.join(galleryDir, filename), buf);
      return entry;
    },
  };
}

// Page count + title via poppler's pdfinfo; nulls when poppler isn't installed
// (or a line can't be read, or the call ran out of time).
async function pdfInfo(pdfPath) {
  try {
    const { stdout } = await poppler("pdfinfo", [pdfPath]);
    const pages = stdout.match(/^Pages:\s+(\d+)/m);
    const title = stdout.match(/^Title:\s+(.+?)\s*$/m);
    return { pages: pages ? Number(pages[1]) : null, title: title ? title[1] : null };
  } catch {
    return { pages: null, title: null };
  }
}
