// Object-detection slot: the fourth AI capability beside tag / embed / transcribe.
// The local detector is the on-server object-detector SIDECAR (LLMDet), so its
// provider is catalog-only (wire: null) like the whisper transcriber, and
// resolveDetector resolves it directly. A keyed provider that advertises `detects`
// routes through wire.detect via detectObjects (the paid path, stubbed here). None
// of these tests hit the real sidecar — resolution returns the engine descriptor
// without calling detect(), and the dispatch test uses a stub wire.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, adminSession, seedBoard, req, meterTotals, until } from "./helpers.js";
import { resolveDetector, detectionDemux, imageForDetection, startWorker } from "../server/worker.js";
import sharp from "sharp";
import { detectObjects, providerCatalog, PROVIDERS, registerProvider, unregisterProvider } from "../server/providers.js";
import { setSetting, createBoard, createAiKey, createEntity, insertItem,
  boardUsageSummary, APP_SCOPE } from "../server/db.js";
import { probeCapability } from "../server/capability-probe.js";

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
    // { objects, usage } — the same shape embed and transcribe answer in, so a
    // detector that bills in TOKENS can say so (metering-plan.md Stage 5c).
    wire: { detect: (_desc, rest) => {
      seen = rest;
      return { objects: [{ label: "x", box: [0, 0, 1, 1], score: 0.9 }], usage: { input: 700, output: 20 } };
    } },
    detects: { default: "stub-1", models: [{ id: "stub-1", note: "t" }] },
  });
  try {
    const out = await detectObjects({ provider: "stubdet", image: Buffer.from("img"), queries: ["cat."], threshold: 0.2 });
    assert.deepEqual(out.objects, [{ label: "x", box: [0, 0, 1, 1], score: 0.9 }]);
    assert.deepEqual(out.usage, { input: 700, output: 20 });
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

// --- metering: the leg, the probe, and the free case (Stage 5c) ---

// One image through the whole extract leg, sidecar stubbed at the fetch layer
// like audio.test.js's — but DRIVEN through the worker, because `extractOne`
// lives inside startWorker's closure and there is no other door (transcribeOne
// is exported, which is why its test needs no worker at all). Detection was the
// last capability spending nothing visible: every call was free, but "free" and
// "unmetered" are different claims and only one of them was true.
test("the detect leg meters one image to its board, priced at the on-device zero", async (t) => {
  const mapping = { fields: [{ key: "car", source: "detect", instruction: "car" }] };
  // A key only opens the claim gate (claimFairBatch wants one on the board);
  // no facets means the tag leg that follows completes without a model call.
  const keyId = await createAiKey(db, "detect-meter-k", "openai", "sk-test");
  const boardId = await createBoard(db, "detect-meter", [], "", true, keyId, null, { enabled: true }, false, { mapping });

  const name = "aa11bb22cc33.png";
  fs.mkdirSync(srv.galleryDir, { recursive: true });
  fs.writeFileSync(path.join(srv.galleryDir, name),
    await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer());
  const eid = await createEntity(db, boardId, { identity: name });
  const iid = await insertItem(db, boardId, {
    identity: name, fields: {}, mapping,
    files: [{ name, original_name: "street.png", kind: "image" }],
  }, "pending_extract", eid);

  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    if (String(url).includes("/detect"))
      return { ok: true, status: 200, json: async () => ({ objects: [{ label: "car", box: [0.1, 0.1, 0.5, 0.5], score: 0.9 }] }) };
    throw new Error("no network in this test"); // nothing else may reach out
  };

  process.env.POLL_MS = "50";
  t.after(() => { delete process.env.POLL_MS; });
  const stop = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
  try {
    await until(async () =>
      (await db.query("SELECT status FROM items WHERE id=$1", [iid])).rows[0]?.status !== "pending_extract");
  } finally {
    await stop();
  }

  // One call, one image — the two units this call site KNOWS it spent. Many
  // queries ride a single pass, so the IMAGE is the quantity, not the query.
  const m = await meterTotals(db, boardId, "detect");
  assert.deepEqual([m.calls, m.images, m.provider, m.model], [1, 1, "localDetector", LOCAL_MODEL]);
  assert.equal(m.input, 0, "the sidecar reported no usage, so no token row was written");

  // On-device → install() normalizes it to a provider-wide $0, so this is a
  // KNOWN zero with nothing left over — not the absent figure an unpriced
  // model gets. "4,213 detections · $0.00" is a true thing to say.
  const { cost } = await boardUsageSummary(db, boardId);
  assert.deepEqual(cost, { micros: 0, unpriced: [] });

  // The job row names the engine that actually ran. It used to stamp the
  // literal string "detection" into the MODEL slot on a detect-only board —
  // a placeholder standing where a model name goes.
  const { rows: [job] } = await db.query(
    "SELECT outcome, detail FROM job_log WHERE board_id=$1 AND kind='extract'", [boardId]);
  assert.equal(job.outcome, "ok");
  assert.equal(job.detail.model, LOCAL_MODEL);
  assert.equal(job.detail.provider, "localDetector");
  assert.ok(!("tokens" in job.detail), "a keyless engine reported none — absent, not zeroed");
});

// The half of Stage 5a that 5b left open: embed and transcribe probes already
// file their ping at the app scope, and this was the last one spending in the
// dark. A probe is a paid call too.
test("the detect probe meters its ping at the app scope", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("/detect")) return { ok: true, status: 200, json: async () => ({ objects: [] }) };
    if (String(url).includes("/health")) return { ok: true, status: 200, json: async () => ({ model: LOCAL_MODEL }) };
    return original(url, opts);
  };
  const before2 = await meterTotals(db, APP_SCOPE, "detect");
  const r = await probeCapability(db, "detect");
  assert.deepEqual([r.ok, r.provider, r.count], [true, "localDetector", 0]);
  const after2 = await meterTotals(db, APP_SCOPE, "detect");
  assert.deepEqual([after2.calls - before2.calls, after2.images - before2.images], [1, 1]);
});

// A plugin written against the pre-5c contract still answers a bare array.
// The dispatcher normalizes it rather than letting it through, because the old
// shape does NOT fail loudly on the leg: `objects` would destructure to
// undefined, demux.route() reads it as `|| []`, and the item lands "No objects
// detected" while the meter bills the image. A silent wrong answer on a paid
// path is the one outcome worth a test.
test("a legacy plugin's bare array still detects — normalized at the dispatcher", async () => {
  registerProvider("olddet", {
    label: "OldDet",
    onDevice: true, // exempt from the rate-limit contract
    wire: { detect: async () => [{ label: "car", box: [0, 0, 1, 1], score: 0.8 }] },
    detects: { default: "old-1", models: [{ id: "old-1", note: "t" }] },
  });
  try {
    const out = await detectObjects({ provider: "olddet", image: Buffer.from("i"), queries: ["car."] });
    assert.deepEqual(out.objects, [{ label: "car", box: [0, 0, 1, 1], score: 0.8 }]);
    assert.deepEqual(out.usage, {}, "it declared no spend — silence, not zeros");
    // The boxes reach their field, which is the thing that silently stopped.
    assert.equal(detectionDemux([{ key: "car", instruction: "car" }]).route(out.objects).get("car").length, 1);
  } finally {
    unregisterProvider("olddet");
  }
});
