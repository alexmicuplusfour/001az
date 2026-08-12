# The chart is the face; the symbol tile is only its fallback

**Status: SHIPPED — `npm test` green (1042 tests). Designed + built 2026-08-12 off a
deep dive into the stocks/crypto templates.**

## What was wrong

The mapping modal's connector Face row offered a select whose first option — and, in
practice, whose default — was **"Symbol tile"**. That option was never a face:

- There is **no tile producer**. [`server/faces/index.js:29`](../server/faces/index.js#L29)
  registers `price-chart`, `image-thumb`, `pdf-page`, `text-peek`, `waveform`. The tile is
  what [`kinds.js:202`](../public/kinds.js#L202) draws into a `.connector-symbol` div when an
  item has **no file at all** — i.e. when nothing was rendered.
- It serialized to `{ from: "raw" }`, which the collector treats as identical to *absent*.
  "Symbol tile" was `null` wearing a costume.
- The real fallback already fires on its own, three times over: no `history()` on the active
  provider ([`runtime.js:294`](../server/connectors/runtime.js#L294)), an empty series
  ([`:298`](../server/connectors/runtime.js#L298)), and `generateFace` keeping the tile when
  the producer returns null ([`worker.js:816`](../server/worker.js#L816)). The modal even
  *named* it in the amber hint — while offering it as a peer above.

And it was the **default**: neither finance template declared `mapping.face`, so
`applyTemplate` fell through to `{ from: "raw" }`
([`mapping-modal.js:869`](../public/mapping-modal.js#L869)) and every crypto/stocks board was
born tile-faced, with the chart three controls deep. That default was stickier than it looked
— `wantsFace` at [`add.js:22`](../server/connectors/add.js#L22) routes an added entity to the
face leg *only* for a connector face, so a tile board's cards were permanently tile-faced,
not merely unrendered.

Mirrors the file board, where the face is a locked **"File preview"** chip and the controls
under it only *refine* it ([`face-normalization-plan.md`](face-normalization-plan.md)).

## What ships

1. **Both templates declare the face** — `{ from: "connector", producer: "chart", period: "1y" }`
   in the crypto and stocks manifests. Cadence stays **off**: the chart renders once, on the
   face leg, when the entity is added.
2. **The Face row is a chip, not a source select.** One producer (every built-in) → a locked
   `.mm-locked-badge` with the producer's label; a second line (`.mm-face-prefer`) carries
   **Range** + the same liveness widget the fields use. A domain declaring **several**
   producers gets a select over *those* — never a tile entry. A domain declaring **none** gets
   a locked **"Symbol tile"** chip that serializes nothing: the row stops vanishing, and the
   tile is finally named in the one place where it is the whole answer.
3. **Legacy `{ from: "raw" }` is coerced on open.** The row normalizes onto a real producer +
   a period it offers, so the modal never shows a chart that Save wouldn't write. The
   validator still **accepts** `raw` — old rows carry it, and a producer-less domain means it.
4. **Migration [`0035_connector_chart_face.js`](../server/migrations/0035_connector_chart_face.js)**
   rewrites existing finance boards whose face is absent or `raw`, and marks their unrendered
   entities due now.
5. **The first render is owed even to a cadence-Off face** (the gap that made 4 possible).

## The scheduling gap, and why it had to be fixed here

Turning a face on used to backfill **only if it was live**: the mapping-save hook reschedules
refreshes, and the sweep's face branch was gated on `faceCadence`, which requires `live`. A
board switched tile → chart with cadence **Off** rendered *nothing*, forever — the face leg
runs at add time, so an entity older than its board's face had no other path to a first
render. Nobody hit it while the chart was opt-in; making it the default walks every existing
board straight into it.

`faceCadence` becomes **`faceSchedule`**:

```js
{ every }       // live: re-render on that cadence
{ first: true } // configured, not live: render ONCE, then never
null            // no connector face
```

- `entityRefreshAt` — rendered + one-shot → **no term** (the entity leaves the sweep);
  unrendered → retry (the cadence, or a 60-min floor for one-shot faces, since the usual
  cause is a provider that can't render this face at all).
- `rescheduleEntityRefreshes` — `face_at IS NULL` → **due now**, live or not. This is the
  urgency path the migration and every mapping save ride.
- `refreshDueEntity` — renders when the cadence is due **or** when there's no face yet.

**Deliberately not the item pipeline.** Re-routing vehicles to `pending_face` would have
flowed every already-tagged item back into the tag leg via `advanceFaced` afterwards, re-billing
a whole board's tagging for a purely visual backfill. The sweep touches faces only.

**And deliberately not the payload stamps.** A vehicle's `payload.mapping` records the mapping
it was *defined* under, which for a pre-migration item genuinely had no face; the migration
leaves it alone rather than rewriting history. The visible consequence is narrow: a **retag**
of a migrated board routes those legacy items straight to the tag leg instead of the face leg
([`db.js:1463`](../server/db.js#L1463)) — which costs nothing, because the sweep owns the first
render either way, and items added after the migration carry the chart face in their stamp.

### The rules now live in one file

`liveFields` / `nextRefreshAt` / `faceSchedule` / `entityRefreshAt` moved to
[`server/connectors/schedule.js`](../server/connectors/schedule.js) — pure, zero imports.
`db.js` needs them (boot reconcile, mapping save) but can't import `runtime.js`, which imports
`db.js`; the old answer was to hand-inline the rules at the db.js call site, which is exactly
the mirror that made "live" mean two things while this change was being written. `runtime.js`
re-exports them, so `add.js` / `server.js` / `worker.js` / the tests are untouched.
`firstRefreshAt` joins them, replacing the add-time `if (live.length) …` dance in `add.js`.

## Also fixed: `/api/connectors` 500'd on an un-added domain

`activeProvider` throws when no provider of a domain is installed — an ordinary state (a
domain nobody added yet) that took down the **entire** catalog fetch: the template picker, the
field catalog and the face row, for every connector. Now caught per connector: `activeProvider`
null and the manifest's faces left **unannotated**, so the modal makes no per-provider
availability claim it can't stand behind.

## The cost

Chart-by-default spends one `history()` call per added entity on the face leg — a 50-symbol
bulk add is 50 paced provider calls against free tiers (CoinGecko demo, FMP free). That is the
price of the face; it was accepted deliberately.

## Tests ([`test/faces.test.js`](../test/faces.test.js))

- `entityRefreshAt` / `faceSchedule` over the one-shot face (first render owed, then off the sweep).
- Both templates declare the chart face, pin a period their producer offers, and validate verbatim.
- Face on with cadence Off → existing entity due now → the sweep renders the chart, the entity
  leaves the sweep, **and the item is still `tagged`** (no re-tagging bill).
- Migration 0035 over real rows: absent and `raw` faces converted, a configured face untouched,
  file boards untouched, unrendered entities queued, rendered ones not, items never re-routed,
  idempotent on re-run.
- [`connectors.test.js`](../test/connectors.test.js) — a new connector entity now starts at
  `pending_face` (was `pending`): the assertion that pinned the old default.

## Considered and left alone

- **The three copies of the face-leg routing CASE** in `retagBoard` / `releaseHeld` /
  `queueUntagged` ([`db.js`](../server/db.js#L1463)) are one rule written three times, but
  their later branches genuinely differ and they're untouched by this change — rewriting three
  hot queries for symmetry buys nothing here.
- **Polling.** A backfilled chart appears on the next page load: `liveBoard()`
  ([`data.js:205`](../public/data.js#L205)) polls for *live* faces because they regenerate under
  new filenames and a stale tab 404s. A one-shot first render can't 404 (the card is a tile
  until it lands), and newly-added entities are in-flight, which already polls fast. Making
  every finance board poll forever for a render that happens once was the worse trade.
- **The hourly retry on an unrenderable face** (CoinMarketCap has no `history()`) is a DB read
  and no provider call, and it's what lets a provider switch heal old cards without a mapping
  save. It's the same bargain the live path already made, at a gentler cadence.

## Pointer

Completes the face arc: producers in [`face-pipeline-plan.md`](face-pipeline-plan.md), the
connector Face row in [`slice-5d-connector-faces-plan.md`](slice-5d-connector-faces-plan.md),
the file half in [`face-normalization-plan.md`](face-normalization-plan.md). This is the last
of them — the slot no longer offers "no face" as a face.
