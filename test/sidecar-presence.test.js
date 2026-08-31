// Sidecar presence, stages 2-3 (sidecar-presence-plan.md): a host that runs no
// whisper/detector sidecar — the barebones install — resolves those floors to
// NOTHING, every consumer waits instead of failing, and the admin surfaces say
// so:
//
//   - resolveTranscriber / resolveDetector answer null (blocked semantics);
//   - a board's deliberate pin of an absent built-in is a missed pin — it
//     falls to the global rung, never silently to another engine;
//   - the transcribe lane's claim query hands back only servable clips, so an
//     engine-less host touches nothing, while a board with its own keyed pin
//     is served beside it;
//   - a pin that passes that coarse SQL filter but cannot resolve waits per
//     item — unfailed, unparkable, folded to one job row;
//   - the extract leg requeues an object-field item BEFORE the paid
//     extraction call — attempts untouched, nothing metered (the re-billing
//     defect this stage exists to kill);
//   - the capabilities feed reports `unavailable` with the reason, and marks
//     the roster entry and the floor absent (stage 3);
//   - the transcribe/detect probes answer a readable 400.
//
// Absence is this file's DEFAULT: helpers points the sidecar URLs at a dead
// port, and beforeEach clears the health cache so every test starts on a host
// with no engines. Presence, where a test wants the old world back, is
// primeSidecars() — the seeded cache.
//
// POLL_MS is read when startWorker runs, so setting it first makes the
// file-level worker below tick fast enough to drive the lane tests. ONE worker
// for the whole file, deliberately: a second worker's separate retry ledger
// would double the job rows these tests count.
process.env.POLL_MS = "50";

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, adminSession, seedBoard, req, until, meterTotals, primeSidecars } from "./helpers.js";
import { clearSidecarHealth } from "../server/sidecar-catalog.js";
import { resolveTranscriber, resolveDetector, startWorker } from "../server/worker.js";
import { probeCapability } from "../server/capability-probe.js";
import { setPluginState, createAiKey, setSetting, createBoard, createEntity, insertItem } from "../server/db.js";

let srv, db, stopWorker;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  fs.mkdirSync(srv.galleryDir, { recursive: true });
  stopWorker = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
});
after(async () => { await stopWorker(); await srv.close(); });
beforeEach(clearSidecarHealth); // the dead-port default: no engines on this host

// Every wait below is on the file-level WORKER, not on a request, so it
// competes with the other seven files the runner has in flight for one
// Postgres. `until`'s 8s default is comfortable solo and marginal under that
// load (it flaked once in a six-file run); the work itself is one 50ms tick.
const WORKER_WAIT = 25000;

const jobRows = async (boardId, kind) =>
  (await db.query("SELECT outcome, error FROM job_log WHERE board_id=$1 AND kind=$2", [boardId, kind])).rows;

const itemPayload = async (id) =>
  (await db.query("SELECT payload FROM items WHERE id=$1", [id])).rows[0].payload;

// One item on its own board, in whatever shape a test needs. `mapping` present
// = an extract-leg fixture (the key only opens the claim gate; no facets means
// the tag leg that follows never calls a model — detect.test.js's arrangement).
async function seedOne(label, { name, kind, mapping = null, boardCols = null }) {
  const key = await createAiKey(db, `${label}-k`, "openai", "sk-test");
  const boardId = mapping
    ? await createBoard(db, label, [], "", true, key.id ?? key, null, { enabled: true }, false, { mapping })
    : await seedBoard(db, label);
  if (boardCols) {
    const cols = Object.keys(boardCols);
    await db.query(
      `UPDATE boards SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(", ")} WHERE id=$1`,
      [boardId, ...cols.map((c) => boardCols[c])]);
  }
  fs.writeFileSync(path.join(srv.galleryDir, name), Buffer.from("bytes — never decoded on these paths"));
  const eid = await createEntity(db, boardId, { identity: name });
  const iid = await insertItem(db, boardId, {
    identity: name, fields: {}, ...(mapping ? { mapping } : {}),
    files: [{ name, original_name: name, kind }],
  }, mapping ? "pending_extract" : "tagged", eid);
  return { boardId, iid, keyId: key.id ?? key };
}

const DETECT_MAPPING = { fields: [{ key: "car", source: "detect", instruction: "car" }] };

// --- resolution ---

