// Reviews community/plugins.json, the community index: every entry is
// well-formed and pins an immutable source, and every entry that changed
// points at a plugin whose manifest says what the entry says. The plugin's
// code is downloaded and READ, never run — no import, no npm install — because
// this runs in CI on a stranger's pull request (community-index-plan.md, D9).
//
//   node scripts/check-plugin-index.mjs community/plugins.json [--base <file>]
//
// `--base` is the file as it was before the change (a pull request's base
// commit); entries it already lists exactly as they are aren't fetched again.
// With GITHUB_TOKEN in the environment, GitHub API calls carry it: a shared CI
// runner's IP has 60 unauthenticated calls an hour, a token a thousand.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { validateIndex, entrySource, manifestMismatches, ENTRY_FIELDS } from "../server/plugin-index.js";
import { fetchModule } from "../server/plugin-fetch.js";
import { manifestIn, catalogIdFor } from "../server/plugin-loader.js";
import { bundledManifests } from "../server/plugins.js";

// The app's bundled examples ship in the image and aren't listed (D11): an
// entry taking one's catalog id would offer "Update to …" on every server
// running that example, and one click would move it onto the listed source.
const RESERVED = new Map(bundledManifests().map(({ manifest }) => {
  const cid = catalogIdFor(manifest);
  return [cid, `${cid} is the app's bundled example ${manifest.label} — examples ship with the app and aren't listed`];
}));

// An entry as it was reviewed: every field it carries, so a change to any of
// them — a new label at the same pin, say — is a change to review. An absent
// field and a null one read alike, as the rules read them.
const asReviewed = (e) => JSON.stringify(ENTRY_FIELDS.map((f) => e[f]));

// The entries a base file already lists, by catalog id — its readable ones,
// since one it couldn't read was never reviewed — or none, when there is no
// base or it isn't an index (the change that creates the file).
function reviewed(baseText) {
  try { return new Map(validateIndex(baseText).plugins.map((e) => [catalogIdFor(e), asReviewed(e)])); }
  catch { return new Map(); }
}

// The problems, one line each, and the catalog ids that were fetched.
export async function checkIndex(text, { base = null } = {}) {
  const { plugins, problems } = validateIndex(text, { reserved: RESERVED });
  const fetched = [];
  if (problems.length) return { problems, fetched }; // the shape first: a fetch proves nothing about a malformed entry
  const already = reviewed(base);
  for (const [i, entry] of plugins.entries()) {
    const cid = catalogIdFor(entry);
    if (already.get(cid) === asReviewed(entry)) continue;
    const where = `plugins[${i}] (${entry.id})`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-index-"));
    try {
      const { source } = entrySource(entry.source);
      const { resolvedRef } = await fetchModule(source, dir);
      fetched.push(cid);
      // GitHub names an archive's top directory for the commit it was cut
      // from, and the installer keeps a sha ref as written only when the two
      // agree.
      if (source.kind === "github" && resolvedRef !== source.ref)
        problems.push(`${where}: the archive is cut from ${resolvedRef.split("@").pop()}, not the pinned commit`);
      for (const m of manifestMismatches(entry, manifestIn(dir))) problems.push(`${where}: ${m}`);
    } catch (e) {
      problems.push(`${where}: ${e.message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return { problems, fetched };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // The file and `--base` in either order; an unknown flag, or `--base` with
  // no file, is the usage line.
  let file, baseFile;
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: "string" } } });
    [file] = positionals;
    baseFile = values.base;
  } catch { file = null; }
  if (!file) {
    console.error("usage: node scripts/check-plugin-index.mjs <index.json> [--base <file>]");
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const real = globalThis.fetch;
    globalThis.fetch = (url, opts = {}) => (String(url).startsWith("https://api.github.com/")
      ? real(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } })
      : real(url, opts));
  }
  let result;
  try {
    result = await checkIndex(fs.readFileSync(file, "utf8"), { base: baseFile ? fs.readFileSync(baseFile, "utf8") : null });
  } catch (e) {
    console.error(`${file}: ${e.message}`);
    process.exit(1);
  }
  for (const p of result.problems) console.error(`${file}: ${p}`);
  console.log(`${file}: ${result.fetched.length} fetched, ${result.problems.length} problem(s)`);
  process.exit(result.problems.length ? 1 : 0);
}
