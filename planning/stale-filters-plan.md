# A selection meeting a taxonomy that moved under it (2026-09-19)

**Status: SHIPPED 2026-09-19 — one helper, one gate, four call sites, browser
only. Suite 1764 green (13 new: 8 in
[facet-match.test.js](../test/facet-match.test.js), 4 in
[filter-shape.test.js](../test/filter-shape.test.js) plus one existing test
given a board to land on), browser suite 38 green against source AND against
the built bundle. No server change, no migration, nothing rewrites a stored
config.**

The one browser case ([boot.test.js](../test/browser/boot.test.js)) is there
because the boot path is an ORDERING — URL decoded, board fetched, gate run,
first paint — and ordering is the one thing a stub can't get wrong on your
behalf. Verified failing without the gate ("Clear filters (2)") before it was
kept.

## The bug

A saved filter config is a plain object of facet keys and values
(`filter_configs.config`), and nothing has ever connected it to the board whose
vocabulary it names. Board facets are edited freely — a value deleted, a key
renamed — and `saveBoardPatch` reconciles item fields and demotes facet
diagnostics but never looks at the selections that point at what it just
changed. Same for `?f=`/`?fx=` links and alert conditions.

Three separate symptoms, in order of how badly they read:

**An exclusion that can't match excludes nothing.** `facetPass` walks the `not`
half asking "does this item hold it"; no item holds a value the board dropped,
so every item passes. A saved "everything except red" quietly starts showing
red the day red is renamed, and looks correct while it does it. **No symptom at
all** — this is the one that justifies the work.

**An include that can't match empties the board**, and leaves no way out: the
rail draws chips by walking `state.facets`, so a value the board stopped
declaring gets no chip. `activeCount()` still counts it. "Clear filters (2)"
over an empty grid with nothing to click off, and Clear All the only exit.

**The items are still there.** Nothing strips tags when a facet value is
deleted — a card tagged `color/red` keeps it forever. The board merely stopped
*declaring* the value, which is why "no items matched" would have been a lie
and the toast says the board doesn't have it any more.

## The decision: skip the parts that can't land, keep the rest, say so

The fourth verdict on a selection that doesn't fit, beside the three
`cleanSelection` already documents (a filter config refuses an empty one, an
alert condition refuses it, an MCP search reads it as unconstrained).

**Skip, don't refuse.** `readFacetScope` 400s an unknown facet key, and says
why: a typo silently retagging nothing is the worst outcome *there*. Here the
caller is a saved view or a shared link written when the value did exist, so
refusing it whole would lose the half that still works.

**Skip, don't rewrite.** The stored config is never touched. Rename a facet
back and the saved filter works again — auto-pruning would turn a typo in the
board modal into permanent loss across every saved config on the board. (A
user-pressed "Clean up" button on a stale row stays possible and unbuilt; the
gate makes it cosmetic.)

**Skip, don't draw a dead chip.** The first shape considered was the rail's own
answer for its system rows — draw the orphan so it has a click-off. Rejected on
the user's call: a chip for a value the board can't offer is a choice that
isn't one, and the clutter is permanent while the dead end is momentary.

## What shipped

**[facet-match.js](../public/facet-match.js) `pruneToDeclared(selected, facets)`**
— live-form selection in, `{ selected, dropped }` out. Both halves. `~` keys
pass untouched: their membership comes from a capability's own set, and their
universes move with the DATA rather than with anyone's edit, so nothing there
stopped being available. The reserved prefix (`facetsReservedKeyError`) is what
makes that test exact.

