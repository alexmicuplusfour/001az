// Audio ingestion (media tier slice 1): the audio source handler stores the
// original + a waveform face, music-metadata fills the audio file fields, and
// the waveform producer is wired into the face registry. Metadata is asserted
// unconditionally (music-metadata is pure-JS — no binary); the waveform face is
// asserted only WHEN it rendered, since ffmpeg is a container dependency and
// these tests run on the host (same graceful-degradation pattern as poppler in
// docs.test.js — no ffmpeg → an extension badge, and the audio still ingests).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, adminSession, seedBoard } from "./helpers.js";
import { audioSource } from "../server/sources/audio.js";
import { createSources } from "../server/sources/index.js";
import { getFaceProducer } from "../server/faces/index.js";
import { waveform } from "../server/faces/waveform.js";
import { extractFileFields } from "../server/media/index.js";
import { documentTextFor } from "../server/worker.js";

// A minimal valid PCM WAV — music-metadata parses it (container/codec/duration/
// sampleRate/channels) with no binary, and it's real audio ffmpeg can draw.
function wavBuffer({ sampleRate = 8000, channels = 1, seconds = 1, bitsPerSample = 16 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = sampleRate * seconds * channels;
  const dataSize = numSamples * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 12000), 44 + i * 2);
  return buf;
}

function tmpDirs(t) {
  const galleryDir = fs.mkdtempSync(path.join(os.tmpdir(), "gal-"));
  const thumbsDir = fs.mkdtempSync(path.join(os.tmpdir(), "thb-"));
  t.after(() => {
    fs.rmSync(galleryDir, { recursive: true, force: true });
    fs.rmSync(thumbsDir, { recursive: true, force: true });
  });
  return { galleryDir, thumbsDir };
}

test("the waveform producer is registered in the face registry", () => {
  assert.equal(typeof getFaceProducer("waveform"), "function");
});

test("documentTextFor yields no text for audio (the future transcription seam)", async () => {
  // Audio falls through to "" — so audio on an AI board skips the extract leg
  // cleanly today, and this is exactly where the transcription slot plugs in.
  assert.equal(await documentTextFor("/nonexistent", { kind: "audio", name: "x.mp3", original_name: "x.mp3" }), "");
});

test("audio ingest: metadata lands; the waveform face degrades gracefully", async (t) => {
  const { galleryDir, thumbsDir } = tmpDirs(t);
  const handler = audioSource({ galleryDir, thumbsDir });
  const tmp = path.join(galleryDir, "in.wav");
  fs.writeFileSync(tmp, wavBuffer({ seconds: 1 }));

  const entry = await handler.ingest(tmp, "clip.wav");
  assert.ok(entry, "audio ingests");
  assert.equal(entry.kind, "audio");
  assert.equal(entry.original_name, "clip.wav");
  assert.ok(fs.existsSync(path.join(galleryDir, entry.name)), "the original is stored");

  // Metadata is deterministic (music-metadata, no binary).
  assert.equal(entry.meta.duration, 1);
  assert.equal(entry.meta.sample_rate, 8000);
  assert.equal(entry.meta.channels, 1);
  assert.ok(entry.meta.codec, "a codec/container was identified");

  // The waveform face is present only when ffmpeg rendered it; when it did, it's
  // the 600px-wide webp the card renders, otherwise the card falls to a badge.
  if (entry.w != null) {
    assert.equal(entry.w, 600);
    assert.ok(entry.h > 0);
    assert.ok(fs.existsSync(path.join(thumbsDir, entry.name + ".webp")), "waveform webp stored");
  } else {
    assert.equal(entry.h, undefined, "no dims without a rendered face (badge)");
  }
});

test("audio ingest: bytes that aren't audio are refused", async (t) => {
  const { galleryDir, thumbsDir } = tmpDirs(t);
  const handler = audioSource({ galleryDir, thumbsDir });
  const tmp = path.join(galleryDir, "fake.mp3");
  fs.writeFileSync(tmp, "this is not audio at all");
  assert.equal(await handler.ingest(tmp, "fake.mp3"), null, "a non-audio .mp3 is rejected");
});

test("createSources dispatches audio extensions to the audio handler", async (t) => {
  const { galleryDir, thumbsDir } = tmpDirs(t);
  const sources = createSources({ galleryDir, thumbsDir });
  t.after(() => sources.close?.());
  const tmp = path.join(galleryDir, "in.wav");
  fs.writeFileSync(tmp, wavBuffer({ seconds: 1 }));
  // forUpload routes an audio extension to the audio handler (the .mp3/.m4a/…
  // → audio mapping is pinned by the extension-uniqueness test in docs.test.js).
  const entry = await sources.forUpload("song.wav").ingest(tmp, "song.wav");
  assert.ok(entry && entry.kind === "audio", "forUpload routed .wav to the audio handler");
});

test("media/audio fields project from the stored meta", () => {
  const entry = {
    name: "x.wav", kind: "audio",
    meta: { duration: 63, bitrate: 128000, sample_rate: 44100, channels: 2, codec: "PCM" },
  };
  const mapping = [
    { key: "duration", from: "file", fn: "duration", kind: "number" },
    { key: "channels", from: "file", fn: "channels", kind: "number" },
    { key: "codec", from: "file", fn: "codec", kind: "text" },
  ];
  const fields = extractFileFields(entry, mapping);
  assert.equal(fields.duration.v, 63);
  assert.equal(fields.channels.v, 2);
  assert.equal(fields.codec.v, "PCM");
  assert.equal(fields.duration.src, "file");
});

test("upload route: a WAV ingests as an audio-kind item", async (t) => {
  const { base, db, close } = await startServer();
  t.after(close);
  const admin = await adminSession(db);
  const board = await seedBoard(db, "audio-board");

  const fd = new FormData();
  fd.append("files", new File([wavBuffer({ seconds: 1 })], "voice.wav", { type: "audio/wav" }));
  const res = await fetch(`${base}/api/upload?board=${board}`, {
    method: "POST",
    headers: { Cookie: `sid=${admin.sid}` },
    body: fd,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rejected.length, 0, "the WAV is accepted");
  assert.equal(body.uploaded[0].kind, "audio");
  assert.equal(body.uploaded[0].label, "voice.wav");
});

// Only meaningful where ffmpeg exists; skipped otherwise so CI without the
// binary stays green (the handler test already covers the degraded path).
test("waveform producer renders a 600px webp (needs ffmpeg)", async (t) => {
  const { galleryDir } = tmpDirs(t);
  const wav = path.join(galleryDir, "tone.wav");
  fs.writeFileSync(wav, wavBuffer({ seconds: 2 }));
  const rendered = await waveform(wav);
  if (!rendered) return t.skip("ffmpeg not installed on this host");
  assert.equal(rendered.w, 600);
  assert.ok(rendered.h > 0);
  assert.ok(Buffer.isBuffer(rendered.webp) && rendered.webp.length > 0);
  // A real webp: RIFF....WEBP magic.
  assert.equal(rendered.webp.subarray(0, 4).toString("latin1"), "RIFF");
  assert.equal(rendered.webp.subarray(8, 12).toString("latin1"), "WEBP");
});
