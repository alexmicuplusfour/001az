// The folder adapter against a real tmp tree + db: enumerate's skip rules
// (extension allowlist, recursion, dotfiles, settle window, size cap), admit's
// birth-path reuse (status matrix, date stamps, file-field projection), the
// dedup ledger (a rescan admits nothing; a deleted entity stays deleted), and
// the one-directional invariant (the source file is never touched).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, seedBoard } from "./helpers.js";
import { enumerate, admit } from "../server/ingestion/folder.js";
import { applyFilters } from "../server/ingestion/filter-engine.js";
import { descriptor } from "../server/ingestion/folder.js";
import { getBoard, updateBoard, ingestedKeys, deleteEntity, setPluginState } from "../server/db.js";
import { createSources } from "../server/sources/index.js";

let srv, db, sources, root;
const OLD = Date.now() - 120000; // safely past the settle window

function put(rel, content = "hello world", mtime = OLD) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  fs.utimesSync(p, new Date(mtime), new Date(mtime));
  return p;
}

before(async () => {
  srv = await startServer();
  db = srv.db;
  sources = createSources({ galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
  root = fs.mkdtempSync(path.join(srv.galleryDir, "..", "ingest-root-"));
  process.env.INGEST_ROOT = root;
});
after(async () => {
  delete process.env.INGEST_ROOT;
  sources.close?.();
  await srv.close();
});

// A board whose ingest config points at `folder` — admit reads it from the row.
async function boardWatching(name, folder, patch = {}) {
  const id = await seedBoard(db, name);
  await updateBoard(db, id, {
    ingest: { enabled: true, source: { folder, recursive: true }, trigger: { mode: "manual" } },
    ...patch,
  });
  return getBoard(db, id);
}

test("enumerate: allowlist, dotfiles, recursion, settle window, size cap", async () => {
  put("scan/a.txt");
  put("scan/b.PDF");
  put("scan/.hidden.txt");
  put("scan/x.exe");
  put("scan/sub/c.md");
  put("scan/fresh.txt", "still copying", Date.now()); // inside the settle window
  put("scan/big.txt", "x".repeat(10 * 1024 * 1024 + 1)); // over the 10MB backstop

  const board = await boardWatching("scan", "scan");
  const { candidates } = await enumerate(db, board, board.ingest);
  assert.deepEqual(candidates.map((c) => c.key).sort(), ["a.txt", "b.PDF", "sub/c.md"]);

  const a = candidates.find((c) => c.key === "a.txt");
  assert.equal(a.label, "a.txt");
  assert.equal(a.values.extension, "txt");
  assert.equal(a.values.file_size, "hello world".length);
  // Some filesystems round utimes to whole seconds.
  assert.ok(Math.abs(a.values.modified - OLD) < 1000);
  assert.ok(a.values.created === null || a.values.created > 0);

  // Recursion off drops the subfolder file.
  const flat = await enumerate(db, board, { ...board.ingest, source: { folder: "scan", recursive: false } });
  assert.deepEqual(flat.candidates.map((c) => c.key).sort(), ["a.txt", "b.PDF"]);

  // The walk stops at `limit` and says so.
  const bounded = await enumerate(db, board, board.ingest, { limit: 1 });
  assert.equal(bounded.candidates.length, 1);
  assert.equal(bounded.truncated, true);
});

test("enumerate: values feed the shared filter engine", async () => {
  const board = await boardWatching("scan2", "scan");
  const { candidates } = await enumerate(db, board, board.ingest);
  const cat = descriptor().filters;
  const txt = applyFilters(candidates, [{ fn: "extension", op: "equals", value: "txt" }], cat);
  assert.deepEqual(txt.map((c) => c.key), ["a.txt"]);
  const pdf = applyFilters(candidates, [{ fn: "name", op: "starts_with", value: "b." }], cat);
  assert.deepEqual(pdf.map((c) => c.key), ["b.PDF"]);
});

test("enumerate: the size cap is per TYPE, not a flat limit", async () => {
  // Same-size txt and pdf; lower ONLY the text limit under their size, so the
  // txt is dropped during the walk while the pdf (default 10 MB) is kept —
  // proving the gate resolves the limit per file type, not from a flat cap.
  put("kap/small.txt", "z".repeat(2000));
  put("kap/small.pdf", "%PDF-" + "z".repeat(2000));
  await setPluginState(db, "media:text", { config: { maxBytes: 1000 } });
  try {
    const board = await boardWatching("kap", "kap");
    const keys = (await enumerate(db, board, board.ingest)).candidates.map((c) => c.key).sort();
    assert.ok(keys.includes("small.pdf"), "pdf under its default limit is kept");
    assert.ok(!keys.includes("small.txt"), "txt over the lowered text limit is dropped");
  } finally {
    await setPluginState(db, "media:text", { config: {} });
  }
});

test("admit: birth statuses match the upload door (unmapped→pending, mapped+park, held)", async () => {
  put("st/one.txt");

  // Unmapped + auto_tag on → pending.
  const plain = await boardWatching("st-plain", "st");
  const { candidates } = await enumerate(db, plain, plain.ingest);
  const cand = candidates.find((c) => c.key === "one.txt");
  const r1 = await admit(db, plain, cand, { sources });
  const { rows: [i1] } = await db.query("SELECT status, payload FROM items WHERE id=$1", [r1.itemId]);
  assert.equal(i1.status, "pending");
  assert.ok(Math.abs(i1.payload.files[0].modifiedAt - OLD) < 1000, "source mtime stamped as modifiedAt");
  assert.ok(i1.payload.files[0].addedAt > 0);

  // AI mapping + auto_tag off → pending_extract, parked.
  const mapped = await boardWatching("st-mapped", "st", {
    mapping: { identity: { source: "extract", instruction: "x" }, fields: [] },
    autoTag: false,
  });
  const r2 = await admit(db, mapped, cand, { sources });
  const { rows: [i2] } = await db.query("SELECT status, payload FROM items WHERE id=$1", [r2.itemId]);
  assert.equal(i2.status, "pending_extract");
  assert.equal(i2.payload.park, true);

  // Unmapped + auto_tag off → held.
  const off = await boardWatching("st-off", "st", { autoTag: false });
  const r3 = await admit(db, off, cand, { sources });
  const { rows: [i3] } = await db.query("SELECT status FROM items WHERE id=$1", [r3.itemId]);
  assert.equal(i3.status, "held");

  // One-directional: the watched file is still exactly where it was.
  assert.ok(fs.existsSync(path.join(root, "st", "one.txt")));
});

test("admit: folder ingestion fills the `created` file field browsers can't", async () => {
  put("cf/doc.txt", "some words here");
  const board = await boardWatching("cf", "cf", {
    mapping: {
      fields: [
        { key: "created", kind: "date", source: "file", fn: "created" },
        { key: "modified", kind: "date", source: "file", fn: "modified" },
      ],
    },
  });
  const { candidates } = await enumerate(db, board, board.ingest);
  const r = await admit(db, board, candidates[0], { sources });
  const { rows: [item] } = await db.query("SELECT payload FROM items WHERE id=$1", [r.itemId]);
  assert.ok(item.payload.fields.modified.v, "modified projected from the source file's mtime");
  // birthtime exists on NTFS/APFS; degrade-to-null is legal elsewhere.
  assert.notEqual(item.payload.fields.created.v, undefined);
  const entry = item.payload.files[0];
  assert.equal(entry.modifiedAt, candidates[0].values.modified);
  assert.equal(entry.createdAt, candidates[0].values.created ?? null);
});

test("ledger: an admitted key never re-admits — even after the entity is deleted", async () => {
  put("led/keep.txt");
  const board = await boardWatching("led", "led");
  const { candidates } = await enumerate(db, board, board.ingest);
  const r = await admit(db, board, candidates[0], { sources });

  const known = await ingestedKeys(db, board.id);
  assert.ok(known.has("keep.txt"), "admit ledgered its key in the same tx");

  // Fresh scan → dedup against the ledger leaves nothing.
  const again = await enumerate(db, board, board.ingest);
  const fresh = again.candidates.filter((c) => !known.has(c.key));
  assert.equal(fresh.length, 0);

  // User deletes the entity: the ledger row survives — no resurrection.
  await deleteEntity(db, r.entityId);
  const after = await ingestedKeys(db, board.id);
  assert.ok(after.has("keep.txt"), "deletion is a user judgment the feed must not overturn");
});

test("admit: undecodable bytes throw err.skip and roll the tx back clean", async () => {
  put("bad/fake.png", "not a png at all");
  const board = await boardWatching("bad", "bad");
  const { candidates } = await enumerate(db, board, board.ingest);
  await assert.rejects(admit(db, board, candidates[0], { sources }), (err) => err.skip === true);
  // Rolled back: no ledger row (the sweep ledgers skips itself), no item.
  const known = await ingestedKeys(db, board.id);
  assert.ok(!known.has("fake.png"));
  const { rows } = await db.query("SELECT COUNT(*)::int AS c FROM items WHERE board_id=$1", [board.id]);
  assert.equal(rows[0].c, 0);
});

test("a missing configured folder throws friendly and tagged — no server paths", async () => {
  const board = await boardWatching("gone", "renamed-away");
  await assert.rejects(enumerate(db, board, board.ingest), (err) => {
    assert.match(err.message, /folder "renamed-away" doesn't exist under the ingest root — renamed or removed\?/);
    assert.equal(err.notFound, true, "tagged so the routes can answer 404 (browse fallback, health probe)");
    // These strings reach the member-visible job log and the board's
    // last_error — the server's filesystem layout must not ride along.
    assert.ok(!err.message.includes(root), "no resolved absolute path");
    assert.ok(!/ENOENT|scandir/.test(err.message), "no raw fs error text");
    return true;
  });
});

test("a file that vanishes between scan and admit fails readable, path-free", async () => {
  const p = put("vanish/x.txt");
  const board = await boardWatching("vanish", "vanish");
  const { candidates } = await enumerate(db, board, board.ingest);
  const c = candidates.find((x) => x.key === "x.txt");
  fs.rmSync(p);
  // Not tagged skip/unprocessable: a vanish is transient-shaped, the sweep may
  // retry it (and the next scan simply won't list it).
  await assert.rejects(admit(db, board, c, { sources }), (err) => {
    assert.match(err.message, /file vanished before it could be copied/);
    assert.ok(!err.message.includes(root), "no resolved absolute path");
    return true;
  });
});
