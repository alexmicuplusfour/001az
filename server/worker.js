import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  claimNextPending,
  claimNextPendingExtract,
  claimNextPendingFace,
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
  setItemEmbedding,
  setItemEmbedError,
  getEntity,
  getEntityByIdentity,
  createEntity,
  setEntityIdentity,
  markEntityProvisional,
  reparentItem,
  entityInstanceCount,
  deleteEntityIfEmpty,
  dueLiveEntities,
  updateEntityFields,
  setEntityRefreshAt,
  addFieldSnapshot,
  pruneFieldSnapshots,
  requeueItemForTag,
  advanceFaced,
} from "./db.js";
import { callTagger, embedTexts, PROVIDERS } from "./providers.js";
import { getConnector } from "./connectors/index.js";
import { entityRefreshAt, faceCadence } from "./connectors/runtime.js";
import { extractFileFields } from "./media/index.js";

// The app-default tagger: settings-designated key, else the legacy env var.
// Returns { provider, apiKey, model } or null when nothing is configured.
export async function resolveDefaultAi(db) {
  const defId = Number(await getSetting(db, "default_key_id")) || 0;
  if (defId) {
    const key = await getAiKey(db, defId);
    if (key) {
      const model = (await getSetting(db, "model")) || PROVIDERS[key.provider].defaultModel;
      return { provider: key.provider, apiKey: key.api_key, model };
    }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: (await getSetting(db, "model")) || process.env.MODEL || PROVIDERS.anthropic.defaultModel,
    };
  }
  return null;
}

