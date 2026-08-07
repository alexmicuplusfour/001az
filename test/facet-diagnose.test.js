// The diagnosis call, its gates, and the demotion (planning/facet-diagnosis-plan.md
// §3-§5).
//
// Two things here are load-bearing and neither fails loudly. The gates decide
// whether a paid call happens at all, and every wrong answer they can give looks
// like "nothing to report" — which is also what a healthy board looks like. And
// the demotion is triggered by a diff the board modal actively works against:
// it sends `facets` on every save whether or not the taxonomy moved.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import {
  createAiKey, createBoard, createEntity, insertItem, setPluginState,
  updateBoard, getBoard, setFacetDiagnostic, demoteFacetDiagnostics,
} from "../server/db.js";
import { facetStamp, editedFacets, diagnoseDue, buildDiagnosePrompt } from "../server/facet-diagnosis.js";
import { startWorker } from "../server/worker.js";

// The gates are read at module load, which ESM hoists above anything this file
// could set — so these run against the SHIPPED defaults (20 items, 15%, a
// ten-minute settle) rather than against convenient ones. Fixtures are sized to
// clear them, and `updated_at = 0` is what puts every seeded item outside the
// settle window.
const MIN_ITEMS = 20;

let srv, db;
before(async () => {
  srv = await startServer();
  db = srv.db;
});
// diagnoseDue scans the whole install and stops after a bounded number of
// boards — correct in production, and it means a test's board would otherwise
// sit behind whatever the previous test left lying around. One board per test.
beforeEach(async () => { await db.query("DELETE FROM boards"); });
after(async () => { await srv?.close?.(); });

const BF = [
  { key: "shape", label: "Shape", single: true, description: "the silhouette", values: ["round", "wide"] },
  { key: "motif", label: "Motif", description: "what it depicts", values: ["star", "leaf"] },
];
const FULL = { shape: facetStamp(BF[0], false), motif: facetStamp(BF[1], false) };

let seq = 0;
async function board(name, { facets = BF, votes = 3 } = {}) {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, `fd-${name}-${++seq}`, "openai", "sk-test");
  const id = await createBoard(db, `fd-${name}-${seq}`, facets, "a board of marks", true, keyId);
  if (votes > 1) await updateBoard(db, id, { aiVotes: votes });
  return id;
}

const conf = (d, of, agreed, votes) => ({ of, agreed, votes, d });

// updated_at = 0 puts the item well outside the settle window; a test that wants
// to exercise the window passes `at: Date.now()`.
async function item(boardId, { confidence, status = "tagged", description = "a mark", at = 0 }) {
  const eid = await createEntity(db, boardId, { identity: `d${++seq}` });
  const id = await insertItem(db, boardId, { identity: `d${seq}`, files: [], fields: {} }, "pending", eid);
  await db.query(
    "UPDATE items SET status=$1, tag_confidence=$2, tag_reasoning=$3, updated_at=$4 WHERE id=$5",
    [status, JSON.stringify(confidence), JSON.stringify({ description }), at, id]
  );
  return id;
}

// 17 contested + 4 clean: over the item minimum, and 81% unstable so a test that
// expects NO call is testing the gate it names rather than an accident of the
// fixture. Every contested item reads {round: 2, wide: 1} of 3 — both values
// split, neither unanimous within the item.
async function seedUnstable(boardId, key = "shape", d = FULL.shape, { contested = 17, clean = 4 } = {}) {
  for (let i = 0; i < contested; i++) {
    await item(boardId, { confidence: { [key]: conf(d, 3, 2, { round: 2, wide: 1 }) }, description: `contested ${i}` });
  }
  for (let i = 0; i < clean; i++) {
    await item(boardId, { confidence: { [key]: conf(d, 3, 3, { round: 3 }) }, description: `clean ${i}` });
  }
}

