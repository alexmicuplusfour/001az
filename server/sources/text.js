// The plain-text source handler: txt / md / csv. Dependency-free — stores the
// original in the gallery store and renders a page-peek face (shared.js) into
// the thumbnail store.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { textCounts } from "./shared.js";
import { textPeek } from "../faces/text-peek.js";
import { storeFace } from "../faces/index.js";

export const manifest = {
  name: "text",
  label: "Text files",
  description: "Read .txt / .md / .csv as plain text",
  extensions: ["txt", "md", "csv"],
  kinds: ["text"],
};

export function textSource({ galleryDir, thumbsDir }) {
  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

  return {
    // Re-derive size + counts for a legacy entry from the stored file.
    async metaFor(entry) {
      try {
        const p = path.join(galleryDir, entry.name);
        const stat = await fs.promises.stat(p);
        return { size: stat.size, meta: textCounts(await fs.promises.readFile(p, "utf8")) };
      } catch {
        return null;
      }
    },

    // tmpPath -> stored original + page-peek face; returns the payload file
    // entry, or null when the bytes don't match the claimed type.
    async ingest(tmpPath, originalName) {
      const ext = (originalName?.match(/\.(\w+)$/)?.[1] || "").toLowerCase();
      if (!manifest.extensions.includes(ext)) return null;
      const buf = await fs.promises.readFile(tmpPath);
      // a .txt/.md/.csv with NUL bytes is binary wearing a text extension
      if (buf.subarray(0, 8192).includes(0)) return null;

      const filename = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
      const text = buf.toString("utf8");
      const entry = { name: filename, original_name: originalName || filename, kind: "text", size: buf.length, meta: textCounts(text) };
      const rendered = await textPeek(text);
      if (rendered) { const { w, h } = await storeFace({ galleryDir, thumbsDir }, filename, rendered); entry.w = w; entry.h = h; }

      await fs.promises.writeFile(path.join(galleryDir, filename), buf);
      return entry;
    },
  };
}
