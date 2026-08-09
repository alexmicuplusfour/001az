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
  updateBoard, getBoard, setFacetDiagnostic, demoteFacetDiagnostics, supersedeFacetDiagnostics,
  retagBoard, boardTagActivity,
} from "../server/db.js";
import { facetStamp, editedFacets, diagnoseDue, buildDiagnosePrompt, facetRollup } from "../server/facet-diagnosis.js";
import { startWorker } from "../server/worker.js";

// The gates are read at module load, which ESM hoists above anything this file
// could set — so these run against the SHIPPED defaults (20 items, 30%, a
// three-minute settle) rather than against convenient ones. Fixtures are sized to
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
// to exercise the window passes `at: Date.now()`. `payload` is what retagBoard
// routes on — `extracted_at` sends a retag straight to tagging, `mapping` sends
// it through the extract leg — so a test can pick which queue state it lands in.
async function item(boardId, { confidence, status = "tagged", description = "a mark", at = 0, payload = {} }) {
  const eid = await createEntity(db, boardId, { identity: `d${++seq}` });
  const id = await insertItem(db, boardId, { identity: `d${seq}`, files: [], fields: {}, ...payload }, "pending", eid);
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
          rewrite: "The silhouette. When a mark reads both round and wide, prefer wide.",
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
  assert.equal(e.rewrite, "The silhouette. When a mark reads both round and wide, prefer wide.");
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
  // Just under, so this pins the floor rather than passing at any floor above a
  // token rate: 7 of 25 is 28%.
  await seedUnstable(b, "shape", FULL.shape, { contested: 7, clean: 18 });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 0, "28% is under the 30% floor");
});

test("…and one more contested item is enough to clear it", async () => {
  // The other side of the same boundary. Apart, these two would both survive a
  // floor set anywhere between them; together they fix it at 30%.
  const b = await board("just-over");
  await seedUnstable(b, "shape", FULL.shape, { contested: 8, clean: 17 });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1, "32% clears it");
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

test("a trickle of new items does NOT re-diagnose", async () => {
  // Rule one, from the other side. A finding is a claim about the TAXONOMY —
  // "these two values overlap, here is wording that separates them" — and 20
  // more logos arriving does not refute it. The explanation was reasoned from
  // twelve specific items, none of which the new arrivals displace, and the
  // rate stays in the same bucket. Nothing about it has become untrue, so
  // nothing is re-asked.
  //
  // Seeded proportionally rather than at the real 2,500: 100 items with 20
  // arriving makes the twenty a fifth of the sample instead of under a percent.
  const b = await board("trickle");
  await seedUnstable(b, "shape", FULL.shape, { contested: 40, clean: 60 });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);

  for (let i = 0; i < 8; i++) {
    await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) }, description: `new contested ${i}` });
  }
  for (let i = 0; i < 12; i++) {
    await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) }, description: `new clean ${i}` });
  }
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1, "same claim, same evidence, same rate — nothing to ask");
});

test("…but growth that moves the rate does re-diagnose", async () => {
  // Rule two. The paragraph survives arrivals; the HEADLINE does not. A facet
  // that read 40% inconsistent and now reads 12% cannot keep a sentence that
  // says 40%, whatever the explanation still gets right.
  const b = await board("grown");
  await seedUnstable(b, "shape", FULL.shape, { contested: 40, clean: 60 });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);

  // 25 clean arrivals: 40 contested of 125 is 32%, a different bucket from 40%
  // and still over the instability floor. Overshooting the floor instead would
  // test gate 4 — a facet that has become healthy is dropped before any of this
  // is consulted — which is a different (and also correct) reason not to ask.
  for (let i = 0; i < 25; i++) {
    await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) }, description: `clean arrival ${i}` });
  }
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2, "40% then 32% is not the same finding");
});

test("a re-measurement of the evidence items re-diagnoses", async () => {
  // Rule one, the case it exists for. Nothing is added or removed — the twelve
  // items the model reasoned from are re-tagged in place, so the reasoning is
  // about data that is gone.
  const b = await board("remeasured");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);
  const evidence = (await diagnosticsOf(b)).shape.evidence;
  assert.ok(evidence.length > 0, "the finding records what it was reasoned from");

  // Flip the agreement on the items it read, and only those.
  await db.query(
    `UPDATE items SET tag_confidence = jsonb_set(tag_confidence, '{shape}', $2::jsonb)
     WHERE id = ANY($1::bigint[])`,
    [evidence, JSON.stringify(conf(FULL.shape, 3, 1, { round: 1, wide: 1, tall: 1 }))]
  );
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2, "the twelve it read are not the twelve that are there");
});

