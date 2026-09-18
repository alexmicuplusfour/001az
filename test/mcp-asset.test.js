// The signed asset route (planning/mcp-stage-2.md §4) — the only way an agent
// can get a file out of this instance, because there is no shared filesystem to
// hand a path across (§1.1).
//
// The signature IS the authorisation here, so most of this file is about what
// happens when it does not hold.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { startServer, callTool, toolText, mcp } from "./helpers.js";
import { createBoard, createEntity, insertItem, setSetting, getSetting } from "../server/db.js";

let srv, db, base, boardId, entityId, fileName;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  await setSetting(db, "mcp_enabled", "1");
  boardId = await createBoard(db, "Asset board", [], "");
  fileName = "asset-fixture.png";
  // A real PNG, because the route hands the file to express's sendFile and the
  // point is that a client gets usable bytes with a usable Content-Type.
  await sharp({ create: { width: 40, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png()
    .toFile(path.join(srv.galleryDir, fileName));
  await sharp({ create: { width: 20, height: 12, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .webp()
    .toFile(path.join(srv.thumbsDir, fileName + ".webp"));
  entityId = await createEntity(db, boardId, { identity: fileName });
  const itemId = await insertItem(
    db, boardId,
    { identity: fileName, files: [{ name: fileName, original_name: "screenshot.png", w: 40, h: 24, kind: "image", meta: { width: 40, height: 24 } }], fields: {} },
    "tagged", entityId
  );
  await db.query("UPDATE items SET tags=$1, tag_reasoning=$2 WHERE id=$3", [
    JSON.stringify(["theme/dark"]),
    JSON.stringify({ description: "A small blue rectangle.", theme: "It is dark blue.", fit: "Fits fine." }),
    itemId,
  ]);
});
after(() => srv.close());

// A fresh link, as get_items hands one out.
async function link() {
  const { result } = await callTool(base, "get_items", { board: boardId, ids: [entityId] });
  const m = /(http\S+\/mcp\/asset\/\S+)/.exec(toolText(result));
  assert.ok(m, "get_items returned a download link");
  return m[1];
}
// The link is minted against BASE_URL, which in tests is not the ephemeral port
// the server actually listens on — so fetch the path against `base`.
const fetchLink = (url, mutate = (u) => u) => fetch(base + mutate(new URL(url).pathname));

test("a link from get_items fetches the original bytes", async () => {
  const r = await fetchLink(await link());
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /image\/png/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(buf, fs.readFileSync(path.join(srv.galleryDir, fileName)), "byte-identical to what is on disk");
});

test("content types express's own mime lookup gets wrong", async () => {
  // express resolves types through send -> mime@1.6, which predates AVIF; 46
  // files in the real gallery would go out as application/octet-stream and a
  // download nobody can preview is half a download.
  const crypto = await import("node:crypto");
  const secret = await getSetting(db, "mcp_asset_secret");
  for (const [file, want] of [["shot.avif", /image\/avif/], ["doc.pdf", /application\/pdf/], ["clip.mp3", /audio\/mpeg/]]) {
    fs.writeFileSync(path.join(srv.galleryDir, file), Buffer.from("not really, but the type is the point"));
    const exp = Date.now() + 60_000;
    const sig = crypto.createHmac("sha256", secret).update(`asset:${file}.${exp}`).digest("base64url").slice(0, 22);
    const r = await fetch(`${base}/mcp/asset/${file}/${exp}/${sig}`);
    assert.equal(r.status, 200, file);
    assert.match(r.headers.get("content-type"), want, file);
  }
  // An extensionless file honestly IS a stream of bytes — no guess invented.
  fs.writeFileSync(path.join(srv.galleryDir, "bare"), Buffer.from("x"));
  const exp = Date.now() + 60_000;
  const sig = crypto.createHmac("sha256", secret).update(`asset:bare.${exp}`).digest("base64url").slice(0, 22);
  const r = await fetch(`${base}/mcp/asset/bare/${exp}/${sig}`);
  assert.match(r.headers.get("content-type"), /octet-stream/);
});

test("a tampered name, exp or signature is refused", async () => {
  const url = await link();
  const [, , , name, exp, sig] = new URL(url).pathname.split("/");
  const at = (n, e, s) => fetch(`${base}/mcp/asset/${n}/${e}/${s}`);

  assert.equal((await at(name, exp, sig)).status, 200, "the untouched link works");
  // A different file under the same signature — the whole point of signing the
  // NAME rather than trusting the path.
  assert.equal((await at("other.png", exp, sig)).status, 403);
  // A later expiry, to try to extend a link the server already issued.
  assert.equal((await at(name, String(Number(exp) + 3_600_000), sig)).status, 403);
  assert.equal((await at(name, exp, sig.slice(0, -1) + "X")).status, 403);
  assert.equal((await at(name, exp, "")).status, 404); // no sig segment at all — no route
  assert.equal((await at(name, "not-a-number", sig)).status, 403);
});

test("path traversal cannot escape the gallery", async () => {
  // The signature already makes a forged name impossible; this pins the second
  // guard, so a future change to the signing scheme cannot quietly reopen it.
  const secret = await getSetting(db, "mcp_asset_secret");
  assert.ok(secret, "get_items minted the secret");
  const crypto = await import("node:crypto");
  const evil = "../../etc/passwd";
  const exp = Date.now() + 60_000;
  const sig = crypto.createHmac("sha256", secret).update(`asset:${evil}.${exp}`).digest("base64url").slice(0, 22);
  // Correctly signed and still refused, because the name is not a bare basename.
  const r = await fetch(`${base}/mcp/asset/${encodeURIComponent(evil)}/${exp}/${sig}`);
  assert.equal(r.status, 403);
});

test("an expired link says how to get a new one", async () => {
  const secret = await getSetting(db, "mcp_asset_secret");
  const crypto = await import("node:crypto");
  const exp = Date.now() - 1000;
  const sig = crypto.createHmac("sha256", secret).update(`asset:${fileName}.${exp}`).digest("base64url").slice(0, 22);
  const r = await fetch(`${base}/mcp/asset/${fileName}/${exp}/${sig}`);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /get_items again/);
});

test("rotating the token does NOT break links; clearing the asset secret does", async () => {
  const url = await link();
  // Rotation is about disconnecting clients. A download already handed out is
  // not a client, and killing it would be a surprise nobody asked for.
  await setSetting(db, "mcp_token", "a-brand-new-token-value");
  assert.equal((await fetchLink(url)).status, 200);

  // Clearing the asset secret is the separate, deliberate revocation.
  await setSetting(db, "mcp_asset_secret", null);
  assert.equal((await fetchLink(url)).status, 403);
  await setSetting(db, "mcp_token", null);
});

test("switching the feature off kills outstanding links", async () => {
  const url = await link();
  assert.equal((await fetchLink(url)).status, 200);
  await setSetting(db, "mcp_enabled", null);
  assert.equal((await fetchLink(url)).status, 404, "404 like /mcp itself — absent, not broken");
  await setSetting(db, "mcp_enabled", "1");
});

test("a grid's images do not spend the agent's request budget", async () => {
  // An MCP App renders one <img> per card, so two 30-card results are 60 GETs
  // inside one window. These 403 on the signature, which is beside the point —
  // the limiter runs before the handler either way, and the budget is what is
  // being measured. Sharing one bucket with /mcp meant the 61st request was a
  // 429 and the model's next tools/call died because the person's browser had
  // loaded pictures.
  for (let i = 0; i < 61; i++) {
    const r = await fetch(`${base}/mcp/thumb/x${i}.jpg/${Date.now() + 60_000}/nope`);
    assert.equal(r.status, 403, `image ${i} was throttled, not refused on its signature`);
  }
  assert.equal((await mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 200);
});

test("the restore gate answers /mcp in JSON and the asset path in text", async () => {
  // The gate matches "/mcp" EXACTLY. Widening it to startsWith would hand a
  // JSON body to an <img>; narrowing it would hand JSON-RPC a prose string.
  // Both halves pinned here because the comment in mcp.js asks for it.
  const { restoreGate } = await import("../server/backup-routes.js");
  const gate = restoreGate({ restore: { active: true, sid: null } });
  const run = (p) =>
    new Promise((resolve) => {
      const res = {
        set: () => res, setHeader: () => res, type: (t) => ((res._type = t), res),
        status: (s) => ((res._status = s), res),
        json: (b) => resolve({ status: res._status, kind: "json", body: b }),
        send: (b) => resolve({ status: res._status, kind: res._type, body: b }),
      };
      gate({ path: p, headers: {} }, res, () => resolve({ status: 200, kind: "next" }));
    });
  assert.deepEqual(await run("/mcp"), { status: 503, kind: "json", body: { error: "restore in progress" } });
  const asset = await run("/mcp/asset/x/1/y");
  assert.equal(asset.status, 503);
  assert.equal(asset.kind, "text/plain");
});
