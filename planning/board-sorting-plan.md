# Board sorting: attribute catalogs per identity source

STATUS: shipped 2026-07-28 — 563 tests green (17 new in test/board-sort.test.js).
Implementation notes vs the plan as written: the media catalog endpoint is
`/api/file-fields` (not `/api/media/fields`); the persisted sort object also
carries `label` so the toolbar button can render without a catalog fetch;
while a search is active the similarity order wins outright (the board sort
resumes when it clears). Second-pass fixes the plan missed: upload response
rows now carry created_at/updated_at/media too (else session uploads sat in
the null tail of date sorts until reload), reconcile backfills created_at from
delta rows, a mapping save re-runs restoreSort (an edit can unbind the sorted
field or flip the identity mode under an active sort), and a failed catalog
fetch isn't cached for the session.

## Context

The gallery has two hard-coded sort toggles — A–Z (`sortAlpha`, on `displayLabel`)
and Top (`sortByHearts`) — applied client-side over the server's newest-first
order (public/filters.js:64-68, public/toolbar.js:440-454). Meanwhile the rest of
the system is rich in typed, sortable attributes: connector manifests declare
fields (crypto: price/market_cap/change_24h; stocks: 11 fields), the media
registry declares per-kind file metadata (duration, pages, megapixels, …), and
boards already bind these through `mapping.fields`. None of it is reachable from
the board view.

Plan: replace the two toggles with one sort dropdown whose entries are assembled
from the board's attribute catalogs, decided by `mapping.identity.from`:

- **`raw`** (or no mapping) — universal sorts + media-catalog fields for the file
  kinds actually present on the board. Entity:instance is 1:1 on raw boards, so a
  file's metadata simply IS the entity's — no aggregation question.
- **`connector`** — universal sorts + the board's bound connector fields
  (`mapping.fields` with `from:"connector"`). Bound fields are exactly the ones
  whose values exist in `entities.fields`, so the menu can never offer a sort we
  don't have data for. Future connectors (plugins) get sorting for free — the
  manifest/template already declares typed fields.
- **`ai`** (derived identity) — universal sorts only, by decision: name, dates,
  hearts, instance count. Media attributes are per-instance and entities are
  multi-instance here; offering them would require an aggregation policy
  (max? sum? face-instance?) we've deliberately declined. This also keeps the
  resume-board mental model simple.

