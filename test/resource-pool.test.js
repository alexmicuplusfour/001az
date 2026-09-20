// The concurrency pool (queue-by-resource-plan.md Stage 1) and the one key
// vocabulary it shares with the rate limiter.
//
// Structural, never timed: "A doesn't delay B" is asserted by counting and by
// whether a promise has settled, not by a wall clock. The worker-rework arc
// wrote that rule down after a timing-based concurrency test proved flaky.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { free, wait, release, maxFor, _reset, _usedOf } from "../server/resource-pool.js";
import { aiKeyBucket } from "../server/providers.js";

beforeEach(() => _reset());

// Has a promise settled yet? Two macrotask turns is plenty for any microtask
// chain the pool creates, and unlike a timeout it doesn't get slower or flakier
// under load.
const settled = async (p) => {
  let done = false;
  p.then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return done;
};

test("the bulkhead: saturating one resource leaves every other untouched", async () => {
  // The entire reason this module exists. A throttled key holding all its slots
  // must not cost a board on a different key anything at all.
  const A = "ai:openai:aaaaaaaaaaaa";
  const B = "ai:openai:bbbbbbbbbbbb";
  for (let i = 0; i < maxFor(A); i++) await wait(A);

  assert.equal(free(A), 0, "A is saturated");
  assert.equal(free(B), maxFor(B), "B's capacity is untouched by A");
  assert.ok(await settled(wait(B)), "a call on B proceeds while A is full");
  assert.ok(!(await settled(wait(A))), "a call on A waits, as it should");

  // And a different CLASS is equally unaffected.
  assert.equal(free("conn:coingecko"), maxFor("conn:coingecko"));
  assert.ok(await settled(wait("conn:coingecko")));
});

test("a resource never exceeds its max, however hard it is flooded", async () => {
  const R = "sidecar:extractor";
  const max = maxFor(R);
  let peak = 0;
  let running = 0;
  // 30 callers against a max of 1: the counting-stub shape, no clocks.
  await Promise.all(Array.from({ length: 30 }, async () => {
    await wait(R);
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setImmediate(r));
    running--;
    release(R);
  }));
  assert.equal(peak, max, `never more than ${max} at once`);
  assert.equal(_usedOf(R), 0, "every slot handed back");
});

test("wait on a full resource resolves only once a slot is released", async () => {
  const R = "sidecar:detector"; // max 1
  await wait(R);
  const queued = wait(R);
  assert.ok(!(await settled(queued)), "blocked while the resource is full");
  release(R);
  assert.ok(await settled(queued), "and admitted the moment a slot frees");
});

test("a waiter is handed the slot directly, so a newcomer cannot jump it", async () => {
  const R = "sidecar:whisper"; // max 1
  await wait(R);
  const queued = wait(R);
  release(R);
  assert.ok(await settled(queued), "the queued caller got the slot");
  assert.equal(_usedOf(R), 1, "the count never dipped — no window for a newcomer");
  assert.ok(!(await settled(wait(R))), "so the newcomer waits");
});

test("an over-release cannot drive the count negative and raise the ceiling", async () => {
  // release() lives in finally blocks, which is exactly where double-releases
  // come from. Going negative would silently widen the pool.
  const R = "conn:coingecko";
  release(R);
  release(R);
  release(R);
  assert.equal(_usedOf(R), 0);
  assert.equal(free(R), maxFor(R), "still exactly its max, not more");
});

test("free() answers for a resource never seen, without inventing one", () => {
  assert.equal(free("conn:never-touched"), maxFor("conn:never-touched"));
  assert.equal(_usedOf("conn:never-touched"), 0);
});

test("maxFor classifies by prefix, and an unknown resource stays permissive", () => {
  assert.equal(maxFor("sidecar:extractor"), 1, "the sidecars are single-threaded");
  assert.equal(maxFor("sidecar:anything-at-all"), 1, "by class, not by name");
  assert.equal(maxFor("ai:openai:abc123abc123"), 8);
  assert.equal(maxFor("conn:coingecko"), 3);
  // Defaults, not laws: something unclassified must behave as it does today.
  assert.ok(maxFor("something:else") >= 8);
  assert.ok(maxFor("") >= 8);
  assert.ok(maxFor(undefined) >= 8);
});

test("maxFor reads the existing env names — no new knobs", () => {
  const { AI_INFLIGHT, FETCH_CONCURRENCY } = process.env;
  try {
    process.env.AI_INFLIGHT = "3";
    process.env.FETCH_CONCURRENCY = "9";
    assert.equal(maxFor("ai:openai:abc123abc123"), 3);
    assert.equal(maxFor("conn:coingecko"), 9);
  } finally {
    if (AI_INFLIGHT === undefined) delete process.env.AI_INFLIGHT; else process.env.AI_INFLIGHT = AI_INFLIGHT;
    if (FETCH_CONCURRENCY === undefined) delete process.env.FETCH_CONCURRENCY; else process.env.FETCH_CONCURRENCY = FETCH_CONCURRENCY;
  }
});

test("one key vocabulary: the pool classifies exactly what the rate limiter buckets", () => {
  // The two limiters must key on ONE string. aiKeyBucket is the AI half's
  // builder (now exported rather than re-spelled), and its output has to be
  // something maxFor can classify — a bucket the pool fell through to the
  // generic default would bound a key at the wrong number.
  const k = aiKeyBucket("openai", "sk-test");
  assert.match(k, /^ai:openai:[0-9a-f]{12}$/);
  assert.equal(maxFor(k), maxFor("ai:x:y"), "classified as an AI key, not as an unknown");

  // Two keys of one provider are two resources; the same key is one.
  assert.notEqual(aiKeyBucket("openai", "sk-a"), aiKeyBucket("openai", "sk-b"));
  assert.equal(aiKeyBucket("openai", "sk-a"), aiKeyBucket("openai", "sk-a"));
  // A keyless provider still buckets per provider — all connections share the box.
  assert.equal(aiKeyBucket("openai", null), "ai:openai:nokey");
});
