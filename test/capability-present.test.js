// The capabilities page's pure presenter (public/capability-present.js) — the
// state → card mapping, tested the det-geometry way: no DOM, no server, just
// payload shapes in and card copy out. The shapes here mirror what
// capabilities.test.js proves the server actually emits.
import test from "node:test";
import assert from "node:assert/strict";
import { presentChip, presentLines, presentSupported, configureTarget, planSection, planBoardPicker, planBoardConfig, fmtProgress, servingRoles, roleBadge, keyRoles, removalStory, isDelegating } from "../public/capability-present.js";

const supported = [
  { name: "openai", label: "OpenAI", installed: true, keyCount: 1, onDevice: false, keyless: false },
  { name: "whisper", label: "Local Transcriber (Whisper)", installed: true, keyCount: 0, onDevice: true, keyless: true },
];

test("chips: the five states, and active splits on who is serving", () => {
  assert.deepEqual(presentChip({ state: "active", viaFloor: false }), { cls: "ok", text: "active" });
  assert.deepEqual(presentChip({ state: "active", viaFloor: true }), { cls: "ok", text: "active · built-in" });
  assert.deepEqual(presentChip({ state: "degraded" }), { cls: "warn", text: "degraded" });
  assert.deepEqual(presentChip({ state: "blocked" }), { cls: "warn", text: "needs a key" });
  assert.deepEqual(presentChip({ state: "off" }), { cls: "dim", text: "off" });
  assert.deepEqual(presentChip({ state: "unavailable" }), { cls: "dim", text: "unavailable" });
});

test("a healthy binding says one thing, not four — Configured only renders when it differs from Running", () => {
  const lines = presentLines({
    state: "active", viaFloor: false,
    bound: { provider: "openai", keyId: 3, model: "whisper-1" },
    running: { provider: "openai", model: "whisper-1", keyId: 3 },
    supportedBy: supported,
  });
  assert.deepEqual(lines.map((l) => l.k), ["Running"]);
  assert.equal(lines[0].v, "OpenAI · whisper-1");
});

test("degraded shows the dead choice, what took over, and why — labels resolved from the entry's own roster", () => {
  const lines = presentLines({
    state: "degraded", viaFloor: true,
    bound: { provider: "openai", keyId: 3, model: "whisper-1" },
    running: { provider: "whisper", model: "large-v3", keyId: null },
    reason: "OpenAI is removed on the Plugins page",
    supportedBy: supported,
  });
  assert.deepEqual(lines, [
    { k: "Configured", v: "OpenAI · whisper-1" },
    { k: "Running", v: "Local Transcriber (Whisper) · large-v3 — built-in, always on" },
    { k: "Why", v: "OpenAI is removed on the Plugins page" },
  ]);
});

test("the env rung names itself, blocked counts its queue, delegation and overrides read as prose", () => {
  const env = presentLines({
    state: "degraded",
    bound: { provider: "openai", keyId: 3, model: null },
    running: { provider: "anthropic", model: "claude-haiku-4-5", keyId: "env" },
    reason: "OpenAI is removed on the Plugins page",
    supportedBy: [{ name: "anthropic", label: "Anthropic", installed: true, keyCount: 0 }, ...supported],
  });
  assert.ok(env.find((l) => l.k === "Running").v.endsWith("— via the server's env key"));

  const blocked = presentLines({ state: "blocked", demand: { waiting: 14 }, supportedBy: [] });
  assert.deepEqual(blocked, [{ k: "Waiting", v: "14 items" }]);
  assert.equal(presentLines({ state: "blocked", demand: { waiting: 1 }, supportedBy: [] })[0].v, "1 item");

  const extract = presentLines({ state: "blocked", delegatesTo: "tag", delegatesToAgent: "tagger", boardOverrides: 2, supportedBy: [] });
  assert.deepEqual(extract, [
    { k: "Uses", v: "each board's tagger" },
    { k: "Overrides", v: "2 boards pin their own" },
  ]);
});

test("modifiers ride the parent's card and say whether the current provider carries them", () => {
  const mod = { id: "research", label: "Web research", supportedBy: ["anthropic"], availableNow: false };
  const lines = presentLines({ state: "active", running: { provider: "openai" }, supportedBy: supported, modifiers: [mod] });
  assert.deepEqual(lines[lines.length - 1], { k: "Web research", v: "needs anthropic" });
  const now = presentLines({ state: "active", running: { provider: "openai" }, supportedBy: supported, modifiers: [{ ...mod, availableNow: true }] });
  assert.equal(now[now.length - 1].v, "available with the current provider");
});

