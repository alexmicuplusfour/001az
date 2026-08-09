# Capabilities — a definition-driven capability registry (and the page it renders)

**Status: SLICE 1 SHIPPED locally 2026-08-09 (uncommitted). Full suite green
(930) with ZERO edits to existing test files — the proof it is read-side only.
`server/capabilities.js` seeds the registry; `provides` is now the normal form
on every descriptor in `PROVIDERS`. Slices 2–6 are still plan-only. The
proposal: make CAPABILITY a
first-class registry (`server/capabilities.js`, one `CAPABILITY_DEFS` entry per
capability) exactly the way `KIND_DEFS` made plugin kinds first-class, then
render a Capabilities page as a pure projection of it. Adding a capability
becomes one descriptor + one wire method; the resolver, the admin routes, the
key-cleanup, the modal section, and the page all stop changing. Slices 1–3 are
worth shipping even if the page is never built. Self-contained for a fresh
session.**

## Why (the vision this serves)

Two goals, in priority order:

1. **Any configuration renders honestly.** Not "here is what today's box looks
   like" — a derived state machine that is correct for a config nobody has
   built yet, including one where a plugin supplies a capability that didn't
   exist when the page was written.
2. **Adding a capability is one descriptor, no runtime edits.** This is the
   same sentence the repo already earns for providers (`server/providers.js`
   header: *"Adding a provider, built-in or plugin, is one descriptor"*),
   connector domains (*"one directory under `server/connectors/`, no runtime
   edits"*), media fields, and — per [plugin-kinds-plan.md](plugin-kinds-plan.md)
   — plugin kinds. Capability is the one axis that never got the treatment,
   and it is now the most-duplicated concept in the codebase.

The Capabilities page is the *payoff*, not the point. The point is that the
codebase currently has no noun for the thing the page would list.

## The evidence — capability is a naming convention repeated 5×

### The isomorphism

[`resolveDefaultAi`](../server/worker.js#L95), [`resolveEmbedder`](../server/worker.js#L122),
[`resolveTranscriber`](../server/worker.js#L1082), [`resolveDetector`](../server/worker.js#L1180)
are one function written four times. Every one of them: read the provider
setting → check the advertise flag → `aiPluginInstalled` → load the key row (or
accept `onDevice` bare) → resolve the model (setting, else descriptor default) →
`aiRate` for pacing → wrap in `withPluginHealth('ai:'+p)` → fall back.

| | tag | extract | embed | transcribe | detect |
|---|---|---|---|---|---|
| provider declares | `wire.tag` (fn) | *(reuses `wire.tag`)* | `embeds` (obj) | `transcribes` (obj) | `detects` (obj) |
| provider setting | — | — | `embed_provider` | `transcribe_provider` | `detect_provider` |
| key setting | `default_key_id` | `boards.extract_key_id` | `embed_key_id` | `transcribe_key_id` | `detect_key_id` |
| model setting | `model` | `boards.extract_model` | `embed_model` | `transcribe_model` | `detect_model` |
| on/off | — | — | `embed_enabled` | *(always on)* | *(always on)* |
| floor | env `ANTHROPIC_API_KEY`, else **blocked** | board tagger, else blocked | **off** | whisper sidecar | localDetector sidecar |
| scope | board-or-global | **board only** | global | global (`board` param dead) | global (`board` param dead) |
| extra knobs | — | — | — | — | `detect_threshold` |
| model-catalog kind | `"tagging"` | — | `"embed"` | `"transcribe"` | `"detect"` |

Five conventions for the settings keys (tagging doesn't even use a `tag_`
prefix), three shapes of declaration (function-presence, object, absent), two
scope models, and `MODEL_KINDS` calls it `"tagging"` while
[`plugins.js`](../server/plugins.js#L38) calls it `"tag"`.

### Every place a new capability must be hand-edited today

| # | Site | What must be added |
|---|---|---|
| 1 | [`providers.js` dispatchers](../server/providers.js#L124) | a 5th `pace → desc.wire.X(desc, rest)` copy |
| 2 | [`providers.js` `KIND_CATALOG`](../server/providers.js#L191) | a model-catalog entry |
| 3 | [`providers.js` `providerCatalog()`](../server/providers.js#L310) | an echoed flag line |
| 4 | [`plugins.js` `aiDefs().capabilities`](../server/plugins.js#L38) | a hand-written `!!` mapping |
| 5 | [`plugin-loader.js` ai-provider `validateBuilt`](../server/plugin-loader.js#L86) | a "advertising X requires wire.x" check |
| 6 | [`worker.js`](../server/worker.js#L1180) | a 5th `resolveX` |
| 7 | [`server.js` `/api/admin/plugins` slots](../server/server.js#L1876) | a slot block |
| 8 | [`server.js` `/api/admin/ai-config` GET+POST](../server/server.js#L2196) | ~40 lines of validation, duplicated |
| 9 | [`server.js` `*-test` probe route](../server/server.js#L2400) | a 4th near-identical probe |
| 10 | [`db.js` `deleteAiKey`](../server/db.js#L1140) | dead-pointer cleanup |
| 11 | [`admin-plugins.js` `slotProviders`/`tagFor`](../public/admin-plugins.js#L24) | a badge branch |
| 12 | [`plugin-modal.js`](../public/plugin-modal.js#L829) | a ~120-line section |

Twelve sites. Measured: adding `detect` touched 7 files and 24 `detect_*`
settings-key call sites. The four modal sections
(`taggerSection` 505–583, `embedSection` 584–705, `transcribeSection` 706–828,
`detectSection` 829–953) are **449 lines** of near-identical code — 38% of
[plugin-modal.js](../public/plugin-modal.js).

### The bug this shape already produced

[`deleteAiKey`](../server/db.js#L1140) clears the dead pointer for
`default_key_id`, `embed_key_id`, and `transcribe_key_id`. Its own comment says
why:

> *"Transcription mirrors embed: a deleted key/connection reverts the slot to
> the whisper sidecar honestly, instead of leaving a dead pointer the UI shows
> as configured while resolveTranscriber silently falls back."*

**`detect_key_id` is not in that function.** Grep it: four hits in
[server.js](../server/server.js#L1901), zero in `db.js`. Delete the key backing
a provider detector and you get exactly the dishonesty the comment was written
to prevent — the Plugins page reports the provider as configured while
[`resolveDetector`](../server/worker.js#L1180) silently serves the local
sidecar. The fourth capability missed the cleanup the first three got. Nothing
detects that class of omission today because there is no list to iterate.

**Fixing this in isolation is the wrong move** — it is the fifth copy of a
cleanup that should be `for (const cap of CAPABILITY_DEFS) …`. It gets fixed as
a *consequence* of Slice 2, and Slice 2 gets a regression test that iterates the
registry so capability #6 cannot repeat it.

### The one capability that already resolves better than the rest

[`activeProvider`](../server/connectors/runtime.js#L119) (connector domains)
does something no AI capability does: when the starred provider isn't installed
it **scans for any installed sibling** before giving up, and only then throws a
message naming the fix. It also already publishes `{ setting, effective }` so
the two can be compared. That is the richest floor behavior in the codebase and
it is trapped in the connector runtime. The registry generalizes it to every
capability for free.

## Prior art — what the four ecosystems that solved this agree on

Researched 2026-08-09. All four converge on the same chain: **declare →
uniform predicate → derive → render generically.**

| Source | The transferable lesson |
|---|---|
| [LSP `ServerCapabilities`](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/specification.md) | The server declares at `initialize` *"so the protocol can be used even if the client or server does not support all the features"* — independent evolution of both sides is the **stated** design goal. `transcribes` already **is** a `ServerCapabilities` field; the host half is missing. |
| [MCP capability negotiation](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) | Servers supporting tools **MUST** declare the capability, and both parties *"refrain from invoking any features not agreed upon."* Declaration is a hard contract, not a hint — mirrors `validateBuilt`'s "advertising `transcribes` requires `wire.transcribe`", which should be generic. |
| [Home Assistant `supported_features`](https://developers.home-assistant.io/docs/core/entity/) | One integration-set bitfield drives *three unrelated consumers* — frontend controls, service-call routing, and the HomeKit/Alexa/Google bridges. Zero per-feature UI code. Also: [architecture #1320](https://github.com/home-assistant/architecture/discussions/1320) is them retrofitting *custom* integrations defining their own features — the argument for designing plugin-contributed capabilities in from the start. |
| [chrome://gpu Graphics Feature Status](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips) | Every row is status **plus cause** ("software only, hardware acceleration disabled"), and it works because it's generated from the feature list, not authored. This is the card. |
| [HF Tasks](https://huggingface.co/tasks/image-classification) | Task-first browsing is the right axis when supply is many-to-many. Least important of the five — it addresses discovery; the real problem here is resolution and honesty. |

**No step in the chain may contain a capability name.** That is the test every
line of this plan has to pass.

## The design — four pillars

### Pillar 1 — `provides`: one shape of declaration

Today a provider declares capability three different ways. Normalize to one map:

```js
// in an ai-provider descriptor (built-in or plugin — same contract)
provides: {
  tag:        { models: [...], default: "claude-haiku-4-5", filter: "^claude" },
  embed:      { models: [...], default: "text-embedding-3-small" },
  transcribe: { models: [...], default: "gpt-4o-transcribe" },
  research:   true,   // a capability with no model axis is just `true`
}
```

**No migration and no plugin breakage.** A shim inside
[`install()`](../server/providers.js#L52) lifts legacy fields into `provides` at
registration time:

```js
// providers.js install(), before requireRateLimit
desc.provides ??= compat(desc);   // wire.tag → provides.tag (models/defaultModel/modelFilter),
                                  // embeds → provides.embed, transcribes → provides.transcribe,
                                  // detects → provides.detect, research → provides.research
```

This is read-side normalization. Every built-in descriptor file, every already
published plugin, and `PLUGIN_API_VERSION` stay untouched. Sites 2, 3, 4, and 5
in the table above become derivations over `provides` — **additively**; see
[Slice 1](#slice-1--provides-normalization-no-behaviour-change) for the exact
shape, which the test suite pins harder than it first appears:

- `KIND_CATALOG` → a lookup on `desc.provides[cap]`, and `MODEL_KINDS` →
  the capability id list (this also kills the `"tagging"` vs `"tag"` naming
  split — pick `tag`, alias `tagging` at the route boundary for one release).
- `providerCatalog()` → keeps emitting `embeds`/`transcribes`/`detects`
  **derived from** `provides`, and adds `provides` alongside. It is a wire
  format the client and four test files read; it cannot be swapped, only
  extended.
- `aiDefs().capabilities` → derived, but over the *capability id list*, not
  `Object.keys(provides)` — the assertion is a `deepEqual` against all five
  keys including the `false` ones.
- `validateBuilt` → the per-capability wire checks become a loop. This stays
  **plugin-only**: the built-in `whisper` and `localDetector` descriptors
  advertise a capability with `wire: null` (sidecar-backed, assembled in
  worker.js), so the rule is not a universal invariant and must never be
  hoisted into `install()`.

### Pillar 2 — `CAPABILITY_DEFS`: the registry

New file `server/capabilities.js`. Deliberately the same shape as
[`KIND_DEFS`](../server/plugin-loader.js#L83) — same argument, one level up.

```js
{
  id: "transcribe",
  label: "Transcription",
  blurb: "turns audio into text so recordings can be tagged and searched",

  // --- SUPPLY: a predicate over a live registry. NEVER a list of names. ---
  supply: {
    registry: () => PROVIDERS,               // or a connector's providers map
    advertises: (d) => d.provides?.transcribe,
    installed: (db, name) => pluginInstalled(db, `ai:${name}`),
    engine: (d, bound) => ({ transcribe: (buf, name) => transcribeAudio({ ...bound, audio: buf, filename: name }) }),
  },

  // --- SELECTION: how many providers serve at once ---
  select: "one",          // "one" = admin binds one (floor applies)
                          // "all" = every installed provider serves (media handlers)
  modifierOf: null,       // set to "tag" for `research` — renders inside the parent card

  // --- BINDING: where the choice is stored ---
  binding: {
    ns: "transcribe",     // default keys: transcribe_provider/_key_id/_model
    keys: null,           // or an explicit override for legacy layouts, e.g.
                          //   tag: { provider: null, keyId: "default_key_id", model: "model" }
    scope: "global",      // "global" | "board" | "board-or-global"
    boardKeys: null,      // e.g. extract: { keyId: "extract_key_id", model: "extract_model" }
    config: [],           // capability-level knobs — detect's threshold lives HERE
  },

  // --- FLOOR: what happens at zero configuration. Exactly three shapes. ---
  floor: { kind: "builtin", engine: whisperTranscriber, note: "on-device sidecar" },
  //     | { kind: "off" }        — feature simply absent          (embed today)
  //     | { kind: "blocked" }    — work accumulates unserved      (tag today)
  //     | { kind: "sibling" }    — scan for any installed supplier (connector domains today)

  // --- DEMAND: a live count, so a card states a consequence, not a status ---
  demand: (db) => countQueued(db, "transcribe"),

  // --- PROBE: the *-test endpoint, one generic route instead of four ---
  probe: { input: tinyWav, label: "probe.wav" },
}
```

`binding.keys` is the no-migration hatch: the four existing capabilities declare
their legacy settings keys explicitly, new ones inherit the uniform
`<ns>_provider/_key_id/_model`. Zero schema migration, zero settings rewrite.

**`select` is the honest generalization.** These are not all one species and
pretending otherwise would be the mistake:

- `select: "one"` — tag, extract, embed, transcribe, detect, each connector
  domain. Admin binds one provider; the floor covers the unbound case.
- `select: "all"` — media handlers, ingestion sources. Every installed supplier
  serves simultaneously; there is nothing to bind, so the floor never applies
  and the state is always `active`. Falls out of the same table with no special
  case.
- `modifierOf: "tag"` — `research`. Not a slot: a qualifier on whoever holds
  tagging. Renders as a line inside the tagging card, never as its own row.

### Pillar 3 — `resolveCapability`: one resolver

```js
// server/capability-resolve.js
export async function resolveCapability(db, capId, board = null) { … }
```

Replaces the four `resolveX` functions with one implementation of the eight
shared steps. The four keep their names as one-line wrappers for a release
(`export const resolveEmbedder = (db) => resolveCapability(db, "embed")`) so the
~20 call sites across [server.js](../server/server.js#L127) and
[worker.js](../server/worker.js) don't move in the same slice, then get deleted.

What becomes generic and therefore correct-everywhere:

- `withPluginHealth` wrapping — currently applied in the transcribe and detect
  engines but *not* uniformly.
- `aiRate` pacing lookup.
- The `onDevice`-resolves-bare rule.
- Dead-pointer cleanup: `deleteAiKey` becomes a loop over the registry, and the
  `detect_key_id` bug cannot recur.
- The sibling-scan floor that only connector domains have today.

### Pillar 4 — state is computed, never enumerated

This is the answer to *"any configuration."* Six states from three facts:

```
supply empty      (no installed provider advertises it)  → unavailable
bound & resolves                                          → active
bound & does NOT resolve                                  → degraded      ← invisible today
unbound & floor.builtin  (or floor.sibling finds one)     → active (floor)
unbound & floor.off                                       → off
unbound & floor.blocked                                   → blocked  (+ demand count)
```

Correct for a capability that doesn't exist yet, for a plugin-contributed one,
and for a provider that advertises three capabilities but is keyed for one.

**`degraded` is the state the current architecture structurally cannot show**,
and it is the one that matters. It is already half-computed: `slots.domains`
carries `{ setting, effective }` with the comment *"they diverge when the
starred provider isn't installed — the UI shows both."* That divergence **is**
`degraded`, computed for connector domains only. The AI capabilities have the
same divergence and don't compute it — which is precisely why the
`detect_key_id` bug is invisible instead of a red card.

New route `GET /api/admin/capabilities`, a **projection** over the same
`pluginCatalog(db)` + resolver — no second source of truth, no new storage:

```jsonc
{ "id": "transcribe", "label": "Transcription", "state": "degraded",
  "bound":   { "provider": "openai", "model": "gpt-4o-transcribe", "keyId": 3 },
  "running": { "provider": "whisper", "model": "large-v3", "reason": "bound key was deleted" },
  "supportedBy": [ { "name": "openai", "installed": true,  "hasKey": false },
                   { "name": "deepgram", "installed": false } ],
  "demand": { "waiting": 0 }, "scope": "global", "config": [] }
```

`supportedBy` generalizes [`renderableFaces()`](../server/connectors/index.js#L40),
which already computes `{ available, supportedBy }` for face producers — the
inverted index, hand-built for one narrow case. Faces become a caller.

## The capability roster (all nine, derived not typed)

| id | select | scope | supply predicate | floor | notes |
|---|---|---|---|---|---|
| `tag` | one | board-or-global | `provides.tag` | `blocked` (env `ANTHROPIC_API_KEY` is a binding rung, not a floor) | legacy keys `default_key_id`/`model` |
| `extract` | one | **board** | `provides.tag` (text-only) | `sibling` → the board's tagger, then `blocked` | today an inline shim at [worker.js:2063](../server/worker.js#L2063); no global slot, no page presence |
| `embed` | one | global | `provides.embed` | `off` (`embed_enabled`) | the only capability with an explicit on/off |
| `transcribe` | one | global→board | `provides.transcribe` | `builtin` whisper sidecar | `board` param already accepted and dead |
| `detect` | one | global→board | `provides.detect` | `builtin` localDetector sidecar | capability config: `threshold` |
| `research` | — | — | `provides.research` | — | `modifierOf: "tag"`; per-board `ai_research` |
| `crypto`, `stocks`, … | one | global | `conn.providers[*]` | `sibling` (already implemented) | **generated** from `listConnectors()`, never typed |
| `ingest` | all | — | `MEDIA_MANIFESTS` | n/a | per-type `maxBytes` config; renders permanently `active` |
| `source` | all | — | `sourceManifests()` | `builtin` folder when `INGEST_ROOT` set | binding is saved connections, not a star |

Two things this roster surfaces that the current UI cannot:

- **`extract` is a real capability with no page, no global default, and no
  advertise flag** — it borrows `wire.tag` and is bound per-board only. It is
  invisible in every existing surface. The registry gives it a card and,
  optionally, the global default it never had.
- **`research` is a modifier, not a slot.** Modelling it as `modifierOf` is what
  stops the page growing a row for something that isn't independently bindable.

## The page

`public/admin-capabilities.js`, ~150 lines, **no capability knowledge**, one
`GET /api/admin/capabilities`:

```
Transcription                                        ⚠ degraded
turns audio into text so recordings can be tagged and searched
Configured:  OpenAI · gpt-4o-transcribe
Running:     Whisper sidecar — the bound key was deleted
Could serve: OpenAI (added, no key) · Deepgram (not added)
                                        [ Re-bind → ]   [ Clear → ]
```

Every line derives from the payload. It does **not** replace the Plugins page —
that owns the lifecycle (add / key / health / provenance / uninstall), and Home
Assistant keeps both axes for the same reason. Capability badges on plugin cards
([`tagFor`](../public/admin-plugins.js#L44)) become links into it.

Deliberately **no completion score**. "4/9 configured" shames a correct
configuration — most instances legitimately never want crypto. States are
working / needs a key / not needed, with a per-capability dismissal that turns
the page into a statement of intent rather than a nag.

## Slices

Each is independently shippable and green-on-`npm test` before the next starts.

### Slice 1 — `provides` normalization (no behaviour change)

Specified in full below. **The contract: additive only.** Nothing legacy is
removed, renamed, or stops being emitted; the acceptance test is `npm test`
green with **zero edits to existing test files**.

#### 1.1 The shim

```js
// server/providers.js — normalize legacy capability declarations into `provides`.
// Read-side only: the legacy fields stay on the descriptor untouched, so every
// existing consumer, plugin, and test keeps reading exactly what it reads today.
// Exported so plugin-loader's validateBuilt normalizes through the SAME code —
// one implementation, or the loader and the registry drift.
const LEGACY_LIFT = [
  ["tag",        (d) => (d.wire?.tag ? { models: d.models || [], default: d.defaultModel ?? null, filter: d.modelFilter ?? null } : null)],
  ["embed",      (d) => d.embeds      || null],
  ["transcribe", (d) => d.transcribes || null],
  ["detect",     (d) => d.detects     || null],
  ["research",   (d) => (d.research ? true : null)],
];
export function normalizeProvides(desc) {
  const out = {};
  for (const [cap, lift] of LEGACY_LIFT) { const v = lift(desc); if (v) out[cap] = v; }
  return { ...out, ...(desc.provides || {}) };  // an explicit `provides` wins per capability
}
```

Called in [`install()`](../server/providers.js#L52), before `requireRateLimit`:

```js
desc.provides = normalizeProvides(desc);
```

Merge rather than `??=`, so a hybrid descriptor (writes `provides.tag`, still
declares legacy `embeds`) keeps both instead of silently losing the legacy half.

#### 1.2 What each legacy field lifts to

| legacy | `provides` key | notes from the actual descriptors |
|---|---|---|
| `wire.tag` + `models` + `defaultModel` + `modelFilter` | `tag: { models, default, filter }` | [`local.js`](../server/ai-providers/local.js#L30) sets `wire.tag = null` explicitly → no `provides.tag`. Correct: it doesn't tag. |
| `embeds` | `embed` | [`anthropic`](../server/ai-providers/anthropic.js#L20) and [`local-detector`](../server/ai-providers/local-detector.js#L21) set `embeds: null` explicitly; others omit it. Both fall out. |
| `transcribes` | `transcribe` | [`whisper`](../server/ai-providers/whisper.js#L23) is `{ default: null, models: [] }` — **truthy with a null default**; the descriptor comment says so outright. Any "is it empty" test on the object breaks it. Use truthiness only. |
| `detects` | `detect` | [`local-detector`](../server/ai-providers/local-detector.js#L23) carries the sidecar's baked model. |
| `research` | `research: true` (omitted when false) | a modifier, not a slot — no model axis, no binding. |

#### 1.3 The seed registry

`test/plugins.test.js` pins `capabilities` with a **`deepEqual` over all five
keys including the `false` ones**, so a derivation over `Object.keys(provides)`
is wrong — it needs the id list. Slice 1 therefore creates `server/capabilities.js`
with ids and catalog policy only; Slice 2 grows the same file into
`CAPABILITY_DEFS`:

```js
// Slice-1 seed. Slice 2 replaces these with the descriptor table; nothing else
// changes, because every consumer already reads through these names.
export const CAPABILITY_IDS = ["tag", "embed", "transcribe", "detect", "research"];
export const MODEL_CAPABILITIES = ["tag", "embed", "transcribe", "detect"]; // research has no model axis
export const CATALOG_POLICY = { tag: { unfilteredShowsAll: true } };        // was KIND_CATALOG's `always`
```

`unfilteredShowsAll` is [`KIND_CATALOG`](../server/providers.js#L191)'s
`always: true`, correctly relocated: it is a *capability policy* ("tagging with
no filter shows everything, a capability catalog with no filter stays curated"),
not something a provider declares.

#### 1.4 The four derivations

**D1 — `KIND_CATALOG` → `provides` lookup** ([providers.js:191](../server/providers.js#L191)):

```js
const catalogFor = (desc, cap) => {
  const p = desc?.provides?.[cap];
  if (!p || typeof p !== "object") return null;          // absent, or a bare modifier (research)
  return { models: p.models, filter: p.filter, always: !!CATALOG_POLICY[cap]?.unfilteredShowsAll };
};
```

`MODEL_KINDS` → `MODEL_CAPABILITIES`, which renames `"tagging"` → `"tag"`.
[server.js:1801](../server/server.js#L1801) also defaults the unrecognized-kind
case to the literal `"tagging"` — change it to `"tag"` and accept `"tagging"` as
an alias for one release. No client sends it (the three call sites in
[plugin-modal.js](../public/plugin-modal.js#L648) send `embed`/`transcribe`/`detect`;
[board-modal.js:398](../public/board-modal.js#L398) omits `kind` for tagging and
relies on the default), so the alias is belt-and-braces against a cached page.

**D2 — `providerCatalog()` gains `provides`, keeps the triple**
([providers.js:301](../server/providers.js#L301)):

```js
research:    !!p.provides.research,
embeds:      p.provides.embed      ? { default: p.provides.embed.default,      models: p.provides.embed.models } : null,
transcribes: p.provides.transcribe ? { default: p.provides.transcribe.default, models: p.provides.transcribe.models } : null,
detects:     p.provides.detect     ? { default: p.provides.detect.default,     models: p.provides.detect.models } : null,
provides:    p.provides,
```

The triple **must** stay: [plugin-modal.js](../public/plugin-modal.js#L639) reads
`p.ai.embeds.models` / `p.ai.transcribes.default` / `p.ai.detects.models`, and
[detect.test.js:34](../test/detect.test.js#L34),
[audio.test.js:170-174](../test/audio.test.js#L170),
[dynamic-plugins.test.js:79](../test/dynamic-plugins.test.js#L79),
[providers.test.js:95-97](../test/providers.test.js#L95) all assert on it. Client
migration to `provides` is Slice 4's business, not Slice 1's.

`research: !!p.provides.research` is a small hardening over today's
`research: p.research`: a plugin descriptor that omits `research` currently puts
`undefined` in the catalog, which JSON-drops and would fail the strict
`deepEqual` at [providers.test.js:126](../test/providers.test.js#L126). Every
built-in sets it explicitly, so that trap has never fired — `!!` removes it.

**D3 — `aiDefs()`** ([plugins.js:44](../server/plugins.js#L44)):

```js
capabilities: Object.fromEntries(CAPABILITY_IDS.map((c) => [c, !!p.provides?.[c]])),
ai: { …, provides: p.provides },   // alongside the legacy embeds/transcribes/detects
```

This also stops `aiDefs()` reaching back into `PROVIDERS` for `wire?.tag` — the
catalog projection becomes self-sufficient.

**D4 — `validateBuilt`** ([plugin-loader.js:86](../server/plugin-loader.js#L86)):

```js
validateBuilt: (m, built) => {
  // UNCHANGED, verbatim: the emptiness rule accepts a truthy `wire` on its own,
  // and tightening it here would be a behaviour change smuggled into a
  // no-behaviour-change slice. Candidate for Slice 2.
  if (!built.wire && !built.embeds && !built.transcribes && !built.detects) throw new Error(…);
  if (!built.label) throw new Error("ai-provider descriptor needs a label");
  const provides = normalizeProvides(built);
  for (const cap of Object.keys(provides)) {
    const verb = WIRE_VERB[cap];                       // { embed, transcribe, detect } — tag/research have none
    if (verb && typeof built.wire?.[verb] !== "function")
      throw new Error(`a ${cap} ai-provider descriptor needs wire.${verb}`);
  }
  if (provides.tag && !provides.tag.default) throw new Error("a tagging ai-provider descriptor needs a defaultModel");
}
```

**Plugin-only, and it must stay that way.** `whisper` and `localDetector` are
built-ins that advertise a capability with `wire: null` — the sidecar HTTP call
is assembled in [worker.js](../server/worker.js#L958) instead. Hoisting this loop
into `install()` would reject two shipping providers. (The asymmetry is real — a
*plugin* can't currently ship a sidecar-backed capability the way whisper does —
but that is a Slice 6 question, not this one.)

#### 1.5 Landmines, with the evidence

1. **JSON round-trip.** [providers.test.js:126](../test/providers.test.js#L126)
   asserts `deepEqual(routeJson, providerCatalog())` under `node:assert/strict`.
   JSON drops `undefined`-valued keys and `deepStrictEqual` treats `{a: undefined}`
   ≠ `{}`. So `provides` must carry **no `undefined` values and no functions** —
   hence `?? null` in the tag lift and `if (v)` skipping absent capabilities
   rather than writing `undefined`.
2. **`whisper.transcribes` is truthy-but-empty.** `{ default: null, models: [] }`.
   Truthiness is the capability flag; never `Object.keys().length`.
3. **`local.wire.tag === null`**, not absent — `d.wire?.tag ? …` handles it;
   `"tag" in d.wire` would not.
4. **`capabilities` needs the full id set** (§1.3), not the provider's keys.
5. **Registry order is asserted.**
   [providers.test.js:70-71](../test/providers.test.js#L70) does a `deepEqual` on
   `["local","openai","gemini"]`, which is `BUILTIN_PROVIDERS` insertion order.
   `install()` mutating the descriptor doesn't touch map order — but nothing may
   rebuild `PROVIDERS`.
6. **`provides` is not (yet) a published plugin contract.** `manifest.apiVersion`
   major must *equal* `PLUGIN_API_VERSION`, so bumping it would reject every
   existing plugin. Slice 1 therefore treats `provides` as host-internal
   normalization that is *accepted* if a descriptor supplies it, and leaves
   [examples/plugins/ollama/README.md](../examples/plugins/ollama/README.md)
   documenting the legacy shape — which stays accurate and needs no edit.

#### 1.6 New tests (`test/provides.test.js` — no existing file is touched)

- **Equivalence, property-based over `PROVIDERS`:** for every registered
  provider, `provides.embed` ≡ `embeds`, `provides.transcribe` ≡ `transcribes`,
  `provides.detect` ≡ `detects`, `!!provides.research` ≡ `research`, and
  `!!provides.tag` ≡ `!!wire?.tag`.
- **Round-trip safety:** `deepStrictEqual(JSON.parse(JSON.stringify(cat)), cat)`
  for the whole catalog — asserts landmine 1 directly instead of hoping
  `providers.test.js:126` catches it.
- **Shape equivalence:** a legacy-shaped descriptor and a `provides`-shaped one
  registered via `registerProvider` produce identical catalog entries modulo
  name/label.
- **Hybrid:** `provides.tag` + legacy `embeds` yields both.
- **The empty catalog:** `whisper.provides.transcribe` is truthy with
  `default: null` and `models: []`.
- **Loader parity:** a plugin fixture declaring `transcribe` without
  `wire.transcribe` is still rejected, with the same message.

#### 1.7 What implementation changed about the spec above

Two things the spec got wrong, both caught by a failing test rather than review:

1. **The normal form has to be bidirectional.** As specified, `provides` was
   derived *from* the legacy fields only — so a descriptor declaring
   `provides.tag` and nothing else produced a catalog entry with
   `defaultModel: undefined` and `models: undefined`, because
   [`providerCatalog()`](../server/providers.js#L370) reads those straight off
   the descriptor and the wires read `desc.defaultModel` directly. Accepting
   `provides` while silently half-breaking it is worse than not accepting it, so
   `install()` also runs `backfillLegacy(desc)`: fill each legacy field *from*
   `provides` when it is absent. Guarded on the `provides` side being present
   rather than a blind `??=` — `embeds: null` is a meaningful explicit
   declaration that [providers.test.js:72](../test/providers.test.js#L72)
   asserts, and turning it into `undefined` would JSON-drop it. For a
   legacy-shaped descriptor every assignment is a no-op by construction.

2. **`WIRE_VERB` cannot include `embed` — and that exposed a real hole.** The
   generic loop was written as "every advertised capability needs its wire",
   which is stricter than the four hand-written checks it replaced: the loader
   has never required `wire.embed`.
   [test/fixtures/plugins/acme-embed](../test/fixtures/plugins/acme-embed/index.js)
   declares `embeds` with `wire: null` and is *asserted* to load
   ([dynamic-plugins.test.js:75](../test/dynamic-plugins.test.js#L75)) — it then
   throws at the first `embedTexts` call, since that does `desc.wire.embed(…)`
   on null. The fixture's own comment claims it mirrors the built-in `local`
   provider, but `local` carries a real `wire.embed` and the fixture does not.
   Slice 1 preserves the behaviour (`WIRE_VERB` omits `embed`, documented at
   the omission); **closing the hole is Slice 2 work**, alongside tightening the
   emptiness rule — both change what the loader accepts.

3. **Emitting `provides` in a payload means every override of that payload has
   to write both shapes.** `/api/admin/plugins` replaces whisper's and
   localDetector's catalogs with what the sidecar's `/health` reports, because
   the model is baked into the image. Adding `provides` alongside the legacy
   field left that override writing only half of it — `detects` would show the
   live model while `provides.detect` still showed the descriptor's baked
   default. Both are now written from one value via a local `sidecarCatalog`
   helper (which also collapses the two near-identical blocks), and
   `provides.test.js` asserts the two shapes agree. **The general lesson for
   slices 2–4: any place that overrides a capability catalog post-projection is
   a divergence site.** There is exactly one today; grep for writes to
   `entry.ai` before adding another.

#### 1.8 Scope

Roughly 60 lines added, 25 changed, across
[providers.js](../server/providers.js), [plugins.js](../server/plugins.js),
[plugin-loader.js](../server/plugin-loader.js), one literal in
[server.js](../server/server.js), plus the new `capabilities.js` seed. **No**
client changes, **no** settings keys, **no** resolver changes, **no** `extract`,
**no** removal of legacy fields, **no** `PLUGIN_API_VERSION` bump.

Existing suites that must pass untouched:
[providers.test.js](../test/providers.test.js),
[plugins.test.js](../test/plugins.test.js),
[dynamic-plugins.test.js](../test/dynamic-plugins.test.js),
[model-discovery.test.js](../test/model-discovery.test.js),
[keyless-providers.test.js](../test/keyless-providers.test.js),
[audio.test.js](../test/audio.test.js), [detect.test.js](../test/detect.test.js),
[compat.test.js](../test/compat.test.js),
[plugin-install.test.js](../test/plugin-install.test.js).

### Slice 2 — `CAPABILITY_DEFS` + `resolveCapability`
The registry, the resolver, the four `resolveX` reduced to wrappers, generic
`deleteAiKey` cleanup. Also the two loader tightenings Slice 1 deliberately left
alone, since both change what is accepted: require `wire.embed` for an
embed-advertising plugin (§1.7), and make `validateBuilt`'s emptiness rule
`provides`-based so a descriptor with a truthy `wire` but no capability is
rejected. Both need the `acme-embed` fixture given a real `wire.embed` — the
first existing-test edit this plan calls for, and a deliberate one.
**Tests:** [audio.test.js](../test/audio.test.js),
[detect.test.js](../test/detect.test.js),
[embed-sweep.test.js](../test/embed-sweep.test.js),
[extraction.test.js](../test/extraction.test.js),
[queue.test.js](../test/queue.test.js) unchanged. Add a registry-iterating
regression: *for every `select:"one"` capability, deleting its bound key clears
the binding* — the test that would have caught `detect_key_id`.

### Slice 3 — `GET /api/admin/capabilities`
The six-state computation, `supportedBy`, `demand`. One generic
`POST /api/admin/capabilities/:id/probe` replaces the four `*-test` routes
(keep the old paths as aliases one release). One generic
`POST /api/admin/capabilities/:id/bind` absorbs the duplicated
transcribe/detect/embed validation in
[`/api/admin/ai-config`](../server/server.js#L2232) — ~120 lines to ~30.
**New test file** `capabilities.test.js`: assert each of the six states is
reachable and that `degraded` is produced by deleting a bound key.

### Slice 4 — the page
Generic renderer + nav entry. Plugins-page badges become links. `plugin-modal`'s
four sections collapse to one `capabilitySection(capId, …)` driven by the
payload — 449 lines to roughly 130.

### Slice 5 — `binding.scope` honoured
Per-board transcribe/detect (the two dead `board` params), and `extract` gains
the global default it never had. Board modal renders a picker for every
capability whose scope allows one, including future ones.

### Slice 6 — `kind: "capability"` in `KIND_DEFS`
A plugin contributes a `CAPABILITY_DEFS` entry. **Gated on a consumer story**
(below).

## Open questions / what this deliberately does not do

- **A capability with no consumer is dead weight.** `tag` is consumed by the
  worker, `embed` by search, `detect` by object fields. A third-party capability
  needs a declared consumption point — realistically "a board field kind invokes
  it" — or Slice 6 ships a page listing capabilities nothing calls. Build the
  registry now; hold Slice 6 until the consumption seam exists.
- **Non-admin visibility.** A member can't fix anything. Admin-only is the
  cheap answer; a read-only "ask your admin" view is the kind one. Undecided —
  it changes nothing structural, so defer to Slice 4.
- **`extract`'s supply predicate is `provides.tag`,** because extraction rides
  the tagging wire text-only. That is genuinely a distinct capability sharing a
  wire, so `supply.advertises` must stay a free function, not `provides[capId]`.
  Resist the urge to make it `provides[id]` — it looks tidier and is wrong.
- **Don't fix `detect_key_id` standalone.** It's the fifth copy of a cleanup
  that should be a loop. Fixing it alone removes the evidence and leaves the
  cause.
- **Naming collision to resolve.** The Plugins page subtitle currently reads
  *"Capabilities and connections in one place,"* where "capability" means a
  `core: true` card. When this ships, "capability" means the registry entry and
  those cards become what they are — always-on connections.
