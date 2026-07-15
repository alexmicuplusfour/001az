# Plugins phase 2 — the install model (capabilities vs connections)

**Status: SHIPPED 2026-07-15 (local, uncommitted).** 310 tests green;
server + migrations live-verified on the dev DB (see "Verify" at the bottom;
browser DOM not automated as ever — the page is mechanical rendering from the
verified catalog). Deviation from the plan: decision #4 (migration) — instead of
"accept a one-time re-add," a second migration (0018) carries IN-USE connectors
over (a board's domain default + any keyed provider), so existing boards keep
refreshing on upgrade. That's aligned with the model, not a violation: "add what
you use" governs the default for NEW/unconfigured things, not things in use.
Original plan below, kept for the record.

---

Refines the one-line "phase 2"
in `plugin-ecosystem-plan.md` (that doc's phase 1 = the unify/registry work,
SHIPPED as f849254; read it for the registry mechanics this builds on). This
doc is self-contained for a fresh session.

## Why

Phase 1 put every integration on one Plugins page as an on/off toggle with a
health dot, all enabled by default. In use it reads wrong (user, 2026-07-15):

- The **toggle is meaningless** for almost every row. Disabling a *non-default*
  connector provider does nothing observable; "off but present" is only a real
  state for media (and "just don't upload a .docx" makes even that pointless).
- The **green dot** is undefined to the eye — it's "enabled + no recorded
  failure", which for anything never called is indistinguishable from "idle".
- Shipping FMP / CoinGecko / CMC / 5 AI providers **all present and all on**
  reads as the app *blessing* an arbitrary vendor set — and invites the
  unanswerable question "where's the line between pre-installed and community?"

The resolution: stop treating presence as endorsement. The real line is not
*who authored it* but **capability (the app's own) vs connection (an outside
service you opt into)**. A capability ships and can't be removed; a connection
is *available* and you **add** the ones you use. A community plugin is just
another available connection — no separate tier, which is the whole point of
the self-hosted/npm trust model.

## The model

Replace **enabled/disabled** with **installed / available**:

- **Installed** = a card on the page, usable. **Available** = not on the page;
  you Add it from a browse modal. (Mechanically "available" == today's
  "disabled": the enforcement fall-through is identical, only the framing and
  the default posture change.)
- **Default install set** (fresh DB, no rows):
  - **Core capabilities** — the four media handlers (image/text/pdf/docx) and
    the on-device embedder. Always installed, **Remove disabled**. These are
    what the app *is*.
  - **Anthropic** — the one connection pre-added, because tagging (the product's
    core value) must work out of the box. Removable.
  - Everything else — OpenAI, Gemini, GLM, OpenRouter, CoinGecko, CoinMarketCap,
    FMP — **available, not installed**. You add what you use.
- **Remove is graceful, never blocked** (flexibility over guardrails). Removing
  a connection == disabling it today: existing boards keep their items and last
  values (fields stop refreshing, no crash); re-adding restores. A confirm names
  the impact ("this is your default tagger" / "N boards use this") but always
  lets you proceed. Core → Remove disabled with a tooltip.

### Coalesce rule (mirrors the phase-1 pattern, default inverted)

```
installed(def, row) =
    def.core                         ? true                 // media + embedder
  : row?.installed != null           ? row.installed        // explicit add/remove
  : def.defaultInstalled ?? false                            // anthropic → true, else false
```

`ai:local` (the embedder) gains `core: true`; `ai:anthropic` gains
`defaultInstalled: true`. Every other def defaults to `false` → available.

### The page

- **One flat list, no segment headers.** Each installed plugin is a card:
  `label · one-line description · right-aligned tag · gear · Remove`.
- **Tag** = `Category · qualifier`:
  - AI: `AI · tagger` / `AI · embedder` when it's the active default for that
    slot, else `AI`.
  - Connector: `Data · crypto` / `Data · stocks` (qualifier = domain).
  - Media: `Media · core`.
- **No dot.** The health ledger stays in the DB (phase-3 seed) and its last
  error surfaces inside the gear modal — but no always-green light on the row.
- **Default badges** (default tagger/embedder/domain) stay — they're orthogonal
  to install and set via the gear, exactly as now.
- **`+ Add plugin`** button opens the Add modal.

### The Add modal

Lists the **available** (`!installed`) plugins from the same catalog — each a
row of `label · description · tag · [Add]`. Add writes `installed: true` and
refreshes. Empty state when everything's installed. Leave a commented seam for
the future community path ("add from GitHub/npm URL") — not built now; the
catalog entry already IS the future manifest (see phase-1 doc's phase-2 pointer).

### Labels & descriptions (the "what is Images?" fix)

Every def gains a one-line `description`. `ai:local` label `Local` → **`Xenova`**
(its actual identity; the description carries the meaning since "Xenova" alone
is as opaque as "Local"). Authoritative draft:

| id | label | description | tag |
|---|---|---|---|
| media:image | Image files | Accept & thumbnail JPG, PNG, WebP, GIF, SVG | Media · core |
| media:text | Text files | Read .txt / .md / .csv as plain text | Media · core |
| media:pdf | PDF documents | Extract text + a page-1 preview (via poppler) | Media · core |
| media:docx | Word documents | Extract text from .docx (via mammoth) | Media · core |
| ai:local | **Xenova** | On-device embeddings for search — no API key (transformers.js) | AI · embedder |
| ai:anthropic | Anthropic | Claude models for tagging & descriptions — bring a key | AI · tagger |
| ai:openai | OpenAI | Models for tagging + embeddings — bring a key | AI |
| ai:gemini | Gemini | Google models for tagging + embeddings — bring a key | AI |
| ai:glm | GLM | Z.ai models for tagging — bring a key | AI |
| ai:openrouter | OpenRouter | Many model backends behind one key | AI |
| crypto:coingecko | CoinGecko | Live crypto prices & market data — keyless | Data · crypto |
| crypto:coinmarketcap | CoinMarketCap | Live crypto prices — needs a key | Data · crypto |
| stocks:fmp | Financial Modeling Prep | US stock quotes, fundamentals, history — needs a key | Data · stocks |

## Slices

### Slice 1 — server: `installed` replaces `enabled`
- **Migration 0017**: `ALTER TABLE plugins ADD COLUMN installed BOOLEAN;`
  (nullable — NULL = "no explicit choice" → coalesce to the tier default).
  Backfill a phase-1 *disable* as a removal:
  `UPDATE plugins SET installed = FALSE WHERE enabled = FALSE;` Leave
  `enabled = TRUE` rows as `installed = NULL` — phase-1 "enabled" carried no
  explicit intent (everything was on by default; many rows are health-only), so
  they fall to the tier default, NOT auto-installed. `enabled` column is left in
  place, unread (drop in a later squash).
- **plugins.js**: `installed()` coalesce above; `ai:local` `core:true`,
  `ai:anthropic` `defaultInstalled:true`; catalog `state.installed` replaces
  `state.enabled`. All media core → `disabledMediaSet` always empty: remove it
  and the ingest.js gate (dead once media can't be removed — one fewer per-file
  branch; the folder-feed retry note in phase-1 becomes moot).
- **Enforcement** (pure rename of the boolean's source, behavior identical):
  `aiPluginEnabled`→`aiPluginInstalled` (worker.js:57), `runtime.activeProvider`
  skips not-installed → first installed sibling → all-removed readable throw
  (runtime.js:110), `pluginState.enabled`→`.installed`.
- **Routes**: `PATCH /api/admin/plugins/:id` takes `{installed}` (was
  `{enabled}`); `core && installed===false` → 400 "core capability — can't be
  removed". Config write-through unchanged. `db.js setPluginState({installed})`.
  Slot-default guard at server.js:1086 ("disabled — enable it first") →
  "not installed — add it first".
- **Tests**: fresh DB → core + anthropic installed, all else available;
  add→installed / remove→available; remove the active connector default →
  fall-forward to a still-installed sibling; core remove → 400; config
  write-through still lands.

### Slice 2 — labels & descriptions
- Add `description` to each provider descriptor (providers.js), connector
  manifest (crypto/stocks index.js), media manifest (sources/*.js). Rename
  `ai:local` label → `Xenova`. plugins.js surfaces `def.description`.
- Test: every catalog entry has non-empty `label` + `description`.

### Slice 3 — the page (admin-plugins.js rewrite)
- Flat card list from the catalog, `installed` only; core cards first, then the
  rest. Card = label · description · right tag · gear · Remove (disabled+tooltip
  for core). Tag helper: segment→category, qualifier from active slot / domain /
  "core". **Delete the dot.** Subtitle rewritten ("Capabilities and connections.
  Add the services you use; core capabilities are always on.").
- Remove → confirm naming impact → `PATCH {installed:false}` → refresh.
  Optional `pluginUsage(db,id)` → `{boards, isDefault}` for the confirm text
  (nice-to-have; generic copy if skipped).
- Keep default badges + gear→plugin-modal.js untouched.

### Slice 4 — the Add modal
- New `plugin-add-modal.js` (shared modal.js kit): available plugins as
  `label · description · tag · [Add]`; Add → `PATCH {installed:true}` → refresh +
  close; empty state. Commented seam for the future URL/npm path.

### Slice 5 — health off the row, onto the modal
- Remove dot rendering (done in slice 3); surface `state.health.lastError` as a
  small "last error · <relative time>" line inside plugin-modal.js when present.
  Recording (`withPluginHealth`, `recordPluginHealth`) untouched — phase-3 seed.

## Decisions baked in (flag if wrong)
- **Only Anthropic is pre-added** among connections (not CoinGecko) — the user
  named Anthropic; a keyless crypto board is still one Add away. Revisit if a
  working-out-of-the-box crypto demo matters more than a clean default.
- **All media handlers + the embedder are core (non-removable).** "Refuse a
  file type" was judged not worth a control; poppler/mammoth already degrade
  gracefully when absent.
- **Remove never blocks**; graceful degradation + a naming confirm.
- **Migration is additive** (new nullable column), not a rename — a phase-1
  health-only row must NOT read as an explicit install.

## Verify (compose stack)
1. Fresh-ish DB boots: page shows core media + Xenova + Anthropic only;
   OpenAI/Gemini/GLM/OpenRouter/CoinGecko/CMC/FMP absent from the page.
2. Add CoinGecko → appears with `Data · crypto`; a crypto board can now pick it.
3. Remove Anthropic (confirm names "default tagger") → boards hold pending via
   env/no-key machinery; re-add → resumes.
4. Remove a connector in use → existing items keep last values, stop refreshing;
   re-add → refresh resumes.
5. Core card Remove is disabled with a tooltip; API rejects `installed:false` 400.
6. Labels read clearly; "Images"/"Xenova" self-explain via their descriptions.
7. Headless page screenshot (manual; no DOM harness).

## Risks / notes
- **Migration/health coupling** is the sharp edge: health rows exist for called
  plugins with `enabled=TRUE`; the additive-nullable column + "only backfill the
  FALSE ones" keeps them *available*, not silently installed. Pin with a test on
  a seeded health-only row.
- Slot defaults still point at a possibly-removed provider — same "truthful UI"
  rule as phase 1: show the badge on the setting's provider with a "falling back
  to X" note rather than moving it.
- `enabled` column left unread this phase (squash later) to keep 0017 trivial
  and reversible.
- deploy.ps1 has no artifact list (docker COPY . .) — new public/*.js needs no
  deploy edit. Prod droplet still pre-ingestion; nothing here changes that.
- Community "add from URL" is deliberately out of scope — this phase makes the
  *shape* (installed/available + Add modal) that phase-2-proper (dynamic loading)
  drops modules into.
