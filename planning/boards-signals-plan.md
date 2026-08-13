# Boards page signals — one dot per board, at the index (2026-08-13)

**Status: SLICES 1–4 BUILT (2026-08-13); remaining: 5 (in-app verify by a
human).** Suite 1173 pass / 0 fail, up from 1127, with 46 new tests:
`ticker.test.js` (9), `boards-signals.test.js` (15), `board-signal.test.js`
(17), `boards-page.test.js` (5). New: `public/ticker.js`,
`public/board-signal.js`, `server/migrations/0037_alert_firings_unseen.sql`.
Touched: `signals.js`, `seen-mark.js`, `jobs-modal.js`, `facet-diagnostics.js`,
`boards.js`, `boards.css`, `styles.css`, `db.js`, `server.js`,
`facet-diagnosis.js`.

Four things the build settled that this plan did not predict, each recorded where
it belongs below: the alert query needed an index after all (**Measured**), the
watermark scope names had to move into `seen-mark.js` to stop the index drifting
from the gallery (**The watermark**), `boards.js` had to give up its
root-absolute import specifiers before any of it could be tested (**Tests**),
and — the one that was a defect in the plan rather than a gap — **the
`aria-label` this document specified would have deleted the card's existing
accessible name** (**UI**).

`header-signals-plan.md` built three dots that all mean *there is unread news
behind me*, gave them one cadence, one watermark and one voice, and closed the
question of scope with a single line:

> **No cross-board signals.** Everything is scoped to the open board. The boards
> overview shows nothing.

This reverses that line, and only that line. Everything else the header signals
decided — what counts as news, when it refreshes, how it is acknowledged — is
kept, and most of it is kept *by reusing the same storage rather than by
agreeing to behave the same way*.

The gap is plain once `/boards` exists (`boards-page-plan.md`): a member with
eight boards has eight galleries' worth of dots and no way to see any of them
without visiting eight galleries. The signals are *ambient* by construction —
"nobody goes LOOKING for any of them" — and the index is the one page where the
question *which board wants me* is the question the reader actually has.

## Decisions made up front

- **One dot per card, not three.** At index altitude the question is *which
  board do I go to*, not *what kind of news is it*. The gallery answers the
  second question already, and that is the right division: the index routes,
  the board explains. The card also already carries up to three capability
  chips, and three more marks on it would be unreadable.
- **The index does not acknowledge.** There is no gesture on `/boards` that
  clears a dot. It clears when you visit the board and open the surface — which
  is what the dot was asking for, so the acknowledgement and the action are the
  same act. This is a real cost and it is stated below.
- **No toast, no chime.** The dot *is* the arrival at the index. See *No voice*.
- **The watermark is not touched** — *revised in build: the keyspace moved, the
  keys did not.* The scope names lived as a private `const SEEN` in
  `jobs-modal.js` and another in `facet-diagnostics.js`, which was fine while
  each string had exactly one writer. The index reads both, so each now has
  readers in two files, and a third copy in a third file would drift the first
  time one moved — silently, since a changed scope re-lights every dot once and
  is indistinguishable from news. `JOBS_SEEN` and `DIAG_SEEN` are now exported
  from `seen-mark.js`, which already owned the key builder; the two surfaces
  import them. **The stored strings are unchanged**, so no reader's mark resets.
- **The watermark keys are not touched.** `seen-mark.js` keys on
  `${scope}:${boardId}` and has since it shipped, so the index dot and the
  gallery dot for the same board are already **the same dot** — same key, same
  comparison, no synchronisation, no new state. That is the whole trick, and
  every other decision here is downstream of it.
- **One cadence, still.** The header-signals argument was *"when does this dot
  refresh" should have one answer*. A second, hand-rolled timer on `/boards`
  with its own hidden-tab handling would be that argument's failure one level
  up. The scheduler is extracted; the signal tables stay separate.

## What the index dot means

Lit when **any** of the three, for that board, is unseen:

| signal | index source | fidelity | gate |
| --- | --- | --- | --- |
| job failure | `failed_at`, the same `latestJobFailureAt` | exact | board members |
| alert firings | `alerts_unseen`, the same per-user sum | exact | the alert's owner |
| tagging finding | `diagnostic_at`, from the stored JSONB | **approximate** | manager + vote mode |

Two of the three are exact because their source is a single stamp or a single
sum that generalises to a set with a `GROUP BY`. The third is not, and it is the
most interesting decision in this plan.

### The tagging finding is approximated, in both directions

