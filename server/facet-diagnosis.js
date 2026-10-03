// Facet diagnosis (planning/facet-diagnosis-plan.md). Vote mode tells a user THAT
// a facet is unreliable; this says why, and a scoped retag lets them check whether
// the fix worked.
//
// Imports db.js and nothing else, on the alerts.js pattern — and deliberately not
// worker.js, in either direction: worker.js reaches in here for facetStamp, so
// what this module needs from the worker (the resolved provider, the tagger) is
// injected by the caller rather than imported.
import crypto from "node:crypto";
import {
  boardFacetSegments, facetSplitValues, facetExamples,
  boardsWithVotes, boardTagActivity, boardQueuedScopes, setFacetDiagnostic, openJob,
} from "./db.js";
import { meterAiCall, spentDetail } from "./metering.js";

// How many worked examples of each kind the prompt carries. Four unanimous is
// enough to make the comparison possible without letting the contrast set crowd
// out the failures it exists to be read against.
const CONTESTED_SHOWN = 8;
const UNANIMOUS_SHOWN = 4;

// The gates. Every one is a guess off one board's data and wants revisiting once
// several boards have run — env-overridable so a test can move them without
// pretending the defaults are settled.
//
// The settle window covers the tail `busy` cannot see: a human correcting items
// one at a time (setItemTags moves the counts with nothing ever queued) and a
// trickle of arrivals between batches. Three minutes and not ten because
// auto-tag's tightest cadence is 15, so a board on it with a five-minute drain
// would never see a ten-minute quiet spell and would silently never be diagnosed.
const SETTLE_MS = Number(process.env.DIAGNOSE_SETTLE_MS) || 180000;
const MIN_ITEMS = Number(process.env.DIAGNOSE_MIN_ITEMS) || 20;
const MIN_RATE = Number(process.env.DIAGNOSE_MIN_RATE) || 0.30;
// Tries before giving up on one unchanged question. Every other outbound-I/O path
// here carries one (failOrRequeue's attempts, alerts.js's WEBHOOK_MAX_ATTEMPTS)
// for the same reason: nothing about a failure changes the gates, so without a
// recorded attempt the next tick asks again — a paid call every DIAGNOSE_POLL_MS
// for as long as the condition lasts. Attempts count against one question at one
// rate (`stands`), so the moment either moves the facet gets a clean slate.
const MAX_ATTEMPTS = 3;
// …and a question that has used its tries rests this long, then gets one more.
// Nothing else would wake it: a retag that lands at the same rate is the same
// question, so a dead key, an outage or a refusal that has since been fixed would
// leave the facet "couldn't re-read" for good. Resting, a failure that persists
// costs one call a day rather than one a minute.
const RETRY_AFTER_MS = 24 * 3600 * 1000;
// Served with the payload rather than re-declared client-side: the reader decides
// which state a facet is in from these same numbers, and a browser copy would
// drift the first time any of them is retuned — with a symptom (a facet stuck
// "awaiting re-measurement" while the loop happily re-diagnoses it) that reads as
// a bug in neither half. `maxAttempts` is here because hitting the cap is the
// moment the loop stops trying, and a facet that goes quiet for that reason has
// to say so rather than render as healthy.
export const GATES = { minItems: MIN_ITEMS, minRate: MIN_RATE, maxAttempts: MAX_ATTEMPTS };
// Bounded per pass so a fleet of newly vote-enabled boards cannot fan out into a
// burst of calls, and so the rotation below actually rotates.
const MAX_FACETS = 10;
const SCAN_BOARDS = 8;

// ─── the definition stamp ────────────────────────────────────────────────────

// A short hash over one facet's DEFINITION and the SHAPE of the prompt that
// measured it, written onto every confidence entry (mergeVotes) so a later reader
// can tell which wording a number describes. Facet A's entry can come from
// yesterday's scoped pass and B's from last month's full one, and after a gloss
// edit and a re-tag mixed is the EXPECTED state — without the stamp a diagnosis
// reads pre-edit measurements as though they described the new wording.
//
// `scoped` is inside the hash because a scoped measurement may not be
// interchangeable with a full one (a live probe put scoped-vs-full agreement at
// 72.5% against an 85.0% full-vs-full control — suggestive, not established), and
// pooling two prompt shapes to reach a sample minimum is how you get a confident
// wrong answer. Two shapes with one definition therefore hash DIFFERENTLY and
// never silently merge, which is what makes pickSegment necessary rather than
// defensive.
//
// Values are SORTED first, so reordering them in the modal keeps a board's
// measurements: it moves the prompt, but it is not a redefinition. The inputs are
// JSON-serialised rather than concatenated for the same reason the hash exists at
// all — a collision does not fail loudly, it reads pre-edit measurements as
// post-edit ones.
export function facetStamp(facet, scoped = false) {
  return crypto.createHash("sha1").update(JSON.stringify([
    facet.description || "",
    [...(facet.values || [])].sort(),
    !!facet.single,
    !!scoped,
  ])).digest("hex").slice(0, 12);
}

