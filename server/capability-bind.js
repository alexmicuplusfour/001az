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
import { CAPABILITY, CAPABILITY_DEFS } from "./capabilities.js";
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

// The BOARD-scoped write (slice 5): validate the board-binding fields of a
// board create/update body and return { column: value } for updateBoard's
// boardBindings map. The body speaks in COLUMN names (`ai_key_id`,
// `transcribe_provider`, …) — the contract the board routes have always had —
// and this loop replaces the per-capability blocks that used to be hand-copied
// there. Column names come from the registry, never from input.
//
// Stricter than the blocks it replaces, deliberately: the old ones checked only
// that a key row EXISTED, so a board could pin an embed-only key as its tagger
// and discover the silent fall-through at runtime. Now the row's provider must
// advertise the capability — the same judgment chooseBinding applies globally.
// Installed-ness is still deliberately unchecked (defaults, not laws: a removed
// built-in's pin resumes when it returns).
//
// Rules per capability:
//   provider + keyId both non-null → 400 (a pin is one or the other)
//   provider: name → must exist, advertise, and be on-device (the built-in
//                    floor included); keyId and model forced NULL
//   provider: null → clears the provider column only — a keyed pin in the same
//                    body still lands
//   keyId: n      → row must exist and its provider must advertise; a provider
//                    column is forced NULL (a keyed pin displaces a name pin);
//                    model validated where the capability demands it
//                    (pinnedModelMustBeAdvertised)
//   keyId: null   → clears keyId and model; an unmentioned provider column is
//                    left alone (a Whisper pin survives an irrelevant clear)
//   model         → only meaningful beside a non-null keyId in the same body;
//                    alone it is ignored (a model with no key is never read)
//
export async function boardBindingPatch(db, body = {}) {
  const cols = {};
  for (const cap of CAPABILITY_DEFS) {
    const bk = cap.binding.boardKeys;
    if (!bk) continue;
    const provVal = bk.provider ? body[bk.provider] : undefined;
    const keyVal = body[bk.keyId];
    const modelVal = bk.model ? body[bk.model] : undefined;
    if (provVal === undefined && keyVal === undefined && modelVal === undefined) continue;

    if (provVal != null && keyVal != null) {
      throw bad(`pin ${cap.noun} to an on-device engine by name OR to a key — not both`);
    }

    if (provVal === null) cols[bk.provider] = null;
    else if (provVal !== undefined) {
      const name = String(provVal);
      const desc = PROVIDERS[name];
      if (!desc) throw bad(`unknown provider "${name}"`);
      if (!declaredCatalog(desc, cap.declaredBy)) throw bad(`${desc.label} advertises no ${cap.noun}`);
      if (!desc.onDevice && cap.floor?.provider !== name) {
        throw bad(`${desc.label} is keyed — pin one of its ${desc.keyless ? "connections" : "keys"} instead of naming it`);
      }
      cols[bk.provider] = name;
      cols[bk.keyId] = null;
      if (bk.model) cols[bk.model] = null;
      continue; // a name pin owns all three columns
    }

    if (keyVal === null) {
      cols[bk.keyId] = null;
      if (bk.model) cols[bk.model] = null;
    } else if (keyVal !== undefined) {
      const key = await getAiKey(db, Number(keyVal));
      if (!key) throw bad(`unknown ${bk.keyId}`);
      const desc = PROVIDERS[key.provider];
      if (!declaredCatalog(desc, cap.declaredBy)) {
        throw bad(`${desc?.label || key.provider} advertises no ${cap.noun} — pick a key from a provider that does`);
      }
      const model = modelVal != null && modelVal !== "" ? String(modelVal) : null;
      if (model && cap.pinnedModelMustBeAdvertised && !declaredCatalog(desc, cap.declaredBy)?.models.some((m) => m.id === model)) {
        throw bad(`${desc.label} has no ${cap.noun} model "${model}"`);
      }
      cols[bk.keyId] = key.id;
      if (bk.model && modelVal !== undefined) cols[bk.model] = model;
      if (bk.provider) cols[bk.provider] = null;
    }
    // modelVal alone falls through to here: deliberately dropped.
  }
  return cols;
}

// ONE config value against ONE field def. Shared by the global knob
// (assertValidCapabilityConfig, below) and the per-board column
// (boardBindingPatch) so the two scopes cannot drift on what they accept —
// the same reason board pins are judged by the global rules. Kind-aware: an
// `enum` value must be one of the declared options, a numeric one must be
// finite. Throws the same 400s the binding walk does.
function assertValidConfigValue(f, v) {
  if (f.kind === "enum") {
    if (!f.options?.some((o) => o.value === String(v)))
      throw bad(`"${v}" is not a ${f.key.replace(/_/g, " ")} — options: ${f.options.map((o) => o.value).join(", ")}`);
  } else if (!Number.isFinite(Number(v))) {
    throw bad(`${f.key.replace(/_/g, " ")} must be a number`);
  }
}

// Validate a config patch WITHOUT writing — the route calls this before
// bindCapability so the stores-nothing covenant holds for a combined body (a
// valid binding + a bogus config must store neither half). An absent value,
// or null/"" (a clear back to the default), is always fine.
export function assertValidCapabilityConfig(capId, values = {}) {
  for (const f of CAPABILITY[capId]?.binding.config || []) {
    const v = values[f.key];
    if (v === undefined || v === null || v === "") continue;
    assertValidConfigValue(f, v);
  }
}

// The BOARD-scoped half of the config story (ai-image-input-plan.md §7), and
// deliberately a separate function from boardBindingPatch: a pin is admin
// authority (it selects credentials), a knob is a cost/quality dial any board
// MANAGER may set — like ai_votes, which multiplies the same bill 3–5×. So
// this runs on the manager's save route too (buildBoardContentUpdate), while
// pins stay on the admin routes.
//
// Judged by the same single-field rule the global knob uses:
//   absent     → column untouched
//   null / ""  → column cleared (the board falls back to the app default)
//   a value    → validated against the field def, then stored
// Pure and synchronous — no db, nothing to look up.
export function boardConfigPatch(body = {}) {
  const cols = {};
  for (const cap of CAPABILITY_DEFS) {
    for (const f of cap.binding.config || []) {
      if (!f.boardColumn) continue;
      const v = body[f.boardColumn];
      if (v === undefined) continue;
      if (v === null || v === "") { cols[f.boardColumn] = null; continue; }
      assertValidConfigValue(f, v);
      cols[f.boardColumn] = String(v);
    }
  }
  return cols;
}

// A capability-level knob (detect's threshold, tagging's image preset): belongs
// to the capability, not to whichever provider serves it, so it is stored and
// cleared with the binding. Validates before the first write (see above) so a
// config-only body also stores nothing when rejected.
export async function setCapabilityConfig(db, capId, values = {}) {
  assertValidCapabilityConfig(capId, values);
  for (const f of CAPABILITY[capId]?.binding.config || []) {
    const v = values[f.key];
    if (v === undefined) continue;
    if (v == null || v === "") await setSetting(db, f.key, null);
    // Numerics store the NUMBER's string form, not the raw input's: a value
    // that validated as a number (Number(true) === 1) must read back as one.
    else await setSetting(db, f.key, f.kind === "enum" ? String(v) : String(Number(v)));
  }
}
