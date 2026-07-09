# Slice 4 — Derived identity

✅ Shipped 2026-07-07. Parent design: `pipeline-boards-plan.md`.

## What shipped

Mapping can declare `identity: { from: "ai", hint: "..." }` so extraction produces the entity's semantic key instead of the stored filename. Two uploads for the same person collapse into one entity with two files. The unique index `idx_items_board_identity` on `(board_id, payload->>'identity')` is the enforcement mechanism — a 23505 collision on `setItemIdentity` triggers a merge.

## Mapping shape (as shipped)

```js
{
  identity: { from: "raw" }                         // same as absent — filename is the key
           | { from: "ai", hint: "the full name" }, // derived via extraction
  fields: [...],
}
```

Validation in `validateMapping`: `from` must be `"raw"` or `"ai"`; `from: "ai"` requires a non-empty `hint` ≤500 chars.

## Normalisation (diverged from plan)

```js
// Shipped — also collapses underscores and hyphens so "priya_ramanathan"
// and "Priya Ramanathan" both key to "priya ramanathan". This was added after
// observing the AI return underscore-separated names during live verify.
const normaliseIdentity = (s) => s.trim().replace(/[-_\s]+/g, " ").toLowerCase();
```

## Display name (not in original plan)

`payload.display_name` stores the AI's original-casing output ("Maya Chen") before normalisation. This is written alongside `identity` in `setItemIdentity`. The client uses it as the primary display label instead of the lowercased key. Preservation rule: if the entity already has a `display_name` with uppercase letters and the new derivation is all-lowercase, keep the existing value (prevents regressions on re-extraction).

The client separates three concerns:
- `name` = stored filename (used for URL construction)
- `identity` = normalised semantic key
- `displayLabel` = `display_name || (identity !== name ? identity : (label || name))`

`reconcile()` updates `displayLabel` live when the poll returns a changed identity/display_name, so cards relabel without a page reload.

## Data model

No new columns. Additions to `payload` JSONB:

```js
payload = {
  identity,              // provisional filename → replaced with normalised derived value
  display_name,          // AI's original-casing output, e.g. "Maya Chen" (not in original plan)
  identity_provisional,  // true when AI returned null for identity on a new item
  files, fields, mapping
}
```

## Server (`server/db.js`)

Four new functions — `getItemByIdentity`, `setItemIdentity(db, id, identity, displayName)`, `appendItemFiles`, `removeFileFromItem`. The `setItemIdentity` signature gained `displayName` vs the plan.

Also: `listItems` response now includes `display_name` and splits `name` (stored file path) from `identity` (semantic key). Previously `name = payload.identity`; for derived items these diverge and the old approach would have broken gallery URLs.

## Server (`server/worker.js`)

`buildFieldsPrompt` injects `identity` first in schema when derived. `extractOne` handles three outcomes:

1. **Value found, no collision** — `setItemIdentity` (with `displayName`), write fields, advance to `pending`
2. **Collision (23505)** — `mergeIntoExisting`: append files to existing entity, delete provisional, re-queue existing to `pending_extract`
3. **No value** — only marks `identity_provisional = true` on brand-new items. Re-extracted entities that already have a valid `display_name` skip the flag (added after live verify showed the flag incorrectly appearing on merged entities post re-extraction).

## Server (`server/server.js`)

- `validateMapping` extended for identity slot
- `DELETE /api/items/:id/files/:index` — removes file, re-queues, deletes entity if last file
- `GET /api/items/:id/reasoning` — returns `files`, `identity_provisional`, plus existing `reasoning` and `fields`

## Client

**`mapping-modal.js`** — identity row became a configurable select (filename/AI) + hint textarea.

**`lightbox.js`** — per-file remove buttons (≥2 files), clickable file switcher, provisional warning, Re-extract button (stays "Queued" after success, calls `ensurePolling()` for live card update, URL field values render as `<a>` links).

**`data.js`** — `reconcile()` detects items that disappear from the poll (merged), removes ghost cards, fires `app:item-merged` toast event.

**`toolbar.js`** — A–Z sort toggle; sort buttons wrapped in `.sort-group` to avoid the `margin-left:auto` double-push bug.

## Deviations from original plan

| Plan | Shipped |
|---|---|
| `normaliseIdentity` collapses whitespace only | Also collapses `-` and `_` |
| Display from `payload.fields` (deferred) | `payload.display_name` ships as the display layer |
| `setItemIdentity(db, id, identity)` | Gains `displayName` param |
| `identity_provisional` always set on null | Skipped when entity already has a valid `display_name` |
| Merge toast: not mentioned | Ships — `app:item-merged` event + toast in upload.js |
| Multi-file view: not mentioned | Ships — file switcher in Details panel |
| A–Z sort: not mentioned | Ships — toolbar toggle |
| URL field values: not mentioned | Ships — auto-detected, rendered as `<a>` |

## Tests

19 new tests in `test/derived-identity.test.js` (89 total). Covers `buildFieldsPrompt` with/without derived identity, mapping validation, `getItemByIdentity`, `setItemIdentity` collision (23505), `appendItemFiles`, `removeFileFromItem`, file-remove route, reasoning endpoint `files` + `identity_provisional`.
