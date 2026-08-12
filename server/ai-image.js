// The AI image input (ai-image-input-plan.md, Slice 1): the rendition the
// TAGGER sees, distinct from the ≤600px q72 card face the grid shows. A vision
// model tags what it can read — a 600px thumb of a 1775px screenshot has
// illegible body text — so this module re-renders the stored original at a
// preset size, clamped by what the resolved provider declares it can accept,
// with a fallback ladder whose floor is the card face: the worst possible
// outcome here is exactly the pre-slice behavior.
//
// Deliberately dependency-light (sharp + fs + the shared decode gate — no db,
// no worker) so its tests are pure and fast, and so the preset table can be
// imported by the capability registry / catalog payloads without dragging the
// pipeline along.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { sharpGate, MAX_DECODE_PIXELS } from "./sharp-gate.js";
// The card face's width cap — a preset clamped to or below it can't beat the
// face it would replace, so it reads the face instead of rendering.
import { THUMB_WIDTH } from "./faces/image-thumb.js";

const DECODE_TIMEOUT_S = 20; // a pathological file must never wedge the gate
const QUALITY_FLOOR = 40; // the byte-cap ladder never encodes below this
// Below this, time spent waiting for the decode gate is scheduler noise rather
// than contention, and reporting it on every row would train a reader to skip
// the field. It is recorded when it MEANS something — the same rule `fallback`
// follows. Contention is also the whole case for the rendition cache
// (ai-image-input-plan.md §8): a cache hit skips the queue as well as the
// render, so "how long did this job sit behind other decodes" is the number
// that decides whether that slice is worth building.
const WAIT_NOTE_MS = 20;

// The one place preset NUMBERS live — render policy only. `edge` is a REQUEST
// (long edge, px) — the provider's declared `images.maxEdge` is the CEILING,
// so `max`'s 4096 simply rides the clamp to each provider's true limit. The
// admin-facing copy (per-preset label + cost hint) lives on the tag
// capability's config def in capabilities.js — that file is pure data the UI
// reads, this one is the pipeline; a drift-pin test holds the two vocabularies
// equal.
// Each entry carries its own id so a resolved preset can say which one it is —
// the job log records the REQUEST beside the outcome, and the outcome alone
// can't answer it (on Anthropic `max` clamps to 1568px, indistinguishable from
// `high`). Duplicating the key is deliberate over deriving it at import: this
// file's whole job is to be readable data. A test pins the two equal.
export const IMAGE_PRESETS = {
  thumb: { id: "thumb", edge: 0, quality: 72 }, // the card face — the kill switch
  standard: { id: "standard", edge: 1024, quality: 80 },
  high: { id: "high", edge: 1568, quality: 82 },
  max: { id: "max", edge: 4096, quality: 85 },
};
export const DEFAULT_PRESET = "high";

// What we assume of a provider that declares no `images` block: every surveyed
// backend accepts ≥2048px and well over 4MB, so this is safe-conservative for
// an unknown plugin. (Survey 2026-08-11: OpenAI minis cap useful input at
// 2048px; Anthropic standard tier 1568px / 10MB base64; Gemini tiles.)
export const GENERIC_IMAGES = { maxEdge: 2048, maxBytes: 4e6 };

// Reported ONCE per unknown id per process. The only way to reach the warn is
// a board still pinned to a preset a later release removed — the app-wide
// default cannot, since capabilityConfig already folds an unknown enum to its
// default before this sees it. Such a board then tags every one of its items
// through here, so a periodic pass over a few thousand of them would write a
// few thousand identical lines and bury the log viewer. Nothing is lost by the
// repeat: every tag job's log row carries `image.preset`, so which boards are
// affected stays answerable per item.
const warnedPresets = new Set();

// A stored preset id → its entry. An unknown id (downgrade, hand-edited row)
// resolves to the default with a warn — never an error; a null/absent id (no
// board pin) resolves silently.
export function resolvePreset(id) {
  const p = id != null ? IMAGE_PRESETS[id] : null;
  if (id != null && !p && !warnedPresets.has(id)) {
    warnedPresets.add(id);
    console.warn(`unknown image preset "${id}" — using "${DEFAULT_PRESET}"`);
  }
  return p || IMAGE_PRESETS[DEFAULT_PRESET];
}

const part = (buf, render) => ({ b64: buf.toString("base64"), mediaType: "image/webp", render });

