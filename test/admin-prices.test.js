// The rate map's admin routes (metering-plan.md, Stages 3c + 4c): read the
// RESOLVED rate map with provenance, type a price in, force a learner pass.
// The GET is what the Usage tab's price editor binds to — it must see exactly
// what stamping sees (one resolution walk serves both). Admin-gated
// throughout: spend RATES are app configuration, not board data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, req, jsonBox } from "./helpers.js";
import { ratesFor, setModelPrices } from "../server/pricing.js";
import { registerProvider, unregisterProvider } from "../server/providers.js";
import { meter } from "../server/db.js";

let srv, db, base, admin, member, mapBox, envBefore;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  member = await seedUser(db, "pleb@test.local");
  mapBox = await jsonBox({
    "learnable-model": { litellm_provider: "adminns", mode: "chat", input_cost_per_token: 2e-6 },
  });
  envBefore = process.env.MODEL_PRICE_SOURCE_URL;
  registerProvider("admin-price-co", { label: "AdminPrice", keyless: true, priceNamespace: "adminns" });
});
after(() => {
  if (envBefore === undefined) delete process.env.MODEL_PRICE_SOURCE_URL;
  else process.env.MODEL_PRICE_SOURCE_URL = envBefore;
  unregisterProvider("admin-price-co");
  mapBox.close();
  return srv.close();
});

test("admin prices: every route is admin-only", async () => {
  for (const [method, path] of [["GET", "/api/admin/prices"], ["PUT", "/api/admin/prices"], ["POST", "/api/admin/prices/refresh"], ["POST", "/api/admin/prices/history"]]) {
    const r = await req(base, method, path, { sid: member.sid, ...(method === "GET" ? {} : { body: {} }) });
    assert.equal(r.status, 403, `${method} ${path} must not answer a non-admin`);
  }
});

test("admin prices: PUT stores an admin row that wins immediately; GET reads it back", async () => {
  const put = await req(base, "PUT", "/api/admin/prices", {
    sid: admin.sid,
    body: { provider: "admin-price-co", model: "typed-model", unit: "input_tokens", microsPerUnit: 7 },
  });
  assert.equal(put.status, 200);
  // setModelPrice owns write-then-rebuild, so the rate is live without a restart.
  assert.equal(ratesFor("admin-price-co", "typed-model").input_tokens, 7);

  const get = await req(base, "GET", "/api/admin/prices", { sid: admin.sid });
  assert.equal(get.status, 200);
  const m = get.json.models.find((m) => m.provider === "admin-price-co" && m.model === "typed-model");
  assert.deepEqual(m.units.input_tokens, { micros: 7, source: "admin" });
});

test("admin prices: GET resolves the rungs WITH provenance — the editor sees what stamping sees", async () => {
  // A descriptor rung entry is runtime data, never stored — this read is the
  // only place it can show up, which is half the reason priceState exists.
  registerProvider("price-state-co", {
    label: "PriceState", keyless: true,
    prices: { "*": { requests: 0 }, "psm": { output_tokens: 40 } },
  });
  try {
    await setModelPrices(db, [
      { provider: "price-state-co", model: "psm", unit: "input_tokens", microsPerUnit: 5, source: "community" },
      { provider: "price-state-co", model: "psm", unit: "output_tokens", microsPerUnit: 55 }, // source defaults to admin
    ]);
    const r = await req(base, "GET", "/api/admin/prices", { sid: admin.sid });
    assert.equal(r.status, 200);
    const psm = r.json.models.find((m) => m.provider === "price-state-co" && m.model === "psm");
    // Per-unit precedence: community supplied input untouched; the admin rung
    // overwrote the descriptor's output — and each answer NAMES its rung.
    assert.deepEqual(psm.units.input_tokens, { micros: 5, source: "community" });
    assert.deepEqual(psm.units.output_tokens, { micros: 55, source: "admin" });
    const star = r.json.models.find((m) => m.provider === "price-state-co" && m.model === "*");
    assert.deepEqual(star.units.requests, { micros: 0, source: "descriptor" },
      "the provider-wide '*' default is an ordinary entry, rung named");
    // The editor's unit vocabulary is the REGISTRY, not just what's priced —
    // an editor declares new facts, so its list can't be limited to old ones.
    const units = Object.fromEntries(r.json.units.map((u) => [u.unit, u]));
    assert.deepEqual(units.web_searches,
      { unit: "web_searches", label: "web searches", format: "count", rate: { per: 1, label: "$ ea" } });
    // The editor's arithmetic runs on `rate.per`, DECLARED here rather than
    // guessed from the display kind: a token rate is quoted per million and a
    // search each, and inferring that is how a stored rate lands 1e6 out —
    // which validRate cannot catch and the meter can never repair.
    assert.equal(units.input_tokens.rate.per, 1e6);
    assert.ok(Array.isArray(r.json.freshness));
  } finally {
    unregisterProvider("price-state-co");
  }
});

