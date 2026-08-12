# Slice 5d — Connector faces (generated charts + sourced images)

**Superseded in part (2026-08-12) by
[`connector-face-default-plan.md`](connector-face-default-plan.md):** the chart is now the
finance templates' default face and the modal's face row is a locked chip, not a
`Symbol tile / Price chart` source select. The tile was never a producer — it's what a card
draws with no rendered face — so it's the fallback only, and offering it as a peer made it
most boards' default. The producer/period/cadence machinery below is unchanged; only the
default and the control are. Read the two sections that describe the source select
(`mapping-modal.js`, verify step 6) as history.

Self-contained implementation plan. Parent design: `pipeline-boards-plan.md`; continues the connector track from `slice-5c-connector-runtime-plan.md`. Finishes the entity mapping's third slot — **face** — for connector boards.

## What this ships

Connector entities currently render a **symbol tile** (`connectorKind` in `kinds.js`, e.g. `LTC` on a dark card). This slice lets a board upgrade that to a real face:

- **Face becomes the third mapping slot** — `mapping.face`, alongside identity and fields, resolvable from `raw` (the tile, default) or `connector`.
- **A connector declares face *producers*** (domain capabilities, like it declares `fields`). Crypto declares a **`chart`** producer: given a price history series, it renders a line chart (SVG→webp) with the **ticker + name overlaid** so it stays legible at card size.
- **Chart data is real history** from a new provider method `history(id, period)`. **CoinGecko-first**; CoinMarketCap's paid history is deferred. If the active provider can't supply history, the face **gracefully falls back to the tile**.
- **User-chosen period + cadence** — the face row in the mapping modal has a period select (`24h … 5y … max`) and the *same* liveness cadence widget as fields (`Off / 1m / … / 1d`). Period = the range shown; cadence = how often to regenerate.
- **The chart feeds the tagger** — once the face is a stored image file, `modelInputFor` sends it as a visual part, so feeling-based facets (`24h momentum`, `risk profile`) get judged from the trend shape, not just the number.

Out of scope: the **sourced-image producer** (e.g. movie poster from a source URL) — designed for below but built when a second connector needs it; CMC history; interactive/detail-view charts; AI-sourced faces.

## The model

Two layers, same split as everywhere else:

