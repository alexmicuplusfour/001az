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
import { startServer, adminSession, seedBoard, req } from "./helpers.js";
import { setPluginState, createAiKey, setSetting, getSetting, oneAudioNeedingTranscription,
  createEntity, insertItem, reprocessEntity } from "../server/db.js";
import { audioSource } from "../server/sources/audio.js";
import { createSources } from "../server/sources/index.js";
import { getFaceProducer } from "../server/faces/index.js";
import { waveform } from "../server/faces/waveform.js";
import { extractFileFields } from "../server/media/index.js";
import { resolveTranscriber, embedTextFor } from "../server/worker.js";
import { transcribeAudio, providerCatalog } from "../server/providers.js";

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

test("resolveTranscriber: with no provider configured, resolves the whisper sidecar and maps its HTTP results", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });

  // A stub db whose settings are all empty → no transcribe_provider → whisper.
  const db = { query: async () => ({ rows: [] }) };
  const eng = await resolveTranscriber(db);
  assert.equal(eng.id, "whisper");
  assert.ok(eng.model, "carries a model for the cache stamp");

  // healthy: POSTs to the sidecar's /transcribe, returns .text
  let seen;
  globalThis.fetch = async (url, opts) => { seen = { url: String(url), opts }; return { ok: true, status: 200, json: async () => ({ text: "hi there" }) }; };
  assert.equal(await eng.transcribe(Buffer.from("x")), "hi there");
  assert.match(seen.url, /\/transcribe$/);
  assert.equal(seen.opts.method, "POST");

  // non-OK carries the HTTP status so the transcription loop can classify it:
  // a 5xx is a transient server fault (back off + retry)...
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(eng.transcribe(Buffer.from("x")), (e) => /transcriber failed/.test(e.message) && e.status === 500);

  // ...a 422 is undecodable input (the loop marks it a permanent transcript_error)
  globalThis.fetch = async () => ({ ok: false, status: 422, json: async () => ({}) });
  await assert.rejects(eng.transcribe(Buffer.from("x")), (e) => e.status === 422);

  // unreachable (deploy blip) → same shape
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(eng.transcribe(Buffer.from("x")), (e) => /transcriber unreachable/.test(e.message) && e.status === undefined);
});

// ── Slice 3: capability-advertised provider transcription ────────────────────

test("providerCatalog advertises transcribes per provider (capability, not a hardcoded list)", () => {
  const cat = Object.fromEntries(providerCatalog().map((p) => [p.name, p]));
  assert.ok(cat.openai.transcribes, "openai advertises transcription");
  assert.equal(cat.openai.transcribes.default, "gpt-4o-transcribe");
  assert.equal(cat.anthropic.transcribes, null, "claude advertises none (no audio modality)");
  assert.ok(cat.whisper.transcribes, "the on-device whisper sidecar advertises transcription");
  assert.equal(cat.local.transcribes, null, "Xenova (local) is the embedder, not the transcriber");
});

test("transcribeAudio (shared compat wire): multipart POST to /audio/transcriptions; error mapping", async (t) => {
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });

  let seen;
  globalThis.fetch = async (url, opts) => { seen = { url: String(url), opts }; return { ok: true, status: 200, json: async () => ({ text: "hi" }) }; };
  const { text } = await transcribeAudio({ provider: "openai", apiKey: "sk", model: "whisper-1", audio: Buffer.from("x"), filename: "clip.mp3" });
  assert.equal(text, "hi");
  assert.match(seen.url, /\/audio\/transcriptions$/);
  assert.equal(seen.opts.method, "POST");
  assert.ok(seen.opts.body instanceof FormData, "sends multipart FormData, not JSON");
  assert.equal(seen.opts.body.get("file").name, "clip.mp3", "the caller's filename (audio extension) reaches the endpoint");
  assert.equal(seen.opts.headers["Content-Type"], undefined, "no JSON content-type — fetch sets the multipart boundary");

  // non-OK → the compat error carries the provider message + HTTP status
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "bad key" } }) });
  await assert.rejects(
    transcribeAudio({ provider: "openai", apiKey: "x", model: "whisper-1", audio: Buffer.from("x") }),
    (e) => /bad key/.test(e.message) && e.status === 401,
  );
});

test("resolveTranscriber: an installed provider with a key resolves a provider engine (capability-gated)", async (t) => {
  const { db, close } = await startServer();
  t.after(close);
  await setPluginState(db, "ai:openai", { installed: true });
  const created = await createAiKey(db, "k", "openai", "sk-test");
  const keyId = created.id ?? created;
  await setSetting(db, "transcribe_provider", "openai");
  await setSetting(db, "transcribe_key_id", String(keyId));

  const eng = await resolveTranscriber(db);
  assert.equal(eng.id, "openai", "engine id is the provider family (the stamp appends :model)");
  assert.equal(eng.model, "gpt-4o-transcribe");

  // its transcribe routes through the openai wire → /audio/transcriptions
  const orig = globalThis.fetch;
  t.after(() => { globalThis.fetch = orig; });
  let seen;
  globalThis.fetch = async (url, opts) => { seen = { url: String(url), opts }; return { ok: true, status: 200, json: async () => ({ text: "spoken words" }) }; };
  assert.equal(await eng.transcribe(Buffer.from("audio")), "spoken words");
  assert.match(seen.url, /\/audio\/transcriptions$/);
});

