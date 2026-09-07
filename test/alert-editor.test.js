// The alert editor's condition surface (alerts-modal.js), rendered whole in
// jsdom — the exclusion arc's Stage 3 additions: a stored condition in
// either wire form renders both halves (struck chips for the NOT side), the
// × removes from its own half, and the save payload serializes back to the
// wire form (array when exclusion-free). The filter-config-pop pattern:
// real index.html, real modal, fetch stubbed at the seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch } from './helpers.js';
import './jsdom-stub.js';

const { state } = await import('../public/state.js');
const { openAlertEditor } = await import('../public/alerts-modal.js');

state.me = { id: 1, name: 'tester' };
state.boardId = 'b1';
state.items = [];
state.alerts = [];
state.facets = [];

const openEditor = (existing) => {
  openAlertEditor(existing);
  return document.getElementById('alert-modal');
};
const closeEditor = (modal) => modal.closest('.modal-overlay')?.remove();
const chipsOf = (modal) => [...modal.querySelectorAll('.al-chip')]
  .map((c) => ({ text: c.firstChild.textContent, neg: c.classList.contains('neg'), el: c }));

// Click Save with the network stubbed; returns the request body. Cleans up
// the modal and the alerts list — a successful save arms the arrivals poll
// (ensurePolling — alerts hold it), and with the list left non-empty the
// 30s re-arm outlives the whole suite.
const saveAndCapture = async (modal, saved = { id: 1 }) => {
  let body;
  await withFetch(async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ alert: saved }) };
  }, async () => {
    [...modal.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await new Promise((r) => setTimeout(r, 20)); // busy() wraps the handler async
  });
  closeEditor(modal);
  state.alerts = [];
  return body;
};

test('both halves render — the NOT side struck, titled, removable from its own half', () => {
  const modal = openEditor({
    id: 1, name: 'mixed', enabled: true, delivery: 'record',
    condition: { kind: { any: ['a'], not: ['c'] }, color: ['red'] },
  });
  let chips = chipsOf(modal);
  assert.deepEqual(chips.map((c) => [c.text, c.neg]), [['a', false], ['c', true], ['red', false]]);
  const struck = chips.find((c) => c.neg);
  assert.equal(struck.el.title, 'must not hold this value');
  struck.el.querySelector('button').click();
  chips = chipsOf(modal);
  assert.deepEqual(chips.map((c) => [c.text, c.neg]), [['a', false], ['red', false]],
    'the × removed only the excluded value');
  closeEditor(modal);
});

test('the save payload serializes to the wire form — array once exclusion-free', async () => {
  const modal = openEditor({
    id: 2, name: 'wire', enabled: true, delivery: 'record',
    condition: { kind: { any: ['a'], not: ['c'] }, color: ['red'] },
  });
  const body = await saveAndCapture(modal, { id: 2 });
  assert.deepEqual(body.condition, { kind: { any: ['a'], not: ['c'] }, color: ['red'] },
    'mixed entry keeps the object form, exclusion-free entry stays the array');
});

test('a legacy array condition round-trips through the editor unchanged', async () => {
  const modal = openEditor({
    id: 3, name: 'legacy', enabled: true, delivery: 'record',
    condition: { kind: ['a', 'b'] },
  });
  assert.deepEqual(chipsOf(modal).map((c) => [c.text, c.neg]), [['a', false], ['b', false]]);
  const body = await saveAndCapture(modal, { id: 3 });
  assert.deepEqual(body.condition, { kind: ['a', 'b'] }, 'no exclusions — the legacy shape, byte-identical');
  state.boardId = null; // refreshTokens no-ops on the poll's parting tick
});
