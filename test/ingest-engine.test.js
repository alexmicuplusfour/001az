// The pure half of ingestion: filter evaluation (every op × kind), sorting,
// the admission limit, trigger schedule math, and the folder jail. No db.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { evaluate, applyFilters, applySort, applyLimit, OPS_BY_KIND } from "../server/ingestion/filter-engine.js";
import { nextIngestRunAt, validateIngest } from "../server/ingestion/index.js";
import { resolveJailed, descriptor } from "../server/ingestion/folder.js";

const CAT = [
  { fn: "name", kind: "text", label: "Name" },
  { fn: "size", kind: "number", label: "Size" },
  { fn: "mod", kind: "date", label: "Modified" },
];
const NOW = Date.parse("2026-07-13T12:00:00");
const DAY = 86400000;

test("text ops: case-insensitive contains / equals / starts_with", () => {
  const v = { name: "Invoice_July.PDF" };
  assert.equal(evaluate(v, { fn: "name", op: "contains", value: "july" }, CAT), true);
  assert.equal(evaluate(v, { fn: "name", op: "contains", value: "august" }, CAT), false);
  assert.equal(evaluate(v, { fn: "name", op: "equals", value: "invoice_july.pdf" }, CAT), true);
  assert.equal(evaluate(v, { fn: "name", op: "starts_with", value: "INV" }, CAT), true);
  assert.equal(evaluate(v, { fn: "name", op: "starts_with", value: "july" }, CAT), false);
});

test("number ops: gte / lte / eq; non-numeric candidate fails", () => {
  assert.equal(evaluate({ size: 100 }, { fn: "size", op: "gte", value: 100 }, CAT), true);
  assert.equal(evaluate({ size: 99 }, { fn: "size", op: "gte", value: 100 }, CAT), false);
  assert.equal(evaluate({ size: 100 }, { fn: "size", op: "lte", value: 100 }, CAT), true);
  assert.equal(evaluate({ size: 101 }, { fn: "size", op: "lte", value: 100 }, CAT), false);
  assert.equal(evaluate({ size: 5 }, { fn: "size", op: "eq", value: "5" }, CAT), true);
  assert.equal(evaluate({ size: "abc" }, { fn: "size", op: "gte", value: 0 }, CAT), false);
});

test("date ops: within_days is now-relative; before/after take day boundaries", () => {
  const v = { mod: NOW - 3 * DAY };
  assert.equal(evaluate(v, { fn: "mod", op: "within_days", value: 7 }, CAT, NOW), true);
  assert.equal(evaluate(v, { fn: "mod", op: "within_days", value: 2 }, CAT, NOW), false);
  // 2026-07-10 local midnight is the boundary; mod sits at July 10, 12:00.
  assert.equal(evaluate(v, { fn: "mod", op: "before", value: "2026-07-11" }, CAT, NOW), true);
  assert.equal(evaluate(v, { fn: "mod", op: "before", value: "2026-07-10" }, CAT, NOW), false);
  assert.equal(evaluate(v, { fn: "mod", op: "after", value: "2026-07-09" }, CAT, NOW), true);
  assert.equal(evaluate(v, { fn: "mod", op: "after", value: "2026-07-10" }, CAT, NOW), false);
  assert.equal(evaluate(v, { fn: "mod", op: "before", value: "garbage" }, CAT, NOW), false);
});

test("a null/missing candidate value fails every filter; unknown fn/op fail closed", () => {
  assert.equal(evaluate({ name: null }, { fn: "name", op: "contains", value: "" }, CAT), false);
  assert.equal(evaluate({}, { fn: "size", op: "gte", value: 0 }, CAT), false);
  assert.equal(evaluate({ name: "x" }, { fn: "nope", op: "contains", value: "x" }, CAT), false);
  assert.equal(evaluate({ name: "x" }, { fn: "name", op: "gte", value: 0 }, CAT), false, "op from another kind");
});

test("applyFilters ANDs; applySort is stable with nulls last; applyLimit slices", () => {
  const rows = [
    { key: "a", values: { name: "a.txt", size: 3, mod: null } },
    { key: "b", values: { name: "b.txt", size: 1, mod: NOW } },
    { key: "c", values: { name: "c.txt", size: 2, mod: NOW - DAY } },
    { key: "d", values: { name: "d.pdf", size: 2, mod: NOW - DAY } }, // ties with c
  ];
  const txt = applyFilters(rows, [
    { fn: "name", op: "contains", value: ".txt" },
    { fn: "size", op: "lte", value: 2 },
  ], CAT);
  assert.deepEqual(txt.map((r) => r.key), ["b", "c"]);

  assert.deepEqual(applySort(rows, { by: "size", order: "asc" }, CAT).map((r) => r.key), ["b", "c", "d", "a"]);
  assert.deepEqual(applySort(rows, { by: "mod", order: "desc" }, CAT).map((r) => r.key), ["b", "c", "d", "a"], "null mod sorts last even descending");
  assert.deepEqual(applySort(rows, { by: "mod", order: "asc" }, CAT).map((r) => r.key), ["c", "d", "b", "a"], "ties keep input order (stable)");
  assert.deepEqual(applyLimit(rows, 2).length, 2);
  assert.equal(applyLimit(rows, undefined).length, 4, "no limit passes through");
});

