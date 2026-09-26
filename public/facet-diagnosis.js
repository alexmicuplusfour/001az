// The diagnosis ENGINE: what state a facet is in, whether the header dot should
// be lit, and the stats fetch that feeds both. Everything here runs on every
// render or on signals.js's 20-second tick, so it is always loaded.
//
// Split out of facet-diagnostics.js, which is now only the SURFACE — the
// modal and the editor block — and is fetched when one of those is opened.
// The two halves were one 606-line file, roughly half of which nothing needs
// until a reader asks to see a diagnosis.
//
// `diagnosisState` lives here rather than in either surface because both need
// it and it is the part that fails quietly: every wrong answer it can give is a
// plausible-looking box in a modal nobody cross-checks.
import { state } from './state.js';
import { api } from './api.js';
import { unseen, markSeen, DIAG_SEEN as SEEN } from './seen-mark.js';

// Which of the five states a facet is in, from one roll-up row (server shape:
// { key, label, items, unanimous, d, scoped, stale, diagnostic }).
//
// Order is load-bearing and not obvious:
//
// - *awaiting* outranks everything, because below the item minimum the stored
//   finding describes measurements that are no longer being counted. Rendering
//   the paragraph anyway is the failure the definition stamp exists to prevent,
//   one layer up.
// - *improved* outranks a finding, but they barely collide in practice: an edit
//   demotes the verdict, so a facet that has improved since one has no verdict
//   left to show. The ordering matters for the case where it does — a facet
//   re-diagnosed after a partial fix — and there the news is the movement.
// - *none* covers `no-problem-found` AND no entry at all, and they must render
//   identically. **Absence must never read as "fine"**: a single-pass board has
//   no diagnostics whatsoever, and its empty state has to look exactly like it
//   does today.
export function diagnosisState(row, ctx = {}) {
  const minItems = ctx.minItems ?? 20;
  const minRate = ctx.minRate ?? 0.30;  // fallback only; the server serves the real one
  const maxAttempts = ctx.maxAttempts ?? 3;
  // Items queued to rewrite THIS facet — not "the board is busy". A scoped
  // retag on one facet leaves the other eight untouched, and treating their
  // items as in-flight hid eight facets' worth of current measurements and told
  // the user to re-tag facets that nothing was going to re-measure.
  //
  // And only when enough of the facet's own sample is in the queue to make its
  // figures misleading (sampleThin). Any-queue-at-all put "re-tagging this
  // facet" on rows whose numbers were 99.8% complete.
  const queued = sampleThin(row) ? row.queued : 0;
  const entry = row?.diagnostic || null;
  const previous = entry?.previous || null;
  const items = row?.items || 0;
  const rate = items ? (items - row.unanimous) / items : 0;

  // Below the minimum, ANY of the three things that could be said about this
  // facet is "we cannot judge it yet" — the stored finding included. The
  // finding's own numbers came from a sample that is no longer being counted,
  // and `rate` here is computed from what is left, so letting it through renders
  // a paragraph explaining an inconsistency above a headline that reports 0%.
  //
  // The third disjunct is the one the first pass missed. `previous` covers an
  // edit and `stale` covers a pre-stamp board, but ordinary curation is neither:
  // setItemTags DELETES a corrected facet's confidence entry rather than
  // re-stamping it, so a board whose contested items have been hand-fixed comes
  // back items: 3, stale: 0, previous: null — with the finding still stored.
  // That is the sampling bias §10 names, arriving as a rendering bug.
  if (items < minItems && (previous || (row?.stale || 0) > 0 || entry?.verdict)) {
    // A pass is running: the sample did not go away, it is in the queue. Saying
    // "not measured — re-tag this board" here is false AND actively harmful, it
    // asks for a second retag on top of the one already running (which
    // retagBoardFacets would silently no-op anyway, since an armed row is
    // `pending` and it only takes `tagged` ones).
    if (queued) return { state: "measuring", previous, items, rate, queued };
    return { state: "awaiting", previous, items, rate };
  }
  if (previous?.stats?.items) {
    const was = (previous.stats.items - previous.stats.unanimous) / previous.stats.items;
    if (items >= minItems && rate < minRate && was >= minRate) {
      return {
        state: "improved", previous, items, rate, was,
        // The first delta after adopting the loop straddles a prompt-shape
        // change and is confounded; every later one is clean. Say so rather
        // than quietly presenting it as like-for-like.
        shapeChanged: previous.scoped !== row.scoped,
      };
    }
  }
  // A stored finding is shown only while it still describes what is measured
  // NOW — same sample, and a facet that still reads unstable.
  //
  // Both halves are about the same thing: nobody wants to be told about a run
  // that has been superseded. Re-tag a board and the old paragraph is an answer
  // to a question nobody is asking any more; the loop will replace it within a
  // settled tick, and until it does, silence is the honest rendering. Showing
  // it with the live percentage above it (which is what this did) makes a
  // superseded finding look freshly computed, and showing it with its own
  // percentage just adds a second number to reconcile.
  //
  // `row.current` is the SERVER's answer, from the same sampleKey() the loop
  // gates on — not a comparison made here. That is deliberate: the reader must
  // hide exactly what the loop re-diagnoses, and a second implementation of
  // "has the evidence moved" in the browser would drift from the first, leaving
  // a facet silent with nothing coming to replace it. Undefined means the entry
  // predates the key, and then showing it beats hiding something we cannot
  // reason about.
  //
  // The rate test is the plainer of the two, and local because it needs
  // nothing: a facet at 86% consistent against a 70% floor is not a problem,
  // whatever a paragraph written when it was 60% has to say about it.
  // `entry?.` and not `entry.` — `current` used to imply an entry existed (it
  // was computed from entry.stats) and no longer does, so an unstable facet
  // that has never been diagnosed reaches here with entry === null. That is the
  // commonest row on any board: every facet is in it until its first diagnosis.
  const current = row?.current !== false && rate >= minRate;
  const renderable = entry?.verdict && entry.verdict !== "no-problem-found" && entry.explanation;
  if (current && entry?.verdict === "genuinely-ambiguous-items") return { state: "note", entry, items, rate };
  if (current && renderable) return { state: "finding", entry, items, rate };

  // Nothing to report right now, and there are two ways to be here. The evidence
  // moved under a stored finding (`current === false`), or a re-read was ATTEMPTED
  // and the provider refused — `attempted()` writes an entry carrying attempts and
  // an error and no verdict, deliberately, because a failed call has no claim to
  // make about the taxonomy.
  //
  // Either way the facet has to say something. Without this it renders blank,
  // which is identical to "nothing wrong here" — and one provider blip used to be
  // enough: the finding was destroyed by the attempt that replaced it, `renderable`
  // went false, and a facet mid-re-read went silent with an error nobody could see.
  //
  // The rate floor is re-tested rather than taken from `current`, and it is the
  // half that decides whether anything is COMING: under the floor gate 4 means the
  // loop will not re-ask at all, so a facet that simply got better keeps the
  // silence it has earned.
  const failing = entry?.attempts > 0 && !entry.verdict;
  if (rate >= minRate && (failing || (row?.current === false && renderable))) {
    // Out of tries. The loop has stopped, and only new measurements will restart
    // it, so "re-reading this facet" would be the promise #43 went to the trouble
    // of making true everywhere else. Say what actually happened instead — this is
    // the only surface on which a user learns their provider is refusing.
    if (failing && entry.attempts >= maxAttempts) {
      return { state: "unreadable", items, rate, error: entry.error };
    }
    return { state: "rereading", items, rate, queued };
  }
  if (!items && queued) return { state: "measuring", previous: null, items, rate, queued };
  return { state: "none", items, rate };
}


