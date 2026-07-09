// Runs on a worker thread (spawned by docx-pool.js): the CPU-bound mammoth
// parsing that would otherwise block the main event loop for the whole process
// while a large document is read. Receives the docx bytes and returns the raw
// text (fed to the tagger + the card page-peek) and the formatted HTML (the
// lightbox's full view). A parse failure means the bytes aren't a real docx —
// reported as ok:false so the pool resolves null and the upload is rejected,
// matching the old inline try/catch behaviour.
import { parentPort } from "node:worker_threads";
import mammoth from "mammoth";

parentPort.on("message", async ({ id, buffer }) => {
  try {
    // The bytes arrive structured-cloned as a Uint8Array; wrap them as a Node
    // Buffer over the same memory (zero-copy) so mammoth gets what it expects.
    const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const text = (await mammoth.extractRawText({ buffer: buf })).value;
    const html = (await mammoth.convertToHtml({ buffer: buf })).value;
    parentPort.postMessage({ id, ok: true, text, html });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