test("roster chips: the one fact that says how far a provider is from serving", () => {
  assert.deepEqual(presentSupported({ name: "x", label: "X", installed: false }), { text: "X — not added", dim: true, link: true });
  assert.equal(presentSupported({ name: "w", label: "W", installed: true, onDevice: true }).text, "W — built-in");
  assert.deepEqual(presentSupported({ name: "o", label: "O", installed: true, keyless: false, keyCount: 0 }).warn, true);
  assert.equal(presentSupported({ name: "o", label: "O", installed: true, keyless: false, keyCount: 2 }).text, "O");
  // keyless-NETWORKED still needs its connection row (that's where the server
  // URL lives) — zero rows warns with the right noun.
  assert.equal(presentSupported({ name: "ol", label: "Ollama", installed: true, keyless: true, keyCount: 0 }).text, "Ollama — no connection yet");
  // connector providers speak key presence as a boolean
  assert.equal(presentSupported({ name: "fmp", label: "FMP", installed: true, needsKey: true, hasKey: false }).text, "FMP — no key yet");
  assert.equal(presentSupported({ name: "cg", label: "CoinGecko", installed: true, needsKey: false, hasKey: false }).text, "CoinGecko");
});

test("Configure opens what a reader would: running, else configured, else the floor", () => {
  assert.equal(configureTarget({ running: { provider: "a" }, bound: { provider: "b" }, floor: { provider: "c" } }), "a");
  assert.equal(configureTarget({ running: null, bound: { provider: "b" }, floor: { provider: "c" } }), "b");
  assert.equal(configureTarget({ running: null, bound: null, floor: { kind: "builtin", provider: "c" } }), "c");
  assert.equal(configureTarget({ running: null, bound: null, floor: { kind: "blocked" } }), null);
});

// --- planSection: the modal's variation table, one row per old hand-written
// difference. The payload closures are the point — a wrong body here writes a
// wrong binding server-side (their server halves live in capabilities.test.js).

const tagCap = {
  id: "tag", label: "Tagging", noun: "tagging", agent: "tagger", declaredBy: "tag",
  binding: { provider: false, enable: false }, floor: { kind: "blocked" },
  env: { configured: true, provider: "anthropic", var: "ANTHROPIC_API_KEY" },
  probeable: true, blurb: "b",
  bound: { provider: "openai", keyId: 3, model: "gpt-5-mini" },
  running: { provider: "openai", model: "gpt-5-mini", keyId: 3 },
  supportedBy: [{ name: "openai", label: "OpenAI" }, { name: "anthropic", label: "Anthropic" }],
};
const embedCap = {
  id: "embed", label: "Semantic search", noun: "embeddings", agent: "embedder", declaredBy: "embed",
  binding: { provider: true, enable: true }, floor: { kind: "off" }, probeable: true, blurb: "b",
  rebindWarning: "re-embeds everything. Continue?",
  bound: { provider: "openai", keyId: 5, model: "text-embedding-3-small", enabled: true },
  running: { provider: "openai", model: "text-embedding-3-small", keyId: 5 },
  supportedBy: [{ name: "openai", label: "OpenAI" }, { name: "local", label: "Local Embedder (Xenova)" }],
  progress: { done: 4, total: 10, failed: 1 },
};
const transcribeCap = {
  id: "transcribe", label: "Transcription", noun: "transcription", agent: "transcriber", declaredBy: "transcribe",
  binding: { provider: true, enable: false }, probeable: true, blurb: "b",
  floor: { kind: "builtin", provider: "whisper", label: "Local Transcriber (Whisper)" },
  bound: { provider: "openai", keyId: 7, model: "whisper-1" },
  running: { provider: "openai", model: "whisper-1", keyId: 7 },
  supportedBy: [{ name: "openai", label: "OpenAI" }, { name: "whisper", label: "Local Transcriber (Whisper)" }],
};
const openaiP = {
  name: "openai", label: "OpenAI",
  ai: { onDevice: false, keyless: false, provides: {
    tag: { models: [{ id: "gpt-5-mini", note: "n" }], default: "gpt-5-mini" },
    embed: { models: [{ id: "text-embedding-3-small", note: "n" }], default: "text-embedding-3-small" },
    transcribe: { models: [{ id: "whisper-1", note: "n" }], default: "gpt-4o-transcribe" },
  } },
};
const anthropicP = { name: "anthropic", label: "Anthropic", ai: { onDevice: false, keyless: false, provides: { tag: { models: [], default: "claude-haiku-4-5" } } } };
const localP = { name: "local", label: "Local Embedder (Xenova)", ai: { onDevice: true, keyless: true, provides: { embed: { models: [{ id: "bge", note: "on-device" }], default: "bge" } } } };
const whisperP = { name: "whisper", label: "Local Transcriber (Whisper)", ai: { onDevice: true, keyless: true, provides: { transcribe: { models: [], default: null } } } };

