// Connector runtime — the domain-agnostic machinery every connector shares.
// A connector module is pure data: a `providers` map, a `defaultProvider`, and
// a `manifest`. The dispatch below is generic over a descriptor
//   conn = { name, providers, defaultProvider }
// so adding a domain (stocks, movies, …) is a directory of data with no edits
// here. Two layers by design — domain → provider — mirroring the AI tagger.
//
// Settings are namespaced by the connector's own name, so domains never collide:
//   <name>_provider           active provider (unset/unknown → defaultProvider)
//   <name>_key_<provider>      that provider's API key (its own slot; no bleed)
import { getSetting, getPluginRow, withPluginHealth, APP_SCOPE } from "../db.js";
import { meterSpend } from "../metering.js";
import { getFaceProducer } from "../faces/index.js";
import { acquire, throttled } from "../provider-pacing.js";
import { createTtlCache, keyFingerprint, CHART_LEARN_TTL } from "./chart-series.js";
import { liveFields, nextRefreshAt } from "./schedule.js";

const providerKey = (db, conn, name) => getSetting(db, `${conn.name}_key_${name}`);

// A finite number, or null. The one rule every provider needs and all three
// had written for themselves: a market API's "", 0-for-missing and garbage are
// ABSENCE, not measurements, and a field that reads 0 when it means "no
// reading" is the kind of wrong that looks right on a card.
export const num = (v) =>
  v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

// Plugin-registry state for one provider: install flag + config overrides
// (rpm/burst). Read straight off the plugins row. Connectors are never core or
// pre-installed (only the flagship AI provider is), so an absent/NULL row means
// the provider is AVAILABLE — not usable until added. activeProvider only runs
// for boards that already added a provider, so a live board keeps working.
async function pluginRowState(db, conn, name) {
  const row = await getPluginRow(db, `${conn.name}:${name}`);
  return { installed: row?.installed ?? false, config: row?.config || {} };
}

// --- per-provider rate limiting + 429 backoff ---
// Token-bucket pacing lives in provider-pacing.js (shared with the AI wire, so
// both throttle the same way). The bucket key here is the connector provider
// name; rpm/burst come from the provider descriptor (+ the Plugins-page override
// merged in activeProvider). On a 429 the call is retried below, honoring
// Retry-After capped at 30 s — these sleeps run inside the worker's single-flight
// tick, so a provider asking for an hour must not be taken at its word; long
// waits belong to the queue's spaced retry_at, not here.
const DEFAULT_RPM = 30, DEFAULT_BURST = 15;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 and — for tiers like CoinGecko's demo key — 401 both signal "slow down"
// (the key is valid; it's rate). Retry either, honoring Retry-After up to the
// cap (env-tunable so tests don't wait it out).
//
// The retry is only half the answer, and used to be the whole of it: re-sending
// at the same pace means the NEXT call is refused too, and a provider that
// counts failed requests against its quota (CoinGecko) charges for every one.
// So tell the bucket as well — `throttled` halves that key's effective rate,
// which is what turns a descriptor's rpm from a guess we're stuck with into a
// starting point. `key` is the bucket key (the provider name), so it lands on
// the same bucket paceFor spends from.
const RATE_STATUS = new Set([429, 401]);
async function withRetry(fn, key, tries = 3) {
  const cap = Number(process.env.CONNECTOR_RETRY_CAP_MS) || 30000;
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (!RATE_STATUS.has(e?.status)) throw e;
      // Retry both, but only let a 429 move the bucket. 401 is retried here
      // because CoinGecko's demo tier has answered rate limits with it — it is
      // far more often just a bad key, and throttling a whole provider for that
      // punishes every board for a problem no amount of slowing down fixes
      // (and a permanently-bad key would pin the penalty at its floor).
      if (e.status === 429) throttled(key); // even on the attempt we're giving up on
      if (i >= tries) throw e;
      const ra = e.retryAfter != null ? Number(e.retryAfter) : null;
      await sleep(Math.min(Number.isFinite(ra) ? ra * 1000 : 500 * 2 ** i, cap));
    }
  }
}

