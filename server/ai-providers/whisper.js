// The on-server whisper sidecar — its own core, keyless provider (the
// transcription peer of the Xenova embedder). The model is baked into the image
// and set via WHISPER_MODEL at deploy (a build-time knob, not a runtime pick), so
// the single model here is mirrored from the app-side TRANSCRIBER_MODEL env — the
// UI shows it as a note, not a dropdown. Unlike the other providers this one is
// catalog-only: the actual sidecar HTTP call is assembled in worker.js
// (resolveTranscriber, alongside the extractor sidecar it shares a failure
// contract with), so the descriptor keeps `wire: null` and never routes through a
// provider wire.
export default () => ({
  label: "Local Transcriber (Whisper)",
  description: "On-device speech-to-text so recordings can be tagged — no API key",
  wire: null,
  defaultModel: null,
  models: [],
  research: false,
  keyless: true,
  embeds: null,
  transcribes: {
    default: process.env.TRANSCRIBER_MODEL || "base",
    models: [{ id: process.env.TRANSCRIBER_MODEL || "base", note: "runs on-server · no API key · set via WHISPER_MODEL at deploy" }],
  },
});
