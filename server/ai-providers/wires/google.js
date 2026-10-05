// The Google wire family: Gemini's NATIVE generateContent protocol, spoken
// when web research is on or a PDF file goes. Google's OpenAI-compat layer has
// no grounding for chat (probed 2026-09-04: every spelling 400s, and the doc
// tip claiming otherwise is image-generation-scoped), and takes no PDF (probed
// 2026-10-05: "Invalid content part type: file") — so those ride the native
// endpoint while everything else a descriptor does (plain tagging, embeddings,
// key tests, model listing/prices) delegates to the compat family unchanged.
// Everything Google-native-specific lives HERE; the engine (providers.js)
// composes this into WIRES and dispatches through descriptor.wire, never
// naming a vendor. googleRequest is exported as the pure request-builder test
// seam. Probe record: planning/gemini-research-plan.md.
import { DEFAULT_TOOL, OUTPUT_BUDGET, clippedError, wholeCall, providerError } from "./tool.js";
import { askFor, negotiate } from "./refusals.js";
import { compatWire, compatFetch, temperatureAsked, quirks, chatSignal } from "./compat.js";

// Research turns legitimately run minutes — searching, digesting, thinking —
// which is exactly why the Anthropic wire declines a short deadline and rides
// its SDK's 10-minute default. The native leg gets the same posture rather
// than inheriting the compat family's 3-minute plain-chat deadline; a hung
// call still can't wedge the worker's tick. Env-tunable, read per call. A
// plain call (a PDF file, no research) keeps the chat deadline, as a PDF on
// any other provider does.
const researchSignal = () => AbortSignal.timeout(Number(process.env.AI_RESEARCH_TIMEOUT_MS) || 600000);

// Native generateContent request. Three load-bearing choices, all measured
// live 2026-09-04 on gemini-3.5-flash:
// - include_server_side_tool_invocations unlocks built-in search COMBINED
//   with function calling (without it: a 400 naming this flag) and narrates
//   each executed search as a toolCall part — the meter's count.
// - mode ANY + allowed_function_names forces record_tags WITHOUT blocking the
//   search (toolCall → toolResponse → functionCall in one turn) — stronger
//   than the Anthropic wire, which must relax to auto and trust the finish.
//   Left AUTO, the model searches and then answers in prose, skipping the
//   tool.
// - parametersJsonSchema, not `parameters`: the classic field is a Schema
//   proto that 400s on the nested additionalProperties every board schema
//   carries; this one takes buildPrompt's schema byte-for-byte.
// Without `research` it's the plain form, for a PDF file on a board that
// doesn't research: the same call, minus the search and its flag. A PDF goes
// as inline data either way, so research never changes what a board sends.
export function googleRequest({ systemText, schema, parts, tool = DEFAULT_TOOL, temperature, research = false }) {
  const content = parts.map((p) =>
    p.kind === "image" || p.kind === "document" ? { inline_data: { mime_type: p.mediaType, data: p.b64 } } : { text: p.text }
  );
  return {
    system_instruction: { parts: [{ text: systemText }] },
    contents: [{ role: "user", parts: content }],
    tools: [
      ...(research ? [{ google_search: {} }] : []),
      { function_declarations: [{ name: tool.name, description: tool.description, parametersJsonSchema: schema }] },
    ],
    tool_config: {
      ...(research ? { include_server_side_tool_invocations: true } : {}),
      function_calling_config: { mode: "ANY", allowed_function_names: [tool.name] },
    },
    generation_config: {
      // A runaway guard, not a size estimate — see OUTPUT_BUDGET. Flat across
      // research for the same reason the Anthropic wire's cap is.
      maxOutputTokens: OUTPUT_BUDGET,
      ...(temperature !== undefined ? { temperature } : {}),
    },
  };
}

// A failed native response ({ error: { code, message, status, details } }).
// providerError (tool.js) carries the shared half — status, Retry-After
// header; the Google half reads RetryInfo from details (a "7s"-style string)
// when no header said it.
async function googleError(r, label) {
  const body = await r.json().catch(() => ({}));
  const e = body.error || {};
  const err = providerError(r, e.message || `${label} HTTP ${r.status}`);
  const retry = (e.details || []).find((d) => String(d["@type"] || "").endsWith("RetryInfo"))?.retryDelay;
  if (err.retryAfter == null && retry != null) err.retryAfter = String(retry).replace(/s$/, "");
  return accountGap(err);
}

// Depleted prepayment credits are the account's gap, not the item's —
// noCount rides failOrRequeue's missing-key lane: retry later, burn no
// attempt, never fail the row (2026-09-10: one night of this error marched
// every queued item to attempts 3 of the 5-attempt ceiling). Vendor string,
// so it lives in the vendor's wire, and reads the same on both legs: the
// OpenAI-style one, which most calls take, said nothing before (its errors
// came as a list the compat wire didn't read).
function accountGap(err) {
  if (/prepayment credits/i.test(err?.message || "")) {
    err.noCount = true;
    // Same pacing rule as the anthropic wire: without a vendor Retry-After,
    // noCount would retry on the 60s race arm — per-minute hammering for a
    // standing outage. 5 minutes between tries; a top-up drains within 5.
    err.retryAfter ??= 300;
  }
  return err;
}

