// The OpenAI-compatible wire family: plain fetch to /chat/completions,
// /embeddings, and /audio/transcriptions. One protocol, many vendors — OpenAI,
// Gemini, GLM, OpenRouter, and any compat plugin all ride this code; they
// differ only in descriptor data (base URL + the `compat` quirk block).
// Everything compat-protocol-specific lives HERE; the engine (providers.js)
// only composes this into WIRES and dispatches through descriptor.wire.
// compatRequest is exported as the pure request-builder test seam — it reads
// the quirk block it's handed and never touches the registry.
import { DEFAULT_TOOL, outputBudget, clippedError } from "./tool.js";

// A keyless connection (a self-hosted Ollama, …) carries no secret — send no
// Authorization header at all rather than a literal "Bearer null". A keyless
// provider MAY still get a token (e.g. a reverse proxy in front of the box);
// when one is stored it's sent like any other. Exported as a test seam.
export const compatHeaders = (apiKey) => ({
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  "Content-Type": "application/json",
});
// Outbound deadlines — raw fetch has no total bound (undici caps response
// headers at ~5 min; a trickling body never times out), and a hung call wedges
// the worker's single-flight tick. The Anthropic wire needs none of this: the
// SDK defaults to a 10-min per-try timeout. Env-tunable, read per call.
const chatSignal = () => AbortSignal.timeout(Number(process.env.AI_CHAT_TIMEOUT_MS) || 180000);
const embedSignal = () => AbortSignal.timeout(Number(process.env.AI_EMBED_TIMEOUT_MS) || 60000);
// Transcription is slow (minutes for a long clip) — a generous default, like the
// local sidecar's timeout; env-tunable per call.
const transcribeSignal = () => AbortSignal.timeout(Number(process.env.AI_TRANSCRIBE_TIMEOUT_MS) || 240000);
const keyTestSignal = () => AbortSignal.timeout(30000); // admin Test button — interactive, fail fast

// A failed compat response, turned into a readable error. OpenRouter buries
// the useful upstream detail under error.metadata.raw and leaves error.message
// as a generic "Provider returned error", so prefer the raw when present; other
// providers only have message. The HTTP status (and Retry-After, when sent)
// ride on the error so the queue can tell a rate limit from a bad request —
// the Anthropic SDK's errors carry .status already; this brings the compat
// wire up to par.
async function compatError(r, label) {
  const body = await r.json().catch(() => ({}));
  const msg = body.error?.metadata?.raw || body.error?.message;
  const err = new Error(msg || `${label} HTTP ${r.status}`);
  err.status = r.status;
  const ra = r.headers?.get?.("retry-after");
  if (ra != null) err.retryAfter = ra;
  return err;
}

