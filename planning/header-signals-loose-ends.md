# Loose ends: header signals (`header-signals-plan.md`, shipped in 02c193b / 0d53bc4)

Post-implementation sweep, 2026-08-09 — a re-read of the landed code rather than
of the plan. All three dots, the shared watermark, the one-timer cadence, the
edge rule and the chime are built as described. What follows is what the sweep
turned up around them.

Baseline: 884 tests pass, `jobs-dot.test.js` contributing 21. Nothing below is a
red test — every defect here is in the gap between what the suite asserts and
what the plan promises.

The shape of the findings is worth naming up front, because it repeats. The
plan's central invariant is stated twice and in one sentence each time —
*fire on the edge from dark to lit* and *whatever is already lit at boot is never
news* — and **defects 1a, 1c, 2, 3 and 4 are all one thing: a rising edge
manufactured out of something that is not news.** A dot that appears late is a
dot; a *toast and a chime* that appear late are an interruption, and the second
one is what the reader learns to distrust. The rule is right. What is missing is
that four separate files can put the reader on the wrong side of it, and none of
them is visible from the module that owns the rule.

Defects **1b** and **1d** are the exception and the pair worth reading first.
Neither is an edge bug: they are a premise. The jobs modal justifies
acknowledging on every refresh with *"a failure landing while the modal is open
has been seen by definition"*, and eleven lines further down the same function
records the fact that makes it false. Two comments in one function, each correct
alone, contradicting each other — which is the one class of defect a test suite
structurally cannot hold an opinion about, and it cost the dot in two separate
ordinary states before anyone noticed there was one bug rather than two.

**Defects 1, 2, 3 and 4 are fixed** — each has a *What was done* under it, and
each grew while being fixed: 1 turned up a fourth fault, 2 turned out to be the
general case of a rule rather than two missing instances of it, 3 turned out to
be a deletion, and 4 turned out to be the source the plan learned the rule from.
Defects 5–16 are recorded and unchecked.

Three of the four are the same fault. **Acknowledge before you render and you
have manufactured a rising edge**: defect 1 dispatched between the stamp and the
mark, defect 4 marked the firings before fetching the list that displays their
marks. The rule the plan states for `.job-new` — *read before anything
acknowledges* — is the general one, and it is worth reading as a property of
every surface here rather than as a note about one watermark.

## Verified sound (checked because a break here would be silent)

- **`started_at` arrives as a number, not a bigint string.** `db.js:11` sets
  `pg.types.setTypeParser(20, Number)`. Without it node-postgres hands back
  `"1754…"` for an `int8`, and while `unseen()`'s `Number()` coercion and
  `jobRow`'s `j.started_at > newSince` would both still work by JS coercion,
  `noteStamp`'s `state.jobsFailedAt === at` identity check would not — a stamp
  fetched by the modal and the same stamp fetched by the tick would compare
  unequal every time and re-render forever.
- **The dots cannot accumulate.** `renderToolbar` builds fresh elements each
  pass, so `attachBtnDot` appends to a new node rather than stacking spans on a
  surviving one.
- **The dot is not clipped.** `#toolbar-fold` is `overflow: hidden` with
  `padding-top: 8px` / `margin-top: -8px` — headroom written for the alert dot
  and inherited correctly by the jobs chip, whose dot overhangs 4 px
  (`translate(50%, -50%)` on 8 px).
- **`.btn-dot`'s hardcoded `#fff` ring is not a latent bug.** There is no dark
  theme in `styles.css` — no `prefers-color-scheme`, no `data-theme`.
- **Board switching cannot leak a stamp.** `state.boardId` is assigned in exactly
  one place (`app.js:66`, off the URL), so changing boards is a full page load.
  `state.jobsFailedAt`, `state.facetStats` and `announce.js`'s `seen` map all
  reset with it; none of them needs a per-board reset path.
- **The import graph is what the plan claims** — checked by hand rather than by
  test (see *Documented but not built*, below). 42 modules reachable from
  `app.js`; every specifier resolves, every named binding exists, and the four
  cycles (`grid↔crates`, `kinds↔lightbox`,
  `grid→tag-editor→kinds→lightbox→grid`, `board-modal↔mapping-modal`) all
  predate this commit. `announce.js` introduced none, and neither did the
  `signals.js → jobs-modal.js` edge added by the defect-1 fix.
