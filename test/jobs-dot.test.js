// The jobs chip's attention dot — "something failed while you weren't looking"
// — and the notification layer it shares with the other two header signals.
//
// Two halves, and each can be wrong in a way the other can't see. The SERVER
// half decides what counts as a failure at all — and the interesting part is
// what it refuses (a retry, a discarded stale result, a restart), because every
// one of those would light a dot that resolves to "nothing you can do", which is
// how a signal gets trained out of a reader. The CLIENT half is the watermark
// shared with the Tagging-consistency dot (public/seen-mark.js), where the
// failure mode is the opposite: two dots writing one key, so acknowledging one
// silently clears the other.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, seedBoard, seedUser, adminSession, req } from "./helpers.js";
import { addJobLog, latestJobFailureAt } from "../server/db.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// The client modules want a localStorage and (via data.js's module-level
// listener) a document. Nothing here needs either to do anything real.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document ||= {
  addEventListener() {}, dispatchEvent() { return true; },
  createElement: () => ({ appendChild() {}, setAttribute() {} }),
};

const { state } = await import("../public/state.js");
const { jobsUnseen, markJobsSeen, failureDrawn } = await import("../public/jobs-modal.js");
const { diagnosticsUnseen, markDiagnosticsSeen } = await import("../public/facet-diagnostics.js");
const { signalLanded, refreshAlerts, refreshJobErrors } = await import("../public/signals.js");
const { noteServerNow } = await import("../public/seen-mark.js");

// ─── the dot's memory ────────────────────────────────────────────────────────

test("a failure newer than the last look lights the dot, and opening clears it", () => {
  store.clear();
  state.boardId = "b1";
  state.jobsFailedAt = 5_000_000;
  assert.equal(jobsUnseen(), true);
  markJobsSeen();
  assert.equal(jobsUnseen(), false);
});

test("…and the next failure lights it again", () => {
  store.clear();
  state.boardId = "b2";
  state.jobsFailedAt = 5_000_000;
  markJobsSeen();
  state.jobsFailedAt = 9_999_999_999_999;
  assert.equal(jobsUnseen(), true);
});

test("no failures at all is a dark dot, not an unknown one", () => {
  // null is the server saying "this board has never failed" — the same answer a
  // failed fetch leaves behind, and neither is worth a mark on the header.
  store.clear();
  state.boardId = "b3";
  state.jobsFailedAt = null;
  assert.equal(jobsUnseen(), false);
});

test("acknowledging with nothing known still records the look", () => {
  // The floor in markSeen. Opening the modal before the stamp has landed (or
  // with the fetch failing) must not leave the dot armed to fire on the next
  // render for a failure that is already older than the visit.
  store.clear();
  state.boardId = "b4";
  state.jobsFailedAt = null;
  markJobsSeen();
  state.jobsFailedAt = Date.now() - 60_000;
  assert.equal(jobsUnseen(), false);
});

test("the dot is per board", () => {
  store.clear();
  state.boardId = "b5";
  state.jobsFailedAt = 5_000_000;
  markJobsSeen();
  assert.equal(jobsUnseen(), false);
  state.boardId = "b6";
  assert.equal(jobsUnseen(), true, "another board's failures are still unseen");
});

test("a reader whose clock runs fast still sees the next failure", () => {
  // The quietest bug in the feature and the reason the server sends its `now`.
  // Every stamp compared is the SERVER's; the acknowledgement floor used to be
  // the reader's own clock. A browser five minutes fast wrote a watermark five
  // minutes into the future and then ignored everything that happened in
  // between — invisibly, because a dot that never lights is indistinguishable
  // from a board where nothing went wrong.
  store.clear();
  state.boardId = "b8";
  const serverNow = Date.now() - 5 * 60_000; // this reader's clock runs 5m fast
  noteServerNow(serverNow);

  state.jobsFailedAt = null;
  markJobsSeen();                            // opened the log; nothing had failed yet
  state.jobsFailedAt = serverNow + 1000;     // …and a second later, one did
  assert.equal(jobsUnseen(), true);

  noteServerNow(Date.now()); // clocks agreed all along — leave the module as found
});

test("the two local dots do not share a watermark", () => {
  // The regression the shared module makes possible: one key builder, two
  // callers, and reading the job log quietly marks the facet findings read
  // (or the reverse). They are different news about different things.
  store.clear();
  state.boardId = "b7";
  state.jobsFailedAt = 5_000_000;
  const facets = [{
    key: "shape", items: 25, unanimous: 15, stale: 0, queued: 0, current: true,
    diagnostic: { verdict: "overlapping-values", explanation: "round and wide overlap", rewrite: "prefer wide", stats: { items: 25, unanimous: 15 }, at: 5_000_000 },
  }];
  const gates = { minItems: 20, minRate: 0.3, maxAttempts: 3 };
  assert.equal(jobsUnseen(), true);
  assert.equal(diagnosticsUnseen("b7", facets, gates), true);

  markJobsSeen();
  assert.equal(diagnosticsUnseen("b7", facets, gates), true, "reading the job log is not reading the findings");

  markDiagnosticsSeen("b7", facets);
  state.jobsFailedAt = Date.now() + 1000; // a fresh failure
  assert.equal(jobsUnseen(), true, "…and reading the findings is not reading the job log");
});

