import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  claimFairBatch,
  setEntityFaceAt,
  updateItemPayload,
  markTagged,
  markExtracted,
  failOrRequeue,
  recoverStuck,
  bumpUsage,
  getBoard,
  getAiKey,
  getSetting,
  dueBoards,
  retagBoard,
  setBoardNextRun,
  itemsNeedingEmbedding,
  oneAudioNeedingTranscription,
  setItemEmbedding,
  setItemEmbedError,
  getEntity,
  getEntityByIdentity,
  createEntity,
  setEntityIdentity,
  markEntityProvisional,
  setItemEntities,
  reconcileEntities,
  touchEntity,
  entityInstanceCount,
  dueLiveEntities,
  updateEntityFields,
  setEntityRefreshAt,
  addFieldSnapshot,
  pruneFieldSnapshots,
  pruneTagSnapshots,
  addJobLog,
  stampJobLog,
  deleteJobLog,
  latestSettledJob,
  markInterruptedJobs,
  pruneJobLog,
  requeueItemForTag,
  advanceFaced,
  dueIngestBoards,
  setIngestNextRun,
  setIngestState,
  ingestedKeys,
  recordIngest,
  withPluginHealth,
  withTx,
  reapEmptyEntities,
} from "./db.js";
import { resolveIngestAdapter, nextIngestRunAt } from "./ingestion/index.js";
import { evaluateItemAlerts, deliverDueAlerts } from "./alerts.js";
import { applyFilters, applySort, applyLimit } from "./ingestion/filter-engine.js";
import { callTagger, embedTexts, transcribeAudio, detectObjects, PROVIDERS } from "./providers.js";
import { pluginInstalled, pluginState } from "./plugins.js";
import { getConnector } from "./connectors/index.js";
import { entityRefreshAt, faceCadence } from "./connectors/runtime.js";
import { storeFace } from "./faces/index.js";
import { extractFileFields } from "./media/index.js";

// A not-installed AI plugin (Plugins page) drops out of resolution — configs
// that reference it fall through to the next rung instead of erroring, and
// items hold pending via the existing no-key machinery when nothing is left.
// (anthropic is pre-added; the local embedder is core; everything else is
// available-until-added — pluginInstalled applies the tier rule.)
const aiPluginInstalled = (db, provider) => pluginInstalled(db, `ai:${provider}`);

// Every live tagger call lands in the plugin health ledger (structured error
// or heal) so the Plugins page dot reflects real traffic — and the future
// self-healing loop has telemetry to read.
// A provider's effective rate limit: the Plugins-page rpm/burst override, or the
// descriptor default (pluginState merges the configSchema defaults in). Read per
// call — the config changes rarely and it's a single indexed lookup — and handed
// to the pacing bucket via the dispatcher args. Keyless providers have no rpm here
// (empty configSchema); they never reach paceAi anyway.
const aiRate = async (db, provider) => (await pluginState(db, `ai:${provider}`))?.config || {};

const trackedTagger = async (db, args) => {
  const { rpm, burst } = await aiRate(db, args.provider);
  return withPluginHealth(db, `ai:${args.provider}`, () => callTagger({ ...args, rpm, burst }));
};

// The app-default tagger: settings-designated key, else the legacy env var.
// Returns { provider, apiKey, model } or null when nothing is configured.
export async function resolveDefaultAi(db) {
  const defId = Number(await getSetting(db, "default_key_id")) || 0;
  if (defId) {
    const key = await getAiKey(db, defId);
    if (key && (await aiPluginInstalled(db, key.provider))) {
      const model = (await getSetting(db, "model")) || PROVIDERS[key.provider].defaultModel;
      // `base`: the connection's own server URL (self-hosted providers) — rides
      // every resolved-ai object so the wire can point at the right box.
      return { provider: key.provider, apiKey: key.api_key, model, base: key.base_url || undefined };
    }
  }
  if (process.env.ANTHROPIC_API_KEY && (await aiPluginInstalled(db, "anthropic"))) {
    return {
      provider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: (await getSetting(db, "model")) || process.env.MODEL || PROVIDERS.anthropic.defaultModel,
    };
  }
  return null;
}

// The app-global embedder for semantic search: enabled flag + provider choice.
// An on-device provider (the local ONNX model) is selected by NAME — it has no
// key row; otherwise a stored key/connection row is looked up (a keyless
// connection resolves with apiKey null and the wire sends no auth header).
// Returns { provider, apiKey, model } or null when off/missing.
export async function resolveEmbedder(db) {
  if ((await getSetting(db, "embed_enabled")) !== "1") return null;
  const embedProvider = await getSetting(db, "embed_provider");
  if (embedProvider) {
    const desc = PROVIDERS[embedProvider];
    if (!desc?.onDevice || !desc.embeds) return null; // a stale name (uninstalled plugin) → off
    if (!(await aiPluginInstalled(db, embedProvider))) return null; // core → always true; kept for symmetry
    return { provider: embedProvider, apiKey: null, model: desc.embeds.default };
  }
  // Key-based path (backward compat: embed_provider null + embed_key_id set).
  const keyId = Number(await getSetting(db, "embed_key_id")) || 0;
  if (!keyId) return null;
  const key = await getAiKey(db, keyId);
  if (!key || !PROVIDERS[key.provider]?.embeds) return null;
  if (!(await aiPluginInstalled(db, key.provider))) return null; // sweep pauses
  return {
    provider: key.provider,
    apiKey: key.api_key,
    model: (await getSetting(db, "embed_model")) || PROVIDERS[key.provider].embeds.default,
    base: key.base_url || undefined,
  };
}

// The text an item's search vector is built from: whole-item description,
// then the per-facet reasoning sentences, then the tags flattened to words
// (so exact facet vocabulary also matches). Falls back to the filename so no
// item ever embeds an empty string. Capped defensively: the tightest embedder
// input limit in the registry is Gemini's 2048 tokens, and a rejected input
// wedges its whole batch — truncating a tail beats that (the local model
// truncates far harder on its own). ~8k chars ≈ 2k tokens.
const EMBED_TEXT_MAX_CHARS = 8000;
export function embedTextFor(tags = [], reasoning = {}, payload = {}) {
  const parts = [];
  if (reasoning.description) parts.push(reasoning.description);
  for (const [k, v] of Object.entries(reasoning)) {
    if (k !== "description" && typeof v === "string" && v.trim()) parts.push(v.trim());
  }
  if (tags.length) parts.push(tags.map((t) => t.replace("/", ": ")).join("; "));
  // Audio: the transcript is the richest signal — include it so a recording is
  // searchable by what's spoken, tagged or not.
  if (payload.transcript) parts.push(payload.transcript);
  const text = parts.join("\n") || payload.files?.[0]?.original_name || payload.identity || "untitled item";
  return text.slice(0, EMBED_TEXT_MAX_CHARS);
}

// A board's effective tagger: its own key (+ model) when set, else the
// default. A board key whose provider plugin is not installed falls through to
// the default like a deleted key would — loudly, so the hold is explicable.
// Exported for tests.
export async function resolveBoardAi(db, boardEntry) {
  if (boardEntry.aiKeyId) {
    const key = await getAiKey(db, boardEntry.aiKeyId);
    if (key && (await aiPluginInstalled(db, key.provider))) {
      return {
        provider: key.provider,
        apiKey: key.api_key,
        model: boardEntry.aiModel || PROVIDERS[key.provider].defaultModel,
        base: key.base_url || undefined,
      };
    }
    if (key) console.log(`board AI provider ${key.provider} is not installed — falling back to the default tagger`);
  }
  return resolveDefaultAi(db);
}

// A missing key is a configuration gap, not an item failure: the claim gate
// normally keeps such items unclaimed, and when its race lets one through,
// noCount tells failOrRequeue to requeue without consuming an attempt.
function noKeyError() {
  const e = new Error("no API key configured");
  e.noCount = true;
  return e;
}

// Generic fallback glosses for common design-vocabulary facet keys, used when
// a facet doesn't carry its own description in the board config.
const GLOSS = {
  shell: "the persistent app chrome / navigation frame",
  nav: "how the primary navigation is organized",
  view: "the dominant content layout of the screen",
  viz: "data-visualization components present (multi-select; omit if none)",
  density: "visual information density",
  theme: "dominant color scheme (always pick one)",
  direction: "overall design direction / vibe",
};

const facetGloss = (f) => (f.description || "").trim() || GLOSS[f.key] || f.label;

export function buildPrompt(facets, context = "", withReasoning = true, subject = "items", withResearch = false) {
  const lines = facets.map((f) => {
    const note = f.single ? " — pick exactly one" : "";
    return `- ${f.key} (${facetGloss(f)}): ${f.values.join(", ")}${note}`;
  });
  const contextBlock = context.trim() ? `\n${context.trim()}\n` : "";
  // Phrased conditionally on purpose: the systemText is cached per board, but
  // the provider is resolved per item (per-board key with app-default
  // fallback), and only Anthropic actually gets a web_search tool.
  const researchPara = withResearch
    ? `\nIf a web search tool is available, you may use it to check recent real-world facts about the item before judging. Always finish by calling record_tags exactly once.\n`
    : "";
  const selectPara = withReasoning
    ? `Start with a freeform description of the item as a whole — one or two sentences covering what it is and its overall style and mood. Then for each facet, first write one short reasoning sentence naming what is visible that drives the choice (or why nothing applies), then select every applicable value. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's values empty when nothing applies (when the fit verdict is "undecided", leave every facet's values empty, including "pick exactly one" facets). Be accurate and conservative; do not invent values outside the allowed lists.`
    : `For each facet, select every applicable value. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's array empty when nothing applies (when the fit verdict is "undecided", leave every facet empty, including "pick exactly one" facets). Be accurate and conservative; do not invent values outside the allowed lists.`;
  const systemText = `You tag ${subject} for a private research gallery.${contextBlock}
Also decide whether the item is the kind of material the facets below can describe at all. If you can honestly justify facet selections from what is visible, the item is a match — set the fit verdict to "match" even when it falls outside the board's stated focus; recording that is what the facets themselves are for. Set the fit verdict to "undecided" only when the item is a different kind of material altogether and the facets simply do not apply, so that selecting values would be pure guessing; in that case leave every facet's values empty. Never combine "undecided" with facet selections: an item you were able to describe with the facets is a match by definition.

${selectPara}
${researchPara}
Facets and allowed values:
${lines.join("\n")}

Return your answer only by calling the record_tags tool.`;

  const properties = {};
  const required = [];
  // Declared (and emitted) first: the model describes the whole item before
  // judging facets. Skipped if a facet claims the key, so `required` can't
  // end up with a duplicate entry.
  if (withReasoning && !facets.some((f) => f.key === "description")) {
    properties.description = {
      type: "string",
      description: "One or two sentences describing the item as a whole: what it is, its overall style and mood.",
    };
    required.push("description");
  }
  for (const f of facets) {
    const gloss = facetGloss(f) + (f.single ? " — pick exactly one value" : "");
    properties[f.key] = withReasoning
      ? {
          type: "object",
          description: gloss,
          // reasoning is declared (and emitted) before values on purpose: the
          // model justifies first, selects second.
          properties: {
            reasoning: {
              type: "string",
              description: "One short sentence: what is visible that justifies the selection, or why nothing applies.",
            },
            values: { type: "array", items: { type: "string", enum: f.values } },
          },
          required: ["reasoning", "values"],
          additionalProperties: false,
        }
      : {
          type: "array",
          items: { type: "string", enum: f.values },
          description: gloss,
        };
    required.push(f.key);
  }
  // Defined after the facet loop so a facet named "fit" can't clobber it.
  properties.fit = withReasoning
    ? {
        type: "object",
        description: "Whether the item fits the kind of material this board collects.",
        properties: {
          reasoning: {
            type: "string",
            description: "One short sentence explaining the verdict.",
          },
          verdict: { type: "string", enum: ["match", "undecided"] },
        },
        required: ["reasoning", "verdict"],
        additionalProperties: false,
      }
    : {
        type: "string",
        enum: ["match", "undecided"],
        description: "Whether the item fits the kind of material this board collects.",
      };
  required.push("fit");
  const schema = { type: "object", properties, required, additionalProperties: false };
  return { systemText, schema };
}

// Convert mammoth HTML to extraction-friendly markdown. Preserves headings,
// bold, and — crucially — hyperlinks (<a href>) as [label](url) so linked
// labels (portfolio, LinkedIn) carry their URLs into the extraction prompt.
export function htmlToMarkdown(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    .replace(/<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return label ? `[${label}](${href})` : href;
    })
    .replace(/<h1[^>]*>/gi, "\n## ").replace(/<\/h1>/gi, "\n")
    .replace(/<h2[^>]*>/gi, "\n### ").replace(/<\/h2>/gi, "\n")
    .replace(/<h3[^>]*>/gi, "\n### ").replace(/<\/h3>/gi, "\n")
    .replace(/<(strong|b)[^>]*>/gi, "**").replace(/<\/(strong|b)>/gi, "**")
    .replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n").replace(/<\/div>/gi, "\n").replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Normalise a derived identity value for consistent collision detection.
// Underscores and hyphens are treated as word separators so the AI returning
// "priya_ramanathan" or "Priya Ramanathan" both key to "priya ramanathan".
// Module-level + exported so validateMapping's candidate dup-check keys the
// same way the runtime resolver does (no drift between the two).
export const normaliseIdentity = (s) => s.trim().replace(/[-_\s]+/g, " ").toLowerCase();

