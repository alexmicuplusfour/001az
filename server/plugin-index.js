// The community index — `community/plugins.json` in the app repo, a list of
// pointers at plugins other people wrote (community-index-plan.md). The rules:
// what a well-formed file and entry are, and what an entry must agree with the
// manifest at its source about — read by the reviewer's script
// (scripts/check-plugin-index.mjs) on every change to the file; pure. The
// fetch: the server pulls the file from its URL when an admin opens the
// Community tab, and builds the tab's rows over the live install records.
import { resolveSource, readBody } from "./plugin-fetch.js";
import { PLUGIN_API_VERSION } from "./plugin-ctx.js";
import { validateManifest, catalogIdFor } from "./plugin-loader.js";
import { manifestEntry } from "./plugins.js";
import { listExternalPlugins } from "./db.js";
import { compatFetch } from "./ai-providers/wires/compat.js";

// The version of the file's own shape this app reads.
const INDEX_API_VERSION = 1;

// An entry's fields, in the doc's order; any other field is ignored. Everything
// the tab shows rides in the entry, so browsing costs one file fetch and never
// a per-plugin read.
export const ENTRY_FIELDS = ["id", "kind", "domain", "label", "description", "author", "version", "apiVersion", "source"];

// An exact npm version — what `npm:name@<version>` may carry: no range, no tag.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

// An entry's source, resolved, or why it can't be one: a GitHub source at a
// full commit sha, or an npm package at an exact version. A tag or a branch
// moves, and a tarball URL has no pin — a listing is reviewed once, so what
// it points at must not change (D2).
export function entrySource(source) {
  let s;
  try { s = resolveSource(source); } catch (e) { return { problem: e.message }; }
  if (s.kind === "github") {
    if (!FULL_SHA.test(s.ref || ""))
      return { problem: `source must pin a full 40-character commit sha (github:owner/repo[/dir]@<sha>), not "${s.ref || "the default branch"}" — a tag or a branch moves` };
    return { source: s };
  }
  if (s.kind === "npm") {
    if (!EXACT_VERSION.test(s.version || ""))
      return { problem: `source must pin an exact npm version (npm:name@1.2.3), not "${s.version || "latest"}"` };
    return { source: s };
  }
  return { problem: `source must be a GitHub commit or an npm version, not a ${s.kind === "file" ? "path" : "tarball URL"}` };
}

// What's wrong with one entry, as sentences; empty when nothing is. The fields
// an entry shares with a manifest are held to the manifest's own rules — the
// loader's validateManifest, with the app's apiVersion in place of the
// entry's, which may name one this app doesn't speak yet (D4) and is only
// held to being a positive integer here. Only the entry's own fields go in:
// any other is ignored, however a manifest would read it.
function entryProblems(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["an entry must be an object"];
  const problems = [];
  const own = Object.fromEntries(ENTRY_FIELDS.filter((f) => f in e).map((f) => [f, e[f]]));
  try { validateManifest({ ...own, main: "index.js", apiVersion: PLUGIN_API_VERSION }); }
  catch (err) { problems.push(err.message.replace(/\bmanifest\./g, "entry.")); }
  if (!Number.isInteger(e.apiVersion) || e.apiVersion < 1) problems.push("entry.apiVersion must be a positive integer");
  for (const f of ["description", "author"])
    if (typeof e[f] !== "string" || !e[f]) problems.push(`entry.${f} is required — a non-empty string`);
  if (e.version == null || e.version === "") problems.push("entry.version is required — a non-empty string");
  if (typeof e.source !== "string" || !e.source) problems.push("entry.source is required");
  else { const { problem } = entrySource(e.source); if (problem) problems.push(problem); }
  return problems;
}

// The whole file: its own shape, every entry's, and no two entries making one
// catalog id (`ai:x`, `<domain>:x`, `source:x` — the loader's uniqueness; the
// id alone may repeat across kinds, as the loader allows). A fault in the file
// itself throws; entry faults come back as `problems`, one line each, so a
// review sees them all at once, and `plugins` are the entries without one —
// the reviewer refuses the file on any problem, while the server shows the
// readable entries and logs the rest (D4: a later index may carry what an
// older app can't read). `reserved` maps catalog ids no entry may take to the
// sentence that says why: the reviewer reserves the app's bundled examples
// (D11); the server reserves none, since a fork's own index is its
// operator's choice.
export function validateIndex(text, { reserved = null } = {}) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(`the index is not valid JSON: ${e.message}`); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("the index must be an object");
  if (doc.apiVersion !== INDEX_API_VERSION)
    throw new Error(`index apiVersion ${JSON.stringify(doc.apiVersion)} — this app reads ${INDEX_API_VERSION}`);
  if (!Array.isArray(doc.plugins)) throw new Error("the index's `plugins` must be an array");
  const problems = [];
  const seen = new Map();
  const plugins = [];
  doc.plugins.forEach((e, i) => {
    const where = `plugins[${i}]${typeof e?.id === "string" ? ` (${e.id})` : ""}`;
    const own = entryProblems(e);
    for (const p of own) problems.push(`${where}: ${p}`);
    if (own.length) return;
    const cid = catalogIdFor(e);
    if (reserved?.has(cid)) { problems.push(`${where}: ${reserved.get(cid)}`); return; }
    if (seen.has(cid)) { problems.push(`${where}: makes the same catalog id as plugins[${seen.get(cid)}], ${cid}`); return; }
    seen.set(cid, i);
    plugins.push(e);
  });
  return { plugins, problems };
}

