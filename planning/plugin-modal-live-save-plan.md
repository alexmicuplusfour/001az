# Plan: live saves across the plugin modals (implemented)

## Goal

No Save buttons in the plugin modals — footer or inline. Every setting commits
the moment it changes, the way the slot "Make default …" buttons already
commit the moment they're clicked. The footer holds Close, everywhere, for
every plugin kind. Born from a field trap: the AI modal's footer "Save"
committed only the rate-limit section, then the reload discarded the model
choice staged in the tagger section above it.

## The full commit-surface inventory (deep dive)

| Section | Kind | Controls | Commits today |
|---|---|---|---|
| connectorSection | connector | secret/number/toggle/text fields | footer **Save** + footer Test |
| — star | connector | Make default for domain | live (in place, no reload) |
| keysSection | ai | add/edit key form; row test/edit/remove | form submit; row actions live |
| taggerSection | ai | connection + model selects | **Make default tagger** (slotButton) |
| embedSection | ai | connection + model selects | **Make default embedder** + Turn off |
| transcribeSection | ai | connection + model selects | **Make default transcriber** + Use Whisper |
| pacingSection | ai | rpm/burst numbers | footer **Save** |
| sourceSection | source | add/edit connection form; row actions | form submit; row actions live |
| mediaSection | media | max-upload-MB number | footer **Save** |

Enabling server fact: `PATCH /api/admin/plugins/:id` **merges** config per key
(`{...stored, ...patch}`, server.js ~L1707), so a field can autosave just
itself and never clobber siblings. `POST /api/admin/ai-config` is likewise a
partial-update endpoint. No server changes needed.

## Design

### 1. One tiny helper: `autosave(el, commit)`

On the control's `change` event (fires on blur for typed input, immediately
for selects/steppers/toggles): disable the control, run `commit()`, subtle
success toast, re-enable. On failure: `toast.error` + revert the control to
its last-saved value (snapshot kept by the helper). No debounce needed —
`change` already coalesces typing.

### 2. Scalar config fields → autosave per field

- **pacingSection** (rpm/burst) and **mediaSection** (max MB): each input
  autosaves `PATCH {config: {[key]: value}}`. Blank still means "clear the
  override, back to default" — it saves too. Save buttons deleted.
- **connectorSection** text/number/toggle fields: same. **Secret fields**:
  autosave on blur only when non-empty (a blur over an empty field must not
  clear a stored key); "remove stored key" stops staging and becomes an
  immediate confirm-then-clear. Chrome-autofill safety: `new-password` stays,
  and empty-value blurs never write.
- After a scalar autosave: **no modal rebuild** (update `p.state.config`
  locally + `ctx.refresh()` for the cards behind). Rebuild-on-save steals
  focus mid-form — hostile when saves fire per blur. Structural actions
  (promote, add/remove row, Turn off) keep the full `reload()`.

### 3. Slot sections: UNCHANGED (explicit by decision)

Slot changes must be explicit — auto-applying a tagger/embedder/transcriber
switch on dropdown change was proposed and **rejected**. The existing
behavior is already the right shape: "Make default …" promotes a
non-default provider; when the provider IS the default the button sits as a
ghost status marker and re-enables the moment the connection or model
changes — clicking it applies. The embedder's re-embed confirm stays on
that click. No code change here; the fix for the Ollama confusion is
removing the footer Save that sat beside these buttons pretending to be
the modal-wide commit.

### 4. Forms stay forms (the one deliberate exception)

Add/edit of **keys and source connections** keeps its explicit submit
("Add key", "Add connection", "Save changes"): creation has required fields
and an identity — half-typed rows can't autosave into existence. Row-level
test/edit/remove are already live. Everything that is a *setting* goes live;
things that *create or replace a record* keep their one submit button.

### 5. Test buttons move inline; the footer holds Close, period

connectorSection's footer Test moves into its section (the AI sections
already do it that way). With live saves, Test always tests stored state —
the old "tests the typed key without saving" subtlety disappears.

## Phases

1. `autosave` helper + pacingSection + mediaSection (the two pure-scalar
   sections — smallest surface, proves the pattern).
2. connectorSection: field autosave incl. the secret rules, Test moved
   inline, footer emptied.
3. Comment sweep (the "footer holds just Close" comment becomes true for all
   kinds) + checklist entry + manual pass over every plugin kind (connector,
   ai keyed/keyless/on-device, source, media).

## Risks / notes

- **Accidental embedder switch** — can't happen: slot applies stay behind
  their explicit button (and the re-embed confirm on it).
- **Secret autosave**: only non-empty blurs write; clearing is an explicit
  confirmed action. An accidental paste-then-blur does save — same blast
  radius as today's paste-then-Save, minus one click.
- **Toast noise**: one subtle toast per commit; selects/toggles are
  single-shot so this stays quiet in practice.
- **reload() focus theft** — avoided for scalar saves by design (see §2).
- Client-only change; no endpoint or schema edits. Board/mapping modals are
  out of scope ("for all plugins" = the plugin modals).
