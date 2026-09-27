// The crate pop and tag pop, exercised as a browser would: real index.html in
// jsdom, real modules, real clicks. These paths shipped broken twice (a missed
// `const pin =` in crates.js, a dropped ddAction import in grid.js) because
// no test ever OPENED the pops — browser-stub.js is for pure modules and
// cannot click. Lint (no-undef) catches the free-identifier class; this file
// catches the behavioral class lint can't see: the false "Couldn't create
// crate" toast, the delete that never repaints, the footer that never renders.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { window, clearToasts } from './jsdom-stub.js';
globalThis.confirm = () => true;

// jsdom swallows exceptions thrown inside event listeners (they surface as a
// window "error" event, not to the dispatcher) — collect them so a test can
// fail on a crash inside a pointerenter/click handler instead of passing
// silently past it.
const listenerErrors = [];
window.addEventListener('error', (e) => listenerErrors.push(e.error ?? e.message));

// Route-keyed fetch stub: "METHOD /path" -> response body (or fn(opts) -> body).
const routes = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const key = `${opts.method || 'GET'} ${url}`;
  if (!routes.has(key)) throw new Error(`unstubbed fetch: ${key}`);
  const h = routes.get(key);
  return { ok: true, status: 200, json: async () => (typeof h === 'function' ? h(opts) : h) };
};

const { state } = await import('../public/state.js');
const { openCratePop, closeCratePop, openCratePicker } = await import('../public/crates.js');
const { renderGrid } = await import('../public/grid.js');
const { updateBulkBar } = await import('../public/bulk.js');

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const enter = (el) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const pointerenter = (el) => el.dispatchEvent(new window.Event('pointerenter'));
const noErrorToast = () => assert.equal(document.querySelector('.toast--error'), null,
  document.querySelector('.toast--error')?.textContent);
const noListenerErrors = () => assert.deepEqual(listenerErrors, []);
// An error toast from one test would fail the next one's noErrorToast.
beforeEach(clearToasts);

state.me = { id: 1, name: 'tester' };
state.boardId = 1;

// A stand-in card with a button in it, outside #grid: that container is drawn
// by Preact since Stage 4, and a foreign element in it would be swept away.
function cardWithCrateBtn() {
  const card = document.createElement('div');
  card.className = 'card';
  const btn = document.createElement('button');
  card.appendChild(btn);
  document.body.appendChild(card);
  return btn;
}

test('creating a crate from the card pop: no false error toast, pop reopens with the row', async () => {
  state.crates = [];
  const item = { id: 11, crateIds: new Set() };
  routes.set('POST /api/crates', { crate: { id: 5, name: 'rigs', owned: true, public: false, item_count: 0 } });
  routes.set('POST /api/crates/5/items', { added: 1, already: 0, count: 1 });

  openCratePop(cardWithCrateBtn(), item);
  const input = document.querySelector('.crate-pop .dd-input');
  assert.ok(input, 'crate pop should open with the New crate input');
  input.value = 'rigs';
  enter(input);
  await settle();

  assert.equal(state.crates.length, 1, 'crate should land in state');
  assert.ok(item.crateIds.has(5), 'item should join the new crate');
  noErrorToast();
  const reopened = document.querySelector('.crate-pop');
  assert.ok(reopened && reopened.textContent.includes('rigs'), 'pop should reopen listing the new crate');
  noListenerErrors();
  closeCratePop();
});

// The crate routes the way the server answers them: create finds your crate
// by that name or makes it (as crate 5), the checkbox route toggles, the add
// route only adds. Every answer waits a few ms, so a second Enter lands while
// the first is still working. Membership is the server's, as "crate:card".
function crateServer({ crates = [], members = [] } = {}) {
  const seen = { creates: 0, adds: [], toggles: 0, members: new Set(members) };
  const named = new Map(crates.map((c) => [c.name, c]));
  const later = (body) => new Promise((r) => setTimeout(() => r(body), 5));
  const count = () => [...seen.members].filter((m) => m.startsWith('5:')).length;
  routes.set('POST /api/crates', (opts) => {
    seen.creates++;
    const { name } = JSON.parse(opts.body);
    if (!named.has(name)) named.set(name, { id: 5, name, owned: true, public: false, item_count: 0 });
    return later({ crate: named.get(name) });
  });
  routes.set('POST /api/crates/5/items', (opts) => {
    const { ids } = JSON.parse(opts.body);
    seen.adds.push(ids);
    const fresh = ids.filter((id) => !seen.members.has(`5:${id}`));
    for (const id of fresh) seen.members.add(`5:${id}`);
    return later({ added: fresh.length, already: ids.length - fresh.length, count: count() });
  });
  for (const id of [11, 12, 13]) {
    routes.set(`POST /api/crates/5/items/${id}`, () => {
      seen.toggles++;
      const had = seen.members.delete(`5:${id}`);
      if (!had) seen.members.add(`5:${id}`);
      return later({ added: !had, count: count() });
    });
  }
  return seen;
}
const answered = () => new Promise((r) => setTimeout(r, 60)); // every stand-in answer is in

