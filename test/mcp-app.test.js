// The MCP App: the ui:// resource, the thumbnail tier, and the structured half
// of a search result (planning/mcp-stage-4.md).
//
// The load-bearing test here is the LAST one. Most clients will never render
// this — Claude Code, which the Agents tab's own copy-command sets up, does not
// advertise the extension at all — so the text result is the contract, and it
// has to be byte-identical whether or not the UI half exists.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { startServer, mcp, callTool, toolText } from "./helpers.js";
import { createBoard, createEntity, insertItem, setSetting, getSetting } from "../server/db.js";

let srv, db, base, boardId, cards;

const UI_URI = "ui://001az-boards/board-grid";
const UI_MIME = "text/html;profile=mcp-app";
const rpc = (method, params) =>
  mcp(base, { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });

async function seedCard(identity, tags) {
  const name = `${identity}.png`;
  const eid = await createEntity(db, boardId, { identity });
  const itemId = await insertItem(
    db, boardId,
    { identity, files: [{ name, original_name: name, w: 40, h: 24, kind: "image", meta: { width: 40, height: 24 } }], fields: {} },
    "tagged", eid
  );
  await db.query("UPDATE items SET tags=$1 WHERE id=$2", [JSON.stringify(tags), itemId]);
  await sharp({ create: { width: 40, height: 24, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .png().toFile(path.join(srv.galleryDir, name));
  await sharp({ create: { width: 20, height: 12, channels: 3, background: { r: 4, g: 4, b: 4 } } })
    .webp().toFile(path.join(srv.thumbsDir, name + ".webp"));
  return eid;
}

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  await setSetting(db, "mcp_enabled", "1");
  boardId = await createBoard(db, "Grid board", [
    { key: "theme", single: true, values: ["light", "dark"] },
    { key: "parts", values: ["data-table", "kanban"] },
  ], "");
  cards = [
    await seedCard("one", ["theme/dark", "parts/data-table"]),
    await seedCard("two", ["theme/light", "parts/data-table", "parts/kanban"]),
  ];
});
after(() => srv.close());

const search = (args = {}) => callTool(base, "search_board", { board: boardId, include_images: false, ...args });

// --- the resource ------------------------------------------------------------

test("initialize declares the extension, and resources/list advertises the template", async () => {
  const caps = (await rpc("initialize")).json.result.capabilities;
  assert.deepEqual(caps.extensions, { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } });
  assert.deepEqual(caps.resources, {});

  const { resources } = (await rpc("resources/list")).json.result;
  assert.equal(resources.length, 1);
  const [r] = resources;
  assert.equal(r.uri, UI_URI);
  // The spec is explicit that this MUST be the profile mime, not plain html —
  // it is how a host tells an app template from an attachment.
  assert.equal(r.mimeType, UI_MIME);
  assert.ok(r._meta.ui.csp, "the listing carries the CSP too, since a host may prefetch from it");
});

test("resources/read serves the template, and names only this instance's origin", async () => {
  const { contents } = (await rpc("resources/read", { uri: UI_URI })).json.result;
  assert.equal(contents.length, 1);
  const [c] = contents;
  assert.equal(c.uri, UI_URI);
  assert.equal(c.mimeType, UI_MIME);
  assert.match(c.text, /^<!doctype html>/i);

  // Exactly one origin, and it must be the one the thumbnails are actually on
  // — asserting them against each other is the real claim, where hardcoding an
  // address would only restate BASE_URL (which in tests is not the ephemeral
  // port the server listens on; see mcp-asset.test.js).
  const csp = c._meta.ui.csp;
  const { result } = await search();
  assert.deepEqual(
    csp.resourceDomains,
    [new URL(result.structuredContent.cards[0].thumb).origin],
    "thumbnails, and nothing else"
  );
  // The view never fetches — everything it knows arrives over postMessage — so
  // an allowance here would be one a later change could quietly start using.
  assert.deepEqual(csp.connectDomains, []);
  assert.deepEqual(csp.frameDomains, []);
});

test("an unadvertised resource uri is a protocol error", async () => {
  // Not a tool error: nothing about it is recoverable by a model, it is a
  // client asking for something that was never offered.
  const r = await rpc("resources/read", { uri: "ui://001az-boards/nope" });
  assert.equal(r.json.error.code, -32602);
  assert.equal(r.json.result, undefined);
});

