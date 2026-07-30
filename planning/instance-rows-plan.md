# Instance rows — a gallery mode that shows the evidence

Parent design: `entity-instances-plan.md`. That plan built the model (entities
above instances) and gave the lightbox a two-zone panel, but the grid still
speaks the pre-entity language: card = one image, tags = one flat set. On a
derived-identity board this produces three standing confusions (live-observed
on the emma board):

- **Filter contradiction** — filtering by `hair-length/short` shows the Emma
  Roberts card wearing her long-haired face photo; the instance that earned the
  match is invisible behind the ④ badge. Entity matching is per-facet-any-
  instance (`filters.js` `matchesExcept`), face selection is filter-blind by
  design (`faces/select.js` determinism).
- **Union confusion** — the card tag pop renders the entity union flat: one
  person "has" medium, long, and short hair. The chip count (union size)
  matches nothing a user can point at.
- **Edit scope** — the grid tag editor silently targets `instances[0]`
  (`tag-editor.js:10`), pre-checks that instance's tags right after the pop
  showed the union, saves one instance, and its thumbnail shows the *entity
  face* — which diverges from `instances[0]` under `prefer`/`latest` face
  configs.

The fix is not more chrome on the card — it's a second gallery mode that
renders the model honestly: **entities stacked vertically, each row = the
untouched entity card + a horizontally scrolling strip of its instances**,
the whole group in a bordered surface. Every control on a tile is
instance-scoped API (`/api/instances/:id/*`), everything on the card is
entity-scoped (`/api/items/:id/*`) — the route split becomes the visible seam.
No server changes: the list payload already ships per-instance
name/w/h/kind/label/status/tags (`db.js` `instanceEntry`).

## Mode selection

- `state.view`: `null | "grid" | "rows"`. `null` = no explicit choice → auto.
- A single rows-toggle button in the toolbar's `.sort-group`, left of Sort —
  grid is the unmarked default, so no segmented control. Shown only where
  rows can matter (`rowsRelevant`): derived-identity boards, boards whose
  data already holds a multi-instance entity, or while rows is effective (an
  explicit rows choice always has a way back). Highlighted when rows is the
  *effective* mode, so an auto-flip is visible where the user's hand just
  was; a click sets the explicit opposite of the current effective mode, so
  it always visibly acts — including overriding an auto-engaged rows.
