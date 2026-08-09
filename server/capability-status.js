// The capabilities status feed (capabilities-plan.md, slice 3) — for every
// capability, one honest answer: what state is it in, what is actually serving
// it, why did it fall if it fell, who else could serve it, and what the outage
// costs. The capabilities page renders this verbatim; nothing in it is authored
// per capability.
//
// READ-ONLY composition over what already exists: CAPABILITY_DEFS (the
// registry), resolveCapability/storedBindingMiss (what serves and why not),
// ONE pluginCatalog(db) call (installed / keys / health for every supportedBy
// roster), listConnectors (domain entries are GENERATED, never typed), and
// listSources (per-source readiness, including the folder/INGEST_ROOT check —
// never read process.env here).
//
// States: five strings + a flag. `active` + viaFloor:true is the plan's
// "active (floor)".
//   active       something serves it (a binding, the env rung, or the floor)
//   degraded     the ADMIN'S stored choice is not what's serving — whatever is
//   blocked      configured target exists but cannot serve until a key arrives
//   off          explicitly disabled (embed's enable flag)
//   unavailable  nothing installed advertises it and there is no built-in floor
//
// SECURITY: `bound` and `running` are built FIELD BY FIELD. resolveCapability's
// result carries apiKey — it must never be spread into this payload. The
// secrets-scan test seeds a sentinel key and greps the serialized response.
import { PROVIDERS } from "./providers.js";
import { CAPABILITY_DEFS } from "./capabilities.js";
import { resolveCapability, capabilityBinding, capabilityConfig, storedBindingMiss } from "./capability-resolve.js";
import { pluginCatalog } from "./plugins.js";
import { listConnectors, getConnector } from "./connectors/index.js";
import { tagQueueDepth, embeddingStats, countBoardOverrides } from "./db.js";
import { transcriberSidecarModel, detectorSidecarModel } from "./worker.js";
import { listSources } from "./ingestion/files.js";
import { probeable } from "./capability-probe.js";

// Per-capability demand — what an outage costs, attached to blocked/degraded
// cards ("14 items waiting"). Keyed by id HERE rather than on CAPABILITY_DEFS
// because that module is pure data imported by db.js and these need queries; a
// capability that owns a queue adds its entry here. `transcribe` is deliberately
// absent: its only counting query is an unindexed payload scan (fine in the
// worker's paced loop, not on an admin page load), and its floor is builtin so
// it is never blocked. `detect`/`extract`: field-triggered / conflated with the
// tag queue.
const DEMAND = {
  tag: async (db) => ({ waiting: await tagQueueDepth(db) }),
  embed: async (db, { running, bound }) => {
    const model = running?.model || bound?.model;
    if (!model) return null;
    const { tagged, embedded, failed } = await embeddingStats(db, model);
    return { waiting: Math.max(0, tagged - embedded - failed) };
  },
};

// Per-capability PROGRESS — how far along the serving binding is, shown while
// it is ACTIVE (demand is the outage view; this is the healthy one). Same home
// and same reasoning as DEMAND: needs queries, so it cannot live on the pure
// data module. Embed is the one capability with a backfill today.
const PROGRESS = {
  embed: async (db, running) => {
    if (!running?.model) return null;
    const { tagged, embedded, failed } = await embeddingStats(db, running.model);
    return { done: embedded, total: tagged, failed };
  },
};

// The floor engines' models are baked into their sidecar images — the
// descriptors deliberately declare little or nothing (whisper's own comment:
// the sidecar names its model). Overlay what /health reports, so a floor
// `running` line states the truth instead of "—". Cached ~60s in worker.js.
const FLOOR_LIVE_MODEL = {
  transcribe: transcriberSidecarModel,
  detect: detectorSidecarModel,
};

// Who could serve this capability — every AI provider whose descriptor
// advertises `declaredBy`, with its install/key/health state off the one
// catalog. Works for `extract` too (declaredBy "tag").
const aiRoster = (catalog, declaredBy) =>
  catalog
    .filter((p) => p.kind === "ai" && p.capabilities?.[declaredBy])
    .map((p) => ({
      name: p.name,
      label: p.label,
      installed: p.state.installed,
      keyCount: p.state.keyCount ?? 0,
      onDevice: !!p.ai?.onDevice,
      keyless: !!p.ai?.keyless,
      health: p.state.health || null,
    }));

