// The metering vocabulary (planning/metering-plan.md): what a billable UNIT
// is, and what a RATE is. Pure data and pure predicates, no imports — the
// CAPABILITY_DEFS pattern, and for the same reason: everything from the meter
// to the rate map to the client's tooltip needs to agree about these, and a
// registry nothing imports can be read by all of them without a cycle.
//
// Why this exists at all: before it, a unit id was spelled independently in
// five places (the AI adapter's translation, three reader pivots, the
// community importer's field map, a descriptor's priceFields) and NAMED
// nowhere. So when a surface needed to say "1,200 input tokens are unpriced"
// it invented English from the id — which is the mistake Stage 0 already made
// once with a prose capability list and reverted in Stage 1: a client
// statement about a growing server-side vocabulary cannot be kept true. The
// server sends the units, their labels, and how to format them; the client
// renders what it is handed.

// The two frames a price is quoted in. `per` is how many units the quote
// covers; `label` names it. Tokens are quoted per million everywhere this app
// fetches prices from — which is exactly WHY micro-dollars per unit and
// dollars per million are the same number — while a call or a search is
// quoted each.
const PER_MILLION = { per: 1e6, label: "$/M" };
const EACH = { per: 1, label: "$ ea" };
// Audio is quoted per minute (OpenAI publishes whisper at $0.006/min) but
// STORED per second — the map's input_cost_per_second is dollars per second,
// so micros-per-unit stays per-single-unit like every other rate and only the
// display frame scales.
const PER_MINUTE = { per: 60, label: "$/min" };

// `format` is a display KIND, not a formatter — the same trick paged-table.js
// uses for its columns. The client maps a kind to a function; the server never
// knows what a token looks like on screen. It describes a QUANTITY.
//
// `rate` answers a different question and is deliberately its own field: what
// a PRICE for this unit is quoted per. That is a BILLING fact, not a display
// one — it decides what an admin's typed "3" is multiplied by on its way to a
// stored rate — so it is declared here rather than inferred from `format`
// being "tokens". Inferring it is how a rate lands a factor of a million out,
// and validRate cannot catch that: 1e6 times a valid rate is still valid, and
// the result is the falsified billing record this file's last comment calls
// unfixable. The two happen to line up today; that is a coincidence, not a
// rule, and a unit that renders as tokens but bills per call would break it.
export const UNIT_DEFS = {
  requests:          { label: "calls",             format: "count",    rate: EACH },
  input_tokens:      { label: "input tokens",      format: "tokens",   rate: PER_MILLION },
  output_tokens:     { label: "output tokens",     format: "tokens",   rate: PER_MILLION },
  cache_read_tokens: { label: "cached reads",      format: "tokens",   rate: PER_MILLION },
  web_searches:      { label: "web searches",      format: "count",    rate: EACH },
  audio_seconds:     { label: "audio",             format: "duration", rate: PER_MINUTE },
  images:            { label: "images",            format: "count",    rate: EACH },
  // Connector traffic, kept as its OWN unit rather than folded into `requests`
  // — and not for presentation. The two count different events: `requests`
  // counts paid calls that ANSWERED, while a data provider's quota is spent by
  // every request SENT, retried and refused ones included (which is the whole
  // reason to watch it). Summing them would make a number that means neither.
  // Units never add across each other, so one entry here is what keeps AI and
  // API calls apart on every surface, for good, without a single reader
  // remembering to filter.
  api_requests:      { label: "API calls",         format: "count",    rate: EACH },
};

// A unit as something displayable. An UNDECLARED unit still renders — a plugin
// may meter anything it likes, and the meter accepts any string by design — it
// just falls back to its own id rather than being dropped or guessed at.
// Graceful degradation, not prevention. Its rate frame degrades to "each",
// the only frame that needs no agreement with the vendor to be true.
export const describeUnit = (unit) => ({
  unit,
  label: UNIT_DEFS[unit]?.label ?? unit,
  format: UNIT_DEFS[unit]?.format ?? "count",
  rate: UNIT_DEFS[unit]?.rate ?? EACH,
});

// The vocabulary as it goes over the wire: deduped, sorted, described. ONE
// projection for every route that ships it, so two surfaces can't ship two
// shapes of one vocabulary — the kindList rule (capabilities.js), which this
// file's own history argues for twice over.
//
// A READER passes the units its rows actually used; an EDITOR asks for
// `unitVocabulary`, because it declares new facts and so cannot be limited to
// the units something already spent. Two questions, two names — and neither
// caller reaches into UNIT_DEFS itself.
export const unitList = (ids = []) => [...new Set(ids)].sort().map(describeUnit);
export const unitVocabulary = (extra = []) => unitList([...Object.keys(UNIT_DEFS), ...extra]);

// The one definition of a valid rate, in micro-dollars per unit. Zero is legal
// and load-bearing (a KNOWN free price); negative and non-finite are not
// prices at all. Every rung funnels through this — the descriptor validator at
// the registry write, both learners, the admin route, and setModelPrices at
// the write itself — because a bad rate is multiplied into cost_micros and, by
// design, never recomputed. A bad image clamp is fixable; a falsified billing
// record is not.
export const validRate = (micros) => Number.isFinite(micros) && micros >= 0;