It lives in facet-match.js because "what does the board declare" already exists
three times — [worker.js](../server/worker.js) `allowed` (tag-string form,
filters the model's answers), [server.js](../server/server.js) `readFacetScope`
(key-level, refuses), [filters.js](../public/filters.js) the rail's `declared`
for `~objects` (mapping-derived) — and a fourth written inline at a call site
is the drift this file exists to end.

**[filters.js](../public/filters.js) `reconcileSelection()`** — THE gate.
Prunes `state.selected` against `state.facets`, toasts what it took, returns
the count. Names the value when there is one to name; a count past that.

Four callers, and the funnel is the point — the fifth road to this Map is a
matter of time:

- `applyFilterConfig` — a saved config, and an alert's "Show all matching
  items" ([alerts-modal.js](../public/alerts-modal.js)).
- boot ([app.js](../public/app.js)) — `?f=`/`?fx=` are decoded ~100 lines
  before the board's vocabulary exists to check them against. Gated on
  `boardData`: an empty facet list is also what a FAILED board fetch leaves,
  and taking someone's filters away over a 500 is worse than stale ones. Placed
  after the two redirects, so a board that isn't ours doesn't toast on its way
  off the page. `syncFiltersToUrl` then rewrites the address without the dead
  pairs — the link self-heals.
- the board modal's `onSaved` ([toolbar.js](../public/toolbar.js)) — **the half
  a door can't see.** The selection was valid when it arrived and stopped being
  valid while it sat there. No reload separates the edit from its own reader,
  which makes this the likeliest way anyone reaches the state at all: you
  delete the value you are standing on.

The sentence-to-selection search being built
([conversational-search-plan.md](conversational-search-plan.md)) is the fifth,
and the one caller certain to name a value that never existed — an LLM choosing
facet values. It inherits the gate by writing `state.selected` and calling
`applyFilterConfig`, with nothing to remember.

## What the build corrected

**The rail's system rows are not the same problem, and were left alone** (the
user's call, after the distinction was put to them). `~uploaders` and
`~clusters` have universes computed from live data — an uploader leaves when
their last card is deleted, clusters recompute — so nobody made a choice that
stopped being available and a click-off is the right answer. `~objects` is
mapping-declared and could have gone either way; splitting it would leave two
philosophies three lines apart in one function, which is worse than the
inconsistency it would fix.

**Exact string comparison is correct, and was checked rather than assumed.**
The board modal normalises every value to lowercase-kebab over a restricted
charset, and the tagger only ever writes declared values (`allowed`). No
case/whitespace layer needed.

**`fit` needs no exemption.** It is the tagger's whole-item verdict, reserved
in the prompt schema, and never appears in a selection. Pinned by the `~`-only
exemption test rather than by a second special case.

**A selection is never persisted to localStorage** — only the URL — so the
entry-point census is closed rather than open-ended.

**[browser-stub.js](../test/browser-stub.js) grew a real element.** toast.js
now runs for real under test, and it styles, listens on and removes what it
builds. Absorbed into the one stub, per that file's own header.

## Checked and left alone

**The alert editor already shows a stale condition honestly.** It renders chips
from the STORED condition rather than from `state.facets`, so a deleted value
appears as an ordinary chip with its own remove button — nothing silently
prunes an alert when you open it. It just doesn't say the value is dead.

**Board switching is a navigation** (`location.href` from the switcher), so
boot's gate covers it; there is no in-place board swap to reconcile.

**`state.facets` has exactly two writers** — boot and the board modal's
`onSaved` — and both are gated. The modal's payload is guaranteed an array
before the save is allowed to happen (`if (!Array.isArray(payload.facets))`),
so the gate can never meet an undefined vocabulary and drop everything.

**Nothing else writes `state.selected` from outside the rail.** `search.js`
doesn't touch it; `resetListFilters` clears it and is followed by a gated
apply; `toggle` can only reach values that have chips.

## Not done

**MCP has the same hole and the worst error message.** `search_board` doesn't
check `facets` against the board, so an agent naming a value that doesn't exist
gets zero rows and "Try fewer facet values, or call describe_board to check the
vocabulary" — a guess where `pruneToDeclared` would give it the fact. Cheap now
that the helper is shared; deliberately out of scope for this pass.

**Alerts are only half-covered.** Viewing an alert's condition goes through the
gate; the alert's own matching does not, so a condition naming a deleted value
still goes silently dead in the sweep. Same helper, server side, one surface to
decide (a `stale` flag on the row? the alerts list?) — unbuilt.
