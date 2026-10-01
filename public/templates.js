// The board templates (planning/templates-plan.md D8, D17, C3–C5): the ones
// this server ships in templates/, loaded and checked when it starts
// (server/templates.js), drawn as the boards page's grid of cards, and one
// template's details at /templates?template=<slug>. Use this template opens
// the board modal filled from it; Start blank opens the New board chooser.
// Admins only (D14), like New board itself.
//
// One page, two views, picked by its address. A card is a plain link to its
// details, so the back button and a middle click work with no history code,
// and the details can be linked to from anywhere (D8).
//
// Relative specifiers, for the reason boards.js spells out.
import { api } from "./api.js";
import { pageToolbar } from "./user-menu.js";
import { ICONS, sentence } from "./utils.js";
import { clipBar, sectionHeadingEl } from "./modal.js";
import { presentChip } from "./capability-present.js";
import { openBoardModal } from "./board-modal.js";
import { openNewBoard, blockedBy, blockedNote, missingType, startingMapping } from "./new-board.js";
import { fileFace, formatWord } from "./mapping-modal.js";
import { newBoardCard, typeChip, fieldsChip, facetsChip } from "./board-grid.js";
import { toast } from "./toast.js";

// Back to this same address after signing in: a link to one template is what
// the page having an address is for, so it has to survive a sign-in.
const LOGIN = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);

const me = await fetch("/api/me", { cache: "no-store" })
  .then((r) => r.json())
  .catch(() => null);

