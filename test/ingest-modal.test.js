// The ingestion modal exercised as a browser would — real index.html in
// jsdom, mocked network. The one guarantee under test is the ROUND-TRIP:
// every key of a saved ingest config survives open → Save byte-identical,
// including keys this client build doesn't know. `total` was lost exactly
// here once — saved fine, dropped by a hand-picked field list on load,
// erased by the next Save — and no server test could see it, because the
// server faithfully round-trips whatever the client remembers to send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
for (const k of ['document', 'localStorage', 'Event', 'CustomEvent', 'KeyboardEvent', 'HTMLElement', 'Node']) {
  globalThis[k] = window[k];
}
globalThis.window = window;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { state } = await import('../public/state.js');
const { openIngestModal } = await import('../public/ingest-modal.js');

state.me = { id: 1, name: 'tester' };
state.boardId = 'b1';
state.boardManage = true;

// A connector-flavored payload (sources: null — no source chooser, no health
// probes) whose catalog exercises every value-control shape the modal
// renders: plain text, an enum vocabulary, and a numeric column with presets.
const DESCRIPTOR = {
  source: [],
  filters: [
    { fn: 'name', kind: 'text', label: 'Name', display: 'text' },
    { fn: 'type', kind: 'text', label: 'Type', display: 'text',
      options: [{ value: 'ETF', label: 'ETF' }, { value: 'Stock', label: 'Stock' }] },
    { fn: 'market_cap', kind: 'number', label: 'Mkt cap', display: 'usd',
      presets: [{ label: 'Over $1 billion', op: 'gte', value: 1e9 }] },
    { fn: 'volume', kind: 'number', label: 'Volume', display: 'number' },
  ],
  sorts: [{ by: 'market_cap', label: 'Market cap' }, { by: 'name', label: 'Name' }],
  triggerModes: ['manual', 'interval', 'daily'],
  runCap: 250,
};

// Maximal saved config: every field the server accepts, in already-normalized
// shape (the modal's legacy-source shaping must no-op on it), plus one key
// this build has never heard of — a newer server's, say. It must ride.
const SAVED = {
  enabled: true,
  source: { type: 'folder', folder: 'watched' },
  filters: [
    { fn: 'type', op: 'equals', value: 'Stock' },
    { fn: 'market_cap', op: 'gte', value: 1e9 },
  ],
  sort: { by: 'market_cap', order: 'desc' },
  total: 1500,
  limit: 250,
  trigger: { mode: 'daily', at: '06:30' },
  future_knob: { nested: 7 },
};

let calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  if (String(url).endsWith('/ingest'))
    return { ok: true, json: async () => ({
      available: true, descriptor: DESCRIPTOR, sources: null,
      config: structuredClone(SAVED), state: null, rootPath: null,
    }) };
  return { ok: true, json: async () => ({}) };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
async function openBuilt() {
  calls = [];
  openIngestModal();
  await tick(); await tick();
  const modal = document.getElementById('ingest-modal');
  assert.ok(modal, 'modal built');
  return modal;
}
const knobInput = (modal, label) => [...modal.querySelectorAll('.im-pair')]
  .find((p) => p.querySelector('label')?.textContent === label)
  ?.querySelector('input');
const saveBtn = (modal) => [...modal.querySelectorAll('button')].find((b) => b.textContent === 'Save');
async function savedPatch(modal) {
  saveBtn(modal).click();
  await tick(); await tick();
  const patch = calls.find((c) => c.opts.method === 'PATCH');
  assert.ok(patch, 'Save PATCHed the board');
  return JSON.parse(patch.opts.body).ingest;
}

test('a saved config round-trips open → Save byte-identical — unknown keys included', async () => {
  const modal = await openBuilt();

  // The visible half of the old bug first: the knobs must SHOW what's saved.
  assert.equal(knobInput(modal, 'Keep top').value, '1500');
  assert.equal(knobInput(modal, 'Admit per run').value, '250');

  // The value controls resolved from the catalog: the enum filter is a
  // select sitting on its saved option; the preset filter recognises its
  // saved (op, value) as the band — no stray custom input beside it.
  const rows = modal.querySelectorAll('.im-filter-row');
  assert.equal(rows[0].querySelector('.im-filter-val select')?.value, 'Stock');
  const presetVal = rows[1].querySelector('.im-filter-val');
  assert.equal(presetVal.querySelector('select')?.selectedOptions[0]?.textContent, 'Over $1 billion');
  assert.equal(presetVal.querySelector('input'), null, 'a recognised band shows no custom input');

  assert.deepEqual(await savedPatch(modal), SAVED,
    'every key — including one this build does not know — survives open → Save');
});

test('an edited knob writes through; everything else still round-trips', async () => {
  const modal = await openBuilt();
  const total = knobInput(modal, 'Keep top');
  total.value = '1000';
  total.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(await savedPatch(modal), { ...SAVED, total: 1000 },
    'the edit lands; no other key is disturbed');
});
