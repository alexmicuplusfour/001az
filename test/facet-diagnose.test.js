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
import { readFileSync } from "node:fs";
import { startServer, adminSession, req, meterTotals } from "./helpers.js";
import {
  createAiKey, createBoard, createEntity, insertItem, setPluginState,
  updateBoard, getBoard, setFacetDiagnostic, demoteFacetDiagnostics,
  retagBoard, boardTagActivity, IN_FLIGHT_STATES,
} from "../server/db.js";
import { facetStamp, editedFacets, diagnoseDue, diagnoseCandidates, buildDiagnosePrompt, facetRollup } from "../server/facet-diagnosis.js";
import { boardsWithVotes } from "../server/db.js";
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
        // The shape meterAiCall actually reads — input_tokens/output_tokens
        // would book zero while still metering the call's request.
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

  const usage = await meterTotals(db, b, "diagnose");
  assert.equal(usage.calls, 1, "the call is billed like any other — as its own kind");
  assert.equal(usage.input, 100, "…with its tokens, not just its row");

  const [job] = (await db.query("SELECT * FROM job_log WHERE board_id=$1 AND kind='diagnose'", [b])).rows;
  assert.equal(job.target, "shape", "the ledger names the facet");
  // The row carries what served it and what it cost, the tag/extract spelling
  // (metering-plan.md Stage 2). Stub usage is 100/20 with no cache — so no
  // cache key, not a zero.
  assert.deepEqual(job.detail, {
    items: 21, unanimous: 4, verdict: "overlapping-values", scoped: false,
    model: "gpt-5-mini", provider: "openai", tokens: { in: 100, out: 20 },
  });
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

// ─── when a finding is asked again: its question, or its rate ───────────────

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
  // A finding is a claim about the TAXONOMY — "these two values overlap, here
  // is wording that separates them" — and 20 more logos arriving does not
  // refute it. The question is the same and the rate holds, so nothing about it
  // has become untrue, and nothing is re-asked.
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
  assert.equal(deps.calls.length, 1, "same question, same rate — nothing to ask");
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

test("deleting the cards a finding was reasoned from does NOT re-diagnose", async () => {
  // Reported from the running app: deleting batches of old logos re-ran the
  // check after every batch, six paid calls in an afternoon with the rate pinned
  // at 30.1-30.2% and one verdict throughout. The worked examples are picked
  // oldest first, the key fingerprinted them, and deleting old cards changed
  // them. The wording and the rate are where they were, so the question is too.
  //
  // Proportional rather than the live 2,400: 40 contested of 100, and the twelve
  // the prompt shows are the oldest eight contested and the oldest four clean.
  const b = await board("deleted");
  await seedUnstable(b, "shape", FULL.shape, { contested: 40, clean: 60 });
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);

  // Every card the prompt showed. 32 of 88 is 36.4%, 3.6 points from 40%.
  const { rowCount } = await db.query(
    `DELETE FROM items WHERE id IN (
       (SELECT id FROM items WHERE board_id=$1 AND (tag_confidence->'shape'->>'agreed')::int < 3 ORDER BY id LIMIT 8)
       UNION ALL
       (SELECT id FROM items WHERE board_id=$1 AND (tag_confidence->'shape'->>'agreed')::int = 3 ORDER BY id LIMIT 4))`,
    [b]
  );
  assert.equal(rowCount, 12);
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1, "the same question at the same rate: nothing to ask");
  const row = (await facetRollup(db, await getBoard(db, b))).find((f) => f.key === "shape");
  assert.equal(row.current, true, "and the screens keep showing the finding");
});

// A retag landing: every queued card back to `tagged`, outside the settle
// window. With `votes`, the new pass also re-described the contested cards and
// split their votes the other way, at the same agreement, so the rate holds.
async function land(b, { votes = null, description = "a broad angular slab" } = {}) {
  await db.query("UPDATE items SET status='tagged', tag_facets=NULL, updated_at=0 WHERE board_id=$1", [b]);
  if (!votes) return;
  await db.query(
    `UPDATE items SET tag_confidence = jsonb_set(tag_confidence, '{shape,votes}', $2::jsonb),
                      tag_reasoning = jsonb_build_object('description', $3::text)
     WHERE board_id=$1 AND (tag_confidence->'shape'->>'agreed')::int < (tag_confidence->'shape'->>'of')::int`,
    [b, JSON.stringify(votes), description]
  );
}

