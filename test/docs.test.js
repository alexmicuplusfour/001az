// Document ingestion (pipeline slice 1): pdf/txt/md/csv through the upload
// door, kind/label on the item API, document parts for the tagger. Preview
// rendering is NOT asserted — poppler is a container dependency and these
// tests run on the host; the handler degrades to no-preview by design.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, adminSession, seedBoard } from "./helpers.js";
import { anthropicRequest } from "../server/ai-providers/wires/anthropic.js";
import { documentTextFor, clipText } from "../server/worker.js";
import { MANIFESTS, acceptsName } from "../server/sources/index.js";
import { textSource } from "../server/sources/text.js";
import { docxSource } from "../server/sources/docx.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function uploadFiles(base, sid, boardId, files) {
  const fd = new FormData();
  for (const [name, content, type] of files) fd.append("files", new File([content], name, { type }));
  const res = await fetch(`${base}/api/upload?board=${boardId}`, {
    method: "POST",
    headers: { Cookie: `sid=${sid}` },
    body: fd,
  });
  return { status: res.status, json: await res.json() };
}

test("document ingestion", async (t) => {
  const { base, db, galleryDir, close } = await startServer();
  t.after(close);
  const admin = await adminSession(db);
  const board = await seedBoard(db, "docs-board");

  await t.test("a .txt ingests as a text-kind item with the generic payload", async () => {
    const r = await uploadFiles(base, admin.sid, board, [
      ["resume.txt", "Jane Doe\nSenior engineer, 10 years of Node.", "text/plain"],
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.json.rejected.length, 0);
    const [u] = r.json.uploaded;
    assert.equal(u.kind, "text");
    assert.equal(u.label, "resume.txt");
    assert.match(u.name, /^[0-9a-f]{16}\.txt$/);
    // text previews render via sharp (no poppler involved), so dims are portable
    assert.equal(u.w, 600);
    assert.equal(u.h, 760);
    // u.id is the entity; the items row is the instance.
    const { rows } = await db.query("SELECT payload, status FROM items WHERE id=$1", [u.instances[0].id]);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].payload.identity, u.name);
    assert.equal(rows[0].payload.files[0].kind, "text");
    assert.equal(rows[0].payload.files[0].original_name, "resume.txt");
  });

  await t.test("a pdf ingests as a pdf-kind item (preview optional)", async () => {
    const r = await uploadFiles(base, admin.sid, board, [
      ["cv.pdf", "%PDF-1.4\n%fake minimal\n", "application/pdf"],
    ]);
    const [u] = r.json.uploaded;
    assert.equal(u.kind, "pdf");
    assert.equal(u.label, "cv.pdf");
    assert.match(u.name, /\.pdf$/);
  });

  await t.test("a docx ingests with text + html sidecars and page-peek preview", async () => {
    const bytes = fs.readFileSync(path.join(FIXTURES, "sample.docx"));
    const r = await uploadFiles(base, admin.sid, board, [
      ["designer.docx", bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ]);
    const [u] = r.json.uploaded;
    assert.equal(u.kind, "docx");
    assert.equal(u.label, "designer.docx");
    assert.equal(u.w, 600); // text-peek preview renders via sharp — portable
    const { rows } = await db.query("SELECT payload FROM items WHERE id=$1", [u.instances[0].id]);
    const stored = rows[0].payload.files[0].name;
    // .txt sidecar (what the tagger reads): clean extracted text, served behind auth
    const sidecar = fs.readFileSync(path.join(galleryDir, stored + ".txt"), "utf8");
    assert.match(sidecar, /Maya Lin - Principal Product Designer/);
    const res = await fetch(`${base}/gallery/${stored}.txt`, { headers: { Cookie: `sid=${admin.sid}` } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /design systems/);
    // .html sidecar (what the lightbox's full view reads): formatted markup, served as html
    const html = fs.readFileSync(path.join(galleryDir, stored + ".html"), "utf8");
    assert.match(html, /<(h\d|p|strong|ul|table)\b/); // real markup, not plaintext
    assert.match(html, /Maya Lin - Principal Product Designer/);
    const hres = await fetch(`${base}/gallery/${stored}.html`, { headers: { Cookie: `sid=${admin.sid}` } });
    assert.equal(hres.status, 200);
    assert.match(hres.headers.get("content-type") || "", /text\/html/);
  });

  await t.test("a zip wearing .docx that mammoth can't read is rejected", async () => {
    const r = await uploadFiles(base, admin.sid, board, [
      ["fake.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "application/zip"],
    ]);
    assert.equal(r.json.uploaded.length, 0);
    assert.equal(r.json.rejected.length, 1);
  });

  await t.test("binary wearing .txt and unknown types are rejected", async () => {
    const r = await uploadFiles(base, admin.sid, board, [
      ["evil.txt", new Uint8Array([0, 1, 2, 3]), "text/plain"],
      ["app.exe", new Uint8Array([77, 90, 1, 2]), "application/octet-stream"],
    ]);
    assert.equal(r.json.uploaded.length, 0);
    assert.equal(r.json.rejected.length, 2);
  });

  await t.test("/api/items carries kind and label", async () => {
    const res = await fetch(`${base}/api/items?board=${board}`, { headers: { Cookie: `sid=${admin.sid}` } });
    const items = await res.json();
    assert.equal(items.find((i) => i.label === "resume.txt")?.kind, "text");
    assert.equal(items.find((i) => i.label === "cv.pdf")?.kind, "pdf");
  });

  await t.test("document parts map to Anthropic document blocks", () => {
    const r = anthropicRequest({
      model: "m", systemText: "s", schema: { type: "object" },
      parts: [{ kind: "document", mediaType: "application/pdf", b64: "QQ==" }, { kind: "text", text: "tag it" }],
    });
    assert.deepEqual(r.messages[0].content[0], {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "QQ==" },
    });
  });
});

// ── documentTextFor: infra failures throw, "no text" is a real answer ────────

test("documentTextFor: extractor downtime throws transient; empty markdown falls through", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctext-"));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, "a.pdf"), "%PDF-1.4 fake");
  const pdf = { kind: "pdf", name: "a.pdf", original_name: "cv.pdf" };

  // healthy: extracted markdown comes back
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ markdown: "# hi" }) });
  assert.equal(await documentTextFor(dir, pdf), "# hi");

  // healthy but textless scan: "" is a real answer (caller may document-block)
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ markdown: "" }) });
  assert.equal(await documentTextFor(dir, pdf), "");

  // extractor erring: throws STATUS-LESS so failOrRequeue spaces retries
  // instead of the caller silently paying per-page document billing
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(documentTextFor(dir, pdf), (e) => /extractor failed/.test(e.message) && e.status === undefined);

  // extractor unreachable (deploy blip): same shape
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(documentTextFor(dir, pdf), (e) => /extractor unreachable/.test(e.message) && e.status === undefined);
});