test("the template is self-contained — no src or href leaves the document", async () => {
  // THE pin that keeps a future edit from reintroducing a CDN. A ui:// resource
  // runs under `default-src 'none'` with only the domains we declare, so an
  // external <script> or <link> would not merely be a policy question — it
  // would silently not load, in someone else's client, with no error we see.
  const { contents: [c] } = (await rpc("resources/read", { uri: UI_URI })).json.result;
  //
  // The claim is "no FIXED external reference", not "no src attribute": the
  // view's own `<img src="${esc(c.thumb)}">` is a runtime expression filled
  // from the signed link, which is the one origin the CSP declares. So every
  // reference has to be an interpolation — a literal one is the failure,
  // whatever it points at.
  const refs = [...c.text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
  const literal = refs.filter((r) => !r.includes("${"));
  assert.deepEqual(literal, [], `the template pulls in ${JSON.stringify(literal)}`);

  // …and nothing dynamic sneaks one in either. Asserted against the CODE, with
  // comments stripped: the file's own header explains why there is no fetch()
  // in it, and a pin that reads prose is a pin that fails on its own
  // documentation.
  const code = c.text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bimport\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});

// --- the thumbnail tier ------------------------------------------------------

test("a thumb link serves the thumb, and cannot be walked to the original", async () => {
  const { result } = await search();
  const url = result.structuredContent.cards[0].thumb;
  assert.match(url, /\/mcp\/thumb\//);

  const thumb = await fetch(base + new URL(url).pathname);
  assert.equal(thumb.status, 200);
  assert.match(thumb.headers.get("content-type"), /image\/webp/);

  // The kind is SIGNED, so swapping the segment does not buy the full file.
  // Without that, every thumb link would be a download link for the original.
  const walked = await fetch(base + new URL(url).pathname.replace("/mcp/thumb/", "/mcp/asset/"));
  assert.equal(walked.status, 403);
});

test("the two tiers sign differently for the same file", async () => {
  const secret = await getSetting(db, "mcp_asset_secret");
  const name = "one.png";
  const exp = Date.now() + 60_000;
  const sig = (kind) =>
    crypto.createHmac("sha256", secret).update(`${kind}:${name}.${exp}`).digest("base64url").slice(0, 22);
  assert.notEqual(sig("asset"), sig("thumb"));
  assert.equal((await fetch(`${base}/mcp/thumb/${name}/${exp}/${sig("thumb")}`)).status, 200);
  assert.equal((await fetch(`${base}/mcp/thumb/${name}/${exp}/${sig("asset")}`)).status, 403);
  assert.equal((await fetch(`${base}/mcp/asset/${name}/${exp}/${sig("asset")}`)).status, 200);

  // A thumb whose .webp is missing is a 404, not a silent empty image.
  fs.rmSync(path.join(srv.thumbsDir, "two.png.webp"));
  const gone = Date.now() + 60_000;
  const s2 = crypto.createHmac("sha256", secret).update(`thumb:two.png.${gone}`).digest("base64url").slice(0, 22);
  assert.equal((await fetch(`${base}/mcp/thumb/two.png/${gone}/${s2}`)).status, 404);
});

// --- the structured half -----------------------------------------------------

test("search_board carries the cards a grid needs, and no more", async () => {
  const { result } = await search();
  const s = result.structuredContent;
  assert.deepEqual(s.board, { id: boardId, name: "Grid board" });
  assert.equal(s.matched, 2);
  assert.equal(s.canSave, true);
  assert.equal(s.cards.length, 2);

  const card = s.cards.find((c) => c.id === cards[0]);
  assert.ok(card, "cards speak the same entity ids the text blocks do");
  assert.match(card.thumb, /^https?:\/\/[^/]+\/mcp\/thumb\//);
  assert.deepEqual([card.w, card.h], [40, 24]);
  // The caption is the single-value facet line — the same one resultText
  // prints, from the same function, so the tile and the prose cannot drift.
  // Every facet this card carries ONE value for — which includes `parts` here,
  // because `singles` is about how many values this item has, not how many the
  // facet allows.
  assert.equal(card.caption, "theme/dark · parts/data-table");
  const multi = s.cards.find((c) => c.id === cards[1]);
  assert.equal(multi.caption, "theme/light", "a facet carrying several values is not a caption");
  // …and it is capped, which the text block is not. Measured live, uncapped
  // captions on a nine-facet board were most of the payload and unreadable in
  // a one-line overlay besides.
  assert.ok(card.caption.split(" · ").length <= 3);
  assert.ok(toolText(result).includes("theme/dark"), "the model still gets the full row");
  // The facet MAP is deliberately absent: the model already has it in the text
  // blocks, and a grid does not render it.
  assert.equal(card.facets, undefined);
  assert.equal(card.tags, undefined);
});

test("saving switched off makes the tiles unpickable", async () => {
  await setSetting(db, "mcp_write", "0");
  try {
    assert.equal((await search()).result.structuredContent.canSave, false);
  } finally {
    await setSetting(db, "mcp_write", null);
  }
  assert.equal((await search()).result.structuredContent.canSave, true);
});

test("the tool points at the template, and only the one with a view does", async () => {
  const { tools } = (await rpc("tools/list")).json.result;
  const withUi = tools.filter((t) => t._meta?.ui);
  assert.deepEqual(withUi.map((t) => t.name), ["search_board"]);
  assert.equal(withUi[0]._meta.ui.resourceUri, UI_URI);
  // The uri a tool names MUST be one resources/read actually serves.
  const served = (await rpc("resources/list")).json.result.resources.map((r) => r.uri);
  assert.ok(served.includes(withUi[0]._meta.ui.resourceUri));
  // Our own markers never reach the wire.
  for (const t of tools) assert.equal(t.ui, undefined);
});

// --- the contract ------------------------------------------------------------

test("the text result is untouched by any of this", async () => {
  // What every client without MCP Apps support shows — which today is most of
  // them, including the one the Agents tab tells you to set up. If adding a
  // view changed the prose, stage 4 would have cost stages 1-3 something.
  const { result } = await search();
  const body = toolText(result);
  assert.match(body, /### 1 of 2 · id \d+/);
  assert.match(body, /theme\/dark/);
  assert.match(body, /matched 2 · returned 2/);
  // structuredContent is NOT also pasted in as JSON. The spec SHOULDs that for
  // backwards compatibility; here it would bill the model twice for one answer.
  assert.doesNotMatch(body, /"cards"|"canSave"|\/mcp\/thumb\//);
});
