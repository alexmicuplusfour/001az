// The learners (planning/metering-plan.md, Stage 3b): the two rungs that
// FETCH. The community learner pulls LiteLLM's public price map and resolves
// the models pricing.js wants; the provider learner asks each connected
// provider's wire what its models cost (listPrices — OpenRouter answers, most
// return null). Both hand rows to setModelPrices, which owns the
// store-then-rebuild consequence; rating itself stays in pricing.js and this
// module never answers a rate to anyone.
//
// Runs on the worker's hourly maintenance tick and gates its own network:
// the map is pulled when a wanted model hasn't been looked up yet, or when
// the stored rows are older than MODEL_PRICE_REFRESH_DAYS; providers are
// asked on the same staleness cadence. A failed fetch keeps the last good
// rows and warns — prices are never load-bearing (the pricing.js posture),
// so nothing here ever throws into the sweep.
import { PROVIDERS } from "./providers.js";
import { wantedModels, setModelPrices } from "./pricing.js";
import { loadModelPrices, modelPriceFreshness, listAiKeys } from "./db.js";
import { validRate } from "./units.js";

// Dollars-per-unit → micro-dollars per unit, the rate map's unit of account
// (metering-plan.md). BOTH rungs land here: a wire reports what its vendor
// stated, in the vendor's unit, and the app's unit of account is converted to
// in exactly one place. toPrecision sheds float-times-1e6 noise
// (0.8340000000000001 → 0.834) so a stored NUMERIC reads like the rate it is.
const dollarsToMicros = (dollars) => Number((dollars * 1e6).toPrecision(12));

// Runtime fetch, nothing vendored — the licensing answer for an open-source
// app (metering-plan.md). Empty = the community rung is OFF (air-gapped
// installs); the admin, provider, and descriptor rungs still price as ever.
const DEFAULT_SOURCE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const sourceUrl = () => process.env.MODEL_PRICE_SOURCE_URL ?? DEFAULT_SOURCE_URL;
const refreshMs = () => Math.max(1, Number(process.env.MODEL_PRICE_REFRESH_DAYS) || 7) * 86400000;

// LiteLLM's cost fields → our units. Dollars-per-unit × 1e6 = micros-per-unit
// (the same convenient identity the whole rate map is built on).
//
// `input_cost_per_request` is why there is no "chat models bill per token, so
// requests are free" rule here: the map DECLARES per-request pricing where it
// exists, and the four models that use it today (Perplexity's online sonar
// models) are `mode: "chat"` charging $0.005 a call. Inferring free requests
// from the modality would have stamped those $0 — the same mistake Stage 3a
// reversed twice, and this time it produces a wrong bill rather than a
// stylistic wart. A model the map is silent about meters its requests
// unpriced, which is what the unpriced remainder is for.
//
// NOT mapped, deliberately — one list, because every entry here is the same
// judgement and the next field to arrive needs one place to be weighed against:
//
//   `search_context_cost_per_query`  an object of context sizes
//                                    (low/medium/high); picking one is a guess.
//   `output_cost_per_second`         prices GENERATED media (TTS, video), not
//   `output_cost_per_image`          the audio/images a call was HANDED. One
//                                    word from the fields we DO read, and the
//                                    map carries more of the output ones than
//                                    the input ones (104 vs 90 seconds; 199 vs
//                                    118 images), so the wrong pick is easy
//                                    and silent.
//   `input_cost_per_pixel`           the same money quantized differently;
//   `input_cost_per_image_token`     converting needs dimensions the map
//                                    does not state.
//   `input_cost_per_image`           see below — it restates a token price
//                                    rather than adding to it.
//
// `input_cost_per_image` was mapped to `images` for one day in Stage 5c and
// taken back out, which is worth recording because the field LOOKS like the
// exact peer of input_cost_per_second. Measured against the live map
// (2026-08-31): 118 models carry it, 48 alongside a non-zero token price, and
// of those only 6 are `mode: "chat"` — the class a vision-model detector lands
// in. All six are OpenRouter/Anthropic, and every figure is the token price
// restated: 1600 image-tokens × $3/M = exactly the $0.0048 published for
// claude-sonnet-4.5. Metering an image AND the tokens that already contain it
// would bill the same money twice into a cost_micros nothing recomputes. The
// other 42 are embedding and image-generation models, where the per-image
// price IS additive — but this app meters `images` on neither path, so
// importing it there is a rate nothing can multiply.
//
// Which leaves no model where reading this field is both safe and useful, and
// the `images` UNIT is unaffected: the meter records the quantity, and the
// admin and descriptor rungs price it when someone actually knows the rate.
// The openrouter descriptor reached the same verdict about the same money from
// the other direction ("a rate we can't attribute is noise") — and that a rule
// forbidding inference from `mode` is what stops the narrower fix here is the
// tell that the field, not the filter, was the problem.
const LITELLM_FIELDS = {
  input_cost_per_token: "input_tokens",
  output_cost_per_token: "output_tokens",
  cache_read_input_token_cost: "cache_read_tokens",
  input_cost_per_request: "requests",
  input_cost_per_second: "audio_seconds", // whisper-1: $0.0001/s = the published $0.006/min
};

