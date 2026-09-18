// The MCP tools (planning/mcp-stage-1.md §4). Knows nothing about HTTP: the
// schemas are pure data and each handler takes a context bag and its arguments,
// so this half tests with no server and mcp.js's half tests with no database.
//
// THE STANDING RULE HERE: this file adds no search algebra. The facet matcher
// is alerts.js's `matchesCondition` — the same `facetPass` the browser grid
// runs (public/facet-match.js) — and the input cleaning is the same
// `cleanSelection` filter configs and alert conditions use. A selection that
// means one thing in the gallery must mean exactly that through this door;
// test/mcp-tools.js pins the two against each other, and a second
// implementation here is the failure that test exists to catch.
//
// TOOLS is also the tab's copy: /api/admin/mcp serves this list, so the MCP
// pane renders the vocabulary it is handed and a fourth tool appears there with
// no client edit (the admin-capabilities.js stance).
import fs from "node:fs";
import path from "node:path";
import { matchesCondition } from "./alerts.js";
import { cleanSelection } from "../public/facet-match.js";
import {
  listBoards,
  getBoard,
  canAccessBoard,
  listItems,
  boardEmbeddings,
  boardEntityCounts,
  embeddingVec,
  entityIdsFor,
  entitiesOnBoard,
  listCrates,
  hasCrates,
  crateItemIds,
  createCrate,
  addCrateItems,
  getSetting,
} from "./db.js";
import { aiImageFor, IMAGE_PRESETS } from "./ai-image.js";
import { resolveEmbedder } from "./worker.js";
import { embedTexts } from "./providers.js";
import { meterAiCall } from "./metering.js";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
// The same relative cutoff /api/search applies — but over the FILTERED set
// rather than the whole board. "The best match among these" is what a composed
// query asks, and scoring only the survivors is less work besides. Do not
// "fix" this back to a board-wide best: it would re-admit items the facets
// already excluded from the comparison.
const SCORE_WINDOW = 0.15;
// get_items' ceiling. Measured (mcp-stage-2.md §3.1): a `standard` rendition is
// ~805 tokens and a `high` one ~1,880, so six is ~4.8k / ~11.3k — an explicit
// "show me these properly" is allowed to be expensive, but not unbounded.
const MAX_ITEMS = 6;
// What aiImageFor clamps against. There is no provider here to declare limits,
// so this is the MCP-side ceiling: 1568px is the largest any preset is worth
// (the `max` preset clamps to it, which is why it is not offered), and 400KB is
// where Block's MCP playbook puts the line for a tool payload.
const MCP_IMAGE_LIMITS = { maxEdge: 1568, maxBytes: 400_000 };
// save_to_crate's ceiling. Matches `exclude_ids` rather than `get_items`' six:
// that six is a TOKEN budget (renditions), and saving renders nothing.
const MAX_SAVE = 100;

// Tool annotations (MCP spec, "Data Types → Tool"). Stating them is not
// cosmetic: an UNannotated tool is assumed readOnly:false, destructive:true,
// idempotent:false, openWorld:true — the pessimistic default — so before this
// every client was told `list_boards` might destroy something and call out to
// the internet. Harmless while everything was a read; actively harmful with a
// write in the list, because a client that cannot tell them apart must either
// prompt on all five or on none, and prompting on all five is how people learn
// to approve without looking.
//
// openWorld is false throughout: every tool here works inside one Postgres
// database and one gallery directory. The embedding request inside search_board
// is this instance's own configured provider doing this instance's own work,
// not an open world of entities the tool discovers.
//
// destructiveHint is omitted on the reads because the spec only gives it
// meaning when readOnlyHint is false; writing it there would imply the two are
// independent knobs.
const READ_TOOL = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
// Additive and retry-safe, which is a claim `ON CONFLICT DO NOTHING` in
// addCrateItems makes true rather than a label hoping it is.
const WRITE_TOOL = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const text = (t) => ({ type: "text", text: t });
// `content` is what the MODEL reads; `structuredContent` is what an MCP App's
// view renders (mcp-stage-4.md). Both ride in every result, and the text half
// is the contract: it is what every client without UI support shows, which is
// most of them.
//
// Deliberately NOT also serialising structuredContent into a text block. The
// spec SHOULDs that for backwards compatibility, and here it would paste the
// card array into the model's context beside the prose that already says the
// same thing, twice-billed — the tools return rich text precisely so a client
// with no structured support loses nothing.
const ok = (blocks, structured) => (structured ? { content: blocks, structuredContent: structured } : { content: blocks });
// A tool EXECUTION error — reported in the result, never as a JSON-RPC error
// (mcp.js owns those). The distinction is the spec's and it matters: a model
// can read this and try something else, where a protocol error is a transport
// failure it can only report. So every "not found" and "not configured" in
// this file lands here, with the next move named.
const fail = (t) => ({ content: [text(t)], isError: true });

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
// Whatever a model sent, as distinct positive integers. get_items and
// save_to_crate both take `ids` from a previous result and both have to
// survive strings, floats, nulls and repeats.
const cleanIds = (raw) => [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(Number.isInteger))];

// --- shared helpers ---------------------------------------------------------

