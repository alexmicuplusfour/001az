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
    icon: 'srcExtract', binding: { provider: false, enable: false, global: true },
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
// A files board with one extract field, for the card-key cases below. It
// HAS items: the pointer reminder is about cards that exist.
const CARD_BOARD = {
  ...BOARD, id: 'b3', name: 'People', has_items: true,
  mapping: {
    card: { by: 'who' },
    face: { source: 'file', prefer: 'image', pick: 'first' },
    fields: [
      { key: 'who', kind: 'text', source: 'extract', instruction: 'the person' },
      { key: 'event', kind: 'text', source: 'extract', instruction: 'the occasion' },
    ],
  },
};
const CONNECTORS = [{
  name: 'stocks', label: 'Stocks', available: true, fields: [],
  faces: [{ name: 'chart', label: 'Price chart', periods: ['1y', '5y'] }],
}];

let patched = null;
let posted = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (opts.method === 'PATCH') { patched = JSON.parse(opts.body); return { ok: true, json: async () => ({}) }; }
  if (opts.method === 'POST') { posted.push(u); return { ok: true, json: async () => ({ ok: true, queued: 7 }) }; }
  const body =
    u.endsWith('/b3/settings') ? structuredClone(CARD_BOARD)
    : u.endsWith('/b2/settings') ? structuredClone(CONNECTOR_BOARD)
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
const click = (n) => n.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
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
  click(sw);
  await tick();
  assert.equal(off(), false, 'auto-tagging was turned off');
  click(sw);
  await tick();
  assert.equal(off(), true, 'and back on');
  shut(modal);
});

