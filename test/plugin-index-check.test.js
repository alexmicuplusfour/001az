// The community index's reviewer (scripts/check-plugin-index.mjs) and the
// rules it runs (server/plugin-index.js): a file and its entries are held to
// their shape, an entry pins an immutable source, and a changed entry's
// manifest says what the entry says — read off a fetched archive, never run
// (community-index-plan.md, Stage 2). Hermetic: GitHub and npm answer from a
// fetch stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFetch, tgzOf, answering, npmAnswers } from "./helpers.js";
import { validateIndex } from "../server/plugin-index.js";
import { checkIndex } from "../scripts/check-plugin-index.mjs";

const FIX = (name) => fileURLToPath(new URL(`./fixtures/plugins/${name}`, import.meta.url));
const SHA = "3f2a9c1e7b0d4a5f6c8e9d0b1a2c3d4e5f6a7b8c";
const gecko = JSON.parse(fs.readFileSync(path.join(FIX("acme-gecko"), "manifest.json"), "utf8"));
const entry = (over = {}) => ({
  id: "acme.gecko", kind: "connector-provider", domain: "crypto", label: "Acme Gecko",
  description: "A crypto provider.", author: "acme", version: "1.0.0", apiVersion: 1,
  source: `github:acme/gecko@${SHA}`, ...over,
});
const index = (...plugins) => JSON.stringify({ apiVersion: 1, plugins });

// A GitHub archive the way the API serves one: a top directory named for the
// commit, the plugin's files inside — the fixture's manifest, or an edited one.
const archive = (manifest = gecko, { top = `acme-gecko-${SHA.slice(0, 7)}`, code = "export default () => ({});\n" } = {}) =>
  tgzOf([[`${top}/manifest.json`, JSON.stringify(manifest)], [`${top}/index.js`, code]]);
const TARBALL = `https://api.github.com/repos/acme/gecko/tarball/${SHA}`;
// One review against stubbed downloads: its answer, and every URL it asked for.
const review = async (text, answers = {}, opts) => {
  const run = answering(answers);
  return { ...(await withFetch(run.fetch, () => checkIndex(text, opts))), calls: run.calls };
};

test("validateIndex: the file's own shape, then every entry's, all reported at once", () => {
  assert.throws(() => validateIndex("{"), /not valid JSON/);
  assert.throws(() => validateIndex(JSON.stringify({ apiVersion: 2, plugins: [] })), /index apiVersion 2 — this app reads 1/);
  assert.throws(() => validateIndex(JSON.stringify({ apiVersion: 1, plugins: {} })), /`plugins` must be an array/);
  assert.deepEqual(validateIndex(index(entry())).problems, []);
  const refused = [
    [entry({ source: "github:acme/gecko@v1.2.0" }), /full 40-character commit sha.*"v1\.2\.0" — a tag or a branch moves/],
    [entry({ source: "github:acme/gecko@main" }), /commit sha/],
    [entry({ source: "github:acme/gecko" }), /not "the default branch"/],
    [entry({ source: `github:acme/gecko@${SHA.slice(0, 7)}` }), /commit sha/],
    [entry({ source: "https://example.com/gecko.tgz" }), /not a tarball URL/],
    [entry({ source: "/srv/plugins/gecko" }), /not a path/],
    [entry({ source: "npm:gecko@^1.0.0" }), /exact npm version.*"\^1\.0\.0"/],
    [entry({ source: "npm:gecko" }), /exact npm version.*"latest"/],
    [entry({ source: "" }), /entry\.source is required/],
    [entry({ kind: "widget" }), /entry\.kind must be one of/],
    [entry({ id: "gecko" }), /entry\.id must be a namespaced/],
    [entry({ version: 1 }), /entry\.version must be a string/],
    [entry({ version: "" }), /entry\.version is required/],
    [entry({ author: undefined }), /entry\.author is required/],
    [entry({ apiVersion: "1" }), /entry\.apiVersion must be a positive integer/],
    [entry({ kind: "connector-domain", domain: "embed" }), /reserved/],
    // The loader's sentence names the field mid-sentence; it's the entry's.
    [entry({ domain: undefined }), /connector-provider requires entry\.domain$/],
  ];
  for (const [e, re] of refused) {
    const { problems } = validateIndex(index(e));
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /^plugins\[0\] \(/);
    assert.match(problems[0], re);
  }
  assert.equal(validateIndex(index(entry({ kind: "widget" }), entry({ id: "gecko" }))).problems.length, 2, "every entry's, at once");
  // Any other field is ignored — a hint an older list carried, or one a later
  // list adds — however the manifest rules would read it.
  assert.deepEqual(validateIndex(index(entry({ kind: "ai-provider", domain: undefined, keyless: "yes", homepage: "https://acme.test" }))).problems, []);
  // Two entries making one catalog id are one plugin twice; one id across two
  // kinds is two plugins, as the loader keys them.
  assert.match(validateIndex(index(entry(), entry({ label: "Again" }))).problems[0],
    /^plugins\[1\] \(acme\.gecko\): makes the same catalog id as plugins\[0\], crypto:acme\.gecko$/);
  assert.deepEqual(validateIndex(index(
    entry({ kind: "ai-provider", domain: undefined, id: "acme.x", source: "npm:acme-x@1.0.0" }),
    entry({ kind: "source", domain: undefined, id: "acme.x", source: "npm:acme-x-src@1.0.0" }),
  )).problems, []);
  // `plugins` is the readable entries — what the server shows, logging the
  // rest; the reviewer refuses the whole file on any problem (Stage 3).
  assert.deepEqual(validateIndex(index(entry({ kind: "widget" }), entry(), entry({ label: "Again" }))).plugins, [entry()]);
});

