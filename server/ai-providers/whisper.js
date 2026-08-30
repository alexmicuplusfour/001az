// The on-server whisper sidecar — its own core, keyless provider (the
// transcription peer of the Xenova embedder). The model is baked into the
// sidecar image at build (the WHISPER_MODEL build arg — a deploy knob, not a
// runtime pick), and the sidecar itself is the only place that names it: the
// worker stamps transcripts from the job payload, and the admin plugins route
// asks its /health for the card's note. Hence the empty transcribes catalog —
// there is nothing to pick, and nothing app-side to keep in sync. Unlike the
// other providers this one is catalog-only: the actual sidecar HTTP call is
// assembled in worker.js (resolveTranscriber, alongside the extractor sidecar
// it shares a failure contract with), so the descriptor keeps `wire: null` and
// never routes through a provider wire.
export default () => ({
  label: "Local Transcriber (Whisper)",
  description: "On-device speech-to-text so recordings can be tagged — no API key",
  wire: null,
  defaultModel: null,
  models: [],
  research: false,
  keyless: true,
  onDevice: true,
  embeds: null,
  // Truthy = advertises transcription (capability gates check `!!transcribes`);
  // empty = the model list isn't the app's to declare — the sidecar reports it.
  transcribes: { default: null, models: [] },
  // …and THIS is how it reports: the sidecar's own /health is the catalog the
  // admin surfaces show (see sidecar-catalog.js, which knows no engine names —
  // it asks whoever declares this). The address lives here beside the rest of
  // the provider's wiring, the way a keyed provider declares its base URL, and
  // worker.js's transcribe calls read it from here too. Lazy so the env is read
  // when asked, not at registry-build time.
  liveCatalog: {
    cap: "transcribe",
    url: () => process.env.TRANSCRIBER_URL || "http://transcriber:3003",
    note: "runs on-server · no API key",
  },
});