// ─── choosing which measurements to read ─────────────────────────────────────

// A facet has TWO current stamps — the same definition measured full and measured
// scoped — and the reader has to commit to one before it counts anything. Getting
// this wrong in either direction breaks the loop with nothing failing loudly: read
// only the full stamp and the scoped retag this feature tells the user to run
// writes a stamp it cannot see, so the verification leg never fires; read only the
// scoped one and no board qualifies at all. Both present as "nothing to report",
// which is also what a healthy board looks like.
//
// More items wins, ties go to the scoped shape (it is the one the diagnose → edit
// → re-tag loop keeps writing, so it is the segment that will keep growing), and
// zero-vs-zero is not a tie — the facet is unmeasured and `d` comes back null to
// say so. The two are rarely close in practice, because a scoped retag replaces
// that facet's entry on every item it lands on; what it cannot reach (failed, held
// and undecided rows) keeps the old stamp, which is why this is "more items" and
// not "any scoped item wins".
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
  // pre-stamp entry (d = null). Not evidence about the current definition, but the
  // difference between "never measured" and "measured against wording you
  // replaced" — which the UI renders as two different sentences.
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
// all. Only one of those is what the data would give you on its own.
export async function facetRollup(db, board) {
  const [rows, scopes] = await Promise.all([
    boardFacetSegments(db, board.id),
    boardQueuedScopes(db, board.id),
  ]);
  // A queued item rewrites a facet when its pass is unscoped (every facet) or when
  // the facet is named in its scope. Nothing else in the queue is that facet's
  // business.
  const queuedFor = (key, count) =>
    scopes.reduce((n, r) => n + (!r.facets || r.facets.includes(key) ? r[count] : 0), 0);
  const found = board.facet_diagnostics || {};
  // The finding rides on the same row as the measurements it describes. Two
  // surfaces read this — the Tagging consistency modal and the facet editor — and
  // handing them the halves separately is how one ends up rendering a paragraph
  // beside numbers it was not written about.
  return (board.facets || []).map((f) => {
    const r = {
      ...pickSegment(f, rows, queuedFor(f.key, "n")),
      // Of those, the ones being RE-measured: they carried an answer the pass will
      // replace, so while they wait the figures are partial. A first pass (an
      // upload) adds cards to the sample without taking any away.
      remeasuring: queuedFor(f.key, "measured"),
      diagnostic: found[f.key] || null,
    };
    // `current` stays undefined with no entry, so the reader shows rather than
    // hides something it cannot reason about. With one, it is the loop's own
    // test, so the screens hide exactly what the loop is about to re-ask.
    if (r.diagnostic) r.current = stands(r.diagnostic, r);
    return r;
  });
}

// Everything the diagnosis prompt reads about one facet, confined to the segment
// pickSegment chose: the split values, and the worked examples in the two groups
// the prompt shows. Null for an unmeasured facet rather than an empty sample —
// there is nothing to ask about, and an empty sample would be asked anyway.
export async function diagnosisSample(db, boardId, segment) {
  if (!segment.d) return null;
  const [split, contested, unanimous] = await Promise.all([
    facetSplitValues(db, boardId, segment.key, segment.d),
    facetExamples(db, boardId, segment.key, segment.d, { contested: true, limit: CONTESTED_SHOWN }),
    facetExamples(db, boardId, segment.key, segment.d, { contested: false, limit: UNANIMOUS_SHOWN }),
  ]);
  // `unanimous` empty is a legitimate and informative state (a facet that never
  // once converged), not a reason to fall back to the contested set — reusing
  // those would make the comparison the prompt asks for circular.
  return { split, contested, unanimous };
}

