// Vote mode's two pure helpers (planning/tagging-accuracy-plan.md).
//
// The whole feature exists because re-running one prompt on one item changes
// 18-22% of facet answers; these pin how N disagreeing runs collapse into one
// answer, and how much of that disagreement is reported back as confidence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import { createAiKey, createBoard, createEntity, insertItem, setPluginState, updateBoard } from "../server/db.js";
import { mergeVotes, parseRun, startWorker } from "../server/worker.js";

const FACETS = [
  { key: "shape", single: true, values: ["round", "square", "wide"] },
  { key: "motif", values: ["animal", "plant", "star"] },
];
const allowed = new Set(["shape/round", "shape/square", "shape/wide", "motif/animal", "motif/plant", "motif/star"]);

// A run in the shape parseRun produces.
const run = (shape, motif, extra = {}) => ({
  picks: { shape, motif },
  reasoning: { shape: `shape:${shape.join("+") || "none"}`, motif: `motif:${motif.join("+") || "none"}` },
  description: "d",
  fit: { verdict: "match", reasoning: "fits" },
  ...extra,
});

// ─── parseRun ────────────────────────────────────────────────────────────────

test("parseRun: filters to the allowed vocabulary, sorts, and lifts reasoning", () => {
  const r = parseRun({
    description: "  a mark  ",
    shape: { reasoning: " it is round ", values: ["round", "not-a-value"] },
    motif: { reasoning: "", values: ["star", "animal"] },
    fit: { verdict: "match", reasoning: "yes" },
  }, FACETS, allowed);
  assert.deepEqual(r.picks.shape, ["round"]); // off-vocabulary value dropped
  assert.deepEqual(r.picks.motif, ["animal", "star"]); // sorted
  assert.equal(r.reasoning.shape, "it is round");
  assert.equal(r.reasoning.motif, undefined); // blank string is not a sentence
  assert.equal(r.description, "a mark");
  assert.deepEqual(r.fit, { verdict: "match", reasoning: "yes" });
});

test("parseRun: normalises the ai_reasoning:false shape (bare arrays, string fit)", () => {
  // With reasoning off the schema emits bare arrays, a bare enum string for fit,
  // and no description at all — the merge must never see two shapes.
  const r = parseRun({ shape: ["square"], motif: ["plant"], fit: "undecided" }, FACETS, allowed);
  assert.deepEqual(r.picks, { shape: ["square"], motif: ["plant"] });
  assert.deepEqual(r.fit, { verdict: "undecided" });
  assert.equal(r.description, undefined);
  assert.deepEqual(r.reasoning, {});
});

// fit.reasoning normalises on the same terms as description and the per-facet
// sentences — parseRun is the ONE place, so nothing downstream re-checks. The
// schema marks it REQUIRED, which is what makes a blank one reachable: a model
// with nothing to say pads rather than omits. Stored raw, a truthy blank wins
// the `why.fit || fallback` slot in the lightbox and draws an empty note box.
test("parseRun: fit reasoning is trimmed, and a blank one is not a sentence", () => {
  const of = (fit) => parseRun({ shape: ["round"], motif: [], fit }, FACETS, allowed).fit;
  assert.deepEqual(of({ verdict: "undecided", reasoning: "   " }), { verdict: "undecided" });
  assert.deepEqual(of({ verdict: "match", reasoning: "  it fits  " }), { verdict: "match", reasoning: "it fits" });
  // strictTools:false providers (glm, openrouter) and Anthropic's advisory tool
  // schema can all answer with a non-string here; the enum verdict survives it.
  assert.deepEqual(of({ verdict: "match", reasoning: { oops: 1 } }), { verdict: "match" });
});

test("parseRun: a facet the model omitted entirely becomes an empty selection", () => {
  const r = parseRun({ fit: "match" }, FACETS, allowed);
  assert.deepEqual(r.picks, { shape: [], motif: [] });
});

// ─── mergeVotes ──────────────────────────────────────────────────────────────

