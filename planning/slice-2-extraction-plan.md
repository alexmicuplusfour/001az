# Slice 2 — Extraction (fields) + the embryonic ingestion modal

Self-contained implementation plan. Parent design: `pipeline-boards-plan.md` (entity boards). Everything here is buildable against the current `main` without reading that doc.

## Context (state of the repo)

- Every item is an **entity**: `payload = { identity, files: [{name, original_name, kind, w, h}], fields: {} }`, unique per `(board_id, identity)`. No board types, no image module. `fields` has been an empty reserved slot since the agnostic-core migration.
- Ingestion: `POST /api/upload` (`server/ingest.js`) → source handlers (`server/sources/`: image sharp pipeline; doc pdf/docx/txt/md/csv with preview faces + docx text sidecar). Statuses: `held → pending → processing → tagged | failed`.
- Tagging: `server/worker.js` — `getBoardPrompt` builds a cached per-board prompt + strict `record_tags` schema from facets; `modelInputFor(payload)` builds provider-neutral parts from `files[0]` by kind (image thumb / pdf document block / text+docx inline); `providers.js#callTagger` maps parts per provider (`TOOL_NAME = "record_tags"` currently hardcoded).
- Client: `kinds.js` (faces), `upload.js` (drop/picker → `/api/upload`), `toolbar.js` plus button → `triggerFilePicker()`, `lightbox.js` Details panel (`paintPanel`: meta block → description → facet reasoning; lazy `GET /api/items/:id/reasoning`).
- Dev loop: `docker compose up -d --build app` → http://localhost:8001; `npm test` (needs compose pg on 127.0.0.1:5433); mint a session: `docker compose exec app node server/mintlink.js admin@example.com` then curl the link with a cookie jar. Headless checks: Edge + `npm i --no-save puppeteer-core` (prune after). Live verify on throwaway boards via the API, delete them after. Real tagging calls are fine (default Anthropic key configured).

## What this slice ships

The AI half of the **entity mapping**: boards get a mapping of AI-extracted fields; ingested items pass through an extraction call before tagging; results show in the Details panel. Configuration lives behind a new **split on the plus button** — the plus itself keeps today's behavior exactly (file picker; global drag-drop untouched); the split opens a menu whose one entry for now is **"Entity mapping…"**, opening the mapping modal. Later slices grow the menu (connector ingestion, review) in place. **The board-settings modal never learns about mappings.**

Blank-first, no templates: the mapping starts empty and the user writes their own fields — this slice proves mapping-via-AI-prompts generically, not any particular importer. Each field row carries a **source** select: "AI instruction" (active) and "Connector" (visible, disabled — the forward signal that this is a mapping, arriving with live data sources).

