// The ingestion HTTP surface: config PATCH validation + timer bookkeeping,
// the descriptor/config GET, the preview dry-run (never saved), run-now with
// its auth matrix, the folder picker listing, and the board payload flag.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";
import { getBoard, updateBoard, recordIngest, setIngestNextRun, setIngestState, ingestedKeys, clearIngestLog } from "../server/db.js";

let srv, db, base, admin, member, boardId, root;
const OLD = Date.now() - 120000;

const GOOD = {
  enabled: true,
  source: { folder: "pick", recursive: true },
  filters: [{ fn: "extension", op: "equals", value: "txt" }],
  sort: { by: "name", order: "asc" },
  limit: 50,
  trigger: { mode: "continuous" },
};

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  member = await seedUser(db, "member@test.local");
  boardId = await seedBoard(db, "routes", [member.id]);
  root = fs.mkdtempSync(path.join(srv.galleryDir, "..", "ingest-root-"));
  process.env.INGEST_ROOT = root;
  for (const f of ["pick/a.txt", "pick/b.txt", "pick/c.md", "pick/deep/d.txt"]) {
    const p = path.join(root, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "content");
    fs.utimesSync(p, new Date(OLD), new Date(OLD));
  }
});
after(async () => {
  delete process.env.INGEST_ROOT;
  await srv.close();
});

const patchIngest = (ingest, sid = admin.sid) =>
  req(base, "PATCH", `/api/boards/${boardId}`, { sid, body: { ingest } });

test("GET /api/boards/:id/ingest serves the descriptor + config in one fetch", async () => {
  const r = await req(base, "GET", `/api/boards/${boardId}/ingest`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.available, true);
  // The resolved root itself (null = unconfigured) — this route is manager-
  // gated — so the modal can show what a subpath actually means instead of a
  // bare name. One field: a `root` boolean beside it would just be
  // `rootPath != null` waiting to drift.
  assert.equal(r.json.rootPath, root);
  assert.ok(r.json.descriptor.filters.some((f) => f.fn === "extension"));
  assert.ok(r.json.descriptor.triggerModes.includes("continuous"));
  assert.equal(r.json.config, null, "nothing saved yet");
});

test("PATCH validation: every rejection names its rule", async () => {
  const cases = [
    [{ ...GOOD, filters: [{ fn: "nope", op: "equals", value: "x" }] }, /unknown filter field/],
    [{ ...GOOD, filters: [{ fn: "name", op: "gte", value: 3 }] }, /not valid/],
    [{ ...GOOD, trigger: { mode: "interval", every: 0 } }, /trigger\.every/],
    [{ ...GOOD, trigger: { mode: "interval", every: 50000 } }, /trigger\.every/],
    [{ ...GOOD, limit: 0 }, /limit/],
    // The only ceiling left is the enumeration safety backstop — a limit past
    // it couldn't be honored, so it's a typo rather than an intent. A "top
    // 5000" run, which the old bound rejected, is now perfectly ordinary.
    [{ ...GOOD, limit: 100001 }, /limit/],
    [{ ...GOOD, limit: 1.5 }, /limit/],
    [{ ...GOOD, source: { folder: "../escape" } }, /escapes/],
    [{ ...GOOD, source: { recursive: "yes" } }, /recursive/],
    [{ ...GOOD, trigger: { mode: "hourly" } }, /trigger mode/],
    [{ ...GOOD, sort: { by: "nope" } }, /unknown sort/],
  ];
  for (const [body, re] of cases) {
    const r = await patchIngest(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, re);
  }
  const b = await getBoard(db, boardId);
  assert.equal(b.ingest, null, "nothing invalid was saved");
});

