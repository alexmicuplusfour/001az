// The usage meter (planning/metering-plan.md, Stage 1) — the generic
// mechanism: "N units of `unit` consumed by this subject", dimensions as
// plain text with '' sentinels, one row per unit. The AI adapter
// (meterAiCall) translates the wire's usage shape and swallows failures —
// the meter observes jobs, it never breaks them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard } from "./helpers.js";
import { meter, meterWrite, boardUsageSummary, pruneUsageMeter, deleteBoard, addModelPrice } from "../server/db.js";
import { meterAiCall, meterAiCalls, priceUnpricedHistory } from "../server/metering.js";
import { refreshRateTable, ratesFor, setModelPrice, wantedModels } from "../server/pricing.js";
import { registerProvider, unregisterProvider, PROVIDERS } from "../server/providers.js";

let srv, db;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
});
after(() => srv.close());

const rowsFor = async (boardId) =>
  (await db.query(
    "SELECT capability, provider, model, unit, quantity FROM usage_meter WHERE board_id=$1 ORDER BY capability, provider, model, unit",
    [boardId]
  )).rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));

// The Stage 3 columns, for the pricing tests below.
const costRows = async (boardId) =>
  (await db.query(
    "SELECT unit, quantity, priced_quantity, cost_micros FROM usage_meter WHERE board_id=$1 ORDER BY unit",
    [boardId]
  )).rows.map((r) => ({ unit: r.unit, q: Number(r.quantity), pq: Number(r.priced_quantity), cm: Number(r.cost_micros) }));

test("meter: accumulates per dimension, and different models stay separate rows", async () => {
  const b = await seedBoard(db, "meter-dims");
  const dims = { boardId: b, capability: "tag", provider: "p", model: "cheap" };
  await meter(db, dims, { input_tokens: 100, requests: 1 });
  await meter(db, dims, { input_tokens: 50, requests: 1 });
  // Same board, same day, different model — the row the old (day, board)
  // rollup could never keep apart, i.e. the reason Stage 1 exists.
  await meter(db, { ...dims, model: "sharp" }, { input_tokens: 7, requests: 1 });

  assert.deepEqual(await rowsFor(b), [
    { capability: "tag", provider: "p", model: "cheap", unit: "input_tokens", quantity: 150 },
    { capability: "tag", provider: "p", model: "cheap", unit: "requests", quantity: 2 },
    { capability: "tag", provider: "p", model: "sharp", unit: "input_tokens", quantity: 7 },
    { capability: "tag", provider: "p", model: "sharp", unit: "requests", quantity: 1 },
  ]);
});

test("meter: the '' sentinels upsert — a nullable dimension would append instead", async () => {
  // App-level spend: no board, no model. Two writes must land in ONE row,
  // which is exactly what NULL dimensions would silently break (Postgres
  // treats NULLs as distinct in unique indexes).
  await meter(db, { capability: "sweep" }, { requests: 1 });
  await meter(db, { capability: "sweep" }, { requests: 1 });
  const rows = await rowsFor("");
  assert.deepEqual(rows, [{ capability: "sweep", provider: "", model: "", unit: "requests", quantity: 2 }]);
});

test("meter: zero and absent quantities write no rows", async () => {
  const b = await seedBoard(db, "meter-zeros");
  await meter(db, { boardId: b, capability: "tag" }, { input_tokens: 0, output_tokens: undefined });
  assert.deepEqual(await rowsFor(b), []);
});

test("meterAiCall: translates the wire shape, requests included, zeros skipped", async () => {
  const b = await seedBoard(db, "meter-ai");
  await meterAiCall(db, b, { capability: "tag", provider: "anthropic", model: "m" },
    { input: 10, output: 3, cacheRead: 0, searches: 0 });
  // No cache_read_tokens / web_searches rows — the common no-cache, no-search
  // call writes only what it has news for.
  assert.deepEqual((await rowsFor(b)).map((r) => [r.unit, r.quantity]),
    [["input_tokens", 10], ["output_tokens", 3], ["requests", 1]]);
});

