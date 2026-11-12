# Comments on cards (2026-11-12)

Self-contained for a fresh session. Written after a look at how the app could
take comments, the user's four calls on it, and a clickable mock they liked.
Line links show the code at commit 1819253. Stages 1 to 4 are done,
uncommitted; each one's Built or Done block says what. Anything not yet checked
against the code says so, and each stage's close look checks it before
anything is built.

## The ask

- "look into a way for users to leave comments on items. let me know what you
  think." (with a screenshot of the lightbox and its Details panel)
- After the look, the user's calls on its four questions: "1. per card. 2. own
  view. 3. keep comments. 4. no." That is:
  1. Comments belong to the card (the entity), not to one of its files.
  2. They get their own view in the lightbox's side panel, beside Details, not
     a section inside it.
  3. When an account is deleted, its comments stay, signed "Former member".
  4. Nobody edits or deletes someone else's comment, admins included. Only
     the author can.
- "sure, mock it": https://claude.ai/artifact/4LwopPpnsGxVFWiuwMfk1o, a
  standalone page, nothing in the repo. Then: "i like it. plan it".

So the mock is the look to build. Its code is a stand-in and nothing is lifted
from it. Where this plan departs from the mock, it says so.

## What is actually happening

**Hearts are the closest thing the app has, and the template.**

