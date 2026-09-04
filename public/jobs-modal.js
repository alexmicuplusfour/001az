// The per-board jobs view (planning/job-log-plan.md, Stage 2): transparency
// into in-flight and finished work, visible to every member. Two sections —
// "In progress" merges the client's own in-flight items (the queue statuses
// the delta poll already streams into state.items) with the server's running
// sweep jobs (a transcription or ingest run has no items.status leg, so its
// `running` job-log row is the only place it exists); "History" pages the
// job_log newest-first with kind filter pills. The in-progress half re-renders
// on every app:render for free; the server half refreshes on a modest interval
// while the modal is open — history only re-pulls page one, so a reader deep
// in Load-more pages isn't yanked back to the top.
import { state } from './state.js';
import { createModal, sectionHeadingEl, busy } from './modal.js';
import { ACTIVE, QUEUED, setBoardPaused } from './data.js';
import { fmtDuration, pill, fmtTok, tokPair, relTime, fmtQty } from './utils.js';
import { unseen, markSeen, seenAt, noteServerNow, JOBS_SEEN as SEEN } from './seen-mark.js';
import { toast } from './toast.js';
import { api } from './api.js';

// ── the chip's attention dot ──
// "A job failed while you weren't looking." The count on the chip already says
// work is HAPPENING; nothing said work had gone wrong, and a failure is the one
// thing in here nobody goes looking for — a tagging error sits in the log
// unread until the user is already suspicious about missing tags.
//
// state.jobsFailedAt is the newest failure's stamp (server: latestJobFailureAt,
// which is where the choice of what counts as a failure is argued), against a
// local watermark — the Tagging-consistency dot's arrangement exactly. The scope
// string itself lives in seen-mark.js, which owns the keyspace, because the
// boards index compares against this same mark.
export const jobsUnseen = () => unseen(SEEN, state.boardId, state.jobsFailedAt);
export const markJobsSeen = () => markSeen(SEEN, state.boardId, state.jobsFailedAt);

// Is the newest failure among the rows currently on screen? This is the whole
// of the dialog's licence to acknowledge on a refresh — see the comment on
// ack() — and it is a predicate over rendered rows rather than a flag, because
// every state that hides the row hides it the same way: the row is not there.
// Module-scope and pure so it can be tested; the dialog's own `drawn()` closes
// over its list and calls this.
export const failureDrawn = (rows, failedAt) =>
  !!failedAt && rows.some((j) => j.outcome === "failed" && j.started_at === failedAt);

// The kind vocabulary comes from the SERVER (capabilities.js KIND_DEFS, on the
// /jobs response) — the client renders what it is handed, so a new kind shows
// up with its name instead of a bare id and this file holds no list to keep
// true (metering-plan.md, Mechanism 3). Module-level because rows render from
// several paths; refreshed on every fetch; an id the server didn't name (an
// old response, a plugin's kind) degrades to itself.
let kindDefs = [];
const kindLabel = (id) => kindDefs.find((k) => k.id === id)?.label || id;
const OUTCOME_LABELS = {
  ok: "done",
  failed: "failed",
  requeued: "will retry",
  discarded: "discarded",
  interrupted: "interrupted",
};
// items.status → the human lane label for the in-progress section.
const STATUS_LABELS = {
  processing: "tagging",
  extracting: "extracting",
  facing: "rendering chart",
  fetching: "fetching data",
  pending: "queued to tag",
  pending_extract: "queued to extract",
  pending_face: "queued for chart",
  pending_fetch: "queued to fetch",
};

// The cancel control's two strengths, in one place — copy, request and past
// tense together, so re-wording a verb (or adding a third) is one entry rather
// than a hunt through the handler and the renderer.
const CANCEL_VERBS = {
  queued: {
    label: "Cancel queued",
    title: "Pull queued work out of the pipeline — items already being processed finish",
    past: "Cancelled",
    confirm: "Cancel this board's queued work? Items already being processed will finish; tagged items keep their tags, never-tagged ones are parked, queued adds are removed.",
  },
  abort: {
    label: "Abort",
    title: "Settle everything now — running calls finish in the background and their results are discarded",
    past: "Aborted",
    confirm: "Abort this board's running work? Already-launched calls finish in the background and their results are DISCARDED — the spend is committed, the outcome isn't. Vehicles mid-fetch are removed. (Running feed scans and transcriptions are not queue items; pause the board to stop their next tick.)",
  },
};