// ─── what the open dialog is allowed to acknowledge ──────────────────────────
//
// Opening the log clears the dot unconditionally — you opened the log. Every
// LATER acknowledgement, on the 5s refresh, makes a much narrower claim: not
// "you had the log" but "this landed while you were watching". The dialog is
// only entitled to that when the row is actually on screen, and three ordinary
// states put it out of view. Each of them used to clear the dot anyway, which
// is the one outcome that loses a failure permanently: the dot is the only
// thing that was ever going to mention it again.

const row = (outcome, startedAt, kind = "tag") => ({ kind, outcome, started_at: startedAt });

test("a filtered page cannot acknowledge a failure it does not contain", () => {
  // The server deliberately serves failed_at board-wide and independent of the
  // page's kind filter, and jobs-dot's route test pins that. It would be given
  // away here: a reader who clicked the Ingestion pill, watching a page with no
  // tagging rows in it, must not have a tagging failure marked read.
  const tagFailedAt = 5_000_000;
  const ingestPage = [row("ok", 6_000_000, "ingest"), row("failed", 900_000, "ingest")];
  assert.equal(failureDrawn(ingestPage, tagFailedAt), false);
  assert.equal(failureDrawn([...ingestPage, row("failed", tagFailedAt)], tagFailedAt), true);
});

test("a reader paged deeper acknowledges nothing, because nothing was redrawn", () => {
  // Off page one the refresh interval re-pulls the pipeline half and pointedly
  // NOT history — a reader on page three should not be yanked back to the top.
  // So a failure landing then is never drawn, and the list it would have been
  // drawn into still holds the older pages it was fetched with.
  const deepPages = [row("ok", 4_000), row("failed", 3_000), row("ok", 2_000)];
  assert.equal(failureDrawn(deepPages, 9_000_000), false, "the new failure is in no page held");
  assert.equal(failureDrawn(deepPages, 3_000), true, "…while one that IS held still counts");
});

test("only a failed row acknowledges a failure", () => {
  // The stamp is a started_at, and an ok row can share one — a folded repeat
  // re-stamped, or simply two jobs starting in the same millisecond. Matching
  // on the stamp alone would let a successful run mark a failure read.
  assert.equal(failureDrawn([row("ok", 7_000)], 7_000), false);
  assert.equal(failureDrawn([row("requeued", 7_000)], 7_000), false, "nor a retry");
});

test("nothing to acknowledge is not something drawn", () => {
  // A board with no failures at all, and the empty list before the first page
  // lands. Neither is a licence to write a mark.
  assert.equal(failureDrawn([], 5_000), false);
  assert.equal(failureDrawn([row("failed", 5_000)], null), false);
});

// ─── what counts as a baseline ───────────────────────────────────────────────
//
// announce.js takes one reading at boot and calls whatever is lit "already
// there, not news". That is only honest for a signal whose data actually
// arrived. What a failed fetch leaves behind — a null stamp, an empty alert
// list — is the same value a clean board leaves behind, so recording it as the
// baseline arms the NEXT successful read to announce, with a chime, news that
// predates the session. It is the one fault in this feature that degrades
// towards noise rather than silence, which is what the flag is for.

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const dead = async () => { throw new Error("offline"); };
const replies = (body, ok = true) => async () => ({ ok, json: async () => body });

// One test rather than four: `landed` is a latch, so the un-landed assertions
// are only meaningful before the landing one — splitting them would leave the
// order load-bearing and invisible.
test("a baseline is only taken for a signal whose data actually arrived", async () => {
  state.boardId = "b-land";
  assert.equal(signalLanded("jobErrors"), false, "nothing has been fetched yet");

  await withFetch(dead, refreshJobErrors);
  assert.equal(signalLanded("jobErrors"), false, "a dead network is not an answer");

  await withFetch(replies({}, false), refreshJobErrors);
  assert.equal(signalLanded("jobErrors"), false, "…nor is a non-2xx");

  // "This board has never failed" IS an answer, and it is the case that makes
  // the flag necessary rather than merely tidy: it leaves state.jobsFailedAt at
  // exactly the null a failed fetch leaves, so no reader of the VALUE can ever
  // tell the two apart. That is the whole defect.
  await withFetch(replies({ failed_at: null, now: Date.now() }), refreshJobErrors);
  assert.equal(signalLanded("jobErrors"), true);
  assert.equal(state.jobsFailedAt, null, "…and the value is still ambiguous, as it must be");
});