test("arming a retag supersedes the finding immediately, before an item lands", async () => {
  // Invalidate-on-write. The retag route is the one place that knows for certain
  // the measurements are about to move, and it knows it a pass EARLIER than any
  // comparison of numbers can: at arming time nothing has landed, so the counts
  // still match and every read-side check would call the finding current.
  const b = await board("armed");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal((await diagnosticsOf(b)).shape.verdict, "overlapping-values");

  const admin = await adminSession(db);
  const r = await req(srv.base, "POST", `/api/admin/boards/${b}/retag`, { sid: admin.sid, body: { facets: ["shape"] } });
  assert.equal(r.status, 200);

  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.stale, true, "marked at arming, not inferred later");
  assert.ok(e.stats, "…and the baseline a later edit demotes survives it");
  assert.equal(e.verdict, "overlapping-values", "…as does the sentence the reader sees while it waits");

  const row = (await facetRollup(db, await getBoard(db, b))).find((f) => f.key === "shape");
  assert.equal(row.current, false, "the reader hides it on the flag alone");
});

test("a retag that misses the twelve leaves the finding alone", async () => {
  // The report this was built for: five items retagged on a board of 2,500, and
  // three findings marked stale. The question at arming is about ROWS — does
  // this retag touch any of the items the explanation was reasoned from — and
  // for five items picked from thousands the answer is almost always no.
  const b = await board("misses");
  await seedUnstable(b, "shape", FULL.shape, { contested: 40, clean: 60 });
  await diagnoseDue(db, stubTagger(), null);
  const evidence = (await diagnosticsOf(b)).shape.evidence;
  assert.ok(evidence.length, "the finding recorded what it read");

  // Arm five items that are NOT among them, exactly as a retag would.
  const { rows } = await db.query(
    `UPDATE items SET status='pending', updated_at=$2
     WHERE id IN (SELECT id FROM items WHERE board_id=$1 AND NOT (id = ANY($3::bigint[])) LIMIT 5)
     RETURNING id`,
    [b, Date.now(), evidence]
  );
  assert.equal(rows.length, 5);
  const hit = await supersedeFacetDiagnostics(db, b, null);
  assert.deepEqual(hit, [], "nothing it reasoned from was touched");
  assert.equal((await diagnosticsOf(b)).shape.stale, undefined);
});

test("a scoped retag supersedes only the facets it names", async () => {
  // scopeResult leaves the other facets' confidence entirely intact, so their
  // findings are still answers to the sample that is still there.
  const b = await board("armed-scoped");
  await seedUnstable(b);
  for (let i = 0; i < MIN_ITEMS + 1; i++) {
    await item(b, { confidence: { motif: conf(FULL.motif, 3, 1, { star: 1, leaf: 2 }) } });
  }
  await setFacetDiagnostic(db, b, "motif", { verdict: "unclear-definition", explanation: "e", rewrite: "r", stats: { items: 21, unanimous: 0 }, d: FULL.motif, scoped: false, k: "x", at: 1 });
  await diagnoseDue(db, stubTagger(), null);

  const admin = await adminSession(db);
  await req(srv.base, "POST", `/api/admin/boards/${b}/retag`, { sid: admin.sid, body: { facets: ["shape"] } });

  const all = await diagnosticsOf(b);
  assert.equal(all.shape.stale, true);
  assert.equal(all.motif.stale, undefined, "nothing is re-measuring motif");
});

// Was "the blind spot: a re-measurement that reproduces the counts exactly is
// missed", and it stayed one after the key gained an evidence term, because that
// term held the twelve items' IDS. The ordering keys on `agreed/of` and ties
// break on `i.id`, so preserving every ratio pins the same eight rows in the same
// slots — on a three-vote board the ratio takes three values, so ties are dense
// and those slots belong to the oldest rows more or less permanently.
//
// Demonstrated before it was fixed: same key `v3|557d0f9dd609|80|1,2,…,21`, and
// the model would have been shown "a broad angular slab, nothing rounded about
// it" where it had read "a rounded wordmark".
test("a re-measurement that reproduces the counts is caught by what the twelve SAY", async () => {
  const b = await board("re-measured");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);

  // A full retag lands: the tension inverts and the tagger re-describes every
  // item. Every agreed/of is preserved, so the rate, the ordering and the id list
  // are all untouched — nothing a summary or an identity could see.
  await db.query(
    `UPDATE items SET
       tag_confidence = jsonb_set(tag_confidence, '{shape,votes}', '{"round":1,"wide":2}'::jsonb),
       tag_reasoning  = jsonb_build_object('description', 'a broad angular slab')
     WHERE board_id=$1 AND (tag_confidence->'shape'->>'agreed')::int < (tag_confidence->'shape'->>'of')::int`,
    [b]
  );
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2, "the examples say something else, so it is a different question");

  // And it is the CONTENT, not the churn: re-running the same write changes
  // nothing, so the third tick spends nothing.
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2);
});

