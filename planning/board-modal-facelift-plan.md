# Board modal facelift (2026-09-21)

**Status: BUILT 2026-09-21, uncommitted.** All six stages in one pass. Unit
suite 1844/1844 (was 1850; prov-band.test.js deleted with its component),
browser suite 52/52 against source AND against `public/dist` (rebuilt).
Verified in the real app through the browser harness (admin session, real
Chromium): new/edit titles, focus in the name for new only, Esc folds the
strip not the modal, a glyph opens its own row, the Mapping pane shows
"Card", narrow width holds. Glyph states checked both ways: no key = four
amber with tooltips; a bound tagger = tag black "· app default", extract
black "· follows tagging", the sidecar pair amber. Zero console errors.

Two things the build added beyond the plan:

- **The MCP tab** (admin.html + account.html) wore `srcSparkle` via
  `data-icon` — the one HTML user the JS grep couldn't see; the mcp-tab
  browser test caught it as an "undefined" prefix. It gets its own `bot`
  glyph (a bot head: the tab is where agents connect), not another borrow.
- **`.pane-toggle:first-child { margin-top: 0 }`** — with the name gone from
  the body the toggle is the body's first child and its 14px top margin
  stacked on the body padding; the mockup's gap is the padding alone.

Nothing on the wire changed. Server touched in one line (the extract
capability's icon name).

**Simplify pass 2026-09-22** (4 agents: reuse, simplification, efficiency,
altitude). Efficiency found nothing — the diff is net-negative work, and the
glyph repaint runs on human clicks, not on a tick, so `statusChip`'s
change-guard discipline does not transfer. The rest converged on one theme:
the deletions left shared vocabulary with one wearer.

- **`wireFold` grew a head ELEMENT instead of being abandoned.** The
  hand-rolled `setStripOpen` was the helper's body minus the click wiring, and
  the aria mirror was written a third time at the button. `wireFold(el, head)`
  now takes a node or a selector and seeds aria from the state. Two callers,
  generality used.
- **The header button is built up front, empty**, beside its caption, so the
  fold is wired once instead of through a nullable bridge and a `capBtn?.`.
  `.glyph-btn:empty { display: none }` keeps it invisible until the feed
  appends marks — the same `:empty` idiom the slot itself uses.
- **`.glyph-btn` stopped borrowing the `status-chip` class.** The pill
  geometry is a two-selector list; the verdict contract (tone, dot, live,
  the presenter) stays with the verdict. This is what made `.warn` mean an
  amber ground on one component and amber ink on the other, ten lines apart,
  and it let the shared comment drop the "except as a `<button>`" caveat.
- **`.glyph`'s ink became `var(--glyph-ink, #868c96)`.** The atom was
  asserting a colour its host had to out-specify. NOTE: the token must be
  `currentColor`, not `inherit` — a CSS-wide keyword on a custom property is
  resolved at the property level ("take the parent's `--glyph-ink`", unset)
  instead of being stored as the token `var()` substitutes. Verified live:
  glyphs in the button are `#111`, glyphs everywhere else unchanged.
- **`mappingBand` deleted from the wire.** Its last reader was one redundant
  conjunct (`c.mappingBand && c.delegatesTo`); only `extract` has a delegate
  floor, so the flag filtered nothing and `detect`'s copy could never match.
  It was named after the deleted band.
- **Smaller:** `resolved()` (one caller, recomputed `decider(p)` that the next
  line already had) and `openStripAt`'s now-unreachable null guard deleted;
  the tooltip's nested-ternary-in-template became one named `origin`; the fold
  head/caret/summary vocabulary moved into `.disclosure`, its only wearer;
  `.pane-toggle`'s `:first-child` exception moved into the block that states
  this file's margin philosophy, scoped to `.modal-body >` (it was also the
  only native CSS nesting in the stylesheet); `SCAN_CORNERS` hoisted, the one
  duplicated path in `ICONS`; the `bot` glyph moved out of the middle of the
  comment paragraph documenting `plugin`; stale "Using …" / band pointers
  swept from five files.

Skipped: dropping `capability` from mapping-modal's SOURCES table (no client
reader, but the table mirrors `server/field-sources.js`, which does read it —
the doc line was fixed instead), and a local heading helper in the mapping
pane (2 call sites, different margins, no net saving).

**Two corrections after looking at it running (2026-09-22):**

- **The marks read, they do not act.** Per-glyph click targets are gone: the
  button is ONE target that opens the strip, and every capability has its row
  inside. Four hit areas inside one ~90px control, each landing somewhere
  different, is a puzzle rather than an affordance. Tooltips stay — they are
  what keeps amber from being a colour alone. `openStripAt` lost its only
  caller and went, taking `.frow.flash` + its keyframes + its reduced-motion
  entry (nothing else ever triggered that highlight).