// Outbound deadline for provider HTTP calls. Node's fetch has no total bound —
// undici caps response headers at ~5 min and a trickling body never times out —
// and one hung connector call wedges the whole single-flight worker tick.
// Two budget classes, because one number can't serve both: the default
// (interactive) covers price/search calls that answer in seconds and must
// fail fast; "bulk" covers a provider's catalog computations (FMP's
// company-screener measured a flat ~15 s in 2026-08 and sub-second when
// re-measured 2026-08-13 — planning/connector-full-catalog.md; the class
// stays because the budget is a hang detector, priced for the slow days),
// where the generous ceiling binds only on a true hang. The PROVIDER picks the class per call
// site — only it knows which of its HTTP calls is a bulk compute; logical
// entry points don't map 1:1 to requests. The runtime owns the values.
export const providerBudgetMs = (kind) =>
  kind === "bulk"
    ? Number(process.env.CONNECTOR_BULK_TIMEOUT_MS) || 60000
    : Number(process.env.CONNECTOR_TIMEOUT_MS) || 15000;
export const providerSignal = (kind) => AbortSignal.timeout(providerBudgetMs(kind));

// One provider's token acquisition, with the merged rpm/burst (env overrides
// CONNECTOR_RPM/CONNECTOR_BURST let the test harness run unthrottled — its
// provider calls are stubbed, so pacing would only add wall-clock delay).
//
// Also the METER (metering-plan.md Stage 5d), because a granted token IS a
// request about to be sent, and this is the one place both pacing modes reach
// it: the legacy pre-acquire in callProvider and the ctx.pace() a
// request-pacing provider awaits per raw fetch. A quota is spent by requests
// SENT — a retried attempt and a refused one cost the same as a success — so
// counting anywhere later would count answers instead.
//
// The write cannot outrun the thing it counts: a token is what the bucket
// hands out at rpm/min, so one write per token is bounded by the provider's
// own rate limit rather than by how hard a sweep pushes.
//
// APP SCOPE, always. Some callers know a board (refresh, faces) and some
// don't (search, testConnection) — but prefetch batches up to 100 ids that
// span boards into ONE request, deliberately, and dividing that request
// between them would be apportionment. Stage 5a could partition the embed
// sweep per board because splitting the batch cost nothing; splitting this one
// would destroy the reason it exists. So no row claims a board rather than
// some rows claiming one.
const paceFor = (db, name, provider) => {
  const rpm = Number(process.env.CONNECTOR_RPM) || provider.rpm || DEFAULT_RPM;
  const burst = Number(process.env.CONNECTOR_BURST) || provider.burst || DEFAULT_BURST;
  return async () => {
    await acquire(name, rpm, burst);
    // Never throws (meterWrite) — the cardinal rule: a metering blip must not
    // read as a connector failure to the sweep, the preview, or the health row.
    await meterSpend(db, APP_SCOPE, { capability: "api", provider: name }, { api_requests: 1 });
  };
};

// Rate-limited + 429-retried provider call. Exported for tests.
//
// Pacing has two modes. Legacy: one token per ATTEMPT, acquired here — blind to
// what the provider actually does inside one (a cache-served list() pays for
// zero HTTP; fetchEntity pays one token for a three-request fan-out). A
// provider that declares `pacesRequests = true` is finer-grained: it awaits the
// threaded ctx.pace() before EACH raw request instead, so cache hits cost
// nothing and fan-outs pay full fare.
//
// Per ATTEMPT, not per logical call, is a fix Stage 5d's metering surfaced. The
// acquire used to sit outside withRetry, which meant a legacy retry re-sent
// while spending nothing — and worse, unpaced: `throttled` halves the bucket on
// a 429 (see the note above it), but with no acquire in the loop that halving
// only bound the NEXT logical call. The one call that just provoked the refusal
// re-sent at full speed, which is the exact failure that note says the throttle
// exists to prevent. Inside the loop, both modes now agree that a quota is
// spent by what was SENT.
//
// AbortSignal.timeout rejects with a bare DOMException ("The operation was
// aborted due to timeout") — no provider name, no status. Rewrap it readably
// for every surface that shows provider errors verbatim (preview toast, job
// log, plugins health row). Still status-less, so withRetry above never
// retried it and callers treat it as a plain failure. Providers may pre-wrap
// with more context (FMP names the endpoint); this is the floor.
export function callProvider(db, name, provider, fn) {
  const pace = paceFor(db, name, provider);
  const attempt = provider.pacesRequests ? fn : async () => { await pace(); return fn(); };
  return withRetry(attempt, name).catch((e) => {
    if (e?.name === "TimeoutError") throw new Error(`${name}: request timed out`);
    throw e;
  });
}

