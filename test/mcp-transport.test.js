// The MCP transport: version negotiation, the method dispatch, the JSON-RPC
// error codes, and the three gates (enabled / origin / token). No board data —
// mcp-tools.test.js owns everything that reads one.
//
// The split is the point: this file would pass against a server with no
// database, which is what keeps the protocol half honest about being protocol.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, mcp } from "./helpers.js";
import { setSetting } from "../server/db.js";
import { toolSpecs } from "../server/mcp-tools.js";

let srv, db, base;

// The Origin gate compares against BASE_URL — the address this instance
// CLAIMS — not the request's Host header, which the caller writes. So the
// same-origin case has to be pinned to a known base, set before import.
const BASE = "https://boards.example";

const rpc = (method, params, opts) =>
  mcp(base, { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, opts);

before(async () => {
  process.env.BASE_URL = BASE;
  srv = await startServer();
  db = srv.db;
  base = srv.base;
  await setSetting(db, "mcp_enabled", "1");
});
after(async () => {
  delete process.env.BASE_URL;
  await srv.close();
});

test("disabled is 404, not an outage", async () => {
  await setSetting(db, "mcp_enabled", null);
  // Every method, including the handshake: a client must not get as far as
  // believing it connected.
  assert.equal((await rpc("initialize")).status, 404);
  assert.equal((await rpc("tools/list")).status, 404);
  await setSetting(db, "mcp_enabled", "1");
  assert.equal((await rpc("tools/list")).status, 200);
});

test("initialize echoes a version it speaks", async () => {
  const r = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.protocolVersion, "2025-06-18");
  // tools, plus the one resource surface that carries the MCP App template,
  // plus the extension that says the template is renderable.
  assert.deepEqual(r.json.result.capabilities, {
    tools: {},
    resources: {},
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  });
  assert.equal(r.json.result.serverInfo.name, "001az-boards");
  assert.match(r.json.result.instructions, /describe_board/);
});

test("initialize answers with ours when it doesn't speak theirs", async () => {
  // The spec's rule is answer-with-yours, NOT refuse — the client decides
  // whether it can live with the difference.
  const r = await rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.protocolVersion, "2025-06-18");
  assert.equal(r.json.error, undefined);
});

test("an unsupported protocol HEADER is 400, an absent one is assumed", async () => {
  assert.equal((await rpc("tools/list", null, { version: "nonsense" })).status, 400);
  // No header identifies a pre-header client, which the spec says to read as
  // 2025-03-26 rather than reject.
  assert.equal((await rpc("tools/list", null, { version: null })).status, 200);
});

test("GET and DELETE are 405 — we offer no server-initiated stream", async () => {
  const get = await mcp(base, undefined, { method: "GET" });
  assert.equal(get.status, 405);
  assert.equal((await mcp(base, undefined, { method: "DELETE" })).status, 405);
});

test("a notification is accepted with 202 and no body", async () => {
  const r = await mcp(base, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r.status, 202);
  assert.equal(r.text, "");
});

test("malformed input gets the right JSON-RPC codes", async () => {
  const bad = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
    body: "{not json",
  });
  // express.json() rejects an unparseable body before we see it; either way the
  // client must not get a 200 with a result.
  assert.ok(bad.status >= 400);

  const noMethod = await mcp(base, { jsonrpc: "2.0", id: 7 });
  assert.equal(noMethod.json.error.code, -32600);

  const unknown = await rpc("no/such/method");
  assert.equal(unknown.json.error.code, -32601);
});

test("an unknown TOOL is a protocol error, not a tool error", async () => {
  // The distinction the spec draws and the one that matters: a model can read
  // and recover from isError, where this is a transport-level fact.
  const r = await rpc("tools/call", { name: "serch_board", arguments: {} });
  assert.equal(r.json.error.code, -32601);
  assert.equal(r.json.result, undefined);
});

test("tools/list advertises complete, valid schemas", async () => {
  const { tools } = (await rpc("tools/list")).json.result;
  // Compared against the registry, not a list written here: adding a tool must
  // not be able to make this test wrong (the stance browser/mcp-tab takes too).
  assert.deepEqual(tools.map((t) => t.name).sort(), toolSpecs().map((t) => t.name).sort());
  for (const t of tools) {
    assert.ok(t.description, `${t.name} has a description`);
    assert.equal(t.inputSchema.type, "object");
    // A `required` naming something the schema never declares is the schema
    // bug a model cannot recover from — it would keep sending a field we
    // ignore, or omit one we demand.
    for (const r of t.inputSchema.required || []) {
      assert.ok(t.inputSchema.properties[r], `${t.name}.${r} is declared`);
    }
    assert.equal(t.handler, undefined, `${t.name} does not leak its handler`);
    assert.equal(t.write, undefined, `${t.name} does not leak our own write marker`);
  }
});