async function nativeTag(desc, { apiKey, model, systemText, schema, parts, base, tool = DEFAULT_TOOL, research = false }) {
  // A connection's own `base` names the COMPAT endpoint (a self-hosted box, a
  // gateway) — the native protocol cannot be derived from it, and silently
  // shipping the key straight to desc.nativeBase would bypass the box the
  // admin pointed at. Refuse loudly instead, as with a descriptor that has no
  // native endpoint at all: research by name, and a PDF file as the provider
  // would refuse one (400), so the step sends its text. The PDF's reason is
  // read after "<label> refused the file:" on its job row.
  const why = !desc.nativeBase ? "none is declared (nativeBase)"
    : base && base !== desc.base ? "this connection's server URL can't reach it" : null;
  if (why) {
    if (research)
      throw new Error(`${desc.label}: web research goes through the provider's native endpoint, but ${why} — turn research off for this board${desc.nativeBase ? ", or use a connection without a server URL" : ""}`);
    throw Object.assign(new Error(`PDF files go through the provider's native endpoint, but ${why}`), { status: 400 });
  }
  const url = `${desc.nativeBase}/models/${encodeURIComponent(model)}:generateContent`;
  const q = quirks(desc);
  const send = (sent) => compatFetch(desc.label, url, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    // The temperature value comes from the descriptor's compat quirk block —
    // one measured choice per provider, not per protocol.
    body: JSON.stringify(googleRequest({ systemText, schema, parts, tool, research, temperature: sent.temperature ? q.temperature : undefined })),
    signal: research ? researchSignal() : chatSignal(),
  });
  // The refusal negotiation (negotiate in refusals.js), temperature only —
  // nothing strict-shaped is sent natively, and parseRun validates answers
  // downstream as always. Keyed on the native URL so a learned refusal never
  // bleeds between a provider's two endpoints.
  const r = await negotiate({
    sent: { temperature: askFor(url, model).temperature && temperatureAsked(q, model) },
    sendFromSent: send,
    errOf: (res) => googleError(res, desc.label),
    endpoint: url, model, label: desc.label,
  });
  const data = await r.json();
  const cand = data.candidates?.[0];
  // A safety-blocked prompt returns no candidates at all — name the reason,
  // or the jobs drill would misread it as the model skipping the tool.
  if (!cand) throw new Error(`${desc.label}: ${data.promptFeedback?.blockReason || "no candidates returned"}`);
  const returned = cand.content?.parts || [];
  const call = returned.find((p) => p.functionCall?.name === tool.name)?.functionCall;
  const input = call && typeof call.args === "object" && call.args !== null ? call.args : null;
  // The two-condition clip rule (wholeCall in tool.js): a MAX_TOKENS finish
  // with the call whole keeps the answer.
  if (!wholeCall(input, schema) && cand.finishReason === "MAX_TOKENS") throw clippedError(OUTPUT_BUDGET);
  if (!input) throw new Error(`model did not call ${tool.name}`);
  const u = data.usageMetadata || {};
  const cached = u.cachedContentTokenCount || 0;
  // Each executed search is a toolCall part carrying its queries — the
  // authoritative count, billed per query ($14/1k). groundingMetadata came
  // back NULL under forced ANY (measured), so it is only the fallback for
  // response shapes that omit the parts; a toolCall with no queries array
  // still counts once, so shape drift under-counts by degree rather than
  // silently billing $0.
  const searches = returned
    .filter((p) => p.toolCall?.toolType === "GOOGLE_SEARCH_WEB")
    .reduce((n, p) => n + (p.toolCall.args?.queries?.length || 1), 0)
    || (cand.groundingMetadata?.webSearchQueries?.length || 0);
  return {
    input,
    usage: {
      input: Math.max((u.promptTokenCount || 0) - cached, 0),
      // Thinking bills as output and is NOT inside candidatesTokenCount
      // (measured 2026-09-04: 274 prompt + 58 candidates + 467 thoughts = 799
      // total) — the same fold the compat wire does from the other side of
      // the fence, where completion_tokens hides thoughts in total_tokens.
      output: Math.max(
        (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
        (u.totalTokenCount || 0) - (u.promptTokenCount || 0)
      ),
      cacheRead: cached,
      searches,
    },
  };
}

// Everything research and PDF files don't touch rides compat byte-identically
// — the engine already gates on `research && desc.research` (callTagger), so
// the flag arriving true is the descriptor's own declaration, and a step sends
// a PDF file only where the descriptor declares `documents` (worker.js
// pdfRoute). Only its errors are read again, for an empty account.
export const googleWire = {
  ...compatWire,
  tag: (desc, opts) => (opts.research || opts.parts.some((p) => p.kind === "document")
    ? nativeTag(desc, opts) : compatWire.tag(desc, opts).catch((e) => { throw accountGap(e); })),
};
