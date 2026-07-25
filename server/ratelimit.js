// Fixed-window rate limiter, keyed by client IP (or a custom `key(req)` — the
// login route adds a per-email window so brute force can't be spread across
// IPs). In-memory — fine for the single-process server; resets on restart.
// This is abuse/DoS throttling, not a security boundary (session ids and
// invite tokens are 192-bit random, so guessing isn't the threat). Requires
// app.set("trust proxy") so req.ip is the real client behind Caddy.
export function rateLimit({ windowMs, max, key: keyFn }) {
  const hits = new Map(); // key -> { count, resetAt }
  let lastSweep = Date.now();

  return function limiter(req, res, next) {
    const now = Date.now();

    // Lazy prune: drop expired windows once per window, so the map stays bounded
    // to distinct keys seen recently without needing a timer to clear on shutdown.
    if (now - lastSweep > windowMs) {
      for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }

    const key = (keyFn ? keyFn(req) : req.ip) || "unknown";
    let e = hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(key, e);
    }
    e.count++;
    if (e.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((e.resetAt - now) / 1000)));
      return res.status(429).json({ error: "too many requests" });
    }
    next();
  };
}
