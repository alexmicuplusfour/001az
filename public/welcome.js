// Welcome — the first screen of a fresh instance (planning/welcome-plan.md
// Stage 2). One decision: connect a model. Everything else on the page is
// either a consequence of that decision or a way out of it.
//
// It is a FOURTH SHELL over the same status feed the Capabilities tab, the
// plugin modal and the board modal wear (capability-present.js). Nothing here
// names a capability, and nothing here re-derives a state: the disclosure
// section's words come from `presentChip`, so this screen and the admin page
// can never describe the same server differently.
//
// Relative specifiers, not the root-absolute `/x.js` form the admin pages use,
// for the reason boards.js spells out: a module specifier resolves against the
// URL of the importing MODULE, so `./api.js` is `/api.js` whether this page was
// reached as `/welcome` or `/welcome.html` — and the root-absolute form would
// resolve to the filesystem root under Node, which would make this file
// untestable.
import { api } from "./api.js";
import { userMenuButton } from "./user-menu.js";
import { ICONS, glyphEl } from "./utils.js";
import { openBoardModal } from "./board-modal.js";
import { busy } from "./modal.js";
import { presentChip, labelIn } from "./capability-present.js";

const LOGIN = "/login.html?next=%2Fwelcome";
const el = (id) => document.getElementById(id);

const me = await fetch("/api/me", { cache: "no-store" })
  .then((r) => r.json())
  .catch(() => null);

// The page's own gate, and deliberately not a copy of the boot rung in
// boards.js. That one asks "should this admin be sent here"; this one asks "may
// whoever arrived be here at all", which is a different question with a
// different answer — an admin who finished setup weeks ago may walk in from the
// Setup menu row and must NOT be bounced. Being here is never a claim that
// anything is unconfigured.
if (!me) {
  location.replace(LOGIN);
} else if (me.needs_password) {
  location.replace("/login.html");
} else if (!me.is_admin) {
  // Every route this page calls is requireAdmin, so a member would watch it
  // fail one request at a time. Send them where their answer actually is.
  location.replace("/boards");
} else {
  el("gate").hidden = true;
  document.querySelector("header").hidden = false;
  el("welcome").hidden = false;
  renderToolbar();
  load();
}

// --- toolbar: the boards page's row 1, minus the button that makes no sense
// here. "New board" is the thing this screen ENDS with, and offering it in the
// corner before a model exists is the shortcut past the only decision on the
// page.

function renderToolbar() {
  const logo = document.createElement("a");
  logo.className = "toolbar-logo";
  logo.href = "/boards";
  logo.textContent = "001az/";

  const auth = document.createElement("div");
  auth.className = "auth"; // margin-left:auto pushes it to the right edge

  auth.appendChild(userMenuButton({ me, afterSignOut: () => location.replace(LOGIN) }));

  el("toolbar").replaceChildren(logo, auth);
}

// --- the two feeds ---

// `tag` is the only capability this page has an opinion about, and it is named
// here for the same reason capability-resolve.js names it: one backbone is a
// fact about this product, not a table.
let tagCap = null;

async function load() {
  let caps, plugins;
  try {
    // In parallel, not in sequence: they share nothing, and the capabilities
    // feed is the expensive one (~67 queries, most of them for the three rows
    // in a section that starts closed).
    [caps, plugins] = await Promise.all([
      api("GET", "/api/admin/capabilities").then((r) => r.capabilities),
      api("GET", "/api/admin/plugins").then((r) => r.plugins),
    ]);
  } catch (err) {
    // Inline, like the boards page's load failure: on an otherwise blank page
    // the failure IS the content.
    el("w-tiles").replaceChildren(errEl(`Couldn't load this server's setup: ${err.message}`));
    return;
  }

  tagCap = caps.find((c) => c.id === "tag");
  renderTiles(plugins);
  renderOthers(caps);
  // Already served — an admin who walked in from the Setup row rather than
  // being sent. Say so instead of asking again.
  if (tagCap?.state === "active") settled(tagCap.running);
}

// Who can be picked. Two populations, one list:
//
//   registered providers that advertise tagging — the built-ins, plus any
//   plugin already installed; their `capabilities.tag` is the descriptor's
//   own answer;
//   bundled AI-provider plugins nobody has installed — examples/plugins/*,
//   listed by the manifest alone (Stage 2b).
//
// A bundled row cannot be filtered on `capabilities.tag`: it has no descriptor
// yet, so it advertises nothing. Every bundled AI provider is offered and the
// honesty lands one step later — picking one that turns out not to tag fails at
// the bind, in the app's own words ("X advertises no tagging"). Guessing here
// would need a manifest field claiming a capability nothing has verified, which
// is a worse lie than a late, accurate error.
const taggers = (plugins) =>
  plugins.filter((p) => p.kind === "ai" && !p.ai?.onDevice && (p.bundled || p.capabilities?.tag));

