// The price learners (metering-plan.md, Stage 3b): the community fetcher
// (LiteLLM's map, matched under a descriptor's declared namespace) and the
// listPrices wire verb (a compat /models listing that carries `pricing`).
// Everything runs against local HTTP stubs — the env knob and the descriptor
// base ARE the seams, so the whole path (fetch → match → convert → store →
// rebuild → ratesFor answers → wanted drains) runs for real with no network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, jsonBox } from "./helpers.js";
import { createAiKey, meter } from "../server/db.js";
import { ratesFor, wantedModels, wantedGeneration, setModelPrice, refreshRateTable } from "../server/pricing.js";
import { learnPrices } from "../server/price-learner.js";
import { registerProvider, unregisterProvider, WIRES } from "../server/providers.js";

// A miniature of the LiteLLM file's shape — hand-written to imitate the
// schema (bare and namespaced keys, the sample_spec doc entry, a chat and an
// embedding mode, the search-context OBJECT), never a copy of the file.
const LITELLM_MAP = {
  sample_spec: { input_cost_per_token: 0, litellm_provider: "one of the providers listed here", mode: "one of: chat, embedding, ..." },
  "m-bare": {
    litellm_provider: "hostedns", mode: "chat",
    input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5, cache_read_input_token_cost: 3e-7,
    // an object of context sizes — pinned UNMAPPED: picking one would be a guess
    search_context_cost_per_query: { search_context_size_low: 0.03, search_context_size_medium: 0.035, search_context_size_high: 0.05 },
  },
  "hostedns/m-prefixed": { litellm_provider: "hostedns", mode: "chat", input_cost_per_token: 1e-6 },
  // same id a wanted model uses, but it belongs to ANOTHER provider's
  // namespace — matching it would invent a bill (the trap)
  "m-imposter": { litellm_provider: "elsewhere", mode: "chat", input_cost_per_token: 9.9e-5 },
  "m-embed": { litellm_provider: "hostedns", mode: "embedding", input_cost_per_token: 2e-8 },
  // A chat model that DOES bill per call (the live map's Perplexity online
  // models are exactly this): the reason no rule may read "chat" as free.
  "m-per-call": { litellm_provider: "hostedns", mode: "chat", input_cost_per_token: 0, output_cost_per_token: 1e-6, input_cost_per_request: 0.005 },
  // A per-second transcription model (the live map's whisper-1 carries BOTH
  // fields at the same value): audio in is billed by duration —
  // input_cost_per_second maps to audio_seconds, while output_cost_per_second
  // prices GENERATED media (TTS/video) and is deliberately unmapped.
  "m-whisper": { litellm_provider: "hostedns", mode: "audio_transcription", input_cost_per_second: 0.0001, output_cost_per_second: 0.0001 },
  // A vision chat model shaped exactly like the live map's OpenRouter/Anthropic
  // rows: a per-image price that RESTATES the token price rather than adding to
  // it (1600 image-tokens × the per-token rate = the per-image figure). Reading
  // it would bill the image and the tokens that already contain it. Both image
  // fields stay unmapped — see LITELLM_FIELDS.
  "m-vision": { litellm_provider: "hostedns", mode: "chat", input_cost_per_token: 3e-6, input_cost_per_image: 0.0048, output_cost_per_image: 0.04 },
};

// An OpenRouter-shaped /models listing: dollars-per-unit STRINGS, zero kept
// (a free model is a KNOWN price), "-1" (variable pricing) dropped.
const PRICED_LISTING = {
  data: [
    { id: "a/b", pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", web_search: "0.004", request: "0" } },
    { id: "free-model", pricing: { prompt: "0", completion: "0" } },
    { id: "variable", pricing: { prompt: "-1", completion: "-1" } },
    { id: "unpriced-model" },
  ],
};

const PRICE_FIELDS = { prompt: "input_tokens", completion: "output_tokens", input_cache_read: "cache_read_tokens", web_search: "web_searches", request: "requests" };
const COMPAT = { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "models", priceFields: PRICE_FIELDS };
const WEEK8 = 8 * 86400000; // past the 7-day default refresh

let srv, db, mapBox, priceBox, idleBox, envBefore;
let clock = Date.now();
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  [mapBox, priceBox, idleBox] = await Promise.all([jsonBox(LITELLM_MAP), jsonBox(PRICED_LISTING), jsonBox(PRICED_LISTING)]);
  envBefore = process.env.MODEL_PRICE_SOURCE_URL;
  // hosted-co: a community-eligible provider (namespace, no wire — the
  // community path needs no wire). selfhosted-style providers are covered in
  // metering.test.js; here the imposter entry covers the namespace check.
  registerProvider("hosted-co", { label: "Hosted", keyless: true, priceNamespace: "hostedns" });
});
after(() => {
  if (envBefore === undefined) delete process.env.MODEL_PRICE_SOURCE_URL;
  else process.env.MODEL_PRICE_SOURCE_URL = envBefore;
  for (const p of ["hosted-co", "router-co", "unconnected-co"]) unregisterProvider(p);
  mapBox.close(); priceBox.close(); idleBox.close();
  return srv.close();
});

