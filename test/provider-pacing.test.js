// Per-key rate limiting for AI provider calls (ai-provider-rate-limiting plan,
// slice 1). The token bucket is shared with connectors (provider-pacing.js); the
// new surface is that the AI dispatchers pace per API KEY. No DB — pure timing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquire, _resetBuckets } from "../server/provider-pacing.js";
import { registerProvider, unregisterProvider, callTagger } from "../server/providers.js";
import { getPluginDef } from "../server/plugins.js";

// setTimeout never fires EARLY, so lower-bound gap assertions can't flake low; we
// avoid tight upper bounds (a loaded machine only ever runs slow) and prefer
// relative checks (X started before Y) where a margin is needed.
const since = (t0) => Date.now() - t0;

test("acquire bursts up to `burst`, then paces at `rpm`", async () => {
  _resetBuckets();
  // rpm 600 = 10 tokens/s = one refill per ~100 ms; burst 2 = two free, then wait.
  const t0 = Date.now();
  await acquire("k", 600, 2); const a = since(t0);
  await acquire("k", 600, 2); const b = since(t0);
  await acquire("k", 600, 2); const c = since(t0);
  assert.ok(a < 60, `first is immediate (was ${a}ms)`);
  assert.ok(b < 60, `second rides the burst (was ${b}ms)`);
  assert.ok(c - b >= 70, `third waits ~100ms for a refill (gap was ${c - b}ms)`);
});

test("each key is an independent bucket", async () => {
  _resetBuckets();
  await acquire("A", 600, 1); // drains A's only token
  const t0 = Date.now();
  await acquire("B", 600, 1); // fresh bucket — must not wait behind A
  assert.ok(since(t0) < 60, `B is immediate despite A being drained (was ${since(t0)}ms)`);
});

test("callTagger paces per API key using the descriptor's declared limit", async () => {
  const saved = { rpm: process.env.AI_RPM, burst: process.env.AI_BURST };
  delete process.env.AI_RPM; delete process.env.AI_BURST; // exercise the declared rpm/burst, not the env override
  _resetBuckets();
  const calls = [];
  registerProvider("pacetest", {
    label: "Pace Test",
    research: false,
    rpm: 600, burst: 1, // ~100 ms per token; one free per key, then pace
    wire: { tag: async (_desc, args) => { calls.push({ key: args.apiKey, t: Date.now() }); return { input: {}, usage: {} }; } },
  });
  try {
    const t0 = Date.now();
    // Three calls on key k1 (must serialize ~100 ms apart) + one on k2 (independent
    // bucket → must NOT queue behind k1). Fired together.
    await Promise.all([
      callTagger({ provider: "pacetest", apiKey: "k1" }),
      callTagger({ provider: "pacetest", apiKey: "k1" }),
      callTagger({ provider: "pacetest", apiKey: "k1" }),
      callTagger({ provider: "pacetest", apiKey: "k2" }),
    ]);
    const k1 = calls.filter((c) => c.key === "k1").map((c) => c.t - t0).sort((x, y) => x - y);
    const k2 = calls.filter((c) => c.key === "k2").map((c) => c.t - t0);
    assert.equal(k1.length, 3);
    assert.ok(k1[1] - k1[0] >= 70, `k1 call 2 paced after call 1 (gap ${k1[1] - k1[0]}ms)`);
    assert.ok(k1[2] - k1[1] >= 70, `k1 call 3 paced after call 2 (gap ${k1[2] - k1[1]}ms)`);
    // k2's own bucket had a free token, so it fired with k1's first — not behind k1's queue.
    assert.ok(k2[0] < k1[1], `k2 ran on its own bucket, not behind k1 (k2 ${k2[0]}ms vs k1 call2 ${k1[1]}ms)`);
  } finally {
    unregisterProvider("pacetest");
    if (saved.rpm !== undefined) process.env.AI_RPM = saved.rpm;
    if (saved.burst !== undefined) process.env.AI_BURST = saved.burst;
    _resetBuckets();
  }
});

test("the manifest contract: a networked provider must declare a rate limit", () => {
  // No rpm/burst → rejected at registration, so nothing enters the registry unthrottled.
  assert.throws(
    () => registerProvider("noratelimit", { label: "No Limit", wire: { tag: async () => ({}) } }),
    /must declare positive rpm and burst/,
  );
  // An on-device provider makes no external calls → exempt from the contract.
  // (Keyless alone does NOT exempt — a self-hosted server still gets paced;
  // that half of the contract is pinned in keyless-providers.test.js.)
  assert.doesNotThrow(() => registerProvider("ondevicetest", { label: "On-Device", onDevice: true, wire: null }));
  unregisterProvider("ondevicetest");
});

test("an explicit rpm/burst override (the Plugins-page config) beats the descriptor default", async () => {
  const saved = { rpm: process.env.AI_RPM, burst: process.env.AI_BURST };
  delete process.env.AI_RPM; delete process.env.AI_BURST; // let the override, not the env, drive it
  const calls = [];
  registerProvider("pacetest2", {
    label: "Pace Test 2",
    research: false,
    rpm: 6000, burst: 100, // descriptor default is fast — the override must win
    wire: { tag: async (_d, a) => { calls.push(Date.now()); return { input: {}, usage: {} }; } },
  });
  try {
    _resetBuckets();
    // override rpm 600 / burst 1 (~100 ms/token) beats the descriptor's fast 6000/100
    await Promise.all([
      callTagger({ provider: "pacetest2", apiKey: "k", rpm: 600, burst: 1 }),
      callTagger({ provider: "pacetest2", apiKey: "k", rpm: 600, burst: 1 }),
    ]);
    assert.ok(calls[1] - calls[0] >= 70, `override throttled the 2nd call (gap ${calls[1] - calls[0]}ms)`);
  } finally {
    unregisterProvider("pacetest2");
    if (saved.rpm !== undefined) process.env.AI_RPM = saved.rpm;
    if (saved.burst !== undefined) process.env.AI_BURST = saved.burst;
    _resetBuckets();
  }
});

test("aiDefs exposes rpm/burst config for networked providers, not for on-device ones", () => {
  const openai = getPluginDef("ai:openai").configSchema.map((f) => f.key);
  assert.ok(openai.includes("rpm") && openai.includes("burst"), "a networked provider offers rpm/burst config");
  assert.equal(getPluginDef("ai:local").configSchema.length, 0, "on-device local has no rate-limit config");
});
