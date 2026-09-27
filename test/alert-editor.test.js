// The alert editor's condition surface (alerts-modal.js), rendered whole in
// jsdom — the exclusion arc's Stage 3 additions: a stored condition in
// either wire form renders both halves (struck chips for the NOT side), the
// × removes from its own half, and the save payload serializes back to the
// wire form (array when exclusion-free). Also the webhook switch. The
// filter-config-pop pattern: real index.html, real modal, fetch stubbed at
// the seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch } from './helpers.js';
import { window } from './jsdom-stub.js';

const { state } = await import('../public/state.js');
const { openAlertEditor } = await import('../public/alerts-modal.js');

state.me = { id: 1, name: 'tester' };
state.boardId = 'b1';
state.items = [];
state.alerts = [];
state.facets = [];

const openEditor = (existing) => {
  // A test that failed midway leaves its modal open, and createModal adds
  // another #alert-modal beside it — clear it, so the one found is this one.
  document.getElementById('alert-modal')?.closest('.modal-overlay')?.remove();
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
//
// Save is gated on a real edit now (save-gate.js), and these tests are about
// what the editor serializes — so the edit that unlocks the button is a
// rename, which travels in a different key and can't colour the answer.
const saveAndCapture = async (modal, saved = { id: 1 }) => {
  let body;
  const name = modal.querySelector('.al-input');
  name.value += ' (edited)';
  name.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0)); // the gate re-reads on a timeout
  await withFetch(async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ alert: saved }) };
  }, async () => {
    const btn = [...modal.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    assert.equal(btn.hasAttribute('aria-disabled'), false, 'the rename lit Save');
    btn.click();
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

// The webhook's switch sits just above its fields.
const hookSwitch = (modal) => modal.querySelector('.al-hook').previousElementSibling.querySelector('.switch');

test('the webhook switch hides its fields, and saving it off clears the URL and the secret', async () => {
  const modal = openEditor({
    id: 4, name: 'hooked', enabled: true, delivery: 'immediate', condition: { kind: ['a'] },
    webhook_url: 'https://example.com/hook', has_secret: true,
  });
  const fields = modal.querySelector('.al-hook');
  assert.equal(fields.hidden, false, 'a saved URL opens it on');
  hookSwitch(modal).click();
  assert.equal(fields.hidden, true);
  assert.equal(modal.querySelector('#alert-hook-url').value, 'https://example.com/hook', 'hidden, not emptied');
  const body = await saveAndCapture(modal, { id: 4 });
  assert.equal(body.webhook_url, '');
  assert.equal(body.webhook_secret, '', 'the stored secret goes with the URL');
});

test('a webhook switched on with no URL is refused rather than saved as none', async () => {
  const modal = openEditor({ id: 5, name: 'bare', enabled: true, delivery: 'immediate', condition: { kind: ['a'] } });
  const fields = modal.querySelector('.al-hook');
  assert.equal(fields.hidden, true, 'no URL opens it off');
  hookSwitch(modal).click();
  assert.equal(fields.hidden, false);
  assert.equal(await saveAndCapture(modal, { id: 5 }), undefined, 'refused — nothing was sent');
});

const buttonOf = (modal, text) => [...modal.querySelectorAll('button')].find((b) => b.textContent === text);

test('switching the webhook on is an edit by itself, though it sends nothing yet', async () => {
  // On with the URL still empty sends what off sends — the gate has to count
  // the switch, not the body (save-gate.js), or Save sits dead through it.
  const modal = openEditor({ id: 12, name: 'lit', enabled: true, delivery: 'immediate', condition: { kind: ['a'] } });
  const save = buttonOf(modal, 'Save');
  hookSwitch(modal).click();
  await new Promise((r) => setTimeout(r, 0)); // the gate re-reads on a timeout
  assert.equal(save.hasAttribute('aria-disabled'), false, 'the switch alone lit Save');
  hookSwitch(modal).click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(save.getAttribute('aria-disabled'), 'true', 'and flipping it back is no edit');
  closeEditor(modal);
});

test('Cancel closes the editor without saving', async () => {
  const modal = openEditor({ id: 13, name: 'nope', enabled: true, delivery: 'immediate', condition: { kind: ['a'] } });
  modal.querySelector('#alert-name').value = 'changed';
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: true, json: async () => ({}) }; }, async () => {
    buttonOf(modal, 'Cancel').click();
    await new Promise((r) => setTimeout(r, 300)); // past the close's fade fallback
  });
  assert.equal(document.getElementById('alert-modal'), null);
  assert.equal(calls, 0);
});

