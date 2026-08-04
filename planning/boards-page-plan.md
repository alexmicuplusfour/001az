# Boards page — a member-facing gallery of boards

**Status: SLICES 1–5 BUILT (2026-08-04); remaining: 6 (in-app verify by a
human — the build was checked throughout against a real headless browser).
Slices 2–3 were
revised after first render: the page now wears the GALLERY's chrome (styles.css,
full-bleed grid, the toolbar's row 1) instead of the admin/profile panel
chrome — see "The page".
Boards are managed on the admin page and
switched via a bare name-list dropdown; there is no member-facing surface that
shows "here are your boards" as a browsable thing. This adds `/boards.html` — a
card grid of the boards the signed-in user can access, each card carrying a
disordered stack of item thumbnails, the board name, its card count, and
presence indicators for tagging (taxonomy), custom mapping (AI-extracted
fields) and auto ingestion. Reached from the boards dropdown and the logo.
Self-contained for a fresh session; no migrations, no changes to the gallery
app's data flow.**

## The gap, and the shape of the fix

The member's only view of "what boards do I have" is the toolbar dropdown
([toolbar.js](../public/toolbar.js) `openBoardPop`, ~line 127): flat name rows,
`location.href = /?board=id` on click. Everything richer — item counts, AI
usage, access rosters — lives on the admin page behind `requireAdmin`
([admin-boards.js](../public/admin-boards.js) against `GET /api/admin/boards`).
The member-facing `GET /api/boards` ([server.js](../server/server.js) ~752)
returns only `{id, name}`.

The data model already answers every question the card wants to ask — all of
it columns on `boards` ([0001_baseline.sql](../server/migrations/0001_baseline.sql)):

| Card element        | Source                  | Detection                                         |
|---------------------|-------------------------|---------------------------------------------------|
| Tagging (taxonomy)  | `boards.facets` JSONB   | `facets.length > 0`                               |
| Custom mapping      | `boards.mapping` JSONB  | `mapping != null`; connector name at `mapping.input.connector` |
| Auto ingestion      | `boards.ingest` JSONB   | `ingest && ingest.enabled !== false` — the exact idiom `GET /api/boards/:id` already uses (~server.js:780) |
| Count               | `entities` table        | one `GROUP BY board_id`                           |
| Preview thumbnails  | `items.payload.files[0]`| `thumbnails/{name}.webp`, already auth-gated      |
| Access              | `board_members`         | `canAccessBoard` / `canManageBoard` ([db.js](../server/db.js) ~1161) |

So the fix is thin: one aggregate endpoint, one static page, two toolbar
touches. The gallery app (app.js, grid.js, view.js, filters) is untouched.

## Decisions, with the reasoning

**A separate page, not an in-app view.** The frontend is page-per-context
(index / admin / profile / login / logs). [app.js](../public/app.js)
hard-requires `?board=` and redirects without it; the toolbar, filter strip,
view.js's grid/rows session logic and the lightbox are all *item*-scoped.
Board switching is already a full navigation (`location.href` in
`openBoardPop`), so routing through a page costs the user nothing they aren't
already paying. And [board-modal.js](../public/board-modal.js) demonstrably
works outside index.html — admin.html imports it — so the page can host "New
board" / "edit board" without dragging the gallery app along.

**Plain CSS grid, gallery visual language — not grid.js.** The masonry in
[grid.js](../public/grid.js) (absolute positioning, per-column height
tracking, card cache keyed by signature, sentinel-driven append) earns its
complexity for thousands of variable-aspect items. Board cards are
uniform-shape and rarely number more than a couple dozen. Reuse the *tokens* —
`--gap`, the `.card` radius/shadow/hover-lift family in
[styles.css](../public/styles.css) (~365), the same `minmax(320px, 1fr)`
column feel — over a `display: grid` container. Identical look, none of the
machinery, no cache/sentinel to carry.

**One aggregate endpoint, not N detail fetches.** The card wants five facts
per board; fetching `GET /api/boards/:id` per board is N round trips and still
lacks counts/previews. New: `GET /api/boards/overview`, `requireAuth`, same
access filter as `/api/boards`, a bounded number of queries regardless of
board count.

