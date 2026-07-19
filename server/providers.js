// The AI-provider ENGINE: the tagging call, embeddings, transcription, key
// validation, per-key pacing, and the registry itself. Everything here is
// provider-agnostic — it reads descriptor fields and never branches on a
// provider name. Prompt building, the queue, and tag validation live in
// worker.js.
//
// A provider is one descriptor: its quirks are data (base URL, which max-tokens
// field it wants, whether it forces the tool call, …) and it points at one of
// two `wire` families — `anthropic` (SDK, tool_use blocks, server-side
// web_search) or `compat` (plain fetch to /chat/completions). The built-in
// descriptors live in ./ai-providers/ as (wires) => descriptor factories — the
// same contract a plugin returns — and are registered below; a dropped-in plugin
// enters the SAME registry the SAME way (registerProvider). Adding a provider,
// built-in or plugin, is one descriptor.
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { acquire } from "./provider-pacing.js";
import { BUILTIN_PROVIDERS } from "./ai-providers/index.js";

const TOOL_NAME = "record_tags";
const TOOL_DESC = "Record the applicable taxonomy tags for this item.";
const DEFAULT_TOOL = { name: TOOL_NAME, description: TOOL_DESC };
// Per-item bound on web searches; each one bills on top of tokens.
const MAX_SEARCHES = 5;

// Cached Anthropic clients, keyed by API key — multiple keys can be active at
// once (per-board overrides), and the registry holds at most a handful.
const anthropicClients = new Map();
function anthropicClient(apiKey) {
  if (!anthropicClients.has(apiKey)) anthropicClients.set(apiKey, new Anthropic({ apiKey }));
  return anthropicClients.get(apiKey);
}

const compatHeaders = (apiKey) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
// Outbound deadlines for the compat wire — raw fetch has no total bound
// (undici caps response headers at ~5 min; a trickling body never times out),
// and a hung call wedges the worker's single-flight tick. The Anthropic wire
// needs none of this: the SDK defaults to a 10-min per-try timeout, and
// research tagging legitimately runs minutes. Env-tunable, read per call.
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

// --- pure request builders (the test seam) ---

// Anthropic tool-use request. Research relaxes tool_choice to auto — a forced
// tool call would block the server-side web_search tool — so the model must be
// trusted (and validated downstream) to finish with record_tags.
export function anthropicRequest({ model, systemText, schema, parts, research = false, tool = DEFAULT_TOOL }) {
  const content = parts.map((p) => {
    if (p.kind === "image") return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.b64 } };
    if (p.kind === "document") return { type: "document", source: { type: "base64", media_type: p.mediaType, data: p.b64 } };
    return { type: "text", text: p.text };
  });
  const toolDef = { name: tool.name, description: tool.description, strict: true, input_schema: schema };
  return {
    model,
    // searching + digesting results eats output budget
    max_tokens: research ? 4096 : 2048,
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    tools: research
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }, toolDef]
      : [toolDef],
    tool_choice: research ? { type: "auto" } : { type: "tool", name: tool.name },
    messages: [{ role: "user", content }],
  };
}

