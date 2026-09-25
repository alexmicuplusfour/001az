// The community index on the server (community-index-plan.md, Stage 3): the
// Community tab's rows, built from the file at PLUGIN_INDEX_URL over the live
// install records, and the fetch's posture — a ten-minute cache, the last good
// copy on a failed refresh, a size cap, the page's flag and the 404 with the
// index off. The index is a jsonBox on this machine; nothing here reaches
// GitHub.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startServer, adminSession, req, jsonBox } from "./helpers.js";
import { communityPlugins } from "../server/plugin-index.js";
import { installFromUrl, uninstall } from "../server/plugin-loader.js";

const FIX = (name) => fileURLToPath(new URL(`./fixtures/plugins/${name}`, import.meta.url));
const SHA = "3f2a9c1e7b0d4a5f6c8e9d0b1a2c3d4e5f6a7b8c";
const SHA2 = "0".repeat(40);
const gecko = {
  id: "acme.gecko", kind: "connector-provider", domain: "crypto", label: "Acme Gecko", description: "A crypto provider.",
  author: "acme", version: "1.0.0", apiVersion: 1, source: `github:acme/gecko@${SHA}`,
};
const brain = {
  id: "acme.brain", kind: "ai-provider", label: "Acme Brain", description: "Models.", author: "acme",
  version: "2.1.0", apiVersion: 1, source: "npm:acme-brain@2.1.0",
  keyless: true, needsBase: true, // not the list's fields: ignored
};
const drop = { id: "acme.drop", kind: "source", label: "Acme Drop", description: "Files.", author: "acme", version: "0.1.0", apiVersion: 1, source: "npm:acme-drop@0.1.0" };
const future = { ...drop, id: "acme.later", label: "Later", apiVersion: 2, source: "npm:acme-later@0.1.0" };
const index = (...plugins) => ({ apiVersion: 1, plugins });
// The clock the cache is driven with: each tick is past the ten-minute window.
let clock = Date.now();
const later = () => ({ now: (clock += 11 * 60 * 1000) });

let srv, db, base, admin, box, envBefore;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  box = await jsonBox(index(gecko, brain, drop, future));
  envBefore = process.env.PLUGIN_INDEX_URL;
  process.env.PLUGIN_INDEX_URL = box.url("/plugins.json"); // read per call, so this lands
});
after(() => {
  if (envBefore === undefined) delete process.env.PLUGIN_INDEX_URL;
  else process.env.PLUGIN_INDEX_URL = envBefore;
  box.close();
  return srv.close();
});

test("GET /api/admin/plugins/community: every entry as a catalog-shaped row, and the page says the chip is drawn", async () => {
  assert.equal((await req(base, "GET", "/api/admin/plugins/community")).status, 403, "admin-only");
  assert.equal((await req(base, "GET", "/api/admin/plugins", { sid: admin.sid })).json.communityIndex, true);
  const r = await req(base, "GET", "/api/admin/plugins/community", { sid: admin.sid });
  assert.equal(r.status, 200);
  const { plugins, fetchedAt, stale, error } = r.json;
  assert.equal(typeof fetchedAt, "number");
  assert.deepEqual({ stale, error }, { stale: false, error: null });
  assert.deepEqual(plugins.map((p) => p.id), ["crypto:acme.gecko", "ai:acme.brain", "source:acme.drop", "source:acme.later"]);
  // The manifest-only shape a bundled example has (the dialog's readers
  // survive it already), with `community` where a bundled row has `bundled`.
  const [g, b, d, l] = plugins;
  assert.deepEqual(g, {
    id: "crypto:acme.gecko", kind: "connector", segment: "crypto", name: "acme.gecko", label: "Acme Gecko",
    description: "A crypto provider.", core: false, capabilities: {}, configSchema: [],
    community: {
      source: `github:acme/gecko@${SHA}`, version: "1.0.0", apiVersion: 1, author: "acme", domain: "crypto",
      installedSource: null, updateAvailable: false, needsApp: false,
    },
    state: { installed: false, config: {}, health: null },
  });
  assert.deepEqual([b.kind, b.segment, d.kind, d.segment], ["ai", "ai", "source", "source"]);
  assert.deepEqual(Object.keys(b.community), Object.keys(g.community), "an entry's other fields ride nowhere");
  assert.equal(b.community.domain, null);
  assert.deepEqual(plugins.filter((p) => p.community.needsApp).map((p) => p.id), [l.id], "an apiVersion this app doesn't speak");
});

