# Field projection — what a board stores is what its mapping declares

**Status: SHIPPED 2026-09-06 (uncommitted), all stages + migration, suite
green (1415), live-verified on local compose.** As-built deviations (incl. the
same-day simplify pass): the reconcile module is a factory
(`createFieldReconciler({metaFor})`, the file arm needs the sources instance)
and `refill` is its real dispatch — manual rows are skipped by the column, and
a non-manual row with no handler refuses to build; the strip has ONE live
encoding, the SQL `stripBoardEntityFields` (db.js) — the planned pure
`stripConnectorFields` was dropped as a production-dead twin; the due rule has
one encoding too (`fieldDueAt`, schedule.js), shared by the scheduler and
refresh; both land sites call one `fetchProjectedEntity` (add.js, beside
`connectorLanding` for the same one-encoding reason), and
`projectConnectorFields` takes the fetched entity and derives the absent-arm
provenance itself; refresh keeps a due-but-unanswered key's OLD value when one
exists (a flaky enrichment must not null a live reading) and lands `{v:null}`
(`absentField`) only when there is none. Live verification: migration 0045
converged all 3 local connector boards (ESLT 11→5 keys), and the boot
reconcile immediately healed a handful of entities that had been stranded
with incomplete field maps — the sweep bought their missing keys once and
rescheduled normally (0 overdue after the burst). Self-contained for a fresh
session.

## Why

A connector board's mapping says "these fields" and the pipeline ignores it.
The FMP provider's `fetchEntity` returns its full 11-field catalog
unconditionally (financialmodelingprep.js:195); the runtime stamps src/at on
everything and passes it through (runtime.js:335); `addConnectorEntity` writes
`entity.fields` whole (add.js), the fetch leg does the same
(worker.js `processFetchOne` → `landEntityFetch`), the listing ships it raw
(db.js listItems), and the lightbox renders whatever arrives as "Connector
fields" (lightbox.js:419). A board mapped to 5 fields shows 11.

This predates the field-sources rework — the store-all behaviour is original
(slice-5-coingecko-plan.md) — but the modal now presents connector fields as an
explicit, removable "Extract Fields" list, so the broken promise is visible.

Worse than cosmetic: the refresh sweep only re-buys MAPPED live fields
(schedule.js `liveFields`), so the unmapped six are fetched once and then rot
next to fresh values, indistinguishable in the panel. A stale value that looks
current is the same class of wrong as the 0-that-means-absent `num()` exists to
prevent.

Meanwhile the FILE source already has the discipline, end to end:
`extractFileFields` (media/index.js:78) projects the mapping's file fields —
subset, fn→key rename, v:null for a field that doesn't apply — and
`backfillFileFields` (server.js:2147) re-projects every item on mapping save,
stripping what's no longer declared. Connector fields never got either half.
That asymmetry is exactly the hand-enumerated drift `field-sources.js` exists
to kill: the rule should be declared once and every source should ride it —
including whatever source comes next (the registry's face/voice forward
declarations).

## The invariant

For deterministic catalog sources (today: `file`, `connector`), what is STORED
equals what the mapping DECLARES, projected under the mapping's keys:

- **Subset**: only mapped fields land; nothing else is written, so nothing
  else can rot.
- **Rename**: values store under `f.key`, read off the provider/catalog by
  `f.fn` — the file path already does this; connector keys currently always
  equal fns (the modal locks catalog keys), so this is headroom, not a change.
- **Total**: a mapped field the source can't answer stores `{ v: null }` —
  present-but-empty, the extractFileFields rule. Presence matters: the
  scheduler treats an ABSENT mapped key as "never fetched, due now", so a
  provider that legitimately answers null must still produce a key or the
  sweep would re-buy it forever.
- **Reconcile on mapping save**: stored data re-converges when the declaration
  changes — strip removed keys; refill added ones by whatever means the source
  declares (see the registry row).

AI sources (`extract`, `detect`) keep their current policy — values are bought,
so nothing is stripped or auto-refilled; a re-extract replaces the map whole
(`markExtracted`). The point of the shared mechanism is that this is now a
DECLARED policy on their registry rows, not a silent omission.

## The registry — one new column

`FIELD_SOURCE_DEFS` rows gain `refill`, read by the reconcile pass:

```js
{ id: "connector", ..., refill: "sweep"  },  // strip now; missing keys ride the refresh sweep
{ id: "file",      ..., refill: "local"  },  // re-project synchronously from stored entries
{ id: "extract",   ..., refill: "manual" },  // reconcile does nothing; explicit re-extract only
{ id: "detect",    ..., refill: "manual" },
```

field-sources.js stays pure data. The implementations live with their sources;
a dispatch table in the new reconcile module keys them by id and iterates
DEFS — a future source is a registry row plus one handler.

## Stage 1 — the scheduler learns "wanted"

`schedule.js` is the single copy of the due rules; it grows the missing-key
term:

- `wantedFields(mapping)`: ALL `source:"connector"` fields (with `every`
  flattened where `refresh` exists), superset of `liveFields`.
