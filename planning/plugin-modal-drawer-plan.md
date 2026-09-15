# Plan: plugin-modal defaults go explicit — status rows + drawer

## Goal

The AI plugin modal's capability sections ("Tagging", "Field extraction", …)
are global-default election booths dressed as provider config. Nothing in the
titles says "this sets the APP default"; the staged key/model selects look
like saved state while being drafts for a button below them; and the key
select appears/disappears by a rule nobody can see (the one-key-hidden `ask`
rule). Fix: the modal body shows **facts only** — one "App defaults" section,
one status row per capability — and every choice moves behind an explicit
act: click "Make default… / Change…", pick key + model in the bottom drawer
(modal.js `createDrawer`), commit with its one primary. Same rails the
mapping pane already rides: *nothing on a tile is editable; opening it IS the
edit.* This also makes the modal enforce the no-implied-choices rule instead
of fighting it with placeholder copy.

## Deep dive — what exists today

### The confusing surface (plugin-modal.js)

| Piece | Where | What it does today |
|---|---|---|
| capability section stack | render() ~L160, `capabilitySection` L550 | one `section(cap.label, cap.blurb)` per global capability — title describes the *capability*, not the act |
| key select | L565 | shown only when `plan.ask` (rows>1 \|\| !holder) — the vanishing-picker confusion |
| model select | L573 | always staged; placeholder `Default (m)` via `pickModel` L76 — honest label for a draft that still *looks* saved |
| `slotButton` | L49 | "Make default {agent}" ghost; arming dance: disabled while any select `isUnset`, or holder-with-no-change |
| Test / Turn off / Use built-in | L616–635 | live one-click acts, holder-gated by the planner |
| `Current default: …` span | L636 | muted footnote, non-holders only — the one place the global fact shows |
| progress line | L651 | backfill story under the section |
| keys add/edit form | `keysSection` L366, `beginEdit` L495 | always-visible name+`sk-…` inputs; edit hijacks the add form |

### The planner (capability-present.js `planSection` L449)

Pure, node-tested (capability-present.test.js, planSection block from L144).
Returns: `guard, rows, preselect, ask (L471), model{catalog|note}, holder,
savedModel, buttons[] (apply/probe/off/revert with exact bind payloads),
confirm, currentDefault, progressLine`. The payload closures are pinned by
tests and must not change — `POST /api/admin/capabilities/:id/bind`
(server.js L2828) is untouched by this whole arc.

### The components already built for this shape

- `createDrawer` (modal.js L369): one editing task, ONE primary, dismissal
  never half-applies, focus trap, Esc-capture that doesn't close the host
  modal. `setPrimaryDisabled` = the arming mechanism `slotButton` hand-rolls.
- `dwGroup` L523 (label/control/hint), `drawerHeadParts` L546 (glyph + title
  + right-aligned source).
- `tileRow` L562: glyph | name over quiet sum | optional × — "opening it is
  the edit". CSS shared vocabulary: `.tile-name`/`.drawer-title`,
  `.tile-sum`/`.drawer-src` are declared once (modal.css ~L1060).
- Lazy host precedent: mapping-modal.js L265 hangs the drawer off
  `container.closest(".modal-dialog")` — **the dialog, not the body** — so
  body rebuilds (our `reload()`) can't orphan the sheet.
- Every capability declares an `icon` (server/capabilities.js registry;
  shipped by capability-status.js L184) — the row glyph comes free,
  `glyphEl` falls back to `srcDot` for anything odd.

## Design

### 1. The modal body: one "App defaults" section, facts only

Replaces the per-capability section stack (order stays: keys → defaults →
rate limit):

```
App defaults
One default per job, app-wide. Boards use it unless they pin their own.

[◇] Tagging                                    [Test] [Change…]
    App default — "OpenAI" key · gpt-5.4-mini

[◇] Field extraction                                 [Make default…]
    Follows each board's tagger

[◇] Semantic search                                  [Make default…]
    App default: Local Embedder (Xenova) · bge-small — built-in
```

Rows are `tileRow` (glyph: `cap.icon`, name: `cap.label`, sum: status line,
`title`: `cap.blurb` so the description survives as hover + drawer hint) plus
a small extension: an optional `actions: [node]` slot rendered after
`tile-main` (reuse > generalize > create — the × slot already sits there;
same insertion point). Progress line, when present, renders as a muted line
under the row.

