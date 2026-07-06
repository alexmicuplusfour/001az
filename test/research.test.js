// Web research: the per-board toggle (boards.ai_research) that lets the
// tagger use a provider web-search tool before judging. Anthropic-only —
// these tests pin the request shape both ways (forced tool call without
// research, relaxed tool choice + web_search with it), the prompt paragraph,
// and the ai_research round-trip through the board routes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import { anthropicRequest } from "../server/providers.js";
import { buildPrompt } from "../server/worker.js";

const facets = [{ key: "kind", label: "Kind", single: true, values: ["a", "b"] }];
const { schema } = buildPrompt(facets);
const parts = [{ kind: "text", text: "judge this" }];

test("research off: single forced record_tags tool, base output budget", () => {
  const r = anthropicRequest({ model: "m", systemText: "s", schema, parts });
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].name, "record_tags");
  assert.deepEqual(r.tool_choice, { type: "tool", name: "record_tags" });
  assert.equal(r.max_tokens, 2048);
});

test("research on: web_search rides along, tool choice relaxes, budget grows", () => {
  const r = anthropicRequest({ model: "m", systemText: "s", schema, parts, research: true });
  assert.equal(r.tools.length, 2);
  assert.equal(r.tools[0].type, "web_search_20250305");
  assert.equal(r.tools[0].max_uses, 5); // per-item spend bound
  assert.equal(r.tools[1].name, "record_tags");
  // a forced tool call would block the server-side search tool
  assert.deepEqual(r.tool_choice, { type: "auto" });
  assert.equal(r.max_tokens, 4096);
});

test("research paragraph appears in the system text only when asked", () => {
  const on = buildPrompt(facets, "", true, "items", true).systemText;
  assert.match(on, /web search tool is available/);
  assert.match(on, /finish by calling record_tags exactly once/);
  const off = buildPrompt(facets, "", true, "items", false).systemText;
  assert.doesNotMatch(off, /web search tool/);
  // the flag changes only the prompt, never the tool schema
  assert.deepEqual(buildPrompt(facets, "", true, "items", true).schema, buildPrompt(facets).schema);
});

// --- ai_research through the board routes ---

let srv, db, base, admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});

after(() => srv.close());

test("ai_research: off by default, settable at create, flippable via PATCH", async () => {
  const plain = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "plain" } });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.ai_research, false);

  const created = await req(base, "POST", "/api/admin/boards", {
    sid: admin.sid,
    body: { name: "researched", ai_research: true },
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.ai_research, true);

  const list = async () => (await req(base, "GET", "/api/admin/boards", { sid: admin.sid })).json;
  let board = (await list()).find((b) => b.id === created.json.id);
  assert.equal(board.ai_research, true);

  const patched = await req(base, "PATCH", `/api/admin/boards/${board.id}`, {
    sid: admin.sid,
    body: { ai_research: false },
  });
  assert.equal(patched.status, 200);
  board = (await list()).find((b) => b.id === created.json.id);
  assert.equal(board.ai_research, false);
});
