// The header's ambient signals — the three dots — and the one cadence that
// keeps them all honest.
//
// Unseen alert firings, a new facet finding, a failed job. What they have in
// common is that nobody goes LOOKING for any of them: each is news you find out
// about because a dot appeared, or you don't find out at all. Which makes
// freshness the whole feature, and it is exactly what each of them used to get
// wrong in its own way:
//
//   alerts       — rode the item poll, so it was live *while items moved*
//   facet stats  — fetched once per page load, full stop. A finding written by
//                  the diagnose loop five minutes into a session did not appear
//                  until the tab was reloaded.
//   job failures — rode the item poll too, which stops the moment the queue
//                  drains — i.e. immediately after the failure that mattered.
//
// The item poll is the wrong horse for all three. It exists to keep the GRID
// current and correctly stops when the grid is settled; these signals are about
// what happened while nothing was going on. So they get their own timer, and
// the same one, because "when does this dot refresh" should have one answer.
//
// Cost is bounded three ways: nothing runs while the tab is hidden (with an
// immediate catch-up when it comes back, which is the "I had to reload" case),
// each signal names its own interval, and a signal whose surface isn't on
// screen is never fetched at all.
import { state } from './state.js';
import { createTicker } from './ticker.js';
import { ensurePolling } from './data.js';
import { refreshFacetStats, canSeeDiagnostics } from './facet-diagnostics.js';
import { jobsModalOpen } from './jobs-modal.js';
import { noteServerNow } from './seen-mark.js';

// "Has this signal's data ever landed?" — which is the BASELINE's question and
// not the dot's. A dot with nothing behind it is correctly dark: there is
// nothing to point at. A BASELINE with nothing behind it is a lie, because the
// first real reading then looks like a rising edge, and the feature announces
// news that predates the session — a chime for a failure from last week.
//
// The plan gave this gate to facet stats alone, for a reason that reads local:
// they are fetched after the first paint, so they are visibly null when
// announce.js takes its first reading. But the state is not theirs. These two
// are fetched inside boot's Promise.all, so on every successful run they are
// populated before the baseline and the nullness never shows — it shows the
// moment one request fails while the rest succeed, which is exactly when nobody
// is looking. And it is the one fault in this feature that degrades towards
// NOISE: everything else here (a failed refresh, a refused autoplay, a dead
// watermark) fails towards silence.
//
// Read by announce.js's ready() and by nothing else. What the dot should do
// with a value it hasn't got is a different question, and "stay dark" is
// already the right answer to it.
const landed = new Set();
export const signalLanded = (name) => landed.has(name);

export async function refreshAlerts() {
  if (!state.boardId) return;
  try {
    const r = await fetch(`/api/alerts?board=${state.boardId}`, { cache: "no-store" });
    if (!r.ok) return;
    const list = await r.json();
    if (!Array.isArray(list)) return;
    const had = state.alerts.length;
    state.alerts = list;
    landed.add("alerts");
    // Holding an alert holds the slow item poll (pollDelay) — an alert is a
    // standing statement that arrivals on this board matter, and arrivals are
    // items. This read is the only place a tab can LEARN it holds one without
    // having been the tab that made it: a first alert created on another
    // device, or one a failed boot fetch missed. Without this the poll it
    // entitles never starts, because the tick that would have noticed is the
    // tick that had already stopped. (alerts-modal does the same on create; the
    // last delete needs nothing — the running tick sees the empty list and
    // stops itself.)
    //
    // On the TRANSITION only. While alerts are held the poll cannot stop —
    // pollDelay never returns 0 — so a call on every tick would be a no-op
    // except in the one state where it isn't: with work in flight the cadence
    // is 4 s, and ensurePolling re-schedules it, so a 20 s heartbeat would keep
    // nudging the fast poll's timer back out.
    if (!had && list.length) ensurePolling();
  } catch { /* keep the last known counts */ }
}

export async function refreshJobErrors() {
  if (!state.boardId) return;
  try {
    const r = await fetch(`/api/boards/${state.boardId}/jobs/errors`, { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    // This response carries the server's clock, and it is the most frequent
    // read that does — so it is what keeps every dot's watermark comparing
    // server stamps against a server-floored mark.
    noteServerNow(d.now);
    state.jobsFailedAt = d.failed_at ?? null;
    // …including a response that says null. "This board has never failed" is an
    // answer; not having asked successfully is not, and the two were the same
    // value until this line.
    landed.add("jobErrors");
  } catch { /* keep the last known stamp */ }
}

const TICK_MS = 20000;

const SIGNALS = [
  // No zero-alert skip: this is also how a tab DISCOVERS alerts — a first alert
  // created in another tab, or missed by a failed boot fetch, must still light
  // the dot here.
  { name: "alerts", every: 20000, run: refreshAlerts },
  // Stood down while the job log is open, and not merely because the dialog
  // already re-reads the same stamp four times as often. Two writers of
  // state.jobsFailedAt is two chances to record a stamp without the mark that
  // acknowledges it, and announce.js reads exactly that gap as a rising edge —
  // so the redundant read is also the one that toasts and chimes about a row
  // the reader is looking straight at. One writer at a time; the dialog's,
  // because only it knows whether the row was drawn. `when` skipping a signal
  // leaves its lastAt alone, so closing the modal refreshes on the next tick
  // rather than up to `every` later.
  { name: "jobErrors", every: 20000, when: () => !jobsModalOpen(), run: refreshJobErrors },
  // Slower on purpose, and the only one that needs to be. The roll-up is an
  // aggregate over every tagged item's confidence on the board — the costly one
  // of the three, and the one whose data moves slowest, since the loop that
  // writes findings only runs once the board has SETTLED and pays for an AI
  // call per facet. A minute is well inside that and nowhere near the cadence
  // that made this endpoint a problem before. Gated too: on a board without
  // vote mode, or for a reader who can't edit facets, there is no button on
  // screen, so there is nothing to fetch for.
  { name: "facetStats", every: 60000, when: () => canSeeDiagnostics(state), run: refreshFacetStats },
];

// The loop itself lives in ticker.js — it is a policy about WHEN, and the
// boards page needs the same one for its per-board dots (boards-signals-plan.md).
// What stays here is the table, which is the part that is genuinely the
// gallery's: three board-scoped fetches that only mean anything with a board
// open and a reader signed in.
const ticker = createTicker({
  tickMs: TICK_MS,
  signals: SIGNALS,
  ready: () => !!state.boardId && !!state.me,
  onBatch: () => document.dispatchEvent(new Event('app:render')),
});

export const startSignals = ticker.start;