test('opening the Mapping pane is not an edit, and an untouched pane sends no mapping', async () => {
  const modal = await open();
  click(modal.querySelector('.pane-toggle-btn[data-pane="mapping"]'));
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
  click(modal.querySelector('.pane-toggle-btn[data-pane="mapping"]'));
  await settle();
  const rm = modal.querySelector('#board-modal-mapping .tile-rm');
  assert.ok(rm, 'the saved field rendered as a removable tile');
  click(rm);
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
  click(modal.querySelector('.pane-toggle-btn[data-pane="mapping"]'));
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
  click(modal.querySelector('.pane-toggle-btn[data-pane="mapping"]'));
  await tick(); // the pane has rendered its saved tiles; the catalog has not landed

  const rm = modal.querySelector('#board-modal-mapping .tile-rm');
  assert.ok(rm, 'saved tiles render before the catalog — they carry their own kind');
  click(rm);
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
  click(modal.querySelector('.pane-toggle-btn[data-pane="mapping"]'));
  await settle();
  assert.equal(off(), true);

  // A period pick is the smallest real change to the face, and it goes through
  // the same drawer a person uses.
  const pane = modal.querySelector('#board-modal-mapping');
  const faceRow = [...pane.querySelectorAll('.mm-def-row')]
    .find((r) => r.querySelector('.mm-def-label')?.textContent === 'face');
  assert.ok(faceRow, 'the face slot renders as a def row');
  click(faceRow);
  await settle();
  const period = [...document.querySelectorAll('.drawer select')]
    .find((sel) => [...sel.options].some((o) => o.value === '5y'));
  assert.ok(period, 'the drawer offers the periods this producer declares');
  period.value = '5y';
  period.dispatchEvent(new window.Event('change', { bubbles: true }));
  const ok = [...document.querySelectorAll('.drawer-foot button')].find((b) => !b.className);
  click(ok);
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
  const paste = [...modal.querySelectorAll('.clip-btn')].find((b) => b.textContent === 'Paste');
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
  [...modal.querySelectorAll('.clip-btn')].find((b) => b.textContent === 'Paste').click();
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

// ─── the card key (planning/card-key-plan.md) ────────────────────────────────
// The Card row is a MENU of the extract fields, not a drawer; a pick rides the
// PATCH as `mapping.card`, "file" drops it, and removing the card field's
// tile resets it. "Match to a list" lives in the field drawer. These are the
// only tests that drive the pane's card row — the browser suite never does.

const openPane = async (id) => {
  const modal = await open(id);
  click(modal.querySelector('.pane-toggle-btn[data-pane="mapping"]'));
  await settle();
  return modal;
};
const cardRow = (modal) => modal.querySelector('#board-modal-mapping [data-place="def:identity"]');
const menuRow = (label) => [...document.querySelectorAll('.dropdown .dd-row')]
  .find((r) => r.querySelector('.dd-label')?.textContent === label);

test('card row: picking a field from the menu arms Save and rides the PATCH as mapping.card', async () => {
  const modal = await openPane('b3');
  assert.match(cardRow(modal).textContent, /one card per who/, 'the saved card key reads on the row');
  click(cardRow(modal));
  await tick();
  assert.ok(menuRow('file') && menuRow('who') && menuRow('event') && menuRow('+ new field'), 'the menu lists file, the extract fields, and new field');
  click(menuRow('event'));
  await settle();
  assert.match(cardRow(modal).textContent, /one card per event/);
  assert.equal(off(), false, 'a different card key is an edit');
  save().click();
  await settle();
  assert.deepEqual(patched.mapping.card, { by: 'event' });
  assert.deepEqual(patched.mapping.face, { source: 'file', prefer: 'image', pick: 'first' }, 'the file face rides under a card key');
  shut(modal);
});

test('card row: picking file drops the card and the file face from the PATCH', async () => {
  const modal = await openPane('b3');
  click(cardRow(modal));
  await tick();
  click(menuRow('file'));
  await settle();
  assert.match(cardRow(modal).textContent, /one card per file/);
  save().click();
  await settle();
  assert.equal('card' in patched.mapping, false);
  assert.equal('face' in patched.mapping, false, 'no face config per file — one instance per card, nothing to pick');
  assert.equal(patched.mapping.fields.length, 2, 'the fields stay');
  shut(modal);
});

test('card row: removing the card field resets the card to per file', async () => {
  const modal = await openPane('b3');
  const rm = modal.querySelector('#board-modal-mapping [aria-label="Remove who"]');
  assert.ok(rm);
  click(rm);
  await tick();
  // (The toast that says so is not asserted: toast.js shows at most three at
  // once and the saves above hold the slots for their 4.5s, so it queues.)
  assert.match(cardRow(modal).textContent, /one card per file/, 'the pointer followed the removal');
  save().click();
  await settle();
  assert.equal('card' in patched.mapping, false);
  assert.deepEqual(patched.mapping.fields.map((f) => f.key), ['event']);
  shut(modal);
});

test('field drawer: "Match to a list" on an extract field rides the PATCH as options', async () => {
  const modal = await openPane('b3');
  click(modal.querySelector('#board-modal-mapping [data-place="tile:extract:event"]'));
  await settle();
  const sw = [...document.querySelectorAll('.drawer .switch-row')]
    .find((r) => /Match to a list/.test(r.textContent))?.querySelector('.switch');
  assert.ok(sw, 'the list toggle lives in the field drawer now');
  click(sw);
  await settle(); // the block rebuilds with its first (empty) option row
  const inputs = document.querySelectorAll('.drawer .fe-val-row input');
  assert.equal(inputs.length, 2, 'one option row: value + hint');
  inputs[0].value = 'Gala';
  inputs[0].dispatchEvent(new window.Event('input', { bubbles: true }));
  const ok = [...document.querySelectorAll('.drawer-foot button')].find((b) => !b.className);
  click(ok);
  await settle();
  assert.equal(off(), false);
  save().click();
  await settle();
  const event = patched.mapping.fields.find((f) => f.key === 'event');
  assert.deepEqual(event.options, [{ value: 'Gala' }]);
  assert.equal(event.kind, 'text');
  shut(modal);
});

// ─── the pointer moved: the cards did not (Stage 5) ──────────────────────────
// A save that moves the card key regenerates nothing — cards are generated,
// they carry hearts and crate places — so after the save toast an info toast
// reminds the reader and hands over the verb. The reminder fires only when
// the pointer changed on a board that has items.

const infoToast = () => [...document.querySelectorAll('.toast--info')].at(-1) || null;
// toast.js shows at most three at once and queues the rest; the saves above
// hold slots for 4.5s, and earlier card moves left reminders queued behind
// them. A click retires a toast through the module (a bare DOM removal would
// leave its slot counted) and lets the next queued one surface — so drain
// until nothing surfaces.
// A sticky toast with actions retires only through them (and the module
// dedupes a repeated message while one is up), so press its Dismiss.
const clearToasts = async () => {
  for (let i = 0; i < 20 && document.querySelector('.toast'); i++) {
    for (const t of document.querySelectorAll('.toast')) {
      const dismiss = [...t.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss');
      if (dismiss) dismiss.click(); else t.click();
    }
    await tick();
  }
};

test('moving the card key on a board with items: an info toast names both keys, and its Reprocess action posts the board reprocess', async () => {
  await clearToasts();
  posted = [];
  const modal = await openPane('b3');
  click(cardRow(modal));
  await tick();
  click(menuRow('event'));
  await settle();
  save().click();
  await settle();
  const t = infoToast();
  assert.ok(t, 'the reminder toast is up');
  assert.match(t.textContent, /^Reprocess the board to generate cards from event\./);
  const btn = [...t.querySelectorAll('button')].find((b) => b.textContent === 'Reprocess');
  assert.ok(btn, 'it carries the verb');
  click(btn);
  await settle();
  assert.deepEqual(posted, ['/api/admin/boards/b3/reprocess']);
  assert.equal(infoToast(), null, 'acting on it closes it');
  shut(modal);
});

test('moving to one card per file words the reminder for it; Dismiss closes it without posting', async () => {
  await clearToasts();
  posted = [];
  const modal = await openPane('b3');
  click(cardRow(modal));
  await tick();
  click(menuRow('file'));
  await settle();
  save().click();
  await settle();
  const t = infoToast();
  assert.match(t.textContent, /^Reprocess the board to make each file its own card\./);
  click([...t.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss'));
  assert.equal(infoToast(), null);
  assert.deepEqual(posted, []);
  shut(modal);
});

test('an edit that leaves the pointer alone, or a board without items, gets no reminder', async () => {
  await clearToasts();
  // Same pointer, a different field edited: no reminder.
  let modal = await openPane('b3');
  click(modal.querySelector('#board-modal-mapping [aria-label="Remove event"]'));
  await tick();
  save().click();
  await settle();
  assert.equal(infoToast(), null, 'the card key did not move');
  shut(modal);
  // The pointer moves on a board with NO items (b1 has none): nothing to regenerate.
  modal = await openPane('b1');
  const add = modal.querySelector('#board-modal-mapping .fe-add-facet');
  assert.ok(add);
  // b1's only field is an unknown source with no drawer; point the card via a new field instead.
  click(cardRow(modal));
  await tick();
  click(menuRow('+ new field'));
  await settle();
  const key = document.querySelector('.drawer input[placeholder=field_key]');
  key.value = 'thing';
  key.dispatchEvent(new window.Event('input', { bubbles: true }));
  click([...document.querySelectorAll('.drawer-foot button')].find((b) => !b.className));
  await settle();
  save().click();
  await settle();
  assert.deepEqual(patched.mapping.card, { by: 'thing' }, 'the pointer did move');
  assert.equal(infoToast(), null, 'but there are no cards to regenerate');
  shut(modal);
});
