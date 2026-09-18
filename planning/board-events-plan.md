# Board events — how an open gallery learns about a change it didn't make

**Status:** SHIPPED in `3ca490f` — see [board-events-stage-1.md](board-events-stage-1.md) for what the code actually does.
**Prompted by:** an agent saving a crate over MCP (`mcp-stage-3.md` §2) while the
gallery sat open beside it, and nothing happening until a reload.

---

## 0 — The part that already works

Adding an item to a new crate in the UI surfaces the toolbar's Crates button
immediately. That path is two lines:

```js
if (!state.crates.find((c) => c.id === crate.id)) state.crates.push(crate);   // crates.js:138
document.dispatchEvent(new Event('app:render'));                              // crates.js:147
```

Mutate state, render. That is the whole mechanism, and it is right. **Every
out-of-band change needs exactly the same two lines.** The only thing missing is
the trigger — *how does this tab learn*. Nothing in this plan should end up
bigger than that question deserves.

## 1 — Why nothing arrives today

Three facts, each sufficient alone:

| | |
|---|---|
| `app.js:151` | `/api/crates` is fetched **once**, inside boot's `Promise.all`, and never again |
| `toolbar.js:619` | the button is gated on `state.crates.length > 0`, so it can only appear on a reload |
| `data.js:311` | `pollDelay()` returns **0** when no work is in flight — a settled board polls at zero cadence, which is exactly when an agent writes |

And the gap is wider than crates. Of the six things boot fetches, **four are
never refreshed**: board config, crates, the boards list, filter configs. Crates
is simply the first one something started writing to from outside.

## 2 — The rejected design, and why it was wrong

The first attempt hung crates off the `signals.js` ticker — the timer behind the
header's three dots. It worked, and it was the wrong place. The tell was a
comment it forced into `announce.js`:

> `// Crates are the one announcement here that is NOT a dot.`

When a thing has to announce that it is unlike its neighbours, it is filed
wrong. Concretely, that design put **cache freshness inside a notifications
module**, so the toolbar's correctness depended on the design of the dots.

Two concerns are tangled in the current code and this plan separates them:

- **Freshness** — *what does the server currently say about this board?*
  Today: the item poll (grid only, stops when settled), plus whatever
  `signals.js` happens to fetch for its own reasons.
- **Notification** — *should the reader be told?* Dots, toasts, chimes.
  `signals.js` + `announce.js`.

Notification is a **consumer** of freshness. It was acting as the carrier.

## 3 — The channel

```
GET /api/boards/:id/events        → text/event-stream
```

The second wearer of the `/api/logs/stream` pattern (`server.js:3225`), which is
already proven in this codebase and already running behind the droplet's Caddy —
heartbeat, `X-Accel-Buffering: no`, cleanup on `req.on("close")`. That pattern
is ~14 lines and is the template.

**The server is single-process** (`Dockerfile:65`, no cluster, no workers), and
the MCP endpoint is mounted on the same express app (`server.js:3716`). So the
bus is a `Map<boardId, Set<res>>` and a loop. No pub/sub, no LISTEN/NOTIFY —
those are the answer to a scaling problem this app does not have.

**Events name a slice, they do not carry it.**

```js
emit(boardId, { type: "crates", by: "mcp" });
```

The client refetches that slice and renders. Carrying the payload would mean
ordering guarantees, partial-state merges and a second code path that can
disagree with the first; refetching is one code path and cannot drift. These
slices are small, and an event is rare.

**A slice is a registry entry, not a branch.** The client holds one table —
`{ crates: refreshCrates, config: refreshBoardConfig, … }` — and an event is a
lookup in it. Adding a live surface later is one `emit()` at the mutation site
and one row in that table; it is not a change to the channel. An unknown `type`
is ignored, so an older tab left open across a deploy degrades to what it does
today rather than throwing.

**Reconnect is a refetch.** `EventSource` reconnects on its own, and anything
that happened during the gap was missed — so `onopen` refreshes every slice the
page cares about rather than trying to replay. No `Last-Event-ID`, no server-side
backlog.

**Auth** is `requireAuth` + `canAccessBoard` (`db.js:2538`), not the log stream's
`requireAdmin`: a board member may watch their own board.

**`Cache-Control: no-cache, no-transform` is load-bearing, not boilerplate.**
`compressible("text/event-stream")` is TRUE, so `app.use(compression())`
(`server.js:297`) opts every event stream IN by default — and gzip holds bytes
back until it has enough to compress well, which is the opposite of what a stream
is for. Measured on this stack, four messages written 250ms apart:

| route's `Cache-Control` | encoding | when each message arrived |
|---|---|---|
| `no-cache` | gzip | 773ms, 520ms, 266ms, 4ms — i.e. all at once, at the end |
| `no-cache, no-transform` | none | 1ms, 1ms, 1ms, 0ms |

`compression` honours `no-transform`, which is why `/api/logs/stream` is live
today and why it was never the bug an early draft of this plan claimed it was.
The catch is that the protection is a header on a ROUTE, so every new stream has
to remember it, and forgetting is invisible — no error, nothing in the log, the
data just arrives in clumps.

`test/sse.test.js` is the guard: it times a line from write to arrival, and fails
if `no-transform` is dropped. **A `/api/events` route sets the same header and
earns its own case in that file.** Asserting on the `content-encoding` header
instead would not work — `compression` only decides once a response crosses 1KB,
so on small frames the header is absent either way.

