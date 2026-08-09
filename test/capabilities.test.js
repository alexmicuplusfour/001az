// The capability registry and its generic resolution (capabilities-plan.md,
// slice 2a).
//
// The first three tests are the ones that matter: they iterate CAPABILITY_DEFS
// rather than naming capabilities, so they cover the one that does not exist
// yet. All three FAIL on the code that shipped before this slice, because the
// two cleanup paths each iterated the capabilities by hand and each stopped at
// three — `detect` was missed by both, and the three that were covered each
// cleared a different subset of their own settings namespace.
//
// ONE server for the whole file, deliberately: these tests are cheap and mostly
// read-only, and a file that stands up six of them adds enough load to the
// 8-way parallel run to starve the wall-clock-sensitive ingest sweep tests.
// Tests run in file order, so the pristine-state one goes first and the one
// that deliberately leaves a stored binding behind goes last.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startServer, adminSession, req } from "./helpers.js";
import { CAPABILITY_DEFS, CAPABILITY, bindingSettings } from "../server/capabilities.js";
import { resolveCapability } from "../server/capability-resolve.js";
import { resolveTranscriber, resolveDetector, resolveEmbedder, resolveDefaultAi } from "../server/worker.js";
import { installFromUrl, uninstall } from "../server/plugin-loader.js";
import { getSetting, setSetting, createAiKey, deleteAiKey, setPluginState } from "../server/db.js";

const FIX = (name) => fileURLToPath(new URL(`./fixtures/plugins/${name}`, import.meta.url));
const keyBound = CAPABILITY_DEFS.filter((c) => c.binding.keys?.keyId);

let srv, db;
before(async () => { srv = await startServer(); ({ db } = srv); });
after(() => srv.close());

// --- pure: no server needed ---

test("the registry stays consistent with what providers may declare", () => {
  for (const cap of CAPABILITY_DEFS) {
    // extract borrows tagging's declaration and wire, so it must never appear as
    // something a provider can advertise.
    assert.ok(CAPABILITY[cap.declaredBy], `${cap.id}: declaredBy names a real capability`);
    if (cap.floor?.kind === "builtin")
      assert.ok(cap.floor.provider, `${cap.id}: a builtin floor names its provider`);
    if (cap.floor?.kind === "delegate")
      assert.ok(CAPABILITY[cap.floor.to], `${cap.id}: a delegate floor names a real capability`);
  }
});

// --- resolution (pristine state first) ---

test("the floor kinds behave as declared", async (t) => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });

  // builtin: always resolves, and says it came from the floor.
  for (const id of ["transcribe", "detect"]) {
    const b = await resolveCapability(db, id);
    assert.equal(b.viaFloor, true, `${id}: unconfigured → floor`);
    assert.equal(b.provider, CAPABILITY[id].floor.provider);
  }
  // off / blocked: nothing resolves, and the difference is what the caller does.
  assert.equal(await resolveCapability(db, "embed"), null, "off until enabled");
  assert.equal(await resolveCapability(db, "tag"), null, "blocked: work waits, it does not fail");
  // delegate: extraction has no global binding of its own and defers to tagging.
  assert.deepEqual(await resolveCapability(db, "extract"), await resolveCapability(db, "tag"));

  // The wrappers' null-vs-never-null contracts, which differ per capability.
  assert.ok(await resolveTranscriber(db), "transcription never fails to resolve");
  assert.ok(await resolveDetector(db), "detection never fails to resolve");
  assert.equal(await resolveEmbedder(db), null);
  assert.equal(await resolveDefaultAi(db), null);
});

// --- cleanup: the two shipped bugs ---

test("deleting a key clears EVERY capability bound to it, and its whole namespace", async () => {
  await setPluginState(db, "ai:openai", { installed: true });
  const created = await createAiKey(db, "k", "openai", "sk-test");
  const keyId = created.id ?? created;

  // Bind every capability that has a global key binding to this one row, with
  // every setting in its namespace populated.
  assert.ok(keyBound.length >= 4, "tag, embed, transcribe and detect all bind a key");
  for (const cap of keyBound) {
    const k = cap.binding.keys;
    await setSetting(db, k.keyId, String(keyId));
    if (k.provider) await setSetting(db, k.provider, "openai");
    if (k.model) await setSetting(db, k.model, "pinned-model");
    if (k.enabled) await setSetting(db, k.enabled, "1");
  }

  await deleteAiKey(db, keyId);

  for (const cap of keyBound)
    for (const s of bindingSettings(cap))
      assert.equal(await getSetting(db, s), null, `${cap.id}: "${s}" survived the deletion of the key it named`);
});

