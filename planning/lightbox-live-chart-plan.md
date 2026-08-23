# Lightbox live charts — detail-renderer registry + a real price chart

Implementation plan. Continues the connector-faces track: `slice-5d-connector-faces-plan.md`
deferred "**interactive charts** in the detail view (client canvas over … provider history)" —
this is that feature, plus the lightbox restructuring it forces. Parent context:
`connector-face-default-plan.md` (the chart IS the finance boards' face), `pipeline-boards-plan.md`.

## What this ships

Today, clicking a stock/coin card opens the lightbox on the **static webp** the face leg
rendered — a picture of a chart, frozen at the last face refresh. This plan replaces that view
with a **live chart** in the Google Finance idiom:

- **Area ↔ Candles** toggle. No compare, no indicators (explicitly out of scope).
- **One canonical range row per domain, below the chart** — `1D 5D 1M 6M YTD 1Y 5Y MAX` —
  pruned live to what the deployment can actually serve (see the capability model).
- **Crosshair + readout** (time + price / OHLC under the pointer), current price + range-change
  header. Fixed viewport (`fitContent`), no pan/zoom in v1.
- Rendered by **TradingView `lightweight-charts` v5.2.1** — vendored, lazy-loaded; no build
  step, no CDN (CSP is `script-src 'self'`), no hand-rolled chart code.
- **Provider/tier/key agnostic, zero-config.** The feature targets the FULL capability
  surface everywhere; what a given backend or key can't serve is *discovered from its own
  refusal*, degrades gracefully (coarser interval → nearest range → static face), drops out
  of the controls for every user, and resurfaces on its own when capability appears. No tier
  matrix in the architecture, no operator setting, no client knowledge of which provider
  exists. Anything provider-specific — endpoints, intervals, gate dialects — lives upstream
  in that provider's module and nowhere else. A plugin connector domain whose provider
  exports `chart()` gets the entire feature for free.
- The static face stays as the **instant fallback**: shown while the series loads, kept when
  no chart can be served at all (no capability, no key, provider down). Honest degrade, never
  a blank stage.

And the structural half, which lands **first**:

- **The lightbox stage becomes a detail-renderer registry.** `showMedia()` is today a hard
  `audio / doc / image` branch chain ([lightbox.js:718-765](../public/lightbox.js#L718-L765));
  a live chart would be special case #4. Instead: an ordered list of renderers, each owning
  `matches()` / `mount()` / `unmount()` — the same shape `kinds.js` already gives card faces.
  Image, doc, and audio become the three built-ins; the chart becomes the fourth entry, not
  a fourth branch. Future types (video, plugin-shipped viewers) slot in the same way.

Out of scope: compare/overlay series, indicators, volume pane, pan/zoom, streaming ticks,
plugin-delivered client renderers (the registry is the seam for them, later).

## The model

Same layering as everything else in the connector system — with the vocabulary owned one
level HIGHER than before, which is what makes the feature provider-agnostic:

| Layer | Owns | This feature |
|---|---|---|
| domain (manifest, pure data) | the canonical control surface | `manifest.chart = { ranges, kinds, defaultRange }` |
| provider (data) | mapping that surface onto its own API | new optional `chart(id, {range, kind}, ctx)`; refuses honestly |
| runtime (dispatch) | resolve provider, pace, track health, **learn capability** | new `chartSeries()` + the learned-availability model |
| route (ACL + shape) | entity → board → connector, wire contract | `GET /api/items/:id/chart` |
| client (presentation) | how content shows itself | detail-renderer registry; draws with lightweight-charts; renders controls **only from the response** |

The domain declares what the control surface *ideally is* (both finance domains declare the
full Google row and both kinds). Providers never declare shrunken vocabularies — a provider
serves a (range, kind) or refuses it, and the refusal is the capability signal. That keeps
every judgment about tiers, hosts, and endpoint matrices inside the provider module that owns
that API's dialect — "handled upstream" — while the architecture, the wire, and the client
stay identical for all of them.

`history()` stays untouched — it feeds the **card face** (periods are the mapping modal's
vocabulary, capped at what renders nicely at card size). `chart()` is the **detail view's**
capability: different ranges, different shapes (OHLC), different economics (view-time,
user-driven). Two consumers, two contracts, one provider file.

### The other candidate source — `field_snapshots` — and why it isn't this

The baseline schema earmarked `field_snapshots` as "the basis of a future price-over-time
chart" ([0001_baseline.sql:179](../server/migrations/0001_baseline.sql#L179)), so the choice
has to be made explicitly, not by omission. It can't carry this feature:

- **moved-only, at refresh cadence** — a board on a 5-minute cadence records at most 288
  points/day, fewer when flat; no OHLC; no depth before the entity was added;
- **gated on `retag_on_refresh`** — the write is
  `if (board.retag_on_refresh) addFieldSnapshot(…)` ([worker.js:797](../server/worker.js#L797)),
  so live boards without retag have **no** movement history at all;
- **90-day default retention** (`SNAPSHOT_RETENTION_DAYS`, worker prune).

Provider history is the primary source, full stop. Snapshots keep their existing job (the
jobs view's `kind=refresh` history). A "what this board actually observed" overlay drawn from
snapshots — zero marginal provider cost, works for any future connector domain without
`chart()` — is a real idea, **deferred**.

---

## Part A — the detail-renderer registry (client refactor, Phase 1)

### Why first

The chart needs a place to mount that isn't another `if`. The refactor is behavior-preserving
and lands alone, so any regression is bisectable to it rather than tangled with the feature.

### Contract

```js
// public/detail-view.js — the registry + the three built-ins.
// A renderer: how one kind of content shows itself on the lightbox stage.
//   { name, matches(inst, entity) → bool, mount(stage, { inst, entity }) → handle }
//   handle = { unmount(), imgEl? }   // unmount releases resources (pause audio,
//                                    // destroy chart, drop object URLs)
// First match wins; registration order IS specificity order:
//   [ chartDetail, audioDetail, docDetail, imageDetail ]   // image is the catch-all
export function mountDetail(stage, inst, entity) { … }
```

- `matches` may read `state` (boardMapping) — client modules already do.
- Renderers create their own DOM inside a single `<div id="lightbox-stage">` that replaces
  today's fixed `#lightbox-img` / `#lightbox-doc` / `#lightbox-audio` siblings in
  [index.html:32-41](../public/index.html#L32-L41).
- `lightbox.js` keeps everything that is *chrome*, not content: nav arrows, fav/crate/info,
  count, panel, download link, keyboard, click-out close, preload. `showMedia(f)` collapses to
  `currentHandle?.unmount(); currentHandle = mountDetail(stage, f, lightboxImg)`.

### Migration of the three built-ins

| Renderer | Moves in | Keeps working (regression contract) |
|---|---|---|
| image | `<img>` creation, fade-in/loading class, alt-from-tags | det-overlay: `positionDetOverlay` reads `handle.imgEl` instead of `#lightbox-img`; overlay stays in lightbox.js (it's panel-linked chrome). Clicks still bubble → close (today's zoom-out behavior). |
| doc | iframe, docx→`.html` sidecar pick, src-set-once, focus recapture on `load` | `elLightbox.focus()` after mount; iframe clicks naturally don't close. |
| audio | player + waveform + transcript cluster, stale-token transcript fetch | `unmount()` = today's `hideAudio()` (pause, drop src, reset); container `stopPropagation` so player clicks don't close. Inline styles on the transcript div move from index.html into the renderer. |

CSS: `#lightbox-doc` / `#lightbox-audio*` id selectors in styles.css become classes; the
generic `.lightbox img` rule already covers the image renderer. No visual change.

Preserved-behavior checklist (hand-verify in Phase 1): arrows/Escape; neighbor preload
(image-only, as today); download href per instance; instance switcher re-mounts; audio stops
on nav/close; doc focus; det-overlay draw/highlight/resize; click-out close everywhere except
interactive surfaces; `closeLightbox` fully resets (via `unmount` + stage clear).

`kinds.js` is untouched — it stays the *card* registry. The two registries stay separate on
purpose: cards dispatch by file kind; the detail stage needs predicates (the chart matches on
*board mapping + entity*, not on a kind string — the vehicle's rendered face IS `kind: "image"`).

---

## Part B — the chart-data capability (server, Phase 2)

### Domain vocabulary (manifest, pure data)

```js
// crypto/index.js + stocks/index.js — the control surface, once per domain:
manifest.chart = {
  ranges: ["1d", "5d", "1m", "6m", "ytd", "1y", "5y", "max"],
  kinds:  ["area", "candles"],
  defaultRange: "1y",     // matches the face default period — visual continuity
};
```

Both finance domains declare the full row. Whether a given deployment shows all of it is the
capability model's runtime answer, never a declaration.

### Provider contract

```js
// Optional capability, like history()/prefetch(). Absent → the domain has no live chart.
// The vocabulary is the DOMAIN's; the provider maps each (range, kind) onto its API —
// or refuses it:
export async function chart(id, { range, kind }, { apiKey, pace } = {})
  → { time: "daily" | "intraday", tz: "utc" | "local", points: [...] }
// points: area → { t|d, p }    candles → { t|d, o, h, l, c }
//   d = "YYYY-MM-DD" (daily granularity)   t = epoch ms (intraday granularity)
```

**One refusal signal, two honest reasons for it.** A provider throws with
`e.unsupported = true` when this (range, kind) isn't servable through it:

- a **plan gate** its API answered — the specific "not on your plan" signals that API
  speaks (only *recognized* gate dialects earn the flag; a bare 403 stays transient so a
  WAF hiccup can't amputate a range);
- a **mapping it doesn't have** — an endpoint the backend simply lacks, or a range past
  what its implemented host can address. Thrown synchronously, zero HTTP, but through the
  SAME channel — so "not implemented yet upstream" and "not on this key's plan" degrade
  identically, and an upstream module upgrade lights the control back up with no changes
  anywhere else.

Anything else thrown is **transient** (timeouts, 429s, 5xx): a readable 502, retryable,
learns nothing.

**Within-range degrade beats refusal.** A provider whose finest interval is gated steps down
before giving up (intraday bars: finest → coarser → hourly). A coarser interval under the
same label is still that range, honestly served — only when no interval answers does the
pair go unsupported. Each rung costs at most one metered request, once, then the learned
choice is cached upstream (remembered per range class with the same ~6 h TTL as the runtime's
learned pairs, so a plan upgrade re-probes the finer interval too).

**Series invariants — every provider's output, enforced at the provider:**

- **strictly ascending, strictly deduplicated time.** lightweight-charts *rejects* `setData`
  with unordered or duplicate times, so this is correctness, not tidiness. It is also a real
  hazard, not a hypothetical: CoinGecko's daily series ends with a live tail point whose UTC
  date equals today's midnight point (verified 2026-08-23: `days=180` → `…22T00:00`,
  `…23T00:00`, `…23T00:12`) — date-string conversion without dedupe ships duplicates. Rule:
  sort ascending, then **keep-last per time value** (the live tail wins over the midnight
  open — it's the fresher price). FMP's intraday/EOD arrays arrive newest-first — sorted
  defensively, never trusted.
- **daily granularity → `d` date strings (UTC date of the stamp); finer → `t` epoch ms** —
  decided per response from the requested granularity, not sniffed from spacing.
- **bounded size.** Area series stride-sample above ~2,000 points (`max` on a long-lived
  listing is ~10k EOD rows). Candles never stride — a skipped candle is silent data loss —
  they **calendar-aggregate**: above ~400 bars, bucket daily bars into ISO weeks, then months
  (o = first open, h = max, l = min, c = last close), the same thing every finance chart does
  at 5y/max zoom. Deterministic buckets, honest OHLC.

### Runtime — `chartSeries` + the learned-availability model

Two integration facts shape this section, both verified in code:

- **`withPluginHealth` records EVERY throw as a structured plugin error**
  ([db.js:1907-1916](../server/db.js#L1907-L1916)) — but a plan gate is the provider
  *answering coherently*, not failing, and must not light the Plugins-page dot. So the
  `tracked()` callback converts an `unsupported` throw into a **marker return value** (health
  sees success — correct: the wire worked), and `chartSeries` unwraps it after. Transient
  throws keep flowing to the ledger unchanged.
- **Learned facts are facts about a (provider, key) pair**, and keys change — an admin who
  pastes a paid key must not wait out a TTL to see 1D come back. The learned map is keyed
  `domain:provider:keyFingerprint` (a short non-reversible hash of the active key, or
  `nokey`), so a key swap lands in a fresh bucket instantly with no coupling to the admin
  routes; the stale bucket dies with the process. The TTL (~6 h) then only has to cover the
  rarer same-key plan upgrade, and the domain prefix keeps two domains' same-named plugin
  providers apart.

```js
// What THIS deployment turned out not to serve:
//   Map<"domain:provider:keyFingerprint", Map<"range|kind", learnedAt>>
// Module-level like screenerDown / the pacing buckets (process lifetime, TTL ~6h,
// test seam reset + an _age seam like _ageScreenerCache). In-memory on purpose:
// it self-heals on restart, and the TTL re-probe resurfaces a pair by itself
// after a plan upgrade — no setting to stale out.
const learned = new Map();

export async function chartSeries(db, conn, entity, source, { range, kind }, depth = 0) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  const decl = conn.manifest?.chart;
  if (!provider.chart || !decl) return null;              // → route 404, face stays
  const bucket = `${conn.name}:${name}:${fingerprint(apiKey)}`; // key swap = fresh bucket
  const alive = (r, k) => !isLearned(bucket, r, k);       // pair-level, TTL-expired = alive
  const kindsFor = (r) => decl.kinds.filter((k) => alive(r, k));
  const ranges = decl.ranges.filter((r) => kindsFor(r).length);
  if (!ranges.length) return null;
  if (!ranges.includes(range))                            // clamp, don't reject: the client's
    range = ranges.includes(decl.defaultRange)            //   stored pref may be stale
      ? decl.defaultRange : ranges.at(-1);
  const kinds = kindsFor(range);
  if (!kinds.includes(kind)) kind = kinds[0];
  const id = name === source?.provider ? source.id : await resolveBySymbol(db, conn, entity.symbol);
  if (id == null) return null;
  // The marker dance: an unsupported throw is converted to a RETURN inside the
  // tracked callback (the provider answered; that IS healthy), so the plugin
  // ledger records a heal, not an error — then unwrapped here as if thrown.
  // A transient throw passes through untouched: ledgered, surfaced as 502.
  const out = await tracked(db, conn, name, provider, () =>
    provider.chart(id, { range, kind }, ctxFor(name, provider, apiKey))
      .catch((e) => { if (e.unsupported) return { __unsupported: true }; throw e; }));
  if (!out?.__unsupported) {
    return out && { ...out, range, ranges, kind, kinds, provider: name,
                    attribution: provider.attribution || null };
  }
  // A refusal is an ANSWER, not an error: learn the exact pair asked, then
  // re-enter with the SAME request — the clamps route around what was just
  // learned (a dead pair falls to the range's other kind, or to the default
  // range). Depth-capped so a fully dead provider costs a bounded probe on
  // one request and finishes discovery lazily on later clicks; exhaustion →
  // null → 404 → the static face.
  learn(bucket, range, kind);
  if (depth >= 3) return null;
  const retry = await chartSeries(db, conn, entity, source, { range, kind }, depth + 1);
  return retry && { ...retry, unavailable: { range, kind } };
}
```

Pair-level learning is the whole trick: it needs no taxonomy of *why* (kind-wide? range-wide?
tier? host?) — each (range, kind) is discovered independently, at most `ranges × kinds` cheap
probes over a deployment's lifetime, and the offer converges to exactly the truth. Because
`learned` is server-side, **every user sees the same controls** — the deployment's real
capability, discovered once, shown to all. Clamped-not-rejected means the echoed
`range`/`ranges`/`kind`/`kinds` self-correct the client in one round trip.

Health: transient failures ride the same `tracked()` ledger as every other provider call, so
a dead chart endpoint lights the Plugins-page dot; a *learned refusal* deliberately does not —
it's the plan working as sold, not a fault.

### Route

```
GET /api/items/:id/chart?range=1y&kind=area        requireAuth + requireEntityAccess
200 { symbol, name, provider, attribution,
      kind, range,          // what was actually served (post-clamp)
      ranges,               // ranges with ≥1 servable kind, as known right now
      kinds,                // kinds servable for THE SERVED RANGE
      time, tz, points,
      unavailable? }        // { range, kind } when a refusal was just learned —
                            // the data is the clamp target's; say so, once, quietly
404 { error }   // not a connector board / no chart capability / id unresolvable / offer empty
502 { error }   // transient provider failure — message verbatim (connector-list pattern)
```

The client renders the range row from `ranges`, the toggle from `kinds`, highlights from the
echoes, and the note from `unavailable` — **everything it draws comes off the response**. It
contains no provider name, no tier, no range table; a provider switch or a learned refusal
reshapes the controls on the next fetch instead of stranding a button that errors forever.
A 401 (session expired) is the plain error state — a passive GET must not trigger the login
redirect the fav button's POST does.

Handler: `getBoard(db, req.entityBoardId)` → `mapping.input.connector` → `getConnector`
(miss → 404); `getEntity` (symbol; `name` in the response is `display_name || symbol`); the
vehicle's provider handle via a new db.js helper `entityVehiclePayload(db, entityId)` —
`SELECT payload FROM items WHERE entity_ids @> ARRAY[$1]::bigint[] AND payload ? 'source'
ORDER BY created_at ASC, id ASC LIMIT 1` (the `dueLiveEntities` join predicate,
[db.js:2266](../server/db.js#L2266), plus the deterministic ordering `entityForAlerts` uses).
No source row → `source: null` → `chartSeries` falls back to symbol resolution, same as a
provider switch. No route-level rate limiter: provider pacing + caches are the guard, per
`connector-list`. Empty-but-served series (`points: []` — a delisted symbol, a dead window)
pass through as 200: absence of data is data; the client renders its "no data for this
range" note (slice 3), and nothing is learned — only an `unsupported` throw teaches.

### Upstream notes — how each bundled backend maps the surface

Implementation detail of the provider modules, with zero architectural weight — recorded so
build time starts from verified facts, not so anything downstream may depend on them. Every
claim below can be wrong for someone's key and the feature still behaves correctly; that is
the point of the capability model.

**FMP (stocks).** One fetch serves both kinds per range (EOD rows and intraday bars both
carry OHLC — the current `history()` throws away everything but close):

| Range | Endpoint | Notes |
|---|---|---|
| `1d` | `/stable/historical-chart/{5min→30min→1hour}` | interval ladder; `from = today−7d`, keep the **last session date** present |
| `5d` | `/stable/historical-chart/{30min→1hour}` | keep the last **5 session dates** |
| `1m 6m ytd 1y 5y max` | `/stable/historical-price-eod/full?from&to` | `ytd` → Jan 1; `max` → `from=1900-01-01`, serves whatever depth the key's plan allows |

Bar timestamps are `"YYYY-MM-DD HH:mm:ss"` US/Eastern → parse with a `Z` suffix
(exchange-as-UTC), `tz: "utc"` — so UTC formatting displays exchange time, which is what
Google shows too. Which plans include intraday varies and is not encoded anywhere: the ladder
plus the refusal signal discover it per deployment, and the interval that answered is
remembered per range class (~6 h, seam-resettable) so later 1d opens skip the dead rungs.
Gate recognition: FMP answers plan gates with **402/403** (429 is rate, 401 is a bad key —
both stay transient). Both intraday and EOD arrays arrive newest-first → defensive ascending
sort per the series invariants; `5y`/`max` candles calendar-aggregate per the same. Cache raw
rows per `symbol|range`, TTL 60 s (intraday) / 5 min (EOD), bounded ~200 entries FIFO — the
`bridgeCache` pattern
([financialmodelingprep.js:440-471](../server/connectors/stocks/financialmodelingprep.js#L440-L471)) —
plus the standard test seam. One cached fetch serves both kinds, so a kind flip is zero HTTP.

**CoinGecko (crypto).** Kind → endpoint; verified live, keyless, **2026-08-23**:

- area → `market_chart?days=N` (any N ≤ the host cap; 289 × 5-min points at `days=1`; hourly
  2–90d, daily above **plus the live-tail point** — see the dedupe invariant) — serves every
  range the host allows with exact day counts, `ytd` included (computed days).
- candles → `ohlc?days=N` where `days` is an **enum** `{1,7,14,30,90,180,365}` (`days=5` →
  HTTP 400 "Invalid days parameter"; 48 × 30-min candles at `days=1`, 92 × 4-day at 365).
  The enum does NOT shrink the range row: a non-enum window fetches the **smallest enum ≥
  the window and trims** to it — `5d` → `days=7` trimmed to 5 (4-h candles), `ytd` → the
  covering enum trimmed to Jan 1. Every ≤365d range serves both kinds.
- The demo/public host caps history at 365 days → `5y`/`max` refuse (synchronously, zero
  HTTP) until the module gains Pro-host support — at which point those buttons light up by
  themselves, nothing downstream touched. Because the enum is respected by construction and
  >365d is never requested, this module needs **no HTTP gate recognition at all** — its only
  refusals are its own synchronous ones (and the >365d 401 the face work discovered stays
  unreachable, which matters: `withRetry` retries 401s).

Separate metered fetches per kind → cached per `id|range|kind`, TTL 60 s (`1d`) / 5 min.
View-time only, ~1 credit per cold open against demo's 10k/month; keyless riders share the
existing 10 rpm bucket and `withRetry` + `throttled` absorb 429 bursts.

**CoinMarketCap (crypto).** Historical quotes exist on its API
(`/v2/cryptocurrency/quotes/historical` — `history()` already uses it,
[coinmarketcap.js:188-218](../server/connectors/crypto/coinmarketcap.js#L188-L218)), and OHLCV
exists as `/v2/cryptocurrency/ohlcv/historical`. The module implements **both kinds**, no
pre-judgment about which tier has what:

- area from quotes/historical — `interval` ladder per range (`5m`→`1h` for `1d`; `1h` for
  `5d`; `1h`→`1d` for `1m`; `1d` above), `count` sized to the window (its documented max is
  10k — never a constraint here);
- candles from ohlcv/historical — `time_period=hourly, interval=1h` for `1d`/`5d` (hourly is
  the finest historical OHLCV CMC offers), `daily` above; both v2 payload shapes handled
  (`data.quotes` and `data[id].quotes`, like `history()`).

Gate dialect: CMC speaks plan refusals as HTTP 400/402/403 with an `error_message` naming the
plan/subscription — recognize **status ∈ {400, 402, 403} + /plan|subscription/i** and throw
`unsupported`; anything else stays transient. Same `id|range|kind` cache + TTLs as CoinGecko.
The stale "CMC has no free equivalent" comment in coingecko.js gets corrected in passing.

---

## Part C — the chart detail renderer (client, Phase 3)

### The library, vendored

- `public/vendor/lightweight-charts.standalone.production.mjs` (v5.2.1) — **self-contained
  ESM** (verified: zero imports; exports `createChart`, `AreaSeries`, `CandlestickSeries`, …),
  198 KB raw / ~50 KB over the wire, canvas-only. Loaded with a memoized dynamic `import()`
  **only when a chart mounts** — non-finance boards never fetch it. Same-origin file satisfies
  `script-src 'self'`, and the repo's own `send`/`mime` maps `.mjs` →
  `application/javascript` (verified against node_modules), so the module import just works.
- `public/vendor/lightweight-charts.LICENSE` (Apache-2.0) rides along (the bundle header also
  retains the notice). **Attribution is the library's own**: v5 ships
  `layout.attributionLogo`, default `true` (verified in typings) — a small TradingView link
  rendered on the chart itself, which is their canonical form. We leave it on; our footer
  line then carries only the DATA credit ("Data by {provider}", from the response's
  `attribution` — CoinGecko's ToS obligation).

API surface verified against the package's `typings.d.ts` (2026-08-23), since the renderer is
written against it: v5 series creation is `chart.addSeries(CandlestickSeries, opts)` (not
v4's `addCandlestickSeries()`); `removeSeries` for the kind flip; **`autoSize: true`** runs
the library's own ResizeObserver (no manual resize plumbing; panel-open reflows just work);
`series.createPriceLine` for the prev-close dash; `subscribeCrosshairMove` hands
`param.seriesData: Map<series, point>` for the readout; `localization.timeFormatter` /
`localization.priceFormatter` + `timeScale.tickMarkFormatter` for label control;
`priceFormat: { precision, minMove }` per series; `Time` accepts `'YYYY-MM-DD'` strings
(business days) and UTC-second timestamps — exactly the wire's `d`/`t` split.

### Matching + anatomy

```js
matches: (inst, entity) =>
  entity.symbol &&
  state.boardMapping?.face?.source === "connector" &&
  state.boardMapping?.face?.producer === "chart" &&
  inst?.id === entity.instances?.[0]?.id        // the vehicle only; attached file
                                                // instances keep their own renderers
```

```
┌──────────────────────────────────────────────┐
│ INTC · Intel Corp.        $90.07  +4.31% 1M  │  header: last price + range delta (±color, signed)
│ ┌──────────────────────────────────────────┐ │
│ │            chart canvas                  │ │  static face <img> underneath until first
│ │   (area gradient / candles + crosshair)  │ │  data lands; kept on error/unsupported
│ └──────────────────────────────────────────┘ │
│      [ Area | Candles ]  1D 5D 1M 6M YTD 1Y… │  controls rendered from response.kinds/.ranges
│         Data by Financial Modeling Prep ·    │  quiet attribution incl. TradingView link
└──────────────────────────────────────────────┘
```

Two visual states, one structure (`wrap = header / media-area / controls`, `cursor: default`,
click-stopPropagation on the whole wrap — the stage around it still closes):

- **Base state** — the static face `<img>` fills the media-area (`object-fit: contain`;
  skipped entirely when the vehicle is a tile, `kind: "connector"` — there is no file, and a
  guaranteed-404 src is noise; `onerror` hides it either way, which also covers the
  live-face-regen-deleted-the-file case). This is what *loading*, *transient-error*, and
  *no-capability* all show. The 404 case additionally hides header + controls — bare image,
  exactly today's view. The lightbox root's existing `.loading` spinner class covers the
  first fetch, image-renderer style.
- **Chart state** — data landed: img hidden, canvas shown, header filled. `< 2` points is
  the empty state: base img stays, a quiet "No data for this range." note. Transient errors
  note the provider's message with the controls still live (any range click retries); a
  response carrying `unavailable` gets one quiet line ("1D isn't available from this data
  source") — the rebuilt controls simply no longer offer it.

- Controls rebuild from every response (`ranges` → row, `kinds` → toggle, toggle hidden when
  only one kind; highlights follow the echoed `range`/`kind`, so a server clamp self-corrects
  the UI silently). Range flips keep the mounted chart and `setData` on arrival — the
  media-area dims (~0.65) while in flight, stale responses dropped by token, the in-flight
  fetch aborted (AbortController) on the next flip and on unmount. A kind flip is
  `removeSeries` + `addSeries` (the two series types carry different options/price lines).
  Entity nav: teardown + remount. `unmount()`: abort + `chart.remove()` (autoSize's observer
  dies with the chart).
- Prefs: `localStorage` remembers kind + range globally (Google-style continuity). First open
  seeds from the board's face period (`24h→1d, 7d→5d, 30d→1m, 90d→6m, 1y→1y, 5y→5y`, else
  `1y`); anything stale self-corrects via the server clamp + echo.

### Chart config (dataviz-pass applied)

Single series, so: no legend; crosshair + readout is mandatory; axes recessive; text in ink
tokens, color only on the marks and the signed delta.

- Colors follow the face producer's own convention ([price-chart.js:32](../server/faces/price-chart.js#L32)):
  up `#16a34a`, down `#dc2626`, chosen by net range direction for area (line + 16%→0 gradient,
  width 2, re-applied per fetch via `series.applyOptions`); candles fixed up/down. Grid
  `#f0f0f2`, tick text the app's muted gray, right-hand price scale, no scale borders.
- **Formatting rule**: custom time formatters exist ONLY for `intraday + tz:"local"` (crypto —
  real epochs shown on the viewer's clock via `toLocale*String`). Everything else rides the
  library defaults, which format in UTC — exactly right for `tz:"utc"` exchange-encoded bars
  and for date-string daily data. `timeScale.timeVisible = (time === "intraday")`.
- **Price precision is data-derived**: a `precisionFor(maxPrice)` picks
  `priceFormat.precision`/`minMove` (2 for ≥$1, more significant digits as prices shrink —
  sub-cent coins must not render "$0.00"), and one `Intl.NumberFormat` built from the same
  precision feeds `localization.priceFormatter`, the header, and the readout — three surfaces,
  one number style.
- Readout: small fixed div updated from `subscribeCrosshairMove` — the point comes off
  `param.seriesData.get(series)` (`{value}` area / `{open,high,low,close}` candles), hidden
  when `param.time` is undefined. `textContent` only.
- `handleScroll/handleScale` off, `autoSize: true`, `fitContent()` after each `setData`.
- The chart **header derives from the series** (last point, range delta vs first) — never
  from `entity.fields`, which delta polls mutate under the open lightbox (see Blast radius).
- Prev-close dashed line (`createPriceLine`, dashed gray, no axis label) on `1d` **when the
  entity carries `price` + `change_1d` fields** — presence of `change_1d` is itself the
  domain-agnostic signal (crypto's rolling `change_24h` never qualifies, correctly, since its
  baseline IS the first point); pure client-side derivation, never load-bearing.

### Files touched

| File | Change |
|---|---|
| `public/index.html` | stage container replaces the three fixed content nodes |
| `public/lightbox.js` | `showMedia` → registry dispatch; det-overlay reads `handle.imgEl`; chrome unchanged |
| `public/detail-view.js` | **new** — registry + image/doc/audio renderers |
| `public/detail-chart.js` | **new** — the chart renderer |
| `public/vendor/…` | **new** — vendored lib + license |
| `public/styles.css` | id→class fixes; `.lb-chart-*` block (controls reuse the app's pill/ghost idiom) |
| `server/connectors/stocks/index.js` | `manifest.chart` vocabulary |
| `server/connectors/crypto/index.js` | `manifest.chart` vocabulary |
| `server/connectors/stocks/financialmodelingprep.js` | `chart()` + cache + seam |
| `server/connectors/crypto/coingecko.js` | `chart()` + cache + seam; fix the stale "CMC has no history" comment |
| `server/connectors/crypto/coinmarketcap.js` | `chart()` (quotes + OHLCV) + cache + seam |
| `server/connectors/runtime.js` | `chartSeries()` + learned availability (+ seam) |
| `server/connectors/index.js` | bind `chartSeries` |
| `server/db.js` | `entityVehiclePayload()` |
| `server/server.js` | the route |
| `test/chart.test.js` | **new** (below) |
| `README.md` | feature note |

## Blast radius — every surface this touches, checked

The integration facts a lightbox refactor + a new stage type actually meet, verified in code:

- **Deep links.** `?item=` (alert links, [app.js:163-181](../public/app.js#L163-L181)) opens
  the lightbox straight from boot — the chart renderer must mount on that path too. It does:
  same `openLightbox`, and `state.boardMapping` is stamped before items land.
- **Keyboard.** `shortcuts.js` gates grid shortcuts on `#lightbox.hidden` — the root element
  and its id survive the refactor. The lightbox's own ArrowLeft/Right still navigate entities
  while a chart is up (today's image behavior; range buttons are focusable `<button>`s and
  Enter/Space operate them).
- **Delta polling vs the open lightbox.** `app:render` never repaints an open lightbox, and
  `reconcile()` **mutates the held entity in place** — `fields`/`instances`/face name follow
  deltas silently ([data.js:71-118](../public/data.js#L71-L118)). Two consequences, both
  designed for: the chart **header derives from the series, not `entity.fields`** (no torn
  reads mid-refresh), and the static base `<img>` may 404 mid-view on a live-face board (the
  regen deletes the old filename — the known behavior data.js's slow poll exists to bound).
  The base img hides on error; the live chart doesn't depend on the static file at all, which
  strictly improves today's failure mode.
- **Rows mode.** Instance tiles open via `openLightboxAt(img, instId)`
  ([rows.js:274](../public/rows.js#L274)) — the chart matches only the vehicle
  (`instances[0]`); any other instance falls through to the file renderers.
- **Crate popover + fav.** Anchored to chrome (`#lightbox-crate`), listens on
  `app:lightbox-crate-changed` — chrome is untouched.
- **CSS.** Exactly four id selectors migrate to classes (`#lightbox-doc`, `#lightbox-audio`,
  `#lightbox-audio-wave`, `#lightbox-audio-el`, styles.css 1628-1665); the `.lightbox img`
  base rule and all `.lbp-*`/`.lb-det-*`/nav/controls/panel rules are chrome and stay put.
  The transcript div's inline styles ([index.html:38](../public/index.html#L38)) move into
  the audio renderer. The `.lightbox.loading::after` spinner stays keyed on the root class.
- **Other pages.** boards.html / admin / logs never load the lightbox — gallery-only surface.
- **`capabilities.js` is not this.** That registry is AI capabilities (tag/extract/embed/…);
  connector domain state is the separate plugins `slots.domains` ladder, and per-provider
  face availability already flows through `renderableFaces` on `/api/connectors`. The chart
  capability needs no registry row; annotating it into the mapping modal's availability hints
  is deferred.
- **Worker untouched.** The refresh sweep, face leg, and `field_snapshots` writer don't change
  — the chart is view-time only. No migration; no schema change.
- **Deploy.** Single image, `COPY . .`, express serves `STATIC_DIR` with `cacheControl:
  false` — the vendored lib ships and revalidates like every other frontend asset (the
  immutable 7-day caching is `/gallery`+`/thumbnails` only).
- **Client item shape.** `toItem` keeps `symbol` + entity `fields`
  ([utils.js:39](../public/utils.js#L39), [:60](../public/utils.js#L60)) — everything
  `matches()` and the prev-close derivation need is already shipped.

## Tests (`test/chart.test.js`, house patterns: stubbed `globalThis.fetch`, `startServer`)

- **FMP `chart()`**: 1d keeps only the last session's bars from a multi-day 5-min stub (shape
  `date/open/high/low/close`, served newest-first — asserts the defensive sort); a 402/403
  on 5-min ladders to 30-min (assert via the `seen` URL list) and the winning interval is
  remembered (second call = one request, no dead rung); EOD range maps closes vs OHLC from
  one stubbed fetch (kind flip = no second HTTP); `max` stride-samples area >2000 points and
  calendar-aggregates candles >400 bars (weekly buckets, o-first/h-max/l-min/c-last); 401
  does NOT ladder (bad key ≠ gate); timestamps parse exchange-as-UTC; cache TTL honored via
  seam reset.
- **CoinGecko `chart()`**: area hits `market_chart` with exact days (`ytd` computed), candles
  hit `ohlc` with the covering enum day and **trim to the window** (`5d` → days=7 trimmed to
  5); verified array shapes (`[t,o,h,l,c]` / `[t,p]`); daily granularity → `d` strings with
  the **live-tail dedupe** (a `…T00:00` + `…T00:12` same-day pair collapses to the tail —
  the verified 2026-08-23 shape); intraday → `t` epochs strictly ascending; `5y`/`max`
  refuse as `unsupported` with zero HTTP; per-kind cache keys.
- **CMC `chart()`**: area from quotes/historical with the interval ladder, candles from
  ohlcv/historical (`time_period=hourly` for `1d`); both v2 payload shapes (`data.quotes`
  and `data[id].quotes`); a 403+"plan" stub on OHLCV refuses `unsupported` while quotes
  still serve; a 500 stays transient.
- **`chartSeries`**: no `chart` export / no `manifest.chart` → null (a bare stub provider);
  foreign range clamps to `defaultRange` and echoes; kind clamps within the served range and
  echoes `kinds`; provider-switch entity re-resolves by symbol (the `resolveBySymbol` path).
- **Learned availability (pair-level)**: an `unsupported` throw on `(1d, area)` → response
  carries the clamp target's data + `unavailable: {range:"1d", kind:"area"}` + `ranges`
  without `1d` (when both kinds are dead) / `kinds` without the dead flavour; the next call
  never touches the provider for that pair; a plain throw learns **nothing** and 502s; the
  depth cap bounds discovery on a fully-dead provider (null → 404); `_age` seam expiry
  re-probes; per-provider isolation (gating one provider's pair leaves its sibling's row
  intact); **a changed apiKey lands in a fresh bucket** (the fingerprint — the key-swap
  instant-heal); **an `unsupported` outcome writes a plugin HEAL, not an error**
  (`getPluginRow` asserts the ledger after the marker dance), while a transient throw still
  writes the structured error; seam reset restores a clean slate per test.
- **Route**: 401 unauthenticated; 404 cross-board member, non-connector board, and a
  chartless provider (a stub domain, like the runtime tests' widgets/gauges); 200 happy path
  (stub provider installed via `installConnectors`, entity + vehicle seeded like
  [connectors.test.js:186](../test/connectors.test.js#L186)) asserting the full wire
  contract; 502 on a transient throwing provider with the message preserved.
- Client stays untested per repo convention → the Phase 1 checklist + Verify below.

## Verify (live, dev stack)

1. Stocks board → open INTC → static face swaps to the live area chart; header price ≈ card
   price field; range delta signed + colored.
2. Flip every range; flip Area↔Candles; controls highlight follows; no lightbox close on any
   control click.
3. Gated ranges (whatever this key's plan refuses): correct behavior is EITHER live data
   (possibly at a ladder-coarsened interval) OR the clamp target's data + the one-line note,
   with the dead pair gone from the controls on the next open **for every user**. Verify the
   mechanism, not the tier: all outcomes pass.
4. Crypto board (CoinGecko) → `1d` = 5-min area / 30-min candles; `1y` candles = 4-day bars;
   `5d`/`ytd` offer area only; `5y`/`max` absent (refused upstream); attribution shows
   "Data by CoinGecko".
5. Plugins → switch crypto to CoinMarketCap → reopen: same range row, kinds per what the key
   serves (candles present iff OHLCV answers); a stored pref for a dead pair silently lands
   on the nearest served one; switch back to CoinGecko → controls follow.
6. Keyless CoinGecko: flip ranges fast → paced, eventually-served, no crash (429 path).
7. Regression sweep: image board (det-overlay hover/resize), pdf/docx (focus, inline render),
   audio (transcript, pause on nav/close), multi-instance switcher, arrows/Esc/click-out,
   download names.

## Phases

1. **Registry refactor** — behavior-frozen; checklist verified; ships alone.
2. **Server capability** — manifest vocabulary + providers + runtime + route + tests;
   verifiable by curl, dark.
3. **Chart renderer** — vendor + renderer + styles; the visible feature.

## Status

**Phase 1 implemented 2026-08-23** — awaiting the hand-verify regression checklist (Verify
step 7) before phase 2 starts. What landed, exactly as planned above:

- `public/detail-view.js` (new): the registry + the three renderers extracted verbatim from
  `showMedia`'s branch chain — audio (player/waveform/transcript + stale-token fetch, full
  detach on unmount), doc (docx `.html` sidecar, focus recapture on load), image (fade-in,
  `loading` class, alt-from-tags, catch-all).
- `public/lightbox.js`: `showMedia` is now the six-line mount/unmount dispatch; the fixed
  img/doc/audio element consts, `hideAudio`, and `showAudioText` are gone; the det-overlay
  positions against `currentHandle.imgEl`; `closeLightbox` resets via `unmount` + stage clear.
- `public/index.html`: the three fixed content nodes → one `#lightbox-stage`; the transcript
  div's inline styles moved to the sheet.
- `public/styles.css`: `.lightbox-stage` (fills + re-centers the content box so renderer
  `max-*:100%` keeps its old meaning); the four id selectors → classes;
  `.lightbox-audio-transcript` carries the former inline styles.

Checked: no stale references to the removed ids/consts anywhere in public/ or test/;
`node --check` passes on both touched modules; chrome (nav/fav/crate/panel/overlay/shortcuts
gate on `#lightbox`) untouched.

**Phase 2 implemented 2026-08-23** — the full suite is green (1204 tests, 22 of them the new
`test/chart.test.js`). Everything as planned above, one addition:

- `server/connectors/chart-series.js` (new, not in the original file table): the series
  invariants as pure shared functions — `unsupported()` (the one refusal signal),
  `dedupeAscending` (keep-last; the live-tail rule), `strideArea`, `aggregateCandles`
  (ISO-week → month calendar buckets) — imported by all three providers rather than
  triplicated.
- `manifest.chart` on both domains (full Google row, both kinds, `defaultRange: "1y"`).
- Provider `chart()` ×3: FMP (intraday ladder 5min→30min→1hour with a remembered rung,
  EOD for the rest, one cached fetch serving both kinds, 402/403 = gate, 401 = transient);
  CoinGecko (exact-days area, covering-enum + trim candles, zero HTTP refusals past the
  365-day host cap, no HTTP gate recognition by construction); CMC (quotes ladder + OHLCV,
  gate = status ∈ {400,402,403} + /plan|subscription/i). Per-provider `_resetChartCache` /
  `_ageChartCache` seams.
- `runtime.chartSeries` + the learned model exactly per the sketch (bucket =
  `domain:provider:keyFingerprint`, TTL 6 h, marker dance through `tracked()`, depth-capped
  re-entry, `_resetChartLearned`/`_ageChartLearned` seams); bound in the registry;
  `entityVehiclePayload` in db.js; the route in server.js.
- Tests cover the whole matrix in the Tests section, including: the ledger heals on a
  refusal and marks on a transient; a swapped key probes again instantly; a dead pair is
  never re-probed inside the TTL; the depth cap; the clamp echoes; the route's auth/ACL/
  contract/502.

**Phase 2 consolidation pass, same day** (suite green at 1207 — 25 chart tests). A review
sweep over the fresh code found two holes and three duplications, all fixed:

- **Sync-throw hole**: a plugin provider whose `chart` isn't `async` would throw *before*
  the marker `.catch` attached — the refusal would have been ledgered as a provider error
  and 502'd. `Promise.resolve().then(() => provider.chart(…))` closes it; pinned by test.
- **Discovery re-resolution**: the recursive re-entry re-ran `activeProvider` and — for
  switched-provider entities — a *metered* `resolveBySymbol` per attempt. `chartSeries` is
  now a bounded loop: one resolution, one provider read, `unavailable ??=` keeps the first
  refusal, and the `{__unsupported}` marker object became a module `REFUSED` symbol.
- **Triplicated machinery → chart-series.js**: `createTtlCache` (the bounded TTL+FIFO cache
  all three data caches and both ladder-rung memories now share — the `createQuoteCache`
  precedent), `ytdDays` (was copied CG/CMC), and `encodeArea`/`encodeCandles` — the complete
  per-kind encode pipelines, so a provider *can't* half-apply the invariants (the
  browseFilters-normalize argument). FMP's EOD path is the one deliberate exception: its
  rows are date-native, forcing them through epoch-based encoders would invent timestamps.
- CMC's `history()` now shares `quoteRows` instead of its own copy of the two-shape unwrap.
- Coverage added: FMP `5d` keeps exactly the last five sessions; CMC's month-scale area
  ladder falls hourly→daily and switches to date-string encoding; the sync-throw case.

**Phase 3 implemented + LIVE-VERIFIED 2026-08-23** (suite green at 1208 — 26 chart tests).

- Shipped: `public/vendor/` (lightweight-charts 5.2.1 standalone ESM + LICENSE),
  `public/detail-chart.js` (the renderer, exactly per Part C), registration in
  `detail-view.js`, the `.lb-chart-*` styles block, the README feature bullet.
- **Live provider matrix, real keys** (the app's own): FMP — this plan DOES serve intraday
  (1d = 78×5-min bars first rung, 5d = 65×30-min across exactly 5 sessions, `max` reaches
  2006 and calendar-aggregates to 239 candles). CoinGecko — 1d 289×5-min, 5d candles trimmed
  to 30×4-h, 1y daily with the live-tail dedupe landing on one row per date, 5y refuses
  cleanly. CMC — 1d area serves at 5-min; **OHLCV is plan-gated → clean `unsupported`**, the
  learned model's first real-world catch.
- **Live end-to-end through the rebuilt container**: full wire contract on INTC 1d; bogus
  `range=7w&kind=heikin` clamps to `1y/area`; BTC 1y candles = 92 four-day bars with the
  CoinGecko attribution; no-session 401; the vendored `.mjs` serves as
  `application/javascript` (197,827 B); the stage is in the served index.html.
- **A live-caught runtime bug, fixed + pinned**: requesting `5y area` on the crypto board
  served `1y candles` — the discovery loop's intermediate probe (5y's surviving kind) had
  mutated the requested kind permanently. Range and kind are now re-derived from the
  ORIGINAL request each iteration, so the asked kind wins again the moment the fallback
  range serves it. Live re-verified after the rebuild: `5y area` → `1y area`, 365 points,
  `unavailable: {5y, area}`, ranges without `5y`.

**Phase 3 review pass, same day** — a trace of the renderer's cross-render and cross-module
interactions (~50 checked) found one real bug and two small gaps, all fixed and redeployed:

- **Formatter state-leak** (the real one): the tick formatter was applied per render with
  `tickMarkFormatter: undefined` as the "reset" — but the library's option merge skips
  undefined, so after viewing crypto's 1d (epoch formatter installed) any daily range on the
  same mount would feed BusinessDay objects into the stale epoch formatter and print
  "Invalid Date" axis labels. Fixed the way the library intends (verified in typings:
  returning `null` falls back to the default): ONE formatter installed at creation, closing
  over the mount's `shape`, custom only for crypto-intraday, `null` otherwise.
- **Bare mode on a tile vehicle** was a blank white box (no face file exists to show) — now
  gets the card's symbol treatment (`.lb-chart-tile`).
- Kind/range buttons carry `aria-pressed`.

Checked and fine, for the record: the download button and panel still work off the vehicle
instance untouched; the det-overlay stays hidden (no `imgEl` on the chart handle); the
mid-reconcile entity-as-inst fallback fails the matches() gate safely; token/abort vs
unmount ordering; the empty→data→error state transitions; prefs echo; spread/stack limits on
`precisionFor`; `.lightbox img` specificity for the base face.

**Simplification pass (4 parallel review agents: reuse / simplification / efficiency /
altitude), same day** — 37 raw findings, ~20 applied after dedup; suite green (1208),
redeployed. The substantive ones:

- *Altitude*: FMP's unmapped-EOD-range fallback silently served 1y data under a future
  range's label, bypassing the refusal model — now refuses like the siblings (test-pinned);
  the client's `matches()` no longer hardcodes the face-producer name (the route's 404 →
  bare mode IS the client's capability discovery); the `unavailable` note speaks the KIND
  when the refusal was kind-level (the CMC OHLCV case read self-contradictory before);
  the freshness policy (live/settled/learn TTLs) lives once in chart-series.js, shared by
  both providers' rung memories and the runtime's learned pairs.
- *Reuse*: `walkLadder` extracted (FMP + CMC had two divergent copies of
  descend-and-remember); the runtime's learned map now IS a `createTtlCache`;
  `resolveProviderId` unifies the id-resolution triple (refresh/faces/chart);
  CG's `marketChartPrices` and CMC's `quoteHistoryPoints` serve both `history()` and
  `chart()`; FMP's `ymd` twin of `utcDate` deleted; the client delta reuses `fmtPercent`,
  the up/down colors reuse `.cb-up`/`.cb-down`, the active range takes `var(--pill-active)`.
- *Efficiency*: the route's three DB reads run in one round-trip; the crosshair readout and
  tick marks use per-render prebuilt `Intl.DateTimeFormat`s (no construction per mousemove);
  FMP memoizes each kind's encode on the cache entry (a hit is a lookup, not a ~10k-row
  re-aggregation); expired TTL-cache entries free at first touch; the render's price
  ceiling is a loop, not a flatMap+spread.
- *Simplification*: CMC's twin 16-thunk config tables → one daily-count map + two small
  builders; one `pill()` builds both control rows with `aria-pressed` as the single state
  channel (CSS styles the attribute); range/kind labels derive (`labelFor`) instead of a
  table; dead `[hidden]` CSS rules, dead initializers, the decorative `Promise.all`, the
  audio token, the handle `name`, and assorted unreachable fallbacks removed.

Skipped, with reasons: hoisting `keyFingerprint` to share with the AI stack's `aiKeyBucket`
(different subsystem, out of this feature's scope — noted as parallel idioms); a shared test
`response()` helper (would drag db-flavoured helpers into a pure unit-test file); full
`.pill` class adoption for the chart controls (the quieter look is deliberate — took the
color token instead); reusing the card's `.connector-face` for the bare tile (would need
size overrides amounting to new CSS anyway — fixed the overclaiming comment instead).

**Post-ship review pass 2026-08-23** — an independent re-read of the shipped code against
this plan and the project's conventions. The architecture held everywhere it was probed;
three real gaps surfaced, all in the learned-state corners, all fixed (suite green at 1210 —
28 chart tests):

- **The ladder memory never expired under use.** `walkLadder` re-stamped the winning rung's
  TTL on every successful reuse, so an actively-viewed chart kept its gate-coarsened interval
  forever — the plan-upgrade re-probe that the shared-TTL note in chart-series.js explicitly
  promises ("only works if both expire together") could never fire, because the runtime's
  pairs are written only on refusal while the rung memory rewrote itself on every win. The
  memory is now written only when the winner CHANGES; an unchanged rung ages out on schedule
  and the finest rung is probed again (~1 metered request per 6 h). Pinned by a mutation-
  verified test (age 4 h → reuse → age 3 h → the finest rung must be re-probed).
- **The ladder memory ignored key swaps.** The runtime buckets learned pairs per key
  fingerprint precisely because "learned facts are facts about a (provider, key) pair" — but
  both providers' rung memories were keyed by range alone, so a pasted paid key re-probed the
  pairs instantly yet kept serving 1d at the old key's coarse interval. `keyFingerprint`
  moved into chart-series.js (the same shared-home argument as the freshness policy: both
  halves of the learned state must key the same way) and both ladder call sites now compose
  it into the memory key. Test-pinned alongside the TTL case.
- **A failed range flip left a dead pill.** The pill guard compares against the REQUESTED
  range, which a transient failure leaves pointing at the flip that failed while the controls
  still highlight what's on screen — clicking the same range again did nothing, against Part
  C's "any range click retries". The renderer now keeps the last successful echo (`served`)
  and reverts `range`/`kind` to it on failure, so internal state always mirrors the
  highlighted controls and the failed pill retries. (Client untested per repo convention.)
- Coverage the Tests section enumerated but the file lacked, added: the `_ageChartCache`
  seam (an expired data-cache entry is re-bought, not served stale) and per-provider learned
  isolation (a sibling provider probes a gated pair fresh; the original's learned pair
  survives a switch away and back).

Left as-is, judged fine on the closer look: the data caches stay un-fingerprinted (up to one
short TTL of old-key data after a swap — data is data); bare mode frames the face in the
media box rather than free-floating ("exactly today's view" was mildly overstated, cosmetic);
`dedupeAscending`'s keep-last assumes append-order sources, which holds for every current
provider; CoinGecko's `ytd` refuses on Dec 31 of a leap year (366 > 365) and clamps to the
materially identical 1y.

Remaining for the operator: the visual sweep (Verify steps 1–7) in a browser — the stack at
`localhost:8001` now runs all three phases with both review passes' fixes.

## Decisions

- **Full surface everywhere, discovery prunes.** Domains declare the complete Google-parity
  control surface; providers refuse per (range, kind) — plan gates and unimplemented mappings
  through one signal; the runtime learns pairs with a TTL; the client renders only what the
  response offers. No tier knowledge outside provider modules, no configuration, and
  capability growth (an upstream module upgrade, a plan upgrade) lights controls back up with
  no downstream changes.
- **Attribution**: the existing convention extended — one quiet line, `Data by {provider}`
  from the response's `attribution` (already a provider declaration the browse modal renders),
  plus the TradingView link the library's license requires. Nothing hardcoded per provider.
- **prev-close dashed line**: on `1d` when `price`/`change_1d` are present on the entity —
  pure client-side derivation, zero cost, never load-bearing.
