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

function resolveWorkerConfig(db) {
  const apiKey = getSetting(db, "api_key") || process.env.ANTHROPIC_API_KEY || null;
  const model = getSetting(db, "model") || process.env.MODEL || "claude-haiku-4-5";
  const dailyCap = Number(process.env.DAILY_CAP || 2000);
  return { apiKey, model, dailyCap };
}

// Generic fallback glosses for common design-vocabulary facet keys.
const GLOSS = {
  shell: "the persistent app chrome / navigation frame",
  nav: "how the primary navigation is organized",
  view: "the dominant content layout of the screen",
  viz: "data-visualization components present (multi-select; omit if none)",
  density: "visual information density",
  theme: "dominant color scheme (always pick one)",
  direction: "overall design direction / vibe",
};

function buildPrompt(facets, context = "") {
  const lines = facets.map((f) => {
    const note = f.single ? " — pick exactly one" : "";
    return `- ${f.key} (${GLOSS[f.key] || f.label}): ${f.values.join(", ")}${note}`;
  });
  const contextBlock = context.trim() ? `\n${context.trim()}\n` : "";
  const systemText = `You tag images for a private research gallery.${contextBlock}
First judge whether the image belongs in this collection at all: the description above and the facet vocabulary below define the kind of material this board collects. If the image is clearly a different kind of material — or you cannot confidently place it in that picture — set "fit" to "undecided". Otherwise set "fit" to "match".

For each image, select every applicable tag from the facets below. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's array empty when nothing applies (when "fit" is "undecided", any facet may be left empty, including "pick exactly one" facets). Be accurate and conservative; do not invent values outside the allowed lists.

Facets and allowed values:
${lines.join("\n")}

Return your answer only by calling the tag_screenshot tool.`;

  const properties = {};
  const required = [];
  for (const f of facets) {
    properties[f.key] = {
      type: "array",
      items: { type: "string", enum: f.values },
      description: (GLOSS[f.key] || f.label) + (f.single ? " — pick exactly one" : ""),
    };
    required.push(f.key);
  }
  // Defined after the facet loop so a facet named "fit" can't clobber it.
  properties.fit = {
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

function getBoardPrompt(db, boardId) {
  if (boardPromptCache.has(boardId)) return boardPromptCache.get(boardId);
  const board = getBoard(db, boardId);
  if (!board || !board.facets.length) return null;
  const { facets, context } = board;
  const allowed = new Set();
  for (const f of facets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const { system, tool } = buildPrompt(facets, context);
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
    const prompt = getBoardPrompt(db, row.board_id);
    if (!prompt) throw new Error(`board ${row.board_id} has no facets configured`);
    const { system, tool, allowed, facets } = prompt;

    const buf = await fs.promises.readFile(path.join(thumbsDir, row.filename + ".webp"));
    const msg = await client.messages.create({
      model,
      max_tokens: 1024,
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
    for (const f of facets) {
      const vals = block.input[f.key];
      if (Array.isArray(vals)) {
        for (const v of vals) {
          const t = `${f.key}/${v}`;
          if (allowed.has(t)) tags.push(t);
        }
      }
    }
    return { tags, undecided: block.input.fit === "undecided" };
  }

  async function tick() {
    const { apiKey, model, dailyCap } = resolveWorkerConfig(db);
    const client = getAiClient(apiKey);
    if (!client) return 0;

    const recovered = recoverStuck(db, STUCK_MS);
    if (recovered) console.log(`worker: recovered ${recovered} stuck image(s)`);
    if (usageToday(db) >= dailyCap) {
      // Say so once a day — otherwise pending images just spin forever
      // with no hint of why (cap exhaustion looks identical to a hang).
      const day = new Date().toISOString().slice(0, 10);
      if (capNoticeDay !== day) {
        const { n } = db.prepare("SELECT COUNT(*) AS n FROM images WHERE status='pending'").get();
        if (n > 0) {
          console.warn(`worker: daily cap (${dailyCap}) reached — ${n} pending image(s) deferred until tomorrow (raise DAILY_CAP or reset ai_usage to resume today)`);
          capNoticeDay = day;
        }
      }
      return 0;
    }

    const row = claimNextPending(db);
    if (!row) return 0;
    try {
      const { tags, undecided } = await tagOne(row, client, model);
      markTagged(db, row.id, tags, undecided);
      bumpUsage(db);
      console.log(`tagged #${row.id} ${row.filename} [${model}]${undecided ? " (undecided)" : ""} -> [${tags.join(", ")}]`);
    } catch (err) {
      const failed = failOrRequeue(db, row.id, err.message, MAX_ATTEMPTS);
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

  const { apiKey, model, dailyCap } = resolveWorkerConfig(db);
  if (apiKey) {
    console.log(`AI tagging worker started (model=${model}, dailyCap=${dailyCap}, facets per-board).`);
  } else {
    console.log("AI tagging worker started (no key — configure one in admin to enable tagging).");
  }
  return () => {
    running = false;
  };
}