// The boards this caller may see. Deliberately not server.js's
// accessibleBoards: that one also applies the reader's own drag ORDER
// (board-arrangement-plan.md), which is a fact about a person looking at a
// rail and means nothing to an agent.
//
// TWO gates, and the order matters: `mcp_boards` NARROWS what an already
// permitted caller is shown — it can never widen access, because the
// membership check runs regardless. Empty means all (mcp-stage-2.md §7).
// ONE implementation, so list_boards, describe_board, search_board and
// get_items cannot disagree about what is in scope.
async function visibleBoards(db, user) {
  const [all, scope] = await Promise.all([listBoards(db), getSetting(db, "mcp_boards")]);
  const live = liveScope(all, (scope || "").split(","));
  const allowed = live.size ? all.filter((b) => live.has(b.id)) : all;
  const ok = await Promise.all(allowed.map((b) => canAccessBoard(db, b.id, user)));
  return allowed.filter((_, i) => ok[i]);
}

// The stored scope, intersected with the boards that still EXIST. Deleting a
// board does not touch `settings`, and nothing cascades there — deleteBoard
// purges usage_meter by hand for the same reason — so a scope list goes stale
// on its own.
//
// An empty intersection is read as NO SCOPE, which is the only answer that
// keeps the tab honest: it tells the operator that unticking every box means
// all of them, and a list of ids that no longer name anything is unticked
// every box. The alternative is a feature that silently answers "no boards"
// with nothing on screen to explain why.
//
// Exported because paneState renders the checklist from the same rule — two
// copies would be exactly the drift the tab's own promise cannot survive.
export function liveScope(allBoards, scopeIds) {
  const exists = new Set(allBoards.map((b) => b.id));
  return new Set((scopeIds || []).filter((id) => id && exists.has(id)));
}

// Resolve a board argument, or the instructional refusal. A wrong id is the
// most likely mistake a caller makes, so the answer carries the ids that would
// have worked rather than just saying no.
async function resolveBoard({ db, user }, raw) {
  const id = String(raw || "");
  // The scope is applied here rather than trusted from a listing: a board
  // withheld by `mcp_boards` must be unreachable BY ID, not merely unlisted.
  //
  // And the row comes OUT of that list rather than from a second `getBoard` —
  // `listBoards` and `getBoard` select the same BOARD_COLS, so the board was
  // already in hand and the extra query was fetching a jsonb-heavy row twice.
  const visible = await visibleBoards(db, user);
  const board = id ? visible.find((b) => b.id === id) : null;
  if (board) return { board };
  const names = visible.map((b) => `${b.id} (${b.name})`);
  return {
    error: fail(
      `No board "${id}" is available to you.\n\n` +
        (names.length
          ? `Boards you can search:\n${names.map((n) => `  ${n}`).join("\n")}`
          : "You have access to no boards on this instance.")
    ),
  };
}

const facetList = (board) => (Array.isArray(board.facets) ? board.facets : []);

// "facet/value" counts for one board, live. One group-by over the tag arrays —
// measured at 15ms on a 4,673-item board, which is why describe_board can
// afford to answer with real numbers instead of the declared vocabulary alone.
async function tagCounts(db, boardId) {
  const { rows } = await db.query(
    `SELECT tag, COUNT(*)::int AS n FROM (
       SELECT jsonb_array_elements_text(tags) AS tag FROM items WHERE board_id = $1
     ) t GROUP BY 1`,
    [boardId]
  );
  return new Map(rows.map((r) => [r.tag, r.n]));
}

// ONE targeted read over the RETURNED page only, never the whole board.
// listItems deliberately doesn't carry reasoning — it is lazy-loaded for the
// lightbox — and putting it there would make every board load in the browser
// heavier just to serve a tool.
//
// This was two functions for a day, and they disagreed in two ways an entity
// with several instances would have shown: one required a stored description
// and took the first row that had one, the other took the first row full stop,
// and neither ordered deterministically in the same way. So search_board could
// print a description get_items then omitted, and two identical searches could
// print different ones. One read, one rule.
//
// THE RULE: an entity's record is its FACE instance's — the row whose file is
// the image the caller is looking at. Anything else describes one picture while
// showing another. `faceName` comes from listItems, which already made that
// choice; matching it here means the two cannot drift. First-created is the
// fallback, and it is what a single-instance entity (every card on a board
// without derived identity) resolves to anyway.
async function recordsFor(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT entity_ids, tag_reasoning, tags, payload FROM items
      WHERE entity_ids && $1::bigint[] ORDER BY created_at ASC, id ASC`,
    [ids]
  );
  const out = new Map();
  for (const r of rows) {
    for (const eid of r.entity_ids || []) {
      if (!out.has(eid)) out.set(eid, []);
      out.get(eid).push(r);
    }
  }
  return out;
}

// The one row of an entity's instances that describes what is on screen.
const recordFor = (records, item) => {
  const rows = records.get(Number(item.id)) || [];
  return rows.find((r) => r.payload?.files?.[0]?.name === item.name) || rows[0] || {};
};

// One item's full record: every facet value with the sentence the tagger wrote
// ABOUT that value, the fit line, and what the file is. Deliberately more than
// resultText — a search result is a candidate, this is the answer to "tell me
// about it". Reasoning sits beside its own facet rather than in a block of its
// own, because separated they are two lists the reader has to zip together.
function detailText(item, rec) {
  const r = rec.tag_reasoning || {};
  const file = rec.payload?.files?.[0];
  const lines = [`## id ${item.id} — ${item.identity || item.name}`];
  if (r.description) lines.push(r.description);
  if (file) {
    const dims = file.meta?.width && file.meta?.height ? `${file.meta.width}×${file.meta.height}` : null;
    const size = file.size ? `${Math.round(file.size / 1024)}KB` : null;
    lines.push([file.original_name || file.name, dims, size].filter(Boolean).join(" · "));
  }
  // The ENTITY's union, not this instance's — it is what search_board matched
  // on and what the card claims to be. A facet in the union that this instance
  // never answered simply carries no sentence.
  // facetSplit, not a second copy of the same loop. This file's header says a
  // second implementation of a shared rule is the failure it exists to catch,
  // and `byFacet.size` is also the truer guard: an item whose tags are all
  // malformed has tags but no facets, and used to print an empty heading.
  const { byFacet } = facetSplit(item);
  if (byFacet.size) {
    lines.push("", "### facets");
    for (const [k, vs] of byFacet) lines.push(`- **${k}**: ${vs.join(", ")}${r[k] ? ` — ${r[k]}` : ""}`);
  }
  if (r.fit) lines.push("", `fit: ${r.fit}`);
  return lines.join("\n");
}


