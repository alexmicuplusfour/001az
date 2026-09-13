// Nobody waits for a dead engine (sidecar-presence-latency-plan.md).
//
// The sibling file, sidecar-presence.test.js, pins that absence is CORRECT —
// floors resolve to nothing, items wait rather than fail, the feed says so.
// This one pins that absence is FREE: no request, ever, pays the /health
// budget to discover it.
//
// Why it needs its own stand-in. Every other test in this suite points the
// sidecar URLs at `http://127.0.0.1:1` — a CLOSED port, refused by the kernel
// instantly. That is the one flavour of absence that costs nothing, and it is
// why a 2-second stall sat on three admin routes with 1,523 tests green over
// it. A compose hostname whose service was excluded from the stack does not
// refuse; it accepts the connection and says nothing, and the reader waits out
// `AbortSignal.timeout(2000)`. `hangingSidecars()` is that host.
//
// The budget is 2000ms, so every assertion below is against a fraction of it:
// the point is never "fast", it is "did not probe".
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req, hangingSidecars, jsonBox } from "./helpers.js";
import {
  clearSidecarHealth, sweepSidecars, sidecarPresent, sidecarPresenceMap,
  startSidecarWatch, stopSidecarWatch,
} from "../server/sidecar-catalog.js";
import { resolveTranscriber } from "../server/worker.js";

const BUDGET = 2000;   // the probe's own AbortSignal.timeout
const FREE = 400;      // generous for a route that does real queries; nowhere near a probe

let srv, db, admin, hanging;

before(async () => {
  srv = await startServer();
  ({ db } = srv);
  admin = await adminSession(db);
  hanging = await hangingSidecars();
});

after(async () => {
  stopSidecarWatch();
  await hanging.close();
  await srv.close();
});

// Nothing has been probed. This is the state a fresh process is in before its
// watch has swept, and — since a test never starts the watch — the state every
// test in this file begins from.
beforeEach(clearSidecarHealth);

const ms = async (fn) => { const t = Date.now(); await fn(); return Date.now() - t; };

test("the routes that used to stall do not probe at all", async () => {
  // The three from the plan's table, measured there at 2075 / 2015 / 2029 ms.
  // The middle one is the boards strip asking about TAGGING, which has no
  // sidecar of its own — it waited two seconds on transcription and object
  // detection to render one line about an API key.
  for (const path of [
    "/api/admin/capabilities",
    "/api/admin/capabilities/tag",
    "/api/admin/plugins",
  ]) {
    const took = await ms(async () => {
      const r = await req(srv.base, "GET", path, { sid: admin.sid });
      assert.equal(r.status, 200);
    });
    assert.ok(took < FREE, `${path} took ${took}ms — a probe is back on the request path`);
  }
});

test("…and neither does the resolution hot path", async () => {
  // floorBinding asks presence once per CLAIMED ITEM. A lazy probe here was
  // the expensive one: not a page load, a queue.
  const took = await ms(async () => {
    for (let i = 0; i < 50; i++) assert.equal(await resolveTranscriber(db), null);
  });
  assert.ok(took < FREE, `50 resolves took ${took}ms`);
});

test("unprobed reads as absent, which is the safe direction", async () => {
  // Not "unknown", not a throw, not an optimistic true. Absence means the floor
  // resolves to nothing, and the caller waits and requeues — blocked semantics,
  // never an item failure. So the state a process boots in is already the state
  // it is safe to serve from.
  assert.equal(await sidecarPresent("whisper"), false);
  assert.equal(await sidecarPresent("localDetector"), false);
  assert.equal(await sidecarPresent("openai"), null, "not sidecar-backed at all — a third answer");
  assert.deepEqual([...(await sidecarPresenceMap())], [["whisper", false], ["localDetector", false]]);
});

test("the sweep is the only thing that pays, and it pays once for both engines", async () => {
  // Two engines behind one hanging host. Concurrency is why this is ~2s and not
  // ~4s — the one place that reasoning still lives, now that no request is
  // behind it.
  const took = await ms(sweepSidecars);
  assert.ok(took >= BUDGET * 0.8, `the sweep really did probe (${took}ms)`);
  assert.ok(took < BUDGET * 1.9, `both probes ran concurrently, not one after the other (${took}ms)`);
  assert.equal(await sidecarPresent("whisper"), false);
});

test("a sweep against engines that answer flips the map, and a later one flips it back", async (t) => {
  const box = await jsonBox({ model: "base" });
  const saved = [process.env.TRANSCRIBER_URL, process.env.OBJECT_DETECTOR_URL];
  process.env.TRANSCRIBER_URL = box.url();
  t.after(async () => {
    [process.env.TRANSCRIBER_URL, process.env.OBJECT_DETECTOR_URL] = saved;
    await new Promise((r) => box.close(r));
  });

  await sweepSidecars();
  assert.equal(await sidecarPresent("whisper"), true);
  assert.equal(await sidecarPresent("localDetector"), false, "the other one is still hanging");

  // Down mid-life. No TTL to wait out any more — the next sweep is the whole
  // mechanism, and what it finds is what every reader sees from then on.
  box.status = 500;
  await sweepSidecars();
  assert.equal(await sidecarPresent("whisper"), false);
});

test("the watch: the first sweep is awaitable, it keeps going, and it stops", async (t) => {
  const box = await jsonBox({ model: "base" });
  const saved = process.env.TRANSCRIBER_URL;
  process.env.TRANSCRIBER_URL = box.url();
  process.env.OBJECT_DETECTOR_URL = box.url(); // both on the box: no 2s hang in this test
  process.env.SIDECAR_WATCH_MS = "40";
  t.after(async () => {
    stopSidecarWatch();
    process.env.TRANSCRIBER_URL = saved;
    process.env.OBJECT_DETECTOR_URL = hanging.url;
    delete process.env.SIDECAR_WATCH_MS;
    await new Promise((r) => box.close(r));
  });

  // The awaited first sweep is what server.js puts before app.listen — by the
  // time the listener opens, the map is filled. That is the difference between
  // an invariant and a race won by warming a cache in time.
  await startSidecarWatch();
  assert.equal(await sidecarPresent("whisper"), true, "filled before the promise resolved");
  const afterFirst = box.hits.length;
  assert.ok(afterFirst >= 2, `both engines probed in the first sweep (${afterFirst})`);

  await new Promise((r) => setTimeout(r, 150));
  assert.ok(box.hits.length > afterFirst, "it kept sweeping");

  stopSidecarWatch();
  const atStop = box.hits.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(box.hits.length, atStop, "and stopped");
});
