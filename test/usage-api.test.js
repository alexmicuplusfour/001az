// Stage 4a of metering-plan.md: the dimensioned usage reader and the work-kind
// vocabulary. The reader groups by any subset of the meter's dimensions over
// any day window; the response is SELF-DESCRIBING (units with labels and
// format kinds, kind/capability/board/provider names) so the client renders
// what it is handed — the detail-chart rule, now for spend.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";
import { meter, setBoardMembers } from "../server/db.js";
import { KIND_DEFS, meterAs } from "../server/capabilities.js";
import { registerProvider, unregisterProvider } from "../server/providers.js";

let srv, db, base, admin, boardA, boardB;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  registerProvider("usage-co", { label: "Usage Co", keyless: true });
  boardA = await seedBoard(db, "usage-a");
  boardB = await seedBoard(db, "usage-b");
  // Controlled numbers, straight through the mechanism: board A tags on two
  // models (one priced), board B extracts, and some app-level work meters
  // outside any board (the '' sentinel).
  await meter(db, { boardId: boardA, capability: "tag", provider: "usage-co", model: "m1" },
    { requests: 2, input_tokens: 1000 }, { input_tokens: 3, requests: 0 });
  await meter(db, { boardId: boardA, capability: "tag", provider: "usage-co", model: "m2" },
    { requests: 1, input_tokens: 500 });
  await meter(db, { boardId: boardB, capability: "extract", provider: "usage-co", model: "m1" },
    { requests: 1, output_tokens: 40 });
  await meter(db, { capability: "sweep" }, { bytes: 900 });
});
after(() => {
  unregisterProvider("usage-co");
  return srv.close();
});

test("KIND_DEFS: every kind carries a label, and links to what its legs meter", () => {
  // Deliberately NOT a literal list of ids: a copy of the table can only fail
  // when someone correctly updates the table, and stays silent when someone
  // adds a kind at a call site and forgets it — friction on the right path,
  // blind on the wrong one (test/capabilities.test.js states the same rule).
  assert.equal(new Set(KIND_DEFS.map((k) => k.id)).size, KIND_DEFS.length, "ids are unique");
  // capability ≠ kind, held in data: a retag sweep's item legs meter as tag.
  assert.equal(KIND_DEFS.find((k) => k.id === "retag").capability, "tag");
  // A kind that spends nothing says so — null, not a guessed capability.
  assert.equal(KIND_DEFS.find((k) => k.id === "ingest").capability, null);
  for (const k of KIND_DEFS) assert.ok(k.label, `${k.id} carries its display label`);
});

test("meterAs: spenders derive their capability from the table, and nothing is blocked", () => {
  // The join column is LIVE data now — metering.js maps every spend through
  // this, so the table and the meter cannot drift (the 4a open item).
  assert.equal(meterAs("retag"), "tag", "a kind's paid legs meter as what it declares");
  assert.equal(meterAs("tag"), "tag");
  // Declared-to-spend-nothing and never-heard-of both degrade to the id
  // itself: metered under their own name, visible, never refused.
  assert.equal(meterAs("ingest"), "ingest");
  assert.equal(meterAs("some-plugin-capability"), "some-plugin-capability");
});

test("usage: admin-only at the top level", async () => {
  const member = await seedUser(db, "usage-member@test.local");
  assert.equal((await req(base, "GET", "/api/usage", { sid: member.sid })).status, 403);
});

test("usage: the ungrouped read is ONE row of folded units — the headline needs no special API", async () => {
  const r = await req(base, "GET", "/api/usage", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.rows.length, 1);
  assert.deepEqual(r.json.rows[0].units, {
    // 2 priced-free requests from m1; m2 and extract metered unpriced.
    requests: { quantity: 4, priced_quantity: 2, cost_micros: 0 },
    input_tokens: { quantity: 1500, priced_quantity: 1000, cost_micros: 3000 },
    output_tokens: { quantity: 40, priced_quantity: 0, cost_micros: 0 },
    bytes: { quantity: 900, priced_quantity: 0, cost_micros: 0 },
  });
  // The vocabulary rides the response: labels + format kinds per unit present,
  // including one no registry declares (bytes → falls back to its id).
  const units = Object.fromEntries(r.json.units.map((u) => [u.unit, u]));
  assert.deepEqual(units.input_tokens,
    { unit: "input_tokens", label: "input tokens", format: "tokens", rate: { per: 1e6, label: "$/M" } });
  // …including how a PRICE for it is quoted, which is a billing fact and so
  // travels declared rather than being inferred client-side from `format`.
  assert.deepEqual(units.bytes,
    { unit: "bytes", label: "bytes", format: "count", rate: { per: 1, label: "$ ea" } },
    "an undeclared unit degrades to per-each — the only frame that needs no agreement to be true");
});

