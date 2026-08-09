// The capability registry (capabilities-plan.md, slices 1–2).
//
// A CAPABILITY is what the app can do (tag, extract, embed, transcribe, detect),
// as opposed to a PROVIDER (who can do it) or a PLUGIN (the install unit). It
// used to exist only as a naming convention repeated once per capability across
// ~12 sites, which is how `detect` came to be missed by BOTH cleanup loops —
// deleteAiKey and cleanupPluginConfig each iterate the capabilities by hand and
// each stops at three.
//
// This file is that list, once. It is PURE DATA — no imports, so anything may
// read it. Resolution over it lives in ./capability-resolve.js; the engines that
// actually make the call live where their protocol lives (worker.js for the
// sidecars, the wires for everything else).
//
// The rule this file exists to enforce: NO consumer may name a capability. They
// iterate this table instead — which is what makes "adding a capability is one
// entry" true in code rather than in prose.
//
// Fields:
//   noun        what to call it mid-sentence in an error the admin will read
//               ("anthropic advertises no object detection"). `label` titles a
//               card; `noun` goes inside prose.
//   declaredBy  which capability's `provides` entry advertises this one. Almost
//               always itself; `extract` rides tagging's declaration and wire.
//   verb        the wire method that performs it.
//   models      has a model axis (a picker, a live-list catalog).
//   binding     where the admin's choice is STORED. `keys` is the global
//               settings namespace, `boardKeys` the per-board columns. Both are
//               enumerated by the cleanup loops, so a capability cannot be
//               forgotten by one of them.
//   env         an extra binding rung reading a server-held secret.
//   floor       what happens with no usable binding — see FLOORS below.
//   modifierOf  a qualifier on another capability, not a slot of its own.

// The floor kinds, all five of which exist in the tree today:
//   builtin   a registered provider with no wire; the engine is the sidecar
//             adapter. Resolution NEVER fails.        (transcribe, detect)
//   off       resolves to nothing until an enable flag is set.        (embed)
//   blocked   resolves to nothing and work waits unserved — the queue requeues
//             via noKeyError's noCount rather than failing.             (tag)
//   delegate  falls back to another capability's binding.          (extract)
//   sibling   scan for any installed provider before giving up. Connector
//             domains do this today in connectors/runtime.js activeProvider;
//             no AI capability uses it yet.
export const CAPABILITY_DEFS = [
  {
    id: "tag",
    agent: "tagger",
    noun: "tagging",
    label: "Tagging",
    blurb: "labels an item against its board's own facet taxonomy",
    declaredBy: "tag", verb: "tag", models: true,
    // Tagging with no declared filter shows the whole live list — a provider may
    // be all-chat, so an unfiltered dump is the right answer here, while the same
    // dump in the embedder picker would be worse than hardcoding. Capability
    // policy, not something a provider declares.
    unfilteredShowsAll: true,
    binding: {
      // No `provider` key: there is no on-device tagger, so the provider is
      // always implied by the connection row. `model` carries no `tag_` prefix —
      // it predates the rest and the env rung below reads it too.
      keys: { provider: null, keyId: "default_key_id", model: "model", enabled: null },
      boardKeys: { keyId: "ai_key_id", model: "ai_model" },
    },
    // The legacy rung: a key the SERVER holds rather than a stored row. Still
    // gated on the provider's plugin being installed.
    env: { secret: "ANTHROPIC_API_KEY", provider: "anthropic", model: "MODEL" },
    floor: { kind: "blocked" },
  },
  {
    id: "extract",
    agent: "extractor",
    noun: "field extraction",
    label: "Field extraction",
    blurb: "reads a board's structured fields out of an item",
    // Extraction rides the TAGGING declaration and wire (text-only), so it is a
    // distinct capability sharing a wire — which is why `declaredBy` is a field
    // rather than just the id.
    declaredBy: "tag", verb: "tag", models: false,
    // Board-scoped only: no global default exists today. The keys are declared
    // so the cleanup loops reach them; resolution stays per-board (slice 5).
    binding: { keys: null, boardKeys: { keyId: "extract_key_id", model: "extract_model" } },
    floor: { kind: "delegate", to: "tag" },
  },
  {
    id: "embed",
    agent: "embedder",
    noun: "embeddings",
    label: "Semantic search",
    blurb: "embeds items so search can rank them by meaning",
    declaredBy: "embed", verb: "embed", models: true,
    binding: { keys: { provider: "embed_provider", keyId: "embed_key_id", model: "embed_model", enabled: "embed_enabled" }, boardKeys: null },
    floor: { kind: "off" },
    // The UI confirms before re-binding the model while enabled: vectors only
    // compare within a model, so a model change re-embeds the whole collection.
    // Copy lives here as data — the generic section renders a confirm for any
    // capability that declares one, and knows nothing about embeddings.
    rebindWarning: "Changing the embedding model re-embeds every item (costs cents, takes a while). Continue?",
  },
  {
    id: "transcribe",
    agent: "transcriber",
    noun: "transcription",
    label: "Transcription",
    blurb: "turns audio into text so recordings can be tagged and searched",
    declaredBy: "transcribe", verb: "transcribe", models: true,
    // A pinned model must be one the provider advertises: otherwise every call
    // throws at the wire and the item requeues for ever. Only these two check —
    // tagging and embeddings accept any id, because live model lists mean the
    // curated catalog is a recommendation, not the set that exists.
    pinnedModelMustBeAdvertised: true,
    binding: { keys: { provider: "transcribe_provider", keyId: "transcribe_key_id", model: "transcribe_model", enabled: null }, boardKeys: null },
    // `whisper` is a REGISTERED provider that advertises transcription with no
    // wire — so the old `provider !== "whisper"` sentinel is gone: resolution
    // simply lands on it, and the engine is the sidecar adapter because that
    // provider has no wire.transcribe, not because of what it is called.
    floor: { kind: "builtin", provider: "whisper" },
  },
  {
    id: "detect",
    agent: "detector",
    noun: "object detection",
    label: "Object detection",
    blurb: "finds objects in an image so items can be searched by what is in them",
    declaredBy: "detect", verb: "detect", models: true,
    // A pinned model must be one the provider advertises: otherwise every call
    // throws at the wire and the item requeues for ever. Only these two check —
    // tagging and embeddings accept any id, because live model lists mean the
    // curated catalog is a recommendation, not the set that exists.
    pinnedModelMustBeAdvertised: true,
    binding: {
      keys: { provider: "detect_provider", keyId: "detect_key_id", model: "detect_model", enabled: null },
      boardKeys: null,
      // Capability-level knobs: settings that belong to the capability rather
      // than to whichever provider happens to serve it.
      config: [{ key: "detect_threshold", default: 0.3 }],
    },
    floor: { kind: "builtin", provider: "localDetector" },
  },
  {
    id: "research",
    noun: "web research",
    label: "Web research",
    blurb: "lets the tagger search the web before it answers",
    // A MODIFIER, not a slot: nothing binds it, it has no model axis, and it
    // renders inside the tagging card. It appears here because a provider
    // DECLARES it, and because leaving it out would mean two lists again.
    declaredBy: "research", verb: null, models: false,
    modifierOf: "tag",
    binding: { keys: null, boardKeys: null },
    floor: null,
  },
];

