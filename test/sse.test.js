// An event stream must not be compressed, and the thing that stops it is one
// header on one route. This file is what keeps that header there.
//
// `compressible("text/event-stream")` is TRUE, so express's compression
// middleware opts event streams IN by default — and gzip's whole job is to hold
// bytes back until it has enough to compress well, which is the exact opposite
// of what a stream is for. Measured on this stack, four messages written 250ms
// apart:
//
//   Cache-Control: "no-cache"                 encoding=gzip  773ms 520ms 266ms 4ms
//   Cache-Control: "no-cache, no-transform"   encoding=none    1ms   1ms   1ms 0ms
//
// The first row is every message arriving at once, when the response ended.
// `no-transform` is what /api/logs/stream already sets, and `compression`
// honours it — so the Logs tab is live today, and this file starts from working
// behaviour rather than a fix.
//
// It is here because that protection is a HEADER ON A ROUTE, which means every
// future stream has to remember it, and forgetting is INVISIBLE: no error, no
// warning, the data simply arrives in clumps. Verified both ways — this passes
// as shipped, and fails the moment `no-transform` is dropped from the route.
//
// Any new event-stream route (planning/board-events-plan.md) must set the same
// header and earn a case in this file.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession } from "./helpers.js";

let srv, base, admin;

before(async () => {
  // `frontend: true` serves the real public/ — the last case needs a static
  // asset big enough to be worth compressing, and the default temp dir is empty.
  srv = await startServer({ frontend: true });
  ({ base } = srv);
  admin = await adminSession(srv.db);
});
after(() => srv.close());

// The stream never ends, so `fetch` + a reader rather than `res.json()` — and
// node has no global EventSource (checked on 22.16), so frames are parsed here.
async function openStream(path, { sid } = {}) {
  const ac = new AbortController();
  const res = await fetch(`${base}${path}`, {
    headers: {
      ...(sid ? { Cookie: `sid=${sid}` } : {}),
      // Explicit: the whole measurement is meaningless if the client never
      // offered to accept compression in the first place.
      "Accept-Encoding": "gzip",
      Accept: "text/event-stream",
    },
    signal: ac.signal,
  });
  return { res, ac, reader: res.body.getReader() };
}

// Read frames until `want` matches one, or the budget runs out. Returns how long
// it took — the measurement this file is about — or null on timeout.
//
// `reader.read()` blocks with no timeout of its own, so the budget is raced
// against it. Without that, the failing case doesn't fail, it HANGS.
//
// CALL THIS ONCE PER READER. Losing the race abandons a `read()` that is still
// outstanding, and that read consumes the NEXT chunk and discards it. The first
// draft called it twice — once to drain the connect backlog, once to wait for
// the needle — and the abandoned drain ate the needle every time. It failed
// looking exactly like the bug under test, which is the worst way to be wrong.
async function waitForFrame(reader, want, budgetMs = 2000) {
  const started = Date.now();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) return null;
    const next = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r("timeout"), left)),
    ]);
    if (next === "timeout" || next.done) return null;
    buf += decoder.decode(next.value, { stream: true });
    for (const line of buf.split("\n")) {
      if (line.startsWith("data:") && want(line.slice(5).trim())) return Date.now() - started;
    }
  }
}

// THE test. The assertion has to be about TIME, not about the content-encoding
// header: `compression` decides lazily, once a response crosses its 1KB
// threshold, so on a stream of small frames the header stays absent while the
// frames pile up regardless. A header assertion passes in both the working and
// the broken build — which is what the first draft of this file did.
test("a line logged while a client is connected reaches it immediately", async () => {
  const { res, ac, reader } = await openStream("/api/logs/stream", { sid: admin.sid });
  try {
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);

    // Logged BEFORE the first read; the backlog the route replays on connect is
    // simply scanned past. Draining it first would need a second reader call,
    // which is the one thing this must not do (see above).
    const needle = `sse-probe-${Math.random().toString(36).slice(2)}`;
    console.log(needle); // captured by emitLog, pushed to every log client
    const ms = await waitForFrame(reader, (d) => d.includes(needle));

    assert.ok(
      ms !== null,
      "a line logged while connected never arrived — the stream is being buffered. " +
        "Most likely `no-transform` was dropped from the route's Cache-Control, which " +
        "lets compression() gzip an event stream."
    );
    // Generous by three orders of magnitude: measured at 0–1ms working, and when
    // broken it does not arrive at all until ~1KB of unrelated log traffic
    // happens to flush it. There is no middle ground to be flaky in.
    assert.ok(ms < 1000, `took ${ms}ms — arriving, but not promptly`);
  } finally {
    ac.abort();
  }
});

test("the board event stream is not compressed either", async () => {
  // This file's own rule, kept: the protection is a header on a ROUTE, so every
  // stream has to set it and forgetting is invisible. /api/events is the second
  // one, and would have shipped with nothing here asserting it.
  //
  // The assertion is the header rather than a timing measurement, and that is a
  // real weakness — see the comment above, compression decides lazily so the
  // header is absent either way on small frames. What makes it worth having is
  // that /api/events frames are tiny and rare, so there is no reliable moment to
  // time; the log stream above is the case that measures, and this is the case
  // that notices a route added without the header at all.
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, {
    headers: { Cookie: `sid=${admin.sid}`, "Accept-Encoding": "gzip", Accept: "text/event-stream" },
    signal: ac.signal,
  });
  ac.abort();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  assert.match(
    res.headers.get("cache-control") || "",
    /no-transform/,
    "an event stream without no-transform is one compression() will buffer"
  );
});

test("it is still an admin-only stream", async () => {
  const { res, ac } = await openStream("/api/logs/stream");
  ac.abort();
  assert.ok(res.status === 401 || res.status === 403, `anonymous got ${res.status}`);
});

test("ordinary responses are still compressed", async () => {
  // The other half, and the one a careless "fix" breaks: switching compression
  // off wholesale would make the case above pass and cost the app ~750 KB per
  // cold load. /admin.js is served from disk and is well past the 1KB threshold
  // below which compression declines anyway.
  const res = await fetch(`${base}/admin.js`, { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip", "static assets stopped being compressed");
});
