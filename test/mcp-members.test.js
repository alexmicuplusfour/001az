// MCP per member (planning/mcp-members-plan.md, stage 1): the token names a
// person, and everything downstream of that was already theirs.
//
// The load-bearing test here is the first one. The tools have always taken a
// user and always enforced that user's board access — §0 of the plan proves it
// — so what this file pins is not the authorisation rule but the wiring that
// finally hands it somebody other than the admin. If these pass against a
// server that resolves its caller from ADMIN_EMAIL, the wiring did not happen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startServer, seedUser, seedInstance, mcp, callTool, toolText, ADMIN_EMAIL } from "./helpers.js";
import {
  createBoard, setBoardMembers, setSetting,
  getUserByEmail, setMcpToken, mcpTokenFor, listCrates, createCrate,
} from "../server/db.js";

let srv, db, base, alice, bob, admin, aliceBoard, bobBoard, aliceCard, bobCard;
const A = "alice-token-aaaaaaaaaaaaaaaaaaaa";
const B = "bob-token-bbbbbbbbbbbbbbbbbbbbbb";

const seedCard = async (board) => Number((await seedInstance(db, board, "tagged")).eid);
const as = (token) => (name, args) => callTool(base, name, args, { token });
const ping = (token) => mcp(base, { jsonrpc: "2.0", id: 1, method: "ping" }, { token });
const alicely = as(A);
const bobly = as(B);

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  await setSetting(db, "mcp_enabled", "1");
  admin = await getUserByEmail(db, ADMIN_EMAIL);

  // seedUser already hands back the id — it is the only field this file reads.
  alice = await seedUser(db, "alice@test.local");
  bob = await seedUser(db, "bob@test.local");
  await setMcpToken(db, alice.id, A);
  await setMcpToken(db, bob.id, B);

  aliceBoard = await createBoard(db, "Alice board", [], "");
  bobBoard = await createBoard(db, "Bob board", [], "");
  await setBoardMembers(db, aliceBoard, [alice.id]);
  await setBoardMembers(db, bobBoard, [bob.id]);
  aliceCard = await seedCard(aliceBoard);
  bobCard = await seedCard(bobBoard);
});
after(() => srv.close());

test("two tokens, two people, and each sees only their own boards", async () => {
  const hers = toolText((await alicely("list_boards", {})).result);
  const his = toolText((await bobly("list_boards", {})).result);
  assert.match(hers, /Alice board/);
  assert.doesNotMatch(hers, /Bob board/);
  assert.match(his, /Bob board/);
  assert.doesNotMatch(his, /Alice board/);

  // The admin's token still reaches everything — is_admin, not a special case
  // in the MCP.
  const theirs = toolText((await callTool(base, "list_boards", {})).result);
  assert.match(theirs, /Alice board/);
  assert.match(theirs, /Bob board/);
});

test("a board withheld is unreachable BY ID, through every tool", async () => {
  // Knowing the id is not access. The refusal has to come from the same place
  // the listing does, or a caller could walk straight past the list.
  for (const [name, args] of [
    ["describe_board", { board: bobBoard }],
    ["search_board", { board: bobBoard, include_images: false }],
    ["get_items", { board: bobBoard, ids: [bobCard] }],
    ["save_to_crate", { board: bobBoard, crate: "Sneak", ids: [bobCard] }],
  ]) {
    const { result } = await alicely(name, args);
    assert.equal(result.isError, true, `${name} refused`);
    assert.match(toolText(result), /No board .* is available to you/, name);
  }
  // …and her own board does not resolve his card either, which is the
  // board-is-the-authority rule rather than the membership one.
  const { result } = await alicely("get_items", { board: aliceBoard, ids: [bobCard] });
  assert.equal(result.isError, true);
  assert.match(toolText(result), /No item on "Alice board"/);
});

test("a membership change lands on the next call, with no reconnect", async () => {
  assert.doesNotMatch(toolText((await bobly("list_boards", {})).result), /Alice board/);
  await setBoardMembers(db, aliceBoard, [alice.id, bob.id]);
  // Same token, same connection, next call.
  assert.match(toolText((await bobly("list_boards", {})).result), /Alice board/);
  await setBoardMembers(db, aliceBoard, [alice.id]);
  assert.doesNotMatch(toolText((await bobly("list_boards", {})).result), /Alice board/);
});

