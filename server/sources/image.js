// The image source handler: turns an uploaded image file into a stored
// original + thumbnail and the generic file entry ({ name, original_name,
// w, h }) that lands in an item's payload.files. Owns everything
// image-format-specific; the ingest route (server/ingest.js) stays
// format-blind. Also owns cleanup of the files it wrote.
import sharp from "sharp";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const THUMB_WIDTH = 600;
const SVG_RASTER_WIDTH = 2000; // SVG uploads are rasterized to WebP at this width
const MAX_PIXELS = 40e6; // decode cap: a 40MP image is ~160 MB of raw pixels
const ALLOWED = { jpeg: "jpg", png: "png", webp: "webp", avif: "avif", heif: "avif", gif: "gif" };

export function imageSource({ galleryDir, thumbsDir }) {
  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

  // The droplet is small (1 vCPU / 458 MB, no swap — node got OOM-killed under
  // a concurrent bulk upload). Keep libvips lean: no operation cache holding
  // decoded images, single worker thread.
  sharp.cache(false);
  sharp.concurrency(1);

  // All upload image processing goes through this gate: decode strictly one
  // image at a time process-wide, no matter how many requests are in flight.
  let processGate = Promise.resolve();
  function serializeProcessing(fn) {
    const run = processGate.then(fn);
    processGate = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  return {
    // tmpPath -> stored original + thumbnail; returns the payload file entry,
    // or null when the bytes aren't an image type we accept.
    async ingest(tmpPath, originalName) {
      return serializeProcessing(async () => {
        let buf = await fs.promises.readFile(tmpPath);
        let meta = await sharp(buf, { pages: 1, limitInputPixels: MAX_PIXELS }).metadata();
        if (meta.format === "svg") {
          // Rasterize SVGs to WebP: vectors can embed scripts, so the original
          // markup is never stored or served. Render at high density, then cap.
          const density = Math.min(2400, Math.max(72, (72 * SVG_RASTER_WIDTH) / (meta.width || SVG_RASTER_WIDTH)));
          buf = await sharp(buf, { density, limitInputPixels: MAX_PIXELS })
            .resize({ width: SVG_RASTER_WIDTH, withoutEnlargement: true })
            .webp({ quality: 90 })
            .toBuffer();
          meta = await sharp(buf).metadata();
        }
        const ext = ALLOWED[meta.format];
        if (!ext) return null;
        const id = crypto.randomBytes(8).toString("hex");
        const filename = `${id}.${ext}`;
        const thumbInfo = await sharp(buf, { pages: 1, limitInputPixels: MAX_PIXELS })
          .rotate()
          .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
          .webp({ quality: 72 })
          .toFile(path.join(thumbsDir, filename + ".webp"));
        await fs.promises.writeFile(path.join(galleryDir, filename), buf);
        return {
          name: filename,
          original_name: originalName || filename,
          kind: "image",
          w: thumbInfo.width,
          h: thumbInfo.height,
        };
      });
    },

    // Legacy: items uploaded before thumb dimensions were stored.
    async backfillDims(rows, update) {
      const todo = rows.filter((r) => r.payload.files?.[0]?.name && !r.payload.files[0].w);
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
