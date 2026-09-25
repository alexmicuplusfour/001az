// The plugin ctx: the whole surface the app hands a plugin's factory,
// `export default (ctx) => …`. The built-in data providers (connectors/crypto,
// connectors/stocks) are written against exactly this object, which is what
// makes one of those files, copied verbatim into a plugin directory, a working
// plugin — and what keeps this list the real contract rather than a document
// about one (planning/plugin-contract-plan.md, Stage 1).
//
// Per-call context rides the per-call arguments, never ctx: the runtime calls
// provider.search(q, { apiKey, pace }), where `pace` is the provider's token
// bucket for that one call.
//
// Imported by the loader and by the built-in domains, never by the AI engine:
// a built-in AI factory is handed only { wires }, which is all it reads, so
// providers.js stays clear of the connector runtime this module pulls in.
import * as series from "./connectors/chart-series.js";
import { providerSignal, providerBudgetMs, num } from "./connectors/runtime.js";
import { createQuoteCache, pickFields } from "./connectors/quote-cache.js";
import { renderChart } from "./faces/price-chart.js";
import { WIRES } from "./ai-providers/wires/index.js";
import { providerError } from "./ai-providers/wires/tool.js";

// The contract version. A plugin's manifest.apiVersion major must equal this;
// bump only on a breaking change to the manifest / ctx / return shapes.
export const PLUGIN_API_VERSION = 1;

// The URL an error names: without its query string, where an API key passed as
// `?apikey=` rides. The message reaches the health ledger, the admin's error
// banner, and — through a failed browse — any member of the board
// (plugin-contract-plan.md, Stage 5).
const shownUrl = (url) => {
  try { const u = new URL(url); return u.origin + u.pathname; }
  catch { return String(url).split(/[?#]/)[0]; }
};

// The short way for a plugin to hit the network: fetch with the error shape the
// runtime's retry protocol reads (the AI wires' providerError), so a 429/401
// with Retry-After backs off instead of bubbling as a dead error. A caller may
// pass its own signal; otherwise the standard outbound deadline applies.
async function fetchJson(url, { signal, ...opts } = {}) {
  const r = await fetch(url, { ...opts, signal: signal ?? providerSignal() });
  if (!r.ok) throw providerError(r, `HTTP ${r.status} for ${shownUrl(url)}`);
  return r.json();
}

export const makeCtx = (manifest) => ({
  apiVersion: PLUGIN_API_VERSION,
  fetchJson,
  // The shared AI wire families ({ anthropic, compat, google }). An ai-provider
  // on a known protocol returns `wire: ctx.wires.compat` and brings only its
  // descriptor (base + `compat` quirks + model catalog) — the protocol code
  // stays in core, one copy.
  wires: WIRES,
  renderChart, // face rendering, for connector plugins that ship a chart face
  log: (...a) => console.log(`[plugin ${manifest.id}]`, ...a),
  // What a data provider needs to be written the way the built-ins are: the
  // outbound deadline per call class (pass "bulk" for a slow bulk endpoint),
  // the finite-number coercion every market API needs, the chart-series shaping
  // and the `unsupported` refusal the live chart learns from, and the quote
  // cache that turns a refresh sweep into one batched request.
  providerSignal,
  providerBudgetMs,
  num,
  series,
  createQuoteCache,
  pickFields,
});