- **`startSignals` is idempotent**, so the `visibilitychange` listener is
  registered once — the `if (timer) return` guard covers both.
- **`lastAt` really is stamped before the await**, so a slow fetch cannot be
  double-started by the next tick.
- **`noteServerNow` refuses a missing `now`.** `Number(undefined) || 0` leaves
  `skew` alone, so an old server mid-rolling-deploy degrades to the reader's
  clock rather than writing a 1970 offset.
- **Three toasts cannot become more than three.** `toast.js` dedupes by
  message+type and caps at `MAX_VISIBLE = 3`; there are three dots.
- **The route does not shadow the log page**, and `failed_at` on the page is
  board-wide regardless of the `kind` filter. Both tested.

## Defects

- [x] **1. `ack()` and `noteStamp` are in the wrong order, and the modal's
  acknowledgement premise is only true on page one.** *(fixed)*

  Three separate faults, all downstream of the same two lines. Take them in
  order of how bad they get. A fourth turned up while fixing them and is
  recorded as 1d.

  **1a — the toast fires for a row the reader is looking at.** `noteStamp`
  (`jobs-modal.js:356-361`) writes `state.jobsFailedAt` and dispatches
  `app:render` **before** `ack()` runs at `:389`. Listener order on that event is
  `render` (`app.js:55`, module scope) → `check` (`announce.js`, registered at
  boot) → `onRender` (registered when the modal opens); `dispatchEvent` is
  synchronous, so `check()` runs to completion inside `noteStamp` while the
  watermark is still un-advanced. New stamp vs. old mark → rising edge → toast
  and chime.

  The **Open** action makes it plainer: it calls `openJobsModal`, which
  early-returns on `modalEl` (`:184`). The button's entire effect is to dismiss
  its own toast.

  The scope is narrower than it first looks, and inverted against what matters.
  `ack()` at `:399` floors the watermark at ~now on open, so this only fires for
  a job that **starts** after the visit begins — the `started_at` trade-off the
  plan accepts, seen from the other side. A tagging leg (seconds) failing during
  the visit toasts; an ingest scan or a transcription that was already running
  fails silently, because its `started_at` is below the mark. While the log is
  open the reader is interrupted about exactly the failures already on screen and
  told nothing about the ones that aren't.

  **1b — off page one, `ack()` acknowledges a row that was never drawn.** The
  comment at `:340-344` rests the whole design on *"a failure landing while the
  modal is open has been seen by definition"*. The comment eleven lines below at
  `:400-402` states the fact that makes it false: the interval *"only refreshes
  history when the reader hasn't paged deeper."* On `pages > 1` (`:406-407`) the
  branch calls `renderScheduled` and `renderLive` and never `renderHistory`, so
  a settled failure is not added to the list — but `ack()` at `:405` runs
  unconditionally, above the branch, and marks it seen on the next tick.

  A reader who clicked **Load more** therefore loses the dot for a failure that
  was never rendered anywhere. And here the toast from 1a is not the bug, it is
  the *only* notice that failure will ever get — which `ack()` then quietly
  retires five seconds later. The premise holds on page one and nowhere else.

  **1c — the chime develops the spam mode the rule was supposed to preclude.**
  `announce.js:80-84` calls `chime()` unconditionally after `toast[kind](...)`,
  but `toast()` returns `null` in two cases without showing anything:
  `_show`'s dedup (same message + type already visible, `toast.js:43`) and the
  `MAX_VISIBLE` queue (`toast.js:136`). "A job failed" is a fixed string on a
  `long` (8 s) duration.

  Normally this is unreachable — the dot stays lit, so there is no second edge.
  With the modal open, `ack()` re-arms the edge every `REFRESH_MS`. A run of
  failures 5 s apart then produces: first toast shown, every subsequent toast
  deduped away, **and a chime every five seconds** with nothing on screen to
  explain it. That is precisely the *"spam mode nobody predicted"* the plan says
  a one-sentence rule cannot develop — and the rule didn't develop it, the
  acknowledgement path did, by making the edge re-armable.

  (Related, smaller: a *queued* toast is shown later with `handle` already `null`,
  so its Open action's `handle?.remove()` is a no-op and it lingers over the
  modal it just opened — the one thing the self-dismiss at `announce.js:82` was
  written to prevent.)

  **1d — the kind filter, found while fixing 1b, and the same bug wearing a
  different hat.** The plan argues the stamp's independence from the page
  explicitly: *"Board-wide and independent of the page's `kind` filter: a reader
  who clicked the Ingestion pill must not have the dot cleared by a page with no
  failures in it."* The server honours it and `jobs-dot.test.js:276-278` pins it.
  The client then threw it away: with the Ingestion pill active, a *tagging*
  failure landing would re-render the filtered history — containing no tagging
  rows at all — and `ack()` at `:389` would mark it seen.

  So 1b and 1d are one fault. "Paged deeper" and "filtered" are two ways of
  arriving at the same state, and the state is simply: **the row is not on
  screen.**

  ### What was done

  Three changes, one per fault, plus the predicate that unifies 1b and 1d.

  - **`ack()` and `noteStamp` now mutate and report** rather than rendering
    (`jobs-modal.js`). A new `settle(moved)` runs both and dispatches once, so
    no `app:render` is ever observed with the stamp advanced and the mark
    behind it — which is the entire mechanism of 1a. `settle` evaluates both
    sides before testing, because `moved || ack()` would short-circuit past the
    acknowledgement in precisely the case that needs it.
  - **Acknowledgement on a refresh is gated on the row having been drawn**, via
    an exported pure predicate `failureDrawn(rows, failedAt)` — the newest
    failure is in the rendered list, or it was not seen. That is 1b and 1d
    together, and it needs no knowledge of pages or filters, because every state
    that hides the row hides it the same way. The **open-time** ack stays
    unconditional: opening the log is the reader's chance at whatever is in it,
    and gating that one would strand the dot on a board whose newest failure has
    scrolled off page one.
  - **The interval no longer acknowledges off page one at all.** The
    unconditional `ack()` above the branch is gone; `load(true)` acks after
    rendering on page one, and the deep-paged branch deliberately does not.
    There the toast is now the only notice, which is correct — and it survives.
  - **`chime()` only sounds for a toast that was shown** (`announce.js`).

  And one that the ordering fix alone would not have covered: **`signals.js`
  stands its `jobErrors` read down while the log is open**
  (`when: () => !jobsModalOpen()`). Fixing the order inside the modal leaves a
  second writer of `state.jobsFailedAt` outside it, and the background tick
  cannot acknowledge — it has no idea what was drawn — so roughly one failure in
  eight would still have toasted from that path. One writer at a time, and it
  falls out of the cadence layer's existing `when` gate rather than needing a new
  concept. It also deletes a request: the dialog already polls the same stamp
  four times as often.

  Tests: four cases on `failureDrawn` — the filtered page, the deep-paged list,
  an `ok` row sharing a `started_at` with the failure, and the empty/no-stamp
  states. `jobs-dot.test.js` is 25 tests, and the module graph re-checks clean
  (42 modules, no new cycle from the `signals.js → jobs-modal.js` edge).

  Not covered by a test: 1a and 1c themselves, which live in the render-ordering
  and in `announce.js` — see defect 16.

