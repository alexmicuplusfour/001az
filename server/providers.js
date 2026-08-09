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
import { CAPABILITY } from "./capabilities.js";

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

// A networked provider MUST declare its rate limit — pacing is part of the
// provider contract, not an optional add-on. On-device providers (local,
// whisper) make no external calls and are exempt. Keyless-NETWORKED providers
// (a self-hosted Ollama, …) are NOT: no secret ≠ no server to melt. Enforced
// here for built-ins and in registerProvider for dynamically-loaded plugins,
// so no AI provider can enter the registry without a declared rpm/burst.
export function requireRateLimit(name, desc) {
  if (!desc.wire || desc.onDevice) return; // on-device → no external rate limit
  if (!(desc.rpm > 0) || !(desc.burst > 0))
    throw new Error(`AI provider "${name}" must declare positive rpm and burst (rate-limit contract)`);
}

// --- capability declaration: the `provides` normal form ---
// A descriptor declares its capabilities three different ways for historical
// reasons — tagging by the PRESENCE of wire.tag, embed/transcribe/detect by a
// catalog OBJECT, research by a BOOLEAN. Every consumer therefore has to know
// which shape each capability uses, which is why adding one costs an edit in a
// dozen places. `provides` is the single normal form:
//
//   provides: { tag: { models, default, filter }, embed: {…}, transcribe: {…},
//               detect: {…}, research: true }
//
// with an ABSENT key meaning "does not do this". Everything below reads
// `provides`; the legacy fields stay on the descriptor untouched, so existing
// consumers, published plugins, and the wires keep working unchanged. This is a
// read-side normalization, not a migration.
// Three of the five are a pure RENAME: the legacy field already holds exactly
// the catalog object `provides` wants. Only `tag` (spread across three sibling
// fields) and `research` (a bare boolean) need their own handling — which is
// why they appear explicitly in both functions below and these three don't.
const RENAMED = { embed: "embeds", transcribe: "transcribes", detect: "detects" };

// Legacy fields → `provides`, with an explicitly-supplied `provides` winning per
// capability (so a hybrid descriptor that writes provides.tag but still declares
// legacy `embeds` keeps both instead of silently losing the legacy half).
//
// Invariant: the result carries NO undefined values and NO functions. It crosses
// the JSON boundary in providerCatalog(), and the route-vs-catalog deepStrictEqual
// in providers.test.js treats { a: undefined } and {} as different objects.
// Exported so the plugin loader validates through this same code — one
// implementation, or the loader and the registry drift.
export function normalizeProvides(desc) {
  const out = {};
  // Tagging is declared by wire.tag EXISTING (local sets it to null, which is not
  // the same as absent), and its catalog lives in three sibling fields.
  if (desc.wire?.tag) out.tag = { models: desc.models || [], default: desc.defaultModel ?? null, filter: desc.modelFilter ?? null };
  // Truthiness is the flag, deliberately: the whisper sidecar advertises
  // transcription as { default: null, models: [] } — the model is baked into its
  // image, so the catalog is legitimately empty and must still read as advertised.
  for (const [cap, field] of Object.entries(RENAMED)) if (desc[field]) out[cap] = desc[field];
  if (desc.research) out.research = true;
  return { ...out, ...(desc.provides || {}) };
}

// The mirror image: fill the legacy fields FROM an explicit `provides`, so a
// descriptor may declare either shape and every existing reader keeps working —
// the wires read desc.defaultModel, the worker reads PROVIDERS[p].embeds, and
// neither knows about `provides` yet. Without this, supplying `provides` alone
// would silently produce a half-broken provider, which is worse than not
// accepting it at all.
//
// Guarded on the provides side being PRESENT, never a blind `??=`: `embeds: null`
// is a meaningful explicit declaration (providers.test.js asserts the null) and
// must not be turned into `undefined`, which would then JSON-drop. For a
// legacy-shaped descriptor every assignment below is a no-op by construction —
// the value it would write is the one it was lifted from.
function backfillLegacy(desc) {
  const t = desc.provides.tag;
  if (t) {
    if (desc.defaultModel == null) desc.defaultModel = t.default;
    if (desc.models == null) desc.models = t.models;
    if (desc.modelFilter == null && t.filter != null) desc.modelFilter = t.filter;
  }
  for (const [cap, field] of Object.entries(RENAMED))
    if (desc.provides[cap] && desc[field] == null) desc[field] = desc.provides[cap];
  if (desc.provides.research && desc.research == null) desc.research = true;
}

