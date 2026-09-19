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

// A connector-flavoured board, for the face-coercion case below.
const CONNECTOR_BOARD = {
  ...BOARD, id: 'b2', name: 'Stocks',
  mapping: {
    input: { connector: 'stocks' },
    fields: [{ key: 'title', source: 'connector', kind: 'text', fn: 'name' }],
    // No `face` — which is exactly the board the coercion rewrites.
  },
};
const CONNECTORS = [{
  name: 'stocks', label: 'Stocks', available: true, fields: [],
  faces: [{ name: 'chart', label: 'Price chart', periods: ['1y', '5y'] }],
}];

let patched = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (opts.method === 'PATCH') { patched = JSON.parse(opts.body); return { ok: true, json: async () => ({}) }; }
  const body =
    u.endsWith('/b2/settings') ? structuredClone(CONNECTOR_BOARD)
    : u.endsWith('/settings') ? structuredClone(BOARD)
    : u.endsWith('/api/admin/ai-keys') ? KEYS
    : u.endsWith('/api/admin/ai-providers') ? PROVIDERS
    : u.endsWith('/api/admin/capabilities') ? CAPS
    : u.includes('/models') ? { source: 'live', models: [{ id: 'gpt-5-mini' }, { id: 'gpt-5' }] }
    : u.endsWith('/api/file-fields') ? []
    : u.endsWith('/api/connectors') ? (await laterTask(), await laterTask(), structuredClone(CONNECTORS))
    : {};
  return { ok: true, json: async () => body };
};

// Paste JSON reads the system clipboard. Node ships its own `navigator`, so
// this replaces the property rather than assigning through it.
//
// readText resolves on a LATER TASK, not a microtask, and that is the point of
// the stub rather than an accident of it: the real clipboard is a permission
// check and an IPC round trip, so the value lands well after the click that
// asked for it. An `async () => CLIPBOARD` resolves in the same task and hides
// the entire bug — the paste would beat the gate's read instead of losing to
// it, and this file would have gone on reporting a fixed feature.
let CLIPBOARD = '';
const laterTask = () => new Promise((r) => setTimeout(r, 0));
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      readText: async () => { await laterTask(); await laterTask(); return CLIPBOARD; },
      writeText: async () => { await laterTask(); },
    },
  },
});

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

// The mirror image of the paste bug, and the more expensive one. When the
// connector catalog lands, the pane COERCES a board saved without a face onto
// the domain's first producer — an async write to the draft that nobody asked
// for. A value-comparing isDirty() reads that as an edit, so the next real
// edit anywhere in the modal drags `mapping` into the PATCH, and the server
// answers a mapping change with a reschedule and a backfill.
test('the connector catalog coercing a face is not an edit', async (t) => {
  const modal = await open('b2');
  modal.querySelector('.pane-toggle-btn[data-pane="mapping"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.ok(modal.querySelector('#board-modal-mapping').children.length, 'the pane built');
  assert.equal(off(), true, 'the catalog landing is not an edit');

  // The consequence, stated against the wire: a rename stays a rename.
  await typeName('Stocks & Shares');
  save().click();
  await settle();
  assert.ok(patched, 'the save went out');
  assert.equal('mapping' in patched, false, 'no mapping rode along, so no reschedule');
  shut(modal);
  t.diagnostic('connector board, no saved face');
});

// The other side of that exactness. The baseline's face is coerced by the same
// rule the draft's is — it is NOT a blanket rebase when the catalog lands,
// because a rebase would also swallow whatever the reader did while the fetch
// was in flight, and losing an edit silently is worse than the bug it fixes.
test('an edit made while the catalog is still loading survives it', async () => {
  const modal = await open('b2');
  modal.querySelector('.pane-toggle-btn[data-pane="mapping"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick(); // the pane has rendered its saved tiles; the catalog has not landed

  const rm = modal.querySelector('#board-modal-mapping .tile-rm');
  assert.ok(rm, 'saved tiles render before the catalog — they carry their own kind');
  rm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle(); // ...and now the catalog lands on top of that edit

  assert.equal(off(), false, 'the removal is still an edit');
  save().click();
  await settle();
  assert.ok('mapping' in patched, 'and it rides the save');
  assert.deepEqual(patched.mapping?.fields, [], 'with the field gone');
  shut(modal);
});

// And a real face change is still an edit — the coercion is excluded from the
// comparison, not the slot.
test('choosing a different face period arms Save', async () => {
  const modal = await open('b2');
  modal.querySelector('.pane-toggle-btn[data-pane="mapping"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(off(), true);

  // A period pick is the smallest real change to the face, and it goes through
  // the same drawer a person uses.
  const pane = modal.querySelector('#board-modal-mapping');
  const faceRow = [...pane.querySelectorAll('.mm-def-row')]
    .find((r) => r.querySelector('.mm-def-label')?.textContent === 'face');
  assert.ok(faceRow, 'the face slot renders as a def row');
  faceRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  const period = [...document.querySelectorAll('.drawer select')]
    .find((sel) => [...sel.options].some((o) => o.value === '5y'));
  assert.ok(period, 'the drawer offers the periods this producer declares');
  period.value = '5y';
  period.dispatchEvent(new window.Event('change', { bubbles: true }));
  const ok = [...document.querySelectorAll('.drawer-foot button')].find((b) => !b.className);
  ok.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(off(), false, 'a face the reader chose IS an edit');
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

// The gate hears a click and re-reads on the next task. Paste JSON writes what
// it pasted AFTER awaiting the clipboard — several tasks later — so the click
// that started it had already been read and found nothing. The symptom was a
// taxonomy visibly replaced over a Save that stayed dead until you went and
// clicked something else.
test('Paste JSON arms Save on its own — the write lands long after the click', async () => {
  const modal = await open();
  CLIPBOARD = JSON.stringify({
    context: 'Catalogue these garments.',
    facets: [{ label: 'Season', values: ['summer', 'winter'] }],
  });
  const paste = [...modal.querySelectorAll('.clip-btn')].find((b) => b.textContent === 'Paste JSON');
  assert.ok(paste, 'the paste chip is there');
  paste.click();
  await settle();

  assert.equal(document.getElementById('board-modal-context').value, 'Catalogue these garments.',
    'the paste really landed');
  assert.equal(off(), false, 'and Save noticed without being prodded');

  // ...and the pasted taxonomy is what a save would carry.
  save().click();
  await settle();
  assert.equal(patched.context, 'Catalogue these garments.');
  assert.deepEqual(patched.facets.map((f) => f.key), ['season']);
  shut(modal);
});

test('a paste of only the context still arms Save', async () => {
  const modal = await open();
  CLIPBOARD = JSON.stringify({ context: 'Only the context moved.' });
  [...modal.querySelectorAll('.clip-btn')].find((b) => b.textContent === 'Paste JSON').click();
  await settle();
  assert.equal(off(), false);
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