// A tagger stub in the shape trackedTagger returns. Records every call so a
// test can assert on the prompt as well as on the count.
function stubTagger(answer = {}, calls = []) {
  return {
    calls,
    resolveAi: async () => ({ provider: "openai", apiKey: "sk-test", model: "gpt-5-mini" }),
    tagger: async (args) => {
      calls.push(args);
      return {
        input: {
          verdict: "overlapping-values",
          explanation: "round and wide overlap",
          values: ["round", "wide"],
          suggestion: "prefer wide when both read true",
          ...answer,
        },
        // The shape bumpUsage actually reads — input_tokens/output_tokens
        // would book zero while still incrementing the row's count.
        usage: { input: 100, output: 20, cacheRead: 0 },
      };
    },
  };
}

const diagnosticsOf = async (id) => (await getBoard(db, id)).facet_diagnostics;

const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ─── the happy path ──────────────────────────────────────────────────────────

test("an unstable facet is diagnosed, stored, billed and logged", async () => {
  const b = await board("happy");
  await seedUnstable(b);
  const deps = stubTagger();

  const done = await diagnoseDue(db, deps, null);
  assert.equal(done.calls, 1);
  assert.equal(deps.calls.length, 1, "one call for the one unstable facet");
  assert.equal(deps.calls[0].tool.name, "record_diagnosis");

  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.verdict, "overlapping-values");
  assert.equal(e.suggestion, "prefer wide when both read true");
  assert.deepEqual(e.stats, { items: 21, unanimous: 4 });
  assert.equal(e.d, FULL.shape);
  assert.equal(e.scoped, false);
  assert.deepEqual(e.split, ["round", "wide"]);

  const [usage] = (await db.query("SELECT count, input_tokens FROM ai_board_usage WHERE board_id=$1", [b])).rows;
  assert.equal(usage.count, 1, "the call is billed like any other");
  assert.equal(Number(usage.input_tokens), 100, "…with its tokens, not just its row");

  const [job] = (await db.query("SELECT * FROM job_log WHERE board_id=$1 AND kind='diagnose'", [b])).rows;
  assert.equal(job.target, "shape", "the ledger names the facet");
  assert.deepEqual(job.detail, { items: 21, unanimous: 4, verdict: "overlapping-values", scoped: false });
});

test("a stable facet on the same board is never diagnosed", async () => {
  // `presentation` at 100% unanimous must never generate a paragraph explaining
  // what is wrong with it.
  const b = await board("stable");
  await seedUnstable(b);
  for (let i = 0; i < MIN_ITEMS + 1; i++) {
    await item(b, { confidence: { motif: conf(FULL.motif, 3, 3, { star: 3 }) } });
  }
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.deepEqual(deps.calls.map((c) => c.tool.name), ["record_diagnosis"], "one call, not two");
  assert.equal((await diagnosticsOf(b)).motif, undefined);
});

// ─── the gates ───────────────────────────────────────────────────────────────

test("no diagnosis on a single-pass board — there is no confidence to read", async () => {
  const b = await board("single", { votes: 1 });
  await seedUnstable(b);
  const deps = stubTagger();
  const done = await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 0);
  assert.equal(done?.boardId ?? null, null, "the board is not even in the rotation");
});

test("no diagnosis below the item minimum", async () => {
  const b = await board("thin");
  await seedUnstable(b, "shape", FULL.shape, { contested: MIN_ITEMS - 1, clean: 0 });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 0, "one item short, and a paragraph about noise is worse than silence");
});

test("no diagnosis below the instability rate", async () => {
  const b = await board("steady");
  await seedUnstable(b, "shape", FULL.shape, { contested: 2, clean: 22 });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 0, "2 in 24 is under the 15% floor");
});

test("no diagnosis while items are still queued", async () => {
  // A bulk retag lands items over minutes and the tally moves the whole time.
  const b = await board("busy");
  await seedUnstable(b);
  await item(b, { status: "pending", confidence: {} });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 0);
});

test("no diagnosis inside the settle window, even with the queue empty", async () => {
  // The other half of gate 2, and the one an empty queue does not cover: the
  // last item landed a moment ago, so the tally is still moving and a paragraph
  // written now re-stales immediately.
  const b = await board("settling");
  await seedUnstable(b);
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) }, at: Date.now() });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 0, "a diagnosis mid-sweep burns a call on a moving target");
});

