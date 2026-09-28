// List's columns and how a field's value prints (planning/list-view-plan.md,
// Stage 3): utils.js fmtField and fmtDate, the column catalog sort.js builds
// per card mode, and the viewer's pick columns.js keeps. The menu, the table
// and the lightbox are the browser's (test/browser/list-columns.test.js).
import { localStore as store } from "./browser-stub.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaCatalog } from "../server/media/index.js";

// The two catalogs as the server sends them: the real file-field catalog, and
// a stocks-shaped domain.
const CONNECTORS = [{
  name: "stocks",
  label: "Stocks",
  fields: [
    { key: "price", kind: "number", fn: "price", label: "Price (USD)", format: "usd" },
    { key: "change_1d", kind: "number", fn: "change_1d", label: "Daily change (%)", format: "percent" },
    { key: "volume", kind: "number", fn: "volume", label: "Volume" },
    { key: "sector", kind: "text", fn: "sector", label: "Sector" },
    { key: "website", kind: "url", fn: "website", label: "Company website" },
  ],
  browse: {
    columns: [
      { key: "name", kind: "text", primary: true },
      { key: "price", kind: "usd", preview: true },
      { key: "volume", kind: "number", preview: true },
      { key: "sector", kind: "text" },
    ],
  },
}];
globalThis.fetch = (url) => {
  const u = String(url);
  const body = u.startsWith("/api/file-fields") ? mediaCatalog() : u.startsWith("/api/connectors") ? CONNECTORS : null;
  return Promise.resolve({ ok: !!body, json: async () => body });
};

const { state } = await import("../public/state.js");
const { columnCatalog, fieldFormat, sortCatalog, loadCatalogs } = await import("../public/sort.js");
const { shownColumns, restoreColumns } = await import("../public/columns.js");
const { fmtField, fmtDate, fmtSize } = await import("../public/utils.js");

const STOCKS = {
  input: { connector: "stocks" },
  fields: [
    { key: "price", kind: "number", source: "connector", fn: "price" },
    { key: "change_1d", kind: "number", source: "connector", fn: "change_1d" },
    { key: "volume", kind: "number", source: "connector", fn: "volume" },
    { key: "sector", kind: "text", source: "connector", fn: "sector" },
    { key: "website", kind: "url", source: "connector", fn: "website" },
  ],
};
const RAW_MAPPED = {
  fields: [
    { key: "duration", kind: "number", source: "file", fn: "duration" },
    { key: "year", kind: "number", source: "extract" },
  ],
};
const CARD_KEY = { card: { by: "who" }, fields: [{ key: "who", kind: "text", source: "extract" }] };
const keys = (entries) => entries.map((e) => e.by);
const item = (id, kind) => ({ id, kind, instances: [{ kind }], media: null, fields: {} });

// ─── the printer ────────────────────────────────────────────────────────────

test("a number prints by its format, and never as dollars without one", () => {
  const n = (v, format) => fmtField(v, { kind: "number", format });
  assert.equal(n(62.4, "usd"), "$62.40", "dollars show the cents, so a column lines up at the point");
  assert.equal(n(3.45e12, "usd"), "$3.45T");
  assert.equal(n(1.23, "percent"), "+1.23%");
  assert.equal(n(-0.84, "percent"), "-0.84%");
  assert.equal(n(45234567), (45234567).toLocaleString(), "a share count is a plain number");
  assert.equal(n(1), (1).toLocaleString(), "a rank of 1 is 1, not $1.00");
  assert.equal(n(3.12, "dollars"), (3.12).toLocaleString(), "a word the page doesn't know is a plain number");
  assert.equal(n(3.12, "toString"), (3.12).toLocaleString(), "…including one an object already has");
  assert.equal(n(88_400_000, "bytes"), fmtSize(88_400_000));
  assert.equal(n(74.4, "clock"), "1:14");
  assert.equal(n(3725, "clock"), "1:02:05");
  assert.equal(n(320000, "kbps"), "320 kbps");
  assert.equal(n(44100, "khz"), `${(44.1).toLocaleString()} kHz`);
  assert.equal(n(1, "channels"), "mono");
  assert.equal(n(2, "channels"), "stereo");
  assert.equal(n(12.2, "megapixels"), "12.2 MP");
});

test("what isn't a formatted number prints as it is, and nothing prints as a dash", () => {
  assert.equal(fmtField(2024, {}), "2024", "an AI answer carries no kind: its year stays a year");
  assert.equal(fmtField(2024, { kind: "text" }), "2024");
  assert.equal(fmtField("Technology", { kind: "text" }), "Technology");
  assert.equal(fmtField("12", { kind: "number", format: "usd" }), "12", "a number's kind with a string in it isn't guessed at");
  for (const v of [null, undefined, ""]) assert.equal(fmtField(v, { kind: "number" }), "—");
  assert.equal(fmtField(NaN, { kind: "number" }), "—");
});

