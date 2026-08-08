# Header signals — three dots, one notification layer (2026-08-09)

Three separate features had each grown the same appendage: a red dot on a header
control saying *there is unread news behind me*. Unseen alert firings on the
ingestion caret (`alerts-plan.md`), a new facet finding on the Tagging
consistency button (`facet-diagnosis-plan.md`), and — the one that prompted this
— nothing at all on the jobs chip, where a failed job sat unread until the user
was already suspicious about missing tags.

Adding the third dot is a small change. Adding it *well* meant noticing that the
two that existed did not actually work the same way, or in one case work at all
after the first paint, and that nobody could have told from the outside which
was which.

Decisions made up front:

- **A dot is a fact about the board, not a per-user ledger.** Two of the three
  keep their "last looked" mark in `localStorage`; only alerts, which predate
  this and carry a real per-user unseen count with a `/seen` endpoint, keep it
  server-side. A finding and a failed job are the same news for every reader,
  nobody needs them to follow a device change, and neither is worth a column and
  a POST.
- **Freshness is the whole feature.** Nobody goes looking for any of these —
  each is news you learn because a dot appeared, or you don't learn at all. A
  dot that updates only on reload is worse than no dot, because it reads as an
  all-clear.
- **The item poll is the wrong clock.** It exists to keep the *grid* current and
  correctly stops when the grid is settled. These signals are about what
  happened while nothing was going on.
- **One vocabulary.** Same corner dot, same acknowledgement gesture (opening the
  surface), same toast shape, one sound. Three signals that behave differently
  teach the reader to distrust all three.

## What was already in place (and why it wasn't enough)

| signal | data | refresh before this | acknowledged by |
| --- | --- | --- | --- |
| unseen alert firings | `state.alerts[].unseen`, server-side per user | item poll, 25 s throttle | opening an alert's history (POST `/seen`) |
| new facet finding | `state.facetStats[].diagnostic.at` | **once per page load** | opening Tagging consistency (local mark) |
| failed job | *did not exist* | — | — |

The middle row is the defect. `ensureFacetStats()` guarded on
`statsFetchedFor === state.boardId`, so the roll-up was fetched once and never
again: a finding written by the diagnose loop five minutes into a session did
not exist until the tab was reloaded. The dot it feeds is the entire point of
that feature and it was the least live thing on the header.

The first row was live, but only by accident of the item poll running. The third
would have inherited the same accident — and worse, because the poll stops the
moment the queue drains, i.e. immediately after the failure that mattered.

## The three signals

Each is a number that only grows with news, compared against a mark:

- **alerts** — `alertsUnseen()`, the sum of per-alert unseen counts. Lit when > 0.
- **facet findings** — the newest `diagnostic.at` among facets in the `finding`
  or `improved` states. `genuinely-ambiguous-items` is deliberately excluded: it
  is information, not a task, and a signal that reads as a to-do and resolves to
  "nothing you can do" teaches the reader to ignore the signal.
- **job failures** — `latestJobFailureAt`, the newest `outcome='failed'` row's
  `started_at`. Board-wide.

Visibility follows the surface, not the signal. The Tagging-consistency dot is
gated by `canSeeDiagnostics` (board manager + vote mode) because its button is;
the jobs chip is ungated because the log is transparency, not management.

## What counts as a job failure

`failed` alone, and the exclusions are the argument:

- **`requeued`** — the pipeline is about to try again. It resolves itself.
- **`discarded`** — a stale result the fence dropped because a merge or delete
  landed mid-flight. Nothing the user can see was lost.
- **`interrupted`** — a restart orphaned a running row. This would put a dot on
  every reader's header after every deploy.
- **`running`** — hasn't finished having an outcome.

**Keyed on `started_at`**, which is also the history list's `ORDER BY`. Two
things follow. The dot and the row it sends you to agree on which failure is
newest, so the dot can never point at something buried on page three. And a
*folded* repeat — the worker re-stamping one row for an identical error rather
than writing 3,000 of them (`foldJobRepeat`) — correctly counts as no news,
which is the same judgement the fold itself encodes.

The cost, stated because it is real: a job that starts before your last look and
fails after it has a row older than the watermark, so it waits for the next
distinct failure to be announced. The alternative (`ended_at`) re-lights an
acknowledged dot every 30 s for a wedged ingest scan. Continuous false alarms
lose to a one-off miss.

## The watermark — `public/seen-mark.js`

One key builder, `${scope}:${boardId}`, and three primitives: `unseen`,
`markSeen`, `seenAt`. The diagnostics dot's storage key predates the shared
module and is left alone (`facetDiagSeen:`), so no existing reader's mark
resets; jobs use `jobErrSeen:`.