- [x] **2. `ready()` is a property of every signal, written as a special case
  for the one signal that made it visible.** *(fixed, with 3)*

  The plan states the invariant plainly — *"The baseline is taken at boot, so
  whatever is **already** lit when the page opens is never news"* — and then
  describes `ready()` as a fix for one signal's timing quirk: facet stats are
  fetched after the first paint, so they are *"still `null` when
  `startAnnouncing()` takes its first reading."*

  That is the right gate for the wrong reason. **Every** signal has a
  not-yet-known state; facet stats are just the only one where it shows up on a
  good day. The other two are fetched inside boot's `Promise.all`, so in every
  successful run they are populated before `startAnnouncing()` at `app.js:153`
  and the nullness never appears. It appears the moment a request fails — and
  then it is read as *dark* rather than skipped, which is the one reading that
  turns old news into an announcement.

  **2a — jobs.** `state.jobsFailedAt` starts `null` (`state.js:24`) and
  `refreshJobErrors` only assigns on a 2xx (`signals.js:44-50`). `null` therefore
  means *"this board has never failed"* **and** *"the fetch didn't land"*, and
  nothing downstream can tell them apart. `state.js:8` documents the opposite
  convention sixteen lines above — `facetStats: null, // null = not fetched yet`
  — so the codebase already had the distinction and this field quietly dropped
  it. `jobs-dot.test.js:60-67` pins the conflation as intended behaviour, and its
  own comment concedes what it is pinning: *"the same answer a failed fetch
  leaves behind"*. That is correct for the **dot** — a dark dot on a failed fetch
  is the right default, since there is nothing to point at — and wrong for the
  **baseline**, which is a different question asked of the same value.

  **2b — alerts.** `state.alerts` starts `[]` and `refreshAlerts` likewise only
  assigns on success, so an empty list means both *"no alerts"* and *"we don't
  know"*. Worse here than for jobs, because alerts carry a real server-side
  per-user ledger: the toast names the alert and counts the firings, so the
  failure mode is a chime and *"5 new matches for Yellow chairs"* for firings
  from yesterday.

  **The trigger is a partial boot failure, not any failure.** A total one is
  harmless: `/api/me` fails too, `state.me` is null, and `app.js:128` redirects
  to the login page before `startAnnouncing()` ever runs. What is needed is one
  of the eight boot requests failing while the rest succeed — a flaky network, a
  server mid-restart, a proxy hiccup. Narrow, and the reason it is worth fixing
  anyway is the *shape* of the failure: this is the one path in the whole feature
  where a fault produces a **louder** signal rather than a quieter one. Every
  other degradation here (a failed refresh, a swallowed autoplay, a dead
  watermark) fails towards silence. This one fails towards a chime.

  **2c — and the same failed fetch strands the item poll.** Not a baseline bug,
  but the same precondition with a heavier casualty, and it is why the
  partial-failure path deserves better than a shrug. `pollDelay()` reads
  `state.alerts.length` (`data.js:220`); with the boot alerts fetch failed,
  `ensurePolling()` at `app.js:149` sees no reason to poll and returns without
  starting. `pollTick` sets `polling = false` and nothing restarts it. Twenty
  seconds later `signals.js` fills `state.alerts` — and never calls
  `ensurePolling()`. On a board whose only poll-holder is the alert, the grid
  stops updating for the rest of the session.

  It has a second trigger that has nothing to do with boot: **an alert created in
  another tab.** Before this commit `refreshAlerts` lived inside `pollTick`, so
  discovery in that state was impossible and the old comment said so — *"a
  zero-alert tab still stops; refreshAlerts can only DISCOVER an alert created
  elsewhere while something else keeps the tick alive."* Moving it to
  `signals.js` made discovery independent, which is the improvement. The one line
  that turns discovery into action did not move with it. So the outcome is not a
  regression — it is the same end state reached with better information — but it
  is now a one-line fix rather than an architectural limit, and `pollDelay()`'s
  own rewritten comment is the argument for it: *"an alert is a standing
  statement that arrivals on this board matter, and the arrivals themselves are
  items."* `alerts-modal.js:403` already calls `ensurePolling()` when an alert is
  created **in this tab**; the cross-tab and failed-boot cases have no equivalent.

  Smaller, same neighbourhood: the alerts toast's **Open** captures `hot[0]`, an
  object out of `state.alerts`, and `refreshAlerts` replaces that array
  wholesale. `openAlertHistory` then zeroes `unseen` on an orphan, so the POST
  still lands but the dot does not clear until the next refresh reflects the
  server. The window is small — the toast lives 8 s and the tick is 20 s away —
  so it needs a hover (which pauses the toast timer) or a `visibilitychange`
  catch-up to hit.

  ### What was done

  - **`ready()` on all three dots**, fed by whether the signal's data has ever
    landed rather than by what the value happens to be. Jobs and alerts both
    live in `signals.js`, which owns their fetches, so one `landed` set there and
    one exported `signalLanded(name)` covers both. Read by `ready()` and by
    nothing else — what the *dot* should do with a value it hasn't got is a
    different question, and "stay dark" was already the right answer to it.
    Marked on a successful read **including one that reports nothing**: "this
    board has never failed" is an answer, not having asked is not, and those were
    the same value until now.
  - **Defect 3 became a deletion.** The `state.facetStats = []` fallback is gone
    rather than replaced, because the hazard it defended against does not exist —
    see 3, below. `ready: () => state.facetStats !== null` now works exactly as
    the plan describes it.
  - **2c: `refreshAlerts` calls `ensurePolling()` when the list it fetched is
    non-empty.** This is the only place a tab can learn it holds an alert without
    having been the tab that created it, so it is the only place that can restart
    the poll that discovery entitles.
  - **The alerts toast looks its alert up by id at click time** instead of
    capturing the object, so acknowledging always mutates the live one.

  Tests: the landing latch for jobs (dead network, non-2xx, and a 2xx reporting
  `null` — with an assertion that `state.jobsFailedAt` is *still* ambiguous
  afterwards, which is the point); the same for alerts, where the ambiguous value
  is `[]`; and the poll starting on discovery, with `setTimeout` stubbed so the
  scheduling is observable and no real `pollTick` is armed against the test
  server. The three landing assertions are one test rather than three, because
  `landed` is a latch and splitting them would make declaration order
  load-bearing and invisible.

  Not covered: that `announce.js` actually *reads* `ready()` this way — defect
  16 again.