test("no diagnosis on measurements of a definition the user has replaced", async () => {
  // The whole reason the stamp exists: the gate counts only items measured
  // against the CURRENT wording, so an edit takes the sample to zero and the
  // next pass spends nothing until something has been re-measured.
  const b = await board("edited");
  await seedUnstable(b);
  const edited = BF.map((f) => (f.key === "shape" ? { ...f, description: "brand new gloss" } : f));
  await updateBoard(db, b, { facets: edited });

  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 0, "zero calls — the gate cannot see a single current measurement");
});

test("a scoped re-measurement is what un-blocks it, and the finding records that shape", async () => {
  // The other half of the loop, and the direction rev. 2 would have broken: read
  // only the full stamp and this never fires, because the scoped retag the plan
  // prescribes writes the other one.
  const b = await board("rescued");
  const edited = BF.map((f) => (f.key === "shape" ? { ...f, description: "brand new gloss" } : f));
  await updateBoard(db, b, { facets: edited });
  const scopedStamp = facetStamp(edited[0], true);
  await seedUnstable(b, "shape", scopedStamp);

  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);
  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.d, scopedStamp);
  assert.equal(e.scoped, true, "the entry says which prompt shape it read");
});

// ─── staleness ───────────────────────────────────────────────────────────────

test("a second pass over unchanged measurements spends nothing", async () => {
  const b = await board("stale");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1, "the paragraph still describes the data");
});

test("…but a moved rate re-diagnoses", async () => {
  const b = await board("moved");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);

  for (let i = 0; i < 21; i++) {
    await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });
  }
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2, "81% unstable then 40% is not the same finding");
});

// ─── the escape hatches ──────────────────────────────────────────────────────

test("no-problem-found stores, and stores without a suggestion", async () => {
  // It has to store, or staleness never records and every tick re-calls. And the
  // suggestion is forced empty rather than trusted: a model that has just said
  // nothing is wrong must not also hand the UI wording to paste in.
  const b = await board("no-problem");
  await seedUnstable(b);
  const deps = stubTagger({ verdict: "no-problem-found", suggestion: "prefer wide anyway" });
  await diagnoseDue(db, deps, null);

  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.verdict, "no-problem-found");
  assert.equal(e.suggestion, "");
});

test("genuinely-ambiguous-items likewise carries no suggestion", async () => {
  const b = await board("ambiguous");
  await seedUnstable(b);
  const deps = stubTagger({ verdict: "genuinely-ambiguous-items", suggestion: "split the facet" });
  await diagnoseDue(db, deps, null);
  assert.equal((await diagnosticsOf(b)).shape.suggestion, "");
});

test("an off-schema verdict is never coerced into a finding", async () => {
  // strictTools:false providers treat the schema as advisory. A stored VERDICT
  // is a claim about the user's taxonomy; "the model said something we don't
  // understand" is not one. The attempt is still recorded — it cost money, and
  // the next tick has to know not to spend it again.
  const b = await board("garbage");
  await seedUnstable(b);
  const deps = stubTagger({ verdict: "the-facet-is-cursed" });
  await diagnoseDue(db, deps, null);
  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.verdict, undefined, "nothing was invented");
  assert.equal(e.attempts, 1, "…but the attempt is a fact on the board");
  assert.match(e.error, /the-facet-is-cursed/);
});

// ─── failure is never load-bearing ───────────────────────────────────────────

test("a provider error on one facet neither throws nor stops the other", async () => {
  const b = await board("boom");
  await seedUnstable(b, "shape");
  await seedUnstable(b, "motif", FULL.motif);
  let n = 0;
  const deps = {
    resolveAi: async () => ({ provider: "openai", apiKey: "sk-test", model: "m" }),
    tagger: async () => {
      if (++n === 1) throw new Error("provider exploded");
      return { input: { verdict: "unclear-definition", explanation: "e", values: [], suggestion: "s" }, usage: null };
    },
  };
  await diagnoseDue(db, deps, null); // must not reject
  const all = await diagnosticsOf(b);
  assert.equal(all.motif.verdict, "unclear-definition", "the second facet still landed");
  assert.equal(all.shape.verdict, undefined, "…and the first recorded its failure rather than a finding");
  assert.equal(all.shape.attempts, 1);
});

