// Audio face producer: the track drawn as a row of bars, the way audio players
// draw a clip. ffmpeg decodes it to mono PCM, read as it streams so a long track
// is never held whole; the samples fold into one loudness per bar, and the bars
// are an SVG rasterised to webp by sharp, like the price chart. ffmpeg is a
// system dependency (ffmpeg in the Dockerfile); without it — or on any decode or
// render failure — this returns null and the card falls back to a badge (the
// audio still ingests, just with no waveform). Takes the path to the audio on
// disk (ffmpeg reads the file, not bytes). Returns { webp, w, h } or null.
import sharp from "sharp";
import { spawn } from "node:child_process";

const W = 600; // matches the image/text face width
const H = 160; // a waveform is wide and short — shown whole, centred in the card face band

// The bar conventions. The count is the picture's, not the track's: every clip
// gets the same 73 bars, each an equal slice of it, whatever its length. A
// bar's height is its slice's loudness (RMS) — raw peaks pin nearly every
// slice of mastered music at the ceiling — scaled to the clip's loud end, the
// 95th-percentile bar, so one spike can't shrink everything else (the couple
// above it clip). The floor under that reference keeps a near-silent recording
// from being blown up to look loud, and a silent slice still draws as a dot,
// so the row reads as one timeline.
const MARGIN = 20; // keeps the bars off the card's edges, and the lightbox frame's
const BAR = 4;
const BARS = 73;
const PITCH = (W - 2 * MARGIN) / BARS;
const REF_PERCENTILE = 0.95;
const REF_FLOOR = 0.01; // RMS, about -40 dBFS
// --text-dim. The page peek's darker ink suits lines of text; a field of bars
// in it reads as a solid block.
const INK = "#6b6b72";

// Loudness needs no fidelity: 8 kHz mono keeps the decoded stream small, and
// 10 ms blocks give every bar at least one of its own once a clip runs past
// about half a second.
const RATE = 8000;
const BLOCK = RATE / 100;

// Decoding scales with duration — cap it so a pathological/huge file degrades
// to a badge instead of tying up a worker. The default comfortably covers a
// full 50 MB (~52 min) audio. Env-tunable like the app's other timeouts.
const WAVEFORM_TIMEOUT_MS = Number(process.env.WAVEFORM_TIMEOUT_MS) || 120000;

// The track as mean squares per 10 ms block, in order.
function loudnessBlocks(audioPath) {
  return new Promise((resolve, reject) => {
    // -ac 1 downmixes so the bars are one combined track, not stacked channels.
    // stderr is dropped rather than piped: a damaged file can log an error per
    // frame, and an unread pipe that fills stalls ffmpeg until the timeout.
    const ff = spawn("ffmpeg", ["-v", "error", "-i", audioPath, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "pipe:1"],
      { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => ff.kill("SIGKILL"), WAVEFORM_TIMEOUT_MS);
    const blocks = [];
    let rest = Buffer.alloc(0); // a float split across two chunks
    let sum = 0, n = 0;
    ff.stdout.on("data", (chunk) => {
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const end = buf.length - (buf.length % 4);
      for (let i = 0; i < end; i += 4) {
        const v = buf.readFloatLE(i);
        sum += v * v;
        if (++n === BLOCK) { blocks.push(sum / n); sum = 0; n = 0; }
      }
      rest = buf.subarray(end);
    });
    ff.on("error", (e) => { clearTimeout(timer); reject(e); });
    ff.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`));
      if (n) blocks.push(sum / n);
      resolve(blocks);
    });
  });
}

// Each bar's RMS over its share of the blocks. A clip shorter than a block per
// bar repeats blocks rather than leaving holes.
function barLoudness(blocks) {
  const bars = [];
  for (let j = 0; j < BARS; j++) {
    const a = Math.min(blocks.length - 1, Math.floor((j * blocks.length) / BARS));
    const b = Math.max(a + 1, Math.floor(((j + 1) * blocks.length) / BARS));
    let sum = 0;
    for (let i = a; i < b; i++) sum += blocks[i];
    bars.push(Math.sqrt(sum / (b - a)));
  }
  return bars;
}

export async function waveform(audioPath) {
  try {
    const blocks = await loudnessBlocks(audioPath);
    if (!blocks.length) return null;
    const bars = barLoudness(blocks);
    const ref = Math.max(REF_FLOOR, [...bars].sort((x, y) => x - y)[Math.floor(REF_PERCENTILE * BARS)]);
    // Mirrored about the midline, rounded ends, each bar centred on its pitch.
    const rects = bars.map((v, j) => {
      const h = Math.max(BAR, Math.min(1, v / ref) * (H - 2 * MARGIN));
      return `<rect x="${(MARGIN + j * PITCH + (PITCH - BAR) / 2).toFixed(1)}" y="${((H - h) / 2).toFixed(1)}" width="${BAR}" height="${h.toFixed(1)}" rx="${BAR / 2}"/>`;
    }).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#ffffff"/>
      <g fill="${INK}">${rects}</g>
    </svg>`;
    const webp = await sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
    return { webp, w: W, h: H };
  } catch {
    return null;
  }
}