test("admin prices: validation mirrors the descriptor contract — zero legal, junk rejected", async () => {
  const put = (body) => req(base, "PUT", "/api/admin/prices", { sid: admin.sid, body });
  assert.equal((await put({ provider: "p", model: "m", unit: "input_tokens", microsPerUnit: -1 })).status, 400);
  assert.equal((await put({ provider: "p", model: "m", unit: "input_tokens", microsPerUnit: "3" })).status, 400);
  assert.equal((await put({ provider: "p", model: "m", microsPerUnit: 3 })).status, 400, "unit is required");
  // Zero is a KNOWN price — "this is free" is a statement, not an omission.
  assert.equal((await put({ provider: "p", model: "m", unit: "requests", microsPerUnit: 0 })).status, 200);
});

test("prices: the WRITE enforces the rate rule, not just the entrances", async () => {
  // Every rung funnels through setModelPrices, so that is where a bad rate is
  // stopped — a fifth rung that forgets to validate must not be able to
  // falsify a billing record, since a stored rate is stamped into cost_micros
  // and by design never recomputed.
  await assert.rejects(
    () => setModelPrices(db, [{ provider: "p", model: "m", unit: "input_tokens", microsPerUnit: NaN }]),
    /invalid rate/
  );
  await assert.rejects(
    () => setModelPrices(db, [{ provider: "p", model: "m", unit: "input_tokens", microsPerUnit: -3 }]),
    /invalid rate/
  );
});

test("admin prices: refresh forces a learner pass and answers with what it learned", async () => {
  process.env.MODEL_PRICE_SOURCE_URL = mapBox.url("/map.json");
  ratesFor("admin-price-co", "learnable-model"); // wanted — the learner's worklist
  const r = await req(base, "POST", "/api/admin/prices/refresh", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.ok(r.json.learned >= 1, "the pass reports what it learned, not just ok");
  assert.equal(ratesFor("admin-price-co", "learnable-model").input_tokens, 2);
  // GET's fetch list no longer hunts the model a pass just priced.
  const get = await req(base, "GET", "/api/admin/prices", { sid: admin.sid });
  assert.ok(!get.json.wanted.some((w) => w.model === "learnable-model"));
  // …and the pull left its timestamp: the freshness line has something to say.
  assert.ok(get.json.freshness.some((f) => f.source === "community" && f.at > 0));
});

test("admin prices: the history route prices the unpriced remainder and reports the money", async () => {
  // Usage metered before the rate existed (rates: {} — nothing known then),
  // then the admin types one in: the shape the action exists for.
  await meter(db, { capability: "tag", provider: "admin-price-co", model: "before-its-time" }, { input_tokens: 1000 });
  await req(base, "PUT", "/api/admin/prices", {
    sid: admin.sid,
    body: { provider: "admin-price-co", model: "before-its-time", unit: "input_tokens", microsPerUnit: 4 },
  });
  const r = await req(base, "POST", "/api/admin/prices/history", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.ok(r.json.rows >= 1 && r.json.micros >= 4000, "rows touched and micros added come back");
  const { rows } = await db.query(
    "SELECT quantity, priced_quantity, cost_micros FROM usage_meter WHERE provider='admin-price-co' AND model='before-its-time'");
  assert.deepEqual(rows.map((x) => [Number(x.quantity), Number(x.priced_quantity), Number(x.cost_micros)]), [[1000, 1000, 4000]]);
  // A second click finds nothing left that any rung can price.
  const again = await req(base, "POST", "/api/admin/prices/history", { sid: admin.sid });
  assert.deepEqual(again.json, { rows: 0, micros: 0 });
});
