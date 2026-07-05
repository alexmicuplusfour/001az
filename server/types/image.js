// The image board type: upload ingestion (multer + sharp), static serving of
// originals + thumbnails, the tagger's image input, and file cleanup. Imports
// nothing from core — everything it can touch arrives via ctx and options.
import express from "express";
import multer from "multer";
import sharp from "sharp";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";

// Backstop limits only — the client pre-filters oversized files and chunks
// large drops (see UPLOAD_* in app.js; keep UPLOAD_MAX_BYTES in sync). If
// multer still trips one of these, the whole request 413s.
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 200; // per request
const THUMB_WIDTH = 600;
const SVG_RASTER_WIDTH = 2000; // SVG uploads are rasterized to WebP at this width
const MAX_PIXELS = 40e6; // decode cap: a 40MP image is ~160 MB of raw pixels
const ALLOWED = { jpeg: "jpg", png: "png", webp: "webp", avif: "avif", heif: "avif", gif: "gif" };

// Express 4 doesn't forward rejected promises from async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export default function imageType({ galleryDir, thumbsDir }) {
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

  // Disk-backed upload (bounded memory; we process one file at a time).
  const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: MAX_BYTES, files: MAX_FILES },
  });

  return {
    manifest: {
      apiVersion: 1,
      type: "image",
      name: "Images",
      version: "1.0.0",
      subject: "images", // "You tag images for a private research gallery."
      capabilities: {},
    },

    // Starter facets offered at board creation (suggestion only — boards own
    // their facets and edit freely).
    suggestedFacets: [
      {
        key: "category", label: "Category", single: true,
        values: ["tops", "bottoms", "footwear", "accessories", "outerwear"],
        description: "what kind of item this is",
      },
      {
        key: "season", label: "Season",
        values: ["summer", "winter", "spring-fall", "year-round"],
        description: "when you'd wear or use it",
      },
      {
        key: "formality", label: "Formality", single: true,
        values: ["casual", "workwear", "formal", "athletic"],
        description: "how dressed-up the item reads",
      },
    ],

    mountRoutes(app, ctx) {
      app.post("/api/upload", ctx.auth.requireAuth, upload.array("files", MAX_FILES), wrap(async (req, res) => {
        const boardId = req.query.board || (req.body && req.body.board_id) || null;
        const board = boardId ? await ctx.boards.get(boardId) : null;
        if (!board) {
          return res.status(400).json({ error: "valid board required" });
        }

        const files = req.files || [];
        const uploaded = [];
        const rejected = [];

        for (const f of files) {
          try {
            await serializeProcessing(async () => {
              let buf = await fs.promises.readFile(f.path);
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
              if (!ext) {
                rejected.push({ name: f.originalname, reason: "unsupported image type" });
                return;
              }
              const id = crypto.randomBytes(8).toString("hex");
              const filename = `${id}.${ext}`;
              const thumbInfo = await sharp(buf, { pages: 1, limitInputPixels: MAX_PIXELS })
                .rotate()
                .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
                .webp({ quality: 72 })
                .toFile(path.join(thumbsDir, filename + ".webp"));
              await fs.promises.writeFile(path.join(galleryDir, filename), buf);

              const item = await ctx.items.create(boardId, {
                filename,
                original_name: f.originalname || filename,
                w: thumbInfo.width,
                h: thumbInfo.height,
              });
              uploaded.push({
                id: item.id,
                name: filename,
                status: item.status,
                tags: [],
                w: thumbInfo.width,
                h: thumbInfo.height,
              });
            });
          } catch (err) {
            console.error("upload error:", f.originalname, err.message);
            rejected.push({ name: f.originalname, reason: "could not process image" });
          } finally {
            await fs.promises.unlink(f.path).catch(() => {});
          }
        }

        res.json({ uploaded, rejected });
      }));

      // Multer limit errors from the route above; anything else falls through
      // to the app's generic error handler.
      app.use((err, _req, res, next) => {
        if (err && err.code === "LIMIT_FILE_SIZE")
          return res.status(413).json({ error: "file too large (max 10 MB)" });
        if (err && err.code === "LIMIT_FILE_COUNT")
          return res.status(413).json({ error: `too many files (max ${MAX_FILES})` });
        next(err);
      });

      // Uploaded originals + thumbnails live outside the app's static dir —
      // mount them explicitly. Filenames are random per upload and never
      // reused, so long-lived caching is safe.
      app.use("/gallery", express.static(galleryDir, { maxAge: "7d", immutable: true }));
      app.use("/thumbnails", express.static(thumbsDir, { maxAge: "7d", immutable: true }));

      // Legacy: items uploaded before thumb dimensions were stored.
      backfillThumbDimensions(ctx).catch((err) => ctx.log("thumb backfill error:", err.message));
    },

    // The tagger sees the thumbnail (cheap) rather than the original.
    async buildModelInput(item) {
      const buf = await fs.promises.readFile(path.join(thumbsDir, item.payload.filename + ".webp"));
      return {
        parts: [
          { kind: "image", mediaType: "image/webp", b64: buf.toString("base64") },
          { kind: "text", text: "Tag this UI screenshot using the record_tags tool." },
        ],
      };
    },

    async onDelete(item) {
      const filename = item.payload?.filename;
      if (!filename) return;
      fs.rmSync(path.join(galleryDir, filename), { force: true });
      fs.rmSync(path.join(thumbsDir, filename + ".webp"), { force: true });
    },
  };

  async function backfillThumbDimensions(ctx) {
    const rows = (await ctx.items.listAll()).filter((r) => r.payload.filename && !r.payload.w);
    if (!rows.length) return;
    ctx.log(`backfilling thumbnail dimensions for ${rows.length} image(s)...`);
    let done = 0;
    for (const row of rows) {
      try {
        const meta = await sharp(path.join(thumbsDir, row.payload.filename + ".webp")).metadata();
        if (meta.width && meta.height) {
          await ctx.items.updatePayload(row.id, { w: meta.width, h: meta.height });
          done++;
        }
      } catch {}
    }
    ctx.log(`thumbnail dimension backfill complete: ${done}/${rows.length}`);
  }
}