test("planSection: the env row exists only on its provider's card, and its apply saves keyId null", () => {
  const plan = planSection({ ...tagCap, bound: { provider: null, keyId: null, model: null }, running: { provider: "anthropic", model: "m", keyId: "env" } }, anthropicP, []);
  assert.equal(plan.guard, null, "the env row counts as a connection");
  assert.deepEqual(plan.rows, [{ value: "env", label: "ANTHROPIC_API_KEY env var" }]);
  assert.equal(plan.preselect, "env", "the holder preselects its own rung");
  assert.equal(plan.ask, false, "one row already holding the slot asks no question");
  assert.deepEqual(plan.buttons[0].payload({ key: "env", model: "claude-haiku-4-5" }),
    { keyId: null, model: "claude-haiku-4-5" }, "no provider field — tag binds by row; env = clear the row");
  // The same capability on ANOTHER provider's card gets no env row.
  const other = planSection(tagCap, openaiP, [{ id: 3, name: "prod" }]);
  assert.deepEqual(other.rows, [{ value: "3", label: "prod" }]);
  assert.deepEqual(other.buttons[0].payload({ key: "3", model: "gpt-5-mini" }), { keyId: 3, model: "gpt-5-mini" });
});

test("planSection: embed's one apply binds AND enables; Turn off keeps the binding", () => {
  const plan = planSection(embedCap, openaiP, [{ id: 5, name: "prod" }]);
  assert.deepEqual(plan.buttons[0].payload({ key: "5", model: "text-embedding-3-small" }),
    { provider: "openai", keyId: 5, model: "text-embedding-3-small", enabled: true });
  const off = plan.buttons.find((b) => b.kind === "off");
  assert.deepEqual(off.payload(), { enabled: false });
  // on-device: picked by name, no rows, still enables in the same call
  const local = planSection({ ...embedCap, running: { provider: "local", model: "bge", keyId: null } }, localP, []);
  assert.equal(local.rows, null);
  assert.deepEqual(local.buttons[0].payload({ key: null, model: null }), { provider: "local", enabled: true });
});

test("planSection: revert targets the floor by name — and never appears on the floor's own card", () => {
  const plan = planSection(transcribeCap, openaiP, [{ id: 7, name: "prod" }]);
  const revert = plan.buttons.find((b) => b.kind === "revert");
  assert.equal(revert.label, "Use the built-in transcription instead");
  assert.deepEqual(revert.payload(), { provider: "whisper" });
  const floorCard = planSection({ ...transcribeCap, bound: { provider: "whisper", keyId: null, model: null }, running: { provider: "whisper", model: "large-v3", keyId: null } }, whisperP, []);
  assert.equal(floorCard.buttons.find((b) => b.kind === "revert"), undefined);
  assert.match(floorCard.model.note, /baked at deploy/, "the sidecar's empty catalog reads as a note, not a picker");
});