// Which facets the user just redefined, with the wording being REPLACED. Keyed on
// the same hash the roll-up gates on, so the demotion rule and the gate can never
// drift apart — a hand-written comparison of description/values/single would be
// free to.
//
// The UNSCOPED hash on both sides: `scoped` is a property of a measurement, not of
// the definition being edited. A new facet has nothing to demote; one that left
// the board keeps an orphaned entry the roll-up never surfaces.
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
// inconsistent", a model will always find a reason — that is what it is for. Given
// no way to say "these items really are mixed" or "nothing here", it invents a
// taxonomy flaw and phrases it convincingly. The escape hatches have to exist, the
// prompt has to say they are acceptable, and the UI has to render them differently
// from a finding.
const VERDICTS = ["overlapping-values", "unclear-definition", "genuinely-ambiguous-items", "no-problem-found"];
// The two that are not actionable. A rewrite under either is forced empty rather
// than trusted: a model that has just said nothing is wrong must not also hand
// over wording to paste into the description.
const ACTIONABLE = new Set(["overlapping-values", "unclear-definition"]);

// The boards index's answer to "does this board have a finding worth a dot"
// (boards-signals-plan.md), read from the stored column alone.
//
// The gallery asks the same question through diagnosisState over facetRollup —
// two aggregate queries per board, on the endpoint that has been a performance
// problem before. Once per board on a background tick would make the index's
// cheap route the expensive one, which is the mistake defect 5 in
// header-signals-loose-ends.md records against latestJobFailureAt. So the index
// reads what listBoards already selected and accepts a coarser answer.
//
// Exact here: ACTIONABLE is precisely the pair that reaches the `finding` state
// — `no-problem-found` is not news, and `genuinely-ambiguous-items` is
// information rather than a task, which is why the gallery's dot excludes it
// too. `explanation` is the same `renderable` test.
//
// Inexact in both directions, and the OVER-light half has THREE causes rather
// than the one the plan named — because after the item minimum diagnosisState
// gates a finding on `row.current !== false && rate >= minRate` (with nothing
// queued), and all three of those operands are the live segment:
//
//   - items below the minimum → the gallery says `awaiting`, or `measuring`
//     with a pass draining. The cause the plan named.
//   - the live contested rate has fallen below the floor → the gallery says
//     nothing at all. Probably the commonest of the three: hand curation fixes
//     contested items without touching the definition, so there is no
//     `previous` to make it `improved` and the sample need not have shrunk at
//     all. (setItemTags DELETES a corrected facet's confidence entry rather
//     than re-stamping it, which facet-diagnosis-loose-ends.md §10 names as
//     sampling bias; below the minimum it lands in the first case instead.)
//   - `current === false` → `stands`, the SERVER's own "the question or the %
//     has moved" answer, computed from that same segment.
//
// All three fail the same way — a dot on a board that has a stored finding in
// it, a coarser truth rather than a lie — and none of them is visible from the
// stored entry, which is the whole reason this read is cheap.
//
// The UNDER-light is one thing: the `improved` state, whose verdict a demotion
// deliberately does not carry forward.
//
// The two directions want different fixes, and it is worth writing down which,
// because "denormalize it at write time" sounds like it answers both and does
// not. The UNDER-light is a write-time fact, so a flag the loop stamps would
// close it. Every OVER-light is caused by the live segment moving AFTER the
// write, so no stamp can see any of them: only a read of the segment can, which
// is the read this function exists to avoid.
export function storedFindingAt(board) {
  const found = board?.facet_diagnostics || {};
  // Only facets the board still DECLARES, which is facetRollup's rule ("a stored
  // key whose facet has left the board has to not appear at all") and not an
  // optional nicety here: a deleted facet's finding is invisible in the gallery,
  // so a dot lit by one could never be acknowledged from anywhere.
  const live = new Set((board?.facets || []).map((f) => f?.key));
  let at = 0;
  for (const [key, e] of Object.entries(found)) {
    if (!live.has(key)) continue;
    if (!ACTIONABLE.has(e?.verdict) || !e?.explanation) continue;
    at = Math.max(at, Number(e.at) || 0);
  }
  return at || null;
}

