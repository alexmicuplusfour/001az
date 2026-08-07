// The facet confidence roll-up (planning/facet-diagnosis-plan.md §1).
//
// "Which of my facets is a coin flip" has needed hand-written SQL since vote
// mode shipped. This reads tag_confidence per facet and answers it — and the
// hard part is not the arithmetic, it is deciding WHICH measurements to count:
// a facet has two current definition stamps (full and scoped), and pooling them
// is the quiet compromise that produces a confident wrong answer.
//
// Confidence is fabricated directly here rather than driven through a live
// tagging pass. facet-stamp.test.js owns the write path end to end; what these
// need is precise control of the numbers being read.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, req } from "./helpers.js";
import {
  createAiKey, createBoard, createEntity, insertItem, setPluginState,
  updateBoard, setItemTags, getBoard,
  boardFacetSegments, facetSplitValues, facetExamples,
} from "../server/db.js";
import { facetStamp, pickSegment, facetRollup, diagnosisSample } from "../server/facet-diagnosis.js";

let srv, db;
before(async () => {
  srv = await startServer();
  db = srv.db;
});
after(async () => { await srv?.close?.(); });

const BF = [
  { key: "shape", label: "Shape", single: true, description: "the silhouette", values: ["round", "wide"] },
  { key: "motif", label: "Motif", description: "what it depicts", values: ["star", "leaf", "bird"] },
];
const FULL = { shape: facetStamp(BF[0], false), motif: facetStamp(BF[1], false) };
const SCOPED = { shape: facetStamp(BF[0], true), motif: facetStamp(BF[1], true) };

let seq = 0;
async function board(name, facets = BF) {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, `fr-${name}-${++seq}`, "openai", "sk-test");
  const id = await createBoard(db, `fr-${name}-${seq}`, facets, "", true, keyId);
  await updateBoard(db, id, { aiVotes: 3 });
  return id;
}

// One tagged item carrying a hand-built confidence map. `undecided` and the
// whole-item description are the two things the queries are picky about.
async function item(boardId, { confidence, tags = [], undecided = false, description = "a mark" }) {
  const eid = await createEntity(db, boardId, { identity: `i${++seq}` });
  const id = await insertItem(db, boardId, { identity: `i${seq}`, files: [], fields: {} }, "pending", eid);
  await db.query(
    `UPDATE items SET status='tagged', tags=$1, tag_confidence=$2, undecided=$3,
            tag_reasoning=$4 WHERE id=$5`,
    [JSON.stringify(tags), JSON.stringify(confidence), undecided,
     JSON.stringify(description === null ? {} : { description }), id]
  );
  return id;
}

// { of, agreed, votes, d } in one expression — `votes` is the full tally
// including the values that lost, which is the whole point of the shape.
const conf = (d, of, agreed, votes) => ({ of, agreed, votes, d });

const byKey = (rollup) => Object.fromEntries(rollup.map((r) => [r.key, r]));

// ─── the arithmetic ──────────────────────────────────────────────────────────

test("per-facet stats: unanimous is agreed === of, counted within one segment", async () => {
  const b = await board("stats");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { wide: 3 }) } });
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) } });
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 1, { round: 1, wide: 1 }) } });

  const r = byKey(await facetRollup(db, await getBoard(db, b)));
  assert.equal(r.shape.items, 4);
  assert.equal(r.shape.unanimous, 2);
  assert.equal(r.shape.d, FULL.shape);
  assert.equal(r.shape.scoped, false);
});

test("a facet the board declares but has never measured is present at zero, not absent", async () => {
  // Absence would read as health. The roll-up is driven by board.facets, so a
  // facet with nothing behind it still gets a row — and a null `d` says the
  // difference between "no problem" and "no data".
  const b = await board("unmeasured");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });

  const r = byKey(await facetRollup(db, await getBoard(db, b)));
  assert.equal(r.motif.items, 0);
  assert.equal(r.motif.d, null);
  assert.equal(r.motif.scoped, null);
  assert.equal(r.motif.label, "Motif", "…and still names itself for the UI");
});

