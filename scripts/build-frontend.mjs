// Frontend build: bundle + minify + content-hash each HTML entry into
// public/dist, then rewrite each HTML to point at the hashed names. The image
// sets STATIC_DIR=public/dist; host dev and the test suite keep serving
// public/ source, so nothing about the edit-reload loop changes.
//
// One file per page, per asset type. Deliberately NOT --splitting across
// entries: measured, shared chunking costs the board page 9 requests / 87 kB
// where a per-entry bundle is 1 request / 81 kB. Cross-page chunk reuse is
// worth less than the page people actually live on.
//
// Every content-hashed file lands under dist/_/ so the cache rule is a PATH
// rule the server can state plainly — /_/ is immutable, everything else
// revalidates — rather than a regex guessing at esbuild's hash alphabet.
// notification.mp3 and vendor/ are not hashed and stay at the root, where
// they correctly keep the revalidating header.
//
// No sourcemaps. They would be 3.9 MB against 1.1 MB for the whole rest of
// dist, and a map embeds the original source verbatim — re-publishing to
// every browser exactly the commentary the Dockerfile's comment-strip exists
// to keep in the repo. If prod debugging ever needs maps, the honest form is
// one uploaded somewhere that is not the web root.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// esbuild stays a pinned CLI fetched at build time, exactly as the Dockerfile
// fetched it before — no dependency added, no change to the image's npm layer,
// and the version lives here and nowhere else.
//
// Installed ONCE and then called directly, rather than through `npx` per
// invocation. Measured on this repo: 8 invocations through npx take 15.2 s of
// which esbuild's own work is 158 ms — 99% of the build was npm-CLI startup,
// paid again on every image build and every CI run. Resolving the binary once
// takes the same work to ~0.5 s.
const ESBUILD = "esbuild@0.24.2";
const TOOLS = path.join(os.tmpdir(), "001az-build-frontend");

