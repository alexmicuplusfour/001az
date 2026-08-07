// Facet diagnosis (planning/facet-diagnosis-plan.md). Vote mode tells a user
// THAT a facet is unreliable; this tells them why, and a scoped retag lets them
// check whether the fix worked. Built in slices: this is the definition stamp
// (§2, shipped) and the roll-up that reads it (§1). The diagnosis call and its
// loop come later.
//
// The module imports db.js and nothing else, on the alerts.js pattern — and
// deliberately not worker.js, in either direction: worker.js reaches in here for
// facetStamp, so anything this module later needs from the worker (the resolved
// provider, the tagger) has to be injected by the caller rather than imported.
import crypto from "node:crypto";
import {
  boardFacetSegments, facetSplitValues, facetExamples,
  boardsWithVotes, boardTagActivity, boardQueuedScopes, setFacetDiagnostic, addJobLog, bumpUsage,
} from "./db.js";

// How many worked examples of each kind the prompt carries. Four unanimous is
// enough to make the comparison possible without letting the contrast set
// crowd out the failures it exists to be read against.
const CONTESTED_SHOWN = 8;
const UNANIMOUS_SHOWN = 4;

// The gates. Every one of these is a guess off one board's data and wants
// revisiting once several boards have run — env-overridable so a test can move
// them without pretending the defaults are settled.
// Three minutes, down from the plan's ten. The reason §4 gave for ten — "a bulk
// retag lands items over minutes and the tally moves the whole time" — is
// already the OTHER half of this gate: retagBoardFacets arms every eligible row
// in one UPDATE, so `busy > 0` holds for the entire run and only falls when the
// last item lands, and a transient failure requeues to `pending` rather than
// leaving the queue. What the window actually covers is the tail that `busy`
// cannot see: a human correcting items one at a time (setItemTags moves the
// counts with nothing ever queued) and a slow trickle of arrivals between
// batches.
//
// Ten minutes also starves boards outright, which is loose end #16: auto-tag's
// tightest cadence is 15 minutes, so a board retagging that often with a
// five-minute drain never sees a ten-minute quiet spell and is silently never
// diagnosed. Three fits inside that gap.
//
// The trade is real in one direction: with the freshness key now exact, a
// diagnosis taken while the counts are still moving is guaranteed to be
// superseded and re-asked, so a shorter window buys freshness with the
// occasional wasted call. At ~1-2k input and ~200 output that is the right side
// to err on.
const SETTLE_MS = Number(process.env.DIAGNOSE_SETTLE_MS) || 180000;
const MIN_ITEMS = Number(process.env.DIAGNOSE_MIN_ITEMS) || 20;
const MIN_RATE = Number(process.env.DIAGNOSE_MIN_RATE) || 0.30;
// The UI decides which of the five states a facet is in from the same two
// numbers the gates use, so they ride out with the payload rather than being
// re-declared client-side. A copy in the browser would drift the first time
// either is retuned, and the symptom — a facet stuck in "awaiting
// re-measurement" while the loop happily re-diagnoses it — reads as a bug in
// neither half.
export const GATES = { minItems: MIN_ITEMS, minRate: MIN_RATE };
// Bounded per pass so a fleet of newly vote-enabled boards cannot fan out into a
// burst of calls, and so the rotation below actually rotates.
const MAX_FACETS = 10;
const SCAN_BOARDS = 8;
// Tries before giving up on one unchanged set of measurements. Every other
// outbound-I/O path in this app carries a backoff (failOrRequeue's attempts,
// alerts.js's WEBHOOK_MAX_ATTEMPTS) and this one needs it for the same reason:
// nothing about a failed diagnosis changes the gates, so without a recorded
// attempt the next tick asks again — a paid call every DIAGNOSE_POLL_MS, for as
// long as the condition lasts. Attempts are keyed to the freshness string, so
// the moment the data actually moves it gets a clean slate.
const MAX_ATTEMPTS = 3;

// ─── the definition stamp ────────────────────────────────────────────────────