test("every tool declares its annotations, so a client can tell reads from writes", async () => {
  // An UNannotated tool is assumed destructive, non-idempotent and open-world
  // — the spec's pessimistic default. That is noise while everything is a
  // read and a real problem once one tool writes, because a client that
  // cannot tell them apart has to prompt on all of them or none.
  //
  // Asserted over the whole registry rather than tool by tool: the point is
  // that a SIXTH tool cannot ship silently pessimistic.
  const { tools } = (await rpc("tools/list")).json.result;
  assert.ok(tools.length >= 5);
  for (const t of tools) {
    const a = t.annotations;
    assert.ok(a, `${t.name} is annotated`);
    assert.equal(a.openWorldHint, false, `${t.name} stays inside this instance`);
    assert.equal(typeof a.readOnlyHint, "boolean", `${t.name} says whether it writes`);
    assert.equal(a.idempotentHint, true, `${t.name} is safe to repeat`);
    if (a.readOnlyHint) {
      // Meaningful only when readOnlyHint is false; stating it next to `true`
      // would imply the two are independent knobs.
      assert.equal(a.destructiveHint, undefined, `${t.name} is a read — destructiveHint is not its to answer`);
    } else {
      assert.equal(a.destructiveHint, false, `${t.name} only ever adds`);
    }
  }
  assert.deepEqual(
    tools.filter((t) => t.annotations.readOnlyHint === false).map((t) => t.name),
    ["save_to_crate"],
    "exactly one tool writes"
  );
});

test("Origin is validated — the DNS-rebinding gate", async () => {
  // A real MCP client sends no Origin at all, which must stay free.
  assert.equal((await rpc("tools/list")).status, 200);
  assert.equal((await rpc("tools/list", null, { origin: "https://evil.example" })).status, 403);
  assert.equal((await rpc("tools/list", null, { origin: BASE })).status, 200);
  // Trailing slashes are the same origin, not a different one.
  assert.equal((await rpc("tools/list", null, { origin: BASE + "/" })).status, 200);
  // A spoofed Host must not buy same-origin: the gate reads BASE_URL, so this
  // is refused even though Host and Origin agree with each other.
  const spoof = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
      Host: "evil.example",
      Origin: "https://evil.example",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(spoof.status, 403);

  await setSetting(db, "mcp_origins", "https://ok.example, https://also.example");
  assert.equal((await rpc("tools/list", null, { origin: "https://ok.example" })).status, 200);
  assert.equal((await rpc("tools/list", null, { origin: "https://nope.example" })).status, 403);
  await setSetting(db, "mcp_origins", null);
});

test("a stored token is required, and compared exactly", async () => {
  await setSetting(db, "mcp_token", "sekrit-token-value");
  assert.equal((await rpc("tools/list")).status, 401);
  assert.equal((await rpc("tools/list", null, { token: "wrong" })).status, 401);
  // Same length, different bytes — the case a naive prefix compare would pass.
  assert.equal((await rpc("tools/list", null, { token: "sekrit-token-valuX" })).status, 401);
  assert.equal((await rpc("tools/list", null, { token: "sekrit-token-value" })).status, 200);
  await setSetting(db, "mcp_token", null);
});

test("no token means local clients only", async () => {
  // The ease-of-setup path: nothing configured, and the machine it runs on can
  // talk to it.
  assert.equal((await rpc("tools/list")).status, 200);
  // The app sets `trust proxy` 1, so this is what a request from anywhere else
  // looks like — and without a token it must be refused.
  const remote = await rpc("tools/list", null, { xff: "203.0.113.7" });
  assert.equal(remote.status, 401);
  assert.match(remote.json.error, /token/);

  // And the same caller CLAIMING to be local. `trust proxy` makes req.ip
  // whatever the last X-Forwarded-For entry says, so this was answered 200 —
  // every tool, no token, to anyone who could reach the published port. The
  // rule reads the socket now, and a declared hop is never this machine.
  assert.equal((await rpc("tools/list", null, { xff: "127.0.0.1" })).status, 401);
  assert.equal((await rpc("tools/list", null, { xff: "203.0.113.7, 127.0.0.1" })).status, 401);
});
