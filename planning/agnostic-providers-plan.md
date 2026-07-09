# Agnostic providers — one descriptor per AI provider, no name-branching

Self-contained implementation plan. Behavior-preserving refactor of the AI-tagger provider layer (`server/providers.js` + its `admin.js` mirror). No user-visible change; the payoff is that adding the *next* provider is one descriptor, not a thread through six structures and three functions.

## The problem

Everywhere else in the app, a type owns its behavior and the core stays blind: `server/sources/index.js` picks a handler and "stays format-blind"; `kinds.js` has each kind own its `face()`. Adding a type = adding one adapter. That was the whole point of the agnostic-core / image-module dissolution.

The provider layer is the last holdout. It's non-agnostic on two axes:

**Knowledge is smeared across parallel structures.** A provider isn't one object — it's an entry in `PROVIDERS`, `PROVIDER_DEFAULT_MODEL`, `COMPAT`, `EMBED_PROVIDERS`, `PROVIDER_EMBED_MODELS`, `PROVIDER_DEFAULT_EMBED_MODEL`, **plus** a hand-synced mirror in `admin.js` (`PROVIDER_MODELS`, `EMBED_MODELS`, and a second copy of the defaults) held together only by "keep in sync" comments. The model catalog *with its notes* exists **only client-side** — the server never had it.

**Behavior is `if (provider === …)` threaded through functions.** From the GLM add:
- `callTagger` / `testKey`: `if (COMPAT[provider]) … else anthropic`
- `compatRequest`: `provider === "openai" ? max_completion_tokens : max_tokens`, `glm ? "auto" : forced`, `glm ? {} : { strict:true }`, `glm ? { thinking:{type:"disabled"} } : {}`
- `testKey`: a dedicated `if (provider === "glm")` arm (1-token completion) vs the compat `GET /models/{id}` arm

Every new provider re-opens those three functions and adds another arm. That's the core knowing about every provider.

## The model

**Provider = descriptor.** One object per provider carries every quirk as *data*, plus a pointer to its wire family. The generic code reads fields off the descriptor; it never sees a provider name.

**Wire family = the one real branch.** There are exactly two request/response protocols: `anthropic` (SDK, `tool_use` blocks, `pause_turn` loop, server-side web_search) and `openai-compat` (plain `fetch` to `/chat/completions`). That distinction is genuine and stays — but as a single `desc.wire` dispatch, not scattered name checks. Each wire family owns `tag` / `testKey` / `embed`, and reads the descriptor's data for the per-provider quirks.

### Descriptor shape (`server/providers.js`)

```js
const anthropic = {
  label: "Anthropic", wire: anthropicWire,
  defaultModel: "claude-haiku-4-5",
  models: [
    { id: "claude-haiku-4-5", note: "fast, cheapest" },
    { id: "claude-sonnet-4-6", note: "balanced" },
    { id: "claude-opus-4-8", note: "sharpest, most expensive" },
  ],
  research: true,          // server-side web_search before tagging
  embeds: null,            // no embeddings API
};

const openai = {
  label: "OpenAI", wire: compatWire,
  base: "https://api.openai.com/v1",
  defaultModel: "gpt-5-mini",
  models: [ /* gpt-5-nano / gpt-5-mini / gpt-5.1, as shipped */ ],
  research: false,
  compat: { maxTokensField: "max_completion_tokens", forceToolChoice: true, strictTools: true, disableThinking: false, keyTest: "models" },
  embeds: {
    default: "text-embedding-3-small",
    models: [
      { id: "text-embedding-3-small", note: "cheapest, plenty here" },
      { id: "text-embedding-3-large", note: "sharper, ~6× cost" },
    ],
  },
};

const gemini = {
  label: "Gemini", wire: compatWire,
  base: "https://generativelanguage.googleapis.com/v1beta/openai",
  defaultModel: "gemini-2.5-flash",
  models: [ /* flash-lite / flash / pro */ ],
  research: false,
  compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: true, disableThinking: false, keyTest: "models" },
  embeds: { default: "gemini-embedding-001", models: [{ id: "gemini-embedding-001", note: "Gemini's embedder" }] },
};

const glm = {                                  // Z.ai — text/vision are separate families; default must be a V model
  label: "GLM", wire: compatWire,
  base: "https://api.z.ai/api/paas/v4",
  defaultModel: "glm-4.6v",
  models: [
    { id: "glm-4.6v-flash", note: "free" },
    { id: "glm-4.6v", note: "balanced" },
    { id: "glm-5.2", note: "sharpest, text boards only" },
  ],
  research: false,                             // has a chat-completions web_search tool — future work
  compat: { maxTokensField: "max_tokens", forceToolChoice: false, strictTools: false, disableThinking: true, keyTest: "completion" },
  embeds: null,                                // Z.ai international has no embeddings API
};

export const PROVIDERS = { anthropic, openai, gemini, glm };
```

