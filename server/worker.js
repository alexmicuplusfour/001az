import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  claimFairBatch,
  setEntityFaceAt,
  updateItemPayload,
  landTranscript,
  markTagged,
  markExtracted,
  objectKeysOf,
  resetEntityToShell,
  deleteEmptyEntities,
  failOrRequeue,
  recoverStuck,
  getBoard,
  dueBoards,
  retagBoard,
  supersedeFacetDiagnostics,
  setBoardNextRun,
  itemsNeedingEmbedding,
  audioNeedingTranscription,
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
  openJob,
  jobLogWrite,
  stampJobLog,
  deleteJobLog,
  latestSettledJob,
  markInterruptedJobs,
  pruneJobLog,
  pruneUsageMeter,
  pendingWebhookFirings,
  requeueItemForTag,
  advanceFaced,
  advanceFetched,
  landEntityFetch,
  dueIngestBoards,
  settleIngestRun,
  ingestRunGate,
  ingestedKeys,
  recordIngest,
  withPluginHealth,
  withTx,
  reapEmptyEntities,
} from "./db.js";
import { CAPABILITY } from "./capabilities.js";
import { meterAiCall, meterAiCalls, spentDetail } from "./metering.js";
import { learnPrices } from "./price-learner.js";
import { wantedGeneration } from "./pricing.js";
import { resolveIngestAdapter, ingestMode, nextScheduledIngestRun, RUN_CAP, CONTINUOUS_MS } from "./ingestion/index.js";
import { evaluateItemAlerts, createDueFirings, deliverFiring, webhookBucket } from "./alerts.js";
import { facetStamp, diagnoseCandidates, diagnoseAnswer } from "./facet-diagnosis.js";
import { applyLimit, runWindow } from "./ingestion/filter-engine.js";
import { callTagger, embedTexts, transcribeAudio, detectObjects, PROVIDERS, aiKeyBucket } from "./providers.js";
import { wait as poolWait, release as poolRelease, backoff, maxFor } from "./resource-pool.js";
import { runKinds } from "./resource-loop.js";
import { sidecarUrl } from "./sidecar-catalog.js";
import { pluginState } from "./plugins.js";
import { resolveCapability, capabilityConfig } from "./capability-resolve.js";
import { getConnector, prefetchDueRefreshes, prefetchClaimedFetches } from "./connectors/index.js";
import { entityRefreshAt, faceSchedule, firstRefreshAt, activeProvider } from "./connectors/runtime.js";
import { connectorLanding, fetchProjectedEntity } from "./connectors/add.js";
import { storeFace } from "./faces/index.js";
import { extractFileFields, projectEntry } from "./media/index.js";
import { aiWork, FIELD_SOURCE, keysCards } from "./field-sources.js";
import { sharpGate, MAX_DECODE_PIXELS } from "./sharp-gate.js";
import { aiImageFor, resolvePreset, GENERIC_IMAGES } from "./ai-image.js";

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

// The app-default tagger: settings-designated key, else the legacy env rung.
// Returns { provider, apiKey, model, keyId } or null when nothing is configured
// (tagging's floor is `blocked` — the queue waits rather than failing). `keyId`
// is which rung answered — a connection row, or "env"; naming it for a human is
// the route's job.
export const resolveDefaultAi = (db) => resolveCapability(db, "tag");

// The app-global embedder for semantic search. Null when the enable flag is off
// or nothing usable is bound (embed's floor is `off`), which is what pauses the
// sweep.
export const resolveEmbedder = (db) => resolveCapability(db, "embed");

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
// default. Since slice 5 this is just the generic board rung — judged by the
// same rules as the app default, falling through loudly (the resolver logs the
// miss) — kept as an adapter because its callers hold cache-snapshot fragments
// ({ aiKeyId, aiModel }), not board rows. Exported for tests.
export const resolveBoardAi = (db, boardEntry) =>
  resolveCapability(db, "tag", { board: { ai_key_id: boardEntry.aiKeyId, ai_model: boardEntry.aiModel } });

// A CONFIGURATION GAP: nothing is bound (or installed, or running) to do this
// work. Not an item failure — the item is fine, the instance isn't ready — so
// `noCount` tells every consumer to requeue without consuming an attempt:
// failOrRequeue skips the increment and spaces the retry (db.js), the leg logs
// skip the row, and transcribeFailurePolicy answers "wait, never park". The
// claim queries normally keep such items unclaimed; this covers the races and
// the per-board residue they can't express.
export function configGapError(message) {
  const e = new Error(message);
  e.noCount = true;
  return e;
}
const noKeyError = () => configGapError("no API key configured");

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

// `scoped` builds a prompt for a PARTIAL pass — some of the board's facets, not
// all of them (facet-addressable tagging, stage 2). It drops the whole-item
// description and the fit verdict from both the schema and the prose, because a
// pass that only speaks for some facets has no business re-deriving either and
// will not write them.
//
// The unscoped strings below are left byte-for-byte alone rather than factored
// with the scoped ones. Prompt wording is worth ~4 accuracy points here, so
// "obviously equivalent" refactors of it are not worth the risk — and
// test/prompt-snapshot.test.js pins them either way.
export function buildPrompt(facets, context = "", withReasoning = true, subject = "items", withResearch = false, scoped = false) {
  const lines = facets.map((f) => {
    const note = f.single ? " — pick exactly one" : "";
    return `- ${f.key} (${facetGloss(f)}): ${f.values.join(", ")}${note}`;
  });
  const contextBlock = context.trim() ? `\n${context.trim()}\n` : "";
  // Phrased conditionally on purpose: the systemText is cached per board, but
  // the provider is resolved per item (per-board key with app-default
  // fallback), and only providers that declare research get a search tool.
  const researchPara = withResearch
    ? `\nIf a web search tool is available, you may use it to check recent real-world facts about the item before judging. Always finish by calling record_tags exactly once.\n`
    : "";
  // Four variants, written out rather than composed: the scoped pair drops the
  // description opener and the "when the fit verdict is undecided…" clause,
  // both of which name things a scoped schema no longer has. Leaving that
  // instruction in would tell the model about a verdict it cannot return.
  const selectPara = scoped
    ? withReasoning
      ? `For each facet, first write one short reasoning sentence naming what is visible that drives the choice (or why nothing applies), then select every applicable value. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's values empty when nothing applies. Be accurate and conservative; do not invent values outside the allowed lists.`
      : `For each facet, select every applicable value. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's array empty when nothing applies. Be accurate and conservative; do not invent values outside the allowed lists.`
    : withReasoning
    ? `Start with a freeform description of the item as a whole — one or two sentences covering what it is and its overall style and mood. Then for each facet, first write one short reasoning sentence naming what is visible that drives the choice (or why nothing applies), then select every applicable value. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's values empty when nothing applies (when the fit verdict is "undecided", leave every facet's values empty, including "pick exactly one" facets). Be accurate and conservative; do not invent values outside the allowed lists.`
    : `For each facet, select every applicable value. Facets are independent; most allow multiple values. Facets marked "pick exactly one" must have exactly one value selected. Choose only tags you can clearly justify from what is visible. Leave a facet's array empty when nothing applies (when the fit verdict is "undecided", leave every facet empty, including "pick exactly one" facets). Be accurate and conservative; do not invent values outside the allowed lists.`;
  // No replacement text when scoped: the model simply sees fewer facets and has
  // no way to know others exist, so explaining that this is a partial pass would
  // raise a question it cannot act on.
  const fitPara = scoped
    ? ""
    : `Also decide whether the item is the kind of material the facets below can describe at all. If you can honestly justify facet selections from what is visible, the item is a match — set the fit verdict to "match" even when it falls outside the board's stated focus; recording that is what the facets themselves are for. Set the fit verdict to "undecided" only when the item is a different kind of material altogether and the facets simply do not apply, so that selecting values would be pure guessing; in that case leave every facet's values empty. Never combine "undecided" with facet selections: an item you were able to describe with the facets is a match by definition.\n\n`;
  const systemText = `You tag ${subject} for a private research gallery.${contextBlock}
${fitPara}${selectPara}
${researchPara}
Facets and allowed values:
${lines.join("\n")}

Return your answer only by calling the record_tags tool.`;

  const properties = {};
  const required = [];
  // Declared (and emitted) first: the model describes the whole item before
  // judging facets. Skipped if a facet claims the key, so `required` can't
  // end up with a duplicate entry.
  if (withReasoning && !scoped && !facets.some((f) => f.key === "description")) {
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
  //
  // A scoped pass makes no whole-item verdict, so it does not ask for one. Note
  // the side effect: unscoped, a facet named `fit` is deliberately overwritten
  // here and never gets asked about at all; scoped, it would keep its own slot.
  // The retag routes refuse `fit` as a scope key rather than let that facet
  // behave one way in one mode and another way in the other.
  if (!scoped) {
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
  }
  const schema = { type: "object", properties, required, additionalProperties: false };
  return { systemText, schema };
}

// ─── vote mode ───────────────────────────────────────────────────────────────
// Re-running one prompt on one item changes 18-22% of facet answers (measured
// 2026-08-06). A board with ai_votes > 1 tags each item that many times and
// keeps what the model repeats. Both helpers are pure so they test without
// fixtures; the orchestration lives in tagOne.

const sameSet = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);

// One tool-call result -> the normalised shape mergeVotes consumes. This is
// also the ONE place the ai_reasoning:false schema is reconciled with the
// reasoning-on one: that board emits `fit` as a bare enum string and no
// description at all, and the merge must never see two shapes.
export function parseRun(input, facets, allowed) {
  const picks = {};
  const reasoning = {};
  for (const f of facets) {
    const entry = input[f.key];
    // Tolerate the pre-reasoning shape (bare array) in case the model drifts.
    const vals = Array.isArray(entry) ? entry : entry && Array.isArray(entry.values) ? entry.values : [];
    picks[f.key] = vals.filter((v) => allowed.has(`${f.key}/${v}`)).sort();
    if (entry && typeof entry.reasoning === "string" && entry.reasoning.trim()) {
      reasoning[f.key] = entry.reasoning.trim();
    }
  }
  // `fit` normalises exactly like `description` below, and for the same reason:
  // one shape for the merge, one shape for the store. The trim is not cosmetic —
  // the schema marks fit.reasoning REQUIRED, so a model with nothing to say
  // answers with whitespace rather than omitting the key, and a truthy blank
  // beats the lightbox's fallback copy to the undecided note (lightbox.js) and
  // renders an empty box. The typeof check covers the strictTools:false
  // providers, whose schema is advisory. tagOne trusts this and re-checks
  // nothing.
  const rawFit = typeof input.fit === "string" ? { verdict: input.fit } : input.fit || {};
  const fit = { verdict: rawFit.verdict };
  if (typeof rawFit.reasoning === "string" && rawFit.reasoning.trim()) {
    fit.reasoning = rawFit.reasoning.trim();
  }
  // The typeof check keeps a facet named "description" (whose entry is an
  // object) from landing here.
  const description = typeof input.description === "string" && input.description.trim()
    ? input.description.trim()
    : undefined;
  return { picks, reasoning, description, fit };
}

// Merge N independent taggings of ONE item. `runs` is in call order, so runs[0]
// is the first (cache-warming) call and wins every tie.
//
// Per facet the merge records { of, agreed, votes, d }:
//   of      — how many runs actually completed (NOT the configured ai_votes;
//             a failed vote leaves fewer, and an escalating count would vary)
//   agreed  — how many of them selected exactly what was kept. One definition
//             for both facet kinds; agreed === of always means unanimous.
//   votes   — the full tally, INCLUDING the values that lost.
//   d       — the definition stamp (facetStamp): WHICH wording and WHICH prompt
//             shape produced the three numbers above. Omitted when `stamps`
//             doesn't carry the facet, which is what a pre-stamp entry looks
//             like and must never be mistaken for a current one.
//
// The losing values are the reason this is an object rather than a bare
// fraction. A facet that fails to converge keeps nothing, so the merged answer
// records no trace of what the model was torn between — and that tension is
// exactly what the facet-diagnosis pass needs to read (work item 3). Discarding
// it would leave "construction is unstable on 18 items" with no way to say what
// it was unstable BETWEEN.
//
// `stamps` is optional and defaults to none: an unstamped merge is exactly what
// a caller with no board prompt behind it (a test, anything pre-migration) has,
// and forcing one would mean inventing a definition nobody measured against.
export function mergeVotes(facets, runs, stamps = {}) {
  if (runs.length === 1) return { ...runs[0], confidence: {} }; // votes=1 is the identity
  // STRICT majority, and floor+1 rather than ceil on purpose: ceil(N/2) is a
  // real majority only for odd N — at N=4 it would let a value supported by
  // exactly half survive. runs.length is not guaranteed odd (a hand-edited
  // ai_votes, or a round where some votes failed), so the threshold must not
  // depend on the route enforcing it.
  const need = Math.floor(runs.length / 2) + 1;
  const picks = {};
  const reasoning = {};
  const confidence = {};

  for (const f of facets) {
    // Insertion order is run order, so a tie resolves to the earliest run.
    const count = new Map();
    for (const r of runs) for (const v of r.picks[f.key] || []) count.set(v, (count.get(v) || 0) + 1);

    let chosen;
    if (f.single) {
      // argmax, NOT a majority threshold: three runs giving three different
      // answers must still yield one. Leaving it empty would read downstream as
      // "nothing applies" — a different claim, and one the fit guard acts on.
      let best = null;
      let bestN = 0;
      for (const [v, n] of count) if (n > bestN) { best = v; bestN = n; }
      chosen = best === null ? [] : [best];
    } else {
      chosen = [...count].filter(([, n]) => n >= need).map(([v]) => v).sort();
    }
    picks[f.key] = chosen;
    confidence[f.key] = {
      of: runs.length,
      agreed: runs.filter((r) => sameSet(r.picks[f.key] || [], chosen)).length,
      votes: Object.fromEntries(count),
      ...(stamps[f.key] ? { d: stamps[f.key] } : {}),
    };

    // The justification must belong to the answer that was KEPT — take it from
    // the earliest run that actually made that selection, and from NOWHERE if
    // no run made it. There is no runs[0] fallback on purpose: on a multi-value
    // facet the merge routinely keeps a set no single run proposed (three runs
    // agree on monoline and each add a different second value -> monoline
    // alone), and runs[0]'s sentence then argues for the values that were just
    // dropped. Single-value facets always find a source, so this only ever
    // withholds a sentence that would have been about something else.
    const src = runs.find((r) => sameSet(r.picks[f.key] || [], chosen));
    if (src?.reasoning[f.key]) reasoning[f.key] = src.reasoning[f.key];
  }

  // description + fit come from ONE run — whichever agreed with the merged
  // result most often — so the item's prose stays internally coherent instead
  // of being stitched from runs that contradicted each other.
  const score = (r) => facets.filter((f) => sameSet(r.picks[f.key] || [], picks[f.key])).length;
  const best = runs.reduce((a, b) => (score(b) > score(a) ? b : a), runs[0]);
  const undecidedVotes = runs.filter((r) => r.fit?.verdict === "undecided").length;

  return {
    picks,
    reasoning,
    confidence,
    description: best.description,
    // Tie -> match: the filledFacets guard in tagOne already arbitrates the real
    // decision, and "match" is the recoverable side of a wrong call.
    fit: { verdict: undecidedVotes > runs.length / 2 ? "undecided" : "match", reasoning: best.fit?.reasoning },
  };
}

// ─── facet scope ─────────────────────────────────────────────────────────────
// A tagging pass can be told which facets it is allowed to WRITE (items.tag_facets,
// migration 0030). The pass itself is unchanged — it still asks for every facet —
// so this is purely a landing-side filter. See planning/facet-addressable-tagging-plan.md.

