// The browser boards.js boots against: a document rich enough for a page that
// BUILDS its own chrome, where browser-stub.js is only rich enough for a module
// that merely touches one.
//
// Split out for the reason browser-stub.js states in its own header — "ONE copy
// on purpose… a stub kept in two places drifts the first time one of them needs
// a method the other doesn't, with a failure that reads as a bug in the module
// under test". Two test files boot this page now (the wiring, and the empty
// states), and the second was going to be a hand copy of the first.
//
// Import it statically, then pull public/ in with `await import`: static imports
// evaluate in declaration order, so the globals are up before the page runs.
import { localStore } from "./browser-stub.js";

export { localStore };

// One class-selector matcher instead of the per-test special cases it replaces.
// Containment on the split list, not equality on className: an element that
// carries a shared utility class alongside its own (.bc-signal-note.vis-hidden)
// still answers to either.
const hasClass = (node, cls) => String(node.className).split(/\s+/).includes(cls);
const parseSel = (sel) => {
  const m = String(sel).match(/^(?::scope\s*>\s*)?\.([\w-]+)$/);
  return m ? { cls: m[1], direct: sel.includes(":scope") } : null;
};

export function el(tag = "div") {
  const n = {
    tag, children: [], attrs: {}, dataset: {}, style: {}, classes: new Set(),
    className: "", textContent: "", innerHTML: "", href: "", title: "", type: "", hidden: false,
    classList: {
      add: (c) => n.classes.add(c), remove: (c) => n.classes.delete(c),
      contains: (c) => n.classes.has(c), toggle() {},
    },
    appendChild(c) { c.parent = n; n.children.push(c); return c; },
    append(...c) { c.forEach((x) => n.appendChild(x)); },
    replaceChildren(...c) { n.children.length = 0; c.forEach((x) => n.appendChild(x)); },
    remove() { const k = n.parent?.children; if (k) k.splice(k.indexOf(n), 1); },
    setAttribute(k, v) { n.attrs[k] = v; },
    getAttribute(k) { return n.attrs[k] ?? null; },
    removeAttribute(k) { delete n.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    // Direct children only either way — the real `.foo` descends, but nothing
    // these pages ask for is nested deeper, and a shim that quietly answered
    // about a grandchild would hide a moved element rather than fail on it.
    querySelector(sel) {
      const p = parseSel(sel);
      return p ? n.children.find((c) => hasClass(c, p.cls)) || null : null;
    },
    querySelectorAll(sel) {
      const p = parseSel(sel);
      return p ? n.children.filter((c) => hasClass(c, p.cls)) : [];
    },
  };
  return n;
}

// The elements the page looks up by id, kept so a test can reach the same node
// the page rendered into.
export const byId = {};

globalThis.document = {
  hidden: false,
  getElementById: (id) => (byId[id] ||= el()),
  createElement: el,
  createDocumentFragment: el,
  querySelector: (s) => (s === "header" ? el() : null),
  // "#id .class" — matched on the CLASS, not just the container. The looser
  // "every child of #boards-grid" this replaces was wrong in exactly the case
  // that matters: on an empty page the grid's only child is the empty-state
  // <p>, which would answer to `.bc-wrap` and convince the page it had a card.
  querySelectorAll(sel) {
    const m = String(sel).match(/^#([\w-]+)\s+\.([\w-]+)$/);
    return m ? (byId[m[1]]?.children || []).filter((c) => hasClass(c, m[2])) : [];
  },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  body: el(), documentElement: el(), head: el(),
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({}),
};
globalThis.getComputedStyle = () => ({});
globalThis.location = {
  href: "/boards", pathname: "/boards", search: "",
  // A redirect here means the auth gate misfired, which would leave a signed-in
  // reader bounced to the login page. Loud rather than silent.
  replace(u) { throw new Error("unexpected redirect to " + u); },
};
// Recorded, not ignored: a page that consumes a one-shot URL param has to be
// checkable on having actually consumed it, and "the address afterwards" is the
// only evidence of that. Kept in step with `location` so a test can read either.
export const historyCalls = [];
globalThis.history = {
  replaceState(_s, _t, url) {
    historyCalls.push(url);
    if (typeof url === "string") {
      const [path, query = ""] = url.split("?");
      globalThis.location.pathname = path;
      globalThis.location.search = query ? `?${query}` : "";
      globalThis.location.href = url;
    }
  },
  pushState() {},
};
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.Audio = class { play() { return Promise.resolve(); } };

// A toast schedules its own dismissal seconds out (toast.js `startTimer`), and
// under node that timer keeps the process alive long after the assertions are
// done — a test file that toasts would otherwise sit for the full 4.5 s. Unref
// the long ones only: the short awaits a test uses to let boot settle still
// have to hold the loop open, or the run ends before the page finishes.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  const t = realSetTimeout(fn, ms, ...rest);
  if (ms >= 1000) t?.unref?.();
  return t;
};