**Lifecycle is the page's.** Switching boards is `location.href = /?board=…`
(`toolbar.js:293`), a full navigation, so `state.boardId` is fixed for the page's
life. Open at boot, die with the document. Nothing to tear down.

## 4 — What this replaces, and what it does not

**In scope: all four surfaces that are stale until a reload** — crates, board
config, filter configs, and the boards list. §1 found them together and they are
one bug, not four; fixing only the one an agent happens to write to would leave
the other three for the next person to rediscover.

It is also the only way to know the channel is general. A mechanism with a
single consumer is a mechanism nobody can tell is general — the second and third
entries are what prove the registry is a registry and not a crate-shaped hole
with a lid on it. Each costs one `emit()` and one row.

**Explicitly not in scope:** migrating the item poll or the signals ticker onto
this channel. Those are not stale-until-reload; they are already live, by other
means that suit them (§2 of the reply thread, and §10 below). Rewriting working
update paths on the back of this is how one regression becomes two suspects.

**Named as the obvious follow-on:** alerts and job failures. Both are discrete
server-side events, both would be better here, and moving them would *delete*
the gallery's ticker entries rather than add anything. Deferred because that is
the code deciding when to notify a person, and it should not change in the same
pass as the mechanism underneath it.

## 5 — Provenance rides the event, not the row

The earlier attempt added a migration — a `source` column on `crates` — so a
toast could say *an agent* rather than *someone*. **The channel deletes that
requirement.** The emitter knows who is calling; the toast needs to know only at
the moment it fires; nothing afterwards ever asks again. So `by` is a field on
the event and the table is untouched.

(If a crates list ever wants to *badge* an agent's crate, that is a durable fact
and needs the column. It is not asked for, so it is not here.)

## 6 — The catch that survives from the first attempt

Crate membership lives on the ITEMS payload — `item.crateIds`, set in
`utils.js:51` and `data.js:168`. A crates refetch alone leaves every loaded card
still believing it is not in the new crate, so the button appears and filters the
grid to **nothing**.

So a `crates` event triggers two refetches: the crate list, and one delta items
pass. `addCrateItems` calls `touchEntities`, so the delta carries exactly the
cards that moved.

`ensurePolling()` cannot be used for this — it starts a *cadence*, and
`pollDelay()` correctly returns 0 on a settled board, so it declines. The delta
fetch inside `pollTick` needs extracting into a `refreshItemsOnce()` that both
callers share. One delta-fetch implementation, two triggers.

## 7 — Emit sites

| site | event |
|---|---|
| `POST /api/crates` (`server.js:629`) | `{type:"crates", by:"ui"}` |
| `DELETE /api/crates/:id` (`:642`) | `{type:"crates", by:"ui"}` |
| `PATCH /api/crates/:id` (`:648`) | `{type:"crates", by:"ui"}` |
| `POST /api/crates/:id/items/:itemId` (`:657`) | `{type:"crates", by:"ui"}` |
| `save_to_crate` (`mcp-tools.js:821`) | `{type:"crates", by:"mcp"}` |

Emitted from the ROUTES, not from `db.js`. The data layer should not know that
an app has subscribers, and the route is where the actor is known anyway.

**A tab does not need to ignore its own echo.** The refetch diffs the server's
list against `state.crates`, which the acting tab has already updated — so it
finds nothing new and says nothing. The same property that made the local path
two lines makes the echo harmless.

## 8 — The toast, as a consumer

A small listener on the event, downstream of the state update — not a fourth
entry in `announce.js`'s `DOTS`, which is a table about standing unseen facts and
has no room for a discrete arrival.

- `by === "mcp"` and a crate genuinely new to this tab → *"An agent saved N cards
  to «name»"*.
- anything else new → *"New crate «name»"*, claiming no author.
- nothing new → silence. This is what makes the echo case free.

Default dark toast. Per the standing rule, colour is for genuinely notable
events and this is a confirmation.

## 9 — Tests

| what | where |
|---|---|
| the stream authenticates, refuses a board you cannot reach, and closes cleanly | a node test against `startServer()` |
| a crate mutation reaches a subscriber of that board and **not** of another | same |
| `save_to_crate` emits with `by:"mcp"`; the UI routes emit `by:"ui"` | extends `mcp-write.test.js` |
| `refreshItemsOnce` is called on a crates event, so membership is not stale | client test |
| a crate this tab made produces no toast (the echo) | client test |
| reconnect refetches rather than replaying | client test |

## 10 — Why not WebSockets

This app has never used them, and that stays true. Everything here is one-way —
the server says "crates changed" and the client refetches over ordinary HTTP,
which it is already doing for every write. A socket buys a channel back that
nothing needs.

The rest is cost avoided: SSE is plain HTTP, so it crosses the droplet's Caddy
with no upgrade handling, reconnects on its own with no retry code to get wrong,
authenticates with the session cookie every other route already uses, and adds no
dependency. `ws` would need all four written and one installed.

The line where that flips is a client→server realtime need — presence, cursors,
someone typing. Nothing on the roadmap asks for it. If it ever does, that is a
socket alongside this, not instead of it.

## 11 — What would make this wrong

If the app ever runs more than one process, the in-process bus silently serves
only the clients that happen to share a process with the writer. The fix is
Postgres `LISTEN`/`NOTIFY` behind the same `emit()`, and `Dockerfile:65` is the
line to watch.