// Group `facet/value` tags by facet key. Same discipline as db.js tagsByFacet,
// including its `i <= 0` guard: a tag with no separator has no facet and must
// not be turned into one by a slice(0, -1).
function groupTags(tags = []) {
  const m = new Map();
  for (const t of tags) {
    const i = t.indexOf("/");
    if (i <= 0) continue;
    if (!m.has(t.slice(0, i))) m.set(t.slice(0, i), []);
    m.get(t.slice(0, i)).push(t.slice(i + 1));
  }
  return m;
}

// Fold a scoped tagging result into what the item already has. `prev` and `next`
// arrive in the same shape ({ tags, reasoning, confidence }) — the call site
// adapts the db row's column names, so this never has to know which side is which.
//
// `facets` is the board's ORDERED facet list and rebuilding through it is not
// cosmetic: tagOne emits tags in board-facet order, so sorting the merged array
// instead would make a scoped landing store a different order than a full one,
// flipping with whichever path wrote last.
//
// `description` and `fit` need no special case — they are reserved keys in
// tag_reasoning, never facet keys, so they are never in `keep` and ride through
// on the spread. (A board MAY declare a facet literally named `description`;
// buildPrompt gives it the facet slot, and scoping to it then replaces it, which
// is what falling through already does.)
export function scopeResult(facets, scope, prev, next) {
  if (!scope?.length) return next; // unscoped is the identity — byte-for-byte
  const keep = new Set(scope);
  const prevBy = groupTags(prev.tags);
  const nextBy = groupTags(next.tags);

  // Walking `facets` also drops a stored tag whose facet is no longer on the
  // board. That is the right answer — the facet is gone, its tags are orphaned —
  // but it means a scoped pass quietly garbage-collects them too.
  const tags = [];
  for (const f of facets) {
    for (const v of (keep.has(f.key) ? nextBy : prevBy).get(f.key) || []) tags.push(`${f.key}/${v}`);
  }

  const pick = (a = {}, b = {}) => {
    const out = { ...a };
    for (const k of keep) {
      delete out[k];
      if (b[k] !== undefined) out[k] = b[k];
    }
    return out;
  };
  return {
    tags,
    reasoning: pick(prev.reasoning, next.reasoning),
    confidence: pick(prev.confidence, next.confidence),
  };
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

// A field with a declared, non-empty options list — the answer is a
// zero-or-more selection from it (buildFieldsPrompt's enum array, the
// landing's `kind: "list"` stamp). One spelling for the prompt and the leg.
export const hasOptions = (f) => Array.isArray(f?.options) && f.options.length > 0;

// Land a list field's answer: the model's `values` filtered to the field's
// options (the schema enum already forbids off-list answers on strict
// providers, but a best-effort provider can still return one — the bounded
// set is the whole point), keyed on the same normalisation the entity
// resolver uses, deduped, and spelled the way the OPTION is spelled, not the
// way the model echoed it — so a card minted from it is named as the user
// declared. A non-array answer lands as "matches none".
export function landListValues(field, values) {
  const canon = new Map(field.options.map((c) => [normaliseIdentity(c.value), c.value.trim()]));
  const out = [];
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v !== "string") continue;
    const spelled = canon.get(normaliseIdentity(v));
    if (spelled && !out.includes(spelled)) out.push(spelled);
  }
  return out;
}

// The mapping's extract fields with the card key first — the order the model
// commits to them in (the schema's `required` and the system text's field
// list both follow it). Only extract-sourced fields reach the model: file
// fields are projected deterministically from the stored entry, connector
// fields come from the source, and detect fields ride the detector pass in
// extractOne — this builder IS the extract source's engine, so naming its own
// source id here is legitimate (field-sources.js).
export function extractFieldsOf(mapping) {
  const fields = ((mapping && mapping.fields) || []).filter((f) => f.source === "extract");
  const by = mapping?.card?.by;
  const at = by ? fields.findIndex((f) => f.key === by) : -1;
  return at > 0 ? [fields[at], ...fields.slice(0, at), ...fields.slice(at + 1)] : fields;
}

// The card key's field, or null when cards are minted per file (or the
// pointer names a field that can't key cards — validation refuses that on
// save, so it only reads that way off a mapping the API wrote). The one
// place the extract leg dereferences the pointer; eligibility is the table's
// (keysCards), the same rule validateMapping applies.
export const cardFieldOf = (mapping) => {
  const by = mapping?.card?.by;
  return by ? (mapping.fields || []).find((f) => f.key === by && keysCards(FIELD_SOURCE[f.source])) || null : null;
};

// Build the extraction prompt + strict schema for a mapping's AI fields.
// Pure function — no cache needed (extraction runs once per item; mappings
// vary per item so a board-level cache wouldn't help).
export function buildFieldsPrompt(mapping) {
  const fields = extractFieldsOf(mapping);
  // The pointer itself: it can only match one of the extract fields above, so
  // a dangling one matches nothing — no second lookup needed.
  const cardKey = mapping?.card?.by ?? null;

  // One line per field. A field with options lists them (with their per-value
  // hints — the schema enum can't carry those) under a cardinality clause the
  // SYSTEM states, not the user's prose: multi, paired with a conservatism
  // clause so "select all that apply" doesn't become "select everything", and
  // "not only the closest single match" to counter a hint phrased as a
  // superlative. The card key's line carries the consistency clause instead
  // when it is open-ended — merge/split needs same subject → same value, and
  // with no list that guidance is the only signal the model has. Framing it
  // as "the entity's unique key" made models favour uniqueness over the
  // user's format (echoing filenames verbatim), so it stays a trailing clause.
  const lines = fields.map((f) => {
    const ask = f.instruction || f.key;
    if (hasOptions(f)) {
      const opts = f.options.map((c) => `    - ${c.value}${c.hint ? `: ${c.hint}` : ""}`).join("\n");
      return `- ${f.key}: ${ask} — an item can match more than one: select every option that genuinely applies` +
        ` (one, several, or none), not only the closest single match; pick only options you can clearly justify:\n${opts}`;
    }
    const consistency = f.key === cardKey ? " — the same subject must always produce the same value" : "";
    return `- ${f.key} (${f.kind}): ${ask}${consistency}`;
  });
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
  // Every property is why-before-value; only the value slot differs. A field
  // with options mirrors the facet enum-array shape (why + values[]): the
  // closed enum makes an off-list answer structurally impossible and an empty
  // array is the legal "matches none". Everyone else keeps the nullable scalar.
  for (const f of fields) {
    const slot = hasOptions(f)
      ? { values: { type: "array", items: { type: "string", enum: f.options.map((c) => c.value) } } }
      : { value: { type: [kindType[f.kind] || "string", "null"] } };
    const [slotKey] = Object.keys(slot);
    properties[f.key] = {
      type: "object",
      description: f.instruction || f.key,
      properties: {
        why: { type: "string", description: `One short sentence justifying the ${slotKey === "values" ? "selection(s), or why none apply" : "value, or why it was not found"}.` },
        ...slot,
      },
      required: ["why", slotKey],
      additionalProperties: false,
    };
    required.push(f.key);
  }
  const schema = { type: "object", properties, required, additionalProperties: false };
  return { systemText, schema };
}

// Per-board cache: board_id -> { systemText, schema, allowed, facets, stamps, research, aiKeyId, aiModel }
// Invalidated on board PATCH (server.js) and cleared entirely on key deletion.
const boardPromptCache = new Map();

// `scope` = the facet keys a partial pass may write (items.tag_facets). It
// narrows the PROMPT as well as the write, so a board has one cached entry per
// distinct scope — hence a nested map. Nesting rather than a compound key is
// deliberate: it keeps invalidateBoardCache a single delete, so a facet edit
// cannot leave a scoped variant alive and tagging against the old gloss.
async function getBoardPrompt(db, boardId, scope = null) {
  const key = scope?.length ? [...scope].sort().join(",") : "";
  const byScope = boardPromptCache.get(boardId);
  if (byScope?.has(key)) return byScope.get(key);
  const board = await getBoard(db, boardId);
  if (!board || !board.facets.length) return null;
  const { context } = board;

  // Two facet lists, and they are NOT interchangeable:
  //   facets    — what this pass asks about and parseRun walks
  //   allFacets — the board's full ordered list, which scopeResult rebuilds the
  //               merged tag array through. Hand it `facets` on a scoped pass
  //               and it emits only the scoped facets, silently deleting every
  //               other facet's tags.
  const allFacets = board.facets;
  const facets = scope?.length ? allFacets.filter((f) => scope.includes(f.key)) : allFacets;
  if (!facets.length) return null; // the scoped facet left the board — nothing to ask

  // Board-wide on purpose: parseRun only asks allowed.has() for facets it is
  // already walking, so a wider set is inert while a narrower one would silently
  // filter valid answers.
  const allowed = new Set();
  for (const f of allFacets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const research = board.ai_research === true;
  // Boards mix file kinds now, so the honest per-board subject is "items";
  // the per-item wording ("Tag this image/document…") rides in the user turn.
  const { systemText, schema } = buildPrompt(
    facets, context, board.ai_reasoning !== false, "items", research, !!scope?.length
  );
  // Clamped here rather than trusted from the column: the route validates it,
  // but a hand-edited row must not fan out unboundedly.
  //
  // Research forces a single pass, and this is the load-bearing guard, not the
  // route's: web_search bills per search (up to MAX_SEARCHES) ON TOP of tokens,
  // so N votes multiply a cost the token estimate never sees. Anyone enabling
  // votes by touching the column directly gets the same protection.
  const votes = research ? 1 : Math.max(1, Math.min(5, Number(board.ai_votes) || 1));
  // One stamp per facet this pass asks about, computed HERE rather than per item:
  // the cache is already keyed by board AND scope, which is exactly the
  // granularity the hash needs (§2 of the diagnosis plan). Keyed by facet key
  // rather than stamped onto the facet objects, which are board.facets and
  // shared with allFacets.
  const stamps = Object.fromEntries(facets.map((f) => [f.key, facetStamp(f, !!scope?.length)]));
  // imagePreset is the board's own PIN only (null = follow the app default) —
  // the effective value is resolved per job, deliberately uncached: see
  // effectivePreset in startWorker.
  const entry = { systemText, schema, allowed, facets, allFacets, stamps, research, votes, aiKeyId: board.ai_key_id, aiModel: board.ai_model, imagePreset: board.tag_image_preset };
  if (byScope) byScope.set(key, entry);
  else boardPromptCache.set(boardId, new Map([[key, entry]]));
  return entry;
}

// What a board's work on a given leg CONTENDS FOR — the resource string the
// concurrency pool and the rate limiter both key on (queue-by-resource-plan.md
// Stage 2). Per BOARD, not per item: the key is a property of the board, and
// resolving it here is strictly cheaper than today's per-item resolveCapability
// inside tagOne (which has no cache at all).
//
// NULL MEANS UNCONSTRAINED, never unclaimable. The two questions — "can this run
// at all" and "what does it contend for" — do not collapse, and the claim query
// answers the first on its own. A face item on a board with no connector
// resolves to null here and must still claim: it renders nothing and advances,
// which is real work that completes.
//
// aiKeyBucket is IMPORTED, not re-spelled, so the pool and the pacing bucket can
// never bound two different things under one name. extract resolves through its
// own capability, which falls through to the board's tagger when unpinned — so a
// board that pins neither has one resource for both legs, which is the truth:
// one key, one quota.
const boardResourceCache = new Map(); // boardId -> { [leg]: string|null }

export async function boardResource(db, leg, board) {
  if (!board) return null;
  const hit = boardResourceCache.get(board.id);
  if (hit && leg in hit) return hit[leg];
  let resource = null;
  // Which kind of leg this is comes from the capability REGISTRY, not a list
  // kept here. `tag`, `extract` and `transcribe` name capabilities and resolve
  // through one; `face`, `fetch` and `refresh` name connector work and contend
  // for the connector's active provider. Derived because the hand-kept version
  // was a deny-list of the connector legs, and `refresh` — added in Stage 5,
  // months after the list — fell through to the capability branch, asked
  // resolveCapability for a capability that does not exist, and got back a
  // silent null. Null means UNCONSTRAINED, so every due entity launched every
  // tick and the pool (with the provider backoff sitting in it) was never
  // consulted at all.
  if (CAPABILITY[leg]) {
    const b = await resolveCapability(db, leg, { board });
    // The presence-gated floor is an on-box engine rather than a quota, so it
    // wears the `sidecar:` name its own wire waits on — the same string, which is
    // the whole discipline here. A keyed provider buckets per account,
    // keyless-networked per provider (aiKeyBucket's own "nokey" rung), and an
    // on-device one has no quota to contend for at all.
    if (b?.viaFloor && leg === "transcribe") resource = WHISPER_RESOURCE;
    else if (b && !PROVIDERS[b.provider]?.onDevice) resource = aiKeyBucket(b.provider, b.apiKey);
  } else {
    const name = board.mapping?.input?.connector;
    const conn = name ? getConnector(name) : null;
    // activeProvider THROWS when every provider of the domain is uninstalled.
    // That is a configuration gap, not a resource — the leg still runs and
    // degrades (processFaceOne renders nothing and advances), so it must not
    // become an exception in the dispatcher.
    if (conn) {
      try { resource = `conn:${(await activeProvider(db, conn)).name}`; }
      catch { resource = null; }
    }
  }
  boardResourceCache.set(board.id, { ...(hit || {}), [leg]: resource });
  return resource;
}

// The same answer from a board ID, which is what every caller actually holds.
// The cache is consulted BEFORE the board is read, so a board already seen costs
// nothing at all — without this the row read happened on every hit and the cache
// only ever saved the capability resolution. That matters most to the sweeps,
// which resolve every unit they enumerate including the ones they then drop.
export async function boardResourceFor(db, leg, boardId) {
  if (!boardId) return null;
  const hit = boardResourceCache.get(boardId);
  if (hit && leg in hit) return hit[leg];
  return boardResource(db, leg, await getBoard(db, boardId));
}

// What the app's embedder contends for — app-GLOBAL, unlike boardResource: one
// embedder serves every board. A keyed provider buckets by account, the same
// string tagging on that key uses (one quota); an on-device one buckets by the
// box, the `local:` class whose one-of-a-kind rule is written at resource-pool.js.
// Not folded into boardResource: on-device returns null there on purpose, since
// nothing would HOLD a `local:` slot for a tag leg — here the sweep's `run` does.
export const embedResource = (e) => (PROVIDERS[e.provider]?.onDevice
  ? `local:${e.provider}`
  : aiKeyBucket(e.provider, e.apiKey));

// One delete drops every scope variant — see the nesting note above.
export function invalidateBoardCache(boardId) {
  boardPromptCache.delete(boardId);
  boardResourceCache.delete(boardId);
}

export function invalidateAllBoardCaches() {
  boardPromptCache.clear();
  boardResourceCache.clear();
}

// Embed one batch of rows (itemsNeedingEmbedding shape), isolating poison
// inputs. The batch is one API call PER BOARD present in it: the wire answers
// one usage total per call, so a call whose rows spanned boards would leave
// the per-board split a guess — apportionment, which the meter never does.
// The sweep's pull is app-wide and usually single-board, so this costs an
// extra HTTP call only when a pull genuinely mixes boards.
// Returns { embedded, skipped } summed across groups; throws for batch-level
// failures (a mid-way throw leaves earlier groups' work standing — the same
// partial progress the isolation path already produces). Exported so the
// sweep and tests share one path.
export async function embedBatch(db, embedder, rows) {
  const { rpm, burst } = await aiRate(db, embedder.provider); // per-provider pacing (local: none)
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.board_id)) groups.set(r.board_id, []);
    groups.get(r.board_id).push(r);
  }
  let embedded = 0, skipped = 0;
  for (const g of groups.values()) {
    const res = await embedGroup(db, embedder, g, { rpm, burst });
    embedded += res.embedded;
    skipped += res.skipped;
  }
  return { embedded, skipped };
}

