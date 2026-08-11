// The parts builder — what the model is actually shown for an item
// (ai-image-input-plan.md, Slice 4). Pure: no server, no Postgres. These tests
// exist because Slice 4 hoisted modelInputFor out of startWorker's closure to
// module scope, the same move documentTextFor and imageForDetection already
// made; the tmpdir fixture style is docs.test.js's.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { modelInputFor, imagesFor } from "../server/worker.js";
import { IMAGE_PRESETS, GENERIC_IMAGES } from "../server/ai-image.js";
import { PROVIDERS } from "../server/providers.js";
import { imageThumb } from "../server/faces/image-thumb.js";

let dirs, root;
before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "model-input-"));
  dirs = { galleryDir: path.join(root, "gallery"), thumbsDir: path.join(root, "thumbs") };
  fs.mkdirSync(dirs.galleryDir);
  fs.mkdirSync(dirs.thumbsDir);
});
after(() => fs.promises.rm(root, { recursive: true, force: true }));

// A stored original + its real card face + the payload the worker would hold.
let seq = 0;
async function imageItem(width, height, extra = {}) {
  const name = `mi${seq++}.png`;
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } } })
    .png().toBuffer();
  await fs.promises.writeFile(path.join(dirs.galleryDir, name), buf);
  const face = await imageThumb(buf);
  await fs.promises.writeFile(path.join(dirs.thumbsDir, name + ".webp"), face.webp);
  return {
    files: [{ name, original_name: "shot.png", kind: "image", w: face.w, h: face.h, meta: { width, height }, ...extra }],
  };
}

const imagePart = (parts) => parts.find((p) => p.kind === "image");
const textOf = (parts) => parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n");
const dimsOf = async (part) => sharp(Buffer.from(part.b64, "base64")).metadata();

test("an image item is shown the RENDITION of its original, not the card face", async () => {
  const payload = await imageItem(4000, 3000);
  const parts = await modelInputFor(dirs, payload, { preset: IMAGE_PRESETS.high });
  const img = imagePart(parts);
  assert.equal(img.render.source, "original");
  assert.equal(img.mediaType, "image/webp");
  const m = await dimsOf(img);
  assert.equal(Math.max(m.width, m.height), 1568, "the preset's long edge");
  // The anchor still closes with the tag leg's own tool.
  assert.match(textOf(parts), /record_tags/);
});

test("the `thumb` preset shows the card face — byte-identical to the pre-preset behaviour", async () => {
  const payload = await imageItem(4000, 3000);
  const parts = await modelInputFor(dirs, payload, { preset: IMAGE_PRESETS.thumb });
  const img = imagePart(parts);
  assert.equal(img.render.source, "thumb");
  const face = await fs.promises.readFile(path.join(dirs.thumbsDir, payload.files[0].name + ".webp"));
  assert.equal(img.b64, face.toString("base64"));
});

test("the provider's declared ceiling clamps the board's preset", async () => {
  const payload = await imageItem(4000, 3000);
  const parts = await modelInputFor(dirs, payload, {
    preset: IMAGE_PRESETS.high,           // asks for 1568
    images: { maxEdge: 900, maxBytes: 4e6 }, // provider says 900
  });
  const m = await dimsOf(imagePart(parts));
  assert.equal(Math.max(m.width, m.height), 900);
});

test("extract mode asks for record_fields and still gets the rendition", async () => {
  const payload = await imageItem(2000, 1200);
  const parts = await modelInputFor(dirs, payload, { mode: "extract", preset: IMAGE_PRESETS.high });
  assert.equal(imagePart(parts).render.source, "original");
  // The wrong-tool-name trap: extraction offers record_fields only.
  assert.match(textOf(parts), /record_fields/);
  assert.doesNotMatch(textOf(parts), /record_tags/);
});

test("a generated connector face stays the face, and keeps its chart anchor", async () => {
  // A chart's galleryDir copy IS its webp face, so the rendition rung finds
  // nothing bigger to render — no special-casing needed.
  const name = "chart0.webp";
  const rendered = await imageThumb(
    await sharp({ create: { width: 600, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer()
  );
  await fs.promises.writeFile(path.join(dirs.galleryDir, name), rendered.webp);
  await fs.promises.writeFile(path.join(dirs.thumbsDir, name + ".webp"), rendered.webp);
  const payload = {
    identity: "BTC",
    files: [{ name, original_name: name, kind: "image", generated: true, w: rendered.w, h: rendered.h }],
  };
  const parts = await modelInputFor(dirs, payload, { preset: IMAGE_PRESETS.max });
  assert.equal(imagePart(parts).render.source, "thumb");
  assert.match(textOf(parts), /price chart for "BTC"/);
});

test("a fileless entity vehicle is text-only — no image, no throw", async () => {
  const parts = await modelInputFor(dirs, { identity: "ACME" }, {
    entity: { display_name: "Acme Corp" },
    preset: IMAGE_PRESETS.high,
  });
  assert.equal(imagePart(parts), undefined);
  assert.match(textOf(parts), /Acme Corp/);
});

test("a preset is not required — the builder defaults rather than throwing", async () => {
  // startWorker always passes one; a future caller that forgets must not take
  // the tag leg down (aiImageFor defaults to the app default preset).
  const payload = await imageItem(1200, 800);
  const parts = await modelInputFor(dirs, payload);
  assert.ok(imagePart(parts).b64.length > 0);
});

test("imagesFor: the resolved provider's ceiling, with the generic floor for everything else", () => {
  assert.deepEqual(imagesFor({ provider: "anthropic" }), PROVIDERS.anthropic.images);
  // An on-device provider declares none; so does an uninstalled/unknown name,
  // and a null binding (a floor that resolved to nothing) must not throw.
  assert.equal(imagesFor({ provider: "local" }), GENERIC_IMAGES);
  assert.equal(imagesFor({ provider: "no-such-provider" }), GENERIC_IMAGES);
  assert.equal(imagesFor(null), GENERIC_IMAGES);
  assert.equal(imagesFor(undefined), GENERIC_IMAGES);
});

// --- §6b: PDFs are deliberately NOT part of the rendition mechanism ---

test("a PDF's page-1 preview stays the stored card face (a decision, not an oversight)", async (t) => {
  // Text-first material: the extracted text is the evidence, the preview is an
  // anchor. If this ever fails, someone wired the pdf branch into the rendition
  // path — read §6b before "fixing" the test.
  const name = "doc0.pdf";
  await fs.promises.writeFile(path.join(dirs.galleryDir, name), "%PDF-1.4 not really");
  // A PDF's text comes from the extractor sidecar (docs.test.js's stub shape).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ markdown: "# Quarterly report" }) });
  t.after(() => { globalThis.fetch = realFetch; });
  const face = await imageThumb(
    await sharp({ create: { width: 1200, height: 1600, channels: 3, background: { r: 240, g: 240, b: 240 } } }).png().toBuffer()
  );
  await fs.promises.writeFile(path.join(dirs.thumbsDir, name + ".webp"), face.webp);

  const payload = { files: [{ name, original_name: "report.pdf", kind: "pdf", w: face.w, h: face.h }] };
  const parts = await modelInputFor(dirs, payload, { preset: IMAGE_PRESETS.max });
  const img = imagePart(parts);
  assert.equal(img.b64, face.webp.toString("base64"), "the stored 600px face, unscaled");
  assert.equal(img.render, undefined, "no rendition bag — this path never renders");
  assert.match(textOf(parts), /Quarterly report/);
});
