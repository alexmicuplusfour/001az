# Nobody waits for a dead engine (2026-09-13)

**Status: Stage 1 SHIPPED 2026-09-13 (local, uncommitted).** Suite 1523 → 1529,
eslint clean. Stages 2 and 3 unstarted, and **Stage 2 should now be deleted** —
see its own section. A follow-up to
[sidecar-presence-plan.md](sidecar-presence-plan.md), which made absence
*correct*. This one makes it *free*. Written after reproducing the stall
locally and reading every caller of the health cache.

## Why now

A first load of `/welcome` on local compose, from the network panel: every
asset 3–15 ms, `/api/me` 10 ms, and then

```
capabilities   2.02 s
plugins        2.01 s
```

Both round numbers, which is the tell — that is not work, it is
`AbortSignal.timeout(2000)` in
[sidecar-catalog.js:48](../server/sidecar-catalog.js#L48).

The two sidecar-backed engines declare compose hostnames:

```
whisper        -> http://transcriber:3003
localDetector  -> http://object-detector:3004
```

Neither is in this stack (`deploy.local.json` excludes them). The host accepts
nothing and answers nothing, so both probes burn the full budget. They run
concurrently, so the page pays 2 s once rather than twice — the concurrency
that [sidecar-presence-plan.md](sidecar-presence-plan.md) 3a already bought.

Reproduced against a `net.createServer(() => {})` — a socket that accepts and
never replies, which is what a dead compose hostname behaves like:

| route | cold | warm |
| --- | ---: | ---: |
| `GET /api/admin/capabilities` | **2075 ms** | 47 ms |
| `GET /api/admin/capabilities/tag` | **2015 ms** | 16 ms |
| `GET /api/admin/plugins` | **2029 ms** | 12 ms |
| both, in parallel (what `/welcome` does) | **2055 ms** | — |

**Note which stand-in was needed to see this.** The test helpers point the
sidecars at `http://127.0.0.1:1` — a *closed* port, which is refused instantly.
That is why 1,523 tests never once paid this cost, and why the suite cannot
currently tell a fast refusal from a 2-second hang. A closed port is the one
kind of absence that is cheap.

## The findings

### 1. It is not a first-run cost

The TTL is 60 s. Any page load more than a minute after the last one pays the
full timeout again. First run is simply when it gets noticed, because that is
when someone is watching the page instead of using it.

### 2. The single-capability route pays for engines it cannot use

`GET /api/admin/capabilities/tag` — the boards strip from
[welcome-plan.md](welcome-plan.md) 3b — costs **2015 ms**, and tagging has no
sidecar at all: `floor: { kind: "blocked" }`
([capabilities.js:124](../server/capabilities.js#L124)). It waits two seconds
on transcription and object detection to render one amber line about an API
key.

That route was added *because* the full feed was 58 queries for one row. It
bought the query cost down and inherited the whole latency cost, which is
larger by two orders of magnitude.

### 3. Absence is inferred from silence, on the request path

Whether an engine is on this host is a **deployment fact**, fixed when the
stack comes up. The app rediscovers it by waiting for a timeout, on a user's
request, every sixty seconds, forever.

Everything else follows from that. The cache is lazy, so the cost always lands
on whoever arrives first after it expires — and that is always a page.

### 4. The state that is held is already the right state

Every consumer derives from ONE map, `provider → /health body | null`:

| caller | wants | path |
| --- | --- | --- |
| [capability-resolve.js:235](../server/capability-resolve.js#L235) `floorBinding` | presence | **resolution hot path** — one ask per claimed item |
| [capability-resolve.js:335](../server/capability-resolve.js#L335) `floorMiss` | presence | status |
| [capability-status.js:362](../server/capability-status.js#L362) | presence, all engines | the feed |
| [capability-status.js:148](../server/capability-status.js#L148) | `body.model` | the feed |
| [capability-probe.js:100](../server/capability-probe.js#L100) | `body.model` | probe route |
| [server.js:2428](../server/server.js#L2428), [:2449](../server/server.js#L2449) `sidecarCatalogs` | `body.models` | `/plugins`, `/ai-providers` |

**The Test button is not a reader of this.** Checked, because it is the one
surface where a stale answer would be a lie: `probeCapability` makes a real
call to the engine and counts what came back
([capability-probe.js](../server/capability-probe.js)); `sidecarDefaultModel`
only supplies the model NAME for the toast, so that it cannot drift from what
was served. A name that is up to one loop interval old is fine, and the probe
itself is always live.

So this plan changes **who fills the map and when**, never its shape. And every
one of those six call sites is already `async` — the signatures do not move, so
no caller is touched. That is the whole reason this is small.

### 5. The lifecycle seam already exists

[server.js:3562](../server/server.js#L3562):

```js
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  const server = app.listen(PORT, HOST, …);
  let stopWorker = launchWorker();
```

with its own comment: *"Under test the module is imported for its `app`/`db`
exports … nothing listens and the tagging worker stays off."* Tests call
`app.listen` themselves and never enter this block.

A background loop started here inherits exactly the right lifecycle: it runs in
a real server process, never in a test, and `shutdown()` is already the place
that stops long-running things. **No guard has to be invented, and no test
fixture has to learn about it.** That is the difference between this being ~60
lines and being a hazard.

### 6. The worker is in-process

`startWorker` is imported into server.js and runs in the same module registry —
`worker_threads` appears only in [docx-pool.js](../server/sources/docx-pool.js),
which never touches sidecars. One map, one loop, no cross-thread copy to keep
in step.

## The decision

**Presence stops being something a request can wait for.**

Not "warm the cache so the wait is unlikely" — that is a race, and a race is
lost on a boot-time page load, a delayed tick, a suspended laptop. The map
becomes state the process holds, a background loop is the only thing that ever
touches the network, and readers get the last known answer immediately.

Three properties make it safe, and all three are already true of the design:

- **Unknown reads as absent**, and absence is the safe direction. `floorBinding`
  returns nothing, which is *blocked* semantics — the item waits and requeues,
  it never fails ([capability-resolve.js:235](../server/capability-resolve.js#L235)
  says so: *"Absence resolves to nothing, and the caller waits — blocked
  semantics, never an item failure."*).
- **The first sweep is awaited before the listener opens**, so there is no
  unknown window in practice. Boot costs one probe round (2 s on a host with no
  sidecars, once, with nobody waiting); by the time a connection is accepted the
  map is filled. This is what turns "fast because we warmed it in time" into an
  invariant.
- **Probing cannot drift from reality**, which is why this plan does *not* let
  the operator declare which sidecars exist. A declaration lives in two places
  (excluded from compose **and** set in env) and the two can disagree. The
  problem was never that we probe — it is that someone waits for it.

### Consequences accepted

- **Recovery is bounded by the loop interval, not the TTL.** At 30 s that is
  strictly better than today's ≤60 s + a poll.
- **A sidecar that comes up during boot's own probe** reads absent for one
  interval. Same as today, and blocked semantics already cover it.
- **The loop probes two dead addresses forever on a host that has neither.**
  ~2 sockets per 30 s, each dying after 2 s. Cheap, and deliberately not
  optimised — see non-goals.

## Stages

### Stage 1 — the map is held, the loop fills it

[sidecar-catalog.js](../server/sidecar-catalog.js).

`sidecarHealth(provider)` stops fetching. It reads the held map and returns
what is there — `null` for an engine that has never answered. Everything
derived from it (`sidecarPresent`, `sidecarDefaultModel`, `sidecarCatalogs`)
is unchanged, including their `async` signatures, so no call site moves.

New, module-private: one sweep that probes every `sidecars()` entry
concurrently — the existing `sidecarPresenceMap` body, essentially — writing
each result into the map. And around it the app's own loop idiom, matching
[worker.js](../server/worker.js)'s dispatch loops rather than inventing a
shape:

```js
while (running) {
  await sweep();
  await new Promise((r) => { const t = setTimeout(r, WATCH_MS); wake = () => { clearTimeout(t); r(); }; });
}
```

Exports `startSidecarWatch()` → returns the first sweep's promise, and
`stopSidecarWatch()`.

[server.js](../server/server.js), inside `if (isMain)` and **before**
`app.listen`:

```js
await startSidecarWatch();
```

and `stopSidecarWatch()` in `shutdown()`, beside `stopWorker()`.

`WATCH_MS` from env with a 30 s default, the `POLL_MS` convention.

**`clearSidecarHealth` / `seedSidecarHealth` keep working unchanged** — they
are writes to the same map, and with no lazy fetch behind it, a seeded entry is
now simply what every reader sees. The six test files that use them
(`primeSidecars`, `sidecarsUp`) need no edit: nothing starts the watch under
test, so the map is whatever the fixture put in it. That is a *simplification*
of the test story, not a new burden — there is no longer a TTL that can expire
mid-file under CI load, which is the hazard `sidecarsUp` exists to work around.

### Stage 1 — what shipped (2026-09-13)

Five files. `sidecar-catalog.js` (the map, the sweep, the watch),
`server.js` (one awaited call before `app.listen`, one line in `shutdown`),
`test/helpers.js` (a stand-in that can hang; `sidecarsUp` sweeps instead of
clearing), `test/job-log.test.js` (one line — see below), and a new
`test/sidecar-latency.test.js` (6 tests).

**The plan's central claim held: no call site moved.** All six readers of the
health map are unchanged, because `sidecarHealth` kept its `async` signature
while losing its body. It is now a read.

**Verified by removal, not by assertion.** Patching the lazy probe back in and
re-running the new file:

```
not ok 1 - the routes that used to stall do not probe at all
    /api/admin/capabilities took 2071ms — a probe is back on the request path
not ok 2 - …and neither does the resolution hot path
    50 resolves took 2081ms
```

Both pass at well under 400 ms on the shipped code, against the same hanging
host. The second is the one worth keeping: 50 sequential resolves is a queue,
not a page — `floorBinding` asks presence once per claimed item, so the lazy
probe's worst reader was never the admin UI.

**The boot line runs, and in the right order** — the one thing the plan flagged
as unpinned. A real `node server/server.js` against a hanging host:

```
sidecars: whisper absent, localDetector absent (re-probed every 30s)
API listening on http://127.0.0.1:8098  (db: 127.0.0.1:5433)
```

The sidecar line lands first, which is the whole invariant: by the time the
listener accepts a connection, the map is filled. (Top-level `await` inside the
`isMain` block is legal ESM — checked directly rather than assumed.)

#### What the tree decided

**`WATCH_MS` moved inside `startSidecarWatch`.** At module scope it was read at
import, which made the cadence a property of *when the file was loaded* and
left no way for a test to drive the loop. Read at start instead — which is also
exactly what `startWorker` does with `POLL_MS`, so it stopped being a new
convention and became an existing one.

**`sidecarsUp()` needed a sweep, not a clear.** The fixture pointed the env at
live stand-in boxes and called `clearSidecarHealth()`, trusting the next reader
to re-probe. With nothing probing lazily, clearing means *both engines absent
forever*. It sweeps now, which reads better anyway: the fixture states "and now
the app has seen them" rather than "forget what you knew". Its `close()` still
just clears, because empty already means absent.

**Six tests in job-log.test.js were relying on an accident**, and this is the
find worth recording. Its transcription stub answers **every** GET with a
finished transcription — including the `/health` probe, which is a GET. So the
lazy probe landed in the stub, read truthy, and whisper was present without any
test saying so. Remove the lazy probe and all six time out waiting for a
transcript that can never start.

`primeSidecars()` in the file's `before` fixes it, and the fixture's own comment
turns out to have predicted this: it exists *"so no /health probe lands in that
stub's call ledger"*. That was written as a convenience. It was load-bearing.

**Nothing else in 1,529 tests noticed**, which is the measure of how little
moved — and also of how thoroughly the closed-port default hid this class of
bug. `http://127.0.0.1:1` is refused by the kernel instantly; only a socket
that *accepts and never answers* costs anything, and until `hangingSidecars()`
the suite had no way to express one.

#### Stage 2: delete it

The plan said to measure after Stage 1 and delete if the cost was gone. It is
gone. `capabilityStatus`'s `sidecarPresenceMap()` call is now two map reads, and
`GET /api/admin/capabilities/tag` — the whole reason the stage existed — is
measured under 400 ms with the map cold, against a host that hangs. There is no
registry-derived filter worth writing for that, and the comment at
[welcome-plan.md](welcome-plan.md) 3c already argues against building one.

Stage 3 (the welcome page's `Promise.all`) still stands on its own merits, and
still buys milliseconds rather than seconds.

### Stage 2 — the feed probes only what its answer needs

[capability-status.js:362](../server/capability-status.js#L362) calls
`sidecarPresenceMap()` unconditionally, including for `only: "tag"`.

After Stage 1 this is already free — the map is held, so the call is a read.
Which means **Stage 2 may be unnecessary**, and that is the honest finding to
record rather than build around: the 2015 ms on the single-capability route is
entirely the probe, and Stage 1 removes the probe.

What remains is a smaller, real thing: `capabilityStatus` still *builds* the
presence map object per call. Measure it after Stage 1; if it is noise, delete
this stage and say so. Do not pre-emptively add a registry-derived filter for
a cost that no longer exists — the comment at 3c already argues that skipping
reads per capability is the table this file exists to not have.

### Stage 3 — the welcome page stops blocking its chooser on the whole feed

[welcome.js](../public/welcome.js) `load()` awaits
`Promise.all([/api/admin/capabilities, /api/admin/plugins])` before rendering
anything. The chooser needs the plugin list and **tagging's state**; the rest
of the feed is the quiet "what else this server can do" section at the bottom
of the page.

Split it: `/api/admin/capabilities/tag` (one row) + `/api/admin/plugins` gate
and draw the chooser; the full feed fills `renderOthers` when it lands. Same
pattern the boards strip already uses — *a beat late is invisible, blocking the
page is not.*

This is worth doing **on its own merits**, not for the 2 s: the chooser is the
page's whole job, and it currently waits on nine capability entries to decide
whether to draw five tiles. But it is third because after Stage 1 it buys
milliseconds, and its value is structural.

## Tests

- **The stand-in has to be able to hang.** `test/helpers.js` points sidecars at
  a closed port (instant refusal), which is why nothing caught this. Add a
  fixture that accepts and never answers — `net.createServer(() => {})` — so a
  latency assertion is possible at all. This is the finding that made the plan;
  it belongs in the suite, not just in the doc.
- **The invariant, stated as a test**: with the sidecars hanging and the watch
  NOT started, every route answers in well under the probe budget. That fails on
  today's tree at ~2 s and passes after Stage 1, and it is the only test that
  actually pins "nobody waits".
- **The loop**: one sweep fills the map; a second sweep after an engine's
  stand-in goes down flips it; `stopSidecarWatch()` ends it. Driven directly,
  not through a server.
- **Unknown reads absent**: an unprobed map resolves `transcribe` to nothing,
  and the item is requeued rather than failed — the existing blocked-semantics
  assertions should already cover this; confirm rather than duplicate.
- **Boot ordering** is the one thing a test cannot easily reach (it lives in
  `if (isMain)`). Keep it to one line beside `app.listen` so reading it is the
  verification, and note here that it is unpinned.

## Sequencing

**Stage 1 is the whole plan.** Stages 2 and 3 are follow-ups whose value should
be re-measured *after* it, and at least one of them is expected to evaporate.

Stage 1 is also self-contained: no call site changes, no fixture changes, one
new loop and one `await` beside an existing one.

## Non-goals

- **Lowering the 2 s timeout.** It is a guess at how slow a healthy `/health`
  may be, and it stops mattering entirely once nothing waits on the probe.
  Leave it generous.
- **Backoff on repeated absence.** Tempting — a host with no sidecars probes
  two dead addresses forever — but the saving is ~2 sockets per 30 s and the
  cost is recovery time, which would become *worse* than today's ≤60 s. If the
  churn ever shows up in a log or a bill, the shape to reach for is a slow loop
  plus a non-blocking nudge from readers who care, so demand accelerates
  freshness. Not before.
- **Letting the deployment declare its sidecars.** Covered under The decision:
  a declaration can disagree with reality, probing cannot.
- **The extractor.** Still has no `liveCatalog`
  ([sidecar-presence-plan.md](sidecar-presence-plan.md) non-goals), so it is not
  probed and not in this map. Unchanged here.
- **The plugins page's live health line.** Still cosmetic, still out.
