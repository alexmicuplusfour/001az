// Board sorting (planning/board-sorting-plan.md): the full media projection
// (projectEntry), the list payload's new created_at/updated_at/media fields in
// all three listItems modes, and the client sort module — catalog assembly per
// identity mode, the comparator's nulls-last stable semantics, and per-board
// persistence/restore with connector defaultSort seeding.
import { localStore as store } from "./browser-stub.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard, seedItem, adminSession } from "./helpers.js";
import { projectEntry } from "../server/media/index.js";
import { listItems, createEntity, insertItem } from "../server/db.js";

// ─── stubs for the client module ─────────────────────────────────────────────
// sort.js touches localStorage, document.dispatchEvent, and fetches the two
// static catalogs. The fetch stub serves fixtures for the catalog paths only
// and delegates everything else (helpers' HTTP requests) to the real fetch.
// The SHARED stub, not a local copy — browser-stub's own header predicted
// exactly this: a second copy drifts the day a client module reaches for a
// method it lacks (data.js now imports toast.js, which builds its container
// at module scope), and the failure reads as a bug in the module under test.

const MEDIA_FIELDS = [
  { key: "file_size", fn: "file_size", kind: "number", label: "File size", group: "All files", appliesTo: "*" },
  { key: "added", fn: "added", kind: "date", label: "Added to board", group: "All files", appliesTo: "*" },
  { key: "width", fn: "width", kind: "number", label: "Width (px)", group: "Images", appliesTo: "image" },
  { key: "duration", fn: "duration", kind: "number", label: "Duration", group: "Audio", appliesTo: ["audio"] },
  { key: "pages", fn: "pages", kind: "number", label: "Pages", group: "Documents", appliesTo: ["pdf", "docx", "text"] },
];
const CONNECTORS = [{
  name: "crypto",
  label: "Crypto",
  fields: [
    { key: "price", kind: "number", fn: "price", label: "Price (USD)" },
    { key: "market_cap", kind: "number", fn: "market_cap", label: "Market cap (USD)" },
    { key: "url", kind: "url", fn: "url", label: "Market page" },
  ],
  browse: { defaultSort: "market_cap" },
}];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith("/api/file-fields") || u.startsWith("/api/connectors")) {
    return Promise.resolve({ ok: true, json: async () => (u.includes("file-fields") ? MEDIA_FIELDS : CONNECTORS) });
  }
  return realFetch(url, opts);
};

const { state } = await import("../public/state.js");
const { sortCatalog, sortValue, applyBoardSort, restoreSort, defaultDir } = await import("../public/sort.js");

let srv, db, admin;
before(async () => {
  srv = await startServer();
  ({ db } = srv);
  admin = await adminSession(db);
});
after(() => srv.close());

// ─── projectEntry: the full projection ──────────────────────────────────────

test("projectEntry: universal + applicable kind module, flat by fn", () => {
  const out = projectEntry({
    name: "a.webp", original_name: "photo.PNG", kind: "image", size: 12345,
    meta: { width: 1920, height: 1080, format: "png" },
    addedAt: 1_720_000_000_000, modifiedAt: null, createdAt: null,
  });
  assert.equal(out.file_size, 12345);
  assert.equal(out.file_type, "image");
  assert.equal(out.extension, "png");
  assert.equal(out.width, 1920);
  assert.equal(out.aspect_ratio, "16:9");
  assert.equal(out.pages, undefined, "non-applicable modules stay out of the bag");
});

test("projectEntry: audio entry carries audio fields, image fields absent", () => {
  const out = projectEntry({
    name: "t.mp3", original_name: "t.mp3", kind: "audio", size: 900,
    meta: { duration: 61.5, bitrate: 192, codec: "mp3" },
  });
  assert.equal(out.duration, 61.5);
  assert.equal(out.codec, "mp3");
  assert.equal(out.width, undefined);
});

// ─── listItems: the payload additions, all three modes ──────────────────────

test("listItems ships created_at/updated_at/media in full, page and delta modes", async () => {
  const boardId = await seedBoard(db, "sort-payload");
  await seedItem(db, boardId);
  for (const opts of [{}, { limit: 5 }, { since: 0 }]) {
    const { items } = await listItems(db, admin.id, boardId, opts);
    assert.equal(items.length, 1, JSON.stringify(opts));
    const it = items[0];
    assert.equal(typeof it.created_at, "number");
    assert.equal(typeof it.updated_at, "number");
    assert.equal(it.media?.file_type, "image", "face file projected");
    assert.equal(it.media?.extension, "png");
  }
});

test("listItems: connector entity (no files) has media null", async () => {
  const boardId = await seedBoard(db, "sort-connector");
  const id = await createEntity(db, boardId, { identity: "bitcoin" });
  await insertItem(db, boardId, { identity: "bitcoin", files: [], fields: {} }, "tagged", id);
  const { items } = await listItems(db, admin.id, boardId);
  assert.equal(items[0].kind, "connector");
  assert.equal(items[0].media, null);
});