test("resolveTranscriber: a configured provider with no key falls back to local (never fails)", async (t) => {
  const { db, close } = await startServer();
  t.after(close);
  await setPluginState(db, "ai:openai", { installed: true });
  await setSetting(db, "transcribe_provider", "openai"); // but no transcribe_key_id
  const eng = await resolveTranscriber(db);
  assert.equal(eng.id, "whisper", "no usable key → the always-on sidecar, not an error");
});

test("ai-config POST: a transcribe model the provider doesn't advertise is rejected (400, not stored)", async (t) => {
  const { base, db, close } = await startServer();
  t.after(close);
  const admin = await adminSession(db);
  await setPluginState(db, "ai:openai", { installed: true });
  const created = await createAiKey(db, "k", "openai", "sk-test");
  const keyId = created.id ?? created;

  // A bogus model → 400, and nothing is persisted (the provider stays unset).
  const bad = await req(base, "POST", "/api/admin/ai-config", {
    sid: admin.sid,
    body: { transcribeProvider: "openai", transcribeKeyId: keyId, transcribeModel: "whisper-9-ultra" },
  });
  assert.equal(bad.status, 400);
  assert.equal(await getSetting(db, "transcribe_provider"), null, "the bad request stored nothing");

  // A real advertised model → 200 and it sticks.
  const ok = await req(base, "POST", "/api/admin/ai-config", {
    sid: admin.sid,
    body: { transcribeProvider: "openai", transcribeKeyId: keyId, transcribeModel: "whisper-1" },
  });
  assert.equal(ok.status, 200);
  assert.equal(await getSetting(db, "transcribe_model"), "whisper-1");
});

// ── Transcription is decoupled from tagging (its own loop) ───────────────────

test("oneAudioNeedingTranscription: picks audio lacking a transcript; skips transcribed / errored / non-audio", async (t) => {
  const { db, close } = await startServer();
  t.after(close);
  const board = await seedBoard(db, "transc-queue");
  const ins = async (payload) => {
    const { rows: [{ id }] } = await db.query(
      "INSERT INTO items (board_id, payload, status, created_at, updated_at) VALUES ($1,$2,'held',$3,$3) RETURNING id",
      [board, JSON.stringify(payload), Date.now()]);
    return id;
  };
  await ins({ files: [{ name: "a.mp3", kind: "audio" }], transcript: "already done" });
  await ins({ files: [{ name: "b.mp3", kind: "audio" }], transcript_error: "bad audio" });
  await ins({ files: [{ name: "c.png", kind: "image" }] });
  const need = await ins({ files: [{ name: "d.mp3", kind: "audio" }] });

  const row = await oneAudioNeedingTranscription(db);
  assert.equal(row.id, need, "the one audio item with neither a transcript nor an error");
  assert.equal(row.payload.files[0].name, "d.mp3");
});

test("reprocess clears a transcript_error so a failed transcription retries; a good transcript survives", async (t) => {
  const { db, close } = await startServer();
  t.after(close);
  const board = await seedBoard(db, "reprocess-transc");

  // One clip that failed to transcribe (permanent error) and one that succeeded.
  const badE = await createEntity(db, board, { identity: "bad.mp3" });
  const badItem = await insertItem(db, board, { files: [{ name: "bad.mp3", kind: "audio" }], transcript_error: "undecodable audio" }, "failed", badE);
  const okE = await createEntity(db, board, { identity: "good.mp3" });
  const okItem = await insertItem(db, board, { files: [{ name: "good.mp3", kind: "audio" }], transcript: "hello there" }, "tagged", okE);

  await reprocessEntity(db, badE);
  await reprocessEntity(db, okE);

  const { rows } = await db.query("SELECT id, payload FROM items WHERE id = ANY($1)", [[badItem, okItem]]);
  const p = Object.fromEntries(rows.map((r) => [Number(r.id), r.payload]));
  assert.equal(p[badItem].transcript_error, undefined, "the failed clip's error is cleared → the loop will retry it");
  assert.equal(p[badItem].transcript, undefined, "still no transcript, so it re-queues");
  assert.equal(p[okItem].transcript, "hello there", "a good transcript survives reprocess — no re-billing");

  // Only the cleared clip re-enters the transcription queue (the good one is done).
  const nextUp = await oneAudioNeedingTranscription(db);
  assert.equal(Number(nextUp.id), badItem);
});

test("embedTextFor: an audio transcript is part of the embed text (searchable by speech)", () => {
  const withText = embedTextFor([], {}, { transcript: "the quick brown fox jumps", files: [{ original_name: "clip.mp3" }] });
  assert.match(withText, /quick brown fox/, "the transcript feeds the vector");
  // Untagged audio with no transcript falls back to the filename, as before.
  assert.equal(embedTextFor([], {}, { files: [{ original_name: "clip.mp3" }] }), "clip.mp3");
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