Tiles are LOCKED (no `onOpen`): the labeled action button is the only
trigger. The named verb ("Make default… / Change…") is the affordance this
redesign exists to add, and a second whole-tile trigger for the same act
would duplicate the tab stop without adding information — mapping's
whole-tile-click stays its own idiom (its tiles carry no labeled verb).
`tileRow` already renders the locked shape (div, default cursor).

Adoption needs one CSS modifier, promoted in modal.css beside the tile
block (never forked): `.tile-sum` is `white-space: nowrap` + ellipsis, and
the status line is the row's CONTENT — the degraded line would clip
silently. The modifier lets the sum wrap (and un-monos `.tile-name` for
prose labels if the type reads wrong there).

### 2. Status line wording lives in the presenter

All new strings come out of `planSection` (house rule: wording is
capability-present's job). The row's `status` is a one-line compression of
`presentLines`' precedence, same rule: while healthy the running line IS the
configured line; degraded/off is where they part and both get said. It
branches on `cap.state` — a field planSection has never read (the test
fixtures don't even carry it — they gain it in stage 1) — plus `bound`,
`running`, `env`, `floor`, `delegatesTo(+Agent)`, `supportedBy` (labels +
onDevice), and the `keys` param for key names. Existing spellings are reused
("built-in", the env-key clause, "each board's {agent}"), never re-minted:

| state × this card | sum line |
|---|---|
| active, default-here, keyed | `App default — "{key name}" key · {model}` |
| active, default-here, env rung | `App default — {ENV_VAR} env var · {model}` |
| active, default-here, on-device (incl. floor-by-design) | `App default — built-in` (+ `· {model}` when it had a choice) |
| active, elsewhere | `App default: {label} · {model}` (+ `— built-in` / `— env` qualifier) |
| active, delegate unbound (extract) | `Follows each board's {delegatesToAgent}` |
| degraded, bound-here | `App default — "{key name}" key · {model} — failing; {running label} serving` |
| degraded, serving-here (whatever picked the work up) | `Serving as the fallback{ — built-in \| — env} ({bound label} is the app default)` — the qualifier is derived from what SERVES (stored → env → floor is the resolution order, so the rung is not always the engine) |
| degraded, elsewhere | `App default: {bound label} · {model} — degraded` |
| any line whose provider can't be named (a restored backup keeps the pointer, loses the row) | the clause drops; degraded-elsewhere falls all the way back to `The app default is failing` |
| off, bound-here (embed) | `Off — binding kept ("{key name}" key · {model})` |
| off, elsewhere | `Off — {noun} disabled` |
| blocked / unavailable | `No app default yet` |
| guard (no keys) | planSection's existing guard text, verbatim; no action button |

("key" follows `connWord` — a keyless provider's rows read `connection`.
A bound keyId missing from the `keys` param degrades to the model clause
alone — never "undefined". The `; {running label} serving` clause renders
only when something actually serves: tag's floor is `blocked`, so its
degraded line ends at `— failing`.)

### 3. The explicit act: row action → drawer (or direct)

First, a predicate split. Today's `holder` conflates two questions that only
agree while healthy, and the degraded card shows it: a failing default's card
says "Make default …" over blank pickers, as if it weren't the default.
- `isDefaultHere` — the stored/resolving default points at this provider:
  active → running-here (the env rung resolves without a bound row);
  degraded/off → **stored**-here. Drives the status spelling, the open label,
  `preselect` and `savedModel`. Named in capability-present.js, beside
  `holder` — the isDelegating lesson: two-clause predicates get names, not
  copies. "Stored" is itself a named predicate (`storedHere`) and is NOT
  `bound.provider === name`: `capabilityBinding` floor-fills the provider, so
  a capability with nothing bound reads back as its own floor's engine (the
  server guards the same trap with `storedNonFloor`, which never reaches the
  wire). Unguarded, a fresh instance's disabled embedder claimed the Local
  Embedder card — "binding kept" over a binding nobody made, `open: null`, and
  no way left to turn embeddings back on.
- `holder` (serving-here) keeps gating what it truly gates: probe, Turn off,
  revert — acts on what runs.

`open`, planned per row. Whether a drawer exists is STRUCTURAL — offered iff
a group would render: `(rows && rows.length > 1) || !!model.catalog`:
- not default-here, choices → `{ label: "Make default…", drawer: true }`
- default-here, choices → `{ label: "Change…", drawer: true }` — including
  degraded (repair = repoint) and off (the drawer's primary re-binds and
  re-enables in one body, exactly today's apply)
- choiceless, not default-here → `{ label: "Make default {agent}", drawer:
  false }`: a direct one-click promote, today's behavior (on-device single
  baked model; a keyed one-key no-catalog provider falls out of the same
  rule instead of needing its own case)
- choiceless, default-here → `null` — the status line already says it; the
  permanently-disabled "Make default {agent}" ghost that sat as a status
  marker dies here rather than migrating
- guard → `open: null`.

`buttons[]` splits: the `apply` entry becomes `primary` (drawer commit /
direct promote); the rest (`probe`/`off`/`revert`) become `rowActions` —
one-click acts on live state, and the drawer contract is one-primary-only,
so they stay on the row: Test (ghost), Turn off (danger, embed holder), "Use
the built-in … instead" (danger, holder + floorPromises). Payload closures
byte-identical.

### 4. The drawer task

```
◇ Default tagger                                        OpenAI
────────────────────────────────────────────────────────────────
Key        [ OpenAI ▾ ]        ← dwGroup; only when >1 row
Model      [ gpt-5.4-mini ▾ ]    (syncModelPicker, unchanged mechanics)
           Replacing: Gemini · gemini-2.5-flash
           [warn-box, embed only, live: "Changing the model re-embeds …"]

                                  [ Cancel ]  [ Make default tagger ]
```

- Head: `drawerHeadParts(cap.icon, false, "Default {agent}", p.label)` — the
  task is named after the ROLE, the source names the provider.
- First body line: `cap.blurb` as a `dw-hint` — the description moves here
  from the old section subtitle.
- Key group only when `rows.length > 1`; a single row (one key, or the env
  rung alone) renders as a quiet fact line ("Key: ANTHROPIC_API_KEY env
  var") — the one-key-hidden rule becomes uniform and visible instead of a
  vanishing select. The explicit act is the primary click itself.
  MECHANICS, because the old shell hides a trap here: today `keySel` is
  ALWAYS created and merely not appended when `ask` is false, and
  `selVals()` reads the hidden select. Ported naively, the fact-line case
  either leaves `sel.key` unanswerable or leaves a hidden unset select
  gating the primary forever (single-key not-default-here has no
  preselect). So: one row → NO select is built, the row auto-answers, and
  arming ranges over rendered selects only. The commit reads
  `sel = { key: keySel?.value ?? plan.rows?.[0]?.value ?? null,
  model: modelSel?.value || plan.model.catalog?.defaultModel || null }` —
  selVals' placeholder→default model rule, kept verbatim. The direct
  promote (no drawer) composes the same `sel` with `model: null`.
- Model: same `syncModelPicker` call, same `pickModel` placeholder, same
  key-change refill listener order.
- `Replacing: …` = `currentDefault`, inside the task where the decision is.
  Stage 2 reshapes it: a presenter-worded STRING via `named()` (the shell
  was concatenating label+model itself — the spelling `named()` exists to
  own), gated on `isDefaultHere` rather than `holder` (a degraded
  default-here drawer is repairing, not replacing — the old gate would have
  shown "Replacing: {the floor}"), and `null` when nothing runs (no
  "Replacing: none"; the row already says "No app default yet").
- **Rebind warn goes inline**: the embed `confirm()` popup is replaced by a
  `.warn-box` under the model group, shown live whenever the picked model ≠
  `confirm.priorModel`. The primary is already an explicit, gated act; a
  second popup on top of it is ceremony. (Deliberate behavior change.)
- Preselect and `savedModel` follow `isDefaultHere` (bound row, else the env
  rung) — which now also prefills the degraded and off drawers; today only
  the healthy holder prefilled, and repairing a failing default meant
  re-picking from blank (see risks).
- Primary label: "Save changes" only when active + default-here; the
  verbatim `Make default {agent}` everywhere else — including the off
  drawer, whose primary genuinely re-elects (binds + enables).
- Arming: `setPrimaryDisabled` — any `isUnset` RENDERED picker disables,
  plus `open.requiresChange` (a new stage-2 presenter field, pinned):
  `isDefaultHere && state !== "off"` demands a change from the open-time
  snapshot, because re-posting an active or degraded binding is a no-op —
  but the OFF drawer's re-post IS the act (`enabled: true` rides it), so it
  must open ARMED. slotButton's blanket "holder needs a change" rule would
  have deadlocked it prefilled-and-disabled; today's shell arms the off
  card immediately (`holder` is false when off), and that behavior keeps.
  `slotButton` (L49) is then deleted.
- Commit: `setPrimaryDisabled(true)` for the duration (the primary's busy
  state — createDrawer has none of its own) → `POST bind` → toast (verbatim
  "Default {agent} saved") → `drawer.close()` → `reload()`. On error:
  `toast.error`, re-run the arming sync, drawer STAYS OPEN with the draft.
  Dismissal paths never post — the contract.
- Instantiation: lazy, hung off `body.closest(".modal-dialog")` (mapping's
  pattern), one instance per modal reused across reloads.

### 5. Keys/connections add + edit move to the drawer too

`keysSection` table becomes pure facts (name + role badges, server, hint) +
row actions (test / edit… / remove — the ellipsis on edit marks
opens-a-task, matching "Change…"). The always-visible form collapses to an
`[Add key…]` ghost button. One shared `keyDrawer(p, editing)` builder — edit
is add-prefilled, and the drawer being a fresh task per open is what deletes
the `beginEdit` form-hijack and its Cancel choreography.

- Head: glyph `key` (both nouns), title `New {noun}` / the row's name —
  live-retitling as the Name input types (drawerHeadParts returns the refs;
  the mapping field editor is the precedent) — src `p.label`.
- Add task: Name, server URL (needsBase), key/token — same inputs, same
  autocomplete (`new-password`) and placeholder rules, primary "Add {noun}".
  Keyless providers keep the connection noun + optional token.
- Edit task: prefilled; the secret shows "•••• stored — leave blank to keep"
  (or "token (optional)" when `k.hint === "no key"`); primary "Save changes".
- **The `<form>` dies, and its two jobs are re-homed deliberately.**
  Browser `required` validation → live primary gating (`input` →
  `setPrimaryDisabled`): add arms iff `name.trim() && (keyless ||
  key.trim())`, edit arms iff `name.trim()`. Enter-to-submit is NOT
  replaced — no drawer task in the app wires Enter, and the keys task
  follows the component's idiom rather than keeping a one-off.
- **Write bodies byte-for-byte from today** (the asymmetries are the
  contract): POST sends `key` always (may be `""` for keyless) and
  `base_url` only when non-blank; PATCH sends `key` only when typed (blank
  keeps the stored secret) and `base_url` ALWAYS when needsBase (blank =
  clear the override, back to the plugin default).
- Commit flow = the capability drawer's: `setPrimaryDisabled(true)` as busy
  → POST/PATCH → verbatim toast → `close()` → `reload()`; error keeps the
  drawer open with the draft.
- Remove stays a row action with its existing consequence-confirm
  (destructive ≠ drawer material); test stays a row action; the env-rung
  empty-state line stays in the section.
- Fix in passing: the name cell drops `innerHTML` interpolation
  (`${k.name}` is admin-authored but stored — textContent + appended badge
  spans).
- Section subtitle re-worded to point at the new section by name: "Named
  keys for this provider. Boards can pick any of them; one can back an app
  default below."
- OUT OF SCOPE, decided not forgotten: `sourceSection`'s inline add/edit
  form is the same pattern, but it is connectionSchema-driven with a
  draft-Test action inside the task, and carries none of the
  default-election confusion this arc fixes. A natural follow-up outside
  the arc if the idiom proves out. welcome.js's first-run key form posts
  the ai-keys route directly and is untouched.

### 6. Connector modal: same explicitness, no drawer

"Make default for {domain}" stays a plain button — no key/model axis, no
choices, so no drawer (the §3 choiceless rule, applied to domains). The
existing default predicate ALSO stays: domain entries carry no floor-fill
(`bound.provider` is the raw stored star — capability-status.js
domainEntry), so `(bound?.provider || running?.provider) === p.name` is
already the right stored-first question and needs no `storedHere` analog.

What changes is the WORDING, which today has two defects: the not-default
case names nobody (the subtitle just stops), and the subtitle string is
built twice in the shell — once in `section()`, once in the post-promote
in-place write — a live drift pair. Fix: `domainStatus(d, providerName,
fallbackLabel)` in capability-present.js, called at both sites:

- default-here (stored star, or unset-and-serving): `{label} data provider.
  Currently the default for new adds.` — today's sentence, verbatim.
- elsewhere, active: `{label} data provider. Default for new adds:
  {labelIn(d, bound || running)}.`
- degraded / blocked / unavailable: the entry's `reason` rides the base
  sentence — domainState already words these ("TMDB can't serve — OMDb took
  over", "X needs an API key"); the helper passes them through, NEVER
  re-mints (the no-fourth-spelling rule).
- `d` missing (stale feed): the base sentence alone, off `fallbackLabel`.

The promote handler doesn't refetch (deliberate — in-place flip keeps
unsaved field edits alive), so its call site hands the helper a PATCHED
entry: `domainStatus({ ...d, bound: { provider: p.name }, state: "active",
reason: null }, …)`. Pins in capability-present.test.js: all four wordings,
the reason passthrough, the fallback, and the patched-promote shape.

## Stages

**1. Presenter** — SHIPPED 2026-09-15 (suite 1545 green) — `planSection` v2
in capability-present.js, additive:
`status`, `open`, `primary`, `rowActions` land beside the existing fields
(`buttons`, `ask`, `currentDefault` untouched until stage 2), so the old
shell renders unchanged off the same commit. Verified safe: every planSection
pin is a targeted assert (`plan.rows`, `buttons[0].payload(...)`) — no
whole-return deepEqual to trip on new fields.
- New input read: `cap.state` — every §2 row branches on it; the fixtures
  (capability-present.test.js L148+) gain the field, incl. new degraded and
  off shapes.
- `isDefaultHere` lands as a named predicate beside `holder`;
  `preselect`/`savedModel` move onto it. The rebind confirm does NOT — it is
  deliberately card-agnostic (an OpenAI→Anthropic embed rebind warns too),
  so it keeps reading `bound` alone. Behavior identical for every active
  card; the degraded/off prefill is the one deliberate change (risks).
- `primary`/`rowActions` are built as the two things they are, and `buttons`
  (the old shell's shape) is assembled FROM them — one construction, so
  "identical payloads" is true by construction, and stage 2 deletes one line
  rather than unpicking a slice.
- Shared with the rest of the file rather than re-typed: `named(c, b)` (the
  "{label} · {model}" spelling, promoted out of presentLines' closure — four
  readers had a copy and only one had the null guard) and the derived
  built-in/env qualifier. The guard return answers the whole row contract
  (`status`/`open`/`primary`/`rowActions`), so the shell has no second shape
  to special-case.
- Pins: the §2 table row by row (incl. the key-name fallback and the
  keyless `connection` noun); the §3 open matrix (both choiceless corners,
  guard null, off/degraded labels); the payload asserts MOVE onto
  `primary`/`rowActions` now, plus one alias assert against `buttons` — so
  stage 2's test diff is deletions only. capability-present.test.js only.

**2. Shell flip** — SHIPPED 2026-09-15 (suite 1545 green; the shell half is
unproven until stage 4's manual matrix runs) — two halves, one commit:

*Presenter (the only automated surface — no DOM tests exist for the plugin
modal, so pins here are what stage 2 can prove):*
- `open.requiresChange` (§4 arming) — pinned: active default-here `true`,
  degraded default-here `true`, off default-here `false`, not-default-here
  `false`.
- `currentDefault` → presenter-worded string via `named()`, `isDefaultHere`-
  gated, `null` when nothing runs (§4 Replacing) — pin reshaped.
- Prune `ask`, `buttons`, and the alias pin. `pickKey`/`pickModel` SURVIVE
  (they are the drawer's placeholders), as do `muted()` and the `isUnset`
  import (arming).

*Shell (manual matrix is the gate, stage 4):*
- plugin-modal.js: `capabilitySection` stack → one "App defaults" section
  (§1): `.tiles` of locked tileRows + actions slot, progress line under the
  row, guard rows action-less.
- The drawer task (§4): lazy `createDrawer(body.closest(".modal-dialog"))`
  (mapping's pattern — the dialog hosts the sheet, so `reload()`'s body
  rebuild can't orphan it; one instance reused across reloads), dwGroup
  key/model, fact-line auto-answer, warn-box live rebind warning, snapshot
  arming, commit per §4.
- `tileRow` grows the `actions` slot + the wrap modifier (modal.js /
  modal.css, §1). Delete `slotButton`, the staged selects, the
  `Current default` span.
- Old-shell reads that must not survive: `plan.ask`, `plan.buttons`, the
  `plan.holder &&` gate on `syncModelPicker`'s `saved` (becomes
  `(!keySel || keySel.value === plan.preselect) ? plan.savedModel : null` —
  `savedModel` is already `isDefaultHere`-scoped).

**3. Keys via drawer** — SHIPPED 2026-09-15 (suite 1545 green; proof rides
stage 4's matrix) — §5. keysSection form → the shared `keyDrawer` task;
table to facts + actions (name cell de-innerHTML'd in passing); subtitle
rewording. No presenter change and no DOM tests exist, so this stage has
zero automated surface — stage 4's matrix rows (add / edit / remove via
drawer, error-keeps-draft, blank-secret-keeps-stored) are its proof.

**4. Connector parity + browser proof + sweep** — SHIPPED 2026-09-15 (node
suite 1556 green incl. the browser file, `test:browser` 26/26; the browser
run's first catch was real: four labeled acts crushed `.tile-main` to zero
width, fixed with the `.tiles.prose` wrap rules. The MANUAL half of the
gate below still wants a compose-stack pass before the arc commits) —
three parts, then the arc commits:

- §6 (`domainStatus` + pins — automated surface #1).
- **test/browser/plugin-modal.test.js** (automated surface #2): the browser
  harness is real infrastructure — Playwright against the real server with a
  throwaway Postgres per file, admin sign-in already solved by
  welcome.test.js, Chromium installed by CI — and this arc's remaining risk
  is exactly the "only real in a browser" kind its header reserves the slow
  tests for. Fake keys suffice: bindCapability validates against DECLARED
  catalogs, never the wire. The file absorbs the drivable matrix rows below.
- Comment sweep, two concrete spots: capability-present.js ~L499 still says
  "which buttons exist" (the field is gone — primary/rowActions vocabulary),
  plugin-modal.js ~L102 still says "a saved slot". The select.js /
  board-modal past-tense lesson narratives STAY — history is house style.

Suite + `npm run lint` + `npm run test:browser` green.

### The gate (stage 4)

**Browser-tested** (the new file): App defaults rows render with status
text · guard row (no keys — guard text, zero buttons) · Add key… drawer
gating (disabled until name + key; keyless needs no token) → add → row +
hint appear · single-key fact line + model-placeholder gating → Make
default tagger → row flips to `App default — "…" key · model` + "default
tagger" badge on the key row · reopen Change… → requiresChange (disabled
until an edit) · rebind warn live-sync (embed: differing model shows the
warn-box, prior model hides it) · Turn off → `Off — binding kept (…)` →
Change… opens ARMED → commit re-enables · direct promote (on-device
single-model — no drawer) · Esc/scrim mid-draft posts nothing · edit key
with blank secret keeps the stored one (hint cell unchanged) · remove key
consequence-confirm.

**Manual** (environment-dependent, on the compose stack): env rung
(ANTHROPIC_API_KEY in the server env) · whisper sidecar PRESENT (the test
env proves the absent side) · backfill progress line (real embed sweep) ·
degraded both-sides wording + prefilled repair drawer (uninstall a bound
provider) · extract delegate row ("Follows each board's tagger") · §6
connector wording incl. the takeover reason · needsBase flows via the
examples/plugins/ollama drop-in (server column, base_url clear-on-blank
edit, token-optional add) · other plugin kinds smoke (connector / source /
media modals unchanged) · Capabilities → Configure entry path · visual
pass (.tiles.prose wrap on the long degraded line, tile-actions alignment,
drawer over the plugin modal's height).

## Risks / notes

- **Bind bodies are the contract**: payload closures move between fields but
  never change shape — stage 1 pins them against today's. No server edits
  anywhere in the arc.
- **confirm() → inline warn-box** is a deliberate UX decision, not drift;
  noted in stage 2's commit.
- **`holder` splits into `isDefaultHere` + serving** — the one semantic
  refinement in the arc, and it lives entirely in stage 1: degraded/off
  cards now present as the default they are ("Change…", prefilled drawer)
  instead of as bystanders ("Make default…", blank pickers). Every
  active-state card behaves byte-identically; probe/Turn off/revert stay
  gated on serving, as today.
- **Verbatim labels survive**: "Make default {agent}" and its toasts keep
  their exact strings (capabilities-plan.md L1315 relies on this) — they just
  move onto the drawer primary / direct button.
- **Focus after commit**: drawer restores focus to its opener; the opener
  dies in `reload()`'s rebuild, so focus falls to the body — identical to
  today's post-promote behavior. `keepPlace` exists if this ever earns
  fixing; not built now.
- **Esc layering** already solved: createDrawer registers capture-phase and
  stops propagation, so a drawer Esc can't fall through to close the modal.
- Board modal, mapping/ingest drawers, admin-capabilities cards and their
  Configure deep-links (#capabilities/<id>): out of scope, unchanged.
- On-device providers keep no keysSection; their modal is just App defaults
  (+ nothing else), which the section subtitle still reads correctly for.
