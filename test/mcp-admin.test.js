// The MCP tab's routes: what the INSTANCE pane reads, what its controls write,
// and the one pin that keeps it honest — the tools it advertises must be the
// tools the protocol actually serves.
//
// Nothing about tokens lives here any more. They belong to people, so they are
// mcp-account.test.js's subject (planning/mcp-members-plan.md §10.12); this
// file is the admin's half, which is the instance and only the instance.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, req, mcp, mcpToken, until } from "./helpers.js";
import {
  getSetting, setSetting, createBoard, setMcpToken, mcpTokenFor, deleteUser,
} from "../server/db.js";

let srv, db, base, admin;

const BASE = "https://boards.example";
const get = (sid = admin.sid) => req(base, "GET", "/api/admin/mcp", { sid });
const patch = (body, sid = admin.sid) => req(base, "PATCH", "/api/admin/mcp", { sid, body });
const tools = (token) =>
  mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, token ? { token } : {});
const revoke = (id, sid = admin.sid) =>
  req(base, "DELETE", `/api/admin/mcp/connections/${id}`, { sid });
const rowFor = async (email) =>
  (await get()).json.connections.find((c) => c.email === email);

before(async () => {
  // server.js reads BASE_URL at import, and each startServer imports fresh —
  // so this pins what the pane will tell the operator to connect to.
  process.env.BASE_URL = BASE;
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});
after(async () => {
  delete process.env.BASE_URL;
  await srv.close();
});

test("the pane is admin-only", async () => {
  const member = await seedUser(db, "nosy@test.local");
  assert.equal((await get(member.sid)).status, 403);
  assert.equal((await patch({ enabled: true }, member.sid)).status, 403);
  assert.equal((await get()).status, 200);
});

test("it starts off, and the pane carries nothing personal", async () => {
  const { json } = await get();
  assert.equal(json.enabled, false);
  // A listening surface nobody asked for is the thing this default prevents.
  assert.equal((await tools()).status, 404);
  // The instance, and only the instance: a token, its stamp and whose it is
  // moved to the account page, and a pane still shipping them would be a second
  // copy of one person's connection (§10.14).
  for (const gone of ["token", "lastUsed", "actingAs"]) {
    assert.equal(json[gone], undefined, `${gone} is not the admin pane's`);
  }
});

test("the endpoint is the address invite links already use", async () => {
  assert.equal((await get()).json.endpoint, `${BASE}/mcp`);
});

test("the pane advertises exactly the tools the protocol serves", async () => {
  // The drift pin. The pane renders what this route hands it, so the route and
  // tools/list must never disagree: a pane that lists a tool nobody can call,
  // or hides one anyone can, is worse than no pane.
  await patch({ enabled: true });
  const names = async () => {
    const pane = await get();
    const wire = await tools(pane.json.token);
    return [pane.json.tools.map((t) => t.name).sort(), wire.json.result.tools.map((t) => t.name).sort()];
  };
  const [paneNames, wireNames] = await names();
  assert.deepEqual(paneNames, wireNames);
  assert.ok(paneNames.length >= 3);
  for (const t of (await get()).json.tools) {
    assert.ok(t.summary && !t.summary.includes("\n"), `${t.name}'s summary is one line`);
  }

  // The saving switch is a NEW way for the two to drift: the pane's table is
  // the switch's readout, so it has to be filtered by exactly the same flag
  // tools/list is. Pinned in BOTH positions — one of them agreeing proves
  // only that one of them was filtered.
  assert.equal((await get()).json.write, true, "on with nothing stored");
  await patch({ write: false });
  const [paneOff, wireOff] = await names();
  assert.deepEqual(paneOff, wireOff);
  assert.ok(!paneOff.includes("save_to_crate"));
  assert.equal(paneOff.length, paneNames.length - 1);
  assert.equal(await getSetting(db, "mcp_write"), "0");

  await patch({ write: true });
  const [paneOn, wireOn] = await names();
  assert.deepEqual(paneOn, wireOn);
  assert.deepEqual(paneOn, paneNames);
  // Cleared, not "1": absence is what ON means here, so a row left behind
  // would be a stored choice nobody made.
  assert.equal(await getSetting(db, "mcp_write"), null);
});

test("origins round-trip and reach the gate", async () => {
  assert.equal((await patch({ origins: "https://a.example,https://b.example" })).json.origins,
    "https://a.example,https://b.example");
  const ok = await mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://b.example" });
  assert.equal(ok.status, 200);
  const no = await mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://c.example" });
  assert.equal(no.status, 403);
  assert.equal((await patch({ origins: "" })).json.origins, "");
});

// --- stage 2: scope and the activity signal ---------------------------------

test("the pane carries every board with its scope state", async () => {
  const a = await createBoard(db, "Alpha", [], "");
  const b = await createBoard(db, "Beta", [], "");
  const { json } = await get();
  const names = json.allBoards.map((x) => x.name);
  assert.ok(names.includes("Alpha") && names.includes("Beta"));
  // Empty scope reads as every box ticked, because that is what empty MEANS.
  assert.ok(json.allBoards.every((x) => x.on));

  assert.deepEqual((await patch({ boards: [a] })).json.boards, [a]);
  const scoped = (await get()).json.allBoards;
  assert.equal(scoped.find((x) => x.id === a).on, true);
  assert.equal(scoped.find((x) => x.id === b).on, false);

  // Ticking ALL of them is the same statement as ticking none: store nothing,
  // so a board added tomorrow is in scope rather than silently excluded by a
  // list written before it existed.
  const all = (await get()).json.allBoards.map((x) => x.id);
  assert.deepEqual((await patch({ boards: all })).json.boards, []);
  const later = await createBoard(db, "Gamma", [], "");
  assert.equal((await get()).json.allBoards.find((x) => x.id === later).on, true);

  // An id that is not a board is dropped rather than stored.
  assert.deepEqual((await patch({ boards: [a, "no-such-board"] })).json.boards, [a]);
  await patch({ boards: [] });
});

