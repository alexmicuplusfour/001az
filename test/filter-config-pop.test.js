// The Filter options pop (filterconfigs.js), exercised as a browser would —
// real index.html in jsdom, real dropdown, real open. It carries two tenants
// (saved filters + the lens toggles) and just grew render logic worth
// pinning: the permanent section head, the no-divider segmentation, and the
// already-saved rule that swaps the save input for a statement. All of that
// is composition a pure-module test can't see.
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
const { openFilterConfigPop } = await import('../public/filterconfigs.js');
const { closeDropdown } = await import('../public/dropdown.js');

state.me = { id: 1, name: 'tester' };
state.boardId = 'b1';

// A fresh anchor per open — re-clicking the same anchor is the dropdown's
// own toggle-shut gesture, which is not what's under test here.
const openPop = () => {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  openFilterConfigPop(anchor);
  return document.querySelector('.filter-config-pop');
};
const drop = () => closeDropdown();

test('the saved-filters section head is permanent — even empty, even with no selection', () => {
  state.filterConfigs = [];
  state.selected = new Map();
  const pop = openPop();
  const head = pop.querySelector('.dd-head');
  assert.equal(head?.textContent, 'Saved filters');
  assert.equal(pop.querySelector('.dd-input'), null, 'nothing to save yet');
  assert.equal(pop.querySelectorAll('.dd-check').length, 2, 'both lens toggles present');
  drop();
});

test('a fresh selection gets the save input, with no divider between list and input', () => {
  state.filterConfigs = [{ id: 1, name: 'kept', config: { color: ['red'] } }];
  state.selected = new Map([['color', new Set(['blue'])]]);
  const pop = openPop();
  assert.ok(pop.querySelector('.dd-input'), 'unsaved selection is savable');
  // exactly ONE divider in the pop — the one setting off the lens toggles;
  // the section head does the list/input segmentation now
  assert.equal(pop.querySelectorAll('.dd-sep').length, 1);
  drop();
});

test('an already-saved selection is told so instead of offered a duplicate', () => {
  state.filterConfigs = [{ id: 1, name: 'kept', config: { color: ['red'] } }];
  state.selected = new Map([['color', new Set(['red'])]]);
  const pop = openPop();
  assert.equal(pop.querySelector('.dd-input'), null, 'no input for a selection that is already a config');
  const note = [...pop.querySelectorAll('.dd-empty')].find((n) => n.textContent.includes('Saved as'));
  assert.match(note?.textContent ?? '', /Saved as "kept"/);
  // and the matching row is the lit one
  const rows = [...pop.querySelectorAll('.dd-row')].filter((r) => !r.classList.contains('dd-check'));
  assert.ok(rows.find((r) => r.textContent.includes('kept'))?.className.includes('active'));
  drop();
});
test('the lens rows are toggles, and flipping one leaves the pop open', () => {
  state.filterConfigs = [];
  state.selected = new Map();
  state.showOdds = false;
  const pop = openPop();
  const toggles = pop.querySelectorAll('.dd-check.cb--toggle');
  assert.equal(toggles.length, 2, 'both lens rows wear the toggle costume');
  assert.equal(toggles[0].querySelector('.cb-input').getAttribute('role'), 'switch');
  toggles[0].querySelector('.cb-input').click();
  assert.equal(state.showOdds, true, 'the flip landed');
  assert.ok(document.querySelector('.filter-config-pop'), 'and the pop is still open');
  drop();
  state.showOdds = false;
});

test('an accessor anchor keeps the pop through a re-render, and closes it when the anchor is gone', () => {
  state.filterConfigs = [];
  state.selected = new Map();
  const arrow = document.createElement('button');
  arrow.id = 'test-arrow';
  document.body.appendChild(arrow);
  openFilterConfigPop(() => document.getElementById('test-arrow'));
  const pop = document.querySelector('.filter-config-pop');
  assert.ok(pop && arrow.classList.contains('dd-open'));
  // the toolbar's move: the anchor is replaced by an identical twin mid-open
  const twin = document.createElement('button');
  twin.id = 'test-arrow';
  arrow.replaceWith(twin);
  document.dispatchEvent(new Event('app:render'));
  assert.ok(pop.isConnected, 'the pop survived the swap');
  assert.ok(twin.classList.contains('dd-open'), 'and dressed the replacement');
  assert.equal(twin.getAttribute('aria-expanded'), 'true');
  // a render that REMOVES the anchor rather than replacing it takes the pop with it
  twin.remove();
  document.dispatchEvent(new Event('app:render'));
  assert.equal(pop.isConnected, false, 'nothing to hang from — closed');
});
