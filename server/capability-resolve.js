// Generic capability resolution (capabilities-plan.md, slice 2a).
//
// ONE implementation of the eight steps that resolveDefaultAi, resolveEmbedder,
// resolveTranscriber and resolveDetector each used to perform by hand:
//
//   1. floor gate        an `off` capability resolves to nothing until enabled
//   2. pick the provider  setting, else the key row's, else the floor's
//   3. still advertises?  the descriptor's `provides` entry
//   4. still installed?   the Plugins-page tier rule
//   5. key row            required unless the provider runs on-device
//   6. model              the capability's setting, else the descriptor default
//   7. fall to the floor  when any of the above says no
//   8. return the BINDING, stamped with how it got there
//
// It returns a BINDING (credentials + model), never an engine. That is the
// genuine common denominator: transcribe and detect have sidecar floors that no
// wire can reach, so their callers wrap the binding in an engine, while tag and
// embed spread it straight into callTagger/embedTexts. Building engines here
// instead would touch ~20 call sites and the worker's per-board prompt cache to
// buy nothing.
//
// `viaFloor` is the honesty bit: true means the configured binding did not
// resolve and the floor answered instead. The capabilities page reads it to tell
// `active` from `degraded` (slice 3); today it tells an engine which shape to be.
import { PROVIDERS, declaredCatalog } from "./providers.js";
import { CAPABILITY } from "./capabilities.js";
import { getSetting, getAiKey } from "./db.js";
import { pluginInstalled } from "./plugins.js";

// A provider is usable for a capability when it advertises it, its plugin is
// installed, and it can actually PERFORM it — the wire method has to exist.
// That last check is what retires the old `provider !== "whisper"` /
// `!== "localDetector"` sentinels: those two advertise their capability with
// `wire: null`, so they fail here and fall to the floor engine that serves them.
async function usable(db, cap, provider) {
  const desc = PROVIDERS[provider];
  if (!declaredCatalog(desc, cap.declaredBy)) return null; // never declared it, or a stale name from an uninstalled plugin
  if (typeof desc.wire?.[cap.verb] !== "function") return null; // advertises it but cannot make the call
  if (!(await pluginInstalled(db, `ai:${provider}`))) return null; // removed on the Plugins page → drops out of resolution
  return desc;
}

// The model in effect: the capability's own setting wins, else whatever the
// provider declares as its default for that capability.
async function modelFor(db, cap, desc) {
  const pinned = cap.binding.keys?.model ? await getSetting(db, cap.binding.keys.model) : null;
  return pinned || declaredCatalog(desc, cap.declaredBy)?.default || null;
}

// The stored binding: a provider named outright (an on-device pick), else the
// one implied by the connection row. One rule for all four capabilities —
// `embed_provider` used to mean "on-device only", transcribe/detect's meant "the
// engine, with sentinel names", and tagging had no provider setting at all.
async function storedBinding(db, cap) {
  const keys = cap.binding.keys;
  if (!keys) return null;
  const named = keys.provider ? await getSetting(db, keys.provider) : null;
  const keyId = keys.keyId ? Number(await getSetting(db, keys.keyId)) || 0 : 0;
  const key = keyId ? await getAiKey(db, keyId) : null;
  const provider = named || key?.provider || null;
  if (!provider) return null;

  const desc = await usable(db, cap, provider);
  if (!desc) return null;
  // A key/connection row is required unless the provider runs in-process. A
  // KEYLESS-networked provider (a self-hosted Ollama) still needs its row: that
  // is where its base_url lives, which is the whole point of the row.
  if (!desc.onDevice && (!key || key.provider !== provider)) return null;

  return {
    provider,
    apiKey: key?.api_key ?? null,
    model: await modelFor(db, cap, desc),
    base: key?.base_url || undefined,
    keyId: key?.id ?? null,
    viaFloor: false,
  };
}

