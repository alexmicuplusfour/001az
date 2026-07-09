# Plan: Semantic search over tagger reasoning

> **Status (2026-07-06):** All phases implemented and tested locally (31/31
> tests, container rebuilt, schema applied). Deviations from the plan below:
> the worker embeds via the backfill sweep only (markTagged/setItemTags clear
> the vector, the sweep re-embeds within one poll tick — one code path instead
> of two); no `dimensions` param is sent (native dims per model; search only
> compares current-model vectors); `setItemTags` (manual edits) also
> invalidates vectors. Not yet exercised against real OpenAI/Gemini keys —
> the embed Test button in admin is the first thing to try.

> **Goal:** free-text search per board ("calm airy dashboards with soft charts")
> ranked by meaning, not keywords. The tagger's per-facet reasoning is already
> item-specific prose; we add one per-item freeform description, embed
> description + reasoning + tags per item, and rank by cosine similarity to the
> embedded query. Admin gets a global enable toggle; embeddings require an
> OpenAI or Gemini key (Anthropic has no embeddings API). Gemini also becomes a
> full third tagging provider via its OpenAI-compatible endpoint.

## Current state (what this builds on)

- **Reasoning**: when `boards.ai_reasoning` is on (default), the tagger returns
  one sentence per facet plus a `fit` sentence; stored in `items.tag_reasoning`
  JSONB as `{ facetKey: sentence, fit: sentence }` (`schema.sql:81`), parsed in
  `worker.js` (`tagOne`), snapshotted in `tag_snapshots.reasoning`, served
  lazily via `GET /api/items/:id/reasoning`, shown in the lightbox panel.
- **Providers**: `server/providers.js` — `PROVIDERS = ["anthropic", "openai"]`,
  `callTagger` dispatches per provider, `testKey` backs the admin Test buttons.
  OpenAI is called via plain `fetch` (no SDK). Keys live in `ai_keys`
  (`provider` column), app default in `settings.default_key_id`, per-board
  override in `boards.ai_key_id/ai_model`.
- **No search of any kind today** — the frontend filters by tag chips only
  (`filters.js`, `state.js`, `grid.js`); `GET /api/items?board=` returns the
  whole board and the client does the rest.
- **DB**: `postgres:17-alpine` in both compose files. No pgvector.
- **Scale**: hundreds of items per board, low thousands total. This drives the
  storage decision below.

## Decisions

- **Per-item description, not per-facet.** Per-facet justification already
  exists (`tag_reasoning`). The new field is one 1–2 sentence freeform
  description of the whole item, requested in the same tool call. It rides in
  `tag_reasoning` under the reserved key `description` (same pattern as the
  existing reserved key `fit`), so `tag_snapshots` and the reasoning endpoint
  carry it with zero schema churn.
- **No pgvector — brute-force cosine in Node.** At this scale (≤ a few
  thousand vectors of 1536 floats) a full scan is sub-millisecond and avoids
  swapping the postgres image + extension migrations in two compose files.
  Vectors live in a `BYTEA` column (Float32Array buffer). If the gallery ever
  hits ~50k items, revisit with `pgvector/pgvector:pg17` (drop-in image swap,
  volume-compatible).
- **One global embedding model, not per-board.** Vectors are only comparable
  if produced by the same model. Embedding config (key + model) is app-level
  in `settings`; each stored vector records the model that produced it, and a
  model change marks everything stale for re-embedding.
- **Gemini = full provider, via the OpenAI-compatible endpoint.**
  `https://generativelanguage.googleapis.com/v1beta/openai/` supports chat
  completions with forced function calls + image parts AND `/embeddings`, so
  both tagging and embedding reuse the existing OpenAI wire code with a
  different base URL. No new SDK.
- **Embedding input per item**: `description` + per-facet reasoning sentences
  + tags flattened to words (`"theme: light; density: roomy"`). Tags add the
  facet vocabulary so exact-word queries also land.

## Phase 1 — the `description` field

1. `worker.js buildPrompt`: when `withReasoning` is true, add a top-level
   `description` property to the tool schema — "1–2 sentences describing the
   item as a whole: what it is, its style and mood" — declared **before** the
   facets (describe → justify → select). Add a matching line to the system
   text. `required` includes it; keep `additionalProperties: false`.
2. `tagOne`: lift `input.description` into `reasoning.description` (trimmed,
   tolerate absence like the other drift cases).
3. Lightbox reasoning panel (`types/image/lightbox.js`): render `description`
   at the top, styled like `fit`, skipped when absent. It must not render as a
   facet row.
4. `test/prompt.test.js`: schema includes/omits `description` per the
   reasoning flag; parse path stores it.
5. Note: existing items won't have descriptions until retagged — the admin
   Retag button already covers backfill, and embedding treats description as
   optional anyway.

## Phase 2 — Gemini as a provider

1. `providers.js`: `PROVIDERS = ["anthropic", "openai", "gemini"]`,
   `PROVIDER_DEFAULT_MODEL.gemini = "gemini-2.5-flash"`. Refactor `openaiTag`
   to take a base URL + auth header; `gemini` calls it with the
   OpenAI-compat base URL. Same for `testKey` (`GET /models/{id}`).
