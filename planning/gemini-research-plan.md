# Gemini web research — a native wire branch, not a flag flip (2026-09-04)

**Status: Stage 1 SHIPPED 2026-09-04 + simplify pass applied (suite
1351/1351, uncommitted). Stage 2 (live verification on local compose)
pending.** One touch-list addition found while building:
[providers.test.js:94](../test/providers.test.js#L94) pinned gemini's wire
reference-equal to openai's — flipped to state the new truth (every non-tag
method compat by reference, tag its own). The simplify pass (4 agents) then
promoted the shared halves the first cut had copied: `wholeCall` /
`rejectDocuments` / `providerError` now live in
[tool.js](../server/ai-providers/wires/tool.js), the fetch-shaped refusal
negotiation loop became `negotiate()` in
[refusals.js](../server/ai-providers/wires/refusals.js) (compat + google ride
it; the Anthropic wire keeps its exception-shaped copy), the native leg got
its own 10-minute `AI_RESEARCH_TIMEOUT_MS` deadline instead of inheriting the
3-minute chat one, googleError gained the Retry-After header read it had
drifted away from, and a connection-level `base` now fails loud on the
research path instead of being silently bypassed (a gateway's key must not
ship straight to Google). Test helpers `withFetch`/`recorder` promoted to
[helpers.js](../test/helpers.js).

Self-contained for a fresh session. Written after a deep dive through both wire
families, the research capability's whole path (descriptor flag → engine →
worker prompt → UI roster → meter), and a set of live probes against Google's
endpoints with the app's stored Gemini key. Every request shape below was
**measured working on 2026-09-04**, not read off a doc page.

## What this is

The board modal's "Web research" toggle is gated on "needs a tagging model
from anthropic". The gate is honest — Anthropic is the only built-in that
declares `research: true` — but the reason has expired: Gemini can ground
tagging in live Google Search now. The catch discovered by probing: **not on
the endpoint the app currently uses.** Gemini rides the shared OpenAI-compat
wire ([gemini.js](../server/ai-providers/gemini.js)), and Google's compat
layer rejects every spelling of a search tool for chat (all 400 — top-level
`google` block, literal `extra_body` wrapper, `tools:[{google_search:{}}]`,
`tools:[{type:"google_search"}]`, `web_search_options`). The doc tip that
suggests otherwise sits in the *image generation* section and applies only
there; for chat, `extra_body.google` accepts `cached_content` and
`thinking_config`, nothing else.

So Gemini research means speaking Google's **native** `generateContent`
protocol for research calls. That is vendor protocol code, and the house rule
(provider agnosticism) says it lives in its own wire module — exactly the
precedent Anthropic already set with [wires/anthropic.js](../server/ai-providers/wires/anthropic.js).
Everything else — engine dispatch, worker prompt, UI roster, meter — is
already data-driven and needs zero or comment-only changes.

## The measured winning shape (probe 7)

