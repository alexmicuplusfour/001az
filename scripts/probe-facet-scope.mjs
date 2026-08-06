// Step zero of stage 2, facet-addressable tagging.
//
// THE QUESTION: does asking about one facet on its own break "pick exactly one"?
// tagging-accuracy-plan.md recorded a cached-prefix per-facet variant dropping
// single-value compliance from 97.5% to 68.8%. That variant declared all nine
// facets in the prefix and asked for one, which is a confusing ask; the scoped
// prompt this codebase now builds declares ONLY the facets it wants, which is a
// different shape and may not reproduce it. Nothing here is safe to assume —
// `single: true` is prompt-only, the schema carries no maxItems (worker.js
// buildPrompt), so nothing structurally prevents three values coming back.
//
// Usage:
//   OPENAI_KEY=sk-... node scripts/probe-facet-scope.mjs [model] [n]
//
// Reads the real board taxonomy from scripts/logos-board.json. Sends text-only
// stand-ins for the images: this measures COMPLIANCE and prompt shape, not
// tagging quality, and text keeps the run cheap. Costs roughly 3*n calls.
//
// READING IT:
//   single-value compliance   scoped vs full, on `shape`. This is the gate.
//     near 97.5% -> stage 2 is safe as built.
//     near 68.8% -> do NOT enable scoped prompts on single-pass boards. The
//                   backstop is mergeVotes' argmax, which collapses a
//                   multi-value answer on a single facet, so the fallback is
//                   gating scoped prompts on ai_votes > 1 rather than dropping
//                   the stage. Re-run with VOTES=3 to see that in action.
//   agreement                 how often scoped and full pick the same value —
//                             MEANINGLESS without the control beside it. The
//                             model disagrees with itself on a rerun of the
//                             identical prompt (~82% per-facet stability,
//                             measured), so the only readable question is
//                             whether scoping moves the answer MORE than that
//                             floor. The control arm asks the full prompt twice
//                             to measure the floor in the same run, on the same
//                             model, on the same day. Do not drop it.
//   tokens                    the actual saving, against the plan's estimate of
//                             ~30-50%, essentially all output.
import fs from "node:fs";
import { buildPrompt } from "../server/worker.js";
import { compatRequest } from "../server/ai-providers/wires/compat.js";
import { PROVIDERS } from "../server/providers.js";

const model = process.argv[2] || "gpt-5.4-mini";
const N = Number(process.argv[3] || 40);
const VOTES = Number(process.env.VOTES || 1);
const key = process.env.OPENAI_KEY;
if (!key) throw new Error("OPENAI_KEY not set");

const board = JSON.parse(fs.readFileSync("scripts/logos-board.json", "utf8"));
const SINGLE = "shape";   // the gate: `single: true`
const MULTI = "construction"; // the least stable facet measured (60% unanimous)

// Text stand-ins. Deliberately varied and a little ambiguous — a probe on nine
// identical descriptions would measure nothing.
const SUBJECTS = [
  "a wide horizontal lockup: the brand name in a heavy geometric sans, with a small circular badge to the left",
  "a monogram of two overlapping letters built from a single unbroken stroke, set in a rounded square",
  "an abstract mark of three ascending bars that fade from teal to indigo, no wordmark",
  "a hand-drawn bird rendered in one continuous line, sitting above a small serif wordmark",
  "a bold circular emblem with the company name curved around the inside edge and a star at the centre",
  "a lowercase wordmark in a thin grotesque, letters spaced widely, no symbol at all",
  "an extruded three-dimensional letterform casting a hard shadow, in two flat colours",
  "a shield-shaped badge with crossed tools inside and a banner of text beneath",
];

const facetOf = (k) => board.facets.find((f) => f.key === k);
const post = async (body) => {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
};

// One call. `facets` decides both the ask and the scoped flag.
async function ask(facets, subject, scoped) {
  const { systemText, schema } = buildPrompt(
    facets, board.context || "", true, "items", false, scoped
  );
  const body = compatRequest({
    compat: PROVIDERS.openai.compat, model, systemText, schema,
    parts: [{ kind: "text", text: `Tag this logo using the record_tags tool.\n\n${subject}` }],
  });
  const j = await post(body);
  const call = j.choices?.[0]?.message?.tool_calls?.[0];
  const args = JSON.parse(call?.function?.arguments || "{}");
  const vals = (k) => {
    const e = args[k];
    return Array.isArray(e) ? e : Array.isArray(e?.values) ? e.values : [];
  };
  return { vals, usage: j.usage || {} };
}

