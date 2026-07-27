# Plan: dynamic model discovery

## Goal

Stop hardcoding model catalogs. Today every provider descriptor ships a static
`models: [{ id, note }]` list that Claude picked at authoring time; models get
retired and launched without us. After this change, the app **asks each provider
what models exist** (using the connection's own key/server), keeps a small
curated fallback for when it can't ask, and always lets the user type an
arbitrary model ID. No community metadata registry (models.dev etc.) — that's an
explicit non-goal for now; we only need "which IDs exist and which one was
picked".

This matches the ecosystem-converged pattern (Open WebUI, LobeChat, OpenCode):
live-fetch for existence, curated fallback for offline/unsupported, free text as
the escape hatch.

## What already exists (why this is cheap)

- The compat wire already GETs `{base}/models/{id}` for its key test
  (`server/ai-providers/wires/compat.js`, `testKey`) — the listing endpoint is
  the same URL minus the ID.
- `boards.ai_model` is already a free TEXT column; only the UI pretends the
  model is a fixed choice.
- The board modal's select populator already preserves an unknown current model
  as an extra option (`public/board-modal.js` ~L222).
- Plugins return the same descriptor contract as built-ins, so they inherit all
  of this for free — the Ollama plugin's hand-edited model array stops being
  necessary (Ollama's OpenAI-compat surface serves `GET /v1/models` from the
  local tags).

## Design

### 1. Wire layer: a `listModels` verb (peer of `testKey`)

Each wire family gains `listModels(desc, { apiKey, base })` returning a
normalized `[{ id, note? }]`, or `null` when the provider can't list.

- **compat wire**: `GET ${baseOf(desc, base)}/models` with `compatHeaders`,
  30 s interactive timeout (same as keyTest). Map `data[].id`; ignore the rest.
  Providers whose descriptor says `compat.keyTest === "completion"` (GLM — no
  models endpoint) return `null`.
- **anthropic wire**: `client.models.list()` via the SDK (paginate; it returns
  `display_name`, which becomes `note`).
- On-device providers (`local`, `whisper`): no change; their catalogs are
  genuinely fixed by what's installed.

Keep the "quirks are data" philosophy: no vendor branches in the wire; anything
provider-specific rides the descriptor.

### 2. Descriptor: `models` becomes "recommended", plus an optional filter

- `models` and `defaultModel` stay, reinterpreted: **recommended picks + offline
  fallback**, not the catalog. Trim ruthlessly — 2–3 entries with notes.
- New optional descriptor field `modelFilter` (data, not code): an array of
  prefixes/substrings used to cut noise from raw listings before display.
  Needed because OpenAI's list includes tts/dall-e/embedding IDs and OpenRouter
  returns ~400 entries. A filter rule ages far better than a model list; a
  provider without one shows everything.
- Same field nested under `embeds` / `transcribes` when we extend listing to
  those catalogs (phase 4).

### 3. Engine + HTTP API

- `providers.js`: `listModels({ provider, apiKey, base })` dispatcher, same
  shape as `testKey` (interactive → not paced through the token bucket).
  Applies `modelFilter`, merges the descriptor's recommended entries on top
  (dedup by id, recommended first so their notes win).
- New route `GET /api/admin/ai-keys/:id/models` — connection-scoped, so the
  key and per-connection `base_url` come from the `ai_keys` row, mirroring the
  existing key-test route (`server/server.js` ~L1559). Response:
  `{ models: [{ id, note?, recommended? }], source: "live" | "fallback" }`.
- **Cache** per connection in memory, TTL ~10 min; `?refresh=1` busts it
  (explicit refresh affordance in the UI). On fetch failure or `null` wire
  support: serve the descriptor fallback with `source: "fallback"` — never an
  error, never an empty picker.

### 4. UI: the select stays, its options go live

(Superseded in implementation: an input + datalist combobox was tried first
and rejected — Chrome filters datalist suggestions against the prefilled
value, hiding the full list behind a broken-looking dropdown. The `<select>`
keeps its UX; discovery happens behind it.)

- The existing `<select>` fills from `providerCatalog()` for an instant
  render, then `attachLiveModels` re-fills its options from the new
  per-connection endpoint when the response lands, preserving the current
  selection (an unknown/retired saved id stays as an extra option — the
  pre-existing fillModelSelect behavior).
- Recommended entries listed first with their notes; the rest as bare IDs.
- The first fetch per picker+connection sends `?refresh=1` — opening a picker
  is the "I just pulled a model" moment; revisits ride the server cache.
- `providerCatalog()` keeps serving the static lists so the picker renders
  instantly before/without a fetch, and for the no-connection-yet flow.

## Phases

1. ~~Escape hatch first: free-text model entry~~ (dropped with the combobox —
   the DB/API still accept any model string, so the escape hatch exists at the
   API layer; the UI offers the discovered list only).
2. **Wire + engine + route**: `listModels` on both wire families, dispatcher,
   connection-scoped endpoint with TTL cache and fallback semantics. Tests:
   mocked-fetch wire tests, dispatcher fallback test, route test (mirror the
   existing keyTest test structure in `test/providers.test.js`).
3. **UI integration**: live-refilled select fed by the endpoint (refresh on
   first fetch per picker). Update the Ollama example plugin: shrink its
   `models` to a fallback note — no code change needed.
4. **Noise filters + secondary catalogs** (delivered): the listing endpoints
   carry no capability metadata, so name-pattern filters ride the descriptor
   as data — `modelFilter` (tagging), `embeds.filter`, `transcribes.filter` —
   and the engine carves one shared raw fetch per catalog kind
   (`?kind=embed|transcribe` on the route). A capability catalog without a
   filter stays on its curated list (an unfiltered dump would be worse than
   hardcoding). OpenRouter's tagging list remains unfiltered for now.

## Non-goals (deliberate)

- No models.dev / LiteLLM metadata layer (pricing, context windows, capability
  badges). Revisit only if we ever want capability filtering in the picker.
- No background/scheduled refresh — fetch is on-demand (picker open / refresh
  click) with a short TTL; a stale list self-heals at call time anyway because
  the provider rejects a retired ID with a readable error.
- No change to how a chosen model is stored or resolved
  (`boards.ai_model` → `PROVIDERS[p].defaultModel` fallback stays as is).

## Risks / edge cases

- **Listing needs a valid key** — the picker may open before a key is saved or
  with a bad key. Fallback semantics cover this: static list + free text, and
  the existing Test button already tells the user their key is bad.
- **Gemini/GLM compat quirks**: Gemini's OpenAI-compat layer serves `/models`;
  GLM does not. (Superseded in implementation: encoded as its own
  `compat.listModels: false` quirk, NOT derived from `keyTest: "completion"` —
  OpenRouter proves the two differ: it key-tests via completion because it has
  no per-model GET, yet lists fine.)
- **Keyless-networked (Ollama, LM Studio)**: listing hits the user's own box;
  the 30 s interactive timeout and per-connection base already handle it.
- **Huge lists (OpenRouter)**: `modelFilter` plus datalist's native typeahead
  keep it usable; if still noisy, cap the display and rely on typeahead.