test("one run is the identity — votes=1 must behave exactly as before", () => {
  const only = run(["round"], ["star"]);
  const m = mergeVotes(FACETS, [only]);
  assert.deepEqual(m.picks, only.picks);
  assert.deepEqual(m.reasoning, only.reasoning);
  // {} means NOT MEASURED, never "zero confidence" — a single pass measures nothing
  assert.deepEqual(m.confidence, {});
});

test("unanimous runs keep the answer at confidence 1", () => {
  const m = mergeVotes(FACETS, [run(["round"], ["star"]), run(["round"], ["star"]), run(["round"], ["star"])]);
  assert.deepEqual(m.picks.shape, ["round"]);
  assert.deepEqual(m.picks.motif, ["star"]);
  assert.deepEqual(m.confidence.shape, { of: 3, agreed: 3, votes: { round: 3 } });
  assert.deepEqual(m.confidence.motif, { of: 3, agreed: 3, votes: { star: 3 } });
});

test("single-value facet: 2 of 3 wins, and confidence reports the split", () => {
  const m = mergeVotes(FACETS, [run(["round"], []), run(["square"], []), run(["round"], [])]);
  assert.deepEqual(m.picks.shape, ["round"]);
  assert.deepEqual(m.confidence.shape, { of: 3, agreed: 2, votes: { round: 2, square: 1 } });
});

test("single-value facet: a 3-way split still yields a value, never an empty one", () => {
  // argmax, NOT a majority threshold. An empty selection would read downstream
  // as "nothing applies" — a different claim, and one the fit guard acts on.
  const m = mergeVotes(FACETS, [run(["round"], []), run(["square"], []), run(["wide"], [])]);
  assert.deepEqual(m.picks.shape, ["round"], "ties resolve to the earliest run");
  // the losing proposals survive — this tally is what the facet diagnosis reads
  assert.deepEqual(m.confidence.shape, { of: 3, agreed: 1, votes: { round: 1, square: 1, wide: 1 } });
});

test("multi-value facet: a value needs a majority to survive", () => {
  const m = mergeVotes(FACETS, [
    run([], ["animal", "star"]),
    run([], ["animal", "plant"]),
    run([], ["animal"]),
  ]);
  // animal 3/3 stays; plant and star are 1/3 each and drop
  assert.deepEqual(m.picks.motif, ["animal"]);
  // no run selected exactly ["animal"] except the third
  assert.deepEqual(m.confidence.motif, { of: 3, agreed: 1, votes: { animal: 3, star: 1, plant: 1 } });
});

test("multi-value facet: exactly at the threshold survives, one below drops", () => {
  const at = mergeVotes(FACETS, [run([], ["plant"]), run([], ["plant"]), run([], ["star"])]);
  assert.deepEqual(at.picks.motif, ["plant"]); // 2 of 3 == floor(3/2)+1
  const below = mergeVotes(FACETS, [run([], ["plant"]), run([], ["star"]), run([], ["animal"])]);
  assert.deepEqual(below.picks.motif, [], "nothing reached a majority");
});

test("the kept answer carries the reasoning of a run that actually made it", () => {
  // runs[0] voted "square" and lost; its sentence justifies the wrong value and
  // must not be stored against "round".
  const m = mergeVotes(FACETS, [run(["square"], []), run(["round"], []), run(["round"], [])]);
  assert.deepEqual(m.picks.shape, ["round"]);
  assert.equal(m.reasoning.shape, "shape:round");
});

// The mirror of the test above, and the case a runs[0] fallback got wrong: on a
// multi-value facet the merge routinely keeps a set NO single run proposed, so
// there is no sentence to carry and none must be invented.
test("no reasoning survives a selection no run actually made", () => {
  // Both runs said plant and each added a different second value; only plant
  // clears the threshold. Run 0's sentence justifies plant AND star, so pinning
  // it to a lone plant chip argues for a value the merge just discarded.
  const partial = mergeVotes(FACETS, [run([], ["plant", "star"]), run([], ["animal", "plant"])]);
  assert.deepEqual(partial.picks.motif, ["plant"]);
  assert.equal(partial.reasoning.motif, undefined, "no run selected exactly [plant]");

  // …and when the facet converges on nothing at all, likewise. The lightbox
  // still draws the row off the confidence split, so this loses no signal.
  const none = mergeVotes(FACETS, [run([], ["plant"]), run([], ["star"])]);
  assert.deepEqual(none.picks.motif, []);
  assert.equal(none.reasoning.motif, undefined);
  assert.deepEqual(none.confidence.motif, { of: 2, agreed: 0, votes: { plant: 1, star: 1 } });

  // Single-value facets are untouched — argmax always keeps a value some run
  // picked, so a source run exists and its sentence rides along as before.
  const single = mergeVotes(FACETS, [run(["square"], []), run(["round"], []), run(["round"], [])]);
  assert.equal(single.reasoning.shape, "shape:round");
});

