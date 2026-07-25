# Alerts — watch a facet selection, get told when new things match (2026-07-25)

The app ingests while nobody is looking — FTP drops, connector polls, scheduled
folder scans — and then tags what arrived minutes later, asynchronously. Today the
only way to learn that something new matched "type/logo + color/red" is to open the
board and look. An alert closes that loop: a named facet condition that, when a new
entity enters its matching set, records the fact and (optionally) tells an external
system. The app stays use-case-agnostic by being delivery-agnostic: core ships
**webhooks only** — one POST covers Discord, Slack, Telegram bots, ntfy.sh phone
push, n8n/Huginn chains, and bare shell scripts. We provide the mechanism, the user
provides the meaning.

Decisions made up front:

- **Alerts are their own feature, not saved filters with a flag.** Different
  intents (a view you return to vs. a condition you watch), separate table,
  separate UI. But the condition reuses the `{ facetKey: [values] }` shape of
  `filter_configs.config` (0001_baseline.sql:231-240) and the client's
  `encodeSelected()` URL encoding (filters.js:231) — same language, no coupling.
- **Detection is always immediate; delivery is a per-alert policy.** Every match
  is written to the ledger the moment tags land. `immediate` / `daily` / `record`
  only control when (whether) the webhook fires. History is therefore always
  exact, and a digest is just a query over undelivered matches — no separate
  accumulation machinery.
- **The match unit is the entity, evaluated on its union tag set.** The grid's
  unit is the entity and its tags are the union across instances
  (db.js:97-101 — "what filtering and facet counts consume"). Matching a single
  instance's tags would under-match any condition satisfied only across
  instances. So: whenever any instance's tags land, re-evaluate its *entity*.
- **An entity fires a given alert at most once, ever.** `PRIMARY KEY (alert_id,
  entity_id)` + `ON CONFLICT DO NOTHING`. Re-tags that keep it matching are
  no-ops; drifting out and back in doesn't re-fire. (If instance-level "new post
  from a watched person" firing is ever wanted, it's a constraint flip — noted,
  not built.)
- **Creation baselines the already-matching set.** Detection only runs at tag
  landings, and boards re-land old tags all the time — periodic auto-tag,
  admin retag, retag-on-refresh all push settled items back through the tag
  leg. Without a baseline, the once-ever dedupe has a hole at birth: the first
  retag after creating an alert would announce the entire pre-existing
  matching set as one giant "N new items". So create (and any condition
  change — widening covers old ground) records every currently-matching
  entity as a claimed row under `firing_id = 0`, a sentinel no real firing
  carries: the primary key is occupied, the re-landings are ON CONFLICT
  no-ops, and only entities that enter the set afterwards read as news.
  Baseline rows are invisible everywhere — pending queries filter
  `firing_id IS NULL`, display queries join a real firing. Migration `0024`
  heals alerts created before this by baselining whatever matches today.
- **The ledger never breaks the job** (the job_log lesson): evaluation is wrapped
  try/catch-warn at its call sites; a webhook timeout is a recorded failure,
  never a thrown error into tagging or the worker sweep.
- **Alerts are per-user, private** — the `filter_configs` stance (owner-scoped,
  per board). The webhook is personal (my phone, my Slack). Board-shared alerts
  are a later feature if anyone asks.
- **Membership is the pipe.** An alert whose owner loses board access goes
  dormant: no new matches, and pending matches/firings freeze undelivered — a
  webhook is an open pipe out of the board, and revoking membership must close
  it, not just the UI. Everything resumes if the owner is re-added. (One
  shared SQL clause on every sweep/detection query.)
- **The condition covers facet tags only.** Status pills, Untagged, favorites,
  crates, and uploader filters are view state, not watchable conditions; the
  create action is only offered while facet pills are active.
- **Alerts live in the plus-menu, not a new toolbar button.** That corner is
  already the arrivals cluster (plus, ingest countdown chip, ingestion menu),
  and alerts are about arrivals. The dropdown follows the saved-filters pop
  (filterconfigs.js:69-104) — the one pattern in the app that already does
  "list + inline manage + contextual create".

## What's already in place

- **Tags land in exactly two places.** AI: `markTagged()` (db.js:1833, fenced on
  `status='processing'`, called from `tagOne` in worker.js). User: `setItemTags()`
  (db.js:302, from `PATCH /api/instances/:id/tags`, server.js ~1882). Two call
  sites to hook — plus one door where the union moves WITHOUT a tag landing:
  a merge/split re-parent (extractOne) carries the instance's kept tags into
  the target entity, growing its union. The tag leg that follows usually
  re-evaluates the final entity, but a failed or fence-discarded tag run would
  strand it — so the move evaluates too.