test("a board retag that lands at the same rate does NOT re-diagnose", async () => {
  // A retag used to mark every finding whose twelve examples it queued, and the
  // loop re-asked once it landed. Same wording, same rate, same answer.
  //
  // Through the real route, so nothing between the click and the landing marks
  // anything; and the landing changes what the tagger SAYS about every
  // contested card, so a key over the examples would have moved.
  const b = await board("retag-same");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1);

  const admin = await adminSession(db);
  const r = await req(srv.base, "POST", `/api/admin/boards/${b}/retag`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.ok(r.json.queued > 0, "the retag queued the board");
  await land(b, { votes: { round: 1, wide: 2 } });
  // The pass can reach the facet — the board is quiet and the finding is judged
  // current — so the silence below is the decision, not a closed gate.
  assert.equal((await boardTagActivity(db, b)).busy, 0);
  assert.equal((await facetRollup(db, await getBoard(db, b))).find((f) => f.key === "shape").current, true);

  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1, "the same question at the same rate: nothing to ask");
});

test("…but one that moves the rate does", async () => {
  const b = await board("retag-moved");
  await seedUnstable(b); // 17 of 21 contested, 81%
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);

  const admin = await adminSession(db);
  await req(srv.base, "POST", `/api/admin/boards/${b}/retag`, { sid: admin.sid });
  await land(b);
  // Three contested cards come back unanimous: 14 of 21 is 67%.
  await db.query(
    `UPDATE items SET tag_confidence = jsonb_set(tag_confidence, '{shape}', $2::jsonb)
     WHERE id IN (SELECT id FROM items WHERE board_id=$1
                  AND (tag_confidence->'shape'->>'agreed')::int < 3 ORDER BY id LIMIT 3)`,
    [b, JSON.stringify(conf(FULL.shape, 3, 3, { round: 3 }))]
  );
  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2, "81% then 67% is not the same finding");
});

test("a facet-only retag is a different question: the finding stops standing and is asked again", async () => {
  // The two measurement shapes are not interchangeable (facetStamp's `scoped`),
  // so a finding read off a full pass does not answer a facet-only one. The
  // stamp moving is the whole signal: the screens stop showing the old finding
  // and the loop re-asks, from the same `stands`.
  const b = await board("reshaped");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  assert.equal((await diagnosticsOf(b)).shape.scoped, false);

  const admin = await adminSession(db);
  const r = await req(srv.base, "POST", `/api/admin/boards/${b}/retag`, { sid: admin.sid, body: { facets: ["shape"] } });
  assert.equal(r.status, 200);
  // The pass lands every card under the facet-only stamp, at the same agreement.
  await db.query(
    `UPDATE items SET status='tagged', tag_facets=NULL, updated_at=0,
       tag_confidence = jsonb_set(tag_confidence, '{shape,d}', to_jsonb($2::text))
     WHERE board_id=$1`,
    [b, facetStamp(BF[0], true)]
  );

  const row = (await facetRollup(db, await getBoard(db, b))).find((f) => f.key === "shape");
  assert.equal(row.scoped, true, "the roll-up reads the facet-only measurement");
  assert.equal(row.current, false, "and the full-pass finding does not answer it");

  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 2, "so it is asked again");
  assert.equal((await diagnosticsOf(b)).shape.scoped, true);
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

test("a retag is a retag on a MAPPED board too — all four queue states count", async () => {
  // retagBoard routes items by payload rather than queueing them uniformly: one
  // carrying a `mapping` it has not been extracted under enters 'pending_extract',
  // a connector vehicle with no rendered file enters 'pending_face'. So on a
  // mapped or connector board a full retag produces no 'pending' row at all.
  //
  // The diagnosis queries that read `IN ('pending','processing')` were therefore
  // wrong on that whole class of board, in the same direction and silently: the
  // settle gate called the board quiet mid-sweep, and the roll-up reported
  // nothing in flight — which is what put "Not measured against the current
  // wording yet. Re-tag this board" over a board being re-tagged as the user
  // read it. The route logged "retag queued: 21 item(s)" throughout.
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
    await retagBoard(db, b);
    const statuses = (await db.query("SELECT DISTINCT status FROM items WHERE board_id=$1", [b])).rows.map((r) => r.status);
    const row = (await facetRollup(db, await getBoard(db, b))).find((f) => f.key === "shape");
    return { statuses, busy: (await boardTagActivity(db, b)).busy, queued: row.queued };
  };

  const plain = await shape({ extracted_at: 1 });
  const mapped = await shape({ mapping: { input: {} } });

  assert.deepEqual(plain.statuses, ["pending"], "the plain board queues straight to tagging");
  assert.deepEqual(mapped.statuses, ["pending_extract"], "the mapped one goes through the extract leg");
  assert.equal(mapped.busy, plain.busy, "and the settle gate holds the same");
  assert.ok(mapped.busy > 0);
  assert.equal(mapped.queued, plain.queued, "and the reader is told the same thing is in flight");
  assert.ok(mapped.queued > 0, "which is what turns 'go re-tag this' into 'this is re-tagging'");
});

