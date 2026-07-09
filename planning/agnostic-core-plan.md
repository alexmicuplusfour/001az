# Agnostic Core — dissolving the image module

A migration, not a feature. At the end the app looks and behaves exactly as today, but there is no image module and no board-type machinery: core speaks one generic item shape — **identity + files + fields** — and an image board is just a board whose items each carry one image file. Everything the comparator direction needs later (text-line items, doc items, extraction, derived identity, connectors) then lands as additions to this shape.

**Scope guard:** nothing new ships. No new file types, no fields UI, no identity modes beyond raw. Four steps, each behavior-identical, each verified on the running stack before the next.

## The item shape

```js
payload = {
  identity: "a1b2c3d4e5f6a7b8.webp",  // raw: for images, the stored filename — what
                                       // UNIQUE(filename) already means, now named
  files: [{ name, original_name, w, h }],  // the material (images: exactly one entry)
  fields: {},                              // reserved; empty until extraction exists
}
```

Uniqueness becomes per-board — `UNIQUE (board_id, identity)` — replacing today's *global* filename index (which currently forbids the same image on two boards; per-board is the correct semantic and can't collide on existing data, since global-unique is strictly stronger).

## Step 1 — identity in the data (server only, API byte-identical) — ✅ shipped 2026-07-06

*Verified: 45 tests green (new `test/payload.test.js`: legacy-row migration, API shape, per-board uniqueness, index swap); dev DB (209 items) migrated on container restart with `/api/items` **byte-identical** before/after for all four boards; live upload wrote the new shape and board delete cleaned both files.*

**Migration**, riding `initDb` next to the existing one-timers (idempotent via WHERE, single atomic UPDATE):

```sql
UPDATE items SET payload = jsonb_build_object(
  'identity', payload->>'filename',
  'files', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'name', payload->>'filename', 'original_name', payload->>'original_name',
    'w', payload->'w', 'h', payload->'h'))),
  'fields', '{}'::jsonb)
WHERE payload ? 'filename' AND NOT payload ? 'identity';

DROP INDEX IF EXISTS idx_items_filename;
```

`schema.sql`: replace `idx_items_filename` with `CREATE UNIQUE INDEX IF NOT EXISTS idx_items_board_identity ON items (board_id, (payload->>'identity'))` and update the payload comment.

**Every payload reader, same commit:**

| Where | Change |
|---|---|
| `db.js` `listItems` (line ~138) | `name: r.payload.identity`, `w/h` from `payload.files[0]` — `/api/items` output stays byte-identical |
| `server/types/image.js` upload | `ctx.items.create` writes the new shape |
| `server/types/image.js` `buildModelInput` | thumbnail path from `payload.files[0].name` |
| `server/types/image.js` `onDelete` + dims backfill | loop `payload.files` |
| `worker.js` `embedTextFor` fallback + log label | `files[0].original_name` / `payload.identity` |
| `scripts/sqlite-to-pg.js` (line ~85) | ETL writes the new shape directly (older dumps are still caught by the initDb guard) |

**Verify:** new payload-shape test (upload → row has identity/files/fields; old-shape row migrated by initDb); full suite; dev-stack click-through: browse, upload, tag, lightbox, delete, favorites, crates.

## Step 2 — generic rendering (client only) — ✅ shipped 2026-07-06

*Verified: 45 tests green; headless Edge parity pass on the largest board (116 items) — 60-card incremental batch all with `<img>` faces + `dataset.ratio` + masonry positions, lightbox open/nav/reasoning-panel/close, hover chrome (actions + tag chip), upload button, zero page errors (favicon 404 pre-existing). The deploy.py ARTIFACTS warning below is obsolete — deploys are image-based now (`deploy.ps1`, Dockerfile `COPY . .`), so file moves ship automatically.*

The client type seam is five hooks (`renderCardBody`, `renderProgressBody`, `openDetail`, `triggerIngest`, `previewUrl`) resolved through `state.adapter`. Replace the seam with a **file-kind module**; the hook implementations move verbatim.