test("checkIndex: a changed entry is fetched, and its manifest must say what the entry says — the code is never run", async () => {
  const good = { [TARBALL]: await archive(gecko, { code: "throw new Error('ran'); // never imported\n" }) };
  assert.deepEqual(await review(index(entry()), good), { problems: [], fetched: ["crypto:acme.gecko"], calls: [TARBALL] });
  // Each field the tab shows or the loader keys on, when the manifest disagrees.
  for (const [change, re] of [
    [{ label: "Gecko Pro" }, /label: the entry says "Gecko Pro", the manifest "Acme Gecko"/],
    [{ version: "2.0.0" }, /version: the entry says "2\.0\.0", the manifest "1\.0\.0"/],
    [{ apiVersion: 2 }, /apiVersion: the entry says 2, the manifest 1/],
  ]) {
    const { problems } = await review(index(entry(change)), good);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /^plugins\[0\] \(acme\.gecko\): /);
    assert.match(problems[0], re);
  }
  // A field the list doesn't have is never held against the manifest.
  assert.deepEqual((await review(index(entry({ keyless: true })), good)).problems, []);
  // The manifest's id and kind, and a connector's domain, the same way.
  const other = (await review(index(entry()), { [TARBALL]: await archive({ ...gecko, id: "acme.other", domain: "stocks" }) })).problems.join("\n");
  assert.match(other, /id: the entry says "acme\.gecko", the manifest "acme\.other"/);
  assert.match(other, /domain: the entry says "crypto", the manifest "stocks"/);
  // A manifest that names no version is held to nothing there: the entry's is the label.
  const unversioned = { ...gecko };
  delete unversioned.version;
  assert.deepEqual((await review(index(entry()), { [TARBALL]: await archive(unversioned) })).problems, []);
  // No manifest at all reads as the loader says it.
  const bare = { [TARBALL]: await tgzOf([[`acme-gecko-${SHA.slice(0, 7)}/index.js`, "export default () => ({});\n"]]) };
  assert.match((await review(index(entry()), bare)).problems[0], /no manifest\.json in/);
  // The archive's commit is the entry's: GitHub names the top directory for it.
  const moved = { [TARBALL]: await archive(gecko, { top: "acme-gecko-0badc0f" }) };
  assert.match((await review(index(entry()), moved)).problems[0], /cut from 0badc0f, not the pinned commit/);
});

test("checkIndex: entries the base already lists unchanged aren't fetched again — any change is", async () => {
  const answers = { [TARBALL]: await archive() };
  const e = entry();
  for (const [what, base, calls] of [
    ["the same file", index(e), []],
    ["a different pin", index(entry({ source: `github:acme/gecko@${"0".repeat(40)}` })), [TARBALL]],
    ["an entry the base lacks", index(), [TARBALL]],
    ["the same pin under another label", index(entry({ label: "Gecko Classic" })), [TARBALL]],
    ["a base that isn't an index (the change that creates the file)", "{}", [TARBALL]],
  ]) {
    assert.deepEqual(await review(index(e), answers, { base }),
      { problems: [], fetched: calls.length ? ["crypto:acme.gecko"] : [], calls }, what);
  }
  // The hole a source-only comparison left: a pull request relabelling a
  // listed plugin without moving its pin is checked against the manifest too.
  const out = await review(index(entry({ label: "Official Gecko" })), answers, { base: index(e) });
  assert.deepEqual(out.calls, [TARBALL]);
  assert.match(out.problems.join("\n"), /label: the entry says "Official Gecko", the manifest "Acme Gecko"/);
});

test("checkIndex: an entry taking a bundled example's catalog id is refused, and nothing is fetched", async () => {
  const ollama = { id: "community.ollama", kind: "ai-provider", domain: undefined, label: "Ollama" };
  assert.deepEqual(await review(index(entry({ ...ollama, source: `github:someone/ollama@${SHA}` }))), {
    problems: ["plugins[0] (community.ollama): ai:community.ollama is the app's bundled example Ollama — examples ship with the app and aren't listed"],
    fetched: [], calls: [],
  });
  // The server reserves nothing: a fork's own index is its operator's choice.
  assert.deepEqual(validateIndex(index(entry(ollama))).problems, []);
});

test("checkIndex: a malformed file fetches nothing, and an npm entry runs the installer's own registry path", async () => {
  // The shape comes first: one bad entry, and not even the good one is fetched.
  const bad = await review(index(entry(), entry({ id: "acme.x", source: "github:acme/gecko@main" })));
  assert.equal(bad.problems.length, 1);
  assert.deepEqual(bad.calls, []);
  // npm: the packument and the tarball, with the registry's integrity hash the
  // installer checks (Stage 1).
  const answers = npmAnswers("acme-gecko", "1.0.0",
    await tgzOf([["package/manifest.json", JSON.stringify(gecko)], ["package/index.js", "export default () => ({});\n"]]));
  assert.deepEqual(await review(index(entry({ source: "npm:acme-gecko@1.0.0" })), answers),
    { problems: [], fetched: ["crypto:acme.gecko"], calls: Object.keys(answers) });
});
