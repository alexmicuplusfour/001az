# Board templates: start a board from a taxonomy someone already wrote (2026-09-30)

**Status: FIRST LAYER (what and why) SETTLED 2026-09-30: D1–D16, the
user's calls; D17 (2026-10-01) moves the pick into a New board chooser.
SECOND LAYER (the contract, C1–C8) written 2026-09-30, amended for D17 on
2026-10-01. THIRD LAYER (the stages: 1, 2a, 2b, 3a, 3b, 4) written
2026-10-01. Stage 1 close-looked, amended and BUILT 2026-10-01
("go ahead"), uncommitted. Stage 2a close-looked, amended and BUILT
2026-10-01 ("go ahead"), uncommitted. Stage 2b close-looked, amended and
BUILT 2026-10-01 ("go on"), uncommitted. Stages 1, 2a and 2b second-passed
2026-10-01, uncommitted. Stage 3a close-looked, amended and BUILT
2026-10-01 ("go ahead"), uncommitted. Stage 3b close-looked, amended and
BUILT 2026-10-01 ("yes"), uncommitted. Stage 4, the second pass on 3a and
3b, DONE 2026-10-01 ("ok, 2nd pass on 3"), uncommitted. Every stage is
built and second-passed.**

Self-contained for a fresh session. Written from a read of the board, board
modal and mapping code, plus web research on how other products do templates
(sources inline). Related plans: [welcome-plan.md](welcome-plan.md) (the
first-run flow this picks up from), [board-duplicate-plan.md](board-duplicate-plan.md)
(the nearest thing that exists: a board's config copied within one server) and
[community-index-plan.md](community-index-plan.md) (how other people's plugins
get found, which templates deliberately don't copy).

The user's method applies (memory: close look, then build, then a second
pass).

Line links show the code as of 2e8633b.

## The ask

"thinking of implementing a templates feature. i feel like that's one of the
biggest hurdles before i can show this app to others. you arrive at an empty
screen; the edit board modal has no guidance ..."

The first sketch had a "browse templates" action in the boards dropdown,
opening a big modal or a page; the community submitting templates through the
UI, the way plugins get listed; optional suggested settings shown in a
template's details; publishing an existing board as a template; and an open
question about the mapping tab.

After the research came back, the user cut it down:

"we wouldn't allow publishing from within the app. yeah, it's ok if
submissions are a bit hard. mapping tab ... it's only valuable when there are
ai extracted fields, so maybe we add copy/paste to that section also only for
ai extracted fields, and the template would have separate sections to copy
paste. i don't know how the user would be able to use the templates ...
having to go back and forth to copy paste the two sections is not idea[l],
but also opening a modal fully populated on both tabs doesn't feel right
either. yes, we'd rename the current "template" functionality to something
else"

## Why

The welcome plan already named the spot. After "Make your first board", a new
admin lands in the board modal, "where a first admin actually has to write a
taxonomy — the product's main feature, on a large surface whose headline is
not 'write your tags'. If first-run stalls anywhere after this ships, it
stalls there." ([welcome-plan.md:1573](welcome-plan.md#L1573))

That screen is blank on purpose. New boards used to start with a sample
Category/Season/Formality taxonomy, and fd71f6f (2026-08-02) dropped it; the
agnostic-core arc deleted the board-type picker that pre-filled suggested
facets. A default taxonomy is a choice nobody made. A template is one someone
makes: a new board still starts blank unless its creator picks a template.

## What exists today

- **First run.** `/welcome` connects a model, "Make your first board" goes
  to `/boards`, and on an empty instance an admin sees a single New board
  card: "the empty state IS the invitation"
  ([boards.js:226](../public/boards.js#L226)). It opens the board modal with
  an empty taxonomy. No sample or seeded boards exist anywhere in the repo.
- **The Tagging Guidance clipboard**
  ([board-modal.js:254](../public/board-modal.js#L254)). Copy writes one
  pretty-printed document, `{ context, facets }`. Paste
  ([normalizeGuidance, board-modal.js:235](../public/board-modal.js#L235))
  replaces what the document mentions and leaves the rest alone, takes a bare
  facets array too, and fills in a missing `key` or `values`. This is already
  half a template, and the half that matters most.
- **The Mapping pane** has two sections, Card and Extract Fields
  ([mapping-modal.js:410](../public/mapping-modal.js#L410),
  [:417](../public/mapping-modal.js#L417)). Extract Fields holds fields from
  four sources: live data from a domain, file metadata, AI extraction and
  object detection ([field-sources.js:69](../server/field-sources.js#L69)).
  An AI-extracted field is `{ key, source: "extract", kind, instruction?,
  options? }`: the kind is text, number, url or date; `options` is the
  Match-to-a-list closed set, text only; a board holds at most 12
  ([mapping-rules.js:73](../server/mapping-rules.js#L73)). Nothing in one
  names anything on the server: no ids, no plugin. All it needs is a model
  that extracts, which every instance supplies its own way.
- **The card key.** `mapping.card = { by: <an extract field's key> }` makes a
  board one card per value of that field instead of one card per file; files
  boards only ([mapping-rules.js:146](../server/mapping-rules.js#L146)).
- **What locks.** Once a board has items, only the domain picker locks; the
  fields stay editable ([mapping-modal.js:149](../public/mapping-modal.js#L149),
  [:301](../public/mapping-modal.js#L301)).
- **Create** ([server.js:2377](../server/server.js#L2377)).
  `POST /api/admin/boards` takes the name, taxonomy, context and mapping in
  one call and runs the same checks a save runs, the mapping's included.
  Global admins only. A board can be born with both template sections
  without the modal ever opening.
- **Duplicate** copies every column but a skip-list
  ([db.js:1809](../server/db.js#L1809)), which is right within one server,
  where every key id still means something. Its plan weighed opening the
  create modal pre-filled and declined: it "costs a refactor of every config
  read in that modal and buys a review step for a board that has nothing in
  it yet" ([board-duplicate-plan.md:294](board-duplicate-plan.md#L294)).
- **`scripts/logos-board.json`.** 9 facets, 72 values, 6.9 KB of context and
  guidance: a probe fixture that is, in shape, the first template.
- **"Template" is taken.** It names:
  - the domain picker at the top of the Mapping pane, Files / Stocks /
    Crypto, labelled "Template", its lock tooltips saying "connector
    template" ([mapping-modal.js:270](../public/mapping-modal.js#L270));
  - the toast "… doesn't provide a board template"
    ([mapping-modal.js:1184](../public/mapping-modal.js#L1184));
  - the toolbar chip "Entity mapping template: …"
    ([toolbar.js:378](../public/toolbar.js#L378)) and its fold step
    `template` ([toolbar.js:628](../public/toolbar.js#L628));
  - the boards-page chip "AI-extracted fields — … template"
    ([boards.js:588](../public/boards.js#L588));
  - a domain plugin's `manifest.template`
    ([plugin-loader.js:177](../server/plugin-loader.js#L177), PLUGIN.md).

## What other products do

- **A template is a copy.** Boards made from one don't change when it does.
  Figma: publishing an update "won't update any existing duplicates"
  ([help](https://help.figma.com/hc/en-us/articles/360040035974-Publish-files-to-the-Figma-Community)).
  The exceptions are Home Assistant blueprints, where a re-import rewrites
  every automation made from one
  ([docs](https://www.home-assistant.io/docs/automation/using_blueprints/)),
  and monday.com's Enterprise-only managed templates.
- **Self-hosted apps ship their starters inside the app.** Baserow keeps 157
  templates in its repo so that self-hosters have them
  ([docs](https://github.com/baserow/baserow/blob/develop/docs/development/create-a-template.md)).
  Label Studio, whose templates are label configs (the nearest thing to a
  taxonomy template), bundles 69
  ([repo](https://github.com/HumanSignal/label-studio/tree/develop/label_studio/annotation_templates)).
  Apps whose gallery lives only on their website have standing "doesn't work
  on self-hosted" issues
  ([AppFlowy](https://github.com/AppFlowy-IO/AppFlowy-Cloud/issues/1039),
  [AFFiNE](https://github.com/toeverything/AFFiNE/issues/13897)).
- **In-app publishing swamps review.** Excalidraw's Publish dialog posts to a
  small function that opens a pull request with a bot token: 1,819 open
  against 318 merged, 3 merges in all of 2026, "test library" submitted 23
  times, and a security scanner flooding the anonymous endpoint
  ([PRs](https://github.com/excalidraw/excalidraw-libraries/pulls), counted
  2026-09-30). Obsidian gave up manual review on 2026-05-12
  ([blog](https://obsidian.md/blog/future-of-plugins/)). D1 is the way out of
  this.
- **Structured data through GitHub, checked by a script, works.** HA Battery
  Notes, a data-only library, takes submissions through an issue form that
  an Action turns into a pull request: 2,066 bot PRs, 1,996 merged, none open
  ([workflow](https://github.com/andrew-codechimp/HA-Battery-Notes/blob/main/.github/workflows/new_device.yaml)).
  Label Studio's community configs arrive as ordinary pull requests, with CI
  checking each one against a schema
  ([repo](https://github.com/HumanSignal/awesome-label-studio-configs)).
- **Nothing tied to one server travels.** n8n never ships credentials and asks
  for them on import
  ([docs](https://docs.n8n.io/build/manage-workflows/n8n-packages/how-import-works));
  Grafana swaps data sources for placeholders
  ([docs](https://grafana.com/docs/grafana/v7.5/dashboards/export-import/)).
  Here the two sections carry nothing tied to a server, so there is nothing
  to strip.
- **Blank sits next to a small set.** Pickers put Blank first beside a
  handful of templates
  ([Framer](https://mobbin.com/screens/d7644164-d6dc-4ea2-9f1c-e07d37701bf4),
  [Bonsai](https://mobbin.com/screens/ad10aec7-7826-40f8-a24c-c583e2ca8dc6),
  [Todoist](https://mobbin.com/screens/7ecc14ba-453e-4323-aec5-90faeb00cf21)).
  Label Studio's template step sits inside project creation and can be done
  later ([docs](https://labelstud.io/guide/setup_project)). Choice-overload
  research finds no effect on average
  ([Scheibehenne et al. 2010](https://academic.oup.com/jcr/article-abstract/37/3/409/1827647))
  and a real one when people don't yet know what they want
  ([Chernev et al. 2015](https://chernev.com/wp-content/uploads/2017/02/ChoiceOverload_JCP_2015.pdf)),
  which is a first run.

## Decisions (the user's)

**D1 — No publishing from inside the app.** A template reaches other people
as a file in a pull request, and "it's ok if submissions are a bit hard."

**D2 — A template is two sections, each the document of a Copy/Paste pair in
the board modal.** Tagging Guidance, `{ context, facets }`, is the clipboard
that exists. AI-extracted fields get a new Copy/Paste on Extract Fields, which
copies the AI-extracted fields only, not live data, file metadata or object
detection. Writing a template means building a board that works, then copying
its two sections into one file.

**D3 — The Mapping tab enters a template only through its AI-extracted
fields.** "it's only valuable when there are ai extracted fields."

**D4 — The existing "Template" becomes "Board type",** and its word goes to
this feature. (The user's pick over "Cards from".) D10 removes the Mapping
tab's selector, so "Board type" is the word in the New board chooser (D17)
and in the chips that name a board's type (the toolbar's, the boards page's, and the
board modal's, D15).
`boards.type` is a dead column from the retired board-type modules, never
read; the new label is UI only and doesn't touch it. The plugin manifest's
`template` key is part of the plugin contract rather than the UI, and can
keep its name.

**D5 — The card key stays out of the fields section; the template file can
name it.** The fields Copy/Paste carries fields only. The keyed-identity
starter (D13) needs its key to come along, so a template file may name one of
its extracted fields as the card key, beside the two sections the way
`boardType` sits beside them, and that fills the modal's Card row (D12)
("yeah, that sounds fine", after first ruling the key out of the fields
section). Files boards only: the create call already refuses a card key on a
data board and one that names no field
([mapping-rules.js:155](../server/mapping-rules.js#L155)). A template without
one makes a board that's one card per file.

**D6 — Screenshots, optional: a folder per template, not a zip.** The user
asked for screenshots ("zips instead of single file?"). Each template is a
folder, `templates/<slug>/template.json`, with its images beside it. A
template without screenshots gets the grey placeholder tile unrendered cards
already use ("yeah gray placeholder is fine").

Why not a zip:

- The pull request would show a binary blob, and a reviewer couldn't read
  the JSON change. In a folder the JSON diff stays readable, and GitHub shows
  the images inline in the pull request.
- Every edit would rewrite the whole blob in the repo's history.
- The app would have to unpack archives, with their path tricks and size
  bombs, for a package that never leaves the repo: it arrives by pull
  request (D1) and ships in the image (D7). The Dockerfile's `COPY . .`
  already picks up a new folder.

A zip earns its keep only when a template travels as one file (uploads,
imports, downloads from outside), and none of that is in this design.

How the screenshots work:

- `template.json` lists them in order, each with a caption.
- The first is the cover on the template's card, cropped to the 4:3 of a
  board card's face (`.bc-face`, [boards.css:257](../public/boards.css#L257)),
  since the templates grid is the boards page's. First written as the
  gallery card's 5:3 (Stage 3b close look, finding 6).

CI checks:

- every listed image exists, and every image in the folder is listed;
- each is WebP or JPEG, under a size cap (about 200 KB);
- there are no more than about three, which keeps 30 templates under
  ~20 MB in the repo and the image.

Review checks what CI can't: nothing private shows, and the images in the
shots are the author's to share. Someone else's photos or logos become a
licensing problem once they're in the repo and the image.

**D7 — Templates live in the repo and ship with the app** ("p2 - ok"). A
`templates/` folder, one folder per template (D6). A merged pull request
ships in the next image, and the images build on every push to main. No
runtime index, no fetch, nothing to rate-limit, and it works offline: the
Baserow and Label Studio shape. CI runs each file through the same rules the
create call applies. Plugins need their index because they are code their
authors release on their own schedule; a template is a few KB of data.

**D8 — The gallery is its own page, with a URL per template** ("p3 - ok").
First proposed as a modal. The user leaned towards a page, and the modal's one
real advantage, not leaving the page you're on, doesn't survive a flow that
always ends on the new board. The page gets:

- room for a template's details, which are a reading task: the logos
  taxonomy alone is 9 facets, 72 values and their guidance;
- a link per template, so a README or a forum post can point into anyone's
  own server, and the back button works;
- phone widths without a drawer inside a dialog;
- no modal stacked on a modal, which the board-modal redesign already
  rejected as "dialog-on-dialog ceremony"
  ([board-modal-redesign-plan.md:198](board-modal-redesign-plan.md#L198)).

It reuses the boards page's card grid rather than a new one, and lives at
`/templates` (D17).

**D9 — No suggested settings for now** ("p4 - ok"). There's no section to
paste them into, and a template works without them.

**D10 — A board's type is chosen once, when the board is made, and the
Mapping tab's selector goes.** The user's, 2026-09-30: "if we have a
pre-screen like you suggested, for choosing to start from blank or from
template, they could also choose to start a stock/crypto or whatever else
type, and we would also enforce there the capabilities, and then we wouldn't
need that shoehorned selector inside the mapping tab".

Why the selector is shoehorned:

- It's a decision made once, sitting in a form for edits: it locks as soon
  as the board has items ([mapping-modal.js:301](../public/mapping-modal.js#L301)).
- A new admin may never see it. The create modal opens on the Tagging tab
  ([board-modal.js:593](../public/board-modal.js#L593)), so Stocks and
  Crypto stay out of sight on the way to a first board.
- Switching it throws away the field list
  ([applyTemplate, mapping-modal.js:1179](../public/mapping-modal.js#L1179))
  and the saved ingest config, which the server has a branch only to clean
  up ([server.js:2348](../server/server.js#L2348)).

The pre-screen first became a New board page listing blank types and
templates together; D17 splits it into a chooser for the types and the
templates page.

It settles the old open question of whether a template can name its type: it
has to. `"boardType": "stocks"` makes a Stocks board, with the Stocks
preset's live-data fields and chart face, the template's extracted fields
beside them, and its guidance; no `boardType` means Files. Without it,
turning a Files board into a Stocks board by hand would wipe the pasted
fields.

The chooser and the templates page show what each type and each template
needs, and whether this server has it. The server already answers that per data type for the old selector,
which "has to say so at the point of choosing, rather than an hour later when
the first add fails" ([server.js:3632](../server/server.js#L3632)). A missing
piece blocks the pick (D11).

**D11 — A missing need blocks the pick** ("block."). In the chooser and on
the templates page, a type or template this server can't run shows what's
missing and where to fix it, and can't be picked until it's fixed. Examples: Stocks with no working
price provider; a plugin's type whose plugin isn't installed; a template
whose extracted fields need a model the server doesn't have. The user chose
this over the proposal to block only what can't be created at all.

The banner a board shows when its provider goes away later stays: that's a
board that already exists. The exact list of what each choice needs belongs
to the contract layer. A blank Files board needs nothing, since an empty
taxonomy is a valid board that doesn't tag
([board-modal.js:571](../public/board-modal.js#L571)).

**D12 — Both picks open the board modal** ("p1 - no, i think we should open
the modal in both cases"). The user chose this over P1, which had a template
make the board without the modal. From the chooser and the templates page
(D17):

- *Blank + a type:* the modal, as today, with the type set.
- *A template:* the modal, filled from the template: its name, the guidance
  section, the extracted-fields section, the type with its preset fields,
  and the card key if it names one (D5; the key is part of the mapping).
  Nothing else, since a template carries no settings (D9). Create board makes
  it.
- *An existing board:* a template's details still have a Copy on each
  section, and each goes into its own Paste in Edit board.

Filling the modal costs less than the duplicate plan feared. That plan priced
pre-filling "every config read in that modal"; a template fills only four,
and the modal's create mode already starts those four from blanks: name,
context and facets ([board-modal.js:562](../public/board-modal.js#L562)),
and the mapping ([board-modal.js:598](../public/board-modal.js#L598)). A
template swaps the blanks for its own values, and the Mapping pane already
builds itself from a mapping object
([mapping-modal.js:151](../public/mapping-modal.js#L151)). One catch for the
contract: today the mapping rides a save only when its tab was opened and
changed ([board-modal.js:1072](../public/board-modal.js#L1072)). A
template's has to ride even when the tab is never opened.

**D13 — Three starters, as placeholders:** a Stocks one, a UI one, and one
with keyed identity (one card per extracted value). "these will be
placeholders until i come up with something solid." All of them
general-purpose, none carrying anyone's own boards or work context.

**D14 — Admins only** ("who: sure"). Only global admins create boards, so the
chooser and the templates page are admins' too, as New board is today. Mapping writes are
admin-only too, so fields Paste is admin-only, while board managers keep
guidance Paste.

**D15 — A board's type is fixed once it's created, and the board modal shows
it as a chip.** Today the Mapping tab can switch a board between Files, Stocks
and Crypto while it's empty; D10 removes that selector.

- The modal shows the type as a chip above the Mapping | Tagging switch
  ("sure, we can show a chip somewhere at high level above the tabs"), in
  both create and edit. It reuses the toolbar's chip
  ([toolbar.js:378](../public/toolbar.js#L378)).
- It shows for every type, Files included, since Files is one of the
  chooser's cards. This is my reading, not the user's words.
- A save refuses a type change ("sure, delete the code"), and the branch that
  clears a board's ingest config when its type switches goes
  ([server.js:2348](../server/server.js#L2348)). Once the selector is gone
  nothing sends a type change; the MCP tools never touch the mapping.

**D16 — Fields Paste replaces** ("it should replace"). It replaces the board's
AI-extracted fields and keeps the other sources: live data, file metadata and
object detection. Left for the contract:

- a pasted key that clashes with one of those other fields;
- the board's card key, when it names an extracted field the paste removed.
  A save refuses a card key that names no field
  ([mapping-rules.js:157](../server/mapping-rules.js#L157)), so Paste has to
  clear it, back to one card per file.

**D17 — New board opens a chooser; templates keep their own page.** The
user's, 2026-10-01: "you click on new board action, it opens a modal with the
types of boards, and an option to go to templates. would be an appealing roomy
layout", then "sounds good" to the shape below. It replaces the single New
board page that D10 and the first contract described.

- New board opens a roomy modal: one big card per board type, each with a
  line saying what it is and, when it's blocked, what's missing (D11). One
  more card the same size, **Start from a template**, goes to `/templates`.
  Templates are the fix for the empty first screen, so that card isn't a text
  link.
- Picking a type closes the chooser and opens the board modal with the type
  set: one after the other, never one on top of the other.
- `/templates` is D8's page: the grid, each template's details, and a
  **Start blank** button that opens the chooser, so each way in leads to the
  other.
- The welcome screen's "Make your first board" goes to `/templates`. A new
  admin learns more from seeing what boards look like than from an abstract
  Files / Stocks choice, and Start blank is right there.

It separates a quick choice (two to five types) from a browsing task
(screenshots and a taxonomy to read), and New board stays an action you take
from anywhere without leaving the page you're on.

## Contract (the second layer)

Written 2026-09-30 from a second read of the code, after the first layer
settled ("aye"). Line links as of 2e8633b.

### C1 — A template is a folder

`templates/<slug>/template.json`, with its screenshots beside it (D6). The
slug is the folder's name: lowercase letters, digits and dashes.

```json
{
  "name": "Logos",
  "description": "One line on what the board is for.",
  "author": "someone",
  "boardType": "stocks",
  "cardKey": "brand",
  "guidance": { "context": "…", "facets": [] },
  "fields": [{ "key": "brand", "source": "extract", "kind": "text", "instruction": "…" }],
  "screenshots": [{ "file": "board.webp", "caption": "…" }]
}
```

(The example shows every key; a real template wouldn't pair `boardType` with
`cardKey`, see below.)

- `name` and `description` are required, and so is at least one of
  `guidance` and `fields`. The rest is optional. `author` shows on the
  details, for a template someone else wrote.
- `boardType` names a board type; absent means Files (D10).
- `cardKey` names one of `fields` (D5). Files boards only: with a
  `boardType` it's refused, as a save refuses it today
  ([mapping-rules.js:155](../server/mapping-rules.js#L155)).
- `guidance` is exactly what the guidance Copy writes, `{ context, facets }`
  ([board-modal.js:266](../public/board-modal.js#L266)). `fields` is exactly
  what the new fields Copy writes (C2). A template is two Copies pasted into
  one file, plus the lines around them.
- `screenshots` (D6): each listed file exists in the folder, and every other
  file in the folder is listed; WebP or JPEG, by name and by its bytes;
  200 KB and three at most (Stage 3a close look).
- A key this list doesn't name is refused: a typo like `boardtype` would
  otherwise make a Files template without a word (Stage 3a close look,
  finding 8). So is a key a guidance document, a facet or a field doesn't
  have: a misspelled `"singel": true` would load and then do nothing (Stage
  3b close look, finding 1).
- The template comes back from the check with both sections as a board made
  from it stores them: guidance as `{ context, facets }`, each facet and each
  field written out the way the board editor writes one (C2).
- No version field. Templates ship in the same image as the code that reads
  them (D7), so a template can't meet an app older or newer than the one it
  was checked against.

### C2 — The two section documents, and the rules they share

**Guidance** is `{ context, facets }`, unchanged, and its Paste keeps its rules
([normalizeGuidance, board-modal.js:235](../public/board-modal.js#L235)).

**Fields** is a bare array of AI-extracted fields in the shape a save writes
them ([collect, mapping-modal.js:1215](../public/mapping-modal.js#L1215)):
`{ key, source: "extract", kind, instruction?, options? }`. Paste fills in a
missing `source`, the way guidance Paste fills in a missing `key`, and refuses
a field of any other source.

- **Copy and Paste** sit on the Extract Fields heading
  ([mapping-modal.js:417](../public/mapping-modal.js#L417)), the same two
  buttons the guidance heading has (`.clip-toolbar`). Copy is there for
  anyone who can see the pane; Paste only on the editable pane, which is
  admins' (D14).
- **Paste replaces** the board's AI-extracted fields and keeps the rest (D16):
  - A pasted key already taken by a kept field (live data, file metadata,
    object detection) refuses the whole paste, naming the key. Nothing
    changes.
  - More than 12 extracted fields refuses it too: the cap a save enforces
    ([field-sources.js:98](../server/field-sources.js#L98)).
  - When the card key named an extracted field the paste removed, the key
    clears, with the toast that removing the field by hand already gives:
    "One card per file again — … was the card key"
    ([mapping-modal.js:613](../public/mapping-modal.js#L613)).
  - Each field is checked for its shape only: an object with a key, and an
    instruction and options of the right types when it has them. Whether
    they're valid stays with Save, `collect()` and the server, which
    already name the field (Stage 1 close look, finding 2).
  - The kept fields stay in their order; the pasted ones follow.

**One module holds the rules** both documents and the template file are
checked by: `public/template-core.js`, pure, no DOM. normalizeGuidance moves
there; the fields rules and the template check join it. The modal's Paste
buttons, the server's template loader and the templates test all import it,
the way the server already imports `sort-core.js` and `facet-match.js` from
public ([db.js:11](../server/db.js#L11)). So do the two write-outs: how a
board stores a facet (`facetOut`, the facet editor's) and an AI-extracted
field (`extractedFieldOut`, the Mapping pane's), which the editor, the pane
and the template check share, so that a template's sections are what a
board made from it holds and what its Copy writes (Stage 3b close look,
finding 1).

### C3 — The New board chooser and the templates page (D17)

**The chooser** is a modal: one card per board type, Files first, then every
type `/api/connectors` lists, the built-ins and any a plugin adds
([server.js:3613](../server/server.js#L3613)). Each card has the type's name
and a line saying what it is. A blocked one says what's missing and links to
where to fix it (C4). The last card, the same size, is **Start from a
template** → `/templates`, except in the chooser the templates page's Start
blank opens, where it would only reload the page you're on (Stage 3b close
look, finding 8). Picking a type closes the chooser, then opens the board
modal (C5).

Every New board opens it:

- New board in the boards dropdown
  ([toolbar.js:332](../public/toolbar.js#L332));
- the boards page's New board button and its empty-grid card
  ([boards.js:133](../public/boards.js#L133),
  [:695](../public/boards.js#L695));
- the admin Boards tab's create button
  ([admin-boards.js:214](../public/admin-boards.js#L214));
- the templates page's **Start blank**.

**The templates page** is `/templates`, from `public/templates.html`. The
server already serves any `.html` in public/ without its extension
([server.js:3951](../server/server.js#L3951)), and the frontend build picks up
every `.html` there
([build-frontend.mjs:72](../scripts/build-frontend.mjs#L72)). Admins only
(D14): anyone else who lands there goes to `/boards`.

- A grid of template cards, each with its cover screenshot or the grey
  placeholder, its name, its description and its type, plus **Start blank**.
  It's the boards page's grid and card (boards.css), the empty grid's dashed
  New board card is Start blank, first, and a face with no screenshot is
  filled with the grey tile's own token (Stage 3b close look, finding 6). A
  card always opens its template's details, blocked or not (finding 5).
- A template's details at `/templates?template=<slug>`: the screenshots with
  captions, the description, the author, the taxonomy with values and
  guidance, the AI-extracted fields and the card key. Each section has its
  own Copy (D12), and one button, **Use this template**, opens the board modal
  filled (C5). The cards are plain links to it, so the back button and a
  middle click need no history code; a slug that isn't loaded shows the grid
  and says so. Someone who isn't signed in comes back to the same details
  after signing in (finding 7).
- The welcome screen's "Make your first board" goes here instead of to
  `/boards` ([welcome.js:394](../public/welcome.js#L394)).

### C4 — What blocks a pick (D11)

A pick is blocked when something it needs doesn't work on this server: a type
card in the chooser, or a template's Use button on the templates page. It
says what's missing and links to where to fix it, and it can't be picked. A
template's card still opens its details, since reading it and its Copy
buttons need nothing (Stage 3b close look, finding 5).

| Pick | Needs |
|---|---|
| Blank Files | nothing |
| Blank of a data type | the type can serve: `available` from `/api/connectors`, the answer the old selector showed |
| A template | its type's need, plus tagging when it has facets, plus extraction when it has extracted fields |
| A template naming a type this server doesn't have | the type's plugin; blocked with "Needs the … plugin" |

Tagging and extraction are read from `/api/admin/capabilities/:id`, as the
setup strip reads tagging ([boards.js:179](../public/boards.js#L179)), and a
template is blocked when the entry's `running` is empty: nothing would run
it. Not through `presentTrouble`, which also speaks for a fallback that runs
and for a provider whose last call failed, and would block a template that
works (Stage 3b close look, finding 4). Extraction falls back to tagging's
chain when nothing is set for it
([capabilities.js:154](../server/capabilities.js#L154)), so whenever
extraction has nothing running, tagging has nothing either, and one fix link
does for both: `/welcome`, which draws its chooser whenever tagging isn't
active, as the setup strip's "Setup" does. A read that fails blocks nothing.
A type whose plugin gives no starting mapping
(`manifest.template`) is blocked too, since there's nothing to start it from
([mapping-modal.js:1183](../public/mapping-modal.js#L1183)).

D11 reverses the old selector's own rule. It listed a data type with no
provider "dimmed, and still pickable", because "setting the board up now and
adding the provider after is a real order to do this in"
([mapping-modal.js:341](../public/mapping-modal.js#L341)). The block guards
only the pick: a board whose provider goes away later keeps the banner it has
today.

### C5 — Opening the board modal

From the chooser for a blank type, from the templates page for a template:
`openBoardModal(null, { canEditAI: true, seed, onSaved })`. The seed fills the
four things a new board starts blank
([board-modal.js:562](../public/board-modal.js#L562),
[:598](../public/board-modal.js#L598)):

- **Blank Files:** no seed; the modal as today.
- **Blank of a data type:** `seed.mapping` is the type's starting mapping,
  `manifest.template` from `/api/connectors`.
- **A template:** `seed.name`, and `seed.context` and `seed.facets` from its
  guidance. `seed.mapping` is the type's starting mapping (none for Files)
  with the template's extracted fields added, and `card: { by: cardKey }`
  when it names one, with the face the Mapping pane gives a card key
  (`fileFace`, beside `connectorFace`), so the board gets the face its tab
  shows. A Files template with no fields starts with no mapping at all, as
  the pane's own `collect()` makes one: `{ fields: [] }` would be stored as
  it is and mark the board as having extracted fields (Stage 3b close look,
  finding 2). A field key that clashes with the starting mapping's is
  caught by the loader for built-in types; for a plugin's type, the save
  refuses it, naming the key.

Then:

- **The type chip** (D15) sits in the name row under the header
  ([board-modal.js:483](../public/board-modal.js#L483)), in create and in
  edit, reusing the toolbar's `.mapping-chip`, whose base rule moves to
  modal.css: the admin page opens the board modal and doesn't load
  styles.css. It names the type the way the toolbar does; a Files board's
  reads "Files".
- **The mapping always rides a create**: the pane's `collect()` when the pane
  was changed, the seed's mapping when it wasn't (never opened, or opened and
  left alone). Today a mapping rides only when its pane was built and changed
  ([board-modal.js:1072](../public/board-modal.js#L1072)); edits keep that
  rule.
- **The save gate's baseline is the seed with an empty name**
  ([board-modal.js:1102](../public/board-modal.js#L1102)), at the open and
  at the rebase when the AI-models strip lands. A template arrives named, so
  Create board is live at once. A blank type's stays off until a name is
  typed, as a blank board's does today. (3b: only a template brings a name.)
  The gate takes it as a `baseline` option, a function its baseline goes
  through at the open and at every rebase, the live model list's included
  (Stage 3b close look, finding 3).
- **`onSaved` is the door's own.** The dropdown's goes to the new board,
  `/?board=<id>&created=1`; the boards page and the admin tab stay and
  redraw, as they do today; the templates page's goes to the new board.

### C6 — The server

- **Templates load at startup** from `templates/` beside the code. The
  image's `COPY . .` includes it, and .dockerignore doesn't exclude it; the
  image workflow rebuilds the app image when it changes (Stage 3a close look,
  finding 1). Each goes through `template-core.js`, its JSON and the save's
  facet rule, and through server/templates.js: its images, and
  `validateMapping` on the mapping a board made from it would save. That's a
  built-in type's starting mapping with the template's fields added, so a
  clashing key is caught; a plugin type's fields are checked alone (finding
  5). One that fails is logged and left out rather than stopping the server.
  The test in C8 keeps a failing one from shipping.
- **`GET /api/admin/templates`** answers the list the page draws, the
  templates as checked, both sections as a board made from the template
  stores them (C1; Stage 3b close look, finding 1): they're public data.
- **Screenshots** are served at `/template-shots/<slug>/<file>`, to logged-in
  users only, like uploads under `/gallery`
  ([server.js:3905](../server/server.js#L3905)), and only a listed screenshot
  of a template that loaded (finding 6). Not under `/templates`, which is the
  page.
- **A save refuses a type change** (D15). `buildBoardAdminUpdate` answers a
  mapping whose `input.connector` differs from the stored one with a 400: "A
  board's type can't change after it's created." It runs after
  `validateMapping`, so a malformed mapping still gets its own message.
  Create is untouched: its stand-in for the stored board carries the body's
  own mapping ([server.js:2377](../server/server.js#L2377)). Server tests
  that made a connector board by saving its mapping onto a Files board make
  it in the create call instead (Stage 2a close look, finding 1).
- **The switch cleanup goes** ("delete the code"): the `inputSwitched` branch
  in `buildBoardAdminUpdate` ([server.js:2348](../server/server.js#L2348))
  and its use in the save route
  ([server.js:1612](../server/server.js#L1612),
  [:1627](../server/server.js#L1627)).

### C7 — The rename, and what goes with the selector

**Goes with the selector (D10):**

- the Template row and everything only it used: `syncTemplateBtn`,
  `applyTemplate`, `clearTemplate`, the lock tooltips and the toast
  ([mapping-modal.js:270](../public/mapping-modal.js#L270),
  [:1179](../public/mapping-modal.js#L1179),
  [:1201](../public/mapping-modal.js#L1201));
- `hasItems` in `buildMappingPane`, whose only job was locking the row
  ([mapping-modal.js:149](../public/mapping-modal.js#L149));
- `.mm-template-row` and `.mm-template-label`
  ([modal.css:111](../public/modal.css#L111),
  [:537](../public/modal.css#L537)), and `.dd-row--unavailable`, which only
  the selector's menu used ([dropdown.css:310](../public/dropdown.css#L310)).
  `.mm-template-label` shares its rule with `.modal-section-title`, so it
  leaves the selector list and the rule stays;
- `.dd-trigger` and `.dd-trigger-value`, which only the selector's button
  wore ([dropdown.css:530](../public/dropdown.css#L530)), the `busy` import
  in mapping-modal.js, and `setIngestState`'s in server.js (Stage 2a close
  look, finding 7).

**Renamed to "Board type" (D4):**

- the toolbar chip: `.template-chip` → `.type-chip`; its tooltip "Entity
  mapping template: stocks" → "Board type: Stocks"; its fold step `template`
  → `type` ([toolbar.js:378](../public/toolbar.js#L378),
  [:628](../public/toolbar.js#L628),
  [styles.css:143](../public/styles.css#L143));
- the boards page chip's tooltip, "AI-extracted fields — stocks template"
  ([boards.js:588](../public/boards.js#L588)): "Board type: Stocks" on a data
  board, with the live-data globe in place of the AI sparkle (Stage 2b close
  look, finding 5), and "AI-extracted fields" with the sparkle on a Files
  board, as now;
- the plugin loader's refusal, "…the name the template picker shows"
  ([plugin-loader.js:146](../server/plugin-loader.js#L146)), which becomes
  "the name the New board chooser shows";
- PLUGIN.md, where a domain's label shows "in the board editor's templates"
  and a board binds to a domain "only through its template" (lines 629 and
  633). The label now shows on the domain's card in the New board chooser,
  and a domain without a `template` shows there blocked. The manifest key
  `template` keeps its name (D4); the docs call it the mapping a new board
  of that type starts from, its starting mapping;
- comments that say "template picker", as each file is touched; and every
  comment, test name and doc line that calls the key's contents "the
  template": they say "starting mapping", so that "template" means only this
  feature once 3a ships a Stocks one. The key keeps its name in code
  (`manifest.template`), and migrations keep their comments, which say what
  was true when they ran (Stage 2b close look, findings 1 and 2);
- tests: the fold list and chip selector in
  [toolbar-fold.test.js](../test/browser/toolbar-fold.test.js), and the
  duplicate test named "template-unlocked"
  ([board-duplicate.test.js:167](../test/board-duplicate.test.js#L167)),
  whose assertions still hold.

### C8 — What the stages have to prove

- Every bundled template passes the rules. A test loads `templates/`; CI runs
  the suite on every push, so that test is the check D7 asked for, with no
  workflow of its own.
- Guidance Copy then Paste gives back what was copied; so do fields. Fields
  Paste replaces the extracted fields and keeps the rest; a clashing key
  refuses and changes nothing; a removed card key clears.
- A template opens the modal filled, and Create board makes the board the
  details showed, mapping included, with the Mapping tab never opened.
- Every New board opens the chooser; Start from a template and Start blank
  lead to each other; the chooser closes before the board modal opens.
- A blocked pick can't be picked, and says why.
- A save that changes a board's type gets a 400; create still takes any type.
- Each stage gets checked in the real app, not only the suite.

### Not in the contract

- No runtime index, no importing or exporting template files, no templates
  from anywhere but the repo (D1, D7).
- No version field (C1). No suggested settings (D9).
- The license (Deferred).

## Stages (the third layer)

Written 2026-10-01 ("go ahead"). Each stage runs as the user's three asks: a
close look against the code first, then the build, then a second pass when
asked. Each one ships something whole, and nothing starts before its close
look. Every proof gets a removal check: the fix taken out, its test watched
failing. Every stage ends with a check in the real app, through
test/browser/harness.js on a throwaway database, never the compose one.

### Stage 1: Copy and Paste for AI-extracted fields

(Close-looked 2026-10-01 and amended. Go-ahead the same day: "go ahead".)

**Stage 1 close look (2026-10-01): what the plan assumed vs what the code
does.**

1. Assumed Paste only writes the fields and redraws. The save gate re-reads
   the form one task after the click
   ([save-gate.js:53](../public/save-gate.js#L53)), and the clipboard answers
   later than that, so a paste that's the only edit leaves Save off, and Save
   swallows clicks while it's off. The gate's own header records guidance
   Paste shipping exactly this once. Paste now raises `input` inside the pane
   after it writes, as guidance Paste does
   ([board-modal.js:300](../public/board-modal.js#L300)). New proof 10.
2. C2 had Paste make the checks `collect()` makes. Those rules already live
   twice, in `collect()` and in `validateMapping`, and the pane's source table
   already asks that the two be kept in step. Paste checks only the shape:
   enough that nothing after it throws. A number where an instruction goes
   makes `collect()` throw at Save
   ([mapping-modal.js:1288](../public/mapping-modal.js#L1288)). On top of that
   it checks its own rules: AI-extracted only, no shared keys, the cap, the
   card key. Whether a key or an instruction is valid stays with Save, which
   already names the field. The cap is passed in rather than written a third
   time, and Copy reuses `collect()`'s per-field output, factored out of it.
3. The shared bar can't live in board-modal.js: mapping-modal.js would import
   the module that imports it. It goes in modal.js, beside `.clip-*`'s home in
   modal.css. Its Copy is api.js's `copy()`, the helper the Members and MCP
   tabs already share ([api.js:46](../public/api.js#L46)). That helper gains
   the no-clipboard case Tagging consistency's copy already handles
   ([facet-diagnostics.js:39](../public/facet-diagnostics.js#L39)): until now
   it threw inside the click over plain http. The Tagging consistency copy
   stays as it is.
4. Guidance Paste blamed the clipboard's contents when it couldn't read the
   clipboard at all, over plain http or with the permission refused. The bar
   now says "couldn't paste" on the button then, and keeps the document's own
   warning for a clipboard holding something else.
5. normalizeGuidance calls facetKey
   ([board-modal.js:35](../public/board-modal.js#L35)), so both move.
   guidance-json.test.js's fake DOM existed only to load board-modal.js; it
   goes, and the file loading bare is proof 1.
6. Where pasted fields land wasn't said. The kept fields stay in their order;
   the pasted ones follow, in the paste's order.
7. The Extract Fields heading is rebuilt by every redraw, so the pressed
   button vanished. The bar's buttons carry `data-place`, which the pane's
   redraw uses to put focus back.
8. The harness opens pages with no permissions
   ([harness.js:110](../test/browser/harness.js#L110)), and no test had
   clicked a clipboard button in a browser. `open()` takes `permissions`.

Checked and fine: data boards allow extracted fields and have no card key;
the add menu's "Maximum 12 AI extraction fields" is reused
([mapping-modal.js:773](../public/mapping-modal.js#L773)); removing the card
key's field by hand already clears it with a toast, reused
([mapping-modal.js:613](../public/mapping-modal.js#L613)); the read-only pane
already hides editing; nothing else imports normalizeGuidance or facetKey.

- **What:**
  - `public/template-core.js` (new, pure): facetKey and normalizeGuidance,
    moved unchanged; `normalizeFields`, the fields document's shape; and
    `mergeExtracted`, the paste itself: the board's fields, a pasted list, the
    card key and the cap in; the new fields and card key out, or the reason
    it's refused.
  - `public/api.js`: `copy()` says "couldn't copy" on the button when there's
    no clipboard or the write fails, instead of throwing.
  - `public/modal.js`: `clipBar`, the Copy/Paste pair, built on `copy()`;
    Paste reads the clipboard and hands the text over, or says "couldn't
    paste". Both buttons carry `data-place`.
  - board-modal.js: the guidance bar is `clipBar`.
  - mapping-modal.js: `clipBar` on Extract Fields; Copy for anyone who sees
    the pane, Paste on the admins' pane only. Paste redraws and raises
    `input`. `collect()`'s per-field output becomes `emitField`, which Copy
    uses too.
  - test/browser/harness.js: `open()` takes `permissions`.
- **What the user sees:** Extract Fields has Copy and Paste, like Tagging
  Guidance. Paste replaces the AI-extracted fields and leaves live-data, file
  and detection fields where they were. With no clipboard (plain http), both
  bars say so on the button.
- **Proofs:**
  1. template-core.js loads with no browser stub, and normalizeGuidance
     behaves as before: guidance-json.test.js, its import moved and its fake
     DOM gone.
  2. Fields Copy writes the board's AI-extracted fields and nothing else;
     pasting that into another board gives the same fields, instructions and
     options included (browser).
  3. Paste replaces the extracted fields and keeps the other sources in
     order, the pasted ones after them (template-core.test.js).
  4. A pasted key that clashes with a kept field, or appears twice in the
     paste, refuses it, and nothing changes (template-core.test.js, browser).
  5. More than 12 extracted fields refuses (template-core.test.js).
  6. A field of another source refuses; a missing `source` is filled in; a
     field whose instruction or options have the wrong shape refuses
     (template-core.test.js).
  7. The card key clears, with its toast, when its field isn't in the paste,
     and stays when it is (template-core.test.js, browser).
  8. The read-only pane has Copy and no Paste (browser).
  9. What Paste produced saves, and a reload shows it (browser).
  10. A paste that's the only edit turns Save on (browser).
  11. With no clipboard, Paste says "couldn't paste" (browser), and `copy()`
      says "couldn't copy" without throwing (api-copy.test.js).
  12. Focus is back on Paste after the redraw (browser).
- **Real-app check:** copy one board's fields, paste them into another,
  save, reload.

**Built (2026-10-01), uncommitted:**

- `public/template-core.js` (new): facetKey and normalizeGuidance, moved
  word for word; `normalizeFields`; `mergeExtracted`.
- `public/api.js`: `copy()` no longer throws with no clipboard; it says
  "couldn't copy". A shared `flash()` keeps the button's own label across a
  second click inside the moment. The old helper read the label at flash
  time, so a quick second click left "copied!" on the button for good.
- `public/modal.js`: `clipBar`.
- `public/board-modal.js`: the guidance bar is `clipBar`, and facetKey and
  normalizeGuidance come from template-core.js. Guidance Copy now says
  "copied!" or "couldn't copy" on the button, where it said "Copied!" or
  showed an error toast.
- `public/mapping-modal.js`: `emitField` out of `collect()`, the bar on
  Extract Fields, `pasteFields`. The file is CRLF in the working copy and
  stays CRLF: it already was, as the index's cached size shows (68,212
  bytes, the CRLF size, against HEAD's 66,876 LF).
- test/browser/harness.js: `open()` takes `permissions`.
- Tests: test/template-core.test.js (new, 15), test/api-copy.test.js (new,
  4), test/browser/fields-clipboard.test.js (new, 5).
  guidance-json.test.js lost its 30-line fake DOM; its assertions are
  unchanged.

Found while building:

- Headless Chromium reads and writes the clipboard once the context is
  granted clipboard-read and clipboard-write; the plan had left that to
  confirm.
- Git Bash's `grep` hides carriage returns: `grep -c $'\r'` said 0 for
  mapping-modal.js, which is CRLF throughout. Line endings are checked with
  node, at byte level.
- The first full run failed welcome.test.js:291, "a configured instance has
  nothing to do here". It asserts `#gate` is hidden right after
  `waitForURL(/boards)`, but the gate clears only after the boards page's
  fetches, which run after the load event `waitForURL` waits for. That's a
  race under the suite's load. It passed alone three times and in a second
  full run. It isn't this stage's code: the one module the stage adds to the
  boards page loads before that load event. Recorded, not fixed. A
  condition wait on `#gate` would fix it.

Removal checks, each fix taken out and its test watched failing (a script
put every file back byte-identical after each):

| removed | failed |
|---|---|
| R1: fields Paste doesn't announce itself | fields-clipboard "Copy writes…": "Save turns on for a paste alone" |
| R2: no type check on a pasted instruction | template-core "a field whose parts have the wrong types…" |
| R3: Paste drops the fields it should keep | template-core "replaces … keeps every other one", "an empty paste…", "a pasted key that a kept field already has…"; fields-clipboard "Copy writes…", "a pasted key the board already has…" |
| R4: no key-clash refusal | template-core both clash tests; fields-clipboard "a pasted key the board already has…" |
| R5: no cap | template-core "more extracted fields than the cap…" |
| R6: the card key survives a paste without its field | template-core "the card key clears…"; fields-clipboard "Copy writes…" |
| R7: a field of another source is let through | template-core "a field of any other source is refused" |
| R8: Paste offered on the read-only pane | fields-clipboard "a reader who can't edit the mapping…" |
| R9: no `data-place` on the bar's buttons | fields-clipboard "Copy writes…": "focus is back on Paste after the redraw" |
| R10: `copy()` without its no-clipboard guard | api-copy "with no clipboard at all…"; fields-clipboard "with no clipboard…" |
| R11: Paste without its no-clipboard guard | fields-clipboard "with no clipboard…" |
| R12: `flash()` reads the label at flash time | api-copy "a second flash inside the moment…" |
| R13: fields Copy takes every field | fields-clipboard "Copy writes…" |
| R14: template-core.js touches a browser-only global | guidance-json.test.js and template-core.test.js fail to load |
| R15: a missing `source` isn't filled in | template-core "…arrived without a source…" and two more |
| R16: a pasted field keeps parts an extracted field doesn't carry | template-core "what an extracted field doesn't carry…" |

Lint clean (`eslint .`). Full suite: 2,291 of 2,291 on the second run. The
new browser file also passes against the built frontend
(`FRONTEND_DIR=public/dist`, after a fresh build of the gitignored
public/dist).

Real-app check (Chromium, the real server on a throwaway database, a
scratchpad script through test/browser/harness.js):

- Copied a board's two extracted fields, one of them its card key with a
  list of options.
- Pasted them into a board that had a file field and an extracted field of
  its own. The file field stayed first, the old extracted field went, and
  Save lit.
- Saved and reloaded: extension, brand, year.
- A board manager's read-only pane shows Copy only.

The screenshots show the fields bar sitting on the Extract Fields heading
exactly as the guidance bar sits on its own. No page errors, no failed
requests.

### Stage 2a: the board type is picked first

(Close-looked 2026-10-01 and amended. Go-ahead the same day: "go ahead".)

**Stage 2a close look (2026-10-01): what the plan assumed vs what the code
does.** Line links in this record are to the working copy after Stage 1.

1. Assumed nothing but the Mapping tab changes a board's type through a
   save. The server tests do: they make a Crypto or Stocks board by creating
   a Files board and then saving a connector mapping onto it. Measured on a
   scratchpad copy of the code with the refusal added: 36 of 2,144 server
   tests fail, each with a 400 where it expected a 200 (faces 14, connectors
   9, liveness 8, field-projection 2, field-sources 1, derived-identity 1,
   ingest-connector 1). They move to making the board with its type in the
   create call, which already takes a mapping. The plan also said no test
   covered the switch cleanup being deleted. One did
   ([ingest-connector.test.js:922](../test/ingest-connector.test.js#L922)),
   and it becomes proof 9's test.
2. Assumed every New board ends on the new board (C5). Only the dropdown's
   does ([toolbar.js:332](../public/toolbar.js#L332)). The boards page stays
   and the new card appears in its grid
   ([boards.js:133](../public/boards.js#L133)); the admin tab redraws its
   table ([admin-boards.js:214](../public/admin-boards.js#L214)). The
   chooser passes each door's own after-create step through; ending on the
   new board is the templates page's (3b).
3. Assumed the chooser loads "through the modal door like the board modal".
   The door is the gallery's only ([modal-door.js](../public/modal-door.js));
   the boards page and the admin page import board-modal.js directly. The
   chooser loads the way the board modal does on each page.
4. Assumed the chip could wear the toolbar's `.mapping-chip`. Its rule and
   its colors live in styles.css
   ([styles.css:1975](../public/styles.css#L1975)), which the admin page
   doesn't load, and the board modal opens there. The base rule moves to
   modal.css, which all three pages load; the toolbar-only variants (error,
   paused, button) stay where they are.
5. Assumed 2a needs the save gate's new baseline (C5). A blank type opens
   unnamed, so Create stays off until a name is typed with no change at all;
   proof 6 is already true. The baseline matters only when a template brings
   a name, so it moves to 3b, with a second half the plan didn't have: the
   rebase when the AI-models strip lands
   ([board-modal.js:906](../public/board-modal.js#L906)) has to leave the
   name out too, or a template's Create goes dead a moment after it opens.
6. Assumed Stocks could be the path that works. Stocks' provider needs a key
   and Crypto's doesn't
   ([domainState, runtime.js:283](../server/connectors/runtime.js#L283)), so
   on a server without a Financial Modeling Prep key, the test harness's
   included, Stocks is blocked. Proof 2 gets its blocked type for free;
   proof 3 and the real-app check use Crypto.
7. C7's list missed pieces only the selector used: `.dd-trigger` and
   `.dd-trigger-value` ([dropdown.css:530](../public/dropdown.css#L530)),
   the `busy` import in mapping-modal.js, and `setIngestState`'s in
   server.js. `.mm-template-label` shares its rule with
   `.modal-section-title` ([modal.css:111](../public/modal.css#L111)), so it
   leaves the selector list and the rule stays.
8. Closing a modal is a fade of up to 250ms
   ([modal.js:115](../public/modal.js#L115)), so "one after the other" means
   the board modal opens from the chooser's `onClose`, once the chooser is
   gone. The scroll lock is counted across the two, so the page doesn't jump
   between them.

Checked and fine: nothing else calls `applyTemplate` or reads `hasItems`;
`has_items` stays in the settings answer, because the reprocess reminder
reads it ([board-modal.js:1025](../public/board-modal.js#L1025)). Only the
board modal's Save sends a mapping: the ingest modal sends its config, the
admin table its members, and the MCP tools never touch it. The Mapping pane
builds from a type's starting mapping the way it opens an existing Stocks
board, by fetching the catalog
([loadCatalog, mapping-modal.js:1210](../public/mapping-modal.js#L1210)).
boards-empty.test.js and welcome.test.js only check that the empty-grid card
is there. The chip in edit names the type the way the toolbar does, the
connector's name capitalized (utils.js `sentence`), with no fetch; the
chooser shows the type's label, the same word for both built-ins, and a
plugin whose label differs from its name would show two names (recorded,
not fixed). Proof 10 already has its test
([ingest-connector.test.js:957](../test/ingest-connector.test.js#L957)),
which passed with the refusal in place. `/admin#plugins` opens the Plugins
tab. modal.css already has a choice card (`.mm-srcopt`: grey fill, hover by
fill, dimmed when disabled), which the chooser's cards share.

- **What:**
  - `public/new-board.js` (new): `openNewBoard({ onSaved })`, the chooser
    (C3). Files first, then every type `/api/connectors` lists, each with its
    label and description. A type that can't serve (`available: false`) or
    gives no starting mapping is blocked: its reason, a link to Admin →
    Plugins, and no pick (C4). If the list doesn't load, Files is still
    there, with a line saying the rest didn't load. Picking a type closes
    the chooser, and its `onClose` opens the board modal with the type's
    starting mapping and the door's `onSaved`. The templates card waits for
    3b.
  - The doors (C3): the dropdown's New board through the modal door
    (modals.js and modal-door.js gain `openNewBoard`); the boards page's
    button and empty card, and the admin tab's button, import new-board.js
    directly. Each keeps its own `onSaved`.
  - board-modal.js: `opts.seed`, its `mapping` only (name, context and
    facets are 3b's); the type chip in the name row; the mapping riding
    every create (C5).
  - modal.css: the `.mapping-chip` base rule, moved from styles.css.
  - mapping-modal.js: the Template row goes, with everything only it used
    (C7).
  - server.js: a save refuses a type change, after the mapping's own
    checks, and the switch cleanup goes (C6).
  - The tests that made a connector board by saving its mapping onto a
    Files board make it in the create call instead.
- **What the user sees:** New board opens a chooser of types; picking one
  opens the board modal with the type's chip. The Mapping tab has no Template
  selector any more. A type this server can't feed says why, links to where
  to fix it, and can't be picked.
- **Proofs:**
  1. Every New board door opens the chooser: the dropdown, the boards page's
     button and empty card, the admin tab (browser).
  2. The chooser lists Files first, then each data type. Stocks, with no key
     in the harness, shows its reason and the fix link, and clicking it
     opens nothing (browser).
  3. Picking Crypto, then Create board without opening the Mapping tab,
     makes a Crypto board whose saved mapping is the starting mapping; so
     does opening the tab and leaving it alone (browser, the mapping read
     back).
  4. The chooser is gone before the board modal opens: never both at once
     (browser).
  5. Files, then Create, makes a board with no mapping, as today (browser).
  6. A blank type's Create board stays off until a name is typed (browser).
  7. Edit board shows the board's type chip, Files included, and the chip is
     drawn on the admin page too (browser).
  8. No Template row, for a new board or an old one (browser).
  9. A PATCH that changes the type (Files to Crypto, Crypto to Stocks,
     Crypto to no mapping) gets a 400 and changes nothing, the ingest config
     included. A PATCH that keeps the type saves, and create takes any type
     (server test, the rewritten switch test).
  10. An ingest save still clears its old run's verdicts (the existing test,
      [ingest-connector.test.js:957](../test/ingest-connector.test.js#L957)).
  11. Each door keeps its own after-create step: the dropdown lands on the
      new board, the boards page stays with the new card in its grid, and
      the admin tab lists the new board (browser).
- **Real-app check:** New board from the dropdown, then Crypto, then Create;
  the board opens as a Crypto board. Stocks shows as blocked. An old Stocks
  board's Edit board shows the chip and no selector, on the gallery and on
  the admin page.

**Built (2026-10-01), uncommitted:**

- `public/new-board.js` (new): `openNewBoard({ onSaved })`. It fetches
  `/api/connectors` first, so the chooser opens whole. Files first, with
  "Cards from the files you add", then each type with its label and
  description. A blocked type is a card that isn't a button: its name dims,
  and an amber box (`.warn-box`) says why and links to `/admin#plugins`. The
  link closes the chooser, which on the admin page would otherwise stay over
  the tab it opens. If the list fails, Files stays, with a line saying the
  rest didn't load. No footer: picking is the action, × and Esc close it.
  Focus goes to the first card. One chooser at a time: a New board click
  while one is loading or open does nothing.
- The doors: toolbar.js through modal-door.js and modals.js; boards.js and
  admin-boards.js import new-board.js. Each passes its own `onSaved`.
- `public/board-modal.js`: `opts.seed` (`{ mapping }`); the chip
  `#board-modal-type` in the name row, the connector's name through utils.js
  `sentence`, "Files" without one; `hasItems` no longer passed.
- `public/mapping-modal.js` (CRLF kept): the Template row, `syncTemplateBtn`,
  `applyTemplate`, `clearTemplate` and the `hasItems` option are gone, with
  the `busy` and `ICONS` imports. The catalog fetch binds the domain itself
  (`bindConnector` had three callers and would have been left with one),
  `inputConnector` is a `const`, and `loadFileFields` lost the guard only a
  second call needed.
- CSS: modal.css gains the `.mapping-chip` base rule (moved from styles.css,
  its colors with fallbacks), `.modal-subhead` as a row with the name input
  flexing, and the chooser's cards (`.nb-*`), which use the modal card's
  tokens and are selected through `.nb-types` to outweigh panel.css's bare
  `button` rules on the admin page. `.mm-template-*`, `.dd-row--unavailable`
  and `.dd-trigger*` are gone.
- `server/server.js` (CRLF kept): the refusal in `buildBoardAdminUpdate`
  after `validateMapping`; `inputSwitched`, its branch in the save route and
  the `setIngestState` import are gone; comments that described the old
  picker say what's true now.
- Tests: test/browser/new-board.test.js (new, 8). The switch test in
  ingest-connector.test.js became the refusal test. The 36 tests that made a
  connector board by saving its mapping make it in the create call: faces.test.js
  (a `boardWith` helper; `faceBoard` uses it), connectors.test.js (its
  `createBoard` helper already took extra body fields), liveness.test.js,
  field-projection.test.js, field-sources.test.js, derived-identity.test.js.

Found while building:

- The close look's finding 6 was half right. A fresh server has no data
  provider added at all, so on a first run Stocks AND Crypto are blocked, with
  "No … provider is installed", until one is added in Admin → Plugins. The
  missing key is the reason only once the provider is added. The browser test
  adds CoinGecko the way the Plugins page does.
- Moving `.mapping-chip`'s base rule to modal.css flipped one override:
  `.token-chip`'s narrower padding won only by coming later in styles.css,
  and modal.css loads after it. It's `.mapping-chip.token-chip` now, and a
  test measures it.
- The admin page's panel.css styles every bare button, `button:has(svg)` at
  (0,1,1), which would have centered the chooser's cards there.
- "Every create sends the pane's collect() when the pane was built" (as
  first written into C5) was one condition more than needed: a pane opened
  and left alone sends what the seed would. The save sends the pane's mapping
  when it changed and the seed's otherwise; C5's wording follows.
- The chooser as first written let a double click on New board open it
  twice: the second call, landing while the first was still fetching the
  types, removed the first chooser without closing it. Its hold on the
  page's scroll was never let go, so after closing with × or a click outside
  the page couldn't scroll. Now a click while a chooser is loading or open
  does nothing, and a test double-clicks with the types held back so both
  clicks land. The board modal opens the same way (it removes an open copy
  of itself), so a double click on Edit board may stick the scroll the same
  way. That predates this stage and wasn't measured: recorded, not touched.

Removal checks, each fix taken out and its tests watched failing (a script
put every file back byte-identical after each). Later tests in
new-board.test.js reuse the boards earlier ones make, so a check that breaks
an early test fails some later ones too; the table names the tests that fail
on their own assertion.

| removed | failed |
|---|---|
| R1: the dropdown's New board opens the board modal directly | "the dropdown's New board…" |
| R2: the boards page's doors open the board modal directly | "the empty grid's card…", "the boards page's button…", "a field removed…" |
| R3: the admin tab's New board opens the board modal directly | "the admin tab's New board…" |
| R4: a blocked type can be picked | "the empty grid's card…": "not a button" |
| R5: the starting mapping doesn't ride the create | "the dropdown's New board…" (tab never opened), "the boards page's button…" (tab opened and left alone) |
| R6: the board modal opens while the chooser still fades | "the empty grid's card…", "the dropdown's New board…": "the chooser was gone before the board modal opened" |
| R7: no type chip | "the empty grid's card…", "the dropdown's New board…", "Edit board names…", "the admin tab's New board…" |
| R8: the Template row back (the pre-stage mapping-modal.js) | "the boards page's button…", "Edit board names…": "no Template row" |
| R9: the server takes a type change | ingest-connector "a save can't change a board's type…" |
| R10: the type check before the mapping's own checks | faces "validateMapping: face slot rules", "validateMapping: file-face slot rules" |
| R11: the chip's rule left in styles.css only | "the admin tab's New board…": the chip's look |
| R12: the token chip's padding at the base's weight | "the toolbar's chips look as they did" |
| R13: the door's `onSaved` dropped | "the empty grid's card…", "the dropdown's New board…", "the boards page's button…", "a field removed…", "the admin tab's New board…" |
| R14: Files starts from an empty mapping | "the empty grid's card…": "a Files board has no mapping" |
| R15: Create live before a name is typed | "the empty grid's card…" |
| R16: an ingest save no longer clears its old run's verdicts | ingest-connector "saving a new config clears a stale drain budget" |
| R17: a second New board click opens another chooser | "a double click on New board opens one chooser…" |

Lint clean (`eslint .`). Full suite: the first run failed one test,
welcome.test.js:291's `#gate` race, the one Stage 1 recorded, now seen in two
of four full runs across the two stages. It passed alone three times, and
the second full run was 2,299 of 2,299. It's still recorded, not fixed: a
condition wait on `#gate` would fix it. The new browser file also passes
against the built frontend (`FRONTEND_DIR=public/dist`, after a fresh build),
where the bundled stylesheets keep modal.css after styles.css.

Real-app check (Chromium, the real server on a throwaway database with
CoinGecko added, a scratchpad script through test/browser/harness.js):

- The empty boards page's card opened the chooser: Files, Crypto, and Stocks
  blocked with "No Stocks provider is installed. Fix in Admin → Plugins".
  Files, a name, Create: the page stayed, the new card appeared, and the
  created toast showed.
- From a board's dropdown: Crypto, the board modal with its Crypto chip, the
  Mapping tab with the starting fields and no Template row; Create landed on
  the new board, whose saved mapping has the 11 starting fields.
- An old Stocks board's editor: the Stocks chip, no selector, and the
  existing "No Stocks provider is installed" banner.
- The admin page: the same chooser, and the chip drawn in its editor.
- At 390px: the chooser's cards stack in one column, and the name row fits
  its chip; no sideways scroll.
- No page errors and no failed requests anywhere.

### Stage 2b: the rename

(Close-looked 2026-10-01 and amended. Go-ahead the same day: "go on", which
took the close look's recommendations, the globe on the boards page chip
among them.)

**Stage 2b close look (2026-10-01): what the plan assumed vs what the code
does.** A sweep for "template" outside the planning docs found about 280
hits in 57 files. Line links are to the working copy after Stage 2a.

1. Assumed every hit left after the rename is the new feature or unrelated.
   The largest group is neither: the plugin manifest's `template` key, which
   D4 keeps. The code that reads it (`manifest.template`, `row.template`),
   the loader's install checks and their messages ("domain manifest.template
   must…"), and the fixtures that test it. Proof 3 gets a group for the key's
   name in code, and one for migrations: 0035's comments say what was true
   when it ran, and stay.
2. Prose calls the key's contents "the template": "a board shaped like … the
   Stocks template" (toolbar-fold.test.js), "the crypto/stocks templates ship
   the chart face" (faces.test.js), and "a board template" in PLUGIN.md at
   three lines the plan didn't list (52, 544, 580). Once 3a ships a Stocks
   template, those read as the feature. About 30 lines; they say "starting
   mapping" now, the plan's own words for the docs (C7).
3. The plan's two phrases, "template picker" and "connector template", miss
   old-meaning text: modal.js:281's example "apply a template";
   connectors/index.js:104's "a re-templated board", a type change that can't
   happen now; connectors.test.js:387, 401 and 451, which still describe the
   rule D11 reversed, one of them as an assertion's message ("still listed
   with its template — a shape you may pick"); dynamic-plugins.test.js's rule
   named "nameless picker entry"; and Stage 2a's own new-board.test.js, which
   selects `.template-chip`. The three server comments the phrases do catch
   (runtime.js:271, capability-status.js:277, server.js:3794) argue for the
   old picker listing a blocked type as pickable, and get rewritten, not a
   word swapped.
4. Nothing automated reads the one change a user sees, the two tooltips; the
   plan left them to the real-app check. One assertion each: the 2a browser
   test already opens a Crypto board, and boards-page.test.js's overview can
   carry one.
5. The boards page chip draws every board with a mapping with the AI
   sparkle, a Stocks board's included
   ([boards.js:583](../public/boards.js#L583)). With its tooltip saying
   "Board type: Stocks", the sparkle contradicts it. A data board's chip
   gets the live-data globe the chooser and the Mapping pane use; a Files
   board with a mapping keeps the sparkle and "AI-extracted fields".
6. PLUGIN.md line 633 says a board binds to a domain only through its
   template, in the board editor. Since 2a a domain without one shows in the
   New board chooser as blocked ("The … plugin doesn't set up new boards"),
   and the doc says so.
7. board-duplicate.test.js's comment says `has_items: false` unlocks the
   Template picker. Nothing is unlocked by it now; it decides the reprocess
   reminder. The test's assertions hold, and its name and comment say what
   they prove now.

Checked and fine: the fold step names live only on the toolbar's
`data-fold` attribute, and nothing stores them. The loader's refusal test
matches only "domain manifest needs a label"
([dynamic-plugins.test.js:277](../test/dynamic-plugins.test.js#L277)), which
the new wording keeps. plugin-doc.test.js reads only the first column of the
table line 52 sits in, and doesn't read the domain-manifest table at all.
utils.js `sentence` gives exactly what the chips build inline. The unrelated
hits, about 50: CSS `grid-template-*`, template strings in comments, the
test database template, MCP's app template, and a SQL query in db.js. The
README's three Mapping screenshots still show the Template row; they're from
an older modal anyway, and refreshing them is its own job.

- **What:**
  - toolbar.js: the chip `.type-chip`, its tooltip "Board type: Stocks", its
    text and tooltip through `sentence`, the fold step `type`; styles.css and
    toolbar-fold.test.js with them.
  - boards.js: the chip's tooltip "Board type: Stocks" and the globe on a
    data board, through `sentence`; a Files board's is unchanged.
  - plugin-loader.js: the refusal names the New board chooser.
  - PLUGIN.md: the label's line, `template`'s line (a domain without one is
    blocked in the chooser), and "starting mapping" where it said "board
    template" or "the template".
  - Comments, test names and assertion messages with the old meaning, and
    the prose about the key's contents (finding 2): every one the sweep
    found, not only the two phrases.
  - The duplicate test's name and comment.
- **What the user sees:** "Board type: Stocks" where it said "Entity mapping
  template: stocks", and on the boards page a globe instead of the AI
  sparkle on a data board's chip. The old meaning of "Template" is gone from
  the app.
- **Proofs:**
  1. toolbar-fold.test.js passes with the renamed step and class, in the
     same fold order.
  2. The plugin loader's refusal still starts "the domain manifest needs a
     label", the part dynamic-plugins.test.js checks
     ([dynamic-plugins.test.js:277](../test/dynamic-plugins.test.js#L277)).
  3. A sweep for "template" in public/, server/, PLUGIN.md and test/, with
     every remaining hit in one of four groups named here: the new feature;
     the manifest key's name in code and in the fixtures that test it;
     unrelated (CSS grid templates, template strings, the test database
     template, MCP's app template, the SQL template in db.js); migrations.
  4. The toolbar chip's tooltip reads "Board type: Crypto" on a Crypto board
     (new-board.test.js).
  5. The boards page chip reads "Board type: Crypto" with the globe on a
     data board, and "AI-extracted fields" with the sparkle on a Files board
     with a mapping (boards-page.test.js).
- **Real-app check:** the toolbar chip's tooltip on a Stocks board, and the
  boards page chips of a Stocks board and a Files board.

**Built (2026-10-01), uncommitted:**

- `public/toolbar.js`: the chip is `typeChip`, `.type-chip`, "Board type:
  Stocks", its text and tooltip through utils.js `sentence`; the fold step is
  `type`. `public/styles.css`'s fold rule follows.
- `public/boards.js`: a data board's chip is the globe, "Stocks" and "Board
  type: Stocks", through `sentence`; a Files board's with a mapping is the
  sparkle alone and "AI-extracted fields", as before.
- `server/plugin-loader.js`: "…the name the New board chooser shows".
- PLUGIN.md: the `label` and `template` rows (a domain without `template`
  shows in the chooser, blocked), the `### template` section's opening, and
  "starting mapping" at lines 52, 544, 580 and 665.
- Comments that described the old picker, rewritten for the chooser:
  runtime.js, capability-status.js, server.js, connectors/index.js,
  modal.js. Prose that called the key's contents "the template" says
  "starting mapping": crypto's and stocks' modules, mapping-rules.js,
  plugin-loader.js, mapping-modal.js, and the bad-domain-template fixture's
  comment and description (its ids and labels stay: they're the key group).
- Tests: toolbar-fold.test.js (the step, the chip, the gap's name, a
  comment); board-duplicate.test.js ("the copy has no content, and arrives
  with the source's mapping", and what `has_items` means now);
  extraction.test.js; connectors.test.js (names, comments, and the message
  that described D11's reversed rule, which now says the chooser shows the
  type blocked); dynamic-plugins.test.js (names); faces.test.js and
  list-columns.test.js (names and messages); new-board.test.js
  (`.type-chip`, and proof 4); boards-page.test.js (its two boards get a
  mapping, a Files one and a Crypto one, and proof 5).

Found while building:

- The sweep's first run placed six lines nowhere. Four were Stage 2a's own
  checks that the Template row is gone, which have to name it: they're a
  fifth group, "gone". One was a SQL comment split over two lines. One was a
  comment I'd just written that quoted the old tooltip; it doesn't now.
- Reading the key group by eye caught what its rules had let through: the
  bad-domain-template fixture's comment and description matched by the
  fixture's folder name, and a new comment in new-board.test.js quoting the
  old tooltip matched `template: `. Rules match the line now, and only the
  feature's files and migrations by path; "unrelated" is tried before "key",
  which had claimed icon.js's "reads the string as a template:".
- The sweep, as a script in the scratchpad (sweep-2b.py), places every line:
  the feature 26 lines in 13 files, migrations 3 in 1, "gone" 4 in 1,
  unrelated 36 in 16, the key 81 in 21, unplaced 0. It covers public/,
  server/, test/ and PLUGIN.md; scripts/ holds only the test database's
  template.

Removal checks, each change taken out and what proves it watched failing (a
script put every file back byte-identical after each):

| removed | failed |
|---|---|
| R1: the fold step keeps its old name | toolbar-fold "the top row folds a step at a time…", and three more of its tests |
| R2: the toolbar chip keeps its old class | toolbar-fold's four fold tests and "the spacing is the row's old spacing…"; new-board "the toolbar's chips look as they did…" |
| R3: the toolbar chip keeps its old tooltip | new-board "the toolbar's chips look as they did, and the type chip says what it is" |
| R4: the fold rule keeps its old names | toolbar-fold "the top row folds a step at a time…", and three more of its tests |
| R5: the boards page chip keeps its old tooltip | boards-page "a data board's chip names its type under the globe…" |
| R6: the boards page chip keeps the AI sparkle on a data board | boards-page "a data board's chip names its type under the globe…" |
| R7: the loader's refusal loses the words its test reads | dynamic-plugins "validateBuilt (connector-domain): nameless chooser card" |
| R8: an old-meaning comment left behind (modal.js's "apply a template") | the sweep: "unplaced 1", naming modal.js:281 |

Lint clean (`eslint .`). Full suite: 2,300 of 2,300 on the first run. The
toolbar-fold and new-board browser files also pass against the built
frontend (`FRONTEND_DIR=public/dist`, after a fresh build).

Real-app check (Chromium, the real server on a throwaway database, a
scratchpad script through test/browser/harness.js): a Stocks board's toolbar
chip reads "Stocks", titled "Board type: Stocks". On the boards page the
Stocks and Crypto boards show the globe with their type, titled "Board type:
Stocks" and "Board type: Crypto"; a Files board with an extracted field shows
the sparkle alone, titled "AI-extracted fields"; a Files board with no
mapping shows no chip. No page errors and no failed requests.

### Second pass on Stages 1, 2a and 2b (2026-10-01)

(Asked for the same day: "do a 2nd pass on these first 3 stages".)

Three read-only reviewers, none shown this plan, each compared the last
commit with the working copy. One took Copy and Paste (Stage 1). One took the
chooser, the board modal's seed and chip, and the server's refusal (2a, 2b).
One took everything else: every remaining reader of what was removed or
renamed, the reworded comments and PLUGIN.md, the 36 moved tests, and the
packaging. My own read checked this plan's claims against the code and each
proof's test setup; both held. The third reviewer found no bugs: the moved
tests still prove what their names say, and both new files reach the bundle
and the image.

**Found and fixed, each with a test:**

1. Each Paste took the other section's document. Extract Fields' Copy writes
   a bare list of keyed objects, and Tagging Guidance's Paste read it as
   facets with no labels and no values: the taxonomy was replaced, Save lit,
   and nothing was said. The other way, a taxonomy pasted into Extract Fields
   landed as extracted fields with no kind. A facet with a `source` and a
   field with `values` are refused now, each with its own bar's warning.
2. A kind nobody offers was saved as "text" without a word. Paste lets a kind
   through for Save to judge (Stage 1 close look, finding 2), but emitField
   swapped any kind outside the source's list for the first one before the
   server could see it. It goes out as it is now, and the server names it:
   `invalid kind "integer" for field "price"`.
3. A field pasted without a kind read "AI extraction · undefined" on its tile
   until the board was saved and reopened. It gets the kind a new field
   starts with, which is what Save would give it.
4. Copy didn't write what Save sends for a field with options. collect()
   trimmed the values, dropped blank rows and empty hints, and rebuilt each
   option as `{ value, hint? }` inside its checks; emitField wrote the options
   as held. So Copy took untrimmed rows, and a saved board's options in the
   database's key order, hint first. The cleanup is `cleanOptions` now, and
   emitField writes through it for both.
5. Older than the arc, moved with normalizeGuidance: a pasted facet whose
   description isn't text threw in the editor's sync, after the paste, so the
   editor showed a taxonomy that Save never saw. It's refused now, the rule
   normalizeFields already keeps for an instruction.
6. A double-clicked type card sent its second click through the chooser. A
   closing modal lets clicks through while it fades (modal.css
   `.is-closing`), and on the boards page what lies under the chooser's cards
   is board cards, which are links. The chooser keeps catching clicks once a
   type is picked.
7. A plugin's starting mapping without a face made a board with none, whose
   cards show the symbol tile, while its Mapping tab showed the domain's first
   face. Before the arc every new board went through the pane, which puts a
   data board without a face on its domain's first one, and saved that. The
   pane's face rule is `connectorFace` now, exported from mapping-modal.js,
   and the chooser puts a starting mapping through it, so the board gets the
   face its tab would show, whether the tab was opened or not. Stage 2a's
   "a pane opened and left alone sends what the seed would" wasn't true for
   such a mapping; it is now. Crypto and Stocks set their face, so nothing
   changes for them. PLUGIN.md says what a starting mapping without a face
   gets.
8. A type with no starting mapping linked to Admin → Plugins, where nothing
   can give it one. Its card says why and has no link now.

**Left behind by the stages, cleaned up:**

- `setIngestState` lost its last caller in the app when 2a deleted the
  type-switch cleanup; only tests used it. It lives in test/helpers.js now.
  db.js's comment names the sweep's real writers (`settleIngestRun`,
  `stopIngestRun`); it had named the wrong one since before the arc.
- Comments: boards.css sent `.mapping-chip`'s base rule to styles.css;
  dropdown.css said "these two" of one caret; toolbar.js said a saved mapping
  re-reads the type chip; mapping-modal.js counted four `let`s.
- PLUGIN.md: `description` is the domain's line in the New board chooser too,
  and the capitalized domain name shows as a board's type in three places,
  not only the toolbar.

**Simplified:**

- The Tagging consistency modal's copy button calls api.js `copy()`. Stage 1
  gave `copy()` that button's no-clipboard handling line for line, so the
  button's own copy of it went. After a copy it says "copied!", like every
  other copy button, where it said "copied". Stage 1's close look had kept
  the button as it was; the pass reverses that, since the two had become the
  same code.
- The Mapping pane's dirty check no longer carries the board's type, which
  can't change.
- One `.modal-section-title` rule where the Template row's removal had left
  two in a row.
- board-modal.js works out the mapping it opens on once (`startMapping`).

**Tests tightened besides the new ones:** the reader's Copy is clicked and
writes what an admin's does; a clipboard that's there but won't be read says
"couldn't paste" (headless Chromium refuses a read without the permission); a
second flash holds for its whole moment; the refused type changes carry a new
name too, which mustn't land; Copy's text is compared to the character.
Found while testing: Windows' clipboard hands text back with CRLF line
breaks, so the test reads it with them normalized.

**Recorded, not fixed:**

- Nothing is on screen while the chooser fetches the types. A modal opened in
  that gap (Edit board from the pencil, say) ends up under the chooser.
  Picking a type then opens the board modal, which removes the open editor
  without closing it, so the page's scroll stays locked until the next Escape.
  A fetch that never answers leaves New board doing nothing until a reload.
  The root is the board modal removing an open copy of itself, recorded at
  2a; the chooser's wait is a second way in. The gap is one small request.
- Copy and Paste answer on the button that was pressed. A redraw in between
  (the connector catalog landing, or an edit made while the browser asks for
  clipboard permission) replaces that button, and the word is lost; nothing
  else is.
- The Members tab says "New login link copied" before the copy runs, so a
  refused write reads as copied, as it did before the arc. Over plain http
  the old `copy()` threw and a red toast named a JavaScript error; now the
  button says "couldn't copy" and the toast still says copied.
- new-board.test.js's `.mm-template-row` checks name a class nothing draws
  now; they stay, the guard R8 showed them to be.
- Not measured or tested: the toolbar's ingest and jobs chips since the base
  rule moved (by reading, the move doesn't touch them), and a type blocked
  for a missing key (the same code path as a missing provider).
- README.md's first screenshot link points at
  docs/screens/front/14-board-cars.png, which the user's own uncommitted docs
  change deletes.

Removal checks, each fix taken out and its tests watched failing (a script
put every file back byte-identical after each):

| removed | failed |
|---|---|
| S1: guidance Paste takes a list of fields as facets | guidance-json "a list of fields isn't a taxonomy"; fields-clipboard "each Paste refuses the other's document…" |
| S2: guidance Paste takes a description that isn't text | guidance-json "a facet whose description isn't text is refused" |
| S3: fields Paste takes a taxonomy as fields | template-core "a taxonomy isn't a list of fields…"; fields-clipboard "each Paste refuses the other's document…" |
| S4: a kind nobody offers goes out as the first kind | fields-clipboard "each Paste refuses the other's document…" |
| S5: a field pasted without a kind keeps none | fields-clipboard "each Paste refuses the other's document…" |
| S6: Copy writes a field's options as they're held | fields-clipboard "Copy writes the extracted fields…", "a reader who can't edit the mapping…" |
| S7: a refused clipboard read says nothing | fields-clipboard "with no clipboard, or one that won't be read…" |
| S8: a second flash is cut short by the first one's end | api-copy "a second flash inside the moment holds for its own moment…" |
| S9: a double click's second click goes through the fading chooser | new-board "a double-clicked type card picks once…" |
| S10: a starting mapping rides without the face its Mapping tab shows | new-board "a starting mapping without a face starts on the first face…" |
| S11: a type with no starting mapping links to Admin → Plugins | new-board "a starting mapping without a face starts on the first face…" |
| S12: a refused save writes the rest of itself first | ingest-connector "a save can't change a board's type, and a refused one changes nothing" |

Lint clean (`eslint .`). Full suite: 2,306 of 2,306 on the first run, six
more than Stage 2b's. The two browser files also pass against the built
frontend (`FRONTEND_DIR=public/dist`, after a fresh build). Stage 2b's sweep
still places every line (unplaced 0).

Real-app check (Chromium, the real server on a throwaway database, a
scratchpad script through test/browser/harness.js), for the one change no
browser test clicks: the Tagging consistency modal's copy button says
"copied!", the clipboard holds the proposed wording, and the button reads
"copy" again after the moment. On the boards page, a double-clicked Files card
left the page on /boards with the board modal open, and a type with no
starting mapping (Films, written into the list on its way to the page) shows
its reason with no link. No page errors and no failed requests.

### Stage 3a: templates on the server

(Close-looked 2026-10-01 and amended. Go-ahead the same day: "go ahead".)

**Stage 3a close look (2026-10-01): what the plan assumed vs what the code
does.** Line links are to the working copy after the second pass.

1. Assumed a merged template ships in the next image (D7). The image
   workflow rebuilds the app image only when `server/`, `public/`,
   `examples/` or a few named files change
   ([images.yml:56](../.github/workflows/images.yml#L56)). Its comment says
   that list is what .dockerignore lets into the build; `templates/` is let
   in but wasn't on it, so a merge that only adds a template would retag the
   old image. `templates/` joins the list. CI's test run has no path filter,
   so the check itself does run on a template's pull request.
2. Proof 4 had a logged-out request get a 401. `requireAdmin` answers 403
   "admin only" to a member and to nobody alike
   ([auth.js:53](../server/auth.js#L53)), and all 45 admin routes use it on
   its own. The proof expects 403 for both.
3. Assumed template-core.js checks the screenshots. It's shared with the
   browser and never touches a disk, and whether the images exist, are
   listed, are WebP or JPEG and stay under the size needs one.
   template-core checks the file's JSON, the screenshot list's shape
   included. A new server/templates.js reads the folders, checks the images,
   and runs the save's mapping check. The test calls it directly for the
   folder proofs.
4. Paste's rules check shape only (Stage 1 close look, finding 2), so a
   template that passes them can still fail at Create board: a kind nobody
   offers, a misspelled key, an instruction over 500 characters, more than 12
   extracted fields, a facet key starting with `~`. C6 sends the fields
   through `validateMapping`; the save's one facet rule
   ([server.js:2160](../server/server.js#L2160)) was missing, and proof 2
   had none of these cases. The facet rule moves to template-core.js, where
   the save and the template check both read it.
5. Checking a template against its type's starting mapping is the clash
   check: `validateMapping` refuses a repeated key
   ([mapping-rules.js:76](../server/mapping-rules.js#L76)). The built-in
   types exist as soon as the server code loads
   ([connectors/index.js:59](../server/connectors/index.js#L59)). A plugin's
   type exists only where its plugin is installed, so checking against it
   would drop a template on one server and list it on another. Only the
   built-ins are put together with a template; a plugin type's fields are
   checked alone, and a clash with its starting fields is the save's (C5).
6. `/template-shots/` as a static folder would also serve template.json and
   anything else in a folder; nothing in express.static keeps it to images.
   It serves a listed screenshot of a template that loaded, and nothing
   else, which settles proof 5's "nothing outside templates/" too. The
   browser revalidates it every time, like the HTML, because a screenshot's
   next version keeps its name.
7. Tests point the server at their own templates through a `startServer`
   option. It sets every folder variable itself, so one set beforehand would
   be overwritten ([helpers.js:112](../test/helpers.js#L112)), which is why
   `staticDir` is a parameter. The broken templates are written by the test
   into its temp folder, JSON and a few image bytes, rather than committed as
   fixture folders with binary images.
8. C1 didn't say what happens to a key it doesn't know. A typo like
   `boardtype` would make a Files template without a word, so an unknown key
   is refused, the way a mapping refuses one
   ([mapping-rules.js:58](../server/mapping-rules.js#L58)).
9. The placeholders have no screenshots (D6 makes them optional), so the
   real-app check serves one from a scratch folder.

The placeholders carry what 3b proves: the Stocks one has facets and
extracted fields (3b proofs 2 and 4), the keyed one a card key (proof 1), and
none has a screenshot (proof 6). A Stocks extracted field can't reuse one of
Stocks' 11 starting keys (`price`, `market_cap`, `sector`, …).

Checked and fine: the plugin loader logs a plugin that fails and goes on
([plugin-loader.js:529](../server/plugin-loader.js#L529)), and finds the
bundled examples' folder from its own file, not the working directory
([plugins.js:387](../server/plugins.js#L387)), which is the model for
`templates/`. .dockerignore lets `templates/` in, and the server already
imports from public/ in the image. CI runs the whole suite on every push and
pull request. `/gallery` is the precedent for files only logged-in users get
([server.js:3892](../server/server.js#L3892)). Nothing used the name
`templates` or `/template-shots` yet.

- **What:**
  - `templates/`, with the three placeholder starters (D13): a Stocks one,
    a UI one, and one with a card key. Valid and minimal: the user writes
    the real ones.
  - template-core.js: `checkTemplate`, the file's JSON (C1): only the keys
    C1 names, the slug, a name and a description, a section at least,
    `boardType` with `cardKey`, both sections through their Paste rules, the
    save's facet rule (`facetsReservedKeyError`, moved here from server.js,
    which imports it), and the screenshot list's shape.
  - server/templates.js (new): `loadTemplates(dir)` reads every folder,
    checks the JSON, checks the images (each listed one there, each one
    there listed, WebP or JPEG by its bytes, 200 KB at most), and runs
    `validateMapping` on the mapping a board made from it would save: a
    built-in type's starting mapping with the fields added, a Files board's
    fields and card key, a plugin type's fields alone. A template that fails
    is left out, with the reason.
  - server.js: `TEMPLATES_DIR` (default: `templates/` beside the code),
    loaded at startup, each failure logged; `GET /api/admin/templates`, the
    templates as checked; `GET /template-shots/:slug/:file`, a listed
    screenshot of a loaded template, to logged-in users.
  - test/helpers.js: `startServer({ templatesDir })`.
  - images.yml: `templates/` is one of the app image's inputs.
  - test/templates.test.js. CI runs it on every push, which makes it the
    check D7 asked for.
- **What the user sees:** nothing yet. The page is 3b.
- **Proofs:**
  1. Every bundled template passes (the real folder).
  2. Each rule refuses a template that breaks it, and names it (folders the
     test writes):
     - the file: not JSON, no name, a key C1 doesn't name, a bad slug,
       neither section, `boardType` with `cardKey`, a `cardKey` naming no
       field, a section its Paste would refuse, a reserved facet key;
     - the save: a kind nobody offers, more than 12 extracted fields, a field
       key clashing with a built-in type's starting fields;
     - the images: one in the folder that isn't listed, a listed one that
       isn't there, a PNG by its name, a PNG by its bytes, one over 200 KB,
       four of them.
  3. A template naming a type this server doesn't have loads, its fields
     checked alone.
  4. A failing template is logged and left out; the server starts and lists
     the rest.
  5. `GET /api/admin/templates` is admins' only: 403 for a member and for a
     logged-out request.
  6. A loaded template's listed screenshot goes to a logged-in user, member
     or admin, and not to a logged-out request. Nothing else comes through
     `/template-shots/`: not template.json, not a left-out template's image,
     not a path out of the folder.
- **Real-app check:** the real server lists the three templates, and serves a
  screenshot from a scratch folder. The image's build context has
  `templates/` in it.

**Built (2026-10-01), uncommitted:**

- `templates/`, the three placeholders, none with screenshots:
  `stock-watchlist` (Stocks: two facets, and one extracted field, `moat`,
  clear of Stocks' starting keys), `ui-screens` (Files: three facets, one
  extracted field) and `products` (Files: one facet, two extracted fields,
  the card key `product`).
- `public/template-core.js`: `checkTemplate(doc, slug)` and
  `SCREENSHOTS_MAX`. A section's own message comes back prefixed with its
  name ("guidance: …", "fields: …"), since the Paste rules were written for
  one section at a time. `facetsReservedKeyError` moved here from server.js,
  which imports it.
- `server/templates.js` (new): `loadTemplates(dir)`, giving
  `{ templates, failures }` in the order of the folders' names, and
  `SCREENSHOT_BYTES_MAX`.
- `server/connectors/index.js`: `BUILT_IN_TYPES`, taken before any plugin
  can register; a plugin can't take a built-in's name.
- `server/server.js` (CRLF kept): `TEMPLATES_DIR`; the templates load after
  the admin seed, each failure logged as "template <slug>: left out — <why>";
  `GET /api/admin/templates` beside the create route; `GET
  /template-shots/:slug/:file` beside `/thumbnails`, sent from the
  template's folder with `Cache-Control: no-cache`. Moving the facet rule
  out also mended the save function's own comment, which it had split in
  two.
- `test/helpers.js`: `startServer({ templatesDir })`, the file's mixed line
  endings kept line by line.
- `.github/workflows/images.yml`: `templates/` among the app's inputs. A
  change to this file makes the next push rebuild all four images, as
  28c9851 did.
- `test/templates.test.js` (new, 8 tests): the real folder; the workflow's
  app line; every rule, one broken template each; a plugin type; the list;
  who gets it; the screenshots; and a save's reserved facet key.

Found while building:

- No test had covered a save refusing a reserved facet key. Moving the rule,
  test/templates.test.js gained one.
- Docker's node base image isn't on this machine, and the image check didn't
  need it: the build context, exported through an empty image, shows exactly
  what .dockerignore lets in.

Removal checks, each rule or route taken out and its test watched failing (a
script put every file back byte-identical after each):

| removed | failed |
|---|---|
| R1: the image workflow skips `templates/` | "the image workflow rebuilds the app when a template changes" |
| R2: an unknown key let through | "each rule refuses a template that breaks it…" |
| R3: the folder's name not checked | "each rule refuses…" |
| R4: a card key with a board type | "each rule refuses…" |
| R5: a card key naming no field | "each rule refuses…" |
| R6: a reserved facet key let through | "each rule refuses…" |
| R7: no save rule on the mapping | "each rule refuses…"; "a template naming a type this server doesn't have…" |
| R8: a built-in type's starting fields left out | "each rule refuses…" (the clash) |
| R9: a plugin type checked like a built-in | "a template naming a type this server doesn't have…" |
| R10: an unlisted file let through | "each rule refuses…" |
| R11: a missing screenshot not named | "each rule refuses…" |
| R12: no size cap | "each rule refuses…" |
| R13: the bytes not read | "each rule refuses…" |
| R14: no count cap | "each rule refuses…" |
| R15: any file name | "each rule refuses…" |
| R16: a failing template not logged | "a failing template is logged and left out…" |
| R17: the list open to members | "the list is admins' only" |
| R18: any file in a template's folder served | "a loaded template's listed screenshot goes to anyone logged in…" |
| R19: screenshots to a logged-out request | "a loaded template's listed screenshot…" |
| R20: screenshots cached by the browser's guess | "a loaded template's listed screenshot…" |
| R21: `startServer` ignores `templatesDir` | "a failing template is logged…", "a loaded template's listed screenshot…" |
| R22: a save forgets the reserved facet key | "a save still refuses a reserved facet key" |
| R23: a repo template that fails (Stocks' `moat` renamed `sector`) | "every template in the repo passes" |

Lint clean (`eslint .`). Full suite: the first run failed one test,
welcome.test.js:291's `#gate` race, recorded since before this arc; the file
passed alone three times, and the second full run was 2,314 of 2,314.

Real-app check (the real server on throwaway databases, real Chromium, a
scratchpad script through test/helpers.js):

- The list route gives the repo's three: products (Files, card key
  `product`, one facet, two fields), stock-watchlist (Stocks, two facets, one
  field) and ui-screens (Files, three facets, one field), none with
  screenshots.
- A scratch folder's template with a real 600×360 JPEG: a logged-in browser
  gets it as `image/jpeg` with `no-cache` and draws it at 600×360; a
  logged-out one gets a 401; its template.json through the route is a 404.
- The image: the build context, exported through an empty image, has
  `templates/` with the three folders, server/templates.js and
  public/template-core.js, and still leaves out test/, node_modules and the
  data folders.

### Stage 3b: the templates page

(Close-looked 2026-10-01 and amended. Go-ahead the same day: "yes".)

**Stage 3b close look (2026-10-01): what the plan assumed vs what the code
does.** Line links are to the working copy after Stage 3a.

1. Assumed the list route's templates could fill the page as they are,
   proof 3 included. The list gave each section as its Paste takes it
   ([normalizeGuidance, template-core.js:57](../public/template-core.js#L57)),
   and the modal's Copy writes what a board stores: the facet editor's
   write-out ([board-modal.js:58](../public/board-modal.js#L58)) and
   emitField's ([mapping-modal.js:139](../public/mapping-modal.js#L139)).
   Measured, all three placeholders' guidance differed: a facet arrived as
   `key, label, single, description, values`, and a board stores `key,
   label, values, single, description`. The list also kept `single: false`,
   untrimmed text, options as written, and any key a board doesn't keep, so
   a misspelled `"singel": true` loaded and then did nothing. The two
   write-outs move to template-core.js, checkTemplate returns both sections
   through them, and a key a section doesn't have is refused, as an unknown
   top-level key already is (Stage 3a close look, finding 8).
2. Assumed the seed's mapping is what the Mapping pane would save. Two cases
   it isn't:
   - A card key brought no face, so the board would pick each card's face
     from its first file of any kind
     ([faces/select.js](../server/faces/select.js)), while its Mapping tab
     says "the first image added" and a save through the tab writes
     `prefer: "image"` ([collect, mapping-modal.js:1242](../public/mapping-modal.js#L1242)).
     The face comes from the pane's own rule, `fileFace`, exported beside
     `connectorFace`, whose fix in the second pass was the same bug for data
     boards.
   - A Files template with guidance only has to start with no mapping.
     `{ fields: [] }` would be stored as it is, and the boards page would
     mark the board as having AI-extracted fields
     ([server.js:1164](../server/server.js#L1164)). No placeholder has this
     shape; C1 allows it.
3. Assumed the save gate could take "the seed with an empty name" as its
   baseline. It snapshots `read()` at the open and at every rebase
   ([save-gate.js](../public/save-gate.js)): the AI-models strip's, and the
   live model list's `gate:rebase` when it moves a picker. It gains a
   `baseline` option, a function the baseline goes through, and a new
   board's leaves the name out. That also fixes a bug, measured in a real
   browser with the strip's feed held back 1.5s: a blank board's Create, live
   once a name was typed, went dead when the strip landed after it.
4. Assumed C4's model needs are read through `presentTrouble`
   ([capability-present.js:53](../public/capability-present.js#L53)). That
   answers "is this worth a warning": it also speaks for a degraded
   capability whose fallback runs, and for an active one whose provider's
   last call failed, and either would block a template that works. The
   entry's own `running` says whether anything would run it; a template is
   blocked when it's empty. Extraction falls back to the tagger
   ([capabilities.js:154](../server/capabilities.js#L154)), so whenever
   extraction has nothing running, tagging has nothing either, and `/welcome`,
   which draws its chooser whenever tagging isn't active, is the one fix link
   for both: the boards page strip's "Setup"
   ([boards.js:201](../public/boards.js#L201)).
5. C4 blocked "a template's card and its Use button". Reading a template and
   its Copy buttons need nothing, and Copy into an existing board is D12's
   own path, so the card always opens. It says what's missing, and only Use
   this template can't be picked.
6. Assumed the grid and the grey placeholder could be reused as they are.
   The grey tile is the gallery card's `.face-badge`, at 5:3
   ([styles.css:1299](../public/styles.css#L1299)); a board card's face is
   `.bc-face`, at 4:3 ([boards.css:257](../public/boards.css#L257)), and its
   empty state is a dashed outline that means an empty board. A template
   card is a board card: with no screenshot its face is filled with the grey
   tile's own token, the way the boards page's symbol tiles already restate
   it, and the cover crops to 4:3, not D6's 5:3. The grid's rule was
   `main#boards-grid`, in a stylesheet that said only boards.html links it,
   and welcome.css had already copied its header rules once. templates.html
   links boards.css, and the grid rule moves to a class. Start blank is the
   empty grid's dashed New board card, first in the grid. Its builder was in
   boards.js, a page that can't be imported, so it moves to a shared module
   with the card chips.
7. D8 wants a link per template that a README can point at. boards.js sends
   someone who isn't signed in to a fixed `next=%2Fboards`
   ([boards.js:33](../public/boards.js#L33)); the templates page passes its
   own address, query included, the way app.js does, and login.js keeps the
   query ([login.js:25](../public/login.js#L25)).
8. On the templates page, Start blank's chooser would offer Start from a
   template, which only reloads the page you're on. The chooser takes an
   option that leaves that card out.
9. The tests need what the plan didn't say. On a test server tagging and
   extraction both read `unavailable` (measured), so every placeholder is
   blocked: the browser tests bind a tagger the way capabilities.test.js
   does, with no network, and Stocks gets its provider installed with a
   stand-in key ([capabilities.test.js:601](../test/capabilities.test.js#L601)).
   The harness's `openApp` took no templates folder, and proof 5 and a cover
   need one, so it gains `templatesDir`. welcome.test.js changes for proof
   10, and its `#gate` race, which failed three of the last eight full runs,
   gets the condition wait it was recorded as needing.
10. The placeholders' values ("iOS", "large cap", "sign in") are ones the
    editor's value boxes can't make: they lowercase what's typed and turn
    spaces into dashes ([board-modal.js:148](../public/board-modal.js#L148)).
    They tag as they are (the worker matches values exactly,
    [worker.js:306](../server/worker.js#L306)), but retyping one rewrites it,
    and a board made by hand would hold "ios" and "large-cap". The
    placeholders take the editor's form.

What the close look was asked to read:

- **How a page boots:** boards.js's ladder (`/api/me`, then the sends for no
  session and for no password), with a member sent to `/boards` the way
  welcome.js sends one. No send to `/welcome` for an admin whose setup is
  pending: that's the landing page's, and a blocked template links there.
- **The modal door:** the gallery's only
  ([modal-door.js](../public/modal-door.js)). The page imports new-board.js
  and board-modal.js directly, like the boards page, and uses the chooser's
  own `blockedBy` and starting mapping, exported.
- **The two capability reads, per load** (measured on a throwaway database):
  `/api/admin/capabilities/tag` 16 queries and `/extract` 15, against 61 for
  the whole feed. The page's load is about 49 queries in five requests made
  together: me, templates, connectors and the two capabilities.
- **The details:** plain links, `/templates?template=<slug>`, one page
  drawing the grid or the details from its address, so the back button and
  a middle click work with no history code. A slug that isn't loaded shows
  the grid and says so.
- **Phone:** the grid is one column and fits from 360px wide. At 320px it
  was 24px too wide (measured: the page widened to 344px), on the boards
  page too; `min(320px, 100%)` in the shared rule fixes both. The details are
  one reading column at every width, with Use this template in its head.

Checked and fine: nothing used `/templates`; express.static serves
`templates.html` there ([server.js:3962](../server/server.js#L3962)) and the
build picks up every page in public/
([build-frontend.mjs:72](../scripts/build-frontend.mjs#L72)). A Stocks
template composes from the chooser's own starting mapping, and `moat` is
clear of Stocks' starting keys. A double click on Use can't open two editors:
a new board's modal is up before the click returns, since nothing is fetched
first.

- **What:**
  - template-core.js: `facetOut`, the facet editor's write-out, which the
    editor uses; `cleanOptions`, moved from mapping-modal.js; and
    `extractedFieldOut`, an AI-extracted field's write-out, which emitField
    uses. checkTemplate returns guidance as `{ context, facets }` and both
    sections through those, and refuses a key a guidance document, a facet
    or a field doesn't have.
  - mapping-modal.js: `fileFace`, the face a card key brings, read by
    collect() and the Face row, exported.
  - save-gate.js: a `baseline` option, applied at the open and at every
    rebase. board-modal.js: `seed.name`, `seed.context` and `seed.facets`,
    and a new board's baseline with its name left out (C5; moved here from
    2a, Stage 2a close look, finding 5).
  - new-board.js: the **Start from a template** card, last, a link to
    `/templates`, left out when the chooser is opened with
    `templatesCard: false`; `blockedBy` and `startingMapping` exported.
  - board-grid.js (new): the empty grid's dashed card and the card chips,
    moved out of boards.js. boards.css: the grid rule on `.bc-grid`, its
    column at `min(320px, 100%)`.
  - `public/templates.html`, `templates.js` and `templates.css`: the grid
    (Start blank, then a board card per template: its cover or the grey
    face, name, description, type chip and chips, and what's missing); the
    details at `?template=<slug>` (screenshots with captions, description,
    author, type, the guidance and the fields each with its Copy, the card
    key, and Use this template or what's missing with its fix link); Use
    opens the board modal from the seed, and a save goes to the new board.
  - welcome.js: "Make your first board" goes to `/templates`.
  - harness.js: `openApp({ templatesDir })`.
  - The placeholders' values in the editor's form.
- **What the user sees:** the templates page. The chooser's templates card.
  A new admin lands on the templates after connecting a model.
- **Proofs:**
  1. Use this template opens the modal filled: name, context and facets,
     the extracted fields in the Mapping pane, and the card key. Create
     board with the Mapping tab never opened makes that board, its card
     key's face the one the tab shows (browser, the mapping read back).
  2. A Stocks template makes a Stocks board: the starting fields and the
     template's extracted fields together.
  3. A section's Copy on the details writes exactly what the modal's Copy
     writes for a board made from it (browser). checkTemplate returns the
     sections as a board stores them, and refuses a key one doesn't have
     (template-core and templates tests).
  4. A blocked template's Use can't be picked and says why, with its fix
     link: its type unavailable, or nothing running tagging when it has
     facets. A tagger that runs but whose last call failed doesn't block.
     The card still opens.
  5. A template whose type this server lacks says "Needs the … plugin".
  6. A template with no screenshots shows the grey face; one with
     screenshots shows its cover, and the details show each with its
     caption.
  7. `/templates?template=<slug>` opens those details directly, the back
     button returns to the grid, a slug that isn't loaded shows the grid and
     says so, and someone who isn't signed in comes back to the details after
     signing in.
  8. Start blank opens the chooser, without its templates card; everywhere
     else the chooser's templates card goes to `/templates`.
  9. A member who opens `/templates` lands on `/boards`.
  10. Welcome's button goes to `/templates` (welcome.test.js).
  11. A template's Create board is live as soon as the modal opens, and
      still live after the AI-models strip lands; a blank board's typed name
      keeps its Create live when the strip lands after it.
  12. A Files template with guidance only makes a board with no mapping.
  13. At 320px wide neither the boards page nor the templates page scrolls
      sideways.
- **Real-app check:** a first run on a fresh database: welcome, connect a
  model, the templates page, a template, Create board, the board. Once more
  at phone width, since room was D8's reason for a page.

**Built (2026-10-01), uncommitted:**

- `public/template-core.js`: `facetOut` (the facet editor's write-out, which
  its `sync()` now calls), `cleanOptions` (moved from mapping-modal.js) and
  `extractedFieldOut` (an AI-extracted field's write-out, which emitField
  calls for every extracted field). checkTemplate returns guidance as
  `{ context, facets }`, the context trimmed and "" when there's none, both
  sections through the write-outs, and refuses a key a guidance document, a
  facet or a field doesn't have.
- `public/mapping-modal.js` (CRLF kept): emitField writes an extracted field
  through `extractedFieldOut`; `fileFace`, exported beside `connectorFace`,
  is the card key's face in collect(), the Face row and its drawer, which
  had each spelled the default out; `formatWord` exported for the details.
- `public/save-gate.js`: the `baseline` option, at the open and at every
  rebase. `public/board-modal.js`: `seed.name`, `seed.context` and
  `seed.facets`, and a new board's gate with its name left out of the
  baseline.
- `public/new-board.js`: the Start from a template card, last, a link to
  `/templates`, left out with `templatesCard: false`; `blockedBy` now gives
  `{ why, fix }`, and `blockedNote` draws it, for the chooser and the
  templates page alike; `missingType` and `startingMapping` exported.
- `public/board-grid.js` (new): `newBoardCard(words, onClick)`, `cardChip`
  and `countLabel`, out of boards.js (CRLF kept). `public/boards.css`: the
  grid's rule on `.bc-grid` (boards.html's grid wears it), its column at
  `min(320px, 100%)`, and a `[hidden]` rule.
- `public/templates.html`, `templates.js`, `templates.css` (new): the page.
- `public/welcome.js` (CRLF kept): Make your first board goes to
  `/templates`.
- `public/modal.css`: the chooser's link card, and `.tp-actions button` in
  the action-row button list. `public/type.css`: the details' title joins
  the title list.
- `test/browser/harness.js`: `openApp({ templatesDir })`.
- The placeholders' values in the editor's form: `large-cap`, `ios`,
  `sign-in`, `empty-state`, `personal-care` and the rest.
- Tests: test/browser/templates-page.test.js (new, 14: the page on a
  server reading a folder the test writes, the repo's three templates copied
  in and three more); template-core.test.js (the write-outs, the checked
  shape); templates.test.js (three refusals); save-gate.test.js (the
  baseline option); new-board.test.js (the chooser's last card);
  welcome.test.js (proof 10, and the `#gate` race's condition wait).

Found while building:

- The page's header row would have been a third copy: boards.js and
  welcome.js each built the logo and the user menu by hand. It's
  user-menu.js's `pageToolbar` now, used by all three.
- The grid's own `display: grid` beat the `hidden` attribute, so a hidden
  grid kept its padding: under the boards page's gate until now, and under a
  template's details here. `.bc-grid[hidden]` puts it away.
- The templates page needs the chooser's blocked box (a reason and its fix
  link), so the box became `blockedNote` instead of a second copy.
- The details' tagging line names both capabilities when both have nothing
  running, with one fix link: "Tagging and field extraction — needs a key".
- The page's test binds its tagger to a stand-in on 127.0.0.1 that answers
  the model list, so the board modal's live model list never reaches the
  internet.
- The welcome test's first fix waited for the boards page's `header`, which
  styles.css draws (`display: grid`) whatever its `hidden` attribute says, so
  the wait returned at once and the race failed the first full run. It
  waits for the gate itself now.

Removal checks, each fix or proof taken out and its tests watched failing (a
script put every file back byte-identical after each, and the files' hashes
were checked against their state before the run). Later tests in
templates-page.test.js read the boards earlier ones make, so a check that
breaks an early one fails some later ones too; the table names the tests
that fail on their own assertion.

| removed | failed |
|---|---|
| B1: facets come back as Paste took them | template-core "a template's sections come back as a board made from it stores them"; templates-page "Copy on the details writes exactly what the board's own Copy writes…" |
| B2: fields come back as Paste took them | template-core "a template's sections come back…" |
| B3: the context neither trimmed nor filled in | template-core "a template's sections come back…" |
| B4: a facet key a board doesn't keep let through | templates "each rule refuses a template that breaks it…" |
| B5: a field key a board doesn't keep let through | templates "each rule refuses…" |
| B6: a guidance key a board doesn't keep let through | templates "each rule refuses…" |
| B7: the details copy the guidance unformatted | templates-page "Copy on the details…" |
| B8: a card key brings no face | templates-page "Use this template opens the board modal filled…" |
| B9: guidance only seeds `{ fields: [] }` | templates-page "a Files template with guidance only makes a board with no mapping" |
| B10: a type's starting fields dropped | templates-page "a Stocks template, once Stocks can serve…" |
| B11: a new board's gate keeps the name | templates-page "Use this template…", "a blank board's name, typed before the AI-models strip lands…" |
| B12: a rebase ignores the baseline option | save-gate "a baseline option says what counts as unchanged…"; templates-page "Use this template…", "a blank board's name…" |
| B13: the open ignores the baseline option | save-gate "a baseline option…" |
| B14: blocked through presentTrouble | templates-page "with nothing running tagging a template that tags is blocked; a tagger whose last call failed…" |
| B15: a blocked template's card isn't a link | templates-page "the grid: Start blank first…" |
| B16: the card's reasons keep their links | templates-page "the grid…" |
| B17: a blocked template's Use still shows | templates-page "a blocked template's details say why…", "with nothing running tagging…" |
| B18: no grey face | templates-page "the grid…" |
| B19: no cover | templates-page "the grid…" |
| B20: the hidden grid still takes room | templates-page "a template's details…" |
| B21: the grid's column a fixed 320px | templates-page "at 320px wide neither the boards page nor the templates page scrolls sideways" |
| B22: signing in forgets the template | templates-page "a link to a template comes back to it after signing in…" |
| B23: a missing template says nothing | templates-page "a link to a template comes back…" |
| B24: a missing template's address stays | templates-page "a link to a template comes back…" |
| B25: Start blank's chooser offers the templates | templates-page "Start blank opens the chooser, without its templates card…" |
| B26: the chooser has no templates card | new-board "the empty grid's card opens the chooser…"; templates-page "Start blank opens the chooser…" |
| B27: `openApp` ignores `templatesDir` | templates-page "the grid…", "a template's details…", "a blocked template's details…" |
| B28: the seed's name left out | templates-page "Use this template…" |
| B29: the seed's context left out | templates-page "Use this template…" |
| B30: the seed's facets left out | templates-page "Use this template…", "a Files template with guidance only…" |
| B31: a missing type not named | templates-page "the grid…", "a blocked template's details…" |
| B32: members not sent away | templates-page "a member who opens the templates lands on the boards page" |
| B33: welcome goes to the boards page | welcome "Connect runs the three calls, and only then does a board become the next step" |
| B34: the boards page never clears its gate | welcome "a configured instance has nothing to do here, so it doesn't stay" (the condition wait) |

Lint clean (`eslint .`). Full suite: the first run was 2,331 of 2,332, its
one failure the welcome wait above; the second, after the fix, 2,332 of
2,332, eighteen more than Stage 3a's. The three browser files also pass
against the built frontend (`FRONTEND_DIR=public/dist`, after a fresh
build), 34 of 34; the build picked up templates.html with no edit to it.

Real-app check (the real server on throwaway databases, real Chromium, a
scratchpad script through test/browser/harness.js, a stand-in model server
on 127.0.0.1):

- A fresh database: the boards page sent the admin to /welcome; Ollama,
  Connect, "Make your first board" landed on /templates: Start blank,
  Products, Stock watchlist ("No Stocks provider is installed") and UI
  screens, each with the grey face.
- UI screens' details: its type chip, Use this template, both sections with
  their Copy, the values as the gallery's pills. Use opened the board modal
  named "UI screens", its Files chip, the context and taxonomy filled, and
  Create live with the AI-models strip landed; the Mapping tab showed
  `app`. Create went to the new board, whose created toast showed,
  with its three facets and its `app` field.
- At 390px wide: the grid one column, the details one column with no
  sideways scroll, the board modal filled, Create, the board.
- No page errors and no failed requests.

Recorded, not fixed:

- The `hidden` attribute on the boards, welcome and templates pages'
  `<header>` hides nothing: styles.css gives `header` `display: grid`, so the
  header's empty card shows above "Checking access…" until the page draws
  its toolbar. It's older than this arc. (Fixed in Stage 4.)

### Stage 4: second pass

A fresh-eyes read of everything the arc shipped: review it, simplify it, a
test per fix, the suite. No new scope. Stages 1, 2a and 2b had theirs on
2026-10-01 (above, after Stage 2b), so this one reads 3a and 3b, and how the
whole arc fits together.

(Asked for the same day: "ok, 2nd pass on 3".)

Three read-only reviewers, none shown this plan. One took the server half:
the template check, the loader, the two routes and the packaging. One took the
templates page and what it opens: the chooser, the board modal's seed, the
save gate's baseline, and their tests. One read across the whole arc for
rules written twice, exports and their callers, leftovers, comments, the
bundle and permissions. My own read checked this plan's claims against the
code and each new test's setup; the one thing it found, a stale comment on
the list route, two reviewers found too. All three found the bundle, the
image and the routes' permissions sound.

**Found and fixed, each with a test:**

1. A template's facets were checked only as far as Paste checks them. A paste
   lands in the board editor, where a facet that's wrong shows and gets
   fixed; a template goes straight into a board. So these loaded, made their
   board, and then never tagged: a facet with no key (a label with no Latin
   letters makes none), a key holding "/" (a tag is stored as key/value), the
   key "fit" (the tagger's own verdict on an item takes it, worker.js), two
   facets with one key, no label, values that aren't a list of text
   (`"values": "s, m, l"` became an empty list, and `[2023, 2024]` can't
   match what the tagger answers), a value listed twice, and
   `"single": "false"`, stored as on. Two reviewers found it. The template
   check refuses each, naming the facet; Paste and a save are as they were.
2. A field whose match list had nothing in it loaded as a plain text field:
   the write-out drops an empty list, where the Mapping pane refuses one at
   Save. It's refused now.
3. A template whose sections hold nothing (`"fields": []` alone, or guidance
   with no context and no facets) loaded and made a blank board with a name.
   "A template needs a context, a facet or a field to set up" now, checked on
   what the sections hold rather than on which keys are there.
4. A screenshot's entry let an unknown key through (`"captoin"` loaded with
   no caption), unlike every other part of the file. Its caption wasn't
   trimmed, which the check's comment says it is, and the message for a bad
   file name left out `.jpeg`, which passes.
5. A double-click on Use this template opened the board modal and closed it
   at once wherever the button lies outside the modal's 600px dialog: its
   left 64px on a wide screen (measured in Chromium). The first click opens
   the modal on the spot, and the second lands on its backdrop, whose
   click-out closes it. modal.js's click-out no longer counts a double-click's
   second press, for every modal.
6. When the templates list failed to load, the page showed only the error,
   Start blank gone too, and a new admin lands here from the welcome screen.
   Start blank stays, beside the note.
7. Older than the arc, recorded at 3b: the boards, welcome and templates
   pages showed their header, an empty card, above "Checking access…",
   because styles.css draws `header` as a grid, which beats the `hidden`
   attribute. `header[hidden]` hides it now; all three pages unhide theirs
   when they draw its toolbar.
8. The fix links on a template's details were the browser's blue inside the
   amber box, where the chooser's take the box's ink. The chooser's rule
   covers the details too.
9. With its name cleared, a template's dead Create said "Nothing to save — no
   changes yet" over a modal full of the template. A new board's dead Create
   always means it has no name, and says "Name the board to create it".

**Left behind, cleaned up:**

- Comments: the list route said the sections come back "as their Paste
  takes them" (as a board stores them, since 3b); server/templates.js said a
  listed template can always be made (not against a plugin type's own
  starting fields, as its own comment further down says) and that its test
  keeps a failing template from being merged (it fails CI); boards.js said
  the welcome screen's button lands on the empty grid; mapping-rules.js said
  a type's starting mapping makes a board "verbatim" (its face goes through
  the Mapping tab's rule since the first second pass); user-menu.js counted
  three surfaces and had the boards and welcome pages build their own row;
  toolbar.js still said "data-source chip"; templates.js said a template
  card's chips are "the way a board's card shows them" (a template card
  names its type always, Files too, and a board's card only a live-data
  type).
- test/templates.test.js left its temp folders behind.

**Simplified:**

- The chips both grids draw are board-grid.js's `typeChip`, `fieldsChip` and
  `facetsChip`; the boards page and the templates page each spelled the
  titles out.
- A card's resting shadow is one token, `--card-shadow` in styles.css, where
  four rules wrote it out: the gallery's cards, the board cards, and the
  details' screenshots and sections.
- The face period rule (the one asked for, or 1y, or the producer's first)
  is mapping-modal.js's `periodFor`, which connectorFace and the Face
  drawer's producer pick each had a copy of. The producer pick had no test;
  it has one now.
- The templates page finds a template's type in one place, and
  `SCREENSHOTS_MAX` isn't exported: nothing outside its file read it.

**Tests tightened besides the new ones:**

- The Mapping tab test waits for the AI-models strip before opening the tab:
  the strip's rebase, landing after, would have taken in a pane that wrongly
  read as edited.
- The Stocks test clicks the new Stocks board's own fields Copy and compares
  it with the details', which its comment said and it didn't do.
- The save gate's baseline test proves the late rebase landed: with the name
  gone again, the moved picker is part of what it counts from.
- The grid test reads the template cards' chips and shadow.

**Declined, with why:**

- A field with no kind is refused at load with validateMapping's `invalid
  kind "undefined" for field …`, while Paste then Save makes it text. The
  message names the field, and a field Copy always writes a kind; a default
  here would be a third copy of the extract source's first kind.
- A board type written "files" or "Stocks" loads, and its card says "Needs
  the Files plugin" on every server: plain on the page at once, and a plugin
  spells its own type's name, in any case.
- The card key's check repeats validateMapping's: kept, since it runs first
  and names the template's card key.
- One mapping builder for the loader and the page: they differ only by the
  face the page adds, which always passes.
- checkTemplate moving into server/templates.js, its only caller: C2 puts
  the rules both documents and the file are checked by in one module.
- One boot ladder for the boards, welcome and templates pages: each differs
  (members stay on one, a set-up instance leaves another).
- Reading a screenshot whole to check its size and first bytes: 200 KB at
  most, once, at startup.
- `missingType` moving to templates.js, its only reader: it sits beside
  `blockedBy`, the other reason a type can't be used, with the same fix link.

**Recorded, not fixed:**

- A plugin type's template can clash with that plugin's own starting fields,
  or pass 12 extracted fields with them. It's listed and usable, and Create
  refuses it, naming the key (Risks; Stage 3a close look, finding 5). The
  page has the plugin's starting mapping and could say so before Create. No
  plugin-typed template ships.
- Use is refused when nothing app-wide runs tagging, though a board's own pin
  in the AI-models strip could run it (C4). The fix link goes to /welcome,
  which sets the app's default; after it, the welcome screen's button goes
  to the templates grid rather than back to the template.
- The chooser names a plugin's type by its label; the toolbar, the board
  editor's chip, the boards page and the templates page by its capitalized
  name. They differ only for a plugin whose label isn't its name.
- No log line when the templates folder is missing: the page shows only
  Start blank. The image workflow's path is tested; .dockerignore isn't.
- A screenshot on the details that fails to load shows the browser's broken
  image; the card's cover falls back to the grey face. Every screenshot was
  read at startup.
- Members get a template's screenshots by their address (3a, proof 6),
  though only admins get the list. They're the repo's own files.

Removal checks, each fix taken out and its tests watched failing (a script
put every file back byte-identical after each, and the files' hashes were
checked against their state before the run). P1 to P12 fail the one table
test of the template check, each on its own broken template, named below.

| removed | failed |
|---|---|
| P1: a facet with no key | templates "each rule refuses a template that breaks it…" (`facet-no-key`) |
| P2: a facet key holding "/" | the same (`facet-slash`) |
| P3: a facet keyed "fit" | the same (`facet-fit`) |
| P4: two facets with one key | the same (`facet-twice`) |
| P5: a facet with no label | the same (`facet-no-label`) |
| P6: values that aren't a list of text | the same (`values-as-text`, `values-as-numbers`) |
| P7: a value listed twice | the same (`value-twice`) |
| P8: `single` that isn't true or false | the same (`single-as-text`) |
| P9: an empty match list | the same (`empty-options`) |
| P10: the old rule, either key present | the same (`empty-sections`) |
| P11: a screenshot's unknown key | the same (`shot-typo`) |
| P12: captions not trimmed | the same (`good`) |
| P13: no Start blank when the list fails | templates-page "when the templates won't load, the page says so and Start blank still works" |
| P14: a double-click's second press closes the modal | templates-page "a double-click on Use this template leaves the board modal open…" |
| P15: no `header[hidden]` rule | templates-page "the page's header stays hidden behind the access check" |
| P16: the details' fix link in the browser's blue | templates-page "a blocked template's details say why…" |
| P17: a new board's dead Create says "no changes yet" | templates-page "…and its Mapping tab shows the template's fields…" |
| P18: no `--card-shadow` | templates-page "the grid…" |
| P19: a `gate:rebase` event ignored | save-gate "a baseline option says what counts as unchanged…" (its new last assertion), "a control that moved ITSELF says so…" |
| P20: the Mapping pane reads as edited once opened | templates-page "…and its Mapping tab shows the template's fields…" |
| P21: a data board's fields Copy takes every field | templates-page "a Stocks template, once Stocks can serve…" |
| P22: a template card names only a live-data type | templates-page "the grid…" |
| P23: the Face drawer's producer pick keeps a period the producer doesn't offer | board-modal-gate "picking another face producer lands on a period it offers" |

Lint clean (`eslint .`). Full suite: the first run was 2,335 of 2,336. Its
one failure was ui-updates.test.js's "a menu's button changes under the open
menu…", which sleeps 250ms for a caret that turns over 0.12s, and read it
unturned. Nothing in this pass reaches that menu (and nothing in the gallery
hides its header, the one shared rule added), it passed alone three times,
and the second run was 2,336 of 2,336, four more than Stage 3b's. The three
browser files also pass against the built frontend (`FRONTEND_DIR=public/dist`,
after a fresh build), 37 of 37.

Real-app check (the real server on throwaway databases, real Chromium, a
scratchpad script through test/browser/harness.js, a stand-in model server on
127.0.0.1):

- The grid with each card's chips; Stock watchlist's details, its fix link in
  the amber box's ink; UI screens' Use by a double-click, the modal open; its
  name cleared, Create's title "Name the board to create it"; named again,
  Create, the board.
- One shadow on the gallery's cards, the board cards and the template cards.
- The boards page: the new board's chips as before (the AI mark and its
  taxonomy; a Files board's card names no type).
- The boards, welcome and templates pages with the access check held: no
  header until it answered, then the header.
- The list answering 500: Start blank, and the note under it.
- The double-click measured again at 1280 and 900 wide, at the button's left
  edge and its middle: the modal stays open in all four (before the fix it
  closed at the left edge at both widths).
- 390px: no sideways scroll. No page errors; the one failed request was the
  deliberate 500.

Also recorded, outside this arc: ui-updates.test.js's caret test sleeps
250ms for its transition, and a loaded run can draw no frame in that time. A
wait for the caret's turn would hold.

## Risks and edges

- **No board migrates.** A board's type is what its mapping already says,
  and nothing about existing boards changes except that the type can't be
  switched.
- **A wrong type can't be fixed in place.** Delete the board and make a new
  one. That was already true of any board with items, and it's D15's call.
- **A plugin's starting mapping can change between its versions.** A
  template names only the type, so it composes with whatever the installed
  plugin gives; a clash is refused at the save, naming the key.
- **Copy and Paste need a secure page** (https, or localhost). A server
  reached over plain http on a LAN address has no clipboard, which is
  already true of Tagging Guidance's Copy and Paste. The templates page's
  Copy has the same limit, and Use this template doesn't need the clipboard
  at all.
- **Template text reaches the tagging model.** Guidance and field
  instructions become prompts on the user's own key. Only reviewed pull
  requests can add them (D1, D7).

## Deferred

- **A license for submitted templates.** "i don't care about that now -
  there's no one to submit templates; i haven't made the app public." The
  repo has no LICENSE file; that comes up again when submissions can.

## Next

Nothing in the plan: every stage is built and second-passed. A push when the
user asks, with the arc's new files and without their own uncommitted ones.