The gallery's dot lights on `diagnosticsUnseen`, which resolves each facet
through `diagnosisState` and keeps only `finding` and `improved`. That resolution
needs the **live** segment — `items`, `unanimous`, `queued`, `stale` — which is
`facetRollup`: two aggregate queries per board, and the endpoint that was a
611 ms problem before it was cut down. Running it once per board on a background
tick would make the index's cheap route the expensive one, which is exactly the
mistake `header-signals-loose-ends.md` defect 5 records against
`latestJobFailureAt`.

So the index reads `boards.facet_diagnostics` instead — a JSONB column
`listBoards` **already selects** (`BOARD_COLS`), so it costs nothing beyond the
read the route is doing anyway. From an entry alone the following are exact:

- `verdict`, and therefore the exclusions: `no-problem-found` is not news, and
  `genuinely-ambiguous-items` is deliberately excluded upstream too — it is
  information, not a task, and *"a signal that reads as a to-do and resolves to
  'nothing you can do' teaches the reader to ignore the signal."*
- `explanation` present — the `renderable` half of the gallery's test, verbatim.
- `stale` — authoritative, written by `supersedeFacetDiagnostics` the moment a
  retag is armed. **This is the load-bearing one**, because a retag is the main
  way a stored finding stops describing what is measured now, and the flag
  covers it exactly rather than approximately.

What cannot be computed without the live segment, and what each costs:

- **Over-lights**, and *revised in build: there are three of these, not one.*
  This plan named only the item minimum, but `diagnosisState` gates a finding on
  `row.current !== false && rate >= minRate` **after** that check, and all three
  operands are the live segment:
  - items below the minimum → the gallery says `awaiting`, or `measuring` with a
    pass draining. The one named here originally.
  - the live contested rate has fallen below the floor → the gallery says
    nothing at all. Probably the commonest, and the one the original write-up
    walked right past: hand curation fixes contested items without touching the
    definition, so there is no `previous` to make it `improved` and the sample
    need not have shrunk at all. (`setItemTags` deletes a corrected facet's
    confidence entry rather than re-stamping it — `facet-diagnosis-loose-ends.md`
    §10's sampling bias — which is the *same* mechanism reaching the *other* of
    these two cases when it goes far enough.)
  - `current === false` → `rateHeld`, the server's own "the evidence has moved"
    answer, from that same segment.

  All three fail the same way, towards *a dot on a board that has a stored
  finding in it*, which is not a lie so much as a coarser truth. Narrow was the
  wrong word for it; **consistently coarse** is the right one, and the direction
  is what the fidelity argument actually rests on.
- **Under-lights** the `improved` state where the verdict was demoted away. A
  demotion sets `previous` and deliberately does **not** carry the verdict, so
  an improved-but-undiagnosed facet has no verdict for this filter to see. The
  index will miss it; the gallery will not. Accepted: `improved` is good news,
  and good news is the one thing an index dot can afford to be late about.

Both directions are stated because a signal whose failure mode is undocumented is
how a reader learns to distrust it. **If the fidelity ever grates, the fix is not
N roll-ups at read time** — it is for the diagnose loop, which holds the live
segment at the moment it writes the entry, to stamp what it resolved to. Read
time cannot get cheaper; write time already has the data.

## The endpoint

```
GET /api/boards/signals -> [ { board_id, failed_at, alerts_unseen, diagnostic_at } ]
```

`requireAuth`, registered **before** `/api/boards/:id` so the literal path is not
captured as an id — the `/overview` precedent, and the same access filter:
`listBoards` then `canAccessBoard` per board through the shared helper, fanned
out with `Promise.all`. Not a batched `board_members` read, for the reason
`/overview` already gives: *a second authorization path is exactly the thing that
drifts.*

*Built as a shared `accessibleBoards(user)`.* Writing the filter out a third time
was what made it obvious it should not be written out at all — `/api/boards`,
`/overview` and this route all wanted it, and the first two had already drifted
into a sequential loop and a parallel one. All three now call the helper, which
is also where that argument lives.

**`canManageBoard` is asked lazily**, which matters on a polled route and not on
`/overview`. The diagnostics gate has a cheap half already in memory (`ai_votes`,
`facet_diagnostics`) and an expensive half (`canManageBoard`), so the cheap half
runs first and the query is issued only where its answer can still change the
output — on a typical instance, where `ai_votes` defaults to 1, that is no boards
at all. `/overview` emits `manage` for every board and so consumes every lookup;
this route was discarding one per board per minute per open tab. Not a cache and
not a second authorization path: the same helper and the same rule, asked in
fewer places.

