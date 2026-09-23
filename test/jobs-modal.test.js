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
import { test, after } from 'node:test';
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

// The served /jobs payload, per test — the ONE source the dialog's In progress
// half reads (instance-work-plan.md): running rows (the feed run, a claimed
// instance) and the waiting lanes, pipeline legs marked `leg`. state.items is
// the grid's; the dialog never reads it, and the tests below say so.
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

test('the same verb when a pipeline lane is waiting too — no flicker', async (t) => {
  WORK = { running: [feedRun({ planned: 400, admitted: 47 })], queued: [{ kind: 'face', label: 'Chart', n: 1, leg: true }] };
  JOBS = [];
  state.items = [];
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

// ── the pipeline legs are rows and lanes of the payload, never the cards ──

test('a claimed instance is a row wearing its kind, its file and its card; a waiting leg is a count', async (t) => {
  WORK = {
    running: [{ id: null, kind: 'extract', label: 'Extraction', target: '2jNX7ZT.jpg', item_id: 5248, entity_id: 33215,
      entity_display: 'emma watson', started_at: Date.now() - 12000, leg: true }],
    queued: [{ kind: 'tag', label: 'Tagging', n: 18, leg: true }],
  };
  JOBS = [];
  state.items = [{ id: 33215, status: 'processing', name: 'emma watson' }];
  const modal = await openModal(t);
  const rows = [...modal.querySelectorAll('.job-running')];
  assert.equal(rows.length, 1, 'one row per claimed instance — the card is not a row');
  assert.match(rows[0].textContent, /Extraction/, 'the kind badge History wears');
  assert.match(rows[0].textContent, /2jNX7ZT\.jpg · emma watson/, 'the file, then the card');
  assert.match(rows[0].textContent, /extracting/, "the leg's verb");
  const notes = [...modal.querySelectorAll('.jobs-note')].map((n) => n.textContent);
  assert.ok(notes.includes('18 waiting — Tagging'), 'the waiting leg is a count under its lane');
  const btn = cancelBtn(modal);
  assert.ok(shown(btn), 'a waiting leg is something to cancel');
  assert.equal(btn.textContent, LABEL);
});

test('cards in flight with nothing in the payload show nothing — the dialog reads the payload', async (t) => {
  WORK = { running: [], queued: [] };
  JOBS = [];
  state.items = [{ id: 1, status: 'processing', name: 'ACME' }, { id: 2, status: 'pending', name: 'BETA' }];
  const modal = await openModal(t);
  assert.equal(modal.querySelectorAll('.job-running').length, 0);
  assert.ok([...modal.querySelectorAll('.jobs-note')].some((n) => n.textContent === 'Nothing in flight.'));
  assert.equal(shown(cancelBtn(modal)), false);
});

test('Abort counts the legs it would take, in instances', async (t) => {
  WORK = {
    running: [
      { id: null, kind: 'tag', label: 'Tagging', target: 'a.png', item_id: 1, entity_id: 1, entity_display: null, started_at: Date.now() - 3000, leg: true },
      { id: 9, kind: 'transcribe', label: 'Transcription', target: 'clip.mp3', item_id: 2, entity_id: 2, entity_display: null, started_at: Date.now() - 30000 },
    ],
    queued: [{ kind: 'tag', label: 'Tagging', n: 4, leg: true }, { kind: 'embed', label: 'Embedding', n: 7 }],
  };
  // The newest cancel row left calls running — the escalation is on offer.
  JOBS = [{ id: 3, kind: 'cancel', outcome: 'ok', error: null, detail: { mode: 'queued', finishing: 3 }, target: null,
    entity_id: null, item_id: null, entity_display: null, started_at: Date.now() - 1000, ended_at: Date.now() - 1000 }];
  state.items = [];
  const modal = await openModal(t);
  const btn = cancelBtn(modal);
  assert.ok(shown(btn));
  assert.equal(btn.textContent, 'Abort — 5 left',
    "one claimed leg + four waiting; the transcription and the embed backlog are not the verb's to take");
});

// Every open wrote the served work into state and woke the delta poll; its
// pending tick must find nothing left to follow, or this file never exits.
after(() => { state.work = { running: [], queued: [] }; });