test("meterAiCalls: N passes fold into one write, and `requests` still counts N", async () => {
  const b = await seedBoard(db, "meter-votes");
  // A vote round: three paid calls, one attribution. The stored numbers must
  // be identical to three separate meterAiCall writes.
  await meterAiCalls(db, b, { capability: "tag", provider: "p", model: "m" }, [
    { input: 10, output: 1 }, { input: 10, output: 2 }, { input: 10, output: 3, cacheRead: 5 },
  ]);
  assert.deepEqual((await rowsFor(b)).map((r) => [r.unit, r.quantity]),
    [["cache_read_tokens", 5], ["input_tokens", 30], ["output_tokens", 6], ["requests", 3]]);
  // Empty round writes nothing at all (no stray `requests: 0` row).
  const b2 = await seedBoard(db, "meter-novotes");
  await meterAiCalls(db, b2, { capability: "tag", provider: "p", model: "m" }, []);
  assert.deepEqual(await rowsFor(b2), []);
});

test("boardUsageSummary: reads the meter back as one board's units map", async () => {
  const b = await seedBoard(db, "meter-read");
  await meterAiCall(db, b, { capability: "tag", provider: "p", model: "m" },
    { input: 100, output: 20, searches: 2 });
  await meterAiCall(db, b, { capability: "diagnose", provider: "p", model: "m" },
    { input: 30, output: 5 });

  const u = await boardUsageSummary(db, b);
  // Every capability's spend rolls up together here, as a UNITS MAP (Stage
  // 5b): which units a surface features inline is its display choice, and a
  // unit this reader never heard of rides through untouched. Zero-quantity
  // units are absent, not zeroed.
  assert.deepEqual(u.units, { requests: 2, input_tokens: 130, output_tokens: 25, web_searches: 2 });
  // Provider "p" has no rates anywhere → nothing priced → no cost CLAIM.
  assert.equal(u.cost, null);
});

test("deleteBoard purges the board's meter rows (no FK to cascade)", async () => {
  const b = await seedBoard(db, "meter-delete");
  await meterAiCall(db, b, { capability: "tag", provider: "p", model: "m" }, { input: 1, output: 1 });
  assert.ok((await rowsFor(b)).length > 0);
  await deleteBoard(db, b);
  assert.deepEqual(await rowsFor(b), []);
});

test("pruneUsageMeter: takes only rows older than the cutoff", async () => {
  const b = await seedBoard(db, "meter-prune");
  await meter(db, { boardId: b, capability: "tag" }, { requests: 1 });
  await db.query("INSERT INTO usage_meter (day, board_id, capability, provider, model, unit, quantity) VALUES ('2000-01-01', $1, 'tag', '', '', 'requests', 5)", [b]);
  // The count is global (the prune is board-blind by design), so this board's
  // surviving rows are what's asserted precisely.
  const n = await pruneUsageMeter(db, Date.now() - 30 * 86400000);
  assert.ok(n >= 1);
  assert.deepEqual(await rowsFor(b), [{ capability: "tag", provider: "", model: "", unit: "requests", quantity: 1 }]);
});

// ─── Stage 3a: rating (planning/metering-plan.md, Mechanism 2) ───────────────