const REFRESH_MS = 5000;
const QUEUED_SHOWN = 20; // a 300-item retag is one summary line, not 300 rows

// ── what the tagger was actually shown ──
// The AI rendition ladder (ai-image-input-plan.md) is designed to be invisible:
// on a missing original, a corrupt file, or a payload over the provider's cap
// it drops back to the ≤600px card face and tags anyway. That is the right
// behaviour and it is also why a board silently running on the OLD input looks
// exactly like a working one — the job-log row is the only place that can tell
// them apart.
//
// `source: "thumb"` is not by itself a problem, and this is the whole reason
// the note keys off `fallback` instead: an image no bigger than the card face
// has nothing to gain from a render (a fifth of a real gallery), and the
// `thumb` preset is a deliberate kill switch. Both are normal, and surfacing
// them as warnings would cry wolf on one row in five until nobody reads the
// field. Only a fallback spends a row's width.
const FALLBACK_WHY = {
  "render-error": "render failed",
  "byte-cap": "too large to send",
};
const why = (f) => FALLBACK_WHY[f] || f;
const imageNote = (img) => (img?.fallback ? `thumbnail fallback (${why(img.fallback)})` : "");

// The full render facts for the hover: "is this board getting the detail I set
// it to" is answered by any one of its rows, and ms/waitMs are the measurement
// the rendition cache (§8) is gated on — a cache hit would skip both the render
// AND the queue, so the queue is reported when there was one.
export const imageTitle = (img) => {
  if (!img) return "";
  const bits = [];
  // The preset ASKED for, ahead of what was delivered. Not redundant with the
  // size: on a provider whose ceiling is 1568px a clamped `max` and a plain
  // `high` render byte-for-byte alike, so the outcome cannot name the setting
  // the board is on — which is the question "is this board using what I chose"
  // actually asks.
  if (img.preset) bits.push(img.preset);
  bits.push(
    img.source === "thumb"
      ? `thumbnail${img.fallback ? ` (${why(img.fallback)})` : ""}`
      : `${img.edge}px q${img.quality}`
  );
  if (img.bytes != null) bits.push(`${Math.round(img.bytes / 1024)} KB`);
  if (img.ms != null) bits.push(`${img.ms}ms${img.waitMs ? ` (${img.waitMs}ms queued)` : ""}`);
  return bits.join(" · ");
};

// What the row's paid call(s) cost, when the leg recorded it (metering-plan.md
// Stage 2). Rows from before the detail carried tokens render exactly as they
// always did — the segment only exists when the key does. Cache reads ride the
// hover (tokensTitle), not the line: they matter to "is the cache working",
// which is a question someone hovers for, not one every row should shout.
const tokensNote = (t) => (t ? tokPair(t.in, t.out) : "");
const tokensTitle = (t) => (t?.cache ? `${fmtTok(t.cache)} cached reads` : "");

