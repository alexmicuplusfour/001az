// The board event channel, client side (planning/board-events-stage-1.md §4).
//
// The server says a SLICE moved; this refetches it through the same function the
// page's own clicks use. There is one way for state to arrive and it cannot drift
// from a second one — which is why events carry a name and never a payload.
//
// What this fixes: 001az is multi-user, and until now anything you did not do
// yourself was invisible until you reloaded. Another member retags a card in
// front of you and the tags do not move; hearts one and the count does not
// change; uploads and the cards do not appear. The server was already stamping
// every one of those changes so other viewers would notice (db.js:1337) — the
// delta poll it stamped for just stops when a board settles, which is exactly
// when someone else's change is the only thing happening.
import { state } from "./state.js";
import { refreshItemsOnce, pollDelay } from "./data.js";
import { loadCrates } from "./crates.js";
import { loadFilterConfigs } from "./filterconfigs.js";
import { getJson } from "./api.js";

// The boards this reader may see — the toolbar's switcher. The only slice with
// no module of its own to live in; boot fetches it inline too, but with a
// short-circuit this has no use for (it reuses the list the landing rule
// already fetched), so the two are not quite the same call.
async function loadBoards() {
  const { data } = await getJson("/api/boards", { cache: "no-store" });
  if (Array.isArray(data)) state.boards = data;
}

// Adding a live surface is a row here plus an emit server-side. An unrecognised
// type is ignored rather than thrown on, so a tab left open across a deploy
// degrades to the behaviour it had this morning instead of breaking.
const SLICES = {
  items: refreshItemsOnce,
  crates: loadCrates,
  filterConfigs: loadFilterConfigs,
  boards: loadBoards,
};

// A slice refreshed twice in quick succession starts two fetches of one
// endpoint, and the second can answer first — leaving the older list in state,
// permanently, until something else moves.
//
// SERIALIZED per slice, not sequence-numbered. A counter compared after the
// await is the obvious shape and it is wrong: the refresh functions write state
// inside `run()`, so by the time a "this one is stale" check runs, the stale
// answer is already in state — the check only suppresses the repaint, leaving
// the screen and the state disagreeing, which is worse than either. Chaining
// makes them land in the order they were issued, which is the property actually
// wanted.
const chain = new Map();

// …and a burst of events for one slice should cost one fetch, not five: a bulk
// action in another tab arrives as one request per click. The debounce collapses
// those, so the chain above is normally one deep — it exists for the case where
// a second burst starts while the first fetch is still in the air.
const DEBOUNCE_MS = 150;
const pending = new Map();

// One repaint per burst, not one per slice. A crate change moves two slices and
// a reconnect moves four, and each was dispatching its own `app:render` — which
// is a full facet recompute and grid pass, several times, within a frame.
let painting = false;
function paint() {
  if (painting) return;
  painting = true;
  queueMicrotask(() => {
    painting = false;
    document.dispatchEvent(new Event("app:render"));
  });
}

function refresh(slice) {
  const run = SLICES[slice];
  if (!run) return;
  // The poll already has items covered, and says so: pollDelay() is non-zero
  // exactly while work is in flight, which is when it is fetching this same
  // delta every four seconds anyway. Without this an upload amplifies — a bulk
  // drop arrives as many chunked requests, so many `items` events, each asking
  // every viewer of that board for a fetch and a render they were getting
  // regardless. server.js's hook states the rule ("for changes that land while a
  // board is SETTLED"); this is the client keeping to it.
  if (slice === "items" && pollDelay()) return;
  clearTimeout(pending.get(slice));
  pending.set(slice, setTimeout(() => {
    // One terminal catch rather than a reject arm mid-chain: the stored tail is
    // then always fulfilled, so a throw can never leave a rejected promise
    // parked on a slice nobody refreshes again — which surfaces as an unhandled
    // rejection, which the browser tests assert against.
    const next = (chain.get(slice) || Promise.resolve())
      .then(run)
      .then(paint)
      .catch(() => {});
    chain.set(slice, next);
  }, DEBOUNCE_MS));
}

let source = null;
// Survives close/reopen on purpose: a hidden tab dropping its stream and
// getting it back is a RE-open, and it may well have missed something.
let opened = false;

function close() {
  source?.close();
  source = null;
}

function connect() {
  if (source || !state.boardId || document.hidden) return;
  source = new EventSource(`/api/events?board=${encodeURIComponent(state.boardId)}`);

  // A RE-open is treated as "I may have missed something". EventSource
  // reconnects by itself and whatever happened during the gap is simply gone —
  // there is no replay to ask for — so catching up is what makes reconnection
  // correct without Last-Event-ID or a server-side backlog.
  //
  // The FIRST open is skipped. Boot already fetched all four of these in its
  // Promise.all and this module starts after it, so refreshing again cost four
  // redundant round trips on EVERY page load — measured, and the reason this is
  // a flag rather than the obvious unconditional version.
  //
  // What that leaves is a hole between boot's fetch and this connect, on the
  // order of a hundred milliseconds, in which a change would be missed until the
  // next event on that slice. Worth four requests a load — and the item poll is
  // usually still winding down across exactly that window anyway.
  source.onopen = () => {
    if (opened) for (const slice of Object.keys(SLICES)) refresh(slice);
    opened = true;
  };

  for (const slice of Object.keys(SLICES)) {
    source.addEventListener(slice, () => refresh(slice));
  }

  // EventSource retries on its own, so there is nothing to do here but not
  // throw. A stream that cannot be opened at all leaves the page exactly as it
  // was before this module existed, which is the right way to fail.
  source.onerror = () => {};
}

// A browser allows six connections per origin ACROSS ALL TABS, and a stream
// holds one for its whole life. Over h2 the ceiling is ~100 and this hardly
// matters; on plain HTTP/1.1 it is six, shared, in an app that loads hundreds of
// thumbnails. Dropping the stream while the tab is hidden is not a workaround
// for that — a tab nobody can see has nothing to update — but it is also what
// keeps a pile of background tabs from costing anything.
//
// Coming back re-opens, and `onopen` refetches, so the catch-up is the same code
// path as a reconnect.
function onVisibility() {
  if (document.hidden) close();
  else connect();
}

export function startEvents() {
  if (!state.boardId || !state.me) return;
  document.addEventListener("visibilitychange", onVisibility);
  connect();
}