test("…but a change that reaches none of the twelve, at an unmoved rate, is still not caught", async () => {
  // The residual, pinned rather than left to be rediscovered. The key holds what
  // the prompt SHOWS: the rate to five points, and the twelve worked examples.
  // The "where they parted" line summarises every contested item on the board and
  // is deliberately absent — its counts move on a retag of any size, which is the
  // one thing rule 1 exists to prevent.
  //
  // seedUnstable's contested rows take the lowest ids, so the eight shown are the
  // first eight; anything past them is outside the sample the finding was
  // reasoned from, and re-measuring it is invisible here by design.
  const b = await board("outside");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  const shown = (await diagnosticsOf(b)).shape.evidence;
  assert.equal(shown.length, 12, "eight contested and four unanimous");

  const { rowCount } = await db.query(
    `UPDATE items SET tag_confidence = jsonb_set(tag_confidence, '{shape,votes}', '{"round":1,"wide":2}'::jsonb)
     WHERE board_id=$1 AND NOT (id = ANY($2::bigint[]))
       AND (tag_confidence->'shape'->>'agreed')::int < (tag_confidence->'shape'->>'of')::int`,
    [b, shown]
  );
  assert.ok(rowCount > 0, "there are contested items outside the twelve");
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1, "nothing the model would be shown has changed");
});

test("one uploaded image does not clear a diagnosis (a tolerance, not a bucket)", async () => {
  // Reported from the running app, and reproduced from its numbers. `ui` was at
  // 93 items / 59 unanimous; two images arrived, one at a time:
  //
  //   93/59  36.56%   bucket 35
  //   96/60  37.50%   bucket 40   <- re-diagnosed
  //   97/61  37.11%   bucket 35   <- re-diagnosed again, back to the first key
  //
  // 0.55 points of real movement and two paid calls, because 37.5 sits exactly on
  // a boundary and Math.round takes it up. A bucket answers "which side of an
  // arbitrary line", not "how far did it move" — so two rates 0.9 points apart
  // differ while two 4.9 points apart match. On a 97-item sample one item moves
  // the rate about a point, so roughly one upload in five crossed a line.
  const b = await board("one-upload");
  for (let i = 0; i < 34; i++) await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) }, description: `c${i}` });
  for (let i = 0; i < 59; i++) await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) }, description: `u${i}` });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);
  assert.deepEqual((await diagnosticsOf(b)).shape.stats, { items: 93, unanimous: 59 });

  // The images land in two batches with a settled tick between them, which is the
  // part that matters: the board PASSES THROUGH 96/60, and jumping straight to
  // 97/61 would miss it entirely — both ends bucket to 35 and only the middle
  // crosses.
  const land = async (contested, unanimous, tag) => {
    for (let i = 0; i < contested; i++) await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) }, description: `${tag} c${i}` });
    for (let i = 0; i < unanimous; i++) await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) }, description: `${tag} u${i}` });
    const r = (await facetRollup(db, await getBoard(db, b))).find((f) => f.key === "shape");
    await diagnoseDue(db, deps, null);
    return r;
  };

  const mid = await land(2, 1, "batch1");
  assert.deepEqual([mid.items, mid.unanimous], [96, 60], "37.50% — the boundary");
  assert.equal(deps.calls.length, 1, "0.94 points is not a different question");
  assert.equal(mid.current, true, "…and the reader keeps showing the finding");

  const end = await land(0, 1, "batch2");
  assert.deepEqual([end.items, end.unanimous], [97, 61], "37.11% — where the live board ended up");
  assert.equal(deps.calls.length, 1, "still the same question, 0.55 points from where it started");
  assert.equal(end.current, true);
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

// The retag drains and every count reproduces exactly — the blind spot above,
// which is what makes the arming hook the only thing standing between these two
// tests and a finding that never expires.
const landUnchanged = (b) =>
  db.query("UPDATE items SET status='tagged', tag_facets=NULL, updated_at=0 WHERE board_id=$1", [b]);

