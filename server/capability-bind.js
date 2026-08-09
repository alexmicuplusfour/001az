// Binding a capability to a provider (capabilities-plan.md, slice 2b).
//
// ONE validated write behind what used to be four near-identical blocks in
// /api/admin/ai-config — the transcribe and detect ones were the same ~40 lines
// with the capability noun swapped, and embed differed only in owning an enable
// flag. Every rule below reads the capability descriptor; no capability is named
// in this file.
//
// The contract the old route earned and this one keeps: a REJECTED bind stores
// nothing. Everything is validated before the first setSetting, because a bogus
// model used to be a 400 that left the provider unset and must stay one.
import { PROVIDERS, declaredCatalog } from "./providers.js";
import { CAPABILITY } from "./capabilities.js";
import { setSetting, getAiKey } from "./db.js";
import { resolveCapability } from "./capability-resolve.js";

const bad = (message) => Object.assign(new Error(message), { status: 400 });

const advertises = (cap, provider) => !!declaredCatalog(PROVIDERS[provider], cap.declaredBy);
// Who could serve this capability with a key — for the "try X or Y" hint. Excludes
// on-device engines: they are the other half of the same sentence.
const keyedCandidates = (cap) =>
  Object.keys(PROVIDERS).filter((n) => advertises(cap, n) && !PROVIDERS[n].onDevice);

// Validate a (provider, keyId, model) choice and return the three values to
// store. Throws a 400 with a readable reason; writes nothing itself.
async function chooseBinding(db, cap, patch) {
  const keys = cap.binding.keys;
  const floorProvider = cap.floor?.kind === "builtin" ? cap.floor.provider : null;

  // A capability with no provider setting (tagging) takes its provider from the
  // key row, so a bind is just "which connection" — nothing to validate beyond
  // the row existing. Its model is deliberately unchecked: live model lists mean
  // the curated catalog is a recommendation, not the set of ids that exist.
  if (!keys.provider) {
    if (patch.keyId == null) return { provider: null, keyId: null, model: undefined };
    const key = await getAiKey(db, Number(patch.keyId));
    if (!key) throw bad("unknown key");
    return { provider: null, keyId: key.id, model: undefined };
  }

  // A named provider wins; otherwise the connection row implies one. (An
  // explicit null provider alongside a key is how the embedder's form says "use
  // the key path" — it must not read as "clear everything".)
  const provider = patch.provider || (patch.keyId != null ? (await getAiKey(db, Number(patch.keyId)))?.provider : null);

  // Cleared, or the floor named outright → back to the always-on engine.
  if (!provider || provider === floorProvider) return { provider: provider || floorProvider, keyId: null, model: null };

  // The one message that covers both halves of the choice, because both are
  // genuinely wrong here: this provider can't serve the capability, and the
  // alternatives are either a capable provider's key or an on-device engine.
  if (!advertises(cap, provider)) {
    const names = keyedCandidates(cap).join(" or ");
    throw bad(`${provider} advertises no ${cap.noun}${names ? ` — try ${names}` : ""} (or an on-device engine, which needs no key)`);
  }

  // On-device engines are picked by NAME and carry no key row.
  if (PROVIDERS[provider].onDevice) return { provider, keyId: null, model: null };

  const desc = PROVIDERS[provider];
  const key = patch.keyId != null ? await getAiKey(db, Number(patch.keyId)) : null;
  if (!key || key.provider !== provider)
    throw bad(`pick a ${desc.label} ${desc.keyless ? "connection" : "key"} to serve ${cap.noun} with it`);

  const model = patch.model || null;
  if (model && cap.pinnedModelMustBeAdvertised && !declaredCatalog(PROVIDERS[provider], cap.declaredBy)?.models.some((m) => m.id === model))
    throw bad(`${desc.label} has no ${cap.noun} model "${model}"`);

  return { provider, keyId: key.id, model };
}

// Apply a patch to a capability's stored binding. Any of `provider`, `keyId`,
// `model`, `enabled` may be absent, meaning "leave it alone".
export async function bindCapability(db, capId, patch = {}) {
  const cap = CAPABILITY[capId];
  const keys = cap?.binding.keys;
  if (!keys) throw bad(`"${capId}" has no global default to bind`);

  // --- validate, then write ---
  const writes = [];
  if (patch.provider !== undefined || patch.keyId !== undefined) {
    const chosen = await chooseBinding(db, cap, patch);
    if (keys.provider) writes.push([keys.provider, chosen.provider]);
    writes.push([keys.keyId, chosen.keyId == null ? null : String(chosen.keyId)]);
    if (keys.model && chosen.model !== undefined) writes.push([keys.model, chosen.model]);
  }
  // An explicit model still applies when the choice didn't decide one — tagging
  // sends key and model together, and its model is never validated here.
  if (patch.model !== undefined && keys.model && !writes.some(([k]) => k === keys.model))
    writes.push([keys.model, patch.model || null]);
  for (const [k, v] of writes) await setSetting(db, k, v);

  // --- the enable flag, validated against the FINAL state ---
  // Deliberately after the writes: turning a capability on has to judge the
  // binding as it now stands, not as it was.
  if (patch.enabled !== undefined && keys.enabled) {
    if (patch.enabled && !(await resolveCapability(db, capId, { ignoreEnabled: true })))
      throw bad(`pick a provider for ${cap.noun} before turning it on`);
    await setSetting(db, keys.enabled, patch.enabled ? "1" : null);
  }
}

// A capability-level knob (detect's threshold): belongs to the capability, not
// to whichever provider serves it, so it is stored and cleared with the binding.
export async function setCapabilityConfig(db, capId, values = {}) {
  for (const f of CAPABILITY[capId]?.binding.config || []) {
    const v = values[f.key];
    if (v !== undefined) await setSetting(db, f.key, v != null ? String(v) : null);
  }
}
