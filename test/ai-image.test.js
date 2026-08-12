// The AI image input module (ai-image-input-plan.md, Slice 1) — pure tests, no
// server, no Postgres. Fixtures are sharp-generated buffers in a per-file
// tmpdir; thumbs come from the REAL imageThumb so the "mid-size original beats
// the q72 face" branch exercises the actual re-encode. The imageForDetection
// tests in detect.test.js are the template.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  aiImageFor,
  resolvePreset,
  IMAGE_PRESETS,
  DEFAULT_PRESET,
  GENERIC_IMAGES,
} from "../server/ai-image.js";
import { sharpGate } from "../server/sharp-gate.js";
import { imageThumb } from "../server/faces/image-thumb.js";

let root, dirs;
before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ai-image-"));
  dirs = { galleryDir: path.join(root, "gallery"), thumbsDir: path.join(root, "thumbs") };
  fs.mkdirSync(dirs.galleryDir);
  fs.mkdirSync(dirs.thumbsDir);
});
after(() => fs.promises.rm(root, { recursive: true, force: true }));

// A stored original + its real card face + the payload file entry. `noise`
// makes an incompressible original (byte-cap tests); `withMeta: false` builds a
// legacy entry (pre-file-fields, no original-resolution meta).
let seq = 0;
async function fixture(width, height, { format = "png", orientation = null, noise = false, withMeta = true } = {}) {
  const name = `fx${seq++}.${format}`;
  let img;
  if (noise) {
    const raw = crypto.randomBytes(width * height * 3);
    img = sharp(raw, { raw: { width, height, channels: 3 } });
  } else {
    img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });
  }
  img = format === "jpeg" ? img.jpeg({ quality: 95 }) : img.png();
  if (orientation) img = img.withMetadata({ orientation });
  const buf = await img.toBuffer();
  await fs.promises.writeFile(path.join(dirs.galleryDir, name), buf);
  const face = await imageThumb(buf);
  await fs.promises.writeFile(path.join(dirs.thumbsDir, name + ".webp"), face.webp);
  return {
    name,
    kind: "image",
    w: face.w,
    h: face.h,
    ...(withMeta ? { meta: { width, height } } : {}),
  };
}

const decoded = (out) => sharp(Buffer.from(out.b64, "base64")).metadata();
const HIGH = IMAGE_PRESETS.high;

// --- the render path ---

test("landscape 4000x3000 at `high` renders the original to a 1568px long edge", async () => {
  const file = await fixture(4000, 3000);
  const out = await aiImageFor(dirs, file, { preset: HIGH });
  assert.equal(out.render.source, "original");
  assert.equal(out.mediaType, "image/webp");
  const m = await decoded(out);
  assert.equal(m.format, "webp");
  assert.equal(Math.max(m.width, m.height), 1568);
  assert.ok(Math.abs(m.width / m.height - 4000 / 3000) < 0.01, "aspect preserved");
  assert.equal(out.render.edge, 1568);
  assert.equal(out.render.quality, HIGH.quality);
  assert.equal(out.render.bytes, Buffer.from(out.b64, "base64").length);
});

test("portrait 1200x3000: the HEIGHT is the capped edge (long-edge semantics, not the card face's width-only cap)", async () => {
  const file = await fixture(1200, 3000);
  const m = await decoded(await aiImageFor(dirs, file, { preset: HIGH }));
  assert.equal(m.height, 1568);
  assert.ok(m.width < 700, "width scaled with the aspect");
});

test("the provider ceiling clamps the preset request", async () => {
  const file = await fixture(4000, 3000);
  const out = await aiImageFor(dirs, file, { preset: HIGH, images: { maxEdge: 1000, maxBytes: 4e6 } });
  const m = await decoded(out);
  assert.equal(Math.max(m.width, m.height), 1000);
});

test("mid-size 800x500 (above the face, below target) re-encodes the original at native size", async () => {
  const file = await fixture(800, 500);
  const out = await aiImageFor(dirs, file, { preset: HIGH });
  assert.equal(out.render.source, "original");
  assert.equal(out.render.edge, 800); // withoutEnlargement — never upscaled
  const m = await decoded(out);
  assert.equal(m.width, 800);
  assert.equal(m.height, 500);
});

test("EXIF orientation is baked in (orientation-6 jpeg comes out rotated)", async () => {
  const file = await fixture(1000, 800, { format: "jpeg", orientation: 6 });
  const m = await decoded(await aiImageFor(dirs, file, { preset: HIGH }));
  assert.equal(m.width, 800);
  assert.equal(m.height, 1000);
});

// --- the thumb rungs ---

