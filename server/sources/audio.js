// The audio source handler. Stores the original in the gallery store; the card
// face is a waveform rendered by ffmpeg (server/faces/waveform.js) into the
// thumbnail store, so it rides the exact same {webp,w,h}→thumbsDir/<name>.webp
// path as every other face. ffmpeg is a system dependency — no ffmpeg and the
// audio still ingests, just without a waveform (an extension badge instead).
//
// Metadata (duration, bitrate, sample rate, channels, codec) comes from
// music-metadata, which is pure-JS: it lands even when ffmpeg is absent, and is
// testable without any binary. music-metadata parsing also doubles as the type
// gate — bytes that no audio parser recognizes throw, and the file is refused.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { parseFile } from "music-metadata";
import { waveform } from "../faces/waveform.js";
import { storeFace } from "../faces/index.js";

export const manifest = {
  name: "audio",
  label: "Audio files",
  description: "Accept, play & waveform MP3 / M4A / WAV / OGG / FLAC",
  extensions: ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"],
  kinds: ["audio"],
  // Audio runs larger than images/docs — a bigger default (still adjustable per
  // type on the Plugins page, and under the absolute upload ceiling).
  maxBytes: 50 * 1024 * 1024,
};

// The metadata surfaced as audio file fields (server/media/audio.js). music-
// metadata's `format` bag → a flat, stored-on-`meta` projection; anything it
// couldn't determine is null on that instance.
const pickAudioMeta = (fmt = {}) => ({
  duration: fmt.duration != null ? Math.round(fmt.duration) : null, // whole seconds
  bitrate: fmt.bitrate != null ? Math.round(fmt.bitrate) : null, // bits/second
  sample_rate: fmt.sampleRate ?? null, // Hz
  channels: fmt.numberOfChannels ?? null,
  codec: fmt.codec || fmt.container || null,
});

export function audioSource({ galleryDir, thumbsDir }) {
  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

  return {
    // Re-derive size + audio metadata for a legacy entry from the stored file.
    async metaFor(entry) {
      try {
        const p = path.join(galleryDir, entry.name);
        const [stat, meta] = await Promise.all([fs.promises.stat(p), parseFile(p).catch(() => null)]);
        return { size: stat.size, meta: pickAudioMeta(meta?.format) };
      } catch {
        return null;
      }
    },

    // tmpPath -> stored original + waveform face; returns the payload file entry,
    // or null when the bytes aren't audio we can parse. Buffer-free: parseFile
    // streams from disk, ffmpeg reads the path, and the original is copied — so
    // a big upload is never held whole in memory (the droplet is small).
    async ingest(tmpPath, originalName) {
      const ext = (originalName?.match(/\.(\w+)$/)?.[1] || "").toLowerCase();
      if (!manifest.extensions.includes(ext)) return null;
      // music-metadata parses by content — a file whose bytes match no audio
      // parser throws, which is the type gate (the mirror of pdf's %PDF- sniff).
      let meta;
      try {
        meta = await parseFile(tmpPath);
      } catch {
        return null;
      }
      if (!meta?.format?.container && !meta?.format?.codec) return null;
      const { size } = await fs.promises.stat(tmpPath);

      const filename = `${crypto.randomBytes(8).toString("hex")}.${ext}`;
      const entry = {
        name: filename,
        original_name: originalName || filename,
        kind: "audio",
        size,
        meta: pickAudioMeta(meta.format),
      };
      // Optional preview: a render (waveform → null, e.g. no ffmpeg) OR a write
      // failure leaves the card an extension badge and the audio still ingests —
      // never a rejection over a missing waveform (graceful degradation).
      const rendered = await waveform(tmpPath);
      if (rendered) {
        try {
          const { w, h } = await storeFace({ galleryDir, thumbsDir }, filename, rendered);
          entry.w = w;
          entry.h = h;
        } catch (e) {
          console.warn(`audio waveform store failed for ${filename}: ${e.message} (badge)`);
        }
      }

      await fs.promises.copyFile(tmpPath, path.join(galleryDir, filename));
      return entry;
    },
  };
}
