// Plugin source resolution + fetch (phase 2, slice 2). Turns an install URL into
// code on disk in a staging dir; the loader (server/plugin-loader.js) then
// validates, npm-installs, and registers it. Three source kinds:
//   github:owner/repo[/sub/dir][@ref]  |  https://github.com/owner/repo[/tree/ref[/sub/dir]]
//     — a subdir installs a plugin that lives INSIDE a repo (monorepo /
//       examples layout), so an app repo can ship installable examples
//   npm:name[@version]       |  a bare (scoped) package name
//   file:/abs/path or a local path — absolute or relative to the server's cwd
//     (dev / air-gapped / vendored; also the hermetic test vector — no network)
//   (a direct https .tgz URL is accepted too — download + extract)
//
// Network is confined here. The loader stays offline-testable: a file: source
// exercises the whole install path with no fetch and (for a dep-free plugin) no
// npm. URL parsing is unit-tested, and the tarball and GitHub downloads run
// against a local server in the tests; npm's registry lookup is the one
// network path they don't run.
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const FETCH_TIMEOUT_MS = Number(process.env.PLUGIN_FETCH_TIMEOUT_MS) || 60000;
const MAX_TARBALL_BYTES = Number(process.env.PLUGIN_MAX_TARBALL_BYTES) || 50 * 1024 * 1024;
const UA = "001az-plugin-installer";

// --- resolve a URL/spec to a source descriptor (pure, no IO) ---

// A repo-relative plugin dir ("examples/plugins/ollama"). Slashes trimmed; any
// empty/dot segment is refused — the subdir is joined onto an extract dir and
// must never climb out of it.
function cleanSubdir(subdir) {
  const d = String(subdir || "").replace(/^\/+|\/+$/g, "");
  if (!d) return null;
  if (d.split("/").some((p) => !p || p === "." || p === ".."))
    throw new Error(`invalid plugin subdirectory "${subdir}"`);
  return d;
}

function githubSource(owner, repo, ref, subdir) {
  // The API tarball endpoint defaults to the repo's default branch when ref is
  // empty, and redirects to codeload (fetch follows redirects).
  return {
    kind: "github", owner, repo, ref: ref || null, subdir: cleanSubdir(subdir),
    tarballUrl: `https://api.github.com/repos/${owner}/${repo}/tarball/${ref || ""}`,
  };
}

// The ref a GitHub install records: the ref as written ("default" for none),
// then the commit that actually ran — a branch and the default both move.
// GitHub names an API tarball's top directory `<owner>-<repo>-<sha7>` after
// the commit it was cut from (octocat/Hello-World → octocat-Hello-World-7fd1a60,
// measured 2026-09-25), and that short sha is itself a valid tarball ref, so a
// card's `main@7fd1a60` is a pin the admin can paste back. A ref that already
// is the commit stays as written, and a top directory with no sha on it records
// the ref alone.
function githubRef(ref, topDir) {
  const named = ref || "default";
  const sha = /-([0-9a-f]{7,40})$/.exec(topDir)?.[1];
  if (!sha) return named;
  if (/^[0-9a-f]{7,40}$/i.test(named) && named.toLowerCase().startsWith(sha)) return named;
  return `${named}@${sha}`;
}

function npmSource(spec) {
  const at = spec.lastIndexOf("@");
  const hasVersion = at > 0; // a leading @ is a scope, not a version separator
  return { kind: "npm", name: hasVersion ? spec.slice(0, at) : spec, version: hasVersion ? spec.slice(at + 1) : null };
}

export function resolveSource(url) {
  const s = String(url || "").trim();
  if (!s) throw new Error("a plugin source URL is required");

  if (s.startsWith("file:")) return { kind: "file", dir: path.resolve(fileURLToPath(s)), resolvedRef: "local" };
  if (s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("./") || s.startsWith("../"))
    return { kind: "file", dir: path.resolve(s), resolvedRef: "local" };

  let m = s.match(/^github:([^/@]+)\/([^/@]+)((?:\/[^@]*)*)(?:@(.+))?$/);
  if (m) return githubSource(m[1], m[2], m[4], m[3]);
  m = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/#?]+)((?:\/[^#?]*)?))?\/?$/);
  if (m) return githubSource(m[1], m[2], m[3], m[4]);

  if (s.startsWith("npm:")) return npmSource(s.slice(4));
  if (!s.includes("://") && /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@.+)?$/i.test(s))
    return npmSource(s);

  if (/^https?:\/\/.+\.(tgz|tar\.gz)(\?.*)?$/i.test(s)) return { kind: "tarball", tarballUrl: s, resolvedRef: "url" };

  // A bare relative path ("examples/plugins/ollama") — resolved against the
  // server's cwd, like any relative path. Recognized LAST so it can never
  // shadow the URL forms above; a typo'd URL-ish string errors readably at
  // fetch time ("local plugin path not found") instead of here.
  if (!s.includes("://") && /[\\/]/.test(s)) return { kind: "file", dir: path.resolve(s), resolvedRef: "local" };

  throw new Error(`unrecognized plugin source "${s}" — use github:owner/repo[/sub/dir], npm:name, an https tarball URL, or a local path`);
}