// The rendition for one image file entry, never throwing for anything short of
// "the thumbnail itself is gone" (which is the pre-slice failure mode and means
// the item's files are genuinely missing — the tag job requeues, correctly).
// `file` is a payload.files entry ({ name, w, h, meta? }); `preset` is a
// resolved IMAGE_PRESETS entry; `images` is the provider descriptor's block.
// Returns { b64, mediaType, render } — `render` is the diagnostics bag
// ({ preset, source, edge?, quality?, bytes, ms, waitMs?, fallback? }) the job log
// records, so "what did the model actually see, and what did it cost" stays
// answerable. `ms` is the WHOLE call including any queue behind the decode
// gate, because that total is what a rendition cache would remove.
export async function aiImageFor({ galleryDir, thumbsDir }, file, { preset = IMAGE_PRESETS[DEFAULT_PRESET], images = GENERIC_IMAGES } = {}) {
  const t0 = Date.now();
  // Set only on the paths that reach the gate; the thumb rungs never queue, so
  // it stays 0 and the field is omitted for them.
  let waitMs = 0;
  const timing = () => ({ ms: Date.now() - t0, ...(waitMs >= WAIT_NOTE_MS ? { waitMs } : {}) });
  // What was ASKED for, recorded beside what was delivered — the outcome alone
  // can't answer it (a clamped `max` and a `high` render identically), and the
  // gap between the two is exactly what a board silently riding the fallback
  // looks like: preset "high", source "thumb".
  const asked = preset.id ? { preset: preset.id } : {};
  const thumbPath = path.join(thumbsDir, file.name + ".webp");
  // The floor. `why` is set only when we got here by falling — and it is
  // logged AFTER the read succeeds, in the past tense, because a message
  // saying we're sending the card face is a lie if the card face is the thing
  // that's missing. A failure here is tagged so the render catch below
  // re-throws it rather than reporting it as a rendition problem and trying
  // the same read a second time.
  const readThumb = async (fallback, why) => {
    const buf = await fs.promises.readFile(thumbPath).catch((err) => {
      err.faceMissing = true;
      throw err;
    });
    if (why) console.warn(`ai image for ${file.name}: ${why} — sent the card face instead`);
    return part(buf, { ...asked, source: "thumb", bytes: buf.length, ...timing(), ...(fallback ? { fallback } : {}) });
  };

  // The clamp: preset request vs provider ceiling. At or below the card face's
  // width the face IS the rendition (the `thumb` preset's edge 0 lands here).
  const target = Math.min(preset.edge, images.maxEdge ?? GENERIC_IMAGES.maxEdge);
  if (target <= THUMB_WIDTH) return readThumb();

  try {
    const original = path.join(galleryDir, file.name);
    // Is the original even bigger than the face? Answer from the stored entry
    // when it carries meta (everything ingested since file fields) — zero I/O —
    // else a sharp header read (legacy entries; no pixel decode). This rung also
    // catches generated connector faces with no special-casing: their galleryDir
    // copy IS the face webp, so original dims == face dims → face.
    let ow = file.meta?.width, oh = file.meta?.height;
    if (!(ow > 0 && oh > 0)) {
      const m = await sharp(original, { pages: 1, limitInputPixels: MAX_DECODE_PIXELS }).metadata();
      ow = m.width; oh = m.height;
    }
    const thumbEdge = Math.max(file.w || 0, file.h || 0) || THUMB_WIDTH;
    if (Math.max(ow, oh) <= thumbEdge) return readThumb();

    // Render + the byte-cap ladder, all inside ONE gate slot: quality −15, then
    // edge ×0.75 — two bounded retries, then the face. `pages: 1` takes a
    // gif/animated-webp's first frame (matching ingest); `.rotate()` bakes EXIF
    // orientation into the pixels (the imageForDetection lesson); fit "inside"
    // caps the LONG edge — providers cap the long edge, unlike the card face's
    // width-only cap. No flatten: webp carries alpha fine.
    const maxBytes = images.maxBytes ?? GENERIC_IMAGES.maxBytes;
    const queuedAt = Date.now();
    const out = await sharpGate(async () => {
      // The gate runs this only when it is our turn, so the delta IS the queue.
      waitMs = Date.now() - queuedAt;
      const render = (edge, quality) =>
        sharp(original, { pages: 1, limitInputPixels: MAX_DECODE_PIXELS })
          .timeout({ seconds: DECODE_TIMEOUT_S })
          .rotate()
          .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
          .webp({ quality })
          .toBuffer({ resolveWithObject: true });
      let edge = target, quality = preset.quality;
      let { data, info } = await render(edge, quality);
      if (data.length > maxBytes) {
        quality = Math.max(QUALITY_FLOOR, quality - 15);
        ({ data, info } = await render(edge, quality));
      }
      if (data.length > maxBytes) {
        edge = Math.round(edge * 0.75);
        ({ data, info } = await render(edge, quality));
      }
      if (data.length > maxBytes) return null;
      return { data, edge: Math.max(info.width, info.height), quality };
    });
    if (!out) return readThumb("byte-cap", `over ${maxBytes}B after quality/size step-down`);
    return part(out.data, { ...asked, source: "original", edge: out.edge, quality: out.quality, bytes: out.data.length, ...timing() });
  } catch (err) {
    // The face IS the fallback, so a failure reading IT is not a rendition
    // problem and there is nothing left to fall back to. Propagate it
    // unchanged — the item's files are genuinely gone and the tag job
    // requeues, which is the pre-slice contract.
    if (err.faceMissing) throw err;
    return readThumb("render-error", err.message);
  }
}