// In-memory cadence state. Deliberately per-process — a restart re-pulls one
// public JSON file at worst, and `now` is a parameter so tests drive the
// clock instead of resetting module state.
let mapPulledAt = 0; // last SUCCESSFUL pull — a failure retries next tick
let tried = new Set(); // wanted keys looked up in the last pull: a model the map lacks must not re-trigger hourly pulls
const askedAt = new Map(); // provider -> last listPrices attempt (success or not — a flaky box is re-asked next period, not next tick)

const wantKey = (w) => `${w.provider}\u0000${w.model}`;

// One wanted model against the map: its bare id, or namespaced under the
// descriptor's declared community namespace — and in either spelling the
// entry must BELONG to that namespace. A self-hosted box serving "llama3"
// has no namespace, is never even looked up, and can't inherit hosted llama3
// prices (the trap, metering-plan.md).
function communityRows(map, wants) {
  const rows = [];
  for (const w of wants) {
    const ns = PROVIDERS[w.provider]?.priceNamespace;
    if (!ns) continue;
    const entry = [map[w.model], map[`${ns}/${w.model}`]].find((e) => e && e.litellm_provider === ns);
    if (!entry) continue;
    for (const [field, unit] of Object.entries(LITELLM_FIELDS)) {
      // typeof, not Number(): a null or string cost is schema drift, and
      // coercing it would turn "we don't know" into a $0 knowledge claim.
      // validRate is the shared rule (units.js) — same one the descriptor
      // rung and the admin route hold.
      if (typeof entry[field] === "number" && validRate(entry[field]))
        rows.push({ provider: w.provider, model: w.model, unit, microsPerUnit: dollarsToMicros(entry[field]) });
    }
  }
  return rows;
}

async function pullCommunity(freshness, current, now, force) {
  const url = sourceUrl();
  if (!url) return [];
  // Resolve wanted models AND every model already community-priced — a priced
  // model leaves the wanted set (that's the drain), so without the second half
  // a weekly refresh would pull the map and then update nothing.
  const priced = new Set(current.filter((r) => r.source === "community").map(wantKey));
  const wants = new Map([...wantedModels(), ...current.filter((r) => r.source === "community")].map((w) => [wantKey(w), w]));
  // "Untried" means never LOOKED UP and not already priced. Without the second
  // half, a restart (which empties `tried`) would re-pull the whole map on its
  // first tick forever, since the stored rows themselves put every priced
  // model back into `wants`. Being already priced IS having been tried.
  const untried = [...wants.keys()].some((k) => !tried.has(k) && !priced.has(k));
  // Two clocks, and both are needed: `mapPulledAt` because an unchanged
  // refresh writes nothing and so never advances fetched_at, `storedAt`
  // because mapPulledAt is per-process and must not re-pull after a restart.
  const storedAt = Math.max(0, ...freshness.filter((f) => f.source === "community").map((f) => f.at));
  if (!force && !untried && now - Math.max(mapPulledAt, storedAt) < refreshMs()) return [];
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  const map = await r.json();
  mapPulledAt = now;
  tried = new Set(wants.keys());
  return communityRows(map, wants.values());
}

