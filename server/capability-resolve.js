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
// Slice 5 adds a rung ahead of these: a BOARD's own pin (boardBinding), read
// off the board row's columns and judged by the same rules, with a miss falling
// to the global walk below rather than to the floor.
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
import { CAPABILITY, CAPABILITY_DEFS, configFieldView } from "./capabilities.js";
import { getSetting, getAiKey } from "./db.js";
import { pluginInstalled } from "./plugins.js";
import { sidecarPresent } from "./sidecar-catalog.js";

// The one spelling of "the engine isn't on this host". Module-private like
// every other miss sentence here: readers outside get it from floorMiss()
// below, the projection that re-walks the same check — never by re-deriving
// presence themselves and correlating it with a null resolution.
const SIDECAR_ABSENT_MISS = "the built-in engine is not running on this server";

// The provider named in a capability's own setting, read once — storedBinding
// publishes it and floorBinding needs it, and the transcription lane walks
// both every poll tick, where a duplicated PK SELECT is ~30k queries a day.
const storedProviderName = async (db, cap) =>
  (cap.binding.keys?.provider ? await getSetting(db, cap.binding.keys.provider) : null);

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
//
// `named` (the provider SETTING, read here) rides every shape so the resolver
// can hand it to floorBinding instead of that rung re-reading the same row —
// the transcription lane walks this path every poll tick, where a duplicated
// PK SELECT is ~30k queries a day.
async function storedBinding(db, cap) {
  const keys = cap.binding.keys;
  if (!keys) return { named: null };
  const named = await storedProviderName(db, cap);
  const keyId = keys.keyId ? Number(await getSetting(db, keys.keyId)) || 0 : 0;
  const key = keyId ? await getAiKey(db, keyId) : null;
  const provider = named || key?.provider || null;
  if (!provider) {
    // A keyId whose row is GONE is a real miss, not "nothing stored" — the live
    // cleanup clears the setting with the row, but a restored backup can
    // resurrect the pointer without the key.
    return keyId ? { named, miss: "the stored key no longer exists" } : { named };
  }

  const miss = await disqualified(db, cap, provider);
  if (miss) return { named, miss };
  const desc = PROVIDERS[provider];
  // A key/connection row is required unless the provider runs in-process. A
  // KEYLESS-networked provider (a self-hosted Ollama) still needs its row: that
  // is where its base_url lives, which is the whole point of the row.
  if (!desc.onDevice && (!key || key.provider !== provider))
    return { named, miss: `no ${desc.keyless ? "connection" : "key"} stored for ${desc.label}` };

  return {
    named,
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

// The board rung (slice 5): a board's own pin, read from its row's columns and
// judged by exactly the same rules as the global rung — board scope changes
// where the choice is stored, never what makes a provider usable. Shapes:
//   { binding }  the pin serves
//   { miss }     something is pinned but cannot serve — the caller falls to the
//                GLOBAL rung (never straight to the floor), loudly, which is
//                resolveBoardAi's old contract for every scoped capability
//   {}           no pin, or the capability has no board scope
async function boardBinding(db, cap, board) {
  const bk = cap.binding.boardKeys;
  if (!bk || !board) return {};
  const named = bk.provider ? board[bk.provider] : null;
  const keyId = bk.keyId ? Number(board[bk.keyId]) || 0 : 0;
  if (!named && !keyId) return {};
  // The board's own model pick, whatever it turns out to be pinned to — read
  // once here rather than at each of the three branches below, which must all
  // prefer it over any default.
  const pick = bk.model ? board[bk.model] : null;

  // A deliberate pin of the built-in — the floor binding, chosen rather than
  // fallen to. Checked before disqualified(): the builtin provider has no wire
  // by design, and viaFloor:true is what routes the engine to the sidecar.
  const floorProvider = cap.floor?.kind === "builtin" ? cap.floor.provider : null;
  if (named && named === floorProvider) {
    // …and the board's own model column comes with it. The built-in may serve
    // several models (model-axis-plan.md); the floor binding supplies the
    // credential shape, the board supplies the pick. Without this the pin
    // resolves to the engine's default and the choice silently evaporates.
    const b = await floorBinding(db, cap, null, await storedProviderName(db, cap));
    // The floor can now decline (its engine absent from this host, below) —
    // a pinned engine that isn't running is a missed pin like any other, so
    // it falls to the GLOBAL rung, loudly, never silently to another engine.
    if (!b) return { miss: SIDECAR_ABSENT_MISS };
    return { binding: { ...b, model: pick || b.model } };
  }

  if (named) {
    const miss = await disqualified(db, cap, named);
    if (miss) return { miss };
    const desc = PROVIDERS[named];
    // Only an on-device engine can be pinned by name — a keyed provider's pin
    // is its key row. The write path refuses this; a hand-seeded row still
    // resolves honestly.
    if (!desc.onDevice) return { miss: `${desc.label} is keyed — a board pins one of its ${desc.keyless ? "connections" : "keys"}, not its name` };
    return {
      binding: {
        provider: named,
        apiKey: null,
        model: pick || declaredCatalog(desc, cap.declaredBy)?.default || null,
        keyId: null,
        viaFloor: false,
      },
    };
  }

  const key = await getAiKey(db, keyId);
  // Near-unreachable (the column is FK ON DELETE SET NULL) but a restored
  // backup can resurrect the pointer without the key — same note as the
  // global rung.
  if (!key) return { miss: "the board's pinned key no longer exists" };
  const miss = await disqualified(db, cap, key.provider);
  if (miss) return { miss };
  const desc = PROVIDERS[key.provider];
  return {
    binding: {
      provider: key.provider,
      apiKey: key.api_key,
      // The board's own model, else the provider's declared default — NEVER the
      // global pinned model, which may belong to a different provider entirely.
      model: pick || declaredCatalog(desc, cap.declaredBy)?.default || null,
      base: key.base_url || undefined,
      keyId: key.id,
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
// requeues without consuming an attempt); `builtin` hands back the built-in
// provider — when its engine is actually on this host; `delegate` defers to
// another capability.
async function floorBinding(db, cap, board = null, storedProvider) {
  const floor = cap.floor;
  if (!floor) return null;
  // Delegation forwards the board: extraction falling to "the tagger" means the
  // BOARD's tagger when one is pinned, exactly the chain the worker used to
  // hand-write.
  if (floor.kind === "delegate") return resolveCapability(db, floor.to, { board });
  if (floor.kind !== "builtin") return null;
  // A sidecar-backed built-in is only a floor where its sidecar runs — a slim
  // host deploys without one (sidecar-presence-plan.md), and handing back a
  // binding for an engine that isn't there is how audio once retried forever.
  // Strictly `=== false`: null means "not sidecar-backed" (no probe to fail),
  // so a hypothetical in-process builtin stays always-on. Absence resolves to
  // nothing, and the caller waits — blocked semantics, never an item failure.
  if ((await sidecarPresent(floor.provider)) === false) return null;
  const desc = PROVIDERS[floor.provider];
  // A model stored ALONGSIDE this provider is the admin's pick among what the
  // built-in serves, so it rides the floor binding. A model stored for some
  // OTHER provider is not ours to use — falling back from a dead OpenAI key
  // must not hand `whisper-1` to the whisper sidecar, which never baked it.
  // `storedProvider` is required, not optional: both callers have already read
  // it (the resolver off storedBinding, the board floor-pin off its own
  // storedProviderName), and an optional one would have to tell "not passed"
  // from "nothing stored" — two meanings for null on a setting whose null is
  // meaningful.
  const pinned = storedProvider === floor.provider && cap.binding.keys?.model
    ? await getSetting(db, cap.binding.keys.model)
    : null;
  const model = pinned || declaredCatalog(desc, cap.declaredBy)?.default || null;
  return { provider: floor.provider, apiKey: null, model, keyId: null, viaFloor: true };
}

// The one resolver. Returns a binding, or null when nothing is configured and
// the floor has nothing to give — it is `off`/`blocked`, or its built-in
// engine is not running on this host.
//
// `ignoreEnabled` asks the question the enable button needs: "would this resolve
// if it were on?" — used to refuse turning a capability on when nothing would
// serve it.
//
// `board` is a board row (or a column-shaped fragment of one); capabilities
// with no boardKeys ignore it. The ladder: board pin → global → env → floor,
// with a MISSED pin falling to the global rung — a board pinned to a dead key
// behaves like an unpinned board, and the item still gets served.
export async function resolveCapability(db, capId, { ignoreEnabled = false, board = null } = {}) {
  const cap = CAPABILITY[capId];
  if (!cap) return null;
  const keys = cap.binding.keys;
  // An `off` capability is gated before anything else is read: a disabled
  // embedder must not resolve just because a key is still stored.
  if (!ignoreEnabled && keys?.enabled && (await getSetting(db, keys.enabled)) !== "1") return null;
  const pinned = await boardBinding(db, cap, board);
  if (pinned.binding) return pinned.binding;
  if (pinned.miss) console.log(`board's pinned ${cap.noun} provider can't serve (${pinned.miss}) — falling back to the app default`);
  const stored = await storedBinding(db, cap);
  if (stored.binding) return stored.binding;
  return (await envBinding(db, cap)) || (await floorBinding(db, cap, board, stored.named));
}

// Why is the STORED choice not the thing serving? Null when it serves — or when
// nothing is stored (an empty binding is not a fault; the state machine reads
// "nothing stored" off capabilityBinding instead). This is the `reason` line on
// a degraded capability card, produced by the same walk resolution takes.
export async function storedBindingMiss(db, capId) {
  const cap = CAPABILITY[capId];
  return cap ? (await storedBinding(db, cap)).miss ?? null : null;
}

// …and why did the FLOOR not catch the fall? Null when it did, or when it has
// no reason of its own to give (`off`/`blocked`/`delegate` are states the card
// already names). storedBindingMiss's peer, and for the same reason: a reason
// re-derived by its reader is a reason that can drift from what resolution
// actually did. Today one floor kind can decline — a builtin whose sidecar
// isn't on this host — so a future kind that can decline adds its sentence
// here and every card renders it with no edit.
export async function floorMiss(db, capId) {
  const floor = CAPABILITY[capId]?.floor;
  if (floor?.kind !== "builtin") return null;
  return (await sidecarPresent(floor.provider)) === false ? SIDECAR_ABSENT_MISS : null;
}

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

// Every board-scopable capability knob, with its vocabulary and the app-wide
// value its "App default" row names (ai-image-input-plan.md §7). This rides
// the BOARD SETTINGS payload rather than the admin capabilities feed, because
// a board manager may set these and cannot read admin feeds — same registry,
// a projection scoped to what the board modal needs.
export async function boardConfigCatalog(db) {
  const out = [];
  for (const cap of CAPABILITY_DEFS) {
    const fields = (cap.binding.config || []).filter((f) => f.boardColumn);
    if (!fields.length) continue;
    const values = await capabilityConfig(db, cap.id);
    // `value` is the APP-WIDE effective value — what the picker's
    // "App default (…)" row names.
    for (const f of fields) out.push(configFieldView(f, values[f.key]));
  }
  return out;
}

// A capability-level knob (detect's threshold, tagging's image preset), read
// from settings with the descriptor's default. Belongs to the capability, not
// to whoever serves it. Kind-aware: an `enum` field passes the stored string
// through when it is one of the def's options (an unknown id — a downgrade, a
// hand-edited row — reads as the default, never an error); a numeric field
// reads any finite number — INCLUDING 0, which the old `Number(v) ||` shape
// silently folded into the default.
export async function capabilityConfig(db, capId) {
  const out = {};
  for (const f of CAPABILITY[capId]?.binding.config || []) {
    const v = await getSetting(db, f.key);
    if (f.kind === "enum") {
      out[f.key] = f.options?.some((o) => o.value === v) ? v : f.default;
    } else {
      const n = Number(v);
      out[f.key] = v != null && v !== "" && Number.isFinite(n) ? n : f.default;
    }
  }
  return out;
}
