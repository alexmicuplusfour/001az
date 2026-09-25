// Remove in a real browser (planning/plugin-contract-plan.md, Stage 5). An
// uninstall deletes what a plugin saved along with its code — a source's
// connections too, since this stage, where they used to outlive it — and the
// confirm names what goes before anything does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openApp } from "./harness.js";
import { adminSession, req } from "../helpers.js";
import { setPassword, listSourceConnections } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";

let app, admin, tmp;

// A plugin directory to install from, under this file's temp root.
const plugin = (name, manifest, code) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ apiVersion: 1, main: "index.js", ...manifest }));
  fs.writeFileSync(path.join(d, "index.js"), code);
  return d;
};

before(async () => {
  app = await openApp();
  admin = await adminSession(app.db);
  // A passwordless account is a half-created one — /api/me says
  // needs_password and the page bounces to /login.html before rendering.
  await setPassword(app.db, admin.id, await hashPassword("plugin-remove-pw"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-remove-"));
});

after(async () => {
  await app?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("uninstalling a source names the connection it deletes — and deletes it", async () => {
  // A source plugin whose connections hold a secret.
  const dir = plugin("vault", { id: "acme.vault", kind: "source", label: "Vault" }, `export default () => ({
  manifest: {
    name: "acme.vault", label: "Vault", needsConnection: true,
    connectionSchema: [{ key: "host", label: "Host", type: "text" }, { key: "token", label: "Token", type: "secret" }],
  },
  backend: () => ({}),
});
`);
  const install = await req(app.base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: { url: dir } });
  assert.equal(install.status, 200, JSON.stringify(install.json));
  const conn = await req(app.base, "POST", "/api/admin/source-connections", {
    sid: admin.sid, body: { type: "acme.vault", label: "Vault one", config: { host: "h", token: "s3cret" } },
  });
  assert.equal(conn.status, 200, JSON.stringify(conn.json));

  const page = await app.open("/admin#plugins", { sid: admin.sid });
  const row = page.locator(".plugin-row", { hasText: "Vault" });
  await row.waitFor();
  const asked = new Promise((resolve) => page.once("dialog", async (d) => { resolve(d.message()); await d.accept(); }));
  await row.locator("button:text-is('Remove')").click();
  const message = await asked;
  assert.match(message, /^Uninstall Vault\?/);
  assert.match(message, /This deletes its 1 saved connection and its downloaded code\./, "named before it goes");
  await row.waitFor({ state: "detached" });

  assert.deepEqual(await listSourceConnections(app.db, "acme.vault"), [], "the connection and its secret went with it");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

// A domain plugin's Remove takes its domain, and with it every board on the
// domain and every other plugin providing it — which its confirm used to leave
// out, saying only that the code goes (plugin-contract-plan.md, Stage 5 second
// pass).
test("uninstalling a domain plugin names the domain that goes with it, and who else it stops", async () => {
  const provider = (label) => `{ label: "${label}", rpm: 30, burst: 5,
  async search() { return []; },
  async fetchEntity() { throw Object.assign(new Error("unknown"), { status: 404 }); },
  async list() { return []; } }`;
  const domainDir = plugin("domain", { id: "acme.tides", kind: "connector-domain", domain: "tides", label: "Tides" },
    `export default () => ({
  providers: { "acme.tides": ${provider("Acme Tides")} },
  defaultProvider: "acme.tides",
  manifest: {
    label: "Tides",
    fields: [{ key: "height", kind: "number", fn: "height", label: "Height (m)" }],
    template: { input: { connector: "tides" }, fields: [{ key: "height", source: "connector", kind: "number", fn: "height" }] },
    browse: { columns: [{ key: "name", label: "Harbour", kind: "text", primary: true }] },
  },
  faces: {},
});
`);
  const otherDir = plugin("other", { id: "other.tides", kind: "connector-provider", domain: "tides", label: "Other Tides" },
    `export default () => (${provider("Other Tides")});\n`);
  try {
    for (const dir of [domainDir, otherDir]) {
      const install = await req(app.base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: { url: dir } });
      assert.equal(install.status, 200, JSON.stringify(install.json));
    }

    const page = await app.open("/admin#plugins", { sid: admin.sid });
    const row = page.locator(".plugin-row", { hasText: "Acme Tides" });
    await row.waitFor();
    const asked = new Promise((resolve) => page.once("dialog", async (d) => { resolve(d.message()); await d.accept(); }));
    await row.locator("button:text-is('Remove')").click();
    const message = await asked;
    assert.match(message, /^Uninstall Acme Tides\?/);
    assert.ok(message.includes("It adds the tides domain, which goes with it: boards on tides stop refreshing, and Other Tides, which provides tides, stops working."), message);
    assert.ok(!message.includes("default tides provider"), "the domain says more than being its default");
    assert.match(message, /This deletes its downloaded code\./);
    await row.waitFor({ state: "detached" });

    const domains = await req(app.base, "GET", "/api/connectors", { sid: admin.sid });
    assert.ok(!domains.json.some((c) => c.name === "tides"), "the domain went with it");
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.failures, []);
  } finally {
    await req(app.base, "DELETE", "/api/admin/plugins/tides:other.tides", { sid: admin.sid });
  }
});
