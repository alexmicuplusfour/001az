// What a newly-lit dot says out loud.
//
// A dot is a standing fact — "there is unread news here" — and it is missable
// by design: small, quiet, in a header you aren't looking at. The toast is its
// ARRIVAL, and the whole design is in one rule:
//
//   **fire on the edge from dark to lit, once, and never again while it stays
//   lit.**
//
// Everything else follows. A retag failing three hundred items is one toast,
// not three hundred — the dot is already up, so there is no edge. Acknowledge
// the log and the next failure is genuinely new, so it announces again. No
// cooldown timer, no burst counter, no "N more" arithmetic: the state the dot
// already tracks answers all of it, and a rule you can state in a sentence is
// one that can't develop a spam mode nobody predicted.
//
// The edge is checked on `app:render` rather than on a signal of its own,
// because every path that can move these three — the signals tick, the boot
// fetch, opening either modal — already ends in one. Reading the dots when the
// header repaints is the same moment the dots themselves are read.
import { state } from './state.js';
import { toast } from './toast.js';
import { chime } from './chime.js';
import { alertsUnseen, openAlertHistory } from './alerts-modal.js';
import { jobsUnseen, openJobsModal } from './jobs-modal.js';
import { diagnosticsUnseen, canSeeDiagnostics } from './facet-diagnostics.js';
import { signalLanded } from './signals.js';
import { openDiagnosticsDoor } from './toolbar.js';

// `ready` guards the baseline, not the dot: a signal whose data has not landed
// yet is skipped entirely rather than recorded as dark, because recording it
// dark is what turns the arrival of PRE-EXISTING news into a toast.
//
// All three carry it, because all three HAVE the state. Facet stats are only
// the conspicuous case — the toolbar fetches them after the first paint, so
// they are still null here on a perfectly good day. The other two are fetched
// inside boot's Promise.all and so are never null on a good day and always null
// on a bad one, which is the harder version of the same bug and not a different
// bug (signals.js: `landed`).
const DOTS = [
  {
    name: "alerts",
    ready: () => signalLanded("alerts"),
    lit: () => alertsUnseen() > 0,
    say() {
      const hot = state.alerts.filter((a) => a.unseen > 0);
      const n = alertsUnseen();
      // Resolved at CLICK time rather than captured, and here the question is
      // whether the alert still EXISTS: this toast outlives its own reading by
      // up to eight seconds, longer if hovered, and opening a history modal for
      // a deleted alert gets a 404 and "Failed to load the history". (Handing
      // it a merely stale object is safe — openAlertHistory re-resolves by id
      // before it touches state, because the alerts dropdown can hand it one
      // too.)
      const id = hot[0]?.id;
      const open = () => {
        const live = state.alerts.find((a) => a.id === id);
        if (live) openAlertHistory(live);
      };
      // One alert can be named and opened; several can only be counted, since
      // the list lives in a dropdown that needs its anchor to open.
      return hot.length === 1
        ? { msg: `${n} new match${n === 1 ? "" : "es"} for "${hot[0].name}"`, open }
        : { msg: `New matches on ${hot.length} alerts` };
    },
  },
  {
    name: "jobs",
    // The signal's name, not the dot's — signals.js owns the fetch that lands.
    ready: () => signalLanded("jobErrors"),
    lit: jobsUnseen,
    // Not a count: the dot's stamp says WHEN, not how many, and a number here
    // would need a second query to be true. "Open" is the answer either way.
    say: () => ({ msg: "A job failed", kind: "error", open: openJobsModal }),
  },
  {
    name: "diagnostics",
    ready: () => state.facetStats !== null,
    lit: () => canSeeDiagnostics(state) && diagnosticsUnseen(state.boardId, state.facetStats, state.facetGates),
    say: () => ({ msg: "New tagging consistency finding", open: openDiagnosticsDoor }),
  },
];

// name → last observed lit-ness. Absent means no baseline yet, and the first
// reading only ever establishes one.
const seen = new Map();

function check() {
  for (const dot of DOTS) {
    if (dot.ready && !dot.ready()) continue;
    const lit = dot.lit();
    const had = seen.get(dot.name);
    seen.set(dot.name, lit);
    if (had === undefined || had || !lit) continue; // baseline, or no rising edge
    const { msg, kind = "info", open } = dot.say();
    // The action dismisses its own toast: leaving it up over the modal it just
    // opened is a second copy of the news the user is now reading. `let` and not
    // `const` so the closure's reference to it is plainly assigned-before-use
    // rather than relying on the click landing after this statement finishes.
    let handle;
    handle = toast[kind](msg, {
      duration: "long",
      actions: open ? [{ label: "Open", onClick: () => { handle?.remove(); open(); } }] : [],
    });
    // Only for a toast that was actually shown NOW. A chime with nothing to
    // read is a notification that says only "something", which is worse than
    // silence and is how a sound gets switched off for good.
    //
    // toast() returns null in two cases and this covers both, deliberately. The
    // one that recurs is the dedup — an identical message still on screen, so
    // the news is already being read. The other is the MAX_VISIBLE queue, where
    // the toast does arrive later and the sound is genuinely dropped; that is
    // the right trade anyway, since three toasts are already up and the reader
    // is not short of notice.
    if (handle) chime();
  }
}

export function startAnnouncing() {
  check(); // establishes the baseline; whatever is already lit is not news
  document.addEventListener("app:render", check);
}
