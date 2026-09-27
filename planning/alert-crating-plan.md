# Alert crating: each new match goes into a crate (2026-09-27)

**Status: all four stages BUILT 2026-09-27, and a simplification pass done
(uncommitted). All four decisions settled 2026-09-27.**

## The ask

In the alert editor, a switch that turns on "put what this alert matches into
a crate". It uses the same crate picker as the gallery, and you can make a new
crate from it.

## What's there today

### Alerts

- Matching happens the moment an item's tags land: `evaluateItemAlerts`
  (server/alerts.js:71). It's called from the worker's tag and extraction
  steps (worker.js:2444, 2511, 2542, 2856), from upload admission
  (ingest.js:114) and from the manual tag edit (server.js:3339).
- For each alert that matches, `addAlertMatch` (db.js:4515) records one row
  per (alert, card), ever, and returns true only when the match is new. Cards
  that already matched when the alert was made are recorded up front as a
  "baseline" (db.js:4524), so they never count as new.
- `boardAlerts` (db.js:4468) only returns alerts that are switched on and
  whose owner can still see the board (`ALERT_OWNER_ACCESS`, db.js:4463). It
  selects just `id` and `condition`.
- Grouping matches into a firing, and delivering it, happen later on the
  worker's maintenance tick. Record only still makes firings; it just never
  sends.
- The alerts table (migrations/0023_alerts.sql:8) has no crate column. The
  next migration is 0054.

### Crates

- A crate belongs to one person on one board: `crates(user_id, board_id,
  name, public)`, with the name unique per person and board
  (migrations/0001_baseline.sql:217). It holds cards, not files:
  `crate_items.item_id` is a card (entity) id, despite its name
  (baseline:242).
- Only the owner can put things in a crate (db.js:1528, 1551). A public crate
  can be seen by the board's members, but not written to by them.
- `addCrateItems(db, userId, crateId, ids)` (db.js:1527) is the add-only
  writer. It checks the owner, keeps only cards on the crate's board, does
  nothing on a repeat, and marks the added cards as changed so open galleries
  pick them up. The agents' `save_to_crate` tool (mcp-tools.js:767) already
  uses it on a member's behalf. The checkbox writer, `toggleCrateItem`
  (db.js:1550), must not be used here, because a second call takes the card
  back out.
- Deleting a crate removes its contents. Deleting a board or a user removes
  their crates.
- **A bug that exists today.** When extraction merges a card into an existing
  one, the emptied card is deleted and its crate places go with it
  (worker.js:2804-2805, then `reconcileEntities` deletes the empty card,
  db.js:3158).
  - The worker already renames a single-file card in place so that "hearts/crate
    survive the identity change" (worker.js:2789). A move into a different,
    existing card still loses them.
  - The split path, which puts each file back on its own card
    (worker.js:2832-2833), gives the new card none of the old card's crates.
  - Alerts avoid this by looking up where the content lives now at read time
    (db.js:4689). Crates don't.

### Live updates

- The worker deliberately never sends live events (server.js:394-397). While
  it's busy, every open gallery already checks in every 4 seconds
  (data.js:350). `addCrateItems` marks the card as changed, so its new crate
  place arrives with the next check-in. The crate view filters on each card's
  own crate list (filters.js:153).
- The gallery never shows crate counts. `item_count` sits in the client's crate
  list, but nothing displays it. So the crate list doesn't need refreshing,
  and **no new event plumbing is needed.**

### The picker

- There's no reusable "choose a crate" control. There are two pickers:
  - `openCratePop(anchor, item)` (crates.js:196), on cards and in the
    lightbox. It shows a checkbox per crate, each click puts the card in or
    takes it out straight away, and the menu stays open. With no card it's the
    toolbar's crate filter. It never hands back a chosen crate.
  - The bulk bar's private `openBulkCratePop` (bulk.js:144). It shows a row
    per crate of yours; a click picks one and runs the bulk add. Its "New
    crate…" box repeats the create request that crates.js:165 also makes.
- Both are built on `openDropdown` (dropdown.js), which already works inside
  a modal:
  - it sits above the modal's overlay;
  - Escape closes it without closing the modal;
  - closing it fires `change` on the button that opened it, which the alert
    editor's Save check hears.
