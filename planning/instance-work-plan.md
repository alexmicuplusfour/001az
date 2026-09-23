# Instance work — the jobs log counts what actually runs (2026-09-23)

**Status: D1 decided — Shape B (user, 2026-09-23). Stages 1+2+3 BUILT,
uncommitted (ledgers below; unit 1882/1882, browser 52/52). Stage 3's second
pass found P1/P2/P4 and they are built; P3 stays unbuilt by its own finding.
Stage 4 VERIFIED in the real app 2026-09-23 (chip 33 ms / 23 instances /
rows by file name / upload mirror on a throwaway board). Next: ONE commit
for the whole arc.** Close read of each stage before
building, as every stage.

## The complaint

On the emma board, Reprocess from the board modal's "cards were generated
from the old key" toast ran 23 extractions and 23 taggings with the jobs chip
dark and the modal saying "Nothing in flight." When the chip did light it
said 2. History named all 46 rows "emma watson" / "emma roberts" — no file
names anywhere. Two runs in the log, 17:54:28 and 17:57:40 UTC, 43 seconds
each, identical shape.

The user's ruling: instances are first-class citizens in the jobs log. Not a
poll-start patch.

## What the code does today (deep dive 2026-09-23)

The app keeps in-flight work in two representations, and only one of them
reaches the jobs log at instance grain:

- **Pipeline legs** (fetch / face / extract / tag) live in `items.status`.
  They reach the client INSIDE CARDS: `listItems` folds every instance's
  status into one `aggregateStatus` per entity (db.js:160, priority list —
  any in-flight instance makes the whole card in-flight). The chip counts
  cards (toolbar.js:191), the modal's In progress lists cards
  (jobs-modal.js `liveItemRow`), the poll cadence reads cards
  (`needsPoll`/`moving`). The per-instance statuses DO travel
  (`item.instances[].status`, `instanceEntry`), but nothing in the jobs log
  reads them.
- **Lane work** (transcribe, ingest, diagnose runs; transcribe and embed
  backlogs) lives in the `work` payload — planning/first-class-work-plan.md.
  That plan deliberately left the pipeline half out of `work` "because the
  delta poll already streams items". It does — as cards.
- **History** is instance-grained already: one `job_log` row per leg attempt
  (worker.js `legLog`), `item_id` set, `target` = the original filename.

Three consequences, all visible in the two screenshots:

1. **Discovery.** A pipeline start the client did not mirror itself is
   invisible until a LANE signal happens. The board reprocess route answers
   `{ok, queued}` — no routed report — so `app:board-reprocessed` →
   `ensurePolling()` → `pollDelay()` reads unchanged client state → 0 → no
   poll. The first server-side signal is the embed backlog after the first
   tagged item (17:54:51 for a 17:54:28 click), seen by the 20 s signals
   tick or the modal's 5 s refresh, then 4 s to the first delta. Extraction
   is invisible by construction. Same family, same hole: a scheduled retag
   on an idle tab, another admin's retag or reprocess, an unpause from
   another tab. The SSE channel does not cover admin routes either (no
   `touchedBoard`), and the worker never emits.
2. **Grain.** Two cards, 23 instances: the chip says 2, the toast said
   "Reprocessing 23 items…", the lane counts ("1 waiting — Embedding") are
   already per instance. The chip mixes units.
3. **Labels.** `pick` (server.js:1255) and the row renderers prefer the
   entity display name over `target`, so a derived board's rows all read
   the same name. On a raw board display is null and the file shows — which
   is why nobody noticed.

## The model

**A unit of work is one instance attempt.** Everything the jobs log shows
— the chip's count, the In progress rows, the History rows — is instance
grained, and it comes from ONE place.

### D1 — where the pipeline half lives on the wire (decided: B, 2026-09-23)

**Shape B (recommended): `work` carries all of it.** The pipeline legs join
the `work` payload as lanes, derived from `items.status` at read time,
nothing written twice:

- `running` gains one row per ACTIVE instance (fetching / facing /
  extracting / processing): `kind` = the leg's job kind (fetch / face /
  extract / tag — already in KIND_DEFS, already what History wears),
  `target` = the original filename, `item_id`, `entity_id`,
  `entity_display`, `started_at` = the claim stamp (`claimFairBatch`
  writes `updated_at` on claim, db.js:2874). `id` null: these are not
  job_log rows.
- `queued` gains one count per leg from the pending statuses, under the
  SAME exclusions `boardLaneQueues` already applies (item ids with a
  running job_log row are not counted twice — the clip held at `pending`
  while it transcribes). One unit of work, one count, decided server-side
  in one function.
- The chip and the modal read `state.work` ONLY. The client-side dedup
  (`busyIds`), `liveItemRow`, `STATUS_LABELS`-by-status, `QUEUED_SHOWN` go.
  Cards keep their statuses for the grid's spinners; that is a different
  view and stays as it is.
- The signals tick becomes a COMPLETE discovery channel: any pipeline
  start on this board, from anywhere, lights the chip within one tick and
  `setWork`'s rising edge wakes the poll. Every route a GALLERY surface
  calls to start work answers `work` — the board reprocess and, per the
  Stage 2 close read (G1), the nine per-card/instance routes through one
  responder (F4: retag/tag-held stay out, their caller is the admin page)
  — and a click lights the chip in the same render.

Why B: it makes first-class-work's own principle literally true ("all
in-flight work on a board is client-visible state, streamed on the board's
heartbeat, driving the chip, the modal and the poll cadence uniformly");
it deletes a merge and a dedup rule instead of adding one; the chip, the
modal and History cannot disagree about what a job is, because they read
one vocabulary from one payload.

