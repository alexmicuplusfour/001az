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

// Why can this provider NOT serve this capability right now? Null = it can.
// One implementation, two consumers: resolution reads it as a boolean (usable →
// otherwise fall to the next rung), the status projection reads the string as
// the card's reason line — which is what keeps the reason and the fallback from
// ever disagreeing. The checks are what retire the old `provider !== "whisper"`
// / `!== "localDetector"` sentinels: the two sidecar-backed built-ins advertise
// their capability with `wire: null`, so they land on the no-wire check and fall
// to the floor engine that serves them — for THEM that is routing, not a fault,
// and the state machine knows a stored floor name is never "degraded".
async function disqualified(db, cap, provider) {
  const desc = PROVIDERS[provider];
  if (!desc) return `"${provider}" is not installed`; // an uninstalled plugin's name lingering in a setting
  if (!declaredCatalog(desc, cap.declaredBy)) return `${desc.label} does not advertise ${cap.noun}`;
  if (typeof desc.wire?.[cap.verb] !== "function") return `${desc.label} has no ${cap.noun} wire of its own`;
  if (!(await pluginInstalled(db, `ai:${provider}`))) return `${desc.label} is removed on the Plugins page`;
  return null;
}
const usable = async (db, cap, provider) => ((await disqualified(db, cap, provider)) ? null : PROVIDERS[provider]);

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
// Returns { binding } when the stored choice serves, { miss: reason } when
// something is stored but cannot serve, {} when nothing is stored at all. The
// resolver reads `.binding` and falls through; storedBindingMiss (the status
// projection) reads `.miss` — same walk, so the reason can never disagree with
// what resolution actually did.
async function storedBinding(db, cap) {
  const keys = cap.binding.keys;
  if (!keys) return {};
  const named = keys.provider ? await getSetting(db, keys.provider) : null;
  const keyId = keys.keyId ? Number(await getSetting(db, keys.keyId)) || 0 : 0;
  const key = keyId ? await getAiKey(db, keyId) : null;
  const provider = named || key?.provider || null;
  if (!provider) {
    // A keyId whose row is GONE is a real miss, not "nothing stored" — the live
    // cleanup clears the setting with the row, but a restored backup can
    // resurrect the pointer without the key.
    return keyId ? { miss: "the stored key no longer exists" } : {};
  }

  const miss = await disqualified(db, cap, provider);
  if (miss) return { miss };
  const desc = PROVIDERS[provider];
  // A key/connection row is required unless the provider runs in-process. A
  // KEYLESS-networked provider (a self-hosted Ollama) still needs its row: that
  // is where its base_url lives, which is the whole point of the row.
  if (!desc.onDevice && (!key || key.provider !== provider))
    return { miss: `no ${desc.keyless ? "connection" : "key"} stored for ${desc.label}` };

  return {
    binding: {
      provider,
      apiKey: key?.api_key ?? null,
      model: await modelFor(db, cap, desc),
      base: key?.base_url || undefined,
      keyId: key?.id ?? null,
      viaFloor: false,
    },
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
  const stored = await storedBinding(db, cap);
  if (stored.binding) return stored.binding;
  return (await envBinding(db, cap)) || (await floorBinding(db, cap));
}

// Why is the STORED choice not the thing serving? Null when it serves — or when
// nothing is stored (an empty binding is not a fault; the state machine reads
// "nothing stored" off capabilityBinding instead). This is the `reason` line on
// a degraded capability card, produced by the same walk resolution takes.
export async function storedBindingMiss(db, capId) {
  const cap = CAPABILITY[capId];
  return cap ? (await storedBinding(db, cap)).miss ?? null : null;
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
  const keyId = keys.keyId ? Number(await getSetting(db, keys.keyId)) || null : null;
  const out = {
    provider: keys.provider ? (await getSetting(db, keys.provider)) || cap.floor?.provider || null : null,
    keyId,
    model: keys.model ? (await getSetting(db, keys.model)) || null : null,
  };
  // A capability with no provider setting (tagging) still has a stored
  // provider — the key row's. Stored information, just stored in the row.
  if (!keys.provider && keyId) out.provider = (await getAiKey(db, keyId))?.provider || null;
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