test("rates: stamping math is cost = round(quantity × rate), priced in full", async () => {
  const b = await seedBoard(db, "price-math");
  // A rate this test OWNS — pinning the arithmetic against a shipped
  // descriptor would make a routine vendor price update break a test that
  // isn't about that vendor.
  for (const [unit, microsPerUnit] of [["input_tokens", 3], ["cache_read_tokens", 0.1]])
    await setModelPrice(db, { provider: "priced-co", model: "m1", unit, microsPerUnit });

  await meterAiCall(db, b, { capability: "tag", provider: "priced-co", model: "m1" },
    { input: 1000, cacheRead: 305 });
  assert.deepEqual(await costRows(b), [
    { unit: "cache_read_tokens", q: 305, pq: 305, cm: 31 }, // 305 × 0.1 = 30.5 → 31
    { unit: "input_tokens", q: 1000, pq: 1000, cm: 3000 },
    // Nobody said what a CALL costs here, so it meters unpriced. Silence is
    // one thing everywhere: not-yet-known, never an implied $0.
    { unit: "requests", q: 1, pq: 0, cm: 0 },
  ]);
  // The roll-up: micros sum legally across units (one currency); the
  // remainder is only a FLAG at this grade — per-unit detail is the board's
  // own endpoint.
  assert.deepEqual((await boardUsageSummary(db, b)).cost, {
    micros: 3031,
    unpriced: [{ unit: "requests", label: "calls", format: "count", quantity: 1 }],
  });
});

test("rates: a descriptor's provider-wide entry applies under its per-model rates", async () => {
  const b = await seedBoard(db, "price-descriptor");
  await refreshRateTable(db);
  const r = ratesFor("anthropic", "claude-haiku-4-5");
  // The shipped descriptor is wired through to the rate table: real per-token
  // rates (their VALUES belong to anthropic.js, and are not restated here)...
  assert.ok(r.input_tokens > 0 && r.output_tokens > 0 && r.cache_read_tokens > 0);
  // ...plus `requests: 0` from the '*' entry — Anthropic bills tokens, not
  // calls, stated once for every model it serves.
  assert.equal(r.requests, 0);
  // Web search bills per search, but the rate isn't published machine-
  // readably. The descriptor omits it, so it stays unpriced rather than
  // guessed — the same silence, and it means the same thing.
  assert.equal(r.web_searches, undefined);

  await meterAiCall(db, b, { capability: "tag", provider: "anthropic", model: "claude-haiku-4-5" },
    { input: 1000, searches: 2 });
  const rows = await costRows(b);
  assert.deepEqual(rows.find((x) => x.unit === "requests"), { unit: "requests", q: 1, pq: 1, cm: 0 });
  assert.deepEqual(rows.find((x) => x.unit === "web_searches"), { unit: "web_searches", q: 2, pq: 0, cm: 0 });
});

test("rates: an unknown model meters unpriced — never a guess", async () => {
  const b = await seedBoard(db, "price-unknown");
  await refreshRateTable(db);
  // A typed-in model id: the provider-wide fact still holds (Anthropic bills
  // no provider per call), but nothing is known about ITS tokens.
  assert.deepEqual(ratesFor("anthropic", "some-typed-in-model"), { requests: 0 });
  await meterAiCall(db, b, { capability: "tag", provider: "anthropic", model: "some-typed-in-model" },
    { input: 500, output: 50 });
  assert.deepEqual(await costRows(b), [
    { unit: "input_tokens", q: 500, pq: 0, cm: 0 },
    { unit: "output_tokens", q: 50, pq: 0, cm: 0 },
    { unit: "requests", q: 1, pq: 1, cm: 0 },
  ]);
});

test("rates: on-device is $0 KNOWN — priced in full at zero cost", async () => {
  const b = await seedBoard(db, "price-free");
  await refreshRateTable(db);
  // `local` (the Xenova embedder) is onDevice, which install() normalizes into
  // an ordinary provider-wide `prices` declaration: every unit of every model
  // is free — a knowledge claim, not an absence.
  await meterAiCall(db, b, { capability: "embed", provider: "local", model: "bge-small-en-v1.5" },
    { input: 900 });
  assert.deepEqual(await costRows(b), [
    { unit: "input_tokens", q: 900, pq: 900, cm: 0 },
    { unit: "requests", q: 1, pq: 1, cm: 0 },
  ]);
});

