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
import { startServer, adminSession, req, seedBoard } from "./helpers.js";
import { CAPABILITY_DEFS, CAPABILITY, bindingSettings } from "../server/capabilities.js";
import { resolveCapability, capabilityConfig } from "../server/capability-resolve.js";
import { setCapabilityConfig } from "../server/capability-bind.js";
import { IMAGE_PRESETS, DEFAULT_PRESET } from "../server/ai-image.js";
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

test("the tag image-preset vocabulary is pinned to IMAGE_PRESETS (ai-image-input-plan.md)", () => {
  // capabilities.js is pure data (no imports), so the enum options are a
  // literal there and the render numbers live in ai-image.js — this pin is
  // what keeps the two vocabularies from drifting.
  const def = CAPABILITY.tag.binding.config.find((f) => f.key === "tag_image_preset");
  assert.equal(def.kind, "enum");
  assert.ok(def.label);
  assert.deepEqual(def.options.map((o) => o.value), Object.keys(IMAGE_PRESETS));
  assert.equal(def.default, DEFAULT_PRESET);
  assert.ok(def.options.every((o) => o.label && o.hint), "every option carries its admin copy");
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

// --- the status feed (slice 3): runs on the still-pristine instance ---

const byId = (r) => Object.fromEntries(r.json.capabilities.map((c) => [c.id, c]));

test("the status payload on a fresh instance — every default state, in one read", async (t) => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });
  const admin = await adminSession(db);

  // Admin-only, like everything else on this surface.
  assert.equal((await req(srv.base, "GET", "/api/admin/capabilities")).status, 403);

  // A waiting item makes tag's blocked state COST something visible.
  const board = await seedBoard(db, "caps-fresh");
  await db.query(
    "INSERT INTO items (board_id, payload, status, created_at, updated_at) VALUES ($1,$2,'pending',$3,$3)",
    [board, JSON.stringify({}), Date.now()]);

  const caps = byId(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));

  // The floors serve, and say so.
  assert.equal(caps.transcribe.state, "active");
  assert.equal(caps.transcribe.viaFloor, true);
  assert.equal(caps.transcribe.running.provider, "whisper");
  assert.equal(caps.transcribe.bound.provider, "whisper", "an empty binding reads as the floor, not as nothing");
  assert.equal(caps.detect.state, "active");
  assert.equal(caps.detect.viaFloor, true);
  assert.equal(caps.detect.config[0].key, "detect_threshold");
  assert.equal(caps.detect.config[0].value, 0.3);

  // Off by explicit flag; blocked with the queue's depth attached.
  assert.equal(caps.embed.state, "off");
  assert.equal(caps.tag.state, "blocked");
  assert.ok(caps.tag.demand.waiting >= 1, "the seeded pending item is counted");
  assert.ok(caps.tag.supportedBy.find((p) => p.name === "anthropic")?.installed, "the pre-added flagship shows as installable supply");

  // Extraction delegates to tagging and follows its state; scopes are derived.
  // (board-or-global since slice 5 gave extract an app-wide default.)
  assert.equal(caps.extract.delegatesTo, "tag");
  assert.equal(caps.extract.delegatesToAgent, "tagger", "the presenter renders the noun from the feed, not a mapping");
  assert.equal(caps.extract.state, "blocked");
  assert.equal(caps.extract.scope, "board-or-global");
  assert.equal(caps.extract.boardOverrides, 0);
  assert.equal(caps.tag.scope, "board-or-global");

  // Research is a modifier nested under tagging, never a row of its own.
  assert.equal(caps.research, undefined);
  assert.equal(caps.tag.modifiers[0].id, "research");
  assert.equal(caps.tag.modifiers[0].availableNow, false, "nothing is serving tag, so its modifier isn't available either");

  // Domains are generated and honestly unavailable before anything is added.
  assert.equal(caps.crypto.state, "unavailable");
  assert.match(caps.crypto.reason, /no .* provider is installed/i);

  // The always-on entries ride the same payload.
  assert.equal(caps.ingest.state, "active");
  assert.ok(caps.ingest.handlers.some((h) => h.name === "image"));
  assert.equal(caps.source.state, "active");
  assert.ok(caps.source.sources.find((s) => s.name === "folder")?.core);

  // The page-facing fields (slice 4a): the floor's identity travels even when
  // it isn't serving; Test buttons come from data; the env rung says whether
  // the server holds its secret; the re-embed confirm is descriptor copy.
  assert.deepEqual(caps.transcribe.floor, { kind: "builtin", provider: "whisper", label: "Local Transcriber (Whisper)" });
  assert.deepEqual(caps.tag.floor, { kind: "blocked" });
  assert.equal(caps.transcribe.probeable, true);
  assert.equal(caps.extract.probeable, undefined, "a delegate has nothing of its own to probe");
  assert.deepEqual(caps.tag.env, { configured: false, provider: "anthropic", var: "ANTHROPIC_API_KEY" }, "cleared for this test — presence is the point");
  assert.match(caps.embed.rebindWarning, /re-embeds every item/);

  // The modal-facing fields (slice 4b): the agent noun keeps "Make default
  // tagger" verbatim; `binding` says which levers exist; declaredBy says which
  // provides-slice carries the model catalog.
  assert.equal(caps.tag.agent, "tagger");
  assert.equal(caps.extract.declaredBy, "tag");
  assert.deepEqual(caps.tag.binding, { provider: false, enable: false, global: true });
  assert.deepEqual(caps.embed.binding, { provider: true, enable: true, global: true });
  assert.deepEqual(caps.detect.binding, { provider: true, enable: false, global: true });
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

