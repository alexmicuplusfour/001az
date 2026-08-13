// Token-bucket pacing shared by every outbound provider call — connectors AND
// AI providers. Lifted out of connectors/runtime.js so the AI wire (providers.js)
// can pace per API key at parity with connectors, without providers.js taking a
// dependency on the connector layer.
//
// One `buckets` Map, namespaced by the caller's key string, so the two keyspaces
// never collide: a connector passes its provider name ("coingecko"); the AI wire
// passes `ai:<provider>:<keyhash>` (per-account, since two API keys of the same
// provider have independent limits). Acquisition is serialized per key via a
// promise chain so concurrent callers don't all spend the same tokens; when the
// bucket is empty a call waits for a refill. rpm/burst are the caller's — a
// connector reads them off the provider descriptor, the AI wire off PROVIDERS
// (+ the AI_RPM/AI_BURST env override), so this module owns no defaults.
const buckets = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The declared rpm is a CLAIM about someone else's tier, and the claim is often
// wrong: CoinGecko's keyless pool is "5-15/min shared per source IP" (a number
// nobody can know from here), its demo tier has been documented at both 30 and
// 100, and any provider can change a plan under a running deployment. So the
// bucket learns. A 429 halves the effective rate and spends the tokens; each
// subsequent 429 halves it again, down to MAX_PENALTY. A quiet EASE_MS wins one
// halving back, so a provider that recovers is not punished for the rest of the
// process's life, and one bad minute doesn't cost the day.
//
// This is what lets a descriptor be optimistic. Guessing low is a permanent
// latency tax on every deployment; guessing high used to be permanent too,
// because the retry (connectors/runtime.js withRetry) re-sent without ever
// slowing down — and for a provider that counts FAILED requests against the
// quota, that spends real money on requests it was denied. Now the wrong guess
// self-corrects within a couple of requests, in whichever direction it was
// wrong.
const MAX_PENALTY = 16;
const EASE_MS = 5 * 60 * 1000;

export async function acquire(key, rpm, burst) {
  let b = buckets.get(key);
  if (!b) { b = { tokens: burst, last: Date.now(), rpm, burst, penalty: 1, easeAt: 0, chain: Promise.resolve() }; buckets.set(key, b); }
  else if (b.rpm !== rpm || b.burst !== burst) {
    // Config overrides (Plugins page) apply live, not on next boot; clamp the
    // saved-up tokens so a burst cut takes effect immediately. A changed RPM
    // also clears what we learned: the declared rate is the tier claim, so an
    // operator editing it (or a key being added, which flips keyless→keyed) is
    // new information about the tier that outranks an old 429. It is also the
    // only way to clear a penalty by hand — everything else waits it out.
    if (b.rpm !== rpm) b.penalty = 1;
    b.rpm = rpm;
    b.burst = burst;
    b.tokens = Math.min(b.tokens, burst);
  }
  const run = b.chain.then(async () => {
    for (;;) {
      const now = Date.now();
      // Ease by ELAPSED time, not one step per call: a bucket that has been
      // quiet for an hour has no evidence left against it, and recovering one
      // halving per request would keep a long-idle provider throttled purely
      // because it was idle.
      if (b.penalty > 1 && now >= b.easeAt) {
        b.penalty = Math.max(1, b.penalty / 2 ** (1 + Math.floor((now - b.easeAt) / EASE_MS)));
        b.easeAt = now + EASE_MS;
        if (b.penalty === 1) console.log(`pacing: ${key} recovered — back to its declared ${b.rpm}/min`);
      }
      const rate = b.rpm / b.penalty;
      b.tokens = Math.min(b.burst, b.tokens + ((now - b.last) / 60000) * rate);
      b.last = now;
      if (b.tokens >= 1) { b.tokens -= 1; return; }
      await sleep(((1 - b.tokens) / rate) * 60000);
    }
  });
  b.chain = run.catch(() => {}); // keep the per-key chain alive on failure
  return run;
}

// "The provider said slow down." Halve the effective rate and spend what's
// banked, so the next call actually waits rather than riding the burst into a
// second refusal. Unknown key = a provider that never paced (legacy per-call
// mode, or a stub) — nothing to slow.
//
// Logged, because a self-throttling limiter is otherwise invisible: the symptom
// is "the app got slow" with nothing in the config to explain it. Only on a
// CHANGE, so a provider pinned at the floor doesn't narrate every request.
export function throttled(key) {
  const b = buckets.get(key);
  if (!b) return;
  const was = b.penalty;
  b.penalty = Math.min(MAX_PENALTY, b.penalty * 2);
  // Restart the refill clock with the spend. Zeroing tokens alone doesn't hold:
  // acquire regenerates from `last`, so a bucket that had been idle would hand
  // the very next call a full burst back and the refusal would cost nothing.
  b.tokens = 0;
  b.last = Date.now();
  b.easeAt = b.last + EASE_MS;
  if (b.penalty !== was)
    console.warn(`pacing: ${key} rate-limited — easing to ${+(b.rpm / b.penalty).toFixed(1)}/min (declared ${b.rpm})`);
}

// Test seam only: drop all buckets so a unit test starts from a clean slate.
export function _resetBuckets() { buckets.clear(); }
// Test seam: the learned penalty is invisible from outside, and "did a 429
// actually slow us down" is the behaviour worth asserting.
export const _penaltyOf = (key) => buckets.get(key)?.penalty ?? 1;
