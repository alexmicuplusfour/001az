// The live catalog of a sidecar-backed engine — ONE source, every reader
// (model-axis-plan.md slice 1).
//
// A sidecar owns its own model list: what it serves is baked into its image at
// build, so the app never declares it and the offer cannot drift from what is
// actually installed. That answer has to reach BOTH admin surfaces:
//
//   GET /api/admin/plugins        the engine's card (the note under its name)
//   GET /api/admin/ai-providers   the board modal's per-board picker
//
// It used to be a closure inside the plugins route, so only the card saw it —
// the board picker read `providerCatalog()`, the STATIC descriptor catalog,
// which for whisper is deliberately empty. A per-board model choice was
// therefore impossible to offer no matter what the sidecar reported.
//
// Nothing here names an engine. A descriptor declares `liveCatalog` — which
// capability it serves, where its /health answers, what note its models carry
// — and this module asks whoever declared one. A dropped-in plugin sidecar
// that advertises three models therefore grows a picker for free, on the same
// rail as a built-in; adding one stays "one descriptor", as providers.js says.
import { PROVIDERS } from "./providers.js";

const sidecars = () => Object.entries(PROVIDERS).filter(([, d]) => d.liveCatalog);

// Where a sidecar-backed provider answers — its own descriptor says, the way a
// keyed provider declares its base URL. worker.js's engines read this too, so
// the address is stated once and a redeploy can't move one and not the other.
export const sidecarUrl = (provider) => PROVIDERS[provider]?.liveCatalog?.url() || null;

// ONE /health read per sidecar, cached ~60s — failures included, so an admin
// page reload doesn't re-time-out against a down sidecar on every hit. Every
// reader shares it (the catalogs below, the capabilities page's running line,
// the probe toast, presence below), so a request costs at most one round trip
// per engine.
//
// The cache holds the probe's PROMISE, stamped at probe start: presence put
// this on the resolution hot path (one ask per claimed item), where concurrent
// cache misses against a down-but-routing host would otherwise each burn the
// full 2s timeout instead of sharing one.
const health = new Map();
export async function sidecarHealth(provider) {
  const url = sidecarUrl(provider);
  if (!url) return null;
  const hit = health.get(provider);
  if (hit && Date.now() - hit.at < 60000) return hit.body;
  const body = (async () => {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
      // Drain the refused body: an abandoned one holds its socket until GC.
      await res.body?.cancel();
      return null;
    } catch { return null; /* down/unreachable — callers fall back */ }
  })();
  health.set(provider, { at: Date.now(), body });
  return body;
}

// Tests flip presence mid-file (a stand-in box goes down, an env URL moves) and
// the TTL would otherwise carry the stale answer across that line. `seed` is
// its twin: state what an engine reports without standing one up, for tests
// that drive an engine's protocol through their own fetch stub and must not
// have a /health probe land in that stub's call ledger.
export const clearSidecarHealth = () => health.clear();
export const seedSidecarHealth = (provider, body) => health.set(provider, { at: Date.now(), body });

// Is the engine actually on this machine? true/false for a sidecar-backed
// provider, null for anything else — so callers ask unconditionally, the
// `sidecarDefaultModel` convention. "Present" = /health answered inside the
// probe budget; a hang, a refusal, or a 5xx all read absent, which under the
// resolver's blocked semantics is a short wait, never a wrong answer.
export async function sidecarPresent(provider) {
  if (!sidecarUrl(provider)) return null;
  return !!(await sidecarHealth(provider));
}

// Presence for EVERY sidecar-backed engine at once, probed concurrently — the
// sidecarCatalogs shape, for the same reason: a serial reader (the
// capabilities feed walks its entries one by one) must pay one cold-cache
// timeout for N down engines, not N. Callers that then ask per provider hit
// the warmed cache.
//
// Built out of sidecarPresent, not out of sidecarHealth: "present" is defined
// once, above, so the resolver's floor gate and the admin card can never come
// to different conclusions about the same engine. Concurrency is unaffected —
// sidecarHealth starts its fetch before it yields, so every probe is in flight
// before the first await here.
export const sidecarPresenceMap = async () =>
  new Map(await Promise.all(
    sidecars().map(async ([name]) => [name, (await sidecarPresent(name)) ?? false])));

// The sidecar's DEFAULT model as a bare string. Null for a provider that isn't
// sidecar-backed, which is what lets callers ask unconditionally instead of
// testing first against a second table of which engines are local.
export async function sidecarDefaultModel(provider) {
  return (await sidecarHealth(provider))?.model || null;
}

// /health → the admin catalog shape. An image that predates the model axis
// reports only `model`; that reads as a one-model catalog, which is exactly
// what keeps the picker hidden for it.
//
// The note rides the CATALOG, not each model: "runs on-server · no API key" is
// a fact about the engine, and stamping it on every option made a two-model
// dropdown repeat the same sentence twice while saying nothing about either
// model. A keyed provider's notes stay per-model, because there they genuinely
// differ (speed, price, context).
function catalogOf(body, note) {
  const models = (Array.isArray(body?.models) ? body.models : [body?.model]).filter(Boolean);
  if (!models.length) return null;
  return { default: body.model || models[0], models: models.map((id) => ({ id })), note };
}

// provider name → { cap, catalog } for every sidecar-backed engine that
// answered. An unreachable sidecar is simply ABSENT: its consumers keep the
// descriptor's own declaration, and a picker that offers only what was
// reported hides rather than offering a model that may not serve. A board's
// stored pin is untouched either way — the choice hides, it is never destroyed.
// Probed concurrently: two down sidecars must cost one timeout, not two.
export async function sidecarCatalogs() {
  const entries = sidecars();
  const bodies = await Promise.all(entries.map(([name]) => sidecarHealth(name)));
  const out = new Map();
  entries.forEach(([name, desc], i) => {
    const catalog = catalogOf(bodies[i], desc.liveCatalog.note);
    if (catalog) out.set(name, { cap: desc.liveCatalog.cap, catalog });
  });
  return out;
}

// Overlay the live catalogs onto an admin feed. The two feeds shape their
// entries differently (a provider row carries `provides`; a plugin carries it
// under `ai`), so the caller passes a locator that returns the holder to write
// — already detached from the registry, because both feeds hand out objects
// shared with memoized defs and mutating one in place would rewrite the
// registry itself. The MERGE stays here: a card and a picker can then never
// disagree about what an engine serves.
export function applySidecarCatalogs(live, holderFor) {
  for (const [provider, { cap, catalog }] of live) {
    const holder = holderFor(provider);
    if (holder) holder.provides = { ...holder.provides, [cap]: catalog };
  }
}
