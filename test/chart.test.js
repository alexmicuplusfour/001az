// The live-chart capability (planning/lightbox-live-chart-plan.md, slice 2):
// the shared series invariants, the domain vocabulary, each provider's
// chart() mapping, the runtime's learned-availability model, and the entity
// route. Provider HTTP is stubbed (house pattern) — no live network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, seedItem, req, installConnectors } from "./helpers.js";
import { createBoard, createEntity, insertItem, getPluginRow, setSetting } from "../server/db.js";
import { registerConnector, unregisterConnector } from "../server/connectors/index.js";
import * as runtime from "../server/connectors/runtime.js";
import { unsupported, dedupeAscending, utcDate, strideArea, aggregateCandles } from "../server/connectors/chart-series.js";
import { manifest as stocksManifest } from "../server/connectors/stocks/index.js";
import { manifest as cryptoManifest } from "../server/connectors/crypto/index.js";
import * as fmp from "../server/connectors/stocks/financialmodelingprep.js";
import * as coingecko from "../server/connectors/crypto/coingecko.js";
import * as coinmarketcap from "../server/connectors/crypto/coinmarketcap.js";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => null },
  };
}

// ─── pure: series invariants ─────────────────────────────────────────────────

test("dedupeAscending: sorts, keeps the LAST point per time (the live-tail rule)", () => {
  const day = 86400000;
  const d0 = Date.UTC(2026, 7, 23);
  // The verified CoinGecko shape: yesterday 00:00, today 00:00, today's live tail.
  const daily = [
    { d: utcDate(d0 - day), p: 1 },
    { d: utcDate(d0), p: 2 },
    { d: utcDate(d0 + 12 * 60000), p: 2.5 }, // same UTC date as the midnight point
  ];
  assert.deepEqual(dedupeAscending(daily, "d"), [
    { d: "2026-08-22", p: 1 },
    { d: "2026-08-23", p: 2.5 }, // the tail won — fresher price
  ]);
  // Numeric key: unordered input comes back ascending, dupes collapse to last.
  assert.deepEqual(dedupeAscending([{ t: 3, p: 30 }, { t: 1, p: 10 }, { t: 3, p: 31 }], "t"),
    [{ t: 1, p: 10 }, { t: 3, p: 31 }]);
});

test("strideArea: bounds the series, keeps first and last", () => {
  const points = Array.from({ length: 5000 }, (_, i) => ({ t: i, p: i }));
  const out = strideArea(points, 2000);
  assert.equal(out.length, 2000);
  assert.equal(out[0].t, 0);
  assert.equal(out[out.length - 1].t, 4999);
  assert.equal(strideArea(points.slice(0, 10), 2000).length, 10, "small series untouched");
});

test("aggregateCandles: calendar buckets with honest OHLC, never a stride", () => {
  // ~3 years of weekday-ish daily bars → weekly buckets.
  const bars = [];
  const start = Date.UTC(2020, 0, 6); // a Monday
  for (let i = 0; i < 900; i++) {
    const t = start + i * 86400000;
    bars.push({ d: utcDate(t), o: i, h: i + 2, l: i - 1, c: i + 1 });
  }
  const weekly = aggregateCandles(bars, 400);
  assert.ok(weekly.length <= 400 && weekly.length > 100, `weekly bucket count ${weekly.length}`);
  // First bucket = first ISO week: opens on the first bar's open/date, closes
  // on the last bar of that week, spans the extremes.
  assert.equal(weekly[0].d, "2020-01-06");
  assert.equal(weekly[0].o, 0);
  assert.equal(weekly[0].c, 7); // 7th day of the week (i=6) closed at i+1
  assert.equal(weekly[0].h, 8); // max h in the bucket (i=6 → 8)
  assert.equal(weekly[0].l, -1);
  assert.equal(aggregateCandles(bars.slice(0, 50), 400).length, 50, "small series untouched");
});

// ─── pure: the domain vocabulary ─────────────────────────────────────────────

