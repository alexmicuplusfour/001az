# Job log — per-board transparency for finished and in-flight work (2026-07-21)

The app has no job history because the queue IS the work product: an item's job state
lives in `items.status/attempts/error/retry_at` and every one of those is overwritten
in place — success erases its own evidence. The pipeline legs (extract → face → tag)
are at least visible *while* running via their statuses; the sweep families are not
visible at all: **transcription** (the longest job in the system — minutes per clip,
single-threaded sidecar) has no status while running and only `payload.transcript` /
`transcript_error` after; **ingestion** keeps only the LAST run in
`boards.ingest_state`; **refresh** and **embed** surface nothing outside admin stats.

What we're building: a per-board job log — a modal opened from within the board —
showing in-progress and finished work, grouped by entity/instance where the job has
one. Decisions made up front:

- **Everything for everyone.** The endpoint is `requireAuth` like
  `/api/boards/:id/tokens` (server.js ~435) — no manager gate, error text included.
- **One row per execution attempt**, not per job. The retry/backoff story ("failed
  429 at 14:31, retried 14:36, ok") IS the transparency being asked for; retention
  keeps the volume honest.
- **The ledger never breaks the job.** Every job-log write is wrapped; a failure is
  a `console.warn`, never a thrown error into the leg/sweep it's observing.

## What's already in place (and why it isn't enough)

- `items.status/attempts/error/retry_at` — a live view of the pipeline legs, reset
  on every success and every explicit requeue. The frontend delta poll (data.js,
  4 s while work is in flight) already streams these transitions — the in-progress
  half of the UI needs **no new machinery** for the legs.
- `tag_snapshots` / `field_snapshots` — *judgment/movement* history, deliberately
  write-on-change (the #9 dedupe lesson). Not execution history — a retag that
  confirms the same tags writes nothing, and that's correct for them. The lesson
  carries over: don't log ticks that carry no information.
- `boards.ingest_state` `{ last_run_at, last_added, last_error, drain_left }` —
  last run only; previous runs are gone.
- `ai_board_usage` — per-day token totals, no per-job attribution.
- `/api/logs/stream` — an admin-only unstructured console ring buffer. Not this.

## The three job shapes

1. **Instance legs** — tag, extract, face, transcribe. One instance, one execution,
   clear start/end. Group under entity → instance in the UI.
2. **Board runs** — an ingestion run ("scanned 120, admitted 5"). Own rows,
   `entity_id/item_id` NULL. (A scheduled-retag pass row is a Stage 4 nicety — its
   per-item tag rows carry the story meanwhile.)
3. **Entity ticks** — connector field refresh. **Excluded from the ledger.** A
   1-minute live board is 1,440 ticks/day/entity — the exact tag_snapshots mistake.
   `field_snapshots` already records the informative subset (movement); Stage 4 can
   surface those rows in the modal instead of duplicating them.

## The ledger: `job_log` (migration `0021_job_log.sql`)

```sql
CREATE TABLE job_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  entity_id  BIGINT,            -- deliberately NOT an FK: history outlives deletion
  item_id    BIGINT,            -- same (the ingest_log stance)
  target     TEXT,              -- display label frozen at execution time
  kind       TEXT NOT NULL,     -- 'tag'|'extract'|'face'|'transcribe'|'ingest'
  outcome    TEXT NOT NULL,     -- 'running'|'ok'|'failed'|'requeued'|'discarded'|'interrupted'
  error      TEXT,              -- 500-char cap, mirroring items.error
  detail     JSONB NOT NULL DEFAULT '{}',
  started_at BIGINT NOT NULL,
  ended_at   BIGINT
);
CREATE INDEX idx_job_log_board ON job_log (board_id, started_at DESC, id DESC);
```

- `board_id` cascades (deleting a board purges its log); `entity_id/item_id` are
  plain columns + the frozen `target` label so "transcribed interview.mp3, later
  deleted" still reads. Live rows join `entities` for the current display name and
  fall back to `target`.
- **`running` rows exist only for the sweep families** (transcribe, ingest) — that
  is precisely their missing in-flight visibility. The legs are already visible via
  `items.status`, so they write **one completed row at resolution** (`started_at`
  captured at function entry) — no dangling-row problem for the common case.
- Boot sweep: `startWorker` marks any leftover `running` rows `interrupted`
  (single-process invariant makes this correct — nothing else can own them).

db.js helpers: `addJobLog(db, fields) -> id` (running rows),
`stampJobLog(db, id, { outcome, error, detail, ended_at })`,
`logJobDone(db, fields)` (one-shot completed row),
`listJobLog(db, boardId, { after, kind, outcome, limit })` — keyset on
`(started_at, id)`, the `/api/items` house pattern —
`markInterruptedJobs(db)`, `pruneJobLog(db, cutoff)`.

## What gets logged — and what deliberately doesn't

| kind | write point | outcomes | detail |
|---|---|---|---|
| `transcribe` | transcribeLoop (worker.js ~1417): `running` when a clip is picked, stamped on resolution | ok / failed / requeued (transient 60 s backoff) | `{ chars, engine }`; target = `original_name` |
| `ingest` | ingestDue (~972): `running` at board-run entry, stamped at the `setIngestState` sites (~1005, ~1018) | ok / failed | `{ scanned, fresh, admitted, skipped, drain_left, trigger }` |
| `tag` | processOne resolution paths (~1035) | ok / failed / requeued / discarded | `{ tags: n, model, undecided }` |
| `extract` | extractOne resolution (~1102, via the `stampExtracted` sites) | ok / failed / requeued / discarded | `{ fields: n, identity: 'derived'\|'merged'\|'split'\|'kept', model }` |
| `face` | processFaceOne (~1257) | ok / failed / requeued / discarded | `{ provider }` |

Leg notes (Stage 3): `failOrRequeue`'s boolean already distinguishes failed vs
requeued (~1048); the fence-discard branches (~1043, ~1063) log `discarded`; the
facet-less completion (~1042) is a real `ok` with `{ tags: 0 }`; the
left-for-recovery branch (~1065) logs `failed` with error `"post-tag write failed —
left for recovery"` (the paid call happened; the result was lost — say so).

**Not logged:** refresh ticks (above), embed successes (plumbing nobody watches —
embed *failures* are a Stage 4 add), ingest-time thumbnails/faces (milliseconds;
the ingest run row is the visible event), recoverStuck/prunes (maintenance noise).

Volume, honestly: a daily scheduled retag of a 300-item board ≈ 300 rows/day; a
50-file upload on a mapped board ≈ 150 leg rows. Trivial next to the excluded
refresh trap. Backstop: `JOB_LOG_RETENTION_DAYS` (default 30; 0 = keep forever),
pruned in the existing hourly `pruneSnapshots` block (~933).

## API

`GET /api/boards/:id/jobs` — `requireAuth` (the tokens-endpoint precedent).
Query: `after` (cursor `startedAt_id`), `kind`, `outcome`, `limit` (default 50,
cap 200). Returns:

```
{ running: [...],            // all outcome='running' rows for the board (tiny, unpaginated)
  jobs: [...], nextCursor, now,
  failed_at }                // newest failure board-wide — the chip's dot, NOT part of the page
```

`GET /api/boards/:id/jobs/errors` — the same `failed_at` alone, plus `now`.
Its own route because the gallery re-reads it on a background tick and the page
above costs five queries to answer (the `/tokens` precedent).

Rows carry `entity_display` (live join, `target` fallback) so the client renders
without a second fetch.

## UI

- **Entry: an activity chip** in the toolbar board group (toolbar.js ~124–213),
  next to the ingestion-countdown chip and token odometer — the established ambient
  slots. The chip shows a pulse + count while work is in flight, derived
  client-side from `state.items` IN_FLIGHT statuses (data.js already computes
  exactly this for `needsPoll`) — zero extra requests. Click → `openJobsModal()`.
- **Modal** via `createModal` (modal.js ~37), two sections:
  - **In progress** — merged view: client-side items in IN_FLIGHT statuses, grouped
    by entity (live for free off the existing `app:render`/poll cycle), plus the
    endpoint's `running` rows — a transcription with elapsed time ("transcribing —
    3m 12s"), an ingest run in flight. Re-fetch `running` on the poll tick while
    the modal is open.
  - **History** — paged list (`paged-table` style), **kind filter chips** across
    the top (the admin-plugins chip pattern, 24ccfb2). Grouped under entity where
    `entity_id` is set; ingest runs render as their own board-level entries. Per
    row: kind badge, target, outcome, relative time, duration, error text (for
    everyone — decision above). `requeued` rows read as the retry story in
    sequence with their successor attempt.

## Stages (each independently shippable; stop anywhere)

- **Stage 1 — the ledger + the invisible families. ✅ DONE.** Migration 0021, db.js
  helpers, prune wiring + `JOB_LOG_RETENTION_DAYS`, boot interrupted-sweep, and the
  two sweep write points: transcribeLoop and ingestDue. No UI yet; data accrues.
  Shipped simpler than the sketch: no `logJobDone` — `addJobLog` covers the
  one-shot completed shape via its `outcome`/`endedAt` params, so a separate
  wrapper was a dead layer; `listRunningJobs` split out as its own tiny helper
  (running rows are unpaginated by design). `oneAudioNeedingTranscription` grew
  `board_id`/`entity_id` in its SELECT — the row it hands the loop is now enough
  to attribute the job. 10 new tests in test/job-log.test.js incl. the cardinal
  rule pinned by dropping the table mid-run; full suite 420/420.
- **Stage 2 — the surface. ✅ DONE.** `GET /api/boards/:id/jobs`, the jobs modal, the
  toolbar chip. In-progress fully derived (items statuses + running rows); history
  shows transcribe + ingest. This is already the biggest win — the two invisible
  families become visible, live and historical.
  Shipped with three deliberate deviations from the sketch: **history is a
  chronological flat list** with a per-row entity/target label, not grouped under
  entities — chronology is a log's truth, and grouping would reorder it (the
  in-progress section does group naturally: one row per in-flight entity card);
  **filter pills appear as their kinds show up in fetched data** (a paged log
  can't know its kind counts up front; pills for kinds with no rows would filter
  to an empty list); and the modal's 5 s interval **re-pulls only page one, and
  only while the reader hasn't paged deeper** — Load-more readers aren't yanked
  back to the top, they just pause live history (running rows still refresh).
  The chip counts the client's own pipeline items (zero extra requests, rebuilt
  every poll tick); sweep jobs appear inside the modal, which fetches for
  itself. Endpoint mirrors /tokens: requireAuth + canAccessBoard → 404, errors
  included for every member. Full suite 421/421.
