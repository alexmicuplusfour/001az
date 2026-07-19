# The worker rework — per-resource lanes + board fairness ("the right way") (2026-07-19)

The end state we've been circling: a worker where **each work type runs at its own natural
capacity**, AI concurrency is governed by the **real per-key rate limits we already built**
(not the arbitrary `4`), pacing happens **off the critical path**, and work is claimed in
**board-fair order**. This is the substrate the original goal (fairness across boards) rides on.

**Consolidates the former `worker-pools-plan.md` and `board-fair-queue-plan.md`** (now removed) —
both are folded in here as stages, updated for what we've since learned.

## What's already in place (the substrate this consumes)

- **Per-key AI rate limiting is DONE** (`ai-provider-rate-limiting-plan.md`, slices 1–2):
  `paceAi` → `acquire` token bucket keyed per API key, limits declared+required per provider and
  grounded in real numbers, editable in the Plugins UI, read at the call sites via `aiRate`.
  This rework **reuses that as-is** — the AI lane's rate governor is the bucket we shipped, no new
  rate machinery.
- **Write fences (§7) are DONE:** `markTagged/markExtracted/advanceFaced` are value-fenced to their
  in-flight status. That's the precondition that makes concurrency safe; a month ago it wasn't true.

## Why pools BEFORE fairness (the concrete reason)

Doing fairness on today's single-flight tick would make things *worse*, not better. The review of
the shipped rate limiting found: a drained bucket makes `acquire` **sleep inside the single-flight
tick** (Gemini free = 10 rpm → ~6 s, serialized across a same-key batch → the tick blocks many
seconds, stalling every other board + the sweeps). A fair batch *mixes boards into one tick*, so
every board would inherit that stall. **Lanes move pacing off the critical path first**, so a
provider's pace-sleep occupies only its own AI slot — then fairness rides on top without inheriting
the stall. That's why the order is pools → fairness, not the reverse.

## The resource model (what actually has finite capacity)

| Resource | Real cap | Governor after the rework |
|---|---|---|
| **AI key** (tag + extract + provider-embed/transcribe) | provider RPM/TPM per key + a memory/cost fuse | the shipped **rate bucket** (per key) **+** an **in-flight cap** (memory/cost) |
| **Extractor sidecar** (PDF, hot path) | single-threaded ≈ 1 | `EXTRACT_CONCURRENCY` (default = replicas) |
| **Local embedder / whisper** | CPU / on-device | their own small caps; keyless, no rate |
| Postgres / worker CPU | ample | — |

