// The Jobs modal's IN PROGRESS half, clicked as a browser would (jsdom, mocked
// network). What is pinned here is one rule, learned from screenshots twice:
// QUEUED is every kind of work the board is waiting to do, and the control
// over it is ONE button with ONE name.
//
// Both failures came from splitting that. First the button counted only
// pipeline rows, so a three-minute import sat on screen with no control
// anywhere on the dialog — on a stocks board a chart renders in about a
// second, so the queue is usually empty while the feed fills it. Then the fix
// gave the feed run its own verb, and the label flickered between two names
// under the pointer as rows came and went. Same work, same request, same word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './jsdom-stub.js';
import { until } from './helpers.js';

const { state } = await import('../public/state.js');
const { openJobsModal } = await import('../public/jobs-modal.js');
const { jobsModalOpen } = await import('../public/jobs-state.js');

state.me = { id: 1, name: 'tester' };
state.boardId = 'b1';
state.boardManage = true;
state.boardPaused = false;

// The served /jobs payload, per test. `work.running` is the server's list of
// running job rows (the feed run lives here); state.items is the client's own
// pipeline view, which is where queued rows come from.
let WORK = { running: [], queued: [] };
let JOBS = [];
let SCHEDULED = { ingest_next_run_at: null, retag_next_run_at: null, refresh_next_at: null };
globalThis.confirm = () => false; // no test presses through a confirm
globalThis.fetch = async (url) => {
  if (String(url).includes('/jobs')) {
    return { ok: true, json: async () => ({
      work: structuredClone(WORK), jobs: structuredClone(JOBS), nextCursor: null,
      kinds: null, has_refresh: false, paused: false, now: Date.now(),
      scheduled: SCHEDULED,
    }) };
  }
  return { ok: true, json: async () => ({}) };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const feedRun = (detail) => ({ id: 1, kind: 'ingest', label: 'Ingestion', target: null,
  item_id: null, entity_id: null, entity_display: null, started_at: Date.now() - 26000, detail });

async function openModal(t) {
  await until(() => !document.getElementById('jobs-modal'), 3000);
  openJobsModal();
  await tick(); await tick(); await tick();
  const modal = document.getElementById('jobs-modal');
  assert.ok(modal, 'modal built');
  // An open modal holds a setInterval that only clears on close, so a test
  // that leaves one open hangs the file after the last report.
  t.after(() => { if (modal.isConnected) modal.querySelector('.modal-close')?.click(); });
  return modal;
}
const cancelBtn = (modal) => modal.querySelector('.jobs-danger');
const shown = (el) => !!el && el.style.display !== 'none';
// The one name the control carries whenever there is anything waiting — the
// point of the test below is that it is the SAME string in both shapes.
const LABEL = 'Cancel queued';

test('a feed run alone earns the control: nothing queued, and still something to stop', async (t) => {
  WORK = { running: [feedRun({ planned: 400, admitted: 47 })], queued: [] };
  JOBS = [];
  // A run in flight: its own stamp sits in the past until it settles.
  SCHEDULED = { ingest_next_run_at: Date.now() - 26000, retag_next_run_at: null,
    refresh_next_at: Date.now() + 3600000 };
  state.items = []; // the pipeline kept up — this is the screenshot's board
  const modal = await openModal(t);

  const btn = cancelBtn(modal);
  assert.ok(shown(btn), 'the button is on the dialog while the run is importing');
  assert.equal(btn.textContent, LABEL, 'one verb over every kind of waiting work');
  assert.match(btn.title, /feed run in progress included/);

  const run = [...modal.querySelectorAll('.job-running')]
    .find((r) => r.textContent.includes('Feed run'));
  assert.ok(run, 'the run is listed');
  assert.match(run.textContent, /importing 47 of 400/, 'progress, not the word "running"');

  // A run in flight holds its own stamp in the past for as long as it takes,
  // so the schedule line used to read "next feed run due now" directly under
  // a row saying the run was already going — the same fact, told twice, one
  // of them wrong.
  const sched = modal.querySelector('.jobs-sched');
  assert.equal(/feed run/.test(sched?.textContent || ''), false,
    'no next-run countdown while this run is up');
  assert.match(sched.textContent, /next refresh/, 'the other schedules still show');
});

test('the same verb when pipeline rows are waiting too — no flicker', async (t) => {
  WORK = { running: [feedRun({ planned: 400, admitted: 47 })], queued: [] };
  JOBS = [];
  state.items = [{ id: 1, status: 'pending', name: 'ACME' }];
  const modal = await openModal(t);

  const btn = cancelBtn(modal);
  assert.ok(shown(btn));
  // THE regression: this label used to be picked by whether a pipeline row
  // happened to be waiting at that instant, so it flickered between two names
  // under the pointer as the chart lane drained the queue and the run refilled
  // it. Same work, same request, same word.
  assert.equal(btn.textContent, LABEL, 'the verb does not change as the queue drains');
});

test('an idle board offers nothing', async (t) => {
  WORK = { running: [], queued: [] };
  JOBS = [];
  state.items = [];
  const modal = await openModal(t);
  assert.equal(shown(cancelBtn(modal)), false, 'no run, no queue, no button');
  assert.ok(jobsModalOpen(), 'the dialog itself is still up');
});
