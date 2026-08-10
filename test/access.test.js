// Board-access authorization matrix. Locks in the Tier 1 hardening: item
// mutations, side-channels, uploads, crates, and static assets must all respect
// board membership, not just a valid session.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { startServer, adminSession, seedUser, seedBoard, seedItem, req } from "./helpers.js";
import { mintInvite, setBoardMembers, createAiKey, setSetting, setPluginState } from "../server/db.js";

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

// Every entity- and instance-scoped route, hit by a user with no membership
// on the board. All must answer 404 (missing and forbidden are
// indistinguishable by design). Cards/hearts/crates speak entity ids;
// tags/reasoning/reextract speak instance ids.
const itemRoutes = (item) => [
  ["DELETE", `/api/items/${item.id}`],
  ["POST", `/api/items/${item.id}/reprocess`],
  ["GET", `/api/items/${item.id}/hearts`],
  ["POST", `/api/items/${item.id}/favorite`],
  ["GET", `/api/instances/${item.instanceId}/reasoning`],
  ["PATCH", `/api/instances/${item.instanceId}/tags`, { tags: [] }],
  ["POST", `/api/instances/${item.instanceId}/reextract`],
  ["POST", `/api/instances/${item.instanceId}/retag`],
  ["DELETE", `/api/instances/${item.instanceId}`],
];

test("outsider is denied every item route on a board they can't access", async () => {
  for (const [method, url, body] of itemRoutes(itemA)) {
    const r = await req(base, method, url, { sid: outsider.sid, body });
    assert.equal(r.status, 404, `${method} ${url}`);
  }
});

test("member is denied item routes on a foreign board", async () => {
  for (const [method, url, body] of itemRoutes(itemB)) {
    const r = await req(base, method, url, { sid: member.sid, body });
    assert.equal(r.status, 404, `${method} ${url}`);
  }
});

