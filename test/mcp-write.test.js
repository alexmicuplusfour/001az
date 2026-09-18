// save_to_crate — the one tool that writes (planning/mcp-stage-3.md §2).
//
// The load-bearing test here is "called twice, adds nothing". The crate's
// existing primitive is toggleCrateItem, which exists for a checkbox and
// REMOVES what it added on a second call; MCP clients retry, so building the
// tool on it would have let a retry silently un-save the work and answer
// "done" both times. Nothing in the protocol prevents that and nothing in the
// app would have recorded it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, mcp, callTool, toolText } from "./helpers.js";
import {
  createBoard, createEntity, insertItem, setSetting,
  listCrates, crateItemIds, toggleCrateItem, createCrate, getUserByEmail,
} from "../server/db.js";

let srv, db, base, boardId, otherBoardId, admin, cards, otherCard;

async function seedCard(board, identity) {
  const eid = await createEntity(db, board, { identity });
  await insertItem(db, board, { identity, files: [], fields: {} }, "tagged", eid);
  return eid;
}

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  await setSetting(db, "mcp_enabled", "1");
  // The MCP acts as ADMIN_EMAIL's account, so the crates it makes are that
  // person's. adminSession creates exactly that account.
  await adminSession(db);
  admin = await getUserByEmail(db, process.env.ADMIN_EMAIL);
  assert.ok(admin, "the acting user exists");
  boardId = await createBoard(db, "Save board", [], "");
  otherBoardId = await createBoard(db, "Other board", [], "");
  cards = [];
  for (let i = 0; i < 4; i++) cards.push(await seedCard(boardId, `card-${i}`));
  otherCard = await seedCard(otherBoardId, "elsewhere");
});
after(() => srv.close());

const save = (args) => callTool(base, "save_to_crate", { board: boardId, ...args });
const cratesNow = () => listCrates(db, admin.id, boardId);
const crateNamed = async (name) => (await cratesNow()).find((c) => c.name === name);

test("creates the crate when it does not exist, owned by the acting user", async () => {
  const { result } = await save({ crate: "Dark dashboards", ids: cards.slice(0, 2) });
  assert.equal(result.isError, undefined);
  const body = toolText(result);
  assert.match(body, /Saved 2 cards to "Dark dashboards" on "Save board"/);
  assert.match(body, /The crate now holds 2\./);
  // Only this server knows the crates control is not on screen until a board
  // has one, so a freshly created crate says where to look.
  assert.match(body, /crates button in the gallery toolbar/);
  assert.match(body, /first time on screen/);

  const crate = await crateNamed("Dark dashboards");
  assert.ok(crate, "it shows up in the person's own crate list");
  assert.equal(crate.owned, true);
  assert.equal(Number(crate.item_count), 2);
  assert.deepEqual([...(await crateItemIds(db, crate.id))].sort(), cards.slice(0, 2).sort());
});

test("adds to the existing crate rather than making a second one", async () => {
  const before = (await cratesNow()).length;
  const { result } = await save({ crate: "Dark dashboards", ids: [cards[2]] });
  assert.match(toolText(result), /Saved 1 card to "Dark dashboards"/);
  assert.match(toolText(result), /The crate now holds 3\./);
  assert.equal((await cratesNow()).length, before, "no second crate of the same name");
  // Not a new crate, so the where-to-find-it line drops the first-time caveat.
  assert.doesNotMatch(toolText(result), /first time on screen/);
});

test("called twice with the same ids, adds nothing and says so", async () => {
  // THE anti-toggle pin. Against toggleCrateItem this call would EMPTY the
  // crate and report success.
  const crate = await crateNamed("Dark dashboards");
  const beforeIds = await crateItemIds(db, crate.id);
  const { result } = await save({ crate: "Dark dashboards", ids: cards.slice(0, 3) });
  assert.equal(result.isError, undefined);
  assert.match(toolText(result), /Saved 0 cards/);
  assert.match(toolText(result), /3 were already in it/);
  assert.match(toolText(result), /The crate now holds 3\./);
  // Caught on the live instance: deriving "this crate is new" from "it holds
  // exactly what I just sent" is satisfied by an exact retry too, and told the
  // person a control they had already used was about to appear for the first
  // time. The condition is whether the BOARD had any crates.
  assert.doesNotMatch(toolText(result), /first time on screen/);
  assert.deepEqual(
    [...(await crateItemIds(db, crate.id))].sort(),
    [...beforeIds].sort(),
    "the retry changed nothing at all"
  );
});