- **13px → 15px.** The marks read grey and the instinct was to blame the ink,
  but the ink was already `#111` (measured in the browser, twice). At 13px a
  2-unit stroke in a 24 viewBox lands near 1px, and an antialiased 1px line
  of `#111` reads grey however it is declared. The stroke ratio is left at
  the set's own 2 — the fix is size, so these marks stay the same weight as
  the identical ones in the strip rows (17px) rather than becoming a bolder
  variant of them. Header grows 2px.

## What's wrong with the top of the modal

Six stacked things before the first control you'd touch: header, the AI-models
strip head, a "Board name" label, the input, the pane toggle, then a "Using
gpt-5.4-mini · Change" band — and the Mapping pane repeats that band once per
capability. In edit mode the name appears twice (the header IS the board name,
and the field holds it again). Three separate surfaces say which model tags the
board: the strip head's summary, the Tagging band, the Mapping bands.

The Mobbin pass (about 55 create/edit dialogs) settled the shape question: no
dialog puts an editable name in the header chrome, and every one with tabs
shows a static title with the name as a field. The mockup that won is the
Adobe Express / Loop shape — static title, an unlabeled name field directly
under it, still inside the header block — plus one chip in the header's
status slot standing in for the whole strip head.

## The changes

1. Title is chrome: "New board" / "Edit board". The name field moves into a
   header sub-row, no label, placeholder "Board name".
2. The AI-models strip loses its head. A chip in the header's status slot
   (the slot ingest-modal fills with its status chip) opens the strip body.
3. The "Using … Change" bands go, from both panes. provBand dies with them.
4. A "Tagging Settings" heading opens the Tagging pane. Copy JSON / Paste JSON
   become Copy / Paste.
5. The Mapping pane's identity + face rows get a section heading, "Card",
   parallel to "Extract Fields".
6. Field extraction gets its own glyph in place of the generic sparkle; the
   embed mark drops to four dots.

## Stage 1 — header: title + name sub-row

