// The reader's half of facet diagnosis (planning/facet-diagnosis-plan.md §6).
//
// Three surfaces, each with one job. The **Diagnostics button** in the gallery
// header is the door and the attention signal; the **Diagnostics modal** is the
// survey and is read-only; the **facet editor** (board-modal.js) is where the
// fix is typed and is the only writer. The repetition between the last two is
// deliberate — if the modal could apply a suggestion it would become a second
// writer into boards.facets, which is the exact race the worker-owned
// facet_diagnostics column exists to avoid.
//
// `diagnosisState` lives here rather than in either surface because both need
// it and it is the part that fails quietly: every wrong answer it can give is a
// plausible-looking box in a modal nobody cross-checks.
import { state } from './state.js';
import { api } from './api.js';
import { createModal } from './modal.js';
import { ICONS, fmtDuration, relTime } from './utils.js';
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

const pct = (n) => `${Math.round(n * 100)}%`;

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
const sampleThin = (row) => {
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
    state.facetStats = d.facets || [];
    state.facetGates = d.gates || {};
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
  refreshFacetStats().then(() => document.dispatchEvent(new Event('app:render')));
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

// The only control on a read-only surface, and the one that closes the loop.
//
// This modal is the ONLY place the proposed wording is rendered — the facet
// editor deliberately shows the headline and nothing else — and `onEdit` CLOSES
// this dialog before opening the editor. So without this the user is asked to
// carry three sentences across a modal boundary from memory, which is the one
// step where the model's proposal, the whole point of the feature, is not on
// screen.
//
// It copies rather than applies for the reason the two surfaces are split at
// all: a control here that wrote the description would make this a second
// writer into `boards.facets`, which is the race the worker-owned
// `facet_diagnostics` column exists to avoid. The clipboard crosses the
// boundary; the editor stays the only writer.
function copyControl(text) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "fd-copy";
  b.textContent = "copy";
  const flash = (t) => { b.textContent = t; setTimeout(() => { b.textContent = "copy"; }, 1200); };
  b.onclick = () => {
    // Not `navigator.clipboard?.writeText(…).then(…)`: over plain HTTP there is
    // no `clipboard` at all, the optional chain yields undefined, and `.then`
    // throws into an onclick where nobody sees it. Say so on the button instead
    // — a control that does nothing when pressed is the failure this file
    // already carries one of (the modal's own swallowed fetch).
    const p = navigator.clipboard?.writeText(text);
    if (!p) return flash("couldn't copy");
    p.then(() => flash("copied"), () => flash("couldn't copy"));
  };
  return b;
}

// One facet's block, in two densities.
//
// The Tagging consistency modal owns the CONTENT — the explanation and the
// proposed description — and keeps each finding folded until asked, so the
// survey stays a survey and you open the one you care about. The facet editor
// gets the headline and nothing else: it is a dense stack of 28px rows, and a
// finding rendered there at any size worth reading is a panel taller than the
// facet it belongs to.
//
// So one surface reports and one explains, and neither pretends to be the other.
// Neither of them WRITES either: the modal offers the proposed wording as a copy
// and the editor offers nothing at all.
//
// There is deliberately no apply callback. The first version took one, honoured
// it only in the density that had nowhere to put it, and was passed one only by
// the density that dropped it — so the control the plan describes existed in
// NEITHER surface, for two commits, with a green suite. A parameter that can be
// handed in and silently ignored is what made that possible, so the parameter is
// gone rather than fixed.
//
// The two densities also differ in WHICH states they carry, and that is the
// second half of "one surface reports and one explains".
//
// A state is either a MEASUREMENT of the facet — a finding, a note that these
// items are genuinely mixed, a rate that improved — or a report on the pipeline:
// nothing measured yet, a retag draining, evidence that moved and a re-read
// coming. The survey modal is where you go to ask about tagging consistency, so
// it answers all six; the pipeline states are most of what it has to say on a
// board that has just been re-tagged, and saying nothing there would read as
// "no problem here".
//
// The editor is not that surface. You opened it to write a description, and a
// grey panel under every facet saying "Not measured against the current wording
// yet. Re-tag this board on Use Case / Domain" is nine copies of a sentence
// about the queue wrapped around the field you are trying to type in — and on a
// board that has never been vote-tagged it is EVERY facet, permanently, because
// that state is the whole board's condition rather than any one facet's news.
export const EDITOR_STATES = new Set(["finding", "note", "improved"]);