// The preview tier: the 600px card face, already generated and immutable,
// ~14KB — about 280 tokens once a client renders it. A missing file yields no
// block rather than an error: the tool must survive a half-restored backup.
//
// `audience: ["assistant"]` is the protocol saying what Mobbin's tool
// descriptions only say in prose — these are for the model to read, not for
// pasting into the user's transcript.
async function previewBlock(dirs, item) {
  if (!item.name) return null;
  // aiImageFor, not a hand-rolled thumb read. The `thumb` preset has edge 0,
  // which lands at or under THUMB_WIDTH, so it resolves to the card face with
  // no sharp work and no decode gate — the same bytes this used to read by
  // hand. ai-image.js owns where a face lives and what happens when one is
  // missing; a second copy of that path here goes stale the day the layout
  // moves, silently, by reading a file that is no longer there.
  const img = await aiImageFor(dirs, { name: item.name }, { preset: IMAGE_PRESETS.thumb }).catch(() => null);
  if (!img) return null;
  return {
    type: "image",
    data: img.b64,
    mimeType: img.mediaType,
    annotations: { audience: ["assistant"], priority: 0.3 },
  };
}

// One result's metadata, as compact lines rather than nested JSON: models read
// prose more cheaply than they read JSON grammar, and the header carries the
// id every follow-up call needs (exclude_ids, similar_to).
// An item's tags split the way both readers want them: facets carrying one
// value read as `key/value`, facets carrying several read as `key: a, b`.
// Shared because the MCP App's tile caption is the singles line — the same
// line, for the same reason, and two copies would drift the moment one of them
// learned about a new tag shape.
function facetSplit(item) {
  const byFacet = new Map();
  for (const t of item.tags || []) {
    const s = t.indexOf("/");
    if (s <= 0) continue;
    const k = t.slice(0, s);
    if (!byFacet.has(k)) byFacet.set(k, []);
    byFacet.get(k).push(t.slice(s + 1));
  }
  const singles = [];
  const multis = [];
  for (const [k, vs] of byFacet) (vs.length === 1 ? singles : multis).push([k, vs]);
  return { byFacet, singles, multis };
}
const singlesLine = (item, cap = Infinity) =>
  facetSplit(item).singles.slice(0, cap).map(([k, vs]) => `${k}/${vs[0]}`).join(" · ");
// How many facets a TILE caption shows. The text block prints all of them —
// the model wants the whole row — but a caption is one line over a thumbnail,
// and the `ui` board tags nine facets deep: measured live, uncapped captions
// were 12.0 KB of the structuredContent for 30 cards, most of it text nobody
// could read in a 150px overlay, billed to every client including the ones
// that never render a grid.
const CAPTION_FACETS = 3;

function resultText(item, i, total, score, description) {
  const { byFacet, singles, multis } = facetSplit(item);
  const lines = [
    `### ${i + 1} of ${total} · id ${item.id}${score == null ? "" : ` · score ${score.toFixed(2)}`}`,
  ];
  if (singles.length) lines.push(singlesLine(item));
  if (multis.length) lines.push(multis.map(([k, vs]) => `${k}: ${vs.join(", ")}`).join(" · "));
  if (!byFacet.size) lines.push("(untagged)");
  if (description) lines.push(description);
  return text(lines.join("\n"));
}

// Resolve a crate by NAME, the way a caller thinks of one. Visibility is
// listCrates' own rule — your crates plus anyone's public ones on this board —
// reused rather than restated, so the agent sees exactly what the gallery's
// crates menu shows the same person.
//
// Case-insensitive after an exact miss, because "dark dashboards" and "Dark
// Dashboards" are the same request, and refusing the second would be the app
// being pedantic at a caller who cannot see the list.
// `canWrite` is the tab's saving switch. Every sentence below that names
// save_to_crate has to know it: the tool is HIDDEN from tools/list when saving
// is off, and prose telling a caller to use a tool it was never offered is the
// same lie that hiding it was meant to avoid — just moved somewhere the list
// does not reach.
async function resolveCrate(db, user, board, raw, canWrite) {
  const want = String(raw || "").trim();
  const crates = await listCrates(db, user.id, board.id);
  const hit =
    crates.find((c) => c.name === want) ||
    crates.find((c) => c.name.toLowerCase() === want.toLowerCase());
  if (hit) return { crate: hit };
  return {
    error: fail(
      `No crate called "${want}" on "${board.name}".\n\n` +
        (crates.length
          ? `Crates on this board:\n${crates.map((c) => `  ${c.name} (${c.item_count})`).join("\n")}`
          : `This board has no crates yet${canWrite ? " — save_to_crate creates one" : ""}.`)
    ),
  };
}