// The per-kind one-liner: what this execution amounted to.
export function summaryFor(j) {
  const d = j.detail || {};
  if (j.outcome === "ok") {
    if (j.kind === "transcribe")
      return d.chars != null
        ? `${d.chars.toLocaleString()} chars${d.seconds ? ` · ${fmtQty(d.seconds, "duration")} of audio` : ""}${d.turns != null ? ` · ${d.turns} turns` : ""}${d.speakers ? ` · ${d.speakers} speaker${d.speakers === 1 ? "" : "s"}` : ""}${d.tokens ? ` · ${tokensNote(d.tokens)}` : ""}`
        : "";
    if (j.kind === "ingest") {
      const bits = [`+${d.admitted ?? 0} admitted`, `${d.scanned ?? 0} scanned`];
      // Skips are permanent (the file is ledgered out of every future scan) —
      // name them: this row is the only trace the file was ever seen.
      if (d.skipped) bits.push(`${d.skipped} skipped${d.skipped_labels?.length ? ` (${d.skipped_labels.slice(0, 3).join(", ")}${d.skipped_labels.length > 3 ? ", …" : ""})` : ""}`);
      if (d.duplicates) bits.push(`${d.duplicates} duplicate${d.duplicates === 1 ? "" : "s"}`);
      if (d.drain_left) bits.push(`${d.drain_left} to drain`);
      if (j.error) bits.push(j.error); // per-item findings ride the ok row
      if (d.attempts > 1) bits.push(`${d.attempts} attempts`);
      return bits.join(" · ");
    }
    if (j.kind === "retag") return d.skipped ? `skipped (${d.skipped})` : `queued ${d.queued ?? 0} item${d.queued === 1 ? "" : "s"}`;
    if (j.kind === "cancel") {
      // Name the verb: both strengths come through one route, so this row is
      // the only place an abort is distinguishable from a cancel — with
      // nothing in flight their counts are identical.
      const did = d.mode === "abort" ? "aborted" : "cancelled";
      const bits = [
        d.restored ? `${d.restored} restored` : "",
        d.parked ? `${d.parked} parked` : "",
        d.removed ? `${d.removed} removed` : "",
        d.finishing ? `${d.finishing} left to finish` : "",
        d.discarding ? `${d.discarding} discarding` : "",
      ].filter(Boolean);
      return `${did}${bits.length ? `: ${bits.join(" · ")}` : " — nothing was queued"}`;
    }
    if (j.kind === "diagnose") {
      // The RUN belongs in the ledger; the finding itself does not — it is a
      // standing assessment of a definition, keyed by facet and replaced rather
      // than appended, so it lives on the board and this row just says a look
      // was taken. Read the verdict here and go to the facet for the paragraph.
      const bits = [`${d.unanimous ?? 0}/${d.items ?? 0} unanimous`];
      if (d.verdict) bits.push(d.verdict.replace(/-/g, " "));
      if (d.scoped) bits.push("this facet alone");
      if (d.tokens) bits.push(tokensNote(d.tokens));
      return bits.join(" · ");
    }
    if (j.kind === "refresh") {
      // detail.fields = the moved values only ({ key: { v } }) — show a few.
      const moved = Object.entries(d.fields || {});
      const shown = moved.slice(0, 3).map(([k, e]) => `${k}: ${e?.v ?? e}`);
      return shown.join(" · ") + (moved.length > 3 ? ` · +${moved.length - 3} more` : "");
    }
    // A tag row says what it produced, what it cost, and — only when it
    // deviates — what the model had to work with (the "speak up on deviation"
    // rule the ingest bits above and the board modal's Advanced summary follow;
    // cost is not a deviation, it's the drill-down this row exists for).
    if (d.tags != null) return [`${d.tags} tag${d.tags === 1 ? "" : "s"}`, tokensNote(d.tokens), imageNote(d.image)].filter(Boolean).join(" · ");
    if (d.fields != null) return [`${d.fields} field${d.fields === 1 ? "" : "s"}`, tokensNote(d.tokens)].filter(Boolean).join(" · ");
    return "";
  }
  // A folded repeat (the same failure re-attempted on its backoff cadence)
  // carries its count — "12 attempts · unreachable…" is the ongoing story.
  // A non-ok row's tokens say the quiet part: the result was dropped, the
  // money was spent anyway. Built as bits like the branches above, so one
  // separator mechanism covers the whole function.
  const bits = [];
  if (Number(d.attempts) > 1) bits.push(`${d.attempts} attempts`);
  if (j.error) bits.push(j.error);
  if (d.tokens) bits.push(`${tokensNote(d.tokens)} spent`);
  return bits.join(" · ");
}