// --- fetch the resolved source into an (existing, empty) staging dir ---

async function downloadTarball(tarballUrl, stagingDir, headers = {}, subdir = null) {
  const res = await fetch(tarballUrl, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${tarballUrl}`);
  // Reject on the declared size first, then cap while streaming — an unbounded or
  // lying body must not be fully buffered (the droplet has 458 MB and no swap).
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES)
    throw new Error(`plugin tarball is too large (${declared} bytes > ${MAX_TARBALL_BYTES})`);
  const chunks = [];
  let total = 0;
  for await (const chunk of Readable.fromWeb(res.body)) {
    total += chunk.length;
    if (total > MAX_TARBALL_BYTES) throw new Error(`plugin tarball exceeds ${MAX_TARBALL_BYTES} bytes`);
    chunks.push(chunk);
  }
  const tgz = path.join(stagingDir, "__plugin.tgz");
  fs.writeFileSync(tgz, Buffer.concat(chunks));
  // GitHub and npm tarballs both wrap everything in one top-level directory.
  // Unpack aside and read that directory's name before dropping it — GitHub's
  // names the commit (githubRef above) — then lift the plugin into the staging
  // root: the wrapper's contents, or, for a plugin that lives inside a repo
  // (monorepo / examples layout), the subdir within it. The rest of the install
  // path sees a plain plugin dir like any other. tar runs with cwd inside
  // staging and a RELATIVE archive name, so a Windows drive-letter path (C:\…)
  // is never passed to it — GNU tar reads the ':' as a host:path spec.
  const unpack = path.join(stagingDir, ".unpack");
  fs.mkdirSync(unpack);
  await run("tar", ["-xzf", "../__plugin.tgz"], { cwd: unpack });
  fs.rmSync(tgz, { force: true });
  // One top-level directory. Loose files beside it (a macOS `._` entry, say)
  // are dropped, as --strip-components always dropped them.
  const dirs = fs.readdirSync(unpack, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (dirs.length !== 1)
    throw new Error("the archive must hold one top-level directory, as GitHub and npm tarballs do");
  const top = dirs[0].name;
  const src = subdir ? path.join(unpack, top, subdir) : path.join(unpack, top);
  if (subdir && !fs.existsSync(path.join(src, "manifest.json")))
    throw new Error(`no manifest.json under "${subdir}" in the repo — is that the plugin's directory?`);
  for (const name of fs.readdirSync(src)) fs.renameSync(path.join(src, name), path.join(stagingDir, name));
  fs.rmSync(unpack, { recursive: true, force: true });
  return top;
}

// Resolve the concrete tarball + version for an npm spec off the registry.
async function npmTarball(source) {
  const meta = await fetch(`https://registry.npmjs.org/${source.name}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`npm registry: HTTP ${r.status} for ${source.name}`))));
  const version = source.version || meta["dist-tags"]?.latest;
  const v = meta.versions?.[version];
  if (!v) throw new Error(`npm package ${source.name}@${source.version || "latest"} not found`);
  return { tarballUrl: v.dist.tarball, resolvedRef: version };
}

// Materialize `source` into `stagingDir`; returns { resolvedRef }. The dir must
// exist and be empty (the caller owns staging lifecycle + cleanup).
export async function fetchModule(source, stagingDir) {
  switch (source.kind) {
    case "file": {
      if (!fs.existsSync(source.dir) || !fs.statSync(source.dir).isDirectory())
        throw new Error(`local plugin path not found: ${source.dir}`);
      fs.cpSync(source.dir, stagingDir, { recursive: true });
      return { resolvedRef: "local" };
    }
    case "github": {
      const top = await downloadTarball(source.tarballUrl, stagingDir, { Accept: "application/vnd.github+json" }, source.subdir);
      return { resolvedRef: githubRef(source.ref, top) };
    }
    case "tarball":
      await downloadTarball(source.tarballUrl, stagingDir);
      return { resolvedRef: source.resolvedRef };
    case "npm": {
      const { tarballUrl, resolvedRef } = await npmTarball(source);
      await downloadTarball(tarballUrl, stagingDir);
      return { resolvedRef };
    }
    default:
      throw new Error(`unsupported source kind: ${source.kind}`);
  }
}