test("PATCH bookkeeping: arming, rearming on trigger change, disarming", async () => {
  const t0 = Date.now();
  assert.equal((await patchIngest(GOOD)).status, 200);
  let b = await getBoard(db, boardId);
  assert.deepEqual(b.ingest.filters, GOOD.filters);
  assert.ok(b.ingest_next_run_at >= t0, "armed for an immediate first run");

  // Same trigger, different filters → the armed timer is left alone.
  const armedAt = b.ingest_next_run_at;
  assert.equal((await patchIngest({ ...GOOD, filters: [] })).status, 200);
  b = await getBoard(db, boardId);
  assert.equal(b.ingest_next_run_at, armedAt, "config-only edits don't reset the schedule");

  // Trigger shape change → re-armed now.
  assert.equal((await patchIngest({ ...GOOD, trigger: { mode: "interval", every: 60 } })).status, 200);
  b = await getBoard(db, boardId);
  assert.ok(b.ingest_next_run_at >= armedAt, "trigger change re-arms");

  // Disable → disarmed. (The worker isn't running in tests; nothing fires.)
  assert.equal((await patchIngest({ ...GOOD, enabled: false })).status, 200);
  b = await getBoard(db, boardId);
  assert.equal(b.ingest_next_run_at, null);

  // Manual mode while enabled → also disarmed (run-now arms it).
  assert.equal((await patchIngest({ ...GOOD, trigger: { mode: "manual" } })).status, 200);
  b = await getBoard(db, boardId);
  assert.equal(b.ingest_next_run_at, null);

  // A hand-fired run survives a later save. Nothing here is on a schedule
  // either side of the PATCH, so the stamp can only be "Run now"'s — cancelling
  // it would contradict the "run queued" the user was just shown.
  await setIngestNextRun(db, boardId, Date.now());
  assert.equal((await patchIngest({ ...GOOD, trigger: { mode: "manual" }, filters: [] })).status, 200);
  b = await getBoard(db, boardId);
  assert.ok(b.ingest_next_run_at > 0, "an unrelated save doesn't cancel a queued run");
  // Same for a paused board — the newly reachable case, since Run now no
  // longer needs `enabled`.
  assert.equal((await patchIngest({ ...GOOD, enabled: false })).status, 200);
  b = await getBoard(db, boardId);
  assert.ok(b.ingest_next_run_at > 0, "pausing an already-queued run leaves the run queued");
  // But a live schedule being switched off IS a disarm — that stamp was the
  // schedule's, not a hand-fired run's.
  assert.equal((await patchIngest(GOOD)).status, 200);
  assert.equal((await patchIngest({ ...GOOD, enabled: false })).status, 200);
  b = await getBoard(db, boardId);
  assert.equal(b.ingest_next_run_at, null, "pausing a running schedule disarms it");

  // A manual board has no timer for `enabled` to hold, so it is normalized to
  // true on the way in rather than stored as inert state the UI has to paper
  // over. The save also answers with the pair it landed on, so the client never
  // re-derives the mode.
  const norm = await patchIngest({ ...GOOD, enabled: false, trigger: { mode: "manual" } });
  assert.equal(norm.status, 200);
  // ingest_error false: an ingest save clears last_error at the save seam
  // (superseded — the next run judges the new config), so the echo and
  // storage agree. paused false: every board save echoes the pause flag, since
  // the client stamps board payloads through one funnel that resets it.
  assert.deepEqual(norm.json, { ok: true, ingest_mode: "manual", ingest_next_run_at: null, ingest_error: false, paused: false });
  b = await getBoard(db, boardId);
  assert.equal(b.ingest.enabled, true, "manual + enabled:false is normalized, not stored");

  const armed = await patchIngest(GOOD);
  assert.equal(armed.json.ingest_mode, "scheduled");
  assert.ok(armed.json.ingest_next_run_at > 0, "the save hands back the stamp it just armed");
  assert.equal((await patchIngest({ ...GOOD, enabled: false })).json.ingest_mode, "paused");

  // ingest: null clears everything.
  assert.equal((await patchIngest(null)).status, 200);
  b = await getBoard(db, boardId);
  assert.equal(b.ingest, null);
});

test("board payload: ingest_mode follows the saved config", async () => {
  let r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_mode, null, "no config at all");
  assert.equal(r.json.ingest_next_run_at, null);
  await patchIngest(GOOD);
  r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_mode, "scheduled");
  assert.ok(r.json.ingest_next_run_at > 0, "the chip's countdown stamp rides the payload");

  // The two no-next-run states are distinguishable — the chip shows one and
  // hides for the other, so the payload can't collapse them into a boolean.
  await patchIngest({ ...GOOD, enabled: false });
  r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_mode, "paused");
  assert.equal(r.json.ingest_next_run_at, null, "a held schedule disarms the timer");
  await patchIngest({ ...GOOD, trigger: { mode: "manual" } });
  r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_mode, "manual");
  await patchIngest(GOOD);
  r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  // Settings payload carries the full config for the modal.
  const s = await req(base, "GET", `/api/boards/${boardId}/settings`, { sid: admin.sid });
  assert.deepEqual(s.json.ingest.source, GOOD.source);
});