export function diagnosisBlock(row, gates, { compact = false, collapsible = false } = {}) {
  const s = diagnosisState(row, gates);
  if (s.state === "none") return null;
  if (compact && !EDITOR_STATES.has(s.state)) return null;

  const el = document.createElement("div");
  // The tone carries the message, and it is one of the three shared notice
  // shells (styles.css) rather than a private palette: amber wants attention,
  // grey has nothing to say yet, green says this got better.
  const tone = { finding: "warn-box", improved: "good-box" }[s.state] || "mute-box";
  el.className = `fd-block ${tone} fd-${s.state}` + (compact ? " fd-compact" : "");

  const head = document.createElement(collapsible ? "button" : "div");
  head.className = compact ? "fd-sum" : "fd-head";
  if (collapsible) { head.type = "button"; head.className += " fd-toggle"; }
  el.appendChild(head);

  // The same glyph as the toolbar button this finding came from, so the line
  // reads as belonging to that feature rather than as a generic form warning.
  if (compact) {
    const icon = document.createElement("span");
    icon.className = "fd-icon";
    icon.innerHTML = ICONS.doubleCheck;
    head.appendChild(icon);
  }
  // A span, not the head's own textContent: the head has children now, and
  // assigning textContent to a parent deletes them.
  const headText = document.createElement("span");
  head.appendChild(headText);
  const setText = (t) => { headText.textContent = t; };

  // The age, on the headline row and pushed right. Bare — "3m ago", not
  // "Diagnosed 3m ago" — because the line it sits on already says what was
  // diagnosed, and the word was doing nothing the sentence beside it wasn't.
  //
  // Up here rather than at the foot of the detail so it survives BOTH the
  // compact variant (the facet editor, which is a headline and nothing else)
  // and the folded collapsible one. It matters most exactly where it used to be
  // invisible: a finding that outlives a tagging run is now the correct outcome
  // when the evidence did not move, so its age is what separates "still true"
  // from "forgotten".
  if (s.entry?.at) {
    const when = document.createElement("span");
    when.className = "fd-when";
    when.textContent = relTime(s.entry.at);
    head.appendChild(when);
  }

  if (s.state === "measuring") {
    setText(`Re-tagging this facet — ${s.queued.toLocaleString()} item${s.queued === 1 ? "" : "s"} still queued. Its figures return as they land.`);
    return el;
  }

  if (s.state === "rereading") {
    setText(s.queued
      ? `Re-tagging this facet — ${s.queued.toLocaleString()} item${s.queued === 1 ? "" : "s"} still queued. A fresh reading follows.`
      : `The measurements have changed. Re-reading this facet.`);
    return el;
  }

  // The provider's own words, on the ingest-modal precedent (`error: <message>`).
  // Raw rather than softened: "something went wrong" would send someone to the
  // logs, and the whole point of this state is that the logs were the only place
  // this had ever been said.
  if (s.state === "unreadable") {
    setText(s.error
      ? `Couldn't re-read this facet — ${s.error}`
      : `Couldn't re-read this facet. It will try again when the measurements next change.`);
    return el;
  }

  if (s.state === "awaiting") {
    // Three ways to be here and they are not one sentence. An edit is the
    // designed path; nothing measured at all is the pre-stamp board; and a
    // handful of items is what curation leaves behind, where "not measured yet"
    // would be a plain lie — those items WERE measured, there are just too few
    // of them left to say anything.
    setText(
      s.previous
        ? `This description changed. Re-tag this board on ${row.label} to measure whether it helped.`
        : s.items
          ? `Only ${s.items} item${s.items === 1 ? "" : "s"} still carry a measurement of the current wording — too few to judge. Re-tag this board on ${row.label}.`
          : `Not measured against the current wording yet. Re-tag this board on ${row.label} to see how stable it is.`,
    );
    return el;
  }

  if (s.state === "improved") {
    const was = (s.previous.stats.items - s.previous.stats.unanimous) / s.previous.stats.items;
    // Agreement, never accuracy: a facet applied wrongly but consistently scores
    // 100% here and is invisible to the whole feature. And never "your edit did
    // this" — hand-corrections between the two measurements move the same
    // number, and nothing here can tell the two apart.
    setText(`${pct(1 - was)} consistent before, ${pct(1 - s.rate)} now.`);
    if (s.shapeChanged && !compact) {
      const note = document.createElement("div");
      // Not "fd-note" — that is the state class of the whole ambiguous block.
      note.className = "fd-caveat";
      note.textContent = "(re-measured on this facet alone, which is a slightly different prompt — the next comparison will be like-for-like.)";
      el.appendChild(note);
    }
    return el;
  }

  // s.rate is the finding's own rate here: diagnosisState only reaches these
  // two states while the stored sample and the live one are the same numbers.
  setText(
    s.state === "note"
      ? `The tagger contradicted itself on ${pct(s.rate)} of items, and the wording may not be the reason.`
      : `The tagger contradicted itself on ${pct(s.rate)} of items.`,
  );
  // The headline is the whole compact block. It used to carry "See Tagging
  // consistency for the detail." as well, which was a second sentence competing
  // for a line already too narrow for the first — it wrapped into a column
  // beside the finding and broke the row. The glyph in front of the line
  // already names the surface it came from.
  if (compact) return el;

  const detail = document.createElement("div");
  detail.className = "fd-detail";
  const into = collapsible ? detail : el;

  const why = document.createElement("div");
  why.className = "fd-why";
  why.textContent = s.entry.explanation;
  into.appendChild(why);


  // A REPLACEMENT description, not a sentence to bolt on. Appending was the
  // original design and it was wrong in both directions: where the current
  // wording already tries to draw the distinction and fails, a second sentence
  // saying it harder is worse than saying it once properly — and two or three
  // diagnose-and-apply cycles leave a description that is one original plus
  // three appendages.
  if (s.state === "finding" && s.entry.rewrite) {
    const sug = document.createElement("div");
    sug.className = "fd-suggestion";
    // A label rather than a box of its own: the explanation and the replacement
    // wording are one thought, and framing the second half separately made the
    // notice read as two nested panels. The heading does the separating.
    const cap = document.createElement("div");
    cap.className = "fd-rewrite-head";
    const capText = document.createElement("span");
    capText.className = "fd-rewrite-cap";
    capText.textContent = "Suggested description";
    cap.appendChild(capText);
    cap.appendChild(copyControl(s.entry.rewrite));
    sug.appendChild(cap);
    const quoted = document.createElement("div");
    quoted.className = "fd-rewrite";
    quoted.textContent = s.entry.rewrite;
    sug.appendChild(quoted);
    into.appendChild(sug);
  }

  if (collapsible) {
    el.appendChild(detail);
    const caret = document.createElement("span");
    caret.className = "fd-caret";
    caret.textContent = "›"; // points right; expanding turns it down
    head.prepend(caret);
    const show = (on) => {
      detail.hidden = !on;
      head.setAttribute("aria-expanded", String(on));
    };
    show(false); // folded by default — the survey is the list, not the essays
    head.onclick = () => show(detail.hidden);
  }
  return el;
}

