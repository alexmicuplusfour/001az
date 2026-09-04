// Facet-addressable tagging, stage 1 (planning/facet-addressable-tagging-plan.md).
//
// A tagging pass can be told which facets it may WRITE. The pass itself is
// unchanged — it still asks the model about every facet — so this is purely a
// landing-side filter, and the whole feature must be invisible until something
// sets a scope.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import {
  createAiKey, createBoard, createEntity, insertItem, setPluginState,
  markTagged, setItemTags, retagItem, retagBoard, retagBoardFacets, retagItemFacets,
  reprocessEntity, cancelBoardQueue, failOrRequeue, recoverStuck,
  queueUntagged, requeueItemForTag,
} from "../server/db.js";
import { scopeResult, startWorker } from "../server/worker.js";

// Deliberately NOT alphabetical: the merge must emit in this order, and a
// lexicographic sort would produce colour/motif/shape instead.
const FACETS = [
  { key: "shape", label: "Shape", single: true, values: ["round", "wide"] },
  { key: "motif", label: "Motif", values: ["star", "leaf", "bird"] },
  { key: "colour", label: "Colour", single: true, values: ["mono", "duo"] },
];

const prev = {
  tags: ["shape/round", "motif/star", "colour/mono"],
  reasoning: { shape: "old shape", motif: "old motif", colour: "old colour", description: "a mark", fit: "fits" },
  confidence: { shape: { of: 3, agreed: 3, votes: { round: 3 } }, motif: { of: 3, agreed: 2, votes: { star: 2 } } },
};
const next = {
  tags: ["shape/wide", "motif/leaf", "motif/bird", "colour/duo"],
  reasoning: { shape: "new shape", motif: "new motif", colour: "new colour", description: "a NEW mark", fit: "still fits" },
  confidence: { shape: { of: 3, agreed: 1, votes: {} }, motif: { of: 3, agreed: 3, votes: {} }, colour: { of: 3, agreed: 3, votes: {} } },
};

// ─── scopeResult ─────────────────────────────────────────────────────────────

test("no scope is the identity — the object itself comes back", () => {
  // Not merely equal: the unscoped path must not rebuild anything, because
  // every existing board takes it on every single tagging pass.
  assert.equal(scopeResult(FACETS, null, prev, next), next);
  assert.equal(scopeResult(FACETS, [], prev, next), next);
  assert.equal(scopeResult(FACETS, undefined, prev, next), next);
});

test("a scoped facet is replaced and every other one is preserved", () => {
  const m = scopeResult(FACETS, ["motif"], prev, next);
  assert.deepEqual(m.tags, ["shape/round", "motif/leaf", "motif/bird", "colour/mono"]);
  assert.equal(m.reasoning.motif, "new motif");
  assert.equal(m.reasoning.shape, "old shape");
  assert.equal(m.reasoning.colour, "old colour");
  assert.deepEqual(m.confidence.motif, next.confidence.motif);
  assert.deepEqual(m.confidence.shape, prev.confidence.shape);
});

test("the merged array is in BOARD-FACET order, not sorted", () => {
  // tagOne emits in board order; sorting here would make a scoped landing store
  // a different order than a full one, flipping with whichever wrote last.
  const m = scopeResult(FACETS, ["colour"], prev, next);
  assert.deepEqual(m.tags, ["shape/round", "motif/star", "colour/duo"]);
  assert.notDeepEqual(m.tags, [...m.tags].sort());
});

test("a scoped facet that comes back empty loses its old tags", () => {
  const empty = { ...next, tags: ["shape/wide"], reasoning: {}, confidence: {} };
  const m = scopeResult(FACETS, ["motif"], prev, empty);
  assert.deepEqual(m.tags, ["shape/round", "colour/mono"], "motif is gone, not kept");
  assert.equal(m.reasoning.motif, undefined, "and so is its stale justification");
  assert.equal(m.confidence.motif, undefined);
});