// callProvider under the shared plugin health ledger: outcomes (post-retry)
// land on the provider's plugins row (structured error or heal), feeding the
// Plugins page dot and, later, the self-healing loop.
const tracked = (db, conn, name, provider, fn) =>
  withPluginHealth(db, `${conn.name}:${name}`, () => callProvider(db, name, provider, fn));

// Resolve the active provider + its key. An unset or unknown provider name
// falls back to the connector's default, and a NOT-INSTALLED provider falls
// forward to the first installed sibling — defaults not laws, so a stale
// setting or a removed plugin never breaks adds. Only when no provider of the
// domain is installed does this throw (readably; the routes and the ingest
// preview surface messages as-is). The returned provider descriptor carries the
// plugin-config rpm/burst overrides shallow-merged in — every callProvider call
// site uses this object, so pacing config flows everywhere from here.
export async function activeProvider(db, conn) {
  const set = await getSetting(db, `${conn.name}_provider`);
  let name = conn.providers[set] ? set : conn.defaultProvider;
  let st = await pluginRowState(db, conn, name);
  if (!st.installed) {
    name = null;
    for (const n of Object.keys(conn.providers)) {
      const s = await pluginRowState(db, conn, n);
      if (s.installed) { name = n; st = s; break; }
    }
    if (!name) throw new Error(`no ${conn.name} provider is installed (add one on the Plugins page)`);
  }
  const apiKey = (await providerKey(db, conn, name)) || null;
  return { name, provider: paced(conn.providers[name], st.config, apiKey), apiKey };
}

// The provider descriptor every call site actually uses: the module's own
// declarations with the effective pacing merged in. Two rules, in precedence
// order, and they live here rather than at each call site because both
// activeProvider and testConnection resolve them and the second used to say
// "same tier rule as activeProvider" over a copy of it.
//
//  1. TIER — a provider whose tiers pace differently declares `keylessRpm`;
//     without a stored key that's the honest ceiling (CoinGecko's keyless
//     pool is a fraction of its keyed one, and it counts FAILED requests
//     against the limit, so overpacing doesn't just 429, it burns quota).
//  2. OVERRIDE — the Plugins page beats both tiers: an operator who knows
//     their plan outranks the descriptor's guess.
const paced = (raw, config = {}, apiKey = null) => ({
  ...raw,
  rpm: config.rpm ?? (apiKey ? raw.rpm : raw.keylessRpm ?? raw.rpm),
  burst: config.burst ?? raw.burst,
});

// The domain's stored-vs-effective pair — the two admin surfaces that expose
// domain state (the Plugins payload's `slots.domains`, the capabilities feed)
// both need it, and the try/catch-around-activeProvider pattern was growing a
// second copy. `setting` is the raw star, which may name a provider that can't
// serve; `effective` is the full activeProvider result, null when no provider
// of the domain is installed — the one case activeProvider throws.
export async function standing(db, conn) {
  const setting = (await getSetting(db, `${conn.name}_provider`)) || null;
  try {
    return { setting, effective: await activeProvider(db, conn) };
  } catch {
    return { setting, effective: null };
  }
}

// A standing read as ONE answer to "can this domain serve right now, and if
// not, why". Both surfaces that ask are the same question asked twice: the
// capabilities feed (the Plugins page card) and /api/connectors (the mapping
// modal's template picker). A picker offering Stocks as a plain choice while
// the card beside it says "unavailable" is not two opinions, it's one rule
// written down twice — so it is written here once.
//
// Pure: `standing` is the only db read, and the labels come from the
// connector's own live provider descriptors (`listConnectors()`'s `providers`),
// so nothing here needs the admin plugin catalog.
//
// `blocked` means the serving provider needs a key it doesn't have —
// activeProvider resolves regardless of keys, but every call would fail.
// `degraded` still SERVES (a sibling took over), so it counts as available;
// the star being dead is the Plugins page's story, not the picker's.
export function domainState({ setting, effective }, { label, providers = [] }) {
  const labelOf = (name) => providers.find((p) => p.name === name)?.label || name;
  const out = (state, reason = null) => ({ state, reason, available: state === "active" || state === "degraded" });
  if (!effective) return out("unavailable", `no ${label} provider is installed`);
  if (setting && setting !== effective.name)
    return out("degraded", `${labelOf(setting)} can't serve — ${labelOf(effective.name)} took over`);
  if (effective.provider.needsKey && !effective.apiKey)
    return out("blocked", `${labelOf(effective.name)} needs an API key`);
  return out("active");
}

