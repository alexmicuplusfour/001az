// The board templates on the server (planning/templates-plan.md, Stage 3a):
// templates/, a folder per template, each checked by the rules its Paste
// buttons apply and by the rules a save applies, then two routes, the list
// and the screenshots. CI runs this file on every push and pull request, and
// its first test reads the real folder: that's what keeps a template that
// fails from being merged (D7).
//
// The broken templates are written here, into a temp folder, a JSON file and
// a few image bytes each, so every case reads in this file.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, adminSession, seedUser, req } from "./helpers.js";
import { createBoard } from "../server/db.js";
import { loadTemplates, SCREENSHOT_BYTES_MAX } from "../server/templates.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The first bytes each format starts with, which is what the check reads.
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

// A template that passes, to break one thing at a time.
const good = (over = {}) => ({
  name: "Good",
  description: "Passes every check.",
  guidance: { context: "Things.", facets: [{ key: "shade", label: "Shade", values: ["light", "dark"] }] },
  fields: [{ key: "brand", source: "extract", kind: "text", instruction: "the brand" }],
  ...over,
});

// A folder of templates: slug → { json (an object, or raw text), files }.
function writeTemplates(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "templates-"));
  for (const [slug, { json, files = {} }] of Object.entries(entries)) {
    fs.mkdirSync(path.join(dir, slug));
    fs.writeFileSync(path.join(dir, slug, "template.json"), typeof json === "string" ? json : JSON.stringify(json));
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, slug, name), bytes);
  }
  return dir;
}

test("every template in the repo passes", () => {
  const dir = path.join(REPO, "templates");
  const { templates, failures } = loadTemplates(dir);
  assert.deepEqual(failures, []);
  const folders = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(templates.map((t) => t.slug), folders, "every folder is a template");
});

// The image workflow rebuilds the app image only for the paths it lists, and
// a merged template that isn't on that list would ship nowhere: the old image
// is retagged instead (Stage 3a close look, finding 1).
test("the image workflow rebuilds the app when a template changes", () => {
  const yml = fs.readFileSync(path.join(REPO, ".github/workflows/images.yml"), "utf8");
  const line = yml.split("\n").find((l) => l.includes('build="$build app"'));
  const pattern = line?.match(/hit '([^']+)'/)?.[1];
  assert.ok(pattern, "the app's line in images.yml");
  assert.match("templates/products/template.json", new RegExp(pattern));
});

