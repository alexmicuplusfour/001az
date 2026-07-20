// The tagging tool contract — protocol-neutral: both wire families present the
// same record_tags tool to their model; each maps it to its protocol's tool
// shape (Anthropic tool_use vs chat-completions function calling). Callers can
// override per call (extraction passes record_fields), so this is only the
// default.
const TOOL_NAME = "record_tags";
const TOOL_DESC = "Record the applicable taxonomy tags for this item.";
export const DEFAULT_TOOL = { name: TOOL_NAME, description: TOOL_DESC };