Cost of B: two more queries per work read (a GROUP BY over the board's
in-flight statuses; a select of ACTIVE rows joined to entities). Both hit
`idx_items_status` / `idx_items_board`. ACTIVE rows are bounded by claims
(pool free slots + ALLOWANCE per tick; 23 observed at once on emma), so the
row list is tens, not thousands. Measured on `ui` (4681 instances, F6):
0.07 ms and 0.15 ms, both on `idx_items_status`. No wire cap.

**Shape A (smaller): keep the client mirror, change the grain.** The modal
lists `state.items[].instances` in flight, the chip counts instance ids,
labels put `target` first, and the board route answers the routed report
the entity route already answers, carried on the event so data.js applies
it the way `requeue()` does. No wire change. Keeps the two-source merge and
the discovery hole (1) for every start that is not this click.

### D2 — queued instances: named or counted

Today In progress names up to 20 queued cards in FIFO order so "the next
one up sits under the ones being worked". Under B, waiting instances are a
count per leg ("18 waiting — Extraction"), the grammar the lane notes
already use; History names each one as it runs. Recommended: counts. A
queue position is not work happening. If names are wanted, the server can
carry the first few per leg (`next: [target…]`) — one more field, no
client list — but it is machinery for a nicety.

### D3 — the cancel gate

"Cancel queued" reaches pipeline queues and the feed run, not the
transcribe/embed backlogs. The client must not carry a list of which kinds
are legs. The server marks pipeline lanes (`leg: true`) — a stated fact on
the payload — and the modal gates on it: `anythingQueued` = feed running ||
a leg lane is queued; `abortOffered` = a leg row is running && the newest
cancel row left work finishing; "Abort — N left" = leg running + leg
queued.

### D4 — labels

A row names its instance first and its card second, when the two differ:
`2jNX7ZT.jpg · emma watson`. Raw boards: display is null, the file alone,
exactly today. Connector boards (F3): a vehicle's target is its identity
(`snyr`) and its display the company name, so a fetch row reads
`snyr · Synergy CHC Corp.` — that is the vehicle. `entity_display` is the
display name ONLY (a card has a name of its own exactly when it has one —
every raw-board entity in the local data has none and a hex identity, every
derived and connector entity has one); `target` travels beside it; the
client composes. Applies to running rows and History.

## Wire shape

```
work = {
  running: [ { id, kind, label, target, item_id, entity_id, entity_display,
               started_at, detail? } ],       // job_log running rows + ACTIVE instances (id null)
  queued:  [ { kind, label, n, leg? } ],      // legs (leg: true) + transcribe/embed backlogs
}
```

Leg kinds come from one table beside `IN_FLIGHT_FOR` in db.js
(`pending → tag`, `pending_extract → extract`, `pending_face → face`,
`pending_fetch → fetch`), so a fifth leg reaches the wire by the same map
that gives it a claim.

## Client

- **toolbar.js** `jobsChip`: n = `work.running.length` + Σ `queued.n`.
  Tooltip keeps its per-lane sentences from the served labels; the items
  half and `busyIds` go.
- **jobs-modal.js**: In progress = `runningRow` for every running row (the
  status verb by kind — extracting, tagging, rendering chart, fetching
  data, transcribing, importing N of M — `runningStatus` grows four arms)
  + one note per queued lane. Cancel gate per D3. `liveItemRow`,
  `STATUS_LABELS`, `QUEUED_SHOWN` deleted.
- **data.js**: `pollDelay` unchanged in text — `workRunning()` is now true
  whenever a leg is claimed, `needsPoll()` still reads cards for the grid.
  The `app:board-reprocessed` listener applies the payload the event
  carries through `setWork` (rising edge → `ensurePolling`) and repaints.
  board-modal.js still imports nothing from data.js (boards/admin pages).
- **History rows**: D4.

## Server

- **db.js** `pipelineWork(db, boardId, excludeIds)` → `{ running, queued }`
  from the in-flight statuses, the leg-kind table, `boardLaneQueues`'s
  exclusion frame.
- **server.js** `workFor`: merge lanes, `leg: true`, one composer as
  before. `POST /api/admin/boards/:id/reprocess` answers `work` (F4:
  reprocess only). `entity_display` = display name only, on job rows,
  running rows and `pick` (F3).
- **capabilities.js**: nothing — fetch/face/extract/tag are already kinds.

## Stages

1. **Server** — as the close read's corrected build list (bottom):
   `LEG_KIND` + `pipelineWork` in db.js, the `workFor` merge with `leg:
   true`, display-only `entity_display` on job rows, running rows and
   `pick`, the reprocess route answering `work`. Proofs in
   first-class-work.test.js + job-log.test.js, each with its removal
   check. Tests only — the real-app look waits for Stage 2 (F1).
2. **Client** — as the Stage 2 close read's corrected build list (bottom,
   G1–G7): the nine per-card routes answer `work` through one responder;
   `workLegQueued()` on the fast tier; `requeue()`, bulk and the reprocess
   listener mirror `work`; the chip and the modal read `state.work` only;
   `labelFor` composes `target · display`; `runningStatus` by kind. Proofs
   per the list, each with its removal check. Ships in the SAME commit as
   Stage 1.
3. **Second pass** — fresh eyes on what shipped, no new scope.
4. **Real app, emma** — click Reprocess: chip reads 23 in the same
   render, In progress lists extracting rows by file name, History rows
   read "file · emma watson". Then `ui` (4681): a retag's chip count and
   the work read's timing.

## Not doing

