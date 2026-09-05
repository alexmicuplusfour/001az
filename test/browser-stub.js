// The minimum browser a PURE front-end module needs to be importable under
// node: the client modules reach for localStorage at module scope, and data.js
// registers a document listener when it loads. Nothing here has to do anything
// real — the functions under test are pure — but it must be in place BEFORE
// the client import, which is why this is a module with a top-level effect
// rather than a setup() a test remembers to call.
//
// Import it statically, then pull the client modules in with `await import`:
// static imports evaluate in declaration order, so the globals are up before
// public/ is touched.
//
// ONE copy on purpose. Two test files needed this, and a stub kept in two
// places drifts the first time one of them needs a method the other doesn't —
// with a failure that reads as a bug in the module under test.
const store = new Map();

// Exported so a test can reset the watermarks between cases.
export const localStore = store;

globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// `body` is here for the same reason `addEventListener` is: toast.js builds
// its container at module scope, and jobs-modal.js imports it — so a module
// that only wanted summaryFor drags a document.body.appendChild into the
// import. Absorbing that here is the settled answer (data.js's listener was
// absorbed, not made lazy); the production modules stay eager.
globalThis.document ||= {
  addEventListener() {},
  dispatchEvent() { return true; },
  body: { appendChild() {} },
  createElement: () => ({ appendChild() {}, setAttribute() {} }),
  // filters.js caches its rail containers at module scope, so every importer
  // of it needs this — two test files had grown their own copy of the line,
  // which is the drift this file's header exists to prevent.
  getElementById: () => null,
};