- [x] **3. The facet dot's `ready()` is defeated by its own catch.** *(fixed
  with 2 — a deletion, see below)*

  `refreshFacetStats` sets `state.facetStats = []` when the first fetch fails
  (`facet-diagnostics.js:196`). That is right for the header — no dot rather than
  a broken toolbar — and it flips `ready()` true, so `announce.js` records the
  baseline as dark for a signal whose data has not landed. When the 60 s tick
  succeeds and a pre-existing finding appears, it announces as new.

  This is verbatim the failure the plan says the gate prevents: *"a signal whose
  data hasn't landed yet is skipped, not recorded dark … recording that as dark
  is exactly what would turn the arrival of a pre-existing finding into a toast a
  minute later."* The gate is correct and the sentinel it reads is overwritten by
  an unrelated concern one file away. `[]`-because-empty and `[]`-because-failed
  have to stay distinguishable through that catch.

  **And the concern turns out not to exist**, which makes this a deletion rather
  than a redesign. The catch's comment justifies the write as *"no dot rather
  than a broken header"* — but `null` was never going to break the header.
  `state.facetStats` has exactly two readers, `toolbar.js:126` and
  `announce.js:58`, and both pass it straight to `diagnosticsUnseen`, whose first
  line is `(facets || [])`. Null is already safe on every path. The line is
  defensive code against a hazard that the function it defends had already
  handled, and its only live effect is to destroy the sentinel `ready()` reads.

