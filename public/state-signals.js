// The board page's state as signals (planning/ui-updates-plan.md, Stage 3).
//
// Each field of `state` becomes a signal behind a getter and a setter, so every
// `state.x` read and write stays as it is, and a `computed` that read `state.x`
// knows when `state.x = …` is written. Only a whole new value is noticed. An
// edit in place (a Map's set, a Set's add, a field of an item) isn't, so the
// selection is always replaced, never edited, and item changes are announced
// with itemsChanged() below (the plan's D5).
//
// Not in state.js, which stays a plain object: the boards, welcome, account
// and admin pages reach state.js too, and this is work done at load, which
// would put the vendored signals on them. Only board-page modules import this
// file. filters.js imports it first, before anything can read a cached value.
import { state } from "./state.js";
import { signal } from "./vendor/signals.mjs";

for (const key of Object.keys(state)) {
  const value = signal(state[key]);
  Object.defineProperty(state, key, {
    get: () => value.value,
    set: (v) => { value.value = v; },
    enumerable: true,
    configurable: true,
  });
}

// Items change in place: the poll's merge writes over each object so that
// every reference to it stays live, and a heart, a crate or a tag edit writes
// a field. No signal sees that, so whatever changes an item, or adds to or
// removes from `state.items` without replacing it, calls itemsChanged(). What
// caches work over the items reads the version. Replacing `state.items` needs
// no call: that's a new value.
export const itemsVersion = signal(0);
export const itemsChanged = () => { itemsVersion.value++; };

// Since Stage 5 a write is also the repaint: app.js draws the page in an
// effect over what it reads, so nothing dispatches an event to ask for one.
// A handler that writes several fields wraps them in batch() (the vendored
// signals file), so they draw once.