// Bumped whenever the QUESTION changes, and it rides in the freshness key: a
// stored finding answers one specific question, and an answer to a different
// question is not current however unchanged the measurements are. Bumping
// re-diagnoses every facet on its next settled tick, which is the only way entries
// written against an older schema get replaced instead of lingering unactionable.
//   1 -> 2: `suggestion` (a sentence to append) became `rewrite` (a replacement).
//   2 -> 3: the advice branches on `single` (see buildDiagnosePrompt).
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

// Two halves, split by what varies. The facet's definition and the rules go in the
// system turn — stable across every item and pass, so a provider-side prompt cache
// can hold them. The measurement and the worked examples go in the user turn.
//
// The advice BRANCHES on `facet.single`, and that is the whole point rather than a
// nicety. Stating the arity and then asking unconditionally for a precedence rule
// is a contradiction, and the model resolves it the way it was told to: on a
// multi-value facet it writes "when both could apply, prefer X", which instructs
// the tagger to discard a value that was really there. Recall drops and agreement
// goes UP, because fewer values in play means fewer ways to disagree — so this
// feature would score the damage as a success and print "63% before, 81% now" over
// it. Nothing downstream can tell that apart from a real fix, which is why it has
// to be prevented here rather than caught later.
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

// ─── is a stored finding still current? ──────────────────────────────────────

// A finding is a claim about a facet's WORDING — "these two values overlap, here
// is wording that separates them" — and it names values, never cards. So it
// stands while two things hold, and nothing else is consulted
// (planning/facet-diagnosis-rerun-plan.md):
//
//   THE SAME QUESTION. The prompt version and the facet's stamp: its wording, its
//     values, one-vs-many, and a full pass vs a facet-only retag. An edit, a
//     re-measurement in the other shape or a new PROMPT_VERSION is a different
//     question.
//   THE SAME %, to five points. The headline says "contradicted itself on 37% of
//     items"; add 500 items that tag cleanly and that is a lie.
//
// Nothing tracks individual cards. Adding, deleting, hand-fixing, retagging and
// reprocessing count through the %, and only through it. The key used to carry a
// fingerprint of the twelve worked examples, and a retag marked the findings
// whose examples it touched: deleting a batch of old cards then re-asked an
// unchanged question (the examples are picked oldest first), and every action
// that had to remember to mark a finding was a place to miss one
// (facet-diagnosis-loose-ends.md 35-40). Re-asking with the same wording and the
// same % gets the same answer — six re-runs on `logos` in an afternoon of
// deletes, one verdict.
//
// Five percentage points, and a TOLERANCE rather than a bucket. The distinction
// is the whole of it: a bucket answers "which side of an arbitrary line", not
// "how far did it move", so two rates 0.9 points apart differ when they straddle
// a boundary while two 4.9 points apart match when they do not.
//
// Observed on the live `ui` board, one uploaded image at a time:
//
//   93 items, 59 unanimous   36.56%   bucket 35
//   96 items, 60 unanimous   37.50%   bucket 40   <- re-diagnosed
//   97 items, 61 unanimous   37.11%   bucket 35   <- re-diagnosed again
//
// 0.55 points of real movement, two paid calls, ending on the key it started
// from — because 37.5 sits exactly on a boundary and Math.round takes it up. On a
// 97-item sample one item moves the rate about a point, so roughly one upload in
// five crossed a line. A tolerance has no lines to cross, and measured from the
// finding's own numbers, slow drift adds up rather than slipping through a step
// at a time.
const RATE_TOLERANCE = 5;
const rateOf = (unanimous, items) => (items ? ((items - unanimous) / items) * 100 : 0);

// Has the headline moved enough to read differently? `stats` is what the finding
// was written about; the segment is what is there now.
//
// `asked` before `stats`: they are the same thing on a finding, and differ only on
// an entry that has only ever failed, where `stats` is an older finding's kept as
// a demote baseline and `asked` is what was actually tried.
function rateHeld(entry, segment) {
  const was = entry?.asked || entry?.stats;
  if (!was?.items) return true; // nothing to compare — never hide on a guess
  return Math.abs(rateOf(segment.unanimous, segment.items) - rateOf(was.unanimous, was.items)) < RATE_TOLERANCE;
}

// The question a finding answers, stored as `k` on every entry, findings and
// failed attempts alike.
export const questionOf = (segment) => `v${PROMPT_VERSION}|${segment.d}`;