test("preview: dry-runs the request body without saving it; count by default, pages on demand", async () => {
  const saved = (await getBoard(db, boardId)).ingest;
  const previewBody = {
    source: { folder: "pick", recursive: true },
    filters: [{ fn: "extension", op: "equals", value: "txt" }],
    sort: { by: "name", order: "asc" },
    trigger: { mode: "manual" },
  };
  // Default response: the count alone — no rows serialized.
  const r = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: previewBody,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 3, "a.txt, b.txt, deep/d.txt — c.md filtered out");
  assert.equal(r.json.new, 3, "nothing ledgered yet");
  assert.equal(r.json.capped, false);
  assert.equal(r.json.sample, undefined, "count-only unless a sample window is requested");
  assert.deepEqual((await getBoard(db, boardId)).ingest, saved, "preview never writes");

  // sample: {offset, limit} pages the sorted matches for the results view.
  const p1 = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { ...previewBody, sample: { offset: 0, limit: 2 } },
  });
  assert.deepEqual(p1.json.sample.map((c) => c.label), ["a.txt", "b.txt"]);
  assert.equal(p1.json.hasMore, true);
  const p2 = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { ...previewBody, sample: { offset: 2, limit: 2 } },
  });
  assert.deepEqual(p2.json.sample.map((c) => c.label), ["d.txt"]);
  assert.equal(p2.json.hasMore, false);

  // Pages skip the count view's split; instead each row carries its ledger
  // reason (null = never ledgered) for the results badge.
  assert.equal(p1.json.new, undefined, "no `new` on page responses");
  assert.deepEqual(p1.json.sample.map((c) => c.ledger), [null, null], "nothing ledgered yet");
  await recordIngest(db, boardId, p1.json.sample[0].key, Date.now());
  const p3 = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { ...previewBody, sample: { offset: 0, limit: 3 } },
  });
  assert.deepEqual(p3.json.sample.map((c) => c.ledger), ["admitted", null, null], "the ledgered row is marked");
  const r2 = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, { sid: admin.sid, body: previewBody });
  assert.equal(r2.json.new, 2, "the count view still accounts against the whole ledger");

  // The schedule is not the preview's business: no trigger at all, or a
  // half-typed one ("every N minutes" with no N yet), previews fine — only
  // Save validates the trigger.
  const noTrig = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { source: previewBody.source, filters: previewBody.filters, sort: previewBody.sort },
  });
  assert.equal(noTrig.status, 200);
  assert.equal(noTrig.json.count, 3, "triggerless preview matches the same set");
  const halfTrig = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { ...previewBody, trigger: { mode: "interval" } },
  });
  assert.equal(halfTrig.status, 200, "an unfinished trigger doesn't block a preview");

  const badWindow = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { ...previewBody, sample: { offset: -1, limit: 0 } },
  });
  assert.equal(badWindow.status, 400);

  const bad = await req(base, "POST", `/api/boards/${boardId}/ingest/preview`, {
    sid: admin.sid,
    body: { source: { folder: "../x" }, trigger: { mode: "manual" } },
  });
  assert.equal(bad.status, 400);
});