- `.dd-trigger` (dropdown.css:500) is the select-looking button that opens
  one. The mapping and ingest modals already use it.
- Making a crate: `POST /api/crates {name, board_id}` finds an existing crate
  with that name or creates one (db.js:1417), and tells every open tab
  (server.js:692).
- Reported by the read, to confirm in Stage 2: in the card menu, pressing
  Enter twice in "New crate…" sends the add twice. Because adding there
  toggles, the second one can take the card back out.
  - **Confirmed by the Stage 2 close look (2026-09-27), and wider.** Run
    against a stand-in server that behaves like the real one: Enter twice
    in the card menu leaves the card out of the new crate; in the bulk bar,
    every selected card ends up out. Each Enter makes the crate (the second
    finds the first by name) and sends its own toggle.
  - **A second bug of the same kind.** In the card menu, typing the name of
    a crate the card is already in takes the card out, with one Enter. The
    create finds that crate by name, and the menu then toggles. The bulk bar
    checks "already in?" before toggling; the card menu doesn't.
  - The cause of both: the gallery's only way to add a card to a crate is the
    checkbox's toggle. The server's add-only writer, `addCrateItems`, has
    no route; only the AI agents' tool reaches it.

## Target

### What you see

A new **Crate** section in the alert editor:

- Heading "Crate", with the line "Each new match goes into a crate — with any
  delivery, Record only too."
- A switch, "Add matches to a crate". Off hides the picker, the same way the
  webhook switch works.
