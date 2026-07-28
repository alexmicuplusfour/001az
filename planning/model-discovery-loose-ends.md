# Loose ends: dynamic model discovery (commit 1185544)

Findings from the post-implementation deep dive. Ordered by severity; check off
as fixed.

## Defects

- [x] **1. Literal NUL byte in `server/ai-providers/wires/anthropic.js`** —
  *(fixed: raw byte replaced with the `\0` escape sequence — same runtime
  string; the fix commit itself still diffs as binary because the old blob is,
  but every diff after is text)*
  the client-cache key (`anthropicClient`, ~L25) separates base and API key
  with a raw `\0` *character* instead of the two-character escape sequence.
  Git detects the NUL and treats the whole file as binary: no diffs, no blame,
  no reviewable changes (the discovery commit shows `Bin 4718 -> 5343 bytes`).
  Fix: write the escape sequence `\0` in source (same runtime string), or use
  `\n` as the separator.

- [x] **2. `AI_MODELS_TTL_MS` missing from the docker-compose passthrough** —
  *(fixed: added to the app service env beside the AI timeout knobs — the prod
  overlay inherits it; README tuning paragraph now names the knob and points
  at providers.js. `.env.example` untouched by design — it omits the deep
  knobs, same as the AI timeout siblings)*
  the knob is read in `providers.js` (`modelListTtl`) but `docker-compose.yml`
  whitelists env vars and this one isn't listed (its siblings
  `AI_CHAT_TIMEOUT_MS` etc. are, ~L79). In the reference Docker deployment,
  setting it in `.env` does nothing. Also absent from the README tuning-knob
  paragraph, which points at server.js/worker.js/alerts.js but not
  providers.js.

- [x] **3. Malformed plugin filter regex → 500s, violating "never an error"** —
  *(fixed: filter compiled once in `assembleModels` inside a try/catch — a
  pattern that doesn't compile degrades exactly like one that matches nothing
  (curated fallback) with a console.warn naming the provider/kind/pattern so
  the author can find the typo; regression test added)*
  `assembleModels` does `new RegExp(cat.filter)` with no guard
  (`providers.js` ~L186). A plugin author's bad pattern makes every picker
  fetch 500; the client's `.catch(() => {})` hides it, so nobody notices.
  Validate at `registerProvider` time or try/catch down to "no filter →
  fallback". Nit: the RegExp is constructed inside the `.filter()` callback —
  once per model id; hoist it.

## Design intent vs. implementation

- [x] **4. `refresh=1` defeats "one upstream fetch serves all kinds"** —
  *(fixed server-side: cache entries are settling promises with a `pending`
  flag; later arrivals — refreshers included — ride an in-flight fetch (it's
  fresh by definition; refresh only busts SETTLED entries, TTL runs from
  settle). No client change. Residual: sequential refreshes that arrive after
  settle still refetch — that's what refresh means. Regression test with a
  delayed fake box proves 3 concurrent per-kind refreshers = 1 upstream ask)* the
  plugin modal builds tagger/embed/transcribe sections together on open; each
  select's first visit sends `refresh=1`, and refresh busts the *shared raw*
  cache — so opening one provider's modal fires 2–3 racing upstream `/models`
  fetches (no in-flight dedup in `cachedProviderModels`). The test asserting
  "embed rode the tagging fetch's cache" passes only because it doesn't send
  refresh. Options: in-flight promise dedup + refresh coalescing (a refresh
  arriving mid-fetch rides it), or only the tagging picker refreshes.

- [x] **5. Transient failure cached as `null` for the full TTL** —
  *(fixed: failures aren't cached at all — a null settle drops its own cache
  entry (guarded so it never evicts a newer one), so the next plain ask
  re-probes and heals the moment the box is back. Riders on the in-flight
  fetch still get the null; #4's coalescing prevents stampedes; a dead box
  refuses in ms and asks are interactive-only. Regression test: flaky box
  500→200, heals on a plain revisit with no refresh/TTL wait)*
  `cachedProviderModels` stores a failed fetch (`live = null`) with the same
  10-min TTL as a success. First-per-picker refresh mostly self-heals, but
  switching connections back and forth inside one open modal serves the
  poisoned null. Shorter failure TTL, or don't cache null.

- [x] **6. Ollama tagger picker lists embedding models** —
  *(fixed: `modelFilter: "^(?!.*(embed|bge))"` added to the example plugin —
  the mirror image of `embeds.filter`, with a comment telling future editors
  to keep the two patterns in sync. Chat models incl. llava pass; nomic/bge/
  mxbai/snowflake embedders are hidden from the tagger picker)* the example plugin
  declares `embeds.filter: "embed|bge"` but no `modelFilter`, so
  `nomic-embed-text` shows as a *tagging* candidate and the wire hard-fails on
  models that can't tool-call. Mirror-image one-liner:
  `modelFilter: "^(?!.*(embed|bge))"`.

## Smaller