test("run-now: auth matrix, and a paused feed still runs once", async () => {
  assert.equal((await patchIngest({ ...GOOD, trigger: { mode: "manual" } })).status, 200);
  let b = await getBoard(db, boardId);
  assert.equal(b.ingest_next_run_at, null);

  const anon = await req(base, "POST", `/api/boards/${boardId}/ingest/run`, {});
  assert.equal(anon.status, 401);
  const notMgr = await req(base, "POST", `/api/boards/${boardId}/ingest/run`, { sid: member.sid });
  assert.equal(notMgr.status, 403, "plain members can't fire ingestion");

  const ok = await req(base, "POST", `/api/boards/${boardId}/ingest/run`, { sid: admin.sid });
  assert.equal(ok.status, 200);
  b = await getBoard(db, boardId);
  assert.ok(b.ingest_next_run_at <= Date.now(), "armed for the next tick");
  await updateBoard(db, boardId, { ingestNextRunAt: null });

  // Pausing holds the schedule; it doesn't confiscate the button. The sweep
  // disarms the board again after the run, so this buys exactly one run.
  await patchIngest({ ...GOOD, enabled: false });
  b = await getBoard(db, boardId);
  assert.equal(b.ingest_next_run_at, null, "pausing disarms the timer");
  const paused = await req(base, "POST", `/api/boards/${boardId}/ingest/run`, { sid: admin.sid });
  assert.equal(paused.status, 200, "a paused feed still runs on demand");
  b = await getBoard(db, boardId);
  assert.ok(b.ingest_next_run_at <= Date.now(), "armed for the next tick");
  await updateBoard(db, boardId, { ingestNextRunAt: null });

  // A fresh run is FRESH: the unfinished budget of the run this one supersedes
  // is its own verdict, and carrying it forward would hand the new run a stale
  // limit (job-control-plan.md Stage 5 — the sweep's settle is fenced, so a
  // superseded tick's admissions were never subtracted from it).
  await patchIngest({ ...GOOD, trigger: { mode: "manual" } });
  await setIngestState(db, boardId, { last_run_at: Date.now() - 1000, last_added: 2, drain_left: 8 });
  assert.equal((await req(base, "POST", `/api/boards/${boardId}/ingest/run`, { sid: admin.sid })).status, 200);
  b = await getBoard(db, boardId);
  assert.equal(b.ingest_state.drain_left, undefined, "the superseded budget is gone");
  assert.equal(b.ingest_state.last_added, 2, "run history is not a budget — it stays");
  await updateBoard(db, boardId, { ingestNextRunAt: null });

  // Nothing configured at all is still a 409 — there's no config to run.
  await patchIngest(null);
  const none = await req(base, "POST", `/api/boards/${boardId}/ingest/run`, { sid: admin.sid });
  assert.equal(none.status, 409, "no config, nothing to run");
});

test("preview split: reasons tally, and non-admitted keys hold no total slot", async () => {
  const cid = await seedBoard(db, "split");
  const cfg = {
    enabled: true,
    source: { folder: "pick", recursive: true },
    filters: [{ fn: "extension", op: "equals", value: "txt" }],
    sort: { by: "name", order: "asc" },
  };
  // Three matching keys, one per reason: a is on the board, b was deleted,
  // deep/d can't be processed.
  await recordIngest(db, cid, "a.txt", Date.now());
  await recordIngest(db, cid, "b.txt", Date.now(), { reason: "deleted" });
  await recordIngest(db, cid, "deep/d.txt", Date.now(), { reason: "skipped" });

  const r = await req(base, "POST", `/api/boards/${cid}/ingest/preview`, { sid: admin.sid, body: cfg });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 3, "no total: count is the whole filtered window");
  assert.equal(r.json.new, 0, "every match is known — nothing to admit");
  assert.equal(r.json.on_board, 1);
  assert.equal(r.json.held, 1);
  assert.equal(r.json.unprocessable, 1);

  // With a total, only the admitted key holds a slot — deleted and skipped
  // backfill (nothing fresh exists in this fixture to fill the freed seats,
  // so the membership just shrinks to the eligible one).
  const t = await req(base, "POST", `/api/boards/${cid}/ingest/preview`, { sid: admin.sid, body: { ...cfg, total: 2 } });
  assert.equal(t.json.count, 1);
  assert.equal(t.json.held, 1, "the split still answers for the whole window");

  // Sample rows carry the reason for the results badge.
  const s2 = await req(base, "POST", `/api/boards/${cid}/ingest/preview`, {
    sid: admin.sid, body: { ...cfg, sample: { offset: 0, limit: 10 } },
  });
  assert.deepEqual(s2.json.sample.map((c) => [c.key, c.ledger]),
    [["a.txt", "admitted"], ["b.txt", "deleted"], ["deep/d.txt", "skipped"]]);
});

