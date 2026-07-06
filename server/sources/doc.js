// The document source handler: pdf / txt / md / csv. Stores the original in
// the gallery store; PDFs additionally get a page-1 preview rendered into the
// thumbnail store via poppler (pdftoppm + sharp), so their card face rides the
// exact same path as an image thumbnail. No poppler on the box → the doc
// still ingests, it just has no preview (title-card face).
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const KIND_BY_EXT = { pdf: "pdf", txt: "text", md: "text", csv: "text" };
const PDF_MAX_PAGES = 100; // Anthropic document-block limit
const THUMB_WIDTH = 600; // matches the image source

export const isDocName = (name) => /\.(pdf|txt|md|csv)$/i.test(name || "");

export function docSource({ galleryDir, thumbsDir }) {
  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

  return {
    // tmpPath -> stored original (+ pdf preview); returns the payload file
    // entry, or null when the bytes don't match the claimed type.
    async ingest(tmpPath, originalName) {
      const ext = (originalName?.match(/\.(\w+)$/)?.[1] || "").toLowerCase();
      const kind = KIND_BY_EXT[ext];
      if (!kind) return null;
      const buf = await fs.promises.readFile(tmpPath);
      if (kind === "pdf" && !buf.subarray(0, 5).equals(Buffer.from("%PDF-"))) return null;
      // a .txt/.md/.csv with NUL bytes is binary wearing a text extension
      if (kind === "text" && buf.subarray(0, 8192).includes(0)) return null;

      const filename = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
      const entry = { name: filename, original_name: originalName || filename, kind };

      if (kind === "pdf") {
        const pages = await pdfPages(tmpPath);
        if (pages != null && pages > PDF_MAX_PAGES) {
          const err = new Error(`PDF too long (max ${PDF_MAX_PAGES} pages)`);
          err.reason = err.message;
          throw err;
        }
        const dims = await renderPdfPreview(tmpPath, path.join(thumbsDir, filename + ".webp"));
        if (dims) { entry.w = dims.w; entry.h = dims.h; }
      }
      if (kind === "text") {
        const dims = await renderTextPreview(buf.toString("utf8"), path.join(thumbsDir, filename + ".webp"));
        if (dims) { entry.w = dims.w; entry.h = dims.h; }
      }

      await fs.promises.writeFile(path.join(galleryDir, filename), buf);
      return entry;
    },
  };
}

// Page count via poppler's pdfinfo; null when poppler isn't installed (or the
// count can't be read) — the API's own limit is the backstop then.
async function pdfPages(pdfPath) {
  try {
    const { stdout } = await run("pdfinfo", [pdfPath]);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// Text files get a "page peek" face: the first lines drawn onto a white
// page (SVG) and rasterized by sharp — same thumbnail store, same webp.
// Needs a system font in the runtime image (fonts-dejavu-core in the
// Dockerfile); without one the page renders blank but dims still land.
const TXT_LINES = 32;
const TXT_WRAP = 74;

async function renderTextPreview(text, thumbPath) {
  const esc = (s) =>
    s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") // XML-illegal control chars
      .replace(/\t/g, "  ")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = [];
  for (const raw of text.slice(0, 4000).split(/\r?\n/)) {
    if (raw.length <= TXT_WRAP) lines.push(raw);
    else for (let i = 0; i < raw.length && lines.length <= TXT_LINES; i += TXT_WRAP) lines.push(raw.slice(i, i + TXT_WRAP));
    if (lines.length > TXT_LINES) break;
  }
  const body = lines.slice(0, TXT_LINES).map((l, i) =>
    `<text x="30" y="${46 + i * 22}" font-family="DejaVu Sans, Arial, sans-serif" font-size="13" fill="#3a3a40">${esc(l)}</text>`
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="760"><rect width="600" height="760" fill="#ffffff"/>${body}</svg>`;
  try {
    const info = await sharp(Buffer.from(svg)).webp({ quality: 72 }).toFile(thumbPath);
    return { w: info.width, h: info.height };
  } catch {
    return null;
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