- [x] **4. The alert history acknowledges before it reads — twice over, and the
  plan cites it as the precedent for getting that right.** *(fixed)*

  `header-signals-plan.md` describes `.job-new` and names its source: *"The alert
  history modal's `.al-new` precedent. The watermark is read before anything
  acknowledges and frozen for the life of the dialog — **read it later and it
  always says 'nothing new'**."* The rule is correct, the jobs log follows it,
  and the file it was learned from does not.

  **4a — the acknowledgement races the list it acknowledges.**
  `openAlertHistory` fired `POST /api/alerts/:id/seen` at the top of the function
  (`alerts-modal.js:421-425`) and then, sixty lines later, `load()` fetched
  `GET /api/alerts/:id/firings` (`:479`) whose rows carry the `seen` flag that
  `.al-new` bolds on (`:452`). `markAlertFiringsSeen` marks **every** unseen
  firing for the alert, so whenever the POST's UPDATE commits first the GET
  returns a history in which nothing is new — the dot sends the reader to a list
  that cannot answer the question the dot asked.

  Measured rather than reasoned, against a local server, 25 opens per arm:

  ```
  client order (POST issued, not awaited, then GET) — .al-new lost in  3/25
  GET first, then POST                              — .al-new lost in  0/25
  ```

  Twelve percent locally, where the POST and the GET are decided by microseconds
  of scheduling. The direction under real latency is not knowable from here, and
  is plausibly worse: the POST is issued first and is by far the cheaper query
  (one UPDATE, against the GET's ownership check plus a paged select).

  **4b — and it acknowledges on hope rather than on the server's answer.** The
  local `alert.unseen = 0` was written with the POST un-awaited, `.catch(() =>
  {})`, and no `r.ok` check, while `refreshAlerts` replaces `state.alerts`
  wholesale every 20 s. A dropped or 500'd POST therefore leaves the reader
  acknowledged locally and unacknowledged on the server, and the next tick
  restores the count. Under the old arrangement — a 25 s throttle riding a poll
  that stopped on an idle board — that was a silent flicker on a dot. It is now a
  guaranteed rising edge, so it costs a toast **and a chime**, naming firings the
  reader has just finished reading.

  A second path needed no failure at all: a `GET /api/alerts` already in flight
  when the POST lands resolves afterwards carrying the pre-POST counts.

  **4c — and the object it zeroes may not be in `state.alerts` any more.**
  `appendAlertMenu` builds its rows once from `state.alerts` and captures each
  `a` (`alerts-modal.js:36-91`); the dropdown does not close on `app:render`
  (`dropdown.js` closes on outside click, Escape, scroll and resize, and on
  nothing else); and `refreshAlerts` replaces the array every 20 s. A menu left
  open handed `openAlertHistory` an orphan, and zeroing an orphan clears nothing.
  Same class as the toast staleness fixed under defect 2, with a much wider
  window — a toast lives 8 s, a dropdown lives as long as you leave it.

  ### What was done

  One reordering answers all three, and it is the same shape as defect 1's fix:
  **settle after you render, not before.**

  - `acknowledge()` now runs as `load()`'s fulfilment handler, so the firings are
    fetched, and their `seen` flags read, before anything is marked.
  - It awaits the POST and checks `r.ok`. A refusal leaves the dot lit — honest,
    silent, and self-healing, since reopening tries again. Nothing is written
    locally that the server did not accept, so there is no false zero for a
    refresh to correct into a rising edge.
  - It resolves the live alert out of `state.alerts` by id before mutating, so
    a stale object from a long-open dropdown (or a toast) cannot swallow the
    acknowledgement.
  - Two handlers rather than `.then().catch()`: the second form would report
    "Failed to load the history" for anything `acknowledge()` threw, and this is
    the one place that must not misname which request broke.

  Stated cost, because it is real: pages fetched **after** the acknowledgement
  come back all-seen, so a reader with more than one page of unseen firings loses
  `.al-new` on the Load-more pages. Those are the oldest firings and unseen ones
  are the newest, so the overlap is small. Fixing it properly means a frozen
  client-side watermark, which is what `.job-new` has — worth doing only if
  anyone ever accumulates a page of them.

  Test: `alerts.test.js` now asserts the `seen` flag in **both** directions on
  the firings list — false on a read that precedes the acknowledgement, true on
  one that follows it. It was asserted in neither, and that is a silent failure
  by construction: a list that stopped carrying `seen` would simply never bold a
  row, which looks exactly like a reader who is up to date.

  Not covered: the client ordering itself, which is DOM-bound — defect 16 again.
  The measurement above is what stands in for it, and the probe was deleted
  rather than kept, since it asserts a race rather than a rule.

- [x] **5. `latestJobFailureAt` sequentially scans the whole `job_log` table, on
  every tick, for every board.** *(fixed — migration 0032)*

  The only index is `idx_job_log_board (board_id, started_at DESC, id DESC)`
  (`0021_job_log.sql:24`), and the query is
  `WHERE board_id=$1 AND outcome='failed' ORDER BY started_at DESC LIMIT 1`
  (`db.js:latestJobFailureAt`).

  **Corrected after measuring — this entry's first write-up reasoned the
  mechanism out of the index definition and got it wrong twice.** It claimed the
  planner walks that index newest-first and stops at the first match, so a board
  with a recent failure is cheap and a clean board is expensive. Neither is true.
  `EXPLAIN (ANALYZE, BUFFERS)` over 100 k rows across two boards, one with no
  failures and one whose newest row is a failure:

  ```
  Limit  (actual time=7.734..7.735 rows=0 loops=1)
    Buffers: shared hit=1429
    ->  Sort  (actual time=7.733..7.734 rows=0 loops=1)
          Sort Key: started_at DESC
          ->  Seq Scan on job_log  (actual time=7.721..7.722 rows=0 loops=1)
                Filter: ((board_id = '…') AND (outcome = 'failed'))
                Rows Removed by Filter: 100001
  ```

  The planner does not use `idx_job_log_board` **at all**. `outcome='failed'` has
  no index and estimates as highly selective, so under a `LIMIT 1` it bets that a
  sequential scan will hit a match early — and when there are none, or one, it
  reads the lot. Three consequences, none of them what the entry first said:

  - **It scans the whole TABLE, not the board.** `Rows Removed by Filter:
    100001` on a 100,001-row table holding two boards. The cost of polling one
    board scales with every other board's history on the instance.
  - **There is no cheap case.** Clean board 7.77 ms; board whose newest row is
    the failure 7.73 ms. Identical, because the scan is unconditional.
  - **1429 buffer hits per call** — roughly 11 MB touched to answer "has
    anything failed".

  This is the route that exists *specifically* so the gallery has something cheap
  to poll: `server.js` justifies splitting it out because the log page "costs
  five queries to answer, which is exactly why /tokens is its own route too". The
  cheap route is the expensive one — and the page pays it too, since
  `latestJobFailureAt` rides that `Promise.all` as well, so an open job log
  re-scans the table every 5 s.

  With the partial index:

  ```
  ->  Index Only Scan using idx_job_log_failed (actual time=0.022..0.022 rows=0)

  clean board            7.77 ms  ->  0.05 ms
  fresh failure on top   7.73 ms  ->  0.05 ms
  ```

  ### What was done

  `0032_job_log_failed.sql` — `CREATE INDEX … ON job_log (board_id, started_at
  DESC) WHERE outcome='failed'`. Partial, not composite: the predicate *is* the
  selectivity, so Postgres walks `(board_id, started_at DESC)` among failures
  alone and stops at the first. ~165× on this data, and flat as the table grows
  rather than linear in it. The index stays small by construction — a failure is
  the rare row, so on a healthy instance it indexes almost nothing, which is
  exactly the case that used to be worst. Plain `CREATE INDEX`, like 0014 and
  0028: the runner wraps each file in a transaction and `CONCURRENTLY` cannot run
  inside one.

  Only `'failed'` is indexed because only `'failed'` is ever asked for — the
  other three non-ok outcomes are deliberately not news — and a wider index would
  be a larger one serving no query.

  Test: the query's **plan**, not a row in `pg_indexes`. The regression this
  guards is the query drifting off the index cut for it — a widened `ORDER BY`, a
  second outcome — and an existence check reads that as healthy. It asserts the
  partial index appears and `Seq Scan` does not, on a board with **no** failures,
  which is the case that used to be worst and the one a healthy instance is in.
  Pinned against `LATEST_JOB_FAILURE_SQL`, now exported from `db.js`, rather than
  a copy of the SQL: a copy would keep passing while the app's own query moved,
  and the regression is invisible from outside, since a sequential scan returns
  the right answer, slowly.

- [ ] **6. `seen-mark.js` can throw, and one caller is outside every `try`.**

  `seenAt` and `markSeen` touch `localStorage` unguarded
  (`seen-mark.js:37`, `:54`). A quota error, or a context where storage access
  itself throws, propagates. Most callers are inside a `try` by luck;
  `jobs-modal.js:399` and `:405` are not, and a throw at `:399` escapes
  `openJobsModal` after `modalEl` is set but before the render listener and the
  refresh interval are wired — leaving the dialog open, dead, and unrefreshable.

  The module is the right place to fix it: the whole point of a watermark is that
  it degrades to "no memory", not to an exception.

- [ ] **7. The first-ever open bolds the entire failure history.**

  `newSince` is `seenAt(...)`, which is `0` before any acknowledgement
  (`jobs-modal.js:203`), so a reader who has never opened the log gets every
  historical `failed` row in `.job-new`. Literally correct — none of them has
  been seen — and wrong for the one visit where the reader is learning what the
  bold means. The natural floor is the same one `markSeen` already uses: on a
  board with no watermark at all, treat the session start as the mark.

- [ ] **8. The diagnostics modal never re-acks, so it can be toasted at too.**

  `openDiagnosticsModal` marks seen once, on open (`facet-diagnostics.js:494`),
  and has no refresh loop. The 60 s tick keeps running underneath it: a finding
  written while the modal is open updates `state.facetStats`, dispatches
  `app:render`, and produces a rising edge behind a dialog whose contents are a
  one-shot fetch and will not show it. Same class as defect 1, an order of
  magnitude rarer, and it wants the same answer the jobs modal already has — an
  `ack` the refresh path calls.

## Documented but not built

- [ ] **9. The static import-graph check does not exist.** The plan closes the
  Tests section with: *"`announce.js` is not unit-tested … Its import graph is
  checked statically instead (every specifier resolves, every named binding
  exists, no cycles introduced)."* There is no such test in `test/`. The claim is
  **true** — verified by hand this sweep, see *Verified sound* — but it is
  asserted in a document and enforced by nothing, which is the worst of the three
  available states: a reader of the plan will believe a regression here is caught.

  It is also cheap: walking `public/*.js` for `import … from` specifiers and
  comparing against each target's `export` names is ~40 lines and would cover the
  whole client, not just `announce.js`.

- [ ] **10. The errors route's comment drifted in the same commit that wrote
  it.** `server.js:919-920` says *"the gallery re-reads this on the **poll
  tick**"* — it does not, that is the entire point of `signals.js`, and the
  sentence was carried over from the draft that predated it — and *"a page costs
  **four** queries to answer"*, which became five when `latestJobFailureAt`
  joined the `Promise.all` eleven lines above. The plan says five. In a codebase
  where the comments carry the argument, both are load-bearing.

## Behaviour worth a decision (no change made)

- **11. The toast is silent to a screen reader, and two of three dots never
  change their accessible name.** There is no `aria-live` region anywhere in the
  app — `#toast-wrap` is a plain `div` — so the *arrival* half of this feature,
  the half the plan says exists because the dot is missable by design, does not
  exist at all for a non-visual reader. `role="status"` on the wrap is a two-line
  change and fixes it for every toast in the app, not just these three.

  Separately, only the jobs chip renames itself when lit
  (`toolbar.js:152`, `"Job log — new errors"`). The diagnostics button
  (`toolbar.js:123`) and the plus-caret (`toolbar.js:378`) keep one
  `aria-label` in both states, so their dots are decoration. The plan's *one
  vocabulary* argument applies here more strongly than anywhere: for this reader
  the three signals currently number one.

- **12. An idle tab went from zero background requests to six a minute.** A quiet
  board with no alerts used to return `null` from `pollDelay()` and go completely
  silent. It now issues `/api/alerts` and `/jobs/errors` every 20 s forever, plus
  `/facet-stats` every 60 s for a manager on a vote-mode board — ~6–7 req/min per
  open tab, indefinitely, on a board where nothing is happening. That is the
  honest price of the plan's *"the item poll is the wrong clock"* and it is worth
  paying; it is also the one thing *"Config surface: none — nothing here
  schedules work or costs money"* does not account for, since it costs server
  load whether or not it costs dollars.

  If it wants bounding, the cheap version is an idle back-off: widen the interval
  after N consecutive ticks that changed nothing, reset on `visibilitychange` and
  on any change. The catch-up-on-return behaviour already covers the case that
  matters, so the widening is nearly free.

- **13. Clock skew is re-learned from scratch every page load, from one feeder.**
  `skew` lives in a module-level `let` (`seen-mark.js:28`) and is written only by
  `refreshJobErrors`. If that route fails at boot — the same failure as defect 2 —
  `markSeen`'s floor silently reverts to the reader's own clock, i.e. the
  documented bug is back and, being a dot that doesn't light, invisible. Two
  cheap hardenings: persist the last offset in `localStorage` so a bad boot
  inherits a known-good one, and add `now` to the `/jobs` page response so the
  open modal feeds the offset too.

- **14. The watermark keys accumulate forever.** `jobErrSeen:<board>` and
  `facetDiagSeen:<board>` are written per board and never pruned — not on board
  deletion, not on sign-out. Small, unbounded, and the kind of thing that is
  easier to decide now than to migrate later.

- **15. `ddCheckRow` sets `role="menuitemcheckbox"` and never `aria-checked`**
  (`dropdown.js:299`). Pre-existing — `admin-boards.js:318,331` got there first —
  but the notification-sound toggle is now a user-facing instance of it, in the
  menu a person opens looking for their own settings.

- **16. `announce.js` has no test of any kind, and it owns the rule.** The plan
  explains why it can't be imported under Node (`board-modal.js`'s root-absolute
  `/x.js` specifiers, reached via `alerts-modal.js`), and that reason is real. It
  is also an argument for extracting the ten lines that matter rather than for
  leaving them unpinned: `check()` is pure state→edge logic over an injectable
  `DOTS` table.

  The four cases worth pinning are exactly the four this sweep found bugs in —
  baseline suppression, `ready` skipping a not-yet-loaded signal, no re-fire
  while a dot stays lit, re-fire after acknowledgement. **Defects 1–4 would all
  have failed that file.**

  One caveat the sweep found while re-tracing defect 1: a test of `check()`
  alone would have caught 1a and 1c but **not** 1b or 1d, which are not
  edge-rule bugs at all — they are a claim in a comment (*"seen by definition"*)
  that another comment in the same function contradicts. No unit test of
  `announce.js` sees that. Those two needed reading the comments against each
  other, which is what a sweep is for and a suite isn't. The fix did leave them
  testable, though: `failureDrawn` is a pure predicate now, and the four cases
  under defect 1 pin it.
