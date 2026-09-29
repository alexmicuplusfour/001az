# Toolbar fold: the top row fits any width (2026-09-29)

**Status: deep dive and prototype 2026-09-29; built and pushed 2026-09-29.
Full suite green (2,225).**

Self-contained for a fresh session. The deep dive's prototype ran outside the
repo (CSS and a fit function injected into the real page, on a throwaway copy
of the "stocks test" board through test/browser/harness.js).

## The ask

"currently the toolbar in the mobile view is f'd. i'm thinking the way we
should fix it is we have the layout adapt dynamically - no resolution
threshold - unless you think that's not kosher." The order the user gave:
the token usage collapses into a coin button that shows the usage on hover or
tap; then the entity mapping template chip goes; then the edit board pencil
leaves the toolbar for the boards dropdown (the way Edit tags sits in the tag
pop); then the board selector narrows and truncates its label (min ~80px), and
the user menu the same. "if it can be achieved cleanly, without making a mess
of conditions."

After the deep dive the user said "go ahead" to four defaults:

1. The logo and the ingest countdown fold before the names start truncating.
2. Below ~385px the ingest chip leaves the row, then the coin.
3. The tagging-consistency ticks (vote boards) fold with the pencil into the
   boards menu, and their unseen dot rides the board button while folded.
4. The coin opens its usage pop on hover or tap at every width, replacing the
   title tooltip.

## Why measure instead of a breakpoint

