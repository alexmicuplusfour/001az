// The definition stamp (planning/facet-diagnosis-plan.md §2).
//
// Every confidence entry now records WHICH wording and WHICH prompt shape
// produced its numbers. Before facet scope an item's tag_confidence was one
// coherent snapshot and the only open question was how old it was; now facet A's
// entry can come from yesterday's scoped pass and B's from last month's full
// one — and once a user takes the diagnosis's advice and re-tags the one facet
// they edited, mixed is the EXPECTED state rather than a corner case.
//
// Nothing reads `d` yet. It ships first and alone because the gate that will
// read it is worthless until boards have been tagged under it at least once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import {
  createAiKey, createBoard, createEntity, insertItem, setPluginState,
  updateBoard, retagItem, retagItemFacets,
} from "../server/db.js";
import { mergeVotes, scopeResult, startWorker } from "../server/worker.js";
import { facetStamp } from "../server/facet-diagnosis.js";

const F = { key: "mood", label: "Mood", single: true, description: "how it feels", values: ["calm", "loud"] };

// ─── the hash's inputs ───────────────────────────────────────────────────────
// Four inputs, four assertions, deliberately not one table-driven loop: a
// refactor that quietly drops an input has to fail on the line that names it.

test("d changes when the description changes", () => {
  assert.notEqual(facetStamp(F), facetStamp({ ...F, description: "how it reads" }));
});

test("d changes when the values change", () => {
  assert.notEqual(facetStamp(F), facetStamp({ ...F, values: ["calm", "loud", "wry"] }));
});

test("d changes when `single` changes", () => {
  assert.notEqual(facetStamp(F), facetStamp({ ...F, single: false }));
});

test("d changes when the pass is scoped rather than full", () => {
  // The one input that is not a property of the facet. It is in the hash because
  // a scoped measurement may not be interchangeable with a full one (the live
  // probe put scoped-vs-full agreement at 72.5% against an 85.0% full-vs-full
  // control), and pooling two prompt shapes to reach a sample minimum is how a
  // confident wrong answer gets written. Same definition, different shape,
  // different stamp — and a reader therefore has TWO current stamps to choose
  // between, never one.
  assert.notEqual(facetStamp(F, false), facetStamp(F, true));
});

test("the same definition hashes the same, and a value REORDER is not a redefinition", () => {
  // Stability is what makes edit-then-revert keep a board's measurements, which
  // is the whole reason this is a hash and not a timestamp.
  assert.equal(facetStamp(F), facetStamp({ ...F }));
  // Values are sorted before hashing, deliberately: dragging one up the list
  // moves the prompt but does not change what the facet means, and throwing
  // away every number a board has over a drag is the worse trade.
  assert.equal(facetStamp(F), facetStamp({ ...F, values: ["loud", "calm"] }));
});

test("a description cannot forge the boundary between itself and the value list", () => {
  // The inputs are JSON-serialised rather than concatenated. Under a naive
  // `${description}|${values}` these two hash identically — and a gloss edit
  // that collides with the old stamp does not fail loudly, it silently reads
  // pre-edit measurements as post-edit ones, which is the exact bug the stamp
  // exists to prevent.
  assert.notEqual(
    facetStamp({ description: "a", values: ["b", "c"] }),
    facetStamp({ description: "a|b", values: ["c"] }),
  );
});

// ─── mergeVotes writes it ────────────────────────────────────────────────────

const FACETS = [
  { key: "shape", single: true, values: ["round", "square"] },
  { key: "mood", single: true, values: ["calm", "loud"] },
];
const run = (shape, mood) => ({
  picks: { shape: [shape], mood: [mood] },
  reasoning: {},
  description: "d",
  fit: { verdict: "match" },
});

test("mergeVotes stamps every facet it writes, and disturbs nothing else in the entry", () => {
  const m = mergeVotes(
    FACETS,
    [run("round", "calm"), run("round", "loud"), run("round", "calm")],
    { shape: "aaaaaaaaaaaa", mood: "bbbbbbbbbbbb" },
  );
  assert.deepEqual(m.confidence.shape, { of: 3, agreed: 3, votes: { round: 3 }, d: "aaaaaaaaaaaa" });
  assert.deepEqual(m.confidence.mood, { of: 3, agreed: 2, votes: { calm: 2, loud: 1 }, d: "bbbbbbbbbbbb" });
});

test("with no stamps the KEY is absent, not present-and-undefined", () => {
  // Every entry written before this shipped looks like this, and "measured under
  // an unknown definition" has to stay distinguishable from "measured under this
  // one" — a present-but-empty `d` would read as a value and could be compared.
  const m = mergeVotes(FACETS, [run("round", "calm"), run("round", "calm")]);
  assert.equal("d" in m.confidence.shape, false);
  assert.deepEqual(m.confidence.shape, { of: 2, agreed: 2, votes: { round: 2 } });
});

test("a facet missing from the stamp map is left unstamped while its neighbour is stamped", () => {
  const m = mergeVotes(FACETS, [run("round", "calm"), run("round", "calm")], { shape: "aaaaaaaaaaaa" });
  assert.equal(m.confidence.shape.d, "aaaaaaaaaaaa");
  assert.equal("d" in m.confidence.mood, false);
});

// ─── a scoped landing carries stamps through ─────────────────────────────────

