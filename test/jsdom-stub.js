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
// a module doing `new Event('app:uploads-pending-changed')` must get jsdom's
// class or every dispatch throws.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
export const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
export const { window } = dom;

for (const k of ['document', 'localStorage', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'HTMLElement', 'Node', 'Image']) {
  globalThis[k] = window[k];
}
globalThis.window = window;
// The save gate's own check (save-gate.js): a choice that moves while the
// editor's read() doesn't throws, so every test that clicks one is a check.
globalThis.__checkGate = true;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
// jsdom lays nothing out, so nothing ever comes into view by itself. The
// observers are kept, so a test can say an element came into view: the
// "load more" marker under the gallery (batches.js), say.
const observers = new Set();
globalThis.IntersectionObserver ??= class {
  constructor(callback) { this.callback = callback; this.watched = new Set(); observers.add(this); }
  observe(el) { this.watched.add(el); }
  unobserve(el) { this.watched.delete(el); }
  disconnect() { this.watched.clear(); }
};
export function intersect(el) {
  for (const o of observers) if (o.watched.has(el)) o.callback([{ target: el, isIntersecting: true }], o);
}
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
// jsdom lays nothing out, so it has no scrolling to do.
window.HTMLElement.prototype.scrollIntoView ??= function () {};

// Toasts outlive the test that raised them, and toast.js shows three at once
// and queues the rest, so a test that reads one clears the old ones first. A
// click retires a toast through the module (a bare DOM removal would leave its
// slot counted) and lets the next queued one surface, so this drains until
// nothing surfaces. A sticky toast with actions retires only through them (and
// the module dedupes a repeated message while one is up), so it gets Dismiss.
export async function clearToasts() {
  for (let i = 0; i < 20 && document.querySelector('.toast'); i++) {
    for (const t of document.querySelectorAll('.toast')) {
      const dismiss = [...t.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss');
      if (dismiss) dismiss.click(); else t.click();
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}
