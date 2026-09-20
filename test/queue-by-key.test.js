// Queue by key (queue-by-resource-plan.md Stage 2): a board whose API key is
// saturated stops costing boards that use a different key.
//
// Before this, concurrency was bounded by PIPELINE STAGE and rate by RESOURCE,
// so a throttled key's calls sat in the token bucket holding lane slots every
// other board needed. Now the dispatcher holds back only the boards whose own
// resource has no room.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startServer, until } from "./helpers.js";
import {
  claimFairBatch, createAiKey, createBoard, createEntity, insertItem,
  setPluginState, getBoard,
} from "../server/db.js";
import { boardResource, startWorker, invalidateAllBoardCaches } from "../server/worker.js";
import { aiKeyBucket, callTagger } from "../server/providers.js";
import { _reset as resetPool, _usedOf, free, wait, maxFor } from "../server/resource-pool.js";

const FACETS = [{ key: "kind", label: "Kind", single: true, values: ["a", "b"] }];

let srv, db, galleryDir, thumbsDir;
before(async () => {
  srv = await startServer();
  ({ db, galleryDir, thumbsDir } = srv);
  await setPluginState(db, "ai:openai", { installed: true });
});
after(() => srv.close());
beforeEach(() => { resetPool(); invalidateAllBoardCaches(); });

const stubFetch = (handler) => {
  const real = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = real; };
};