async function aiEntry(db, cap, catalog) {
  const keys = cap.binding.keys;
  const bound = await capabilityBinding(db, cap.id);
  const miss = await storedBindingMiss(db, cap.id);
  const eff = await resolveCapability(db, cap.id);
  const supported = aiRoster(catalog, cap.declaredBy);

  // "The admin chose something other than the floor." capabilityBinding
  // floor-fills the provider, so a cleared transcribe binding reads "whisper" —
  // equal to the floor, hence NOT a choice; naming the floor outright is the
  // same non-choice. A stored keyId is always a choice (tag has no provider
  // setting at all).
  const floorProvider = cap.floor?.kind === "builtin" ? cap.floor.provider : null;
  const storedNonFloor = !!bound && ((bound.provider && bound.provider !== floorProvider) || !!bound.keyId);

  // The order is load-bearing (see the plan §3.3): `off` is an explicit choice
  // and wins; a MISSED stored choice is degraded even when the env rung or the
  // floor picked up the work (an effective-first rule would call that healthy).
  let state;
  let reason = null;
  if (keys?.enabled && bound && !bound.enabled) {
    state = "off";
  } else if (miss && storedNonFloor) {
    state = "degraded";
    reason = miss;
  } else if (eff) {
    state = "active";
  } else if (!supported.some((p) => p.installed) && cap.floor?.kind !== "builtin") {
    state = "unavailable";
  } else {
    state = "blocked";
  }

  // Field by field — eff carries apiKey and must never be spread.
  const viaFloor = !!eff?.viaFloor;
  let running = null;
  if (eff) {
    running = { provider: eff.provider, model: eff.model ?? null, keyId: eff.keyId ?? null };
    // Live sidecar model wins over the descriptor's (possibly stale, possibly
    // absent) baked default; falls back to it when the sidecar is unreachable.
    if (viaFloor && FLOOR_LIVE_MODEL[cap.id]) running.model = (await FLOOR_LIVE_MODEL[cap.id]()) || running.model;
  }

  const demand =
    (state === "blocked" || state === "degraded") && DEMAND[cap.id]
      ? await DEMAND[cap.id](db, { running, bound })
      : null;
  const progress = state === "active" && PROGRESS[cap.id] ? await PROGRESS[cap.id](db, running) : null;

  const cfg = cap.binding.config?.length ? await capabilityConfig(db, cap.id) : null;
  const modifiers = CAPABILITY_DEFS.filter((m) => m.modifierOf === cap.id).map((m) => ({
    id: m.id,
    label: m.label,
    blurb: m.blurb,
    supportedBy: catalog.filter((p) => p.kind === "ai" && p.capabilities?.[m.declaredBy]).map((p) => p.name),
    // Can the provider CURRENTLY serving the parent do this too?
    availableNow: !!(eff && PROVIDERS[eff.provider]?.provides?.[m.declaredBy]),
  }));

  return {
    id: cap.id,
    kind: "ai",
    label: cap.label,
    noun: cap.noun,
    agent: cap.agent,
    blurb: cap.blurb,
    // Which `provides` slice backs this capability — the modal's model catalog
    // reads p.ai.provides[declaredBy] instead of assuming it equals the id.
    declaredBy: cap.declaredBy,
    // Which levers this capability's binding has — so the section renders an
    // enable toggle or a provider-by-name apply from data, not from its id.
    binding: { provider: !!keys?.provider, enable: !!keys?.enabled },
    state,
    viaFloor,
    reason,
    // Derived, not declared: which levels this capability binds at.
    scope: cap.binding.boardKeys ? (keys ? "board-or-global" : "board") : "global",
    bound,
    running,
    supportedBy: supported,
    demand,
    ...(progress ? { progress } : {}),
    // The floor's identity travels even while a keyed provider serves — the
    // revert button ("Use Whisper instead") and the active(floor) line both
    // need its NAME, which is otherwise only implicit when the floor answers.
    floor: cap.floor
      ? {
          kind: cap.floor.kind,
          ...(cap.floor.provider
            ? { provider: cap.floor.provider, label: PROVIDERS[cap.floor.provider]?.label || cap.floor.provider }
            : {}),
        }
      : null,
    ...(probeable(cap.id) ? { probeable: true } : {}),
    // An env rung is a binding the admin can't see in any key list — say
    // whether the server holds that secret and WHO it belongs to, so the
    // section knows which provider's card offers the env row.
    ...(cap.env ? { env: { configured: !!process.env[cap.env.secret], provider: cap.env.provider, var: cap.env.secret } } : {}),
    ...(cap.rebindWarning ? { rebindWarning: cap.rebindWarning } : {}),
    ...(cap.floor?.kind === "delegate" ? { delegatesTo: cap.floor.to } : {}),
    ...(cap.binding.boardKeys ? { boardOverrides: await countBoardOverrides(db, cap.binding.boardKeys.keyId) } : {}),
    ...(cfg ? { config: cap.binding.config.map((f) => ({ key: f.key, value: cfg[f.key] })) } : {}),
    ...(modifiers.length ? { modifiers } : {}),
  };
}

