// The MCP tools against real boards: the facet algebra, the ranking, the
// projection, and access control.
//
// The load-bearing test here is "the two doors agree" — the same selection,
// run through search_board and through alerts.js's matchesCondition directly,
// must name the same cards. That is what stops a second search algebra growing
// inside mcp-tools.js, which is the one way this feature could quietly start
// lying about what a filter means.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, seedUser, mcp, callTool, toolText, toolImages } from "./helpers.js";
import { createBoard, createEntity, insertItem, setBoardMembers, setSetting } from "../server/db.js";
import { matchesCondition } from "../server/alerts.js";
import { resolveEmbedder } from "../server/worker.js";
import { findTool } from "../server/mcp-tools.js";

let srv, db, base, boardId, otherBoardId;
const byIdent = new Map(); // identity -> { eid, id }

const FACETS = [
  {
    key: "theme",
    label: "Color Theme",
    single: true,
    values: ["light", "dark", "mixed"],
    description: "The dominant scheme of the main content area.",
  },
  {
    key: "shell",
    label: "Layout Shell",
    single: true,
    values: ["sidebar-nav", "top-nav", "split-pane"],
    description: "The macro container scaffolding.",
  },
  {
    key: "parts",
    label: "Core Components",
    values: ["data-table", "code-editor", "kanban", "never-used"],
    description: "Distinct visible components.",
  },
];

// Six cards spanning the combinations the algebra has to get right: OR within
// a facet, AND across facets, exclusion, and one card carrying no tags at all.
const SEED = [
  { id: "a", tags: ["theme/dark", "shell/sidebar-nav", "parts/data-table"] },
  { id: "b", tags: ["theme/dark", "shell/split-pane", "parts/code-editor"] },
  { id: "c", tags: ["theme/light", "shell/sidebar-nav", "parts/data-table"] },
  { id: "d", tags: ["theme/light", "shell/top-nav", "parts/kanban"] },
  { id: "e", tags: ["theme/dark", "shell/sidebar-nav", "parts/data-table", "parts/code-editor"] },
  { id: "f", tags: [] },
];

// One INSTANCE on a card that already exists. Split out of seedCard for the
// counting test, which needs a card carrying two of them.
async function seedInstance(boardId, eid, identity, name, tags) {
  const id = await insertItem(
    db,
    boardId,
    { identity, files: [{ name, original_name: name, w: 10, h: 10, kind: "image" }], fields: {} },
    "tagged",
    eid
  );
  await db.query("UPDATE items SET tags=$1, tag_reasoning=$2 WHERE id=$3", [
    JSON.stringify(tags),
    JSON.stringify({ description: `A card called ${identity}.` }),
    id,
  ]);
  // The preview tier reads <face name>.webp off the thumbnails dir. Contents
  // are never parsed — the tool base64s the bytes — so anything is a thumbnail
  // for this purpose.
  fs.writeFileSync(path.join(srv.thumbsDir, name + ".webp"), Buffer.from("RIFF....WEBPVP8 "));
  return id;
}

async function seedCard(boardId, identity, tags) {
  const eid = await createEntity(db, boardId, { identity });
  return { eid, id: await seedInstance(boardId, eid, identity, `${identity}.png`, tags) };
}

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  await setSetting(db, "mcp_enabled", "1");
  boardId = await createBoard(db, "UI board", FACETS, "Screens for design reference.");
  otherBoardId = await createBoard(db, "Private board", FACETS, "");
  for (const s of SEED) byIdent.set(s.id, await seedCard(boardId, s.id, s.tags));
  await seedCard(otherBoardId, "secret", ["theme/dark"]);
});
after(() => srv.close());

