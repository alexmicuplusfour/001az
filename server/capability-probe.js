// Capability probes (capabilities-plan.md, slice 2b) — the "does this actually
// work end to end" button behind /api/admin/capabilities/:id/probe. (The four
// legacy *-test routes that first delegated here were deleted in 7b.)
//
// One entry per capability, holding the ONE thing that genuinely differs: the
// sample input. Everything around it — resolve, call, report which provider and
// model answered, turn a failure into a readable 400 — is shared.
//
// A probe answers with { ok, provider, model, ... }, or throws. Callers map a
// throw to a 400: the point of the button is to make the failure legible, so the
// provider's own message is the payload.
import sharp from "sharp";
import { testKey, embedTexts } from "./providers.js";
import { withPluginHealth, APP_SCOPE } from "./db.js";
import { meterAiCall } from "./metering.js";
import { resolveDefaultAi, resolveEmbedder, resolveTranscriber, resolveDetector } from "./worker.js";
import { sidecarDefaultModel } from "./sidecar-catalog.js";

const bad = (message) => Object.assign(new Error(message), { status: 400 });

// A ~0.25s 8 kHz mono PCM WAV of a quiet tone — small, valid audio for a
// reachability probe. The endpoint accepts it and returns (transcript is
// usually empty; a 200 is the signal that key + model + endpoint all work).
function tinyWav() {
  const sr = 8000, n = 2000, bytes = n * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF", 0); b.writeUInt32LE(36 + bytes, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 6) * 6000), 44 + i * 2);
  return b;
}

// A tiny solid image — small, valid pixels for a reachability probe. LLMDet finds
// nothing in a blank image, so a 200 with a count is the signal it works.
const tinyImage = () =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();

const PROBES = {
  // Tagging and embeddings probe the BINDING: resolve credentials, make one
  // cheap call through the dispatcher, under the plugin-health ledger.
  tag: async (db) => {
    const ai = await resolveDefaultAi(db);
    if (!ai) throw bad("No default API key configured");
    await withPluginHealth(db, `ai:${ai.provider}`, () => testKey(ai));
    return { provider: ai.provider, model: ai.model };
  },
  embed: async (db) => {
    const em = await resolveEmbedder(db);
    if (!em) throw bad("semantic search is not enabled/configured");
    const { usage } = await withPluginHealth(db, `ai:${em.provider}`, () => embedTexts({ ...em, texts: ["ping"] }));
    // A probe is a paid call too — one request, a few tokens, filed at the
    // app scope: no board asked for it (metering-plan.md Stage 5a).
    await meterAiCall(db, APP_SCOPE, { capability: "embed", provider: em.provider, model: em.model }, usage);
    return { provider: em.provider, model: em.model };
  },
  // Transcription and detection probe the ENGINE, which always resolves — so
  // neither has a "not configured" case. The engine wraps itself in the health
  // ledger already (the sidecar floors have none, by design).
  transcribe: async (db) => {
    const t = await resolveTranscriber(db);
    // The deadline keeps this admin-facing probe from waiting behind a long job —
    // the sidecar's express lane answers tiny clips in seconds when healthy.
    const { usage } = await t.transcribe(tinyWav(), "probe.wav", { deadlineMs: 30000 });
    // A probe is a paid call too — filed at the app scope like the embed ping
    // above, through the same projection. Its quarter-second WAV rounds to
    // zero seconds, so this spend is purely call-shaped (Stage 5b).
    await meterAiCall(db, APP_SCOPE, { capability: "transcribe", provider: t.id, model: t.model }, usage);
    return { provider: t.id, model: t.model };
  },
  detect: async (db) => {
    const d = await resolveDetector(db);
    const { objects, usage } = await d.detect(await tinyImage(), ["object."]);
    // A probe is a paid call too — one image, filed at the app scope like the
    // embed and transcribe pings above. This was the last probe still spending
    // invisibly (Stage 5c closes the gap 5a opened).
    //
    // Metered against `d.model`, NOT the live `model` resolved below: the
    // extract leg has no cheap way to ask /health per item, so it meters the
    // descriptor's spelling. Recording the other one here would split one
    // engine across two rows — and two rows price separately, since the rate
    // table is keyed on (provider, model). The live answer's job is display.
    await meterAiCall(db, APP_SCOPE, { capability: "detect", provider: d.id, model: d.model },
      usage, { images: 1 });
    // An on-device engine's model is baked into its sidecar image — report what
    // /health says so the toast can't drift from the served model. A provider
    // that isn't sidecar-backed answers null and keeps the model it named on
    // its descriptor, so there is nothing here to test against first.
    const model = (await sidecarDefaultModel(d.id)) || d.model;
    return { provider: d.id, model, count: objects.length };
  },
};

// Which capabilities have a probe — the status payload carries this so the
// page renders Test buttons from data instead of hardcoding four ids. (Deleted
// once as dead code; the page is the consumer it was waiting for.)
export const probeable = (capId) => !!PROBES[capId];

export async function probeCapability(db, capId) {
  const probe = PROBES[capId];
  if (!probe) throw bad(`"${capId}" has nothing to probe`);
  return { ok: true, ...(await probe(db)) };
}