test("save_to_crate writes to the CALLER's crates", async () => {
  const saved = await alicely("save_to_crate", {
    board: aliceBoard, crate: "Shortlist", ids: [aliceCard],
  });
  assert.equal(saved.result.isError, undefined);

  const hers = await listCrates(db, alice.id, aliceBoard);
  assert.deepEqual(hers.map((c) => [c.name, c.owned]), [["Shortlist", true]]);
  // Not the admin's, which is where every crate an agent made used to land.
  assert.deepEqual(await listCrates(db, admin.id, aliceBoard), []);
});

test("one member's rate window is their own", async () => {
  // Under Docker every member arrives from the same bridge address, so a
  // per-IP window alone would let one busy agent refuse everybody else.
  //
  // A BURNER member, not Alice: a spent window lasts the full minute, so
  // closing hers would leave every test below this one talking to a 429 —
  // which is exactly how this file failed the first time it was run.
  const greedy = await seedUser(db, "greedy@test.local");
  const G = "greedy-token-gggggggggggggggggg";
  await setMcpToken(db, greedy.id, G);

  let refused = 0;
  for (let i = 0; i < 62; i++) if ((await ping(G)).status === 429) refused++;
  assert.ok(refused > 0, "the greedy member's own window closed");
  // Both of the others are untouched, though all three share one IP.
  assert.equal((await ping(A)).status, 200);
  assert.equal((await ping(B)).status, 200);
});

test("a cleared token stops working, and clears nobody else's", async () => {
  await setMcpToken(db, bob.id, null);
  assert.equal((await ping(B)).status, 401);
  assert.equal((await ping(A)).status, 200);
  await setMcpToken(db, bob.id, B);
});

test("ADMIN_EMAIL naming nobody changes nothing", async () => {
  // The bug this arc dissolves: /mcp used to resolve its caller from that
  // variable, which is empty on any instance whose admin came from first-run
  // setup — so every tool answered "this instance has no admin account
  // configured" while the tab showed a working command. Nothing reads it now.
  await db.query("UPDATE users SET email='moved@test.local' WHERE id=$1", [admin.id]);
  try {
    const { result } = await alicely("list_boards", {});
    assert.equal(result.isError, undefined);
    assert.match(toolText(result), /Alice board/);
    assert.doesNotMatch(toolText(result), /no admin account/);
  } finally {
    await db.query("UPDATE users SET email=$2 WHERE id=$1", [admin.id, process.env.ADMIN_EMAIL]);
  }
});

test("migration 0051 carries the instance's token to the earliest admin", async () => {
  // Replayed against a hand-built pre-arc state: the instance token in
  // settings, and nobody holding one. Without this, every client connected on
  // the day this deploys breaks.
  const sql = fs.readFileSync(new URL("../server/migrations/0051_mcp_tokens.sql", import.meta.url), "utf8");
  await setMcpToken(db, admin.id, null);
  await setSetting(db, "mcp_token", "the-old-instance-token");
  await setSetting(db, "mcp_last_used", "1700000000000");

  await db.query(sql);

  const carried = await mcpTokenFor(db, admin.id);
  assert.equal(carried.token, "the-old-instance-token");
  assert.equal(Number(carried.last_used_at), 1700000000000, "the stamp comes with it");
  // The settings rows are gone, including the one nothing carried.
  const { rows } = await db.query("SELECT key FROM settings WHERE key IN ('mcp_token','mcp_last_used')");
  assert.deepEqual(rows, []);
  // And the carried token is live, as the admin.
  // No token passed: the harness reads the admin's through to the database, so
  // the carried one IS the default from here on.
  const { result } = await callTool(base, "list_boards", {});
  assert.match(toolText(result), /Bob board/);
});

test("a public crate of someone else's is visible but not writable through a name", async () => {
  // Review §5 gets likelier with several members: search resolves a name
  // against crates you can SEE (yours plus public ones), while save only ever
  // writes your own. Pinned as the behaviour it is today so the fix is a
  // deliberate change rather than a surprise.
  const his = await createCrate(db, bob.id, aliceBoard, "Shared");
  await db.query("UPDATE crates SET public = TRUE WHERE id=$1", [his.id]);
  await setBoardMembers(db, aliceBoard, [alice.id, bob.id]);

  const saved = await alicely("save_to_crate", { board: aliceBoard, crate: "Shared", ids: [aliceCard] });
  assert.equal(saved.result.isError, undefined);
  const named = (await listCrates(db, alice.id, aliceBoard)).filter((c) => c.name === "Shared");
  assert.equal(named.length, 2, "hers was created beside his rather than written into");
  assert.deepEqual(named.map((c) => c.owned).sort(), [false, true]);

  await setBoardMembers(db, aliceBoard, [alice.id]);
});
