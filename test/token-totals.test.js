// Stage 0 of metering-plan.md: the token buckets stay apart on the wire.
// Input and output bill at 3-5× different rates and cache reads at a fraction
// of input, so no endpoint may ever hand the client a pre-summed figure —
// these pin the shape of the two routes that used to do exactly that.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";
import { boardUsageSummary } from "../server/db.js";
import { meterAiCall, meterSpend } from "../server/metering.js";
import { setModelPrice } from "../server/pricing.js";

let srv, db, base, admin;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});
after(() => srv.close());

test("units: summed per unit across days, never across units", async () => {
  const boardId = await seedBoard(db, "buckets");
  // Two paid calls (different shapes) — the totals must keep the units apart.
  const attr = { capability: "tag", provider: "anthropic", model: "m-1" };
  await meterAiCall(db, boardId, attr, { input: 1000, output: 50, cacheRead: 300, searches: 1 });
  await meterAiCall(db, boardId, attr, { input: 200, output: 25 });

  const { units } = await boardUsageSummary(db, boardId);
  assert.deepEqual(units, {
    requests: 2, input_tokens: 1200, output_tokens: 75, cache_read_tokens: 300, web_searches: 1,
  });

  // The poll route serves the same map — and nothing pre-summed — WITH the
  // vocabulary, so the chip names units it has no list of (Stage 5b: the
  // three-bucket shape this used to ship could not represent audio at all,
  // and the chip went dark on a board whose only spend was transcription).
  const r = await req(base, "GET", `/api/boards/${boardId}/tokens`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.units, units);
  const defs = Object.fromEntries(r.json.unitDefs.map((u) => [u.unit, u.label]));
  assert.equal(defs.input_tokens, "input tokens");

  // The board payload carries the identical object (the chip's first paint).
  const b = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.deepEqual(b.json.units, units);
});

test("units: a unit outside the token buckets reaches the board's own surfaces", async () => {
  // The reconciliation Stage 5b owes: the board reader used to pivot to
  // { input, output, cache_read }, so transcription spend joined the COST and
  // the remainder while being unrepresentable in the figure beside it.
  const boardId = await seedBoard(db, "audio-only");
  await meterSpend(db, boardId, { capability: "transcribe", provider: "whisper", model: "small" },
    { requests: 1, audio_seconds: 90 });
  const r = await req(base, "GET", `/api/boards/${boardId}/tokens`, { sid: admin.sid });
  assert.deepEqual(r.json.units, { requests: 1, audio_seconds: 90 });
  const audio = r.json.unitDefs.find((u) => u.unit === "audio_seconds");
  assert.deepEqual([audio.label, audio.format], ["audio", "duration"]);
});

// ─── Stage 3c: the money shows up (manager-gated, and only when KNOWN) ──────

test("cost: manager-gated on both routes; the remainder is per-unit, never summed", async () => {
  const member = await seedUser(db, "cost-member@test.local");
  const boardId = await seedBoard(db, "costs", [member.id]);
  // A model this test prices itself — input has a rate, output doesn't, so
  // the figure and the remainder BOTH have something to say.
  await setModelPrice(db, { provider: "priced-co", model: "m", unit: "input_tokens", microsPerUnit: 3 });
  await meterAiCall(db, boardId, { capability: "tag", provider: "priced-co", model: "m" }, { input: 2000, output: 100 });

  // The admin (a manager everywhere) sees the stamped figure and the honest
  // per-unit remainder — output tokens and the call, each in its own unit.
  const r = await req(base, "GET", `/api/boards/${boardId}/tokens`, { sid: admin.sid });
  // The remainder is per unit and CARRIES ITS LABELS — the client renders
  // what it is handed rather than turning ids into English (server/units.js).
  assert.deepEqual(r.json.cost, {
    micros: 6000,
    unpriced: [
      { unit: "output_tokens", label: "output tokens", format: "tokens", quantity: 100 },
      { unit: "requests", label: "calls", format: "count", quantity: 1 },
    ],
  });
  const b = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.deepEqual(b.json.cost, r.json.cost);

  // A plain member gets the usage but NO cost key — absent, not zeroed.
  const m = await req(base, "GET", `/api/boards/${boardId}/tokens`, { sid: member.sid });
  assert.equal(m.status, 200);
  assert.deepEqual(m.json.units, { requests: 1, input_tokens: 2000, output_tokens: 100 });
  assert.ok(!("cost" in m.json));
  const mb = await req(base, "GET", `/api/boards/${boardId}`, { sid: member.sid });
  assert.ok(!("cost" in mb.json));
});

test("cost: nothing ever priced → no figure at all; free on-device → a true $0.00", async () => {
  // Unknown model, no rates anywhere: ≈$0.00 would be a claim, not an absence.
  const dark = await seedBoard(db, "cost-unknown");
  await meterAiCall(db, dark, { capability: "tag", provider: "glm", model: "mystery" }, { input: 500 });
  const r1 = await req(base, "GET", `/api/boards/${dark}/tokens`, { sid: admin.sid });
  assert.ok(!("cost" in r1.json), "no rate was ever known — no cost claim");

  // The local embedder is priced-at-zero by declaration — $0.00 is KNOWN.
  const free = await seedBoard(db, "cost-free");
  await meterAiCall(db, free, { capability: "embed", provider: "local", model: "bge-small-en-v1.5" }, { input: 900 });
  const r2 = await req(base, "GET", `/api/boards/${free}/tokens`, { sid: admin.sid });
  assert.deepEqual(r2.json.cost, { micros: 0, unpriced: [] }, "ran free on your own hardware — a real thing to say");
});

test("units: a board with no usage answers the same shape, empty", async () => {
  // An absent unit key IS "nothing spent in that unit" — the meter writes no
  // zero rows by design, so the map says exactly what happened without the
  // reader having to enumerate a fixed set of buckets to zero out.
  const boardId = await seedBoard(db, "untouched");
  const r = await req(base, "GET", `/api/boards/${boardId}/tokens`, { sid: admin.sid });
  assert.deepEqual(r.json, { units: {}, unitDefs: [] });
});

test("units: member-visible, outsider 404", async () => {
  const member = await seedUser(db, "member@test.local");
  const outsider = await seedUser(db, "outsider@test.local");
  const boardId = await seedBoard(db, "scoped", [member.id]);

  const ok = await req(base, "GET", `/api/boards/${boardId}/tokens`, { sid: member.sid });
  assert.equal(ok.status, 200);
  const no = await req(base, "GET", `/api/boards/${boardId}/tokens`, { sid: outsider.sid });
  assert.equal(no.status, 404);
});
