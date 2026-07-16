// The docx source handler. docx gets its content extracted at ingest
// (mammoth): raw text into a .txt sidecar (the tagger + the card page-peek
// read it — clean signal, no markup, works on every provider) and formatted
// HTML into a .html sidecar (the lightbox's full view). So docx flows through
// the text pipeline for tagging, unlike PDFs. mammoth is pure-JS and
// CPU-bound, so the extraction runs on a worker thread (docx-pool.js) to keep
// it off the event loop — otherwise a big document stalls every other upload
// while it parses.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { createDocxPool } from "./docx-pool.js";
import { textCounts } from "./shared.js";
import { textPeek } from "../faces/text-peek.js";
import { storeFace } from "../faces/index.js";

export const manifest = {
  name: "docx",
  label: "Word documents",
  description: "Extract text from .docx (via mammoth)",
  extensions: ["docx"],
  kinds: ["docx"],
};

export function docxSource({ galleryDir, thumbsDir }) {
  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  const docxPool = createDocxPool();

  return {
    // Terminate the extraction workers (graceful shutdown).
    close: () => docxPool.close(),

    // Re-derive size + counts for a legacy entry from the extracted-text sidecar.
    async metaFor(entry) {
      try {
        const p = path.join(galleryDir, entry.name);
        const stat = await fs.promises.stat(p);
        return { size: stat.size, meta: textCounts(await fs.promises.readFile(p + ".txt", "utf8").catch(() => "")) };
      } catch {
        return null;
      }
    },

    // tmpPath -> stored original + sidecars + page-peek face; returns the
    // payload file entry, or null when the bytes don't match the claimed type.
    async ingest(tmpPath, originalName) {
      const ext = (originalName?.match(/\.(\w+)$/)?.[1] || "").toLowerCase();
      if (ext !== "docx") return null;
      const buf = await fs.promises.readFile(tmpPath);
      // docx is a zip; extraction failing means it isn't really one.
      if (!buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return null;
      // mammoth runs on a worker thread (docx-pool) so a big document can't
      // stall the event loop and hold up every other upload. Raw text feeds
      // the tagger + the card page-peek; formatted HTML is the lightbox's
      // full view. null = mammoth couldn't read it, so it isn't a real docx.
      const extracted = await docxPool.extract(buf);
      if (!extracted) return null;
      const { text, html } = extracted;

      const filename = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
      const entry = { name: filename, original_name: originalName || filename, kind: "docx", size: buf.length, meta: textCounts(text) };
      await fs.promises.writeFile(path.join(galleryDir, filename + ".txt"), text);
      await fs.promises.writeFile(path.join(galleryDir, filename + ".html"), docHtml(html));
      const rendered = await textPeek(text);
      if (rendered) { const { w, h } = await storeFace({ galleryDir, thumbsDir }, filename, rendered); entry.w = w; entry.h = h; }

      await fs.promises.writeFile(path.join(galleryDir, filename), buf);
      return entry;
    },
  };
}

// Wrap mammoth's HTML fragment in a minimal, readable document for the
// lightbox iframe. Rendered same-origin under the app CSP (script-src 'self',
// object-src 'none'), which neutralizes any script/embed a crafted docx might
// carry; the typography is inline styling (style-src allows 'unsafe-inline').
function docHtml(fragment) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { max-width: 720px; margin: 0 auto; padding: 48px 28px; background: #fff; color: #23232a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.5em; }
  p { margin: 0 0 0.9em; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: 1em 0; }
  td, th { border: 1px solid #dcdce2; padding: 6px 10px; text-align: left; vertical-align: top; }
  a { color: #2b6cb0; }
</style></head><body>${fragment}</body></html>`;
}