test("planSection: guard, probe gating, confirm arming, and the progress line", () => {
  const guarded = planSection(transcribeCap, openaiP, []);
  assert.match(guarded.guard, /Add a key above to serve transcription/);

  // Test only shows on the acting provider's card.
  assert.ok(planSection(transcribeCap, openaiP, [{ id: 7, name: "k" }]).buttons.some((b) => b.kind === "probe"));
  const notHolder = planSection({ ...transcribeCap, running: { provider: "whisper", model: null, keyId: null } }, openaiP, [{ id: 7, name: "k" }]);
  assert.ok(!notHolder.buttons.some((b) => b.kind === "probe"));
  assert.deepEqual(notHolder.currentDefault, { label: "Local Transcriber (Whisper)", model: null });

  // The costly-rebind confirm arms only while enabled with a pinned model.
  const armed = planSection(embedCap, openaiP, [{ id: 5, name: "k" }]);
  assert.deepEqual(armed.confirm, { message: "re-embeds everything. Continue?", priorModel: "text-embedding-3-small" });
  const dark = planSection({ ...embedCap, bound: { ...embedCap.bound, enabled: false } }, openaiP, [{ id: 5, name: "k" }]);
  assert.equal(dark.confirm, null);

  assert.equal(armed.progressLine, fmtProgress({ done: 4, total: 10, failed: 1 }));
  assert.match(armed.progressLine, /4 of 10 items processed/);
});

// --- slice 5b: extraction's own binding displaces the delegation story ---

test("the Uses line yields once the capability has its own global binding", () => {
  const bound = presentLines({
    state: "active", delegatesTo: "tag",
    bound: { provider: null, keyId: 4, model: "extract-mini" },
    running: { provider: "openai", model: "extract-mini", keyId: 4 },
    supportedBy: supported,
  });
  assert.ok(!bound.some((l) => l.k === "Uses"), "Running already tells the truth — no contradiction line");
  // …and the delegating shape (nothing bound) keeps it, as pinned above.
  const delegating = presentLines({ state: "blocked", delegatesTo: "tag", delegatesToAgent: "tagger", bound: { provider: null, keyId: null, model: null }, supportedBy: [] });
  assert.deepEqual(delegating, [{ k: "Uses", v: "each board's tagger" }]);
});

test("planSection: extract gets a section on its declarer's card — bind by row, tag's model catalog, one button", () => {
  const extractCap = {
    id: "extract", label: "Field extraction", noun: "field extraction", agent: "extractor",
    declaredBy: "tag", blurb: "b", delegatesTo: "tag",
    binding: { provider: false, enable: false, global: true }, floor: { kind: "delegate" },
    bound: { provider: null, keyId: null, model: null },
    running: { provider: "openai", model: "gpt-5-mini", keyId: 3 }, // delegating: the tagger serves
    supportedBy: [{ name: "openai", label: "OpenAI" }],
  };
  const plan = planSection(extractCap, openaiP, [{ id: 3, name: "prod" }]);
  assert.equal(plan.guard, null);
  assert.deepEqual(plan.rows, [{ value: "3", label: "prod" }]);
  assert.equal(plan.model.catalog.models[0].id, "gpt-5-mini", "extraction rides the tagging wire — its models are tag models");
  assert.equal(plan.buttons.length, 1, "no probe (nothing of its own to probe), no off, no revert");
  assert.equal(plan.buttons[0].label, "Make default extractor");
  assert.deepEqual(plan.buttons[0].payload({ key: "3", model: "gpt-5-mini" }), { keyId: 3, model: "gpt-5-mini" },
    "no provider field (binds by row), no enabled flag");
});

// --- slice 5b: the board modal's per-board pin picker ---

const boardTranscribe = {
  id: "transcribe", label: "Transcription", noun: "transcription", agent: "transcriber", declaredBy: "transcribe",
  binding: { provider: true, enable: false, global: true },
  floor: { kind: "builtin", provider: "whisper", label: "Local Transcriber (Whisper)" },
  boardBinding: { provider: "transcribe_provider", keyId: "transcribe_key_id", model: "transcribe_model" },
  running: { provider: "openai", model: "whisper-1", keyId: 7 },
  supportedBy: [
    { name: "openai", label: "OpenAI", installed: true, keyCount: 1, onDevice: false, keyless: false },
    { name: "whisper", label: "Local Transcriber (Whisper)", installed: true, keyCount: 0, onDevice: true, keyless: true },
    { name: "acme", label: "Acme Audio", installed: false, keyCount: 1, onDevice: false, keyless: false },
  ],
};
const allKeys = [
  { id: 7, name: "prod", provider: "openai" },
  { id: 9, name: "acme-k", provider: "acme" },
  { id: 11, name: "embeds-only", provider: "voyage" }, // advertises no transcription
];
const boardCatalog = {
  openai: { provides: { transcribe: { models: [{ id: "whisper-1", note: "n" }], default: "gpt-4o-transcribe" } } },
};