// The env rung (tagging only today): a secret the server holds instead of a
// stored row. Gated on the provider's plugin being installed, like any other.
async function envBinding(db, cap) {
  if (!cap.env || !process.env[cap.env.secret]) return null;
  const desc = await usable(db, cap, cap.env.provider);
  if (!desc) return null;
  const pinned = cap.binding.keys?.model ? await getSetting(db, cap.binding.keys.model) : null;
  return {
    provider: cap.env.provider,
    apiKey: process.env[cap.env.secret],
    model: pinned || process.env[cap.env.model] || declaredCatalog(desc, cap.declaredBy)?.default || null,
    keyId: "env", // which rung answered; naming it for a human is the route's job
    viaFloor: false,
  };
}

// What happens with no usable binding. `off`/`blocked` resolve to nothing (the
// difference is what the CALLER does — the embed sweep pauses, the tag queue
// requeues without consuming an attempt); `builtin` hands back the always-on
// provider so resolution never fails; `delegate` defers to another capability.
async function floorBinding(db, cap) {
  const floor = cap.floor;
  if (!floor) return null;
  if (floor.kind === "delegate") return resolveCapability(db, floor.to);
  if (floor.kind !== "builtin") return null;
  const desc = PROVIDERS[floor.provider];
  return {
    provider: floor.provider,
    apiKey: null,
    model: declaredCatalog(desc, cap.declaredBy)?.default ?? null,
    keyId: null,
    viaFloor: true,
  };
}

// The one resolver. Returns a binding, or null when the capability's floor is
// `off`/`blocked` and nothing is configured.
//
// `ignoreEnabled` asks the question the enable button needs: "would this resolve
// if it were on?" — used to refuse turning a capability on when nothing would
// serve it.
export async function resolveCapability(db, capId, { ignoreEnabled = false } = {}) {
  const cap = CAPABILITY[capId];
  if (!cap) return null;
  const keys = cap.binding.keys;
  // An `off` capability is gated before anything else is read: a disabled
  // embedder must not resolve just because a key is still stored.
  if (!ignoreEnabled && keys?.enabled && (await getSetting(db, keys.enabled)) !== "1") return null;
  return (await storedBinding(db, cap)) || (await envBinding(db, cap)) || (await floorBinding(db, cap));
}

// Can this provider serve this capability right now? Returns its descriptor, or
// null. Exported for the BOARD-scoped path, which resolves from a board column
// rather than a setting but has to judge a provider by exactly the same rule —
// otherwise a board pinned to an embed-only connection resolves as a tagger and
// throws at the wire, while the global default falls through cleanly.
export const usableProvider = (db, capId, provider) => usable(db, CAPABILITY[capId], provider);

// What is STORED for a capability, with the floor's provider standing in when
// nothing is bound. The read-side peer of bindCapability: one place that knows a
// capability's settings keys, so the payloads that expose bindings cannot drift
// from each other or from the descriptor's floor.
//
// Note it does NOT include `binding.config` (detect's threshold): a knob that
// belongs to the capability rather than to whoever serves it outlives any one
// binding, which is also why the cleanup loops leave it alone.
export async function capabilityBinding(db, capId) {
  const cap = CAPABILITY[capId];
  const keys = cap?.binding.keys;
  if (!keys) return null;
  const out = {
    provider: keys.provider ? (await getSetting(db, keys.provider)) || cap.floor?.provider || null : null,
    keyId: keys.keyId ? Number(await getSetting(db, keys.keyId)) || null : null,
    model: keys.model ? (await getSetting(db, keys.model)) || null : null,
  };
  if (keys.enabled) out.enabled = (await getSetting(db, keys.enabled)) === "1";
  return out;
}

// A capability-level knob (detect's threshold), read from settings with the
// descriptor's default. Belongs to the capability, not to whoever serves it.
export async function capabilityConfig(db, capId) {
  const out = {};
  for (const f of CAPABILITY[capId]?.binding.config || []) {
    const v = await getSetting(db, f.key);
    out[f.key] = v != null && v !== "" ? Number(v) || f.default : f.default;
  }
  return out;
}
