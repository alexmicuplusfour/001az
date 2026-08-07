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
// Just enough element for diagnosisBlock to build its tree. Deliberately tiny:
// the assertions below read the tree the module produces, not this shim's
// behaviour, so the only thing it has to get right is structure.
const el = (tag) => ({
  tag, className: "", textContent: "", hidden: false, children: [], attrs: {},
  appendChild(c) { this.children.push(c); return c; },
  prepend(c) { this.children.unshift(c); return c; },
  setAttribute(k, v) { this.attrs[k] = v; },
});
globalThis.document ||= {
  addEventListener() {}, dispatchEvent() { return true; }, createElement: el,
};
globalThis.document.createElement ||= el;

// `navigator` is an accessor on globalThis in Node, so it cannot be assigned —
// swap the property for the call and put the original descriptor back. Passing
// `undefined` gives a navigator with no `clipboard` at all, which is what plain
// HTTP looks like.
function withClipboard(clipboard, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: clipboard ? { clipboard } : {}, configurable: true });
  try { return fn(); }
  finally {
    if (had) Object.defineProperty(globalThis, "navigator", had);
    else delete globalThis.navigator;
  }
}

// Depth-first text of a built block, which is what a reader actually sees.
const textOf = (n) => (n.textContent || "") + n.children.map(textOf).join("");
const find = (n, cls) => (n.className?.split(" ").includes(cls) ? n : n.children.reduce((h, c) => h || find(c, cls), null));
const { diagnosisState, diagnosticsUnseen, markDiagnosticsSeen, canSeeDiagnostics, diagnosisBlock } = await import("../public/facet-diagnostics.js");

const G = { minItems: 20, minRate: 0.30 };

