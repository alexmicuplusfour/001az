// The rate limiter is a pure middleware — test it directly, no server needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../server/ratelimit.js";

function mock(ip) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json() { return this; },
  };
  return [{ ip }, res];
}

test("allows up to max, then 429s with Retry-After", () => {
  const limiter = rateLimit({ windowMs: 1000, max: 3 });
  let passed = 0;
  for (let i = 0; i < 3; i++) {
    const [req, res] = mock("1.1.1.1");
    limiter(req, res, () => passed++);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(passed, 3);

  const [req, res] = mock("1.1.1.1");
  let nextCalled = false;
  limiter(req, res, () => (nextCalled = true));
  assert.equal(res.statusCode, 429);
  assert.equal(nextCalled, false);
  assert.ok(res.headers["Retry-After"]);
});

test("limits are per-IP", () => {
  const limiter = rateLimit({ windowMs: 1000, max: 1 });
  const [ra, sa] = mock("a");
  limiter(ra, sa, () => {});
  assert.equal(sa.statusCode, 200);
  const [rb, sb] = mock("b");
  limiter(rb, sb, () => {});
  assert.equal(sb.statusCode, 200); // different IP, own window
  const [ra2, sa2] = mock("a");
  limiter(ra2, sa2, () => {});
  assert.equal(sa2.statusCode, 429);
});

test("a custom key groups requests across IPs", () => {
  // The login route keys a second limiter on the submitted email, so brute
  // force against one account can't be spread across source addresses.
  const limiter = rateLimit({ windowMs: 1000, max: 2, key: (req) => req.body?.email || "" });
  for (const [ip, expected] of [["a", 200], ["b", 200], ["c", 429]]) {
    const [req, res] = mock(ip);
    req.body = { email: "victim@x" };
    limiter(req, res, () => {});
    assert.equal(res.statusCode, expected, `ip ${ip}`);
  }
  // A different email is its own window even from a throttled IP.
  const [req, res] = mock("c");
  req.body = { email: "other@x" };
  limiter(req, res, () => {});
  assert.equal(res.statusCode, 200);
});

test("the window resets after windowMs", async () => {
  const limiter = rateLimit({ windowMs: 30, max: 1 });
  const [r1, s1] = mock("x");
  limiter(r1, s1, () => {});
  assert.equal(s1.statusCode, 200);
  const [r2, s2] = mock("x");
  limiter(r2, s2, () => {});
  assert.equal(s2.statusCode, 429);
  await new Promise((r) => setTimeout(r, 45));
  const [r3, s3] = mock("x");
  let ok = false;
  limiter(r3, s3, () => (ok = true));
  assert.equal(s3.statusCode, 200);
  assert.ok(ok);
});
