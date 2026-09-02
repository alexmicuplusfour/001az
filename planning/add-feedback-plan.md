# Add feedback — busy buttons + queued connector adds (2026-09-03)

Self-contained for a fresh session. Written after a deep dive spanning the
browse modal, the bulk route, the connector add path, the worker's lane
architecture, the client poll/reconcile loop, and every place the item status
vocabulary lives.

## The two complaints

Adding 50 stocks from the browse modal:

1. **The "Add selected" button shows nothing while it works.** It disables,
   but for any selection ≤100 its label never changes — the ad-hoc progress
   text in [connector-browse.js:206-214](../public/connector-browse.js#L206-L214)
   only fires per-chunk, and the chunk size is 100. Twenty seconds of a
   silently disabled button.
2. **All feedback lands at once, at the end.** The rows uncheck/disable only
   when the whole request returns. 50 stocks = 19.7s
   (`POST /entities/bulk 19742ms`); hundreds would be minutes of nothing.

## Why it takes 19.7 seconds

The bulk route ([server.js:2969](../server/server.js#L2969)) loops
`addConnectorEntity` **inside the HTTP request**. Each call does
`connector.fetchEntity` — a paced provider round-trip (~150–600ms under
`callProvider`'s pacing, [connectors/runtime.js](../server/connectors/runtime.js))
— then creates the entity + tag-vehicle instance. 50 × ~400ms ≈ 20s, all
provider I/O, all serialized behind one response. Everything AFTER creation
(face render, tagging, embedding) already runs in the background via the
worker; it's only the provider fetch that blocks the response.

## The insight that makes this cheap

**The app already has exactly one queue: the items table + statuses.** The
worker claims by status into per-resource lanes
([worker.js:2604-2661](../server/worker.js#L2604)), `claimFairBatch` maps
waiting→in-flight ([db.js:2012](../server/db.js#L2012)), the client's delta
poll reconciles new rows in and renders spinner cards for anything in
`ACTIVE`/`QUEUED` ([data.js:40-48](../public/data.js#L40),
[grid.js:399](../public/grid.js#L399)). `IN_FLIGHT_FOR` in db.js was written
so "a fourth leg cannot be added without this following it."

And the entity can be created **without** the provider fetch: the browse row
already carries `id`, `symbol`, and the display name, and the identity
derivation is pinned and shared — `(symbol || "").toLowerCase() || id`
(connector-list's `on_board` marking mirrors `runtime.fetchEntity`,
[server.js:3108-3111](../server/server.js#L3108)). So "add" splits into:

- **enqueue** (in the request): create entity from browse-row data with empty
  fields, insert the vehicle at a new status `pending_fetch`, payload stamped
  `unfetched: true`. Milliseconds per row — duplicates still 23505 → skipped.
- **fetch leg** (in the worker): a fourth lane claims
  `pending_fetch → fetching`, calls `fetchEntity`, lands fields +
  display_name/source, schedules liveness refresh (`firstRefreshAt`), clears
  `unfetched`, advances to `pending_face` / `pending` / `held` — the same
  status computation [add.js](../server/connectors/add.js) does today.
  Provider errors go through `failOrRequeue` per item, visible in the jobs
  drill, instead of a lump "N couldn't be added" toast.

The user experience becomes: click Add → rows flip instantly ("On board"),
items appear in the gallery as queued cards within a poll tick, and data
streams in card-by-card exactly like tagging already does. Closing the modal,
refreshing the page, even restarting the server no longer loses anything —
recoverStuck requeues `fetching` debris. This is the general mechanism for
future content types the browse modal grows.

## Stage 1 — busy buttons (a shared mechanism)

### The app already contains both halves — in two different places

- **Behavior**: `busy(btn, label, fn)` at
  [plugin-modal.js:38](../public/plugin-modal.js#L38) — disable, swap label,
  restore in finally. 14 call sites across plugin-modal,
  admin-capabilities, admin-plugins, admin-usage. No spinner.
- **Visual**: the ingest modal's preview button
  ([modal.css:590-607](../public/modal.css#L590),
  [ingest-modal.js:621-627](../public/ingest-modal.js#L621)) — a `.loading`
  class hides the label (which keeps reserving its width, so no layout jump)
  and overlays a centered 12px ring. No shared helper; hand-built spans.

Stage 1 marries them: promote `busy()` into [modal.js](../public/modal.js)
(the modal vocabulary), promote the preview button's overlay-spinner CSS into
a shared `.is-busy` rule in modal.css, and refit the preview button as the
first consumer (its private `.im-btn-label`/`.im-btn-spin` CSS deleted).

### Mechanism design

`busy(btn, fn)` — the label parameter is dropped: the spinner overlays the
existing label instead of swapping text, which is what the preview button
already does and what keeps button widths stable (including tiny ones like
the lightbox's `×`). On start: `disabled`, class `is-busy`,
`aria-busy="true"`, current text wrapped in a `.busy-label` span (hidden via
`opacity: 0`, not `visibility` — geometry AND the accessibility tree both
keep it), `.busy-spin` span appended (`aria-hidden`).

- **Claim contract**: the finally restores label + enabled **only if the
  helper's spans are still the button's children.** A handler that re-labels
  the button mid-run claims it — plugin-add's "Added", the lightbox's
  "Queued" — and busy leaves both the label and the disabled state exactly
  as the handler set them. Detached-button restores (modal closed mid-save)
  are harmless no-ops.
- **Spinner colors from `currentColor`**: `border: 2px solid currentColor;
  border-top-color: transparent` — reads on the dark primary and the white
  ghost without per-kind colors. `:disabled` opacity dims it exactly as the
  preview spinner already dims today.
- **Keyframes live in modal.css under their own name** (`busy-spin`). This
  is load-bearing, not style: admin.html does NOT load styles.css, where the
  global `spin` keyframes live — the preview CSS comment "spin keyframe is
  global" is only true on the gallery page. The shared rule must not depend
  on it. styles.css keeps `spin` for its three non-modal consumers.
- Re-entrancy: `is-busy` check + disabled double-guard.

### Adoption inventory (verified by sweep)

- **Signature migration** (3-arg → 2-arg, import moves to modal.js): the 14
  existing `busy()` sites.
- **Ad-hoc conversions**: tag-editor Save
  ([tag-editor.js:96](../public/tag-editor.js#L96)); alerts-modal Save + Send
  test (Save's manual re-enable-on-error branches collapse; test's
  restore-to-enabled is correct since dirtiness is unchanged by a test);
  mapping-modal template picker
  ([mapping-modal.js:316](../public/mapping-modal.js#L316)); plugin-add-modal
  Add rows + Install (Install also disables its URL input — that stays in
  the handler); lightbox remove / re-extract / retag; connector-browse Add +
  Add selected (Stage 2 rewrites this handler anyway); ingest-modal Preview
  (the donor, refitted).
- **A latent bug this fixes**: board-modal's Create board / Save
  ([board-modal.js:1002](../public/board-modal.js#L1002)) has **no guard at
  all** — an unguarded async POST where a double-click can create two
  boards. It adopts busy() and gets the guard for free.
- **Out of scope**: login/profile (pages without modal.css, not modals);
  admin panel buttons (admin-boards "queuing…", admin-members copy link,
  admin-backups) — same helper would work and they can adopt opportunistically
  later, but they're panels, not modals; "Load more" buttons (paged-table,
  ingest preview paging) keep their "Loading…" note pattern — they're
  pagination, not commit actions, and the note is the feedback surface.

## Stage 2 — queued connector adds

**Close-look verified 2026-09-03** — three parallel read agents checked every
claim below against the code (db mechanics, worker/runtime, client + tests).
Everything is file:line-verified; the four HARD BLOCKERS are marked ⚠.

### The failure class that makes the routing edits load-bearing

Tagging an entity with empty fields does NOT fail — worker's tagOne builds
`fieldLines` from `{...entity.fields, ...payload.fields}`, gets `[]`, and the
prompt still says "judging from its extracted fields below" with nothing
below. The model tags from the name alone, `markTagged` lands, the leg logs
"ok". **Silent garbage, indistinguishable from real tags.** Every place that
could route an unfetched item past its fetch leg feeds this exact hole.

### server/db.js

- `STATUS_PRIORITY` (:87) — add `"fetching","pending_fetch"` at the front.
  (Single-instance entities pass status through verbatim at :120, so this
  only matters for multi-instance aggregates — still add it.)
- ⚠ `IN_FLIGHT_FOR` (:94) — `pending_fetch: "fetching"` is MANDATORY before
  the leg can fail anything: `failOrRequeue` derives its value fence from
  this map (`IN_FLIGHT_FOR[requeueStatus] || "processing"`, :2874) — without
  the entry, every fetch failure fences on 'processing', matches nothing,
  and the row wedges in 'fetching' forever. TAG_QUEUE derives too; its four
  consumers were audited — 3 clearly correct with fetch included, 1
  (tagQueueDepth → capability-status "N waiting") slightly over-counts;
  accepted, the items do reach the tag leg.
- `claimFairBatch` (:2012) — CASE arm `'pending_fetch' → 'fetching'` (else
  the ELSE claims it into 'processing' and the tag leg runs on empty
  fields), ⚠ the keyless-board gate at :2020 must become
  `i.status IN ('pending_face','pending_fetch') OR …` (fetch needs no AI
  key; without this, adds on a keyless board are never claimed — no test
  pins this today), AND the **default `stages` arrays** in both
  claimFairBatch and claimNextWork (:2045) must gain 'pending_fetch'.
- ⚠ `recoverStuck` (:2896) — TWO hand-written lists that do NOT derive from
  IN_FLIGHT_FOR despite the nearby comment: the WHERE at :2916 (omit
  'fetching' → crashed fetch rows are unrecoverable forever) and the CASE at
  :2904 (omit the arm → the ELSE 'pending' routes a recovered fetch into the
  tag leg = silent garbage tags). Both edits or neither.
- ⚠ Routing CASEs — FOUR sites, not three: retagBoard (:1509), releaseHeld
  (:1573), queueUntagged (:1599), **and reprocessEntity (:2649)** — the last
  has no status filter at all and its own variant predicate. All four need a
  `payload ? 'unfetched'` → `'pending_fetch'` arm FIRST (an unfetched
  connector vehicle also satisfies STAMPED_CONNECTOR_FACE, so a later arm is
  swallowed by the face arm). Share it as one string beside
  STAMPED_CONNECTOR_FACE, same anti-drift rationale. This is also the rescue
  path: a fetch that exhausts retries lands in 'failed', and retag/
  queueUntagged (WHERE includes 'failed') re-enter it at the RIGHT leg.
- `advanceFetched(db, id, toStatus, patch)` — the advanceFaced shape:
  `payload = (payload - 'unfetched') || $patch::jsonb` (shallow merge —
  fine, the patch replaces `source` whole), `attempts=0, error=NULL,
  retry_at=NULL`, fence `WHERE id=$n AND status='fetching'`, return
  rowCount>0 (false = discarded, deleted/re-routed mid-flight — deletion
  paths have no coordination; the fence IS the mechanism). Do NOT use
  updateItemPayload for the source patch — it has no fence and would splat
  stale provider data over a re-routed row. `park` must SURVIVE this
  advance (it's consumed later by advanceFaced / the held-park rule), so
  strip only 'unfetched'.
- Entity landing: **no existing helper writes symbol** (createEntity is its
  only writer, verified — no UPDATE touches entities.symbol), and composing
  setEntityIdentity (clears identity_provisional, can 23505) +
  updateEntityFields means two transactions with a strandable gap. Add ONE
  `landEntityFetch(db, id, {identity, displayName, symbol, fields,
  refreshAt})` statement. On identity change colliding 23505 (only possible
  when the enqueue lacked the symbol, or the provider disagrees with its own
  list): fail the item as a late duplicate — visible in the jobs drill,
  user-deletable — rather than silently merging.

### server/connectors/add.js

- `enqueueConnectorEntity(db, board, connectorName, {id, symbol, name})`:
  identity = `(symbol || "").toLowerCase() || String(id)` — the EXACT
  expression connector-list's on_board marking uses (server.js:3110),
  pinned to runtime.fetchEntity's derivation (runtime.js:339). createEntity
  (fields `{}`, display_name from the browse row) + insertItem
  (status 'pending_fetch', payload `{identity, files: [], fields: {},
  mapping, source: {provider: activeName, id}, unfetched: true, park?}`) —
  **wrapped in withTx**: reapEmptyEntities is structural (an entity with its
  instance row is never reaped) but a crash between the two statements
  strands a reapable orphan; add.js's existing pair has the same gap and
  never earned it — this one does I/O-free work, so the tx is cheap.
  `park` stamped exactly as add.js does (wantsFace && !auto_tag). 23505 →
  `.duplicate`, same contract. Log "connector entity queued: …" for parity.
- `addConnectorEntity` STAYS — the ingest sweep's admit() is strictly
  sequenced (entity before ledger, `.duplicate` must throw synchronously,
  and its prewarm exists precisely to make the inline fetch cheap), and the
  single-entity route keeps it too (below).

### server/server.js

- Bulk route: ids as strings (legacy, identity falls to the id and the leg
  reconciles) or `{id, symbol, name}` rows (the modal's form; symbol may be
  legitimately empty for symbol-less domains). No provider I/O. Modest
  length caps on client-supplied name/symbol. Response rows = add.js's
  return shape (status pending_fetch, fields {}) + `connector_id` echoing
  the request id. Keep BULK_ADD_MAX 100.
- **Single-entity POST /entities stays synchronous** — it's the API's
  immediate-result path (response is rendered with real fields; 409/502
  contracts pinned by faces.test:398-435 + connectors.test:519), the modal
  doesn't use it, and converting it buys nothing.

### server/worker.js

- `FETCH_CONCURRENCY = Math.max(1, Number(process.env.FETCH_CONCURRENCY) || 3)`
  (the `<LANE>_CONCURRENCY` convention; provider pacing is the real
  throttle). New lane + `STEP.fetching = processFetchOne` + fillLanes line +
  the boot banner lane list (:2864).
- **Batch prewarm, or crypto bulk adds are 1 metered request per item**:
  crypto fetchEntity reads the shared 60s quote cache and a miss buys a
  BATCHED endpoint for ONE id (coingecko.js:355-361 names this exact trap;
  FMP has no prefetch and doesn't need one — its fetch is per-symbol
  anyway). The ingestion adapter already solved this with
  runtime.prefetchIds(db, conn, ids, board) → warmIds (no-op under 2 ids or
  without provider.prefetch). The fetch lane's fill claims its batch, groups
  by board connector (the prefetchDueRefreshes pattern), prewarms, then
  dispatches — claim-then-fetch sits well inside the 60s TTL.
- `processFetchOne(row)`: getBoard + getEntity (either missing → advance
  attempt discards, same as face leg's null-tolerance), getConnector from
  board.mapping (gone = board re-templated → plain throw → retries →
  failed), `connector.fetchEntity(db, row.payload.source.id, board.id)`
  (bound signature verified index.js:36; 15s interactive budget applies —
  fine), landEntityFetch (fields + display_name + symbol + identity
  reconcile + refresh_at from firstRefreshAt), then advanceFetched with
  toStatus = wantsFace ? 'pending_face' : board.auto_tag ? 'pending' :
  'held' (board freshly read in the leg). Errors → failOrRequeue(…,
  'pending_fetch') + legLog kind 'fetch' (target auto-falls-through to
  payload.identity — files is []).

### server/capabilities.js

- KIND_DEFS + `{ id: "fetch", label: "Fetch", capability: null }` — null =
  spends nothing itself, exactly the ingest/face/refresh row; provider
  quota already meters separately under the `api` work label. Wire
  vocabulary flows to the jobs modal untouched; usage-api.test's generic
  assertions pass as-is.

### public/

- data.js — `QUEUED` += pending_fetch, `ACTIVE` += fetching. ⚠ Required,
  not cosmetic: filters.js `isTagged` (:93) returns false for unknown
  statuses AND the pills miss them — an unlisted pending_fetch item is
  INVISIBLE in the grid, and needsPoll stops polling while fetches run.
  Nine consumer sites all follow the sets automatically (verified).
- grid.js :398 — replace the six-status literal with the imported sets
  (rows.js:261 is the precedent; removes the drift site).
- jobs-modal.js — `pending_fetch: "queued to fetch"`, `fetching: "fetching
  data"` (degrades to raw id meanwhile, no crash).
- connector-browse.js — send `{id, symbol: data.symbol, name:
  values[primaryCol.key]}` (both bundled manifests declare exactly one
  primary column, key "name", and both providers' list() rows carry symbol +
  values.name — verified); flip rows by `connector_id` and DELETE
  findIdBySymbol/markAddedRow — the symbol match is latently wrong today
  (CoinGecko id≠symbol; duplicate tickers collide). ensurePolling +
  app:render already in place. Keep the 100-chunk loop.
- state.js :29 comment refresh (names the pill's statuses). Cards need
  nothing: the connector face reads only symbol/identity/displayLabel
  (fields is never read at card level — verified), so a queued card is
  visually final at birth; lightbox on a pending_fetch item shows an empty
  connector-fields section (acceptable, worth an eyeball).

### Tests

- connectors.test bulk (:901): counts survive but the provider stub goes
  unused — extend: added rows are pending_fetch + payload.unfetched, stub
  NEVER called, connector_id echoed; duplicate assertion unaffected (23505
  fires at createEntity, pre-fetch, by design).
- retry.test (:107): add fetching → pending_fetch recoverStuck case.
- queue.test: add pending_fetch → fetching claim case + the keyless-gate
  case (nothing pins it today).
- fences.test: add an advanceFetched discard case.
- extraction.test (:479) + faces.test (:445): routing CASEs — seed a
  pending_fetch/fetching pair in the untouched set and an unfetched failed
  row asserting → pending_fetch.
- facet-diagnose.test :698 hardcodes `STATES` as six with a title saying
  "every one" — extend to eight or derive from an export (it would pass
  silently while its claim went false).
- job-log.test: sibling case — the fetch leg writes ok/failed rows.
- faces.test :398-435 / connectors.test :519 pin the SINGLE-add route's
  pending_face + park — untouched, that route stays synchronous.

## Non-goals

- The ingest sweep keeps the synchronous `addConnectorEntity` — it already
  runs in the worker; enqueue-first is about HTTP latency, and the ledger
  wants the immediate outcome.
- No streaming/NDJSON: the queue design strictly dominates (survives
  disconnect, unifies with the pipeline, jobs-drill visibility).
- No new persistence: no jobs table, no migration — statuses are text.

## Status

- Stage 1: SHIPPED 2026-09-03 (uncommitted). Full suite green (1323).
  As built: `busy(btn, fn)` in modal.js wraps the button's existing children
  (composite triggers survive; inner-span writers keep working); `.is-busy` +
  `busy-spin` keyframes in modal.css; preview button refitted; 14 old busy()
  sites migrated (imports now from modal.js); ad-hoc patterns converted in
  tag-editor, alerts (save+test), mapping (template), plugin-add (add+install),
  lightbox (remove/re-extract/retag), board-modal save (gained its missing
  double-submit guard), connector-browse (row Add + Add selected — the >100
  chunk-progress label was dropped: it would claim the button mid-run and kill
  the spinner, rows still flip per chunk, and Stage 2 makes chunks instant).
  Simplification pass (same day): `claim(btn, label)` exported beside busy as
  the contract's explicit spelling (lightbox uses it); the lightbox's twin
  re-extract/retag handlers folded into one `queueLegBtn` factory;
  `.im-preview-btn` dissolved into `.im-btn` (it was only ever the spinner
  host); plugin-modal's last hand-rolled guard (key/connection add form)
  converted.
- Stage 2: SHIPPED 2026-09-03 (uncommitted). Built as specified above, all
  four blockers included. Tests extended per the list (plus a new
  keyless-claim-gate case and an end-to-end fetch-leg test: enqueue with a
  provider-call spy proving zero I/O, then the worker landing fields and
  advancing to the face leg). Full suite green (1325).
  Simplification pass (same day, 4 agents): claimFairBatch/claimNextWork/
  recoverStuck now DERIVE their status CASEs and lists from IN_FLIGHT_FOR
  (the "authoritative list" comment is finally true; `IN_FLIGHT_STATES` is
  exported and the facet-diagnose states test imports it instead of
  re-hardcoding); add.js grew `connectorLanding(board)` (one encoding of the
  park/next-leg rule, used by both add paths AND the fetch leg) and a shared
  `connectorRow` builder (the client row had two verbatim authors);
  the prewarm moved beside prefetchDueRefreshes as
  `prefetchClaimedFetches` and got MATERIALLY better: it warms the board's
  queued fetch ids (queuedFetchSourceIds), not just the claimed slice —
  steady-state claims are 1 row at a time, so slice-warming was a no-op and
  every drained row would have paid a metered batch endpoint for one id; it
  also resolves the connector from the fresh board row, not the payload
  stamp, and fillLane's prep hook gained the failure boundary its comment
  promised. Skipped as beyond-diff: folding the three entity-UPDATE helpers
  into one keyed writer; a shared per-leg envelope for the four workers'
  catch blocks.