test("a scope naming only deleted boards reads as no scope", async () => {
  // Nothing cascades into settings when a board is deleted — deleteBoard even
  // purges usage_meter by hand for the same reason — so a scope list goes stale
  // on its own. Left alone, the agent would see nothing while the tab showed
  // every box unticked, which the tab itself says means ALL of them.
  const doomed = await createBoard(db, "Doomed", [], "");
  await patch({ boards: [doomed] });
  assert.deepEqual((await get()).json.boards, [doomed]);

  await db.query("DELETE FROM boards WHERE id=$1", [doomed]);
  const after = await get();
  assert.ok(after.json.allBoards.every((b) => b.on), "every box reads as ticked again");
  await patch({ boards: [] });
});

// --- stage 3: oversight (planning/mcp-members-plan.md §10.18-10.19) ----------
//
// Every token below belongs to a BURNER member. The admin's own row is in this
// list too and every other call in this file rides on that token by default
// (helpers.js), so a test that revoked it would close the door behind itself —
// §10.8 recorded three tests that learned this the confusing way.

test("the connections list says who is connected, and never what with", async () => {
  await patch({ enabled: true });
  const bob = await seedUser(db, "bob-conn@test.local");
  await setMcpToken(db, bob.id, "conn-list-token-bbbbbbbbbbbb");

  const row = await rowFor("bob-conn@test.local");
  assert.ok(row, "one row per token");
  assert.equal(row.isAdmin, false);
  assert.ok(row.created > Date.now() - 60_000, "created just now");
  assert.equal(row.lastUsed, null, "and never used");

  // The admin's own connection is in the list. Leaving it out would be the pane
  // pretending the admin is not a member, which is the thing this arc undid.
  const { json } = await get();
  assert.ok(json.connections.some((c) => c.isAdmin), "including the admin's own");

  // §3's promise, asserted against the WIRE rather than trusted to a SELECT
  // list: an admin reads who, never what. Both tokens, because the harness's is
  // the one certain to be in the table.
  assert.doesNotMatch(JSON.stringify(json), /conn-list-token/, "not the member's");
  assert.doesNotMatch(JSON.stringify(json), new RegExp(await mcpToken(base)), "not the admin's");

  // And the stamp advances once that member's client calls — the signal the old
  // instance-wide mcp_last_used could only ever give for everyone at once.
  await tools("conn-list-token-bbbbbbbbbbbb");
  const stamp = await until(async () => (await rowFor("bob-conn@test.local")).lastUsed);
  assert.ok(stamp > Date.now() - 10_000);
});

test("revoking one connection stops it on the next call, and no other", async () => {
  await patch({ enabled: true });
  const gone = await seedUser(db, "revoke-me@test.local");
  const kept = await seedUser(db, "keep-me@test.local");
  await setMcpToken(db, gone.id, "revoke-token-111111111111");
  await setMcpToken(db, kept.id, "revoke-token-222222222222");
  assert.equal((await tools("revoke-token-111111111111")).status, 200);

  const res = await revoke((await rowFor("revoke-me@test.local")).id);
  assert.equal(res.status, 200);
  // The write answers the WHOLE pane, because the table redraws from whatever a
  // write returns exactly as every switch on this tab does.
  assert.ok(Array.isArray(res.json.allBoards) && Array.isArray(res.json.tools));
  assert.ok(!res.json.connections.some((c) => c.email === "revoke-me@test.local"));

  // The stage's done-when. Nothing caches a token, so the NEXT call is the one
  // that answers 401.
  assert.equal((await tools("revoke-token-111111111111")).status, 401);
  assert.equal((await tools("revoke-token-222222222222")).status, 200, "nobody else was touched");
  assert.equal(await mcpTokenFor(db, gone.id), null);
});

test("revoking is the admin's alone, and a bad id is not a 500", async () => {
  const member = await seedUser(db, "not-admin@test.local");
  const bystander = await seedUser(db, "collateral@test.local");
  await setMcpToken(db, bystander.id, "collateral-token-cccccccccc");
  const { id } = await rowFor("collateral@test.local");

  assert.equal((await revoke(id, member.sid)).status, 403);
  assert.ok(await mcpTokenFor(db, bystander.id), "and it is still there");

  // Two admins with this tab open is the normal case: the second one asked for
  // a state that already holds, and a 404 would be the pane arguing with a
  // reader who is right.
  assert.equal((await revoke(id)).status, 200);
  const again = await revoke(id);
  assert.equal(again.status, 200);
  assert.ok(!again.json.connections.some((c) => c.email === "collateral@test.local"));

  // Number("nope") is NaN, which Postgres rejects for a bigint — so without the
  // guard a junk URL is a 500 in the log rather than an answer.
  assert.equal((await revoke("nope")).status, 404);
});

test("removing a member takes their connection with them", async () => {
  const doomed = await seedUser(db, "doomed-conn@test.local");
  await setMcpToken(db, doomed.id, "doomed-token-dddddddddddd");
  assert.ok(await rowFor("doomed-conn@test.local"));

  // The FK cascade, not a display filter: a list showing a row for an account
  // that no longer exists is an admin chasing a connection nobody holds.
  await deleteUser(db, doomed.id);
  assert.equal(await rowFor("doomed-conn@test.local"), undefined);
  assert.equal((await tools("doomed-token-dddddddddddd")).status, 401);
});