test("planBoardPicker: the rows are the App default (named), installed on-device engines, and only keys that could serve", () => {
  const plan = planBoardPicker(boardTranscribe, allKeys, null, boardCatalog);
  assert.deepEqual(plan.rows, [
    { value: "", label: "App default (OpenAI · whisper-1)" },
    { value: "whisper", label: "Local Transcriber (Whisper) — built-in" },
    { value: "7", label: "prod — openai" },
    { value: "9", label: "acme-k — acme · not installed" },
  ], "the embeds-only key is not offered — the write path would refuse it");
  assert.equal(plan.preselect, "", "a new board inherits");
  // The default's meaning updates with what actually serves.
  const floorServed = planBoardPicker({ ...boardTranscribe, running: { provider: "whisper", model: "large-v3", keyId: null } }, allKeys, null, boardCatalog);
  assert.equal(floorServed.rows[0].label, "App default (Local Transcriber (Whisper) · large-v3)");
});

test("planBoardPicker: a delegate capability's unset row says what it follows, never a false app default", () => {
  const boardExtract = {
    id: "extract", label: "Field extraction", noun: "field extraction", agent: "extractor", declaredBy: "tag",
    binding: { provider: false, enable: false, global: true },
    floor: { kind: "delegate", to: "tag" },
    boardBinding: { keyId: "extract_key_id", model: "extract_model" },
    delegatesTo: "tag", delegatesToAgent: "tagger",
    // Under delegation the resolver still reports what runs (the tagger's
    // chain) — the row must not present that as extraction's own default.
    running: { provider: "openai", model: "gpt-5-mini", keyId: 7 },
    supportedBy: [{ name: "openai", label: "OpenAI", installed: true, keyCount: 1, onDevice: false, keyless: false }],
  };
  const plan = planBoardPicker(boardExtract, allKeys, null, boardCatalog);
  assert.equal(plan.rows[0].label, "Same as the tagger");
  assert.equal(plan.chosenLabel("", null), "Same as the tagger",
    "the unset delegate answers with its relationship; the shell adds the live model");
  // Published for the shell, which must not re-derive it: the answer is what
  // tells the board modal whether to follow the tagger's picker for this row's
  // live value, and the raw delegatesTo field would say yes even below.
  assert.equal(plan.delegated, true);
  // With an app-wide default of its OWN bound, the row reads as inherited again.
  const bound = planBoardPicker({ ...boardExtract, bound: { keyId: 7 } }, allKeys, null, boardCatalog);
  assert.equal(bound.rows[0].label, "App default (OpenAI · gpt-5-mini)");
  assert.equal(bound.chosenLabel("", null), "OpenAI · gpt-5-mini");
  assert.equal(bound.delegated, false,
    "a capability answering with its own app-wide default is not following anyone — " +
    "the shell reads this to decide whether to resolve through the delegate's picker");
});

// The predicate the row above rests on, alone: the feed ships `delegatesTo` for
// any delegate-floored capability, so every reader has to pair it with "and
// nothing of its own is bound". Three readers here did; the board modal's strip
// and bands each kept a copy that didn't, and named the tagger's model on a
// board whose extraction ran on its own app-wide binding.
test("isDelegating: the descriptor says it CAN delegate, a stored default says it isn't", () => {
  const floored = { delegatesTo: "tag", delegatesToAgent: "tagger" };
  assert.equal(isDelegating(floored), true, "delegate floor, nothing of its own bound");
  assert.equal(isDelegating({ ...floored, bound: { keyId: 7 } }), false,
    "an app-wide default of its own outranks the delegate floor — the resolver says so too");
  // A binding row with no key is not a choice: config-only or provider-only
  // bindings leave keyId null, and the delegate floor still carries the work.
  assert.equal(isDelegating({ ...floored, bound: { keyId: null, model: "x" } }), true);
  assert.equal(isDelegating({ bound: { keyId: 7 } }), false, "no delegate floor at all");
});

