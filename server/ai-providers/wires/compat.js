// The OpenAI-compatible wire family: plain fetch to /chat/completions,
// /embeddings, and /audio/transcriptions. One protocol, many vendors — OpenAI,
// Gemini, GLM, OpenRouter, and any compat plugin all ride this code; they
// differ only in descriptor data (base URL + the `compat` quirk block).
// Everything compat-protocol-specific lives HERE; the engine (providers.js)
// only composes this into WIRES and dispatches through descriptor.wire.
// compatRequest is exported as the pure request-builder test seam — it reads
// the quirk block it's handed and never touches the registry.
import { DEFAULT_TOOL, OUTPUT_BUDGET, clippedError, providerError, rejectDocuments } from "./tool.js";
import { askFor, negotiate } from "./refusals.js";

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

// GET {base}/models, the raw rows — the ONE fetch behind both listModels and
// listPrices. null when the provider has no models endpoint at all (GLM says
// so in its quirk block); the engine serves the curated fallback instead.
async function modelRows(desc, { apiKey, base } = {}) {
  if (desc.compat.listModels === false) return null;
  const r = await compatFetch(desc.label, `${baseOf(desc, base)}/models`, { headers: compatHeaders(apiKey), signal: keyTestSignal() });
  if (!r.ok) throw await compatError(r, desc.label);
  const data = await r.json();
  return Array.isArray(data.data) ? data.data : [];
}

// A listed row's id in the spelling the chat endpoint and our curated lists
// use — see stripListPrefix on listModels.
function modelId(desc, m) {
  const id = String(m.id || "");
  const strip = desc.compat.stripListPrefix;
  return strip && id.startsWith(strip) ? id.slice(strip.length) : id;
}

// A failed compat response, turned into a readable error. OpenRouter buries
// the useful upstream detail under error.metadata.raw and leaves error.message
// as a generic "Provider returned error", so prefer the raw when present; other
// providers only have message. Status and Retry-After ride via providerError
// (tool.js), the shared half of the contract every wire's mapper builds on.
async function compatError(r, label) {
  const body = await r.json().catch(() => ({}));
  const e = body.error || {};
  const err = providerError(r, (e.metadata?.raw || e.message) || `${label} HTTP ${r.status}`);
  // OpenAI names the offending field and the reason in structured form
  // (param:"temperature", code:"unsupported_value") alongside the prose. Keep
  // both — the parameter-rejection recovery below reads them, and they're
  // strictly more reliable than matching an error sentence. Nothing else in the
  // app reads .code off a provider error (it's Postgres/fs errors that use it).
  if (e.param) err.param = e.param;
  if (e.code) err.code = e.code;
  return err;
}

// ─── parameters the provider may refuse ──────────────────────────────────────
// `noTemperature` (descriptor data) is a best-effort list of families known to
// reject it — but on OpenAI the tagging model comes from a LIVE /models list, so
// any id can appear and no static regex stays right. gpt-5-mini is exactly that
// case: it rejects temperature, it's the descriptor's own defaultModel, and the
// original guard only covered the o-series. A 400 is permanent-shaped, so
// failOrRequeue failed each item on its FIRST attempt — one board, every item
// dead, with a provider error most users can do nothing about.
//
// So the regex is only an optimisation; the correctness path — recognising
// the refusal and re-sending without the feature — is shared with the
// Anthropic wire and lives in refusals.js: the per-feature rejection
// vocabulary (temperature AND strict, since fable-5.1 refused both in one day,
// 2026-09-03), the learned set, and the keys both wires derive by. A tagging
// call is worth more than what either optimistic extra buys.