test("a scoped landing replaces the scoped facet's stamp and leaves the others'", () => {
  // `pick` copies whole confidence objects, so this costs scopeResult no code —
  // which is exactly why it needs pinning: nothing in scopeResult mentions `d`,
  // so nothing there would break visibly if the entry's shape moved underneath.
  const prev = {
    tags: [], reasoning: {},
    confidence: {
      shape: { of: 3, agreed: 3, votes: {}, d: "full-shape" },
      mood: { of: 3, agreed: 2, votes: {}, d: "full-mood" },
    },
  };
  const next = { tags: [], reasoning: {}, confidence: { mood: { of: 3, agreed: 3, votes: {}, d: "scoped-mood" } } };
  const m = scopeResult(FACETS, ["mood"], prev, next);
  assert.equal(m.confidence.mood.d, "scoped-mood");
  assert.equal(m.confidence.shape.d, "full-shape", "an untouched facet keeps the stamp of the pass that measured it");
});

// ─── end to end ──────────────────────────────────────────────────────────────

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

const rowsOf = async (sql, args) => (await db.query(sql, args)).rows;
const itemOf = async (id) => (await rowsOf("SELECT * FROM items WHERE id=$1", [id]))[0];

const BF = [
  { key: "kind", label: "Kind", single: true, description: "what it is", values: ["a", "b"] },
  { key: "mood", label: "Mood", single: true, description: "how it feels", values: ["calm", "loud"] },
];

const tagger = (kind, mood) => async (_url, opts) => {
  const body = JSON.parse(opts.body);
  return new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: { name: body.tools?.[0]?.function?.name,
      arguments: JSON.stringify({
        description: "d",
        kind: { values: [kind], reasoning: `kind ${kind}` },
        mood: { values: [mood], reasoning: `mood ${mood}` },
        fit: { verdict: "match", reasoning: "ok" },
      }) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200 });
};

const stubFetch = (handler) => {
  const real = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = real; };
};
const until = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function drain(handler, id) {
  const restore = stubFetch(handler);
  const stop = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
  try {
    await until(async () => (await itemOf(id))?.status === "tagged");
  } finally {
    await stop();
    restore();
  }
}

// ai_votes: 3 throughout — a single-pass board writes no confidence at all, so
// there is nothing for a stamp to ride on.
async function seedTagged(name, kind = "a", mood = "calm") {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, `st-${name}`, "openai", "sk-test");
  const board = await createBoard(db, `st-${name}`, BF, "", true, keyId);
  await updateBoard(db, board, { aiVotes: 3 });
  const eid = await createEntity(db, board, { identity: name });
  const id = await insertItem(db, board, { identity: name, files: [], fields: {} }, "pending", eid);
  await drain(tagger(kind, mood), id);
  return { board, id };
}

test("a full vote pass stamps every facet with its unscoped definition", async () => {
  const { id } = await seedTagged("one.png");
  const conf = (await itemOf(id)).tag_confidence;
  assert.equal(conf.kind.d, facetStamp(BF[0], false));
  assert.equal(conf.mood.d, facetStamp(BF[1], false));
});

test("a single-pass board has no stamps, because it has no confidence", async () => {
  // {} = NOT MEASURED. The stamp appears exactly where confidence does and
  // nowhere else — there is no such thing as a stamped non-measurement.
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "st-single", "openai", "sk-test");
  const board = await createBoard(db, "st-single", BF, "", true, keyId); // ai_votes defaults to 1
  const eid = await createEntity(db, board, { identity: "solo.png" });
  const id = await insertItem(db, board, { identity: "solo.png", files: [], fields: {} }, "pending", eid);
  await drain(tagger("a", "calm"), id);
  assert.deepEqual((await itemOf(id)).tag_confidence, {});
});

test("a scoped retag stamps the SCOPED shape, and only on the facet it re-measured", async () => {
  // The state the diagnosis has to survive, and the reason it cannot ask for
  // "the facet's current stamp" as though that were one value: one item, two
  // facets, two prompt shapes, all of them current.
  const { id } = await seedTagged("two.png");
  const first = (await itemOf(id)).tag_confidence;

  await retagItemFacets(db, id, ["mood"]);
  await drain(tagger("b", "loud"), id);

  const conf = (await itemOf(id)).tag_confidence;
  assert.equal(conf.mood.d, facetStamp(BF[1], true), "re-measured on this facet alone");
  assert.notEqual(conf.mood.d, first.mood.d, "…which is not the stamp the full pass wrote for the same wording");
  assert.equal(conf.kind.d, first.kind.d, "the untouched facet keeps the stamp of the pass that measured it");
});

test("editing a gloss changes the stamp on the next pass — the whole point", async () => {
  const { board, id } = await seedTagged("three.png");
  const first = (await itemOf(id)).tag_confidence;

  const admin = await adminSession(db);
  const edited = BF.map((f) => (f.key === "mood" ? { ...f, description: "brand new gloss" } : f));
  const r = await req(srv.base, "PATCH", `/api/admin/boards/${board}`, { sid: admin.sid, body: { facets: edited } });
  assert.equal(r.status, 200);

  await retagItem(db, id);
  await drain(tagger("a", "calm"), id);

  const conf = (await itemOf(id)).tag_confidence;
  assert.notEqual(conf.mood.d, first.mood.d, "the number no longer claims to describe the wording it replaced");
  assert.equal(conf.kind.d, first.kind.d, "…and the facet nobody touched still carries the same stamp");
});
