// The AI-provider ENGINE: the registry, per-key pacing, and the dispatchers
// (tag / embed / transcribe / key test). Everything here is provider-agnostic —
// it reads descriptor fields and dispatches through descriptor.wire; no vendor
// name, protocol constant, or SDK import appears in this file. Prompt building,
// the queue, and tag validation live in worker.js.
//
// A provider is one descriptor: its quirks are data (base URL, which max-tokens
// field it wants, whether it forces the tool call, …) and it points at one of
// two `wire` families — `anthropic` (SDK, tool_use blocks, server-side
// web_search) or `compat` (plain fetch to /chat/completions) — which live in
// ./ai-providers/wires/, one module per protocol. The built-in descriptors live
// in ./ai-providers/ as (wires) => descriptor factories — the same contract a
// plugin returns — and are registered below; a dropped-in plugin enters the
// SAME registry the SAME way (registerProvider). Adding a provider, built-in or
// plugin, is one descriptor.
import crypto from "node:crypto";
import { acquire } from "./provider-pacing.js";
import { BUILTIN_PROVIDERS } from "./ai-providers/index.js";
import { WIRES } from "./ai-providers/wires/index.js";

// Re-exported for the plugin loader (ctx.wires) and tests — the wire families
// themselves live in ./ai-providers/wires/, one module per protocol; the engine
// only hands the roster to descriptor factories and plugins.
export { WIRES };

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