// Keyless first, and — in the tile and again in the card — the one row that
// says anything about itself. It is the only provider someone can finish
// without deciding to spend money, and on a fresh instance the only one that
// isn't a vendor account, so it is what the screen should open with.
//
// One predicate for two populations: an installed provider answers from its
// descriptor, a bundled one from its manifest's listing hint, which is the only
// thing knowable before its code runs.
const isKeyless = (p) => (p.bundled ? p.bundled.keyless : !!p.ai?.keyless);

// Name, plus a line only where the terms differ from every other row's. Five
// rows that all say "needs a key" carry no information; the entropy is in the
// exception. Shared by the tile and the card it becomes — they are the same
// identity twice, and were two copies of this block until they weren't.
function identity(p) {
  const box = document.createElement("div");
  const name = document.createElement("div");
  name.className = "w-name";
  name.textContent = p.label;
  box.appendChild(name);
  if (isKeyless(p)) {
    const note = document.createElement("div");
    note.className = "w-note";
    note.textContent = "on your machine";
    box.appendChild(note);
  }
  return box;
}

function renderTiles(plugins) {
  const rows = taggers(plugins).sort((a, b) => Number(isKeyless(b)) - Number(isKeyless(a)));
  if (!rows.length) {
    el("w-tiles").replaceChildren(errEl("No AI providers are available on this server."));
    return;
  }
  el("w-tiles").replaceChildren(...rows.map(tile));
}

function tile(p) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "w-tile";
  b.dataset.plugin = p.id;
  b.append(markEl(p.label), identity(p));
  b.addEventListener("click", () => pick(p, b));
  return b;
}

// The monogram: the label's first letter, upper-cased. No vendor assets, no
// id→glyph table — a provider that arrives as a plugin is marked for free and
// nothing has to be kept in step with anyone's brand.
function markEl(label) {
  const m = document.createElement("span");
  m.className = "w-mark";
  m.textContent = (label.trim()[0] || "?").toUpperCase();
  return m;
}

const errEl = (text) => {
  const d = document.createElement("div");
  d.className = "w-err";
  d.textContent = text;
  return d;
};

// --- picking one ---

// Whose card is on screen, and null while the chooser is. Page state like
// tagCap above, rather than a parameter threaded through the connect sequence:
// every step below is about this one provider, and three functions asking for
// it by argument was three chances to hand along a different one.
let picked = null;

// Picking collapses the grid: you never look at four vendors you already
// rejected. The install fires HERE rather than on Connect, because a bundled
// plugin's manifest cannot say whether its field is an API key or a server URL
// — only its descriptor can, and the descriptor does not exist until the code
// is loaded. The install answers the question and the card is drawn from its
// reply (welcome-plan.md 2.3).
async function pick(p, tileBtn) {
  if (!p.bundled) return showCard(p);
  const run = busy(tileBtn, async () => {
    try {
      const { plugin } = await api("POST", "/api/admin/plugins/install", { url: p.bundled.path });
      showCard(plugin);
    } catch (err) {
      // On the tile, not in the card: there is no card yet, and an error that
      // outlives the thing that caused it is the toast rule this page avoids.
      el("w-tiles").appendChild(errEl(`Couldn't add ${p.label}: ${err.message}`));
    }
  });
  await run();
}

