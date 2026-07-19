# Smart worker pools — per-resource concurrency (2026-07-19)

Retire the single `TAG_CONCURRENCY=4`. Replace one global counter with a budget per
**real resource**, so tagging, extraction, and embedding each run at their own natural
capacity instead of sharing (and wasting) one magic number.

Composes with `board-fair-queue-plan.md`: that plan sets the *order* work is claimed
(round-robin across boards); this plan sets the *width* (how much of each type runs at
once). Together they resolve the open item from that plan — "decouple claim-width from
execution-concurrency." Supersedes the `4` assumption throughout.

## Why `4` is the wrong shape

- **Provenance:** git `5d6c28a` (2026-07-05, "Tag images concurrently in the worker") —
  introduced when the worker *only* tagged images. The name `TAG_CONCURRENCY` is the
  fossil. It predates the extract stage, the face stage, and the unified queue. The value
  was never derived from anything.
- **It's the only throttle on AI calls.** `PROVIDERS` (providers.js) has no rpm/tpm
  metadata; the token bucket in `connectors/runtime.js` is connector-only. So `4` is
  silently acting as a rate limiter it was never designed to be — and doing it uniformly
  across work types with wildly different bottlenecks.
- **It's wasted on extraction.** 4 concurrent `extractOne`s funnel into one single-threaded
  PyMuPDF sidecar; 3 queue (§10). Real extraction concurrency is ~1.
- **It's a memory ceiling.** Peak memory scales with it (parallel base64 PDFs, image
  loads; `sharp.concurrency(1)` is the sibling discipline). ~40 MB/item worst case (§4).
- **It conflates unrelated resources into one knob** — the core defect.

## The resource model (what actually has finite capacity)

| Resource | Nature | Real cap | Today |
|---|---|---|---|
| **AI key** (tag + extract + provider-embed calls) | network; provider RPM/TPM **per key** | provider limit per key; a cost/mem fuse | shares the global 4 |
| **Extractor sidecar** (PDF, hot path) | single-threaded HTTP service | = # replicas (**1**) | shares the global 4 (3 wasted) |
| **Local embedder** (ONNX) | CPU / libuv | ~1–2 | batch sweep, 1 call/tick |
| **Transcriber sidecar** | single-threaded | = # replicas (1) | own loop already ✓ |
| **docx worker pool** | worker_threads | `DOCX_WORKERS` (1) | separate, at **ingest** ✓ |
| Postgres / worker CPU | — | ample | — |

Punchline: the three the user named map to three *different* bottlenecks — **tagging** is
gated by the provider key (high, parallel), **extraction** by the sidecar (≈1), **embedding**
by a batch call / CPU. One number cannot be right for all three.

## Design: lanes bounded per resource

Each work type runs in its own **bounded pool**, sized to its resource. A pool is the
`docx-pool.js` shape: a semaphore + a queue + a pump that launches while capacity and work
both exist. Concretely:

- **AI pool**, keyed per API key: `aiSem[keyId]` (max in-flight) **and** a per-key token
  bucket (starts/min). A board with its own key gets its own budget; boards on the default
  key share one. This is where "4" is replaced by something principled — and where per-board
  fairness (the sister plan) applies, because contention is per key.
- **Extractor pool:** `sidecarSem`, size = `EXTRACT_CONCURRENCY` (default = sidecar
  replicas = 1–2). Only the **sidecar fetch phase** occupies it.
- **Embed pool:** `embedSem` (default 1), its own loop like transcription — a slow embed
  batch never blocks claims again.
- **Transcription:** already a separate loop; leave it (optionally re-express as a pool for
  symmetry).

### Extraction is two-phase (the key refactor)

`extractOne` today does *sidecar fetch → AI call* inline in one slot. Split it:

```
pending_extract → [sidecarSem] documentTextFor()  → [aiSem[key]] record_fields → markExtracted
```

The sidecar phase holds only `sidecarSem` (≈1); the AI phase holds only `aiSem[key]` (wide).
Result: extraction saturates the sidecar with exactly one in-flight doc while its AI calls
run in the shared AI pool alongside tagging — no stage steals the other's slots. This is the
"full advantage of extracting" the brief asks for: the sidecar is the limit, so run it flat
out at 1 and stop pretending 4.