**Its own route rather than fields on `/api/boards/overview`.** The overview
answers a page: entity counts and a LATERAL preview stack. This is re-read on a
background tick, and re-fetching the preview stack every minute to learn whether
a job failed would pay for a thumbnail collage nobody asked to see again — and
would churn the rendered `<img>` set on every tick. This is the `/jobs/errors`
split, restated: *"the gallery re-reads it on a background tick and a page costs
five queries to answer, which is exactly why `/tokens` is its own route too."*

**One entry per accessible board, always, nulls included** — not only boards with
news. Absence would then mean both *nothing here* and *not in the response yet*,
and this feature has already paid for that conflation twice (`landed`,
`state.facetStats`). One shape, one meaning: an entry is an answer.

**No `now`, and this is worth writing down because copying it is the obvious
move** — the first draft of this plan did, with a justification that does not
survive reading `seen-mark.js`. `/jobs/errors` carries the server clock because
`markSeen` floors the watermark at `serverNow()`, and a reader's own clock would
write a mark into the future. **The index never marks.** It only ever calls
`unseen()`, which is one stored number against one server stamp with no clock of
the reader's anywhere in it. A `now` here would be a field with no reader, and
`noteServerNow` fed from a page that never writes a watermark would move an
offset for nobody. If the index ever gains an acknowledgement gesture it gains
`now` in the same commit — and not before, because a field carried "for
consistency" is how the next reader concludes the index must be flooring
something.

A bare array rather than `{ boards: [...] }`, matching `/api/boards` and
`/api/boards/overview`, now that there is no envelope-level field to carry.

**`diagnostic_at` is gated server-side**, to `null` unless the requester manages
the board *and* `ai_votes > 1`. Not a client-side filter: `/facet-stats` is
`requireBoardManager`, and emitting "there is a finding on this board" to a plain
member through the index would quietly widen an access boundary that route was
drawn to hold. Note the consequence honestly — `canSeeDiagnostics`'s two operands
now appear on the server too. They are not shared, because they answer different
questions: the client's decides whether a *button* is drawn, the server's decides
whether a *fact is disclosed*. Only the second is a security boundary.

### Queries — three, set-wise

1. **Failures.** LATERAL over `unnest($1::text[])`, the shape
   `boardPreviewFaces` already uses, so migration 0032's partial index
   (`(board_id, started_at DESC) WHERE outcome='failed'`) is walked per board and
   stops at the first row.
2. **Alerts.** `listAlerts`'s correlated subquery generalises to one grouped
   read over the requester's alerts:
   `... FROM alerts a JOIN alert_firings f ON f.alert_id=a.id AND NOT f.seen
   WHERE a.user_id=$1 GROUP BY a.board_id`. Boards with no alerts are simply
   absent from the result and read as 0.
3. **Diagnostics.** No query — `facet_diagnostics` rides in on the `listBoards`
   the access filter already ran.

### Measured, 2026-08-13

Both plans were measured with `EXPLAIN (ANALYZE, BUFFERS)` rather than reasoned
about, on the precedent of defect 5 in `header-signals-loose-ends.md`, whose
first write-up derived a plan from an index definition and *"got it wrong
twice"*. 100k `job_log` rows across 12 boards; 60k `alert_firings` across 20
users. Both questions the plan asked have answers, and they are different
answers.

**The failure sweep is exactly what was hoped, and the LATERAL earns its
keep.** 0032's partial index is walked per board (`Index Only Scan using
idx_job_log_failed`), and the shape matters more than expected once a board has
real failures:

```
                          12 boards, 2 failures   12 boards, 20k failures