What sits in row 1 depends on the board (the template chip, the ingest
countdown), on who is looking (the pencil and the coin are a manager's) and
on live data (the token figures grow, the jobs chip gains a count). The
stocks board has to start folding at 800px; a board without those chips
wouldn't need anything until ~420px. Any fixed width is wrong for most boards.

## Measured (the deep dive)

On a throwaway copy of "stocks test": an admin named alex, the Stocks
template, ↑15,823k ↓8,638k $136.60, a 23h countdown. The row wants 744px and
the header gives it the window's width less 54px.

| steps | fits down to | 390 | 360 |
|---|---|---|---|
| the user's four: coin, template, pencil, names | ~465px | 77px short | 107px short |
| + logo and countdown before the names | ~385px | fits | 28px short |
| + ingest chip out, coin out | 320px | fits | fits |

The user's 499px screenshot is Chrome's narrowest desktop window, not a phone.

## The steps

In order. Each is a word in `#toolbar[data-fold]`, and styles.css says what
it does (`[data-fold~=word]`).

| step | what happens | where its door goes |
|---|---|---|
| `coin` | the usage figures fold into the coin | the coin's usage pop, on hover or tap |
| `template` | the mapping template chip goes | the board editor's Mapping pane |
| `edit` | the pencil and the ticks go | the boards menu: Edit board, Tagging consistency; the ticks' dot rides the board button |
| `logo` | the wordmark goes | the boards menu's All boards |
| `countdown` | the ingest chip keeps its icon only | its tooltip and the ingest modal |
| `names` | the board and user buttons give way, each down to 80px | the boards menu lists the full name |
| `ingest` | the ingest chip goes | the + menu's Automatic ingestion… |
| `usage` | the coin goes | none: the usage can't be read at these widths (≤340px on the stocks board) |

## How

- **`fitToolbar` (toolbar.js)** tries no steps, then one, then two, and keeps
  the first that doesn't overflow the row. Every try happens before paint, so
  only the answer shows. Nothing in the components reads a width; the one
  reader of the fold is the boards menu, which adds the rows for what the
  `edit` step took out.
- **It runs when the fit can change:** the row's width (a ResizeObserver on
  `#toolbar`), anything drawn in the row (a MutationObserver: token figures,
  a rename, the jobs count, the countdown's tick), and the web font swapping
  in (type.css is `font-display: swap`). The fold changes neither the row's
  width nor what's drawn in it, so none of these fires on its own answer.
- **One flat row.** The board and user buttons sat inside `.board-group` and
  `.auth`, and nested flex can't floor them at 80px: every variant tried
  either truncated "alex" before "stocks test" or let buttons slide over each
  other (and an overflow check can't see an overlap). So the row's two groups
  are `display: contents`, every control is the row's own flex item, and the
  spacing is stated on the row: a 6px gap, 8px more after the logo, 4px more
  between the right-hand controls, and a spacer (`.auth::before`, an auto
  margin) that holds the right-hand controls at the right edge whichever of
  them is showing. The boards and welcome pages share the header and get the
  same row.
- **The names floor** is `width: 80px; flex: 0 1 max-content` on the two
  buttons at the `names` step: the base size is the content, and the width
  only sets the flex item's automatic minimum, min(content, 80px). A name
  under 80px never shrinks and never grows.
- **Folded controls are `display: none`**, so they leave the tab order too.

## Built (2026-09-29)

- **toolbar.js**: `FOLDS`, `fitToolbar`, `folded`, `initToolbarFold` (called
  from app.js beside `initHeaderScroll`, so the unit tests that import the
  toolbar don't start observers). The template chip, the board name and the
  countdown got class hooks (`template-chip`, `board-name`,
  `ingest-chip-eta`). The boards menu's footer gains Edit board and Tagging
  consistency, first, while `edit` is folded; the ticks row wears the unseen
  dot on its glyph. BoardGroup reads the ticks' dot once (`ticksUnseen`) and
  hands it to the ticks button and the board button.
- **The coin** is a `<button class="mapping-chip token-chip">` with
  `aria-label="AI usage"`. Hovering opens the breakdown (a hover pop, as the
  tag chip's); a click or tap opens it to stay. The breakdown is the old
  tooltip's facts, one per line: a row per metered unit, the dollar figure
  with its "at the rates known when each call ran", and what it leaves out.
- **styles.css**: the flat row and the step rules sit under `#toolbar`. The
  ingest, jobs and token chips share one `button.mapping-chip` rule (border,
  font, cursor, hover) instead of the first two each restating it.
- **dropdown.css**: a dot on a menu row's glyph drops the white ring it wears
  on the light toolbar.
- **boards.js, welcome.js**: a comment each. Both pages put `.auth` straight
  into `#toolbar`, so they get the same flat row, and the spacer, not
  `.auth`'s margin, holds their user menu right.

Changed from the plan while building:

- **The right edge.** `.auth > :first-child { margin-left: auto }` would lose
  the auto margin whenever the first right-hand control folds (the ingest
  chip at the `ingest` step). A zero-width `.auth::before` carries it
  instead, whatever is showing. It adds a gap: the two clusters sit at least
  12px apart when the row is tight (14px before this change).
- **No mouse-only check on the coin's hover.** A tap fires the hover open, and
  the tap's click replaces that hover pop with one that stays
  (dropdown.js), so touch works without it, as the tag chip always has.
- **The ingest chip's tooltip names the countdown** ("Automatic ingestion:
  Scheduled — next run in 23h. …"). It said only "the schedule is armed",
  which is nothing once the `countdown` step has hidden the time.
- **`max-content`, not `content`, for the names' base size.** WebKit (the
  iPhone's engine, Playwright's WebKit 26.6) took `flex-basis: content` in
  the real row, computed it as `content`, and still laid both buttons out at
  the 80px width: "alex" grew to 80 and "stocks test" dropped straight to 80.
  A bare replica of the row got it right in WebKit, so it's something about
  the real buttons; `max-content` is right in both engines, and Chromium
  draws the two the same.

## Proofs

test/browser/toolbar-fold.test.js: the real server and public/, Chromium, 9
tests, green on source and on the build (`FRONTEND_DIR=public/dist`). The
board is shaped like "stocks test"; a second board has votes and a real
finding (25 tagged items, 10 split, the finding stored).

1. The sweep: 1200px down to 320 and back, every 10px. At every width the
   steps are a prefix of the list and never go back as it narrows; nothing
   spills or overlaps; the user menu holds the right edge; each step's
   control is hidden exactly when the step is taken; the board name is whole
   until `names`; the board button never goes under 80px; "alex" never
   changes width; growing back draws the same row. By 320 every step is
   taken.
2. The spacing at 1200 is the old row's: 14px after the logo, 6px in the
   board's cluster, 10px on the right; the boards page's user menu holds the
   edge with New board 10px from it.
3. A long address gives way only from `names`, holds 80px, and fits down to
   340px (see Known behaviors for under that).
4. The vote board: with room, the ticks carry the dot and the menu has only
   All boards and New board; folded, the dot is on the board button and the
   menu leads with Edit board and Tagging consistency (dotted); Edit board
   opens the editor.
5. The coin: a mouse hover opens the breakdown (no title left on the chip);
   on a 390px phone the coin stands alone, and a tap opens the breakdown and
   it stays until a tap elsewhere.
6. At `countdown` the ingest chip keeps its icon and its tooltip says "next
   run in 23h".
7. Renamed in the board editor at the width where only `coin` is taken, a
   long name takes more steps (the rename back goes through the boards
   menu's Edit board, since the pencil has folded) and the old name gives
   them back.
8. With the web font held, the row is folded in the stand-in font (790px:
   no steps); when Inter lands, the row takes `coin`.
9. Phones (touch, 430 to 320): the row fits, the page stays the screen's
   width, the user menu holds the edge, the board button holds 80px.

Removal checks, each fix taken out and its test watched failing:

| removed | failed |
|---|---|
| the fold (`FOLDS = []`) | 1, 9 |
| the flat row (`display: contents`) | 1, 2, 3 |
| the names floor (`width: 80px`) | 1, 3, 9 |
| the spacer (`.auth::before`) | 1, 2 |
| the boards menu rows | 4 |
| the board button's dot rule, either way (always hidden / never hidden) | 4 |
| the MutationObserver | 7 |
| the web-font listener | 8 |
| the ResizeObserver | 1 |
| the coin's click, then its hover | 5, 5 |
| the countdown in the ingest tooltip | 6 |
| the template chip's class | 1 |

Old against new, pixel for pixel (HEAD's public/ served as FRONTEND_DIR): the
header is identical wherever the old row fit, on the gallery at 1400, 1200
and 900, the boards page at 1200 and 390, and the welcome page at 1200 and
390.

WebKit, by hand (the suite is Chromium's; CI installs no WebKit): the real
server and public/ in Playwright's WebKit 26.6, the same board. Swept 1200 to
320px, every step in order, nothing spilled or overlapped, the user menu held
the edge, "alex" held 60px throughout; on a touch phone at 390, 375, 360 and
320 the row fits (board button 112, 97, 82 and 81px), and a tap on the coin
opens the breakdown and it stays. This is the run that caught `content`
(above).

Not proven by a test: the menu dot losing its white ring (dropdown.css), a
look.

## Known behaviors

- **A long user name on the stocks board fits down to 340px.** Under that,
  with every step taken and both names at 80px, the row is out of room: at
  320 it's 19px short, and its right end clips (nothing overlaps). "alex"
  fits down to 320.
- The row reacts to live changes: when the jobs chip lights up with a count
  on a tight screen, the next step folds, and it unfolds when the queue
  drains.
- Row 2 wraps to three or four lines on a phone but never spills. Not part of
  this.
