// The attention dots' local memory: "has anything landed since you last
// looked?", per board, per signal.
//
// Two of the three dots in the header work this way — Tagging consistency and
// the job log — and the third, the ingestion caret's alert dot, deliberately
// does not: an alert firing is a ledger the server keeps per user, with a
// /seen endpoint and a count that belongs in the dropdown rows. These two are
// advisory. A finding and a failed job are both facts about the BOARD that
// every reader sees the same way, nobody needs them to follow a device change,
// and neither is worth a column and a POST. So the watermark is localStorage,
// and the whole comparison is one number against one number.
//
// `scope` is the storage prefix, not a display name — it is baked into the key
// and changing it silently re-lights every dot once.
const key = (scope, boardId) => `${scope}:${boardId}`;

// Every stamp compared here was written by the SERVER — a job's started_at, a
// finding's `at` — while Date.now() below is the reader's own clock, and the
// two are not the same clock. A browser running a few minutes fast floors its
// watermark into the future and then sits there ignoring real news until its
// clock catches up; a browser running slow re-announces news already read. Both
// fail silently, because a dot that doesn't light looks exactly like nothing
// having happened.
//
// So the floor runs on the server's clock instead. Whoever has a server `now`
// to hand reports it here, and the one offset serves every dot: skew is a
// property of the pair of clocks, not of any one signal.
let skew = 0;
export function noteServerNow(now) {
  const at = Number(now) || 0;
  if (at) skew = at - Date.now();
}
const serverNow = () => Date.now() + skew;

// The raw watermark — for a surface that wants to show WHICH things are new
// rather than only whether any are.
export const seenAt = (scope, boardId) => Number(localStorage.getItem(key(scope, boardId))) || 0;

// Is `newestAt` (the stamp of the newest thing worth a dot) newer than the last
// look? A falsy/absent stamp means there is nothing to signal — the dot stays
// dark rather than lighting on data that hasn't arrived yet.
export function unseen(scope, boardId, newestAt) {
  const at = Number(newestAt) || 0;
  if (!at) return false;
  return at > seenAt(scope, boardId);
}

// Acknowledge. The server-clock now is a FLOOR, not a fallback: marking with
// the newest stamp alone would leave the dot lit whenever the caller
// acknowledges against data it hasn't got yet (a fetch still in flight, a
// cleared cache), and "I looked, just now" is the honest thing to record
// either way.
export function markSeen(scope, boardId, newestAt) {
  localStorage.setItem(key(scope, boardId), String(Math.max(Number(newestAt) || 0, serverNow() - 1)));
}
