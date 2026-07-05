// Board-access authorization matrix. Locks in the Tier 1 hardening: item
// mutations, side-channels, uploads, crates, and static assets must all respect
// board membership, not just a valid session.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, adminSession, seedUser, seedBoard, seedItem, req } from "./helpers.js";

let srv, db, base;
let admin, member, outsider;
let boardA, boardB; // member belongs to A only; B is foreign to them
let itemA, itemB;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  member = await seedUser(db, "member@test.local");
  outsider = await seedUser(db, "outsider@test.local");
  boardA = await seedBoard(db, "A", [member.id]);
  boardB = await seedBoard(db, "B", []); // no members but admin
  itemA = await seedItem(db, boardA);
  itemB = await seedItem(db, boardB);
});

after(() => srv.close());

// Every item-scoped route, hit by a user with no membership on the item's board.
// All must answer 404 (missing and forbidden are indistinguishable by design).
const itemRoutes = (id) => [
  ["DELETE", `/api/items/${id}`],
  ["POST", `/api/items/${id}/reprocess`],
  ["GET", `/api/items/${id}/hearts`],
  ["POST", `/api/items/${id}/favorite`],
  ["GET", `/api/items/${id}/reasoning`],
  ["PATCH", `/api/items/${id}/tags`, { tags: [] }],
];

test("outsider is denied every item route on a board they can't access", async () => {
  for (const [method, url, body] of itemRoutes(itemA.id)) {
    const r = await req(base, method, url, { sid: outsider.sid, body });
    assert.equal(r.status, 404, `${method} ${url}`);
  }
});

test("member is denied item routes on a foreign board", async () => {
  for (const [method, url, body] of itemRoutes(itemB.id)) {
    const r = await req(base, method, url, { sid: member.sid, body });
    assert.equal(r.status, 404, `${method} ${url}`);
  }
});

test("unauthenticated is denied item routes", async () => {
  for (const [method, url, body] of itemRoutes(itemA.id)) {
    const r = await req(base, method, url, { body });
    assert.equal(r.status, 401, `${method} ${url}`);
  }
});

test("member can act on items in their own board", async () => {
  const fav = await req(base, "POST", `/api/items/${itemA.id}/favorite`, { sid: member.sid });
  assert.equal(fav.status, 200);
  assert.equal(fav.json.favorited, true);

  const hearts = await req(base, "GET", `/api/items/${itemA.id}/hearts`, { sid: member.sid });
  assert.equal(hearts.status, 200);

  const tags = await req(base, "PATCH", `/api/items/${itemA.id}/tags`, { sid: member.sid, body: { tags: ["kind/a"] } });
  assert.equal(tags.status, 200);
  assert.deepEqual(tags.json.tags, ["kind/a"]);
});

test("tags PATCH drops values outside the board facets", async () => {
  const r = await req(base, "PATCH", `/api/items/${itemA.id}/tags`, {
    sid: member.sid,
    body: { tags: ["kind/a", "kind/nonsense", "bogus/x"] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.tags, ["kind/a"]);
});

test("admin can access items on any board", async () => {
  const r = await req(base, "GET", `/api/items/${itemB.id}/reasoning`, { sid: admin.sid });
  assert.equal(r.status, 200);
});

test("a non-integer item id is a 404, not a 500", async () => {
  const r = await req(base, "DELETE", `/api/items/abc`, { sid: admin.sid });
  assert.equal(r.status, 404);
});

test("crates are pinned to their own board", async () => {
  // Member creates a crate on their board.
  const create = await req(base, "POST", "/api/crates", { sid: member.sid, body: { name: "c", board_id: boardA } });
  assert.equal(create.status, 200);
  const crateId = create.json.crate.id;

  // Adding a same-board item works; a foreign-board item is rejected.
  const ok = await req(base, "POST", `/api/crates/${crateId}/items/${itemA.id}`, { sid: member.sid });
  assert.equal(ok.status, 200);
  const cross = await req(base, "POST", `/api/crates/${crateId}/items/${itemB.id}`, { sid: member.sid });
  assert.equal(cross.status, 404);
});

test("crate cannot be created on an inaccessible board", async () => {
  const r = await req(base, "POST", "/api/crates", { sid: outsider.sid, body: { name: "x", board_id: boardA } });
  assert.equal(r.status, 404);
});

test("static image bytes require a session", async () => {
  // Drop a file where the thumbnail handler will find it.
  fs.mkdirSync(srv.thumbsDir, { recursive: true });
  fs.writeFileSync(path.join(srv.thumbsDir, "probe.webp"), "not-really-webp");

  const anon = await req(base, "GET", "/thumbnails/probe.webp", {});
  assert.equal(anon.status, 401);
  const authed = await req(base, "GET", "/thumbnails/probe.webp", { sid: member.sid });
  assert.equal(authed.status, 200);
});

test("security headers are set on every response", async () => {
  const res = await fetch(base + "/api/health");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "same-origin");
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("delete removes the item and is idempotent afterward", async () => {
  const victim = await seedItem(db, boardA);
  const del = await req(base, "DELETE", `/api/items/${victim.id}`, { sid: member.sid });
  assert.equal(del.status, 200);
  const again = await req(base, "DELETE", `/api/items/${victim.id}`, { sid: member.sid });
  assert.equal(again.status, 404);
});
