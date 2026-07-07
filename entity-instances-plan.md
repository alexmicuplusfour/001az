# Entities & instances — per-instance fields and tags

✅ Shipped 2026-07-08 (all four phases in one pass; 116 tests green; migration +
per-instance re-extraction live-verified on the dev DB — the "Toyota" entity from
the motivating screenshot now carries FJ45/brown, MR2/gray-sports, FJ40/white as
three instances). Deviations from the plan below:

- Instance routes live at `/api/instances/:id/{tags,reasoning,reextract}` and
  `DELETE /api/instances/:id` (not nested under items).
- Card-level `POST /api/items/:id/reprocess` stayed and re-queues **all**
  instances, so grid/bulk clients needed no changes; re-extract is per instance.
- A sole-instance entity whose re-derived identity changes and collides with
  nobody is **renamed in place** (hearts/crates survive) instead of split.
- The tag dossier gains an `entity: <display name>` line for identified entities.
- Instance removal doesn't re-queue anything (per-instance data made that step
  obsolete, as predicted).

Parent design: `pipeline-boards-plan.md`. This revises "The model": the entity is no
longer the item row — it's a thin row *above* items, and each item row becomes one
**instance** (one file + its own extracted fields + its own facet tags).

## Why

`modelInputFor` only ever sends `files[0]`. Today's "entity-level" fields and tags on a
merged entity describe just the first file; the other files are never seen by the AI.
(Cars board: "Toyota" holds three different cars, but one `car_model` and one tag set.)
The fix is not to make the AI look at all files at once — it's to store what the
pipeline already produces at the level it's actually true:

- **Entity** — identity, display name, connector-bound fields. Singular per board,
  one card. ("Toyota", "Priya Ramanathan", "bitcoin".)
- **Instance** — one file, its own `fields` (car_model per photo, email per résumé)
  and its own tags/reasoning. The material evidence.

Scope falls out of the field's source — `from: "connector"` → entity,
`from: "ai"` → instance. No new mapping config. Fields are **stored per instance,
always**; a person's two résumés both yielding the same email is provenance, not
duplication. Entity-level rollup, if ever wanted, is a display concern.

## Architecture: entities above items (not instances below)

New thin `entities` table; `items` rows become the instances **unchanged**. All the
delicate machinery — status flow, `claimNextPending*` (SKIP LOCKED), `failOrRequeue`,
`recoverStuck`, `tag_snapshots`, embeddings sweep — already operates per item row and
stays byte-identical; it was per-instance all along, mislabeled.

Alternative considered and rejected: a child `instances` table under items would
re-point every claim/retry/snapshot/embedding query at a new table — moving the risk
into the concurrency-sensitive, money-spending code. Entities-above moves the change
into the read layer and routes, which tests cover cheaply.

Entity ids are seeded from the old item ids (`OVERRIDING SYSTEM VALUE`), so
`favorites` / `crate_items` re-point to `entities(id)` with **values unchanged** and
client-visible card ids stay stable. Hearts and crates are entity-level, as they
already effectively were.

## Schema

```sql
CREATE TABLE IF NOT EXISTS entities (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id             TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  identity             TEXT NOT NULL,           -- normalised key (or filename while provisional)
  display_name         TEXT,                    -- AI's original casing / connector name
  symbol               TEXT,                    -- connector ticker face
  fields               JSONB NOT NULL DEFAULT '{}',  -- connector-bound fields only
  identity_provisional BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL
);
CREATE UNIQUE INDEX idx_entities_board_identity ON entities(board_id, identity);
ALTER TABLE items ADD COLUMN entity_id BIGINT REFERENCES entities(id) ON DELETE CASCADE;
DROP INDEX idx_items_board_identity;  -- uniqueness moves to entities
```

Items keep their payload shape with `files` as an array of exactly one entry (zero
churn in `modelInputFor`, `sources.cleanup`, thumb backfill; flatten to `file` in a
later pass if it itches). `payload.identity` on items goes vestigial (stays = filename).
`identity_provisional` / `display_name` move to the entity.

### Migration (idempotent, in initDb, guarded by `items.entity_id IS NULL`)

1. Create `entities`; backfill one per item with the **same id**, lifting
   `identity` / `display_name` / `symbol` / `identity_provisional` from payload; setval.
2. `UPDATE items SET entity_id = id`.
3. **Split multi-file items** (only derived-identity boards have them): row keeps
   `files[0]`; each extra file becomes a new item row under the same entity with
   status `pending_extract` (mapped) / `pending`. They were never individually
   extracted or tagged — queueing them fresh is the honest path. Costs a few AI calls
   on the next worker pass; acceptable, that data is wrong today anyway.
