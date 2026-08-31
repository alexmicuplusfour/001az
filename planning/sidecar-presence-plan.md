# Sidecar presence — optional heavy sidecars, honestly absent (2026-08-31)

**Status: COMPLETE — all four stages shipped 2026-08-31 / 2026-09-01 (local,
uncommitted). Full suite green (1322).**
Self-contained for a fresh session. Written after a deep dive spanning the
capability registry, resolution, both worker lanes, the status feed, the
client presenter, and the compose/deploy path — plus two live experiments
(compose profile behavior, droplet exclusion).

## Why now

The repo is going public. A stranger's `git clone && docker compose up -d`
builds four images totalling ~7.3GB — app 2.64GB, extractor 431MB, transcriber
1.21GB, object-detector 3.0GB — downloading four model sets, 20–30 minutes
before the first screen. The two heavy sidecars serve the two capabilities a
first-run user is least likely to touch (transcription, object detection).

The production droplet already runs without them: `deploy.local.json` grew an
`exclude` list (2026-08-31) and the transcriber + object-detector were removed
from the host. That exclusion exposed the real problem, which is not the
gigabytes:

**the app has no way to represent a built-in engine's absence.** It was built
when the sidecars were unconditionally present, and that assumption is baked
into the registry, the resolver, the status feed, the client, and both worker
lanes. Barebones must be a supported configuration, not a silent lie.

## The three defects

### 1. The `builtin` floor cannot represent its own absence