test("clear: wipes the memory, spares the history, needs no config", async () => {
  const cid = await seedBoard(db, "clear-me", [member.id]);
  await recordIngest(db, cid, "pick/a.txt", Date.now());
  await recordIngest(db, cid, "pick/b.txt", Date.now());
  await setIngestState(db, cid, { last_run_at: 111, last_added: 2, last_error: "boom", drain_left: 7 });

  // The GET payload counts what the button offers to wipe.
  await req(base, "PATCH", `/api/boards/${cid}`, { sid: admin.sid, body: { ingest: GOOD } });
  const g = await req(base, "GET", `/api/boards/${cid}/ingest`, { sid: admin.sid });
  assert.deepEqual(g.json.ledger, { total: 2, on_board: 2, held: 0, unprocessable: 0 });

  const anon = await req(base, "POST", `/api/boards/${cid}/ingest/clear`, {});
  assert.equal(anon.status, 401);
  const notMgr = await req(base, "POST", `/api/boards/${cid}/ingest/clear`, { sid: member.sid });
  assert.equal(notMgr.status, 403, "plain members can't wipe the memory");

  const ok = await req(base, "POST", `/api/boards/${cid}/ingest/clear`, { sid: admin.sid });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.cleared, 2, "the receipt names the rows that died");
  assert.equal((await ingestedKeys(db, cid)).size, 0);
  // The response echoes the ingestion trio the clear landed on — the same
  // thing the board PATCH echoes, and for the same reason: the client stamps
  // it through one funnel rather than re-deriving what a clear implies.
  assert.equal(ok.json.ingest_mode, "scheduled", "the config and its timer are untouched");
  assert.equal(ok.json.ingest_error, false, "the error it just dropped is gone from the echo too");

  // The superseded-state clear rides along (drain_left is a budget over
  // vanished premises, last_error a verdict on a wiped memory) — but run
  // HISTORY stays: this forgets what the feed remembers, not what it did.
  const b = await getBoard(db, cid);
  assert.equal(b.ingest_state.drain_left, undefined);
  assert.equal(b.ingest_state.last_error, undefined);
  assert.equal(b.ingest_state.last_run_at, 111);
  assert.equal(b.ingest_state.last_added, 2);

  // Deliberately no configured-ingest gate: rows outlive a removed config on
  // purpose, and clearing a deconfigured board's haunting is legitimate.
  await recordIngest(db, cid, "pick/c.txt", Date.now());
  await req(base, "PATCH", `/api/boards/${cid}`, { sid: admin.sid, body: { ingest: null } });
  const unconfigured = await req(base, "POST", `/api/boards/${cid}/ingest/clear`, { sid: admin.sid });
  assert.equal(unconfigured.status, 200);
  assert.equal(unconfigured.json.cleared, 1);

  // Idempotent — clearing nothing is a zero receipt, not an error.
  const again = await req(base, "POST", `/api/boards/${cid}/ingest/clear`, { sid: admin.sid });
  assert.equal(again.status, 200);
  assert.equal(again.json.cleared, 0);
});

