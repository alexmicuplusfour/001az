// The ingestion modal exercised as a browser would — real index.html in
// jsdom, mocked network. The first guarantee under test is the ROUND-TRIP:
// every key of a saved ingest config survives open → Save byte-identical,
// including keys this client build doesn't know. `total` was lost exactly
// here once — saved fine, dropped by a hand-picked field list on load,
// erased by the next Save — and no server test could see it, because the
// server faithfully round-trips whatever the client remembers to send.
//
// The rest is stage 6's information architecture: the deletion rule is a
// FILTER, the preview EXPLAINS ITS OWN COUNT, and the whole-ledger reset is a
// quiet link on the run-state line — three intents that used to share one
// unnameable section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './jsdom-stub.js';
import { until } from './helpers.js';

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
// Per-test knobs on the stubbed payload: the dedup-memory size, and the
// adapter's own answer to "does an admission carry its own identity" (the
// descriptor flag the clear warning reads).
let LEDGER = { total: 0, on_board: 0, held: 0, unprocessable: 0 };
// What the preview route answers — the numbers the count and its explanation
// lines are read off. Filter-scoped server-side, unlike LEDGER above, which is
// the whole ledger and feeds only the records reset.
let PREVIEW = { count: 0, new: 0, on_board: 0, held: 0, unprocessable: 0, capped: false, truncated: false };
let CLEARED = 0;
let SAFE = true;
// Answer to the next confirm(). Stubbed here beside fetch rather than inside a
// test, so no test can leave a live auto-accept behind for the next one.
let CONFIRMED = true;
let confirmMsg = null;
globalThis.confirm = (m) => { confirmMsg = m; return CONFIRMED; };
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  if (String(url).endsWith('/ingest/preview'))
    return { ok: true, json: async () => structuredClone(PREVIEW) };
  if (String(url).endsWith('/ingest/clear'))
    return { ok: true, json: async () => ({ cleared: CLEARED, ledger: LEDGER }) };
  if (String(url).endsWith('/ingest'))
    return { ok: true, json: async () => ({
      available: true, descriptor: { ...DESCRIPTOR, forgetAllIsSafe: SAFE }, sources: null,
      config: structuredClone(SAVED), state: null, rootPath: null, ledger: LEDGER,
    }) };
  return { ok: true, json: async () => ({}) };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