// A short hash over one facet's DEFINITION and the SHAPE of the prompt that
// measured it, written onto every confidence entry (mergeVotes) so a later
// reader can tell which wording a number describes. Before facet scope an item's
// tag_confidence was one coherent snapshot; now facet A's entry can come from
// yesterday's scoped pass and B's from last month's full one, and after a user
// edits a gloss and re-tags that one facet, mixed is the EXPECTED state. Without
// the stamp a diagnosis re-reads pre-edit measurements as though they described
// the new wording.
//
// `scoped` is inside the hash because a scoped measurement may not be
// interchangeable with a full one (the live probe put scoped-vs-full agreement
// at 72.5% against an 85.0% full-vs-full control — suggestive, not established),
// and pooling two prompt shapes to reach a sample minimum is how you get a
// confident wrong answer. Two shapes with the same definition therefore hash
// DIFFERENTLY and never silently merge — which is what makes pickSegment below
// necessary rather than defensive.
//
// Values are SORTED first, so reordering them in the modal keeps a board's
// measurements: it moves the prompt, but it is not a redefinition, and throwing
// away every number over a drag is the worse trade.
//
// 12 hex chars, following providers.js's key fingerprint, and the inputs are
// JSON-serialised rather than concatenated. Both are about the same failure: a
// collision here does not fail loudly, it silently reads pre-edit measurements
// as post-edit ones, which is the exact bug the stamp exists to prevent.
export function facetStamp(facet, scoped = false) {
  return crypto.createHash("sha1").update(JSON.stringify([
    facet.description || "",
    [...(facet.values || [])].sort(),
    !!facet.single,
    !!scoped,
  ])).digest("hex").slice(0, 12);
}

// ─── choosing which measurements to read ─────────────────────────────────────

// A facet has TWO current stamps — the same definition measured full and
// measured scoped — and the reader has to commit to one before it counts
// anything. Getting this wrong in either direction breaks the loop with nothing
// failing loudly: read only the full stamp and the scoped retag the diagnosis
// tells the user to run writes a stamp this cannot see, so the verification leg
// never fires; read only the scoped one and no board qualifies at all, because
// none has been scope-tagged. Both present as "nothing to report", which is also
// what a healthy board looks like.
//
// More items wins. A genuine tie goes to the scoped shape: it is the one the
// diagnose -> edit -> re-tag loop keeps writing, so it is the segment that will
// keep growing. Zero-vs-zero is not a tie — the facet is unmeasured, and `d`
// comes back null to say so rather than naming a segment with nothing in it.
//
// The two segments are rarely close in practice, because a scoped retag replaces
// that facet's entry on every item it lands on: the old segment drains as the
// new one fills. What the retag cannot reach — failed, held and undecided rows —
// keeps the old stamp, which is why this is "more items" and not "any scoped
// item wins".
export function pickSegment(facet, rows, queued = 0) {
  const mine = rows.filter((r) => r.facet === facet.key);
  const seg = (scoped) => {
    const d = facetStamp(facet, scoped);
    const r = mine.find((x) => x.d === d);
    return { d, scoped, items: r?.items || 0, unanimous: r?.unanimous || 0 };
  };
  const full = seg(false);
  const scoped = seg(true);
  const chosen = scoped.items >= full.items && scoped.items > 0 ? scoped : full;

  // Everything under some OTHER stamp: a wording the user has since edited, or a
  // pre-stamp entry (d = null). Not evidence about the current definition, but
  // the difference between "never measured" and "measured against wording you
  // replaced" — which the UI has to render as two different sentences.
  const stale = mine.reduce((n, r) => n + (r.d === full.d || r.d === scoped.d ? 0 : r.items), 0);

  return {
    key: facet.key,
    label: facet.label || facet.key,
    items: chosen.items,
    unanimous: chosen.unanimous,
    d: chosen.items ? chosen.d : null,
    scoped: chosen.items ? chosen.scoped : null,
    stale,
    // Items queued to rewrite THIS facet — zero for the eight facets a scoped
    // retag leaves alone, however much of the board is in flight for the ninth.
    queued,
  };
}

