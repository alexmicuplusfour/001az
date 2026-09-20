# Queue by resource — limiting work by what it waits on (2026-09-20)

Deep dive into how the worker limits concurrency, why the limits are keyed on the
wrong thing, and what the right key would be. Nothing here is built yet.

The method is deliberate: abstract first, concrete only when the layer above is
settled, and each step down is earned by reading more. A decision taken before its
layer is settled gets made by accident — the code happens to do something, and that
becomes the answer. Layers 1–5 below are settled. Layer 6 is written and awaiting a
read. Layer 7 is code, and nothing in it has started.

## How this started

The question was "wouldn't it make more sense to queue by provider/key instead of
what we do now?" The answer is yes, and the general form is bigger than the AI lane.

## Layer 1 — the idea (settled)

**Limit work by what it waits on, not by what kind of work it is.**

Today there are two limiters keyed on two different things. The rate limiter
(provider-pacing.js) keys on the *resource*: `ai:<provider>:<keyhash>` for AI calls
(providers.js:246), the bare provider name for connectors (connectors/runtime.js:126).
Independent quotas get independent buckets — that half is right. The concurrency
limiter — the four lanes in worker.js:2816 (AI 8 / extract 2 / face 2 / fetch 3) —
keys on the *pipeline stage*. Stage is a proxy for the resource, and it's a bad one in
both directions: it lumps things that don't contend (two boards on different keys, two
boards on different connectors) and it splits nothing that does.

The two limiters also fight. `acquire()` sleeps inside the call
(providers.js:257 → provider-pacing.js), which is inside the pipeline that
`fillLane` launched *after* `ln.take()` (worker.js:2841). A call waiting for a token
holds its lane slot the whole time. The 429 penalty (`throttled`, halves the rate
down to 1/16) lengthens that wait, so a throttled key holds more slots for longer, and
boards on healthy keys lose throughput. The mechanism that contains one key's
problem is what spreads it.

Board-fairness doesn't cover this. `claimFairBatch` (db.js:2825) interleaves boards
only when the batch is wide; on a single-slot refill it's `LIMIT 1` ordered by
`created_at`, and the aged backlog wins every time — the comment on it says as much
("plain FIFO beyond").

### Research (same day)

- The shape has a name: the **bulkhead pattern** — one isolated pool per downstream
  dependency, so a slow one exhausts only its own capacity. The canonical motivating
  example is exactly this bug.
- Three job-queue systems converged on it independently: BullMQ *groups* (per-group
  concurrency + rate, round-robin across groups), Sidekiq *capsules* (separate pools
  with their own concurrency), Oban *partitions* (per-partition concurrency + rate).
  Mostly paid tiers — it's what production hits, not a nicety.
- Sizing: Little's Law, `limit = rate × latency`. The industry moved past computing
  it to *adaptive* limits (Netflix concurrency-limits: +1 on success with good
  latency, ×0.9 on degradation). The pacing bucket's 429 penalty + quiet-period ease
  is already that AIMD shape, on the rate axis. Nothing adapts the concurrency axis.
- Holding a slot in one pool while waiting for a slot in another is the classic
  thread-starvation deadlock. The standard answer is "never hold one while acquiring
  another" — split the unit. This app's leg machinery *is* that split.

Sources: Wikipedia "Bulkhead pattern"; docs.bullmq.io/bullmq-pro/groups;
github.com/sidekiq/sidekiq/wiki/Advanced-Options; github.com/Netflix/concurrency-limits;
netflixtechblog "Performance under load"; pvk.ca "The unscalable, deadlock-prone thread pool".

## Layer 2 — the inventory (settled)

Every thing work waits on, and who waits on it. Read from the code, not recalled.

### Remote — limited by someone else's quota

| Resource | Who waits on it | Limited today by |
|---|---|---|
| **An AI key** — one bucket per provider+key (providers.js:246) | tag leg · extract leg's model call · cloud transcription · cloud detection · cloud embedding · facet diagnosis · `/api/search` (semantic) · `/api/search/similar` · `/api/boards/:id/meaning-clusters` · MCP search (mcp-tools.js:917) · admin key test | rate bucket per key ✓ · concurrency: the AI lane of 8, shared across ALL keys, covering only tag/extract |
| **A connector provider** — one bucket per provider name (runtime.js:126) | fetch leg · face leg (chart history) · liveness refresh + its prefetch · feed enumeration (`list`, `browseFilters`), prewarm (`prefetchIds`), admission (`fetchEntity`) · browse/list/chart/test routes | rate bucket per provider ✓ · concurrency: the fetch lane of 3, shared across providers, covering only the fetch leg |
| **FTP server / S3 bucket** (ingestion/sources) | feed enumeration + file download | nothing — a client per operation, no pacing |
| **Webhook targets** (alerts.js:242) | alert delivery | one at a time, 10 s timeout each |
| Price learner, plugin fetch | hourly / install-time | not in the worker's path |

### Local — limited by the machine (droplet: 1 vCPU, 458 MB, no swap)