test('a secret saved without a URL survives an unrelated edit', async () => {
  // The old editor allowed it; such an alert opens switched off, and a rename
  // must not read as "switched off, drop the secret".
  const modal = openEditor({ id: 10, name: 'orphan', enabled: true, delivery: 'immediate', condition: { kind: ['a'] }, has_secret: true });
  const body = await saveAndCapture(modal, { id: 10 });
  assert.equal('webhook_secret' in body, false);
});

test('Record only hides the webhook section, keeps its settings, and asks for no URL', async () => {
  const setRecord = (modal) => {
    const mode = modal.querySelector('select[aria-label="Delivery"]');
    mode.value = 'record';
    mode.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const hookSectionOf = (modal) => modal.querySelector('.al-hook').closest('.modal-section');
  let modal = openEditor({ id: 11, name: 'rec0', enabled: true, delivery: 'record', condition: { kind: ['a'] } });
  assert.equal(hookSectionOf(modal).hidden, true, 'opens hidden, not only when switched to');
  closeEditor(modal);

  modal = openEditor({ id: 8, name: 'rec', enabled: true, delivery: 'immediate', condition: { kind: ['a'] },
    webhook_url: 'https://example.com/hook' });
  assert.equal(hookSectionOf(modal).hidden, false);
  setRecord(modal);
  assert.equal(hookSectionOf(modal).hidden, true);
  const kept = await saveAndCapture(modal, { id: 8 });
  assert.equal(kept.webhook_url, 'https://example.com/hook', 'kept for when delivery comes back');

  // Switched on with no URL, then Record only: the hidden field can't hold up the save.
  modal = openEditor({ id: 9, name: 'rec2', enabled: true, delivery: 'immediate', condition: { kind: ['a'] } });
  hookSwitch(modal).click();
  setRecord(modal);
  assert.equal((await saveAndCapture(modal, { id: 9 })).delivery, 'record');
});

const testBtnOf = (modal) => [...modal.querySelectorAll('button')].find((b) => b.textContent === 'Send test notification');
const typeUrl = (modal, url) => {
  const input = modal.querySelector('#alert-hook-url');
  input.value = url;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

// Switch the webhook on, type a URL, press Test — never Save. Returns the
// request the button made.
const testFire = async (modal, url) => {
  hookSwitch(modal).click();
  typeUrl(modal, url);
  const btn = testBtnOf(modal);
  assert.equal(btn.hasAttribute('aria-disabled'), false, 'an unsaved URL can be tested');
  let sent;
  await withFetch(async (u, opts) => {
    sent = { u, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ ok: true }) };
  }, async () => {
    btn.click();
    await new Promise((r) => setTimeout(r, 20));
  });
  closeEditor(modal);
  return sent;
};

test('the test button fires what the fields hold, without saving first', async () => {
  const sent = await testFire(openEditor({ id: 6, name: 'try', enabled: true, delivery: 'immediate', condition: { kind: ['a'] }, has_secret: true }),
    'https://example.com/new');
  assert.equal(sent.u, '/api/alerts/test');
  assert.deepEqual(sent.body, { id: 6, name: 'try', condition: { kind: ['a'] }, webhook_url: 'https://example.com/new' },
    'the untouched secret is left out, so the stored one signs');
});

test('a new alert can test before it exists', async () => {
  const sent = await testFire(openEditor(null), 'https://example.com/new');
  assert.equal(sent.u, '/api/alerts/test');
  assert.deepEqual(sent.body, { board_id: 'b1', name: '', condition: {}, webhook_url: 'https://example.com/new' });
});

test('a test still in flight when its URL is cleared leaves the button inert', async () => {
  const modal = openEditor({ id: 7, name: 'race', enabled: true, delivery: 'immediate', condition: { kind: ['a'] } });
  hookSwitch(modal).click();
  typeUrl(modal, 'https://example.com/slow');
  const btn = testBtnOf(modal);
  let answer;
  let calls = 0;
  await withFetch(async () => {
    calls++;
    await new Promise((r) => { answer = r; });
    return { ok: true, json: async () => ({ ok: true }) };
  }, async () => {
    btn.click();
    typeUrl(modal, ''); // emptied while the test is out
    answer();
    await new Promise((r) => setTimeout(r, 20));
    btn.click(); // the finished test mustn't have re-armed it
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  assert.equal(calls, 1);
  closeEditor(modal);
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