// The board-level answer to "which of my facets is a coin flip" — one row per
// facet the board declares, in board order.
//
// Driven by board.facets rather than by what tag_confidence happens to hold: a
// facet with no measurements has to appear (as items: 0) or its absence reads as
// health, and a stored key whose facet has left the board has to not appear at
// all. Both directions matter, and only one of them is what the data would give
// you on its own.
export async function facetRollup(db, board) {
  const [rows, scopes] = await Promise.all([
    boardFacetSegments(db, board.id),
    boardQueuedScopes(db, board.id),
  ]);
  // A queued item rewrites a facet when its pass is unscoped (every facet) or
  // when the facet is named in its scope. Nothing else in the queue is that
  // facet's business.
  const queuedFor = (key) =>
    scopes.reduce((n, r) => n + (!r.facets || r.facets.includes(key) ? r.n : 0), 0);
  const found = board.facet_diagnostics || {};
  // The finding rides on the same row as the measurements it describes. Two
  // surfaces read this — the Diagnostics modal and the facet editor — and
  // handing them the halves separately is how one ends up rendering a paragraph
  // beside numbers it was not written about.
  return (board.facets || []).map((f) => ({ ...pickSegment(f, rows, queuedFor(f.key)), diagnostic: found[f.key] || null }));
}

// Everything the diagnosis prompt reads about one facet, all of it confined to
// the one segment pickSegment chose. Returns null for an unmeasured facet rather
// than an empty sample — there is nothing to ask about, and an empty sample
// would be asked anyway.
export async function diagnosisSample(db, boardId, segment, { withExamples = true } = {}) {
  if (!segment.d) return null;
  // The split values alone answer "has anything moved since the stored finding"
  // (they are two thirds of the freshness key), and on a settled board that
  // question is asked every tick and answered "no" every time. Fetching the
  // worked examples to decide it would be three queries per unstable facet per
  // minute, forever, to change nothing.
  const split = await facetSplitValues(db, boardId, segment.key, segment.d);
  if (!withExamples) return { split, contested: [], unanimous: [] };
  const [contested, unanimous] = await Promise.all([
    facetExamples(db, boardId, segment.key, segment.d, { contested: true, limit: CONTESTED_SHOWN }),
    facetExamples(db, boardId, segment.key, segment.d, { contested: false, limit: UNANIMOUS_SHOWN }),
  ]);
  // `unanimous` empty is a legitimate and informative state (a facet that never
  // once converged), not a reason to fall back to the contested set — reusing
  // those would make the comparison the prompt asks for circular.
  return { split, contested, unanimous };
}

// Which facets the user just redefined, with the wording being REPLACED. Keyed
// on the same hash the roll-up gates on, so the demotion rule and the gate can
// never drift apart — a hand-written comparison of description/values/single
// would be free to.
//
// The UNSCOPED hash on both sides: `scoped` is a property of a measurement, not
// of the definition being edited, and comparing like for like is the whole job.
// A facet that is new has nothing to demote; one that left the board keeps an
// orphaned entry that the roll-up (driven by board.facets) never surfaces.
export function editedFacets(before = [], after = []) {
  const was = new Map(before.map((f) => [f.key, f]));
  const out = [];
  for (const f of after) {
    const had = was.get(f.key);
    if (had && facetStamp(had, false) !== facetStamp(f, false)) {
      out.push({ key: f.key, description: had.description || "" });
    }
  }
  return out;
}

// ─── the diagnosis call ──────────────────────────────────────────────────────

const DIAGNOSE_TOOL = { name: "record_diagnosis", description: "Record why this facet's tagging is inconsistent." };

// The last two verdicts are the load-bearing part. Asked "why is this
// inconsistent", a model will always find a reason — that is what it is for.
// Given no way to say "the values are fine, these items really are mixed" or
// "nothing here", it invents a taxonomy flaw and phrases it convincingly. The
// escape hatches have to exist, the prompt has to say they are acceptable
// answers, and the UI has to render them differently from a finding.
const VERDICTS = ["overlapping-values", "unclear-definition", "genuinely-ambiguous-items", "no-problem-found"];
// The two that are not actionable. A suggestion under either is forced empty
// rather than trusted: a model that has just said nothing is wrong must not also
// hand over wording to paste into the description.
const ACTIONABLE = new Set(["overlapping-values", "unclear-definition"]);

