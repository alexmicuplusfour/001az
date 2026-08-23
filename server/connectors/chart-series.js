// Shared shaping for the live-chart capability's series (planning/
// lightbox-live-chart-plan.md). Pure functions, no I/O — every provider's
// chart() funnels its raw rows through these, so the series invariants live
// once instead of once per backend:
//
//   - strictly ascending, strictly deduplicated time. The client renderer
//     (lightweight-charts) REJECTS setData with unordered or duplicate times,
//     and the hazard is real: CoinGecko's daily series ends with a live tail
//     point whose UTC date equals today's midnight point (verified 2026-08-23),
//     so date-string conversion without dedupe ships duplicates.
//   - bounded size. Area series stride-sample; candles never stride (a skipped
//     candle is silent data loss) — they calendar-aggregate instead, the same
//     weekly/monthly bucketing every finance chart shows at 5y/max zoom.
//
// Also home to the ONE refusal signal the runtime's learned-availability model
// reads, so no provider invents its own spelling of it.

// An "unsupported" refusal: this (range, kind) isn't servable through this
// backend/key — a plan gate the provider RECOGNIZED, or a mapping it doesn't
// have. A fact about capability, not a failure: the runtime learns it and the
// control disappears; it must never be thrown for transient trouble.
export function unsupported(message) {
  const e = new Error(message);
  e.unsupported = true;
  return e;
}

// Sort ascending by `key` ("t" epoch ms | "d" ISO date string — lexicographic
// IS chronological for ISO dates) and keep the LAST point per identical time
// value. Keep-last on purpose: in the live-tail collision the tail is the
// fresher price, and providers append, not prepend.
export function dedupeAscending(points, key) {
  const sorted = [...points].sort((a, b) =>
    a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0
  );
  const out = [];
  for (const p of sorted) {
    if (out.length && out[out.length - 1][key] === p[key]) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

// Epoch ms → the stamp's UTC date, the `d` encoding for daily granularity.
export const utcDate = (t) => new Date(t).toISOString().slice(0, 10);

// Stride an area series down to at most `max` points, keeping first and last —
// the face producer's downsample (server/faces/price-chart.js), same mechanics.
export function strideArea(points, max = 2000) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

// The Monday of a date string's ISO week (UTC math) — the weekly bucket key.
function mondayOf(d) {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

// Merge consecutive candles sharing a bucket key: the bucket opens on its first
// bar's open AND date (a real trading day, not the calendar boundary), closes
// on its last close, spans the extremes.
function bucketCandles(candles, keyOf) {
  const out = [];
  let key = null;
  let cur = null;
  for (const bar of candles) {
    const k = keyOf(bar);
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { d: bar.d, o: bar.o, h: bar.h, l: bar.l, c: bar.c };
    } else {
      cur.h = Math.max(cur.h, bar.h);
      cur.l = Math.min(cur.l, bar.l);
      cur.c = bar.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Daily candles above `max` bars aggregate to ISO weeks; still above, to
// months. Deterministic calendar buckets, honest OHLC — never a stride.
export function aggregateCandles(candles, max = 400) {
  if (candles.length <= max) return candles;
  const weekly = bucketCandles(candles, (bar) => mondayOf(bar.d));
  if (weekly.length <= max) return weekly;
  return bucketCandles(candles, (bar) => bar.d.slice(0, 7));
}

// One freshness policy for the whole capability, not one per provider:
//   LIVE    — sub-day ranges, where the newest point is a moving quote;
//   SETTLED — day-scale ranges, where only the tail bar drifts;
//   LEARN   — how long a refusal (a learned pair, a ladder's dead rung) is
//             trusted before re-probing. Shared between the runtime's learned
//             pairs and the providers' rung memories ON PURPOSE: the plan-
//             upgrade re-probe story only works if both expire together.
export const CHART_TTL_LIVE = 60 * 1000;
export const CHART_TTL_SETTLED = 5 * 60 * 1000;
export const CHART_LEARN_TTL = 6 * 60 * 60 * 1000;

// A bounded TTL cache — the one shape every provider's chart cache, the rung
// memories, and the runtime's learned pairs turned out to share, extracted
// after each had written its own. FIFO eviction like FMP's bridgeCache; an
// expired entry is dropped at first touch rather than squatting until
// eviction; `age` backs the `_ageChart*` test seams, `reset` the `_reset*` ones.
export function createTtlCache(max = 200) {
  const map = new Map();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.at >= entry.ttl) { map.delete(key); return undefined; }
      return entry.value;
    },
    put(key, value, ttl) {
      map.set(key, { at: Date.now(), ttl, value });
      if (map.size > max) map.delete(map.keys().next().value);
    },
    reset() { map.clear(); },
    age(ms) { for (const entry of map.values()) entry.at -= ms; },
  };
}

// Descend a tiered request ladder: finest rung first, a recognized plan gate
// steps down, anything else rethrows. The winning rung's INDEX is remembered
// (in a createTtlCache the caller owns, CHART_LEARN_TTL horizon) so later
// calls skip known-dead rungs. Returns { value, rung } from the rung that
// answered, or null when every rung gated — the caller wraps null in its own
// `unsupported` message. Extracted because FMP and CMC had each written this
// walk with a different memory encoding.
export async function walkLadder(rungs, memory, key, isGate, tryRung) {
  const remembered = memory.get(key);
  const start = remembered != null ? Math.min(remembered, rungs.length - 1) : 0;
  for (let i = start; i < rungs.length; i++) {
    try {
      const value = await tryRung(rungs[i]);
      memory.put(key, i, CHART_LEARN_TTL);
      return { value, rung: rungs[i] };
    } catch (e) {
      if (!isGate(e)) throw e; // transient (or a bad key) — never "learned"
    }
  }
  return null;
}

// Days since Jan 1 UTC — the ytd window, for the providers that compute it.
export const ytdDays = () =>
  Math.max(1, Math.ceil((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 86400000));

// The complete encode pipelines, one per kind, so a provider can't half-apply
// the invariants (dedupe but forget the stride; convert dates but skip the
// dedupe — the browseFilters normalize argument, again). Input points carry
// epoch `t`; the daily flavour converts to `d` strings. FMP's EOD path is the
// one caller that stays hand-rolled: its rows are date-native (no epochs), so
// forcing them through here would mean inventing timestamps just to strip them.
export const encodeArea = (points, { daily, tz }) =>
  daily
    ? { time: "daily", tz,
        points: dedupeAscending(points.map(({ t, p }) => ({ d: utcDate(t), p })), "d") }
    : { time: "intraday", tz, points: strideArea(dedupeAscending(points, "t")) };

export const encodeCandles = (bars, { daily, tz }) =>
  daily
    ? { time: "daily", tz,
        points: aggregateCandles(dedupeAscending(
          bars.map(({ t, o, h, l, c }) => ({ d: utcDate(t), o, h, l, c })), "d")) }
    : { time: "intraday", tz,
        points: dedupeAscending(bars.map(({ t, o, h, l, c }) => ({ t, o, h, l, c })), "t") };