test("a stored key whose facet has left the board does not appear", async () => {
  const b = await board("ghost");
  await item(b, { confidence: {
    shape: conf(FULL.shape, 3, 3, { round: 3 }),
    ghost: conf("deadbeefdead", 3, 1, { a: 1, b: 1 }),
  } });

  const rollup = await facetRollup(db, await getBoard(db, b));
  assert.deepEqual(rollup.map((r) => r.key), ["shape", "motif"], "board order, and nothing else");
});

// ─── the undecided exclusion ─────────────────────────────────────────────────

test("an undecided item is excluded — the regression that makes every facet look healthy", async () => {
  // status='tagged' does NOT exclude it: the verdict rides its own column. An
  // undecided item has its facets empty, every run picked [], so agreed === of
  // and it scores UNANIMOUS. Left in, items the model explicitly declined to
  // place count as evidence that the taxonomy works.
  const b = await board("undecided");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 1, { round: 1, wide: 1 }) } });
  const before = byKey(await facetRollup(db, await getBoard(db, b)));
  assert.deepEqual([before.shape.items, before.shape.unanimous], [1, 0]);

  await item(b, { undecided: true, confidence: { shape: conf(FULL.shape, 3, 3, {}) } });

  const after = byKey(await facetRollup(db, await getBoard(db, b)));
  assert.deepEqual([after.shape.items, after.shape.unanimous], [1, 0], "the undecided item raised nothing");
});

test("an undecided item is excluded from the sample queries too, not just the count", async () => {
  const b = await board("undecided-sample");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) }, description: "contested" });
  await item(b, { undecided: true, confidence: { shape: conf(FULL.shape, 3, 3, {}) }, description: "declined" });
  await item(b, { undecided: true, confidence: { shape: conf(FULL.shape, 3, 1, { round: 1, wide: 1 }) }, description: "declined-split" });

  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  const s = await diagnosisSample(db, b, seg);
  assert.deepEqual(s.contested.map((x) => x.description), ["contested"]);
  assert.deepEqual(s.unanimous.map((x) => x.description), [], "the declined item is not a working example");
});

// ─── 1b: splits, not frequency ───────────────────────────────────────────────

test("the split tally counts where the runs PARTED, not which value is commonest", async () => {
  // Every contested item here reads {round: 3, wide: 1} of 3. Summing the tally
  // ranks `round` first at 3x the weight — and `round` is the one value nobody
  // disputed. Frequency is not tension.
  const b = await board("splits");
  for (let i = 0; i < 3; i++) {
    await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 3, wide: 1 }) } });
  }
  const rows = await facetSplitValues(db, b, "shape", FULL.shape);
  assert.deepEqual(rows, [{ value: "wide", split_on: 3 }]);
});

test("a value every run picked on every item never appears as a split", async () => {
  const b = await board("no-splits");
  await item(b, { confidence: { motif: conf(FULL.motif, 3, 1, { star: 3, leaf: 2, bird: 1 }) } });
  const rows = await facetSplitValues(db, b, "motif", FULL.motif);
  assert.deepEqual(rows.map((r) => r.value), ["bird", "leaf"], "star was unanimous within the item");
  assert.deepEqual(rows.map((r) => r.split_on), [1, 1]);
});

test("unanimous items contribute no splits at all", async () => {
  const b = await board("unanimous-only");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });
  assert.deepEqual(await facetSplitValues(db, b, "shape", FULL.shape), []);
});

// ─── 1c/1d: the contested set and the contrast set ───────────────────────────

test("the two example sets are disjoint, and the contrast set is not faked from failures", async () => {
  const b = await board("contrast");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 1, { round: 1, wide: 1 }) }, description: "worst" });
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) }, description: "middling" });
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) }, description: "clean" });

  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  const s = await diagnosisSample(db, b, seg);
  assert.deepEqual(s.contested.map((x) => x.description), ["worst", "middling"], "most contested first");
  assert.deepEqual(s.unanimous.map((x) => x.description), ["clean"]);
  const overlap = s.contested.filter((c) => s.unanimous.some((u) => u.description === c.description));
  assert.deepEqual(overlap, [], "no item is both");
});

