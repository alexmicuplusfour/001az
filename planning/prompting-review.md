# Prompting deep dive — review findings

A full review of the prompting stack (2026-07-29): the prompt builders and
per-item user turns in `server/worker.js`, both wire families
(`server/ai-providers/wires/anthropic.js`, `wires/compat.js`), the dispatch
engine (`server/providers.js`), all five provider descriptors, the local
embedder, and the tests that pin prompt shapes. Findings ranked: misalignments
first, then cheap wins, then design observations.

## The prompt surface, mapped

Six distinct surfaces:

1. **Tagging** — `buildPrompt` (worker.js): system text + a JSON schema
   generated from the board's facets, cached per board. Reasoning-first
   (description → per-facet reasoning → values → fit verdict).
2. **Field extraction** — `buildFieldsPrompt` (worker.js): per-field
   `why`/`value` pairs, optional derived identity.
3. **Per-item user turns** — `modelInputFor` (worker.js): kind-specific anchors
   (image, PDF text + page-1 preview, docx/text, audio transcript, chart face,
   entity dossier) plus an extracted-fields dossier.
4. **Research mode** — Anthropic-only server-side `web_search` (max 5
   searches), `tool_choice` relaxed to auto, `pause_turn` continuation.
5. **Embedding text** — `embedTextFor` (worker.js): description + reasoning
   sentences + flattened tags + transcript; raw user query on the search side.
6. **Tool contracts** — `record_tags` / `record_fields` one-liners
   (`wires/tool.js`).

## What's strong (keep)

