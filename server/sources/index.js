// Source handlers: whoever brings a file into the app stores it, generates
// its face (thumbnail), and describes it as a payload file entry. The ingest
// route picks a handler per file and stays format-blind. All handlers share
// one storage convention — original in galleryDir/<name>, face in
// thumbsDir/<name>.webp — which is what makes cleanup generic.
import fs from "node:fs";
import path from "node:path";
import { imageSource } from "./image.js";
import { docSource, isDocName } from "./doc.js";

export function createSources({ galleryDir, thumbsDir }) {
  const image = imageSource({ galleryDir, thumbsDir });
  const doc = docSource({ galleryDir, thumbsDir });

  return {
    // Docs are picked by extension; everything else goes to the image
    // handler, whose sharp sniff is the real gate (non-images come back null).
    forUpload: (originalName) => (isDocName(originalName) ? doc : image),

    // Remove everything a payload's files put on disk.
    cleanup(files) {
      for (const f of files || []) {
        if (!f.name) continue;
        fs.rmSync(path.join(galleryDir, f.name), { force: true });
        fs.rmSync(path.join(galleryDir, f.name + ".txt"), { force: true }); // docx text sidecar
        fs.rmSync(path.join(thumbsDir, f.name + ".webp"), { force: true });
      }
    },

    backfillDims: image.backfillDims,
  };
}