// N votes of the same ask, merged the way mergeVotes does for a single facet:
// argmax over the tally, ties to the earliest run. This is the backstop the
// fallback in §2.7 relies on, so the probe has to be able to exercise it.
async function askVoted(facets, subject, scoped, key_) {
  const runs = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  for (let i = 0; i < VOTES; i++) {
    const r = await ask(facets, subject, scoped);
    runs.push(r.vals(key_));
    usage.prompt_tokens += r.usage.prompt_tokens || 0;
    usage.completion_tokens += r.usage.completion_tokens || 0;
  }
  if (VOTES === 1) return { picked: runs[0], usage, rawRuns: runs };
  const count = new Map();
  for (const run of runs) for (const v of run) count.set(v, (count.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of count) if (n > bestN) { best = v; bestN = n; }
  return { picked: best === null ? [] : [best], usage, rawRuns: runs };
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

(async () => {
  console.log(`probe: ${model}, ${N} items, votes=${VOTES}`);
  console.log(`gate facet "${SINGLE}" (single:true), also sampling "${MULTI}" (multi)\n`);

  const stats = {
    scoped: { compliant: 0, n: 0, in: 0, out: 0 },
    full: { compliant: 0, n: 0, in: 0, out: 0 },
    agree: 0,        // scoped vs full
    control: 0,      // full vs full — the rerun floor to read `agree` against
    pairs: 0,
  };

  for (let i = 0; i < N; i++) {
    const subject = SUBJECTS[i % SUBJECTS.length] + (i >= SUBJECTS.length ? ` (variant ${Math.floor(i / SUBJECTS.length)})` : "");
    try {
      const s = await askVoted([facetOf(SINGLE), facetOf(MULTI)], subject, true, SINGLE);
      const f = await askVoted(board.facets, subject, false, SINGLE);
      // The control: the SAME full prompt again. Its disagreement with `f` is
      // the noise floor that makes the scoped-vs-full number readable.
      const f2 = await askVoted(board.facets, subject, false, SINGLE);

      // Compliance is measured on the RAW runs, not the merged answer — the
      // merge is the backstop, so counting it would hide exactly what we came
      // to measure.
      for (const run of s.rawRuns) { stats.scoped.n++; if (run.length === 1) stats.scoped.compliant++; }
      for (const run of f.rawRuns) { stats.full.n++; if (run.length === 1) stats.full.compliant++; }
      stats.scoped.in += s.usage.prompt_tokens; stats.scoped.out += s.usage.completion_tokens;
      stats.full.in += f.usage.prompt_tokens; stats.full.out += f.usage.completion_tokens;
      stats.pairs++;
      if (s.picked[0] && s.picked[0] === f.picked[0]) stats.agree++;
      if (f.picked[0] && f.picked[0] === f2.picked[0]) stats.control++;

      process.stdout.write(`\r${i + 1}/${N}`);
    } catch (e) {
      console.error(`\nitem ${i}: ${e.message}`);
    }
  }

  const perCall = (t, runs) => (runs ? Math.round(t / runs) : 0);
  console.log(`\n\n  single-value compliance ("${SINGLE}" returned exactly one value, raw runs)`);
  console.log(`    scoped  ${pct(stats.scoped.compliant, stats.scoped.n)}  (${stats.scoped.compliant}/${stats.scoped.n})`);
  console.log(`    full    ${pct(stats.full.compliant, stats.full.n)}  (${stats.full.compliant}/${stats.full.n})`);
  console.log(`\n  agreement on the kept "${SINGLE}" value`);
  console.log(`    scoped vs full          ${pct(stats.agree, stats.pairs)}  (${stats.agree}/${stats.pairs})`);
  console.log(`    full vs full (CONTROL)  ${pct(stats.control, stats.pairs)}  (${stats.control}/${stats.pairs})`);
  const gap = (stats.control - stats.agree) / (stats.pairs || 1);
  // Rough two-proportion standard error, printed so the gap is never read as a
  // clean effect at small N. At n=40 anything under ~17 points is inside 2 SE.
  const p1 = stats.agree / (stats.pairs || 1), p2 = stats.control / (stats.pairs || 1);
  const se = Math.sqrt((p1 * (1 - p1) + p2 * (1 - p2)) / (stats.pairs || 1));
  console.log(`    gap ${(gap * 100).toFixed(1)} pts, ~${se ? (gap / se).toFixed(1) : "?"} SE — under 2 SE is suggestive, not established`);
  console.log(`\n  tokens per call    input     output`);
  console.log(`    scoped        ${String(perCall(stats.scoped.in, stats.scoped.n)).padStart(7)}   ${String(perCall(stats.scoped.out, stats.scoped.n)).padStart(7)}`);
  console.log(`    full          ${String(perCall(stats.full.in, stats.full.n)).padStart(7)}   ${String(perCall(stats.full.out, stats.full.n)).padStart(7)}`);

  const sc = stats.scoped.compliant / (stats.scoped.n || 1);
  const fc = stats.full.compliant / (stats.full.n || 1);
  console.log(`\n  VERDICT: ${
    sc >= fc - 0.03
      ? "PASS — scoped compliance holds; stage 2 is safe as built."
      : sc < 0.85
      ? "FAIL — gate scoped prompts on ai_votes > 1 (argmax backstop) or drop stage 2. Re-run with VOTES=3."
      : "MARGINAL — compliance slipped but did not collapse; widen N before deciding."
  }`);
})();
