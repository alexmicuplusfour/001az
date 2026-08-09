// The capability registry — SEED (capabilities-plan.md, slice 1).
//
// A CAPABILITY is what the app can do (tag, embed, transcribe, detect), as
// opposed to a PROVIDER (who can do it) or a PLUGIN (the install unit). Today
// that concept exists only as a naming convention repeated once per capability
// across ~12 sites; this file is where it becomes a thing with a name.
//
// Slice 1 seeds it with the ids and the per-capability CATALOG policy only —
// enough to de-duplicate the model-catalog table and the capability flags,
// without moving any resolution logic. Slice 2 grows this same file into the
// full CAPABILITY_DEFS descriptor table (supply/binding/floor/demand) and every
// consumer keeps reading through the names below, so nothing downstream changes
// again.
//
// The rule this file exists to enforce: NO consumer may name a capability. They
// iterate these lists instead — which is what makes "adding a capability is one
// entry" true in code rather than in prose.

// Every capability a provider can DECLARE, in display order. `research` is a
// modifier on tagging (no model axis, no binding of its own), not a slot — it
// lives here because a provider declares it, and slice 2's descriptor table is
// where that distinction gets encoded.
export const CAPABILITY_IDS = ["tag", "embed", "transcribe", "detect", "research"];

// The subset that has a MODEL axis, i.e. that the per-connection model listing
// (/api/admin/ai-keys/:id/models) can be asked about. `research` has none.
export const MODEL_CAPABILITIES = ["tag", "embed", "transcribe", "detect"];

// Per-capability CATALOG policy — how the live model list from a provider's own
// /models endpoint is carved for this capability's picker.
//
// `unfilteredShowsAll`: with no declared filter, show the whole live list rather
// than staying on the curated one. True for tagging alone: a provider may be
// all-chat, so an unfiltered dump is the right answer there — while an
// unfiltered dump into the EMBEDDER picker would be worse than hardcoding
// (that's the `always` flag KIND_CATALOG used to carry inline).
//
// This is capability policy, not a provider declaration: it belongs to "what
// tagging is", not to "what OpenAI supports".
export const CATALOG_POLICY = {
  tag: { unfilteredShowsAll: true },
};

// capability id -> the wire method that must back it. Absent = the loader does
// not require a wire for this capability. Used by the plugin loader to check
// that an advertised capability is real.
//
// NOTE 1: this is a PLUGIN rule, not a universal invariant. The built-in whisper
// and localDetector descriptors advertise a capability with `wire: null` — they
// are sidecar-backed and their HTTP call is assembled in worker.js. Never hoist
// this check into providers.js install().
//
// NOTE 2: `tag` is absent because it is declared BY wire.tag existing (the check
// would be circular), and `research` because it is a flag on the tagging call,
// not a call of its own.
//
// NOTE 3: `embed` is absent because the loader has never required wire.embed,
// and slice 1 is a no-behaviour-change slice. That is a real hole, not a
// deliberate exemption: test/fixtures/plugins/acme-embed declares `embeds` with
// `wire: null` and loads happily, then throws at the first embedTexts call
// (`desc.wire.embed` on null). Its comment claims it mirrors the built-in
// `local` provider, but local carries a real `wire.embed` — the fixture does
// not. Closing this means changing what the loader accepts, so it belongs to
// slice 2 along with the emptiness rule in validateBuilt.
export const WIRE_VERB = { transcribe: "transcribe", detect: "detect" };