- Vocabulary enforced **structurally** (enum in `input_schema` — an invalid
  tag can't exist), with a belt-and-braces `allowed`-set filter at parse time.
- Reasoning declared **before** values in the schema — chain-of-thought
  embedded in the output contract, not begged for in prose.
- The `fit` verdict has a code-side guard (`filledFacets < facets.length / 2`)
  compensating for a prompt instruction models won't follow — right call.
- Cost routing is disciplined: thumbnails not originals, extracted text not
  per-page PDF billing, document blocks only as a last resort.
- The Anthropic cache breakpoint on system text is correctly placed — tools
  precede system in the prompt prefix, so the tool schema is cached too.
- Prompt shapes are pinned by tests (`test/prompt.test.js`,
  `test/research.test.js`, `test/extraction.test.js`).
- Real iteration history preserved in comments (e.g. the identity-hint
  "unique key" framing lesson, worker.js ~line 326).

## Real misalignments

### 1. Extraction's fallback user turn names the wrong tool

**FIXED 2026-07-29** — `modelInputFor` takes a `mode` ("tag" | "extract") and
every anchor asks for the tool actually offered; `extractOne` passes the
entity and `"extract"`; the compat wire matches the tool call by name
(`model did not call <tool>`), mirroring the Anthropic wire. Pinned by the
job-log extract+tag leg test (fallback anchor asks for record_fields) and two
compat wire-parse tests. Decision point 4 below resolved as "keep the call,
word it honestly" — the fileless-vehicle ask no longer promises fields below;
skipping the call entirely remains open as a cost optimisation.

(Expanded after a close trace, 2026-07-29.)

`extractOne` (worker.js:1428) builds parts as
`modelInputForExtract(payload) ?? modelInputFor(payload)` and then passes
`tool: { name: "record_fields", … }`. `modelInputForExtract` returns null for
every non-text material, so the fallback — whose anchors all command *"Tag
… using the record_tags tool"* — is reached on four real paths:

| Trigger (AI fields on the mapping +) | Anchor sent | Extra wrinkle |
| --- | --- | --- |
| **image upload** (the common one) | "Tag this image using the record_tags tool." (worker.js:940) | — |
| **no-file connector vehicle** | "…Tag it using the record_tags tool, judging from its extracted fields below." (worker.js:872) | there ARE no fields below — the dossier append lives only in `tagOne`; and `entity` isn't passed, so the name falls back to `payload.identity` |
| **textless/scanned PDF** | doc block + "Tag this document using the record_tags tool." (worker.js:899) | whole PDF billed per page, on the extract leg IN ADDITION to the tag leg's own document-block call |
| **speechless audio** | "…Tag it using the record_tags tool, judging from its name." (worker.js:932) | — |

Every one contradicts the system text ("Return your answer only by calling
the record_fields tool") and the tools array (record_fields is the only tool).

**Severity is provider-shaped:**

- Anthropic / OpenAI / Gemini / OpenRouter (forced tool choice): the schema
  wins; the contradiction is noise with at most mild quality drag. Low.
- **GLM (`forceToolChoice: false` — the prompt IS the forcing mechanism):**
  three outcomes. (a) It calls record_fields anyway — fine. (b) It answers in
  prose — "no tool call in response", burns all 3 attempts, item fails.
  (c) **It hallucinates a `record_tags` call — and the compat wire accepts
  it**: `compat.js:113` takes `tool_calls[0]` without checking
  `function.name` (the Anthropic wire DOES filter by name, anthropic.js:75).
  The tag-shaped args then miss every `input[f.key]` lookup → AI fields
  silently absent; on a derived-identity mapping, `input.identity` is
  undefined → the "no identity derived" branch fires and an un-named entity
  is **marked provisional**. The leg logs `ok`. Silent data loss.

**Fix (three parts + one decision):**

1. Thread the task through `modelInputFor(payload, entity, mode = "tag")` —
   each anchor picks its sentence per mode ("Tag this image using the
   record_tags tool." vs "Extract the requested fields from this image using
   the record_fields tool."). `extractOne` passes `"extract"`.
2. Compat wire: find the tool call **by name**, mirroring the Anthropic wire —
   `tool_calls.find(c => c.function?.name === tool.name)`, throw
   `model did not call ${tool.name}` otherwise. Converts GLM's silent wrong
   answer into a retryable error with the same message shape both wires use.
3. `extractOne` already fetches the entity for identity resolution — hoist
   that above the parts build and pass it, so the no-file anchor names the
   entity properly.
4. **Decision needed** for the no-file vehicle: extraction there has no
   material at all (the "fields below" promise is false). Either skip the AI
   call (stamp AI fields null with why "no material to extract from") or
   append the entity-fields dossier like `tagOne` does so the sentence is
   true. Skipping is cheaper and more honest; the dossier only helps if AI
   fields are meant to be derived from connector fields.

Tests to pin: extraction-fallback parts never contain "record_tags"
(extraction.test.js), compat wire rejects a mismatched tool-call name
(compat.test.js).

### 2. Document truncation is silent

**FIXED 2026-07-29** — `clipText(text, max)` (module scope, exported)
appends `[truncated: showing the first N of M characters]` only when it cut;
used at all four prompt sites. The cap was also RAISED: 50k chars was an
uninformed arbitrary pick; now `TEXT_DOC_MAX_CHARS` defaults to 150k chars
(~37k tokens — ~50 dense pages / ~2.5h of speech, covering the transcriber's
2-hour design point, inside GLM's 128k-token window, still a cost fuse for
scheduled retags) and is env-tunable. Pinned by pure clipText tests in
docs.test.js. The embed-side 8k cap is untouched (gist by design).

(Expanded after a close trace, 2026-07-29.)

Four prompt-facing sites slice at `TEXT_DOC_MAX_CHARS` (50k chars) with no
marker — worker.js:896 (pdf, tag), :915 (docx/text, tag), :934 (audio
transcript, tag), :980 (all text materials, extract). A fifth slice
(`embedTextFor`, worker.js:155, 8k chars) feeds embeddings only — lower
stakes by design (transcript is last in the join, so the searchable gist
survives).

**Who actually hits 50k chars:**

- Prose documents: ~2.5–3k chars/page → the cap lands around **17–25 dense
  pages**. Resumes never; reports, theses, filings routinely.
- **Audio is the sharp case**: conversational speech ≈ 150 wpm ≈ ~55k
  chars/hour, so the cap lands almost exactly at the **one-hour mark** — and
  the transcriber sidecar is explicitly engineered for 2-hour clips ("~real-
  time on CPU"). The app's own headline long-recording support silently
  discards everything past ~hour one from BOTH legs' model view. (The stored
  `payload.transcript` is complete — only the prompt is cut — so the fix
  changes no data.)

**Failure shape per leg:**

- Extract (worst): `buildFieldsPrompt` instructs "set the value to null when
  the field cannot be determined from the material" plus a why sentence — so
  a tail field comes back `{v: null, why: "the document does not mention X"}`,
  an affirmative false claim stored on the item, indistinguishable from real
  absence. Re-extract can't fix it; the same slice reproduces it.
- Tag: facets judged from the head only; reasoning sentences assert "no X
  present"; a fit verdict can go undecided on material that matches past the
  cut.

**Fix:** hoist `TEXT_DOC_MAX_CHARS` to module scope and add a pure exported
`clipText(text, max)` that appends
`[truncated: showing the first N of M characters]` only when it actually cut
— the counts give the model scale (1% missing vs half missing), the marker
sits after the material and before the closing ask, and the model's why
sentences become honest ("not determinable — the document is truncated").
Use it at all four sites; unit-test the seam (docs.test.js style).

**Left open (cost knobs, not correctness):** the cap itself is a cost fuse —
50k chars ≈ 12.5k tokens against 200k-token context windows. An env override,
or a higher cap for the extract leg only (extraction needs detail; tagging
needs gist), are reasonable follow-ups once the marker makes truncation
visible in the why sentences.

### 3. Nothing detects output-length truncation

**FIXED 2026-07-29** — `outputBudget(schema, research)` and
`clippedError(cap)` live in wires/tool.js, shared by both wire families. The
budget scales `clamp(1024 + 128 × schema props, 2048 (research 4096), 8192)`;
the Anthropic wire checks `stop_reason === "max_tokens"` after the pause_turn
loop, the compat wire checks `finish_reason === "length"` before the
tool-call lookup; both throw the 422 permanent-shaped cap error (one paid
attempt, honest message on the item). Pinned by budget-scaling tests
(research.test.js, compat.test.js) and a compat wire clip test. The
reasoning-effort quirk follow-up below remains open (goes with #4).

(Expanded after a close trace, 2026-07-29.)

`max_tokens` is a fixed 2048 for non-research calls in both wires
(anthropic.js `research ? 4096 : 2048`, compat.js `[maxTokensField]: 2048`),
and neither wire ever reads `stop_reason` / `finish_reason` (Anthropic checks
only `pause_turn`).

**What actually happens when output clips:**

- Anthropic: `stop_reason: "max_tokens"` with the tool_use block absent or
  incomplete → the wire throws the misleading "model did not call
  record_tags".
- Compat: `finish_reason: "length"` with either no tool_calls ("model did not
  call X") or arguments cut mid-JSON → `JSON.parse` throws
  `Unterminated string in JSON at position …` — pure gibberish stored as the
  item's error.
- Both are status-less throws, so failOrRequeue treats them as transient:
  **five paid attempts** (maxAttempts 3 + TRANSIENT_EXTRA 2) re-clipping
  deterministically before the item fails with the misdirecting message.

**Why 2048 is far more dangerous than the facet math suggests — the
reasoning-token trap.** The facet arithmetic (reasoning mode ≈ 40–70 output
tokens per facet) only clips at ~25–45 facets: rare, though boards are
user-defined. But the OpenAI descriptor's default model is **gpt-5-mini, a
reasoning model**, and `max_completion_tokens` counts its INVISIBLE reasoning
tokens too. A gpt-5-family model can burn hundreds-to-thousands of tokens
thinking before emitting the tool call — with 2048 total, an ordinary board
can come back `finish_reason: "length"` with nothing visible at all. GLM got
`disableThinking` for exactly this class of problem; OpenAI/OpenRouter
reasoning models have no guard, and users pick reasoning models freely from
the live model list. The app's DEFAULT OpenAI configuration sits near this
cliff.

**Fix (shared helpers in wires/tool.js, both wires):**

1. **Scale the budget from the schema** — `outputBudget(schema, research)`:
   `clamp(1024 + 128 × schema property count, floor, 8192)`, floor 2048
   (research 4096). max_tokens is a ceiling, not a spend — raising it costs
   nothing unless used. Computed in the wires from the schema they already
   hold; no plumbing.
2. **Detect the clip** — Anthropic `msg.stop_reason === "max_tokens"` (after
   the pause_turn loop, so a continued-then-clipped turn is caught too);
   compat `choices[0].finish_reason === "length"`, checked BEFORE the
   tool-call lookup so it wins over both downstream failure shapes. Throw a
   shared `clippedError(cap)`: readable, actionable, and **permanent-shaped
   (status 422)** — retrying re-pays the same deterministic clip, so fail on
   attempt one with the real story on the item; reprocess re-arms after a
   config change. (Near-cap sampling variance means a retry might squeak
   under, but 4 more paid calls is a bad lottery.)

**Follow-up noted, not done here:** a compat quirk for reasoning effort
(OpenAI `reasoning_effort: "minimal"` fits a closed-vocabulary tagging task)
— belongs with finding #4's sampling-params-as-quirk-data work.

## Cheap, high-value wins

### 4. Temperature is never set — tagging at 1.0 everywhere

**PARKED by decision 2026-07-29** (the quirk-gated design below stays on the
shelf); the incidental Gemini catalog finding is **FIXED** — curated set
refreshed to the live-verified 3.5 family (default gemini-3.5-flash), embeds
catalog gains gemini-embedding-2 with 001 kept as default so no corpus
re-embed is triggered.

**DOWNGRADED after a close look (2026-07-29)** — the original "highest
leverage" claim did not survive contact with evidence:

- **Measured stability is already excellent.** tag_snapshots: 5,508 items
  with AI judgments, 20 ever changed, ZERO flip-flops (A→B→A). Denominator
  caveat: only ~3 same-config retags observed in the job-log window, and the
  changed items cluster on wardrobe — facet-definition iteration, not noise.
  No evidence of sampling churn; no evidence against it either.
- **The churn scenario is hypothetical today**: every board has
  auto_tag=true (tag-on-upload) with the default 1440-min interval value,
  but `auto_tag_periodic` is armed on none — scheduled retags have never
  fired (job_log kind='retag' is empty). The insurance only starts mattering
  if periodic retag gets turned on.
- **The provider matrix bites exactly where confidence was highest**
  (live-probed with stored keys, 2026-07-29): gpt-5.4-mini and gpt-5.1
  ACCEPT temperature:0 (OpenAI restored it in the 5.1+ line); **o3 rejects
  it with a hard 400** ("Only the default (1) value is supported") and
  o-series ids pass the tagging modelFilter, so a blanket temperature
  permanently fails items for anyone picking an o-model. Gemini accepts it
  on live models. GLM unprobed (no stored key — its quirks are
  live-verified by policy, so don't guess). OpenRouter backends vary.

**If implemented** (cheap insurance, no longer urgent): quirk data, not a
global — `compat.temperature: 0` plus a `compat.noTemperature` model-regex
guard (openai: `"^o\\d"`); anthropic sets temperature 0 in its own wire
(all Claude models accept it; the app never enables extended thinking);
GLM/OpenRouter left unset. Pairs with the reasoning-effort quirk from #3's
follow-up.

**Incidental REAL finding from the probes:** the Gemini descriptor's
`defaultModel: "gemini-2.5-flash"` is RETIRED — "no longer available to new
users" (404). A fresh install or new key using the curated default fails
every call. The curated Gemini catalog needs a refresh to the 3.5 family
(this instance's boards dodged it by sitting on 2.5-pro / 3.5-flash).

(Original write-up below.)

Neither `anthropicRequest` nor `compatRequest` sends `temperature`, so every
provider samples at its default (1.0 for Anthropic and OpenAI). For
closed-vocabulary classification and field extraction, ~0–0.2 is standard.
Not just marginal accuracy: scheduled retag re-judges everything, and
`tag_snapshots` deliberately records only *judgment changes* — at temperature
1.0 some fraction of those rows are pure sampling noise, polluting the
then-vs-now history the feature exists for and feeding spurious alert
evaluations. **Highest-leverage single line in this review.**

Caveat: some reasoning-mode models reject non-default temperature — make it a
`compat` quirk knob like the others.

### 5. Local embedder is missing bge's query prefix

`local.js` uses `bge-small-en-v1.5`, whose model card is explicit that short
*queries* should be prefixed with
`Represent this sentence for searching relevant passages: ` (passages stay
bare). The search route embeds the raw query, so local-embedder users silently
lose recall. Wants a per-descriptor `queryPrefix` (or an `isQuery` flag on
`embedTexts`) — API embedders don't want it, bge does.

### 6. Extraction has no format contract for `date` and `number` kinds

A `date` field is just `type: "string"` — models return "March 2024",
"2024-03", "03/01/24" across items, and lenient validation keeps all of them,
so field values aren't comparable or sortable. Two lines in the system text
fix it: dates as ISO 8601 (or the most precise known prefix, e.g. `2024-03`),
numbers as plain numerals, no separators or units. While there: since
`htmlToMarkdown` deliberately preserves hyperlinks as `[label](url)`, tell the
model URLs may appear as markdown links — that's the payoff of the whole
conversion and the prompt never mentions it.

### 7. A failed research turn should recover, not re-bill

With `tool_choice: auto`, a model that finishes with prose instead of
`record_tags` throws, and the retry re-pays for up to 5 web searches. Cheaper:
when the turn ends without the tool call, push the assistant content back and
issue one continuation with `tool_choice` forced (searching is done; forcing
is safe now) — same shape as the existing `pause_turn` loop. Also, the
research instruction is one generic sentence ("check recent real-world
facts"); for the boards where research matters (crypto/stocks with
`retag_on_refresh`) a board-context hint about *what's worth searching* would
spend those five searches much better.

## Design observations

### 8. The fit paragraph is fighting a war the code already won

It's the longest, most convoluted paragraph in the system prompt — nested
conditions, a "Never combine" double-bind — written to argue the model out of
a behavior the code comment admits it exhibits anyway, and which the
`filledFacets` guard already corrects. Since code owns the decision, the
prompt can be radically simpler ("If the facets below genuinely can't describe
this kind of material, set fit to undecided and leave values empty; otherwise
match"), spending instruction budget where the model actually listens. Fewer
tokens per cache-miss call, too.

### 9. Turning reasoning off silently degrades semantic search

With `ai_reasoning: false`, the `description` property is dropped from the
schema entirely, so `embedTextFor` has only flattened tags (plus transcript)
to embed. A user toggling reasoning off thinks they're saving tagging output
tokens; they're also gutting their search index. Either keep `description` in
the no-reasoning schema (one sentence — most savings survive), or surface the
coupling in the UI.

### 10. Board context is spliced in unframed

User-written `context` lands verbatim between the identity sentence and the
fit paragraph with no label. A `Board context: …` frame (or delimiter) keeps a
context with its own headings/lists from visually merging into app
instructions, and gives users the mental model that this is *their* voice
inside the prompt. Related vestiges from the image-gallery origin: "private
research gallery" and the description's "overall style and mood" phrasing —
on a resumes or crypto board, "style and mood" is mildly wrong guidance for
the sentence that becomes the item's primary embedding text. "What it is, and
what stands out about it" generalizes better.

### 11. Identity consistency clause disappears when the user supplies a hint

The "same subject → same value" guidance survives only in the no-hint fallback
(deliberate — "unique key" framing caused filename echoes). But consistency
and format are orthogonal: merge/split correctness *depends* on stable
derivation, and `normaliseIdentity` only papers over case/separator variance,
not "Bob Smith" vs "Robert Smith". Appending the consistency sentence *after*
the user's hint (rather than replacing it) keeps the user's format primary
while restoring the invariant the entity machinery needs.

## Smaller notes

- Research reasoning sentences can assert web-sourced claims with no
  provenance; the API returns citations currently discarded. Storing them next
  to `tag_reasoning` would make research-driven tag flips auditable.
  Future-work sized.
- PDF visual facets are judged from the page-1 thumbnail only — a deliberate
  cost trade, but worth a README line so nobody debugs "why didn't it see
  page 3" as a prompt problem.
- No prompt/context versioning: `legLog` records the model per attempt, but
  after a facet-gloss or context edit, old `tag_snapshots` rows can't be
  distinguished from judgment changes caused by the edit. A hash of
  `systemText` in the leg-log detail closes that for pennies.

## Incident 2026-07-29: OpenAI `invalid_prompt` on every board

All OpenAI tagging began failing with "Invalid prompt: your prompt was
flagged as potentially violating our usage policy". Not caused by app changes
(6 of the first 7 failures predate the then-current image; the same
model/prompt tagged 4,635 items the previous evening). Live bisect with the
stored key isolated the trigger: **the gpt-5 family began rejecting NAMED
tool forcing** (`tool_choice: {type:"function", function:{name}}`) as
invalid_prompt — bare prompts, system text, schema, strict mode, tool name,
and reasoning wording were all innocent; `tool_choice: "auto"` and
`"required"` pass. Fix: OpenAI's quirk became `forceToolChoice: "required"`
(compatRequest is now three-valued: true → named force, "required", false →
auto); with one tool defined the guarantee is unchanged. Verified live: all
flagged items re-tagged ok on gpt-5.4-mini. Diagnostic probes kept in
`scripts/probe-openai-flag.mjs` / `bisect-openai-flag.mjs` /
`bisect2-openai-flag.mjs`. **Watch item:** OpenRouter still uses the named
force — if OpenAI-backed models through OpenRouter start flagging, flip its
quirk the same way.

## Suggested order

#4 (temperature) and #2 (truncation marker) are one-liners; #1 is a small
parameter thread through `modelInputFor`; #5 and #6 are each ~5 lines. #3 and
#7 are the only ones needing real wire-level work.
