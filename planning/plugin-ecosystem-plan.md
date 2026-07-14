# Plugin ecosystem — phase 1: unify

**Status: SHIPPED 2026-07-14 (all 5 slices, local/uncommitted).** 309 tests green
(the occasional full-suite failure is the pre-existing ingest-sweep `until()`
load race — passes isolated). Live-verified on the compose stack against the
real dev DB: migration 0016 applied, 13 plugins render with pre-existing key
state, disable-fallback chain (gecko off → cmc effective; both off → readable
error; re-enable → recovery), rpm config round-trip (5 ↔ descriptor default),
media:pdf gate (refusal toast wording → re-enable → ingest), core lock on
media:image, ai-providers enabled flags, new statics served. Browser DOM not
automated as usual (no headless harness) — admin-plugins.js/plugin-modal.js
are syntax-checked catalog renderers; eyeball the page on next manual visit.

Deviations from the plan as written, decided while building:
- The media-disable gate resolves the handler BEFORE admitFile's
  `unprocessable`-stamping try — a disabled type is config, not a property of
  the bytes, so folder feeds RETRY it after re-enable instead of ledgering
  the file forever. Reject copy: "PDF documents are disabled (Plugins page)".
- `GET /api/admin/ai-providers` gained per-provider `enabled` flags; the board
  modal MARKS a disabled provider's keys ("· disabled") rather than filtering
  them out — defaults not laws.
- `POST /api/admin/plugins/:id/test` is connector-only (AI keys keep their
  per-key test route; media has nothing to call).
- Health is also recorded from the ai-keys/:id/test, ai-config/test and
  embed-test routes, not just live worker/runtime traffic.

Original plan below, kept for the record.

---

---

## Repo context (skim if you know the app)

001az: agnostic boards/entities app. Node/Express + Postgres, build-less vanilla-JS
frontend, docker compose on :8001 (`docker compose up -d`), tests `npm test`
(292-ish green). Migrations are numbered files in `server/migrations/` run in order
by initDb; `0001_baseline.sql` is the fresh-install baseline.

Three integration layers exist today, each already descriptor/registry-shaped but
each with its own admin surface and storage conventions:

- **AI providers** — `server/providers.js`. `PROVIDERS` map (line ~360):
  `local, anthropic, openai, gemini, glm, openrouter`, one data descriptor each
  (label/wire/base/defaultModel/models+notes/research/compat quirks/embeds/keyless).
  Dispatchers `callTagger`/`embedTexts`/`testKey` read `desc.wire`;
  `providerCatalog()` serves the admin UI (`GET /api/admin/ai-providers`,
  server.js:1021 — also consumed by the board modal's per-board override).
  Keys live in the **`ai_keys` table** (named, multiple per provider — db.js:655+);
  slot state in settings: `default_key_id` + `model` (tagger),
  `embed_enabled`/`embed_provider`/`embed_key_id`/`embed_model` (embedder).
  Resolution: worker.js `resolveDefaultAi` (:54), `resolveEmbedder` (:76),
  `resolveBoardAi` (:114, board key → default fallback). Env fallback:
  `ANTHROPIC_API_KEY` when no default key set.
- **Connectors** — `server/connectors/`. Domains (`crypto`, `stocks`) are data
  modules (manifest + `providers` map + `defaultProvider`); `runtime.js` is the
  shared dispatch: `activeProvider` (:79) resolves settings `${domain}_provider`
  (unknown/unset → defaultProvider) + `${domain}_key_${provider}` (per-provider
  key slots, no bleed); `callProvider` (:70) = per-provider token bucket, rpm/burst
  from the provider descriptor (DEFAULT 30/15), env overrides for tests.
  Admin routes server.js:1123–1182 (`GET/POST /api/admin/connectors*`).
  Items stamp `payload.source = {provider, id}`; refresh/faces re-resolve by
  symbol after a provider switch (`resolveBySymbol`) — provider plurality is
  already handled at the data layer.
- **Media (file ingestion)** — `server/sources/`. `createSources()` dispatcher:
  `forUpload(name)` picks by extension (`isDocName` → doc.js, else image.js whose
  sharp sniff is the real gate). doc.js (182 lines) currently bundles THREE stacks:
  text (txt/md/csv, dep-free, SVG text-peek preview), pdf (poppler binary,
  graceful-absent), docx (mammoth npm, worker pool, `.txt`/`.html` sidecars).
  Single call site: ingest.js:33 (`sources.forUpload(...).ingest(...)`) — both
  the upload route and the folder-feed sweep pass through it.
  NOTE: `server/media/` is a DIFFERENT thing (per-kind file-METADATA field
  projection, already a clean registry) — phase 1 does not touch it.

Admin shell: `public/admin.js` — `TAB_NAMES = ["members","boards","ai","connectors"]`,
one module per tab (`admin-ai.js` 322 lines, `admin-connectors.js` 109 lines).

Design rule that governs every choice below: **flexibility over guardrails** —
defaults not laws, graceful degradation not prevention, never a hard block where a
readable fallback works.

## The vision (user's, 2026-07-14)

The app becomes a plugin ecosystem. **Phase 1 (this doc):** one "Plugins" admin
page replaces the AI Tagger and Connectors tabs — a segmented list of every
integration; toggle on/off, configure via a modal whose fields the plugin
declares, star one plugin as the default for each slot. **Phase 2:** users add
their own plugins (self-hosted, npm/GitHub trust model — NOT a hosted marketplace;
decided 2026-07-04). **Phase 3 (future):** self-healing — AI gets structured
failure telemetry and patches plugins when upstream APIs drift. Motivation:
the author implemented FMP but won't implement + maintain a dozen alternatives
per integration type; the contract must be maintainable by one person, the
catalog by a community.

Ratified in planning rounds 1–2:

- **Multi-key stays.** `ai_keys` + `boards.ai_key_id` untouched. Key management
  UI moves INTO each AI plugin's modal (filtered view of ai_keys).
- **Media decomposes by dependency stack**: image (sharp, core), text (dep-free),
  pdf (poppler), docx (mammoth). Audio later.
- **Slots, not per-plugin defaults**: tagger, embedder, one per connector domain.
  Future media→AI needs (audio transcription) become new slots, resolved through
  the registry — media plugins never name providers.
- **Enabled ≠ default**: enabled = usable, default = preselected. Multiple
  connector providers of one domain usable at once (semantic upgrade over the
  old exclusive active pick — the data layer already supports it).

## The model

**Plugin id** = `<segment>:<name>` (colon: URL-path-safe in `/api/admin/plugins/:id`).
Segments are also the page grouping:

| segment | plugins | kind |
|---|---|---|
| `ai` | ai:local, ai:anthropic, ai:openai, ai:gemini, ai:glm, ai:openrouter | ai |
| `crypto` | crypto:coingecko, crypto:coinmarketcap | connector |
| `stocks` | stocks:fmp | connector |
| `media` | media:image (core), media:text, media:pdf, media:docx | media |

**Catalog entry** (assembled server-side, served to the page):

```
{ id, kind, segment, label, core,
  capabilities,          // ai: {tag, embed, research}; connector: {search, list, history…}; media: {extensions, kinds}
  configSchema: [ {key, label, type: secret|number|text|select|toggle, default?, min?, help?} ],
  // + per-kind extras the modal needs: models/embeds catalogs (ai), needsKey (connector)
  state: { enabled, config (secrets masked → hasKey), health, keyCount (ai) } }
```

**Storage — deliberately minimal.** ONE new table (migration `0016_plugins.sql`):

```sql
CREATE TABLE plugins (
  id         TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  config     JSONB   NOT NULL DEFAULT '{}',
  fail_count INT     NOT NULL DEFAULT 0,
  last_ok_at BIGINT, last_fail_at BIGINT,
  last_error JSONB,                          -- {message, status, at} — phase-3 seed, keep structured
  updated_at BIGINT
);
```

**Absent row = enabled with default config** — no seeding, no migration of
existing data. Everything else stays where it lives and is merely *reinterpreted*:

- `${domain}_provider` setting → the domain's **slot default** (was: exclusive
  active). Same key, zero migration.