async function openBuilt(t) {
  // close() unmounts on a 250ms transition fallback (modal.js), and
  // openIngestModal no-ops while the old overlay is still registered — so an
  // open always waits the previous one out.
  await until(() => !document.getElementById('ingest-modal'), 3000);
  calls = [];
  confirmMsg = null;
  openIngestModal();
  await tick(); await tick();
  const modal = document.getElementById('ingest-modal');
  assert.ok(modal, 'modal built');
  // An open modal runs a 1s setInterval (the header chip's tick) that only
  // clears once the overlay disconnects — so a modal left open holds the
  // event loop open and THE WHOLE FILE HANGS, forever, after the last test
  // reports. Every test used to close by hand or by Save, which hid it until
  // the first assertion failed mid-test and took 45 minutes of nothing with
  // it. t.after runs on failure too, so cleanup stops being discipline.
  t?.after(() => {
    if (modal.isConnected) modal.querySelector('.modal-close')?.click();
  });
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

test('a saved config round-trips open → Save byte-identical — unknown keys included', async (t) => {
  const modal = await openBuilt(t);

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

test('an edited knob writes through; everything else still round-trips', async (t) => {
  const modal = await openBuilt(t);
  const total = knobInput(modal, 'Keep top');
  total.value = '1000';
  total.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(await savedPatch(modal), { ...SAVED, total: 1000 },
    'the edit lands; no other key is disturbed');
});

// Shown on screen, not merely "this element doesn't say display:none" — the
// exception verbs are hidden by their ROW, so asking the button alone reports
// a visible Re-include long after its line is gone.
function shown(el) {
  for (let n = el; n && n !== document; n = n.parentElement) if (n.style?.display === 'none') return false;
  return true;
}
const btn = (modal, re) => [...modal.querySelectorAll('button')]
  .find((b) => re.test(b.textContent) && shown(b));
// A visible text action, by its words. Four of them share .im-link now (the
// count, the two exception verbs, the footer reset), so the regex is the
// whole identification.
const link = (modal, re) => [...modal.querySelectorAll('.im-link')]
  .find((b) => re.test(b.textContent) && shown(b));
// The visible explanation lines under the count, label text only — the verb
// beside each one is asserted separately, by name.
const lines = (modal) => [...modal.querySelectorAll('.im-exceptions .im-line')]
  .filter(shown)
  .map((r) => r.querySelector('span').textContent);

test('the deletion rule is a filter, and it asks nothing about the backlog', async (t) => {
  LEDGER = { total: 10, on_board: 3, held: 7, unprocessable: 0 };
  const modal = await openBuilt(t);

  // Not in a section of its own — "skip" needs an "out of what?", and Filters
  // is the section that answers it.
  const sw = modal.querySelector('.im-filters').closest('.modal-section').querySelector('.switch-row');
  assert.ok(sw, 'the rule lives in the Filters section');
  assert.match(sw.textContent, /Skip items you've deleted from this board/);

  // The flag is FORWARD-ONLY server-side, so flipping it is a policy change
  // and nothing else: no question about the 7 already held, no clear. Stage 4
  // asked here, which is exactly the blend this stage exists to undo — the
  // backlog has its own line, with its own verb, under Preview.
  sw.querySelector('.switch').click();
  await tick(); await tick();
  assert.equal(confirmMsg, null, 'no question — the backlog is not this control’s business');
  assert.equal(calls.some((c) => c.url.endsWith('/ingest/clear')), false, 'and nothing is cleared');

  // …and the flag itself rides the buffered config to Save, like any knob.
  assert.equal((await savedPatch(modal)).rememberDeletions, false);
});

test('preview explains its own count; Re-include acts on exactly the window it named', async (t) => {
  LEDGER = { total: 3836, on_board: 1497, held: 2336, unprocessable: 3 };
  PREVIEW = { count: 1500, new: 1500, on_board: 1497, held: 2336, unprocessable: 3, capped: false, truncated: false };
  const modal = await openBuilt(t);

  // Nothing is claimed before the simulation runs — the counts cost a click,
  // deliberately, because that click is the moment anyone cares.
  assert.deepEqual(lines(modal), [], 'no numbers before Preview');
  assert.equal(link(modal, /to ingest/), undefined);

  btn(modal, /^Preview$/).click();
  await tick(); await tick();
  assert.equal(link(modal, /to ingest/).textContent, '1,500 to ingest ›',
    'eligibility, not "new" — a re-included item is eligible without being new');
  assert.deepEqual(lines(modal), [
    '1,497 already on the board.',
    '2,336 excluded because you deleted them.',
    "3 couldn't be read.",
  ], 'why the count is not bigger, in the order the answers matter');

  // Declining asks, and does nothing else.
  CONFIRMED = false;
  link(modal, /^Re-include/).click();
  await tick(); await tick();
  assert.match(confirmMsg, /compete for slots/, 'the confirm states the Keep-top consequence');
  assert.equal(calls.some((c) => c.url.endsWith('/ingest/clear')), false, 'declined → no request');

  // Accepting sends the BUFFERED config, so the rows forgotten are the rows
  // the number was read off — not the ledger-wide 2,336-plus-whatever-the-
  // filters-exclude that stage 4 would have taken.
  CONFIRMED = true;
  CLEARED = 2336;
  PREVIEW = { ...PREVIEW, count: 3836, new: 3836, held: 0 };
  calls = [];
  link(modal, /^Re-include/).click();
  await tick(); await tick(); await tick();
  const sent = calls.find((c) => c.url.endsWith('/ingest/clear'));
  const body = JSON.parse(sent.opts.body);
  assert.equal(body.scope, 'deleted');
  assert.deepEqual(body.ingest.filters, SAVED.filters, 'the window it named rides along');
  assert.equal(body.run, undefined,
    'and no run is armed: the scope is buffered config, a run would execute the saved one');

  // The change lands where the user is already looking — re-previewed in
  // place, not left behind a button they have to find again.
  assert.ok(calls.some((c) => c.url.endsWith('/ingest/preview')), 're-previewed');
  assert.equal(link(modal, /^Re-include/), undefined, 'an emptied line goes away');
  assert.equal(link(modal, /to ingest/).textContent, '3,836 to ingest ›');

  // A config edit makes every one of those numbers a lie — the whole block
  // goes, not just the count.
  knobInput(modal, 'Keep top').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(lines(modal), []);
  assert.equal(link(modal, /to ingest/), undefined);
});

test('a truncated window marks every number it reports as a floor', async (t) => {
  LEDGER = { total: 9, on_board: 4, held: 5, unprocessable: 0 };
  PREVIEW = { count: 500, new: 500, on_board: 4, held: 5, unprocessable: 0, capped: true, truncated: true };
  const modal = await openBuilt(t);
  btn(modal, /^Preview$/).click();
  await tick(); await tick();
  assert.equal(link(modal, /to ingest/).textContent, '500+ to ingest ›');
  assert.deepEqual(lines(modal), ['4+ already on the board.', '5+ excluded because you deleted them.']);
});

test('the records reset is ledger-wide, warns per descriptor, and hides at zero', async (t) => {
  // Not safe to forget (the file adapter can't recognize pre-provenance
  // items), and the warning comes from the descriptor, never a payload sniff.
  SAFE = false;
  CONFIRMED = false;
  LEDGER = { total: 5, on_board: 5, held: 0, unprocessable: 0 };
  let modal = await openBuilt(t);
  const hatch = link(modal, /^Clear ingestion records/);
  assert.ok(hatch, 'the hatch names records, not history or memory');
  // NOT in the footer: that row is Save and Run now, and a footer `button`
  // rule outranks .im-link there — a quiet maintenance link came out looking
  // like a third primary. It rides the last-run line instead, pushed right.
  assert.equal(hatch.closest('.modal-footer'), null);
  assert.ok(hatch.closest('.im-line'), 'it shares the run-state line');
  hatch.click();
  await tick(); await tick();
  assert.match(confirmMsg, /duplicated/);
  assert.equal(calls.some((c) => c.url.endsWith('/ingest/clear')), false, 'declined → no request');
  modal.querySelector('.modal-close').click();

  // Nothing remembered at all: no reset, because there is nothing to reset.
  SAFE = true;
  LEDGER = { total: 0, on_board: 0, held: 0, unprocessable: 0 };
  modal = await openBuilt(t);
  assert.equal(link(modal, /^Clear ingestion records/), undefined);
});
