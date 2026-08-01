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
import { resolveDetector } from "../server/worker.js";
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

test("catalog: detects rides through with default + models; a non-detect provider is null", () => {
  const c = providerCatalog().find((p) => p.name === "localDetector");
  assert.ok(c);
  assert.equal(c.onDevice, true);
  assert.equal(c.detects.default, LOCAL_MODEL);
  assert.ok(Array.isArray(c.detects.models) && c.detects.models.length);
  assert.equal(providerCatalog().find((p) => p.name === "anthropic").detects, null);
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

test("GET ai-config exposes the detect block; POST gates the provider and stores the threshold", async () => {
  const cfg = (await req(srv.base, "GET", "/api/admin/ai-config", { sid: admin.sid })).json;
  assert.equal(cfg.detect.provider, "localDetector");
  assert.equal(cfg.detect.active, "localDetector");
  assert.equal(cfg.detect.threshold, 0.3);

  // A provider that advertises no detection is refused.
  const bad = await req(srv.base, "POST", "/api/admin/ai-config", { sid: admin.sid, body: { detectProvider: "anthropic" } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /advertises none|object detection/);

  // The on-device detector is picked by name; the threshold knob persists.
  const ok = await req(srv.base, "POST", "/api/admin/ai-config", { sid: admin.sid, body: { detectProvider: "localDetector", detectThreshold: 0.25 } });
  assert.equal(ok.status, 200);
  const next = (await req(srv.base, "GET", "/api/admin/ai-config", { sid: admin.sid })).json;
  assert.equal(next.detect.provider, "localDetector");
  assert.equal(next.detect.threshold, 0.25);
  await setSetting(db, "detect_threshold", null); // leave settings as found
});