// The app-global embedder for semantic search: enabled flag + provider choice.
// 'local' uses the on-server ONNX model (no key); otherwise a stored API key
// is looked up. Returns { provider, apiKey, model } or null when off/missing.
export async function resolveEmbedder(db) {
  if ((await getSetting(db, "embed_enabled")) !== "1") return null;
  const embedProvider = await getSetting(db, "embed_provider");
  if (embedProvider === "local") {
    return { provider: "local", apiKey: null, model: PROVIDERS.local.embeds.default };
  }
  // Key-based path (backward compat: embed_provider null + embed_key_id set).
  const keyId = Number(await getSetting(db, "embed_key_id")) || 0;
  if (!keyId) return null;
  const key = await getAiKey(db, keyId);
  if (!key || !PROVIDERS[key.provider]?.embeds) return null;
  return {
    provider: key.provider,
    apiKey: key.api_key,
    model: (await getSetting(db, "embed_model")) || PROVIDERS[key.provider].embeds.default,
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
  const text = parts.join("\n") || payload.files?.[0]?.original_name || payload.identity || "untitled item";
  return text.slice(0, EMBED_TEXT_MAX_CHARS);
}

// A board's effective tagger: its own key (+ model) when set, else the default.
async function resolveBoardAi(db, boardEntry) {
  if (boardEntry.aiKeyId) {
    const key = await getAiKey(db, boardEntry.aiKeyId);
    if (key) {
      return {
        provider: key.provider,
        apiKey: key.api_key,
        model: boardEntry.aiModel || PROVIDERS[key.provider].defaultModel,
      };
    }
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

// Build the extraction prompt + strict schema for a mapping's AI fields.
// Pure function — no cache needed (extraction runs once per item; mappings
// vary per item so a board-level cache wouldn't help).
export function buildFieldsPrompt(mapping) {
  // Only AI fields are extracted here; file fields (from:"file") are projected
  // deterministically from the stored entry, connector fields come from the source.
  const fields = ((mapping && mapping.fields) || []).filter((f) => f.from === "ai");
  const hasDerivedIdentity = mapping?.identity?.from === "ai";
  const identityHint = hasDerivedIdentity ? (mapping.identity.hint || "").trim() : "";
  const lines = fields.map((f) => `- ${f.key} (${f.kind}): ${f.hint || f.key}`);

  // Identity is just another extraction field to the model: its hint rides in
  // the system-text field list like everyone else's, first (mirroring schema
  // order). Framing it as "the entity's unique key" made models favour
  // uniqueness over the user's format (echoing filenames verbatim), so that
  // consistency guidance survives only as the fallback when no hint was given —
  // there it's the only signal the model has, and merge/split needs same
  // subject → same value.
  if (hasDerivedIdentity) {
    lines.unshift(`- identity (text): ${identityHint ||
      "a short name for what this item is about — the same subject must always produce the same value"}`);
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

  // Identity key is declared first so the model commits to it before extracting fields.
  if (hasDerivedIdentity) {
    properties.identity = {
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
  const call = (rs) => embedTexts({
    provider: embedder.provider,
    apiKey: embedder.apiKey,
    model: embedder.model,
    texts: rs.map((r) => embedTextFor(r.tags, r.tag_reasoning, r.payload)),
  });
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
      failures.push({ id: r.id, message: String(e?.message ?? e) });
    }
  }
  if (!embedded) throw new Error(failures[0].message);
  for (const f of failures) {
    await setItemEmbedError(db, f.id, f.message);
    console.warn(`embed: skipping item #${f.id} (${f.message}) — re-tagging retries it`);
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
    if (board.retag_on_refresh && board.auto_tag) { await requeueItemForTag(db, inst.id); requeued = true; }
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
  await fs.promises.writeFile(path.join(galleryDir, name), rendered.webp);
  await fs.promises.writeFile(path.join(thumbsDir, name + ".webp"), rendered.webp);
  const face = { name, kind: "image", generated: true, w: rendered.w, h: rendered.h };
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

export function startWorker({ db, thumbsDir, galleryDir }) {
  const POLL_MS = Number(process.env.POLL_MS || 3000);
  const STUCK_MS = Number(process.env.STUCK_MS || 180000);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
  const CONCURRENCY = Math.max(1, Number(process.env.TAG_CONCURRENCY) || 4);
  const TEXT_DOC_MAX_CHARS = 50000; // ~12k tokens; plenty for tagging judgment

  // What the model sees for an item: parts built from its files by kind.
  // Images: the thumbnail (cheap) rather than the original. Documents: their
  // extracted text (documentTextFor), so every provider can tag them; PDFs
  // additionally carry their page-1 thumbnail so visual/style facets keep
  // their signal, and fall back to an Anthropic-only document block when the
  // document genuinely has no text layer (extractor DOWNTIME throws instead —
  // the retry queue waits it out rather than paying per-page billing).
  async function modelInputFor(payload, entity = null) {
    const file = payload.files?.[0];
    if (!file) {
      // Instance with no material file (connector tag vehicle): the
      // bound-fields dossier appended by tagOne is the material; anchor it
      // with the entity's name.
      return [{
        kind: "text",
        text: `The item is an entity named "${entity?.display_name || entity?.identity || payload.identity}". Tag it using the record_tags tool, judging from its extracted fields below.`,
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
            `:\n\n${text.slice(0, TEXT_DOC_MAX_CHARS)}\n\nTag this document using the record_tags tool.`,
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
        { kind: "text", text: "Tag this document using the record_tags tool." },
      ];
    }
    if (file.kind === "text" || file.kind === "docx") {
      const text = await documentTextFor(galleryDir, file);
      return [{
        kind: "text",
        text: `The item is the following document ("${file.original_name}"):\n\n${text.slice(0, TEXT_DOC_MAX_CHARS)}\n\nTag this document using the record_tags tool.`,
      }];
    }
    const buf = await fs.promises.readFile(path.join(thumbsDir, file.name + ".webp"));
    // A generated connector face (e.g. a price chart) gets a chart-aware anchor
    // so the tagger reads the trend, not a generic "image".
    const anchor = file.generated
      ? `This is a price chart for "${entity?.display_name || entity?.identity || payload.identity}". Tag it using the record_tags tool, judging from the chart and the extracted fields below.`
      : "Tag this image using the record_tags tool.";
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
    const text = await documentTextFor(galleryDir, file);
    if (!text.trim()) return null;
    return [{
      kind: "text",
      text: `The item is the following document ("${file.original_name}"):\n\n${text.slice(0, TEXT_DOC_MAX_CHARS)}\n\nExtract the requested fields using the record_fields tool.`,
    }];
  }

  async function tagOne(row) {
    const prompt = await getBoardPrompt(db, row.board_id);
    if (!prompt) throw new Error(`board ${row.board_id} has no facets configured`);
    const { systemText, schema, allowed, facets } = prompt;

    const ai = await resolveBoardAi(db, prompt);
    if (!ai) throw noKeyError();

    const entity = row.entity_id ? await getEntity(db, row.entity_id) : null;
    const parts = await modelInputFor(row.payload, entity);
    // Distilled extraction results ride along as a text part so the tagger
    // sees the structured data without re-reading the raw material. Entity
    // fields (connector-bound) come first, the instance's own extractions
    // override on key collision.
    const fields = { ...(entity?.fields || {}), ...(row.payload.fields || {}) };
    const fieldLines = Object.entries(fields)
      .filter(([, { v }]) => v !== null && v !== undefined)
      .map(([key, { v }]) => `${key}: ${v}`);
    if (entity?.display_name) fieldLines.unshift(`entity: ${entity.display_name}`);
    if (fieldLines.length) parts.push({ kind: "text", text: `Extracted fields:\n${fieldLines.join("\n")}` });
    const { input, usage } = await callTagger({
      provider: ai.provider,
      apiKey: ai.apiKey,
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
      if (queued) console.log(`scheduled retag: queued ${queued} item(s) in board "${b.name}"`);
      else if (skipped) console.log(`scheduled retag: board "${b.name}" skipped (weekend) — rescheduled`);
    }
  }

  // Embedding sweep: (re)vectorize tagged items with no current-model vector.
  // This single path covers fresh tags (markTagged clears the vector), manual
  // edits, turning the feature on late, and model changes — one batched API
  // call per tick (embedBatch isolates poison inputs so one bad item can't
  // wedge the backfill). Batch-level failures back off for a minute so a bad
  // key or outage doesn't turn the poll loop into an API hammer.
  const EMBED_BATCH = Math.max(1, Number(process.env.EMBED_BATCH) || 64);
  let embedBackoffUntil = 0;
  async function embedDue() {
    if (Date.now() < embedBackoffUntil) return;
    const embedder = await resolveEmbedder(db);
    if (!embedder) return;
    const rows = await itemsNeedingEmbedding(db, embedder.model, EMBED_BATCH);
    if (!rows.length) return;
    try {
      const { embedded, skipped } = await embedBatch(db, embedder, rows);
      console.log(`embedded ${embedded} item(s)${skipped ? `, skipped ${skipped}` : ""} [${embedder.model}]`);
    } catch (err) {
      embedBackoffUntil = Date.now() + 60000;
      console.warn(`embed error (retrying in 60s): ${err.message}`);
    }
  }

  // Liveness sweep: refresh entities whose live connector fields are due. Same
  // bounded-batch + backoff discipline as embedDue so a provider outage can't
  // turn the sweep into an API hammer. The per-entity work is refreshDueEntity
  // (module scope, exported for tests).
  const REFRESH_BATCH = Math.max(1, Number(process.env.REFRESH_BATCH) || 20);
  let refreshBackoffUntil = 0;

  // Movement-history retention: field_snapshots older than this are dropped.
  // 0 disables the prune (keep forever). Checked hourly, not per tick — the
  // DELETE is cheap but there's no point running it every 3s.
  const SNAPSHOT_RETENTION_DAYS = Number(process.env.SNAPSHOT_RETENTION_DAYS ?? 90);
  let nextPruneAt = 0;
  async function pruneSnapshots() {
    if (!SNAPSHOT_RETENTION_DAYS || Date.now() < nextPruneAt) return;
    nextPruneAt = Date.now() + 3600000;
    const n = await pruneFieldSnapshots(db, Date.now() - SNAPSHOT_RETENTION_DAYS * 86400000);
    if (n) console.log(`pruned ${n} field snapshot(s) older than ${SNAPSHOT_RETENTION_DAYS}d`);
  }

  async function refreshDue() {
    if (Date.now() < refreshBackoffUntil) return;
    const rows = await dueLiveEntities(db, Date.now(), REFRESH_BATCH);
    for (const row of rows) {
      try {
        await refreshDueEntity(db, row, Date.now(), { galleryDir, thumbsDir });
      } catch (err) {
        refreshBackoffUntil = Date.now() + 60000;
        await setEntityRefreshAt(db, row.entity.id, Date.now() + 60000); // retry later, don't wedge the sweep
        console.warn(`refresh error entity #${row.entity.id} (retrying in 60s): ${err.message}`);
        break;
      }
    }
  }

  async function processOne(row) {
    const label = row.payload?.identity || `item ${row.id}`;
    let result;
    try {
      // Facet-less board: nothing to tag. Complete the item instead of failing
      // it — extraction-only boards (mapping, no facets) are a supported shape.
      if (!(await getBoardPrompt(db, row.board_id))) {
        await markTagged(db, row.id, [], false, {});
        console.log(`tagged #${row.id} ${label} [no facets — nothing to tag]`);
        return;
      }
      result = await tagOne(row);
    } catch (err) {
      const failed = await failOrRequeue(db, row.id, err, MAX_ATTEMPTS);
      console.warn(`tag error #${row.id} ${label}: ${err.message} (${failed ? "failed" : "requeued"})`);
      return;
    }
    // The paid call succeeded — a write failure past this point must not
    // requeue (that would bill a second call). Leave the row processing;
    // recoverStuck re-queues it later if markTagged itself was the casualty.
    try {
      const { tags, undecided, reasoning, usage, model } = result;
      await markTagged(db, row.id, tags, undecided, reasoning);
      await bumpUsage(db, row.board_id, usage);
      console.log(`tagged #${row.id} ${label} [${model}]${undecided ? " (undecided)" : ""} -> [${tags.join(", ")}]`);
    } catch (err) {
      console.warn(`post-tag write failed #${row.id} ${label}: ${err.message} (left for recovery)`);
    }
  }

  // Normalise a derived identity value for consistent collision detection.
  // Underscores and hyphens are treated as word separators so the AI returning
  // "priya_ramanathan" or "Priya Ramanathan" both key to "priya ramanathan".
  const normaliseIdentity = (s) => s.trim().replace(/[-_\s]+/g, " ").toLowerCase();

  // Move an instance under the entity that already holds its derived
  // identity, keeping the fields and tags it just earned (merge and split are
  // the same move: re-parent, then drop the old entity if it emptied out).
  // The latest derivation wins the display name — identity can be anything
  // (a name, a code, a date), so no cased-preference heuristics.
  async function reparentInto(row, target, displayName, oldEntityId) {
    await reparentItem(db, row.id, target.id);
    if (displayName !== target.display_name) await setEntityIdentity(db, target.id, target.identity, displayName);
    if (await deleteEntityIfEmpty(db, oldEntityId)) {
      console.log(`merge: instance #${row.id} re-parented into entity #${target.id} ("${target.identity}"), empty entity #${oldEntityId} deleted`);
    } else {
      console.log(`split: instance #${row.id} re-parented into entity #${target.id} ("${target.identity}")`);
    }
  }

  // Run extraction for one pending_extract item. Resolves the board's AI the
  // same way tagOne does; writes payload.fields and advances to pending so the
  // normal tag leg picks it up next. When the mapping has derived identity,
  // resolves collisions by merging into the existing entity instead.
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
      await markExtracted(db, row.id, row.payload.fields || {});
      return;
    }
    const board = await getBoard(db, row.board_id);
    // Extraction uses its own provider override when set; otherwise falls back
    // to the board's tagging provider. Either way, the input is text-only (via
    // modelInputForExtract) so extraction works with any provider.
    const extractAi = board?.extract_key_id
      ? await resolveBoardAi(db, { aiKeyId: board.extract_key_id, aiModel: board.extract_model })
      : null;
    const ai = extractAi || await resolveBoardAi(db, { aiKeyId: board?.ai_key_id, aiModel: board?.ai_model });
    if (!ai) throw noKeyError();

    const { systemText, schema } = buildFieldsPrompt(mapping);
    // Try text-only extraction first (works with any provider, avoids image
    // tokens for PDFs). Fall back to the full modelInputFor path for non-doc
    // files (images, connector entities) where there is no text sidecar.
    const parts = await modelInputForExtract(row.payload) ?? await modelInputFor(row.payload);
    const { input, usage } = await callTagger({
      provider: ai.provider,
      apiKey: ai.apiKey,
      model: ai.model,
      systemText,
      schema,
      parts,
      tool: { name: "record_fields", description: "Record the extracted fields for this item." },
    });

    // Seed with the deterministic file fields projected from the stored entry,
    // so the payload.fields write below (markExtracted replaces the map) doesn't
    // drop them. Projected from the CURRENT board mapping (like the backfill), so
    // a file-field edit during the pending window still lands; the stamped mapping
    // only governs AI replay. Keys are unique, so AI fields never collide.
    const fields = extractFileFields(row.payload.files?.[0], board?.mapping?.fields || mapping.fields);
    // Lenient-validate each AI field: wrong type → null (keep the why sentence).
    for (const f of (mapping.fields || []).filter((f) => f.from === "ai")) {
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

    // Derived identity: resolve against the parent entity before advancing.
    // The instance's fields are written either way — they're its own.
    if (mapping.identity?.from === "ai") {
      const entity = await getEntity(db, row.entity_id);
      const rawIdentity = input.identity?.value;
      if (!entity) {
        // Orphan instance (shouldn't happen) — extract what we can and move on.
        await markExtracted(db, row.id, fields);
        console.warn(`extracted #${row.id} [no parent entity — skipped identity resolution] [${ai.model}]`);
      } else if (!rawIdentity || typeof rawIdentity !== "string" || !rawIdentity.trim()) {
        // AI couldn't derive an identity. Only flag provisional on entities
        // that were never identified (no display_name); established entities
        // keep their identity — this instance just didn't add evidence.
        const established = !!entity.display_name;
        if (!established) await markEntityProvisional(db, entity.id);
        await markExtracted(db, row.id, fields);
        console.log(`extracted #${row.id} [no identity derived${established ? " — keeping entity identity" : " — provisional"}] [${ai.model}]`);
      } else {
        // The display name is the model's output verbatim — identity can be
        // anything ("INV-2026-04", "BTC-USD", a name, a date), so any cleanup
        // heuristic mangles someone's format. Fuzzy matching lives only in the
        // invisible collision key (normaliseIdentity).
        const newDisplayName = rawIdentity.trim();
        const derived = normaliseIdentity(rawIdentity);
        if (entity.identity === derived) {
          // Same key — refresh the display name to this derivation and make
          // sure the provisional flag is gone.
          await setEntityIdentity(db, entity.id, derived, newDisplayName);
          await markExtracted(db, row.id, fields);
          console.log(`extracted #${row.id} identity="${derived}" [${ai.model}]`);
        } else {
          const other = await getEntityByIdentity(db, row.board_id, derived);
          if (other) {
            // Another entity already holds this identity — merge (or split
            // away from a multi-instance entity): re-parent this instance.
            await reparentInto(row, other, newDisplayName, entity.id);
            await markExtracted(db, row.id, fields);
          } else if ((await entityInstanceCount(db, entity.id)) <= 1) {
            // Sole instance and nobody holds the derived key: establish a
            // provisional entity, or rename an established one whose identity
            // changed on re-extract — in place either way, so hearts and
            // crate membership survive.
            try {
              await setEntityIdentity(db, entity.id, derived, newDisplayName);
              await markExtracted(db, row.id, fields);
              console.log(`extracted #${row.id} identity="${derived}" [${ai.model}]`);
            } catch (err) {
              if (err.code !== "23505") throw err;
              // Race: the identity appeared since the lookup — merge instead.
              const winner = await getEntityByIdentity(db, row.board_id, derived);
              if (!winner) throw err;
              await reparentInto(row, winner, newDisplayName, entity.id);
              await markExtracted(db, row.id, fields);
            }
          } else {
            // Split: this instance belongs to someone new; the rest of the
            // entity stays as it is.
            let targetId;
            try {
              targetId = await createEntity(db, row.board_id, { identity: derived, displayName: newDisplayName });
            } catch (err) {
              if (err.code !== "23505") throw err;
              const winner = await getEntityByIdentity(db, row.board_id, derived);
              if (!winner) throw err;
              targetId = winner.id;
            }
            await reparentItem(db, row.id, targetId);
            await markExtracted(db, row.id, fields);
            console.log(`split: instance #${row.id} detached from entity #${entity.id} into #${targetId} ("${derived}")`);
          }
        }
      }
    } else {
      await markExtracted(db, row.id, fields);
      const label = row.payload?.identity || `item ${row.id}`;
      console.log(`extracted #${row.id} ${label} [${ai.model}] -> [${Object.keys(fields).join(", ")}]`);
    }

    await bumpUsage(db, row.board_id, usage);
  }

  async function processExtractOne(row) {
    const label = row.payload?.identity || `item ${row.id}`;
    try {
      await extractOne(row);
    } catch (err) {
      const failed = await failOrRequeue(db, row.id, err, MAX_ATTEMPTS, "pending_extract");
      console.warn(`extract error #${row.id} ${label}: ${err.message} (${failed ? "failed" : "requeued"})`);
    }
  }

  // Face leg: render the connector chart (if any) before the entity tags, so the
  // tagger sees it. A missing/ungenerable face leaves the tile; either way we
  // advance to the tag leg.
  async function processFaceOne(row) {
    const label = row.payload?.identity || `entity ${row.entity_id}`;
    try {
      const now = Date.now();
      const entity = row.entity_id ? await getEntity(db, row.entity_id) : null;
      const board = await getBoard(db, row.board_id);
      if (entity && board) {
        let face = null;
        // A face render failure isn't fatal — proceed to tag with the tile; the
        // sweep's self-heal retries the first render later.
        try { face = await generateFace(db, { galleryDir, thumbsDir }, entity, { id: row.id, payload: row.payload }, board, now); }
        catch (e) { console.warn(`face render failed for #${row.entity_id} ${label}: ${e.message} (tile)`); }
        await setEntityRefreshAt(db, entity.id, entityRefreshAt(entity.fields, face ? now : entity.face_at, board.mapping, now));
      }
      await advanceFaced(db, row.id); // → pending (tag leg), or held when parked
    } catch (err) {
      const failed = await failOrRequeue(db, row.id, err, MAX_ATTEMPTS, "pending_face");
      console.warn(`face error #${row.id} ${label}: ${err.message} (${failed ? "failed" : "requeued"})`);
    }
  }

  async function tick() {
    const recovered = await recoverStuck(db, STUCK_MS, MAX_ATTEMPTS);
    if (recovered) console.log(`worker: recovered ${recovered} stuck item(s)`);
    await retagDue();
    await embedDue();
    await refreshDue();
    await pruneSnapshots();

    // Boards without their own key only process when a default exists.
    const hasDefault = !!(await resolveDefaultAi(db));

    // Extract leg has priority: pending_extract items go before pending.
    const extractRows = [];
    while (extractRows.length < CONCURRENCY) {
      const row = await claimNextPendingExtract(db, hasDefault);
      if (!row) break;
      extractRows.push(row);
    }
    if (extractRows.length) {
      await Promise.all(extractRows.map(processExtractOne));
      return extractRows.length;
    }

    // Face leg: render connector chart faces before those entities tag.
    const faceRows = [];
    while (faceRows.length < CONCURRENCY) {
      const row = await claimNextPendingFace(db);
      if (!row) break;
      faceRows.push(row);
    }
    if (faceRows.length) {
      await Promise.all(faceRows.map(processFaceOne));
      return faceRows.length;
    }

    // Tag leg.
    const rows = [];
    while (rows.length < CONCURRENCY) {
      const row = await claimNextPending(db, hasDefault);
      if (!row) break;
      rows.push(row);
    }
    if (!rows.length) return 0;
    await Promise.all(rows.map(processOne));
    return rows.length;
  }

  let running = true;
  let wake = () => {};
  const loop = (async () => {
    while (running) {
      let n = 0;
      try {
        n = await tick();
      } catch (e) {
        console.error("worker tick error:", e.message);
      }
      if (!running) break;
      // Interruptible sleep: stop() short-circuits it so shutdown never
      // waits out a poll interval.
      await new Promise((r) => {
        const t = setTimeout(r, n > 0 ? 400 : POLL_MS);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
  })();

  resolveDefaultAi(db).then((ai) => {
    if (ai) {
      console.log(`AI tagging worker started (default ${ai.provider}/${ai.model}, per-board overrides in board settings, ${CONCURRENCY} concurrent).`);
    } else {
      console.log(`AI tagging worker started (no default key — only boards with their own key will tag, ${CONCURRENCY} concurrent).`);
    }
  }).catch((e) => console.warn(`worker: default-AI probe failed at start: ${e.message}`)); // log-only — an unhandled rejection here would crash the boot
  // Stop claiming immediately; the returned promise resolves once the
  // in-flight tick (if any) has finished, so callers can drain before exit.
  return () => {
    running = false;
    wake();
    return loop;
  };
}
