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
export function diagnosisState(row, gates = {}) {
  const minItems = gates.minItems ?? 20;
  const minRate = gates.minRate ?? 0.15;
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
  if (entry?.verdict === "genuinely-ambiguous-items") return { state: "note", entry, items, rate };
  if (entry?.verdict && entry.verdict !== "no-problem-found" && entry.explanation) {
    return { state: "finding", entry, items, rate };
  }
  return { state: "none", items, rate };
}

const pct = (n) => `${Math.round(n * 100)}%`;

// Whether the header shows the door at all. Both halves are load-bearing and
// each alone leaves a button that opens something useless: without
// `boardManage` a reader gets a facet suggestion they cannot act on, and
// without vote mode the modal is permanently empty, because a single-pass board
// writes no confidence at all ({} is NOT MEASURED, never zero).
export const canSeeDiagnostics = (s) => !!s.boardManage && Number(s.boardVotes) > 1;

// The roll-up is board-manager data on its own endpoint, so it is deliberately
// not in the gallery's board payload. Fetched once per board, cached on state,
// and re-rendered on arrival — the refreshBoardIngest pattern. Keyed on the
// board id so switching boards re-fetches, and marked BEFORE the request so a
// burst of toolbar rebuilds fires one.
let statsFetchedFor = null;
export function ensureFacetStats() {
  if (statsFetchedFor === state.boardId) return;
  statsFetchedFor = state.boardId;
  api("GET", `/api/boards/${state.boardId}/facet-stats`)
    .then((d) => {
      state.facetStats = d.facets || [];
      state.facetGates = d.gates || {};
      document.dispatchEvent(new Event('app:render'));
    })
    .catch(() => { state.facetStats = []; }); // no dot rather than a broken header
}

// The dot's memory. localStorage per board rather than server-side, unlike
// alerts: this is advisory, not a ledger, and it does not need to survive a
// device change. Keyed on the newest `at` the board carries, so a finding
// written after the user last looked re-lights it.
const SEEN_KEY = (boardId) => `facetDiagSeen:${boardId}`;

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
  const seen = Number(localStorage.getItem(SEEN_KEY(boardId))) || 0;
  return newestAt(worth) > seen;
}

export function markDiagnosticsSeen(boardId, facets) {
  localStorage.setItem(SEEN_KEY(boardId), String(Math.max(newestAt(facets), Date.now() - 1)));
}

// One facet's block, shared shape between the modal and the facet editor. The
// editor passes `onApply` (it owns a textarea to append into); the modal never
// does, because it must not be able to write.
export function diagnosisBlock(row, gates, onApply) {
  const s = diagnosisState(row, gates);
  if (s.state === "none") return null;

  const el = document.createElement("div");
  el.className = `fd-block fd-${s.state}`;

  const head = document.createElement("div");
  head.className = "fd-head";
  el.appendChild(head);

  if (s.state === "awaiting") {
    // Three ways to be here and they are not one sentence. An edit is the
    // designed path; nothing measured at all is the pre-stamp board; and a
    // handful of items is what curation leaves behind, where "not measured yet"
    // would be a plain lie — those items WERE measured, there are just too few
    // of them left to say anything.
    head.textContent = s.previous
      ? `This description changed. Re-tag this board on ${row.label} to measure whether it helped.`
      : s.items
        ? `Only ${s.items} item${s.items === 1 ? "" : "s"} still carry a measurement of the current wording — too few to judge. Re-tag this board on ${row.label}.`
        : `Not measured against the current wording yet. Re-tag this board on ${row.label} to see how stable it is.`;
    return el;
  }

  if (s.state === "improved") {
    const was = (s.previous.stats.items - s.previous.stats.unanimous) / s.previous.stats.items;
    // Agreement, never accuracy: a facet applied wrongly but consistently scores
    // 100% here and is invisible to the whole feature. And never "your edit did
    // this" — hand-corrections between the two measurements move the same
    // number, and nothing here can tell the two apart.
    head.textContent = `${pct(1 - was)} consistent before, ${pct(1 - s.rate)} now.`;
    if (s.shapeChanged) {
      const note = document.createElement("div");
      // Not "fd-note" — that is the state class of the whole ambiguous block.
      note.className = "fd-caveat";
      note.textContent = "(re-measured on this facet alone, which is a slightly different prompt — the next comparison will be like-for-like.)";
      el.appendChild(note);
    }
    return el;
  }

  head.textContent = s.state === "note"
    ? `The tagger contradicted itself on ${pct(s.rate)} of items, and the wording may not be the reason.`
    : `The tagger contradicted itself on ${pct(s.rate)} of items.`;

  const why = document.createElement("div");
  why.className = "fd-why";
  why.textContent = s.entry.explanation;
  el.appendChild(why);

  if (s.state === "finding" && s.entry.suggestion) {
    const sug = document.createElement("div");
    sug.className = "fd-suggestion";
    const quoted = document.createElement("span");
    quoted.textContent = `Suggested: “${s.entry.suggestion}”`;
    sug.appendChild(quoted);
    if (onApply) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fd-apply";
      btn.textContent = "add to description";
      // Appends into the textarea and leaves the cursor there: a text edit the
      // user can undo, retype or ignore before saving. The model never writes
      // to the board.
      btn.onclick = () => onApply(s.entry.suggestion);
      sug.appendChild(btn);
    }
    el.appendChild(sug);
  }
  return el;
}

// ─── the modal ───────────────────────────────────────────────────────────────

// Read-only. Every facet carrying confidence data, its stability, and its
// finding if it has one. Each finding offers a way into the board modal, which
// is the only place a suggestion can actually be applied.
export async function openDiagnosticsModal({ onEditFacet } = {}) {
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

  for (const row of facets) {
    const card = document.createElement("div");
    card.className = "fd-card";

    const title = document.createElement("div");
    title.className = "fd-card-head";
    const name = document.createElement("strong");
    name.textContent = row.label || row.key;
    title.appendChild(name);

    const stat = document.createElement("span");
    stat.className = "fd-stat";
    // Not measured and measured-at-100% are different claims and must not share
    // a rendering: {} means NOT MEASURED, never zero.
    stat.textContent = row.items
      ? `${pct(row.unanimous / row.items)} consistent · ${row.items} item${row.items === 1 ? "" : "s"}`
      : "not measured";
    title.appendChild(stat);
    card.appendChild(title);

    const block = diagnosisBlock(row, gates, null);
    if (block) card.appendChild(block);

    if (block && diagnosisState(row, gates).state === "finding" && onEditFacet) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "fd-edit";
      edit.textContent = "Edit this facet";
      edit.onclick = () => { close(); onEditFacet(row.key); };
      card.appendChild(edit);
    }
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
