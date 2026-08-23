// Object-detection slot: the fourth AI capability beside tag / embed / transcribe.
// The local detector is the on-server object-detector SIDECAR (LLMDet), so its
// provider is catalog-only (wire: null) like the whisper transcriber, and
// resolveDetector resolves it directly. A keyed provider that advertises `detects`
// routes through wire.detect via detectObjects (the paid path, stubbed here). None
// of these tests hit the real sidecar — resolution returns the engine descriptor
// without calling detect(), and the dispatch test uses a stub wire.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import { resolveDetector, detectionDemux, imageForDetection } from "../server/worker.js";
import sharp from "sharp";
import { detectObjects, providerCatalog, PROVIDERS, registerProvider, unregisterProvider } from "../server/providers.js";
import { setSetting } from "../server/db.js";

const LOCAL_MODEL = "iSEE-Laboratory/llmdet_tiny";

// --- pure: the descriptor contract + dispatch ---

test("descriptor: the on-device detector is catalog-only (wire null) and advertises detects", () => {
  const d = PROVIDERS.localDetector;
  assert.equal(d.onDevice, true);
  assert.equal(d.keyless, true);
  assert.equal(d.wire, null); // the sidecar HTTP call lives in the worker, like whisper
  assert.equal(d.detects.default, LOCAL_MODEL);
});

test("catalog: detection rides through provides with default + models; a non-detect provider has no entry", () => {
  const c = providerCatalog().find((p) => p.name === "localDetector");
  assert.ok(c);
  assert.equal(c.onDevice, true);
  assert.equal(c.provides.detect.default, LOCAL_MODEL);
  assert.ok(Array.isArray(c.provides.detect.models) && c.provides.detect.models.length);
  assert.equal(providerCatalog().find((p) => p.name === "anthropic").provides.detect, undefined);
});

test("dispatch: detectObjects routes to a keyed provider's wire.detect (the paid path)", async () => {
  let seen = null;
  registerProvider("stubdet", {
    label: "StubDet",
    onDevice: true, // exempt from rate-limit contract
    wire: { detect: (_desc, rest) => { seen = rest; return [{ label: "x", box: [0, 0, 1, 1], score: 0.9 }]; } },
    detects: { default: "stub-1", models: [{ id: "stub-1", note: "t" }] },
  });
  try {
    const out = await detectObjects({ provider: "stubdet", image: Buffer.from("img"), queries: ["cat."], threshold: 0.2 });
    assert.deepEqual(out, [{ label: "x", box: [0, 0, 1, 1], score: 0.9 }]);
    assert.equal(seen.threshold, 0.2);
    assert.deepEqual(seen.queries, ["cat."]);
    assert.ok(Buffer.isBuffer(seen.image));
  } finally {
    unregisterProvider("stubdet");
  }
});

test("sidecar client: failure taxonomy — unreachable transient, 422 permanent, 5xx transient", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const db = { query: async () => ({ rows: [] }) }; // no settings → the default localDetector sidecar
  const eng = await resolveDetector(db);
  const img = Buffer.from("img");

  // sidecar unreachable → transient; the extract leg requeues (no status set)
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(eng.detect(img, ["cat"]),
    (e) => /object-detector unreachable/.test(e.message) && e.transient === true);

  // undecodable image → 422: permanent-shaped (4xx ≠ 408/429) so failOrRequeue
  // parks it on attempt one instead of burning the retry budget, and the
  // sidecar's reason rides through in the message.
  globalThis.fetch = async () => ({ ok: false, status: 422, json: async () => ({ error: "undecodable image: cannot identify" }) });
  await assert.rejects(eng.detect(img, ["cat"]),
    (e) => e.status === 422 && e.transient !== true && /undecodable image/.test(e.message));

  // a genuine inference fault → 500: NOT permanent → the extract leg requeues
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
  await assert.rejects(eng.detect(img, ["cat"]),
    (e) => e.status === 500 && /boom/.test(e.message));
});

// --- pure: the demux (query build + label routing) ---

test("demux: queries come from the instruction's synonyms, else the de-snaked key", () => {
  const d = detectionDemux([
    { key: "car", instruction: "car, automobile" },
    { key: "license_plate", instruction: "" }, // no instruction → de-snaked key
  ]);
  assert.deepEqual(d.queries, ["car", "automobile", "license plate"]);
});

