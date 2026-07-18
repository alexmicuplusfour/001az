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
import { setPluginState } from "../server/db.js";
import { audioSource } from "../server/sources/audio.js";
import { createSources } from "../server/sources/index.js";
import { getFaceProducer } from "../server/faces/index.js";
import { waveform } from "../server/faces/waveform.js";
import { extractFileFields } from "../server/media/index.js";
import { documentTextFor, resolveTranscriber } from "../server/worker.js";

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

// A deterministic stub engine: counts transcribe() calls and returns a fixed
// transcript, so cache hits/misses are observable without a real sidecar.
function stubTranscriber(text = "hello world", { id = "local", model = "base" } = {}) {
  const eng = { id, model, calls: 0, async transcribe() { eng.calls++; return text; } };
  return eng;
}

test("documentTextFor(audio): transcribes, returns text, writes a stamped .txt cache", async (t) => {
  const { galleryDir: dir } = tmpDirs(t);
  fs.writeFileSync(path.join(dir, "a.mp3"), "raw-audio-bytes");
  const eng = stubTranscriber("The quick brown fox.");
  const file = { kind: "audio", name: "a.mp3", original_name: "clip.mp3" };

  assert.equal(await documentTextFor(dir, file, eng), "The quick brown fox.");
  assert.equal(eng.calls, 1);
  assert.equal(
    fs.readFileSync(path.join(dir, "a.mp3.txt"), "utf8"),
    "# engine: local:base\n\nThe quick brown fox.",
    "cache carries the engine stamp then the transcript",
  );
});

test("documentTextFor(audio): a second call on the same engine hits the cache (no re-transcribe)", async (t) => {
  const { galleryDir: dir } = tmpDirs(t);
  fs.writeFileSync(path.join(dir, "a.mp3"), "raw");
  const eng = stubTranscriber("cached line");
  const file = { kind: "audio", name: "a.mp3", original_name: "clip.mp3" };

  assert.equal(await documentTextFor(dir, file, eng), "cached line");
  assert.equal(await documentTextFor(dir, file, eng), "cached line");
  assert.equal(eng.calls, 1, "the second read came from the cache");
});

test("documentTextFor(audio): a cache from a DIFFERENT engine is ignored and re-transcribed", async (t) => {
  const { galleryDir: dir } = tmpDirs(t);
  fs.writeFileSync(path.join(dir, "a.mp3"), "raw");
  // A stale cache produced by a different model — the flexibility guard.
  fs.writeFileSync(path.join(dir, "a.mp3.txt"), "# engine: local:small\n\nold transcript");
  const eng = stubTranscriber("fresh transcript", { model: "base" });
  const file = { kind: "audio", name: "a.mp3", original_name: "clip.mp3" };

  assert.equal(await documentTextFor(dir, file, eng), "fresh transcript", "different stamp → re-transcribed");
  assert.equal(eng.calls, 1);
  assert.equal(
    fs.readFileSync(path.join(dir, "a.mp3.txt"), "utf8"),
    "# engine: local:base\n\nfresh transcript",
    "the cache is re-stamped with the producing engine",
  );
});

test("documentTextFor(audio): an empty transcript is a real answer — cached, not re-run", async (t) => {
  const { galleryDir: dir } = tmpDirs(t);
  fs.writeFileSync(path.join(dir, "a.mp3"), "raw");
  const eng = stubTranscriber(""); // a genuinely speechless clip
  const file = { kind: "audio", name: "a.mp3", original_name: "silence.mp3" };

  assert.equal(await documentTextFor(dir, file, eng), "");
  assert.equal(await documentTextFor(dir, file, eng), "");
  assert.equal(eng.calls, 1, "empty transcript is cached like any other");
  assert.equal(fs.readFileSync(path.join(dir, "a.mp3.txt"), "utf8"), "# engine: local:base\n\n");
});

test("documentTextFor(audio): transcriber downtime throws status-less (requeue, never empty)", async (t) => {
  const { galleryDir: dir } = tmpDirs(t);
  fs.writeFileSync(path.join(dir, "a.mp3"), "raw");
  const eng = { id: "local", model: "base", async transcribe() { throw new Error("transcriber unreachable (ECONNREFUSED) — will retry"); } };
  const file = { kind: "audio", name: "a.mp3", original_name: "clip.mp3" };

  await assert.rejects(
    documentTextFor(dir, file, eng),
    (e) => /transcriber unreachable/.test(e.message) && e.status === undefined,
  );
  assert.equal(fs.existsSync(path.join(dir, "a.mp3.txt")), false, "no cache written on failure");
});

test("resolveTranscriber: v1 resolves the always-on local sidecar and maps its HTTP results", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  const eng = await resolveTranscriber(null); // v1 ignores db/board
  assert.equal(eng.id, "local");
  assert.ok(eng.model, "carries a model for the cache stamp");

  // healthy: POSTs to the sidecar's /transcribe, returns .text
  let seen;
  globalThis.fetch = async (url, opts) => { seen = { url: String(url), opts }; return { ok: true, status: 200, json: async () => ({ text: "hi there" }) }; };
  assert.equal(await eng.transcribe(Buffer.from("x")), "hi there");
  assert.match(seen.url, /\/transcribe$/);
  assert.equal(seen.opts.method, "POST");

  // non-OK → status-less throw so failOrRequeue waits it out
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(eng.transcribe(Buffer.from("x")), (e) => /transcriber failed/.test(e.message) && e.status === undefined);

  // unreachable (deploy blip) → same shape
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(eng.transcribe(Buffer.from("x")), (e) => /transcriber unreachable/.test(e.message) && e.status === undefined);
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

test("upload route: a file over its per-type limit is rejected with a reason", async (t) => {
  const { base, db, close } = await startServer();
  t.after(close);
  const admin = await adminSession(db);
  const board = await seedBoard(db, "audio-limit-board");
  // Drop the audio limit below this WAV so admitFile's size gate fires on the
  // /api/upload path (the real user-facing leg of Slice 0's per-type limit) and
  // surfaces err.reason into rejected[].reason — not just the folder walk.
  await setPluginState(db, "media:audio", { config: { maxBytes: 4096 } });

  const fd = new FormData();
  fd.append("files", new File([wavBuffer({ seconds: 1 })], "big.wav", { type: "audio/wav" }));
  const res = await fetch(`${base}/api/upload?board=${board}`, {
    method: "POST",
    headers: { Cookie: `sid=${admin.sid}` },
    body: fd,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.uploaded.length, 0, "the over-limit file is not admitted");
  assert.equal(body.rejected.length, 1);
  assert.equal(body.rejected[0].name, "big.wav");
  assert.match(body.rejected[0].reason, /larger than .* limit for its type/i);
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
