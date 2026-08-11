// Per-board capability pins (capabilities-plan.md, slice 5a).
//
// The claims under test, in ladder order: a board's own pin outranks the app
// default; a pin of the BUILT-IN is a real choice (the cost-control case: the
// app default is paid, one board keeps the free sidecar); a broken pin falls to
// the app default rather than dying; writes are judged by the same rule as the
// global bind (a key from a provider that can't serve is refused, not silently
// absorbed at runtime); and extraction's new app-wide default sits between a
// board's extract pin and the delegation to the tagger.
//
// ONE server for the whole file (house rule — see capabilities.test.js). Tests
// run in file order and later tests do arithmetic over pins created by earlier
// ones, so the order is load-bearing: the pristine feed test goes first and the
// state-leaving extract-ladder test goes last.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startServer, adminSession, seedUser, req } from "./helpers.js";
import { CAPABILITY_DEFS, CAPABILITY } from "../server/capabilities.js";
import { resolveCapability } from "../server/capability-resolve.js";
import { resolveTranscriber, resolveDetector } from "../server/worker.js";
import { installFromUrl, uninstall } from "../server/plugin-loader.js";
import { getBoard, createAiKey, deleteAiKey, listAiKeys, countBoardOverrides, setSetting, setPluginState, setBoardMembers, BOARD_BINDING_COLS } from "../server/db.js";

const FIX = (name) => fileURLToPath(new URL(`./fixtures/plugins/${name}`, import.meta.url));

let srv, db, admin;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  admin = await adminSession(db);
  await setPluginState(db, "ai:openai", { installed: true });
});
after(() => srv.close());

