// The reader's half (planning/facet-diagnosis-plan.md §6).
//
// `diagnosisState` decides which of five states a facet is in, and every wrong
// answer it can give is a plausible-looking box: a paragraph about wording the
// user already replaced, an "improved" badge on a facet nobody measured, or —
// worst and quietest — silence that reads as health. None of that fails at
// runtime, so it is pinned here.
//
// Also the two payloads that feed it, because the surfaces would drift apart
// the moment they stopped coming from one place.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import {
  createAiKey, createBoard, createEntity, insertItem, setPluginState,
  updateBoard, setFacetDiagnostic,
} from "../server/db.js";
import { facetStamp, GATES } from "../server/facet-diagnosis.js";

// The client module reaches for localStorage; nothing else in it needs a DOM.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document ||= { addEventListener() {}, dispatchEvent() { return true; } };
const { diagnosisState, diagnosticsUnseen, markDiagnosticsSeen, canSeeDiagnostics } = await import("../public/facet-diagnostics.js");

const G = { minItems: 20, minRate: 0.15 };

// One roll-up row, as the server serves it.
const row = (over = {}) => ({
  key: "shape", label: "Shape", items: 0, unanimous: 0, d: null, scoped: null, stale: 0, diagnostic: null,
  ...over,
});
const finding = (over = {}) => ({
  verdict: "overlapping-values", explanation: "round and wide overlap", values: ["round"],
  rewrite: "prefer wide", stats: { items: 25, unanimous: 15 }, split: ["wide"],
  d: "aaa", scoped: false, k: "x", at: 1000, ...over,
});

// ─── state 3: nothing to say, and the two ways to get there ──────────────────

test("a facet with no diagnostics renders nothing", () => {
  // A single-pass board has no diagnostics whatsoever, and its empty state has
  // to stay visually identical to what shipped before any of this existed.
  assert.equal(diagnosisState(row(), G).state, "none");
  assert.equal(diagnosisState(row({ items: 40, unanimous: 40 }), G).state, "none");
});

test("no-problem-found renders exactly like no entry at all", () => {
  // ABSENCE MUST NEVER READ AS "FINE" — so the converse has to hold too: a
  // measured, healthy facet must not get a badge that an unmeasured one lacks,
  // or the unmeasured one starts reading as the broken one.
  const measured = diagnosisState(row({ items: 40, unanimous: 39, diagnostic: finding({ verdict: "no-problem-found", rewrite: "" }) }), G);
  assert.equal(measured.state, "none");
});

// ─── state 1: a finding ──────────────────────────────────────────────────────

test("an actionable verdict with enough items is a finding", () => {
  const s = diagnosisState(row({ items: 25, unanimous: 15, diagnostic: finding() }), G);
  assert.equal(s.state, "finding");
  assert.equal(s.entry.rewrite, "prefer wide");
  assert.equal(Math.round(s.rate * 100), 40, "the rate is read off the measurements, not off the entry");
});

test("a verdict with no explanation is not a finding", () => {
  // A box with a heading and no body is worse than no box.
  const s = diagnosisState(row({ items: 25, unanimous: 15, diagnostic: finding({ explanation: "" }) }), G);
  assert.equal(s.state, "none");
});

// ─── state 2: information, not a task ────────────────────────────────────────

test("genuinely-ambiguous-items is its own state, not a finding", () => {
  const s = diagnosisState(row({ items: 25, unanimous: 15, diagnostic: finding({ verdict: "genuinely-ambiguous-items", rewrite: "" }) }), G);
  assert.equal(s.state, "note");
});

// ─── state 4: awaiting re-measurement ────────────────────────────────────────

test("a live verdict does NOT outrank awaiting when the sample has fallen away", () => {
  // The ordering, and the only case that actually tests it: an entry carrying a
  // verdict AND a previous, on a facet whose current segment is now too thin.
  const s = diagnosisState(row({
    items: 3, unanimous: 1, stale: 22,
    diagnostic: finding({ previous: { stats: { items: 25, unanimous: 15 }, description: "old", scoped: false } }),
  }), G);
  assert.equal(s.state, "awaiting", "the finding must not win here");
});

test("…and a curated board is the case that has neither `previous` nor `stale`", () => {
  // The one above passes on `stale` alone, which is NOT what curation leaves
  // behind: setItemTags DELETES a corrected facet's confidence entry rather
  // than re-stamping it, so the removed items vanish from the roll-up entirely
  // instead of landing in `stale`. Hand-fix eighteen of twenty-one contested
  // items under a standing finding and the row reads items: 3, stale: 0,
  // previous: null — every disjunct the ordering used to key on absent, and the
  // stored paragraph the only thing left. It rendered "the tagger contradicted
  // itself on 0% of items" above an explanation of the contradiction.
  const s = diagnosisState(row({ items: 3, unanimous: 3, stale: 0, diagnostic: finding() }), G);
  assert.equal(s.state, "awaiting", "a finding must never render on a sub-minimum sample");
  assert.equal(s.previous, null);
});

