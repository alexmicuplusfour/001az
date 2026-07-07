// The document source handler: pdf / docx / txt / md / csv. Stores the
// original in the gallery store; PDFs get a page-1 preview rendered into the
// thumbnail store via poppler (pdftoppm + sharp), so their card face rides
// the exact same path as an image thumbnail (no poppler on the box → the doc
// still ingests, just without a preview). docx gets its content extracted at
// ingest (mammoth, pure JS): raw text into a .txt sidecar (the tagger + the
// card page-peek read it — clean signal, no markup, works on every provider)
// and formatted HTML into a .html sidecar (the lightbox's full view). So docx
// flows through the text pipeline for tagging, unlike PDFs.
import sharp from "sharp";
import mammoth from "mammoth";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const KIND_BY_EXT = { pdf: "pdf", docx: "docx", txt: "text", md: "text", csv: "text" };
const PDF_MAX_PAGES = 100; // Anthropic document-block limit
const THUMB_WIDTH = 600; // matches the image source

export const isDocName = (name) => /\.(pdf|docx|txt|md|csv)$/i.test(name || "");

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
      if (kind === "docx") {
        // docx is a zip; extraction failing means it isn't really one.
        if (!buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return null;
        let text, html;
        try {
          // Raw text feeds the tagger + the card page-peek; formatted HTML is
          // the lightbox's full view.
          text = (await mammoth.extractRawText({ buffer: buf })).value;
          html = (await mammoth.convertToHtml({ buffer: buf })).value;
        } catch {
          return null;
        }
        await fs.promises.writeFile(path.join(galleryDir, filename + ".txt"), text);
        await fs.promises.writeFile(path.join(galleryDir, filename + ".html"), docHtml(html));
        const dims = await renderTextPreview(text, path.join(thumbsDir, filename + ".webp"));
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
