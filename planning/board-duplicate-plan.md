# Duplicating a board — config, not content (2026-09-17)

**Status: BUILT 2026-09-17 (both stages) + simplify pass, uncommitted. Suite
1604 green (8 new in [board-duplicate.test.js](../test/board-duplicate.test.js)).**
Server verified against Postgres; the row button is linted but not yet clicked
in a browser — the running compose image predates the change. The content fork
under **Deferred** stays unbuilt and unasked-for.

The thing done by hand today, repeatedly: a board exists with the right
taxonomy, the right mapping, the right pins, and the next one needs the same
shape. The instance's own board list is the evidence — `objects test`,
`stocks test`, `stocks cancel test`, `transcriber test`, `resumes test`,
`empty board`. Each of those was a taxonomy and a mapping retyped into a fresh
create modal.

Half the problem is already solved and names the seam: the **Tagging Guidance
clipboard** ([board-modal.js](../public/board-modal.js) `buildGuidanceClipboard`)
copies `{ context, facets }` between boards as one JSON document, and its own
comment says why it carries both halves — "moving a board's tagging to another
board means moving both". Duplication is that sentence extended to the rest of
the row: the mapping, the pins, the schedule, the feed config.

## The decision: config only

**A duplicate copies the board's configuration and none of its content.** No
items, no entities, no files, no history.

Not a staging decision — a design one. Three independent arguments land on it:

**Tags are not separable from items.** Tags live in `items.tags`, per-instance
extraction in `items.payload.fields`, connector values in `entities.fields`.
They ride the row for free. So "with items, without tags" is not a lighter
option, it is a *bill*: it copies the rows and then asks a model to recompute
what was just discarded. The only coherent with-items copy is
everything-on-the-item, which makes the question "do we include tags" answer
itself.

**The cost is bytes, and the code forbids sharing them.**
`cleanup()` ([sources/index.js](../server/sources/index.js) `cleanup`) removes
`galleryDir/<name>`, `thumbsDir/<name>.webp` and the `.txt`/`.html` sidecars by
name, with no refcount. Two boards therefore cannot reference one stored file —
deleting either board punches holes in the other. A with-items copy means
physically duplicating every original and thumbnail, or introducing
refcounting into a delete path that is currently a one-liner. The `ui` board
is 4,668 items.

