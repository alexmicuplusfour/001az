# Pipeline Boards — concrete plan

Prerequisite: the agnostic-core migration (`agnostic-core-plan.md`) is complete — no image module, no board types, every item is `{ identity, files, fields }`, uniqueness is `(board_id, identity)`.

## The model

**Input is universal.** The plus button opens one dialog on every board: drop files and/or type lines of text. No board customizes the input surface — everything board-specific is interpretation.

**Identity mode is the per-board switch** deciding how input becomes items:

- **raw** (default, images today): each file or line is one item, immediately, no AI. Identity = the filename or the line itself ("INTC").
- **derived**: input is *material*; the AI assigns identity from inside it per the board's identity hint ("the applicant's name"). Items merge by identity — material accumulates, which is how one item comes to hold several files.

**Instructions do the rest.** Facets (shipped) judge each item; a fields schema (new) extracts typed values first. Both are per-board config-as-prompt, both apply identically in either identity mode. Uploading PDFs to a raw board whose facet descriptions say "read the document" is legitimate flexibility — the user owns the boundaries, the AI never redraws them.

**Cards are deterministic: body = the material's face, title = the identity.**

- image file → the image (today's card, unchanged; title suppressed — a random filename is noise)
- pdf → page-1 render; text-ish docs → title + doc icon
- text line → title-only card, until a connector or extraction gives it a face
- derived item with several files → first image (stable, not random) or a small collage; identity as title
- connector-backed item → **the connector generates the face** (stock → price chart webp). Whoever supplies the data supplies its face.

## Data model

Board config — columns, following the existing `facets`/`ai_*` pattern:

```sql
ALTER TABLE boards ADD COLUMN IF NOT EXISTS identity_mode TEXT NOT NULL DEFAULT 'raw';   -- 'raw' | 'derived'
ALTER TABLE boards ADD COLUMN IF NOT EXISTS identity_hint TEXT NOT NULL DEFAULT '';      -- derived: what identity IS
ALTER TABLE boards ADD COLUMN IF NOT EXISTS fields JSONB NOT NULL DEFAULT '[]';          -- extraction schema; [] = no extract stage
ALTER TABLE boards ADD COLUMN IF NOT EXISTS gather_instructions TEXT NOT NULL DEFAULT '';-- research guidance for the extract call
ALTER TABLE boards ADD COLUMN IF NOT EXISTS gather_every_min INTEGER;                    -- connector/research refresh cadence; NULL = static
```

Field schema entries: `{ key, kind, description, role?, bind? }` — kinds `text | number | url | date | image | series`; `role: "hero"` promotes an image field to the card face; `bind: { connector, fn, args }` makes the field connector-filled (see Connectors). Kinds define the extraction-tool schema fragment, the JSON shape, and the rendering; new kinds are rare and deliberate.

Item payload (extends the agnostic-core shape):

```js
payload = {
  identity: "Jane Doe",     // raw: filename / typed line. derived: AI-assigned; filename is provisional until extraction resolves it
  text: "INTC",             // typed-line items only: the line is the material
  files: [{ name, original_name, w, h, kind, hash, generated: true? }],  // generated: connector-made faces
  fields: { price: { v: 187.2, src: "finnhub", at 1751800000000 },
            name:  { v: "Jane Doe", src: "extract" } },
}
```

Item status gains an extract leg, used only when the board has fields or derived identity:

```
held → pending_extract → extracting → pending → processing → tagged | failed
```

`held` moves to the very front (extraction is AI spend; auto-tag off must gate it too). Boards with `fields: []` and raw identity skip straight to `pending`, exactly today's flow. Claim/retry/stuck-recovery extend as-is; `idx_items_status` already covers it.

Extraction history mirrors tagging history: `field_snapshots`, same shape as `tag_snapshots` (`item_id, source, fields, reasoning, at`). Ships when fields can first change (slice 5).

## Mechanics

**Ingest** (`/api/upload`, already core): accepts multipart files (image + pdf/txt/md/csv by sniffed type, each through its source handler) and/or `{ lines: [...] }`. Raw board: item per file/line, dupes rejected on `(board_id, identity)`. Derived board: item per file/line with provisional identity, straight to `pending_extract`. Source handlers own preview generation (image → thumbnail as today; pdf → page-1 webp via poppler-utils in the app image). Hygiene: mime sniffing, per-file/total size caps, PDF page cap.

**Extract** (worker, one AI call per item): input = the item's files as image/document blocks + `payload.text` + `gather_instructions` + exact values of bound fields (filled first, so the model sees facts as context); web research rides the existing `ai_research` toggle. Output = `record_fields` tool call — strict schema built from `boards.fields` exactly as `record_tags` is built from facets (descriptions as gloss, reasoning-first). **Bound fields never appear in the tool schema** — the model never transcribes numbers. On derived boards the schema carries a reserved `identity` key (the pattern `fit`/`description` already use in `tag_reasoning`).

**Identity resolution** (derived boards, after extract): normalize (trim, collapse case/whitespace); collision on `(board_id, identity)` merges — the new item's files append to the existing item (per-file content-hash dedupe), the new row is dropped, the existing item goes `pending_extract` (re-extract over the grown material → re-tag; snapshots accrue). No identity found → keep the provisional filename, surface it on the item's error slot. The correction path for a wrong merge is manual file-removal in the detail view — it must ship in the same slice.

**Connectors** (`server/connectors/<name>.js`, tiny registry):

```js
export default {
  manifest: { apiVersion: 1, name: "finnhub", version: "0.1" },
  settings: ["api_key"],                    // admin-configured, namespaced in settings
  fns: {
    quote:  { args: { symbol: "text" }, returns: "number", async call(args) {...} },
    closes: { args: { symbol: "text" }, returns: "series", async call(args) {...} },
  },
  async preview(item) {...},                // optional: returns an SVG/PNG buffer → sharp → webp,
}                                           // stored as a generated file entry = the card face
```

Bindings resolve `$identity` / `$fields.x` into args. Connector failures mark the field stale, never fail the item. The rendered preview does double duty: card face *and* the chart image the tagger sees (momentum/basing are shapes, not arrays).

**Liveness**: `gather_every_min` re-runs bindings + preview per item; a changed value or new material marks the item dirty → `pending_extract` → re-tag. Spend follows change. `auto_tag_periodic` stays for boards where only judgment goes stale. Manual reprocess remains the human override at any stage.

**Client**: plus dialog (dropzone + lines textarea); card face/title rule above (grid's ratio-based layout unchanged — faces are always sized images or fixed title cards); detail view = material viewer (lightbox for images, file links otherwise) + fields with provenance (extracted vs connector, per-field reasoning) + tag reasoning + file removal on derived boards. Board modal grows: identity mode + hint, fields editor (shares bones with the facet editor — extract the shared table component, don't copy it), gather instructions + cadence. Item files served behind auth + board ACL only — résumés must never ride public statics.

## Slices

Each shippable, verified live before the next.

1. **Text input** — plus dialog (files + lines), `{ lines }` ingest, `payload.text`, title-only cards, text part in model input. *Verify: paste ticker lines on a research-on board → tagged with sane reasoning.*
2. **Documents** — pdf/txt/md/csv source handlers, pdf page-1 preview, document blocks in model input (Anthropic-native). *Verify: drop PDFs on a raw board with doc-reading facet instructions → previews + correct tags.*
3. **Extraction** — `boards.fields` + editor, `record_fields`, extract statuses, fields in detail, usage counted. Anthropic-only. *Verify: résumé PDFs → fields populated with reasoning.*
4. **Derived identity** — `identity_mode`/`identity_hint`, reserved identity output, merge + accumulate + hash dedupe, collage face + identity title, file removal in detail. *Verify: mixed Watson/Roberts images on a derived board → exactly two items, material intact under re-upload.*
5. **Connectors** — registry, finnhub, bindings, generated chart faces, `gather_every_min` + dirty cascade, `field_snapshots`. **Stock board = pure config**: raw identity (ticker lines), two bound fields + researched narrative fields, feeling-facets (thesis / moat / recognition / momentum / conviction-source), research on. *Verify: paste tickers → chart cards with exact numbers; only changed items re-tag on the next cycle.*
6. **Templates** — board-creation picker (candidates, stocks, doc-compare) prefilling config + facets, extending the existing suggested-facets confirm flow.

## Deferred

- **Replace semantics** for derived merges (v2 résumé supersedes v1) — accumulate + manual file removal covers it until it annoys.
- **Office formats** (docx/pptx/xlsx via headless LibreOffice compose service).
- **Extraction on compat providers** (needs a per-provider PDF story) and **agentic gather** (model browses material/connectors mid-call — escape hatch for oversized material).
- **Field-level user edits with locks** — design together with the override-vs-refresh rule when liveness is real.
- **Interactive charts** — cards stay static faces; a period-selector chart belongs in the detail view someday.
- **PLUGIN.md + reference connector** — after finnhub proves the connector contract.
