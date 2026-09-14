# First-class work — every lane visible on the wire (2026-09-14)

Self-contained for a fresh session. Written after a deep dive spanning the
worker's lane architecture, the job log, the client poll/reconcile loop, the
jobs chip, and the jobs modal.

## The complaint

A running transcription doesn't light the jobs chip. The board sits there
doing minutes of real work — claiming clips, holding a sidecar job open,
landing transcripts — and the toolbar says nothing is happening.

## Why: the app has two representations of in-flight work, and only one is on the wire

**Per-item pipeline legs** (tag / extract / face / fetch) live in
`items.status`. The delta poll streams items, so the client sees this half
for free: the chip counts `ACTIVE`/`QUEUED` statuses
([toolbar.js:173](../public/toolbar.js#L173),
[data.js:42-43](../public/data.js#L42)), `needsPoll()`/`moving()` key the
poll cadence off the same sets ([data.js:46-60](../public/data.js#L46)), and
the modal's Live section renders the same rows. These legs deliberately write
no `running` job-log rows — [worker.js:2150-2153](../server/worker.js#L2150):
"visible via items.status while in flight."

**Lane jobs** (sweeps and runs) live *only* in `job_log` rows with
`outcome='running'`. Transcription says it outright
([worker.js:1161-1163](../server/worker.js#L1161)): "A `running` job-log row
is the only place 'transcribing now' exists — this sweep has no items.status
leg." Ingest runs are the same
([worker.js:1985-1990](../server/worker.js#L1985)). The only reader of those
rows is the jobs modal's own 5s fetch (`listRunningJobs` via
`GET /api/boards/:id/jobs`) — the chip, the poll cadence, and every other
surface are blind to them. The chip's comment even documents the scoping:
"Sweep jobs the client can't see (a transcription, an ingest run) live
inside the modal" ([toolbar.js:146](../public/toolbar.js#L146)).

The blindness compounds: because `needsPoll()` only reads item statuses, a
transcription-only stretch drops the delta poll to 30s or **stops it
entirely** (`pollDelay()` → 0, [data.js:290-297](../public/data.js#L290)).
The transcript's landing then doesn't even reach an open tab.

### The full lane census

| lane | running row? | items.status leg? | visible anywhere while running? |
|---|---|---|---|
| tag/extract/face/fetch legs | no (by design) | yes | yes — chip, grid, modal |
| transcribe | yes, per attempt | no | modal only, while open |
| ingest run | yes, per run | admitted items appear after | modal only, while open |
| retag pass | no — settled row at end (instant: it just queues) | queued items appear | effectively yes |
| cancel | no — settled row (instant) | n/a | n/a |
| embed sweep | **no rows at all** except failures | no | **nowhere** |
| diagnose pass | **settled rows only** | no | **nowhere** |
| refresh tick | none (kept out of job_log for volume) | no | nowhere — see honest gap below |

Two more constraints that make `running` rows trustworthy as a registry:
the boot sweep stamps orphaned rows `interrupted`
([db.js:2916-2922](../server/db.js#L2916)), and the transcribe loop chains
clips at a 200ms gap ([worker.js:2958](../server/worker.js#L2958)) so a
draining queue is one continuous busy stretch, not a flicker.

One subtlety: on an auto-tagging board a fresh audio upload sits at
`pending` while its tag leg waits for the transcript (the `noCount` gate,
[worker.js:1550-1561](../server/worker.js#L1550)) — so *that* path lights
the chip today, via the waiting item. The dark cases are exactly the ones
with no status leg: held boards, manual boards, already-tagged clips,
engine-arrival backfills.

## The model

One principle: **all in-flight work on a board is client-visible state,
streamed on the board's heartbeat, and it drives the chip, the modal, and
the poll cadence uniformly.**

The two server-side representations stay — each is the natural bookkeeping
for its shape of work (per-item queue state vs lane runs), and forcing
either into the other's shape would be duplicate truth. What unifies is the
**wire contract**: a `work` payload that carries the lane half, next to the
items that already carry the pipeline half.

```
work = {
  running: [ { id, kind, label, target, item_id, entity_display, started_at } ],
  queued:  [ { kind, label, n } ],
}
```

- `running` — `listRunningJobs` rows, plus a `label` from `KIND_DEFS` so the
  payload is self-describing (the standing rule: clients render labels from
  the server's vocabulary, never a client-side list).
- `queued` — per-lane backlog counts for work **invisible to items.status**:
  clips awaiting transcription, items awaiting embedding. Counted only when
  the lane is actually served (an engine resolves) — a backlog nothing will
  ever claim is a configuration gap, not work happening, and the chip must
  not glow forever over it. Counts exclude items already visible as
  in-flight statuses and items already in `running` — one unit of work, one
  count, no double-billing.

### Registry completeness (server)

- transcribe ✓, ingest ✓ already write running rows.
- **diagnose**: restructure to open a running row at pass start and stamp it
  at the end (today both call sites write settled rows only,
  [facet-diagnosis.js:591,674](../server/facet-diagnosis.js#L591)). A pass
  is a paid AI call taking seconds-to-minutes; it earns the same in-flight
  presence as a transcription.
- **embed**: represented by its queue count, not running rows — a batch is
  seconds with 200ms gaps, below the heartbeat's resolution; the honest
  visible fact is "N items awaiting embedding" draining toward zero. The
  count mirrors `itemsNeedingEmbedding`'s predicate
  ([db.js:3187](../server/db.js#L3187)) via a shared SQL fragment so the
  count and the claim can never drift.
- transcribe queue likewise shares its predicate with
  `oneAudioNeedingTranscription` ([db.js:3225](../server/db.js#L3225)).
- Pause: counts stay when a board is paused (the queue is intact — the
  chip's existing paused grammar shows a frozen count saying "waiting"),
  running rows stay until the running job finishes (pause gates claims, not
  work already in the air) — both match the semantics the chip and modal
  already speak.

### Honest gap: refresh ticks

A connector refresh tick is a sub-second-to-seconds call on its own
cadence, deliberately kept out of job_log for volume. A tick shorter than
the heartbeat cannot be represented by the heartbeat; its "coming" time is
already on the modal's scheduled strip. Left out, stated here. If a
long-drain refresh batch ever becomes a felt gap, it gets a running row per
*drain* (open while `refreshDue` reports more), not per tick.

### Transport

Three carriers, ONE composer (`workFor(boardId, board?)` in server.js), so
`state.work` holds one row shape whichever carrier wrote it last:

1. **`GET /api/items` (delta poll)** — the `since` branch and the first
   page both carry `work`. The first page matters: opening a board
   mid-transcription must ignite the chip on boot, not 20s later.
2. **`GET /api/boards/:id/jobs/errors` (signals' 20s tick)** — carries
   `work`. This is the **discovery channel**: a sweep starting server-side
   on an idle board (scheduled retag, unpause, engine arrival) reaches the
   client within one signals tick, which then wakes the fast poll — the
   same transition pattern alerts already use. While the modal is open the
   signals tick stands down (existing rule) and the modal's own fetch is
   the writer — one writer at a time, preserved.
3. **`GET /api/boards/:id/jobs` (modal)** — serves the same `work` payload
   in place of its old top-level `running`; the modal renders Live from
   the shared state its own fetch just wrote, so the chip and an open
   modal can never disagree.

The composer's pieces sit at their natural depths: worker.js's
`servedBacklogLanes` owns the lane registry and the served verdicts
(memoized ~5s per board — the verdicts are configuration, and a resolution
is a walk of settings reads that must not run per 4s tick per tab); db.js's
`boardLaneQueues` takes `[{ kind, model? }]` and applies the in-flight and
running-row exclusions uniformly in one loop, with each lane's predicate
(`LANE_NEED`) shared with its claim query. Adding a backlog lane = one line
in each. The open/stamp lifecycle every lane job uses is one helper too —
db.js `openJob` → `{ id, settle }`: both writes ride `jobLogWrite`,
`settle` is idempotent and degrades to writing a settled row when the open
was lost, and transcribe, ingest, and diagnose all sit on it.

### Client

- `state.work = { running: [], queued: [] }`, written through ONE setter
  (data.js `setWork`) by every carrier — the delta poll, the signals tick,
  the modal's fetch — so the wake-the-poll rising edge is free wherever the
  payload lands. Last-write-wins is safe: all copies of the same server
  truth, no acknowledge semantics (unlike `failed_at`).
- **Cadence** ([data.js](../public/data.js)): a running row is work MOVING —
  it holds the 4s poll open, paused board included (pause gates claims, not
  the job in the air), so the transcript lands live. A backlog with nothing
  running is work WAITING and drains at sweep pace (one clip at a time,
  minutes each) — it holds the 30s tier instead of spinning the fast poll
  behind a lane backoff, and the running row a claim produces promotes the
  cadence the moment work moves. Everything drained → poll winds down, chip
  cools through the existing ignite/cool machinery untouched.
- **Chip** ([toolbar.js](../public/toolbar.js)): count = in-flight items
  + running rows (minus rows whose `item_id` is already a visible in-flight
  item — the auto-tag-board case where the same clip is both a waiting
  `pending` item and the transcribe lane's running row) + queued lane
  counts. Tooltip names the lanes from their served labels
  ("Transcription: 1 running, 3 waiting") in the existing notes grammar.
- **Modal**: Live section adds a lane-backlog note per nonzero queue
  ("3 waiting — Transcription"), mirroring the existing "…and N more
  queued" note.

## Stages

1. **Server model** — shared SQL fragments for the two lane predicates;
   `transcribeQueueCount` / `embedQueueCount` in db.js; `label` on running
   rows; diagnose running rows; `workFor()` composer in server.js.
2. **Transport** — `work` on the three carriers.
3. **Client** — `state.work`, cadence, chip, modal.
4. **Tests** — queue-count gating (served/unserved, pause, in-flight
   exclusion, running exclusion), endpoint payload shapes, `pollDelay`
   with lane work, diagnose row lifecycle.
