// The rating layer (planning/metering-plan.md, Mechanism 2 / Stage 3a): what a
// unit of (provider, model) usage costs, resolved through rungs and answered
// SYNCHRONOUSLY from an in-memory table so stamping a cost adds zero
// round-trips to the worker's hot path.
//
// The rungs, best answer per unit wins:
//   1. admin      — a model_prices row the admin typed in (source='admin')
//   2. provider   — a listPrices wire answer, stored (source='provider'; 3b)
//   3. descriptor — `prices` declared on the provider module, author-time data
//   4. community  — the fetched public map, stored (source='community'; 3b)
//   5. nothing    — the unit meters unpriced; quantity - priced_quantity is
//                   the visible remainder. Never a guess.
//
// This layer knows only what a descriptor SAYS about prices, never what a
// provider IS: "on-device runs on your box, so it's free" is a fact about
// providers, and it lives where provider facts live (providers.js install(),
// which normalizes it into an ordinary `prices` declaration). Nothing here
// reads a capability flag.
//
// The meter never imports this module — rates are handed IN as plain data
// (metering.js joins the two), which is what keeps db.js price-blind and this
// module meter-blind. Rebuilds happen at boot and through setModelPrice;
// between rebuilds the table is immutable, so reads need no locking.
import { PROVIDERS } from "./providers.js";
import { loadModelPrices, addModelPrices } from "./db.js";
import { validRate } from "./units.js";

// "provider\0model" -> { unit: microsPerUnit }. BOTH axes take '*': a
// key(provider, "*") entry is the provider-wide default any rung can write
// (an on-device provider's free rate, an admin's blanket rate), and a '*' UNIT
// is honored by the meter itself (db.js: `rates[u] ?? rates["*"]`). Neither is
// a special case for anything — the same wildcard on two axes.
//
// NUL is the separator because a provider or model id may contain anything
// else; written as an escape so this file stays TEXT to `git grep` (a literal
// NUL byte makes the whole file binary to code search).
let table = new Map();

const key = (provider, model) => `${provider}\u0000${model}`;

// Models that came up without a rate of their own, for a provider whose
// descriptor names a community namespace — the fetch list Stage 3b's learner
// works through. Recorded on lookup, dropped once a price arrives.
const wanted = new Map();
export const wantedModels = () => [...wanted.values()];

// ONE resolution walk — stored rows + the descriptor registry, layers applied
// worst-first so each better rung's per-unit write wins by plain overwrite:
// community (3b) < descriptor < provider (3b) < admin. Kept as the single
// walk on purpose: the rate table (what stamping reads) and priceState (what
// the editor shows) both come from here, so the editor cannot show a rate the
// meter would not stamp.
async function resolveAll(db) {
  const rows = await loadModelPrices(db);
  const out = new Map(); // key(provider, model) -> { provider, model, units: { unit: { micros, source } } }
  const put = (provider, model, unit, micros, source) => {
    const k = key(provider, model);
    let m = out.get(k);
    if (!m) out.set(k, m = { provider, model, units: {} });
    m.units[unit] = { micros, source };
  };
  const layer = (source) => {
    for (const r of rows) {
      if (r.source === source) put(r.provider, r.model, r.unit, Number(r.micros_per_unit), source);
    }
  };
  layer("community");
  for (const [id, desc] of Object.entries(PROVIDERS)) {
    for (const [model, units] of Object.entries(desc.prices || {})) {
      for (const [unit, micros] of Object.entries(units)) put(id, model, unit, micros, "descriptor");
    }
  }
  layer("provider");
  layer("admin");
  return out;
}

// Rebuild the rate table from the stored rows + the descriptor registry.
// Never throws into the caller's boot path — pricing being down means usage
// meters unpriced, which is the designed degradation, not a failure.
export async function refreshRateTable(db) {
  try {
    const resolved = await resolveAll(db);
    const next = new Map();
    for (const [k, m] of resolved) {
      next.set(k, Object.fromEntries(Object.entries(m.units).map(([unit, u]) => [unit, u.micros])));
    }
    table = next;
    // A model whose price just arrived stops being wanted — otherwise 3b's
    // fetcher re-requests it on every sweep, forever.
    for (const k of wanted.keys()) if (next.has(k)) wanted.delete(k);
  } catch (e) {
    console.warn(`price table refresh failed (usage meters unpriced): ${e.message}`);
  }
}

// The resolved map WITH provenance — what the price editor renders (Stage
// 4c). Raw stored rows can't answer either of the editor's questions: what
// will actually be stamped (four rungs overwrite per unit) or where a number
// came from (the descriptor rung is runtime data, never stored). Unlike the
// table rebuild this throws — a route answers 500, it doesn't degrade.
export const priceState = async (db) => [...(await resolveAll(db)).values()];

// The synchronous answer: { unit: microsPerUnit }. {} = nothing known — the
// caller stamps nothing priced.
export function ratesFor(provider, model) {
  const own = table.get(key(provider, model));
  if (!own && provider && model && PROVIDERS[provider]?.priceNamespace) {
    // Only a provider that declared a community namespace can ever be fetched
    // for — a self-hosted box serving "llama3" must NOT inherit hosted llama3
    // prices, so no namespace means no wanting (metering-plan.md, the trap).
    // A provider-wide rate doesn't settle it: it's a default, not this model's
    // price, and the model's own rates are still worth learning.
    wanted.set(key(provider, model), { provider, model });
  }
  // The model's own rates override the provider-wide default, unit by unit.
  return { ...table.get(key(provider, "*")), ...own };
}

// Write prices and make them live. Every price writer goes through here —
// 3b's community fetcher and listPrices learner (batches), 3c's admin route
// (one row) — so none of them has to remember that a stored row does nothing
// until the table is rebuilt, and a batch pays for ONE rebuild, not one per
// row. db.js keeps the raw INSERT; the consequence is owned by the module that
// owns the cache (providers.js's invalidate-through-the-owner rule).
export async function setModelPrices(db, rows) {
  // The choke point every rung already funnels through, so it is also where
  // "a rate is a non-negative finite number" is ENFORCED rather than merely
  // checked at each entrance. A rate reaching the table is multiplied into
  // cost_micros and never recomputed; a fifth rung that forgets to validate
  // must not be able to falsify a billing record.
  const bad = rows.find((r) => !validRate(r.microsPerUnit));
  if (bad) throw new Error(`invalid rate for ${bad.provider}/${bad.model} ${bad.unit}: ${bad.microsPerUnit}`);
  if (!rows.length) return;
  await addModelPrices(db, rows);
  await refreshRateTable(db);
}
export const setModelPrice = (db, row) => setModelPrices(db, [row]);
