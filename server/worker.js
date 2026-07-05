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
} from "./db.js";
import { callTagger, PROVIDER_DEFAULT_MODEL } from "./providers.js";

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

export function buildPrompt(facets, context = "", withReasoning = true, subject = "images") {
  const lines = facets.map((f) => {
    const note = f.single ? " — pick exactly one" : "";
    return `- ${f.key} (${facetGloss(f)}): ${f.values.join(", ")}${note}`;
  });
  const contextBlock = context.trim() ? `\n${context.trim()}\n` : "";
  const selectPara = withReasoning
    ? `For each facet, first write one short reasoning sentence naming what is visible that drives the choice (or why nothing applies), then select every applicable value. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's values empty when nothing applies (when the fit verdict is "undecided", leave every facet's values empty, including "pick exactly one" facets). Be accurate and conservative; do not invent values outside the allowed lists.`
    : `For each image, select every applicable tag from the facets below. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's array empty when nothing applies (when the fit verdict is "undecided", leave every facet empty, including "pick exactly one" facets). Be accurate and conservative; do not invent values outside the allowed lists.`;
  const systemText = `You tag ${subject} for a private research gallery.${contextBlock}
Also decide whether the image is the kind of material the facets below can describe at all. If you can honestly justify facet selections from what is visible, the image is a match — set the fit verdict to "match" even when it falls outside the board's stated focus; recording that is what the facets themselves are for. Set the fit verdict to "undecided" only when the image is a different kind of material altogether and the facets simply do not apply, so that selecting values would be pure guessing; in that case leave every facet's values empty. Never combine "undecided" with facet selections: an image you were able to describe with the facets is a match by definition.

${selectPara}

Facets and allowed values:
${lines.join("\n")}

Return your answer only by calling the record_tags tool.`;

  const properties = {};
  const required = [];
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
        description: "Whether the image fits the kind of material this board collects.",
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
        description: "Whether the image fits the kind of material this board collects.",
      };
  required.push("fit");
  const schema = { type: "object", properties, required, additionalProperties: false };
  return { systemText, schema };
}

// Per-board cache: board_id -> { systemText, schema, allowed, facets, adapter, aiKeyId, aiModel }
// Invalidated on board PATCH (server.js) and cleared entirely on key deletion.
const boardPromptCache = new Map();

async function getBoardPrompt(db, registry, boardId) {
  if (boardPromptCache.has(boardId)) return boardPromptCache.get(boardId);
  const board = await getBoard(db, boardId);
  if (!board || !board.facets.length) return null;
  const adapter = registry.get(board.type);
  if (!adapter) throw new Error(`board ${boardId} has unknown type "${board.type}"`);
  const { facets, context } = board;
  const allowed = new Set();
  for (const f of facets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const { systemText, schema } = buildPrompt(facets, context, board.ai_reasoning !== false, adapter.manifest.subject);
  const entry = { systemText, schema, allowed, facets, adapter, aiKeyId: board.ai_key_id, aiModel: board.ai_model };
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

export function startWorker({ db, registry }) {
  const POLL_MS = Number(process.env.POLL_MS || 3000);
  const STUCK_MS = Number(process.env.STUCK_MS || 180000);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
  const CONCURRENCY = Math.max(1, Number(process.env.TAG_CONCURRENCY) || 4);

  async function tagOne(row) {
    const prompt = await getBoardPrompt(db, registry, row.board_id);
    if (!prompt) throw new Error(`board ${row.board_id} has no facets configured`);
    const { systemText, schema, allowed, facets } = prompt;

    const ai = await resolveBoardAi(db, prompt);
    if (!ai) throw new Error("no API key configured");

    // The board type decides what the model sees; the worker owns everything
    // around it (prompt, schema, validation, retries).
    const { parts } = await prompt.adapter.buildModelInput({ id: row.id, payload: row.payload });
    const { input, usage } = await callTagger({
      provider: ai.provider,
      apiKey: ai.apiKey,
      model: ai.model,
      systemText,
      schema,
      parts,
    });
    const tags = [];
    const reasoning = {};
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
    // undecided regardless of prompt wording, and an image it could describe
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
      if (queued) console.log(`scheduled retag: queued ${queued} image(s) in board "${b.name}"`);
      else if (skipped) console.log(`scheduled retag: board "${b.name}" skipped (weekend) — rescheduled`);
    }
  }

  async function processOne(row) {
    const label = row.payload?.filename || `item ${row.id}`;
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
    if (recovered) console.log(`worker: recovered ${recovered} stuck image(s)`);
    await retagDue();

    // Boards without their own key only tag when a default exists; their
    // images stay pending in the queue until one is configured.
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
  (async function loop() {
    while (running) {
      let n = 0;
      try {
        n = await tick();
      } catch (e) {
        console.error("worker tick error:", e.message);
      }
      await new Promise((r) => setTimeout(r, n > 0 ? 400 : POLL_MS));
    }
  })();

  resolveDefaultAi(db).then((ai) => {
    if (ai) {
      console.log(`AI tagging worker started (default ${ai.provider}/${ai.model}, per-board overrides in board settings, ${CONCURRENCY} concurrent).`);
    } else {
      console.log(`AI tagging worker started (no default key — only boards with their own key will tag, ${CONCURRENCY} concurrent).`);
    }
  });
  return () => {
    running = false;
  };
}