// What the manifest at the source must agree with the entry about, as
// sentences naming the field: what the tab shows and the loader keys on, and
// the version when the manifest names one. `description` may differ — the
// index's can be shorter.
export function manifestMismatches(entry, manifest) {
  const fields = ["id", "kind", "label", "apiVersion"];
  if (["connector-provider", "connector-domain"].includes(entry.kind)) fields.push("domain");
  if (manifest.version != null) fields.push("version");
  return fields.filter((f) => entry[f] !== manifest[f])
    .map((f) => `${f}: the entry says ${JSON.stringify(entry[f])}, the manifest ${JSON.stringify(manifest[f])}`);
}

// --- the server's side: the fetch, and the Community tab's rows ---

// Where the index is read from. Empty turns the Community tab off — the
// air-gapped answer, as the price learner's URL is (D8); a fork lists its own
// file. Read per call, never at import: the env is fixed at boot in
// production, and the tests move it.
const DEFAULT_INDEX_URL = "https://raw.githubusercontent.com/alexmicuplusfour/001az/main/community/plugins.json";
export const indexUrl = () => process.env.PLUGIN_INDEX_URL ?? DEFAULT_INDEX_URL;

const INDEX_TTL_MS = 10 * 60 * 1000; // raw.githubusercontent allows 60 an hour per IP; this holds one app at 6
const INDEX_TIMEOUT_MS = 15000; // it answers a click, not a schedule
const INDEX_MAX_BYTES = 1024 * 1024; // remote input; an entry is a few hundred bytes

// The last good fetch, per process: { url, entries, fetchedAt }.
let cache = null;

// The index's readable entries, fetched at most once per ten minutes. The last
// good copy answers until then, and a refresh that fails hands it back marked
// `stale` with the reason rather than emptying the tab; without one, no
// entries and the reason. A failed refresh doesn't advance the clock, so the
// next click retries (the price learner's rule). The cache remembers its URL,
// so a moved env never answers another file's rows. `now` is a parameter so
// tests drive the clock instead of resetting module state.
async function fetchPluginIndex({ now = Date.now() } = {}) {
  const url = indexUrl();
  const good = cache?.url === url ? cache : null;
  if (good && now - good.fetchedAt < INDEX_TTL_MS) return { entries: good.entries, fetchedAt: good.fetchedAt, stale: false, error: null };
  try {
    const res = await compatFetch("the plugin index", url, { signal: AbortSignal.timeout(INDEX_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const { plugins, problems } = validateIndex((await readBody(res, INDEX_MAX_BYTES, "the plugin index")).toString("utf8"));
    for (const p of problems) console.warn(`plugin index: skipped ${p}`);
    cache = { url, entries: plugins, fetchedAt: now };
    return { entries: plugins, fetchedAt: now, stale: false, error: null };
  } catch (e) {
    return good
      ? { entries: good.entries, fetchedAt: good.fetchedAt, stale: true, error: e.message }
      : { entries: [], fetchedAt: null, stale: false, error: e.message };
  }
}

// The Community tab's rows (D7): every entry as a catalog-shaped row — the
// manifest-only shape a bundled example has, with a `community` block where a
// bundled row has `bundled` — over the live install records, so `installed`
// flips the moment an install lands and never waits on the cache. `installed`
// is "an external row with this catalog id exists", healthy or errored, as
// bundledPlugins counts it; `updateAvailable` is "the pin differs" — no
// versions are compared anywhere, and an index install stores the entry's
// source verbatim, so the strings are the comparison. `needsApp`: an entry
// this app can read whose apiVersion isn't the one it speaks (D4).
export async function communityPlugins(db, opts) {
  const { entries, ...meta } = await fetchPluginIndex(opts);
  const installed = new Map((await listExternalPlugins(db)).map((r) => [r.id, r.source_url]));
  const plugins = entries.map((e) => {
    const id = catalogIdFor(e);
    const installedSource = installed.get(id) ?? null;
    return manifestEntry(id, e, {
      community: {
        source: e.source, version: e.version, apiVersion: e.apiVersion, author: e.author, domain: e.domain ?? null,
        installedSource, updateAvailable: installedSource != null && installedSource !== e.source,
        needsApp: e.apiVersion !== PLUGIN_API_VERSION,
      },
      state: { installed: installedSource != null, config: {}, health: null },
    });
  });
  return { plugins, ...meta };
}