test("unauthenticated is denied item routes", async () => {
  for (const [method, url, body] of itemRoutes(itemA)) {
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

  const tags = await req(base, "PATCH", `/api/instances/${itemA.instanceId}/tags`, { sid: member.sid, body: { tags: ["kind/a"] } });
  assert.equal(tags.status, 200);
  assert.deepEqual(tags.json.tags, ["kind/a"]);
});

test("tags PATCH drops values outside the board facets", async () => {
  const r = await req(base, "PATCH", `/api/instances/${itemA.instanceId}/tags`, {
    sid: member.sid,
    body: { tags: ["kind/a", "kind/nonsense", "bogus/x"] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.tags, ["kind/a"]);
});

test("admin can access items on any board", async () => {
  const r = await req(base, "GET", `/api/instances/${itemB.instanceId}/reasoning`, { sid: admin.sid });
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

// Regression: the crate route once validated :itemId against the items table,
// though the client sends entity ids. The two id sequences overlap and advance
// nearly in lockstep, so a same-numbered item row usually exists and the wrong
// lookup passed by coincidence — until deletions desynced the sequences in
// prod. Desync them here so the coincidence can't mask the bug again.
test("crating works for an entity id with no same-numbered item row", async () => {
  await db.query(
    "SELECT setval(pg_get_serial_sequence('entities','id'), (SELECT GREATEST(MAX(id), 1) FROM items) + 1000)"
  );
  const lone = await seedItem(db, boardA);
  const noTwin = await db.query("SELECT 1 FROM items WHERE id = $1", [lone.id]);
  assert.equal(noTwin.rows.length, 0, "test premise: no item row shares the entity id");

  const create = await req(base, "POST", "/api/crates", { sid: member.sid, body: { name: "desync", board_id: boardA } });
  assert.equal(create.status, 200);
  const r = await req(base, "POST", `/api/crates/${create.json.crate.id}/items/${lone.id}`, { sid: member.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.added, true);
});

test("crate cannot be created on an inaccessible board", async () => {
  const r = await req(base, "POST", "/api/crates", { sid: outsider.sid, body: { name: "x", board_id: boardA } });
  assert.equal(r.status, 404);
});

test("public crates are visible to other board members", async () => {
  const owner = await seedUser(db, "crate-owner@test.local");
  await db.query("UPDATE users SET name = $1 WHERE id = $2", ["Alice", owner.id]);
  await setBoardMembers(db, boardA, [member.id, owner.id]);

  const create = await req(base, "POST", "/api/crates", {
    sid: owner.sid,
    body: { name: "shared", board_id: boardA },
  });
  assert.equal(create.status, 200);
  const crateId = create.json.crate.id;

  const privateList = await req(base, "GET", `/api/crates?board=${boardA}`, { sid: member.sid });
  assert.equal(privateList.status, 200);
  assert.equal(privateList.json.some((c) => c.id === crateId), false);

  const pub = await req(base, "PATCH", `/api/crates/${crateId}`, {
    sid: owner.sid,
    body: { public: true },
  });
  assert.equal(pub.status, 200);
  assert.equal(pub.json.crate.public, true);

  const publicList = await req(base, "GET", `/api/crates?board=${boardA}`, { sid: member.sid });
  assert.equal(publicList.status, 200);
  const shared = publicList.json.find((c) => c.id === crateId);
  assert.ok(shared);
  assert.equal(shared.owned, false);
  assert.equal(shared.owner_name, "Alice");
  assert.match(shared.name, /shared/);
});

test("only the owner can toggle crate visibility", async () => {
  const owner = await seedUser(db, "crate-owner2@test.local");
  await setBoardMembers(db, boardA, [member.id, owner.id]);
  const create = await req(base, "POST", "/api/crates", {
    sid: owner.sid,
    body: { name: "mine", board_id: boardA },
  });
  const crateId = create.json.crate.id;
  await req(base, "PATCH", `/api/crates/${crateId}`, { sid: owner.sid, body: { public: true } });

  const denied = await req(base, "PATCH", `/api/crates/${crateId}`, {
    sid: member.sid,
    body: { public: false },
  });
  assert.equal(denied.status, 404);
});

test("items expose memberships in other members' public crates", async () => {
  const owner = await seedUser(db, "crate-owner3@test.local");
  await setBoardMembers(db, boardA, [member.id, owner.id]);
  const create = await req(base, "POST", "/api/crates", {
    sid: owner.sid,
    body: { name: "filter-me", board_id: boardA },
  });
  const crateId = create.json.crate.id;
  await req(base, "PATCH", `/api/crates/${crateId}`, { sid: owner.sid, body: { public: true } });
  await req(base, "POST", `/api/crates/${crateId}/items/${itemA.id}`, { sid: owner.sid });

  const items = await req(base, "GET", `/api/items?board=${boardA}`, { sid: member.sid });
  assert.equal(items.status, 200);
  const row = items.json.find((i) => i.id === itemA.id);
  assert.ok(row.crateIds.includes(crateId));
});

test("semantic search respects auth, board access, and the enabled flag", async () => {
  // Feature off: even a member gets 404 (indistinguishable from missing).
  let r = await req(base, "GET", `/api/search?board=${boardA}&q=x`, { sid: member.sid });
  assert.equal(r.status, 404);
  r = await req(base, "GET", `/api/search?board=${boardA}&q=x`);
  assert.equal(r.status, 401);

  // Turn it on with a fake (never-called) eligible key. OpenAI must be added
  // (available-not-installed by default) for the embedder to resolve.
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "embed-test", "openai", "sk-test");
  await setSetting(db, "embed_key_id", String(keyId));
  await setSetting(db, "embed_enabled", "1");
  try {
    // Board access still gates it.
    r = await req(base, "GET", `/api/search?board=${boardA}&q=x`, { sid: outsider.sid });
    assert.equal(r.status, 404);
    // Empty query short-circuits before any embedding call.
    r = await req(base, "GET", `/api/search?board=${boardA}&q=`, { sid: member.sid });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.results, []);
  } finally {
    await setSetting(db, "embed_enabled", null);
    await setSetting(db, "embed_key_id", null);
  }
});

test("enabling semantic search requires an embeddings-capable key", async () => {
  // No embed key configured → refuse to enable.
  let r = await req(base, "POST", "/api/admin/capabilities/embed/bind", { sid: admin.sid, body: { enabled: true } });
  assert.equal(r.status, 400);
  // An anthropic key is not eligible either.
  const anthKey = await createAiKey(db, "anth", "anthropic", "sk-ant-test");
  r = await req(base, "POST", "/api/admin/capabilities/embed/bind", { sid: admin.sid, body: { keyId: anthKey, enabled: true } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /embeddings/);
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

test("invite token is stored hashed but still redeems into a session", async () => {
  const invitee = await seedUser(db, "invitee@test.local");
  const token = await mintInvite(db, invitee.id); // raw, returned once

  // Stored value is the SHA-256, never the raw token.
  const stored = await db.query("SELECT token FROM invites WHERE user_id=$1 AND used_at IS NULL", [invitee.id]);
  assert.equal(stored.rows[0].token, crypto.createHash("sha256").update(token).digest("hex"));
  assert.notEqual(stored.rows[0].token, token);

  // The raw token still logs in: /auth/:token redirects and sets a session.
  const res = await fetch(base + `/auth/${token}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie || "", /sid=/);
  const sid = /sid=([^;]+)/.exec(cookie)[1];
  const me = await req(base, "GET", "/api/me", { sid });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, "invitee@test.local");
});

test("security headers are set on every response", async () => {
  const res = await fetch(base + "/api/health");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  // 'self', not 'none': the lightbox frames /gallery documents same-origin
  assert.match(csp, /frame-ancestors 'self'/);
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