test("a board with no usable key is skipped without a stored entry", async () => {
  const b = await board("keyless");
  await seedUnstable(b);
  const deps = { resolveAi: async () => null, tagger: async () => assert.fail("must not call") };
  await diagnoseDue(db, deps, null);
  assert.deepEqual(await diagnosticsOf(b), {});
});

// ─── the rotation ────────────────────────────────────────────────────────────

test("two boards both needing work are served in turn, not one of them twice", async () => {
  // Nothing here creates claimable work, so no row stops matching once it has
  // been served. Without the rotation the first eligible board is re-picked
  // every tick and everything behind it starves — silently, and indefinitely.
  const a = await board("rot-a");
  const c = await board("rot-b");
  await seedUnstable(a);
  await seedUnstable(c);
  const deps = stubTagger();

  const first = await diagnoseDue(db, deps, null);
  const second = await diagnoseDue(db, deps, first.boardId);
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1);
  assert.notEqual(second.boardId, first.boardId, "the second pass served the other board");
  assert.deepEqual(
    [first.boardId, second.boardId].sort(), [a, c].sort(),
    "…and between them they covered both",
  );
});

// ─── the prompt ──────────────────────────────────────────────────────────────

test("the prompt labels both groups and names the escape hatches", () => {
  const segment = { key: "shape", label: "Shape", items: 10, unanimous: 2, d: FULL.shape, scoped: false, stale: 0 };
  const sample = {
    split: [{ value: "wide", split_on: 6 }],
    contested: [{ description: "a wide mark", votes: { round: 2, wide: 1 }, agreed: 2, of: 3 }],
    unanimous: [{ description: "a circle", votes: { round: 3 }, agreed: 3, of: 3 }],
  };
  const { systemText, parts } = buildDiagnosePrompt({ context: "marks" }, BF[0], segment, sample, null);

  assert.match(systemText, /genuinely-ambiguous-items/);
  assert.match(systemText, /no-problem-found/);
  assert.match(systemText, /cannot see the items/i, "it must not reason as though it saw them");
  assert.match(systemText, /do not ask "what is wrong with this facet"/);
  const text = parts[0].text;
  assert.match(text, /ITEMS WHERE THE PASSES DISAGREED/);
  assert.match(text, /ITEMS WHERE THE PASSES AGREED/);
  assert.match(text, /a wide mark/);
  assert.match(text, /a circle/);
});

test("a facet that never converged says so, rather than showing an empty heading", () => {
  const segment = { key: "shape", items: 4, unanimous: 0, d: FULL.shape, scoped: false };
  const sample = {
    split: [],
    contested: [{ description: "x", votes: { round: 2, wide: 1 }, agreed: 2, of: 3 }],
    unanimous: [],
  };
  const { parts } = buildDiagnosePrompt({}, BF[0], segment, sample, null);
  assert.match(parts[0].text, /never once converged/);
});

test("a re-diagnosis after an edit quotes the old wording and the old rate", () => {
  const segment = { key: "shape", items: 10, unanimous: 8, d: FULL.shape, scoped: true };
  const sample = { split: [], contested: [], unanimous: [] };
  const previous = { stats: { items: 10, unanimous: 6 }, description: "the old gloss", d: "x", scoped: false, at: 1 };
  const { parts } = buildDiagnosePrompt({}, BF[0], segment, sample, previous);
  assert.match(parts[0].text, /the old gloss/);
  assert.match(parts[0].text, /6 of\s*10 items were unanimous/);
  assert.match(parts[0].text, /8 of 10 now/);
});

// ─── the demotion ────────────────────────────────────────────────────────────

const finding = (d = FULL.shape) => ({
  verdict: "overlapping-values", explanation: "e", values: ["round"], suggestion: "s",
  stats: { items: 25, unanimous: 15 }, split: ["round"], d, scoped: false, k: "x", at: 1000,
});

test("editedFacets diffs on the definition, not on presence", () => {
  assert.deepEqual(editedFacets(BF, BF), [], "an identical save changes nothing");
  const reordered = [{ ...BF[0], values: ["wide", "round"] }, BF[1]];
  assert.deepEqual(editedFacets(BF, reordered), [], "a value reorder is not a redefinition");
  const edited = [{ ...BF[0], description: "new" }, BF[1]];
  assert.deepEqual(editedFacets(BF, edited), [{ key: "shape", description: "the silhouette" }],
    "…and it carries the wording being REPLACED, for the next prompt to quote");
  const added = [...BF, { key: "new", values: ["a"] }];
  assert.deepEqual(editedFacets(BF, added), [], "a facet that did not exist has nothing to demote");
});