function showCard(p) {
  picked = p;
  el("w-tiles").hidden = true;
  const card = el("w-picked");
  card.hidden = false;
  // Assigned, not added: a card re-opened after the back arrow must not still
  // be wearing is-done from a previous pick.
  card.className = "w-picked w-rise";

  // band 1 — who this is, and the way back
  const back = document.createElement("button");
  back.type = "button";
  back.className = "w-back";
  back.setAttribute("aria-label", "Pick a different provider");
  back.innerHTML = ICONS.arrowLeft;
  back.addEventListener("click", () => {
    picked = null;
    card.hidden = true;
    el("w-tiles").hidden = false;
  });

  const id = identity(p);
  id.className = "w-picked-id";

  const head = document.createElement("div");
  head.className = "w-picked-head";
  head.append(back, markEl(p.label), id);

  // band 2 — a LABELLED field, full width. Which one it is comes from the
  // descriptor, which is why the install had to happen first.
  const needsBase = !!p.ai?.needsBase;
  const field = document.createElement("div");
  field.className = "w-field";
  const label = document.createElement("label");
  label.htmlFor = "w-secret";
  label.textContent = needsBase ? "Server URL" : "API key";
  const input = document.createElement("input");
  input.id = "w-secret";
  input.type = needsBase ? "text" : "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  if (needsBase) input.placeholder = p.ai.base || "http://…";
  field.append(label, input);

  // band 3 — the action, and one dot per call it makes
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "Connect";
  const trace = document.createElement("div");
  trace.className = "w-trace";
  const dots = [0, 1, 2].map(() => {
    const d = document.createElement("span");
    d.className = "w-dot";
    trace.appendChild(d);
    return d;
  });
  const actions = document.createElement("div");
  actions.className = "w-actions";
  actions.append(go, trace);

  const err = document.createElement("div");
  err.className = "w-err";
  err.hidden = true;

  card.replaceChildren(head, field, actions, err);

  const onConnect = busy(go, () => connect(input, dots, err));
  go.addEventListener("click", onConnect);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") onConnect(); });
  input.focus();
}