test("rates: admin rung beats the descriptor, and a later edit never restamps history", async () => {
  const b = await seedBoard(db, "price-admin");
  await refreshRateTable(db);
  await meterAiCall(db, b, { capability: "tag", provider: "anthropic", model: "claude-haiku-4-5" }, { input: 1000 });
  // Admin types in a different price; the table rebuilds.
  await addModelPrice(db, { provider: "anthropic", model: "claude-haiku-4-5", unit: "input_tokens", microsPerUnit: 7 });
  await refreshRateTable(db);
  assert.equal(ratesFor("anthropic", "claude-haiku-4-5").input_tokens, 7);
  // The pre-edit stamp is untouched; the next call stamps at the new rate.
  await meterAiCall(db, b, { capability: "tag", provider: "anthropic", model: "claude-haiku-4-5" }, { input: 1000 });
  const input = (await costRows(b)).find((r) => r.unit === "input_tokens");
  assert.deepEqual(input, { unit: "input_tokens", q: 2000, pq: 2000, cm: 1000 + 7000 });
});

test("rates: a future-dated price row is not in effect yet", async () => {
  await addModelPrice(db, {
    provider: "anthropic", model: "claude-haiku-4-5", unit: "output_tokens",
    microsPerUnit: 999, effectiveFrom: Date.now() + 86400000,
  });
  await refreshRateTable(db);
  assert.equal(ratesFor("anthropic", "claude-haiku-4-5").output_tokens, 5); // still the descriptor's
});

test("rates: only a provider that names a community namespace is ever wanted (the self-hosted trap)", async () => {
  // The pair is the point: the SAME unknown model on two providers that differ
  // only in declaring a namespace. A self-hosted box serving "llama3" must not
  // inherit hosted llama3 prices, so it is never even looked up.
  registerProvider("hosted-co", { label: "Hosted", keyless: true, priceNamespace: "hosted-co" });
  registerProvider("selfhosted-co", { label: "SelfHosted", keyless: true });
  try {
    await refreshRateTable(db);
    ratesFor("hosted-co", "llama3");
    ratesFor("selfhosted-co", "llama3");
    const want = wantedModels();
    assert.ok(want.some((w) => w.provider === "hosted-co" && w.model === "llama3"), "namespaced → fetch list");
    assert.ok(!want.some((w) => w.provider === "selfhosted-co"), "no namespace → never fetched for");

    // And a learned price drops it from the list, rather than being requested
    // again on every sweep forever.
    await setModelPrice(db, { provider: "hosted-co", model: "llama3", unit: "input_tokens", microsPerUnit: 2, source: "community" });
    assert.ok(!wantedModels().some((w) => w.provider === "hosted-co"), "priced → no longer wanted");
  } finally {
    unregisterProvider("hosted-co");
    unregisterProvider("selfhosted-co");
  }
});

test("rates: a descriptor's prices are validated at the one registry write", async () => {
  // The stakes are what make this an install-time contract rather than a
  // read-time coercion: a rate typed wrong is multiplied into cost_micros and,
  // by design, never recomputed.
  assert.throws(() => registerProvider("bad-price", { label: "Bad", keyless: true, prices: { m1: { input_tokens: "3" } } }),
    /non-negative finite number/);
  assert.throws(() => registerProvider("bad-shape", { label: "Bad", keyless: true, prices: { m1: 3 } }),
    /must be an object/);
  // Zero is legal and load-bearing — "free" as a KNOWN price.
  assert.doesNotThrow(() => registerProvider("free-co", { label: "Free", keyless: true, prices: { "*": { "*": 0 } } }));
  unregisterProvider("free-co");
  assert.ok(!PROVIDERS["bad-price"], "a rejected descriptor never enters the registry");
});

