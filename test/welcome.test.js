// First-run setup, the second door (planning/welcome-plan.md Stage 1). Not to
// be confused with test/setup.test.js, which pins the FIRST one: who gets to
// claim the admin account on an instance where nobody has a password. That
// door is about access. This one is about configuration — the instance now has
// an admin, and the question is whether it has anything for them to work with.
//
// What it pins is `setup_pending`, a predicate with three rungs and exactly
// one stored bit, and the rungs are asserted one at a time because each is a
// short-circuit for the next and a reordering would be invisible to a test
// that only ever checked the whole answer.
//
// The rung worth naming is the middle one. An instance WITH boards is never
// pending, even with no model at all — because a long-running instance whose
// key was revoked is broken, not new, and must not be sent to an onboarding
// screen. That row ("a board is enough") is the one that would quietly go
// green again if someone simplified the predicate down to "is tagging
// configured", which is why it states the whole reason in its name.
//
// Order is deliberate: the skip test writes the one stored bit and leaves it
// written, so everything that depends on NOT being skipped runs above it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";
import { setSetting, createAiKey, deleteBoard, deleteAiKey, setPluginState, getPluginRow } from "../server/db.js";
import { resolveCapability } from "../server/capability-resolve.js";
import { readFileSync } from "node:fs";

let srv, db, base, admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});

after(() => srv.close());

const pending = async (sid = admin.sid) => (await req(base, "GET", "/api/me", { sid })).json.setup_pending;

test("a fresh instance is pending — no model, no boards, nothing skipped", async () => {
  assert.equal(await pending(), true);
});

test("…and stops the moment tagging resolves", async () => {
  const keyId = await createAiKey(db, "welcome-test", "anthropic", "sk-test");
  // Both halves, because a key alone has never been enough: resolution is
  // install-gated and registering a key installs nothing. Until Stage 4 this
  // line was invisible — anthropic was pre-added, so the gate was open by
  // default and only for this one vendor. Now the chooser performs both, and
  // so does this (welcome-plan.md 4.1).
  await setPluginState(db, "ai:anthropic", { installed: true });
  await setSetting(db, "default_key_id", String(keyId));
  assert.equal(await pending(), false, "a bound, installed, advertising provider is a finished setup");
  await setSetting(db, "default_key_id", null); // back to pending for the rungs below
  assert.equal(await pending(), true);
});

// welcome-plan.md 4.1, at the server level: the sequence the welcome screen
// performs, and the reason its middle call is not optional. The probe is left
// out deliberately — it is the one call that leaves this machine, it is covered
// against a real server in test/browser/welcome.test.js, and what is in
// question here is whether the binding RESOLVES, which is decided before
// anything is dialled.
test("connecting a built-in is two writes, and the second one is the whole bug", async () => {
  const keyId = await createAiKey(db, "sequence-test", "openai", "sk-t");
  await setSetting(db, "default_key_id", String(keyId));

  // The state Stage 2 shipped: a key, a binding, and nothing serving. The
  // reason names a page the reader has never opened, about a removal that
  // never happened — and the probe this precedes says "No default API key
  // configured" to someone who just typed one.
  assert.equal(await resolveCapability(db, "tag"), null, "a key alone installs nothing");

  await setPluginState(db, "ai:openai", { installed: true });
  assert.equal((await resolveCapability(db, "tag")).provider, "openai");

  await setSetting(db, "default_key_id", null);
  await setPluginState(db, "ai:openai", { installed: false });
});

// welcome-plan.md 4.5. The flip in 4.4 is safe for anyone whose key is in the
// environment and for anyone starting fresh. It is NOT safe for the admin who
// added an Anthropic key through the UI: they never touched the install toggle
// because the card was already there, so their row falls to a default that is
// about to change under them.
test("the migration keeps a UI-added anthropic key working, and writes nothing otherwise", async () => {
  const sql = readFileSync(new URL("../server/migrations/0047_anthropic_explicit_install.sql", import.meta.url), "utf8");

  // No anthropic key on this instance: nothing to preserve, and a written row
  // would be the pre-added vendor card sneaking back in by another door.
  // Both halves of that state are established here rather than assumed — a
  // test above leaves an unbound anthropic key behind, and the whole migration
  // turns on whether one exists.
  await db.query("DELETE FROM ai_keys WHERE provider = 'anthropic'");
  await db.query("DELETE FROM plugins WHERE id = 'ai:anthropic'");
  await db.query(sql);
  assert.equal(await getPluginRow(db, "ai:anthropic"), null, "a fresh instance keeps its clean slate");

  // …and with one, the explicit TRUE that the old default used to supply.
  const keyId = await createAiKey(db, "migration-test", "anthropic", "sk-t");
  await db.query(sql);
  assert.equal((await getPluginRow(db, "ai:anthropic")).installed, true);

  // An explicit removal stays removed. Someone who turned Anthropic off and
  // left the key behind meant it, and a migration that "restores" their
  // tagging is a migration that overrides them.
  await setPluginState(db, "ai:anthropic", { installed: false });
  await db.query(sql);
  assert.equal((await getPluginRow(db, "ai:anthropic")).installed, false);

  await deleteAiKey(db, keyId);
  await db.query("DELETE FROM plugins WHERE id = 'ai:anthropic'");
});

test("a board is enough to stop it: broken is not new", async () => {
  // No model here — the instance genuinely cannot tag. It is still not
  // pending, because it has boards, and an instance with boards has already
  // been set up once. Whatever is wrong with it is the boards page's strip to
  // report, not the welcome screen's to pretend hasn't happened yet.
  const boardId = await seedBoard(db, "Somewhere already");
  assert.equal(await pending(), false);
  await deleteBoard(db, boardId);
  assert.equal(await pending(), true, "…and the rung is a read, not a latch");
});

test("a member is never asked", async () => {
  // Absent, not false: they cannot add a key, so the question was never
  // theirs, and the field's absence is what keeps it that way rather than a
  // client remembering to check is_admin first.
  const member = await seedUser(db, "member@welcome.test");
  const me = (await req(base, "GET", "/api/me", { sid: member.sid })).json;
  assert.equal(me.is_admin, false);
  assert.equal("setup_pending" in me, false);
});

test("the skip door is admin-only", async () => {
  const member = await seedUser(db, "outsider@welcome.test");
  assert.equal((await req(base, "POST", "/api/admin/welcome/skip", { sid: member.sid })).status, 403);
  assert.equal((await req(base, "POST", "/api/admin/welcome/skip", {})).status, 403);
  assert.equal(await pending(), true, "a refused skip stores nothing");
});

test("skipping settles it, twice", async () => {
  assert.equal((await req(base, "POST", "/api/admin/welcome/skip", { sid: admin.sid })).status, 200);
  assert.equal(await pending(), false);
  // Idempotent: the door is a statement about a redirect, and saying it again
  // says the same thing.
  assert.equal((await req(base, "POST", "/api/admin/welcome/skip", { sid: admin.sid })).status, 200);
  assert.equal(await pending(), false);
});

test("…and skipping outranks everything below it", async () => {
  // The cheapest rung is also the first: with the flag set, neither the board
  // check nor the resolution walk can put the instance back in the redirect's
  // path. Pins the ORDER, which is the part that is otherwise invisible.
  const boardId = await seedBoard(db, "Later, then");
  assert.equal(await pending(), false);
  await deleteBoard(db, boardId);
  assert.equal(await pending(), false);
});
