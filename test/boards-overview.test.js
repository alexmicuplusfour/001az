// The boards-page aggregate (planning/boards-page-plan.md): GET
// /api/boards/overview scopes to the caller's memberships, computes the card
// facts (entity count, capability flags, manage), and builds preview stacks —
// newest file instances first, symbol tiles topping up connector boards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, seedItem, req } from "./helpers.js";
import { createBoard, createEntity, insertItem, setBoardMembers, updateBoard } from "../server/db.js";

let srv, db, base;
let admin, member, outsider;
let boardA, boardB, boardC, boardCap;
let itemA1, itemA2;

const NEXT_RUN = 1893456000000;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  member = await seedUser(db, "member@test.local");
  outsider = await seedUser(db, "outsider@test.local");

  // A: taxonomy board, member is a plain member; ingest configured but OFF.
  // Two entities, one carrying a second instance — count must read 2, not 3.
  boardA = await seedBoard(db, "A", [member.id]);
  itemA1 = await seedItem(db, boardA, "a1.png");
  itemA2 = await seedItem(db, boardA, "a2.png");
  await insertItem(
    db, boardA,
    { identity: "a1.png", files: [{ name: "a1b.png", original_name: "a1b.png", w: 10, h: 10 }], fields: {} },
    "tagged", itemA1.id
  );
  await updateBoard(db, boardA, { ingest: { enabled: false, source: { type: "folder" } } });

  // B: facet-less and empty, admin-only; ingest enabled with a scheduled run.
  boardB = await createBoard(db, "B", []);
  await updateBoard(db, boardB, {
    ingest: { enabled: true, trigger: { mode: "daily", hourUtc: 9 }, source: { type: "folder" } },
    ingestNextRunAt: NEXT_RUN,
  });

  // C: connector-mapped board, member is board-admin. Two symbol entities
  // (no files) plus one chart-faced instance on BTC — the preview mixes the
  // file entry with symbol fill.
  boardC = await createBoard(db, "C", [], "", true, null, null, {}, false, {
    mapping: { input: { connector: "crypto" }, identity: { from: "connector" }, fields: [] },
  });
  await setBoardMembers(db, boardC, [member.id], [member.id]);
  const btc = await createEntity(db, boardC, { identity: "bitcoin", displayName: "Bitcoin", symbol: "BTC" });
  await createEntity(db, boardC, { identity: "eth", symbol: "ETH" });
  await insertItem(
    db, boardC,
    { identity: "bitcoin", files: [{ name: "chart.png", original_name: "chart.png", w: 20, h: 10, kind: "image" }], fields: {} },
    "tagged", btc
  );

  // Cap: 10 single-instance entities; the stack must stop at 8.
  boardCap = await seedBoard(db, "Cap", []);
  for (let i = 0; i < 10; i++) await seedItem(db, boardCap, `cap${i}.png`);
});

after(() => srv.close());

const overview = async (sid) => req(base, "GET", "/api/boards/overview", sid ? { sid } : {});
const find = (r, id) => r.json.find((b) => b.id === id);

test("unauthenticated is denied", async () => {
  const r = await overview();
  assert.equal(r.status, 401);
});

test("outsider gets an empty list, not 404s", async () => {
  const r = await overview(outsider.sid);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, []);
});

test("member sees exactly their boards; admin sees all", async () => {
  const m = await overview(member.sid);
  assert.equal(m.status, 200);
  assert.deepEqual(new Set(m.json.map((b) => b.id)), new Set([boardA, boardC]));

  const a = await overview(admin.sid);
  assert.equal(a.status, 200);
  assert.deepEqual(
    new Set(a.json.map((b) => b.id)),
    new Set([boardA, boardB, boardC, boardCap])
  );
});

test("capability flags reflect board config", async () => {
  const r = await overview(admin.sid);

  const a = find(r, boardA);
  // facet_count carries both jobs — presence (chip shown at all) and the count
  // in its tooltip; there is deliberately no separate has_taxonomy flag.
  assert.equal(a.facet_count, 1); // the seed's single "kind" facet
  assert.equal(a.has_mapping, false);
  assert.equal(a.mapping_connector, null);
  // Ingest config present but held. The chip still shows — this row is an
  // inventory of what the board HAS — and it names the pause instead of
  // vanishing, which used to read as "no ingestion configured here".
  assert.equal(a.ingest_mode, "paused");
  assert.equal(a.ingest_next_run_at, null);

  const b = find(r, boardB);
  assert.equal(b.facet_count, 0);
  assert.equal(b.ingest_mode, "scheduled");
  assert.equal(b.ingest_next_run_at, NEXT_RUN);

  // No ingest config at all is the only no-chip case.
  assert.equal(find(r, boardC).ingest_mode, null);

  const c = find(r, boardC);
  assert.equal(c.has_mapping, true);
  assert.equal(c.mapping_connector, "crypto");
});

test("count counts gallery cards (entities), not instance rows", async () => {
  const r = await overview(admin.sid);
  assert.equal(find(r, boardA).count, 2); // 3 items rows, 2 entities
  assert.equal(find(r, boardB).count, 0);
  assert.equal(find(r, boardC).count, 2);
});

test("preview lists newest file instances in thumbnail vocabulary", async () => {
  const r = await overview(admin.sid);
  const p = find(r, boardA).preview;
  // Same-ms created_at ties break on id DESC: the late second instance of
  // entity A1 leads, then A2, then A1's original.
  assert.deepEqual(p.map((e) => e.name), ["a1b.png", "a2.png", "a1.png"]);
  for (const e of p) {
    assert.equal(e.kind, "image"); // absent kind defaults like instanceEntry
    assert.equal(e.w, 10);
  }
});

test("connector boards top up with symbol tiles; empty boards preview empty", async () => {
  const r = await overview(admin.sid);
  const p = find(r, boardC).preview;
  assert.equal(p[0].name, "chart.png"); // file entries lead
  const symbols = p.slice(1);
  assert.deepEqual(new Set(symbols.map((e) => e.symbol)), new Set(["BTC", "ETH"]));
  const eth = symbols.find((e) => e.symbol === "ETH");
  assert.equal(eth.display_name, "eth"); // identity fallback when unnamed
  const btcSym = symbols.find((e) => e.symbol === "BTC");
  assert.equal(btcSym.display_name, "Bitcoin");

  assert.deepEqual(find(r, boardB).preview, []);
});

test("preview caps at 8", async () => {
  const r = await overview(admin.sid);
  const cap = find(r, boardCap);
  assert.equal(cap.count, 10);
  assert.equal(cap.preview.length, 8);
});

test("manage mirrors board-admin and global-admin", async () => {
  const m = await overview(member.sid);
  assert.equal(find(m, boardA).manage, false); // plain member
  assert.equal(find(m, boardC).manage, true); // board-admin

  const a = await overview(admin.sid);
  for (const b of a.json) assert.equal(b.manage, true);
});