**"N items" counts ENTITIES — what the member sees as cards.** The gallery
listing walks `entities` and attaches instances
([db.js](../server/db.js) `listItems`, ~136); on a derived-identity board one
card bundles several files. The admin table's `item_count`
(`boardItemStats`, instance rows) answers a different question — inventory,
not gallery size. The card label should match what clicking through shows, so:
`SELECT board_id, COUNT(*) FROM entities GROUP BY board_id`. Deliberate
divergence from the admin number; the plan owns it rather than inheriting it
by accident.

**No status filtering — anywhere.** `listItems` has no status WHERE clause:
members already see pending (spinner) and held (dotted-outline) cards in the
gallery. The boards page previews and counts therefore don't filter by status
either — filtering here would make the preview disagree with the gallery it
advertises. (Earlier drafts assumed held items were member-hidden; they are
not.)

**Previews are impressionistic, not face-exact.** The gallery's card face is
`selectFace(instances, mapping.face)` — it needs *all* of an entity's
instances plus board config, per entity ([faces/select.js](../server/faces/select.js)).
Replicating that in one SQL pass is real work for a 60px collage tile. Instead:
the newest N instances *that carry a file* per board, one window query —
`payload->'files'->0` projected to `{name, w, h, kind}`. On raw boards this IS
the card face (single-instance entities); on derived boards it may show a
non-face instance of an entity — fine for a preview stack. Boards that come
back short (pure connector boards whose entities have no files — the
symbol-tile cards in [kinds.js](../public/kinds.js) `connectorKind`) are
topped up from a second query: newest entities' `{symbol, display_name}`,
rendered as small symbol tiles reusing the `.connector-face` styling.
Connector boards with generated chart faces need nothing special — charts are
files, the window query picks them up.

**A deterministic fan, not actual randomness.** The "disordered stack" comes
from fixed transforms (−2°, −9°, +8°, +3.5° with small offsets), not
`Math.random()`. Stable across re-renders (no layout jitter), and adjacent
cards still read as disordered because their *contents* differ. Tiles are
uniform-size with `object-fit: cover`, so mixed aspect ratios stack cleanly.
Fetch 8 previews, render up to 4 — the surplus absorbs missing/broken thumbs.

Two refinements the build settled (an earlier draft said `nth-child` and
"shimmer"):

- **Explicit slot classes, not `:nth-child`.** A tile whose thumbnail 404s
  hands its slot to a spare; under `:nth-child` that re-index would spin every
  surviving tile to a new angle. `.slot-0`…`.slot-3` carry the transform and
  z-index, so a replacement lands in the same visual position. Verified: a
  board whose three newest thumbnails were missing still drew four tiles, each
  at its original angle.
- **A STATIC skeleton, no shimmer.** styles.css (~522) records the gallery's
  deliberate choice: "an animated shimmer forces style/paint/raster work every
  frame for every visible unloaded card". The tile skeleton is a flat fill for
  the same reason.

