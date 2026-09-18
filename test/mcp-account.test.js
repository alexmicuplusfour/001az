// The account page's routes (planning/mcp-members-plan.md §10.12): one person's
// connection, held by that person.
//
// These were `/api/admin/mcp` in stage 1 — a personal act routed through the
// admin door, because the admin tab was then the only surface a token could
// exist on. What this file pins is that a MEMBER, who can reach nothing of the
// admin's, can do the whole thing for themselves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  startServer, adminSession, seedUser, req, mcp, callTool, toolText, until,
} from "./helpers.js";
import { setSetting, createBoard, setBoardMembers, setMcpToken, mcpTokenFor } from "../server/db.js";

let srv, db, base, admin, member, memberBoard, adminBoard;

const BASE = "https://boards.example";
const state = (sid) => req(base, "GET", "/api/account/mcp", { sid });
const mint = (sid) => req(base, "POST", "/api/account/mcp/token", { sid, body: {} });
const clear = (sid) => req(base, "DELETE", "/api/account/mcp/token", { sid });
const tools = (token) =>
  mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token });

before(async () => {
  process.env.BASE_URL = BASE;
  srv = await startServer();
  ({ db, base } = srv);
  await setSetting(db, "mcp_enabled", "1");
  admin = await adminSession(db);
  member = await seedUser(db, "member@test.local");
  memberBoard = await createBoard(db, "Member board", [], "");
  adminBoard = await createBoard(db, "Admin-only board", [], "");
  await setBoardMembers(db, memberBoard, [member.id]);
  await setBoardMembers(db, adminBoard, []);
});
after(async () => {
  delete process.env.BASE_URL;
  await srv.close();
});

test("a member reaches their own connection, and nothing of the admin's", async () => {
  assert.equal((await state(member.sid)).status, 200);
  assert.equal((await mint(member.sid)).status, 200);
  // The admin door stays shut to them, which is the whole reason these routes
  // exist rather than the member being handed requireAdmin.
  assert.equal((await req(base, "GET", "/api/admin/mcp", { sid: member.sid })).status, 403);
  // And signed out is signed out.
  assert.equal((await state(null)).status, 401);
  assert.equal((await mint(null)).status, 401);
});

test("mint, rotate, clear — and the old token stops at each step", async () => {
  const first = (await mint(member.sid)).json.token;
  assert.ok(first?.length >= 24, "there is a token to put in the command");
  assert.equal((await tools(first)).status, 200);

  // Rotate IS mint: the same route, replacing the row.
  const second = (await mint(member.sid)).json.token;
  assert.notEqual(second, first);
  assert.equal((await tools(first)).status, 401, "the old one is gone");
  assert.equal((await tools(second)).status, 200);

  const cleared = await clear(member.sid);
  assert.equal(cleared.json.token, null);
  assert.equal((await tools(second)).status, 401);
  assert.equal(await mcpTokenFor(db, member.id), null);
});

test("the payload names only the boards that member's agent can reach", async () => {
  const token = (await mint(member.sid)).json.token;
  const { json } = await state(member.sid);
  assert.deepEqual(json.boards.map((b) => b.name), ["Member board"]);
  assert.equal(json.actingAs, "member@test.local");
  assert.equal(json.endpoint, `${BASE}/mcp`);
  assert.ok(json.tools.length >= 3, "the tool list rides along");

  // The page and the protocol answer the same question the same way — the
  // point of rendering `visibleBoards` rather than a query written for a page.
  const listed = toolText((await callTool(base, "list_boards", {}, { token })).result);
  assert.match(listed, /Member board/);
  assert.doesNotMatch(listed, /Admin-only board/);
});

test("the board ceiling narrows a member's list too", async () => {
  await setSetting(db, "mcp_boards", adminBoard);
  const { json } = await state(member.sid);
  assert.deepEqual(json.boards, [], "membership intersected with the ceiling is nothing");
  await setSetting(db, "mcp_boards", null);
  assert.deepEqual((await state(member.sid)).json.boards.map((b) => b.name), ["Member board"]);
});

test("switching MCP on mints nothing", async () => {
  // The stage 1 behaviour, inverted on purpose (§10.14). Enabling is an
  // instance act; minting is a personal one, and it has a page of its own now.
  await clear(admin.sid);
  await setSetting(db, "mcp_enabled", null);
  await req(base, "PATCH", "/api/admin/mcp", { sid: admin.sid, body: { enabled: true } });
  assert.equal(await mcpTokenFor(db, admin.id), null, "no token nobody asked for");
  // …and the admin mints theirs exactly where everyone else does.
  assert.ok((await mint(admin.sid)).json.token);
});

test("the pane says so when the instance has it switched off", async () => {
  await setSetting(db, "mcp_enabled", null);
  const { json } = await state(member.sid);
  assert.equal(json.enabled, false);
  // Still their own state, so the page can say what is off rather than 404ing
  // at somebody who did nothing wrong.
  assert.equal(json.actingAs, "member@test.local");
  await setSetting(db, "mcp_enabled", "1");
});

test("last used starts empty and advances once that member's client calls", async () => {
  await setMcpToken(db, member.id, "acct-stamp-token-aaaaaaaaaaaa");
  assert.equal((await state(member.sid)).json.lastUsed, null);
  await tools("acct-stamp-token-aaaaaaaaaaaa");
  // Written fire-and-forget inside the gate, so the answer can land before the
  // write does and a test that reads straight after is racing its own subject.
  const stamp = await until(async () => (await state(member.sid)).json.lastUsed);
  assert.ok(stamp > Date.now() - 10_000, "the stamp is from just now");
});

test("one member's acts do not touch another's token", async () => {
  const other = await seedUser(db, "other@test.local");
  const mine = (await mint(member.sid)).json.token;
  const theirs = (await mint(other.sid)).json.token;
  assert.notEqual(mine, theirs);
  await clear(other.sid);
  assert.equal((await tools(mine)).status, 200, "clearing theirs left mine alone");
});
