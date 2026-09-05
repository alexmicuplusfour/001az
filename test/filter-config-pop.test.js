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