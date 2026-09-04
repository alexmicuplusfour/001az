// Parameters a provider may refuse at call time — the negotiation both wire
// families speak. Same shape each time: the request carries an optimistic
// extra, a model 400s on it, and the wire drops the field, re-sends, and
// remembers — because a refused call bills nothing and no static list of
// who-refuses-what stays right (the compat wire learned that on gpt-5-mini,
// 2026-08-09; the Anthropic wire on fable-5.1, 2026-09-03 — twice in one day,
// temperature in the morning and strict by the afternoon).
//
// What lives here is what the wires must agree on: what each refusal looks
// like on the wire, how a learned refusal is keyed, the learned set itself —
// and, for the fetch-shaped wires (compat, google), the negotiation loop
// (negotiate, below). HOW to rebuild a request from the surviving features
// stays wire-local: compat re-derives its quirk block, google a temperature
// value, and the Anthropic wire — whose failures arrive as SDK exceptions
// mid-await, not as !r.ok responses — keeps its own exception-shaped copy of
// the loop around its builder.
import { createHash } from "node:crypto";

// Two scopes of learned fact. Temperature refusal is a property of the MODEL
// (Anthropic removed non-default sampling from Opus 4.7 onward; OpenAI's
// o-series and gpt-5 base family likewise). Strict refusal is a property of
// the SCHEMA — the server compiles input_schema into a grammar and 400s when
// the compilation is too big (big closed vocabularies, many optional keys),
// so a board with a leaner schema on the very same model must still get
// strict. The fingerprint keeps one whale board from stripping everyone's
// guarantee.
const schemaScope = ({ schema }) =>
  `|${createHash("sha1").update(JSON.stringify(schema ?? null)).digest("base64url").slice(0, 12)}`;

export const REFUSABLE = {
  temperature: {
    // OpenAI answers in structured form (param:"temperature",
    // code:"unsupported_value"); everyone else in prose that varies by vendor
    // and generation: "Unsupported value", "not supported", "only the
    // default" — and, since the Claude 5.1 family, "deprecated"
    // ("`temperature` is deprecated for this model", seen live 2026-09-03).
    // The rejection-verb requirement keeps a 400 that merely quotes the word
    // (a schema error echoing user text) fatal, as it should be.
    rejects: (e) =>
      e.param === "temperature" ||
      (/temperature/i.test(e.message || "") &&
        /unsupported|not support|invalid|only the default|deprecated/i.test(e.message || "")),
    scope: () => "",
    note: "tagging keeps working, minus ~4 points of run-to-run stability",
  },
  strict: {
    // fable-5.1, 2026-09-03, on a facet-heavy board: "The compiled grammar is
    // too large, which would cause performance issues. Simplify your tool
    // schemas or reduce the number of strict tools." A schema too rich to
    // compile, not a schema that is wrong. Dropping strict is safe: the
    // schema still rides the tool definition as guidance, and parseRun
    // filters every answer against the board's vocabulary anyway — it was
    // built for the strictTools:false providers, whose schema was always
    // advisory.
    rejects: (e) => /compiled grammar|strict tool/i.test(e.message || ""),
    scope: schemaScope,
    note: "tagging keeps working — answers are validated against the vocabulary downstream",
  },
};

// Learned refusals, `${feature}|${endpoint}|${model}` plus the feature's
// scope, so a board pays the discovery round trip once per process rather
// than on every item. One Set across both wires — keys carry the endpoint, so
// entries cannot collide. Not locked: the worker runs AI_INFLIGHT items at a
// time, so the first wave may each discover a refusal independently — a
// refused call bills nothing and every one of them still recovers, which is
// cheaper than serialising a wire for it. Bounded by the number of distinct
// (feature, model, board-schema) triples actually used. Plain and
// process-lifetime, unlike the connectors' TTL'd chartLearned bucket
// (runtime.js) — deliberate: a vendor UN-refusing a parameter is not a case
// worth paying re-probes for, and a restart re-probes anyway. Exported as a
// test seam.
export const refused = new Set();

export const refusalKey = (feature, endpoint, model, ctx = {}) =>
  `${feature}|${endpoint}|${model}${REFUSABLE[feature].scope(ctx)}`;

// What this call should optimistically ask for: every feature this
// (endpoint, model, schema) hasn't refused yet. The wire intersects this with
// its own data (compat: the quirk block; Anthropic: nothing — it wants both).
export const askFor = (endpoint, model, ctx = {}) =>
  Object.fromEntries(Object.keys(REFUSABLE).map((f) => [f, !refused.has(refusalKey(f, endpoint, model, ctx))]));

// Which SENT feature does this 400 refuse? null when none — the guard that
// keeps an unrelated 400, or one blaming a field this request never carried,
// fatal rather than re-paid. (SDK errors carry .status and embed the body in
// .message; compatError mirrors that shape, so one predicate reads both wire
// families' failures.)
export const refusedFeature = (e, sent) =>
  Number(e?.status) === 400
    ? Object.keys(REFUSABLE).find((f) => sent[f] && REFUSABLE[f].rejects(e)) || null
    : null;

// The learn-it-and-say-so step, shared so the operator-facing sentence has
// one owner. Warns once per learned key per process, not per item — a
// provider fact worth seeing in the logs, not noise.
export const learnRefusal = (feature, key, label, model) => {
  refused.add(key);
  console.warn(`${label}: ${model} rejects ${feature} — re-sending without it (${REFUSABLE[feature].note})`);
};

// The negotiation loop for fetch-shaped wires: send what `sent` says, and
// when a 400 refuses a SENT feature, learn it, turn the flag off, re-send.
// Bounded by the feature count — every pass flips one flag off, and
// refusedFeature matches sent features only, so an unrelated (or repeat) 400
// throws. `sendFromSent` is the wire-local rebuild (the surviving flags back
// into a protocol request); `errOf` maps the wire's failed Response onto the
// shared error contract (.status et al) this module's predicates read.
// Returns the ok Response for the wire to consume.
export async function negotiate({ sent, sendFromSent, errOf, endpoint, model, ctx = {}, label }) {
  let r = await sendFromSent(sent);
  while (!r.ok) {
    const err = await errOf(r);
    const feature = refusedFeature(err, sent);
    if (!feature) throw err;
    learnRefusal(feature, refusalKey(feature, endpoint, model, ctx), label, model);
    sent = { ...sent, [feature]: false };
    r = await sendFromSent(sent);
  }
  return r;
}