`createModal` keeps its header exactly as it is (title | status | ×). The
board modal inserts a `div.modal-subhead` between the header and the strip,
the same way it already inserts the strip
([board-modal.js:485](../public/board-modal.js#L485)). Insert order becomes:
header, subhead, strip, wrap(body, footer).

```css
.modal-subhead { flex-shrink: 0; padding: 0 20px 16px; border-bottom: 1px solid #eee; }
.modal-header:has(+ .modal-subhead) { border-bottom: 0; }
```

The header's own hairline moves under the sub-row, so the input reads as part
of the header block, which is the mockup. `:has()` is already in modal.css
(the placeholder-select rule), so no new browser floor.

**Rejected: `flex-wrap` on the header** with the input at `flex-basis:100%`.
One line of CSS, and it would let the status slot wrap to a second line instead
of ellipsizing — the exact contract the ingest modal's chip relies on
([modal.css:62](../public/modal.css#L62)). The header row stays a row.

The input keeps `id="board-modal-name"` — `draft()`, the focus rule
([board-modal.js:998](../public/board-modal.js#L998)) and
[board-modal-gate.test.js:110](../test/board-modal-gate.test.js#L110) all read
it by id and stay untouched. It gets the base `.modal-dialog input` look for
free; width 100%. Placeholder "Board name" replaces "e.g. Wardrobe Items" — with
no label, the placeholder is the only thing naming the field.

`createModal({ title: isNew ? "New board" : "Edit board" })` — dialog
`aria-label` follows. The saved/created toast still names the board, so the
name is never nowhere.

## Stage 2 — the chip replaces the strip head

**What's reused:** the status slot. It was carved for exactly this — every
modal has one, empty it costs nothing, under width pressure it yields first and
its label ellipsizes while the title never shrinks. Nothing to add there.

**What the chip is.** The words "AI models" as plain slot text (13px, the
slot's grey), and beside them a button holding one glyph per capability the
feed says boards may pin — the same `cap.icon` each strip row wears, the same
loop, at 13px in default ink (`#111`, not the chip grey: these are marks, not
a caption). Nothing names a capability; a plugin that adds one gets its
glyph. Before the feed lands the slot shows the words alone, no button.

Each glyph carries the state of ITS capability, two states only:

| state | look | tooltip |
|---|---|---|
| will run (board pin or app default) | normal | "Tagging · gpt-5.4-mini · app default" |
| nothing configured anywhere | warn tint (amber) | "Tagging: no model configured" |

**Not red, not faded.** Faded means off / not applicable, and a capability
with no model is in use and will fail. Red is the error tone; this is a
config gap. Amber is what the Mapping pane's empty band already used for the
same case. And "following the app default" is NORMAL — a fresh board must not
open with four faded glyphs.

**The state follows delegation.** An extractor with no pin falls back to the
tagger, so its glyph asks the resolved picker (`decider(p)`, the strip's own
rule at [board-modal.js:~890](../public/board-modal.js#L890)), never its own
select. Otherwise every board shows extract amber.

**Each glyph is a door.** The chip opens the strip; a glyph opens it AT that
capability's row with the flash — `openStripAt`, unchanged. The tooltip makes
amber more than a color: it says which capability and what's missing.

**Reuse.** `statusChip()` is a single tone-bearing verdict with a presenter
contract; this is words plus a glyph run, so it doesn't go through `set()`.
What's reused is the header slot and the chip's geometry (the `#f6f6f9` /
6px-radius pill): the button is `<button class="status-chip glyph-btn">`, and
modal.css gains

```css
.modal-status .slot-label { font-size: 13px; color: #6b6b72; margin-right: 8px; }
button.status-chip { border: 0; font: inherit; cursor: pointer; }
button.status-chip:hover { background: #ededf2; }
.glyph-btn { gap: 7px; padding: 5px 8px; color: var(--text, #111); }
.glyph-btn .glyph { display: inline-flex; color: inherit; } /* .glyph's own grey is source ink */
.glyph-btn svg { width: 13px; height: 13px; }
.glyph-btn .warn { color: #e09f3e; }
```

The modal.css comment updates: a verdict, and as a button, the door to where
the verdict is set.

**Mechanics.** `wireFold(el, headSel)` finds the head INSIDE the strip
([board-modal.js:~410](../public/board-modal.js#L410)); it takes a head element
too now, so the chip in the header can drive `stripEl.classList.toggle("open")`
and carry `aria-expanded`. `openStripAt`, `onStripKey`, the scrim and the
wrap are untouched. `#board-modal-models-summary` and the `.strip-head`
markup go.

A closed strip with no head is a zero-height element that still draws its
`border-bottom` — a stray hairline directly under the sub-row's own. The
strip's closed border rule goes (`.modal-strip:not(.open) { border: 0 }` or
simply `display:none` closed); open, the scrim's edge is the only line, as
today.

The chip only exists when `canEditAI` — the non-admin gallery pencil opens a
modal with an empty slot, invisible, same as before.

## Stage 3 — the bands go, and provBand with them

**Tagging pane:** `tagBand` and its prepend, gone. `openTagRow` loses its
caller (the chip body opens the strip plainly; glyphs open rows via
`openCapRow`). `bandState(p)` survives renamed — it is now each glyph's
state, for every picker, not just the tagger's.

**Mapping pane:** the whole band apparatus is dead once nothing pushes into
it: `bands` Map, `applyBands`, `usedCapabilities`, `setBands`, `lastBands`,
the `prov` container in `render`, the `onCapabilityChange` option
([mapping-modal.js:187-224](../public/mapping-modal.js#L187-L224)). In
board-modal, `mappingBands()`, both `setBands` calls (pane toggle + presentation)
and the `onCapabilityChange: openCapRow` line. `openCapRow` keeps a caller — the chip's glyphs. `bandCaps`/`delegatingCap` stay only long enough to find
`tagPicker`.

**modal.js:** `provBand` loses both users → deleted, with `.prov` in modal.css
([modal.css:445-461](../public/modal.css#L445-L461)) and
[test/prov-band.test.js](../test/prov-band.test.js). Deletion means deletion;
suite count drops by that file's tests.

Nothing is lost that the chip doesn't carry: the bands' per-capability empty
state ("No extractor configured — Set one up") is the amber glyph with its
tooltip, and the click lands on the same row "Set one up" did.

After shipping: the memory note "board-modal-redesign: Models pane +
provenance lines" is stale — the provenance line is the chip now.

## Stage 4 — heading + button words

`sectionHeading("Tagging Settings")` opens the first `.modal-section` (the
one carrying `border-top:none;margin-top:0;padding-top:0` inline). It sits
above the auto-tag switch; the section's existing
`.modal-section > .section-heading { margin-bottom: 12px }` spaces it.

`buildGuidanceClipboard`: "Copy JSON" → "Copy", "Paste JSON" → "Paste"; the
"Copied!" flash restores to "Copy". The paste-failure toast keeps saying JSON
— that's the error, not the button.
[board-modal-gate.test.js:316](../test/board-modal-gate.test.js#L316) and
`:336` find the button by `textContent === 'Paste JSON'` → `'Paste'`. The
comment at [guidance-json.test.js:59](../test/guidance-json.test.js#L59) is
prose only.

## Stage 5 — Mapping pane section heading

`sectionHeadingEl(<name>)` before the `.mm-def` block in `render`
([mapping-modal.js:444](../public/mapping-modal.js#L444)), margin `0 0 8px`
(the first heading has no room to reserve above it; "Extract Fields" keeps
its `10px 0 8px`). `.mm-def`'s own 4px top padding stays.

**The name: "Card".** The rows already say it — "each file is its own
card", "each entry is its own card", "what a card draws when nothing renders"
— so the heading names what the rows define in the pane's own word. Not
"Gallery card": gallery is the boards page's word, and the same card opens in
the lightbox. Not "Entity": that's the code's word, never the UI's.

## Stage 6 — extraction gets its own glyph

`srcSparkle` is a four-point star, the generic "a model did this" mark, and
it is the extract capability's icon in the feed
([server/capabilities.js:138](../server/capabilities.js#L138)), the extract
source's glyph in the mapping pane, and the identity drawer's "AI extraction"
card. Beside tag / wave / frame / embed in the chip it is the one glyph that
names a technology rather than a job.

Rendered eight candidates at 24, 13, 12 and 19px, in the chip row and in a
def row (scratch sheets, 2026-09-21). **Picked: scan corners with two text
lines** — the detect frame's own corners (the same "look at the item"
bracket) with lines where detect has a circle: read text out vs find a thing.
Side by side at 13 and 12px the two read as lines vs circle; the three-line
variant was the one that turned to mush, so it's two. Rejected on the
render: file-with-arrow-out (crisp but didn't read), file with lines
(is `srcFile` at 12px), text cursor, table, braces, list.

```js
srcExtract: glyph('<path d="M4 8.5V5.5a1.5 1.5 0 0 1 1.5-1.5h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3"/><path d="M8 10h8M8 14h5"/>'),
```

The corners path is `srcFrame`'s verbatim, so the two are one family on
purpose; if `glyph` grows a shared-corners helper later that's where it goes,
not now.

`srcSparkle` is renamed, not kept — a glyph with no user is dead weight, and
the two-star `sparkle` (the boards page's AI-fields chip) is a different
glyph with its own comment. Users to move: the feed icon, mapping-modal
(source row, identity def row, drawer head, "AI extraction" card), grid.js
"Re-extract fields", and the gate test's fixture.

**Found on the way:** [grid.js:348](../public/grid.js#L348) draws "Find
similar by meaning" with `srcSparkle`. That's embeddings' job and embeddings
have their own mark (`embed`, with a comment about exactly this kind of
borrowing). It moves to `embed` in the same commit.

**Embed loses its stray fifth dot.** The current mark is five dots "scattered
in a plane"; at 13px in the button the fifth reads as a smudge. It becomes
four dots in a horizontal rhombus — rendered at r=1.7 and r=1.9 with three
spreads, the larger dots on the wider spread survive 13px best:

```js
embed: glyph('<circle cx="4" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="7" r="1.9" fill="currentColor" stroke="none"/><circle cx="20" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="17" r="1.9" fill="currentColor" stroke="none"/>'),
```

Its comment keeps the why (points in a plane, filled because a stroked figure
closes up small) and drops the "five-part" wording.

`public/dist` is the built bundle — `npm run build:frontend` after, or the
served app keeps the star.

## Second pass (after build)

- Open a NEW board: caret in the name field, title "New board", the slot
  says "AI models" with no button until the feed lands, then the button with
  one glyph per capability in black ink, none amber on a normal install. Save dead until a
  name is typed (gate).
- Open an EXISTING board as admin: title "Edit board", name filled, no caret,
  chip shows the glyphs. Click the chip → strip opens under the sub-row, scrim
  dims body + footer, Esc folds the strip not the modal. Click ONE glyph → strip opens at that
  row, flashed. Remove the app-default tagging key → that glyph goes amber
  with the tooltip saying so; the extract glyph follows it.
- Open an existing board as a NON-admin (gallery pencil): no chip, no strip,
  no stray hairline.
- Narrow the window: the chip ellipsizes, the title doesn't, the × stays.
- Mapping pane, admin: no band, heading above identity/face, "Extract Fields"
  below. A field bound to extract with no extractor pinned — confirm the strip
  row shows the delegated value.
- Copy → "Copied!" → "Copy". Paste with guidance JSON on the clipboard arms
  Save (the gate test covers it; check it live once).
- `npm test` + browser suite against source AND `FRONTEND_DIR=public/dist`.
- grep for `provBand`, `setBands`, `onCapabilityChange`, `models-summary`,
  `strip-head`, `Paste JSON`, `srcSparkle` — all zero (source, not dist).
