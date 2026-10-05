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
import { modelInputFor, modelInputForExtract, imagesFor, documentsFor, pdfRoute, refusedFile } from "../server/worker.js";
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

test("a PDF's page-1 preview stays the stored card face (a decision, not an oversight)", async () => {
  // Text-first material: the extracted text is the evidence, the preview is an
  // anchor. If this ever fails, someone wired the pdf branch into the rendition
  // path — read §6b before "fixing" the test.
  const name = "doc0.pdf";
  await fs.promises.writeFile(path.join(dirs.galleryDir, name), "%PDF-1.4 not really");
  // A PDF's text is what its read kept beside it (pdf-conversion-plan.md C5).
  await fs.promises.writeFile(path.join(dirs.galleryDir, name + ".md"), "# Quarterly report");
  const face = await imageThumb(
    await sharp({ create: { width: 1200, height: 1600, channels: 3, background: { r: 240, g: 240, b: 240 } } }).png().toBuffer()
  );
  await fs.promises.writeFile(path.join(dirs.thumbsDir, name + ".webp"), face.webp);

  const payload = {
    files: [{ name, original_name: "report.pdf", kind: "pdf", w: face.w, h: face.h }],
    pdf_text: { pages: 1, chars: 18 },
  };
  const parts = await modelInputFor(dirs, payload, { preset: IMAGE_PRESETS.max });
  const img = imagePart(parts);
  assert.equal(img.b64, face.webp.toString("base64"), "the stored 600px face, unscaled");
  assert.equal(img.render, undefined, "no rendition bag — this path never renders");
  assert.match(textOf(parts), /Quarterly report/);
});

test("a clip whose transcription failed with an empty message is answered, not still waiting", async () => {
  // The claim asks the stored column, which tests the transcript_error KEY
  // (migration 0057); the legs used to test its truthiness, so an error with
  // an empty message was claimable yet bounced forever as "awaiting
  // transcription" (audio-tag-handoff-plan.md second pass).
  const clip = { files: [{ name: "c.mp3", original_name: "c.mp3", kind: "audio" }] };
  const parts = await modelInputFor(dirs, { ...clip, transcript_error: "" });
  assert.match(parts[0].text, /"c\.mp3" with no discernible speech/, "tagged from its name");
  assert.equal(await modelInputForExtract(dirs.galleryDir, { ...clip, transcript_error: "" }), null, "nothing to extract");
  await assert.rejects(modelInputFor(dirs, clip), /awaiting transcription/, "no key at all is still a wait");
});

// --- pdf-conversion-plan.md Stage 1b: what a PDF sends once it has been read ---