- Due rule, in one place: a wanted key ABSENT from `entity.fields` → due now
  (never fetched — the field-side mirror of `faceSchedule`'s `{first:true}`);
  a live key present → `at + every`; a static key present → never.
- `nextRefreshAt` takes wanted entries (with optional `every`) and applies
  that rule; `firstRefreshAt` / `entityRefreshAt` / callers switch from
  `liveFields` to `wantedFields`.

Callers to touch: `rescheduleEntityRefreshes` (db.js:2988) and the boot
reconcile `reconcileLiveSchedules` (db.js:48) — both currently gate on
`live.length`; the gate becomes "any wanted fields or a face", else a board
that adds a static field would never backfill it. server.js:1323 passes
wanted instead of live.

`runtime.refresh` (runtime.js:437):
- `due` = wanted keys absent OR cadence-elapsed (was: live+elapsed only).
- Provider-facing want-set uses `f.fn` (today it passes `f.key` and works only
  because they coincide); `fetchFields` coverage check maps back fn→key.
- `merged` is rebuilt from wanted keys only — projection at refresh time, so
  the sweep is self-healing: any stray key (drift, crash between migration and
  save) converges out on the entity's next refresh instead of persisting.

## Stage 2 — land-time projection

New pure module `server/connectors/project.js` (no db, no provider — the
schedule.js of "what lands"):

- `projectConnectorFields(fetched, mappingFields)` → the TOTAL projection:
  for each mapped connector field, `{ [f.key]: { v, kind, src, at } }` off
  `fetched[f.fn]`, `{ v: null, kind: f.kind, src, at }` when the provider
  didn't answer (src = the provider that was asked; truthful, and the present
  key stops the due-forever loop).
- `stripConnectorFields(stored, mappingFields)` → the PARTIAL projection for
  reconcile: keep mapped keys as stored, drop the rest, add NOTHING — absence
  is precisely what makes the scheduler buy a newly-mapped key.

Applied at both land sites, which each have the board in hand:
- `addConnectorEntity` (add.js): project before `createEntity`;
  `firstRefreshAt` then reads the projected map (a static-only mapping still
  schedules nothing — all keys present at birth).
- The fetch leg (worker.js `processFetchOne`): project before
  `landEntityFetch`, same for the refetch/reprocess re-entry that lands
  through it.

The stored-value shape `{v, src, at, kind}` is unchanged; only which keys
exist changes. Snapshots (`addFieldSnapshot`) already record moved live keys
only — untouched.

## Stage 3 — one reconcile on mapping save

New `server/field-reconcile.js`: `reconcileFields(db, boardId, mapping)`,
iterating `FIELD_SOURCE_DEFS`:

- `file` → today's `backfillFileFields` body moves here verbatim (server.js
  loses it; the enrich-legacy-entries leg comes along).
- `connector` → bulk-read the board's entities, `stripConnectorFields`, bulk
  write only real changes (the backfill's own pattern). Refill is NOT fetched
  here — `rescheduleEntityRefreshes` already runs on every mapping save
  (server.js:1323) and, with Stage 1's rule, stamps entities missing a newly
  mapped key due-now; the sweep buys the data at its own pace, prefetch-
  batched. A save stays fast and can't hammer a metered provider.
- `extract`/`detect` → `refill: "manual"`, handler absent, loop skips.

server.js:1322-1326 collapses to `rescheduleEntityRefreshes(...)` +
`reconcileFields(...)` unconditionally (the file-only gate `m === null ||
!m.input` dies — reconcile itself knows what applies per source). Ordering:
strip BEFORE reschedule, so the reschedule sees the post-strip field maps.

Bonus, same commit: `validateMapping` checks connector `fn` against the
manifest field catalog (server.js today validates media fns but takes any
string for connector fns — the drift a bad save would now silently strip).

## Migration — 0045

Historical entities carry the full provider catalog. One-time strip: for each
connector board, rewrite `entities.fields` through `stripConnectorFields`
(keys === fns historically, so no rename leg). Skip no-op rows. Field
snapshots keep their history — movement records, not current state.

No refresh_at pass needed: the next boot's `reconcileLiveSchedules` (with
Stage 1's rule) stamps anything the strip left wanting — and there is nothing
to want, since the strip only removes.

## What deliberately doesn't change

- **AI field data** is never stripped by a mapping edit (paid data, manual
  refill policy on the row). The lightbox's AI section may still show a
  removed field's last value — a separate, cheaper conversation once this
  mechanism exists to hang it on.
- **The Details panel, sort menu, filters** need no code: sort/filters already
  build from the mapping; the panel renders stored keys, which now ARE the
  mapping's keys, in mapping order (projection iterates the mapping).
- **detail-chart.js:315** hardcodes `price`/`change_1d` for the header chips;
  on a board that unmaps them the chips go blank. Accepted — that's the
  truthful reading, and the series header numbers don't depend on fields.
- **Browse/ingest candidates** (ingestion/connector.js) read the manifest's
  browse columns, not entity fields — the catalog walk and feed filters are
  untouched.
- **Store-all's one perk dies knowingly**: re-adding a field used to populate
  instantly from storage; now it lands on the next sweep tick (seconds, and
  visible as pending rather than silently stale).

## Tests

- project.js unit: subset, fn→key, total-with-null, strip keeps/drops/adds
  nothing.
- Add + fetch leg land the mapped subset only (connectors.test / stocks.test
  currently assert the full catalog — they flip to asserting the subset).
- Mapping save: removed field's data gone from entities; added field stamps
  refresh_at due-now and the sweep lands it (present, then refreshed).
- Refresh self-heals a stray key and buys an absent one; `fetchFields`
  receives fns; partial-coverage fallback still trips on fn terms.
- Boot reconcile schedules a board whose mapping wants a missing static key.
- Migration: mixed board strips to mapping, file boards untouched.

## Rejected

- **Filter at display**: hides the symptom, keeps unrefreshed data on the
  entity — the stale-that-looks-current bug with extra steps, and every future
  consumer (export, API) re-inherits it.
- **Synchronous refetch on save**: a 1,000-entity board × a metered provider
  inside one PATCH. The refresh sweep exists, is paced, and prefetch-batches;
  refill rides it.
- **Strip AI fields too**: destructive to paid data on a config edit;
  declared manual instead. Revisit only with an explicit user-facing choice.
