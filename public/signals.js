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
import { refreshFacetStats, canSeeDiagnostics } from './facet-diagnostics.js';
import { noteServerNow } from './seen-mark.js';

export async function refreshAlerts() {
  if (!state.boardId) return;
  try {
    const r = await fetch(`/api/alerts?board=${state.boardId}`, { cache: "no-store" });
    if (!r.ok) return;
    const list = await r.json();
    if (Array.isArray(list)) state.alerts = list;
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
  } catch { /* keep the last known stamp */ }
}

const TICK_MS = 20000;

const SIGNALS = [
  // No zero-alert skip: this is also how a tab DISCOVERS alerts — a first alert
  // created in another tab, or missed by a failed boot fetch, must still light
  // the dot here.
  { name: "alerts", every: 20000, run: refreshAlerts },
  { name: "jobErrors", every: 20000, run: refreshJobErrors },
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

let timer = null;
const lastAt = new Map();

async function tick() {
  // `document.hidden` and not `!document.hasFocus()`: a second window beside
  // the editor is still being watched.
  if (document.hidden || !state.boardId || !state.me) return;
  const now = Date.now();
  const due = SIGNALS.filter((s) => (!s.when || s.when()) && now - (lastAt.get(s.name) || 0) >= s.every);
  if (!due.length) return;
  for (const s of due) lastAt.set(s.name, now);
  // Each signal already swallows its own network failures; this is the backstop
  // for anything they don't, because a rejection here happens inside a
  // setInterval callback where nothing is waiting to catch it — an unhandled
  // rejection, and one signal's bad day silently taking the other two's render
  // with it.
  await Promise.all(due.map((s) => s.run().catch(() => {})));
  // One render for the batch. Every signal feeds a dot in the same toolbar, so
  // three renders would repaint it three times to the same pixels.
  document.dispatchEvent(new Event('app:render'));
}

// Called once, after boot has filled the signals for the first time — hence the
// stamps: the first tick is a REFRESH, not a duplicate of what boot just did.
export function startSignals() {
  if (timer) return;
  const now = Date.now();
  for (const s of SIGNALS) lastAt.set(s.name, now);
  timer = setInterval(tick, TICK_MS);
  // Coming back to a tab that sat in the background is the moment a stale dot
  // is most obviously wrong — catch up immediately rather than up to TICK_MS
  // later. Everything due fires at once because nothing ticked while away.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
}
