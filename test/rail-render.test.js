// The filter rail rendered whole (renderFacetsInto), exercised as a browser
// would — real index.html in jsdom. Born from a Stage 2 near-miss
// (planning/chip-exclusion-plan.md): the row blocks read the selection's
// entry shape directly, no pure-module test renders them, and a shape change
// that missed one `[...sel]` would throw on every render in production while
// the whole suite stayed green. This file is the net: every row species
// (status, clusters, objects, uploaders, real facets) rendered under a
// selection that carries live values, gone values, and an inert exclusion.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './jsdom-stub.js';

const { state } = await import('../public/state.js');
const { toItem } = await import('../public/utils.js');
const { selEntry } = await import('../public/facet-match.js');
const { renderFacetsInto } = await import('../public/filters.js');

state.me = { id: 1, name: 'tester' };
state.boardId = 'b1';
state.facets = [
  { key: 'color', label: 'Color', values: ['red', 'blue'] },
  { key: 'size', label: 'Size', values: ['big', 'small'] },
];
state.boardMapping = { fields: [{ key: 'car', source: 'detect' }] };
state.items = [
  { id: 1, name: 'a', status: 'tagged', tags: ['color/red', 'size/big'], objects: ['car'],
    uploadedBy: { id: 5, name: 'alex' } },
  { id: 2, name: 'b', status: 'tagged', tags: ['color/blue'],
    uploadedBy: { id: 6, name: 'sam' } },
].map(toItem);

const render = () => {
  const box = document.createElement('div');
  renderFacetsInto(box);
  return box;
};
const pillTexts = (box) => [...box.querySelectorAll('.pill')].map((p) => p.firstChild.textContent);
const pillByText = (box, text) =>
  [...box.querySelectorAll('.pill')].find((p) => p.firstChild.textContent === text);

afterEach(() => {
  state.selected = new Map();
  state.showOdds = 0;
});

test('every row species renders under a mixed selection without throwing', () => {
  state.selected = new Map([
    ['color', selEntry(['red'])],
    ['size', selEntry([], ['small'])],          // inert exclusion — Stage 2 contract
    ['~objects', selEntry(['car'])],
    ['~uploaders', selEntry(['5'])],
  ]);
  const box = render();
  const labels = [...box.querySelectorAll('.facet-label')].map((el) => el.textContent);
  assert.ok(labels.includes('OBJECTS'), 'objects row present');
  assert.ok(labels.includes('UPLOADED BY'), 'uploaders row present');
  assert.ok(labels.includes('Color') && labels.includes('Size'), 'facet rows present');
  assert.ok(pillTexts(box).includes('red'), 'facet value pill rendered');
});

test('selected values keep their click-off pill from either half', () => {
  state.selected = new Map([
    // 'small' is declared but holds zero items — visible only because it is
    // selected, and the selection sits in the NOT half: the union rule.
    ['size', selEntry([], ['small'])],
    // The system rows have gone-value loops: values absent from the current
    // universe still render a click-off.
    ['~objects', selEntry(['gone-field'])],
    ['~uploaders', selEntry(['99'])],
  ]);
  const texts = pillTexts(render());
  for (const v of ['small', 'gone-field', '99']) {
    assert.ok(texts.includes(v), `selected value "${v}" still renders its click-off`);
  }
});

test('an empty selection renders the bare rail', () => {
  state.selected = new Map();
  const box = render();
  assert.ok(pillTexts(box).length >= 4, 'value pills render with nothing selected');
});

// ── Stage 3: the excluded pill and its gestures ──────────────────────────────

test('an excluded pill wears .neg, a signed count, no mute, no odds badge', () => {
  state.showOdds = 1;
  state.selected = new Map([['color', selEntry([], ['red'])]]);
  const box = render();
  const red = pillByText(box, 'red');
  assert.ok(red.classList.contains('neg'), 'the .neg state');
  assert.equal(red.querySelector('.count').textContent, '−1', 'the count is what it removes, signed');
  assert.ok(!red.classList.contains('muted'), 'a chosen state never mutes');
  assert.equal(red.querySelector('.mult'), null, 'no odds badge on a chosen chip');
  // A declared value nothing holds: excluded, it must show plain 0, not −0.
  state.selected = new Map([['size', selEntry([], ['small'])]]);
  const small = pillByText(render(), 'small');
  assert.equal(small.querySelector('.count').textContent, '0', 'removes nothing — unsigned zero');
  assert.ok(!small.classList.contains('muted'), 'inert but chosen — clearable, not muted');
});

test('contextmenu toggles exclusion; Alt+click is its twin; left-click includes', () => {
  state.selected = new Map();
  let box = render();
  pillByText(box, 'red').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.ok(state.selected.get('color').not.has('red'), 'right-click excludes');
  box = render();
  assert.ok(pillByText(box, 'red').classList.contains('neg'));
  pillByText(box, 'red').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const entry = state.selected.get('color');
  assert.ok(entry.any.has('red') && !entry.not.has('red'), 'left-click on an excluded chip includes it — each clears the other');
  box = render();
  pillByText(box, 'blue').dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true }));
  assert.ok(state.selected.get('color').not.has('blue'), 'Alt+click routes to exclusion');
  box = render();
  pillByText(box, 'blue').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.ok(!state.selected.get('color').not.has('blue'), 'right-click again clears the exclusion');
});

test('the −N respects the facet\'s own includes: an inert strike says 0', () => {
  // The user-found case (2026-09-08): color is single-valued per item, so
  // with blue included, striking red removes nothing — the count must say
  // so instead of quoting the leave-facet-out number (which said −29 live).
  state.selected = new Map([['color', selEntry(['blue'], ['red'])]]);
  const red = pillByText(render(), 'red');
  assert.equal(red.querySelector('.count').textContent, '0', 'inert strike, honest zero');
  assert.ok(red.classList.contains('neg'), 'still chosen and clearable');
});

test('the −N bites on multi-valued facets: un-strike restores exactly N', () => {
  const extra = toItem({ id: 3, name: 'c', status: 'tagged', tags: ['size/big', 'size/small'] });
  state.items = [...state.items, extra];
  state.selected = new Map([['size', selEntry(['big'], ['small'])]]);
  const small = pillByText(render(), 'small');
  assert.equal(small.querySelector('.count').textContent, '−1',
    'the dual-tagged item is what the strike removes — big-only items were never at stake');
  state.items = state.items.slice(0, 2);
});

test('a mouse right-click never eats the next left-click', () => {
  // ONE container across both gestures — the real rail's shape. The earlier
  // tests re-rendered between dispatches, handing each gesture a fresh
  // handler and hiding exactly this: the swallow flag armed by a mouse
  // right-click (which no synthetic click ever follows) lay in wait and ate
  // the next legitimate click anywhere in the rail.
  const box = render();
  pillByText(box, 'red').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.ok(state.selected.get('color').not.has('red'), 'right-click excludes');
  pillByText(box, 'blue').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok(state.selected.get('color').any.has('blue'), 'the very next left-click lands');
});
