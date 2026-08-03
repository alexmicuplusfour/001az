// The worker's tag landing is alert detection's PRIMARY path (processOne ->
// markTagged -> evaluateItemAlerts, worker.js) — the API tests drive only the
// manual-PATCH hook, so nothing there would catch the worker call site being
// dropped. This file drives the real pipeline: a live worker claims a pending
// item, the anthropic wire talks to an in-test stub via ANTHROPIC_BASE_URL
// (the SDK's own endpoint override — no fetch monkey-patching), the tags
// land, and the match must appear with no explicit evaluate call anywhere.
//
// Its own file, not alerts.test.js: a live worker's delivery loop sweeps
// pending matches on its own 50ms cadence, which would race that file's
// carefully backdated settle-window choreography. node:test gives each file
// its own process, so the worker (and the env it needs) stays contained.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, adminSession, seedUser, req } from "./helpers.js";
import { createBoard, createEntity, insertItem } from "../server/db.js";
import { startWorker } from "../server/worker.js";

let srv, db, base, admin, boardId, stopWorker, ai;

const FACETS = [
  { key: "kind", label: "Kind", single: false, values: ["a", "b"] },
  { key: "color", label: "Color", single: false, values: ["red", "blue"] },
];

before(async () => {
  // An Anthropic-shaped tagger: every request comes back as one record_tags
  // tool_use choosing kind/a + color/red — the worker does the rest.
  ai = http.createServer((rq, rs) => {
    rq.on("data", () => {});
    rq.on("end", () => {
      rs.setHeader("Content-Type", "application/json");
      rs.end(JSON.stringify({
        content: [{
          type: "tool_use", id: "tu_stub", name: "record_tags",
          input: {
            kind: { values: ["a"], reasoning: "stub says a" },
            color: { values: ["red"], reasoning: "stub says red" },
          },
        }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => ai.listen(0, "127.0.0.1", r));
  // All read at client/loop construction — set before anything imports or runs.
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
  process.env.ANTHROPIC_API_KEY = "test-key"; // resolveDefaultAi's env fallback
  process.env.POLL_MS = "50";

  srv = await startServer();
  db = srv.db;
  base = srv.base;
  admin = await adminSession(db);
  boardId = await createBoard(db, "Worker alerts board", FACETS, "", true, null, null, { enabled: true });
  stopWorker = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
});

after(async () => {
  await stopWorker?.();
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.POLL_MS;
  await new Promise((r) => ai.close(r));
  await srv.close();
});

async function until(fn, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 60));
  }
}

test("a worker tag landing records the match — the primary detection path, end to end", async () => {
  const r = await req(base, "POST", "/api/alerts", {
    sid: admin.sid,
    body: { board_id: boardId, name: "worker-path", condition: { kind: ["a"], color: ["red"] } },
  });
  assert.equal(r.status, 200, r.text);
  const alert = r.json.alert;

  // A pending, file-less instance (the connector tag-vehicle shape) — the
  // worker claims it, the stub tags it into the watched set.
  const eid = await createEntity(db, boardId, { identity: "wired-entity" });
  const iid = await insertItem(db, boardId, { identity: "wired-entity", files: [], fields: {} }, "pending", eid);

  const match = await until(async () =>
    (await db.query("SELECT * FROM alert_matches WHERE alert_id=$1", [alert.id])).rows[0]);
  assert.equal(match.entity_id, eid);
  assert.equal(match.item_id, iid);

  // And the item really went through the tag leg (not some side door).
  const { rows: [item] } = await db.query("SELECT status, tags FROM items WHERE id=$1", [iid]);
  assert.equal(item.status, "tagged");
  assert.deepEqual(item.tags, ["kind/a", "color/red"]);
});

test("the facet-less tag landing evaluates too — system-facet conditions don't need tags", async () => {
  // A board with no facets takes processOne's no-facet branch (complete,
  // don't fail — getBoardPrompt is null), which is that pipeline's FINAL
  // landing. Before it evaluated, an ~uploaders condition there could never
  // fire from the worker.
  const bare = await createBoard(db, "No-facet board", [], "", true, null, null, { enabled: true });
  const uploader = await seedUser(db, "no-facet-landing@example.com");
  const r = await req(base, "POST", "/api/alerts", {
    sid: admin.sid,
    body: { board_id: bare, name: "no-facet landing", condition: { "~uploaders": [String(uploader.id)] } },
  });
  assert.equal(r.status, 200, r.text);
  const alert = r.json.alert;

  // Inserted BEHIND the upload door on purpose (no birth landing) — a match
  // can only come from the worker's facet-less landing.
  const eid = await createEntity(db, bare, { identity: "bare-entity", uploadedBy: uploader.id });
  const iid = await insertItem(db, bare, { identity: "bare-entity", files: [], fields: {} }, "pending", eid);

  const match = await until(async () =>
    (await db.query("SELECT * FROM alert_matches WHERE alert_id=$1", [alert.id])).rows[0]);
  assert.equal(match.entity_id, eid);

  // And it really took the facet-less branch: completed with zero tags.
  const { rows: [item] } = await db.query("SELECT status, tags FROM items WHERE id=$1", [iid]);
  assert.equal(item.status, "tagged");
  assert.deepEqual(item.tags, []);
});