test("the toggle still toggles, through the same insert", async () => {
  // toggleCrateItem's add branch is now addCrateItems with one id. The gallery
  // checkbox must be untouched by that: a checkbox toggling is the only thing
  // that still separates the two.
  const crate = await crateNamed("Dark dashboards");
  const off = await toggleCrateItem(db, admin.id, crate.id, cards[0]);
  assert.deepEqual([off.added, Number(off.count)], [false, 2]);
  const on = await toggleCrateItem(db, admin.id, crate.id, cards[0]);
  assert.deepEqual([on.added, Number(on.count)], [true, 3]);
  // And an id from another board is still refused outright.
  assert.equal(await toggleCrateItem(db, admin.id, crate.id, otherCard), null);
});

test("ids from another board are skipped and named", async () => {
  const { result } = await save({ crate: "Mixed bag", ids: [cards[3], otherCard, 99_000_001] });
  assert.equal(result.isError, undefined);
  assert.match(toolText(result), /Saved 1 card to "Mixed bag"/);
  assert.match(toolText(result), /2 ids are not cards on this board and were skipped/);
  assert.match(toolText(result), new RegExp(`${otherCard}`));
  assert.match(toolText(result), /99000001/);
  assert.equal(Number((await crateNamed("Mixed bag")).item_count), 1);
});

test("no id resolves: an error, and nothing left behind", async () => {
  const before = (await cratesNow()).length;
  const { result } = await save({ crate: "Never made", ids: [otherCard] });
  assert.equal(result.isError, true);
  assert.match(toolText(result), /Ids are board-specific/);
  // The crate is checked BEFORE it is opened, so a call with nothing savable
  // in it does not litter the gallery with an empty set nobody asked for.
  assert.equal((await cratesNow()).length, before);
  assert.equal(await crateNamed("Never made"), undefined);
});

test("a board outside the scope refuses the write, not only the reads", async () => {
  await setSetting(db, "mcp_boards", otherBoardId);
  try {
    const { result } = await callTool(base, "save_to_crate", {
      board: boardId, crate: "Sneaky", ids: cards.slice(0, 1),
    });
    assert.equal(result.isError, true);
    assert.match(toolText(result), /No board .* is available to you/);
    assert.equal(await crateNamed("Sneaky"), undefined);
  } finally {
    await setSetting(db, "mcp_boards", null);
  }
});

test("a name too long is trimmed, and the answer reports the trimmed name", async () => {
  // createCrate slices to 64 itself. A silently truncated name is one the
  // caller will fail to find again, so the answer must say what it used.
  const long = "L".repeat(80);
  const { result } = await save({ crate: long, ids: [cards[0]] });
  const used = "L".repeat(64);
  assert.match(toolText(result), new RegExp(`Saved 1 card to "${used}"`));
  assert.ok(await crateNamed(used));
  // An empty name is a refusal, not a crate called "".
  const blank = await save({ crate: "   ", ids: [cards[0]] });
  assert.equal(blank.result.isError, true);
  assert.match(toolText(blank.result), /Give the crate a name/);
});

// --- the saving switch -------------------------------------------------------

