# A model axis for on-device engines — one mechanism, three engines

**Status: Slices 1–2 BUILT & VERIFIED (2026-08-30, uncommitted) — the picker
works end to end: an image built `BAKE_MODELS=small,medium` offers both in the
board modal, a board pinned to `medium` transcribes on medium, and the job log
says so. Suite 1247 green. Slice 1 was the generic app
layer: one live-catalog source feeds both admin surfaces, both bind rungs
accept a model for a named on-device engine, and the planner offers the axis
when an engine reports more than one model. Suite 1246 green (+18); live-checked
that both feeds now carry the identical sidecar catalog and that the picker
stays hidden while whisper reports one model (the no-op-on-merge property).
Slices 2–4 not started — no engine reports a second model yet, so nothing in
the UI changes until one does. Motivated by a measured finding (the
whisper size benchmark in the appendix): the app's on-device engines each serve
exactly ONE model, chosen at image build, and there is no way to pick another
from the UI. Successor thread to
[structured-transcripts-plan.md](structured-transcripts-plan.md) (slices 1–3
shipped; slice 4 benchmarked and rejected). Self-contained for a fresh
session.**

## The problem

Every keyed provider has a model picker — the board modal's AI-models strip and
the admin capabilities section both offer one. The three **on-device** engines
do not:

| engine | capability | model today | where it lives |
|---|---|---|---|
| `whisper` | transcribe | `small` | transcriber sidecar, baked at build |
| `localDetector` | detect | `llmdet_tiny` | object-detector sidecar, baked at build |
| `local` (Xenova) | embed | `bge-small-en-v1.5` | **in-process**, a `const` in the module |

All three are in the identical position for the identical reason, and the
motivation is now measured rather than theoretical: whisper `small` → `medium`
fixes every transcription error observed on real material (appendix), and
nothing in the app can express that choice per board.

### The five deliberate blockers

Nothing here is a bug — the app is consistently built around "an on-device
engine has one baked model". Changing that means retiring five decisions:

1. **The sidecar** loads one model at startup (`local_files_only`), and its
   `/transcribe` takes bytes only.
2. **The job id is `sha256(bytes)`** ([transcriber/main.py](../transcriber/main.py)) —
   two jobs for the same audio at different sizes would collide in the dedupe
   cache and the second would be served the first's transcript.
3. **The descriptor declares no catalog** —
   [whisper.js](../server/ai-providers/whisper.js) carries
   `transcribes: { default: null, models: [] }` with the rule *"the model list
   isn't the app's to declare — the sidecar reports it."*
