// Local object-detection provider: on-device open-vocabulary detection via the
// SAME @huggingface/transformers ONNX runtime the embedder uses (local.js) — no
// API key, no sidecar, in-process. OWLv2 takes a list of noun-phrase queries and
// returns a box + score + label per detected object, with no per-class training.
// The pipeline is lazy-loaded and its Promise cached so concurrent callers share
// one initialisation, exactly like the embedder. `onDevice` (no pacing, no
// connections) + `keyless` (no secret) — so it rides its own `wire.detect` and
// `detectObjects` dispatches to it like any other provider (there is no
// `provider === "local-detector"` branch in providers.js).
//
// Boxes are normalised to canonical xyxy in 0..1 HERE, at the engine boundary,
// so every downstream consumer gets one coordinate convention regardless of
// engine (a future paid detector's dialect — e.g. Gemini's [ymin,xmin,ymax,xmax]
// on a 0..1000 scale — converts in its own wire, never leaking outward).
const LOCAL_DETECT_MODEL = "Xenova/owlv2-base-patch16-ensemble";
let _detectPipeline = null;
// Inference is serialized through one shared pipeline: extraction runs several
// items wide, but OWLv2's activations are memory-heavy, so concurrent runs would
// contend. detect() calls queue on this chain (the embedder loops sequentially
// for the same reason); a rejection doesn't break the queue.
let _chain = Promise.resolve();

// image: raw encoded bytes (Buffer/Uint8Array — decoded via sharp under RawImage);
// queries: noun phrases to ground; threshold: OWLv2 scores run LOW, so ~0.1 is a
// sane floor (a 0.5 default returns nothing). Returns [{ label, box, score }].
function localDetect(args) {
  const run = _chain.then(() => detectOnce(args));
  _chain = run.then(() => {}, () => {});
  return run;
}

async function detectOnce({ image, queries, threshold = 0.1 }) {
  const labels = (Array.isArray(queries) ? queries : [queries]).filter((q) => typeof q === "string" && q.trim());
  if (!labels.length) return [];
  const { pipeline, RawImage } = await import("@huggingface/transformers");
  if (!_detectPipeline) {
    _detectPipeline = pipeline("zero-shot-object-detection", LOCAL_DETECT_MODEL, { dtype: "q8" });
  }
  const pipe = await _detectPipeline;
  const img = await RawImage.fromBlob(new Blob([image]));
  const out = await pipe(img, labels, { threshold });
  const W = img.width, H = img.height;
  return out.map((d) => ({
    label: d.label,
    score: d.score,
    box: [d.box.xmin / W, d.box.ymin / H, d.box.xmax / W, d.box.ymax / H],
  }));
}

// Detect-only wire: tag/testKey null (a keyless on-device detector neither tags
// nor validates a key); detect reads image + queries (+ threshold) from opts.
const localDetectorWire = { tag: null, testKey: null, detect: (_desc, rest) => localDetect(rest) };

export default () => ({
  label: "Local Object Detector (Transformers.js)",
  description: "On-device open-vocabulary object detection — no API key (transformers.js)",
  wire: localDetectorWire,
  defaultModel: null,
  models: [],
  research: false,
  keyless: true,
  onDevice: true,
  embeds: null,
  transcribes: null,
  detects: {
    default: LOCAL_DETECT_MODEL,
    models: [{ id: LOCAL_DETECT_MODEL, note: "runs on-server · no API key" }],
  },
});