// ─── the wire verb ───────────────────────────────────────────────────────────

test("compat listPrices: the declared price fields become rows in the VENDOR's unit; zero kept, -1 dropped", async () => {
  const out = await WIRES.compat.listPrices({ label: "Box", base: priceBox.url("/v1"), compat: COMPAT });
  // dollarsPerUnit, not micros: a wire reports what the vendor said, and the
  // rate map's unit of account is converted to in one place (price-learner).
  assert.deepEqual(out, [
    { model: "a/b", unit: "input_tokens", dollarsPerUnit: 0.000003 },
    { model: "a/b", unit: "output_tokens", dollarsPerUnit: 0.000015 },
    { model: "a/b", unit: "cache_read_tokens", dollarsPerUnit: 0.0000003 },
    { model: "a/b", unit: "web_searches", dollarsPerUnit: 0.004 },
    { model: "a/b", unit: "requests", dollarsPerUnit: 0 },
    { model: "free-model", unit: "input_tokens", dollarsPerUnit: 0 },
    { model: "free-model", unit: "output_tokens", dollarsPerUnit: 0 },
  ]);
});

test("compat listPrices: the rung is OPT-IN — a descriptor that declares no priceFields answers null", async () => {
  // `pricing` is not part of the compat protocol, so a box serving one is not
  // reason enough to believe it: without this gate a proxy in front of a
  // self-hosted model would have its upstream's HOSTED prices stored — the
  // community rung's trap, arriving through the other door.
  const { priceFields, ...noPrices } = COMPAT;
  const before = priceBox.hits.length;
  assert.equal(await WIRES.compat.listPrices({ label: "Vanilla", base: priceBox.url("/v1"), compat: noPrices }), null);
  assert.equal(priceBox.hits.length, before, "opting out costs no request at all");

  // Declared, but the listing carries no pricing (vanilla OpenAI's shape).
  const bare = await jsonBox({ data: [{ id: "m1" }, { id: "m2" }] });
  try {
    assert.equal(await WIRES.compat.listPrices({ label: "Bare", base: bare.url("/v1"), compat: COMPAT }), null);
  } finally { bare.close(); }
});

test("compat listPrices: ids are normalized like listModels, so rates file under the spelling chat uses", async () => {
  const box = await jsonBox({ data: [{ id: "models/g-1", pricing: { prompt: "0.000002" } }] });
  try {
    const desc = { label: "G", base: box.url("/v1"), compat: { ...COMPAT, stripListPrefix: "models/" } };
    assert.deepEqual(await WIRES.compat.listPrices(desc), [{ model: "g-1", unit: "input_tokens", dollarsPerUnit: 0.000002 }]);
    assert.deepEqual(await WIRES.compat.listModels(desc, {}), [{ id: "g-1" }], "one endpoint, one spelling");
  } finally { box.close(); }
});

test("every wire family declares its listPrices stance", () => {
  assert.equal(WIRES.anthropic.listPrices, null, "models.list carries no pricing — explicit, not forgotten");
});

// ─── the community learner ───────────────────────────────────────────────────

test("air-gapped: an empty MODEL_PRICE_SOURCE_URL disables the community rung — no fetch, no throw", async () => {
  process.env.MODEL_PRICE_SOURCE_URL = "";
  ratesFor("hosted-co", "m-bare"); // wanted, but the rung is off
  await learnPrices(db, { now: clock });
  assert.equal(mapBox.hits.length, 0);
});

