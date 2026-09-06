// The crate pop and tag pop, exercised as a browser would: real index.html in
// jsdom, real modules, real clicks. These paths shipped broken twice (a missed
// `const pin =` in crates.js, a dropped ddAction import in grid.js) because
// no test ever OPENED the pops — browser-stub.js is for pure modules and
// cannot click. Lint (no-undef) catches the free-identifier class; this file
// catches the behavioral class lint can't see: the false "Couldn't create
// crate" toast, the delete that never repaints, the footer that never renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;
// Assign UNCONDITIONALLY: Node ships its own global Event/CustomEvent, and
// jsdom's dispatchEvent rejects instances of them — a module doing
// `new Event('app:render')` must get jsdom's class or every dispatch throws.
for (const k of ['document', 'localStorage', 'Event', 'CustomEvent', 'KeyboardEvent', 'HTMLElement', 'Node']) {
  globalThis[k] = window[k];
}
globalThis.window = window;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.confirm = () => true;

// jsdom swallows exceptions thrown inside event listeners (they surface as a
// window "error" event, not to the dispatcher) — collect them so a test can
// fail on a crash inside a pointerenter/click handler instead of passing
// silently past it.
const listenerErrors = [];
window.addEventListener('error', (e) => listenerErrors.push(e.error ?? e.message));

// Route-keyed fetch stub: "METHOD /path" -> response body (or fn -> body).
const routes = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const key = `${opts.method || 'GET'} ${url}`;
  if (!routes.has(key)) throw new Error(`unstubbed fetch: ${key}`);
  const h = routes.get(key);
  return { ok: true, status: 200, json: async () => (typeof h === 'function' ? h() : h) };
};

const { state } = await import('../public/state.js');
const { openCratePop, closeCratePop } = await import('../public/crates.js');
const { cardFor } = await import('../public/grid.js');

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const enter = (el) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const pointerenter = (el) => el.dispatchEvent(new window.Event('pointerenter'));
const noErrorToast = () => assert.equal(document.querySelector('.toast--error'), null,
  document.querySelector('.toast--error')?.textContent);
const noListenerErrors = () => assert.deepEqual(listenerErrors, []);

state.me = { id: 1, name: 'tester' };
state.boardId = 1;

function cardWithCrateBtn() {
  const card = document.createElement('div');
  card.className = 'card';
  const btn = document.createElement('button');
  card.appendChild(btn);
  document.getElementById('grid').appendChild(card);
  return btn;
}

test('creating a crate from the card pop: no false error toast, pop reopens with the row', async () => {
  state.crates = [];
  const item = { id: 11, crateIds: new Set() };
  routes.set('POST /api/crates', { crate: { id: 5, name: 'rigs', owned: true, public: false, item_count: 0 } });
  routes.set('POST /api/crates/5/items/11', { added: true, count: 1 });

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

test('deleting a crate from the filter pop: state drops it and a repaint fires', async () => {
  state.crates = [{ id: 7, name: 'olds', owned: true, public: false, item_count: 0 }];
  state.items = [];
  routes.set('DELETE /api/crates/7', {});
  let renders = 0;
  const count = () => renders++;
  document.addEventListener('app:render', count);

  const btn = document.createElement('button'); // toolbar Crates button: not in a .card
  document.body.appendChild(btn);
  openCratePop(btn, null);
  const del = document.querySelector('.crate-pop .dd-del');
  assert.ok(del, 'owned crate row should carry a delete button');
  del.click();
  await settle();

  assert.equal(state.crates.length, 0, 'crate should leave state');
  assert.ok(renders >= 1, 'delete must dispatch app:render — the live-update the UI depends on');
  noErrorToast();
  noListenerErrors();
  document.removeEventListener('app:render', count);
});

test('tag pop opens with its Edit tags footer', async () => {
  state.facets = [{ key: 'style', name: 'Style' }];
  const item = {
    id: 12, kind: 'image', url: 'x.jpg', thumb: 'x.jpg', w: 4, h: 3,
    tags: ['sleek'], instances: [{ id: 1, kind: 'image', status: 'tagged' }],
    status: 'tagged', undecided: false, crateIds: new Set(), hearts: 0, favoritedByMe: false,
  };
  const card = cardFor(item);
  document.getElementById('grid').appendChild(card);
  pointerenter(card); // hover chrome: card-actions + tag chip
  const chip = card.querySelector('.tag-chip');
  assert.ok(chip, 'hover should attach the tag chip');
  pointerenter(chip); // opens the tag pop
  const pop = document.querySelector('.tag-pop');
  assert.ok(pop, 'tag pop should open');
  assert.ok(pop.textContent.includes('Edit tags'), 'footer should carry the Edit tags action');
  noListenerErrors();
});
