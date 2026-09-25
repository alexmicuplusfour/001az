// PLUGIN.md against the code (planning/plugin-contract-plan.md, Stage 5).
// Every list the doc prints that the code also holds as a list — the kinds, ctx,
// the capabilities, the optional provider methods, the connection field types,
// the column kinds, the reserved domains, the built-in domains' fields and
// browse tables — is read out of the doc and compared with the code's own. A
// new ctx member, capability or field fails here until the doc says it, which
// is what naming a test in the doc never did.
//
// The tables sit under `<!-- pin: name -->` markers: HTML comments, so a reader
// of the rendered doc never sees them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { KINDS, PROVIDER_METHODS, CONNECTION_FIELD_TYPES, RESERVED_DOMAINS } from "../server/plugin-loader.js";
import { makeCtx } from "../server/plugin-ctx.js";
import { CAPABILITY, CAPABILITY_IDS } from "../server/capabilities.js";
import { FILTER_KIND } from "../server/ingestion/connector.js";
import { getConnector } from "../server/connectors/index.js";

const DOC = fs.readFileSync(new URL("../PLUGIN.md", import.meta.url), "utf8");

// The body rows of the table under `<!-- pin: name -->`, as trimmed cells.
function pinned(name) {
  const lines = DOC.split(/\r?\n/);
  const at = lines.indexOf(`<!-- pin: ${name} -->`);
  assert.ok(at >= 0, `PLUGIN.md has no "${name}" table`);
  const rows = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("|")) {
      if (rows.length) break;
      continue;
    }
    rows.push(line.slice(1, -1).split("|").map((c) => c.trim()));
  }
  return rows.slice(2); // the header and its rule
}
// The name a cell leads with: `fetchJson(url, options)` → fetchJson.
const nameIn = (cell) => /^`([A-Za-z_$][\w$-]*)/.exec(cell)?.[1] ?? null;
// Every backticked token in a cell.
const codes = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
// Every "`key` (kind)" pair in a cell, as "key (kind)".
const typed = (cell) => [...cell.matchAll(/`([^`]+)` \((\w+)\)/g)].map((m) => `${m[1]} (${m[2]})`);
const sorted = (xs) => [...xs].sort();

test("the kinds", () => {
  assert.deepEqual(pinned("kinds").map((r) => nameIn(r[0])), [...KINDS]);
});

test("ctx: every member, in order", () => {
  assert.deepEqual(pinned("ctx").map((r) => nameIn(r[0])), Object.keys(makeCtx({ id: "doc.test" })));
});

test("the chart helpers ctx.series carries", () => {
  const { series } = makeCtx({ id: "doc.test" });
  assert.deepEqual(sorted(pinned("series").map((r) => nameIn(r[0]))), sorted(Object.keys(series)));
});

test("the capabilities a provider declares, and the wire method each needs", () => {
  assert.deepEqual(
    pinned("capabilities").map((r) => [nameIn(r[0]), nameIn(r[2])]),
    CAPABILITY_IDS.map((id) => [id, CAPABILITY[id].verb]),
  );
});

test("a connector provider's methods: the optional ones are the runtime's, the rest required", () => {
  const rows = pinned("provider-methods");
  const optional = rows.filter((r) => r[1] === "no").map((r) => nameIn(r[0]));
  assert.deepEqual(sorted(optional), sorted(PROVIDER_METHODS));
  // What the loader requires beyond the optional set (validateConnectorProvider).
  assert.deepEqual(sorted(rows.filter((r) => r[1] === "yes").map((r) => nameIn(r[0]))), ["fetchEntity", "search"]);
  assert.equal(rows.length, PROVIDER_METHODS.length + 2, "every row is one or the other");
});

test("a source connection's field types", () => {
  assert.deepEqual(pinned("connection-field-types").map((r) => nameIn(r[0])), CONNECTION_FIELD_TYPES);
});

test("a browse column's kinds", () => {
  assert.deepEqual(pinned("column-kinds").map((r) => nameIn(r[0])), Object.keys(FILTER_KIND));
});

test("the reserved domain names", () => {
  assert.deepEqual(sorted(pinned("reserved-domains").map((r) => nameIn(r[0]))), sorted(RESERVED_DOMAINS));
});

for (const domain of ["crypto", "stocks"]) {
  test(`${domain}: the fields a provider fills`, () => {
    assert.deepEqual(
      pinned(`fields ${domain}`).map(([fn, kind, label]) => [nameIn(fn), kind, label]),
      getConnector(domain).manifest.fields.map((f) => [f.fn, f.kind, f.label]),
    );
  });

  test(`${domain}: what list, history and chart are asked for`, () => {
    const m = getConnector(domain).manifest;
    const cells = Object.fromEntries(pinned(`browse ${domain}`).map((r) => [r[0].replaceAll("`", ""), r[1]]));
    const row = Object.fromEntries(Object.entries(cells).map(([k, cell]) => [k, codes(cell)]));
    // The kind beside each key too: it says whether `list` answers a number or
    // a string there.
    assert.deepEqual(typed(cells["list values"]), m.browse.columns.map((c) => `${c.key} (${c.kind})`));
    assert.deepEqual(row.sorts, m.browse.sorts.map((s) => s.key));
    assert.deepEqual(row.filters, m.browse.filters.map((f) => f.key));
    assert.deepEqual(row["history periods"], m.faces[0].periods);
    assert.deepEqual(row["chart ranges"], m.chart.ranges);
    assert.deepEqual(row["chart kinds"], m.chart.kinds);
    assert.deepEqual(row["chart default range"], [m.chart.defaultRange]);
  });
}