test("…and every in-flight state counts, claimed ones included", async () => {
  // Every leg, each with a state the item WAITS in and a state the worker
  // claims it INTO. Missing 'extracting' and 'facing' was the same defect one
  // level down: a board whose queue has just been picked up reads quiet.
  //
  // Driven off db.js's OWN exported list rather than a copy — a hand-written
  // array here kept passing while its "every one" title went false the moment
  // the fetch leg landed, which is exactly how the first version came to name
  // a subset and look complete.
  for (const status of IN_FLIGHT_STATES) {
    const b = await board(`state-${status}`);
    await seedUnstable(b);
    await db.query("UPDATE items SET status=$2 WHERE board_id=$1", [b, status]);
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
    await db.query("UPDATE items SET status=$2 WHERE board_id=$1", [b, status]);
    assert.equal((await boardTagActivity(db, b)).busy, 0, `${status}: the board is quiet`);
  }
});

test("a retag's queued cards count as re-measuring; an upload's do not", async () => {
  // Both are queued, and only one takes cards out of the sample: a retag's carry
  // the answer their pass will replace, an upload's first pass carries none. The
  // screens set a finding's judgment aside only for the first (rerun plan D4), so
  // an upload cannot bring back a finding that had stopped standing.
  const b = await board("remeasuring");
  await seedUnstable(b); // 21 measured cards
  await db.query("UPDATE items SET status='pending' WHERE id IN (SELECT id FROM items WHERE board_id=$1 ORDER BY id LIMIT 10)", [b]);
  for (let i = 0; i < 30; i++) await item(b, { confidence: {}, status: "pending", description: `new ${i}` });
  const row = (await facetRollup(db, await getBoard(db, b))).find((f) => f.key === "shape");
  assert.equal(row.queued, 40, "forty cards will write this facet");
  assert.equal(row.remeasuring, 10, "ten of them are being re-measured");
});

// ─── the update, and what a quiet pass costs ─────────────────────────────────

test("0058 keeps a finding from before the update standing, rather than asking it again", async () => {
  // The key used to end in a fingerprint of the twelve worked examples. Left
  // alone, every stored finding would mismatch once and be re-asked: a dot on
  // every board with Double-check tags on, which is the noise the change exists
  // to remove.
  const b = await board("migrated");
  await seedUnstable(b);
  const deps = stubTagger();
  await diagnoseDue(db, deps, null);
  const now = (await diagnosticsOf(b)).shape;

  // The same finding as the old code stored it; one in the shape v3 keys had
  // before that (a rate bucket and the examples' ids); and an older question's.
  await setFacetDiagnostic(db, b, "shape", { ...now, k: `${now.k}|0123456789abcdef`, stale: true, evidence: ["1", "2"] });
  await setFacetDiagnostic(db, b, "older", { k: `${now.k}|80|1,2,3`, verdict: "unclear-definition" });
  await setFacetDiagnostic(db, b, "motif", { k: "v2|abc|15|round", verdict: "unclear-definition", stale: true });

  const sql = readFileSync(new URL("../server/migrations/0058_diagnosis_question_key.sql", import.meta.url), "utf8");
  await db.query(sql);
  await db.query(sql); // twice: a rewritten key no longer matches

  const all = await diagnosticsOf(b);
  assert.deepEqual(all.shape, now, "the fingerprint is cut off the key, `stale` and `evidence` go, nothing else moves");
  assert.equal(all.older.k, now.k, "every v3 key comes down to its question");
  assert.deepEqual(all.motif, { k: "v2|abc|15|round", verdict: "unclear-definition" },
    "an older question's key is left to be asked again");

  await diagnoseDue(db, deps, null);
  assert.equal(deps.calls.length, 1, "the finding stands");
});

