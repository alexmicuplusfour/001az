// The boot gate's newest rung (planning/welcome-plan.md Stage 1.3): an admin
// whose instance has no boards and no AI model goes to /welcome instead of to
// the boards page's empty state.
//
// A third boot means a third FILE, for the reason boards-empty.test.js spells
// out — public/boards.js reads `me` once at module scope, so one `me` per
// process. The three now read as a set:
//
//   boards-page.test.js   a member with boards          renders the grid
//   boards-empty.test.js  an admin who SKIPPED          renders the empty state
//   this file             an admin who hasn't yet       never renders at all
//
// dom-stub's location.replace THROWS by default, which is deliberate there —
// "a redirect here means the auth gate misfired" is the right alarm for every
// other page test. This is the one file where a redirect is the subject, so it
// replaces the stub with a recorder before booting the page. That swap is the
// reason this cannot be a test inside boards-empty.test.js even if `me` were
// not module-scoped: the two files want opposite things from the same global.
//
// What it really pins is that the gate REFUSES TO RENDER. Asserting only the
// destination would pass for a page that redirected and then went on to paint
// a screenful of the wrong thing behind it — which is the actual failure mode,
// since location.replace is a no-op in a stub and every line after it still
// runs.
//
// The proof of that is `byId`, which dom-stub fills LAZILY:
// `getElementById: (id) => (byId[id] ||= el())`. An id that is still undefined
// was never asked for. So "the page behind it never opens" is not a claim
// about a `hidden` flag — it is the stronger claim that boards.js never
// reached for those elements at all.
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { byId } from "./dom-stub.js";

const ME = {
  id: 1, name: "Root", email: "root@example.com",
  is_admin: true,
  // The server composes this from three facts (capability-resolve.js
  // setupPending); the client is handed the conclusion and must not re-derive
  // any of it, so the fixture is a bare boolean on purpose.
  setup_pending: true,
};

const redirects = [];

globalThis.fetch = async (url) => {
  const body =
    url.includes("/api/me") ? ME :
    url.includes("/api/boards/overview") ? [] :
    url.includes("/api/boards/signals") ? [] : null;
  if (body === null) throw new Error("unexpected fetch " + url);
  return { ok: true, status: 200, json: async () => body };
};

before(async () => {
  globalThis.location.replace = (u) => redirects.push(u);
  // Same guard as boards-empty: nothing is on screen, so nothing may arm a
  // 60 s interval and hold the run open.
  globalThis.setInterval = () => { throw new Error("ticker armed behind the gate"); };
  await import("../public/boards.js");
  await new Promise((r) => setTimeout(r, 50));
});

test("an admin with setup pending is sent to the chooser", () => {
  assert.deepEqual(redirects, ["/welcome"]);
});

test("…and the page behind it never opens", () => {
  // location.replace is a real navigation in a browser but a no-op here, so
  // every statement after it still executes. The branch has to END the ladder,
  // not merely start a navigation and fall through into the render path.
  //
  // dom-stub creates an element the first time anything asks for it, so an id
  // that is still absent from byId was never touched. The else branch unhides
  // #gate, unhides #boards-grid and fills #toolbar; none of that happened.
  assert.equal(byId["gate"], undefined, "#gate was never unhidden");
  assert.equal(byId["boards-grid"], undefined, "the grid was never reached for");
  assert.equal(byId["toolbar"], undefined, "and no header was built");
});