**A with-items copy is born locked.** Mapping templates lock once a board has
items ([mapping-modal.js](../public/mapping-modal.js) `hasItems` — "templates
rewire the whole mapping, only sane while the board is empty"). A config-only
copy is born empty and therefore fully editable, which is the entire point of
duplicating one. A with-items copy would arrive unable to change the mapping
it just copied — the feature shipping pre-broken for its most likely use.

If a with-items fork is ever wanted it is a different feature with a different
name and a different confirm dialog (see **Deferred** below). It is not a
checkbox on this one.

## What a board owns, and what happens to each part

| | |
|---|---|
| **Copied as-is** | `facets`, `context`, `ai_reasoning`, `ai_research`, `ai_votes`, the capability pins (`ai_key_id`/`ai_model`, `extract_*`, `transcribe_*`, `detect_*`), `tag_image_preset`, `auto_tag*` (incl. `periodic`/`every_min`/`skip_weekends`), `mapping`, `retag_on_refresh` |
| **Copied, arrives off** | `ingest` — with `enabled: false` |
| **Not copied (sweep-owned)** | `auto_tag_next_run_at`, `ingest_next_run_at`, `ingest_state`, `facet_diagnostics`, `paused` |
| **Not copied (history)** | `job_log`, `usage_meter`, `ingest_log` |
| **Not copied (content)** | `entities`, `items`, `tag_snapshots`, `field_snapshots`, gallery + thumbnail files |
| **Not copied (per-user views)** | `crates`, `crate_items`, `filter_configs`, `favorites`, `alerts` |
| **Copied** | `board_members`, roles included |

Notes on the ones that aren't obvious:

**Only the feed has to arrive off, and the distinction is exact.** An armed
`auto_tag_periodic` timer on an empty board fires, finds nothing to tag, and
re-arms — free, so it rides across unchanged and the copy keeps the schedule it
was configured with. An armed **ingest** timer scans a real source and admits
everything it finds. Two boards on one FTP folder or one connector feed, double
spend, and — because the copy's `ingest_log` is empty — it re-ingests every key
the original already admitted, including everything the user deleted from it
(the ledger being what makes deletion stick, [0015](../server/migrations/0015_ingestion.sql)).
Airtable duplicates a base with its automations copied *but turned off*, for
exactly this class of reason; the same call here, narrowed to the one leg that
actually costs something.

A **manual**-trigger feed needs no handling — it never arms — and must not be
written `enabled: false`, which is meaningless there (`enabled` pauses a
schedule; a manual board has none) and which the save trunk normalizes back to
`true` anyway.

**History must not follow.** `job_log` is the transparency ledger
([0021](../server/migrations/0021_job_log.sql)); a copy carrying rows for runs
that never happened on it is simply a false record. Same for the spend tables.
None of these are reached by the copy statement below, so this costs nothing to
honour — but `usage_meter` is worth knowing about for the opposite reason: it
has **no FK on boards** (its `''` app-scope sentinel forbids one), which is why
`deleteBoard` has to purge it by hand.

**`facet_diagnostics` are measurements of items.** The copy has none. Dropping
them is not a simplification, it is the only true value.

**Alerts stay behind.** They are per-user (`UNIQUE(user_id, board_id, name)`)
and carry a live webhook. Copying them onto an empty board is harmless but
pointless; copying them onto a board *with* items would require re-running
[0024](../server/migrations/0024_alert_baseline.sql)'s baseline seed or the
copy announces its entire pre-existing matching set as new. Config-only makes
the question moot, which is another small argument for config-only.

**Cross-references do not break.** The classic duplication hazard — Notion's
relations pointing back into the source workspace — has no analogue here.
`ai_key_id` → `ai_keys`, `ingest.source.connectionId` → `source_connections`
([ingestion/files.js](../server/ingestion/files.js)), `mapping.input.connector`
→ an installed plugin name. All instance-global. The copy points at the same
rows and works.

## The mechanism: a row action and one copy route

A `duplicate` button on each row of the admin Boards table, beside `edit`. It
takes no input: the copy is named `Copy of <name>`, created immediately, and
the table re-renders with it at the bottom.

**No confirm.** That file's rule is already written down on the `tag held`
button — "deliberately has no confirm" — and it is the right rule: confirm what
costs money or destroys something. A duplicate is additive, free, and undone by
the `delete` sitting four buttons along.

**No name prompt.** `Copy of <name>` is right often enough, and `edit` is in
the same row for when it isn't. Duplicating twice yields two boards called
`Copy of stocks test`, and duplicating a copy yields `Copy of Copy of stocks
test`. Both are harmless — `boards.name` has no unique constraint and nothing
in the app resolves boards by name — and de-duplicating would be machinery for
a non-problem.

### Why a new route rather than the create route

The create route's own comment warns against a second write path: create used
to hand-copy PATCH's validation checks and had already drifted. That warning
does not apply here, and seeing why is what makes this small.

**A duplicate has no user input, so there is nothing to validate.** The source
row is already valid — it went through the trunk when it was saved. Routing a
copy back through `buildBoardContentUpdate` would be re-validating the
database against itself, and it would mean the client first reading every
column and posting it back, which puts a hand-written column list in the
browser. This is a copy, not a create.

### The copy statement

The one design decision in the whole feature: **derive the copied columns by
subtraction, not by listing them.**

`BOARD_COLS` ([db.js](../server/db.js)) is the existing hand-written list of a
board's configuration, and it already carries a comment about what hand-written
costs — "a new column is invisible until it is named here, which is how a
feature evaporates into 'it never writes anything' with a green suite". An
allow-list for duplication would reproduce exactly that: add a board setting,
forget the second list, and duplication silently stops carrying it. A
*deny*-list inverts the failure — a new setting is copied by default, and only
a column someone consciously excluded is left behind.

That needs `BOARD_COLS` split into its array and a join, which is the only
change to existing code:

```js
const BOARD_COL_LIST = [
  "id", "name", "facets", "context", "ai_reasoning", "ai_research", "ai_votes",
  ...BOARD_BINDING_COLS,
  "auto_tag", "auto_tag_periodic", "auto_tag_every_min", "auto_tag_skip_weekends",
  "auto_tag_next_run_at", "mapping", "gather_every_min", "retag_on_refresh",
  "paused", "ingest", "ingest_next_run_at", "ingest_state", "facet_diagnostics",
  "created_at",
];
const BOARD_COLS = BOARD_COL_LIST.join(", ");

// What a COPY does not inherit. Everything else in BOARD_COL_LIST travels —
// see the deny-list reasoning above. Each entry needs a reason, and these are
// the only four kinds there are:
const NOT_DUPLICATED = new Set([
  "id", "name", "created_at",                     // the copy's own
  "auto_tag_next_run_at", "ingest_next_run_at",   // timers: the sweep arms them
  "ingest_state",                                 // run status of a board that hasn't run
  "facet_diagnostics",                            // measured against items the copy lacks
  "paused",                                       // a copy starts unpaused
]);
```

`duplicateBoard(db, srcId, name, { pauseIngest })` is then one transaction of
two or three statements — the SQL text is built once at module load, since
neither the column list nor the deny-list changes at runtime:

```
1. INSERT INTO boards (id, name, created_at, …DUP_COLS)
     SELECT $1, $2, $3, …DUP_COLS FROM boards WHERE id=$4   -- 0 rows → null
2. UPDATE boards SET ingest = jsonb_set(ingest, '{enabled}', 'false')
     WHERE id=$1                                            -- only if pauseIngest
3. INSERT INTO board_members (board_id, user_id, role, created_at)
     SELECT $1, user_id, role, $2 FROM board_members WHERE board_id=$3
```

**`pauseIngest` is the caller's decision, not a predicate in SQL.** Whether a
feed is on a schedule is `ingestMode()`
([ingestion/index.js](../server/ingestion/index.js)) — the single place that
ranks manual over `enabled` — and both the save trunk and the worker already
consume it. Spelling it here as `ingest #>> '{trigger,mode}' IS DISTINCT FROM
'manual'` would be a third copy of that rule, in a language where it cannot be
tested beside the other two: add a trigger mode and `server.js` and `worker.js`
move together while the `WHERE` clause silently does not. db.js cannot import
`ingestMode` itself — `ingestion/files.js` imports db.js, so the edge would
close a cycle — so the route decides and passes a flag. It also gets the rule
exactly right for free: a feed the user had *already* paused needs nothing done
to it, which the SQL predicate would not have known.

Statement 3 is a raw statement rather than `setBoardMembers`, because that
function opens its own `withTx` and `withTx` calls `db.connect()` — it cannot
nest inside the transaction this needs to be. It lives beside
`ADD_BOARD_MEMBER` as `COPY_BOARD_MEMBERS`, under the comment that exists to
keep the `board_members` row shape in one place. Copying the rows directly is
also the better behaviour: `role` travels, so a board-admin on the original is
a board-admin on the copy, which `setBoardMembers(ids, adminIds)` would have
made us take apart and rebuild.

`glosses` and `type` are dead columns that `BOARD_COLS` already omits, so the
copy gets their schema defaults. Correct, and free.

### The route

```js
app.post("/api/admin/boards/:id/duplicate", requireAdmin, requireBoardManager, wrap(async (req, res) => {
  const src = req.board;
  const name = `Copy of ${src.name}`;
  const pauseIngest = ingestMode(src.ingest) === "scheduled";
  const copy = await duplicateBoard(db, src.id, name, { pauseIngest });
  if (!copy) return res.status(404).json({ error: "not found" });
  res.json({ id: copy.id, name, members: copy.members, ingestPaused: pauseIngest });
}));
```

`requireAdmin` matches `POST /api/admin/boards` — creating a board is a
global-admin power. `requireBoardManager` behind it does the board lookup, the
404 and the `req.board` attach that this route would otherwise hand-roll; a
global admin always passes its role check, so it changes no permissions. That
composition is the one `PATCH /api/admin/boards/:id` already uses, with a
comment saying exactly this.

## Stages

**Stage 1 — the copy.**
`BOARD_COL_LIST` / `NOT_DUPLICATED` / `duplicateBoard` in db.js, the route in
server.js, the `duplicate` button in
[admin-boards.js](../public/admin-boards.js). Toast names the copy and its
member count; `renderBoards()` on success.

**Stage 2 — tests.**
The deny-list is the feature, so the test that matters is the one that fails
when someone adds a board column and forgets this file: assert
`BOARD_COL_LIST` minus `NOT_DUPLICATED` equals the copied set, and that every
name in `NOT_DUPLICATED` is actually in `BOARD_COL_LIST` (a typo'd exclusion
would silently copy the column it meant to block). Then:

- a duplicate of a fully-configured board matches it column for column on
  everything outside the deny-list — pins, mapping, facets, context, votes,
  the auto-tag schedule;
- both timers and `ingest_state` are null on the copy, and `paused` is false;
- a scheduled feed arrives `enabled: false`; a manual one is untouched;
- members and their roles come across;
- the copy has no items, no `job_log`, no meter rows;
- duplicating a board with items leaves the copy empty and therefore
  template-unlocked.

## Deferred: forking a board's content

Written down so it is a decision rather than an omission. If "duplicate with
items" is ever actually wanted, it is a **separate, loudly-confirmed action**
("Fork *wardrobe* — 461 items, ~N GB") and it needs, at minimum:

- a file strategy — physical copy of every original + thumbnail + sidecar, or
  refcounting introduced into `cleanup()`;
- `ingest_log` copied wholesale, or the fork re-ingests everything the original
  admitted and resurrects everything it deleted;
- `alert_matches` baselined ([0024](../server/migrations/0024_alert_baseline.sql))
  for any alert that comes with it;
- an answer for the mapping lock — the fork is born with items and therefore
  cannot be re-templated;
- a progress surface: 4,668 items and their bytes is a job, not a request.

None of that is speculative work worth doing before something asks for it.

## Known limits

**The copy shares the original's credentials by reference.** Both boards point
at one `ai_keys` row and one `source_connections` row. That is correct — they
are instance-global — but it means deleting a key breaks both, and the copy's
spend lands under its own `board_id` in the meter while the *key* is shared.
Nothing to fix; worth knowing before someone reads a bill.

**The copy is unreviewable before it exists.** A row button creates it outright
— there is no preview and no chance to adjust the mapping on the way through.
Accepted because the copy is free, empty, additive and deletable, and because
the alternative (routing duplication through the create modal so its panes
could be pre-filled) costs a refactor of every config read in that modal and
buys a review step for a board that has nothing in it yet.

**The feed arrives off with no announcement.** `enabled: false` is written
server-side and the only place it surfaces is the copy's own ingest modal,
later. That is the right default and the wrong silence; if it proves
surprising, the toast is where to say it.

**Nothing carries the source board's identity forward.** The copy has no link
back and no record that it was duplicated. Deliberate: a provenance column
would be a new fact to maintain for a relationship that stops being true the
moment either board is edited.

**The row is getting wide.** `edit · duplicate · access · retag · delete` is
five buttons, and a board that is both holding items and running a queue adds
`tag held` and `stop` for seven. Nothing here fixes that; it is the first
thing to look at if the cell starts wrapping.

**There is no "apply this board's settings to that one".** Duplication only
ever makes a new board. Re-applying onto a live one is a different and more
dangerous action — it would overwrite a board's taxonomy and mapping — and the
guidance clipboard already covers the safe half of it.

**The deny-list's promise holds only inside `BOARD_COL_LIST`.** "A new setting
is copied by default" is true of any column someone remembered to add to that
hand-written list — which is the rot its own comment warns about, now inherited
by a second feature rather than fixed. A column added to `boards` and wired
into `updateBoard` but missed in `BOARD_COL_LIST` is neither selected nor
copied, and these tests stay green because they derive from the same list.
db.js hand-maintains four enumerations of this table already (`BOARD_COL_LIST`,
`NEW_BOARD_DEFAULTS`, `createBoard`'s INSERT list, `updateBoard`'s if-chain);
`NOT_DUPLICATED` is a fifth. The real fix is one source of truth — introspect
`boards` once at boot the way [backup.js](../server/backup.js) `tableColumns`
already does, and define `BOARD_COLS` as all-columns-minus-`NOT_SELECTED`
(which would finally give the dead `type` column a stated home). That is a
refactor of four existing call sites and was out of scope here, but it is the
change that would make this feature's headline property actually true.

**`NOT_DUPLICATED` names three concepts under one.** Row identity
(`id`/`name`/`created_at`), armed timers, sweep-owned state
(`ingest_state`/`facet_diagnostics`) and one user-owned flag (`paused`) share a
Set. The sweep-owned pair is a concept `updateBoard` already owns under another
name — it refuses to write exactly those two, by omission from its if-chain,
with the same reasoning a hundred lines away. Naming it once
(`SWEEP_OWNED_COLS`, skipped by construction in `updateBoard` and composed into
`NOT_DUPLICATED`) would mean a new sweep-owned column is added in one place
instead of remembered in two. Same scope call as above.

**`withTx` cannot take an existing client.** That is why the membership copy is
a raw statement rather than `setBoardMembers`. db.js documents a `dbc` (pool or
tx client) convention elsewhere — `recordIngest`, `stampIngestDeleted`,
`admitFile` — and teaching `withTx` to pass a client through would make all
nine of its call sites composable. Deferred: it is a change to shared
infrastructure for one caller's convenience, and `COPY_BOARD_MEMBERS` living
beside `ADD_BOARD_MEMBER` keeps the row shape in one place meanwhile.
