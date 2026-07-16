// Image face producer: an oriented, ≤600px-wide webp thumbnail of an already
// decoded image buffer. The caller (sources/image.js) owns the decode, the SVG
// rasterization, the format sniff, and writing the original — this is only the
// card face. `maxPixels` caps the decode (the OOM guard on the small droplet;
// image.js passes its MAX_PIXELS). Returns { webp, w, h }.
import sharp from "sharp";

const THUMB_WIDTH = 600;

export async function imageThumb(buf, { maxPixels } = {}) {
  const { data, info } = await sharp(buf, { pages: 1, limitInputPixels: maxPixels })
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer({ resolveWithObject: true });
  return { webp: data, w: info.width, h: info.height };
}