test("both finance domains declare the full chart surface — never a provider's tier", () => {
  const FULL = ["1d", "5d", "1m", "6m", "ytd", "1y", "5y", "max"];
  for (const m of [stocksManifest, cryptoManifest]) {
    assert.deepEqual(m.chart.ranges, FULL);
    assert.deepEqual(m.chart.kinds, ["area", "candles"]);
    assert.equal(m.chart.defaultRange, "1y");
  }
});

// ─── FMP chart() ─────────────────────────────────────────────────────────────

const FMP_BARS = [
  // Newest-first, two sessions — the endpoint's real ordering.
  { date: "2026-08-21 15:55:00", open: 10, high: 11, low: 9, close: 10.5 },
  { date: "2026-08-21 09:30:00", open: 9, high: 10, low: 8.5, close: 10 },
  { date: "2026-08-20 15:55:00", open: 8, high: 9, low: 7, close: 8.5 },
];

test("FMP 1d: last session only, ascending exchange-as-UTC; one fetch serves both kinds", async () => {
  fmp._resetChartCache();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("/historical-chart/5min?")) return response(FMP_BARS);
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const area = await fmp.chart("intc", { range: "1d", kind: "area" }, { apiKey: "k" });
    assert.equal(area.time, "intraday");
    assert.equal(area.tz, "utc");
    assert.deepEqual(area.points, [
      { t: Date.parse("2026-08-21T09:30:00Z"), p: 10 },
      { t: Date.parse("2026-08-21T15:55:00Z"), p: 10.5 },
    ]);
    const candles = await fmp.chart("INTC", { range: "1d", kind: "candles" }, { apiKey: "k" });
    assert.deepEqual(candles.points[0], { t: Date.parse("2026-08-21T09:30:00Z"), o: 9, h: 10, l: 8.5, c: 10 });
    assert.equal(seen.length, 1, "kind flip is a cache hit — zero extra HTTP");
    assert.ok(seen[0].includes("symbol=INTC"), "symbol uppercased");
  } finally {
    globalThis.fetch = original;
  }
});

test("FMP 5d: a generous calendar window trims to the last five sessions", async () => {
  fmp._resetChartCache();
  const original = globalThis.fetch;
  // Six session dates of 30-min bars, newest-first — the oldest must fall away.
  const rows = [];
  for (let day = 14; day <= 19; day++) {
    rows.push({ date: `2026-08-${day} 10:00:00`, open: day, high: day + 1, low: day - 1, close: day + 0.5 });
  }
  rows.reverse();
  globalThis.fetch = async (url) => {
    if (String(url).includes("/historical-chart/30min?")) return response(rows);
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const out = await fmp.chart("AAA", { range: "5d", kind: "area" }, { apiKey: "k" });
    const days = [...new Set(out.points.map((p) => new Date(p.t).toISOString().slice(0, 10)))];
    assert.deepEqual(days, ["2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("FMP intraday ladder: a 402/403 steps down and the rung is remembered; 401 stays transient", async () => {
  fmp._resetChartCache();
  const original = globalThis.fetch;
  let seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("/historical-chart/5min?")) return response({ "Error Message": "Exclusive Endpoint" }, 403);
    if (String(url).includes("/historical-chart/30min?")) return response(FMP_BARS);
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const out = await fmp.chart("AAA", { range: "1d", kind: "area" }, { apiKey: "k" });
    assert.equal(out.points.length, 2);
    assert.deepEqual(seen.map((u) => u.match(/historical-chart\/(\w+)\?/)[1]), ["5min", "30min"]);

    // The winning rung is remembered: a DIFFERENT symbol skips the dead probe.
    seen = [];
    await fmp.chart("BBB", { range: "1d", kind: "area" }, { apiKey: "k" });
    assert.deepEqual(seen.map((u) => u.match(/historical-chart\/(\w+)\?/)[1]), ["30min"]);

    // 401 is a bad key, not capability — no ladder, no unsupported.
    fmp._resetChartCache();
    seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return response({ "Error Message": "Invalid API KEY" }, 401);
    };
    await assert.rejects(
      fmp.chart("CCC", { range: "1d", kind: "area" }, { apiKey: "bad" }),
      (e) => e.status === 401 && !e.unsupported
    );
    assert.equal(seen.length, 1, "no rung walked on a non-gate error");
  } finally {
    globalThis.fetch = original;
  }
});

