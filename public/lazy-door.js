// A door onto a module that is fetched when something needs it, not at boot.
//
// The mechanism is three lines of memo and one rule that is easy to get wrong:
// a chunk that failed to arrive — offline, or a deploy that replaced it
// mid-session — must NOT be remembered as failed, or the door stays shut for
// the rest of the session. Hence the memo is dropped on rejection so the next
// attempt retries.
//
// Written once because there are two doors and there will be more: the toolbar's
// modals and the detail view are separate chunks on purpose (different gestures,
// very different frequencies — see modals.js), but they are not separate ideas.
import { toast } from './toast.js';

export function lazyDoor(load, { failMsg, after } = {}) {
  let ready = null;

  const get = () => {
    if (ready) return ready;
    // `after` is one-time wiring the module needs before its first use, run
    // inside the memo so it happens exactly once however many callers race.
    ready = after ? load().then((m) => { after(m); return m; }) : load();
    ready.catch(() => { ready = null; });
    return ready;
  };

  // Wrap a handler that needs the module in hand. Returns a plain function, so
  // it can be passed straight to addEventListener. A click that silently does
  // nothing is worse than a slow one, so a failure says so.
  const wrap = (fn) => async (...args) => {
    let m;
    try { m = await get(); } catch { toast.error(failMsg); return; }
    return fn(m, ...args);
  };

  return {
    wrap,
    // One of the module's exports, as a function that loads it first. This is
    // what lets call sites keep reading the way they did before the split —
    // `openJobsModal()`, not `withModals((m) => m.openJobsModal())`.
    fn: (name) => wrap((m, ...args) => m[name](...args)),
    // Warm it ahead of the click. Silent: nothing was asked for yet, and the
    // real open will report a failure if the reader does ask.
    preload: () => get().catch(() => {}),
  };
}