test("listItems: media follows the face instance, not the first one", async () => {
  const boardId = await seedBoard(db, "sort-face");
  const id = await createEntity(db, boardId, { identity: "maya chen" });
  const file = (n, size) => ({ identity: n, files: [{ name: n, original_name: n, kind: "image", size, w: 10, h: 10 }], fields: {} });
  await insertItem(db, boardId, file("old.png", 111), "tagged", id);
  await insertItem(db, boardId, file("new.png", 222), "tagged", id);
  await db.query("UPDATE boards SET mapping=$1 WHERE id=$2", [{ identity: { source: "extract" }, face: { source: "file", pick: "latest" } }, boardId]);
  const { items } = await listItems(db, admin.id, boardId);
  assert.equal(items[0].name, "new.png");
  assert.equal(items[0].media.file_size, 222, "the projected bag is the face file's");
});

// ─── sortValue + comparator ─────────────────────────────────────────────────

const entity = (id, over = {}) => ({
  id, displayLabel: `e${id}`, created_at: id, updated_at: id, hearts: 0,
  fields: {}, media: null, instances: [{ kind: "image" }], kind: "image", ...over,
});

test("sortValue: namespaced keys read the right slot", () => {
  const it = entity(1, {
    hearts: 7,
    media: { duration: 61.5 },
    fields: { price: { v: 42000, src: "coingecko" } },
    instances: [{ kind: "pdf" }, { kind: "pdf" }],
  });
  assert.equal(sortValue(it, "hearts"), 7);
  assert.equal(sortValue(it, "media:duration"), 61.5);
  assert.equal(sortValue(it, "field:price"), 42000);
  assert.equal(sortValue(it, "instances"), 2);
  assert.equal(sortValue(it, "media:pages"), null, "missing media fn is null");
  assert.equal(sortValue(it, "field:nope"), null);
});

test("applyBoardSort: null sort preserves order; numbers sort with nulls last both ways", () => {
  const mk = () => [
    entity(1, { media: { duration: 5 } }),
    entity(2, { media: null }),          // a doc on a mixed board — no duration
    entity(3, { media: { duration: 30 } }),
    entity(4, { media: { duration: null } }),
  ];
  state.sort = null;
  assert.deepEqual(applyBoardSort(mk()).map((e) => e.id), [1, 2, 3, 4]);

  state.sort = { by: "media:duration", dir: "desc" };
  assert.deepEqual(applyBoardSort(mk()).map((e) => e.id), [3, 1, 2, 4], "desc, null tail keeps incoming order");
  state.sort = { by: "media:duration", dir: "asc" };
  assert.deepEqual(applyBoardSort(mk()).map((e) => e.id), [1, 3, 2, 4], "asc flips values, nulls still last");
});

test("applyBoardSort: text compares locale-aware, ISO date strings sort chronologically", () => {
  const list = [
    entity(1, { displayLabel: "beta", media: { modified: "2026-03-01" } }),
    entity(2, { displayLabel: "Alpha", media: { modified: "2025-12-31" } }),
  ];
  state.sort = { by: "name", dir: "asc" };
  assert.deepEqual(applyBoardSort([...list]).map((e) => e.id), [2, 1]);
  state.sort = { by: "media:modified", dir: "desc" };
  assert.deepEqual(applyBoardSort([...list]).map((e) => e.id), [1, 2]);
});

// ─── sortCatalog per identity mode ──────────────────────────────────────────

test("catalog: derived board offers universal only, plus Files", async () => {
  state.boardMapping = { identity: { source: "extract" } };
  state.items = [];
  const sections = await sortCatalog();
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0].entries.map((e) => e.by), ["name", "created", "updated", "hearts", "instances"]);
});

test("catalog: connector board offers bound fields minus url, labels from the manifest", async () => {
  state.boardMapping = {
    input: { connector: "crypto" },
    identity: { source: "connector" },
    fields: [
      { key: "price", kind: "number", source: "connector", fn: "price" },
      { key: "market_cap", kind: "number", source: "connector", fn: "market_cap" },
      { key: "url", kind: "url", source: "connector", fn: "url" },
    ],
  };
  const sections = await sortCatalog();
  assert.equal(sections.length, 2);
  assert.equal(sections[0].entries.some((e) => e.by === "instances"), false, "Files entry is derived-only");
  assert.equal(sections[1].label, "Crypto");
  assert.deepEqual(sections[1].entries.map((e) => e.by), ["field:price", "field:market_cap"]);
  assert.equal(sections[1].entries[1].label, "Market cap (USD)");
});

