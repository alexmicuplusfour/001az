// Helpers shared by the text-bearing source handlers (text, docx). Pure —
// no handler state; each handler owns its own storage dirs and lifecycle.
import sharp from "sharp";

// Word + line counts for text-bearing documents (txt/md/csv and docx's
// extracted text). Pure — the handler already has the string in memory.
export function textCounts(text) {
  const s = text || "";
  return {
    word_count: (s.match(/\S+/g) || []).length,
    line_count: s ? s.split(/\r\n|\r|\n/).length : 0,
  };
}

// Text files get a "page peek" face: the first lines drawn onto a white
// page (SVG) and rasterized by sharp — same thumbnail store, same webp.
// Needs a system font in the runtime image (fonts-dejavu-core in the
// Dockerfile); without one the page renders blank but dims still land.
const TXT_LINES = 32;
const TXT_WRAP = 74;

export async function renderTextPreview(text, thumbPath) {
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
