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
// A token bucket per provider keeps the sweep and backfills under each API's
// limit instead of bursting and 429ing. Acquisition is serialized per provider
// so concurrent callers don't all spend the same tokens; when the bucket is
// empty a call waits for a refill. On a 429 the call is retried, honoring
// Retry-After capped at 30 s — these sleeps run inside the worker's
// single-flight tick, so a provider asking for an hour must not be taken at
// its word; long waits belong to the queue's spaced retry_at, not here.
// rpm/burst come from the provider descriptor.
const DEFAULT_RPM = 30, DEFAULT_BURST = 15;
const buckets = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire(key, rpm, burst) {
  let b = buckets.get(key);
  if (!b) { b = { tokens: burst, last: Date.now(), rpm, burst, chain: Promise.resolve() }; buckets.set(key, b); }
  else if (b.rpm !== rpm || b.burst !== burst) {
    // Config overrides (Plugins page) apply live, not on next boot; clamp the
    // saved-up tokens so a burst cut takes effect immediately.
    b.rpm = rpm;
    b.burst = burst;
    b.tokens = Math.min(b.tokens, burst);
  }
  const run = b.chain.then(async () => {
    for (;;) {
      const now = Date.now();
      b.tokens = Math.min(b.burst, b.tokens + ((now - b.last) / 60000) * b.rpm);
      b.last = now;
      if (b.tokens >= 1) { b.tokens -= 1; return; }
      await sleep(((1 - b.tokens) / b.rpm) * 60000);
    }
  });
  b.chain = run.catch(() => {}); // keep the per-provider chain alive on failure
  return run;
}

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
// Price/search APIs answer in seconds; 15 s is generous. Env-tunable.
export const providerSignal = () =>
  AbortSignal.timeout(Number(process.env.CONNECTOR_TIMEOUT_MS) || 15000);

// Rate-limited + 429-retried provider call. Exported for tests. Env overrides
// (CONNECTOR_RPM/CONNECTOR_BURST) let the test harness run unthrottled — its
// provider calls are stubbed, so pacing would only add wall-clock delay.
export function callProvider(name, provider, fn) {
  const rpm = Number(process.env.CONNECTOR_RPM) || provider.rpm || DEFAULT_RPM;
  const burst = Number(process.env.CONNECTOR_BURST) || provider.burst || DEFAULT_BURST;
  return acquire(name, rpm, burst).then(() => withRetry(fn));
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

export async function search(db, conn, query) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  return tracked(db, conn, name, provider, () => provider.search(query, { apiKey }));
}

// Browse a sorted, paginated page of the domain's catalog for the ingestion
// modal. `opts` = { sort, order, page, pageSize, query }. A provider that can't
// browse (no list()) yields [] — the modal degrades to "not supported", like a
// missing history()/face producer.
export async function list(db, conn, opts) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  if (!provider.list) return [];
  return tracked(db, conn, name, provider, () => provider.list(opts, { apiKey }));
}

// Assemble the connector entity from the active provider's raw values:
//  - identity = lowercase symbol (portable across providers; dedupes the same
//    asset added under two backends), falling back to the provider id;
//  - src = provider name on every field (truthful provenance);
//  - at = fetch time on every field (the liveness baseline; read in a later slice);
//  - source = { provider, id } — the provider handle a future refresh re-fetches from.
export async function fetchEntity(db, conn, id, now = Date.now()) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  const e = await tracked(db, conn, name, provider, () => provider.fetchEntity(id, { apiKey }));
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
  await tracked(db, conn, name, provider, () => provider.testConnection({ apiKey }));
  return { provider: name };
}

// --- liveness (slice 5c) ---

// A mapping's live connector fields: [{ key, kind, from, fn, live, every }].
export const liveFields = (mapping) =>
  (mapping?.fields || []).filter((f) => f.from === "connector" && f.live);

// Soonest time any live field comes due: min(field.at + every*60000), or null
// when nothing is live. `fields` is the entity's stored field map; a field with
// no `at` yet is treated as due now.
export function nextRefreshAt(fields, live, now = Date.now()) {
  let next = null;
  for (const f of live) {
    const due = (fields?.[f.key]?.at ?? now) + f.every * 60000;
    if (next === null || due < next) next = due;
  }
  return next;
}

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
// edits. `inst` carries the provider `source`. Whole-object fetch (one API call)
// even when a single field is due; you can't fetch a field in isolation. `at` is
// always bumped on a refresh (last-checked, not last-changed) so an unchanged
// field doesn't read "due" forever. `moved` holds only value changes.
export async function refresh(db, conn, entity, inst, mapping, now = Date.now()) {
  const live = liveFields(mapping);
  const due = live.filter((f) => now - (entity.fields?.[f.key]?.at ?? 0) >= f.every * 60000);
  if (!due.length) return { merged: null, moved: {}, next: nextRefreshAt(entity.fields, live, now) };

  const src = inst.payload?.source;
  const active = await activeProvider(db, conn);
  const id = active.name === src?.provider ? src.id : await resolveBySymbol(db, conn, entity.symbol);
  if (id == null) return { merged: null, moved: {}, next: nextRefreshAt(entity.fields, live, now) };
  const fetched = await fetchEntity(db, conn, id, now);

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
  const series = await tracked(db, conn, name, provider, () => provider.history(id, faceCfg.period, { apiKey }));
  if (!series || !series.length) return null;
  return producer(series, { symbol: entity.symbol, name: entity.display_name, period: faceCfg.period });
}

// The live face cadence, mirroring liveFields — { every } when the mapping's
// face is a connector face marked live, else null.
export const faceCadence = (mapping) => {
  const f = mapping?.face;
  return f && f.from === "connector" && f.live ? { every: f.every } : null;
};

// An entity's next refresh time across BOTH its live fields and its face.
// `faceAt` is entities.face_at (null until the face is first rendered). This
// runs right after a render attempt, so a still-null faceAt here means the
// render was unavailable (e.g. the active provider has no history) — retry one
// cadence out rather than dropping the term, else a face-only board with no
// live fields would get refresh_at null and fall off the sweep until the next
// boot/mapping-save. The retry is a cheap no-op while the provider can't render.
// (First-render urgency is separate: rescheduleEntityRefreshes/boot reconcile
// treat a null faceAt as due-now, so enabling a face still backfills at once.)
export function entityRefreshAt(fields, faceAt, mapping, now = Date.now()) {
  let next = nextRefreshAt(fields, liveFields(mapping), now);
  const cad = faceCadence(mapping);
  if (cad) {
    const due = (faceAt ?? now) + cad.every * 60000;
    if (next === null || due < next) next = due;
  }
  return next;
}