// The per-call context every provider method receives: the key plus the
// pacing handle (see callProvider — request-pacing providers await it before
// each raw fetch). Built fresh per logical call; `pace` closes over the
// merged rpm/burst so Plugins-page overrides flow everywhere from here.
const ctxFor = (db, name, provider, apiKey) => ({ apiKey, pace: paceFor(db, name, provider) });

export async function search(db, conn, query) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  return tracked(db, conn, name, provider, () => provider.search(query, ctxFor(db, name, provider, apiKey)));
}

// Browse a sorted, paginated page of the domain's catalog for the ingestion
// modal. `opts` = { sort, order, page, pageSize, query }. A provider that can't
// browse (no list()) yields [] — the modal degrades to "not supported", like a
// missing history()/face producer.
export async function list(db, conn, opts) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  if (!provider.list) return [];
  return tracked(db, conn, name, provider, () => provider.list(opts, ctxFor(db, name, provider, apiKey)));
}

// The browse filters a user can actually apply RIGHT NOW: the manifest's
// declarations with their vocabularies resolved, normalized to {value,label}.
//
// Two kinds of vocabulary. A static filter carries its own `options` (FMP's
// 11-sector taxonomy is effectively frozen, so writing it down beats buying
// it). A filter declared `from: "provider"` gets its options from the active
// provider's filterOptions() — CoinGecko's ~857 categories are the provider's
// to know, not ours to freeze, and a provider that can't supply them (CMC has
// no equivalent) simply renders no control, the same declarative rule the
// face `requires` gate uses.
//
// This is the ONE resolver: the filters route renders from it and the browse
// route whitelists against it, so what the client can offer and what the
// server will accept are the same list by construction. Provider failure
// degrades to the static filters — a dead categories endpoint costs the
// category control, never the whole modal.
export async function browseFilters(db, conn) {
  const declared = conn.manifest?.browse?.filters || [];
  if (!declared.length) return [];
  // One shape and one ordering for every vocabulary, whatever supplied it: a
  // bare string is its own label, and the list comes back sorted. Sorting HERE
  // rather than in each provider is what stops an 857-entry dropdown arriving
  // unsorted because a provider forgot — the resolver's guarantee, not a rule
  // restated per backend.
  const normalize = (options) =>
    (options || [])
      .map((o) => (typeof o === "string" ? { value: o, label: o } : o))
      .filter((o) => o && o.value != null)
      .map((o) => ({ value: o.value, label: String(o.label ?? o.value) }))
      .sort((a, b) => a.label.localeCompare(b.label));

  let supplied = {};
  if (declared.some((f) => f.from === "provider")) {
    try {
      const { name, provider, apiKey } = await activeProvider(db, conn);
      if (provider.filterOptions)
        supplied = await tracked(db, conn, name, provider, () =>
          provider.filterOptions(ctxFor(db, name, provider, apiKey))) || {};
    } catch (e) {
      console.warn(`${conn.name}: filter options unavailable (static filters only): ${e.message}`);
    }
  }
  const out = [];
  for (const f of declared) {
    const options = normalize(f.from === "provider" ? supplied[f.key] : f.options);
    if (!options.length) continue; // no vocabulary → no control, rather than an empty one
    out.push({ key: f.key, label: f.label || f.key, options });
  }
  return out;
}

// Assemble the connector entity from the active provider's raw values:
//  - identity = lowercase symbol (portable across providers; dedupes the same
//    asset added under two backends), falling back to the provider id;
//  - src = provider name on every field (truthful provenance);
//  - at = fetch time on every field (the liveness baseline; read in a later slice);
//  - source = { provider, id } — the provider handle a future refresh re-fetches from.
export async function fetchEntity(db, conn, id, now = Date.now()) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  const e = await tracked(db, conn, name, provider, () => provider.fetchEntity(id, ctxFor(db, name, provider, apiKey)));
  const symbol = e.symbol || null;
  const identity = (symbol || "").toLowerCase() || e.id;
  const fields = {};
  for (const [k, v] of Object.entries(e.fields || {})) fields[k] = { ...v, src: name, at: now };
  return { identity, display_name: e.display_name, symbol, source: { provider: name, id: e.id }, fields };
}