test("planBoardPicker: preselects come from the board's columns; a vanished pin falls to the default row", () => {
  const keyed = planBoardPicker(boardTranscribe, allKeys, { transcribe_key_id: 7, transcribe_model: "whisper-1" }, boardCatalog);
  assert.equal(keyed.preselect, "7");
  const named = planBoardPicker(boardTranscribe, allKeys, { transcribe_provider: "whisper" }, boardCatalog);
  assert.equal(named.preselect, "whisper");
  const dead = planBoardPicker(boardTranscribe, allKeys, { transcribe_key_id: 99 }, boardCatalog);
  assert.equal(dead.preselect, "", "a dead pointer must not be sent back on save");
});

test("planBoardPicker: the model axis exists only for keyed rows, speaks the capability's own catalog slice", () => {
  const plan = planBoardPicker(boardTranscribe, allKeys, { transcribe_key_id: 7, transcribe_model: "whisper-1" }, boardCatalog);
  assert.equal(plan.modelAxis(""), null, "the default row inherits — no picker");
  assert.equal(plan.modelAxis("whisper"), null, "an on-device engine's model is baked");
  const axis = plan.modelAxis("7");
  assert.equal(axis.kind, "transcribe", "live listings are asked for THIS capability's models");
  assert.equal(axis.keyId, 7);
  assert.deepEqual(axis.entry, { defaultModel: "gpt-4o-transcribe", models: [{ id: "whisper-1", note: "n" }] });
  assert.equal(axis.saved, "whisper-1", "the persisted model belongs to the persisted key");
  assert.equal(plan.modelAxis("9").saved, null, "…and to no other");
});

test("planBoardPicker: the payloads write the feed's column names, full-state per capability", () => {
  const plan = planBoardPicker(boardTranscribe, allKeys, null, boardCatalog);
  assert.deepEqual(plan.payload("", null),
    { transcribe_provider: null, transcribe_key_id: null, transcribe_model: null }, "App default = clear the pin");
  assert.deepEqual(plan.payload("whisper", null),
    { transcribe_provider: "whisper", transcribe_key_id: null, transcribe_model: null }, "a built-in pin is a name, never a key");
  assert.deepEqual(plan.payload("7", "whisper-1"),
    { transcribe_provider: null, transcribe_key_id: 7, transcribe_model: "whisper-1" }, "a keyed pin displaces any name pin");

  // The tagger's shape: no provider column exists, so no name rows and no
  // provider field in any body.
  const tagPlan = planBoardPicker({
    id: "tag", label: "Tagging", noun: "tagging", agent: "tagger", declaredBy: "tag",
    binding: { provider: false, enable: false, global: true }, floor: { kind: "blocked" },
    boardBinding: { keyId: "ai_key_id", model: "ai_model" },
    running: { provider: "openai", model: "gpt-5-mini", keyId: 7 },
    supportedBy: [{ name: "openai", label: "OpenAI", installed: true, keyCount: 1, onDevice: false, keyless: false }],
  }, allKeys, { ai_key_id: 7, ai_model: null }, boardCatalog);
  assert.ok(!tagPlan.rows.some((r) => r.value && !/^\d+$/.test(r.value)), "no name rows without a provider column");
  assert.deepEqual(tagPlan.payload("7", "gpt-5-mini"), { ai_key_id: 7, ai_model: "gpt-5-mini" });
  assert.deepEqual(tagPlan.payload("", null), { ai_key_id: null, ai_model: null });
});

test("planBoardPicker: chosenLabel narrates the current selection for the mapping pane's inheritance note", () => {
  const plan = planBoardPicker(boardTranscribe, allKeys, null, boardCatalog);
  assert.equal(plan.chosenLabel("", null), "OpenAI · whisper-1", "the default row answers with what it inherits");
  assert.equal(plan.chosenLabel("7", "whisper-1"), "prod — openai · whisper-1");
  assert.equal(plan.chosenLabel("whisper", null), "Local Transcriber (Whisper) — built-in");
});

// --- the board modal's capability-CONFIG planner (ai-image-input-plan.md §7) ---

// A tag entry as the feed projects it: the board-scopable image-detail knob.
const boardTagCfg = [{
    key: "tag_image_preset", value: "high", kind: "enum", boardColumn: "tag_image_preset",
    label: "Image size sent to the model",
    hint: "larger images cost more tokens",
    chip: "image size",
    options: [
      { value: "thumb", label: "Thumbnail" },
      { value: "standard", label: "Standard" },
      { value: "high", label: "High" },
      { value: "max", label: "Provider max" },
    ],
}];