`markSeen` records `max(newestStamp, now - 1)`. The floor is not a fallback: a
caller acknowledging against data it hasn't got yet (a fetch still in flight, a
cleared cache) must still record *I looked, just now*, or the dot survives the
visit.

**That floor was the quietest bug in the feature.** Every stamp compared here is
written by the SERVER — a job's `started_at`, a finding's `at` — while
`Date.now()` is the reader's own clock, and the two are not the same clock. A
browser running a few minutes fast wrote its watermark into the future and then
ignored real news until the clock caught up; one running slow re-announced news
already read. Both fail silently, because a dot that doesn't light is
indistinguishable from nothing having happened. The floor now runs on a recorded
server offset (`noteServerNow`, fed by the errors route's `now`), and one offset
serves every dot — skew is a property of the pair of clocks, not of any signal.

## The cadence — `public/signals.js`

One timer for all three. 20 s base tick; each signal names its own interval.

- **alerts**, **job errors** — 20 s.
- **facet stats** — 60 s, and the only one that needs to be slower. The roll-up
  aggregates every tagged item's confidence on the board (the endpoint has been
  a performance problem before, at 611 ms), while the loop that writes findings
  only runs once the board has settled and pays for an AI call per facet. The
  data cannot move faster than that.

Bounded three ways: nothing runs while `document.hidden`, with an immediate
catch-up on `visibilitychange` (returning to a tab is exactly when a stale dot
is most obviously wrong, and it is the case that used to require a reload); a
signal whose surface isn't on screen is never fetched (`canSeeDiagnostics`); and
one `app:render` per batch, since all three feed dots in the same toolbar.

`lastAt` is stamped *before* awaiting, so a slow fetch can't be double-started by
the next tick. Each signal's `run()` carries a `.catch` — a rejection inside a
`setInterval` callback has nothing waiting to catch it, and one signal's bad day
would take the other two's render with it.

