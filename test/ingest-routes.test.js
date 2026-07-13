// The ingestion HTTP surface: config PATCH validation + timer bookkeeping,
// the descriptor/config GET, the preview dry-run (never saved), run-now with
// its auth matrix, the folder picker listing, and the board payload flag.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";
import { getBoard, updateBoard } from "../server/db.js";

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
  assert.equal(r.json.root, true);
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
    [{ ...GOOD, limit: 501 }, /limit/],
    [{ ...GOOD, source: { folder: "../escape" } }, /escapes/],
    [{ ...GOOD, source: {} }, /folder is required/],
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

  // ingest: null clears everything.
  assert.equal((await patchIngest(null)).status, 200);
  b = await getBoard(db, boardId);
  assert.equal(b.ingest, null);
});

test("board payload: ingest_enabled flag follows the saved config", async () => {
  let r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_enabled, false);
  assert.equal(r.json.ingest_next_run_at, null);
  await patchIngest(GOOD);
  r = await req(base, "GET", `/api/boards/${boardId}`, { sid: admin.sid });
  assert.equal(r.json.ingest_enabled, true);
  assert.ok(r.json.ingest_next_run_at > 0, "the chip's countdown stamp rides the payload");
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

test("run-now: auth matrix and the enabled gate", async () => {
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

  await patchIngest({ ...GOOD, enabled: false });
  const off = await req(base, "POST", `/api/boards/${boardId}/ingest/run`, { sid: admin.sid });
  assert.equal(off.status, 409, "no running a disabled feed");
});

test("folder picker: bounded listing under the root", async () => {
  const r = await req(base, "GET", "/api/ingest/folders", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.root, true);
  assert.ok(r.json.folders.includes("pick"));
  assert.ok(r.json.folders.includes("pick/deep"));
});

test("connector boards: ingestion answers 'not available' everywhere (until phase 2)", async () => {
  const cid = await seedBoard(db, "connector-board");
  await updateBoard(db, cid, {
    mapping: { input: { connector: "crypto" }, identity: { from: "connector" }, fields: [] },
  });
  const info = await req(base, "GET", `/api/boards/${cid}/ingest`, { sid: admin.sid });
  assert.equal(info.json.available, false);

  const patch = await req(base, "PATCH", `/api/boards/${cid}`, { sid: admin.sid, body: { ingest: GOOD } });
  assert.equal(patch.status, 400);
  assert.match(patch.json.error, /not available/);

  const prev = await req(base, "POST", `/api/boards/${cid}/ingest/preview`, { sid: admin.sid, body: GOOD });
  assert.equal(prev.status, 400);
});