- No `running` job_log rows for legs. The ledger's rule stands: legs are
  visible via status and write one settled row per attempt. `work` DERIVES
  from status; nothing is written twice.
- No client-side list of pipeline kinds (D3).
- No change to the grid's spinners, the in-progress lane, or
  `applyRoutedEntities` for the entity routes.
- No SSE emit for admin routes. B makes the signals tick sufficient; the
  events channel stays for settled-board changes, as its header says.

## Open for the close read

- `moving()` / `needsPoll()` still read cards. With `work.running` covering
  every claimed leg, `needsPoll()` could read `work` too and the cards'
  statuses would be the grid's alone. Decide there, not here.
- ~~The wire cap on `running`~~ — settled, none (F6).
- Observed on emma, out of scope: 23 rows claimed into `extracting` at
  once against a pool of 8 (durations grow 5.8 s → 20.6 s in waves — the
  calls queued inside `run`). The claim step sizes by `free(r)` before the
  acquire that decrements it. Belongs to queue-by-resource, noted here so
  it is not lost.

## Stage 1 close read (2026-09-23)

Read against the real code and the local database. Findings ranked by how
much they change the build; each is what the plan assumed vs what the code
does.

### Findings that change the build

- **F1 — Stages 1 and 2 are one commit.** The plan treated the server
  stage as shippable alone. The old chip adds every queued lane's `n` to
  its card count and dedups running rows by `entity_id`
  (toolbar.js:189-204): pipeline running rows carry the card's id and
  dedup away, pipeline queued counts ADD. Stage 1 alone makes emma read
  2 + 18 = 20. Stage 1 proves itself in tests; the real-app look waits for
  Stage 2, as card-key's Stages 1+2 did.
- **F2 — the running-row exclusion is load-bearing.** The plan said a
  claimed row and a running transcribe row never overlap. They do: the tag
  and extract legs CLAIM an audio row and only then find the transcript
  missing (worker.js:1744-1749, 1797-1800), throw a no-count wait, and
  requeue it. A clip mid-transcription cycles claimed → waiting → claimed,
  and for a moment is both `processing` and the transcribe lane's running
  row. Pipeline running rows exclude running-row item ids — the same frame
  `boardLaneQueues` uses for its counts. One rule, both lists. Proof: seed
  exactly that overlap, assert one row and no tag-lane count.
- **F3 — card names: the honest rule is simpler than D4.** Local data, 11
  boards: every raw-board entity (ui, wardrobe, logos, boats, transcriber
  test) has `display_name` NULL and `identity` = the stored hex filename;
  every derived (cars, emma, invoice, resumes) and connector (stocks,
  crypto) entity has a display name. So "a card has a name of its own
  exactly when `display_name` is set" holds without exception. The server
  fold `display || target || identity` exists only to keep the hex off
  screen (job-log.test.js:854-866 pins that). Amendment: `entity_display`
  = `display_name` only, on job rows and running rows; `target` stays the
  file; the client composes `target · display` when both exist and differ
  (Stage 2). The old client's own `display || target` fallback renders
  identically meanwhile, so the server can change now; the test at
  job-log.test.js:865-866 moves its assertion from `entity_display` to
  `target`. Refresh rows (entity-scoped, no target) keep `display ||
  identity`. D4's connector clause was wrong: a vehicle's target is its
  identity (`snyr`), its display the company name, so a fetch row will
  read `snyr · Synergy CHC Corp.`. That is the vehicle; accept.
- **F4 — only the reprocess route answers `work`.** Retag and tag-held
  are called from admin-boards.js alone (admin page: no chip, no
  `state.work`); the payload would be dropped. Reprocess is the one
  board-wide start fired from a page that can be the gallery. Retag joins
  when it has a gallery caller.
- **F5 — the click's cadence (Stage 2 amendment).** At response time the
  worker has not claimed yet, so the payload is queued-only, and
  `pollDelay` puts queued-only work on the 30 s tier (data.js:326, built
  for lane backlogs draining at transcription pace); `ensurePolling` on
  the slow tier does not promote (data.js:393-404). The chip would read
  23 at once while the cards wait up to 30 s for a first delta. A queued
  LEG lane is fast-tier work — pipeline queues drain at claim pace — so
  the fast condition gains `workLegQueued()`, reading the `leg` flag D3
  adds; no client kind list. Paused boards keep the slow tier through the
  existing `!moving()` branch. This is `needsPoll` said from the server's
  payload instead of from the cards.

### Findings that settle open questions

- **F6 — no wire cap.** EXPLAIN ANALYZE on ui (4681 instances): the
  per-leg count 0.07 ms, the running-row select 0.15 ms, both on
  `idx_items_status`. A 4681-row retag walks 4681 index entries — low
  milliseconds. Running rows are bounded by claims. Stage 4 records one
  measurement during a real retag; nothing is built for it.
- **F7 — keyless boards, known-open, inherited.** `claimFairBatch` skips
  `pending`/`pending_extract` on a board with no key and no default
  (db.js:2880). Today's chip glows for those rows anyway (cards pending);
  under B they read "N waiting — Tagging". Not a regression, not honest
  either. The honest gate is the claim query's own key condition, and
  `hasDefaultKey` is a worker-side fact; it belongs in `servedBacklogLanes`
  the way transcribe/embed do, one line each once a default-key read is
  reachable from server.js. Not this arc. Recorded here.
- **F8 — leg kinds need a four-entry table.** `pending → processing` is
  the tag leg; the other three follow `pending_<x> → <x>ing`. `LEG_KIND`
  sits beside `IN_FLIGHT_FOR` in db.js, keyed by the wait state; a fifth
  leg edits the two lines that give it a claim. Labels stay in
  capabilities.js — fetch/face/extract/tag are already kinds.
