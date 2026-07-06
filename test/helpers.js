// Test harness: each call to startServer() spins up a throwaway Postgres
// database, imports the app against it (schema + admin seed run at import),
// and listens on an ephemeral port. Nothing here touches the real dev DB.
//
// Requires a reachable Postgres whose role can CREATE DATABASE. Locally that's
// the compose db on 127.0.0.1:5433; CI points TEST_ADMIN_URL at its service.
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  createUser,
  getUserByEmail,
  createSession,
  createBoard,
  setBoardMembers,
  insertItem,
} from "../server/db.js";

const ADMIN_URL = process.env.TEST_ADMIN_URL || "postgres://gallery:gallery@127.0.0.1:5433/postgres";
export const ADMIN_EMAIL = "admin@test.local";

export async function startServer() {
  const name = "gallery_test_" + crypto.randomBytes(6).toString("hex");
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${name}`);
  const dbUrl = ADMIN_URL.replace(/\/[^/]+$/, "/" + name);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-test-"));
  const galleryDir = path.join(tmp, "gallery");
  const thumbsDir = path.join(tmp, "thumbnails");

  // The app reads all of these at import; set them before importing.
  process.env.DATABASE_URL = dbUrl;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.COOKIE_SECURE = "0";
  process.env.GALLERY_DIR = galleryDir;
  process.env.THUMBS_DIR = thumbsDir;
  process.env.STATIC_DIR = tmp; // no real frontend needed for API tests

  // Query string cache-busts the import so repeated starts in one process each
  // get a fresh module bound to their own DATABASE_URL.
  const mod = await import("../server/server.js?bust=" + name);
  const { app, db } = mod;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    await new Promise((r) => server.close(r));
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { base, db, galleryDir, thumbsDir, close };
}

// --- seeding (operates on the app's own pool) ---

const FACETS = [{ key: "kind", label: "Kind", single: true, values: ["a", "b"] }];

export async function adminSession(db) {
  const u = await getUserByEmail(db, ADMIN_EMAIL); // seeded at import
  return { id: u.id, sid: await createSession(db, u.id), email: ADMIN_EMAIL };
}

export async function seedUser(db, email) {
  const u = await createUser(db, email, null);
  return { id: u.id, sid: await createSession(db, u.id), email };
}

export async function seedBoard(db, name, memberIds = []) {
  const id = await createBoard(db, name, FACETS, "", true, null, null, { enabled: true });
  if (memberIds.length) await setBoardMembers(db, id, memberIds);
  return id;
}

export async function seedItem(db, boardId, filename = crypto.randomBytes(6).toString("hex") + ".png") {
  const id = await insertItem(
    db,
    boardId,
    { identity: filename, files: [{ name: filename, original_name: filename, w: 10, h: 10 }], fields: {} },
    "tagged"
  );
  return { id, filename };
}

// --- request helper ---

export async function req(base, method, pathname, { sid, body } = {}) {
  const headers = {};
  if (sid) headers.Cookie = `sid=${sid}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (static files, redirects) */
  }
  return { status: res.status, json, text };
}