2. Usage normalization: the compat endpoint reports `usage` in OpenAI shape —
   existing normalization applies. Cached-token details may be absent; guard
   with the existing `|| 0`s.
3. `admin.js`: add gemini to the provider `<select>` and `PROVIDER_MODELS`
   (e.g. `gemini-2.5-flash`, `gemini-2.5-pro`; keep in sync with
   `PROVIDER_DEFAULT_MODEL` as the comment demands).
4. Verify strict-schema behavior: the compat layer accepts
   `tools[].function.parameters` but may ignore `strict` — the worker already
   validates values against the allowed set, so drift is tolerated. Test with
   a real key on one image board.

## Phase 3 — embedding pipeline

1. **Schema** (`schema.sql`, additive `ALTER TABLE IF NOT EXISTS` style):
   - `items.embedding BYTEA` (nullable), `items.embedding_model TEXT`.
   - Settings keys (no new table): `embed_enabled` (`"1"`/absent),
     `embed_key_id`, `embed_model`.
2. **`providers.js`**: `embedTexts({ provider, apiKey, model, texts })` →
   `POST {base}/embeddings` for openai (`text-embedding-3-small` default) and
   gemini (`gemini-embedding-001`, request `dimensions: 1536` — falls back to
   model default if the compat layer ignores it; dimension consistency is
   enforced per-model anyway). Anthropic keys are not eligible. Returns
   `Float32Array[]` + token usage.
3. **`worker.js`**: after `markTagged` succeeds and embeddings are enabled,
   build the item's embed text and call `embedTexts` with the *global* key
   (not the board's tagging key); store vector + model. Embedding failure must
   not fail the tagging — log it and leave the vector NULL (the backfill
   sweep retries).
4. **Backfill/staleness sweep**: a worker pass (same loop cadence as the tag
   queue) that finds `status='done'` items where `embedding IS NULL OR
   embedding_model <> current`, in small batches (the embeddings endpoint
   takes arrays — batch ~64 texts per call). Runs whenever embeddings are
   enabled; this is also what handles "turned on later" and "model changed".
5. Re-tag → `markTagged` → vector cleared/rewritten in the same update, so
   retagged items re-embed naturally. Item delete cascades already cover
   cleanup.

## Phase 4 — admin UI

In the existing **AI Config** section (`admin.js` ~810), a new "Semantic
search" block:

- Enable/disable switch (writes `embed_enabled`).
- Key `<select>` listing **only openai/gemini keys**; model `<select>` per
  provider (`text-embedding-3-small` / `text-embedding-3-large`;
  `gemini-embedding-001`).
- When no eligible key exists: switch disabled, inline note — *"Semantic
  search needs an OpenAI or Gemini API key for embeddings (Anthropic doesn't
  offer an embeddings API). Add one under AI keys."* This is the required
  user-facing key notice.
- Status line: `N of M tagged items embedded` (+ stale count after a model
  change) so backfill progress is visible; a Test button that embeds one
  string via `testKey`-style endpoint.
- Changing the model warns that all items will re-embed (cost: cents).

Server side: fold the new settings into the existing
`GET/POST /api/admin/ai-config` handlers + validation (key must exist and be
openai/gemini when enabling).

## Phase 5 — search API + frontend

1. **`GET /api/search?board=<id>&q=<text>`** (`requireAuth` +
   `canAccessBoard`, same guard as `/api/items`): embed the query with the
   global model, load the board's vectors (id + bytea; hundreds of rows, fine
   per request — add an in-process per-board cache keyed on a version counter
   only if it ever measures slow), cosine-rank, return
   `[{ id, score }]` for items above a relative cutoff (e.g. within 0.15 of
   the top score, capped at 60). Rate-limit modestly (each call costs one
   embedding request). 404/empty when embeddings are disabled.
2. **Frontend** (`toolbar.js` + `state.js` + `grid.js` + `filters.js`): a
   search input in the toolbar, submitted on Enter (not per keystroke — every
   query is an API call). Active search = the grid shows only returned ids,
   ordered by score; tag-chip filters still intersect on top. Clear button /
   Esc restores normal order. Hide the input entirely when the server says
   embeddings are off (flag on an existing bootstrap payload, e.g. `/api/me`
   or the board response).
3. **Tests**: access control on `/api/search` (board membership), disabled
   state, ranking sanity with stubbed vectors.

## Costs & edge cases

- **Cost**: embedding is ~$0.02/M tokens; an item's blob is ~100 tokens →
  the whole gallery re-embeds for well under $0.05. Queries are ~10 tokens.
  The description field adds ~50 output tokens per tagging call.
- **Boards with `ai_reasoning` off**: items embed from tags only — weak but
  harmless. The admin reasoning toggle copy should mention reasoning powers
  semantic search.
- **Held/pending/error items**: never embedded (no tags yet); they simply
  don't appear in search results, matching how the grid treats them.
- **Public crates page**: search stays behind auth for now; the public page
  keeps chip filtering only.
- **Ordering**: Phase 1 ships alone (it improves the lightbox even without
  search). Phase 2 is independent. Phases 3→4→5 are sequential.
