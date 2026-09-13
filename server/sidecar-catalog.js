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

// What each sidecar last said, as a plain value: the /health body, or null for
// "did not answer". NOT a promise and NOT a TTL — reading this map never
// touches the network, which is the whole point (sidecar-presence-latency-plan.md).
//
// It used to be a lazy cache: first reader after a 60s expiry paid the probe,
// and since the readers are all admin routes and the resolution hot path, that
// reader was always a page. Against a host that ACCEPTS and never answers — a
// compose hostname whose service was excluded from the stack — that is the
// full 2s budget below, measured at 2075ms on the capabilities feed and
// 2015ms on the single-capability route the boards strip uses, which has no
// sidecar of its own to wait for.
//
// So absence stopped being something a request discovers. The watch loop at the
// bottom of this file is the only thing that ever probes; everyone else reads
// what it left. An entry that is MISSING (nothing probed yet) reads exactly
// like one that is null: absent. That is the safe direction — the resolver
// treats an absent floor as blocked, so the item waits and requeues rather than
// failing — and startSidecarWatch() awaits its first sweep before the listener
// opens, so in a real server there is no unprobed window to fall into.
const health = new Map();

// Async, though it no longer awaits anything: every caller is already `await`ing
// it and the signature is what keeps this change from touching six call sites.
export async function sidecarHealth(provider) {
  if (!sidecarUrl(provider)) return null;
  return health.get(provider) ?? null;
}

// ONE /health read, with the budget every reader used to pay inline.
async function probe(provider) {
  try {
    const res = await fetch(`${sidecarUrl(provider)}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return await res.json();
    // Drain the refused body: an abandoned one holds its socket until GC.
    await res.body?.cancel();
    return null;
  } catch { return null; /* down/unreachable — callers fall back */ }
}

// Every engine at once. Concurrent because a host missing both sidecars must
// cost one timeout rather than two — the only place that reasoning still lives,
// now that no request is behind it. Exported for the watch below and for tests
// that stand up real stand-in boxes and want the map to reflect them.
export async function sweepSidecars() {
  const names = sidecars().map(([name]) => name);
  const bodies = await Promise.all(names.map(probe));
  names.forEach((name, i) => health.set(name, bodies[i]));
  return health;
}

// Tests flip presence mid-file (a stand-in box goes down, an env URL moves).
// `seed` is its twin: state what an engine reports without standing one up, for
// tests that drive an engine's protocol through their own fetch stub and must
// not have a /health probe land in that stub's call ledger. Both are plain
// writes to the map above — with no lazy fetch behind it, what a fixture puts
// in is exactly what every reader sees, for as long as it sits there. The TTL
// that used to expire mid-file under CI load is gone with the laziness.
export const clearSidecarHealth = () => health.clear();
export const seedSidecarHealth = (provider, body) => health.set(provider, body);

// Is the engine actually on this machine? true/false for a sidecar-backed
// provider, null for anything else — so callers ask unconditionally, the
// `sidecarDefaultModel` convention. "Present" = /health answered inside the
// probe budget; a hang, a refusal, or a 5xx all read absent, which under the
// resolver's blocked semantics is a short wait, never a wrong answer.
export async function sidecarPresent(provider) {
  if (!sidecarUrl(provider)) return null;
  return !!(await sidecarHealth(provider));
}

// Presence for EVERY sidecar-backed engine at once — the shape the capabilities
// feed wants, so it can walk its entries serially without asking per engine.
// A read of held state now; it used to be the one concurrent probe round that
// the whole feed's latency hung on.
//
// Still built out of sidecarPresent rather than the map directly: "present" is
// defined once, above, so the resolver's floor gate and the admin card can
// never come to different conclusions about the same engine.
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
// Reads what the watch left; the Promise.all is now just shape, not latency.
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

// --- the watch ---
//
// The only thing in this process that probes. Started by server.js inside its
// `isMain` block, beside startWorker — which is the seam that already means
// "a real server process, never a test": under test the module is imported for
// its app/db exports and nothing in that block runs, so the map stays whatever
// a fixture put in it and no stray /health lands in anyone's call ledger.
//
// The loop shape is worker.js's, not a setInterval: sleep in a timeout that a
// wake() can cut short, and re-check the flag after waking so stop() is prompt.
// The timer is unref'd — the listener is what should hold the process open, and
// a watch that outlives it would be the only thing keeping a shut-down server
// alive for up to one interval.
let watching = false;
let wake = null;
// Which loop is the live one. stop() cannot interrupt a sweep already in flight
// (a probe holds its full budget), so a stop immediately followed by a start
// would otherwise leave the OLD loop to finish its sweep, re-read a `watching`
// that is true again, and carry on beside the new one — two loops probing,
// with only one stoppable. Each loop keeps the generation it was born with and
// exits the moment that stops being the current one.
let generation = 0;

// Returns the FIRST sweep, so the caller can await it before opening a
// listener: boot pays one probe round — 2s on a host with neither engine, with
// nobody waiting on it — and every request afterwards reads a filled map. That
// await is what makes "nobody waits" an invariant rather than a race won by
// warming the cache in time.
export function startSidecarWatch() {
  if (watching) return Promise.resolve(health);
  watching = true;
  // Read at START, the POLL_MS convention — so the cadence is a property of
  // this run rather than of when the module happened to be imported.
  const WATCH_MS = Number(process.env.SIDECAR_WATCH_MS) || 30000;
  const FAST_MS = Number(process.env.SIDECAR_WATCH_FAST_MS) || 2000;
  // How long the fast cadence is worth paying for. 180s because that is the
  // object-detector's own healthcheck start_period — the number its image
  // already declares as "this may take a while to come up".
  const WARMUP_MS = Number(process.env.SIDECAR_WATCH_WARMUP_MS) || 180000;
  const startedAt = Date.now();

  // Two cadences, and the whole rule is one line: look often while an engine is
  // MISSING and we are still early enough that it might just be starting.
  //
  // `compose up` starts everything at once, and a model sidecar is not ready for
  // tens of seconds — it has to import torch and load weights. At one fixed 30s
  // cadence the app spends up to half a minute reporting an engine as
  // unavailable after it has come up, which is what a reader actually notices.
  //
  // Bounded on purpose, and this is the part that keeps it honest: a host that
  // simply does not deploy these engines (the common self-hosted case) must not
  // probe two dead addresses every two seconds forever. After the warm-up it
  // settles to the steady cadence and stays there, so the fast phase is a
  // startup cost paid once per process, not a standing one.
  const nextDelay = () =>
    Date.now() - startedAt < WARMUP_MS && sidecars().some(([n]) => !health.get(n))
      ? FAST_MS
      : WATCH_MS;

  const first = sweepSidecars().then((m) => {
    const said = sidecars().map(([n]) => `${n} ${m.get(n) ? "up" : "absent"}`).join(", ");
    if (said) console.log(`sidecars: ${said} (re-probed every ${Math.round(nextDelay() / 1000)}s)`);
    return m;
  });
  const mine = ++generation;
  (async () => {
    await first;
    while (watching && generation === mine) {
      await new Promise((r) => {
        const t = setTimeout(r, nextDelay());
        t.unref?.();
        wake = () => { clearTimeout(t); r(); };
      });
      if (!watching || generation !== mine) break;
      await sweepSidecars(); // probe() swallows its own failures; a sweep cannot reject
    }
  })();
  return first;
}

export function stopSidecarWatch() {
  watching = false;
  generation++; // retire the live loop even if it is mid-sweep and cannot hear this yet
  wake?.();
}