- When on, a picker button showing the chosen crate, or "Select a crate…" when
  none is chosen. It opens the shared crate picker: your crates on this board,
  the chosen one marked, and "New crate…" at the bottom.
  - Compact and left-aligned, like the Delivery dropdown beside it, with the
    menu opening from its left edge (the picker's `align: "start"`).
    Decided after the Stage 4 close look (2026-09-27).
- Saving with the switch on and no crate chosen is refused with "Pick a crate".
- An alert whose crate has since been deleted opens with the switch off.
- **The editor sends `crate_id` only when the crate choice changed** from what
  it opened with. Amended after the Stage 4 close look (2026-09-27).
  - The editor can only tell a crate is gone by looking it up in the page's
    crate list. If that list is behind (the crate was set up in another tab,
    and the live update hasn't arrived), the alert opens "off".
  - Sent every time, "off" would clear a crate nobody touched, on any rename.
    Left out means "keep" on the server (Stage 3), so an unchanged choice is
    left out.

### Server

- **Migration 0054:** `alerts.crate_id BIGINT REFERENCES crates(id) ON
  DELETE SET NULL`.
  - "On" means a crate is set. There's no separate flag, the same as the
    webhook's URL.
  - Deleting the crate turns crating off.
- **Alert body:** `crate_id`. Left out keeps the current crate, `null` clears
  it, an id sets it. It must be a crate you own on the alert's board;
  otherwise the save gets a 400 "crate not found".
  - Amended after the Stage 3 close look (2026-09-27): the body parser never
    touches the database, so the ownership check sits in the create and edit
    routes, before the write.
  - A crate deleted between that check and the write makes the database
    refuse the link. That answers "crate not found" too, not a 500, the way
    a duplicate name already answers.
  - "Left out keeps" is also what lets this stage ship before the editor:
    today's editor sends every field but `crate_id`, so saving an alert
    can't clear its crate.
- `alertJson` and `listAlerts` carry `crate_id`.
- **The hook:** `boardAlerts` also selects `user_id` and `crate_id`. In
  `evaluateItemAlerts`, when `addAlertMatch` says the match is new and the
  alert has a crate, call `addCrateItems(db, a.user_id, a.crate_id,
  [entityId])`. That call gets its own try/catch, so one crate failing (for
  example, deleted mid-call) can't skip the other alerts' matches.
- **What that gives for free:**
  - Only new matches go in; baseline cards never do.
  - It stops when the alert is switched off, or when its owner loses access
    to the board.
  - It doesn't depend on delivery or the settle window. A card goes in the
    moment it matches, even for a daily digest.
  - **Crating follows the alert's news** (amended after the Stage 3 close
    look). A card you take out stays out, because a match is recorded once
    per card. But the alert can see a card as new again in two ways, and
    crating adds it again both times:
    - an edit that narrows the condition drops the matches not yet
      delivered, and a dropped card that matches again later is new again;
    - extraction moving the content onto a card that hasn't matched: the
      alert announces it again under that card (an existing quirk).

    Both are rare, and both are the alert's own behavior. Accepted.

### Merges

Amended after the close look (2026-09-27):

- **Crate places and hearts follow the content.** When extraction moves a file
  from card A to card B, whether a merge or a split, B joins A's crates and
  gets A's hearts.
- **Only from cards the file left, to cards it joined.** On a "Match to a
  list" board one file can sit on several cards. A file that stays on A and
  also joins B hasn't left A, so B inherits nothing.
- **On every move, not only when A ends up empty.** Two files leaving the same
  card at the same moment each still see the other, so neither move deletes
  the card; it's cleaned up later, and its places go then. A copy that waited
  for "this emptied A" would miss both.
- If A survives, it keeps its own places. A carried place keeps its original
  date.
- **One function does the whole move:** set the file's cards, carry the
  places, clean up whatever emptied, all in one transaction. Both worker
  paths call it, so the carry can't be skipped. It replaces the two copies of
  "set the cards, then clean up" (worker.js:2804-2805 and 2832-2833).
- Why hearts are in: they're lost the same way, in the same two places, and
  the worker's own comment names "hearts/crate" as what it protects.

### The picker

Amended after the Stage 2 close look (2026-09-27):

- **`openCratePicker(anchor, { activeId, onPick, align })`** in crates.js:
  the bulk bar's picker, promoted. It lists your crates with `activeId`
  marked and "New crate…" at the bottom. Picking one closes the menu and
  calls `onPick(crate)`.
  - It returns the menu, so the bulk bar can still close it when the
    selection empties.
  - The divider above "New crate…" follows your crates, the same list the
    menu shows. Today's bulk menu draws it when anyone has a crate, which
    leaves a line over an empty list.
  - `align` comes from the caller: the bulk bar's button sits at the right
    end, the editor's will sit on the left.
- **`createCrate(name)`** in crates.js: the one create request (POST, then add
  it to `state.crates` if it's missing). It replaces the two copies
  (crates.js:165-178, bulk.js:164-173).
- **The double Enter is stopped at the text box, not the create request.**
  `ddInput` ignores Enter while its last submit is still working. A guard on
  the create can't fix it: both creates come back with the same crate, and
  each caller then runs its add twice. The one spot covers the card menu, the
  picker, and saved filters (where a double Enter just saves twice).
- **An add-only route: `POST /api/crates/:id/items {ids}`.** It wraps
  `addCrateItems`, so it's owner-only, keeps only cards on the crate's board,
  and does nothing on a repeat. It checks board access the way the toggle
  route does, and tells open tabs about both the list and the cards.
  - `addToCrate(crateId, items)` in crates.js calls it, and marks the cards
    in on success.
  - The bulk bar sends one request for all selected cards instead of one per
    card, and drops its "already in?" check. The toast comes from the answer.
  - The card menu's "New crate…" creates, then adds. It never toggles, so an
    existing name keeps the card in.
  - The checkbox rows stay toggles; that's what a checkbox is.
  - Stage 3's alert hook calls the same `addCrateItems`, so the gallery and
    alerts share one way in.
- The bulk bar becomes `openCratePicker(btn, { onPick: addAllToCrate })`.
- The card and lightbox checkbox menu stays as it is, because it does a
  different job: several crates, toggling, staying open. Its create goes
  through `createCrate` and `addToCrate`.

## Stages

1. **Crate places and hearts follow a merge.** The one move function, and
   both worker paths call it. This fixes a bug that exists today.
   - Close look (2026-09-27) changed four things: carry only from cards the
     file left to cards it joined; carry on every move; include hearts; fold
     the move into one function. See "Merges" above.
   - Proof at the function level:
     - merge: the surviving card is in the crate and keeps the hearts, with
       the original dates;
     - split: the new card is in the crate, and the old one keeps its place;
     - a file that only gains a second card carries nothing.
   - Proof through the real worker, with a stand-in AI (the way
     test/detect.test.js drives the extract step): a merge and a split each
     end with the receiving card in the crate.
   - Each proof is run with its piece of the fix removed.

   **Built.** `moveInstance(db, itemId, oldIds, newIds)` in db.js (next to
   `reconcileEntities`) does the move, the carry and the cleanup in one
   transaction. Both worker spots call it (worker.js, the card-key branch and
   the one-card-per-file branch). The worker no longer imports
   `setItemEntities`, `reconcileEntities` or `withTx`.
   - Function-level proofs are in test/derived-identity.test.js: the merge,
     the split (the old card keeps its places, so this is also the "every
     move" case), and "Match to a list" carrying nothing. Dates are fixed at
     insert, and the carried places keep them.
   - The worker-level proof is the new test/crate-places-worker.test.js. It
     runs a live worker with a stand-in Anthropic server behind
     `ANTHROPIC_BASE_URL` (alerts-worker.test.js's pattern), answering
     `record_fields`. The log confirms a real merge ("identity=[ada lovelace]
     (membership changed)") and a real split ("own card again").
   - Removal checks, each run against both files:
     - no carry at all: 4 fail (both function proofs, both worker proofs);
     - crate half only: the same 4 fail;
     - hearts half only: the same 4 fail;
     - carrying from all old cards to all new ones: only the "Match to a
       list" proof fails;
     - the old two-line code back at the merge spot: only the worker merge
       proof fails;
     - the old code back at the split spot: only the worker split proof
       fails.
   - Found while building: a worker-level extraction test needs the image's
     thumbnail on disk too (`thumbnails/<name>.webp`), because the extract
     step's image input reads it. The first run failed with ENOENT on it. The
     detect test never hit this, since its step doesn't read thumbnails.
   - The merge and split wiring had no automated coverage before;
     derived-identity.test.js's header said it was "exercised in the live
     verify". That header now points at the new test.
   - Full suite: 2093/2093.
2. **The shared picker, and adds that only add.** `openCratePicker`,
   `createCrate`, `addToCrate` and the add-only route; the bulk bar moves onto
   them. In the gallery, the double Enter and the existing-name bug are
   fixed, and the bulk add becomes one request.
   - Close look (2026-09-27) changed four things: the double-Enter guard
     moves to the text box; the add-only route, used by the bulk bar and the
     card menu's create; the picker returns its menu and takes `align`; the
     divider follows your own crates. See "The picker" above.
   - Proof: the existing crate menu and bulk tests pass. Tests that stub the
     toggle for an add move to the add route. The bulk test that checked
     "each card joins as its answer lands" becomes "all join when the one
     answer lands".
   - New tests:
     - card menu: a double Enter on "New crate…" makes one crate and the
       card ends up in it; an existing name keeps the card in;
     - the picker: it lists only your crates, marks the chosen one, calls
       back once on a pick, a double Enter on "New crate…" creates one crate
       and picks it, and there's no divider over an empty list;
     - the bulk bar: one request for every selected card, and all of them
       join;
     - the route: it adds; a repeat adds nothing; it refuses another
       person's crate, bad ids, and someone who's lost access to the board;
       it ignores a card from another board; it tells open tabs about the
       list and the cards.
   - A browser check that the bulk add still works, through the real server.
   - Each proof is run with its fix removed.

   **Built.**
   - `ddInput` (dropdown.js) ignores Enter while its last submit is still
     working.
   - `POST /api/crates/:id/items {ids}` (server.js) wraps `addCrateItems`. A
     new `getCrateBoard` (db.js) gives it the crate's board before it writes,
     to check access and to announce. Bad ids get a 400; a crate that isn't
     yours, or one on a board you've lost, gets a 404.
   - crates.js has `createCrate`, `addToCrate` and `openCratePicker`. The
     card menu's "New crate…" is now create, then add.
   - bulk.js uses the picker and sends one add for the whole selection. The
     toasts come from the answer ("Added N" or "Already in"). The error is
     now "Couldn't add to crate": one request, so there's no "N of M" left.
   - `align` has no caller yet. The editor is its first, in Stage 4.
   - Found while building: making a crate from the lightbox's crate menu
     never updated the count on the lightbox's crate button. Only the
     checkbox rows told it; the create path didn't. `addToCrate` tells it
     now. Proof: the new browser test. Without the fix, the count never
     appears.
   - Found while building: crate-pop.test.js's "no error toast" check read
     every toast on the page, so one test's error failed the tests after it.
     The first removal run showed 7 failures where 3 were real. Each test now
     starts with no toasts up.
   - Existing tests moved:
     - crate-pop's create test stubs the add route;
     - cached-counts' bulk test is now "they join when the answer lands";
     - ui-updates' "Crates button the moment it exists" browser test watches
       for either crate URL.
   - New tests:
     - 6 in crate-pop.test.js: card menu ×2, picker ×3, bulk ×1;
     - 5 in the new test/crate-add.test.js (the route);
     - 1 in events.test.js;
     - 2 in the new test/browser/crates.test.js: the bulk add through the
       real server, and the lightbox count.
   - Removal checks, 13, each run against the tests meant to catch it:
     - no text-box guard: both double-Enter tests fail;
     - the card menu toggling after "New crate…" again: the existing-name
       test, the create test and the lightbox browser test;
     - the bulk bar back to one toggle per card: both bulk tests. The
       browser test still passes, because the old way works while the page
       is up to date. Stage 3 is what makes the page lag.
     - the picker listing everyone's crates: the list test and the divider
       test;
     - the picker marking nothing: the list test;
     - the divider over everyone's crates: the divider test;
     - adds not marking the cards in: 4 (the create test, the card menu's
       double Enter, both bulk tests);
     - no word to the lightbox after an add: the lightbox browser test;
     - the route without its board-access check: the lost-access test;
     - the route without its ids check: the bad-ids test;
     - the route not announcing the cards, or not the list: the events test,
       each time;
     - the route gone: 6 (both browser tests, 3 route tests, the events
       test). The not-yours and lost-access tests still pass, since a
       missing route answers 404 too.
   - Full suite, browser tests included: 2107/2107 (Stage 1's 2093 plus the
     14 new tests).
3. **Alerts put their matches in the crate (server).** The migration, the
   save rules, `boardAlerts`, the hook. Proof in test/alerts.test.js:
   - a new match lands in the crate, from a Record only alert too (the
     "with any delivery" promise);
   - a baseline card doesn't;
   - a switched-off alert doesn't;
   - nor does one whose owner was removed from the board;
   - another person's crate, or another board's, is refused at save, and so
     is a crate id that isn't one;
   - the save round trip: create, edit and the list all carry `crate_id`;
     left out keeps it, `null` clears it;
   - a crate deleted between the save's check and its write reads as "crate
     not found";
   - deleting the crate clears the alert's crate;
   - a crate write that fails doesn't stop the rest of the matching;
   - a card you took out isn't put back by a re-tag.

   Each is run with its fix removed.
   - Close look (2026-09-27) changed three things:
     - The planned proof for "one crate failing can't skip the rest" didn't
       test it. Deleting the crate clears the alert's crate, so no write is
       tried, and a write to a crate that's gone returns quietly; only a race
       makes it throw. The proof now forces the failure with a test-only
       trigger that refuses one card. The file sits on two cards ("Match to
       a list"), and the second card must still get its match and its crate
       place. Two cards, not two alerts: the order alerts are checked in
       isn't fixed, but a file's cards are in a fixed order.
     - The save check moves into the routes, and the race answers "crate not
       found" (see "Server" above).
     - "Stays out" became "crating follows the alert's news" (same place).

   **Built.**
   - Migration 0054 adds `alerts.crate_id`: a link to the crate, cleared
     when the crate is deleted. The link is named (`alerts_crate_id_fkey`)
     because the save routes read the name.
   - db.js: `boardAlerts` brings the owner and the crate. `listAlerts`,
     `createAlert` and `updateAlert` carry `crate_id`.
   - server.js:
     - `parseAlertBody` reads `crate_id`: left out keeps it, `null` clears
       it, an id sets it, and anything else is "crate not found";
     - `ownsAlertCrate` checks the crate in both routes, before the write;
     - `crateGone` turns the race into "crate not found";
     - `alertJson` carries `crate_id`.
   - alerts.js: the hook runs after a new match, with its own catch.
   - 10 new tests, in the "crating:" section of alerts.test.js. The two
     forced failures use test-only triggers, dropped again in a `finally`:
     one refuses a card's crate place, the other deletes the crate as the
     alert row is written.
   - planning/alerts-plan.md's schema block gains the column.
   - Removal checks, 19, each run against alerts.test.js:
     - no crate write in the hook: 5 fail (the new match, the baseline, the
       owner coming back, the forced failure, the card taken out);
     - crating every match, not only new ones: the baseline test and the
       taken-out test;
     - no catch around the crate write: the forced-failure test;
     - `boardAlerts` not bringing the owner and the crate: the same 5 as no
       write;
     - `boardAlerts` without its enabled check: the switched-off test, and
       the existing "a disabled alert stops matching";
     - without its owner-access check: the owner-left test, and the
       existing dormancy test;
     - no ownership check at create, or at edit: the refusals test, each
       time;
     - junk crate ids reaching the database: the refusals test;
     - "left out" clearing instead of keeping: the round-trip test;
     - `alertJson` without `crate_id`: 5, every test that reads it back;
     - `listAlerts` without it: the round-trip test;
     - `createAlert` not writing it: 7, every test whose alert needs its
       crate from creation. That includes the race test, because a create
       that drops the crate succeeds;
     - `updateAlert` not writing it: the round-trip test, and the race
       test's edit half;
     - the migration with CASCADE, or with no delete rule: the "alert keeps
       watching" test, each time;
     - the link named differently: the race test, since the routes read the
       name;
     - the create's or the edit's race handling gone: the race test, each
       time.
   - Full suite, lint and browser tests included: 2117/2117 (Stage 2's 2107
     plus the 10 new tests).
4. **The editor.** The Crate section. The switch and the picker go in the
   editor's summary for Save. A save with no crate chosen is refused.
   - Close look (2026-09-27) changed three things:
     - **`crate_id` is sent only when the choice changed** (see "What you
       see"), so a page whose crate list is behind can't clear the crate on a
       rename.
     - **The test-only `__checkGate` check sees the switch, not the picker.**
       It watches switches, checkboxes, dropdown lists and toggle buttons; the
       picker is a plain button whose label changes. So picking a crate gets
       its own test. Teaching the check to watch pickers would also bring the
       board settings' template picker under it, and that label can change
       with nobody touching it (the connector list landing). Left for another
       time.
     - The picker is compact, like the Delivery dropdown.
   - Build notes from the close look: the crate section can't reuse the
     webhook's `.al-hook` (the tests find the webhook switch through it, and
     the crate section comes first); the two share one spacing rule instead.
   - Proof, editor tests:
     - the switch hides the picker, and saving it off sends `null`;
     - an alert whose crate is gone opens switched off, and a rename leaves
       `crate_id` out;
     - a rename with the crate untouched leaves `crate_id` out;
     - the switch alone lights Save, and saving it with no crate asks for one
       ("Pick a crate");
     - picking a different crate lights Save and saves its id;
     - a crate made from the picker gets chosen and saved, on a new alert;
     - Record only keeps the Crate section.
   - A real-browser run through the test harness: open the editor, make a new
     crate from the picker, save, tag an item so it matches, and see the card
     in that crate's view.
   - Each proof is run with its fix removed.

   **Built.**
   - alerts-modal.js: the Crate section after Condition. It has the heading,
     the switch "Add matches to a crate", and the picker button, hidden while
     the switch is off but keeping its choice.
     - The alert opens switched on only when its crate is in the page's list
       of your crates.
     - The editor's summary for Save carries the switch and the chosen crate.
     - "Pick a crate" refuses a save that's on with no crate.
     - The save sends `crate_id` only when the choice changed.
   - The picker button is a plain button that joins the modal's select rule
     in modal.css: the same box, arrow and text size as Delivery. It reads
     dim while it says "Select a crate…". Its spacing shares the webhook
     fields' rule.
   - Found while building: `.dd-trigger`, the menu-button style the board
     settings' template picker uses, came out visibly smaller than the
     Delivery dropdown beside it: 12px text and about 29px tall, against 14px
     and about 37px. Screenshots showed it.
     - The button wears the modal's select style instead.
     - A `ddTrigger()` helper, made to share that markup with the template
       picker, came back out once the editor stopped using it. The template
       picker is untouched.
   - Found while building: in the new-alert test, typing the name, flipping
     the switch and picking the crate landed in one burst. The save check
     reads a burst as one edit (its documented blind spot), so it couldn't
     see a forgotten switch there. The test now pauses after each edit.
   - Tests:
     - 7 new in alert-editor.test.js.
     - 1 new in test/browser/crates.test.js, the real run. It filters the
       board and opens "Alert on current filter…". It makes a crate from the
       picker, creates the alert, and retags a card through the tag route.
       The crate's view then shows that card, and not the one that matched
       before.
   - The look was checked with screenshots in Chromium: off, open, and
     picked.
   - Removal checks, 10:
     - the crate sent whether touched or not: the two "leaves `crate_id` out"
       tests;
     - the summary without the switch: the two tests that switch it on (in
       the new-alert test, the save check throws). The file's last test
       fails too: the throw ends the new-alert test early, and its save,
       still in flight, lands in the next test's capture;
     - the summary without the chosen crate: 4 (picking lights Save, and the
       three tests that save a crate);
     - no "Pick a crate" refusal: the switching-on test;
     - opening on whatever crate the alert names: the "can't find it" test;
     - the switch not hiding the picker: the switch test;
     - a pick not taken: the picking test and the new-alert test;
     - Record only hiding the section: the Record only test;
     - the prompt not marked as one: the switching-on test;
     - the save never carrying the crate: 4, including the browser run.
   - Full suite, lint and browser tests included: 2125/2125 (Stage 3's 2117
     plus the 8 new tests), on the third run. Each of the first two had one
     different timing test slip under the full run's load, and each passes
     alone: sidecar-latency's "50 resolves" (506ms against its limit), and
     the welcome page's "a configured instance…", the flake already seen
     after Stage 1. Neither touches this arc's code.

## Simplification pass (2026-09-27)

Four read-only reviewers read the arc's whole diff, one each for reuse,
simplification, wasted work, and fixes at the wrong depth, told to keep
behavior as it is. Every finding was re-read in the code before anything
changed.

**What went:**
- server.js: the pasted try/catch in both alert routes, for a crate deleted
  mid-save, is one `.catch(crateGone)` each. crateGone throws the 400 itself,
  a status on the error that the error middleware sends, the way
  previewWindow's errors do. Same status, same answer.
- server.js: `alertJson`'s `crate_id ?? null` is `crate_id`. Every row and
  every parsed body it gets already has one.
- db.js: `addCrateItems` and `toggleCrateItem` ask `getCrateBoard` whether the
  crate is yours, instead of each writing that query again.
- worker.js: the first move's comment repeated `moveInstance`'s own. It is now
  one line, like the second move's.
- crates.js:
  - `setCrateCount`: the count update that the toggle and the add both wrote
    out, comment and all;
  - `newCrateInput`: the "New crate…" box and the line over it, which the card
    menu and the picker both built;
  - `createCrate` and `addToCrate` send through `api()`, from api.js, which
    the file already imported from;
  - `createCrate` isn't exported, since nothing outside the file uses it.
- bulk.js: `closeBulkCratePop`, a one-line wrapper with one caller, is gone.
- Tests:
  - `placeCard` and `placesOf` were written twice, in derived-identity and the
    worker test, and the copies had already drifted. They are one copy in
    helpers.js, without the `Number()` calls the database's number parsing
    makes pointless;
  - the worker test uses helpers.js's `until` instead of its own copy;
  - the three "click the toasts away" helpers (board-modal-gate's, and the two
    this arc added) are one `clearToasts` in jsdom-stub.js: board-modal-gate's
    version, which also drains the queue and presses Dismiss;
  - the pixel the browser tests serve for cards without files is one
    `servePixels` in the harness, shared by ui-updates and crates;
  - alert-editor has one `tick` and one `setRecord`, each written once;
  - the events test seeds its cards with helpers.js's `seedInstance`;
  - the browser crate test uses its own `sorted`.
- Found by the reviewers: derived-identity's rollback test still built the
  worker's old move by hand (a transaction around the membership write and the
  reconcile), so nothing proved `moveInstance` rolls back, the carried places
  included. It now calls `moveInstance` and makes its last write fail, the
  delete of the emptied card, with a test-only trigger. It also checks that
  the winner got none of the places.

**Declined, and why:**
- A three-column link from alerts to crates (crate, owner, board) so the
  database holds the whole ownership rule. It needs Postgres 15 or later
  (`ON DELETE SET NULL (crate_id)`) and a new unique index on crates. That is
  a schema decision, not a cleanup.
- The page's crate count. Nothing on the page shows `item_count`, yet the
  toggle and the add both keep it. The add route's "crates" event also makes
  every open tab fetch the crate list again, only for that count. Retiring it
  (both writers, both events) changes behavior, so it is its own ask. The
  removal check below agrees: taking the count out fails no test, because
  nothing reads it.
- The lightbox's crate button reading the items signal instead of listening
  for `app:lightbox-crate-changed`. That is lightbox.js, and a behavior
  change: it would also follow deletes and polls.
- One positive-id check shared by the crate routes and `alertId`. Each crate
  route checks its id inline, so sharing it means touching all four and
  renaming `alertId`.
- One stub model server for the worker test and alerts-worker.test.js. That
  needs a new helper and changes to a test outside the arc.
- Skipping the events on an add that added nothing, and skipping the crate
  check on an edit that kept the crate. Each adds a condition to save one
  request.
- A shared `makeCrate`, or a shared sorted list of a crate's cards, across the
  alert, crate-add and browser tests. The copies differ (one checks the
  status), and each is a line or two.
- One helper for the editor's two "switch over hidden fields" sections, and
  one for its test's two switch finders. Two uses each, and no lines saved.

**Removal checks, 17** (each piece taken out, the tests run, the file restored
and compared byte for byte):
- `moveInstance` without its transaction: the rewritten rollback test;
- a move carrying no crate places, and one carrying no hearts: 4 each (the two
  `moveInstance` tests and the two worker tests, all on the shared helpers);
- `.catch(crateGone)` taken off create, then off edit: the race test each time;
- `alertJson` without `crate_id`: 5 alert tests;
- the add route not announcing "crates": the events test;
- `addToCrate` sending no cards: 5 (both browser files, crate-pop);
- `createCrate` not listing the new crate: 3;
- the "New crate…" box always under a line: the no-crates picker test;
- `clearToasts` doing nothing: 4 (alert-editor's "Pick a crate" test and three
  in board-modal-gate). crate-pop's tests pass without it: a clean run leaves no
  error toast behind, and the helper is there for a run that does;
- the draft without the crate switch: the same 3 as Stage 4, with the moved
  `tick`;
- four found a gap: nothing failed. Three of the gaps were there before this
  pass, and the pass had changed those lines, so each got a proof and was run
  again:
  - crateGone calling every failure a missing crate: new alert test, any other
    failure writing an alert is still a 500;
  - `addCrateItems` without its owner check: new crate-add test, it answers
    null for another person's crate when called directly (every caller checks
    first, so no route could show it);
  - `toggleCrateItem` without its owner check: new crate-add test, the checkbox
    route can't take a card out of another person's crate (that route asks
    only about the card's board);
  - the "New crate…" box never under a line: an assertion in the picker test
    that the line is there over a list.
- The count taken out of `setCrateCount` fails nothing, as said above.

Lint clean. Full suite, browser tests included: 2128/2128 on the first run
(Stage 4's 2125 plus the three new tests).

## Decisions

1. **A new crate made from the editor is created right away.** DECIDED
   2026-09-27. This is how the gallery works, and it's what the shared picker
   does. Cancel leaves an empty crate behind, and a first crate makes the
   toolbar's Crates button appear; both are accepted.
2. **The crate only collects new arrivals.** DECIDED 2026-09-27. An alert
   treats the cards that already match its filter when it's made as already
   seen, so with crating on the crate starts empty and fills as new matches
   arrive. To add the existing ones, select them in the gallery (the alert's
   filter is already on) and add them to the crate by hand, once. No "add the
   N that match now" option.
3. **The Crate section goes straight after Condition.** DECIDED 2026-09-27.
   It has nothing to do with delivery, and it stays visible when Record only
   hides the webhook.
4. **Stage 1 (crate places follow a merge) goes first.** DECIDED 2026-09-27.
   It fixes a bug every crate has today, and alert crating would hit it more
   often: a match made at upload lands on a card that extraction often merges
   away.

## Not touched

- Writing to someone else's public crate. Only your own crates can be written
  to, and the server enforces that.
- Showing "added to crate" in the alert history.
- MCP.