test('card menu: a double Enter on "New crate…" makes one crate, and the card ends up in it', async () => {
  state.crates = [];
  const item = { id: 11, crateIds: new Set() };
  const server = crateServer();
  openCratePop(cardWithCrateBtn(), item);
  const input = document.querySelector('.crate-pop .dd-input');
  input.value = 'rigs';
  enter(input);
  enter(input); // before the first has answered
  await answered();

  assert.equal(server.creates, 1, 'one create');
  assert.deepEqual([...server.members], ['5:11'], 'the card is in the crate');
  assert.ok(item.crateIds.has(5), 'and the page says so');
  noErrorToast();
  noListenerErrors();
  closeCratePop();
});

test('card menu: "New crate…" with the name of a crate the card is already in keeps it in', async () => {
  // The server finds your crate by name, so this is a crate that exists. The
  // menu used to follow the create with the checkbox's toggle, which took the
  // card out.
  state.crates = [{ id: 5, name: 'rigs', owned: true, public: false, item_count: 1 }];
  const item = { id: 11, crateIds: new Set([5]) };
  const server = crateServer({ crates: state.crates, members: ['5:11'] });
  openCratePop(cardWithCrateBtn(), item);
  const input = document.querySelector('.crate-pop .dd-input');
  input.value = 'rigs';
  enter(input);
  await answered();

  assert.deepEqual([...server.members], ['5:11'], 'still in the crate');
  assert.equal(server.toggles, 0, 'the checkbox route never ran');
  assert.ok(item.crateIds.has(5));
  noErrorToast();
  noListenerErrors();
  closeCratePop();
});

// The picker (openCratePicker): the bulk bar's menu, and the alert editor's.
function pickerAnchor() {
  const btn = document.createElement('button');
  document.body.appendChild(btn);
  return btn;
}

test('the picker lists only your crates, marks the chosen one, and a pick closes it and answers once', () => {
  state.crates = [
    { id: 1, name: 'mine', owned: true, public: false, item_count: 0 },
    { id: 2, name: 'also mine', owned: true, public: false, item_count: 0 },
    { id: 3, name: 'theirs', owned: false, public: true, owner_name: 'Bo', item_count: 0 },
  ];
  const picks = [];
  openCratePicker(pickerAnchor(), { activeId: 2, onPick: (c) => picks.push(c.id) });
  const rows = [...document.querySelectorAll('.crate-pop .dd-row')];
  assert.deepEqual(rows.map((r) => r.textContent), ['mine', 'also mine'], "your crates, not someone else's public one");
  assert.deepEqual(rows.map((r) => r.classList.contains('active')), [false, true], 'the chosen one is marked');
  assert.ok(document.querySelector('.crate-pop .dd-sep'), 'a line between the list and the New crate… box');

  rows[0].click();
  assert.deepEqual(picks, [1], 'one answer, the crate picked');
  assert.equal(document.querySelector('.crate-pop'), null, 'the menu closed');
  noListenerErrors();
});

test('the picker: a double Enter on "New crate…" makes one crate, and picks it once', async () => {
  state.crates = [{ id: 1, name: 'mine', owned: true, public: false, item_count: 0 }];
  const server = crateServer();
  const picks = [];
  openCratePicker(pickerAnchor(), { onPick: (c) => picks.push(c.id) });
  const input = document.querySelector('.crate-pop .dd-input');
  input.value = 'fresh';
  enter(input);
  enter(input);
  await answered();

  assert.equal(server.creates, 1, 'one create');
  assert.deepEqual(picks, [5], 'picked once: the new crate');
  assert.deepEqual(state.crates.map((c) => c.id), [1, 5], 'and it joined the list');
  assert.equal(document.querySelector('.crate-pop'), null, 'the menu closed');
  noErrorToast();
  noListenerErrors();
});