// "Nothing matched", said accurately. Two callers: the normal end of a search,
// and the short-circuit for a crate with no members — which never reads the
// board at all, so it cannot reach the first one.
//
// A crate search that finds nothing has exactly ONE cause when no other filter
// is set: the crate is empty. `crate_items.item_id` cascades from entities, so
// a crate cannot hold a card that has been deleted, and listItems returns every
// entity asked for — there is no "its cards are gone" state to report. Saying
// so beats naming the board at someone who asked about a crate.
function emptyResultText(board, inCrate, hasFacets, ctx, notes) {
  const emptyCrate = inCrate && !Number(inCrate.item_count);
  return (
    (emptyCrate
      ? `The crate "${inCrate.name}" on "${board.name}" is empty.${ctx.write ? " save_to_crate adds to it." : ""}`
      : `No cards ${inCrate ? `in "${inCrate.name}"` : `on "${board.name}"`} matched.`) +
    (hasFacets ? " Try fewer facet values, or call describe_board to check the vocabulary." : "") +
    (notes.length ? `\n\n${notes.join("\n")}` : "")
  );
}

// One section naming a board's crates, for describe_board. Absent when there
// are none: a heading over an empty list sends a caller looking for something
// that is not there.
async function crateSection(db, user, board, canWrite) {
  const crates = await listCrates(db, user.id, board.id);
  if (!crates.length) return null;
  return (
    `\n## saved sets (crates)\n` +
    crates.map((c) => `  ${c.name} (${c.item_count} cards)`).join("\n") +
    `\nPass \`crate\` to search_board to search inside one${canWrite ? ", or to save_to_crate to add to it" : ""}.`
  );
}

// --- the tools --------------------------------------------------------------