4. **Both bind paths force `model: null`** for an on-device pin
   ([chooseBinding:59](../server/capability-bind.js#L59),
   [boardBindingPatch:158](../server/capability-bind.js#L158)).
5. **The planner refuses the axis** —
   [`modelAxis`](../public/capability-present.js#L227) returns `null` unless the
   selection is a key row, and the admin section renders a note ("model baked at
   deploy") instead of a select
   ([capability-present.js:374-383](../public/capability-present.js#L374-L383)).

## What is already true (why this is smaller than it looks)

Verified by reading, not assumed:

- **The resolution layer already carries a model for a name pin.**
  [`boardBinding`](../server/capability-resolve.js#L137) reads
  `board[bk.model] || declaredCatalog(...).default`, and `modelFor` does the
  same globally. The read path has always supported this; only the WRITE paths
  and the UI say no.
- **The catalog-from-`/health` mechanism exists — but it decorates the WRONG
  FEED for this feature** (close look, 2026-08-30). `sidecarCatalog`
  ([server.js](../server/server.js#L2135)) is a closure inside
  `GET /api/admin/plugins`, so it lights up the Plugins card only. The board
  modal's picker reads `GET /api/admin/ai-providers`
  ([board-modal.js](../public/board-modal.js#L337) `loadProviders()`), which
  returns `providerCatalog()` — the **static** descriptor catalog. Growing
  `sidecarCatalog` in place would leave the board dropdown empty. The live
  catalog must become ONE source consumed by both routes.
- **The board-modal shell needs ZERO changes.** `syncModel()` renders a select
  whenever `plan.modelAxis(sel)` is non-null, and
  [`syncModelPicker`](../public/board-modal.js#L425) fills from the static
  `entry` and only fetches live listings when `keyId` is non-null. Hand it an
  axis with `keyId: null` and it does exactly the right thing already.
- **The expensive case is already guarded.** `embed` declares
  `rebindWarning` ("Changing the embedding model re-embeds every item"), the
  picker renders a confirm for any capability that declares one, and
  `itemsNeedingEmbedding` re-queues items whose `embedding_model` differs — so
  exposing the embedder's axis inherits the safety rail rather than needing a
  special case.

## Locked decisions

1. **An engine opts in by REPORTING more than one model.** No provider names,
   no capability names, anywhere in the generic layer
   ([[provider-agnosticism-constraint]]). A future plugin sidecar that
   advertises three models gets a picker for free.
2. **The engine owns its model list.** For sidecar engines the list comes from
   `/health` via `sidecarCatalog`; the app never declares it statically, so the
   offer can never drift from what is actually baked. This extends the existing
   "the sidecar owns its model name" rule from one model to many.
3. **The picker appears only when the catalog holds more than one entry.** A
   one-model engine keeps today's note — a select with a single option is
   noise, and this is what keeps the change invisible for deploys that bake one
   model ([[no-implied-choices-in-ui]]).
4. **Validation defers to the engine — expressed as "an EMPTY declared catalog
   forbids nothing".** `pinnedModelMustBeAdvertised` validates against the
   descriptor's catalog, which for whisper is deliberately `[]`, so it would
   reject every model including ones `/health` just offered. Keying the skip on
   the catalog being empty (rather than on a provider being sidecar-backed)
   needs **no new descriptor field** — it avoids importing the `sidecar` flag
   from the shelved slice 4. `localDetector` and `local` keep validating
   against their one-entry catalogs. A pin naming an unbaked model fails AT the
   engine with a readable error and parks the item.
5. **Which models exist stays a BUILD decision.** `ARG BAKE_MODELS=small`
   keeps every existing image byte-identical; a deploy opts into more. The UI
   chooses among what a deploy baked — it never implies a download.
6. **One model resident at a time** (lazy load, LRU of one). RAM is
   `max(models)`, never the sum. Measured swap cost: 1.8s for small, 12.1s for
   medium — negligible against a multi-minute transcription.

## Slice 1 — the generic app layer ✅ (2026-08-30)

As-built: exactly the revised shape below. Two extra findings surfaced while
building — (a) `planSection`'s on-device APPLY payload omitted `model`
entirely, so even a rendered picker would not have saved (fixed: it sends the
model only when it offered a catalog); (b) `capability-status.js`'s
`FLOOR_LIVE_MODEL` and `capability-probe.js` both read the probes' bare-string
answer, so the probes KEEP that contract — `sidecar-catalog.js` accepts either
a string or `{ default, models }`, which means slice 2 changes the sidecar and
one table row, not three consumers.



No engine changes; after this slice every on-device engine that reports >1
model gets a working picker, and none of them report >1 yet, so behaviour is
unchanged.

Revised after the close look (2026-08-30) — the two blocking findings are #1
and #2 below; the plan's original "two edits + sidecarCatalog 1→N" would have
shipped a picker that was empty on the only surface that matters.

- **NEW `server/sidecar-catalog.js`** — ONE source of "a sidecar-backed
  provider's live catalog", replacing the closure buried in
  `/api/admin/plugins`. Holds the (provider, capability, probe, note) table
  and returns a `Map<provider, { cap, catalog }>`; both
  `GET /api/admin/ai-providers` (the board picker's feed) and
  `GET /api/admin/plugins` (the card) apply it. Tolerates a probe returning
  either today's bare model string or slice 2's `{ default, models }`, so
  slice 2 changes only the probe. **Must copy, never mutate**: `providerCatalog()`
  hands out the descriptor's own `provides` object by reference.
- **[capability-bind.js](../server/capability-bind.js)**:
  - `chooseBinding`: **the floor branch is the bug**, not the on-device branch.
    `provider === floorProvider` short-circuits at
    [line 48](../server/capability-bind.js#L48) and forces `model: null`, and
    for transcribe/detect the floor IS the on-device engine — so line 59 is
    unreachable for whisper and the app-wide default could never store a model.
    Split it: a CLEAR returns to the floor with no model; NAMING a provider
    (floor or not) falls through to the on-device rule, which keeps its model.
  - `boardBindingPatch`: the name-pin branch writes and validates the model
    instead of nulling it. (Clearing already works — `provVal === null`
    deliberately does not `continue`, so it falls through to the keyId branch
    which clears `bk.model` too.)
  - One shared `chooseModel(cap, provider, model)` enforcing decision 4, used
    by both rungs — replacing the inline check duplicated in the keyed branch.
- **[capability-present.js](../public/capability-present.js)** — the pure
  planner, three edits:
  - `modelAxis(sel)`: resolve the provider from a key row OR a name row; return
    an axis with `keyId: null` for a name pin, and only when the catalog holds
    **more than one** model. Its `saved` currently keys on `savedKey` alone, so
    a name-pinned model would never preselect — generalize to the stored
    selection whichever kind it is.
  - `payload(sel, model)`: write `out[bb.model]` for a name pin, as it already
    does for a key pin.
  - The capability-section planner (`onDevice → note`): render the picker when
    the on-device catalog has >1 model, the note otherwise.
- **Tests**: planner cases (name pin with 1 model → no axis; with N → axis with
  `keyId: null`; `saved` preselects a name pin's model; payload writes it),
  bind-path cases (naming the floor now keeps a model; an unknown model is
  rejected where a catalog exists and accepted where it is empty), and the
  shared catalog source reaching both feeds.
- **No shell changes** (`syncModelPicker` already fills from a static entry and
  skips live listings when `keyId` is null), no worker changes, no resolution
  changes — engines keep ignoring `binding.model` until slice 2.
- **Graceful degradation, verified by design**: an unreachable sidecar yields
  an empty live catalog → no picker → a board's stored model still resolves
  from its column. The choice hides; it is never destroyed.
- **A model that stops being baked** (an image rebuilt without it) drops out of
  the catalog, so the picker hides and the next board save clears the column
  back to the engine's default — a self-heal. Until someone saves, the stale
  pin reaches the engine and parks the item with a readable error, which is
  decision 4 working as intended rather than a silent wrong transcript.
- **No added latency**, checked rather than assumed: `/api/admin/capabilities`
  already calls the same probes (`capability-status.js` FLOOR_LIVE_MODEL), the
  board modal fetches its three feeds in parallel, and the probes share one
  60s cache in worker.js — so the overlay rides a probe already in flight.

## Slice 2 — whisper serves N models (the first consumer) ✅ (2026-08-30)

As-built, with one bug the close look MISSED and the first test caught: slice
1's dive claimed "the resolution layer already carries a model for a name pin".
It does — but only for a non-floor on-device provider. A board pinning the
FLOOR (whisper — i.e. the only sidecar transcriber there is) hits
`boardBinding`'s floor short-circuit, which returns `floorBinding()` and
discards the board's model column; the app-wide default lost it the same way,
because `storedBinding` disqualifies a wireless provider and falls through to
`floorBinding` too. Both fixed in capability-resolve.js — and the global fix
had to be narrow: the stored model rides the floor binding ONLY when the
stored provider IS the floor, or falling back from a dead OpenAI key would
hand `whisper-1` to the whisper sidecar, which never baked it. (Same shape as
the `chooseBinding` bug slice 1 found on the write side: the floor being an
on-device engine is a case that keeps getting swallowed by "the floor is the
fallback" branches.)

Live-verified: image built `BAKE_MODELS=small,medium`; `/health` reports both;
the board picker's feed offers both; a board pinned to `medium` logged
`unloading whisper 'small'` → `loading whisper 'medium' ready in 4.1s` and
stamped `whisper:medium` in the job log; an unbaked model returns
`422 model 'large-v3' is not baked into this transcriber (have: small, medium)`.

Revised by the close look (2026-08-30). The blocking find is #1: without it the
feature is worse than not having it.

1. **The express drain must skip jobs needing a model swap.** `_drain_express()`
   runs after EVERY ASR segment, so a long job on `medium` interrupted by an
   express job wanting `small` would evict, load (12s), run, and reload (12s) —
   per interruption. Rule: express serves only jobs the currently-loaded model
   can serve; a mismatched one waits for the running job, exactly like any
   queued job today. **A running job never pays a reload mid-flight.**
2. **Lazy loading must not cost the fail-loudly-at-boot property.** Today the
   model loads at import, which is what the healthcheck's `start_period: 120s`
   is for. Validate every baked name at startup (`download_model(name,
   local_files_only=True)` resolves the cache dir without loading weights),
   assert `WHISPER_MODEL ∈ BAKE_MODELS`, and eagerly load the DEFAULT only.
3. **Evict THEN load.** Building the new model before dropping the old peaks at
   the SUM (~2.3GB for small+medium) and defeats the whole point. Explicit
   `del` + `gc.collect()` before constructing.
4. **One cached `/health`, two readers.** `transcriberSidecarModel()` keeps its
   bare-string contract (capability-status + the detect probe read it); a new
   `transcriberSidecarCatalog()` returns `{ default, models }` over the SAME
   cached payload — no second round-trip, no two caches that can disagree.
5. **Skew is safe both ways, with one caveat to state**: a new app against an
   old sidecar has its `?model=` ignored and gets the baked model, which the
   sidecar self-reports — so the job log stamps the truth. A board's pin can be
   silently unhonored during a partial deploy, visible only in the job log.
6. Mechanics: an unbaked model returns **422** (4xx parks with a readable
   error; 5xx would retry forever); `/health` reports the VALIDATED list; the
   done payload names the JOB's model, which makes per-item job-log stamps
   accurate for free; the admin probe may report "transcriber busy" when it
   wants an unloaded model behind a long job (honest, matches existing busy
   behaviour).
7. Deferred and named, not built: `WHISPER_RESIDENT=n` to keep several models
   loaded on a roomy box, removing swaps entirely.


- **[transcriber/Dockerfile](../transcriber/Dockerfile)**: `ARG BAKE_MODELS=small`
  (comma list) replacing the single `WHISPER_MODEL` bake; loop the
  pre-download. `WHISPER_MODEL` remains the DEFAULT model for requests that
  name none.
- **[transcriber/main.py](../transcriber/main.py)**:
  - A model registry: `{name: WhisperModel|None}` for the baked set, loaded
    lazily; an LRU of one evicts the previous model on a switch (log the swap).
  - `/health` reports `models: [...]` alongside `model` (the default) — old
    callers keep working.
  - `POST /transcribe?model=X` (default `WHISPER_MODEL`); an unbaked name →
    422 with a readable error (permanent → the clip parks, honestly).
  - **The job id becomes `sha256(bytes + model)`** — the dedupe invariant must
    key on what was actually asked for, or a re-pin would serve the old
    transcript from cache.
  - The done payload's `model` already reports what served; it now varies.
- **[worker.js](../server/worker.js)** `sidecarTranscriber`: send
  `binding.model` when set. (Everything else — turns, speakers, the stall
  detector, the job-log stamp — is untouched.)
- **Live verify**: two boards on different sizes, one clip each; confirm the
  job log stamps `whisper:small` vs `whisper:medium`, the swap logs once, and a
  pin naming an unbaked model parks with a readable error.

## Slice 3 (optional) — the object detector

Same pattern, simpler protocol (synchronous `/detect`, no job cache to key):
bake N, lazy-load, list on `/health`, accept a model in the request body,
`objectDetectorSidecar` passes `binding.model`. Worth it if llmdet
tiny/small/base prove meaningfully different; unmeasured today.

## Slice 4 (optional) — the Xenova embedder

The easiest engine and the riskiest capability. `local.js` holds
`LOCAL_EMBED_MODEL` as a const and `localEmbed` ignores the model it is
handed — so its declared catalog is currently unreachable in two ways. Fix:
cache one pipeline per model and read the call's model. The corpus-invalidation
danger is already handled by `rebindWarning` + the `embedding_model` column;
what this slice must NOT do is offer a model per BOARD (vectors compare only
within a model — the embed capability deliberately has `boardKeys: null`, and
that must stay).

## Risks / open questions

- **Image size.** Baking small+medium ≈ 2GB. `BAKE_MODELS` defaulting to
  `small` keeps existing deploys unchanged, but the "just add medium" path
  costs a big rebuild.
- **Swap thrash.** Alternating boards on short clips pay 12s per switch. The
  transcription lane is serial, so the worst case is bounded; if it bites,
  order the queue by model rather than adding a second resident model.
- **A rebuild that drops a baked model** strands pins naming it. By design they
  fail loudly at the sidecar and park; the picker stops offering it on the next
  `/health` read.
- **RAM ceiling** is unchanged as a deployment concern: `max(models)` still
  means a medium-capable deploy needs ~1.6GB for the transcriber alone.
- **Whether a per-board model axis is wanted at all** for detect/embed is
  unmeasured — slices 3–4 are deliberately optional.

## Appendix — the measured motivation (2026-08-29)

Same three clips, `int8`, `cpu_threads=2`, one process per model:

| model | speed | peak RSS | quality |
|---|---|---|---|
| small (shipped default) | 5.69× real-time | 694 MB | visible errors |
| **medium** | 1.93× real-time | 1583 MB | fixes all observed errors |
| large-v3-turbo | 1.63× real-time | 1651 MB | slower, more RAM, *worse* than medium |

Errors `medium` fixes that `small` makes: "orchata" → "horchata"; "why you go
see me" → "why you ghosted me"; "we thought through" → "we dug through";
"R.A. disgrace" → "You are a disgrace"; "filthy pebbins" → "filthy peasant".
All three models are word-perfect on clean TTS audio (0.0% WER), so the
difference only appears on real material. `large-v3-turbo` is the notable
loser — it regressed to "filthy pebbins" while costing more than medium.

**Interim, independent of this plan:** setting `WHISPER_MODEL=medium` in `.env`
and rebuilding the transcriber gets the entire quality jump today, with no
code. This plan is what makes it a per-board CHOICE rather than a deploy-wide
one.