test("…and the same for alerts, where the ambiguous value is an empty list", async () => {
  state.boardId = "b-land";
  assert.equal(signalLanded("alerts"), false);

  await withFetch(dead, refreshAlerts);
  await withFetch(replies([], false), refreshAlerts);
  assert.equal(signalLanded("alerts"), false);

  await withFetch(replies([]), refreshAlerts);
  assert.equal(signalLanded("alerts"), true, "a board with no alerts on it is an answer");
});

test("discovering an alert starts the item poll it entitles", async () => {
  // An alert holds the slow item poll because an alert is a standing statement
  // that arrivals on this board matter, and arrivals are items. A tab can learn
  // it holds one WITHOUT having been the tab that made it — created on another
  // device, or missed by a failed boot fetch — and before this that discovery
  // moved the dot and nothing else, because the tick that would have restarted
  // the poll is the tick that had already stopped.
  //
  // setTimeout is stubbed rather than spied: it both makes the scheduling
  // observable and keeps a real pollTick from being armed against a test server.
  const realTimeout = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = () => { scheduled++; return 0; };
  try {
    state.boardId = "b-poll";
    state.items = [];
    state.uploading = [];
    state.boardIngest = false;
    state.boardMapping = null; // the other two things that would hold the poll
    state.alerts = [];

    await withFetch(replies([]), refreshAlerts);
    assert.equal(scheduled, 0, "a board with no alerts has nothing to keep listening for");

    await withFetch(replies([{ id: 1, name: "watch", unseen: 0 }]), refreshAlerts);
    assert.ok(scheduled > 0, "the first alert this tab has seen starts the poll");
  } finally {
    globalThis.setTimeout = realTimeout;
    state.alerts = [];
  }
});

// ─── the sound ───────────────────────────────────────────────────────────────