test("planBoardConfig: the unset row names what the app default resolves to", () => {
  const [plan] = planBoardConfig(boardTagCfg, null);
  assert.equal(plan.column, "tag_image_preset", "the write vocabulary comes from the feed, never hardcoded");
  assert.equal(plan.label, "Image size sent to the model");
  assert.deepEqual(plan.rows[0], { value: "", label: "App default (High)" });
  assert.deepEqual(plan.rows.map((r) => r.value), ["", "thumb", "standard", "high", "max"]);
  assert.equal(plan.preselect, "", "a board with no pin inherits");
  // The default row tracks the app-wide value, so it can never mislabel it.
  const [cheap] = planBoardConfig([{ ...boardTagCfg[0], value: "thumb" }], null);
  assert.equal(cheap.rows[0].label, "App default (Thumbnail)");
});

test("planBoardConfig: a pin preselects, and a retired preset falls back instead of being resent", () => {
  assert.equal(planBoardConfig(boardTagCfg, { tag_image_preset: "max" })[0].preselect, "max");
  assert.equal(
    planBoardConfig(boardTagCfg, { tag_image_preset: "ultra-retired" })[0].preselect, "",
    "a value the app no longer declares must not be sent back on save"
  );
});

test("planBoardConfig: payload clears with null", () => {
  const [plan] = planBoardConfig(boardTagCfg, null);
  assert.deepEqual(plan.payload(""), { tag_image_preset: null }, "App default = clear the column");
  assert.deepEqual(plan.payload("max"), { tag_image_preset: "max" });
});

test("planBoardConfig: the Advanced summary chip names the knob, and only when the board deviates", () => {
  const [plan] = planBoardConfig(boardTagCfg, null);
  assert.equal(plan.chipFor(""), "", "an inherited value is not state the fold is hiding");
  assert.equal(plan.chipFor("standard"), "image size: Standard");
  // The name is the knob's own copy — the summary loops over N knobs, and the
  // modal used to hardcode "image:" for all of them, so a second board-scoped
  // knob would have reported under the first one's name.
  const [other] = planBoardConfig([{ ...boardTagCfg[0], chip: "detail level" }], null);
  assert.equal(other.chipFor("max"), "detail level: Provider max");
  // No `chip` copy → the full label rather than silence: verbose beats wrong,
  // and beats a fold summary that hides a changed setting.
  const [bare] = planBoardConfig([{ ...boardTagCfg[0], chip: undefined }], null);
  assert.equal(bare.chipFor("max"), "Image size sent to the model: Provider max");
});

test("planBoardConfig: one fixed hint for the field, not one per option", () => {
  // Per-option hints had to be re-synced on every change and every failed
  // save — and the admin page's copy of that rule was already missing, so it
  // described the wrong option. A constant is un-stale-able, and the option
  // ORDER carries the cheap→expensive ladder without copy repeating it.
  const [plan] = planBoardConfig(boardTagCfg, null);
  assert.equal(plan.hint, "larger images cost more tokens");
  assert.equal(plan.hintFor, undefined, "no per-selection hint to keep in sync");
  assert.ok(plan.rows.every((r) => !("hint" in r)), "rows carry a label and a value, nothing to sync");
  // A field that ships no hint plans an empty one rather than "undefined".
  assert.equal(planBoardConfig([{ ...boardTagCfg[0], hint: undefined }], null)[0].hint, "");
});

test("planBoardConfig: only board-scopable knobs plan a row", () => {
  assert.deepEqual(planBoardConfig(undefined, null), [], "no config at all");
  // detect's threshold is capability-level but deliberately NOT board-scoped:
  // no boardColumn, so no row.
  assert.deepEqual(
    planBoardConfig([{ key: "detect_threshold", value: 0.3 }], null), [],
    "a global-only knob stays out of the board modal"
  );
});

// --- 7c: the Plugins-tab helpers — one source for "who serves what" ---
// These replace slotProviders/tagFor's hand-lists, whose removal warning
// forgot the transcriber. The rules worth pinning: effective-vs-stored view,
// the delegate exclusion, the disabled gate, and the consequence copy.

