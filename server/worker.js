import fs from "node:fs";
import path from "node:path";
import {
  claimNextPending,
  markTagged,
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
} from "./db.js";
import { callTagger, embedTexts, PROVIDER_DEFAULT_MODEL, EMBED_PROVIDERS, PROVIDER_DEFAULT_EMBED_MODEL } from "./providers.js";

// The app-default tagger: settings-designated key, else the legacy env var.
// Returns { provider, apiKey, model } or null when nothing is configured.
export async function resolveDefaultAi(db) {
  const defId = Number(await getSetting(db, "default_key_id")) || 0;
  if (defId) {
    const key = await getAiKey(db, defId);
    if (key) {
      const model = (await getSetting(db, "model")) || PROVIDER_DEFAULT_MODEL[key.provider];
      return { provider: key.provider, apiKey: key.api_key, model };
    }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: (await getSetting(db, "model")) || process.env.MODEL || PROVIDER_DEFAULT_MODEL.anthropic,
    };
  }
  return null;
}

// The app-global embedder for semantic search: enabled flag + designated key
// (must be an embeddings-capable provider — Anthropic has no embeddings API).
// Returns { provider, apiKey, model } or null when off/misconfigured.
export async function resolveEmbedder(db) {
  if ((await getSetting(db, "embed_enabled")) !== "1") return null;
  const keyId = Number(await getSetting(db, "embed_key_id")) || 0;
  if (!keyId) return null;
  const key = await getAiKey(db, keyId);
  if (!key || !EMBED_PROVIDERS.includes(key.provider)) return null;
  return {
    provider: key.provider,
    apiKey: key.api_key,
    model: (await getSetting(db, "embed_model")) || PROVIDER_DEFAULT_EMBED_MODEL[key.provider],
  };
}

// The text an item's search vector is built from: whole-item description,
// then the per-facet reasoning sentences, then the tags flattened to words
// (so exact facet vocabulary also matches). Falls back to the filename so no
// item ever embeds an empty string.
export function embedTextFor(tags = [], reasoning = {}, payload = {}) {
  const parts = [];
  if (reasoning.description) parts.push(reasoning.description);
  for (const [k, v] of Object.entries(reasoning)) {
    if (k !== "description" && typeof v === "string" && v.trim()) parts.push(v.trim());
  }
  if (tags.length) parts.push(tags.map((t) => t.replace("/", ": ")).join("; "));
  return parts.join("\n") || payload.files?.[0]?.original_name || payload.identity || "untitled item";
}

// A board's effective tagger: its own key (+ model) when set, else the default.
async function resolveBoardAi(db, boardEntry) {
  if (boardEntry.aiKeyId) {
    const key = await getAiKey(db, boardEntry.aiKeyId);
    if (key) {
      return {
        provider: key.provider,
        apiKey: key.api_key,
        model: boardEntry.aiModel || PROVIDER_DEFAULT_MODEL[key.provider],
      };
    }
  }
  return resolveDefaultAi(db);
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

export function startWorker({ db, thumbsDir, galleryDir }) {
  const POLL_MS = Number(process.env.POLL_MS || 3000);
  const STUCK_MS = Number(process.env.STUCK_MS || 180000);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
  const CONCURRENCY = Math.max(1, Number(process.env.TAG_CONCURRENCY) || 4);
  const TEXT_DOC_MAX_CHARS = 50000; // ~12k tokens; plenty for tagging judgment

  // What the model sees for an item: parts built from its files by kind.
  // Images: the thumbnail (cheap) rather than the original. PDFs: the original
  // as a document block (Anthropic-only — providers.js rejects it elsewhere).
  // Text docs: the content inline, capped.
  async function modelInputFor(payload) {
    const file = payload.files[0];
    if (file.kind === "pdf") {
      const buf = await fs.promises.readFile(path.join(galleryDir, file.name));
      return [
        { kind: "document", mediaType: "application/pdf", b64: buf.toString("base64") },
        { kind: "text", text: "Tag this document using the record_tags tool." },
      ];
    }
    if (file.kind === "text" || file.kind === "docx") {
      // docx reads its ingest-time text sidecar (mammoth extraction).
      const src = file.kind === "docx" ? file.name + ".txt" : file.name;
      const text = await fs.promises.readFile(path.join(galleryDir, src), "utf8");
      return [{
        kind: "text",
        text: `The item is the following document ("${file.original_name}"):\n\n${text.slice(0, TEXT_DOC_MAX_CHARS)}\n\nTag this document using the record_tags tool.`,
      }];
    }
    const buf = await fs.promises.readFile(path.join(thumbsDir, file.name + ".webp"));
    return [
      { kind: "image", mediaType: "image/webp", b64: buf.toString("base64") },
      { kind: "text", text: "Tag this image using the record_tags tool." },
    ];
  }

  async function tagOne(row) {
    const prompt = await getBoardPrompt(db, row.board_id);
    if (!prompt) throw new Error(`board ${row.board_id} has no facets configured`);
    const { systemText, schema, allowed, facets } = prompt;

    const ai = await resolveBoardAi(db, prompt);
    if (!ai) throw new Error("no API key configured");

    const parts = await modelInputFor(row.payload);
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
  // call per tick. Failures back off for a minute so a bad key or outage
  // doesn't turn the poll loop into an API hammer.
  const EMBED_BATCH = Math.max(1, Number(process.env.EMBED_BATCH) || 64);
  let embedBackoffUntil = 0;
  async function embedDue() {
    if (Date.now() < embedBackoffUntil) return;
    const embedder = await resolveEmbedder(db);
    if (!embedder) return;
    const rows = await itemsNeedingEmbedding(db, embedder.model, EMBED_BATCH);
    if (!rows.length) return;
    try {
      const { vectors } = await embedTexts({
        provider: embedder.provider,
        apiKey: embedder.apiKey,
        model: embedder.model,
        texts: rows.map((r) => embedTextFor(r.tags, r.tag_reasoning, r.payload)),
      });
      for (let i = 0; i < rows.length; i++) {
        await setItemEmbedding(db, rows[i].id, vectors[i], embedder.model);
      }
      console.log(`embedded ${rows.length} item(s) [${embedder.model}]`);
    } catch (err) {
      embedBackoffUntil = Date.now() + 60000;
      console.warn(`embed error (retrying in 60s): ${err.message}`);
    }
  }

  async function processOne(row) {
    const label = row.payload?.identity || `item ${row.id}`;
    try {
      const { tags, undecided, reasoning, usage, model } = await tagOne(row);
      await markTagged(db, row.id, tags, undecided, reasoning);
      await bumpUsage(db, row.board_id, usage);
      console.log(`tagged #${row.id} ${label} [${model}]${undecided ? " (undecided)" : ""} -> [${tags.join(", ")}]`);
    } catch (err) {
      const failed = await failOrRequeue(db, row.id, err.message, MAX_ATTEMPTS);
      console.warn(`tag error #${row.id} ${label}: ${err.message} (${failed ? "failed" : "requeued"})`);
    }
  }

  async function tick() {
    const recovered = await recoverStuck(db, STUCK_MS);
    if (recovered) console.log(`worker: recovered ${recovered} stuck item(s)`);
    await retagDue();
    await embedDue();

    // Boards without their own key only tag when a default exists; their
    // items stay pending in the queue until one is configured.
    const hasDefault = !!(await resolveDefaultAi(db));
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
  });
  // Stop claiming immediately; the returned promise resolves once the
  // in-flight tick (if any) has finished, so callers can drain before exit.
  return () => {
    running = false;
    wake();
    return loop;
  };
}
