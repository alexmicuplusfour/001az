# The source as a field: tile summary + chooser drawer

**Status: SHIPPED 2026-08-24, all six slices** (drawer extensions;
promotion sweep; source-chooser.js; ingest source section rewired — add
menu + tile + chooser, path row / Pull from / Test deleted;
source-browse-modal.js and its orphaned CSS removed; suite 1216/1216
green). Remaining: the §10 manual eyeball pass in a live browser —
untestable from the suite, all client-side. Uncommitted alongside the
ingest-missing-source work.
Companion to `ingest-missing-source-plan.md`, which this partly supersedes: the
*policies* that plan landed (silent-when-healthy probes, the eager/on-demand
axis, 404-ascend relinking, connection+path as one atomic commit, add/remove
instead of implied defaults) all carry over unchanged — what changes is the
furniture they live in.

## 1. What changes, in one look

Today's Source section is a form: a "Pull from" row (source-type select), then
a path row (root prefix + input + Browse… + Test + ×), then the subfolders
switch — and Browse opens a second modal stacked on the first.

It becomes the mapping pane's Fields model:

```
nothing added                      source added
─────────────                      ────────────
Source                             Source
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐           ┌──────────────────────────────────┐
    + Add source                   │ ▣  ingest-root/wardrobe        × │
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘           │    Local folder · includes       │
                                   │    subfolders                    │
                                   └──────────────────────────────────┘
                                   ✗ folder "wardrobe" doesn't exist…   ← only on error
```

