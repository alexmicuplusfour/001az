// The ingestion status presenter — pure data in, verdict out, no DOM (the
// capability-present.js pattern), so the precedence + wording rules are
// node-testable and live in exactly ONE place. Three surfaces read ingestion
// state — the toolbar chip, the boards-page card chip, and the ingest
// modal's header chip — and the first two grew private copies of the same
// two rules ("a pending run outranks the mode", "failing tints — the
// countdown IS the retry"). The modal mounts THIS; the other two migrate
// here in ingest-status-plan.md stage 3 rather than growing a third dialect.
//
// Inputs are the board-payload trio (ingestStatus() server-side; stampBoard
// keeps it live client-side) plus the one fact only the modal holds:
//   mode        null | "manual" | "paused" | "scheduled"
//   nextRunAt   ms stamp or null — <= now means due/claimed; while failing
//               the stamp IS the retry
//   error       boolean — the ongoing-state signal, never the message (the
//               words are manager-gated; the last-run line carries them)
//   triggerMode the SAVED trigger.mode, for watch-vs-schedule wording.
//               Optional: surfaces that only hold the trio say "Scheduled".
//   now         injected so tests never race the clock
//
// The verdict is chip-shaped — { state, tone, live, dim, due, left, label,
// title } — for statusChip() to apply verbatim. tone is "neutral" | "ok" |
// "error": "warn" belongs to the component's set, not to ingestion — nothing
// here warns. live only while something is actually happening (a due run, a
// live watch), never merely "enabled". `state` is the discriminant for
// surfaces that branch; `due`/`left` (ms to the stamp, null without one)
// carry the countdown itself, so a compact surface can render "now" or a
// bare number without re-deriving the top rung of the ladder from raw state.
import { fmtDuration } from "./utils.js";

const verdict = (state, tone, label, title, { live = false, dim = false, due = false, left = null } = {}) =>
  ({ state, tone, live, dim, due, left, label, title });

export function presentIngest({ mode = null, nextRunAt = null, error = false, triggerMode = null, now = Date.now() } = {}) {
  const watch = triggerMode === "continuous";

  // A stamp outranks the mode: a hand-fired run on a paused (or Off) board
  // is a run, not the pause it falls back to when it lands.
  if (nextRunAt != null) {
    const left = nextRunAt - now;
    if (left <= 0) {
      // Due — the sweep claims it within a worker tick. Failing keeps its
      // tone through the retry: red pulse, honest words.
      return error
        ? verdict("retrying", "error", "Retrying now", "The retry is due — the worker claims it within a tick.", { live: true, due: true, left })
        : verdict("running", "ok", "Running now", "The run is due — the worker claims it within a tick.", { live: true, due: true, left });
    }
    // Failing outranks the pretty words: the countdown is real (it IS the
    // retry), so it keeps counting — under the failure's name and tone.
    if (error) return verdict("failing", "error", `Failing — retry in ${fmtDuration(left)}`, "The last run failed — the countdown is its retry.", { left });
    return watch
      ? verdict("watching", "ok", `Watching — next check in ${fmtDuration(left)}`, "Continuous watch is active.", { live: true, left })
      : verdict("scheduled", "ok", `Scheduled — next run in ${fmtDuration(left)}`, "The schedule is armed — the countdown is the next run.", { left });
  }

  // No stamp: the mode carries the words. Paused and Off are deliberate
  // holds — quiet (dim), not warnings; a failure on top keeps the hold's
  // name but wears the failure's tone.
  const held = mode === "paused";
  if (error) {
    return verdict(held ? "held-failed" : "off-failed", "error", `${held ? "Paused" : "Off"} — last run failed`,
      held ? "The schedule is held, and its last run failed." : "The last run failed.", { dim: true });
  }
  if (held) return verdict("paused", "neutral", "Paused", "The schedule is held — Save and run now still works.", { dim: true });
  if (mode === "scheduled") {
    // Armed but not yet stamped — the sweep hands out the first stamp on its
    // next tick. Say the mode; skip the countdown it doesn't have yet.
    return watch
      ? verdict("watching", "ok", "Watching", "Continuous watch is active.", { live: true })
      : verdict("scheduled", "ok", "Scheduled", "The schedule is armed.");
  }
  return verdict("off", "neutral", "Off", "No automatic trigger — the board ingests only on demand.", { dim: true });
}
