import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import {
  claimNextPending,
  markTagged,
  failOrRequeue,
  recoverStuck,
  usageToday,
  bumpUsage,
  countPending,
  getBoard,
  getSetting,
} from "./db.js";

// Cached Anthropic client — recreated only when the API key changes.
let _aiClient = null;
let _aiClientKey = null;

function getAiClient(apiKey) {
  if (!apiKey) return null;
  if (apiKey !== _aiClientKey) {
    _aiClient = new Anthropic({ apiKey });
    _aiClientKey = apiKey;
  }
  return _aiClient;
}

async function resolveWorkerConfig(db) {
  const apiKey = (await getSetting(db, "api_key")) || process.env.ANTHROPIC_API_KEY || null;
  const model = (await getSetting(db, "model")) || process.env.MODEL || "claude-haiku-4-5";
  const dailyCap = Number(process.env.DAILY_CAP || 2000);
  return { apiKey, model, dailyCap };
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

function buildPrompt(facets, context = "", withReasoning = true) {
  const lines = facets.map((f) => {
    const note = f.single ? " — pick exactly one" : "";
    return `- ${f.key} (${facetGloss(f)}): ${f.values.join(", ")}${note}`;
  });
  const contextBlock = context.trim() ? `\n${context.trim()}\n` : "";
  const selectPara = withReasoning
    ? `For each facet, first write one short reasoning sentence naming what is visible that drives the choice (or why nothing applies), then select every applicable value. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's values empty when nothing applies (when the fit verdict is "undecided", leave every facet's values empty, including "pick exactly one" facets). Be accurate and conservative; do not invent values outside the allowed lists.`
    : `For each image, select every applicable tag from the facets below. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's array empty when nothing applies (when the fit verdict is "undecided", leave every facet empty, including "pick exactly one" facets). Be accurate and conservative; do not invent values outside the allowed lists.`;
  const systemText = `You tag images for a private research gallery.${contextBlock}
Also decide whether the image is the kind of material the facets below can describe at all. If you can honestly justify facet selections from what is visible, the image is a match — set the fit verdict to "match" even when it falls outside the board's stated focus; recording that is what the facets themselves are for. Set the fit verdict to "undecided" only when the image is a different kind of material altogether and the facets simply do not apply, so that selecting values would be pure guessing; in that case leave every facet's values empty. Never combine "undecided" with facet selections: an image you were able to describe with the facets is a match by definition.

${selectPara}

Facets and allowed values:
${lines.join("\n")}

Return your answer only by calling the tag_screenshot tool.`;

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
  const tool = {
    name: "tag_screenshot",
    description: "Record the applicable taxonomy tags for this UI screenshot.",
    strict: true,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
  const system = [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];
  return { system, tool };
}

// Per-board prompt cache: board_id -> { system, tool, allowed, facets }
const boardPromptCache = new Map();

async function getBoardPrompt(db, boardId) {
  if (boardPromptCache.has(boardId)) return boardPromptCache.get(boardId);
  const board = await getBoard(db, boardId);
  if (!board || !board.facets.length) return null;
  const { facets, context } = board;
  const allowed = new Set();
  for (const f of facets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const { system, tool } = buildPrompt(facets, context, board.ai_reasoning !== false);
  const entry = { system, tool, allowed, facets };
  boardPromptCache.set(boardId, entry);
  return entry;
}

export function invalidateBoardCache(boardId) {
  boardPromptCache.delete(boardId);
}

export function startWorker({ db, thumbsDir }) {
  const POLL_MS = Number(process.env.POLL_MS || 10000);
  const STUCK_MS = Number(process.env.STUCK_MS || 180000);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
  let capNoticeDay = null; // last day the cap warning was logged

  async function tagOne(row, client, model) {
    const prompt = await getBoardPrompt(db, row.board_id);
    if (!prompt) throw new Error(`board ${row.board_id} has no facets configured`);
    const { system, tool, allowed, facets } = prompt;

    const buf = await fs.promises.readFile(path.join(thumbsDir, row.filename + ".webp"));
    const msg = await client.messages.create({
      model,
      max_tokens: 2048,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: "tag_screenshot" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/webp", data: buf.toString("base64") } },
            { type: "text", text: "Tag this UI screenshot using the tag_screenshot tool." },
          ],
        },
      ],
    });
    const block = msg.content.find((b) => b.type === "tool_use");
    if (!block) throw new Error("no tool_use block in response");
    const tags = [];
    const reasoning = {};
    let filledFacets = 0;
    for (const f of facets) {
      const entry = block.input[f.key];
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
    const fit = block.input.fit;
    const verdict = typeof fit === "string" ? fit : fit && fit.verdict;
    if (fit && typeof fit.reasoning === "string" && fit.reasoning.trim()) {
      reasoning.fit = fit.reasoning.trim();
    }
    // Only honor an undecided verdict when the model also found the facets
    // mostly inapplicable. It keeps folding "off-scope but taggable" into
    // undecided regardless of prompt wording, and an image it could describe
    // with most of the facets is board material by definition.
    const undecided = verdict === "undecided" && filledFacets < facets.length / 2;
    return { tags, undecided, reasoning };
  }

  async function tick() {
    const { apiKey, model, dailyCap } = await resolveWorkerConfig(db);
    const client = getAiClient(apiKey);
    if (!client) return 0;

    const recovered = await recoverStuck(db, STUCK_MS);
    if (recovered) console.log(`worker: recovered ${recovered} stuck image(s)`);
    if ((await usageToday(db)) >= dailyCap) {
      // Say so once a day — otherwise pending images just spin forever
      // with no hint of why (cap exhaustion looks identical to a hang).
      const day = new Date().toISOString().slice(0, 10);
      if (capNoticeDay !== day) {
        const n = await countPending(db);
        if (n > 0) {
          console.warn(`worker: daily cap (${dailyCap}) reached — ${n} pending image(s) deferred until tomorrow (raise DAILY_CAP or reset ai_usage to resume today)`);
          capNoticeDay = day;
        }
      }
      return 0;
    }

    const row = await claimNextPending(db);
    if (!row) return 0;
    try {
      const { tags, undecided, reasoning } = await tagOne(row, client, model);
      await markTagged(db, row.id, tags, undecided, reasoning);
      await bumpUsage(db);
      console.log(`tagged #${row.id} ${row.filename} [${model}]${undecided ? " (undecided)" : ""} -> [${tags.join(", ")}]`);
    } catch (err) {
      const failed = await failOrRequeue(db, row.id, err.message, MAX_ATTEMPTS);
      console.warn(`tag error #${row.id} ${row.filename}: ${err.message} (${failed ? "failed" : "requeued"})`);
    }
    return 1;
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

  resolveWorkerConfig(db).then(({ apiKey, model, dailyCap }) => {
    if (apiKey) {
      console.log(`AI tagging worker started (model=${model}, dailyCap=${dailyCap}, facets per-board).`);
    } else {
      console.log("AI tagging worker started (no key — configure one in admin to enable tagging).");
    }
  });
  return () => {
    running = false;
  };
}