- `${domain}_key_${provider}` settings → stay the connector key store; the plugin
  modal's `api_key` schema field writes through to them.
- `default_key_id`/`model`, `embed_*` settings → tagger/embedder slots, unchanged;
  existing `POST /api/admin/ai-config` remains their write path (the modal calls it).
- `plugins.config` holds ONLY schema-declared overrides (rpm/burst etc.).

**Enabled semantics (all graceful, all readable):**

- **AI**: `resolveDefaultAi` — default key's provider disabled → treat as
  unconfigured (fall to env key; env provider disabled too → null → boards hold
  pending via the existing noKeyError machinery). `resolveBoardAi` — board key's
  provider disabled → fall through to default (log line, like keyless boards).
  `resolveEmbedder` — disabled → null (embed sweep pauses). Key REGISTRATION for
  a disabled provider stays allowed (storing a key is harmless; defaults not laws).
- **Connector**: `activeProvider` — slot default disabled → first enabled provider
  of the domain (items re-resolve by symbol, existing mechanics); ALL disabled →
  readable throw (routes/ingest-preview already surface error messages).
- **Media**: extension owned by a disabled handler → per-file readable reject at
  the ingest.js:33 gate ("PDF uploads are disabled — Plugins page"); one gate
  covers upload AND folder feeds. Existing items keep files/previews/lightbox —
  disable only stops NEW ingestion. `media:image` is core: not disableable
  (also because sharp is shared infra — pdf/text previews route through it).

## What phase 1 does NOT do

No dynamic loading (built-ins stay explicit imports — phase 2). No per-board
plugin anything beyond what exists. No client plugin halves (kinds.js untouched).
No AI-call rate limiting (worker is single-flight; connector rpm/burst is where
config-with-defaults gets proven). No new slots (transcribe arrives with audio).
`server/media/` untouched (disabled-handler fields just project null — harmless).

---

## Slices

### Slice 1 — media split (behavior-identical)

Split `server/sources/doc.js` by dependency stack; the extension registry becomes
the seam the plugin catalog reads.

