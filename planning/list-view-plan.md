# List view: the board as a table (2026-09-27)

**Status: Stage 1 built and second-passed 2026-09-28, uncommitted. Stage 2
close-looked 2026-09-28 and split: 2a (List with the mouse) and 2b (the
keyboard) built, both 2026-09-28 and uncommitted. Stage 3 (the board's
columns) close-looked, amended and built 2026-09-28, uncommitted. Stage 4 (phones,
keeping your place, Shift-click) close-looked, amended and built 2026-09-28,
uncommitted.**

A clickable prototype, outside the repo, is at
https://claude.ai/artifact/QzTaTXLHvy9hDiARPeQW9n (private). It uses sample
data shaped like four real boards. The user's review on 2026-09-28: "i like
pretty much everything about it". Stage 2 builds toward it, with the
prototype's "Toggles" view buttons (D10, picked 2026-09-28).
Written 2026-09-27 from web research (two agents: how real products pair a
list with a grid, and the engineering side) plus a read of the view code.

Self-contained for a fresh session. Parents: `instance-rows-plan.md` (the rows
view and the grid/rows switch this plan widens), `board-sorting-plan.md` (the
sort catalogs the columns come from), `ui-updates-plan.md` (the components,
keys and draw gate a row is built with).

The user's method applies (memory: close look, then build, then a second
pass): one close read of each stage BEFORE building it, a fresh-eyes pass
after. The Stage 1 close read is expected to rewrite parts of this document.

Line links show the code as of Stage 1's second pass (2026-09-28, the
working tree on f8d5933).

## The ask

"i'm considering implementing a list view. wdyt? do some web research. it
would have to be something robust." After the research came back, the user
settled three things:

- **No tags in the table.** A row gets the same tags button a card has (the
  hover pop with the tags, Edit tags, Find similar).
- **Each viewer saves their own columns.**
- Write the plan.

## Why

What a table does that masonry can't:

- **The sort order reads.** Masonry drops each next card into the shortest
  column, so a sort (the stocks board by Volume ↓) is hard to follow down the
  page. The research agrees: lists win for comparing and sorting, grids for
  browsing pictures (NN/g, Baymard).
- **Titles get the full width.** Audio cards cut a title at ~40 characters
  ("Lovers Lagoon, Presented by NiiroCore [6n42r0wh5rjh1…").
- **Numbers line up.** A connector board is a stock screener, and its fields
  belong in columns.

Where it doesn't pay: picture boards (`ui`, 4,691 screenshots). The picture is
the content there, and the grid stays the way to browse it. The photo-first
products never built a list at all (Lightroom, Apple Photos, Pinterest).
That's fine: the view is each viewer's choice per board, and grid stays the
default.

Once it ships, it stays. Figma, YouTube and IMDb all faced revolts over
removing a list view. So this gets built to last, or not at all.

## What's there to build on

Most of what a list needs already exists:

