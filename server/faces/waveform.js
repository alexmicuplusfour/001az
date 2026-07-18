// Audio face producer: a waveform image rendered by ffmpeg's built-in
// `showwavespic` filter (one shot, the audio analogue of poppler's `pdftoppm`
// for a pdf page-1), then transcoded to webp by sharp. ffmpeg is a system
// dependency (ffmpeg in the Dockerfile); without it — or on any render failure —
// this returns null and the card falls back to a badge (the audio still
// ingests, just with no waveform). Takes the path to the audio on disk (ffmpeg
// reads the file, not bytes). Returns { webp, w, h } or null.
//
// Rendered dark-on-white to sit beside the pdf/text page-peeks (text-peek draws
// its glyphs in the same #3a3a40 on #ffffff): showwavespic draws the wave on a
// transparent canvas, so sharp flattens it onto white.
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const W = 600; // matches the image/text face width
const H = 200; // a waveform is wide and short — fills the doc-face preview band
// showwavespic decodes the whole track, so work scales with duration — cap it so
// a pathological/huge file degrades to a badge instead of tying up a worker. The
// default comfortably covers a full 50 MB (~52 min) audio; overrides beyond that
// just fall back to a badge. Env-tunable like the app's other timeouts.
const WAVEFORM_TIMEOUT_MS = Number(process.env.WAVEFORM_TIMEOUT_MS) || 120000;

export async function waveform(audioPath) {
  const out = path.join(os.tmpdir(), "wave-" + crypto.randomBytes(6).toString("hex") + ".png");
  try {
    // aformat→mono downmixes so the picture is one combined wave (not stacked
    // per-channel); showwavespic paints it; -frames:v 1 takes the single frame.
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-i", audioPath,
      "-filter_complex", `aformat=channel_layouts=mono,showwavespic=s=${W}x${H}:colors=0x3a3a40`,
      "-frames:v", "1",
      out,
    ], { timeout: WAVEFORM_TIMEOUT_MS });
    const { data, info } = await sharp(out)
      .flatten({ background: "#ffffff" }) // showwavespic canvas is transparent
      .webp({ quality: 72 })
      .toBuffer({ resolveWithObject: true });
    return { webp: data, w: info.width, h: info.height };
  } catch {
    return null;
  } finally {
    await fs.promises.unlink(out).catch(() => {});
  }
}
