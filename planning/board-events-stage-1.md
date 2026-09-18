# Board events — stage 1: waking the delta

> Reads on from [board-events-plan.md](board-events-plan.md), which settled the
> transport (SSE, one stream per browser, events name a slice rather than carry
> it). This is what the code has to do, after reading it.

**Status:** planned, not started. Suite at 1696.

---

## 0 — What this actually fixes

001az is a multi-user product — members, board roles, shared boards, hearts, and
an agent endpoint that writes. **Today, anything you did not do yourself is
invisible until you reload.** Someone retags a card in front of you and the tags
don't move. Someone hearts it and the count doesn't change. Someone uploads and
the cards don't appear. An agent saves a crate and the toolbar stays empty.

Nothing errors. The screen is simply wrong, and there is no way to tell.

**The server already does its half.** It stamps entities specifically so other
people's clients notice — `db.js:1337` says it outright:

> *"The heart count is part of the entity's list payload — stamp it so other
> viewers' delta polls pick the change up."*

Same intent at `db.js:1472` (crate membership), `3004` (entity merges), `3072`
(aggregate status/tags), `ingest.js:169`. There is a good delta mechanism behind
it: `?since=` over `entities.updated_at` and `items.updated_at`, shipping the
board's full id list so merges and deletes are detectable (`db.js:280`).

**That work is currently wasted**, because `pollDelay()` (`data.js:311`) returns
0 on a settled board — correctly, since it exists to follow work in flight. So
every careful stamp lands in a database nobody is reading.

This stage is not a new feature. It is the missing half of one the server was
already paying for.

## 1 — The centre is `items`, not crates

One event does almost all the work, because one delta fetch already covers:

| what changed | carried by |
|---|---|
| tags another member edited | the items payload |
| a heart another member added | the items payload (`hearts`) |
| cards another member uploaded | the id list |
| cards deleted or merged away | the id list |
| statuses moving | the items payload |
| crate membership | the items payload (`crateIds`) |

Crates, the boards list and saved filters are three small list refetches on top.
They are worth doing — they are what shows the channel is general rather than a
one-off — but they are not the point. **`items` is the point.**

## 2 — The emit is one hook, not twenty

The obvious plan was to call `emit()` at every write. There are 20 such sites in
`db.js`, and a rule you have to remember 20 times is one you will forget, silently.

There is a better seam. All twelve item-mutating routes already pass through
`requireEntityAccess` or `requireItemAccess` (`server.js:377`, `:389`), which
resolve the board for access control and attach it:

```js
req.entityBoardId = ent.board_id;   // requireEntityAccess
req.itemBoardId   = item.board_id;  // requireItemAccess
```

So the board is already on the request. One piece of middleware covers all of
them, and every future route that uses the same guards gets it free:

```js
// after attachUser, before the routes
app.use((req, res, next) => {
  res.on("finish", () => {
    if (req.method === "GET" || res.statusCode >= 400) return;
    const board = req.entityBoardId || req.itemBoardId || req.boardId;
    if (board) emitBoard(board, "items");
  });
  next();
});
```

`res.on("finish")` is deliberate: emit only what actually succeeded, after it is
committed and answered. A handler that 404s or throws emits nothing.

Three writers sit outside those guards and name their board explicitly:

| | |
|---|---|
| `POST /api/upload` (`ingest.js:125`) | `?board=` — set `req.boardId` |
| the ingest sweep (`ingest.js:105`) | has `board.id`; emits directly, no request to hang off |
| `save_to_crate` (`mcp-tools.js`) | has `board.id` |

**Deliberately NOT hooked: the worker.** While it churns, every client's poll is
already awake at 4s (`needsPoll`/`workRunning`), so an emit per tagged item would
be thousands of messages telling clients to do what they are already doing. The
line is: *the channel exists for changes that land while a board is settled.*

## 3 — The channel

`server/events.js`, its own module, mounted like `mcp.js`.

```
GET /api/events?board=<id>     → text/event-stream
```

**One connection per browser tab, tagged with the user id and the board that tab
is on.** That is what lets one endpoint serve both shapes: `emitBoard()` reaches
the tabs on that board, `emitUser()` reaches all of a person's tabs — which the
boards list needs and a per-board stream could not express.

**Access is checked once, at connect** (`canAccessBoard`). Events then go only to
connections already tagged with that board, so nothing is broadcast to a reader
who would have to be filtered out.

**These headers are load-bearing:**

```js
"Cache-Control": "no-cache, no-transform",  // or compression() gzips it — measured, see test/sse.test.js
"X-Accel-Buffering": "no",                  // or a buffering proxy holds it
```

