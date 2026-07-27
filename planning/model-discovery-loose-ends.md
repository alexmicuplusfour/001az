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

## Verified sound (no action)

Cache invalidation coverage (PATCH/DELETE routes + plugin uninstall — also
covers row-id reuse after delete); keyless connections send no `Bearer null`;
`listModels: false` vs `keyTest: "completion"` correctly distinct; kind param
validation; admin-only auth on the route; merge/fallback semantics match the
plan; empty-id rows dropped; empty-filter-result falls back to curated.
