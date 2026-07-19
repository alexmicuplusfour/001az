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

export async function acquire(key, rpm, burst) {
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
  b.chain = run.catch(() => {}); // keep the per-key chain alive on failure
  return run;
}

// Test seam only: drop all buckets so a unit test starts from a clean slate.
export function _resetBuckets() { buckets.clear(); }