Universal sorts (every board): **Name** (A–Z, `displayLabel`), **Date added**
(`entities.created_at` — also the default, i.e. today's server order), **Date
updated** (`entities.updated_at`), **Hearts**, and — derived boards only —
**Instance count** (files per identity; raw and connector entities always have
exactly one, so the entry would be dead weight there).

One sort active at a time (the menu is a radio, not the current independent
toggles); search-similarity ordering still wins while a search is active.
Mixed-kind file boards get the union of the applicable media sections; entities
lacking the attribute sort to the end (nulls last, both directions) in their
default newest-first order — same semantics `applySort` already uses in
ingestion (server/ingestion/filter-engine.js:70-86). Universal `file_type`
("Type") doubles as Finder-style group-by-kind for mixed boards.

Facts that shape the design (verified):

- The client eventually holds the ENTIRE board in `state.items` (boot page +
  `drainItems` background drain, public/data.js:297-324), and already re-sorts
  the filtered copy on every render. **Client-side sorting is the right layer** —
  no server ORDER BY, no cursor-follows-sort complexity, no JSONB index work.
- The list payload today ships neither `created_at`/`updated_at` nor any file
  metadata (server/db.js:187-221 — only face w/h/kind + connector `fields`).
  Date sorts and media sorts need the server to ship values; both are cheap.
- Media values are pure functions of the stored file entry ("capture-once,
  project-many", server/media/index.js). `extractFileFields` already computes
  the full projection internally (universal + applicable kind modules) before
  filtering to mapping-requested keys — the full bag just needs exporting.
- Media `added/modified/created` project as ISO `"YYYY-MM-DD"` strings —
  lexicographic compare is correct; entity `created_at/updated_at` are BIGINT ms
  arriving as JS Numbers. Comparator dispatches on catalog `kind` (text →
  localeCompare, number → numeric, date → either representation works via
  localeCompare-on-string / numeric-on-number).
- Connector field values live at `item.fields[key].v` client-side (shape
  `{ v, src, kind, at }`); mapping field entries are `{ key, kind, from, fn }`
  without labels — labels resolve from `/api/connectors` manifest fields (match
  by `fn`), same as the mapping modal does. The media catalog is served at
  `/api/file-fields` (server.js:2321-2325). Both are static per session —
  fetch once, lazily, on first menu open.
- `state.boardMapping` is on the client from boot (app.js:81) and re-stamped on
  mapping save (toolbar.js:214) — the catalog mode is always derivable locally.
- Kinds present on a board: scan `state.items[].instances[].kind` — no server
  support needed, and it stays correct as the drain lands.
- localStorage is the established client persistence (`lastBoard`, app.js:48).
  Sort is a per-viewer preference, not board config — localStorage per board,
  no migration, no route, no multi-user fight over one board-level setting.

## Design

**Sort state**: `state.sort = null | { by, dir }` replacing `sortAlpha` +
`sortByHearts`. `null` = default (server order, newest first). `by` is a
namespaced key so sources can't collide: `"name"`, `"created"`, `"updated"`,
`"hearts"`, `"instances"` (universal), `"media:<fn>"`, `"field:<key>"`
(connector-bound mapping field). `dir` defaults per kind: text → asc,
number/date/hearts/instances → desc. Re-selecting the active entry flips `dir`.

**Persistence**: `localStorage["boardSort:<boardId>"] = JSON.stringify(sort)`,
restored at boot, validated against the assembled catalog (a mapping edit or
kind disappearance invalidates silently → default). Seed: on a connector board
with no stored sort, start from `manifest.browse.defaultSort` if that key is
bound in the mapping (a crypto board opens by market cap, not upload order).

**Menu shape**: one dropdown replacing both buttons. Sections in order:
Board (universal entries) · media groups present ("All files", "Images",
"Audio", "Documents" — catalog `group`, filtered by `appliesTo` vs kinds
present) · connector section (manifest label, e.g. "Crypto"). On mixed-kind
boards, kind-scoped section headers carry a coverage count ("Audio · 12") so a
partial sort reads as intentional. `url`-kind fields excluded; media `added`
excluded (duplicate of universal Date added).

## Server changes

**1. server/media/index.js** — export the full projection:
`projectEntry(entry)` → flat `{ fn: value }` over universal + applicable kind
modules (extract the existing internal computation from `extractFileFields`;
that function becomes a filter over it). Pure, no new I/O.

**2. server/db.js `listItems`** — three payload additions, all modes
(full/page/delta):
- `e.updated_at` added to the entity SELECT (created_at is already selected,
  just not emitted).
- Item JSON gains `created_at`, `updated_at`.
- Item JSON gains `media`: `projectEntry(faceFileEntry)` for the face
  instance's file entry, `null` for connector entities (no files). Assembly
  keeps the raw `payload.files[0]` alongside each `instanceEntry` internally
  (it's in hand in the instances query) and projects only the face's — nothing
  per-instance is shipped, so derived boards with many files pay one bag per
  entity, not per file.

No migration, no new routes, no route changes.

## Client changes

**3. public/state.js** — drop `sortByHearts`/`sortAlpha`, add `sort: null`.

**4. public/sort.js (new)** — the whole feature's brain:
- `sortCatalog()` → sectioned entries `{ by, label, kind, group }` assembled
  from `state.boardMapping?.identity?.from` (absent mapping → `raw`), kinds
  present, and the lazily-fetched `/api/media/fields` + `/api/connectors`
  catalogs (cached module-level; menu renders universal entries immediately if
  the fetch is in flight).
- `sortValue(item, by)` → dispatch: `displayLabel` / `created_at` /
  `updated_at` / `hearts` / `instances.length` / `media?.[fn]` /
  `fields[key]?.v`.
- `applyBoardSort(list)` → no-op on `state.sort == null`; else stable sort,
  typed compare, nulls last regardless of direction (list arrives in server
  order, so the null tail and ties keep newest-first).
- `saveSort()` / `restoreSort(boardId)` with catalog validation + connector
  defaultSort seeding.

**5. public/filters.js** — `taggedFiltered` replaces the two sort lines with
`applyBoardSort` (search-similarity sort stays above it); `filterKey` swaps
`sortByHearts, sortAlpha` for `state.sort` (keeps grid memoization honest).

**6. public/toolbar.js** — replace the sort-group's two buttons with one
dropdown button labeled with the active entry ("Newest" default, e.g.
"Market cap ↓" when set), reusing public/dropdown.js. Active state styling when
`state.sort != null`. Selecting writes state + `saveSort()` + render;
re-selecting flips direction.

**7. public/app.js** — after board data lands (mapping known), `restoreSort()`
before first render.

**8. utils.js `toItem` / data.js `reconcile`** — carry `created_at`,
`updated_at`, `media` onto items; reconcile updates `updated_at` and `media` on
delta (a re-extract or file swap can change media values; `fields` already
follows the delta).

## Known-benign / deferred

- During the background drain a non-default sort shows a correctly-sorted
  partial list that grows as pages land — same progressive-settle behavior the
  hearts sort has today. Accepted.
- Live connector values (price, change_24h) refresh server-side; a delta poll
  updates `fields` and the next render re-sorts. Cards may reorder under a
  watching user on a live board — that's the point of a live sort; no
  mid-render suppression.
- Full-list sort runs on every render (N log N over the filtered copy) —
  identical cost profile to today's A–Z path; fine at current board scales.
- Per-instance AI-extracted fields as sort keys on derived boards: explicitly
  out (universal-only by decision). If ever wanted, the aggregation question
  (which instance speaks for the entity) must be answered first — face-instance
  is the natural candidate.
- Server-side/user-account sort persistence: not now; localStorage matches the
  existing pattern and loses only cross-device stickiness.
- Media bag adds ~10 small values per entity to list payloads; not worth a
  conditional. Revisit only if payload profiling ever says otherwise.

## Tests

- media/index: `projectEntry` full-bag shapes per kind (image/audio/pdf/text),
  null-fill for missing meta; `extractFileFields` unchanged behavior over the
  refactor.
- db listItems: `created_at`/`updated_at`/`media` present in all three modes;
  `media` null for connector entities; face-instance (not first-instance) entry
  projected when mapping.face redirects the face.
- sort.js (client): catalog assembly per identity mode (raw/connector/ai —
  derived offers universal only; instances entry only on `ai`; kind filtering
  on mixed boards; url/`added` exclusions); comparator nulls-last both
  directions, typed compares, stability (ties keep input order); restore
  validation drops a stale `by`; connector defaultSort seeding only when bound
  and nothing stored.
- filters: filterKey changes when sort changes; search precedence over board
  sort.