- **Matching semantics are already defined** by `matchesExcept()` (filters.js:17):
  OR within a facet's values, AND across facets, membership tested against the
  `facet/value` tag strings. The server-side matcher is a 10-line mirror of this.
- **Filtered views are already shareable URLs** — `syncFiltersToUrl()`
  (filters.js:257) writes `?f=`, app.js:39 decodes it on boot. A webhook can link
  to the living view today; only the *delta* view (`?event=`) is new.
- **Scheduling precedent for "daily at HH:MM"**: the ingestion trigger's `daily`
  mode (`nextIngestRunAt`, server/ingestion/index.js:25-41) and
  `boards.auto_tag_next_run_at`. Same `next_run_at` stamp-after-run pattern.
- **Sweep precedent**: the worker's maintenance loop (worker.js ~1672) already
  ticks at POLL_MS doing recovery + retag/ingest scheduling — the delivery sweep
  rides the same cadence.
- **Outbound fetch precedent**: plugin-fetch.js:67-89 (`fetch` + timeout env +
  size cap, no SSRF guard — self-hosted app, authed users enter the URLs; same
  stance here).
- **Gallery view mechanisms to reuse**: `state.selectedCrateId` filtering
  (filters.js:59) is the exact shape `?event=` needs; the crates chip is the
  dismissal pattern.

## Schema — migration `0023_alerts.sql`

```sql
CREATE TABLE alerts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id         TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  condition        JSONB NOT NULL DEFAULT '{}',  -- { facetKey: [values] }, ≥1 facet enforced at API
  delivery         TEXT NOT NULL DEFAULT 'immediate',  -- 'immediate' | 'daily' | 'record'
  daily_at_min     INTEGER,                      -- minutes-of-day; kept across delivery switches (the remembered digest time)
  next_delivery_at BIGINT,                       -- daily: next due; stamped after each run
  webhook_url      TEXT,                         -- NULL for record-only
  webhook_secret   TEXT,                         -- optional; X-Alert-Signature HMAC-SHA256 when set
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       BIGINT NOT NULL,
  UNIQUE(user_id, board_id, name)
);
CREATE INDEX idx_alerts_board ON alerts(board_id) WHERE enabled;

-- One row per (alert, entity), ever — the dedupe IS the primary key.
CREATE TABLE alert_matches (
  alert_id   BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  entity_id  BIGINT NOT NULL,   -- deliberately NOT an FK: history outlives deletion (job_log stance)
  item_id    BIGINT,            -- the instance whose tagging triggered it (same stance)
  label      TEXT,              -- display name frozen at match time (job_log's `target`)
  firing_id  BIGINT,            -- NULL = pending; 0 = baseline (matched before the alert); else the grouping firing
  matched_at BIGINT NOT NULL,
  PRIMARY KEY (alert_id, entity_id)
);
CREATE INDEX idx_alert_matches_pending ON alert_matches(alert_id) WHERE firing_id IS NULL;
CREATE INDEX idx_alert_matches_firing  ON alert_matches(firing_id);

-- One row per delivery/grouping event — what history shows and ?event= links to.
CREATE TABLE alert_firings (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id       BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  fired_at       BIGINT NOT NULL,
  entity_count   INTEGER NOT NULL,
  webhook_status TEXT,           -- NULL (record-only) | 'pending' | 'ok' | 'failed'
  webhook_error  TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  retry_at       BIGINT,         -- next attempt due; NULL = now (0025)
  seen           BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_alert_firings_alert ON alert_firings(alert_id, fired_at DESC);
```

## Stage 1 — detection: evaluate on tag landing, record matches

New module `server/alerts.js`:

- `matchesCondition(tagSet, condition)` — the `matchesExcept` mirror: every facet
  key in the condition must have ≥1 of its values present as `facet/value` in the
  set. Exported bare for tests.
- `evaluateEntity(db, boardId, entityId)` — union the entity's instance tags
  (`SELECT tags FROM items WHERE entity_id=$1`), load the board's enabled alerts,
  and for each match `INSERT INTO alert_matches ... ON CONFLICT DO NOTHING`,
  freezing `label` from the entity's display name. Tag landings are AI-paced
  (rate-limited singles), so a per-landing alerts query is fine — no cache.

Call sites, all wrapped try/catch-warn (evaluateItemAlerts never throws):