// Build the extraction prompt + strict schema for a mapping's AI fields.
// Pure function — no cache needed (extraction runs once per item; mappings
// vary per item so a board-level cache wouldn't help).
export function buildFieldsPrompt(mapping) {
  // Only AI fields are extracted here; file fields (from:"file") are projected
  // deterministically from the stored entry, connector fields come from the source.
  // Object-detection fields never reach the model — they're produced by a
  // separate detector pass in extractOne — so they're excluded from both the
  // system-text field list and the record_fields schema here.
  const fields = ((mapping && mapping.fields) || []).filter((f) => f.from === "ai" && f.kind !== "object");
  const hasDerivedIdentity = mapping?.identity?.from === "ai";
  const identityHint = hasDerivedIdentity ? (mapping.identity.hint || "").trim() : "";
  // Classify mode: the identity answer is constrained to a user-declared list
  // (each { value, hint? }). Absent/empty → open extraction, exactly as before.
  const candidates = hasDerivedIdentity && Array.isArray(mapping.identity.candidates)
    ? mapping.identity.candidates : [];
  const classify = candidates.length > 0;
  const lines = fields.map((f) => `- ${f.key} (${f.kind}): ${f.hint || f.key}`);

  // Identity is just another extraction field to the model: its hint rides in
  // the system-text field list like everyone else's, first (mirroring schema
  // order). Framing it as "the entity's unique key" made models favour
  // uniqueness over the user's format (echoing filenames verbatim), so that
  // consistency guidance survives only as the fallback when no hint was given —
  // there it's the only signal the model has, and merge/split needs same
  // subject → same value. In classify mode the allowed options (with their
  // per-value hints) are listed instead — the schema enum forbids anything off
  // the list, and the hints are the only place a per-option description can live.
  if (hasDerivedIdentity) {
    if (classify) {
      const opts = candidates.map((c) => `    - ${c.value}${c.hint ? `: ${c.hint}` : ""}`).join("\n");
      // Cardinality is the system's to state, not the user's prose (that's the
      // whole point of the toggle) — so spell out multi here, and pair it with a
      // conservatism clause so "select all that apply" doesn't become "select
      // everything". "Not only the closest single match" specifically counters a
      // hint phrased as a superlative ("resembles the most").
      lines.unshift(`- identity: ${identityHint || "which of the options below this item matches"}` +
        ` — an item can match more than one: select every option that genuinely applies` +
        ` (one, several, or none), not only the closest single match; pick only options you can clearly justify:\n${opts}`);
    } else {
      lines.unshift(`- identity (text): ${identityHint ||
        "a short name for what this item is about — the same subject must always produce the same value"}`);
    }
  }
  const systemText =
    `You extract structured fields from items for a private research board.\n\n` +
    `For each field, first write one short sentence explaining why you chose the value ` +
    `(or why it could not be found in the material), then provide the value. ` +
    `Set the value to null when the field cannot be determined from the material.\n\n` +
    (lines.length ? `Fields to extract:\n${lines.join("\n")}\n\n` : "") +
    `Return your answer only by calling the record_fields tool.`;

  const kindType = { text: "string", url: "string", date: "string", number: "number" };
  const properties = {};
  const required = [];

  // Identity key is declared first so the model commits to it before extracting
  // fields. Classify mode mirrors the facet enum-array shape (why + values[]);
  // the closed enum makes an off-list answer structurally impossible and an
  // empty array is the legal "matches none". Open mode keeps the scalar value.
  if (hasDerivedIdentity) {
    properties.identity = classify
      ? {
          type: "object",
          description: identityHint || "Which of the listed options this item matches.",
          properties: {
            why: { type: "string", description: "One short sentence justifying the selection(s), or why none apply." },
            values: { type: "array", items: { type: "string", enum: candidates.map((c) => c.value) } },
          },
          required: ["why", "values"],
          additionalProperties: false,
        }
      : {
          type: "object",
          description: identityHint || "A short, consistent name for what this item is about.",
          properties: {
            why: { type: "string", description: "One short sentence justifying the value, or why it was not found." },
            value: { type: ["string", "null"] },
          },
          required: ["why", "value"],
          additionalProperties: false,
        };
    required.push("identity");
  }

  for (const f of fields) {
    const jt = kindType[f.kind] || "string";
    properties[f.key] = {
      type: "object",
      description: f.hint || f.key,
      properties: {
        why: { type: "string", description: "One short sentence justifying the value, or why it was not found." },
        value: { type: [jt, "null"] },
      },
      required: ["why", "value"],
      additionalProperties: false,
    };
    required.push(f.key);
  }
  const schema = { type: "object", properties, required, additionalProperties: false };
  return { systemText, schema };
}

// Per-board cache: board_id -> { systemText, schema, allowed, facets, research, aiKeyId, aiModel }
// Invalidated on board PATCH (server.js) and cleared entirely on key deletion.
const boardPromptCache = new Map();