// A well-formed compat tool-call answer, so a stubbed call actually lands tags.
const tagReply = () => new Response(JSON.stringify({
  choices: [{ message: { tool_calls: [{ function: {
    name: "record_tags",
    arguments: JSON.stringify({
      description: "d", kind: { values: ["a"], reasoning: "r" },
      fit: { verdict: "match", reasoning: "ok" },
    }),
  } }] } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
}), { status: 200, headers: { "Content-Type": "application/json" } });

let seq = 0;
async function boardWithKey(name, secret) {
  const keyId = await createAiKey(db, `${name}-k${++seq}`, "openai", secret);
  const boardId = await createBoard(db, name, FACETS, "", true, keyId);
  return boardId;
}
const seedPending = async (boardId, label) => {
  const eid = await createEntity(db, boardId, { identity: label });
  return insertItem(db, boardId, { identity: label, files: [], fields: {} }, "pending", eid);
};
const statusOf = async (itemId) =>
  (await db.query("SELECT status FROM items WHERE id=$1", [itemId])).rows[0]?.status;

test("boardResource names the same string the rate limiter buckets", async () => {
  const b = await boardWithKey("qbk-resource", "sk-shared");
  const r = await boardResource(db, "tag", await getBoard(db, b));
  assert.equal(r, aiKeyBucket("openai", "sk-shared"),
    "the pool and the pacing bucket must key on one string, or they bound different things");
});

test("two keys are two resources; one key shared is one", async () => {
  const a = await boardWithKey("qbk-a", "sk-alpha");
  const b = await boardWithKey("qbk-b", "sk-beta");
  const c = await boardWithKey("qbk-c", "sk-alpha"); // same secret, different key row
  const [ra, rb, rc] = await Promise.all([
    boardResource(db, "tag", await getBoard(db, a)),
    boardResource(db, "tag", await getBoard(db, b)),
    boardResource(db, "tag", await getBoard(db, c)),
  ]);
  assert.notEqual(ra, rb, "different keys are independent quotas");
  assert.equal(ra, rc, "the same secret is one quota, however many rows point at it");
});

test("a board with no connector has NO resource — and that must not mean unclaimable", async () => {
  // The defect this stage was drafted with. An allow-list built from resolvable
  // resources would have stranded the face leg forever: queue.test.js asserts a
  // face item claims with no key AND no connector, because it renders nothing
  // and advances, which is real work that completes. Null means unconstrained.
  const b = await boardWithKey("qbk-faceless", "sk-face");
  assert.equal(await boardResource(db, "face", await getBoard(db, b)), null);
  assert.equal(await boardResource(db, "fetch", await getBoard(db, b)), null);

  // And the claim is what proves the consequence: nothing holds it back.
  const iid = await seedPending(b, "faceless.png");
  await db.query("UPDATE items SET status='pending_face' WHERE id=$1", [iid]);
  const rows = await claimFairBatch(db, false, ["pending_face"], 5, []);
  assert.ok(rows.some((r) => r.id === iid), "a face item with no resource still claims");
  await db.query("UPDATE items SET status='failed' WHERE id=$1", [iid]);
});

test("excludeBoards holds back one board's work without touching another's", async () => {
  const a = await boardWithKey("qbk-held", "sk-held");
  const b = await boardWithKey("qbk-free", "sk-free");
  const ia = await seedPending(a, "held.png");
  const ib = await seedPending(b, "free.png");

  const rows = await claimFairBatch(db, true, ["pending"], 10, [a]);
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes(ia), "the saturated board's row is left queued, not failed");
  assert.ok(ids.includes(ib), "the other board claims in the same pass");
  await db.query("UPDATE items SET status='failed' WHERE id = ANY($1)", [[ia, ib]]);
});

test("the wire holds one of its key's slots for the whole call", async () => {
  // The ordering that makes the dispatcher's free() reading meaningful: the slot
  // is taken BEFORE pacing, so a call asleep in the token bucket still reads as
  // busy. Observed from inside the call, which is the only place it is visible.
  const resource = aiKeyBucket("openai", "sk-inflight");
  let insideUsed = -1;
  const restore = stubFetch(async () => { insideUsed = _usedOf(resource); return tagReply(); });
  try {
    assert.equal(_usedOf(resource), 0);
    await callTagger({
      provider: "openai", apiKey: "sk-inflight", model: "gpt-4o-mini",
      systemText: "s", schema: { type: "object" }, parts: [{ kind: "text", text: "t" }],
    });
    assert.equal(insideUsed, 1, "a slot is held while the call is on the wire");
    assert.equal(_usedOf(resource), 0, "and handed back after it, on every path");
  } finally { restore(); }
});

test("a route's call and the worker's call on one key share one count", async () => {
  // Half the demand on these keys never goes through the worker — search,
  // similar, clusters, MCP. Counting at the WIRE is what lets the pool see both:
  // whoever calls, it lands on the same resource.
  const resource = aiKeyBucket("openai", "sk-shared-count");
  await wait(resource); // stand in for a route already in flight on this key
  assert.equal(_usedOf(resource), 1);

  let insideUsed = -1;
  const restore = stubFetch(async () => { insideUsed = _usedOf(resource); return tagReply(); });
  try {
    await callTagger({
      provider: "openai", apiKey: "sk-shared-count", model: "gpt-4o-mini",
      systemText: "s", schema: { type: "object" }, parts: [{ kind: "text", text: "t" }],
    });
  } finally { restore(); }
  assert.equal(insideUsed, 2, "the wire call joined the route's count, it did not get its own");
  assert.equal(free(resource), maxFor(resource) - 1, "and only the route's slot is still held");
});

// This test was PARKED through Stage 2 and the reason was a real defect it
// found: AI_INFLIGHT sized BOTH the global AI lane and the per-key pool ceiling,
// so saturating one key filled the whole lane, the dispatcher claimed nothing
// for anybody, and the hold-back was never consulted. Stage 3b retires the lane
// — AI_INFLIGHT now sizes each KEY's own pool and nothing else — so the two
// boards below genuinely cannot block each other, and this is the test that says
// the arc's headline claim is true.
test("a saturated key does not stop a board on another key from tagging", async () => {
  // The end-to-end claim of the whole stage. Board A's key is pinned at one
  // in-flight call that never returns; board B must still finish. Asserted as an
  // OUTCOME that simply never arrives if the bug is present, never as a duration.
  const prevInflight = process.env.AI_INFLIGHT;
  process.env.AI_INFLIGHT = "1"; // one hanging call is enough to saturate
  const a = await boardWithKey("qbk-e2e-stuck", "sk-stuck");
  const b = await boardWithKey("qbk-e2e-ok", "sk-ok");
  const ia = await seedPending(a, "stuck.png");
  const ib = await seedPending(b, "ok.png");

  let hung = 0;
  // Held open, but RELEASABLE. stop() drains in-flight pipelines with no cap of
  // its own — only server.js's shutdown races it against 5s — so a call that
  // truly never settles would hang the drain and the test with it.
  const holds = [];
  const restore = stubFetch(async (_url, opts = {}) => {
    const auth = opts.headers?.Authorization || opts.headers?.authorization || "";
    if (auth.includes("sk-stuck")) {
      hung++;
      return new Promise((_res, rej) => holds.push(rej));
    }
    return tagReply();
  });

  const stop = startWorker({ db, galleryDir, thumbsDir });
  try {
    await until(() => hung > 0); // board A is holding its key's only slot
    await until(async () => (await statusOf(ib)) === "tagged");
    assert.equal(await statusOf(ia), "processing",
      "board A is still waiting on its own key, as it should be");
  } finally {
    restore();
    for (const rej of holds) rej(new Error("test teardown")); // let the drain finish
    await stop();
    if (prevInflight === undefined) delete process.env.AI_INFLIGHT;
    else process.env.AI_INFLIGHT = prevInflight;
    await db.query("UPDATE items SET status='failed' WHERE id = ANY($1)", [[ia, ib]]);
  }
});
