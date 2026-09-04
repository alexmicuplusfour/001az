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
//             adapter. Resolves whenever that engine is actually on this host
//             — a sidecar-backed built-in (one whose descriptor declares
//             `liveCatalog`, the address its /health answers on) is only a
//             floor where its sidecar runs, and a slim install may deploy
//             without one. Absent, it resolves to NOTHING and the capability
//             behaves as `blocked`: work waits, it is never failed. Presence
//             is a runtime fact about the PROVIDER, so it is asked of the
//             descriptor at resolution (capability-resolve.js) rather than
//             declared as a second truth here.        (transcribe, detect)
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
      // Capability-level knob (ai-image-input-plan.md): the image detail sent
      // to the tagger — a PRESET id, not pixels. The vocabulary + admin copy
      // live here (this file is pure data the UI reads; copy-as-data is the
      // rebindWarning precedent); the numbers each id maps to live in
      // ai-image.js IMAGE_PRESETS, and a drift-pin test holds the two equal.
      //
      // `boardColumn` makes it board-scopable: a NULL column falls to the
      // `key` setting above. It lives here rather than as a fourth boardKeys
      // field on purpose — boardKeys' three names carry PIN semantics (the
      // provider-XOR-keyId rule, countBoardOverrides, and the cleanup loops
      // that clear a deleted key's pins). Config is exactly what those loops
      // must never touch, and a preset id has nothing to dangle.
      config: [{
        key: "tag_image_preset", boardColumn: "tag_image_preset", default: "high", kind: "enum",
        label: "Image size sent to the model",
        // ONE hint for the field, not one per option, and deliberately the
        // whole story: the options are ordered cheapest-first, so the only
        // thing copy has to add is which way the bill moves. Per-option hints
        // were worse three ways — they claimed multipliers ("≈5×") nobody has
        // measured (providers tokenize images differently, and the ratio moves
        // with the source image), they guessed at what each rung would do to
        // YOUR material, and a hint that changes with the selection is a hint
        // that can go stale. A fixed line cannot.
        hint: "larger images cost more tokens",
        // The short name for the board modal's collapsed Advanced summary,
        // which lists what a board has CHANGED ("… · image size: Standard").
        // Separate copy from `label` because that line carries three or four
        // of these and a full sentence would swamp it — and it lives here, as
        // data, so a second board-scoped knob names itself instead of
        // inheriting whatever the first one hardcoded.
        chip: "image size",
        options: [
          { value: "thumb", label: "Thumbnail" },
          { value: "standard", label: "Standard" },
          { value: "high", label: "High" },
          { value: "max", label: "Provider max" },
        ],
      }],
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
    // Both scopes (slice 5): a board's own pick wins, then the app-wide default,
    // then the delegate floor (the tagger's chain). The global settings reuse
    // the board columns' names — same strings, two stores, which is already the
    // arrangement transcribe has in the other direction. No provider setting:
    // like tagging, the connection row implies the provider, and the model is
    // deliberately unvalidated (extraction rides the tagging wire and its live
    // model lists).
    binding: {
      keys: { provider: null, keyId: "extract_key_id", model: "extract_model", enabled: null },
      boardKeys: { keyId: "extract_key_id", model: "extract_model" },
    },
    // Presentation, not resolution: this capability's picker lives in the board
    // modal's AI-models strip like every other, but the Mapping pane surfaces
    // its provenance ("Using <model>") beside the AI fields it powers — and the
    // Tagging pane's band finds the tagger through this capability's
    // delegatesTo. Data, not a name check in the client.
    mappingBand: true,
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
    binding: {
      keys: { provider: "transcribe_provider", keyId: "transcribe_key_id", model: "transcribe_model", enabled: null },
      // The first boardKeys with a provider column: a board pin of the built-in
      // ("this board uses Whisper while the app default is paid") names an
      // engine with no key row, which a key pointer cannot express. provider
      // XOR keyId — the write path enforces it, and it is what keeps cleanup
      // coherent (a deleted key FK-NULLs keyId and the loop clears model; a
      // provider pin has no key to lose).
      boardKeys: { provider: "transcribe_provider", keyId: "transcribe_key_id", model: "transcribe_model" },
    },
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
    // The Mapping pane surfaces this capability's provenance beside the detect
    // fields it powers — same flag, same consumer as extract's band. Data, not
    // a name check in the client (field-sources.js `capability` is the join).
    mappingBand: true,
    // A pinned model must be one the provider advertises: otherwise every call
    // throws at the wire and the item requeues for ever. Only these two check —
    // tagging and embeddings accept any id, because live model lists mean the
    // curated catalog is a recommendation, not the set that exists.
    pinnedModelMustBeAdvertised: true,
    binding: {
      keys: { provider: "detect_provider", keyId: "detect_key_id", model: "detect_model", enabled: null },
      // provider XOR keyId, same as transcribe's — see the comment there.
      boardKeys: { provider: "detect_provider", keyId: "detect_key_id", model: "detect_model" },
      // Capability-level knobs: settings that belong to the capability rather
      // than to whichever provider happens to serve it. Deliberately global,
      // never per-board — the threshold belongs to detection itself.
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
// ONE wire shape for a capability-level knob, with its effective value. Two
// projections need it — the admin capabilities feed (capability-status.js) and
// the board settings payload (capability-resolve.js boardConfigCatalog), which
// exists because a board MANAGER may set a knob and cannot read admin feeds.
// Shared so the two can't drift on field names; the client's planBoardConfig
// takes either one unchanged.
//
// Conditional spreads are load-bearing: a def that declares no kind/label/
// options/boardColumn must still project as exactly { key, value } (detect's
// threshold, whose payload shape is pinned by test).
export const configFieldView = (f, value) => ({
  key: f.key,
  value,
  ...(f.kind ? { kind: f.kind } : {}),
  ...(f.label ? { label: f.label } : {}),
  ...(f.hint ? { hint: f.hint } : {}),
  ...(f.chip ? { chip: f.chip } : {}),
  ...(f.options ? { options: f.options } : {}),
  ...(f.boardColumn ? { boardColumn: f.boardColumn } : {}),
});

export const bindingSettings = (cap) => {
  const k = cap.binding.keys;
  return k ? [k.provider, k.keyId, k.model, k.enabled].filter(Boolean) : [];
};

// --- the work-kind vocabulary (job_log.kind; metering-plan.md Stage 4) ---
// Every kind of work the app logs, in the jobs modal's pill order, with its
// display label and the capability its PAID legs meter as. The two vocabularies
// are linked, not equal: a retag SWEEP logs kind='retag' while the item legs it
// queues meter capability='tag', and `null` means this kind spends nothing
// itself (ingest enumerates, refresh moves values, face draws — none is a paid
// model call). This list is what replaces the client's hardcoded KIND_LABELS:
// the routes serve it and the client renders what it is handed, so a plugin or
// a new sweep appears with its own name instead of a bare id (the units.js
// rule, applied to work).
//
// Labels are the WORK's names, deliberately distinct from CAPABILITY_DEFS'
// feature names where they differ — an embed run is "Embedding" in a job list
// even though the capability card is "Semantic search". Same id, two surfaces,
// each speaking its own language; the id is the join.
export const KIND_DEFS = [
  { id: "transcribe", label: "Transcription", capability: "transcribe" },
  { id: "ingest", label: "Ingestion", capability: null },
  { id: "fetch", label: "Data fetch", capability: null },
  { id: "tag", label: "Tagging", capability: "tag" },
  { id: "extract", label: "Extraction", capability: "extract" },
  { id: "face", label: "Chart", capability: null },
  { id: "retag", label: "Retag pass", capability: "tag" },
  { id: "cancel", label: "Cancel", capability: null },
  { id: "embed", label: "Embedding", capability: "embed" },
  { id: "refresh", label: "Refresh", capability: null },
  { id: "diagnose", label: "Facet review", capability: "diagnose" },
];

// A capability id as prose, for usage breakdowns: the kind that IS the
// capability names it ("Tagging"); a capability with no job kind of its own
// (detect — it runs inside extract legs) falls back to its CAPABILITY_DEFS
// label, and an id neither knows renders as itself — a plugin may meter any
// capability string it likes, and an unknown one degrades to its id rather
// than being dropped.
const kindDef = (id) => KIND_DEFS.find((k) => k.id === id);

// Work the app spends on that is neither a job kind nor an AI capability: the
// connector runtime's outbound requests, which burn a data provider's request
// QUOTA rather than dollars. It is named here and not in CAPABILITY_DEFS on
// purpose — that table means "something a provider can be bound to serve", so
// every entry needs a wire verb, a binding and a floor, and the cleanup loops
// iterate it. An entry with none of those would be a permanent exception in
// each of them, which is exactly how `detect` came to be missed by both.
// Naming is a smaller job than that table does, so it gets a smaller table.
const WORK_LABELS = { api: "API" };

export const capabilityLabel = (id) =>
  kindDef(id)?.label ?? CAPABILITY[id]?.label ?? WORK_LABELS[id] ?? id;

// The kind vocabulary as it goes over the wire: id + label, no `capability`.
// ONE projection for every route that serves it, so two surfaces can't ship
// two shapes of one vocabulary — the reason configFieldView exists above. The
// join column stays server-side: which capability a kind's legs meter as is
// how the drill-down joins, not something a client should recompute.
export const kindList = () => KIND_DEFS.map(({ id, label }) => ({ id, label }));

// What a KIND's paid legs meter as — the spenders' read of the join column
// above. Every meter call site derives its capability through here rather
// than restating the string, which is what makes the table the single source
// instead of a parallel claim nothing checks: a kind whose legs bill as an
// existing capability states that fact once, and the meter and the labels
// both follow. A kind the table doesn't know (or one declared to spend
// nothing) degrades to metering under its own id — visible and labelled by
// the capabilityLabel fallback, never blocked.
export const meterAs = (kind) => kindDef(kind)?.capability ?? kind;

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
// (the check would be circular), and `research` because it is a flag on the
// tagging call rather than a call of its own. `embed` joined in slice 7a: the
// loader historically never required wire.embed, so an embed advertiser with
// wire null loaded and then threw at the first embedTexts call.
export const WIRE_VERB = { embed: "embed", transcribe: "transcribe", detect: "detect" };