LATERAL over unnest              0.099 ms                 0.268 ms
GROUP BY + MAX                   0.103 ms                10.057 ms
```

Equivalent on a healthy instance, **37× apart on an unhealthy one** — the
aggregate has to sort every failed row on the board to take a `MAX`, while the
LATERAL stops at the first. 11 boards that have never failed: 0.078 ms, no
sequential scan anywhere. The claim that this form is flat in the failure count
is now measured rather than asserted.

**The alert sweep needed an index, and the argument for it is the direction it
fails in.** `idx_alert_firings_alert (alert_id, fired_at DESC)` does not serve a
`NOT seen` aggregate — that index is ordered for the history list, and this read
does not care when anything fired. At 24k firings with a quarter unseen the
planner chose `Seq Scan on alert_firings`: 1.66 ms and 694 buffer hits, over
*every user's* firings, to answer a question about six numbers.

The reason that is worth a migration rather than a shrug: the planner reaches
for the scan **when a large share of firings are unseen**, which is precisely
the state of a reader with a lot of unread news — the reader the dot exists for.
The query gets slower the more it has to say. On a healthy instance (4% unseen,
60k firings) it already finds a nested loop and takes 0.374 ms; with the index
that is 0.177 ms and 143 buffer hits, and the pathological case stops existing.

**`0037_alert_firings_unseen.sql`** — `(alert_id) WHERE NOT seen`. Partial, and
on `alert_id` alone: the predicate *is* the selectivity, and the sum reads
`entity_count` off the heap either way, so more columns would buy a bigger index
and no early termination. 40 kB against a 4.5 MB table, and it shrinks every time
somebody opens a history — the same by-construction smallness 0032 gets from a
failure being the rare row. Plain `CREATE INDEX`, since the runner wraps each
file in a transaction and `CONCURRENTLY` cannot run inside one.

## The cadence

**60 s, plus a `visibilitychange` catch-up, and no faster.** The gallery's 20 s
buys freshness on a page you are working in; the boards page is *"a lobby, not a
dashboard"* by its own plan's decision, which shipped it with no poll at all.
One tick a minute honours the freshness argument — which is almost entirely about
*returning to a tab*, and which the catch-up covers outright — without turning
the lobby into a dashboard. It is also one request per minute against the
gallery's six to seven, which is the number `header-signals-loose-ends.md`
defect 12 already flags as this feature's honest and unaccounted price.

**The scheduler is extracted, the signal tables are not.** New
`public/ticker.js`: `createTicker({ tickMs, signals, onBatch })`, holding
everything that is a *policy about when* rather than a fact about any signal —
the `document.hidden` gate, the immediate `visibilitychange` catch-up, `lastAt`
stamped **before** the await so a slow fetch cannot be double-started, the
per-signal `.catch` backstop (a rejection inside a `setInterval` callback has
nothing waiting to catch it), and one `onBatch` per batch rather than one per
signal. `signals.js` keeps its three board-scoped entries, its `landed` latch and
its `app:render` dispatch, and becomes a caller. `boards.js` declares one entry
at 60 s and re-renders its own dots.

This is the one refactor in the plan and it is a **pure extraction — no
behaviour change** — so it gets its own slice and is verified by the existing
suite before anything is built on it.

`boards.js` cannot simply import `signals.js`: that module's tick early-returns
on `state.boardId` and every entry in its table is a board-scoped fetch. The
import weight is *not* the objection here (`data.js` pulls only `state` and
`utils`) — the objection is that its table is the gallery's table.

**A failed refresh keeps the last known signals**, the rule `refreshAlerts`
already states as *"keep the last known counts"*. Nothing on the index goes dark
because a request failed; a dot that vanishes on a network blip is the one
failure direction this feature has consistently refused.

**No ticker on a page with no cards.** A member with zero boards gets the *"ask
an admin for access"* empty state, and a minute-by-minute poll asking after
signals for nothing is the purest form of the cost defect 12 objects to. The same
guard covers the grid having failed to load: no cards, nothing to paint, nothing
to fetch for. This is `signals.js`'s `if (!state.boardId) return` at the index's
altitude.

**The board set can drift under the map.** The signals response and the rendered
grid come from two fetches a moment apart, and a board can be created or deleted
between them (or by this very page's *New board* button). The map is keyed by
board id and consulted per card, so the mismatch resolves itself in both
directions without a reconciliation step: a signals row for a board with no card
is never read, and a card with no signals row has no dot. Worth stating only
because the alternative shape — an array positionally aligned with the grid —
would put the wrong board's dot on the wrong card, and would do it rarely.

**The per-tick authorization cost is real and bounded by board count.** The route
runs `canAccessBoard` per board, once per tick, for every open index tab. A
global admin short-circuits without querying at all; a member with eight boards
pays eight cheap lookups a minute. That is acceptable at the sizes this app is
built for, and it is named here rather than discovered, because it is the term
that grows with the thing the page is *for*. Caching the accessible set per
session is the obvious lever if it ever bites, and it is a lever this plan
deliberately does not pull — see the loose ends.

## No voice at the index

The gallery's toast exists because *"a dot is a standing fact and it is missable
by design: small, quiet, in a header you aren't looking at."* On `/boards` that
premise is false — the dots are the page's content, in the reader's field of
view, on cards they came here to look at. The toast would be a second copy of
what is already on screen, which is precisely the reasoning that makes the
gallery's toast dismiss itself when its Open is clicked.

Two more reasons, either sufficient on its own:

- **An Open action at the index is a navigation.** It would take the reader off
  the page they just opened, to the board they were in the middle of choosing
  between. The card is already a link; that is the affordance.
- **The baseline does not scale.** *"Three toasts on arrival would be the
  feature's worst first impression"* — at the index it is three per board. And
  since the baseline is taken at load and the reader is on this page for
  seconds, the only edge the index could ever fire on is news landing during
  those seconds. A rule that can only fire in a window nobody is in is not a
  rule worth the code.

`announce.js` therefore does not travel, which is also the honest reading of its
import graph: it reaches `alerts-modal.js` → `filters.js`, `board-modal.js`,
`alert-event.js`, and every one of its `say()` handlers opens a modal that only
exists in the gallery.

## UI

- **The dot** — `attachBtnDot` from `utils.js`, unchanged, on `.bc-wrap`. Same
  8 px red circle with the white ring, same corner treatment as all three header
  dots. `boards.html` already loads `styles.css`, so the circle itself costs no
  new CSS, and `.bc-wrap` is already `position: relative` for the pencil.
- **Placement: top-left of the card**, because top-right is the manage pencil's
  and they must not collide or trade places on hover. The pencil is
  hover-revealed and the dot is permanent, so the dot is the one that cannot
  move. `.btn-dot` hardcodes `top: 0; right: 0` with `translate(50%, -50%)`, so
  this is one override rule in `boards.css` (`.board-card .btn-dot { right: auto;
  left: 0; transform: translate(-50%, -50%) }`) rather than a parameter on
  `attachBtnDot` — the header has three callers that all want the right corner,
  and a knob added for the fourth would be a knob three callers pass the same
  value to.
- **Not inside the `<a>`.** Same reasoning the pencil already carries: the dot is
  a sibling in `.bc-wrap`, absolutely positioned over the card. It is
  `pointer-events: none` already, so it cannot eat a click on the link.
- **The card names what it has** — *revised in build; the plan's own answer here
  was a regression.* It said `.board-card` gains an `aria-label` of the form
  `People — new job failure, 5 new alert matches`. **`aria-label` REPLACES an
  element's content-derived name.** The card's name today is composed from what
  it contains — the board name, "247 items", a connector chip — so labelling the
  link would have collapsed all of it to whatever the dot chose to say, on every
  card, including the dark ones that had to carry a label too under that scheme.
  A sighted reader keeps the count; a screen-reader user loses it. That is the
  wrong trade and it was invisible in the plan, because "add an aria-label" reads
  like an accessibility improvement.

  The signal is an ADDITION to what the card says, so it is added as content: a
  `.bc-signal-note` span inside the link, hidden by a shared `.vis-hidden`
  utility, and the browser composes the name — *"People 247 items … a job failed,
  2 new alert matches"*. The clip utility lives in `styles.css` beside `.btn-dot`
  rather than in `boards.css`, because the loose end below already names its
  second caller: the gallery header's dots need the same thing, on pages that do
  not load `boards.css`, so scoping it here would guarantee a duplicate — and a
  duplicated clip block is exactly the kind that drifts into `display: none` and
  silently leaves the accessibility tree.
  It also disposes of the stale-label failure mode outright, since there is no
  attribute to leave behind: the node is removed and rebuilt on exactly the same
  terms as the dot, so the two cannot disagree about what is lit.

  This is still the fix `header-signals-loose-ends.md` defect 11 asks for and
  never got — two of the three header dots *"keep one `aria-label` in both
  states, so their dots are decoration"* — with one dot at the index, so one
  place to say it.
- **And the sighted half of the same problem**, which this plan filed as a loose
  end and should not have: a bare red dot with no text anywhere on the page is
  unreadable to the reader who *can* see it. The dot carries a `title` with the
  same wording. On the dot rather than the card, because a card-wide tooltip
  would fire on every hover and collide with the one `.bc-name` already has.
- **`z-index: 6` on the dot.** `.btn-dot` ships without one, and a positioned
  element at `auto` paints below any positioned sibling with a positive z-index —
  which the preview tiles have (1–4), clipped to `.bc-face`, the box the dot's
  inner half overhangs into. Above the pencil's 5 for the same reason.
- **The dot lands after the grid.** The overview and the signals fetch fire in
  parallel on boot; the grid renders on the overview, and the dots attach when
  signals land. This is the `diagnosticsBtn` / ingest-chip pattern verbatim:
  *"the button is drawn immediately either way, and only the dot waits."* If the
  signals fetch fails outright the page is the page, dotless — no toast, no
  inline note. Only the *grid* failing is content-level enough to say so.

### The paint contract

Two facts about `boards.js` make this the part most likely to ship broken, and
neither is visible from the endpoint.

**The grid re-renders from scratch, on a path that has nothing to do with
signals.** The manage pencil calls `openBoardModal(b.id, { onSaved: render })`,
and `render()` ends in `grid.replaceChildren(...boards.map(cardFor))`. So editing
any board's settings rebuilds every card — and dots attached once when the fetch
landed would vanish, silently, until the next tick up to a minute later. Editing
a board is *exactly* the moment a manager is looking at these cards.

So the last signals response is held in a module-level `Map<boardId, row>` and
**that map is the only source**: `cardFor` consults it while building, so any
re-render re-applies dots for free. This is the same property the gallery gets
from `renderToolbar` rebuilding fresh elements each pass — stated here because on
this page it has to be arranged rather than inherited.

**And the tick must not re-render the grid.** Rebuilding every card once a minute
would churn the whole `<img>` set — re-running `loading="lazy"`, re-triggering
the `onerror` slot-handover, and re-animating the fan — to move a red circle. The
tick updates the map and calls a `paintDots()` that reconciles dots on the cards
already on screen.

**Which means the accumulation guarantee does not transfer.**
`header-signals-loose-ends.md` verified *"the dots cannot accumulate"* for the
header, and the reason it gives is entirely about the gallery's render model:
*"renderToolbar builds fresh elements each pass, so `attachBtnDot` appends to a
new node rather than stacking spans on a surviving one."* `paintDots()` appends
to **surviving** nodes, so it must remove before it adds — the `.btn-dot` span
*and* the `has-dot` class `attachBtnDot` sets alongside it — or a board with a
standing failure grows a dot per minute. The `aria-label` is re-derived in the
same pass for the same reason: painted in place and left alone, it goes stale the
first time a second signal lights.

Two writers, one map, and the invariant that keeps them honest: **a full render
and a paint must produce the same DOM.** If they can disagree, the bug only
appears after a settings save, which is the hardest possible way to find it.

## What this deliberately doesn't do

- **No per-signal dots or counts on the card.** One mark, one meaning. A count
  would need `alerts_unseen` to speak for a stamp-based signal it cannot
  summarise, and the header already refused a count for the same reason.
- **No acknowledgement at the index.** Stated as a cost, because it has a real
  case: a manager who has read a finding and chosen to live with it clears it in
  the gallery and the card follows, but there is no way to dismiss from the card
  itself. Adding one would mean an index gesture that marks news read **without
  showing it** — the exact failure `failureDrawn` was written to prevent one
  level down.
- **No dot on the gallery's board switcher.** The natural next surface: an "All
  boards" row that lights when any *other* board has news. Cheap once this route
  exists, and deliberately out of scope — it adds a request to the gallery's
  tick, which is the budget defect 12 is already unhappy about. Loose end.
- **No new watermark keys and no server-side ledger** for jobs or diagnostics.
  The index reuses `jobErrSeen:` and `facetDiagSeen:` exactly as written. A new
  key would be a second answer to *have you seen this*, and the two would drift
  the first time one was written without the other.
- **No exact diagnostics fidelity.** Argued above, in both directions.
- **No ordering or filtering by signal.** "Boards that want you first" is a sort,
  and sorting the index is `board-sorting-plan.md` territory.

## Config surface

None. One route, no env knobs, no new `localStorage` keys, and one migration
(`0037`) that measurement asked for. The cadence is a load decision, not a
preference —
and the sound preference (`notifySound`) is untouched because the index has no
sound.

## Tests

**`test/boards-signals.test.js`** — the route, on the `helpers.js` harness:

- Access: a member gets only their boards; a global admin gets all; anonymous is
  401. One entry per accessible board **including boards with nothing**, since
  that shape is what makes absence unambiguous.
- `failed_at` agrees with `latestJobFailureAt` per board, and is board-scoped —
  a failure on board A must not light board B. The exclusions ride along:
  `requeued` / `discarded` / `interrupted` / `running` are not news here either,
  which is asserted rather than assumed, because this is a second query
  answering the first one's question.
- `alerts_unseen` is **per user**: two users with alerts on one board, each
  seeing their own sum and not the other's. This is the assertion that catches a
  `GROUP BY board_id` that dropped its `user_id` filter, which would be a
  cross-user leak that every single-user test passes.
- `diagnostic_at` is `null` for a non-manager, `null` on a board with
  `ai_votes = 1`, and set for a manager on a vote-mode board — the disclosure
  gate, tested as a gate.
- The JSONB filter: `no-problem-found` and `genuinely-ambiguous-items` do not
  light; a `stale` entry does not light; an entry with a verdict and no
  `explanation` does not light; the newest qualifying `at` wins across facets.
- **The query plan**, following 0032's precedent: the partial index appears and
  `Seq Scan` does not, on a board with **no** failures — the case a healthy
  instance is always in and the one that used to be worst. Pinned against the
  exported SQL constant rather than a copy, since a copy keeps passing while the
  app's own query moves, and the regression is invisible from outside — a
  sequential scan returns the right answer, slowly.

**`test/ticker.test.js`** — the extraction. Nothing runs while hidden; `ready`
gates the whole ticker; `start()` stamps so the first tick is a refresh; a signal
is not fetched more often than its own `every`; `when` skipping leaves `lastAt`
alone so the signal is due on the *next* tick; `lastAt` is stamped before the
await; a rejecting signal takes neither the batch nor `onBatch` with it;
`onBatch` fires once per batch and not at all when nothing is due; `start()` is
idempotent. Every one is behaviour `signals.js` had and none of it was pinned —
which is the argument for doing the extraction as its own slice.

*Built without a fake clock.* Each case is a property of ONE tick, so the ticker
returns its `tick()` and the tests drive that, choosing intervals (`every: 0` for
always-due, a large one for never-due) rather than mocking time — a fake clock
would add a moving part to tests whose subject is exactly the handling of time.
Two things the writing turned up, both worth keeping: at `every: 0` a signal is
due on every tick *by definition*, so the double-start case needs a real interval
or it pins nothing; and a `setInterval` stub must return a **truthy** handle,
because the double-start guard is `if (timer) return` and a stub returning `0`
reports a bug no browser can have.

**Client rollup** — the index predicate is a pure function over one signals row
plus the watermarks, so it is testable the way `failureDrawn` is: lit on each of
the three alone; dark when all three are acknowledged; the diagnostics component
dark for a `diagnostic_at` of `null` however old the watermark is (the
server-side gate arriving as data, not as a second client test); and **the
cross-surface assertion that is the whole point** — `markSeen("jobErrSeen",
board, stamp)`, as the gallery's job log writes it, darkens the index dot for
that board with no other state changing.

**The paint contract**, which is DOM-bound and therefore the part most likely to
go untested — the three failures in that section are each one assertion:

- Two consecutive paints with the same signals leave **one** `.btn-dot`, not
  two. This is the accumulation guarantee the header gets for free and this page
  has to earn.
- A full re-render (the `onSaved: render` path) produces the same dots as a
  paint — asserted by rendering, painting, and comparing, so the invariant is
  pinned rather than described.
- A signal going dark removes the dot **and** the `has-dot` class, and re-derives
  the `aria-label`. A stale accessible name is the failure that no visual check
  catches, which is exactly how defect 11 survived a whole feature.

`jobs-dot.test.js` and `announce.test.js` must pass unchanged through the
ticker extraction. If either moves, the extraction was not pure. *(They did.)*

**The paint assertions were verified by mutation rather than assumed**, which is
the practice `header-signals-loose-ends.md` defect 16 argues for after a test
that would have proved nothing. Deleting the remove-before-add line fails
exactly three cases — accumulation, going dark, and render-vs-paint — and no
others.

**`test/boards-page.test.js` — added in build, and not in this plan.** The plan
tested the rollup and the paint and left the module that *wires them* uncovered,
which is where the ordering risk actually lives: `boards.js` runs its boot block
at the top of the file and declares the maps that block depends on below it, so
anything evaluating a step early lands in a temporal dead zone — invisible to
every other test here and total in the browser, a blank page. The page now boots
under Node behind a browser shim: a card per board, the board id on the wrapper,
exactly one dot, the accessible name, and the ticker armed once.

**That required giving up `boards.js`'s root-absolute import specifiers.**
`/api.js` and friends resolve against the origin in a browser and against the
*filesystem root* under Node, so the module could not be imported at all. Made
relative, which changes nothing in a browser — a module specifier resolves
against the importing module's URL, never the document's — and `boards.html`
keeps the absolute form on its `<script src>`, which genuinely is
document-relative. Exactly the change and the argument `board-modal.js` was
given for `announce.test.js`. The admin family still carries the old form; see
the loose ends.

## Slices

1. ✅ **The ticker.** Extract `createTicker` from `signals.js`; `signals.js`
   becomes its first caller. No new behaviour, no new surface. Green suite
   including `jobs-dot.test.js` is the acceptance criterion, plus
   `ticker.test.js`.
2. ✅ **The route.** `GET /api/boards/signals` + the two db helpers, with
   `EXPLAIN (ANALYZE, BUFFERS)` on both new queries recorded in this document
   before the slice closes. `boards-signals.test.js`. *Closed with migration
   0037, which the measurement asked for and this plan did not predict.*
3. ✅ **The dot.** `boards.js` fetches signals in parallel with the overview,
   attaches one dot per card, names it on the card's `aria-label`/`title`.
   Static — no tick yet, so the fetch and the render are verifiable alone.
4. ✅ **The cadence.** The 60 s ticker on `/boards`, the `visibilitychange`
   catch-up, `paintDots()` reconciling in place, keep-last-known on failure, and
   no ticker at all with no cards on the page.
5. ⬜ **In-app verify.** As a plain member and as a manager, on a board with a real
   failed job and a real fired alert: the dot appears; opening the job log in
   that board's gallery and returning to `/boards` finds it dark; a member sees
   no dot from a finding they cannot see; a background tick moves a dot without
   a reload. Two specifically: **edit a board through the pencil and confirm the
   dots survive the save**, and leave the tab backgrounded for several minutes
   and confirm the returning card carries one dot rather than five.

## Loose ends

- **The admin family still imports root-absolute.** `admin*.js`, `profile.js`,
  `plugin-modal.js` and `plugin-add-modal.js` carry ~30 `/x.js` specifiers
  between them. `boards.js` was converted because this feature put code in it and
  that code needed testing; converting the rest is the same one-line change per
  import and the same argument, and it would make those pages importable too.
  Deliberately not swept here — it is a change to six files this feature does not
  otherwise touch.
- **The board switcher dropdown** — see *deliberately doesn't do*. The cheapest
  version rides the gallery's existing tick with one added request, and the
  honest version waits until defect 12's idle back-off exists.
- **Denormalising the diagnostics verdict at write time** — which closes ONE of
  the two divergences, and the distinction is worth keeping because the phrase
  sounds like it closes both. The **under-light** (`improved`, whose verdict a
  demotion drops) is a write-time fact, so a flag the loop stamps would fix it.
  All three **over-lights** are caused by the live segment moving *after* the
  write, so no stamp can see any of them: they need an invalidation **event**,
  the way `stale` works only because `supersedeFacetDiagnostics` has a retag to
  hang on. Nothing fires when curation quietly moves a facet's sample or its
  rate, so that event has to be invented first — a design question, not a
  denormalisation.
- **Defect 11's other half.** This plan fixes the accessible name at the index;
  the diagnostics button and the plus-caret in the gallery header still keep one
  `aria-label` in both states, and there is still no `aria-live` region for the
  toast anywhere in the app.
- **Ordering by signal** — `board-sorting-plan.md`.
- **Caching the accessible board set per session**, which is the lever for the
  per-tick authorization cost. Not pulled here, and the reason is the one
  `/overview` already gives about batching: an authorization answer that is
  *stored* is an authorization answer that can go stale, and a member removed
  from a board would keep seeing its signals for as long as the cache lived.
  Worth doing only with an invalidation story, which is a bigger question than
  this page's.
- ~~**The index shows nothing about *why* a board is lit** beyond the accessible
  name.~~ *Closed in build — it was not defensible.* A red dot with no text
  anywhere is not a restrained design, it is an unexplained one, and the cost of
  fixing it was a `title` on the dot. The reasoning that parked it (the card
  already carries three chips and a count) argued against adding another *visible*
  element, which a tooltip is not.
- **The diagnostics approximation is not tested against the real thing.** The
  JSONB filter's rules are pinned, but nothing asserts they agree with what
  `facetRollup` → `diagnosisState` would say for the same board. Both documented
  divergences (over-lighting an `awaiting` facet, under-lighting `improved`) are
  therefore reasoned rather than measured. A test would need to seed
  `tag_confidence` to move the live segment under a stored finding, which is real
  work; it is the honest next thing if the dot is ever reported as lying.
- **An idle back-off** for both tickers, which the extraction makes a one-place
  change rather than two.