test("a save that does not touch the taxonomy demotes nothing", async () => {
  // The assertion the obvious implementation fails. The board modal sends
  // `facets` on EVERY save, so `facets !== undefined` is not "the taxonomy
  // changed" — it is "someone opened the modal".
  const b = await board("untouched");
  await setFacetDiagnostic(db, b, "shape", finding());
  const admin = await adminSession(db);

  const r = await req(srv.base, "PATCH", `/api/admin/boards/${b}`, {
    sid: admin.sid, body: { name: "renamed", facets: BF, auto_tag: false },
  });
  assert.equal(r.status, 200);

  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.verdict, "overlapping-values", "the finding survived a rename");
  assert.equal(e.previous, undefined);
});

test("editing one facet demotes its finding and leaves its neighbour's alone", async () => {
  const b = await board("demote");
  await setFacetDiagnostic(db, b, "shape", finding());
  await setFacetDiagnostic(db, b, "motif", finding(FULL.motif));
  const admin = await adminSession(db);

  const edited = BF.map((f) => (f.key === "shape" ? { ...f, values: ["round", "wide", "tall"] } : f));
  const r = await req(srv.base, "PATCH", `/api/admin/boards/${b}`, { sid: admin.sid, body: { facets: edited } });
  assert.equal(r.status, 200);

  const all = await diagnosticsOf(b);
  assert.equal(all.shape.verdict, undefined, "the paragraph quoted wording that is gone");
  assert.deepEqual(all.shape.previous.stats, { items: 25, unanimous: 15 }, "…the baseline did not go with it");
  assert.equal(all.shape.previous.description, "the silhouette");
  assert.equal(all.motif.verdict, "overlapping-values", "the untouched facet is untouched");
});

test("a second edit before any re-measurement keeps the older baseline and never nests", async () => {
  const b = await board("twice");
  await setFacetDiagnostic(db, b, "shape", finding());

  await demoteFacetDiagnostics(db, b, [{ key: "shape", description: "first wording" }]);
  await demoteFacetDiagnostics(db, b, [{ key: "shape", description: "second wording" }]);

  const e = (await diagnosticsOf(b)).shape;
  assert.deepEqual(e.previous.stats, { items: 25, unanimous: 15 });
  assert.equal(e.previous.description, "first wording", "the surviving baseline is the measured one");
  assert.equal(e.previous.previous, undefined, "no history grows in a board column");
});

test("the board-manager PATCH demotes too, not just the admin one", async () => {
  const b = await board("manager-patch");
  await setFacetDiagnostic(db, b, "shape", finding());
  const admin = await adminSession(db);
  const edited = BF.map((f) => (f.key === "shape" ? { ...f, description: "moved" } : f));

  const r = await req(srv.base, "PATCH", `/api/boards/${b}`, { sid: admin.sid, body: { facets: edited } });
  assert.equal(r.status, 200);
  assert.equal((await diagnosticsOf(b)).shape.verdict, undefined);
});

// ─── the loop closes ─────────────────────────────────────────────────────────

