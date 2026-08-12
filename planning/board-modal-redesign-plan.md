# Board modal redesign — behavior up front, models out of the way

**Status: SHIPPED 2026-08-11, uncommitted at time of writing. Suite green
(`npm test`: 980, 0 failures, post-review-pass). Verified live (Playwright drive: open modal → band's Change opens the
strip at the Tagging row → pin transcription → strip summary updates → Save →
columns round-trip: `transcribe_provider: "whisper"`, `transcribe_key_id:
null`, extraction still delegating). Interactive mockup that drove the design
review: https://claude.ai/code/artifact/95ff7bc8-fd39-4251-833a-9f1d3c76ef99
("Board modal, redesigned" — its final state matches what shipped, minus the
caret glyph swap).**

## The problem

The board editor's Tagging tab had become a wall: three provider/model picker
pairs at the top (tagger, transcriber, detector — each with its own "this
board's own X provider; the app default when unset" parenthetical), four
toggles, a disabled toggle whose explanation had to justify its own
disabledness, a passes select with a cost warning, and only then — below all
of it — the thing the app is actually about: the taxonomy. Meanwhile the
Mapping tab carried a fourth, hand-built picker (extraction provider), the one
picker in the system not driven by the capability registry.

The redesign brief, in the user's words: simplicity and agnosticism; keep the
versatility but don't overwhelm new users; progressive disclosure based on
immediate needs; transparency. Plus one hard constraint added during review:
**the taxonomy/facet editor is the star of the app and must not be demoted or
altered.**

## The principle

**Separate what a board does from what powers it.** Mapping and Tagging keep
only behavior. Every provider/model choice lives in one AI-models fold, and
each pane that depends on a model says — in one quiet line — which model will
actually run. A new board is three decisions (name, context, auto-tag) and
zero dropdowns; every knob is still one click away.

Three sub-rules the review converged on:

- **Folding hides controls, never state.** Every collapsed surface summarizes
  its contents in its own header: the strip's collapsed line names the tagging
  model and counts board-specific choices; the Advanced fold's header reads
  "Explain tags · double-check ×3". The resting view is a status display.
- **Provenance instead of pickers.** "Using prod — openai · gpt-5.4-mini —
  Change" answers the transparency question without asking the user to operate
  anything. The active model is visible at the point of use; configuration
  lives elsewhere; override is one click away.
- **Models are plumbing, not a peer of the work.** Whatever surface holds them
  must have less visual weight than the Mapping | Tagging control, must not
  float, and must not navigate.

## The shipped anatomy

**The AI-models strip** (`.modal-strip`) — a full-bleed collapsible band
mounted between the modal header and the scrolling body, outside both panes,
so it is shared by both tabs and visible at any scroll position. Collapsed:
one line, "▸ AI models — prod — openai · gpt-5.4-mini · 1 board choice".
Expanded: one flat row per pinnable capability (`.frow`, hairline-separated,
no boxes in boxes), each showing name + blurb left and current value + source
("app default" / "chosen for this board" / the resolved delegate) right;
clicking a row folds out its key + model selects (one row open at a time).
While the strip is open a scrim dims the modal body below — click it or press
Esc to fold (the Esc handler registers in the capture phase so it wins over
modal.js's own Escape-closes-the-modal listener). Admin-only, like the
pickers it absorbed. No explanatory prose inside — the rows and their source
labels carry all the explanation.

**Provenance bands** (`.prov`) — centered one-liners on a soft ground, copy
exactly "Using <name — provider · model> Change". One at the top of the
Tagging pane; one directly below the Mapping pane's "AI-extracted fields"
title. Change opens the strip with the relevant row expanded and flashed.
Bands re-render on picker change and pane reveal. **Corrected 2026-08-12 —
this paragraph shipped claiming a third trigger, "strip toggle", that was never
wired, and leaning on the reveal push to cover a provider's live model list
landing, "which repaints a select without firing `change`".** Both halves were
wrong in the same direction. The toggle re-render did not exist, and it would
not have been enough if it had: a landing can MOVE the selection (off a guess
the provider disproves), and repainting labels on a fold the reader may never
touch does not stop Save from writing a model no band ever showed. The landing
now announces itself — `attachLiveModels` dispatches `change` when, and only
when, the value actually moved — so it arrives through the picker-change path
every surface already listens on, and the plugin modal's apply button stops
comparing against a selection that shifted underneath it. The reveal push stays
for what it was really for: edits made while the Mapping pane was hidden.

**The Tagging pane**, top to bottom: band → "Tag new uploads automatically"
(the one primary switch) → **Advanced** (a `.disclosure` fold, closed by
default, header summarizing what's on) → Tagging Guidance (AI context +
taxonomy, unchanged). Inside Advanced: "Explain tags" (was "AI reasoning"),
"Double-check tags" with the passes select and cost note revealed only while
on, "Web research", and a "Re-tagging" group (schedule + on-data-change),
still gated on auto-tagging. Double-check and web research remain **separate
switches** — the review explicitly rejected merging them into one radio group
— with the server-enforced mutual exclusion expressed as turning one on
switching the other off, instead of a grayed switch to puzzle over. Web
research additionally disables live while the tagging provider doesn't
advertise it, with a hint naming who could ("needs a tagging model from
anthropic — pick one under AI models") — provider truth from the catalog's
`provides.research`, the who-could list from the feed's modifier roster, no
provider names in client code.

**The taxonomy** closes the Tagging pane with the open-ended slot where it can
grow without burying anything. The facet editor, guidance clipboard,
`normalizeGuidance`, and facet-diagnostics blocks are untouched — the only
thing that changed around them is that the compact settings sit above instead
of the picker wall.

## What moved where (the registry consequences)

The strip's rows are the same registry loop the Tagging tab already had —
`planBoardPicker` (capability-present.js) per capability with `boardBinding`
— re-mounted with fold-out presentation. That made two special cases
deletable:

- **The hand-built extraction select** (mapping-modal.js, ~65 lines with its
  own fetches, its own `extractLoaded` save-gate, its own dead-pin fallback)
  is gone. Extraction is now a generic strip row; its pin rides the same
  `aiLoaded`-gated full-state payload as every other capability, and
  `collect()` returns `{ mapping }` only.
- **`boardPickerHome: "mapping"`** became **`mappingBand: true`**: the field
  no longer moves a picker (nothing is excepted from the strip); it marks
  which capability's provenance the Mapping pane surfaces — and, through that
  capability's `delegatesTo`, which picker the Tagging band reads. Both bands
  resolve from data; the client still names no capability.

`planBoardPicker` gained one branch: a delegate capability with nothing of its
own bound app-wide answers its unset row with the relationship ("Same as the
tagger") instead of a false "App default (none configured)"; the shell follows
that answer — `plan.delegated`, never the raw `delegatesTo` — through the live
pickers, so the surface still names the model that will actually run, unsaved
edits included. Payloads, preselects, and the
model axis are unchanged. Its `title`/`hint` fields are gone — the strip rows
read `cap.label`/`cap.blurb` from the feed instead, so the plan lost its last
presentation strings. Two board-modal exports died with the extraction select
(`keyLabel`, `withDefaultNote` — nothing imported them anymore), and both fold
surfaces (strip, Advanced) share one `wireFold` helper.

**Corrected 2026-08-12 (89aca9e) — the shell shipped reading `cap.delegatesTo`
directly, and this document told it to.** The feed carries that field for any
delegate-floored capability, which is a fact about its descriptor and not about
what it is doing; delegation stops being the story the moment an app-wide
default of the capability's own is stored. `planBoardPicker` had always tested
both halves. The two copies the shell made — the strip row's source line and
`resolved()` behind both provenance bands — kept only the first, so on an app
with an app-wide extract default the row printed extraction's own model above
the TAGGER's as its source, and the Mapping band told the reader the tagger was
doing the extracting. The pair is now one exported predicate, `isDelegating`,
which the planner publishes as `plan.delegated`: the planner decides *whether*
to follow, the shell only resolves *what that comes to live*. Read the split
that way and the shell has nothing left to get wrong.

## CSS: generic components only (house rule)

Everything added to modal.css is a reusable component, never named for its
first use: `.modal-strip`/`.strip-head`/`.strip-body` (full-bleed collapsible
band under any modal header), `.frow-*` (fold-out row list — summary line over
an inline editor), `.fold-summary` and `.chev` (shared by the strip and
`.disclosure`), `.prov`, `.linkbtn`, `.modal-body-wrap`/`.modal-body-scrim`
(the scrim pairs with any open `.modal-strip` via a sibling selector). The
first draft used `.cap-*` names and collided with admin.html's existing
`.cap-head` — modal.css loads on that page — which is exactly why the rule
exists. Fold carets are `ICONS.chevron` (1em, `currentColor` — same size and
color as the text they accompany; `rotate(-90deg)` closed, natural
down-pointing open), never a `▶` text glyph. The strip-width hover bleed on
`.frow-head` lives in a `.modal-strip .frow-head` context rule, not in the
base component.

## Design-review record — rejected containers (do not resurrect)

The models surface went through seven containers before the strip. The
rejections are as load-bearing as the result:

1. **Third tab** (Mapping | Tagging | Models) — rejected: equal weight for
   plumbing.
2. **Footer link + override dot** — rejected: footer is the wrong place; the
   dot signified nothing to the reader.
3. **Body-swap sub-view with a Back bar** — rejected: back navigation inside
   a modal is clumsy.
4. **Body-swap with the tab strip left visible, deselected** — rejected:
   "hacky"; a segmented control with no segment selected is a state that
   shouldn't exist.
5. **Second stacked modal** — rejected: dialog-on-dialog ceremony.
6. **Header popover** ("AI models ▾") — rejected outright.
7. **In-body boxed disclosure** — right pattern, wrong chrome: boxes within
   boxes within boxes.

The fix for 7 produced the shipped design: move the fold out of the body,
attach it full-bleed under the header, and flatten everything inside it. Other
review corrections worth remembering: no explanatory prose inside the strip
(intro line, status line, and "applies on save" note were all cut as noise);
band copy is exactly "Using <model> Change" (no "Tagged by", no "(app
default)" parenthetical); the scrim was requested, not invented.

## Files

- `public/board-modal.js` — strip + scrim + Esc capture; pane reorder;
  Advanced fold with live summary; both bands; capability loop → `.frow`
  rows; research gating; band/summary resolution through `delegatesTo`.
- `public/mapping-modal.js` — extraction select deleted; new contract
  `{ isDirty, collect, setExtractionLabel }` + `onExtractionChange` option;
  band re-appended by `renderFields` (which wipes its container).
- `public/capability-present.js` — delegate-aware unset row.
- `public/modal.css` — the generic components above.
- `server/capabilities.js`, `server/capability-status.js` —
  `boardPickerHome` → `mappingBand` (the only server change).
- `test/capability-present.test.js` — +1 test pinning the delegate row.

Board-admins (`canEditAI: false`) see no strip and no bands — they cannot
fetch the admin feeds, and the settings GET withholds pin columns from them —
matching the pre-redesign permission surface exactly.
