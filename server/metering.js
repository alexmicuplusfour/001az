// The metering adapters (planning/metering-plan.md, Stages 1–3): the layer that
// joins the price-blind meter mechanism (db.js) to the meter-blind rating layer
// (pricing.js). Spenders import from HERE; db.js keeps the mechanism and
// pricing.js keeps the rungs, and neither imports the other — which is what
// lets rate resolution read the provider registry without db.js growing a
// dependency cycle.
//
// `meterSpend` is the generic join and takes any spender's units; the
// meterAiCall/meterAiCalls/spentDetail projections below it are the AI-shaped
// ones. Stage 5d made that distinction load-bearing rather than theoretical —
// the connector runtime spends here too, and it has no wire `usage` at all.
import { meter, meterWrite, usageRows, priceUnpricedMeter, rateOf } from "./db.js";
import { ratesFor } from "./pricing.js";
import { meterAs } from "./capabilities.js";

// One walk over a round's usages, and the ONE place that names the wire's
// fields. Both projections below read it, so a renamed or added bucket lands
// in a single spot instead of half-landing in one of two translations.
const sumUsage = (usages) => usages.reduce((t, u) => ({
  input: t.input + (Number(u?.input) || 0),
  output: t.output + (Number(u?.output) || 0),
  cacheRead: t.cacheRead + (Number(u?.cacheRead) || 0),
  searches: t.searches + (Number(u?.searches) || 0),
}), { input: 0, output: 0, cacheRead: 0, searches: 0 });

// Projection 1 — a round of paid calls as meter units. `requests` counts the
// PAID CALLS, which is what keeps every per-call average read off this table
// honest. Private: every spender reaches it through the two helpers below, so
// `input → input_tokens` is named here and nowhere else. It was briefly
// exported for the legs that ALSO spend a unit of their own — which turned
// `{ ...callUnits([usage]), <unit>: n }` into three hand-written copies of one
// shape. `extra` below is that shape, once.
const callUnits = (usages) => {
  const u = sumUsage(usages);
  return {
    requests: usages.length,
    input_tokens: u.input,
    output_tokens: u.output,
    cache_read_tokens: u.cacheRead,
    web_searches: u.searches,
  };
};

// The bare join — any spender's units, rated and written. The rate lookup is
// synchronous off pricing's in-memory table (stamping cost adds no
// round-trip; an unknown model just stamps nothing priced), and the write
// rides meterWrite so a metering failure never breaks the work it observes.
//
// No pricing RULES live here, only the join: this module may not know how any
// vendor bills. "Anthropic charges for tokens, not calls" is a fact about
// Anthropic and is stated by anthropic.js (`requests: 0`) — inferring it here
// from "we happen to know some other rate" would read a descriptor's silence
// as $0 in one place while the same silence about web_searches means unpriced
// in another.
//
// `dims.capability` is the work's id as the SPENDER holds it — a job kind or
// a capability — and lands through meterAs: a kind maps to what KIND_DEFS
// declares its paid legs meter as, anything else passes through unchanged.
// Applied HERE, at the one join every spender rides, so the vocabulary table
// is consulted by construction — a call site can't restate the link wrongly,
// and a kind whose billing home changes moves every spender at once.
export function meterSpend(db, boardId, dims, units) {
  // Normalized ONCE: the row is filed under this model and rated under it too.
  // They used to disagree — the write said `dims.model ?? ""` while the lookup
  // passed the raw value, so a spender with no model at all (Stage 5d's
  // connector requests; the whisper sidecar before its first done payload)
  // filed under `provider\0''` and priced under `provider\0undefined`. Masked
  // so far, because the only rates those providers carry are the `*` wildcard,
  // which matches either spelling — but a rate written for the empty model
  // could never have reached the rows it belongs to.
  const model = dims.model ?? "";
  return meterWrite(() => meter(
    db, { boardId, ...dims, capability: meterAs(dims.capability), model },
    units,
    ratesFor(dims.provider, model)
  ));
}

// N paid calls that share an attribution — a vote round's passes, which differ
// only in what they spent. They fold into ONE row per unit anyway (identical
// PK), so summing here trades N round-trips for one without changing a single
// stored number; `requests` still counts the calls, not the items. A
// projection over the join above: the wire's usage shape becomes meter units
// here.
//
// `extra` is what the SPENDER spent in units of its own, beside whatever the
// wire reported — the transcribe leg's audio seconds, the detect leg's image.
// It rides here rather than at each call site because a leg that builds its own
// units object has to name the wire's fields a second time to do it, and that
// is precisely how a renamed bucket half-lands. Anything it names wins over the
// projection, which is what lets a spender correct a wire it knows is lying.
export function meterAiCalls(db, boardId, dims, usages = [], extra = {}) {
  if (!usages.length) return Promise.resolve(null);
  return meterSpend(db, boardId, dims, { ...callUnits(usages), ...extra });
}

// One paid AI call — the same path, a round of one. Everything takes an array
// so there is exactly one answer to "one or many" in this file.
export const meterAiCall = (db, boardId, dims, usage = {}, extra = {}) =>
  meterAiCalls(db, boardId, dims, [usage], extra);

// The plan's "price unpriced history" admin action (metering-plan.md — the
// additive escape hatch it reserved "if the pain is real"; a $22 opus-5 run
// reading ≈$0 was the pain, 2026-09-04). Stamp the rates known NOW onto
// usage that metered before any rung knew one. Additive only: priced history
// is never rewritten (write-time stamping stays the law), and pairs no rung
// prices stay honestly unpriced — a rate row is built only where one exists,
// so the pre-meter backfill's ''-provider rows resolve to nothing and are
// never touched. The unit fallback is meter()'s own `rateOf`, called rather
// than restated, so a provider-wide wildcard prices history exactly as it
// would have priced the call — including at 0, the knowledge claim. NOT
// routed through meterWrite: this is a person's explicit act, and a failure
// belongs in their face, not a server log.
export async function priceUnpricedHistory(db) {
  const rows = [];
  for (const r of await usageRows(db, { group: ["provider", "model"] })) {
    // Pairs with nothing owing are skipped BEFORE the rate lookup: ratesFor is
    // not a pure read — it records a want for any namespaced pair carrying no
    // rates of its own — and a fully-priced pair has no business teaching the
    // learner anything. It also keeps the rate list down to rows the
    // statement can actually use.
    if (!Object.values(r.units).some((u) => u.quantity > u.priced_quantity)) continue;
    const rates = ratesFor(r.provider, r.model);
    for (const [unit, u] of Object.entries(r.units)) {
      const micros = rateOf(rates, unit);
      if (u.quantity > u.priced_quantity && micros != null)
        rows.push({ provider: r.provider, model: r.model, unit, micros });
    }
  }
  return priceUnpricedMeter(db, rows);
}

// Projection 2 — what served a paid call and what it cost, in the shape the
// job row's `detail` carries it (metering-plan.md Stage 2). The legs that bill
// spread this rather than each spelling the trio out, so the meter's
// dimensions and the row's claim about them cannot drift: both read the same
// `dims` and the same usages.
//
// `tokens` is dropped when the call reported nothing (a keyless engine, the
// local embedder) so the row stamps no zeros, and `provider` when there was no
// model call at all — absent, not empty, the house rule.
export function spentDetail({ provider, model }, usages) {
  const u = sumUsage(usages);
  const tokens = u.input || u.output || u.cacheRead
    ? { in: u.input, out: u.output, ...(u.cacheRead ? { cache: u.cacheRead } : {}) }
    : null;
  return { model, ...(provider ? { provider } : {}), ...(tokens ? { tokens } : {}) };
}