// Bumped whenever the QUESTION changes. It rides in the freshness key for the
// same reason `d` carries the prompt shape: a stored finding is an answer to one
// specific question, and a finding produced by a different question is not
// current however unchanged the measurements are. Bumping re-diagnoses every
// facet on its next settled tick, which is also the only way entries written
// against an older schema get replaced instead of lingering unactionable.
//   1 -> 2: `suggestion` (one sentence to append) became `rewrite` (a complete
//           replacement description).
//   2 -> 3: the advice branches on `single`. Under v2 a multi-value facet was
//           asked for a precedence rule and answered with one — "if both could
//           apply, prefer gradient-blend" — which tells the tagger to discard a
//           value that was really there. Every v2 finding on a multi-value facet
//           carries that defect, and the bump is what replaces them rather than
//           leaving them on screen with a control that hands the wording over.
const PROMPT_VERSION = 3;

const DIAGNOSE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    explanation: { type: "string", description: "Two sentences at most, naming the specific values involved." },
    values: { type: "array", items: { type: "string" }, description: "The values in tension, or empty." },
    rewrite: {
      type: "string",
      description:
        "A COMPLETE replacement for the facet description — not an addition to it. Keep every judgement " +
        "the current description already establishes, and restate it precisely enough that the ambiguity " +
        "above cannot recur. Three sentences at most. Empty when there is nothing worth changing.",
    },
  },
  required: ["verdict", "explanation", "values", "rewrite"],
  additionalProperties: false,
};

const tally = (votes = {}) => Object.entries(votes).map(([v, n]) => `${v} x${n}`).join(", ") || "nothing";