- **The list and its order.** `taggedFiltered()` is the filtered, sorted list
  every view draws, and the lightbox's prev/next walks the same list
  ([lightbox.js:906-909](../public/lightbox.js#L906-L909)). Sorting is stable
  and puts empties last. While a search is on, its similarity order wins
  ([filters.js:157-161](../public/filters.js#L157-L161),
  [sort.js:145-159](../public/sort.js#L145-L159)).
- **The columns.** `sortCatalog()` already knows each board's sortable
  attributes by card mode ([sort.js:73-124](../public/sort.js#L73-L124)):
  - universal: name, dates, hearts, plus files on card-key boards;
  - the bound connector fields, with their labels;
  - the file fields for the kinds present.

  `sortValue()` reads any of them off an item.
- **A table.** The connector browse modal already is one
  ([paged-table.js](../public/paged-table.js),
  [connector-browse.js](../public/connector-browse.js)). It has column kinds,
  widths, right-aligned numbers and shared formatters, and a row click that
  skips the row's own controls
  ([connector-browse.js:164](../public/connector-browse.js#L164)).
- **A small face.** Each kind already answers `previewUrl(item)` for chrome
  that wants a small picture ([kinds.js](../public/kinds.js)). Kinds with no
  picture use the grey badge.
- **The card's parts** ([grid.js:205-445](../public/grid.js#L205-L445)):
  - `HeartControl`, `TagChip` and `CardActions`;
  - the pin that keeps the actions showing while a menu is open;
  - `cardProps()` and the value-by-value redraw check.
- **Bulk selection** is a set of ids, so it survives a view switch.
- **Batches and the draw gate.** Both views draw a batch at a time (60 cards,
  30 rows) as the page nears the "load more" marker at the bottom (the
  sentinel). Both skip a draw when nothing they read has moved.

What's in the way:

- **The view switch is two-way.** view.js knows grid and rows. (Corrected by
  the Stage 1 close look; the first draft said "about six places".)
  - Three checks in grid.js treat "not rows" as grid:
    - layout ([grid.js:77](../public/grid.js#L77));
    - load-more ([grid.js:640](../public/grid.js#L640));
    - the lightbox's scroll-back ([grid.js:618](../public/grid.js#L618)).

    With a third view, two of them would draw the grid's cards into `#grid`
    over it: load-more when the sentinel fires, and scroll-back when you close
    the lightbox on an item that isn't drawn yet. (Stage 1 flipped all three
    to "is the grid showing?"; the links are to the flipped lines.)
  - rows.js already asks "am I the view showing?"
    ([rows.js:329](../public/rows.js#L329)).
  - app.js's draw is the one real either/or
    ([app.js:60-68](../public/app.js#L60-L68)).
  - The toolbar's one on/off button
    ([toolbar.js:515-527](../public/toolbar.js#L515-L527)) and view.js's
    two-way toggle are the picker, which is Stage 2's work.
- **Select-all reads the page, and that's right.** Ctrl+A takes whatever
  `.card[data-id]` elements it finds
  ([grid.js:668-673](../public/grid.js#L668-L673)). A card whose picture
  failed to load draws nothing ([grid.js:529](../public/grid.js#L529)), so
  the page read skips an item you can't see. A list's rows only need the same
  `data-id`, and the selector widens to `[data-id]`.
- **Two ways to print a value.** Connector browse prints by the kind the
  manifest declares. The lightbox guesses from the field's key
  ([lightbox.js:19-56](../public/lightbox.js#L19-L56)): `file_size` → MB,
  `duration` → m:ss, `volume` → $B, and any other number ≥ 1 → dollars.
- **No keyboard path.** A card is a `<div>` with a click handler. The only
  thing Tab reaches on a card is its select button. The action buttons exist
  only while the pointer is over the card. So today an item can't be opened
  from the keyboard.
- **The page header is fixed and folds** as you scroll
  ([header-scroll.js](../public/header-scroll.js)). Anything sticky has to
  sit under a header whose height changes.
- **Faces are 600px wide**
  ([image-thumb.js](../server/faces/image-thumb.js), `THUMB_WIDTH`).

## The design

A third gallery view, **List**. It shows one row per card, in
`taggedFiltered()` order, drawn as a real `<table>` into `#grid` (where rows
mode draws today).

A row, left to right:

| select | face | name | data columns… | heart | actions |
|---|---|---|---|---|---|
| the card's select button | the kind's small face, ~48px tall | the display label, full width; the row's open button | from the board's catalog | the card's heart and count | on hover: tags, reprocess, delete, crate |

- **Face.** Each kind shows itself small through kinds.js:
  - photos are cropped to the box;
  - waveforms and charts show whole;
  - the grey badge shows when there's no picture.

  The row never branches on kind.
- **Name.** A `<button>`, which is how the keyboard and screen readers open
  the item. A click anywhere else on the row passes through to it, except on
  the row's own controls or at the end of a drag, so a title can still be
  selected. In bulk mode it selects, as a card click does.
- **Data columns.** The same catalog the sort menu reads, so a column and a
  sort entry can never disagree. No tags and no facets: the tags button
  covers them.
- **Heart.** The card's heart, as a fixed column. Its header sorts by hearts.
- **Actions.** The card's own `TagChip` and `CardActions`, drawn on hover and
  kept showing while a menu opened from them is open. That's exactly the
  card's rule.
- **Header.**
  - Each sortable column's header is a sort button. A click writes the same
    `state.sort` the toolbar's sort button writes: one sort, two controls.
  - The first click takes the column's default direction (`defaultDir`: text
    A→Z, numbers and dates high first). The next click flips it.
  - Going back to "Newest" stays in the sort menu.
  - The header sticks under the page header.
- **States.** The upload lane becomes rows at the top. Processing, needs-tags
  and selected become row styles.
- **Columns.** A Columns menu shows and hides data columns. The choice is
  saved per viewer per board and checked against the board on load.
- **Phones.** Face, name and one value. That value is the sorted column's, so
  a sort still reads. (Amended at the Stage 4 close look: touch tablets too,
  whenever the full table is wider than the screen.)

What doesn't move: the filters, the sort rules, the lightbox, the bulk bar,
the rows view itself, and the server (apart from D4's descriptors).

## Decisions (for the Stage 1 close read to confirm or overturn)

- **D1: a real `<table>`, not an ARIA grid.**
  - Screen readers read a real table cell by cell and announce the headers as
    you move. An ARIA grid would require arrow-key navigation and a roving
    tabindex, and buys nothing here: nothing in a row is edited in place.
    Higley: tables "can be sortable, filterable, virtualized, and can contain
    links and buttons without needing to be a grid". Roselli: don't turn a
    table into a grid just for a clickable row.
  - No select-all checkbox in the header either. Roselli: screen readers
    would read that header as the label of every row's checkbox. Select-all
    stays Ctrl+A and the bulk bar.
  - Tab stops per row: select and name. (Amended at the Stage 2 close look:
    the heart is a `<div>` with a click, on cards too, so it isn't one. It
    stays mouse-only in the row; the lightbox's heart is a real button.)
  - What the keyboard reaches, as the code stands (the Stage 2 close look;
    the draft assumed the lightbox had every action a row has):
    - select a row, then the bulk bar: Reprocess, Delete, Add to crate;
    - open a row, then the lightbox: heart, crate, download, and each
      file's Retag, Re-extract and Re-transcribe;
    - not reachable, in List as on cards today: Edit tags, Find similar,
      and the reprocess menu's item-level steps.
  - The lightbox itself ignores the keyboard's focus: it isn't focused on
    open, Tab walks the page behind it, and closing leaves focus where it
    started. Stage 2b fixes that.
  - Amended at the Stage 2b close look: the lightbox keeps the keyboard in
    by making the page behind it inert while it's open, not with the
    drawer's Tab trap (Stage 2b, finding 4).

- **D2: the name is the open button, and a row click passes through to it.**
  - The other pattern stretches the name's link over the whole row with
    `::after`. It's rejected for two reasons:
    - A `<tr>` can only anchor that overlay in Safari 27 onward (WebKit's
      Safari 27 notes, via the research). On older Safari the overlay would
      cover the whole table.
    - The overlay stops you selecting a title.
  - Passing clicks through keeps both, and the app already does it in
    connector browse.
  - The cost: NVDA reads the row's cells as "clickable". Accepted.

- **D3: columns come from the sort catalog.** One catalog, two readers.
  - Card-key boards get the universal set only. board-sorting-plan declined
    an aggregation rule for per-file attributes there, and this plan doesn't
    invent one.
  - Per-file extracted fields and transcripts aren't in the items payload
    (an item's `fields` holds connector fields only,
    [utils.js:62](../public/utils.js#L62)), so they can't be columns. Out of
    scope.

- **D4: one way to print a field's value.** The list must not become a third
  printer.
  - The minimal route: move the lightbox's `formatFieldNumber` to a shared
    module and call it from both. The list would inherit its guesses,
    including dollars for any unmatched number ≥ 1.
  - Proposed instead:
    - Each file-field descriptor declares how it prints, next to its kind
      (`server/media/*.js`, served by `/api/file-fields`). Unit formats
      already travel from the server that way (`fmtQty`,
      [utils.js:450-460](../public/utils.js#L450-L460)).
    - Connector fields already declare usd/percent/number.
    - One formatter, in a module the board page loads, prints by what it's
      handed. The list and connector browse use it, and it replaces the
      lightbox's key-guessing.
  - Stage 3's close read picks between the two routes and settles the format
    names. It also checks the lightbox's dollar fallback on extract number
    fields: from the code, a year of 2024 looks like it prints as
    "$2,024.00". Unconfirmed.
  - Amended at the Stage 3 close look: the declared route. The suspicion was
    wrong (an AI answer is stored with no kind and prints as it is); the
    dollars land on connector fields instead, a share count and a rank among
    them (Stage 3, findings 1-2). Connector fields don't declare a format yet:
    only the browse table's columns do. A manifest field gains an optional
    `format` in the browse table's words (`usd`, `percent`), a file field
    declares its own, and `fmtField` (utils.js) prints them all.

- **D5: few default columns, and never guessed from content.**
  - Defaults: Date added everywhere; every bound field on connector boards
    (the mapping already chose them); Files on card-key boards.
  - File fields start hidden, since a mixed board can offer close to twenty.
    The viewer adds what they want.
  - If the real-app check shows a board begging for one (Duration on audio),
    the smallest fix is a flag on that descriptor. The kind's own manifest
    speaks for it; the client never keeps a per-kind list.
  - A viewer's own choice always wins, and nothing rearranges it later.
    Windows picked folder columns by content, and it went badly (Hanselman
    2007, TechNet 2008).
  - Amended at the Stage 3 close look: the mapping didn't choose the fields.
    The templates bind the whole catalog, ten sortable fields on stocks and
    on crypto, about 1,940px of table where a 1280px window gives List 1,232.
    A connector board starts with the bound fields its domain previews (the
    browse columns marked `preview`: price, market cap, volume), the
    domain's own word for its headline numbers.

- **D6: per viewer, per board, in localStorage.** The user's call, and the
  `boardSort:` / `boardView:` pattern: `boardColumns:<boardId>`.
  - No stored value means the defaults.
  - A saved column the board no longer has is dropped at load, the way
    `validSort` drops a stranded sort
    ([sort.js:176-190](../public/sort.js#L176-L190)).
  - A column the board gains later shows up in the menu, not in a viewer's
    saved set.
  - Choices follow the device, not the person. Moving sort, view and columns
    to the server together is a later ask.
  - Amended at the Stage 3 close look: "no longer has" is judged by the
    board's card mode and the catalog, never by the file kinds loaded so far.
    A board loads its newest 200 items first, so a kind can arrive late.

- **D7: each view answers for itself (rewritten at the Stage 1 close look).**
  - Every check inside a view asks "am I the view showing?", never "is it
    rows?". rows.js already does; grid.js's three checks flip, one word each.
  - The two places that act on every view say so plainly:
    - app.js's draw picks the view;
    - app.js's frame pokes every view's sentinel, and each ignores the poke
      unless it's showing.

    The lightbox's close does the same: it asks each view to bring the item
    in, then scrolls to it. grid.js can't import rows.js, which already
    imports grid.js, so the caller asks each view.
  - Declined: moving the views behind one shared shape (one sentinel, one
    dispatcher). It would add a layer and fix nothing the flips don't.
  - Amended at the Stage 2 close look: the batch loading moves into one
    helper (batches.js) before List becomes its third copy. Each view still
    draws its own tree and keeps its own "load more" observer; the helper
    owns what they had copied: how many are drawn, the next batch, drawing
    far enough to hold an item, and re-arming the observer. Stage 1's bug
    was exactly a copy missing a step (rows never drew far enough for the
    lightbox). The lightbox's close and app.js's frame then ask the helper
    once instead of naming every view.
  - Declined: Ctrl+A reading the view's own list and limit. It would select
    a card whose picture failed, which you can't see, and a bulk delete would
    then delete it.

- **D8: auto-rows never overrides List.** While filters are on, the view
  flips grid to rows if the filtered result has any card with more than one
  file ([view.js:46-56](../public/view.js#L46-L56)). With List as the base,
  it stays List. Picking the dense view was deliberate, which is D5's lesson
  again.

- **D9: grid stays the default everywhere; List is always the viewer's own
  choice.** No board opens in List on its own, not even a connector board
  (the no-implied-choices rule). A board-level default view is a later ask.

- **D10: toggles (the user's pick, 2026-09-28, from the prototype's two
  shapes).**
  - Grid stays the unmarked default. List and Rows are each a button that
    switches its view on and off, like today's Rows button; pressing one
    while the other is on switches straight across.
  - List's button shows on every board, Rows' only where `rowsRelevant()`
    (as today). Most boards gain one button.
  - Icons from the prototype: List is a small square and a line, twice;
    Rows keeps its two bars.
  - Rejected: one button per view (Grid, List, Rows, the showing one
    pressed), which puts at least two new buttons on every board.

- **D11: keep the batches, no virtualization.** List draws in batches as you
  scroll, the grid's way, with fixed row heights.
  - Virtualizing would hide off-screen rows from find-in-page and screen
    readers, and add a dependency.
  - `content-visibility` does nothing on a normal `<tr>`, because layout
    containment doesn't apply to table rows.
  - Revisit only if a real board proves slow.

- **D12: thumbnails use the existing faces; measure before adding
  anything.**
  - A 48px row shows a 600px face, the same file the grid loads. A list
    scrolls through more of them, faster.
  - Stage 4 measures memory and bytes on the `ui` board.
  - A small face size (a new artifact plus a backfill) only on evidence.
  - Amended at the Stage 4 close look: no measurement. A row loads the file
    the card loads, and speed isn't the goal. A small face waits for a real
    board that proves slow.

- **D13: out of scope.**
  - group by;
  - column reorder and resize;
  - row height;
  - column presets;
  - CSV export;
  - editing in place;
  - expandable entity rows (files stay in rows mode and the lightbox);
  - the view in the URL.

  People will ask for each, and each is its own ask.

## Stages

Each stage: close read → build → suite green → a real-app check → a short
ledger note here.

### Stage 1: each view answers for itself

(Rewritten at the close look, 2026-09-27. The first draft's shared shape is
declined in D7. Go-ahead 2026-09-28: "you can start with stage 1".)

- grid.js's three checks become "is the grid the view showing?": layout,
  load-more and the scroll-back's draw-further step. Identical behavior
  today with two views.
- Rows loses your place after the lightbox; this stage fixes it.
  - The lightbox pages through the whole filtered list, but closing it
    scrolls back only if the item's row is already drawn
    ([grid.js:613-630](../public/grid.js#L613-L630)). The grid draws further
    to reach it; rows, which draws 30 at a time, never does.
  - So in rows view: page past row 30 in the lightbox, close, and you're back
    where you started.
  - Rows gets the grid's draw-further step, and the lightbox's close asks
    each view (D7).
  - Stage 4's "keep your place when switching views" needs every view to
    reach an undrawn item, so this belongs here.
- Ctrl+A stays as it is (D7).
- Proof:
  - The existing tests that cover both views stay green:
    - the flip and lane tests in [cards.test.js](../test/cards.test.js)
      (lines 305-319, 485-503);
    - [instance-rows.test.js](../test/instance-rows.test.js);
    - the browser flip guard
      ([ui-updates.test.js:564](../test/browser/ui-updates.test.js#L564)).
  - New: rows view with 70 entities; scrolling back to #66 draws it and
    scrolls to it. It must fail with the fix removed.
  - In Chromium through the harness: rows view, lightbox to item 35, close,
    and row 35 is on screen. This is a one-off check, recorded here, not a
    new browser test: the unit test already drives the real path (click a
    card, page with the arrow keys, close with Escape), and the browser
    README keeps browser tests for what only a browser does.
  - The flips can't change any markup while there are only two views, so no
    old-vs-new comparison. Their real test comes with List (Stage 2): the
    sentinel and the lightbox never draw cards into List.

**Stage 1 close look (2026-09-27): what the draft assumed vs what the code
does.**

1. Assumed about six "is it rows?" checks, needing one shared shape for the
   views. In fact rows.js already asks "is it me?", and only grid.js's three
   checks assume "not rows means grid". Two of those three would draw the
   grid over a third view. Fix: flip them, one word each; the shared shape
   is declined.
2. Assumed Ctrl+A should read the view's own list and limit. In fact a
   broken card draws nothing, so the page read skips it, and the
   list-and-limit version would select, and a bulk delete would delete, an
   item you can't see. Kept as it is.
3. Rows' lost place after the lightbox (above) was confirmed from the code
   and moved into this stage.
4. Where rows' scroll-back lives: the lightbox imports only grid.js, and
   grid.js can't import rows.js back. So each view gets its own step that
   does nothing unless it's showing, and the lightbox calls each. That's how
   app.js already pokes both sentinels
   ([app.js:65-67](../public/app.js#L65-L67)).
5. The markup comparison was dropped from the proof: two-view behavior can't
   change.

Found for Stage 2 (recorded, not built):
- view.js treats anything that isn't "rows" as grid
  ([view.js:21](../public/view.js#L21)).
- It throws away a saved view that isn't rows or grid
  ([view.js:100](../public/view.js#L100)).
- Its toggle only flips between two views, and instance-rows.test.js tests
  all three of these.
- Rows clears the masonry's leftover height when it draws
  ([rows.js:298](../public/rows.js#L298)); List must too.
- app.js sets only a `rows-mode` class ([app.js:60](../public/app.js#L60)).
- Upload placeholders deliberately have no `data-id`, so Ctrl+A skips them
  ([grid.js:351-353](../public/grid.js#L351-L353)). List's lane rows keep
  that.

**Stage 1 BUILT 2026-09-28 (uncommitted).**
- grid.js: layout, load-more and the scroll-back's draw-further step each
  ask "is the grid showing?"; the comments say why.
- rows.js: `revealRow(item)` draws rows far enough to hold an item, the
  grid's step done with rows' own limit. It does nothing unless rows is
  showing.
- lightbox.js: closing calls `revealRow`, then `scrollToCard`. The file's
  CRLF endings are kept.
- app.js: one comment updated.
- Tests, in test/cards.test.js: two new ones sharing `pageAndClose`. Each
  drives the real path: click the first card, press the right arrow 65
  times, press Escape.
  - Rows view, 70 entities: 66 rows drawn, and #66 scrolled to.
  - Grid view: 66 cards and no rows.
- Removal checks, each file restored byte for byte by hash:
  - R1, the lightbox without `revealRow`: the rows test fails on "drawn far
    enough" (expected 66 rows, got 30).
  - R2, `revealRow` without its "is rows showing?" check: the grid test
    fails with rows 66, cards 0. That's the rows view drawn over the grid,
    the hazard the check prevents.
- Not pinned, as planned: grid.js's three flips behave the same with two
  views. Their test comes with List.
- Chromium, through the harness, old vs new: rows view with 40 entities,
  lightbox to 35 / 40, Escape.
  - The committed frontend: row 35 never drawn, the page back at the top.
  - The working tree: row 35 drawn and on screen (the sentinel then loads
    the last 10), no page errors.
- Suite:
  - Lint clean, and the full run passed 2142 of 2142 in 97s.
  - A first full run had failed once in plugin-modal.test.js ("remove: the
    consequence-confirm names the roles…") and then hung for over 15
    minutes. The rerun, with `--test-timeout=120000` and the same code, was
    fully green.
  - Unrelated to this stage (the admin page never loads grid, rows or the
    lightbox), and not investigated.

**Stage 1 second pass 2026-09-28.** One reviewer read the diff cold, never
shown this plan. I checked the plan's claims, the tests' setups and the
production build.
- Behavior: nothing wrong.
  - The flips are identical with two views: `effectiveView()` only ever
    answers "grid" or "rows".
  - The lightbox is `scrollToCard`'s only caller.
  - Closing in grid view does what it did before.
- The build: production keeps one copy of rows.js, shared with the lazy
  lightbox chunk. The board page still loads the same 4 files at boot.
- Fixed:
  - The new tests had copied two helpers.
    - `until`: test/helpers.js already exports it and says new tests import
      it.
    - `shows()`: the flip test already had the same one.

    Each is one helper now, and so is the 70-item board (`longBoard`).
  - A test comment said the lightbox loads "on the first open". Every open
    waits on an import (lazy-door.js), which is why both tests wait.
  - `pageAndClose` closes the lightbox in its `finally`, so a failing test
    can't leave it open with the page's scroll locked.
  - Comments:
    - The close order was told in three places; now only at the call, in
      lightbox.js.
    - The load-more comment said each view's appender checks the view. On
      the rows side it's the observer that checks.
  - Line links in this plan: eleven pointed at pre-build lines, and line
    23 still named commit 0d6648b.
- Recorded, not changed:
  - The grid test passes on HEAD too. It guards the new code rather than
    catching a bug: it's the one that fails when `revealRow` loses its "is
    rows showing?" check (R2). It says so now.
  - Not pinned by any test:
    - grid.js's three flips, as planned (Stage 2);
    - `pokeRowsSentinel()` after the reveal: jsdom has no
      IntersectionObserver, and it's the grid's own step;
    - `revealRow`'s early return when the row is already drawn: it only
      skips work that would change nothing.
  - A reveal far down a board draws every row up to the item at once, as
    the grid's step does for cards. Not measured.
- Declined: the reviewer's "the code points at a plan the repo doesn't
  track". The repo tracks about 110 plans, and all 46 that code points at
  are tracked. This one goes in with the arc.
- After the pass:
  - The public/ edits are comments only: the minified bundle is
    byte-identical.
  - R1 and R2 fail on the same lines with the rewritten tests.
  - cards.test.js 19/19, lint clean.
- The pass's first full run timed out 6 browser tests on pages this stage
  doesn't touch. The build's hung run was still alive: a Bash-started
  `npm test` from 21:30, with two headless browsers busy. Killed. The five
  files then passed 51/51 on their own.
- The full run after the pass: 2141 of 2142 in 114s, lint clean.
  - The one failure is welcome.test.js:291. It checks, at one instant, that
    the boards page's loading spinner is gone, and it lost that race under
    the suite's load.
  - The boards page loads none of this stage's files, and the file passed
    10/10 on its own. Not fixed: outside this stage.

### Stage 2: List, with the fixed columns

(Close-looked 2026-09-28 and split in two. Go-ahead for 2a the same day:
"yes. toggles. go ahead".)

**Stage 2 close look (2026-09-28): what the draft assumed vs what the code
does.**

1. Assumed keyboard users open a row and act in the lightbox. The lightbox
   never takes focus, lacks Delete, Edit tags, Find similar and the full
   Reprocess, and the heart isn't a tab stop (D1, amended). The keyboard
   work becomes its own stage, 2b.
2. Assumed a sort starts unmarked. "Newest first" is exactly Date added,
   newest first: the server orders by `created_at DESC, id DESC`
   ([db.js:305](../server/db.js#L305)). So with no sort chosen, the Date
   added header shows ↓, and its first click goes to ↑; otherwise that
   click would leave the list as it was.
3. The draft's open question, answered: while a search is on, relevance
   order wins ([filters.js:160](../public/filters.js#L160)) and the
   toolbar's sort button still shows the chosen sort. The headers show no
   arrow and don't respond then, and the toolbar's button reads
   "Relevance". The prototype already did this.
4. The sort rule (picking the active entry again flips it, a new pick takes
   its natural direction) lives inside the toolbar's menu
   ([toolbar.js:594-598](../public/toolbar.js#L594-L598)). It moves to
   sort.js, and the menu and the headers both call it.
5. Assumed kinds.js already answers small pictures (`previewUrl`). The small
   picture is drawn three ways with three fallbacks (the lightbox's file
   list: the extension or "?"; the rows tile: the extension, the kind or
   "file"; the tag editor: nothing), and the card's badge is a fourth. Each
   kind's `small()` replaces `previewUrl`: a picture, cropped or shown
   whole, or the card's badge. List, the rows tile, the lightbox's file
   list and the tag editor all read it.
6. List would have been the third copy of the batch loading, about 40 lines
   each in grid.js and rows.js. One helper first (D7, amended).
7. The table look exists: `.cb-table` in modal.css (loaded on the board
   page, used by three modals) has the prototype's header style. List
   wears it, renamed `.data-table` since it stops being connector
   browse's, with `.cb-end` renamed `.num`. The card's controls are placed
   at the card's corners by global rules, so List scopes a few rules for
   them inside cells.
8. `pinWhileOpen` already took a selector (rows' tiles passed one). It now
   finds the nearest element that registered, so no caller names a class.
9. The folding header measures only its open height, on purpose, for its
   spacer ([header-scroll.js:39-42](../public/header-scroll.js#L39-L42)).
   The sticky column header needs the live height on every frame of the
   fold: a second value from the same observer, `--header-bottom`.
10. Small ones: connector browse's row click skips controls but not the end
    of a text selection, so List adds that check. "Sorted by …" copies the
    boards page's hidden polite note
    ([boards.html:21](../public/boards.html#L21)). Dates print through one
    `fmtDate` beside paged-table.js's formatters; four places printed them
    ad hoc.

### Stage 2a: List with the mouse

- batches.js, the helper (D7, amended). grid.js and rows.js move onto it
  first, with no change in what they do. The lightbox's close asks it to
  bring the item in, in whichever view is showing, then scroll to it.
- view.js: "list" as a saved view, `toggleView(v)` for either toggle, and
  D8 in `resolveView`: with List as the base, a filter session stays List.
- The toolbar (D10): the List toggle on every board, the Rows toggle as
  today, and the sort button reading "Relevance" while a search is on.
- sort.js: the one sort rule, and the sort the headers show.
- kinds.js: `small()` per kind and a `SmallFace` for List (finding 5).
- grid.js exports what the row reuses, no copies: `HeartControl`,
  `TagChip`, `CardActions`, the select button, the spinner's near-the-
  screen hook and the lane tail's "show the queue". `pinWhileOpen` finds
  the nearest registered element.
- list.js:
  - the table: select, face, name, Date added (plus Files on card-key
    boards), heart, actions;
  - header sort on name, Date added, Files and hearts, `aria-sort` on the
    shown sort's column, and "Sorted by …" said out loud;
  - rows keyed by item, redrawn value by value, the grid's way;
  - a row click passes through to the name, except on the row's controls
    or at the end of a text selection; in bulk mode it selects;
  - the upload lane as rows with no `data-id` (Ctrl+A skips them), its own
    budget, and the "+N processing…" tail;
  - loading, needs-tags and selected as row styles, with the prototype's
    flags beside the name.
- The sticky header at `--header-bottom` (finding 9).
- The table's CSS: `.data-table` plus a List section in styles.css
  (finding 7).
- app.js: the third view in the draw, and `list-mode` on `#grid`.
- Tests, each checked by removing its fix and watching it fail:
  - view.js three ways, and D8;
  - the helper: the next batch and drawing far enough, in all three views;
  - List: rows kept across a repaint; a heart redraws one row; the row
    click's pass-through; header and toolbar moving each other; Date added
    ↓ with no sort; a search turning the headers off; Ctrl+A; the lane's
    rows; the lightbox's close landing on its row;
  - small faces per kind, and the tile's and the lightbox list's legends;
  - `pinWhileOpen` finding a card, a tile and a List row;
  - in the browser: the flip guard across three views, the sticky header
    under the folding header, and "load more" in List.
- Real-app check: the harness boards in Chromium. Then the user checks the
  four real boards from the 2026-09-27 screenshots by eye (transcriber, ui,
  stocks test, emma).

**Stage 2a BUILT 2026-09-28 (uncommitted).**
- New: public/batches.js (the helper) and public/list.js (the view), and
  test/browser/list-view.test.js.
- Changed:
  - grid.js and rows.js now run on the helper. grid.js exports the row's
    parts, and `pinWhileOpen` finds the nearest registered element.
  - view.js, toolbar.js and sort.js as planned; kinds.js has `small()` and
    `SmallFace`.
  - The lightbox's file list, the rows tile and the tag editor read
    `small()`.
  - header-scroll.js publishes `--header-bottom`.
  - app.js draws the third view, and index.html has the hidden "Sorted by"
    note.
  - `.cb-table` and `.cb-end` are renamed `.data-table` and `.num`
    (modal.css, paged-table.js and the three modals); the List section is in
    styles.css.
  - Four places now print dates through `fmtDate`.
- Changed from the plan while building:
  - `fmtDate` lives in utils.js, not beside paged-table.js's formatters. It
    has five callers across pages, and fmtUsd moved to utils.js for the
    same reason.
  - `small()` returns how a picture fills the box: whole, from the top, or
    about the middle. The close look said "cropped or whole", but the card
    crops a page peek from its top; the screenshots showed it.
  - List's redraw check leaves out the items' version. The filtered list is
    rebuilt on every item write, so the list itself already stands for the
    items. Its removal check passed (nothing could pin it), so it went.
    The grid's and rows' checks carry the same unneeded entry: left for the
    second pass.
  - The row click has no "is this on a control?" test: every control in a
    row stops its own click, as on the card.
  - modal.css loads after styles.css, so List's rules that restate
    `.data-table`'s are written `.data-table.list-table`. The browser test
    found it: the column header's `top` came out 0.
  - The unsorted headers' arrows render nothing, where an empty text had been
    rewritten on every redraw. The redraw test found it.
  - A lane row's delete shows on hover, like the card's (the screenshots).
  - With one fallback, an audio file without a waveform reads ♪ in the rows
    tile and the lightbox's file list, where it read "MP3".
- Removal checks, 31, each failing with its fix removed and each file put
  back by hash:
  - the helper: the view check and the next batch in the observer, the
    view check in drawing far enough, and asking every view on close;
  - view.js: "list" as a view, as a saved view, D8, and `toggleView(v)`;
  - the toolbar: the List toggle, and "Relevance";
  - sort.js: Date added ↓ with no sort, no sort during a search, and the
    flip on a second pick;
  - kinds.js: the chart whole, the page from its top and the waveform whole,
    an upload's own picture, and the tile's badge;
  - grid.js: the pin finding a List row, Ctrl+A taking List rows, and bulk
    mode selecting;
  - list.js: the redraw check, each of its four inputs (the selection, the
    viewer, the facets, the card mode), the text-selection check, the lane
    rows' missing id, and the "Sorted by" note;
  - the browser: the live header edge, the selector strength, and the forced
    draw on a fresh key (the flip guard).
- Real-app check in Chromium through the harness, on a board with one item of
  every kind and drawn thumbnails (screenshots at the top, hovered, scrolled
  and in bulk mode):
  - photos are cropped, a chart and a waveform are whole, and a page peek is
    cropped from its top;
  - DOCX, ♪ and the ETH ticker wear the card's badges;
  - needs tags is dotted with a flag, and an item in work sits in the lane
    with a spinner;
  - Date added shows ↓ with no sort chosen, and only the hearted row's heart
    shows;
  - hovering brings the select circle, the tags chip, reprocess with its
    menu, delete and crate as the page's pills;
  - scrolled, the column header sits 6px under the folded page header on
    every frame of the fold;
  - bulk mode tints the chosen rows, shows every select circle and the bulk
    bar, and hides the hearts and actions, as on cards;
  - no page errors, and no sideways scroll at 1280px.
- Packaging: the board page still loads 4 files at boot, with one copy of
  batches.js.
- Suite: lint clean, and the full run passed 2161 of 2161 in 101s.
- Still owed:
  - the user's look at the four real boards;
  - phones are Stage 4's: measured at 390px, the table is 554px wide and
    the page scrolls sideways until then;
  - the four imports found unused while checking (app.js `reconcile`,
    tag-editor.js `ICONS`, ingest-modal.js `fmtDuration`,
    instance-rows.test.js `store`) were already unused at HEAD, and were left.

### Stage 2b: List from the keyboard

(Close-looked 2026-09-28. Go-ahead the same day: "yes, go ahead", with the
page made inert behind the lightbox.)

The draft, before the close look:
- The lightbox takes focus when it opens and keeps Tab inside it (the
  drawer's code, [modal.js:442-458](../public/modal.js#L442-L458), becomes
  a shared helper). Closing it puts focus on the name of the row it
  closed on.
- Focus on a name survives a repaint. One case couldn't be settled by
  reading: a repaint that moves the focused row (a sort by hearts, and
  someone hearts it). The test covers it.
- `scroll-padding-top`, so a focused row can't hide under both bars.
- Tests for each, and D1's keyboard reach written down as tests.

**Stage 2b close look (2026-09-28): what the draft assumed vs what the code
does.** Four scratch probes in Chromium on throwaway boards, plus the code.

1. The open case, settled. A repaint keeps focus on a row's name unless
   that row itself moves up the list: Preact then moves the row's element,
   and the browser takes focus off an element it moves (Preact 10.29.8 has
   no `moveBefore`). A row moving down, another row jumping over it, and a
   repaint that moves nothing all keep focus. `keepPlace`
   ([modal.js:308-334](../public/modal.js#L308-L334)) already puts focus
   back after a rebuild, by a `data-place` on each control, and modal.js
   already loads at boot.
2. Assumed the lightbox is never focused. Nearly: the audio and document
   views focus it ([detail-view.js:173](../public/detail-view.js#L173),
   [:205](../public/detail-view.js#L205)), but on open that runs before the
   lightbox is shown, so it misses. It lands only when you page onto audio
   or a document, and then closing drops focus to nothing.
3. Tab walks the page behind the lightbox: from the row you opened, on down
   the list under it.
4. Assumed the drawer's Tab trap could be shared. Not as it is:
   - it looks only for inputs and buttons, and Download is a link (the
     audio player and a document's frame take Tab too);
   - it treats `visibility: hidden` controls as reachable, and the lightbox
     hides its end arrows and its closed panel that way. Tab slips out past
     Details, and at the first item the wrap lands on the hidden Prev arrow,
     which can't take focus;
   - menus that open over the lightbox (Add to crate, Retag's facet
     picker) are mounted outside it, so a Tab in one would be pulled back
     into the lightbox with the menu left open.

   Instead (the user's pick): while the lightbox is open, the page behind
   it is `inert`, the browser's own "out of reach": no Tab stop, click or
   screen reader lands there. dropdown.js already uses it for a closing
   menu. What opens over the lightbox is added to the page afterwards and
   stays live, and so do the toasts, the top layer by design (toast.css).
   The drawer keeps its trap.
5. Closing the Details panel from the keyboard (its × or Escape) hides it
   with focus inside. The browser drops focus from a hidden control, and
   the next Tab leaves the lightbox.
6. The panel is rebuilt whole on every paint
   ([lightbox.js:481](../public/lightbox.js#L481)): twice per open (again
   when its fetch lands), and on switching or removing a file. Enter on a
   file in the Instances list destroys the button it pressed.
7. The lightbox's keys are caught page-wide, whatever has focus
   ([lightbox.js:1011-1025](../public/lightbox.js#L1011-L1025)):
   - on a focused audio player, → pages to the next item. The player takes
     ← and → itself (it seeks, 0.2s a press on a 20s clip) and ↑ and ↓ (the
     volume);
   - typing a new crate's name in Add to crate, ← pages back one item,
     closes the pop and loses the name. Mouse users hit this too.

   And paging with the Next button onto audio or a document, those views
   pull focus off Next onto the lightbox.
8. A screen reader reads the lightbox's heart as its count ("0, button")
   and Add to crate as "button"
   ([lightbox.js:87-98](../public/lightbox.js#L87-L98)): the icons are
   hidden from it and neither button has a name. And the lightbox doesn't
   say it's a dialog.
9. The select circle is `opacity: 0` until hover
   ([styles.css:1249-1279](../public/styles.css#L1249-L1279)), so every
   other Tab stop in List shows nothing. Cards have the same problem.
10. Shift+Tab up the list moved through four controls in a row under the
    folded page header or the column header, and the page never scrolled:
    the browser counts them as on screen. The offset has to be the header's
    open height, since scrolling up can unfold it.
11. Closing after paging, focus stays on the row you opened while the page
    scrolls to the one it ended on, so the next Tab carries on from the
    wrong row.
12. All of this is browser work: Tab, focus dropping from a moved or hidden
    element, and `inert` exist only in a browser (jsdom has no Tab).

Found outside 2b:
- The closed filter drawer only slides off-screen
  ([styles.css:2902-2921](../public/styles.css#L2902-L2921)), so its
  buttons, and its chips on a board with facets, are invisible Tab stops
  after the last row, in every view. Taken into 2b: one rule, hidden the
  way the lightbox's panel is.
- "Clear filters (0)" shows in the drawer with nothing to clear: the
  button's CSS `display` beats its `hidden`
  ([filters.js:693](../public/filters.js#L693)). Not keyboard work;
  recorded.
- Modals (`mountModal`) have no focus handling at all: nothing is focused
  on open, nothing keeps focus inside, nothing gives it back. The drawer's
  trap is the only one in the app. Its own ask.
- Unchanged, as decided at the Stage 2 close look: Edit tags, Find similar
  and the item-level reprocess steps stay mouse-only.

**Stage 2b, amended:**
- The lightbox:
  - a dialog, named by its item on every page (`role="dialog"`,
    `aria-modal`, the item's name as its label);
  - opening focuses the lightbox itself, and the page behind it is inert
    until it closes: every element on the page but the lightbox and the
    toasts;
  - closing puts focus on the open control of the item it closed on, where
    its view has one (List's name, marked `data-open`); `showItem` returns
    the element it scrolled to. Cards and tiles have none: a click opens
    them, a click focuses nothing, so there's nothing to give back;
  - closing the Details panel with focus inside it hands focus to the
    Details button;
  - the panel's paints go through `keepPlace`, with a `data-place` on each
    file's name and remove buttons and on Re-extract, Re-transcribe and
    Retag. `keepPlace` passes its arguments through to the render;
  - its paging and zoom keys stand back while a text field or a player has
    focus: shortcuts.js's "typing in a field", widened to players and
    exported;
  - the audio and document views stop taking focus when they mount. The
    document view takes it back from its frame only if the frame took it;
  - the heart and Add to crate are named with the card's words:
    "Favorite" (pressed or not) and "Add to crate".
- List:
  - its draw goes through `keepPlace`, with a `data-place` on each row's
    select button and name;
  - the select circle shows on keyboard focus, on cards too;
  - `scroll-padding-top` at the header's open height (header-scroll.js
    publishes `--header-open`, the value its spacer already holds), and a
    `scroll-margin-top` on List's row controls for the column header.
- The closed filter drawer leaves the Tab order.
- Tests, in the browser, each checked by removing its fix and watching it
  fail:
  - Enter on a name focuses the lightbox, named by the item, and Tab stays
    in it;
  - closing after paging focuses the row it closed on;
  - focus stays on a name whose row moves up;
  - the select circle shows on keyboard focus;
  - Shift+Tab up the list never leaves focus under the headers;
  - Tab past the last row doesn't land in the closed drawer;
  - the Details panel hands focus back on close, and keeps it on a file
    switched to;
  - the lightbox's keys stand back for a text field and a player;
  - paging with Next keeps focus on Next;
  - D1's keyboard reach as one Tab walk: a row, the lightbox, Details, and
    back to the row.
- `keepPlace` passing its arguments through: a unit test beside its others.
- Real-app check: the harness boards in Chromium; then the user, by eye.

**Stage 2b BUILT 2026-09-28 (uncommitted).**
- New: test/browser/list-keyboard.test.js, eleven tests.
- Changed:
  - lightbox.js: the lightbox is a dialog named by its item. Opening focuses
    it and makes the page behind it inert (`holdPage`), and closing puts focus
    on the open control of the item it closed on. Closing the Details panel
    with focus inside hands it to the Details button. The panel paints through
    `keepPlace`. The heart says whether it's on, and the paging and zoom keys
    stand back for a focused text field or player.
  - index.html: `role="dialog"` and `aria-modal` on the lightbox; "Favorite"
    and "Add to crate" name its two buttons.
  - detail-view.js: the audio and document views take no focus when they
    mount; the document view takes it back only from its own frame.
  - list.js draws through `keepPlace`: the name carries `data-open` and a
    `data-place`, and the select button a `place` (grid.js's `SelectButton`
    takes it).
  - batches.js: `showItem` returns the element it scrolled to.
  - modal.js: `keepPlace` passes its arguments through.
  - shortcuts.js: `typingInField` is `focusOwnsKeys`, exported, and counts a
    player too.
  - header-scroll.js publishes `--header-open`; styles.css has the page's
    `scroll-padding-top`, List's `scroll-margin-top`, the select circle on
    keyboard focus, and the closed filter drawer hidden.
  - Tests: keep-place.test.js gains one. In cards.test.js the row-click test
    replaces the selection before adding its range (below).
- Changed from the plan while building:
  - No fallback to "where focus was" on closing. Every mouse open starts from
    nothing focused (a click on a card, a tile or a row's cell focuses
    nothing), and the one keyboard open, List's name, is what the rule
    covers. Grid and rows already end where they began.
  - The toasts stay live under the inert page. They're the top layer
    (toast.css), and some carry actions (an upload's Cancel). The first test
    pins it.
  - Before writing the key rule, a probe with a real WAV: Chromium's audio
    player, when focused, seeks on ← and → (1% of the clip a press) and sets
    the volume on ↓.
  - Chromium scrolls a focused control only as far as it must, not to the
    middle of the screen. So the open header height matters in Chromium too:
    walking up two rows unfolds the header, and a control placed clear of the
    folded one ends up under the column header. The Shift+Tab test walks far
    enough to show it (K17 below).
  - jsdom's `focus()` leaves a caret in the selection, and `addRange` then
    ignores a second range, so the row-click test's text selection came out
    empty once closing the lightbox focused a row. A drag replaces the
    selection, so the test does too. Browsers don't do this; the fix is the
    test's.
  - A file-less instance comes back as kind "connector" (db.js
    `instanceEntry`) and opens as a document frame, which put a frame in the
    lightbox's Tab walk. The tests seed real files.
  - The redraw test uses a real trigger: another member's heart, which the
    page picks up within seconds. A test that imported the page's modules
    would break the built-frontend run (FRONTEND_DIR).
- Removal checks, 32, each failing with its fix removed and each file put
  back byte for byte by hash. Two full runs showed tests weaker than meant;
  after the fixes, the checks they touched ran again:
  - Shift+Tab with the page header folded started from "the first name clear
    of the column header". On this board the row above it sat clear too, so
    taking out the page's padding failed only the open-header half. Both
    halves now set a name 30px under the column header and check, as setup,
    that the row above starts hidden; the folded half walks up two rows.
  - Two tests found a control by the attribute a check removes (the remove
    button's and Retag's `data-place`) or waited on a menu the check closed,
    and so failed on a setup line or a 30s wait. They now find controls by
    class or text and read without waiting. Every assertion is labelled, so
    each check fails on its own line:
  - the lightbox: its focus on opening (K1), the inert page (K2), the toasts
    left live (K3), the dialog's name (K4) and role (K5);
  - closing onto the row: the focus call (K6), `showItem` returning the
    element (K7), `data-open` (K8);
  - a redraw: List's `keepPlace` (K9), the name's place (K10), the select
    button's place in list.js (K11) and in grid.js (K12);
  - the select circle on keyboard focus (K13);
  - Shift+Tab: the page's padding (K14), `--header-open` (K15), List's own
    margin (K16), and the open height against the live one (K17: the control
    at 124px, the unfolded column header down to 166px);
  - the closed drawer's `visibility` (K18);
  - the Details panel: focus back to its button (K19), its `keepPlace` (K20),
    the places on a file's name (K21), its remove button (K22) and Retag
    (K23), and `keepPlace` passing its arguments (K24, the unit test);
  - the keys: the lightbox's stand-back (K25), and a player counting (K26);
  - paging with Next: the audio view's focus (K27), the document view's on
    mount (K28) and on its frame's load (K29);
  - the walk: "Favorite" (K30), "Add to crate" (K31), and the heart's
    `aria-pressed` (K32).
- Real-app check in Chromium through the harness, on a board of 41 pictures
  with drawn faces and a two-file entity (screenshots):
  - Tab onto a row: the browser's ring on the name; one more Tab and the
    select circle shows, ringed;
  - Enter: the lightbox opens with the focus on itself and no ring; Tab goes
    Previous, Next, Add to crate, Favorite, the ring visible on the dark
    pills;
  - Details from the keyboard, Tab to Retag, ringed;
  - three items on, Escape twice: the ring on the name of the row it closed
    on, mid-screen;
  - scrolled, Shift+Tab: the focused name 7px under the column header, the
    page header unfolded;
  - no page errors.
- Packaging: the board page still loads 4 files at boot. shortcuts.js now
  shares a boot chunk with face-select.js, since the lazy lightbox imports it
  too; modal.js was already at boot.
- Suite: lint clean. The full run passed 2172 of 2173, twice (106s the
  second time).
  - The one failure, both times, is welcome.test.js:291, the race Stage 1's
    second pass recorded. It checks, the moment the boards page has loaded,
    that its "Checking access…" gate is gone. boards.js hides the gate only
    once its own `/api/me` answers, and under the full suite's load that can
    still be in flight.
  - It passed on its own, and twice side by side with the new keyboard tests.
  - The boards page runs none of 2b's code before its gate hides: it gets
    styles.css and modal.js, and neither change touches the gate.
  - Not fixed: outside this stage. The fix would be to wait for the gate to
    hide rather than check it at one instant.
- Still owed:
  - the user's look at the four real boards, now with the keyboard too;
  - phones are Stage 4's;
  - recorded, not built: "Clear filters (0)" in the drawer; modals' focus
    handling; a link in a field's value in the Details panel has no place, so
    the panel's second paint drops focus from it; after a file is removed its
    button is gone, and focus with it; the lane's "+N processing…" is
    mouse-only in List, as on cards.

### Stage 3: the board's columns

(Close-looked 2026-09-28. Go-ahead the same day: "yes, go ahead", with the
select, picture and name pinned at the left when the columns don't fit.)

The draft, before the close look:
- The column catalog from `sortCatalog()`. That function only fetches
  `/api/file-fields` and `/api/connectors` the first time the sort menu
  opens, so List has to ask for it on its first draw.
- D4's formatter and descriptor formats, and the lightbox moving onto them.
- The Columns menu (the app's dropdown with check rows), `boardColumns:`, and
  the load-time check (D6). On a mixed board, the menu labels sections that
  only apply to one kind with how many items they cover, as the sort menu
  does.
- Layout:
  - numbers right-aligned (paged-table.js's `ALIGN_END`);
  - "—" for empty;
  - the name column takes the leftover width and cuts off with "…";
  - `table-layout: fixed`, so later batches can't shift the columns.
- Every column sorts from its header.
- Real-app check: stocks and transcriber.

**Stage 3 close look (2026-09-28): what the draft assumed vs what the code
does.** Two scratch probes in Chromium, on throwaway boards shaped like the
stocks and crypto templates, plus the code.

1. D4 suspected the lightbox prints an AI-extracted year as "$2,024.00". It
   doesn't. The extract step stores an answer as `{ v, why }`, with no kind
   ([worker.js:2705](../server/worker.js#L2705)), and the lightbox formats
   only a value whose kind is `number`: "2024", measured.
2. The dollars land on connector fields, whose stored kind is `number` and
   whose unit the lightbox guesses from the key
   ([lightbox.js:19-56](../public/lightbox.js#L19-L56)). Measured on the
   built-in templates' fields:
   - stocks: Volume, a share count, "$12.35M"; P/E "$24.87"; Dividend yield
     "$3.12", and "0.44" with no % below 1;
   - crypto: rank "$1.00"; circulating supply "$19,712,345.00".

   PLUGIN.md documents the guess as a limit for plugin domains ("temp: 21.5
   reads "$21.50""). D4's minimal route would put these in whole columns.
3. The words exist: the browse table's column kinds, `usd` and `percent` (a
   change), with `number` the plain case (PLUGIN.md). A manifest field has no
   slot for one ("Units go in the label: nothing else carries one"), but the
   server sends the manifest's fields as written
   ([connectors/index.js:136](../server/connectors/index.js#L136)) and the
   plugin loader checks only a field's key, kind and fn
   ([plugin-loader.js:171-176](../server/plugin-loader.js#L171-L176)).
4. Three places print these values, each its own way: connector browse
   ([connector-browse.js:106-112](../public/connector-browse.js#L106-L112)),
   the ingest preview
   ([ingest-modal.js:1172-1177](../public/ingest-modal.js#L1172-L1177)) and
   the lightbox. List would have been a fourth.
5. A file's dates are day-only ("2026-09-28", server/media/universal.js).
   `fmtDate` reads one as midnight UTC, so west of UTC it prints the day
   before: 9/27/2026 in California, measured. The lightbox prints the raw
   string, so nobody sees it yet; List's Modified and Created would.
6. D5 assumed the mapping had chosen a connector board's fields. The
   templates bind the whole catalog (PLUGIN.md says so): ten sortable fields
   on stocks and on crypto. At realistic widths that's a table about 1,940px
   wide. At a 1280px window List gets 1,232, and its fixed columns take 552.
   The domain already names its headline numbers: the browse columns marked
   `preview` (price, market cap, volume on both).
7. D6 assumed the load-time check could use the catalog. The sort menu's
   sections list only the file kinds among the items loaded so far
   ([sort.js:64-69](../public/sort.js#L64-L69)), and a board loads its
   newest 200 items first ([app.js:152](../public/app.js#L152)) and the rest
   after. A saved Pages column on a board whose PDFs are older would be
   dropped at load. The check goes by card mode, as `validSort`'s does.
8. List needs each shown column's name and format before it draws, and they
   come from the two catalogs, fetched when the sort menu first opens (and
   `/api/connectors` at load on a connector board with no saved sort).
9. Columns that don't fit, measured with ten stock columns at 1280px: the
   page scrolls sideways and the column header stays stuck, but scrolled
   right the rows lose their names. With the select, picture and name pinned
   at the left (`position: sticky; left`), they stay, and the header still
   sticks. The prototype's own scroll box unsticks the header. At a 1024px
   window even the stocks defaults overflow.
10. Built in 2a already: `table-layout: fixed`, the name cut with "…", "—"
    for empty and right-aligned numbers. Long labels wrap to two lines in the
    38px header by themselves ("Market cap (USD)", measured).
11. A row redraws when one of its props changes (grid.js `sameProps`). A
    value that isn't a prop can't redraw it, so a live price refresh would
    never reach its row.
12. The Columns menu's parts exist: `openDropdown` with `ddHead` and
    `ddCheckRow` (dropdown.js), and the sort menu's "Audio · 3" heads
    (`sortCatalog`).

Found outside 3:
- The lightbox lists a card's fields in the database's key order, shortest
  name first (price, sector, volume, website…), not the mapping's: Postgres
  keeps a JSON object's keys that way. Taken into 3: the lightbox's fields
  are looked up in the mapping for their formats anyway.

**Stage 3, amended:**
- Formats (D4):
  - a connector manifest field takes an optional `format`, `usd` or
    `percent`; none, or a word the page doesn't know, prints a plain number.
    Stocks and crypto declare theirs, and PLUGIN.md's field tables gain the
    column;
  - a file field declares its own in server/media (`bytes`, `clock`,
    `kbps`, `khz`, `channels`, `megapixels`: what the lightbox prints
    today), and `mediaCatalog()` passes it on;
  - `fmtField` in utils.js prints a value by its kind and format, "—" for
    nothing. A number whose kind isn't `number` (an AI answer) prints as it
    is. `fmtNumber` and `fmtPercent` move there from paged-table.js, and the
    clock printer from detail-view.js;
  - connector browse, the ingest preview, the lightbox and List all print
    through it. The lightbox's key-guessing goes, and its fields follow the
    mapping's order;
  - `fmtDate` reads a day-only value as that day;
  - the change colors (`.cb-up`, `.cb-down`: connector browse's, shared
    with the lightbox's chart) become `.change-up`, `.change-down`, and
    List's percent cells wear them.
- The catalog (sort.js): each entry carries its format, and one lookup
  takes a column's key to its entry. A board loads the catalog its fields
  come from (`/api/connectors` on a connector board, `/api/file-fields` on
  the rest), and the page redraws when it lands.
- Columns (D5, D6):
  - defaults: Date added; the bound fields the domain previews, on a
    connector board; Files, on a card-key board;
  - `boardColumns:<boardId>`, per viewer per board, in catalog order. A key
    the board's card mode can't show, or the catalog doesn't have, is left
    out at load, and the stored list is left alone;
  - the Columns menu: a button in the actions column's header; the catalog's
    sections as check rows, a shown column's section kept even before an
    item of its kind has loaded; "Reset to the board's defaults".
- The table:
  - every data column sorts from its header;
  - widths by kind, from one table in list.js; the name takes the rest, down
    to 240px, and past that the page scrolls sideways;
  - the select, picture and name pinned at the left, the header still stuck;
  - each shown value a prop of its row.
- Tests, each checked by removing its fix and watching it fail:
  - unit: `fmtField` and `fmtDate`; the catalog's formats; the defaults;
    the load-time check by card mode; PLUGIN.md's field tables against the
    manifests (plugin-doc.test.js);
  - browser: a stocks-shaped board's default columns and how they print; the
    Columns menu, saved, restored and reset; a sort from a data column's
    header; a live value reaching its row; too many columns, with the page
    scrolled sideways, the names pinned and the header stuck; the name's
    floor; a day-only date west of UTC; the Details panel's connector fields
    on stocks and crypto, in the mapping's order, and an AI number as it is.
- Real-app check: harness boards shaped like stocks, crypto and transcriber
  in Chromium; then the user's four boards by eye.

**Stage 3 BUILT 2026-09-28 (uncommitted).**
- New: public/columns.js (the viewer's columns and the Columns menu),
  test/list-columns.test.js (14) and test/browser/list-columns.test.js (9).
- Changed:
  - server: the stocks and crypto manifests declare `format` on their dollar
    and change fields; the file-field descriptors declare theirs, and
    `mediaCatalog()` passes it on.
  - utils.js: `fmtField`, the one printer; `fmtNumber` and `fmtPercent` moved
    in from paged-table.js and `fmtClock` from detail-view.js; `changeClass`;
    `fmtDate` reads a day-only value as that day; `fmtUsd` shows the cents
    from a dollar up; the Columns glyph.
  - connector-browse.js and ingest-modal.js print through `fmtField`, and
    detail-chart.js takes its percent and color from utils.js. `.cb-up` and
    `.cb-down` are `.change-up` and `.change-down` (modal.css).
  - sort.js: entries carry their format; `loadCatalogs` (the board's
    catalog), `columnCatalog`, `fieldFormat`, and `sortCatalog`'s `keep`.
  - state.js holds `columns`. app.js restores them and loads the board's
    catalog at boot. toolbar.js shows the Columns button while List shows.
  - list.js: the data columns from `shownColumns()`; the widths in one table
    (a `<colgroup>`), with the name's 240px floor as the table's `min-width`;
    the pinned cells' offsets; each value a row prop; keyed cells.
  - styles.css: the widths out; number and text cells; the pinning, the cells
    opaque with the row's tint on them; the edge while scrolled.
  - lightbox.js: the key-guessing printer is gone. Fields print through
    `fmtField` with `fieldFormat`, in the mapping's order, and the panel's
    second paint waits for the catalog.
  - PLUGIN.md: `format` on a domain's fields, a format column in the pinned
    field tables (plugin-doc.test.js checks it), and the dollar caveat gone.
- Changed from the plan while building:
  - The Columns button sits in the toolbar, between the view toggles and the
    sort, while List shows; not in the table's actions header. The actions
    column isn't pinned, so on a table wider than the window it scrolls away
    with the page: at a 1024px window the button would have started
    off-screen.
  - `fmtUsd` shows the cents from a dollar up ("$62.40"), so prices line up
    at the point down a column. Connector browse had printed "$62.4" and the
    lightbox "$62.40". It reaches the token chip, the admin usage figures and
    the price list too: a whole-dollar amount there reads "$20.00" now.
  - Scrolled sideways, the pinned name draws a hairline edge, so the first
    column sliding under it reads as passing beneath, not cut off. A CSS
    scroll-driven animation on the page's own sideways scroll: nothing at
    rest, and nothing in a browser without them.
  - The pinned cells are opaque, so a row's tint moved from the row to its
    cells; selected still shows over hovered.
  - Finding 11 was wrong. Every poll merge writes a changed item over with
    fresh arrays (data.js reconcile, `Object.assign(ex, toItem(d), …)`), and
    the tags array is already a row prop, so a row redraws whenever its item
    comes in a poll. The values are props anyway, the card's rule (grid.js
    `cardProps`: a card draws from its props alone), and nothing can pin them
    today (C22 below).
  - What else the lightbox prints differently, besides the misprints: a price
    under a cent keeps its digits ("$0.000009"; the key-guess printed it as
    "$0.00"); a byte size is `fmtSize`'s ("21.0 MB", was
    "21 MB"); a file's date field is a date ("9/14/2026", was "2026-09-14"); a
    connector date field is a date (it printed epoch milliseconds); a clip's
    length counts whole seconds as the player does ("36:51" for 2211.6s, was
    rounded to "36:52").
  - Connector browse: an empty text value reads "—" (it was blank).
  - A dividend yield has no format: `percent` is a change (PLUGIN.md), so it
    reads "3.12" under "Dividend yield (%)".
  - A not-a-number guard in `fmtField` was dropped before the checks: every
    printer it hands a number to guards already, and values arrive as JSON.
  - Until the board's catalog lands (one small local request at boot), List
    shows only the board's own columns; the rest appear when it does.
- Removal checks, 41, each file put back byte for byte by hash, and the git
  status the same before and after. 39 fail with their fix removed:
  - formats: the stocks price's (C1), crypto's volume's (C2), the formatter's
    lookup (C3), numbers formatted only when their kind says so (C4, and C4b
    in the lightbox), the lookup's own-key guard (C5), the cents (C6), the
    day-only date (C7, and C7b in List), "—" for an empty string (C8), the
    audio duration's (C10), `mediaCatalog()` passing formats on (C11), and
    PLUGIN.md's table against the manifest (C41);
  - the catalog: the domain's previewed fields as defaults (C12), Files as a
    card-key default (C13), file columns whatever kinds have loaded (C14), the
    name and hearts left out (C15), the same array while nothing changes (C16a
    in sort.js, C16b in columns.js), the menu keeping a shown column's section
    (C21), and the board's catalog loaded at boot (C36);
  - the pick: catalog order (C17), a stored pick that isn't a list (C18), the
    menu saving in catalog order (C19) and resetting (C20), the draw's stamp
    carrying the columns (C23), and the button only in List (C24);
  - the table: the pinning (C25), its offsets (C26), opaque cells (C27), the
    pinned header over the sliding one (C28), the edge (C29), the name's
    floor (C30), the hover tint on cells (C31) and selected over it (C32), a
    change's color (C38) and List's use of it (C39);
  - the lightbox: the format looked up (C33) and the mapping's order (C34).
- Two pass with their fix removed:
  - C22, the values as row props: see finding 11 above. The live-value test
    had nudged the page with a heart on the same row, which redraws the row by
    itself; it nudges with a heart on another row now, and still passes
    either way.
  - C37, the lightbox's own wait for the catalog: the board's boot load
    already has it there. Expected; it covers a panel opened before the boot
    load lands.
- Not pinned by a test: connector browse and the ingest preview printing
  through `fmtField` (no test drives either table; both need a connector
  provider), and the cells' keys (nothing a reader sees).
- Real-app check in Chromium through the harness, on boards shaped like
  stocks (seven tickers, an ETF with no market cap), crypto (a coin under a
  cent) and an audio board (screenshots):
  - stocks: Date added, Price, Market cap ↓ and Volume by default, "$62.40",
    "$978.10B", "—" for the ETF's market cap, share counts plain;
  - the Columns menu: Board and Stocks, the defaults checked;
  - every column on: changes in green and red, industries cut with "…";
    scrolled sideways, the names pinned with their edge;
  - at a 1024px window the defaults overflow and the page scrolls sideways,
    the Columns button in view;
  - the lightbox on Coca-Cola: its fields in the template's order, a P/E, a
    yield and a share count plain;
  - crypto: "$64,123.45", "$0.000009", "$31.20B";
  - audio: "581 KB", the files' dates, "1:14", "320 kbps", "44.1 kHz", mono;
  - no page errors.
- Packaging: the board page still loads 4 files at boot. columns.js rides in
  the entry with list.js; paged-table.js stays in the lazy modals chunk.
- Suite: lint clean. Full runs: 2194 of 2196 (131s), then 2195 of 2196
  (143s).
  - Both runs: welcome.test.js:291, the known race (Stages 1 and 2b).
  - The first run only: ui-updates.test.js:615, a toolbar menu's caret
    measured mid-turn (it waits 250ms for a 0.12s turn) on a grid board this
    stage doesn't draw. No leftover processes were running; the file passed
    21/21 alone twice, and the second full run passed it.
- Found in the user's look (their stocks board): a number column's header
  didn't sit over its values. Two causes, both in the header's sort button:
  - a button centres its own text, so a label that wraps ("Daily change (%)",
    "Market cap (USD)") sat centred over its column. `.list-sort` takes its
    cell's alignment now (`text-align: inherit`);
  - the arrow's slot was drawn empty on every unsorted header, and the flex
    gap before it held every unsorted label 4px short of the column's edge
    (since Stage 1, on the Files column; Stage 3's labels showed it). The
    arrow is drawn only on the sorted column now. The heart column's icon
    sits dead centre for the same reason.
  - Test: a new browser test measures each line of every number column's
    label against the values' right edge: unsorted, flush; sorted, the arrow
    flush and the label's lines ending together before it; a wrapped label
    both ways. The old check read only the cells' `text-align`.
  - Removal checks, 2, each file put back byte for byte by hash: without
    `text-align: inherit`, the wrapped label's lines end 11px and 45px short;
    with the empty arrow back, "Price (USD)" ends 4px short.
  - Real-app check: the user's screen rebuilt in Chromium (Date added, Date
    updated, Price, Daily change, Market cap, Volume ↓; then Market cap ↓),
    screenshots, no page errors.
- Still owed:
  - the rest of the user's look at the real boards;
  - phones are Stage 4's;
  - recorded, not built: connector browse leaves a date column blank
    (PLUGIN.md says so; `fmtField` would print it);
  - asked, and the user said it's fine: under a dollar, `fmtUsd` drops
    trailing zeros, so a 20-cent price reads "$0.2" in a column of "$2.01"
    and "$0.1653".

### Stage 4: phones and keeping your place

(Close-looked 2026-09-28. Go-ahead the same day: "go ahead", with Shift-click
range select in all three views.)

The draft, before the close look:
- At ≤640px: face, name and the sorted column's value. No sideways scroll (a
  scrolling wrapper would also break the sticky header).
- Switching views keeps your place: the first visible item, or the focused
  one, is scrolled into view in the new view (Stage 1 gave every view
  scroll-to). Today a switch draws the other view's first batch and leaves
  you wherever the page lands.
- D12's measurement on `ui`.
- Shift-click range select, in both views: the user's call. Lists invite it
  (Finder, Gmail, Drive). The grid doesn't have it, so both or neither.

**Stage 4 close look (2026-09-28): what the draft assumed vs what the code
does.** Five scratch probes in Chromium through the harness: its phone and
tablet mode (a touch screen with a phone's viewport) and a 1280px window, on
throwaway boards shaped like stocks, an audio board and a board of 150 photos.

1. The draft assumed a phone scrolls a too-wide table sideways. A phone
   browser widens the page to fit it instead. At 390px the stocks table made
   the page 1,206px wide, and the header card, fixed to the page, widened
   with it: the List toggle (the way back to the grid), Columns and the sort
   sat at 904-1,179px, off the screen. A sideways swipe slides the whole page
   rather than scrolling it (the page's own sideways scroll stays at 0), so
   Stage 3's pinned names slide away too: after two swipes the screen showed
   numbers only. Stage 2a measured a narrow desktop window, where the page
   does scroll.
2. Not only phones: a touch tablet does the same whenever the table is wider
   than it. A stocks board at 744px and at 820px widened the page to 1,206px,
   the sort off the screen; an audio board at 744px to 816px. A "≤640px" rule
   misses them.
3. The select circle, the heart (on a row nobody has hearted) and the actions
   show only under a pointer (styles.css), so on a touch screen they're
   invisible and still take a tap. The prototype's phone row kept the heart.
4. Today a switch from List to the grid lands at the top of the grid: the
   grid places its cards a frame after drawing them, and for that frame the
   page is too short to hold the scroll. From the grid to List it lands on
   whatever row the old scroll falls on (the grid at photo 64, List at 100).
5. "Stage 1 gave every view scroll-to": the lightbox's scroll-back
   (batches.js `showItem`) draws only up to the item, then centers it. To go
   back near the top of the screen, an item at the end of what's drawn has
   nothing below it, and the page can't scroll that far: simulated, the item
   landed 609px low in List and 190px low in the grid. The new view has to
   draw past it, and the grid has to place its cards before the scroll.
6. The folding header takes the switch's jump for the reader scrolling
   (header-scroll.js): after a jump up it unfolded (measured), over the row
   just put back.
7. "Or the focused one": at the switch the focus is on the toolbar's toggle
   (no key switches views), so it's never an item.
8. D12's measurement: a row loads the same thumbnail file the card does
   (kinds.js `thumbUrl`, lazily), and speed isn't the goal (the user's rule
   since the ui-updates arc). Dropped (D12, amended).
9. Shift-click: nothing selects a range today; no handler reads Shift. The
   select circle and the bulk-mode click are shared by the grid's cards, the
   rows view's cards and List's rows (grid.js `SelectButton`,
   `openOrSelect`), and a rows view tile selects its card the same way, so
   one change covers the three views. A Shift+click on a List row extends a
   text selection, and the row ignores a click that ends one (Stage 2a), so
   the row has to stop that.

Found outside 4 (recorded, not built):
- On a phone the header's top row cuts the account button off at its right
  edge, in the grid too.

**Stage 4, amended:**
- The compact table (list.js): at ≤640px, and on a touch screen
  (`hover: none`) whenever the full table is wider than the room it has.
  Redrawn when that changes: a rotation, a resize, a column added.
  - A row: the picture (64 by 40), the name, and under it the sorted
    column's value, "Price (USD) · $62.40", a change in its color; sorted by
    name or while searching, Date added.
  - No select, data, heart or actions columns (finding 3; the lightbox has
    them). The lane's rows and the "+N processing…" tail follow. Rows stay
    58px (D11).
  - The table is never wider than the screen, and the toolbar has no
    Columns button.
  - A desktop window too narrow for the full table keeps Stage 3's sideways
    scroll with the names pinned: a desktop page does scroll.
- Keeping your place (batches.js), on a switch from the toolbar's toggles:
  - before it, the first item in sight under the header (and List's column
    header), top-most then left-most;
  - after the other view draws: that item drawn in with a batch past it, the
    grid laid out, and the page scrolled so the item sits at the height it
    had, never under List's column header; the list's first item goes back
    to the top;
  - header-scroll.js is told the jump isn't the reader's, so the header
    stays folded or open as it was;
  - only a switch from the toolbar: a filter's auto flip to rows isn't a
    place to keep.
- Shift-click (bulk.js): every item drawn between the last one picked and
  this one, in the page's order, joins the selection; what's drawn, Ctrl+A's
  rule (D7). On the select circle, and on a card, a List row or a rows tile
  in bulk mode. List stops a Shift+click extending a text selection there.
- D12: no measurement.
- Tests, each checked by removing its fix and watching it fail:
  - browser, phone and tablet contexts: the page no wider than the screen,
    the toolbar's toggle and sort on it and no Columns button; the compact
    row and its second line by the sort; a tablet whose table fits keeps it;
    a desktop window crossing 640px redraws;
  - browser: grid to List, List to grid and rows to List put the first item
    in sight back at its height, the header still folded; from the top, the
    new view starts at the top;
  - Shift-click: unit tests of the range in each view (no anchor, an anchor
    no longer drawn), and a browser test on List (no text selected).
- Real-app check: phone and tablet screenshots in Chromium; then the user,
  by eye.

**Stage 4 BUILT 2026-09-28 (uncommitted).**
- New: test/browser/list-phone.test.js (4), test/browser/view-switch.test.js
  (5) and test/browser/range-select.test.js (2); test/cards.test.js gains 3.
- Changed:
  - list.js: `compactList()`, true at ≤640px, or on a touch screen
    (`hover: none`) when the full table's floor (`fullWidth`, which the
    table's min-width shares) is wider than the room inside the page's
    margins (grid.js `gridBox`, exported). A signal the draw reads is bumped
    on a resize or a change of hover when the answer flips, and whenever the
    640px query does (`narrowScreen`, for the toolbar).
    The compact table: the picture's column 84px (the picture 64 by 40), the
    name and its second line (`subEntry`, `subLine`), no select, data, heart
    or actions columns, the lane's rows and tail to match, and no min-width.
    A row's click hands its event on, and a Shift+press in bulk mode doesn't
    select text.
  - batches.js: `switchView` (the first item in sight, `inSight`, under
    `coveredTop`); `reveal(item, more)` draws a batch past the item when asked
    and lays the view out even when it draws nothing more.
  - header-scroll.js (CRLF kept): `pageJumped()` moves the header's baseline
    to where the page landed.
  - toolbar.js: the toggles call `switchView`; no Columns button at a
    phone's width.
  - bulk.js (CRLF kept): the last plain pick is where a range starts
    (`anchor`), `selectRange`, and a cleared selection has none.
  - grid.js: `pickItem` (a Shift-click picks a range), `holdTextInBulk`; the
    select button and `openOrSelect` pick through it, and a card holds the
    text on a Shift+press in bulk mode. rows.js: a tile likewise.
  - styles.css: the compact picture and the second line.
  - test/browser/harness.js: `open()` takes a device (a phone's or a
    tablet's screen).
- Changed from the plan while building:
  - A touch tablet measures the room inside the page's margins, not up to
    the screen's edge. The close look's audio board "fitting" an 820px
    tablet was a 792px table running 20px into a 772px room's right margin;
    it's compact there now, and full when the tablet is turned sideways.
  - The Columns button leaves only at a phone's width, not with every
    compact table. On a tablet, a column added that no longer fit would have
    hidden the one button that takes it off again. A phone turned sideways
    stays compact and gains the button, so the 640px query has its own
    listener: crossing it redraws the toolbar when the table doesn't change.
    The one on hover stays too (a mouse plugged into a tablet resizes
    nothing); no test can change hover mid-page, so it isn't pinned.
  - A Shift-click doesn't move where a range starts. The ranges only add,
    so moving it changed nothing a test could see.
  - The select button has no text guard of its own: in bulk mode its press
    reaches its row's or card's, and a button's press doesn't stretch a
    selection (its removal check, below, passed).
  - `pageJumped` only moves the baseline: resetting the header's run as well
    changed nothing measurable.
  - The first item in sight goes back to the top when it's the list's first
    item: from the top of a page, the other view starts at its top.
  - `reveal` now lays the grid out once more when the lightbox closes on a
    card already drawn: the same positions.
- Removal checks, 31, each file put back byte for byte by hash, the git
  status the same before and after. 30 fail with their fix removed:
  - the compact table: the 640px rule (P1), the touch rule (P2), the fit
    (P3), no columns (P4), no Columns button on a phone (P5), the button
    back when the phone is turned (P14) and kept on a tablet (P15), the
    redraw on a resize (P6, through the tablet's turn), no select or heart
    (P7), no actions (P8), no min-width (P9), the second line (P10), Date
    added for the name's sort (P11), a change's color (P12), the smaller
    picture (P13);
  - keeping your place: the toggles through `switchView` (K1, the item
    landed at 1,087px), a batch past the item (K2, 681px), the grid laid out
    when nothing more is drawn (K3), never under the column header (K4), the
    first item to the top (K5), the header left alone (K6: it unfolded, the
    page covered to 166px), List's column header in what covers the page
    (K7);
  - Shift-click: a range (S1), from the last pick (S2), none after a clear
    (S3), a tile (S4), a card or a row in bulk mode (S5), no text on a List
    row (S6) or a card (S9), an older selection cleared (S8).
  - P6 passed at first: without the resize listener the page redrew anyway,
    at its next refresh, inside the test's 30s wait. The redraw must come
    within a second now, and P6 fails.
  - S7, the select button's own text guard, passed: redundant (above), and
    removed.
- Not pinned: the listener on hover; a rows tile's text guard (a tile is a
  picture).
- Real-app check in Chromium through the harness (screenshots): a 390px
  phone, stocks, photos (with seven items in work: five lane rows and "+2
  processing…") and sorted by name; an 820px tablet, stocks; a 1280px desktop
  window, unchanged; both switch directions landing on the item with the
  header folded. No page errors.
- Packaging: the board page still loads 4 files at boot.
- Suite: lint clean. The full run passed 2211 of 2211 (122s); after the
  Columns button's change, 2210 of 2211, the one failure welcome.test.js's
  known race (Stages 1, 2b and 3).
- Still owed:
  - the user's look on a real phone and tablet: Chromium's phone mode stands
    in for Chrome on Android, and Safari on an iPhone or iPad wasn't run;
  - the rest of the user's look at the real boards;
  - Stage 5, the second pass.

### Stage 5: second pass

Fresh eyes on the whole diff, then simplify.

## Gains, plainly

- A sort you can follow, whole titles, numbers in columns.
- The first gallery view that works from the keyboard.
- The "is it rows?" checks go away (Stage 1), whatever happens to List.
- Field values print one way everywhere (D4), and the lightbox stops guessing
  from key names.

## Risks and edges

- **Rows and List mean nearly the same thing.** The names and icons have to
  say which is which (D10).
- **Hover-only actions on touch.** Rows inherit the card's limit: on a phone
  a tap opens the lightbox, which has the actions. Not new, and not fixed
  here; the open question about hover on touch stays open.
- **The folding header** moves the sticky header's offset during its 0.28s
  fold. Checked in Stage 2.
- **A search in progress** orders by relevance, not by the sort (Stage 2's
  open question).
- **Card-key boards** show only columns about the card as a whole, not per
  file (D3).
- **Mixed boards:** a column for one kind shows "—" on the others.
- **Find-in-page** only sees rows already drawn, as in the grid today.

## Sources (research, 2026-09-27)

- NN/g, cards vs lists: https://www.nngroup.com/articles/cards-component/
- NN/g, data tables: https://www.nngroup.com/articles/data-tables/
- NN/g, mobile tables: https://www.nngroup.com/articles/mobile-tables/
- Baymard, list vs grid: https://baymard.com/blog/product-listing-page-plp-ux
- Sarah Higley, grids vs tables: https://sarahmhigley.com/writing/grids-part1/
- Adrian Roselli, no grid for a clickable row:
  https://adrianroselli.com/2023/11/dont-turn-a-table-into-an-aria-grid-just-for-a-clickable-row.html
- Adrian Roselli, sortable columns:
  https://adrianroselli.com/2021/04/sortable-table-columns.html
- Adrian Roselli, check-all in a table:
  https://adrianroselli.com/2025/07/check-uncheck-all-in-a-table.html
- ARIA APG, table pattern: https://www.w3.org/WAI/ARIA/apg/patterns/table/
- Heydon Pickering, clickable cards: https://inclusive-components.design/cards/
- WebKit, Safari 27 (`position: relative` on table rows):
  https://webkit.org/blog/18325/webkit-features-for-safari-27-0/
- CSS containment level 2: https://www.w3.org/TR/css-contain-2/
- Hanselman, Windows guessing folder views:
  https://www.hanselman.com/blog/wrong-file-types-view-in-vista-explorer-folders
- Figma, list view removed and restored:
  https://forum.figma.com/share-your-feedback-26/bring-back-list-view-for-your-files-38938