- New root `kinds.js`: the image kind — card body (the `<img>` with ratio pinning and load/error wiring from `types/image/index.js`), progress body, detail (lightbox), preview/thumb/full URLs. Dispatch: `kindFor(item)` — v1 always the image kind; the seam is the point.
- Call sites: `grid.js` (~239, ~292, ~301) → kind functions; `toolbar.js` (~87) → file picker directly; `tag-editor.js` (~15) → kind preview.
- `types/image/upload.js` → `upload.js`, `types/image/lightbox.js` → `lightbox.js` (git mv back to root — the indirection is what's being removed, not the code). `app.js`: drop `registerType`/`getType`/`state.adapter`, call `initUpload()`/`initLightbox()` at boot. Delete `types/`.
- ⚠️ `deploy.py` ARTIFACTS: add `kinds.js`, fix the moved paths (this list has been missed twice before).

**Verify:** visual parity on the real boards is the acceptance bar — masonry + `dataset.ratio` fast path, lazy load, lightbox nav + reasoning panel, upload placeholders and progress, tag-editor preview, hover chrome. Headless pass (Edge + puppeteer-core, the template from the original refactor) + suite.

## Step 3 — generic ingest + model input (server) — ✅ shipped 2026-07-06 (together with step 4)

*Verified: 45 tests green; `/api/items` byte-identical pre/post on all boards; live e2e — type-less board create → upload through `ingest.js` + `sources/image.js` → **real Sonnet tagging call through the core `modelInputFor`** (`theme/light`) → item delete cleaned both files → board delete. Headless: board page renders, admin "New board" modal has no type picker and prefills the starter facets. (Steps 3+4 shipped as one pass: deleting the registry breaks the board-types endpoint, so leaving the picker up in between would have been a broken interim.) Superseded 869c879, after documents landed: the subject is now the literal `"items"` — boards mix file kinds, so the byte-identical invariant was deliberately broken; one-time prompt-cache re-prime, tag-snapshot comparability boundary at that commit.*

- **`server/ingest.js`**: `/api/upload` moves out of the image adapter unchanged (auth, board ACL, multer limits, per-file loop, uploaded/rejected response). Per file it calls a **source handler** picked by sniffed type — images only, as today.
- **`server/sources/image.js`**: the sharp pipeline verbatim — process-wide decode gate, SVG rasterization, `ALLOWED` map, thumbnailing, the OOM constants. Returns the file entry `{ name, original_name, w, h }`; ingest wraps it into the item.
- **Worker**: `buildModelInput` becomes a core function — parts from the item's files by kind (image file → thumbnail image part + the exact "Tag this image using the record_tags tool." text). `getBoardPrompt` drops `registry.get(board.type)`; `subject` is the literal `"images"` — **the prompt stays byte-identical** (board prompt cache and snapshot comparability depend on it).
- **Deletes**: `server.js` item/board delete paths call a core `cleanupFiles(payload)` (gallery + thumbnail unlink per `files[].name`) instead of `adapter.onDelete`.
- **`server.js`**: registry creation/`mountAll`/export removed; ingest route + `/gallery` and `/thumbnails` authed statics mounted directly. Delete `server/types/` (registry, ctx facade, adapter). The narrow-contract discipline isn't lost — it returns with connectors, when something is a plugin again.

**Verify:** suite (access matrix, prompt, research tests unchanged — `buildPrompt`'s signature keeps the subject arg); e2e on the dev stack: upload → real tagging call → delete cleans both files.

## Step 4 — retire the type surface — ✅ shipped 2026-07-06 (see step 3 note)

- `admin.js` board modal: remove the type `<select>` + `/api/admin/board-types` fetch (~lines 602–677); the starter-facets prefill stays, fed by a local constant (the old image `suggestedFacets`). `POST` body drops `type` (~line 808).
- `server.js`: remove `GET /api/admin/board-types` and the type validation on board create; `createBoard` drops the type param. `boards.type` column stays (DEFAULT `'image'`, nothing reads it — drop in a later schema pass); stop emitting `type` in board payloads.
- Sweep: README board-type mentions, any `board.type` reads left in client/server.

**Verify:** board create/edit incl. facet prefill + confirm-on-overwrite flow; full suite; final click-through.

## Risks / invariants

- **Step 1 rewrites every live item row.** Idempotent single-statement UPDATE, guarded on shape, rehearsed against a copy of the dev DB before any real one — same discipline as the `images → items` rename.
- **The tagging prompt must not change byte-for-byte**: subject `"images"`, tool `record_tags`, gloss path untouched. Prompt cache keys and snapshot comparability both ride on it. *(Held through the migration; superseded by 869c879 once boards mixed file kinds — see step 3 note.)*
- **Step 2 is the only visually exposed step**; layout math, card cache, and chrome don't change — only where the body element comes from. Parity or it doesn't ship.
- **API contract frozen throughout**: `/api/items` keeps emitting `name`/`w`/`h` exactly as today; `toItem()` and everything downstream never notices.
- The board-type plugin seam is deleted deliberately: one built-in behavior needs no adapter layer. Extension points return later as source handlers / file kinds / connectors — smaller, sharper contracts.