test("FMP intraday fully gated → unsupported; gated EOD → unsupported; unmapped range refuses", async () => {
  fmp._resetChartCache();
  const original = globalThis.fetch;
  globalThis.fetch = async () => response({ "Error Message": "Exclusive Endpoint" }, 402);
  try {
    await assert.rejects(fmp.chart("AAA", { range: "1d", kind: "area" }, { apiKey: "k" }),
      (e) => e.unsupported === true);
    await assert.rejects(fmp.chart("AAA", { range: "1y", kind: "area" }, { apiKey: "k" }),
      (e) => e.unsupported === true);
    // A range the module has no mapping for refuses like the siblings — never
    // some other window served under its label (zero HTTP: fetch would throw).
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    await assert.rejects(fmp.chart("AAA", { range: "3m", kind: "area" }, { apiKey: "k" }),
      (e) => e.unsupported === true);
  } finally {
    globalThis.fetch = original;
  }
});

test("FMP EOD: closes vs OHLC from one fetch; max strides area and weekly-buckets candles", async () => {
  fmp._resetChartCache();
  const original = globalThis.fetch;
  const rows = [];
  const start = Date.UTC(2016, 0, 4);
  for (let i = 0; i < 2600; i++) {
    const d = utcDate(start + i * 86400000);
    rows.push({ date: d, open: i, high: i + 2, low: i - 1, close: i + 1 });
  }
  rows.reverse(); // the endpoint answers newest-first
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).includes("/historical-price-eod/full?")) return response(rows);
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const area = await fmp.chart("AAA", { range: "max", kind: "area" }, { apiKey: "k" });
    assert.equal(area.time, "daily");
    assert.equal(area.points.length, 2000, "area strided to the bound");
    assert.equal(area.points[0].d, "2016-01-04");
    assert.equal(area.points[0].p, 1, "area plots the close");
    const candles = await fmp.chart("AAA", { range: "max", kind: "candles" }, { apiKey: "k" });
    assert.ok(candles.points.length <= 400, `candles aggregated (${candles.points.length})`);
    assert.equal(candles.points[0].o, 0, "bucket opens on the first bar's open");
    assert.equal(calls, 1, "both kinds from one cached fetch");
  } finally {
    globalThis.fetch = original;
  }
});

// ─── CoinGecko chart() ───────────────────────────────────────────────────────

test("CoinGecko area: exact days per range; 1d is 5-min epochs, 6m is deduped date strings", async () => {
  coingecko._resetChartCache();
  const original = globalThis.fetch;
  const day = 86400000;
  const d0 = Date.UTC(2026, 7, 21);
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("days=180")) {
      // Daily stamps + the live tail on the same UTC date (verified shape).
      return response({ prices: [[d0, 1], [d0 + day, 2], [d0 + 2 * day, 3], [d0 + 2 * day + 720000, 3.5]] });
    }
    if (/[?&]days=1$/.test(String(url))) {
      return response({ prices: [[d0, 10], [d0 + 300000, 10.5]] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const oneDay = await coingecko.chart("bitcoin", { range: "1d", kind: "area" }, {});
    assert.equal(oneDay.time, "intraday");
    assert.equal(oneDay.tz, "local");
    assert.deepEqual(oneDay.points, [{ t: d0, p: 10 }, { t: d0 + 300000, p: 10.5 }]);
    const sixMonths = await coingecko.chart("bitcoin", { range: "6m", kind: "area" }, {});
    assert.equal(sixMonths.time, "daily");
    assert.deepEqual(sixMonths.points, [
      { d: "2026-08-21", p: 1 },
      { d: "2026-08-22", p: 2 },
      { d: "2026-08-23", p: 3.5 }, // live tail deduped, tail wins
    ]);
    assert.ok(seen[0].includes("/market_chart?"), "area rides market_chart");
  } finally {
    globalThis.fetch = original;
  }
});

test("CoinGecko candles: covering enum + trim (5d → days=7); past 365d refuses with zero HTTP", async () => {
  coingecko._resetChartCache();
  const original = globalThis.fetch;
  const seen = [];
  const now = Date.now();
  const bars = Array.from({ length: 42 }, (_, i) => {
    const t = now - (41 - i) * 4 * 3600000; // 7 days of 4-hour candles ending now
    return [t, 10, 11, 9, 10.5];
  });
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("/ohlc?")) return response(bars);
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const out = await coingecko.chart("bitcoin", { range: "5d", kind: "candles" }, {});
    assert.ok(seen[0].includes("days=7"), "smallest covering enum");
    assert.equal(out.time, "intraday");
    const cutoff = now - 5 * 86400000;
    assert.ok(out.points.length < 42 && out.points.length >= 29, `trimmed to the window (${out.points.length})`);
    assert.ok(out.points.every((p) => p.t >= cutoff), "nothing older than the asked window");

    seen.length = 0;
    await assert.rejects(coingecko.chart("bitcoin", { range: "5y", kind: "area" }, {}),
      (e) => e.unsupported === true);
    await assert.rejects(coingecko.chart("bitcoin", { range: "max", kind: "candles" }, {}),
      (e) => e.unsupported === true);
    assert.equal(seen.length, 0, "host-cap refusals are synchronous — zero HTTP");
  } finally {
    globalThis.fetch = original;
  }
});