// Is enough of this facet's sample in the queue to make its figures misleading?
//
// Queued items drop out of the roll-up entirely (it counts `tagged` rows), so
// the percentage shown is computed over what is left. Five of 2,500 leaves a
// reading over 2,495 items, which is not "partial" by any honest use of the
// word — but the check was `queued > 0`, so a five-item retag put a banner over
// nine facets announcing that every figure below was unreliable.
//
// The threshold is not a taste: RATE_BUCKET is five points, and if the missing
// slice is smaller than that it cannot move the reading by a whole bucket even
// if every queued item came back the opposite way. Below it there is nothing
// truthful to warn about.
const RATE_BUCKET = 0.05;
export const sampleThin = (row) => {
  const queued = row?.queued || 0;
  return queued > 0 && queued / (queued + (row?.items || 0)) >= RATE_BUCKET;
};
// Whether the header shows the door at all. Both halves are load-bearing and
// each alone leaves a button that opens something useless: without
// `boardManage` a reader gets a facet suggestion they cannot act on, and
// without vote mode the modal is permanently empty, because a single-pass board
// writes no confidence at all ({} is NOT MEASURED, never zero).
export const canSeeDiagnostics = (s) => !!s.boardManage && Number(s.boardVotes) > 1;

// The roll-up is board-manager data on its own endpoint, so it is deliberately
// not in the gallery's board payload. Cached on state and re-rendered on
// arrival — the refreshBoardIngest pattern.
//
// This used to be the ONLY read: once per page load, guarded, and then never
// again, so a finding the diagnose loop wrote at minute five of a session did
// not exist until the tab was reloaded. The dot it feeds is the whole point of
// the feature and it was the least live thing on the header. The repeat read is
// signals.js's now; what stays here is the first one and the shape of the data.
export async function refreshFacetStats() {
  try {
    const d = await api("GET", `/api/boards/${state.boardId}/facet-stats`);
    // The gates first. The board page reads the dots on every write, and the
    // stats are what makes this dot readable (announce.js's ready()), so a
    // first reading with the fallback gates could make a finding already there
    // look new the moment the served ones land.
    state.facetGates = d.gates || {};
    state.facetStats = d.facets || [];
  } catch {
    // Left exactly as found, which for a first read means `null` stands.
    //
    // This used to fall back to [] "so there is no dot rather than a broken
    // header" — defending against a hazard that did not exist. state.facetStats
    // has two readers (toolbar.js, announce.js) and both hand it straight to
    // diagnosticsUnseen, whose first line is `(facets || [])`; null was always
    // safe. What the fallback DID do was destroy the sentinel announce.js reads
    // through ready(), recording a baseline of "nothing here" for a signal whose
    // data never arrived — which is precisely how a pre-existing finding
    // announces itself as new a minute later.
    //
    // And a failed REFRESH must not throw away findings already on screen,
    // which is the same rule stated for the other direction.
  }
}