// Ask every CONNECTED provider whose wire can answer — no reason to poll a
// provider nobody configured. The whole catalog is stored, not just wanted
// models: OpenRouter prices ~300 models in one public call, and storing them
// all means a board's newly-picked model is priced from its first paid call
// instead of after a wanted-set round trip. Asked at the descriptor's own
// base, keyless — prices are provider-level facts, not connection-level, and
// the one real answerer today lists publicly. A provider that demands auth
// throws, is warned about, and is re-asked next period.
async function askProviders(db, freshness, now, force) {
  // Grouped by provider because that is how prices are STORED (model_prices
  // has no connection dimension, and neither does the meter) — but ASKED
  // through a real connection, with its key and its base_url. A self-hosted
  // or plugin provider's descriptor `base` is only the form's placeholder, so
  // asking there would poll a host the user never configured. First
  // connection that answers wins; the rest of that provider's are not asked.
  const byProvider = new Map();
  for (const k of await listAiKeys(db)) {
    if (typeof PROVIDERS[k.provider]?.wire?.listPrices !== "function") continue;
    if (!byProvider.has(k.provider)) byProvider.set(k.provider, []);
    byProvider.get(k.provider).push(k);
  }
  const storedAt = new Map(freshness.filter((f) => f.source === "provider").map((f) => [f.provider, f.at]));
  const due = [...byProvider].filter(([p]) => force || now - Math.max(askedAt.get(p) || 0, storedAt.get(p) || 0) >= refreshMs());
  // Concurrent: the providers are independent, and asking them in series
  // would add up their timeouts on the caller's clock.
  const answers = await Promise.all(due.map(async ([p, keys]) => {
    askedAt.set(p, now); // set before asking, so a provider that keeps failing isn't re-asked hourly
    for (const k of keys) {
      try {
        const answer = await PROVIDERS[p].wire.listPrices(PROVIDERS[p], { apiKey: k.api_key, base: k.base_url });
        if (answer?.length) return answer.map(({ model, unit, dollarsPerUnit }) => ({ provider: p, model, unit, microsPerUnit: dollarsToMicros(dollarsPerUnit) }));
      } catch (e) {
        console.warn(`price learner: ${PROVIDERS[p].label} listPrices failed via "${k.name}" (kept last good rows): ${e.message}`);
      }
    }
    return [];
  }));
  return answers.flat();
}

// Only rows that CHANGE something are written — a weekly refresh that finds
// the same rates inserts nothing, so every model_prices row stays a real
// change (the tag-snapshot dedupe principle) instead of effective_from churn.
function dropUnchanged(current, rows) {
  const key = (r) => `${r.provider}\u0000${r.model}\u0000${r.unit}\u0000${r.source}`;
  const have = new Map(current.map((r) => [key(r), Number(r.micros_per_unit)]));
  return rows.filter((r) => have.get(key(r)) !== r.microsPerUnit);
}

// The pass the maintenance tick calls. `now` is injectable so tests drive the
// staleness clock; `force` skips the staleness gates for an explicit "refresh
// prices now" (3c's admin route) — the gates exist to pace a background sweep,
// not to refuse a person who asked. Returns how many rates were learned (0 is
// a fine answer: everything already current), or null when the pass itself
// failed — the sweep ignores the return, but a person who clicked Refresh
// deserves the difference between "nothing new" and "it broke".
export async function learnPrices(db, { now = Date.now(), force = false } = {}) {
  try {
    const [freshness, current] = await Promise.all([modelPriceFreshness(db), loadModelPrices(db)]);
    // Each rung fetches independently — community being offline must not stop
    // a provider from answering for itself — and the two are concurrent for
    // the same reason. `source`/`fetchedAt` are stamped once, here, so a rung
    // returns plain rates and a third rung can't get the convention wrong.
    const [community, provider] = await Promise.all([
      pullCommunity(freshness, current, now, force).catch((e) => {
        console.warn(`price learner: community pull failed (kept last good rows): ${e.message}`);
        return [];
      }),
      askProviders(db, freshness, now, force),
    ]);
    const stamp = (rs, source) => rs.map((r) => ({ ...r, source, fetchedAt: now }));
    const fresh = dropUnchanged(current, [...stamp(community, "community"), ...stamp(provider, "provider")]);
    if (fresh.length) {
      await setModelPrices(db, fresh);
      console.log(`price learner: ${fresh.length} rate(s) learned`);
    }
    return fresh.length;
  } catch (e) {
    console.warn(`price learner pass failed: ${e.message}`);
    return null;
  }
}
