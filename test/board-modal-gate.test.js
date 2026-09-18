// The board editor's Save gate (board-modal.js + save-gate.js), in jsdom with
// the network stubbed.
//
// This is the hardest of the gated editors, and the two hard parts are both
// about state that is NOT on screen when the modal opens:
//
//   the capability strip — pins arrive on a fetch, and filling them in moves
//     every one of them into the payload. That is the board's stored state
//     arriving late, not five edits, so the baseline has to move with it.
//   the mapping pane — built lazily, on the first click of the Mapping tab.
//     Merely looking at it must not arm Save, and an edit made there and
//     undone must disarm it again.
//
// The gate is also what now decides whether `mapping` rides the save at all,
// which the server answers with a reschedule and a backfill — so "untouched
// pane sends no mapping" is asserted against the wire, not against a flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './jsdom-stub.js';

const { openBoardModal } = await import('../public/board-modal.js');

const BOARD = {
  id: 'b1', name: 'Wardrobe', context: 'clothes', facets: [],
  ai_reasoning: true, ai_research: false, ai_votes: 1,
  auto_tag: true, auto_tag_periodic: false, auto_tag_every_min: 1440,
  auto_tag_skip_weekends: false, retag_on_refresh: false,
  ai_key_id: 7, ai_model: 'gpt-5-mini',
  capability_config: [],
  has_items: false,
  mapping: { fields: [{ key: 'title', source: 'filename' }] },
};

const CAPS = {
  capabilities: [{
    id: 'tag', label: 'Tagging', noun: 'tagging', agent: 'tagger', declaredBy: 'tag',
    icon: 'srcSparkle', binding: { provider: false, enable: false, global: true },
    floor: { kind: 'blocked' },
    boardBinding: { keyId: 'ai_key_id', model: 'ai_model' },
    running: { provider: 'openai', model: 'gpt-5-mini', keyId: 7 },
    supportedBy: [{ name: 'openai', label: 'OpenAI', installed: true, keyCount: 1, onDevice: false }],
    config: [],
  }],
};
const KEYS = [{ id: 7, name: 'prod', provider: 'openai' }];
const PROVIDERS = [{
  name: 'openai', label: 'OpenAI',
  provides: { tag: { default: 'gpt-5-mini', models: [{ id: 'gpt-5-mini' }, { id: 'gpt-5' }] } },
}];

let patched = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (opts.method === 'PATCH') { patched = JSON.parse(opts.body); return { ok: true, json: async () => ({}) }; }
  const body =
    u.endsWith('/settings') ? structuredClone(BOARD)
    : u.endsWith('/api/admin/ai-keys') ? KEYS
    : u.endsWith('/api/admin/ai-providers') ? PROVIDERS
    : u.endsWith('/api/admin/capabilities') ? CAPS
    : u.includes('/models') ? { source: 'live', models: [{ id: 'gpt-5-mini' }, { id: 'gpt-5' }] }
    : u.endsWith('/api/file-fields') ? []
    : u.endsWith('/api/connectors') ? []
    : {};
  return { ok: true, json: async () => body };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

const save = () => document.getElementById('board-modal-save');
// The gate's "no" is aria-disabled, never the `disabled` attribute — it holds
// the button focusable so it can say why it is dim (save-gate.js).
const off = () => save().getAttribute('aria-disabled') === 'true';
const nameBox = () => document.getElementById('board-modal-name');
const typeName = async (v) => {
  nameBox().value = v;
  nameBox().dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
};

async function open(id = 'b1') {
  patched = null;
  await openBoardModal(id, { canEditAI: true });
  await settle();          // the capability feed and the live model listing
  return document.getElementById('board-edit-modal');
}
const shut = (modal) => modal?.remove();

test('an untouched board editor opens with Save dead — the feed landing is not an edit', async () => {
  const modal = await open();
  // The strip really did fill in: without this the next assertion would pass
  // for the wrong reason.
  assert.ok(modal.querySelector('.frow select'), 'the capability strip mounted its picker');
  assert.equal(off(), true, 'nothing changed — Save has nothing to do');
  shut(modal);
});

test('a rename arms Save, and typing the old name back disarms it', async () => {
  const modal = await open();
  await typeName('Wardrobe Items');
  assert.equal(off(), false);
  await typeName('Wardrobe');
  assert.equal(off(), true, 'back to the name it opened with');
  shut(modal);
});

test('a switch arms it too — an edit is not only a keystroke', async () => {
  const modal = await open();
  const sw = modal.querySelector('#board-modal-autotag button.switch');
  sw.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(off(), false, 'auto-tagging was turned off');
  sw.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(off(), true, 'and back on');
  shut(modal);
});

test('opening the Mapping pane is not an edit, and an untouched pane sends no mapping', async () => {
  const modal = await open();
  modal.querySelector('.pane-toggle-btn[data-pane="mapping"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.ok(modal.querySelector('#board-modal-mapping').children.length, 'the pane built');
  assert.equal(off(), true, 'looking at a pane is not editing it');

  // ...and the wire agrees: an untouched pane keeps the save a light tagging
  // update, with no server-side reschedule or backfill.
  await typeName('Wardrobe Items');
  save().click();
  await settle();
  assert.ok(patched, 'the save went out');
  assert.equal('mapping' in patched, false, 'no mapping key at all');
  assert.equal(patched.name, 'Wardrobe Items');
  shut(modal);
});

test('a real mapping edit arms Save, and rides the same one save', async () => {
  const modal = await open();
  modal.querySelector('.pane-toggle-btn[data-pane="mapping"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  const rm = modal.querySelector('#board-modal-mapping .tile-rm');
  assert.ok(rm, 'the saved field rendered as a removable tile');
  rm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  assert.equal(off(), false, 'a field was removed');

  save().click();
  await settle();
  assert.ok(patched, 'the save went out');
  assert.ok('mapping' in patched, 'a touched pane folds into the same PATCH');
  // The board's only field is gone, and a mapping with nothing in it collapses
  // to null — an unmapped board, not an empty mapping (mapping-modal.js).
  assert.equal(patched.mapping, null, 'and it carries the edit');
  shut(modal);
});

test('a picker moved by its own live model list does not arm Save', async () => {
  // attachLiveModels can move a selection off a pre-render guess the provider
  // disproves. It announces that with `gate:rebase` precisely so a board
  // editor does not light its own Save a second after opening.
  const modal = await open();
  const sel = modal.querySelector('.frow-edit select:not([hidden])');
  assert.ok(sel);
  sel.value = sel.options[sel.options.length - 1].value;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  sel.dispatchEvent(new window.Event('gate:rebase', { bubbles: true }));
  await tick();
  assert.equal(off(), true, 'a move nobody made is not an edit');

  // A pick the PERSON makes is, though — same control, no rebase.
  sel.value = sel.options[0].value;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(off(), false);
  shut(modal);
});

test('a new board cannot be created empty — Create is dead until it is named', async () => {
  patched = null;
  await openBoardModal(null, { canEditAI: true });
  await settle();
  const modal = document.getElementById('board-edit-modal');
  const btn = save();
  assert.equal(btn.textContent, 'Create board');
  assert.equal(btn.getAttribute('aria-disabled'), 'true', 'there is no board here yet');
  await typeName('Recipes');
  assert.equal(btn.hasAttribute('aria-disabled'), false);
  shut(modal);
});

test('broken taxonomy JSON leaves Save reachable — the fix has to be saveable', async () => {
  const modal = await open();
  const facets = document.getElementById('board-modal-facets');
  facets.value = '[{';
  facets.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(off(), false, 'an unbuildable draft counts as changed');
  shut(modal);
});
