// A golden snapshot of the UNSCOPED tagging prompt.
//
// Why this exists: every other systemText assertion in the suite is a regex
// fragment match (`assert.match(systemText, /description of the item as a whole/)`),
// so a refactor of buildPrompt could reword or drop a whole sentence of the
// prompt for every board and stay green. On a codebase whose recent history is
// measuring 4-point accuracy effects from prompt wording, that is not a safety
// net. This is.
//
// It is deliberately NOT a test of what the prompt should say — it is a test
// that it did not change by accident. If you meant to change it, re-record with:
//
//   node --test test/prompt-snapshot.test.js   (read the diff it prints)
//   UPDATE_PROMPT_SNAPSHOT=1 node --test test/prompt-snapshot.test.js
//
// and put the diff in the commit message, because it changes how every board
// is tagged.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../server/worker.js";

const SNAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "prompt-snapshot.json");

// Fixed inputs: a single-value facet with a gloss, a multi-value one without,
// a board context, and a non-default subject — enough to exercise every branch
// that composes systemText.
const FACETS = [
  { key: "shape", label: "Shape", single: true, values: ["round", "wide"], description: "the outline" },
  { key: "motif", label: "Motif", values: ["star", "leaf"] },
];

const capture = () => {
  const out = {};
  for (const mode of ["reasoning-on", "reasoning-off"]) {
    for (const research of [false, true]) {
      const p = buildPrompt(FACETS, "Only blue things.", mode === "reasoning-on", "widgets", research);
      out[mode + (research ? "+research" : "")] = { systemText: p.systemText, schema: p.schema };
    }
  }
  return out;
};

test("the unscoped tagging prompt has not changed", () => {
  const actual = capture();
  if (process.env.UPDATE_PROMPT_SNAPSHOT === "1") {
    fs.writeFileSync(SNAP, JSON.stringify(actual, null, 2).replace(/\r\n/g, "\n") + "\n");
    return;
  }
  const expected = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  for (const key of Object.keys(expected)) {
    assert.equal(actual[key].systemText, expected[key].systemText, `systemText drifted for ${key}`);
    assert.deepEqual(actual[key].schema, expected[key].schema, `schema drifted for ${key}`);
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
});