test("description and fit survive a scoped merge untouched", () => {
  // They are reserved keys in tag_reasoning, never facet keys — a scoped pass
  // does not own the whole-item prose even though it re-generated it.
  const m = scopeResult(FACETS, ["shape"], prev, next);
  assert.equal(m.reasoning.description, "a mark");
  assert.equal(m.reasoning.fit, "fits");
});

test("a board that declares a facet named 'description' can scope to it", () => {
  const f = [{ key: "description", label: "Description", values: ["a", "b"] }];
  const p = { tags: ["description/a"], reasoning: { description: "old" }, confidence: {} };
  const n = { tags: ["description/b"], reasoning: { description: "new" }, confidence: {} };
  const m = scopeResult(f, ["description"], p, n);
  assert.deepEqual(m.tags, ["description/b"]);
  assert.equal(m.reasoning.description, "new");
});

test("a tag whose facet left the board is dropped, and a malformed one cannot corrupt the merge", () => {
  const p = { tags: ["shape/round", "ghost/gone", "no-separator", "/leading"], reasoning: {}, confidence: {} };
  const m = scopeResult(FACETS, ["motif"], p, { tags: [], reasoning: {}, confidence: {} });
  assert.deepEqual(m.tags, ["shape/round"], "ghost facet garbage-collected; junk ignored");
});

// ─── integration ─────────────────────────────────────────────────────────────

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
  { key: "kind", label: "Kind", single: true, values: ["a", "b"] },
  { key: "mood", label: "Mood", single: true, values: ["calm", "loud"] },
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

async function seedTagged(name, kind = "a", mood = "calm") {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, `fs-${name}`, "openai", "sk-test");
  const board = await createBoard(db, `fs-${name}`, BF, "", true, keyId);
  const eid = await createEntity(db, board, { identity: name });
  const id = await insertItem(db, board, { identity: name, files: [], fields: {} }, "pending", eid);
  await drain(tagger(kind, mood), id);
  return { board, id };
}

test("a scoped retag rewrites one facet and leaves the other alone", async () => {
  const { id } = await seedTagged("one.png", "a", "calm");
  const before = await itemOf(id);
  assert.deepEqual(before.tags, ["kind/a", "mood/calm"]);

  // The model now answers differently on BOTH facets; only `mood` may land.
  // Returns the touched rows' entity ids (the routed-report seed), null on a refusal.
  assert.ok(await retagItemFacets(db, id, ["mood"]));
  assert.deepEqual((await itemOf(id)).tag_facets, ["mood"]);
  await drain(tagger("b", "loud"), id);

  const after = await itemOf(id);
  assert.deepEqual(after.tags, ["kind/a", "mood/loud"], "kind kept its old answer");
  assert.equal(after.tag_reasoning.kind, "kind a", "…and its old justification");
  assert.equal(after.tag_reasoning.mood, "mood loud");
  assert.equal(after.tag_facets, null, "the scope is consumed by the landing");
});

test("a scoped pass leaves `undecided` alone and snapshots consistently", async () => {
  const { id } = await seedTagged("two.png", "a", "calm");
  const snapsBefore = (await rowsOf("SELECT 1 FROM tag_snapshots WHERE item_id=$1", [id])).length;

  // Armed first, flagged second — retagBoardFacets/retagItemFacets refuse an
  // already-undecided item, so the only way a scoped pass meets the flag is for
  // it to arrive after the arming. The landing must still not touch it, and must
  // hand addTagSnapshot the flag that is STORED rather than the pass's own
  // verdict, or the dedupe compares against a value nobody saved.
  await retagItemFacets(db, id, ["mood"]);
  await db.query("UPDATE items SET undecided=TRUE WHERE id=$1", [id]);
  await drain(tagger("b", "loud"), id);

  const after = await itemOf(id);
  assert.equal(after.undecided, true, "a partial pass makes no whole-item verdict");
  // Tags did change, so exactly one snapshot is appended — and it is compared
  // against the flag actually stored, not the fresh pass's verdict.
  const snaps = await rowsOf("SELECT tags, undecided FROM tag_snapshots WHERE item_id=$1 ORDER BY id", [id]);
  assert.equal(snaps.length, snapsBefore + 1);
  assert.equal(snaps.at(-1).undecided, true);
});