const search = (args) => callTool(base, "search_board", { board: boardId, ...args });
// The ids a result named, in the order it named them.
const idsOf = (result) =>
  toolText(result)
    .split("\n")
    .map((l) => /^### \d+ of \d+ · id (\d+)/.exec(l)?.[1])
    .filter(Boolean)
    .map(Number);

// --- the anti-drift pin ------------------------------------------------------

test("search_board and matchesCondition name the same cards", async () => {
  const cases = [
    { theme: { any: ["dark"] } },                                        // include, one value
    { parts: { any: ["data-table", "code-editor"] } },                   // OR within a facet
    { theme: { any: ["dark"] }, shell: { any: ["sidebar-nav"] } },       // AND across facets
    { theme: { not: ["light"] } },                                       // exclude only
    { theme: { any: ["dark"] }, parts: { not: ["code-editor"] } },       // both halves
    { shell: { any: ["split-pane", "top-nav"] }, theme: { not: ["dark"] } },
    { theme: { any: ["no-such-value"] } },                               // matches nothing
  ];
  for (const condition of cases) {
    const expected = SEED.filter((s) => matchesCondition(new Set(s.tags), condition))
      .map((s) => byIdent.get(s.id).eid)
      .sort((a, b) => a - b);
    const { result } = await search({ facets: condition, limit: 30, include_images: false });
    assert.deepEqual(
      idsOf(result).sort((a, b) => a - b),
      expected,
      `two doors disagree on ${JSON.stringify(condition)}`
    );
  }
});

test("an empty facet selection is unconstrained, not unmatchable", async () => {
  // matchesCondition answers FALSE for an empty condition — a stored alert with
  // no values is corrupt — but an MCP search with no facets is asking for
  // everything. Passing one through would return nothing for every facet-less
  // call, which is the single easiest way to get this wrong.
  assert.equal(matchesCondition(new Set(["theme/dark"]), {}), false);
  for (const facets of [undefined, {}, { theme: {} }, "not an object", []]) {
    const { result } = await search({ facets, limit: 30, include_images: false });
    assert.equal(idsOf(result).length, SEED.length, `facets=${JSON.stringify(facets)} should match all`);
  }
});

// --- shaping -----------------------------------------------------------------

test("limit, exclude_ids and the count line", async () => {
  const two = await search({ limit: 2, include_images: false });
  assert.equal(idsOf(two.result).length, 2);
  assert.match(toolText(two.result), /matched 6 · returned 2/);
  assert.match(toolText(two.result), /exclude_ids/);

  const drop = idsOf(two.result);
  const next = await search({ limit: 30, exclude_ids: drop, include_images: false });
  const got = idsOf(next.result);
  assert.equal(got.length, SEED.length - 2);
  for (const id of drop) assert.ok(!got.includes(id), `${id} was excluded`);

  // Nothing left to page through: the invitation to refine must not appear.
  assert.doesNotMatch(toolText(next.result), /exclude_ids/);
});

test("previews ride along by default and are addressed to the model", async () => {
  const on = await search({ limit: 3 });
  const imgs = toolImages(on.result);
  assert.equal(imgs.length, 3);
  for (const i of imgs) {
    assert.equal(i.mimeType, "image/webp");
    assert.deepEqual(i.annotations.audience, ["assistant"]);
    assert.ok(i.data.length > 0);
  }
  const off = await search({ limit: 3, include_images: false });
  assert.equal(toolImages(off.result).length, 0);
  assert.equal(idsOf(off.result).length, 3);
});

test("a missing thumbnail loses its image, not the whole answer", async () => {
  // A half-restored backup is the real version of this. The card must still be
  // named — dropping it would make the gallery look smaller than it is.
  const { eid } = byIdent.get("a");
  const gone = path.join(srv.thumbsDir, "a.png.webp");
  const saved = fs.readFileSync(gone);
  fs.unlinkSync(gone);
  try {
    const { result } = await search({ facets: { shell: { any: ["sidebar-nav"] } }, limit: 30 });
    assert.ok(idsOf(result).includes(eid), "the card is still listed");
    assert.equal(toolImages(result).length, idsOf(result).length - 1);
    assert.equal(result.isError, undefined);
  } finally {
    fs.writeFileSync(gone, saved);
  }
});

test("results carry the tagger's description and the facet values", async () => {
  const { result } = await search({ facets: { theme: { any: ["light"] }, shell: { any: ["top-nav"] } } });
  const text = toolText(result);
  assert.match(text, /A card called d\./);
  assert.match(text, /theme\/light/);
  assert.match(text, /shell\/top-nav/);
  // A multi-value facet reads as a list, not as repeated pairs.
  const multi = await search({ facets: { parts: { any: ["code-editor"] }, shell: { any: ["sidebar-nav"] } } });
  assert.match(toolText(multi.result), /parts: data-table, code-editor/);
});

// --- ranking -----------------------------------------------------------------

test("similar_to ranks by stored vectors and costs nothing", async () => {
  const embedder = await resolveEmbedder(db);
  assert.ok(embedder, "the on-device embedder is the floor, so this resolves out of the box");
  // Hand-written vectors: similar_to never calls a provider — it reads what is
  // already stored — so this exercises the real ranking path with no model load.
  const vec = (arr) => Buffer.from(new Float32Array(arr).buffer);
  const put = async (ident, arr) =>
    db.query("UPDATE items SET embedding=$1, embedding_model=$2 WHERE id=$3", [
      vec(arr), embedder.model, byIdent.get(ident).id,
    ]);
  await put("a", [1, 0, 0, 0]);
  await put("b", [0.9, 0.1, 0, 0]);  // nearest to a
  await put("c", [0, 1, 0, 0]);      // orthogonal
  await put("e", [0.5, 0.5, 0, 0]);

  const { result } = await search({ similar_to: byIdent.get("a").eid, limit: 10, include_images: false });
  const order = idsOf(result);
  assert.equal(order[0], byIdent.get("a").eid, "the anchor leads its own results");
  assert.equal(order[1], byIdent.get("b").eid, "then its nearest neighbour");
  assert.ok(order.indexOf(byIdent.get("c").eid) > order.indexOf(byIdent.get("e").eid));
  // Cards with no vector can't be ranked, and the answer says so rather than
  // silently shortening.
  assert.match(toolText(result), /not embedded yet/);
});

test("facets narrow before meaning ranks", async () => {
  const { result } = await search({
    facets: { theme: { any: ["dark"] } },
    similar_to: byIdent.get("a").eid,
    limit: 10,
    include_images: false,
  });
  const got = idsOf(result);
  assert.ok(!got.includes(byIdent.get("c").eid), "a light card is gone even though it has a vector");
  assert.match(toolText(result), /matched 3/);
});

test("an unembedded anchor degrades instead of refusing", async () => {
  const { result } = await search({ similar_to: byIdent.get("d").eid, limit: 30, include_images: false });
  assert.equal(result.isError, undefined);
  assert.equal(idsOf(result).length, SEED.length, "the facet answer survives");
  assert.match(toolText(result), /has no stored vector yet/);
});

test("no embedder degrades a query instead of 404ing the call", async () => {
  // /api/search answers 404 here. Through this door that would throw away the
  // facet answer the caller could still have used.
  await setSetting(db, "embed_enabled", "0");
  try {
    const { result } = await search({ facets: { theme: { any: ["dark"] } }, query: "a dark console", include_images: false });
    assert.equal(result.isError, undefined);
    assert.equal(idsOf(result).length, 3);
    assert.match(toolText(result), /Meaning ranking is unavailable/);

    const { result: boards } = await callTool(base, "list_boards");
    assert.match(toolText(boards), /NOT configured/);
  } finally {
    await setSetting(db, "embed_enabled", null);
  }
});

// --- describe_board ----------------------------------------------------------

test("describe_board hands over the vocabulary with live counts", async () => {
  const { result } = await callTool(base, "describe_board", { board: boardId });
  const text = toolText(result);
  assert.match(text, /# UI board/);
  assert.match(text, /Screens for design reference\./);
  assert.match(text, /## theme \(one value per card\)/);
  assert.match(text, /## parts \(several values per card\)/);
  assert.match(text, /The dominant scheme of the main content area\./);
  assert.match(text, /dark \(3\)/);
  assert.match(text, /light \(2\)/);
  assert.match(text, /data-table \(3\)/);
  // A declared value nothing carries is listed at zero, never hidden: a caller
  // that saw a short list would conclude the vocabulary is smaller than it is.
  assert.match(text, /never-used \(0\)/);
  assert.match(text, /mixed \(0\)/);
});

test("describe_board counts what search_board matches, in cards", async () => {
  // Against the OTHER DOOR, never a restatement of this one's SQL. The old
  // version of this test asserted describe_board against a copy-paste of its
  // own group-by, so it agreed with the implementation by construction — which
  // it went on doing while that implementation counted image ROWS and answered
  // 18 where the search matched 10.
  //
  // The fixture has to fail against that bug, so `two-shots` is ONE card with
  // TWO instances carrying the same tag: counting rows says 3, counting cards
  // says 2. A board of one-image cards passes either way and proves nothing —
  // the trap mcp-entity-fanout.test.js names in its own header.
  const board = await createBoard(db, "Multi board", [FACETS[0]], "");
  await seedCard(board, "solo", ["theme/dark"]);
  const pair = await createEntity(db, board, { identity: "two-shots" });
  await seedInstance(board, pair, "two-shots", "two-shots-1.png", ["theme/dark"]);
  await seedInstance(board, pair, "two-shots", "two-shots-2.png", ["theme/dark"]);

  const text = toolText((await callTool(base, "describe_board", { board })).result);
  assert.match(text, /2 cards/);
  assert.match(text, /\sdark \(2\)/, "two cards carry it, not three rows");

  const hit = await callTool(base, "search_board", {
    board,
    facets: { theme: { any: ["dark"] } },
    include_images: false,
  });
  assert.match(toolText(hit.result), /matched 2/, "the count is the search's count");
});

// --- errors and access -------------------------------------------------------

test("an unknown board is a tool error naming the ones that work", async () => {
  const { result, error } = await search({ board: "no-such-board" });
  assert.equal(error, undefined, "not a protocol error");
  assert.equal(result.isError, true);
  assert.match(toolText(result), /No board "no-such-board"/);
  assert.match(toolText(result), /UI board/);
});

test("access is enforced on the search, not just the listing", async () => {
  // Stage 1's token always acts as the admin, who sees every board — so going
  // through the HTTP door could never prove this check does anything. Call the
  // handlers directly with a restricted user instead. This is exactly what the
  // transport/tools split is for: the tools half answers questions about
  // authority without a protocol in the way.
  const member = await seedUser(db, "member@test.local");
  await setBoardMembers(db, boardId, [member.id]); // this board only, never the private one
  // The ctx mcp.js builds, minus the protocol. thumbLink is part of it since
  // stage 4 — search_board mints one per card for the MCP App's grid — so a
  // stub without it is a stub that lies about the contract.
  const ctx = {
    db,
    dirs: { thumbsDir: srv.thumbsDir },
    user: { id: member.id, is_admin: false },
    thumbLinks: async (names) => names.map((n) => (n ? `https://example.test/mcp/thumb/${n}/1/sig` : null)),
    write: true,
  };

  const listed = toolText(await findTool("list_boards").handler(ctx, {}));
  assert.match(listed, /UI board/);
  assert.doesNotMatch(listed, /Private board/, "a board they are not a member of is not listed");

  // And the board they cannot see is refused BY ID — a listing filter alone
  // would let a caller who guessed the id read it anyway.
  const denied = await findTool("search_board").handler(ctx, { board: otherBoardId });
  assert.equal(denied.isError, true);
  assert.match(toolText(denied), /No board "/);
  assert.doesNotMatch(toolText(denied), /Private board/, "the refusal does not leak the board it hid");

  // Same through describe_board — every tool that takes a board id checks it.
  assert.equal((await findTool("describe_board").handler(ctx, { board: otherBoardId })).isError, true);

  // The board they DO have is served normally, so the check is not just
  // refusing everything.
  assert.equal((await findTool("search_board").handler(ctx, { board: boardId })).isError, undefined);
});

test("list_boards counts cards, not item rows", async () => {
  const { result } = await callTool(base, "list_boards");
  const line = toolText(result).split("\n").find((l) => l.includes("UI board"));
  assert.match(line, /6 cards · 3 facets/);
});

test("tools/call with non-object arguments is a protocol error", async () => {
  const r = await mcp(base, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "list_boards", arguments: [1, 2] },
  });
  assert.equal(r.json.error.code, -32602);
});

// --- get_items (stage 2) -----------------------------------------------------

test("get_items returns the full record and a rendition per id", async () => {
  const want = [byIdent.get("a").eid, byIdent.get("e").eid];
  const { result } = await callTool(base, "get_items", { board: boardId, ids: want });
  const t = toolText(result);
  for (const id of want) assert.match(t, new RegExp(`## id ${id} `));
  // Not just the description search already gave — the per-facet reasoning is
  // the thing this tool exists to hand over.
  assert.match(t, /\*\*theme\*\*: dark/);
  assert.match(t, /A card called a\./);
  assert.equal(toolImages(result).length, 2, "one rendition each");
  assert.match(t, /download the original/);
});

test("get_items refuses more than the cap instead of truncating", async () => {
  const ids = SEED.map((s) => byIdent.get(s.id).eid).concat([9991, 9992]);
  const { result } = await callTool(base, "get_items", { board: boardId, ids });
  assert.equal(result.isError, true);
  assert.match(toolText(result), /at most 6/);
  // A silent truncation would answer a different question than the one asked.
  assert.equal(toolImages(result).length, 0);
});

test("get_items names ids it could not find and still returns the rest", async () => {
  const { result } = await callTool(base, "get_items", { board: boardId, ids: [byIdent.get("a").eid, 987654] });
  assert.equal(result.isError, undefined);
  assert.match(toolText(result), new RegExp(`## id ${byIdent.get("a").eid} `));
  assert.match(toolText(result), /has id 987654/);
});

test("the board argument is the authority, not the id", async () => {
  // The id exists — on the other board. Knowing an id must not be enough.
  const other = await seedCard(otherBoardId, "elsewhere", ["theme/dark"]);
  const { result } = await callTool(base, "get_items", { board: boardId, ids: [other.eid] });
  assert.equal(result.isError, true);
  assert.match(toolText(result), /Ids are board-specific/);
});

// --- board scope (stage 2) ---------------------------------------------------

test("mcp_boards narrows every tool, by id as well as in the listing", async () => {
  await setSetting(db, "mcp_boards", boardId);
  try {
    const listed = toolText((await callTool(base, "list_boards")).result);
    assert.match(listed, /UI board/);
    assert.doesNotMatch(listed, /Private board/, "an out-of-scope board is not listed");

    // …and is unreachable BY ID from every tool that takes one. A listing
    // filter alone would let a caller that remembered the id read it anyway.
    for (const [tool, args] of [
      ["search_board", {}],
      ["describe_board", {}],
      ["get_items", { ids: [1] }],
    ]) {
      const { result } = await callTool(base, tool, { board: otherBoardId, ...args });
      assert.equal(result.isError, true, `${tool} refused the out-of-scope board`);
      assert.doesNotMatch(toolText(result), /Private board/, `${tool} did not name what it hid`);
    }
  } finally {
    await setSetting(db, "mcp_boards", null);
  }
  // Empty means ALL, not none — the trap a scope control must not set.
  assert.match(toolText((await callTool(base, "list_boards")).result), /Private board/);
});

// --- multi-instance entities -------------------------------------------------

test("search_board and get_items describe the SAME instance — the face", async () => {
  // One card, two images, and a board whose face rule is "latest" — so the
  // face is the SECOND instance and the naive "first row" answer is the wrong
  // one. That is what makes this test discriminating: with the face rule at
  // its default both candidates coincide and any implementation looks right.
  //
  // Before the fix these two tools read different rows (search took the first
  // row that HAD a description, in no defined order; get_items took the first
  // row full stop), so a card could be described one way in a search result
  // and another way when asked about directly — and neither was necessarily
  // describing the picture on screen.
  const faceBoard = await createBoard(db, "Face board", FACETS, "");
  await db.query(`UPDATE boards SET mapping=$1 WHERE id=$2`, [
    JSON.stringify({ face: { source: "file", pick: "latest" } }),
    faceBoard,
  ]);
  const eid = await createEntity(db, faceBoard, { identity: "two-shots" });
  const mk = async (name, description) => {
    fs.writeFileSync(path.join(srv.thumbsDir, name + ".webp"), Buffer.from("RIFF....WEBPVP8 "));
    const id = await insertItem(
      db, faceBoard,
      { identity: "two-shots", files: [{ name, original_name: name, w: 10, h: 10, kind: "image" }], fields: {} },
      "tagged", eid
    );
    await db.query("UPDATE items SET tags=$1, tag_reasoning=$2 WHERE id=$3", [
      JSON.stringify(["theme/dark"]),
      JSON.stringify({ description }),
      id,
    ]);
  };
  await mk("older.png", "The older instance.");
  await mk("newer.png", "The newer instance.");   // pick:"latest" -> this is the face

  const { result: searched } = await callTool(base, "search_board", { board: faceBoard, include_images: false });
  assert.match(toolText(searched), /The newer instance\./, "search describes the face");
  assert.doesNotMatch(toolText(searched), /The older instance\./);

  const { result: got } = await callTool(base, "get_items", { board: faceBoard, ids: [eid] });
  assert.match(toolText(got), /The newer instance\./, "get_items describes the same one");
  assert.doesNotMatch(toolText(got), /The older instance\./);
  // And the download offered is the face's file — a link beside a picture has
  // to be that picture.
  assert.match(toolText(got), /\/mcp\/asset\/newer\.png\//);
});

test("a face with no description does not borrow another instance's", async () => {
  // The other half of the old divergence: search used to take the first row
  // that HAD a description, so a card whose face was never described would be
  // labelled with a sentence written about a DIFFERENT picture. Silence is the
  // honest answer.
  const board = await createBoard(db, "Quiet face board", FACETS, "");
  const eid = await createEntity(db, board, { identity: "quiet" });
  for (const [name, reasoning] of [
    ["quiet.png", { theme: "No description on this one." }],
    ["loud.png", { description: "A sentence about the other picture." }],
  ]) {
    fs.writeFileSync(path.join(srv.thumbsDir, name + ".webp"), Buffer.from("RIFF....WEBPVP8 "));
    const id = await insertItem(
      db, board,
      { identity: "quiet", files: [{ name, original_name: name, w: 10, h: 10, kind: "image" }], fields: {} },
      "tagged", eid
    );
    await db.query("UPDATE items SET tags=$1, tag_reasoning=$2 WHERE id=$3",
      [JSON.stringify(["theme/dark"]), JSON.stringify(reasoning), id]);
  }
  const { result } = await callTool(base, "search_board", { board, include_images: false });
  assert.doesNotMatch(toolText(result), /the other picture/);
});

test("get_items shows the entity's whole tag union, not one instance's slice", async () => {
  // An entity's tags are the union across its instances (the listItems stance),
  // and that union is what search_board matched on. Showing one instance's
  // slice here would list fewer facets than the card the caller picked.
  const eid = await createEntity(db, boardId, { identity: "union.png" });
  fs.writeFileSync(path.join(srv.thumbsDir, "union.png.webp"), Buffer.from("RIFF....WEBPVP8 "));
  for (const [name, tags] of [["union.png", ["theme/light"]], ["union-b.png", ["parts/kanban"]]]) {
    const id = await insertItem(
      db, boardId,
      { identity: "union.png", files: [{ name, original_name: name, w: 10, h: 10, kind: "image" }], fields: {} },
      "tagged", eid
    );
    await db.query("UPDATE items SET tags=$1 WHERE id=$2", [JSON.stringify(tags), id]);
  }
  const { result } = await callTool(base, "get_items", { board: boardId, ids: [eid] });
  const t = toolText(result);
  assert.match(t, /\*\*theme\*\*: light/);
  assert.match(t, /\*\*parts\*\*: kanban/, "the other instance's facet is in the union too");
});
