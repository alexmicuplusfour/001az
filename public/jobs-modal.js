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
import { createModal, sectionHeadingEl } from './modal.js';
import { ACTIVE, QUEUED } from './data.js';
import { fmtDuration, pill } from './utils.js';
import { unseen, markSeen, seenAt, noteServerNow } from './seen-mark.js';

// ── the chip's attention dot ──
// "A job failed while you weren't looking." The count on the chip already says
// work is HAPPENING; nothing said work had gone wrong, and a failure is the one
// thing in here nobody goes looking for — a tagging error sits in the log
// unread until the user is already suspicious about missing tags.
//
// state.jobsFailedAt is the newest failure's stamp (server: latestJobFailureAt,
// which is where the choice of what counts as a failure is argued), against a
// local watermark — the Tagging-consistency dot's arrangement exactly.
const SEEN = "jobErrSeen";
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

const KIND_LABELS = {
  transcribe: "Transcription",
  ingest: "Ingestion",
  tag: "Tagging",
  extract: "Extraction",
  face: "Chart",
  retag: "Retag pass",
  embed: "Embedding",
  refresh: "Refresh",
  diagnose: "Facet review",
};
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
  pending: "queued to tag",
  pending_extract: "queued to extract",
  pending_face: "queued for chart",
};

const REFRESH_MS = 5000;
const QUEUED_SHOWN = 20; // a 300-item retag is one summary line, not 300 rows
const relTime = (ts) => `${fmtDuration(Date.now() - ts)} ago`;

// The per-kind one-liner: what this execution amounted to.
function summaryFor(j) {
  const d = j.detail || {};
  if (j.outcome === "ok") {
    if (j.kind === "transcribe") return d.chars != null ? `${d.chars.toLocaleString()} chars` : "";
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
    if (j.kind === "diagnose") {
      // The RUN belongs in the ledger; the finding itself does not — it is a
      // standing assessment of a definition, keyed by facet and replaced rather
      // than appended, so it lives on the board and this row just says a look
      // was taken. Read the verdict here and go to the facet for the paragraph.
      const bits = [`${d.unanimous ?? 0}/${d.items ?? 0} unanimous`];
      if (d.verdict) bits.push(d.verdict.replace(/-/g, " "));
      if (d.scoped) bits.push("this facet alone");
      return bits.join(" · ");
    }
    if (j.kind === "refresh") {
      // detail.fields = the moved values only ({ key: { v } }) — show a few.
      const moved = Object.entries(d.fields || {});
      const shown = moved.slice(0, 3).map(([k, e]) => `${k}: ${e?.v ?? e}`);
      return shown.join(" · ") + (moved.length > 3 ? ` · +${moved.length - 3} more` : "");
    }
    if (d.tags != null) return `${d.tags} tag${d.tags === 1 ? "" : "s"}`;
    if (d.fields != null) return `${d.fields} field${d.fields === 1 ? "" : "s"}`;
    return "";
  }
  // A folded repeat (the same failure re-attempted on its backoff cadence)
  // carries its count — "12 attempts · unreachable…" is the ongoing story.
  return (Number(d.attempts) > 1 ? `${d.attempts} attempts · ` : "") + (j.error || "");
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
  badge.textContent = KIND_LABELS[j.kind] || j.kind;

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
  if (j.detail?.engine) summary.title = j.detail.engine;

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
  badge.textContent = KIND_LABELS[j.kind] || j.kind;
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

export function openJobsModal() {
  if (modalEl) return; // already open
  let timer = null;
  const onRender = () => renderLive();
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
    clearBtn.className = "tool-btn jobs-clear";
    clearBtn.textContent = "Clear";
    clearBtn.title = "Delete this board's job history (in-flight rows are kept)";
    clearBtn.style.display = "none"; // shown once there's history to clear
    clearBtn.addEventListener("click", async () => {
      if (!confirm("Clear this board's job history? This can't be undone.")) return;
      try {
        const r = await fetch(`/api/boards/${state.boardId}/jobs`, { method: "DELETE" });
        if (!r.ok) throw new Error(String(r.status));
        seenKinds.clear();
        activeKind = "all";
        load(true); // repopulates from what survives: running rows, refresh history
      } catch {} // leave the list as-is; the interval re-syncs either way
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
  let activeKind = "all";
  const seenKinds = new Set(); // pills appear as their kinds show up in data

  const note = (el, text) => {
    const p = document.createElement("p");
    p.className = "jobs-note";
    p.textContent = text;
    el.appendChild(p);
  };

  function renderScheduled(sched) {
    if (!sched) return;
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
  }

  function renderFilters() {
    filters.replaceChildren();
    if (!seenKinds.size) return; // no history at all — no point in pills
    const setKind = (k) => { activeKind = k; load(true); };
    filters.appendChild(pill("All", null, activeKind === "all", false, () => setKind("all")));
    for (const kind of Object.keys(KIND_LABELS)) {
      if (seenKinds.has(kind) || activeKind === kind)
        filters.appendChild(pill(KIND_LABELS[kind], null, activeKind === kind, false, () => setKind(kind)));
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
      if (reset) { jobs = data.jobs; pages = 1; }
      else { jobs = jobs.concat(data.jobs); pages++; }
      cursor = data.nextCursor;
      const moved = noteStamp(data);
      for (const j of [...data.running, ...data.jobs]) seenKinds.add(j.kind);
      // Refresh history lives outside job_log (field_snapshots) — the flag is
      // how its pill appears before the kind is ever fetched.
      if (data.has_refresh) seenKinds.add("refresh");
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
      renderScheduled(d.scheduled);
      renderLive();
      if (moved) document.dispatchEvent(new Event('app:render'));
    }).catch(() => {});
  }, REFRESH_MS);
}