async function getBoardPrompt(db, boardId) {
  if (boardPromptCache.has(boardId)) return boardPromptCache.get(boardId);
  const board = await getBoard(db, boardId);
  if (!board || !board.facets.length) return null;
  const { facets, context } = board;
  const allowed = new Set();
  for (const f of facets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const research = board.ai_research === true;
  // Boards mix file kinds now, so the honest per-board subject is "items";
  // the per-item wording ("Tag this image/document…") rides in the user turn.
  const { systemText, schema } = buildPrompt(facets, context, board.ai_reasoning !== false, "items", research);
  const entry = { systemText, schema, allowed, facets, research, aiKeyId: board.ai_key_id, aiModel: board.ai_model };
  boardPromptCache.set(boardId, entry);
  return entry;
}

export function invalidateBoardCache(boardId) {
  boardPromptCache.delete(boardId);
}

export function invalidateAllBoardCaches() {
  boardPromptCache.clear();
}

// Embed one batch of rows (itemsNeedingEmbedding shape), isolating poison
// inputs. The whole batch is one API call on the happy path. When it fails
// with a request-content 4xx — the only class that can be item-specific;
// auth/model/rate statuses (401/403/404/408/429) and 5xx/network are the
// caller's to back off on — each item is retried alone: lone failures are
// marked (setItemEmbedError) and skipped by future sweeps, innocents proceed.
// If NOTHING succeeds one-by-one, the 400 was config-shaped after all (e.g. a
// provider that rejects a bad model as 400), so throw for the backoff instead
// of wrongly marking a whole batch. Returns { embedded, skipped }; throws for
// batch-level failures. Exported so the sweep and tests share one path.
export async function embedBatch(db, embedder, rows) {
  const t0 = Date.now();
  const { rpm, burst } = await aiRate(db, embedder.provider); // per-provider pacing (local: none)
  const call = (rs) =>
    withPluginHealth(db, `ai:${embedder.provider}`, () =>
      embedTexts({
        provider: embedder.provider,
        apiKey: embedder.apiKey,
        base: embedder.base,
        model: embedder.model,
        rpm, burst,
        texts: rs.map((r) => embedTextFor(r.tags, r.tag_reasoning, r.payload)),
      })
    );
  try {
    const { vectors } = await call(rows);
    for (let i = 0; i < rows.length; i++) await setItemEmbedding(db, rows[i].id, vectors[i], embedder.model);
    return { embedded: rows.length, skipped: 0 };
  } catch (err) {
    const s = Number(err?.status);
    const isolatable = Number.isInteger(s) && s >= 400 && s < 500 && ![401, 403, 404, 408, 429].includes(s);
    if (!isolatable || rows.length <= 1) throw err;
  }
  let embedded = 0;
  const failures = [];
  for (const r of rows) {
    try {
      const { vectors } = await call([r]);
      await setItemEmbedding(db, r.id, vectors[0], embedder.model);
      embedded++;
    } catch (e) {
      failures.push({ row: r, message: String(e?.message ?? e) });
    }
  }
  if (!embedded) throw new Error(failures[0].message);
  for (const { row: r, message } of failures) {
    await setItemEmbedError(db, r.id, message);
    // Embed successes are plumbing nobody watches, but a marked-and-skipped
    // item silently vanishes from the search corpus — that gets a job row.
    await jobLogWrite(() => addJobLog(db, {
      boardId: r.board_id, entityId: r.entity_ids?.[0] ?? null, itemId: r.id,
      target: r.payload?.files?.[0]?.original_name || r.payload?.identity || null,
      kind: "embed", outcome: "failed", error: message,
      detail: { model: embedder.model }, startedAt: t0, endedAt: Date.now(),
    }));
    console.warn(`embed: skipping item #${r.id} (${message}) — re-tagging retries it`);
  }
  return { embedded, skipped: failures.length };
}

// --- periodic retag schedule (server-local time; set TZ to move it) ---

const DAY_MS = 24 * 3600 * 1000;
const isWeekend = (ts) => [0, 6].includes(new Date(ts).getDay());

// Next run after `from`: one interval later, pushed forward a day at a time
// past Sat/Sun when weekends are excluded (keeps the time-of-day intact).
export function nextAutoTagRun(from, everyMin, skipWeekends) {
  let t = from + everyMin * 60000;
  if (skipWeekends) while (isWeekend(t)) t += DAY_MS;
  return t;
}

// --- connector liveness (slice 5c) ---

// Refresh one due entity: whole-object fetch via its connector's active provider,
// write back only the due fields (see runtime.refresh), and — only when the
// board opts in with retag_on_refresh — snapshot the movement and re-queue the
// entity to re-tag on a real change. Movement history rides the retag opt-in:
// a plain live board just updates in place (a 1-min live price would otherwise
// write ~1440 unread rows/day). Exported so the sweep and tests share one path.
// Throws are the caller's (the sweep backs off); it never swallows.
export async function refreshDueEntity(db, { entity, inst, board }, now = Date.now(), dirs = null) {
  const conn = getConnector(board.mapping?.input?.connector);
  if (!conn?.refresh) { await setEntityRefreshAt(db, entity.id, null); return { moved: [], requeued: false, faced: false }; }
  const mapping = board.mapping;
  // Fields — live config from the board mapping (current), not the stamped one.
  const r = await conn.refresh(db, entity, inst, mapping, now);
  const fields = r.merged || entity.fields;
  const moved = r.merged ? Object.keys(r.moved) : [];

  // Face — regenerate the chart when its own cadence is due (needs the worker's
  // dirs; the sweep passes them, unit tests may not). A rendered face uses a new
  // filename so the immutable cache serves fresh bytes (generateFace unlinks the
  // old). `dirs` absent → skip (fields-only path).
  let faceAt = entity.face_at;
  let faced = false;
  const cad = faceCadence(mapping);
  // Regenerate when the cadence is due, OR render the first face when the entity
  // has a live face but none yet (face_at null) — so turning a face on / raising
  // its cadence backfills every existing coin instead of only the ones that
  // happened to render already. A face render error is isolated: log and keep
  // going, so it never blocks the field refresh or halts the sweep.
  if (dirs && cad && (faceAt == null || now - faceAt >= cad.every * 60000)) {
    try {
      const face = await generateFace(db, dirs, entity, inst, board, now);
      // Success → face_at advances to now; an unavailable render returns null
      // and generateFace resets face_at to null, so mirror that locally (a throw
      // is transient and leaves the stored face_at intact — keep the old value).
      faceAt = face ? now : null;
      faced = !!face;
    } catch (e) {
      console.warn(`face render failed for entity #${entity.id} ${entity.identity}: ${e.message} (keeping fields)`);
    }
  }

  // One authoritative refresh_at across fields + face.
  const nextAt = entityRefreshAt(fields, faceAt, mapping, now);
  if (r.merged) await updateEntityFields(db, entity.id, fields, nextAt);
  else await setEntityRefreshAt(db, entity.id, nextAt);

  let requeued = false;
  if (moved.length) {
    if (board.retag_on_refresh) await addFieldSnapshot(db, entity.id, r.moved, r.provider, now);
    // requeueItemForTag only touches settled items (tagged/failed) — an
    // instance mid-definition or mid-flight is left alone, so requeued
    // reflects what actually happened.
    if (board.retag_on_refresh && board.auto_tag) requeued = await requeueItemForTag(db, inst.id);
    console.log(`refreshed entity #${entity.id} ${entity.identity} [${r.provider}] -> ${moved.join(", ")}${requeued ? " (retag)" : ""}`);
  }
  if (faced) console.log(`refreshed face for entity #${entity.id} ${entity.identity}`);
  return { moved, requeued, faced };
}

// Render + store the connector chart face for one entity, or leave the symbol
// tile when the mapping has no connector face or the active provider can't
// supply history. Writes the webp under the standard convention (galleryDir/
// <name> + thumbsDir/<name>.webp), points the vehicle instance's files at it,
// and stamps entities.face_at. Regeneration uses a NEW random name (the statics
// cache immutably) and unlinks the old generated file. Returns the file entry
// or null. Exported so the face leg, the sweep, and tests share one path.
export async function generateFace(db, { galleryDir, thumbsDir }, entity, inst, board, now = Date.now()) {
  const conn = getConnector(board.mapping?.input?.connector);
  const faceCfg = board.mapping?.face;
  if (!conn?.produceFace || faceCfg?.from !== "connector") return null;
  const rendered = await conn.produceFace(db, entity, inst.payload?.source, faceCfg);
  if (!rendered) { await setEntityFaceAt(db, entity.id, null); return null; } // no history → keep the tile
  const name = crypto.randomBytes(16).toString("hex");
  const stored = await storeFace({ galleryDir, thumbsDir }, name, rendered, { generated: true });
  const face = { ...stored, kind: "image", generated: true };
  const old = inst.payload?.files?.[0];
  await updateItemPayload(db, inst.id, { files: [face] });
  await setEntityFaceAt(db, entity.id, now);
  if (old?.generated && old.name !== name) {
    await fs.promises.unlink(path.join(galleryDir, old.name)).catch(() => {});
    await fs.promises.unlink(path.join(thumbsDir, old.name + ".webp")).catch(() => {});
  }
  return face;
}

// Every document kind resolves to text the same way — pdf via the PyMuPDF
// sidecar (structured markdown, links preserved), docx via its html sidecar
// (htmlToMarkdown; .txt fallback), text files raw. Two failure shapes, kept
// deliberately distinct:
//  - extractor infra failure (unreachable / non-OK) THROWS status-less →
//    failOrRequeue spaces the retries and the item rides out the blip
//    (deploys restart the sidecar) instead of falling back to per-page
//    document billing;
//  - a document with genuinely no text throws 422 (permanent — retrying won't
//    grow text) for docx/text, but returns "" for pdf: a textless scan is the
//    one case where the Anthropic document block is the right fallback
//    (visual reading is what those models are for; the caller decides).
// Exported for tests; the worker binds galleryDir at the call sites.
const EXTRACTOR_URL = process.env.EXTRACTOR_URL || "http://extractor:3002";
// Generous by design: the sidecar is single-threaded, so with the extract
// claims fanned in, a request can legitimately sit behind ~3 OCR jobs
// (~40 s+ each). A budget that doesn't cover that queue manufactures
// spurious extractor-unreachable errors under ordinary load.
const EXTRACTOR_TIMEOUT_MS = Number(process.env.EXTRACTOR_TIMEOUT_MS) || 240000;
const noTextError = (file) => {
  const e = new Error(`"${file.original_name || file.name}" has no extractable text`);
  e.status = 422; // permanent-shaped: failOrRequeue fails it on the first attempt
  return e;
};
// The audio transcriber sidecar (faster-whisper) — audio's equivalent of the
// extractor, but the exchange is ASYNC: POST /transcribe returns 202 + a
// content-hash job id immediately, and we poll GET /jobs/<id> until it settles.
// No HTTP request ever spans inference (a 2h clip is ~real-time on CPU), so a
// timeout can never orphan completed work — the failure that used to grind the
// old sync sidecar forever. Because the id hashes the bytes, a retry or an app
// restart RE-JOINS the same in-flight job instead of duplicating it, and a
// finished result stays claimable sidecar-side for ~1h.
const TRANSCRIBER_URL = process.env.TRANSCRIBER_URL || "http://transcriber:3003";
// Bounds ONE HTTP exchange (a poll), never the job. Submit gets a higher floor
// below — it ships the whole file.
const TRANSCRIBER_HTTP_TIMEOUT_MS = Number(process.env.TRANSCRIBER_HTTP_TIMEOUT_MS) || 30000;
// Job liveness is judged by progress, not wall time: a job whose transcribed
// seconds haven't advanced in this long is declared hung (transient — the next
// attempt re-joins or restarts it; the sidecar's own watchdog restarts a truly
// frozen model). Covers the pre-segment decode+VAD phase of a long clip too.
const TRANSCRIBER_STALL_MS = Number(process.env.TRANSCRIBER_STALL_MS) || 900000;

// The sidecar's live model, read off its /health and cached briefly — for
// display surfaces (the Plugins page whisper card). The sidecar is the ONLY
// place that names its model (baked at image build); nothing app-side mirrors
// WHISPER_MODEL, so nothing can drift. Null when unreachable — callers show a
// "baked at deploy" fallback. Failures cache too, so an admin page reload
// doesn't re-time-out against a down sidecar on every hit.
let sidecarModelCache = { at: 0, model: null };
export async function transcriberSidecarModel() {
  if (Date.now() - sidecarModelCache.at < 60000) return sidecarModelCache.model;
  let model = null;
  try {
    const res = await fetch(`${TRANSCRIBER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) model = (await res.json()).model || null;
  } catch { /* down/unreachable — display-only, fall back */ }
  sidecarModelCache = { at: Date.now(), model };
  return model;
}

// The on-server whisper-sidecar engine, wrapped as an interchangeable descriptor
// { id, model, transcribe } so a provider engine slots in the way resolveEmbedder
// picks local vs a provider. Failure taxonomy for the transcription loop:
//   - `transient: true`, no scope — the sidecar itself is unwell (down, queue
//     full): back off the LANE, no clip is at fault.
//   - `scope: "job"` — this clip's job failed/stalled/vanished: transient for
//     the ITEM (per-item backoff + attempt cap), the lane moves on.
//   - `status: 422` — undecodable input: the loop parks it permanently.
// id "whisper" matches the keyless `whisper` provider — its plugin card and the
// transcribe_provider sentinel.
function whisperTranscriber() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The sidecar names its own model: the done payload carries it, and `model`
  // fills in from there — null until a job completes. The cache stamp thus
  // records the model that actually produced the text, even across a mid-job
  // sidecar redeploy.
  let model = null;
  return {
    id: "whisper",
    get model() { return model; },
    // opts.deadlineMs: give up (transient) if the job hasn't settled by then —
    // for interactive callers like the admin probe, not the worker loop.
    // opts.stallMs: test override for the no-progress window.
    async transcribe(buf, _filename, { deadlineMs = 0, stallMs = TRANSCRIBER_STALL_MS } = {}) {
      const started = Date.now();
      let sub;
      try {
        sub = await fetch(`${TRANSCRIBER_URL}/transcribe`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: buf,
          // covers shipping a 500MB body across the compose network, not the job
          signal: AbortSignal.timeout(Math.max(TRANSCRIBER_HTTP_TIMEOUT_MS, 120000)),
        });
      } catch (e) {
        const err = new Error(`transcriber unreachable (${e.message}) — will retry`);
        err.transient = true;
        throw err;
      }
      if (!sub.ok) {
        // 503 = queue full (lane-wide, transient via 5xx); 422 = bad input.
        const e = new Error(`transcriber failed (HTTP ${sub.status})`);
        e.status = sub.status;
        throw e;
      }
      const jobId = (await sub.json()).job;
      // Poll until settled: immediately once (tiny probes finish in seconds),
      // then backing off 250ms → 30s. Network blips mid-poll are tolerated for
      // a few rounds — the job keeps running through them.
      let lastDone = -1, lastAdvance = Date.now(), pollFailures = 0, delay = 0;
      for (;;) {
        if (delay) await sleep(delay);
        delay = Math.min(delay ? delay * 2 : 250, 30000);
        if (deadlineMs && Date.now() - started > deadlineMs) {
          const e = new Error("transcriber busy — a longer job holds the queue");
          e.transient = true;
          e.scope = "job";
          throw e;
        }
        let res;
        try {
          res = await fetch(`${TRANSCRIBER_URL}/jobs/${jobId}`, { signal: AbortSignal.timeout(TRANSCRIBER_HTTP_TIMEOUT_MS) });
        } catch (e) {
          if (++pollFailures < 5) continue;
          const err = new Error(`transcriber unreachable mid-job (${e.message}) — will retry`);
          err.transient = true;
          throw err;
        }
        pollFailures = 0;
        if (res.status === 404) {
          // The sidecar restarted (jobs are in-memory) — resubmitting on the
          // next attempt is the recovery, and the content hash dedupes it.
          const e = new Error("transcriber lost the job (restarted?) — will retry");
          e.transient = true;
          e.scope = "job";
          throw e;
        }
        if (!res.ok) {
          const e = new Error(`transcriber failed (HTTP ${res.status})`);
          e.status = res.status;
          e.scope = "job";
          throw e;
        }
        const job = await res.json();
        if (job.status === "done") {
          if (job.model) model = job.model;
          return job.text || "";
        }
        if (job.status === "failed") {
          const e = new Error(`transcriber: ${job.error || "unknown failure"}`);
          e.status = job.permanent ? 422 : 500; // permanent = undecodable input
          e.scope = "job";
          throw e;
        }
        const done = Number(job.progress?.done_s) || 0;
        if (done > lastDone) {
          lastDone = done;
          lastAdvance = Date.now();
        } else if (Date.now() - lastAdvance > stallMs) {
          const e = new Error(`transcriber stalled (no progress in ${Math.round(stallMs / 60000)}m) — will retry`);
          e.transient = true;
          e.scope = "job";
          throw e;
        }
      }
    },
  };
}

// Transient attempts per clip before parking it (reprocess un-parks). Bounds the
// pathological clip; a healthy lane never gets near it.
const TRANSCRIBE_MAX_ATTEMPTS = Number(process.env.TRANSCRIBE_MAX_ATTEMPTS) || 5;

// How the transcription loop answers a failure — pure, exported for tests.
//   park          a permanent fault of the clip (undecodable, provider 4xx)
//   park-capped   transiently failing clip out of attempts — stop poisoning the lane
//   backoff-item  this clip's job faulted/stalled — retry IT later, lane moves on
//   backoff-lane  the engine itself is unwell (down, 429/5xx) — nothing would succeed
export function transcribeFailurePolicy(err, attempts, maxAttempts = TRANSCRIBE_MAX_ATTEMPTS) {
  const s = Number(err?.status);
  const transient = err?.transient === true || s === 429 || s === 408 || (s >= 500 && s < 600)
    || /unreachable/.test(String(err?.message));
  if (!transient) return "park";
  if (err?.scope !== "job") return "backoff-lane";
  return attempts + 1 >= maxAttempts ? "park-capped" : "backoff-item";
}

// A board's audio→text engine. An app-wide `transcribe_provider` setting can
// point at any provider that ADVERTISES `transcribes` (a stored key + installed
// plugin); everything else — unset, "whisper", a no-audio provider (Claude has
// `transcribes: null`), a missing key — falls back to the always-on whisper
// sidecar. Never fails to resolve: audio must always become taggable. Fully
// capability-driven — no provider name is hardcoded here. `board` is accepted
// for a future per-board choice (unused today). Exported for tests + server.
export async function resolveTranscriber(db, board = null) {
  const provider = await getSetting(db, "transcribe_provider");
  if (provider && provider !== "whisper" && PROVIDERS[provider]?.transcribes && (await aiPluginInstalled(db, provider))) {
    const keyId = Number(await getSetting(db, "transcribe_key_id")) || 0;
    const key = keyId ? await getAiKey(db, keyId) : null;
    // A keyed/keyless-networked provider needs its stored key/connection row;
    // an on-device plugin (own wire.transcribe, no rows — the loader rejects a
    // transcribes descriptor without one) resolves bare. Whisper itself never
    // reaches here (name-guarded above): it rides the sidecar, not a wire.
    if (key || PROVIDERS[provider].onDevice) {
      const model = (await getSetting(db, "transcribe_model")) || PROVIDERS[provider].transcribes.default;
      const { rpm, burst } = await aiRate(db, provider); // per-provider pacing, same bucket as tagging
      return {
        id: provider, // the engine family; the cache stamp appends :model (→ "openai:gpt-4o-transcribe")
        model,
        // Runs under the plugin-health ledger like every other provider call
        // (trackedTagger, embedBatch) so transcription traffic + errors show on
        // the Plugins page — otherwise a paid provider transcribes invisibly.
        transcribe: async (buf, filename) =>
          (await withPluginHealth(db, `ai:${provider}`, () =>
            transcribeAudio({ provider, apiKey: key?.api_key ?? null, base: key?.base_url || undefined, model, rpm, burst, audio: buf, filename }))).text,
      };
    }
  }
  return whisperTranscriber();
}

const OBJECT_DETECTOR_URL = process.env.OBJECT_DETECTOR_URL || "http://object-detector:3004";
// Bounds ONE /detect exchange: a detection is seconds, but a queued image behind
// others (the sidecar is single-threaded) plus a cold model load can run longer,
// so keep it generous like the extractor.
const OBJECT_DETECTOR_TIMEOUT_MS = Number(process.env.OBJECT_DETECTOR_TIMEOUT_MS) || 180000;

// The detector sidecar's live model, read off its /health and cached briefly —
// the peer of transcriberSidecarModel(). The model is baked into the image at
// build (OBJECT_DETECTOR_MODEL), so the app never mirrors it; the admin card
// reads it from here and thus can't drift when the image is rebuilt with a
// different model. Null when unreachable — callers show a baked-at-deploy
// fallback. Failures cache too, so an admin reload doesn't re-time-out per hit.
let detectorModelCache = { at: 0, model: null };
export async function detectorSidecarModel() {
  if (Date.now() - detectorModelCache.at < 60000) return detectorModelCache.model;
  let model = null;
  try {
    const res = await fetch(`${OBJECT_DETECTOR_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) model = (await res.json()).model || null;
  } catch { /* down/unreachable — display-only, fall back */ }
  detectorModelCache = { at: Date.now(), model };
  return model;
}

// The on-server object-detector sidecar wrapped as an interchangeable engine
// { id, model, detect } — the peer of whisperTranscriber(). POSTs the ORIGINAL
// image + noun-phrase queries to /detect and returns canonical
// [{ label, box(0..1 xyxy), score }]. Unreachable/non-OK throws transient → the
// extract leg requeues (mirrors the extractor contract), never a silent empty.
function objectDetectorSidecar(threshold) {
  return {
    id: "localDetector",
    model: PROVIDERS.localDetector.detects.default, // the sidecar's baked default
    detect: async (image, queries) => {
      let res;
      try {
        res = await fetch(`${OBJECT_DETECTOR_URL}/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_b64: image.toString("base64"), queries, threshold }),
          signal: AbortSignal.timeout(OBJECT_DETECTOR_TIMEOUT_MS),
        });
      } catch (e) {
        const err = new Error(`object-detector unreachable (${e.message}) — will retry`);
        err.transient = true;
        throw err;
      }
      if (!res.ok) {
        // Carry the sidecar's reason into the message so a parked item's error
        // says WHY (e.g. "undecodable image: ..."), not a bare status. A 4xx
        // (422 undecodable input) is permanent → failOrRequeue parks it on the
        // first attempt; a 5xx stays transient → the extract leg requeues.
        let detail = "";
        try { detail = (await res.json())?.error || ""; } catch { /* no/again-unreadable body */ }
        const e = new Error(`object-detector failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
        e.status = res.status;
        throw e;
      }
      const { objects } = await res.json();
      return Array.isArray(objects) ? objects : [];
    },
  };
}

// A board's image→boxes engine. A `detect_provider` setting can point at any
// provider that ADVERTISES `detects` (a stored key + installed plugin) and routes
// through wire.detect; everything else — unset, "localDetector", a no-detect
// provider, a missing key — falls back to the always-on on-server object-detector
// sidecar (LLMDet). Never fails to resolve. Fully capability-driven; `board` is
// accepted for a future per-board choice (unused today). Threshold is closed over
// from settings. Exported for tests + server.
export async function resolveDetector(db, board = null) {
  const provider = (await getSetting(db, "detect_provider")) || "localDetector";
  const threshold = Number(await getSetting(db, "detect_threshold")) || 0.3;
  const desc = PROVIDERS[provider];
  if (provider !== "localDetector" && desc?.detects && (await aiPluginInstalled(db, provider))) {
    const keyId = Number(await getSetting(db, "detect_key_id")) || 0;
    const key = keyId ? await getAiKey(db, keyId) : null;
    // A keyed provider needs its stored key; an on-device detector plugin
    // (own wire.detect, no rows) resolves bare — same shape as transcription.
    if (key || desc.onDevice) {
      const model = (await getSetting(db, "detect_model")) || desc.detects.default;
      const { rpm, burst } = await aiRate(db, provider);
      return {
        id: provider,
        model,
        // Runs under the plugin-health ledger like every other provider call so
        // detection traffic + errors show on the Plugins page.
        detect: (image, queries) =>
          withPluginHealth(db, `ai:${provider}`, () =>
            detectObjects({ provider, apiKey: key?.api_key ?? null, base: key?.base_url || undefined, model, rpm, burst, image, queries, threshold })),
      };
    }
  }
  // The always-on on-server object-detector sidecar — no key, resolved directly
  // (wire: null), like the whisper transcriber.
  return objectDetectorSidecar(threshold);
}

// One object field = one object type; its queries are the hint's comma/newline-
// split synonyms for the SAME thing (or the de-snaked field key when there's no
// hint, so a field `license_plate` detects "license plate"). Every object field's
// queries run in ONE detector pass — the detector echoes the matched query as
// each box's label, so `.route()` demuxes boxes back to the owning field by that
// label. `norm` mirrors the sidecar's own query normalization
// (q.strip().rstrip('.').lower()): the sidecar feeds period-terminated phrases and
// echoes labels WITHOUT the period, so a hint typed "car." must normalize to
// "car" or the label would never match and the box would be silently dropped.
// Pure + exported so the demux (the fragile part) is unit-testable without a DB.
export function detectionDemux(objectFields) {
  const norm = (s) => s.trim().replace(/\.+$/, "").trim().toLowerCase();
  const deSnake = (key) => key.replace(/_/g, " ");
  const queryToField = new Map(); // normalized query → owning field key (first wins)
  const queries = []; // original strings passed to the detector (deduped)
  const seen = new Set();
  for (const f of objectFields) {
    const raw = (f.hint || deSnake(f.key)).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    for (const q of (raw.length ? raw : [deSnake(f.key)])) {
      const nq = norm(q);
      if (!queryToField.has(nq)) queryToField.set(nq, f.key);
      if (!seen.has(nq)) { seen.add(nq); queries.push(q); }
    }
  }
  return {
    queries,
    // Boxes → { fieldKey: det[] }. Every field gets an entry (empty if nothing
    // matched); a box whose label matches no query is dropped (it wasn't asked for).
    route(detections) {
      const byField = new Map(objectFields.map((f) => [f.key, []]));
      for (const d of (detections || [])) {
        const key = queryToField.get(norm(d.label));
        if (key) byField.get(key).push(d);
      }
      return byField;
    },
  };
}

// The grounding-DINO family resizes to ~this on the long edge internally, so
// shipping a full-res original only inflates the base64 POST + the sidecar's
// decode for zero accuracy gain (the sidecar is single-threaded — every wasted
// megabyte queues behind the next image). 40e6 mirrors the ingest decode cap.
const DETECT_MAX_EDGE = 1333;
const DETECT_MAX_INPUT_PIXELS = 40e6;

// Prepare an image for the detector: cap the long edge and re-encode small. The
// boxes come back normalized 0..1, so a uniform downscale leaves them exact.
// .rotate() bakes EXIF orientation into the pixels — the sidecar's PIL does NOT
// auto-orient, so without this a rotated phone photo would detect on unrotated
// pixels while the browser draws the overlay on the auto-oriented display; baking
// it keeps the boxes aligned with what the user sees. Best-effort: any sharp
// failure (undecodable/exotic input) falls back to the original bytes, so this
// only ever SHRINKS a decodable image and never changes the failure contract —
// a truly bad image still reaches the sidecar and 422-parks there (see #detect).
export async function imageForDetection(buf) {
  try {
    return await sharp(buf, { pages: 1, limitInputPixels: DETECT_MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: DETECT_MAX_EDGE, height: DETECT_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }) // JPEG has no alpha; white beats the default black behind a logo
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    return buf; // let the sidecar decode (and 422-park) a truly undecodable image
  }
}

// The job log observes; it must never break the job it observes. Every ledger
// write goes through here — a failure is a warn, never a throw into the leg
// or sweep being recorded. Returns the write's result, or null on failure.
async function jobLogWrite(fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn("job log write failed:", e.message);
    return null;
  }
}

// The per-item material budget for a model turn, in chars (~4 chars/token).
// The default covers ~50 dense pages or ~2.5 hours of speech — the
// transcriber's own 2-hour design point fits — while staying inside every
// built-in provider's context window (GLM's 128k tokens is the tightest) and
// remaining a cost fuse for scheduled retags, which re-pay the input per item
// per pass. Env-tunable; anything past it is clipText-marked, never silently
// dropped.
const TEXT_DOC_MAX_CHARS = Number(process.env.TEXT_DOC_MAX_CHARS) || 150000;

// Bound one material block for a model turn, saying so when it actually cuts:
// an unmarked missing tail reads as ABSENCE (extraction answers "not found"
// with a confident why sentence), a marked one reads as truncation the model
// can report. The counts give it scale — 1% missing and half missing warrant
// different confidence. Exported for tests.
export function clipText(text, max = TEXT_DOC_MAX_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated: showing the first ${max} of ${text.length} characters]`;
}

export async function documentTextFor(galleryDir, file) {
  if (file.kind === "pdf") {
    const buf = await fs.promises.readFile(path.join(galleryDir, file.name));
    let res;
    try {
      res = await fetch(`${EXTRACTOR_URL}/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: buf,
        signal: AbortSignal.timeout(EXTRACTOR_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`extractor unreachable (${e.message}) — will retry`);
    }
    if (!res.ok) throw new Error(`extractor failed (HTTP ${res.status}) — will retry`);
    return (await res.json()).markdown || "";
  }
  if (file.kind === "docx") {
    const html = await fs.promises.readFile(path.join(galleryDir, file.name + ".html"), "utf8").catch(() => "");
    const text = html
      ? htmlToMarkdown(html)
      : await fs.promises.readFile(path.join(galleryDir, file.name + ".txt"), "utf8").catch(() => "");
    // An image-only docx passes ingest with empty sidecars; tagging a blank
    // document would only hallucinate.
    if (!text.trim()) throw noTextError(file);
    return text;
  }
  if (file.kind === "text") {
    const text = await fs.promises.readFile(path.join(galleryDir, file.name), "utf8").catch(() => "");
    if (!text.trim()) throw noTextError(file);
    return text;
  }
  return "";
}