test("a retag armed DURING the provider call survives that call's own write", async () => {
  // diagnoseDue reads facet_diagnostics once at the top of a pass and diagnoses
  // every facet against that snapshot, sequentially, with a provider call apiece
  // — so the gap between the read and the write is the whole pass, not one call.
  // A plain merge writes an entry with no `stale` over a mark armed inside it,
  // and the entry's freshness key was computed before the retag existed. Land the
  // re-measurement on the same counts and nothing ever re-asks: the hook is gone
  // and the key was blind to this case by design.
  const b = await board("mid-call");
  await seedUnstable(b);
  await diagnoseDue(db, stubTagger(), null);
  assert.equal((await diagnosticsOf(b)).shape.verdict, "overlapping-values");
  for (let i = 0; i < 4; i++) await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });

  const deps = stubTagger();
  const inner = deps.tagger;
  let hit;
  deps.tagger = async (args) => {
    await retagBoard(db, b);                                  // the user clicks retag
    hit = await supersedeFacetDiagnostics(db, b, null);        // …mid-flight
    return inner(args);
  };
  await diagnoseDue(db, deps, null);
  assert.deepEqual(hit, ["shape"], "the retag did mark it");
  assert.equal((await diagnosticsOf(b)).shape.stale, true, "and the pass did not erase the mark it never read");

  await landUnchanged(b);
  const next = stubTagger();
  await diagnoseDue(db, next, null);
  assert.equal(next.calls.length, 1, "so the re-measurement is re-read, counts identical or not");
});

test("…but a pass that ANSWERS a stale mark still clears it", async () => {
  // The other direction, and what a blanket "always preserve" would break: a
  // superseded finding that has just been re-diagnosed is current again, and
  // leaving the flag on renders "re-reading this facet" over a paragraph written
  // a moment ago, for good.
  const b = await board("clears");
  await seedUnstable(b);
  await diagnoseDue(db, stubTagger(), null);
  await retagBoard(db, b);
  assert.deepEqual(await supersedeFacetDiagnostics(db, b, null), ["shape"]);
  await landUnchanged(b);

  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1, "the mark is what makes it re-ask over unmoved counts");
  assert.equal((await diagnosticsOf(b)).shape.stale, undefined, "and the answer retires it");
});

test("a recorded failure never clears a stale mark either", async () => {
  // attempted() rebuilds the entry from scratch, so it dropped `stale` with
  // everything else it did not name — and a provider blip between a retag and its
  // re-diagnosis is the one moment that flag is load-bearing.
  const b = await board("fail-stale");
  await seedUnstable(b);
  await diagnoseDue(db, stubTagger(), null);
  await retagBoard(db, b);
  await supersedeFacetDiagnostics(db, b, null);
  await landUnchanged(b);

  const deps = stubTagger();
  deps.tagger = async () => { throw new Error("provider 503"); };
  await diagnoseDue(db, deps, null);
  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.attempts, 1, "the attempt is recorded, as defect 1 requires");
  assert.equal(e.stale, true, "…and the mark outlives it, because nothing was answered");
});

test("…and MAX_ATTEMPTS still bounds a SUPERSEDED finding", async () => {
  // The other half of the test above, and the reason it needs one. The cap used
  // to hold on this path only because attempted() rebuilt the entry without
  // `stale` — a failure silently retracting a fact about the data, which is what
  // let the skip check short-circuit on the flag and still terminate. Guard the
  // flag properly and that accident goes with it: `stale` is permanent until
  // something answers it, so a flag-first skip check never caps and the loop pays
  // every tick, for as long as the provider is unwell. 1,440 calls a facet a day
  // — defect 1's own number, reached by fixing defect 39.
  //
  // So the cap is asked FIRST and unconditionally, and the two facts stay
  // independent: money spent against an unchanged question, and whether the data
  // moved.
  const b = await board("cap-stale");
  await seedUnstable(b);
  await diagnoseDue(db, stubTagger(), null);
  await retagBoard(db, b);
  await supersedeFacetDiagnostics(db, b, null);
  await landUnchanged(b); // counts reproduce exactly — `stale` is the ONLY reason it re-asks

  let paid = 0;
  const deps = stubTagger();
  deps.tagger = async () => { paid++; throw new Error("provider 503"); };
  for (let i = 0; i < 8; i++) await diagnoseDue(db, deps, null);

  assert.equal(paid, 3, "three tries, then silence — the WEBHOOK_MAX_ATTEMPTS precedent");
  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.attempts, 3);
  assert.equal(e.stale, true, "the flag is still true; it is simply not what bounds the spending");

  // And the cap is per QUESTION, not permanent: move the data and it re-asks.
  for (let i = 0; i < 8; i++) await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });
  await diagnoseDue(db, deps, null);
  assert.equal(paid, 4, "a moved rate is a new question and earns a clean slate");
});