test("a demoted entry after an edit is awaiting, with the baseline intact", () => {
  // The ordinary path: the demotion cleared the verdict and the items that
  // produced it now sit under a stamp the roll-up no longer counts. If the UI
  // rendered the old paragraph anyway, the definition stamp bought nothing.
  const s = diagnosisState(row({
    items: 0, stale: 25,
    diagnostic: { previous: { stats: { items: 25, unanimous: 15 }, description: "old", scoped: false } },
  }), G);
  assert.equal(s.state, "awaiting");
  assert.deepEqual(s.previous.stats, { items: 25, unanimous: 15 });
});

test("a pre-stamp board is awaiting too, with no `previous` to explain why", () => {
  // Every board tagged before the stamp shipped looks like this: measured, but
  // under a definition nobody recorded. The copy has to work as a first
  // impression, not only as a follow-up to an edit.
  const s = diagnosisState(row({ items: 0, stale: 30 }), G);
  assert.equal(s.state, "awaiting");
  assert.equal(s.previous, null);
});

test("a facet nobody has ever measured is NOT awaiting — it is silent", () => {
  // Nothing changed and nothing was lost; there is simply no data. Telling the
  // user to re-tag would invent a problem.
  assert.equal(diagnosisState(row({ items: 0, stale: 0 }), G).state, "none");
});

// ─── state 5: improved ───────────────────────────────────────────────────────

test("improved: the current segment is stable and the baseline was not", () => {
  const s = diagnosisState(row({
    items: 25, unanimous: 24, scoped: true,
    diagnostic: { previous: { stats: { items: 25, unanimous: 15 }, description: "old", scoped: false } },
  }), G);
  assert.equal(s.state, "improved");
  assert.equal(s.shapeChanged, true, "full baseline vs scoped re-measurement — the delta is confounded and says so");
});

test("…and a second cycle, scoped against scoped, drops the caveat", () => {
  const s = diagnosisState(row({
    items: 25, unanimous: 24, scoped: true,
    diagnostic: { previous: { stats: { items: 25, unanimous: 15 }, description: "old", scoped: true } },
  }), G);
  assert.equal(s.state, "improved");
  assert.equal(s.shapeChanged, false);
});

test("a facet that did not actually improve is not badged as improved", () => {
  const s = diagnosisState(row({
    items: 25, unanimous: 16,
    diagnostic: { previous: { stats: { items: 25, unanimous: 15 }, description: "old", scoped: false } },
  }), G);
  assert.notEqual(s.state, "improved", "36% unstable is still over the floor");
});

test("a baseline that was already healthy produces no improvement claim", () => {
  // Otherwise every re-measurement of a stable facet congratulates the user for
  // an edit that changed nothing.
  const s = diagnosisState(row({
    items: 25, unanimous: 25,
    diagnostic: { previous: { stats: { items: 25, unanimous: 24 }, description: "old", scoped: false } },
  }), G);
  assert.equal(s.state, "none");
});

test("improvement is never claimed on too few items", () => {
  const s = diagnosisState(row({
    items: 5, unanimous: 5,
    diagnostic: { previous: { stats: { items: 25, unanimous: 15 }, description: "old", scoped: false } },
  }), G);
  assert.equal(s.state, "awaiting", "five items is not evidence of anything");
});

// ─── the dot ─────────────────────────────────────────────────────────────────

test("the dot lights for a finding, and opening the modal clears it", () => {
  store.clear();
  const facets = [row({ items: 25, unanimous: 15, diagnostic: finding({ at: 5000 }) })];
  assert.equal(diagnosticsUnseen("b1", facets, G), true);
  markDiagnosticsSeen("b1", facets);
  assert.equal(diagnosticsUnseen("b1", facets, G), false);
});

test("a finding written after the last look lights it again", () => {
  store.clear();
  const first = [row({ items: 25, unanimous: 15, diagnostic: finding({ at: 5000 }) })];
  markDiagnosticsSeen("b2", first);
  const later = [row({ items: 25, unanimous: 15, diagnostic: finding({ at: 9_999_999_999_999 }) })];
  assert.equal(diagnosticsUnseen("b2", later, G), true);
});

test("the dot does NOT light for genuinely-ambiguous-items", () => {
  // Information, not a task. A signal that reads as a to-do and resolves to
  // "nothing you can do" teaches the user to ignore the signal.
  store.clear();
  const facets = [row({ items: 25, unanimous: 15, diagnostic: finding({ verdict: "genuinely-ambiguous-items", at: 5000 }) })];
  assert.equal(diagnosticsUnseen("b3", facets, G), false);
});