test("a scoped pass that changes nothing appends no snapshot", async () => {
  const { id } = await seedTagged("three.png", "a", "calm");
  const before = (await rowsOf("SELECT 1 FROM tag_snapshots WHERE item_id=$1", [id])).length;
  await retagItemFacets(db, id, ["mood"]);
  await drain(tagger("b", "calm"), id); // mood unchanged; kind's new answer is discarded
  assert.deepEqual((await itemOf(id)).tags, ["kind/a", "mood/calm"]);
  assert.equal((await rowsOf("SELECT 1 FROM tag_snapshots WHERE item_id=$1", [id])).length, before);
});

test("an unscoped retag still rewrites everything — the feature is invisible", async () => {
  const { id } = await seedTagged("four.png", "a", "calm");
  await retagItem(db, id);
  assert.equal((await itemOf(id)).tag_facets, null);
  await drain(tagger("b", "loud"), id);
  const after = await itemOf(id);
  assert.deepEqual(after.tags, ["kind/b", "mood/loud"]);
  assert.equal(after.undecided, false);
});

// ─── stage 2: the scope narrows the PROMPT, not just the write ───────────────

// Capture what actually goes on the wire, so these assert the request rather
// than the outcome.
const capturingTagger = (kind, mood, sent) => async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  return tagger(kind, mood)(url, opts);
};

