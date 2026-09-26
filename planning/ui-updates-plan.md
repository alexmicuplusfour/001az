# UI updates: change what changed, keep the rest (2026-09-26)

Self-contained for a fresh session. Written after the 2026-09-26 look at how
the board page repaints. The repaint costs below come from a benchmark
script, `ui-updates-bench.mjs`: real Chromium, a throwaway database, a board
with 5 facets of 10 values each. They were re-run with it in Stage 0's second
pass, when it learned to measure the re-layout row. It isn't in the repo: its
repaints were hand-fired `app:render`s, which since Stage 5 redraw nothing.
Other numbers say where they came from, and anything not measured says so.

Line links show the code as it was when the line was written. The arc started
from commit 6779198, so once a stage has changed a file, a link in "What is
actually happening" or in a stage's plan can be a few lines off, or point at
code that's gone. That stage's Built block says what replaced it.

## The ask

"Can you look into the way the app renders UI updates?" Then, after the
findings: "how do modern apps work? how can we make it not hacky?" The quick
fixes offered first (skip the hidden mobile rail, cache the chip counts, skip
repaints when nothing changed) were turned down. This plan fixes the cause.

## What is actually happening

**How a repaint works today.**

- All page state is one plain object, `state` ([state.js](../public/state.js)).
  Code that changes it then fires `app:render`: 63 calls in 23 files.
