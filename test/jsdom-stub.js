// The browser-in-node for tests that must CLICK — real index.html in jsdom,
// installed once into globalThis. ONE copy on purpose, the browser-stub.js
// rule: this block had grown five per-file copies that were already
// drifting (one had MouseEvent, one worked around its absence), and the
// next jsdom quirk would have needed fixing in five places, each miss
// reading as a bug in the module under test. browser-stub.js stays the
// pure-module twin — it can't click; this one can.
//
// Assign the classes UNCONDITIONALLY: Node ships its own global
// Event/CustomEvent, and jsdom's dispatchEvent rejects instances of them —
// a module doing `new Event('app:render')` must get jsdom's class or every
// dispatch throws.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
export const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
export const { window } = dom;

for (const k of ['document', 'localStorage', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'HTMLElement', 'Node']) {
  globalThis[k] = window[k];
}
globalThis.window = window;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