test('the picker: with no crates of your own, no rows, no divider over them, and a note saying so', () => {
  state.crates = [{ id: 3, name: 'theirs', owned: false, public: true, owner_name: 'Bo', item_count: 0 }];
  const ctx = openCratePicker(pickerAnchor(), { onPick: () => {} });
  assert.equal(document.querySelectorAll('.crate-pop .dd-row').length, 0);
  assert.equal(document.querySelector('.crate-pop .dd-sep'), null, 'no line over an empty list');
  assert.equal(document.querySelector('.crate-pop .dd-empty')?.textContent, 'None yet — name one below.');
  assert.ok(document.querySelector('.crate-pop .dd-input'), 'just the New crate… box');
  ctx.close();
});

test('the bulk bar: one add for every selected card, and all of them join', async () => {
  state.crates = [{ id: 5, name: 'picks', owned: true, public: false, item_count: 1 }];
  state.items = [11, 12, 13].map((id) => ({ id, crateIds: new Set(id === 11 ? [5] : []) }));
  state.bulkSelected = new Set([11, 12, 13]);
  const server = crateServer({ crates: state.crates, members: ['5:11'] });
  updateBulkBar();
  try {
    document.querySelector('#bulk-bar .bb-btn.crate').click();
    document.querySelector('.crate-pop .dd-row').click();
    await answered();

    assert.deepEqual(server.adds, [[11, 12, 13]], 'one request, the whole selection');
    assert.equal(server.toggles, 0, 'the checkbox route never ran');
    assert.deepEqual([...server.members].sort(), ['5:11', '5:12', '5:13'], 'all in, the one already there too');
    assert.ok(state.items.every((i) => i.crateIds.has(5)), 'and the page says so');
    assert.ok([...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Added 2 to "picks"')),
      'the toast counts what the server added');
    noErrorToast();
    noListenerErrors();
  } finally {
    state.bulkSelected = new Set();
    updateBulkBar();
  }
});

test('deleting a crate from the filter pop: state drops it, as a new list', async () => {
  const before = [{ id: 7, name: 'olds', owned: true, public: false, item_count: 0 }];
  state.crates = before;
  state.items = [];
  routes.set('DELETE /api/crates/7', {});

  const btn = document.createElement('button'); // toolbar Crates button: not in a .card
  document.body.appendChild(btn);
  openCratePop(btn, null);
  const del = document.querySelector('.crate-pop .dd-del');
  assert.ok(del, 'owned crate row should carry a delete button');
  del.click();
  await settle();

  assert.equal(state.crates.length, 0, 'crate should leave state');
  // Since Stage 5 nothing asks for a repaint: the page draws on a write it can
  // see, which for a list is a new list, not the old one edited.
  assert.notEqual(state.crates, before, 'a new list, not the old one edited');
  noErrorToast();
  noListenerErrors();
});

test('tag pop opens with its Edit tags footer', async () => {
  state.facets = [{ key: 'style', name: 'Style' }];
  const item = {
    id: 12, kind: 'image', url: 'x.jpg', thumb: 'x.jpg', w: 4, h: 3,
    tags: ['sleek'], instances: [{ id: 1, kind: 'image', status: 'tagged' }],
    status: 'tagged', undecided: false, crateIds: new Set(), hearts: 0, favoritedByMe: false,
  };
  renderGrid('crate-pop|grid', [], [item]); // the grid draws the card (Stage 4: cards are components)
  const card = document.querySelector('#grid .card[data-id="12"]');
  assert.ok(card, 'the grid drew the card');
  pointerenter(card); // hover chrome: card-actions + tag chip
  await settle(); // a card's hover is state, drawn a tick later (Stage 4)
  const chip = card.querySelector('.tag-chip');
  assert.ok(chip, 'hover should attach the tag chip');
  pointerenter(chip); // opens the tag pop
  const pop = document.querySelector('.tag-pop');
  assert.ok(pop, 'tag pop should open');
  assert.ok(pop.textContent.includes('Edit tags'), 'footer should carry the Edit tags action');
  noListenerErrors();
});