const listNames = async () =>
  (await mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json.result.tools.map((t) => t.name);

test("writes off: the tool leaves the vocabulary, and the reads stay", async () => {
  assert.ok((await listNames()).includes("save_to_crate"), "on by default — absence is not a choice");
  await setSetting(db, "mcp_write", "0");
  try {
    const names = await listNames();
    assert.ok(!names.includes("save_to_crate"), "offering what we would refuse would be a lie");
    assert.deepEqual(names.sort(), ["describe_board", "get_items", "list_boards", "search_board"]);
  } finally {
    await setSetting(db, "mcp_write", null);
  }
  assert.ok((await listNames()).includes("save_to_crate"), "and it comes back");
});

test("writes off: a stale client's call is a readable refusal, not METHOD_NOT_FOUND", async () => {
  await setSetting(db, "mcp_write", "0");
  try {
    const r = await save({ crate: "Denied", ids: [cards[0]] });
    // A protocol error would tell the model only that the transport failed.
    // This one it can read out to the person who can fix it.
    assert.equal(r.error, undefined, "not a JSON-RPC error");
    assert.equal(r.result.isError, true);
    assert.match(toolText(r.result), /switched off .* MCP in the admin settings/);
    assert.equal(await crateNamed("Denied"), undefined);
  } finally {
    await setSetting(db, "mcp_write", null);
  }
});

// --- reading a crate back ----------------------------------------------------

test("describe_board names the board's crates, and only when there are some", async () => {
  const { result } = await callTool(base, "describe_board", { board: boardId });
  const body = toolText(result);
  assert.match(body, /## saved sets \(crates\)/);
  assert.match(body, /Dark dashboards \(3 cards\)/);
  assert.match(body, /Mixed bag \(1 cards?\)/);

  // A board with none says nothing rather than heading an empty list.
  const empty = await callTool(base, "describe_board", { board: otherBoardId });
  assert.doesNotMatch(toolText(empty.result), /saved sets/);
});

test("with saving off, no prose points at a tool the caller was never offered", async () => {
  // Hiding save_to_crate from tools/list and then telling the caller to use it
  // is the same lie, moved somewhere the list does not reach. Three sentences
  // name that tool; all three have to know about the switch.
  // create-if-absent, so this is safe whether or not a later test made it too
  await createCrate(db, admin.id, boardId, "Nothing here");
  await setSetting(db, "mcp_write", "0");
  try {
    const desc = await callTool(base, "describe_board", { board: boardId });
    assert.match(toolText(desc.result), /search inside one\./, "the read half still reads");
    assert.doesNotMatch(toolText(desc.result), /save_to_crate/);

    const none = await callTool(base, "search_board", { board: otherBoardId, crate: "Nope" });
    assert.match(toolText(none.result), /no crates yet\./);
    assert.doesNotMatch(toolText(none.result), /save_to_crate/);

    const emptyCrate = await callTool(base, "search_board", {
      board: boardId, crate: "Nothing here", include_images: false,
    });
    assert.match(toolText(emptyCrate.result), /is empty\./);
    assert.doesNotMatch(toolText(emptyCrate.result), /save_to_crate/);
  } finally {
    await setSetting(db, "mcp_write", null);
  }
  // …and with it back on, all three offer it again.
  const back = await callTool(base, "describe_board", { board: boardId });
  assert.match(toolText(back.result), /or to save_to_crate to add to it/);
});

test("search_board scopes to a crate, by name, case-insensitively", async () => {
  const inCrate = await callTool(base, "search_board", {
    board: boardId, crate: "Dark dashboards", include_images: false,
  });
  const body = toolText(inCrate.result);
  assert.match(body, /in crate "Dark dashboards" · matched 3/);
  const ids = body.split("\n").map((l) => /· id (\d+)/.exec(l)?.[1]).filter(Boolean).map(Number);
  assert.deepEqual(ids.sort(), cards.slice(0, 3).sort(), "exactly the members");

  // Same request, different shift key.
  const lower = await callTool(base, "search_board", {
    board: boardId, crate: "dark DASHBOARDS", include_images: false,
  });
  assert.match(toolText(lower.result), /matched 3/);
});

test("searching a crate that matches nothing names the CRATE, not the board", async () => {
  // The review pass found this: the empty-result line named the board at a
  // caller who had asked about a crate, because the edit that was supposed to
  // teach it about crates silently did not apply and three green runs said
  // nothing. There was no test for an empty crate.
  await createCrate(db, admin.id, boardId, "Nothing here");
  const empty = await callTool(base, "search_board", {
    board: boardId, crate: "Nothing here", include_images: false,
  });
  // An empty crate is the ONLY way a crate search with no other filter comes
  // back empty — crate_items cascades from entities, so it cannot hold a
  // deleted card — so the answer says that rather than "nothing matched".
  assert.match(toolText(empty.result), /The crate "Nothing here" on "Save board" is empty/);
  assert.doesNotMatch(toolText(empty.result), /No cards on/);

  // A non-empty crate whose members fail the facets is a different sentence.
  const filtered = await callTool(base, "search_board", {
    board: boardId, crate: "Dark dashboards", facets: { theme: { any: ["no-such-value"] } }, include_images: false,
  });
  assert.match(toolText(filtered.result), /No cards in "Dark dashboards" matched/);
  assert.match(toolText(filtered.result), /describe_board to check the vocabulary/);
});

test("an unknown crate name is an error naming the ones that exist", async () => {
  const { result } = await callTool(base, "search_board", { board: boardId, crate: "Nope" });
  assert.equal(result.isError, true);
  assert.match(toolText(result), /No crate called "Nope" on "Save board"/);
  assert.match(toolText(result), /Dark dashboards \(3\)/);

  // …and on a board with no crates at all, it says what to do instead.
  const none = await callTool(base, "search_board", { board: otherBoardId, crate: "Nope" });
  assert.match(toolText(none.result), /no crates yet — save_to_crate creates one/);
});
