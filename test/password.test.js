// Password auth: scrypt storage, login, first-time set / change, session
// revocation, and the single-use invite lifecycle. Kept lean on requests to
// the rate-limited endpoints (/api/login, /api/account/password, /auth/:token
// share one 30-per-15-min bucket per IP) so the suite never trips its own 429.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, req } from "./helpers.js";
import { hashPassword, verifyPassword, dummyVerify } from "../server/password.js";
import { setPassword, mintInvite, createSession } from "../server/db.js";

let srv, db, base;
let admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});

after(() => srv.close());

// Raw fetch where the helper won't do: reading Set-Cookie / Location.
const sidFrom = (res) => /sid=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1] || null;
const login = (email, password, sid) =>
  fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sid ? { Cookie: `sid=${sid}` } : {}) },
    body: JSON.stringify({ email, password }),
  });

test("scrypt round-trip: verifies its own output, rejects everything else", async () => {
  const stored = await hashPassword("correct horse");
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse", stored), true);
  assert.equal(await verifyPassword("wrong horse", stored), false);
  // Malformed / hostile stored values fail closed, never throw.
  for (const bad of ["", "plainhash", "scrypt$16384$8$1$only-five", "scrypt$999$8$1$AA$AA", "scrypt$1048576000$8$1$AA$AA", stored.replace("scrypt", "bcrypt")]) {
    assert.equal(await verifyPassword("correct horse", bad), false);
  }
  assert.equal(await dummyVerify("anything"), false);
  // Salted: same password, different rows.
  assert.notEqual(await hashPassword("correct horse"), stored);
});

test("login with the right password sets a working session and stamps last_login_at", async () => {
  const u = await seedUser(db, "pw-ok@test.local");
  await setPassword(db, u.id, await hashPassword("hunter22hunter22"));
  const res = await login(u.email, "hunter22hunter22");
  assert.equal(res.status, 200);
  const sid = sidFrom(res);
  assert.ok(sid);
  const me = await req(base, "GET", "/api/me", { sid });
  assert.equal(me.json.email, u.email);
  assert.equal(me.json.needs_password, false);
  const { rows } = await db.query("SELECT last_login_at FROM users WHERE id=$1", [u.id]);
  assert.ok(Number(rows[0].last_login_at) > Date.now() - 60_000);
});

test("wrong password, unknown email, and passwordless account are indistinguishable 401s", async () => {
  const u = await seedUser(db, "pw-401@test.local");
  await setPassword(db, u.id, await hashPassword("hunter22hunter22"));
  const results = await Promise.all([
    login(u.email, "not-the-password"),
    login("nobody@test.local", "whatever-here"),
    login(admin.email, "whatever-here"), // seeded admin has no password yet
  ]);
  for (const r of results) assert.equal(r.status, 401);
  const bodies = await Promise.all(results.map((r) => r.text()));
  assert.equal(new Set(bodies).size, 1);
});

test("login rotates: the pre-login session dies", async () => {
  const u = await seedUser(db, "pw-rotate@test.local");
  await setPassword(db, u.id, await hashPassword("hunter22hunter22"));
  const preSid = u.sid;
  const res = await login(u.email, "hunter22hunter22", preSid);
  assert.equal(res.status, 200);
  assert.notEqual(sidFrom(res), preSid);
  const me = await req(base, "GET", "/api/me", { sid: preSid });
  assert.equal(me.json, null);
});

test("first-time set: needs_password flags it, no current required, then the password logs in", async () => {
  const u = await seedUser(db, "pw-first@test.local");
  assert.equal((await req(base, "GET", "/api/me", { sid: u.sid })).json.needs_password, true);
  const set = await req(base, "POST", "/api/account/password", { sid: u.sid, body: { password: "brand-new-pass" } });
  assert.equal(set.status, 200);
  assert.equal((await req(base, "GET", "/api/me", { sid: u.sid })).json.needs_password, false);
  assert.equal((await login(u.email, "brand-new-pass")).status, 200);
});

test("password_hash never leaks through /api/me or /api/admin/users", async () => {
  const me = await req(base, "GET", "/api/me", { sid: admin.sid });
  assert.ok(!me.text.includes("password_hash"));
  const users = await req(base, "GET", "/api/admin/users", { sid: admin.sid });
  assert.equal(users.status, 200);
  assert.ok(!users.text.includes("password_hash"));
});