- worker.js `tagOne` — after `markTagged` returns true (the row in hand has
  `board_id`/`entity_id`).
- server.js `PATCH /api/instances/:id/tags` — after `setItemTags`, so manual
  tagging can trigger an alert too (an OSINT user hand-tagging an entity into a
  watched set *is* the event).
- worker.js `extractOne` — after a merged/split disposition: the re-parent
  grows the target entity's union with the tags the instance keeps through
  the move (the across-instances case the matcher exists for). Usually the
  subsequent tag leg re-evaluates the final entity anyway; evaluating at the
  move removes the "usually" (a failed tag run must not strand a grown
  union), and dedupe makes the double evaluation free.

Not hooked: `insertItem` (items are born tagless — nothing can match before the
tag leg), untagging paths (leaving the set is not an event).

Creation seeds the baseline (`seedAlertBaseline`): every entity whose union
already matches is recorded pre-claimed under the `firing_id = 0` sentinel, so
the re-landings a board retag produces are dedupe no-ops instead of a mass
firing. Condition-changing edits re-seed; the seed is idempotent (ON CONFLICT
leaves real match rows alone), and a create whose seed fails is rolled back
rather than left lying in wait.

Tests: matcher semantics (AND/OR, empty facet, slash values), union-across-
instances matching, once-ever dedupe, both call-site triggers, baseline at
create and at widening edits, the 0024 healing migration.

## Stage 2 — delivery: the sweep, three policies, one webhook shape

A `deliverDueAlerts()` pass on its own worker loop (the embedLoop reasoning:
webhook sends are outbound I/O with a 10s timeout — a hung endpoint must not
sit inside the maintenance tick delaying recovery and ingestion; sends are
additionally capped per pass):

- **immediate** — fire when the alert's newest ungrouped match is older than
  `ALERT_SETTLE_MS` (default 60 s) *or* its oldest exceeds `ALERT_MAX_WAIT_MS`
  (default 10 min). There is no batch/run id in the pipeline, and tagging
  trickles for minutes after a bulk ingest — the settle window is what turns a
  500-file drop into one notification instead of 500, with bounded latency.
