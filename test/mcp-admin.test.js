// The Agents tab's routes: what the pane reads, what its controls write, and
// the one pin that keeps the pane honest — the tools it advertises must be the
// tools the protocol actually serves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, req, mcp, until } from "./helpers.js";
import { getSetting, setSetting, createBoard } from "../server/db.js";

let srv, db, base, admin;

const BASE = "https://boards.example";
const get = (sid = admin.sid) => req(base, "GET", "/api/admin/mcp", { sid });
const patch = (body, sid = admin.sid) => req(base, "PATCH", "/api/admin/mcp", { sid, body });
const rotate = (sid = admin.sid) => req(base, "POST", "/api/admin/mcp/rotate", { sid, body: {} });
const tools = (token) =>
  mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, token ? { token } : {});

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
  assert.equal((await rotate(member.sid)).status, 403);
  assert.equal((await get()).status, 200);
});

test("it starts off, with nothing minted", async () => {
  const { json } = await get();
  assert.equal(json.enabled, false);
  assert.equal(json.token, null);
  // A listening surface nobody asked for is the thing this default prevents.
  assert.equal((await tools()).status, 404);
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

test("switching it on mints a token", async () => {
  await setSetting(db, "mcp_enabled", null);
  await setSetting(db, "mcp_token", null);
  const { json } = await patch({ enabled: true });
  assert.equal(json.enabled, true);
  assert.ok(json.token?.length >= 24, "there is a token to put in the command");
  // Which means the copy button always has something that works.
  assert.equal((await tools(json.token)).status, 200);
});

test("switching it back on does not re-mint", async () => {
  const before = (await get()).json.token;
  await patch({ enabled: false });
  await patch({ enabled: true });
  assert.equal((await get()).json.token, before, "an existing client keeps working");
});

test("rotate replaces the token and the old one stops", async () => {
  const old = (await get()).json.token;
  const { json } = await rotate();
  assert.notEqual(json.token, old);
  assert.equal((await tools(old)).status, 401);
  assert.equal((await tools(json.token)).status, 200);
});

test("clearing the token is the local-only mode", async () => {
  const { json } = await patch({ token: null });
  assert.equal(json.token, null);
  assert.equal(await getSetting(db, "mcp_token"), null);
  // The test client IS loopback, so it still works...
  assert.equal((await tools()).status, 200);
  // ...and anyone else does not.
  assert.equal(
    (await mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { xff: "203.0.113.9" })).status,
    401
  );
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

test("last used starts empty and advances once something calls", async () => {
  await setSetting(db, "mcp_last_used", null);
  assert.equal((await get()).json.lastUsed, null);
  await patch({ enabled: true });
  await tools((await get()).json.token);
  // The stamp is written fire-and-forget inside the gate — deliberately, since
  // awaiting it would put a second round trip on every MCP call for a number
  // nobody reads to the second. So the ANSWER can land before the write does,
  // and a test that reads straight after is racing its own subject.
  const stamp = await until(async () => (await get()).json.lastUsed);
  assert.ok(stamp > Date.now() - 10_000, "the stamp is from just now");
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