test("tag's image preset: enum projection, validation, and the stores-nothing covenant (Slice 2)", async () => {
  const admin = await adminSession(db);
  const bind = (body) => req(srv.base, "POST", "/api/admin/capabilities/tag/bind", { sid: admin.sid, body });

  // Projection: the enum def rides the config row; detect's row keeps its
  // exact legacy { key, value } shape (its tests deepEqual it).
  let caps = byId(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
  const row = caps.tag.config.find((f) => f.key === "tag_image_preset");
  assert.equal(row.value, "high", "unset reads as the def's default");
  assert.equal(row.kind, "enum");
  assert.ok(row.label);
  assert.deepEqual(row.options.map((o) => o.value), ["thumb", "standard", "high", "max"]);
  // The board-scoped write vocabulary ships with the entry, like boardBinding
  // does for pins — the modal must never hardcode a column name.
  assert.equal(row.boardColumn, "tag_image_preset");
  assert.deepEqual(Object.keys(caps.detect.config[0]).sort(), ["key", "value"]);

  // An unknown id is a 400 and stores nothing.
  let r = await bind({ config: { tag_image_preset: "enormous" } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /options: thumb, standard, high, max/);
  assert.equal(await getSetting(db, "tag_image_preset"), null);

  // The covenant holds for a COMBINED body: a valid key binding beside a bogus
  // config stores neither half (config is validated before the binding writes).
  const created = await createAiKey(db, "img-covenant", "openai", "sk-img");
  const keyId = created.id ?? created;
  const keyBefore = await getSetting(db, "default_key_id");
  r = await bind({ keyId, config: { tag_image_preset: "enormous" } });
  assert.equal(r.status, 400);
  assert.equal(await getSetting(db, "default_key_id"), keyBefore, "the binding half stored nothing");
  assert.equal(await getSetting(db, "tag_image_preset"), null);

  // A numeric field rejects junk through the same walk.
  r = await req(srv.base, "POST", "/api/admin/capabilities/detect/bind",
    { sid: admin.sid, body: { config: { detect_threshold: "abc" } } });
  assert.equal(r.status, 400);
  assert.equal(await getSetting(db, "detect_threshold"), null);

  // Round-trip: a real id sticks and the feed reflects it.
  r = await bind({ config: { tag_image_preset: "max" } });
  assert.equal(r.status, 200);
  assert.equal(await getSetting(db, "tag_image_preset"), "max");
  caps = byId(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
  assert.equal(caps.tag.config.find((f) => f.key === "tag_image_preset").value, "max");

  // Null clears back to the default.
  r = await bind({ config: { tag_image_preset: null } });
  assert.equal(r.status, 200);
  assert.equal(await getSetting(db, "tag_image_preset"), null);

  await deleteAiKey(db, keyId); // leave the key table as found
});

test("kind-aware capabilityConfig: numeric 0 is honored, junk and unknown ids fall to defaults", async () => {
  // The old read was `Number(v) || default`, which folded a stored 0 into the
  // default — 0 is a real threshold and must survive (deliberate behavior fix).
  await setSetting(db, "detect_threshold", "0");
  assert.equal((await capabilityConfig(db, "detect")).detect_threshold, 0);
  // Junk in the row (hand-edited — the route rejects it) reads as the default.
  await setSetting(db, "detect_threshold", "abc");
  assert.equal((await capabilityConfig(db, "detect")).detect_threshold, 0.3);
  await setSetting(db, "detect_threshold", null);
  assert.equal((await capabilityConfig(db, "detect")).detect_threshold, 0.3);
  // An enum row holding a retired id reads as the default, never an error.
  await setSetting(db, "tag_image_preset", "retired-preset");
  assert.equal((await capabilityConfig(db, "tag")).tag_image_preset, "high");
  await setSetting(db, "tag_image_preset", null);
  // Numerics store CANONICALLY — a value that validated as a number (here
  // Number(true) === 1) must be stored as one, or it would read back as the
  // default despite passing validation.
  await setCapabilityConfig(db, "detect", { detect_threshold: true });
  assert.equal(await getSetting(db, "detect_threshold"), "1");
  await setSetting(db, "detect_threshold", null);
});

test("the modal's bind bodies (4b): env-apply, one-call enable, revert, off", async (t) => {
  const admin = await adminSession(db);
  const bind = (id, body) => req(srv.base, "POST", `/api/admin/capabilities/${id}/bind`, { sid: admin.sid, body });
  const created = await createAiKey(db, "bodies", "openai", "sk-test");
  const keyId = created.id ?? created;
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-env";
  t.after(async () => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    await deleteAiKey(db, keyId);
    await setSetting(db, "model", null);
    await setSetting(db, "embed_provider", null);
    await setSetting(db, "embed_enabled", null);
  });

  // Tagger, env row selected: keyId null + model — the env rung serves.
  assert.equal((await bind("tag", { keyId: null, model: "claude-haiku-4-5" })).status, 200);
  assert.equal(await getSetting(db, "default_key_id"), null);
  assert.equal(await getSetting(db, "model"), "claude-haiku-4-5");
  assert.equal((await resolveDefaultAi(db)).keyId, "env");

  // Tagger, key row: same call shape, no provider field (tag binds by row).
  assert.equal((await bind("tag", { keyId, model: "gpt-5-mini" })).status, 200);
  assert.equal((await resolveDefaultAi(db)).keyId, keyId);

  // Embed, one call binds AND enables — the enable judges the final state.
  assert.equal((await bind("embed", { provider: null, keyId, model: "text-embedding-3-small", enabled: true })).status, 200);
  assert.equal(await getSetting(db, "embed_enabled"), "1");
  assert.equal((await resolveEmbedder(db)).model, "text-embedding-3-small");

  // Turn off keeps the binding and closes the gate.
  assert.equal((await bind("embed", { enabled: false })).status, 200);
  assert.equal(await getSetting(db, "embed_key_id"), String(keyId), "binding kept");
  assert.equal(await resolveEmbedder(db), null);

  // On-device pick by name, enabling in the same call.
  assert.equal((await bind("embed", { provider: "local", enabled: true })).status, 200);
  assert.equal((await resolveEmbedder(db)).provider, "local");

  // Revert to the floor clears the whole choice.
  await bind("transcribe", { provider: "openai", keyId, model: "whisper-1" });
  assert.equal((await bind("transcribe", { provider: "whisper" })).status, 200);
  assert.equal(await getSetting(db, "transcribe_key_id"), null);
  assert.equal(await getSetting(db, "transcribe_model"), null);
  assert.equal((await resolveTranscriber(db)).id, "whisper");
});

test("degraded says why, shows what took over — and the payload never carries key material", async (t) => {
  const admin = await adminSession(db);
  await setPluginState(db, "ai:openai", { installed: true });
  const created = await createAiKey(db, "sec", "openai", "sk-SECRET-scan-42");
  const keyId = created.id ?? created;
  await setSetting(db, "transcribe_provider", "openai");
  await setSetting(db, "transcribe_key_id", String(keyId));
  await setPluginState(db, "ai:openai", { installed: false });
  t.after(async () => {
    await setPluginState(db, "ai:openai", { installed: true });
    await deleteAiKey(db, keyId); // clears the whole transcribe namespace (proven above)
  });

  const r = await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid });
  const tr = byId(r).transcribe;
  assert.equal(tr.state, "degraded");
  assert.match(tr.reason, /removed on the Plugins page/);
  assert.equal(tr.viaFloor, true);
  assert.equal(tr.running.provider, "whisper", "what is ACTUALLY serving");
  assert.equal(tr.bound.provider, "openai", "what the admin chose");

  // `running` is built field-by-field precisely so this can never regress:
  // resolveCapability's result carries the apiKey.
  assert.ok(!JSON.stringify(r.json).includes("sk-SECRET-scan-42"), "no key material anywhere in the payload");

  // The ordering case the state machine exists for: the same broken key bound
  // as the DEFAULT TAGGER while the env rung is available. The env rung serves
  // (viaFloor false — an effective-first rule would call this healthy), but the
  // admin's stored choice is dead, so the state is degraded and `running` names
  // what actually answers.
  const savedEnv = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-env-standin";
  await setSetting(db, "default_key_id", String(keyId));
  try {
    const caps = byId(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
    assert.equal(caps.tag.state, "degraded");
    assert.equal(caps.tag.viaFloor, false);
    assert.equal(caps.tag.running.keyId, "env");
    assert.equal(caps.tag.running.provider, "anthropic");
    assert.equal(caps.tag.bound.provider, "openai", "the dead choice stays visible");
  } finally {
    if (savedEnv === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedEnv;
    await setSetting(db, "default_key_id", null);
  }
});

test("unavailable: nothing installed advertises it and there is no built-in floor", async (t) => {
  const admin = await adminSession(db);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  await setPluginState(db, "ai:anthropic", { installed: false });
  await setPluginState(db, "ai:openai", { installed: false });
  t.after(async () => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    await setPluginState(db, "ai:anthropic", { installed: true });
    await setPluginState(db, "ai:openai", { installed: true });
  });

  const caps = byId(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
  assert.equal(caps.tag.state, "unavailable");
  assert.equal(caps.extract.state, "unavailable", "the delegate follows");
  // The floored capabilities can never reach this state.
  assert.equal(caps.transcribe.state, "active");
  assert.equal(caps.detect.state, "active");
});

test("domain entries: generated, and blocked means a key is the only thing missing", async (t) => {
  const admin = await adminSession(db);
  const get = async () => byId(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
  t.after(async () => {
    await setSetting(db, "crypto_provider", null);
    await setSetting(db, "stocks_key_financialmodelingprep", null);
    await setPluginState(db, "crypto:coingecko", { installed: false });
    await setPluginState(db, "stocks:financialmodelingprep", { installed: false });
  });

  // A keyless provider serves the moment it is added.
  await setPluginState(db, "crypto:coingecko", { installed: true });
  let caps = await get();
  assert.equal(caps.crypto.state, "active");
  assert.equal(caps.crypto.running.provider, "coingecko");

  // A keyed provider without its key: configured target, cannot serve — blocked,
  // the same meaning the state has for tagging.
  await setPluginState(db, "stocks:financialmodelingprep", { installed: true });
  caps = await get();
  assert.equal(caps.stocks.state, "blocked");
  assert.match(caps.stocks.reason, /needs an API key/);
  await setSetting(db, "stocks_key_financialmodelingprep", "fmp-test-key");
  caps = await get();
  assert.equal(caps.stocks.state, "active");

  // Star a provider that can't serve: the sibling scan takes over and the
  // payload says so instead of silently absorbing it.
  await setSetting(db, "crypto_provider", "coinmarketcap");
  caps = await get();
  assert.equal(caps.crypto.state, "degraded");
  assert.match(caps.crypto.reason, /took over/);
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