test("tagging's shared model setting goes with the key — the env rung must not inherit it", async (t) => {
  // The concrete failure the whole-namespace rule fixes: `model` is read by BOTH
  // the key rung and the env rung, so a leftover "gpt-5-mini" from a deleted
  // OpenAI default key was handed to Claude on every item after the fallback.
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-env";
  t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });

  const created = await createAiKey(db, "k2", "openai", "sk-test");
  const keyId = created.id ?? created;
  await setSetting(db, "default_key_id", String(keyId));
  await setSetting(db, "model", "gpt-5-mini");
  assert.equal((await resolveDefaultAi(db)).model, "gpt-5-mini");

  await deleteAiKey(db, keyId);
  const ai = await resolveDefaultAi(db);
  assert.equal(ai.provider, "anthropic", "falls to the env rung");
  assert.notEqual(ai.model, "gpt-5-mini", "and not carrying the dead binding's model");
});

test("uninstalling a name-selected provider clears the capability it was bound to", async () => {
  const id = await installFromUrl(db, FIX("acme-detect"));
  await setSetting(db, "detect_provider", "acme.detect");
  await setSetting(db, "detect_model", "acme-detect-1");

  await uninstall(db, id);

  // An on-device plugin has no key row, so nothing else reaches these. Left
  // behind, a later reinstall silently re-activates a detector the admin removed.
  for (const s of bindingSettings(CAPABILITY.detect))
    assert.equal(await getSetting(db, s), null, `"${s}" survived the uninstall of the plugin it named`);
  assert.equal((await resolveDetector(db)).id, "localDetector", "and detection is back on its floor");
});

// --- binding and probing by capability id (slice 2b) ---

test("bind and probe are addressed by capability id, with the same rules the legacy body names get", async () => {
  const admin = await adminSession(db);
  await setPluginState(db, "ai:openai", { installed: true });
  const created = await createAiKey(db, "bind-k", "openai", "sk-test");
  const keyId = created.id ?? created;

  // A provider that advertises the capability but has no matching key.
  let r = await req(srv.base, "POST", "/api/admin/capabilities/transcribe/bind",
    { sid: admin.sid, body: { provider: "openai" } });
  assert.equal(r.status, 400);
  assert.equal(await getSetting(db, "transcribe_provider"), null, "a rejected bind stores nothing");

  // A model the provider doesn't advertise — rejected, and still stores nothing.
  r = await req(srv.base, "POST", "/api/admin/capabilities/transcribe/bind",
    { sid: admin.sid, body: { provider: "openai", keyId, model: "whisper-9-ultra" } });
  assert.equal(r.status, 400);
  assert.equal(await getSetting(db, "transcribe_provider"), null);

  // A real one sticks, and resolution picks it up.
  r = await req(srv.base, "POST", "/api/admin/capabilities/transcribe/bind",
    { sid: admin.sid, body: { provider: "openai", keyId, model: "whisper-1" } });
  assert.equal(r.status, 200);
  assert.equal((await resolveTranscriber(db)).model, "whisper-1");

  // Capability-level config rides the same route.
  r = await req(srv.base, "POST", "/api/admin/capabilities/detect/bind",
    { sid: admin.sid, body: { provider: "localDetector", config: { detect_threshold: 0.42 } } });
  assert.equal(r.status, 200);
  assert.equal(await getSetting(db, "detect_threshold"), "0.42");

  // An unknown capability is a 400, not a crash.
  r = await req(srv.base, "POST", "/api/admin/capabilities/nonsense/bind", { sid: admin.sid, body: { provider: "x" } });
  assert.equal(r.status, 400);
  r = await req(srv.base, "POST", "/api/admin/capabilities/nonsense/probe", { sid: admin.sid });
  assert.equal(r.status, 400);

  // Probing a capability with nothing bound reports the reason rather than 500.
  r = await req(srv.base, "POST", "/api/admin/capabilities/embed/probe", { sid: admin.sid });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not enabled/);

  await setSetting(db, "transcribe_provider", null);
  await setSetting(db, "transcribe_key_id", null);
  await setSetting(db, "transcribe_model", null);
  await setSetting(db, "detect_threshold", null);
  await setSetting(db, "detect_provider", null);
});

// --- leaves a stored binding behind on purpose: keep last ---

test("a bound provider that stops being usable falls to the floor and says so", async () => {
  const created = await createAiKey(db, "k3", "openai", "sk-test");
  await setSetting(db, "transcribe_provider", "openai");
  await setSetting(db, "transcribe_key_id", String(created.id ?? created));
  assert.equal((await resolveCapability(db, "transcribe")).viaFloor, false);

  // Removed on the Plugins page: the binding is still stored, but nothing serves
  // it. That divergence is the `degraded` state the capabilities page reads.
  await setPluginState(db, "ai:openai", { installed: false });
  assert.equal((await resolveCapability(db, "transcribe")).viaFloor, true);
  assert.equal(await getSetting(db, "transcribe_provider"), "openai", "the stored choice is kept — it is not silently rewritten");
});