- **Filter sessions**: while `activeCount() > 0` (the toolbar's own
  definition of "filtered" — facet pills, untagged, status, uploader), a
  temporary session layer sits over the base preference. Entering flips to
  rows whenever the filtered result contains a multi-instance entity —
  regardless of the stored base. That condition is the raw-board guardrail:
  on classic galleries no multi-instance entity can exist, so the masonry
  never flips (entity-instances-plan's byte-for-byte promise holds); until a
  filter's result can stack, the session shows the base mode. The flip
  ratchets: once rows engages it holds for the session's life — deleting the
  result's last stack must not yank the view out from under the hand that
  clicked, and the board streaming in behind first paint can still engage it
  late. A
  toggle click during the session is **session-scoped**; clearing the
  filters drops the layer and restores the pre-filter base ("return to the
  previous mode"). Favorites/crates/search don't start sessions — they
  aren't "filters" by the toolbar's own accounting (each has its own
  control, none increments the Filters count).
- Outside a session, the toggle stores the base in `boardView:<boardId>`
  (the `boardSort:` pattern, same try/catch) — the standing preference is
  what you choose while browsing unfiltered.
- The mode joins the render key (append to `filterKey()`'s tuple), so
  `renderLimit` resets and the grid/rows caches never serve each other.
  `layoutGrid()` (and its callers in `render()`/`scrollToCard`) is gated to
  grid mode — it writes absolute positions; `#grid.rows-mode` is normal flow.

## The row group

`rows.js`, sibling to grid.js — grid.js is untouched except the layout gate.

- `.entity-row`: bordered surface (`--border`-style token, radius, padding),
  a two-column grid. Left: the exact card `cardFor` builds — but from a separate
  `rowCache`, so masonry inline styles (width/left/top) never leak in; CSS
  pins card width in rows mode (~300px, clamped on mobile). All entity
  affordances (hearts, crate, tag chip, reprocess-all, delete, bulk select,
  lightbox click) ride along for free.
- Right: `.inst-strip`, `overflow-x: auto`, tiles in created-ASC server order
  — the same order as the lightbox switcher, so the two surfaces never
  disagree about instance positions. No reordering under filters.
- **Single-instance entities render without a strip** — just the card in the
  container. The card already *is* that instance (its tag edit hits
  `instances[0]`, reprocess re-queues it, delete removes it); a one-tile strip
  would show the same photo twice with duplicate controls.
- Tile face: `thumbUrl(inst.name)` for images (and docs/audio with w/h — a
  rendered preview exists exactly when dimensions do, the `previewUrl`
  convention); extension badge fallback, mirroring the lightbox file rows.
  Tiles stretch to the row's height, and the CARD alone decides that height
  (grid container + zero-intrinsic-height strip, so a tall thumbnail can't
  inflate the row); per-row heights, not uniform — uniform would crop or
  letterbox the card face. Tile chrome (tag chip + actions) is DOM-mounted
  on hover exactly like the card's, so a 60-instance strip doesn't idle
  with 180 unused buttons.
- Tile click → `openLightboxAt(img, instId)`: new lightbox export = today's
  `openLightbox` + set `currentInstIndex` to the instance's index after open
  (`showLightbox` resets it to 0, so the entry point sets it after).
- **Face marker**: the tile whose id matches
  `selectFace(img.instances, state.boardMapping?.face)` gets a subtle chip —
  "why does the card show this photo" answers itself. The client `selectFace`
  copy moves out of lightbox.js into `public/face-select.js` (imported by
  lightbox + rows — still one client mirror of `server/faces/select.js`;
  `test/faces.test.js` parity assertion re-points at the new path).
- Progress lane, empty state, sentinel: shared. `appendMoreCards` grows
  mode-aware (appends row groups in rows mode); `visibleGridItems`/
  `scrollToCard` keep working — `.card[data-id]` elements exist in both modes.
- Row cache keyed by entity id with its own signature: `cardSig(img)` +
  per-instance `id|status|tags|undecided|dim` + face id — same
  recreate-just-what-changed philosophy as `cardEl`. In-flight instances show
  the spinner treatment via the existing `.onstage` observer on the group.

## Tile controls

Mirror of the lightbox's per-instance verbs, nothing invented:

- **Tag chip** — count = `inst.tags.length`; pop lists the instance's own
  tags; Edit → `openTagEditor(img, inst)` (the second parameter has existed
  since the entity split — the grid just never passed it). Edit scope,
  pre-checked state, and the photo on screen agree by construction.
- **Re-extract** — `POST /api/instances/:id/reextract`, shown when the board
  mapping declares AI work (`identity.from === "ai"` or any field
  `from: "ai"` — the worker's own `aiWork` gate), since the route 409s
  without a stamped mapping. In rows mode a re-derived identity that
  re-parents becomes *legible*: the tile leaves this row and appears in
  another on the next poll (reconcile already handles the entity diff).
- **Retag** — `POST /api/instances/:id/retag`, always.
- **Delete** — `DELETE /api/instances/:id`, then the lightbox removal's exact
  follow-up: drop from `img.instances`, `refreshEntityTags`, re-pick the face
  via `selectFace`, re-render. Strips only exist at ≥2 instances, so the
  server's last-instance 409 is a concurrent-delete race backstop — toast it.
- No heart/crate on tiles: `favorites`/`crate_items` reference `entities(id)`;
  instance-level affordances would lie about the schema.

## Filtering inside rows

- `instanceMatches(inst)` — exported pure from filters.js: for every active
  facet selection, `inst.tagSet` has one of the selected values. Facet pills
  only; search scores, favorites, crates, status pills stay entity-level
  (search results are already deduped to entity ids server-side — there is no
  per-instance score to scope by).
- **Dim, don't hide**: non-matching tiles get `.inst-dim` (~.35 opacity).
  Hiding breaks on the cross-facet union case — an entity can match a filter
  that no single instance satisfies (short from one photo, emma-roberts from
  another), which would render an empty strip. An all-dim strip is the honest
  rendering: "matches only in aggregate".
- On render with active filters, the strip scrolls its first matching tile
  into view.

## Companion fix: union counts in the grid tag pop

In `openTagPop`, when `img.instances.length > 1`, each tag row gains a
`·n` count (instances carrying it) — turning "contradiction" into
"distribution" in the mode that keeps the union. Single-instance entities
(every raw board) render byte-identically. The earlier instance-strip-in-
editor idea is superseded: the row *is* the strip, and the editor is always
instance-scoped from both entry points.

## Phases

1. **Tag-pop counts** — self-contained, ships alone.
2. **Mode plumbing + read-only rows** — `state.view`, toggle, persistence,
   render-key mode, layout gate, rows renderer (card + strip + face marker +
   tile click → `openLightboxAt`), shared `face-select.js` extraction.
3. **Tile controls** — tag pop/editor, re-extract, retag, delete with face
   re-pick.
4. **Filter integration** — auto-enable rule, `instanceMatches`, dim +
   auto-scroll.
5. **Sweep** — README gallery section, styles polish, mobile pass (card width
   clamp, touch scroll), pointer from `entity-instances-plan.md`.

## Tests / verify

- `test/instance-rows.test.js` (the board-sort pattern — pure functions over a
  state shim): `instanceMatches` single/multi-facet/no-selection;
  the auto-enable decision table (override set / unset × filter on/off ×
  multi-instance present/absent); tag-pop count math.
- `test/faces.test.js`: parity assertion re-pointed at `face-select.js`.
- Live verify on the emma board: filter `short` → rows auto-engage; the
  Roberts row scrolls its short-haired tile into view bright while the rest
  dim; the card face is unchanged; tile tag edit shows that photo and saves to
  that photo; re-extract on a re-classified photo visibly migrates the tile to
  the other row; tile delete re-picks the card face; grid mode's tag pop now
  reads `hair-length/short ·1`. On a raw board: filtering never flips the
  mode; the toggle still offers rows (bare cards in containers) and back.
