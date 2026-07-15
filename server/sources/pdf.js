// The PDF source handler. Stores the original in the gallery store; the card
// face is page 1 rendered into the thumbnail store via poppler (pdftoppm +
// sharp), so it rides the exact same path as an image thumbnail. Poppler is a
// system dependency (poppler-utils in the Dockerfile) — no poppler on the box
// and the doc still ingests, just without a preview or page count.
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const PDF_MAX_PAGES = 100; // Anthropic document-block limit
const THUMB_WIDTH = 600; // matches the image source

export const manifest = {
  name: "pdf",
  label: "PDF documents",
  description: "Extract text + a page-1 preview (via poppler)",
  extensions: ["pdf"],
  kinds: ["pdf"],
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

      const { pages, title } = await pdfInfo(tmpPath);
      if (pages != null && pages > PDF_MAX_PAGES) {
        const err = new Error(`PDF too long (max ${PDF_MAX_PAGES} pages)`);
        err.reason = err.message;
        throw err;
      }
      entry.meta = { pages, title };
      const dims = await renderPdfPreview(tmpPath, path.join(thumbsDir, filename + ".webp"));
      if (dims) { entry.w = dims.w; entry.h = dims.h; }

      await fs.promises.writeFile(path.join(galleryDir, filename), buf);
      return entry;
    },
  };
}

// Page count + title via poppler's pdfinfo; nulls when poppler isn't installed
// (or a line can't be read). `pages` also backstops the page cap — the API's
// own limit is the fallback when poppler is absent.
async function pdfInfo(pdfPath) {
  try {
    const { stdout } = await run("pdfinfo", [pdfPath]);
    const pages = stdout.match(/^Pages:\s+(\d+)/m);
    const title = stdout.match(/^Title:\s+(.+?)\s*$/m);
    return { pages: pages ? Number(pages[1]) : null, title: title ? title[1] : null };
  } catch {
    return { pages: null, title: null };
  }
}

// Page 1 -> png (pdftoppm) -> webp thumbnail (sharp). Returns { w, h } or
// null when poppler isn't installed or the render fails.
async function renderPdfPreview(pdfPath, thumbPath) {
  const prefix = path.join(os.tmpdir(), "docprev-" + crypto.randomBytes(6).toString("hex"));
  try {
    await run("pdftoppm", ["-png", "-f", "1", "-singlefile", "-scale-to", String(THUMB_WIDTH), pdfPath, prefix]);
    const info = await sharp(prefix + ".png").webp({ quality: 72 }).toFile(thumbPath);
    return { w: info.width, h: info.height };
  } catch {
    return null;
  } finally {
    await fs.promises.unlink(prefix + ".png").catch(() => {});
  }
}
