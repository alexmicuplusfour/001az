// getJson (public/api.js) — the one client helper whose answer decides where a
// reader ENDS UP rather than what renders, so it has to keep apart the two
// failures every other fetch in the app is happy to fold together.
//
// The bug it exists to prevent was live: the gallery's board fetch read
// `.then(r => r.ok ? r.json() : null).catch(() => null)`, so "this board isn't
// yours" and "the request died" arrived as the same null. Acting on that null
// would have bounced a reader off their own board whenever a request dropped;
// NOT acting on it left a signed-in reader staring at an item-scoped page with
// no items, no filters and no board, which is what actually shipped.
import { test } from "node:test";
import assert from "node:assert/strict";

import { getJson } from "../public/api.js";

const serve = (fn) => { globalThis.fetch = fn; };

test("an answer that parses comes back as data", async () => {
  serve(async () => ({ ok: true, status: 200, json: async () => ({ id: "b1", name: "People" }) }));
  assert.deepEqual(await getJson("/api/boards/b1"), { data: { id: "b1", name: "People" } });
});

test("a refusal comes back as its status, and carries no data", async () => {
  serve(async () => ({ ok: false, status: 404, json: async () => ({ error: "not found" }) }));
  const r = await getJson("/api/boards/gone");
  assert.equal(r.status, 404);
  assert.ok(!("data" in r), "a caller testing `data` must not see a refusal as a board");
});

test("…and it is the status, not a boolean — 401 is a different move from 404", async () => {
  // The gallery acts on 404 alone: a 401 is an expired session, which the
  // /api/me gate turns into one hop to login. A helper that only said "failed"
  // would make those two indistinguishable at the call site.
  serve(async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }));
  assert.deepEqual(await getJson("/api/boards/b1"), { status: 401 });
});

test("no answer at all is empty — neither data nor a status to act on", async () => {
  serve(async () => { throw new TypeError("Failed to fetch"); });
  assert.deepEqual(await getJson("/api/boards/b1"), {});
});

test("a 200 whose body won't parse is no answer either, not an empty board", async () => {
  // The failure this rules out is subtle and total: a proxy returning an HTML
  // error page with a 200 would otherwise throw INSIDE the caller's await,
  // taking down boot, or — if it parsed to null — read as a board with no name.
  serve(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }));
  assert.deepEqual(await getJson("/api/boards/b1"), {});
});

test("fetch options are passed through — the callers that need no-store depend on it", async () => {
  let seen = null;
  serve(async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => ({}) }; });
  await getJson("/api/boards/b1", { cache: "no-store" });
  assert.equal(seen.url, "/api/boards/b1");
  assert.deepEqual(seen.opts, { cache: "no-store" });
});