// Resolve one derived identity value to an entity id via find-or-create,
// preferring to reuse an old entity IN PLACE (from `reusable`) when the key is
// new — that keeps a provisional/sole entity's id stable so its hearts and crate
// membership survive a rename (the pre-array "sole instance: rename in place"
// branch). `resolved` is the ids already claimed this pass, so a reusable entity
// is never handed out twice. The latest derivation wins the display name —
// identity can be anything (a name, a code, a date), so no cased heuristics.
//
// Concurrency: extraction runs EXTRACT_CONCURRENCY-wide and classify mode funnels
// many items to the same candidate, so a sibling extraction can claim `key`
// between our lookup and our write — the unique (board_id, identity) index then
// throws 23505. We recover by adopting the winner, so a race MERGES into it
// instead of throwing the leg into a requeue. Module-level (exported) so the
// collision recovery is unit-testable without driving the model.
export async function resolveIdentity(db, boardId, key, display, reusable, resolved) {
  // The entity that won a concurrent create/rename of `key`. A non-23505 error —
  // or a winner that vanished again before we could read it — re-throws, and the
  // leg requeues; only the genuine race is swallowed.
  const winner = async (err) => {
    if (err.code !== "23505") throw err;
    const w = await getEntityByIdentity(db, boardId, key);
    if (!w) throw err;
    return w.id;
  };
  const existing = await getEntityByIdentity(db, boardId, key);
  if (existing) {
    // Adopt the entity already holding this key, refreshing its display name.
    // Can't collide — we write the key the row already carries.
    await setEntityIdentity(db, existing.id, key, display);
    return existing.id;
  }
  while (reusable.length) {
    const rid = reusable.shift();
    if (resolved.includes(rid)) continue;      // already claimed by an existing-key match
    try {
      await setEntityIdentity(db, rid, key, display);
      return rid;
    } catch (err) {
      // The rename lost the race: rid keeps its old key and is still a sole
      // entity, so hand it back for a later value in this pass to reuse.
      reusable.unshift(rid);
      return winner(err);
    }
  }
  try {
    return await createEntity(db, boardId, { identity: key, displayName: display });
  } catch (err) {
    return winner(err);
  }
}

