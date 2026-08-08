// DeepSeek as an ai-provider plugin: tagging against api.deepseek.com through
// its OpenAI-compatible API. No protocol code here — the descriptor rides the
// shared compat wire (ctx.wires.compat), exactly like the built-in OpenAI/GLM
// providers. This is also the reference example of a KEYED, hosted compat
// provider whose vendor diverges from the OpenAI defaults (the Ollama example
// next door covers the keyless self-hosted shape).
//
// Tagging only: DeepSeek publishes no embeddings and no audio endpoint, so
// `embeds`/`transcribes` stay null and semantic search keeps whatever embedder
// is already selected.
//
// Every quirk below was live-probed against the real API on 2026-08-08 — this
// file names no behaviour that wasn't observed, per the same rule the built-in
// GLM descriptor follows.
export default function (ctx) {
  const compat = ctx.wires.compat;
  return {
    label: "DeepSeek",
    description: "DeepSeek V4 models for tagging — TEXT ONLY, no vision. Bring a key.",
    // The shared compat wire, with ONE method wrapped. DeepSeek has no vision
    // model — V4 accepts only `text` content parts and answers any image with
    //   400 … unknown variant `image_url`, expected `text`
    // (verified 2026-08-08 on both v4-flash and v4-pro, in both the OpenAI
    // `image_url` and the Anthropic-style `image` shapes). That is a permanent
    // property of the provider, not a transient fault, so the raw 400 would
    // otherwise be retried — five paid attempts per image, each failing
    // identically, with a serde message that never names the real cause.
    //
    // Wrapping here rather than asking core for a "text-only" flag keeps the
    // whole quirk inside the plugin: the contract lets a descriptor return any
    // wire object, so spreading the shared one and overriding a single method
    // is the sanctioned way to model a divergence the shared wire doesn't. Every
    // other method (testKey, listModels, embed, …) stays core's, one copy.
    wire: {
      ...compat,
      async tag(desc, opts) {
        if (opts.parts?.some((p) => p.kind === "image")) {
          const e = new Error(
            `${desc.label} has no vision model — it can only tag text. Point image boards at a vision-capable tagger (Anthropic, OpenAI, Gemini, OpenRouter).`
          );
          // 422 = permanent-shaped: the queue parks the item on the first
          // attempt instead of re-paying for a failure that cannot change.
          // Same contract the wire's own clipped-output error uses.
          e.status = 422;
          throw e;
        }
        return compat.tag(desc, opts);
      },
    },
    // The `/v1` suffix is DeepSeek's OpenAI-compatibility alias, unrelated to
    // model version — the wire appends /chat/completions and /models to it.
    base: "https://api.deepseek.com/v1",
    // Rate limit: DeepSeek publishes NO RPM figure — it gates by CONCURRENCY
    // (v4-pro 500, v4-flash 2500 simultaneous requests, account-wide across all
    // keys, 429 on exceed, expandable for free on request). So this is not a
    // provider number: a conservative pace, far under any concurrency ceiling
    // given the worker is single-flight anyway. Adjustable on the plugin card.
    rpm: 60, burst: 5,
    // NO `models` list. The picker is served live from DeepSeek's own GET
    // /models (the shared compat wire's listModels, asked per connection with
    // that connection's key), so a model DeepSeek adds or retires appears or
    // drops out with no edit here and no app update. A curated array would only
    // duplicate that answer and then go stale against it.
    //
    // `defaultModel` is the one model id this file names, and it is not a
    // catalog — it is the pre-selection for a picker nobody has touched yet,
    // and the contract requires it of any tagging provider (the loader's
    // validateBuilt). It doubles as the sole option if DeepSeek can't be
    // reached when a picker opens, so the select is never empty. Flash is the
    // pick: cheaper, and it honours all three reasoning_effort levels where pro
    // clamps `low` up to `high`. (deepseek-chat / deepseek-reasoner are
    // deprecated as of 2026-07-24; the V4 pair replaces them.)
    defaultModel: "deepseek-v4-flash",
    research: false, // no server-side web search on the chat-completions path
    keyless: false,
    compat: {
      maxTokensField: "max_tokens", // DeepSeek does not use max_completion_tokens
      // ── Read this block as ONE decision, not five ──────────────────────────
      // `disableThinking` is load-bearing for the three settings under it.
      // V4 models think by default, and in thinking mode DeepSeek rejects any
      // forced tool call with a 400: "Thinking mode does not support this
      // tool_choice". Turning thinking off lifts that restriction — verified
      // both ways on 2026-08-08:
      //     thinking default + tool_choice required  → HTTP 400
      //     thinking off     + tool_choice required  → HTTP 200, tool call made
      //     thinking off     + tool_choice named     → HTTP 200, tool call made
      // So DO NOT flip disableThinking to false without also dropping
      // forceToolChoice back to `false` — they move together, and splitting
      // them fails every tag on the board with a 400.
      //
      // Thinking is worth disabling on its own merits anyway: it bills as
      // output tokens against the tagger's OUTPUT_BUDGET, and hidden reasoning
      // is exactly what clips a tool call mid-JSON on other providers.
      disableThinking: true,
      // With thinking off, the tool call can be FORCED — so tagging never
      // depends on the model volunteering one. "required" rather than the named
      // form: both work here, and with a single tool defined they're the same
      // guarantee, but `required` is what OpenAI's descriptor settled on after
      // the named form started tripping its prompt filter.
      forceToolChoice: "required",
      // `strict` on the function schema is accepted (HTTP 200, valid tool call)
      // against a realistic multi-facet board schema — nested reasoning objects,
      // enums, additionalProperties:false. Same as the OpenAI descriptor.
      strictTools: true,
      // Closed-vocabulary tagging wants the mode, not a sample. Accepted with
      // thinking off; three repeat runs at 0 returned near-identical selections,
      // which is the churn reduction the compat request builder documents.
      temperature: 0,
      // "list" (GET /models) rather than "models" (GET /models/{id}). BOTH work
      // — the per-model GET is undocumented but answers 200 — so this is a
      // robustness choice, not a compatibility one: `defaultModel` is the only
      // model id this file names, and a `models` probe would turn a retired
      // default into a red Test button on a perfectly good key. The index
      // answers "is this key live" without betting on any one model, and the
      // model picker is fed from the same call.
      keyTest: "list",
    },
    embeds: null,      // DeepSeek publishes no /embeddings endpoint
    transcribes: null, // …and no /audio/transcriptions
  };
}