// OpenAI-compatible chat-completions request. A forced function call mirrors
// the Anthropic tool shape and the same strict JSON schema works — but the
// per-provider quirks (which max-tokens field, whether the tool call is forced
// or left auto, whether `strict` is accepted, whether thinking must be turned
// off) are read as data from the `compat` quirk block passed in (the
// descriptor's), not branched on a provider name. See the GLM descriptor for
// why each knob exists.
export function compatRequest({ compat, model, systemText, schema, parts, tool = DEFAULT_TOOL }) {
  const content = parts.map((p) =>
    p.kind === "image"
      ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.b64}` } }
      : { type: "text", text: p.text }
  );
  return {
    model,
    // Sized to the schema (a floor when small). Reasoning models (gpt-5
    // family) burn INVISIBLE thinking tokens from this same budget — a
    // hardcoded 2048 could come back finish_reason:"length" with nothing
    // visible on an ordinary board.
    [compat.maxTokensField]: outputBudget(schema),
    ...(compat.disableThinking ? { thinking: { type: "disabled" } } : {}),
    // Closed-vocabulary classification wants the mode, not a sample. Measured
    // 2026-08-06 on gpt-5.4-mini: re-tagging the same item with the same prompt
    // changed 22.4% of facet answers at the API default (1.0) and 18.3% at 0 —
    // 4 points of pure churn for nothing. (The remaining 18% is the reasoning
    // model's own decode variance; temperature does not touch it.)
    //
    // Quirk data, not a global: `noTemperature` is a model-id regex for
    // families that REJECT the parameter. OpenAI's o-series 400s on it
    // ("Unsupported value: 'temperature' does not support 0 with this model")
    // and o-ids pass the tagging modelFilter, so a blanket send would
    // permanently fail every item on a board using one. Live-probed
    // 2026-08-06: gpt-5.4-mini/gpt-5.1/gemini-3.5-flash accept, o3 rejects.
    ...(compat.temperature !== undefined &&
        !(compat.noTemperature && new RegExp(compat.noTemperature).test(model))
          ? { temperature: compat.temperature } : {}),
    messages: [
      { role: "system", content: systemText },
      { role: "user", content },
    ],
    tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: schema, ...(compat.strictTools ? { strict: true } : {}) } }],
    // forceToolChoice is three-valued: true names the function, "required"
    // demands SOME tool call (equivalent here — the compat path only ever
    // defines one), false leaves auto (GLM). OpenAI moved to "required" on
    // 2026-07-29: gpt-5-family models began rejecting the NAMED force as
    // invalid_prompt ("flagged as potentially violating our usage policy") —
    // bisected live; auto and required pass, the name-check throw downstream
    // still guards the auto-ish paths.
    tool_choice: compat.forceToolChoice === "required" ? "required"
      : compat.forceToolChoice ? { type: "function", function: { name: tool.name } }
      : "auto",
  };
}

// The endpoint root for one call: the connection's own server URL when it
// carries one (self-hosted providers — `needsBase` descriptors), else the
// descriptor default. Rides the per-call opts like apiKey does, NOT ctx/desc:
// two connections of one provider can point at two boxes.
const baseOf = (desc, base) => base || desc.base;

// Network-level failures (refused, timeout, DNS) surface from undici as a bare
// "fetch failed" TypeError with the useful part buried in .cause. Rethrow with
// the cause code and the target URL visible, so an admin's Test (and the
// health ledger) says "ECONNREFUSED http://…" instead of shrugging —
// load-bearing for self-hosted connections, where a wrong IP/port/firewall is
// the common failure. HTTP-level errors never reach this (compatError).
async function compatFetch(label, url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    const code =
      e.cause?.code || e.cause?.errors?.[0]?.code ||
      // "timeout" verbatim — the deadline contract is pinned by tests matching
      // /timeout|abort/ on a hung-provider failure (embed-sweep).
      (e.name === "TimeoutError" || e.cause?.name === "TimeoutError" ? "timeout" : null) ||
      e.cause?.message; // e.g. undici's "bad port" — anything beats the outer "fetch failed"
    throw new Error(`${label}: ${code || e.message} — ${url}`);
  }
}

export const compatWire = {
  async tag(desc, { apiKey, model, systemText, schema, parts, base, tool = DEFAULT_TOOL }) {
    // Document blocks are Anthropic-only: the chat-completions path has no PDF
    // input. Fail loud with the fix, rather than degrading silently.
    if (parts.some((p) => p.kind === "document"))
      throw new Error(`${desc.label} taggers can't read PDF documents — use an Anthropic tagger for this board`);
    const r = await compatFetch(desc.label, `${baseOf(desc, base)}/chat/completions`, {
      method: "POST",
      headers: compatHeaders(apiKey),
      body: JSON.stringify(compatRequest({ compat: desc.compat, model, systemText, schema, parts, tool })),
      signal: chatSignal(),
    });
    if (!r.ok) throw await compatError(r, desc.label);
    const data = await r.json();
    const choice = data.choices?.[0];
    // Output-cap check FIRST: a length-clipped turn otherwise surfaces as
    // "model did not call X" or a JSON parse error on half-written arguments
    // — both misdirect, and both retry a deterministic failure.
    if (choice?.finish_reason === "length") throw clippedError(outputBudget(schema));
    // Find the call BY NAME, like the Anthropic wire: a provider whose tool
    // choice can't be forced (GLM is auto-only) may invent another function,
    // and taking whatever came first would accept tag-shaped args as
    // extraction input — fields silently empty, logged ok. Same error shape
    // as the Anthropic wire's missing-call throw.
    const call = (choice?.message?.tool_calls || []).find((c) => c.function?.name === tool.name);
    if (!call) throw new Error(`model did not call ${tool.name}`);
    const u = data.usage || {};
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    return {
      input: JSON.parse(call.function.arguments),
      usage: {
        // prompt_tokens includes cached ones; pull those out to match Anthropic
        input: Math.max((u.prompt_tokens || 0) - cached, 0),
        output: u.completion_tokens || 0,
        cacheRead: cached,
      },
    };
  },

  async testKey(desc, { apiKey, model, base }) {
    const id = model || desc.defaultModel;
    // "completion": a one-token chat call (for providers with no models
    // endpoint — GLM). "models": a cheap GET on the model id. "list": GET the
    // models INDEX — proves the box is up and talking without requiring any
    // particular model to exist. The self-hosted shape (Ollama): what's pulled
    // varies per box and the picker already shows it, so a per-model probe
    // answering "model not found" on a healthy box reads as breakage. All
    // three surface the provider's own error message.
    if (desc.compat.keyTest === "list") {
      const r = await compatFetch(desc.label, `${baseOf(desc, base)}/models`, { headers: compatHeaders(apiKey), signal: keyTestSignal() });
      if (!r.ok) throw await compatError(r, desc.label);
      return;
    }
    if (desc.compat.keyTest === "completion") {
      const r = await compatFetch(desc.label, `${baseOf(desc, base)}/chat/completions`, {
        method: "POST",
        headers: compatHeaders(apiKey),
        body: JSON.stringify({
          model: id,
          [desc.compat.maxTokensField]: 1,
          ...(desc.compat.disableThinking ? { thinking: { type: "disabled" } } : {}),
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: keyTestSignal(),
      });
      if (!r.ok) throw await compatError(r, desc.label);
      return;
    }
    const r = await compatFetch(desc.label, `${baseOf(desc, base)}/models/${encodeURIComponent(id)}`, { headers: compatHeaders(apiKey), signal: keyTestSignal() });
    if (!r.ok) throw await compatError(r, desc.label);
  },

  // List the models this connection can use right now — GET {base}/models, the
  // listing form of the keyTest probe. Returns [{ id }] (the compat schema
  // carries nothing else useful; OpenAI's is bare ids). A provider with no
  // models endpoint at all (GLM) says so in its quirk block and returns null —
  // the engine serves the descriptor's curated fallback instead. Distinct from
  // keyTest: "completion" ≠ no listing (OpenRouter lists fine, it just has no
  // per-model GET). stripListPrefix: Gemini's compat layer lists ids as
  // "models/gemini-…" while its chat endpoint (and our curated lists) use the
  // bare id — the quirk normalizes so the merge and filters see one spelling.
  async listModels(desc, { apiKey, base }) {
    if (desc.compat.listModels === false) return null;
    const r = await fetch(`${baseOf(desc, base)}/models`, { headers: compatHeaders(apiKey), signal: keyTestSignal() });
    if (!r.ok) throw await compatError(r, desc.label);
    const data = await r.json();
    const rows = Array.isArray(data.data) ? data.data : [];
    const strip = desc.compat.stripListPrefix;
    return rows
      .map((m) => {
        const id = String(m.id || "");
        return { id: strip && id.startsWith(strip) ? id.slice(strip.length) : id };
      })
      .filter((m) => m.id);
  },

  // Embed a batch of texts. Returns { vectors: Float32Array[], usage } with
  // every vector L2-normalized, so similarity is a plain dot product.
  async embed(desc, { apiKey, model, texts, base }) {
    const r = await compatFetch(desc.label, `${baseOf(desc, base)}/embeddings`, {
      method: "POST",
      headers: compatHeaders(apiKey),
      body: JSON.stringify({ model, input: texts }),
      signal: embedSignal(),
    });
    if (!r.ok) throw await compatError(r, desc.label);
    const data = await r.json();
    const rows = (data.data || []).slice().sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length) throw new Error(`${desc.label} returned ${rows.length} embeddings for ${texts.length} inputs`);
    const vectors = rows.map((d) => {
      const v = Float32Array.from(d.embedding);
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= norm;
      return v;
    });
    return { vectors, usage: { input: data.usage?.prompt_tokens || 0, output: 0, cacheRead: 0 } };
  },

  // Transcribe audio → text (OpenAI-style POST /audio/transcriptions, multipart).
  // The parallel to embed: any compat-family provider whose backend exposes this
  // endpoint opts in by setting `transcribes` on its descriptor — the generic
  // path never names a provider. Returns { text, usage }; usage is per-audio
  // (not tokens), left zero — transcription billing isn't tracked yet.
  async transcribe(desc, { apiKey, model, audio, filename, base }) {
    const form = new FormData();
    form.append("model", model || desc.transcribes.default);
    // The multipart filename's EXTENSION is load-bearing: OpenAI validates the
    // audio format from it, and rejects an extensionless name. Callers pass the
    // stored <hex>.<ext> name; the fallback is only for a bare reachability probe.
    form.append("file", new Blob([audio]), filename || "audio.wav");
    const r = await compatFetch(desc.label, `${baseOf(desc, base)}/audio/transcriptions`, {
      method: "POST",
      // NOT compatHeaders — FormData sets its own multipart Content-Type + boundary.
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: form,
      signal: transcribeSignal(),
    });
    if (!r.ok) throw await compatError(r, desc.label);
    const data = await r.json();
    return { text: data.text || "", usage: { input: 0, output: 0, cacheRead: 0 } };
  },
};
