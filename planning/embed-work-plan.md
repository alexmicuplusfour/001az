# Embeddings in the job log (2026-09-25)

Self-contained for a fresh session. Follows first-class-work-plan.md (which
put transcription on the wire) and instance-work-plan.md (which made every
claimed instance a row of its own).

## The complaint

The jobs chip lights up with a count, its tooltip says "Embedding: 1
waiting", and the job log it opens says "Nothing in flight." History never
shows an embedding either. The chip claims work the log can't find.

## What is actually happening (measured on local compose)

- **Embedding is fast.** A tag lands, then its embedding lands shortly after:
  crypto `ondo` tagged at 18:39:59.155 and was embedded at .767 (0.6s later);
  stocks test `smci` was tagged at 18:24:32.968 and embedded at 33.979 (1.0s).
  No board had anything left to embed when checked.
- **The embed sweep isn't woken when a tag lands.** The four pipeline legs
  share one wake group, so one landing wakes the others
  ([resource-loop.js:92](../server/resource-loop.js#L92)). The embed sweep has
  its own group, so it only notices new work on its own poll, which is every
  3s when idle ([worker.js:1859](../server/worker.js#L1859)). So a tagged item
  sits "waiting to embed" for anywhere from a few ms up to 3s before the sweep
  even picks it up.
- **The page checks for work every 4s while jobs are active, and every 30s
  otherwise** ([data.js:329](../public/data.js#L329)). The 30s rate is meant
  for a lane backlog with nothing running, which the code assumes is
  transcription: minutes per clip, possibly stalled behind a backoff. An embed
  backlog never has anything "running", because embeds write no running rows.
  So whenever a 4s check lands in the gap between a tag landing and its
  embedding landing, the page sees "1 waiting — Embedding", drops to 30s, and
  the chip keeps that count for up to 30s after the work finished. With a
  0.6–3s gap and a 4s check, that's somewhere between 1 in 7 and 3 in 4
  tagging runs.
- **Opening the log doesn't fix the chip.** The log fetches the real state and
  saves it where the chip reads from. But the only way to redraw the chip is
  to redraw the whole page (toolbar, filters, grid —
  [app.js:27](../public/app.js#L27)), and the log deliberately doesn't do that
  on its 5s refresh ([jobs-modal.js:676](../public/jobs-modal.js#L676)). So
  the chip keeps its old count behind the dialog until the page's next check.
  That's the screenshot.
- **History has no embeds by design.** job-log-plan.md: "embed successes are
  plumbing nobody watches". Only poison-item failures write a row
  ([worker.js:862](../server/worker.js#L862)). first-class-work-plan.md chose
  a waiting count over running rows because it assumed a batch was too short
  for the 4s check to catch. The measurement shows the opposite: the check
  catches the gap regularly, and with no running row, the gap looks like a
  stalled backlog.

## What changes

1. **The chip stops lingering.** An embed backlog keeps the page on the 4s
   check, the same as a waiting pipeline leg. The chip is then at most one
   check behind the real state.
2. **Embeddings show up in the log like transcription does.** While a batch is
   embedding, it's a row under "In progress". When it finishes, it's a row in
   History with what it embedded and what it cost, and History gets an
   "Embedding" filter pill.

## Decisions

- **D1 — One row per batch per board, not per item.** The embedder is billed
  per call and one call covers the whole batch, so a per-item row couldn't
  honestly show tokens (the meter never splits a call's cost). The worker
  already makes one call per board per batch
  ([worker.js:787](../server/worker.js#L787)), so a row per call is the
  natural fit. A one-item batch (the usual case right after tagging) is named
  by its file, like every other row. A bigger batch (a re-embed after a model
  change) reads "N items".
- **D2 — The check rate is fixed with a marker from the server, not with the
  running rows.** Running rows only cover the time a batch is in the air.
  The 0–3s before the sweep picks the batch up still looks like a backlog
  with nothing running, and so does embed work that doesn't come from a tag
  landing: a tag edit (a route, `setItemTags`), a landed transcript (the
  worker, `landTranscript`), or a switch of embedding model. So the server
  marks the embed backlog as one that clears at the worker's pace, and the
  page follows it at 4s.

  Today `leg: true` carries two separate facts: "Cancel queued can pull this"
  and "this drains at the worker's pace, check fast". Embeds are the second
  but not the first. So those split into two markers: `leg` keeps meaning
  cancellable, and a new `fast` marker decides the check rate. The server puts
  `fast` on the legs and on the embed backlog; transcription doesn't get it.
  `pollDelay` reads `fast` alone. The client still holds no list of which
  kinds are which.
- **D3 — Dropped: "opening the log redraws the chip."** It was proposed on
  2026-09-25 and dropped the same day on the user's question ("why? couldn't
  we just check more often while active?"). Once embeds keep the 4s rate, the
  chip is at most one check behind the log. A dedicated redraw would only
  cover that ≤4s window, and the only redraw available is the whole page.
  Checking faster than 4s was considered too and declined: every check runs
  the item diff plus the work read for every open tab, and a 4s lag isn't
  something anyone notices on a count. (Corrected in the simplification
  pass: a check is about 11–13 queries plus a full page redraw, not "about
  seven". The delta poll and the tokens read each make their own request,
  and the 5s lane-verdict memo misses every other 4s tick.)
- **D4 — DECIDED 2026-09-26: a batch-level failure folds into one "will
  retry" row.** A batch-level failure is the embedder being down, as opposed
  to one bad item. Today it writes no row: the batch backs off for 60s and
  retries forever, and the failure only shows on the Plugins health page.
  Now it writes one `requeued` row ("will retry") on the board, and each
  repeat folds into it ("12 attempts · unreachable…"), the way transcription
  handles its engine being down
  ([db.js:3465 latestSettledJob](../server/db.js#L3465)). A success in
  between ends the fold, so the next failure starts a new row.

  **No red dot.** The first draft said this would light the dot. That was
  wrong: the dot only lights for `failed` (LATEST_JOB_FAILURE_SQL), and a
  batch that keeps retrying hasn't failed. Calling it `failed` to get the dot
  would contradict what the row means. Rejected: (b) retract, i.e. write
  nothing, as today; (c) one row per retry, i.e. a new row every minute.

  Poison-item failures keep their own failed rows, unchanged, and those do
  light the dot: that item really is given up on.
- **D5 — Not doing: waking the embed sweep when a tag lands.** It would get
  items searchable up to 3s sooner, but D2 already fixes the chip, and
  nothing reported is about that delay. Noted, not built.

## What stays the same

- Cancel queued and Abort ignore embeds, as today. Embed rows aren't legs.
- A paused board skips embedding, as today. With a backlog, the chip keeps its
  count and the page checks every 30s, the same as for legs.
- The boot sweep already marks leftover running rows `interrupted`, and that
  covers embed rows with no new code.
- If the embedder is down with a backlog, the page keeps checking at 4s while
  the board is open. The legs already behave this way behind a failing key,
  so this is accepted.

## Stages

Each stage gets a close look before it's built.

### Stage 1 — the chip stops lingering (D2)

- Server: the work payload's queue entries carry `fast: true` on the four
  legs and on the embed backlog ([server.js:1227 workFor](../server/server.js#L1227)).
  The embed lane's `fast` is declared where the lanes are defined,
  `servedBacklogLanes` ([worker.js:1483](../server/worker.js#L1483)), and
  `workFor` copies it onto the queue entry by kind.
- Client: `pollDelay` reads `fast` in place of `leg`
  (`workLegQueued` → `workFastQueued`, [data.js:70](../public/data.js#L70)).
  The cancel checks in jobs-modal.js keep reading `leg`.
- Tests: work-cadence.test.js. An embed backlog is fast, transcription stays
  slow, a leg is still fast, and a paused board is still slow. The workFor
  shape test covers which lanes get `fast`. Each test gets a removal check.
- Browser test (real server, real Chromium, no worker): a tagged item with
  no embedding is a backlog nothing will clear. Check that the page looks
  for work every 4s, not 30s. Then land the embedding with a direct database
  write and time the chip clearing.
- Real app: one real tag on compose after the fix. The chip should clear
  within about 4s of the embedding landing.

**Close look (2026-09-25)** — what the plan had wrong, before a line was
built:

- **The marker was pointed at the wrong file.** The plan said
  [db.js:3821](../server/db.js#L3821), which is the table of each lane's
  SQL, and `boardLaneQueues` throws away everything but `kind` and `n`. The
  table of which lanes exist is `servedBacklogLanes`, whose comment already
  says "adding a backlog lane = one line here".
- **More tests change than the plan said.** `fast` on the legs changes 6
  exact-shape assertions (first-class-work ×3, connectors ×1,
  derived-identity ×2), and the cadence test for legs switches to `fast`. The
  cheaper option (`pollDelay` reads `leg || fast`, with only embed getting
  `fast`) was declined, because it leaves `leg` meaning two things.
- **The reproduction depended on luck.** "Repeat until the chip lingers" hits
  about one run in four, and each try is a paid tag. It's replaced by the
  browser test above, which reproduces the problem every time, because the
  suite runs no worker and so the backlog never clears.
- **Wording:** "a transcript landing" isn't a route (see D2).
- **Bonus, no extra code:** while the page is checking for work, it drops
  live item events from the server, because the next check will pick them up
  ([events.js:82](../public/events.js#L82)). A lingering embed count held
  those back for up to 30s; after this it's 4s.
- **Considered, not built:** marking embeds `fast` only while the embedder
  isn't in its 60s retry pause (the server can see that pause, because it
  runs in the same process as the worker). The legs already check every 4s
  behind a failing key, so it would be extra code for a small load saving.

**Built (2026-09-25), uncommitted.**

- `servedBacklogLanes` declares `fast: true` on the embed lane. `workFor`
  puts `leg: true, fast: true` on every leg and copies `fast` onto a lane's
  queue entry by kind. `workLegQueued` became `workFastQueued`, and
  `pollDelay` reads it. The jobs modal's cancel checks still read `leg`.
- **Tests:** a new cadence unit test (embed backlog → 4s; paused → 30s), a
  new server test (every carrier shows embed `fast` and not `leg`, and
  transcription neither), and a new browser test,
  [test/browser/work-cadence.test.js](../test/browser/work-cadence.test.js).
  **Seven** exact-shape assertions gained `fast`, not the six the close look
  counted: it missed the upload answer in first-class-work.test.js, which
  looks its leg up with `find` and so didn't show in the grep. Hand-written
  UI fixtures (jobs-chip, jobs-modal, board-modal-gate) were left alone,
  since none of them reads the check rate.
- **Removal checks, each half undone on its own:**
  - R1, the client reads `leg` again: the unit test fails
    (pollDelay 30000), and the browser test fails with 1 check in 14s.
  - R2, the embed lane isn't declared `fast`: the server test and the
    browser test fail.
  - R3, legs aren't marked `fast`: 5 tests across first-class-work,
    connectors and derived-identity fail.
  - R4, `workFor` drops the lane's mark: the server test and the browser
    test fail.
- **Browser test numbers:** with the fix, checks went out at 3.7s and 7.8s,
  and the chip cleared 4.4s after the vector was written. Without it: 3.7s,
  then 33.8s.
- **A bug in the new test, caught while undoing the fix:** its timeout
  message counted the checks when the wait started, not when it ended, so
  the failure read "0 checks" when there had been 1. The message is now a
  function.
- **Suite:** 1995/1995 green (1992 + 3), lint clean, and the browser test
  also passes against the built frontend (`FRONTEND_DIR=public/dist`).
- **Real app (compose rebuilt, 2026-09-25 19:58 UTC):** one throwaway board,
  one real upload, the chip read every 100ms. The run caught the exact race:
  - the tag landed at +2.8s (no facets, so no AI call and no spend);
  - the check at +5.1s saw "Embedding: 1 waiting";
  - the embedding landed at +6.3s, 3.4s after the tag;
  - the next check came at +9.1s, and the chip went dark 3.0s after the
    embedding landed. The old rate would have put that check at +35s.

  The board and the temporary session were deleted afterwards. The
  tag-to-embed gap was 3.4s this time, against 0.6s and 1.0s in the first
  measurements (the embed sweep's 3s poll), so the old bug hit more often
  than the "1 in 7" estimated above.

**Second pass (2026-09-25)** — the shipped code re-read with fresh eyes, no
new scope. No code defect was found. What it checked, and what it fixed:

- **Checked and holds:**
  - Every client carrier (boot, delta poll, signals tick, jobs modal,
    upload, bulk, requeue, the board-reprocessed event) hands the payload
    to `setWork`. Nothing but `pollDelay` reads `fast`, and nothing but the
    modal's cancel checks reads `leg`.
  - Every server route that answers `work` goes through `workFor`, so no
    payload is hand-built without the mark.
  - The built-in embedder is `core`, keyless and on by default, and it
    isn't gated on anything being present. The new server test's embed lane
    therefore resolves in CI as well as locally.
  - A paused board stays on the 30s rate.
  - The page drops live item events while it's checking for work
    (events.js), and a 4s check now covers those.
  - Line endings: every touched file kept its working copy's ending,
    checked against git's cached sizes.
- **Fixed:**
  - Two comments I wrote said an embed lands "within a second or two" /
    "in about a second". The compose run measured 3.4s from tag to
    embedding, because the sweep polls every 3s. They now say "picked up on
    the sweep's next 3s poll, done a second or so later".
  - The browser test allowed 6s against a measured ~4.4s, which is tight
    with CI running eight files at once. It now allows 10s. It only has to
    tell 4s from 30s.
  - A test comment in connectors.test.js said the `leg` mark is what makes
    the chip count. The chip counts every entry; the comment now names what
    `leg` and `fast` each do.
  - The `pollDelay` comment called every unmarked backlog "a transcription
    one", which rots when a lane is added. It now says "not marked `fast`
    (today only transcription's)".
- **Not changed:** the hand-written UI fixtures in jobs-chip, jobs-modal and
  board-modal-gate still show legs without `fast`, as recorded above. Older
  plans that describe `leg` as the check-rate mark (instance-work-plan.md
  F5) are left as dated records.
- **Suite after the pass:** the touched files pass (106/106), lint is clean,
  and the browser test passes on source and on the built frontend. The
  compose image wasn't rebuilt, because the pass changed only comments and
  test margins.

### Stage 2 — embeds in the log (D1, D4)

- Worker: `embedGroup` opens a running row per call (`openJob`, kind
  `embed`). The row's detail carries `items` (the count) and `item_ids` (the
  batch). It settles `ok` with the number embedded, the number skipped,
  tokens when the engine reports any, and the engine stamp, and it clears
  `item_ids` (only a running row needs them). A one-item batch also carries
  the item's file, item id and entity id, like every other row.
- Work payload: `workFor` excludes a running row's `item_ids` from the
  waiting counts, the same way it already excludes a single `item_id`
  ([server.js:1235](../server/server.js#L1235)). It also puts `n` (the
  number of ids) on that running row, so the count and the exclusion come
  from the same list.
- Chip: a running row counts as `n` items, or 1 when it has no `n`. A batch
  of 64 reads "Embedding: 64 running", not "1 running" next to a waiting
  count that has just dropped by 64.
- Log: `RUNNING_VERBS` gets "embedding". `labelFor` names a row with no
  file "N items", the way a feed run is "Feed run". `summaryFor` gets an
  embed line: skipped count and tokens, when there are any.
- Batch-level failure: per D4. `latestSettledJob` gets an "any item" mode,
  because the fold has to see the board's newest embed row whichever item
  it was about.
- Tests: job-log.test.js — a batch writes one running row that settles `ok`;
  the poison test now expects two rows (the batch, "1 skipped", and the
  item's failed row); a batch failure folds and a success in between ends
  the fold; while the call is held, the running row carries the batch.
  first-class-work.test.js — a running batch's items aren't also counted as
  waiting, and the row carries `n`. jobs-chip and jobs-row — the count, the
  label, the summary, the running text. Browser — the chip and both halves
  of the log with a real server. Each test gets a removal check.
- Real app: upload one image to a throwaway board and check that History
  shows an Embedding row with the file name (no tokens: the local embedder
  reports none; the engine shows on hover). Then force bigger batches on
  that board (clear its embeddings) and watch the payload at 100ms: a
  running row with `n`, a waiting count that doesn't also count those
  items, and "N items" rows in History. D4 can't be exercised on compose
  (the local embedder doesn't fail), so it's covered by the unit tests.

**Close look (2026-09-26)** — what the plan had wrong, before a line was
built:

- **Tokens.** The plan's real-app check expected tokens. The local embedder
  reports `{ input: 0, output: 0 }`, so its rows carry none; tokens only
  appear with a paid embedder.
- **D4 and the red dot.** Covered in D4 above: folding "like transcription"
  means `requeued`, which doesn't light the dot.
- **The fold lookup.** `latestSettledJob` looks at one item, or at
  board-level rows only. A one-item success row between two failures would
  be invisible to it, and the second failure would fold into the first as if
  nothing had worked in between.
- **Where the batch's ids live.** They go in the running row's detail, and
  `workFor` reads them for both the exclusion and `n`.
- **Considered and reversed: dropping running rows.** Timed in the
  container, a local batch takes 6ms for one item, 66ms for 8 and 482ms for
  64, so on this host a running row would almost never be seen. The user
  pointed out that's the fastest case, not the general one. A paid embedder
  goes over the network and waits on its rate limit, a slower machine takes
  longer per item, and a model switch re-embeds everything, batch after
  batch. The rows stay.
- **An older bug, recorded, not fixed.** A single bad item alone in a batch
  can't be told apart from a broken embedder (one input, no isolation). It
  is retried every minute, and each failure pauses the embed resource for
  60s, until another item joins its batch and isolation marks it. Under D4
  this shows as a "will retry" row. (Added in the simplification pass: with
  Stage 1, that lone item also keeps its board's open tabs on the 4s check
  for as long as it sits there. The 60s pause is on the whole embed
  resource, so it also stalls other boards' embed backlogs, and their tabs
  sit at 4s while they wait.)

**Built (2026-09-26), uncommitted.**

- **Worker:** the old `embedGroup` body is now `embedGroupCalls`, which
  also answers the usages it metered. The new `embedGroup` wraps it:
  `openJob` with `{ items, item_ids }`, settle `ok` with `embedded`,
  `skipped` (when any), `tokens` (when any), `engine`, and
  `item_ids: null`. `items` is repeated in the settle so a lost open still
  writes a labelled row. On a throw it folds or settles `requeued` and
  rethrows for the caller's backoff. `embedTarget` is shared with the poison
  rows.
- **db.js:** `latestSettledJob(…, { anyItem })`. The job-log header comment
  now lists diagnose and embed among the kinds with running rows; it had
  been stale since diagnose got them.
- **server.js `workFor`:** the running ids come from `detail.item_ids` when
  present, else `item_id`, and the same list is the row's `n`.
- **Client:** the chip counts `run += j.n ?? 1`. `RUNNING_VERBS.embed`,
  `labelFor`'s "N items", and `summaryFor`'s embed line ("1 skipped ·
  1.2K in / 0 out", or nothing).
- **A test consequence the close look didn't foresee:** job-log.test.js's
  worker-driven tests (transcription, tag, extract) started seeing the
  worker's own embed rows. The worker runs the embed sweep with the real
  on-device embedder, and those rows land on their own clock: 4 tests
  failed, a different 4 on each run. Several of them wait for "any row is
  ok", which an embed row could satisfy early. The `jobsFor` helper now
  leaves embed rows out unless a test passes `{ embed: true }`, which the
  six embed assertions do. The embedder wasn't switched off, because the
  sweep is part of what those tests run.
- **New tests:** job-log ×3 (the batch row running and then settled, the
  one-item name, the fold and what ends it) plus the rewritten poison test;
  first-class-work ×1 (exclusion + `n` on all three carriers); jobs-chip ×1;
  jobs-row ×1; browser ×1 (the chip at 3 = 2 running + 1 waiting, the
  running row "Embedding | 2 items | embedding", the note "1 waiting —
  Embedding", two History rows and the pill).
- **Removal checks, nine halves, each undone alone and restored
  byte-for-byte (scripted):**
  - W1, no batch row: 4 job-log tests fail.
  - W2, the fold ignores rows that name an item: the fold test fails.
  - W3, the settle keeps `item_ids`: the batch test fails.
  - S1, `workFor` excludes only `item_id`: the payload test and the browser
    test fail.
  - S2, no `n` on running rows: the same two fail.
  - C1, the chip counts a batch as 1: the chip test and the browser test
    fail.
  - C2 (no label), C3 (no summary line) and C4 (no running verb): each fails
    the jobs-row test and the browser test.
- **Suite:** 2002/2002 green (1995 + 7), lint clean, and the browser test
  also passes against the built frontend.
- **Real app (compose rebuilt, 2026-09-26):** a throwaway board with no
  facets, so no AI calls.
  - One upload wrote one row: `embed-one.png`, ok, `items: 1`, engine
    `local:Xenova/bge-small-en-v1.5`, no tokens.
  - 150 more tagged and embedded in ordinary batches (for example 22 and 64
    items).
  - All 151 embeddings were then cleared at once. Sampling
    `/api/boards/:id/jobs` every 50ms, 10 of 18 samples caught a batch
    running: "64 running + 87 waiting = 151", then "64 + 23 = 87". The sum
    never went over 151; without the exclusion the first reading would have
    been 215. Three rows landed: 64, 64 and 23 items, in 346ms, 367ms and
    195ms.
  - In the real page on the built bundle, History read "Embedding | 64
    items | done", with the engine on hover and the pills "All · Tagging ·
    Embedding", and there were no page errors.
  - The board and the temporary session were deleted.
  - D4 wasn't exercised on compose, because the local embedder can't be
    made to fail. The job-log fold test covers it.

## Simplification pass (2026-09-26)

Four read-only reviewers looked at the arc's diff, one each for reuse,
simplification, efficiency and altitude, with the rule "behavior-preserving
only". Every finding was re-read in the code before acting on it.

**What went:**

- **One naming rule.** `embedTarget` became `rowTarget`, and `legLog` uses
  it too; it had its own inline copy of the same expression. The comment
  about why the original filename wins moved with it. pipelineWork's SQL
  COALESCE is the same rule and is named in that comment.
- **One settle detail.** `closing = { items, item_ids: null, engine }` is
  shared by the `ok` and `requeued` settles. They had spelled it out
  separately.
- **`latestSettledJob` body.** It now uses the `args.push` pattern
  `listJobLog` already uses. The old version had three expressions (`byItem`,
  a conditional `cond`, a conditional params list) that had to agree.
- **`workFor`.** The one-use `itemsOf` helper is inlined, and the
  `Array.isArray` guard is gone: `item_ids` is only ever written as an
  array or null.
- **job-log tests.**
  - `jobsFor` always leaves embed rows out, and `embedRowsFor` returns only
    them. Six "include, then filter" pairs are gone.
  - The fixtures moved above the poison test, and the poison test uses the
    shared stub and `EMBEDDER`. Its asserted error text is now
    `/upstream 400/`, the stub's own message.
  - `seedDue` is built on helpers' `seedInstance` instead of a raw INSERT.
  - The file's own `until()` replaces a hand-rolled poll loop.
  - A dead nested stub in the fold test is gone: the outer stub already
    answers "ok" for anything that isn't a status.
- **first-class-work tests.** One `carriers(b)` list replaces three copies,
  and `seedImage` moved up so the embed-batch test uses it.
- **Browser test.** It seeds with `seedInstance`, not
  `createEntity` + `insertItem` pairs.
- **Stale text.** Three test comments still said an embed lands "in about a
  second", and one cadence test title and message still said "a lane
  backlog" where only transcription is slow now. All four were fixed.

**Declined, and why:**

- **Fix `openJob`'s lost-open path so it merges detail.** Two reviewers
  found that the fallback replaces the open-time detail instead of merging
  it, which is why the embed settles repeat `items`. Fixing it at the
  source would also change what ingest writes in that path (it would keep
  `trigger`). That's a behavior change outside this arc, so it's recorded
  here and not made.
- **Use `listJobLog(…, { limit: 1 })` for the fold instead of `anyItem`.**
  It's the same query plus a join, but the fold would then read through
  History's pager. The named function for folds is clearer.
- **A shared "settle or fold" helper with transcription.** It would save
  about 4 lines at the cost of a helper that takes a lookup callback. The
  two sites also differ in what they look up and in their detail.
- **Strip `item_ids` from running rows on the wire.** Nothing reads them,
  but it's about 0.45 KB per 64-item batch while it runs, under 5% of the
  delta poll's own id list. Negligible, and stripping it is another line.
- **Replace the browser test's `waitFor` with helpers' `until`.** Its
  message is a function on purpose: that's how the "0 checks" bug was
  caught.
- **Shave the browser cadence test from about 12s to about 8s** by writing
  the vector after the first check's response. It adds flake risk for a
  file that isn't on the suite's critical path.
- **The efficiency findings about the 4s check itself.** The query count
  is corrected in D3, and the lone-bad-item interaction is added to the
  older-bug note above. The only cheaper design is the one already declined
  in Stage 1's close look (mark embeds `fast` only when the embed resource
  isn't paused), and it changes the check rate.

**Removal checks after the pass (scripted, bytes restored):** every proof
the pass restructured, plus the new shared rule:

- W1, no batch row: 4 job-log tests fail.
- W2, the fold ignores rows that name an item: the fold test fails.
- W3, the settle keeps `item_ids`: the batch test and the fold test fail.
- T1, `rowTarget` names by identity: the tag-leg row test **and** the
  one-item embed test fail, so the shared rule is proven for both callers.
- D1, `anyItem` is ignored: the fold test fails.
- S1, `workFor` excludes only `item_id`: the payload test and the browser
  test fail.
- S2, no `n`: the same two fail.
- F1, the embed lane isn't `fast`: the server test, the payload test and
  the browser cadence test fail.

**Suite:** the touched files pass (185/185) and lint is clean. The first
full run failed one test, 2001/2002: welcome.test.js "the user menu has no
Setup row" timed out after 15s waiting for the user menu. That file isn't
touched by this arc, and it passed 3/3 when run alone. The full rerun passed
2002/2002, so it was load. The browser test passes on the built frontend.

**Compose (rebuilt after the pass):** the Stage 2 check was re-run with
identical results. The one-item row is `embed-one.png`, and the 151-item
re-embed read "64 running + 87 waiting = 151", then "64 + 23 = 87" (12 of 38
samples caught a batch). The rows were 64, 64 and 23 items, History
rendered, and there were no page errors. The board and the temporary session
were deleted.

## Cost

In the usual flow, about one extra History row per tagging burst, since
tagged items usually embed one at a time. The job log already stores one row
per tag.