- `render()` ([app.js:28-67](../public/app.js#L28-L67)) runs straight away on
  every one of them. Nothing merges them, except
  [events.js:59-70](../public/events.js#L59-L70) for its own bursts.
- Each repaint:
  - clears the toolbar and builds it again from nothing
    ([toolbar.js:312-313](../public/toolbar.js#L312-L313));
  - builds the filter rail again from nothing, twice: the desktop rail and
    the mobile drawer, even while the drawer is closed
    ([filters.js:637-647](../public/filters.js#L637-L647));
  - before that, counts every chip by walking every item on the board
    (`computeFacetStats`, [filters.js:160](../public/filters.js#L160));
  - for a signed-in reader, runs the filtered list a second time just for the
    favorites count ([filters.js:290](../public/filters.js#L290));
  - redraws the grid or rows. This part is already done right: cards are
    cached by id and the page isn't touched when nothing changed
    ([grid.js:574-604](../public/grid.js#L574-L604)).
- When: every 4s while work is running (the poll); every 20s on any open board
  while the tab is visible, because the header's dots always end in a repaint
  whether or not anything came back different
  ([signals.js:143](../public/signals.js#L143)); and on every click that
  changes anything.

**What it costs.** A repaint where nothing changed:

| | 1500 items, full speed | 5000 items, CPU slowed 4x |
|---|---|---|
| whole repaint | 5.3–5.6ms | 48.7–50.6ms (three frames) |
| counting chips (`computeFacetStats`) | 1.5–1.7ms | 23–32ms |
| the page re-laid out mid-repaint | 2.2–2.3ms | 12.3–13.1ms |
| building the toolbar | 0.2–0.3ms | 1.4–6.6ms |
| a poll tick with no changes (fetch + merge + repaint) | 24ms | 102ms |

Each range is the bench's two runs: no filter on, and one chip on.

The re-layout row: once the toolbar and rail have been rebuilt, the grid reads
its own width to size the progress lane
([grid.js:372-375](../public/grid.js#L372-L375)), and the browser has to lay
out the whole page right then to answer. The same read costs ~0ms when nothing
was rebuilt. So the rebuild itself is between a quarter and a half of every
repaint, before counting anything.

**What breaks.** The first five are confirmed in real Chromium, and each is a
test (the drawer's since Stage 1) in
[ui-updates.test.js](../test/browser/ui-updates.test.js):

- Keyboard focus on a filter chip or a toolbar button drops to `<body>` on the
  next repaint. A keyboard toggle is itself a repaint, so pressing Enter on a
  focused chip or on the favorites button loses your place at once, not only
  when a poll lands.
- The search box keeps its text, but the caret jumps to the end
  ([toolbar.js:597-600](../public/toolbar.js#L597-L600)). With the caret at 3
  in "red chairs", it came back at 10.
- A toolbar menu that's open when a repaint lands loses its button. The caret
  flips back to "closed" while the menu is still open. Escape hands focus back
  to the removed button, so it lands on `<body>`. And clicking the button to
  close the menu closes it and immediately opens a new one.
- Every repaint replaces the filter chips and the jobs chip with new
  elements.
- The phone drawer is a second copy of the rail and loses focus the same
  way. Its scroll position survives. (Found in Stage 1's close look.)
- Not testable: a native tooltip closes when the element under it is
  replaced. The jobs chip's tooltip is the only place its lane counts are
  written out, and while work runs the chip is replaced every 4s. No test can
  see a native tooltip, so Stage 0 lists a check by eye.

**The workarounds the rebuild made necessary.** Each one puts back something
the browser would have kept if the element had stayed:

- the search box's focus-and-caret restore
  ([toolbar.js:311](../public/toolbar.js#L311),
  [597-600](../public/toolbar.js#L597-L600));
- the token counter kept in a module variable so it can roll across rebuilds
  ([toolbar.js:31-33](../public/toolbar.js#L31-L33),
  [434-454](../public/toolbar.js#L434-L454));
- the jobs chip's animation bookkeeping. The busy/idle edge is kept as a timed
  window and the glow's position is tied to the wall clock, because every
  repaint hands CSS a brand-new chip
  ([toolbar.js:163-213](../public/toolbar.js#L163-L213); the `--jobs-phase`
  and `--jobs-edge-phase` rules in
  [styles.css:1657-1710](../public/styles.css#L1657-L1710));
- the ingest chip's once-a-second timer, which has to notice its chip was
  thrown away and stop itself
  ([toolbar.js:90-97](../public/toolbar.js#L90-L97)), and the title write it
  skips to avoid churn ([toolbar.js:52-54](../public/toolbar.js#L52-L54));
- the saved-filters arrow opening its menu with a "find my replacement"
  function instead of an element
  ([toolbar.js:554-557](../public/toolbar.js#L554-L557)). It is the only
  reason dropdown.js re-finds and re-dresses its anchor on every repaint
  ([dropdown.js:265-293](../public/dropdown.js#L265-L293));
- dropdown.js holding a menu where it is when its button has been replaced
  while it's open ([dropdown.js:171-178](../public/dropdown.js#L171-L178)).
  Without it the menu would fly to the top corner on the next scroll. Found
  in Stage 0's close look;
- `keepPlace` ([modal.js:256](../public/modal.js#L256)). The board editor's
  taxonomy and the mapping pane rebuild their lists while the modal is open
  ([board-modal.js:77](../public/board-modal.js#L77),
  [mapping-modal.js:405](../public/mapping-modal.js#L405)), and this puts the
  scroll position and the focused control back afterwards. It's the same
  patch, inside modals. Found in Stage 0's close look.

**And the hand-built caches.** Each exists because a repaint can't tell what
changed, so it recomputes or rebuilds unless someone listed the inputs by
hand:

- `cardCache` + `cardSig` ([grid.js:27-80](../public/grid.js#L27-L80)). A
  card is rebuilt when its signature string changes, so every field a card
  shows has to be typed into that string;
- `filterKey()` ([filters.js:15-23](../public/filters.js#L15-L23));
- the clusters cache ([patterns.js:196-206](../public/patterns.js#L196-L206)),
  there because clustering takes ~70ms on a 4.5k board (its own comment's
  number) and a repaint arrives every 4s;
- events.js's one repaint per burst
  ([events.js:59-70](../public/events.js#L59-L70)).

## How modern apps do it

Two ideas. Every current framework has the first, and nearly all have the
second.

1. **Describe the UI, don't build it.** A component is a function that returns
   what its piece of the page should look like right now. A library compares
   that with what's on screen and changes only the differences: same
   `<button>`, new text. Nothing is thrown away, so everything the browser
   keeps on an element survives: focus, caret, hover, an open tooltip, a
   running animation. The workarounds above have nothing left to do.
2. **State that knows who reads it ("signals").** Each piece of state is a
   signal. A component that reads one is subscribed to it, and setting it
   redraws only those components. A value worked out from others (a
   `computed`, like the chip counts) keeps its answer until one of its inputs
   changes. Several changes in one moment become one redraw. There's no
   "redraw everything" event, no dispatch to remember, and no hand-listed
   cache keys.

The hand-built caches are the second idea done by hand, one piece at a time.
The workarounds are what the missing first idea costs.

## What changes

At the end of the arc, on the board page:

1. The toolbar, the filter rail and the cards are Preact components, written
   with htm: plain template strings, so `public/` still runs in the browser
   as written.
2. A repaint changes only what differs. Focus, caret, tooltips, animations and
   open menus survive it, and every workaround listed above is deleted.
3. Page state lives in signals. A change draws the page again, and each
   surface changes only what differs. The chip counts and the filtered list
   are recomputed only when the items or the filters changed, so a poll tick
   where nothing changed costs next to nothing.
4. `app:render` and its dispatches are gone, once nothing listens to them.

No visual change is intended at any stage: same markup, same class names, same
CSS, apart from the jobs chip's two phase variables.

## Decisions

- **D1 — Preact + htm + @preact/signals.** Recommended 2026-09-26; the user
  asked for it to be written up. Confirm at Stage 1's close look. Sizes
  measured 2026-09-26 (minified + brotli) against the board page's 51.8kB
  boot payload:

  | | size | why not |
  |---|---|---|
  | **Preact + hooks + htm** | **5.5kB** (7.8kB with signals) | |
  | lit-html + signals | 5.1kB | It only does templates. Components that set themselves up and clean up after themselves mean adopting Lit's web components on top, a second system. This page is full of widgets with timers, observers and menus, so without that their setup and teardown are hand-managed again, which is where the workarounds came from. |
  | React 19 | 58.0kB | Same model as Preact at ~7x the size. It would more than double the page. |
  | Solid | 10.4kB | Built around a compiler; its template-string mode is second-class. |
  | Svelte | not measured | A compiler, so dev would need a build step. |

  Also rejected:
  - *Morphing*: keep the builders, then patch the old page to match the new
    one, as idiomorph does. The builders attach click handlers that capture
    values when the element is built, and morphing keeps the old elements, so
    it keeps the old handlers. Every handler would need rewriting first, and
    at that point it's a framework written by hand.
  - *Writing our own*: that's the road the workarounds came from.

- **D2 — Shipped as one vendored file, the way the charting library already
  is.** `public/vendor/preact.mjs`, generated by a new
  `scripts/vendor-preact.mjs` from pinned versions and committed.
  - Precedent: [detail-chart.js:26](../public/detail-chart.js#L26) imports
    `./vendor/lightweight-charts.standalone.production.mjs`, and the
    production build bundles it like any other module (the copy-assets
    comment in [build-frontend.mjs](../scripts/build-frontend.mjs)).
  - The script fetches the packages the way build-frontend.mjs fetches
    esbuild: into a temp folder, with nothing added to package.json.
  - Checked 2026-09-26 on a trial bundle: no bare `import "preact"` is left in
    it, so it loads unbuilt from `public/`. It uses no `eval` or
    `new Function`, so the page's `script-src 'self'`
    ([server.js:311-321](../server/server.js#L311-L321)) holds.
  - The packages ship no license comments, so the script writes a
    `/*! … */` header naming each package, version and license (preact MIT,
    htm Apache-2.0, signals MIT). `--legal-comments=eof` then carries it into
    the built chunk. The script also copies each LICENSE file beside it, as
    `lightweight-charts.LICENSE` sits today.
  - Exactly one copy of Preact, ever. Every module imports from
    `./vendor/preact.mjs`; two copies break hooks.
  - Plain signals are a second file, `./vendor/signals.mjs`, from the same
    script (Stage 3's close look). The board page is its only user, and in
    `preact.mjs` they'd have cost the admin page 1.4kB. The same rule
    applies: one copy of the signals core, ever.

  Rejected: an npm dependency plus an import map. Seven HTML pages would need
  the map, the server would need a route into node_modules, and the build a
  second way to find the files.

- **D3 — htm, not JSX.** `public/` runs in the browser as written: host dev,
  the unit tests and the browser suite all load source. JSX would put a build
  step in front of every edit. htm reads like JSX with three differences worth
  knowing: a component is written `<${Name} />`, attribute values are
  `${…}`, and each template is parsed once and cached.

- **D4 — Until Stage 5, surfaces redraw exactly when they do today.** A ported
  surface keeps its exported function as the seam: `renderToolbar(count)`,
  `renderFacetsInto(container, stats)`. Only its inside changes: it calls
  Preact's `render()` into the same container instead of clearing it.
  - `render()` is synchronous, so app.js doesn't change, and code that reads
    the page right after a repaint keeps working. Example: the rail toggle
    measures its own height to hold the scroll
    ([filters.js:696-709](../public/filters.js#L696-L709)).
  - Tests that call those functions and inspect the container keep working:
    rail-render.test.js passed unchanged in Stage 1.
  - Signals take over *when* things redraw only in Stage 5. The first draft
    said Stage 3; its close look moved that, since caching the counts is
    nearly all of the speed.

  Checked in jsdom 2026-09-26: calling `render()` again into the same
  container keeps the same input element, its focus and its caret, and a
  focused button keeps focus.

- **D5 — Items stay the same objects.** `reconcile()` writes over each item in
  place, so the lightbox's current item, the selection and crate membership
  keep pointing at live data
  ([data.js:206-220](../public/data.js#L206-L220)).
  - Signals notice a new value, not a changed object. So item changes are
    announced through one function, `itemsChanged()`, which bumps an items
    version that the counts and the filtered list read. Items don't become
    immutable.
  - The writers, from Stage 3's close look: the poll's merge (only when the
    answer brought something), the requeue mirror, a heart (grid, lightbox),
    removing a file (lightbox, rows), a tag edit, crate membership (the
    checkbox, a new crate, deleting a crate, the bulk bar as each of its
    answers lands), an upload's rows, connector adds and the background
    drain. A write that replaces `state.items` needs no call.
  - Tag arrays are already replaced, never edited, by every writer; the
    clusters cache relies on that
    ([patterns.js:197-207](../public/patterns.js#L197-L207)).
  - The selection is replaced, never edited in place. Most writers already do
    `state.selected = new Map(…)`; a few in app.js, filters.js and
    patterns.js still edit it, and Stage 3 converts them.

- **D6 — Helpers that other code still uses are wrapped, never copied.**
  Three cases:
  - *Only the ported surface uses it*: it moves into the component and the
    old function is deleted. Examples: `toolBtn` (the toolbar is its only
    caller) and `pillAction` (the rail is its only caller).
  - *Other code uses it, and it doesn't change while the page is open*: the
    component draws the element empty and the old function fills it, once
    (D7). Example: `userMenuButton`, also on the boards and welcome pages;
    Stage 2's close look confirmed nothing in it changes during a visit. (The
    first draft said "mounts the old element"; appended into a row Preact
    draws, it loses its place.)
  - *Other code uses it, and it changes with state*: it becomes a component,
    and the old function becomes a thin wrapper that draws the component into
    a spare element and hands that element back, so there's one definition.
    Example: `pill()`, also used by jobs-modal.js and admin-usage.js
    (corrected in Stage 1's close look: detail-chart.js has a private `pill`
    of its own). Checked in jsdom 2026-09-26: the wrapper's element is a real
    element, and its click handler works after the element is moved.

  One kind fits none of the three: a helper that writes on its *parent*.
  `attachBtnDot` adds a class to the button it's given, which a component
  can't do, and wrapping it would load Preact onto the boards page for one
  span. So the surface Preact draws writes the class and the dot itself, and
  the helper stays for the hand-built pages. (Found in Stage 2's close look.)

  Component code stays out of utils.js. The boards, admin, account and
  welcome pages and the board page all import it, so anything it imports lands
  in all five bundles. The few components used by more than one surface (an
  `Icon` for the ICONS strings, `Pill`) each get a small module of their own,
  as shared controls already do (checkbox.js, dropdown.js): `pill.js` in
  Stage 1, `icon.js` in Stage 2.
  Everything else lives in the file that owns the surface today: toolbar.js
  keeps the toolbar. No components folder.

  The same goes for work done at load. The boards, welcome, account and admin
  pages reach `state.js`, so `state.js` stays a plain object, and making its
  fields signals happens in `state-signals.js`, which only the board page
  loads. (Stage 3's close look: done in `state.js`, it would have put the
  vendored signals on those four pages.)

- **D7 — A surface is ported whole, from a container nobody else rebuilds.** A
  component drawn inside an element that old code clears would be dropped
  without being told, so its timers and observers would never be cleaned up.
  So the toolbar goes as one unit (both rows), not chip by chip, and so does
  the rail. And old code never appends into an element Preact draws. It may
  fill one, once, when Preact gives that element no children and old code
  never touches its classes: `userMenuButton` fills the toolbar's button, the
  Odometer the token chip's counter. (Measured in Stage 2's close look: an
  element appended into a row Preact draws ends up out of place once the
  row's other children go and one comes back.)

- **D8 — Tests.**
  - **Only real triggers.** A browser test gets its repaint from something a
    person or the server really does: a key press that toggles a chip or a
    button, or a new item arriving through the page's own poll. Never from a
    hand-fired `app:render`. From Stage 3 the rail and toolbar stop listening
    to it, so it would redraw nothing and every test would pass without
    testing anything. A new item changes what the rail and toolbar show (the
    result count, the chip counts, the jobs count), so every stage has to
    redraw them.
  - **Bug tests state what happens today.** A test asserts today's behavior
    (focus lands on `<body>`, the caret at 10) and checks its setup along the
    way, so it only passes if the setup worked and the bug happened. It fails
    the moment the bug stops. The stage that fixes the bug rewrites the test
    to the fixed behavior, and its removal check is putting the old code
    back. Not `todo`: measured on Node 22.16, a failing `todo` keeps the exit
    code at 0, but one that fails because its own setup broke looks the same
    as one failing on the bug, and the default reporter prints a
    "✖ failing tests" block at the end of every `npm test`.
  - **Grouped by the stage that fixes them**, so each stage rewrites only its
    own. Things that are right today and that a later stage could break are
    pinned as "stays true" guards.
  - Rendered surfaces are tested in jsdom through `test/jsdom-stub.js` (the
    real index.html), which rail-render.test.js already uses.
    jobs-chip.test.js used to call `jobsChip()` for an element; since Stage 2
    it draws the component into a box.
  - The pure-logic tests (filter-shape, instance-rows, pattern-odds, lane,
    delta-reconcile, work-cadence, board-sort) shouldn't change.
  - Preact runs `useEffect` after the next frame, up to 100ms later when
    there's no `requestAnimationFrame` (seen in the jsdom check). A test of a
    timer or observer has to wait for it or use the jsdom stub's frame clock.
  - Every new proof gets a removal check: put the old builder back and watch
    the test fail.

- **D9 — Out of scope: the other six pages, the modals, the lightbox and
  dropdown internals.**
  - Menus are built when opened and thrown away when closed, so rebuilding
    them isn't the bug.
  - Most modals are the same, but not all. The board editor's taxonomy and
    the mapping pane rebuild their lists while open, and `keepPlace` is their
    patch. It works and is tested, so they stay out of scope; they're the
    first candidates once this arc is done. (Stage 0's close look corrected
    this: the first draft said every modal is thrown away whole.)
  - The boards page has its own toolbar and dots. It moves when it's next
    touched, by the same rules.
  - The masonry math (`layoutGrid`) stays hand-written in every stage,
    because libraries don't do layout. It runs after each draw.

- **D10 — A menu's button shows it's open through `aria-expanded`, not a
  class.** dropdown.js used to mark the button by adding `dd-open`. Preact
  rewrites an element's whole class list whenever the element's own classes
  change, so the mark vanished with the menu still open. Measured in Stage 2's
  close look: the caret flipped back to closed and the menu stayed up.
  dropdown.js already sets `aria-expanded`, Preact never writes it, and the
  app already styles from it (modal.css, welcome.css). The rules match
  `[aria-haspopup="menu"][aria-expanded="true"]`, which only dropdown.js
  sets, so the board editor's and the welcome page's disclosures aren't
  caught. The class is deleted. This is the one change to dropdown.js's
  insides (D9) besides deleting the "find my replacement" anchor, and it's
  there because the toolbar can't be ported correctly without it.
  - One more rule read the class: the admin page's board-access chip, in
    admin.html's own `<style>`, which Stage 2 missed (Stage 2's second pass
    found it). It reads `.boards-chip[aria-expanded="true"]`: one attribute,
    since the chip's class already narrows it. That keeps the rule's weight,
    so an empty chip's dashed look still wins on order.

## What stays the same

- The look: markup, class names and CSS. Each stage compares old and new side
  by side in a real browser.
- The server, the API, the poll cadence (`pollDelay`), the events channel and
  the URL sync.
- Dev: `public/` still runs unbuilt. Production: still one hashed bundle per
  page, with preload hints.
- The pure logic: facet matching, sorting, the clustering math, and
  `reconcile()`'s rules.

## Stages

Each stage gets a close look before it's built. Stages 0–2 are written close
to buildable. Stages 3–5 are the direction; their close looks make them
concrete.

### Stage 0 — pin the bugs

One new file, `test/browser/ui-updates.test.js`: real server, real Chromium,
one board with two facets and a few tagged items. Every repaint comes from a
real trigger, and every bug test states today's behavior (D8).

Fixed by Stage 1 (the rail):

1. Enter on a focused filter chip turns it on, and focus drops to `<body>`.
2. A poll that brings an item replaces the filter chips: the chip's count
   goes up, on a new element.

Fixed by Stage 2 (the toolbar):

3. Enter on the focused favorites button turns it on, and focus drops to
   `<body>`.
4. A poll that brings an item moves the search caret to the end, and replaces
   the jobs chip (one poll, both checks). The jobs chip staying the same
   element is what would keep its tooltip open, and unlike the tooltip it can
   be tested.
5. With the plus menu open, a poll leaves its caret reading closed, and
   Escape then drops focus to `<body>` (one poll).
6. With the sort menu open, a poll makes a second click on the sort button
   close the menu and open a new one.

Stays true (guards):

7. A poll that brings an item leaves every card already on the grid in place.
   Stage 4 rewrites cards.
8. Turning a lens on from the saved-filters menu keeps the menu open, with
   its button dressed open and the menu still under it. Today the toggle
   repaints the toolbar under the open menu, and the "find my replacement"
   anchor is what survives that. Stage 2 deletes the anchor.

- **Precondition, checked on every page the tests open:** the search box is
  there and the jobs chip is busy. Both exist only because the test server
  has an embedder. Tagged items waiting for an embedding are a backlog the
  suite never clears, and that backlog is also what keeps the page checking
  every 4s (measured 4034ms apart): the poll the tests wait on. If that
  changes, the tests fail with that sentence instead of a 12s timeout.
- **Removal checks.** Stage 0 has no fix to remove, so each test is checked
  in the direction that matters, and every temporary edit is restored byte
  for byte:
  - a bug test must fail once the bug stops. A temporary stand-in fix goes
    into the app code: focus or caret put back by hand after the rebuild, or
    the plus and sort menus opened through the "find my replacement" anchor.
    Where a stand-in would be real work (an element that stays the same), the
    assertion is flipped to the fixed behavior instead, and must fail on
    today's code;
  - a guard must fail when what it guards is broken: cards never reused, and
    the saved-filters arrow passing itself instead of the anchor function.
- **By eye, once:** hover the jobs chip on compose while a queue runs, and
  watch whether the tooltip vanishes at each 4s check. That settles the one
  claim no test can see.
- **The bench:** the table above is the "before". It was re-run with the
  saved bench in the second pass, on the day Stage 0 was built.
- No app code changes.

**Close look (2026-09-26)**: what the plan had wrong, before a line was
built. Ten prototype tests ran on today's code first: the 7 bug tests failed
for the expected reason and the 2 guards passed.

- **The repaint had no trigger.** The plan said "survives a repaint", and the
  first probe fired `app:render` by hand. From Stage 3 that redraws nothing,
  and the tests would pass without testing anything. Now: real triggers only
  (D8). A new item written to the database shows up about 3.7s later through
  the page's own poll.
- **`todo` hid broken tests and printed noise** (measured, see D8). Now: bug
  tests state today's behavior.
- **More was broken than the plan listed.** Keyboard toggles lose focus at
  once; an open toolbar menu loses its button in three ways; the filter chips
  are replaced too. Four checks became six bug tests.
- **Two workarounds were missing** from the list (dropdown.js's
  detached-anchor hold and `keepPlace`), and D9's reason for leaving modals
  out was wrong.
- **Two guards added** for things later stages could break.
- **The embedder dependency** (the poll and the search box) is now checked
  up front, as work-cadence.test.js does.
- **For Stage 3:** the bench fires `app:render` by hand too. See Stage 3.

**Built (2026-09-26), uncommitted.**

- [test/browser/ui-updates.test.js](../test/browser/ui-updates.test.js): the
  eight tests above, in that order. Each bug test checks its setup on the way
  and ends on assertions that carry one shared message: "this pins today's
  bug. If its stage has landed, rewrite the test to the fixed behavior".
- **Runs:** 8/8 on source and 8/8 on the built frontend
  (`FRONTEND_DIR=public/dist`). About 25s for the file: five tests wait on a
  real poll, ~4.4s each.
- **Removal checks.** Each test ran alone; every temporary edit was restored
  byte for byte, checked by hash.
  - R1, focus put back on the chip after the rail rebuild: test 1 fails on
    its pinned line (focus was on `button.pill.active[red]`).
  - R2a, the chip-identity assertion inverted: test 2 fails on its pinned
    line. R2b, the rail never redraws after boot: test 2 fails on its setup
    line ("the chip counts the new item"), so it can't pass by nothing
    redrawing.
  - R3, focus put back on the favorites button: test 3 fails on its pinned
    line.
  - R4a, the caret put back after the toolbar rebuild: test 4 fails on the
    caret (3, not 10). R4b, the jobs-chip identity assertion inverted (caret
    check skipped to reach it): fails on its pinned line. R4c, the toolbar
    never redraws after boot: fails on its setup line ("the jobs chip counts
    the new item").
  - R5a, the plus menu opened with the "find my replacement" anchor: test 5
    fails on the caret dressing. R5b, the same with that line skipped: fails
    on Escape (focus went back to the caret). R5c, the toolbar frozen: fails
    on its setup line.
  - R6, the sort menu opened the same way: test 6 fails (no new menu). R6b,
    the toolbar frozen: fails on its setup line.
  - R7, cards never reused: guard 7 fails (0 cards kept).
  - R8, the saved-filters arrow passing itself: guard 8 fails ("its button
    still reads open": 0).
- **A bug in the new test, caught by R4c.** The poll helper first watched the
  result count, a toolbar element, to know the item had arrived. So a frozen
  toolbar failed as "the new item didn't reach the page… is it still
  checking every 4s?", blaming the poll. The helper now watches the grid,
  which none of these tests is about, and each poll test checks that its own
  surface redrew: the red chip's count, the jobs count, or the result count.
  The result-count check was added to the two menu tests; R5c and R6b prove
  it.
- **Suite:** `npm test` 2011/2011 green in 1m45s, lint included, the eight
  new tests among them while eight files ran at once.
- **Owed, by eye:** the tooltip check on compose (hover the jobs chip while a
  queue runs).
- No app code changed. The bench numbers above stand as the "before" (same
  day).

**Second pass (2026-09-26)**: what shipped, re-read with fresh eyes, no new
scope. No test gave a wrong answer. What it checked, and what it fixed:

- **Checked and holds:**
  - Nothing repaints a test's page during its setup except the page's own
    poll, about 4s after the first draw. The event stream doesn't refresh
    on its first connection, only on a reconnect (events.js). The header's
    dots first tick at 20s. A board this small has no second page to
    stream in. Under the full suite's load, the setups finished with more
    than 2s to spare.
  - No request fails on these pages: `page.failures` was empty in all
    eight tests, so the file now asserts that too, as the house style does.
  - No pinned assertion can pass because nothing redrew. Each sits behind a
    setup check proving its surface redrew (R2b, R4c, R5c, R6b).
  - Tests don't leak into each other. Each opens a fresh browser context,
    so filters, favorites and the lens start off. The shared board only
    gains items, and every test measures its own before and after.
  - Line endings: the new files match their neighbors (LF, like 11 of the
    13 files in test/browser/; this said CRLF until Stage 1's second pass
    checked the bytes).
  - Every check below really ran. A first attempt at re-running them did
    nothing at all (a broken patch to the check script), which showed as
    empty output; the app files were confirmed clean and the full set was
    re-run once the script was repaired.
- **Fixed:**
  - **The table's numbers didn't all come from the bench this doc names,
    and the bench couldn't produce the re-layout row** that Stages 1 and 2
    are checked against. That row came from a one-off script. The bench now
    measures it, and its insert counter is named for what it counts
    (top-level insertions, not nodes). It was re-run at both sizes and the
    table now comes from it. The numbers moved by a few percent, none
    enough to change a conclusion.
  - **An unwritten timing assumption.** Every test has to finish its setup
    before the page's first poll. That was true, but written down nowhere.
    It is now, in the test file (openBoard's comment).
  - **The search test's setup was the most exposed**: 18 separate key
    presses before its trigger. It now fills the box and places the caret
    in two steps.
  - **A slow, vague failure.** Stalling a setup past the first poll showed
    the chip test waiting out Playwright's default 30s and failing with
    "Timeout 30000ms exceeded". The three waits after pressing Enter now give
    up after 5s, with a message naming the likely cause. Stalled again, it
    fails in ~5s with that message (D1). The stalled search test fails on
    its setup line, with the caret already at 10 (D4).
  - **Two sentences here overstated:** "every number below was measured
    with the bench" (see above), and "each one is a test" under What
    breaks, whose last item, the tooltip, can't be.
- **Not changed:**
  - The tooltip check stays owed, by eye.
  - The other waits in the file keep Playwright's default: they follow a
    page load or a click, and a click doesn't depend on focus, so a repaint
    can't swallow it the way it swallows Enter.
- **After the pass:** the file passes 8/8 on source and on the built
  frontend, lint is clean, and all sixteen checks (R1–R8 and D1, D4) fail on
  their intended line, with every file restored byte for byte.
  `npm test` 2011/2011 green in 1m30s, lint included.

### Stage 1 — Preact in the page, and the filter rail on it

The rail goes first because it's the smaller whole surface. Its containers
(`#filters`, `#filters-mobile`, `#filter-drawer-clear`) are fixed elements in
index.html that nothing else rebuilds, and it uses only a few helpers. The
toolbar is most of toolbar.js's 738 lines: two rows, five menus, an odometer,
and a user menu shared with other pages.

- `scripts/vendor-preact.mjs` produces `public/vendor/preact.mjs` plus
  `preact.LICENSE` and `htm.LICENSE` (D2). Preact and htm only. The hooks
  come in Stage 2 and signals in Stage 3: each add-on hooks into Preact as
  soon as it loads, so neither is shipped before something uses it.
  (Corrected in the second pass: this said "Preact, hooks and htm", and the
  first build shipped the hooks with nothing using them.)
- `renderFacetsInto(container, stats)` keeps its signature and draws the rail
  with Preact (D4): the status row, the clusters row with its fewer/more
  steps, the object and uploader rows, the real facets, and the odds marks.
  **Rows and chips are both keyed**: rows by facet (`~status` for the status
  row), chips by value. Keyed chips alone aren't enough: when a row appears
  above the focused chip's row (the status row does, as soon as anything
  starts processing), unkeyed rows are reused by position and the focused
  chip is replaced.
- **Known limit, not fixed here:** Chromium drops focus from an element that
  moves, even when it's the same element. Facet and object rows keep their
  declared order, so no toggle or poll ever moves their chips. The uploader
  row sorts by count and the clusters row by the clusters' own order, so a
  poll that re-sorts them can still take focus off a chip there. Chromium's
  newer `moveBefore()` keeps focus through a move, but Preact 10 doesn't use
  it.
- Helpers (D6): the `Pill` component goes in its own module, `public/pill.js`
  (the codebase's one-module-per-shared-control pattern: checkbox.js,
  dropdown.js, switch.js). `pill()` becomes a thin wrapper around it there,
  and its two other callers, jobs-modal.js and admin-usage.js, import it
  from there. `pillAction()` has one caller, the rail, so it moves into the
  rail and is deleted. `appendCount()` stays in utils.js for admin-plugins.js;
  the Pill draws its own count.
- The right-click exclusion listener stays on the container
  ([filters.js:319-328](../public/filters.js#L319-L328)): the container is
  fixed and the chips keep their data attributes.
- **Decided: the closed drawer keeps being drawn.** Once drawing is only a
  comparison, an unchanged drawer costs little. Skipping it would need a
  draw-on-open path, which is more code for a saving the bench can measure.
  The drawer's "Clear filters (n)" button isn't rail content and keeps its
  element already (only its label is rewritten), so it's left as it is.
- Tests:
  - rail-render.test.js should pass unchanged through the seam; if it
    doesn't, that's a finding;
  - two new tests, written first as today's behavior and flipped with
    Stage 0's two: the phone drawer (a keyboard toggle drops focus there
    too), and a poll that adds a row above the focused chip and a chip
    before it (proves the keys);
  - a new unit test for `pill()`, which nothing covers today;
  - once, before the old builder goes: the rail drawn both ways for the
    rail-render fixtures, and the markup compared, as the proof of "no
    visual change";
  - removal checks: the old code back fails all four rail tests; row keys
    off and chip keys off each fail the keys test.
- Checks:
  - source in real Chromium: `npm run test:browser`;
  - the built output:
    `npm run build:frontend && FRONTEND_DIR=public/dist npm run test:browser`;
  - no security-policy errors in `page.errors`;
  - boot payloads, measured the app-loading way. Before: board page 51.8kB,
    admin page 52.3kB. Expect about +5.5kB on each: the admin page takes
    Preact through admin-usage.js's `pill()`;
  - the bench: the re-layout row should shrink (the toolbar still rebuilds
    until Stage 2), and the rail row with it;
  - the real app goes through the harness (real server, real Chromium,
    desktop and phone width), never a session minted on compose. A look by
    eye on compose is the user's.

**Close look (2026-09-26)**: what the plan had wrong, before a line was
built. Measured in real Chromium unless marked.

- **Keyed chips weren't enough.** With a row appearing above, unkeyed rows
  replaced the focused chip and lost focus; keyed rows kept both. So rows
  are keyed too.
- **Keys can't stop a move from dropping focus.** A focused element that
  moves loses focus in Chromium, same element or not; elements moving
  around it are fine. Recorded above as a known limit for the two rows that
  re-sort.
- **The phone drawer has the same bug and no test.** A keyboard toggle in the
  drawer drops focus. Its scroll position holds across a real poll and a
  real toggle (235px stayed 235px). A first probe said the scroll reset,
  but it was the probe's own `focus()` call scrolling the drawer, and a real
  tap proved it wrong.
- **The `pill()` caller list was wrong.** detail-chart.js has its own private
  `pill` (a different control, `aria-pressed`, no `.pill` class). The real
  callers are jobs-modal.js and admin-usage.js. admin-plugins.js has its own
  copy, `filterPill`, from before this plan; it's left alone.
- **The real-app check conflicted with the rule** that live checks go
  through the harness, never a session minted on compose.
- **Decided here:** the closed drawer keeps being drawn; `appendCount()`
  stays; the module is `pill.js`.
- **Holds:** nothing but filters.js touches the rail's containers, and they
  start empty; Preact imports fine without a DOM, so the logic tests that load
  filters.js on the hand-written stub keep working; preact and htm each ship a
  LICENSE, and htm has no NOTICE file; D1 confirmed.

**Built (2026-09-26), uncommitted.**

- **What changed:**
  - `scripts/vendor-preact.mjs` (new) wrote `public/vendor/preact.mjs`
    (11.6kB, 4.6kB brotli: preact 10.29.8 and htm 3.1.1 in one file, a
    licence banner on top; the first build also carried the hooks, 14.4kB,
    until the second pass) and `preact.LICENSE` / `htm.LICENSE`. It
    installs the pinned packages into a temp folder and calls esbuild's own
    API, not its command line, because the banner has spaces a shell would
    split.
  - `public/pill.js` (new): the `Pill` component, and `pill()` as a thin
    wrapper that draws it into a spare element and hands the element back.
  - `filters.js`: `renderFacetsInto` draws with Preact. Rows are keyed by
    facet (`~status` for the status row), chips by value. `pillAction` became
    the rail's own `stepPill`. The uploader row carries a comment on the known
    limit.
  - `utils.js`: `pill()` and `pillAction()` are gone. `appendCount()` lost its
    `cls` parameter: the odds mark was its only other use, and the rail now
    draws that itself.
  - `jobs-modal.js` and `admin-usage.js` import `pill` from `pill.js`.
- **Tests:**
  - The two new browser tests (the drawer, the keys) were run first as today's
    behavior, and passed. With the new rail, all four Stage 1 tests then
    failed on their pinned lines, each "actual" being the fix (focus on
    `button.pill.active[red]`, the same element). All four were rewritten to
    the fixed behavior.
  - rail-render.test.js passed unchanged through the seam (8/8), as planned.
  - `test/pill.test.js` (new, 3 tests): `pill()` against the old builder's
    markup, and its click after the element moves. Checked directly as
    well: the old `pill()` and the new one give byte-identical markup for four
    argument sets.
  - The markup proof: the rail drawn by the old builder and by the new code,
    for 8 states (bare, mixed selections, gone values on every system row,
    excluded chips, odds marks drawn, status pills on, the clusters row with a
    gone cluster and its fewer/more steps). 8/8 identical, attributes sorted.
    The first run drew no odds marks, because its fixtures were too small for
    the lens to say anything, so a 40-item case was added that draws them.
- **Removal checks.** Every temporary edit was restored byte for byte,
  checked by hash.
  - RS1, all of Stage 1's app code put back: all four Stage 1 tests fail
    (focus on `<body>`; not the same element).
  - RS2, row keys off: the keys test fails (focus on `<body>`, red replaced).
  - RS3, chip keys off: the keys test fails with focus on
    `button.pill[amber]`. The element that held red was redrawn as amber,
    focus and all: the exact failure chip keys are there to prevent.
  - RS4, the wrapper drops its click handler: the pill test fails (0 clicks).
  - RS5, the Pill loses its title: the two markup tests fail.
  - Stage 0's checks for the toolbar tests and the guards (R2b, R3–R8, D4),
    re-run against the changed file: each still fails on its intended line.
    D1, a setup stalled past the first poll, now **passes** for the rail: a
    poll no longer takes the chip's focus, so the rail tests stopped
    depending on that timing.
- **Runs:** the browser file 10/10 on source; the whole browser suite 74/74
  on the built frontend; lint clean.
- **Payloads** (built, brotli, the app-loading way): board page 51.8 → 56.4kB
  (+4.6), admin page 52.3 → 57.0kB (+4.7), boards page 38.3kB unchanged
  (after the second pass; with the hooks it was 56.8 and 57.5kB). The
  licence banner rides into the chunks that carry Preact, and the LICENSE
  files are copied into dist.
- **Bench**, a no-op repaint, before → after:

  | | 1500 items, full speed | 5000 items, CPU slowed 4x |
  |---|---|---|
  | whole repaint | 5.3–5.6 → 3.2–3.5ms | 48.7–50.6 → 39.4–40.8ms |
  | the page re-laid out mid-repaint | 2.2–2.3 → 0.5–0.7ms | 12.3–13.1 → 3.6–4.1ms |
  | both rails drawn (counting included) | 1.9–2.4 → 1.9–2.1ms | 32.2–41.6 → 27.2–31.5ms |
  | a poll tick with no changes | 24 → 25ms | 102 → 85ms |

  Of the 120 top-level insertions per repaint, 110 are gone; the 10 left are
  the toolbar's. The chip counting itself is unchanged (23–32ms at 5000
  items), as planned: that's Stage 3.
- **Suite:** `npm test` 2016/2016 green in 1m39s, lint included, the five
  new tests (two browser, three for pill()) among them.
- **Owed, by eye:** the rail on compose, if wanted (click, right-click, Tab,
  the drawer on a phone). The harness covered the same in real Chromium, at
  desktop and phone width.

**Second pass (2026-09-26)**: what shipped, re-read with fresh eyes, no new
scope. A second reader that hadn't seen this plan compared the old rail with
the new one line by line, and nothing the old one did is lost. What the pass
found:

- **Fixed:**
  - **The hooks shipped with nothing using them.** The vendored file exported
    Preact's hooks, and the script said the production build drops whatever
    a page doesn't import. For the hooks it doesn't: like the signals add-on,
    they wire themselves into Preact as soon as the file loads. A page
    importing only `html` and `render` carried 0.45kB brotli of hook code
    (4.95 against 4.50kB). The script now exports just those two and says
    why, and Stage 2 adds the hooks it uses. The vendored file went from 14.4
    to 11.6kB (5.6 → 4.6kB brotli), the board page from 56.8 to 56.4kB and
    the admin page from 57.5 to 57.0kB. No built chunk carries hook code.
  - **A test that couldn't say why it failed.** One run of the whole browser
    suite on the built frontend failed guard 7 in its setup: no card drew
    within 30s, and all the wait said was "Timeout 30000ms". Four more runs
    of the file on the built frontend (forty board opens) and twelve opens of
    the same board state didn't repeat it, so the cause is unknown. openBoard
    now says what the page had: how many cards and chips drew, the first
    card's size, and the page's errors and failed requests. RP1 proves it
    (below).
  - **Comments that said something false:**
    - vendor-preact.mjs: the hooks sentence above;
    - styles.css named `pillAction` in utils.js as the step chips' source.
      It's `stepPill` in filters.js;
    - filters.js said "a chip that didn't change stays the same element".
      Any chip stays the same element while it's in the rail, changed or
      not, which is the point;
    - filters.js's known-limit note named only the uploader row. The clusters
      row is sorted by size (cluster-core.js) and has the same limit;
    - utils.js credited the odds mark to pill.js (filters.js draws it), and
      pill.test.js said nothing else covers pill()'s callers
      (work-cadence.test.js reads the job log's chip text).
  - **Stale lines in this doc:** D4's "Stage 1 finds out" (it did), Stage 1's
    "Preact, hooks and htm", and Stage 0's second pass calling the new test
    file CRLF (it's LF, like 11 of the 13 files beside it).
- **Changed on purpose, so recorded rather than fixed.** The arc exists so
  that an element that stays keeps what the browser keeps on it, and these
  are that:
  - After a mouse click, focus stays on the chip, with no ring (a click
    doesn't show one). Before, the rebuild dropped it to `<body>`. So Space
    or Enter toggles the chip last clicked, and the context-menu key excludes
    it. Nothing on the page handles Space or Enter globally, and the
    shortcuts stand aside only for text fields (shortcuts.js), so none of
    them behaves differently.
  - The chips' own CSS transition (0.12s on background, colour, border and
    opacity) now runs when a chip turns on or off, or a poll mutes it. A
    rebuilt chip was a new element every time, and a new element has nothing
    to fade from.
  - On a touch screen, a chip tapped off keeps its faint hover grey (#f1f1f3
    on white) until the next tap elsewhere. Measured in emulated touch
    Chromium, old rail against new: the old one replaced the tapped chip, so
    it never showed. A chip tapped on shows dark either way. Any button in
    the app that stays in place already does this, since no stylesheet
    guards hover for touch. If it's unwanted, `@media (hover: hover)` around
    the two `.pill` hover rules removes it, and Stage 2's toolbar would want
    the same. The user's call.
- **Checked and holds:**
  - Nothing the old rail did is lost: click and Alt+click, right-click
    exclusion (status and step chips still carry no address, so it ignores
    them), classes, titles, counts, odds marks, the order of rows and chips,
    and every rule for when one shows.
  - The keys test's everyday opposite: the status row and the chip ahead of
    red disappearing in one poll, as when an item finishes. Red kept focus
    and stayed the same element, in real Chromium. Removing an element
    doesn't move the ones after it.
  - Facet and object rows never move a chip: they follow the facet's
    declared values and the mapping's declared fields.
  - Keys: every list is keyed. The system rows' `~` keys can't clash with a
    facet's, since the server refuses `~` facet keys. A cluster named "more"
    can't be mistaken for the step chip, because they're different elements.
    Two chips can share a key if a board declares a value twice, or has two
    facets whose names make the same key (board-modal.js checks neither).
    Preact then pairs them in order, and twins always show together, so
    nothing visible breaks. Noted, for the board editor.
  - The four Stage 1 tests each see their own redraw during setup, so none
    passes with the rail frozen (R2b, re-run).
  - Nothing outside filters.js touches the rail's containers. Both pill()
    callers import it from pill.js, and nothing passes appendCount a third
    argument.
  - Line endings, checked in bytes against what git checked out: each edited
    file kept its own (filters.js and the new files LF; utils.js,
    jobs-modal.js and admin-usage.js CRLF).
  - Seen in passing, older than this arc: styles.css says "a pill is not a
    flex row" above the chip notes' margin, but `.pill` has been inline-flex
    since the ellipsis change.
- **After the pass:**
  - RS1–RS5, re-run against the new vendored file: each fails where it did.
  - R2b, re-run: fails on its setup line.
  - RP1, new: every repaint throws after the rail draws. The first Stage 1
    test fails in setup with "the board didn't draw (…; 0 cards, 5 chips).
    Page errors: ["Error: RP1: a repaint threw before the grid"]", the error
    listed once rather than once per poll.
  - Every file restored byte for byte, checked by hash.
  - The browser file 10/10 on source, and on the built frontend in four
    runs. The whole browser suite 74/74 on the built frontend; lint clean.
  - The bench, re-run: at or a little under the table above at both sizes
    (5000 items at 4x: repaint 33.4–36.5ms, re-layout 3.4–3.9ms, a quiet
    tick 76ms; 1500 at full speed: 2.9–3.0ms, 0.5ms, 21.5ms). One run can't
    separate what the hooks cost from run-to-run noise, so the table stands.
  - `npm test` 2016/2016 green in 1m37s, lint included.

### Stage 2 — the toolbar

- Re-run the vendor script with the hooks the toolbar uses added to its
  entry: the ingest chip's one-second timer, the jobs chip's edge, and the
  two elements old code fills (D7). Measured in Stage 1's second pass: the
  add-on's wiring alone is 0.45kB brotli on a page, and the whole add-on
  1.0kB. The admin page pays the wiring too, since it loads Preact for
  `pill()`.
- `renderToolbar(resultCount)` keeps its name and draws both rows, into
  `#toolbar` and `#toolbar-sub`. Setting `document.title` stays a plain line
  in it.
- Deleted, each one a workaround listed above:
  - the search restore (`searchHadFocus`). The box is safe to draw: its text
    goes to `state.searchDraft` on every keystroke
    ([toolbar.js:576](../public/toolbar.js#L576)), and Preact writes an
    input's value only when it differs from what's in the box, so a repaint
    never rewrites it mid-typing, caret included. **Rule: never delay that
    write.** A draft that lagged the box would have every repaint put the old
    text back;
  - the module-level `tokenOdo`: the token chip holds its own Odometer;
  - the jobs chip's edge window and wall-clock phase (`lastJobsBusy`,
    `lastJobsCount`, `lastJobsBoard`, `jobsEdge`, `--jobs-phase`,
    `--jobs-edge-phase`). The chip now stays the same element, so the
    ignite/cool animations run by adding a class on the busy edge and
    dropping it 450ms later, by the existing constant rather than on the
    animation's end: with reduced motion the animations are off, and no end
    event would ever fire. The cooling "ghost count" still needs the last
    count remembered; that's a line in the component;
  - the ingest chip's self-stopping timer and its title skip. The timer is set
    up when the chip appears and cleared when it goes. Checked in jsdom
    2026-09-26: a component's timer is cleared when the component is removed;
  - the "find my replacement" anchor for the saved-filters arrow: the arrow
    passes itself. That leaves dropdown.js's anchor-as-function support with
    no caller (filterconfigs.js:84 already passes an element), so it's deleted
    too: the function-anchor branch and the `app:render` listener it
    registers, and filter-config-pop.test.js's test of them. Stage 0's
    guard 8 must keep passing.
- The open-menu mark moves to `aria-expanded` (D10): dropdown.js stops adding
  `dd-open`, and dropdown.css's three rules read the attribute.
- Not deleted: dropdown.js's hold for a menu whose button was replaced
  ([dropdown.js:167-173](../public/dropdown.js#L167-L173)). Menus opened from
  cards can still lose their button until Stage 4, and the editor panes'
  menus after that.
- Helpers, sorted by D6 in the close look:
  - `toolBtn()` is deleted: the toolbar was its only caller;
  - `Icon` (new, `public/icon.js`) draws an ICONS string as the `<svg>` it
    describes: htm reads the string as a template, with one strings array per
    icon so htm's cache can't grow;
  - `userMenuButton` fills a button the toolbar draws, through a new
    optional argument, and the Odometer fills the counter the token chip
    draws (D7). The boards and welcome pages call `userMenuButton()` as
    before;
  - `attachBtnDot` stays for the boards page. The toolbar draws its three
    dots itself: `has-dot` on the button and the dot inside it (D6's extra
    case);
  - `appendCrateLabel` becomes `CrateLabel` in crates.js, and the old
    function wraps it for the crates menu (D6's third case);
  - the favorites count is the rail's: a `Count` shared from pill.js.
- The menus the toolbar opens keep using dropdown.js, anchored to elements
  that now stay put.
- Tests:
  - jobs-chip.test.js draws the component;
  - Stage 0's four Stage 2 tests are rewritten to the fixed behavior, each
    with a removal check. Guard 8 and the plus-menu test read `aria-expanded`
    instead of the class;
  - a new guard, written first against today's code: with a cluster chip on,
    turning the cluster lens off from the open saved-filters menu keeps the
    arrow reading open, although the Filters count changes under it (the
    case D10 exists for). Clusters need at least 16 items with three tags
    each, so it gets a board of its own;
  - new unit tests: `Icon` against every ICONS entry, and the jobs chip's
    edge (the class on the crossing, gone 450ms later, the ghost count while
    cooling);
  - once, before the old builder goes: both rows drawn by the old code and
    the new for a spread of states, and the markup compared, as Stage 1 did
    for the rail.
- Comments that become false and get rewritten: dropdown.js (the anchor
  contract), dropdown.css (the caret note), filterconfigs.js (the accessor),
  odometer.js (the rebuilds), board-signal.js (the gallery's fresh elements),
  styles.css (the jobs chip's phase notes), and toolbar.js's own.
- Real app:
  - tab through the toolbar while a queue runs;
  - hover the jobs chip across several polls. The chip staying the same
    element is what lets its tooltip stay up, but may not be enough: its
    text changes with every poll while work runs, and no test can see a
    tooltip. By eye;
  - watch ignite and cool next to the old build;
  - type in search while a poll lands;
  - open each menu while a repaint lands.
- The bench: the toolbar and re-layout rows.

**Close look (2026-09-26)**: what the plan had wrong, before a line was
built. Four prototypes on a real board page in real Chromium, through the
harness.

- **An open menu's button would have stopped looking open.** dropdown.js's
  `dd-open` is a class, and Preact rewrote the whole class list when the
  button's own classes changed: the caret flipped back to closed with the
  menu still up. It happens under an open menu when turning a cluster lens
  off clears a cluster selection (the Filters count drops and the arrow loses
  `active`), or when an alert fires (the plus button's dot is a class). Now
  D10. With a rule on `aria-expanded`, the caret stayed turned.
- **Icons needed a way in.** Most toolbar buttons get their icon as an SVG
  string with a label or a dot beside it, which a template can't do without
  wrapping the string in an extra element. htm reading the string as a
  template gave the identical `<svg>` for all 50 icons, beside a label too.
- **The user menu can't be appended into a row Preact draws.** Once that
  row's other children went and one came back, the menu was no longer last.
  Rare with today's boot order (the first draw has the board and the user),
  but fragile. Now D7's fill rule, which keeps the markup identical and the
  boards and welcome pages free of Preact.
- **Two helpers D6 left open:** `attachBtnDot` writes a class on its parent
  (D6's new case); `appendCrateLabel` fits D6's third case.
- **Tests the plan missed:** filter-config-pop.test.js tests the anchor this
  stage deletes; guard 8 and the plus-menu test read the class D10 deletes;
  D10's own case had no test.
- **Holds:** the search box (see its rule above). The jobs chip model: on one
  element the glow is one continuous animation through igniting, busy and
  cooling (the same animation objects, 283 → 317 → 633ms), so dropping the
  two phase variables loses nothing. Nothing outside toolbar.js touches the
  toolbar or queries its elements. `toolBtn` has no other caller. The user
  menu never changes during a visit. The Odometer already persists by
  design.

**Built (2026-09-26), uncommitted.**

- **What changed:**
  - `toolbar.js` draws both rows with Preact: one `ToolBtn`, and components
    for the jobs chip, the ingest chip, the token chip, the board group, the
    user menu's button, the search box, the crates button and the mode chips.
    738 lines became 590. Deleted: `searchHadFocus`, the module-level
    `tokenOdo`, the jobs chip's edge window and wall-clock phases, the ingest
    chip's self-stopping interval and title skip, and the "find my
    replacement" anchor. `jobsChip()` is now the `JobsChip` component.
  - `dropdown.js` takes an element anchor only. The accessor branch and its
    `app:render` listener are gone, and the open mark is `aria-expanded`
    (D10), with the `dd-open` class deleted. `dropdown.css`'s caret and
    trigger rules read the attribute.
  - `icon.js` (new): `Icon`. `pill.js`: `Count`, which the chips and the
    favorites button now share. `crates.js`: `CrateLabel`, with
    `appendCrateLabel` wrapping it. `user-menu.js` fills a button it's given;
    `odometer.js` fills the element it's given. `utils.js` lost `toolBtn`.
  - `styles.css`: the jobs chip's two phase variables are gone, the one CSS
    change the plan allows, and its notes are rewritten.
  - Comments rewritten in dropdown.js, dropdown.css, filterconfigs.js,
    odometer.js, board-signal.js, styles.css and utils.js (`attachBtnDot`,
    `appendCount`).
  - The vendor script exports `useState`, `useEffect`, `useLayoutEffect` and
    `useRef` again: 14.3kB, 5.5kB brotli.
- **Tests:**
  - The new guard was written first and passed on the old code, where the
    "find my replacement" anchor re-marked the rebuilt arrow. It passes on
    the new. Its board is the file's second, 20 items in two alike groups.
  - The four Stage 2 tests, run on the new code before any rewrite: each
    failed on its pinned line with the fix as "actual" (focus on
    `button.tool-btn.fav.active`; the caret at 3; the plus caret still marked
    open; the second click only closed the sort menu). Rewritten to the fixed
    behavior. The sort test no longer waits 3s for a menu that shouldn't
    come: the close happens in the same call that would have opened it. With
    no pinned test left, the file's PINNED message is gone.
  - Guard 8 and the plus-menu test read `aria-expanded`.
  - jobs-chip.test.js draws the component, plus the edge test: igniting on
    the crossing and still there partway through, gone after 450ms; cooling
    with the ghost count, then idle.
  - icon.test.js (new): all 50 glyphs give the string's own markup and are
    made of real SVG elements (markup alone can't tell: a `<path>` made in the
    HTML namespace prints the same and draws nothing); beside a label, no
    wrapper.
  - filter-config-pop.test.js: the anchor test went with the anchor.
  - **The markup proof:** both rows drawn by the old code and the new, each in
    its own process, through the same 9 states drawn back to back, so the new
    code is measured on its repaint-in-place path rather than a fresh draw per
    state. Attributes and classes sorted, the old chip's phase style dropped:
    9/9 identical. The states cover no reader; a bare board; work waiting
    with a failure unseen on a paused board; the queue draining (the
    cool-down with the ghost count); a manager's tokens and cost, connector
    chip, diagnostics and ingest countdown; the alerts dot, an own crate on,
    sort, favorites, filters and the clear button, the rows view and a typed
    search; someone else's crate, a search running and both mode chips; ingest
    held, a spend in a unit other than tokens, everything off; no board.
- **Removal checks.** Every temporary edit was restored byte for byte,
  checked by hash.
  - RT1, all of Stage 2's app code put back: the four Stage 2 tests fail
    (focus on `<body>`; the caret at 10; the plus caret not marked open; a
    new sort menu opened). With the same code back, the three guards pass:
    they held before Stage 2 as well.
  - RT2, D10 undone (the open mark a class again, the caret rule on it): the
    new guard fails with `aria-expanded` "true" and the caret flat, the
    close look's bug exactly.
  - RT3, the search box stops writing its text to state: the search test
    fails with the text gone (`''`, caret 0) after the poll.
  - RT4, the edge class never cleared: the edge test fails, still
    `igniting`. RT5, the cool-down forgets the last count: it fails on the
    ghost count (`'0'`).
  - RT6, `Icon` wraps the glyph in a span: both icon tests fail.
  - RT7, the saved-filters arrow remounted on every repaint: guard 8 fails
    ("its button still reads open": 0).
  - Stage 0's checks re-run on the new toolbar: the rail frozen (R2b) and
    the toolbar frozen (R4c, R5c, R6b) each fail on the setup line that
    proves its surface redrew; cards never reused (R7) fails guard 7.
- **Runs:** the browser file 11/11 on source; the unit suite 1944/1944; the
  whole browser suite 75/75 on the built frontend; lint clean.
- **Real app, through the harness:** 24 real Tab presses, 400ms apart, while
  two polls landed, walked the toolbar in order (board, jobs chip, +, its
  caret, the user menu, Filters, its arrow, search, favorites, sort) and on
  into the rail and the cards. Focus never fell to `<body>` partway; the
  once it did was the walk running off the end of the page and wrapping to
  the logo. Seen in passing, older than this arc: the walk goes through the
  closed phone drawer's controls on a desktop-width page.
- **Payloads** (built, brotli): board page 56.4 → 57.3kB, admin page 57.0 →
  57.4kB (the hooks' wiring, as measured in Stage 1's second pass), boards
  page 38.3 → 38.2kB and welcome page 19.5 → 19.4kB (dropdown.js lost the
  anchor branch).
- **Bench**, a no-op repaint, from Stage 1 (as re-run in its second pass) to
  now:

  | | 1500 items, full speed | 5000 items, CPU slowed 4x |
  |---|---|---|
  | whole repaint | 2.9–3.0 → 2.5–2.7ms | 33.4–36.5 → 30.4–34.9ms |
  | the page re-laid out mid-repaint | 0.5 → 0.1ms | 3.4–3.9 → 0.5–0.8ms |
  | drawing the toolbar | 0.2–0.3 → 0.1–0.2ms | 1.6–3.2 → 0.9–3.1ms |
  | a poll tick with no changes | 21.5 → 25.8ms | 76 → 67ms |

  Across the arc so far, at 5000 items and 4x: a repaint that changes
  nothing went from 49–51ms to 30–35ms, and the forced re-layout inside it
  from 12–13ms to under 1ms. What's left is almost all the chip counting
  (21–25ms), which is Stage 3. The 1500-item poll tick moved within its
  noise. Of the 120 elements a repaint used to insert, 2 are left: the phone
  drawer's "Clear filters (n)" label, which filters.js still writes as
  markup (its button keeps its element; Stage 1 left it as it was).
- **Suite:** `npm test` 2019/2019 green in 1m37s, lint included.
- **Owed, by eye, on compose:** hover the jobs chip across several polls
  while a queue runs (the tooltip); watch ignite and cool next to the old
  build.

**Second pass (2026-09-26)**: what shipped, re-read with fresh eyes, no new
scope. Two readers that hadn't seen this plan compared the old code with the
new, one the toolbar line by line, the other the shared helpers and every
other caller of them. Each finding was re-read in the code, and the ones
about behavior were measured in Chromium, old against new. The old side was
the frontend as it stood before Stage 2, served from a copy. What the pass
found:

- **Fixed:**
  - **The saved-filters menu stopped following its arrow.** The "find my
    replacement" anchor had also moved the menu under its arrow on every
    repaint. Without it, the menu moved only on scroll or resize. With a
    cluster chip on, turning the cluster lens off from the open menu clears
    the chip, so "Filters (1)" becomes "Filters" and the arrow moves 17px
    left. The old menu followed it (0px off). The new one stayed 17px off.
    The cluster rows now move the menu after their flip. They use the menu's
    own `reposition`, which the admin menus already call when their content
    changes size. The D10 guard now checks the menu's left edge too, after
    a setup line that proves the arrow moved.
  - **The admin page's board-access chip stopped lighting while its popover
    was up.** admin.html has a `.boards-chip.dd-open` rule of its own, the
    last thing reading the deleted class, and Stage 2's search for the class
    missed it. Measured: lit (#e6e6ea) before, resting grey after. It reads
    `aria-expanded` now (D10 says how). The MCP tab's test already opens
    that chip's popover, and now also checks the chip reads open with the
    pointer away.
  - **Clicking the search box's × dropped the focus.** The old restore put
    the caret back in the box after any repaint that found the focus
    anywhere in it, the × included, so a click on the × left you ready to
    type. The new × goes as the search clears, and the focus a click gave it
    went with it. It now hands the caret to the box itself. There's a new
    "stays true" test (it passes on the old code too).
  - **A row that threw while it drew broke the toolbar until a reload.** The
    toolbar reviewer couldn't settle this by reading, so it was measured.
    The jobs chip was made to throw once, through its read of
    `state.boardPaused` (nothing else in the toolbar reads it while
    drawing), and then two normal repaints followed. The old toolbar was
    blank for that repaint and exactly as before on the next. The new one
    drew a second `.auth` group, a second + button and user menu, and kept
    it. Preact keeps a record of what it drew, and a throw partway through a
    draw leaves the record half updated.
    - Each row now sits under an error boundary (`useErrorBoundary`, which
      the vendor script now exports: 14.5kB, 5.6kB brotli). What threw keeps
      what it last drew, the rest of the row still draws, and the error is
      still reported as uncaught (`reportError`), so it reaches the console
      and the browser tests' error log. The next repaint tries again.
    - A boundary can't catch a second error before Preact settles the first
      a moment later. Measured with two throwing repaints in one moment (a
      click can repaint twice): the duplicate came back. So a repaint in
      that moment leaves the row as it is.
    - After: one throw, two throws in one moment, and an error that lasted
      three repaints each left one of everything, back exactly as before,
      with every error reported. The rail and the grid now also draw on a
      repaint where the toolbar threw. The old toolbar's error stopped the
      whole repaint, since it draws first.
    - New unit test: toolbar.test.js.
  - **The ingest chip could show stale words.** Stage 2 kept its last face
    across repaints. It had read the old "leave its last text alone" as
    lasting, and it never did: the old chip was rebuilt on every repaint, so
    in that branch it showed just its icon. The one state that reaches the
    branch while the chip shows is a schedule armed but not yet stamped,
    such as a paused board switched back on. There the new chip kept saying
    "paused" until the sweep stamped it. It's back to just the icon, with a
    comment naming that state, and a test in toolbar.test.js.
  - **Comments that said something false:**
    - odometer.js had the frame order backwards: a frame callback runs
      before the browser's layout, not after. What's true is that waiting
      keeps the read out of the middle of the toolbar's redraw;
    - dropdown.js said a hover menu's button never gets redrawn under it. A
      card rebuilt by a poll takes its tag chip with it, until Stage 4. The
      sentence explained binding to the element in hand rather than the
      anchor function, which is gone, so the sentence went too;
    - toolbar.js said a repaint compares with what is on the page. Preact
      compares with what it drew last time. It also said Preact erases a
      class set from outside on every repaint, when it does so only when
      the classes it draws there change;
    - pill.js called favorites the toolbar's one button with a number. The
      jobs chip and the Filters label carry numbers too. It's the one with
      a trailing count;
    - board-signal.test.js still said the header gets its one-dot guarantee
      from fresh elements each pass.
  - **This doc:** a note on line links (they show the code as it was
    written, from 6779198). The two links later stages follow now point
    where the code is: D4's rail toggle and Stage 2's menu hold. Also D10's
    admin rule, Stage 3's list of reads straight after a repaint, and the
    Cost line, now measured.
  - **A test that hung instead of failing.** With the ingest fix taken out,
    the new ingest test failed before it could remove the chip. The chip's
    once-a-second timer then kept the test file from ever finishing. Its
    cleanup now runs either way.
- **Changed on purpose, so recorded rather than fixed:**
  - Escape in the search box now clears it and leaves it in one press. Its
    handler always said "clear, then leave". Before, the leave hit the
    replaced box, so the first Escape kept the caret in the emptied box and
    only a second one left. Now the page's own shortcuts get Escape one
    press sooner. If the two-step is wanted back, it's one line.
  - On a touch screen, a tapped toolbar button keeps its faint hover grey
    (#f1f1f3) until the next tap elsewhere. Measured: favorites tapped on
    then off, and Filters tapped twice. The old toolbar never showed it.
    It's the same as the chips, and the same open question as in Stage 1's
    second pass.
  - The sort button's label is text now. The old helper wrote it as markup,
    and a sort label can come from a board's field names, so a field named
    with markup rendered as markup there. The page's script policy already
    blocked scripts. This is a fix, recorded so it isn't mistaken for a
    change of look.
  - A menu used to close when its button disappeared. That went with the
    "find my replacement" anchor. The saved-filters arrow disappears only if
    the reader or the board name goes, and both are set once at boot
    (sign-out reloads), so nothing reaches it today.
- **Checked and holds:**
  - Every toolbar menu across a real poll. This was the plan's real-app
    check, and the Built block had covered only the three menus the tests
    open. Each of the board menu, the plus menu, the user menu, saved
    filters, crates and sort stayed the same menu on the same button,
    marked open with the caret turned, 6px under it. Escape closed each one
    and gave its button focus, and a reopened menu closed on a second click.
  - Nothing else reads `dd-open`: no JS, CSS, HTML or test. Every
    `openDropdown` caller passes an element. No anchor manages
    `aria-expanded` itself, and nothing else sets `aria-haspopup`, so the
    two attributes mark exactly the elements the class did, at the same
    moments.
  - Every caller of a changed helper, old signature against new:
    `userMenuButton` (the boards and welcome pages call it as before),
    `Odometer` (one caller), `appendCrateLabel`, `Count`, `Icon`,
    `attachBtnDot` and `appendCount`. Nothing refers to `toolBtn` any more,
    and nothing sets or reads the jobs chip's deleted phase variables.
  - There is no board switch within a page: the board id is set once at
    boot ([app.js:79](../public/app.js#L79),
    [115](../public/app.js#L115)) and the board menu navigates. So the jobs
    chip losing the old per-board memory loses nothing.
  - The one toolbar element with a CSS transition is the caret's own turn,
    which ran on open and close before too.
  - Packaging: before the pass changed it, the vendor script regenerated
    the committed file byte for byte, and the licenses are unchanged. The
    boards, welcome, account, login and logs bundles carry no Preact.
  - The jobs chip and icon unit tests: six runs side by side, all green.
    The edge test's 250ms check has 200ms of room before its 450ms timer.
  - Line endings: each file kept its own.
- **After the pass:**
  - Removal checks, one fix taken out each time, with every file restored
    byte for byte (checked by hash):
    - RP2, the cluster rows don't move the menu: the D10 guard fails with
      the menu 17px off its arrow;
    - RP3, the admin chip's rule back on the deleted class: the MCP scope
      test fails with the chip at its resting grey;
    - RP4, the × clears without handing the focus over: the × test fails
      with the box unfocused;
    - RG1, the rows drawn without the boundary: toolbar.test.js fails when
      the throw escapes the first repaint. RG2, the boundary without the
      settling skip: it fails when the throw escapes the second;
    - RI1, the ingest chip keeping its last face: it fails with "paused",
      the held title and the `paused` class;
    - RT2, re-run on the renamed D10 guard (D10 undone): it fails with the
      caret flat and `aria-expanded` "true".
  - The D10 guard, the × test and the MCP scope test also pass on the old
    frontend, as guards should.
  - Runs: the whole browser suite 76/76 on the built frontend. `npm test`
    2022/2022 green in 93s, lint included.
  - The bench, re-run, at or under the Stage 2 numbers above. At 5000 items
    and 4x: repaint 32.6–34.3ms, re-layout 0.7–0.8ms, drawing the toolbar
    1.0–3.1ms, a quiet tick 66.5ms. At 1500 and full speed: 2.5ms, 0.1ms,
    0.1–0.2ms and 20.6ms.
  - Payloads (built, brotli): the board page 57.3 → 57.5kB. The admin,
    boards and welcome pages are unchanged.
  - Still owed, by eye, on compose: the jobs chip's tooltip across several
    polls, and ignite and cool next to the old build.

### Stage 3 — the counts and the list, cached (the speed half)

Rewritten by its close look (below). The first draft also moved the rail and
the toolbar onto signals of their own. Measured, that part was worth ~2–4ms of
a quiet repaint at 5000 items and 4x, against most of the stage's risk, so it
moved to Stage 5.

- Plain signals (`@preact/signals-core`, pinned) get a vendored file of their
  own, `public/vendor/signals.mjs`, written by the same script. Only the board
  page loads it: ~1.4kB brotli there (measured once built: 1.9kB, with the
  file's license line and the stage's own code). In the shared `preact.mjs`
  they'd cost the admin page 1.4kB for nothing, since the build can't drop the
  unused part of one pre-bundled file. There is only ever one copy of the
  signals core: the Preact wiring Stage 5 may add must use this file, not
  bring its own.
- `public/state-signals.js` (new, board page only) turns each of `state`'s
  fields into a signal behind a getter and setter, so every `state.x` read and
  write stays as it is. It can't live in `state.js`: the boards, welcome,
  account and admin pages all reach `state.js`, and turning the fields into
  signals is work done at load, which would bring the signals onto them.
  - filters.js imports it first, so the fields are signals before any cached
    value is read. app.js imports filters.js.
  - `boardIngestError`, the one field made outside `state.js` (by
    `stampBoard`), is declared there.
  - utils.js's `isAdmin()` is deleted. Nothing calls it, and it was utils.js's
    only reason to import `state.js`.
- Cached with `computed`, behind the functions callers use today:
  - the chip counts, which the rail reads;
  - the filtered, sorted list (`taggedFiltered`), read by `render()`, the
    grid's next batch, the rows view and the lightbox. None of them edits it,
    so they share one copy;
  - the favorites count, which reads the cached list.

  The functions that do the counting stay, for the tests and the bench. The
  filtered list reads the state fields it needs once, before its loop over the
  items. Read once per item through the getters, they cost 2.2 → 3.9–4.4ms at
  5000 items and 4x.
- Item changes are announced with `itemsChanged()` (D5 has the list of
  writers). It bumps a version the cached values read. The poll's merge
  announces only when the answer brought something, so a quiet tick recounts
  nothing. Where the list itself is replaced (boot, a delete, the ghost
  sweep), the `items` signal announces on its own.
- The selection is replaced, never edited. Five places edited it in place:
  boot's uploader filter, the chip toggle, and three places where the
  clusters lens drops its chip. The chip toggle also edited the sets inside
  the entry, so the entry is copied too.
- The clusters cache stays. On purpose, it keeps serving the old grouping
  while items are still being worked, and the meaning grouping comes from the
  server, so a `computed` can't replace it. It publishes its grouping as a
  signal whenever that changes, and the counts and the list read it through
  `clusterSet`. The ordering rule at the top of `render()` stays.
- The rail and the toolbar keep redrawing on every repaint, inside it (D4 now
  runs to Stage 5). With the counts cached, that redraw is Preact comparing two
  unchanged surfaces.
- A check for the tests: with a flag set, every repaint compares the cached
  counts, list and favorites count with a fresh computation, and throws on any
  difference. A writer that forgets to announce leaves the rail wrong without a
  sound, so the browser harness sets the flag on every page it opens. That
  makes each browser test that changes items or filters check this too. A
  writer no test reaches gets a test of its own.
- The bench: its hand-fired repaint still reaches the rail and toolbar, so its
  rows stay comparable across stages. Its quiet-tick row is split in two: the
  page's own work (reading and merging the answer), and the wait for the
  server, which this stage can't touch.
- Tests:
  - unit, in jsdom: after each writer that can be called on its own (the
    poll's merge, the requeue mirror, an upload's rows, the chip toggles,
    the clusters lens), the cached counts and list match a fresh count; a
    quiet merge leaves them cached;
  - browser, with the check on everywhere: the writers only the page's
    buttons reach, each through its real control, checking what the page
    shows as well;
  - every one with its announcement removed, to watch it fail;
  - the Stage 0–2 tests unchanged.

**Close look (2026-09-26)**: what the first draft had wrong, before a line was
built. Three read-only agents made inventories: every write to `state`, every
write to an item, and every place that reads the page straight after a change.
Six prototypes were measured, in real Chromium through the harness and in
jsdom.

- **The speed is nearly all in one place.** A repaint where nothing changed,
  median of 15, with the pieces timed apart:

  | | 5000 items, CPU slowed 4x | 1500 items, full speed |
  |---|---|---|
  | whole repaint | 33–48ms | 2.5–3.2ms |
  | counting the chips | 22–36ms | 1.5–1.7ms |
  | both rails redrawn from counts already made | 1.5–2.3ms | 0.3–0.4ms |
  | the toolbar (the favorites count inside it) | 0.8–3.7ms (0.5–2.5ms) | 0.1–0.2ms |
  | the rest of `render()` (the filtered list inside it) | 0.8–3.1ms (0.4–2.2ms) | 0.1–0.2ms |

  So with the counts and the list cached, a quiet repaint comes to ~2–4ms at
  5000 items and 4x (~0.5–0.8ms at 1500). Moving the rail and toolbar onto
  signals of their own would take it to ~0.5–1ms.
- **That last part was where the risk was.** Found by the inventories:
  - the rail and toolbar read things that aren't in `state`. The jobs and
    diagnostics dots read "seen" marks kept in the browser's storage, the
    rows button reads view.js's choice for the session, and the rail reads
    the clusters cache. Each would have to become a signal, or those
    buttons and dots stop updating;
  - two places read the page straight after a change, and a redraw that came
    a moment later would break them: the rail toggle's scroll fix
    ([filters.js:652-659](../public/filters.js#L652-L659)), and the
    saved-filters menu moving under its arrow (filterconfigs.js), which a
    test pins;
  - the toolbar's error boundary retries on the next `renderToolbar` call,
    and the bench's repaints stop reaching the surfaces;
  - Preact's wiring for signals adds another 1.1kB.

  Measured in jsdom, the move itself works: a component that reads `state.x`
  through a getter redraws when `state.x` is written, five writes in a row
  make one redraw, and routing Preact's redraw queue through a flush the code
  can call makes a redraw land at once. The move is now in Stage 5.
- **Signals can't be switched on in `state.js`.** The boards, welcome, account
  and admin pages reach it through utils.js, and the boards and admin pages
  also through the board editor's diagnostics. Importing only `signal` from
  the vendored `preact.mjs` cost a page 6.2kB brotli, nearly the whole file.
  That would be boards +16%, welcome +32% and account +76%. Today the build
  drops `state.js` from those pages only because it does nothing at load.
- **Nor in the shared vendored file.** A page that uses only `render` and
  `html` from it (the admin page) went 4.95 → 6.32kB with plain signals added,
  and to 7.52kB with Preact's wiring for them. The whole file went from
  5.45kB to 6.87kB and 7.93kB.
- **Items have no single door.** Outside the poll's merge, 13 places in 9
  files write items. Four of the 14 writers don't repaint straight after: the
  poll's merge (its repaint waits for the token fetch), bulk reprocess, bulk
  add-to-crate, and the crate checkbox. The crate checkbox usually doesn't
  repaint at all, so the comment in `render()` that every data change
  repaints at once is wrong. Every one needs the announcement, or the next
  repaint shows old counts where today it recounts.
- **The selection was edited in place in five places,** and the chip toggle
  also edited the sets inside an entry.
- **The clusters cache can't become a `computed`** (above). The first draft
  said it would, and that this retired the ordering rule at the top of
  `render()`.
- **A quiet tick's server wait isn't page work.** At 5000 items and 4x, the
  quiet poll's answer took 18.5–22.3ms to arrive, and the page's own share
  was ~3.5ms (the body 1.1–1.5ms, parsing 0.2ms, the merge 1.8–2.0ms; 35kB,
  mostly the board's 5000 ids). At 1500 items the wait was 12.7–16.1ms and
  the page's share ~0.5ms. The bench's tick row had added them together.
- **Holds:**
  - Reading `state` through the getters costs nothing in the counting,
    which reads the fields once (23.5ms plain, 23.0 through the getters, 23.3
    inside a `computed`). A cached read is 0ms.
  - `Object.assign(state, …)` and spreading `state` work with the getters,
    and a `computed` re-runs only when something it read changed.
  - Nothing reads the filtered list and edits it.

**Built (2026-09-26), uncommitted.**

- **What changed:**
  - `scripts/vendor-preact.mjs` also writes `public/vendor/signals.mjs`
    (@preact/signals-core 1.14.4: `signal` and `computed`), 4.6kB and 1.6kB
    brotli with its license line, and copies `signals-core.LICENSE` beside it.
    `preact.mjs` came out byte for byte the same.
  - `public/state-signals.js` (new) holds the loop that makes each `state`
    field a signal, plus `itemsVersion` and `itemsChanged()`.
  - `state.js` declares `boardIngestError`. utils.js lost `isAdmin()`, and
    with it its import of `state.js`.
  - filters.js:
    - the chip counts, the filtered list and the favorites count are
      `computed`, and `taggedFiltered` and `favoritesInContext` read them;
    - `filterItems()` is the fresh list (the old body of `taggedFiltered`)
      and reads its six state fields once. `computeFacetStats` reads its two
      per-item fields once;
    - the chip toggle copies its entry into a new map, and `renderFacets`
      reads the cached counts;
    - `checkCached()` is the tests' check.
  - patterns.js: the grouping is a signal, published at every refresh and
    where the meaning grouping's answer lands, and `clusterSet` and
    `clusterValues` read it. The three places that dropped the lens's chip in
    place share one helper that replaces the selection.
  - app.js: boot's uploader filter replaces the selection, and `render()` runs
    the check when the flag is set. Its comment that every data change repaints
    at once now says which ones don't.
  - `itemsChanged()` at the 14 writers:
    - data.js: the merge, the requeue mirror, the drain;
    - lightbox.js: its heart, its file removal;
    - crates.js: three;
    - one each in grid.js (the heart), rows.js (file removal), tag-editor.js,
      bulk.js, upload.js and connector-browse.js.
  - test/browser/harness.js sets the check's flag on every page it opens.
    test/jsdom-stub.js gained no-op `ResizeObserver` and `scrollIntoView`,
    and `Image` among its globals. The lightbox's setup, preloads and close
    need them in jsdom.
- **Found while building:**
  - A unit test (pattern-clusters.test.js) reads the meaning grouping straight
    after the server's answer lands, with no repaint between. Published only
    at a refresh, the grouping was still empty there. It's now also published
    where the answer lands.
  - My edits for Stage 2's second pass had dropped this section's
    `### Stage 3` heading. Restored.
  - Docker Desktop's engine stopped partway through the removal checks, and
    the test database went with it. Two browser checks failed on "connect
    ECONNREFUSED" before reaching any code. Docker was started again, the
    containers came back on their own restart policy with nothing
    re-created, and those two checks were re-run.
  - A tick's answer can repeat rows. The server hands its cursor back 2s
    early (server.js, the `/api/items` route), so a row stamped in the last
    2s comes again, the merge announces it, and the next repaint recounts.
    That's right by the rule, and it stops 2s after the last change.
    Measured on a board seeded seconds before: six ticks fired back to back
    carried 207, 43, 37, 33, 28 and 23 rows. On a settled board of 5000
    items, only the first tick after loading carried rows, and the next five
    kept the same cached list.
- **Tests:**
  - test/cached-counts.test.js (new, 16) drives each writer through its own
    code path in jsdom, the crate-pop.test.js way, then runs
    `checkCached()`:
    - the merge: a quiet one (the same cached list, nothing counted), one
      that brings an item, one that retags an item;
    - the requeue mirror, an upload's rows and the drain;
    - the chip toggles, each making a new selection;
    - the clusters lens turned off, and a step to more groups;
    - the crate checkbox while filtering by that crate;
    - a card's heart and the lightbox's heart;
    - removing a file in the lightbox and in the rows view;
    - a tag edit and a connector add.

    The ones behind buttons click their real controls, with the real
    index.html and real modules. The server is a stubbed fetch.
  - ui-updates.test.js has a new guard: a heart on a card moves the favorites
    count at once, in the real app with the check on. It passes on the old
    frontend too.
  - The browser suite runs with the check on in every page.
  - Two writers have no test that can fail: deleting a crate and a new
    crate. The counts and the list read crate membership only for the crate
    being filtered by, and neither can change that in view today:
    - a new crate isn't the one being filtered by;
    - deleting that crate clears the filter, which recounts anyway.

    Their calls stay, so a count that reads membership more widely later
    can't go stale. (The build listed the bulk bar's crate add here too,
    reasoning that it skips items already in the crate. That was wrong: the
    second pass found that cards picked before a crate filter stay picked
    under it. See below.)
- **Removal checks** (every file restored byte for byte, checked by hash):
  - Each writer's call removed: its test fails on its own line.
    - The merge: in the Stage 1 poll test, the new item's card never
      reaches the grid; in the unit tests, the list lacks the new item or
      keeps the retagged one.
    - An upload's rows: the check fails, "the cached chip counts differ".
    - A card's heart: the unit test, and in the browser guard the count
      stays "0".
    - Likewise the requeue mirror, the drain, the lightbox's heart, both
      file removals, the crate checkbox and a connector add.
  - The tag editor's own call: its test still passes, as expected, because
    the requeue mirror right after it announces too. With both removed, it
    fails.
  - The chip toggle editing in place again: the unit test fails on "a new
    map". In the real browser the Stage 1 chip test fails on its page errors
    alone, with "checkCached: the cached filtered list differs from a fresh
    one". That's the check catching a miss nothing else on the page showed.
  - The clusters lens dropping its chip in place: both its tests fail.
  - A refresh that doesn't publish the grouping: four of
    pattern-clusters.test.js's tests fail, and the D10 browser guard times
    out waiting for the cluster row.
  - A quiet merge that announces anyway: the quiet-tick test fails (a new
    list, counted again).
  - Deleting a crate, a new crate: nothing fails, as found above. The bulk
    bar's: nothing failed either, for want of a test. The second pass adds
    one.
- **Runs:** the unit suite 1962/1962; the whole browser suite 77/77 on the
  built frontend; `npm test` 2039/2039 green in 105s, lint included.
- **Bench**, a repaint where nothing changed, from the end of Stage 2 (its
  second pass) to now. Two clean runs at 5000 items: the first run of the
  closing script overlapped Docker's containers starting back up, so it
  isn't used.

  | | 1500 items, full speed | 5000 items, CPU slowed 4x |
  |---|---|---|
  | whole repaint | 2.5 → 0.7ms | 32.6–34.3 → 3.6–4.5ms |
  | the page re-laid out mid-repaint | 0.1 → 0–0.1ms | 0.7–0.8 → 0.4–0.6ms |
  | drawing the toolbar | 0.1–0.2 → 0.1ms | 1.0–3.1 → 0.4–0.6ms |
  | a fresh count of the chips (what a real change pays) | 1.5–1.9 → 1.7–2.2ms | 23.9–26.5 → 23.9–31.9ms |

  Across the arc, at 5000 items and 4x, a repaint that changes nothing went
  from 48.7–50.6ms to 3.6–4.5ms. A fresh count still costs what it did, and
  a change that really moved something still pays it once, which is correct.
  - The quiet poll tick, now in its parts, at 5000 items and 4x: the wait for
    the server 22.7–24.7ms, the page's work on the answer 3.6–8.9ms, the
    repaint 7.2–8.9ms. At 1500 items: 15ms, 0.4ms and 1.3ms.
  - A repaint straight after that wait costs more than the bench's
    back-to-back ones. Measured on its own with the cached list unchanged,
    at 5000 items and 4x: 3.3–4.5ms after a fetch, against 2.1–3.0ms back to
    back.
- **Payloads** (built, brotli):
  - the board page 57.5 → 59.4kB: the signals file is 1.6kB with its license
    line, and the stage's own code ~0.3kB;
  - the admin page 57.4 → 57.3kB. Not from `isAdmin()` going: nothing called
    it, so the build had already left it out. The 69 bytes are the
    minifier's names shuffling (measured in the second pass, old build
    against new);
  - the boards, account and welcome pages unchanged, and none of them
    carries signals or `state.js`.
- **Owed by eye:** nothing new. The rail and the toolbar redraw exactly when
  they did. Still owed from Stage 2: the jobs chip's tooltip, and ignite and
  cool.

**Second pass (2026-09-26).** Three read-only reviewers, none shown the
plan, one area each: what the cached values read; every writer of items and
the state conversion; the tests and the harness. One compared old against
new by running 130 random sequences of 250–300 steps through the app's own
write paths on the pre-stage copy and on the new code, diffing the list, the
favorites count and the rail after each step: identical throughout. My own
share: the vendor script rebuilt both files byte for byte (and the pre-stage
script the same `preact.mjs`); the built pages compared old against new
(signals in the board page only, the other four pages' code unchanged); the
plan's claims and links.

- **Found and fixed:**
  - **The bulk bar's crate add announced only after its last answer**
    (bulk.js). Each item joins the crate as its own answer lands, and the
    announcement came after all of them. In between, a poll's repaint, the
    grid's next batch, the rows view and the lightbox read the list from
    before the add: with that crate as the filter, the items already in
    stayed hidden until the last answer, where the old code showed each at
    the next repaint. The build had listed this writer as unobservable,
    reasoning that the bulk bar skips items already in the crate. The
    selection is pruned against the board, not the filtered list, so cards
    picked before a crate filter stay picked under it, and that's how items
    outside the crate get added while it's the filter. All three reviewers
    found it; two measured it (old: [1] → [1,2] → [1,2,3]; new: [1] → [1] →
    [1,2,3]). Now announced per answer, with a unit test that holds the
    second answer back and reads the list between the two.
  - **Nothing proved the check could fail.** Every "the counts follow" claim
    in cached-counts.test.js, and the whole browser net, rests on
    `checkCached()`. Emptying its body left 16/16 green, and so did deleting
    any one of its three comparisons. Three tests now make it fail, one per
    comparison: a selection edited in place, a heart written without an
    announcement, a retag written without one.
  - **The quiet-tick test drove `reconcile()` alone.** A real tick (data.js
    `pollTick`) also stores a new cursor and a new work object every time,
    and fetches the board's totals. A cached value that read any of those
    would recount on every tick, and the test wouldn't have known
    (measured: `filterItems` reading `state.work` left it green). It now
    drives `refreshItemsOnce()` through a stubbed answer and writes the
    totals as `refreshTokens` does.
  - **The browser net had holes.** The check throws into `page.errors`, and
    a test fails only if it reads `page.errors` afterwards. card-faces opens
    a board and never reads it; lightbox-layers reads it only in its last
    test; the new heart guard's cleanup click comes after its read. The
    harness now reads every page's errors at close and fails the file on
    any the check threw, so a page no test looked at still counts.
  - **The favorites count with a filter on was never tested**: a count over
    all items passed both suites. The card-heart test now turns on a chip
    that leaves the hearted card out, and reads 0.
  - The plan's admin-page line (above) was wrong: `isAdmin()` was never in
    that bundle.
  - Smaller: a test name said "then another excluded" and excluded the same
    chip; five tests' teardown wasn't in `finally`, so one failure would
    cascade; the bench's `taggedFilteredMs` and `renderFacetsBothMs` rows
    time cached reads since this stage, and now say so; its quiet tick
    reports the rows each tick carried, so a run says whether its ticks
    were quiet.
- **Checked and fine**, the reviewers' lists re-read in the code: every
  input of the cached values is a `state` field written whole, an item field
  followed by `itemsChanged()`, or the published grouping; no module
  variable, storage, DOM or clock. All 14 writers announce straight after
  their write, with no read between. Nothing edits the cached list, holds it
  by identity or needs a fresh array (the lightbox's copy is only
  reassigned). Nothing treats `state` as a plain object in a way the getters
  break; every written field is declared; the fields are signals before any
  module can read a cached value, in dev and in the production bundle, which
  holds one copy of the signals core. The grouping is published after every
  change to the cluster result (a pending answer, a stale one, level steps
  and lens switches while pending, all run). `checkCached` has no false
  alarm and no side effect; its deep compare ignores Map and Set order,
  which nothing in the app changes in place. jsdom-stub's additions change
  no other test's result (78/78, identical per test). Known and left: toast
  timers keep the test file's process alive ~4.5s after its last test, which
  isn't a hang.
- **The reviewers' "could not settle", settled:**
  - the counts read the grouping only through `clusterSet`. With it reading
    the live result instead of the signal, the D10 browser guard fails in
    Chromium on the check's own error, so the suite covers that too;
  - getter reads outside the caches (a card's 8, a row's one per file, a
    chip's per row) cost what the close look measured per read, 70–90ns at
    4x: a 60-card batch reads ~500 times, ~0.04ms. Not re-measured;
  - a tick that brings a row pays a fresh count plus the getters' ~2ms at
    5000 items and 4x, as the close look recorded.
- **Older bugs found, not fixed** (they predate the arc, and the old code
  does the same; the user's call):
  - a connector add can put the same item on the board twice:
    connector-browse.js adds every returned row without the "already on the
    board" check upload.js has for the same race with the poll. Two objects
    for one id, the merge updates only one, and the other's spinner card
    stays in the lane with the 4s poll running until a reload;
  - a facet whose key is `constructor` breaks the page at its first chip
    click: filters.js looks the key up on a plain object and finds
    `Object.prototype.constructor`. The server reserves only `~` keys;
  - a re-carve after a retag can hand a selected cluster chip to a different
    group: cluster names are positions, and only a level step or the lens
    turning off drops the chip.
- **Removal checks** (every file restored byte for byte, checked by hash):
  - the bulk bar's per-answer announcement moved back after the last answer,
    or removed: its test fails at "the first answer is in";
  - `checkCached` emptied: all three failing-check tests fail. Each
    comparison deleted alone: its test fails;
  - `filterItems` reading `state.work`: the quiet-tick test fails, "a
    recount";
  - the favorites count over all items: the heart test fails, 1 where 0;
  - `clusterSet` reading the live result: the D10 guard fails on the
    check's error, in Chromium;
  - the chip toggle in place again, with its test's `page.errors` read
    deleted: the file fails at close, on the harness's net.
- **Runs:** the built frontend's browser suite 77/77 in 42s; `npm test`
  2043/2043 in 96s (the four new unit tests; lint included). The bench at
  1500 items reads as before (a repaint where nothing changed 0.7ms; a quiet
  tick 17.9ms of server wait, 0.5ms of page work, 1.3ms of repaint), and its
  new column shows the ticks: the first carried 218 rows (the 2s-early
  cursor, on a board seeded seconds before), the other seven none. Not
  re-run at 5000: nothing on the repaint path changed.

### Stage 4 — cards

Rewritten by its close look (below). The first draft listed what a card keeps
in the DOM and missed the faces, what a change costs today, and what a plain
component list would cost on a scrolled-deep board.

- Cards, rows, tiles and the progress lane become components, keyed by item
  id (and by upload id for a placeholder), drawn into `#grid` from `render()`
  as today (D4). A card draws from props the grid hands it: the fields it
  shows (status, hearts and whether you hearted it, name, size, kind, whether
  the face is a drawn one, label, file count, tags, whether it needs tags,
  whether it's in flight, whether it's selected). Bulk mode stays the body's
  class, which the stylesheet reads to hide the chrome: as a prop it redrew
  every card on the first selection and the last (the second pass). It
  redraws only when one of those changed (`shouldComponentUpdate`, a shallow
  compare), so a quiet repaint costs nothing at any scroll depth, and a
  change redraws one card. This isn't a hand-typed cache key like `cardSig`:
  a card can only draw what it's handed, so a field that isn't a prop can't
  be drawn stale. Render reads props alone; the item object rides along for
  the handlers (the lightbox, the pops, the API calls). Items stay the same
  objects (D5), and nothing new is written on them.
- The faces (kinds.js) become components too, one per kind plus its progress
  face. They were built by hand and wrote on the card (`loaded`, and
  `remove()` on a broken picture), which a component that owns the card
  would erase or fight. A face that fails to load becomes state: drawn once
  as nothing, the masonry re-run, no second request. kinds.js may import
  Preact: only the board page reaches it (checked).
- What a card held in the DOM becomes state: hover (the chrome draws while
  the pointer is over it, as today), the pin (a menu opened from the card
  keeps the chrome; the pops set it on the component through a small
  registry by element, and Stage 5 makes it a signal), `loaded`, `onstage` (the
  shared observer, for in-flight cards only), a broken face, the heart's
  fetched names.
- Bulk selection is a whole-value write: bulk.js replaces `state.bulkSelected`
  and repaints, and stops editing card elements. A card reads `selected` from
  its props.
- The masonry math (`layoutGrid`) stays as it is and runs after each draw,
  clamp included. The lane's budget reads the same width it does (they
  disagreed by the grid's padding, so the lane could wrap a row early).
- The scroll sentinel stays where it is: an append raises the limit and
  redraws. Batches of 60 (grid) and 30 (rows) stay. `scrollToCard` raises the
  limit, draws, lays out, scrolls.
- rows.js: rows persist, so the strip-scroll bookkeeping (`scroll-keep`)
  goes. "Aim at the first match" stays where a rebuilt strip was aimed: a
  new row, a strip that appears, a filter change that moves the row's dim
  pattern (the second pass narrowed it from every filter change). Tiles are
  components with the same hover chrome and pin, keyed by file id.
- Deleted: `cardCache`, `cardSig`, `rowCache`, `rowSig`, `progressCache`, the
  lane's cached tail, `releaseCard`, `dropAllCards`, `dropAllRows`, the
  same-children checks, `cardFor` (tests draw the grid instead) and
  `teardownCardHover`.
- dropdown.js's hold for a menu whose button was replaced stays: five menus
  outside the cards can still lose their button (the close look's list). Its
  comment names them instead of the cards.
- The vendored Preact also exports `Component`: the class form is what
  carries `shouldComponentUpdate`, and it's already inside the bundle.
- Tests:
  - browser, real triggers, each failing today and fixed by the stage: a
    heart click keeps the card as the same element, with its buttons; a poll
    that retags a card keeps its open tag pop; a poll that changes one card
    keeps keyboard focus on another card's select button; a failing
    thumbnail is asked for once, not once per tick;
  - stays true: guard 7 (cards stay in place across a poll), card faces,
    upload, the lightbox, events;
  - unit, in jsdom: a card draws its props and redraws in place when they
    change; the pin keeps the chrome while a menu is open and drops it
    after; bulk selection as a whole-value write; a broken face draws
    nothing, once; a row's tiles from its files, dim where they don't match;
  - every one with its fix removed (the pre-stage frontend served through
    `FRONTEND_DIR`, or the old files put back), to watch it fail;
  - the bench gains first paint, append and one-card-changed rows.

**Close look (2026-09-26)**: what the first draft had wrong, before a line was
built. Two read-only agents made inventories: everything outside grid.js and
rows.js that reads or writes a card element, and everything a card, row or
tile holds that isn't derivable from its item. Measured in real Chromium
through the harness, with a plain Preact card list and a memoized one drawn
in the page beside today's grid.

- **What's wrong today is bigger than the draft said.** The draft credited
  the grid as already done right because a quiet repaint leaves it alone,
  and that part holds (0.2ms at 60 cards). But any single card change
  re-inserts every mounted card (`replaceChildren`), and that re-insert:
  - drops keyboard focus from any card's select button when a *different*
    card changes (measured; a quiet repaint keeps it);
  - resets every rows-strip's scroll to 0 (re-inserting an element resets
    its scroll, measured on the DOM; rows mode re-inserts all rows whenever
    anything changed, and `scroll-keep` covers only the rebuilt ones);
  - blinks a hearted card's own buttons away, since the card is rebuilt
    under the pointer (measured: gone right after the click at full speed,
    back after Chromium's next synthetic mouse move);
  - re-asks for a failing thumbnail on every repaint, forever: the error
    handler removes the card, the cache sees a detached element and rebuilds
    it (5 requests in 5 repaints; one per 4s tick while work runs), and rows
    mode is left with a row that has no card;
  - never redraws a progress card's face (keyed with no signature).
- **A plain component list would be a regression at depth.** Every repaint
  would re-diff every mounted card. The fix: cards draw from props and skip
  the redraw when none changed. Measured, the grid's share of a repaint:

  | | today | plain Preact list | props + skip when unchanged |
  |---|---|---|---|
  | quiet, 60 cards mounted, 4x | 0.2ms | 2.0ms | 0.4ms |
  | quiet, 600 mounted, 4x | 1.1ms | 17.8ms | 0.6ms |
  | quiet, 3000 mounted, 4x | 21.5ms | 90.4ms | 2.8ms |
  | one card changed, 60 mounted, 4x | 14.2ms (2.5 at full speed) | 2.1ms | 0.3ms |
  | one card changed, 600 mounted, full speed | 29ms | 2.6ms | 0.1ms |
  | one card changed, 3000 mounted, 4x | 774ms | 98.7ms | 3.0ms |
  | the first 60 drawn, 4x | 31ms (with the masonry) | 25.8ms | 30.7ms |
  | 600 drawn, 4x | 251ms for 540 (with the masonry) | 75ms | 79ms |

  The prototype cards carried the same elements as today's (face, select
  button, heart, chrome on hover). Today's whole repaint at 60 cards is
  3.9ms at 4x, so the plain list would add half of that to every tick, and
  a scrolled board far more.
- **The faces weren't in the draft**, and they're half the card's DOM: built
  by kinds.js, writing `loaded` on the card and removing it on error.
- **Four things set classes on cards from outside**, which the card's owner
  would erase on its next redraw (the D10 lesson): `selected` (bulk.js edits
  card elements directly, and edits `state.bulkSelected` in place at six
  sites), `loaded` (kinds.js), `pop-open` (the pin, used by the crate, tag
  and verbs pops) and `onstage` (the spinner observer). Each becomes state.
- **The dropdown hold stays.** After cards persist, five menus can still lose
  their button, none of them cards: the lightbox panel's Retag menu (the
  panel repaints when the reasoning fetch lands, and on arrow keys), the
  admin Boards access menu (a 1.5s deferred table re-render after a retag),
  the toolbar's Crates menu (its button unmounts if another member deletes
  the last crate), and the mapping pane's identity and add-field menus (an
  async catalog fetch redraws the pane).
- **rows.js's scroll bookkeeping exists only because rows are rebuilt.** With
  persistent rows a keyed insert above a scrolled strip keeps its position
  (measured); only moving the scrolled row itself resets it, which is a
  sort change.
- **Smaller:** the sentinel isn't a component; `laneBudget` and `layoutGrid`
  read different widths (the lane wraps a row early near a column
  boundary); `cardFor` going re-points three unit tests (crate-pop's tag
  pop, cached-counts' heart and rows removal); the browser tests' selectors
  all stay; fields a card shows that `cardSig` never carried (`h`, `kind`,
  `generated`, `symbol`, a file's size and name in a tile, `state.facets`
  for the dotted outline) go stale today until something else rebuilds the
  card, and are props now.
- **Holds:** keyed by item id; batches of 60 and 30; the masonry after each
  draw; the deletions; D4 (the grid draws inside `render()`); only the board
  page reaches kinds.js, grid.js, rows.js, bulk.js and crates.js, so none of
  this reaches another page.

**Built (2026-09-26), uncommitted.**

- **What changed:**
  - `scripts/vendor-preact.mjs` exports `Component` too. `preact.mjs` is the
    same size (14.5kB, 5.6kB brotli).
  - kinds.js: the faces are components. Each kind has a `Face` and a
    `ProgressFace`; documents, audio and connector entities are `instant`
    (their card is loaded at once). A face takes the card's props plus
    `loaded`, `overlay` (the select button and the heart, drawn inside its
    media region), `onLoaded`, `onBroken` and `onLayout`; a picture already
    in the cache reports loaded at mount. `previewUrl` is unchanged.
  - grid.js: `cardProps(item)` is the projection. `Card` is a class whose
    `shouldComponentUpdate` compares props and state value by value; its
    state is hover, pinned, loaded, broken and onstage. `HeartControl`,
    `TagChip`, `CardActions` (with `Act`, the button), `ProgressCard`,
    `LaneMore`, `Lane`, `EmptyNote` and `Grid` are components. `renderGrid`
    draws the tree; `appendMoreCards` and `scrollToCard` raise the limit and
    draw. The pin is a registry of the mounted cards' setters
    (`pinWhileOpen` takes a registry and a selector, for the tiles); the
    spinner observer keeps a setter per watched element. `layoutGrid` is as
    it was, with `gridBox()` shared with the lane's budget.
  - A draw is skipped when none of its inputs moved, the stamp in `draw()`:
    the cached list, the limit, the lane's ids and budget, the viewer, the
    selection, the facets and the items version. Found by the bench, below.
  - rows.js: `Row` (a class: the card's props compared value by value, the
    rest by identity; the first-match scroll on mount and on a filter
    change), `Tile` (hover and pin state, a registry of its own), `Rows`;
    `renderRows` draws with the same stamp plus the selection and the
    mapping. (Not quite: it left out the lane's budget, until the second
    pass.)
  - Deleted: `cardCache`, `cardSig`, `cardEl`, `cardFor`, `progressCache`,
    the lane's cached tail, `releaseCard`, `dropAllCards`, the prune loop
    and the same-children check in grid.js; `rowCache`, `rowSig`, `rowEl`,
    `dropAllRows`, `scrollFlaggedStrips` and the scroll-keep and scroll-match
    flags in rows.js; `teardownCardHover` and `teardownTileHover`; utils.js's
    `actionBtn` (the components draw their buttons).
  - bulk.js: `select(next)` replaces the set, updates the bar and repaints;
    `toggleBulkSelect(item)` takes no element; the prune listener replaces
    the set when it drops ids; the two bulk actions rely on `clearBulk`'s
    repaint. Nothing in it touches a card element.
  - app.js: a mode flip draws the other tree, with nothing to drop first.
    (It didn't: a flip back drew nothing, since each view kept its own key.
    The second pass gave both one.)
  - dropdown.js's hold names the menus that can still lose their button.
    Three comments that named `cardSig` (crates.js, data.js,
    delta-reconcile.test.js) say what's true now.
  - Tests: test/cards.test.js (new, 10). crate-pop.test.js and
    cached-counts.test.js draw the grid instead of calling `cardFor`, and
    wait a tick after a pointer event. ui-updates.test.js gains the four
    "Fixed in Stage 4" tests, and guard 7 checks that each surviving element
    still shows its item. test/jsdom-stub.js is unchanged.
  - The bench gains the cards block, and announces its one-card change the
    way every writer does.
- **Found while building:**
  - **A memoized list still walks.** With every card skipping its redraw, a
    quiet draw at 600 mounted cards measured 2.5ms at full speed and 11.6ms
    at 4x, against the old same-check's 0.4 and 1.6: Preact still builds and
    matches 600 keyed children, and the grid projects 600 items' props. So
    the draw itself is skipped when none of its inputs moved. After that:
    0ms at both sizes, and the whole quiet repaint reads as it did before the
    stage.
  - A card's own state lands a tick later (Preact batches state), where the
    old builder appended chrome on the spot. Invisible in the browser; the
    unit tests wait a tick.
  - jsdom answers `:hover` for the last element clicked (nwsapi), so the pin
    test clicks the page first; and it answers "" for the grid's padding, so
    `gridBox()` guards the NaN.
  - The old frontend passed the retag test once: the pop survived under a
    detached chip by the dropdown's hold. The test also checks that the
    pop's button is the chip on the card.
  - The failing-thumbnail test's item outlived its page, and every page
    after it got a real 404 the tests count as a failed request; it deletes
    its item in a `finally`. On the old frontend that item is rebuilt every
    tick, first in the grid, so the old-frontend removal check runs the new
    tests and the older guards in separate pages.
  - Guard 7 held with the keys removed: the elements survive a poll unkeyed,
    one item along. It now checks the item each element shows.
  - An open tag pop keeps the list it opened with when the poll retags its
    card. Before, the card's rebuild opened a new pop under the pointer, by
    luck of a synthetic mouse move. Menus are snapshots, as D9 says.
  - A mode flip redraws the lane (the two trees don't share elements), so an
    upload placeholder's picture is set again from its local URL. Rare, and
    not measured.
  - The bench's "first batch" includes unmounting the previous 60 cards (its
    empty step), which the old code did by clearing a map: 5.8 → 7.8ms at
    1500, 39 → 48ms at 5000/4x. An append of 60, a mount and a layout, reads
    the same: 8.1 → 8.7 and 60.9 → 58.
- **Tests:**
  - test/cards.test.js: a card draws its item (picture, size, ratio, select
    button, no chrome yet, the needs-tags outline); an in-flight item's
    spinner; the pointer brings and takes the chrome; a repaint that changed
    nothing redraws no card (a render spy) and one that changed an item
    redraws that card in place; a heart click redraws in place and keeps the
    chrome; a pinned menu keeps the chrome and releases it; bulk selection
    as a whole-value write, hiding the chrome; a broken picture draws
    nothing, once; the lane's placeholders and tail; a row's tiles, dim
    where they don't match, with the face marked, kept across a repaint.
  - ui-updates.test.js, real triggers: a heart click keeps the card as the
    same element with its buttons; a poll that retags a card keeps its open
    tag pop, on the chip; a poll that brings an item keeps keyboard focus on
    a card's select button; a thumbnail that fails is asked for once.
  - Stays true: guard 7 (now with the item check), card faces, upload, the
    lightbox, events, and the Stage 3 heart guard.
- **Removal checks** (every file restored byte for byte, checked by hash):
  - a card redrawing on every repaint (`shouldComponentUpdate` true): the
    render-spy test fails, drawn [1, 2, 3] where [];
  - the pin never registered, or not keeping the chrome: the pin test fails
    on its two lines;
  - the set edited in place: the bulk test fails, "a new set";
  - a broken picture ignored: the unit test fails on "gone", and the browser
    test on its card count (asked for once, but the card stays);
  - the keys removed: guard 7 fails, 0 of 3 showing their item;
  - the pre-stage frontend under the four new tests: all four fail on their
    own line (the element replaced; the pop's button detached; focus on the
    page; three requests). Under the two older guards: both pass.
- **Runs:** the browser suite 81/81 on the built frontend (65s); `npm test`
  2057/2057 (97s; 1976 unit).
- **Bench**, before the stage (the pre-stage frontend served) → after, the
  new cards block plus the rows from before:

  | | 1500 items, full speed | 5000 items, CPU slowed 4x |
  |---|---|---|
  | a quiet repaint, 60 cards mounted | 0.7–0.8 → 0.7–0.8ms | 3.5–4.2 → 3.4–3.5ms |
  | one card changed, 60 mounted | 2.6 → 0.6ms | 14.7 → 2.8ms |
  | one card changed, 600 mounted | 24.5 → 2.8ms | 152 → 14.6ms |
  | a quiet draw, 600 mounted | 0.4 → 0ms | 1.6 → 0ms |
  | an append of 60 | 8.1 → 8.7ms | 60.9 → 58ms |
  | the first batch, after unmounting the last | 5.8 → 7.8ms | 39 → 48ms |
  | a quiet tick: wait / page work / repaint | 15.5 / 0.5 / 1.6 → 13.6 / 0.4 / 1.1 | 23.7 / 3.4 / 6.4 → 23.2 / 3.8 / 6.3 |

  What changed hands: a change to one card no longer re-inserts every
  mounted card, and a quiet repaint doesn't visit them at all.
- **Payloads** (built, brotli): the board page 59.4 → 60.4kB (the
  components; Preact's class support was already inside). The admin page
  57.3kB, and the boards, account and welcome pages, unchanged.
- **Owed by eye:** rows mode in the real app (a strip's scroll and the
  first-match aim; no browser test draws rows), the lane through a real
  upload (upload.test.js sees the settled card, not the placeholder's face),
  and the crate pop's re-open after a new crate on a real card (jsdom covers
  it). Still from Stage 2: the jobs chip's tooltip, and ignite and cool.

**Second pass (2026-09-26).** Three read-only reviewers, none shown the
plan: grid.js and kinds.js, old against new; rows.js, bulk.js and app.js, old
against new; the callers, the stylesheet and index.html. Each finding re-read
in the code and confirmed in jsdom, or in Chromium against the pre-stage copy.

- **Found and fixed:**
  - **The view toggle showed the wrong view on the way back.** Each view
    skipped its draw when nothing it reads had moved, and kept its own key,
    which a flip never changes. After grid, rows, grid the page still held
    the rows (Chromium, three clicks: old rows, cards, rows; new rows, rows,
    rows), and a view came back at its scrolled-deep batch. The old code
    reset the other view's key on every render, which went with the caches.
    Both views now go by one key for `#grid` (grid.js `freshKey`).
  - **Bulk mode was a prop on every card,** so the first selection and the
    last redrew them all. The stylesheet already hides the chrome in bulk
    mode (`body.bulk-mode`), as before the stage, so the prop is gone.
  - **A card's loaded and broken outlived its picture.** A card whose
    picture failed stayed hidden through a new one (on a live chart board,
    the chart drawn again under a new name), and a loaded card's new picture
    drew over a blank face (Chromium drops a lazy image's old picture when
    its src changes). A new name starts both over; a document's band is
    keyed by its file.
  - **A tile's menu could pin another row's tile.** In classify mode one
    file sits under every entity that claimed it, and the registry was keyed
    by file id. Pins are keyed by element now, cards and tiles in one weak
    map.
  - **Strips were re-aimed on every filter change,** losing a hand-scrolled
    position to a sort or the favorites. Now as the old code: a new row, a
    strip that appears, a filter change that moves the row's dim pattern.
  - **A file sent back to work showed its spinner a poll late** when its
    entity was already in work (a file's status is written in place). The
    row compares a per-file "in work" string.
  - **The rows' lane ignored a resize.** One `laneStamp` serves both views.
  - Smaller: a test's stand-in card inside `#grid`, moved out; stale comments
    in styles.css, events.test.js and app.js; the two Built claims above,
    marked.
- **Checked and fine:** the markup and every selector that targets it; every
  importer; every writer of a field a card shows announces it; a tile's
  release not re-reading `:hover` (Chromium doesn't re-hover a still pointer
  when a menu vanishes, so the tile agrees with the pointer's last event).
- **Settled, left as they are:** a flip redraws the upload lane; a card that
  keeps its element eases its state changes (the needs-tags inset, the
  in-flight dim) where a rebuilt one snapped; a picture the page already
  loaded fades in again when a scroll or the lightbox's return draws its
  card (it appeared at once before); a thumbnail that fails because the
  server blinked stays hidden until its picture changes or a reload (the old
  code asked on every repaint, the bug the stage fixed; a retry would need a
  policy, the user's call).
- **Tests:** cards.test.js gains seven (the flip, a new picture, a document's
  new picture, a file's spinner, the shared-file pin, the strip's aim, the
  lane in both views); its bulk test spies on the redraws and reads the
  page's own stylesheet; each test starts from freshly mounted cards.
  ui-updates.test.js gains the flip guard, on a board of its own.
- **Removal checks** (files restored by hash): each fix taken out, its test
  fails on its own line; the pre-stage frontend passes the flip guard.
- **Runs:** unit 1983/1983; the built frontend's browser suite 82/82;
  payloads unchanged.

### Stage 5 — retire `app:render`

Rewritten by its close look (below). The first draft had each surface
subscribe to its own signals, and made its case on speed; neither held.

- `render()` stays the one ordered draw, and runs inside one effect: whenever
  a signal it read changes, it runs again, at once, the way a dispatch ran
  it. The order inside it stays (the cluster refresh, the view's choice, the
  toolbar, the rail, the grid), and so does its timing, so the rail toggle's
  height read and the saved-filters menu's re-place keep working. An error
  in it is reported, not thrown back into whatever wrote the signal.
- Writers stop dispatching. A handler that writes several fields wraps them
  in one `batch()`, so they still land as one repaint, as the dispatch at
  their end made them.
- What a signal can't see becomes a whole-value write: the crates list (a
  crate added, a count moved), the alerts (one saved, one marked seen), the
  saved filters, the uploads, the boards list (a rename). The view's choice
  for the session becomes a signal. The "seen" marks keep their localStorage
  and gain a version signal the dots read. The header's "has this landed"
  set is filled before the state it guards is written.
- The other listeners: the selection prune runs at the top of `render()`,
  ahead of the cards; announce.js's check becomes an effect of its own; the
  `?item=` deep link waits for its item in an effect; the jobs modal's
  refresh is an effect while it's open. Then nothing listens to
  `app:render`, and it goes, with events.js's one-repaint-per-burst microtask
  and the header tick's `onBatch` repaint.
- The vendored signals file exports `effect` and `batch` as well.
- Not this stage: the older bugs the close look found (below).
- Tests:
  - browser, real triggers, each failing today: re-adding an item from the
    lightbox to the crate the board is filtered on brings its card back at
    once; "Find similar by meaning" takes a typed search's spinner down at
    once;
  - stays true: the rail toggle holds the page's scroll (the repaint is
    still synchronous); a crate made from a card's crate menu shows the
    toolbar's Crates button at once (a whole-value write);
  - unit: announce.js's tests drive it by writing state, not by dispatching;
    crate-pop.test.js checks the delete replaces the crates list;
  - each with its fix removed, and the pre-stage frontend under the new
    browser tests.

**Close look (2026-09-26)**: what the first draft had wrong, before a line was
built. One read-only agent listed every input the surfaces and listeners
read, every writer of each, and whether a repaint follows it.

- **The case is late repaints, not speed.** Five writes today repaint only
  on the next 4s poll or the 20s header tick, which quietly heal them:
  - "Run now" on a manual ingest schedule stamps the run after its
    repaint, so its chip waits for the next tick;
  - the job log refreshes the work it shows without repainting, so after
    Cancel queued or Clear the header's jobs chip keeps counting;
  - re-adding an item from the lightbox to the crate the board is filtered
    on repaints nothing, so its card stays gone and the counts one short;
  - "Find similar by meaning" drops a typed search's spinner flag without a
    repaint;
  - a connector bulk-add chunk that adds nothing updates the work unseen.
  Signals fix the class: a write is the repaint.
- **The dispatch at a handler's end is also a batch.** Loading a saved filter
  writes the selection, then trims it, and the view's rows choice is a
  ratchet that runs on each repaint (view.js `resolveView`). A repaint per
  write could latch it on a half-applied filter, so several writes go in one
  `batch()`.
- **`render()`'s order matters.** The cluster refresh must come first, the
  selection prune before the cards, and the rail toggle reads the page's
  height straight after its repaint. The first draft's per-surface
  subscriptions redraw later and in no set order.
- **About half of the 62 dispatches follow writes a signal can't see:**
  pushes into lists, a board's name, the view's session choice, the "seen"
  marks in localStorage. The first draft's list of these was partly stale:
  the bulk selection is a whole value since Stage 4, and the pinned card and
  tile never went through `app:render`, so they need no signal. Its bench
  and "only set a value that differs" bullets were about speed; both go.
- **The jobs modal listens to `app:render`**: its pause line and "In progress"
  are drawn only by that listener.
- **Older bugs found, not this stage's** (the user's call):
  - saving the board editor opened from Tagging consistency never reaches
    the page until a reload: that door's save handler copies nothing into
    state, where the pencil's does (toolbar.js);
  - a settled card deleted elsewhere never leaves the page: the poll drops
    only in-flight items missing from its id list;
  - a false "A job failed" toast and chime can fire while the job log shows
    that failure: a pause flip repaints between its recording the failure
    and acknowledging it;
  - "Run now" on a manual schedule doesn't start the poll, so the run's
    cards can miss the page.

**Built (2026-09-26), uncommitted.**

- **What changed:**
  - app.js draws the page in one effect: `render()` runs again whenever a
    signal it read changes, at once, and an error in it is reported, not
    thrown into the writer. The selection prune runs first in it (bulk.js
    `pruneSelection`, the listener it was). The `?item=` deep link waits for
    its item in an effect.
  - The 62 dispatches are gone. Handlers that write several fields batch
    them: clearing the filters, loading a saved one, the lane's "show the
    queue", a search's answer, the lenses, the pencil's board save, a tag
    save, a re-queue's answer, the poll's merge, the board's ingest and pause
    stamp, a bulk delete, a crate's delete and its memberships.
  - What a signal couldn't see is a whole-value write now: the crates list
    (a new crate, a count moved), the alerts (one saved, one marked seen),
    the saved filters, the uploads, the boards list (a rename). The view's
    session choice is a signal (view.js). The "seen" marks count their
    writes on `state.seenMarks`, which every read of a mark reads
    (seen-mark.js), and the header's landing set counts its landings
    (signals.js; since the second pass, one signal holding the set), so
    announce.js's effect hears both.
  - announce.js's check is an effect. The jobs modal draws its pause line,
    scheduled line and "In progress" in an effect while it's open; its load
    records the newest failure and acknowledges it in one batch (the
    refresh deeper in the pages acknowledges nothing, as before; corrected
    in the second pass).
  - events.js's one-repaint-per-burst microtask and the header tick's
    repaint are gone. The vendored signals file exports `effect` and `batch`.
  - The Tagging-consistency door's board editor lost its `onSaved`, which
    only dispatched. That door still copies nothing into the page (the older
    bug, unchanged).
- **Found while building:**
  - announce.js's ready() check reads a plain set of the signals that have
    landed. In an effect, a dot skipped before its data landed is never read
    again unless the landing itself is a change, and on a board that has
    never failed the jobs stamp stays null. The landings are counted now;
    without the count the announce tests fail from their first re-arm on.
  - The job log recorded a new failure's stamp and acknowledged it in two
    steps. With the dots read on every write, the stamp alone was a rising
    edge: a toast and a chime about the row on screen. One batch now, which
    also retires the older bug of the same shape (a pause flip landing
    between the two).
  - The crate re-add test first read its answer when the row's box ticked,
    which is on the click, before the server answers. It reads the grid when
    the lightbox hears of the rejoin now.
  - The Crates-button test passed with the crates list pushed in place: the
    card's membership lands a moment later, and that write redraws the
    toolbar anyway. It reads the button when the page asks to put the card
    in the crate now, which makes it a Stage 5 test (the pre-stage frontend
    fails it) rather than a stays-true one.
  - seen-mark.js loads on the boards and admin pages, which have no signals,
    so its count lives on `state`: a signal on the board page, a plain field
    elsewhere.
  - A rewrite of announce.test.js turned its CRLF to LF; put back, by git's
    cached size.
- **Tests:**
  - ui-updates.test.js, "Fixed in Stage 5", real triggers, each failing on
    the pre-stage frontend: re-adding an item from the lightbox to the crate
    the board is filtered on brings its card back at once; "Find similar by
    meaning" takes a typed search's spinner down at once; a crate made from
    a card's menu draws the toolbar's Crates button the moment it exists. A
    fourth board, with a crate, for the first.
  - jobs-modal.test.js: a failure that lands while the log shows it is
    acknowledged with it, no toast and no chime.
  - announce.test.js and crate-pop.test.js drive the new wiring: state
    writes, and a new crates list.
- **Removal checks** (files restored by hash):
  - the page drawn once, not in an effect: all three Stage 5 tests fail;
  - the crates list pushed in place: the Crates test fails, no button;
  - announce's check run once, not in an effect; a landing not counted; a
    mark not counted: announce.test.js fails from its re-arm case on, each;
  - the job log's stamp and acknowledgement in two steps: its test fails,
    one toast;
  - the pre-stage frontend (rebuilt by reversing the stage's edits) under the
    three Stage 5 tests: all three fail.
  - Not pinned: the draw's timing. With the lens toggle's write made late,
    the saved-filters guard held: on its board the menu's arrow doesn't
    move. Two readers need the draw synchronous, and the effect keeps it so:
    the rail toggle's height read (filters.js) and the saved-filters menu's
    re-place (filterconfigs.js).
  - Not tested on their own: the view's session choice as a signal, and the
    alerts', saved filters', uploads' and boards' whole-value writes. The
    crates list stands for them.
- **Runs:** `npm test` 2069/2069 (lint, 1984 unit, the browser suite on
  source); the built frontend's browser suite 85/85.
- **Payloads** (built, brotli): the board page 60.4kB and the admin page
  57.3kB, unchanged (`effect` and `batch` were inside signals-core's copy
  already); the boards page 38.2 → 38.4kB (seen-mark.js now reads state.js,
  which that page's bundle had dropped).
- **Owed by eye:** the late repaints no test drives: "Run now" on a manual
  ingest schedule (its chip), and Cancel queued or Clear in the job log (the
  header's jobs chip). From earlier stages: rows mode's strip scroll and
  aim, the lane through a real upload, the crate pop's re-open on a real
  card, the jobs chip's tooltip, ignite and cool.

**Second pass (2026-09-26).** The stage's diff re-read against the pre-stage
copy, and every handler that writes state checked for writes it makes one at
a time.

- **Found and fixed:**
  - **Opening Tagging consistency could toast about itself.** The dialog
    wrote the fresh stats, then their gates, then the mark that clears them.
    The dots are read on every write now, so a finding newer than the
    header's copy lit the dot between the first write and the last: "New
    tagging consistency finding" and a chime, under the reader's own click.
    The job log had the same shape and got a batch; this dialog's modules
    load on the boards and admin pages, which have no signals, so the mark
    goes first instead (facet-diagnostics.js).
  - **The stats' first read could do the same.** It wrote the stats before
    their gates, so the first reading judged them by the fallback floor. On
    a board whose served floor is under the fallback, a finding already
    there read dark, then lit one write later: a toast about old news. The
    gates go first (facet-diagnosis.js).
  - **Four handlers still drew their answer in steps:** an upload's chunk
    (the placeholders out, the rows in, the work), a connector add's chunk
    (the rows, then the work), the crates list when the selected crate is
    gone, and an alert's "Show all matching items" (about eight draws
    through a half-reset rail). Each is one batch now. Nothing showed
    between the steps, since they run in one go, but the stage's rule is
    one draw per handler.
  - **The bulk bar's Reprocess re-queued by hand,** the one surface that
    didn't go through `requeue()` (data.js). It does now, which also
    batches its two writes.
  - **Leftovers:** the ticker's `onBatch`, which nothing passed once the
    header's tick stopped asking for a repaint, and its test; the job log's
    `ack()` and `noteStamp()` return values and its `settle()` wrapper,
    which nothing read; its first `renderLive()`, which the effect's first
    run does. The header's landings are one signal holding the set, not a
    set and a counter.
  - Stale comments: events.js's chain, the job log's "render tick", three
    tests still describing `app:render`.
- **Checked and fine:** writes inside the draw settle at once. The lens
  grouping and the view's re-arm are written before anything in the draw
  reads them, and the selection prune runs the draw once more when it
  prunes. No `markSeen` runs inside an effect, so the marks' count can't
  loop. The job log's effect finds everything it draws already built.
- **Tests:** announce.test.js gains the Tagging-consistency dot: its first
  reading has its gates, and opening the dialog on a newer finding doesn't
  announce it. Each checks its setup (the finding landed unseen; the
  dialog's stats landed). ticker.test.js loses the `onBatch` case.
- **Removal checks** (files restored by hash): the stats before their gates:
  the first case fails, one toast; the dialog's old order: the second
  fails, one toast.
- **Not pinned:** the four batches (only the number of draws differs) and
  the bulk Reprocess (no test drives it; it now sends the call the card's
  own Reprocess sends, through the same function).
- **Runs:** `npm test` 2071/2071 (lint, the unit tests, the browser suite on
  source); the built frontend's browser suite 85/85. In the build the
  signals chunk still loads on the board page alone.

## Cost

- **Bytes:** measured +4.6kB brotli at Stage 1, +5.7kB by the end of Stage 2
  (which added the hooks), +7.6kB after Stage 3 (plain signals, on the
  board page alone) and +8.6kB after Stage 4 (the cards as components: 60.4kB
  against the 51.8kB start). Stage 5 added nothing to the board page
  (signals-core already carried `effect` and `batch`) and 0.2kB to the boards
  page: 8.6kB on the board page by the end (~17%). The ported code got
  smaller in lines, not in bytes: the caches, signatures and scroll
  bookkeeping went, but a component describes the whole card where the old
  builders appended only what a hover needed.
  - Another page pays only once something it loads imports the vendored file.
  - Stage 1's `pill()` wrapper makes jobs-modal.js and admin-usage.js
    importers, so the admin page (52.3kB before) picks it up through
    admin-usage.js. The jobs modal's chunk shares the board page's copy.
- **The first frontend dependency**, vendored: MIT, Apache-2.0, MIT. Updating
  means re-running the script with new pins.
- **The work:** the toolbar and the rail rewritten as templates, the item
  writes routed through one function, and the card builders rewritten. Most
  of the risk is in Stage 3's list of writers.
- **Two ways of drawing side by side**, for a long time: the out-of-scope
  surfaces stay hand-built. D6 and D7 are the rules that stop that from
  turning into copies or leaks.
