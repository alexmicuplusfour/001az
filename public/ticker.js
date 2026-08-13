// One answer to "when does this dot refresh".
//
// `signals.js` wrote this loop for the gallery's three header dots, and the
// argument it made for having ONE of them applies again the moment a second
// surface wants ambient signals: three signals that behave differently teach the
// reader to distrust all three, and so do two pages that disagree about what a
// hidden tab does. What is extracted here is everything that is a policy about
// WHEN — the hidden-tab gate, the catch-up on return, the double-start guard,
// the failure containment. What stays with each caller is its own table of what
// to fetch, because that is the part that is genuinely per-surface.
//
// A signal is `{ name, every, when?, run }`. `every` is its own interval, which
// the base tick only samples — so `tickMs` is the resolution, not the cadence,
// and a signal is never fetched more often than it asked for.
//
// Cost is bounded three ways, and all three live here: nothing runs while the
// tab is hidden, each signal names its own interval, and a signal whose surface
// isn't on screen says so through `when` and is never fetched at all.

export function createTicker({ tickMs, signals, ready, onBatch }) {
  let timer = null;
  const lastAt = new Map();

  // Exported on the returned object rather than kept private, for two reasons
  // that happen to coincide: the visibilitychange handler needs to call it out
  // of band, and it is the seam a test can drive without mocking the clock —
  // every behaviour worth pinning here (the hidden gate, the pre-await stamp,
  // one bad signal not taking the batch) is a property of one tick.
  async function tick() {
    // `document.hidden` and not `!document.hasFocus()`: a second window beside
    // the editor is still being watched.
    //
    // `ready` is the caller's own precondition — a board id and a signed-in
    // user in the gallery, cards on the page at the index. Distinct from a
    // signal's `when`, which asks whether ONE signal has a surface; this asks
    // whether the page is in a state to have signals at all.
    if (document.hidden || (ready && !ready())) return;
    const now = Date.now();
    const due = signals.filter((s) => (!s.when || s.when()) && now - (lastAt.get(s.name) || 0) >= s.every);
    if (!due.length) return;
    // Stamped BEFORE the await, so a fetch slower than the tick cannot be
    // double-started by the next one. And only for what actually ran: `when`
    // skipping a signal leaves its lastAt alone, so the tick after its surface
    // reappears refreshes it rather than leaving it up to `every` later.
    for (const s of due) lastAt.set(s.name, now);
    // Each signal is expected to swallow its own network failures; this is the
    // backstop for anything they don't, because a rejection here happens inside
    // a setInterval callback where nothing is waiting to catch it — an
    // unhandled rejection, and one signal's bad day silently taking every other
    // signal's render with it.
    await Promise.all(due.map((s) => s.run().catch(() => {})));
    // One call for the batch. Every signal a caller registers here feeds the
    // same surface, so a render per signal would repaint it to the same pixels.
    onBatch?.();
  }

  // Called once, after the caller's boot has filled these signals for the first
  // time — hence the stamps: the first tick is a REFRESH, not a duplicate of
  // what boot just did.
  function start() {
    if (timer) return; // idempotent, which is also what registers the listener once
    const now = Date.now();
    for (const s of signals) lastAt.set(s.name, now);
    timer = setInterval(tick, tickMs);
    // Coming back to a tab that sat in the background is the moment a stale dot
    // is most obviously wrong — catch up immediately rather than up to tickMs
    // later. Everything due fires at once, because nothing ticked while away.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  }

  return { start, tick };
}