// The first read, from the toolbar. Keyed on the board id so switching boards
// re-fetches, and marked BEFORE the request so a burst of toolbar rebuilds
// fires one.
let statsFetchedFor = null;
export function ensureFacetStats() {
  if (statsFetchedFor === state.boardId) return;
  statsFetchedFor = state.boardId;
  refreshFacetStats();
}

// The dot's memory (seen-mark.js — the jobs chip's dot keeps its in the same
// place, for the same reasons). Keyed on the newest `at` the board carries, so
// a finding written after the user last looked re-lights it. The scope string
// is the storage prefix and predates the shared module: leave it alone. It lives
// in seen-mark.js, which owns the keyspace, because the boards index compares
// against this same mark.

const newestAt = (facets = []) =>
  facets.reduce((n, f) => Math.max(n, Number(f.diagnostic?.at) || 0), 0);

// Lit by states 1 and 5 only. `genuinely-ambiguous-items` is information, not a
// task, and must not raise a signal that reads as a to-do.
export function diagnosticsUnseen(boardId, facets, gates) {
  const worth = (facets || []).filter((f) => {
    const s = diagnosisState(f, gates).state;
    return s === "finding" || s === "improved";
  });
  if (!worth.length) return false;
  return unseen(SEEN, boardId, newestAt(worth));
}

export function markDiagnosticsSeen(boardId, facets) {
  markSeen(SEEN, boardId, newestAt(facets));
}