test("end to end: diagnose, take the advice, re-measure, and the baseline survives", async () => {
  const b = await board("loop");
  await seedUnstable(b);
  const deps = stubTagger();

  // 1. diagnosed
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);
  assert.equal((await diagnosticsOf(b)).shape.verdict, "overlapping-values");

  // 2. the user appends the suggestion and saves
  const admin = await adminSession(db);
  const edited = BF.map((f) => (f.key === "shape" ? { ...f, description: "the silhouette. prefer wide when both read true" } : f));
  await req(srv.base, "PATCH", `/api/admin/boards/${b}`, { sid: admin.sid, body: { facets: edited } });

  // 3. …and the next pass spends NOTHING, because nothing has been re-measured
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1, "no call is spent on a facet awaiting re-measurement");
  assert.deepEqual((await diagnosticsOf(b)).shape.previous.stats, { items: 21, unanimous: 4 });

  // 4. a scoped retag of that one facet lands, and this time it mostly agrees
  await db.query("DELETE FROM items WHERE board_id=$1", [b]);
  const scopedStamp = facetStamp(edited[0], true);
  await seedUnstable(b, "shape", scopedStamp, { contested: 4, clean: 17 });

  // 5. now it re-diagnoses — and the prompt carries the old wording and rate
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2, "a real re-measurement is worth a call");
  const sent = deps.calls[1].parts[0].text;
  assert.match(sent, /the silhouette/, "the model is told what the wording used to be");
  assert.match(sent, /4 of\s*21 items were unanimous/, "…and what the rate used to be");

  const e = (await diagnosticsOf(b)).shape;
  assert.deepEqual(e.stats, { items: 21, unanimous: 17 }, "19% unanimous -> 81%, which is the whole point");
  assert.equal(e.scoped, true);
  assert.deepEqual(e.previous.stats, { items: 21, unanimous: 4 }, "the baseline survived the re-diagnosis");
});

// ─── the loop actually runs ──────────────────────────────────────────────────

test("startWorker's diagnose loop reaches a real board through the real tagger", async () => {
  // Every other test in this file calls diagnoseDue directly. That leaves the
  // wiring — the loop being started at all, its deps closure, resolveBoardAi and
  // trackedTagger — with no coverage whatsoever: cut the loop out of startWorker
  // and this file still passes in full.
  process.env.DIAGNOSE_POLL_MS = "50";
  const b = await board("loop-wiring");
  await seedUnstable(b);

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: {
        name: body.tools?.[0]?.function?.name,
        arguments: JSON.stringify({
          verdict: "unclear-definition", explanation: "round and wide are not pinned down",
          values: ["round", "wide"], suggestion: "prefer wide for lockups",
        }),
      } }] } }],
      usage: { prompt_tokens: 900, completion_tokens: 120 },
    }), { status: 200 });
  };
  const stop = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
  try {
    await until(async () => (await diagnosticsOf(b))?.shape?.verdict === "unclear-definition");
  } finally {
    await stop();
    global.fetch = realFetch;
    delete process.env.DIAGNOSE_POLL_MS;
  }

  assert.equal(calls[0].tools[0].function.name, "record_diagnosis", "the real tagger carried the diagnosis tool");
  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.suggestion, "prefer wide for lockups");

  // Billed through the same ledger as any other call, in the shape bumpUsage
  // actually reads — asserting only `count` would pass with the tokens at zero.
  const [usage] = (await db.query("SELECT count, input_tokens, output_tokens FROM ai_board_usage WHERE board_id=$1", [b])).rows;
  assert.equal(usage.count, 1);
  assert.equal(Number(usage.input_tokens), 900);
  assert.equal(Number(usage.output_tokens), 120);
});

// ─── a failed diagnosis must not become a standing order ─────────────────────

test("a provider error is recorded, retried a bounded number of times, then left alone", async () => {
  // Nothing about a failure changes the gates: the items are still there, still
  // unstable, still measured under the same stamp. Without a recorded attempt
  // the next tick asks again — a paid call every DIAGNOSE_POLL_MS for as long as
  // the provider stays unwell, which on the shipped 60s cadence is 1,440 calls
  // per facet per day.
  const b = await board("retry-cap");
  await seedUnstable(b);
  let n = 0;
  const deps = {
    resolveAi: async () => ({ provider: "openai", apiKey: "sk-test", model: "m" }),
    tagger: async () => { n++; throw new Error("provider exploded"); },
  };

  for (let i = 0; i < 6; i++) await diagnoseDue(db, deps, null);
  assert.equal(n, 3, "three tries, then it stops asking");

  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.attempts, 3);
  assert.match(e.error, /provider exploded/);
  assert.equal(e.verdict, undefined, "a failure is not a finding");
});

test("an unusable verdict is recorded as an attempt — it cost money either way", async () => {
  const b = await board("retry-garbage");
  await seedUnstable(b);
  const deps = stubTagger({ verdict: "the-facet-is-cursed" });
  for (let i = 0; i < 6; i++) await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 3);
  assert.equal((await diagnosticsOf(b)).shape.verdict, undefined);
});