// `newSince` is the reader's watermark as it stood when the dialog opened — the
// dot's own number. Marking the failures above it is the answer to the question
// the dot provokes and cannot itself answer: not "has something gone wrong"
// (the red text has always said that) but WHICH of these I haven't seen. The
// alert history modal marks its unseen firings the same way and for the same
// reason; only failures are marked here, because a fresh `ok` row is not what
// the signal was about and would dilute it to noise.
function jobRow(j, newSince = 0) {
  const row = document.createElement("div");
  row.className = "job-row" + (j.outcome === "failed" && j.started_at > newSince ? " job-new" : "");

  const badge = document.createElement("span");
  badge.className = `job-kind job-kind-${j.kind}`;
  badge.textContent = kindLabel(j.kind);

  const label = document.createElement("span");
  label.className = "job-label";
  label.textContent = j.kind === "ingest" ? "Feed run" : (j.entity_display || j.target || `item ${j.item_id ?? ""}`);
  if (j.detail?.trigger) label.title = `trigger: ${j.detail.trigger}`;

  const outcome = document.createElement("span");
  outcome.className = `job-outcome job-outcome-${j.outcome}`;
  // A refresh row IS a movement (flat ticks are never recorded) — say so.
  outcome.textContent = j.kind === "refresh" ? "moved" : (OUTCOME_LABELS[j.outcome] || j.outcome);

  const summary = document.createElement("span");
  summary.className = "job-summary" + (j.outcome === "ok" ? "" : " job-err");
  summary.textContent = summaryFor(j);
  // The engine, the rendition and the cache reads share the hover — all answer
  // "what actually served this row", and the cell has one title slot.
  const title = [j.detail?.engine, imageTitle(j.detail?.image), tokensTitle(j.detail?.tokens)].filter(Boolean).join(" · ");
  if (title) summary.title = title;

  const when = document.createElement("span");
  when.className = "job-when";
  const dur = j.ended_at ? j.ended_at - j.started_at : null;
  when.textContent = relTime(j.started_at) + (dur !== null && dur >= 1000 ? ` · ${fmtDuration(dur)}` : "");
  when.title = new Date(j.started_at).toLocaleString();

  row.append(badge, label, outcome, summary, when);
  return row;
}

// A server `running` row: elapsed instead of outcome, no summary yet.
function runningRow(j) {
  const row = document.createElement("div");
  row.className = "job-row job-running";
  const badge = document.createElement("span");
  badge.className = `job-kind job-kind-${j.kind}`;
  badge.textContent = kindLabel(j.kind);
  const label = document.createElement("span");
  label.className = "job-label";
  label.textContent = j.kind === "ingest" ? "Feed run" : (j.entity_display || j.target || "");
  const status = document.createElement("span");
  status.className = "job-outcome job-outcome-running";
  status.textContent = j.kind === "transcribe" ? "transcribing" : "running";
  const when = document.createElement("span");
  when.className = "job-when";
  when.textContent = `for ${fmtDuration(Date.now() - j.started_at)}`;
  row.append(badge, label, status, when);
  return row;
}

// A client-side in-flight item (the pipeline legs — live via the delta poll).
function liveItemRow(img) {
  const row = document.createElement("div");
  row.className = "job-row job-running";
  const badge = document.createElement("span");
  badge.className = "job-kind job-kind-queue";
  badge.textContent = "Pipeline";
  const label = document.createElement("span");
  label.className = "job-label";
  label.textContent = img.displayLabel || img.name;
  const status = document.createElement("span");
  status.className = "job-outcome " + (ACTIVE.has(img.status) ? "job-outcome-running" : "job-outcome-queued");
  status.textContent = STATUS_LABELS[img.status] || img.status;
  row.append(badge, label, status);
  return row;
}

let modalEl = null;

// While the dialog is up it polls the board's stamp four times as often as the
// background tick and acknowledges what it draws, so it is the authority on
// state.jobsFailedAt for as long as it lives. signals.js stands its own read
// down against this — see the `when` on the jobErrors signal for why a second
// writer here is not merely redundant but wrong.
export const jobsModalOpen = () => !!modalEl;

