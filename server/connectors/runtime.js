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
import { getSetting, getPluginRow, withPluginHealth } from "../db.js";
import { getFaceProducer } from "../faces/index.js";
import { acquire } from "../provider-pacing.js";
import { liveFields, nextRefreshAt } from "./schedule.js";

const providerKey = (db, conn, name) => getSetting(db, `${conn.name}_key_${name}`);

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
const RATE_STATUS = new Set([429, 401]);
async function withRetry(fn, tries = 3) {
  const cap = Number(process.env.CONNECTOR_RETRY_CAP_MS) || 30000;
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (!RATE_STATUS.has(e?.status) || i >= tries) throw e;
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
// company-screener holds a flat ~15 s server-side regardless of size —
// measured, see planning/connector-scale-plan.md), where the generous
// ceiling binds only on a true hang. The PROVIDER picks the class per call
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
const paceFor = (name, provider) => {
  const rpm = Number(process.env.CONNECTOR_RPM) || provider.rpm || DEFAULT_RPM;
  const burst = Number(process.env.CONNECTOR_BURST) || provider.burst || DEFAULT_BURST;
  return () => acquire(name, rpm, burst);
};

// Rate-limited + 429-retried provider call. Exported for tests.
//
// Pacing has two modes. Legacy: one token per LOGICAL call, acquired here —
// blind to what the provider actually does (a cache-served list() pays for
// zero HTTP; fetchEntity pays one token for a three-request fan-out). A
// provider that declares `pacesRequests = true` opts into truthful metering:
// this pre-acquire is skipped and the provider awaits the threaded ctx.pace()
// before EACH raw request instead — cache hits cost nothing, fan-outs pay
// full fare, and retried attempts pay per attempt. Dynamic plugin providers
// without the flag keep legacy behavior untouched.
//
// AbortSignal.timeout rejects with a bare DOMException ("The operation was
// aborted due to timeout") — no provider name, no status. Rewrap it readably
// for every surface that shows provider errors verbatim (preview toast, job
// log, plugins health row). Still status-less, so withRetry above never
// retried it and callers treat it as a plain failure. Providers may pre-wrap
// with more context (FMP names the endpoint); this is the floor.
export function callProvider(name, provider, fn) {
  const pre = provider.pacesRequests ? Promise.resolve() : paceFor(name, provider)();
  return pre.then(() => withRetry(fn)).catch((e) => {
    if (e?.name === "TimeoutError") throw new Error(`${name}: request timed out`);
    throw e;
  });
}

// callProvider under the shared plugin health ledger: outcomes (post-retry)
// land on the provider's plugins row (structured error or heal), feeding the
// Plugins page dot and, later, the self-healing loop.
const tracked = (db, conn, name, provider, fn) =>
  withPluginHealth(db, `${conn.name}:${name}`, () => callProvider(name, provider, fn));

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
  const raw = conn.providers[name];
  const provider = { ...raw, rpm: st.config.rpm ?? raw.rpm, burst: st.config.burst ?? raw.burst };
  return { name, provider, apiKey: (await providerKey(db, conn, name)) || null };
}

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
const ctxFor = (name, provider, apiKey) => ({ apiKey, pace: paceFor(name, provider) });

export async function search(db, conn, query) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  return tracked(db, conn, name, provider, () => provider.search(query, ctxFor(name, provider, apiKey)));
}

// Browse a sorted, paginated page of the domain's catalog for the ingestion
// modal. `opts` = { sort, order, page, pageSize, query }. A provider that can't
// browse (no list()) yields [] — the modal degrades to "not supported", like a
// missing history()/face producer.
export async function list(db, conn, opts) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  if (!provider.list) return [];
  return tracked(db, conn, name, provider, () => provider.list(opts, ctxFor(name, provider, apiKey)));
}

// Assemble the connector entity from the active provider's raw values:
//  - identity = lowercase symbol (portable across providers; dedupes the same
//    asset added under two backends), falling back to the provider id;
//  - src = provider name on every field (truthful provenance);
//  - at = fetch time on every field (the liveness baseline; read in a later slice);
//  - source = { provider, id } — the provider handle a future refresh re-fetches from.
export async function fetchEntity(db, conn, id, now = Date.now()) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  const e = await tracked(db, conn, name, provider, () => provider.fetchEntity(id, ctxFor(name, provider, apiKey)));
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
  const raw = conn.providers[name];
  const provider = { ...raw, rpm: st.config.rpm ?? raw.rpm, burst: st.config.burst ?? raw.burst };
  if (!provider.testConnection) throw new Error("provider has no connection test");
  const apiKey = kOverride !== undefined && kOverride !== "" ? kOverride : await providerKey(db, conn, name);
  await tracked(db, conn, name, provider, () => provider.testConnection(ctxFor(name, provider, apiKey)));
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

  const src = inst.payload?.source;
  const active = await activeProvider(db, conn);
  const id = active.name === src?.provider ? src.id : await resolveBySymbol(db, conn, entity.symbol);
  if (id == null) return { merged: null, moved: {}, next: nextRefreshAt(entity.fields, live, now) };

  const dueKeys = due.map((f) => f.key);
  let fetched = null;
  if (active.provider.fetchFields) {
    const partial = await tracked(db, conn, active.name, active.provider, () =>
      active.provider.fetchFields(id, dueKeys, ctxFor(active.name, active.provider, active.apiKey)));
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
  const id = name === source?.provider ? source.id : await resolveBySymbol(db, conn, entity.symbol);
  if (id == null) return null;
  const series = await tracked(db, conn, name, provider, () => provider.history(id, faceCfg.period, ctxFor(name, provider, apiKey)));
  if (!series || !series.length) return null;
  return producer(series, { symbol: entity.symbol, name: entity.display_name, period: faceCfg.period });
}

// faceSchedule / entityRefreshAt — the face's half of the scheduling rules —
// are in ./schedule.js with their field-side siblings, re-exported above.