export const CAPABILITY = Object.fromEntries(CAPABILITY_DEFS.map((c) => [c.id, c]));

// Every settings key holding a capability's stored binding. The cleanup paths
// (a deleted key row in db.js, an uninstalled plugin in plugin-loader.js) clear
// the WHOLE namespace through this rather than a hand-picked subset — which is
// both what they each got wrong for `detect`, and what left tagging's shared
// `model` behind pointing at a deleted key's provider.
//
// Lives here, in the data module, because both callers own their own setSetting
// and neither may import a module that imports db.js.
export const bindingSettings = (cap) => {
  const k = cap.binding.keys;
  return k ? [k.provider, k.keyId, k.model, k.enabled].filter(Boolean) : [];
};

// What a PROVIDER can declare in `provides` — every capability that carries its
// own declaration. `extract` is excluded: it advertises nothing of its own, it
// reads tagging's. This is the list the per-provider capability flags iterate,
// so it must stay exactly the declarable set.
export const CAPABILITY_IDS = CAPABILITY_DEFS.filter((c) => c.declaredBy === c.id).map((c) => c.id);

// …and the subset with a model axis, i.e. what the per-connection model listing
// (/api/admin/ai-keys/:id/models) can be asked about.
export const MODEL_CAPABILITIES = CAPABILITY_DEFS.filter((c) => c.models).map((c) => c.id);

// capability id -> the wire method the PLUGIN LOADER requires to back it.
//
// NOTE 1: this is a plugin rule, not a universal invariant. The built-in whisper
// and localDetector descriptors advertise a capability with `wire: null` — they
// are sidecar-backed and their HTTP call is assembled in worker.js. Never hoist
// this check into providers.js install().
//
// NOTE 2: deliberately NOT derived from the `verb` fields above, and narrower
// than they are. `tag` is absent because it is declared BY wire.tag existing
// (the check would be circular), `research` because it is a flag on the tagging
// call rather than a call of its own, and `embed` because the loader has never
// required wire.embed — test/fixtures/plugins/acme-embed declares `embeds` with
// wire null, is asserted to load, and would throw at the first embedTexts call.
// Closing that changes what the loader accepts; it waits for the slice where
// that is in scope.
export const WIRE_VERB = { transcribe: "transcribe", detect: "detect" };
