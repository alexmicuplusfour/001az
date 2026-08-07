// The tagging tool contract — protocol-neutral: both wire families present the
// same record_tags tool to their model; each maps it to its protocol's tool
// shape (Anthropic tool_use vs chat-completions function calling). Callers can
// override per call (extraction passes record_fields), so this is only the
// default.
const TOOL_NAME = "record_tags";
const TOOL_DESC = "Record the applicable taxonomy tags for this item.";
export const DEFAULT_TOOL = { name: TOOL_NAME, description: TOOL_DESC };

// The output ceiling for one tool call. A FAILSAFE, not a size estimate — the
// number exists to stop a runaway generation, and nothing else. Both wire
// families cap from here.
//
// It used to be sized per-schema (1024 + 128 per property, floor 2048) on the
// theory that property count proxies how much the model must write. It does
// proxy the VISIBLE answer — but that is the smaller half of the spend. A
// thinking model bills its reasoning against this same cap and shows none of it
// back. Measured 2026-08-07, gemini-3.5-flash on an 18-item 5-facet board:
// ~300 tokens of visible tool call against 780-1,920 of hidden thinking, i.e.
// 4-6x the ~40-70/facet the old formula was built on. Three items landed past
// 2,048 and failed; several more sat within 100 tokens of it. Sizing the cap to
// the part you can see is the wrong measurement, at any constant.
//
// Headroom is free: the same board re-measured at 8,192 thought exactly as much
// as it had at 2,048 (a model spends what the task needs, not what it is
// offered), and clipped nothing. 8,192 is also the largest value the old
// formula could already produce, so no provider is handed a cap it wasn't
// already expected to accept.
export const OUTPUT_BUDGET = 8192;

// The cap was hit AND cost us the answer — see each wire for why that is two
// conditions rather than one. Permanent-shaped (422): the same request re-clips
// deterministically, so a retry re-pays for the same failure — fail the item on
// attempt one with the real story (reprocess re-arms it after a config change).
// Without this the clip surfaces as "model did not call X" or a JSON parse
// error, and burns five paid attempts.
export function clippedError(cap) {
  const e = new Error(
    `model output hit the ${cap}-token cap before the tool call completed — hidden reasoning can consume it; try a non-reasoning model or fewer facets/fields`
  );
  e.status = 422;
  return e;
}