Each `if (provider === …)` from the GLM add becomes a field lookup:

| Today (scattered) | Agnostic (data) |
|---|---|
| `if (COMPAT[provider])` | `desc.wire` |
| `provider === "openai" ? max_completion_tokens : max_tokens` | `desc.compat.maxTokensField` |
| `glm ? "auto" : forced` | `desc.compat.forceToolChoice` |
| `glm ? {} : { strict:true }` | `desc.compat.strictTools` |
| `glm ? thinking:disabled : {}` | `desc.compat.disableThinking` |
| `if (provider === "glm")` testKey arm | `desc.compat.keyTest` (`"completion"` \| `"models"`) |
| `EMBED_PROVIDERS` / `PROVIDER_*_EMBED_MODEL` | `desc.embeds` |
| `research` gate | `desc.research` |

### Wire families

```js
const compatWire = {
  tag(desc, { apiKey, model, systemText, schema, parts, tool }) { /* current compatTag, reading desc.base + desc.compat */ },
  testKey(desc, { apiKey, model }) { /* desc.compat.keyTest === "completion" ? 1-token chat : GET /models/{id} */ },
  embed(desc, { apiKey, model, texts }) { /* current embedTexts, reading desc.base */ },
};

const anthropicWire = {
  tag(desc, args) { /* current anthropicTag, honoring desc.research */ },
  testKey(_desc, { apiKey, model }) { /* current countTokens probe */ },
  embed: null,
};
```

The public functions become thin dispatchers that look up the descriptor once and delegate:

```js
export function callTagger({ provider, research, ...rest }) {
  const desc = PROVIDERS[provider];
  return desc.wire.tag(desc, { ...rest, research: research && desc.research });
}
export function testKey({ provider, ...rest })   { const d = PROVIDERS[provider]; return d.wire.testKey(d, rest); }
export function embedTexts({ provider, ...rest }) { const d = PROVIDERS[provider]; return d.wire.embed(d, rest); }
```

`anthropicRequest` and `compatRequest` stay exported as the pure request builders (the test seam); they now read a descriptor. To avoid churning `test/compat.test.js`, `compatRequest` keeps accepting `{ provider, … }` and looks up `PROVIDERS[provider].compat` internally — same call signature, same asserted output.

### Keeping the callers stable (transition)

`worker.js` and `server.js` import named exports (`PROVIDER_DEFAULT_MODEL`, `EMBED_PROVIDERS`, `PROVIDER_DEFAULT_EMBED_MODEL`, `PROVIDERS`). Rather than rewrite them all at once, **generate the legacy-named exports from the registry** so they can't drift:

```js
export const PROVIDER_NAMES = Object.keys(PROVIDERS);
export const PROVIDER_DEFAULT_MODEL       = mapVals(PROVIDERS, (p) => p.defaultModel);
export const EMBED_PROVIDERS              = PROVIDER_NAMES.filter((n) => PROVIDERS[n].embeds);
export const PROVIDER_DEFAULT_EMBED_MODEL = mapVals(embedOnly, (p) => p.embeds.default);
```

Single authored source (the registry); the old shapes are derived views. One real caller edit: `server.js` validation `PROVIDERS.includes(provider)` → `provider in PROVIDERS` (since `PROVIDERS` is now the descriptor map, not an array). `PROVIDER_EMBED_MODELS` (exported but imported nowhere — only mirrored in an admin comment) is dropped; its data now lives in `desc.embeds.models`.