export function startWorker({ db, thumbsDir, galleryDir, sources = null, autoBackup = null }) {
  const POLL_MS = Number(process.env.POLL_MS || 3000);
  const STUCK_MS = Number(process.env.STUCK_MS || 180000);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
  // Per-resource lanes (worker-rework Stage 1) replace the single global "4": AI
  // in-flight is a memory/cost fuse (the provider RATE is the per-key token bucket in
  // providers.js), the extractor sidecar is single-threaded so its lane is ≈1-2, and
  // faces are light. TAG_CONCURRENCY stays as a deprecated alias for AI_INFLIGHT.
  const AI_INFLIGHT = Math.max(1, Number(process.env.AI_INFLIGHT) || Number(process.env.TAG_CONCURRENCY) || 8);
  const EXTRACT_CONCURRENCY = Math.max(1, Number(process.env.EXTRACT_CONCURRENCY) || 2);
  const FACE_CONCURRENCY = Math.max(1, Number(process.env.FACE_CONCURRENCY) || 2);

  // Job-log rows still `running` were orphaned by the previous process (a
  // crash or stop mid-transcription/mid-ingest) — stamp them interrupted so
  // the jobs view never shows a ghost in flight. The bootAt fence in the
  // UPDATE keeps this boot's own fresh rows safe from the sweep.
  jobLogWrite(() => markInterruptedJobs(db, Date.now())).then((n) => {
    if (n) console.log(`job log: ${n} job(s) from the previous run marked interrupted`);
  });

  // What the model sees for an item: parts built from its files by kind.
  // Images: the thumbnail (cheap) rather than the original. Documents: their
  // extracted text (documentTextFor), so every provider can tag them; PDFs
  // additionally carry their page-1 thumbnail so visual/style facets keep
  // their signal, and fall back to an Anthropic-only document block when the
  // document genuinely has no text layer (extractor DOWNTIME throws instead —
  // the retry queue waits it out rather than paying per-page billing).
  async function modelInputFor(payload, entity = null, mode = "tag") {
    // The closing ask names the tool this leg actually offers: the tag leg
    // forces record_tags, extraction forces record_fields. On a provider that
    // can't force the call (GLM's tool_choice is auto-only) the sentence IS
    // the forcing, so a wrong name here instructs the model to fill in the
    // wrong form.
    const ask = (subject, judging = "") => mode === "extract"
      ? `Extract the requested fields from ${subject} using the record_fields tool${judging}.`
      : `Tag ${subject} using the record_tags tool${judging}.`;
    const file = payload.files?.[0];
    if (!file) {
      // Instance with no material file (connector tag vehicle): the
      // bound-fields dossier appended by tagOne is the material; anchor it
      // with the entity's name. Extraction appends no dossier, so its ask
      // can't promise "fields below" — the name is all there is.
      return [{
        kind: "text",
        text: `The item is an entity named "${entity?.display_name || entity?.identity || payload.identity}". ${ask("it", mode === "extract" ? "" : ", judging from its extracted fields below")}`,
      }];
    }
    if (file.kind === "pdf") {
      const text = await documentTextFor(galleryDir, file);
      if (text.trim()) {
        // Page-1 preview rides along so visual/style facets keep their signal;
        // the thumbnail is a fraction of the tokens of per-page PDF billing.
        const parts = [];
        const thumb = await fs.promises.readFile(path.join(thumbsDir, file.name + ".webp")).catch(() => null);
        if (thumb) parts.push({ kind: "image", mediaType: "image/webp", b64: thumb.toString("base64") });
        parts.push({
          kind: "text",
          text: `The item is the following document ("${file.original_name}")` +
            (thumb ? ", shown above as a first-page preview" : "") +
            `:\n\n${clipText(text)}\n\n${ask("this document")}`,
        });
        return parts;
      }
      // Extraction succeeded but found no text: a scan with no text layer
      // (or past the OCR cap). The whole PDF as a document block is the right
      // fallback — visual reading is exactly what Anthropic models can do
      // (compat providers reject document parts with a readable error).
      console.warn(`no text layer in ${file.original_name || file.name} — sending as a document block (Anthropic-only, billed per page)`);
      const buf = await fs.promises.readFile(path.join(galleryDir, file.name));
      return [
        { kind: "document", mediaType: "application/pdf", b64: buf.toString("base64") },
        { kind: "text", text: ask("this document") },
      ];
    }
    if (file.kind === "text" || file.kind === "docx") {
      const text = await documentTextFor(galleryDir, file);
      return [{
        kind: "text",
        text: `The item is the following document ("${file.original_name}"):\n\n${clipText(text)}\n\n${ask("this document")}`,
      }];
    }
    if (file.kind === "audio") {
      // The transcript is produced out-of-band by the transcription loop and
      // stored on the payload, independent of tagging. If it isn't ready yet
      // (and didn't permanently fail), requeue — status-less — so the first tag
      // still tags the speech rather than the filename.
      const transcript = payload.transcript;
      if (transcript === undefined && !payload.transcript_error) {
        // A wait, not a failure — don't burn tag attempts while a long clip
        // transcribes (noCount requeues indefinitely on a short backoff).
        const e = new Error("awaiting transcription — will retry");
        e.noCount = true;
        throw e;
      }
      if (transcript && transcript.trim()) {
        return [{
          kind: "text",
          text: `The item is an audio recording named "${file.original_name}". Transcript:\n\n${clipText(transcript)}\n\n${ask("this recording")}`,
        }];
      }
      // No discernible speech (music/ambient/silence) or a permanent transcribe
      // failure → anchor on the filename, like a textless document.
      return [{
        kind: "text",
        text: `The item is an audio recording named "${file.original_name}" with no discernible speech. ${ask("it", ", judging from its name")}`,
      }];
    }
    const buf = await fs.promises.readFile(path.join(thumbsDir, file.name + ".webp"));
    // A generated connector face (e.g. a price chart) gets a chart-aware anchor
    // so the tagger reads the trend, not a generic "image".
    const anchor = file.generated
      ? `This is a price chart for "${entity?.display_name || entity?.identity || payload.identity}". ${ask("it", mode === "extract" ? ", judging from the chart" : ", judging from the chart and the extracted fields below")}`
      : ask("this image");
    return [
      { kind: "image", mediaType: "image/webp", b64: buf.toString("base64") },
      { kind: "text", text: anchor },
    ];
  }

  // Text-only input for the extraction leg — all doc types go through the
  // same documentTextFor path so extraction works with any provider (document
  // blocks are Anthropic-only) and never pays image tokens. null = no text
  // (image file, or a genuinely textless pdf) — the caller falls back to
  // modelInputFor; extractor downtime throws out of here instead.
  async function modelInputForExtract(payload) {
    const file = payload.files?.[0];
    if (!file) return null; // connector entity with no file — nothing to extract
    let text;
    if (file.kind === "audio") {
      // Audio's "text" is its transcript (produced out-of-band); wait for it the
      // same way the tag leg does. A speechless clip has nothing to extract.
      if (payload.transcript === undefined && !payload.transcript_error) {
        const e = new Error("awaiting transcription — will retry");
        e.noCount = true; // a wait, not a failure — see modelInputFor
        throw e;
      }
      text = payload.transcript || "";
    } else {
      text = await documentTextFor(galleryDir, file);
    }
    if (!text.trim()) return null;
    return [{
      kind: "text",
      text: `The item is the following document ("${file.original_name}"):\n\n${clipText(text)}\n\nExtract the requested fields using the record_fields tool.`,
    }];
  }

  async function tagOne(row) {
    const prompt = await getBoardPrompt(db, row.board_id);
    if (!prompt) throw new Error(`board ${row.board_id} has no facets configured`);
    const { systemText, schema, allowed, facets } = prompt;

    const ai = await resolveBoardAi(db, prompt);
    if (!ai) throw noKeyError();

    const entity = row.entity_ids?.[0] ? await getEntity(db, row.entity_ids[0]) : null;
    const parts = await modelInputFor(row.payload, entity);
    // Distilled extraction results ride along as a text part so the tagger
    // sees the structured data without re-reading the raw material. Entity
    // fields (connector-bound) come first, the instance's own extractions
    // override on key collision.
    const fields = { ...(entity?.fields || {}), ...(row.payload.fields || {}) };
    const fieldLines = Object.entries(fields)
      // Scalars only — an object-detection field's `v` is an array of boxes,
      // which distils to noise (`key: [object Object],…`); it has no place in
      // the tagger's text anyway.
      .filter(([, { v }]) => v !== null && v !== undefined && typeof v !== "object")
      .map(([key, { v }]) => `${key}: ${v}`);
    if (entity?.display_name) fieldLines.unshift(`entity: ${entity.display_name}`);
    if (fieldLines.length) parts.push({ kind: "text", text: `Extracted fields:\n${fieldLines.join("\n")}` });
    const { input, usage } = await trackedTagger(db, {
      provider: ai.provider,
      apiKey: ai.apiKey,
      base: ai.base,
      model: ai.model,
      systemText,
      schema,
      parts,
      research: prompt.research,
    });
    const tags = [];
    const reasoning = {};
    // Whole-item description rides in tag_reasoning under a reserved key,
    // like `fit`. The typeof check keeps a facet named "description" (whose
    // entry is an object) from landing here.
    if (typeof input.description === "string" && input.description.trim()) {
      reasoning.description = input.description.trim();
    }
    let filledFacets = 0;
    for (const f of facets) {
      const entry = input[f.key];
      // Tolerate the pre-reasoning shape (bare array) in case the model drifts.
      const vals = Array.isArray(entry) ? entry : entry && Array.isArray(entry.values) ? entry.values : [];
      if (entry && typeof entry.reasoning === "string" && entry.reasoning.trim()) {
        reasoning[f.key] = entry.reasoning.trim();
      }
      const before = tags.length;
      for (const v of vals) {
        const t = `${f.key}/${v}`;
        if (allowed.has(t)) tags.push(t);
      }
      if (tags.length > before) filledFacets++;
    }
    const fit = input.fit;
    const verdict = typeof fit === "string" ? fit : fit && fit.verdict;
    if (fit && typeof fit.reasoning === "string" && fit.reasoning.trim()) {
      reasoning.fit = fit.reasoning.trim();
    }
    // Only honor an undecided verdict when the model also found the facets
    // mostly inapplicable. It keeps folding "off-scope but taggable" into
    // undecided regardless of prompt wording, and an item it could describe
    // with most of the facets is board material by definition.
    const undecided = verdict === "undecided" && filledFacets < facets.length / 2;
    return { tags, undecided, reasoning, usage, model: ai.model, provider: ai.provider };
  }

  // Fire due scheduled boards: re-queue everything for a fresh tagging pass
  // (content the board tracks can go stale) and schedule the next run. A run
  // landing on an excluded weekend retags nothing — it just rolls forward to
  // the next weekday slot.
  async function retagDue() {
    for (const b of await dueBoards(db, Date.now())) {
      const now = Date.now();
      const skipped = b.auto_tag_skip_weekends && isWeekend(now);
      const queued = skipped ? 0 : await retagBoard(db, b.id);
      await setBoardNextRun(db, b.id, nextAutoTagRun(now, b.auto_tag_every_min, b.auto_tag_skip_weekends));
      // One board-run row per pass — the answer to "why did 300 items just
      // queue" (and to "why didn't my retag run" on a skipped weekend). The
      // queued items each write their own tag rows as they process.
      await jobLogWrite(() => addJobLog(db, {
        boardId: b.id, kind: "retag", outcome: "ok",
        detail: { queued, ...(skipped ? { skipped: "weekend" } : {}) },
        startedAt: now, endedAt: Date.now(),
      }));
      if (queued) console.log(`scheduled retag: queued ${queued} item(s) in board "${b.name}"`);
      else if (skipped) console.log(`scheduled retag: board "${b.name}" skipped (weekend) — rescheduled`);
    }
  }

  // Embedding sweep: (re)vectorize tagged items with no current-model vector.
  // This single path covers fresh tags (markTagged clears the vector), manual
  // edits, turning the feature on late, and model changes — one batched API
  // call per pass (embedBatch isolates poison inputs so one bad item can't
  // wedge the backfill). Batch-level failures back off for a minute so a bad
  // key or outage doesn't turn the poll loop into an API hammer. Driven by
  // embedLoop (Stage 3); returns true after a FULL batch so the loop drains a
  // backlog fast instead of one batch per tick.
  const EMBED_BATCH = Math.max(1, Number(process.env.EMBED_BATCH) || 64);
  let embedBackoffUntil = 0;
  async function embedDue() {
    if (Date.now() < embedBackoffUntil) return false;
    const embedder = await resolveEmbedder(db);
    if (!embedder) return false;
    const rows = await itemsNeedingEmbedding(db, embedder.model, EMBED_BATCH);
    if (!rows.length) return false;
    try {
      const { embedded, skipped } = await embedBatch(db, embedder, rows);
      console.log(`embedded ${embedded} item(s)${skipped ? `, skipped ${skipped}` : ""} [${embedder.model}]`);
      return rows.length === EMBED_BATCH; // full batch → more likely waiting, drain fast
    } catch (err) {
      embedBackoffUntil = Date.now() + 60000;
      console.warn(`embed error (retrying in 60s): ${err.message}`);
      return false;
    }
  }

  // Liveness sweep: refresh entities whose live connector fields are due. Same
  // bounded-batch + backoff discipline as embedDue so a provider outage can't
  // turn the sweep into an API hammer. The per-entity work is refreshDueEntity
  // (module scope, exported for tests).
  const REFRESH_BATCH = Math.max(1, Number(process.env.REFRESH_BATCH) || 20);
  let refreshBackoffUntil = 0;

  // Snapshot retention, checked hourly not per tick — the DELETEs are cheap
  // but there's no point running them every 3s. 0 disables a prune (keep
  // forever). field_snapshots (movement history) defaults to 90 days;
  // tag_snapshots (judgment history) defaults to keep-forever — the dedupe in
  // addTagSnapshot means every row is a real judgment change, i.e. the
  // then-vs-now data itself, so age-pruning it is opt-in.
  const SNAPSHOT_RETENTION_DAYS = Number(process.env.SNAPSHOT_RETENTION_DAYS ?? 90);
  const TAG_SNAPSHOT_RETENTION_DAYS = Number(process.env.TAG_SNAPSHOT_RETENTION_DAYS ?? 0);
  // The job log (execution history, one row per attempt) defaults to 30 days —
  // it's operational transparency, not the product's data like the snapshots.
  const JOB_LOG_RETENTION_DAYS = Number(process.env.JOB_LOG_RETENTION_DAYS ?? 30);
  let nextPruneAt = 0;
  // Ghost-entity reap: a zero-instance entity is normally impossible, but the
  // FK-less entity_ids link can strand one on a crash or a concurrent delete.
  // Swept hourly; only entities settled empty for REAP_AGE_MS are taken, so an
  // in-flight upload (entity then instance, two statements) is never caught.
  const REAP_AGE_MS = Number(process.env.ENTITY_REAP_AFTER_MS) || 1800000; // 30 min
  let nextReapAt = 0;
  async function pruneSnapshots() {
    if ((!SNAPSHOT_RETENTION_DAYS && !TAG_SNAPSHOT_RETENTION_DAYS && !JOB_LOG_RETENTION_DAYS) || Date.now() < nextPruneAt) return;
    nextPruneAt = Date.now() + 3600000;
    if (SNAPSHOT_RETENTION_DAYS) {
      const n = await pruneFieldSnapshots(db, Date.now() - SNAPSHOT_RETENTION_DAYS * 86400000);
      if (n) console.log(`pruned ${n} field snapshot(s) older than ${SNAPSHOT_RETENTION_DAYS}d`);
    }
    if (TAG_SNAPSHOT_RETENTION_DAYS) {
      const n = await pruneTagSnapshots(db, Date.now() - TAG_SNAPSHOT_RETENTION_DAYS * 86400000);
      if (n) console.log(`pruned ${n} tag snapshot(s) older than ${TAG_SNAPSHOT_RETENTION_DAYS}d`);
    }
    if (JOB_LOG_RETENTION_DAYS) {
      const n = await pruneJobLog(db, Date.now() - JOB_LOG_RETENTION_DAYS * 86400000);
      if (n) console.log(`pruned ${n} job log row(s) older than ${JOB_LOG_RETENTION_DAYS}d`);
    }
  }

  async function reapGhostEntities() {
    if (Date.now() < nextReapAt) return;
    nextReapAt = Date.now() + 3600000; // hourly, like the snapshot prune
    const n = await reapEmptyEntities(db, REAP_AGE_MS);
    if (n) console.log(`worker: reaped ${n} empty ghost entit${n === 1 ? "y" : "ies"}`);
  }

  async function refreshDue() {
    if (Date.now() < refreshBackoffUntil) return false;
    const rows = await dueLiveEntities(db, Date.now(), REFRESH_BATCH);
    for (const row of rows) {
      try {
        await refreshDueEntity(db, row, Date.now(), { galleryDir, thumbsDir });
      } catch (err) {
        refreshBackoffUntil = Date.now() + 60000;
        await setEntityRefreshAt(db, row.entity.id, Date.now() + 60000); // retry later, don't wedge the sweep
        console.warn(`refresh error entity #${row.entity.id} (retrying in 60s): ${err.message}`);
        return false; // backed off — nothing to drain fast for
      }
    }
    return rows.length === REFRESH_BATCH; // full batch → more may be due, drain fast
  }

  // Ingestion sweep: run due boards' feeds (the worker tick is the cron — a
  // "continuous" folder watch is just a 30s rescan). Per board: enumerate the
  // source, drop everything ever ledgered (ingest_log — deletion in the app is
  // a user judgment the feed must not overturn), then filter/sort/limit with
  // the shared engine and admit through the adapter. Admissions are capped per
  // tick; a bigger logical run drains across ticks with next_run_at=now,
  // resuming from drain_left so the run's `limit` stays exact. Per-board
  // failures land in ingest_state with a 5-minute backoff — never the loop.
  const INGEST_CONTINUOUS_MS = Math.max(5000, Number(process.env.INGEST_CONTINUOUS_MS) || 30000);
  const INGEST_RUN_CAP = Math.max(1, Number(process.env.INGEST_RUN_CAP) || 25);

  // Fold a repeating non-event into its prior row: attempts up, error and
  // detail refreshed, this attempt's fresh row retracted. Without the fold a
  // failure repeating on its retry cadence is the flat-tick trap in failure
  // clothes — a transcriber outage writes a `requeued` row per 60 s backoff,
  // a wedged ingest scan one per 30 s tick (a weekend ≈ 3k identical rows).
  // The first occurrence and any CHANGE (a different error, something
  // admitted, the eventual resolution) still get their own rows.
  const foldJobRepeat = async (prior, freshId, { outcome, error = null, detail = {} }) => {
    await jobLogWrite(() => stampJobLog(db, prior.id, {
      outcome, error,
      detail: { ...detail, attempts: (Number(prior.detail?.attempts) || 1) + 1 },
      endedAt: Date.now(),
    }));
    if (freshId != null) await jobLogWrite(() => deleteJobLog(db, freshId));
  };

  async function ingestDue() {
    for (const b of await dueIngestBoards(db, Date.now())) {
      const cfg = b.ingest;
      const now = Date.now();
      const manual = cfg?.trigger?.mode === "manual";
      // One run = one job-log row, `running` while the feed is enumerated and
      // admitted — ingest has no other in-flight representation. ingest_state
      // keeps only the LAST run; these rows are where the history lives.
      const jobId = await jobLogWrite(() => addJobLog(db, {
        boardId: b.id, kind: "ingest", startedAt: now,
        detail: { trigger: cfg?.trigger?.mode || null },
      }));
      const stamp = (fields) => (jobId == null ? null : jobLogWrite(() => stampJobLog(db, jobId, fields)));
      try {
        const adapter = resolveIngestAdapter(b);
        if (!adapter) throw new Error("ingestion is not available for this board");
        if (!sources) throw new Error("ingestion is not available (worker started without sources)");
        const catalog = adapter.descriptor().filters;
        const { candidates } = await adapter.enumerate(db, b, cfg);
        const known = await ingestedKeys(db, b.id);
        const fresh = candidates.filter((c) => !known.has(c.key));
        // Budget: a drain tick resumes what's left of the current logical run
        // instead of re-slicing a fresh limit (keeps "top-N" semantics exact).
        const drainLeft = Number(b.ingest_state?.drain_left) || 0;
        const budget = drainLeft > 0 ? drainLeft : (Number(cfg.limit) || Infinity);
        const picked = applyLimit(applySort(applyFilters(fresh, cfg.filters, catalog), cfg.sort, catalog), budget);
        const batch = picked.slice(0, INGEST_RUN_CAP);
        let added = 0;
        let dups = 0;
        const errors = [];
        const skips = []; // labels — the "why did my file never get picked up" answer
        for (const c of batch) {
          try {
            await adapter.admit(db, b, c, { sources });
            added++;
          } catch (err) {
            // duplicate (already on the board) and skip (unsupported bytes)
            // are ledger-and-forget: stop rescanning them. Real errors stay
            // unledgered so the next run retries them.
            if (err.duplicate || err.skip) {
              await recordIngest(db, b.id, c.key, Date.now());
              if (err.skip) skips.push(c.label);
              else dups++;
            } else errors.push(`${c.label}: ${err.message}`);
          }
        }
        const remaining = picked.length - batch.length;
        await setIngestState(db, b.id, {
          last_run_at: now,
          last_added: added,
          last_error: errors[0] ?? null,
          ...(remaining > 0 ? { drain_left: remaining } : {}),
        });
        await setIngestNextRun(db, b.id,
          remaining > 0 ? Date.now() : nextIngestRunAt(cfg.trigger, Date.now(), { continuousMs: INGEST_CONTINUOUS_MS }));
        // A completed run is `ok` even with per-item errors (they're the run's
        // findings, carried in error/skipped) — `failed` means the run itself
        // died (the catch below). But an idle SCHEDULED scan (admitted
        // nothing, ledgered nothing, erred nothing, nothing draining) is a
        // flat tick, and a continuous watch flat-ticks every 30 seconds — the
        // tag_snapshots volume lesson. Retract its running row instead of
        // stamping it. A MANUAL run always keeps its row: the user asked, and
        // "0 admitted" is the answer. Skips and duplicates COUNT as events:
        // both ledger the file out of every future scan permanently, and the
        // row naming it is the only trace that ever happened.
        const eventful = added > 0 || errors.length > 0 || remaining > 0 || skips.length > 0 || dups > 0;
        if (!eventful && !manual && jobId != null) {
          await jobLogWrite(() => deleteJobLog(db, jobId));
        } else {
          // A scan whose ONLY news is the same per-item error as the prior
          // row's is a flat tick too (a wedged file on a continuous watch
          // ≈ 2,880 rows/day) — fold it instead of stamping a fresh row.
          const errorOnly = errors.length > 0 && !added && !skips.length && !dups && remaining === 0;
          const prior = errorOnly && !manual && jobId != null
            ? await jobLogWrite(() => latestSettledJob(db, b.id, "ingest"))
            : null;
          // Compare the STORED form — addJobLog caps error at 500 chars.
          const sameStory = prior?.outcome === "ok" && prior.error === String(errors[0] ?? "").slice(0, 500) &&
            !Number(prior.detail?.admitted) && !Number(prior.detail?.skipped) &&
            !Number(prior.detail?.duplicates) && !Number(prior.detail?.drain_left);
          if (sameStory) {
            await foldJobRepeat(prior, jobId, {
              outcome: "ok", error: errors[0],
              detail: { scanned: candidates.length, fresh: fresh.length },
            });
          } else {
            await stamp({
              outcome: "ok", error: errors[0] ?? null,
              detail: {
                scanned: candidates.length, fresh: fresh.length, admitted: added,
                skipped: skips.length, drain_left: remaining > 0 ? remaining : 0,
                ...(skips.length ? { skipped_labels: skips.slice(0, 20) } : {}),
                ...(dups ? { duplicates: dups } : {}),
              },
            });
          }
        }
        if (added) console.log(`ingest: board "${b.name}" +${added} item(s)${remaining ? ` (${remaining} to drain)` : ""}`);
      } catch (err) {
        // Scheduled triggers back off 5 minutes and retry; a manual run was
        // asked for ONCE — its outcome is this error (visible in the modal
        // status line), not a silent retry loop that runs forever until the
        // source heals. "Run now" re-arms it whenever the user wants.
        // Settle the schedule BEFORE publishing the error: last_error is what
        // observers poll for, so everything it implies (disarmed/backed off)
        // must already be true when it lands.
        await setIngestNextRun(db, b.id, manual ? null : Date.now() + 5 * 60000).catch(() => {});
        // Preserve a mid-drain budget across the failure — wiping it would
        // hand the retry a fresh `limit` and over-admit the logical run.
        const drainLeft = Number(b.ingest_state?.drain_left) || 0;
        await setIngestState(db, b.id, {
          last_run_at: now,
          last_added: 0,
          last_error: err.message,
          ...(drainLeft > 0 ? { drain_left: drainLeft } : {}),
        }).catch(() => {});
        // The same failure repeating on the retry cadence (a dead source =
        // one row per 5-minute backoff) folds into its prior row; a manual
        // run was asked for, so its row always stands alone.
        const prior = !manual && jobId != null
          ? await jobLogWrite(() => latestSettledJob(db, b.id, "ingest"))
          : null;
        if (prior?.outcome === "failed" && prior.error === String(err.message).slice(0, 500)) {
          await foldJobRepeat(prior, jobId, { outcome: "failed", error: err.message });
        } else {
          await stamp({ outcome: "failed", error: err.message });
        }
        console.warn(`ingest error board "${b.name}" (${manual ? "manual — not retried" : "retrying in 5m"}): ${err.message}`);
      }
    }
  }

  // One completed job-log row per pipeline-leg attempt (tag/extract/face).
  // The legs are visible via items.status while in flight, so they write no
  // `running` rows — started_at is the leg's entry time, one row per
  // execution at resolution. noCount waits (missing key, awaiting a
  // transcript) are gates, not attempts — the callers skip logging those.
  const legLog = (row, kind, t0, outcome, error = null, detail = {}) =>
    jobLogWrite(() => addJobLog(db, {
      boardId: row.board_id, entityId: row.entity_ids?.[0] ?? null, itemId: row.id,
      // The original filename, not payload.identity — for uploads the
      // identity is the vestigial STORED name (a hex string nobody recognizes).
      target: row.payload?.files?.[0]?.original_name || row.payload?.identity || null,
      kind, outcome, error, detail, startedAt: t0, endedAt: Date.now(),
    }));

  async function processOne(row) {
    const label = row.payload?.identity || `item ${row.id}`;
    const t0 = Date.now();
    let result;
    try {
      // Facet-less board: nothing to tag. Complete the item instead of failing
      // it — extraction-only boards (mapping, no facets) are a supported shape.
      if (!(await getBoardPrompt(db, row.board_id))) {
        if (await markTagged(db, row.id, [], false, {})) {
          await legLog(row, "tag", t0, "ok", null, { tags: 0 });
          console.log(`tagged #${row.id} ${label} [no facets — nothing to tag]`);
        } else {
          await legLog(row, "tag", t0, "discarded");
          console.warn(`stale tag result for #${row.id} ${label} discarded (re-routed or deleted mid-flight)`);
        }
        return;
      }
      result = await tagOne(row);
    } catch (err) {
      const failed = await failOrRequeue(db, row.id, err, MAX_ATTEMPTS);
      if (!err.noCount) await legLog(row, "tag", t0, failed ? "failed" : "requeued", err.message);
      console.warn(`tag error #${row.id} ${label}: ${err.message} (${failed ? "failed" : "requeued"})`);
      return;
    }
    // The paid call succeeded — a write failure past this point must not
    // requeue (that would bill a second call). Leave the row processing;
    // recoverStuck re-queues it later if markTagged itself was the casualty.
    // A DISCARD (fence: the user re-routed the row mid-call) is not a write
    // failure — their routing wins, the result is dropped, the tokens were
    // spent either way so usage still counts.
    try {
      const { tags, undecided, reasoning, usage, model } = result;
      const landed = await markTagged(db, row.id, tags, undecided, reasoning);
      await bumpUsage(db, row.board_id, usage);
      if (landed) {
        await legLog(row, "tag", t0, "ok", null, { tags: tags.length, model, ...(undecided ? { undecided: true } : {}) });
        console.log(`tagged #${row.id} ${label} [${model}]${undecided ? " (undecided)" : ""} -> [${tags.join(", ")}]`);
        await evaluateItemAlerts(db, row.id); // never throws — the ledger never breaks the job
      } else {
        await legLog(row, "tag", t0, "discarded", null, { model });
        console.warn(`stale tag result for #${row.id} ${label} discarded (re-routed or deleted mid-flight)`);
      }
    } catch (err) {
      // The execution happened, the result was lost — say exactly that.
      await legLog(row, "tag", t0, "failed", `post-tag write failed — left for recovery: ${err.message}`);
      console.warn(`post-tag write failed #${row.id} ${label}: ${err.message} (left for recovery)`);
    }
  }

  // Stamp the extract result; false = the fence discarded it (the row was
  // re-routed or deleted mid-flight — the user's routing wins, and their
  // fresh run re-derives; entity-side moves above the stamp self-heal there).
  async function stampExtracted(row, fields) {
    const landed = await markExtracted(db, row.id, fields);
    if (!landed) console.warn(`stale extract result for #${row.id} discarded (re-routed or deleted mid-flight)`);
    return landed;
  }

  // Run extraction for one pending_extract item. Resolves the board's AI the
  // same way tagOne does; writes payload.fields and advances to pending so the
  // normal tag leg picks it up next. When the mapping has derived identity,
  // resolves collisions by merging into the existing entity instead.
  // Returns a job-log summary for processExtractOne — { landed, fields,
  // identity, model } — or null for the no-AI passthrough (a status flip is
  // not an execution worth a history row).
  async function extractOne(row) {
    const mapping = row.payload.mapping;
    const aiWork =
      mapping?.identity?.from === "ai" ||
      (Array.isArray(mapping?.fields) && mapping.fields.some((f) => f.from === "ai"));
    if (!aiWork) {
      // Nothing for the model to do — the mapping is empty or all its fields
      // are connector/file-sourced (a connector vehicle's stamp lands here on
      // release). Advance without an AI call, keeping the fields the payload
      // already carries.
      await stampExtracted(row, row.payload.fields || {});
      return null;
    }
    const board = await getBoard(db, row.board_id);
    const aiFields = (mapping.fields || []).filter((f) => f.from === "ai");
    const objectFields = aiFields.filter((f) => f.kind === "object");
    // Object fields ride a separate detector pass below, not the LLM — so the
    // model is only called when there's derived identity or a non-object field
    // to extract. An object-only board skips the LLM entirely (ai/usage stay
    // null and the tail guards for it).
    const needsLLM = mapping?.identity?.from === "ai" || aiFields.some((f) => f.kind !== "object");

    let input = {}, usage = null, ai = null;
    if (needsLLM) {
      // Extraction uses its own provider override when set; otherwise falls back
      // to the board's tagging provider. Either way, the input is text-only (via
      // modelInputForExtract) so extraction works with any provider.
      const extractAi = board?.extract_key_id
        ? await resolveBoardAi(db, { aiKeyId: board.extract_key_id, aiModel: board.extract_model })
        : null;
      ai = extractAi || await resolveBoardAi(db, { aiKeyId: board?.ai_key_id, aiModel: board?.ai_model });
      if (!ai) throw noKeyError();

      const { systemText, schema } = buildFieldsPrompt(mapping);
      // Try text-only extraction first (works with any provider, avoids image
      // tokens for PDFs). Fall back to the full modelInputFor path for non-doc
      // files (images, connector entities) where there is no text sidecar — in
      // extract mode, so its anchors ask for record_fields, not record_tags.
      let parts = await modelInputForExtract(row.payload);
      if (!parts) {
        // The fallback anchors name the entity (no-file vehicles, chart faces).
        // Identity resolution below re-reads its own copy after the call, so a
        // mid-call rename never acts on this snapshot.
        const entity = row.entity_ids?.[0] ? await getEntity(db, row.entity_ids[0]) : null;
        parts = await modelInputFor(row.payload, entity, "extract");
      }
      ({ input, usage } = await trackedTagger(db, {
        provider: ai.provider,
        apiKey: ai.apiKey,
        base: ai.base,
        model: ai.model,
        systemText,
        schema,
        parts,
        tool: { name: "record_fields", description: "Record the extracted fields for this item." },
      }));
    }

    // Seed with the deterministic file fields projected from the stored entry,
    // so the payload.fields write below (markExtracted replaces the map) doesn't
    // drop them. Projected from the CURRENT board mapping (like the backfill), so
    // a file-field edit during the pending window still lands; the stamped mapping
    // only governs AI replay. Keys are unique, so AI fields never collide.
    const fields = extractFileFields(row.payload.files?.[0], board?.mapping?.fields || mapping.fields);
    // Lenient-validate each scalar AI field: wrong type → null (keep the why
    // sentence). Object fields are populated by the detector pass below, not here.
    for (const f of aiFields) {
      if (f.kind === "object") continue;
      const entry = input[f.key];
      if (!entry) continue;
      const why = typeof entry.why === "string" ? entry.why.trim() : "";
      let v = entry.value ?? null;
      if (v !== null) {
        if (f.kind === "number" && typeof v !== "number") v = null;
        if (f.kind === "url" && (typeof v !== "string" || !/^https?:\/\//.test(v))) v = null;
        if ((f.kind === "text" || f.kind === "date") && typeof v !== "string") v = null;
      }
      fields[f.key] = { v, why };
    }

    // Object-detection pass: a separate leg, not an LLM call. One field = one
    // object type; its queries are the hint (comma/newline-split synonyms for the
    // SAME thing), or the de-snaked field key when there's no hint (so a field
    // `license_plate` detects "license plate"). Every object field's queries run
    // in ONE detector pass (LLMDet takes all the queries at once), then each box is
    // routed back to its field by the matched query. A non-image item has nothing
    // to detect (empty, not an error); a detector failure throws → the extract leg
    // requeues, like extractor downtime. Boxes arrive canonical (xyxy, 0..1).
    if (objectFields.length) {
      const file = row.payload.files?.[0];
      const image = file?.kind === "image"
        ? await fs.promises.readFile(path.join(galleryDir, file.name))
        : null;
      if (!image) {
        for (const f of objectFields) fields[f.key] = { v: [], why: "no image to detect on" };
      } else {
        for (const f of objectFields) fields[f.key] = { v: [], why: "No objects detected" };
        // Build the query set, run ONE detection pass, demux boxes back to fields
        // by matched label (detectionDemux owns the sidecar-matching normalization).
        // The image is capped + oriented first (imageForDetection) — same boxes,
        // far less to ship to the single-threaded sidecar.
        const demux = detectionDemux(objectFields);
        const detector = await resolveDetector(db, board);
        const byField = demux.route(await detector.detect(await imageForDetection(image), demux.queries));
        for (const f of objectFields) {
          const v = byField.get(f.key) || [];
          fields[f.key].v = v;
          if (v.length) fields[f.key].why = `Detected: ${[...new Set(v.map((d) => d.label))].join(", ")}`;
        }
      }
    }

    // Derived identity: resolve the item's membership SET before advancing.
    // Extract and classify are the same path — extract yields one derived value,
    // classify yields zero-or-more from the candidate list; both become the set
    // of entity ids the item carries (entity_ids[0] canonical). The instance's
    // fields are written either way — they're its own. `disposition` feeds the
    // job-log summary; `landed` reports whether the stamp beat the fence.
    let landed = false;
    let disposition = null;
    if (mapping.identity?.from === "ai") {
      const classify = Array.isArray(mapping.identity.candidates) && mapping.identity.candidates.length > 0;
      // Classify: an allowed set keyed by normalised value → the candidate's
      // canonical spelling. The schema enum already forbids off-list answers on
      // strict providers, but a best-effort provider can still return one, so we
      // filter here too (mirrors the tagging leg's `allowed.has(t)` guard) — the
      // bounded set is the whole point. Display is the candidate's spelling, not
      // the model's echo, so the entity's name matches the list the user declared.
      const allowedByKey = classify
        ? new Map(mapping.identity.candidates.map((c) => [normaliseIdentity(c.value), c.value.trim()]))
        : null;
      const raw = classify
        ? (Array.isArray(input.identity?.values) ? input.identity.values : [])
        : (input.identity?.value != null ? [input.identity.value] : []);
      // Normalise + dedupe, preserving order (first stays canonical). In OPEN
      // mode the display name is the model's output verbatim — identity can be
      // anything ("INV-2026-04", "BTC-USD", a name, a date), so no cleanup
      // heuristic mangles someone's format; fuzzy matching lives only in the key.
      const seen = new Set();
      const derived = [];
      for (const v of raw) {
        if (typeof v !== "string" || !v.trim()) continue;
        const key = normaliseIdentity(v);
        if (classify && !allowedByKey.has(key)) continue; // drop off-list answers
        if (seen.has(key)) continue;
        seen.add(key);
        derived.push({ key, display: classify ? allowedByKey.get(key) : v.trim() });
      }

      const oldIds = row.entity_ids || [];
      if (derived.length === 0) {
        // AI derived nothing / matched no candidate. Keep the current membership;
        // flag provisional only on entities never identified (no display_name) —
        // an established entity keeps its identity, this instance just didn't add
        // evidence.
        disposition = "kept";
        for (const eid of oldIds) {
          const e = await getEntity(db, eid);
          if (e && !e.display_name) await markEntityProvisional(db, eid);
        }
        if ((landed = await stampExtracted(row, fields)))
          console.log(`extracted #${row.id} [no identity derived] [${ai.model}]`);
      } else {
        // Old entities this instance is the SOLE member of are safe to rename in
        // place (hearts/crate survive the identity change) — resolveIdentity
        // draws from this pool before minting a new entity.
        const reusable = [];
        for (const eid of oldIds) if ((await entityInstanceCount(db, eid)) <= 1) reusable.push(eid);
        const resolvedIds = [];
        for (const { key, display } of derived) {
          const id = await resolveIdentity(db, row.board_id, key, display, reusable, resolvedIds);
          if (!resolvedIds.includes(id)) resolvedIds.push(id);
        }
        // One transaction so a crash can't strand a ghost: the membership write
        // and the reconcile that drops whatever it emptied (merge) or stamps the
        // survivors (split) commit together — the atomicity the single-tx
        // reparentInstance had, before the array rewrite split it in two.
        await withTx(db, async (client) => {
          await setItemEntities(client, row.id, resolvedIds);
          await reconcileEntities(client, [...oldIds, ...resolvedIds]);
        });
        const same = oldIds.length === resolvedIds.length && oldIds.every((x) => resolvedIds.includes(x));
        disposition = same ? "derived" : "moved";
        if ((landed = await stampExtracted(row, fields)))
          console.log(`extracted #${row.id} identity=[${derived.map((d) => d.key).join(", ")}]${same ? "" : " (membership changed)"} [${ai.model}]`);
      }
    } else {
      const label = row.payload?.identity || `item ${row.id}`;
      if ((landed = await stampExtracted(row, fields)))
        console.log(`extracted #${row.id} ${label} [${ai?.model ?? "detection"}] -> [${Object.keys(fields).join(", ")}]`);
    }

    // A membership change re-homes the instance's tags into a different entity's
    // union — the across-instances case the matcher exists for. The tag leg that
    // follows usually re-evaluates the final entity anyway, but that leans on the
    // leg landing (a failed or fence-discarded tag run would strand the grown
    // union unexamined), so the move itself is the event. Dedupe makes the
    // double evaluation free.
    if (disposition === "moved") {
      await evaluateItemAlerts(db, row.id); // never throws — the ledger never breaks the job
    }

    if (usage) await bumpUsage(db, row.board_id, usage);
    return { landed, fields: Object.keys(fields).length, identity: disposition, model: ai?.model ?? "detection" };
  }

  async function processExtractOne(row) {
    const label = row.payload?.identity || `item ${row.id}`;
    const t0 = Date.now();
    try {
      const r = await extractOne(row);
      // null = the no-AI passthrough (a connector stamp; a status flip is not
      // an execution). Otherwise one row per attempt; `discarded` when the
      // fence dropped a stale result.
      if (r) await legLog(row, "extract", t0, r.landed ? "ok" : "discarded", null,
        { fields: r.fields, ...(r.identity ? { identity: r.identity } : {}), model: r.model });
    } catch (err) {
      const failed = await failOrRequeue(db, row.id, err, MAX_ATTEMPTS, "pending_extract");
      if (!err.noCount) await legLog(row, "extract", t0, failed ? "failed" : "requeued", err.message);
      console.warn(`extract error #${row.id} ${label}: ${err.message} (${failed ? "failed" : "requeued"})`);
    }
  }

  // Face leg: render the connector chart (if any) before the entity tags, so the
  // tagger sees it. A missing/ungenerable face leaves the tile; either way we
  // advance to the tag leg.
  async function processFaceOne(row) {
    const label = row.payload?.identity || `entity ${row.entity_ids?.[0]}`;
    const t0 = Date.now();
    try {
      const now = Date.now();
      const entity = row.entity_ids?.[0] ? await getEntity(db, row.entity_ids[0]) : null;
      const board = await getBoard(db, row.board_id);
      let rendered = false;
      let renderError = null;
      if (entity && board) {
        let face = null;
        // A face render failure isn't fatal — proceed to tag with the tile; the
        // sweep's self-heal retries the first render later.
        try { face = await generateFace(db, { galleryDir, thumbsDir }, entity, { id: row.id, payload: row.payload }, board, now); }
        catch (e) { renderError = e.message; console.warn(`face render failed for #${row.entity_ids?.[0]} ${label}: ${e.message} (tile)`); }
        rendered = !!face;
        await setEntityRefreshAt(db, entity.id, entityRefreshAt(entity.fields, face ? now : entity.face_at, board.mapping, now));
      }
      // rendered:false + render_error is the "why is my chart a tile" answer —
      // the leg still advances (outcome ok), but the log says what happened.
      const detail = {
        provider: board?.mapping?.input?.connector ?? null, rendered,
        ...(renderError ? { render_error: renderError } : {}),
      };
      // → pending (tag leg), or held when parked; false = fence discarded a
      // stale advance (the row was re-routed or deleted mid-render).
      if (await advanceFaced(db, row.id)) {
        await legLog(row, "face", t0, "ok", null, detail);
      } else {
        await legLog(row, "face", t0, "discarded", null, detail);
        console.warn(`stale face advance for #${row.id} ${label} discarded (re-routed or deleted mid-flight)`);
      }
    } catch (err) {
      const failed = await failOrRequeue(db, row.id, err, MAX_ATTEMPTS, "pending_face");
      if (!err.noCount) await legLog(row, "face", t0, failed ? "failed" : "requeued", err.message);
      console.warn(`face error #${row.id} ${label}: ${err.message} (${failed ? "failed" : "requeued"})`);
    }
  }

  // The claimed row's in-flight status names the step it needs.
  const STEP = { extracting: processExtractOne, facing: processFaceOne, processing: processOne };

  // --- per-resource lanes (worker-rework Stage 1) ---
  // The single-flight tick is gone. A dispatcher claims fair work and LAUNCHES it
  // without awaiting, bounded per resource by a lane counter, so each work type runs
  // at its own capacity and one lane's wait — a paced AI call, a slow OCR — never
  // blocks another. Maintenance (recovery + sweeps) runs on its own loop, so a slow
  // sweep can't stall the dispatcher either.
  const lane = (max) => { let used = 0; return { free: () => used < max, freeSlots: () => max - used, take: () => { used++; }, release: () => { used--; } }; };
  const aiLane = lane(AI_INFLIGHT), extractLane = lane(EXTRACT_CONCURRENCY), faceLane = lane(FACE_CONCURRENCY);

  // inFlight: ids this process is actively holding — recoverStuck skips them so it
  // can't reclaim a live call as "stuck" (Stage 0: recovery ownership). pipelines:
  // the live promises, awaited by stop() to drain on shutdown.
  const inFlight = new Set();
  const pipelines = new Set();
  let hasDefault = false; // refreshed each maintenance pass; read by the dispatcher

  let running = true;
  let wake = () => {};          // nudge the dispatcher (a lane freed, or new work)
  let maintainWake = () => {};
  let embedWake = () => {};
  let refreshWake = () => {};
  let transcribeWake = () => {};
  let alertsWake = () => {};

  // Fill one lane that has room with a single board-fair BATCH of its stage, sized to
  // the free slots — so boards interleave (a small board's items claim ahead of a big
  // board's backlog) instead of the oldest board monopolizing the lane. A batch, not
  // one-at-a-time: single-row claims collapse to FIFO. Each pipeline is fire-and-tracked
  // — on settle it frees its lane, leaves the in-flight sets, and nudges the dispatcher.
  async function fillLane(ln, stage) {
    const rows = await claimFairBatch(db, hasDefault, [stage], ln.freeSlots());
    for (const row of rows) {
      ln.take();
      inFlight.add(row.id);
      const p = STEP[row.status](row).finally(() => {
        ln.release();
        inFlight.delete(row.id);
        pipelines.delete(p);
        wake();
      });
      pipelines.add(p);
    }
  }

  // One pass over the lanes with room. Stops claiming once `running` is false so
  // shutdown drains cleanly; the dispatcher re-runs this on every completion/poll.
  async function fillLanes() {
    if (running && aiLane.free()) await fillLane(aiLane, "pending");
    if (running && extractLane.free()) await fillLane(extractLane, "pending_extract");
    if (running && faceLane.free()) await fillLane(faceLane, "pending_face");
  }

  // The dispatcher: keep the lanes full. Poll short while work is in flight (a
  // completion frees a lane — refill promptly, and cover any missed wake), long when
  // idle. wake() short-circuits the sleep.
  const dispatchLoop = (async () => {
    while (running) {
      try { await fillLanes(); }
      catch (e) { console.error("worker dispatch error:", e.message); }
      if (!running) break;
      await new Promise((r) => {
        const t = setTimeout(r, inFlight.size ? 250 : POLL_MS);
        wake = () => { clearTimeout(t); r(); };
      });
    }
  })();

  // Maintenance: recovery + the LIGHT coordination sweeps (retag scheduling, ingestion,
  // prune) on a cadence, off the dispatcher's path so a slow sweep can't stall claims.
  // The heavy throughput sweeps (embedding, liveness refresh) moved to their own loops
  // below (Stage 3), so a big embed backlog or a slow connector can't delay recovery or
  // ingestion. Nudges the dispatcher after, since retag/ingest may have created work.
  const maintainLoop = (async () => {
    while (running) {
      try {
        const recovered = await recoverStuck(db, STUCK_MS, MAX_ATTEMPTS, [...inFlight]);
        if (recovered) console.log(`worker: recovered ${recovered} stuck item(s)`);
        hasDefault = !!(await resolveDefaultAi(db));
        await retagDue();
        await ingestDue();
        await pruneSnapshots();
        await reapGhostEntities();
        // Scheduled DB-only backup (server/backup.js) — it no-ops unless due
        // and skips itself while any backup/restore job is running.
        if (autoBackup) await autoBackup();
      } catch (e) { console.error("worker maintain error:", e.message); }
      if (!running) break;
      wake();
      await new Promise((r) => {
        const t = setTimeout(r, POLL_MS);
        maintainWake = () => { clearTimeout(t); r(); };
      });
    }
  })();

  // Embedding sweep on its own loop (Stage 3): the vector backfill runs off the
  // coordination tick, so a slow provider or a big backlog can't delay recovery,
  // ingestion, or the scheduled retag. Drains fast — polls short after a full batch,
  // idles at POLL_MS otherwise (its own backoff still gates provider errors).
  const embedLoop = (async () => {
    while (running) {
      let more = false;
      try { more = await embedDue(); }
      catch (e) { console.error("worker embed error:", e.message); }
      if (!running) break;
      await new Promise((r) => {
        const t = setTimeout(r, more ? 200 : POLL_MS);
        embedWake = () => { clearTimeout(t); r(); };
      });
    }
  })();

  // Liveness refresh on its own loop (Stage 3): same reasoning as embedLoop — a slow
  // connector refreshing due entities can't stall the coordination tick, and a full
  // batch drains fast rather than one per maintenance pass. Unlike embedLoop it nudges
  // the dispatcher after each pass: a moved field can requeue an entity for re-tag
  // (retag_on_refresh), and maintainLoop used to deliver that wake when refreshDue lived
  // there. Embedding never creates claimable work, so embedLoop needs no such wake.
  const refreshLoop = (async () => {
    while (running) {
      let more = false;
      try { more = await refreshDue(); }
      catch (e) { console.error("worker refresh error:", e.message); }
      if (!running) break;
      wake();
      await new Promise((r) => {
        const t = setTimeout(r, more ? 200 : POLL_MS);
        refreshWake = () => { clearTimeout(t); r(); };
      });
    }
  })();

  // Alert delivery on its own loop (the embedLoop reasoning): a webhook send
  // is outbound I/O with a 10s timeout, and a hung endpoint retried across
  // several firings would otherwise sit inside the maintenance tick, delaying
  // recovery and ingestion. Nothing here creates claimable work — no wake().
  const alertsLoop = (async () => {
    while (running) {
      try { await deliverDueAlerts(db); }
      catch (e) { console.error("worker alerts error:", e.message); }
      if (!running) break;
      await new Promise((r) => {
        const t = setTimeout(r, POLL_MS);
        alertsWake = () => { clearTimeout(t); r(); };
      });
    }
  })();

  // Transcription loop — dedicated, separate from the tick, so a multi-minute
  // clip never blocks tagging/embedding/ingestion. It's I/O-bound (awaits the
  // sidecar), so it runs concurrently. It queries audio by payload (not status),
  // so EVERY audio item is transcribed regardless of tagging; the transcript
  // lands on payload.transcript for the tagger, the embedder, and the lightbox.
  let transcribeBackoffUntil = 0; // lane-wide: the engine itself is unwell
  // Per-clip retry ledger: itemId → { attempts, until }. A fault tied to ONE
  // clip (its job stalled, vanished, or hit an inference error) backs off and
  // caps here, so a pathological clip can't freeze the whole audio lane the way
  // the old single global backoff did — the query below skips clips in backoff.
  const transcribeRetry = new Map();
  const transcribeLoop = (async () => {
    while (running) {
      let did = false;
      try {
        if (Date.now() >= transcribeBackoffUntil) {
          const waiting = [...transcribeRetry.entries()].filter(([, r]) => r.until > Date.now()).map(([id]) => id);
          const row = await oneAudioNeedingTranscription(db, waiting);
          if (row) {
            did = true;
            const file = row.payload.files?.[0];
            // A `running` job-log row is the only place "transcribing now"
            // exists — this sweep has no items.status leg. Each attempt is its
            // own row (a transient retry after the backoff opens a fresh one).
            const jobId = await jobLogWrite(() => addJobLog(db, {
              boardId: row.board_id, entityId: row.entity_ids?.[0] ?? null, itemId: row.id,
              target: file?.original_name || file?.name || null, kind: "transcribe",
            }));
            const stamp = (fields) => (jobId == null ? null : jobLogWrite(() => stampJobLog(db, jobId, fields)));
            try {
              if (!file) throw new Error("no file on the item");
              const transcriber = await resolveTranscriber(db);
              const buf = await fs.promises.readFile(path.join(galleryDir, file.name));
              const text = await transcriber.transcribe(buf, file.name);
              await updateItemPayload(db, row.id, { transcript: text });
              transcribeRetry.delete(row.id);
              // whisper's model is the sidecar's own answer (null if it predates self-reporting)
              await stamp({ outcome: "ok", detail: { chars: text.length, engine: [transcriber.id, transcriber.model].filter(Boolean).join(":") } });
              console.log(`transcribed #${row.id} "${file.original_name}" -> ${text.length} chars`);
            } catch (err) {
              const attempts = transcribeRetry.get(row.id)?.attempts || 0;
              const action = transcribeFailurePolicy(err, attempts);
              if (action === "backoff-lane" || action === "backoff-item") {
                if (action === "backoff-lane") {
                  transcribeBackoffUntil = Date.now() + 60000;
                  did = false; // nothing else would succeed either — sleep the full poll
                } else {
                  transcribeRetry.set(row.id, { attempts: attempts + 1, until: Date.now() + 60000 });
                }
                // Consecutive transient retries of one clip are one story,
                // not one row per backoff tick: fold into the clip's prior
                // `requeued` row — attempts up, error and end time refreshed.
                // The first failure and the eventual resolution (ok/failed)
                // keep their own rows, and the fold survives restarts because
                // the prior row is found in the ledger, not in memory.
                const prior = jobId == null ? null
                  : await jobLogWrite(() => latestSettledJob(db, row.board_id, "transcribe", row.id));
                if (prior?.outcome === "requeued") {
                  await foldJobRepeat(prior, jobId, { outcome: "requeued", error: err.message });
                } else {
                  await stamp({ outcome: "requeued", error: err.message });
                }
                console.warn(`transcribe: transient ${action === "backoff-lane" ? "engine" : `clip #${row.id}`} error (retry in 60s): ${err.message}`);
              } else {
                // Park the clip — a permanent fault (undecodable, provider 4xx)
                // or a transient one out of attempts. The queue moves on; it'll
                // tag from its filename, like a textless document. A reprocess
                // clears transcript_error to grant a fresh set of attempts.
                const note = action === "park-capped"
                  ? `gave up after ${attempts + 1} attempts: ${err.message}` : err.message;
                await updateItemPayload(db, row.id, { transcript_error: String(note).slice(0, 300) });
                transcribeRetry.delete(row.id);
                await stamp({ outcome: "failed", error: note });
                console.warn(`transcribe failed #${row.id} "${file?.original_name}": ${note}`);
              }
            }
          }
        }
      } catch (e) {
        console.error("transcribe loop error:", e.message);
      }
      if (!running) break;
      await new Promise((r) => {
        const t = setTimeout(r, did ? 200 : POLL_MS);
        transcribeWake = () => { clearTimeout(t); r(); };
      });
    }
  })();

  resolveDefaultAi(db).then((ai) => {
    if (ai) {
      console.log(`AI tagging worker started (default ${ai.provider}/${ai.model}, per-board overrides in board settings; lanes ${AI_INFLIGHT} AI / ${EXTRACT_CONCURRENCY} extract / ${FACE_CONCURRENCY} face).`);
    } else {
      console.log(`AI tagging worker started (no default key — only boards with their own key will tag; lanes ${AI_INFLIGHT} AI / ${EXTRACT_CONCURRENCY} extract / ${FACE_CONCURRENCY} face).`);
    }
  }).catch((e) => console.warn(`worker: default-AI probe failed at start: ${e.message}`)); // log-only — an unhandled rejection here would crash the boot
  // Stop claiming immediately; the returned promise resolves once the
  // in-flight tick (if any) has finished, so callers can drain before exit.
  return () => {
    running = false;
    wake();
    maintainWake();
    embedWake();
    refreshWake();
    transcribeWake();
    alertsWake();
    // Drain: let the loops finish their current pass and stop claiming, THEN await the
    // in-flight pipelines (captured after the loops settle, so a final fill's launches
    // are included). server.js caps the total wait.
    return (async () => {
      await Promise.all([dispatchLoop, maintainLoop, embedLoop, refreshLoop, transcribeLoop, alertsLoop]);
      await Promise.all([...pipelines]);
    })();
  };
}