Boot fills all three through the same functions the tick uses (`refreshAlerts`,
`refreshJobErrors` ride the boot `Promise.all` in `app.js`; facet stats via the
toolbar's `ensureFacetStats`), and `startSignals()` stamps them as just-done so
the first tick is a refresh rather than a duplicate.

`pollDelay()` still keeps alerts on the slow item poll, but for the honest
reason now: an alert is a standing statement that *arrivals* on this board
matter, and arrivals are items. Its dot no longer depends on it.

## The voice — `public/announce.js`, `public/chime.js`

One rule: **fire on the edge from dark to lit, once, and never again while it
stays lit.**

Everything else falls out of it. A retag failing three hundred items is one
toast, not three hundred — the dot is already up, so there is no edge.
Acknowledge the log and the next failure announces again, because it is
genuinely new. No cooldown timer, no burst counter, no "and N more" arithmetic:
the state the dot already tracks answers all of it, and a rule you can state in
one sentence cannot develop a spam mode nobody predicted.

Checked on `app:render`, because every path that can move these three — the
signals tick, the boot fetch, opening either modal — already ends in one.

Two subtleties, both about the baseline:

- The baseline is taken at boot, so whatever is **already** lit when the page
  opens is never news. Three toasts on arrival would be the feature's worst
  first impression.
- A signal whose data hasn't landed yet is **skipped, not recorded dark**. Facet
  stats are fetched after the first paint, so they are still `null` when
  `startAnnouncing()` takes its first reading; recording that as dark is exactly
  what would turn the arrival of a pre-existing finding into a toast a minute
  later. `ready()` gates it, and the first true reading only establishes a
  baseline.

Each toast carries an **Open** action onto the surface it is about, and dismisses
itself when clicked — leaving it up over the modal it just opened is a second
copy of the news the reader is now reading. This is why `toolbar.js` exports
`openDiagnosticsDoor`: two doors onto one modal that differ in what they wire is
how one of them quietly loses the `onEdit` hand-off to the only surface that can
act on a finding.

**The sound** is one tone for all three. Three would have to be learned, and
nothing here is urgent enough to earn that. `public/notification.mp3` at 0.35
volume, built on first use so a tab with the sound off never fetches it, played
on the same edge as the toast (a second chime during the first restarts it, so a
two-signal batch is still one sound). The autoplay refusal on a tab the user
hasn't clicked in is swallowed on purpose — the toast and the dot have already
said the same thing, which is what lets the sound be the part that doesn't
always arrive.

Sound is the only part of this that reaches someone who isn't looking at the
tab, so the off switch is in the **user menu** (`ddCheckRow`), where a person
looks for their own settings, not behind a page nobody opens. On unless
explicitly turned off. Turning it **on** plays the tone: it confirms what was
enabled, and it is a click — which is what the browser's autoplay policy wants
before it will let the first real notification through.

## API

```
GET /api/boards/:id/jobs/errors    -> { failed_at, now }
```

`requireAuth` + `canAccessBoard`, member-visible on the same terms as the log it
summarises. Its own route rather than a field on the log page because the
gallery re-reads it on a background tick and a page costs five queries to answer
— the `/tokens` precedent. `now` travels with it because the watermark's floor
has to be server-clocked.

`GET /api/boards/:id/jobs` also returns `failed_at`, from the same
`latestJobFailureAt` so the two cannot disagree. Board-wide and independent of
the page's `kind` filter: a reader who clicked the Ingestion pill must not have
the dot cleared by a page with no failures in it. This is what lets a reader with
the modal **open** acknowledge what they are actually looking at rather than a
stamp the background tick last refreshed up to 20 s ago — and it is what makes
**Clear** take the dot with it, since the reload after the delete reads
`failed_at: null` off the same response.

## UI

- **The dot** — `attachBtnDot` (utils.js), unchanged: a red 8 px circle centred
  on the button's top-right corner, half in and half out, with a ring so it
  stays readable over the overhang. The toolbar's top padding is already
  headroom for it.
- **The jobs chip** carries the dot and its count at once, and they say opposite
  things: the count is work *happening* and goes away on its own, the dot is
  work that went *wrong* and doesn't. The tooltip names both when both hold;
  `aria-label` becomes "Job log — new errors".
- **`.job-new`** — in the log, failures newer than the watermark the dialog
  opened with are bolded (label + outcome cells only, weight only, so nothing
  reflows while the list is still moving). The dot's question is *which of these
  haven't I seen*, and the list is where it gets answered. The alert history
  modal's `.al-new` precedent. The watermark is read before anything
  acknowledges and frozen for the life of the dialog — read it later and it
  always says "nothing new"; re-read it per refresh and a failure un-marks
  itself a tick after it appears.

## What this deliberately doesn't do

- **No count on the dot.** The chip already shows an in-flight count; a second
  number in the same control would be unreadable, and the log is one click away.
- **No "Failed" filter pill.** `listJobLog` has supported `outcome=` since Stage
  1 and nothing uses it. The pill row is a *kind* dimension; mixing an outcome
  into it is a design smell, and `.job-new` answers the same question in place.
- **No snooze or mute per signal.** The sound is all-or-nothing; the dots aren't
  silenceable at all. Opening the surface is the only acknowledgement, which is
  what keeps the rule statable in one sentence.
- **No cross-board signals.** Everything is scoped to the open board. The boards
  overview shows nothing.
- **No push/Notification API.** The tab has to be open. Webhooks are already the
  answer for reaching someone who isn't here (`alerts-plan.md`).

## Config surface

None. Two `localStorage` keys — `facetDiagSeen:<board>`, `jobErrSeen:<board>` —
and `notifySound`. No env knobs: nothing here schedules work or costs money, and
the cadences are load decisions, not preferences.

## Tests (`test/jobs-dot.test.js`)

- What counts as a failure and what pointedly doesn't; board scope; a folded
  repeat is not new news.
- The watermark per board, its floor, and that the jobs and facet dots do **not**
  share a key — one shared key builder, two callers, and reading the job log
  would quietly mark the findings read.
- A reader whose clock runs fast still sees the next failure.
- The page and the errors route agree on `failed_at` regardless of the page's
  kind filter; clearing history takes the stamp with it.
- The route is member-visible, 404s an outsider, 401s anonymous, and does not
  shadow the log page.
- The chime's file is where the page will ask for it — the one failure here is
  literally silent, since a 404 lands inside the `catch` that exists to swallow
  autoplay refusals.

`announce.js` is not unit-tested: it reaches `alerts-modal.js` →
`board-modal.js`, which uses root-absolute `/x.js` specifiers that resolve
outside a browser. Its import graph is checked statically instead (every
specifier resolves, every named binding exists, no cycles introduced).

## Shipped

2026-08-09, commit `02c193b`. New: `public/seen-mark.js`, `public/signals.js`,
`public/announce.js`, `public/chime.js`, `public/notification.mp3`,
`test/jobs-dot.test.js`. Touched: `db.js` (`latestJobFailureAt`), `server.js`
(the route + `failed_at` on the page), `app.js`, `data.js`, `toolbar.js`,
`jobs-modal.js`, `facet-diagnostics.js`, `alerts-modal.js`, `state.js`,
`styles.css`.