// OpenAI-compatible chat-completions request. A forced function call mirrors
// the Anthropic tool shape and the same strict JSON schema works — but the
// per-provider quirks (which max-tokens field, whether the tool call is forced
// or left auto, whether `strict` is accepted, whether thinking must be turned
// off) are read as data from the descriptor's `compat` block, not branched on
// the provider name. See the GLM descriptor for why each knob exists.
export function compatRequest({ provider, model, systemText, schema, parts, tool = DEFAULT_TOOL }) {
  const { compat } = PROVIDERS[provider];
  const content = parts.map((p) =>
    p.kind === "image"
      ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.b64}` } }
      : { type: "text", text: p.text }
  );
  return {
    model,
    [compat.maxTokensField]: 2048,
    ...(compat.disableThinking ? { thinking: { type: "disabled" } } : {}),
    messages: [
      { role: "system", content: systemText },
      { role: "user", content },
    ],
    tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: schema, ...(compat.strictTools ? { strict: true } : {}) } }],
    tool_choice: compat.forceToolChoice ? { type: "function", function: { name: tool.name } } : "auto",
  };
}

// --- wire families ---
// Each owns tag/testKey/embed and reads the descriptor for base URL, label,
// and its `compat`/`research` data. `embed: null` marks a family (or provider)
// with no embeddings API. Both are exported (WIRES, below) and handed to plugins
// on `ctx.wires` — a compat-protocol provider reuses `WIRES.compat` and brings
// only its descriptor (base + `compat` quirks + catalog), never a copy of the
// protocol. A provider speaking a genuinely new protocol still brings its own.

const anthropicWire = {
  async tag(desc, { apiKey, model, systemText, schema, parts, research = false, tool = DEFAULT_TOOL }) {
    const request = anthropicRequest({ model, systemText, schema, parts, research, tool });
    let msg = await anthropicClient(apiKey).messages.create(request);
    const usage = { input: 0, output: 0, cacheRead: 0, searches: 0 };
    const addUsage = (u = {}) => {
      // cache writes bill as (slightly dearer) input, so fold them in
      usage.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      usage.output += u.output_tokens || 0;
      usage.cacheRead += u.cache_read_input_tokens || 0;
      usage.searches += u.server_tool_use?.web_search_requests || 0;
    };
    addUsage(msg.usage);
    // A search-heavy turn can come back paused mid-work; hand the partial turn
    // back and let the model continue (bounded — beyond that, the missing tool
    // call below turns it into a retryable failure).
    for (let i = 0; i < 3 && msg.stop_reason === "pause_turn"; i++) {
      request.messages.push({ role: "assistant", content: msg.content });
      msg = await anthropicClient(apiKey).messages.create(request);
      addUsage(msg.usage);
    }
    const block = msg.content.find((b) => b.type === "tool_use" && b.name === tool.name);
    if (!block) throw new Error(`model did not call ${tool.name}`);
    return { input: block.input, usage };
  },

  async testKey(desc, { apiKey, model }) {
    // Same 30 s bound as the compat keyTest — interactive admin button; the
    // SDK's 10-min default is for the tagging path, not for a click.
    await anthropicClient(apiKey).messages.countTokens({
      model: model || desc.defaultModel,
      messages: [{ role: "user", content: "hi" }],
    }, { timeout: 30000 });
  },

  embed: null, // Anthropic has no embeddings API
};

const compatWire = {
  async tag(desc, { apiKey, model, systemText, schema, parts, tool = DEFAULT_TOOL }) {
    // Document blocks are Anthropic-only: the chat-completions path has no PDF
    // input. Fail loud with the fix, rather than degrading silently.
    if (parts.some((p) => p.kind === "document"))
      throw new Error(`${desc.label} taggers can't read PDF documents — use an Anthropic tagger for this board`);
    const r = await fetch(`${desc.base}/chat/completions`, {
      method: "POST",
      headers: compatHeaders(apiKey),
      body: JSON.stringify(compatRequest({ provider: desc.name, model, systemText, schema, parts, tool })),
      signal: chatSignal(),
    });
    if (!r.ok) throw await compatError(r, desc.label);
    const data = await r.json();
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error("no tool call in response");
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

  async testKey(desc, { apiKey, model }) {
    const id = model || desc.defaultModel;
    // "completion": a one-token chat call (for providers with no models
    // endpoint — GLM). "models": a cheap GET on the model id. Both validate the
    // key and surface the provider's own error message.
    if (desc.compat.keyTest === "completion") {
      const r = await fetch(`${desc.base}/chat/completions`, {
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
    const r = await fetch(`${desc.base}/models/${encodeURIComponent(id)}`, { headers: compatHeaders(apiKey), signal: keyTestSignal() });
    if (!r.ok) throw await compatError(r, desc.label);
  },

  // Embed a batch of texts. Returns { vectors: Float32Array[], usage } with
  // every vector L2-normalized, so similarity is a plain dot product.
  async embed(desc, { apiKey, model, texts }) {
    const r = await fetch(`${desc.base}/embeddings`, {
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
  async transcribe(desc, { apiKey, model, audio, filename }) {
    const form = new FormData();
    form.append("model", model || desc.transcribes.default);
    // The multipart filename's EXTENSION is load-bearing: OpenAI validates the
    // audio format from it, and rejects an extensionless name. Callers pass the
    // stored <hex>.<ext> name; the fallback is only for a bare reachability probe.
    form.append("file", new Blob([audio]), filename || "audio.wav");
    const r = await fetch(`${desc.base}/audio/transcriptions`, {
      method: "POST",
      // NOT compatHeaders — FormData sets its own multipart Content-Type + boundary.
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: transcribeSignal(),
    });
    if (!r.ok) throw await compatError(r, desc.label);
    const data = await r.json();
    return { text: data.text || "", usage: { input: 0, output: 0, cacheRead: 0 } };
  },
};

// The shared wire families, keyed by name — the two protocols the app speaks.
// Exposed to plugins via ctx.wires (plugin-loader.js) so an external provider on
// a known protocol references one instead of reimplementing it; a bug fix to a
// wire reaches every provider riding it, built-in or plugin, from this one spot.
export const WIRES = { anthropic: anthropicWire, compat: compatWire };

// --- the registry ---
// One descriptor per provider, keyed by name. `models`/`embeds.models` carry the
// admin catalog (id + note) as the single source of truth — the admin UI is
// served from here. Built-ins are populated below from ./ai-providers factories;
// plugins add theirs live via registerProvider. Both land in this one map.
export const PROVIDERS = {};

// A networked (keyed) provider MUST declare its rate limit — pacing is part of the
// provider contract, not an optional add-on. On-device/keyless providers (local,
// whisper) make no external calls and are exempt. Enforced here for built-ins and
// in registerProvider for dynamically-loaded plugins, so no AI provider can enter
// the registry without a declared rpm/burst.
export function requireRateLimit(name, desc) {
  if (!desc.wire || desc.keyless) return; // on-device / keyless → no external rate limit
  if (!(desc.rpm > 0) || !(desc.burst > 0))
    throw new Error(`AI provider "${name}" must declare positive rpm and burst (rate-limit contract)`);
}

// The ONE write into the registry: stamp the self-name, enforce the rate-limit
// contract, insert. Built-ins and plugins both land here — the only difference is
// a plugin flags `external` first (registerProvider), so a built-in is never
// offered for uninstall. Keeping this a single function is what makes "built-ins
// and plugins enter the registry the same way" true in code, not just in prose.
function install(name, desc) {
  desc.name = name;
  requireRateLimit(name, desc); // any provider declares its rate limit, or it's rejected
  PROVIDERS[name] = desc;
}

// Populate the built-ins: call each factory with the shared wires and install the
// descriptor it returns. Insertion order (see ai-providers/index.js) sets the
// registry + catalog display order.
for (const [name, make] of Object.entries(BUILTIN_PROVIDERS)) install(name, make(WIRES));

// --- dynamic registration (phase 2) ---
// Register a dynamically-loaded AI provider (an `ai-provider` plugin). The
// descriptor is the same data shape a built-in is (label/description/wire/
// defaultModel/models/embeds/research/keyless…); providerCatalog() reads
// PROVIDERS live, so the plugin's card and the board modal pick it up from this
// one write. `external` marks it for uninstall and lets the UI distinguish it.
// The loader calls this only after the descriptor is fully validated.
export function registerProvider(name, desc) {
  desc.external = true; // marks it for uninstall + lets the UI distinguish it from a built-in
  install(name, desc);
}

export function unregisterProvider(name) {
  delete PROVIDERS[name];
}

// Callers reach through the registry directly: PROVIDERS[p].defaultModel for
// the default, PROVIDERS[p]?.embeds as the "does this provider embed" check.
// The one place a plain list is needed (validation error messages) derives it
// inline from Object.keys(PROVIDERS).

// --- per-key pacing ---
// AI calls run through the same token bucket connectors use (provider-pacing.js),
// but bucketed per API KEY, not per provider: two keys of one provider are two
// accounts with independent limits, two boards sharing a key contend. Every keyed
// provider DECLARES its rpm/burst in the descriptor (required — see requireRateLimit,
// grounded in each provider's published tier where one exists), so the DEFAULT below
// is a defensive fallback only, never reached for a validated provider. AI_RPM/AI_BURST
// override for ops + tests (mirrors CONNECTOR_RPM). No withRetry layer here on purpose:
// the Anthropic SDK already retries and the queue's spaced retry_at is the retry
// mechanism (worker-queue-holes §2) — this paces only. Keyless on-device providers
// (local/whisper) never reach here.
const DEFAULT_AI_RPM = 300, DEFAULT_AI_BURST = 10;
const aiKeyBucket = (provider, apiKey) =>
  `ai:${provider}:${apiKey ? crypto.createHash("sha1").update(apiKey).digest("hex").slice(0, 12) : "nokey"}`;
// rpmOverride/burstOverride carry the per-provider Plugins-page config (read by the
// worker's aiRate helper); precedence is env > admin override > descriptor default.
async function paceAi(provider, apiKey, rpmOverride, burstOverride) {
  const desc = PROVIDERS[provider];
  if (desc?.keyless) return; // on-device (local/whisper): no external call, nothing to pace
  const rpm = Number(process.env.AI_RPM) || rpmOverride || desc?.rpm || DEFAULT_AI_RPM;
  const burst = Number(process.env.AI_BURST) || burstOverride || desc?.burst || DEFAULT_AI_BURST;
  await acquire(aiKeyBucket(provider, apiKey), rpm, burst);
}

// --- public dispatchers ---

// Run one tagging call. `parts` is the provider-neutral user content the source
// built ({ kind: "image", mediaType, b64 } | { kind: "text", text } |
// { kind: "document", … }); the wire family maps it to its own format. Research
// (server-side web search before tagging) is honored only by providers that
// declare it — the rest tag from the given input. Returns { input, usage }: the
// tool-call input object (facet key -> selection, plus "fit") and token usage
// normalized to { input, output, cacheRead, searches } — cache reads are kept
// out of `input` because they bill at a fraction of the input rate. Throws with
// a readable message on any failure.
export async function callTagger({ provider, research = false, rpm, burst, ...rest }) {
  await paceAi(provider, rest.apiKey, rpm, burst);
  const desc = PROVIDERS[provider];
  return desc.wire.tag(desc, { ...rest, research: research && desc.research });
}

// Embed a batch of texts (semantic search). Only embeddings-capable providers
// qualify — callers gate on PROVIDERS[provider].embeds before reaching here. The
// on-device `local` provider rides its own wire.embed like any other (paceAi
// no-ops for keyless), so there's no provider-name branch here.
export async function embedTexts({ provider, rpm, burst, ...rest }) {
  await paceAi(provider, rest.apiKey, rpm, burst);
  const desc = PROVIDERS[provider];
  return desc.wire.embed(desc, rest);
}

// Transcribe audio bytes → { text, usage } via a provider's wire. Only
// transcribes-capable providers qualify — callers gate on
// PROVIDERS[provider].transcribes. `whisper` is the on-server sidecar, resolved
// directly by resolveTranscriber (worker.js) with a null wire, so it never
// routes here — only keyed provider engines do.
export async function transcribeAudio({ provider, rpm, burst, ...rest }) {
  await paceAi(provider, rest.apiKey, rpm, burst);
  const desc = PROVIDERS[provider];
  return desc.wire.transcribe(desc, rest);
}

// Cheap key/model validation for the admin "Test" buttons. Throws with the
// provider's error message on failure.
export function testKey({ provider, ...rest }) {
  const desc = PROVIDERS[provider];
  return desc.wire.testKey(desc, rest);
}

// Public catalog for the admin UI — labels, model lists (with notes), defaults,
// and capability flags. No secrets, safe to serve. The client renders its
// provider/model pickers from this so the catalog isn't mirrored in two places.
export function providerCatalog() {
  return Object.keys(PROVIDERS).map((name) => {
    const p = PROVIDERS[name];
    return {
      name,
      label: p.label,
      description: p.description || "",
      defaultModel: p.defaultModel,
      models: p.models,
      research: p.research,
      keyless: !!p.keyless,
      embeds: p.embeds ? { default: p.embeds.default, models: p.embeds.models } : null,
      transcribes: p.transcribes ? { default: p.transcribes.default, models: p.transcribes.models } : null,
    };
  });
}
