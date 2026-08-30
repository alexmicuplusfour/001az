# Board arrangement — the reader's own order

**Status: BUILT (2026-08-30). Boards have always come back oldest-first, which
is nobody's preference — it is just the order they happened to be created in,
and on an instance with a dozen boards it means the one you open every day sits
wherever it landed. This adds a per-READER arrangement: drag a card on `/boards`
(or focus its grip and press an arrow key) and the order sticks, on your account,
across devices. It applies to the two member-facing surfaces — the boards index
and the gallery's board switcher — and deliberately not to the admin table. One
migration (`users.board_order`), one route extension (`PATCH /api/account`), one
sort on the server, and the drag itself on the boards page.**

## The gap

Every board listing an ordinary reader sees comes out of one query:

```js
// server/db.js — listBoards
SELECT ${BOARD_COLS} FROM boards ORDER BY created_at ASC
```

`accessibleBoards` ([server.js](../server/server.js)) filters it and three routes
serve it: `/api/boards` (the switcher), `/api/boards/overview` (the index),
`/api/boards/signals` (dots, order-blind). Nothing on the client re-sorts —
[boards.js](../public/boards.js) does `boards.map(cardFor)` and
[toolbar.js](../public/toolbar.js) iterates `state.boards` — so **server order is
the only order there is**, and there was no notion of position, rank or
arrangement anywhere in the schema.

That uniformity is the opportunity. Because both surfaces render in received
order and neither sorts, an arrangement applied in `accessibleBoards` reaches
both of them and the switcher needs no code at all.

## Decisions, with the reasoning

**Per reader, not per board.** A `position` column on `boards` is the smaller
change and the wrong one. A board is shared: one member's drag would reshuffle
everyone else's index. It would also land in every listing that reads
`listBoards`, including `/api/admin/boards`, and that table is the instance's
ledger — rows compared across people, in a stable order two admins can both
point at. So the order lives on the `users` row and the ledger keeps
`created_at`.

**An array of ids, not a join table.** `users.board_order` is a JSONB array,
written whole. A `(user_id, board_id, position)` table would need a transaction
per drag, a unique constraint to stop two boards claiming one slot, and a
cleanup path on board delete and on membership change. The array needs none of
that, because it is a **ranking, not a registry**:

- a board missing from it has no rank and sorts last, in `created_at` order —
  so a board created or shared *after* the last drag needs no write;
- an id naming a board that is gone matches nothing — so a deleted board needs
  no cleanup loop, and the stale id is pruned the next time the reader drags;
- an id for a board the reader can't see is never compared against anything,
  because the ranking is applied only to boards `canAccessBoard` already
  approved.

Which is also why the write path shape-checks the ids but does not verify them
against the boards table. Validating would buy an authorization property this
list does not carry — it grants nothing — at the cost of a query on every drag.
What *is* enforced is that the column can't be used as storage: strings only,
deduped, ≤64 chars each, ≤500 entries.

**The sort lives in `accessibleBoards`, not on the client.** One function, both
surfaces, no second opinion about order between the index and the switcher —
and the switcher's code is untouched. Unranked boards sort last in arrival
order, which `Array#sort` being stable gives us rather than a tiebreaker.

**One account route, not a new one.** `PATCH /api/account` already existed for
the display name, and the name and the arrangement are the same kind of thing:
state belonging to the reader rather than to any board. Each field is written
only when it is *sent*, so the profile page (name alone) and the boards index
(order alone) can never clobber the other's. The old contract — a bare `{name}`
— still works unchanged.

**Handle-only drag, not a draggable card.** The card is a link first; that is
what the page is for. Making the whole card a drag source would put a rearrange
in the way of opening a board, and the card contains a natively-draggable `<a>`
and natively-draggable `<img>`s that would each start their own drag instead.
So the grip is a `<button>`, `draggable` goes on the wrapper only while the grip
is held, and the link and the thumbnails are explicitly opted out.

The grip being a button is also what makes the keyboard path possible: focus it
and the arrow keys move the card, with an `aria-live` line saying where it
landed. Up/Down are bound to the same one-place step as Left/Right — the column
count is a viewport accident, and a key that moves by a number the reader can't
see is worse than one that moves by one.

**The DOM is the model.** A drag reorders the grid live and the saved order is
read back off the cards, so there is no id array to keep in step with what's on
screen. Same reasoning the dots already run on: the rendered cards are their own
index (`wrap.dataset.board`), and a second structure describing them is a second
thing to get wrong.