// Test a provider's reachability. The admin UI passes the provider it has
// selected (and, when the admin just typed one, an apiKey) so the check reflects
// the form, not whatever is currently active/saved. Both fall back: no override
// → the active provider; no typed key → that provider's stored key.
export async function testConnection(db, conn, { provider: pOverride, apiKey: kOverride } = {}) {
  const name = pOverride && conn.providers[pOverride] ? pOverride : (await activeProvider(db, conn)).name;
  // Deliberately no enabled gate on the explicit-override path: the admin
  // tests a provider BEFORE enabling it. Config pacing still applies.
  const st = await pluginRowState(db, conn, name);
  const apiKey = kOverride !== undefined && kOverride !== "" ? kOverride : await providerKey(db, conn, name);
  const provider = paced(conn.providers[name], st.config, apiKey);
  if (!provider.testConnection) throw new Error("provider has no connection test");
  await tracked(db, conn, name, provider, () => provider.testConnection(ctxFor(db, name, provider, apiKey)));
  return { provider: name };
}

// --- liveness (slice 5c) ---
// The scheduling rules themselves are pure and live in ./schedule.js (db.js
// needs them and can't import this module — it's the other way round). Re-
// exported here so every caller keeps one connector-runtime import; `refresh`
// below uses two of them directly, hence the import alongside.
export { liveFields, nextRefreshAt, faceSchedule, entityRefreshAt, firstRefreshAt } from "./schedule.js";

// Map a symbol back to a provider id under the active provider — provider ids
// aren't portable (CoinGecko's "bitcoin" ≠ CoinMarketCap's "1"), so a refresh
// after a provider switch re-resolves by ticker. Prefers an exact symbol match.
export async function resolveBySymbol(db, conn, symbol) {
  if (!symbol) return null;
  const want = symbol.toLowerCase();
  const hits = await search(db, conn, symbol);
  const hit = hits.find((h) => (h.symbol || "").toLowerCase() === want) || hits[0];
  return hit ? hit.id : null;
}

// The provider handle an entity should be fetched under RIGHT NOW: the stamped
// source id when it names the active backend, else re-resolved by ticker.
// Null when the symbol can't be found either. Refresh, faces and charts all
// make this same call — one spelling for the three of them.
const resolveProviderId = (db, conn, activeName, source, symbol) =>
  activeName === source?.provider ? source.id : resolveBySymbol(db, conn, symbol);

// Batch-warm the active provider's quote cache for a set of provider ids (a
// provider declares the capability by exporting prefetch(ids, ctx)). Purely an
// economics move: whatever reads those ids next hits the warm cache, so a
// 100-coin batch pays one metered call instead of 100. Best-effort by design —
// any failure just means the per-entity path pays retail.
//
// Two callers with two shapes, one warm: the refresh sweep arrives with due
// ROWS (below), the ingestion sweep with an admission batch's ids straight off
// the enumerated candidates. This is the seam they share; writing it twice is
// how the quote-cache economics drifted the first time.
async function warmIds(db, active, ids) {
  const want = [...new Set((ids || []).filter((v) => v != null).map(String))];
  if (want.length < 2) return; // nothing a batch would save
  await callProvider(db, active.name, active.provider, () =>
    active.provider.prefetch(want, ctxFor(db, active.name, active.provider, active.apiKey)));
}

export async function prefetchIds(db, conn, ids) {
  const active = await activeProvider(db, conn).catch(() => null);
  if (!active?.provider.prefetch) return;
  await warmIds(db, active, ids);
}

// The refresh sweep's shape: `rows` are its due entries ({ entity, inst, … }).
// A provider-switched entity (source names another backend) is skipped here and
// re-resolved by its own refresh as usual.
export async function prefetchRefresh(db, conn, rows) {
  const active = await activeProvider(db, conn).catch(() => null);
  if (!active?.provider.prefetch) return;
  await warmIds(db, active, rows
    .map((r) => r?.inst?.payload?.source)
    .filter((s) => s && s.provider === active.name && s.id != null)
    .map((s) => s.id));
}