- **Provider = data.** `history(id, period)` returns a raw `[{ t, price }]` series. A backend concern (CoinGecko has it free; CMC doesn't). Optional — its absence gates the capability.
- **Connector = domain rendering.** `crypto.faces.chart(series, { symbol, name, period })` turns the series into a webp. The runtime never draws a chart; the domain does.

`mapping.face` picks a producer the connector declares in its manifest. Crypto declares `chart` (option: `period`); a future movies connector would declare `poster` (bound to an image field, no render) — the seam accommodates both, we implement `chart`.

## Mapping shape (additions)

```js
mapping.face =
    { from: "raw" }                    // symbol tile — same as absent (default)
  | { from: "connector", producer: "chart", period: "1y", live: true, every: 60 }
// live/every: the field-liveness widget reused; Off = render once at add, never redraw
```

`validateMapping` ([server.js:529](server/server.js#L529)) additions:
- `mapping.face` optional; `from` ∈ `{ "raw", "connector" }` (ai deferred).
- `from: "connector"` requires `input.connector` set; `producer` must be one the connector's manifest `faces` declares; `period` must be in that producer's allowed set.
- `live`/`every` follow the field rules (`every` integer 1–43200 when live).

## Data model

**Generated face file.** The chart is stored under the existing convention ([sources/index.js:4-5](server/sources/index.js#L4-L5)) — `galleryDir/<name>` (full view) + `thumbsDir/<name>.webp` (card face) — so cleanup stays generic. The connector vehicle instance gains a file entry:

```js
payload.files = [{ name, kind: "image", generated: true, w, h }]   // was []
```
Because it's a normal image file, `kindFor` renders it as the face and `modelInputFor` sends it — no new card or tagger pipeline. Absent (no history / raw face) → `files: []` → the tile, as today.

**`entities.face_at` (new column).** When the face was last generated — the scheduling input for the face's cadence (mirrors how a field's `at` lives in `entities.fields[k].at`).

```sql
ALTER TABLE entities ADD COLUMN IF NOT EXISTS face_at BIGINT;
```

`refresh_at` (slice 5c) becomes `min(live fields' next-due, face's next-due)` where the face term is `face_at + mapping.face.every*60000`. So `nextRefreshAt` / `rescheduleEntityRefreshes` / `reconcileLiveSchedules` fold in the face (they already load the entity + board mapping; `face_at` is on the entity row and `mapping.face.every` on the board — no instance join needed).

**Status legs.** Connector entities with a chart face route through a pre-tag **face leg**, mirroring the extract leg:
```
pending_face → facing → pending → processing → tagged | failed
```
so the chart exists before the first tag (which needs to see it). Plain items and raw-face connectors skip it (straight to `pending`, as today). `STATUS_PRIORITY`, `recoverStuck` (`facing → pending_face`), and `failOrRequeue(requeueStatus)` extend to the new pair.

## Provider — `history`

```js
// coingecko.js — market_chart; period → days (24h→1, 7d→7, 30d→30, 90d→90,
// 1y→365, 5y→1825, max→"max"); downsampled to ~150 points in the renderer.
export async function history(id, period, { apiKey } = {}) {
  const days = PERIOD_DAYS[period];
  const r = await fetch(`${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}`, { headers: cgHeaders(apiKey) });
  if (!r.ok) throw new Error(`CoinGecko history failed: HTTP ${r.status}`);
  const d = await r.json();
  return (d.prices || []).map(([t, price]) => ({ t, price }));
}
```
`coinmarketcap.js` gets **no** `history` export → the runtime detects the absence and the face falls back to the tile while CMC is active.

## Connector — the chart producer

`crypto/index.js` (still mostly data) grows a `faces` map + manifest descriptors:

```js
export const faces = { chart: renderChart };   // domain rendering, sharp+SVG like renderTextPreview
manifest.faces = [{
  name: "chart", label: "Price chart",
  periods: ["24h", "7d", "30d", "90d", "1y", "5y", "max"],
}];

// renderChart(series, { symbol, name, period }) → { webp: Buffer, w, h }
//  - downsample series to ~150 points; scale to min/max; SVG <path> line
//  - net-change tint (green up / red down), symbol big + name small overlaid
//  - sharp(Buffer.from(svg)).webp() at a fixed size (e.g. 600×360)
```

Same render mechanic as `docSource`'s `renderTextPreview` ([doc.js:121-137](server/sources/doc.js#L121-L137)) — build an SVG string, `sharp(Buffer.from(svg)).webp()`. Fonts already available in the image (`fonts-dejavu-core`, added for text previews).

## Runtime — `produceFace`

```js
// runtime.js — resolve the active provider, gate on history, fetch the series
// (re-resolving the id by symbol on a provider switch, like refresh), render.
// Returns { webp, w, h } or null (→ caller keeps the tile).
export async function produceFace(db, conn, entity, source, faceCfg) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  if (!provider.history || !conn.faces?.[faceCfg.producer]) return null;
  const id = name === source?.provider ? source.id : await resolveBySymbol(db, conn, entity.symbol);
  if (id == null) return null;
  const series = await provider.history(id, faceCfg.period, { apiKey });
  if (!series.length) return null;
  return conn.faces[faceCfg.producer](series, { symbol: entity.symbol, name: entity.display_name, period: faceCfg.period });
}
```
Bound into the registry `bind()` like the other methods. Returns bytes only — file I/O stays in the worker (it owns `galleryDir`/`thumbsDir`).

## Worker — the face leg + regeneration

A shared `generateFace(entity, inst, board, now)` used by both the leg and the sweep:
1. `runtime.produceFace` → bytes (or null → leave the tile, clear `face_at`).
2. Write to a **new random filename** — `galleryDir/<new>` + `thumbsDir/<new>.webp` — then delete the old face file. New name because `/gallery`+`/thumbnails` cache immutably (slice-5c note); reusing a name would serve a stale chart. The card's `reconcile` picks up the changed `files[0].name` → fresh fetch.
3. Update the instance (`files: [face]`) and `entities.face_at = now`; recompute `refresh_at`.

- **`processFaceOne`** (new leg): `claimNextPendingFace` (mirrors `claimNextPendingExtract` at [db.js:999](server/db.js#L999) but **no AI-key gate** — it's a data/render step) → `generateFace` → status `pending`. Failure rides `failOrRequeue(requeueStatus: "pending_face")`. In `tick()` it runs after the extract leg, before the tag leg.
- **Sweep**: `refreshDueEntity` (slice 5c) also regenerates the face when `face_at + mapping.face.every*60000 <= now`, via `generateFace`. A face regen does **not** cascade a retag (same reasoning as field refresh — the next tag, scheduled or `retag_on_refresh`, picks up the current chart).

## Tagger input

`modelInputFor` ([worker.js:307](server/worker.js#L307)) already sends `files[0]` as an image part, so the chart flows to the tagger for free. One tweak: when `files[0].generated`, use a chart-aware anchor — *"This is a {period} price chart for {name}. Tag it using record_tags, judging from the chart and the fields below."* The connector-field dossier still appends ([worker.js:381-390](server/worker.js#L381-L390)), so the tagger sees **chart + numbers**.

## Server

- **Entities route** ([server.js:991](server/server.js#L991)): when `mapping.face?.from === "connector"` and the connector can produce it, insert the vehicle at `pending_face` instead of `pending`; else unchanged. `face_at` starts NULL (the leg sets it).
- **`validateMapping`**: the face-slot rules above.

## Client

- **`mapping-modal.js`** — a **face row below the identity row** (connector boards only): a source select (`Symbol tile` = raw / `Price chart` = the connector producer), and when chart, a **period** select + the **cadence** `livenessSelect` (reused verbatim). Serializes to `mapping.face`. Non-connector boards don't show it.
- **In-flight statuses** — `pending_face`/`facing` join `pending_extract`/`extracting` everywhere the client treats items as in-progress (`data.js` `inProgress()`, `grid.js` spinner, upload watcher). The symbol tile is the progress face until the chart lands (the existing just-added-coin progress-face behaviour, `e20f767`).
- **Card / lightbox** — no change: `kindFor` renders the generated image as the face; the lightbox full view shows `galleryDir/<name>`. The ticker/name legibility is baked into the render.

## Tests (`test/faces.test.js` + extend `connectors`/`liveness`)

- `validateMapping`: face slot valid (`raw`; `connector`+`chart`+period+cadence); rejected (unknown producer, bad period, face on a non-connector board, `live` without `every`).
- `renderChart` (pure): a stub series → a webp Buffer with sane dims; empty series handled.
- `produceFace` (fetch stubbed): CoinGecko active → series → bytes; **CMC active (no `history`) → null** (fallback proven); provider switch re-resolves by symbol.
- Face leg: a chart-face connector board → entity created at `pending_face`; `generateFace` writes a file + sets `face_at` + advances to `pending`; the vehicle now has an image file so `modelInputFor` sends an image part.
- Scheduling: `refresh_at` folds in the face cadence; a regen writes a **new** filename and unlinks the old.
- No live network in tests (history stubbed, as fetch is elsewhere).

## Verify (live, throwaway board)

1. Crypto board → mapping modal → face row → **Price chart, period 1y, cadence 5m** → Save.
2. Add a coin → card shows the tile briefly (`pending_face`), then the **chart with ticker/name**; Details full view shows it too.
3. First tag reflects the chart (check `momentum`/`risk` reasoning references the trend, not only the number).
4. Wait a cadence → the chart regenerates (new filename, card refreshes); non-live fields/tile untouched.
5. Admin → switch active provider to CoinMarketCap → next face gen finds no `history` → **falls back to the tile** (no crash); switch back → chart returns.
6. Set face to **Symbol tile** → Save → regenerates nothing, card is the tile.

## Phases

1. **Chart face end-to-end** — provider `history`, `renderChart`, `produceFace`, the face leg + `face_at`, mapping slot + modal row, tagger anchor. Crypto only, CoinGecko only.
2. **Sweep regeneration** — fold the face cadence into `refresh_at`/`refreshDueEntity` (could ride phase 1 if small).

## Status — SHIPPED + PUSHED 2026-07-08 (commit `d7b0906`)

Both phases in one commit (Phase 2 interleaves Phase 1's files). 143 tests green (`test/faces.test.js`). Live-verified on the compose stack with CoinGecko active: LTC rendered a valid webp chart and re-tagged `momentum/steady` + `risk_profile/established` straight off the trend.

### Deviations from the plan above

- **`generateFace` is exported from `worker.js`** (module scope, like `refreshDueEntity`) and does NOT set `refresh_at` — the callers do (the face leg and the sweep compute the face-inclusive `refresh_at` via `entityRefreshAt`), so there's one authoritative write per pass.
- **`dueLiveEntities` matches the vehicle by `payload ? 'source'`, not file-count.** The plan's mental model had the vehicle file-less, but a generated face *gives it a file* — the old `jsonb_array_length(files)=0` join would have dropped every face-bearing entity from the sweep. Caught in Phase 2.
- **`runtime.entityRefreshAt` + `faceCadence`** are the shared "min over live fields + face" helpers; `rescheduleEntityRefreshes`/`reconcileLiveSchedules` fold the face in (a board can now be live via the face alone).
- **`releaseHeld`** routes held connector-face items to `pending_face` (before `pending_extract`), so an auto-tag-off board still renders the chart when it resumes.
- **Provider fallback is silent + self-noting:** `produceFace` returns null when the active provider lacks `history()`; `generateFace` then clears `face_at` and leaves the tile. A face that never rendered (e.g. created under CMC) won't auto-retry on the sweep (face_at stays null) — re-add or re-save fixes it; minor, noted.

### Follow-ups after live use (commits `335f876`, `1529b47`)

Running the faces on a live 9-coin board surfaced four things:

- **First-render self-heal (`335f876`).** The sweep only *regenerated* existing faces (`face_at != null`), so enabling/raising a live face never backfilled coins that hadn't rendered yet. Now a live face with `face_at` null is due *now* — turning a face on renders it for every existing entity on the next sweep.
- **Chart restyle (`1529b47`).** White background, full-width line (no lateral padding), smaller black ticker + name.
- **Face errors are isolated (`1529b47`).** A failed render no longer aborts the sweep or the field refresh — the original symptom was a face 401 taking *prices* down with it. The face leg falls back to the tile instead of failing the item.
- **CoinGecko's demo tier caps history at 365 days** (366+ → 401) — this was the real cause of the persistent 401s (a `5y` period request), not rate limiting. The chart now offers periods up to **1y** and `history()` clamps the day count. Longer ranges need a CoinGecko **Pro** key (different host/header) — deferred.
- **Per-provider rate limiter (`1529b47`).** A token bucket paces each provider under its API limit (CoinGecko rpm 25 / burst 3) with a bounded retry treating **429 and 401** as "slow down" (the demo tier returns 401 for rate). Providers surface `.status`/`Retry-After`; env-tunable (`CONNECTOR_RPM`/`CONNECTOR_BURST`) so the stubbed test suite runs unthrottled. 146 tests green.

## Deferred

- **Sourced-image producer** (movies `poster`, stocks logo) — the second instance that proves the `faces` seam; built with the connector that needs it. Shape: `{ from: "connector", producer: "poster" }`, no render, just fetch+store the provider's image URL.
- **CoinMarketCap history** (paid endpoint) — until then CMC boards use the tile.
- **Interactive charts** in the detail view (client canvas over `field_snapshots` + provider history) — the face here is a static image.
- **Chart styling depth** (axes, gridlines, currency labels) — v1 is a clean sparkline-style line + overlay.