### Claiming must be capacity-aware

The dispatcher claims *the next ready item whose resource has room*. If `sidecarSem` is full,
it must still be able to claim `pending`/`pending_face` work. So the claim takes the set of
currently-claimable stages: `claimNextWork(db, { stages, hasDefault })` — e.g. drop
`pending_extract` from `stages` when the sidecar pool is saturated. (Board-fair ordering from
the sister plan applies within the claim; batch size = free AI capacity.)

## The hard part: staying correct once lanes run concurrently

Single-flight is currently load-bearing for correctness (§7). Moving to concurrent pools is
safe **only** if we preserve these invariants:

1. **`recoverStuck` must not reclaim a live in-flight row.** Today it's safe because it runs
   at tick-top with nothing in flight; research tagging (minutes) and OCR (240 s) exceed
   `STUCK_MS` (3 min), so concurrent recovery would "recover" healthy rows → re-claim → double
   bill (§7's "a status-VALUE fence is not ownership"). **Fix (single process):** keep an
   in-memory `Set` of claimed item ids; add on claim, remove on settle; `recoverStuck` excludes
   it (`AND NOT (id = ANY($inFlight))`). This *is* the "claim token brought forward" the audit
   anticipated — realized in memory, no schema change. Also raise `STUCK_MS` default well above
   worst-case call duration as defense in depth (it now only ever catches genuine crash/drain
   debris). **Prerequisite for any concurrency (Stage 0).**
2. **Write fences (§7) stay correct.** `markTagged/markExtracted/advanceFaced` are already
   value-fenced to their in-flight status; atomic claim (status flip + `SKIP LOCKED`) means two
   pools can't double-claim. With (1) handling recovery, no new hole opens. ✓
3. **Pacing sleeps stop wedging everything.** The token bucket's Retry-After sleeps currently
   block the whole single-flight tick (runtime.js comment). Under lanes they block only their own
   lane — a strict improvement — so the "don't honor a long Retry-After here" caution can relax
   (though keep the 30 s cap; long waits still belong to `retry_at`).
4. **Drain/shutdown:** `stop()` awaits all pools (it already awaits loop + transcribeLoop). More
   in-flight work = more to drain, but each pool is bounded, so drain stays bounded. The 5 s
   deploy cap / re-bill window (§4) is unchanged in kind — note only.
5. **Multi-process is still out of scope.** The in-memory in-flight set is single-process
   ownership. True scale-out needs a DB lease/heartbeat (§7); explicitly deferred.

## Primitives to build / reuse

- **Generalize the token bucket:** lift `acquire`/`withRetry` out of `connectors/runtime.js`
  into a shared module and key it per **AI key** too. Add optional `rpm`/`burst` (later `tpm`)
  to `PROVIDERS` descriptors (and per-key override), defaulting to a conservative rate when
  unknown. Connectors keep their existing behavior.
- **A tiny `Pool(size)`** (semaphore + queue + pump), mirroring `docx-pool.js`. Reused for
  `sidecarSem`, `embedSem`, and `aiSem[key]` (size from key/provider config).
- **Dispatcher loop** replacing the claim-and-`Promise.all` in `tick()`: launch-without-await,
  track in `inFlight`, wake on completion (the existing `wake` pattern). Cheap coordination
  sweeps (`recoverStuck`, `retagDue`, `refreshDue`, `ingestDue`, `pruneSnapshots`) stay on a
  light scheduler tick — they're not throughput work.

## Rollout in stages (each independently shippable)

- **Stage 0 — recovery ownership.** In-memory `inFlight` set; `recoverStuck` excludes it; raise
  `STUCK_MS`. Small, no behavior change yet, unblocks all concurrency. *(Also correct to land
  even if we stop here.)*
- **Stage 1 — safe partial: per-type sub-caps within single-flight.** Keep the single-flight
  tick, but claim a wider batch and cap sub-types inside it: ≤ `EXTRACT_CONCURRENCY` sidecar
  items, up to `AI_CONCURRENCY` AI items. Kills the wasted-sidecar-slots problem and lets tagging
  run wide **without** true concurrency (recoverStuck still runs with nothing in flight → Stage 0
  not strictly required yet). **Limitation:** the tick still awaits its slowest member, so a
  3-minute research tag idles the other slots until it returns. A safe stepping stone, not the
  full win.
- **Stage 2 — the real win: continuous per-resource lanes.** Dispatcher + `aiSem`/`sidecarSem`,
  launch-as-slots-free (no straggler gating). Requires Stage 0. Split `extractOne` into the
  two-phase pipeline. This is where utilization actually maxes out per resource.
- **Stage 3 — per-key AI budgets + move embedding to its own lane.** Token bucket per key from
  config; `embedDue` becomes an `embedSem` loop off the coordination tick. Per-board fairness
  now attaches to each key pool.
- **Stage 4 — defer:** TPM-awareness, sidecar replicas (multiple PyMuPDF processes — not threads,
  PyMuPDF isn't thread-safe per §5), multi-process DB lease.

Stopping after Stage 1 already retires the `4` (it becomes `AI_CONCURRENCY` + `EXTRACT_CONCURRENCY`)
and fixes the sidecar waste at low risk. Stages 2–3 are the "full advantage" the brief wants.

## Config surface

Retire `TAG_CONCURRENCY`; introduce per-resource knobs (keep `TAG_CONCURRENCY` as a deprecated
alias → `AI_CONCURRENCY` so live deploys don't break):

- `AI_CONCURRENCY` (default ~6–8; a cost/memory fuse, not the provider's true limit)
- `EXTRACT_CONCURRENCY` (default 1 = sidecar replicas)
- `EMBED_CONCURRENCY` (default 1)
- optional `PROVIDERS[p].rpm/burst` (+ per-key override) — the principled AI cap; conservative
  default when unset
- raise `STUCK_MS` default (e.g. 10–15 min, above worst-case call duration)

All must be threaded through compose + `.env.example` (the §5 lesson: knobs unreachable in the
stack are dead knobs — the compose passthrough is part of the work, not an afterthought).

## Trade-offs / risks

- **Complexity in the most money-sensitive code.** The whole reason to stage it and to make
  Stage 0 (ownership) explicit. The §7 fences already landed, which is what makes this tractable
  now and wasn't true a month ago.
- **RPM vs TPM.** LLM limits are often token-bound; a request/concurrency cap can still blow a
  TPM ceiling on big document-block calls. Concurrency + RPM is a fine first cut; TPM-awareness is
  Stage 4. Note it, don't block on it.
- **Cost fuse.** A per-key concurrency cap also bounds runaway spend (a 1000-item retag can't fire
  1000 parallel calls). Keep a sane default cap even if the provider could absorb more.
- **Prompt-cache locality.** Interleaving boards across the AI pool trims provider prompt-cache
  reuse slightly (sister-plan note). Verify whether `providers.js` even sets `cache_control`
  before counting this; pennies at this scale regardless.
- **Utilization vs safety.** Stage 1 is safe-but-straggler-gated; Stage 2 is full-utilization-but-
  concurrent. Sequence deliberately.

## Tests

- **Stage 0:** `recoverStuck` skips an id in the in-flight set even past `STUCK_MS` (pins the
  no-double-claim invariant that everything else rests on).
- **Per-type caps:** with `EXTRACT_CONCURRENCY=1`, two `pending_extract` items never hit the
  sidecar concurrently while `pending` tags run in parallel (stub the sidecar to count concurrent
  callers).
- **Pool bounds:** `aiSem`/`sidecarSem` never exceed their size under a flood (max-observed-
  concurrency assertion via a counting stub).
- **Two-phase extraction:** an item flows sidecar→AI→`markExtracted`; a sidecar failure retries
  without ever making the AI call; fences still discard a stale stamp on a re-routed row.
- **End-to-end loop:** `startWorker`/`stop` unchanged as the public surface; the existing
  queue.test.js loop test still passes; drain awaits all pools.
- **Fairness composition:** sister-plan's two-board interleave still holds when the batch width is
  "free AI capacity" instead of a constant.

## Open decisions

1. How far this turn — Stage 0+1 (safe, retires `4`, low risk) or commit to the full lane system
   (Stages 0–3)?
2. Confirm single-process is the target (in-memory ownership) vs designing the DB lease now for
   future scale-out.
3. Add real per-provider rate-limit config now (Stage 3) or ship concurrency caps first and derive
   rates later from observed 429s.