// A connector domain as a capability entry — GENERATED from listConnectors().
// Same five states; `blocked` here means the serving provider needs a key it
// doesn't have (activeProvider resolves regardless of keys, but every call
// would fail — same meaning as a keyless tagger: a configured target that
// cannot serve until a key arrives).
async function domainEntry(db, c, catalog) {
  // One reader of stored-vs-effective (connectors/runtime.js standing) — shared
  // with the Plugins payload's slots.domains, so the two cannot disagree.
  const { setting, effective } = await getConnector(c.name).standing(db);
  const roster = catalog
    .filter((p) => p.kind === "connector" && p.segment === c.name)
    .map((p) => ({
      name: p.name,
      label: p.label,
      installed: p.state.installed,
      needsKey: !!p.connector?.needsKey,
      hasKey: !!p.state.hasKey,
      health: p.state.health || null,
    }));
  const labelOf = (name) => roster.find((r) => r.name === name)?.label || name;

  let state;
  let reason = null;
  if (!effective) {
    state = "unavailable";
    reason = `no ${c.label} provider is installed`;
  } else if (setting && setting !== effective.name) {
    // The sibling scan took over — the connector runtime's own degraded state,
    // surfaced instead of silently absorbed.
    state = "degraded";
    reason = `${labelOf(setting)} can't serve — ${labelOf(effective.name)} took over`;
  } else if (effective.provider.needsKey && !effective.apiKey) {
    state = "blocked";
    reason = `${labelOf(effective.name)} needs an API key`;
  } else {
    state = "active";
  }

  return {
    id: c.name,
    kind: "domain",
    label: c.label,
    blurb: c.description || "",
    state,
    viaFloor: false,
    reason,
    scope: "global",
    bound: { provider: setting },
    running: effective ? { provider: effective.name } : null,
    supportedBy: roster,
    demand: null,
  };
}

// The two `select:"all"` capabilities — every installed supplier serves at
// once, nothing binds, so the state is always active. They are here so the page
// answers "what can this instance do" from one payload.
const ingestEntry = (catalog) => ({
  id: "ingest",
  kind: "always-on",
  label: "File ingestion",
  blurb: "the file types the app accepts, previews, and tags",
  state: "active",
  viaFloor: false,
  select: "all",
  handlers: catalog
    .filter((p) => p.kind === "media")
    .map((p) => ({ name: p.name, label: p.label, extensions: p.capabilities.extensions })),
});

async function sourceEntry(db, catalog) {
  // listSources computes per-source readiness (the folder entry honestly
  // reports a missing INGEST_ROOT) — but only for INSTALLED sources; the
  // catalog carries the full roster.
  const ready = new Map((await listSources(db)).map((s) => [s.type, s.ready]));
  return {
    id: "source",
    kind: "always-on",
    label: "Ingestion sources",
    blurb: "where boards can feed themselves files from",
    state: "active",
    viaFloor: false,
    select: "all",
    sources: catalog
      .filter((p) => p.kind === "source")
      .map((p) => ({
        name: p.name,
        label: p.label,
        core: !!p.core,
        installed: p.state.installed,
        connectionCount: p.state.connectionCount ?? null,
        ready: ready.get(p.name) ?? null, // null = not installed, nothing to be ready
      })),
  };
}

export async function capabilityStatus(db) {
  const catalog = await pluginCatalog(db);
  const out = [];
  for (const cap of CAPABILITY_DEFS) {
    if (cap.modifierOf) continue; // renders inside its parent, never as a row
    out.push(await aiEntry(db, cap, catalog));
  }
  for (const c of listConnectors()) out.push(await domainEntry(db, c, catalog));
  out.push(ingestEntry(catalog));
  out.push(await sourceEntry(db, catalog));
  return out;
}