- [capabilities.js:36](../server/capabilities.js#L36) defines the floor kind:
  *"builtin — a registered provider with no wire… Resolution NEVER fails."*
  Both heavy sidecars use it (`transcribe` → whisper, `detect` →
  localDetector).
- [capability-status.js:109](../server/capability-status.js#L109) excludes
  builtin floors from the `unavailable` state by name.
- `floorBinding()` ([capability-resolve.js:197](../server/capability-resolve.js#L197))
  is the ONE rung that never calls `disqualified()` — every other rung checks
  installed/advertises/wire; the floor is assumed.
- [capability-probe.js:58](../server/capability-probe.js#L58) says it outright:
  *"Transcription and detection probe the ENGINE, which always resolves — so
  neither has a 'not configured' case."*
- The assumption is masked by [plugins.js:43](../server/plugins.js#L43):
  whisper/localDetector are `core: true` — "always installed, not removable" —
  so no existing check ever says no.

Result: the Capabilities tab — whose stated contract is "is it working, and if
not, why" — reports **active · built-in** for capabilities that physically
cannot run on this host.

### 2. A missing transcriber is an infinite 60-second retry loop

A connection refusal carries no `scope`, so `transcribeFailurePolicy`
([worker.js:1063](../server/worker.js#L1063)) answers `backoff-lane` — which
deliberately consumes no attempt and never writes `transcript_error`. But
[`oneAudioNeedingTranscription`](../server/db.js#L2749) only skips rows having
a transcript OR a `transcript_error`. Neither ever appears, so the same clip is
picked, refused, and slept on — forever. `foldJobRepeat`
([worker.js:1098](../server/worker.js#L1098)) exists precisely to fold this
loop's identical job-log rows; the codebase absorbs the symptom instead of
representing the cause.

### 3. A missing detector re-bills extraction, then destroys the work

In the extract leg the extraction model call is metered at
[worker.js:~2307](../server/worker.js#L2307); the detect pass runs after it
([worker.js:2354](../server/worker.js#L2354)). An unreachable detector throws
there → the whole leg throws → `failOrRequeue` → the next attempt re-runs
`extractOne` from the top and **pays for extraction again** — up to
`MAX_ATTEMPTS`, after which the item fails permanently, discarding extraction
that succeeded every time. Six lines up, the leg already degrades gracefully
for a missing image (`{ v: [], why: "no image to detect on" }`); detection has
no such path.

Also broken, operationally: with the droplet's sidecars excluded, a bare
`docker compose up -d` on the host fails — `depends_on` drags in services
whose images don't exist (`pull_policy: never`). deploy.ps1 currently works
around this with `--no-deps` and a service list.

## The decision

**Make `builtin` presence-gated, and reuse `blocked` semantics when the engine
is absent.** No new concept: the tag capability already models exactly this —
`floor: { kind: "blocked" }`, resolution returns null, the worker refreshes
`hasDefault` each maintenance pass ([worker.js:2625](../server/worker.js#L2625)),
and `claimFairBatch` ([db.js:1993](../server/db.js#L1993)) doesn't claim work
it can't serve: *"their items stay queued until a key appears (never failed for
a missing key)."* Absence of a sidecar is the same kind of fact as absence of a
key.

Two answers, deliberately not conflated (the architecture already separates
them — state is display, floor kind drives the caller):

- **Display: `unavailable`.** Nothing on this host serves the capability; the
  card's existing `supportedBy` roster says who could.
- **Queue behavior: `blocked`.** Work waits unserved, consuming no attempts,
  writing no failure rows, and starts the moment an engine appears. Never
  destroy or permanently mis-stamp work over what may be a deploy blip.

**Presence is `sidecarHealth()`** ([sidecar-catalog.js:35](../server/sidecar-catalog.js#L35))
— one probe per sidecar, cached 60s *failures included*, probed concurrently.
The cache is load-bearing: a 500-item queue must cost one timeout per minute,
not 500. "Is this floor sidecar-backed?" needs **no new registry field** — it
is exactly `PROVIDERS[provider].liveCatalog`, the marker
[sidecar-catalog.js:23](../server/sidecar-catalog.js#L23) already filters on.
The in-app embedder (local/Xenova — onDevice but no `liveCatalog`) is
untouched by construction.

### Consequences accepted

- A sidecar mid-restart reads absent for ≤ ~60s (health TTL) + a poll. Under
  blocked semantics that is a short wait, never a wrong answer. (The
  object-detector's own healthcheck grants 180s start_period — a cold start is
  exactly the window this must not misread as "gone forever".)
- A board with **object fields** on a detector-less host: its extract-leg items
  **wait** (noCount requeue, resolved BEFORE the extraction model call — no
  spend), they are not stamped "no objects". Declared fields are demand, same
  as tag-without-a-key; stamping empties would silently destroy the mapping's
  meaning. Boards without object fields never touch the detector
  ([worker.js:2340](../server/worker.js#L2340) gates on `objectFields.length`)
  and extract normally.
- Audio uploaded while no transcriber runs: rows sit unclaimed (payload-based
  query), transcribed automatically when an engine appears. No resweep needed.
- A keyed provider bound for transcribe/detect keeps working with no sidecar —
  the floor is only the last rung.

## Stages

### Stage 1 — presence, in one module (SHIPPED 2026-08-31, local)

Shipped as a standalone, behavior-neutral commit: presence is computed but
nothing reads it yet (Stage 2 does), and the test seam + suite pre-wiring land
while every existing assertion still holds. That is what keeps Stages 2–3 from
being a hundred-assertion diff. Full suite green after.

**1a. Module changes** ([sidecar-catalog.js](../server/sidecar-catalog.js)):

- `sidecarPresent(provider)` → `true | false | null` (null = not
  sidecar-backed, so callers ask unconditionally — the `sidecarDefaultModel`
  convention). Present = `/health` answered 200 + parseable JSON inside the 2s
  budget. A 500, a hang, or a refusal all read absent — under blocked
  semantics that is a short wait, never a wrong answer, so no finer
  distinction is needed.
- **In-flight coalescing** in `sidecarHealth`: cache `{ at, body }` where
  `body` is the probe's *promise*, stamped at probe start. Today concurrent
  cache misses each fetch ([sidecar-catalog.js:38-45](../server/sidecar-catalog.js#L38));
  that was fine at admin-page cadence, but presence puts this on the
  resolution hot path (per claimed item) — on cache expiry with a
  down-but-routing host, N concurrent extract legs would otherwise each burn
  the 2s timeout. Callers are async either way; nothing else changes,
  failures stay cached.
- `clearSidecarHealth()` export — the 60s TTL otherwise leaks presence across
  tests in one file, and tests flip presence mid-file (a mutable box's
  `status = 500`).
- No new marker: `liveCatalog` stays the "is this sidecar-backed" test
  (:23); the in-app embedder (local/Xenova — no `liveCatalog`) answers null
  by construction.

**1b. The module-identity fact the whole seam rests on** (verified):
`startServer()` imports `server.js?bust=<name>` — but query strings don't
propagate to that module's own bare imports, so `./sidecar-catalog.js`,
`./worker.js`, `./providers.js` resolve once and are **shared across every
bust and every static test import in the process**. One health cache per
process; a static `clearSidecarHealth()` import in helpers reaches the exact
cache the app under test uses. (Same mechanism behind helpers' existing
module-scope env-URL comment, [helpers.js:34-39](../test/helpers.js#L34).)

**1c. The helpers seam** ([test/helpers.js](../test/helpers.js)):

- **`sidecarsUp()`**: one `jsonBox` per engine — the helper's own doc already
  names "a sidecar" as its use case — env URLs reassigned (safe post-import:
  both descriptors read them lazily, per helpers' comment),
  `clearSidecarHealth()`, returns the boxes plus a `close()` that restores the
  dead default and clears again.
- Caveat, by design: a box answers *every* path with its payload — fine,
  because suites that drive the engines (`/transcribe`, `/detect`) stub
  `globalThis.fetch` outright, which intercepts box URLs too; the box only
  ever really serves `/health`.
- Both sidecar URLs keep the SAME dead default (`127.0.0.1:1`). An earlier cut
  split them (`:1`/`:2`) so a URL-dispatching stub could tell the engines
  apart; the direct cache seed removed the only dispatcher, and no test stub
  anywhere discriminates by host — they all match on `/transcribe`, `/detect`,
  `/jobs/`.

**1d. Suite audit** (checked file by file; no suite reassigns the URLs — all
20 fetch-stubbing files leave them dead). **Implemented 2026-08-31 with a
lighter pattern than first planned**: the resolve-then-stub sites are NOT
reordered — instead `primeSidecars()` warms the shared health cache before
the test body, so a presence-gated resolve reads the cache and never fetches,
leaving every stub, call ledger, and assertion byte-identical. Two fixtures,
each fit for its consumer:

- `primeSidecars()` — for unit tests that resolve a floor engine and drive
  its protocol through their own fetch stubs. Clears the cache (so no earlier
  test's answer leaks in) and seeds both engines' bodies through
  `seedSidecarHealth`, the twin of `clearSidecarHealth`. Synchronous, no
  network, nothing to restore. Inverse (absence) = dead ports +
  `clearSidecarHealth()`.
- `sidecarsUp()` — jsonBoxes + env reassignment, for server-driven suites
  where routes re-probe over the file's whole life and a seeded cache could
  expire mid-file under CI load. The boxes are mutable (jsonBox's contract),
  so flipping one's `status` + clearing the cache is how a test makes an
  engine go down mid-file — no option, and no third fixture, for absence.

Both read ONE `SIDECAR_HEALTH` table, so "primed" and "up" cannot drift into
describing different machines. The first cut of `primeSidecars` warmed the
cache by monkeypatching `globalThis.fetch` process-wide and letting the real
prober re-enter the stub; the simplification pass replaced it with the direct
seed — same outcome, and it removes a hazard, since one call site runs while a
server and its worker ticks are live and would have seen the fake network.

Per file:

- [audio.test.js](../test/audio.test.js) — no shared server, each test
  self-hosts → `primeSidecars()` at the top of the **9 floor tests** (the
  protocol test, transcribeOne metering, pinned-model, 5 stub-db whisper
  client tests, the falls-back-to-local test). The keyed-provider and compat
  tests touch no floor. Bind tests (:400-455) are **safe unchanged**:
  `chooseModel` judges the DECLARED catalog only
  ([capability-bind.js:29](../server/capability-bind.js#L29) — "the engine is
  the validator"), so health answers can't change bind outcomes.
- [detect.test.js](../test/detect.test.js) — has a file-level `before()` (a
  root-suite hook, so it precedes even the unit tests declared above it) →
  `sidecarsUp()` there covers all 3 `resolveDetector` sites, the
  `startWorker` extract-leg flow, and the probe test in one move; the header
  comment ("resolution returns the engine descriptor without calling
  detect()") renegotiated to name the boxes. Its probe test already answered
  `/health` in its own stub — the pattern confirmed in the wild.
- [capabilities.test.js](../test/capabilities.test.js) +
  [board-capabilities.test.js](../test/board-capabilities.test.js) — the feed
  suites. They pin precisely what Stage 3 flips (`transcribe.state ===
  "active"`, `viaFloor: true`, `running.provider === "whisper"`, the floor
  identity payload) and currently pass only because presence is unread.
  `sidecarsUp()` in `before()` keeps every one of those assertions true
  through Stage 3 with zero edits. Checked: neither pins `running.model` for
  a floor (only embed's), so the box's model overlaying null breaks nothing;
  the floor-pin binds (:282-306) are static-validated (above).
- [plugins.test.js](../test/plugins.test.js) — reads static defs
  (`getPluginDef`), not the live overlay; the plugins route's
  `sidecarCatalogs()` already tolerates absence (skips the overlay). No
  change.
- **Worker-running suites** (queue, job-log, model-input, ingest-*, facet-*):
  none resolve the transcribe/detect floors — the extract leg touches the
  detector only when a mapping has object fields
  ([worker.js:2340](../server/worker.js#L2340)), which only detect.test.js
  seeds, and only audio.test.js claims audio. Stage 2's maintenance-tick gate
  will probe health once per file against dead ports — refused instantly, the
  exact latency story helpers already tells (:29-33).
- [capability-present.test.js](../test/capability-present.test.js) — pure
  presenter fixtures, no fetch; untouched until Stage 3 adds the `present`
  fields.

**1e. Cold-start facts** (read from the sidecars' own boot sequences): the
object-detector loads its model *before* binding the server
([main.py](../object-detector/main.py) — load at :40, `serve_forever` at
:150), so a cold start reads absent for ~25s (its compose healthcheck grants
180s start_period). The transcriber binds `/health` immediately — boot only
verifies model *metadata* (`download_model(local_files_only=True)`,
[transcriber/main.py:89-96](../transcriber/main.py#L89)); weights load lazily
in the worker thread. Both are inside the 60s-TTL + blocked-wait envelope;
recorded here so nobody "fixes" the detector's dark window into a special
case.

Sizing honestly: the module is ~30 lines; helpers ~30; audio ~12 mechanical
reorders + stub branches; detect ~6 edits + a comment; the two feed suites a
`before()`/`after()` each.

### Stage 2 — resolution and the worker (SHIPPED 2026-09-01, local)

Implemented exactly as below; test/sidecar-presence.test.js carries the seven
stage-2 tests (2e), full suite green. One discovery during implementation:
server.js does NOT launch the worker when imported by tests — suites that
need one start their own (the detect.test.js pattern), which the new file
does file-level so its job-row counts see a single retry ledger.

Every mechanism below was read at the line level before this was written; the
refs are to the code as it stood after Stage 1.

**2a. Resolution** ([capability-resolve.js](../server/capability-resolve.js)):

- `floorBinding()` (:197): after the `builtin` check, gate on presence —
  `if ((await sidecarPresent(floor.provider)) === false) return null`. Strict
  `=== false` on purpose: `null` means "not sidecar-backed", and a builtin
  floor with no `liveCatalog` has no probe to fail, so it stays always-on.
  Null is the shape `off`/`blocked` already return, so `resolveCapability`'s
  contract line ("or null when the capability's floor is off/blocked and
  nothing is configured") extends to "…or its built-in engine is not running".
- The board floor-pin branch (:127-134) calls `floorBinding` and then reads
  `b.model` — with null that is a TypeError, not a graceful miss. Guard:
  `if (!b) return { miss: "the built-in engine is not running on this server" }`
  → falls to the global rung like every other missed pin, loudly, via the
  existing console line at :238.
- `resolveTranscriber` ([worker.js:1076](../server/worker.js#L1076)) and
  `resolveDetector` (:1282) deref `b.viaFloor` — both need `if (!b) return
  null` first (detect's before its `capabilityConfig` read, which would
  otherwise run for nothing).

**2b. Transcribe lane** ([worker.js:2763](../server/worker.js#L2763)) — the
deep dive found the planned global-only gate was wrong (it strands a board
carrying its own keyed pin on a host whose floor is absent), and the
simplification pass then found the JS gate that replaced it was at the wrong
ALTITUDE. Final shape:

- **Board serviceability lives in the claim query**, the shape the tag queue
  has always had (`claimFairBatch`'s `b.ai_key_id IS NOT NULL OR $2`,
  [db.js:2020](../server/db.js#L2020)). `oneAudioNeedingTranscription` takes a
  `served` descriptor — `{ globally, pinCols, floorProvider }` — and filters
  `AND ($2 OR <board pin columns>)`. A JS-side gate could only decide
  yes-or-no for the WHOLE lane, so one board's leftover pin would open it for
  every board, and each unservable clip would be claimed, resolved, logged and
  backed off once a minute forever — the plan's own defect #2, recreated one
  level down and absorbed by `foldJobRepeat`.
- **A pin OF the absent built-in is not a pin that can serve**, so the floor's
  provider is excluded by name — the name arrives from the registry
  (`CAPABILITY.transcribe.floor.provider`), never spelled in db.js.
  `IS DISTINCT FROM` so a null floorProvider still admits every named pin.
- **Coarse on purpose**, exactly like the tag queue's: a pin that exists but
  cannot resolve (its provider uninstalled) passes the filter and is handled
  per item.
- **That residue is a `configGapError` throw**, not a bespoke branch. The
  vocabulary already existed: `noCount` (the flag `failOrRequeue` reads to
  requeue without spending an attempt) plus `transcribeFailurePolicy`, the
  declared home of "what does this failure mean". The policy gains ONE rule —
  `if (err?.noCount) return "backoff-item"` FIRST, so a configuration gap can
  never reach `park-capped` — and the catch's attempt arithmetic becomes
  `attempts + (err.noCount ? 0 : 1)`, the same expression
  [db.js:2815](../server/db.js#L2815) already uses for the same flag. The
  15-line hand-rolled fold/stamp branch (a verbatim copy of the catch's) is
  gone, and "unparkable by construction" is now a property of the policy,
  asserted in one line of its unit test rather than only through a two-board
  worker integration test.
- A new pin/bind is picked up within one POLL_MS (3s); binds don't nudge
  `transcribeWake` and don't need to.

**2c. Extract leg** ([worker.js:2244](../server/worker.js#L2244)) — hoist the
detector resolve above the LLM branch (`needsLLM`, :2258), replacing the
inner resolve at :2354:

```
let detector = null;
if (objectFields.length && row.payload.files?.[0]?.kind === "image") {
  detector = await resolveDetector(db, board);
  if (!detector) throw noDetectorError();   // noCount, like noKeyError (:134)
}
```

- The `kind === "image"` guard mirrors the detect block's own inner condition
  (:2342): a non-image item with object fields never calls the detector today
  and lands `"no image to detect on"` — a slim host must not block items that
  never needed the engine.
- One `detectable` (+ `detectFile`) derivation feeds both the guard and the
  detect pass below. Two copies of that predicate could drift, and the drift
  is ugly: a pass that widened its notion of an image while the guard stayed
  narrow would leave `detector` null and throw a TypeError mid-leg, failing
  the item on attempts — the exact outcome this stage exists to prevent.
- The throw lands before `trackedTagger`/`meterAiCall` (:2292-2307), so
  **nothing is billed** — the re-billing defect dies here.
- No new requeue machinery: `failOrRequeue` with `noCount`
  ([db.js:2813-2819](../server/db.js#L2813)) already leaves attempts
  untouched, never fails the item, and stamps `retry_at = now +
  RETRY_BACKOFF_MS[0]` (60s) — so requeued rows are SPACED, not hot-looped,
  by machinery that already exists. `claimFairBatch`'s retry_at filter
  (:2021) honors it, and the extract catch already skips job-log rows for
  noCount errors (:2492). Verified line by line; the whole leg change is the
  hoist plus one error constructor.
- Items queued while the detector is absent start extracting within ~60s of
  it appearing (their next retry_at lapse) — no resweep needed.

**2d. Probes** ([capability-probe.js](../server/capability-probe.js)):
`transcribe` and `detect` now have the "not configured" case their :58-60
comment says they lack — a null engine throws
`bad("transcription isn't served on this instance — the built-in sidecar isn't running and no provider is bound")`
(detect analogous), which the route already maps to a readable 400. Update
that comment.

**2e. New tests** (the seams are Stage 1's `primeSidecars` /
`clearSidecarHealth` / `sidecarsUp`):

- resolve: absent floor → null for transcribe and detect; a board floor-pin
  with the engine absent → miss → the global rung serves when a keyed default
  exists; present (seeded) → unchanged bindings.
- transcribe lane: absent + no pins → ticks claim nothing, zero job-log rows;
  absent floor + one board with a keyed pin → that board's clip transcribes
  while another board's clip stays unclaimed, unparked, attempts untouched.
- extract leg: object-field image + absent detector → stays `pending_extract`,
  attempts unchanged, `retry_at` set, **usage_meter empty** (the money
  assertion), no extract job-log row; non-image object-field item + absent
  detector → completes with `"no image to detect on"`.
- probes: the 400 with the readable message.

**2f. Ripple check on existing suites** (verified against each file's
mechanics): worker-running suites' transcribe ticks now resolve the gate per
POLL_MS — against dead ports that is an instantly-refused, 60s-cached probe
(the exact latency story helpers already tells); suites whose catch-all fetch
stubs throw during a tick read absent, which idles a lane none of them
assert on. audio.test.js is primed per test; detect.test.js rides its boxes.
No existing assertion depends on transcription happening in a file that
doesn't arrange an engine.

Sizing: ~60 lines of production change across three files; the tests are the
larger half.

### Stage 3 — the status feed and the client (SHIPPED 2026-09-01, local)

Implemented exactly as below; full suite green. The one existing assertion
that moved: capabilities.test.js's fresh-instance shape pin on
`caps.transcribe.floor` now includes `present: true` — the deepEqual caught
the intentional new field, which is that pin doing its job.

Every touchpoint verified at the line level against the post-stage-2 code.
Four files change (`sidecar-catalog.js`, `capability-resolve.js`,
`capability-status.js`, `capability-present.js`) plus two test files; the
three shells (admin-capabilities.js, plugin-modal.js, board-modal.js) pass
`cap` objects through wholesale and need no edits — the presenter contract
("a capability added to the registry renders without a client edit") holds
for fields added to one.

**3a. One concurrent presence warm** ([sidecar-catalog.js](../server/sidecar-catalog.js)):
`sidecarPresenceMap()` — probe every `liveCatalog`-bearing provider
concurrently (the `sidecars()` enumeration + `Promise.all` shape
`sidecarCatalogs` already has), return `Map(provider → bool)`. This is the
fix for the finding the Stage 1 pass recorded: `capabilityStatus` walks
capabilities serially, each sidecar floor awaits its own probe, and on a cold
cache with both engines down the admin page blocks ~2s + ~2s — **live on the
droplet today**. Called once at the top of `capabilityStatus`; every later
read (`sidecarDefaultModel` :126, the roster, the floor payload) is then a
cache hit. Drain the non-2xx body while in the module
(`await res.body?.cancel()` — the undici socket nit).

**3b. The feed** ([capability-status.js](../server/capability-status.js)):

- `aiRoster` (:69) gains `present`, only on entries whose provider carries a
  `liveCatalog` (the presence map's keys) — the in-app embedder (`local`, no
  liveCatalog) never grows the field, so nothing downstream needs a third
  state for it. Signature: `aiRoster(catalog, declaredBy, presence)`.
- **State machine** (:100-113): the `:109` escape clause
  (`cap.floor?.kind !== "builtin"` ⇒ never unavailable) DIES, subsumed by the
  roster: the floor's provider is itself a roster entry (core-installed
  advertiser), so availability becomes
  `supported.some((p) => p.installed && p.present !== false)`. Consequences,
  walked: whisper absent + openai installed keyless → `blocked` ("needs a
  key" — the right noun, there is installable supply); whisper absent +
  nothing else installed → `unavailable`. Presence never creates a new
  `degraded`: a stored pin OF the floor keeps `storedNonFloor === false`
  (naming the floor is a non-choice, :94-95), so an absent engine walks to
  `unavailable` exactly like an unbound one — verified against
  `storedBindingMiss`'s walk.
- `reason` on that unavailable: the shared absence sentence (3d), so the
  card's existing Why line (presentLines renders `reason` unconditionally)
  says *why* it's unavailable without a client edit.
- `floor` payload (:173-180) gains `present` for sidecar-backed builtins —
  what the revert button and removal story read.
- `running` untouched: an absent floor never resolves, so `running` is
  honestly null already. DEMAND untouched (transcribe's absence reasoning
  holds; see open questions).

**3c. The presenter** ([capability-present.js](../public/capability-present.js)) —
four touchpoints, all pure:

- `presentSupported` (:80): on-device + `present === false` →
  `"${label} — not running on this server"`, **dim** like "not added" rather
  than amber: it is a statement about supply, and the remedy is a deploy, not
  a click. `present` undefined (networked, or the embedder) keeps today's
  branches bit-for-bit.
- `planBoardPicker` (:213): the on-device row filter gains
  `p.present !== false` — no-implied-choices: don't offer an engine that
  cannot serve. A board's STORED pin of a now-absent engine already degrades
  correctly: preselect falls to the default row and the pin column is never
  written (the choice hides, it is not destroyed).
- `removalStory` (:167): the builtin branch requires `present !== false`;
  absent falls through to the tail line ("stops until another key is bound"),
  which is the truth on a slim host.
- `planSection` revert (:439): "Use the built-in instead" additionally
  requires `cap.floor.present !== false` — the button must not offer a revert
  to nothing.
- Unchanged on purpose: `configureTarget` keeps the floor as its last-resort
  target (its card is exactly where "not running" shows); the WRITE paths
  still accept binding/pinning an absent engine (defaults, not laws — the
  feed reports, it does not forbid); probe buttons stay rendered (clicking
  yields stage 2's readable 400, which IS the honest answer).

**3d. The shared sentence and the duplicate read**
([capability-resolve.js](../server/capability-resolve.js)) — both deferred
here by the stage-2 simplification pass:

- The absence sentence is authored once (exported beside the resolver —
  `sidecarAbsentMiss` or similar) and read by `boardBinding`'s miss (:137)
  and the feed's `reason`, per the module's own rule that one implementation
  keeps a reason and a fallback from disagreeing (`disqualified` can't host
  it — the floor rung deliberately skips `disqualified`).
- `storedBinding` returns `named` beside its three shapes; `resolveCapability`
  threads it into `floorBinding`, which stops re-reading
  `getSetting(keys.provider)` (:223 duplicates :73). Pre-existing, but the
  transcribe lane now walks this every tick — ~28.8k duplicate SELECTs/day at
  the default poll. `storedBindingMiss` and `boardBinding`'s own
  `floorBinding` call are unaffected (an omitted argument keeps the read).

**3e. Tests:**

- [capability-present.test.js](../test/capability-present.test.js) (pure
  fixtures): the `present: false` chip; the picker row filtered when absent
  and kept when present; `removalStory` falling through to the tail;
  the revert button gated. Existing fixtures carry no `present` field and
  must keep passing unchanged — that is the `!== false` contract under test.
- [sidecar-presence.test.js](../test/sidecar-presence.test.js) (the
  absent-world integration file) gains `adminSession` + feed assertions:
  `GET /api/admin/capabilities` on the engine-less host → transcribe/detect
  `state: "unavailable"` with the reason sentence, `floor.present === false`,
  roster whisper/localDetector `present: false`; then `primeSidecars()` + a
  fresh request → `active` + `viaFloor` (the regression pin for the old
  world).
- capabilities.test.js / board-capabilities.test.js: **zero edits** — their
  boxes make presence true, which was Stage 1's entire point.

Board modal provenance bands and the mapping pane read `running`/the picker
planner — they follow for free. Sizing: ~80 lines of production change,
tests about the same.

### Stage 4 — compose profiles, deploy, README (SHIPPED 2026-09-01, local)

Implemented as below. Verified after: `config --services` lists 4 services
bare and 6 with `COMPOSE_PROFILES=transcribe,detect`; the merged project
validates (no depends_on error); both deploy renders pass `bash -n`; the
stamped value is `''` for the droplet's exclusions and `transcribe,detect`
for a full host; `set_env` proved idempotent including the empty value.

**Compose behaviour, all measured on the installed engine (compose v5.1.4),
not assumed** — five questions, because the profile/exclude interaction is
where this stage can quietly go wrong:

1. A `depends_on` target behind an inactive profile is a **hard error**
   ("depends on undefined service X: invalid compose project"), not a skip.
   This is why the `depends_on` deletion is a prerequisite, not a tidy-up.
2. A bare `up -d` starts **only** the unprofiled services. ✔
3. `COMPOSE_PROFILES=…` is honoured from the project `.env`. ✔
4. **Naming a profiled service explicitly starts it anyway** — profiles gate
   the *default* set, not addressability. So deploy.ps1's explicit service
   list stays authoritative and the two mechanisms never fight: `exclude`
   says what this host builds/ships/starts, profiles say what a bare command
   starts.
5. `compose rm -sfv <profiled-out service>` **fully stops and removes** a
   running container (exit 0, no "no such service"). The exclusion cleanup
   therefore keeps working unchanged — this was the one real risk in the
   stage and it is closed.

Changes:

- [docker-compose.yml](../docker-compose.yml): `transcriber` gets
  `profiles: ["transcribe"]`, `object-detector` gets `profiles: ["detect"]`
  (per-capability, matching the exclusion granularity). **Delete the app's
  `depends_on` entries for extractor/transcriber/object-detector**
  (:147–155), keeping only `db: service_healthy`. The deps buy nothing — the
  app calls sidecars lazily per job and treats unreachable as transient (and,
  after Stage 2, absent as blocked). The extractor stays in the base stack:
  431MB, and it backs PDF/docx ingestion, which IS first-run core.
- [.env.example](../.env.example): a `COMPOSE_PROFILES=` line with the two
  profile names in its comment, in the `--- sidecars ---` neighbourhood where
  `WHISPER_MODEL` already lives.
- [deploy.ps1](../deploy.ps1): with the deps gone, `--no-deps` and the
  separate db-first `up` collapse into one `up -d --wait db <services>` —
  `db: service_healthy` again orders and waits for itself. The explicit list
  stays (finding 4, and because it is what keeps the compose `caddy` service
  out of prod). `exclude` stays: it controls what is *built and shipped*,
  which profiles cannot.
  - **The deploy stamps `COMPOSE_PROFILES` into the droplet's `.env`**, next
    to `APP_TAG`, derived from the non-excluded services. Without it the two
    mechanisms could disagree on a host that excludes only ONE sidecar (the
    deploy would start the other; a bare command on the host would not).
    One source of truth — deploy.local.json's `exclude` — projected into the
    file compose reads. The services table gains a `Profile` column to
    derive it from.
  - Fix the drift while in here: deploy defaults `WHISPER_MODEL` to `base`,
    compose and .env.example to `small`. Align deploy to `small`.
- Droplet effect, stated precisely: a bare
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`
  no longer fails on the excluded sidecars' missing images — that footgun is
  closed. It would still start the compose `caddy` service, which prod does
  not want (host Caddy owns 80/443). That is pre-existing and out of scope;
  the deploy's explicit service list is what avoids it.
- [README.md](../README.md): a quickstart table — base stack (~3.5GB: caddy +
  app + db + extractor) vs `+transcribe` (+1.2GB) vs `+detect` (+3GB); what
  each capability reads as without it (unavailable on the Capabilities tab,
  with a keyed provider able to serve it instead); the one-line opt-in. This
  is the stage's actual deliverable for a stranger cloning the repo.

### Tests (new, beyond the Stage 1 audit)

- resolve: builtin floor absent → null; board pin of an absent engine →
  miss → global rung; present → unchanged bindings (regression).
- worker: extract leg with object fields + absent detector → `noCount`
  requeue, **no usage_meter row** (the money assertion); transcribe loop
  claims nothing while the gate is down, resumes when it lifts.
- status: absent → `unavailable` + roster `present:false`; present →
  `active · built-in` (regression pin).
- presenter: picker row filtered, removal story downgraded, revert button
  gated.
- probes: 400 with the readable message.

## Sequencing

(Stage 1 in fact shipped on its own — behavior-neutral, so the split was
safe; its nine primed call sites stay inert until Stage 2 proves them.)
Remaining commits, each green:

1. **Stage 2** — resolution + worker. The behavior fix: nothing retries
   forever, nothing re-bills, nothing mis-stamps.
2. **Stage 3** — the feed and client tell the truth the resolver now knows.
3. **Stage 4** — compose/deploy/README. Only now is "barebones clone" safe to
   advertise, because absence is a represented state end to end.

## Non-goals / open questions

- **Extractor absence** has the same infinite-requeue shape in its leg, but the
  extractor stays in the base stack and on every host (431MB, doc ingestion is
  core), so it is out of scope here. If a host ever excludes it, this plan's
  pattern (presence via its /health, blocked semantics) extends — its
  descriptor would need a `liveCatalog` declaration first (it has none; its
  URL still lives in a worker const, [worker.js:886](../server/worker.js#L886)).
- **Demand counter for transcribe** ("N clips waiting" on the unavailable
  card): wants an indexed way to count payload-shaped audio rows; revisit if
  the card feels empty in practice.
- **Plugins-page health line for sidecars**: the card could surface the live
  /health state (the ledger deliberately has no rows for floors). Cosmetic;
  not required for honesty.
- **Prebuilt images (GHCR)** would turn the remaining ~3GB build into a
  ~2-minute pull. Real win for adoption, but a release-pipeline commitment
  (multi-arch, tags, push-per-release) — after this plan, not inside it.
- `core: true` in plugins.js keeps meaning "not removable in the UI" — the
  Plugins card's engine is still a real registered provider; only *presence*
  varies per host. No change there.