test("a facet that never once converged yields an EMPTY contrast set, not a reused one", async () => {
  // The honest answer to "what do the contested items have that these don't" is
  // then "there are no these", which is itself the finding. Filling the group
  // with contested items would make the comparison circular.
  const b = await board("never-converged");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 1, { round: 1, wide: 1 }) }, description: "a" });
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 1, { round: 1, wide: 1 }) }, description: "b" });

  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  const s = await diagnosisSample(db, b, seg);
  assert.equal(s.contested.length, 2);
  assert.deepEqual(s.unanimous, []);
});

test("contested examples order on the RATIO, so a 2-of-5 outranks a 1-of-2", async () => {
  // `of` is how many runs COMPLETED, not the configured ai_votes, so one board
  // carries a mix. Ordering on `agreed` alone puts the coin flip second.
  const b = await board("ratio");
  await item(b, { confidence: { shape: conf(FULL.shape, 2, 1, { round: 1, wide: 1 }) }, description: "half" });
  await item(b, { confidence: { shape: conf(FULL.shape, 5, 2, { round: 2, wide: 2 }) }, description: "two-fifths" });

  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  const s = await diagnosisSample(db, b, seg);
  assert.deepEqual(s.contested.map((x) => x.description), ["two-fifths", "half"]);
});

test("an item with no whole-item description is not a worked example", async () => {
  // ai_reasoning:false boards write none, so the sample comes back empty and the
  // diagnosis runs on labels alone — degraded, and degraded specifically toward
  // over-diagnosis, since the contrast set is what goes first.
  const b = await board("no-description");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 1, { round: 1, wide: 1 }) }, description: null });
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) }, description: null });

  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  const s = await diagnosisSample(db, b, seg);
  assert.deepEqual(s.contested, []);
  assert.deepEqual(s.unanimous, []);
  assert.equal(seg.items, 2, "…while the roll-up still counts them");
});

// ─── the segment rule ────────────────────────────────────────────────────────

test("a board measured only full reads the full segment", async () => {
  const b = await board("only-full");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) } });
  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  assert.deepEqual([seg.d, seg.scoped, seg.items], [FULL.shape, false, 1]);
});

test("a board measured only scoped reads the scoped segment", async () => {
  // The direction that fails silently if the reader hard-codes the full stamp:
  // this is the state a board is in right after taking the diagnosis's advice.
  const b = await board("only-scoped");
  await item(b, { confidence: { shape: conf(SCOPED.shape, 3, 2, { round: 2, wide: 1 }) } });
  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  assert.deepEqual([seg.d, seg.scoped, seg.items], [SCOPED.shape, true, 1]);
});

test("with both shapes present the reader commits to one and never pools", async () => {
  const b = await board("both");
  for (let i = 0; i < 3; i++) {
    await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });
  }
  for (let i = 0; i < 5; i++) {
    await item(b, { confidence: { shape: conf(SCOPED.shape, 3, 1, { round: 1, wide: 1 }) } });
  }
  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  assert.equal(seg.items, 5, "not 8 — the two shapes are never summed");
  assert.equal(seg.unanimous, 0, "…and the full segment's unanimity does not leak in");
  assert.equal(seg.d, SCOPED.shape);
});

test("a tie goes to the scoped shape, which is the segment that keeps growing", async () => {
  const b = await board("tie");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });
  await item(b, { confidence: { shape: conf(SCOPED.shape, 3, 1, { round: 1, wide: 1 }) } });
  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  assert.equal(seg.d, SCOPED.shape);
  assert.equal(seg.items, 1);
});

test("measurements under a replaced wording are stale, not current — and counted separately", async () => {
  // Every pre-stamp entry looks like this too (d = null). The distinction the UI
  // needs is "never measured" vs "measured against wording you have since
  // edited"; the second is a re-tag away from useful and must not read as the
  // first.
  const b = await board("stale");
  await item(b, { confidence: { shape: conf("0ldde£1nition", 3, 1, { round: 1, wide: 1 }) } });
  await item(b, { confidence: { shape: { of: 3, agreed: 1, votes: { round: 1, wide: 1 } } } }); // pre-stamp

  const seg = pickSegment(BF[0], await boardFacetSegments(db, b));
  assert.equal(seg.items, 0, "nothing current");
  assert.equal(seg.d, null);
  assert.equal(seg.stale, 2, "…but two items are one re-tag from being evidence");
});