test("documentTextFor: a docx/text with no extractable text fails permanent-shaped", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctext-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // image-only docx: passes ingest with an empty .txt sidecar
  fs.writeFileSync(path.join(dir, "d.docx.txt"), "  \n");
  await assert.rejects(
    documentTextFor(dir, { kind: "docx", name: "d.docx", original_name: "pics.docx" }),
    (e) => /"pics\.docx" has no extractable text/.test(e.message) && e.status === 422
  );

  fs.writeFileSync(path.join(dir, "empty.txt"), "");
  await assert.rejects(
    documentTextFor(dir, { kind: "text", name: "empty.txt", original_name: "empty.txt" }),
    (e) => e.status === 422
  );

  // content still flows through untouched
  fs.writeFileSync(path.join(dir, "u.txt"), "hello");
  assert.equal(await documentTextFor(dir, { kind: "text", name: "u.txt", original_name: "u.txt" }), "hello");
});

// ── clipText: the model is told when its material was cut ────────────────────
// A silently missing tail reads as ABSENCE (extraction answers "not found"
// with a confident why sentence); the marker turns it into truncation the
// model can report, with counts for scale.

test("clipText: under the cap passes through untouched", () => {
  assert.equal(clipText("short document", 100), "short document");
  assert.equal(clipText("x".repeat(100), 100), "x".repeat(100)); // exactly at the cap: no marker
});

test("clipText: over the cap keeps the head and appends the counted marker", () => {
  const clipped = clipText("a".repeat(150), 100);
  assert.ok(clipped.startsWith("a".repeat(100)));
  assert.ok(clipped.endsWith("\n\n[truncated: showing the first 100 of 150 characters]"));
  assert.ok(!clipped.includes("a".repeat(101)), "nothing past the cap leaks through");
});

