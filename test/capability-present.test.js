// The capabilities page's pure presenter (public/capability-present.js) — the
// state → card mapping, tested the det-geometry way: no DOM, no server, just
// payload shapes in and card copy out. The shapes here mirror what
// capabilities.test.js proves the server actually emits.
import test from "node:test";
import assert from "node:assert/strict";
import { presentChip, presentLines, presentSupported, configureTarget, planSection, fmtProgress } from "../public/capability-present.js";

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

  const extract = presentLines({ state: "blocked", delegatesTo: "tag", boardOverrides: 2, supportedBy: [] });
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