export const TOOLS = [
  {
    name: "list_boards",
    title: "List boards",
    description:
      "List the galleries (\"boards\") available to you. Start here, then call describe_board on whichever one fits before searching it. Cheap — no images.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(ctx) {
      const { db, user } = ctx;
      const boards = await visibleBoards(db, user);
      if (!boards.length) return ok([text("You have access to no boards on this instance.")]);
      const counts = await boardEntityCounts(db);
      // Whether a meaning query will work at all is a property of the INSTANCE,
      // not the board — but the caller needs it before it writes one, and this
      // is the first thing it reads.
      const embedder = await resolveEmbedder(db).catch(() => null);
      const lines = boards.map((b) => {
        const n = facetList(b).length;
        return `${b.id} · ${b.name} · ${counts[b.id] || 0} cards · ${n} facet${n === 1 ? "" : "s"}`;
      });
      return ok([
        text(
          `${lines.join("\n")}\n\nSemantic search (the \`query\` and \`similar_to\` arguments): ${
            embedder ? "available" : "NOT configured on this instance — facet filters still work"
          }.\nCall describe_board with a board id to get its facet vocabulary.`
        ),
      ]);
    },
  },

  {
    name: "describe_board",
    title: "Describe a board's vocabulary",
    description:
      "Return one board's facet vocabulary: every facet key, its allowed values with live counts, and the prose that defines each one. Call this before search_board so your facet filters use the board's exact keys and values. No images — also the cheapest way to answer counting questions (\"how many dark dashboards are there\").",
    inputSchema: {
      type: "object",
      properties: { board: { type: "string", description: "Board id from list_boards." } },
      required: ["board"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const { db, user } = ctx;
      const { board, error } = await resolveBoard(ctx, args.board);
      if (error) return error;
      const facets = facetList(board);
      // The crates ride along because they ARE part of "what do I need to know
      // before searching this board": a caller cannot add to a set it does not
      // know the name of, and cannot read one back either. One small query,
      // run where the caller already looks, instead of a fifth tool.
      const [counts, { rows: [{ n: cards }] }, crates] = await Promise.all([
        tagCounts(db, board.id),
        db.query("SELECT COUNT(*)::int AS n FROM entities WHERE board_id = $1", [board.id]),
        crateSection(db, user, board, ctx.write),
      ]);
      const out = [`# ${board.name}`, `${cards} cards · ${facets.length} facets`];
      if (board.context) out.push(`\n${board.context}`);
      if (!facets.length) {
        out.push("\nThis board declares no facets, so facet filtering is unavailable. Use `query` instead.");
        if (crates) out.push(crates);
        return ok([text(out.join("\n"))]);
      }
      for (const f of facets) {
        out.push(`\n## ${f.key}${f.single ? " (one value per card)" : " (several values per card)"}`);
        if (f.label && f.label !== f.key) out.push(`label: ${f.label}`);
        if (f.description) out.push(f.description);
        // A declared value with no tagged items is listed at 0, never hidden —
        // a caller that saw a short list would conclude the vocabulary is
        // smaller than it is, and pick a worse filter for it.
        out.push(
          (f.values || []).map((v) => `  ${v} (${counts.get(`${f.key}/${v}`) || 0})`).join("\n")
        );
      }
      out.push(
        `\nUse these in search_board's \`facets\`, e.g. {"${facets[0].key}":{"any":["${
          (facets[0].values || [])[0] ?? "value"
        }"]}}.`
      );
      if (crates) out.push(crates);
      return ok([text(out.join("\n"))]);
    },
  },

  {
    name: "search_board",
    title: "Search a board",
    // This tool has a view (mcp-stage-4.md). `ui` is our marker, like `write`;
    // toolSpecs turns it into the spec's _meta.ui.resourceUri when mcp.js
    // hands it the uri.
    ui: true,
    description:
      "Search one board. Combine any of: facet filters (exact vocabulary from describe_board), a meaning query in plain language, and a similar-to anchor. Prefer ONE composed call over several narrow ones. Returns compact metadata plus a low-resolution preview image per result for you to read.\n\nWriting `query`: describe what you would SEE, in plain language — \"analytics console with a dense metrics table and a command palette open\". Avoid negations (\"without a sidebar\" ranks almost identically to \"with a sidebar\" — exclude it with facets.not instead), vague style words (\"modern\", \"clean\"), and disconnected keyword lists. Put structural constraints in `facets`, not in `query`.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board id from list_boards." },
        facets: {
          type: "object",
          description:
            'Facet filter, keys and values exactly as describe_board returns them. Per facet: {"any": [...]} matches ANY listed value; {"not": [...]} excludes. Facets AND together. Example: {"theme":{"any":["dark"]},"core_components":{"any":["data-table","code-editor"]},"density":{"not":["roomy"]}}',
        },
        query: { type: "string", maxLength: 500, description: "Plain-language description of what you are looking for." },
        similar_to: {
          type: "integer",
          description: "An item id from a previous result — rank the board by resemblance to it. Free and fast; no meaning query needed.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          default: DEFAULT_LIMIT,
          description: `Each result with its preview costs roughly 400 tokens. ${DEFAULT_LIMIT} is a good default; raise it only when surveying.`,
        },
        exclude_ids: {
          type: "array",
          items: { type: "integer" },
          maxItems: 100,
          description: "Item ids to leave out — use this to page: \"more like these, but not these\".",
        },
        crate: {
          type: "string",
          description:
            "Search only inside one saved set (crate) on this board. describe_board lists the names. Combines with everything else, so this is how you ask \"which of the ones we saved are dark\".",
        },
        include_images: {
          type: "boolean",
          default: true,
          description: "false drops previews to roughly 115 tokens per result. Use it for counting and surveying.",
        },
        task_intent: {
          type: "string",
          maxLength: 200,
          description:
            "One short sentence naming your overall task; keep it identical across calls for the same task. Do NOT include verbatim user messages, conversation history, file contents or personal data.",
        },
      },
      required: ["board"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const { db, dirs } = ctx;
      const { board, error } = await resolveBoard(ctx, args.board);
      if (error) return error;

      const limit = clamp(Number(args.limit) || DEFAULT_LIMIT, 1, MAX_LIMIT);
      const condition = cleanSelection(args.facets);
      const hasFacets = Object.keys(condition).length > 0;

      // listItems, not a leaner query: it already does face selection, the
      // instance->entity tag union and aggregateStatus, and it MEASURED faster
      // (95ms) than a bespoke per-entity projection (191ms). userId is null so
      // the crate and favorites joins are skipped — a search result has no use
      // for either.
      // The crate is resolved BEFORE the board is read, so a crate search asks
      // for its members instead of reading the whole board and throwing most
      // of it away — `listItems`' `ids` option is exactly this shape, and it is
      // the one stage 3 added for get_items. On the `ui` board that is a
      // handful of rows against 4,673 and 7.4MB.
      let inCrate = null;
      let only = null;
      if (args.crate != null && String(args.crate).trim()) {
        const { crate, error: crateError } = await resolveCrate(db, ctx.user, board, args.crate, ctx.write);
        if (crateError) return crateError;
        inCrate = crate;
        only = [...(await crateItemIds(db, crate.id))];
        // An empty crate has no ids to ask for, and `ids: []` would read as
        // "no filter" to listItems' `ANY($n)` — so short-circuit rather than
        // accidentally returning the whole board.
        if (!only.length) return ok([text(emptyResultText(board, inCrate, hasFacets, args, []))]);
      }
      const { items } = await listItems(db, null, board.id, only ? { ids: only } : {});

      // An ABSENT facet selection means unconstrained, so matching is skipped
      // entirely. matchesCondition answers false for an empty condition — a
      // stored alert with no values is corrupt — and passing one through here
      // would return nothing for every facet-less search. Same cleaning, two
      // verdicts; see cleanSelection's note in facet-match.js.
      // `matched` counts what was ASKED for, so it is taken after both filters.
      const rows0 = hasFacets ? items.filter((it) => matchesCondition(new Set(it.tags), condition)) : items;
      let rows = rows0;
      const matched = rows.length;

      const notes = [];
      let scores = null;
      if (args.query || args.similar_to != null) {
        const ranked = await rank(ctx, board, rows, args, notes);
        if (ranked) ({ rows, scores } = ranked);
      }

      if (Array.isArray(args.exclude_ids) && args.exclude_ids.length) {
        const drop = new Set(args.exclude_ids.map(Number));
        rows = rows.filter((it) => !drop.has(Number(it.id)));
      }

      const page = rows.slice(0, limit);
      if (!page.length) return ok([text(emptyResultText(board, inCrate, hasFacets, ctx, notes))]);

      const withImages = args.include_images !== false;
      // Three reads up front and in parallel: the descriptions are one query,
      // the previews are a dozen small files that must not be read one
      // blocking call at a time — this runs inside the request, and the whole
      // rest of the server waits behind a sync read — and the thumb links are
      // a signature each.
      const [records, previews, thumbs] = await Promise.all([
        recordsFor(db, page.map((p) => Number(p.id))),
        withImages ? Promise.all(page.map((it) => previewBlock(dirs, it))) : [],
        ctx.thumbLinks(page.map((it) => it.name || null)),
      ]);
      const blocks = [];
      page.forEach((it, i) => {
        const description = recordFor(records, it).tag_reasoning?.description;
        blocks.push(resultText(it, i, page.length, scores?.get(it.id) ?? null, description));
        if (previews[i]) blocks.push(previews[i]);
      });

      const tail = [
        `${inCrate ? `in crate "${inCrate.name}" · ` : ""}matched ${matched} · returned ${page.length}${
          rows.length > page.length ? ` · refine with exclude_ids, or narrow the facets` : ""
        }`,
      ];
      if (notes.length) tail.push(...notes);
      blocks.push(text(tail.join("\n")));

      // The view's half. Deliberately thin: a grid needs a picture, an id and
      // something to read on hover — not the facet map, which the text blocks
      // already carry for the model. Measured (mcp-stage-4.md §2.3), 30 cards
      // of this shape are a few KB where 30 thumbnails as data: URIs would be
      // ~545 KB, and it rides in every result whether a host renders it or not.
      const structured = {
        board: { id: board.id, name: board.name },
        matched,
        // Tiles are pickable only where picking leads somewhere; with the
        // tab's saving switch off the view opens them instead.
        canSave: !!ctx.write,
        cards: page.map((it, i) => {
          const caption = singlesLine(it, CAPTION_FACETS);
          return {
          id: Number(it.id),
          thumb: thumbs[i],
          ...(it.w && it.h ? { w: it.w, h: it.h } : {}),
          ...(caption ? { caption } : {}),
          ...(scores?.has(it.id) ? { score: Number(scores.get(it.id).toFixed(3)) } : {}),
          };
        }),
      };
      return ok(blocks, structured);
    },
  },

  {
    name: "get_items",
    title: "Get items in full",
    description:
      "Fetch the complete record for specific items from a search — every facet value with the reasoning behind it, and a larger, legible rendering. Also returns a temporary download link for the original file. Ask for several ids in ONE call rather than one call each.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "The board the ids came from." },
        ids: {
          type: "array",
          items: { type: "integer" },
          minItems: 1,
          maxItems: MAX_ITEMS,
          description: "Item ids from a search_board result.",
        },
        preset: {
          type: "string",
          enum: ["standard", "high"],
          default: "standard",
          description:
            "standard is about 1024px and legible for layout and composition. Use high (about 1568px) only when you need to READ small text in the image — it roughly doubles the tokens.",
        },
        task_intent: {
          type: "string",
          maxLength: 200,
          description:
            "One short sentence naming your overall task; keep it identical across calls for the same task. Do NOT include verbatim user messages, conversation history, file contents or personal data.",
        },
      },
      required: ["board", "ids"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const { db, dirs, assetLink } = ctx;
      const { board, error } = await resolveBoard(ctx, args.board);
      if (error) return error;

      const ids = cleanIds(args.ids);
      if (!ids.length) return fail("Pass at least one item id from a search_board result.");
      if (ids.length > MAX_ITEMS) {
        // Truncating silently would answer a different question than the one
        // asked, and the caller would never learn which items it did not see.
        const each = args.preset === "high" ? "1,900" : "800";
        return fail(`That is ${ids.length} items; ask for at most ${MAX_ITEMS} at a time (each costs roughly ${each} tokens).`);
      }

      const preset = IMAGE_PRESETS[args.preset === "high" ? "high" : "standard"];
      // The BOARD argument is the authority, not the id: `ids` narrows WITHIN
      // the board, so an id belonging to another board simply does not come
      // back — it cannot resolve just because the caller knew it.
      const { items } = await listItems(db, null, board.id, { ids });
      const onBoard = new Map(items.map((it) => [Number(it.id), it]));
      const found = ids.filter((id) => onBoard.has(id));
      const missing = ids.filter((id) => !onBoard.has(id));

      // Nothing found at all is a failed call, not a result with an apology in
      // it — the caller asked a question this board cannot answer, and the
      // likeliest cause is ids from a different board's search.
      if (!found.length) {
        return fail(
          `No item on "${board.name}" has ${ids.length === 1 ? "id" : "ids"} ${ids.join(", ")}. ` +
          `Ids are board-specific — check which board the search that produced them was against.`
        );
      }

      const records = await recordsFor(db, found);
      const blocks = [];
      for (const id of found) {
        const item = onBoard.get(id);
        const rec = recordFor(records, item);
        blocks.push(text(detailText(item, rec)));
        const file = rec.payload?.files?.[0];
        if (!file?.name) continue;
        // Both tiers at once, which is what "show me this properly" means: a
        // rendition the MODEL reads, and a link the USER can actually fetch.
        // Neither failing takes the record down with it.
        const [img, link] = await Promise.all([
          aiImageFor(dirs, file, { preset, images: MCP_IMAGE_LIMITS }).catch(() => null),
          assetLink(file.name).catch(() => null),
        ]);
        if (img) {
          blocks.push({
            type: "image",
            data: img.b64,
            mimeType: img.mediaType,
            annotations: { audience: ["assistant"], priority: 0.6 },
          });
        }
        if (link) {
          blocks.push(text(`download the original (${file.original_name || file.name}) — link valid one hour:\n${link}`));
        }
      }
      if (missing.length) {
        // Named, not swallowed: an id that vanished silently would read to the
        // caller as an item with nothing to say about it.
        blocks.push(text(
          `No item on "${board.name}" has ${missing.length === 1 ? "id" : "ids"} ${missing.join(", ")} — ` +
          `ids are board-specific, so check which search they came from.`
        ));
      }
      return ok(blocks);
    },
  },

  {
    name: "save_to_crate",
    title: "Save cards to a crate",
    // `write: true` is this file's marker, not part of the MCP Tool shape —
    // toolSpecs strips it. It drives two things: the tab's saving switch hides
    // this tool from tools/list, and mcp.js answers a call that arrives anyway
    // with a readable refusal instead of "unknown tool".
    write: true,
    description:
      "Save cards to a named set (a \"crate\") on one board, so the person can open them in the gallery afterwards. Creates the crate if it does not exist yet, and adds to it if it does. Saving a card that is already in the crate does nothing, so this is safe to retry.\n\nUse it when the person asks you to keep, collect or shortlist what you found — the results otherwise live only in this conversation.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "The board the ids came from." },
        crate: {
          type: "string",
          maxLength: 64,
          description:
            "The crate's name — created if it does not exist. Call describe_board first to see the names already in use, so you add to one rather than making a near-duplicate.",
        },
        ids: {
          type: "array",
          items: { type: "integer" },
          minItems: 1,
          maxItems: MAX_SAVE,
          description: "Item ids from a search_board result.",
        },
        task_intent: {
          type: "string",
          maxLength: 200,
          description:
            "One short sentence naming your overall task; keep it identical across calls for the same task. Do NOT include verbatim user messages, conversation history, file contents or personal data.",
        },
      },
      required: ["board", "crate", "ids"],
      additionalProperties: false,
    },
    async handler(ctx, args) {
      const { db, user } = ctx;
      const { board, error } = await resolveBoard(ctx, args.board);
      if (error) return error;

      // createCrate trims and slices to 64 itself; doing it here too is how the
      // answer can report the name it ACTUALLY used. A silently truncated name
      // is one the caller will fail to find again.
      const name = String(args.crate || "").trim().slice(0, 64);
      if (!name) return fail("Give the crate a name — it is how the person finds these cards again.");

      const ids = cleanIds(args.ids);
      if (!ids.length) return fail("Pass at least one item id from a search_board result.");
      if (ids.length > MAX_SAVE) return fail(`That is ${ids.length} ids; save at most ${MAX_SAVE} at a time.`);

      // Checked BEFORE the crate is opened, so a call with nothing savable in
      // it leaves nothing behind. Creating the crate first and then finding
      // every id wrong would litter the person's gallery with an empty set
      // they never asked for.
      const valid = await entitiesOnBoard(db, ids, board.id);
      if (!valid.size) {
        return fail(
          `None of those ${ids.length === 1 ? "ids is a card" : "ids are cards"} on "${board.name}". ` +
            "Ids are board-specific — check which board the search that produced them was against."
        );
      }

      // Asked BEFORE anything is created, because it is the exact condition
      // the closing line claims: the crates control is absent from a board's
      // toolbar until that board has one. Deriving it afterwards from "the
      // crate holds exactly what I just sent" looked equivalent and is not —
      // an exact retry satisfies that too, and would tell the person a control
      // they have already used is about to appear for the first time.
      const hadCrates = await hasCrates(db, user.id, board.id);

      const crate = await createCrate(db, user.id, board.id, name);
      if (!crate) return fail(`Could not open a crate called "${name}" on "${board.name}".`);
      const r = await addCrateItems(db, user.id, crate.id, [...valid]);
      if (!r) return fail(`Could not write to the crate "${crate.name}".`);

      const skipped = ids.filter((id) => !valid.has(id));
      const lines = [
        `Saved ${r.added} ${r.added === 1 ? "card" : "cards"} to "${crate.name}" on "${board.name}".` +
          (r.already ? ` ${r.already} ${r.already === 1 ? "was" : "were"} already in it.` : "") +
          ` The crate now holds ${r.count}.`,
      ];
      if (skipped.length) {
        lines.push(
          `\n${skipped.length} ${skipped.length === 1 ? "id is not a card" : "ids are not cards"} on this board and ${
            skipped.length === 1 ? "was" : "were"
          } skipped: ${skipped.join(", ")}.`
        );
      }
      // Where to look. Only this server knows that the crates control is not
      // on screen until a board has one, and a save the person cannot find is
      // half a save.
      lines.push(
        `\nOpen it from the crates button in the gallery toolbar${
          hadCrates ? "" : " — that button only appears once a board has at least one crate, so this may be its first time on screen"
        }.`
      );
      return ok([text(lines.join("\n"))]);
    },
  },
];