// Two halves, split by what varies. The facet's definition and the rules go in
// the system turn — stable across every item and every pass, so a provider-side
// prompt cache can hold them. The measurement and the worked examples go in the
// user turn, because they are the thing that changed.
//
// The advice BRANCHES on `facet.single`, and the branch is the whole point
// rather than a nicety. Telling the model the arity (one line, above) and then
// asking unconditionally for a precedence rule is a contradiction, and the
// model resolves it the way it was told to: on a multi-value facet it writes
// "when both could apply, prefer X", which instructs the tagger to discard a
// value that was really there. Recall drops — and agreement goes UP, because
// fewer values in play means fewer ways to disagree, so this feature scores the
// damage as a success and state 5 prints "63% before, 81% now" over it. Nothing
// downstream can tell that apart from a real fix, which is why it has to be
// prevented in the prompt rather than caught later.
//
// The slip is inherited from the plan: §0 observes that the unstable facets are
// exactly the ones "with values that can both be true of one item" and then
// prescribes "one recurring fix: a precedence rule". Those two sentences only
// agree for `single: true`. On a multi-value facet what is actually unsettled
// is each value's own threshold — what earns it, and what near miss does not.
export function buildDiagnosePrompt(board, facet, segment, sample, previous) {
  const unstable = segment.items - segment.unanimous;
  const pct = Math.round((unstable / segment.items) * 100);

  const systemText =
    `You are reviewing the TAXONOMY of a private research board — not any individual item.\n\n` +
    `A tagger applied one facet to this board's items several times over, independently, and ` +
    `disagreed with itself. Your job is to say why, and where the cause is the facet's own ` +
    `wording, to propose a fix.\n\n` +
    (board.context ? `What this board is for: ${board.context}\n\n` : "") +
    `The facet under review:\n` +
    `- key: ${facet.key}\n` +
    `- name: ${facet.label || facet.key}\n` +
    `- the tagger may pick: ${facet.single ? "exactly one value" : "any number of values, including none"}\n` +
    `- description, exactly as the user wrote it: ${facet.description ? `"${facet.description}"` : "(none — the facet has no guidance at all)"}\n` +
    `- allowed values: ${(facet.values || []).join(", ")}\n\n` +
    `You will be shown two labelled groups of items: ones where the passes disagreed, and ones ` +
    `where they agreed. Ask what the first group has that the second doesn't. That comparison is ` +
    `the task — do not ask "what is wrong with this facet", which assumes its own answer.\n\n` +
    `A few things to hold on to:\n` +
    `- You cannot see the items. Every description you are shown was written by the tagger ` +
    `itself, so any claim about what an item looks like has to rest on those words.\n` +
    `- "genuinely-ambiguous-items" — the taxonomy is fine and these particular items really are ` +
    `mixed — is a correct and expected answer, and so is "no-problem-found". Reach for them when ` +
    `the evidence does not support a wording change. Neither takes a rewrite.\n` +
    `- Your rewrite REPLACES the description; it is not appended to it. Rewrite the whole thing, ` +
    `keeping every judgement the current wording already establishes — you are making it unambiguous, ` +
    `not substituting your own idea of what the facet is for. Where the current wording already tries ` +
    `to draw the distinction and fails, say it better rather than saying it twice.\n` +
    (facet.single
      ? `- Exactly one value survives, so the strongest rewrites carry a PRECEDENCE RULE for the case ` +
        `where two values could each stand alone, e.g. "when a mark has both a uniform stroke and a ` +
        `colour blend, prefer gradient-blend". Name which one wins, and on what evidence.\n`
      : `- This facet takes ANY NUMBER of values, so a precedence rule is the wrong instrument here and ` +
        `writing one would be a regression: when two of these are genuinely both present, tagging BOTH ` +
        `is the correct answer, and "prefer X over Y" tells the tagger to throw one away. What is ` +
        `unsettled is the THRESHOLD for each value on its own — what has to be visible before that value ` +
        `is earned, and what near miss does not earn it. Rewrite so each contested value can be decided ` +
        `without reference to the others, and say plainly that two of them applying at once is expected ` +
        `rather than a conflict to resolve.\n`) +
    `- A rule that merely tells the tagger to apply the facet less often is not a fix — a facet that ` +
    `ends up empty is no more useful than one that keeps changing its mind. Nor is one that buys ` +
    `agreement by suppressing a value that was really there: fewer values in play means fewer ways to ` +
    `disagree, so that scores as an improvement here while making the tagging worse.\n\n` +
    `Record your answer with the ${DIAGNOSE_TOOL.name} tool.`;

  const group = (rows, empty) => (rows.length
    ? rows.map((r) => `- "${r.description}"\n    the passes chose: ${tally(r.votes)} (${r.agreed} of ${r.of} agreed)`).join("\n")
    : `  (${empty})`);

  const text =
    `Measured over ${segment.items} items. On ${unstable} of them (${pct}%) the passes did not all agree.\n\n` +
    `Where they parted — values some passes chose and others didn't, counted per item:\n` +
    (sample.split.length
      ? sample.split.slice(0, 8).map((s) => `- ${s.value}: ${s.split_on} of those ${unstable} items`).join("\n")
      : "  (no value stands out — the disagreement is spread thin)") +
    `\n\nITEMS WHERE THE PASSES DISAGREED\n` +
    group(sample.contested, "no descriptions available — this board does not store them, so judge from the values alone and say so if that is not enough") +
    `\n\nITEMS WHERE THE PASSES AGREED\n` +
    group(sample.unanimous, "none — this facet has never once converged on this board, which is itself the finding") +
    (previous
      ? `\n\nThis facet has been diagnosed before. The description then read ` +
        `${previous.description ? `"${previous.description}"` : "(nothing)"}, and ${previous.stats?.unanimous ?? 0} of ` +
        `${previous.stats?.items ?? 0} items were unanimous — against ${segment.unanimous} of ${segment.items} now. ` +
        `Say whether that edit helped, and diagnose what is left rather than repeating the earlier finding.`
      : "");

  return { systemText, schema: DIAGNOSE_SCHEMA, parts: [{ kind: "text", text }] };
}

// What "this diagnosis is still current" means: the same measurements, of the
// same definition, parting on the same values.
//
// `d` does most of the work — it already carries both the wording and the prompt
// shape — so this only has to catch the case where the numbers moved under an
// unchanged definition.
//
// The counts are EXACT. §4 bucketed the rate to 5 points so that one more tagged
// item could not invalidate a good paragraph, and that optimisation is what let
// a whole re-tag pass unnoticed: `construction` went from 2,143 items to 2,276
// with the rate at 37% on both sides of the run, so the key was identical and
// the loop skipped — a finding written about a sample that no longer existed,
// standing indefinitely. Drift and wholesale re-measurement are the same shape
// through a bucket, and there is no width that separates them.
//
// The re-diagnoses this costs are bounded by the settle gate rather than by the
// bucket: nothing is diagnosed until the board has been quiet for ten minutes,
// so the counts have stopped moving by the time this is read. A board that is
// genuinely being re-tagged is a board whose diagnosis genuinely is out of date.
//
// The reader hides a finding on exactly this condition (diagnosisState's
// `sameSample`). The two must stay in step: whatever this would re-diagnose,
// the UI hides — and anything the UI hides, this must re-diagnose, or a facet
// goes silent with nothing coming to replace it.
const freshness = (segment, split) => [
  `v${PROMPT_VERSION}`,
  segment.d,
  `${segment.unanimous}/${segment.items}`,
  split.join(","),
].join("|");

