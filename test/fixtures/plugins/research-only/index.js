// Fixture: declares ONLY `research` — a modifier on tagging, not a capability of
// its own. A provider that can research but serve nothing qualifies a tagger it
// doesn't have. The legacy emptiness check rejected this by accident (research
// was never in its disjunction); the provides-based rule rejects it on purpose,
// by requiring at least one NON-MODIFIER capability.
export default function () {
  return { label: "Research Only", wire: null, keyless: true, research: true };
}
