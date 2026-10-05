// Web research: the per-board toggle (boards.ai_research) that lets the
// tagger use a provider web-search tool before judging. Two research-capable
// wires — Anthropic (server-side web_search, tool choice relaxed to auto)
// and the google family (native generateContent, record_tags FORCED straight
// through the search; wires/google.js) — these tests pin both request shapes,
// the native response/usage mapping, the prompt paragraph, and the
// ai_research round-trip through the board routes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, adminSession, req, withFetch, recorder } from "./helpers.js";
import { anthropicRequest } from "../server/ai-providers/wires/anthropic.js";
import { googleRequest, googleWire } from "../server/ai-providers/wires/google.js";
import { OUTPUT_BUDGET } from "../server/ai-providers/wires/tool.js";
import { buildPrompt } from "../server/worker.js";
import { PROVIDERS } from "../server/providers.js";

const facets = [{ key: "kind", label: "Kind", single: true, values: ["a", "b"] }];
const { schema } = buildPrompt(facets);
const parts = [{ kind: "text", text: "judge this" }];

// A complete record_tags payload keyed off the schema — the wires' wholeness
// check reads only "k in input", so the facet-vs-fit value shape is moot.
const wholeInput = () => Object.fromEntries(
  schema.required.map((k) => [k, k === "description" ? "d" : { reasoning: "r", values: [] }])
);

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
  const opts = { apiKey: "sk-ant-wiretest", model: "m", systemText: "s", schema, parts };
  try {
    // every required key present → the clip cost us nothing, keep the answer
    box.input = wholeInput();
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

// --- the google wire: research rides Gemini's native protocol ---
// (probed live 2026-09-04 — planning/gemini-research-plan.md holds the record)

const gemini = PROVIDERS.gemini;
const jsonResponse = (body) => async () => new Response(JSON.stringify(body), { status: 200 });

const gTagOpts = (extra = {}) => ({ apiKey: "k", model: "gemini-3.5-flash", systemText: "s", schema, parts, ...extra });

test("google request: search + FORCED record_tags coexist, schema untouched", () => {
  const r = googleRequest({ systemText: "s", schema, parts, temperature: 0, research: true });
  assert.deepEqual(r.tools[0], { google_search: {} });
  const fn = r.tools[1].function_declarations[0];
  assert.equal(fn.name, "record_tags");
  // the SAME object buildPrompt made — additionalProperties intact; the
  // classic `parameters` proto rejects it, parametersJsonSchema takes it
  assert.equal(fn.parametersJsonSchema, schema);
  assert.equal(schema.additionalProperties, false);
  // ANY forces the call without blocking the search — no relax-and-trust
  assert.deepEqual(r.tool_config.function_calling_config,
    { mode: "ANY", allowed_function_names: ["record_tags"] });
  // the flag that unlocks built-in search + function calling AND narrates
  // each executed search as a countable toolCall part
  assert.equal(r.tool_config.include_server_side_tool_invocations, true);
  assert.equal(r.generation_config.maxOutputTokens, OUTPUT_BUDGET);
  assert.equal(r.generation_config.temperature, 0);
  // temperature follows the wires' value-or-omit convention
  assert.equal("temperature" in googleRequest({ systemText: "s", schema, parts }).generation_config, false);
  assert.equal(r.system_instruction.parts[0].text, "s");
  // image parts speak inline_data, not the compat family's data URLs
  const img = googleRequest({ systemText: "s", schema, parts: [{ kind: "image", mediaType: "image/webp", b64: "QQ==" }] });
  assert.deepEqual(img.contents[0].parts[0], { inline_data: { mime_type: "image/webp", data: "QQ==" } });
});

test("google wire: research off stays on the compat endpoint, request untouched", async () => {
  let seen;
  await withFetch(async (url, opts) => {
    seen = { url: String(url), body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: "record_tags", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200 });
  }, () => googleWire.tag(gemini, gTagOpts()));
  assert.match(seen.url, /\/openai\/chat\/completions$/);
  // the compat shape, forced by name — byte-identical to riding wires.compat
  assert.deepEqual(seen.body.tool_choice, { type: "function", function: { name: "record_tags" } });
});