## Serve the catalog; delete the client mirror

The catalog (models + notes + defaults) is authored once, server-side, and shipped to admin. Fold a `providers` array into the existing `GET /api/admin/ai-config` response (admin already fetches it — no new route):

```js
providers: PROVIDER_NAMES.map((name) => {
  const p = PROVIDERS[name];
  return { name, label: p.label, defaultModel: p.defaultModel, models: p.models,
           research: p.research, embeds: p.embeds && { default: p.embeds.default, models: p.embeds.models } };
})
```

No secrets in it (labels and model ids only), so it rides safely on the admin payload. Then in `admin.js`, **delete**: `PROVIDER_MODELS`, the `PROVIDER_DEFAULT_MODEL` mirror, `EMBED_MODELS`, `EMBED_DEFAULT_MODEL`, and the hardcoded `["anthropic","openai","gemini","glm"]` dropdown list. `fillModelSelect`, the provider `<select>`, and the embed-model `<select>` read from `cfg.providers` instead. Result: **adding a provider is one server descriptor and zero client edits.**

## Files

- `server/providers.js` — the refactor: descriptor registry, two wire families, thin dispatchers, generated legacy exports. Net simpler; the name-branches collapse into data.
- `server/server.js` — one line: `PROVIDERS.includes` → `provider in PROVIDERS`; add `providers` to the ai-config response.
- `admin.js` — delete the four mirrored structures + the dropdown array; read `cfg.providers`.
- `server/schema.sql` — no change (comment already lists all four).

## Tests

The existing shape-pinning suite is the safety net for a behavior-preserving refactor — it must stay green with only signature adaptation:
- `test/compat.test.js`, `test/research.test.js`, `test/extraction.test.js`, `test/docs.test.js` — keep asserting the exact same request bytes through `compatRequest`/`anthropicRequest`.

New (`test/providers.test.js`):
- **Registry integrity**: every descriptor has `label`, `defaultModel`, `models[]`, `wire`; every model note is a string; `defaultModel` is in `models`.
- **Capabilities-as-data** (the anti-regression for what this refactor is *for*): `glm.compat` = `{forceToolChoice:false, strictTools:false, disableThinking:true, keyTest:"completion"}`; `openai`/`gemini` = `{forceToolChoice:true, strictTools:true, disableThinking:false, keyTest:"models"}`.
- **Derived exports match**: `EMBED_PROVIDERS` = `["openai","gemini"]`; `PROVIDER_DEFAULT_MODEL.glm` = `"glm-4.6v"`; `PROVIDERS` has exactly the four keys.
- **Served catalog**: `GET /api/admin/ai-config` returns `providers` with notes and defaults; GLM entry marks `glm-5.2` "text boards only"; anthropic entry has `embeds:null`.

## Verify (live)

Behavior-preserving, so the live check is "nothing changed for the user":
1. Restart → admin AI panel lists all four providers, each with its model dropdown + notes (now server-fed), embed dropdown for OpenAI/Gemini only.
2. Each provider's **test** button still works; tagging a board still runs and bills as before.
3. Grep the tree: zero `provider === "…"` or `if (COMPAT[…])` name-checks remain in `providers.js`; `admin.js` no longer hardcodes model lists or the provider array.

## Phases

1. **Server registry (behavior-preserving).** Descriptor map + wire families + thin dispatchers + generated legacy exports + the `server.js` one-liner. Existing tests stay green; no client change. This is the whole structural win and is independently shippable.
2. **Serve + delete the mirror.** Add `providers` to ai-config; gut the `admin.js` duplicates. Now provider-adds are one descriptor.
3. *(optional tidy, deferrable)* Migrate `worker.js`/`server.js` off the generated legacy exports onto accessors, then delete the generated shims. Pure cleanup once phase 1 has settled.

## Deferred

- GLM web-search research (it has a chat-completions `web_search` tool — `desc.research` could go true with a compat-side research path). First compat provider that could support the per-board research toggle.
- Per-provider request tuning beyond the current four flags — add fields to `desc.compat` as real divergences appear, never a new `if (name)`.