test("editing a facet's gloss strands its measurements without touching its neighbour's", async () => {
  const b = await board("edit");
  await item(b, { confidence: {
    shape: conf(FULL.shape, 3, 1, { round: 1, wide: 1 }),
    motif: conf(FULL.motif, 3, 3, { star: 3 }),
  } });

  const edited = BF.map((f) => (f.key === "shape" ? { ...f, description: "brand new gloss" } : f));
  const r = byKey(await facetRollup(db, { id: b, facets: edited }));
  assert.equal(r.shape.items, 0);
  assert.equal(r.shape.stale, 1, "the old number is still there, it just no longer describes this facet");
  assert.equal(r.motif.items, 1, "the facet nobody edited is untouched");
});

// ─── the roll-up's other blind spot ──────────────────────────────────────────

test("a hand-corrected facet leaves the tally rather than counting as agreement", async () => {
  // setItemTags deletes the confidence entry for any facet whose values the user
  // changed — correctly, since a surviving "2 of 3 agreed" on a hand-picked
  // value would be a lie. The consequence is a sampling bias worth pinning: the
  // items a user bothers to correct are the CONTESTED ones, so a curated board
  // under-reports its own instability.
  const b = await board("corrected");
  const keep = await item(b, { tags: ["shape/round"], confidence: { shape: conf(FULL.shape, 3, 3, { round: 3 }) } });
  const fix = await item(b, { tags: ["shape/round"], confidence: { shape: conf(FULL.shape, 3, 1, { round: 1, wide: 1 }) } });

  await setItemTags(db, fix, ["shape/wide"]);

  const r = byKey(await facetRollup(db, await getBoard(db, b)));
  assert.equal(r.shape.items, 1, "the corrected item left the sample entirely");
  assert.equal(r.shape.unanimous, 1, "…it did not stay on as agreement");
  assert.ok(keep);
});

// ─── the endpoint ────────────────────────────────────────────────────────────

test("GET facet-stats returns the roll-up, and carries the pass count with it", async () => {
  const b = await board("route");
  await item(b, { confidence: { shape: conf(FULL.shape, 3, 2, { round: 2, wide: 1 }) } });

  const admin = await adminSession(db);
  const r = await req(srv.base, "GET", `/api/boards/${b}/facet-stats`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.votes, 3);
  assert.deepEqual(r.json.facets.map((f) => f.key), ["shape", "motif"]);
  assert.equal(r.json.facets[0].items, 1);
  assert.equal(r.json.facets[0].unanimous, 0);
});

test("a single-pass board reports facets with nothing in them, and says votes: 1", async () => {
  // The reader must be able to tell "measured, no problem" from "never measured"
  // — {} is NOT MEASURED, and a single-pass board writes {} for every item.
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, `fr-single-${++seq}`, "openai", "sk-test");
  const b = await createBoard(db, `fr-single-${seq}`, BF, "", true, keyId);
  await item(b, { confidence: {} });

  const admin = await adminSession(db);
  const r = await req(srv.base, "GET", `/api/boards/${b}/facet-stats`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.votes, 1);
  assert.deepEqual(r.json.facets.map((f) => f.items), [0, 0]);
});

test("facet-stats is board-manager only, on the edit pencil's terms not the jobs chip's", async () => {
  // The number is only actionable to someone who can edit the taxonomy it
  // measures, so this sits on the pencil's side of the toolbar rather than
  // being ungated transparency like the job log.
  const b = await board("gate");
  const viewer = await seedUser(db, `fr-viewer-${seq}@example.com`);
  const denied = await req(srv.base, "GET", `/api/boards/${b}/facet-stats`, { sid: viewer.sid });
  assert.ok(denied.status === 403 || denied.status === 404, `expected a refusal, got ${denied.status}`);
});
