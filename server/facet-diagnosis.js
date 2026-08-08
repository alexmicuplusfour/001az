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
  boardsWithVotes, boardTagActivity, boardQueuedScopes, setFacetDiagnostic, addJobLog, bumpUsage,
} from "./db.js";

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
// for as long as the condition lasts. Attempts are keyed to the freshness string,
// so the moment the data moves the facet gets a clean slate.
const MAX_ATTEMPTS = 3;
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
  const queuedFor = (key) =>
    scopes.reduce((n, r) => n + (!r.facets || r.facets.includes(key) ? r.n : 0), 0);
  const found = board.facet_diagnostics || {};
  // The finding rides on the same row as the measurements it describes. Two
  // surfaces read this — the Tagging consistency modal and the facet editor — and
  // handing them the halves separately is how one ends up rendering a paragraph
  // beside numbers it was not written about.
  const out = (board.facets || []).map((f) => ({ ...pickSegment(f, rows, queuedFor(f.key)), diagnostic: found[f.key] || null }));
  for (const r of out) {
    // `current` stays undefined with no entry, so the reader shows rather than
    // hides something it cannot reason about.
    if (!r.diagnostic) continue;
    // `stale` is set by supersedeFacetDiagnostics the moment a retag is armed —
    // the authoritative answer, from the one place that knows for certain the
    // measurements are about to move. Tested FIRST and without needing a segment:
    // while the pass is draining there are no tagged rows to resolve a stamp from,
    // so anything gated on `r.d` would skip exactly the window it exists to cover.
    if (r.diagnostic.stale) { r.current = false; continue; }
    // Rule two, and the only one the reader can afford — both operands are already
    // on the row. Rule one (did the twelve items change) is the worker's job and
    // reaches the reader as the flag above; putting it here took this endpoint to
    // 611ms. The reader must never be STRICTER than the loop or a facet goes quiet
    // with nothing coming.
    r.current = rateHeld(r.diagnostic, r);
  }
  return out;
}

