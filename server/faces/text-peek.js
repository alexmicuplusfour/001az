// Text face producer: a "page peek" — the first ~32 lines drawn onto a white SVG
// page and rasterized by sharp. Used by the text (txt/md/csv) and docx handlers
// (docx feeds its extracted text). Needs a system font in the runtime image
// (fonts-dejavu-core in the Dockerfile); without one the page renders blank but
// dims still land. Returns { webp, w, h } or null on failure.
import sharp from "sharp";

const TXT_LINES = 32;
const TXT_WRAP = 74;

// XML-illegal C0 control chars — all of 0x00–0x1F except tab/LF/CR. Built from
// char codes so no literal control characters live in this source file (they get
// silently mangled by editors/tools; keep them out of the bytes on disk).
const C = String.fromCharCode;
const CTRL = new RegExp(`[${C(0)}-${C(8)}${C(0x0b)}${C(0x0c)}${C(0x0e)}-${C(0x1f)}]`, "g");

export async function textPeek(text) {
  const esc = (s) =>
    s.replace(CTRL, "")
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
    const { data, info } = await sharp(Buffer.from(svg)).webp({ quality: 72 }).toBuffer({ resolveWithObject: true });
    return { webp: data, w: info.width, h: info.height };
  } catch {
    return null;
  }
}