test("price unpriced history: the remainder gets today's rate; priced history never moves", async () => {
  const b = await seedBoard(db, "price-history");
  registerProvider("history-co", { label: "History", keyless: true });
  try {
    await refreshRateTable(db);
    // Metered before any rung knew a rate — the $22-invisible shape.
    await meter(db, { boardId: b, capability: "tag", provider: "history-co", model: "late" },
      { input_tokens: 1000, requests: 2 }, ratesFor("history-co", "late"));
    // Metered at a rate that was KNOWN then — the write-time stamp this
    // action must never touch, however the rate moves afterwards.
    await meter(db, { boardId: b, capability: "tag", provider: "history-co", model: "early" },
      { input_tokens: 500 }, { input_tokens: 1 });

    // Rates arrive after the fact: a per-model rate for the latecomer, a
    // provider-wide $0 for its requests (the wildcard is the same one a
    // write resolves), and a REPRICING of the already-stamped model.
    await setModelPrice(db, { provider: "history-co", model: "late", unit: "input_tokens", microsPerUnit: 5 });
    await setModelPrice(db, { provider: "history-co", model: "*", unit: "requests", microsPerUnit: 0 });
    await setModelPrice(db, { provider: "history-co", model: "early", unit: "input_tokens", microsPerUnit: 9 });

    const first = await priceUnpricedHistory(db);
    assert.ok(first.rows >= 2 && first.micros >= 5000, "the action reports what it priced");
    const rows = (await db.query(
      "SELECT model, unit, quantity, priced_quantity, cost_micros FROM usage_meter WHERE board_id=$1 ORDER BY model, unit", [b]
    )).rows.map((r) => ({ model: r.model, unit: r.unit, q: Number(r.quantity), pq: Number(r.priced_quantity), cm: Number(r.cost_micros) }));
    assert.deepEqual(rows, [
      { model: "early", unit: "input_tokens", q: 500, pq: 500, cm: 500 }, // stamped at 1 then, 9 now — still 500
      { model: "late", unit: "input_tokens", q: 1000, pq: 1000, cm: 5000 }, // the remainder, at today's 5
      { model: "late", unit: "requests", q: 2, pq: 2, cm: 0 }, // $0 via the wildcard — priced, a knowledge claim
    ]);

    // Idempotent by nature: everything a rung can price is priced, and what
    // no rung can price (the ''-provider backfill, rateless pairs) is never
    // touched — so a second click finds nothing.
    assert.deepEqual(await priceUnpricedHistory(db), { rows: 0, micros: 0 });
  } finally {
    unregisterProvider("history-co");
  }
});

test("meter: the rates parameter is generic — a non-AI unit prices the same way", async () => {
  const b = await seedBoard(db, "price-generic");
  await meter(db, { boardId: b, capability: "sweep" }, { bytes: 1500 }, { bytes: 0.002 });
  assert.deepEqual(await costRows(b), [{ unit: "bytes", q: 1500, pq: 1500, cm: 3 }]);
});

test("cardinal rule: a broken meter never breaks the spender", async () => {
  const b = await seedBoard(db, "meter-broken");
  // The job-log trick: drop the table so the write path fails for real.
  await db.query("ALTER TABLE usage_meter RENAME TO usage_meter_gone");
  try {
    // Everything that routes through meterWrite swallows — the tag / extract /
    // diagnose landings must never see a metering blip as their own failure,
    // and neither must the Stage 5 spenders that haven't been written yet.
    await meterAiCall(db, b, { capability: "tag", provider: "p", model: "m" }, { input: 1 });
    await meterAiCalls(db, b, { capability: "tag", provider: "p", model: "m" }, [{ input: 1 }]);
    assert.equal(await meterWrite(() => meter(db, { boardId: b, capability: "embed" }, { requests: 1 })), null);
    // The mechanism itself is honest: raw meter() throws, so a caller that
    // wants the error can have it. Safety is meterWrite's contract, and a new
    // spender gets it by using the named wrapper rather than re-deriving it.
    await assert.rejects(() => meter(db, { boardId: b, capability: "tag" }, { requests: 1 }));
  } finally {
    await db.query("ALTER TABLE usage_meter_gone RENAME TO usage_meter");
  }
});