// `kind` preselects the history filter — the Usage tab's drill-down deep-link
// (#jobs/<kind>, app.js) lands here. Optional and destructured, so the two
// callers that pass nothing (the toolbar chip, announce's toast action —
// which hands over a click event) fall through to "all" untouched.
export function openJobsModal({ kind } = {}) {
  if (modalEl) return; // already open
  let timer = null;
  // Everything pause repaints rides the app's render tick, so setBoardPaused's
  // dispatch is the single path whether the flip came from this button or from
  // another manager landing on the 5s pull.
  const onRender = () => { renderPause(); renderScheduled(); renderLive(); };
  const { body, overlay } = createModal({
    title: "Jobs",
    id: "jobs-modal",
    onClose: () => {
      modalEl = null;
      clearInterval(timer);
      document.removeEventListener("app:render", onRender);
    },
  });
  modalEl = overlay;

  // Read BEFORE anything acknowledges, and held for the life of the dialog:
  // reading the log is what moves the watermark, so a copy taken later always
  // says "nothing new". Frozen rather than re-read on each refresh so a failure
  // landing while you watch stays marked instead of un-marking itself a tick
  // after it appears.
  const newSince = seenAt(SEEN, state.boardId);

  // ── In progress ──
  // Both sections share one skeleton: .jobs-section > .jobs-head > h3, then
  // content. The head is a flex row either way (History puts Clear in its
  // right slot) so the two headings box and space identically.
  const liveSec = document.createElement("div");
  liveSec.className = "jobs-section";
  const liveHead = document.createElement("div");
  liveHead.className = "jobs-head";
  liveHead.appendChild(sectionHeadingEl("In progress"));
  // Board pause (job-control-plan.md Stage 1). No local mirror — state.boardPaused
  // is the one copy, and setBoardPaused carries the flag, the poll cadence and the
  // repaint together. The endpoint echoes the flag on every 5s pull, so a pause
  // flipped by another manager reaches this modal without a reload. Managers get
  // the toggle — reading is for every member, holding the board is management
  // (the Clear button's line, and the PATCH enforces it server-side).
  let lastSched = null;
  let pauseLabel = null;
  let cancelBtn = null;
  let cancelLabel = null;
  // Is the hard verb on offer? A board fact, not this tab's: the newest cancel
  // row said it had to leave work running, and work is still running. Same
  // answer in every tab, and it survives a reload.
  const abortOffered = () =>
    state.items.some((i) => ACTIVE.has(i.status)) &&
    (jobs.find((j) => j.kind === "cancel")?.detail?.finishing ?? 0) > 0;
  const renderPause = () => {
    if (!pauseLabel) return;
    pauseLabel.textContent = state.boardPaused ? "Resume" : "Pause";
    pauseLabel.parentElement.title = state.boardPaused
      ? "Resume this board's automatic work"
      : "Pause this board's automatic work — running jobs finish, the queue and schedules wait";
  };
  const syncPaused = (d) => {
    if (d.paused !== undefined && !!d.paused !== state.boardPaused) setBoardPaused(d.paused);
  };
  if (state.boardManage) {
    const pauseBtn = document.createElement("button");
    pauseBtn.type = "button";
    pauseBtn.className = "tool-btn jobs-pause";
    // The label lives in a span because renderPause writes it from INSIDE the
    // busy() handler: busy wraps the button's children and restores only while
    // its wrapper is still the button's child, so re-labelling the button
    // itself would eat the wrapper and leave the button disabled forever.
    // Writing into an inner span is the composite-button case busy documents.
    pauseLabel = document.createElement("span");
    pauseBtn.appendChild(pauseLabel);
    pauseBtn.addEventListener("click", busy(pauseBtn, async () => {
      const to = !state.boardPaused;
      const r = await fetch(`/api/boards/${state.boardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: to }),
      });
      if (r.ok) setBoardPaused(to); // else: the 5s pull re-syncs whatever is true
    }));
    renderPause();
    liveHead.appendChild(pauseBtn);

    // Soft cancel + Abort (job-control-plan.md Stages 2/3): ONE button, two
    // strengths, and which one it offers is DERIVED from the board rather than
    // latched in this tab. Abort shows when the newest cancel row reports work
    // it had to leave running AND something is still running to catch — the
    // GitHub shape, Force cancel appearing when Cancel wasn't enough. Reading
    // that off the ledger (page one, re-pulled every 5s) rather than off "did
    // *I* just press Cancel" is what makes the hard verb reachable by a second
    // manager, and by the first after a reload: a latch hid it from exactly
    // the session that needed it, because with the queue emptied there was no
    // button left to press. An abort's own row reports nothing left running,
    // so it disarms itself. The label lives in a span for busy()'s
    // composite-button contract, like Pause's above.
    cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "tool-btn jobs-danger";
    cancelLabel = document.createElement("span");
    cancelBtn.appendChild(cancelLabel);
    cancelBtn.style.display = "none";
    cancelBtn.addEventListener("click", busy(cancelBtn, async () => {
      const abort = abortOffered();
      const verb = CANCEL_VERBS[abort ? "abort" : "queued"];
      if (!confirm(verb.confirm)) return;
      try {
        const c = await api("POST", `/api/boards/${state.boardId}/jobs/cancel-queued`, { abort });
        // The same sentence the History row will carry — summaryFor owns the
        // wording, so the toast and the ledger can't drift.
        const said = summaryFor({ kind: "cancel", outcome: "ok", detail: c });
        const any = c.restored || c.parked || c.removed || c.finishing || c.discarding;
        toast(any ? `${verb.past} — ${said}` : "Nothing was queued");
        load(true); // pull the cancel row in now; the queue rows clear on the delta poll
      } catch (e) {
        toast.error(e.message || "Cancel failed");
      }
    }));
    liveHead.appendChild(cancelBtn);
  }
  liveSec.appendChild(liveHead);
  const liveList = document.createElement("div");
  liveList.className = "jobs-list";
  liveSec.appendChild(liveList);
  // Upcoming automatic work ("next feed run in 12m") — filled from the
  // endpoint's `scheduled` stamps on every refresh.
  const schedLine = document.createElement("p");
  schedLine.className = "jobs-sched";
  schedLine.hidden = true;
  liveSec.appendChild(schedLine);

  // ── History ──
  const histSec = document.createElement("div");
  histSec.className = "jobs-section";
  const histHead = document.createElement("div");
  histHead.className = "jobs-head";
  histHead.appendChild(sectionHeadingEl("History"));
  // Managers get a Clear button: reading the log is for every member,
  // destroying it is management (the endpoint enforces the same line).
  let clearBtn = null;
  if (state.boardManage) {
    clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "tool-btn jobs-danger";
    clearBtn.textContent = "Clear";
    clearBtn.title = "Delete this board's job history (in-flight rows are kept)";
    clearBtn.style.display = "none"; // shown once there's history to clear
    clearBtn.addEventListener("click", async () => {
      if (!confirm("Clear this board's job history? This can't be undone.")) return;
      try {
        await api("DELETE", `/api/boards/${state.boardId}/jobs`);
        seenKinds.clear();
        activeKind = "all";
        load(true); // repopulates from what survives: running rows, refresh history
      } catch (e) {
        toast.error(e.message || "Clear failed"); // the list stands; the interval re-syncs
      }
    });
    histHead.appendChild(clearBtn);
  }
  histSec.appendChild(histHead);
  const filters = document.createElement("div");
  filters.className = "jobs-filters";
  const histList = document.createElement("div");
  histList.className = "jobs-list";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "tool-btn jobs-more";
  more.textContent = "Load more";
  // Not the `hidden` attribute: .tool-btn's `display` out-specifies the UA's
  // [hidden] rule, which kept this button visible with no page behind it.
  more.style.display = "none";
  histSec.append(filters, histList, more);
  body.append(liveSec, histSec);

  let running = []; // the server's running sweep rows, refreshed on the interval
  let jobs = []; // settled rows fetched so far (across Load-more pages)
  let cursor = null;
  let pages = 0;
  let activeKind = kind || "all";
  const seenKinds = new Set(); // pills appear as their kinds show up in data
  // A preselected kind seeds its own pill: a deep-link to a kind with no
  // history would otherwise render an empty filtered list with no pills at
  // all — and no way back to "All".
  if (kind) seenKinds.add(kind);

  const note = (el, text) => {
    const p = document.createElement("p");
    p.className = "jobs-note";
    p.textContent = text;
    el.appendChild(p);
  };

  // Called with a fresh `scheduled` block, or bare (from the render tick) to
  // redraw the last one — pause rewrites this line, so it has to be repaintable
  // without a fetch.
  function renderScheduled(sched = lastSched) {
    lastSched = sched;
    // While paused the stamps go overdue by design and "due now" would be a
    // standing lie — say the true thing instead.
    if (state.boardPaused) {
      schedLine.hidden = false;
      schedLine.textContent = "Paused — running jobs finish; queued work and schedules resume on unpause";
      return;
    }
    if (!sched) { schedLine.hidden = true; return; }
    const when = (ts) => (ts - Date.now() <= 0 ? "due now" : `in ${fmtDuration(ts - Date.now())}`);
    const bits = [];
    if (sched.ingest_next_run_at) bits.push(`next feed run ${when(sched.ingest_next_run_at)}`);
    if (sched.retag_next_run_at) bits.push(`next retag ${when(sched.retag_next_run_at)}`);
    if (sched.refresh_next_at) bits.push(`next refresh ${when(sched.refresh_next_at)}`);
    schedLine.hidden = !bits.length;
    schedLine.textContent = bits.length ? `Scheduled: ${bits.join(" · ")}` : "";
  }

  function renderLive() {
    if (!overlay.isConnected) return;
    liveList.replaceChildren();
    for (const j of running) liveList.appendChild(runningRow(j));
    const inFlight = state.items.filter((i) => ACTIVE.has(i.status) || QUEUED.has(i.status));
    const active = inFlight.filter((i) => ACTIVE.has(i.status));
    // state.items is newest-first, but the worker claims oldest-first (FIFO —
    // see claimFairBatch). So the front of the line is the END of this list:
    // reverse to oldest-first so the next item to tag sits right under the ones
    // being tagged, and the sliced-off overflow is the newest (furthest back in
    // line) rather than the next up — the rows that feed into tagging are the
    // ones on screen.
    const queued = inFlight.filter((i) => QUEUED.has(i.status)).reverse();
    for (const img of active) liveList.appendChild(liveItemRow(img));
    for (const img of queued.slice(0, QUEUED_SHOWN)) liveList.appendChild(liveItemRow(img));
    if (queued.length > QUEUED_SHOWN) note(liveList, `…and ${queued.length - QUEUED_SHOWN} more queued`);
    if (!liveList.children.length) note(liveList, "Nothing in flight.");
    // The client can't see mid_pass, so "queued" here is an upper bound on what
    // a cancel would touch — the button's honesty lives in the confirm copy and
    // the counts the server answers with, not in this visibility test.
    if (cancelBtn) {
      const abort = abortOffered();
      const verb = CANCEL_VERBS[abort ? "abort" : "queued"];
      const n = abort ? active.length : queued.length;
      cancelBtn.style.display = n ? "" : "none";
      cancelLabel.textContent = abort ? `${verb.label} — ${n} still running` : verb.label;
      cancelBtn.title = verb.title;
    }
  }

  function renderFilters() {
    filters.replaceChildren();
    if (!seenKinds.size) return; // no history at all — no point in pills
    const setKind = (k) => { activeKind = k; load(true); };
    filters.appendChild(pill("All", null, activeKind === "all", false, () => setKind("all")));
    for (const { id, label } of kindDefs) {
      if (seenKinds.has(id) || activeKind === id)
        filters.appendChild(pill(label, null, activeKind === id, false, () => setKind(id)));
    }
  }

  function renderHistory() {
    histList.replaceChildren();
    for (const j of jobs) histList.appendChild(jobRow(j, newSince));
    if (!jobs.length) note(histList, "No jobs recorded yet.");
    more.style.display = cursor ? "" : "none";
    if (clearBtn) clearBtn.style.display = jobs.length ? "" : "none";
  }

  async function fetchPage(after) {
    const params = new URLSearchParams();
    if (after) params.set("after", after);
    if (activeKind !== "all") params.set("kind", activeKind);
    const r = await fetch(`/api/boards/${state.boardId}/jobs?${params}`, { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }

  // Opening IS the acknowledgement — the alert-history precedent — and that
  // one is unconditional: opening the log is the reader's chance at whatever is
  // in it. Every LATER acknowledgement makes a different and much narrower
  // claim — not "you had the log" but "this landed while you were watching" —
  // which is only true if the row was actually drawn. See drawn().
  //
  // Mutates and REPORTS rather than rendering, and so does noteStamp below. The
  // stamp and the mark have to move with no app:render between them:
  // announce.js reads the dots on that event, so a stamp recorded without its
  // mark is a rising edge, and it would toast and chime about a row the reader
  // is looking straight at.
  //
  // Declared above load() — which calls them — rather than below, where they
  // would work only by the grace of load's first await.
  const ack = () => {
    if (!jobsUnseen()) return false;
    markJobsSeen();
    return true;
  };

  // Was the newest failure actually put on screen? Three ordinary states say
  // no, and the dot has to survive the refresh in every one of them:
  //
  //   · a kind filter that excludes it. The stamp is deliberately board-wide
  //     and independent of the filter (server.js) precisely so a reader who
  //     clicked the Ingestion pill isn't cleared by a page with no failures in
  //     it — acknowledging it here would give that argument away on the client.
  //   · a reader paged deeper than page one, where the interval stops
  //     re-pulling history on purpose (see the setInterval below).
  //   · the moment before the first page lands.
  const drawn = () => failureDrawn(jobs, state.jobsFailedAt);

  // Every response carries the chip's stamp, so take it from whichever read
  // just happened — fresher than the background tick's, and the only path that
  // notices a Clear having destroyed everything the dot was pointing at.
  //
  // It carries the server's clock too, and that had been thrown away. The
  // watermark's floor is server-clocked (seen-mark.js) precisely because the
  // reader's own clock may be minutes out, and the offset had exactly one
  // feeder — signals.js's /jobs/errors read, which this dialog now stands down
  // while it is open. So with the log up, the one response the client still
  // receives was the one response nobody was reading the clock off. `now` has
  // been in this payload since b743290, long before the dot needed it.
  const noteStamp = (data) => {
    noteServerNow(data.now);
    const at = data.failed_at ?? null;
    if (state.jobsFailedAt === at) return false;
    state.jobsFailedAt = at;
    return true;
  };

  // The pair, settled together and rendered once. Both sides are evaluated
  // before the test — `moved || ack()` would short-circuit past the
  // acknowledgement in exactly the case that needs it, the one where the stamp
  // has just moved.
  const settle = (moved) => {
    const acked = drawn() && ack();
    if (moved || acked) document.dispatchEvent(new Event('app:render'));
  };

  // reset=true replaces the list (open, filter switch, interval refresh of
  // page one); reset=false appends the next Load-more page. Guards: never
  // append without a cursor (that would concat page one onto itself), and a
  // generation counter so the NEWEST call wins — a filter click or Load more
  // landing while the interval's refresh is in flight supersedes it instead
  // of being dropped (or double-applied when the stale fetch resolves late).
  let gen = 0;
  async function load(reset) {
    if (!reset && !cursor) return;
    const g = ++gen;
    try {
      const data = await fetchPage(reset ? null : cursor);
      if (g !== gen) return; // a newer load took over while this one was in flight
      running = data.running;
      if (data.kinds) kindDefs = data.kinds; // the server's vocabulary, refreshed per fetch
      if (reset) { jobs = data.jobs; pages = 1; }
      else { jobs = jobs.concat(data.jobs); pages++; }
      cursor = data.nextCursor;
      const moved = noteStamp(data);
      for (const j of [...data.running, ...data.jobs]) seenKinds.add(j.kind);
      // Refresh history lives outside job_log (field_snapshots) — the flag is
      // how its pill appears before the kind is ever fetched.
      if (data.has_refresh) seenKinds.add("refresh");
      syncPaused(data);
      renderScheduled(data.scheduled);
      renderLive();
      renderFilters();
      renderHistory();
      settle(moved); // against what was just rendered, not what the tick last knew
    } catch {
      if (g === gen && !jobs.length) { histList.replaceChildren(); note(histList, "Failed to load — retrying…"); }
    }
  }

  more.addEventListener("click", () => load(false));

  renderLive(); // the client half needs no fetch — show it immediately
  load(true);
  // The unconditional one: you opened the log. Ahead of load's first page, so
  // the dot clears on the click rather than a round trip later.
  if (ack()) document.dispatchEvent(new Event('app:render'));
  // The delta poll re-renders the pipeline half as statuses move; the interval
  // re-pulls the server half (running rows tick, fresh completions land) but
  // only refreshes history when the reader hasn't paged deeper.
  document.addEventListener("app:render", onRender);
  timer = setInterval(() => {
    if (pages <= 1) { load(true); return; }
    // Paged deeper, so history is deliberately NOT re-pulled — a reader on page
    // three should not be yanked back to the top. Which is exactly why nothing
    // acknowledges here: a failure landing now is never drawn, so the dot (and
    // the toast the rising edge earns it) is the only notice it will get.
    fetchPage(null).then((d) => {
      running = d.running;
      const moved = noteStamp(d);
      syncPaused(d);
      renderScheduled(d.scheduled);
      renderLive();
      if (moved) document.dispatchEvent(new Event('app:render'));
    }).catch(() => {});
  }, REFRESH_MS);
}