test("a scoped pass asks about the scoped facet only, with no description or verdict", async () => {
  const { id } = await seedTagged("s1.png", "a", "calm");
  await retagItemFacets(db, id, ["mood"]);
  const sent = [];
  await drain(capturingTagger("b", "loud", sent), id);

  const schema = sent.at(-1).tools[0].function.parameters;
  assert.deepEqual(Object.keys(schema.properties), ["mood"], "kind is not even asked about");
  assert.deepEqual(schema.required, ["mood"]);
  assert.equal(schema.properties.description, undefined, "no whole-item description to re-derive");
  assert.equal(schema.properties.fit, undefined, "a partial pass makes no whole-item verdict");

  const sys = sent.at(-1).messages[0].content;
  assert.doesNotMatch(sys, /fit verdict/, "…and the prose must not mention one either");
  assert.doesNotMatch(sys, /description of the item as a whole/);
  assert.doesNotMatch(sys, /- kind \(/, "the other facet is absent from the list");
  assert.match(sys, /- mood \(/);
});

test("an unscoped pass still asks about everything", async () => {
  const { id } = await seedTagged("s2.png", "a", "calm");
  await retagItem(db, id);
  const sent = [];
  await drain(capturingTagger("b", "loud", sent), id);
  const schema = sent.at(-1).tools[0].function.parameters;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["description", "fit", "kind", "mood"]);
  assert.match(sent.at(-1).messages[0].content, /fit verdict/);
});

test("a scope whose facet has left the board lands the item unchanged", async () => {
  // getBoardPrompt returns null for an empty intersection, which is the same
  // signal as a facet-less board — and the scoped branch must PRESERVE there,
  // not wipe, or a deleted facet would cost the item every tag it has.
  const { board, id } = await seedTagged("s3.png", "a", "calm");
  await db.query("UPDATE items SET status='pending', tag_facets=ARRAY['ghost']::text[] WHERE id=$1", [id]);
  const sent = [];
  await drain(capturingTagger("b", "loud", sent), id);
  const after = await itemOf(id);
  assert.equal(sent.length, 0, "nothing was asked, so nothing was paid for");
  assert.deepEqual(after.tags, ["kind/a", "mood/calm"], "every tag survives");
  assert.equal(after.tag_facets, null);
});

test("editing a facet invalidates the scoped prompt too, not just the full one", async () => {
  // The bug this feature exists to let users fix: edit a gloss, retag that
  // facet. A scoped cache entry surviving the edit would tag against the OLD
  // gloss — silently, and exactly when the user is watching for a change.
  const { board, id } = await seedTagged("s4.png", "a", "calm");
  await retagItemFacets(db, id, ["mood"]);
  let sent = [];
  await drain(capturingTagger("b", "loud", sent), id);
  assert.doesNotMatch(sent.at(-1).messages[0].content, /brand new gloss/);

  const admin = await adminSession(db);
  const edited = BF.map((f) => (f.key === "mood" ? { ...f, description: "brand new gloss" } : f));
  const r = await req(srv.base, "PATCH", `/api/admin/boards/${board}`, { sid: admin.sid, body: { facets: edited } });
  assert.equal(r.status, 200);

  await retagItemFacets(db, id, ["mood"]);
  sent = [];
  await drain(capturingTagger("b", "calm", sent), id);
  assert.match(sent.at(-1).messages[0].content, /brand new gloss/, "the scoped entry was invalidated");
});

// ─── the scope must not outlive its pass ─────────────────────────────────────
// Six other writers can see a row while its scope is armed. Each must clear it,
// or a stale scope narrows the next pass. The other writers are exempt only by
// their own status filters, which is why every one of these is pinned.

async function armed(name) {
  const { board, id } = await seedTagged(name, "a", "calm");
  await retagItemFacets(db, id, ["mood"]);
  assert.deepEqual((await itemOf(id)).tag_facets, ["mood"], "armed");
  return { board, id };
}

test("setItemTags clears an armed scope", async () => {
  const { id } = await armed("c1.png");
  await setItemTags(db, id, ["kind/b"]);
  assert.equal((await itemOf(id)).tag_facets, null);
});

test("retagItem clears an armed scope", async () => {
  const { id } = await armed("c2.png");
  await retagItem(db, id);
  assert.equal((await itemOf(id)).tag_facets, null);
});

test("reprocessEntity clears an armed scope", async () => {
  const { id } = await armed("c3.png");
  const { entity_ids: [eid] } = await itemOf(id);
  await reprocessEntity(db, eid);
  assert.equal((await itemOf(id)).tag_facets, null);
});

test("cancelBoardQueue clears an armed scope on both branches", async () => {
  const { board, id } = await armed("c4.png");        // has tags -> `restored`
  const bare = await insertItem(db, board, { identity: "c5.png", files: [], fields: {} }, "pending");
  await db.query("UPDATE items SET tag_facets=ARRAY['mood']::text[] WHERE id=$1", [bare]); // no tags -> `parked`
  await cancelBoardQueue(db, board);
  assert.equal((await itemOf(id)).tag_facets, null, "restored branch");
  assert.equal((await itemOf(bare)).tag_facets, null, "cleared branch");
});

test("markTagged clears the scope it consumed, even when the pass is unscoped", async () => {
  const { id } = await armed("c6.png");
  await db.query("UPDATE items SET status='processing' WHERE id=$1", [id]);
  assert.equal(await markTagged(db, id, ["kind/a"], false, {}, {}), true);
  assert.equal((await itemOf(id)).tag_facets, null);
});

test("a retry keeps its scope — failOrRequeue and recoverStuck must not clear it", async () => {
  const { id } = await armed("c7.png");
  await db.query("UPDATE items SET status='processing' WHERE id=$1", [id]);
  await failOrRequeue(db, id, new Error("boom"), 5);
  assert.deepEqual((await itemOf(id)).tag_facets, ["mood"], "a failed vote keeps its scope");
  await db.query("UPDATE items SET status='processing', updated_at=0 WHERE id=$1", [id]);
  await recoverStuck(db, 1000, 5);
  assert.deepEqual((await itemOf(id)).tag_facets, ["mood"], "and so does a crash-recovered one");
});

// …but a pass that has run OUT of retries is over, and its scope must go with
// it. This is the other half of the rule above, and it is what keeps "a scoped
// row is only ever pending or processing" true — the premise every remaining
// writer's exemption rests on. A 'failed' row is visible to retagBoard,
// queueUntagged and requeueItemForTag, none of which filter on the scope.

// Arm a scope and then exhaust the pass: a permanent 4xx fails the row outright.
async function armedThenFailed(name) {
  const { board, id } = await armed(name);
  await db.query("UPDATE items SET status='processing' WHERE id=$1", [id]);
  const permanent = Object.assign(new Error("bad request"), { status: 400 });
  assert.equal(await failOrRequeue(db, id, permanent, 3), true, "a permanent error fails the row");
  assert.equal((await itemOf(id)).status, "failed");
  return { board, id };
}

test("a terminally failed pass drops its scope, and so does a recovery ceiling", async () => {
  const { id } = await armedThenFailed("c8.png");
  assert.equal((await itemOf(id)).tag_facets, null, "failOrRequeue's terminal branch");

  const { id: id2 } = await armed("c9.png");
  await db.query("UPDATE items SET status='processing', attempts=99, updated_at=0 WHERE id=$1", [id2]);
  await recoverStuck(db, 1000, 3);
  const r = await itemOf(id2);
  assert.equal(r.status, "failed");
  assert.equal(r.tag_facets, null, "recoverStuck's ceiling branch");
});

test("the three writers that CAN see a failed row inherit no scope from it", async () => {
  // Each is exempt from clearing only because a scoped row never reaches its
  // status filter. These pin that, rather than the list of exemptions.
  const { board, id } = await armedThenFailed("c10.png");
  await retagBoard(db, board);
  assert.equal((await itemOf(id)).tag_facets, null, "retagBoard");

  const { board: b2, id: id2 } = await armedThenFailed("c11.png");
  await db.query("UPDATE items SET tags='[]'::jsonb WHERE id=$1", [id2]); // queueUntagged's filter
  await queueUntagged(db, b2);
  assert.equal((await itemOf(id2)).tag_facets, null, "queueUntagged");

  const { id: id3 } = await armedThenFailed("c12.png");
  await requeueItemForTag(db, id3);
  assert.equal((await itemOf(id3)).tag_facets, null, "requeueItemForTag");

  // Park them: drain() runs a real worker over every board, so a row left
  // 'pending' here would land in a later test's captured requests.
  await db.query("UPDATE items SET status='tagged' WHERE id = ANY($1::bigint[])", [[id, id2, id3]]);
});

test("a FULL retag after a failed scoped pass rewrites every facet", async () => {
  // The user-visible shape of the bug: the rescue pass would ask about one facet
  // and leave the other eight on their old answers, silently.
  const { board, id } = await armedThenFailed("c13.png");
  await retagBoard(db, board);
  const sent = [];
  await drain(capturingTagger("b", "loud", sent), id);
  const asked = Object.keys(sent.at(-1).tools[0].function.parameters.properties).sort();
  assert.deepEqual(asked, ["description", "fit", "kind", "mood"], "the whole board was asked about");
  assert.deepEqual((await itemOf(id)).tags, ["kind/b", "mood/loud"], "and the whole board landed");
});

// ─── undecided items are a full pass's job, not a scoped one ─────────────────
// An undecided item IS status='tagged' — the verdict rides its own column — so
// the status filter alone would sweep in exactly the items scoping cannot help.

const undecidedTagger = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  return new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: { name: body.tools?.[0]?.function?.name,
      arguments: JSON.stringify({
        description: "d",
        kind: { values: [], reasoning: "nothing applies" },
        mood: { values: [], reasoning: "nothing applies" },
        fit: { verdict: "undecided", reasoning: "not this kind of thing" },
      }) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200 });
};

