// Differential probe for the OpenAI "Invalid prompt ... usage policy" flag.
// Sends three cheap requests with the key in OPENAI_KEY (never printed):
//   A. bare "Say hi" — flags => account/key-level screening, prompt irrelevant
//   B. the real logos-board tagging request (text stand-in for the image) —
//      flags => prompt-content screening
//   C. request B with reasoning-elicitation wording neutralized — passes
//      while B flags => the chain-of-thought wording is the trigger
// Usage: OPENAI_KEY=... node scripts/probe-openai-flag.mjs [model]
import fs from "node:fs";
import { buildPrompt } from "../server/worker.js";
import { compatRequest } from "../server/ai-providers/wires/compat.js";
import { PROVIDERS } from "../server/providers.js";

const model = process.argv[2] || "gpt-5.4-mini";
const key = process.env.OPENAI_KEY;
if (!key) throw new Error("OPENAI_KEY not set");

const board = JSON.parse(fs.readFileSync("scripts/logos-board.json", "utf8"));
const { systemText, schema } = buildPrompt(board.facets, board.context || "");
const parts = [{ kind: "text", text: "Tag this image using the record_tags tool." }];
const compat = PROVIDERS.openai.compat;

const neutralize = (s) =>
  s.replace(/reasoning sentence/g, "supporting note")
   .replace(/reasoning/g, "note")
   .replace(/justify|justifies|justifying/g, "support");
const neutralSchema = JSON.parse(neutralize(JSON.stringify(schema)));

const probes = {
  "A bare-hi": { model, max_completion_tokens: 16, messages: [{ role: "user", content: "Say hi" }] },
  "B real-request": compatRequest({ compat, model, systemText, schema, parts }),
  "C neutralized": compatRequest({ compat, model, systemText: neutralize(systemText), schema: neutralSchema, parts }),
};

for (const [name, body] of Object.entries(probes)) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const data = await r.json().catch(() => ({}));
  const verdict = r.ok
    ? `OK (finish=${data.choices?.[0]?.finish_reason}, tool=${data.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? "none"})`
    : `HTTP ${r.status}: ${data.error?.code ?? "?"} — ${String(data.error?.message ?? "").slice(0, 140)}`;
  console.log(`${name} [${model}] -> ${verdict}`);
}