test("forget scopes: one verb, three reaches — and a config narrows it to its own window", async () => {
  const cid = await seedBoard(db, "forget-scopes", [member.id]);
  // Real keys under the real fixture root, because the scoped forget
  // ENUMERATES: a.txt is on the board, b.txt was deleted, deep/d.txt couldn't
  // be read. c.md was deleted too but the config's extension filter excludes
  // it, and gone.txt was deleted and has since left the source entirely —
  // those last two are the difference between the two reaches.
  const seed = async () => {
    await clearIngestLog(db, cid);
    await recordIngest(db, cid, "a.txt", Date.now());
    await recordIngest(db, cid, "b.txt", Date.now(), { reason: "deleted" });
    await recordIngest(db, cid, "c.md", Date.now(), { reason: "deleted" });
    await recordIngest(db, cid, "gone.txt", Date.now(), { reason: "deleted" });
    await recordIngest(db, cid, "deep/d.txt", Date.now(), { reason: "skipped" });
  };
  const forget = (body, sid = admin.sid) =>
    req(base, "POST", `/api/boards/${cid}/ingest/clear`, { sid, body });
  const reasons = async () =>
    [...(await ingestedKeys(db, cid)).entries()].sort().map(([k, r]) => `${k}:${r.reason}`);

  await req(base, "PATCH", `/api/boards/${cid}`, { sid: admin.sid, body: { ingest: GOOD } });
  await seed();
  const g = await req(base, "GET", `/api/boards/${cid}/ingest`, { sid: admin.sid });
  assert.deepEqual(g.json.ledger, { total: 5, on_board: 1, held: 3, unprocessable: 1 },
    "the GET's counts are LEDGER-wide — the footer reset is the one surface that reads them");

  assert.equal((await forget({ scope: "nope" })).status, 400, "an unknown scope is a typo, not a wipe");
  assert.equal((await forget({ scope: "deleted" }, member.sid)).status, 403);

  // SCOPED (stage 6): Re-include is offered beside a filter-scoped count, so
  // it acts on that window and nothing else. c.md fails the extension filter;
  // gone.txt isn't in the listing at all. Both keep their rows.
  await updateBoard(db, cid, { ingestNextRunAt: null });
  const scoped = await forget({ scope: "deleted", ingest: GOOD });
  assert.equal(scoped.json.cleared, 1, "only the deleted key this config's window actually names");
  assert.deepEqual(await reasons(),
    ["a.txt:admitted", "c.md:deleted", "deep/d.txt:skipped", "gone.txt:deleted"]);
  assert.deepEqual(scoped.json.ledger, { total: 4, on_board: 1, held: 2, unprocessable: 1 },
    "the receipt's counts come from the route's own GROUP BY, not the client's arithmetic");

  // Nothing is armed, ever. The scope came from the modal's BUFFERED config
  // while a run would execute the SAVED one, so arming here could admit a
  // different set than the number that was acted on — the client re-previews
  // instead. `run` is not a parameter any more, and saying it changes nothing.
  assert.equal((await getBoard(db, cid)).ingest_next_run_at, null,
    "a forget is not a request to run");
  await forget({ scope: "deleted", ingest: GOOD, run: true });
  assert.equal((await getBoard(db, cid)).ingest_next_run_at, null, "…even when asked");

  // UNSCOPED: no config, so the whole reason bucket goes — what the toggle's
  // old backlog question used to do, and still reachable by any caller that
  // has no window to speak of.
  await seed();
  assert.equal((await forget({ scope: "deleted" })).json.cleared, 3);
  assert.deepEqual(await reasons(), ["a.txt:admitted", "deep/d.txt:skipped"]);

  // Retry: the unprocessable bucket, same verb, same narrowing.
  assert.equal((await forget({ scope: "skipped", ingest: GOOD })).json.cleared, 1);
  assert.deepEqual(await reasons(), ["a.txt:admitted"]);

  // `all` never scopes — it is the footer's whole-ledger reset, the one clear
  // not read off a windowed number. A config in the body is ignored.
  await seed();
  assert.equal((await forget({ scope: "all", ingest: GOOD })).json.cleared, 5);
  assert.equal((await ingestedKeys(db, cid)).size, 0);

  // A scoped forget still validates the config it was handed.
  await seed();
  const bad = await forget({ scope: "deleted", ingest: { ...GOOD, filters: [{ fn: "nope", op: "equals", value: "x" }] } });
  assert.equal(bad.status, 400, "a config that couldn't be previewed can't be acted on either");
  assert.equal((await ingestedKeys(db, cid)).size, 5, "and nothing died on the way");
});

test("folder picker: bounded listing under the root", async () => {
  const r = await req(base, "GET", "/api/ingest/folders", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.root, true);
  assert.ok(r.json.folders.includes("pick"));
  assert.ok(r.json.folders.includes("pick/deep"));
});

test("connector boards: the feed adapter serves a browse-derived descriptor", async () => {
  const cid = await seedBoard(db, "connector-board");
  await updateBoard(db, cid, {
    mapping: { input: { connector: "crypto" }, fields: [] },
  });
  const info = await req(base, "GET", `/api/boards/${cid}/ingest`, { sid: admin.sid });
  assert.equal(info.json.available, true);
  const desc = info.json.descriptor;
  assert.deepEqual(desc.source, [], "the connector universe is the source — nothing to configure");
  assert.ok(desc.filters.some((f) => f.fn === "market_cap" && f.kind === "number"), "usd column → number filter");
  assert.ok(desc.filters.some((f) => f.fn === "change_24h" && f.kind === "number"), "percent column → number filter");
  assert.ok(desc.sorts.some((s) => s.by === "market_cap"));
  assert.deepEqual(desc.triggerModes, ["manual", "interval", "daily"], "no continuous rescan against a metered API");

  // A folder-shaped config can't land on a feed board — its file filters
  // (name/extension/…) aren't in the connector's catalog.
  const patch = await req(base, "PATCH", `/api/boards/${cid}`, { sid: admin.sid, body: { ingest: GOOD } });
  assert.equal(patch.status, 400);
  assert.match(patch.json.error, /unknown filter field/);

  // …a feed config saves and arms; the folder-only continuous mode is refused.
  const feedCfg = {
    enabled: true,
    source: {},
    filters: [{ fn: "market_cap", op: "gte", value: 1e9 }],
    sort: { by: "market_cap", order: "desc" },
    limit: 50,
    trigger: { mode: "interval", every: 60 },
  };
  const ok = await req(base, "PATCH", `/api/boards/${cid}`, { sid: admin.sid, body: { ingest: feedCfg } });
  assert.equal(ok.status, 200);
  const b = await getBoard(db, cid);
  assert.deepEqual(b.ingest.filters, feedCfg.filters);
  assert.ok(b.ingest_next_run_at <= Date.now(), "armed for an immediate first run");
  const cont = await req(base, "PATCH", `/api/boards/${cid}`, {
    sid: admin.sid, body: { ingest: { ...feedCfg, trigger: { mode: "continuous" } } },
  });
  assert.equal(cont.status, 400);
  assert.match(cont.json.error, /trigger mode/);

  // A connector the registry doesn't know keeps answering "not available".
  await updateBoard(db, cid, { ingest: null, ingestNextRunAt: null });
  await updateBoard(db, cid, {
    mapping: { input: { connector: "nope" }, fields: [] },
  });
  const gone = await req(base, "GET", `/api/boards/${cid}/ingest`, { sid: admin.sid });
  assert.equal(gone.json.available, false);
});