test("description and fit come from one run, the one that agreed most", () => {
  const odd = run(["square"], ["plant"], { description: "the outlier", fit: { verdict: "match", reasoning: "outlier" } });
  const a = run(["round"], ["star"], { description: "the consensus", fit: { verdict: "match", reasoning: "consensus" } });
  const m = mergeVotes(FACETS, [odd, a, run(["round"], ["star"])]);
  assert.equal(m.description, "the consensus");
  assert.equal(m.fit.reasoning, "consensus");
});

test("fit verdict is a majority, and ties fall to match", () => {
  const und = (extra) => run(["round"], ["star"], { fit: { verdict: "undecided", reasoning: "no" }, ...extra });
  assert.equal(mergeVotes(FACETS, [und(), und(), run(["round"], ["star"])]).fit.verdict, "undecided");
  assert.equal(mergeVotes(FACETS, [und(), run(["round"], ["star"]), run(["round"], ["star"])]).fit.verdict, "match");
  // an even split is not a majority -> match, the recoverable side
  assert.equal(mergeVotes(FACETS, [und(), run(["round"], ["star"])]).fit.verdict, "match");
});

test("merging survivors of a partially failed vote round still works", () => {
  // tagOne pushes only fulfilled runs, so the merge can legitimately see 2 of 3.
  const m = mergeVotes(FACETS, [run(["round"], ["star"]), run(["round"], ["star"])]);
  assert.deepEqual(m.picks.shape, ["round"]);
  assert.deepEqual(m.confidence.shape, { of: 2, agreed: 2, votes: { round: 2 } });
});

test("the majority threshold is STRICT, including at even run counts", () => {
  // ceil(N/2) would let a value supported by exactly half survive at N=4.
  // runs.length is not guaranteed odd — a hand-edited ai_votes, or a round
  // where one vote failed, both land here.
  const four = [run([], ["plant"]), run([], ["plant"]), run([], ["star"]), run([], ["star"])];
  assert.deepEqual(mergeVotes(FACETS, four).picks.motif, [], "2 of 4 is a tie, not a majority");
  const three = [run([], ["plant"]), run([], ["plant"]), run([], ["plant"]), run([], ["star"])];
  assert.deepEqual(mergeVotes(FACETS, three).picks.motif, ["plant"], "3 of 4 is a majority");
  // two surviving runs must AGREE — "keep what the model repeats" means both
  assert.deepEqual(mergeVotes(FACETS, [run([], ["plant"]), run([], ["star"])]).picks.motif, []);
  assert.deepEqual(mergeVotes(FACETS, [run([], ["plant"]), run([], ["plant"])]).picks.motif, ["plant"]);
});

test("a facet nobody selected is empty at full confidence, not absent", () => {
  const m = mergeVotes(FACETS, [run([], []), run([], []), run([], [])]);
  assert.deepEqual(m.picks.shape, []);
  assert.deepEqual(m.picks.motif, []);
  assert.deepEqual(m.confidence.shape, { of: 3, agreed: 3, votes: {} }, "unanimous silence is still unanimous");
});

// ─── integration: passes are silent ──────────────────────────────────────────
// The invariant the whole design rests on — however many votes run, the item
// takes ONE landing. Only the paid call and its usage row are genuinely N.

let srv, db;
before(async () => {
  srv = await startServer();
  db = srv.db;
  process.env.POLL_MS = "50";
});
after(async () => {
  delete process.env.POLL_MS;
  await srv?.close?.();
});