POST `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
with header `x-goog-api-key` (not Bearer):

```json
{
  "system_instruction": { "parts": [{ "text": systemText }] },
  "contents": [{ "role": "user", "parts": [...] }],
  "tools": [
    { "google_search": {} },
    { "function_declarations": [{ "name": "record_tags", "description": "…",
        "parametersJsonSchema": schema }] }
  ],
  "tool_config": {
    "include_server_side_tool_invocations": true,
    "function_calling_config": { "mode": "ANY", "allowed_function_names": ["record_tags"] }
  },
  "generation_config": { "temperature": 0, "maxOutputTokens": 8192 }
}
```

What each measured fact bought:

- **`include_server_side_tool_invocations: true`** is the key that unlocks
  built-in search *combined with* function calling — without it the request
  400s ("Please enable tool_config.include_server_side_tool_invocations to
  use Built-in tools with Function calling"). With it, the search runs
  server-side and the turn's parts narrate it.
- **`mode: "ANY"` + `allowed_function_names`** forces `record_tags` *without
  blocking the search*: a grounded probe came back
  `toolCall → toolResponse → functionCall` in ONE turn, the answer correct
  and current (it knew about models released this month). This is stronger
  than the Anthropic wire gets — there, forcing the tool would block
  `web_search`, so tool_choice relaxes to `auto` and the wire trusts the
  model to finish ([wires/anthropic.js:62](../server/ai-providers/wires/anthropic.js#L62)).
  Gemini needs no such trust: search is not blocked by the forced call. In a
  plain AUTO run the model searched and then answered in prose, skipping
  `record_tags` — so ANY is load-bearing, not decoration.
- **`parametersJsonSchema`**, not `parameters`: the classic `parameters`
  field is a Schema proto that 400s on the nested `additionalProperties:
  false` every board schema carries ([worker.js:277](../server/worker.js#L277)).
  `parametersJsonSchema` took the `buildPrompt` schema **byte-for-byte
  untouched** and the args came back in the real board shape (per-facet
  `{values, reasoning}`, `fit.verdict`, `description`). No sanitizer, no
  schema fork.
- **`temperature: 0`** accepted (matches the compat quirk block's measured
  choice); `system_instruction` and `maxOutputTokens` accepted.
- **Search count is visible**: each executed search is a part
  `{ toolCall: { toolType: "GOOGLE_SEARCH_WEB", args: { queries: [...] } } }`
  — one probe ran one toolCall carrying 3 queries. Billing is per executed
  query, so count = Σ `toolCall.args.queries.length`. In AUTO runs
  `groundingMetadata.webSearchQueries` also appears, but in forced-ANY runs
  it came back **null** while the toolCall parts were present — the parts are
  the authoritative count, groundingMetadata only a fallback.
- **Usage**: `usageMetadata = { promptTokenCount, candidatesTokenCount,
  thoughtsTokenCount, totalTokenCount }`. Thinking bills as output and is NOT
  inside `candidatesTokenCount` (measured: 274 + 58 + 467 = 799 = total) —
  the same trap the compat wire already documents and folds
  ([compat.js:240-247](../server/ai-providers/wires/compat.js#L240)).
- The model may legitimately search **zero** times (probe 7's item didn't
  need the web; ANY still forced the call). "May use it" is the contract the
  shared prompt paragraph already states ([worker.js:183](../server/worker.js#L183)).

Full request/response captures lived in the session scratchpad
(`gemini-research-probe*.json`); the shapes above are the durable record.

## Design

### New wire family: `google`

[wires/index.js](../server/ai-providers/wires/index.js) grows a third entry —
`google` — a module `wires/google.js` exporting:

- **`googleRequest(...)`** — pure builder, the test seam, same contract as
  `anthropicRequest`/`compatRequest`: takes `{ model, systemText, schema,
  parts, tool, temperature }` and returns the JSON body above. Parts map
  text → `{text}`, image → `{ inline_data: { mime_type, data } }`.
- **`googleWire = { ...compatWire, tag }`** — every non-research concern
  (embeds, key test, model list, prices list) rides the compat implementation
  unchanged through the spread; `tag` branches: `research` off → delegate to
  `compatWire.tag` verbatim (same negotiation, same errors, zero behavior
  change), `research` on → the native call.

The descriptor ([gemini.js](../server/ai-providers/gemini.js)) then declares
`wire: wires.google`, `research: true`, and a
`nativeBase: "https://generativelanguage.googleapis.com/v1beta"` field (data
on the descriptor, not string surgery on the compat base — a gateway plugin
overriding `base` can override `nativeBase` too, or not declare research).
Engine and plugins need nothing: `callTagger` already sends
`research && desc.research` ([providers.js:274](../server/providers.js#L274)),
and plugins receive the new family via `ctx.wires` for free.

Rejected alternative: teaching the shared compat wire to branch on a quirk
block. The native protocol differs in endpoint, auth header, request AND
response shape — that's not a quirk, that's a protocol, and vendor protocol
in the shared wire is exactly what the agnosticism rule forbids. (GLM's
future research is the opposite case: its `web_search` IS an in-band
chat-completions tool, so when that day comes it's quirk-block data on the
compat wire — the note in [glm.js:30](../server/ai-providers/glm.js#L30)
stands.)

### The native tag path

Mirrors the two existing wires' choices, in their order:

1. **Refusal negotiation**: reuse `askFor`/`refusedFeature`/`learnRefusal`
   keyed on the native URL, temperature only (`strict` is a compat/Anthropic
   concept; nothing strict is sent natively — parseRun validates downstream
   as always). Fable-5.1 taught us twice in one day that param support is
   learned, not known ([refusals.js](../server/ai-providers/wires/refusals.js)).
2. **Timeout**: the compat family's `chatSignal()` (`AI_CHAT_TIMEOUT_MS`,
   default 180s). Probed research turns ran 10–30s; env-tunable if a search
   marathon ever needs Anthropic's 10-minute generosity.
3. **Errors**: native errors are `{ error: { code, message, status, details } }`.
   Map to the compat contract — `Error` with `.status` (and `.retryAfter`
   when a RESOURCE_EXHAUSTED carries RetryInfo in details) — so the queue's
   rate-limit handling can't tell the families apart
   ([compat.js:53-71](../server/ai-providers/wires/compat.js#L53)).
4. **Answer extraction**: the `functionCall` part matched **by name** (both
   wires learned to never take "whatever called first"); `args` is already an
   object — no JSON.parse. Missing call + `finishReason: "MAX_TOKENS"` →
   `clippedError(OUTPUT_BUDGET)`; missing call otherwise (incl.
   MALFORMED_FUNCTION_CALL, seen live on this model family) → the standard
   `model did not call record_tags` throw, retryable like today. A parseable
   call wins regardless of finishReason — the compat wire's measured Gemini
   lesson (thinking overruns the cap *after* emitting a whole call) applies
   verbatim.
5. **Usage**: `input = promptTokenCount − cachedContentTokenCount`,
   `output = candidatesTokenCount + thoughtsTokenCount` (fallback
   `totalTokenCount − promptTokenCount`), `cacheRead =
   cachedContentTokenCount || 0`, `searches` = toolCall sum with
   `groundingMetadata.webSearchQueries?.length` as fallback. Everything
   downstream is already built: `meterAiCall` folds `searches` into
   `web_searches` rows ([metering.js:40](../server/metering.js#L40)), board
   attribution, Usage tab, jobs drill — all untouched.
6. **Documents**: keep the compat wire's PDF throw on the research path too.
   The native endpoint could take PDFs, but then flipping research on/off
   would change *which boards can tag at all* — a modifier must not move that
   line. Noted as a possible future unlock, deliberately not here.

### No per-item search cap — accepted, stated

Anthropic's wire bounds spend with `max_uses: 5`
([wires/anthropic.js:15](../server/ai-providers/wires/anthropic.js#L15));
the native API has no equivalent parameter. Measured behavior: one search
round of ≤3 queries per item (~$0.042 worst observed vs Anthropic's capped
$0.05). The shared prompt already frames search as optional; no vendor-forked
prompt, no fake knob. If a runaway ever shows up in the meter, that's the day
for a prompt-side bound.

### Old/live-listed models: fail loud, don't negotiate

Grounding-with-function-calling is a Gemini-3-family capability; all three
curated models qualify. A live-listed older id with research on will 400 and
surface in the jobs drill like any wire error. Deliberately NOT added to the
refusal vocabulary: temperature/strict degrade cosmetically, but silently
dropping research would un-buy a feature the user explicitly paid a toggle
for. The admin picks a current model; the error text says why.

### Prices: the descriptor rung, because Google states a number

Anthropic's searches stay unpriced in its descriptor because no
machine-readable rate exists. Google states one: **$14 per 1,000 search
queries** after 5,000 free grounded prompts/month, Gemini-3 family (pricing
page + grounding doc, surveyed 2026-09-04 — re-verify on the live pricing
page at implementation time). So [gemini.js](../server/ai-providers/gemini.js)
gains, alongside `research: true`:

```js
prices: { "*": { requests: 0, web_searches: 14000 } },  // µ$/unit; $0.014 per executed query
```

`"*"` is safe despite 2.5-era models billing per-prompt instead: those models
can't run the combined-tools shape at all, so they never meter a search. The
free monthly allowance makes ≈$ an over-estimate early in the month — ≈ is
already the product's honest answer, and an admin price row overrides.
Token prices keep arriving via the community map (`priceNamespace: "gemini"`).

## Touch list

- **new** `server/ai-providers/wires/google.js` — `googleRequest` +
  `googleWire` (delegating spread over compat).
- [wires/index.js](../server/ai-providers/wires/index.js) — third roster
  entry + comment (the "one place the family roster is named").
- [gemini.js](../server/ai-providers/gemini.js) — `wire: wires.google`,
  `research: true`, `nativeBase`, `prices`, header comment rewritten (the
  "no grounding on the compat layer" sentence is now a *why the native
  branch exists* sentence).
- [worker.js:180-183](../server/worker.js#L180) — comment only: "only
  Anthropic actually gets a web_search tool" → research-capable providers,
  plural. The paragraph text itself already speaks provider-neutrally and
  names `record_tags` — unchanged.
- Tests (suite currently 1344):
  - [research.test.js](../test/research.test.js) — header comment drops
    "Anthropic-only"; new section: `googleRequest` shape (both tools,
    untouched `parametersJsonSchema` with `additionalProperties` intact,
    ANY + allowed names, `include_server_side_tool_invocations`,
    system_instruction, temperature/budget); response mapping via stubbed
    fetch (compat.test.js pattern): functionCall-by-name, searches=3 from
    one 3-query toolCall, thoughts folded into output, groundingMetadata
    fallback, MAX_TOKENS/no-call → clipped, research-off delegation to the
    compat request shape.
  - [providers.test.js:67-70](../test/providers.test.js#L67) — the "Anthropic
    is the only research-capable provider" pin flips: gemini moves to the
    `research: true` side, comment updated.
  - [capability-present.test.js:71](../test/capability-present.test.js#L71)
    does NOT flip (close-look correction): its `supportedBy: ["anthropic"]`
    is a hand-made fixture feeding the client rendering function, still a
    valid input. No server test pins the roster contents either — it is
    computed from the catalog at
    [capability-status.js:162](../server/capability-status.js#L162), so the
    "needs anthropic / gemini" note fixes itself with zero test edits.
  - [admin-prices.test.js](../test/admin-prices.test.js) — a gemini
    `web_searches` descriptor-rung row asserts $0.014/query surfaces.
- **Zero changes**: engine dispatch, board routes (votes×research exclusivity
  [server.js:1740](../server/server.js#L1740) applies as-is — "searches bill
  per pass" is now true twice over), UI (roster is data,
  [capability-status.js:162](../server/capability-status.js#L162) →
  [board-modal.js:957-971](../public/board-modal.js#L957)), meter schema,
  price learner.

## Stages

**Stage 1 — the wire.** Everything under "Touch list". Ships green on the
suite; behavior identical for every board with research off (delegation is
verbatim), new behavior only where a gemini-tagged board flips the toggle.

**Stage 2 — live verification on local compose.** With the stored Gemini key:
research ON on a gemini-tagged board → item tags land grounded; meter grows
`web_searches` rows under provider `gemini` with board attribution; Usage tab
shows the count and ≈$ at $0.014/query; jobs drill shows the call; research
OFF → request byte-identical to today's compat shape; an Anthropic research
board still green (no cross-family regression). Record measured latency,
thoughts-token overhead, and typical query count in the ledger. Mind the free
tier's 10 RPM ([gemini.js](../server/ai-providers/gemini.js) rpm block) when
batch-testing.

## Known-adjacent, deliberately untouched

- `usage_meter.provider` un-namespaced (the standing migration note) —
  research rows ride the same `"gemini"` string the family already uses; no
  new collision surface.
- GLM research — different mechanism (in-band compat tool), different day.
- Native-path PDFs, thinking-budget knobs, per-item search bounds — listed
  above with their reasons; none block shipping.