test("community: wanted models price from the map — bare and namespaced keys, dollars ×1e6", async () => {
  process.env.MODEL_PRICE_SOURCE_URL = mapBox.url("/prices.json");
  for (const m of ["m-bare", "m-prefixed", "m-imposter", "m-embed", "m-per-call", "m-whisper", "m-vision"]) ratesFor("hosted-co", m);
  await learnPrices(db, { now: clock });
  assert.equal(mapBox.hits.length, 1);
  assert.deepEqual(ratesFor("hosted-co", "m-bare"), { input_tokens: 3, output_tokens: 15, cache_read_tokens: 0.3 });
  // Per-second audio pricing lands in its own unit — $0.0001/s = 100 micros/s
  // (the published $0.006/min) — and generation-side seconds stay unmapped.
  assert.deepEqual(ratesFor("hosted-co", "m-whisper"), { audio_seconds: 100 });
  // Per-image is NOT the peer of per-second, however much it looks like one:
  // this row's $0.0048 is 1600 image-tokens at its own $3/M, so a rate of
  // 4800 micros/image would bill the same money twice. The tokens are read,
  // the image price is not — and the meter still records the image quantity,
  // which lands in the unpriced remainder where an unknown rate belongs.
  assert.deepEqual(ratesFor("hosted-co", "m-vision"), { input_tokens: 3 });
  assert.deepEqual(ratesFor("hosted-co", "m-prefixed"), { input_tokens: 1 }, "found under the namespaced key");
  assert.deepEqual(ratesFor("hosted-co", "m-embed"), { input_tokens: 0.02 });
  // the imposter belongs to another namespace: still unpriced, never a guess
  assert.deepEqual(ratesFor("hosted-co", "m-imposter"), {});
  // priced models drained from the fetch list; the miss stays wanted
  const wanted = wantedModels().map((w) => w.model);
  assert.ok(!wanted.includes("m-bare") && wanted.includes("m-imposter"));
});

test("community: per-request pricing is READ, never inferred from the mode", async () => {
  // The map declares input_cost_per_request where it applies, and the models
  // that use it are mode:"chat" charging real money per call (Perplexity's
  // online models, live). A "chat bills tokens, so requests are free" rule
  // would stamp $0 on exactly these — a wrong bill, not a style wart.
  assert.equal(ratesFor("hosted-co", "m-per-call").requests, 5000, "$0.005/call = 5000 micros");
  // And silence stays silence: a chat model that says nothing about requests
  // meters them unpriced rather than free.
  assert.equal(ratesFor("hosted-co", "m-bare").requests, undefined);
});

test("community: a model the map lacks does not re-trigger pulls; a NEW wanted model does", async () => {
  await learnPrices(db, { now: clock });
  assert.equal(mapBox.hits.length, 1, "m-imposter was tried — no new pull");
  ratesFor("hosted-co", "m-new");
  await learnPrices(db, { now: clock });
  assert.equal(mapBox.hits.length, 2, "an untried wanted model pulls within the tick");
});

test("community: the weekly refresh re-resolves STORED models but writes only changes", async () => {
  const count = async () => Number((await db.query("SELECT COUNT(*) AS n FROM model_prices WHERE source='community'")).rows[0].n);
  const beforeRows = await count();
  clock += WEEK8;
  await learnPrices(db, { now: clock }); // stale → pull; same rates → nothing written
  assert.equal(mapBox.hits.length, 3);
  assert.equal(await count(), beforeRows, "unchanged rates insert nothing — every row is a real change");

  // The map updates a price: exactly one new effective row, history intact.
  mapBox.payload = { ...LITELLM_MAP, "m-bare": { ...LITELLM_MAP["m-bare"], input_cost_per_token: 4e-6 } };
  clock += WEEK8;
  await learnPrices(db, { now: clock });
  assert.equal(ratesFor("hosted-co", "m-bare").input_tokens, 4, "the drained model still refreshed");
  assert.equal(await count(), beforeRows + 1);
  const { rows } = await db.query(
    "SELECT COUNT(*) AS n FROM model_prices WHERE provider='hosted-co' AND model='m-bare' AND unit='input_tokens'");
  assert.equal(Number(rows[0].n), 2, "the old rate keeps its row — stamped history references it");
});

// ─── the provider learner ────────────────────────────────────────────────────