test("an original no bigger than the face passes the face through, deciding from stored meta alone", async () => {
  const file = await fixture(300, 200);
  // Delete the original: rung 3 must answer from file.meta without touching it.
  await fs.promises.unlink(path.join(dirs.galleryDir, file.name));
  const out = await aiImageFor(dirs, file, { preset: HIGH });
  assert.equal(out.render.source, "thumb");
  assert.equal(out.render.fallback, undefined);
  const thumbBytes = await fs.promises.readFile(path.join(dirs.thumbsDir, file.name + ".webp"));
  assert.equal(out.b64, thumbBytes.toString("base64"), "byte-identical to the card face");
});

test("a legacy entry (no meta) still renders via the header read", async () => {
  const file = await fixture(4000, 3000, { withMeta: false });
  const out = await aiImageFor(dirs, file, { preset: HIGH });
  assert.equal(out.render.source, "original");
  assert.equal(Math.max((await decoded(out)).width, (await decoded(out)).height), 1568);
});

test("the `thumb` preset sends the face even for a huge original", async () => {
  const file = await fixture(4000, 3000);
  const out = await aiImageFor(dirs, file, { preset: IMAGE_PRESETS.thumb });
  assert.equal(out.render.source, "thumb");
});

// --- the byte-cap ladder ---

test("an impossible byte cap falls all the way to the face, flagged", async () => {
  const file = await fixture(2000, 1500);
  const out = await aiImageFor(dirs, file, { preset: HIGH, images: { maxEdge: 2048, maxBytes: 1 } });
  assert.equal(out.render.source, "thumb");
  assert.equal(out.render.fallback, "byte-cap");
});

test("a generous byte cap renders without fallback; a just-too-tight one steps down or falls back", async () => {
  const file = await fixture(2000, 1500, { noise: true });
  const generous = await aiImageFor(dirs, file, { preset: HIGH });
  assert.equal(generous.render.source, "original");
  assert.equal(generous.render.fallback, undefined);

  // One byte under the measured size: the ladder must either produce a SMALLER
  // original render (quality or edge stepped down) or land on the face — never
  // ship an over-cap payload. (Exact rung taken varies with libvips version;
  // the invariant is what matters.)
  const cap = generous.render.bytes - 1;
  const tight = await aiImageFor(dirs, file, { preset: HIGH, images: { maxEdge: 2048, maxBytes: cap } });
  if (tight.render.source === "original") {
    assert.ok(tight.render.bytes <= cap, "never over the cap");
    assert.ok(
      tight.render.quality < HIGH.quality || tight.render.edge < generous.render.edge,
      "stepped down to get there"
    );
  } else {
    assert.equal(tight.render.fallback, "byte-cap");
  }
});

// --- failure floors ---

test("a corrupt original falls back to the face, flagged", async () => {
  const file = await fixture(1000, 800, { withMeta: false });
  await fs.promises.writeFile(path.join(dirs.galleryDir, file.name), "not an image at all");
  const out = await aiImageFor(dirs, file, { preset: HIGH });
  assert.equal(out.render.source, "thumb");
  assert.equal(out.render.fallback, "render-error");
});

test("missing original AND missing face propagates (the item's files are genuinely gone)", async () => {
  await assert.rejects(
    aiImageFor(dirs, { name: "ghost.png", kind: "image", w: 600, h: 400 }, { preset: HIGH }),
    /ENOENT/
  );
});

test("a missing face is never reported as a rendition problem, nor read twice", async () => {
  // The face is the floor, so failing to read IT is not "we fell back" — it is
  // "there is nothing to fall back to". The old shape logged
  // "…— sending the thumbnail" and then threw on the very thumbnail it had
  // just promised, having attempted the same read twice.
  const file = await fixture(2000, 1500);
  await fs.promises.unlink(path.join(dirs.thumbsDir, file.name + ".webp"));
  await fs.promises.writeFile(path.join(dirs.galleryDir, file.name), "not an image");

  const warned = [];
  const real = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    await assert.rejects(aiImageFor(dirs, file, { preset: HIGH }), /ENOENT/);
  } finally {
    console.warn = real;
  }
  assert.deepEqual(warned, [], "no claim about a card face that could not be sent");
});

test("a fallback that DID land is logged, once, in the past tense", async () => {
  const file = await fixture(1800, 1200, { withMeta: false });
  await fs.promises.writeFile(path.join(dirs.galleryDir, file.name), "not an image");

  const warned = [];
  const real = console.warn;
  console.warn = (m) => warned.push(String(m));
  let out;
  try {
    out = await aiImageFor(dirs, file, { preset: HIGH });
  } finally {
    console.warn = real;
  }
  assert.equal(out.render.source, "thumb");
  assert.equal(warned.length, 1);
  assert.match(warned[0], /sent the card face instead/);
});