async function seedUndecided(name) {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, `fs-${name}`, "openai", "sk-test");
  const board = await createBoard(db, `fs-${name}`, BF, "", true, keyId);
  const eid = await createEntity(db, board, { identity: name });
  const id = await insertItem(db, board, { identity: name, files: [], fields: {} }, "pending", eid);
  await drain(undecidedTagger, id);
  const r = await itemOf(id);
  assert.equal(r.undecided, true, "the seed must actually be undecided");
  assert.deepEqual(r.tags, [], "…with nothing to preserve");
  return { board, id };
}

test("a scoped retag skips undecided items — they have nothing to preserve", async () => {
  const { board, id } = await seedUndecided("u1.png");
  // Writing one facet's answers to an item still flagged undecided is incoherent
  // both ways, and the landing would fire alerts (recorded once, never retracted)
  // off a verdict the model declined to make.
  assert.equal(await retagBoardFacets(db, board, ["mood"]), 0, "queued nothing");
  const after = await itemOf(id);
  assert.equal(after.status, "tagged", "and left the item exactly where it was");
  assert.equal(after.tag_facets, null);

  // A full retag is still the right tool for them, and still takes them.
  assert.equal(await retagBoard(db, board) > 0, true);
  await db.query("UPDATE items SET status='tagged' WHERE id=$1", [id]); // park (see above)
});

