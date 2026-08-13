// The label pluralizer (public/utils.js). It exists because the browse
// modal's "all" option is built from a name the client didn't write — a
// filter label that now comes from a provider's vocabulary — so bare +"s"
// shipped "All categorys" and "All industrys" the moment the filter set grew
// past Sector and Exchange.
import { test } from "node:test";
import assert from "node:assert/strict";

const { plural } = await import("../public/utils.js");

test("plural: consonant + y takes -ies, sibilants take -es, the rest take -s", () => {
  // The two filters that broke, and the two that had been hiding it.
  assert.equal(plural("category"), "categories");
  assert.equal(plural("industry"), "industries");
  assert.equal(plural("sector"), "sectors");
  assert.equal(plural("exchange"), "exchanges");

  // A VOWEL before the y keeps it: "days", never "daies".
  assert.equal(plural("day"), "days");
  assert.equal(plural("currency"), "currencies");

  // Sibilant endings, the -es family.
  for (const [one, many] of [
    ["class", "classes"], ["index", "indexes"], ["match", "matches"], ["dish", "dishes"],
  ]) assert.equal(plural(one), many);

  // Case is the caller's business — the transform never restyles the word.
  assert.equal(plural("Category"), "Categories");

  // Nothing in, nothing out: a filter with no label must not render "undefineds".
  assert.equal(plural(""), "");
  assert.equal(plural(undefined), "");
  assert.equal(plural(null), "");
});