test("source registry: every declared extension maps to exactly one handler", () => {
  const seen = new Map();
  for (const m of MANIFESTS) {
    assert.ok(m.name && m.label && m.extensions.length && m.kinds.length, `manifest ${m.name} is complete`);
    for (const ext of m.extensions) {
      assert.ok(!seen.has(ext), `extension .${ext} claimed by both ${seen.get(ext)} and ${m.name}`);
      seen.set(ext, m.name);
    }
  }
  // the folder-feed pre-filter is the manifests' union — and nothing else
  assert.ok(acceptsName("shot.PNG") && acceptsName("cv.pdf") && acceptsName("notes.md"));
  assert.ok(!acceptsName("movie.mp4") && !acceptsName("noext"));
});

test("a preview-write failure leaves the doc ingesting (graceful degradation)", async (t) => {
  // The card preview is optional: if the thumbnail can't be written, the doc
  // still ingests with a badge — never a rejection. Regression guard for the
  // face-pipeline refactor, which moved the write out of the producer's own
  // try/catch (storeFace) — this pins that the doc handlers still swallow it.
  const galleryDir = fs.mkdtempSync(path.join(os.tmpdir(), "gal-"));
  const thumbsDir = fs.mkdtempSync(path.join(os.tmpdir(), "thb-"));
  t.after(() => {
    fs.rmSync(galleryDir, { recursive: true, force: true });
    fs.rmSync(thumbsDir, { recursive: true, force: true });
  });
  const handler = textSource({ galleryDir, thumbsDir });
  // Break the thumb store: replace the dir with a file, so writing
  // thumbsDir/<name>.webp fails (ENOTDIR) while the original write still works.
  fs.rmdirSync(thumbsDir);
  fs.writeFileSync(thumbsDir, "x");

  const tmp = path.join(galleryDir, "in.txt");
  fs.writeFileSync(tmp, "hello world\nsecond line");
  const entry = await handler.ingest(tmp, "note.txt");

  assert.ok(entry, "the doc still ingests despite the thumbnail failure");
  assert.equal(entry.kind, "text");
  assert.equal(entry.w, undefined, "no preview dims when the thumb couldn't be written");
  assert.ok(fs.existsSync(path.join(galleryDir, entry.name)), "the original is stored");
});

test("a docx preview-write failure still writes the original + sidecars", async (t) => {
  // Same graceful degradation for docx — but docx writes .txt/.html sidecars
  // AROUND the thumb, so this also pins that a swallowed thumb failure doesn't
  // cost those artifacts (text.js has no sidecars to lose). Uses the real docx
  // fixture: textPeek renders via sharp (available on the host), so this
  // actually reaches storeFace and exercises the catch — unlike pdf, whose
  // pdfPage returns null without poppler and never gets there.
  const galleryDir = fs.mkdtempSync(path.join(os.tmpdir(), "gal-"));
  const thumbsDir = fs.mkdtempSync(path.join(os.tmpdir(), "thb-"));
  const handler = docxSource({ galleryDir, thumbsDir });
  t.after(async () => {
    await handler.close();
    fs.rmSync(galleryDir, { recursive: true, force: true });
    fs.rmSync(thumbsDir, { recursive: true, force: true });
  });
  // Break the thumb store: replace the dir with a file (ENOTDIR on write).
  fs.rmdirSync(thumbsDir);
  fs.writeFileSync(thumbsDir, "x");

  const tmp = path.join(galleryDir, "in.docx");
  fs.copyFileSync(path.join(FIXTURES, "sample.docx"), tmp);
  const entry = await handler.ingest(tmp, "designer.docx");

  assert.ok(entry, "the docx still ingests despite the thumbnail failure");
  assert.equal(entry.kind, "docx");
  assert.equal(entry.w, undefined, "no preview dims when the thumb couldn't be written");
  assert.ok(fs.existsSync(path.join(galleryDir, entry.name)), "the original is stored");
  assert.ok(fs.existsSync(path.join(galleryDir, entry.name + ".txt")), "the text sidecar survives the thumb failure");
  assert.ok(fs.existsSync(path.join(galleryDir, entry.name + ".html")), "the html sidecar survives the thumb failure");
});