if (!me) {
  location.replace(LOGIN);
} else if (me.needs_password) {
  location.replace("/login.html");
} else if (!me.is_admin) {
  // Only admins make boards, so a template is nothing anyone else can use
  // (D14), and the list it's drawn from is an admin route.
  location.replace("/boards");
} else {
  document.getElementById("gate").hidden = true;
  document.querySelector("header").hidden = false;
  pageToolbar({ me, afterSignOut: () => location.replace(LOGIN), home: "/boards" });
  load();
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// A board made here is what you came for, so a save goes to it, as the
// gallery's own New board does (C5).
const toNewBoard = (saved) => { location.href = `/?board=${encodeURIComponent(saved.id)}&created=1`; };

// Where a model gets connected: the welcome screen, which draws its chooser
// whenever tagging isn't running. The boards page's setup strip goes there too.
const FIX_IN_SETUP = { href: "/welcome", label: "Fix in Setup" };

// Everything the page reads, at once: the templates, this server's board
// types (whether each can serve, and the mapping it starts from), and whether
// anything runs tagging and extraction (C4). A capability read that fails
// blocks nothing: a page that can't ask says nothing rather than guessing.
async function load() {
  const [list, rows, tag, extract] = await Promise.all([
    api("GET", "/api/admin/templates").catch((err) => err),
    api("GET", "/api/connectors").catch(() => null),
    api("GET", "/api/admin/capabilities/tag").catch(() => null),
    api("GET", "/api/admin/capabilities/extract").catch(() => null),
  ]);
  if (!Array.isArray(list)) {
    // Inline, not a toast: on an otherwise blank page the failure IS the
    // content. Start blank needs no template, so it stays.
    const grid = document.getElementById("templates-grid");
    grid.replaceChildren(newBoardCard("Start blank", startBlank), el("p", "boards-note", `Couldn't load the templates: ${list?.message || "no answer"}`));
    grid.hidden = false;
    return;
  }
  const server = { rows: Array.isArray(rows) ? rows : null, tag, extract };
  const slug = new URLSearchParams(location.search).get("template");
  if (slug) {
    const t = list.find((x) => x.slug === slug);
    if (t) return drawDetails(t, server);
    // A link to a template this server doesn't have, or one it left out
    // because it failed its check: the grid instead, and why. The address
    // goes back to the grid's, so a reload doesn't say it again.
    toast.info("That template isn't on this server.");
    history.replaceState(null, "", location.pathname);
  }
  drawGrid(list, server);
}

// What stops a template being used on this server (C4), each reason with
// where it gets fixed. Its type first: one this server doesn't have at all
// needs its plugin, and one it has must be able to serve and give a starting
// mapping, the chooser's own rule. Then the models: tagging when it has
// facets, extraction when it has fields, and only when nothing would run them
// (the entry's `running`). Not presentTrouble, which also speaks for a
// fallback that runs and for a provider whose last call failed, and would
// block a template that works. Extraction falls back to the tagger, so when
// it has nothing running, tagging has nothing either: one line, one fix.
function blockers(t, { rows, tag, extract }) {
  const out = [];
  if (t.boardType) {
    const row = typeRow(t, rows);
    const type = !rows ? { why: "Couldn't load this server's board types", fix: null }
      : !row ? missingType(t.boardType)
      : blockedBy(row);
    if (type) out.push(type);
  }
  const idle = [t.guidance?.facets.length && tag, t.fields?.length && extract].filter((c) => c && !c.running);
  if (idle.length) {
    const who = idle.map((c, i) => (i ? c.label.toLowerCase() : c.label)).join(" and ");
    out.push({ why: `${who} — ${presentChip(idle[0]).text}`, fix: FIX_IN_SETUP });
  }
  return out;
}

// The board modal's starting point for a template (C5): its name, its
// guidance, and the mapping the Mapping pane would save for it. A type's
// starting mapping with the template's fields after its own. A Files board's
// fields, with a card key and the face the pane gives one (fileFace), so the
// board gets the face its Mapping tab shows; no fields at all is no mapping,
// as the pane's collect() makes it (Stage 3b close look, finding 2).
function seedFor(t, rows) {
  const fields = t.fields || [];
  let mapping = null;
  if (t.boardType) {
    const start = startingMapping(typeRow(t, rows));
    mapping = { ...start, fields: [...start.fields, ...fields] };
  } else if (fields.length) {
    mapping = t.cardKey ? { card: { by: t.cardKey }, face: fileFace(null), fields } : { fields };
  }
  return { name: t.name, context: t.guidance?.context || "", facets: t.guidance?.facets || [], mapping };
}

function use(t, server) {
  openBoardModal(null, { canEditAI: true, seed: seedFor(t, server.rows), onSaved: toNewBoard });
}

// Start blank: the chooser, minus its own Start from a template card, which
// would only bring you back here.
const startBlank = () => openNewBoard({ onSaved: toNewBoard, templatesCard: false });

const typeName = (t) => (t.boardType ? sentence(t.boardType) : "Files");
const typeRow = (t, rows) => rows?.find((r) => r.name === t.boardType);
const shotSrc = (t, s) => `/template-shots/${encodeURIComponent(t.slug)}/${encodeURIComponent(s.file)}`;

// ── The grid ────────────────────────────────────────────────────────────────

function drawGrid(list, server) {
  const grid = document.getElementById("templates-grid");
  // Blank first, the way pickers put it beside their templates.
  grid.replaceChildren(newBoardCard("Start blank", startBlank), ...list.map((t) => templateCard(t, blockers(t, server))));
  grid.hidden = false;
}

// A template as a board card (boards.css): its cover, or the grey face a card
// with no picture gets; its name and its line; the board grid's chips for
// what it sets up, its type always, Files too, since that's picked here once
// and never changes (a board's card names only a live-data type); and what
// stops it being used here. The reasons go without their links, since the
// card is itself a link: the details have the fixes, and opening them needs
// nothing (C4).
function templateCard(t, blocked) {
  const card = el("a", "board-card");
  card.href = `/templates?template=${encodeURIComponent(t.slug)}`;

  const face = el("div", "bc-face tp-face");
  const cover = t.screenshots[0];
  if (cover) {
    const img = el("img");
    img.src = shotSrc(t, cover);
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    // One that doesn't load leaves the grey face a template without one has.
    img.addEventListener("error", () => img.remove());
    face.appendChild(img);
  }

  const name = el("div", "bc-name", t.name);
  name.title = t.name; // the name ellipsizes; hover gives the full one back
  const chips = el("div", "bc-chips");
  chips.appendChild(typeChip(t.boardType));
  if (t.fields?.length) chips.appendChild(fieldsChip());
  const n = t.guidance?.facets.length || 0;
  if (n) chips.appendChild(facetsChip(n));
  const meta = el("div", "bc-meta");
  meta.appendChild(chips);
  const body = el("div", "bc-body");
  body.append(name, el("p", "tp-line", t.description), meta);
  if (blocked.length) body.appendChild(blockedNote(blocked.map(({ why }) => ({ why }))));

  card.append(face, body);
  const wrap = el("div", "bc-wrap");
  wrap.appendChild(card);
  return wrap;
}

// ── The details ─────────────────────────────────────────────────────────────

function drawDetails(t, server) {
  document.title = `001az - ${t.name}`;
  const blocked = blockers(t, server);

  const back = el("a", "tp-back");
  back.href = "/templates";
  back.innerHTML = ICONS.arrowLeft;
  back.append("All templates");

  const sub = el("div", "tp-sub");
  // The board editor's own type chip: what the board it makes will say.
  const type = el("span", "mapping-chip", typeName(t));
  type.title = "Board type";
  sub.appendChild(type);
  if (t.author) sub.appendChild(el("span", "", `by ${t.author}`));

  // Use this template, or what stops it and where that's fixed: in the head,
  // so it's there on arrival however long the taxonomy below it runs.
  const act = el("div", "tp-actions");
  if (blocked.length) {
    act.appendChild(blockedNote(blocked));
  } else {
    const btn = el("button", "", "Use this template");
    btn.type = "button";
    btn.addEventListener("click", () => use(t, server));
    act.appendChild(btn);
  }

  const head = el("div", "tp-head");
  head.append(el("h1", "", t.name), sub, el("p", "tp-lead", t.description), act);

  const page = document.getElementById("template-details");
  page.replaceChildren(
    back, head,
    ...t.screenshots.map((s) => shot(t, s)),
    ...(t.guidance ? [guidanceSection(t.guidance)] : []),
    ...(t.fields ? [fieldsSection(t)] : []),
  );
  page.hidden = false;
}

function shot(t, s) {
  const fig = el("figure", "tp-shot");
  const img = el("img");
  img.src = shotSrc(t, s);
  img.alt = s.caption || "";
  fig.appendChild(img);
  if (s.caption) fig.appendChild(el("figcaption", "", s.caption));
  return fig;
}

// Each section as a board made from the template holds it (the list comes
// back from the template check that way), with a Copy that writes exactly
// what the board editor's own Copy would, for pasting into a board that
// exists already (D12).
function section(title, place, text) {
  const sec = el("section", "tp-section");
  const head = el("div", "section-head-row");
  head.append(sectionHeadingEl(title), clipBar({ place, copy: () => text }));
  sec.appendChild(head);
  return sec;
}

function guidanceSection(g) {
  const sec = section("Tagging guidance", "template-guidance", JSON.stringify(g, null, 2));
  if (g.context) sec.appendChild(el("p", "tp-context", g.context));
  for (const f of g.facets) {
    const row = el("div", "tp-item");
    const head = el("div", "tp-item-head");
    head.append(el("span", "tp-label", f.label), el("span", "tp-key", f.key),
      el("span", "tp-note", f.single ? "one value" : "any of the values"));
    row.appendChild(head);
    if (f.description) row.appendChild(el("p", "tp-text", f.description));
    const values = el("div", "pills tp-values");
    for (const v of f.values) values.appendChild(el("span", "pill", v));
    row.appendChild(values);
    sec.appendChild(row);
  }
  return sec;
}

function fieldsSection(t) {
  const sec = section("AI-extracted fields", "template-fields", JSON.stringify(t.fields, null, 2));
  if (t.cardKey) {
    sec.appendChild(el("p", "tp-context", `One card per ${t.cardKey}: the files that share a ${t.cardKey} are one card.`));
  }
  for (const f of t.fields) {
    const row = el("div", "tp-item");
    const head = el("div", "tp-item-head");
    head.append(el("span", "tp-key", f.key), el("span", "tp-note", formatWord(f)));
    if (f.key === t.cardKey) head.appendChild(el("span", "tp-note", "card key"));
    row.appendChild(head);
    if (f.instruction) row.appendChild(el("p", "tp-text", f.instruction));
    if (f.options) {
      const values = el("div", "pills tp-values");
      for (const o of f.options) {
        const pill = el("span", "pill", o.value);
        if (o.hint) pill.title = o.hint;
        values.appendChild(pill);
      }
      row.appendChild(values);
    }
    sec.appendChild(row);
  }
  return sec;
}