// Re-fetch one entity and return the fields to write back — only those live
// fields whose cadence has elapsed. Live config comes from `mapping` (the board
// mapping — the current source of truth an admin edits), NOT the instance's
// stamped mapping, which is frozen at creation and would ignore later liveness
// edits. `inst` carries the provider `source`. `at` is always bumped on a
// refresh (last-checked, not last-changed) so an unchanged field doesn't read
// "due" forever. `moved` holds only value changes.
//
// The fetch itself is field-aware when the provider allows: a provider may
// export fetchFields(id, keys, ctx) → { fields } serving just the requested
// keys from its cheapest sources (FMP serves price/market_cap/volume/… from
// its cached screener universe — ZERO marginal HTTP for a whole board's
// refresh cycle; only change_1d needs a per-symbol quote). The response must
// cover every due key or the runtime falls back to the whole-object
// fetchEntity — a partial answer can never strand a field due-forever.
// Providers without the capability get the whole-object path, unchanged.
export async function refresh(db, conn, entity, inst, mapping, now = Date.now()) {
  const live = liveFields(mapping);
  const due = live.filter((f) => now - (entity.fields?.[f.key]?.at ?? 0) >= f.every * 60000);
  if (!due.length) return { merged: null, moved: {}, next: nextRefreshAt(entity.fields, live, now) };

  const active = await activeProvider(db, conn);
  const id = await resolveProviderId(db, conn, active.name, inst.payload?.source, entity.symbol);
  if (id == null) return { merged: null, moved: {}, next: nextRefreshAt(entity.fields, live, now) };

  const dueKeys = due.map((f) => f.key);
  let fetched = null;
  if (active.provider.fetchFields) {
    const partial = await tracked(db, conn, active.name, active.provider, () =>
      active.provider.fetchFields(id, dueKeys, ctxFor(db, active.name, active.provider, active.apiKey)));
    const fields = {};
    for (const [k, v] of Object.entries(partial?.fields || {})) fields[k] = { ...v, src: active.name, at: now };
    if (dueKeys.every((k) => fields[k])) fetched = { fields };
  }
  if (!fetched) fetched = await fetchEntity(db, conn, id, now);

  const merged = { ...entity.fields };
  const moved = {};
  for (const f of due) {
    const nv = fetched.fields[f.key];
    if (!nv) continue;
    if (merged[f.key]?.v !== nv.v) moved[f.key] = nv;
    merged[f.key] = nv; // always rewritten so `at` advances → refresh_at recomputes
  }
  return { merged, moved, next: nextRefreshAt(merged, live, now), provider: active.name };
}

// --- faces (slice 5d) ---

// Produce the connector face bytes for an entity, or null when unavailable
// (unknown producer, provider has no history, empty series) — the caller keeps
// the symbol tile. `source` is the provider handle; re-resolve by symbol on a
// provider switch, like refresh. The connector's `faces` map NAMES a shared
// producer (server/faces); the raw series comes from the active provider's
// history().
export async function produceFace(db, conn, entity, source, faceCfg) {
  const producer = getFaceProducer(conn.faces?.[faceCfg?.producer]);
  if (!producer) return null;
  const { name, provider, apiKey } = await activeProvider(db, conn);
  if (!provider.history) return null; // provider can't supply history → fall back
  const id = await resolveProviderId(db, conn, name, source, entity.symbol);
  if (id == null) return null;
  const series = await tracked(db, conn, name, provider, () => provider.history(id, faceCfg.period, ctxFor(db, name, provider, apiKey)));
  if (!series || !series.length) return null;
  return producer(series, { symbol: entity.symbol, name: entity.display_name, period: faceCfg.period });
}

// faceSchedule / entityRefreshAt — the face's half of the scheduling rules —
// are in ./schedule.js with their field-side siblings, re-exported above.

// --- live chart (the lightbox detail view; planning/lightbox-live-chart-plan.md) ---
//
// The domain manifest declares the FULL (range, kind) surface; a provider
// serves a pair or refuses it (`e.unsupported` — a plan gate its API answered,
// or a mapping it doesn't have). What a deployment's key turned out not to
// serve is LEARNED here, per pair, so the offer converges to the truth with no
// tier knowledge anywhere: the response's ranges/kinds are the controls the
// client renders, identical for every user.
//
// The learned entries are keyed `domain:provider:keyFingerprint|range|kind` —
// a key swap lands in a fresh bucket instantly (an admin pasting a paid key
// must not wait out a TTL), the domain prefix keeps same-named plugin
// providers apart, and the TTL (CHART_LEARN_TTL, shared with the providers'
// ladder-rung memories) covers the rarer same-key plan upgrade. In-memory on
// purpose: it self-heals on restart, and there is no setting to go stale.
const chartLearned = createTtlCache(1000);

