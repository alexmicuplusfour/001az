# Lightbox panel: a component that follows its item (2026-10-04)

Self-contained for a fresh session. Written after a look at the lightbox's
Details panel that started from its download button. Line links show the code
at commit f813d2d. Anything not measured says so, and Stage 0 measures each of
those before anything is built.

This takes over the lightbox half of Stage 6 in
[ui-updates-plan.md](ui-updates-plan.md), which left the panel as the user's
call between three ways: (a) leave it a snapshot, (b) rebuild it whenever its
item changes, (c) make it a component, like the cards. This plan is (c). (b)
would keep every workaround listed below and lose focus, scroll and an open
menu each time it ran; (c) is what the toolbar, the filter rail and the cards
already went through. Stage 6's other half, the uploads toast, stays in that
plan.

## The ask

- "The download button is currently misplaced. It should be on the filename
  row." After the first look, the user's calls: no download on stock
  (connector) items, and one download per file row.
- Then: "we recently implemented preact. i wasn't aware the sidebox panel did
  stupid shit also ... maybe do a deep dive on how we can refactor the panel
  first." After the deep dive: "yes", write it up.

So the download move waits for the refactor, and lands as its last stage.

## What is actually happening

**How the panel draws.**

- One function builds all of it:
  [paintPanel](../public/lightbox.js#L445-L755), about 310 lines of
  `createElement`, with [fieldsSection](../public/lightbox.js#L331-L438) and
  [panelCell](../public/lightbox.js#L315-L326). It empties the panel
  (`replaceChildren`) and builds it again from nothing.
- It runs when you open the panel
  ([setPanel](../public/lightbox.js#L798-L811)), land on an item
  ([showLightbox](../public/lightbox.js#L857-L881)), switch files
  ([showInstance](../public/lightbox.js#L846-L855)) or remove one. Each of
  those draws it twice: once straight away, and again when the file's details
  come back from `/api/instances/:id/reasoning`
  ([renderPanel](../public/lightbox.js#L763-L788)).
- Nothing else draws it. The heart, crate and file-count buttons over the
  picture work the same way: drawn when you land on an item and after their
  own clicks.
- The selected file is a position in the item's list of files,
  `currentInstIndex` ([lightbox.js:40](../public/lightbox.js#L40)), not an id.

**What breaks.** Most serious first. Finding 1 was measured in Chromium on
2026-09-26 for Stage 6 of the ui-updates plan, and the code it runs through
hasn't changed since. The rest are read from the code; Stage 0 measures each
one.

1. **The lightbox never follows a change made anywhere else.** Measured:
   - with the panel open, tags changed elsewhere: after the poll, the panel
     still showed the old tag;
   - a heart made elsewhere: the lightbox's heart still read 0;
   - taking the item out of the crate the board is filtered on, from the
     lightbox's own crate menu: its crate button still read 1, lit. crates.js
     tells the lightbox only when the item stays in the crate.

   And so a Retag you queue from the panel says "Queued", and its new tags
   only show once you've moved off the item and back.
2. **The file's details land late and push the tags down.** The first draw has
   no details, so it shows the tags without their reasons. The second inserts
   the File fields and AI-extracted fields sections above the tags, the
   description under the Tags heading, and a reason under each facet.
   Everything under the file info moves down when the request comes back: too
   quick to see locally, a visible jump on a slow connection.
3. **It opens on the first file, not the one the card shows.** A board can set
   its card face to "Latest added", or to prefer images, documents or audio
   ([mapping-modal.js:1002](../public/mapping-modal.js#L1002)). The card then
   shows that file, but a click opens the lightbox on the first one:
   [showLightbox](../public/lightbox.js#L860) sets the position to 0 under a
   comment that says "reset to the face instance". The rows view gets it right
   ([rows.js:267](../public/rows.js#L267)).
4. **Removing a file above the one you're looking at switches you to another
   file.** Looking at the second of three files and removing the first, the
   position stays at 1, which is now the third file
   ([lightbox.js:514-515](../public/lightbox.js#L514-L515)). The picture and the
   panel move to a file you didn't pick. Removing the last file while looking
   at it goes to the first file, not the new last one.
5. **A failed Retag, Re-extract or Re-transcribe still says "Queued".** The
   button waits for `requeueToast`, then marks itself "Queued" and stays
   disabled ([lightbox.js:582-591](../public/lightbox.js#L582-L591)).
   `requeueToast` shows the error toast itself and never throws
   ([data.js:169-176](../public/data.js#L169-L176)), so a refused or failed
   request gets an error toast and a dead "Queued" button.
6. **Removing a file is written twice, and the two copies have drifted.** The
   rows view's copy says it is the lightbox's "verbatim"
   ([rows.js:79-102](../public/rows.js#L79-L102)), but only the rows view shows
   the server's reason when the server refuses ("cannot remove the only
   instance — delete the item instead",
   [server.js:3590-3592](../server/server.js#L3590-L3592)). The panel says
   "Couldn't remove file" ([lightbox.js:504-520](../public/lightbox.js#L504-L520)).
7. **Download.**
   - It sits in the panel's header, beside pin and close, which act on the
     panel; download acts on a file ([index.html:44](../public/index.html#L44)).
   - On an item with several files it downloads only the selected one, and
     nothing on screen says which.
   - It's offered on stock items. A ticker tile has no file: its link points
     at `gallery/<ticker>`, which doesn't exist
     ([connectors/add.js:35-52](../server/connectors/add.js#L35-L52)). A stock
     with a chart face downloads the app's own chart picture under a random
     32-character name with no extension
     ([worker.js:1025-1029](../server/worker.js#L1025-L1029),
     [faces/index.js:65-68](../server/faces/index.js#L65-L68)). The file info
     under the name says the same about a ticker tile: "file nvda", a file
     that doesn't exist (found in Stage 0's close look).
   - Its link is written from two places
     ([lightbox.js:448-449](../public/lightbox.js#L448-L449),
     [850-851](../public/lightbox.js#L850-L851)).
   - It went in on 2026-07-06 (f7d04b0), when every item was one file. Items
     with several files came on 07-07 and 07-08, and the button never moved.

**The workarounds the rebuild made necessary.** Each one puts back something
the elements would have kept if they'd stayed, or tells a part to redraw:

- `keepPlace` ([modal.js:319](../public/modal.js#L319)) wraps the panel's draw
  ([lightbox.js:761](../public/lightbox.js#L761)). Every control the keyboard
  can be on carries a `data-place` name, so focus can be handed to its
  replacement: the file names, the remove buttons, the leg buttons
  ([lightbox.js:498](../public/lightbox.js#L498),
  [502](../public/lightbox.js#L502), [575](../public/lightbox.js#L575)). Its
  scroll half never reaches the panel: it looks for the scrolling box above
  the panel's body, and the body is itself the scrolling box.
- The details request carries a counter and four checks so a late answer
  can't draw over a newer one ([lightbox.js:770](../public/lightbox.js#L770),
  [785](../public/lightbox.js#L785)).
- `loadCatalogs()` is awaited beside it so the second draw prints fields in
  their declared formats ([lightbox.js:777](../public/lightbox.js#L777)).
  `fieldFormat` already reads a signal that changes when a catalog lands
  ([sort.js:180-181](../public/sort.js#L180-L181)), so a drawing that reads
  it would follow by itself.
- `revealActiveInstance` runs after every draw to scroll the selected file's
  row back into view inside its list
  ([lightbox.js:754](../public/lightbox.js#L754)).
- `app:lightbox-crate-changed`: crates.js asks the lightbox to redraw its crate
  button ([crates.js:162](../public/crates.js#L162),
  [199](../public/crates.js#L199); heard at
  [lightbox.js:1039](../public/lightbox.js#L1039)), and the other handlers
  call `renderLightboxFav`, `renderLightboxCrate` and `renderLightboxInfo`
  themselves.

## What changes

At the end of the arc:

1. The lightbox keeps three things as signals: which item is open, which file
   (by id), and whether the panel is open.
2. While the lightbox is open, one effect draws its heart, crate and file-count
   buttons and its Details panel from those and from the items. A change made
   anywhere reaches them, the way it reaches the cards.
3. The panel is a Preact component. A redraw changes only what differs, so
   focus, scroll and an open Retag menu survive it, and every workaround
   listed above is deleted.
4. Download sits on the row of the file it downloads, and stock items have
   none.

Same markup, class names and CSS, so nothing looks different apart from the
download's new place and the panel waiting for a file's details (D11).

## Decisions

- **D1 — Scope: the lightbox's buttons and its panel.** Out of scope and
  unchanged:
  - the stage: the image, audio, document and chart viewers
    ([detail-view.js](../public/detail-view.js),
    [detail-chart.js](../public/detail-chart.js)). A file doesn't change while
    you look at it, and each viewer already sets itself up and cleans up after
    itself;
  - scroll-to-zoom and the count pill, which paint frame by frame by hand on
    purpose;
  - the object-detection boxes over the picture, still drawn by hand, fed by
    the panel's details as now;
  - the arrows, the pin, opening and closing, Escape, focus going back on
    close, and the page behind being held (`inert`).
- **D2 — Signals in lightbox.js:** the open item and the selected file's id
  from Stage 1; panel open from Stage 2, whose component is the first thing
  to read it (Stage 1's close look). The same kind of module signal list.js,
  view.js and patterns.js keep. The list you page through stays as it is
  today: the filtered list taken when the lightbox opens, except that paging
  skips a card that has left the page since (D12).
- **D3 — The selected file is an id.**
  - Opening selects the file the card shows:
    `selectFace(item.instances, state.boardMapping?.face)`, the call the rows
    view makes for its face ([rows.js:267](../public/rows.js#L267)). Opening
    on a given file (a rows-view tile) selects that file, as now.
  - If the selected file leaves the item (removed here or elsewhere, or moved
    to another item by a re-extract), the selection goes to the file that took
    its place in the list, or to the new last file if it was last. That's
    what removing the selected file does today, except today's jump to the
    first file when it was last.
  - The stage remounts, and the panel repaints, when you move to another item
    or another file, never because the item's data changed. A remount would
    restart an audio clip and reset the zoom. The item counts as well as the
    file: on a "Match to a list" board one file can belong to several items,
    so paging from one to the next can land on the same file (Stage 1's close
    look; the plan first said the file id alone).
  - From Stage 2 the panel is a component and draws on every change, changing
    only what differs; only the stage still waits for a move (Stage 2's close
    look).
- **D4 — One effect while the lightbox is open,** the way the job log draws
  while it's open ([jobs-modal.js:723](../public/jobs-modal.js#L723)). It
  reads the lightbox's signals, `itemsVersion` (items change in place,
  ui-updates D5), `state.items` (D12) and the state fields the buttons and
  panel show. It draws the three buttons, the arrows, the dialog's name and
  the panel, and it's disposed on close. `app:lightbox-crate-changed` goes at
  both ends, and so do the hand-called button redraws. From Stage 1's close
  look, measured against the vendored signals:
  - It runs inside whatever wrote what it reads, the poll's merge among them,
    and an error thrown in an effect is thrown back into that writer. So it
    catches and reports its own errors, as app.js's draw does
    ([app.js:287-289](../public/app.js#L287-L289)).
  - Whatever it calls subscribes it too: the vendored signals have no way to
    read without subscribing, and the panel's repaint reads the board's
    facets, closing reads the filter list. So each piece of its work is gated
    on its own inputs, and a run for any other reason does nothing: a button
    is written only when its content changed (which also keeps the Details
    button's tooltip from closing under the pointer every poll), the stage
    only for another item or file (D3). The panel, from Stage 2, is drawn on
    every run, and Preact leaves alone what didn't change. Every draw of it
    happens in this effect, so whatever it reads (the facets, the catalog,
    the details) brings the next one.
  - It may write what it reads (the selection moving to another file) and
    dispose itself mid-run (closing, D12); both measured.
- **D5 — The panel is a Preact component,** drawn into
  `#lightbox-panel-body`, which nothing else writes into (ui-updates D7).
  - Its pieces: the name row; the file list and its rows; the file info rows
    (file, kind, id); one fields section, used for connector, file and
    AI-extracted fields; a facet card; one leg button for Re-extract, Retag and
    Re-transcribe; the notices (provisional identity, parked, undecided, the
    hints).
  - It isn't keyed by item. Paging to the next item redraws the same tree, so
    the keyboard stays where it was, on Retag for instance, as list-keyboard's
    test expects today
    ([list-keyboard.test.js:286-290](../test/browser/list-keyboard.test.js#L286-L290)).
    State that belongs to one file is kept per file.
  - From Stage 2's close look:
    - The per-file state (a button's busy ring, "Queued") sits in a table by
      file id, not in components keyed by file, which would be made anew on
      paging and drop the keyboard.
    - Retag sits in the half that waits for the details (D11), so on a move it
      goes for one round trip. The leg buttons keep the keyboard across that:
      the one the keyboard was on takes it back when the next file's details
      land, unless the keyboard went somewhere else meanwhile. Today it
      survives only because the first paint draws Retag at once, which is
      the jump D11 removes.
    - The details come in as a prop (D6), so a jsdom test can draw every
      state from props.
    - The section headings come from modal.js's `sectionHeading`, an HTML
      string. The component draws that one source the way `Icon` draws an icon
      string (icon.js), not a copy of its markup.
  - It lives in its own module, `public/lightbox-panel.js`, imported only by
    lightbox.js, so it rides the same lazy chunk (settled 2026-10-04, the
    user: "split it"). The panel is nearly half of lightbox.js, and on its own
    a jsdom test can draw it from props, the way cards.test.js draws a card.
    This departs from ui-updates D6 ("the file that owns the surface keeps
    it"), on purpose.
  - Its buttons don't use `busy()` or `claim()`
    ([modal.js:249-280](../public/modal.js#L249-L280)). Both write into the
    button, and nothing may write into an element Preact draws (ui-updates
    D7). The component draws the same busy markup from its own state, so the
    CSS stays as it is.
- **D6 — The file's details are fetched by the panel,** when the selected file
  changes and when that file's status or tags change, so a retag that lands
  brings its new reasons with it. A poll that changes nothing about this file
  fetches nothing. An answer for another file, or for an older state, is
  dropped. The details feed the object-detection boxes as now.
  - Amended by Stage 2's close look. A full retag clears the file's tags,
    reasons and agreement on the server at once
    ([db.js:483-484](../server/db.js#L483-L484)), and the page takes the
    file's cleared tags as they come; it holds back only the card's own
    ([data.js:180-201](../public/data.js#L180-L201)). Drawn live, the panel
    would lose its chips and say "No AI tags for this item." for the whole
    retag, and a fetch on the status change would bring back nothing. So:
  - The file's half of the panel is one snapshot: the file's tags, status and
    undecided flag as they were when its details were asked for, with the
    reasons, agreement and fields that came back.
  - Every move asks again. For the same file, the next ask waits until the
    file settles, that is, until its status leaves the queued and running
    sets (D7's test), and then goes if the file went through a run or its
    status or tags changed. While it's queued or running, the half keeps what
    it showed.
  - The snapshot sits in a signal of the panel's module, asked for from the
    lightbox's effect and handed to the component as a prop (D4: every draw
    happens in the effect).
  - Accepted gap: a run that starts and finishes between two of the page's
    looks, a re-extract elsewhere say, changes nothing the page can see. The
    list carries no stamp per file, so that isn't asked for again.
- **D7 — The leg buttons.** While the request is out, the button shows the
  busy ring. It says "Queued" only when the request worked: `requeueToast`
  returns whether it did, and its other callers don't need to read it.
  "Queued" belongs to that file and that button, and it ends by itself when
  the file's status leaves the queued and running sets (`QUEUED`/`ACTIVE`,
  [data.js:54-55](../public/data.js#L54-L55)), that is, when the work lands.
  Re-extract stays clickable while a Retag is queued, as today.
- **D8 — One way to remove a file:** `removeInstance(item, inst)` in data.js,
  next to `requeue`. It's the rows view's version: the server's reason when it
  refuses, and a latch against a double click. The rows view and the panel
  both call it.
- **D9 — Download (the original ask).**
  - An item with two or more files: a download on each file row, before its
    remove button. An item with one file: at the right end of the name row.
    The panel's header keeps pin and close only.
  - None on a connector item: not on a ticker tile (no file), and not on a
    chart face (the app's own picture).
  - On a connector item the file info drops its "file" row too, for the same
    reason: on a ticker tile it names the ticker as if it were a file. Kind
    and id stay. (Proposed in Stage 0's close look; the user's answer was "go
    ahead", 2026-10-04.)
  - Amended by Stage 3's close look: the page knows this per file, not per
    item. A ticker tile's file is a placeholder, with nothing stored behind
    it, named after the ticker (`kind: "connector"`). A chart face is a
    picture the app drew itself (`generated`): a random name with no
    extension, replaced on every refresh. One check per file decides both
    the download and the "file" row, and gives the same answer as "a
    connector item" for every stock today.
  - Each link is named for its file ("Download 3WOsFn0.jpg"), so a screen
    reader doesn't hear "Download" nineteen times, and clicking it doesn't
    switch the shown file: the row's own click picks the file, so the link
    stops its click, as remove does.
  - It saves under the file's original name, as now. Amended by Stage 3's
    close look: except an SVG, which the server stores as WebP (vectors can
    carry scripts, so it rasterizes them), so the download said `.svg` over
    WebP. It saves as `.webp`. The rule isn't "the stored extension": a HEIC
    is kept as it is under an `.avif` name, and its own name is the right
    one.
  - The row button reuses the remove button's box (`.lbp-file-remove`, made a
    shared class); the red hover stays on remove only. No copy of the rule.
    The remove button keeps its class, which the tests find it by; the link
    gets a hover of its own.
  - Not done: naming the remove buttons per file ("Remove pair-a.jpg"), the
    same problem on the same rows. Offered in Stage 3's close look, not taken
    up.
- **D10 — Tests:** ui-updates D8's rules.
  - Only real triggers: a click, a key, or a change arriving through the
    page's own poll (made through the API as the same user, the way Stage 6
    measured). A held-back request (`page.route`, as list-keyboard does) is
    fine for timing; a refused one stands in for a refusal the test can't
    cause for real. (Stage 0's close look found both refusals it pins can be
    caused for real, so none is faked there.)
  - Bug tests state today's behavior and check their setup on the way,
    grouped by the stage that fixes them, and that stage rewrites them.
  - What's right today and could break is pinned as a "stays true" guard.
  - Every new proof gets a removal check: put the old code back, watch the
    test fail.
- **D11 — The file's half of the panel waits for its details** (finding 2;
  settled 2026-10-04, the user: "wait"). The name row, the file list and the
  file info rows draw at once, from the item. Everything from the fields down
  waits for the file's details: on opening and on a file switch, one round
  trip of "Loading…" under the file info, then it draws once. A new fetch for
  the same file (a retag landing) keeps the old details on screen until the
  new ones arrive. Rejected: drawing the tags first and keeping the jump.
  From Stage 2's close look:
  - The chips wait with the reasons: they're part of the snapshot (D6), so a
    retag that lands redraws the half once, not new chips under old reasons.
  - A details request that fails draws the half without details, as today,
    rather than "Loading…" for good.
  - A move keeps the panel's place, as before the arc; a new item's file
    list starts at its top. A poll, or the details landing, keeps your place
    too. (Settled 2026-10-04, the user: "keep the place". Stage 2 had put the
    panel back at its top on every move, on this plan's word that the old
    rebuild did the same, and Stage 2's second pass found it didn't: the
    rebuild put the scroll back where it was, so a stock's long connector
    fields kept their place from card to card, and on a file board the first
    paint was short, so it ended near the top anyway.)
  - Not done: keeping each file's details while the lightbox is open, so
    going back to a file would skip "Loading…" (the user's call, 2026-10-04).
- **D12 — When the open item goes away, the lightbox closes** (settled
  2026-10-04, the user: "close it"). Merged into another item by a re-extract,
  or swept from the page as a ghost card: the lightbox closes, and a toast
  says so in the deep link's words, "That card isn't on this board any more"
  ([app.js:88](../public/app.js#L88)). Rejected for now: following the shown
  file to the item that now holds it.
  - Closing this way also closes any menu open on the lightbox. Closing used
    to close only the crate menu, and the other ways to close close a menu
    first; this one doesn't wait for anyone (Stage 1's close look).
  - Two toasts only when the open card is one you uploaded in this tab, still
    processing, and it merges: the upload's own "Merged into an existing
    entity" ([upload.js:325-328](../public/upload.js#L325-L328)) and this one.
    Rare, and both true; left as is (Stage 1's close look).
  - The page only notices some of these. A settled card deleted in another
    tab never leaves the page (an older bug, recorded in the ui-updates arc),
    so it never reaches the lightbox either.

## What stays the same

- The look: markup, class names and CSS, apart from D9 and D11.
- The stage, zoom, the count pill, the arrows, preloads, the pin, the keys,
  opening and closing.
- The server and the API. No server change is planned.

## Stages

Each stage is three asks: a close look (read the code against this plan, say
what it got wrong), the build (amend the plan first), and a second pass when
asked. Each stage's real-app check runs in real Chromium through
test/browser/harness.js, never in a session minted in the compose database.
Anything left to check by eye on compose is listed in the stage.

### Stage 0 — pin the bugs

Browser tests in a new file, `test/browser/lightbox-panel.test.js`, grouped by
the stage that fixes them, the way ui-updates.test.js is. Each states what
happens today and checks its setup on the way:

- Fixed in Stage 1:
  - a heart made elsewhere (through the API, as the same user) doesn't reach
    the lightbox's heart after the poll;
  - taking the item out of the crate the board is filtered on, from the
    lightbox's crate menu, leaves its crate button at 1, lit;
  - on a board whose face is "Latest added", opening a two-file card shows
    the first file;
  - looking at the second of three files, removing the first shows the third;
  - looking at the last of four files, removing it shows the first;
  - an item still in the queue, deleted elsewhere (through the API), is swept
    from the page by the poll while the lightbox stays open on it.
- Fixed in Stage 2:
  - with the panel open, tags changed elsewhere don't reach it after the poll;
  - with the details held back, the Tags heading is drawn before they land,
    and moves down when they do;
  - a Retag the server refuses leaves the button reading "Queued", disabled.
    Refused for real: a full retag queued through the API first, then one
    facet picked from the menu the panel still offers;
  - a removal the server refuses toasts "Couldn't remove file", not the
    server's reason. Refused for real: the item's other file removed through
    the API first.
- Fixed in Stage 3:
  - a ticker tile's panel offers a download that points at a file that
    doesn't exist;
  - a ticker tile's file info names that file ("file nvda");
  - a two-file item's panel has one download, in its header, for the selected
    file only.
- Each bug test gets a stand-in fix in the build: a small temporary edit to
  the app that makes its bug stop, under which the test must fail on its
  "today" line, never on a setup line. The app file is put back byte for byte
  after each. Each new guard below is broken the same way and must fail.
- Stays true through every stage. New, since nothing tested them:
  - a pinned panel opens with the lightbox, and closing the panel doesn't
    unpin it (Stage 1 moves the panel's open state);
  - an object field's box draws over the picture with the panel open, and
    hovering its row lights it (Stage 2 moves what feeds the boxes).

  Already tested:
  - focus through the panel's draws and through paging
    ([list-keyboard.test.js:254-292](../test/browser/list-keyboard.test.js#L254-L292));
  - focus back on Details after Escape and after ×
    ([list-keyboard.test.js:234-252](../test/browser/list-keyboard.test.js#L234-L252));
  - the Tab walk
    ([list-keyboard.test.js:339-366](../test/browser/list-keyboard.test.js#L339-L366);
    Stage 3 moves Download in it);
  - the fields as List's test reads them
    ([list-columns.test.js:367-372](../test/browser/list-columns.test.js#L367-L372));
  - removing a file in jsdom
    ([cached-counts.test.js:254](../test/cached-counts.test.js#L254));
  - the panel's geometry ([lightbox-layers.test.js](../test/browser/lightbox-layers.test.js))
    and zoom with the panel open
    ([lightbox-zoom.test.js](../test/browser/lightbox-zoom.test.js)).

**Close look (2026-10-04).** Every test above was prototyped outside the repo
and run in real Chromium through the harness against today's code: 16 of 16
passed, and so did the 54 existing tests listed as already tested. Measured
on the way: the Tags heading moves down 245px when the details land, with two
fields and a two-line description; a queued item deleted elsewhere leaves the
page about 8s later, two polls, since data.js waits one more poll before
sweeping an item the page didn't upload itself
([data.js:264-277](../public/data.js#L264-L277)). What changed the plan:

- A card whose thumbnail fails isn't drawn at all
  ([grid.js:563](../public/grid.js#L563)), and `servePixels` answers only
  full-size pictures. With no thumbnails served, the cards left the grid under
  the clicks and 11 of the first 12 prototypes failed in setup. `servePixels`
  gets a `thumbnails` option; its other callers stay as they are.
- `seedInstance` makes items with no file, and those draw and open as ticker
  tiles. The tests seed an entity and its files the way list-keyboard does.
- Both refusals can be caused for real, so no reply is faked. The Retag one
  needs a board with two facets: on a one-facet board, picking the only facet
  is a full retag (the route reads a scope of every facet as no scope), and
  the server takes it.
- Two behaviors had no test, and Stages 1 and 2 move them: the pin and the
  object-detection boxes. Each gets a guard.
- Finding 4's last-file case gets its own test, since D3 changes it.
- Once its fix lands, a test must fail on its "today" line: the jump test
  checks the early Tags heading as part of the bug, since D11 removes it, and
  the download tests look for any download link in the panel, not
  `#lightbox-download`, which Stage 3 deletes.
- A ticker tile's file info reads "file nvda", a file that doesn't exist. D9
  now drops that row on connector items.
- Two Playwright traps. `res.json()` waits forever on a body the page never
  reads, and the panel's remove handler reads only the status: assert the
  status and the route's own sentence instead. And a response wait set up
  right after a fetch from the test can match that fetch's answer instead of
  the page's own request: match the request's body too.

**Built (2026-10-04).** The user said "go ahead"; this stage's list, its close
look, D9's file row, D10's note and the later stages' counts were amended
first.

- [lightbox-panel.test.js](../test/browser/lightbox-panel.test.js): 15 tests,
  about 31s. Six until Stage 1, four until Stage 2, three until Stage 3, two
  stays-true guards. Each bug test checks its setup on the way and states
  today's behavior on its "today" lines.
- `servePixels(page, { thumbnails: true })` in
  [harness.js](../test/browser/harness.js) answers thumbnails too.
  view-switch.test.js and sorted-load.test.js each had a route of their own
  doing the same (one with its own copy of the pixel); both call it now.
- Stand-in checks, each a temporary edit to the app, put back byte for byte
  and checked by hash afterwards. Every one failed its test on the intended
  line, never a setup line, 15 of 15:
  - heart: an effect redraws the lightbox's heart whenever items change;
  - crate: crates.js tells the lightbox when the item leaves the crate too;
  - face: opening selects `selectFace`'s file;
  - an earlier file removed: the shown file is kept by its id;
  - the last file removed: the selection goes to the new last file;
  - the item gone: an effect closes the lightbox when its item leaves
    `state.items`;
  - tags changed elsewhere: an effect repaints the panel whenever items
    change;
  - the jump: the panel's first draw, before the details, is skipped;
  - the refused Retag: `requeueToast` says whether it worked, and "Queued"
    only then;
  - the refused removal: the server's reason is read and shown;
  - the ticker's download: the link loses its `download` on a connector item;
  - the ticker's file row: dropped on a connector item;
  - the two-file download: the header link loses its `download` when the
    item has two files;
  - the pin guard: a pinned panel no longer opens with the lightbox;
  - the boxes guard: the boxes aren't drawn.
- Runs: the new file 15/15; `npm test` 2,353/2,353 (lint included, ~182s);
  no test process left behind.
- Line endings, checked in bytes: the three test files this stage edited are
  LF, as they were at checkout, and so are the new test file and this plan.
  public/lightbox.js is CRLF in this working copy (autocrlf), and Git Bash's
  grep and sed both reported it as LF; the stand-in script refused to run on
  an anchor it couldn't find exactly once, which is how that showed, and it
  now matches each file's own ending.
- The prototypes and the stand-in runner stay in the session's scratchpad,
  not the repo.

### Stage 1 — the lightbox's state; its buttons follow the item

- D2's two signals, D3's selection, and D4's effect drawing the heart, crate
  and file-count buttons, the arrows and the dialog's name. The panel stays
  hand-built for now: when the effect moves to another item or file (D3), it
  repaints the panel the way switching files does today.
  - The panel's file rows pick and mark their file by its id, not by position
    ([lightbox.js:477-478](../public/lightbox.js#L477-L478)).
  - Removing a file no longer picks the next file itself
    ([lightbox.js:514-515](../public/lightbox.js#L514-L515)): the effect
    moves off a removed shown file. Removing any other file leaves the shown
    one be, so the remove handler repaints the panel's list itself.
  - Opening on a given file (a rows-view tile) selects it before anything is
    mounted: one mount, where today mounts the first file and then the one
    asked for.
- D12: the lightbox closes when its item goes away, and paging skips a card
  that has left the page.
- Deleted: `currentInstIndex` and `selectedInst()`'s reset,
  `app:lightbox-crate-changed` at both ends, the hand-called button redraws,
  `showLightbox`. The jsdom stub's comment uses that event as its example
  ([jsdom-stub.js:11](../test/jsdom-stub.js#L11)) and needs another.
- Tests:
  - Stage 0's six flip.
  - New: paging skips a card that has left the page; stays true: a poll that
    changes the open item keeps the picture on the stage as the same element
    (D3's no-remount rule).
  - The Stage 5 crate test in ui-updates waits on the event to read the grid
    ([ui-updates.test.js:455-486](../test/browser/ui-updates.test.js#L455-L486)).
    It reads the grid when the lightbox's crate button changes instead,
    which the same write draws. (The plan first said a fetch wrapper at the
    membership request; that would read the grid before crates.js has
    written the change.)
- Real-app check: the tests in the harness. Owed by eye on compose: an audio
  clip keeps playing through a poll that brings a change to its item (the
  stays-true test checks the stage isn't remounted, which is what would stop
  it).

**Close look (2026-10-04).** The code Stage 1 touches, read against the plan,
and the vendored signals probed directly (a scratchpad script, not the repo).
What changed the plan:

- An error thrown in an effect is thrown back into whatever wrote the signal
  (measured), and this effect runs inside the poll's merge. It reports its
  own errors (D4).
- On a "Match to a list" board one file can belong to several items, so the
  stage and the panel follow the item as well as the file (D3).
- The list you page through is a snapshot, so a card swept since the lightbox
  opened would close it the moment you paged onto it. Paging skips it (D12).
- Closing closed only the crate menu, so D12's close would have left the
  Retag menu up (D12).
- The plan's rewire of the crate test would have read the grid too early
  (above).
- Panel open has no reader until Stage 2 (D2).
- Whatever the effect calls subscribes it, so each piece of its work is gated
  on its own inputs, and its buttons are written only when they change (D4).
- The panel's file rows and its remove handler went by position too (above).
- Headless audio playback needs a real file, but what stops a clip is a
  remount: a stays-true test checks the stage isn't remounted, and playback
  is owed by eye.
- D12's toast reuses the deep link's sentence; the rare double toast with an
  upload's merge toast stays (D12).

Confirmed: items keep their identity through batch loads and merges
(`addItems` skips the ids it has, the merge writes in place), so "still in
`state.items`" is a sound test; and every write to an item's data calls
`itemsChanged()` (ui-updates Stage 3's list of writers).

**Built (2026-10-04).** The user said "yes" to amending and building; D2, D3,
D4, D12 and this stage's bullets and close look were amended first.

- [lightbox.js](../public/lightbox.js): `lightboxItem` and `lightboxFile` are
  signals, and `draw` is the effect, made when the lightbox opens and
  disposed when it closes. `showLightbox`, `showInstance` and
  `currentInstIndex` are gone; `open` serves both ways to open, `navLightbox`
  pages with `step`, which skips a card that has left the page, and
  `closeLightbox` closes any open menu. The three buttons draw through
  `write`, which skips what hasn't changed. The panel's file rows pick and
  mark their file by id, and its remove handler repaints only when the shown
  file stays.
- On the way: the panel's late paint, when the file's details land, compared
  the file it was asked for with the one shown as objects, and a poll that
  brought the open item mid-request rebuilt its files as new objects, so the
  details were dropped and the panel stayed without them. It compares ids
  now.
- [crates.js](../public/crates.js): its two `app:lightbox-crate-changed`
  dispatches are gone. [jsdom-stub.js](../test/jsdom-stub.js)'s comment names
  `app:uploads-pending-changed` instead.
- [lightbox-panel.test.js](../test/browser/lightbox-panel.test.js), 19 tests:
  eight fixed in Stage 1 (Stage 0's six, flipped; paging skips a card that
  left; a card that leaves the page closes the menu open on the lightbox),
  four until Stage 2, three until Stage 3, four stays true (the pin, the
  boxes; new: the same picture on the stage through a poll that changes its
  item, and the same insides in the buttons through a poll that changes
  another card). The ui-updates crate test reads the grid when the lightbox's
  crate button lights, through a `MutationObserver`.
- Removal checks, each a fix taken back out of the new code, every one failing
  its test on the intended line, 11 of 11: the effect deaf to item changes
  (the heart, and separately the crate button); opening on the first file;
  the remove handler selecting by position; the fallback going to the first
  file; no close for a gone item; paging onto a gone card; closing leaving
  other menus up; the stage mounted on every run; the buttons written on
  every run; and, for the rewired crate test, the grid drawn a task late.
  Against the pre-stage lightbox.js and crates.js, the eight Stage 1 tests
  fail and the other eleven pass.
- Not pinned: the effect reporting its own errors (nothing in it throws to
  test with), and the Details tooltip itself (no test can see a native
  tooltip; the buttons' same-insides test pins what keeps it up). Owed by
  eye on compose: an audio clip playing on through a poll that changes its
  item; the Details tooltip staying up through a poll.
- Runs: the new file 19/19; every other test file that touches the
  lightbox, 275/275; `npm test` 2,357/2,357 (lint included, ~191s); the
  browser suite on the built frontend 198/198. No test process left behind.
- Line endings, checked in bytes: lightbox.js stays CRLF as checked out, the
  others LF.

**Second pass (2026-10-04).** The user asked for it after the build. Two
read-only reviewers, neither shown the plan: one read the code against the
lightbox before the stage, one read the tests. Every finding was re-read in
the code, and the suspected flakes were forced to confirm them.

Fixed:

- Paging with the Retag menu open left the menu up, hanging off the old
  button, and a pick from it retagged the file of the card you'd left. This
  is older than the stage: dropdown.js even listed the arrow keys among the
  repaints it holds a menu through. Stage 1 added a second way in, a poll
  that moves the selection off a removed file. The effect now closes any open
  menu whenever it moves to another item or file. That covers the crate menu
  too, so the two separate closes of it (on paging, on closing) are gone. New
  test: paging with the Retag menu open closes it.
- The Race test (a refused removal) could fail on its setup since Stage 1. A
  poll landing between its removal elsewhere and its click moves the
  selection and repaints the panel with one file. It now holds the page's
  polls (`holdPolls`, harness.js), which is the race it stages: a page that
  hasn't heard yet.
- The Retag test could fail when the file's details landed after its menu
  opened. The second paint rebuilds the panel, the menu stays on the old
  button, and the claim writes "Queued" into a button no longer on screen.
  It now waits for the details' paint first.
- The rewired ui-updates crate test no longer proved the click's own write. A
  poll lands the same change and draws both halves together, so with
  crates.js's write taken out it still passed. It, and this file's crate
  test, now hold the polls, and a missing write fails on the test's own line
  rather than a timeout.
- Smaller:
  - Changes made elsewhere go through the API from outside the page
    (`elsewhere`), so the page's own requests are the only ones it sees, and
    the Retag test's request filter went.
  - The paging test checks the gone card was next before it goes.
  - Pair picks its second file, so "the selected file" isn't also "the
    first".
  - The stays-true picture test checks the lightbox drew the poll's change.
  - The menu test checks the menu is still open before the card leaves.
  - Three 3s waits are 10s.
  - The ticker tests check page errors. The 404 fetch is gone, since any file
    on this test server would get one too.
- Simplified: `showFile` is inlined; `closeLightbox`'s `batch` is gone
  (nothing reads the signals once the effect is gone). Comments fixed: the
  effect's accidental readers, `open`'s guard (the effect being made can't be
  stopped by the close it runs), face-select.js's consumers, and dropdown.js's
  list of repaints.

Declined:

- Clicking the row of the file already shown no longer re-fetches the panel;
  it did as a side effect of remounting the stage, which also restarted a
  clip. Stage 2 makes the panel follow its item, which is what that click
  stood in for.
- The details' late paint draws the file object from before a poll. Using the
  new object would put new tags beside reasons fetched for the old ones.
  Stage 2's details follow the item (D6).
- Two older edge cases, recorded under "Not in this plan": `open` while
  already open, and `open` refusing a card swept while the lightbox's code
  was still loading.
- One helper for "the item and its face file", shared by opening and paging:
  it would save a line.
- Closing each test's page as it ends, seeding and `openPanel` helpers shared
  across test files, and routing pixels before the first load instead of
  reloading. Those are harness-wide choices, not this stage's.

Checks, 22 of 22 as intended, files restored by hash after each:

- Stage 1's eleven removals again, against the changed tests: each fails on
  its intended line.
- The pass's fix taken out: the new paging test fails on its line.
- crates.js's own write taken out, left to the poll: both crate tests fail on
  their lines. Both, as they were before the pass, passed.
- A poll forced into the Race test's window (a 4.5s pause): the test before
  the pass fails on its setup line, and the new one passes.
- The file's details forced to land under the open Retag menu: the test
  before the pass fails on its "today" line. The new one, with the details
  1.5s late, passes.
- The header download pinned to the first file: Pair fails on its line. As
  it was before the pass, it passed.

Runs: the lightbox file 20/20; `npm test` 2,358/2,358 (~182s); the browser
suite on the built frontend 199/199. No test process left behind. Line
endings as checked out (lightbox.js, dropdown.js and face-select.js CRLF, the
rest LF). Still owed by eye on compose: the clip and the tooltip through a
poll (above).

### Stage 2 — the panel as a component

- D5's component, D6's details, D7's buttons, D8's removal, D11's wait.
- Deleted: `paintPanel`, `fieldsSection`, `panelCell`, `queueLegBtn`, the
  panel's `keepPlace` and every `data-place` in it, the request counter and
  its checks, the `loadCatalogs()` await, `revealActiveInstance` after every
  draw (it runs when the selection changes), rows.js's `doRemoveInstance`. The
  header's download link has had one writer since Stage 1 (the panel's
  paint; switching files stopped writing it). With the paint gone, the
  effect writes it on a move, until Stage 3 moves it.
- Panel open becomes a signal (D2), which the effect reads.
- Markup proof, the way ui-updates Stage 2 did it: old and new panels drawn
  for the same states and compared, in jsdom, each in its own process,
  attributes sorted, the old `data-place`s dropped. The states:
  - a one-file picture with no identity; an identity with three files; a
    document; audio (the Transcript heading);
  - a connector item with connector fields, one showing when it was updated
    (on a fixed clock);
  - parked; undecided; provisional identity;
  - file fields beside AI-extracted fields; an object field, one with nothing
    detected, a list field and a link field;
  - vote badges; no reasoning recorded; reasoning turned off; a board with no
    facets.
  - Not compared: "signed out", which the board page can't reach (it sends you
    to login, [app.js:229-232](../public/app.js#L229-L232)), and the wait for
    the details, which is new (D11).
- Tests:
  - Stage 0's four flip. The "tags changed elsewhere" one waits for the
    refetch: the chips come with it (D11).
  - New: a change to the file's tags and reasons, written the way a finished
    retag writes them, reaches the open panel after the poll, chips and
    reasons together; a retag queued from the panel keeps its chips while it
    runs, says "Queued", and redraws once when it lands; the panel keeps its
    scroll, its elements and its details through a poll that changes its
    item; a move puts it back at its top; a details request that fails draws
    the half without details.
  - The tests that waited on `.lbp-hint` for "the details landed" wait on
    Retag instead: "Loading…" is an `.lbp-hint` too.
- Real-app check: the new tests in the harness. Owed by eye on compose:
  opening the panel at prod's latency (D11).

**Close look (2026-10-04).** The panel code, rows.js's removal, the requeue
path and the server's re-queue routes, read against the plan. What changed the
plan:

- A retag clears the file's tags and reasons at once, and the page follows
  the file's (D6). Drawn live, the panel would lose its chips for the whole
  retag. Its file half is now one snapshot, asked again when the file
  settles.
- D11's wait takes Retag away for a round trip on every move, and today's
  keyboard-on-Retag after paging lives only on the first paint drawing it at
  once. The leg buttons hand the keyboard back (D5).
- Every draw of the panel happens in the lightbox's effect, so the details sit
  in a signal and come in as a prop (D4, D6). A component that fetched into
  its own state would draw outside the effect, and a catalog landing later
  wouldn't reach the fields.
- Scroll on a move, a failed request, and the chips waiting with the reasons
  were unsaid (D11).
- Smaller: the download link needed a writer; per-file state in a table, not
  keyed components; one source for the section headings; the markup proof's
  states; the tests' "details landed" marker.
- From Stage 1's second pass: the "tags changed elsewhere" test needed a
  wait for the refetch; the late paint used the file object from before a
  poll (gone with the paint); and the Retag menu hung off the old button when
  the details landed under it, which the buttons kept across draws end.

Confirmed: the four "Until Stage 2" tests flip as planned; all three legs send
the file to a queued status, so D7's end works for each, and `requeueToast`'s
other callers ignore what it answers; rows.js's removal is the version with
the server's reason and a latch; `fieldFormat` reads the catalog's signal;
the vendored Preact has the hooks; no server change.

**Built (2026-10-04).** The user said "sure" to amending and building, with the
keyboard fix and no per-file cache of details. D3, D4, D5, D6, D11 and this
stage were amended first.

- [lightbox-panel.js](../public/lightbox-panel.js), new, imported only by
  lightbox.js, so it rides the lightbox's lazy chunk:
  - the panel as components: `Panel`, `FileList` and `FileRow`,
    `FieldsSection`, `FieldCell` and `DetRow`, `FileHalf` and `FacetCell`,
    `LegButton`;
  - the details snapshot, `fileDetails`, asked for by `followFile`, which the
    lightbox's effect calls with the shown file;
  - the buttons' state by file (`legs`), and `resetPanel` on close.
- [lightbox.js](../public/lightbox.js): panel open is a signal. The effect
  draws the panel on every run and the stage on a move. On a move it also puts
  the panel at its top and writes the header's download. It draws the boxes
  over the picture when the shown file's details change. Deleted: `paintPanel`,
  `fieldsSection`, `panelCell`, `queueLegBtn`, `renderPanel`, the panel's
  `keepPlace` and every `data-place`, the request counter, the
  `loadCatalogs()` wait, `selectedInst`, and `revealActiveInstance` after every
  draw (it runs when the selection moves). About 1,120 lines down to 620.
- [data.js](../public/data.js): `requeueToast` answers whether it went;
  `removeInstance` is the one removal (D8), and rows.js's `doRemoveInstance`
  is gone.
- [icon.js](../public/icon.js): `Markup` draws any of the app's own markup
  strings the way `Icon` draws a glyph. The panel's headings go through it, from
  modal.js's `sectionHeading`.
- "Queued" ends when the file settles: `followFile` clears it before the
  panel draws. The button's own in-flight check, a second way of saying the
  same thing, went.
- dropdown.js's list of what repaints under an open menu no longer names the
  panel.
- Tests:
  - The four flipped, each now waiting on what the panel draws.
  - Three more fixed in Stage 2: a retag landing elsewhere, its chips and
    reasons in one draw; a retag queued from the panel, which keeps what it
    showed while the retag runs, says "Queued", and redraws once it lands; a
    move back to the top.
  - Two stays-true guards: the panel's place, elements and details through a
    poll; a failed request still draws the file's half. The panel before the
    stage never redrew on a poll and never waited, so they held there by
    themselves; they were written as fixes, and moved when the old frontend
    passed them.
  - The Paged test waits on Retag.
  - list-keyboard's focus test named the focused file by its `data-place`,
    which went; it reads the file's name instead.
- Against the frontend before the stage, the seven "Fixed in Stage 2" tests
  fail and the other eighteen pass.
- Removal checks, each a fix taken back out of the new code, every one failing
  its test on the intended line, 14 of 14:
  - the same file never asked about again (the chips stay red);
  - the file's half drawn before its details (a Tags heading before they
    land);
  - "Queued" set on any answer and never ended, the old button (refused, it
    still says Queued);
  - the panel's own words on a refused removal;
  - chips drawn from the file as it is, reasons from the snapshot (the chips
    turn first; and, mid-retag, the chips go);
  - the details asked for again while the retag runs (the chips go);
  - "Queued" never ending (still Queued when the retag lands);
  - the panel's tree made anew on every draw, and the details asked for on
    every draw (the place, the elements, the extra requests);
  - a move keeping the panel's scroll;
  - a failed request leaving "Loading…";
  - the leg buttons dropping the keyboard on a move (list-keyboard: not on
    Retag after paging);
  - and Stage 1's menu close again, its test's marker changed.
  - Not re-run: Stage 1's removal of the remove handler's own selection, since
    that code is gone. A removal now leaves the selection to the effect.
- One race the runs found: the browser suite on the built frontend first came
  out 203/204. list-keyboard's "keyboard reach as one walk" tabbed through
  the panel the moment it opened, expecting Retag, which now comes with the
  details (D11). The details took 245ms there. It waits for Retag now, and
  passes on both frontends.
- Runs: the lightbox file 25/25; `npm test` 2,363/2,363 (lint included,
  ~194s); list-keyboard after its fix 11/11 on both frontends; the browser
  suite on the built frontend 204/204. No test process left behind. Line
  endings as checked out (lightbox.js and dropdown.js CRLF, the rest LF, the
  new module LF).
- Owed by eye on compose: opening the panel at prod's latency (D11), and from
  Stage 1, a clip and the Details tooltip through a poll.
- Markup proof: 17 states, the list above plus a failed file (Retag without
  its scope menu), a ticker tile and a failed request. Old and new were drawn
  in jsdom, each in its own process. 16 came out identical. The 17th differs
  only by `loading="lazy"` on the file thumbnails: the old code set it as a
  property, which jsdom doesn't reflect into the markup and Chromium does
  (checked), so in a browser they're identical.
- Bytes: the lightbox chunk went from 10.8 to 11.5 kB gzipped, the main bundle
  about the same: about 0.7 kB in all.

**Second pass (2026-10-04).** The user said "2nd pass". Two read-only
reviewers, never shown the plan: one read the panel's code against the
frontend before the stage; the other read the shared pieces, their other
callers and the tests. Each finding was re-read in the code, and each
behavioral one got a test that fails without its fix.

Fixed, each brought in by Stage 2 unless it says otherwise:

- Paging between two cards that show the same file wiped the object boxes
  off the picture for good. A board that classifies puts a file in every card
  that claimed it. Mounting the stage cleared the boxes, and the details
  hadn't changed, so nothing drew them again. The panel before the stage
  drew them on every paint. Now one place draws them, from the shown file's
  details, before the panel, so a panel that fails to draw can't leave the
  last file's boxes over the next picture either.
- A pinned panel slid in when the lightbox opened on a card with files to
  list. Drawing the panel reads layout (its file list's scroll), and the panel
  was drawn before its class was set, so the browser saw it closed first.
  The class goes first again, as before the stage.
- The keyboard could land on a leg button several cards later. With it on
  Re-extract (or Re-transcribe), page to a file without one and keep paging,
  and the next file that had one took the keyboard, where Space would queue
  billed work. The next file's half now lets go of it once drawn.
- Escape while the next file's details were on their way left the keyboard
  nowhere, since the move had taken the button it was on. It goes to
  Details, as closing from inside the panel does.
- Field formats after a failed load. The panel before the stage asked for
  the field catalog with every file's details, which also asked again after
  a failed ask at page load. Stage 2 dropped that, so after a failed load a
  file field printed raw (2,211.6 rather than 36:51). It asks again with the
  details, and the half draws once, formatted.
- Retag kept saying it opens a menu after its file could no longer be scoped.
  The menu writes its marks on the button as it opens, and the button now
  outlives the menu. It says so itself while it has a menu, and drops the
  marks with it.
- Tests:
  - list-keyboard's focus test raced the held details (400ms) with fixed
    sleeps of 500, 100 and 600ms. Its "through the fetch's paint" check could
    run before the paint. It waits for Retag instead.
  - The two refusal tests held the polls only after opening the card, so a
    poll already out could bring the change made elsewhere. They hold them
    from the board's load (`openBoard`'s new `before`).
  - `nextPoll` waited two frames after the poll's answer. It now waits for
    the board's token count, which a poll asks for only after its merge has
    drawn.
- Smaller:
  - `removeInstance` no longer answers, since nothing read it.
  - The panel uses data.js's `IN_FLIGHT`, now exported, rather than a copy.
  - Its `relTime` is utils.js's, plus "just now".
  - `keepPlace` no longer forwards arguments. The panel was its last caller,
    and its test for that went.
  - Comments fixed: face-select.js's consumers; modal.js's `busy()` (the
    lightbox no longer uses it); styles.css (`FacetCell`); server.js's details
    route; worker.js's undecided note; dropdown.css on `aria-haspopup`; the
    lightbox's effect (it draws the panel only while it's open); and the
    test file's rule for `land`.
  - "A file-less item (a ticker tile)" was wrong too: a ticker has a file
    entry, its connector vehicle. Only a card caught mid-merge has none.

Open, for the user: the scroll on a move (D11 above). The plan said the old
rebuild reset it, and it didn't.

Declined:

- On a refused removal the toast is the server's own words, "not found" or
  "login required" among them. D8 took the rows view's version, which already
  did this.
- The guards behind `disabled` (`FileRow`'s busy check, `queueLeg`'s): kept.
- One helper for "the details landed" across the tests: each test waits on
  what it needs next.
- Cleanup in `finally`: each test owns its own cards, on the file's own server.
- Setup waits that end in a timeout rather than an assertion.
- The header's download, written only on a move: Stage 3 moves it to the
  file rows.
- Moving the overlay clear from `setPanel` to `closeLightbox`: no fewer
  lines, and it would need a test of its own.
- Recorded under "Not in this plan": a poll asked before a click's write and
  answered after it can end "Queued" early.

Tests: six new, five "Stays true" (the shared file's boxes, the pinned panel,
the keyboard paging on, Escape mid-wait, the formats) and one "Fixed in
Stage 2" (Retag's menu marks). Against the frontend before the stage, the
eight "Fixed in Stage 2" tests fail and the other 23 pass.

Checks, 13 of 13 failing on the intended line, files restored by hash after
each:

- Each of the six fixes taken back out fails its new test.
- The details landing on a tree made anew fails list-keyboard's "through the
  fetch's paint", which can't run early any more.
- Stage 2's removals whose tests this pass changed: the keyboard hand-back
  (list-keyboard's new waits), the old "Queued" and the panel's own words on
  a refused removal (polls held from the load), and the details asked again
  mid-retag, the chips drawn live and "Queued" never ending (`nextPoll`'s new
  sign).
- The panel's boxes drawn after it rather than before it has no test: it takes
  a panel that fails to draw.

Runs: the lightbox file 31/31; list-keyboard, keep-place and cached-counts
42/42; `npm test` 2,368/2,368 (lint included, ~213s); the browser suite on
the built frontend 210/210. The lightbox chunk is 11.3 kB gzipped. No test
process left behind. Line endings as checked out (lightbox.js, face-select.js,
server.js and worker.js CRLF; the rest LF). Still owed by eye on compose: the
panel opening at prod's latency, and from Stage 1 a clip and the Details
tooltip through a poll.

### Stage 3 — download on the file rows

- D9, the file info's "file" row on connector items included.
- Tests: Stage 0's three flip. The Tab walk has Download after "Close panel".
  Each file row's link carries its own file's address and name; a one-file
  item's link sits on the name row; a stock with a chart face has none.
  From the close look: a click on a row's link leaves the shown file alone,
  and an SVG's download saves as `.webp`.

**Close look (2026-10-04).** The header's link, the file rows, the server's
file entries and the tests, read against D9. What changed the plan:

- An SVG upload is stored as WebP
  ([sources/image.js:60-66](../server/sources/image.js#L60-L66)), so "the
  original name, as now" saved WebP under `.svg`, a file that won't open. It
  saves as `.webp` (D9).
- "A connector item" is a per-file fact in the page: a ticker's placeholder
  ([db.js:238-242](../server/db.js#L238-L242)) or a chart the app drew
  ([worker.js:1019-1036](../server/worker.js#L1019-L1036)). One check per
  file (D9).
- Smaller: the link stops its click, since the row's click picks the file;
  the shared box keeps the remove button's class, which a jsdom test and four
  browser tests find it by; the name row becomes a two-part row; the header
  link goes from `index.html`, two CSS selectors and three lines of
  lightbox.js, and only list-keyboard's walk and this file's `downloads`
  helper read it.
- Offered, not taken up: naming the remove buttons per file.

Confirmed: Stage 0's three tests flip as planned; list-keyboard's "Item 30"
has one file, so its walk becomes pin, close, "Download item-30.jpg", Retag;
the gallery is same-origin, so the link names the saved file, and documents
and audio save their originals; nothing else reads the header's link.

**Built (2026-10-04).** The user said "go ahead", with the SVG and per-file
amendments as proposed; naming the remove buttons wasn't taken up. D9 and
this stage were amended first.

- [lightbox-panel.js](../public/lightbox-panel.js):
  - `ownFile`: a file of the board's own, neither a ticker's placeholder
    (`kind: "connector"`) nor a chart the app drew (`generated`).
  - `savedName`: the original name, except an SVG stored as WebP, which saves
    as `.webp`.
  - `Download`: a same-origin link named for its file ("Download
    pair-a.jpg"), its click kept from the row.
  - A download on each file row, before remove. A one-file item's sits at the
    end of its name. The "file" info row is shown only for a file of the
    board's own.
- The header's link is gone: from [index.html](../public/index.html), from
  [lightbox.js](../public/lightbox.js) (its lookup, its writer on a move, its
  icon), and from the header's two CSS selectors.
- [styles.css](../public/styles.css): `.lbp-file-btn` is the box both of a
  file's buttons wear. The remove button keeps `.lbp-file-remove` and its red
  hover, and the download has a neutral one. The name row is a flex row, the
  name taking the room.
- Tests:
  - Stage 0's three flipped to "Fixed in Stage 3".
  - Four new: a one-file item's download on its name; a stock whose face is
    its chart offers none and names no file; a row's download saves that file
    (the browser's own download, by its name) and leaves the shown file; an
    SVG saves as `.webp`.
  - list-keyboard: the walk has "Download item-30.jpg" after "Close panel".
    The focus test's Tab from a file's name now lands on its download, before
    remove as D9 puts it, so the download is the control that holds the focus
    through the details' paint.
- Against the frontend before the stage, the seven "Fixed in Stage 3" tests
  fail and the other 28 pass.
- Removal checks, each a fix taken back out, every one failing its test on
  the intended line, 10 of 10:
  - no download on the rows, and the header's link left in (the Pair test);
  - none on a one-file item's name (its test, and list-keyboard's walk);
  - a ticker's placeholder, and then the app's chart, counted as files;
  - the "file" row for every file;
  - the link's click reaching the row (the shown file switches);
  - the original name, SVG or not;
  - and Stage 2's second-pass check of list-keyboard's paint line again, its
    control now the download.
- Screenshots in the harness: a one-file item with a name long enough to
  wrap has its download at the top right of the name; a three-file item has
  a download and a trash box on each row, and the download's hover is grey,
  not red.
- Runs: the lightbox file 35/35; list-keyboard and cached-counts 33/33;
  `npm test` 2,372/2,372 (lint included, ~204s); the browser suite on the
  built frontend 214/214. The lightbox chunk is 11.5 kB gzipped (11.3 before
  the stage). No test process left behind. Line endings as checked out
  (index.html and lightbox.js CRLF, the rest LF).
- Owed by eye on compose: a download saved from a real board (the browser's
  own save, under the original name), and as before, the panel opening at
  prod's latency, a clip and the Details tooltip through a poll.

### Stage 4 — second pass

Fast, per the method: re-read what shipped against the pre-arc code, fix and
simplify, a test per fix, the suites.

**Done (2026-10-04).** The user said "stage 4". Two read-only reviewers, never
shown the plan, compared everything against git HEAD, the code before the
arc: one the lightbox as a user meets it, for each kind of card; the other
the shared pieces, their other callers and the tests. Each finding was re-read
in the code.

Fixed:

- A file change brought by a poll (the shown file removed elsewhere, say)
  closed the crate menu too, and a crate name being typed with it. Stage 1's
  second pass had a move close any menu. Another file of the same item now
  closes only the panel's menu (Retag's, which was for the file left), and
  another item closes any. `closeDropdown` takes an optional `within`.
- Since Stage 2's second pass the file's half waited for the field formats as
  well as its details, so a formats request that hung kept the tags and Retag
  from drawing. The panel still asks for them again, without waiting, and the
  fields reprint when they land.
- A menu still up when Retag lost it (its file went into the queue) wrote
  "collapsed" back onto a plain button as it closed. A menu now leaves alone
  a button that took its marks off.
- An SVG's link said "Download logo.svg" and saved `logo.webp`. It now says
  what it saves.
- Tests:
  - The formats test could pass without the panel's own ask. The page loaded
    once before the test's routes were in, and that first load could take
    the one refusal. `openBoard` now starts on `/api/me`, puts the routes in,
    then opens the board, as sorted-load does: one load per test.
  - list-keyboard's focus test leaned on a 400ms hold. The hold is explicit
    now, released once the keyboard has moved on.
  - The refused-removal test read the toasts as soon as any came up. It waits
    for the server's own sentence (`toastSays`).
  - The Escape test checks first that the move left the keyboard on nothing.
  - The two ticker tests are one.
- Simplified:
  - `detailsOf(file)`, the snapshot if it's that file's, used by `followFile`,
    the effect and the panel; `fileDetails` is no longer exported.
  - The effect reads the selected file once.
  - `endQueued` reads with `peek`, one draw fewer when "Queued" ends.
  - The tests got `menuGone` and `toastSays`, and the harness's `PIXEL` is no
    longer exported.

Recorded, not fixed:

- The styles for the detected-object list (`.lbp-det-list`, a 3px gap, and
  `.lbp-det-empty`, the "nothing detected" line in grey) had never reached
  the page. The old code set the classes and overwrote them a few lines
  later, ever since object detection came in (2026-08-01). The user: "it's
  fine the way it is", so the two rules are deleted and the look stays.
- The count pill counts cards that paging skips (Stage 1). It reads 3 / 10,
  then 5 / 10 when the card between has left the page. Rare.
- Paging between two cards that share a file, with the keyboard on a file's
  row, drops the keyboard: each card's list is made anew, so it starts at its
  top (D11). Before the arc a row of the same file took it back.
- A transcript that lands while its clip is open shows after a move, not
  before. Clicking the shown file's row in a multi-file card used to mount
  the stage again; D3 keeps it.
- Details that hang leave "Loading…" for as long as the request does (D11).
- The scroll on a move, open since Stage 2's second pass: the user said "keep
  the place" (D11). The effect no longer puts the panel at its top, and the
  test of a move became "Stays true: a move keeps the panel's place", with
  the reset put back as its removal check.
- That shipped in 74bf9cf still losing the place on a photo board, and the
  user saw it ("now it doesn't"). The move test scrolled Long A and Long B,
  whose own half (thirty connector fields) scrolls by itself, so it never
  met the usual case: a photo whose fields and tags are what scrolls. Those
  wait for the next file's details (D11), "Loading…" leaves the panel
  short, and the browser pulls the scroll up to fit, where it stays when the
  details land. Measured in the harness: 600 before the move, 0 after it.
  Now the panel's "Loading…" keeps the height of the file's half it takes
  the place of: the half sits in one wrapper (`.lbp-file-half`), and while
  it waits the wrapper's min-height is the height it had, read as the wait
  takes over; the half's own draw drops it. A first version held the height
  from outside, in lightbox.js, with an empty block at the end of the
  panel's content; the user asked "is it hacky?", and it was: it measured
  the whole panel, repeated the panel's own "is the half drawn" check to
  let go, and needed guards. Padding on the panel didn't do it either: the
  panel grew to fit the padding instead of scrolling, and the place came
  out at 169. The wrapper changes nothing on screen: screenshots of a busy
  panel, a parked one and an undecided one are the same bytes before and
  after. New test: "a move keeps the panel's place when it's the file's
  half you've scrolled", with the next file's details held, so it checks
  the place during "Loading…" and after it, and that no room is held once
  they've landed. Removal checks, 3 of 3: no height held (the place goes
  during the wait), and the reset to the top put back, for both move tests.

Tests: three new (the crate menu through another file, the Retag menu closed
by one, field formats that never come) and one more for Retag's marks (a menu
still up when it loses them); the two ticker tests merged. The file has 38.

Checks, 14 of 14 failing on the intended line, files restored by hash after
each:

- Each fix of this stage taken back out fails its test: the menu's
  "collapsed" mark, the formats asked again, the half waiting for them, the
  crate menu closed by another file, the Retag menu left up by one, and the
  SVG link's name.
- The earlier removals whose tests this stage changed fail them again: the
  panel's own words on a refused removal, the old "Queued" and "Queued" never
  ending (their toast waits), Escape from inside the panel only (its new
  setup line), a ticker's placeholder as a file and the "file" row for every
  file (the merged ticker test), and list-keyboard's keyboard hand-back and
  paint check (its explicit hold).

Against the code before the arc (git HEAD), the whole file: all 25 "Fixed in
Stage N" tests fail, and 9 "Stays true" pass. The other 4 "Stays true" fail
on setup lines, never on what they check, because they set up with what the
arc added: the lightbox following a poll (3) and the details' wait (1).

Runs: `npm test` 2,375/2,375 (lint included, ~203s); the browser suite on
the built frontend 217/217. The lightbox chunk is 11.5 kB gzipped. No test
process left behind. Line endings as checked out (lightbox.js and dropdown.js
CRLF, the rest LF).

Owed by eye on compose, for the whole arc: the panel opening at prod's
latency; a clip, and the Details tooltip, through a poll; a download saved
from a real board.

## Not in this plan

- The uploads toast, Stage 6's other half (ui-updates plan).
- The board editor and the mapping pane, which also rebuild with `keepPlace`
  (ui-updates D9 named them the next candidates).
- A settled card deleted in another tab never leaving the page (older bug).
- The paging list following filter changes while the lightbox is open. It's a
  snapshot by design.
- Opening while already open, as when a `?item=` link is still loading and
  you click a card: the scroll lock is taken twice and given back once, so
  the page stays locked after closing (older bug, found by Stage 1's second
  pass).
- On a visit's first open, a click on a card swept while the lightbox's code
  was still loading does nothing and says nothing (older, and rare).
- A poll asked before a click's write and answered after it puts the card
  back as it was until the next poll: nothing in the merge knows the answer
  is older than the click (older, app-wide). Since Stage 2 the panel follows
  it too, so a Retag clicked then can lose "Queued" early and keep cleared
  reasons until the retag lands. It needs the card to have changed in the
  few seconds before the click, since a poll brings only changed cards
  (found by Stage 2's second pass).

## Cost

- Bytes: about nothing expected. Preact and the signals are already on the
  board page, and the lightbox is its own lazy chunk. Measured at each stage.
- Code: about 480 lines of panel rewritten as components, the workarounds
  above deleted, and one removal function instead of two.
- Risk: the panel has many states (the markup proof's list), which is why
  Stage 2 compares old and new across all of them.
