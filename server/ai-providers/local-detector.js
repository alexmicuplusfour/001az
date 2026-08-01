// The on-server object-detection sidecar — its own core, keyless provider (the
// object-detection peer of the whisper transcriber). The model (LLMDet by
// default) is baked into the `object-detector` sidecar image at build
// (OBJECT_DETECTOR_MODEL — a deploy knob, not a runtime pick), and the sidecar
// itself is the only place that runs it. Catalog-only: the actual /detect HTTP
// call is assembled in worker.js (resolveDetector → objectDetectorSidecar,
// alongside the extractor/transcriber sidecars it shares a failure contract
// with), so the descriptor keeps `wire: null` and never routes through a provider
// wire. Mirrors whisper.js exactly.
export default () => ({
  label: "Local Object Detector (LLMDet)",
  description: "On-device open-vocabulary object detection so images can be searched by object — no API key",
  wire: null,
  defaultModel: null,
  models: [],
  research: false,
  keyless: true,
  onDevice: true,
  embeds: null,
  transcribes: null,
  // Truthy = advertises detection (capability gates check `!!detects`); the model
  // is the sidecar's baked default, shown as the card note.
  detects: {
    default: "iSEE-Laboratory/llmdet_tiny",
    models: [{ id: "iSEE-Laboratory/llmdet_tiny", note: "runs in the object-detector sidecar · no API key" }],
  },
});