// The ONE write into the registry: stamp the self-name, enforce the rate-limit
// contract, insert. Built-ins and plugins both land here — the only difference is
// a plugin flags `external` first (registerProvider), so a built-in is never
// offered for uninstall. Keeping this a single function is what makes "built-ins
// and plugins enter the registry the same way" true in code, not just in prose.
function install(name, desc) {
  desc.name = name;
  // Two orthogonal descriptor flags: `keyless` = connections to this provider
  // carry no secret (auth); `onDevice` = it runs in-process/on-box and makes no
  // external calls (network). On-device implies keyless — normalize so the two
  // can never contradict (an on-device provider with a secret is nonsensical).
  if (desc.onDevice) desc.keyless = true;
  // Normalize the capability declaration here, at the one registry write, so
  // every descriptor in PROVIDERS — built-in, plugin, or test-registered —
  // carries `provides` and no reader has to handle both shapes. NOTE: this does
  // NOT check that an advertised capability has a backing wire; whisper and
  // localDetector legitimately advertise one with wire null (sidecar-backed,
  // assembled in worker.js). That check is a PLUGIN rule and lives in the loader.
  desc.provides = normalizeProvides(desc);
  backfillLegacy(desc);
  requireRateLimit(name, desc); // any networked provider declares its rate limit, or it's rejected
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
// New code should ask PROVIDERS[p].provides?.embed instead — same answer, but
// one shape for every capability, so it survives a capability being added.
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
  if (desc?.onDevice) return; // on-device (local/whisper): no external call, nothing to pace
  // Keyless-networked providers pace like any other; their bucket is the
  // per-provider "nokey" one (aiKeyBucket) since all connections share the box.
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

// Detect objects in an image → [{ label, box, score }] via a provider's wire.
// Only detects-capable providers qualify — callers gate on
// PROVIDERS[provider].detects. The on-device `localDetector` rides its own
// wire.detect like any other (paceAi no-ops for keyless), so there's no
// provider-name branch here.
export async function detectObjects({ provider, rpm, burst, ...rest }) {
  await paceAi(provider, rest.apiKey, rpm, burst);
  const desc = PROVIDERS[provider];
  return desc.wire.detect(desc, rest);
}

// Cheap key/model validation for the admin "Test" buttons. Throws with the
// provider's error message on failure.
export function testKey({ provider, ...rest }) {
  const desc = PROVIDERS[provider];
  return desc.wire.testKey(desc, rest);
}

// The models a connection can use RIGHT NOW: the provider's own listing
// endpoint (wire.listModels, asked with the connection's key/server), carved
// per CAPABILITY and merged under the descriptor's curated picks. One raw
// fetch serves every capability — /models mixes chat, embedding, and audio ids
// and the listing endpoints carry NO capability metadata (OpenAI's is bare
// ids), so name-pattern filters carried as descriptor data are how a catalog
// claims its slice: `provides.<cap>.filter`, a regex source tested against the
// id (lifted from `modelFilter` / `embeds.filter` / `transcribes.filter` on a
// legacy-shaped descriptor). Tagging
// without a filter shows everything (a provider may be all-chat); a
// capability catalog without a filter stays on its curated list — an
// unfiltered dump into the embedder picker would be worse than hardcoding.
// That asymmetry is capability POLICY, not a provider declaration, so it lives
// on the capability (`unfilteredShowsAll`), not in each descriptor.
// The descriptor lists are the recommended set + offline fallback, NOT the
// catalog — a wire without listing, a fetch failure, or a filter that
// matches nothing serves them alone (source: "fallback"); never a throw,
// never an empty picker (the Test button is the key diagnostic). But an
// ANSWER is the truth: when the provider listed and the curated ids weren't
// there, their notes say so — a suggestion must not impersonate an
// installed model. When the
// live list applies it owns existence: a retired curated id drops out,
// everything else sorts in below the recommendations; descriptor notes win
// the labels for ids both sides know.
// One capability's declared catalog on a descriptor, or null when the provider
// doesn't advertise it — or when the key names a modifier like `research`, which
// is `true`, not a catalog. THE shape guard: exported because resolution and
// binding need exactly this question answered, and three copies of it would be
// three chances to disagree about what "advertises" means.
export const declaredCatalog = (desc, capKey) => {
  const p = desc?.provides?.[capKey];
  return p && typeof p === "object" ? p : null;
};

// …carved for the live-list merge: the descriptor's declaration plus this
// capability's policy. No capability is named here — it reads whatever
// `provides` and CATALOG_POLICY hold.
const catalogFor = (desc, cap) => {
  const p = declaredCatalog(desc, cap);
  return p && { models: p.models, filter: p.filter, always: !!CAPABILITY[cap]?.unfilteredShowsAll };
};
function assembleModels(desc, kind, live) {
  const cat = catalogFor(desc, kind);
  if (!cat) return { source: "fallback", models: [] }; // provider lacks the capability
  // `absent`: the provider ANSWERED and these ids weren't in the answer
  // (fresh Ollama box with nothing pulled, filter matched nothing). Still
  // suggest them — an empty select reads as broken, and the curated notes are
  // the "what should I pull" hint — but say so inline, so a suggestion can't
  // impersonate an installed model. A null live (couldn't ask) stays
  // unmarked: we don't know they're absent.
  const fallback = (absent) => ({
    source: "fallback",
    models: (cat.models || []).map((m) => ({
      ...m,
      recommended: true,
      ...(absent ? { note: m.note ? `${m.note} · not listed by this connection` : "not listed by this connection" } : {}),
    })),
  });
  if (!live || (!cat.filter && !cat.always)) return fallback(false);
  // A filter that doesn't compile (a plugin author's typo) degrades exactly
  // like one that matches nothing — warned so the author can find it, since
  // the route's fallback-not-error contract otherwise swallows the evidence.
  let filter = null;
  if (cat.filter) {
    try { filter = new RegExp(cat.filter); }
    catch (err) {
      console.warn(`${desc.label}: bad ${kind} model filter ${JSON.stringify(cat.filter)} — serving the curated list (${err.message})`);
      return fallback(false); // broken filter ≠ evidence of absence
    }
  }
  const list = filter ? live.filter((m) => filter.test(m.id)) : live;
  if (!list.length) return fallback(true);
  const rest = new Map(list.map((m) => [m.id, m]));
  const models = [];
  // cat.models is optional (an embed-only plugin omits the tagging list) —
  // the plugin contract never required it, so the merge can't either.
  for (const m of cat.models || []) if (rest.delete(m.id)) models.push({ ...m, recommended: true });
  models.push(...[...rest.values()].sort((a, b) => a.id.localeCompare(b.id)));
  return { source: "live", models };
}
// The raw wire ask, failure-swallowing: null = "nothing live" (no listing
// support, unreachable, bad key) and every kind falls back. Interactive like
// testKey — not paced.
async function fetchLiveModels(desc, opts) {
  if (!desc?.wire?.listModels) return null;
  try { return (await desc.wire.listModels(desc, opts)) || null; }
  catch { return null; }
}
export async function listProviderModels({ provider, apiKey, base, kind = "tag" }) {
  const desc = PROVIDERS[provider];
  return assembleModels(desc, kind, await fetchLiveModels(desc, { apiKey, base }));
}

// --- the per-connection model-list cache ---
// Keyed by ai_keys row id (the connection's key/server decide the answer), so
// it lives HERE with the lister, not inline in a route: every mutation path —
// the admin PATCH/DELETE routes AND plugin uninstall, which deletes rows via
// deleteAiKey directly — invalidates through the one exported function, the
// same owner-module pattern as ingestion's invalidateSourceCache. The cache
// holds the RAW live list (as a settling promise — see the coalescing note in
// cachedProviderModels), not assembled payloads: all three catalog kinds
// share one upstream fetch, and assembly is cheap per request.
// TTL read per call: 0 = off (tests use this); empty string counts as unset →
// the 10-min default (Number("") is 0, which would silently disable caching).
const modelListCache = new Map(); // ai_keys row id -> { at, live }
const modelListTtl = () => {
  const v = process.env.AI_MODELS_TTL_MS;
  return v == null || v === "" ? 600000 : Number(v);
};
export function invalidateModelListCache(keyId) {
  modelListCache.delete(Number(keyId));
}
export async function cachedProviderModels(keyId, { provider, apiKey, base, kind = "tag" }, { refresh = false } = {}) {
  const desc = PROVIDERS[provider];
  const id = Number(keyId);
  let entry = modelListCache.get(id);
  // An in-flight fetch is fresh by definition, so later arrivals ride it —
  // refreshers included: the plugin modal builds its per-kind sections in one
  // pass and every select's first visit sends refresh=1, so without
  // coalescing each section would bust the raw list the previous section's
  // still-pending fetch was about to fill (three racing upstream asks per
  // modal open). Refresh only busts SETTLED entries; TTL runs from settle.
  const usable = entry && (entry.pending || (!refresh && Date.now() - entry.at < modelListTtl()));
  if (!usable) {
    const e = { pending: true, at: Date.now() };
    e.live = fetchLiveModels(desc, { apiKey, base }).then((v) => {
      e.pending = false;
      e.at = Date.now();
      // A failure isn't a fact worth remembering: a cached null would pin the
      // fallback for the whole TTL after the box recovers. Drop the entry so
      // the next ask re-probes (a dead box refuses in milliseconds, asks are
      // interactive-only, and concurrent ones coalesce above) — riders on
      // this fetch still get the null. Guarded: never evict a newer entry.
      if (v == null && modelListCache.get(id) === e) modelListCache.delete(id);
      return v;
    });
    modelListCache.set(id, e);
    entry = e;
  }
  return assembleModels(desc, kind, await entry.live);
}

// …and carved for the UI: deliberately narrower than the descriptor's own object
// (no `filter` — that's server-side carving data, not a picker's business).
const catalogEntry = (desc, cap) => {
  const p = declaredCatalog(desc, cap);
  return p ? { default: p.default, models: p.models } : null;
};

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
      // `!!` not a passthrough: a descriptor that omits `research` would put
      // `undefined` here, which JSON-drops and then fails the route-vs-catalog
      // deepStrictEqual. Every built-in sets it explicitly so that has never
      // fired; deriving it removes the trap for plugins.
      research: !!p.provides.research,
      keyless: !!p.keyless,
      onDevice: !!p.onDevice,
      // needsBase: connections carry the server URL (self-hosted providers —
      // the descriptor base is only the suggested default, shown as the form's
      // placeholder). Fixed-endpoint providers never store one.
      needsBase: !!p.needsBase,
      base: p.needsBase ? p.base || null : null,
      // The per-capability catalogs, DERIVED from `provides` but still emitted
      // under their legacy names: this payload is a wire format the plugin modal
      // and the board modal read (p.ai.embeds.models, …). It can be extended,
      // not swapped — the client moves to `provides` when the capabilities page
      // lands, not before.
      embeds: catalogEntry(p, "embed"),
      transcribes: catalogEntry(p, "transcribe"),
      detects: catalogEntry(p, "detect"),
      // The normal form itself, so a capability-aware consumer can iterate
      // instead of naming the three fields above.
      provides: p.provides,
    };
  });
}
