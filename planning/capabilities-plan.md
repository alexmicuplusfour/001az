# Capabilities — a definition-driven capability registry (and the page it renders)

**Status: SLICE 1 SHIPPED (commit 013235d). SLICE 2a SHIPPED locally 2026-08-09
(uncommitted): `CAPABILITY_DEFS` is the registry, `capability-resolve.js` is the
one resolver behind all four `resolveX`, and both cleanup paths iterate it —
which fixes THREE dead-pointer bugs (`detect_key_id`, `detect_provider`, and
tagging's shared `model`, §2.10). SLICE 2b SHIPPED too: `capability-bind.js` +
`capability-probe.js` replace the four duplicated blocks in
`/api/admin/ai-config` and the four `*-test` routes, which become adapters over
them; `server.js` is 240 lines lighter. SLICE 3 SHIPPED 2026-08-10:
`capability-status.js` + `GET /api/admin/capabilities` — the five-state
computation (+`viaFloor`), reasons via `storedBindingMiss`, `supportedBy` off
one `pluginCatalog` call, demand where it is indexed-cheap, domains generated
from `listConnectors()`, and the secrets-scan test. Suite green at 941, repeated
runs, still zero edits to existing test files. Slices 4–6 remain plan-only. The
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

**And it is missed twice** — [`cleanupPluginConfig`](../server/plugin-loader.js#L460)
clears `embed_provider` and `transcribe_provider` on uninstall but not
`detect_provider`, so uninstalling an on-device detector plugin leaves the
pointer naming it and a later reinstall silently re-activates a detector the
admin removed, which is the exact failure that function's own comment warns
about. Two independent hand-rolled loops over the capabilities, both stopping at
three. See [§2.1](#21-the-bug-is-in-two-places-not-one).

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

**Split in two.** 2a is the correctness slice (registry, resolver, cleanup — it
fixes the bugs); 2b is the API dedup (generic bind + probe routes). 2a is worth
shipping alone; 2b is a diff twice its size with none of the risk-reduction.

#### 2.1 The bug is in two places, not one

The plan has been citing `deleteAiKey` missing `detect_key_id`. A second site has
the same omission:

| site | clears for tag | embed | transcribe | detect |
|---|---|---|---|---|
| [`deleteAiKey`](../server/db.js#L1140) — a key row is deleted | `default_key_id` | `embed_key_id`, `embed_enabled` | `transcribe_provider/_key_id/_model` | **nothing** |
| [`cleanupPluginConfig`](../server/plugin-loader.js#L460) — a plugin is uninstalled | (via `deleteAiKey`) | `embed_provider`, `embed_enabled` | `transcribe_provider/_key_id/_model` | **nothing** |

Both are hand-written iterations over the capabilities, and both stop at three.
The second one is worse than a stale pointer — its own comment says why:

> *"NAME-based slot pointers too: an on-device plugin is selected by name, not
> key row, so no deleteAiKey cascade reaches these — left behind they would
> silently re-activate the slot on a later reinstall."*

So uninstalling an on-device detector plugin leaves `detect_provider` naming it,
and reinstalling silently re-activates a detector the admin removed. Two
independent hand-rolled loops, one capability missed by both, zero test
coverage of the class. **This is the slice's justification**: not "the registry
is tidier" but "the third and fourth copies of this loop don't exist."

#### 2.2 The central fork: the four resolvers return two different kinds of thing

This is the design decision Slice 2 turns on, and it isn't cosmetic:

| resolver | returns | consumed by |
|---|---|---|
| [`resolveDefaultAi`](../server/worker.js#L95) | `{ provider, apiKey, model, base, keyId }` — **credentials** | spread into `callTagger`; `keyId`/`provider` also read for usage accounting, health, and the board cache |
| [`resolveEmbedder`](../server/worker.js#L122) | `{ provider, apiKey, model, base }` — **credentials** | spread into `embedTexts` |
| [`resolveTranscriber`](../server/worker.js#L1082) | `{ id, model, transcribe() }` — **an engine** | `.transcribe(buf, name)` |
| [`resolveDetector`](../server/worker.js#L1180) | `{ id, model, detect() }` — **an engine** | `.detect(image, queries)` |

The split is not arbitrary: transcribe and detect have a **sidecar floor that is
not reachable through a wire at all** ([`whisperTranscriber`](../server/worker.js#L958),
[`objectDetectorSidecar`](../server/worker.js#L1138) speak their own HTTP job
protocols), so the only shape common to "a provider" and "the floor" is a
callable. Tag and embed have no sidecar floor, so they never needed one.

**Decision: `resolveCapability` returns the BINDING; engines are built by a
per-capability `engine(binding)`.** The binding is the genuine common
denominator — every one of the eight resolution steps produces it, and the
engine is the part that differs. Building engines for tag/embed instead would
touch ~20 call sites and the worker's per-board prompt cache (which stores
`aiKeyId`/`aiModel`) to buy nothing.

```js
resolveCapability(db, "tag")        → { provider, apiKey, model, base, keyId, viaFloor: false } | null
resolveCapability(db, "transcribe") → { provider: "whisper", model: null, apiKey: null, keyId: null, viaFloor: true }
```

**The four exported names stay** — permanently, not as a deprecation shim.
`resolveEmbedder(db)` reads better at a call site than
`resolveCapability(db, "embed")`, six test files import them, and the win was
never the names: it is that all four become one-line wrappers over one
implementation.

```js
export const resolveEmbedder = (db) => resolveCapability(db, "embed");
export const resolveTranscriber = (db, board = null) => engineFor("transcribe", db, board);
```

#### 2.3 One rule for `<ns>_provider`, which today means three different things

| capability | what the provider setting means today |
|---|---|
| `embed` | **on-device pick only** — [`resolveEmbedder`](../server/worker.js#L127) returns null if the named provider isn't `onDevice`, so a networked provider is unreachable through this setting and must come via `embed_key_id` |
| `transcribe`, `detect` | **the engine**, on-device *or* keyed, with the sentinel names `"whisper"` / `"localDetector"` meaning the floor |
| `tag` | **does not exist** — no `tag_provider`; the provider is implied by the `default_key_id` row |

One rule replaces all three:

```
provider = <ns>_provider  ??  keyRow(<ns>_key_id)?.provider  ??  floor.provider
```

Backward compatible for every value currently in the settings table — checked
case by case: `embed_provider="local"` resolves on-device as before;
`embed_provider` null + `embed_key_id` set takes the key path as before;
`transcribe_provider="whisper"` now resolves because whisper **is** the floor
provider's name rather than because of a sentinel comparison. The sentinel
checks (`provider !== "whisper"`, `provider !== "localDetector"`) disappear
entirely: resolution picks the provider, and `engineFor` uses the floor engine
because that provider has no `wire.transcribe`, not because of its name.

The key requirement generalizes the same way: today transcribe/detect demand
`key || desc.onDevice`. That is `needsRow = !desc.onDevice` — a keyless-networked
provider (a self-hosted Ollama: `keyless: true`, `onDevice: false`) still has a
connection row carrying its `base_url`, which is exactly why it must not be
lumped in with on-device.

#### 2.4 The floor taxonomy — five kinds, all present in the tree today

| kind | capability | behaviour |
|---|---|---|
| `builtin` | transcribe, detect | a registered provider with no wire; engine comes from the capability's `floorEngine`. Never fails to resolve. |
| `off` | embed | gated by `embed_enabled`; resolution returns null and the sweep pauses |
| `blocked` | tag | returns null; [`noKeyError`](../server/worker.js#L191) sets `noCount` and the queue requeues without consuming an attempt |
| `sibling` | connector domains | [`activeProvider`](../server/connectors/runtime.js#L119) scans for any installed provider before failing |
| `delegate` | extract | falls back to the board's tagger ([worker.js:2064](../server/worker.js#L2064)), then to `blocked` |

`sibling` is the richest and is currently reachable only by connector domains.
Generalizing it is free once the registry exists, and it is what makes
`degraded` distinguishable from `active`.

#### 2.5 What `resolveCapability` actually does

The eight steps every current resolver performs, once:

1. floor gate (`off` → null if the enable setting is unset)
2. `provider = <ns>_provider ?? keyRow?.provider ?? floor.provider` (§2.3)
3. `supply.advertises(desc)` — the provider still declares this capability
4. `aiPluginInstalled(db, provider)` — **pinned by
   [plugins.test.js:337](../test/plugins.test.js#L337)**, "not installed → drops out"
5. load the key row when `needsRow`; on failure fall to the floor (never throw)
6. model = `<ns>_model` setting, else `desc.provides[cap].default`
7. `aiRate(db, provider)` for pacing
8. return the binding, stamped `viaFloor` and (for slice 3) the reason it fell

Two capability-specific rungs stay in the descriptor rather than the resolver:
tag's **env rung** (`ANTHROPIC_API_KEY` with `keyId: "env"`, itself gated on
`aiPluginInstalled("anthropic")`) and detect's **threshold**, a capability-level
config value closed over by the engine.

#### 2.6 The cleanup loop — the actual fix

```js
// db.js deleteAiKey, plugin-loader.js cleanupPluginConfig
for (const cap of CAPABILITY_DEFS) await clearBinding(db, cap, { keyId })   // or { provider }
```

`binding.keys` enumerates each capability's settings namespace, so clearing is
total by construction and a sixth capability inherits both cleanups for free.
The board-scoped bindings (`boards.ai_key_id`/`ai_model`,
`boards.extract_key_id`/`extract_model`, and the `boards_using` count at
[db.js:1103](../server/db.js#L1103)) enumerate from `binding.boardKeys` the same
way.

#### 2.7 Slice 2b — the routes

`POST /api/admin/capabilities/:id/bind` absorbs the transcribe and detect blocks
of [`/api/admin/ai-config`](../server/server.js#L2232), which are identical
modulo the capability noun (~40 lines each: advertise check, key-provider match,
model-is-advertised check, three `setSetting` calls). Embed keeps one extra
rule — the `enabled` flag and its "validate final state" check.

`POST /api/admin/capabilities/:id/probe` replaces the four `*-test` routes
([test](../server/server.js#L2431), [embed-test](../server/server.js#L2360),
[transcribe-test](../server/server.js#L2390), [detect-test](../server/server.js#L2415)),
which differ only in the sample input the descriptor already names: `tinyWav()`,
`tinyImage()`, `["ping"]`, and a bare `testKey`. Old paths stay as aliases for
one release since the modal calls them by URL.

#### 2.8 Landmines

1. **`objectDetectorSidecar` hardcodes a provider name**:
   `PROVIDERS.localDetector.detects.default` ([worker.js:1141](../server/worker.js#L1141)).
   Must become `PROVIDERS[floor.provider].provides.detect.default`, or the floor
   engine still names what the registry is supposed to own.
2. **Health-wrapping happens at different layers per capability today** —
   transcribe/detect wrap at *engine construction*
   ([worker.js:1101](../server/worker.js#L1101)), tag at the *call site*
   (`trackedTagger`), embed at *its* call site ([worker.js:742](../server/worker.js#L742)).
   Unifying into `engineFor` is right but risks double-wrapping; do it only
   where it provably doesn't change the ledger, and leave the rest for a later
   pass rather than widening 2a.
3. **The four null-vs-never-null contracts differ and are all pinned**:
   transcribe and detect must never fail to resolve
   ([audio.test.js:221](../test/audio.test.js#L221),
   [detect.test.js:159](../test/detect.test.js#L159)); embed returns null when
   off ([plugins.test.js:361](../test/plugins.test.js#L361)); tag returns null
   when unconfigured ([plugins.test.js:337](../test/plugins.test.js#L337)). The
   wrappers must preserve each exactly.
4. **`embed_enabled` is checked before anything else** — it is a floor gate, not
   a post-resolution filter. A generic resolver that checks it late would let a
   disabled embedder resolve.
5. **`whisperTranscriber` has a stateful `get model()`** filled from the job
   payload after a transcription completes, so the engine must stay constructed
   per resolution, not cached in the registry.
6. **The two loader tightenings Slice 1 deferred** land here, since both change
   what is accepted: require `wire.embed` for an embed-advertising plugin
   (§1.7), and make `validateBuilt`'s emptiness rule `provides`-based. Both need
   [acme-embed](../test/fixtures/plugins/acme-embed/index.js) given a real
   `wire.embed` — the first deliberate edit to an existing test this plan calls
   for.

#### 2.10 What implementation changed about the spec above (slice 2a, shipped)

1. **A third dead-pointer bug, of the same family.** Clearing the *whole*
   settings namespace rather than a hand-picked subset turned out to matter
   beyond `detect`: the three capabilities that WERE handled each cleared a
   different subset. Tagging cleared only `default_key_id`, leaving `model`
   behind — and `model` is read by the env rung too. So deleting an OpenAI
   default key while `ANTHROPIC_API_KEY` was set left Claude being asked for
   `gpt-5-mini` on every item. Pinned by its own test.
2. **`clearBinding` could not live with the resolver.** `deleteAiKey` is *in*
   `db.js`, so a helper in `capability-resolve.js` (which imports `db.js`) would
   have made `db.js` import a module that imports it back. The key list lives in
   `capabilities.js` instead — the pure-data module with no imports, which is
   precisely why it has none. `bindingSettings(cap)` returns the namespace and
   each caller uses its own `setSetting`.
3. **The sentinels are genuinely gone.** No `provider !== "whisper"` or
   `!== "localDetector"` remains: `usable()` rejects a provider whose
   `wire[verb]` is not a function, so the two sidecar-backed built-ins fall to
   their own floor by the general rule rather than by name. `objectDetectorSidecar`
   now takes the binding instead of reading `PROVIDERS.localDetector` itself.
4. **Resolution is slightly stricter, deliberately.** `usable()` applies the
   advertise + wire checks to *every* capability, where `resolveDefaultAi` and
   `resolveEmbedder` previously applied neither consistently — a key row whose
   provider cannot tag used to resolve as the tagger and then throw at the wire;
   it now falls to the floor. Unreachable through the UI (the key form only
   offers networked providers), but it is a behaviour change, not a refactor.
5. **A test file's server count is a load decision.** The first version stood up
   six servers (one per test) and made the wall-clock-sensitive
   `ingest-sweep` continuous-cadence test fail ~2 runs in 3 — while passing in
   isolation, and while the same server changes with the test file removed
   passed twice cleanly. The suite runs eight files at a time; six extra
   databases is enough to starve a settle-window assertion. Consolidated to one
   shared server, ordered pristine-state test first and state-leaving test last.
   **House rule for the remaining slices: share a server unless a test needs
   isolation.**

#### 2.11 Slice 2b as shipped

`capability-bind.js` (validate + write) and `capability-probe.js` (the sample
input per capability) are the two new modules. `/api/admin/ai-config` keeps
every one of its body names and becomes a **table adapter**: `LEGACY_BIND_FIELDS`
says which field carried which value, and every rule lives in `bindCapability`.
The four `*-test` routes collapse into a loop over `{path: capability}`. The
capability-native `POST /api/admin/capabilities/:id/{bind,probe}` are the peers
the client moves to in slice 4. `server.js` loses 240 lines net.

Three things the merge forced, none of them cosmetic:

1. **One error message had to satisfy two tests that assert different words.**
   `embedProvider: "anthropic"` is pinned to match `/on-device/`
   ([keyless-providers.test.js:147](../test/keyless-providers.test.js#L147)) and
   `detectProvider: "anthropic"` to match `/advertises none|object detection/`
   ([detect.test.js:175](../test/detect.test.js#L175)) — the same rejection, two
   capabilities, two vocabularies. Rather than keep both strings, one message
   states both true facts: *"anthropic advertises no object detection — try X or
   Y (or an on-device engine, which needs no key)"*. It satisfies both regexes
   because both are accurate, not because it was padded. This is what `noun` on
   the descriptor is for.
2. **A null provider next to a key means "use the key path", not "clear".** The
   embedder's form posts `{ embedProvider: null, embedKeyId, embedModel }`
   together. A first cut read the null as "unbind" and dropped the key with it.
3. **An explicit model must survive a choice that doesn't set one.** Tagging
   posts key and model together, and tagging's model is deliberately unvalidated
   (live model lists make the curated catalog a recommendation, not the set of
   ids that exist) — so the model write cannot be an `else` branch of the
   provider write.

`pinnedModelMustBeAdvertised` is on transcribe and detect only, which is where
the check exists today: those two reject an unadvertised pinned model because it
would throw at the wire on every item and requeue for ever.

#### 2.12 Review pass — what the first cut of slice 2 missed

1. **The writes were deduplicated and the READS were left in two copies.** The
   `slots` block of `/api/admin/plugins` and `GET /api/admin/ai-config` each
   hand-read the same four capabilities' settings — including hardcoded
   `|| "whisper"` and `|| "localDetector"` floor defaults that the descriptor now
   owns. `capabilityBinding(db, capId)` is the read-side peer of
   `bindCapability`; both payloads keep their exact shapes and neither knows a
   settings key any more. (I had written that helper during 2b and deleted it as
   dead code, one slice too early.)
2. **The same shape-guard existed three times** — `catalogOf` in
   capability-resolve, `catalogOf` in capability-bind, `declared` in providers —
   all answering "the `provides` entry for this capability, if it is a catalog".
   Three chances to disagree about what *advertises* means. Now one exported
   `declaredCatalog(desc, capKey)`.
3. **Only one of the two floor engines got de-named.** `objectDetectorSidecar`
   was changed to take the binding; `whisperTranscriber` was left hardcoding
   `id: "whisper"`, with a comment referring to the `transcribe_provider`
   sentinel that no longer exists. Both take the binding now.
4. **The board-scoped tagger stayed loose while the global one got strict.**
   `resolveBoardAi` checked only "is the plugin installed", so a board pinned to
   an embed-only connection resolved as a tagger and threw at the wire, while
   the app default fell through cleanly. It judges by `usableProvider` now —
   board scope changes *where the choice is stored*, never what makes a provider
   usable.
5. **Dead code the extraction left**: `probeable` (never called),
   `aiPluginInstalled` and its `pluginInstalled` import, and — a good signal —
   `getSetting` and `PROVIDERS` became entirely unused in `worker.js`. The
   worker no longer reads settings or the provider registry to resolve anything,
   which is what "resolution moved out" should look like.

#### 2.9 Tests

The two that would have caught the shipped bugs, both iterating the registry so
capability #6 inherits them:

- *for every capability with a `keyId` binding, deleting the bound key clears
  the whole binding* → catches `detect_key_id`
- *for every capability with a `provider` binding, uninstalling the named
  provider clears it* → catches `detect_provider`, including the
  reinstall-re-activates case its comment warns about

Plus: each of the five floor kinds resolves as specified; a bound-but-unresolvable
capability reports `viaFloor` with a reason (the `degraded` input slice 3 needs);
and the four wrapper contracts from landmine 3.

Existing suites that must stay green: [audio.test.js](../test/audio.test.js),
[detect.test.js](../test/detect.test.js),
[embed-sweep.test.js](../test/embed-sweep.test.js),
[extraction.test.js](../test/extraction.test.js),
[queue.test.js](../test/queue.test.js),
[plugins.test.js](../test/plugins.test.js),
[keyless-providers.test.js](../test/keyless-providers.test.js),
[plugin-install.test.js](../test/plugin-install.test.js).

### Slice 3 — `GET /api/admin/capabilities`

**Scope correction:** the original slice-3 text also carried the bind and probe
routes — those shipped in 2b. What remains is the *status projection*: the
state computation, `supportedBy`, `demand`, and the reason string. Deep-dived
2026-08-10; the spec below supersedes the sketch.

#### 3.1 What already exists, verified

| need | source |
|---|---|
| effective binding + `viaFloor` | [`resolveCapability`](../server/capability-resolve.js) — shipped 2a |
| stored binding, floor-filled | [`capabilityBinding`](../server/capability-resolve.js) — shipped in the 2b review pass |
| per-provider installed / keyCount / hasKey / connectionCount / health | [`pluginCatalog(db)`](../server/plugins.js) — **one call powers every `supportedBy`** |
| per-capability advertise flags | `entry.capabilities[declaredBy]` on the same catalog rows (works for `extract`, whose `declaredBy` is `tag`) |
| domain stored-vs-effective | the [`slots.domains`](../server/server.js) block: `setting` + `activeProvider` (throws when no provider installed) |
| tag demand | **missing** — [`boardTagActivity`](../server/db.js#L550) counts `TAG_QUEUE` per board only; a global `tagQueueDepth(db)` is one new query beside it, reusing the same `TAG_QUEUE` constant (which derives from `IN_FLIGHT_FOR`, all six pipeline states — not just `pending`) |
| embed demand | [`embeddingStats(db, model)`](../server/db.js#L2559) — tagged/embedded/failed; remaining = tagged − embedded − failed |
| board overrides count | pattern at [db.js:1104](../server/db.js#L1104) (`boards_using`); generalize to `countBoardOverrides(db, column)` with the column injected from `binding.boardKeys.keyId` (module constants, same rule as the cleanup loop) |
| sidecar live models | `transcriberSidecarModel()` / `detectorSidecarModel()` (worker exports, 60s-cached) |
| source readiness incl. the folder/`INGEST_ROOT` check | [`listSources(db)`](../server/ingestion/files.js#L273) already computes `ready` — compose it, never read `process.env` in the projection |

**Transcribe demand is deliberately null.** The only counting query
([`oneAudioNeedingTranscription`](../server/db.js#L2530)) filters on
`payload->'files'->0->>'kind'` — an unindexed JSON predicate, a full items scan.
Fine in the worker's paced loop; not on an admin page load. And transcription's
floor is `builtin`, so it is never blocked — the count would be "in progress",
not a consequence. Detect and extract demand: null likewise (field-triggered /
conflated with the tag queue).

#### 3.2 The reason string — design correction

The plan said the resolver would return the binding "stamped `viaFloor` and (for
slice 3) the reason it fell". That cannot work as written: **the null contracts
are pinned.** `resolveDefaultAi` must return exactly `null` when unconfigured
([plugins.test.js:337](../test/plugins.test.js#L337) asserts strict equality),
so a degraded-tag reason has nowhere to ride — the resolver returns null, not an
annotatable object.

Instead, `capability-resolve.js` refactors internally and exports one new
function:

- `usable()`'s three checks become `disqualified(db, cap, provider) → string |
  null` (the reason, or null = usable); `usable` stays as `disqualified ? null :
  desc`. Distinct strings for the two removal shapes: a name whose descriptor is
  **gone** (uninstalled plugin lingering in a setting) vs. installed-but-removed
  on the Plugins page.
- `storedBinding` returns `{ binding }` or `{ miss: reason }` internally —
  adding the key-row reasons (`no key stored for X`, and `the stored key no
  longer exists` for a keyId whose row is gone, reachable via backup restore).
  `resolveCapability` reads `.binding`; behavior identical.
- **`storedBindingMiss(db, capId) → string | null`** is the export the
  projection reads. One implementation of the predicates, two consumers — no
  drift, no widened resolver contract, zero existing-test edits.

#### 3.3 The state algorithm

Emitted as **five states + a `viaFloor` flag** (`active` + `viaFloor` ≡ the
plan's "active (floor)" — fewer strings for the page to branch on):

```
miss  = storedBindingMiss(db, id)          // why the stored choice isn't serving
eff   = resolveCapability(db, id)
storedNonFloor = binding names something ≠ the floor (for tag: a keyId is stored)

if (keys.enabled && !enabled)                     → off          // explicit choice wins
else if (miss && storedNonFloor)                  → degraded     // YOUR choice isn't serving, whatever is
else if (eff)                                     → active (+viaFloor)
else if (supplyEmpty && floor.kind !== "builtin") → unavailable  // nothing installed advertises it
else                                              → blocked      // + demand
```

Cases that make the order load-bearing, all test-pinned:

- **Stored `"whisper"`** (bindCapability normalizes a clear to the floor name):
  `miss` is "no wire of its own" but `storedNonFloor` is false → active(floor),
  not degraded. Naming the floor is a choice, not a fault.
- **Broken stored key + env rung serving**: eff is the env binding
  (`viaFloor: false`!) — an effective-first rule would call it healthy. `miss
  && storedNonFloor` catches it first → degraded, with `running` showing what
  actually serves (`keyId: "env"`).
- **Embed enabled + bound + plugin later removed**: floor is `off` but the admin
  explicitly enabled → degraded (backfill accumulates), not off, not blocked.
- **unavailable is reachable**: tag on a fresh instance minus anthropic (the
  other tag providers are available-not-installed by default); domains on a
  fresh instance (no connector provider is `defaultInstalled`, so
  `activeProvider` throws).

#### 3.4 Domains, and the two `select:"all"` entries

Domain entries are **generated from `listConnectors()`**, cashing the roster
promise. Their state reuses the same five strings with one addition to blocked's
meaning: `activeProvider` resolves regardless of keys, so *effective provider
`needsKey` without a stored key* → **blocked** with reason "X needs an API key"
— which is exactly what blocked means for tag (a configured target that cannot
serve until a key arrives). Degraded = `setting && setting !== effective` (the
divergence the payload already computes today). Unavailable = the
no-provider-installed throw.

`ingest` (one entry, media handlers collapsed) and `source` are permanently
`active`, `select: "all"`; source rows carry `connectionCount` (pluginCatalog)
and `ready` (listSources — the folder row honestly reports a missing
`INGEST_ROOT`).

#### 3.5 The payload

```jsonc
{ "capabilities": [
  { "id": "transcribe", "kind": "ai", "label": "…", "noun": "…", "blurb": "…",
    "state": "degraded", "viaFloor": true,
    "bound":   { "provider": "openai", "keyId": 3, "model": "whisper-1" },
    "running": { "provider": "whisper", "model": "large-v3", "keyId": null },
    "reason": "OpenAI is removed on the Plugins page",
    "supportedBy": [ { "name": "openai", "label": "OpenAI", "installed": true,
                        "keyCount": 0, "onDevice": false, "health": null } ],
    "demand": null, "scope": "global",
    "config": [ { "key": "detect_threshold", "value": 0.3 } ] },   // detect only
  { "id": "tag", "…": "…",
    "modifiers": [ { "id": "research", "supportedBy": ["anthropic"],
                     "availableNow": true } ] },                    // research nests, never a row
  { "id": "extract", "delegatesTo": "tag", "scope": "board", "boardOverrides": 2 },
  { "id": "crypto", "kind": "domain", "…": "…" },
  { "id": "ingest", "kind": "always-on", "state": "active", "handlers": [ "…" ] }
] }
```

- `running` is built **field-by-field** (`provider`, `model`, `keyId`,
  `viaFloor`) — never a spread of the resolver result, which carries `apiKey`.
  A test seeds a key `sk-SECRET-…` and asserts the serialized payload never
  contains it. This is the one place slice 3 can create a leak; treat it as the
  primary review point.
- Floor `running.model` overlays the sidecar's live `/health` model (whisper
  declares `default: null` — the descriptor's own comment says the sidecar
  names its model), so the card states the truth rather than "—".
- `bound.provider` for tag fills from the key row (`capabilityBinding` gains
  that lookup) — stored info, just stored in the row.

New module `server/capability-status.js` (projection only, no writes), one
route `GET /api/admin/capabilities` (requireAdmin), two db helpers
(`tagQueueDepth`, `countBoardOverrides`). The `DEMAND` and sidecar-overlay maps
live in the status module keyed by capability id — they cannot live in
`capabilities.js`, which is pure data imported by `db.js`; each carries a
comment saying a queue-owning capability adds its entry there.

**Not touched:** the `slots.domains` block and both legacy GET payloads keep
their shapes (zero-existing-test-edits rule); folding them over the domain-state
helper is slice-4 cleanup.

#### 3.6a Review pass — what the first cut of slice 3 missed

1. **`domainEntry` was the third copy of stored-vs-effective.** The
   `slots.domains` block in server.js and the new projection each hand-read
   `${domain}_provider` and try/catch'd around `activeProvider`. Folded into
   [`standing(db, conn)`](../server/connectors/runtime.js) beside
   `activeProvider` itself — the two admin surfaces now read one function and
   cannot disagree. (The spec had marked this "slice-4 cleanup"; it was six
   lines and drift-prone, so it moved up.)
2. **The ordering decision wasn't pinned.** §3.3's justification for checking
   the miss before the effective binding — a broken stored key while the env
   rung silently serves — had no test. It does now: tag reports `degraded` with
   `running.keyId: "env"` and the dead choice still visible in `bound`.
3. **Deliberately left alone:** `aiEntry` walks the settings three times
   (capabilityBinding + storedBindingMiss + resolveCapability, the latter two
   sharing `storedBinding` internally). A merged
   "resolve-with-status" export would save a handful of indexed reads on an
   admin-page load and cost a third resolver entry point; not worth it.

#### 3.6 Tests (extend `capabilities.test.js`, same shared server)

Anon 403; every state reachable — fresh-instance defaults (transcribe/detect
active+viaFloor, embed off, tag blocked with `demand.waiting` counting a seeded
`TAG_QUEUE` item), degraded with the exact reason string, unavailable for tag
(remove anthropic, env cleared) and for a fresh domain, domain blocked on
needs-key (`stocks_key_financialmodelingprep` unset) and degraded on
starred-then-removed; the secrets scan; ingest/source present and active.
State-mutating tests restore what they change (shared server, §2.10 rule 5).

### Slice 4 — the page

**4a SHIPPED locally 2026-08-10 (uncommitted):** the payload fields (§4.2), the
pure presenter (`public/capability-present.js`, det-geometry pattern, 7 tests),
the page (`public/admin-capabilities.js`), the Capabilities tab (admin.html +
admin.js with the shell's first `hashchange` listener and suffix-preserving
deep links), and the Plugins-page slot badges as `#capabilities/<id>` links.
Suite green at 948 ×2; browser import graph + tab wiring verified statically
(the test harness serves no frontend — its `STATIC_DIR` is a temp dir, so
static 404s in a harness smoke are an artifact). 4b remains plan-only.

Deep-dived 2026-08-10. **Split 4a/4b like slice 2**: 4a is the page (new
surface, additive payload fields, zero existing-client edits beyond nav +
links); 4b is the modal collapse (rewrites 449 lines of existing UI and moves
its writes to the capability-native routes). 4a ships alone.

#### 4.1 What the frontend dive established

- **The admin shell makes a tab cheap.** [admin.js](../public/admin.js) is 36
  lines: `TAB_NAMES`, one button + one panel in
  [admin.html](../public/admin.html), one render module. Hash deep-linking
  exists (`#plugins`) but there is **no `hashchange` listener anywhere** — tab
  switching is click-only after load. Badges-as-links need one; `#capabilities/tag`
  needs `initialTab.split("/")` (two lines).
- **The four modal sections, measured for real** ([plugin-modal.js](../public/plugin-modal.js)
  547–953): a shared skeleton — no-keys guard → connection picker →
  model picker (`syncModelPicker`, `kind: capId`) → `slotButton` → Test /
  revert / `currentDefaultNote` — with per-capability variation that is
  entirely expressible as data:

  | | tag | embed | transcribe | detect |
  |---|---|---|---|---|
  | extra picker row | env option (`"env"` sentinel value) | — | — | — |
  | enable semantics | — | apply implies `enabled:true`; Turn off | — | — |
  | revert-to-floor button | none (floor is `blocked` — nothing to revert to) | — | "Use Whisper instead" | "Use on-device detector instead" |
  | on-device holder | — | name-pick (local) | name-pick | name-pick + Test ("Loading model…") |
  | extras | Test when default | stats line; **confirm on model change** (re-embed cost) | Test | Test |

- **`detect_threshold` has no client UI at all.** Grep `public/` for
  `threshold`/`detectThreshold`: zero hits outside unrelated modules. The
  server stores, serves, and validates a knob nothing can set. The payload's
  `config[]` was designed for exactly this — slice 4a closes the hole
  generically (an autosave number input rendered from `config[]`), and it is
  the first proof the config seam works.
- **No browser harness** (established in the repo's own commit history), but
  the house pattern exists: client modules are tested with hand-rolled DOM
  stubs ([toast.test.js](../test/toast.test.js)), and pure presenter functions
  are the testable surface.
- **The page can reuse the plugin modal as its "Fix" action.**
  `openPluginModal(p, ctx)` and `loadPluginState()` are exported — the page
  opens the bound (or floor) provider's existing modal instead of growing its
  own bind UI in 4a.

#### 4.2 Payload additions (4a, additive only)

Four small fields the page needs that the feed doesn't carry; all come from
data that already exists server-side:

1. `floor: { kind, provider, label } | null` — the revert button's target and
   the "active (floor)" line need the floor's *name* even while a keyed
   provider is serving; today it is only implicit in `running` when the floor
   answers.
2. `probeable: true` — re-export the probe roster from
   [capability-probe.js](../server/capability-probe.js) (deleted as dead in the
   2a review, needed after all — the page must not hardcode which four ids
   have Test buttons).
3. `env: { configured: boolean }` on capabilities with an env rung — the
   modal's env-option row currently reads `slots.tagger.envKey`.
4. `rebindWarning` (embed: the re-embeds-everything confirm copy) — moves the
   one confirm dialog's trigger condition into descriptor data on
   [capabilities.js](../server/capabilities.js).

#### 4.3 The page (4a) — `public/admin-capabilities.js`

One fetch of `/api/admin/capabilities`, one card per entry, **no capability
knowledge**: every card renders state chip + blurb + Configured/Running lines +
reason + demand + `supportedBy` chips (installed/keys state, health dot) +
`config[]` inputs (autosave → `bind` with `config`) + modifiers line + Probe
button (`probeable`) + "Configure →" (opens the bound-or-floor provider's
plugin modal; supportedBy chips of not-installed providers link `#plugins`).
Domain / always-on entries render from the same template minus what they lack.

Pure presenter exported for stub-DOM tests: `presentCapability(entry) →
{ chip, headline, lines, actions }` — state → chip class/copy, degraded →
reason line, blocked → demand line — mirroring how
[slotProviders/tagFor](../public/admin-plugins.js) are unit-tested today.

Nav: tab + panel + `TAB_NAMES` entry + `hashchange` listener +
`initialTab.split("/")` for `#capabilities/<id>` (scroll + highlight). The
Plugins page's slot badges (`default tagger` …) become links to
`#capabilities/<id>`.

**Non-goals, decided:** admin-only (the page lives in admin.html; a member
read-only view stays deferred). No gallery/first-run integration in this slice
— the gallery already has the jobs surface; a "tagging is blocked" banner
linking here is a candidate follow-up, not part of 4a.

#### 4.4 The modal collapse (4b) — SHIPPED locally 2026-08-10 (uncommitted)

As specced below, plus the small server additions it called for (`agent`,
`declaredBy`, `binding` flags, `env.provider`/`env.var`, `progress` via a
`PROGRESS` map beside `DEMAND`). plugin-modal.js went 1169 → 835 lines
(the four sections + `connectionPicker` + `currentDefaultNote` deleted, one
`capabilitySection` shell added); `planSection` in capability-present.js
carries every decision, node-tested row by row including the exact bind
bodies, with their server halves pinned in capabilities.test.js ("the modal's
bind bodies"). loadPluginState fetches capabilities; the modal reload merge
threads it. Suite green at 953 ×2. The legacy ai-config adapter + probe
aliases now have zero client callers — deletion is a later cleanup slice,
together with `slotProviders()`.

**The whole client surface of the legacy routes is these four sections.** All
15 `POST /api/admin/ai-config` + `*-test` call sites in `public/` live in
[plugin-modal.js](../public/plugin-modal.js) 547–953; the GET has no client
caller at all. After 4b, `LEGACY_BIND_FIELDS` and the four probe aliases serve
only stale cached pages — kept one release (their server tests pin them),
deleted in a later cleanup slice together with `slotProviders()` (the badges'
hand-list, out of 4b's scope).

**Correction to the earlier sketch: `capabilitySection` cannot be stub-DOM
tested.** plugin-modal.js imports `/api.js`-path modules, so node cannot load
it — the toast.test pattern only works for import-free modules. The testable
seam is therefore a **pure planner** in
[capability-present.js](../public/capability-present.js):

```
planSection(cap, provider, keys) → {
  title, subtitle,                    // cap.label / cap.blurb
  guard,                              // "add a key above…" when keyless-empty and no env row
  rows, preselect, ask,               // connection options INCL. the env row; the
                                      //   one-key-hidden rule as the `ask` flag
  modelCatalog | modelNote,           // { models, defaultModel } for syncModelPicker
                                      //   (kind = cap.id), or the single-model note
  holder,                             // this provider is the acting one (running.provider)
  buttons: [{ kind, label, payload(sel) }],  // apply / probe / revert / off — payload
                                      //   is a closure over select values, so tests
                                      //   assert the EXACT bind bodies
  confirm,                            // rebindWarning predicate inputs
  currentDefault,                     // from cap.running via cap.supportedBy labels
  progressLine,
}
```

plugin-modal keeps a thin DOM shell (~40 lines) that maps the plan onto the
existing pieces — `section()`, `fillSelect`, `syncModelPicker`, `slotButton`
(all untouched); `connectionPicker` loses its last callers and dies (the env
row means the picker is rows-driven now, which is what the tagger hand-built
around it for).

**The bind bodies, pinned by planner tests AND server tests** (the risky
mappings, one per current call site):

| action today | bind body |
|---|---|
| tagger apply, env row selected (`defaultKeyId: null, model`) | `{ keyId: null, model }` — the env rung serves by falling through |
| tagger apply, key row | `{ keyId, model }` |
| embed apply, key path (`embedProvider: null, …, embedEnabled: true`) | `{ provider: null, keyId, model, enabled: true }` — one call; enable validates the FINAL state |
| embed apply, on-device | `{ provider: "local", enabled: true }` (name from the roster, not a literal) |
| embed Turn off | `{ enabled: false }` — binding kept, gate closed |
| transcribe/detect apply | `{ provider, keyId, model }` |
| revert ("Use Whisper instead") | `{ provider: cap.floor.provider }` — clears keyId/model per chooseBinding's floor branch |
| all four Test buttons | `POST /api/admin/capabilities/:id/probe` |

Server-side additions (small, all data): `agent` on the defs ("tagger",
"embedder", …) so "Make default tagger" and its toasts stay verbatim;
`declaredBy` emitted so the shell reads `p.ai.provides[cap.declaredBy]` instead
of assuming id === declaredBy; `progress` on the embed entry (a `PROGRESS` map
beside `DEMAND`, embeddingStats when enabled) replacing the stats line's
`slots.embedder.stats` read — and rendered by the page too, for free.
`loadPluginState()` gains the capabilities fetch; the modal's
`active`/`isDefault` checks become `capsById[id].running?.provider === p.name`
(the env→anthropic mapping already lives in `running`).

**Accepted copy drift** (listed so it's a decision): the tagger section title
becomes "Tagging" (`cap.label` — the other three titles already match); revert
buttons read `Use the built-in ${noun} instead` (generic beats "Use Local
Transcriber (Whisper) instead"); detect's on-device Test busy label unifies to
"Testing…"; the embed stats line becomes the generic progress copy.

Tests: planner table row by row (env payload, enable-on-apply, revert target,
off, confirm predicate, guard, one-key `ask` rule) in
capability-present.test.js; the four bind bodies added to the server-side bind
test; the existing modal behaviors that survive only by hand-testing (select
placeholder → disabled button interplay) stay in the DOM shell it already
lives in, unchanged.

Estimated diff: plugin-modal −449/+~170, capability-present +~120,
capability-status/capabilities.js +~30, tests +~120.

#### 4.4a Review pass — what the first cut of slice 4 missed

1. **The probe toast existed twice** (page Test + modal Test, same template
   string in two files) and **`busy` existed twice** (a local copy in
   admin-capabilities). Both shared now: `fmtProbe` joins the presenter's
   fmt exports; `busy` is exported from plugin-modal.
2. **The Capabilities tab went stale after Plugins-tab edits.** The modal's
   `refresh` from the Plugins tab repainted only the plugin cards, so a rebind
   made the *diagnostics* page lie until a full reload — on the one page whose
   job is truth. `refresh` now repaints both surfaces. Deliberate ESM module
   cycle (admin-plugins ↔ admin-capabilities), safe because each side only
   calls the other inside functions.
3. **`presentSupported` under-warned keyless-networked providers**: an
   installed Ollama with zero connections rendered a plain label, though it
   cannot serve without a connection row (that's where the server URL lives).
   Zero rows now warns for keyed and keyless alike, with the right noun.
4. Small: the `labelOf` alias dropped; README's admin-panel bullet now names
   the Capabilities tab.
5. **Deliberately left**: the modal's caps fetch failing fails the whole modal
   (same Promise.all strictness as its other three fetches); `renderCapabilities`
   double-fetches when refresh chains from the modal (one extra admin-page GET).

#### 4.5 Tests

- 4a: presenter pure-fn tests (every state → chip/lines, secrets never in
  presenter output by construction); config autosave posts `bind` with
  `config` (route already tested server-side); `docs.test.js`-style check that
  the new tab is wired (TAB_NAMES ↔ html panels) if cheap.
- 4b: stub-DOM tests for `capabilitySection` covering the variation table row
  by row — env option, enable, revert label from `floor.label`, on-device
  name-pick, confirm-on-model-change gated by `rebindWarning`.

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