const str = (v) => (typeof v === "string" ? v.trim() : "");
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

// Diagnose one facet. Returns the stored entry, or null when nothing was worth
// spending a call on. `deps.tagger` is injected rather than imported: this
// module sits below worker.js in the import graph (worker.js reaches in here for
// facetStamp) and must stay there.
async function diagnoseFacet(db, deps, board, facet, segment, prior) {
  const probe = await diagnosisSample(db, board.id, segment, { withExamples: false });
  if (!probe) return null;
  const split = probe.split.slice(0, 5).map((s) => s.value).sort();
  const fresh = freshness(segment, split);
  // Nothing has moved since the last attempt on this facet — either it produced
  // a finding, or it has failed enough times that asking again is just spending.
  if (prior?.k === fresh && (prior.verdict || (prior.attempts || 0) >= MAX_ATTEMPTS)) return null;

  const ai = await deps.resolveAi(board);
  if (!ai) return null; // no key is a configuration gap, not a finding

  // The one thing an attempt always leaves behind, so a failure is a fact on the
  // board rather than a line in a log nobody reads.
  //
  // Two things ride through it untouched, and both are baselines the user's next
  // edit needs. `previous` is the obvious one — an outage between an edit and a
  // successful re-diagnosis must not destroy the evidence the edit did anything.
  // `stats` is the one the first sweep missed: the entry it replaces is what
  // demoteFacetDiagnostics moves INTO `previous`, and that function skips any
  // entry without stats. Drop them here and the sequence "finding stored →
  // measurements move → provider blips → user edits" leaves nothing to demote,
  // so the 'improved' state can never fire on the very facet the loop just told
  // the user to fix. The verdict is deliberately NOT carried: it described
  // measurements that have since moved, and keeping it would also make the skip
  // check above read a stale finding as a current one and never ask again.
  const attempted = (fields) => setFacetDiagnostic(db, board.id, facet.key, {
    k: fresh, at: Date.now(), attempts: (prior?.k === fresh ? prior.attempts || 0 : 0) + 1,
    ...(prior?.previous ? { previous: prior.previous } : {}),
    ...(prior?.stats ? { stats: prior.stats, d: prior.d ?? null, scoped: prior.scoped ?? null } : {}),
    ...fields,
  });

  const t0 = Date.now();
  const sample = await diagnosisSample(db, board.id, segment);
  const { systemText, schema, parts } = buildDiagnosePrompt(board, facet, segment, sample, prior?.previous);
  let input, usage;
  try {
    ({ input, usage } = await deps.tagger({
      provider: ai.provider, apiKey: ai.apiKey, base: ai.base, model: ai.model,
      systemText, schema, parts, tool: DIAGNOSE_TOOL,
    }));
  } catch (e) {
    // Recorded before rethrowing, so the caller still logs it and the next tick
    // still knows this was tried. Without the record the gates pass identically
    // a minute later and the same call is made again, indefinitely.
    await attempted({ error: String(e.message).slice(0, 200) });
    throw e;
  }
  // One row per paid call, whatever came back — the token ledger tracks spend,
  // not usefulness.
  if (usage) await bumpUsage(db, board.id, usage);

  // strictTools:false providers treat the schema as advisory, so an off-list
  // verdict is reachable. Record no FINDING rather than inventing one: a stored
  // verdict is a claim about the user's taxonomy, and "the model answered
  // something we don't understand" is not one. The attempt is still recorded —
  // it cost real money, and a provider that does this once will do it again.
  const verdict = VERDICTS.includes(input?.verdict) ? input.verdict : null;
  if (!verdict) {
    console.warn(`diagnose: board ${board.id} facet ${facet.key} — unusable verdict ${JSON.stringify(input?.verdict)}`);
    await attempted({ error: `unusable verdict: ${JSON.stringify(input?.verdict)}`.slice(0, 200) });
    return null;
  }

  const entry = {
    verdict,
    explanation: str(input.explanation),
    values: arr(input.values),
    // Forced empty on the two non-actionable verdicts rather than trusted: a
    // model that has just said nothing is wrong must not also hand the UI
    // wording to paste over the user's own.
    rewrite: ACTIONABLE.has(verdict) ? str(input.rewrite) : "",
    stats: { items: segment.items, unanimous: segment.unanimous },
    split,
    d: segment.d,
    scoped: segment.scoped,
    k: fresh,
    at: Date.now(),
    // Carried forward, not re-derived: `previous` is set by the demotion when
    // the user edits, and it has to survive every later diagnosis or the
    // "was 60%, now 88%" comparison loses its baseline the moment it becomes
    // computable.
    ...(prior?.previous ? { previous: prior.previous } : {}),
  };
  await setFacetDiagnostic(db, board.id, facet.key, entry);
  // Warn, never throw — the app's standing rule is that a writer must not throw
  // into the job it observes. Thrown from here the finding would already be
  // stored, the caller would log "diagnose failed", and the rotation would count
  // a success as a failure.
  await addJobLog(db, {
    boardId: board.id, target: facet.key, kind: "diagnose", outcome: "ok",
    detail: { items: segment.items, unanimous: segment.unanimous, verdict, scoped: segment.scoped },
    startedAt: t0, endedAt: Date.now(),
  }).catch((e) => console.warn(`diagnose job log write failed: ${e.message}`));
  return entry;
}