// Meaning ranking over the SURVIVORS of the facet filter. Returns null (and
// pushes an explanatory note) whenever it cannot rank — a board with no
// embedder still answers its facet query rather than refusing the whole call,
// which is where /api/search's 404 would be the wrong answer through this door.
async function rank(ctx, board, rows, args, notes) {
  const { db, user } = ctx;
  const embedder = await resolveEmbedder(db).catch(() => null);
  if (!embedder) {
    notes.push("Meaning ranking is unavailable: this instance has no embedding provider configured. Results above are the facet filter only, newest first.");
    return null;
  }
  const all = await boardEmbeddings(db, board.id, embedder.model);
  // entity id -> its instances' vectors. An entity's score is its BEST
  // instance's, matching /api/search — one card can hold several images and
  // the strongest is what the card is about. One instance can also belong to
  // several entities (classify mode), so it lands under each: `similar_to` a
  // card whose only image it shares must not read as "never embedded".
  const byEntity = new Map();
  for (const r of all) {
    const v = embeddingVec(r);
    for (const eid of entityIdsFor(r)) {
      if (!byEntity.has(eid)) byEntity.set(eid, []);
      byEntity.get(eid).push(v);
    }
  }

  let probes;
  if (args.similar_to != null) {
    probes = byEntity.get(Number(args.similar_to));
    if (!probes?.length) {
      notes.push(`Item ${args.similar_to} has no stored vector yet, so similar-to ranking was skipped. Results above are the facet filter only.`);
      return null;
    }
  } else {
    const q = String(args.query).trim().slice(0, 500);
    if (!q) return null;
    const { vectors, usage } = await embedTexts({ ...embedder, texts: [q] });
    // The query embed is a paid call like any other and is metered to the
    // board being searched — the search is that board's work, exactly as
    // /api/search books it.
    //
    // `task_intent` does NOT ride along yet, deliberately. meterAiCall's fifth
    // argument is extra UNITS (numbers keyed by unit name), not a label, and
    // usage_meter's PK is (day, board, capability, provider, model, unit) with
    // nowhere for a string. Attribution is stage 2, behind the provider
    // namespacing migration; the PARAMETER ships now because changing a tool
    // schema later churns every connected client, and adding a meter dimension
    // churns nothing.
    await meterAiCall(
      db,
      board.id,
      { capability: "embed", provider: embedder.provider, model: embedder.model },
      usage
    ).catch(() => {}); // the ledger never breaks the answer
    probes = [vectors[0]];
  }

  const scores = new Map();
  for (const it of rows) {
    const vecs = byEntity.get(Number(it.id));
    if (!vecs) continue;
    let best = -Infinity;
    for (const v of vecs) {
      for (const p of probes) {
        if (v.length !== p.length) continue; // stale dims mid-model-change
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i] * p[i];
        if (s > best) best = s;
      }
    }
    if (best > -Infinity) scores.set(it.id, best);
  }
  if (!scores.size) {
    notes.push("None of the matching cards has been embedded yet, so they are listed newest first rather than by meaning.");
    return null;
  }

  let ordered = rows.filter((it) => scores.has(it.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id));
  if (args.similar_to == null) {
    // The relative cutoff, over the FILTERED set — see SCORE_WINDOW.
    const top = scores.get(ordered[0].id);
    ordered = ordered.filter((it) => scores.get(it.id) >= top - SCORE_WINDOW);
  }
  const unembedded = rows.length - scores.size;
  if (unembedded > 0) {
    notes.push(`${unembedded} matching card${unembedded === 1 ? " is" : "s are"} not embedded yet and could not be ranked.`);
  }
  return { rows: ordered, scores };
}

