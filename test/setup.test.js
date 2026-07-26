// First-run setup: an instance where NO account has a password (fresh
// install, or a restore of an archive without passworded accounts) lets the
// first visitor create the admin account — email + password, right on the
// login page, no env preconfiguration and no CLI. The door re-checks the DB
// on every call and closes for good the moment any password exists.
//
// Kept lean on POST /api/setup: it shares the 30-per-15-min authLimiter
// bucket with /api/login and /auth/:token.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, req, ADMIN_EMAIL } from "./helpers.js";
import { hashPassword } from "../server/password.js";
import { createSession, getUserByEmail, mintInvite, setPassword } from "../server/db.js";

let srv, db, base;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
});

after(() => srv.close());

const sidFrom = (res) => /sid=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1] || null;
const claim = (body) =>
  fetch(base + "/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("a fresh instance advertises setup", async () => {
  assert.deepEqual((await req(base, "GET", "/api/setup", {})).json, { setup: true });
});

test("the door closes the instant anyone has a password", async () => {
  const u = await seedUser(db, "setup-bystander@test.local");
  await setPassword(db, u.id, await hashPassword("hunter22hunter22"));
  assert.deepEqual((await req(base, "GET", "/api/setup", {})).json, { setup: false });
  assert.equal((await claim({ email: "x@test.local", password: "hunter22hunter22" })).status, 403);
  // Back to the no-passwords state (as a wipe-restore of a passwordless
  // archive would leave it): the door reopens.
  await db.query("UPDATE users SET password_hash=NULL WHERE id=$1", [u.id]);
  assert.deepEqual((await req(base, "GET", "/api/setup", {})).json, { setup: true });
});

test("a bad email or short password refuses without claiming anything", async () => {
  assert.equal((await claim({ email: "not-an-email", password: "hunter22hunter22" })).status, 400);
  assert.equal((await claim({ email: "x@test.local", password: "short" })).status, 400);
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM users WHERE password_hash IS NOT NULL");
  assert.equal(rows[0].n, 0);
});

test("claiming an existing email promotes it, signs in, and shuts the door", async () => {
  // The seeded admin exists but has no password. Two ways into the account
  // that must die with the claim: an unredeemed mintlink link, and a session
  // someone already opened off such a link.
  const adminUser = await getUserByEmail(db, ADMIN_EMAIL);
  const staleInvite = await mintInvite(db, adminUser.id);
  const hijacked = await createSession(db, adminUser.id);

  const res = await claim({ email: ADMIN_EMAIL.toUpperCase(), password: "hunter22hunter22" });
  assert.equal(res.status, 200);
  const sid = sidFrom(res);
  assert.ok(sid, "the claim must sign the admin in");
  const me = await req(base, "GET", "/api/me", { sid });
  assert.equal(me.json.email, ADMIN_EMAIL); // normalized, same row — not a duplicate
  assert.equal(me.json.is_admin, true);
  assert.equal(me.json.needs_password, false);

  // Door shut: not advertised, replay refused.
  assert.deepEqual((await req(base, "GET", "/api/setup", {})).json, { setup: false });
  assert.equal((await claim({ email: ADMIN_EMAIL, password: "hunter22hunter22" })).status, 403);

  // The stale invite and the hijacked session both died with the claim.
  const redeemed = await fetch(base + `/auth/${staleInvite}`, { redirect: "manual" });
  assert.equal(redeemed.status, 302);
  assert.match(redeemed.headers.get("location") || "", /error=invalid/);
  assert.equal((await req(base, "GET", "/api/me", { sid: hijacked })).json, null);

  // And the password the claim set is a real login.
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: "hunter22hunter22" }),
  });
  assert.equal(login.status, 200);
});

test("claiming a brand-new email creates the admin account outright", async () => {
  // No ADMIN_EMAIL required: reopen the door and claim with an email the
  // instance has never seen.
  await db.query("UPDATE users SET password_hash=NULL");
  const res = await claim({ email: "owner@fresh.local", password: "hunter22hunter22" });
  assert.equal(res.status, 200);
  const me = await req(base, "GET", "/api/me", { sid: sidFrom(res) });
  assert.equal(me.json.email, "owner@fresh.local");
  assert.equal(me.json.is_admin, true);
});

test("adminSession still works for suites that never claim", async () => {
  // The rest of the test suite logs in by writing sessions directly — the
  // setup door being open in those suites must not get in their way.
  const admin = await adminSession(db);
  assert.equal((await req(base, "GET", "/api/admin/backups", { sid: admin.sid })).status, 200);
});