execFileSync("npm", ["i", "--prefix", TOOLS, "--no-save", "--no-audit", "--no-fund", ESBUILD], {
  stdio: ["ignore", "ignore", "inherit"],
  shell: process.platform === "win32",
});
const BIN = path.join(TOOLS, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");

function esbuild(args) {
  try {
    execFileSync(BIN, args, { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
  } catch {
    // esbuild has already printed the real diagnostic to stderr. Two nested
    // node stack traces on top of it say nothing and bury it.
    console.error(`\nesbuild failed on: ${args[0]}`);
    process.exit(1);
  }
}
const metaOf = async (f) => JSON.parse(await fs.readFile(f, "utf8"));
// Six of the seven HTML files are CRLF and logs.html is LF, so anything this
// script splices in has to match the file it lands in.
const eolOf = (s) => (s.includes("\r\n") ? "\r\n" : "\n");

const SRC = "public";
const OUT = "public/dist";

// The pages to build. What each one LOADS is read out of its HTML rather than
// listed here, because the rewriter below deletes every local stylesheet link
// and writes one back: a hardcoded list would silently drop a stylesheet
// somebody added to the markup, and the verification pass could not catch it —
// the count would still be one. The markup is the source of truth.
//
// The roster is read off disk for the same reason. A hand-kept list would go
// stale the first time somebody adds a page: dev keeps working (source is
// served straight from public/), and the page 404s in production only.
const PAGES = (await fs.readdir(SRC))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.slice(0, -".html".length));

// Local stylesheet links, in cascade order, and the module script's src.
// Both spellings are in the tree (`styles.css` and `/styles.css`;
// `src` before or after `type="module"`), and six of the seven files are CRLF.
const LOCAL_CSS = /<link[^>]+rel="stylesheet"[^>]+href="\/?([a-z-]+)\.css"[^>]*>/g;
const MODULE_JS = /<script[^>]*src="\/?([a-z-]+\.js)"[^>]*><\/script>/;

function readPage(html, page) {
  const css = [...html.matchAll(LOCAL_CSS)].map((m) => m[1]);
  const js = html.match(MODULE_JS);
  if (!js) throw new Error(`${page}.html: no module script tag found`);
  return { js: js[1], css };
}

// Everything in the static root that is neither an entry nor an import gets
// copied across as-is: today the chime's audio (chime.js fetches
// "/notification.mp3" by name) and the vendor licence. The vendor .mjs itself
// is bundled into a lazy chunk and --legal-comments=eof carries its Apache-2.0
// notice into that chunk; the file is copied anyway because it costs nothing
// to keep the notice adjacent.
//
// Stated as an exclusion rather than an allowlist. An allowlist of the two
// files that happen to be there today would leave the next one — a favicon, an
// OG image — missing in production only.
// .mjs counts as built: vendor/lightweight-charts…mjs is bundled into a lazy
// chunk, so copying it across would ship 193 kB nothing ever requests.
const BUILT = new Set([".js", ".mjs", ".css", ".html"]);
async function copyAssets(dir = "") {
  for (const e of await fs.readdir(path.join(SRC, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (path.join(SRC, rel) === OUT) continue; // never copy the output into itself
    if (e.isDirectory()) { await copyAssets(rel); continue; }
    if (BUILT.has(path.extname(e.name))) continue;
    await fs.mkdir(path.join(OUT, dir), { recursive: true });
    await fs.copyFile(path.join(SRC, rel), path.join(OUT, rel));
  }
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, "_"), { recursive: true });

const hashed = {}; // page -> { js, css }
const wants = {};  // page -> the css set its HTML asked for, for the verification pass

for (const page of PAGES) {
  const { js, css } = readPage(await fs.readFile(path.join(SRC, `${page}.html`), "utf8"), page);
  wants[page] = { css };
  // JS. --splitting stays on per invocation so detail-chart.js's dynamic
  // import of the charting vendor still lands in its own lazy chunk; with one
  // entry per build there is no cross-entry sharing to pessimise.
  const jsMeta = path.join(OUT, `.meta-${page}.json`);
  esbuild([
    `${SRC}/${js}`, "--bundle", "--minify", "--format=esm", "--splitting",
    `--outdir=${OUT}`, `--entry-names=_/${page}-[hash]`, "--chunk-names=_/[name]-[hash]",
    "--legal-comments=eof", `--metafile=${jsMeta}`,
  ]);
  const jm = await metaOf(jsMeta);
  const entry = Object.entries(jm.outputs).find(([, v]) => v.entryPoint === `${SRC}/${js}`);
  hashed[page] = { js: "/_/" + path.basename(entry[0]) };

  // Chunks the entry imports STATICALLY are part of the boot payload, but the
  // browser cannot know they exist until it has parsed the entry — a second
  // round trip for files it was always going to need. A modulepreload link in
  // the HTML lets it fetch them alongside the entry instead. Measured at 50 ms
  // simulated latency: without, entry at +79 ms and chunks at +140 ms; with,
  // all of them in flight by +73 ms (planning/app-loading-plan.md, Stage 2).
  //
  // Static imports only. Chunks behind a dynamic import() are the ones we went
  // to the trouble of deferring — preloading those would undo the stage.
  const eager = new Set();
  (function walk(o) {
    if (eager.has(o)) return;
    eager.add(o);
    for (const i of jm.outputs[o]?.imports || []) if (i.kind === "import-statement") walk(i.path);
  })(entry[0]);
  eager.delete(entry[0]);
  hashed[page].preload = [...eager].map((o) => "/_/" + path.basename(o));
  await fs.rm(jsMeta, { force: true });
}

// CSS, all pages in ONE invocation. A generated entry per page @imports that
// page's set in link order, so esbuild concatenates and cross-minifies each
// into a single render-blocking request instead of five. Measured on
// index.html: 5 files / 17 kB -> 1 file / 15 kB.
//
// Batched, unlike the JS: esbuild has no CSS code splitting, so multiple CSS
// entry points in one build emit one file per entry with no cross-entry
// sharing — the pessimisation the JS loop exists to avoid cannot happen here.
// Verified byte-identical output, same content hash, batched or not.
//
// The generated entries live in OUT, not SRC: a crash between write and
// cleanup would otherwise leave strays in public/, where they are both repo
// litter and something a `public/*.css` glob would pick up. @import resolves
// relative to the entry file, hence the ../../ back to source.
const cssPages = PAGES.filter((p) => wants[p].css.length);
if (cssPages.length) {
  const gen = path.join(OUT, ".css-entries");
  const cssMeta = path.join(OUT, ".meta-css.json");
  try {
    await fs.mkdir(gen, { recursive: true });
    for (const page of cssPages) {
      await fs.writeFile(
        path.join(gen, `${page}.css`),
        wants[page].css.map((c) => `@import "../../${c}.css";`).join("\n"),
      );
    }
    esbuild([
      ...cssPages.map((p) => path.join(gen, `${p}.css`)),
      "--bundle", "--minify", `--outdir=${OUT}`,
      "--entry-names=_/[name]-[hash]", `--metafile=${cssMeta}`,
    ]);
    const cm = await metaOf(cssMeta);
    for (const [out, v] of Object.entries(cm.outputs)) {
      if (!out.endsWith(".css")) continue;
      const page = path.basename(v.entryPoint, ".css");
      hashed[page].css = "/_/" + path.basename(out);
    }
  } finally {
    await fs.rm(gen, { recursive: true, force: true });
    await fs.rm(cssMeta, { force: true });
  }
}

// HTML rewrite. Local stylesheet links are dropped wherever they sit and one
// hashed link is inserted at the position of the first one, which preserves
// cascade order relative to the inline <style> blocks that follow it. The
// Google Fonts link is not local and is left in place (it leaves in stage 5).
//
// \r?\n, not \n: six of the seven HTML files in public/ are CRLF and logs.html
// is LF. An \n-anchored match silently no-ops on the CRLF ones, and the build
// still exits 0 having emitted pages whose stylesheet hrefs point at files
// that are not in dist — an app that loads with no CSS whatsoever. That is
// what the verification pass at the bottom of this file exists to catch.
for (const [page, refs] of Object.entries(hashed)) {
  const file = path.join(SRC, `${page}.html`);
  let html = await fs.readFile(file, "utf8");

  // Same shape as LOCAL_CSS above, line-anchored so the whole line goes. The
  // two must stay in step: what gets counted has to be what gets removed, or
  // a link survives into dist pointing at a file that was never emitted.
  const localLink = /^[ \t]*<link[^>]+rel="stylesheet"[^>]+href="\/?[a-z-]+\.css"[^>]*>\r?\n/gm;
  const links = html.match(localLink) || [];
  if (links.length) {
    const first = html.indexOf(links[0]);
    const indent = links[0].match(/^[ \t]*/)[0];
    const eol = links[0].endsWith("\r\n") ? "\r\n" : "\n";
    html = html.replace(localLink, "");
    html = html.slice(0, first) + `${indent}<link rel="stylesheet" href="${refs.css}" />${eol}` + html.slice(first);
  }

  // Both spellings exist in the tree: src="app.js" and src="/boards.js", with
  // type="module" on either side of the src attribute.
  const before = html;
  const preloads = (refs.preload || [])
    .map((u) => `    <link rel="modulepreload" href="${u}" />`)
    .join(eolOf(html));
  html = html.replace(
    /<script([^>]*)src="\/?[a-z-]+\.js"([^>]*)><\/script>/,
    `<script$1src="${refs.js}"$2></script>`,
  );
  if (html === before) throw new Error(`${page}.html: no module script tag matched`);
  // In <head>, beside the stylesheet: the point is for the browser to see these
  // while it is still parsing the head, not when it reaches the script at the
  // bottom of the body. Anchored on a regex that captures whatever indent the
  // file uses rather than a literal two spaces — this is the one rewrite whose
  // absence costs a round trip and changes nothing visible, so it must not be
  // able to no-op quietly. The verification pass counts them.
  if (preloads) {
    const at = html;
    html = html.replace(/^([ \t]*)<\/head>/m, (m, indent) => preloads + eolOf(html) + indent + "</head>");
    if (html === at) throw new Error(`${page}.html: no </head> to place modulepreload hints before`);
  }

  await fs.writeFile(path.join(OUT, `${page}.html`), html);
}

await copyAssets();

// Verify, because a rewrite that matched nothing is indistinguishable from a
// rewrite that worked until someone loads the page. Every local href/src in
// every emitted HTML must resolve to a file that exists in dist, and every
// page that had stylesheets must end up with exactly one.
let bad = 0;
for (const page of Object.keys(hashed)) {
  const html = await fs.readFile(path.join(OUT, `${page}.html`), "utf8");
  // Asset references only — <link rel=stylesheet href> and <script src>. Plain
  // <a href> is page navigation (profile.html links /login.html?change=1&…),
  // which is the server's business, not a file that has to sit in dist.
  const local = (u) => !/^(https?:)?\/\//.test(u) && !u.startsWith("data:");
  const sheetHrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const preloadHrefs = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map((m) => m[1]);

  for (const u of [...sheetHrefs, ...scriptSrcs, ...preloadHrefs].filter(local)) {
    const onDisk = path.join(OUT, u.replace(/^\//, ""));
    if (!(await fs.access(onDisk).then(() => true).catch(() => false))) {
      console.error(`  MISSING  ${page}.html -> ${u}`);
      bad++;
    }
  }
  // Hashed output is whatever sits under /_/ — the path convention this build
  // exists to establish. Matching on the hash's own alphabet instead would be
  // the guess the /_/ layout was chosen to avoid, and would turn an esbuild
  // bump into a false failure.
  const sheets = sheetHrefs.filter((u) => u.startsWith("/_/")).length;
  const want = wants[page].css.length ? 1 : 0;
  if (sheets !== want) {
    console.error(`  ${page}.html: ${sheets} hashed stylesheet link(s), expected ${want}`);
    bad++;
  }
  // …and nothing local survived un-hashed. This is the check that a stylesheet
  // added to the markup can never be silently dropped: it would either still be
  // here pointing at a name dist does not carry, or have been swept into the
  // bundle. Either way the count above stays 1, so only this catches it.
  for (const u of sheetHrefs.filter((u) => local(u) && !u.startsWith("/_/"))) {
    console.error(`  ${page}.html: un-hashed local stylesheet survived the rewrite -> ${u}`);
    bad++;
  }
  // The preload hints are the one output whose absence is invisible — the page
  // works, one round trip slower. So they get counted like everything else.
  if (preloadHrefs.length !== (hashed[page].preload || []).length) {
    console.error(`  ${page}.html: ${preloadHrefs.length} modulepreload link(s), expected ${(hashed[page].preload || []).length}`);
    bad++;
  }
}
if (bad) throw new Error(`${bad} unresolved reference(s) in built HTML`);

console.log(`built ${PAGES.length} pages -> ${OUT}`);
for (const [p, r] of Object.entries(hashed)) console.log(`  ${p}: ${r.js} ${r.css || "(no css)"}`);