The tile is a **summary, not a form** — nothing on it is editable. Adding
follows "+ Add field" to the letter: **"+ Add source" opens the rich
dropdown** (dropdown.js — the add-field menu's component), one row per
installed source kind:

```
                + Add source
┌───────────────────────────────────────────────┐
│ ▣  Local folder     on the server's ingest root│
│ ◌  FTP / FTPS       a folder on a server       │
│ ◌  S3               a bucket prefix            │
└───────────────────────────────────────────────┘
```

Picking a kind opens the **chooser** for it: a fixed-height bottom drawer
inside the ingest dialog (the `createDrawer` component the mapping pane's
field editors use), holding everything else that defines the source.
Clicking an existing tile opens the same chooser for the saved kind directly
— no menu; like a field, a tile never changes its kind (that's remove and
re-add).

```
┌ ingest dialog ─────────────────────────────┐
│  (settings dimmed under the drawer scrim)  │
│ ┌────────────────────────────────────────┐ │
│ │ ▣ source                  Local folder │ │ ← drawer-head (kicker = the kind)
│ │ Connection  [mplex ▾]                  │ │ ← remote kinds only
│ │ ingest-root/pixel  [↑ Up]              │ │ ← location line (+ relink notice)
│ │ ┌────────────────────────────────────┐ │ │
│ │ │ 📁 camera            —      Aug 12 │ │ │ ← the tree; owns the scroll
│ │ │ 📁 screenshots       —      Aug 20 │ │ │
│ │ └────────────────────────────────────┘ │ │
│ │ Include subfolders                  ⬤ │ │
│ │                [Cancel] [Use this folder] │
│ └────────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

One primary — **Use this folder** — commits connection + path + subfolders
as a single act. Cancel/scrim/Esc discard the whole draft. The stacked
`source-browse` modal is deleted.

## 2. Why this shape

- **The Fields model already answers every question this section fumbles.**
  A configured thing renders as a bounded object (glyph, name, quiet summary,
  ×); the editor is a drawer; "nothing on a tile is editable — the drawer is"
  (modal.css's own words). The source is one more configured thing.
- **"Pull from" dies because it was never a setting.** The source kind is
  *what you're adding*, not a knob on something that already exists — and the
  fields model already solved that: the add menu picks the kind, the drawer
  configures it, and a tile never mutates its kind (changing it is remove and
  re-add). The kind is settled by an explicit menu pick *before* the drawer
  opens — never pressed inside it as a default nobody chose — and the drawer
  then commits **connection + path + recursive as one act**, the
  atomic-commit rule.
- **Drawer instead of a stacked modal.** `source-browse` is the app's only
  modal-on-modal. The drawer component was built generic for precisely this
  ("any modal whose editors currently inline-expand… has this exact problem"),
  and its contract — draft in `build`, commit only via the primary, no
  dismissal path half-applies — is the doctrine this section already follows.
  It also fixes a real flaw for free: while the chooser is open, the scrim
  covers Save/Run now, so a mid-draft save can't happen.
- **Fixed height because trees resize.** The drawer today hugs its content;
  a tree whose height changed with every folder's entry count would bounce on
  every click. A fixed percentage of the dialog gives navigation a stable
  viewport.

## 3. The tile

- **Glyph** per source type: `folder` → new `srcFolder` icon, `s3` → new
  `srcCloud`, `ftp` (and any unknown remote) → existing `srcGlobe`. Two small
  additions to `ICONS` in utils.js.
- **Name** (mono, truncating, full string in `title`): the resolved location,
  the same spelling the chooser's location line uses — `ingest-root/wardrobe`,
  `mplex/pixel/camera`. A root/whole-source pick renders as `ingest-root/`
  (trailing separator = "inside here", the established idiom). A dangling
  saved connection renders the bare path with **no** prefix — a made-up server
  name would vouch for a connection that no longer exists.
- **Summary line**: `{source label} · includes subfolders|this folder only`.
  The type label carries what "Pull from" used to say; recursive must surface
  here because its switch moves into the drawer.
- **×** removes (back to "+ Add source"); title keeps today's warning that
  Save afterwards turns ingestion off. Save semantics are untouched: removed +
  saved config → `{ ingest: null }`; removed + nothing saved → refuse toast.
- **Health line** under the tile: the existing `.im-status tight` line with
  the existing policy, verbatim — eager (connectionless) sources probe
  silently on mount and after a commit, render only errors; remote sources
  stay quiet. The debounced-keystroke probe dies with the path input; only
  the mount/commit probes remain.
- Read-only (`canEdit` false): tile main is a div (no click, no ×); no source
  → a "No source configured." line in the existing `.im-hint` style — no
  borrowed or new class. (Defensive parity — the GET is manager-gated
  anyway.)

## 4. The add menu and the chooser drawer

**The add menu.** "+ Add source" opens the rich dropdown (`openDropdown` /
`ddRow` from dropdown.js — already the app-wide shared component), in the
add-field menu's grammar: leading glyph, the kind's label, a dim right-hand
note (`folder` → "on the server's ingest root", `ftp` → "a folder on a
server you connect to", `s3` → "a bucket prefix"). Picking a row closes the
menu and opens the chooser for that kind. An unusable kind — folder without
`INGEST_ROOT`, remote without connections — renders as a **static row** (no
`onClick`: ddRow's own "line in a list, not a menu item" form) with the
reason as its note, so the menu answers "why can't I?" in place. With a
single installed source there is no menu — the button opens the chooser
directly, the same rule that hides today's one-option type select.

Changing kind later is **remove and re-add**, the fields doctrine. The old
type-select's carry-over of recursive intent dies with it — a fresh add
seeds the schema defaults.

**The chooser.** New module `public/source-chooser.js` replaces
`source-browse-modal.js` (same jurisdiction: navigate a source, pick a
base), rendering into a drawer the ingest modal owns — **born knowing its
kind**:

- Ingest modal holds the mapping pane's lazy pattern:
  `drawerInst ??= createDrawer(dialog)`, opened with the new `tall` variant.
- **Head**: kind glyph + `source` (mono title) + the kind's label as a
  static kicker.
- **Connection row** (remote only): switch → load that server's root,
  commit only on Use. (Revised in live review 2026-08-24: the browse
  modal's display-fallback-to-first is GONE — without a valid saved id the
  picker opens on a "Select connection…" placeholder and nothing loads
  until the explicit pick; a pre-picked first server was an implied choice
  and an unasked connect.)
- **Location line + ↑ Up, relink notice, tree, 404-ascend**: move over
  verbatim (`fmtLoc`, `parentOf`, `goneNote`, seq guard, Use-gating). One
  guard added: `fmtLoc` with an empty base (dangling connection) renders the
  relative path alone, not `/{rel}`.
- **Include subfolders**: the `switchRow`, inside the draft, committed with
  everything else.
- **Foot**: Cancel + `Use this {folder|prefix}` (the schema's word for the
  source's path field). Disabled until a level actually renders — via the new
  `setPrimaryDisabled` (see §5).
- **Commit** hands `{ type, connectionId?, path, recursive }` to the ingest
  modal, which does what pick-then-save does today: write `cfg.source` (via
  `keyFor`), seed the source's schema defaults, nudge a continuous trigger to
  interval when the committed type needs a connection (the nudge moves here
  from the old type-select handler), `renderTriggerModes()`,
  `invalidatePreview()`, re-render the tile, eager-probe.
- **Edit flow**: clicking the tile opens the chooser for the saved kind
  directly (no menu) — its connection selected, the tree starting at the
  saved path. A missing path enters the relink flow (ascend + notice) — the
  drawer *is* the repair surface the error line points at.
- **Non-browsable source** (none installed today, fallback preserved): the
  body swaps the tree for a plain path input; commit takes the typed value.
  Today's fallback bypassed the chooser entirely; now it lives inside it.

## 5. Component work

Per the house rule — a component a second surface adopts stops being the
first surface's property:

- **Drawer (modal.js): two generic extensions**, documented in its header
  contract. `open({ tall: true })` → `.drawer.tall { height: 62%; }` (of the
  host dialog; toggled per open so the mapping drawers stay content-hugged),
  with `.drawer.tall .drawer-body { overflow: hidden; }` and
  `.drawer-body .cb-scroll { min-height: 0; }` so the tree owns the scroll
  (cb-scroll's 200px floor would overflow a short drawer otherwise). And
  `setPrimaryDisabled(on)` — any drawer task with async validity needs it.
- **Tile family promoted**: `.mm-tiles`/`.mm-tile`/`.mm-tile-main`/`-body`/
  `-name`/`-sum`/`-rm` → `.tiles`/`.tile-*` (no collisions in the css; the
  block moves out of the "entity mapping modal" section). A `tileRow({ glyph,
  ai, name, sum, title, onOpen, onRemove, removeLabel, place })` builder lands
  in modal.js; mapping's `fieldTile` and the ingest source tile both use it.
  The `.drawer-title`/`.drawer-src` co-declaration with tile name/sum stays.
- **`glyphEl` → utils.js** beside `ICONS` (it's already a cross-component
  atom: tiles, def rows, source cards, drawer heads). Its class `.mm-glyph`
  → `.glyph` (collision-checked: free).
- **`.mm-face-hint` → `.warn-box`** — the amber statement box the ingest
  modal *already* borrows for the INGEST_ROOT warning, and which the reason
  notes (§8) borrow again. Its `.mm-unavail` modifier is just "no margin —
  the container already spaces me", the concept the status-line family
  names `flush`: it becomes `.warn-box.flush`.
- **`drawerHeadParts` → modal.js** (it builds the drawer's own head
  vocabulary). The source cards (`srcCard`/`.mm-srcopt`) stay mapping's —
  with the kind chosen in the add menu the chooser never needs them, so
  they keep their single consumer.
- **The add menu costs no component work**: dropdown.js is already shared
  by eleven surfaces, and ddRow's static form is the unusable-kind
  rendering.
- **ICONS**: add `srcFolder`, `srcCloud`.

The promotion sweep is mechanical (rename + import), lands as its own slice
with zero visual change, and the chooser then builds on the shared
vocabulary.

## 6. What dies

- `source-browse-modal.js` (absorbed into `source-chooser.js`); no CSS or
  other callers reference it.
- The "Pull from" row and type select (the add menu + remove-and-re-add
  replace them).
- The path row wholesale: input, `.im-affix` prefix, Browse… button, Test
  button, the keystroke-debounced probe and its `isConnected` timer guard
  (no input, no keystrokes — mount/commit probes remain).
- CSS left without a consumer: `.im-source-path`, `.im-affix`(+`.mono`) —
  grep-verify, then delete.
- The Test button's toasts. **The chooser is the test**: opening it performs
  a live read of exactly the committed connection + path — a dead server
  shows the error, a missing path enters the relink flow, an empty folder
  shows "Empty folder." (which for an inbox-style source is good news, same
  as today's "Reachable — nothing here yet").
- The truncation note's "narrow by typing a path" tail (there is no path
  typing anymore) → "Showing the first 1000 entries."

## 7. What deliberately does not change

- **Server: zero changes.** Same browse route, same 404 contract, same save
  semantics, same ledger/key rules. The suite should stay green untouched.
- `keyFor` (folder keeps `folder`, remotes use `path`), the legacy
  normalization (saved bare `{type}` → `""`), `sourceAdded()` gating of
  Preview/Save, the Off trigger default, filters/sort/trigger/preview
  sections, the status line, footer buttons.
- The eager/on-demand probe axis and silent-when-healthy.

## 8. Edge cases

- **Legacy whole-root config** (`{type:"folder"}` → normalized `""`): tile
  reads `ingest-root/` — the formerly invisible root watch becomes explicit.
- **Dangling connection**: tile shows the bare path, no prefix; opening the
  chooser lands on the "Select connection…" placeholder (the saved server
  is gone — no substitute is presumed); the explicit re-pick is the repair.
- **All installed sources unusable** (no INGEST_ROOT, no connections):
  "+ Add source" is replaced by the applicable reason note(s) — a menu of
  only-static rows would be a click into a dead end. Partial availability
  keeps the button; the unusable rows carry their reasons in the menu.
- **Esc layering**: the drawer's capture-phase Esc already stops the ingest
  modal from closing under it — verified in the component.
- **S3 >1000 entries in one level**: navigation-only can't narrow past the
  cap anymore. Accepted for now; if it bites, a "jump to path" field in the
  chooser is the follow-up, not a revived inline input.
- **Focus after commit**: the opener (add button / old tile) is replaced by
  the re-render, so focus the new tile's main button after commit rather
  than letting the drawer's focus-return land on a detached node.

## 9. Decision points

1. **Drop the Test button** (recommended). The chooser performs the same
   read with a richer answer. Reversible — the `check()` helper it shared
   with the probe survives as the probe.
2. **Promotion scope** (recommended: the full §5 sweep). Conservative
   alternative: reuse the `mm-*` classes cross-modal and only move the CSS
   block's section comment — less churn, but it leaves mapping's name on
   shared furniture, against the house rule.
3. **Tall drawer height**: landed at 62%, raised to **80%** in live review
   (2026-08-24) — the tree wanted more of the dialog.
4. **Primary label**: `Use this folder` / `Use this prefix` per the schema's
   field label (recommended) vs. one fixed string.

## 10. Manual checklist (client is untested by the suite)

- Add menu: one row per installed kind with its note; unusable kinds render
  static with their reason (no hover, skipped by the arrow-key walk);
  single-source install skips the menu straight to the chooser.
- Local: add → root pick (`ingest-root/` tile) · subfolder pick · rename the
  folder on disk → silent probe paints the error → tile click → relink flow
  → Use → error clears.
- FTP: add → type card → connection select → pick (tile `mplex/…`) ·
  connection switch mid-browse resets to that server's root · dangling
  connection repair · dead server shows the error in the drawer, Use stays
  disabled.
- S3: prefix pick, `Use this prefix` label, empty prefix shows "Empty
  folder." and Use stays enabled (empty is pickable — draining is normal).
- Drawer: Cancel/scrim/Esc discard; Esc doesn't close the ingest modal;
  Tab is trapped; Save/Run now unreachable under the scrim; reduced-motion.
- Tile: ×, remove+Save clears config ("Ingestion removed"), re-add, sum
  reflects recursive, long path truncates with full title.
- Mapping tab after the promotion sweep: pixel-identical tiles/drawers.
- Trigger: committing a remote source nudges continuous → interval; modes
  re-render per source.
- Suite: unchanged and green (no server edits).

## 11. Slices

1. modal.js drawer extensions (`tall`, gated primary) + CSS — detailed in
   Appendix A.
2. Promotion sweep (§5) — mechanical, zero visual change, mapping still
   pixel-identical.
3. `source-chooser.js` (drawer content: connection, tree, relink, switch,
   commit) — replaces `source-browse-modal.js`.
4. Ingest source section rewrite: add menu / tile render / commit chores;
   delete the path row and "Pull from".
5. Deletions + strings + dead CSS.
6. Full suite + the §10 manual pass.

## Appendix A — slice 1 in detail: the drawer extensions

Two additions to `createDrawer` (modal.js), both documented in its header
contract; nothing else in the component moves. Mapping's drawers are
untouched by construction — they pass neither new option, and both default
to today's behavior.

### A1. `tall` — a size axis for the sheet

`open({ …, tall: true })`. Today the sheet hugs its content under
`max-height: 88%`; a tree re-renders per level, so a content-hugging sheet
would change height on every click. `tall` pins it to a fixed fraction of
the host dialog — a stable viewport, not a bigger form.

- **Toggled per open** — `sheet.classList.toggle("tall", !!tall)` — because
  the sheet is one reused element per modal: a default task opened after a
  tall one must hug again. `close()` deliberately leaves the class (the
  closed sheet is invisible; the next `open()` sets it right), and
  `refresh()` rebuilds only the body, class untouched.
- **Ordering**: the toggle happens at the top of `open()`, before the
  `void sheet.offsetHeight` reflow read, so the first open resolves its
  closed state at the right geometry before animating. Height itself is
  not in the transition list (opacity/transform/visibility), so no
  animation interaction and no reduced-motion changes.
- **CSS** (three lines, inside the existing Bottom-drawer block):

  ```css
  .drawer.tall { height: 80%; }
  .drawer.tall .drawer-body { overflow: hidden; }
  .drawer-body .cb-scroll { min-height: 0; }
  ```

  Line 1: the percentage resolves against the host `.modal-dialog`
  (createDrawer already forces `position: relative` on it) — the dialog is
  content-sized under its viewport clamp, so the drawer breathes with it;
  62% is the eyeball starting point. Line 2: the body stops scrolling so
  its one scroll region owns that job — otherwise the location line and
  the subfolders switch scroll away and you get nested scrollbars. Line 3:
  `.cb-scroll`'s global 200px floor would overflow a short drawer; the
  floor drops **only inside drawer bodies** (two-class specificity beats
  the global rule; connector-browse and the results view keep their
  floor).
- **Accepted edges**: on a very short viewport the fixed rows could crowd
  the tree down to a few visible entries — same order of cramped as the
  88% default would be. If review-by-eye dislikes it, the fallback is
  `height: clamp(220px, 62%, 88%)` (noting clamp's min-wins-over-max
  behavior on absurdly small hosts). The dialog growing with settings
  content (long filter list → taller drawer) is harmless wobble.

### A2. A gated primary

`primary: { label, onClick, disabled? }` honored at open, plus a
`setPrimaryDisabled(on)` method on the instance. The chooser's "Use this
folder" is only a valid commit once a browse level has actually rendered —
today's browse modal gates exactly this way (`useBtn.disabled` until
`load()` succeeds).

- **Mechanics**: the foot is rebuilt every `open()`, so the instance keeps
  a module-scoped `okBtn` ref reassigned per open; the method guards on
  `current && okBtn`, so a stale async callback landing after a dismissal
  is a no-op.
- **Only the primary is gatable.** Cancel, scrim and Esc never disable —
  the existing dismissal contract (you can always leave without applying)
  extended to its natural corollary.
- **Deliberately not** exposing the button element: the narrow method is
  the entire permission — callers can't relabel or restyle the commit.
- **Focus edge, noted not fixed**: `open()` falls back to focusing the
  primary when the body has no focusables; a disabled primary refuses
  focus, leaving it on the opener until the trap's first Tab pulls it in.
  The chooser always has focusables (connection select / ↑ Up / the
  switch), so the edge stays theoretical.

### A3. Contract + verification

The header comment's usage sketch gains both options:

```js
//   drawer.open({ head, build, primary: { label, onClick, disabled? },
//                 onDismiss, tall });
//   drawer.setPrimaryDisabled(on);   // gate the commit while open
```

Slice 1 is inert until slices 3–4 consume it; its verification is "the
mapping tab's three drawers behave pixel-identically" (no `tall` passed →
`toggle(false)`; `disabled` undefined → `false`). The chooser's tighter
row spacing, if wanted, is chooser-side styling in slice 3 — not another
drawer variant.

## Appendix B — slice 2 in detail: the promotion sweep

Ground rule (recorded as standing feedback): **no new CSS unless necessary;
a style adopted outside its component gets generalized, not borrowed.**
Slice 2 creates zero new styles — it renames and relocates what slice 3–4
adopt, and slices 3–4 then target zero new classes themselves (transient
layout uses the same inline-style idiom the browse modal already uses).

### B1. What gets promoted

| Today | Becomes | Consumers touched |
|---|---|---|
| `.mm-tiles` | `.tiles` | mapping-modal.js:445 |
| `.mm-tile` (+`.ai`) | `.tile` (+`.ai`) | fieldTile (collapses onto `tileRow`) |
| `.mm-tile-main/-body/-name/-sum/-rm` | `.tile-main/-body/-name/-sum/-rm` | fieldTile; `.drawer-title`/`.drawer-src` co-declarations intact |
| `.mm-glyph` (+`.ai`) | `.glyph` (+`.ai`) | `glyphEl`, the raw `className` write at mapping-modal.js:881, contextual rules (`.mm-def-row .glyph`, `.mm-srcopt .glyph svg`, `.tile-main .glyph svg`), doc comment :51 |
| `.mm-face-hint` | `.warn-box` | mapping-modal.js:407, ingest-modal.js:247 |
| `.mm-unavail` | `.warn-box.flush` | mapping-modal.js:407 (rule deleted, absorbed by `flush`) |

Collision-checked: `.tile`, `.tiles`, `.glyph`, `.warn-box` appear nowhere
in css/js/html today.

### B2. Builders

- **`glyphEl` → utils.js** beside `ICONS` (which it reads); emits class
  `glyph`. mapping's local copy (line 230) dies.
- **`drawerHeadParts` → modal.js** (it builds `.drawer-title`/`.drawer-src`,
  the drawer's own head vocabulary); imports `glyphEl`. mapping's local
  (line 280) dies.
- **`tileRow(…)` → modal.js**, the one new builder:
  `{ glyph, ai, name, sum, title, place, onOpen, onRemove, removeLabel,
  removeTitle }`. `onOpen` absent = locked tile (a div, cursor default, no
  tab stop — fieldTile's unknown-source case); `onRemove` absent = no ×;
  `place` rides on the main button for keepPlace. Mapping's `fieldTile`
  becomes a ~15-line call that keeps only its own logic (SOURCES lookup,
  editable gating, splice/markDirty/render); the ingest tile (slice 4) is
  a second call.
- Import graph stays acyclic: modal.js → utils.js → state.js → nothing.
  (modal.js gains its first import.)

### B3. Relocation and ordering safety

The tile family, the glyph atom and the warn box move out of the "entity
mapping modal" section into the shared tail of modal.css (with the drawer /
`dw-*` vocabulary). All three are self-contained families — no
equal-specificity pair exists across blocks (the contextual glyph rules are
two-class selectors on disjoint containers), so document-order moves can't
flip any outcome. Comments that name the old classes update in place
(modal.css:420, :905; mapping-modal.js:51).

### B4. The fence — what keeps its prefix, and why

- `.mm-def-*`, `.mm-chips`, `.mm-srcrow`/`.mm-srcopt`, `.mm-empty`,
  `.mm-template-*`: single-consumer, genuinely mapping's. Nothing adopts
  them (the read-only "No source configured." note uses ingest's own
  `.im-hint`, not `.mm-empty`).
- `.fe-*` (add/remove vocabulary): already shared by three features
  (board/facet editor, ingest filters, mapping's add button) — "+ Add
  source" joins an already-shared family, not a first borrow. Renaming a
  legacy prefix on an established shared family is cosmetics, not this
  initiative.
- `.cb-*`: owned by `pagedTableScaffold`, which *is* the shared component —
  its classes are its API.
- `.im-*`: ingest-feature-internal; the chooser is the same feature.

### B5. The one non-mechanical edit + verification

Everything above is a rename except mapping-modal.js:881 — the identity
drawer's live head recolor writes `className = "mm-glyph" + …` raw; missed,
the head glyph silently stops flipping violet on the AI pick. It's on the
checklist by name.

Verify: `node --check` on utils/modal/mapping-modal; grep for
`mm-tile|mm-glyph|mm-face-hint|mm-unavail` returns zero; the mapping tab
(tiles, all three drawers, the unavailable-domain banner) and the ingest
modal's INGEST_ROOT warning render pixel-identically. Suite untouched
(client-only).

## Appendix C — slice 3 in detail: the chooser module

### C0. Sequencing — purely additive

Slice 3 lands `public/source-chooser.js` and two ICONS entries; **nothing
imports it yet**. `source-browse-modal.js` keeps working untouched (it dies
in slice 5, after slice 4 has rewired the ingest modal), so every
intermediate state ships.

### C1. API

```js
openSourceChooser({ drawer, boardId, source, rootPath = "", draft = {}, onCommit })
```

- `drawer` — the ingest modal's `createDrawer` instance (lazy, the mapping
  pattern). The chooser opens a task into it; it never creates one.
- `source` — the manifest entry verbatim (`type`, `label`, `browsable`,
  `needsConnection`, `connections`, `sourceSchema`). Everything
  presentational derives from it, which makes the chooser MORE
  schema-faithful than today's path row:
  - the path field (found via `pathKeyFor`) names the primary — `Use this
    folder` / `Use this prefix` (schema label, lowercased) — and labels the
    non-browsable fallback input (+ its `help` as the hint);
  - the recursive field names the switch — S3 gets its schema's **"Include
    sub-prefixes"** where today's row hardcodes "Include subfolders" (a
    deliberate label-only delta) — and supplies the seed default; a future
    kind whose schema has no recursive field gets no switch.
- `rootPath` — the resolved INGEST_ROOT label; read only when
  `!needsConnection`.
- `draft` — `{ connectionId?, path?, recursive? }`; absent keys = fresh
  add. The edit flow passes the saved values and the tree opens at
  `draft.path`, entering the relink flow if it 404s.
- `onCommit({ connectionId?, path, recursive })` — the ONE exit that
  writes, fired only by the primary (then `drawer.close()`). Cancel, scrim
  and Esc leave everything untouched.

Two named exports besides the opener:

- **`pathKeyFor(type)`** — the one spelling of "folder keeps `folder`,
  remotes use `path`" MOVES HERE from ingest-modal's local `keyFor`
  (source vocabulary belongs to the source module); slice 4 switches
  ingest-modal to this import.
- **`sourceGlyph(type)`** — folder→`srcFolder`, s3→`srcCloud`, else
  `srcGlobe` (an installed plugin source lands on the globe; if one ever
  wants its own mark, a manifest `glyph` key is the extension). The tile
  and the add menu (slice 4) import it too.

### C2. Icons

`srcFolder` + `srcCloud` join ICONS in the src* cluster (folder / cloud
outlines on the set's stroke-2, 24-box grammar); the cluster comment widens
from "mapping pane" to include ingestion source kinds.

### C3. Ports and deltas from source-browse-modal.js

Verbatim ports: `load()` (seq guard, 404-ascend, `parentOf`, root floor,
Use-gating, `missing` carrying the ORIGINAL path); `renderPath` (mono
location + ↑ Up); `fmtLoc` plus the empty-base guard; the goneNote
(`im-status error flush` — `.im-*` is feature-internal per the B4 fence);
the connection row (change → hide goneNote + `load("")`; the old
display-fallback-to-first died in live review — see the §4 revision);
dir/file rows + `fmtBytes` (stays module-private; the old copy dies with
its file); "Empty {folder|prefix}." (the schema's noun) with the
empty-level-is-pickable rule.

Three deltas:

1. `useBtn.disabled` → `primary: { disabled: true }` at open,
   `drawer.setPrimaryDisabled(…)` around `load()`.
2. The truncation note drops "— narrow by typing a path" (there is no path
   typing anymore; §8's S3 >1000 edge stands accepted).
3. Commit shape: trailing-slash-normalized `path`, explicit `recursive`,
   `connectionId` only for connection-backed kinds.
4. (Live review, 2026-08-24) **The primary also disables while the tree
   stands exactly where the board already points** — same path, same
   server, same subfolders — a commit that changes nothing shouldn't offer
   itself. Any delta re-arms it, so flipping the subfolders switch at the
   saved folder stays committable. Edit flow only (`savedAt` baseline from
   the draft; the add flow has none).

### C4. The one new hazard — cross-task leak

The drawer's primary is REUSED across tasks, unlike the old modal's
per-instance Use button. A slow browse response from a dismissed chooser
would otherwise land `setPrimaryDisabled(false)` into the NEXT task (close
mid-load, reopen, the stale success enables the new task's still-loading
Use). The component's own guard only covers the drawer-closed case, not
the reopened one. Fix: a `dead` flag flipped by `onDismiss` AND by commit;
every async continuation bails on it. (`onDismiss` gains its first real
job.)

### C5. Layout — zero new CSS

The body gets ONE wrapper div (inline
`display:flex;flex-direction:column;gap:10px;min-height:0;flex:1`) so the
drawer-body's 15px group gap is irrelevant and the old modal body's 10px
rhythm carries over. Regions top→bottom: connection row (remote only),
location line, goneNote, the cb table scaffold (`flex:1`; moreBtn hidden),
the `switchRow`. Inline styles are the old modal's own idiom — no new
classes.

### C6. Non-browsable arm (insurance — no installed kind hits it)

Body = one `dw-group` (label/help from the path schema field) with a text
input bound to the draft path; no tree, primary enabled immediately; the
"blank = the whole source" placeholder carries over — the Use click is the
explicit act. Today's fallback bypassed the chooser entirely; now it lives
inside it.

### C7. Head, focus, a11y

Head: `sourceGlyph` + `source` (mono title) + `s.label` as a static kicker
— the kind never changes inside the drawer. Focus: `open()` lands on the
first focusable (the connection select or the switch; tree `<a>`s aren't in
the focus query) and the slice-1 trap + capture-Esc handle the rest.

### C8. Verification

Additive slice: `node --check`, an import-graph eyeball (source-chooser →
modal/paged-table/board-modal; no back-edges — board-modal never imports
it), and grep-zero for accidental new classes. The module is exercised
end-to-end when slice 4 wires it; the suite is untouched.

## Appendix D — slice 4 in detail: the source section rewrite

### D0. Scope and sequencing

Slice 4 rewires ingest-modal.js onto the slice-3 module — the add menu,
the tile, the commit chores — and deletes the "Pull from" row and the
whole path-row block. The two "Add a folder first" refusal toasts fold in
here (they're the section's voice); slice 5 shrinks to pure deletions
(source-browse-modal.js, its import leftovers, `.im-source-path` /
`.im-affix` CSS).

One small amendment to the slice-3 module first: extract the location
spelling as a pure export — `fmtLocation(base, rel)` — with the chooser's
`fmtLoc` becoming a closure over it. The tile's name and the chooser's
location line must stay ONE spelling; the mixed-separator edge on a
Windows INGEST_ROOT ("D:\\ingest/wardrobe") is accepted — the browse modal
has rendered it that way all along.

### D1. The rewritten block

`buildFileSource` keeps its name and becomes: `usableKind`, `renderSource`,
`openAddMenu`, `renderTile` (+ its probe), `openChooser`. Type is never
forced — normalization stamps `type ||= "folder"` only on a SAVED source;
an unconfigured board's `cfg.source` stays `{}`. The modal owns one lazy
drawer (`drawerInst ??= createDrawer(dialog)`, the mapping pattern).

- `usableKind(sk)`: folder → `info.rootPath && sk.ready`; connection-backed
  → has connections; other connectionless kinds → usable.
- `renderSource()` un-added: every kind unusable → today's reason notes
  verbatim (the `warn-box` INGEST_ROOT sentence, the `im-hint` connections
  sentence), no button; read-only → `im-hint` "No source configured.";
  otherwise the `fe-add-facet` "+ Add source" — which opens the menu, or
  the chooser directly when exactly one kind is installed.
- Added → `renderTile()`.

### D2. The add menu

`openDropdown(add, { align: "start", width: "anchor" })`; one `ddRow` per
installed kind: leading `glyphEl(sourceGlyph(type))`, the kind's label, a
trailing dim note. Usable → note is the kind blurb (folder "on the
server's ingest root", ftp "a folder on a server you connect to", s3 "a
bucket prefix", unknown kinds none) and `onClick` closes + opens the
chooser. Unusable → NO onClick (ddRow's own static form — no hover, no
arrow-key stop), the note is the short reason ("needs INGEST_ROOT on the
server" / "no connections yet — Plugins page"), the full sentence rides
the row's `title`.

The trailing-note builder is mapping's `menuNoteEl` pattern gaining its
second consumer → it promotes into dropdown.js as **`ddNote(text)`**
(reuse > generalize); mapping's local helper dies and its one call site
imports.

### D3. The tile

- glyph `sourceGlyph(type)`; name `fmtLocation(base, rel)` (mono,
  truncates, full string in `title`) where base = the connection's label
  (dangling → "" → bare path) or `info.rootPath`.
- sum: `{kind label} · includes subfolders|this folder only` — the generic
  app-voice pair; the schema-faithful per-kind wording ("Include
  sub-prefixes") lives on the chooser's switch, deliberately not re-derived
  here.
- **Uninstalled saved kind** (plugin removed): sum `{type} (not
  installed)`, tile LOCKED but removable — the mapping unknown-source-tile
  precedent, replacing today's line-181 silent re-aim at `sources[0]`,
  which was itself an implied choice.
- × sets `cfg.source = {}` (true nothing-added), invalidates preview,
  re-renders; `removeTitle` keeps the save-afterwards warning, reworded to
  "source".
- Below the tile: the silent health line (`im-status tight`).

### D4. Commit chores, in order

`onCommit(picked)` → rebuild `cfg.source` fresh (`{ type, connectionId?,
[pathKeyFor(type)]: path, recursive? }`) → `seedSourceDefaults(sk)` (future
schema fields; path/recursive are already explicit) → the remote
continuous→interval nudge (moves from the dead typeSel handler) →
`renderTriggerModes()` → `invalidatePreview()` → `renderSource()` (+ eager
probe) → focus the new `.tile-main`. The chooser's `drawer.close()` runs
after onCommit and its opener-restore targets a now-detached node — a
no-op — so the explicit focus survives.

### D5. The probe, simplified

`check()` + `probe()` collapse into one function: the Test button dies
(§9 decision 1 executed), so the probe is the sole consumer — limit-1
browse of the committed source, renders ONLY a server-verdict error,
transport blips and health stay silent. No debounce, no `isConnected`
timer guard (there are no keystrokes anymore); it runs on tile render and
after commit, eager (connectionless) kinds only; per-render closure seq.

### D6. Deletions and imports

Gone from ingest-modal.js: local `keyFor` (→ `pathKeyFor` import), the
"Pull from" row + typeSel handler, `renderDetail` (absorbed into
renderSource), `renderFolderBlock` wholesale (sublabel, per-fieldLabel add
button, `rootLabelNow`, affix, path input + debounced probe, Browse…,
Test + its toasts, ×, switch-row placement, mount probe), the
`openSourceBrowse` import. New imports: `openSourceChooser` / `pathKeyFor`
/ `sourceGlyph` / `fmtLocation` (source-chooser), `createDrawer` /
`tileRow` (modal.js), `glyphEl` (utils), `openDropdown` / `ddRow` /
`ddNote` (dropdown). `switchRow` stays (the trigger pause row).

### D7. Edges

- `info.sources = []`: today crashes at `sources[0].type`; the new branch
  renders an empty-safe section.
- Legacy bare `{type}` config → tile `ingest-root/` (the invisible root
  watch made explicit).
- Dangling connection → bare-path tile, chooser is the repair (its own
  display-fallback + Use commit).
- Trigger section with nothing added keeps reading `type || "folder"` for
  its mode list (unchanged, per §7).

### D8. Verification

`node --check`; grep `openSourceBrowse` → only the old file itself
remains (deleted in slice 5); the suite is untouched by construction.
This is the slice where the §10 manual checklist becomes fully
exercisable — the add menu, both chooser flows, the relink path, and the
mapping tab's untouched drawers all want the eyeball pass.

## Appendix E — simplification pass (2026-08-24, post-ship)

Four-angle review (Reuse/Efficiency agents; Simplification/Altitude run
inline after the agents hit a session limit). Applied:

- **`fillSelect`** (select.js) replaces the chooser's hand-rolled option
  loop — the codebase's one filler, already used by every sibling picker.
- **`dwGroup` promoted to modal.js** — mapping's local `group()` builder
  (dw-group/label/hint) gained a second consumer in the chooser's
  non-browsable arm, so it moved to the drawer vocabulary; mapping imports
  it aliased.
- **`sourceRootLabel` exported from source-chooser.js** — the
  which-root-does-this-resolve-against rule had quietly split into two
  spellings (the chooser's `curRootLabel`, the tile's inline ternary);
  now one export beside `fmtLocation`, both consumers call it.
- **Ghost-drawer guard in `createDrawer.onKey`** — the drawer scrim covers
  the dialog, not the overlay ring, so click-out could tear the modal down
  around an open sheet: `close()` never ran, the capture-phase keydown
  listener survived, retained the detached tree, and swallowed Tab
  page-wide. `onKey` now detaches itself on the first keypress after the
  sheet leaves the document. (Pre-existing hole — the mapping drawer had
  it too — but this initiative made it routine.)
- **`stripSlashes`** — five spellings of the trailing-slash strip inside
  source-chooser.js folded into one module-local helper.

Skipped, with reasons: the commit-time probe re-fetches the path the
chooser just verified (one limit-1 request on a user-paced action —
threading a skip flag costs more than the fetch); a shared fetch helper
for probe()/load() (the two requests need different error semantics — a
wrapper would erase distinctions both rely on).