test("the dot lights for an improvement — the user has to be told they won", () => {
  store.clear();
  const facets = [row({
    items: 25, unanimous: 24, scoped: true,
    diagnostic: { at: 5000, previous: { stats: { items: 25, unanimous: 15 }, description: "old", scoped: false } },
  })];
  assert.equal(diagnosticsUnseen("b4", facets, G), true);
});

test("the dot is per board", () => {
  store.clear();
  const facets = [row({ items: 25, unanimous: 15, diagnostic: finding({ at: 5000 }) })];
  markDiagnosticsSeen("b5", facets);
  assert.equal(diagnosticsUnseen("b5", facets, G), false);
  assert.equal(diagnosticsUnseen("b6", facets, G), true, "another board's finding is still unseen");
});

// ─── the payloads that feed all of it ────────────────────────────────────────

let srv, db;
before(async () => { srv = await startServer(); db = srv.db; });
after(async () => { await srv?.close?.(); });

const BF = [{ key: "shape", label: "Shape", single: true, description: "the silhouette", values: ["round", "wide"] }];

test("both surfaces are served the same rows, from the same place", async () => {
  // The facet editor and the Diagnostics modal render the same five states off
  // the same shape. Served from two hand-written projections they would drift,
  // and the drift would show as one surface disagreeing with the other about
  // whether a facet is fine.
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "ui-k", "openai", "sk-test");
  const b = await createBoard(db, "ui-board", BF, "", true, keyId);
  await updateBoard(db, b, { aiVotes: 3 });

  const stamp = facetStamp(BF[0], false);
  for (let i = 0; i < 4; i++) {
    const eid = await createEntity(db, b, { identity: `u${i}` });
    const id = await insertItem(db, b, { identity: `u${i}`, files: [], fields: {} }, "pending", eid);
    await db.query(
      "UPDATE items SET status='tagged', tag_confidence=$1 WHERE id=$2",
      [JSON.stringify({ shape: { of: 3, agreed: i === 0 ? 3 : 1, votes: { round: 2, wide: 1 }, d: stamp } }), id]
    );
  }
  await setFacetDiagnostic(db, b, "shape", finding({ d: stamp }));

  const admin = await adminSession(db);
  const stats = await req(srv.base, "GET", `/api/boards/${b}/facet-stats`, { sid: admin.sid });
  const settings = await req(srv.base, "GET", `/api/boards/${b}/settings`, { sid: admin.sid });
  assert.equal(stats.status, 200);
  assert.equal(settings.status, 200);
  assert.deepEqual(stats.json.facets, settings.json.facet_stats);
  assert.deepEqual(stats.json.gates, settings.json.facet_gates);
});

test("the gates travel with the numbers rather than being re-declared client-side", async () => {
  // A copy of the thresholds in the browser drifts the first time either is
  // retuned, and the symptom — a facet stuck "awaiting re-measurement" while
  // the loop happily re-diagnoses it — reads as a bug in neither half.
  const admin = await adminSession(db);
  const keyId = await createAiKey(db, "ui-k2", "openai", "sk-test");
  const b = await createBoard(db, "ui-board-2", BF, "", true, keyId);
  const r = await req(srv.base, "GET", `/api/boards/${b}/facet-stats`, { sid: admin.sid });
  assert.deepEqual(r.json.gates, GATES);
  assert.equal(typeof r.json.gates.minItems, "number");
  assert.equal(typeof r.json.gates.minRate, "number");
});

test("the finding rides on the row it describes", async () => {
  const admin = await adminSession(db);
  const keyId = await createAiKey(db, "ui-k3", "openai", "sk-test");
  const b = await createBoard(db, "ui-board-3", BF, "", true, keyId);
  await setFacetDiagnostic(db, b, "shape", finding());
  const r = await req(srv.base, "GET", `/api/boards/${b}/facet-stats`, { sid: admin.sid });
  assert.equal(r.json.facets[0].key, "shape");
  assert.equal(r.json.facets[0].diagnostic.verdict, "overlapping-values");
});

// ─── the header gate ─────────────────────────────────────────────────────────

test("the Diagnostics button is hidden from a viewer who cannot edit facets", () => {
  // Same cluster as the edit pencil, deliberately unlike the jobs chip — the
  // log is transparency, a facet suggestion is only useful to someone who can
  // act on it.
  assert.equal(canSeeDiagnostics({ boardManage: false, boardVotes: 3 }), false);
});

test("…and hidden on a single-pass board, which measures nothing to show", () => {
  // Asserted separately from the half above on purpose: either one alone still
  // leaves a button, and it opens something useless in a different way.
  assert.equal(canSeeDiagnostics({ boardManage: true, boardVotes: 1 }), false);
  assert.equal(canSeeDiagnostics({ boardManage: true, boardVotes: 3 }), true);
});