// --- resolvePreset ---

test("the render bag names the preset that was ASKED for, not just what came out", () => {
  // The outcome can't answer "which setting is this board on": a `max` clamped
  // to a 1568px provider ceiling is byte-identical to `high`. And the pairing
  // that matters — asked for high, sent the card face — is only visible when
  // both halves are recorded.
  assert.deepEqual(
    Object.entries(IMAGE_PRESETS).map(([k, p]) => [k, p.id]),
    Object.keys(IMAGE_PRESETS).map((k) => [k, k]),
    "every preset knows its own id"
  );
});

test("a rendition records its preset on every rung, including the fallback", async () => {
  const file = await fixture(2000, 1500);
  assert.equal((await aiImageFor(dirs, file, { preset: IMAGE_PRESETS.max })).render.preset, "max");
  assert.equal((await aiImageFor(dirs, file, { preset: IMAGE_PRESETS.thumb })).render.preset, "thumb");

  // The diagnostic pairing: a board asking for `high` that silently got the
  // ≤600px card face. Without the preset this row reads like a board that
  // chose the thumbnail.
  const broken = await fixture(1800, 1200, { withMeta: false });
  await fs.promises.writeFile(path.join(dirs.galleryDir, broken.name), "not an image");
  const out = await aiImageFor(dirs, broken, { preset: IMAGE_PRESETS.high });
  assert.equal(out.render.preset, "high", "what was asked for");
  assert.equal(out.render.source, "thumb", "what was sent");
  assert.equal(out.render.fallback, "render-error", "and why they differ");
});

test("resolvePreset: every declared id resolves; unknown and absent ids land on the default", () => {
  for (const id of Object.keys(IMAGE_PRESETS)) assert.equal(resolvePreset(id), IMAGE_PRESETS[id]);
  assert.equal(resolvePreset("bogus"), IMAGE_PRESETS[DEFAULT_PRESET]);
  assert.equal(resolvePreset(null), IMAGE_PRESETS[DEFAULT_PRESET]);
  assert.equal(resolvePreset(undefined), IMAGE_PRESETS[DEFAULT_PRESET]);
  assert.ok(IMAGE_PRESETS[DEFAULT_PRESET]);
  assert.ok(GENERIC_IMAGES.maxEdge > 0 && GENERIC_IMAGES.maxBytes > 0);
});

// --- timing: the rendition cache's evidence ---

test("every rendition times itself, and reports the gate queue only when there was one", async () => {
  const file = await fixture(2000, 1500);

  const solo = await aiImageFor(dirs, file, { preset: HIGH });
  assert.equal(typeof solo.render.ms, "number");
  assert.ok(solo.render.ms >= 0);
  assert.equal(solo.render.waitMs, undefined, "an uncontended render reports no queue");

  // The free rung is timed too: that it reads near zero is the evidence the
  // kill switch really is byte-for-byte the old, cheap behaviour.
  const face = await aiImageFor(dirs, file, { preset: IMAGE_PRESETS.thumb });
  assert.equal(face.render.source, "thumb");
  assert.equal(typeof face.render.ms, "number");
  assert.equal(face.render.waitMs, undefined, "the thumb rungs never reach the gate");

  // Hold the gate, then render behind it. This wait is the whole case for the
  // rendition cache (§8) — a cache hit skips the queue as well as the decode —
  // so it has to be measured, not inferred from a sequential benchmark.
  let release;
  const held = sharpGate(() => new Promise((r) => { release = r; }));
  const queued = aiImageFor(dirs, file, { preset: HIGH });
  await new Promise((r) => setTimeout(r, 80));
  release();
  await held;
  const out = await queued;
  assert.ok(out.render.waitMs >= 50, `queued behind the gate (waitMs ${out.render.waitMs})`);
  assert.ok(out.render.ms >= out.render.waitMs, "the total includes the wait");
});

// --- the gate ---

test("sharpGate serializes jobs and survives a rejection mid-chain", async () => {
  const log = [];
  const slow = sharpGate(async () => {
    log.push("a-start");
    await new Promise((r) => setTimeout(r, 50));
    log.push("a-end");
  });
  const failing = sharpGate(async () => {
    log.push("b");
    throw new Error("boom");
  });
  const third = sharpGate(async () => {
    log.push("c");
  });
  await assert.rejects(failing, /boom/);
  await slow;
  await third;
  assert.deepEqual(log, ["a-start", "a-end", "b", "c"]);
});