- **F9 — `started_at` is the claim stamp, and only the claim writes it.**
  `claimFairBatch` sets `updated_at` (db.js:2896-2897); landings move the
  row to its next wait state before their stamp; `recoverStuck` requeues.
  "for 12s" means "claimed 12 s ago", which on emma includes queueing
  behind the pool (23 claimed, 8 in the air). Honest at the vocabulary's
  level; the over-claim is queue-by-resource's.

### Confirmations

- Classify mode: one row per instance under its first card
  (`entity_ids[1]`, as `legLog` already does). One attempt, one row.
- Abort moves claimed rows to tagged/held (db.js:2343-2345): they leave
  the list while the cancel row says "N discarding". Same as the cards.
- Paused: counts stay (the claim gate holds the rows), running rows
  finish. The existing chip grammar for paused applies unchanged.
- Every carrier goes through `workFor` (server.js:1286, 1352, 3164, 3182);
  one merge covers all four, and the reprocess route makes five.
- `id: null` on synthesized rows: nothing reads `id` on a running row.

### Stage 1, corrected build list

1. db.js: `LEG_KIND` beside `IN_FLIGHT_FOR`; `pipelineWork(db, boardId,
   excludeIds)` → running rows (ACTIVE minus excludeIds, LEFT JOIN
   entities for `display_name`, `target` = COALESCE(original_name,
   identity), `started_at` = `updated_at`, oldest first) + queued counts
   per leg (wait states minus excludeIds; held/tagged/failed never).
2. server.js `workFor`: running = job rows ∪ pipeline rows by
   `started_at`; queued = legs (`leg: true`, pipeline order fetch, face,
   extract, tag) then lanes; labels via `capabilityLabel`;
   `entity_display` = display name only, on both row kinds and in `pick`.
3. `POST /api/admin/boards/:id/reprocess` answers `{ ok, queued, work }`.
4. Proofs: (a) a claimed extract row and a claimed tag row appear as
   running rows with kind, label, file, display name, claim stamp;
   pending rows count per leg with `leg: true`; held/tagged/failed do
   not; (b) F2's overlap counts once; (c) the three carriers and the
   reprocess response agree; (d) display-only `entity_display` with
   `target` beside it — the hex test moves. Removal checks: drop the
   merge → (a) fails; drop the exclusion → (b) counts two; drop `leg` →
   the flag assertion fails.

Stage 2 carries F1 (one commit), F3 (client composes labels), F5
(`workLegQueued` on the fast tier).

## Build ledger

**Stage 1 — built 2026-09-23, uncommitted.** As the close read's corrected
list, with one decision made while building.

- db.js: `LEG_KIND` in pipeline order and `ACTIVE_KIND` derived from it,
  beside `IN_FLIGHT_FOR`; `pipelineWork(db, boardId, excludeIds)` after
  `boardLaneQueues` — two queries in parallel, `started_at` = the row's
  `updated_at`, `id: null`, `target` = COALESCE(original_name, identity),
  `entity_display` = the first card's display name.
- server.js: `workFor` merges — `running` = job rows ∪ leg rows sorted by
  `started_at`; `queued` = legs first, then lanes; `entity_display` is the
  display name only, in `workFor` and in `pick`; the reprocess route
  answers `{ ok, queued, work }`.
- **Decision while building:** `leg: true` rides the RUNNING leg rows too,
  not only the queued lanes. D3's abort gate reads "a leg row is running",
  and `id: null` alone would have been an implicit marker. One flag, both
  halves.
- Proofs: first-class-work.test.js +3 — the shape (one row per claimed
  state wearing its kind and file, the named card's display beside it,
  `started_at` = claim stamp, one count per waiting leg in pipeline order,
  held/tagged/failed absent); the overlap (a `processing` clip with a
  running transcribe row is one record, no tag-lane count); the carriers
  (delta poll, signals tick, jobs page all carry the leg lane marked `leg`
  and the claimed row marked `leg`, and the reprocess answer carries the
  queue it filled). job-log.test.js: the hex-identity test now asserts
  `target` carries the file and `entity_display` is null. 35/35 across the
  two files.
- Removal checks, each restored byte-for-byte after:
  - R1 drop the merge in `workFor` → the carriers test fails (1 of 6).
  - R2 drop the running-row exclusion in `pipelineWork` (parameter kept
    typed) → the overlap test fails (1 of 6).
  - R3 drop `leg: true` on queued legs → the carriers test fails (1 of 6).
  - R4 restore the old fold in `pick` → the /jobs page test fails (1 of
    29).
  - R5 drop the tag leg from `LEG_KIND` → the shape test and the carriers
    test fail (2 of 6).