test("browse: a missing folder is a friendly 404; limit bounds the probe", async () => {
  // 404 — the backend tagged it — with a message built from the subpath, not
  // the resolved absolute path. The browse modal keys its ascend-and-relink
  // fallback on exactly this status.
  const gone = await req(base, "POST", `/api/boards/${boardId}/ingest/source/browse`, {
    sid: admin.sid, body: { source: { type: "folder" }, path: "not-here" },
  });
  assert.equal(gone.status, 404);
  assert.match(gone.json.error, /folder "not-here" doesn't exist under the ingest root/);
  assert.ok(!gone.json.error.includes(root), "no absolute server path in the message");
  assert.ok(!/ENOENT|scandir/.test(gone.json.error), "no raw fs error text either");

  // Config-shaped failures stay 400 — only a missing path earns the fallback.
  const escape = await req(base, "POST", `/api/boards/${boardId}/ingest/source/browse`, {
    sid: admin.sid, body: { source: { type: "folder" }, path: "../escape" },
  });
  assert.equal(escape.status, 400);

  // The health probe's bound: limit 1 answers "does this level open" with a
  // single entry instead of the whole listing.
  const probe = await req(base, "POST", `/api/boards/${boardId}/ingest/source/browse`, {
    sid: admin.sid, body: { source: { type: "folder" }, path: "pick", limit: 1 },
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.json.entries.length, 1);
  assert.equal(probe.json.truncated, true, "there was more than the probe asked to see");
});

test("board payload: ingest_error flags a failing watch — boolean only, config-gated", async () => {
  await patchIngest(GOOD);
  await setIngestState(db, boardId, {
    last_run_at: Date.now(), last_added: 0,
    last_error: 'folder "pick" doesn\'t exist under the ingest root — renamed or removed?',
  });
  let r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_error, true, "the ongoing-state signal the chips tint on");
  assert.equal(r.json.ingest_mode, "scheduled", "failing composes with the mode, it doesn't replace it");

  // A clean run clears it — the flag holds while the failure does, no longer.
  await setIngestState(db, boardId, { last_run_at: Date.now(), last_added: 3, last_error: null });
  r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_error, false);

  // A config save supersedes the old config's verdict: last_error drops at
  // the save seam, so every surface greys together — the PATCH echo, this
  // GET, and the boards page can't disagree. Run history survives.
  await setIngestState(db, boardId, { last_run_at: Date.now(), last_added: 0, last_error: "boom again" });
  assert.equal((await patchIngest(GOOD)).status, 200);
  const st = (await getBoard(db, boardId)).ingest_state;
  assert.equal(st.last_error, undefined, "save dropped the superseded error");
  assert.ok(st.last_run_at, "run history survives the save");
  r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_error, false);

  // Leftover sweep state on a deconfigured board isn't news (ingest_state is
  // sweep-owned; the state here lands AFTER the clearing save, as a crashed
  // sweep's would).
  assert.equal((await patchIngest(null)).status, 200);
  await setIngestState(db, boardId, { last_run_at: Date.now(), last_added: 0, last_error: "stale" });
  r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_error, false, "no config, no flag");
});

