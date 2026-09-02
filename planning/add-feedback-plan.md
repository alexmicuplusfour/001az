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

Status vocabulary sites (the complete list, verified by grep):

server/db.js
- `STATUS_PRIORITY` — add `"fetching","pending_fetch"` at the front (fetch is
  the earliest, most-alive leg).
- `IN_FLIGHT_FOR` — add `pending_fetch: "fetching"`; TAG_QUEUE derives.
- `claimFairBatch` — CASE arm `'pending_fetch' → 'fetching'`; join the
  `pending_face` exemption from the AI-key gate (fetch needs no AI key).
- `recoverStuck` — include `'fetching'`, requeue to `pending_fetch`.
- retagBoard / releaseHeld / queueUntagged — new first CASE arm shared as one
  string (the STAMPED_CONNECTOR_FACE pattern): `payload ? 'unfetched'` →
  `pending_fetch`, so a failed fetch retags into the RIGHT leg. Legacy
  connector items lack the key and route as before.
- `advanceFetched(db, id, toStatus, sourcePatch)` — fenced on
  `status='fetching'` (the advanceFaced pattern), clears `unfetched`, merges
  the true `source` into payload.

server/connectors/add.js
- `enqueueConnectorEntity(db, board, connectorName, row)` — the enqueue half;
  `addConnectorEntity` stays for the ingest sweep (already background) and
  the single-entity route.

server/server.js
- bulk route: ids may be strings (legacy) or `{id, symbol, name}` rows; no
  provider I/O; response rows echo `connector_id` so the modal flips exact
  rows (kills the match-by-symbol hack).

server/worker.js
- `FETCH_CONCURRENCY` (default 3; provider pacing is the real throttle),
  fetch lane, `STEP.fetching = processFetchOne`, legLog kind `fetch`.
- identity reconcile edge (enqueued without symbol): `setEntityIdentity` on
  mismatch; a 23505 there = late-discovered duplicate → failed with a clear
  error.

server/capabilities.js — `KIND_DEFS` + `{ id: "fetch", label: "Data fetch" }`
(the jobs modal renders kinds from the wire, nothing else to teach it).

public/
- data.js — `QUEUED` += `pending_fetch`, `ACTIVE` += `fetching`; every pill,
  toolbar count and poll predicate follows.
- grid.js — replace the six-status literal with the ACTIVE/QUEUED sets
  (unifies a drift-prone copy while touching it).
- jobs-modal.js — STATUS_LABELS for the two new states.
- connector-browse.js — send `{id, symbol, name}` rows (name from the
  `primary` browse column), flip rows by `connector_id` on response, busy
  button from Stage 1, keep the 100-chunk loop (each chunk now ~instant).

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
- Stage 2: PROPOSED — design settled above, not implemented.