- **daily** — when `now >= next_delivery_at`: group whatever is pending (if
  nothing, skip — no empty notifications), stamp the next run via a
  `nextIngestRunAt`-style daily computation from `daily_at_min`. Edits move
  the stamp only when the schedule itself changes (mode or HH:MM) — a rename
  or pause/resume keeps it, so an unrelated edit can't silently push an
  overdue digest to tomorrow; the sweep resolves overdue stamps (fire
  what's pending, re-arm).
- **record** — same settle grouping (uniform history and `?event=` links),
  `webhook_status` stays NULL, no send.

Firing = insert `alert_firings` row, claim matches with
`UPDATE alert_matches SET firing_id=$1 WHERE alert_id=$2 AND firing_id IS NULL`
(single worker process — the house concurrency assumption), then deliver.

Webhook: `POST webhook_url`, JSON, `ALERT_WEBHOOK_TIMEOUT_MS` (default 10 s).
Max 3 attempts spaced by a `retry_at` stamp — immediate, +1 min, +5 min
(0025; the sweep ticks every ~3 s, so tick-paced retries would burn all
three attempts in seconds and turn any endpoint restart into a permanent
failure) — then `failed` with the error recorded: transparency over
cleverness, the history row is the receipt. Delivery is gated on `enabled`
like grouping is — off freezes a pending send mid-retry, re-enable thaws it
(the dormancy stance, one toggle down). When `webhook_secret` is set,
`X-Alert-Signature: sha256=<hmac of body>`. Delivery is **at-least-once**:
the sweep sends, then stamps — a crash between the two resends the firing
next tick, because the reverse order would turn the same crash into a
silently lost alert. `firing_id` (and `fired_at`) are stable across resends;
an idempotent receiver dedupes on them.

```json
{
  "firing_id": 93,
  "alert": { "id": 7, "name": "new logos" },
  "board": "abc",
  "fired_at": 1785000000000,
  "entity_count": 12,
  "entities": [{ "id": 4411, "label": "Acme rebrand", "url": ".../?board=abc&item=4411" }],
  "links": {
    "event":  ".../?board=abc&event=93",
    "filter": ".../?board=abc&f=type%3Alogo"
  }
}
```

Absolute links ride `BASE_URL` — the same knob invite links mint from, so no
new configuration (unset → links omitted, payload still useful). `entities`
capped at ~20 with `entity_count` carrying the truth — log nothing silently.

API (all `requireAuth` + `canAccessBoard`, owner-scoped like filter-configs,
server.js:427-457 as the template):

- `GET/POST /api/alerts?board=` · `PATCH/DELETE /api/alerts/:id`
- `GET /api/alerts/:id/firings` (paginated history)
- `GET /api/alert-firings/:id` → `{ firing, entityIds }` (the `?event=` fetch)
- `POST /api/alerts/:id/test` — fire a sample payload at the URL now; returns
  status/error. Debugging webhooks blind is miserable; this is the fix.

Tests: settle-window grouping, daily stamping, record-only, webhook failure
recording, HMAC, test-fire — webhook target is an in-test `http.createServer`.

## Stage 3 — UI: the plus-menu, the create/edit modal, the history modal

- **The plus-menu grows a second section** (toolbar.js:276-285, the dropdown that
  today holds only "Automatic ingestion…"): `ddSep`, then one `ddRow` per alert
  the user has on this board, then a footer row **"Alert on current filter…"**.
  The create row does the naming work no noun could — it says what gets created
  and what it's tied to. With no facet pills active it's replaced by the
  filterconfigs-style `dd-empty` hint ("Pick some filters, then create an alert
  here." — the same teaching trick as saved filters). Alert rows carry an
  unseen new-match count badge (entities across unseen firings — "5" means
  five new items, the number the user is owed) and trailing edit-pencil + delete
  (`configDelBtn` pattern, filterconfigs.js:26); **row click opens history** —
  an alert's primary payload is "what happened", and the count badge makes that
  the natural read. (Deliberate divergence from saved-filter rows, whose click
  applies; the living view is one click away inside history.) A small dot on
  the plus-caret when any alert has unseen firings replaces the bell as the
  ambient indicator — without it, a record-only alert is invisible until you
  think to look.
- **Create/edit modal** (`public/alerts-modal.js`, `createModal()` from
  modal.js): condition prefilled from `state.selected`, rendered as the
  tag-editor's facet pill groups (tag-editor.js) read-only-with-remove; name,
  delivery mode (immediate / daily at HH:MM / record only), webhook URL +
  optional secret + Test button. The daily hint names the server's clock
  (zone, current time, offset) when it disagrees with the viewer's — the
  stamp is server-local (a Docker host is usually UTC), and "09:00" must
  not silently mean some other hour; /api/me carries the server's tz. The pencil reopens the same modal — "rename"
  is just the name field, and the webhook/mode need an edit surface anyway;
  a bespoke inline rename would strand them.
- **History modal** (jobs-modal layout, jobs-modal.js): one row per firing —
  fired_at, entity count, webhook status (failed shows the error text —
  everything for everyone). Row click → gallery `?event=<firingId>` (Stage 4's
  chip) and closes the modal. Opening marks the alert's firings seen. History
  pages on the jobs-modal keyset cursor (`fired_at_id`, Load more while a
  cursor comes back) — a long-lived alert's log is never silently capped.
- Alerts + unseen counts fetched with the boot `Promise.all` (app.js:54).

## Stage 4 — gallery as the alert viewer

- **`?event=<firingId>`** — app.js reads it on boot, fetches
  `/api/alert-firings/:id`, sets `state.alertEventIds` (a Set) + a dismissible
  chip ("⚠ new logos — 12 new"); `taggedFiltered()` gains one clause beside
  `selectedCrateId` (filters.js:59); include it in `filterKey()` (filters.js:14).
  Matches follow the content (firingMatches.live_entity_id): a merged-away
  entity's view row and webhook link point at the card its instance now
  lives under, resolved at read time. Only hard-deleted entities drop out of
  the view and lose their link (the payload keeps the frozen label) — and
  the chip count still states the original truth.
- **`?item=<entityId>`** — after boot, open the lightbox on that entity. Small,
  generally useful, and it's what makes per-entity webhook links land somewhere.
- Unseen-count refresh (the plus-caret dot and the dropdown row badges)
  piggybacks the existing delta-poll cadence (data.js) — no new timer, no SSE;
  the 4 s in-flight poll is already the app's liveness.

## Out of scope (deliberately)

- Email/SMTP, per-service integrations (a Discord webhook is already a webhook),
  SSRF guards (plugin-fetch stance), board-shared alerts, instance-level
  re-firing, threshold conditions ("only when ≥N accumulate"), delivery as a
  plugin surface — the last is the natural follow-on once the plugin system has
  a hook story, and the events table is already the interface it would consume.