Out of scope, on purpose: derived identity (identity stays raw), connector/bound fields (disabled option only), review staging, templates of any kind, field roles on cards, per-ingestion mapping override (the modal edits the board default; that's the only mapping for now), research during extraction, `field_snapshots`.

## Data model

```sql
ALTER TABLE boards ADD COLUMN IF NOT EXISTS mapping JSONB;  -- NULL = no extraction, board behaves exactly as today
```

```js
// boards.mapping, v1 shape (identity/face/input slots arrive in later slices; absent = raw/file/files)
{ fields: [{ key, kind: "text"|"number"|"url"|"date", from: "ai", hint }] }
// from is explicit for forward compat ("connector" arrives with live data sources)
// validation: key = facet-style slug, unique; kind from the enum; from = "ai" only; hint string ≤500; ≤12 fields

// item payload additions
payload.mapping = { ...board mapping at ingest time }   // stamped — re-extraction replays THIS, never the board default
payload.fields  = { name: { v: "Maya Lin", why: "…" } } // extraction output; v null when not found
```

Statuses gain the extract leg: `held → pending_extract → extracting → pending → processing → tagged | failed`.
Items whose stamped mapping has ≥1 field start at `pending_extract` (after the held gate — `held` means no AI spend, so it must gate extraction too). `releaseHeld` routes to `pending_extract` when `payload ? 'mapping'`, else `pending`. `recoverStuck`/attempts/requeue machinery extends to the new pair (new `claimNextPendingExtract`, requeue back to `pending_extract`). Index `idx_items_status` already covers it.

## Server

**`server/ingest.js`** — read `board.mapping` (add `mapping` to `BOARD_COLS` in db.js); when it has fields, stamp `payload.mapping` and start the item at `pending_extract` (auto_tag permitting). Upload response unchanged plus nothing new (fields arrive async like tags).

**`server/worker.js`** — new extraction pass, mirroring tagging's shape:

- Claim priority: `pending_extract` before `pending` in the poll loop.
- `buildFieldsPrompt(mapping)` (exported pure, like `buildPrompt`): systemText ~"You extract structured fields from items for a private research board." + per-field lines from hints; strict schema `record_fields`: per field `{ key: { why: string, value: T|null } }` — reasoning declared before value (the record_tags discipline); kinds map text/url/date→string, number→number; value nullable for "not found". No prompt cache v1 (extraction runs once per item; mappings vary per item).
- `extractOne(row)`: resolve the board's AI (same `resolveBoardAi` path — needs board ai_key_id/ai_model via `getBoard`), parts from the existing `modelInputFor(row.payload)`, call with the `record_fields` tool, lenient-validate kinds (number is a number, url looks like one; wrong → null + keep why), write `payload.fields` (`updateItemPayload`), status → `pending`. Failures ride `failOrRequeue` semantics back to `pending_extract`/`failed`. Usage → `bumpUsage`.
- Tagging feeds on fields: in `tagOne`, when `payload.fields` is non-empty, append a text part — `"Extracted fields:\nname: Maya Lin\nyears: 15"` — so judgment sees the distilled data.

**`server/providers.js`** — parameterize the tool: `callTagger({ …, tool = { name: "record_tags", description: TOOL_DESC } })`; `anthropicRequest`, the tool-use block name-check, and `compatTag` all use it. (The research web_search path stays record_tags-only.)

**Routes** (`server/server.js`):
- `GET /api/boards/:id` → include `mapping` (the modal reads it).
- `PATCH /api/admin/boards/:id` → accept `mapping` with shape validation (admin-only, like facets; members see the pane read-only).
- `GET /api/items/:id/reasoning` → also return `fields` (the Details panel already fetches this lazily).
- `POST /api/items/:id/reextract` (auth + item access) → requires `payload.mapping`; sets `pending_extract`. Reprocess stays retag-only.

## Client

**Split plus** (`toolbar.js`) — the plus button itself is untouched (file picker). Beside it, a small chevron using the existing `openDropdown` machinery; menu entries for now: **"Entity mapping…"**. Later slices append entries here (connector ingestion etc.).

**`mapping-modal.js` (new) + styles** — opened from the menu:
- Editable field rows: key, kind select (text/number/url/date), **source select** ("AI instruction" active; "Connector" disabled with a "coming with live data sources" hint), hint textarea, remove; add-field button. Starts blank.
- Save (admins) → `PATCH /api/admin/boards/:id { mapping }`, toast; non-admins see it read-only.
- Visually consistent with the facet editor but built fresh — different schema, different page; extracting a truly shared editor component is a later refactor if the shapes converge.
- Modal follows the board-modal conventions (overlay, Escape, click-out with mousedown guard).

**Status surfaces**: `pending_extract`/`extracting` join `pending`/`processing` everywhere the client treats items as in-flight — `data.js` `inProgress()` + upload watcher counts, `grid.js` loading-spinner condition, `upload.js` pendingIds check.

**Details panel** (`lightbox.js` `paintPanel`): a **Fields** section between the meta block and the description — one row per field (`name — Maya Lin`) with the why-sentence underneath in the facet-reasoning style; `v: null` renders as "—". A small "Re-extract" action in the section header hits the new endpoint.

## Tests (extend `test/docs.test.js` patterns; suite currently 53)

- `buildFieldsPrompt`: schema shape (why-before-value, nullable values, kind→type), hint glossing (pure, like prompt.test.js).
- `providers`: `anthropicRequest` with a custom tool name emits it (extend the existing shape test).
- Mapping PATCH: valid saves; bad kind / dup key / oversize rejected; `GET /api/boards/:id` returns it.
- Ingest: board with mapping → item stamped + status `pending_extract`; board without → `pending` exactly as today.
- `releaseHeld` routing, `reextract` endpoint (requires mapping, resets status), reasoning endpoint carries fields.
- No live-AI in tests (extraction call itself is exercised in the live verify).

## Verify (live, throwaway board)

Write a few fields by hand in the mapping modal (any doc-shaped fields — the existing `test/fixtures/sample.docx` works as material) → upload docs → watch `pending_extract → extracting → pending → tagged` → Details shows the fields with justifications → tagging reasoning references the fields → re-extract works → plain plus + drag-drop behave exactly as before on a mapping-less board → headless screenshot of modal + Details → delete board (cleanup intact).

## Risks / notes

- `held` must gate extraction (spend) — check the auto-tag-off path both at ingest and release.
- Strict-schema nullables: if a provider chokes on `type: [T, "null"]`, fall back to required-with-empty-string and normalize server-side; note which path shipped.
- Extraction failures must not strand items: attempts cap → `failed` with the error surfaced, same as tagging.
- Don't regress plain boards: `mapping = NULL` must be byte-identical behavior to today (tests pin it).
- Design rules in force: mapping UI only in the ingestion modal; flexibility over guardrails (defaults, not laws); face/identity vocabulary; commit style = short imperative summary + body, Co-Authored-By Claude Fable 5 trailer; push only when asked.
