// Builds the vendored front-end libraries (planning/ui-updates-plan.md, D2 and
// D3), each bundled into one ES module the browser loads as it is:
//   public/vendor/preact.mjs   Preact, the hooks it needs and htm
//   public/vendor/signals.mjs  plain signals (@preact/signals-core), for the
//                              board page alone (Stage 3)
//
// One committed file each, for the same reasons lightweight-charts is one.
// public/ runs in the browser without a build step (host dev and the tests
// serve the source), so nothing it imports may be a bare package name. And one
// bundle means one copy on every page: a second copy of Preact would break
// hooks, and a second copy of the signals core would be a second set of
// signals that the first can't see.
//
// Signals are a file of their own because the build can't drop the unused
// part of one pre-bundled file: inside preact.mjs they'd cost the admin page,
// which draws only chips, 1.4kB brotli it never uses (Stage 3's close look).
//
// Run it only to change a version: bump a pin below, run
// `node scripts/vendor-preact.mjs`, and commit what it writes. The packages
// are fetched into a temp folder, the way build-frontend.mjs fetches esbuild,
// so nothing is added to package.json and the image's npm layer doesn't move.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const PINS = { preact: "10.29.8", htm: "3.1.1", "@preact/signals-core": "1.14.4" };
// The same esbuild build-frontend.mjs pins, so the two agree on the syntax
// they read and write.
const ESBUILD = "esbuild@0.24.2";
const TOOLS = path.join(os.tmpdir(), "001az-vendor-preact");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "public", "vendor");

execFileSync("npm", [
  "i", "--prefix", TOOLS, "--no-save", "--no-audit", "--no-fund",
  ESBUILD, ...Object.entries(PINS).map(([name, version]) => `${name}@${version}`),
], { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });

// Through esbuild's own API rather than its command line: the banner below has
// spaces in it, and a shell would split it.
const esbuild = createRequire(import.meta.url)(path.join(TOOLS, "node_modules", "esbuild"));

// What the app gets: only what some page imports so far. Add an export when a
// stage first needs it.
//
// preact.mjs: `html` is htm bound to Preact's h, so a template string reads
// like JSX without a compile step. The hooks came with the toolbar (Stage 2),
// the first component with a timer of its own, and useErrorBoundary with its
// second pass (a toolbar row that throws). Component came with the cards
// (Stage 4): a card skips its redraw unless a prop changed, and the class
// form is what carries shouldComponentUpdate. Like Preact's wiring for signals,
// preact/hooks wires itself into Preact as soon as it loads, so the production
// build keeps it on every page that loads Preact, used there or not (measured:
// 0.45kB brotli).
//
// signals.mjs: `signal` holds a value and tells whatever read it when it
// changes; `computed` is a value worked out from signals and kept until one of
// them changes. Stage 3 caches the rail's counts and the filtered list this way.
// `effect` runs a function again whenever a signal it read changes, and
// `batch` makes several writes land as one change: Stage 5 draws the board
// page this way instead of on a dispatched event.
//
// A /*! comment is the kind a bundler keeps: build-frontend.mjs's
// --legal-comments=eof carries it to the end of the page's chunk, so what the
// browser downloads still names what it contains and where the licenses are.
const OUTPUTS = [
  {
    file: "preact.mjs",
    sourcefile: "vendor-preact-entry.js",
    entry: `
export { render, Component } from "preact";
export { useState, useEffect, useLayoutEffect, useRef, useErrorBoundary } from "preact/hooks";
import { h } from "preact";
import htm from "htm";
export const html = htm.bind(h);
`,
    banner: `/*! preact ${PINS.preact} (MIT) and htm ${PINS.htm} (Apache-2.0), bundled by scripts/vendor-preact.mjs. Their licenses: vendor/preact.LICENSE, vendor/htm.LICENSE. */`,
  },
  {
    file: "signals.mjs",
    sourcefile: "vendor-signals-entry.js",
    entry: `
export { signal, computed, effect, batch } from "@preact/signals-core";
`,
    banner: `/*! @preact/signals-core ${PINS["@preact/signals-core"]} (MIT), bundled by scripts/vendor-preact.mjs. Its license: vendor/signals-core.LICENSE. */`,
  },
];

for (const { file, sourcefile, entry, banner } of OUTPUTS) {
  const out = path.join(VENDOR, file);
  await esbuild.build({
    stdin: { contents: entry, resolveDir: TOOLS, sourcefile },
    bundle: true,
    format: "esm",
    minify: true,
    legalComments: "inline",
    banner: { js: banner },
    outfile: out,
    logLevel: "warning",
  });
  const bytes = await fs.readFile(out);
  console.log(`wrote public/vendor/${file}: ${(bytes.length / 1024).toFixed(1)}kB, ${(zlib.brotliCompressSync(bytes).length / 1024).toFixed(1)}kB brotli`);
}

// The license texts ride beside the bundles, as lightweight-charts.LICENSE does
// (build-frontend.mjs copies them into dist). htm ships no NOTICE file, so its
// Apache-2.0 text is all it asks to travel with it.
const LICENSES = { preact: "preact.LICENSE", htm: "htm.LICENSE", "@preact/signals-core": "signals-core.LICENSE" };
for (const [name, file] of Object.entries(LICENSES)) {
  await fs.copyFile(path.join(TOOLS, "node_modules", name, "LICENSE"), path.join(VENDOR, file));
}