// One roll-up row, as the server serves it.
const row = (over = {}) => ({
  key: "shape", label: "Shape", items: 0, unanimous: 0, d: null, scoped: null, stale: 0, queued: 0, diagnostic: null,
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

test("a re-measured sample discards the old finding — it does not annotate it", () => {
  // Reported from the running app, twice. The first version paired the LIVE
  // percentage with the STORED paragraph, so a retag looked like it had
  // refreshed the finding. The second explained the gap in a sentence, which
  // nobody asked for and nobody could parse: "Written against 25 items; 133 now
  // carry a measurement of this wording."
  //
  // The answer is neither. A superseded finding is not a finding — the loop
  // will replace it within a settled tick, and until then the honest rendering
  // is nothing at all.
  // `current: false` is the SERVER's answer, from the same sampleKey() the loop
  // gates on. The client deliberately does not recompute it — a second
  // implementation would drift, and a facet hidden by a check the loop does not
  // share never gets a replacement.
  const superseded = () => row({
    items: 133, unanimous: 84, current: false,
    diagnostic: finding({ stats: { items: 25, unanimous: 15 } }),
  });
  const t = textOf(diagnosisBlock(superseded(), G));
  assert.doesNotMatch(t, /round and wide overlap/, "the superseded explanation is gone");
  assert.doesNotMatch(t, /prefer wide/, "…and so is the wording it wanted pasted over the description");
  assert.doesNotMatch(t, /contradicted itself/, "…and the headline that made it look freshly computed");

  // …and an entry the server vouched for still shows, on the same numbers.
  const vouched = row({ items: 133, unanimous: 84, current: true, diagnostic: finding() });
  assert.equal(diagnosisState(vouched, G).state, "finding");
});

test("an unstable facet nobody has diagnosed yet does not throw", () => {
  // The commonest row on any board — every facet is in this state until its
  // first diagnosis lands. `current` used to be computed FROM the entry, so it
  // could not be true without one; now it comes from the server and can be, and
  // the verdict lookup under it went from safe to a null dereference. Nothing
  // else in the file covers "over the rate floor, no entry".
  const s = diagnosisState(row({ items: 40, unanimous: 20 }), G);
  assert.equal(s.state, "none");
  assert.equal(diagnosisBlock(row({ items: 40, unanimous: 20 }), G), null);
});

test("a superseded finding says a re-reading is coming, rather than going blank", () => {
  // Blank is the same rendering as "nothing wrong here", which is how a reader
  // ends up asking whether the feature is working at all. The wait is a few
  // minutes — the loop holds until the board settles.
  const s = diagnosisState(row({ items: 133, unanimous: 84, current: false, diagnostic: finding() }), G);
  assert.equal(s.state, "rereading");
  assert.match(textOf(diagnosisBlock(row({ items: 133, unanimous: 84, current: false, diagnostic: finding() }), G)),
    /measurements have changed/);

  // With a retag still draining it names that instead, since "re-reading" would
  // understate a job the user can watch.
  const draining = row({ items: 133, unanimous: 84, current: false, queued: 900, diagnostic: finding() });
  assert.match(textOf(diagnosisBlock(draining, G)), /900 items still queued/);
});

test("a facet under the rate floor is silent, not 'being re-read'", () => {
  // Both conditions live in one `current`, and only one of them means a
  // replacement is coming. A facet that simply got better has earned silence.
  const better = row({ items: 133, unanimous: 120, current: false, diagnostic: finding() });
  assert.ok((133 - 120) / 133 < G.minRate);
  assert.equal(diagnosisState(better, G).state, "none");
});

test("a finding says when it was written", () => {
  // Stored since the column shipped and never rendered. A finding outliving a
  // tagging run is now the CORRECT outcome when the evidence did not move, so
  // its age is the difference between "still true" and "forgotten".
  const t = textOf(diagnosisBlock(row({
    items: 25, unanimous: 15, current: true,
    diagnostic: finding({ at: Date.now() - 3 * 86400000 }),
  }), G));
  assert.match(t, /Diagnosed 3d ago\./);
});

test("a facet that now reads healthy shows no warning, whatever is stored", () => {
  // 86% consistent against a 70% floor. The paragraph was written when it was
  // worse and is not a claim about this. Independent of the sample test above,
  // and cheap to state, because "why am I being warned about a facet that is
  // fine" is the question it exists to never provoke.
  const healthy = row({ items: 133, unanimous: 115, diagnostic: finding({ stats: { items: 133, unanimous: 115 } }) });
  assert.ok((133 - 115) / 133 < G.minRate, "the fixture really is under the threshold");
  assert.equal(diagnosisState(healthy, G).state, "none");
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


// ─── density: the editor reports, the modal explains ────────────────────────

const bigFinding = () => row({
  items: 25, unanimous: 17,
  diagnostic: finding({
    // Coherent with the row on purpose: these tests are about LAYOUT, and a
    // fixture whose stored stats disagree with its row would make every
    // headline assertion here quietly also a drift assertion.
    stats: { items: 25, unanimous: 17 },
    explanation: "minimalist-modern and geometric-modernist overlap badly across most of the disputed marks.",
    rewrite: "The dominant stylistic school of the mark. Use minimalist-modern for reduced, clean, contemporary marks; use geometric-modernist for marks built from strict geometry, and prefer it whenever both could apply.",
  }),
});

test("the facet editor gets the headline, never the content", () => {
  // The complaint this exists to prevent: a finding rendered at survey size is
  // a panel taller than the facet it belongs to, pushing that facet's own
  // values off screen. The editor is a stack of 28px rows.
  const block = diagnosisBlock(bigFinding(), G, { compact: true });
  const t = textOf(block);
  assert.match(t, /The tagger contradicted itself on 32% of items\./,
    "worded exactly as the modal words it — one finding, one sentence");
  assert.doesNotMatch(t, /geometric-modernist/, "no explanation here");
  assert.doesNotMatch(t, /Suggested description/, "and no proposal here");
  // ONE sentence on the line. A second one pointing at the modal wrapped into a
  // column beside the first and broke the row it had to fit in.
  assert.doesNotMatch(t, /See Tagging consistency/);
});

test("the editor carries no control at all, in either density's vocabulary", () => {
  // The two surfaces have separate jobs and the compact one has nowhere to put
  // an action. Asserted by class rather than by text because the failure this
  // replaces was structural: `diagnosisBlock` used to take an apply callback,
  // honour it only in the density with nowhere to put it, and be handed one only
  // by the density that dropped it — so the control the plan describes rendered
  // in NEITHER surface, for two commits, with this file green. The parameter is
  // gone; what is left is the assertion that nothing sneaks back in.
  const block = diagnosisBlock(bigFinding(), G, { compact: true });
  assert.equal(find(block, "fd-copy"), null);
  assert.equal(find(block, "fd-rewrite"), null);
  assert.equal(find(block, "fd-suggestion"), null);
});

test("the modal hands the proposed wording over, because it is the only surface holding it", () => {
  // `onEdit` CLOSES this dialog before opening the board editor, and the editor
  // renders the headline alone — so between the two the proposal leaves the
  // screen entirely. Without a way to take it, the user is asked to reproduce
  // three sentences from memory into a two-row textarea.
  const block = diagnosisBlock(bigFinding(), G, { collapsible: true });
  const btn = find(block, "fd-copy");
  assert.ok(btn, "the copy control is present in the density that shows the text");

  let wrote = null;
  withClipboard({ writeText: (t) => { wrote = t; return Promise.resolve(); } }, () => btn.onclick());
  assert.equal(wrote, bigFinding().diagnostic.rewrite,
    "the whole proposal, verbatim — not the headline and not a truncation");
});

test("…and says so on the button when there is no clipboard to write to", () => {
  // Plain HTTP has no navigator.clipboard at all. The optional chain yields
  // undefined and `.then` would throw inside an onclick, where nothing surfaces
  // it — leaving a control that does nothing when pressed, which is the one
  // failure mode this file already carries an example of.
  const btn = find(diagnosisBlock(bigFinding(), G, { collapsible: true }), "fd-copy");
  withClipboard(undefined, () => btn.onclick());
  assert.equal(btn.textContent, "couldn't copy");
});

test("the modal folds each finding, and opens to the whole thing", () => {
  // The survey is the list of facets and their numbers; the essays are what you
  // open one of. Six findings unfolded is the wall of text again, one surface
  // over.
  const folded = diagnosisBlock(bigFinding(), G, { collapsible: true });
  assert.equal(find(folded, "fd-detail").hidden, true, "folded by default");
  assert.match(textOf(find(folded, "fd-toggle")), /contradicted itself on 32%/);

  const block = diagnosisBlock(bigFinding(), G);
  const t = textOf(block);
  assert.match(t, /The tagger contradicted itself on 32% of items\./);
  assert.match(t, /geometric-modernist/);
  assert.match(t, /Suggested description/);
  assert.doesNotMatch(t, /See Tagging consistency/, "it IS Tagging consistency");
});

test("a one-line state says its whole piece in the editor", () => {
  // `awaiting` and `improved` are one sentence each and complete in themselves.
  const block = diagnosisBlock(row({ items: 0, stale: 25 }), G, { compact: true });
  const t = textOf(block);
  assert.match(t, /Not measured against the current wording yet/);
  assert.doesNotMatch(t, /See Tagging consistency/);
});


// ─── a retag in flight is not an absence of data ────────────────────────────

test("a facet being re-tagged says so, rather than that it was never measured", () => {
  // Reported from the running app: a scoped retag moved most of the board to
  // `pending`, the roll-up counted only TAGGED items, and every facet reported
  // "Not measured against the current wording yet. Re-tag this board on X." The
  // measurements were never gone, and the advice was to start a second retag on
  // top of the one already running.
  const s = diagnosisState(row({ items: 0, stale: 0, queued: 1827 }), G);
  assert.equal(s.state, "measuring");
  assert.equal(s.queued, 1827);

  const block = diagnosisBlock(row({ items: 0, stale: 0, queued: 1827 }), G, { compact: true });
  const t = textOf(block);
  assert.match(t, /Re-tagging this facet — 1,827 items still queued/);
  assert.doesNotMatch(t, /Re-tag this board/, "never ask for a retag while one is running");
});

test("a facet the retag does NOT touch keeps reporting its own numbers", () => {
  // The second half of the same report, and the sharper half: a scoped retag on
  // `construction` armed 1,579 items for construction ALONE. Every other facet's
  // stored answer was untouched and still current — `scopeResult` preserves them
  // — so treating "the board is busy" as if it applied to all nine hid eight
  // facets' worth of live measurements behind a re-tagging notice.
  const untouched = row({ items: 25, unanimous: 17, queued: 0, diagnostic: finding({ stats: { items: 25, unanimous: 17 } }) });
  assert.equal(diagnosisState(untouched, G).state, "finding");
  assert.doesNotMatch(textOf(diagnosisBlock(untouched, G, { compact: true })), /Re-tagging/);
});

test("a facet stranded by an edit still says so once the queue is empty", () => {
  // The `awaiting` copy is right when nothing is in flight — that is the
  // designed path, and the user genuinely does need to re-tag.
  const stranded = row({ items: 0, stale: 25 });
  assert.equal(diagnosisState(stranded, G).state, "awaiting");
  assert.match(textOf(diagnosisBlock(stranded, G, { compact: true })), /Re-tag this board/);
});

test("a facet with a real sample reports it even while its own retag drains", () => {
  // Partial, but partial of something — the banner is what says so.
  const s = diagnosisState(row({ items: 25, unanimous: 17, queued: 900, diagnostic: finding({ stats: { items: 25, unanimous: 17 } }) }), G);
  assert.equal(s.state, "finding");
});

test("five queued items on a board of 2,228 is not a re-tagging notice", () => {
  // Reported from the running app: retagging five items put "Re-tagging this
  // facet — 5 items still queued" on three facets and a banner over all nine
  // saying every figure below was partial. The reading was over 2,223 of 2,228
  // items — 99.8% complete.
  //
  // The threshold is RATE_BUCKET, not a preference: five points is the
  // granularity at which the rate is judged everywhere else, and a slice
  // smaller than that cannot move the reading by a bucket even if every queued
  // item came back the other way.
  const thin = row({ items: 2223, unanimous: 1400, queued: 5, diagnostic: finding({ stats: { items: 2223, unanimous: 1400 } }) });
  assert.equal(diagnosisState(thin, G).state, "finding", "the finding is untouched");
  assert.doesNotMatch(textOf(diagnosisBlock(thin, G)), /Re-tagging|still queued/);

  // …and a retag that HAS taken the sample away still says so. The per-facet
  // notice is for a facet with nothing left to report; the banner above the list
  // is what qualifies a reading that is merely incomplete.
  const drained = row({ items: 10, unanimous: 5, queued: 1100, diagnostic: finding() });
  assert.match(textOf(diagnosisBlock(drained, G)), /1,100 items still queued/);
});