// The three calls, each reporting the message its own route already writes. No
// composite endpoint, deliberately: three calls means three honest failure
// points, and a server that answered "setup failed" would have to invent a
// sentence none of them said.
//
// The ORDER is forced, not chosen: the probe resolves the capability before
// calling it, so the binding has to exist first. Which means a failed probe
// leaves this instance bound and broken — and `setup_pending` false, so a
// reload lands on the boards page rather than back here. That is why a failure
// keeps the reader ON this card with what they typed still in the field: it is
// the last cheap chance to fix a typo.
async function connect(input, dots, err) {
  const p = picked;
  err.hidden = true;
  for (const d of dots) d.classList.remove("is-on");
  const typed = input.value.trim();
  const needsBase = !!p.ai?.needsBase;
  if (!typed && !p.ai?.keyless) { input.focus(); return; }

  try {
    const body = { name: p.label, provider: p.name, key: needsBase ? "" : typed };
    if (needsBase) body.base_url = typed || p.ai.base || "";
    const { id: keyId } = await api("POST", "/api/admin/ai-keys", body);
    dots[0].classList.add("is-on");

    // Picking IS installing (welcome-plan.md 4.3). Every rung of resolution is
    // gated on the provider's plugin being installed (capability-resolve.js,
    // disqualified) and registering a key installs nothing — so without this
    // the bind below succeeds, the probe answers "No default API key
    // configured", and the reader is told they have no key on the step after
    // they pasted one. That was four of the five keyed built-ins; the bundled
    // rows escaped it only because 2.3 installs them at tile-click for an
    // unrelated reason.
    //
    // Unconditional rather than branched on `p.bundled`: `p` is the real def by
    // now either way — a bundled one arrives as the install's own reply — and
    // the route is idempotent, so the bundled path pays one no-op call instead
    // of a condition someone has to keep true.
    //
    // After the key and not before, because a rejected field is the common
    // failure and it should leave nothing behind. No fourth dot: this is part
    // of connecting, not a step the reader took.
    await api("PATCH", `/api/admin/plugins/${p.id}`, { installed: true });

    await api("POST", "/api/admin/capabilities/tag/bind", { keyId });
    dots[1].classList.add("is-on");

    const probe = await api("POST", "/api/admin/capabilities/tag/probe");
    dots[2].classList.add("is-on");
    settled(probe);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

// Connected. The title becomes a statement rather than an instruction, and the
// footnote answers the question the reader has NOW — not "can I change this"
// but "where would I". That is also where the re-entry question gets answered,
// at the moment someone would wonder about it.
//
// What the copy must not do is promise more than the probe checked: it proved
// the CONNECTION, not that the work will succeed. A self-hosted box with
// nothing pulled answers the model list and then fails at the first tag.
function settled(running) {
  // Never `running.provider`. That is the internal name, and an installed
  // plugin's is its namespaced manifest id — "community.ollama" — a string no
  // reader of this screen has any business seeing.
  //
  // Two sources, because there are two ways to arrive and only one of them has
  // a roster to look in. Coming through Connect, the label is the one already
  // on the card: the feed was fetched BEFORE the install, so its roster has
  // never heard of the provider that is now answering and labelIn would fall
  // through to the name. Coming from the Setup row on an instance that was
  // already configured, nothing was picked and the roster is current, which is
  // exactly what labelIn is for.
  const who = picked?.label || (running?.provider ? labelIn(tagCap, running.provider) : null);
  const answering = who
    ? `${who}${running.model ? ` · ${running.model}` : ""} is answering.`
    : "This server can tag, describe and fill board fields.";

  // True of both arrivals: what is answering, and that there is nothing left to
  // skip — "Skip for now — uploads and boards work without it" under a
  // connected model reads as the page not having noticed.
  el("w-why").textContent = answering;
  document.querySelector(".w-foot").hidden = true;

  // WALKED IN, on an instance that is already configured — the Setup row's
  // reader (welcome-plan.md 3.0), not a first run. Everything below is about
  // finishing something they didn't start: there is no card, and "Make your
  // first board" is a claim about how new they are. The title stays the task
  // and the CHOOSER STAYS — a page reached from "Setup" that cannot change the
  // setup is the one thing that rung must not produce.
  if (!picked) return;

  el("w-title").textContent = "Model connected";
  el("w-fine").textContent = "Change it any time from Setup.";
  el("w-tiles").hidden = true;

  // A finished card IS its head: the field, the action row and the way back all
  // belonged to a decision that has been made. Said by keeping one child rather
  // than by removing three, which is the same edit and a shorter sentence.
  const card = el("w-picked");
  const head = card.querySelector(".w-picked-head");
  head.querySelector(".w-back").remove();
  const done = document.createElement("div");
  done.className = "w-running";
  done.textContent = "connected";
  head.appendChild(done);
  card.replaceChildren(head);
  card.classList.add("is-done");

  // Absent until now, not disabled: progressive disclosure with teeth. The step
  // did not exist a moment ago, and a greyed button would have claimed it did.
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Make your first board";
  btn.addEventListener("click", () =>
    openBoardModal(null, {
      canEditAI: true,
      onSaved: (saved) => { location.href = `/?board=${encodeURIComponent(saved.id)}`; },
    })
  );
  const note = document.createElement("span");
  note.className = "w-next-note";
  note.textContent = "A board is where your taxonomy lives.";
  const next = el("w-next");
  next.classList.add("w-rise");
  next.replaceChildren(btn, note);
  next.hidden = false;
}

// --- what else this server can do ---

// Everything AI this instance can do that is not the decision above. Derived,
// not listed: whatever CAPABILITY_DEFS holds, minus the backbone and minus
// whatever delegates to it (extraction is tagging wearing a different hat, and
// a row that always mirrors the row above it is noise).
//
// This REPLACED a live capability readout — every capability rendered through
// presentChip, flipping to active as the connection landed. It was cut because
// only two capabilities hang off the provider at all, so three of five rows
// never moved, and because a five-row status panel competes with the one
// decision the page exists for. The Capabilities tab already is that page.
function renderOthers(caps) {
  const rows = caps.filter((c) => c.kind === "ai" && c.id !== "tag" && !c.delegatesTo);
  if (!rows.length) return;

  const marks = el("w-disclose-marks");
  marks.replaceChildren(...rows.map((c) => glyphEl(c.icon, false)));

  const list = el("w-others");
  list.replaceChildren(...rows.map((c) => {
    const row = document.createElement("div");
    row.className = "w-other";
    const gl = glyphEl(c.icon, false);
    gl.classList.add("w-gl");
    const name = document.createElement("span");
    name.textContent = c.label;
    const state = document.createElement("span");
    state.className = "w-state";
    // presentChip, verbatim. The alternative is this page authoring a fourth
    // spelling of a state that already has one, which is exactly the drift
    // capability-present.js exists to prevent.
    state.textContent = presentChip(c).text;
    row.append(gl, name, state);
    return row;
  }));

  const btn = el("w-disclose");
  // The caret is filled here rather than in the HTML for the reason every glyph
  // in this app is: one set, one place (utils.js ICONS), and a page that types
  // its own ▾ is a page that has quietly left it.
  btn.querySelector(".w-caret").innerHTML = ICONS.chevron;
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    list.hidden = open;
    // One home at a time: open, the marks live in the rows, so the header's
    // copy of them goes away rather than showing the same three glyphs twice.
    marks.hidden = !open;
  });
}

// --- the way out ---

// The consequence sits HERE and nowhere else on the page. This is the one spot
// where "what happens without a model" is information the reader needs, because
// it is the choice being made.
el("w-skip").addEventListener("click", async () => {
  // Best effort: the flag stops a redirect, and failing to store it must not
  // strand someone on a screen they asked to leave.
  await api("POST", "/api/admin/welcome/skip").catch(() => {});
  location.replace("/boards");
});
