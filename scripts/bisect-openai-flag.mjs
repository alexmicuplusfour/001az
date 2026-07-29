// Bisect which component of the tagging request trips OpenAI's invalid_prompt
// flag: system text alone, tool schema alone, halves of the system text, and
// a model sweep. Usage: OPENAI_KEY=... node scripts/bisect-openai-flag.mjs
import fs from "node:fs";
import { buildPrompt } from "../server/worker.js";
import { compatRequest } from "../server/ai-providers/wires/compat.js";
import { PROVIDERS } from "../server/providers.js";

const key = process.env.OPENAI_KEY;
if (!key) throw new Error("OPENAI_KEY not set");
const board = JSON.parse(fs.readFileSync("scripts/logos-board.json", "utf8"));
const { systemText, schema } = buildPrompt(board.facets, board.context || "");
const parts = [{ kind: "text", text: "Tag this image using the record_tags tool." }];
const compat = PROVIDERS.openai.compat;
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
  return r.ok;
};

// Split the system text: intro/instructions vs the facet catalog lines.
const facetsAt = systemText.indexOf("Facets and allowed values:");
const sysHead = systemText.slice(0, facetsAt);
const sysFacets = systemText.slice(facetsAt);
const tinySchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

await ask("1 system-only, no tools     ", { model: MODEL, max_completion_tokens: 16, messages: [{ role: "system", content: systemText }, { role: "user", content: "Tag it." }] });
await ask("2 tools-only, tiny system   ", compatRequest({ compat, model: MODEL, systemText: "You tag items.", schema, parts }));
await ask("3 sys head half, no tools   ", { model: MODEL, max_completion_tokens: 16, messages: [{ role: "system", content: sysHead }, { role: "user", content: "Tag it." }] });
await ask("4 sys facet half, no tools  ", { model: MODEL, max_completion_tokens: 16, messages: [{ role: "system", content: sysFacets }, { role: "user", content: "Tag it." }] });
await ask("5 tiny schema, real system  ", compatRequest({ compat, model: MODEL, systemText, schema: tinySchema, parts }));
await ask("6 real request on gpt-5.1   ", compatRequest({ compat, model: "gpt-5.1", systemText, schema, parts }));
await ask("7 real request on gpt-5-mini", compatRequest({ compat, model: "gpt-5-mini", systemText, schema, parts }));
