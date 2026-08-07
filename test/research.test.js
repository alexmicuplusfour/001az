// Web research: the per-board toggle (boards.ai_research) that lets the
// tagger use a provider web-search tool before judging. Anthropic-only —
// these tests pin the request shape both ways (forced tool call without
// research, relaxed tool choice + web_search with it), the prompt paragraph,
// and the ai_research round-trip through the board routes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, adminSession, req } from "./helpers.js";
import { anthropicRequest } from "../server/ai-providers/wires/anthropic.js";
import { OUTPUT_BUDGET } from "../server/ai-providers/wires/tool.js";
import { buildPrompt } from "../server/worker.js";

const facets = [{ key: "kind", label: "Kind", single: true, values: ["a", "b"] }];
const { schema } = buildPrompt(facets);
const parts = [{ kind: "text", text: "judge this" }];

test("research off: single forced record_tags tool, base output budget", () => {
  const r = anthropicRequest({ model: "m", systemText: "s", schema, parts });
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].name, "record_tags");
  assert.deepEqual(r.tool_choice, { type: "tool", name: "record_tags" });
  assert.equal(r.max_tokens, OUTPUT_BUDGET);
});

test("research on: web_search rides along, tool choice relaxes", () => {
  const r = anthropicRequest({ model: "m", systemText: "s", schema, parts, research: true });
  assert.equal(r.tools.length, 2);
  assert.equal(r.tools[0].type, "web_search_20250305");
  assert.equal(r.tools[0].max_uses, 5); // per-item spend bound
  assert.equal(r.tools[1].name, "record_tags");
  // a forced tool call would block the server-side search tool
  assert.deepEqual(r.tool_choice, { type: "auto" });
  // the cap is a runaway guard now, not a size estimate — research needs no
  // separate floor because there is nothing left to be a floor under
  assert.equal(r.max_tokens, OUTPUT_BUDGET);
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

test("output budget is flat: neither schema size nor research moves it", () => {
  const bigSchema = (n) => ({
    type: "object",
    properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: "object" }])),
    required: [],
  });
  for (const n of [1, 40, 100]) {
    assert.equal(anthropicRequest({ model: "m", systemText: "s", schema: bigSchema(n), parts }).max_tokens, OUTPUT_BUDGET);
    assert.equal(
      anthropicRequest({ model: "m", systemText: "s", schema: bigSchema(n), parts, research: true }).max_tokens,
      OUTPUT_BUDGET
    );
  }
});

// A turn that stops at max_tokens can still carry the whole tool call — Gemini
// does it routinely (see the compat wire), and Claude can too. Failing the item
// then would discard a usable answer, so the clip throw is conditional on the
// call NOT surviving. Completeness is the schema's required keys: parseRun
// reads a missing facet as "no tags", not as damage, so a half-written call has
// to be caught here.
test("anthropic wire: max_tokens is fatal only when the tool call didn't survive", async () => {
  const { anthropicWire } = await import("../server/ai-providers/wires/anthropic.js");
  const { schema: s } = buildPrompt(facets);
  // A stand-in Messages API, like the model-discovery tests' fake boxes: every
  // turn stops at max_tokens, and the test varies only how whole the call is.
  const box = http.createServer((rq, rs) => {
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "m",
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", id: "tu_1", name: "record_tags", input: box.input }],
      usage: { input_tokens: 10, output_tokens: 20 },
    }));
  });
  await new Promise((r) => box.listen(0, "127.0.0.1", r));
  const desc = { base: `http://127.0.0.1:${box.address().port}` };
  const opts = { apiKey: "sk-ant-wiretest", model: "m", systemText: "s", schema: s, parts };
  try {
    // every required key present → the clip cost us nothing, keep the answer
    box.input = Object.fromEntries(
      s.required.map((k) => [k, k === "description" ? "d" : { reasoning: "r", values: [] }])
    );
    assert.deepEqual((await anthropicWire.tag(desc, opts)).input, box.input);
    // a key short → genuinely truncated, fail permanently rather than tag blanks
    const { description, ...partial } = box.input;
    box.input = partial;
    await assert.rejects(
      anthropicWire.tag(desc, opts),
      (e) => /token cap/.test(e.message) && e.status === 422
    );
  } finally {
    box.close();
  }
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