- `sources/text.js` (txt/md/csv: sniff NUL-byte, text-peek SVG preview),
  `sources/pdf.js` (%PDF magic, poppler pdftoppm preview + pdfinfo page cap,
  no-poppler fallback), `sources/docx.js` (zip magic, mammoth pool, sidecars,
  `close()`). Shared storage/preview helpers → `sources/shared.js` if extraction
  leaves duplication; each module exports a small manifest
  `{ name, label, extensions: [...], kinds: [...] }` (image's too).
- `sources/index.js`: `isDocName` ternary → handler list; `forUpload` picks by
  extension, unmatched → image (sharp sniff stays the gate). `metaFor` dispatches
  kind→handler (was image-vs-doc). `cleanup` stays generic (shared convention;
  sidecar rms already extension-blind). `close()` → docx only.
- worker `modelInputFor` is kind-driven, not handler-driven — untouched.
- Existing docs/ingest tests staying green IS the behavior pin. Add one:
  registry maps every declared extension to exactly one handler.

### Slice 2 — server registry + read-only catalog (additive)

- New `server/plugins.js`: composes the three sub-registries into catalog entries.
  - ai: from `PROVIDERS` (reuse `providerCatalog()` data; capabilities from
    wire/models/embeds/research; `ai:local` keyless, no keys section).
  - connector: from `getConnector`/domain manifests × providers.
    configSchema: `api_key` (secret; required-when-starred iff `needsKey` —
    CoinGecko's optional demo key means the field always shows),
    `rpm`/`burst` (number, defaults from descriptor ?? 30/15, min 1).
  - media: from sources manifests. `media:image` → `core: true`. Empty
    configSchema in phase 1 (toggles are their substance).
  - Registry-integrity invariants: unique ids, valid schema types, every
    connector provider covered.
- db.js: `getPluginRows`, `getPluginState(db, id)` (absent-row coalesce),
  `setPluginState`, `recordPluginHealth`. Migration `0016_plugins.sql`.
- `GET /api/admin/plugins` (requireAdmin) → `{ plugins: [entries+state], slots }`
  where `slots = { tagger: {keyId, model, envKey}, embedder: {enabled, provider,
  keyId, model, stats}, crypto: {provider}, stocks: {provider} }` — assembled from
  the same settings the old GETs read. Secrets masked (api_key → hasKey).
  Old routes untouched this slice; catalog is additive.

### Slice 3 — state honored (writes + enforcement)

- `PATCH /api/admin/plugins/:id` `{enabled?, config?}`:
  unknown id 404; `core` + `enabled:false` → 400 readable; config validated
  against configSchema (unknown keys rejected, per-type checks); secret fields:
  non-empty set / `""` clear / undefined keep (the connector-route convention,
  server.js:1153–1160); connector `api_key` writes through to
  `settings ${domain}_key_${provider}`; the rest lands in `plugins.config`.
- `POST /api/admin/plugins/:id/test` — ai → `testKey` (body keyId or typed key),
  connector → `conn.testConnection` (typed-key/stored-key fallback, verbatim from
  the old route), media → 400 "nothing to test".
- Slot writes: tagger/embedder keep `POST /api/admin/ai-config` (its validation —
  unknown key, embeds-capability, enable-state — is exactly right already).
  New `POST /api/admin/plugins/slots/:domain` `{provider}` for connector domains:
  validates provider ∈ domain + enabled + needsKey→hasKey (guard moves here from
  the old POST /api/admin/connectors/:name), writes `${domain}_provider`.
- Enforcement:
  - `runtime.activeProvider` (runtime.js:79): resolve name as today, then skip
    disabled → first enabled → all-disabled readable throw. Return the provider
    descriptor shallow-merged with config overrides
    (`{...provider, rpm: cfg.rpm ?? provider.rpm, burst: ...}`) — every
    `callProvider` call site already uses this returned object, so overrides
    flow with zero further edits. `acquire()` (runtime.js:28): refresh
    `b.rpm/b.burst` from the passed values so config edits apply without restart.
  - worker.js `resolveDefaultAi`/`resolveBoardAi`/`resolveEmbedder`: enabled
    checks per the semantics table above (each is a 2–3 line gate + log).
  - ingest.js:33: `forUpload` consults enabled state → readable per-file reject.
    (forUpload becomes async or takes a prefetched enabled-set — prefer the
    latter: ingest already has db; pass `disabledExts` resolved once per request.)
  - `POST /api/admin/ai-keys` provider list: keep permissive (see semantics).
- Tests: PATCH validation matrix, core lock, write-through key, activeProvider
  fallback chain + all-disabled throw, rpm override reaches the bucket,
  resolve* fallbacks, disabled-extension reject (upload + feed leg).

### Slice 4 — the page (UI swap + old-route retirement)

- `admin.html`/`admin.js`: `TAB_NAMES = ["members","boards","plugins"]`; DELETE
  `admin-ai.js` + `admin-connectors.js`; new `admin-plugins.js` + `plugin-modal.js`
  (shared modal.js/dropdown.js kit; component CSS shared, not copied).
- `admin-plugins.js` — segmented list from the catalog: AI providers / Crypto /
  Stocks / Media types. Row: status dot · label · default-badges ("default tagger",
  "default embedder", "default crypto") · hint (keyCount / hasKey / extensions) ·
  toggle (core → lock) · gear. Toggle PATCHes immediately; default dark toast.
- `plugin-modal.js` — sections by kind:
  - schema-driven config form (secret shows "key set ·········" placeholder,
    blank=keep, explicit clear; number/select/toggle/text renderers);
  - ai: **Keys** (list/add/remove/test — existing `/api/admin/ai-keys*` routes,
    UI ported from admin-ai.js) + **Default tagger** (key+model selects → ai-config)
    + **Embeddings** on embeds-capable (model select, set-default-embedder,
    embed-test, backfill stats — ported, not dropped; stats come with the catalog
    slots payload). envKey fallback surfaced as today ("using env key").
  - connector: config form + Test + "Make default for <domain>".
  - media: enable/disable copy + extension list.
- board-modal.js: per-board key picker filters to enabled providers (keeps
  `/api/admin/ai-providers` — board modal remains its second consumer).
- RETIRE: `GET/POST /api/admin/connectors`, `POST /api/admin/connectors/:name/test`
  (server.js:1123–1182) — admin-connectors.js was their only consumer. Public
  `/api/connectors` (listConnectors → mapping modal/browse) untouched.
  Keep: ai-keys*, ai-config* (modal consumers), ai-providers (board modal).
- Update any tests pinning the retired routes to the new endpoints.

### Slice 5 — health ledger (phase-3 seed)

- `recordPluginHealth(db, id, outcome)`: failure → `last_fail_at`, `fail_count+1`,
  `last_error {message (truncated ~500), status, at}`; success → writes ONLY when
  healing (`fail_count > 0` or `last_ok_at` null) so steady-state sweeps don't
  chatter the table.
- Call points (all already hold db + plugin identity): connector runtime
  search/list/fetchEntity/produceFace/testConnection outcomes; worker tagging
  outcome (knows provider); embed-sweep outcome; the two test endpoints.
  Deliberately NOT inside `callProvider` (no db there).
- Catalog serves health → row dot: gray disabled · green ok · amber fail_count 1–2
  · red ≥3; tooltip = last_error.message + relative time. Media dots reflect
  enabled only (local processing failures stay per-item, as today).
- Rule for phase 3: never flatten provider errors to bare strings — keep
  status/body-shape in `last_error`.

---

## Verify (compose stack, end of each slice / all at end)

1. Boot: migration applies; absent plugin rows behave enabled-default.
2. Page renders 6 ai + 3 connector + 4 media rows, correct badges from a DB that
   predates the table.
3. Disable coinmarketcap → crypto adds/refresh/faces still work via coingecko;
   disable BOTH crypto providers → add/preview surfaces the readable error.
4. Set coingecko rpm=5 → feed preview visibly paces (cold enumerate).
5. Disable media:pdf → pdf upload rejects with toast, existing pdf items still
   render + lightbox; re-enable → ingests again. media:image toggle → 400.
6. Disable the default tagger's provider → boards hold pending with log line;
   re-enable → sweep resumes. Embedder disable → sweep pauses, search 400s
   readably (board.search stays on — degradation not prevention).
7. Real tag e2e on anthropic through the new resolution path.
8. Headless page screenshot (house pattern; DOM automation is manual otherwise).

## Risks / notes

- admin-ai.js port is the fiddly part (keys table + tagger defaults + embeddings
  block all re-homed into modals) — do it last within slice 4, diff the served
  payloads before/after.
- Bucket rpm live-update changes a long-lived Map entry — one test pins it.
- `${domain}_provider` reinterpretation means a stale disabled-default silently
  falls forward; the page shows the star on the SETTING's provider with a
  "disabled — falling back to X" hint rather than moving the star (truthful UI).
- deploy.ps1 has no artifact list (docker COPY . .) — new public/*.js files need
  no deploy edits. Droplet prod is still pre-ingestion; nothing here changes that.
- Phase 2 pointer: the catalog entry IS the future plugin manifest — when dynamic
  loading arrives, a dropped-in module must produce exactly this shape +
  `apiVersion` + namespaced name (`vendor.name`). Connector/compat-AI plugins are
  the server-only easy tier; media plugins (server handler + kinds.js client half
  + possible system deps in the image) are the advanced tier, documented in a
  future PLUGIN.md with a reference plugin extracted from coingecko.js.
- Phase 3 pointer: health ledger (slice 5) + dynamic loading (phase 2) are the
  prerequisites; the loop (failure threshold → hand AI the plugin source +
  contract + failing exchange → patch → testConnection gate → human approve →
  reload) is deliberately NOT designed yet.