// Does this finding still stand? The one answer: the loop asks it to decide
// whether to spend, and the roll-up to decide what the screens show, so the two
// cannot disagree about which findings are current. The attempts counter keys on
// it too, so a facet whose question or % has really moved gets a clean slate of
// tries. An entry with no key (a demotion leaves only `previous`) never stands.
const stands = (entry, segment) => entry?.k === questionOf(segment) && rateHeld(entry, segment);

const str = (v) => (typeof v === "string" ? v.trim() : "");
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

// The PAID half: one call, one entry on the board, one job-log row — for a facet
// `candidates` let through, on the key `diagnoseCandidates` resolved. Exported for
// the worker's kind, whose `run` this is. Returns the stored entry, null for an
// attempt that recorded a failure, and throws only what nobody here owns (a db
// hiccup), after settling its own job row.
export async function diagnoseAnswer(db, deps, board, facet, segment, ai) {
  const prior = segment.diagnostic;
  const k = questionOf(segment);
  // The one thing an attempt always leaves behind, so a failure is a fact on the
  // board rather than a line in a log nobody reads.
  //
  // `previous` and `stats` ride through untouched, and both are baselines the
  // user's next edit needs: demoteFacetDiagnostics turns `stats` into the next
  // `previous` and skips any entry without them, so dropping them here means the
  // 'improved' state can never fire on the very facet the loop just told the user
  // to fix. The verdict is deliberately NOT carried — it answered a question that
  // has since moved, and keeping it would make `candidates` read an outdated
  // finding as a current one.
  //
  // `asked` is the numbers THIS attempt was made against, and it has to be its own
  // field rather than reusing `stats`. The two differ on exactly this entry:
  // `stats` here is an older finding's, kept as a demote baseline, so measuring
  // "has the question changed" against it would answer yes for ever — a cap that
  // never engages and a facet retried every tick. Written on the attempt path
  // only; on a finding, `stats` already is what it asked about.
  const t0 = Date.now();
  // The pass's in-flight presence: a paid call taking seconds-to-minutes is
  // work happening, and `running` job-log rows are how lane work reaches the
  // wire (first-class-work-plan.md). Both exits below settle this row
  // instead of writing their own settled rows.
  const job = await openJob(db, {
    boardId: board.id, target: facet.key, kind: "diagnose", startedAt: t0,
  });
  const attempted = async (error, spent = null) => {
    const attempts = (stands(prior, segment) ? prior.attempts || 0 : 0) + 1;
    await setFacetDiagnostic(db, board.id, facet.key, {
      k, at: Date.now(), attempts, error,
      asked: { items: segment.items, unanimous: segment.unanimous },
      ...(prior?.previous ? { previous: prior.previous } : {}),
      ...(prior?.stats ? { stats: prior.stats, d: prior.d ?? null, scoped: prior.scoped ?? null } : {}),
    });
    // …and a row in the job log, on the app's standing convention for a failed
    // pass (jobs-modal renders "N attempts · <error>" for a non-ok outcome). The
    // success path already logs; without this the one surface that answers "what
    // did the worker do, and did it work" showed diagnosis as though it never
    // failed. Warn-never-throw for the same reason as the success row.
    await job.settle({
      outcome: "failed", error,
      // `spent` only where the call actually happened and its answer was
      // unusable — the wire-throw site has no usage to report. That row is the
      // one this function exists for ("it cost real money"), so it says how
      // much, the same way a discarded tag row does.
      detail: { attempts, items: segment.items, unanimous: segment.unanimous, ...spent },
    });
  };

  // Backstop for any throw the two exits above don't own (a db hiccup in the
  // sample query, the meter, the landing): a running row left dangling reads
  // as work-in-flight on every surface until a restart reaps it, so an
  // unsettled row is stamped failed before the error continues to the
  // caller's per-facet catch.
  try {
    const sample = await diagnosisSample(db, board.id, segment);
    // What the passes were parting on when this was written. Taken from the sample
    // rather than probed for: this is the only path that needs it, and it has
    // already paid for the query.
    const split = sample.split.slice(0, 5).map((s) => s.value).sort();
    const { systemText, schema, parts } = buildDiagnosePrompt(board, facet, segment, sample, prior?.previous);
    let input, usage;
    try {
      ({ input, usage } = await deps.tagger({
        provider: ai.provider, apiKey: ai.apiKey, base: ai.base, model: ai.model,
        systemText, schema, parts, tool: DIAGNOSE_TOOL,
      }));
    } catch (e) {
      // Recorded before rethrowing, so the caller still logs it and the next tick
      // still knows this was tried. Without the record the gates pass identically a
      // minute later and the same call is made again, indefinitely.
      await attempted(String(e.message).slice(0, 200));
      throw e;
    }
    // One meter write per paid call, whatever came back — the ledger tracks
    // spend, not usefulness. Metered as its own kind ('diagnose', the job-log
    // vocabulary): it rides the tag binding but it is not tagging, and spend
    // transparency is exactly the place the difference matters.
    const dims = { capability: "diagnose", provider: ai.provider, model: ai.model };
    if (usage) await meterAiCall(db, board.id, dims, usage);
    // The same facts in the row's spelling, for whichever row this pass writes.
    const spent = spentDetail(dims, [usage]);

    // strictTools:false providers treat the schema as advisory, so an off-list
    // verdict is reachable. Record no FINDING rather than inventing one: a stored
    // verdict is a claim about the user's taxonomy, and "the model answered something
    // we don't understand" is not one. The attempt is still recorded — it cost real
    // money, and a provider that does this once will do it again.
    const verdict = VERDICTS.includes(input?.verdict) ? input.verdict : null;
    if (!verdict) {
      console.warn(`diagnose: board ${board.id} facet ${facet.key} — unusable verdict ${JSON.stringify(input?.verdict)}`);
      await attempted(`unusable verdict: ${JSON.stringify(input?.verdict)}`.slice(0, 200), spent);
      return null;
    }

    const entry = {
      verdict,
      explanation: str(input.explanation),
      values: arr(input.values),
      // Forced empty on the two non-actionable verdicts rather than trusted: a model
      // that has just said nothing is wrong must not hand the UI wording to paste
      // over the user's own.
      rewrite: ACTIONABLE.has(verdict) ? str(input.rewrite) : "",
      stats: { items: segment.items, unanimous: segment.unanimous },
      split,
      d: segment.d,
      scoped: segment.scoped,
      k,
      at: Date.now(),
      // Carried forward, not re-derived: the demotion sets `previous` when the user
      // edits, and it has to survive every later diagnosis or the "was 60%, now 88%"
      // comparison loses its baseline the moment it becomes computable.
      ...(prior?.previous ? { previous: prior.previous } : {}),
    };
    await setFacetDiagnostic(db, board.id, facet.key, entry);
    // Warn, never throw — the app's standing rule is that a writer must not throw
    // into the job it observes. Thrown from here the finding would already be stored,
    // the caller would log "diagnose failed", and the rotation would count a success
    // as a failure.
    await job.settle({
      outcome: "ok",
      detail: {
        items: segment.items, unanimous: segment.unanimous, verdict, scoped: segment.scoped, ...spent,
      },
    });
    return entry;
  } catch (e) {
    // settle is idempotent — the exits above already settled on their paths,
    // so this only catches the throws nobody owns (a db hiccup in the sample
    // query, the meter, the landing) before they reach the caller's
    // per-facet catch. Unsettled, the running row would read as
    // work-in-flight on every surface until a restart reaps it.
    await job.settle({ outcome: "failed", error: String(e.message).slice(0, 200) });
    throw e;
  }
}

