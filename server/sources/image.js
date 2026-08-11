// The image source handler: turns an uploaded image file into a stored
// original + thumbnail and the generic file entry ({ name, original_name,
// w, h }) that lands in an item's payload.files. Owns everything
// image-format-specific; the ingest route (server/ingest.js) stays
// format-blind. Also owns cleanup of the files it wrote.
import sharp from "sharp";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { sharpGate, MAX_DECODE_PIXELS } from "../sharp-gate.js";
import { imageThumb } from "../faces/image-thumb.js";
import { storeFace } from "../faces/index.js";

const SVG_RASTER_WIDTH = 2000; // SVG uploads are rasterized to WebP at this width
const ALLOWED = { jpeg: "jpg", png: "png", webp: "webp", avif: "avif", heif: "avif", gif: "gif" };

// `extensions` is the name-level pre-filter (folder feeds, catalog display) —
// the sharp sniff in ingest() is the real gate, and unmatched extensions still
// reach this handler as the dispatcher's fallback. `core`: images can't be
// disabled — sharp is shared infrastructure (pdf/text previews render through
// it) and the grid's face pipeline assumes it exists.
export const manifest = {
  name: "image",
  label: "Image files",
  description: "Accept & thumbnail JPG, PNG, WebP, GIF, SVG",
  core: true,
  extensions: ["jpg", "jpeg", "png", "webp", "avif", "heif", "heic", "gif", "svg"],
  kinds: ["image"],
  // Per-type upload limit in bytes — the manifest default, adjustable per type on
  // the Plugins page. multer's global ceiling (server/ingest.js) is only an
  // absolute backstop; this is the real gate, enforced in admitFile.
  maxBytes: 10 * 1024 * 1024,
};

// The original-resolution metadata surfaced for image file fields (server/media).
// Shared by ingest (from the decoded buffer) and metaFor (from the stored file).
const pickImageMeta = (m) => ({
  width: m.width ?? null,
  height: m.height ?? null,
  format: m.format || null,
  space: m.space || null,
  hasAlpha: m.hasAlpha ?? null,
});

export function imageSource({ galleryDir, thumbsDir }) {
  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

  // The decode gate + the droplet-safe sharp globals live in ../sharp-gate.js,
  // shared with the tag-time AI renditions (ai-image.js) — one "who may decode
  // right now" answer process-wide.

  return {
    // tmpPath -> stored original + thumbnail; returns the payload file entry,
    // or null when the bytes aren't an image type we accept.
    async ingest(tmpPath, originalName) {
      return sharpGate(async () => {
        let buf = await fs.promises.readFile(tmpPath);
        let meta = await sharp(buf, { pages: 1, limitInputPixels: MAX_DECODE_PIXELS }).metadata();
        if (meta.format === "svg") {
          // Rasterize SVGs to WebP: vectors can embed scripts, so the original
          // markup is never stored or served. Render at high density, then cap.
          const density = Math.min(2400, Math.max(72, (72 * SVG_RASTER_WIDTH) / (meta.width || SVG_RASTER_WIDTH)));
          buf = await sharp(buf, { density, limitInputPixels: MAX_DECODE_PIXELS })
            .resize({ width: SVG_RASTER_WIDTH, withoutEnlargement: true })
            .webp({ quality: 90 })
            .toBuffer();
          meta = await sharp(buf).metadata();
        }
        const ext = ALLOWED[meta.format];
        if (!ext) return null;
        const id = crypto.randomBytes(8).toString("hex");
        const filename = `${id}.${ext}`;
        // The face (thumbnail) via the shared producer; the original is written
        // separately below (storeFace writes only the thumb for a non-generated face).
        // Unlike the doc handlers, the face is NOT optional here: an image's whole
        // point is its thumbnail, so a render/write failure rejects the upload
        // (behavior-identical to the pre-face-pipeline inline toFile). imageThumb
        // throws rather than returning null, so there's no null-guard branch.
        const rendered = await imageThumb(buf, { maxPixels: MAX_DECODE_PIXELS });
        const { w, h } = await storeFace({ galleryDir, thumbsDir }, filename, rendered);
        await fs.promises.writeFile(path.join(galleryDir, filename), buf);
        return {
          name: filename,
          original_name: originalName || filename,
          kind: "image",
          w,
          h,
          // Stored-file size + original-resolution metadata for file fields
          // (server/media). meta.width/height are the source pixels — distinct
          // from w/h, which are the thumbnail's.
          size: buf.length,
          meta: pickImageMeta(meta),
        };
      });
    },

    // Re-derive size + original resolution for a legacy entry (uploaded before
    // file fields) from the stored file. sharp.metadata() reads the header only —
    // no full pixel decode — so this is cheap even on the small box. Returns
    // { size, meta } or null when the file can't be read.
    async metaFor(entry) {
      try {
        const p = path.join(galleryDir, entry.name);
        const [stat, m] = await Promise.all([
          fs.promises.stat(p),
          sharp(p, { pages: 1, limitInputPixels: MAX_DECODE_PIXELS }).metadata(),
        ]);
        return { size: stat.size, meta: pickImageMeta(m) };
      } catch {
        return null;
      }
    },

    // Legacy: items uploaded before thumb dimensions were stored. Image kind
    // only — a doc without dims has no preview by design, not a missing value.
    async backfillDims(rows, update) {
      const todo = rows.filter((r) => {
        const f = r.payload.files?.[0];
        return f?.name && !f.w && (f.kind || "image") === "image";
      });
      if (!todo.length) return;
      console.log(`backfilling thumbnail dimensions for ${todo.length} image(s)...`);
      let done = 0;
      for (const row of todo) {
        try {
          const file = row.payload.files[0];
          const meta = await sharp(path.join(thumbsDir, file.name + ".webp")).metadata();
          if (meta.width && meta.height) {
            // Top-level merge: single-file items, so replacing the array is safe.
            await update(row.id, { files: [{ ...file, w: meta.width, h: meta.height }] });
            done++;
          }
        } catch {}
      }
      console.log(`thumbnail dimension backfill complete: ${done}/${todo.length}`);
    },
  };
}
