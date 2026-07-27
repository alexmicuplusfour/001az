// Local embedding-only provider: on-device ONNX, no API key, no tagger. The
// Xenova pipeline lives HERE, behind a real `wire.embed`, so the engine's
// embedTexts dispatches to it exactly as it does a compat provider — there is no
// `provider === "local"` branch in providers.js. `onDevice` marks it as running
// in-process (no connections to register, no pacing — a big batch isn't
// throttled); `keyless` (implied by onDevice) is the auth half: no secret.
//
// The pipeline (@huggingface/transformers, ONNX, in-process) is lazy-loaded on
// first call and the Promise is cached so concurrent callers all await the same
// initialisation without double-loading.
const LOCAL_EMBED_MODEL = "Xenova/bge-small-en-v1.5";
let _localPipeline = null;
async function localEmbed({ texts }) {
  if (!_localPipeline) {
    const { pipeline } = await import("@huggingface/transformers");
    _localPipeline = pipeline("feature-extraction", LOCAL_EMBED_MODEL, { dtype: "q8" });
  }
  const pipe = await _localPipeline;
  const vectors = [];
  for (const text of texts) {
    const out = await pipe(text, { pooling: "mean", normalize: true });
    vectors.push(new Float32Array(out.data));
  }
  return { vectors, usage: { input: 0, output: 0, cacheRead: 0 } };
}

// Embed-only wire: tag/testKey null (a keyless on-device embedder neither tags
// nor validates a key); embed reads only `texts` from the call opts.
const localWire = { tag: null, testKey: null, embed: (_desc, rest) => localEmbed(rest) };

export default () => ({
  label: "Local Embedder (Xenova)",
  description: "On-device embeddings for search — no API key (transformers.js)",
  wire: localWire,
  defaultModel: null,
  models: [],
  research: false,
  keyless: true,
  onDevice: true,
  embeds: {
    default: LOCAL_EMBED_MODEL,
    models: [{ id: LOCAL_EMBED_MODEL, note: "runs on-server · no API key" }],
  },
});