// What tools/list answers with, and what the MCP tab renders. `handler` and
// `write` are ours, not the protocol's, so neither goes out.
//
// A switched-off write is ABSENT here rather than present-and-refusing: a
// vocabulary that offers what the server will decline is a lie, and this list
// is also the tab's own tool table, so the switch explains itself — untick it,
// watch the row go. mcp.js still answers a call from a client that listed
// earlier; see its note on that.
export const toolSpecs = (write = true, uiUri = null) =>
  TOOLS.filter((t) => write || !t.write).map(({ handler, write: w, ui, ...spec }) => ({
    ...spec,
    // DERIVED from the `write` marker rather than declared beside it. Spelling
    // "this tool writes" twice — once as the gate that hides it when saving is
    // off, once as `readOnlyHint: false` — is two fields encoding one fact with
    // nothing reconciling them; a sixth tool given the annotation and not the
    // marker would be listed and executed with saving switched off.
    annotations: w ? WRITE_TOOL : READ_TOOL,
    // The tool says it HAS a view; mcp.js says where that view lives, because
    // the resource is the transport's to serve and its uri is built from the
    // server name. Attached unconditionally when a uri is passed: `_meta` is
    // MCP's extension slot and unknown keys are ignored by construction, so a
    // client with no MCP Apps support drops it and renders the text — which is
    // exactly what Claude Code does today (mcp-stage-4.md §2.1). Checking
    // capabilities first would mean sessions, to satisfy a SHOULD we already
    // satisfy in substance by always returning a meaningful text result.
    ...(ui && uiUri ? { _meta: { ui: { resourceUri: uiUri, visibility: ["model", "app"] } } } : {}),
  }));

// Unfiltered on purpose. Whether a tool may RUN is mcp.js's question, asked
// against the same `write` marker — resolving the name and refusing the call
// are two answers, and collapsing them here would turn a switched-off tool
// into "no such tool".
export function findTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}