Heartbeat every 20s, `req.on("close")` cleanup — both copied from
`/api/logs/stream`, the working precedent in this codebase.

## 4 — The client

`public/events.js`. A registry, so adding a surface is one row:

```js
const SLICES = {
  items:         refreshItemsOnce,   // §5
  crates:        refreshCrates,
  boards:        refreshBoards,
  filterConfigs: refreshFilterConfigs,
};
```

An unknown `type` is ignored, so a tab left open across a deploy degrades to
today's behaviour rather than throwing.

Four rules, each for a specific failure:

- **Refresh everything on `onopen`.** `EventSource` reconnects by itself and
  whatever happened during the gap is gone — there is no replay to ask for.
  Treating every open as "I may have missed something" makes reconnection correct
  without `Last-Event-ID` or a server-side backlog.
- **One in-flight refresh per slice, latest wins.** Two events in quick succession
  start two fetches of one endpoint, and the second can return first, leaving the
  older answer in state. A per-slice request counter; a stale response is dropped.
  (`detail-chart.js:360` uses `AbortController` for the same hazard; a counter is
  used here because a response already in flight cannot be un-received.)
- **Debounce a slice ~150ms.** A bulk action elsewhere emits per request.
- **Close while the tab is hidden, reopen on return.** A browser allows six
  connections per origin *across all tabs* and a stream holds one for its whole
  life. Prod negotiates h2 (verified) where the ceiling is ~100, but a plain-HTTP
  deployment is on six, shared, in an app that loads hundreds of thumbnails. A
  tab nobody can see has nothing to update, so this is correctness, not a dodge.

## 5 — `refreshItemsOnce()`

The delta fetch currently lives inside `pollTick` (`data.js:332`) and has to come
out so both callers share one implementation.

**Not `ensurePolling()`** — that starts a *cadence*, and `pollDelay()` correctly
returns 0 on a settled board, so it would simply decline. This is the single
tick, with no opinion about whether another should follow.

Step 1 of the build, on its own, with no behaviour change and the suite green.

## 6 — Scope

**In:** the channel; `items`; crates, boards list, saved filter configs;
`refreshItemsOnce`.

**Out, and why:**

| | |
|---|---|
| board config / facets | `app.js:166–200` is fifteen state assignments **plus navigation** (`boardGone → location.replace`), and `state.facets` is what the filter rail is built from. Re-running it live yanks the reader elsewhere or rebuilds the filters under their hands. Its own design |
| the worker's per-item writes | the poll is already awake for those (§2) |
| the signals ticker | alerts and job failures belong here eventually and moving them would *delete* code — but that is the path that decides when to notify a person, and it should not change in the same pass as the mechanism beneath it |
| the "an agent saved…" toast | stage 2. It reads the same event. Freshness first, notification after |
| leader election across tabs | the hidden-tab close covers the realistic case |

## 7 — Tests

| what | how |
|---|---|
| the stream sets `no-transform` and arrives promptly | a case in `test/sse.test.js`, beside the log stream's |
| a heart by user A reaches user B's stream | node test, raw reader (no `EventSource` in node 22) |
| …and **not** a client on another board | the isolation claim |
| a board you cannot access is refused at connect | same |
| one emit per request, not per row | save 3 cards, count frames |
| the worker's writes emit nothing | the §2 boundary, pinned |
| a stale refresh response is dropped | client test, two fetches resolved out of order |
| two real browsers: heart in one, count moves in the other | playwright — the only test that proves the whole thing |

**Every case gets run against the unbuilt state first.** `test/sse.test.js` was
green before its fix existed, twice, for two different reasons, and only checking
caught it.

## 8 — Order

1. `refreshItemsOnce()` extracted. No behaviour change, suite green.
2. `server/events.js` + the route + its tests. Nothing consumes it yet.
3. The `res.on("finish")` hook + the three explicit emitters.
4. `public/events.js` + the `items` slice. **The defect in §0 is fixed here.**
5. crates, boards, filterConfigs — three rows and three emits, the step that
   shows the registry is a registry.
6. The two-browser test.

## 9 — What would make this wrong

An in-process bus serves only the clients sharing a process with the writer. The
app is single-process today (`Dockerfile:65`, no cluster, no workers) and that is
the line to watch. The fix is Postgres `LISTEN`/`NOTIFY` behind the same
`emitBoard()` — considered and rejected for stage 1 on measured grounds: a
dedicated connection outside a `max: 5` pool, and row-level triggers costing 13×
on bulk writes (statement-level with transition tables, 2×) on the worker's hot
path, to make a crate appear.