test("CoinGecko: area and candles cache separately per (id, range, kind)", async () => {
  coingecko._resetChartCache();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).includes("/market_chart?")) return response({ prices: [[Date.UTC(2026, 7, 20), 1]] });
    if (String(url).includes("/ohlc?")) return response([[Date.UTC(2026, 7, 20), 1, 2, 0.5, 1.5]]);
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    await coingecko.chart("bitcoin", { range: "1m", kind: "area" }, {});
    await coingecko.chart("bitcoin", { range: "1m", kind: "candles" }, {});
    await coingecko.chart("bitcoin", { range: "1m", kind: "area" }, {});
    await coingecko.chart("bitcoin", { range: "1m", kind: "candles" }, {});
    assert.equal(calls, 2, "one metered fetch per kind, repeats served from cache");
  } finally {
    globalThis.fetch = original;
  }
});

// ─── CoinMarketCap chart() ───────────────────────────────────────────────────

test("CMC area: the interval ladder steps down on a plan gate and remembers the rung", async () => {
  coinmarketcap._resetChartCache();
  const original = globalThis.fetch;
  let seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("interval=5m")) {
      return response({ status: { error_message: "Your plan doesn't support this time range" } }, 403);
    }
    if (String(url).includes("interval=1h")) {
      return response({ data: { quotes: [
        { timestamp: "2026-08-23T10:00:00.000Z", quote: { USD: { price: 5 } } },
        { timestamp: "2026-08-23T11:00:00.000Z", quote: { USD: { price: 6 } } },
      ] } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const out = await coinmarketcap.chart("77", { range: "1d", kind: "area" }, { apiKey: "k" });
    assert.equal(out.time, "intraday");
    assert.deepEqual(out.points.map((p) => p.p), [5, 6]);
    assert.deepEqual(seen.map((u) => u.match(/interval=(\w+)/)[1]), ["5m", "1h"]);

    // Remembered rung: a different coin skips the gated 5m probe.
    seen = [];
    await coinmarketcap.chart("88", { range: "1d", kind: "area" }, { apiKey: "k" });
    assert.deepEqual(seen.map((u) => u.match(/interval=(\w+)/)[1]), ["1h"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("CMC area: a month-scale ladder falls from hourly to daily and encodes date strings", async () => {
  coinmarketcap._resetChartCache();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("interval=1h")) {
      return response({ status: { error_message: "Your plan doesn't support this time range" } }, 403);
    }
    if (String(url).includes("interval=1d")) {
      return response({ data: { quotes: [
        { timestamp: "2026-08-20T00:00:00.000Z", quote: { USD: { price: 1 } } },
        { timestamp: "2026-08-21T00:00:00.000Z", quote: { USD: { price: 2 } } },
      ] } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const out = await coinmarketcap.chart("77", { range: "1m", kind: "area" }, { apiKey: "k" });
    assert.deepEqual(seen.map((u) => u.match(/interval=(\w+)/)[1]), ["1h", "1d"]);
    assert.equal(out.time, "daily", "the daily rung encodes as dates, not epochs");
    assert.deepEqual(out.points, [{ d: "2026-08-20", p: 1 }, { d: "2026-08-21", p: 2 }]);
  } finally {
    globalThis.fetch = original;
  }
});

test("CMC candles: OHLCV daily (keyed payload shape); plan gate → unsupported; 5xx stays transient", async () => {
  coinmarketcap._resetChartCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/ohlcv/historical?")) {
      return response({ data: { 77: { quotes: [
        { time_open: "2026-08-20T00:00:00.000Z", quote: { USD: { open: 1, high: 2, low: 0.5, close: 1.5 } } },
        { time_open: "2026-08-21T00:00:00.000Z", quote: { USD: { open: 1.5, high: 3, low: 1, close: 2 } } },
      ] } } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const out = await coinmarketcap.chart("77", { range: "1m", kind: "candles" }, { apiKey: "k" });
    assert.equal(out.time, "daily");
    assert.deepEqual(out.points[0], { d: "2026-08-20", o: 1, h: 2, l: 0.5, c: 1.5 });

    coinmarketcap._resetChartCache();
    globalThis.fetch = async () =>
      response({ status: { error_message: "Your subscription plan doesn't support this endpoint" } }, 403);
    await assert.rejects(coinmarketcap.chart("77", { range: "1m", kind: "candles" }, { apiKey: "k" }),
      (e) => e.unsupported === true);

    coinmarketcap._resetChartCache();
    globalThis.fetch = async () => response({}, 500);
    await assert.rejects(coinmarketcap.chart("77", { range: "1m", kind: "candles" }, { apiKey: "k" }),
      (e) => !e.unsupported && e.status === 500);
  } finally {
    globalThis.fetch = original;
  }
});

// ─── runtime: chartSeries + the learned-availability model ───────────────────

let srv, db, base, admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  await installConnectors(db, "gauges:meter", "chartstub:stub", "nochart:p");
});
after(() => srv.close());

const VOCAB = { ranges: ["1d", "1m", "1y"], kinds: ["area", "candles"], defaultRange: "1y" };

// A stub domain around a chart fn; `calls` records every (range, kind) asked.
function gaugesConn(chartFn) {
  const calls = [];
  const meter = {
    label: "Meter",
    async search(q) { return [{ id: `resolved-${q}`.toLowerCase(), symbol: String(q).toUpperCase() }]; },
    async fetchEntity() { return {}; },
    ...(chartFn
      ? { async chart(id, { range, kind }, ctx) { calls.push([id, range, kind]); return chartFn(id, { range, kind }, ctx); } }
      : {}),
  };
  const conn = { name: "gauges", providers: { meter }, defaultProvider: "meter", manifest: { chart: VOCAB } };
  return { conn, calls };
}

const ENTITY = { id: 1, symbol: "GG" };
const SOURCE = { provider: "meter", id: "gg" };
const SERVED = { time: "daily", tz: "local", points: [{ d: "2026-01-02", p: 1 }] };

test("chartSeries: no capability → null; clamps foreign range/kind and echoes the offer", async () => {
  runtime._resetChartLearned();
  const bare = gaugesConn(null);
  assert.equal(await runtime.chartSeries(db, bare.conn, ENTITY, SOURCE, { range: "1y", kind: "area" }), null);

  const noVocab = gaugesConn(async () => SERVED);
  noVocab.conn.manifest = {};
  assert.equal(await runtime.chartSeries(db, noVocab.conn, ENTITY, SOURCE, { range: "1y", kind: "area" }), null);

  const { conn, calls } = gaugesConn(async () => SERVED);
  const out = await runtime.chartSeries(db, conn, ENTITY, SOURCE, { range: "7d", kind: "bogus" });
  assert.equal(out.range, "1y", "foreign range clamps to the default");
  assert.equal(out.kind, "area", "foreign kind clamps to the first offered");
  assert.deepEqual(out.ranges, VOCAB.ranges);
  assert.deepEqual(out.kinds, VOCAB.kinds);
  assert.equal(out.provider, "meter");
  assert.deepEqual(out.points, SERVED.points);
  assert.deepEqual(calls, [["gg", "1y", "area"]]);
});

test("chartSeries: an unsupported pair is learned, served around, reported once — and never re-probed", async () => {
  runtime._resetChartLearned();
  const { conn, calls } = gaugesConn(async (id, { range, kind }) => {
    if (range === "1d" && kind === "area") throw unsupported("meter: no 1d area");
    return SERVED;
  });

  const first = await runtime.chartSeries(db, conn, ENTITY, SOURCE, { range: "1d", kind: "area" });
  assert.deepEqual(first.unavailable, { range: "1d", kind: "area" });
  assert.equal(first.range, "1d", "the range survives via its other kind");
  assert.equal(first.kind, "candles");
  assert.deepEqual(first.kinds, ["candles"], "kinds echo the served range's live flavours");
  assert.ok(first.ranges.includes("1d"), "the range stays offered while a kind lives");
  assert.deepEqual(calls, [["gg", "1d", "area"], ["gg", "1d", "candles"]]);

  const second = await runtime.chartSeries(db, conn, ENTITY, SOURCE, { range: "1d", kind: "area" });
  assert.equal(second.kind, "candles");
  assert.equal(second.unavailable, undefined, "already learned — nothing newly refused");
  assert.equal(calls.length, 3, "the dead pair is never probed again");
});

test("chartSeries: a fully dead range drops out of the offer; transient throws learn nothing", async () => {
  runtime._resetChartLearned();
  const dead = gaugesConn(async (id, { range }) => {
    if (range === "1d") throw unsupported("meter: no 1d at all");
    return SERVED;
  });
  const out = await runtime.chartSeries(db, dead.conn, ENTITY, SOURCE, { range: "1d", kind: "area" });
  assert.equal(out.range, "1y", "clamped to the default after both kinds died");
  assert.deepEqual(out.unavailable, { range: "1d", kind: "area" }, "the FIRST refusal is the one reported");
  assert.ok(!out.ranges.includes("1d"));
  assert.equal(dead.calls.length, 3);

  runtime._resetChartLearned();
  const flaky = gaugesConn(async () => { throw new Error("meter exploded"); });
  await assert.rejects(runtime.chartSeries(db, flaky.conn, ENTITY, SOURCE, { range: "1d", kind: "area" }),
    /meter exploded/);
  await assert.rejects(runtime.chartSeries(db, flaky.conn, ENTITY, SOURCE, { range: "1d", kind: "area" }));
  assert.equal(flaky.calls.length, 2, "transient failures are retried next request — nothing learned");
});

test("chartSeries: the asked KIND survives a range fallback (the live-caught 5y-area → 1y-candles drift)", async () => {
  runtime._resetChartLearned();
  // The CoinGecko-live shape: the whole "1d" range refuses (both kinds), so a
  // request for (1d, area) must fall back to the default range WITH area — not
  // stranded on candles because the intermediate probe borrowed that kind.
  const { conn, calls } = gaugesConn(async (id, { range }) => {
    if (range === "1d") throw unsupported("range dead");
    return SERVED;
  });
  const out = await runtime.chartSeries(db, conn, ENTITY, SOURCE, { range: "1d", kind: "area" });
  assert.equal(out.range, "1y");
  assert.equal(out.kind, "area", "the asked kind wins again once the range serves it");
  assert.deepEqual(calls.map(([, r, k]) => `${r}|${k}`), ["1d|area", "1d|candles", "1y|area"]);
});

test("chartSeries: a fully dead provider is depth-capped, then 404s; TTL expiry re-probes", async () => {
  runtime._resetChartLearned();
  const { conn, calls } = gaugesConn(async () => { throw unsupported("meter: nothing at all"); });
  const out = await runtime.chartSeries(db, conn, ENTITY, SOURCE, { range: "1y", kind: "area" });
  assert.equal(out, null, "exhausted offer → null → the route's 404");
  assert.equal(calls.length, 4, "depth cap bounds discovery on one request");

  // Aging past the TTL re-opens the learned pairs.
  runtime._ageChartLearned(7 * 60 * 60 * 1000);
  calls.length = 0;
  const served = gaugesConn(async () => SERVED);
  const back = await runtime.chartSeries(db, served.conn, ENTITY, SOURCE, { range: "1y", kind: "area" });
  assert.deepEqual(back.ranges, VOCAB.ranges, "expired learning restores the full offer");
});

test("chartSeries: learned state is per key — a swapped key gets a fresh bucket", async () => {
  runtime._resetChartLearned();
  await setSetting(db, "gauges_key_meter", "OLD-KEY");
  let gate = true;
  const { conn, calls } = gaugesConn(async (id, { range, kind }) => {
    if (gate && range === "1d" && kind === "area") throw unsupported("gated under OLD-KEY");
    return SERVED;
  });
  await runtime.chartSeries(db, conn, ENTITY, SOURCE, { range: "1d", kind: "area" });
  calls.length = 0;
  await runtime.chartSeries(db, conn, ENTITY, SOURCE, { range: "1d", kind: "area" });
  assert.deepEqual(calls, [["gg", "1d", "candles"]], "old key: the dead pair is skipped");

  gate = false; // the new key's plan serves it
  await setSetting(db, "gauges_key_meter", "NEW-KEY");
  calls.length = 0;
  const out = await runtime.chartSeries(db, conn, ENTITY, SOURCE, { range: "1d", kind: "area" });
  assert.equal(out.kind, "area", "fresh bucket probed the pair again, instantly");
  await setSetting(db, "gauges_key_meter", "");
});

test("chartSeries: an unsupported outcome heals the plugin ledger; a transient one marks it", async () => {
  runtime._resetChartLearned();
  const gated = gaugesConn(async () => { throw unsupported("plan says no"); });
  await runtime.chartSeries(db, gated.conn, ENTITY, SOURCE, { range: "1y", kind: "area" });
  let row = await getPluginRow(db, "gauges:meter");
  assert.equal(row.last_error, null, "a refusal is the plan working as sold — no error ledgered");

  runtime._resetChartLearned();
  const flaky = gaugesConn(async () => { throw new Error("wire down"); });
  await assert.rejects(runtime.chartSeries(db, flaky.conn, ENTITY, SOURCE, { range: "1y", kind: "area" }));
  row = await getPluginRow(db, "gauges:meter");
  assert.match(row.last_error.message, /wire down/, "a transient failure IS ledgered");

  runtime._resetChartLearned();
  await runtime.chartSeries(db, gated.conn, ENTITY, SOURCE, { range: "1y", kind: "area" });
  row = await getPluginRow(db, "gauges:meter");
  assert.equal(row.last_error, null, "the next coherent answer heals the row");
  assert.equal(row.fail_count, 0);
});

test("chartSeries: a SYNCHRONOUSLY-throwing unsupported (non-async plugin shape) still refuses cleanly", async () => {
  runtime._resetChartLearned();
  const calls = [];
  const meter = {
    label: "Meter",
    async search() { return []; },
    async fetchEntity() { return {}; },
    chart(id, { range, kind }) { // deliberately NOT async — throws before any await
      calls.push([range, kind]);
      if (range === "1d") throw unsupported("sync refusal");
      return Promise.resolve(SERVED);
    },
  };
  const conn = { name: "gauges", providers: { meter }, defaultProvider: "meter", manifest: { chart: VOCAB } };
  const out = await runtime.chartSeries(db, conn, ENTITY, SOURCE, { range: "1d", kind: "area" });
  assert.equal(out.range, "1y", "the sync refusal was learned and routed around");
  assert.deepEqual(out.unavailable, { range: "1d", kind: "area" });
  const row = await getPluginRow(db, "gauges:meter");
  assert.equal(row.last_error, null, "the marker dance caught the sync throw — no error ledgered");
});

test("chartSeries: a provider-switched entity re-resolves its id by symbol", async () => {
  runtime._resetChartLearned();
  const { conn, calls } = gaugesConn(async () => SERVED);
  const out = await runtime.chartSeries(db, conn, ENTITY, { provider: "elsewhere", id: "x9" }, { range: "1y", kind: "area" });
  assert.ok(out);
  assert.deepEqual(calls, [["resolved-gg", "1y", "area"]], "the foreign handle is re-resolved, not trusted");
});

// ─── the route ───────────────────────────────────────────────────────────────

const STUB_VOCAB = { ranges: ["1d", "1y"], kinds: ["area", "candles"], defaultRange: "1y" };

before(async () => {
  registerConnector("chartstub", {
    providers: {
      stub: {
        label: "Stub",
        attribution: { text: "Data by Stub", url: "https://stub.example" },
        async search() { return []; },
        async fetchEntity() { return {}; },
        async chart(id, { range, kind }) {
          if (id === "explode") throw new Error("stub blew a fuse");
          return { time: "daily", tz: "local", points: [{ d: "2026-01-02", p: 1 }, { d: "2026-01-03", p: 2 }] };
        },
      },
    },
    defaultProvider: "stub",
    manifest: { label: "Chartstub", chart: STUB_VOCAB },
  });
  registerConnector("nochart", {
    providers: { p: { label: "P", async search() { return []; }, async fetchEntity() { return {}; } } },
    defaultProvider: "p",
    manifest: { label: "NC", chart: STUB_VOCAB },
  });
});
after(() => {
  unregisterConnector("chartstub");
  unregisterConnector("nochart");
});

async function seedChartEntity(connectorName, sourceId = "gg") {
  const boardId = await createBoard(db, `board-${connectorName}-${sourceId}`, [], "", true, null, null, {}, false, {
    mapping: { input: { connector: connectorName }, identity: { source: "connector" }, fields: [] },
  });
  const entityId = await createEntity(db, boardId, { identity: "gg", displayName: "Gadget", symbol: "GG" });
  await insertItem(db, boardId,
    { identity: "gg", source: { provider: connectorName === "chartstub" ? "stub" : "p", id: sourceId }, files: [], fields: {} },
    "tagged", entityId);
  return { boardId, entityId };
}

test("GET /api/items/:id/chart: auth + ACL + the wire contract", async () => {
  runtime._resetChartLearned();
  const { entityId } = await seedChartEntity("chartstub");

  assert.equal((await req(base, "GET", `/api/items/${entityId}/chart`)).status, 401, "no session");

  const outsider = await seedUser(db, "outsider@test.local");
  assert.equal((await req(base, "GET", `/api/items/${entityId}/chart`, { sid: outsider.sid })).status, 404,
    "not a member → indistinguishable from missing");

  const r = await req(base, "GET", `/api/items/${entityId}/chart?range=1d&kind=area`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.symbol, "GG");
  assert.equal(r.json.name, "Gadget");
  assert.equal(r.json.provider, "stub");
  assert.deepEqual(r.json.attribution, { text: "Data by Stub", url: "https://stub.example" });
  assert.equal(r.json.range, "1d");
  assert.equal(r.json.kind, "area");
  assert.deepEqual(r.json.ranges, STUB_VOCAB.ranges);
  assert.deepEqual(r.json.kinds, STUB_VOCAB.kinds);
  assert.equal(r.json.time, "daily");
  assert.equal(r.json.tz, "local");
  assert.equal(r.json.points.length, 2);

  // A foreign stored pref self-corrects via the clamp + echo.
  const clamped = await req(base, "GET", `/api/items/${entityId}/chart?range=5y&kind=heikin`, { sid: admin.sid });
  assert.equal(clamped.json.range, "1y");
  assert.equal(clamped.json.kind, "area");
});

test("GET /api/items/:id/chart: 404 off the connector path, 404 without capability, 502 transient", async () => {
  const plain = await seedItem(db, await seedBoard(db, "plain-files"));
  const r404 = await req(base, "GET", `/api/items/${plain.id}/chart`, { sid: admin.sid });
  assert.equal(r404.status, 404, "a files board has no live chart");

  const { entityId: chartless } = await seedChartEntity("nochart");
  assert.equal((await req(base, "GET", `/api/items/${chartless}/chart`, { sid: admin.sid })).status, 404,
    "a provider without chart() keeps the static face");

  const { entityId: boom } = await seedChartEntity("chartstub", "explode");
  const r502 = await req(base, "GET", `/api/items/${boom}/chart`, { sid: admin.sid });
  assert.equal(r502.status, 502);
  assert.match(r502.json.error, /blew a fuse/, "the provider's message survives verbatim");
});