4. Re-point `favorites.item_id` and `crate_items.item_id` FKs to `entities(id)`
   (values unchanged).

## Pipeline (worker.js)

**Tagging** — mechanically unchanged (per item row = per instance). The tag call's
dossier becomes: entity display_name/identity + entity connector fields + the
instance's own extracted fields.

**Extraction** — same call, but derived-identity resolution now writes to the
*parent entity*:

- Parent still provisional → normalise, set entity identity/display_name
  (casing-preservation rule moves here). On 23505: **merge = re-parent** — point the
  instance's `entity_id` at the winner, delete the emptied provisional entity. The
  instance keeps the fields and tags it just earned; **no survivor re-extraction, no
  `appendItemFiles`, zero extra AI calls.**
- Parent established, same value → no-op. Different value → **split**: re-parent the
  instance to the existing entity with that identity (or a new one); delete the old
  entity if it lost its last instance. Re-extract finally un-merges. Instance tags
  survive a split (they describe the material); retag is a click if it mattered.
- Null → `identity_provisional` on the entity, only when it has no established
  identity (today's display_name guard, relocated).

Retired: `mergeIntoExisting`, `appendItemFiles`, `removeFileFromItem`,
`getItemByIdentity`/`setItemIdentity` (replaced by entity-table equivalents).

## Routes

- `GET /api/items` → entities with nested `instances: [{ id, name, w, h, kind, label,
  status, tags, undecided, fields? }]`; entity carries id (stable), identity,
  display_name, symbol, hearts, crateIds, aggregate status (any in-flight →
  in-flight, any failed → failed, else tagged).
- Upload → per file: create provisional entity (identity = filename) + one instance.
  Response gains the pair of ids.
- Connector create → entity row (bound fields, 409 on 23505 unchanged) + one file-less
  instance as the tag vehicle (today's `files: []` row, re-homed).
- `DELETE /api/items/:id` → entity: cascade instances, cleanup all files.
- `DELETE /api/items/:id/instances/:iid` replaces `/files/:index` — same last-one
  guard (409: delete the entity instead). No re-extraction needed anymore.
- Per-instance, addressed by instance id: `PATCH tags`, `reprocess`, `reextract`,
  `reasoning`. `requireItemAccess` still works — instances *are* items rows; entity
  routes get a sibling entity-access check.
- `/api/search` dedupes instance hits to entity ids (embeddings stay per instance).

## Client

- `state.items` = entities; `toItem` gains `instances[]`; card face = first instance,
  file-count badge when >1.
- Filters: entity matches when **any** instance's tagSet has the tag; one-pass facet
  counts count each entity once.
- Lightbox: two-zone Details panel — identity block pinned on top (displayLabel,
  provisional warning, connector fields); below it, the **selected instance's**
  fields + facet tags + reasoning, swapping with the existing file switcher. Tag
  editor, re-extract, download, remove all act on the selected instance.
- Bulk tag writes to every instance of each selected entity (1-instance in the common
  case, so identical to today).
- `reconcile()`: a merge now shows up as an entity id vanishing while its instance
  reappears under another entity → same merge toast, but no ghost-card problem —
  the instance and its data survive. Upload toast batches track instance ids.

## Guardrail

Raw-identity boards (the classic gallery) have exactly one instance per entity
forever and must behave byte-for-byte like today: same AI call count, same panel
(switcher hidden), same ids, same hearts. This is the regression surface — pin it
with tests before touching the worker.

## Phases

1. **Schema + migration + read layer** — entities table, 1:1 backfill, multi-file
   split, grouped list response. No visible behavior change on raw boards.
2. **Worker** — entity-targeted identity resolution, re-parent merge, split,
   provisional relocation; retire the file-append merge path.
3. **Routes + client** — instance routes, two-zone panel, per-instance tag editing,
   filters/counts, toasts.
4. **Sweep** — search dedupe, bulk ops, delete dead helpers, update
   `pipeline-boards-plan.md` "The model", README/schema comments.

## Tests / verify

- Suites to update: derived-identity (merge/split rewrite), extraction, docs,
  connectors, payload — the item factory becomes entity+instance.
- New: migration splits a 3-file row into 3 instances under one entity; merge
  re-parents keeping fields/tags; split detaches; last-instance delete guard;
  per-instance tag PATCH; entity cascade delete cleans all files.
- Live verify: two `test-resumes/` PDFs of the same person → one entity, two
  instances, per-instance email/phone with provenance; cars board → "Toyota" entity,
  per-photo `car_model` and per-photo color/function tags; lightbox switcher swaps
  fields+tags with the file.
