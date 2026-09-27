# Serif titles, self-hosted fonts (2026-09-26)

**Status: Stages 1-3 BUILT 2026-09-26 (uncommitted). Verified on compose
:8001 (rebuilt after Stage 2 and again after Stage 3) and on the
source-served path.**

## The ask

Titles switch to Source Serif 4 semibold and grow:

- modal titles, plus the titles inside modals (edit board, plugins, add
  plugin, jobs, the provider modal, and the rest);
- admin and account: page and section titles, and the stat numbers (usage,
  storage);
- lightbox side panel: its "Details" title and its section titles.

Second round:

- two sizes only: 18px for a header-bar title (modal, lightbox panel), 22px
  for the section titles under it (corrected after Stage 3: they were built
  at 18), a page's own title and the stats;
- load the whole Source Serif 4 family;
- the existing prose serif becomes Source Serif too;
- stop loading fonts from Google and serve them ourselves;
- "do a proper job": tear down and consolidate whatever's in the way.

## What's there today

Title type is spread over five places, and none of them agree on how:

| Title | Where the type is set | Today |
|---|---|---|
| Modal title (every `createModal`) | [modal.css:57](../public/modal.css#L57) `.modal-title` | Inter 15/600 |
| Section titles in modals and in the lightbox panel ("Tagging Settings", "API Keys", "Connector fields", "Tags") | [modal.js:287-290](../public/modal.js#L287-L290) `sectionHeading()`, an **inline** `style="font-size:16px"` on the h2 | Inter 16/**700** (h2 is bold by default) |
| Lightbox panel title ("Details") | [styles.css:2393](../public/styles.css#L2393) `.lbp-head`, set on the whole flex row; the word is a bare `<span>` ([index.html:41](../public/index.html#L41)) | Inter 14/600 |
| Admin/account page title | [panel.css:14](../public/panel.css#L14) bare `h1`, whose margin [panel.css:19](../public/panel.css#L19) `.page-head h1` then overrides | Inter 19/**700** |
| Admin/account section titles | [panel.css:33](../public/panel.css#L33) `.panel > h2` and [panel.css:110](../public/panel.css#L110) `.section h2`, the same rule written twice | Inter 16/**700** |
| Stat numbers (usage, storage) | [admin.html:135](../public/admin.html#L135) `.kpi .v`, in the page's inline `<style>` | Inter 20/600 |

Other things in the way:

- **Fonts come from Google.** Six pages each carry two `preconnect`s and a
  stylesheet link from `fonts.googleapis.com` (lines 7-9), and that stylesheet
  pulls the font files from `fonts.gstatic.com`. The CSP opens both origins
  for it ([server.js:314-315](../server/server.js#L314-L315)). The build
  leaves that link in place with a note saying it "leaves in stage 5"
  ([build-frontend.mjs:201](../scripts/build-frontend.mjs#L201)). That's
  [app-loading-plan.md](app-loading-plan.md)'s Stage 5, which was planned and
  never built. This arc builds it.
- **Font tokens only exist on four of the six pages.** `--sans` and `--serif`
  are defined in styles.css ([styles.css:18-22](../public/styles.css#L18-L22)),
  which admin.html and account.html don't load. panel.css restates the Inter
  stack by hand ([panel.css:9](../public/panel.css#L9)). modal.css uses
  `var(--serif)` and `var(--sans)` with no fallback, so when the board editor
  opens on the admin page, the tagging-consistency notices should come out in
  Inter instead of the serif (read from the code, not yet checked in a
  browser).
- **The prose serif is whatever the OS has**: Iowan Old Style on a Mac,
  Palatino Linotype on Windows, Georgia elsewhere. Its comment says there's
  no second webfont on purpose ([styles.css:19-21](../public/styles.css#L19-L21)).
  Now that we're shipping one, that reason no longer holds.
- `sectionHeading()` has a `style` argument that nothing passes, and its sub
  line is inline-styled too. plugin-modal.js finds that sub line with
  `querySelector("p")` and has a comment explaining it
  ([plugin-modal.js:211-215](../public/plugin-modal.js#L211-L215)).

## Target

### The fonts: `public/fonts/`

The files are Google's own subsets, the same woff2 files the Google Fonts
stylesheet hands out, taken from the fontsource npm packages
(`@fontsource-variable/inter`, `@fontsource-variable/source-serif-4` 5.3.0).
They're vendored into the repo; the packages are not added as dependencies.
Each family keeps one file per script subset (Latin, Latin Extended, Cyrillic,
Greek, Vietnamese), and `unicode-range` means a page only downloads the
subsets its text actually uses.

- **Inter**: what's loaded today, served from here instead, plus its italic.
  The variable weight axis, upright and italic, 7 subsets each = 14 files. The
  upright Latin file is byte-identical to the one Google serves now (same
  SHA-1, 48 KB), so Inter won't look any different. The italic replaces the
  slant the browser fakes today; the one `<i>` on the admin MCP tab is its
  only user.
- **Source Serif 4, whole family**: every weight (200-900), roman and italic,
  with the optical-size axis, so each size gets the cut drawn for it: text cut
  for the 13px notices, display cut for the 22px stats. 6 subsets × 2 styles
  = 12 files. The Latin roman file is 122 KB. Without the optical-size axis it
  would be 51 KB, so the axis is what "whole family" costs. Italic (130 KB)
  only downloads if something is actually set in serif italic, and today
  nothing is.
- **Licences**: both fonts are OFL, and the licence text ships next to the
  files. Source Serif's comes from upstream (adobe-fonts/source-serif), because
  the one in the fontsource package names the copyright holder as
  "Google Inc.".

### `public/type.css`, linked first on those six pages

1. **`@font-face`**, one block per file, with the family names `"Inter"` and
   `"Source Serif 4"`, so the existing `--sans` stack works without changes.
   `font-display: swap`, same as today.
2. **The font tokens**, moved out of styles.css: `--sans` as it is today, and
   `--serif: "Source Serif 4", Georgia, serif`. There's one serif, so there's
   no separate title token. The notices move to Source Serif with their
   weights as they are (500 and 400). panel.css's body uses `var(--sans)`.
3. **The title list.** Every title in the app is listed in one rule that sets
   family, weight (600) and line-height. That last one matters because a modal
   shows up on pages whose bodies inherit 1.4 on some and 1.5 on others, so
   today the same modal title sits in a different line box depending on the
   page. The sizes sit right below it. This works like modal.css's
   form-control rule: a new title gets added to the list, and doesn't declare
   its own type.

   | Selector | Size | Covers |
   |---|---|---|
   | `.modal-title` | 18 | every modal's title |
   | `.lbp-title` (new class on the "Details" span) | 18 | lightbox panel title |
   | `.section-heading > h2` | 22 | section titles in modals and the lightbox panel |
   | `.panels h2` | 22 | admin/account section titles (replaces both panel.css rules) |
   | `.page-head h1` | 22 | "Admin", "Account" |
   | `.kpi .v` | 32 | usage and storage stats (raised from 22 on request) |

   The stats need no figure setting: Google's subset of Source Serif 4 has
   no oldstyle figures at all (its only figure features are `pnum` and
   `tnum`), and its default figures are lining and all the same width.

**Owner rules keep their layout only.** Font-size and font-weight come off
`.modal-title`, `.lbp-head`, panel.css's h2s, and `.kpi .v`. panel.css's bare
`h1` rule goes entirely: its size moves to the list, and `.page-head h1`
already overrides its margin. The two h2 rules merge into one `.panels h2`
margin rule.

**`sectionHeading()` loses its inline styles.** The h2's margin and the sub
line's margin and colour move to modal.css, next to the `.section-heading`
rule that's already at [modal.css:139](../public/modal.css#L139). The unused
`style` argument is deleted, and the plugin-modal comment is rewritten to
match.

### Pages, CSP, build

- **Six pages** (index, boards, admin, account, login, welcome) drop their
  three Google lines and link `type.css` before their other stylesheets.
  logs.html is monospace and loads no fonts, so it's untouched.
- **CSP**: the `fonts.googleapis.com` allowance comes out of `style-src`, and
  the `font-src` line is deleted outright, since `default-src 'self'` already
  covers self-hosted fonts. The comment above it gets updated.
- **Build**: esbuild gets `--loader:.woff2=file` and
  `--asset-names=_/[name]-[hash]`. The fonts then land content-hashed under
  `/_`, where the server already caches for a year
  ([server.js:3812](../server/server.js#L3812)). `.woff2` joins the `BUILT`
  set, so the unhashed copies don't also get copied into dist, the same way
  the vendored `.mjs` is handled. The "leaves in stage 5" comment goes, and
  app-loading-plan.md's Stage 5 gets marked as done here.

## Stages

1. **Self-hosted fonts and tokens.** Vendor the files and licences, write
   type.css's `@font-face` and tokens, link it on the six pages, drop the
   Google lines, shorten the CSP, teach the build about woff2. Visible change:
   the prose notices go to Source Serif, including on admin, where they're
   sans today. Proof, in the real app on compose :8001, rebuilt:
   - no request to any Google origin;
   - no CSP errors in the console;
   - Inter's computed font unchanged;
   - fonts served from `/_/…-[hash].woff2` with the year-long cache header;
   - the same checks on the source-served dev path.

   **Built.** Measured on compose, before and after:
   - requests went from `fonts.googleapis.com` + `fonts.gstatic.com` to
     `/_/inter-latin-wght-normal-NRMW37G5.woff2` (48,256 bytes,
     `font/woff2`, `public, max-age=31536000, immutable`);
   - the CSP now names no font origin;
   - no console errors;
   - Inter's computed family is unchanged everywhere probed.

   The admin notice bug was real: before, a `.fd-head` on /admin computed to
   the Inter stack; after, to `"Source Serif 4", Georgia, serif`. On the
   source path (a scratch test through `test/browser/harness.js`, not
   committed), fonts load from `/fonts/` and `type.css` is the first
   stylesheet.
2. **`sectionHeading()` teardown, nothing should look different.** Swap the
   inline styles for modal.css rules, drop `style`, fix the plugin-modal
   comment. Proof: the computed box and colour of a heading and its sub line
   are the same before and after, in a modal and in the lightbox.

   **Built.** Every probed heading and sub line had the same size, weight,
   margin, colour and height before and after, in the board editor, Jobs, the
   provider modal and the lightbox. The screenshots were pixel-identical
   except for live data (usage and storage figures). One exception: the
   board editor capture came back with its body scrolled 23px. It didn't come
   back in six re-runs (scrollTop 0 every time) or in the Stage 3 capture, so
   it was a capture flake, not the change.
3. **The title list, the visible change.** Write the rule, strip font
   properties from the owner rules, add `.lbp-title`, delete panel.css's `h1`,
   merge its two h2 rules. Proof in the real app:
   - a screenshot of each surface in the ask;
   - `document.fonts.check('600 18px "Source Serif 4"')` returns true;
   - a grep shows no title's font-size or font-weight declared anywhere
     outside type.css.

   **Built.** Every listed title computes to Source Serif 4 600: 18px with a
   23.4px line box, or 22px with 28.6px. The modal title's line box was 21px
   on the gallery and 22.5px on admin; it's 23.4px on both now. Margins are
   unchanged. `document.fonts.check` returns true on the source path. After
   the change, the only title selectors outside type.css carry layout alone:
   `.modal-title`, `.section-heading > h2`, `.page-head h1`, `.panels h2`,
   `.lbp-head`. Every h2 under `.panels` was either a panel's direct child or
   inside a `.section` (checked across admin-*.js, account-mcp.js,
   mcp-pane.js), so the one merged `.panels h2` margin rule matches what the
   two old ones did.

### Second pass (2026-09-26)

- **Missed:** a third hand-written copy of the Inter stack, on dropdown.css's
  `.dd-input`. The first pass only looked at styles.css and panel.css. It's
  now `var(--sans)`. Every page that loads dropdown.css loads type.css first,
  and it computes to the same value.
- **Stale comments fixed:**
  - styles.css said "every page" loads type.css (logs.html doesn't);
  - the `.fd-caret` note measured "the serif faces", meaning the old system
    ones;
  - the build's list of files copied as-is didn't include the font licences.
- **Swept for missed titles:** every CSS rule named title/head/heading/label
  that is bold or 14px+, and every heading class the modal and lightbox JS
  build. Nothing title-shaped is outside the list: what's left are uppercase
  micro-labels, row labels, and the "Not touched" items. The Add plugin
  dialog's only title is its modal title.
- **For the user to decide:** a real notice (`diagnosisBlock()`, the unit
  test's finding fixture, in the harness page) rendered beside the old stack.
  `.fd-head` / `.fd-sum` are declared weight 500. None of the old system
  serifs has a 500, so they always rendered at 400. Source Serif draws a real
  500, so notice headlines now read noticeably bolder than they used to.
  Setting them to 400 would keep the old weight; leaving them at 500 is the
  weight the rule always asked for.

## Not touched

- the uppercase micro-labels (TAXONOMY, SECTOR, INSTANCES, table headers);
- the monospace drawer and tile titles;
- row labels in lists ("Tagging", "Field extraction");
- the lightbox item name under "Details";
- the gallery's own chrome (header, the "Filters" drawer, cards);
- the login and welcome headings;
- the lightbox chart's name and price;
- the Backups "Restoring…" overlay;
- logs.html and the MCP app page (system fonts).

Any of these can join the title list later with one selector.

### Size correction (2026-09-26)

"We agreed on 18 and 22. The inline titles should be 22, not 18." Stage 3
had put every title except the page h1 and the stats at 18. In the user's
first mockup, "API Keys" sat larger than the "OpenAI" modal title. The split
is by role:
- 18: a header-bar title (`.modal-title`, `.lbp-title`);
- 22: the section titles under it (`.section-heading > h2`, and the same role
  on admin/account, `.panels h2`), the page's own title, and the stats.

Then: "make the font for the stat amounts larger - 32px". `.kpi .v` is 32px,
set on its own line in type.css.

Then (2026-09-27): "a few more places to serif. the login/first-run screens; the welcome screens. you can keep the existing font sizes." `.login-card h1` (18) and `.w-page h1` (31, 26 on a phone) joined the list; their own rules keep only layout. The welcome title lost its -0.025em tracking, which was Inter's display tightening and looked cramped in the serif.
Then: "for login/signup let's make it 22, and for the welcome 32". `.login-card h1` moved to the 22 group, and `.w-page h1` to the 32 group with the stats. The welcome title is still 26 on a phone.