test("a pass with nothing to ask reads no worked examples", async () => {
  // The fingerprint ranked the twelve examples of every unstable facet on every
  // pass, just to decide whether to spend. Whether a finding stands is on the
  // row now, so the examples are read only for a call that is being made.
  const b = await board("quiet-pass");
  await seedUnstable(b);
  await diagnoseDue(db, stubTagger(), null);

  const sent = [];
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === "query") return (q, ...rest) => { sent.push(String(q?.text ?? q)); return target.query(q, ...rest); };
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const deps = stubTagger();
  await diagnoseDue(counted, deps, null);
  assert.equal(deps.calls.length, 0);
  assert.ok(sent.some((q) => q.includes("jsonb_each(i.tag_confidence)")), "the pass did read the roll-up");
  assert.ok(!sent.some((q) => q.includes("AS description")), "and no worked example");
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

test("…and the tail is diagnosed on the next pass, and re-asked when its rate moves", async () => {
  // The ten worst used to hold the slots whether or not they had anything to
  // ask, so the eleventh was never looked at: not on the next pass, and not when
  // its rate moved. Only a finding marked out of date jumped the queue, and only
  // a retag marked one. Findings that stand now leave before the bound is
  // applied, so it is a queue rather than a wall, whatever a facet needs asking
  // for (rerun plan D8).
  const b = await board("tail", { facets: ELEVEN });
  await seedLadder(b);
  const deps = stubTagger();
  const f0 = (from) => deps.calls.slice(from).filter((c) => c.systemText.includes("key: f0\n")).length;

  await diagnoseDue(db, deps, null);
  assert.equal(f0(0), 0, "pass one goes to the ten worst");
  let at = deps.calls.length;
  await diagnoseDue(db, deps, null);
  assert.deepEqual([f0(at), deps.calls.length - at], [1, 1], "pass two is f0's alone: the ten ahead of it stand");

  // f0's rate moves, 33% to 41%, and nothing else's: the new cards carry f0 only.
  for (let j = 0; j < 4; j++) {
    await item(b, { confidence: { f0: conf(facetStamp(ELEVEN[0], false), 3, 2, { round: 2, wide: 1 }) }, description: `late ${j}` });
  }
  at = deps.calls.length;
  await diagnoseDue(db, deps, null);
  assert.deepEqual([f0(at), deps.calls.length - at], [1, 1], "re-asked, with ten worse facets standing");
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

  // Billed through the same meter as any other call, in the shape meterAiCall
  // actually reads — asserting only the request would pass with tokens at zero.
  const usage = await meterTotals(db, b, "diagnose");
  assert.equal(usage.calls, 1);
  assert.equal(usage.input, 900);
  assert.equal(usage.output, 120);
});

// ─── the rotation as the worker's kind sees it (queue-by-resource-plan.md Stage 7)

// Start the walk AT a board: the id just before it in the rotation's own order,
// or none when it is first. Other tests' boards share this database, so the only
// deterministic assertions are about the board a walk starts on.
async function walkFrom(boardId) {
  const boards = await boardsWithVotes(db);
  const i = boards.findIndex((b) => b.id === boardId);
  return i > 0 ? boards[i - 1].id : null;
}

test("diagnoseCandidates: hands out a real question, withholds a facet in flight, walks past a board with none", async () => {
  const deps = stubTagger();
  const fresh = await board("cand-fresh");
  await seedUnstable(fresh);

  // A real question: the unit carries everything the paid half needs.
  const found = await diagnoseCandidates(db, deps, await walkFrom(fresh));
  assert.equal(found.boardId, fresh);
  assert.equal(found.units.length, 1, "the one unstable facet");
  assert.equal(found.units[0].facet.key, "shape");
  assert.ok(found.units[0].ai, "and the key it will spend on, resolved here so the run spends on what was decided");

  // In flight: the same walk with that facet excluded hands it out to nobody.
  const held = await diagnoseCandidates(db, deps, await walkFrom(fresh), [`${fresh}:shape`]);
  assert.ok(!held.units.some((u) => u.board.id === fresh), "a slow call cannot be asked twice");

  // Diagnosed: once answered, the board has no question left, and the walk goes
  // past it inside this same call rather than handing it out to discover that.
  await diagnoseDue(db, deps, await walkFrom(fresh));
  assert.equal((await diagnosticsOf(fresh)).shape.verdict, "overlapping-values");
  const past = await diagnoseCandidates(db, deps, await walkFrom(fresh));
  assert.ok(!past.units.some((u) => u.board.id === fresh), "an already-diagnosed board is walked past, not handed out");
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

test("…and a question out of tries rests a day, then gets one more", async () => {
  // Nothing else wakes it: a retag that lands at the same rate is the same
  // question, so a dead key or an outage fixed since would leave the facet
  // "couldn't re-read" for good. Resting, a failure that persists costs one call
  // a day.
  const b = await board("retry-rest");
  await seedUnstable(b);
  let n = 0;
  const deps = {
    resolveAi: async () => ({ provider: "openai", apiKey: "sk-test", model: "m" }),
    tagger: async () => { n++; throw new Error("provider exploded"); },
  };
  for (let i = 0; i < 4; i++) await diagnoseDue(db, deps, null);
  assert.equal(n, 3, "out of tries");

  // The last try, a day and a minute ago.
  const e = (await diagnosticsOf(b)).shape;
  await setFacetDiagnostic(db, b, "shape", { ...e, at: Date.now() - 24 * 3600 * 1000 - 60000 });
  await diagnoseDue(db, deps, null);
  assert.equal(n, 4, "rested, so one more");
  assert.equal((await diagnosticsOf(b)).shape.attempts, 4);
  await diagnoseDue(db, deps, null);
  assert.equal(n, 4, "and then another day's rest");
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

  // The rate moves, 81% to 87%, so the next tick is a new question and calls
  // again.
  for (let i = 0; i < 10; i++) {
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