test("attempts reset when the measurements actually move", async () => {
  // The cap is on one unchanged set of numbers, not on the facet. A board that
  // gets re-tagged deserves a fresh look even if the last three tries failed.
  const b = await board("retry-reset");
  await seedUnstable(b);
  let fail = true;
  const seen = [];
  const deps = {
    resolveAi: async () => ({ provider: "openai", apiKey: "sk-test", model: "m" }),
    tagger: async () => {
      seen.push(1);
      if (fail) throw new Error("nope");
      return { input: { verdict: "unclear-definition", explanation: "e", values: [], suggestion: "s" }, usage: null };
    },
  };
  for (let i = 0; i < 5; i++) await diagnoseDue(db, deps, null);
  assert.equal(seen.length, 3, "capped");

  fail = false;
  for (let i = 0; i < 8; i++) {
    await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });
  }
  await diagnoseDue(db, deps, null);
  assert.equal(seen.length, 4, "new numbers, fresh slate");
  assert.equal((await diagnosticsOf(b)).shape.verdict, "unclear-definition");
});

test("a recorded failure keeps the baseline it inherited", async () => {
  // Otherwise a provider outage between an edit and a successful re-diagnosis
  // silently destroys the only evidence the user's edit did anything.
  const b = await board("retry-baseline");
  await seedUnstable(b);
  await setFacetDiagnostic(db, b, "shape", {
    ...finding(), previous: { stats: { items: 30, unanimous: 10 }, description: "old wording", scoped: false, at: 1 },
  });
  const deps = {
    resolveAi: async () => ({ provider: "openai", apiKey: "sk-test", model: "m" }),
    tagger: async () => { throw new Error("down"); },
  };
  await diagnoseDue(db, deps, null);

  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.attempts, 1);
  assert.deepEqual(e.previous.stats, { items: 30, unanimous: 10 }, "the baseline survived the outage");
});

test("…and it keeps the stats that are the NEXT baseline, not only the last one", async () => {
  // The other order, and the one the first sweep missed. There is no `previous`
  // yet — the user has not edited anything. The stats on the live entry are what
  // demoteFacetDiagnostics moves into `previous` when they finally do, and it
  // skips any entry that has none. So: diagnose, let the measurements move (a
  // scheduled retag is enough), fail one call, then take the advice — and
  // without this the edit demotes nothing, `previous` never exists, and the
  // "was 60%, now 88%" the whole feature is pointed at can never render on the
  // one facet the loop just told the user to fix.
  const b = await board("retry-stats");
  await seedUnstable(b);
  await diagnoseDue(db, stubTagger(), null);
  assert.deepEqual((await diagnosticsOf(b)).shape.stats, { items: 21, unanimous: 4 });

  // The numbers move, so the next tick is a fresh freshness key and calls again.
  for (let i = 0; i < 6; i++) {
    await item(b, { confidence: { shape: conf(FULL.shape, 3, 1, { round: 1, wide: 2 }) }, description: `more ${i}` });
  }
  await diagnoseDue(db, {
    resolveAi: async () => ({ provider: "openai", apiKey: "sk-test", model: "m" }),
    tagger: async () => { throw new Error("down"); },
  }, null);
  const failed = (await diagnosticsOf(b)).shape;
  assert.equal(failed.attempts, 1);
  assert.equal(failed.verdict, undefined, "a failure is still not a finding");
  assert.deepEqual(failed.stats, { items: 21, unanimous: 4 }, "…but the measured baseline is still there");

  // Now the user takes the advice.
  const admin = await adminSession(db);
  const edited = BF.map((f) => (f.key === "shape" ? { ...f, description: "the silhouette; prefer wide" } : f));
  const r = await req(srv.base, "PATCH", `/api/boards/${b}`, { sid: admin.sid, body: { facets: edited } });
  assert.equal(r.status, 200);

  const after = (await diagnosticsOf(b)).shape;
  assert.deepEqual(after.previous.stats, { items: 21, unanimous: 4 }, "the edit had something to demote");
  assert.equal(after.previous.description, "the silhouette");
});
