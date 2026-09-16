// The reader-facing SURFACE of facet diagnosis (planning/facet-diagnosis-plan.md §6).
//
// The two surfaces in this file: the **Diagnostics modal** is the survey and is
// read-only, and the editor block it shares with the **facet editor**
// (board-modal.js), which is where the fix is typed and is the only writer.
// The repetition between them is deliberate — if the modal could apply a
// suggestion it would become a second writer into boards.facets, which is the
// exact race the worker-owned facet_diagnostics column exists to avoid. The
// third surface, the header button and its attention dot, is drawn by
// toolbar.js off facet-diagnosis.js and never loads this file.
//
// Reached only by opening something, so it is loaded then rather than at boot
// (see modals.js). The engine that decides whether there is anything to open
// — and lights the header dot — is facet-diagnosis.js, which stays eager.
import { state } from './state.js';
import { api } from './api.js';
import { createModal } from './modal.js';
import { ICONS, relTime } from './utils.js';
import { diagnosisState, sampleThin, markDiagnosticsSeen } from './facet-diagnosis.js';

// A formatter, used only by what this file renders.
const pct = (n) => `${Math.round(n * 100)}%`;


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