// The facets on one board worth spending a call on, or null when the board
// itself is not ready. Gates 2-5; gate 1 (vote mode) is boardsWithVotes.
async function candidates(db, board) {
  const act = await boardTagActivity(db, board.id);
  if (act.busy > 0 || Date.now() - act.lastTagged < SETTLE_MS) return null;

  const out = [];
  for (const segment of await facetRollup(db, board)) {
    // Gate 5 rides inside the segment: `items` is one prompt shape's worth of
    // measurements of the CURRENT definition, never a pool of two. Below the
    // minimum the facet is awaiting re-measurement — a UI state, not a silence.
    if (segment.items < MIN_ITEMS) continue;
    if ((segment.items - segment.unanimous) / segment.items < MIN_RATE) continue;
    out.push(segment);
    if (out.length >= MAX_FACETS) break;
  }
  return out;
}

// One pass of the loop. Walks boards from `afterBoardId` and diagnoses the first
// one with work, returning the id it stopped at so the caller can rotate past it.
//
// A rotation rather than "the first board that qualifies": nothing here creates
// claimable work, so there is no row that stops matching once it has been
// served. A board whose staleness check keeps passing would be re-picked every
// tick and every board behind it would starve — silently, and indefinitely.
export async function diagnoseDue(db, deps, afterBoardId = null) {
  const boards = await boardsWithVotes(db);
  if (!boards.length) return null;
  const at = afterBoardId ? boards.findIndex((b) => b.id === afterBoardId) + 1 : 0;
  const start = at > 0 && at < boards.length ? at : 0;

  let visited = null;
  for (let i = 0; i < Math.min(SCAN_BOARDS, boards.length); i++) {
    const board = boards[(start + i) % boards.length];
    visited = board.id;
    const segments = await candidates(db, board);
    if (!segments?.length) continue;

    const byKey = new Map((board.facets || []).map((f) => [f.key, f]));
    const prior = board.facet_diagnostics || {};
    let calls = 0;
    for (const segment of segments) {
      const facet = byKey.get(segment.key);
      if (!facet) continue;
      try {
        if (await diagnoseFacet(db, deps, board, facet, segment, prior[segment.key])) calls++;
      } catch (e) {
        // Never load-bearing (the evaluateItemAlerts rule): a missing diagnosis
        // costs nothing, and a diagnosis pass that broke tagging would be a
        // serious regression. One facet's failure does not end the board's pass.
        console.warn(`diagnose failed for board ${board.id} facet ${segment.key}: ${e.message}`);
      }
    }
    if (calls) return { boardId: board.id, calls };
  }
  return { boardId: visited, calls: 0 };
}