- A heart is one row per person on the card: `favorites (user_id, item_id)`,
  where `item_id` holds an entity id for historic reasons
  ([0001_baseline.sql:206-215](../server/migrations/0001_baseline.sql#L206-L215)).
- Any member of the card's board can heart it. The routes sit behind
  `requireEntityAccess` ([server.js:675-684](../server/server.js#L675-L684)),
  which answers 404 for a card on a board you can't see
  ([server.js:442-450](../server/server.js#L442-L450)).
- The count rides the card itself. `listItems` joins a count per card
  ([db.js:288-293](../server/db.js#L288-L293)) and `toItem` keeps `hearts`
  and `favoritedByMe` on the page's card
  ([utils.js:47-48](../public/utils.js#L47-L48)). Every way a board loads
  goes through `listItems`: the full list, the sorted first page, the
  `?since=` delta and the MCP tools.
- A heart stamps its card (`touchEntity`,
  [db.js:1357-1359](../server/db.js#L1357-L1359)) so a delta returns it.
- Other viewers hear about it with no code of the heart's own. After any
  successful write that went through `requireEntityAccess`, one hook announces
  `items` to everyone watching the board
  ([server.js:414-425](../server/server.js#L414-L425)). Their page refetches
  the changed cards (`SLICES.items` in [events.js](../public/events.js)), and
  the card and the lightbox's heart redraw from the merged card
  ([data.js:244](../public/data.js#L244)).
- Who hearted a card shows by name, or by email when the account has no name
  ([db.js:1364-1371](../server/db.js#L1364-L1371)). `/api/me` sends no user
  id.

**Cards merge, split and disappear.**

- Re-extraction can move a file to another card: when the name the AI derives
  for it now matches another card (a merge), or when the board stops grouping
  and every file is its own card again. Both moves go through one function,
  `moveInstance` ([db.js:3212-3239](../server/db.js#L3212-L3239)), called from
  [worker.js:3172](../server/worker.js#L3172) and
  [worker.js:3198](../server/worker.js#L3198). Nothing else changes which card
  a file is on: `setItemEntities` has no other caller.
- A card that loses its last file is deleted, and its rows go with it (ON
  DELETE CASCADE). That's why `moveInstance` copies hearts and crate places
  from the cards a file left to the cards it joined, on every move and not
  only when the left card empties. Two files leaving the same card at once
  each still see the other inside their own transaction, so neither one's
  tidy-up deletes the card. It commits empty, and a later sweep deletes it
  ([db.js:3195-3211](../server/db.js#L3195-L3211); the sweep at
  [worker.js:3205](../server/worker.js#L3205) and `reapEmptyEntities` at
  [db.js:3248](../server/db.js#L3248)).
- When the file is its card's only one and its new name is new to the board,
  the card is renamed in place and keeps its id, so everything on it stays
  without a move ([worker.js:3161-3165](../server/worker.js#L3161-L3165);
  `resetEntityToShell` does the same going back to one card per file).
- Deleting a card deletes it outright
  ([db.js:3265](../server/db.js#L3265)), and removing a card's last file in
  the panel deletes the card too ([server.js:3644](../server/server.js#L3644)).
- Deleting an account cascades its hearts and crates
  ([db.js:1173-1176](../server/db.js#L1173-L1176)). Global admins can't be
  deleted that way.

**Who can see a board.** Its members and the global admins, nobody else.
There is no anonymous viewing ([db.js:2645-2653](../server/db.js#L2645-L2653)).
A board admin edits the board's settings and has no other powers over its
cards.

**The lightbox and its panel.**

- The panel is one aside with a header (the title "Details", the pin, ×) and
  a body ([index.html:39-48](../public/index.html#L39-L48)). What's in it is a
  Preact component, drawn by the lightbox's one effect while `panelOpen` is
  true ([lightbox.js:37](../public/lightbox.js#L37),
  [lightbox.js:379-438](../public/lightbox.js#L379-L438),
  [lightbox-panel.js:96-98](../public/lightbox-panel.js#L96-L98)).
- (i) toggles the panel and wears `.on` while it's open
  ([lightbox.js:296-312](../public/lightbox.js#L296-L312),
  [lightbox.js:583-586](../public/lightbox.js#L583-L586)). The pin is one
  localStorage value per board, read when the lightbox opens
  ([lightbox.js:291-294](../public/lightbox.js#L291-L294),
  [lightbox.js:458-461](../public/lightbox.js#L458-L461)).
- Keys: Escape closes the panel if it's open, else the lightbox, wherever the
  focus is. The arrows page unless a text field or a player has the focus
  ([lightbox.js:599-616](../public/lightbox.js#L599-L616),
  [shortcuts.js:8-12](../public/shortcuts.js#L8-L12)).
- The heart and crate buttons show only for a signed-in viewer (`state.me`,
  [lightbox.js:399-403](../public/lightbox.js#L399-L403)).

**The card face.** The heart sits at the bottom left, and is drawn only while
the card is hovered, has hearts, or has yours
([grid.js:577-580](../public/grid.js#L577-L580)). The bulk-select box takes
the bottom right. List view has a heart column of its own
([list.js:201](../public/list.js#L201)).

**Backups** read the table list from the database, so a new table is backed
up and restored with no change
([backup.js:71-93](../server/backup.js#L71-L93)). Not yet checked: that
restore loads a table whose user column can be empty.

**Duplicating a board** copies its settings, never its cards
([db.js:1785-1794](../server/db.js#L1785-L1794)), so it has nothing to copy
here.

## What changes

At the end of the arc:

1. A card has one comment thread. Any member of its board can read it and add
   to it. Only a comment's author can edit or delete it.
2. The lightbox's top bar gets a comments button beside the heart: a speech
   bubble, with the count once there is one. It opens the side panel on a
   Comments view; (i) opens it on Details. One panel, one pin, one ×.
3. The Comments view shows the card's name, the thread oldest first, and a
   text box at the bottom of the panel.
4. A card with comments shows the count beside its heart. Clicking it opens
   the lightbox on Comments.
5. A thread follows its card through a merge. When a move empties a card, its
   thread goes where the file went.
6. A deleted account's comments stay, signed "Former member".

## Decisions

Settled by the user:

- **D1 — On the card.** One thread per card (entity), whichever of its files
  is showing. Comments on a single file would be another plan.
- **D2 — Its own view.** The panel shows Details or Comments, never both. The
  look is the mock's.
- **D3 — A deleted account's comments stay.** Their `user_id` becomes empty
  when the account goes, and the thread signs them "Former member". Taking
  someone off a board doesn't touch their comments, which still show under
  their name.
- **D4 — Only the author edits or deletes.** No override for global or board
  admins. A consequence, stated so it's chosen with open eyes: a former
  member's comment can only go with its card. And any member of a board can
  delete any of its cards today (`DELETE /api/items/:id` checks access only,
  [server.js:3477](../server/server.js#L3477)), which takes the card's thread
  with it (Stage 1's close look).

Proposed, from the look and the mock (each stage's close look can amend):

- **D5 — Storage.** One table, migration 0062:
  `comments (id, entity_id → entities ON DELETE CASCADE, user_id → users ON
  DELETE SET NULL, body, created_at, edited_at)`, indexed on
  `(entity_id, created_at)`, and on `user_id`, which deleting an account
  looks comments up by.
  - `entity_id`, not `item_id`: the favorites column's name is history, not a
    rule.
  - Deleting a card deletes its thread, as it deletes its hearts.
- **D6 — Text.** Plain text, trimmed and otherwise kept as typed. Line breaks
  show; nothing is formatted and links aren't made clickable. Empty is
  refused. The cap is 10,000 characters, generous on purpose. Past it the
  server answers 400 with a sentence the page shows.
- **D7 — The API.** Everything under the card, so `requireEntityAccess` checks
  access and the existing hook tells the board. No event code of its own.
  - `GET /api/items/:id/comments` returns
    `{ comments: [{ id, body, created_at, edited_at, author, mine }] }`,
    oldest first. `author` is the name the hearts list uses (the name, else
    the email), or null for a deleted account. `mine` marks the caller's own,
    since the page doesn't know its own user id.
  - `POST /api/items/:id/comments` with `{ body }` returns the new comment.
  - `PATCH /api/items/:id/comments/:cid` with `{ body }` returns the comment.
    `edited_at` is set only when the text changed.
  - `DELETE /api/items/:id/comments/:cid`.
  - A comment that isn't on that card: 404. Someone else's: 403, "Only its
    author can change a comment." A card on a board you can't see: 404, as
    for hearts.
  - Every write stamps the card (`touchEntity`), so a delta returns it.
  - A post onto a card that was deleted, or emptied by a move, after the
    access check passed fails Postgres's foreign key check (23503). Nothing
    maps that today, so it would be a 500. The route answers 404 with the
    lightbox's own sentence, "That card isn't on this board any more."
  - A comment counts as an update to its card, as a heart does today: the
    stamp moves the card on a board sorted by Date updated, which reads the
    card's `updated_at` ([sort-core.js:115](../public/sort-core.js#L115)).
    Accepted at Stage 1's close look. Keeping comments out of that order
    would take a second stamp just for them.
- **D8 — The card carries its count.** `comments`, from one grouped query in
  `listItems`, scoped to the cards being listed the way crate places are
  ([db.js:343-355](../server/db.js#L343-L355)), not counted over the whole
  table the way the hearts join is. `toItem` keeps it.
  - An open thread refetches when its card's `updated_at` changes. Every
    comment write stamps it (D7), and the card already carries it
    ([db.js:400](../server/db.js#L400)). It also changes for other reasons
    (a retag, a price refresh), and each of those costs an open thread one
    small fetch. The plan first added a second number, `commentsAt`, as an
    exact key. Stage 1's close look dropped it: a field and a query that buy
    nothing the stamp doesn't.
  - The MCP tools list through `listItems` but write their own text for each
    card (`resultText` and `detailText` in
    [mcp-tools.js](../server/mcp-tools.js)), which leaves hearts out and
    leaves the count out too. They're unchanged.
- **D9 — A thread follows its card through a merge.** In `moveInstance`:
  - If a card the file left has no files once the move is written, its
    comments move to the file's main card after the move, in the same
    transaction, before the tidy-up deletes the emptied card. "Main card" is
    the first card in the file's new list, which the app already treats as
    the file's own ([db.js:3131-3134](../server/db.js#L3131-L3134)). On most
    boards a file has one card, so that's simply where it went.
  - A card the file left that keeps other files keeps its thread. A file
    gaining a second card carries nothing.
  - Moved, never copied, unlike hearts. A copy would be the same conversation
    twice, edited and deleted separately.
  - The race above would lose threads. Extraction runs up to 8 at once per
    AI key ([resource-pool.js:69](../server/resource-pool.js#L69)), so two
    files of one card can move at the same moment. Each checks whether the
    card emptied before the other has committed, so neither moves the
    thread. Then whichever tidies up after the other's commit deletes the
    card, or it commits empty and the sweep deletes it. Either way the thread
    goes with it.
  - The fix: right after writing the file's new card list, `moveInstance`
    locks every card the move touches (the ones it leaves, joins and stays
    on, since the tidy-up stamps them all), in id order, `FOR UPDATE`. Two
    moves through one card then take turns, and the second one's check sees
    the first's commit: transactions here are plain read-committed, which
    reads afresh at every statement ([db.js:77-90](../server/db.js#L77-L90)).
  - After the file's row, not first. A move and a file removal
    (`deleteInstance`, one statement) both write the file's row before
    touching cards today, so locking cards first would let each hold what the
    other waits for. In id order, so two moves can't do that to each other
    either.
  - `FOR UPDATE`, not a lighter lock. A comment posted onto the card while a
    move empties it would otherwise land just after the thread moved, and go
    with the card. With it, the post waits for the move and then gets D7's
    404.
  - Amended at Stage 4's pass: `FOR UPDATE` only on the cards the move
    leaves, the ones it can empty, and `FOR NO KEY UPDATE` on all of them
    first. On a card being joined, `FOR UPDATE` deadlocked a heart landing
    there with the move's copy. And a file removal takes the same locks in
    the same order (`removeInstance`), or racing a move it could empty a
    card and delete its thread.
  - The worker's sweep after a dissolve
    ([worker.js:3205](../server/worker.js#L3205)) exists only for this race
    and has nothing left to catch. It stays: offered at Stage 1's close look,
    not taken up. `moveInstance`'s comment gives the race as one reason
    hearts are copied on every move; that sentence goes. The copy stays,
    since a split giving the new card the old one's places is a rule a test
    pins.
  - When a whole card dissolves because the board stops grouping, the thread
    goes with the last file out. That's arbitrary, but the thread is kept,
    which beats deleted.
- **D10 — The panel has a view.** A `panelView` signal in lightbox.js,
  "details" or "comments", beside `panelOpen`.
  - (i) and the bubble each toggle their own view. Closed, or open on the
    other view: it opens on theirs. Open on theirs: it closes. The button
    whose view is showing wears `.on` and `aria-pressed`, and the title reads
    Details or Comments.
  - The pin works as it does today, and a pinned panel opens on the view it
    last showed. The stored value becomes "1" for Details, as today, so no
    one's pin changes, or "comments".
  - Work that only Details needs stops while Comments shows: the file details
    fetch, and the detection boxes over the picture, which belong to the
    Details list.
  - Closing the panel from inside it puts the keyboard on the button of the
    view it showed. Today that's always (i), which would send someone closing
    Comments to the wrong button (found building Stage 2).
- **D11 — The Comments view is its own component**,
  `public/lightbox-comments.js`, drawn by the same effect into the panel
  body.
  - It fetches the thread when the card changes, and again when the card's
    `updated_at` changes (D8). While a fetch is out it keeps what it shows.
    The first one says "Loading…", as the Details half does. One that fails
    says "Couldn't load the comments." and is tried again when the card next
    changes.
  - Your own post, edit or delete shows at once from the server's answer, and
    updates the card's count with it, the way the heart updates its own. The
    announcement then brings one refetch that finds nothing new.
  - The thread scrolls inside the view and the text box stays at the bottom.
    While Comments shows, the panel's body hands its scroll and padding to
    the thread, a rule in the view's own CSS, so lightbox.js sets nothing for
    it. Opening a thread shows its newest comment, and one arriving while
    you're at the newest keeps you there; scrolled up to read, you stay put.
  - Over the thread, the card's name, and on a card with several files a line
    saying "3 files, one thread" (the mock's).
  - Each comment shows its author, its age, "· edited" if it was, and its
    text. Ages read as the panel's field ages do: "just now" under 45
    seconds, else the app's "5m ago", not the mock's longer words. That rule
    moves into utils.js as one function both use. The full date and time is
    the tooltip.
  - Your own comments get a pencil and a bin, the panel's small file buttons
    (`.lbp-file-btn`). Edit swaps the text for a box with Cancel and Save.
    Delete asks inside the comment: "Delete this comment?" with Cancel and
    Delete. The app's card delete asks with the browser's confirm; this
    doesn't, as in the mock. When the box or the question goes, the keyboard
    goes back to the pencil or bin that opened it.
  - Delete is the action row's primary button, black like Save. The board
    page has no red button (its deletes ask with the browser's confirm), so
    the mock's red one isn't built.
  - Post, Save and Delete are disabled while their request is out.
  - Ctrl+Enter (⌘+Enter on a Mac) posts or saves. Enter starts a new line.
  - An unsent comment stays with its card while you page away or close the
    lightbox, until the page reloads.
  - No toast when it works: the comment appearing is the answer. When it
    fails, an error toast, with the server's sentence when there is one.
  - The text boxes join modal.css's one input declaration and the buttons its
    action-row list, as that file asks of every new wearer. Anything else
    reuses the panel's own rules (`.panel-cell`, `.lbp-hint`), with new CSS
    only where nothing fits.
  - The board page never draws for a signed-out viewer: app.js sends them to
    sign in first. So the heart's `state.me` check guards nothing. The bubble
    shares its line, and the view adds no checks of its own (found building
    Stage 2; the plan said all three would hide).
- **D12 — Escape, as in the mock.** In the edit box it cancels the edit. In
  the text box, the first Escape leaves the box with the draft kept; the next
  closes the panel, then the lightbox, as today. While "Delete this comment?"
  asks, it cancels the question, as the mock does (the plan first left this
  out). Everywhere else, unchanged. Today the first Escape closes the panel
  even from a text field, so this is one new rung, for the comment boxes
  only.
  - The boxes and the question keep their Escape from reaching the
    lightbox's handler, which stays as it is (found building Stage 2).
- **D13 — The count on the card.** A chip like the heart's, with the bubble
  and the count, shown whenever the card has comments. Clicking it opens the
  lightbox on Comments; `openLightbox` gains an option for the view.
  detail-open.js passes every argument through to it already (lazy-door.js),
  so it doesn't change. A panel pinned on Details and opened this way moves
  its pin to Comments, by D10's rule (found building Stage 3).
  - It sits in the heart's row, after the heart. A card with comments always
    has its heart in that row, faded out of sight unless the card has hearts
    or is hovered, as in the mock, so hovering never moves the count. Today
    the heart isn't drawn at all until hover.
  - The card has no such row today: the heart is placed by itself at the
    bottom left. Stage 3 makes one in the heart's place, holding the heart
    and the count. Cards without comments look as they do now (found
    building Stage 3).
  - On grid and rows-view cards, which are the same component, and in List
    view beside the heart in its heart column, with the same click (Q1).
    List already draws its heart in every row, faded until the row is
    hovered, so the count can't move there either. The heart column is 76px,
    room for the heart alone, so it widens to fit both, on every List table:
    a width that followed the comments would jump when the first one lands.
    The compact List (phones, and touch screens the full table doesn't fit)
    has no heart column, by its own rule, so no count either (found building
    Stage 3).
  - The count is a button, the mock's, so the keyboard reaches it. In bulk
    mode it hides with the heart: picking is a card's only click there.

Settled by the user after the plan was written:

- **Q1 — List view.** "yes to q1": the count shows beside the heart in List
  view too, so the two views agree (D13).

Flagged so they're seen, both small and easy to undo: D12 adds a rung to
Escape, and D10 changes what the pin stores.

## What stays the same

- The Details view, hearts, crates, the stage, zoom, paging and the count
  pill.
- Search. Comments aren't part of what a card embeds, so a comment never
  re-embeds a card or shifts anyone's results.
- Board events. No new event type; comments ride `items`.
- Backups. No change expected; Stage 1 checks a round trip.
- The MCP tools (D8).

## Stages

Each stage is three asks: a close look (read the code against this plan, say
what it got wrong), the build (amend the plan first, then build, then run
each new test with its fix removed: it must fail), and a second pass when
asked. Real-app checks run in real Chromium through test/browser/harness.js,
never in a session minted in the compose database.

### Stage 1 — the server

- Migration 0062 (D5).
- db.js: list, add, edit and delete a comment, each stamping the card; the
  count in `listItems` (D8); the lock and the thread rule in `moveInstance`,
  and its comment's race sentence (D9).
- server.js: the four routes (D6, D7).
- Tests, each beside its kind:
  - [access.test.js](../test/access.test.js): the four routes join
    `itemRoutes`, so an outsider and a member of another board get 404 on
    each;
  - [events.test.js](../test/events.test.js): a comment by one person
    reaches another person's stream, beside the heart's test;
  - [backup.test.js](../test/backup.test.js): the seed gets two comments,
    one whose account is gone, and the restore test finds both as they were;
  - [derived-identity.test.js](../test/derived-identity.test.js), with a
    helper of its own, since `placesOf` is compared whole: a merge that
    empties a card moves its thread to the card the file joined; a move that
    leaves the card with other files keeps the thread there; a file gaining
    a second card carries nothing; a file moving into several cards takes
    the thread to the first;
  - the race, there too: two moves out of one card, each held for a moment
    right after its thread check by a test-only trigger, the way the crash
    test plants one. Without the lock both checks then run before either
    commits, every time. The thread must survive, on the card of whichever
    file left last;
  - a new test/comments.test.js for the rest: a member posts, reads, edits
    and deletes their own; `mine` and `author` come back right, the name or
    else the email; another member's edit and delete get 403 and change
    nothing; a comment id from another card gets 404; empty and over-cap
    text gets 400 and stores nothing; an edit that changes nothing leaves
    `edited_at` empty; the card's count follows a post and a delete, and
    `?since=` returns the card after a post, an edit and a delete; deleting
    the card deletes its thread; deleting the account keeps its comments
    with no author; a post onto a card that vanished after the access check
    gets 404 (a test-only trigger deletes the card mid-insert).

**Close look (2026-11-12).** Read against the code at 1819253. What it
changed, all written into the decisions above:

- D9's lock moved from first to right after the file's row, became
  `FOR UPDATE`, and covers every card the move touches; the race it closes is
  wider than the plan said (a card deleted by the second tidy-up, not only
  one that commits empty). The worker's sweep stays (offered, not taken up).
- The race test gets a fixed order from a test-only trigger, or "fails
  without the lock" would depend on timing.
- D8 dropped `commentsAt`: the card's `updated_at` already does its job.
- D7 gained the 404 for a card that vanished mid-post, and the Date updated
  order (accepted with "go ahead", the recommended answer).
- D4 gained the card-deletion line; D8 and "What stays the same" lost the
  claim that the MCP tools would carry the count.
- The tests moved beside their siblings, with comments.test.js keeping the
  rest.
- Checked and right: nothing but `moveInstance` changes which card a file is
  on; `entities.uploaded_by` already uses ON DELETE SET NULL (migration
  0009); boards cascade to cards; restore orders tables by their foreign keys
  ([backup.js:97-121](../server/backup.js#L97-L121)); express.json's 100 KB
  body limit is far above the cap; no other plan claims migration 0062;
  routed reports set statuses only, so they can't reset the count
  ([data.js:131-140](../public/data.js#L131-L140)).

**Built (2026-11-12, uncommitted).** After "go ahead", with the plan amended
first.

- server/migrations/0062_comments.sql: the table and its two indexes (D5).
- server/db.js: `COMMENT_MAX`, `listComments`, `addComment`, `editComment`,
  `deleteComment`. Every write stamps the card, except a save that changes
  nothing. The count in `listItems`, scoped the way its instances query is.
  In `moveInstance`: the lock right after the instance's row, the thread
  moving to the main card, and the race sentence in its comment replaced by
  the rule the copy now rests on (a card split off another starts in its
  crates, with its hearts).
- server/server.js: the four routes. Text is trimmed and refused when empty
  or past 10,000 characters, counted in code points. A comment id that isn't
  a positive whole number is 404; "1.5" would otherwise reach Postgres as a
  bigint and come back a 500. A 23503 on the insert answers 404, "That card
  isn't on this board any more."
- Tests: test/comments.test.js (9); access.test.js's matrix (+4 routes);
  events.test.js (+1); backup.test.js (two seeded comments, one with no
  author, plus one written after the backup, which the restore must undo);
  derived-identity.test.js (+6).
- One test the plan didn't list: a comment posted while a move empties its
  card is refused (404), not lost. It proves `FOR UPDATE`, which the close
  look argued for and nothing tested; under a lighter lock only this test
  fails. It waits for the move's hold in Postgres's own activity view
  (`pg_stat_activity`, wait event PgSleep), not on a timer.
- Removal checks: 28 stand-in edits, each applied alone and its file put back
  byte for byte. Every one failed its tests: the author check off edit or
  delete; the card check off edit or delete; the id guard; the empty check;
  the cap; the cap counting UTF-16 units; `edited_at` on every save; the
  count left off the card; no stamp on a post, an edit or a delete (three);
  the 404 for a vanished card; no cascade from the card; a cascade from the
  account; the access guard off each route (four); the post's announcement;
  the thread never moving; moving to the lowest id; moving off cards that
  keep files; copying to every card joined, like hearts; no lock; a lighter
  lock; comments left out of backups.
  - Two needed a wider net. With the access guard off edit or delete, the
    matrix still passes: the handler has no card id then and matches nothing,
    so an outsider gets 404 anyway. comments.test.js fails instead, because
    the author's own edit and delete stop working.
- Runs: full `npm test` (lint, template, every file): 2,496 tests, 2,493
  passed, 2 skipped, 1 failed. The failure was test/browser/sorted-load.test.js
  getting `net::ERR_NO_BUFFER_SPACE` from Chromium while eight files ran at
  once, before any assertion. That file alone: 11/11.
- Where: Docker was off, and starting it would have brought the whole stack
  back up with its worker. Every run used a throwaway Postgres 17.9 (npm's
  `@embedded-postgres/windows-x64`) in the session's scratchpad, on port 55433
  through `TEST_ADMIN_URL`. CI runs them on its own Postgres.
- Owed: the compose stack applies 0062 on its next rebuild (ask first).
  Nothing from Stage 1 shows in the UI yet.

### Stage 2 — the lightbox

- index.html: the bubble button between the heart and (i); the panel's title
  written from the view.
- utils.js: the bubble glyph in ICONS; `comments` in `toItem`, which D8 gave
  it and no stage listed (the bubble's count needs it); `ago`, the ages'
  rule (D11).
- lightbox.js: `panelView`, the two buttons' toggles and `.on`, the pin's
  stored view, Details-only work held back while Comments shows, and where
  closing the panel puts the keyboard (D10).
- lightbox-panel.js: the field ages through `ago`.
- public/lightbox-comments.js (D11), with Escape's new rungs (D12), and its
  CSS: modal.css's input declaration and action-row lists take the view's
  box and buttons; styles.css gets the rest, the bubble's `.on` beside (i)'s,
  and the download's hover on every small file button (the pencil needs
  one).
- Browser tests, in a new test/browser/comments.test.js:
  - the bubble opens Comments and (i) switches to Details, each button lit in
    turn and the title following; each toggles its view closed;
  - a pinned panel reopens on the view it last showed;
  - posting with the button and with Ctrl+Enter: the comment comes last, the
    box empties, and the bubble's count goes up;
  - your comment has the pencil and bin; another member's has neither; a
    deleted account's shows "Former member" and has neither;
  - Save on an edit marks it edited; Escape in the edit box cancels and
    changes nothing;
  - delete asks first; Cancel keeps the comment; Delete removes it and the
    count drops;
  - a draft stays with its card while paging away and back, and the arrows
    typed in the box don't page;
  - a comment another member posts reaches an open thread with no reload;
  - while Comments shows, no file details are fetched;
  - added building it: Escape in the text box leaves it with the draft kept,
    and the next closes the panel with the keyboard on the bubble; Escape on
    the delete question cancels it; a long thread opens on its newest
    comment, with the text box in view under it; a post the server refuses
    toasts its sentence and keeps the text.

**Read before building (2026-11-12).** The user said "go ahead with 2"
without a close look, so the code was read against this stage at the start
of the build. What it changed, all written in above:

- `toItem` has no `comments` yet. D8 said it would keep the count; Stage 1
  was the server only.
- Closing the panel puts the keyboard on (i) whichever view showed (D10).
- The panel's body scrolls, with padding, so a text box inside it would
  scroll away with the thread (D11).
- D12's "as in the mock" includes cancelling the delete question, which its
  "Everywhere else, unchanged" contradicted.
- The board page has no red button, and never draws for a signed-out viewer
  (D11).
- Checked and right: the arrows and zoom keys already stand back for a
  focused text box (`focusOwnsKeys`); an open menu takes Escape before the
  lightbox does (dropdown.js); every row `toItem` reads for a card already
  on the page comes from `listItems`, which always carries the count (an
  upload or a connector add is a new card), so the count needs no `hold`
  rule; the panel's body is one Preact root, so drawing Comments into it
  replaces Details, and the close's `resetPanel` clears either.

**Built (2026-11-12, uncommitted).** After "go ahead with 2", with the plan
amended first.

- public/lightbox-comments.js, new: the view. One signal holds the thread on
  screen; it's asked for when the card or its `updated_at` changes, and an
  answer a newer question overtook is dropped. Writes go through one helper:
  a dead session goes to sign in, any other refusal to an error toast in the
  server's words. Drafts sit in a plain map by card. Five small components:
  the thread, a comment, the edit box, the delete question, the text box.
  The view is made anew for each card, so another card starts at its newest
  comment with its own draft.
- lightbox.js: `panelView` and `VIEWS`, each view's button and title.
  `setPanel(open, view)` lights and presses the view's button, writes the
  title, keeps a pin on the view showing, and on closing gives the keyboard
  to the view's button. The pin reads "1" or "comments". Details' fetch and
  boxes run only while Details shows. The bubble draws the card's count.
- index.html: the bubble between the heart and (i); the title's id, which
  also names the panel.
- utils.js: `ICONS.comment`, `comments` in `toItem`, `ago`. lightbox-panel.js:
  the field ages through `ago`.
- modal.css: `.cm-box` joins the text-field declaration, and `.cm-row button`
  the action-row lists (primary, ghost, disabled). styles.css: the bubble's
  `.on` beside (i)'s, the download's hover on every small file button, and
  the view's rules, among them the body handing its scroll to the thread.
- Departures from the mock, all in D11 before the build: Delete is black, ages
  read "5m ago", and Cancel, Save, Delete and Post are the action row's own
  buttons, a size up from the mock's small ones.
- Tests: test/browser/comments.test.js, 13. The plan's nine, and four found
  building: Escape in the text box; a long thread opening at its newest; a
  refused post; a thread that can't be fetched saying so. Escape on the
  delete question went into the delete test. Three were tightened so their
  fix could fail them: Details' boxes going when Comments takes over, an edit
  showing from its own answer with the refetch held, and a reader scrolled up
  staying put when a comment arrives.
- One existing test changed by design: list-keyboard.test.js's Tab walk
  through the lightbox now passes Comments between Favorite and Details.
- Removal checks: 46 stand-in edits, each applied alone and its file put back
  byte for byte. Every one failed its test: the bubble opening Details; both
  buttons lit; the title not written; `aria-pressed` not set; the pin always
  Details, not following a switch, or read as "1" only; Details' fetch or
  boxes while Comments shows; closing always handing the keyboard to (i); the
  count left out of `toItem`, not drawn on the bubble, not raised by a post,
  not dropped by a delete; ages without "just now"; no refetch when
  `updated_at` moves; your post, edit or delete not shown from its answer;
  the box not emptied; the pencil and bin on everyone's; no Former member;
  Escape in the edit box reaching the lightbox or not cancelling; the
  keyboard not back on the pencil or the bin; the question not taking the
  keyboard; Ctrl+Enter not saving or not posting; no question before a
  delete; Escape on the question reaching the lightbox; drafts not kept; the
  view not made anew per card; the arrows paging from a text box (an
  existing rule this stage leans on); Escape in the text box reaching the
  lightbox or not leaving the box; not kept at the newest; kept there when
  scrolled up; the body keeping its scroll; no files line; a refused post
  losing its text, or its toast losing the server's words; the box not
  growing, or growing with no cap; Post enabled with nothing to post; a
  failed load saying Loading….
- Not proven by a test: the guard that drops an overtaken answer (paging
  fast; without it, a "Loading…" flash and a second fetch, as the Details
  half's own guard would cost), and the CSS joins, which are looks only.
- Runs: the new file alone, 13/13. Against the bundled build
  (`npm run build:frontend`, then FRONTEND_DIR=public/dist) with
  lightbox-panel.test.js, 52/52; the view lands in the lightbox's lazy chunk.
  Full `npm test` (lint, template, every file): 2,509 tests, 2,506 passed, 2
  skipped, 1 failed, the Tab walk above. With it updated, the file passed
  alone (11/11), and a second full run passed: 2,507 passed, 2 skipped, none
  failed.
- Where: Docker was on, so every run used throwaway databases on the compose
  Postgres, the tests' default.
- Owed: the compose image bundles the frontend when it's built
  (STATIC_DIR=public/dist), so the app at :8001 shows none of this until the
  next rebuild (ask first).

### Stage 3 — the count on cards

- grid.js: the heart's row, with the chip in it, and the heart kept in the
  row when a card has comments; `comments` in `cardProps`, so a card redraws
  when its count moves; the chip as a component List shares (D13).
- lightbox.js: opening on a given view. detail-open.js: no change.
- list.js: the count beside the heart in the heart column, same click, and
  the column wider (Q1).
- styles.css: the row in the heart's old place; the chip's pill, the
  heart's; bulk mode hides it.
- Browser tests: the chip shows only with comments, follows a post made in
  the lightbox, and opens the lightbox on Comments, on a card and on a List
  row; hovering a card that has comments and no hearts doesn't move the chip.
  Added building it: a rows-view card carries the chip too; in List, the
  heart and the count sit side by side in their column; bulk mode hides it.

**Read before building (2026-11-12).** "go ahead with 3", again without a
close look, so the code was read at the start of the build. What it changed,
all written into D13 above:

- detail-open.js needs no change: its door passes every argument through.
- The card has no heart's row: the heart is placed alone, so the row is new.
- List's heart is already drawn in every row and faded, D13's rule for
  cards; its column is too narrow for a second chip; the compact List has no
  heart column at all.
- Opening on Comments from the chip moves a Details pin to Comments (D10).
- Checked and right: rows-view cards are grid.js's `Card` (rows.js); a card
  redraws only when a prop in `cardProps` changes, so the count has to be
  one; a post's own count change (`recount`, Stage 2) calls itemsChanged,
  which redraws the cards.

**Built (2026-11-12, uncommitted).** After "go ahead with 3", with the plan
amended first.

- grid.js: `CommentChip`, a button with the bubble and the count, which
  opens the lightbox on Comments. A card draws its heart and the chip in one
  row in the heart's old corner, and draws the heart whenever the card has
  comments; the existing CSS fades it until hover. `comments` joins
  `cardProps`.
- lightbox.js: `openLightbox(item, { view })`. A view given opens the panel
  on it; otherwise the pin decides, as before.
- list.js: the chip after the heart in its column, which goes from 76px to
  128px.
- styles.css: the row holds the heart's corner, and the heart and the chip
  share the heart's pill; hovering the row lifts it, as hovering the heart
  lifted the heart; bulk mode hides the chip. List's heart column runs from
  the left without wrapping, its header's icon over the hearts' icons.
- One departure, in D13 before the build: List's hearts now run from the
  left of their column, not its middle, so they line up whether or not a row
  has a count.
- Tests: 5 more in test/browser/comments.test.js. The count shows only with
  comments, in the heart's corner, and holds still while the heart fades in;
  it follows a post made in the lightbox, the first one bringing it, with the
  page's polls held so the post's own answer has to move it; it opens the
  lightbox on Comments from a card and from a List row; in List it sits
  beside the heart, inside its cell, with the hearts under the column's icon,
  and a rows-view card has it too; bulk mode hides it.
- Removal checks: 11 stand-in edits, each applied alone and its file put back
  byte for byte. Every one failed its test: the count left out of the card's
  props; the heart not kept in the row; the row out of the heart's corner;
  the chip opening without its view; the lightbox ignoring a view; no count
  in List; List's column as narrow as before; its header icon centred; its
  hearts centred; bulk mode keeping the count; a post's count change not
  announced to the cards.
  - One needed a better test first. With the column back at 76px the count
    didn't wrap, it spilled past its cell, which the List test didn't check
    until it asked that the count fit inside its cell.
- Not proven by a test, all looks: List's no-wrap rule (it matters only past
  two-figure hearts beside a three-figure count), the row's lift over its
  neighbours while hovered, and the chip's button reset.
- Runs: the new tests alone; with cards.test.js and the List, events and
  ui-updates browser files, 92/92; against the bundled build with
  list-view.test.js, 20/20; full `npm test`, 2,514 tests: 2,512 passed, 2
  skipped, none failed.
- Owed: as for Stage 2, the app at :8001 shows this after the next image
  rebuild (ask first).

### Stage 4 — second pass

The whole arc read again with fresh eyes, against the code from before
Stage 1. No new scope.

**Done (2026-11-12, uncommitted).** After "do a 2nd pass". Three read-only
reviewers, one per area (the server, the Comments view, the count on cards
and List), each comparing the working copy with HEAD and never shown this
plan. This session checked the plan's line links, the tests' setups and the
packaging, and measured in Chromium what reading couldn't settle.

Found and fixed, each with a test that fails with its fix removed:

- Server:
  1. A comment id like `1e20`, or 20 digits, answered 500, not 404:
     `Number.isInteger` lets 1e20 through, and it overflows the column. The
     comments' ids now take the alerts' safe check, shared as `positiveId`.
     And a comment that isn't there says "That comment isn't there any
     more.", not the bare "not found" the page used to toast.
  2. D9's lock could deadlock with a heart. With every card FOR UPDATE, a
     heart or crate place landing on the card a file joins waited on the move
     (its foreign key check) while the move's copy waited on it. Every card a
     move touches is now locked FOR NO KEY UPDATE, which two moves still
     can't both hold and a foreign key check can share, and the cards it
     leaves, the only ones it can empty, FOR UPDATE as before.
  3. A file removal racing a move could delete a thread. Removing a card's
     other file while the worker moved one off it, the route counted two
     files, removed its own, and its race heal deleted the card, empty now,
     with its thread. `removeInstance` (db.js) counts and deletes under the
     cards' locks, taken in the move's order, so the second one waits and
     counts what the first left. The race heal had nothing left to catch and
     went.
- The Comments view:
  4. Paging away and back while a post was out put its text back in the box,
     ready to send twice. The text leaves the drafts as it's sent and comes
     back only if the post fails, and the box is read-only meanwhile.
  5. Paging away and straight back let the other card's late answer take the
     screen: the thread flickered to "Loading…" and was fetched again. A
     question out for another card is dropped once this card's thread shows.
  6. A Save that landed late closed whatever was open by then, another
     comment's box and its typing among them. What's open is one state now,
     and a late answer closes only its own.
  7. Escape on the edit's Cancel or Save closed the panel and left the edit
     open behind it. Escape anywhere in the edit cancels it, as anywhere in
     the delete question already did.
  8. Focus fell to the page after posting with the Post button, after a
     delete, and after a Save or Delete the server refused, where Escape then
     closed the panel. Measured: Chromium takes focus off a button a frame
     after it turns disabled. The keyboard goes back to the box, or to
     Cancel, when it's nowhere or still on that box's own button.
  9. A thread that failed to load said so until its card changed, through
     closing and opening the lightbox again. It's asked again whenever the
     view comes to it.
  10. A long reply grew the box over the thread and hid the newest comment.
      At the newest, the thread keeps it in view as its own height changes.
  11. A refetch that crossed your post could show it twice. The post's
      answer replaces a copy already there.
  12. The delete question is a group its question names, so a screen reader
      landing on Cancel says what it cancels.
- The count on cards and List:
  13. On a touch screen, a tap beside a card's count hearted the card: the
      heart kept faded there still takes taps (measured: the same tap opens a
      card with no comments, as before). On screens that can't hover, it's
      hidden and keeps its room.
  14. Opening Comments from a card's count by keyboard left focus on the page
      when the lightbox closed. Closing gives it back to what opened it,
      where the card has nothing to take it (List's rows still give it to
      their name).
  15. Stage 3's no-wrap rule for List's heart cell reached the hearts' list
      of names, which ran out of its box. The list wraps again.
  16. A List count with the keyboard on it lost it when its row moved, as a
      comment moves a card sorted by Date updated. It's named for keepPlace,
      as the select circle is.

Simplified, no change in behavior: the count's "only with comments" check
lives in the chip, not at its two callers (its Stage 3 test re-proven with
the check removed); a comment's text is `.lbp-desc` with its own margin and
wrapping, not a copy of its type; a dead `.list-table .heart` reset and the
chip's repeat of the global `font: inherit` went; the stale widths in
list-phone.test.js's messages, and list.js's header, now name the count.

Declined, and why:

- A NUL in a comment answers 500, as on every text route in the app.
- A post's every foreign key error reads as the card gone, the author's
  included: harmless, since the account's session goes with it.
- The card's own `:id` on the item routes 500s on 1e20, as it did before
  this arc (requireEntityAccess, requireItemAccess).
- The count as one correlated subquery instead of the grouped query: it
  would need measuring on a big board first.
- The lock when a move changes nothing: the tidy-up locks those cards anyway.
- deleteEntity locks the card before its files and a move the other way
  round, as before this arc, so the two can deadlock and Postgres ends one.
  The move's comment now says so instead of implying every writer agrees.
- At the newest, the thread snaps to the bottom on every redraw, so a box
  opening on a comment higher up pushes it up a little. That's the stick at
  work; the other way, the last comment's box opens below the view.
- The arrows page from the comments' buttons, as from Details' buttons.
- The bubble's name doesn't carry its count, as the heart's doesn't, and the
  Ctrl+Enter hint isn't tied to its box.
- The count can run one high for a moment when a refresh lands between your
  post and its answer. The post's own announcement corrects it, so returning
  the count from the server, the heart's way, buys a moment.
- `send()` beside api.js's `api()`, which drops the status a 401 needs. The
  four copies of the sign-in redirect predate the arc.
- Decided already: a click on a count moves a Details pin to Comments (D10,
  D13); List's heart column is 52px wider on every table (D13). A
  consequence D13 didn't state: on a touch tablet, a table within 52px of
  fitting now takes the compact table.
- Older, recorded, not fixed: on a touch tablet's full List, every row's
  faded heart takes taps, as every card's select circle does; and List's tag
  chip and actions draw over the pinned name when the table scrolls
  sideways, where the hearts now pass under it.

- Tests: test/comments.test.js's 404 test takes the huge ids and the new
  sentence; 2 more in derived-identity.test.js (a heart landing mid-move, a
  removal racing a move); 11 more in test/browser/comments.test.js, and 3 of
  its tests extended (the failed load asked again, the question's group, the
  box growing over a long thread).
- Removal checks: 25, each applied alone and its file put back byte for
  byte, and every one failed its test: the 1e20 check; the bare "not
  found"; every card FOR UPDATE (the heart deadlocks); the left cards not
  FOR UPDATE (a comment posted mid-move goes with the card); no lock (two
  moves lose the thread); the removal counting unlocked (the thread goes);
  the removal taking a card's last file; the draft kept while it's sent;
  the box taking typing then; another card's late answer taken; a late Save
  closing whatever's open; Escape only from the edit's box; no keyboard back
  after a post; none after a delete; a failed thread not asked again; your
  post added twice; the question not a group; the thread not kept at its
  newest as it shrinks; no keyboard back after a refused Save; none after a
  refused Delete; the faded heart taking taps on a touch screen; no
  keyboard back to the count; the names not wrapping; the List count
  without its place; the chip drawn with no comments.
  - Two needed better tests first. The List count's place passed until its
    row started at the bottom: one row up, Preact moves the neighbour, and
    the keyboard never leaves. The chip's own check passed because a card
    hides its heart's row at rest anyway, until the test hovered a card with
    no comments and looked at a List row with none.
- The browser file's pages: each test now closes the last one's page before
  opening its own. Left open, each page kept the board's events, so every
  comment written later had them all fetch the board again: 265 fetches in
  one run of the file, up to 641ms each alone and 15s under the full suite,
  where one test's page timed out loading. Now 72, at most 39ms. The removal
  checks ran before this, which only closes pages between tests.
- Measured, unchanged: a comment's text reads 13px on 19.5px in
  rgb(60, 60, 66), margin 4px 0 0, pre-wrap, as before it took
  `.lbp-desc`.
- Runs: the server files, 62/62; the browser file alone, 29/29; full
  `npm test`, 2,527 tests: 2,524 passed, 2 skipped, and 1 failed, the page
  that timed out loading above. After the fix, 2,527 tests: 2,525 passed, 2
  skipped, none failed. Against the bundled build, the browser file 29/29.
- Owed: the app at :8001 shows Stages 2 to 4 after the next image rebuild
  (ask first).

## Not in this plan

- Notifications, unread marks and @mentions. The app sends no email at all,
  and an unread mark would be a per-person record on the server, like the
  alerts' seen marks.
- The MCP tools reading or writing comments. `get_items` returning them is
  the cheap first step.
- Searching comments, a "has comments" filter, sorting by comments.
- Comments as hints to the tagger.
- Replies, reactions, formatting, edit history.
- Comments on a single file.
- Moderation of any kind (D4).

## Cost

- One table, and one grouped query on every card load, by an indexed column.
- Code: about 150 lines of server, a component of a few hundred lines, some
  CSS, and the tests.
- Bytes: the component joins the lightbox's lazy chunk; the cards gain one
  small chip.