test("the chime's file is where the page will ask for it", () => {
  // The one failure here is completely silent — literally. A moved or renamed
  // file, or one sitting outside the served directory (it arrived in the repo
  // ROOT, which express.static does not serve), gives a 404 inside a `.catch`
  // that exists to swallow the browser's autoplay refusal. Nothing appears
  // anywhere; the sound simply never plays again.
  const src = fs.readFileSync(path.join(PUBLIC, "chime.js"), "utf8").match(/SRC\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(src, "chime.js still names its source file");
  assert.ok(fs.existsSync(path.join(PUBLIC, src.replace(/^\//, ""))), `${src} is not under public/`);
});

test("the sound is on until it is turned off, and stays off", async () => {
  const { soundOn, setSoundOn } = await import("../public/chime.js");
  store.clear();
  assert.equal(soundOn(), true, "an unset preference behaves like the feature was asked for");
  setSoundOn(false);
  assert.equal(soundOn(), false);
  setSoundOn(true);
  assert.equal(soundOn(), true);
});

// ─── what the server calls a failure ─────────────────────────────────────────

let srv, db;
before(async () => { srv = await startServer(); db = srv.db; });
after(async () => { await srv?.close?.(); });

const logged = (boardId, outcome, startedAt, over = {}) =>
  addJobLog(db, { boardId, kind: "tag", outcome, startedAt, endedAt: startedAt + 10, ...over });

test("the newest failure's stamp is what the dot gets", async () => {
  const b = await seedBoard(db, "dot-newest");
  await logged(b, "failed", 1000);
  await logged(b, "failed", 3000);
  await logged(b, "ok", 5000);
  assert.equal(await latestJobFailureAt(db, b), 3000);
});

test("a board that has never failed reports nothing rather than zero", async () => {
  const b = await seedBoard(db, "dot-clean");
  await logged(b, "ok", 1000);
  assert.equal(await latestJobFailureAt(db, b), null);
});

test("the outcomes that resolve themselves are not failures", async () => {
  // Each of these is a red-ish row in the log and none of them is news:
  // `requeued` is the pipeline about to try again, `discarded` is a stale
  // result the fence dropped after a merge landed mid-flight, `interrupted` is
  // a restart — that last one would put a dot on every reader's header after
  // every deploy — and `running` hasn't finished having an outcome.
  const b = await seedBoard(db, "dot-benign");
  for (const [i, outcome] of ["requeued", "discarded", "interrupted", "running"].entries()) {
    await logged(b, outcome, 1000 + i);
  }
  assert.equal(await latestJobFailureAt(db, b), null);

  // …and one real failure among them still comes through.
  await logged(b, "failed", 2000);
  assert.equal(await latestJobFailureAt(db, b), 2000);
});

test("failures are board-scoped", async () => {
  const a = await seedBoard(db, "dot-a");
  const b = await seedBoard(db, "dot-b");
  await logged(a, "failed", 7000);
  assert.equal(await latestJobFailureAt(db, b), null);
});

test("a folded repeat is not a new failure", async () => {
  // The worker folds an identical repeating error into its existing row rather
  // than writing one per 30s tick (foldJobRepeat). The dot keys on started_at
  // precisely so that fold carries through: the same wedged scan re-stamping
  // the same row must not re-light an acknowledged dot every half minute.
  const b = await seedBoard(db, "dot-fold");
  const id = await logged(b, "failed", 4000);
  assert.equal(await latestJobFailureAt(db, b), 4000);
  await db.query("UPDATE job_log SET ended_at=$1, detail='{\"attempts\":2}' WHERE id=$2", [Date.now(), id]);
  assert.equal(await latestJobFailureAt(db, b), 4000, "the re-stamp moved ended_at, not the news");
});

// ─── the route ───────────────────────────────────────────────────────────────

test("the route serves the stamp to any member, like the log it summarises", async () => {
  const member = await seedUser(db, "dot-member@test.local");
  const b = await seedBoard(db, "dot-route", [member.id]);
  await logged(b, "failed", 8000);
  const r = await req(srv.base, "GET", `/api/boards/${b}/jobs/errors`, { sid: member.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.failed_at, 8000);
});

test("…and not to someone who cannot see the board", async () => {
  const outsider = await seedUser(db, "dot-outsider@test.local");
  const owner = await seedUser(db, "dot-owner@test.local");
  const b = await seedBoard(db, "dot-private", [owner.id]);
  await logged(b, "failed", 9000);
  const r = await req(srv.base, "GET", `/api/boards/${b}/jobs/errors`, { sid: outsider.sid });
  assert.equal(r.status, 404);
});

test("…and not to nobody at all", async () => {
  const b = await seedBoard(db, "dot-anon");
  const r = await req(srv.base, "GET", `/api/boards/${b}/jobs/errors`, {});
  assert.equal(r.status, 401);
});

test("…and carries the server's clock, which is the one the watermark is floored on", async () => {
  const admin = await adminSession(db);
  const b = await seedBoard(db, "dot-clock");
  const r = await req(srv.base, "GET", `/api/boards/${b}/jobs/errors`, { sid: admin.sid });
  assert.equal(typeof r.json.now, "number");
  assert.ok(Math.abs(r.json.now - Date.now()) < 60_000);
});

test("the errors route does not shadow the job log page", async () => {
  // Both hang off /jobs; a route that swallowed the other would take the whole
  // modal down, or serve it a stamp where it expects a page.
  const admin = await adminSession(db);
  const b = await seedBoard(db, "dot-shadow");
  await logged(b, "failed", 6000);
  const page = await req(srv.base, "GET", `/api/boards/${b}/jobs`, { sid: admin.sid });
  assert.equal(page.status, 200);
  assert.ok(Array.isArray(page.json.jobs), "still a page of rows");
  assert.equal(page.json.jobs[0].outcome, "failed");
});

test("the log page carries the same stamp, so the open modal acknowledges what it rendered", async () => {
  // The modal refreshes every 5s while open and the background tick every 20s;
  // without this the reader could watch a failure arrive, close the dialog, and
  // then have the dot light for the row they just read.
  const admin = await adminSession(db);
  const b = await seedBoard(db, "dot-page-stamp");
  await logged(b, "ok", 1000);
  await logged(b, "failed", 2000);
  const page = await req(srv.base, "GET", `/api/boards/${b}/jobs`, { sid: admin.sid });
  assert.equal(page.json.failed_at, 2000);

  // Board-wide, NOT a property of the filtered page — a reader who clicked the
  // Ingestion pill must not have the dot cleared by a page with no failures in
  // it, nor kept alive by one that happens to hold an old one.
  const filtered = await req(srv.base, "GET", `/api/boards/${b}/jobs?kind=ingest`, { sid: admin.sid });
  assert.equal(filtered.json.jobs.length, 0, "the fixture really has no ingest rows");
  assert.equal(filtered.json.failed_at, 2000);
});

test("clearing the history takes the dot's stamp with it", async () => {
  // The Clear button destroys exactly what the dot points at. The modal reads
  // the stamp back off the reload that follows, so the chip can't sit there red
  // over an empty log.
  const admin = await adminSession(db);
  const b = await seedBoard(db, "dot-cleared");
  await logged(b, "failed", 3000);
  assert.equal((await req(srv.base, "GET", `/api/boards/${b}/jobs`, { sid: admin.sid })).json.failed_at, 3000);
  await req(srv.base, "DELETE", `/api/boards/${b}/jobs`, { sid: admin.sid });
  assert.equal((await req(srv.base, "GET", `/api/boards/${b}/jobs`, { sid: admin.sid })).json.failed_at, null);
});
