// Document ingestion (pipeline slice 1): pdf/txt/md/csv through the upload
// door, kind/label on the item API, document parts for the tagger. Preview
// rendering is NOT asserted — poppler is a container dependency and these
// tests run on the host; the handler degrades to no-preview by design.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard } from "./helpers.js";
import { anthropicRequest } from "../server/providers.js";

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
  const { base, db, close } = await startServer();
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
    const { rows } = await db.query("SELECT payload, status FROM items WHERE id=$1", [u.id]);
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