test("google wire: research speaks native — the forced call arrives through the search, searches counted from toolCall parts", async () => {
  const input = wholeInput();
  let seen;
  const r = await withFetch(async (url, opts) => {
    seen = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [
          { toolCall: { toolType: "GOOGLE_SEARCH_WEB", args: { queries: ["a", "b", "c"] } } },
          { toolResponse: { toolType: "GOOGLE_SEARCH_WEB", response: {} } },
          { functionCall: { name: "record_tags", args: input } },
        ] },
      }],
      usageMetadata: { promptTokenCount: 274, candidatesTokenCount: 58, thoughtsTokenCount: 467, totalTokenCount: 799 },
    }), { status: 200 });
  }, () => googleWire.tag(gemini, gTagOpts({ research: true })));
  assert.equal(seen.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
  assert.equal(seen.headers["x-goog-api-key"], "k");
  // the descriptor quirk's measured temperature rides the native path too
  assert.equal(seen.body.generation_config.temperature, 0);
  assert.deepEqual(r.input, input);
  // one search round, three executed queries = three billable searches;
  // thoughts fold into output (58 + 467) — they are what Google charges
  assert.deepEqual(r.usage, { input: 274, output: 525, cacheRead: 0, searches: 3 });
});

test("google wire: search count falls back to groundingMetadata when no toolCall parts narrate", async () => {
  const r = await withFetch(jsonResponse({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ functionCall: { name: "record_tags", args: wholeInput() } }] },
      groundingMetadata: { webSearchQueries: ["x", "y"] },
    }],
    usageMetadata: {},
  }), () => googleWire.tag(gemini, gTagOpts({ research: true })));
  assert.equal(r.usage.searches, 2);
});

test("google wire: MAX_TOKENS is fatal only when the call didn't survive", async () => {
  const at = (input) => jsonResponse({
    candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ functionCall: { name: "record_tags", args: input } }] } }],
    usageMetadata: {},
  });
  const input = wholeInput();
  // every required key present → the clip cost us nothing, keep the answer
  const kept = await withFetch(at(input), () => googleWire.tag(gemini, gTagOpts({ research: true })));
  assert.deepEqual(kept.input, input);
  // a key short → genuinely truncated: permanent-shaped, like both wires
  const { description, ...partial } = input;
  await assert.rejects(
    withFetch(at(partial), () => googleWire.tag(gemini, gTagOpts({ research: true }))),
    (e) => /token cap/.test(e.message) && e.status === 422
  );
});

test("google wire: a searching turn that skips record_tags fails retryably; a blocked prompt names the reason", async () => {
  // the AUTO-mode shape measured live: search, then prose, no function call —
  // MALFORMED_FUNCTION_CALL turns land here too (no functionCall part)
  await assert.rejects(
    withFetch(jsonResponse({
      candidates: [{ finishReason: "STOP", content: { parts: [
        { toolCall: { toolType: "GOOGLE_SEARCH_WEB", args: { queries: ["a"] } } },
        { text: "prose answer" },
      ] } }],
      usageMetadata: {},
    }), () => googleWire.tag(gemini, gTagOpts({ research: true }))),
    /model did not call record_tags/
  );
  // safety block: no candidates at all — surface blockReason, not "no call"
  await assert.rejects(
    withFetch(jsonResponse({ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }),
      () => googleWire.tag(gemini, gTagOpts({ research: true }))),
    /SAFETY/
  );
});

test("google wire: a native temperature refusal is dropped, re-sent, and remembered", async () => {
  const refusal = () => new Response(JSON.stringify({
    error: { code: 400, message: "Unsupported value: temperature is not supported with this model.", status: "INVALID_ARGUMENT" },
  }), { status: 400 });
  const ok = () => new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "record_tags", args: wholeInput() } }] } }],
    usageMetadata: {},
  }), { status: 200 });
  const { fetch, bodies } = recorder((n) => (n === 1 ? refusal() : ok()));
  // a model id of its own: the learned set is process-lifetime and keyed by
  // (feature, endpoint, model) — don't pollute the other tests' model
  const opts = gTagOpts({ research: true, model: "gemini-refusal-probe" });
  await withFetch(fetch, () => googleWire.tag(gemini, opts));
  assert.equal(bodies[0].generation_config.temperature, 0);
  assert.equal("temperature" in bodies[1].generation_config, false);
  // learned: the next call for this model asks without it up front
  await withFetch(fetch, () => googleWire.tag(gemini, opts));
  assert.equal(bodies.length, 3);
  assert.equal("temperature" in bodies[2].generation_config, false);
});