test("installed and updateAvailable read the live install records; the file is fetched once per ten minutes", async () => {
  const hits = box.hits.length;
  const id = await installFromUrl(db, FIX("acme-gecko")); // crypto:acme.gecko, from a path
  const row = async (opts) => (await communityPlugins(db, opts)).plugins.find((p) => p.id === id);
  let g = await row();
  assert.equal(g.state.installed, true, "flips at once — the cache holds the file, not the rows");
  assert.equal(g.community.installedSource, FIX("acme-gecko"));
  assert.equal(g.community.updateAvailable, true, "a pin that isn't the entry's");
  // As an index install records it: the entry's source, verbatim.
  await db.query("UPDATE external_plugins SET source_url = $2 WHERE id = $1", [id, gecko.source]);
  g = await row();
  assert.equal(g.community.updateAvailable, false, "the same pin");
  assert.equal(box.hits.length, hits, "no fetch within ten minutes");
  // The author moves the pin: seen once the clock passes.
  box.payload = index({ ...gecko, source: `github:acme/gecko@${SHA2}`, version: "1.1.0" }, brain, drop, future);
  g = await row(later());
  assert.equal(box.hits.length, hits + 1);
  assert.deepEqual([g.community.updateAvailable, g.community.version, g.community.source], [true, "1.1.0", `github:acme/gecko@${SHA2}`]);
  await uninstall(db, id);
  assert.equal((await row()).state.installed, false);
});

test("a failed refresh answers the last good rows marked stale with the reason, and the next call retries", async () => {
  const hits = box.hits.length;
  box.status = 500;
  try {
    let out = await communityPlugins(db, later());
    assert.equal(box.hits.length, hits + 1);
    assert.equal(out.stale, true);
    assert.match(out.error, /^HTTP 500 from http:\/\/127\.0\.0\.1/);
    assert.equal(out.plugins.length, 4, "the last good rows");
    assert.equal(typeof out.fetchedAt, "number", "and when they were fetched");
    out = await communityPlugins(db, { now: clock });
    assert.equal(box.hits.length, hits + 2, "a failure doesn't advance the clock — a call at the same moment retries");
  } finally { box.status = 200; }
  const out = await communityPlugins(db, later());
  assert.deepEqual([out.stale, out.error, box.hits.length], [false, null, hits + 3]);
});

test("another URL answers for itself: unreadable entries skipped; a malformed, oversized or unreachable file is an error with no rows", async () => {
  const other = await jsonBox(index({ ...gecko, kind: "widget" }, brain));
  const wrongVersion = await jsonBox({ apiVersion: 2, plugins: [] });
  const tooBig = await jsonBox(index({ ...brain, description: "x".repeat(2 * 1024 * 1024) }));
  try {
    process.env.PLUGIN_INDEX_URL = other.url("/plugins.json");
    let out = await communityPlugins(db);
    assert.deepEqual(out.plugins.map((p) => p.id), ["ai:acme.brain"], "the readable entry — and never the first box's rows: the cache is keyed by URL");
    assert.equal(out.error, null);
    process.env.PLUGIN_INDEX_URL = wrongVersion.url("/plugins.json");
    out = await communityPlugins(db);
    assert.deepEqual([out.plugins, out.fetchedAt, out.stale], [[], null, false]);
    assert.match(out.error, /index apiVersion 2 — this app reads 1/);
    process.env.PLUGIN_INDEX_URL = tooBig.url("/plugins.json");
    out = await communityPlugins(db);
    assert.deepEqual(out.plugins, []);
    assert.match(out.error, /the plugin index (is too large|exceeds)/);
    // A dead port names itself, not "fetch failed" — a port a box just gave
    // back, since fetch refuses the low well-known ones before connecting.
    const dead = await jsonBox({});
    const deadUrl = dead.url("/plugins.json");
    await new Promise((r) => dead.close(r));
    process.env.PLUGIN_INDEX_URL = deadUrl;
    out = await communityPlugins(db);
    assert.equal(out.error, `the plugin index: ECONNREFUSED — ${deadUrl}`);
  } finally {
    process.env.PLUGIN_INDEX_URL = box.url("/plugins.json");
    other.close(); wrongVersion.close(); tooBig.close();
  }
});

test("with the index off, the page says so and the route is 404", async () => {
  process.env.PLUGIN_INDEX_URL = "";
  try {
    assert.equal((await req(base, "GET", "/api/admin/plugins", { sid: admin.sid })).json.communityIndex, false);
    const r = await req(base, "GET", "/api/admin/plugins/community", { sid: admin.sid });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /PLUGIN_INDEX_URL/);
  } finally { process.env.PLUGIN_INDEX_URL = box.url("/plugins.json"); }
});