const instability = (s) => (s.items - s.unanimous) / s.items;
// Out of tries on this question, and not yet rested (RETRY_AFTER_MS).
const resting = (e) => (e.attempts || 0) >= MAX_ATTEMPTS && Date.now() - (Number(e.at) || 0) < RETRY_AFTER_MS;

// The facets on one board worth spending a call on, or null when the board itself
// is not ready. Gates 2-5; gate 1 (vote mode) is boardsWithVotes.
//
// A finding that stands is dropped BEFORE MAX_FACETS is applied, and so is a
// question that has used its tries. The bound caps the calls in one pass; taken
// from every unstable facet, ten that needed nothing held the slots while the
// eleventh, its % moved, was never looked at. Both tests read only the row, so
// they cost nothing here. What is left is ordered worst first, which is the
// difference between a priority and a truncation: whatever waits is asked on a
// later pass, once the ones ahead of it stand.
async function candidates(db, board) {
  const act = await boardTagActivity(db, board.id);
  if (act.busy > 0 || Date.now() - act.lastTagged < SETTLE_MS) return null;

  const out = [];
  for (const segment of await facetRollup(db, board)) {
    // Gate 5 rides inside the segment: `items` is one prompt shape's worth of
    // measurements of the CURRENT definition, never a pool of two. Below the
    // minimum the facet is awaiting re-measurement — a UI state, not a silence.
    if (segment.items < MIN_ITEMS) continue;
    if (instability(segment) < MIN_RATE) continue;
    // The same question (`current` is `stands`, set by the roll-up), already
    // answered or tried enough: the cap is about money against an unchanged
    // question, so it holds until the question or the % moves, or it has rested.
    const prior = segment.diagnostic;
    if (segment.current && (prior.verdict || resting(prior))) continue;
    out.push(segment);
  }
  out.sort((a, b) => instability(b) - instability(a));
  return out.slice(0, MAX_FACETS);
}