const runWorker = () => startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const stubFetch = (handler) => {
  const real = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = real; };
};

const BF = [{ key: "kind", label: "Kind", single: true, values: ["a", "b"] }];

// Each call answers differently so a merge is actually exercised: a, b, a.
const rotatingTagger = (answers, calls) => async (_url, opts) => {
  const body = JSON.parse(opts.body);
  const v = answers[calls.length % answers.length];
  calls.push(body);
  return new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: { name: body.tools?.[0]?.function?.name,
      arguments: JSON.stringify({ description: "d", kind: { values: [v], reasoning: `picked ${v}` }, fit: { verdict: "match", reasoning: "ok" } }) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200 });
};

async function seedTaggable(boardId, name) {
  const eid = await createEntity(db, boardId, { identity: name });
  return insertItem(db, boardId, { identity: name, files: [], fields: {} }, "pending", eid);
}

const rowsOf = async (sql, args) => (await db.query(sql, args)).rows;

test("three votes make three calls but exactly one landing", async () => {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "votes-k1", "openai", "sk-test");
  const board = await createBoard(db, "votes-3", BF, "", true, keyId);
  await updateBoard(db, board, { aiVotes: 3 });
  const iid = await seedTaggable(board, "one.png");

  const calls = [];
  const restore = stubFetch(rotatingTagger(["a", "b", "a"], calls));
  const stop = runWorker();
  try {
    await until(async () => (await rowsOf("SELECT status FROM items WHERE id=$1", [iid]))[0]?.status === "tagged");
  } finally {
    await stop();
    restore();
  }

  assert.equal(calls.length, 3, "one paid call per vote");
  // …and every one of them sent the SAME prompt — voting must not vary the ask
  assert.equal(new Set(calls.map((c) => JSON.stringify(c.messages))).size, 1);

  const [item] = await rowsOf("SELECT tags, tag_confidence FROM items WHERE id=$1", [iid]);
  assert.deepEqual(item.tags, ["kind/a"], "2 of 3 said a");
  assert.deepEqual(item.tag_confidence.kind, { of: 3, agreed: 2, votes: { a: 2, b: 1 } });

  // one landing: one snapshot, one job-log row, one item
  assert.equal((await rowsOf("SELECT 1 FROM tag_snapshots WHERE item_id=$1", [iid])).length, 1);
  const jobs = await rowsOf("SELECT * FROM job_log WHERE board_id=$1 AND kind='tag'", [board]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].outcome, "ok");
  assert.equal(jobs[0].detail.votes, 3);

  // usage is the one deliberate N: the ledger counts PAID CALLS, not items
  const [usage] = await rowsOf("SELECT count, input_tokens FROM ai_board_usage WHERE board_id=$1", [board]);
  assert.equal(usage.count, 3);
  assert.equal(Number(usage.input_tokens), 30); // 10 prompt tokens x 3
});

test("a single-pass board is untouched: one call, and confidence stays unmeasured", async () => {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "votes-k2", "openai", "sk-test");
  const board = await createBoard(db, "votes-1", BF, "", true, keyId); // ai_votes defaults to 1
  const iid = await seedTaggable(board, "two.png");

  const calls = [];
  const restore = stubFetch(rotatingTagger(["a"], calls));
  const stop = runWorker();
  try {
    await until(async () => (await rowsOf("SELECT status FROM items WHERE id=$1", [iid]))[0]?.status === "tagged");
  } finally {
    await stop();
    restore();
  }
  assert.equal(calls.length, 1);
  const [item] = await rowsOf("SELECT tags, tag_confidence FROM items WHERE id=$1", [iid]);
  assert.deepEqual(item.tags, ["kind/a"]);
  // {} = NOT MEASURED. A single pass measures no agreement, and must not claim 1.0.
  assert.deepEqual(item.tag_confidence, {});
  const jobs = await rowsOf("SELECT detail FROM job_log WHERE board_id=$1 AND kind='tag'", [board]);
  assert.equal(jobs[0].detail.votes, undefined, "no votes key on a single-pass board");
});