// --- the google wire: a PDF file rides the native protocol too ---
// (pdf-conversion-plan.md, Stage 5: the compat layer refuses a file part,
// probed 2026-10-05 — "Invalid content part type: file")

const pdfParts = [{ kind: "document", mediaType: "application/pdf", b64: "UERG", name: "memo.pdf" }, { kind: "text", text: "Tag the PDF above." }];

test("google wire: a PDF goes through Gemini's own API, with the search only when research is on", async () => {
  for (const research of [false, true]) {
    let seen;
    const out = await withFetch(async (url, opts) => {
      seen = { url: String(url), body: JSON.parse(opts.body) };
      return new Response(JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "record_tags", args: wholeInput() } }] } }],
        usageMetadata: { promptTokenCount: 546, candidatesTokenCount: 5, totalTokenCount: 551 },
      }), { status: 200 });
    }, () => googleWire.tag(gemini, gTagOpts({ parts: pdfParts, research })));
    const r = `research ${research ? "on" : "off"}`;
    assert.deepEqual(out.usage, { input: 546, output: 5, cacheRead: 0, searches: 0 }, `${r}: metered as research is`);
    assert.equal(seen.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent", r);
    assert.deepEqual(seen.body.contents[0].parts, [
      { inline_data: { mime_type: "application/pdf", data: "UERG" } }, { text: "Tag the PDF above." },
    ], r);
    assert.equal(seen.body.tools.some((t) => "google_search" in t), research, `${r}: the search`);
    assert.equal("include_server_side_tool_invocations" in seen.body.tool_config, research, `${r}: its flag`);
    assert.deepEqual(seen.body.tool_config.function_calling_config, { mode: "ANY", allowed_function_names: ["record_tags"] }, r);
  }
});

test("google wire: a PDF refused as a 400, before any request, where the native endpoint can't be reached", async () => {
  // A connection's own server URL names the OpenAI-style endpoint, which takes
  // no PDF, and Gemini's own API can't be derived from it; a descriptor may
  // declare no native endpoint at all. Refused as the provider would, the step
  // sends the PDF's text; research there keeps its own, status-less message.
  const sent = [];
  const cases = [
    [gemini, { base: "http://gateway.example/v1" }, /this connection's server URL can't reach it$/],
    [{ ...gemini, nativeBase: undefined }, {}, /none is declared \(nativeBase\)$/],
  ];
  await withFetch(async (url) => { sent.push(String(url)); throw new Error("no request should go out"); }, async () => {
    for (const [desc, extra, why] of cases) {
      await assert.rejects(googleWire.tag(desc, gTagOpts({ parts: pdfParts, ...extra })), (e) => {
        assert.equal(e.status, 400, why);
        assert.match(e.message, /^PDF files go through the provider's native endpoint, but /);
        assert.match(e.message, why);
        return true;
      });
      await assert.rejects(googleWire.tag(desc, gTagOpts({ parts: pdfParts, research: true, ...extra })), (e) => {
        assert.equal(e.status, undefined, "research's own refusal");
        assert.match(e.message, /^Gemini: web research goes through the provider's native endpoint, but /);
        return true;
      });
    }
  });
  assert.deepEqual(sent, []);
});

test("google wire: a PDF without research keeps the chat deadline, not research's ten minutes", async (t) => {
  // A timeout carries no status, so it never sends the PDF's text: the item
  // waits and tries again. On every other provider a PDF gets the chat
  // deadline; Gemini's own API is no different without research.
  const saved = [process.env.AI_CHAT_TIMEOUT_MS, process.env.AI_RESEARCH_TIMEOUT_MS];
  t.after(() => {
    for (const [k, v] of [["AI_CHAT_TIMEOUT_MS", saved[0]], ["AI_RESEARCH_TIMEOUT_MS", saved[1]]])
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  process.env.AI_CHAT_TIMEOUT_MS = "50";
  process.env.AI_RESEARCH_TIMEOUT_MS = "60000";
  const hang = async (_url, opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)));
  const settled = await withFetch(hang, () => Promise.race([
    googleWire.tag(gemini, gTagOpts({ parts: pdfParts })).then(() => "answered", (e) => e.message),
    new Promise((r) => setTimeout(() => r("still waiting"), 3000)),
  ]));
  assert.match(settled, /timeout/);
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

  const list = async () => (await req(base, "GET", "/api/admin/boards", { sid: admin.sid })).json.boards;
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