test("usage: the response says WHICH BREAKDOWNS EXIST, from the list it validates against", async () => {
  // Mechanism 3's third promise. Without it a group-by control has to hardcode
  // the dimension list — the mistake this feature already caught for
  // capabilities (Stage 0) and units (3c), one level up.
  const r = await req(base, "GET", "/api/usage", { sid: admin.sid });
  assert.deepEqual(Object.keys(r.json.dims), ["day", "board", "capability", "provider", "model"]);
  assert.equal(r.json.dims.capability.label, "Work");
  // Values only for what was actually grouped — a dimension offers itself
  // without the server enumerating every board on every call.
  assert.ok(!("values" in r.json.dims.board));
  const g = await req(base, "GET", "/api/usage?group=board", { sid: admin.sid });
  assert.ok("values" in g.json.dims.board);
  assert.equal(g.json.dims.model.label, "Model");
  assert.ok(!("values" in g.json.dims.model));
});

test("usage: grouped by board and model — rows split, and every id arrives with its label", async () => {
  const r = await req(base, "GET", "/api/usage?group=board,model", { sid: admin.sid });
  assert.equal(r.status, 200);
  const key = (row) => `${row.board}|${row.model}`;
  const rows = Object.fromEntries(r.json.rows.map((row) => [key(row), row.units]));
  assert.equal(rows[`${boardA}|m1`].input_tokens.cost_micros, 3000);
  assert.equal(rows[`${boardA}|m2`].input_tokens.quantity, 500);
  assert.equal(rows[`${boardB}|m1`].output_tokens.quantity, 40);
  assert.equal(rows["|"].bytes.quantity, 900, "app-level spend rides the '' sentinel row");
  // Board names — including OUR sentinel, named at the source.
  assert.equal(r.json.dims.board.values[boardA], "usage-a");
  assert.equal(r.json.dims.board.values[""], "outside any board");
});

test("usage: capability grouping labels from the kind vocabulary; providers from the registry", async () => {
  const r = await req(base, "GET", "/api/usage?group=capability,provider", { sid: admin.sid });
  assert.equal(r.json.dims.capability.values.tag, "Tagging");
  assert.equal(r.json.dims.capability.values.extract, "Extraction");
  assert.equal(r.json.dims.capability.values.sweep, "sweep", "an id nothing declares degrades to itself");
  assert.equal(r.json.dims.provider.values["usage-co"], "Usage Co");
  // The '' PROVIDER is a named sentinel like the '' board — the pre-meter
  // backfill and model-less spend render "unattributed", not a bare dash.
  assert.equal(r.json.dims.provider.values[""], "unattributed");
});

test("usage: an unknown group dimension is a 400, not a guess", async () => {
  const r = await req(base, "GET", "/api/usage?group=model,vibes", { sid: admin.sid });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /vibes/);
});

test("usage: the window defaults, is echoed, and reaches back when asked", async () => {
  await db.query(
    "INSERT INTO usage_meter (day, board_id, capability, provider, model, unit, quantity) VALUES ('2001-06-01', $1, 'tag', '', '', 'requests', 99)",
    [boardA]);
  // Unasked, the read is windowed — the meter keeps forever and grouping bounds
  // nothing, so an unbounded default would scan and ship all of history.
  const def = await req(base, "GET", "/api/usage", { sid: admin.sid });
  assert.equal(def.json.rows[0].units.requests.quantity, 4, "the 2001 row is outside the default window");
  assert.match(def.json.from, /^\d{4}-\d{2}-\d{2}$/, "the answer states the window it used");
  assert.equal(def.json.to, null);
  // A default, not a law: from= reaches as far back as the caller likes.
  const all = await req(base, "GET", "/api/usage?from=2000-01-01", { sid: admin.sid });
  assert.equal(all.json.rows[0].units.requests.quantity, 103);
  assert.equal(all.json.from, "2000-01-01");
  const ancient = await req(base, "GET", "/api/usage?from=2000-01-01&to=2001-12-31", { sid: admin.sid });
  assert.equal(ancient.json.rows[0].units.requests.quantity, 99);
});

test("board usage: manager-gated, and the route's scope beats any query param", async () => {
  const manager = await seedUser(db, "usage-mgr@test.local");
  const member = await seedUser(db, "usage-pleb@test.local");
  const scoped = await seedBoard(db, "usage-scoped", [manager.id, member.id]);
  await setBoardMembers(db, scoped, [manager.id, member.id], [manager.id]);
  await meter(db, { boardId: scoped, capability: "tag", provider: "usage-co", model: "m9" }, { requests: 7 });

  // A member is 403 — spend is management-visible (metering-plan.md, Decided).
  assert.equal((await req(base, "GET", `/api/boards/${scoped}/usage`, { sid: member.sid })).status, 403);

  // The manager sees THEIR board — and pointing ?board= at someone else's
  // changes nothing, because scope is the route's contract, not a parameter.
  const r = await req(base, "GET", `/api/boards/${scoped}/usage?group=board&board=${boardA}`, { sid: manager.sid });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.rows.map((row) => row.board), [scoped]);
  assert.equal(r.json.rows[0].units.requests.quantity, 7);
});

test("jobs response carries the kind vocabulary — the modal renders labels it is handed", async () => {
  const r = await req(base, "GET", `/api/boards/${boardA}/jobs`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.kinds.find((k) => k.id === "diagnose"), { id: "diagnose", label: "Facet review" });
  assert.ok(r.json.kinds.every((k) => Object.keys(k).join() === "id,label"),
    "one wire shape for the vocabulary — the join column stays server-side");
});
