// The shared k-means core (cluster-core.js) — the pure pieces both flavors
// lean on: the level→k mapping, the capped floor (3% of a big board was
// measured executing a real 29-member cluster), and the gibberish handles
// (deterministic, format-stable, collision-rolling).
import { test } from "node:test";
import assert from "node:assert/strict";
import { kFor, floorFor, handleFor, LEVEL_MAX, K, K_STEP } from "../public/cluster-core.js";

test("kFor: levels buy centers, boards cap them", () => {
  assert.equal(kFor(1, 1000), K);
  assert.equal(kFor(2, 1000), K + K_STEP);
  assert.equal(kFor(LEVEL_MAX, 1000), K + K_STEP * (LEVEL_MAX - 1));
  assert.equal(kFor(1, 5), 5, "never more centers than rows");
});

test("floorFor: 3% of the board, but never below MIN_GROUP nor above the cap", () => {
  assert.equal(floorFor(100), 8, "small boards floor at MIN_GROUP");
  assert.equal(floorFor(500), 15);
  assert.equal(floorFor(2000), 30, "the cap — uncapped 3% (=60 here) executes real structure");
});

test("handleFor: deterministic, pronounceable, and collisions roll to distinct", () => {
  const a = handleFor("TMUS");
  assert.equal(handleFor("TMUS"), a, "same string, same handle, forever");
  assert.match(a, /^[bdgklmnprstvz][aeiou][bdgklmnprstvz][aeiou][bdgklmnprstvz]$/);
  const taken = new Set();
  assert.equal(handleFor("TMUS", taken), a, "first ask claims the handle...");
  const b = handleFor("TMUS", taken);
  assert.notEqual(b, a, "...so the second rolls to a fresh one (self-registered, no caller bookkeeping)");
  assert.match(b, /^[bdgklmnprstvz][aeiou][bdgklmnprstvz][aeiou][bdgklmnprstvz]$/);
  assert.notEqual(handleFor("VOD"), handleFor("CHT"), "distinct strings, distinct handles (here)");
});
