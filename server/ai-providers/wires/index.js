// The shared wire families, keyed by name — the protocols the app speaks
// (anthropic: SDK + tool_use blocks + server-side web_search; compat: plain
// fetch to OpenAI-style /chat/completions). This barrel is the ONE place the
// family roster is named: the engine (providers.js) re-exports it as WIRES,
// descriptor factories receive it, and plugins get it as ctx.wires
// (plugin-loader.js) — so a provider on a known protocol references a family
// instead of reimplementing it, and a bug fix to a wire reaches every provider
// riding it from one spot. Adding a protocol family = one module here + one
// entry below.
import { anthropicWire } from "./anthropic.js";
import { compatWire } from "./compat.js";

export const WIRES = { anthropic: anthropicWire, compat: compatWire };
