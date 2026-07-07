# Entity Boards — one entity, mapped from anywhere

Prerequisite (✅ shipped 2026-07-06): the agnostic core — no image module, no board types; every item is `{ identity, files, fields }`, unique per `(board_id, identity)`.

## The model

**There is one kind of thing: the entity** (= the item). It has an identity, a face, files (material), fields (metadata), and — once connectors exist — live data. An image is an entity with one file and no fields; a candidate is identity + extracted fields + files; a stock is identity + bound fields + a generated face and no files at all. The Details panel is the entity view.

> **Revised 2026-07-08 (`entity-instances-plan.md`, shipped):** the entity is now a
> thin row *above* items; each items row is one **instance** — one file with its own
> extracted fields, facet tags, and queue state. Entity-level: identity, display
> name, connector-bound fields, hearts, crates. Instance-level: AI-extracted fields
> and tags (scope follows the field's source). Merge/split = re-parenting instances;
> the Details panel is two zones (identity pinned, instance swaps with the file
> switcher).

**The entity mapping says how each slot gets filled.** Per slot, the source is an AI instruction, a connector, or raw:

```js
mapping = {
  input:    "files" | { connector: "finnhub" },          // how entities arrive: drop files, or search/pick from a provider
  identity: { from: "raw" }                              // filename / connector id
          | { from: "ai", hint: "the candidate's name" } // derived: built by extraction
          | { from: "connector" },
  fields: [
    { key: "name",   kind: "text",   from: "ai", hint: "the candidate's full name" },
    { key: "price",  kind: "number", from: "connector", fn: "quote",  args: { symbol: "$identity" } },
    { key: "series", kind: "series", from: "connector", fn: "closes", args: { symbol: "$identity" } },
  ],
  face: "file" | "connector",                            // file preview, or generated (chart)
}
```

**Templates are named mapping presets** — "People (résumés)", "Stocks" — that *copy* into use (never shared by reference; editing a template must not rewire boards at a distance). Connectors ship their template; the app ships a couple.

**The board holds a default mapping, not a law.** The plus modal opens on the board's default; the user can switch template for any ingestion. Mixed boards are allowed and degrade gracefully — Details shows whatever fields an item has, and tagging's `fit: undecided` verdict already absorbs material the facets can't describe. Because mappings can vary per ingestion, **each item stamps the mapping that built it** (in payload) — re-extraction replays the item's own mapping, never the board default. Never strong-arm the user; the app fails gracefully.

**Ingestion flow (the split plus).** Plus → modal → template (default: the board's; switchable) → the input surface the mapping implies (drop zone for files; provider search/list for connector input) → entities are **staged and shown for review** — identity, fields, face laid out so mis-mapping is caught before it lands (the wrong-merge moment for derived identity, the "INTC → Intel Corp?" moment for connectors) → commit releases them into the normal pipeline (extract where needed, then tagging). Per-mapping auto-commit for flows you've come to trust.

**Facets are untouched.** Board-level taxonomy, `record_tags`, reasoning, snapshots, per-board keys — the judgment layer stays exactly as shipped; extraction feeds it a fields dossier as one more text part.

## Data model

```sql
ALTER TABLE boards ADD COLUMN IF NOT EXISTS mapping JSONB;         -- default mapping; NULL = plain files, no extraction
ALTER TABLE boards ADD COLUMN IF NOT EXISTS gather_every_min INTEGER; -- connector refresh cadence (liveness slice)
```

Item payload additions (slots already reserved):

```js
payload = {
  identity, files, fields,               // as shipped
  fields: { name: { v: "Maya Lin", why: "…", src: "ai" | "finnhub", at } },
  mapping: { ... },                      // the mapping that built this entity (stamped at ingest)
}
```

Statuses gain two legs in front of tagging:

```
review → held → pending_extract → extracting → pending → processing → tagged | failed
```

`review` = staged, visible only in the ingestion modal (excluded from the board listing); commit advances, discard deletes. Items with no extract work skip `pending_extract`. `held` keeps meaning "no AI spend" and gates extraction too. Existing claim/retry/stuck machinery extends per status.

Extraction history (`field_snapshots`, shaped like `tag_snapshots`) ships when fields can first change — the liveness slice.

## Mechanics

- **Extract call**: one per entity — material parts (existing `modelInputFor`) in, `record_fields` out: strict schema generated from the mapping's AI fields exactly as `record_tags` is generated from facets (hints as glosses, reasoning-first, kinds → JSON types). On derived-identity mappings the schema carries a reserved `identity` key (the `fit`/`description` pattern). Bound fields never appear in the schema — connector values are filled before the call and shown to the model as context. Usage counts into `ai_board_usage`.
- **Identity resolution** (derived): normalize (trim, case/whitespace collapse); collision on `(board_id, identity)` merges — files append (content-hash dedupe), merged entity re-extracts over grown material, re-tags; snapshots accrue. Surfaced in the review step before it ever commits. No identity found → provisional (filename), flagged.
- **Re-extract ≠ re-tag.** Retag re-runs judgment on stored fields + material. Re-extract (manual, or material/bound-data changed) replays the item's stamped mapping. Spend follows change.
- **Connectors** (`server/connectors/<name>.js`, tiny registry): manifest, admin-configured settings, typed fns, optional `search` (powers the provider input surface), optional `preview` (generated face → webp, stored as a `generated: true` file entry so the card pipeline needs zero special cases), and a shipped template. `$identity` / `$fields.x` resolve into args. Connector failures mark fields stale, never fail the entity.
- **Liveness**: `gather_every_min` re-runs bindings + preview; changed values mark the entity dirty → re-extract → re-tag. `auto_tag_periodic` remains for boards where only judgment goes stale.
- **Client**: split plus modal (template picker, input surface, review grid, mapping editor link); mapping editor shares bones with the facet editor; fields render in Details with provenance (ai vs connector) and per-field reasoning; `role: "title"` / hero fields give ghost entities their card presence. Entity files/faces stay behind auth + board ACL.

## Slices

1. **Documents** — ✅ shipped 2026-07-06 (pdf/docx/txt/md/csv, preview faces, read-the-content tagging, in-lightbox viewing, docx text sidecar via mammoth).
2. **Extraction** — ✅ shipped 2026-07-07. `boards.mapping` (AI fields only), mapping stamped on items, `record_fields`, `pending_extract`/`extracting`, fields in Details. Plus keeps today's file picker; chevron menu gains "Entity mapping…" → mapping modal (identity anchor, field rows, source select). Implementation plan: `slice-2-extraction-plan.md`.
3. ~~**Ingestion modal + review**~~ — **skipped**. Review (staged items, commit/discard, template switching per ingestion) adds friction without benefit at this stage: raw-filename identity means bad extractions are harmless to undo (re-extract), and there are no merges or connector bindings to get wrong. Revisit when derived identity (slice 4) or connectors (slice 5) land, since that's when a wrong merge is hard to undo and review earns its place.
4. **Derived identity** — ✅ shipped 2026-07-07. `mapping.identity.from = "ai"` drives extraction to produce the entity key instead of the filename. Normalisation collapses whitespace, underscores, and hyphens before lowercasing. Collision on `(board_id, identity)` merges — files append, provisional deleted, existing entity re-extracts + re-tags. `display_name` preserves AI's original casing for display; `name`/`identity` split in the list response fixes URL construction for derived items. Client: file switcher in Details panel, merge toast, A–Z sort, provisional warning, Re-extract queues live. Implementation plan: `slice-4-derived-identity-plan.md`.
5. **Connectors** — registry, finnhub (settings, fns, `search`, chart `preview`, stock template), provider input surface, bound fields + identity, `gather_every_min` + dirty cascade, `field_snapshots`. **Stocks ship as a template, zero stock code in core.** *Verify: search "intel" → entity lands with chart + exact numbers → tagged; next cycle re-tags only changed entities.*
6. **Research resolver** — "add by name": free-typed names resolved by web research + extraction (identity derived/canonicalized). Businesses, restaurants, anything nameable. Mostly composition of 2–5 with the shipped `ai_research` machinery. *Verify: five restaurant names → entities with researched fields.*
7. **Template library** — manage/save/share mapping templates (with facet presets riding along); board-creation prefill folds in here.

## Deferred / open

- **Ingestion modal + review** (was slice 3) — template picker per ingestion, `review` staging status, review grid, commit/discard, auto-commit toggle. Deferred until derived identity or connectors make a bad merge consequential.
- **Replace semantics** for derived merges (v2 résumé supersedes v1) — accumulate + manual file removal until it hurts.
- **pptx/xlsx** (mammoth-style extraction or LibreOffice), **agentic gather** (model browses material/connectors mid-call), **field-level edits with locks** (design with the override-vs-refresh rule when liveness is real), **interactive charts** (detail view someday), **PLUGIN.md + reference connector** (after finnhub proves the contract).
- Whether boards can hide specific templates/connectors from their plus menu — add when a real board wants it.