test("research forces a single pass however many votes the column asks for", async () => {
  // web_search bills per search ON TOP of tokens; N votes would multiply a cost
  // the token estimate never sees. The guard lives in the worker, not the route,
  // so touching the column directly is still safe.
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "votes-k3", "openai", "sk-test");
  const board = await createBoard(db, "votes-research", BF, "", true, keyId, null, {}, true);
  await updateBoard(db, board, { aiVotes: 5 });
  const iid = await seedTaggable(board, "three.png");

  const calls = [];
  const restore = stubFetch(rotatingTagger(["a", "b", "a", "b", "a"], calls));
  const stop = runWorker();
  try {
    await until(async () => (await rowsOf("SELECT status FROM items WHERE id=$1", [iid]))[0]?.status === "tagged");
  } finally {
    await stop();
    restore();
  }
  assert.equal(calls.length, 1, "research must not fan out");
});

// ─── routes: ai_votes validation ─────────────────────────────────────────────

test("ai_votes round-trips, rejects even/out-of-range, and refuses research", async () => {
  const admin = await adminSession(db);
  const B = srv.base;

  // defaults to a single pass
  const plain = await req(B, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "v-plain" } });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.ai_votes, 1);

  const made = await req(B, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "v-three", ai_votes: 3 } });
  assert.equal(made.status, 200);
  assert.equal(made.json.ai_votes, 3);

  const list = async () => (await req(B, "GET", "/api/admin/boards", { sid: admin.sid })).json;
  assert.equal((await list()).find((b) => b.id === made.json.id).ai_votes, 3);

  // even counts make a real tie reachable on a single-value facet
  for (const bad of [2, 4, 0, 7, "three"]) {
    const r = await req(B, "PATCH", `/api/admin/boards/${made.json.id}`, { sid: admin.sid, body: { ai_votes: bad } });
    assert.equal(r.status, 400, `ai_votes ${bad} must be refused`);
  }

  // research bills per search, per pass — the pair is refused in BOTH directions
  const addResearch = await req(B, "PATCH", `/api/admin/boards/${made.json.id}`, { sid: admin.sid, body: { ai_research: true } });
  assert.equal(addResearch.status, 400, "turning research on under votes>1 must be refused");

  const researched = await req(B, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "v-res", ai_research: true } });
  const addVotes = await req(B, "PATCH", `/api/admin/boards/${researched.json.id}`, { sid: admin.sid, body: { ai_votes: 3 } });
  assert.equal(addVotes.status, 400, "turning votes on under research must be refused");

  // …and at create time
  const both = await req(B, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "v-both", ai_votes: 3, ai_research: true } });
  assert.equal(both.status, 400);

  // swapping one for the other in a single PATCH is legal
  const swap = await req(B, "PATCH", `/api/admin/boards/${researched.json.id}`, { sid: admin.sid, body: { ai_research: false, ai_votes: 5 } });
  assert.equal(swap.status, 200);
  assert.equal((await list()).find((b) => b.id === researched.json.id).ai_votes, 5);

});

test("an edit that touches neither votes nor research is never blocked by them", async () => {
  // A board can hold the forbidden pair only by editing the column directly,
  // but once it does, renaming it must still work — validating untouched state
  // would fail an edit for a reason absent from the request. Tagging stays safe
  // either way: getBoardPrompt forces a single pass under research.
  const admin = await adminSession(db);
  const B = srv.base;
  const made = await req(B, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "v-legacy", ai_research: true } });
  await db.query("UPDATE boards SET ai_votes=3 WHERE id=$1", [made.json.id]);

  const renamed = await req(B, "PATCH", `/api/admin/boards/${made.json.id}`, { sid: admin.sid, body: { name: "v-legacy-2" } });
  assert.equal(renamed.status, 200, "an unrelated edit must not trip the pair check");

  // …but touching either half still refuses while the other stands
  const bump = await req(B, "PATCH", `/api/admin/boards/${made.json.id}`, { sid: admin.sid, body: { ai_votes: 5 } });
  assert.equal(bump.status, 400);
});