test("a retag is a retag on a MAPPED board too — all four queue states count", async () => {
  // retagBoard routes items by payload rather than queueing them uniformly: one
  // carrying a `mapping` it has not been extracted under enters 'pending_extract',
  // a connector vehicle with no rendered file enters 'pending_face'. So on a
  // mapped or connector board a full retag produces no 'pending' row at all.
  //
  // Three diagnosis queries read `IN ('pending','processing')` and every one was
  // therefore wrong on that whole class of board, in the same direction and
  // silently: the arming hook found nothing queued and left every finding
  // standing, the settle gate called the board quiet mid-sweep, and the roll-up
  // reported nothing in flight — which is what put "Not measured against the
  // current wording yet. Re-tag this board" over a board being re-tagged as the
  // user read it. The route logged "retag queued: 21 item(s)" throughout.
  //
  // Asserted as PARITY between the two shapes rather than against fixed numbers:
  // the routing is retagBoard's business and may grow another leg, and the claim
  // that matters is that diagnosis cannot tell the legs apart.
  const shape = async (payload) => {
    const b = await board(`routed-${Object.keys(payload)[0]}`);
    for (let i = 0; i < 17; i++) {
      await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) }, description: `c${i}`, payload });
    }
    for (let i = 0; i < 4; i++) {
      await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) }, description: `u${i}`, payload });
    }
    await diagnoseDue(db, stubTagger(), null);
    assert.equal((await diagnosticsOf(b)).shape.verdict, "overlapping-values");

    await retagBoard(db, b);
    const statuses = (await db.query("SELECT DISTINCT status FROM items WHERE board_id=$1", [b])).rows.map((r) => r.status);
    const hit = await supersedeFacetDiagnostics(db, b, null);
    const row = (await facetRollup(db, await getBoard(db, b))).find((f) => f.key === "shape");
    return { statuses, hit, busy: (await boardTagActivity(db, b)).busy, queued: row.queued, current: row.current };
  };

  const plain = await shape({ extracted_at: 1 });
  const mapped = await shape({ mapping: { input: {} } });

  assert.deepEqual(plain.statuses, ["pending"], "the plain board queues straight to tagging");
  assert.deepEqual(mapped.statuses, ["pending_extract"], "the mapped one goes through the extract leg");
  assert.deepEqual(mapped.hit, plain.hit, "the hook fires the same on both");
  assert.equal(mapped.hit.length, 1);
  assert.equal(mapped.busy, plain.busy, "and the settle gate holds the same");
  assert.ok(mapped.busy > 0);
  assert.equal(mapped.queued, plain.queued, "and the reader is told the same thing is in flight");
  assert.ok(mapped.queued > 0, "which is what turns 'go re-tag this' into 'this is re-tagging'");
  assert.equal(mapped.current, false);
});

test("…and every one of the six in-flight states counts, claimed ones included", async () => {
  // Three legs, each with a state the item WAITS in and a state the worker claims
  // it INTO — six, not the four the first pass at this named. Missing 'extracting'
  // and 'facing' is the same defect one level down: a board whose queue has just
  // been picked up reads quiet, and an evidence item being extracted right now
  // reads untouched.
  //
  // Driven off the list rather than off two hand-picked examples, because that is
  // exactly how the first version came to name a subset and look complete.
  const STATES = ["pending", "processing", "pending_extract", "extracting", "pending_face", "facing"];
  for (const status of STATES) {
    const b = await board(`state-${status}`);
    await seedUnstable(b);
    await diagnoseDue(db, stubTagger(), null);
    const evidence = (await diagnosticsOf(b)).shape.evidence;
    assert.ok(evidence.length, `${status}: a finding to supersede`);

    await db.query("UPDATE items SET status=$2 WHERE board_id=$1", [b, status]);
    assert.deepEqual(await supersedeFacetDiagnostics(db, b, null), ["shape"], `${status}: the hook fires`);
    assert.ok((await boardTagActivity(db, b)).busy > 0, `${status}: the settle gate holds`);
    const row = (await facetRollup(db, await getBoard(db, b))).find((f) => f.key === "shape");
    assert.ok(row.queued > 0, `${status}: the reader is told a pass is running`);
  }

  // The parked states are the other half of the claim and must NOT count: a held
  // or failed row is not coming back on its own, so treating it as in flight
  // would hold the settle gate open for good.
  for (const status of ["held", "failed"]) {
    const b = await board(`parked-${status}`);
    await seedUnstable(b);
    await diagnoseDue(db, stubTagger(), null);
    await db.query("UPDATE items SET status=$2 WHERE board_id=$1", [b, status]);
    assert.deepEqual(await supersedeFacetDiagnostics(db, b, null), [], `${status}: nothing is re-measuring`);
    assert.equal((await boardTagActivity(db, b)).busy, 0, `${status}: the board is quiet`);
  }
});

