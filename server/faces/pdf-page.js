// PDF face producer: page 1 rendered to a ≤600px webp via poppler (pdftoppm) +
// sharp. Poppler is a system dep (poppler-utils in the Dockerfile); without it —
// or on any render failure — returns null and the card falls back to an extension
// badge (the doc still ingests, just with no preview). Takes the path to the pdf
// on disk (poppler reads the file, not bytes). Returns { webp, w, h } or null.
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { THUMB_WIDTH } from "./image-thumb.js"; // matches the image face by construction

const run = promisify(execFile);

export async function pdfPage(pdfPath) {
  const prefix = path.join(os.tmpdir(), "docprev-" + crypto.randomBytes(6).toString("hex"));
  try {
    await run("pdftoppm", ["-png", "-f", "1", "-singlefile", "-scale-to", String(THUMB_WIDTH), pdfPath, prefix]);
    const { data, info } = await sharp(prefix + ".png").webp({ quality: 72 }).toBuffer({ resolveWithObject: true });
    return { webp: data, w: info.width, h: info.height };
  } catch {
    return null;
  } finally {
    await fs.promises.unlink(prefix + ".png").catch(() => {});
  }
}