// ─── the modal ───────────────────────────────────────────────────────────────

// Read-only. Every facet carrying confidence data, its stability, and its
// finding if it has one. Two controls, neither of which writes: a finding's
// proposed wording can be copied, and one link hands the user off to the board
// modal, which is the only place a description can actually be changed.
export async function openDiagnosticsModal({ onEdit } = {}) {
  let data;
  try { data = await api("GET", `/api/boards/${state.boardId}/facet-stats`); }
  catch { return; }

  const facets = data.facets || [];
  const gates = data.gates || {};
  // Opening the modal is the freshest read there is — keep the toolbar's copy
  // in step so the dot clears against the same data the user just saw.
  state.facetStats = facets;
  state.facetGates = gates;
  markDiagnosticsSeen(state.boardId, facets);
  document.dispatchEvent(new Event('app:render')); // clear the dot

  document.getElementById("facet-diagnostics-modal")?.remove();
  const { body, footer, close } = createModal({ id: "facet-diagnostics-modal", title: "Tagging consistency" });

  const intro = document.createElement("p");
  intro.className = "fd-intro";
  // Said once, plainly, because it is the feature's biggest limitation: a facet
  // the model applies wrongly but CONSISTENTLY scores 100% here.
  intro.textContent = data.votes > 1
    ? "Whether the tagger applies each facet the same way twice. It tags every item more than once, and this is where those passes contradicted each other — which measures consistency, not correctness: a facet applied wrongly but consistently still reads 100%."
    : "This board tags each item once, so there is nothing to compare. Turn on Double-check tags in the board editor to start measuring.";
  body.appendChild(intro);

  // Said once at the top, because it qualifies EVERY number below it — not just
  // the facets that came back thin. A facet that has landed 89 of 2,400 items
  // reports a real percentage of an unrepresentative sample, and nothing in its
  // own row can say so.
  const busyFacets = facets.filter(sampleThin);
  if (busyFacets.length) {
    const n = Math.max(...busyFacets.map((f) => f.queued));
    const banner = document.createElement("p");
    banner.className = "mute-box fd-busy";
    // Names the facets, because that is the whole difference between "your
    // board is mid-pass" and "these three numbers are partial". A scoped retag
    // is the thing this feature tells people to run, so it is the common case.
    banner.textContent =
      `A re-tag is running on ${busyFacets.map((f) => f.label || f.key).join(", ")} — ` +
      `${n.toLocaleString()} item${n === 1 ? "" : "s"} still queued. ` +
      (busyFacets.length === facets.length
        ? "Every figure below is partial until it finishes."
        : "Only those figures are partial; the rest are current.");
    body.appendChild(banner);
  }

  // ONE way out, at the top, rather than one per finding. The per-facet version
  // read "Edit this facet" and could not deliver it: it opened the board editor
  // scrolled to that facet, which is a different promise, and now that the
  // editor shows only the headline it would be pointing at less than the reader
  // was already looking at.
  if (onEdit && facets.length) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "fd-edit";
    edit.textContent = "Edit this board's facets";
    edit.onclick = () => { close(); onEdit(); };
    body.appendChild(edit);
  }

  for (const row of facets) {
    // The lightbox panel's facet card, worn here too: this modal lists the same
    // facets, so it uses the same shell (panel-cell / panel-label / panel-chip)
    // rather than a lookalike of its own.
    const card = document.createElement("div");
    card.className = "fd-card panel-cell";

    const title = document.createElement("div");
    title.className = "fd-card-head";
    const name = document.createElement("span");
    name.className = "panel-label";
    name.textContent = row.label || row.key;
    title.appendChild(name);

    // Size first, then the score — the count is the qualifier and belongs
    // beside the number it qualifies, not stacked in front of it.
    const stat = document.createElement("span");
    stat.className = "fd-stat";
    const score = document.createElement("span");
    score.className = "panel-chip fd-score";
    // Not measured and measured-at-100% are different claims and must not share
    // a rendering: {} means NOT MEASURED, never zero.
    if (row.items) {
      stat.textContent = `${row.items} item${row.items === 1 ? "" : "s"}`;
      // The toolbar button's glyph, so the figure reads as this feature's
      // measurement rather than as a bare percentage of something unnamed.
      const icon = document.createElement("span");
      icon.className = "fd-icon";
      icon.innerHTML = ICONS.doubleCheck;
      score.appendChild(icon);
      score.appendChild(document.createTextNode(pct(row.unanimous / row.items)));
    } else {
      score.textContent = "not measured";
    }
    title.append(stat, score);
    card.appendChild(title);

    const block = diagnosisBlock(row, gates, { collapsible: true });
    if (block) card.appendChild(block);

    body.appendChild(card);
  }

  if (!facets.length) {
    const none = document.createElement("p");
    none.className = "fd-intro";
    none.textContent = "This board has no facets yet.";
    body.appendChild(none);
  }

  const done = document.createElement("button");
  done.className = "ghost";
  done.textContent = "Close";
  done.onclick = close;
  footer.appendChild(done);
}