test("each rule refuses a template that breaks it, and says which", () => {
  const cases = {
    // The file.
    "not-json": { json: "{ name: Good", want: /template\.json isn't JSON/ },
    "no-name": { json: good({ name: undefined }), want: /"name" must be text/ },
    "a-typo": { json: { ...good(), boardtype: "stocks" }, want: /"boardtype" isn't a template key/ },
    Bad_Slug: { json: good(), want: /lowercase letters, digits and dashes/ },
    "no-sections": { json: good({ guidance: undefined, fields: undefined }), want: /needs a context, a facet or a field to set up/ },
    "empty-sections": { json: good({ guidance: { facets: [] }, fields: [] }), want: /needs a context, a facet or a field to set up/ },
    "type-and-key": { json: good({ boardType: "stocks", cardKey: "brand" }), want: /a card key is for a Files board/ },
    "key-names-nothing": { json: good({ cardKey: "model" }), want: /the card key "model" names none of the fields/ },
    "paste-refuses": { json: good({ fields: [{ key: "season", label: "Season", values: ["summer"] }] }), want: /^fields: that's a taxonomy/ },
    "reserved-facet": { json: good({ guidance: { facets: [{ key: "~objects", label: "Objects", values: [] }] } }), want: /^guidance: facet key "~objects" is reserved/ },
    // A key inside a section that a board doesn't keep would load and do nothing.
    "guidance-typo": { json: good({ guidance: { contxt: "Things.", facets: [] } }), want: /^guidance: "contxt" isn't a guidance key/ },
    "facet-typo": { json: good({ guidance: { facets: [{ key: "shade", label: "Shade", values: [], singel: true }] } }), want: /^guidance: "singel" isn't a facet key/ },
    "field-typo": { json: good({ fields: [{ key: "brand", kind: "text", instructions: "the brand" }] }), want: /^fields: "instructions" isn't a field key/ },
    "shot-typo": { json: good({ screenshots: [{ file: "a.webp", captoin: "The board" }] }), files: { "a.webp": WEBP }, want: /^"captoin" isn't a screenshot key/ },
    // A facet that would load and never be tagged: Paste takes these into the
    // editor, where they show and get fixed; a template has no editor.
    "facet-no-key": { json: good({ guidance: { facets: [{ label: "色", values: ["赤"] }] } }), want: /^guidance: each facet needs a key/ },
    "facet-slash": { json: good({ guidance: { facets: [{ key: "size/fit", label: "Size", values: ["s"] }] } }), want: /^guidance: the facet key "size\/fit" can't hold a "\/"/ },
    "facet-fit": { json: good({ guidance: { facets: [{ key: "fit", label: "Fit", values: ["slim"] }] } }), want: /^guidance: the facet key "fit" is the tagger's own verdict/ },
    "facet-twice": {
      json: good({ guidance: { facets: [{ key: "shade", label: "Shade", values: ["light"] }, { key: "shade", label: "Tone", values: ["warm"] }] } }),
      want: /^guidance: two facets have the key "shade"/,
    },
    "facet-no-label": { json: good({ guidance: { facets: [{ key: "shade", values: ["light"] }] } }), want: /^guidance: facet "shade" needs a label/ },
    "values-as-text": { json: good({ guidance: { facets: [{ key: "size", label: "Size", values: "s, m, l" }] } }), want: /^guidance: facet "size" needs its values, a list of text/ },
    "values-as-numbers": { json: good({ guidance: { facets: [{ key: "year", label: "Year", values: [2023, 2024] }] } }), want: /^guidance: facet "year" needs its values, a list of text/ },
    "value-twice": { json: good({ guidance: { facets: [{ key: "shade", label: "Shade", values: ["light", "light"] }] } }), want: /^guidance: facet "shade" lists a value twice/ },
    "single-as-text": { json: good({ guidance: { facets: [{ key: "shade", label: "Shade", values: ["light"], single: "false" }] } }), want: /^guidance: "single" on facet "shade" must be true or false/ },
    // A match list with nothing in it, which the Mapping pane refuses at Save.
    "empty-options": { json: good({ fields: [{ key: "brand", kind: "text", options: [{ value: " " }] }] }), want: /^fields: the options of "brand" are empty/ },
    // What a save refuses.
    "unknown-kind": { json: good({ fields: [{ key: "price", kind: "integer" }] }), want: /invalid kind "integer" for field "price"/ },
    "thirteen-fields": { json: good({ fields: Array.from({ length: 13 }, (_, i) => ({ key: `f${i}`, kind: "text" })) }), want: /at most 12 extract fields/ },
    "clash": { json: good({ boardType: "stocks", fields: [{ key: "sector", kind: "text" }] }), want: /duplicate field key: sector/ },
    // The images.
    "unlisted": { json: good(), files: { "a.webp": WEBP }, want: /a\.webp is in the folder but not in screenshots/ },
    "missing": { json: good({ screenshots: [{ file: "a.webp" }] }), want: /a\.webp is in screenshots but not in the folder/ },
    "png-by-name": { json: good({ screenshots: [{ file: "a.png" }] }), files: { "a.png": PNG }, want: /a lowercase \.webp, \.jpg or \.jpeg name/ },
    "png-by-bytes": { json: good({ screenshots: [{ file: "a.webp" }] }), files: { "a.webp": PNG }, want: /a\.webp isn't a WebP image/ },
    "oversize": {
      json: good({ screenshots: [{ file: "a.jpg" }] }),
      files: { "a.jpg": Buffer.concat([JPEG, Buffer.alloc(SCREENSHOT_BYTES_MAX)]) },
      want: /a\.jpg is 201 KB, over the 200 KB/,
    },
    "four-shots": {
      json: good({ screenshots: ["a", "b", "c", "d"].map((n) => ({ file: `${n}.jpg` })) }),
      files: Object.fromEntries(["a", "b", "c", "d"].map((n) => [`${n}.jpg`, JPEG])),
      want: /3 screenshots at most/,
    },
    // And one that passes, screenshots and all, its captions trimmed and an
    // empty one left out.
    good: {
      json: good({ screenshots: [{ file: "cover.webp", caption: " The board " }, { file: "detail.jpg", caption: " " }] }),
      files: { "cover.webp": WEBP, "detail.jpg": JPEG },
    },
  };
  const dir = writeTemplates(cases);
  try {
    const { templates, failures } = loadTemplates(dir);
    const why = Object.fromEntries(failures.map((f) => [f.slug, f.error]));
    for (const [slug, { want }] of Object.entries(cases)) {
      if (want) assert.match(why[slug] ?? "(it loaded)", want, slug);
    }
    assert.deepEqual(templates.map((t) => t.slug), ["good"]);
    assert.deepEqual(templates[0].screenshots, [{ file: "cover.webp", caption: "The board" }, { file: "detail.jpg" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A plugin's type is there only where its plugin is installed, so a template
// for one is checked the same way on every server: its own fields, and not
// against starting fields the server may not have.
test("a template naming a type this server doesn't have loads, its fields checked alone", () => {
  const dir = writeTemplates({
    films: { json: good({ boardType: "films", fields: [{ key: "sector", kind: "text" }] }) },
    "films-bad-kind": { json: good({ boardType: "films", fields: [{ key: "year", kind: "integer" }] }) },
  });
  try {
    const { templates, failures } = loadTemplates(dir);
    assert.deepEqual(templates.map((t) => t.slug), ["films"], "a key Stocks starts with is no clash for another type");
    assert.deepEqual(failures.map((f) => f.slug), ["films-bad-kind"]);
    assert.match(failures[0].error, /invalid kind "integer"/, "its own fields are still checked");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The server ──────────────────────────────────────────────────────────────

let srv, admin, member, dir;
// The server's own log on its way to Admin → Logs: its console hook
// (server.js) calls through to whatever console.error was when it loaded.
const logged = [];

before(async () => {
  const realError = console.error;
  console.error = (...args) => { logged.push(args.join(" ")); realError(...args); };
  dir = writeTemplates({
    good: { json: good({ screenshots: [{ file: "cover.webp" }] }), files: { "cover.webp": WEBP } },
    broken: { json: good({ name: "", screenshots: [{ file: "cover.webp" }] }), files: { "cover.webp": WEBP } },
  });
  srv = await startServer({ templatesDir: dir });
  admin = await adminSession(srv.db);
  member = await seedUser(srv.db, "member@test.local");
});
after(async () => {
  await srv?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("a failing template is logged and left out; the server starts and lists the rest, as checked", async () => {
  assert.ok(logged.some((l) => l.includes(`template broken: left out — "name" must be text`)), logged.join("\n"));
  const r = await req(srv.base, "GET", "/api/admin/templates", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, loadTemplates(dir).templates);
  assert.deepEqual(r.json.map((t) => t.slug), ["good"]);
});

// Every admin route answers 403 to a member and to nobody alike (auth.js
// requireAdmin).
test("the list is admins' only", async () => {
  assert.equal((await req(srv.base, "GET", "/api/admin/templates", { sid: member.sid })).status, 403);
  assert.equal((await req(srv.base, "GET", "/api/admin/templates")).status, 403);
});

test("a loaded template's listed screenshot goes to anyone logged in, and nothing else comes through", async () => {
  const get = (p, sid) => fetch(`${srv.base}${p}`, { headers: sid ? { Cookie: `sid=${sid}` } : {} });
  for (const who of [admin, member]) {
    const r = await get("/template-shots/good/cover.webp", who.sid);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/webp");
    assert.equal(r.headers.get("cache-control"), "no-cache");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), WEBP);
  }
  assert.equal((await get("/template-shots/good/cover.webp")).status, 401, "logged out");
  for (const p of [
    "/template-shots/good/template.json", // the file beside it
    "/template-shots/broken/cover.webp", // a left-out template's image
    "/template-shots/good/%2e%2e%2f%2e%2e%2fpackage.json", // out of the folder
    "/template-shots/nothing/cover.webp",
  ]) {
    assert.equal((await get(p, admin.sid)).status, 404, p);
  }
});

// The rule moved to template-core.js so a template is held to it; a save
// still reads it from there.
test("a save still refuses a reserved facet key", async () => {
  const id = await createBoard(srv.db, "Facets", [], "", true, null, null, { enabled: false });
  const r = await req(srv.base, "PATCH", `/api/admin/boards/${id}`, {
    sid: admin.sid, body: { facets: [{ key: "~objects", label: "Objects", values: [] }] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /facet key "~objects" is reserved/);
});