// ─── MAX_FACETS is a priority, not a truncation ─────────────────────────────

// Eleven facets at eleven different instability rates over one set of items:
// facet i is contested on the first 10+i of 30, so f0 sits at 33% and f10 at
// 67%, every one of them clear of both gates.
const ELEVEN = Array.from({ length: 11 }, (_, i) => ({
  key: `f${i}`, label: `F${i}`, single: true, description: `the f${i}`, values: ["round", "wide"],
}));
async function seedLadder(b) {
  for (let j = 0; j < 30; j++) {
    const c = {};
    for (let i = 0; i < ELEVEN.length; i++) {
      c[`f${i}`] = j < 10 + i
        ? conf(facetStamp(ELEVEN[i], false), 3, 2, { round: 2, wide: 1 })
        : conf(facetStamp(ELEVEN[i], false), 3, 3, { round: 3 });
    }
    await item(b, { confidence: c, description: `mark ${j}` });
  }
}
const diagnosed = async (b) => Object.keys(await diagnosticsOf(b)).sort();

test("over the facet bound, the WORST ten are diagnosed rather than the first ten", async () => {
  // The bound is right (§4: a fleet of newly vote-enabled boards must not fan out
  // into a burst) but it used to be applied by walking board order and breaking
  // at ten, so the tail was not diagnosed later — it was never diagnosed, the
  // bound being re-applied identically every tick.
  const b = await board("priority", { facets: ELEVEN });
  await seedLadder(b);
  await diagnoseDue(db, stubTagger(), null);
  assert.deepEqual(await diagnosed(b), ["f1", "f10", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"],
    "f0, the least unstable, is the one left out");
});

test("…and a superseded finding outranks severity, because the reader promised it", async () => {
  // The sharper half. A facet past the bound whose finding has been superseded
  // renders "The measurements have changed. Re-reading this facet." — and under
  // the old truncation nothing was ever coming, so that sentence stood for good.
  // Measured before the fix: zero calls naming the eleventh facet across ten
  // ticks, `stale` still true.
  //
  // f0 is the LEAST unstable facet, so severity alone would keep it last for
  // ever; the mark is what pulls it to the front.
  const b = await board("stale-first", { facets: ELEVEN });
  await seedLadder(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.ok(!(await diagnosticsOf(b)).f0, "f0 starts out past the bound");

  await setFacetDiagnostic(db, b, "f0", {
    verdict: "overlapping-values", explanation: "e", values: [], rewrite: "r",
    stats: { items: 30, unanimous: 20 }, evidence: [], d: facetStamp(ELEVEN[0], false),
    scoped: false, k: "old", at: Date.now(),
  });
  // Scoped, so f0 is the ONLY facet with a mark outstanding — which is what
  // isolates the claim. Severity alone would keep the least unstable facet last
  // for ever; the mark is what pulls it to the front.
  await retagBoard(db, b);
  assert.deepEqual(await supersedeFacetDiagnostics(db, b, ["f0"]), ["f0"]);
  await landUnchanged(b);

  const before = deps.calls.length;
  await diagnoseDue(db, deps, null);
  assert.ok(deps.calls.slice(before).some((c) => c.systemText.includes("key: f0\n")), "f0 is re-read on the next tick");
  assert.equal((await diagnosticsOf(b)).f0.stale, undefined, "and the mark retires");
});

test("…and when a full retag marks ALL of them, the tail waits one tick, not for ever", async () => {
  // The realistic path, and the one that shows the bound is now a queue rather
  // than a wall: eleven marks, ten served this tick, the eleventh first in line
  // on the next because the ten it was behind stopped being stale as they landed.
  const b = await board("all-stale", { facets: ELEVEN });
  await seedLadder(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);

  await setFacetDiagnostic(db, b, "f0", {
    verdict: "overlapping-values", explanation: "e", values: [], rewrite: "r",
    stats: { items: 30, unanimous: 20 }, evidence: [], d: facetStamp(ELEVEN[0], false),
    scoped: false, k: "old", at: Date.now(),
  });
  await retagBoard(db, b);
  assert.equal((await supersedeFacetDiagnostics(db, b, null)).length, 11, "every finding is superseded");
  await landUnchanged(b);

  const saw = (from) => deps.calls.slice(from).some((c) => c.systemText.includes("key: f0\n"));
  let at = deps.calls.length;
  await diagnoseDue(db, deps, null);
  assert.equal(saw(at), false, "tick one goes to the ten worst, all of them equally stale");
  at = deps.calls.length;
  await diagnoseDue(db, deps, null);
  assert.equal(saw(at), true, "tick two is f0's, alone at the front");
  assert.equal((await diagnosticsOf(b)).f0.stale, undefined);
});

// ─── the escape hatches ──────────────────────────────────────────────────────

test("no-problem-found stores, and stores without a rewrite", async () => {
  // It has to store, or staleness never records and every tick re-calls. And the
  // rewrite is forced empty rather than trusted: a model that has just said
  // nothing is wrong must not also hand the UI wording to paste in.
  const b = await board("no-problem");
  await seedUnstable(b);
  const deps = stubTagger({ verdict: "no-problem-found", rewrite: "some replacement anyway" });
  await diagnoseDue(db, deps, null);

  const e = (await diagnosticsOf(b)).shape;
  assert.equal(e.verdict, "no-problem-found");
  assert.equal(e.rewrite, "");
});

test("genuinely-ambiguous-items likewise carries no rewrite", async () => {
  const b = await board("ambiguous");
  await seedUnstable(b);
  const deps = stubTagger({ verdict: "genuinely-ambiguous-items", rewrite: "split the facet" });
  await diagnoseDue(db, deps, null);
  assert.equal((await diagnosticsOf(b)).shape.rewrite, "");
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
      return { input: { verdict: "unclear-definition", explanation: "e", values: [], rewrite: "s" }, usage: null };
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

test("a multi-value facet is never asked for a precedence rule", async () => {
  // Reported from the running app. The prompt states the arity in one line and
  // then, unconditionally, asked for "a precedence rule … e.g. prefer
  // gradient-blend" — single-value advice. On `construction`, which takes any
  // number of values, the model did as it was told and proposed "if both could
  // apply, prefer gradient-blend", i.e. instructed the tagger to discard a value
  // that was really present.
  //
  // The reason this cannot be left to be caught downstream: taking that advice
  // LOWERS recall and RAISES agreement, because a facet with fewer values in
  // play has fewer ways to disagree with itself. This feature would score the
  // damage as a success and print "63% consistent before, 81% now" over it.
  const segment = { key: "shape", label: "Shape", items: 10, unanimous: 2, d: FULL.shape, scoped: false, stale: 0 };
  const sample = { split: [], contested: [], unanimous: [] };
  const prompt = (facet) => buildDiagnosePrompt({ context: "marks" }, facet, segment, sample, null).systemText;

  const multi = prompt({ key: "construction", label: "Construction", values: ["a", "b"], description: "how it is built" });
  // Not "the words never appear" — the branch names the instrument in order to
  // forbid it. What must not appear is the ASK.
  assert.doesNotMatch(multi, /carry a PRECEDENCE RULE/, "never solicited here");
  assert.match(multi, /precedence rule is the wrong instrument/, "…and it is told why, not merely left uninstructed");
  assert.match(multi, /tagging BOTH\s+is the correct answer/, "two at once is the expected outcome, not a conflict");
  assert.match(multi, /THRESHOLD for each value on its own/, "…which is what is actually unsettled");

  const single = prompt({ ...BF[0], single: true });
  assert.match(single, /carry a PRECEDENCE RULE/, "where exactly one value survives it is still the right fix");
  assert.doesNotMatch(single, /wrong instrument/);

  // The other half, on both branches: agreement bought by suppressing a real
  // value is the failure this whole feature is blind to, so the prompt has to
  // name it rather than trusting the reader to notice.
  for (const p of [multi, single]) assert.match(p, /fewer values in play means fewer ways to disagree/);
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
  verdict: "overlapping-values", explanation: "e", values: ["round"], rewrite: "s",
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

  // 2. the user takes the rewrite and saves
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
  // A PARTIAL fix: 8 of 21 is 38%, down from 81% but still over the floor, so
  // there is a second diagnosis to make. A fix that took it under 30% would
  // correctly produce no call at all and show "improved" instead — which is the
  // test two above this one.
  await seedUnstable(b, "shape", scopedStamp, { contested: 8, clean: 13 });

  // 5. now it re-diagnoses — and the prompt carries the old wording and rate
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2, "a real re-measurement is worth a call");
  const sent = deps.calls[1].parts[0].text;
  assert.match(sent, /the silhouette/, "the model is told what the wording used to be");
  assert.match(sent, /4 of\s*21 items were unanimous/, "…and what the rate used to be");

  const e = (await diagnosticsOf(b)).shape;
  assert.deepEqual(e.stats, { items: 21, unanimous: 13 }, "19% consistent -> 62%, and still worth a second look");
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
          values: ["round", "wide"], rewrite: "The silhouette; prefer wide for lockups.",
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
  assert.equal(e.rewrite, "The silhouette; prefer wide for lockups.");

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

  // …and it lands in the job log, on the app's standing convention for a failed
  // pass. Only the success path logged before, so the one surface that answers
  // "what did the worker do, and did it work" showed diagnosis as though it never
  // failed — while the entry quietly carried an error nothing rendered.
  const { rows } = await db.query(
    "SELECT outcome, error, detail FROM job_log WHERE board_id=$1 AND kind='diagnose' ORDER BY started_at", [b]);
  assert.equal(rows.length, 3, "one row per attempt, like every other failing lane");
  assert.ok(rows.every((r) => r.outcome === "failed"));
  assert.match(rows[2].error, /provider exploded/);
  assert.deepEqual(rows.map((r) => r.detail.attempts), [1, 2, 3], "jobs-modal renders 'N attempts · <error>'");
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
      return { input: { verdict: "unclear-definition", explanation: "e", values: [], rewrite: "s" }, usage: null };
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

// ─── the rewrite replaces, it does not accumulate ────────────────────────────

test("the prompt asks for a replacement description, not a sentence to bolt on", () => {
  // Appending was the original design and it was wrong in both directions.
  // Where the current wording already tries to draw the distinction and fails —
  // which is what the first live run actually found — a second sentence saying
  // it harder is worse than saying it once properly. And two or three
  // apply-and-retag cycles leave a description that is one original plus three
  // appendages.
  const segment = { key: "shape", items: 25, unanimous: 10, d: FULL.shape, scoped: false };
  const sample = { split: [], contested: [], unanimous: [] };
  const { systemText, schema } = buildDiagnosePrompt({}, BF[0], segment, sample, null);

  assert.match(systemText, /rewrite REPLACES the description/);
  assert.match(systemText, /keeping every judgement the current wording already establishes/,
    "the user's intent is not the model's to replace");
  assert.doesNotMatch(systemText, /appended to the description/);
  assert.ok(schema.required.includes("rewrite"));
  assert.equal(schema.properties.suggestion, undefined, "the old field is gone, not shadowed");
});

test("the prompt refuses 'just tag it less often' as a fix", () => {
  // The first live run produced exactly this for the worst facet: "do not tag
  // these unless explicitly evident". That makes the facet emptier, not more
  // consistent, and empty is not fixed — vote mode already showed unresolved
  // multi-value facets getting emptier rather than settling.
  const segment = { key: "shape", items: 25, unanimous: 10, d: FULL.shape, scoped: false };
  const { systemText } = buildDiagnosePrompt({}, BF[0], segment, { split: [], contested: [], unanimous: [] }, null);
  assert.match(systemText, /a facet that ends up empty is no more useful/i);
});

test("changing the question re-diagnoses every facet, even when the numbers have not moved", async () => {
  // A stored finding is an answer to one specific question. Bump the question
  // and it is no longer current, however unchanged the measurements are — the
  // same logic that puts the prompt SHAPE inside `d`. Without this, entries
  // written against an older schema sit there unactionable forever, because
  // staleness only ever looks at the data.
  const b = await board("prompt-version");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);

  const e = (await diagnosticsOf(b)).shape;
  assert.match(e.k, /^v\d+\|/, "the freshness key names the question it answered");

  // Same board, same numbers, an entry stored under a different question.
  await setFacetDiagnostic(db, b, "shape", { ...e, k: e.k.replace(/^v\d+/, "v0") });
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2, "a finding from an older prompt is not a current finding");
});