test("servingRoles: the effective view — delegate-served entries are the target's role, not a second one", () => {
  const caps = [
    { kind: "ai", id: "tag", agent: "tagger", running: { provider: "anthropic", model: "m", keyId: "env" }, bound: { provider: null, keyId: null, model: null } },
    // extract UNBOUND: its running is the tagger's own binding riding the delegate floor — not anthropic's role
    { kind: "ai", id: "extract", agent: "extractor", delegatesTo: "tag", delegatesToAgent: "tagger",
      running: { provider: "anthropic", model: "m", keyId: "env" }, bound: { provider: null, keyId: null, model: null } },
    // embed off: no running at all, so no role — the enable gate needs no special case here
    { kind: "ai", id: "embed", agent: "embedder", running: null, bound: { provider: null, keyId: 5, model: null, enabled: false } },
    { kind: "ai", id: "transcribe", agent: "transcriber", running: { provider: "whisper", model: "large-v3", keyId: null }, bound: { provider: "whisper", keyId: null, model: null } },
    { kind: "domain", id: "crypto", running: { provider: "anthropic" } }, // domains are never AI roles
  ];
  assert.deepEqual(servingRoles(caps, "anthropic").map((c) => c.id), ["tag"]);
  assert.deepEqual(servingRoles(caps, "whisper").map((c) => c.id), ["transcribe"]);
  // extract WITH its own stored key is a real role of the serving provider
  const own = [{ kind: "ai", id: "extract", agent: "extractor", delegatesTo: "tag", delegatesToAgent: "tagger",
    running: { provider: "openai", model: "m", keyId: 3 }, bound: { provider: null, keyId: 3, model: null } }];
  assert.deepEqual(servingRoles(own, "openai").map((c) => c.id), ["extract"]);
});

test("roleBadge: names the role, links its card, and keeps the tagger's env qualifier", () => {
  assert.deepEqual(
    roleBadge({ id: "tag", agent: "tagger", running: { provider: "anthropic", keyId: "env" } }),
    { capId: "tag", text: "default tagger · env" });
  assert.deepEqual(
    roleBadge({ id: "transcribe", agent: "transcriber", running: { provider: "whisper", keyId: null } }),
    { capId: "transcribe", text: "default transcriber" });
});

test("keyRoles: the stored view — every capability bound to the row; a disabled binding stays quiet", () => {
  const caps = [
    { kind: "ai", id: "tag", agent: "tagger", bound: { provider: null, keyId: 7, model: null } },
    { kind: "ai", id: "transcribe", agent: "transcriber", bound: { provider: "openai", keyId: 7, model: "whisper-1" } },
    { kind: "ai", id: "embed", agent: "embedder", bound: { provider: null, keyId: 7, model: null, enabled: false } },
    { kind: "ai", id: "detect", agent: "detector", bound: { provider: null, keyId: 2, model: null } },
  ];
  assert.deepEqual(keyRoles(caps, 7).map((c) => c.id), ["tag", "transcribe"]);
  assert.deepEqual(keyRoles(caps, 2).map((c) => c.id), ["detect"]);
  assert.deepEqual(keyRoles(caps, 9), []);
});

test("removalStory: the consequence clause per floor shape", () => {
  assert.equal(
    removalStory({ noun: "tagging", env: { configured: true, provider: "anthropic", var: "ANTHROPIC_API_KEY" }, floor: { kind: "blocked" } }),
    "tagging falls back to the ANTHROPIC_API_KEY env var");
  assert.equal(
    removalStory({ noun: "tagging", env: { configured: false, provider: "anthropic", var: "ANTHROPIC_API_KEY" }, floor: { kind: "blocked" } }),
    "tagging stops until another key is bound");
  assert.equal(
    removalStory({ noun: "transcription", floor: { kind: "builtin", provider: "whisper", label: "Local Transcriber (Whisper)" } }),
    "transcription falls back to Local Transcriber (Whisper)");
  assert.equal(removalStory({ label: "Semantic search", noun: "embeddings", floor: { kind: "off" } }), "Semantic search turns off");
  assert.equal(
    removalStory({ noun: "field extraction", floor: { kind: "delegate" }, delegatesTo: "tag", delegatesToAgent: "tagger" }),
    "field extraction falls back to each board's tagger");
});