**Not every preview entry is drawable.** `w`/`h` are stamped only when
`storeFace` actually wrote a thumbnail (server/faces/index.js), so on the
text/docx path — where a failed peek render "leaves a badge, never rejects" —
a file entry can arrive with no thumbnail behind it. `w && h` is therefore the
existence test (exactly what kinds.js's `docKind.previewUrl` uses), and
undrawable entries are skipped in favour of spares. Consequence: the dashed
placeholder is keyed on "nothing drawable", NOT on `count === 0` — a board
with items but no renderable faces gets the placeholder while its count line
still tells the truth.

**No new access surface.** `/thumbnails` static serving is `requireAuth` but
not board-scoped ([server.js](../server/server.js) ~2589) — any authed user
who *knows a filename* can fetch it. That's a pre-existing property; the
overview endpoint only hands out filenames for boards the requester can
access, so it widens nothing.

## The endpoint

`GET /api/boards/overview` — `requireAuth`, placed beside `/api/boards`
(~server.js:752). Response: array, one entry per accessible board, in
`listBoards` order:

```json
{
  "id": "uuid",
  "name": "People",
  "count": 247,
  "facet_count": 7,
  "has_mapping": true,
  "mapping_connector": "cryptocurrencies",
  "has_ingest": true,
  "ingest_next_run_at": 1722600000000,
  "manage": true,
  "preview": [
    { "name": "people-ab12.webp", "w": 1024, "h": 768, "kind": "image" },
    { "symbol": "BTC", "display_name": "Bitcoin" }
  ]
}
```

- `count` — entities on the board (see decision above).
- `mapping_connector` — `mapping.input?.connector ?? null`; the gallery
  toolbar already surfaces this as the `mapping-chip`
  ([toolbar.js](../public/toolbar.js) ~177); the card indicator reuses the
  vocabulary.
- `ingest_next_run_at` — only when ingest is enabled, same guard as
  `GET /api/boards/:id`; feeds the indicator tooltip.
- `manage` — `canManageBoard`; gates the card's edit pencil, mirroring the
  gallery toolbar's pencil semantics.
- `preview` — up to 8 entries newest-first; file entries and symbol fill
  distinguishable by shape (`name` vs `symbol`).

Query plan:

1. `listBoards` + per-board `canAccessBoard`/`canManageBoard`, the same helpers
   `/api/boards` uses — fanned out with `Promise.all` so the lookups overlap
   instead of serializing. Deliberately NOT replaced by one batched
   `board_members` read: a second authorization path is the thing that drifts
   when the role rules change, and a global admin short-circuits without
   querying at all.
2. Entity counts: one `GROUP BY board_id`.
3. Previews: **top-n-per-board via LATERAL**, one query:

```sql
SELECT b.id AS board_id, t.name, t.w, t.h, t.kind
FROM unnest($1::text[]) AS b(id)
CROSS JOIN LATERAL (
  SELECT i.created_at, i.id AS iid,
         i.payload->'files'->0->>'name'     AS name,
         (i.payload->'files'->0->>'w')::int AS w,
         (i.payload->'files'->0->>'h')::int AS h,
         i.payload->'files'->0->>'kind'     AS kind
  FROM items i
  WHERE i.board_id = b.id AND i.payload->'files'->0 IS NOT NULL
  ORDER BY i.created_at DESC, i.id DESC
  LIMIT $2
) t
ORDER BY b.id, t.created_at DESC, t.iid DESC
```

4. Symbol fill, only for boards that returned fewer than 8 file previews: the
   same LATERAL shape over `entities` (`symbol`, `display_name`), restricted to
   the short boards.

**This needs migration 0028 (`idx_items_board_created`) to pay off, and the
index needs the LATERAL — neither half works alone.** Measured on ~8k items:
the original window-over-the-whole-table form took ~19ms and re-read and sorted
every row on every board to keep 8 of them, growing linearly with the library.
Adding the index changed nothing on its own, because projecting `payload`
forces a heap visit per row so nothing can terminate early. The LATERAL alone
was no better (~23ms). Together they walk each board's slice of the index and
stop after n: **~3ms, and flat as the library grows.** The index mirrors
migration 0014's reasoning for `entities`, one table over.

New db.js helpers: `boardEntityCounts(db)` and
`boardPreviewFaces(db, boardIds, n)` (the latter owning queries 3+4 and
returning `Map<boardId, entries[]>`). Kind strings ride through verbatim —
`kind` in files payloads is already the client vocabulary
(`instanceEntry`, db.js ~101).

## The page

`public/boards.html` + `public/boards.js`, served statically like
admin/profile/login. Boot: fetch `/api/me`; not signed in →
`location.replace("/login.html?next=/boards.html")`; then fetch the overview
and render.

It also honours the gate the OTHER standalone pages skip: a session with
`needs_password` (a fresh invite) goes to the set-password screen, as
[app.js](../public/app.js) ~123 does. profile.js and admin-members.js only
test `!me`, which is survivable for a settings page you reach from a menu —
but the gallery logo points here, so this page is a landing surface and can't
be the way around the gate.

**The page wears the GALLERY's chrome, not the admin/profile panel chrome.**
This reverses two earlier drafts (the first assumed styles.css was already
shared; the second swung to panel.css on discovering it isn't). Both were
wrong about the goal: an index of boards that looks like a settings page
disowns the product it indexes. boards.html loads **styles.css + dropdown.css
+ boards.css**, which buys the tinted `#f7f8fa` body, the floating sticky
glass header, `#toolbar`, `.tool-btn` and the dropdown — and a FULL-BLEED
grid, the same edge-to-edge `padding: 20px 24px 60px` the gallery's
`main#grid` uses, not panel.css's 1200px centered column.

Header: **row 1 only** — the `001az/` `.toolbar-logo` hard left, the user
menu hard right (`.auth` carries `margin-left: auto`). No filter row, no
search, no board switcher, no header-scroll collapse.

- boards.js **rebuilds** those two pieces rather than importing toolbar.js:
  that module is the per-board toolbar and drags in the entire app (filters,
  upload, lightbox, every modal). It's ~20 lines against the same shared
  parts — `openDropdown`/`ddRow`/`ddSep` from dropdown.js (no imports of its
  own) and `ICONS` from utils.js (pure functions over state.js) — using the
  same class names, so styles.css dresses them identically. The user menu
  carries the gallery's rows verbatim: Admin (when `is_admin`), Profile,
  separator, Sign out.
- `#toolbar` needs one local override: it reserves `margin-bottom`,
  `padding-bottom` and a hairline rule to divide itself from `#toolbar-sub`,
  which this page doesn't have. Left alone, the header floats with ~20px of
  dead space under a rule separating nothing.

**Card-internal classes are namespaced `bc-*`** (`.bc-face`, `.bc-stack`,
`.bc-thumb`, `.bc-body`, `.bc-name`, `.bc-meta`, `.bc-count`). Now that both
stylesheets load on this page, `.board-*` is taken: styles.css owns it for the
toolbar's board controls, and `.board-name` there is a 13px toolbar label that
would silently restyle every card title. Only `.board-card` keeps the prefix —
it has no counterpart.

Card anatomy:

```
┌───────────────────────────┐
│      ┌─────────┐          │  .bc-face — fixed aspect (4:3), overflow
│   ┌──┤         ├──┐       │  hidden; up to 4 .bc-thumb tiles, absolutely
│   │  │  (top)  │  │       │  positioned, per-slot rotation/offset;
│   └──┤         ├──┘       │  object-fit: cover; loading="lazy"
│      └─────────┘          │
│  Board name               │  .bc-name
│  247 items    ◈  ✦  ⟳    │  .bc-meta: count + indicator chips
└───────────────────────────┘
```

- Whole card is an `<a href="/?board={id}">` — real link, so middle-click /
  cmd-click work for free.
- Indicators reuse the muted-chip look (`.inst-count` family, styles.css
  ~774), icon-only + a `title` that spells the capability out. Ordered along
  the pipeline — what comes in, what's pulled out, how it's organised:
  - ingest → `ICONS.redo`, "Automatic ingestion — next run in 2h", reusing
    `fmtDuration` so the phrasing matches the gallery's countdown chip.
    Enabled but unscheduled (the sweep hasn't armed the stamp yet) drops the
    suffix rather than inventing one.
  - mapping → `ICONS.sparkle`, "AI-extracted fields"; when `mapping_connector`
    is set the chip also carries the connector name as text, the toolbar
    `mapping-chip` vocabulary.
  - taxonomy → `ICONS.tag`, "Tagging — N facets", off `facet_count`. There is
    deliberately NO `has_taxonomy` beside it: the other two capabilities pair a
    flag with a detail the flag can't be derived from (a connector name, a
    next-run stamp), but a count already implies presence, and two fields that
    can disagree is a bug waiting to happen. The client tests `> 0`.
  Absent capability = absent chip; no greyed-out placeholders.
- **`ICONS.sparkle` is new** — added to utils.js rather than inlined here, so
  the icon set stays in one place. Purely additive; the gallery is unaffected.
- `manage` → hover pencil (the gallery toolbar's affordance) opening
  `openBoardModal(id, { canEditAI: me.is_admin, onSaved: render })` — the
  modal already downgrades to content-only for non-admin board admins.
  **The pencil is a `<button>`, so it CANNOT live inside the card's `<a>`** —
  nested interactive content is invalid and behaves inconsistently. The grid
  item is therefore a `.bc-wrap` holding the link and the pencil as siblings,
  with the pencil absolutely positioned over the card. The wrapper also owns
  the hover lift so card and pencil rise together; the link keeps only the
  shadow. Revealed on `:hover` OR `:focus-visible` — hover alone strands
  keyboard users.
- boards.html must also load **modal.css + toast.css**, which board-modal.js
  renders into (the same set admin.html loads).
- Admins get a "+ New board" button in the header, same
  `openBoardModal(null, …)` call as the dropdown footer, navigating to the new
  board on save.
- Empty board → dashed placeholder face, "No items yet". Zero boards → page
  empty state: "No boards yet — ask an admin for access."
- Symbol-fill preview entries render as small tiles reusing
  `.connector-face`/`.connector-symbol` styling.

Layout: `#boards-grid { display: grid; grid-template-columns:
repeat(auto-fill, minmax(320px, 1fr)); gap: var(--gap); }`. Card shadow /
hover-lift copied from the `.card` rules so the two galleries feel like one
product.

**`public/boards.css` holds only the grid and the cards** — styles.css
supplies everything else (see "the page wears the gallery's chrome" above).
Note this page is the exception among standalone pages: admin.html and
profile.html load panel.css and keep rules local, and admin.html says so
outright ("colors inlined since this page doesn't load styles.css"). They're
settings surfaces; this one is a gallery, so it follows the gallery.

## Entry points

1. **Dropdown footer** ([toolbar.js](../public/toolbar.js) `openBoardPop`): the
   footer used to exist only for admins ("New board"). It's now always built —
   an "All boards" row → `/boards.html` for everyone, then the admin-gated
   "New board". A real `<a>` (middle-clickable), using the new `ICONS.grid`;
   `.tp-edit` gained `text-decoration: none` for it, the way `.dd-row` already
   carries "rows can be `<a>`". Two stacked footer actions is an existing
   shape — rows.js appends Edit + Retag the same way. Note the dropdown itself
   only renders with `state.boards.length > 1` — acceptable, since a one-board
   member reaches the page via the logo.
2. **Logo**: the `toolbar-logo` becomes an `<a href="/boards.html">` on the
   gallery page — conventional "home", and the ONLY route there for a
   one-board member. Needs `text-decoration: none` on the class. On the boards
   page itself boards.js builds it as a `<span>`, so it stays inert.
3. **URL**: `/boards.html` and the clean `/boards` BOTH work with no route at
   all — the static mount already carries `{ extensions: ["html"] }`
   ([server.js](../server/server.js) ~2631), so the planned `sendFile` alias
   is unnecessary. Verified against a running server.
4. **Deliberately NOT changed**: the no-`?board=` landing still redirects to
   the last-used board (app.js ~64–84, `lastBoard` in localStorage). Power
   users land on their board; the boards page is a destination, not a gate.

## Slices

**Slice 1 — server.** `boardEntityCounts` + `boardPreviewFaces` in
[db.js](../server/db.js); `GET /api/boards/overview` beside `/api/boards` in
[server.js](../server/server.js). Test file `test/boards-overview.test.js` on
the [helpers.js](../test/helpers.js) harness (throwaway Postgres,
`createBoard`/`setBoardMembers`/`createEntity`/`insertItem` seeds):
- member sees only assigned boards; global admin sees all; anonymous → 401.
- flags: facets `[]` vs populated; `mapping` null vs set (+
  `mapping_connector` projection); `ingest` null / `{enabled:false}` /
  enabled (+ `ingest_next_run_at` only when enabled).
- `count` counts entities, not instance rows (seed a 2-instance entity).
- preview: newest-first, file-less items skipped, symbol fill kicks in for a
  connector-only board, cap respected.
- `manage`: true for global admin and board-admin, false for plain member.

**Slice 2 — page skeleton.** `boards.html` + `boards.js`: auth gate, overview
fetch, card grid with name + count + click-through link, page/board empty
states, grid CSS. Renders with plain text faces before the stack exists —
verifiable on its own.

**Slice 3 — the face.** Thumbnail fan (fixed per-slot transforms, cover-fit,
lazy), symbol tiles, placeholder when nothing is drawable, `onerror` slot
handover to a spare. Static skeleton behind unloaded tiles.

**Slice 4 — indicators + manage.** The chip row with tooltips; hover pencil →
`openBoardModal`; header "+ New board" for admins; refresh-on-save.

**Slice 5 — entry points.** Dropdown footer restructure ("All boards" row for
everyone, "New board" stays admin-gated); logo → link on the gallery page.
(No `/boards` alias needed — the static mount already resolves it.)

**Slice 6 — in-app verify.** Run the app; check as admin AND as a plain
member (single-board member included): dropdown footer, logo, card
click-through, pencil vs no pencil, empty states, indicator tooltips, a
connector board's symbol tiles, lazy thumb loading on a big board.

## Prior art — how other apps draw this page (survey, 2026-08)

A verified web survey of collections-index pages (Pinterest boards, Apple/
Google Photos albums, Miro/Figma dashboards, Notion/Airtable galleries,
Raindrop, Are.na, Milanote, mymind, Trello). What bears on this design:

**Single cover image is the industry norm — and every app that uses one ships
cover-management UI to go with it.** Pinterest (owner-picked cover, hover
pencil → change-cover dialog), Apple Photos ("Key Photo", oldest-by-default,
long-press to override), Miro (per-card menu → change thumbnail), Figma
(first-page render, right-click "Set as thumbnail", 16:9), Notion
(configurable source: page cover / first block / files property), Airtable
(attachment-field cover). The stack decision dodges that entire feature: an
auto-derived preview needs no curation UI, no "which item represents this
board" concept, no cover column. Apple's own defaults are the precedent for
auto-derivation (oldest item for user albums, newest for smart albums).

**The single-cover norm is being second-guessed where curation is absent.**
Google Photos' Collections tab (Aug 2024 redesign) drew the criticism that
top-level cover tiles give "little insight into what's in each collection",
and Google is testing a replacement where each collection shows a scrollable
row of item previews. For boards nobody hand-curates — exactly our case — a
multi-item preview is where the field is heading, not a retro choice.

**Special behavior is signaled weakly elsewhere; chips + tooltips beat the
norm.** mymind marks auto-updating collections only by the "Smart Space"
name; Apple marks smart albums only by refusing cover customization; Figma
marks custom thumbnails with a small icon. Privacy states are mostly *hidden*
rather than badged (Pinterest secret boards vanish from all public surfaces;
Miro password boards drop off Recents when the session lapses). Nothing to
copy here — our three capability chips with `title` tooltips are already
ahead of common practice, and Are.na (three named visibility states) is the
only app treating collection state as first-class card vocabulary.

**Card interaction conventions confirmed.** Whole-card click target (card
grammar implies clickability — no "Open" buttons); per-card actions hidden
behind hover/overflow to avoid repeated-button noise (Miro's ⋯ menu,
Pinterest's hover pencil) — matches our hover pencil. One pattern worth
stealing later: Airtable cycles through a record's images on cover hover;
hover-advancing our stack is a cheap delight (see loose ends).

**Index-page growth path is sorting + pinning, everywhere.** Miro: sort by
created/last-opened/last-modified, ownership filters, starred section, grid/
list toggle. Google Photos Collections: sort by last-modified/title/
most-recent-photo, grid/list toggle. iOS 26 Photos: a "Pinned Collections"
shelf. Confirms parking ordering in [board-sorting-plan.md](board-sorting-plan.md)
territory; when it lands, "last updated" is the field's default sort.

**Dedicated destination beats merged surface.** Apple folded the albums index
into one continuous scroll in iOS 18 and reverted it in iOS 26 after
backlash, restoring a dedicated Collections tab; Trello likewise keeps the
boards page separate from its activity Home. Supports the separate-page
decision over an in-gallery view.

**Empty states.** The documented anatomy is copy + visual + action, with the
caveat that informative-only states (no CTA) are legitimate when the user
can't self-serve. Our member zero-boards state ("ask an admin for access")
is exactly that case; the empty-board card keeps it to copy + placeholder.

## Loose ends, called out

- **Hover-advance the stack** (Airtable-style cover cycling): on card hover,
  shuffle the fanned thumbnails forward through the 8 fetched previews. Pure
  CSS/JS polish, no API change — slice 3+ material if it earns its keep.

- **Preview ≠ card face on derived boards** — accepted (decision above). If it
  ever grates, the fix is a `selectFace` pass server-side, not client patching.
- **Per-board membership lookups** use the shared helpers, fanned out rather
  than batched — see the query plan for why that's deliberate.
- **Board ordering** — `listBoards` order for now. [board-sorting-plan.md](board-sorting-plan.md)
  territory if members want recency/pinning; the endpoint shape doesn't
  preclude it.
- **Live counts** — the page is fetch-on-load, no delta poll. It's a lobby,
  not a dashboard; the gallery's polling machinery stays where it is.