**Escape really cancels.** The live preview is a real DOM move, so abandoning a
drag has to be a real move back — `dragend` reports `dropEffect === "none"`, and
the card returns to the neighbour it was picked up from. Exactly one card ever
moves during a drag, so remembering that one sibling *is* the undo; no order
snapshot is involved. Leaving the preview in place would save an arrangement the
reader explicitly walked away from.

**All four drag events are bound to the grid, not the cards.** `render()`
replaces every card whenever a board is edited, so per-card handlers would be
rebuilt under a drag in flight. Drag events bubble and the wrapper already
carries its board id for `paintDots`, so the event target resolves to everything
a handler needs. The grip stays per-card because what it owns is its own button.

**A failed save re-renders.** The grid on screen would otherwise be a claim the
server never accepted. Toast, then `render()`, which redraws from the stored
arrangement — the cards go back to the last order that is actually true.

## What else `/api/boards` feeds

Sorting inside `accessibleBoards` reaches every caller of it, so the other two
were checked rather than assumed:

- **The no-`?board=` redirect** ([app.js](../public/app.js) ~78) falls back to
  `accessible[0]` when there's no `lastBoard`. That was "the oldest board you
  can see" and is now "the one you put first" — which is the better answer, and
  the reason this is a note rather than a guard.
- **The admin member picker** ([admin-members.js](../public/admin-members.js)
  ~240) lists board chips per user off the same endpoint, so it follows the
  admin's own arrangement. Kept: it is a *chooser*, and the order the admin
  knows their boards in is the right one to pick from. The admin **table** is
  the surface where that would have been wrong, and it reads `listBoards`.
- `/api/boards/signals` is order-blind — the client keys it into a Map.

Nothing else re-sorts, so there is exactly one place that decides order for a
reader and one place that decides it for the ledger.

## What changed

| File | Change |
|---|---|
| [0039_board_order.sql](../server/migrations/0039_board_order.sql) | `users.board_order JSONB NOT NULL DEFAULT '[]'` |
| [db.js](../server/db.js) | `setBoardOrder` |
| [server.js](../server/server.js) | `arrangeFor` + `accessibleBoards` sorts; `cleanBoardOrder`; `PATCH /api/account` takes `board_order` |
| [boards.js](../public/boards.js) | the grip, the drag, the arrow keys, the save |
| [boards.css](../public/boards.css) | `.bc-tools` cluster (the pencil moved into it), `.bc-grip`, `.dragging` |
| [utils.js](../public/utils.js) | `ICONS.grip` |
| [board-arrange.test.js](../test/board-arrange.test.js) | 11 tests: ordering, the unranked tail, deleted boards, per-reader isolation, the admin ledger, dedup, the storage bound, name/order independence |
| [boards-page.test.js](../test/boards-page.test.js) | now boots on TWO boards — pins the grip's presence rule, the cluster holding grip+pencil, and the link's drag opt-out (and finally exercises the dark-card path) |

`toolbar.js` is untouched — the switcher reorders because `/api/boards` does.

The page's own temporal-dead-zone guard earned its keep during the build:
`initArrange` runs from the boot block at the top of boards.js, above the `let`
declarations this section adds, and creating the live region there threw. It is
built from `gripFor` instead — which also satisfies the ARIA constraint that a
live region be in the document *before* its text changes.

## Known limits

**Touch does not drag.** HTML5 drag-and-drop does not fire for touch input, so
on a phone the cards are read-only. Accepted rather than papered over with a
pointer-event reimplementation: that means hand-rolling the drag image, the edge
autoscroll and escape-to-cancel that the browser otherwise supplies, for the
one-column layout where the arrangement matters least. If it becomes worth
doing, the keyboard path already proves the model has a non-drag entry point.

**Nothing surfaces the arrangement outside `/boards`.** There is no "reset my
order" control; dragging is the only writer, and sending an empty array (which
the route accepts and the tests pin) is the reset if one is ever wanted.

**A stale id survives until the next drag.** Deleting a board leaves its id in
every *other* reader's stored array, inert. Pruning it would mean a fan-out
write across users on every board delete, to remove an entry that already ranks
nothing — the ranking's whole point is that it tolerates this.

**A second open tab shows the old order** until it re-renders. There is no push
channel for account state and this page's only poll is the signals tick, which
is deliberately narrow. Last write wins, which for one person's own two tabs is
the right answer.

**A render invalidates a queued save.** The DOM is the model only while the
cards are on it, so `render()` — which is about to replace all of them — drops
any pending save timer. `saveOrder` also bails on an empty grid, as a backstop
for the sliver where a render lands mid-flight: storing `[]` read off the
no-boards note would wipe the arrangement this feature exists to keep.