// Would a request for this model carry a temperature at all? The one definition
// — compatRequest builds from it, and the recovery above uses it to tell "the
// provider refused what we sent" from "we sent none and something else broke".
// Exported: the google family's native path answers the same question from
// the same quirk block.
export const temperatureAsked = (compat, model) =>
  compat.temperature !== undefined &&
  !(compat.noTemperature && new RegExp(compat.noTemperature).test(model));

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
    // A runaway guard, not a size estimate — see OUTPUT_BUDGET for why sizing
    // this to the schema measured the wrong half of the spend.
    [compat.maxTokensField]: OUTPUT_BUDGET,
    ...(compat.disableThinking ? { thinking: { type: "disabled" } } : {}),
    // Closed-vocabulary classification wants the mode, not a sample. Measured
    // 2026-08-06 on gpt-5.4-mini: re-tagging the same item with the same prompt
    // changed 22.4% of facet answers at the API default (1.0) and 18.3% at 0 —
    // 4 points of pure churn for nothing. (The remaining 18% is the reasoning
    // model's own decode variance; temperature does not touch it.)
    //
    // Quirk data, not a global: `noTemperature` is a model-id regex for
    // families known to REJECT the parameter (OpenAI's o-series and gpt-5 base
    // family both 400 on it). It's an optimisation — it saves the doomed first
    // call — not the guarantee: the tagging model comes from a live /models
    // list, so an unlisted id can always turn up, and the wire recovers from
    // the rejection at call time. See REFUSABLE.temperature in refusals.js.
    ...(temperatureAsked(compat, model) ? { temperature: compat.temperature } : {}),
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
// Exported: protocol-neutral, so the google family wraps its native calls too.
export async function compatFetch(label, url, opts) {
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
    rejectDocuments(desc.label, parts);
    const url = `${baseOf(desc, base)}/chat/completions`;
    const send = (compat) => compatFetch(desc.label, url, {
      method: "POST",
      headers: compatHeaders(apiKey),
      body: JSON.stringify(compatRequest({ compat, model, systemText, schema, parts, tool })),
      signal: chatSignal(),
    });
    // The refusal negotiation (negotiate in refusals.js): what to ask for is
    // the learned set intersected with this descriptor's own data — a quirk
    // block that never carried temperature, or a noTemperature-exempt model,
    // sends none regardless. `undefined`/false is how compatRequest is told to
    // omit a quirk, so the rebuild from the surviving flags needs no second
    // code path.
    const ask = askFor(url, model, { schema });
    const quirksOf = (sent) => ({
      ...desc.compat,
      ...(sent.temperature ? {} : { temperature: undefined }),
      strictTools: sent.strict,
    });
    const r = await negotiate({
      sent: {
        temperature: ask.temperature && temperatureAsked(desc.compat, model),
        strict: ask.strict && !!desc.compat.strictTools,
      },
      sendFromSent: (sent) => send(quirksOf(sent)),
      errOf: (res) => compatError(res, desc.label),
      endpoint: url, model, ctx: { schema }, label: desc.label,
    });
    const data = await r.json();
    const choice = data.choices?.[0];
    // Find the call BY NAME, like the Anthropic wire: a provider whose tool
    // choice can't be forced (GLM is auto-only) may invent another function,
    // and taking whatever came first would accept tag-shaped args as
    // extraction input — fields silently empty, logged ok. Same error shape
    // as the Anthropic wire's missing-call throw.
    const call = (choice?.message?.tool_calls || []).find((c) => c.function?.name === tool.name);
    // Arguments that parse ARE the answer, whatever the finish reason claims.
    // Gemini reports finish_reason "length" whenever its hidden thinking
    // overran the cap — including when it then went on to emit the entire tool
    // call (measured 2026-08-07: 1,807 thinking + 299 visible against a 2,048
    // cap, valid JSON, every required key present). Reading the finish reason
    // before the payload threw that answer away and failed the item
    // permanently, on a board where 1 item in 6 hit it.
    let input = null;
    try { input = call ? JSON.parse(call.function.arguments) : null; } catch { input = null; }
    // So a clip is fatal only once nothing usable came back: no call at all, or
    // arguments cut mid-JSON.
    if (!input && choice?.finish_reason === "length") throw clippedError(OUTPUT_BUDGET);
    if (!call) throw new Error(`model did not call ${tool.name}`);
    if (!input) throw new Error(`${tool.name} arguments were not valid JSON`);
    const u = data.usage || {};
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    return {
      input,
      usage: {
        // prompt_tokens includes cached ones; pull those out to match Anthropic
        input: Math.max((u.prompt_tokens || 0) - cached, 0),
        // Thinking bills as output, and Gemini reports it ONLY inside the total
        // — completion_tokens counts the visible answer alone (measured
        // 2026-08-07: completion_tokens 299 on a turn whose total ran 1,807
        // above prompt+completion, a ~6x under-count of what Google charged).
        // OpenAI already folds reasoning into completion_tokens, where the
        // total agrees and this max is a no-op.
        output: Math.max(u.completion_tokens || 0, (u.total_tokens || 0) - (u.prompt_tokens || 0)),
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
  //
  // The fetch and the id normalization are shared with listPrices (below):
  // ONE endpoint, two projections over its rows, so a box that both prefixes
  // its ids and prices them can't file rates under a spelling nothing looks
  // up.
  async listModels(desc, opts) {
    const rows = await modelRows(desc, opts);
    return rows && rows.map((m) => ({ id: modelId(desc, m) })).filter((m) => m.id);
  },

  // Per-model rates, when the listing carries them (metering-plan.md, the
  // provider rung): the same GET {base}/models rows, reading a `pricing`
  // object that is NOT part of the OpenAI-compatible protocol — so which
  // fields it holds is descriptor data (`compat.priceFields`), exactly like
  // every other vendor difference in this file. A descriptor that declares
  // none answers null ("didn't say"), which is also what keeps this rung
  // OPT-IN: without it, any compat box — including a proxy in front of a
  // self-hosted model, serving an upstream's hosted prices — would have its
  // listing believed. That is the community rung's `priceNamespace` trap
  // arriving through the other door, and it gets the same lock.
  //
  // Answers in the VENDOR's unit — dollars per unit, as stated on the wire.
  // Converting to the rate map's micros is the pricing layer's business, not
  // a wire's: a wire translates a vendor's format and knows nothing about how
  // this app stores a rate. Zero is kept (a free model is a KNOWN price); a
  // negative (-1 = "variable") is dropped, since that is not a rate and we
  // never guess one.
  async listPrices(desc, opts) {
    const fields = desc.compat.priceFields;
    if (!fields) return null;
    const rows = await modelRows(desc, opts);
    const out = [];
    for (const m of rows || []) {
      const model = modelId(desc, m);
      if (!model || !m.pricing || typeof m.pricing !== "object") continue;
      for (const [field, unit] of Object.entries(fields)) {
        const dollarsPerUnit = Number(m.pricing[field]);
        if (m.pricing[field] != null && Number.isFinite(dollarsPerUnit) && dollarsPerUnit >= 0)
          out.push({ model, unit, dollarsPerUnit });
      }
    }
    return out.length ? out : null;
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
  // path never names a provider. Returns { text, usage }: token-billed
  // transcription models (gpt-4o-transcribe) report usage on the response and
  // it passes through; per-duration models (whisper-1) report nothing and the
  // zeros stand — the caller meters the audio's own measured duration, which
  // is the unit those models bill in.
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
    return {
      text: data.text || "",
      usage: {
        input: data.usage?.input_tokens || 0,
        output: data.usage?.output_tokens || 0,
        cacheRead: 0,
      },
    };
  },
};