// The rotation, split from the act (queue-by-resource-plan.md Stage 7). Walks
// boards past `afterBoardId` and hands back every facet on the FIRST board with a
// real question as units the worker's kind runs in parallel, returning the id it
// stopped at so the caller can rotate past it. A unit carries the segment it was
// checked against and the key it will spend on, so the run spends on exactly what
// was decided here. `exclude` is the facets already in flight, so a slow call
// cannot be asked twice.
//
// A rotation rather than "the first board that qualifies": nothing here creates
// claimable work, so there is no row that stops matching once it has been served.
// A board whose staleness check keeps passing would be re-picked every pass and
// every board behind it would starve — silently, and indefinitely.
//
// "First board with a real QUESTION", not "first board with unstable facets", and
// the difference is the rotation's responsiveness: a board whose unstable facets
// all stand is walked past inside this one call, where handing it out and
// discovering the skips one facet at a time would cost a whole poll per such
// board — and a moved facet fifteen boards along would wait fifteen polls to be
// noticed.
export async function diagnoseCandidates(db, deps, afterBoardId = null, exclude = []) {
  const boards = await boardsWithVotes(db);
  if (!boards.length) return null;
  const at = afterBoardId ? boards.findIndex((b) => b.id === afterBoardId) + 1 : 0;
  const start = at > 0 && at < boards.length ? at : 0;
  const skip = new Set(exclude);

  let visited = null;
  for (let i = 0; i < Math.min(SCAN_BOARDS, boards.length); i++) {
    const board = boards[(start + i) % boards.length];
    visited = board.id;
    const byKey = new Map((board.facets || []).map((f) => [f.key, f]));
    const segments = ((await candidates(db, board)) || []).filter((s) => !skip.has(`${board.id}:${s.key}`));
    if (!segments.length) continue;
    try {
      // One key for the board: every facet on it spends on the same one.
      const ai = await deps.resolveAi(board);
      if (!ai) continue; // no key is a configuration gap, not a finding
      return { boardId: board.id, units: segments.map((segment) => ({ board, facet: byKey.get(segment.key), segment, ai })) };
    } catch (e) {
      // Never load-bearing (the evaluateItemAlerts rule): a missing diagnosis
      // costs nothing, and a diagnosis pass that broke tagging would be a serious
      // regression. One board's failure does not end the walk.
      console.warn(`diagnose failed for board ${board.id}: ${e.message}`);
    }
  }
  return { boardId: visited, units: [] };
}

// One whole pass, synchronously: the rotation, then every question it found
// answered in turn. What the tests drive, and what "tick the diagnosis once"
// means outside the worker — which runs the two halves apart, the answers in
// parallel. One difference from the loop this replaced, deliberate and shared
// with the kind: a board whose every attempt FAILED ends the pass (the next one
// moves on), where the old loop tried the next board in the same breath — under
// a provider outage that is one board's worth of failed calls per pass rather
// than eight.
export async function diagnoseDue(db, deps, afterBoardId = null) {
  const found = await diagnoseCandidates(db, deps, afterBoardId);
  if (!found) return null;
  let calls = 0;
  for (const u of found.units) {
    try {
      if (await diagnoseAnswer(db, deps, u.board, u.facet, u.segment, u.ai)) calls++;
    } catch (e) {
      console.warn(`diagnose failed for board ${u.board.id} facet ${u.facet.key}: ${e.message}`);
    }
  }
  return { boardId: found.boardId, calls };
}