test("an absent floor resolves to nothing; a present one still serves", async () => {
  const stub = { query: async () => ({ rows: [] }) }; // no settings → the floor is the whole ladder
  assert.equal(await resolveTranscriber(stub), null, "no sidecar, no provider → transcription resolves to nothing");
  assert.equal(await resolveDetector(stub), null, "…and detection likewise");

  primeSidecars(); // the same host with its sidecars running — the old world, unchanged
  assert.equal((await resolveTranscriber(stub)).id, "whisper");
  assert.equal((await resolveDetector(stub)).id, "localDetector");
});

// Runs BEFORE anything installs a networked advertiser: with openai installed
// the same host correctly reads `blocked` ("needs a key" — there is
// installable supply), which is a different honest answer than this one.
test("the capabilities feed: unavailable with the why, present:false on roster and floor", async () => {
  const admin = await adminSession(db);
  const byId = (r) => Object.fromEntries(r.json.capabilities.map((c) => [c.id, c]));

  const caps = byId(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
  for (const id of ["transcribe", "detect"]) {
    assert.equal(caps[id].state, "unavailable", `${id}: nothing on this host can serve`);
    assert.equal(caps[id].reason, "the built-in engine is not running on this server");
    assert.equal(caps[id].floor.present, false, `${id}: the floor's identity travels with its absence`);
    assert.equal(caps[id].running, null, `${id}: nothing pretends to run`);
  }
  const whisper = caps.transcribe.supportedBy.find((p) => p.name === "whisper");
  assert.deepEqual([whisper.installed, whisper.present], [true, false],
    "installed plugin, absent engine — two separate facts, both told");

  // The same host with its sidecars running — the old world, unchanged.
  primeSidecars();
  const caps2 = byId(await req(srv.base, "GET", "/api/admin/capabilities", { sid: admin.sid }));
  for (const id of ["transcribe", "detect"]) {
    assert.equal(caps2[id].state, "active");
    assert.equal(caps2[id].viaFloor, true);
    assert.equal(caps2[id].floor.present, true);
  }
});

test("a board pin of an absent built-in is a missed pin: it falls to the global rung", async (t) => {
  await setPluginState(db, "ai:openai", { installed: true });
  const key = await createAiKey(db, "presence-global-k", "openai", "sk-test");
  await setSetting(db, "transcribe_provider", "openai");
  await setSetting(db, "transcribe_key_id", String(key.id ?? key));
  t.after(async () => {
    await setSetting(db, "transcribe_provider", null);
    await setSetting(db, "transcribe_key_id", null);
  });
  const board = { transcribe_provider: "whisper", transcribe_key_id: null, transcribe_model: null };

  assert.equal((await resolveTranscriber(db, board)).id, "openai",
    "the pinned engine isn't running → the app default serves, loudly, not silently another engine");

  primeSidecars();
  assert.equal((await resolveTranscriber(db, board)).id, "whisper", "running again → the pin is honored");
});

// --- probes ---

test("the transcribe and detect probes answer a readable 400 when nothing serves", async () => {
  await assert.rejects(probeCapability(db, "transcribe"),
    (e) => e.status === 400 && /isn't served on this instance/.test(e.message));
  await assert.rejects(probeCapability(db, "detect"),
    (e) => e.status === 400 && /isn't served on this instance/.test(e.message));
});

// --- the extract leg: requeue BEFORE the spend ---

test("an object-field image with no detector waits — unfailed, unbilled, unlogged", async () => {
  const { boardId, iid } = await seedOne("presence-detect", {
    name: "presence-car.png", kind: "image", mapping: DETECT_MAPPING,
  });

  // The worker claims it, resolves NO detector ahead of the extraction call,
  // and requeues: back to pending_extract, spaced by retry_at, attempts
  // untouched — a wait, not a strike.
  const item = await until(async () => {
    const { rows: [r] } = await db.query("SELECT status, attempts, error, retry_at FROM items WHERE id=$1", [iid]);
    return r.status === "pending_extract" && r.retry_at != null ? r : null;
  }, WORKER_WAIT);
  assert.equal(item.attempts, 0, "a configuration gap consumes no attempts — the cap stays unreachable");
  assert.match(item.error, /object detection is not available on this server/);

  // The money assertion: the old order billed extraction on every attempt
  // before detection threw. Now nothing is metered at all…
  assert.equal((await meterTotals(db, boardId)).calls, 0,
    "no call was paid for — the detector resolves before the model runs");
  // …and the wait is quiet in the job ledger too (noCount skips the leg log).
  assert.deepEqual(await jobRows(boardId, "extract"), []);
});

test("an object-field NON-image flows through: it never needed the engine", async () => {
  const { iid } = await seedOne("presence-text", {
    name: "presence-note.txt", kind: "text", mapping: DETECT_MAPPING,
  });
  const payload = await until(async () => {
    const { rows: [r] } = await db.query("SELECT status, payload FROM items WHERE id=$1", [iid]);
    return r.status !== "pending_extract" && r.status !== "extracting" ? r.payload : null;
  }, WORKER_WAIT);
  assert.equal(payload.fields.car.why, "no image to detect on",
    "the detect pass answers for a non-image itself — absence of the engine never held it");
});

// --- the transcribe lane ---

test("with no engine anywhere, the lane claims nothing: clips wait untouched", async () => {
  const { boardId, iid } = await seedOne("presence-audio-idle", {
    name: "presence-idle.wav", kind: "audio",
  });

  // Give the 50ms lane a generous window to do the wrong thing.
  await new Promise((r) => setTimeout(r, 400));
  const payload = await itemPayload(iid);
  assert.equal(payload.transcript, undefined, "not transcribed — there is nothing to transcribe with");
  assert.equal(payload.transcript_error, undefined, "and NOT failed — waiting is not an error");
  assert.deepEqual(await jobRows(boardId, "transcribe"), [],
    "the claim query filtered it out: no claim, no ledger row, no churn");
});

test("a board's own keyed pin is served while engine-less boards wait beside it", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  // The paid wire answers; EVERYTHING else (sidecar health probes included)
  // refuses — this is a host with no sidecars and one paid account.
  globalThis.fetch = async (url) => {
    if (String(url).includes("/audio/transcriptions"))
      return { ok: true, status: 200, json: async () => ({ text: "spoken words" }) };
    throw new Error("no network in this test");
  };
  await setPluginState(db, "ai:openai", { installed: true });

  // `waits` is created first, so `pinned`'s clip is newer and the lane
  // (newest-first) would meet it first either way.
  const waits = await seedOne("presence-audio-waits", { name: "presence-waits.wav", kind: "audio" });
  const pinned = await seedOne("presence-audio-pinned", { name: "presence-pinned.wav", kind: "audio" });
  await db.query("UPDATE boards SET transcribe_key_id=$1 WHERE id=$2", [pinned.keyId, pinned.boardId]);

  // The pinned board's clip transcribes through its own engine…
  await until(async () => (await itemPayload(pinned.iid)).transcript === "spoken words", WORKER_WAIT);

  // …and the engine-less board's clip was never claimed at all: the claim
  // query admits a board by the shape of its pin, and that board has none.
  const payload = await itemPayload(waits.iid);
  assert.equal(payload.transcript, undefined);
  assert.equal(payload.transcript_error, undefined, "waiting, not failed");
  assert.deepEqual(await jobRows(waits.boardId, "transcribe"), [],
    "unservable work is filtered in SQL, so it costs nothing per tick");
});

test("a pin that passes the coarse filter but cannot resolve waits per item, unfailed", async (t) => {
  // The residue the claim query deliberately can't see: a board pins a KEY,
  // so the SQL admits it, but the key's provider has been uninstalled — so
  // resolution walks board → global → floor and comes back with nothing.
  await setPluginState(db, "ai:openai", { installed: true });
  const { boardId, iid, keyId } = await seedOne("presence-audio-dead-pin", {
    name: "presence-dead.wav", kind: "audio",
  });
  await db.query("UPDATE boards SET transcribe_key_id=$1 WHERE id=$2", [keyId, boardId]);
  await setPluginState(db, "ai:openai", { installed: false });
  t.after(() => setPluginState(db, "ai:openai", { installed: true }));

  const rows = await until(async () => {
    const r = await jobRows(boardId, "transcribe");
    return r.length ? r : null;
  }, WORKER_WAIT);
  assert.equal(rows.length, 1, "repeat encounters fold into the one requeued row");
  assert.equal(rows[0].outcome, "requeued");
  assert.match(rows[0].error, /no transcription engine on this server for this board/);

  const payload = await itemPayload(iid);
  assert.equal(payload.transcript, undefined);
  assert.equal(payload.transcript_error, undefined,
    "a configuration gap never parks the clip — TRANSCRIBE_MAX_ATTEMPTS is for clips that fail, not for hosts that aren't ready");
});