test("nextIngestRunAt: continuous / interval / daily rollover / manual", () => {
  assert.equal(nextIngestRunAt({ mode: "continuous" }, NOW, { continuousMs: 30000 }), NOW + 30000);
  assert.equal(nextIngestRunAt({ mode: "interval", every: 90 }, NOW), NOW + 90 * 60000);
  // NOW is 12:00 local — 14:30 lands today, 09:00 rolls to tomorrow.
  assert.equal(nextIngestRunAt({ mode: "daily", at: "14:30" }, NOW), Date.parse("2026-07-13T14:30:00"));
  assert.equal(nextIngestRunAt({ mode: "daily", at: "09:00" }, NOW), Date.parse("2026-07-14T09:00:00"));
  assert.equal(nextIngestRunAt({ mode: "manual" }, NOW), null);
  assert.equal(nextIngestRunAt(undefined, NOW), null);
});

test("resolveJailed: keeps subpaths inside the root, rejects escapes", () => {
  const root = path.join(path.sep, "tmp", "root");
  assert.equal(resolveJailed(root, ""), path.resolve(root));
  assert.equal(resolveJailed(root, "sub/deeper"), path.resolve(root, "sub/deeper"));
  assert.equal(resolveJailed(root, ".."), null);
  assert.equal(resolveJailed(root, "../rootX/y"), null, "prefix collision");
  assert.equal(resolveJailed(root, path.join(path.sep, "abs")), null, "absolute path");
  assert.equal(resolveJailed(root, "sub/../../x"), null, "buried traversal");
  assert.equal(resolveJailed("", "sub"), null, "no root configured");
});

test("validateIngest: the folder descriptor's rules, one by one", () => {
  const desc = descriptor();
  const good = {
    enabled: true,
    source: { folder: "drop", recursive: true },
    filters: [{ fn: "extension", op: "equals", value: "png" }],
    sort: { by: "modified", order: "desc" },
    limit: 50,
    trigger: { mode: "continuous" },
  };
  const opts = { hasRoot: true };
  assert.equal(validateIngest(good, desc, opts), null);

  assert.match(validateIngest({ ...good, filters: [{ fn: "nope", op: "equals", value: "x" }] }, desc, opts), /unknown filter field/);
  assert.match(validateIngest({ ...good, filters: [{ fn: "name", op: "gte", value: 1 }] }, desc, opts), /not valid for text/);
  assert.match(validateIngest({ ...good, filters: [{ fn: "modified", op: "within_days", value: 0 }] }, desc, opts), /day count/);
  assert.match(validateIngest({ ...good, source: { folder: "../x" } }, desc, opts), /escapes/);
  assert.match(validateIngest(good, desc, { hasRoot: false }), /INGEST_ROOT/);
  assert.match(validateIngest({ ...good, limit: 0 }, desc, opts), /limit/);
  assert.match(validateIngest({ ...good, limit: 501 }, desc, opts), /limit/);
  assert.match(validateIngest({ ...good, sort: { by: "nope" } }, desc, opts), /unknown sort/);
  assert.match(validateIngest({ ...good, trigger: { mode: "hourly" } }, desc, opts), /trigger mode/);
  assert.match(validateIngest({ ...good, trigger: { mode: "interval" } }, desc, opts), /trigger\.every/);
  assert.match(validateIngest({ ...good, trigger: { mode: "interval", every: 50000 } }, desc, opts), /trigger\.every/);
  assert.match(validateIngest({ ...good, trigger: { mode: "daily", at: "25:00" } }, desc, opts), /HH:MM/);
  assert.equal(validateIngest({ ...good, trigger: { mode: "daily", at: "23:45" } }, desc, opts), null);
  assert.match(validateIngest(good, null, opts), /not available/);
});

test("OPS_BY_KIND is the single op source the descriptor leans on", () => {
  assert.deepEqual(Object.keys(OPS_BY_KIND).sort(), ["date", "number", "text"]);
});