const isLearned = (bucket, range, kind) => chartLearned.get(`${bucket}|${range}|${kind}`) != null;
const learn = (bucket, range, kind) => chartLearned.put(`${bucket}|${range}|${kind}`, true, CHART_LEARN_TTL);

// Sentinel the marker dance below returns in place of an unsupported throw.
const REFUSED = Symbol("chart pair refused");

// One entity's chart series under the active provider, clamped — never
// rejected — to what the deployment has proven servable. Returns null when
// nothing can serve (no capability, no vocabulary, empty offer, unresolvable
// id): the route answers 404 and the client keeps the static face.
export async function chartSeries(db, conn, entity, source, { range, kind } = {}) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  const decl = conn.manifest?.chart;
  if (!provider.chart || !decl?.ranges?.length || !decl?.kinds?.length) return null;

  const bucket = `${conn.name}:${name}:${keyFingerprint(apiKey)}`;
  const alive = (r, k) => !isLearned(bucket, r, k);
  const kindsFor = (r) => decl.kinds.filter((k) => alive(r, k));

  // Resolved once — a switched-provider entity must not pay a metered
  // resolveBySymbol search per discovery attempt.
  const id = await resolveProviderId(db, conn, name, source, entity.symbol);
  if (id == null) return null;

  // The discovery loop. A refusal is an ANSWER, not an error: learn the exact
  // pair asked, then go around — the clamps route the same request past what
  // was just learned (a dead pair falls to the range's other kind, or to the
  // default range). Bounded so a fully dead provider costs a bounded probe on
  // one request and finishes discovery lazily on later clicks; exhaustion →
  // null → 404 → the static face. `unavailable` keeps the FIRST refused pair,
  // so the client can say "1d isn't available" even when the fallback also
  // degraded a step.
  //
  // Range and kind are re-derived from the ORIGINAL request each iteration,
  // never carried over mutated: a probe that had to borrow the range's other
  // kind (5y area dead → try 5y candles) must not strand the user's kind on
  // the final answer — once the range falls back to one that serves the asked
  // kind, the asked kind wins again (live-caught: "5y area" served 1y CANDLES).
  const wantRange = range;
  const wantKind = kind;
  let unavailable = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ranges = decl.ranges.filter((r) => kindsFor(r).length);
    if (!ranges.length) return null;
    range = ranges.includes(wantRange) ? wantRange
      : ranges.includes(decl.defaultRange) ? decl.defaultRange
      : ranges[ranges.length - 1];
    const kinds = kindsFor(range);
    kind = kinds.includes(wantKind) ? wantKind : kinds[0];

    // The marker dance: an unsupported refusal is converted to a RETURN inside
    // the tracked callback — the provider answered coherently, and that IS a
    // healthy outcome, so the plugin ledger records a heal, never an error —
    // then unwrapped here. Transient throws pass through untouched: ledgered
    // as failures, surfaced by the route as a readable 502. Promise.resolve()
    // first, so even a plugin provider that throws SYNCHRONOUSLY lands in the
    // catch instead of skipping the dance.
    const out = await tracked(db, conn, name, provider, () =>
      Promise.resolve()
        .then(() => provider.chart(id, { range, kind }, ctxFor(db, name, provider, apiKey)))
        .catch((e) => { if (e?.unsupported) return REFUSED; throw e; }));
    if (out !== REFUSED) {
      return out && { ...out, range, ranges, kind, kinds, provider: name,
                      attribution: provider.attribution || null,
                      ...(unavailable ? { unavailable } : {}) };
    }
    learn(bucket, range, kind);
    unavailable ??= { range, kind };
  }
  return null;
}

// Test seams only (house convention: provider-pacing's _resetBuckets).
export function _resetChartLearned() {
  chartLearned.reset();
}
export function _ageChartLearned(ms) {
  chartLearned.age(ms);
}