| Resource | Who waits on it | Limited today by |
|---|---|---|
| **Image decoding** (sharp-gate.js) | tag renditions · extract's image fallback · detection prep (worker.js:1451) · image uploads/admissions (sources/image.js:57) | **one process-wide gate, strictly 1 at a time, NOT reentrant** — keyed on the resource |
| **Word-doc parsing** (sources/docx-pool.js:18) | docx uploads/admissions | **worker_threads pool, DOCX_WORKERS default 1** — keyed on the resource |
| **Extractor sidecar** (extractor/main.py) | PDF text extraction | Python `http.server` — single-threaded, synchronous. App lane of 2 = one running, one waiting at the socket. 240 s timeout |
| **Detector sidecar** (object-detector/main.py) | object detection | "single-threaded so one memory-heavy inference runs at a time". 180 s timeout |
| **Whisper sidecar** (transcriber/main.py:22,66) | local transcription | one inference thread, `QUEUE_MAX = 4` per lane, express lane < 2 MB, dedup by audio hash. App submits one at a time |
| **On-device embedding** (ai-providers/local.js) | local embedding | in-process, onnxruntime-node (native pool — competes for the vCPU, doesn't block the loop); one text at a time within a batch |
| **Chart / PDF-page / waveform rendering** (faces/*.js) | face leg (charts only) · PDF + audio admissions | **ungated** — sharp + poppler/ffmpeg child processes; up to 2 from the face lane plus whatever uploads arrive |
| **Database connections** (db.js:34) | everything: 15 pipeline slots, 8 loops, every HTTP + MCP request | `pg.Pool max: 5`, no acquire timeout. No transaction spans an outbound call (verified: one `withTx` in worker.js, DB-only) |
| Disk | gallery/thumbs writes, ingest spool, backups | — |

### The three questions that were open, answered by fact

**A connector with two API keys — one resource or two?** Can't happen. One active
provider and one key per connector domain, app-wide (`<domain>_provider`,
`<domain>_key_<provider>` settings, runtime.js:183). No per-board connector pin
exists — boards pin AI keys only (`ai_key_id`, `extract_key_id`, `transcribe_key_id`,
`detect_key_id`; migrations 0001:63, 0010:5, 0033:13–17). Bucket-by-provider-name is
exactly right. Closed.

**What does transcription contend for?** Decided per board: a cloud key
(`transcribe_key_id`), else the Whisper sidecar (resolveTranscriber, worker.js:1118;
floor in capabilities.js:234). A cloud transcription uses the SAME bucket as tagging
on that key (`aiRate` — "same bucket as tagging"). So the answer is "whatever the
board resolves to," and it's the string tagging would produce. Closed.

**Is extraction one job or several?** Several, in sequence, on one lane slot:
extractor sidecar (PDFs, `documentTextFor`) → image decode gate (image fallback via
`modelInputFor`) → the board's extract key or its delegated tag key (`needsLLM`) →
detector sidecar or cloud detect key (`detectable`). Up to four resources. The
clearest case in the app of one unit holding a slot while waiting on things the slot
doesn't represent. Closed — and it's the case the leg split (Layer 1 research)
answers.

### What the inventory turned up that wasn't expected

1. **The right shape already exists, twice.** The decode gate and the docx pool are
   both keyed on the resource. They're the precedent. The four lanes are the outliers.
2. **The worker is not the only consumer.** Searching, browsing, and uploading draw on
   the same keys, connectors, decode gate, docx pool, and DB pool. A concurrency
   model that lives only inside `startWorker` cannot see half the demand.
3. **Every sidecar is effectively 1.** The lane numbers above them are queue depth,
   not parallelism.
4. **The AI key is one resource across five kinds of work**, and a board can pin
   different keys for tagging and extraction. The resource is the key, never the
   (key, kind) pair.
5. **The face leg renders connector charts only.** Image, PDF, audio, and text faces
   are produced at upload time by sources/*.js. So the face lane and the upload path
   both render, ungated, and neither knows about the other.
6. **The DB pool of 5 is a hidden serialization point.** Every query from 15 slots +
   8 loops + HTTP waits on it under load, and nothing models it.

### Deliberate serialization — must NOT change

- The first vote on a multi-vote board runs alone so the rest hit the provider's
  prompt cache (worker.js tagOne, ~7k tokens/item measured).
- Admissions inside one feed run are sequential: the cancel gate is checked between
  admissions (worker.js ingestDue), which is what makes stopping a 250-item import
  instant, and order is what makes "top N" exact.
- The extractor and detector sidecars genuinely do one thing at a time.

## Layer 3 — the split (settled)

The principle — the mechanism owns *when and how many*, the work owns *what it
means* — held against each of the ten kinds of work. For each: what gives it
exclusivity today (a claim), whether its landing is fenced, what a double run would
cost, what must stay with the work, and what is mechanism-shaped but currently living
inside the work's own loop.

| Kind | Claim (exclusivity) | Landing fenced? | Double run costs | Stays with the work | Mechanism-shaped, inside the work today |
|---|---|---|---|---|---|
| **tag** | status flip (`claimFairBatch`) | yes — `markTagged`, `failOrRequeue` | prevented | scoped merge, meter-before-land, first-vote-alone, alert eval | nothing — already the model |
| **extract** | status flip | yes — `markExtracted`; identity via unique index + `winner` | prevented | detector-before-paid-call order, identity resolution, restamp, tx reconcile | nothing — but it's a multi-resource unit (Layer 2 Q3) |
| **face** | status flip | yes — `advanceFaced` | prevented | render-failure-is-ok, refresh stamp | nothing |
| **fetch** | status flip | yes — `advanceFetched`; 23505 → 409 | prevented | `connectorLanding` routing | `prefetchClaimedFetches` — a per-resource batch warm, already passed to `fillLane` as `prep`. **That's the hook shape.** |
| **ingest** (per board) | the stamp (`ingest_next_run_at`) as run identity | yes — `settleIngestRun`, `ingestRunGate` between admissions | prevented per board | drain budget, admission order, ledger reasons, fold-into-prior, one-shot vs scheduled — the whole 200-line block | the 5-min failure backoff (a per-source backoff spelled as a re-arm); the `draining` short-poll |
| **embed** | **none** — `itemsNeedingEmbedding` has no in-flight exclusion | no — `setItemEmbedding WHERE id` | idempotent write, **double bill** | per-board grouping (meter attribution), poison isolation, "nothing-succeeds-alone = config" rule | 60 s batch backoff, drain-fast return, one batch at a time |
| **refresh** | **none** — `dueLiveEntities` is `refresh_at <= now`, no exclusion | no | idempotent write, **double quota** | `refreshDueEntity`'s body (moved fields, face regen, retag-on-refresh); `prefetchDueRefreshes` — a per-connector batch warm, the same hook shape as fetch's | the early-abort + 60 s lane backoff; one entity at a time |
| **transcribe** | **in-memory** `waiting` list — the closest existing sweep to the target shape | no — `landTranscript WHERE id` | idempotent text; sidecar dedups by hash; **cloud bills twice** | per-clip retry ledger + `transcribeFailurePolicy` (park / backoff-item), fold-into-prior, meter | `backoff-lane` (60 s lane-wide); one clip at a time |
| **alerts** | firing creation is atomic (`createAlertFiring`: `firing_id IS NULL` in a tx) ✓ · webhook send: **none** | send: no — at-least-once **by design** | double-send, accepted (receivers dedupe on `firing_id`) | settle window, daily re-arm, at-least-once, per-firing retry table | sequential sends |
| **diagnose** | per-board `FOR UPDATE` on the JSONB ✓ | yes — that lock | prevented per board | settle gate (`busy > 0 \|\| lastTagged < 3 min`), cursor order, per-facet job rows | one board per tick; 60 s cadence |

### What holding the split showed

**1. It holds for all ten.** Nothing needs to move *into* the work. Several things
need to move *out* — every backoff, every cadence, every "one at a time."

**2. The mechanism needs exactly three things from each kind of work:** an
enumeration that excludes what is already in flight, a runner for one unit, and the
resource each unit contends for. The four legs have the first as a DB claim.
Transcription has it in memory. Embed, refresh, and the webhook send have it
*nowhere* — they get it from being single-flight loops. So "one at a time" in those
three is not a correctness argument. It's a missing exclusion, and the pattern for
supplying it already exists twice in the code (`inFlight` → `recoverStuck` excludeIds;
transcription's `waiting`).

**3. Where the mechanism lives: below the worker, beside the pacing buckets.** Routes
are call-shaped (one call, no unit: `/api/search` is one `embedTexts`, browse is one
`list`). Legs are unit-shaped. provider-pacing.js already sits under both and is
already keyed by resource — the concurrency pool lives next to it. The dispatcher
*consults* it before claiming, which is the actual fix for holding-a-slot-while-
waiting: don't claim what the resource can't take, and boards on other keys get
claimed instead. The stage lanes stay as coarse memory/cost fuses — the job
`AI_INFLIGHT`'s own comment gives them. Three layers, each bounding what it says.

**4. Two things Layer 2 didn't see.** The refresh early-abort conflates a per-entity
error (a delisted coin's 404) with a provider-level one (429/5xx) — `tracked` throws
for both, and the loop treats every throw as "back the lane off." And the ingest
window cache is keyed `conn|provider|sort|order|cap|stop` — **not per board** — with
no in-flight dedup in `fillWindow` (connector.js ~176). Two boards on one connector
run one at a time today, so a cold miss walks once. Run them concurrently and both
walk the catalog. Enumeration on a shared key has to become single-flight per key
before boards run side by side. Spool tmp names are unique (`ingest-<16 hex>`), the
ledger is per board, the sources handlers are stateless — those are fine.

**5. The multi-resource extract is a Layer 4 problem** with a known answer: it is
legs, and the pipeline already knows how to be legs.

## Layer 4 — the contract (settled)

One shape for all ten kinds of work, or it isn't one mechanism. Typed against what
each enumeration actually returns today (all read this session), not forced.

### What a kind of work hands over

```
kind = {
  name,                                                // for the log and the wake
  claims,                                              // does `due` flip state? (the legs: yes)
  due(db, { exclude, limit, onlyBoards?, excludeBoards? }) → unit[]   // MUST skip `exclude`
  keys(unit)                            → id[]         // identity for the in-flight set (1..N)
  resourceOf(db, unit)                  → string|null  // what this unit contends for; null = unconstrained
  boardOf?(unit)                        → boardId      // CLAIMING kinds: lets the tick learn board → resource
  prep?(db, unit[])                     → void         // best-effort batch warm, never fatal
  run(db, unit)                         → void         // one unit; owns its fences, ledger, retry
  limit?, pollMs?, inFlight?                           // batch size; cadence; a SHARED set, if given
}
```

*(Rewritten after the Stage 2 close read. The first draft had one `boards` allow-list
that replaced `hasDefaultKey`; Stage 2 found that breaks the face leg, because "can
this run at all" and "what does it contend for" are two questions. The `hasDefaultKey`
gate STAYS in the SQL and answers the first. The contract now carries BOTH lists,
because a claiming kind's tick needs both, at different steps.)*

Three rules that make the asymmetries honest rather than hidden:

- **A claiming kind's tick is two steps, and the two lists belong to different steps.**
  Step 1: for each KNOWN resource with room, an allow-list claim — `onlyBoards` = that
  resource's boards, `limit` = exactly `free(r)`. That is what sizes a claim to a key
  once the lane is gone; sum `free()` across resources instead and one board with a
  hundred pending claims twenty-four rows against a key with room for eight. Step 2:
  one deny-list catch-all — `excludeBoards` = every known board with a non-null
  resource, `limit` = a small allowance — for boards never seen and for boards whose
  resource is null. A null-resource board is therefore capped at the allowance per
  tick; in practice that is only a face item on a board with no connector, which is
  rare and fast. A sweep kind (`claims: false`) has one step: `due({ exclude, limit })`,
  group by `resourceOf`, launch ≤ `free(r)` per group, drop the rest — over-enumerating
  costs nothing, the leftovers come back next tick.
- **`run` may throw.** Containment is the mechanism's (Layer 3), not each catch
  block's. This is what closes the crash in "Found along the way" structurally.
- **A `backoff` zeroes `free()` and touches nothing else.** It is a signal to the
  dispatcher — stop claiming for this resource — never a gate on `wait()`: search
  routes call `embedTexts` on the same wire, and a `wait` that honoured a backoff
  would hang a search for the whole window. Callers proceed and fail fast.

### What the mechanism gives back

- **`exclude`** — its in-flight key set, into every `due`. The missing exclusion for
  embed, refresh, and the webhook send (Layer 3 §2) becomes one `AND NOT id = ANY($n)`
  each, the clause `boardLaneQueues` and `recoverStuck` already carry.
- **`limit`, `onlyBoards`, `excludeBoards`** — per the two-step tick above. `hasDefault`
  and the `OR $2` clause in `claimFairBatch` STAY (corrected at Stage 2): they are the
  "can this run at all" gate, which the pool has no opinion on. The boot race in "Found
  along the way" therefore stays cosmetic rather than retired.
- **`wakeAll()`** — three callers (retag, refresh, ingest) create claimable rows
  without knowing which leg they land in; they nudge every kind at once.
- **A shareable in-flight set.** The four legs are one row namespace and `recoverStuck`
  is fed from ONE set of item ids; split it four ways and an in-flight extract gets
  reclaimed as stuck. Kinds may be handed the same `Set`.
- **launch** — take the resource → `run` (contained) → finally release, drop the keys,
  wake. The `.finally` in `fillLane` today, with a `.catch` it lacks.
- **cadence** — per kind: short after a tick that launched something, the kind's own
  poll otherwise, and wake on every settle (kept, not lost, if it lands mid-tick).
  *(Corrected at 3a: the first draft had `run` return `{ more? }`; `embedDue`,
  `refreshDue`, `ingestDue` (`draining`) and the transcribe loop (`did`) all carry
  that hint today under four names. Redundant — a settle already wakes the loop, and
  a run that stopped at its cap re-arms itself, so `due` answers with it again the
  moment the loop asks.)*
- **resource backoff** — a lane-wide sleep becomes a per-resource one, owned by the
  pool: `free(resource) = 0` for the window. The kind signals it through the taxonomy
  that already exists — `transcribeFailurePolicy` distinguishes `err.scope === "job"`
  from engine-level (worker.js:1098); the 429 path already calls `throttled`.
- **`max(resource)`** — a policy per resource class, seeded from Layer 2:

  | class | seed | why |
  |---|---|---|
  | `sidecar:*` (extractor, detector, whisper) | 1 | single-threaded; a second waits app-side instead of at the socket |
  | `ai:<provider>:<key>` | `rate × latency`, floor 1, ceiling `AI_INFLIGHT` | Little's Law; rate is the bucket's, latency the job log's `ended_at − started_at` per leg |
  | `conn:<provider>` | same shape, ceiling `FETCH_CONCURRENCY` | same |
  | `local` (on-device embed) | 1 | one vCPU |
  | `webhook:<host>` | small fixed | — |
  | `src:<fs root \| ftp host \| s3 bucket>` | small fixed | no bucket to learn from |

  Adaptive (AIMD on the concurrency axis, Layer 1 research) is a later refinement of
  the same `free()` interface, not a different contract.

### The ten adoptions

| Kind | `due` | `keys` | `resourceOf` | `prep` | `run` |
|---|---|---|---|---|---|
| tag | `claimFairBatch(["pending"], limit, boards)` | `[item.id]` | board's tag key (`boardResource`) | — | `processOne` |
| extract | `claimFairBatch(["pending_extract"], …)` | `[item.id]` | board's extract key — **see below** | — | `processExtractOne` |
| face | `claimFairBatch(["pending_face"], …)` | `[item.id]` | board's connector provider (chart history) | — | `processFaceOne` |
| fetch | `claimFairBatch(["pending_fetch"], …)` | `[item.id]` | board's connector provider | `prefetchClaimedFetches` — **already the shape** | `processFetchOne` |
| ingest | `dueIngestBoards(now)` + exclude | `[board.id]` | board's source: `conn:<p>` or `src:<…>` | — | the per-board body of `ingestDue`, unchanged inside; returns `{ more: remaining > 0 && !pausedMid }` |
| embed | `itemsNeedingEmbedding(model, limit)` + exclude, grouped by board | `[...group item ids]` | embed key (global) or `local` | — | `embedGroup`; `more` = full batch |
| refresh | `dueLiveEntities(now, limit)` + exclude | `[entity.id]` | board's connector provider | `prefetchDueRefreshes` — **already the shape** | `refreshDueEntity`; per-entity failure sets that entity's retry and returns — no lane abort |
| transcribe | `oneAudioNeedingTranscription` with `limit` and exclude ∪ its own `waiting` | `[item.id]` | board's transcriber: `sidecar:whisper` or a key | — | `transcribeOne`; engine-scope errors → resource backoff |
| alerts (send) | `pendingWebhookFirings(now, limit)` + exclude | `[firing.id]` | `webhook:<host of webhook_url>` — not board-derived, ignores `boards` | — | send + stamp, unchanged |
| diagnose | boards with votes past the cursor, settled → `segments × facets` | `[board:facet:segment]` | board's tag key | — | `diagnoseFacet`; per-board `FOR UPDATE` stays in the write |

Firing *creation* (the two alert phases before the send) and the maintenance sweeps
(retag, prune, reap, price learning, backup, storage sample) are not kinds of work
here — DB-only or self-gated, they stay on a plain maintenance loop.

### Decisions the contract forces

**Extract is the one unit that doesn't fit, and the contract says why.** One resource
per unit; extract touches up to four (Layer 2 Q3). The honest adoption is three legs —
`extract_text` (`sidecar:extractor`, PDFs only) → `extract_model` (board's extract
key) → `detect` (`sidecar:detector` or a key) — which the pipeline already knows how
to be (`IN_FLIGHT_FOR` + `routingCase`, db.js:97 and :924). Until then it declares its
model key and inner-gates the sidecar — which is exactly today, so the interim is not
a regression, only an unsplit unit.

**`sharpGate` stays an inner gate, not a pool resource.** It is a promise chain
(unbounded, non-reentrant), held for milliseconds, released within the unit. A tag
job holds its key's slot while waiting on it — the same coupling as today, accepted;
making it a pool resource would put a bounded pool behind another bounded pool, the
Layer 1 hazard.

**`boardResource` needs a cache with an invalidation edge.** Resolution is per board
(Layer 2: cheaper than today's per-item), cached beside `boardPromptCache`. Board
writes and key deletion already invalidate (server.js:2531, :2555, :2643); the
app-default rebind in capability-bind does not — that edge gets added.

**Shared-key enumeration becomes single-flight per key.** The ingest window cache
(Layer 3 §4) gets an in-flight promise per `ck` so two boards on one connector share
one walk. Small, and it must land before `ingest` adopts the contract.

## Layer 5 — the mapping (settled)

Every declaration inside `startWorker` (worker.js:1716–3101), assigned. Then where
the mechanism lives and how it composes with pacing, what the wire reads, which tests
and exports pin the surface, and what depends on what.

### The assignment

**Mechanism** — moves to a new module, or becomes the generated loop skeleton:

| Today | Becomes |
|---|---|
| `POLL_MS` (:1717) | the default cadence; a kind may declare `pollMs` (diagnose does) |
| `AI_INFLIGHT`, `FETCH_CONCURRENCY` (:1727–1730) | pool ceilings for the `ai:` and `conn:` classes, under the names they have. `EXTRACT_CONCURRENCY` and `FACE_CONCURRENCY` bound nothing once the lanes go — deleted in 3b, see its finding 3 |
| `lane()`, `aiLane` … `fetchLane` (:2816–2817) | the pool, keyed by resource |
| `inFlight` (:2822) | per-kind key sets — readers take typed ids (`recoverStuck`, `boardLaneQueues` take item ids) |
| `pipelines`, `running` (:2823, :2826) | unchanged, mechanism-owned |
| `wake` + seven `*Wake` closures (:2827–2834) | one wake per kind, generated |
| `fillLane` (:2841) | `tick(kind)`: read `free()` per resource → `due` → `prep` → group by `resourceOf` → launch |
| `dispatchLoop` (:2871) | the generated per-kind loop — one per kind, so a slow `due` in one never delays another |
| `embedLoop`, `refreshLoop`, `ingestLoop`, `alertsLoop`, `diagnoseLoop`, `transcribeLoop` (:2919–3048) | six instances of that same generated loop |
| `stop()` | unchanged shape: stop every loop, then drain `pipelines` |

**Kind** — stays in worker.js as that kind's `due` / `run` / `prep` / `resourceOf`:

| Kind | Keeps |
|---|---|
| tag | `tagOne`, `processOne`, `legLog`, `effectivePreset`, `DIRS`, `MAX_ATTEMPTS` (its `failOrRequeue` policy) |
| extract | `extractOne`, `stampExtracted`, `processExtractOne` |
| face | `processFaceOne` |
| fetch | `processFetchOne`; `prefetchClaimedFetches` is its `prep` verbatim |
| ingest | the per-board body of `ingestDue` (:2019–2247) **unchanged inside**; `RUN_CAP`, `CONTINUOUS_MS`; `draining` becomes `{ more }` |
| embed | `EMBED_BATCH` as its `limit`; `embedGroup` as `run`; `itemsNeedingEmbedding` grouped by board as `due` |
| refresh | `REFRESH_BATCH`; `refreshDueEntity` as `run`; `prefetchDueRefreshes` is its `prep` verbatim |
| transcribe | `transcribeRetry` (the per-clip ledger); `transcribeServed` becomes its `boardResource`; `transcribeOne` as `run` |
| alerts | the send-and-stamp body of `deliverDueAlerts`' third phase as `run` |
| diagnose | `diagnoseCursor`, `diagnoseDeps`, `diagnoseFacet` as `run`, `DIAGNOSE_POLL_MS` as its `pollMs` |

**Maintenance loop** — stays as it is, not a kind: `maintainLoop`, `retagDue`, `PRUNES`
/ `hourly` / `pruneSnapshots`, `REAP_AGE_MS` / `reapGhostEntities`, the price learner
trio, `autoBackup`, `sampleStorage`, `STUCK_MS`, and `recoverStuck` (reads the legs'
in-flight set, as today). The two alert firing-creation phases move here from
`alertsLoop` — DB-only and atomic, they were never outbound work.

**Gone:**

- `STEP` (:2808) — the kinds registry replaces the hand-written map. Drift hazard retired.
- ~~`hasDefault` and `claimFairBatch`'s `OR $2`~~ — **NOT gone; corrected at Stage 2.**
  They are the "can this run at all" gate, distinct from the pool's "does it have
  room". They stay, refreshed by the maintenance loop as today.
- `embedBackoffUntil`, `refreshBackoffUntil`, `transcribeBackoffUntil` — `pool.backoff(resource)`.
- `fillLanes` (:2861) — the four-lanes-in-sequence pass. Each kind ticks alone.
- The `for … await` in `embedDue`, `refreshDue`, `ingestDue`, the `LIMIT 1` in
  transcribe — the mechanism launches units.
- `refreshDue`'s early-abort (Layer 3 §4).

### Where it lives, and how it composes with pacing

- A new module beside provider-pacing.js (name is Layer 6's). Exports `free(resource)`,
  `wait(resource)`, `release(resource)`, `backoff(resource, ms)`, and the max policy.
- **Counting is at the call level, in the wire** — `callTagger` / `embedTexts` /
  `transcribeAudio` beside `paceAi` (providers.js:266–280), and `callProvider`
  (runtime.js:160). The order is `wait(K)` → `acquire(K)` → call → `release(K)`. A
  call waiting on K's *rate* now holds K's *own* slot — that is the bulkhead. Routes
  get it without knowing.
- Sidecars aren't in the wire. Three direct call sites need `wait("sidecar:…")`:
  `documentTextFor` (:1483), `objectDetectorSidecar` (:1291), `whisperTranscriber` (:947).
- **The dispatcher reads `free()`; it never takes.** The in-flight set is unit-level
  bookkeeping; the pool counts calls. Between a claim and its first call a unit holds
  no slot. A vote-N board over-claims by N — bounded by the pool, refined later if it
  ever matters.
- **The wire's "queued" counts don't read the mechanism.** `workFor` (server.js:1222)
  takes in-flight ids from `listRunningJobs` — the job log. The ledger stays the
  observable; the set stays private. No new export.

### Tests and exports that pin the surface

- Exports that must not move: server.js:161, capability-probe.js:16, mcp-tools.js:37
  (`startWorker`, `invalidateBoardCache(s)`, the four `resolve*`, `servedBacklogLanes`,
  `engineStamp`, `nextAutoTagRun`, `normaliseIdentity`). None are mechanism internals.
- `claimFairBatch(db, hasDefaultKey, stages, limit)` is called directly in
  queue.test.js; its second parameter becomes `boards`, or stays and is ignored —
  Layer 6's call.
- Thirteen test files drive `startWorker` end to end (queue, detect, sidecar-presence,
  facet-diagnose, facet-scope, facet-stamp, ingest-connector, ingest-sweep, job-log,
  votes, model-input, connectors, alerts-worker). Each adoption's proof is the tests
  that already pin that kind, unchanged.

### What depends on what

0. The crash fix — two lines, lands first regardless. Mechanism containment also
   closes it, but a real crash shouldn't wait on a refactor.
1. The pool module + the generated loop, with their own tests, no kind adopted.
   Pure addition; nothing observable changes.
2. **The four legs** — they already have claims and fences. This is "queue by key"
   shipped. Retires `lane` / `STEP` / `fillLane` / `fillLanes` / `dispatchLoop` /
   `hasDefault`. Needs `boardResource` + its cache + the rebind invalidation edge,
   and the wire-level `wait`/`release` in providers.js and runtime.js.
3. transcribe — the closest existing shape; needs the whisper `wait` site.
4. alerts send, embed — one exclusion clause each.
5. refresh — exclusion clause; early-abort removed.
6. ingest — after the window-cache single-flight; the biggest body, unchanged inside.
7. diagnose — last, least at stake.
8. extract → three legs — independent once 2 has landed.

2 needs 1. 3–7 need 1, not 2. 6 needs the window fix. 8 needs 2.

## Layer 6 — the plan (written)

This is the refinement worker-rework-plan.md deferred as its own Stage 4 ("per-key AI
lanes … the `extractOne` sidecar/AI split"), taken up with the inventory it lacked.
Two of that arc's lessons are rules here: **no dead knobs** (nothing ships defaulting
to today's behaviour behind a knob nobody reaches), and **concurrency tests are
structural, never timed** — "A doesn't delay B" is a counting stub or a fake pool
reporting `free(A) = 0`, never a wall clock.

Each stage is one commit, reverted alone. Landing order: 0 → 1 → 2, then 3–7 in any
order (6 after its pre-step), 8 whenever it is measured to matter. **Stopping after
Stage 2 ships the original goal**; every later stage is its own decision.

### Stages

- **Stage 0 — The crash fixes. ✅ DONE (2026-09-20).** Plural — a close read found
  three paths, not one. A Postgres restart is the trigger, and it reaches the process
  three ways:

  1. A leg's catch block calls `failOrRequeue` unguarded (worker.js:2306, :2697,
     :2743, :2801). The throw escapes, the pipeline promise rejects, nothing handles
     it — `fillLane` attaches only `.finally`.
  2. `stop()` awaits `Promise.all([...pipelines])`, so a rejecting pipeline makes
     `shutdown()` reject, and `shutdown` is called from
     `process.on("SIGTERM", () => shutdown(…))` (server.js:3928) — floating. An
     unhandled rejection *during shutdown*.
  3. **Different mechanism, missed by the first draft of this stage:** `pg.Pool` has
     no `'error'` listener in production (db.js:34). A restart is exactly what makes
     an idle client error, and an unhandled `'error'` event on an EventEmitter throws
     — uncaughtException. test/helpers.js:126 already adds `db.on("error", () => {})`
     with a comment naming this; the harness is immune to a crash production isn't.

  *The fix, three lines in two files:* `.catch((e) => console.error(…))` in `fillLane`
  **before** the `.finally` — ordering is load-bearing, not stylistic: catch-first is
  what makes `p` provably never reject, which is what closes path 2 as well as 1.
  Plus `pool.on("error", …)` in db.js, logging rather than swallowing (production's
  version of what helpers does). Recovery after the fix is already correct: `.finally`
  runs on rejection too, so the slot is released and the id leaves `inFlight`, and
  `recoverStuck` reclaims the row — no capacity leak, the crash was the only damage.

  *Proof:* rides existing idioms, not invented ones — backup.test.js:288 is the
  template (stray-listener, `setImmediate` drain, `finally` removal), votes.test.js:225
  is `stubFetch`. A real board with `createAiKey(db, …, "openai", "sk-test")` so it
  claims; `stubFetch` fails the call and flips a flag; a db Proxy rejects **every**
  query once flipped — what a restart actually does, and free of SQL coupling. (The
  first draft matched on `SET status=$1, attempts=$2, error=$3`, which a reformat turns
  into a green test that exercises nothing.) Assert the intercept count is non-zero so
  it can't pass vacuously, drain with `setImmediate`, assert no strays, assert `stop()`
  resolves. Second test: a pool `'error'` event doesn't kill the process.

  *Verify:* the tests are the proof; nothing visible changes. *Untouched:* everything
  else. Lands alone, first.

  **Shipped:** as written, with one difference — three tests, not two. The `stop()`
  path (2) earned its own test rather than an extra assertion inside the first: the
  first test's `finally` has to drain the worker anyway, so a `doesNotReject` buried
  there would have been load-bearing cleanup masquerading as an assertion.
  `test/worker-containment.test.js`; suite 1811/1811 green.

  **Each test was run against the unfixed code and fails there** — 3/3 failing, each
  for its own reason (stray rejection; a rejected drain; no pool listener). Without
  that check the first draft's SQL-text match would have passed vacuously, which was
  the whole objection to it.

  **Also found:** `scripts/backfill-uploaded-by.js` builds its own pool with no
  `'error'` listener either. Deliberately left — it is a one-shot manual script, so
  the failure is visible and re-runnable, not a service dying under a deploy.

- **Stage 1 — The pool, and one key vocabulary. ✅ DONE (2026-09-20).** *(A close read
  moved the loop generator out of this stage — see "what the close read changed" below.)*

  **The key vocabulary first, because it is what makes the pool possible.** The two
  limiters already key on the resource, but they spell it differently: AI buckets are
  `ai:<provider>:<keyhash>` (providers.js:246, prefixed), connector buckets are a bare
  `coingecko` (runtime.js:129, unprefixed). `maxFor` dispatches on prefix, so a bare
  name falls to the permissive default instead of `FETCH_CONCURRENCY` — every connector
  would get the wrong ceiling. Fix: export `aiKeyBucket`, and namespace the connector
  bucket to `conn:<name>` at its two call sites (`acquire`, and the `withRetry` key
  that reaches `throttled`). Blast radius checked: the pacing key is only ever an
  in-memory `Map` key, never persisted; the meter records `{ capability: "api",
  provider: name }` from `name` separately, so it is untouched. This half is a REAL
  change, which is what keeps the stage from being pure dead code.

  *(Corrected at build: I predicted existing pacing tests wouldn't break because they
  pass synthetic key names. Wrong — faces.test.js:282 passes its synthetic name through
  `callProvider`, which namespaces it, so the assertion moved to `conn:rl-learn` and
  the test failed until it did. That failure is worth more than the prediction was: it
  is the proof both call sites moved together, so the test now also asserts nothing
  lands on the bare name — `acquire` and `throttled` drifting onto different buckets is
  exactly what this vocabulary exists to prevent.)*

  **Then the pool** — `server/resource-pool.js`, beside provider-pacing.js: `free(r)`,
  `wait(r)`, `release(r)`, `maxFor(r)`, `_reset()` (the seam pacing already has).
  `maxFor` by prefix — `sidecar:` → 1, `ai:` → `AI_INFLIGHT`, `conn:` →
  `FETCH_CONCURRENCY`, anything else → a permissive default (defaults, not laws).
  Never a vendor name. **Only the prefixes Stage 2 consumes**: `local`, `webhook:` and
  `src:` arrive with Stages 4 and 6, and `backoff(r, ms)` with Stage 3 — the plan's own
  no-dead-knobs rule applies to uncalled functions as much as to unreachable env vars.
  The table is data and grows per stage.

  *Proof:* `resource-pool.test.js` — **the bulkhead property itself: saturate A, assert
  B's `free` is untouched and its `wait` resolves immediately** (this was missing from
  the first draft, and it is the entire reason the module exists); never exceeds `max`
  under a flood (counting stub, the worker-rework Stage 1 shape); `wait` on a full
  resource resolves only after a `release`; an over-release cannot drive the count
  negative; `free` for an unseen resource returns its max; `maxFor` resolves by prefix,
  env wins, unknown gets the default. Plus a pacing test that the connector bucket is
  now namespaced. *Verify:* none — the suite is the proof, as worker-rework's Stage 0
  was. *Untouched:* worker.js.

  *Noted, not built:* `wait` queues unbounded, exactly as `acquire` already does. The
  dispatcher cannot contribute to that by construction (it claims no more than `free`);
  routes could under heavy load. Worth knowing before it is worth machinery.

  **Shipped:** `server/resource-pool.js` + `test/resource-pool.test.js` (9 tests),
  `aiKeyBucket` exported, `connBucket` in runtime.js at both call sites, faces.test.js
  updated. Suite 1820/1820. Two things the build added beyond the written stage, both
  from writing `release`: a waiter is handed the slot *directly* rather than through a
  decrement-then-reacquire, so the count never dips and a newcomer cannot jump a queued
  caller; and `release` clamps at zero, because it lives in `finally` blocks, which is
  where double-releases come from and where going negative would silently widen the
  pool. Both are tested.

  *Verified safe, and worth recording because Layer 1's research named it as the
  classic deadlock:* no `wait` can nest inside another. Each of the six sites Stage 2
  wraps holds exactly one outbound call; the sidecar text extraction happens inside the
  parts builders (worker.js:1557, :1584, :1656) which finish before the model call
  starts; image decoding completes in an `await` inside the detector's argument list;
  and in both `tracked` wrappers `release` runs inside the call while the plugin-health
  DB write runs after it, so a slow ledger write never holds a slot.

  **What the close read changed.** The first draft put the loop generator (`runKinds`)
  in this stage. Its first real consumer is Stage 3, so building it here would design
  its contract before any sweep had tried to fit it — the exact "decide it before the
  layer is settled" failure this method exists to prevent. Worse, validating it against
  the four legs would validate it against the least representative kinds: they all
  claim through the database and all have landing fences, where the sweeps have
  neither. It moves to the front of Stage 3, where transcribe — the closest existing
  shape — is its first consumer. That in turn shrinks Stage 2 (below).

- **Stage 2 — The four legs adopt it. Queue by key.** The goal. (a) `boardResource(db,
  kind, boardId)` in worker.js: tag and extract resolve through `resolveCapability` to
  `aiKeyBucket(provider, apiKey)` — **exported from providers.js and used, not
  re-spelled**, so lane and bucket cannot drift; face and fetch resolve through
  `activeProvider` to `conn:<name>`, catching its throw (it raises when a connector's
  providers are all uninstalled) and treating that as no resource. **Null means
  UNCONSTRAINED, not unclaimable** — see (b). Cached beside `boardPromptCache`;
  invalidated by the three existing edges (server.js:2531, :2555, :2643) plus a new one
  in capability-bind.js for the app-default rebind.

  (b) **`excludeBoards`, a deny-list — NOT an allow-list.** The first draft had
  `boards` replace `hasDefaultKey` outright, and a close read found that breaks the
  face leg: queue.test.js:81 asserts a face item claims with no key AND no connector,
  and the comment at :118 says why — "renders nothing → advances". Real work that
  completes. An allow-list built from resolvable resources would never claim it.

  The error was collapsing two questions that don't collapse. *Can this run at all?*
  is already answered by the existing SQL (`i.status IN ('pending_face','pending_fetch')
  OR b.ai_key_id IS NOT NULL OR $2`). *What does it contend for?* is the new question.
  A tag item with no key can't run; a face item with no connector runs contending for
  nothing. Both resolve to null and need opposite treatment. So the pool's restriction
  is purely SUBTRACTIVE — hold back boards whose resource is saturated, leave anything
  unresolvable alone. `hasDefaultKey` and the `OR $2` clause STAY, untouched. Same
  deny-list-not-allow-list instinct as the board-duplicate arc, for the same reason:
  a case nobody thought about should work by default.

  This also retires the signature churn (Layer 5 left it open): one optional
  `excludeBoards` parameter on `claimFairBatch` means the 17 positional
  `claimNextWork(db, hasDefaultKey, stages)` call sites across five test files don't
  change, and queue.test.js:178's positional `claimFairBatch` keeps working.

  **Where the board list comes from**, which the first draft left unspecified: NOT a
  `SELECT DISTINCT board_id` per stage per tick — `board_id` isn't in `idx_items_status`,
  so that is a heap visit per backlog row every 250 ms, or a new composite index. A
  resource only saturates because the dispatcher launched work on it, so the dispatcher
  keeps a `Map<boardId, resource>` filled at claim time and excludes the boards whose
  resource has no room. No extra query, no migration, self-correcting. A board it has
  never seen slips one row through before joining the map — the same bounded
  imprecision already accepted for vote fan-out.

  (c) The wire: `pool.wait(bucket)` before `paceAi` and `release` in
  a `finally`, in `callTagger` / `embedTexts` / `transcribeAudio` (providers.js:266–280)
  and in `callProvider` (runtime.js:160); `documentTextFor` (:1483) and
  `objectDetectorSidecar` (:1291) get `wait("sidecar:extractor")` /
  `wait("sidecar:detector")`.

  **`wait` BEFORE `acquire`, and the reason belongs in a comment because it is
  load-bearing and counterintuitive.** The pool must count units *committed* to a
  resource, including those asleep in the token bucket. Count only calls genuinely in
  flight and a throttled key reports full capacity while every unit sleeps — and the
  dispatcher, reading `free`, claims without bound. Someone will eventually try to
  "fix" the ordering so the pool counts only real calls; that silently disables the
  whole mechanism.

  *Known interim, stated rather than discovered later:* the sidecar `wait` is inside
  the extract unit, but the extract STAGE's resource is the AI key — so sidecar
  saturation never informs the claim. No regression (it is what happens today), and it
  is the multi-resource case Stage 8 resolves. (d) **`dispatchLoop` and `fillLanes` STAY** — the close
  read of Stage 1 shrank this stage to the smallest diff that delivers the goal.
  `fillLane` resolves each board's resource, keeps the boards whose resource has room,
  and passes them to `claimFairBatch`; the four lane counters stay exactly what Layer 4
  assigned them, the coarse memory/cost fuse `AI_INFLIGHT`'s own comment describes.
  `hasDefault` STAYS (it is the can-run gate — see (b); an earlier line here said it
  goes, and was wrong). `STEP`, `lane`, `dispatchLoop`
  and the four-lanes-in-sequence fix travel with the loop generator in Stage 3 —
  that fix is worth microseconds and does not belong in the commit that carries the
  goal. (e) The `*_CONCURRENCY` / `AI_INFLIGHT` names become the pool's class ceilings
  — same names, same env. *Proof, green:* queue.test.js (the "no key anywhere"
  test keeps its assertion — a board resolving to no resource is not in `boards`; a
  face's connector resolves, so it claims), votes, facet-scope, facet-stamp,
  model-input, detect, sidecar-presence, job-log, connectors, ingest-connector,
  ingest-sweep, alerts-worker. *Proof, new:* two boards on two resources with a fake
  pool reporting `free(A) = 0, free(B) = 2` → only B's rows claim (the starvation case,
  structurally); `boardResource` invalidates on board key edit, key delete, and
  app-default rebind; the tag resource string equals `aiKeyBucket()` for the same key;
  a route's `embedTexts` and a worker tag call on one key share one pool count
  (counting stub); `claimFairBatch` with `boards = [b1]` never returns b2's rows.
  *Verify in the real app:* the fetch side needs nothing extra — a crypto board on
  CoinGecko and a stocks board on FMP, both with queued fetches, CoinGecko's rpm
  override set to 2 on the Plugins page: the stocks fetches proceed at full speed in
  the Jobs modal while crypto crawls. The AI side needs two keys; with two, throttle
  one the same way and the other board keeps tagging. With one key nothing visible
  changes, and that is the correct result. *Untouched:* the six sweeps and their loops.

- **Stage 3 — split three ways after a close read.** The first draft bundled the loop
  generator, the four legs moving onto it, and transcribe adopting. But the legs-move
  is where the global lane goes — and after Stage 2 we know the lane is what keeps the
  pool inert, so 3b is the commit where queue-by-key actually starts working. It gets
  its own commit and its own real-app verification. Three findings from the close read
  are folded in: the stage repeated Stage 2's two-questions mistake (`transcribeServed`
  is the can-run gate and stays in SQL; `boardResource` is added beside it, not instead);
  `backoff` must not gate `wait()`; and the four legs need ONE shared in-flight set.

  - **3a — the loop generator. ✅ DONE (2026-09-20).** `server/resource-loop.js`:
    `runKinds(kinds, { db })` → one loop per kind. Tick per the Layer 4 contract:
    claiming kinds run the two-step tick (per-known-resource allow-list claims sized
    to `free(r)`, then a deny-list catch-all with a small allowance); sweep kinds
    enumerate once, group by `resourceOf`, launch ≤ `free(r)` per group, drop the
    rest. `null` resource = unconstrained. `prep` before launch, best-effort. Every
    `run` under containment. `wakeAll()` returned. Kinds may share an in-flight `Set`.
    `stop()` stops every loop, then awaits every in-flight run.

    **Shipped, with one contract change found while building: `more` is gone.** The
    first draft had `run` return `{ more? }` so a sweep could ask for a short poll.
    Building the cadence showed it redundant: every settling run already wakes its
    loop, and a run that stopped at its cap re-arms itself (ingest sets
    `next_run_at = now`; embed's next batch is simply still due), so `due` answers
    with it again the moment the loop asks — sooner than any short poll would.
    Cadence is therefore: short after a tick that launched something, the kind's poll
    otherwise, and wake on every settle. A wake that lands mid-tick is kept (a
    `pending` flag) rather than lost to the next poll; the dispatcher this replaces
    lost it and leaned on its short poll, which left a freed slot idle for up to a
    poll when the tick had launched nothing. Cost: one tick per settle under a settle
    storm — bounded by the batch that was launched, and zero when nothing settles,
    which is strictly better than polling every 200 ms for the length of a
    five-minute transcription.

    **Also found while building — in the tests, not the loop, and worth recording
    because it is the sweep contract stated from the other side:** a sweep's `due`
    must stop returning a unit once its work has landed. The first fake backlog never
    did, so a completed unit was re-launched forever, and a held one meant `stop()`
    could never drain; the fakes now remove a unit in a `finally`, success or throw.
    And every fake `due` yields one macrotask, the way a real one does across the
    database round-trip — without it, wake-on-settle → re-tick is a pure microtask
    cycle that starves `setImmediate` and hangs the harness, a shape production
    cannot produce since every real `due` is a query. 11 tests, `resource-loop.test.js`;
    `claimFairBatch` gained `onlyBoards` as a sixth positional with `null` = no
    restriction, so all 18 existing call sites are untouched. Suite 1837/1837, one
    parked for 3b. **Adds `backoff(r, ms)` to the pool** — zeroes `free` for the window, leaves
    `wait` alone. `claimFairBatch` gains `onlyBoards` beside `excludeBoards` (both
    optional, both positional after `excludeBoards`; nothing existing changes).
    **Not wired into `startWorker`.** *Proof:* `resource-loop.test.js` with a fake
    kind and an injected `sleep` so cadence and wake are asserted by the recorded
    delay, never by a clock — `exclude` is passed and honoured; a sweep's units group
    by `resourceOf` and launch ≤ `free` per group, leftovers dropped and re-seen next
    tick; a claiming kind's step 1 sizes each known resource to exactly `free(r)` and
    step 2 excludes every known board; a null resource launches regardless of pool
    state; a rejecting `run` is contained and the loop continues; `more` shortens the
    next sleep; `wakeAll` cancels a pending sleep; `stop` resolves only after an
    in-flight run does; two kinds handed one `Set` share it; `backoff` zeroes `free`
    while `wait` still proceeds. *Verify:* none — no observable change; the suite is
    the proof. *Untouched:* worker.js.

  - **3b — the four legs move. ✅ DONE (2026-09-20).** They register as four claiming
    kinds sharing one in-flight `Set` (which `recoverStuck` reads). `STEP`, `lane`, the
    four lane objects, `fillLane`, `fillLanes`, `boardSeen`/`heldBack`, `pipelines`,
    `dispatchLoop` and its `wake` retire; the three callers that nudged the dispatcher
    (retag, refresh, ingest) call `wakeAll`. **Test 7 in queue-by-key.test.js unskips
    here** — this is the commit that makes it true: `AI_INFLIGHT` stops sizing a shared
    lane and sizes each key's own pool, so a stuck key holds only its own slot.

    **Five findings from the close read, three of which changed what shipped.**

    1. **The legs are a pipeline, and the wake did not follow it.** `markExtracted` and
       `advanceFaced` both land rows in `pending` — the TAG leg's queue; `advanceFetched`
       lands in `pending`/`pending_extract`. The old dispatcher refilled all four lanes on
       any settle, so this was free. Four independent loops lose it: an extract settling
       wakes only the extract loop, and a claimable row then waits up to a full poll.
       Fixed in the loop module, one rule, no new knob: **a settle wakes every kind that
       shares the settling kind's in-flight `Set`.** They share a Set because they are one
       row namespace; being one pipeline is the same fact stated twice.
    2. **`null` resource has no total-in-flight ceiling — and checking first is why no
       class was added for it.** The close look flagged an on-device tagger as the
       unbounded case: `boardResource` returns `null` for `onDevice`, and the AI lane was
       silently capping it. Verified before building, and the premise is wrong — no
       on-device provider can serve tag or extract. `tag`'s floor is `blocked`, `extract`
       delegates to `tag`, and all three on-device descriptors carry no tag wire (`local`
       is embed-only with `wire.tag = null`; `whisper` and `localDetector` have
       `wire: null` outright). That branch is Stage 2's forward guard for a tagger that
       does not exist yet, so a `local:` pool class would have been a ceiling on a path
       nothing can enter — the dead-knob smell one level up. **Not built.**
       What IS true and belongs in every later stage: after 3b nothing caps a kind's
       TOTAL in-flight, only its per-resource in-flight, so `null` has to keep meaning
       "this work is cheap", not merely "this work is unkeyed". Every live null today is
       cheap or bounded elsewhere — a face on a board whose connector has no installed
       provider renders nothing and advances; CPU decode has its own gate in
       sharp-gate.js; the extractor and detector are `sidecar:` resources taken at the
       call. A future kind with a slow unkeyed `run` needs a resource of its own, and
       naming one is cheaper than reviving a lane.
    3. **`EXTRACT_CONCURRENCY` and `FACE_CONCURRENCY` became dead knobs.** The stage text
       above claimed all four `*_CONCURRENCY` numbers survive as class ceilings; two of
       them don't. Extract's resource is an `ai:` key and face's is a `conn:`, so those two
       env names bound nothing once the lanes go — deleted rather than left to read like
       live tuning. `AI_INFLIGHT` (with its `TAG_CONCURRENCY` alias) and `FETCH_CONCURRENCY`
       survive, as the `ai:` and `conn:` class ceilings they already were in Stage 1.
       The boot log named all four lane sizes and now names the pool's ceilings instead.
    4. **Kinds sharing one resource can over-commit inside a tick.** A board that pins
       neither tagger nor extractor has ONE key for both legs. The tag kind reads
       `free(r) = 8` and claims 8; the extract kind reads the same 8, because nothing has
       reached the wire yet, and claims 8 more. The pool's "the dispatcher cannot
       contribute to the waiter queue by construction" holds per kind, not across kinds.
       Left alone deliberately: the over-committed rows WAIT at `poolWait` rather than
       fail, it corrects on the next tick (by then `free` reads 0), and it is strictly
       better than the two independent lanes of 8 and 2 it replaces. Machinery to make it
       exact would need a commitment counter shared across loops, which is a lot of
       structure for an imprecision that costs nothing.
    5. **Cold start ramps by one tick per board.** An unseen board's first claim is the
       catch-all allowance (4), not the lane's free slots (8); from the second tick step 1
       sizes to the real number. One tick, once per board, and the steady state is right.

    A known race widens and is worth recording: derived-identity classify mode has a
    same-board extraction collision (two items minting one candidate) that self-heals on
    retry. It was reachable at `EXTRACT_CONCURRENCY` = 2 and is now reachable at the
    extract key's ceiling. Same defect, same self-heal, more often — noted in
    identity-classify-mode-plan.md, not fixed here.

    *Proof, green:* every test Stage 2 listed, plus board-pause, fences, retry.
    *Proof, new:* test 7 unskipped — two boards on two keys, `AI_INFLIGHT=1`, the stuck
    one holds only its own slot; a settle wakes a sibling kind sharing its in-flight Set
    and leaves an unrelated kind asleep (verified to fail without the fix). Suite
    1839/1839, nothing skipped.
    *Verify in the real app:* the Stage 2 verification, done here instead — two
    connectors with one rpm override, and two keys if available.

  - **3c — transcribe. ✅ DONE (2026-09-20).** `audioNeedingTranscription` (renamed —
    it no longer returns one) takes a `limit` and `exclude ∪ waiting`; **`transcribeServed`
    stays in the SQL** as the can-run gate; `boardResource(transcribe, board)` — the
    whisper sidecar or the board's own key — is added beside it; the engine-scope branch
    `transcribeFailurePolicy` already had calls `backoff(resource, 60 s)` in place of
    `transcribeBackoffUntil`; `whisperTranscriber`'s `transcribe()` takes
    `wait("sidecar:whisper")` spanning submit AND every poll, released in a `finally` —
    five throw exits plus the return, and the slot is rightly held for minutes because
    the sidecar is busy the whole time; `transcribeLoop` goes.

    **Six findings from the close read, plus one that only building could surface.**

    1. **The wait would have starved the admin probe.** `capability-probe.js` calls the
       same `transcribe()` with `deadlineMs: 30000`, and that deadline is measured from
       INSIDE the function — after the wait. A probe parked behind a twenty-minute clip
       would blow its whole budget without once checking it, where today it works fine,
       because the sidecar's submit is asynchronous (202 + a job id) and nothing
       serializes at the socket. Fixed with the flag that already carries this meaning:
       `deadlineMs` marks an interactive caller, and such a caller skips the pool
       entirely. It submits, the sidecar queues it alongside, and the existing
       "transcriber busy" deadline error reports exactly what it reports today. The pool
       therefore counts the clips the WORKER has in flight — which is the number that
       sizes its claims, and the only number that needed to be true.
    2. **One wait per path, and one of the two was already done.** A cloud transcriber
       runs `transcribeAudio` → `viaKey`, which has held `ai:<key>` since Stage 2. Had
       the kind's `run` also waited on `boardResource(transcribe, …)` it would be the
       same string twice on one call — a self-deadlock at `AI_INFLIGHT=1`. So only the
       whisper path gained a wait, inside its own wire. Not a special case: `detect`
       already splits exactly this way (`objectDetectorSidecar.detect` wrapped at the
       sidecar, `detectObjects` counted by `viaKey`).
    3. **Backing off a cloud key now reaches the tag leg**, because they are the same
       resource and the tag leg sizes claims off the same `free()`. Accepted and written
       into the code: one key is unwell, everything on it should ease off, in-flight work
       continues, and the token bucket still does the real pacing. The alternative is a
       transcribe-only name for one key, which is the two-limiters-under-one-name defect
       the arc exists to end.
    4. **`boardResource`'s cache sat behind an uncached board read.** It took the board
       ROW, so every caller did `getBoard` first and the cache only ever saved the
       capability resolution. A sweep resolves every unit it enumerates including the ones
       it drops, so this bit hardest here. Added `boardResourceFor(db, leg, boardId)`,
       which consults the cache before reading anything — and **3b's four legs moved onto
       it too**, so a claimed row on a known board now costs no query at all.
    5. **`oneAudioNeedingTranscription` had to stop being "one".** The limit is the point:
       with `LIMIT 1` the newest clip could be a whisper clip that cannot launch, and a
       cloud-pinned board's clip behind it was never even looked at — the head-of-line
       block, made structural by the query. Renamed; 9 call sites, mechanical.
    6. **`transcribeOne` was left alone.** Its `board` is declared inside the `try`, so a
       `backoff` call in its catch would have had nothing in scope. The kind's `run` acts
       on the `"backoff-lane"` it already returns instead, and its four tests did not move.
    7. **Found while building: the pool's backoff is process-wide, where
       `transcribeBackoffUntil` was per-worker-instance.** That is more correct in
       production — the pool is process-wide because the RESOURCE is (the same sidecar
       serves the routes), one process runs one worker, and a restart does not heal a
       downed engine. But three job-log tests failed on it: they build several workers in
       one process, and a test that knocks the sidecar over was holding the next sixty
       seconds of the file hostage. The old code hid that by keeping the timer in
       `startWorker`'s closure. Fixed where it belongs — `runWorker` clears the pool, the
       way the pacing tests call `_resetBuckets` — not by weakening the backoff.

    One cost accepted: the wall-clock gate used to short-circuit before the query, so an
    outage meant no reads at all. The sweep now asks every tick and gets nothing back —
    one indexed read per poll.

    *Proof, green:* audio, media, sidecar-presence (its "the lane idles without an engine"
    assertion is now the SQL gate doing exactly what it always did), job-log, board-pause.
    *Proof, new:* the worker's clip holds the sidecar slot for the whole job and hands it
    back; an interactive probe never queues behind it (verified to HANG without the skip,
    which is the starvation itself); `boardResource` names `sidecar:whisper` for the floor
    and the key's own bucket for a board pinning a cloud key. Suite 1842/1842.
    *Verify in the real app:* with the whisper sidecar, two uploads still serialize at the
    sidecar (its max is 1) — unchanged and correct; with a cloud transcriber pinned on one
    board, both progress at once. *Untouched:* the sidecar, the per-clip ledger, the
    fold-into-prior logic, `transcribeOne`.

- **Stage 4 — split in two after a close read.** Alerts and embed share nothing, and
  the embed half edits `viaKey` — a wire `/api/search`, similar, clusters and the MCP
  all go through, not just the worker. That earns its own commit and its own green
  suite rather than riding along with a webhook change. One line of the first draft was
  already stale: "`more` is a full batch" — `more` was deleted in 3a, and a full batch
  re-arms itself so `due` answers with it on the next tick, sooner than a short poll.

  - **4a — alerts send. ✅ DONE (2026-09-21).** `deliverDueAlerts` splits into
    `createDueFirings` (its two grouping passes — pure coordination, no outbound I/O)
    and `deliverFiring` (one firing's send-and-stamp). Creation runs on the maintenance
    tick; delivery is a kind with `resourceOf = webhook:<host>`. `pendingWebhookFirings`
    gains `excludeIds`; `alertsLoop` and `alertsWake` go.

    **`deliverDueAlerts` survives as the composition of the two halves**, and that was
    the right call rather than churn: it has one production caller but twenty-five in
    alerts.test.js, where "tick the whole thing once, synchronously" is exactly what
    makes that file deterministic about settle windows. The worker runs the halves
    separately; the tests keep their one-shot.

    **Findings.**

    1. **`exclude` here is a correctness requirement, not an efficiency one.** Delivery
       is send-THEN-stamp on purpose — at-least-once, because a crash between the two
       resends where the other order silently loses a notification. So a firing stays
       `pending`, and therefore stays due, for the whole length of its own send. The
       sequential loop re-read it safely because only one send ever existed; a kind
       launches without awaiting, and the exclusion is the only thing standing between
       an overlapping tick and a duplicate POST. Proven by removing it: the test fails.
    2. **`webhook:` is capped at 2, and the number is not for our benefit.** The win is
       that two HOSTS stop queueing behind each other — which one sequential loop over
       every pending firing denied them. Within a single host 2 collects essentially all
       of that; the permissive default of 8 would have meant eight simultaneous posts to
       a stranger's server, which collects none of it. `webhookBucket` lives in
       alerts.js beside the sender, for the reason `aiKeyBucket` lives in providers.js:
       one speller, so the pool and the caller cannot mean different things.
    3. **Nothing backs off a webhook resource, deliberately.** A failing endpoint already
       has a per-firing retry schedule in its own row — two escalating windows then
       `failed` — which beats a shared 60-second gate on every count: it is per firing,
       it survives a restart, and it is visible in the ledger.
    4. **Moving creation to the maintenance tick costs no latency**, because that loop
       already calls `wakeAll()` at the end of its pass and the delivery kind is now in
       that set. A firing created there is sent on the same tick. This is 3b's
       shared-wake generalization paying for itself a second time.
    5. **Small, found by a failing test:** `deliverFiring` takes a *pendingWebhookFirings*
       row — the firing JOINed to its alert, which is where the URL and the signing
       secret live. The `alert_firings` row alone carries neither. Said so at the
       function, since the kind hands `run` exactly what `due` returned.

    *Proof, green:* alerts, alerts-worker, alert-editor, job-log. *Proof, new:*
    `webhookBucket` names the host and collapses two paths on it, separates two hosts,
    answers null for an unparseable URL, and is capped at 2; a firing still `pending` is
    due, and is withheld while this process is sending it (verified to fail without the
    exclusion). Suite 1844/1844. *Verify in the real app:* two alerts pointed at two
    different webhook hosts fire in one tick. *Untouched:* firing-creation atomicity,
    at-least-once, the payload, the retry schedule.

  - **4b — embed. ✅ DONE (2026-09-21).** `itemsNeedingEmbedding` gains `excludeIds`;
    `due` groups by board and a unit is a board GROUP (`keys` returns its row ids — the
    contract already allows 1..N per unit); `run` is `embedBatch` on one board's rows;
    batch-level errors call `backoff`; `embedLoop`, `embedDue` and `embedBackoffUntil` go.
    `local:<provider>` joins the pool at max 1.

    **`viaKey` was NOT changed, and reversing that is the finding.** The close read said
    on-device should stop skipping the pool — that it conflates "no external rate limit"
    (true, why it skips `paceAi`) with "no concurrency limit" (false). The diagnosis
    holds; the prescription did not survive being written down. Counting on-device calls
    at the wire means every interactive caller is in the count too — `/api/search`,
    similar, clusters and both MCP tools all embed one short string through the same
    function. Two consequences, both bad and both new: `free()` would read zero because
    somebody typed in the search box, so the sweep would stop claiming for a 15 ms call;
    and that search would queue behind a sixty-four-text backfill batch, where today it
    interleaves with it. So the slot is taken by the BULK caller — the sweep's `run`,
    on-device only — and the class means "how many batches the backfill runs at once",
    which is the only thing that needed bounding. It is the whisper probe's rule again:
    an interactive caller has no business in the number that sizes background work.

    The happy side effect is that **4b never touches the shared wire at all**, which was
    the entire reason for splitting it out of 4a. The split was still right — that was
    only knowable by doing it.

    **The rest.**

    1. **Grouping is about metering, not contention.** All groups in a tick resolve to
       one resource, because the embedder is app-global — `resolveCapability("embed")`
       takes no board. The grouping exists because the wire answers one usage total per
       call, so a call spanning boards would leave the per-board split a guess, which is
       apportionment and the meter never does it. `run` is `embedBatch` unchanged rather
       than a reach into `embedGroup`: one board's rows re-group to one group and one
       call, and the eleven tests around that path did not move.
    2. **`exclude` matters here for money, not duplication.** A row stops qualifying only
       when its vector lands, so it stays due for the whole length of the call embedding
       it — and a second tick would re-read it and pay a second time. Verified to fail
       without the exclusion.
    3. **A paid embedder gets faster and now shares the tag legs' budget.** It was always
       counted at the wire (Stage 2), but the old sweep ran one batch per tick no matter
       who served it. Groups now launch up to `free(ai:<key>)`, which is the same eight
       slots tagging on that key uses — one quota, honestly. A big backfill can therefore
       crowd out tagging on a single-key install; binding a separate embedding key (it is
       an app-level setting, unlike the per-board tag key) gives it its own eight. Rate is
       unaffected either way — the per-key bucket still paces, so parallelism cannot
       exceed rpm; it only stops the sweep from waiting when the provider was not.

    *Proof, green:* embed-sweep, board-pause, job-log, search, mcp. *Proof, new:* rows
    mid-call are withheld (fails without it); a paid embedder buckets exactly as the rate
    limiter does and keeps the key's ceiling, while the on-device one is its own class at
    1 — so the two can never cap each other. Suite 1846/1846. *Verify in the real app:* a
    100-item retag embeds in visibly fewer ticks (job-log timestamps). *Untouched:*
    `viaKey`, `embedBatch`, `embedGroup`, poison isolation, the per-board metering split.

- **Simplification pass after 4b (2026-09-21).** Suite unchanged at 1846/1846. What
  came out: the loop's `wakes`/`known` maps keyed by kind NAME are keyed by the kind
  object (`known` is now a local per loop, handed to the tick); the three-way `wakes.set`
  dance in the loop collapsed to one wake that cancels a sleep if there is one and sets
  `pending` otherwise; `inFlightOf` (a test-only accessor — the test asserts on the set it
  already holds) and the per-kind `allowance` (a contract option no production kind ever
  set) are gone; `keys` defaults to `[unit.id]`, so only the embed kind spells it; every
  sweep kind dropped `claims: false`, `pollMs: POLL_MS` and `inFlight: new Set()`, all
  three being the loop's own defaults. The shared-wake rule and the `local:` rule were
  each written out in three places and now live once — in the loop's `launch` and in
  the pool's class table — with a one-line pointer from the others. The stale `viaKey`
  comment that promised on-device would take a wire slot now says why it does not.
  Considered and left: folding `embedResource` into `boardResource` — on-device returns
  null there on PURPOSE, since nothing would hold a `local:` slot for a tag leg, and a
  resource name nobody holds is unbounded in a costume.

- **Stage 5 — Refresh. ✅ DONE (2026-09-21).** `dueLiveEntities` gains `excludeIds`;
  the refresh kind is a sweep whose `run` is `refreshDueEntity` with its own catch →
  `setEntityRefreshAt(+60 s)`; `prefetchDueRefreshes` is `prep`; `refreshLoop`,
  `refreshDue`, `refreshBackoffUntil`, `refreshWake` and the early-abort go. Suite
  1847/1847.

  **The plan's proof line was wrong, and the correction is the stage's real content.**
  It said a connector 429 "backs off `conn:<p>` through the pool (`throttled` already
  fires — assert `free` reaches 0)". `throttled` is the pacing bucket's learned penalty:
  it halves the provider's RATE and never touches the pool, so nothing zeroed `free` on a
  429 and the assertion would have asserted something nothing did. The pool backoff had
  to be added, and where it went decided what it covers:

  1. **At the wire, not in the kind.** In `callProvider`'s give-up path, beside where
     `withRetry` already tells the bucket — so every connector caller tells the pool:
     the fetch leg, refresh, ingest, prefetch, a route. Put in the refresh kind's `run`
     instead, a fetch-leg 429 on the same provider would have paused nothing. This is
     the connector wire's own precedent (`throttled` lives there) rather than the AI
     wire's (where each kind classifies its own failures), because the connector wire
     already classifies.
  2. **What qualifies is a split the old sweep never made.** It had ONE lane-wide timer
     that any throw tripped — a 404 for a delisted coin stalled every provider's
     entities for a minute, which is exactly the verify step's complaint. Now: **the
     provider is unwell** — a 429 it gave up retrying, a 5xx, no status at all (a
     timeout, a socket error) — backs off `conn:<p>` for a minute and the loop stops
     sizing work for it; **this entity is wrong** — 404, 400, the rest of 4xx — moves
     that entity's `refresh_at` a minute out and nothing else. 401 stays out for
     `throttled`'s reason: a bad key is not unwell, and pausing claims for it pins the
     pause. Only the GIVE-UP backs off, so a 429 that recovered on its retry pauses
     nothing. Verified to fail without it.
  3. **Refresh was already counted at the wire and now shares the fetch leg's slots.**
     `refresh()` → `tracked` → `callProvider` → `poolWait`, so `run` holds nothing (the
     no-double-wait rule). Up to `free(conn:<p>)` refreshes run at once per provider
     where the old sweep did one entity at a time, and they draw on the same three
     slots as fetches. One quota; the bucket still paces.
  4. **A refresh can create tag work, and a kind's settle wakes only its own set.**
     `retag_on_refresh` → `requeueItemForTag` → `pending`. The old loop called
     `wakeAll()` after every pass; the kind cannot share the legs' set (its ids are
     ENTITY ids, and `recoverStuck` would read them as item ids), so `run` calls
     `wakeAll()` when `refreshDueEntity` reports `requeued` — one line, precise where
     the loop was a blanket. `wakeAll` became a `let` bound after the loop exists, the
     shape every `*Wake` in this file already had, rather than leaning on the fact that
     a `const` declared one statement later is initialized by the time any `run` fires.
  5. **The `rows.length > 1` prefetch guard moved inside `prefetchDueRefreshes`, per
     connector group.** A one-id warm is a metered batch call spent on one id. The loop
     calls `prep` whenever units exist, so the guard had to survive; per group rather
     than per batch means one crypto entity due beside nineteen stocks no longer costs
     the stocks their warm. `prep` goes through `callProvider`, so it is the first `prep`
     that contends for the resource its units will use — it waits for a slot inside the
     tick if the fetch leg holds all three, which is bounded, not a deadlock (the units
     hold nothing yet), and is what the old sweep did too.
  6. **The unit already carries the board.** `dueLiveEntities` returns `{ entity, inst,
     board }` with `id` and `mapping` on the board — all the connector branch of
     `boardResource` reads — so `resourceOf` costs no query. It uses the leg name
     `refresh`, its own cache slot, rather than borrowing `fetch`'s: a Map entry, and it
     does not lie.

  *Proof, green:* liveness (drives `refreshDueEntity` directly and never the sweep, so it
  did not move), connectors, faces, board-pause, ingest-connector. *Proof, new:* an
  in-flight entity is withheld; a retry-exhausted 429, a 5xx and a status-less failure
  each zero `free(conn:<p>)` while a 404, a 401 and a recovered 429 leave it alone.
  *Verify in the real app:* a crypto board holding one delisted coin — the rest refresh
  on cadence instead of stalling a minute per tick. *Untouched:* `refreshDueEntity`'s
  body, `withRetry`, the bucket penalty.

- **Second pass on Stage 5 (2026-09-21) — it found a defect the stage had shipped.**
  Suite 1848/1848.

  **`boardResource(db, "refresh", board)` returned null, always, and silently.** The
  function branched on a hand-kept deny-list of the connector legs —
  `if (leg !== "face" && leg !== "fetch")` — so `refresh`, added months after that list
  was written, fell through to the capability branch, asked `resolveCapability` for a
  capability named "refresh", and got back the `if (!cap) return null` that guards
  unknown ids. Null means UNCONSTRAINED, so the refresh kind launched every due entity
  every tick and never read the pool — which means the `conn:` backoff this very stage
  added at the wire was inert for the one sweep it was added for. The stage's headline
  claim was false on arrival.

  **Why the stage's own tests missed it.** They proved the two halves separately and
  neither drove the sweep: `liveness.test.js` calls `refreshDueEntity` directly, and the
  new wire test asserts `free()` reaches zero at `callProvider`. Nothing asserted the
  thing in between — that the KIND names a resource at all. The missing assertion is one
  line (`boardResource(db, "refresh", board)` is `conn:…`, and equals the fetch leg's
  answer for the same board, since that is the shared-quota claim). Written first,
  watched fail, then fixed.

  **The fix is to stop keeping the list.** The branch now asks `CAPABILITY[leg]`: a leg
  whose name is a capability id resolves through one, everything else is connector work.
  Derived from the registry, so the discriminator cannot drift from the thing it
  discriminates — and a seventh leg lands in the right branch without anyone remembering
  this function exists. Same instinct as the board-duplicate arc and the `IN_FLIGHT_FOR`
  derivations: the list that has to be edited in two places is the bug.

  **Also this pass:** `wakeAll`'s forward declaration moved from beside `inFlight` (130
  lines from its assignment) to directly above `runKinds`, with the reason it is a `let`
  written where it is read; and the maintenance loop's header comment, which still
  described embedding and refresh as loops "below", now names what is actually left.

- **Stage 6 — Ingest. ✅ DONE (2026-09-21), in the two steps the close read asked for.**
  Suite 1849/1849.

  **6-pre — one single-flight, not three.** The plan's pre-step was already done on the
  connector side (`windowFlights` in connector.js, with a test) and NOT on the file side:
  `files.js` had the same window cache and no flight, so two S3 boards on one connection
  due together would each have listed the whole bucket and raced to write one key —
  unreachable while the sweep was sequential, reachable the moment it is not. The FMP
  screener carried a third copy. Lifted into `singleFlight(flights, key, walk)` in
  window-cache.js, used by connector.js and files.js; FMP's copy is left, because it
  clears on failure only and replaces its whole cache on success — different enough that
  forcing it in is churn, and it is noted at the helper.

  *The proof took three tries, and the reason is worth keeping.* The first version
  released the gate before the first caller had reached `list`, so its walk finished
  before the second arrived — alone, the second then hit the 60-second window cache
  (one listing, for the wrong reason); in the file, an earlier test had disabled that
  cache, so it walked. The test was measuring the cache, not the flight. The second
  version failed on the plugin DEFS memo: `pluginInstalled` asks `getPluginDef`, which is
  memoized, and `registerSource` alone does not refresh it — the real loader calls
  `resetDefs()` beside every register, and a test that skips that inherits whatever an
  earlier test built. The third starts the second caller only once the first is provably
  INSIDE the held-open listing (a signal from `list`), and asserts the two got the SAME
  result object — which only joining the flight can produce, since a cache read hands
  back a fresh copy. Its one clock (the second caller's single db read before the
  flight) fails safe: a second listing fails the test, never passes it.

  **6 — the kind.** `dueIngestBoards` gains `limit` and `excludeIds` (and, now that a
  tick takes a batch, an order: soonest-due first); the per-board body is `ingestBoard(b)`
  verbatim — re-indented by two, so read that diff with `-w` — and `run` calls it;
  `ingestLoop`, `ingestWake`, `draining` and the early poll go.

  1. **`resourceOf` costs nothing and file feeds get no `src:` class.**
     `resolveIngestAdapter` and `boardResource`'s connector branch read the same field
     (`mapping.input.connector`), so `boardResource(db, "ingest", b)` names `conn:<p>` for
     a feed and null for a file board with no new code — and with the Stage-5 fix the
     branch is chosen by the capability registry, so `ingest` lands right without anyone
     adding it to a list. The plan wanted `src:<kind>:<root|host|bucket>` for files. What
     would it bound? A folder scan contends for disk, which nothing in the pool models;
     an S3 listing for a bucket that handles concurrency fine and is now single-flighted
     per connection besides. A class at the permissive default bounding nothing real is
     the dead-knob smell. Null, with the 3b rule applied: a file scan is I/O plus a
     bounded admit loop, and today's sweep already ran every due board in one pass.
  2. **`exclude` is a correctness requirement, for the third time.** A board's stamp
     moves only when its run SETTLES, so a board mid-run is still due; a kind would have
     started a second run under the same fence, and both would have passed the gate.
     "Run now" mid-run is unchanged: the route re-stamps, the run in flight fails its
     gate and stops, the board stays excluded until it returns, the next tick takes it
     up under the new stamp.
  3. **Drain-fast is the settle-wake.** A draining board settles with `next_run_at =
     now`, is due again immediately, and its own settle wakes the kind. The plan's
     "`draining` returned as `{ more }`" predates 3a. The drain tests (a run cap of 2,
     forcing multi-tick drains) pass unchanged.
  4. **Admissions are claimable rows, and the wake is in a `finally`** — the refresh
     rule again, and in a finally so a run that admitted and then failed to settle still
     hands its rows on. `added` is hoisted out of the try for that reason.
  5. **Stage 5's wire backoff reaches feeds for free, and it is new behaviour.** A catalog
     walk that gets a retry-exhausted 429 or a 5xx now pauses claims for that provider
     for a minute, while file boards and other providers' feeds carry on; before, only the
     per-board 5-minute retry fired. Correct, unplanned, and part of the real-app check.
  6. **Cancel-A-leaves-B is structural.** Each run carries its own fence; cancelling one
     re-stamps one board. Covered by cancel-queued.test.js already; no concurrency test
     was added for a property the code cannot get wrong.

  *Proof, green:* all ten ingest-*.test.js (161 across the affected files), cancel-queued,
  liveness. *Proof, new:* two callers on one remote connection share one listing and one
  result object (fails without the flight); a board mid-run is withheld; a feed board's
  ingest resource equals its fetch and refresh resource; a file board's is null.
  *Observed, not caused:* one Playwright welcome test timed out once under the full
  suite's parallel load and passed alone and on the rerun — the same fifteen-second
  `waitForURL` the file has always had. *Verify in the real app:* a folder board and a
  connector board both "Run now" — two `running` rows in the Jobs modal at once, both
  progressing. *Untouched:* the run body, admission order, the cancel gate, the ledger,
  the job-log folding.

- **Second pass on Stage 6 (2026-09-21).** Suite unchanged. The Stage-5 pass found a
  defect; this one found none, and the checks it ran are worth writing down as the
  checklist for a moved body:

  1. **Could a throw in the new `finally` be swallowed?** The loop contains every `run`,
     so a `ReferenceError` from `wakeAll()` (a `let` declared 900 lines below the
     function that calls it) would have been LOGGED, not raised — and the sweep tests
     assert on database state, so they would have stayed green with the wake dead.
     Checked by grepping the sweep suite's output for any contained error: none.
     `ingestBoard` is a hoisted declaration but is only ever invoked from the kind's
     `run`, which cannot fire before `runKinds`, which is after the `let`.
  2. **Does the moved body still describe the loop it left?** Seven comment lines said
     "tick" or "this loop" in the worker-loop sense — "the stamp this tick claimed",
     "not this loop's", "re-fetched on every single tick" — and now say run, invocation
     or scan. Two "flat tick"s stay: that is the job-log arc's own term for a scheduled
     scan that did nothing, not a reference to the loop.
  3. **Does the new order starve anyone?** `dueIngestBoards` gained `ORDER BY
     ingest_next_run_at ASC` with its limit. A draining board re-stamps itself to NOW,
     which is newer than every other due board's stamp, so it queues BEHIND them — a
     long drain cannot crowd out a board that was due before it. Before, the sequential
     pass ran every due board so the question never arose; with a batch it does, and the
     order answers it the right way for free.
  4. **Do the two defaults disagree?** `dueIngestBoards` defaults `limit` to 20 for
     direct callers; the kind sets none, so the loop passes its own 8. Not a bug — the
     20 only ever reaches the tests — but a reader could take it for the sweep's batch.
     Left, and said here.

- **Stage 7 — Diagnose. ✅ DONE (2026-09-21) — and it was not registration only.**
  Suite 1850/1850. The last hand-written loop is gone; ten kinds run on the resource
  loop and `maintainLoop` is the only loop left in the worker.

  **The poll was doing a second job the plan did not see.** The generated loop re-ticks
  200 ms after any tick that launched and on every settle; `pollMs` applies only after
  an IDLE tick. For a kind that rotates to a new board each call, that would walk the
  whole install as fast as calls settle — every unstable facet diagnosed in a burst on a
  key tagging shares, and the settle-gate rollups (`candidates()` across up to eight
  boards) run once per settled call instead of once a minute. Same total spend (each
  question is answered once and capped), arriving all at once. The worker's own comment
  said the slow cadence existed for the rollup cost; its EFFECT was also a spend pace.
  Fix, in the kind: `due` opens once per poll — a time check, no query while closed, so
  the re-ticks and wakes fall through to `pollMs` for free. Today's pacing, preserved,
  with no contract change. The gate is three lines of arithmetic inside the closure and
  has no cheap removal test; it is asserted by reading, and said so here.

  **The split had to cut `diagnoseFacet` in two, not just export it.** Its first half
  decides whether a facet has a question worth paying for (the ranking query, the cap,
  the stored verdict, the resolved key); its second half pays. `diagnoseDue` interleaved
  check and act across boards in one pass, stopping at the first board where a call
  actually happened — so a board whose unstable facets were all already diagnosed was
  walked past in the same breath. A kind whose `due` yielded "the first board with
  candidates" and left the skips to `run` would have handed such a board out, discovered
  the skips one facet at a time, and advanced the cursor one board per POLL: a retag's
  re-staled facet fifteen boards along would wait fifteen minutes to be noticed. So
  `diagnoseQuestion` (the check) and `diagnoseAnswer` (the pay) are separate functions;
  `diagnoseCandidates(db, deps, afterBoardId, exclude)` walks to the first board with a
  real QUESTION and hands out units that carry the question they were checked against;
  `diagnoseDue` is the composition, unchanged for its seventeen direct callers. One
  behaviour differs from the old loop, deliberately and shared between the one-shot and
  the kind: a board whose every attempt FAILED ends the pass and the next poll moves on,
  where the old loop tried the next board in the same breath — under a provider outage,
  one board's worth of failed calls per pass rather than eight.

  **"The per-board `FOR UPDATE` already pins the write" — there is no `FOR UPDATE`.**
  `setFacetDiagnostic` is a single-statement `facet_diagnostics = facet_diagnostics ||
  jsonb_build_object(key, …)`, which is the same guarantee for this purpose: one UPDATE
  merges one key atomically under the row lock the statement itself takes, so a board's
  facets answered in parallel cannot clobber each other. The plan should say what the
  code does.

  **The rest.** The resource is the board's tag key (`boardResourceFor(db, "tag", …)`) —
  the same string `deps.resolveAi` resolves inside the answer — and it is already counted
  at the wire (`trackedTagger` → `viaKey`), so `run` holds nothing. Unit identity is
  `board:facet`, and `exclude` is passed into the walk so a slow call is not asked
  twice. Two comments said the settle gate was "ten minutes wide"; `SETTLE_MS` is 180
  seconds. The per-facet catch moved from the loop into the resource loop's containment.

  *Proof, green:* facet-diagnose (56, the seventeen one-shot callers and the
  worker-driven test at `DIAGNOSE_POLL_MS=50` untouched). *Proof, new:*
  `diagnoseCandidates` hands out a real question with its resolved key, withholds a
  facet in flight (fails without the exclusion), and walks past an already-diagnosed
  board inside one call. *Verify in the real app:* the one visible change — a board
  with two or more unstable facets shows two `diagnose` rows running at once in the
  Jobs modal. *Untouched:* the settle gate, the cursor, the prompt, the ledger writes.

- **Stage 8 — Extract becomes three legs. Independent; only when measured.** Two new
  legs in `IN_FLIGHT_FOR` (claim, recover, cancel, and `TAG_QUEUE` derive themselves),
  two arms in `routingCase` (text before model, detect after), `STATUS_PRIORITY`, the
  client's status vocabulary (public/ reads statuses — a browser-suite change), the
  jobs-modal kinds. *Trigger:* the job log showing extract legs holding a key slot
  while waiting on the extractor (`started_at` → first call). *Proof:* extraction,
  detect, derived-identity, cancel-queued, browser status pills. *Verify:* a PDF
  board's item visibly walks text → extract → detect. *Untouched until then.*

### Still deferred (carried from worker-rework Stage 4)

TPM-aware pacing; multiple sidecar processes; a multi-process worker via a DB lease —
the concurrent-claim test in "Found along the way" says the claim is already safe for
that last one.

### Config surface

No new knob names. `AI_INFLIGHT` and `FETCH_CONCURRENCY` become per-class ceilings under
the names they have; `EXTRACT_CONCURRENCY` and `FACE_CONCURRENCY` turn out to bound nothing
once the lanes go and are deleted in 3b rather than left reading like live tuning. A per-resource
override, if it is ever wanted, rides the Plugins-page config the way rpm/burst do —
not env, and not before someone asks.

### Where the deep dive's serialization list stands after each stage

After 2: AI by key ✓, fetch by connector ✓, the dispatcher's four-lanes-in-sequence ✓.
After 3–5: transcribe, webhooks, embed groups, refresh entities and its early-abort ✓.
After 6: feeds per board ✓. Never: admissions inside one feed run, and the first vote
alone — both deliberate (Layer 2).

## Layer 7 — code (not started)

The stages above, in order, one commit each.

## Found along the way — not part of this arc, but real

**A leg can crash the process.** All four leg catch blocks call `failOrRequeue`
unguarded (worker.js:2306, :2697, :2743, :2801). If that DB write throws, the throw
escapes the catch, the pipeline promise rejects, and nothing handles it — `fillLane`
attaches only `.finally`, `Promise.all([...pipelines])` runs only in `stop()`, and
there is no `process.on("unhandledRejection")` anywhere. Confirmed: the shape exits 1
under Node 22. Reachable on a Postgres restart (leg fails + DB write fails together).
Blast radius is a container restart, not data loss (`recoverStuck` picks the rows up).
Two lines and a test; do it before touching `fillLane`.

**`STEP` is the one hand-written copy of the leg map.** worker.js:2807 mirrors
`IN_FLIGHT_FOR`'s four values by hand; db.js derives five spellings from the map and
exports `IN_FLIGHT_STATES`, which worker.js doesn't import. If they ever disagree,
`STEP[row.status]` is undefined, the TypeError fires after `ln.take()` and
`inFlight.add()` but before `.finally` attaches: the lane slot leaks permanently and
the id stays in `inFlight` forever, so `recoverStuck` skips that row for the life of
the process.

**Verified safe: concurrent claims.** The outer UPDATE in `claimFairBatch` has no
status predicate, so a concurrent committed claim between the statement snapshot and
the lock looked like a double-claim. Reproduced on a throwaway DB with a `pg_sleep`
stall inside `ready`: worker B claims and commits at t=0.7 s, worker A's statement
completes at t=2 s and returns zero rows. Postgres' EvalPlanQual re-check drops it.
Safe for multiple replicas, not just by single-process luck.

**Cosmetic:** `hasDefault` starts `false` and is set by the maintain loop, so the very
first dispatch pass skips AI-stage claims for boards without their own key. Heals
in ≤ 3 s, fails closed.

`planning/worker-queue-holes.md` (2026-07-12) is fully closed — items 1–10 shipped,
only the note-only minors in #11 remain.