// Everything the diagnosis prompt reads about one facet, confined to the segment
// pickSegment chose. Null for an unmeasured facet rather than an empty sample —
// there is nothing to ask about, and an empty sample would be asked anyway.
export async function diagnosisSample(db, boardId, segment, examples = null) {
  if (!segment.d) return null;
  // `examples` is the freshness check's own read, handed down. It fetched exactly
  // these two groups a moment ago to decide whether to spend at all, so fetching
  // them again would be two wasted queries AND a second chance for the check and
  // the prompt to disagree about which twelve items this paragraph is about.
  const [split, { contested, unanimous }] = await Promise.all([
    facetSplitValues(db, boardId, segment.key, segment.d),
    examples || facetEvidence(db, boardId, segment),
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

// A finding goes out of date in exactly two ways, checked in different places
// because they cost different amounts.
//
//   THE NUMBER MOVED. The headline says "contradicted itself on 37% of items";
//     add 500 items that tag cleanly and that is a lie. Bucketed to five points,
//     so growth that cannot change how the sentence reads does not invalidate it.
//     Free — both operands are on the row — which is why the READER computes this
//     half too. Five points is an absolute step on a bounded quantity, so unlike a
//     tolerance on a raw count it needs no defence: it is "the rate moved enough
//     to read differently".
//
//   THE EVIDENCE MOVED. The explanation was reasoned from twelve specific items,
//     and what dates it is not that they were touched but that they now SAY
//     something else. So the key holds what the prompt puts in front of the model
//     about each one — id, agreed/of, vote tally, description — and nothing the
//     prompt does not show. It costs a ranking query, so ONLY the worker asks it,
//     and a retag answers a cheaper version inline from the stored ids
//     (supersedeFacetDiagnostics).
//
//   +20 items, none in the twelve      evidence same, bucket same    skip
//   5 of 2,500 retagged, not the 12    evidence same, bucket same    skip
//   133 items re-measured              tallies and prose move        re-ask
//   the contested items hand-fixed     they leave the sample         re-ask
//   21 clean items land, 81% -> 40%    bucket moves                  re-ask
//
// WHAT IS DELIBERATELY NOT IN IT: the "where they parted" line, which counts split
// values over EVERY contested item rather than the twelve. A tension that shifts
// across the bulk of the board while the twelve hold and the rate keeps its bucket
// is missed. Hashing its counts was rejected because they move on a retag of ANY
// size, which is what rule 1 exists to prevent, and rank-hashing jitters on ties.
const RATE_BUCKET = 5;
const rateBucket = (unanimous, items) =>
  (items ? Math.round(((items - unanimous) / items) * (100 / RATE_BUCKET)) * RATE_BUCKET : 0);

// The half both readers can afford. `stats` is what the finding was written about;
// the segment is what is there now.
export function rateHeld(entry, segment) {
  if (!entry?.stats?.items) return true; // nothing to compare — never hide on a guess
  return rateBucket(entry.stats.unanimous, entry.stats.items) === rateBucket(segment.unanimous, segment.items);
}

// The twelve worked examples, in the two groups the prompt shows. ONE call serves
// both the freshness check and the prompt, which is what makes "the key tracks
// what the model reads" true by construction rather than by a comment asking two
// queries to please stay identical.
export function facetEvidence(db, boardId, segment) {
  return Promise.all([
    facetExamples(db, boardId, segment.key, segment.d, { contested: true, limit: CONTESTED_SHOWN }),
    facetExamples(db, boardId, segment.key, segment.d, { contested: false, limit: UNANIMOUS_SHOWN }),
  ]).then(([contested, unanimous]) => ({ contested, unanimous }));
}

// One worked example reduced to everything about it the prompt shows, and nothing
// else, so a column the prompt ignores cannot trigger a paid call.
//
// The id alone is NOT evidence: the ordering keys on `agreed/of`, which on a
// three-vote board takes three values, so ties are dense and break on `i.id` —
// pinning the same eight rows in their slots while every tally inverts and every
// description is rewritten under them.
//
// The tally is sorted rather than trusted to arrive in a stable order: it comes
// back as jsonb, and a key order that changed between reads would re-diagnose a
// facet on which nothing had happened.
const tallyKey = (v) =>
  Object.entries(v || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k}=${n}`).join(",");
const exampleKey = (r) => `${r.id}:${r.agreed}/${r.of}:${tallyKey(r.votes)}:${r.description || ""}`;

// The whole question, worker-side: the definition, the prompt version, the
// bucketed rate, and what the twelve examples say. Hashed, because the
// descriptions alone would put kilobytes of prose in a board column per facet; the
// ids stay legible on `entry.evidence`, which is what a retag looks up by.
export async function questionKey(db, boardId, segment) {
  const examples = await facetEvidence(db, boardId, segment);
  const shown = [...examples.contested, ...examples.unanimous];
  const digest = crypto.createHash("sha1").update(shown.map(exampleKey).join("|")).digest("hex").slice(0, 16);
  return {
    k: [`v${PROMPT_VERSION}`, segment.d, rateBucket(segment.unanimous, segment.items), digest].join("|"),
    evidence: shown.map((r) => r.id),
    examples,
  };
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

// Diagnose one facet. Returns the stored entry, or null when nothing was worth
// spending a call on.
async function diagnoseFacet(db, deps, board, facet, segment, prior) {
  if (!segment.d) return null;
  // The accurate check, and the one place that can afford it: one ranking query per
  // unstable facet per tick, in the worker, off every page load.
  const { k: fresh, evidence, examples } = await questionKey(db, board.id, segment);
  // Nothing worth spending on — and it is TWO independent questions. The cap is
  // about money against an unchanged question; `stale` is about whether the data
  // moved. Neither answers the other, and running them together is what let a
  // superseded finding retry every tick forever.
  if (prior?.k === fresh) {
    // Unconditional, a superseded finding included: `stale` says a retag
    // re-measured the sample, not that the provider will work this time.
    if ((prior.attempts || 0) >= MAX_ATTEMPTS) return null;
    // `stale` beats a stored VERDICT, and only that. A retag has re-measured the
    // items this finding was reasoned from, so the answer is out of date even
    // though the question looks identical — which is the key's one blind spot, a
    // re-measurement that reproduces the counts.
    if (!prior.stale && prior.verdict) return null;
  }

  const ai = await deps.resolveAi(board);
  if (!ai) return null; // no key is a configuration gap, not a finding

  // The one thing an attempt always leaves behind, so a failure is a fact on the
  // board rather than a line in a log nobody reads.
  //
  // `previous` and `stats` ride through untouched, and both are baselines the
  // user's next edit needs: demoteFacetDiagnostics turns `stats` into the next
  // `previous` and skips any entry without them, so dropping them here means the
  // 'improved' state can never fire on the very facet the loop just told the user
  // to fix. The verdict is deliberately NOT carried — it described measurements
  // that have since moved, and keeping it would make the skip check above read a
  // stale finding as a current one. `stale` is not carried either but is preserved
  // by the setter (the trailing false): a failed attempt has answered nothing, so
  // a retag's mark must outlive it, and only the setter can tell that apart from a
  // mark a concurrent write legitimately cleared.
  const t0 = Date.now();
  const attempted = async (error) => {
    const attempts = (prior?.k === fresh ? prior.attempts || 0 : 0) + 1;
    await setFacetDiagnostic(db, board.id, facet.key, {
      k: fresh, at: Date.now(), attempts, error,
      ...(prior?.previous ? { previous: prior.previous } : {}),
      ...(prior?.stats ? { stats: prior.stats, d: prior.d ?? null, scoped: prior.scoped ?? null } : {}),
    }, false);
    // …and a row in the job log, on the app's standing convention for a failed
    // pass (jobs-modal renders "N attempts · <error>" for a non-ok outcome). The
    // success path already logs; without this the one surface that answers "what
    // did the worker do, and did it work" showed diagnosis as though it never
    // failed. Warn-never-throw for the same reason as the success row.
    await addJobLog(db, {
      boardId: board.id, target: facet.key, kind: "diagnose", outcome: "failed", error,
      detail: { attempts, items: segment.items, unanimous: segment.unanimous },
      startedAt: t0, endedAt: Date.now(),
    }).catch((e) => console.warn(`diagnose job log write failed: ${e.message}`));
  };

  const sample = await diagnosisSample(db, board.id, segment, examples);
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
  // One row per paid call, whatever came back — the token ledger tracks spend, not
  // usefulness.
  if (usage) await bumpUsage(db, board.id, usage);

  // strictTools:false providers treat the schema as advisory, so an off-list
  // verdict is reachable. Record no FINDING rather than inventing one: a stored
  // verdict is a claim about the user's taxonomy, and "the model answered something
  // we don't understand" is not one. The attempt is still recorded — it cost real
  // money, and a provider that does this once will do it again.
  const verdict = VERDICTS.includes(input?.verdict) ? input.verdict : null;
  if (!verdict) {
    console.warn(`diagnose: board ${board.id} facet ${facet.key} — unusable verdict ${JSON.stringify(input?.verdict)}`);
    await attempted(`unusable verdict: ${JSON.stringify(input?.verdict)}`.slice(0, 200));
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
    // The twelve items this paragraph was reasoned from, so a retag can ask "does
    // this touch any of them" from the arming site without ranking anything —
    // which is what lets five items on a board of 2,500 leave a finding alone.
    evidence,
    d: segment.d,
    scoped: segment.scoped,
    k: fresh,
    at: Date.now(),
    // Carried forward, not re-derived: the demotion sets `previous` when the user
    // edits, and it has to survive every later diagnosis or the "was 60%, now 88%"
    // comparison loses its baseline the moment it becomes computable.
    ...(prior?.previous ? { previous: prior.previous } : {}),
  };
  // The one write entitled to clear `stale`, and only the mark this pass actually
  // read. A mark armed while the provider call was in flight describes a
  // re-measurement this finding has not seen, so it survives and the next settled
  // tick re-asks.
  await setFacetDiagnostic(db, board.id, facet.key, entry, !!prior?.stale);
  // Warn, never throw — the app's standing rule is that a writer must not throw
  // into the job it observes. Thrown from here the finding would already be stored,
  // the caller would log "diagnose failed", and the rotation would count a success
  // as a failure.
  await addJobLog(db, {
    boardId: board.id, target: facet.key, kind: "diagnose", outcome: "ok",
    detail: { items: segment.items, unanimous: segment.unanimous, verdict, scoped: segment.scoped },
    startedAt: t0, endedAt: Date.now(),
  }).catch((e) => console.warn(`diagnose job log write failed: ${e.message}`));
  return entry;
}

const instability = (s) => (s.items - s.unanimous) / s.items;

// The facets on one board worth spending a call on, or null when the board itself
// is not ready. Gates 2-5; gate 1 (vote mode) is boardsWithVotes.
//
// ORDERED before MAX_FACETS is applied, which is the difference between a priority
// and a truncation: walking board order and breaking at ten meant the tail of a
// board with more than ten unstable facets was not diagnosed later, it was never
// diagnosed. `stale` sorts first because a superseded finding is one the reader is
// actively promising to replace ("the measurements have changed, re-reading this
// facet") and nothing else was coming to keep that promise. When a full retag
// marks every facet at once the tail waits one tick and no longer, since the ten
// served stop being stale as they land; severity breaks the remaining ties.
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
    out.push(segment);
  }
  out.sort((a, b) =>
    Number(!!b.diagnostic?.stale) - Number(!!a.diagnostic?.stale) ||
    instability(b) - instability(a));
  return out.slice(0, MAX_FACETS);
}

// One pass of the loop. Walks boards from `afterBoardId` and diagnoses the first
// one with work, returning the id it stopped at so the caller can rotate past it.
//
// A rotation rather than "the first board that qualifies": nothing here creates
// claimable work, so there is no row that stops matching once it has been served.
// A board whose staleness check keeps passing would be re-picked every tick and
// every board behind it would starve — silently, and indefinitely.
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
        // costs nothing, and a diagnosis pass that broke tagging would be a serious
        // regression. One facet's failure does not end the board's pass.
        console.warn(`diagnose failed for board ${board.id} facet ${segment.key}: ${e.message}`);
      }
    }
    if (calls) return { boardId: board.id, calls };
  }
  return { boardId: visited, calls: 0 };
}