// One board's slice of the batch — the wire calls, the poison isolation, and
// the metering, which is why every row here shares a board. The whole group is
// one API call on the happy path. When it fails with a request-content 4xx —
// the only class that can be item-specific; auth/model/rate statuses
// (401/403/404/408/429) and 5xx/network are the caller's to back off on —
// each item is retried alone: lone failures are marked (setItemEmbedError)
// and skipped by future sweeps, innocents proceed. If NOTHING succeeds
// one-by-one, the 400 was config-shaped after all (e.g. a provider that
// rejects a bad model as 400), so throw for the backoff instead of wrongly
// marking a whole batch.
async function embedGroup(db, embedder, rows, { rpm, burst }) {
  const t0 = Date.now();
  const dims = { capability: "embed", provider: embedder.provider, model: embedder.model };
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
    const { vectors, usage } = await call(rows);
    // Meter BEFORE the landing (the tag leg's rule, worker-queue-holes #11):
    // the tokens are spent whatever the writes below do, and the write itself
    // never throws (meterWrite).
    await meterAiCall(db, rows[0].board_id, dims, usage);
    for (let i = 0; i < rows.length; i++) await setItemEmbedding(db, rows[i].id, vectors[i], embedder.model);
    return { embedded: rows.length, skipped: 0 };
  } catch (err) {
    const s = Number(err?.status);
    const isolatable = Number.isInteger(s) && s >= 400 && s < 500 && ![401, 403, 404, 408, 429].includes(s);
    if (!isolatable || rows.length <= 1) throw err;
  }
  let embedded = 0;
  const failures = [];
  const usages = [];
  for (const r of rows) {
    try {
      const { vectors, usage } = await call([r]);
      usages.push(usage);
      await setItemEmbedding(db, r.id, vectors[0], embedder.model);
      embedded++;
    } catch (e) {
      failures.push({ row: r, message: String(e?.message ?? e) });
    }
  }
  // One write for the salvage round's paid calls — `requests` counts the
  // calls that ANSWERED; a failed call returned no usage, and inventing a
  // number for it is exactly what the meter refuses (empty round: no-op).
  await meterAiCalls(db, rows[0].board_id, dims, usages);
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
  const r = await conn.refresh(db, entity, inst, mapping, now, board.id);
  const fields = r.merged || entity.fields;
  const moved = r.merged ? Object.keys(r.moved) : [];

  // Face — regenerate the chart when its own cadence is due (needs the worker's
  // dirs; the sweep passes them, unit tests may not). A rendered face uses a new
  // filename so the immutable cache serves fresh bytes (generateFace unlinks the
  // old). `dirs` absent → skip (fields-only path).
  let faceAt = entity.face_at;
  let faced = false;
  const sched = faceSchedule(mapping);
  // Regenerate when the cadence is due, OR render the first face when the entity
  // has a connector face but none yet (face_at null) — so turning a face on /
  // raising its cadence backfills every existing coin instead of only the ones
  // that happened to render already. The first render is owed even to a face
  // with cadence Off: it's the ONLY way an entity older than its board's face
  // ever gets one (the face leg runs at add time). A face render error is
  // isolated: log and keep going, so it never blocks the field refresh or halts
  // the sweep.
  if (dirs && sched && (faceAt == null || (sched.every && now - faceAt >= sched.every * 60000))) {
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
  if (!conn?.produceFace || faceCfg?.source !== "connector") return null;
  const rendered = await conn.produceFace(db, entity, inst.payload?.source, faceCfg, board.id);
  if (!rendered) { await setEntityFaceAt(db, entity.id, null); return null; } // no history → keep the tile
  const name = crypto.randomBytes(16).toString("hex");
  const stored = await storeFace({ galleryDir, thumbsDir }, name, rendered, { generated: true });
  // `stored` carries `size` here and only here: storeFace reports it when the
  // webp it wrote IS the original, which is exactly the generated case.
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
// The sidecars' resource names, in the pool's `sidecar:` class (max 1 — each is
// genuinely single-threaded, so a second caller waits at the socket either way).
// Named constants because each is spelled at a wait and a release, and a typo
// between the two would leak a slot forever rather than fail.
const EXTRACTOR_RESOURCE = "sidecar:extractor";
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
// Bounds ONE HTTP exchange (a poll), never the job. Submit gets a higher floor
// below — it ships the whole file.
const TRANSCRIBER_HTTP_TIMEOUT_MS = Number(process.env.TRANSCRIBER_HTTP_TIMEOUT_MS) || 30000;
// Job liveness is judged by progress, not wall time: a job whose transcribed
// seconds haven't advanced in this long is declared hung (transient — the next
// attempt re-joins or restarts it; the sidecar's own watchdog restarts a truly
// frozen model). Covers the pre-segment decode+VAD phase of a long clip too.
const TRANSCRIBER_STALL_MS = Number(process.env.TRANSCRIBER_STALL_MS) || 900000;
// The whisper sidecar's pool name — same `sidecar:` class as the extractor and
// detector, same reason for a named constant: it is spelled at a wait, a
// release, a backoff and boardResource, and a typo between any two of them would
// leak a slot forever rather than fail.
const WHISPER_RESOURCE = "sidecar:whisper";

// What a sidecar reports about itself — its model, its baked list, its address
// — lives in ./sidecar-catalog.js, generic over any descriptor that declares
// `liveCatalog`. The sidecar is the ONLY place that names its model (baked at
// image build); nothing app-side mirrors WHISPER_MODEL, so nothing can drift.

// The on-server whisper-sidecar engine, wrapped as an interchangeable descriptor
// { id, model, transcribe } so a provider engine slots in the way resolveEmbedder
// picks local vs a provider. Failure taxonomy for the transcription loop:
//   - `transient: true`, no scope — the sidecar itself is unwell (down, queue
//     full): back off the LANE, no clip is at fault.
//   - `scope: "job"` — this clip's job failed/stalled/vanished: transient for
//     the ITEM (per-item backoff + attempt cap), the lane moves on.
//   - `status: 422` — undecodable input: the loop parks it permanently.
//   - model-not-baked (409, or a pre-409 image's 422 naming it) — config skew,
//     the lane backs off; no clip is at fault.
// `id` comes from the resolved floor binding, not from a literal here — the
// registry owns which provider is transcription's floor, and this engine is
// merely what serves it.
function whisperTranscriber(binding) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // …and its address comes from the same place, off the descriptor the binding
  // names, so the sidecar's URL is declared once (beside its /health, which the
  // admin catalogs read) rather than mirrored in a const here.
  const base = sidecarUrl(binding.provider);
  // The sidecar names its own model: the done payload carries it, and `model`
  // fills in from there — null until a job completes. The cache stamp thus
  // records the model that actually produced the text, even across a mid-job
  // sidecar redeploy.
  let model = null;
  return {
    id: binding.provider,
    get model() { return model; },
    // opts.deadlineMs: give up (transient) if the job hasn't settled by then —
    // for interactive callers like the admin probe, not the worker loop.
    // opts.stallMs: test override for the no-progress window.
    async transcribe(buf, _filename, { deadlineMs = 0, stallMs = TRANSCRIBER_STALL_MS } = {}) {
      // The sidecar is one model on one box, so the worker runs ONE clip at a time
      // through it — and the slot is rightly held for minutes, because the sidecar
      // is busy for every one of them. Six exits below (five throws and the
      // return) are why this is a `finally` and not a release per path.
      //
      // `deadlineMs` marks an interactive caller — today the admin probe — and such
      // a caller never queues here. It cannot: the deadline is measured from
      // inside this function, so a probe parked in `wait` behind a twenty-minute
      // clip would blow its whole budget without once checking it. It submits
      // instead, the sidecar queues it alongside (submission is async: 202 + a
      // job id, nothing serializes at the socket), and the deadline below reports
      // "transcriber busy" exactly as it does today. So the pool here counts the
      // clips the WORKER has in flight, which is the number that sizes its claims.
      const pooled = !deadlineMs;
      if (pooled) await poolWait(WHISPER_RESOURCE);
      try {
        const started = Date.now();
        let sub;
        try {
          // The model rides the submit when one is pinned; absent = the
          // sidecar's own default. An image that predates the axis ignores the
          // parameter and self-reports what it actually ran, so the job log
          // still stamps the truth.
          const url = `${base}/transcribe${binding.model ? `?model=${encodeURIComponent(binding.model)}` : ""}`;
          sub = await fetch(url, {
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
          // The body names the reason when the sidecar sent one, so the probe's
          // toast and the job log say WHY, not just the number.
          let detail = "";
          try { detail = String((await sub.json())?.error || ""); } catch {}
          const e = new Error(`transcriber failed (HTTP ${sub.status})${detail ? `: ${detail}` : ""}`);
          e.status = sub.status;
          // A model this image didn't bake (409; older images say 422 with the
          // same words) means the pinned model and the pulled tag disagree — the
          // clip is innocent. Lane backoff, like an unwell sidecar: fixing the
          // pin or the tag revives everything, where parking would turn a config
          // skew into permanent data loss (the noCount rule's logic).
          if (sub.status === 409 || /not baked/.test(detail)) e.transient = true;
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
            res = await fetch(`${base}/jobs/${jobId}`, { signal: AbortSignal.timeout(TRANSCRIBER_HTTP_TIMEOUT_MS) });
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
            // turns: per-segment { start, end, text, speaker? } — [] = structure
            // produced, no speech; speaker is a relative slot ("S1") when the
            // engine diarized, absent otherwise. null when the sidecar image
            // predates turns — either image can ship first. `text` stays the
            // canonical material; turns are seek/display structure.
            return { text: job.text || "", turns: Array.isArray(job.turns) ? job.turns : null };
          }
          if (job.status === "failed") {
            const e = new Error(`transcriber: ${job.error || "unknown failure"}`);
            e.status = job.permanent ? 422 : 500; // permanent = undecodable input
            e.scope = "job";
            throw e;
          }
          // Liveness = the SUM of both phases' progress: diarized_s advances
          // while the sidecar diarizes (done_s sits at 0 for many minutes on a
          // long clip — it would otherwise trip the stall window), done_s takes
          // over during ASR. Each is monotonic within a job, so any advance in
          // either resets the clock; a pre-diarization sidecar sends neither
          // field's sibling and the sum degrades to plain done_s.
          const done = (Number(job.progress?.done_s) || 0) + (Number(job.progress?.diarized_s) || 0);
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
      } finally {
        if (pooled) poolRelease(WHISPER_RESOURCE);
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
  // A configuration gap (noCount — no engine bound for this board) waits like a
  // faulted job but must never reach the cap: parking a clip because the
  // INSTANCE isn't configured would turn a wait into permanent data loss, and
  // an operator fixing the binding an hour later would find it dead. First
  // rule, so nothing below can promote it to park-capped; the caller likewise
  // leaves attempts untouched for it, the arithmetic failOrRequeue already
  // does for the same flag.
  if (err?.noCount) return "backoff-item";
  const s = Number(err?.status);
  const transient = err?.transient === true || s === 429 || s === 408 || (s >= 500 && s < 600)
    || /unreachable/.test(String(err?.message));
  if (!transient) return "park";
  if (err?.scope !== "job") return "backoff-lane";
  return attempts + 1 >= maxAttempts ? "park-capped" : "backoff-item";
}

// A board's audio→text engine. Resolution is generic (capability-resolve.js);
// this only decides which SHAPE the binding wears — the on-server sidecar, or a
// provider wire. `viaFloor` covers every way the configured choice can fail to
// resolve: unset, an uninstalled plugin, a no-audio provider, a missing key, or
// whisper itself (which advertises transcription with no wire) — and a board's
// deliberate pin of the built-in, which resolves as the floor binding by
// design. Fails to resolve only on a host running no sidecar with no provider
// bound — audio then WAITS to become taggable (blocked semantics), it is never
// failed. `board` is the item's board row (slice 5) — its pin outranks the app
// default. Exported for tests + server.
// The transcript's engine identity ("whisper:large-v3") — stamped onto the
// payload at landing AND compared by reprocessEntity's staleness arm ($4), so
// both sides MUST build it here: a drifted spelling on either end would
// silently make the comparison never (or always) fire, with no error anywhere.
export const engineStamp = (t) => [t?.id, t?.model].filter(Boolean).join(":");

export async function resolveTranscriber(db, board = null) {
  const b = await resolveCapability(db, "transcribe", { board });
  // Null since the floor became presence-gated: no provider bound and the
  // whisper sidecar is not on this host. The caller waits (the lane's gate and
  // per-item backoff), never fails the clip.
  if (!b) return null;
  if (b.viaFloor) return whisperTranscriber(b);
  const { rpm, burst } = await aiRate(db, b.provider); // per-provider pacing, same bucket as tagging
  return {
    id: b.provider, // the engine family; the cache stamp appends :model (→ "openai:gpt-4o-transcribe")
    model: b.model,
    // Runs under the plugin-health ledger like every other provider call
    // (trackedTagger, embedBatch) so transcription traffic + errors show on
    // the Plugins page — otherwise a paid provider transcribes invisibly.
    transcribe: async (buf, filename) => {
      const r = await withPluginHealth(db, `ai:${b.provider}`, () =>
        transcribeAudio({ provider: b.provider, apiKey: b.apiKey, base: b.base, model: b.model, rpm, burst, audio: buf, filename }));
      // turns pass through from the wire when a diarizing model serves it —
      // null until then, the same contract the sidecar path wears. usage
      // likewise: token-billed transcription models report it, the leg
      // meters it (Stage 5b); the sidecar path carries none.
      return { text: r.text, turns: r.turns ?? null, usage: r.usage };
    },
  };
}

// Fold a repeating non-event into its prior row: attempts up, error and
// detail refreshed, this attempt's fresh row retracted. Without the fold a
// failure repeating on its retry cadence is the flat-tick trap in failure
// clothes — a transcriber outage writes a `requeued` row per 60 s backoff,
// a wedged ingest scan one per 30 s tick (a weekend ≈ 3k identical rows).
// The first occurrence and any CHANGE (a different error, something
// admitted, the eventual resolution) still get their own rows. Module scope
// (db passed in) because its users straddle levels: the ingest folds live in
// startWorker's closure, transcribeOne outside it.
const foldJobRepeat = async (db, prior, freshId, { outcome, error = null, detail = {} }) => {
  await jobLogWrite(() => stampJobLog(db, prior.id, {
    outcome, error,
    detail: { ...detail, attempts: (Number(prior.detail?.attempts) || 1) + 1 },
    endedAt: Date.now(),
  }));
  if (freshId != null) await jobLogWrite(() => deleteJobLog(db, freshId));
};

// One clip, end to end: job-log row, resolve the board's engine, transcribe,
// meter, land the transcript, stamp the outcome. Extracted from the loop so
// the flow is testable without racing a poll tick; the loop keeps its lane
// state and reads this function's answer — "backoff-lane" means the ENGINE is
// unwell and the whole lane should sleep; every other outcome ("ok",
// "backoff-item", "parked") is already fully handled here, `retry` (the
// per-clip attempts ledger) included. `retry` is required rather than
// defaulted: a throwaway map would silently disable both mechanisms it exists
// for — the attempt cap, and the per-clip backoff that stops one pathological
// clip blocking the whole audio lane. Never throws.
export async function transcribeOne(db, galleryDir, row, retry) {
  const file = row.payload.files?.[0];
  // A `running` job-log row is the only place "transcribing now" exists —
  // this sweep has no items.status leg. Each attempt is its own row (a
  // transient retry after the backoff opens a fresh one).
  const job = await openJob(db, {
    boardId: row.board_id, entityId: row.entity_ids?.[0] ?? null, itemId: row.id,
    target: file?.original_name || file?.name || null, kind: "transcribe",
  });
  try {
    if (!file) throw new Error("no file on the item");
    // The board's own pin outranks the app default (slice 5). One PK
    // SELECT ahead of a multi-second sidecar/API call — noise here,
    // and the job-log stamp below records engine:model per item, so
    // per-board engines stay visible in job history.
    const board = row.board_id ? await getBoard(db, row.board_id) : null;
    // No engine for THIS board: the claim query admits a board by the SHAPE of
    // its pin, which can't tell a pin that resolves from one that doesn't (a
    // key whose provider was uninstalled), and the engine can vanish between
    // claim and resolve. The residue lands here as a configuration gap — the
    // catch below waits it out on the clip's own backoff, spends no attempt,
    // and folds repeats into one job row.
    const transcriber = await resolveTranscriber(db, board);
    if (!transcriber) throw configGapError("no transcription engine on this server for this board");
    const buf = await fs.promises.readFile(path.join(galleryDir, file.name));
    const { text, turns, usage } = await transcriber.transcribe(buf, file.name);
    // Meter BEFORE the landing (the tag leg's rule): the engine ran whatever
    // the writes below do. The quantity is the clip's own measured duration —
    // an engine-agnostic fact, so the on-device sidecar's volume meters too,
    // priced at its declared zero. It is read through projectEntry, the one
    // place that decides what a file's metadata says (media/index.js): this
    // number multiplies into cost_micros, so it comes from the module that
    // DECLARES it (media/audio.js) rather than from a second reach into the
    // payload bag. A clip with no measured duration meters its call and
    // nothing else: absence, not zero. Token-billed engines meter what their
    // wire reported beside it, through the shared projection (no model prices
    // both seconds AND tokens — verified against the live map, 2026-08-31).
    // Dims are read AFTER the call on purpose: the sidecar self-reports its
    // model in the done payload, so `transcriber.model` now names the model
    // that actually produced this text.
    const secs = Number(projectEntry(file).duration) || 0;
    const dims = { capability: "transcribe", provider: transcriber.id, model: transcriber.model };
    await meterAiCall(db, row.board_id, dims, usage, { audio_seconds: secs });
    // turns ([] included) land beside the flat transcript; the key is
    // absent when the engine gave none (legacy sidecar image, plain
    // provider model) and readers fall back to the flat text. The engine
    // stamp is the job log's spelling, taken post-call so it names what
    // actually produced the text (whisper self-reports its model).
    const engine = engineStamp(transcriber);
    await landTranscript(db, row.id, { text, turns, engine });
    retry.delete(row.id);
    // Distinct speaker count for the job log — engine-agnostic (any
    // diarizing engine's labels count); omitted when zero so
    // speakerless rows read exactly as before.
    const speakers = new Set((turns || []).map((t) => t.speaker).filter(Boolean)).size;
    // What the row spent, in the row's own spelling: seconds beside the
    // kind-specific facts, tokens through the same projection the tag and
    // extract legs use (the modal already renders detail.tokens).
    const { tokens } = spentDetail(dims, [usage]);
    // whisper's model is the sidecar's own answer (null if it predates self-reporting)
    await job.settle({ outcome: "ok", detail: {
      chars: text.length, turns: turns?.length, speakers: speakers || undefined,
      ...(secs ? { seconds: Math.round(secs) } : {}),
      ...(tokens ? { tokens } : {}),
      engine,
    } });
    console.log(`transcribed #${row.id} "${file.original_name}" -> ${text.length} chars`);
    return "ok";
  } catch (err) {
    const attempts = retry.get(row.id)?.attempts || 0;
    const action = transcribeFailurePolicy(err, attempts);
    if (action === "backoff-lane" || action === "backoff-item") {
      if (action !== "backoff-lane") {
        // A configuration gap costs no attempt (failOrRequeue's arithmetic for
        // the same flag) — the clip waits, and the cap stays for clips that are
        // actually failing.
        retry.set(row.id, { attempts: attempts + (err.noCount ? 0 : 1), until: Date.now() + 60000 });
      }
      // Consecutive transient retries of one clip are one story,
      // not one row per backoff tick: fold into the clip's prior
      // `requeued` row — attempts up, error and end time refreshed.
      // The first failure and the eventual resolution (ok/failed)
      // keep their own rows, and the fold survives restarts because
      // the prior row is found in the ledger, not in memory.
      const prior = job.id == null ? null
        : await jobLogWrite(() => latestSettledJob(db, row.board_id, "transcribe", row.id));
      if (prior?.outcome === "requeued") {
        await foldJobRepeat(db, prior, job.id, { outcome: "requeued", error: err.message });
      } else {
        await job.settle({ outcome: "requeued", error: err.message });
      }
      console.warn(`transcribe: transient ${action === "backoff-lane" ? "engine" : `clip #${row.id}`} error (retry in 60s): ${err.message}`);
      return action;
    }
    // Park the clip — a permanent fault (undecodable, provider 4xx)
    // or a transient one out of attempts. The queue moves on; it'll
    // tag from its filename, like a textless document. A reprocess
    // clears transcript_error to grant a fresh set of attempts.
    const note = action === "park-capped"
      ? `gave up after ${attempts + 1} attempts: ${err.message}` : err.message;
    await updateItemPayload(db, row.id, { transcript_error: String(note).slice(0, 300) });
    retry.delete(row.id);
    await job.settle({ outcome: "failed", error: note });
    console.warn(`transcribe failed #${row.id} "${file?.original_name}": ${note}`);
    return "parked";
  }
}

// Bounds ONE /detect exchange: a detection is seconds, but a queued image behind
// others (the sidecar is single-threaded) plus a cold model load can run longer,
// so keep it generous like the extractor.
const OBJECT_DETECTOR_TIMEOUT_MS = Number(process.env.OBJECT_DETECTOR_TIMEOUT_MS) || 180000;
const DETECTOR_RESOURCE = "sidecar:detector";

// The on-server object-detector sidecar wrapped as an interchangeable engine
// { id, model, detect } — the peer of whisperTranscriber(). POSTs the ORIGINAL
// image + noun-phrase queries to /detect and returns canonical
// { objects: [{ label, box(0..1 xyxy), score }], usage }. Unreachable/non-OK
// throws transient → the extract leg requeues (mirrors the extractor
// contract), never a silent empty.
function objectDetectorSidecar(binding, threshold) {
  const base = sidecarUrl(binding.provider);
  return {
    // All three come from the resolved floor binding and its descriptor —
    // naming the provider here would put the registry's job back in the engine.
    id: binding.provider,
    model: binding.model, // the sidecar's baked default
    detect: async (image, queries) => {
      // Single-threaded sidecar, same argument as the extractor — and the same
      // finally, because three of the four exits below are throws.
      await poolWait(DETECTOR_RESOURCE);
      try {
      let res;
      try {
        res = await fetch(`${base}/detect`, {
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
      // No usage: the sidecar is keyless and on-device, so it has nothing to
      // report and says so rather than reporting zeros. The caller meters the
      // image it sent, which is the unit this engine's $0 price is quoted in.
      return { objects: Array.isArray(objects) ? objects : [], usage: {} };
      } finally {
        poolRelease(DETECTOR_RESOURCE);
      }
    },
  };
}

// A board's image→boxes engine — the peer of resolveTranscriber, and the same
// two-shape split over one generic resolution. `viaFloor` covers unset, an
// uninstalled plugin, a no-detect provider, a missing key, localDetector
// itself, and a board's deliberate pin of it. Never fails to resolve. `board`
// is the item's board row (slice 5) — the call site always had it; the
// resolver finally reads it. Threshold is a CAPABILITY-level knob (it belongs
// to detection, not to whichever provider serves it), closed over from
// settings — deliberately global, never per-board.
// Which backlog lanes are served for one board — the `queued` half's gate
// (first-class-work-plan.md), living beside the resolvers it asks because
// lane resolution is this module's job. Answers as `[{ kind, model? }]`,
// db.js's boardLaneQueues vocabulary; adding a backlog lane = one line here
// + its predicate in LANE_NEED beside the claim queries.
//
// Memoized briefly per board: the verdicts are configuration (bindings,
// plugin installs, sidecar presence) but the delta poll asks every 4s per
// open tab, and a resolution is a walk of settings reads that must not run
// per tick. TTL rather than invalidation — the writers that can flip a
// verdict span three modules, and the wire's own staleness is 4-20s, so a
// few seconds of memory is invisible to the reader. The board row is only
// needed on a miss (pin columns), so callers pass its id and optionally the
// row they already hold.
const laneVerdicts = new Map(); // boardId -> { at, lanes }
const LANE_VERDICT_TTL_MS = 5000;
export async function servedBacklogLanes(db, boardId, board = null) {
  const hit = laneVerdicts.get(boardId);
  if (hit && Date.now() - hit.at < LANE_VERDICT_TTL_MS) return hit.lanes;
  const b = board ?? await getBoard(db, boardId);
  const [transcriber, embedder] = await Promise.all([resolveTranscriber(db, b), resolveEmbedder(db)]);
  const lanes = [
    ...(transcriber ? [{ kind: "transcribe" }] : []),
    ...(embedder ? [{ kind: "embed", model: embedder.model }] : []),
  ];
  laneVerdicts.set(boardId, { at: Date.now(), lanes });
  return lanes;
}

export async function resolveDetector(db, board = null) {
  const b = await resolveCapability(db, "detect", { board });
  // Null since the floor became presence-gated: no provider bound and the
  // detector sidecar is not on this host. The extract leg requeues the item
  // without spending or counting an attempt.
  if (!b) return null;
  const { detect_threshold: threshold } = await capabilityConfig(db, "detect");
  // The on-server object-detector sidecar — no key, resolved directly
  // (wire: null), like the whisper transcriber.
  if (b.viaFloor) return objectDetectorSidecar(b, threshold);
  const { rpm, burst } = await aiRate(db, b.provider);
  return {
    id: b.provider,
    model: b.model,
    // Runs under the plugin-health ledger like every other provider call so
    // detection traffic + errors show on the Plugins page.
    detect: (image, queries) =>
      withPluginHealth(db, `ai:${b.provider}`, () =>
        detectObjects({ provider: b.provider, apiKey: b.apiKey, base: b.base, model: b.model, rpm, burst, image, queries, threshold })),
  };
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
    const raw = (f.instruction || deSnake(f.key)).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
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
// megabyte queues behind the next image). The decode cap is the shared
// MAX_DECODE_PIXELS from sharp-gate.js — one OOM policy with ingest and the
// AI renditions.
const DETECT_MAX_EDGE = 1333;

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
    // Through the shared decode gate: detection decodes run as wide as the extract
    // leg claims, and used to decode up to 40MP ungated, concurrent with gated
    // ingest decodes. sharpGate is what bounds the CPU here; the resource pool
    // bounds the CALLS, which is a different thing and does not cover this.
    return await sharpGate(() =>
      sharp(buf, { pages: 1, limitInputPixels: MAX_DECODE_PIXELS })
        .rotate()
        .resize({ width: DETECT_MAX_EDGE, height: DETECT_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }) // JPEG has no alpha; white beats the default black behind a logo
        .jpeg({ quality: 90 })
        .toBuffer()
    );
  } catch {
    return buf; // let the sidecar decode (and 422-park) a truly undecodable image
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
    // The extractor is a single-threaded Python server: a second request does
    // not run, it waits at the socket. Waiting HERE instead makes that visible
    // to the pool, and the wait is released before the model call this text
    // feeds — the leg touches the two resources in sequence, never nested.
    await poolWait(EXTRACTOR_RESOURCE);
    try {
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
    } finally {
      // Three exits from this branch — unreachable, non-OK, and the read.
      // Releasing on only the happy one leaks the sidecar's single slot on
      // every failure, which is the shape that wedges a pool permanently.
      poolRelease(EXTRACTOR_RESOURCE);
    }
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

// What the model sees for an item: parts built from its files by kind. Module
// scope + exported so the builder is directly testable (the documentTextFor /
// imageForDetection convention); startWorker binds its storage dirs.
//
// Images: a provider-clamped rendition of the stored ORIGINAL — `preset` (the
// board's image detail) and `images` (the resolved provider's ceiling), see
// ai-image-input-plan.md — falling back to the ≤600px card face on any
// trouble. Documents: their extracted text (documentTextFor), so every
// provider can tag them; PDFs additionally carry their page-1 card face
// (deliberately NOT rendition-scaled — §6b: a PDF is text-first material), and
// fall back to an Anthropic-only document block when the document genuinely
// has no text layer (extractor DOWNTIME throws instead — the retry queue waits
// it out rather than paying per-page billing).
// The image-input ceiling the RESOLVED provider declares (ai-image-input-plan
// §1) — an absent block means the conservative generic defaults. Pure, so it
// sits beside the builder rather than in startWorker's closure.
export const imagesFor = (binding) => PROVIDERS[binding?.provider]?.images ?? GENERIC_IMAGES;

export async function modelInputFor({ galleryDir, thumbsDir }, payload, { entity = null, mode = "tag", preset, images } = {}) {
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
  // The AI rendition, NOT the card face: a 600px q72 thumbnail of a 1775px
  // screenshot has illegible body text, and every provider accepts far more
  // (ai-image-input-plan.md). aiImageFor clamps the board's preset to what the
  // resolved provider declares and never throws — its floor is that same card
  // face, so the worst case here is the pre-preset behaviour. Not wrapped in
  // sharpGate: it gates internally, and the gate is not reentrant.
  const rendered = await aiImageFor({ galleryDir, thumbsDir }, file, { preset, images });
  // A generated connector face (e.g. a price chart) gets a chart-aware anchor
  // so the tagger reads the trend, not a generic "image". (Its rendition is
  // always the face: the chart's galleryDir copy IS the webp thumb.)
  const anchor = file.generated
    ? `This is a price chart for "${entity?.display_name || entity?.identity || payload.identity}". ${ask("it", mode === "extract" ? ", judging from the chart" : ", judging from the chart and the extracted fields below")}`
    : ask("this image");
  return [
    // `render` is the diagnostics bag the job log records — both wires map
    // parts by `kind` and ignore unknown fields, so it rides along invisibly.
    { kind: "image", mediaType: rendered.mediaType, b64: rendered.b64, render: rendered.render },
    { kind: "text", text: anchor },
  ];
}

// Text-only input for the extraction leg — all doc types go through the
// same documentTextFor path so extraction works with any provider (document
// blocks are Anthropic-only) and never pays image tokens. null = no text
// (image file, or a genuinely textless pdf) — the caller falls back to
// modelInputFor; extractor downtime throws out of here instead.
export async function modelInputForExtract(galleryDir, payload) {
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

// Resolve one derived identity value to an entity id via find-or-create,
// preferring to reuse an old entity IN PLACE (from `reusable`) when the key is
// new — that keeps a provisional/sole entity's id stable so its hearts and crate
// membership survive a rename (the pre-array "sole instance: rename in place"
// branch). `resolved` is the ids already claimed this pass, so a reusable entity
// is never handed out twice. The latest derivation wins the display name —
// identity can be anything (a name, a code, a date), so no cased heuristics.
//
// Concurrency: extraction runs as wide as its board's key has room for (Stage 3b
// widened this from a flat 2) and classify mode funnels many items to the same
// candidate, so a sibling extraction can claim `key`
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

export function startWorker({ db, thumbsDir, galleryDir, sources = null, autoBackup = null, sampleStorage = null }) {
  const POLL_MS = Number(process.env.POLL_MS || 3000);
  // The diagnose kind's own cadence, and it paces SPEND as much as scanning: its
  // settle gate is three minutes wide, and every facet it passes is a paid call.
  const DIAGNOSE_POLL_MS = Number(process.env.DIAGNOSE_POLL_MS || 60000);
  const STUCK_MS = Number(process.env.STUCK_MS || 180000);
  const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
  // Concurrency is bounded per RESOURCE now (queue-by-resource-plan.md Stage 3b),
  // so nothing here sizes a lane. `AI_INFLIGHT` (with its `TAG_CONCURRENCY` alias)
  // and `FETCH_CONCURRENCY` survive as the pool's `ai:` and `conn:` class ceilings,
  // read there by maxFor — same names, one place. `EXTRACT_CONCURRENCY` and
  // `FACE_CONCURRENCY` are gone: extract contends for an AI KEY and face for a
  // CONNECTOR, so once the lanes went neither name bounded anything.

  // Job-log rows still `running` were orphaned by the previous process (a
  // crash or stop mid-transcription/mid-ingest) — stamp them interrupted so
  // the jobs view never shows a ghost in flight. The bootAt fence in the
  // UPDATE keeps this boot's own fresh rows safe from the sweep.
  jobLogWrite(() => markInterruptedJobs(db, Date.now())).then((n) => {
    if (n) console.log(`job log: ${n} job(s) from the previous run marked interrupted`);
  });

  // The parts builders live at module scope (see modelInputFor /
  // modelInputForExtract above) — bound here to this worker's storage dirs.
  const DIRS = { galleryDir, thumbsDir };

  // The image detail in effect for a job: the board's own pin, else the
  // app-wide default. The global read is skipped entirely when the board pins
  // one — and deliberately NOT cached beside the board prompt: caching the
  // effective value would need the capability bind route to invalidate every
  // board cache, and one single-row SELECT next to a paid call is not worth a
  // new invalidation edge.
  const effectivePreset = async (boardPresetId) =>
    resolvePreset(boardPresetId ?? (await capabilityConfig(db, "tag")).tag_image_preset);

  async function tagOne(row) {
    const prompt = await getBoardPrompt(db, row.board_id, row.tag_facets);
    if (!prompt) throw new Error(`board ${row.board_id} has no facets configured`);
    const { systemText, schema, allowed, facets, stamps, votes } = prompt;

    const ai = await resolveBoardAi(db, prompt);
    if (!ai) throw noKeyError();

    const entity = row.entity_ids?.[0] ? await getEntity(db, row.entity_ids[0]) : null;
    // ONE rendition per item, whatever the vote count: `parts` is built once
    // and shared across all N calls below.
    const parts = await modelInputFor(DIRS, row.payload, {
      entity,
      preset: await effectivePreset(prompt.imagePreset),
      images: imagesFor(ai),
    });
    // Distilled extraction results ride along as a text part so the tagger
    // sees the structured data without re-reading the raw material. Entity
    // fields (connector-bound) come first, the instance's own extractions
    // override on key collision.
    const fields = { ...(entity?.fields || {}), ...(row.payload.fields || {}) };
    const fieldLines = Object.entries(fields)
      // Scalars and lists — an object-detection field's `v` is an array of
      // boxes, which distils to noise (`key: [object Object],…`); it has no
      // place in the tagger's text anyway. A list field (`kind: "list"`, an
      // array of option spellings) joins.
      .filter(([, f]) => f.v !== null && f.v !== undefined && (f.kind === "list" || typeof f.v !== "object"))
      .map(([key, f]) => `${key}: ${f.kind === "list" ? f.v.join(", ") : f.v}`);
    if (entity?.display_name) fieldLines.unshift(`entity: ${entity.display_name}`);
    if (fieldLines.length) parts.push({ kind: "text", text: `Extracted fields:\n${fieldLines.join("\n")}` });
    // A vote pass is an internal API call, NOT a pipeline event: however many
    // run here, tagOne returns one result for one item and everything
    // downstream (markTagged, the snapshot, alerts, the job log) happens once.
    // The only thing that is genuinely N is the paid call — hence `usages`.
    const usages = [];
    const once = async () => {
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
      usages.push(usage);
      return parseRun(input, facets, allowed);
    };

    // Run 1 alone, THEN the rest together. The provider-side prompt cache is
    // written by a COMPLETED call — firing all N at once makes all N miss and
    // costs ~7,000 extra fresh tokens per item (measured). One call of latency
    // buys that back. Later runs are allSettled: a timeout on vote 3 must not
    // cost the item its attempts, only its precision.
    const runs = [await once()];
    if (votes > 1) {
      for (const r of await Promise.allSettled(Array.from({ length: votes - 1 }, once))) {
        if (r.status === "fulfilled") runs.push(r.value);
        else console.warn(`vote run failed for #${row.id}: ${r.reason?.message} — merging ${runs.length} of ${votes}`);
      }
    }

    const merged = mergeVotes(facets, runs, stamps);
    const tags = [];
    let filledFacets = 0;
    for (const f of facets) {
      if (merged.picks[f.key].length) filledFacets++;
      for (const v of merged.picks[f.key]) tags.push(`${f.key}/${v}`);
    }
    // Whole-item description rides in tag_reasoning under a reserved key, like `fit`.
    const reasoning = { ...merged.reasoning };
    if (merged.description) reasoning.description = merged.description;
    if (merged.fit.reasoning) reasoning.fit = merged.fit.reasoning;
    // Only honor an undecided verdict when the model also found the facets
    // mostly inapplicable. It keeps folding "off-scope but taggable" into
    // undecided regardless of prompt wording, and an item it could describe
    // with most of the facets is board material by definition.
    const undecided = merged.fit.verdict === "undecided" && filledFacets < facets.length / 2;
    return {
      tags, undecided, reasoning, confidence: merged.confidence,
      usages, votes: runs.length, model: ai.model, provider: ai.provider,
      // What the model was actually shown, for the job log — the only way to
      // tell a `high` board from one silently riding the thumbnail fallback.
      image: parts.find((p) => p.kind === "image")?.render ?? null,
    };
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
      // Same reason as the manual retag route: every facet is about to be
      // re-measured, so every finding on the board is superseded from here.
      if (queued) await supersedeFacetDiagnostics(db, b.id, null);
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

  // History retention, checked hourly not per tick — the DELETEs are cheap but
  // there's no point running them every 3s. 0 disables a prune (keep forever).
  // ONE table, not one hand-written block per ledger: the old shape repeated
  // the same five lines per entry AND named every knob again in a compound
  // early-return, so a fifth ledger that forgot that second edit would silently
  // never prune whenever the other four were zero — the common configuration,
  // since two of them default to 0.
  //   field_snapshots  movement history, 90 days.
  //   tag_snapshots    judgment history, keep-forever — addTagSnapshot dedupes,
  //                    so every row is a real change, i.e. the then-vs-now data
  //                    itself; age-pruning it is opt-in.
  //   job_log          execution history, 30 days — operational transparency,
  //                    not the product's data like the snapshots.
  //   usage_meter      spend history, keep-forever — a per-day rollup stays
  //                    small, and it IS the billing record.
  const PRUNES = [
    { days: Number(process.env.SNAPSHOT_RETENTION_DAYS ?? 90), run: pruneFieldSnapshots, noun: "field snapshot(s)" },
    { days: Number(process.env.TAG_SNAPSHOT_RETENTION_DAYS ?? 0), run: pruneTagSnapshots, noun: "tag snapshot(s)" },
    { days: Number(process.env.JOB_LOG_RETENTION_DAYS ?? 30), run: pruneJobLog, noun: "job log row(s)" },
    { days: Number(process.env.USAGE_METER_RETENTION_DAYS ?? 0), run: pruneUsageMeter, noun: "usage meter row(s)" },
  ];
  // The maintenance loop ticks at POLL_MS, but several of its jobs only want
  // to run hourly. ONE gate rather than a `let nextXAt` beside each — the same
  // reason PRUNES above is a table: the third copy of a shape is where the
  // shape should have become a mechanism. Each wrapped job keeps its own
  // independent clock, and the timestamp advances BEFORE the work so a slow
  // pass can't stack.
  const hourly = (fn) => {
    let nextAt = 0;
    return async (...args) => {
      if (Date.now() < nextAt) return;
      nextAt = Date.now() + 3600000;
      return fn(...args);
    };
  };

  // Ghost-entity reap: a zero-instance entity is normally impossible, but the
  // FK-less entity_ids link can strand one on a crash or a concurrent delete.
  // Swept hourly; only entities settled empty for REAP_AGE_MS are taken, so an
  // in-flight upload (entity then instance, two statements) is never caught.
  const REAP_AGE_MS = Number(process.env.ENTITY_REAP_AFTER_MS) || 1800000; // 30 min
  const pruneSnapshots = hourly(async () => {
    for (const { days, run, noun } of PRUNES) {
      if (!days) continue;
      const n = await run(db, Date.now() - days * 86400000);
      if (n) console.log(`pruned ${n} ${noun} older than ${days}d`);
    }
  });

  const reapGhostEntities = hourly(async () => {
    const n = await reapEmptyEntities(db, REAP_AGE_MS);
    if (n) console.log(`worker: reaped ${n} empty ghost entit${n === 1 ? "y" : "ies"}`);
  });

  // Price learning (price-learner.js, metering-plan.md 3b). Hourly rather than
  // the refresh period so a just-wanted model prices within the hour; the
  // learner gates its own network beyond that and never throws.
  //
  // NOT awaited: this is the one maintenance job that makes outbound calls
  // (a ~2MB map fetch, a per-provider listing), and this loop's whole design
  // is that recovery can't be delayed by slow work — which is why the heavy
  // sweeps got their own loops. A pending pass is tracked so ticks can't pile
  // passes up on each other.
  // Hourly-unless-nudged, one clock. The hourly cadence paces refreshes of
  // rates we already hold; a model seen for the FIRST time can't wait on it —
  // cost is stamped at write and never recomputed, so every unpriced tick of
  // a new model is money the Usage tab will never show (a $22 opus-5 run
  // metered ≈$0 this way, 2026-09-03). wantedGeneration (pricing.js) is the
  // free synchronous proxy for the learner's own untried gate: a new want —
  // a stamping lookup or refreshRateTable's meter seed — runs the pass on
  // the next tick, and that pass advances the SAME clock the hour uses, so
  // a nudge at minute 59 doesn't buy a second pass at minute 60. Not the
  // shared hourly() wrapper: this gate composes the nudge and the
  // single-flight check, and bending the helper around one caller's extra
  // condition is the wrong trade. The generation is re-read only when a
  // pass actually launches, so a nudge landing mid-pass is retried next
  // tick rather than lost.
  let priceLearnInFlight = null;
  let learnedAtGen = wantedGeneration(), nextLearnAt = 0;
  const learnPricesDue = () => {
    if (priceLearnInFlight) return;
    const gen = wantedGeneration();
    if (gen === learnedAtGen && Date.now() < nextLearnAt) return;
    learnedAtGen = gen;
    nextLearnAt = Date.now() + 3600000;
    priceLearnInFlight = learnPrices(db).finally(() => { priceLearnInFlight = null; });
  };

  // One feed run for one due board — the ingest kind's `run` (its tick is the
  // cron: a "continuous" folder watch is just a 30s rescan). Enumerate the
  // source, drop everything ever ledgered (ingest_log — deletion in the app is
  // a user judgment the feed must not overturn), then filter/sort/limit with
  // the shared engine and admit through the adapter. Admissions are capped per
  // run; a bigger logical run drains across runs with next_run_at=now, resuming
  // from drain_left so the run's `limit` stays exact — and because the settle
  // re-arms the board as due, the kind's own settle-wake takes it straight back
  // up. Per-board failures land in ingest_state with a 5-minute backoff and
  // nowhere wider; backing off the PROVIDER is the wire's job (runtime.js
  // callProvider), and it reaches a catalog walk exactly as it reaches a fetch.
  async function ingestBoard(b) {
    let added = 0; // admissions are claimable rows for the legs — see the finally
    const cfg = b.ingest;
    const now = Date.now();
    // The stamp this run claimed the board under IS this run's identity
    // (job-control-plan.md Stage 5). Everything below is fenced on it, so
    // whoever re-stamps mid-flight — a cancel, "Run now", a save that
    // changes the trigger — stops this run where it stands instead of
    // losing to it.
    const fence = b.ingest_next_run_at;
    // Not the schedule's run: a manual board, or a paused one that only got
    // here because "Run now" armed it. Either way it's one run — nothing
    // re-arms afterwards, nothing retries, and the row it leaves in the job
    // log always stands (somebody asked, so "0 admitted" is the answer).
    const oneShot = ingestMode(cfg) !== "scheduled";
    // One run = one job-log row, `running` while the feed is enumerated and
    // admitted — ingest has no other in-flight representation. ingest_state
    // keeps only the LAST run; these rows are where the history lives.
    const job = await openJob(db, {
      boardId: b.id, kind: "ingest", startedAt: now,
      detail: { trigger: cfg?.trigger?.mode || null },
    });
    try {
      const adapter = resolveIngestAdapter(b);
      if (!adapter) throw new Error("ingestion is not available for this board");
      if (!sources) throw new Error("ingestion is not available (worker started without sources)");
      const descriptor = adapter.descriptor();
      const catalog = descriptor.filters;
      // Budget: a drain run resumes what's left of the current logical run
      // instead of re-slicing a fresh limit (keeps "top-N" semantics exact).
      // Read before enumerating: mid-drain is also what lets an adapter hold
      // the window it is draining instead of re-walking a metered catalog per
      // run (`drain` — see connector.js).
      const drainLeft = Number(b.ingest_state?.drain_left) || 0;
      const { candidates } = await adapter.enumerate(db, b, cfg, { drain: drainLeft > 0 });
      const known = await ingestedKeys(db, b.id);
      // Membership vs admission — two different subtractions since stage 3
      // (a user-deleted key backfills its `total` slot but never re-admits)
      // — and both live in runWindow, shared with the preview route so a
      // count and a run can never disagree. `fresh` arrives sorted, so
      // order survives into the budget slice.
      // `changed` is the adapter's own "has this slot stopped holding the
      // bytes we recorded" (files.js); without it a reused path is
      // invisible forever — the spool case.
      const { fresh, tally } = runWindow(candidates, cfg, catalog, known,
        { changed: adapter.changed });
      const budget = drainLeft > 0 ? drainLeft : (Number(cfg.limit) || Infinity);
      const picked = applyLimit(fresh, budget);
      const batch = picked.slice(0, RUN_CAP(descriptor.runCap));
      // One batched warm ahead of the per-item admissions; the economics and
      // the best-effort contract live with it, in connector.js `prewarm`.
      // Whether a batch is big enough to be worth batching is the runtime's
      // call (runtime.warmIds), not this run's.
      if (adapter.prewarm && batch.length) await adapter.prewarm(db, b, batch);
      let dups = 0;
      const errors = [];
      const skips = []; // labels — the "why did my file never get picked up" answer
      const held = []; // labels — recognized as content you deleted (stage 5)
      let superseded = false;
      let pausedMid = false; // held by the board's pause, NOT superseded
      let processed = 0;     // candidates dealt with, however they went
      // What this run still owes, published before the first admission so the
      // Jobs modal can say "importing 0 of 200" the moment the row appears —
      // `picked` is the logical run's remainder, `batch` only this invocation's
      // slice of it. Progress is then republished every few admissions: the
      // modal polls at 5s, so anything finer is writes nobody reads.
      const planned = picked.length;
      await job.progress({ planned, admitted: 0 });
      let sinceProgress = 0;
      for (const c of batch) {
        // Between admissions, not just between runs: a connector batch is
        // 250 admissions deep, so "after the batch" would still be a flood
        // arriving after a cancel — or minutes of importing after a pause.
        const gate = await ingestRunGate(db, b.id, fence);
        if (!gate.armed) { superseded = true; break; }
        if (gate.paused) { pausedMid = true; break; }
        try {
          await adapter.admit(db, b, c, { sources });
          added++;
        } catch (err) {
          // duplicate (already on the board), skip (unsupported bytes) and
          // held (stage 5: the bytes are something you deleted) are all
          // ledger-and-forget: stop rescanning them. Real errors stay
          // unledgered so the next run retries them. The reason stamped is
          // what the history reads back — a corrupt file is not a rejection
          // and a rejection is not a duplicate. `err.ledger` carries the
          // slot's re-read facts (hash/size/mtime) where the bytes were
          // actually read, which is what stops a merely-touched file from
          // drifting and being re-fetched on every single scan; the run
          // passes it through without looking inside, staying adapter-blind.
          if (err.duplicate || err.skip || err.held) {
            await recordIngest(db, b.id, c.key, Date.now(), {
              ...(err.ledger || {}),
              reason: err.skip ? "skipped" : err.held ? "deleted" : "admitted",
              itemId: err.itemId ?? null,
            });
            if (err.skip) skips.push(c.label);
            else if (err.held) held.push(c.label);
            else dups++;
          } else errors.push(`${c.label}: ${err.message}`);
        }
        processed++;
        if (++sinceProgress >= 5) { sinceProgress = 0; await job.progress({ admitted: added }); }
      }
      // A superseded run has no remainder to hand on: whoever re-stamped
      // decided what happens next, and drain_left is the budget of a run
      // that is over. A PAUSED one is the opposite — it keeps every row it
      // did not get to, which is what makes unpausing resume rather than
      // restart. Counting what was PROCESSED rather than the batch length is
      // what makes a mid-batch break honest in both cases.
      const remaining = superseded ? 0 : picked.length - processed;
      // A drain continues regardless of how the run started — it's already in
      // flight and somebody asked for all of it. Otherwise only a live
      // schedule re-arms (nextScheduledIngestRun owns that rule). The fence
      // decides whether either lands: false = this run was superseded while
      // it worked, and its state write dies with it.
      const stopped = !(await settleIngestRun(db, b.id, fence, {
        state: {
          last_run_at: now,
          last_added: added,
          last_error: errors[0] ?? null,
          ...(remaining > 0 ? { drain_left: remaining } : {}),
        },
        nextRunAt: remaining > 0
          ? Date.now()
          : nextScheduledIngestRun(cfg, Date.now(), { continuousMs: CONTINUOUS_MS() }),
      }));
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
      // Keys this run ledgered out of every future scan. Named once: the
      // three predicates below all ask the same question, and a fourth
      // disposition that updated only two of them would silently undo the
      // volume guard they exist to enforce.
      const ledgered = skips.length + dups + held.length;
      // `stopped` counts as an event: the row is the trace of a run that
      // ended early, and the cancel that ended it is looking for company.
      const eventful = added > 0 || errors.length > 0 || remaining > 0 || ledgered > 0 || stopped;
      if (!eventful && !oneShot && job.id != null) {
        await jobLogWrite(() => deleteJobLog(db, job.id));
      } else {
        // A scan whose ONLY news is the same per-item error as the prior
        // row's is a flat tick too (a wedged file on a continuous watch
        // ≈ 2,880 rows/day) — fold it instead of stamping a fresh row.
        const errorOnly = errors.length > 0 && !added && !ledgered && remaining === 0;
        const prior = errorOnly && !oneShot && job.id != null
          ? await jobLogWrite(() => latestSettledJob(db, b.id, "ingest"))
          : null;
        // Compare the STORED form — addJobLog caps error at 500 chars.
        const quiet = (d) => !Number(d?.admitted) && !Number(d?.skipped)
          && !Number(d?.duplicates) && !Number(d?.held) && !Number(d?.drain_left);
        const sameStory = prior?.outcome === "ok"
          && prior.error === String(errors[0] ?? "").slice(0, 500) && quiet(prior.detail);
        if (sameStory) {
          await foldJobRepeat(db, prior, job.id, {
            outcome: "ok", error: errors[0],
            detail: { scanned: candidates.length, fresh: fresh.length },
          });
        } else {
          await job.settle({
            outcome: "ok", error: errors[0] ?? null,
            detail: {
              scanned: candidates.length, fresh: fresh.length, admitted: added,
              skipped: skips.length, drain_left: remaining > 0 ? remaining : 0,
              ...(skips.length ? { skipped_labels: skips.slice(0, 20) } : {}),
              ...(dups ? { duplicates: dups } : {}),
              // Recognized as content you deleted, under a name the ledger
              // had never seen. An EVENT, unlike `ignored` below: it
              // ledgers a new key permanently, so this row is its only
              // trace — the same argument skips make.
              ...(held.length ? { held: held.length, held_labels: held.slice(0, 20) } : {}),
              // How many matches a user deletion is holding back. A
              // STANDING number, not an event of this run — which is why
              // it touches neither `eventful` above nor `sameStory`
              // below: a continuous watch would otherwise stamp a fresh
              // "1433 ignored" row every 30s, the volume lesson those two
              // exist to prevent. It rides rows that earned their place
              // some other way.
              ...(tally.held ? { ignored: tally.held } : {}),
              ...(stopped ? { stopped: true } : {}),
            },
          });
        }
      }
      if (added) console.log(`ingest: board "${b.name}" +${added} item(s)${remaining ? ` (${remaining} to drain)` : ""}`);
    } catch (err) {
      // Live schedules back off 5 minutes and retry; a one-shot run was asked
      // for ONCE — its outcome is this error (visible in the modal status
      // line), not a silent retry loop that runs forever until the source
      // heals. "Run now" re-arms it whenever the user wants.
      // One fenced write (Stage 5): the schedule and the error land
      // together — last_error is what observers poll for, so everything it
      // implies (disarmed/backed off) must already be true when it lands —
      // and a run cancelled mid-failure doesn't get to re-arm its retry.
      // The mid-drain budget is preserved across a failure: wiping it would
      // hand the retry a fresh `limit` and over-admit the logical run.
      const drainLeft = Number(b.ingest_state?.drain_left) || 0;
      await settleIngestRun(db, b.id, fence, {
        state: {
          last_run_at: now,
          last_added: 0,
          last_error: err.message,
          ...(drainLeft > 0 ? { drain_left: drainLeft } : {}),
        },
        nextRunAt: oneShot ? null : Date.now() + 5 * 60000,
      }).catch(() => {});
      // The same failure repeating on the retry cadence (a dead source =
      // one row per 5-minute backoff) folds into its prior row; a hand-fired
      // run was asked for, so its row always stands alone.
      const prior = !oneShot && job.id != null
        ? await jobLogWrite(() => latestSettledJob(db, b.id, "ingest"))
        : null;
      if (prior?.outcome === "failed" && prior.error === String(err.message).slice(0, 500)) {
        await foldJobRepeat(db, prior, job.id, { outcome: "failed", error: err.message });
      } else {
        await job.settle({ outcome: "failed", error: err.message });
      }
      console.warn(`ingest error board "${b.name}" (${oneShot ? "not retried" : "retrying in 5m"}): ${err.message}`);
    } finally {
      // Admissions are claimable rows for the tag and face legs, and a kind's
      // settle wakes only the kinds sharing its own in-flight set — the refresh
      // kind's rule, once more. In a finally so a run that admitted and then
      // failed to settle still hands its rows on.
      if (added) wakeAll();
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
    let prompt; // needed again at the landing, which is a separate try block
    try {
      // Facet-less board: nothing to tag. Complete the item instead of failing
      // it — extraction-only boards (mapping, no facets) are a supported shape.
      //
      // A SCOPED pass here must land unchanged, not empty: the board lost its
      // facets after the scope was queued, and wiping every tag is the opposite
      // of what scoping promises. Passing the row's own tags keeps them and
      // still clears the scope.
      prompt = await getBoardPrompt(db, row.board_id, row.tag_facets);
      if (!prompt) {
        const scoped = !!row.tag_facets?.length;
        // Unscoped stays exactly as it was: empty tags, verdict cleared, no
        // reasoning. Only the scoped branch preserves.
        const landed = scoped
          ? await markTagged(db, row.id, row.tags || [], row.undecided, row.tag_reasoning || {}, row.tag_confidence || {}, true)
          : await markTagged(db, row.id, [], false, {});
        if (landed) {
          await legLog(row, "tag", t0, "ok", null, scoped
            ? { tags: (row.tags || []).length, facets: row.tag_facets, skipped: "no facets to ask about" }
            : { tags: 0 });
          console.log(`tagged #${row.id} ${label} [no facets — nothing to tag]`);
          // Same contract as the real tag landing below. [] tags can't match
          // anything, but system-facet conditions (~uploaders, ~objects) don't
          // need tags — and on a facet-less board this is the pipeline's final
          // landing, so skipping it would strand those conditions unevaluated.
          await evaluateItemAlerts(db, row.id); // never throws — the ledger never breaks the job
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
      const { undecided, usages, votes, model, provider, image } = result;
      // A scoped pass (items.tag_facets) writes only the facets it was queued
      // for and keeps the rest of the item's answers. `row` is the CLAIM-TIME
      // state and that is safe without a re-read: markTagged is fenced on
      // status='processing', and every competing writer — setItemTags,
      // retagItem, reprocessEntity — moves the row out of it, so either nobody
      // wrote and this is current, or the fence discards the whole result.
      const scope = row.tag_facets;
      // allFacets, NOT prompt.facets: on a scoped pass the latter is just the
      // scoped subset, and rebuilding through it would drop every other facet's
      // tags instead of preserving them.
      const merged = scopeResult(
        prompt.allFacets, scope,
        { tags: row.tags || [], reasoning: row.tag_reasoning || {}, confidence: row.tag_confidence || {} },
        result
      );
      const { tags, reasoning, confidence } = merged;
      // Meter BEFORE the landing: the tokens were spent whatever markTagged
      // does next, and this call never throws — so the spend is recorded even
      // when the write below fails and the catch reports the loss. (The old
      // shape metered after the landing, which quietly dropped the bill on
      // exactly the "post-tag write failed" path — worker-queue-holes #11's
      // "usage stays unconditional" invariant, now actually held.)
      // The meter counts PAID CALLS, not items: every per-call average read
      // off it (admin dashboard, cost estimates) breaks if N votes record as
      // one, so `requests` gets all N. One write, not N — the passes share an
      // attribution, so they fold into the same rows either way.
      const dims = { capability: "tag", provider, model };
      await meterAiCalls(db, row.board_id, dims, usages);
      // What the meter just recorded, in the row's spelling — one derivation
      // for both landings below, off the same dims the meter got.
      const spent = spentDetail(dims, usages);
      // Scoped: `undecided` is not written, so the snapshot must be told the
      // flag that IS stored or its dedupe compares against a value nobody saved.
      const landed = await markTagged(db, row.id, tags, scope?.length ? row.undecided : undecided,
                                      reasoning, confidence, !!scope?.length);
      if (landed) {
        await legLog(row, "tag", t0, "ok", null, {
          tags: tags.length, ...spent,
          ...(scope?.length ? { facets: scope } : {}),
          ...(votes > 1 ? { votes } : {}),
          ...(!scope?.length && undecided ? { undecided: true } : {}),
          // Image items only — "what did the model actually see".
          ...(image ? { image } : {}),
        });
        console.log(`tagged #${row.id} ${label} [${model}]${scope?.length ? ` (facets: ${scope.join(", ")})` : ""}${!scope?.length && undecided ? " (undecided)" : ""} -> [${tags.join(", ")}]`);
        await evaluateItemAlerts(db, row.id); // never throws — the ledger never breaks the job
      } else {
        // The fence dropped the result; the money was spent anyway. The tokens
        // on this row are where that shows.
        await legLog(row, "tag", t0, "discarded", null, spent);
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
    if (!landed) {
      console.warn(`stale extract result for #${row.id} discarded (re-routed or deleted mid-flight)`);
      return landed;
    }
    // The extract-stamp alert landing: object detections land here, so an
    // `~objects` condition is evaluated the moment boxes exist. Gated on an
    // actual detection — connector stamps and box-less extracts skip the read,
    // which is sound because nothing ELSE a condition can see lands at
    // extract: tags land at tagging, the uploader at admission (ingest.js).
    // entityForAlerts projects objects into the matched set, so a mixed
    // tags+objects condition settles at whichever landing completes it.
    if (objectKeysOf(fields).length)
      await evaluateItemAlerts(db, row.id); // never throws — the ledger never breaks the job
    return landed;
  }

  // Run extraction for one pending_extract item. Resolves the board's AI the
  // same way tagOne does; writes payload.fields and advances to pending so the
  // normal tag leg picks it up next. When the mapping names a card key,
  // resolves collisions by merging into the existing entity instead.
  // Returns a job-log summary for processExtractOne — { landed, fields,
  // identity, spent, image } — or null for the no-AI passthrough (a status
  // flip is not an execution worth a history row).
  async function extractOne(row) {
    const mapping = row.payload.mapping;
    if (!aiWork(mapping)) {
      // Nothing for the model to do — the mapping is empty or all its fields
      // are connector/file-sourced (a connector vehicle's stamp lands here on
      // release). Advance without an AI call, keeping the fields the payload
      // already carries.
      await stampExtracted(row, row.payload.fields || {});
      return null;
    }
    const board = await getBoard(db, row.board_id);
    const extractFields = extractFieldsOf(mapping);
    const objectFields = (mapping.fields || []).filter((f) => f.source === "detect");
    // Detect fields ride a separate detector pass below, not the LLM — so the
    // model is only called when there's an extract field (the card key, when
    // there is one, is one of them). A detect-only board skips the LLM
    // entirely (ai/usage stay null and the tail guards for it).
    const needsLLM = extractFields.length > 0;

    // `imageRender` mirrors the tag leg: extraction sends a rendition too
    // whenever the item has no text sidecar (an image, a connector chart
    // face), and a fallback there is exactly as invisible as on the tag leg.
    // NOT named `image` — the object-detection block below binds that name to
    // a raw file buffer, and two meanings for one word in one function is how
    // the wrong one gets read.
    // `spent` is the job row's "what served this and what it cost" fragment,
    // filled by whichever leg spends FIRST — the extractor here, or the
    // detector pass below on a detect-only board. Still null at the return only
    // when nothing was called at all (detect fields on a non-image item), and
    // then the row says nothing rather than naming an engine that never ran.
    // The detector resolves BEFORE the paid extraction call. In the old order
    // it resolved inside the detect pass below — after the model was called
    // and metered — so with the sidecar absent and nothing bound, every
    // attempt billed extraction, threw at detection, and re-billed on retry
    // until the cap failed the item, discarding extraction that succeeded
    // every time. Absence now requeues before a token moves. The image-kind
    // guard mirrors the detect pass's own: a non-image item never calls the
    // detector (it lands "no image to detect on"), so a host without the
    // engine must not hold items that never needed it.
    // ONE derivation of "this item has something to detect on", read by the
    // guard here and by the pass below. Two copies could drift — and the way
    // they would drift is ugly: a pass that widened its notion of an image
    // while this guard stayed narrow would leave `detector` null and throw a
    // TypeError mid-leg, failing the item on attempts, which is the exact
    // outcome this stage exists to prevent.
    const detectFile = row.payload.files?.[0];
    const detectable = objectFields.length > 0 && detectFile?.kind === "image";
    let detector = null;
    if (detectable) {
      detector = await resolveDetector(db, board);
      // A configuration gap, not an item failure (configGapError's rule): the
      // item requeues unfailed with attempts untouched, failOrRequeue spaces
      // the retry, and the catch below skips the job log — so the wait is
      // quiet on every ledger and ends within a minute of an engine appearing.
      if (!detector) throw configGapError("object detection is not available on this server — the item waits for an engine");
    }

    let input = {}, usage = null, ai = null, imageRender = null, spent = null;
    if (needsLLM) {
      // Extraction's whole ladder in one call: the board's extract pin, the
      // app-wide extract default (slice 5), then delegation to the tagger —
      // the BOARD's tagger first, exactly the chain this block used to
      // hand-write. Either way, the input is text-only (via
      // modelInputForExtract) so extraction works with any provider.
      ai = await resolveCapability(db, "extract", { board });
      if (!ai) throw noKeyError();

      const { systemText, schema } = buildFieldsPrompt(mapping);
      // Try text-only extraction first (works with any provider, avoids image
      // tokens for PDFs). Fall back to the full modelInputFor path for non-doc
      // files (images, connector entities) where there is no text sidecar — in
      // extract mode, so its anchors ask for record_fields, not record_tags.
      let parts = await modelInputForExtract(galleryDir, row.payload);
      if (!parts) {
        // The fallback anchors name the entity (no-file vehicles, chart faces).
        // Identity resolution below re-reads its own copy after the call, so a
        // mid-call rename never acts on this snapshot.
        const entity = row.entity_ids?.[0] ? await getEntity(db, row.entity_ids[0]) : null;
        // Extraction reuses TAGGING's image detail (one dial for one decision —
        // it rides tagging's declaration and binding delegation), but clamps to
        // the EXTRACT binding's provider, which may differ.
        parts = await modelInputFor(DIRS, row.payload, {
          entity,
          mode: "extract",
          // board?. — the row's board can vanish between the claim and the
          // read here (the adjacent `board?.mapping` guards the same window);
          // an absent pin just means "use the app default".
          preset: await effectivePreset(board?.tag_image_preset),
          images: imagesFor(ai),
        });
        imageRender = parts.find((p) => p.kind === "image")?.render ?? null;
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
      // Meter at the paid call, not at the landing: everything below —
      // identity derivation, the stamp, the alert sweep — can throw, and the
      // bill must not ride on any of it succeeding (the same hoist as the tag
      // landing's). Never throws.
      const dims = { capability: "extract", provider: ai.provider, model: ai.model };
      await meterAiCall(db, row.board_id, dims, usage);
      spent = spentDetail(dims, [usage]);
    }

    // Seed with the deterministic file fields projected from the stored entry,
    // so the payload.fields write below (markExtracted replaces the map) doesn't
    // drop them. Projected from the CURRENT board mapping (like the backfill), so
    // a file-field edit during the pending window still lands; the stamped mapping
    // only governs AI replay. Keys are unique, so AI fields never collide.
    const fields = extractFileFields(row.payload.files?.[0], board?.mapping?.fields || mapping.fields);
    // Lenient-validate each extracted scalar: wrong type → null (keep the why
    // sentence). Detect fields are populated by the detector pass below, not here.
    // A field with options lands its answer as an ARRAY of the options'
    // canonical spellings (landListValues), stamped `kind: "list"` — the
    // shape column file fields already carry — so the object-field
    // discriminator (objectKeysOf) and the lightbox can tell it from a box
    // array. This branch comes first, since the kind checks below would
    // null an array.
    for (const f of extractFields) {
      const entry = input[f.key];
      if (!entry) continue;
      const why = typeof entry.why === "string" ? entry.why.trim() : "";
      if (hasOptions(f)) {
        fields[f.key] = { v: landListValues(f, entry.values), why, kind: "list" };
        continue;
      }
      let v = entry.value ?? null;
      if (v !== null) {
        if (f.kind === "number" && typeof v !== "number") v = null;
        if (f.kind === "url" && (typeof v !== "string" || !/^https?:\/\//.test(v))) v = null;
        if ((f.kind === "text" || f.kind === "date") && typeof v !== "string") v = null;
      }
      fields[f.key] = { v, why };
    }

    // Object-detection pass: a separate leg, not an LLM call. One detect field =
    // one object type; its queries are the instruction (comma/newline-split
    // synonyms for the SAME thing), or the de-snaked field key when there's none
    // (a field `license_plate` detects "license plate"). Every detect field's queries run
    // in ONE detector pass (LLMDet takes all the queries at once), then each box is
    // routed back to its field by the matched query. A non-image item has nothing
    // to detect (empty, not an error); a detector failure throws → the extract leg
    // requeues, like extractor downtime. Boxes arrive canonical (xyxy, 0..1).
    if (objectFields.length) {
      // `detectable` (and with it `detector`) was settled above, before the
      // extraction spend — this reads that one answer rather than deriving a
      // second one.
      if (!detectable) {
        for (const f of objectFields) fields[f.key] = { v: [], why: "no image to detect on" };
      } else {
        const image = await fs.promises.readFile(path.join(galleryDir, detectFile.name));
        for (const f of objectFields) fields[f.key] = { v: [], why: "No objects detected" };
        // Build the query set, run ONE detection pass, demux boxes back to fields
        // by matched label (detectionDemux owns the sidecar-matching normalization).
        // The image is capped + oriented first (imageForDetection) — same boxes,
        // far less to ship to the single-threaded sidecar. `detector` resolved
        // above, before the extraction spend.
        const demux = detectionDemux(objectFields);
        const { objects, usage: detected } = await detector.detect(await imageForDetection(image), demux.queries);
        // Meter at the paid call, like every other leg — everything below can
        // throw and the bill must not ride on it. One call and one image are
        // what this call site KNOWS it spent (many queries ride a single pass,
        // so the image is the quantity, not the query); whatever the engine
        // reported rides on top, because a vision-model detector bills in
        // tokens. The on-device sidecar reports nothing and those zeros never
        // write a row. Never throws.
        const detectDims = { capability: "detect", provider: detector.id, model: detector.model };
        await meterAiCall(db, row.board_id, detectDims, detected, { images: 1 });
        // A detect-only board never calls a model, so this leg is what the job
        // row has to describe. It used to stamp the literal string "detection"
        // into the MODEL slot — a placeholder standing where a model name goes,
        // while the engine that actually ran was named right here. `??=` because
        // the extractor above spends first when both legs run: one `spent`
        // fragment names one engine, and the meter has both regardless.
        spent ??= spentDetail(detectDims, [detected]);
        const byField = demux.route(objects);
        for (const f of objectFields) {
          const v = byField.get(f.key) || [];
          fields[f.key].v = v;
          if (v.length) fields[f.key].why = `Detected: ${[...new Set(v.map((d) => d.label))].join(", ")}`;
        }
      }
    }

    // The card key: resolve the item's membership SET before advancing. Open
    // and list fields are the same path — an open field yields one derived
    // value, a list field zero-or-more from its options; both become the set
    // of entity ids the item carries (entity_ids[0] canonical). The value is
    // read off the LANDED field, so the list filter/canonical spelling above
    // is the one canonicalisation for card and non-card fields alike. The
    // instance's fields are written either way — they're its own.
    // `disposition` feeds the job-log summary; `landed` reports whether the
    // stamp beat the fence.
    let landed = false;
    let disposition = null;
    const cardField = cardFieldOf(mapping);
    if (cardField) {
      const landedV = fields[cardField.key]?.v;
      // In OPEN mode the display name is the model's output verbatim —
      // identity can be anything ("INV-2026-04", "BTC-USD", a name, a date),
      // so no cleanup heuristic mangles someone's format; fuzzy matching
      // lives only in the key. A list field's values are already the
      // options' spellings, deduped. Normalise + dedupe, preserving order
      // (first stays canonical).
      const raw = Array.isArray(landedV) ? landedV : landedV != null ? [String(landedV)] : [];
      const seen = new Set();
      const derived = [];
      for (const v of raw) {
        if (typeof v !== "string" || !v.trim()) continue;
        const key = normaliseIdentity(v);
        if (seen.has(key)) continue;
        seen.add(key);
        derived.push({ key, display: v.trim() });
      }

      const oldIds = row.entity_ids || [];
      if (derived.length === 0) {
        // AI derived nothing / matched no option. Keep the current membership;
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
      // One card per file: the item is its own card, named by its file. A
      // board that HAD a card key keeps the cards it generated until a
      // reprocess brings every instance through here, so this branch has to
      // undo what the card branch did — an instance sharing an entity is
      // moved to a fresh shell, a sole one is reset in place (id kept, so
      // hearts and crate places survive; the name goes back to the file so
      // the board looks per-file uniformly). Connector boards never reach
      // this (their vehicles are sole by construction and carry no file).
      const label = row.payload?.identity || `item ${row.id}`;
      const fileName = row.payload.files?.[0]?.name;
      const oldIds = row.entity_ids || [];
      if (!mapping.input && fileName && oldIds.length) {
        const sole = oldIds.length === 1 && (await entityInstanceCount(db, oldIds[0])) <= 1;
        if (sole) {
          const e = await getEntity(db, oldIds[0]);
          if (e && (e.identity !== fileName || e.display_name)) await resetEntityToShell(db, e.id, fileName);
        } else {
          const shell = await createEntity(db, row.board_id, { identity: fileName });
          await withTx(db, async (client) => {
            await setItemEntities(client, row.id, [shell]);
            await reconcileEntities(client, [...oldIds, shell]);
          });
          // Two instances leaving the same card at once each still see the
          // other inside their own transaction, so neither reconcile deletes
          // it and it commits empty. reapEmptyEntities would collect it in
          // time, but a dissolve that leaves a blank card on the board until
          // then is the one thing this branch exists to prevent — sweep the
          // old ids once more after the commit.
          await deleteEmptyEntities(db, oldIds);
          disposition = "moved";
        }
      }
      if ((landed = await stampExtracted(row, fields)))
        console.log(`extracted #${row.id} ${label} [${spent?.model ?? "none"}] -> [${Object.keys(fields).join(", ")}]${disposition === "moved" ? " (own card again)" : ""}`);
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

    return {
      landed, fields: Object.keys(fields).length, identity: disposition,
      spent, image: imageRender,
    };
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
        { fields: r.fields, ...(r.identity ? { identity: r.identity } : {}), ...r.spent,
          // Image-bearing extractions only — "what did the model actually see",
          // the same question the tag leg's row answers.
          ...(r.image ? { image: r.image } : {}) });
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
        try { face = await generateFace(db, DIRS, entity, { id: row.id, payload: row.payload }, board, now); }
        catch (e) { renderError = e.message; console.warn(`face render failed for #${row.entity_ids?.[0]} ${label}: ${e.message} (tile)`); }
        rendered = !!face;
        await setEntityRefreshAt(db, entity.id, entityRefreshAt(entity.fields, face ? now : entity.face_at, board.mapping, now));
      }
      // rendered:false + render_error is the "why is my chart a tile" answer —
      // the leg still advances (outcome ok), but the log says what happened.
      // `connector`, not `provider`: since the billing legs started stamping
      // `provider` with the AI vendor that served them, one JSONB key meaning
      // both a connector id and a model vendor would quietly mix the two in
      // any query that spans kinds (Stage 4's drill-down joins on exactly this).
      const detail = {
        connector: board?.mapping?.input?.connector ?? null, rendered,
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

  // Fetch leg (add-feedback-plan Stage 2): the bulk add enqueues connector
  // vehicles at 'pending_fetch' with a placeholder entity (browse-row name +
  // symbol, empty fields); this leg buys the provider data and lands it, then
  // routes the item to whichever leg the board wants next — the same
  // computation the synchronous add used to make inline.
  async function processFetchOne(row) {
    const label = row.payload?.identity || `item ${row.id}`;
    const t0 = Date.now();
    try {
      const board = await getBoard(db, row.board_id);
      const entity = row.entity_ids?.[0] ? await getEntity(db, row.entity_ids[0]) : null;
      // Board or entity gone mid-claim = the row is (or is about to be) gone
      // too — deleteEntity removes sole-home vehicles, board delete cascades.
      // Throwing routes through failOrRequeue, whose fence no-ops on a row
      // that no longer exists.
      if (!board || !entity) throw new Error("board or entity deleted mid-fetch");
      const connectorName = board.mapping?.input?.connector;
      const conn = connectorName ? getConnector(connectorName) : null;
      if (!conn) throw new Error("board no longer has a connector input");
      const fetched = await fetchProjectedEntity(db, conn, row.payload?.source?.id, board);
      // Land fields + the corrected identity/name/symbol in one statement.
      // A 23505 here is a LATE duplicate — the enqueue lacked the symbol (or
      // the provider disagrees with its own list) and the true identity is
      // already on the board. 409 makes failOrRequeue fail it immediately
      // (permanent), so it surfaces in the jobs drill instead of retrying.
      try {
        await landEntityFetch(db, entity.id, {
          identity: fetched.identity,
          displayName: fetched.display_name,
          symbol: fetched.symbol,
          fields: fetched.fields,
          refreshAt: firstRefreshAt(fetched.fields, board.mapping),
        });
      } catch (err) {
        if (err.code === "23505") {
          const e = new Error(`"${fetched.identity}" is already on this board`);
          e.status = 409;
          throw e;
        }
        throw err;
      }
      // A row without the 'unfetched' stamp is a reprocess re-buying its data —
      // connectorLanding's refetch rule lands it explicit (never held).
      const to = connectorLanding(board, { refetch: !row.payload?.unfetched }).status;
      const detail = { connector: connectorName, provider: fetched.source?.provider ?? null };
      if (await advanceFetched(db, row.id, to, { identity: fetched.identity, source: fetched.source })) {
        await legLog(row, "fetch", t0, "ok", null, detail);
      } else {
        await legLog(row, "fetch", t0, "discarded", null, detail);
        console.warn(`stale fetch advance for #${row.id} ${label} discarded (re-routed or deleted mid-flight)`);
      }
    } catch (err) {
      const failed = await failOrRequeue(db, row.id, err, MAX_ATTEMPTS, "pending_fetch");
      if (!err.noCount) await legLog(row, "fetch", t0, failed ? "failed" : "requeued", err.message);
      console.warn(`fetch error #${row.id} ${label}: ${err.message} (${failed ? "failed" : "requeued"})`);
    }
  }

  // --- the work, as kinds on the resource loop (queue-by-resource-plan.md) ---
  // Each kind hands server/resource-loop.js what is ready, what a unit contends
  // for, and how to run one; the loop owns how many and when. What a unit
  // contends for is the RESOURCE that will actually serve it — the API key behind
  // a board's tagger, the connector's active provider, the sidecar, the receiving
  // webhook host — so a throttled key costs only the boards on that key. A lane
  // sized by pipeline stage could not express that, and the rate limiter
  // underneath was keyed the other way.

  // The four pipeline legs: CLAIMING kinds, sharing ONE in-flight set because
  // the ids are item ids in one namespace — recoverStuck reads it so it cannot
  // reclaim a live call as stuck, and the legs hand rows to each other
  // (markExtracted and advanceFaced both land `pending`, the tag leg's queue),
  // which is why the loop wakes every kind on a shared set when one settles.
  //
  // `exclude` is ignored on purpose: a claiming `due` FLIPS the row's status, so
  // a row this process is already running is not in any stage list the next
  // claim asks for. The sweeps below do need it — their `due` is a read.
  const inFlight = new Set();
  let hasDefault = false; // refreshed each maintenance pass; read by every claim
  const leg = (name, stage, run, prep) => ({
    name, claims: true, inFlight, prep,
    due: (d, { limit, onlyBoards = null, excludeBoards = [] }) =>
      claimFairBatch(d, hasDefault, [stage], limit, excludeBoards, onlyBoards),
    boardOf: (row) => row.board_id,
    // A throw here reads as "unconstrained" to the loop, which is the safe
    // direction: the board claims exactly as it did before the arc.
    resourceOf: (d, row) => boardResourceFor(d, name, row.board_id),
    run: (_d, row) => run(row),
  });

  // Transcription: a SWEEP, because audio has no items.status leg — a clip
  // qualifies by the ABSENCE of a transcript, and landing one flips no status
  // (it writes the payload and clears the vector, which is the embed sweep's
  // business). Its own in-flight set for the same reason.
  //
  // Per-clip retry ledger: itemId → { attempts, until }. A fault tied to ONE
  // clip — its job stalled, vanished, or hit an inference error — backs off and
  // caps here, so a pathological clip cannot freeze the whole audio queue. The
  // query skips clips still inside their backoff; that is `waiting` below.
  const transcribeRetry = new Map();
  // Whether the app-wide chain resolves at all. Its floor is presence-gated
  // (sidecar-presence-plan.md), so on a host running no sidecar with nothing
  // bound this is false and ONLY boards carrying their own pin are servable.
  // This is the CAN-RUN question and it stays in SQL, where board pins are a
  // column test: on an engine-less host nothing is read, failed or logged. What
  // a clip CONTENDS for is a different question — resourceOf below — and the
  // two do not collapse: letting them would make an unservable clip unclaimable
  // and an unconstrained one invisible.
  const transcribeServed = async () => ({
    globally: !!(await resolveCapability(db, "transcribe")),
    pinCols: CAPABILITY.transcribe.binding.boardKeys,
    floorProvider: CAPABILITY.transcribe.floor?.provider ?? null,
  });
  const transcribeKind = {
    name: "transcribe",
    due: async (d, { exclude, limit }) => {
      const waiting = [...transcribeRetry].filter(([, r]) => r.until > Date.now()).map(([id]) => id);
      return audioNeedingTranscription(d, [...exclude, ...waiting], await transcribeServed(), limit);
    },
    // The whisper sidecar, or the key behind a cloud transcriber. The loop
    // launches at most `free()` per engine, so a clip waiting on a busy sidecar
    // no longer stands in front of one whose board pins a provider.
    resourceOf: (d, row) => boardResourceFor(d, "transcribe", row.board_id),
    run: async (d, row) => {
      // transcribeOne never throws and handles every answer but one itself.
      // "The engine is unwell" is the one about the RESOURCE rather than the
      // clip: zero its free slots for a minute and the loop stops sizing work for
      // it while every board on a different engine carries on. On a cloud
      // transcriber that resource is the board's API key, so a 429 here also
      // eases off tagging on that key for the window — one key, one quota.
      if (await transcribeOne(d, galleryDir, row, transcribeRetry) !== "backoff-lane") return;
      const r = await boardResourceFor(d, "transcribe", row.board_id);
      if (r) backoff(r, 60000);
    },
  };

  // Alert delivery: a SWEEP over the firings owed a webhook, and the one kind
  // whose `exclude` is a correctness requirement. Delivery is send-then-stamp
  // (at-least-once, deliberately), so a firing stays `pending` — and therefore
  // due — for the whole length of its own send; without the exclusion an
  // overlapping tick would post it twice. Nothing backs off here: a failing
  // endpoint has its own per-firing retry schedule in the row, which is per
  // firing, survives a restart, and is visible in the ledger.
  const alertsKind = {
    name: "alerts", limit: 10,
    due: (d, { exclude, limit }) => pendingWebhookFirings(d, Date.now(), limit, exclude),
    resourceOf: (_d, f) => webhookBucket(f.webhook_url),
    run: (d, f) => deliverFiring(d, f),
  };

  // Embedding: (re)vectorize items with no current-model vector — fresh tags,
  // manual edits, search turned on late, a model change. A unit is a BOARD
  // GROUP, not a row, because the wire answers one usage total per call and a
  // call spanning boards would leave the per-board split a guess; every group
  // in a tick contends for the same thing, since the embedder is app-global.
  const EMBED_BATCH = Math.max(1, Number(process.env.EMBED_BATCH) || 64);
  const embedKind = {
    name: "embed", limit: EMBED_BATCH,
    due: async (d, { exclude, limit }) => {
      const embedder = await resolveEmbedder(d);
      if (!embedder) return []; // the feature is off, or nothing usable is bound
      const rows = await itemsNeedingEmbedding(d, embedder.model, limit, exclude);
      const groups = new Map();
      for (const r of rows) {
        if (!groups.has(r.board_id)) groups.set(r.board_id, []);
        groups.get(r.board_id).push(r);
      }
      return [...groups.values()].map((rs) => ({ embedder, rows: rs }));
    },
    keys: (g) => g.rows.map((r) => r.id),
    resourceOf: (_d, g) => embedResource(g.embedder),
    run: async (d, g) => {
      const resource = embedResource(g.embedder);
      // On-device only: a keyed provider's slot is already held at the wire
      // (providers.js viaKey), and taking it again here would be the same string
      // twice on one call — a self-deadlock the moment the ceiling is 1.
      const bulk = !!PROVIDERS[g.embedder.provider]?.onDevice;
      if (bulk) await poolWait(resource);
      try {
        const { embedded, skipped } = await embedBatch(d, g.embedder, g.rows);
        console.log(`embedded ${embedded} item(s)${skipped ? `, skipped ${skipped}` : ""} [${g.embedder.model}]`);
      } catch (err) {
        // A batch-level failure is about the ENGINE, not these rows — embedBatch
        // has already ruled out one poison item, retrying them alone and only
        // re-throwing when nothing succeeded that way. Zero the resource's free
        // slots for a minute; the rows never left the queue and come back.
        backoff(resource, 60000);
        console.warn(`embed error (retrying in 60s): ${err.message}`);
      } finally {
        if (bulk) poolRelease(resource);
      }
    },
  };

  // Liveness refresh: entities whose live connector fields (or chart face) are
  // due. A SWEEP — refresh_at only moves when the refresh LANDS — over units
  // that already carry their board row, so what one contends for costs no read:
  // the connector's active provider, the same `conn:` the fetch leg claims
  // against. That is one quota, honestly: up to `free(conn:<p>)` refreshes now
  // run at once per provider where the old sweep did one entity at a time, and
  // they share those slots with fetches. The wire counts them (runtime.js
  // callProvider), so `run` holds nothing.
  //
  // Failure splits in two, where the old sweep had one lane-wide timer that a
  // single delisted coin could trip for everyone. THIS ENTITY is wrong → its own
  // refresh_at moves a minute out, here. THE PROVIDER is unwell → the wire backs
  // off `conn:<p>` in the pool and the loop stops sizing work for it, while every
  // other provider's entities refresh on cadence.
  const REFRESH_BATCH = Math.max(1, Number(process.env.REFRESH_BATCH) || 20);
  const refreshKind = {
    name: "refresh", limit: REFRESH_BATCH, prep: prefetchDueRefreshes,
    due: (d, { exclude, limit }) => dueLiveEntities(d, Date.now(), limit, exclude),
    keys: (row) => [row.entity.id],
    resourceOf: (d, row) => boardResource(d, "refresh", row.board),
    run: async (d, row) => {
      try {
        // A moved field can requeue the entity's item for re-tag — claimable
        // work for the tag leg, which cannot see this kind's settle.
        if ((await refreshDueEntity(d, row, Date.now(), DIRS)).requeued) wakeAll();
      } catch (err) {
        await setEntityRefreshAt(d, row.entity.id, Date.now() + 60000);
        console.warn(`refresh error entity #${row.entity.id} (retrying in 60s): ${err.message}`);
      }
    },
  };

  // Ingestion: a SWEEP over due feed boards. A board stays due until its run
  // SETTLES and re-stamps ingest_next_run_at, so `exclude` is what stops a
  // second run of the same board starting under the same fence while the first
  // is still admitting — the sequential loop this replaces awaited each run,
  // which hid it. "Run now" mid-run is unchanged: the route re-stamps, the run
  // in flight fails its gate and stops, the board stays excluded until it
  // returns, and the next tick takes it up under the new stamp.
  //
  // A connector feed contends for the provider serving it — the same `conn:`
  // the fetch leg and the refresh kind draw on, and the one the wire backs off
  // when a catalog walk finds it unwell. A file feed contends for nothing worth
  // naming: a folder scan is disk, an S3 listing is a bucket that handles
  // concurrency fine and is single-flighted per connection besides.
  const ingestKind = {
    name: "ingest",
    due: (d, { exclude, limit }) => dueIngestBoards(d, Date.now(), limit, exclude),
    resourceOf: (d, b) => boardResource(d, "ingest", b),
    run: (_d, b) => ingestBoard(b),
  };

  // Facet diagnosis (planning/facet-diagnosis-plan.md §4): the rotation walk is
  // `due`, the paid call is `run`. The provider and the tagger are injected:
  // facet-diagnosis.js sits BELOW this file in the import graph — worker.js
  // reaches in there for facetStamp — so it must never reach back, and passing
  // the two functions is what keeps that true.
  //
  // The poll here is load-bearing in a way no other kind's is. The loop re-ticks
  // 200 ms after any tick that launched, and on every settle; for a kind that
  // rotates to a NEW board each call, that would walk the whole install as fast
  // as calls settle — every unstable facet diagnosed in a burst on a key tagging
  // shares, and the settle-gate rollups run once per settled call instead of
  // once a poll. Same total spend, arriving all at once. So `due` opens once per
  // poll: a time check, no query while closed, and the re-ticks and wakes fall
  // through to `pollMs` for free. What the kind buys over the loop it replaces
  // is that one board's unstable facets run in PARALLEL up to its key's free
  // slots, where the loop answered them one after another.
  //
  // The cursor lives here rather than in the module: it is an ordering, not
  // state worth a column, and a restart re-starting at the lowest board id costs
  // one redundant staleness check.
  const diagnoseDeps = {
    resolveAi: (board) => resolveBoardAi(db, { aiKeyId: board.ai_key_id, aiModel: board.ai_model }),
    tagger: (args) => trackedTagger(db, args),
  };
  let diagnoseCursor = null;
  let diagnoseHandedAt = 0;
  const diagnoseKind = {
    name: "diagnose", pollMs: DIAGNOSE_POLL_MS,
    due: async (d, { exclude }) => {
      if (Date.now() - diagnoseHandedAt < DIAGNOSE_POLL_MS) return [];
      const found = await diagnoseCandidates(d, diagnoseDeps, diagnoseCursor, exclude);
      diagnoseCursor = found?.boardId ?? null;
      if (!found?.units.length) return [];
      diagnoseHandedAt = Date.now();
      return found.units;
    },
    keys: (u) => [`${u.board.id}:${u.facet.key}`],
    resourceOf: (d, u) => boardResourceFor(d, "tag", u.board.id),
    run: async (d, u) => {
      if (await diagnoseAnswer(d, diagnoseDeps, u.board, u.facet, u.segment, u.prior, u.q)) {
        console.log(`diagnosed facet ${u.facet.key} on board ${u.board.id}`);
      }
    },
  };

  // Declared here rather than after `work` because two runs above call it
  // (refresh on a requeue, ingest on an admission) and `work` is what provides it. Nothing can call it before the assignment
  // below: every tick opens by awaiting `due`, so the first `run` is at least a
  // turn away.
  let wakeAll = () => {};

  const work = runKinds([
    leg("tag", "pending", processOne),
    leg("extract", "pending_extract", processExtractOne),
    leg("face", "pending_face", processFaceOne),
    leg("fetch", "pending_fetch", processFetchOne, prefetchClaimedFetches),
    transcribeKind,
    alertsKind,
    embedKind,
    refreshKind,
    ingestKind,
    diagnoseKind,
  ], { db, pollMs: POLL_MS });

  // Nudge everything above. Three writers create claimable rows without knowing
  // which kind picks them up — a scheduled retag, a moved live field, a feed
  // admission — and an extra idle tick on a kind that had nothing to do is far
  // cheaper than a row waiting out a poll for a wake nobody sent.
  wakeAll = () => work.wakeAll();

  let running = true;
  let maintainWake = () => {};

  // Maintenance: recovery + the LIGHT coordination work (retag scheduling, alert
  // firing, prune) on a cadence, off the claiming path so a slow sweep can't
  // stall it. Everything that talks to a provider is a kind on the resource loop
  // above. Nudges every kind after, since retag may have created work.
  const maintainLoop = (async () => {
    while (running) {
      try {
        const recovered = await recoverStuck(db, STUCK_MS, MAX_ATTEMPTS, [...inFlight]);
        if (recovered) console.log(`worker: recovered ${recovered} stuck item(s)`);
        hasDefault = !!(await resolveDefaultAi(db));
        await retagDue();
        // Firing creation — pure coordination, no outbound I/O, which is exactly
        // what this loop is for. It sits above the hourly and best-effort work
        // below so a slow backup walk cannot delay an alert, and the `wakeAll()`
        // at the end of this pass nudges the delivery kind, so a firing created
        // here is sent on the same tick rather than waiting out a poll.
        await createDueFirings(db);
        await pruneSnapshots();
        await reapGhostEntities();
        await learnPricesDue();
        // Scheduled DB-only backup (server/backup.js) — it no-ops unless due
        // and skips itself while any backup/restore job is running.
        if (autoBackup) await autoBackup();
        // Daily storage sample (server/storage.js) — self-gated and
        // self-catching; last, so this shared try's earlier sweeps never
        // lose their turn to a failed walk.
        if (sampleStorage) await sampleStorage();
      } catch (e) { console.error("worker maintain error:", e.message); }
      if (!running) break;
      wakeAll();
      await new Promise((r) => {
        const t = setTimeout(r, POLL_MS);
        maintainWake = () => { clearTimeout(t); r(); };
      });
    }
  })();

  // Asked of the pool rather than mirrored from env, so the line cannot claim a
  // ceiling the pool does not actually enforce.
  const ceilings = `in flight at once: ${maxFor("ai:")} per AI key, ${maxFor("conn:")} per connector, ${maxFor("sidecar:")} per sidecar`;
  resolveDefaultAi(db).then((ai) => {
    if (ai) {
      console.log(`AI tagging worker started (default ${ai.provider}/${ai.model}, per-board overrides in board settings; ${ceilings}).`);
    } else {
      console.log(`AI tagging worker started (no default key — only boards with their own key will tag; ${ceilings}).`);
    }
  }).catch((e) => console.warn(`worker: default-AI probe failed at start: ${e.message}`)); // log-only — an unhandled rejection here would crash the boot
  // Stop claiming immediately; the returned promise resolves once the
  // in-flight tick (if any) has finished, so callers can drain before exit.
  return () => {
    running = false;
    // Stop claiming now; this resolves once every kind has left its tick AND every
    // launched run has settled. Started here so they stop at the same instant
    // `running` goes false, exactly as they did when one flag held the dispatcher.
    const drained = work.stop();
    maintainWake();
    // Drain: let the maintenance pass finish, then the kinds' own drain.
    // server.js caps the total wait.
    return (async () => {
      await maintainLoop;
      await drained;
    })();
  };
}