const byId = (r) => Object.fromEntries(r.json.capabilities.map((c) => [c.id, c]));
const caps = async () => byId(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
const bind = (id, body) => req(srv.base, "POST", `/api/admin/capabilities/${id}/bind`, { sid: admin.sid, body });
const patchBoard = (id, body) => req(srv.base, "PATCH", `/api/admin/boards/${id}`, { sid: admin.sid, body });
const newBoard = async (name, body = {}) => {
  const r = await req(srv.base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name, facets: [], ...body } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id;
};
const newKey = async (name, provider) => {
  const created = await createAiKey(db, name, provider, "sk-" + name);
  return created.id ?? created;
};

// --- the feed, pristine (keep first) ---

test("the feed says which capabilities boards may pin, and the column names to write", async () => {
  const c = await caps();
  // Scopes are derived from the registry: transcribe/detect gained board scope,
  // extract gained the app-wide default, embed deliberately stays global.
  assert.equal(c.transcribe.scope, "board-or-global");
  assert.equal(c.detect.scope, "board-or-global");
  assert.equal(c.extract.scope, "board-or-global");
  assert.equal(c.tag.scope, "board-or-global");
  assert.equal(c.embed.scope, "global");
  // The write vocabulary ships with the entry — the board modal posts these
  // field names without ever naming a capability.
  assert.deepEqual(c.transcribe.boardBinding, { provider: "transcribe_provider", keyId: "transcribe_key_id", model: "transcribe_model" });
  assert.deepEqual(c.tag.boardBinding, { keyId: "ai_key_id", model: "ai_model" });
  assert.equal(c.embed.boardBinding, undefined);
  // `binding.global` = there is an app-wide default to bind (the modal's
  // dispatch gate; extract's is the slice-5 addition).
  for (const id of ["tag", "extract", "embed", "transcribe", "detect"]) {
    assert.equal(c[id].binding.global, true, `${id} has a global default`);
  }
  assert.equal(c.transcribe.boardOverrides, 0);
  assert.equal(c.detect.boardOverrides, 0);
});

// --- the write path: judged like the global bind, rejected writes store nothing ---

let okKeyId; // t-ok, an openai key — reused by the lifecycle test below

test("board pins are validated — provider XOR key, advertisement, and the model rule", async () => {
  const okId = (okKeyId = await newKey("t-ok", "openai")); // advertises transcription
  const badId = await newKey("t-bad", "anthropic"); // does not
  const id = await newBoard("pins-validate");

  let r = await patchBoard(id, { transcribe_provider: "whisper", transcribe_key_id: okId });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not both/);

  r = await patchBoard(id, { transcribe_key_id: badId });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /advertises no transcription/);

  // The same strictness now covers the tagger-era columns: a key can only pin a
  // capability its provider can actually serve (openai advertises no detection).
  r = await patchBoard(id, { detect_key_id: okId });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /advertises no object detection/);

  // A keyed provider pinned by name is a category error — names are for
  // on-device engines.
  r = await patchBoard(id, { transcribe_provider: "openai" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /instead of naming it/);

  // pinnedModelMustBeAdvertised holds for board pins too — a bogus model would
  // requeue every clip for ever.
  r = await patchBoard(id, { transcribe_key_id: okId, transcribe_model: "whisper-9-ultra" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /no transcription model/);

  r = await patchBoard(id, { transcribe_key_id: 999999 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /unknown transcribe_key_id/);

  // None of the rejections stored anything.
  const b = await getBoard(db, id);
  assert.equal(b.transcribe_provider, null);
  assert.equal(b.transcribe_key_id, null);
  assert.equal(b.transcribe_model, null);
  assert.equal(b.detect_key_id, null);
});

test("pin lifecycle: each clear touches only its own columns, and the two pin kinds displace each other", async () => {
  const id = await newBoard("pins-lifecycle");

  assert.equal((await patchBoard(id, { transcribe_provider: "whisper" })).status, 200);
  assert.equal((await getBoard(db, id)).transcribe_provider, "whisper");

  // A keyId clear that never mentioned the provider must not wipe a name pin.
  assert.equal((await patchBoard(id, { transcribe_key_id: null })).status, 200);
  assert.equal((await getBoard(db, id)).transcribe_provider, "whisper");

  // A keyed pin displaces the name pin (provider XOR keyId at rest).
  assert.equal((await patchBoard(id, { transcribe_key_id: okKeyId, transcribe_model: "whisper-1" })).status, 200);
  let b = await getBoard(db, id);
  assert.equal(b.transcribe_provider, null);
  assert.equal(Number(b.transcribe_key_id), okKeyId);
  assert.equal(b.transcribe_model, "whisper-1");

  // keyId: null clears the model that pointed with it.
  assert.equal((await patchBoard(id, { transcribe_key_id: null })).status, 200);
  b = await getBoard(db, id);
  assert.equal(b.transcribe_key_id, null);
  assert.equal(b.transcribe_model, null);

  // The full clear — what the picker's App default row sends — from a name pin.
  assert.equal((await patchBoard(id, { transcribe_provider: "whisper" })).status, 200);
  assert.equal((await patchBoard(id, { transcribe_provider: null, transcribe_key_id: null, transcribe_model: null })).status, 200);
  b = await getBoard(db, id);
  assert.equal(b.transcribe_provider, null);
  assert.equal(b.transcribe_key_id, null);
  assert.equal(b.transcribe_model, null);
});

test("a rejected pin on CREATE leaves no board behind — validation runs before the INSERT", async () => {
  const count = async () => (await db.query("SELECT COUNT(*)::int AS c FROM boards")).rows[0].c;
  const before = await count();
  const r = await req(srv.base, "POST", "/api/admin/boards",
    { sid: admin.sid, body: { name: "never-born", facets: [], transcribe_key_id: 999999 } });
  assert.equal(r.status, 400);
  assert.equal(await count(), before);
});

// --- board-scoped CONFIG columns: the same write path, none of the pin rules
// (ai-image-input-plan.md §4) ---

test("a board-scoped config column rides the pin path: derived, written, cleared, validated", async () => {
  // Derivation, first: the column reaches the SELECT list / updateBoard
  // allow-list / admin payload off the registry, so a def edit is the whole
  // wiring. A hand-added column would pass the round-trips below and still be
  // invisible to a fresh capability — this is the assertion that catches that.
  assert.ok(BOARD_BINDING_COLS.includes("tag_image_preset"), "config boardColumns join the derived list");

  // On CREATE, beside a pin — one body, both kinds.
  const keyId = await newKey("cfg-key", "openai");
  const id = await newBoard("img-preset", { tag_image_preset: "max", ai_key_id: keyId });
  assert.equal((await getBoard(db, id)).tag_image_preset, "max");
  assert.equal(Number((await getBoard(db, id)).ai_key_id), keyId, "the pin in the same body landed too");

  // PATCH sets, and clears back to the app default. "" clears like null (the
  // select's empty option).
  assert.equal((await patchBoard(id, { tag_image_preset: "standard" })).status, 200);
  assert.equal((await getBoard(db, id)).tag_image_preset, "standard");
  assert.equal((await patchBoard(id, { tag_image_preset: null })).status, 200);
  assert.equal((await getBoard(db, id)).tag_image_preset, null, "null = use the app default");
  await patchBoard(id, { tag_image_preset: "high" });
  assert.equal((await patchBoard(id, { tag_image_preset: "" })).status, 200);
  assert.equal((await getBoard(db, id)).tag_image_preset, null, '"" clears like null');

  // An unknown id is refused with the same message the global knob gives, and
  // the WHOLE body is discarded — the pins' stores-nothing contract, inherited
  // because boardBindingPatch throws before updateBoard runs.
  await patchBoard(id, { tag_image_preset: "high" });
  const r = await patchBoard(id, { name: "img-preset-renamed", tag_image_preset: "enormous" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /options: thumb, standard, high, max/);
  const after = await getBoard(db, id);
  assert.equal(after.tag_image_preset, "high", "the rejected value never landed");
  assert.equal(after.name, "img-preset", "and neither did the valid half of the body");

  // …and a non-admin BOARD MANAGER may set it through their own save route.
  // The authority line: a knob is a cost dial like ai_votes (which managers
  // already set), not a credential — pins stay admin-only.
  const mgr = await seedUser(db, "img-mgr@test.local");
  await setBoardMembers(db, id, [mgr.id], [mgr.id]); // board-admin = manager
  const asMgr = (body) => req(srv.base, "PATCH", `/api/boards/${id}`, { sid: mgr.sid, body });
  assert.equal((await asMgr({ tag_image_preset: "standard" })).status, 200);
  assert.equal((await getBoard(db, id)).tag_image_preset, "standard", "a manager may set the knob");
  const mgrBad = await asMgr({ tag_image_preset: "enormous" });
  assert.equal(mgrBad.status, 400, "…judged by the same rule as the admin route");
  assert.equal((await getBoard(db, id)).tag_image_preset, "standard");
  // Their settings payload carries the knob AND its vocabulary (they can't
  // read admin feeds), but never the pins.
  const mgrView = await req(srv.base, "GET", `/api/boards/${id}/settings`, { sid: mgr.sid });
  assert.equal(mgrView.status, 200);
  assert.equal(mgrView.json.tag_image_preset, "standard");
  assert.equal(mgrView.json.ai_key_id, undefined, "pins stay admin-only");
  const cat = mgrView.json.capability_config.find((f) => f.boardColumn === "tag_image_preset");
  assert.equal(cat.value, "high", "the app-wide default the 'App default (…)' row names");
  assert.deepEqual(cat.options.map((o) => o.value), ["thumb", "standard", "high", "max"]);
  await patchBoard(id, { tag_image_preset: "high" }); // back to where the rest of the test expects it

  // A rejected config on CREATE leaves no board behind, exactly like a pin.
  const count = async () => (await db.query("SELECT COUNT(*)::int AS c FROM boards")).rows[0].c;
  const before = await count();
  const bad = await req(srv.base, "POST", "/api/admin/boards",
    { sid: admin.sid, body: { name: "never-born-2", facets: [], tag_image_preset: "enormous" } });
  assert.equal(bad.status, 400);
  assert.equal(await count(), before);

  // Untouched by an unrelated edit (the absent-means-untouched rule).
  assert.equal((await patchBoard(id, { context: "unrelated" })).status, 200);
  assert.equal((await getBoard(db, id)).tag_image_preset, "high");

  await deleteAiKey(db, keyId);
  // A deleted key clears the PIN and leaves the config alone — config is not a
  // pointer, so no cleanup loop touches it.
  assert.equal((await getBoard(db, id)).tag_image_preset, "high", "config survives key deletion");
});

// --- the core case: two boards, two answers ---

test("a board pinned to the built-in keeps it while the app default is paid — and the mirror", async () => {
  const keyId = await newKey("t-core", "openai");

  // App default: the paid engine.
  assert.equal((await bind("transcribe", { provider: "openai", keyId, model: "whisper-1" })).status, 200);
  const builtinBoard = await newBoard("core-builtin", { transcribe_provider: "whisper" }); // pins ride the create
  const plainBoard = await newBoard("core-default");

  const pinnedEng = await resolveTranscriber(db, await getBoard(db, builtinBoard));
  assert.equal(pinnedEng.id, "whisper", "the board's built-in pin wins over the paid app default");
  const plainEng = await resolveTranscriber(db, await getBoard(db, plainBoard));
  assert.equal(plainEng.id, "openai");
  assert.equal(plainEng.model, "whisper-1");

  // The mirror: app default reverted to the floor, one board pins the paid key.
  assert.equal((await bind("transcribe", { provider: "whisper" })).status, 200);
  const paidBoard = await newBoard("core-paid", { transcribe_key_id: keyId, transcribe_model: "whisper-1" });
  assert.equal((await resolveTranscriber(db, await getBoard(db, paidBoard))).id, "openai");
  assert.equal((await resolveTranscriber(db, await getBoard(db, plainBoard))).id, "whisper");
});

// --- a named on-device engine that is NOT the floor ---

let acmePluginId;
test("a board pin of an installed on-device engine resolves its own wire, not the sidecar", async () => {
  acmePluginId = await installFromUrl(db, FIX("acme-detect"));
  const id = await newBoard("det-acme", { detect_provider: "acme.detect" });
  const eng = await resolveDetector(db, await getBoard(db, id));
  assert.equal(eng.id, "acme.detect");
  assert.equal(eng.model, "acme-detect-1", "the pin inherits the engine's declared default model");
  // An unpinned resolution is untouched by any board's pin.
  assert.equal((await resolveDetector(db, null)).id, "localDetector");
});

test("a pin whose provider is removed on the Plugins page falls to the app default", async (t) => {
  await setPluginState(db, "ai:acme.detect", { installed: false });
  t.after(() => setPluginState(db, "ai:acme.detect", { installed: true }));
  const board = (await listBoardsByName(db, "det-acme"))[0];
  assert.equal((await resolveDetector(db, board)).id, "localDetector", "served by the floor via the global walk — never dead");
  // The pin itself is kept — removal is reversible, and it resumes on reinstall.
  assert.equal(board.detect_provider, "acme.detect");
});

// --- the counting surfaces: overrides and boards_using span every pin column ---

test("override counts and boards_using see every kind of pin", async () => {
  // Running tally from the tests above: two transcribe pins (core-builtin by
  // name, core-paid by key), one detect pin (det-acme by name).
  assert.equal(await countBoardOverrides(db, CAPABILITY.transcribe.binding.boardKeys), 2, "a provider-only pin counts too");
  assert.equal(await countBoardOverrides(db, CAPABILITY.detect.binding.boardKeys), 1);

  // Pin extraction on a second board with the SAME key that core-paid uses for
  // transcription: boards_using must count across capability columns.
  const keys = await listAiKeys(db);
  const core = keys.find((k) => k.name === "t-core");
  const plain = (await listBoardsByName(db, "core-default"))[0];
  assert.equal((await patchBoard(plain.id, { extract_key_id: core.id })).status, 200);

  const counted = (await listAiKeys(db)).find((k) => k.name === "t-core");
  assert.equal(Number(counted.boards_using), 2, "one board pins it for transcription, another for extraction");
  assert.equal(Number((await listAiKeys(db)).find((k) => k.name === "t-bad").boards_using), 0);
});

// --- cleanup: deletion and uninstall reach board pins ---

test("deleting a key clears the board's pinned model beside the FK-nulled pointer", async () => {
  const keyId = await newKey("t-del", "openai");
  const id = await newBoard("del-board", { transcribe_key_id: keyId, transcribe_model: "whisper-1" });
  assert.equal((await getBoard(db, id)).transcribe_model, "whisper-1");

  await deleteAiKey(db, keyId);
  const b = await getBoard(db, id);
  assert.equal(b.transcribe_key_id, null, "the FK clears the pointer");
  assert.equal(b.transcribe_model, null, "the registry loop clears the model that pointed with it");
});

test("uninstalling a plugin clears board pins of its name — no silent re-activation later", async () => {
  await uninstall(db, acmePluginId);
  const board = (await listBoardsByName(db, "det-acme"))[0];
  assert.equal(board.detect_provider, null, "a true uninstall leaves nothing behind, board pins included");
  assert.equal((await resolveDetector(db, board)).id, "localDetector");
});

// --- the board payload ships the pin columns (admin-only, registry-derived) ---

test("board settings carry every pin column for the modal's pickers", async () => {
  const board = (await listBoardsByName(db, "core-paid"))[0];
  const r = await req(srv.base, "GET", `/api/boards/${board.id}/settings`, { sid: admin.sid });
  assert.equal(r.status, 200);
  // Every board-scoped column the registry declares — pins AND config knobs
  // (the modal's pickers preselect off these).
  for (const col of BOARD_BINDING_COLS) {
    assert.ok(col in r.json, `settings payload carries ${col}`);
  }
  assert.equal(Number(r.json.transcribe_key_id), (await listAiKeys(db)).find((k) => k.name === "t-core").id);
  assert.equal(r.json.transcribe_model, "whisper-1");
});

// --- scope is data: a board means nothing to a global-only capability ---

test("the resolver ignores a board for capabilities without board scope", async () => {
  assert.equal(CAPABILITY.embed.binding.boardKeys, null, "embed is global by declaration — one search index, one vector space");
  // A board fragment carrying nonsense columns changes nothing: embed has no
  // board rung to read them.
  assert.equal(await resolveCapability(db, "embed", { board: { embed_key_id: 424242 } }), null);
});

// --- extraction's ladder (leaves global tag bound: keep last) ---

test("extract: board pin beats the app-wide default beats delegation to the tagger", async (t) => {
  const keyId = await newKey("t-ex", "openai");
  t.after(async () => {
    await setSetting(db, "extract_key_id", null);
    await setSetting(db, "extract_model", null);
  });

  // Delegation leg: nothing extract-specific anywhere → the global tagger.
  assert.equal((await bind("tag", { keyId, model: "gpt-5-mini" })).status, 200);
  const plain = await newBoard("ex-plain");
  let ai = await resolveCapability(db, "extract", { board: await getBoard(db, plain) });
  assert.equal(ai.provider, "openai");
  assert.equal(ai.model, "gpt-5-mini", "no extract binding → the tagger's chain");

  // The app-wide extract default (new in slice 5) outranks delegation…
  assert.equal((await bind("extract", { keyId, model: "extract-mini" })).status, 200);
  ai = await resolveCapability(db, "extract", { board: await getBoard(db, plain) });
  assert.equal(ai.model, "extract-mini", "an explicit global extract default beats the tagger");

  // …a board's own tagger does NOT outrank it (capability first, then scope)…
  const tagged = await newBoard("ex-tagged", { ai_key_id: keyId, ai_model: "tag-own" });
  ai = await resolveCapability(db, "extract", { board: await getBoard(db, tagged) });
  assert.equal(ai.model, "extract-mini");

  // …but a board's own EXTRACT pin outranks everything.
  const pinned = await newBoard("ex-pinned", { extract_key_id: keyId, extract_model: "extract-pro" });
  ai = await resolveCapability(db, "extract", { board: await getBoard(db, pinned) });
  assert.equal(ai.model, "extract-pro");

  // With the global default cleared, delegation forwards the BOARD — the
  // tagged board's extraction follows its own tagger, not the app's.
  await setSetting(db, "extract_key_id", null);
  await setSetting(db, "extract_model", null);
  ai = await resolveCapability(db, "extract", { board: await getBoard(db, tagged) });
  assert.equal(ai.model, "tag-own", "delegation resolves the tagger WITH the board");

  // And the feed can finally say extract itself is degraded: re-bind the global
  // default, then remove its provider on the Plugins page.
  assert.equal((await bind("extract", { keyId, model: "extract-mini" })).status, 200);
  await setPluginState(db, "ai:openai", { installed: false });
  try {
    const c = await caps();
    assert.equal(c.extract.state, "degraded");
    assert.match(c.extract.reason, /removed on the Plugins page/);
  } finally {
    await setPluginState(db, "ai:openai", { installed: true });
  }
});

// getBoard-by-name helper (ids are created inside earlier tests; names are the
// stable handle across them).
async function listBoardsByName(db, name) {
  const { rows } = await db.query("SELECT id FROM boards WHERE name=$1", [name]);
  const out = [];
  for (const r of rows) out.push(await getBoard(db, r.id));
  return out;
}