// A stored PDF with a real card face; `extra` is what its read left on the payload.
async function pdfItem(extra = {}, { face = true } = {}) {
  const name = `pdf${seq++}.pdf`;
  const body = "%PDF-1.4 not really";
  await fs.promises.writeFile(path.join(dirs.galleryDir, name), body);
  if (face) {
    const thumb = await imageThumb(
      await sharp({ create: { width: 1200, height: 1600, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer());
    await fs.promises.writeFile(path.join(dirs.thumbsDir, name + ".webp"), thumb.webp);
  }
  return { name, payload: { files: [{ name, original_name: "locked.pdf", kind: "pdf", size: body.length }], ...extra } };
}

test("a parked PDF goes as its face and its name on every step, never as the file", async () => {
  // Parked = the extractor couldn't open it (a password, damage) or gave up on
  // it; the AI can't open what the extractor couldn't (plan C8).
  const { payload } = await pdfItem({ pdf_text_error: "extractor: the PDF is password-protected" });
  const parts = await modelInputFor(dirs, payload);
  assert.equal(parts.some((p) => p.kind === "document"), false, "never the file");
  assert.ok(imagePart(parts), "its page-1 face rides along");
  assert.match(textOf(parts), /PDF document \("locked\.pdf"\), shown above as a first-page preview, whose text couldn't be read\. Tag it using the record_tags tool, judging from its preview and its name\./);
  assert.doesNotMatch(textOf(parts), /password/, "why it was parked is the job row's to say, not the model's");

  // Extraction has no text to work from, and falls back to the same parts.
  assert.equal(await modelInputForExtract(dirs.galleryDir, payload), null);
  assert.match(textOf(await modelInputFor(dirs, payload, { mode: "extract" })), /record_fields tool, judging from its preview and its name/);

  // No face (pdftoppm can't render a locked file either): the name alone.
  const bare = (await pdfItem({ pdf_text_error: "" }, { face: false })).payload;
  const only = await modelInputFor(dirs, bare);
  assert.deepEqual(only.map((p) => p.kind), ["text"]);
  assert.match(textOf(only), /whose text couldn't be read\. Tag it using the record_tags tool, judging from its name\./);
});

// A provider that reads PDF files (Anthropic's declaration), and one that
// doesn't — the step's view of a PDF, as worker.js pdfView builds it.
const READS = { convert: true, documents: { maxBytes: 20e6, maxPages: 100 }, label: "Anthropic" };
const CANT = { convert: true, documents: null, label: "GLM" };

test("a PDF read with no text goes as the file where the provider reads PDF files and it fits, else as its face and name", async () => {
  // Before Stage 3 it went as the file to every provider, and all but Anthropic
  // failed the item (planning/pdf-conversion-plan.md, C8 step 5).
  const { name, payload } = await pdfItem({ pdf_text: { pages: 2, chars: 0 } });
  await fs.promises.writeFile(path.join(dirs.galleryDir, name + ".md"), "[Pages 1–2 are scanned and weren't read (OCR is off).]");
  const file = await modelInputFor(dirs, payload, { pdf: READS });
  assert.deepEqual(file.map((p) => p.kind), ["document", "text"], "the file, and no page-1 picture beside it");
  assert.match(file[1].text, /^The item is the PDF document above \("locked\.pdf"\)\. Tag this document using the record_tags tool\.$/);
  assert.deepEqual(file[1].pdf, { as: "file", why: "no readable text" }, "what went and why, for the job row");
  // Extraction has no text to send, and takes the same file in its own words.
  assert.equal(await modelInputForExtract(dirs.galleryDir, payload, READS), null);
  const extract = await modelInputFor(dirs, payload, { mode: "extract", pdf: READS });
  assert.deepEqual(extract.map((p) => p.kind), ["document", "text"]);
  assert.match(textOf(extract), /Extract the requested fields from this document using the record_fields tool\./);

  // A provider that can't read PDF files: its face and name, instead of failing.
  const cant = await modelInputFor(dirs, payload, { pdf: CANT });
  assert.equal(cant.some((p) => p.kind === "document"), false, "never the file");
  assert.ok(imagePart(cant), "its page-1 face rides along");
  assert.match(textOf(cant), /PDF document \("locked\.pdf"\), shown above as a first-page preview, whose text couldn't be read/);
  assert.deepEqual(cant.at(-1).pdf, { as: "picture", why: "no readable text; GLM can't read PDF files" });
  // One that reads them, but not this many pages: the same.
  const long = await modelInputFor(dirs, payload, { pdf: { ...READS, documents: { maxPages: 1 } } });
  assert.deepEqual(long.at(-1).pdf, { as: "picture", why: "no readable text; 2 pages, over Anthropic's 1" });
  // With no view at all — no provider in hand — nothing is assumed to read files.
  assert.equal((await modelInputFor(dirs, payload)).some((p) => p.kind === "document"), false);
});

test("with the switch off, a PDF goes as the file where the provider reads PDF files and it fits, read or not", async () => {
  const off = { ...READS, convert: false };
  for (const extra of [{}, { pdf_text: { pages: 3, chars: 40 } }]) {
    const { payload } = await pdfItem({ ...extra });
    payload.files[0].meta = { pages: 3 };
    for (const parts of [await modelInputFor(dirs, payload, { pdf: off }), await modelInputFor(dirs, payload, { mode: "extract", pdf: off })]) {
      assert.deepEqual(parts.map((p) => p.kind), ["document", "text"], JSON.stringify(extra));
      assert.deepEqual(parts[1].pdf, { as: "file" }, "what the switch says: no why");
    }
    assert.equal(await modelInputForExtract(dirs.galleryDir, payload, off), null, "no text to send: the file goes");
  }
});

test("with the switch off, a PDF the provider can't take as a file goes as its text, or asks for it", async () => {
  const off = { ...CANT, convert: false };
  const { name, payload } = await pdfItem({ pdf_text: { pages: 3, chars: 12 } });
  await fs.promises.writeFile(path.join(dirs.galleryDir, name + ".md"), "Kept text here.");
  const tag = await modelInputFor(dirs, payload, { pdf: off });
  assert.deepEqual(tag.map((p) => p.kind), ["image", "text"], "the text, with the page-1 picture when tagging");
  assert.deepEqual(tag.at(-1).pdf, { as: "text", why: "GLM can't read PDF files" });
  const extract = await modelInputForExtract(dirs.galleryDir, payload, off);
  assert.deepEqual(extract.map((p) => p.kind), ["text"], "extraction: the text alone, as ever");
  assert.match(extract[0].text, /Kept text here\.\n\nExtract the requested fields using the record_fields tool\.$/);
  assert.deepEqual(extract[0].pdf, { as: "text", why: "GLM can't read PDF files" });

  // Not read yet: both steps ask for the text — a wait, not a failure.
  const unread = (await pdfItem()).payload;
  for (const call of [() => modelInputFor(dirs, unread, { pdf: off }), () => modelInputForExtract(dirs.galleryDir, unread, off)]) {
    await assert.rejects(call(), (e) => e.askText === true && e.noCount === true && /GLM can't read PDF files/.test(e.message));
  }
});

test("pdfRoute: one rule for what a PDF goes as, checked top to bottom", () => {
  const anthropic = READS, glm = CANT;
  const files = (meta = { pages: 3 }, size = 1000) => [{ name: "f.pdf", kind: "pdf", size, meta }];
  const unread = { files: files() };
  const read = { files: files(), pdf_text: { pages: 3, chars: 50 } };
  const textless = { files: files(), pdf_text: { pages: 3, chars: 0 } };
  const parked = { files: files(), pdf_text_error: "password" };
  const on = (v) => ({ ...v, convert: true }), off = (v) => ({ ...v, convert: false });
  const cases = [
    // 1. Parked: never the file, whatever the switch or the provider.
    [parked, on(anthropic), { as: "picture", why: "the PDF couldn't be read" }],
    [parked, off(anthropic), { as: "picture", why: "the PDF couldn't be read" }],
    // 2. Off, the provider reads PDF files, and this one fits: the file.
    [read, off(anthropic), { as: "file" }],
    [unread, off(anthropic), { as: "file" }],
    [textless, off(anthropic), { as: "file" }],
    // 3. Kept text: the text — said why when the switch is off.
    [read, on(anthropic), { as: "text" }],
    [read, on(glm), { as: "text" }],
    [read, off(glm), { as: "text", why: "GLM can't read PDF files" }],
    // 4. Unread: on, the claim's race; off, ask for the text.
    [unread, on(anthropic), { as: "wait" }],
    [unread, on(glm), { as: "wait" }],
    [unread, off(glm), { as: "ask", why: "GLM can't read PDF files" }],
    // 5. Read, no text: the file where it fits, else the face and name.
    [textless, on(anthropic), { as: "file", why: "no readable text" }],
    [textless, on(glm), { as: "picture", why: "no readable text; GLM can't read PDF files" }],
    [textless, off(glm), { as: "picture", why: "no readable text; GLM can't read PDF files" }],
    // Fits: pages from the read, else pdfinfo's; none known doesn't fit; size.
    [{ files: files({ pages: 140 }) }, off(anthropic), { as: "ask", why: "140 pages, over Anthropic's 100" }],
    [{ files: files({ pages: 140 }), pdf_text: { pages: 99, chars: 5 } }, off(anthropic), { as: "file" }],
    [{ files: files({ pages: null }) }, off(anthropic), { as: "ask", why: "page count unknown" }],
    [{ files: files({}) }, off(anthropic), { as: "ask", why: "page count unknown" }],
    [{ files: files({ pages: 3 }, 25e6) }, off(anthropic), { as: "ask", why: "25 MB, over Anthropic's 20 MB" }],
    // A size nobody knows doesn't fit either (a legacy entry): the 32 MB request
    // limit is too close to bet the call on it.
    [{ files: [{ name: "f.pdf", kind: "pdf", meta: { pages: 3 } }] }, off(anthropic), { as: "ask", why: "size unknown" }],
    // A limit left out, or null, is no limit.
    [{ files: files({ pages: null }) }, off({ ...anthropic, documents: {} }), { as: "file" }],
    [{ files: files({ pages: 500 }, 25e6) }, off({ ...anthropic, documents: { maxBytes: null, maxPages: null } }), { as: "file" }],
    // Refused: as though it didn't fit, the provider's reason given.
    [read, off({ ...anthropic, refused: "prompt is too long" }), { as: "text", why: "Anthropic refused the file: prompt is too long" }],
    [unread, off({ ...anthropic, refused: "prompt is too long" }), { as: "ask", why: "Anthropic refused the file: prompt is too long" }],
    [textless, on({ ...anthropic, refused: "x" }), { as: "picture", why: "no readable text; Anthropic refused the file: x" }],
  ];
  for (const [payload, view, want] of cases) assert.deepEqual(pdfRoute(payload, view), want, JSON.stringify({ payload, view }));
  assert.deepEqual(pdfRoute(read), { as: "text" }, "no view: the switch's default, on");
});

test("which providers declare PDF files, and their limits; a provider without the block reads none", () => {
  // Stage 3: Anthropic. Stage 5: OpenAI (50 MB a request, no page limit, 35 MB
  // for base64's third), Gemini (50 MB or 1,000 pages) and OpenRouter (the
  // smallest of the vendors it hands a file to, Anthropic's).
  assert.deepEqual(documentsFor({ provider: "anthropic" }), { maxBytes: 20e6, maxPages: 100 });
  assert.deepEqual(documentsFor({ provider: "openai" }), { maxBytes: 35e6 });
  assert.deepEqual(documentsFor({ provider: "gemini" }), { maxBytes: 35e6, maxPages: 1000 });
  assert.deepEqual(documentsFor({ provider: "openrouter" }), { maxBytes: 20e6, maxPages: 100 });
  for (const provider of ["glm", "no-such-provider"]) assert.equal(documentsFor({ provider }), null, provider);
});

test("refusedFile: a 400 or 413 on a call that carried a PDF file, in the provider's own words", () => {
  const doc = [{ kind: "document", mediaType: "application/pdf", b64: "QQ==" }, { kind: "text", text: "x" }];
  // Every wire leaves the provider's own sentence as the message — the
  // Anthropic wire swaps it in for the SDK's status and body (compat.test.js).
  const tooLong = Object.assign(new Error("prompt is too long: 215000 tokens > 200000 maximum"), { status: 400 });
  assert.equal(refusedFile(doc, tooLong), "prompt is too long: 215000 tokens > 200000 maximum");
  assert.equal(refusedFile(doc, Object.assign(new Error("request too large"), { status: 413 })), "request too large");
  assert.equal(refusedFile([{ kind: "text", text: "x" }], tooLong), null, "no file went: not the file's refusal");
  // The account's trouble is a 400 too — an empty balance, a spend limit — and
  // its wire marks it a wait. Not the file's: sent as text it fails the same.
  const broke = Object.assign(new Error("Your credit balance is too low to access the Anthropic API."), { status: 400, noCount: true, retryAfter: 300 });
  assert.equal(refusedFile(doc, broke), null, "the account's 400, not the file's");
  // A billed call clipped (422), a key, a model, a rate limit, an outage: not a refusal of the file.
  for (const status of [401, 404, 408, 422, 429, 500, undefined])
    assert.equal(refusedFile(doc, Object.assign(new Error("e"), { status })), null, `status ${status}`);
});

test("a long PDF's text reaches the model cut and marked, with its unread pages said in place", async () => {
  const skipped = "[Pages 21–40 are scanned and weren't read (OCR limit 20).]";
  const text = `Page one of the report.\n\n${skipped}\n\n${"x".repeat(200000)}`;
  const { name, payload } = await pdfItem({ pdf_text: { pages: 41, chars: text.length - skipped.length } });
  await fs.promises.writeFile(path.join(dirs.galleryDir, name + ".md"), text);
  for (const parts of [await modelInputFor(dirs, payload), await modelInputForExtract(dirs.galleryDir, payload)]) {
    const said = textOf(parts);
    assert.ok(said.includes(`Page one of the report.\n\n${skipped}`), "the unread pages are named where they were");
    assert.ok(said.includes(`[truncated: showing the first 150000 of ${text.length} characters]`), "cut at 150,000, and marked");
  }
});

test("a PDF with neither text nor a parked read waits — the claim's race, not a failure", async () => {
  const { payload } = await pdfItem();
  for (const call of [() => modelInputFor(dirs, payload), () => modelInputForExtract(dirs.galleryDir, payload)]) {
    // No status: a status would read as permanent, and fail the item.
    await assert.rejects(call(), (e) => /waiting for the PDF's text/.test(e.message) && e.noCount === true && e.status === undefined);
  }
});