- Full unit suite: 1865/1865 after one amendment — card-key's Stage 5
  test (derived-identity.test.js:607) pinned the reprocess answer as
  exactly `{ ok, queued }`; it now asserts the two fields and the `work`
  the answer carries (the stamped instance waits to extract, the unstamped
  one to tag — the route's own routing, read back through the wire).
  eslint clean on the changed files.
- Not done, by design (F1): no real-app look until Stage 2 lands in the
  same commit — the old chip would count cards plus the leg lanes.

**Stage 2 — built 2026-09-23, uncommitted.** As the close read's corrected
list (G1–G7), with two things found while building.

- server.js: `answerRouted(req, res, affected, extra)` — the nine
  per-card/instance routes answer `{ ok, entities, work, ...extra }`. The
  tag-edit route rides too: a tag edit creates embed work.
- data.js: `workLegQueued()`; `pollDelay`'s fast tier reads the cards, the
  running rows and the leg lanes; `requeue()` mirrors `work` beside the
  routed report; the reprocess listener applies `detail.work` and then
  calls `ensurePolling()` itself. bulk.js mirrors per answer, last wins.
- board-modal.js: the event carries `work: r.work`.
- toolbar.js: `jobsChip` (exported for its test) counts
  `work.running.length + Σ queued.n`; the tooltip is the lanes' sentences;
  the ACTIVE/QUEUED import is gone.
- jobs-modal.js: `labelFor` (exported), `runningStatus` by kind, Live =
  running rows + one note per waiting lane, gate/count/abort from `work`
  (`legsLeft`); `liveItemRow`, `STATUS_LABELS`, `QUEUED_SHOWN` deleted;
  header rewritten.
- **Found while building 1:** a running row wears the payload's own
  `label`, with the vocabulary list as the fallback. The modal's test
  harness serves no kind vocabulary, and the badge read the raw id — a row
  that arrives with its label should not depend on a second list having
  loaded (the chip already reads the same field).
- **Found while building 2:** the poll timer. `setWork` wakes the poll, so
  a test that leaves work in state keeps the 4 s tick alive and the file
  never exits. work-cadence's own tests had always ended by draining — an
  implicit rule, now stated in the file; jobs-modal.test.js gets a
  file-level `after` that drains for the same reason.
- Proofs: jobs-chip.test.js (new, 3: the count is the payload, 23 on a
  two-card board; two cards in flight with no work is no count; a sweep
  row + a lane backlog + a leg lane read 7 with the lanes' sentences);
  jobs-modal.test.js (harness through WORK, +3: a claimed instance is a
  row with kind, file and card and a waiting leg is a count; cards alone
  show nothing; "Abort — 5 left" counts legs in instances);
  jobs-row.test.js (+6 for `labelFor` and the verbs; one obsolete
  assertion that a tag row says "running" moved to `diagnose`);
  work-cadence.test.js (+2: a leg lane is fast-tier and slow when paused;
  `requeue` mirrors the answer's work); board-modal-gate.test.js (the
  event carries the answer's work); first-class-work.test.js (+1: a
  per-card route answers `work`).
- Removal checks, each restored byte-for-byte after:
  - S1 `pollDelay` without the leg lane → the cadence test fails (1 of 4).
  - S2 the chip without the waiting lanes → two chip tests fail (2 of 3).
  - S3 the modal's gate blind to leg lanes → the leg-row test fails (1 of 6).
  - S4 `labelFor` with the old fold → the two composition tests fail (2 of
    24).
  - S5 the per-card routes without `work` → the per-card test fails (1 of 7).
  - S6 the event without the answer's work → the gate test fails (1 of 20).
  - S7 `requeue` without the mirror → the requeue test fails (1 of 5).
- Full unit suite: 1880/1880. Browser suite (real server, Playwright):
  52/52. eslint clean on every changed file.
- Next: Stage 3 (second pass), then Stage 4 on emma after a rebuild — the
  image builds the frontend itself (Dockerfile:34).

## Stage 2 close read (2026-09-23)

Read against the client code, the test harnesses and the routes the client
calls. Same format: what the plan assumed vs what the code does.

### Findings that change the build

- **G1 — per-card clicks would light the chip a poll LATE; the per-card
  routes answer `work` too.** The plan had the chip read `state.work` only
  and only the board reprocess answering `work` (F4). Code: the nine
  per-card / per-instance routes (server.js:3432-3567 — reprocess, retag,
  re-extract, the instance legs, the scoped retags) answer
  `{ ok, entities }` and `requeue()` (data.js:128) mirrors that into the
  CARDS instantly; nothing touches `state.work` until the next delta. So a
  card would spin at once while the chip waited up to 4 s — today it
  lights in the same render. F4's rule was too narrow: it is "every route
  a GALLERY surface calls to start work answers `work`" — reprocess AND
  the per-card family; retag/tag-held stay out because their caller is
  the admin page. Nine routes, no shared responder today, all under
  `requireEntityAccess`/`requireItemAccess` which already resolved the
  board (`req.entityBoardId` / `req.itemBoardId`): one small responder
  `answerRouted(req, res, affected, extra)` replaces nine identical lines
  and adds `work`. Client: `requeue()` calls `setWork(work)` beside
  `applyRoutedEntities`; bulk.js's fan-out (bulk.js:88-93) the same, last
  answer wins (setWork's own rule — every copy is the same server truth).
  Alternative considered: accept the ≤4 s lag. Rejected: "the answer to a
  click carries the work" is the one rule, and this is where it would have
  silently had an exception.
- **G2 — the cadence keeps BOTH readers, which resolves the open item.**
  Plan (open): could `needsPoll()` read `work` only? Code: the per-card
  mirror lands in cards, the board mirror lands in `work` (G1 makes both
  land in both, but the cards' copy is still the grid's). `pollDelay`'s
  fast tier reads cards (`needsPoll`) + `workRunning()` + the new
  `workLegQueued()` (F5). Two carriers for WHEN TO ASK, one payload for
  WHAT IS SHOWN. Test in work-cadence.test.js: a queued leg lane → 4000;
  paused → 30000 through the existing `!moving()` branch.
- **G3 — the modal's gate, count and abort read `state.work`, and the
  test harness's premise inverts.** `abortOffered` (jobs-modal.js:378),
  `anythingQueued` (392) and `inFlight` (569) read `state.items` with
  ACTIVE/QUEUED. They become: abort offered = a `leg` row is running &&
  the newest cancel row left work finishing; anything queued = feed
  running || a `leg` lane is queued; "Abort — N left" = leg rows running
  + Σ leg lanes. jobs-modal.test.js:26-28 says "state.items is where
  queued rows come from" — rewritten: the second test's
  `state.items = [{status: 'pending'}]` becomes
  `WORK.queued = [{ kind: "tag", n: 1, label: "Tagging", leg: true }]`.
  ACTIVE/QUEUED leave jobs-modal.js and toolbar.js (their only uses are
  the replaced ones; filters/grid/patterns keep theirs — the grid's
  spinners and pills are cards, by design).
- **G4 — one label helper, and it fixes a wart while there.** Two label
  sites today (jobRow :249, runningRow :296) with different fallbacks; a
  board-level row (retag, cancel, diagnose: no target, no entity) renders
  the literal "item " with nothing after it. `export const labelFor = (j)`
  — "Feed run" for ingest; else `target` and `entity_display` deduped,
  joined " · " (D4); else `item N` only when there IS an item id; else ""
  (a board row wears its kind badge). Pure, exported, tested: raw (file
  only), derived (`2jNX7ZT.jpg · emma watson`), connector (`snyr · Synergy
  CHC Corp.`), refresh (display only), board-level ("").
- **G5 — the chip test is feasible; export `jobsChip`.** toolbar.js has no
  test harness, and it is module-private (:180). Probed: it loads under
  jsdom-stub. Exported for the test the way jobs-modal.js exports
  `runningStatus`/`summaryFor`/`failureDrawn`. Test: two in-flight cards +
  work of 3 leg rows and a 20 lane → the count reads 23 and the title
  names the lanes; two in-flight cards and empty work → no count (the
  chip is the payload, not the cards).
- **G6 — the reprocess listener calls `ensurePolling()` itself.** Plan:
  "setWork's rising edge wakes the poll". Code: the edge fires only on
  none → some (data.js:70); right after any tagging an embed backlog is
  usually present, so there is no edge. The listener does
  `setWork(e.detail?.work); ensurePolling(); render` — with F5 `pollDelay`
  is 4000 and `ensurePolling` promotes a slow timer (data.js:400-404).
  `setWork(undefined)` is a no-op by design, which is also what a response
  without `work` (the gate test's mock, an older server) needs.
- **G7 — the gate test feeds `work` and listens for it.** Its mock
  (board-modal-gate.test.js:80-83) answers `{ ok, queued: 7 }`; it
  answers a `work` too and the test asserts the event's `detail.work`
  carries it, from a listener on `document` — the boards/admin pages have
  no data.js, so the dispatch is the contract there.

### Findings that settle details

- **G8 — `runningStatus` grows four verbs by kind** — extract
  "extracting", tag "tagging", face "rendering chart", fetch "fetching
  data" — the words STATUS_LABELS used, keyed by kind now; diagnose stays
  "running". `STATUS_LABELS`, `liveItemRow`, `QUEUED_SHOWN`, `busyIds`,
  `itemN` and the never-styled `job-outcome-queued`/`job-kind-queue`
  class names go; no CSS to delete (checked). The jobs-modal.js header
  and the chip's comment block (toolbar.js:180-188) are rewritten to say
  one payload.
- **G9 — queued rows are counted, not named (D2 stands).** The lane note
  grammar ("18 waiting — Extraction") already exists for the served
  lanes; the FIFO "next up" list goes with `liveItemRow`.
- **G10 — nothing else reads the live section.** No browser test touches
  it (grepped); `seenKinds` seeds History pills from running kinds as it
  does for transcribe today; `state.work`'s boot shape is right; events.js
  follows `pollDelay` so items events are skipped while the fast poll runs.
- **G11 — the real-app look needs the built frontend.** The compose image
  serves public/dist; Stage 4 runs `npm run build:frontend` (or the image
  build does) before the look, then the emma click and the ui retag.

### Stage 2, corrected build list

1. server.js: `answerRouted(req, res, affected, extra)` — the nine
   per-card/instance routes answer `{ ok, entities, work, ...extra }`.
2. data.js: `workLegQueued()`; `pollDelay` fast tier reads it; `requeue()`
   mirrors `work`; the reprocess listener applies `detail.work` and calls
   `ensurePolling()`. bulk.js mirrors `work` per answer.
3. board-modal.js: the event carries `work: r.work`.
4. toolbar.js: `jobsChip` counts `work.running.length + Σ queued.n`, notes
   from the lanes only, exported; ACTIVE/QUEUED import gone.
5. jobs-modal.js: `labelFor` (exported), `runningStatus` by kind, Live =
   running rows + lane notes, gate/count/abort from `work`, dead code out,
   header rewritten.
6. Proofs: work-cadence (leg lane fast/paused slow), jobs-modal (harness
   through WORK; gate + count from leg lanes; Live rows from leg rows),
   a jobs-chip test (count 23 vs cards 2; empty work → no count), a
   labelFor test (five shapes), gate test (event carries `work`), and a
   server test that a per-card route answers `work` (first-class-work or
   derived-identity). Removal checks per proof.
7. Ships with Stage 1 as one commit (F1).

## Stage 3 — second pass (2026-09-23)

Fresh-eyes re-read of everything Stages 1+2 shipped, no new scope. Three
findings and one tidy; the checklist of what came back clean is below.

### Found

- **P1 — upload and connector-add still light the chip a poll late. My own
  G1 rule, applied incompletely.** G1 says every route a GALLERY surface
  calls to start work answers `work`; I applied it to the nine
  per-card/instance routes and the board reprocess, and missed the two
  surfaces that MINT in-flight rows: `POST /api/upload` (ingest.js:125,
  answering `{ uploaded }` — upload.js `mergeUploadedRows` pushes them into
  state.items at `pending`/`pending_extract`) and the connector add
  (server.js:3690 — connector-browse.js unshifts the returned rows, which
  enter at `pending_fetch`). Both used to light the chip in the same render
  BECAUSE the chip read the cards; now the chip reads `work` alone, so it
  stays dark until the next delta poll — `ensurePolling()` schedules at
  4000 ms, so up to four seconds of a drop or an add looking idle. Not a
  correctness bug, and the grid shows its own placeholders and spinners
  throughout — but it is exactly the dishonesty this arc exists to remove,
  in the two places a NEW item appears rather than an existing one moves.
  Fix, same one-line shape as `requeue()`: both routes answer `work`
  through the composer, and their clients `setWork(answer.work)` beside the
  row merge they already do. Cost: one `workFor` per upload CHUNK (a 1000-
  file drop is ~50 chunks, next to 1000 file writes and thumbnails) — and
  see P2, which is the part that actually costs.
- **P2 — `workFor` on every click multiplies an UNINDEXED board scan.**
  `listRunningJobs` filters `board_id` + `outcome='running'`, and job_log
  carries no index for it: `idx_job_log_board` is (board_id, started_at
  DESC, id DESC) and `idx_job_log_failed` is partial on `outcome='failed'`.
  Measured on the local ledger (7208 rows): **Seq Scan, 4.3 ms**, growing
  linearly with the ledger for the life of the instance. That cost is
  PRE-EXISTING on every delta poll (4 s per open tab) and every signals
  tick — Stage 2 did not create it — but Stage 2 put it on every per-card
  click, and therefore on every item of a bulk fan-out: `doBulkReprocess`
  fires one POST per selected card in parallel, so a 500-card selection now
  runs 500 board-wide sequential scans whose payloads are all discarded but
  the last. A partial index `(board_id) WHERE outcome='running'` — the
  exact shape of the `idx_job_log_failed` beside it, so no new pattern —
  takes the same query to **0.105 ms** (measured inside a rolled-back
  transaction on the live DB; nothing left behind). One migration, and it
  pays back the poll cost too, which is the bigger number in aggregate.
  This is the honest correction to the "two more indexed queries" cost
  claim in D1: the two NEW queries are indeed sub-millisecond (F6), and the
  one they travel with is not.
- **P3 — F6 measured the query and not the RENDER.** "No wire cap" was the
  right answer for cost and the wrong question for length: `running` holds
  one row per simultaneously-claimed instance, and emma showed 23 claimed
  at once against a pool of 8 — the known over-claim (the claim step sizes
  by `free(r)` before the acquire that decrements it), which belongs to
  queue-by-resource and is out of scope here. So the list's length is
  bounded by that defect rather than by the pool, and deleting
  `QUEUED_SHOWN` removed the only thing that had ever capped this section.
  The old modal rendered ACTIVE rows uncapped too, so this is not a
  regression — but it is now instances rather than cards, which is the
  bigger number. Stage 4's `ui` retag is already the measurement that
  answers it. Do not add a cap before that number exists.
- **P4 (tidy) — two selects nothing reads.** `listJobLog` and
  `listRunningJobs` still `SELECT e.identity AS entity_identity`; with
  `pick` and `workFor` no longer folding it (F3), nothing on the wire reads
  either copy. `listRefreshHistory` still needs its own, on purpose. The
  column now survives in those two queries only because
  job-log.test.js:139 asserts it straight off the db function.

### Checked and clean

- **A stale payload cannot cross boards.** The chip is now 100% `state.work`,
  so this was the first thing looked for. The board switcher is a full
  navigation (`location.href = /?board=…`, toolbar.js:281), so `state.work`
  starts at its empty shape and boot seeds it from the first page; the one
  in-place path (app.js:115) is boot's own landing rule, before any fetch.
- **Both `/api/items` branches carry `work`** — the `since` delta and the
  first page; later keyset pages deliberately don't (one answer per load).
- **One writer, everywhere.** boot, delta poll, signals tick, the modal's
  fetch and its interval, `requeue`, bulk, the reprocess event — all
  through `setWork`. No second writer, and `setWork(undefined)` is a no-op,
  which is what an older server and the gate test's mock both need.
- **The `entity_display` contract change has one client consumer**
  (`labelFor`) and one deliberate server exception (refresh rows keep
  `display || identity`: they have no file, so there is no target to lead
  with).
- **History pills.** Running leg rows now add `extract`/`tag`/`face`/`fetch`
  to `seenKinds`, so those pills can appear before their first settled row
  — and those kinds do write history, so the pill leads somewhere.
- **Abort's count matches what the verb takes.** `legsLeft()` = claimed legs
  + waiting legs; `cancelBoardQueue` pulls the four wait states and discards
  the four active ones. More accurate than the cards it replaced.
- **Nothing dead left behind.** No reference to `QUEUED_SHOWN`,
  `liveItemRow`, `STATUS_LABELS` or `busyIds`; no orphan CSS for the
  deleted `job-kind-queue` / `job-outcome-queued` class names (neither ever
  had a rule).
- **Leg rows never read `detail`** — `runningStatus` answers from the kind
  table before reaching for it, and leg rows carry none.
- **The keyless board (F7) is unchanged.** Its `pending` cards held the 4 s
  poll open before; its leg lane holds it now. No regression, same
  known-open honesty gap.
- **The running container carries both stages** (rebuilt 2026-09-23, carries
  `labelFor`, `legsLeft`, `answerRouted`, `workLegQueued`), so Stage 4 is
  unblocked — it spends real AI calls on real boards, so it is the user's
  call to run.

### Stage 3 fixes — built 2026-09-23, uncommitted

P1, P2 and P4 built; **P3 deliberately not** — its own finding says the
number that would justify a cap does not exist yet, and Stage 4's `ui` retag
is what produces it.

- **P1** — `POST /api/upload` (ingest.js) and the connector bulk add
  (server.js `entities/bulk`) answer `work` through the one composer;
  upload.js and connector-browse.js `setWork` beside the rows they already
  merge. `workFor` reaches ingest.js through `mountIngest`'s options bag
  rather than an import: the composer closes over server.js's `db`, and
  server.js mounts ingest.js, so an import would be a cycle.
- **P2** — migration **0053_job_log_running.sql**: `CREATE INDEX … ON
  job_log(board_id, started_at) WHERE outcome = 'running'`, partial on the
  outcome exactly like `idx_job_log_failed` beside it. `listRunningJobs`
  now reads from an exported `RUNNING_JOBS_SQL`, so its test pins the plan
  against the app's own string — the arrangement `LATEST_JOB_FAILURE_SQL`
  already had.
- **P4** — `entity_identity` dropped from `listJobLog` and
  `listRunningJobs`; `listRefreshHistory` keeps its own (a refresh row has
  no file, so identity is all it has).
- Proofs: first-class-work.test.js +2 (an upload's answer carries the tag
  lane it queued; the running-jobs query takes the partial index and no
  sequential scan, with 500 settled rows behind it so a scan is not simply
  cheapest); connectors.test.js (the bulk add answers two vehicles waiting
  at the fetch leg, marked `leg`); job-log.test.js (the display join now
  carries the card's NAME and `entity_identity` is gone from the row).
- Removal checks, each restored byte-for-byte after:
  - T1 upload route without `work` → the upload proof fails (1 of 9).
  - T2 bulk add without `work` → the bulk test fails (1 of 47).
  - T3 migration's CREATE INDEX withheld → the plan test fails (1 of 9) and
    prints the `Seq Scan on job_log` it was cut to remove.
  - T4 `entity_identity` put back on the wire → two job-log tests fail (the
    display-join assertion and `markInterruptedJobs`, which compares the
    running row's columns).
- Full unit suite: 1882/1882. eslint clean on every changed file.
- **Not covered by a unit proof, stated plainly:** the client half of P1.
  `uploadChunk` and the connector-browse chunk loop are module-private with
  no seam, and adding one to test a one-line mirror would be the wrong
  trade. The server contract is proved; the mirror is Stage 4's to exercise
  (drop a file, watch the chip light on the same tick).

## Stage 4 — the real app (2026-09-23)

Driven with Playwright against the rebuilt compose image (migration 0053
applied: `idx_job_log_running` present). The reprocess was fired the way the
toast's action fires it — POST the route, then dispatch
`app:board-reprocessed` with the answer's `work` — so the board's own card
key was not touched. Zero console errors in either run.

**The emma board, 23 instances in 2 cards.** What the complaint asked for,
measured:

| | before the arc | now |
|---|---|---|
| chip lights | ~27 s after the click | **33 ms** — the same render |
| chip says | 2 (cards) | **23** (instances) |
| In progress, extraction | "Nothing in flight." | 16 rows, one per claimed instance |
| a row reads | — | `3emqv15t9kc11.jpg · Emma Watson  extracting  for 7s` |
| History reads | "emma watson" ×46 | `AQJFcqx.jpg · Emma Watson` |

- The answer carried `[{kind:"extract", n:23, label:"Extraction", leg:true}]`
  and the chip read 23 with "Extraction: 23 waiting" before anything was
  claimed — the discovery hole is closed at its source, not by a poll.
- Through the run the tooltip tracked the lanes as they moved:
  "Extraction: 16 running — Tagging: 1 running, 6 waiting".
- The count stayed honest as work crossed legs: at t+30s, 8 running + 11
  waiting to tag + 3 waiting to embed = the chip's 22.
- 23 extract rows and 23 tag rows in the ledger, all `ok`; both cards intact
  (17/6 instances, same ids); everything back to `tagged` in 45 s.

**The upload mirror (P1's client half, the part no unit test covers).** On a
throwaway board, PAUSED before the drop so the row is admitted but never
claimed — zero spend, deleted afterwards (verified gone). The chip went from
no count to **1** in the same tick as the drop, reading "Tagging: 1 waiting —
board paused", and the modal showed "1 waiting — Tagging". The item sat at
`pending` with no tags, as a paused board should.

**P3, answered as far as this board can answer it.** In progress peaked at
**17 rows** (16 extracting + 1 tagging) out of 23 queued — a readable list,
no cap wanted. What that does NOT settle is a board with thousands queued:
the claim ramp here took almost everything available within seconds, so the
list length still follows the over-claim rather than the pool. Left
unmeasured on purpose — manufacturing a 4681-instance run on `ui` would
spend real money to learn something a real large run will show for free.
The cap stays unbuilt until that number exists.

**Observed, and NOT this arc's** — for the card-key plan, which is also
uncommitted: the reprocess rewrote both cards' `display_name` from
`emma watson` to `Emma Watson` while their `identity` (the key, and the
grouping) stayed lowercase. So the display name follows the MODEL's casing
on each derivation, not the list option's spelling — which contradicts
card-key H1 ("a list field's display IS its option's spelling, always"),
closed on that reasoning. Cosmetic, and arguably the nicer name, but it is
non-deterministic across runs and the ledger should say so.