test("catalog: raw mixed board unions media sections by kinds present, counts scoped ones", async () => {
  state.boardMapping = null;
  state.items = [
    entity(1, { kind: "image", instances: [{ kind: "image" }] }),
    entity(2, { kind: "image", instances: [{ kind: "image" }] }),
    entity(3, { kind: "audio", instances: [{ kind: "audio" }] }),
  ];
  const sections = await sortCatalog();
  assert.deepEqual(sections.map((s) => s.label), ["Board", "All files", "Images", "Audio"], "no Documents — none present");
  const all = sections.find((s) => s.label === "All files");
  assert.equal(all.entries.some((e) => e.by === "media:added"), false, "added duplicates Date added");
  assert.equal(all.count, null, "universal section is never partial");
  assert.equal(sections.find((s) => s.label === "Images").count, 2);
  assert.equal(sections.find((s) => s.label === "Audio").count, 1);
});

test("catalog: single-kind board carries no coverage counts", async () => {
  state.boardMapping = null;
  state.items = [entity(1, { kind: "audio", instances: [{ kind: "audio" }] })];
  const sections = await sortCatalog();
  assert.deepEqual(sections.map((s) => s.label), ["Board", "All files", "Audio"]);
  assert.equal(sections.find((s) => s.label === "Audio").count, null);
});

// ─── persistence: restore validation + connector seeding ────────────────────

test("restoreSort: a stored sort that no longer fits the identity mode is dropped", () => {
  state.boardId = "b-restore";
  state.boardMapping = { identity: { source: "extract" } };
  localStorage.setItem("boardSort:b-restore", JSON.stringify({ by: "media:duration", dir: "desc", label: "Duration" }));
  restoreSort();
  assert.equal(state.sort, null);

  localStorage.setItem("boardSort:b-restore", JSON.stringify({ by: "instances", dir: "desc", label: "Files" }));
  restoreSort();
  assert.equal(state.sort?.by, "instances", "universal + derived-only entry survives on an ai board");

  localStorage.setItem("boardSort:b-restore", "{not json");
  restoreSort();
  assert.equal(state.sort, null, "corrupted entry falls back silently");
});

test("restoreSort: unbound connector field is dropped, bound one survives", () => {
  state.boardId = "b-conn";
  state.boardMapping = {
    input: { connector: "crypto" },
    identity: { source: "connector" },
    fields: [{ key: "price", kind: "number", source: "connector", fn: "price" }],
  };
  localStorage.setItem("boardSort:b-conn", JSON.stringify({ by: "field:market_cap", dir: "desc", label: "Market cap" }));
  restoreSort();
  assert.notEqual(state.sort?.by, "field:market_cap", "unbound key rejected");

  localStorage.setItem("boardSort:b-conn", JSON.stringify({ by: "field:price", dir: "asc", label: "Price (USD)" }));
  restoreSort();
  assert.deepEqual(state.sort, { by: "field:price", dir: "asc", label: "Price (USD)" });
});

test("restoreSort: a fresh connector board seeds from browse defaultSort when bound", async () => {
  state.boardId = "b-seed";
  state.boardMapping = {
    input: { connector: "crypto" },
    identity: { source: "connector" },
    fields: [{ key: "market_cap", kind: "number", source: "connector", fn: "market_cap" }],
  };
  localStorage.removeItem("boardSort:b-seed");
  restoreSort();
  assert.equal(state.sort, null, "sync part leaves the default");
  await new Promise((r) => setImmediate(r)); // let the cached catalog promise land
  assert.deepEqual(state.sort, { by: "field:market_cap", dir: "desc", label: "Market cap (USD)" });

  // Same board without the binding: no seed — the value wouldn't exist.
  state.boardMapping.fields = [];
  state.sort = null;
  restoreSort();
  await new Promise((r) => setImmediate(r));
  assert.equal(state.sort, null);
});

test("reconcile: delta backfills created_at (session uploads) and follows media", async () => {
  const { reconcile } = await import("../public/data.js");
  const { toItem } = await import("../public/utils.js");
  // An upload-row item from an old server: no timestamps, no media.
  state.items = [toItem({ id: 9, name: "x.png", status: "tagged", tags: [], kind: "image" })];
  assert.equal(state.items[0].created_at, null);
  reconcile(
    [{ id: 9, name: "x.png", status: "tagged", tags: [], created_at: 111, updated_at: 222, media: { file_size: 5 } }],
    new Set([9])
  );
  assert.equal(state.items[0].created_at, 111, "delta trues up the entity stamp");
  assert.equal(state.items[0].updated_at, 222);
  assert.equal(state.items[0].media.file_size, 5, "a re-extract/face swap moves the bag");
});

test("defaultDir: text ascends, everything else descends", () => {
  assert.equal(defaultDir("text"), "asc");
  assert.equal(defaultDir("number"), "desc");
  assert.equal(defaultDir("date"), "desc");
});