- **Stage 3 — the pipeline legs. ✅ DONE.** One `legLog` helper; each leg writes one
  completed row per attempt at resolution, started_at from leg entry. The modal
  needed no changes — kinds are data-driven. Decisions made while shipping:
  `extractOne` returns a summary `{ landed, fields, identity, model }` and
  `processExtractOne` writes the single row — one write point instead of nine
  stampExtracted sites; the **no-AI extract passthrough writes nothing** (a
  connector stamp's status flip is not an execution worth a history row);
  **noCount waits write nothing** (a missing key or awaiting-transcription gate
  would otherwise drip a `requeued` row per claim cycle while a clip
  transcribes — gates, not attempts); the face detail gained
  `rendered`/`render_error` — a render failure still advances (outcome ok), and
  the row is the "why is my chart a tile" answer; the post-tag
  write-failure path logs `failed` with an explicit "left for recovery" error
  (the paid call happened, the result was lost — say so). Tests drive all three
  legs through a real worker: face keyless (queue.test pattern), extract→tag
  end-to-end against a stubbed compat wire (one tool-call response serves both
  record_fields and record_tags; asserts fields/identity='derived'/tags detail
  AND the entity rename), facet-less ok {tags:0}, permanent 400 → failed.
  Full suite 425/425.
- **Stage 4 — defer/polish. ✅ DONE (except the progress door).** Shipped:
  **embed-failure rows** — written exactly where an item is marked-and-skipped
  in embedBatch (the moment it silently vanishes from the search corpus);
  batch-level config failures stay unlogged (no item attribution, and the
  admin embedding stats already carry them). **Retag-sweep run rows** — one
  per pass with `{ queued }` (weekend skips included: the answer to "why
  didn't my retag run"); the queued items write their own tag rows.
  **Refresh history** — served under `kind=refresh` straight from
  `field_snapshots` wearing the job-row shape (never duplicated into
  job_log); a `has_refresh` flag on every response drives the modal's pill,
  and refresh rows read "moved" instead of "done" — a flat tick is never
  recorded, so every row IS a movement. **The scheduled strip** — the
  endpoint returns `scheduled { ingest_next_run_at, retag_next_run_at,
  refresh_next_at }` (the last via MIN(entities.refresh_at)); the modal
  renders "Scheduled: next feed run in 12m · next refresh in 40s" under
  In progress. **Still deferred:** the transcription progress door — true
  percent needs the sidecar to report chunks (streaming from a stdlib
  HTTPServer); the elapsed-time display on running rows covers the need
  meanwhile. Bonus fix caught by a test going flaky: ingestDue's failure
  path now settles the schedule (disarm/back off) BEFORE publishing
  last_error — observers poll for the error, so everything it implies must
  already be true when it lands. Full suite 428/428.

**Loose-ends pass (2026-07-21, post-ship).** First real use surfaced three
things. (1) **Load more never hid**: `.tool-btn`'s `display` out-specifies the
UA's `[hidden]` rule, so with no next page a click re-fetched page one and
concatenated it — history repeated on every click. Visibility now toggles
`style.display`, `load()` refuses to append without a cursor, and a
generation counter makes the newest call win (a filter click or Load more
during the interval's in-flight refresh supersedes it instead of being
dropped). (2) **Rows labeled uploads by the stored hex name** —
`payload.identity` is the vestigial stored filename; targets now freeze
`original_name` first, and the endpoint's display chain runs display name →
target → identity (a provisional entity's identity IS the hex name).
(3) **Idle continuous scans were the flat-tick trap in the one family we DID
log**: a 30-second folder watch wrote an `ok` row per scan (~2,880/day —
34 real rows accrued in a day of dev use). An idle SCHEDULED run (admitted
nothing, erred nothing, nothing draining) now retracts its running row via
`deleteJobLog` instead of stamping it; a MANUAL run always keeps its row —
the user asked, and "0 admitted" is the answer. Failures are never
suppressed. Suite 429/429.

**Deep-dive pass (2026-07-21, later the same day).** Three more holes, all
the flat-tick lesson wearing different clothes. (1) **A transcriber outage
wrote a `requeued` row per 60-second backoff tick** — same clip, same error,
~3k near-identical rows over a weekend. Consecutive transient retries now
FOLD into the clip's prior `requeued` row (`latestSettledJob` +
`foldJobRepeat`): attempts count in detail, error and end time refreshed,
the fresh attempt's row retracted. The first failure and the eventual
resolution keep their own rows, and the fold survives restarts because the
prior row is found in the ledger, not memory. (2) **Skip-only scheduled
scans were retracted — but their effect is permanent.** A ledgered skip
(unsupported bytes) excludes the file from every future scan, and the
retracted row was the only trace it was ever seen. Skips and duplicates now
count as eventful, are tallied separately (`skipped` no longer conflates
errored items), and the row freezes `skipped_labels` — the "why did my file
never get picked up" answer, named in the modal. (3) **The same error
repeating on its retry cadence re-logged forever** (a wedged file: one
ok-with-error row per 30 s scan; a dead source: one failed row per 5-minute
backoff). A scheduled run whose only news is the same error as its prior
row folds the same way; anything new — an admission, a skip, a different
error — breaks the fold, and manual runs never fold. The modal reads the
count back ("12 attempts · …") and ingest ok-rows now show their per-item
error text. Suite 433/433.

**Clear button (2026-07-21).** `DELETE /api/boards/:id/jobs` +
a red Clear in the History header. Manager-gated (`requireBoardManager`):
READING the log is transparency for every member; destroying it is
management. Settled rows only — running rows are live work whose stamp is
still coming (the fold lookups tolerate a vanished prior), and refresh
history is field_snapshots (movement data, not this ledger) — both survive
the wipe. The button renders only for managers (`state.boardManage`) and
only when there's history behind it. Suite 438/438.

**Attention dot (2026-08-09).** The chip said work was HAPPENING and nothing
said work had gone WRONG — so a tagging error sat unread until the user was
already suspicious about missing tags. The chip now carries the same corner dot
as the ingestion caret's unseen alerts and the Tagging-consistency finding:
`latestJobFailureAt` (newest `outcome='failed'` row) against a local watermark,
`public/seen-mark.js`.

- **`failed` alone.** `requeued` is the pipeline retrying, `discarded` is a
  stale result the fence dropped, `interrupted` is a restart — a dot on every
  reader's header after every deploy. A signal that lights for self-healing
  states is one people learn to ignore.
- **Keyed on `started_at`**, which is also the history list's `ORDER BY`: the
  dot and the row it sends you to agree on which failure is newest, and a
  *folded* repeat (§ the fold, above — one wedged scan re-stamping one row
  rather than 3,000 of them) correctly counts as no news. The cost is a job that
  started before your last look and fails after it: its row is older than the
  watermark, so it waits for the next distinct failure.
- **Opening acknowledges**, and the modal marks the failures above the
  watermark it opened with (`.job-new`, weight only) — the dot's question is
  "which of these haven't I seen", and the list is where it gets answered. The
  alert history modal's `.al-new` precedent.
- **`Clear` takes the dot with it** — the reload after the delete reads
  `failed_at: null` back off the same response.

**Live dots (2026-08-09).** The pass above turned up the reason none of this
felt reliable: each of the three header dots had invented its own freshness
story. Alerts rode the item poll; facet-stats was fetched **once per page load**
and never again, so a finding written five minutes into a session did not exist
until reload; job failures rode the item poll too, which stops the moment the
queue drains — i.e. immediately after the failure that mattered. The item poll
is the wrong horse for all three: it keeps the *grid* current and correctly
stops when the grid is settled, while these are about what happened while
nothing was going on.

`public/signals.js` now owns all three on one timer — 20 s base tick, per-signal
intervals (alerts and job errors 20 s; facet-stats 60 s, since it aggregates
every tagged item's confidence and its writer only runs on a settled board),
nothing while the tab is hidden with an immediate catch-up on return, one
`app:render` per batch, and a signal whose surface isn't on screen never
fetched (`canSeeDiagnostics`). Boot fills them through the same two functions.
`pollDelay()` keeps alerts on the slow poll but for the honest reason now — an
alert is a standing statement that *arrivals* on this board matter.

**Toasts and a chime (2026-08-09).** A dot is missable by design — small,
quiet, in a header you aren't looking at — so `public/announce.js` gives all
three a voice, on one rule: **fire on the edge from dark to lit, once, and never
again while it stays lit.** Everything else falls out of it. A retag failing
three hundred items is one toast, not three hundred, because the dot is already
up and there is no edge; acknowledge the log and the next failure announces
again, because it is genuinely new. No cooldown timer, no burst counter, no
"and N more" arithmetic — the state the dot already tracks answers all of it.

Checked on `app:render`, since every path that can move these three ends in
one. The baseline is taken at boot so what is *already* lit when the page opens
is never news, and a signal whose data hasn't landed yet (facet stats, fetched
after the first paint) is skipped rather than recorded dark — recording it dark
is exactly what would turn the arrival of pre-existing news into a toast.
Each toast carries an **Open** action onto the surface it is about, which is why
`toolbar.js` exports `openDiagnosticsDoor`: two doors onto one modal that differ
in what they wire is how one of them quietly loses the `onEdit` hand-off.

`public/chime.js` is the audible half — **one** tone for all three (three would
have to be learned, and nothing here is urgent enough to earn that), at 0.35
volume, on the same edge. `public/notification.mp3`, built on first use so a
tab with the sound off never fetches it. The autoplay refusal on an untouched
tab is swallowed on purpose: the toast and the dot have already said the same
thing, which is what lets the sound be the part that doesn't always arrive.
Off switch in the **user menu** (`ddCheckRow`), because sound is the only part
of this that reaches someone not looking at the tab; turning it ON plays the
tone, which both confirms the setting and is the click the autoplay policy
wants before the first real notification.

`seen-mark.js` also carries the fix for the quietest bug in the feature: every
stamp compared is the SERVER's, so the acknowledgement floor runs on the
server's clock (`noteServerNow`, fed by the errors route's `now`). A browser a
few minutes fast used to write its watermark into the future and then ignore
everything until the clock caught up — invisibly, since a dot that never lights
looks exactly like a board where nothing went wrong.

## Config surface

`JOB_LOG_RETENTION_DAYS` (default 30) — .env.example entry + compose passthrough
(the §5 lesson: unreachable knobs are dead knobs). No concurrency/behavior knobs —
the ledger observes, it doesn't schedule.

## Tests (`test/job-log.test.js`)

- Helpers: add/stamp roundtrip; keyset order + cursor; kind/outcome filters; prune
  cutoff; `markInterruptedJobs` flips only `running` rows.
- Transcribe: success → running→ok with `{ chars, engine }`; permanent → failed
  with error; transient → requeued, and the retry opens a FRESH row (per-attempt
  invariant).
- Ingest: ok row with counts; failure row with error; a drain tick writes its own
  row.
- Stage 3: each leg's outcome mapping — ok (tags count), failed vs requeued (the
  `failOrRequeue` boolean), discarded (fence), facet-less ok.
- Endpoint: auth required; pagination; `running` array shape.
- Attention dot (`test/jobs-dot.test.js`): what counts as a failure and what
  pointedly doesn't; board scope; a folded repeat is not new news; the watermark
  per board, its floor, and that the jobs and facet dots don't share a key; a
  reader whose clock runs fast still sees the next failure; the page and the
  errors route agree on `failed_at` regardless of the page's kind filter; the
  route is member-visible, 404s an outsider, and doesn't shadow the page.
- **The cardinal rule pinned:** stub `addJobLog` to throw → transcription and
  ingestion still complete (the ledger can never break the job).