test("a day-only date is that day west of UTC; a timestamp is the viewer's day", () => {
  const tz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    assert.equal(fmtDate("2026-09-28"), new Date(2026, 8, 28).toLocaleDateString(), "a file's date, as the file has it");
    assert.equal(fmtField("2026-09-14", { kind: "date" }), new Date(2026, 8, 14).toLocaleDateString());
    const at = Date.UTC(2026, 8, 28, 3); // 8pm the day before, in California
    assert.equal(fmtField(at, { kind: "date" }), new Date(at).toLocaleDateString());
    assert.equal(fmtDate(null), "—");
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

// ─── the column catalog ─────────────────────────────────────────────────────

test("before its catalog lands, a board offers only its own columns", () => {
  state.boardMapping = STOCKS;
  assert.deepEqual(keys(columnCatalog()), ["created", "updated"]);
});

test("a connector board's columns: its bound fields but a link, named and formatted by the domain", async () => {
  state.boardMapping = STOCKS;
  await loadCatalogs();
  const cols = columnCatalog();
  assert.deepEqual(keys(cols), ["created", "updated", "field:price", "field:change_1d", "field:volume", "field:sector"],
    "the name and hearts are the table's own; a url can't be ordered");
  const price = cols.find((c) => c.by === "field:price");
  assert.deepEqual([price.label, price.kind, price.format], ["Price (USD)", "number", "usd"]);
  assert.deepEqual(keys(cols.filter((c) => c.byDefault)), ["created", "field:price", "field:volume"],
    "it starts with Date added and the fields the domain previews");
});

test("a card-key board's columns are the board's own, Files among the defaults", () => {
  state.boardMapping = CARD_KEY;
  const cols = columnCatalog();
  assert.deepEqual(keys(cols), ["created", "updated", "instances"]);
  assert.deepEqual(keys(cols.filter((c) => c.byDefault)), ["created", "instances"]);
});

test("a file board offers every file field, whatever kinds have loaded so far", async () => {
  state.boardMapping = null;
  state.items = [item(1, "image")]; // the newest 200 can all be pictures
  await loadCatalogs();
  const cols = columnCatalog();
  for (const by of ["media:file_size", "media:width", "media:pages", "media:duration"]) {
    assert.ok(keys(cols).includes(by), `${by} is a column the board has`);
  }
  assert.ok(!keys(cols).includes("media:added"), "Added to board is Date added");
  assert.equal(cols.find((c) => c.by === "media:duration").format, "clock");
  assert.deepEqual(keys(cols.filter((c) => c.byDefault)), ["created"], "file fields start hidden (D5)");
});

// ─── the viewer's pick ──────────────────────────────────────────────────────

test("the viewer's pick is shown in catalog order; without one, the defaults", async () => {
  state.boardId = "b-cols";
  state.boardMapping = STOCKS;
  await loadCatalogs();
  store.delete("boardColumns:b-cols");
  restoreColumns();
  assert.equal(state.columns, null);
  assert.deepEqual(keys(shownColumns()), ["created", "field:price", "field:volume"]);
  store.set("boardColumns:b-cols", JSON.stringify(["field:sector", "created", "field:change_1d"]));
  restoreColumns();
  assert.deepEqual(keys(shownColumns()), ["created", "field:change_1d", "field:sector"]);
});

test("a saved column the board can't show is left out, and left in storage (D6)", async () => {
  state.boardId = "b-stale";
  state.boardMapping = STOCKS;
  await loadCatalogs();
  const saved = JSON.stringify(["field:pe_ratio", "field:price", "media:duration"]);
  store.set("boardColumns:b-stale", saved);
  restoreColumns();
  assert.deepEqual(keys(shownColumns()), ["field:price"], "an unbound field and a file field on a connector board");
  assert.equal(store.get("boardColumns:b-stale"), saved, "the stored pick is the viewer's, untouched");
});

test("a saved file column stays shown while no item of its kind has loaded", async () => {
  state.boardId = "b-late";
  state.boardMapping = null;
  state.items = [item(1, "image")];
  await loadCatalogs();
  store.set("boardColumns:b-late", JSON.stringify(["media:pages"]));
  restoreColumns();
  assert.deepEqual(keys(shownColumns()), ["media:pages"]);
});

test("a stored pick that isn't a list of keys is no pick", () => {
  state.boardId = "b-junk";
  for (const junk of ["{not json", "42", JSON.stringify({ by: "created" }), JSON.stringify([1, 2])]) {
    store.set("boardColumns:b-junk", junk);
    restoreColumns();
    assert.equal(state.columns, null, junk);
  }
});

test("the columns are the same array until the pick or the catalog changes", async () => {
  state.boardMapping = STOCKS;
  await loadCatalogs();
  state.columns = ["field:price"];
  const first = shownColumns();
  assert.equal(shownColumns(), first, "a row's props compare by it");
  state.columns = ["field:volume"];
  assert.notEqual(shownColumns(), first);
});

// ─── how a field prints in the lightbox ──────────────────────────────────────

test("a field's format is found through the mapping: a connector's, a file's, none for an AI answer", async () => {
  state.boardMapping = STOCKS;
  await loadCatalogs();
  assert.equal(fieldFormat("price"), "usd");
  assert.equal(fieldFormat("volume"), undefined);
  assert.equal(fieldFormat("nope"), undefined);
  state.boardMapping = RAW_MAPPED;
  await loadCatalogs();
  assert.equal(fieldFormat("duration"), "clock");
  assert.equal(fieldFormat("year"), undefined);
});

// ─── the Columns menu's sections ────────────────────────────────────────────

test("the menu keeps a shown column's section before an item of its kind has loaded", async () => {
  state.boardMapping = null;
  state.items = [item(1, "image"), item(2, "audio")];
  const labels = (sections) => sections.map((s) => s.label);
  assert.ok(!labels(await sortCatalog()).includes("Documents"), "no document loaded, no Documents");
  const sections = await sortCatalog({ keep: new Set(["media:pages"]) });
  const docs = sections.find((s) => s.label === "Documents");
  assert.deepEqual(keys(docs.entries), ["media:pages"], "just the kept column, so it can be turned off");
  assert.equal(docs.count, 0, "and it says it covers none yet");
});