test("the per-instance scoped route refuses an undecided item with a 409", async () => {
  const admin = await adminSession(db);
  const { id } = await seedUndecided("u2.png");
  assert.equal(await retagItemFacets(db, id, ["mood"]), null);
  const r = await req(srv.base, "POST", `/api/instances/${id}/retag`, { sid: admin.sid, body: { facets: ["mood"] } });
  assert.equal(r.status, 409);
  // …but an unscoped retag of the same item is still fine.
  const full = await req(srv.base, "POST", `/api/instances/${id}/retag`, { sid: admin.sid, body: {} });
  assert.equal(full.status, 200);
});

// ─── routes ──────────────────────────────────────────────────────────────────

test("the retag routes take an optional facet scope and refuse a bad one", async () => {
  const admin = await adminSession(db);
  const B = srv.base;
  const { board, id } = await seedTagged("r1.png", "a", "calm");

  // absent = today's behaviour, whole board
  const all = await req(B, "POST", `/api/admin/boards/${board}/retag`, { sid: admin.sid, body: {} });
  assert.equal(all.status, 200);
  assert.equal(all.json.facets, undefined);
  assert.equal((await itemOf(id)).tag_facets, null);

  await db.query("UPDATE items SET status='tagged' WHERE id=$1", [id]);
  const one = await req(B, "POST", `/api/admin/boards/${board}/retag`, { sid: admin.sid, body: { facets: ["mood"] } });
  assert.equal(one.status, 200);
  assert.deepEqual(one.json.facets, ["mood"]);
  assert.deepEqual((await itemOf(id)).tag_facets, ["mood"]);

  // a typo must be loud — silently retagging nothing is the worst outcome
  for (const bad of [["nope"], ["mood", "nope"], [], "mood", ["fit"]]) {
    const r = await req(B, "POST", `/api/admin/boards/${board}/retag`, { sid: admin.sid, body: { facets: bad } });
    assert.equal(r.status, 400, `facets ${JSON.stringify(bad)} must be refused`);
  }

  // scoping to EVERY facet is just a full pass — normalised, so the paths can't drift
  await db.query("UPDATE items SET status='tagged', tag_facets=NULL WHERE id=$1", [id]);
  const every = await req(B, "POST", `/api/admin/boards/${board}/retag`, { sid: admin.sid, body: { facets: ["kind", "mood"] } });
  assert.equal(every.status, 200);
  assert.equal(every.json.facets, undefined);
  assert.equal((await itemOf(id)).tag_facets, null);
});

test("the per-instance route scopes too, and refuses an untagged item", async () => {
  const admin = await adminSession(db);
  const B = srv.base;
  const { board, id } = await seedTagged("r2.png", "a", "calm");

  const ok = await req(B, "POST", `/api/instances/${id}/retag`, { sid: admin.sid, body: { facets: ["mood"] } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await itemOf(id)).tag_facets, ["mood"]);

  // nothing to preserve on a never-tagged row -> 409, not a silent no-op
  const bare = await insertItem(db, board, { identity: "r3.png", files: [], fields: {} }, "pending");
  const no = await req(B, "POST", `/api/instances/${bare}/retag`, { sid: admin.sid, body: { facets: ["mood"] } });
  assert.equal(no.status, 409);
});
