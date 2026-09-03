// Temperature: a parameter providers increasingly refuse — shared between the
// compat and Anthropic wires. Both send it where it still buys run-to-run
// stability (the temperature-0 measurement in compatRequest) and recover at
// call time where a model turns out to reject it, so the two pieces that must
// agree — what a rejection looks like, and which (endpoint, model) pairs have
// already rejected — live here rather than in either wire. Neither wire
// hardcodes model knowledge: compat descriptors MAY carry a `noTemperature`
// regex as data (it skips a call known to fail), and the Anthropic wire
// carries nothing at all — every model gets the field once and keeps it only
// if the provider takes it.

// Does this 400 name temperature as the problem? OpenAI answers in structured
// form (param:"temperature", code:"unsupported_value"); everyone else in
// prose, and the prose varies by vendor and generation: "Unsupported value",
// "not supported", "only the default" — and, since the Claude 5.1 family,
// "deprecated" ("`temperature` is deprecated for this model", seen live on
// claude-fable-5.1, 2026-09-03). The rejection-verb requirement keeps a 400
// that merely quotes the word (a schema error echoing user text) fatal, as it
// should be. Anthropic SDK errors arrive pre-shaped: .status is the HTTP code
// and .message embeds the whole error body, so the same predicate reads both
// wire families' failures.
export const rejectsTemperature = (e) =>
  Number(e?.status) === 400 &&
  (e.param === "temperature" ||
    (/temperature/i.test(e.message || "") &&
      /unsupported|not support|invalid|only the default|deprecated/i.test(e.message || "")));

// Learned per (endpoint, model), so a board pays the discovery round trip once
// per process rather than on every item. One Set across both wires — keys
// carry the endpoint, so entries cannot collide. Not locked: the worker runs
// AI_INFLIGHT items at a time, so the first wave may each discover it
// independently — a rejected call bills nothing and every one of them still
// recovers, which is cheaper than serialising a wire for it. Bounded by the
// number of distinct models actually used. Plain and process-lifetime, unlike
// the connectors' TTL'd chartLearned bucket (runtime.js) — deliberate: a
// vendor UN-refusing temperature is not a case worth paying re-probes for,
// and a restart re-probes anyway. Exported as a test seam.
export const temperatureRejected = new Set();

// One spelling of "this endpoint, this model" for the Set above — the
// no-collision invariant is only real if every wire derives keys the same way.
export const temperatureKey = (endpoint, model) => `${endpoint}|${model}`;

// The learn-it-and-say-so step, shared so the operator-facing sentence has one
// owner. Warns once per model per process, not per item — a provider fact
// worth seeing in the logs, not noise.
export const learnTemperatureRejection = (key, label, model) => {
  temperatureRejected.add(key);
  console.warn(`${label}: ${model} rejects temperature — re-sending without it (tagging keeps working, minus ~4 points of run-to-run stability)`);
};