The `4` dies by splitting into **two orthogonal, principled governors**: *rate* (starts/min — the
provider's real limit, already built) and *in-flight* (simultaneous requests — a memory/cost fuse).
Neither is a single global magic number, and the extractor gets its own, different cap.

## Design: continuous lanes + a fair dispatcher

Replace the single-flight `tick()` claim-and-`Promise.all` with a **dispatcher** that launches work
continuously, bounded by **per-resource semaphores**, never by one global count.

- **Semaphores (the lanes):**
  - `aiSem[keyId]` — max in-flight AI calls per key (the memory/cost fuse; the *rate* is the shipped
    bucket, acquired inside the call). Distinct keys → distinct fuses.
  - `sidecarSem` — max in-flight extractor calls (`EXTRACT_CONCURRENCY`, ≈1).
  - `embedSem`, and transcription (already its own loop).
- **The dispatcher loop:** while total in-flight < a global bound *and* the fair queue has claimable
  work whose resource has room, claim the next fair item and **launch its pipeline without awaiting**
  (fire-and-track in an `inFlight` Set), then continue. Await only when everything is full; wake on
  any completion (the existing `wake` pattern).
- **An item's pipeline hops resources by phase** (one async function, no re-queue between phases):
  ```
  extract item:  [sidecarSem] documentTextFor()  →  [aiSem[key]] record_fields  →  markExtracted
  tag item:                                          [aiSem[key]] record_tags    →  markTagged
  face item:     [connector bucket] render                                       →  advanceFaced
  ```
  So the single-threaded sidecar runs exactly one doc at a time while that item's *AI* call competes
  in the shared AI lane alongside tagging — the extraction/tagging slot-stealing (§10) is gone by
  construction, and `paceAi`'s sleep now happens **inside `aiSem`**, not in a shared tick.

### Extraction split (the one real refactor)

`extractOne` today does sidecar-fetch → AI-call inline in one slot. Split it so the sidecar phase
holds only `sidecarSem` and the AI phase holds only `aiSem[key]`. Everything downstream
(`markExtracted`, identity/merge) is unchanged.

## The hard parts (correctness — this is where the plan earns its keep)

1. **`recoverStuck` must not reclaim a live in-flight row (Stage 0, prerequisite).** Today it's safe
   only because it runs at tick-top with nothing in flight. Under continuous lanes it could "recover"
   a healthy long call (research tagging minutes; sidecar 240 s) → re-claim → double bill (§7: "a
   status-VALUE fence is not ownership"). **Fix (single process):** an in-memory `Set` of claimed
   item ids; `recoverStuck` excludes it (`AND NOT (id = ANY($inFlight))`); raise `STUCK_MS` well above
   worst-case call duration as defense in depth. This IS the "claim token, brought forward" — in
   memory, no schema change. Nothing else in the rework is safe without it, so it ships first.
2. **Fairness in a continuous dispatcher must not collapse to FIFO.** Claiming one row at a time and
   recomputing `board_rank` collapses to oldest-first (the board-fair-plan insight). The fix composes
   naturally with the dispatcher: when AI capacity frees for K items, **claim a fair batch of K in one
   snapshot** (`row_number() OVER (PARTITION BY board_id ORDER BY created_at)`, ordered
   `board_rank, created_at`). "Claim to fill free capacity" *is* a batch, so fairness holds for
   `active_boards ≤ capacity` and degrades to FIFO beyond (no worse than today). `claimNextWork`
   becomes `claimFairBatch(db, {stages, limit})`; the `LIMIT 1` wrapper keeps existing tests green.
3. **Write fences stay correct.** Atomic claim (status flip + `SKIP LOCKED`) means two lanes can't
   double-claim; the fences discard any stale stamp. With (1) covering recovery, no new hole opens.
4. **Single-process only.** The in-memory `inFlight` set is single-process ownership. True scale-out
   needs a DB lease/heartbeat — explicitly out of scope (Stage 4).

## Stages (each independently shippable; stop anywhere)

- **Stage 0 — Recovery ownership. ✅ DONE.** In-memory `inFlight` set + `recoverStuck` exclusion.
  Zero behavior change today; the invariant the lanes stand on. (Did NOT raise `STUCK_MS` as the
  sketch suggested — the ownership set is the real protection, and a higher value would only slow
  crash/deploy recovery.)
- **Stage 1 — Per-resource lanes, continuous. ✅ DONE.** Single-flight tick → a dispatcher that
  launches work bounded by per-resource lane counters (AI / extract / face) + a separate maintenance
  loop; `paceAi` now sleeps inside its lane slot (in-tick-sleep stall fixed). Retired the `4` →
  `AI_INFLIGHT` / `EXTRACT_CONCURRENCY` / `FACE_CONCURRENCY`. Shipped simpler than the sketch: a
  GLOBAL AI lane (not per-key `aiSem[key]`) and `extractOne` kept whole (sidecar + AI in one lane) —
  both moved to Stage 4 as refinements.
- **Stage 2 — Board-fair claim ordering (THE ORIGINAL GOAL). ✅ DONE.** `claimFairBatch` ranks each
  board's ready items by age and serves rank-0 of every board first, claimed as one snapshot batch
  per lane (single-row claims collapse to FIFO); `claimNextWork` is the LIMIT-1 wrapper. Fairness
  holds while active boards ≤ lane size, degrades to FIFO beyond.
- **Stage 3 — Embedding + throughput sweeps into lanes.** Move `embedDue`/`refreshDue` off the
  coordination tick into `embedSem`/their own bounded loops; only cheap coordination
  (`recoverStuck`, `retagDue` scheduling, `ingestDue`, prune) stays on a light scheduler tick.
- **Stage 4 — Defer:** per-key AI lanes (`aiSem[key]` — full cross-board isolation when a slow
  provider's paced items hog the global AI lane); the `extractOne` sidecar/AI split (its AI call
  joins the shared AI lane); TPM-aware pacing (the real ceiling for big-input tagging — Anthropic
  Start is 1,000 RPM but 2M ITPM); multiple sidecar processes (PyMuPDF isn't thread-safe → processes,
  not threads); multi-process worker via a DB lease.

Stopping after Stage 2 achieves the original intention *the right way*: the `4` is gone, each type
runs at its own capacity, pacing is off the critical path, and boards are treated fairly.

## Config surface (retire the `4`)

- Drop `TAG_CONCURRENCY` (keep as a deprecated alias → `AI_INFLIGHT`).
- `AI_INFLIGHT` (per-key in-flight fuse; memory/cost, default ~6–8), `EXTRACT_CONCURRENCY` (=sidecar
  replicas, default 1), `EMBED_CONCURRENCY` (default 1), higher `STUCK_MS` default.
- Rate limits are already a config surface (Plugins UI + descriptors) — unchanged.
- Compose passthrough for the new knobs (the §5 lesson: unreachable knobs are dead knobs).

## Tests

- **Stage 0:** `recoverStuck` skips an id in the in-flight set even past `STUCK_MS` (the no-double-
  claim invariant everything rests on).
- **Stage 1:** `sidecarSem`/`aiSem` never exceed their size under a flood (counting-stub); a Gemini-
  rate pace-sleep on key A does not delay a key-B call (the stall fix); extraction flows
  sidecar→AI→`markExtracted`, and a sidecar failure retries without ever making the AI call.
- **Stage 2:** the two-board interleave (small board's items claim ahead of a large board's backlog);
  single board stays strict FIFO; the `LIMIT 1` wrapper still returns the globally-oldest row.
- **Stage 3:** a slow embed batch no longer blocks tag claims.
- **Throughout:** `startWorker`/`stop` stay the public surface; existing queue/retry/fence tests green;
  drain awaits all lanes.

## What this replaced (former plans, now removed)

- **worker-pools** — its lane model + recoverStuck-ownership + extraction split are Stages 0–1/3
  here, updated to consume the now-built rate limiting and to fix the in-tick-sleep stall.
- **board-fair-queue** — its batch-claim fairness is Stage 2 here, now feeding the AI lane instead
  of a `Promise.all` batch.