test("demux: a trailing period in an instruction still matches the sidecar's period-stripped label", () => {
  // Regression: the sidecar feeds "car." and echoes label "car"; an instruction typed
  // "car." must normalize to "car" or the box is silently dropped.
  const d = detectionDemux([{ key: "car", instruction: "car." }]);
  const byField = d.route([{ label: "car", box: [0, 0, 0.5, 0.5], score: 0.9 }]);
  assert.equal(byField.get("car").length, 1);
});

test("demux: boxes route to their field by label; an unasked label is dropped", () => {
  const d = detectionDemux([{ key: "car", instruction: "car" }, { key: "wheel", instruction: "wheel" }]);
  const byField = d.route([
    { label: "car", box: [0, 0, 1, 1], score: 0.8 },
    { label: "Wheel", box: [0, 0, 1, 1], score: 0.7 }, // case-insensitive
    { label: "tree", box: [0, 0, 1, 1], score: 0.6 },  // never queried → dropped
  ]);
  assert.equal(byField.get("car").length, 1);
  assert.equal(byField.get("wheel").length, 1);
  assert.deepEqual([...byField.keys()], ["car", "wheel"]); // no stray "tree" field
});

test("demux: a query shared by two fields is deduped once, first field wins the label", () => {
  const d = detectionDemux([{ key: "a", instruction: "car" }, { key: "b", instruction: "car" }]);
  assert.deepEqual(d.queries, ["car"]); // sent to the detector once
  const byField = d.route([{ label: "car", box: [0, 0, 1, 1], score: 0.9 }]);
  assert.equal(byField.get("a").length, 1);
  assert.equal(byField.get("b").length, 0);
});

// --- pure: image prep before the detector ---

test("imageForDetection caps the long edge and shrinks the payload; boxes stay 0..1 so scale is safe", async () => {
  const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png().toBuffer();
  const out = await imageForDetection(big);
  const meta = await sharp(out).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 1333, "long edge capped");
  // Aspect preserved to within integer-pixel rounding — a uniform scale keeps 0..1 boxes exact.
  assert.ok(Math.abs(meta.width / meta.height - 4000 / 3000) < 0.01, "aspect ratio preserved");
  assert.equal(meta.format, "jpeg");
  assert.ok(out.length < big.length, "payload shrank");
});

test("imageForDetection never enlarges a small image", async () => {
  const small = await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png().toBuffer();
  const meta = await sharp(await imageForDetection(small)).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 150);
});

test("imageForDetection falls back to the original bytes on an undecodable image (sidecar then 422-parks it)", async () => {
  const junk = Buffer.from("this is not an image");
  assert.equal(await imageForDetection(junk), junk);
});

// --- integration: resolution + config validation through the server ---

let srv, db, admin;
before(async () => { srv = await startServer(); ({ db } = srv); admin = await adminSession(db); });
after(() => srv.close());

test("resolveDetector defaults to the on-server object-detector sidecar (no settings)", async () => {
  const d = await resolveDetector(db);
  assert.equal(d.id, "localDetector");
  assert.equal(d.model, LOCAL_MODEL);
  assert.equal(typeof d.detect, "function"); // the sidecar HTTP client (not called here)
});

test("resolveDetector is capability-gated: a no-detect provider falls back to local", async () => {
  await setSetting(db, "detect_provider", "anthropic"); // advertises no detects
  try {
    assert.equal((await resolveDetector(db)).id, "localDetector");
  } finally {
    await setSetting(db, "detect_provider", null);
  }
});

test("the capabilities feed exposes the detect binding; bind gates the provider and stores the threshold", async () => {
  const detectOf = (r) => r.json.capabilities.find((c) => c.id === "detect");
  const cfg = detectOf(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
  assert.equal(cfg.bound.provider, "localDetector", "an empty binding reads as the floor");
  assert.equal(cfg.running.provider, "localDetector");
  assert.deepEqual(cfg.config, [{ key: "detect_threshold", value: 0.3 }]);

  // A provider that advertises no detection is refused.
  const bad = await req(srv.base, "POST", "/api/admin/capabilities/detect/bind", { sid: admin.sid, body: { provider: "anthropic" } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /advertises none|object detection/);

  // The on-device detector is picked by name; the threshold knob persists.
  const ok = await req(srv.base, "POST", "/api/admin/capabilities/detect/bind",
    { sid: admin.sid, body: { provider: "localDetector", config: { detect_threshold: 0.25 } } });
  assert.equal(ok.status, 200);
  const next = detectOf(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
  assert.equal(next.bound.provider, "localDetector");
  assert.deepEqual(next.config, [{ key: "detect_threshold", value: 0.25 }]);
  await setSetting(db, "detect_threshold", null); // leave settings as found
});