test("preview: `total` caps membership; ingested members occupy slots; bounds validated", async () => {
  const bid = await seedBoard(db, "total-preview");
  const body = {
    source: { folder: "pick", recursive: true },
    filters: [{ fn: "extension", op: "equals", value: "txt" }],
    sort: { by: "name", order: "asc" },
    total: 2,
  };
  const r = await req(base, "POST", `/api/boards/${bid}/ingest/preview`, { sid: admin.sid, body });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 2, "membership = the first `total` of the sorted matches (3 txt exist)");
  assert.equal(r.json.new, 2);

  // Sample pages the CAPPED set — the run and the results view read one window.
  const p = await req(base, "POST", `/api/boards/${bid}/ingest/preview`, {
    sid: admin.sid, body: { ...body, sample: { offset: 0, limit: 5 } },
  });
  assert.deepEqual(p.json.sample.map((c) => c.label), ["a.txt", "b.txt"]);
  assert.equal(p.json.hasMore, false, "no pages past the membership");

  // A ledgered member still occupies its slot: count holds, `new` drops —
  // this is what makes `total` mean "top N" instead of "N more per run".
  await recordIngest(db, bid, p.json.sample[0].key, Date.now());
  const r2 = await req(base, "POST", `/api/boards/${bid}/ingest/preview`, { sid: admin.sid, body });
  assert.equal(r2.json.count, 2);
  assert.equal(r2.json.new, 1);

  // Bounds, same ceiling as `limit`.
  for (const bad of [0, -1, 2.5, "x", 100001]) {
    const rb = await req(base, "POST", `/api/boards/${bid}/ingest/preview`, {
      sid: admin.sid, body: { ...body, total: bad },
    });
    assert.equal(rb.status, 400, `total=${bad} refused`);
    assert.match(rb.json.error, /total must be an integer/);
  }
});

test("preview: a full membership suppresses `capped` — the count is no longer a lower bound", async () => {
  const bid = await seedBoard(db, "total-capped");
  for (let i = 1; i <= 5; i++) {
    const p = path.join(root, `totals/t${i}.txt`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "content");
    fs.utimesSync(p, new Date(OLD), new Date(OLD)); // past the settle window, like every fixture here
  }
  const body = { source: { folder: "totals" }, filters: [], sort: { by: "name", order: "asc" } };
  // A rationed window (3 of 5) makes the walk truncate — the operator's knob,
  // read at call time by ENUM_CAP.
  process.env.INGEST_FEED_CAP = "3";
  try {
    const bare = await req(base, "POST", `/api/boards/${bid}/ingest/preview`, { sid: admin.sid, body });
    assert.equal(bare.json.count, 3);
    assert.equal(bare.json.capped, true, "no total: a truncated walk keeps its honest +");
    const above = await req(base, "POST", `/api/boards/${bid}/ingest/preview`, {
      sid: admin.sid, body: { ...body, total: 4 },
    });
    assert.equal(above.json.count, 3);
    assert.equal(above.json.capped, true, "membership not reached: more COULD match — still a lower bound");
    const full = await req(base, "POST", `/api/boards/${bid}/ingest/preview`, {
      sid: admin.sid, body: { ...body, total: 3 },
    });
    assert.equal(full.json.count, 3);
    assert.equal(full.json.capped, false, "membership full: the count cannot grow, the + would lie");
  } finally {
    delete process.env.INGEST_FEED_CAP;
  }
});

test("the ingest config round-trips PATCH → GET wholesale — unknown keys included", async () => {
  // The full shape, plus a key this server build doesn't know. Storing it
  // verbatim is deliberate, not accidental: an older client editing a newer
  // config must not strip the keys it can't see (the modal holds the same
  // contract from its side — test/ingest-modal.test.js), and validateIngest
  // bounds what it knows rather than whitelisting what may exist.
  const bid = await seedBoard(db, "roundtrip");
  const full = {
    enabled: true,
    source: { folder: "pick", recursive: true },
    filters: [{ fn: "extension", op: "equals", value: "txt" }],
    sort: { by: "name", order: "asc" },
    total: 123,
    limit: 45,
    trigger: { mode: "daily", at: "06:30" },
    future_knob: { nested: 7 },
  };
  const r = await req(base, "PATCH", `/api/boards/${bid}`, { sid: admin.sid, body: { ingest: full } });
  assert.equal(r.status, 200);
  const info = await req(base, "GET", `/api/boards/${bid}/ingest`, { sid: admin.sid });
  assert.deepEqual(info.json.config, full, "what was saved is what comes back — no key silently dropped");
});