test("change: wrong current 403, right current swaps which password works", async () => {
  const u = await seedUser(db, "pw-change@test.local");
  await setPassword(db, u.id, await hashPassword("old-password-1"));
  const bad = await req(base, "POST", "/api/account/password", { sid: u.sid, body: { current: "nope", password: "new-password-2" } });
  assert.equal(bad.status, 403);
  const good = await req(base, "POST", "/api/account/password", { sid: u.sid, body: { current: "old-password-1", password: "new-password-2" } });
  assert.equal(good.status, 200);
  assert.equal((await login(u.email, "old-password-1")).status, 401);
  assert.equal((await login(u.email, "new-password-2")).status, 200);
});

test("too-short password is rejected", async () => {
  const u = await seedUser(db, "pw-short@test.local");
  const r = await req(base, "POST", "/api/account/password", { sid: u.sid, body: { password: "seven77" } });
  assert.equal(r.status, 400);
});

test("changing the password revokes every other session but keeps the caller's", async () => {
  const u = await seedUser(db, "pw-revoke@test.local");
  const other1 = await createSession(db, u.id);
  const other2 = await createSession(db, u.id);
  const r = await req(base, "POST", "/api/account/password", { sid: u.sid, body: { password: "fresh-password" } });
  assert.equal(r.status, 200);
  assert.equal((await req(base, "GET", "/api/me", { sid: u.sid })).json.email, u.email);
  assert.equal((await req(base, "GET", "/api/me", { sid: other1 })).json, null);
  assert.equal((await req(base, "GET", "/api/me", { sid: other2 })).json, null);
});

test("anonymous password change is a 401", async () => {
  const r = await req(base, "POST", "/api/account/password", { body: { password: "irrelevant-here" } });
  assert.equal(r.status, 401);
});

test("invite links are single-use and route by password state", async () => {
  // No password yet → the redemption lands on the set-password screen.
  const fresh = await seedUser(db, "inv-fresh@test.local");
  const t1 = await mintInvite(db, fresh.id);
  const r1 = await fetch(base + `/auth/${t1}`, { redirect: "manual" });
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get("location"), "/login.html");
  assert.ok(sidFrom(r1));
  // Second redemption of the same token is dead.
  const r2 = await fetch(base + `/auth/${t1}`, { redirect: "manual" });
  assert.equal(r2.headers.get("location"), "/login.html?error=invalid");

  // With a password set → straight into the app.
  const seasoned = await seedUser(db, "inv-seasoned@test.local");
  await setPassword(db, seasoned.id, await hashPassword("already-set-pass"));
  const r3 = await fetch(base + `/auth/${await mintInvite(db, seasoned.id)}`, { redirect: "manual" });
  assert.equal(r3.headers.get("location"), "/");
});

test("brute force against one account trips the per-email limiter", async () => {
  // Own server: fresh rate-limit windows, so the 11 attempts here don't eat
  // the shared per-IP budget of the tests above (and vice versa).
  const srv2 = await startServer();
  try {
    const u = await seedUser(srv2.db, "pw-brute@test.local");
    await setPassword(srv2.db, u.id, await hashPassword("the-real-password"));
    let last;
    for (let i = 0; i < 10; i++) {
      last = await fetch(srv2.base + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password: `guess-${i}` }),
      });
      assert.equal(last.status, 401, `attempt ${i + 1}`);
    }
    const blocked = await fetch(srv2.base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: u.email, password: "the-real-password" }),
    });
    assert.equal(blocked.status, 429); // even the right password waits out the window
  } finally {
    await srv2.close();
  }
});

test("expired invites and re-minted-over invites don't redeem", async () => {
  const u = await seedUser(db, "inv-dead@test.local");
  const expired = await mintInvite(db, u.id, -1000);
  const r1 = await fetch(base + `/auth/${expired}`, { redirect: "manual" });
  assert.equal(r1.headers.get("location"), "/login.html?error=invalid");
  // Minting a new link deletes the outstanding one.
  const older = await mintInvite(db, u.id);
  await mintInvite(db, u.id);
  const r2 = await fetch(base + `/auth/${older}`, { redirect: "manual" });
  assert.equal(r2.headers.get("location"), "/login.html?error=invalid");
});