test("provider rung: a CONNECTED provider's listPrices lands as source='provider'; unconnected providers are never asked", async () => {
  registerProvider("router-co", { label: "Router", keyless: true, wire: WIRES.compat, base: priceBox.url("/v1"), compat: COMPAT, rpm: 60, burst: 10 });
  registerProvider("unconnected-co", { label: "Idle", keyless: true, wire: WIRES.compat, base: idleBox.url("/v1"), compat: COMPAT, rpm: 60, burst: 10 });
  await createAiKey(db, "k", "router-co", "sk-test");
  await learnPrices(db, { now: clock });
  assert.deepEqual(ratesFor("router-co", "a/b"),
    { input_tokens: 3, output_tokens: 15, cache_read_tokens: 0.3, web_searches: 4000, requests: 0 });
  assert.deepEqual(ratesFor("router-co", "free-model"), { input_tokens: 0, output_tokens: 0 }, "free is a KNOWN price");
  assert.deepEqual(ratesFor("router-co", "variable"), {}, "-1 (variable pricing) is not a rate");
  assert.equal(idleBox.hits.length, 0, "no connection, no poll");
  const { rows } = await db.query("SELECT DISTINCT source FROM model_prices WHERE provider='router-co'");
  assert.deepEqual(rows.map((r) => r.source), ["provider"]);
});

test("provider rung sits above community: the provider's own answer wins", async () => {
  await setModelPrice(db, { provider: "router-co", model: "a/b", unit: "input_tokens", microsPerUnit: 999, source: "community", fetchedAt: clock });
  assert.equal(ratesFor("router-co", "a/b").input_tokens, 3, "community can't override what the provider said");
});

// ─── the meter as the durable half of the want list ─────────────────────────
// See db.js unpricedMeterModels: refreshRateTable re-seeds `wanted` from the
// meter's unpriced pairs on every rebuild, so a restart can't orphan a new
// model's unpriced history (a $22 opus-5 run stayed invisible exactly that
// way before 2026-09-04).

test("meter seed: an unpriced pair survives restart via refreshRateTable, prices, and drains", async () => {
  // A model NO ratesFor call ever recorded (the post-restart shape): its only
  // trace is an unpriced meter row.
  mapBox.payload = { ...LITELLM_MAP, "m-meter": { litellm_provider: "hostedns", mode: "chat", input_cost_per_token: 2e-6 } };
  await meter(db, { capability: "tag", provider: "hosted-co", model: "m-meter" }, { input_tokens: 1000 });
  assert.ok(!wantedModels().some((w) => w.model === "m-meter"), "premise: the in-memory set has never heard of it");
  await refreshRateTable(db); // what boot does
  assert.ok(wantedModels().some((w) => w.model === "m-meter"), "the rebuild seeds the want from the meter");
  const hits = mapBox.hits.length;
  await learnPrices(db, { now: clock });
  assert.equal(mapBox.hits.length, hits + 1, "the seeded want pulls the map");
  assert.equal(ratesFor("hosted-co", "m-meter").input_tokens, 2, "the NEXT run stamps priced");
  // The history row stays unpriced (write-time stamping, no retro-repricing) —
  // but a seeded want drains exactly like a looked-up one the moment rates
  // land, and the priced-set gate keeps the immortal history row from
  // re-pulling on every pass.
  assert.ok(!wantedModels().some((w) => w.model === "m-meter"), "priced means drained, seed included");
  await learnPrices(db, { now: clock });
  assert.equal(mapBox.hits.length, hits + 1, "a learned model's unpriced history never re-pulls");
});

test("meter seed: a provider without a namespace stays outside the want list", async () => {
  // The llama3 trap, meter edition: a self-hosted box's unpriced usage must
  // not pull a map it can never be priced from.
  await meter(db, { capability: "tag", provider: "local", model: "m-nons" }, { input_tokens: 1000 });
  await refreshRateTable(db);
  assert.ok(!wantedModels().some((w) => w.model === "m-nons"), "no namespace, no want");
  const hits = mapBox.hits.length;
  await learnPrices(db, { now: clock });
  assert.equal(mapBox.hits.length, hits, "no want, no pull");
});

// ─── the want generation, the worker's now-signal ────────────────────────────
// The worker's maintenance tick runs the learner hourly for refreshes, but a
// model seen for the FIRST time can't wait an hour of unpriced stamping — it
// reads this counter each tick and learns immediately when a lookup records
// a model not wanted before.
test("wantedGeneration: bumps once per NEW want — not on repeats, not without a namespace", () => {
  const g0 = wantedGeneration();
  ratesFor("hosted-co", "m-gen");
  assert.equal(wantedGeneration(), g0 + 1, "a new want bumps");
  ratesFor("hosted-co", "m-gen");
  assert.equal(wantedGeneration(), g0 + 1, "the same want again does not");
  ratesFor("local", "m-gen-other");
  assert.equal(wantedGeneration(), g0 + 1, "no namespace means no wanting, so no bump");
});
