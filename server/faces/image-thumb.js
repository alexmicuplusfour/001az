// Image face producer: an oriented, ≤600px-wide webp thumbnail of an already
// decoded image buffer. The caller (sources/image.js) owns the decode, the SVG
// rasterization, the format sniff, and writing the original — this is only the
// card face. `maxPixels` caps the decode (the OOM guard on the small droplet;
// image.js passes its MAX_PIXELS). Returns { webp, w, h }.
import sharp from "sharp";

// Exported as the ONE statement of the card face's width: the pdf face
// matches it, and the AI rendition (ai-image.js) uses it as the "a preset at
// or below the face can't beat the face" threshold — a drifted copy there
// would silently mis-route the thumb-mode rung.
export const THUMB_WIDTH = 600;

export async function imageThumb(buf, { maxPixels } = {}) {
  const { data, info } = await sharp(buf, { pages: 1, limitInputPixels: maxPixels })
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer({ resolveWithObject: true });
  return { webp: data, w: info.width, h: info.height };
}
