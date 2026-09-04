# Job control — cancel and pause for the pipeline (2026-09-04)

Deep dive into what "cancel a job" and "pause the work" mean in this app, what
already exists, what the industry does, and a staged shape. Nothing here is built
yet. A second research round (same day, three parallel audits: held-vs-undecided
readers, `pending` arrival paths, pause scope/resume behavior) resolved the open
questions; their verdicts are folded in below and the evidence is cited inline.

## The finding that frames everything

The app does not need a cancellation *mechanism* — it already has one. It needs the
**verbs**.

Every pipeline landing is value-fenced on its in-flight status: `markTagged` writes
`WHERE status='processing'` (db.js ~2796), `advanceFaced`/`advanceFetched` fence the
same way, and `failOrRequeue` fences on `IN_FLIGHT_FOR[requeueStatus]` (db.js ~2950).
`discarded` is already a first-class job-log outcome with its own copy ("the money was
spent anyway", worker.js processOne). So **any UPDATE that moves a row out of its
pending/in-flight status IS a cancel**, and the worker's existing discipline handles
the in-flight half: the result comes back, the fence drops it, a `discarded` row says
so. This was built for re-route-mid-flight (reprocess, delete); a cancel button is the
same move with a user's name on it.

Proof it's already used this way: `cancelBoardQueue` (db.js ~3379) + `POST
/api/admin/boards/:id/retag/cancel` (server.js ~2185) + the red stop button on
Admin › Boards (admin-boards.js ~139). Three limits keep it from being the feature:

1. **Admin-only, and in the wrong room.** People watch jobs in the Jobs modal; the
   stop button lives on an admin panel they may never open (and members/managers
   never can).
2. **Tag queue only.** It touches `status='pending'`; queued extract/face/fetch rows
   are unreachable — exactly the legs a big connector add or upload floods.
3. **No pause.** It empties the queue; there is no way to *keep* the queue and stop
   the burn.

## What exists today, per job shape

| Shape | Queued state | In flight | Stop today |
|---|---|---|---|
| Pipeline legs (tag/extract/face/fetch) | `items.status` pending_* | fenced in-flight statuses | admin cancel, `pending` only |
| Scheduled retag | `auto_tag_next_run_at` | one UPDATE, instant | turn the schedule off (config, not pause) |
| Ingestion run | `ingest_next_run_at` | `running` job row; **drain re-arms itself** | schedule pause exists (0036); a mid-drain run is unstoppable — "a drain continues regardless of how the run started" (worker.js ingestDue) |
| Embed / refresh / transcribe / diagnose sweeps | derived from data state | loop-internal | nothing (capability floor gates are config, not pause) |
| Whole worker | — | — | `runtime.stopWorker()` — restore's exclusivity drain (backup-routes.js ~211), not user-facing, not durable |

Two more facts that matter:

- **Restart is not an escape hatch.** The queue is durable by design: a restart marks
  `running` job rows interrupted and `recoverStuck` re-queues in-flight items with an
  attempt counted. Good engineering — and it means an explicit cancel is the *only*
  way to shed work.
- **Money is the stake.** Since the metering arc the queue has a price. Cancel/pause
  is cost control; the Jobs modal is where someone watches spend happen with no brake.

## Research: how the queue systems do it

- **BullMQ** — `queue.pause()` is durable and queue-level: workers finish the job
  they hold, then idle; nothing new is claimed. No forceful kill of active jobs.
- **Celery** — `revoke` skips a queued task; `revoke(terminate=True)` kills the
  *process* and the docs warn against it.
- **Temporal** — cancellation is cooperative (cleanup runs); terminate is the
  forceful last resort.
- **GitHub Actions** — ships the exact two-verb pair: **Cancel** (graceful,
  SIGINT→grace→escalate) and a separate **Force cancel** added later for when
  graceful isn't enough. **Jenkins** calls its verb **Abort**.

Consensus, and it maps 1:1 onto this codebase: **pause gates claiming and lets
in-flight finish; cancel removes queued work and discards in-flight results
cooperatively; nobody kills a running call.** The claim gate is one WHERE clause in
`claimFairBatch`; the cooperative discard is the fence that already ships.

## The verbs and their names

- **Pause** keeps the queue and stops the burn: nothing new is claimed, in-flight
  finishes, resume continues exactly where it left off.
- **Cancel queued** (soft, the visible action) empties only work that hasn't
  started: settled states restored, placeholders removed, started items flow to
  tagging.
- **Abort** (hard, one deliberate step further away — the GitHub "Force cancel" /
  Jenkins precedent) settles everything now; running calls finish and their results
  are discarded by the fences. Honest microcopy required: Abort does not stop the
  paid call already in the air — it stops its result from landing.

Note the composition: on a board with a periodic retag, cancel alone is not durable
— the scheduled pass re-queues `tagged`/`failed`/`held` alike a few hours later
(worker.js ~1808 → retagBoard). "Stop this board" = pause; "shed this queue" =
cancel; both together is the true full stop.

## Stage 1 — board pause

**SHIPPED 2026-09-04 (local, suite 1359 green; cleanup pass same day).** As built,
beyond the spec: (1) the one real bug during the build was exactly the trap
BOARD_COLS' comment warns about — the column existed, every gate worked, and
getBoard still served `undefined` until `paused` was named in the hand-written
list; (2) the "Run now while paused" deferral surfaces as the Run-now toast
("Board paused — run queued for resume") rather than a status line — the toast is
the moment the question is asked; (3) pollDelay keeps the fast tier while
anything is genuinely MOVING (an upload landing, or a row pause let finish) and
drops to 30 s only when the paused board is queue-only; (4) the seven gates go
through a `notPaused(alias)` helper at db.js module scope carrying the roster and
the not-gated list, so `grep -c notPaused` answers "is the gate complete?" and
the eighth sweep's author has something to find; (5) the client stamps `paused`
through the one existing board funnel (`stampBoardIngest` → `stampBoard`), which
is why the board PATCH echoes the flag — the funnel resets from whatever payload
it is handed, so a save response that omitted it would silently resume the board
on the client; (6) `.paused` was promoted to `.mapping-chip.paused` beside
`.mapping-chip.error`, the family-wide statement both chips now share.

**Known cost, deliberately not fixed here.** While a board is paused,
`dueLiveEntities` still walks its overdue entities every tick: the sweep is
ordered `refresh_at ASC` and a paused board's stamps are the oldest in the
system, so `NOT b.paused` filters only AFTER the entities index walk and the
per-row items GIN probe. On a big paused live board that is a repeated wasted
scan every 3 s, for as long as the pause lasts. The clean fix is to NULL
`refresh_at` on pause (the rows leave the partial index entirely) and rebuild
the schedule on resume via `rescheduleEntityRefreshes` — but that makes pause
MUTATE entity schedules, which Stage 1 deliberately does not do ("pausing needs
no side-effect — the gates read the flag live"), and it would have to
distinguish paused-nulled stamps from entities that legitimately never refresh.
Revisit if a long pause on a large live board is ever a real workload.

`boards.paused BOOLEAN NOT NULL DEFAULT FALSE` (migration). One column, durable
across restarts for free, per-board because that's the app's unit of work, spend
attribution, and scheduling.

**Position settled by research: pause gates everything automatic the board spends —
including the liveness refresh.** The decisive facts: (a) `refreshDueEntity` on a
`retag_on_refresh` board calls `requeueItemForTag` on every moved field (worker.js
~844-852) — gate the claim but not the sweep and a paused live board keeps flipping
items to `pending` all through the pause, building a paid backlog that bursts on
resume; (b) chart-face renders are the real quota burn — one uncached provider
request per entity per cadence (`produceFace` → `provider.history()`, runtime.js
~476, no batch, no cache; a 100-entity board at 60-min faces ≈ 2,400 requests/day
against FMP free's 250/day), where field refreshes are batched (250 ids/request,
60 s quote cache) and nearly free. Alerts do NOT depend on refresh — conditions are
tag-sets evaluated at tag/extract/upload landings only (alerts.js ~43-87), so
"alerts on stale data" is a non-concern.

The gates — every site verified against the SQL (close-look pass, 2026-09-04):

| Query | Gate | Verified note |
|---|---|---|
| `claimFairBatch` (db.js 2067) | `AND NOT b.paused` in the ready CTE | boards already joined at 2073; covers all four legs; `prefetchClaimedFetches` consumes its output — gated for free |
| `dueBoards` / retagDue (db.js 1672) | `AND NOT paused` | plain boards WHERE, no join needed. Stamp untouched while paused → one owed run on resume (`nextAutoTagRun` rolls from `now`, no catch-up multiplication). The comment above it (1662-1671) warns the predicate only works because auto-tag has no hand-arm path — still true; pause joins the same family |
| `dueIngestBoards` (db.js 1694) | `AND NOT paused` | `drain_left` preserved → resume continues the drain exactly. See the Run-now collision below |
| `dueLiveEntities` (db.js ~2385) | `AND NOT b.paused` | boards joined at the face/retag columns already. `prefetchDueRefreshes(db, rows)` takes THIS query's rows (connectors/index.js 73) — no second query to gate |
| `itemsNeedingEmbedding` (db.js 2840) | **new** `JOIN boards b ON b.id = items.board_id` + `AND NOT b.paused` | confirmed: the query has no board handle today |
| `oneAudioNeedingTranscription` (db.js ~2876) | `AND b.paused IS NOT TRUE` | the LEFT JOIN to boards already exists for the pin columns; `IS NOT TRUE` is the spelling that matches the join (board_id is NOT NULL in practice, but don't couple to that) |
| `boardsWithVotes` → diagnoseDue (db.js 581) | `AND NOT paused` | plain boards WHERE; facet diagnosis makes paid tagger calls |
| `deliverDueAlerts` | **no gate** | delivery ships matches already detected; alerts have their own `enabled` switch, and holding a daily send past `next_delivery_at` trips the exact hazard alerts.js ~225 guards |
| `recoverStuck`, reap/prune sweeps | **no gate** | recovery requeues to pending where the claim gate holds them; prune is retention, not spend |

**The invariant that falls out: pause gates execution, never intake.** Uploads,
manual retags, admin "Retag all", queued adds — every path may still arm and queue
freely on a paused board; the rows sit in their queues and the claim gate holds
them. The only intake-shaped things pause stops are the scheduled *runs* themselves
(retag pass, feed run), because a run IS execution — enumerating a feed spends
quota before a single item lands.

**The one design collision: "Run now" on a paused board.** The Run-now route
(server.js 1464) just arms `ingest_next_run_at`, and 0036's principle is "pausing a
schedule stops the timer, it doesn't confiscate the button." Board pause can't
honor that by exempting the stamp: `ingest_next_run_at` has multiple writers (the
save path recomputes it on every config save, server.js ~1780; the sweep re-arms
mid-drain), so a null-the-stamp-on-pause design would need every writer to learn
about pause — the exact multi-site discipline the single sweep gate avoids.
Position: the sweep gate stands as the one choke point; Run now while paused
**arms and defers** — the run fires on resume, nothing is confiscated, and the
ingest modal's status line says so ("board paused — run queued for resume"). The
button still isn't confiscated; its run is queued.

**Resume behavior (audited): safe by construction, one cheap mitigation.** Every
schedule re-arms from `now` (retag, ingest), every sweep is batch-capped (refresh 20,
embed 64, transcribe 1, lanes 8/2/2/3), and `nextRefreshAt` recomputes from the fresh
landing — an entity 3 days overdue fires once, not 72 times. The one real issue is
head-of-line starvation: `dueLiveEntities` is `ORDER BY refresh_at ASC` with no board
fairness, so a days-paused board monopolizes the refresh sweep for its whole drain
(50 min at keyless CoinGecko rpm). Mitigation, in the unpause transaction:
`UPDATE entities SET refresh_at = GREATEST(refresh_at, now)` for the board (optionally
`+ random()*min(cadence, 5min)` smear, the `rescheduleEntityRefreshes` shape). One
UPDATE, kills the starvation, costs nothing semantically. The double-tag edge (owed
retag + refresh cascade both queueing) is fence-bounded; accept the small-board leak
under "when in doubt, let it finish".

**Copy: pause stops *automatic* work.** Human-clicked routes stay live and metered —
lightbox live chart, browse filters, manual add, ingest "Run now" — and that's
correct (a human asked). Say it, don't hide it.

**Plumbing (close-look additions):**

- **Toggle surface:** `paused` rides the existing board PATCH (server.js 1315,
  `requireBoardManager`) — no new endpoint. The Jobs modal's Pause/Resume button
  PATCHes it; members see the state, managers flip it (the Clear-history split).
- **State reaches the client twice, both existing payloads:** the board payload
  (for the toolbar chip and `pollDelay`) and the jobs endpoint response (the modal
  renders state it fetched, not state it hopes the board payload had).
- **`pollDelay` (data.js 227):** a paused board with a full queue currently reads
  as "work in flight" → 4 s delta polling forever. The comment right there already
  states the principle ("the armed stamp, not the enabled flag, is the right test:
  … nothing on the way"): a paused board has nothing on the way — drop to the 30 s
  tier (not 0: in-flight stragglers still land for a few minutes after pausing).
- **`renderScheduled` (jobs-modal.js 375):** overdue stamps render "due now" — a
  paused board would show "next retag due now" indefinitely, contradicting the
  pause. When paused, the scheduled line should say so instead ("Paused — schedules
  resume on unpause").
- **The unpause transaction:** clear `paused` + the refresh smear in one statement
  pair: `UPDATE entities SET refresh_at = GREATEST(refresh_at, $now) WHERE
  board_id=$1 AND refresh_at IS NOT NULL AND refresh_at < $now`. Nothing else needs
  touching — retag/ingest stamps are single-valued and fire once on resume; a
  preserved `drain_left` continues its drain.

UI: Pause/Resume in the Jobs modal's In progress header (manager-gated, `busy()`),
and `.jobs-chip.paused` on the toolbar chip. The CSS vocabulary already exists:
`.ingest-chip.paused` (styles.css ~1474 — "dimmed rather than greyed, and the glyph
stops implying motion") is the exact precedent; kill the `jobs-pulse` animation,
keep the count — the count is the point (the queue is intact), the pulse is the lie.
`ICONS.stop`/`ICONS.play` already exist (utils.js ~296). No new component.

## The cancel boundary: "entered the pipeline"

Rule (2026-09-04): soft cancel touches only items that have NOT consumed any leg's
work this pass; started items run their remaining legs to tagging and settle
coherently. No aborting of in-flight calls in any stage.

**Discriminator: an explicit marker column, NOT `payload.extracted_at`.** The audit
killed the payload idea conclusively, in both directions:

- `extracted_at` is a fact about the item's *definition* ("fields were derived,
  ever"), never cleared anywhere, by documented design (db.js ~2112: it exists so a
  later release skips a second paid extraction). Asking it a per-pass question is a
  category error. Concretely: on a mapped auto-tag-off board — the "definition runs,
  tagging waits" configuration — **every** row "Tag now" (releaseHeld) or the
  auto-tag flip (queueUntagged) queues carries the stamp with `tags='[]'`, reads as
  "started", and cancel would touch none of them. That's the exact flood the button
  exists for.
- It also errs in the forbidden direction: all three legs can produce `pending` rows
  the payload test would wrongly cancel. The killer is `advanceFetched` → `pending`
  (face-less connector board): the fetch-landed row is **byte-identical in payload**
  to a fresh `addConnectorEntity` entry row — no payload test can ever separate
  work-already-bought from not-started. And rows re-entering `pending` via
  `advanceFaced`/`markExtracted` after a re-extract still carry tags, so the
  tags-first restore branch would steal them mid-pipeline.

The marker: `items.mid_pass BOOLEAN` (nullable, no default — the `tag_facets`/0030
restore argument; **a column, not a payload key** — facet-addressable-tagging-plan.md
~122 already litigated this: payload is definition, this is queue state, and a column
rides `claimFairBatch`'s `RETURNING *` for free).

- **Set (3 sites, unconditionally):** `markExtracted`, `advanceFaced`,
  `advanceFetched` — each already value-fenced, and the stamp lands in the same
  statement as the status flip, so there is no window where a row is `pending` and
  unmarked; soft cancel's `WHERE status='pending' AND mid_pass IS NOT TRUE` can never
  see a leg's row mid-transition (it's in-flight at that instant, untargeted, and row
  locks serialize the rest). Stamp even on the park arm — every path out of `held`
  is a clearing queuer, and a payload CASE that mirrors the status CASE is drift
  waiting to happen.
- **Clear (~12 sites):** the ten queuers that already carry the identical
  `attempts=0, error=NULL, retry_at=NULL` reset triple (retagItem, reextractItem,
  retagBoard, retagBoardFacets, retagItemFacets, queueUntagged, requeueItemForTag,
  reprocessEntity, plus the terminal landings markTagged and setItemTags), plus
  `releaseHeld` and the cancel helper itself. The marker joins an existing uniform
  convention, not a new discipline. `failOrRequeue`/`recoverStuck` deliberately do
  NOT touch it — a retry of a mid-pipeline row is still mid-pipeline.
- The invariant, in this file's idiom: *every UPDATE that pulls a row out of a
  settled status or is user-initiated clears the marker; the three fenced leg
  landings set it.* A forgotten clear fails conservative — one extra paid tag call —
  which is the chosen bias anyway.
- **Ordering: test the marker BEFORE the tags branch.** Tags-first would steal
  mid-pipeline rows that still carry tags (the re-extract case).
- Close-look notes (2026-09-04): all three landings already reset
  `attempts=0, error=NULL, retry_at=NULL` inside their fenced statement, so
  `mid_pass=TRUE` slots in symmetrically; the terminal clears (markTagged,
  setItemTags) are hygiene, not correctness — the only paths INTO a queue are
  the clearing queuers and the setting landings, and failOrRequeue/recoverStuck
  preserving the marker is exactly right for a bounced mid-pipeline row.

## Stage 2 — soft cancel ("Cancel queued")

**Cleanup pass (2026-09-04, suite 1364 green).** Beyond the build: the two
landing UPDATEs collapsed into one `CASE` + `FILTER` statement — the split
worked only because `parked` ran second on what `restored` had already moved
out of the status set, an ordering nothing stated and a swap would have
silently parked every restorable row; the sole-home-entity predicate promoted
to `deleteEmptyEntities` (it had three hand-written copies and no FK cascade
behind it); `jobLogWrite` moved from worker.js into db.js beside `addJobLog`,
where its rule was already documented, and exported (the cancel route was its
third re-spelling); the admin `/retag/cancel` route RETIRED — its path named
the retag leg while the operation grew to delete queued adds, and
`canManageBoard` passes every global admin, so the admin panel now calls the
member route; `boardItemStats.p` widened to all four queued statuses, without
which the admin stop button never rendered for the bulk-add case its new copy
promises; the toast reuses `summaryFor` and `api()` so wording and errors have
one home; `.jobs-clear` → `.jobs-danger` with the head row switched from
`space-between` to `gap` + `margin-left:auto` (two buttons in that row made
Pause slide sideways whenever Cancel toggled); and the Stage-2 toast.js change
was REVERTED — `test/browser-stub.js` exists to absorb exactly this (its own
comment cites data.js's import-time listener as the precedent), so the stub
gained `body` and the production module stayed eager.

**Skipped, recorded:** hoisting the `mid_pass=NULL, attempts=0, error=NULL,
retry_at=NULL` reset into a `FRESH_PASS` const. Two reviewers split on it —
for: it matches the `notPaused` precedent one stage earlier and the plan's own
"a forgotten clear = a silently uncancellable item"; against: unlike
`TAG_QUEUE`/`CLAIM_CASE`/`REQUEUE_ARMS` nothing DERIVES it, so it prevents no
omission, and it would cover 8 of the 22 `mid_pass` mentions (the terminal
landings clear the marker without the triple) — a const that looks like a
completeness audit without being one. Took the conservative side; revisit if a
queuer ever ships with a partial reset. Also outstanding: facet-diagnosis.js
still spells the never-throw rule with two inline `.catch`es and should adopt
the now-shared `jobLogWrite` (outside this diff).

**SHIPPED 2026-09-04 (local, suite 1364 green).** As built, on spec — migration
0044, the three fenced setters, eleven clears riding the reset-triple
convention (releaseHeld's missing triple closed in the same edit), the
status-uniform cancel in `cancelBoardQueue` (kept name; counts
`{restored, parked, removed, finishing}`), `POST /api/boards/:id/jobs/cancel-queued`
+ the admin route on one shared `cancelQueued()` with its job-log row, kind
`cancel` in KIND_DEFS, the modal button (visibility owned by renderLive,
`.jobs-clear` styling reused), and all four ride-along copy/client fixes.
recoverStuck's dead ELSE arm dropped — a fifth leg now fails loudly (NULL into
NOT NULL) instead of silently misrouting. One build surprise outside the spec:
importing `{ toast }` into jobs-modal pulled toast.js's import-time
`document.body` work into the DOM-less test files and crashed them whole —
fixed at depth by making the toast wrapper lazy (created on first toast), with
the three DOM-stub tests updated to the new contract.

**Close-look pass (2026-09-04, pre-build): the spec is now status-uniform.** The
draft excluded `pending_face` on a "mid-pipeline more often than not" guess made
before `mid_pass` existed. The audit of the routers says otherwise: retagBoard,
releaseHeld and queueUntagged all carry the shared `STAMPED_CONNECTOR_FACE` arm,
so every retag on a connector chart board routes its never-rendered vehicles
into `pending_face` as ENTRY rows (mid_pass cleared by the queuer) — and the
sync add lands there at creation. Only advanceFetched-routed face rows are
genuinely mid-pipeline, and those carry `mid_pass=TRUE`. The marker
discriminates the face queue exactly as well as the tag queue, for free —
excluding the status would mean "Cancel queued" skips precisely the tile-stuck
vehicles of a chart-board retag, on the board this feature was born on. So:

One transaction, generalizing `cancelBoardQueue`, touching every QUEUED status
(`pending`, `pending_extract`, `pending_face`, `pending_fetch`) where
`mid_pass IS NOT TRUE`, with ONE status-independent rule:

- **tags present → `tagged`.** The pre-queue settled state restored, zero loss.
  (Works beyond `pending`: a tagged-but-unfaced vehicle whose render kept
  failing sits at `pending_face` with tags; a pre-extraction-era tagged item
  can sit at `pending_extract` with tags. Both were settled before the queuer
  touched them; cancel puts back what the queuer took.)
- **never-tagged → `held`** — parked, releasable; the routers' shared CASE
  (UNFETCHED first, then face/extract/tag arms) already routes every held
  shape correctly on release.
- **`pending_fetch` → delete** the item and its placeholder entity, in the same
  tx (DELETE items RETURNING entity_ids → delete sole-home entities; no files
  exist pre-fetch, so no store cleanup). See the decided edge below.
- **Untouched:** `mid_pass IS TRUE` rows and every in-flight status. Started
  work is never stranded half-done.
- All touched branches: `mid_pass=NULL, tag_facets=NULL, attempts=0, error=NULL,
  retry_at=NULL` (the existing helper misses `retry_at`).

**The pending_fetch edge, decided with eyes open:** retagBoard's UNFETCHED arm
re-queues an old permanently-failed fetch vehicle into `pending_fetch`, and the
queuer wipes attempts/error — post-retag it is column-identical to a fresh
bulk-add placeholder, so cancel cannot tell "don't add these" from "stop
re-fetching this old card" and will delete both. Chosen anyway: what's deleted
is a data-less shell (fetch never landed; no files, no fields, no tags — at
most a heart), re-adding is one browse-modal click, and the alternative
(park to held) would leave the marquee case — a fat-fingered 300-item add —
as 300 junk shells with no bulk remove. The job-log row's `removed` count is
the visibility. (Mid-`fetching` rows still finish; the leg already survives
entity deletion.)

Race with the claim: the cancel UPDATE waits on rows the claimer holds locked,
re-evaluates its WHERE, and no-ops on anything that went in-flight — the fence
discipline needs nothing new.

Route: `POST /api/boards/:id/jobs/cancel-queued`, `requireBoardManager` — the same
gate as Clear history. The admin red stop button delegates to the same helper;
its confirm copy currently promises "the rest show as untagged for review" and
must say parked/held instead (the response body is ignored by admin-boards.js —
verified — so the shape change to the new counts is free). The button's
`pending_count > 0` gate covers only the tag queue; acceptable for a legacy
surface whose successor is the Jobs modal button.

**Why `held` and not today's `tagged+undecided` (research verdict):** nothing
anywhere consumes undecided as a positive signal a cancel would feed — its readers
are the facet-diagnosis rollup and the scoped-retag fences (both *exclude* it) and
the lightbox note (which *misattributes* it: "The AI couldn't apply this board's
facets" on an item the user cancelled — already logged as a defect,
facet-scope-loose-ends.md ~201). Three concrete wins for `held`:

1. **Embedding spend.** `itemsNeedingEmbedding` admits `status='tagged'`; a
   cancelled tagged+undecided row has empty tags, `embedTextFor` falls back to the
   filename, and the item gets a **paid embed call** into the search corpus keyed on
   its filename. Cancelling 300 items = 300 embed calls vs 0 at `held`. A
   cost-control feature that spends money on cancel is wrong.
2. **The only discoverable board-level resume affordance:** "tag held ▸" appears in
   Admin › Boards with a live count the moment `held_count > 0`; undecided surfaces
   nothing anywhere. Per-item Retag/reprocess/manual-tag are identical for both.
3. **Truth + inherited routing:** the three release paths (releaseHeld,
   queueUntagged, retagBoard) already route held rows correctly, mapping adoption
   included.

Board-visible behavior is otherwise identical: same grid membership, same dotted
"needs a human" card (`needsTags` already treats undecided and held as siblings,
filters.js ~113), same Untagged pill, same absence from Processing/Unprocessed.

Ride-along edits the switch requires (from the audit):

- **Lightbox held copy** (lightbox.js ~519) currently asserts "this board's
  auto-tagging is off" — false for a cancelled item. Make it status-honest: "Not
  tagged — parked. Retag it to queue it again." Must-do; shipping without it trades
  one lie for another. Same one-line fix for the admin "(N held)" tooltip
  (admin-boards.js ~45).
- **Client stale-tags fix**: data.js ~77's delta reconcile doesn't clear displayed
  tags for a `held` row with an empty list (a retagItem'd row whose tags the DB
  already cleared would keep showing them). Add `held` to the condition — it's
  already terminal per data.js ~169.
- **Known propagation quirk, accepted and stated:** `STATUS_PRIORITY` ranks `held`
  above unlisted `tagged`, so cancelling one instance of a five-instance entity
  flips the whole card to held (dotted). Arguably correct — something *is* parked.
- **Mapping adoption accepted:** a cancelled held row on a board that later gains a
  mapping routes through a paid extract on release — "when in doubt, let it finish."

Tests: the single existing `cancelBoardQueue` test (facet-scope.test.js ~328,
scope-clearing on both branches) survives unchanged; no test anywhere asserts the
landing status — write one per branch (`tagged` restore, `held` park, placeholder
delete, `retry_at IS NULL` on all).

## Stage 3 — Abort (the hard verb)

**Cleanup pass (2026-09-04, suite 1365 green).** One real bug, found by the
altitude review: the reveal was a per-tab LATCH, so after a cancel emptied the
queue and left rows running, `queued.length === 0` and an unset latch hid the
button entirely — a second manager, or the same one after a reload, could
neither abort nor press Cancel to re-reveal it. Decision 7 said "revealed after
a soft cancel"; a latch made that "revealed to whoever clicked", which is the
session that least needs it. Now DERIVED from the board: the newest cancel row
reports `finishing > 0` and something is still running. The ledger encodes the
state machine for free — an abort's own row reports nothing left running, so it
disarms itself — and the answer is the same in every tab, survives a reload,
and removes the state mutation that was happening inside `renderLive`.

Also: `summaryFor` now names the verb (`aborted:` / `cancelled:`) — with both
strengths coming through one route, the ledger row IS the audit trail, and an
abort with nothing in flight was otherwise character-identical to a cancel; the
status lists moved to module scope beside their `IN_FLIGHT_FOR` siblings as one
`legHalves` rule (which also makes the abort partition visible rather than
asserted in prose); `finishing` is `abort ? 0 : boardTagActivity(...).busy` —
skipping a query whose answer the code already asserts, so Stage 3 nets zero
added statements; `discarding` is always returned (0 in soft mode) rather than
a mode-dependent key; the two verbs' copy collected into a `CANCEL_VERBS`
table instead of seven parallel ternaries; the two route tests folded into one
that covers the arming SEQUENCE (soft cancel leaves work running → abort),
which nothing tested before; and the Clear-history handler adopted `api()`,
which Stage 3's import made available and which replaces its silent `catch {}`.

**Skipped, recorded:** building the `mid_pass` fence as a JS fragment instead
of the parameterized `($n OR mid_pass IS NOT TRUE)`. Two reviewers said keep
(one SQL string for both verbs; the statement a reader sees is the statement
that runs; node-postgres uses unnamed statements so the boolean is
constant-folded at Bind and the branch leaves the plan entirely), one said
change on file precedent. Kept, with the crosscut between `discarding` and
`removed` now named in the comment.

**SHIPPED 2026-09-04 (local, suite 1366 green).** As built, on the close-look
spec: `cancelBoardQueue(db, boardId, { abort })` with both status lists derived
from IN_FLIGHT_FOR and the mid_pass fence parameterized out; `discarding`
pre-counted in-tx, returned only in abort mode (the soft shape stays four
keys); same route with `{ abort: true }`; the modal's one button carries both
verbs (label in a busy()-safe span, renderLive owns visibility + label + the
disarm-when-drained rule; reopening resets to Cancel). The tests pin the part
everything leans on: a late `markTagged` landing on an aborted row returns
false and the restored tags survive.

**Close-look pass (2026-09-04, pre-build): every fence audited, spec sharpened.**

The escape hatch when soft isn't enough: everything settles now, no boundary test.
No process is killed and no call is aborted — the landing fences do all the work,
and the audit walked each one:

| leg | landing fence | what an aborted flip leaves |
|---|---|---|
| `processing` | `markTagged … WHERE status='processing'` | result discarded, `discarded` row with the tokens spent; `evaluateItemAlerts` only fires on a landed result, so no phantom alerts |
| `extracting` | `markExtracted … WHERE status='extracting'` | extracted fields thrown away — paid sidecar work a later release re-pays; that IS abort's meaning, soft cancel is the gentle verb |
| `facing` | `advanceFaced … WHERE status='facing'` | the render may still land on the ENTITY (face file + refresh stamp — harmless; a parked card gets its chart), the item advance discards |
| `fetching` | `advanceFetched … WHERE status='fetching'` | item + placeholder deleted mid-call; verified end-to-end: `landEntityFetch` is a plain UPDATE (0 rows = silent no-op, no throw), the dup-409 path lands in `failOrRequeue` whose fence no-ops on a gone row, and `legLog` writes from the claim-time snapshot with non-FK ids — the `discarded` row survives the deletion with a readable target |

`recoverStuck` can't resurrect anything (settled statuses aren't in IN_FLIGHT_SQL),
re-claim can't either (settled statuses aren't claimable), and the failure dot keys
on `outcome='failed'` alone — an abort's wave of `discarded` rows doesn't ring the
alarm.

**Mechanics — one flag, not a near-copy** (the Stage-2 altitude note, honored):
`cancelBoardQueue(db, boardId, { abort })`. Abort widens both branches and drops
the fence:

- pulled: `pending, pending_extract, pending_face` + `processing, extracting,
  facing`, no `mid_pass` test — same CASE (tags → tagged, bare → held).
- delete: `pending_fetch` + `fetching`.
- Derive both lists from `IN_FLIGHT_FOR` (pulled = all legs minus the fetch pair,
  delete = the fetch pair) so a fifth leg can't be forgotten — the TAG_QUEUE rule.
- Counts gain `discarding`: the in-flight rows caught mid-call, pre-counted in the
  same tx before the flip (`RETURNING` can't see the old status pre-PG18). A call
  that lands in the pre-count↔flip window settles normally and the pulled branch
  catches its landed row — no gap, at most a one-off overcount of `discarding`.
  `finishing` reads 0 after an abort by construction.
- Ledger: the same cancel row, `mode: 'abort'` (the detail key anticipated it).
  Always written, even all-zero — destructive intent is worth recording.

Route: the same `POST /api/boards/:id/jobs/cancel-queued` with body
`{ abort: true }` — same permission, same helper, one door.

**Placement (decision 7): revealed after a soft cancel.** Session-local in the
modal: a cancel response with `finishing > 0` swaps the Cancel button into
"Abort — N still running" (danger styling, its own confirm) until the in-flight
set drains or the modal closes. Reopening shows plain Cancel again; pressing it
no-ops on the empty queue and re-reveals Abort — the GitHub shape, Force cancel
appearing when Cancel wasn't enough. Confirm copy tells the truth: "running calls
finish and their results are discarded — the spend is committed, the outcome
isn't."

**Honesty gaps, accepted and to be said in copy:**

- After an abort the In progress list empties and the chip goes quiet while up to
  minutes of already-launched calls still burn in the background. The toast names
  it ("N running calls will finish and be discarded") and each `discarded` row
  lands in History with its tokens as the calls return.
- Abort stops PIPELINE work only. A running transcription or a mid-drain ingest
  run (the modal's `running` sweep rows) is not an item status and is not
  touched — pausing the board is what stops the next tick of those. The button
  copy should scope itself to the queue.

## Transparency in the modal

Three surfaces, all riding existing machinery:

1. **The cancel row.** Every cancel (either strength) writes one board-run job-log
   row, new kind `cancel` in KIND_DEFS, detail with the branch counts:
   `{ mode: 'queued'|'abort', restored, parked, removed, finishing }` — `finishing`
   being the in-flight count a soft cancel left running. `summaryFor` renders the
   sentence ("cancelled: 120 restored, 30 parked, 12 queued adds removed; 4 in
   flight left to finish"). Lands at the top of History within one 5 s refresh —
   the "why did my queue vanish" answer. (The job-log plan's "the ledger observes,
   it doesn't schedule" stands: the buttons live beside the ledger; the row they
   write is observation.)
2. **The In progress list tells the rest by shrinking.** After a soft cancel the
   queued rows vanish and what remains IS the started set, finishing under its
   normal labels — no new standing state.
3. **Abort's tail is already built.** As each discarded call lands, its `discarded`
   history row appears with the tokens it burned.

## Sidecar fixes to fold into the same change

Surfaced by the audits; small, adjacent, worth closing while in the files:

- `releaseHeld` is the only queuer missing the `attempts/error/retry_at` reset
  triple (db.js ~1631, verified still true) — harmless today only because every
  writer of `held` resets first; close it when adding the `mid_pass` clear.
- `recoverStuck`'s `ELSE 'pending'` arm (db.js ~3017) is unreachable today and a
  silent misroute waiting for a fifth leg. The fix is to DROP the ELSE, not
  rewrite it: an unmatched CASE yields NULL, the column is NOT NULL, so a fifth
  leg would fail loudly at its first recovery instead of silently routing to
  the wrong queue.
- The lightbox/admin held-copy fixes above (they fix an existing misattribution
  independent of this arc). Verified verbatim: lightbox.js ~519 ("this board's
  auto-tagging is off") and admin-boards.js ~45 ("uploads waiting while
  auto-tagging is off").
- Cancelling a retag leaves its `supersedeFacetDiagnostics` marks standing —
  findings read "not measured against the current wording" until the diagnose
  loop re-measures. Self-healing; not worth a counter-write.

## Stage 4 — later, if wanted

- **Per-row ✕.** The board-level verbs first; a single-item cancel is the same CASE
  applied to one id if the need shows up.
- **Global pause.** A settings-KV flag gating `fillLanes` + the sweeps. Cheap;
  wait for the need.
- **Transcription cancel mid-clip** needs a sidecar endpoint; out of scope.
- **Priced queue line.** "queued to tag: 300 ≈ $9" beside the Cancel button — the
  metering arc's deal sentence doing cost control. Nicety, not structure.

Dropped (2026-09-04): aborting in-flight provider calls via AbortSignal threading.
The fence-discard semantics make it unnecessary, the spend on a launched call is
committed anyway, and it would touch every wire.

## Decisions log

1. ~~held vs tagged+undecided~~ → **held** (embedding spend, resume affordance,
   truth; ride-along copy + data.js fixes listed above).
2. ~~extracted_at as discriminator~~ → **`items.mid_pass` column** (payload test
   fails in both directions; marker joins the existing reset-triple convention;
   marker-before-tags branch ordering).
3. ~~pause scope~~ → **gate refresh too** (retag_on_refresh backlog + face quota);
   alerts delivery stays ungated; resume gets the `GREATEST(refresh_at, now)`
   stamp in the unpause transaction.
4. ~~chip treatment~~ → **`.jobs-chip.paused`** reusing the `.ingest-chip.paused`
   vocabulary (dim, stop the pulse, keep the count).
5. ~~naming/placement~~ → **"Cancel queued"** visible, **"Abort"** one step further
   away (GitHub Cancel/Force-cancel, Jenkins Abort precedent).

6. ~~held propagation on multi-instance entities~~ → **accepted as-is** (user,
   2026-09-04): something *is* parked; STATUS_PRIORITY stays untouched.
7. ~~Abort placement~~ → **revealed after a soft cancel** (user, 2026-09-04):
   while in-flight rows remain, the modal offers "N still running · abort" —
   the GitHub shape, Force cancel appearing when Cancel wasn't enough.
8. Run now on a paused board → **arms and defers** (close-look pass): the sweep
   gate is the single choke point; the run fires on resume; the ingest modal
   status line says so.
9. ~~pending_face excluded from soft cancel~~ → **included, status-uniform rule**
   (Stage 2 close-look): the routers' shared STAMPED_CONNECTOR_FACE arm makes
   `pending_face` an entry queue on every connector-chart retag, and `mid_pass`
   discriminates it for free — tags → tagged, never-tagged → held, regardless
   of which queue the row sits in.
10. pending_fetch cancel **deletes**, accepting the rescue-retag edge (Stage 2
    close-look): a retag-requeued failed-fetch vehicle is column-identical to a
    fresh bulk-add placeholder, so cancel deletes both; the loss is a data-less
    shell, re-addable in one click, and parking instead would strand the
    marquee 300-item-add case as junk shells. `removed` in the cancel row is
    the visibility.
11. Abort ships as **a flag on the same helper and the same route** (Stage 3
    close-look): `cancelBoardQueue(db, boardId, { abort })` +
    `POST /jobs/cancel-queued { abort: true }` — status lists derived from
    IN_FLIGHT_FOR so a fifth leg can't be forgotten; counts gain `discarding`
    (pre-counted in-tx); the ledger row is always written, even all-zero.
