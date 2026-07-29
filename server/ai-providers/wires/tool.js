// The tagging tool contract — protocol-neutral: both wire families present the
// same record_tags tool to their model; each maps it to its protocol's tool
// shape (Anthropic tool_use vs chat-completions function calling). Callers can
// override per call (extraction passes record_fields), so this is only the
// default.
const TOOL_NAME = "record_tags";
const TOOL_DESC = "Record the applicable taxonomy tags for this item.";
export const DEFAULT_TOOL = { name: TOOL_NAME, description: TOOL_DESC };

// Output budget for one tool call, sized to the ask: the schema's property
// count is the honest proxy for how much the model must write (reasoning mode
// runs ~40-70 output tokens per facet/field). A ceiling, not a spend —
// headroom is free unless used — and reasoning models (the gpt-5 family) burn
// invisible thinking tokens from this same budget, so the floor stays
// generous. Research keeps a higher floor: searching + digesting results eats
// output too. Both wire families size from here.
export function outputBudget(schema, research = false) {
  const props = Object.keys(schema?.properties || {}).length;
  return Math.max(research ? 4096 : 2048, Math.min(1024 + 128 * props, 8192));
}

// The output cap was hit before the tool call finished. Permanent-shaped
// (422): the same request re-clips deterministically, so a retry re-pays for
// the same failure — fail the item on attempt one with the real story
// (reprocess re-arms it after a config change). Without this check the clip
// surfaces as "model did not call X" or a JSON parse error, and burns five
// paid attempts.
export function clippedError(cap) {
  const e = new Error(
    `model output hit the ${cap}-token cap before the tool call completed — hidden reasoning can consume it; try a non-reasoning model or fewer facets/fields`
  );
  e.status = 422;
  return e;
}