- [x] **7. board-modal doesn't uphold `attachLiveModels`' documented
  invariant** — the comment promises `_modelKey` updates "unconditionally,
  including for null (the App default row)", but `syncAiModelSel` only calls
  it inside `if (key)`. A slow response for the previous connection refills
  the now-hidden select. Harmless today; caller contradicts the contract.
  *(fixed: `attachLiveModels(sel, key ? key.id : null)` moved outside the
  `if (key)` in BOTH board-modal (App default row) and mapping-modal (Board
  default row — same gap); plugin-modal already did this via syncLive)*

- [x] **8. Env-key anthropic default tagger can't list** — *(fixed: the route
  grew an `id === "env"` branch — lists as provider `anthropic` with
  `process.env.ANTHROPIC_API_KEY`, 404 when unset, reserved cache id 0 (row
  ids start at 1; the env key changes only with a restart so no mutation path
  invalidates it). plugin-modal's tagger syncLive passes "env" through
  instead of nulling it; attachLiveModels needed no change — a string keyId
  rides the same URL/guard. Route test covers 404, live listing via
  ANTHROPIC_BASE_URL, and cache behavior)*

- [x] **9. OpenRouter risk note is stale** — *(fixed: the plan's bullet now
  records the datalist's removal — the ~400 ids land in a plain `<select>`
  unfiltered, accepted for now, with `modelFilter` named as the ready lever)*

- [x] **10. Anthropic wire `listModels` effectively untested** — *(fixed:
  fakeAnthropicBox serves paged models.list responses by hit count; test
  proves both pages are walked via has_more and display_name becomes the
  picker note)*

- [x] **11. Filter noise (self-heals at call time, maybe fine)** — *(fixed as
  comments: openai.js notes Responses-API-only/instruct ids pass because a
  name pattern can't see the serving API — call time fails readably;
  gemini.js notes gemma-* is excluded deliberately, spotty tool-calling)*

- [x] **12. `?refresh=0` busts the cache** — *(fixed: `refresh === "1"`
  strict compare; asserted in the env-route test)*

## Found in the field (post-sweep)

- [x] **13. Test on a healthy-but-empty Ollama box says "model not found"** —
  keyTest "models" probes `/models/{defaultModel}`, conflating "box up" with
  "curated default pulled"; a fresh box reads as broken. *(fixed: compat wire
  gained `keyTest: "list"` — probes the models INDEX, proving reachability/
  auth regardless of what's pulled; the Ollama example now declares it.
  Installed plugin copies need an update/reinstall to pick it up)*

- [x] **14. An empty live answer impersonated a missing one** — `!live?.length`
  treated "provider answered: nothing here" like "couldn't ask", so a fresh
  box showed curated suggestions indistinguishable from installed models
  (the field report behind #13). *(fixed: null live (couldn't ask) keeps
  plain suggestions; an ANSWERED-but-absent set serves them with the note
  suffixed "not listed by this connection" — data-only, flows through the
  existing note rendering, no client change. Broken-filter fallback stays
  unmarked: no evidence of absence)*

- [x] **15. The plugin modals' footer "Save" was a trap** — it committed ONLY
  one section (rate limit / connector config / media limit) while looking
  modal-wide, then reload() rebuilt every section and silently discarded a
  staged model choice. *(fixed per plugin-modal-live-save-plan.md: Save
  buttons removed everywhere — settings fields autosave on change (per-key
  PATCH merge, error → toast + revert, no focus-stealing rebuild); secrets
  save on non-empty blur only, cleared only via the explicit confirmed
  remove; connector Test moved inline; footer holds just Close for every
  plugin kind. Slot sections and add/edit forms unchanged BY DECISION —
  slot changes and record creation stay explicit buttons)*

- [x] **16. A disproved default guess survived the live refill, selected** —
  the picker's instant render preselects the curated defaultModel as a
  guess; the live refill preserved "the current selection" without being
  able to tell a persisted choice from that guess, so a never-pulled
  recommendation (llama3.1:8b) stayed selected and choosable on a fresh
  Ollama board picker. *(fixed: the answer owns the options — what survives
  is a selection present in the answer, or the PERSISTED model threaded
  through every attachLiveModels call site (board/mapping/tagger/embed/
  transcribe), which is kept even when absent but labeled "not listed by
  this connection" via fillModelSelect's new absentNote — claimable only
  off a live answer, never a fallback. Follow-up: the mechanism consolidated
  behind ONE exported entry point, syncModelPicker(sel, entry, keyId,
  {kind, saved}) — fillModelSelect/attachLiveModels went module-internal;
  the five call sites hand over facts and never touch the two-phase
  render/upgrade/eviction mechanics. Persistence stays context-owned by
  design: no provider-level layer can know which saved model matters to a
  given picker)*

## Verified sound (no action)

Cache invalidation coverage (PATCH/DELETE routes + plugin uninstall — also
covers row-id reuse after delete); keyless connections send no `Bearer null`;
`listModels: false` vs `keyTest: "completion"` correctly distinct; kind param
validation; admin-only auth on the route; merge/fallback semantics match the
plan; empty-id rows dropped; empty-filter-result falls back to curated.
