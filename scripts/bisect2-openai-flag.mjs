// Round 2: probes 1-7 showed the system text passes alone and ANY tool-bearing
// variant flags. Confounded variables: tools present, strict, forced
// tool_choice, the user-turn wording, the tool name. Isolate each.
// Usage: OPENAI_KEY=... node scripts/bisect2-openai-flag.mjs
const key = process.env.OPENAI_KEY;
if (!key) throw new Error("OPENAI_KEY not set");
const MODEL = "gpt-5.4-mini";

const ask = async (name, body) => {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await r.json().catch(() => ({}));
  console.log(`${name} -> ${r.ok ? "OK" : `FLAGGED (${data.error?.code ?? r.status})`}`);
};

const tinyParams = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const tool = (name, strict) => ({ type: "function", function: { name, description: "Record the result.", parameters: tinyParams, ...(strict ? { strict: true } : {}) } });
const base = (extra) => ({ model: MODEL, max_completion_tokens: 64, messages: [{ role: "system", content: "You tag items." }, { role: "user", content: "Tag it." }], ...extra });

await ask("a tools strict+forced, plain user ", base({ tools: [tool("record_tags", true)], tool_choice: { type: "function", function: { name: "record_tags" } } }));
await ask("b tools strict, auto choice       ", base({ tools: [tool("record_tags", true)], tool_choice: "auto" }));
await ask("c tools no-strict, forced         ", base({ tools: [tool("record_tags", false)], tool_choice: { type: "function", function: { name: "record_tags" } } }));
await ask("d tools no-strict, auto           ", base({ tools: [tool("record_tags", false)], tool_choice: "auto" }));
await ask("e no tools, user names the tool   ", { model: MODEL, max_completion_tokens: 64, messages: [{ role: "system", content: "You tag items." }, { role: "user", content: "Tag this image using the record_tags tool." }] });
await ask("f tools strict+forced, other name ", base({ tools: [tool("record_result", true)], tool_choice: { type: "function", function: { name: "record_result" } } }));
