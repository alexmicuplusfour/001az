// The New board chooser (planning/templates-plan.md D17, C3), the first step
// of every New board. A board's type, Files or a kind of live data a
// connector serves, is picked here once: the board modal that follows shows
// it, and nothing changes it after (D10, D15).
//
// One card per type: Files first, then every type /api/connectors lists,
// built in or added by a plugin. A type this server can't feed says what's
// missing and where to fix it, and can't be picked (D11), because its board
// would be made and then fail on its first add.
//
// The last card, Start from a template, goes to the templates page
// (templates.js), whose Start blank opens this chooser in turn; there the card
// is left out, since it would only reload the page you're on.
//
// Every New board opens this: the gallery's boards dropdown (through the modal
// door), the boards page's button and empty-grid card, the admin Boards tab,
// and the templates page's Start blank. Each hands in its own onSaved, and it
// rides through to the board modal untouched: the dropdown and the templates
// page go to the new board, the other two stay and redraw.
import { api } from "./api.js";
import { createModal } from "./modal.js";
import { openBoardModal } from "./board-modal.js";
import { connectorFace } from "./mapping-modal.js";
import { glyphEl, sentence } from "./utils.js";

// Admin → Plugins, where a type's provider or plugin is added.
const FIX_IN_PLUGINS = { href: "/admin#plugins", label: "Fix in Admin → Plugins" };

// Why a board of this type can't be made on this server, or null when it can,
// with where that gets fixed when it can be. The reason is the capabilities
// ladder's own words (admins get it, and only admins get here). The built-in
// types always give a starting mapping; a plugin's may not, and then there's
// nothing to start a board from, and nothing on this server can give it one.
// The templates page asks it about a template's type too.
export function blockedBy(row) {
  if (row.available === false) return { why: sentence(row.reason) || `${row.label} isn't available on this server`, fix: FIX_IN_PLUGINS };
  if (!row.template) return { why: `The ${row.label} plugin doesn't set up new boards`, fix: null };
  return null;
}

// A type this server doesn't have at all, which a board template can name:
// the plugin that adds it isn't installed.
export const missingType = (name) => ({ why: `Needs the ${sentence(name)} plugin`, fix: FIX_IN_PLUGINS });

// What a blocked pick says, in the amber box: each reason, with a link to
// where it gets fixed when there is one. `onFix` runs as a link is followed:
// the chooser closes itself, since on the admin page the link switches tabs
// under it.
export function blockedNote(reasons, onFix = null) {
  const box = document.createElement("div");
  box.className = "warn-box flush";
  for (const r of reasons) {
    const line = document.createElement("div");
    line.append(`${r.why}.`);
    if (r.fix) {
      const a = document.createElement("a");
      a.href = r.fix.href;
      a.textContent = r.fix.label;
      if (onFix) a.addEventListener("click", onFix);
      line.append(" ", a);
    }
    box.appendChild(line);
  }
  return box;
}

// A type's starting mapping with its face as the Mapping tab would show it,
// so the board gets that face even if the tab is never opened. A board
// template of the type starts from it too.
export const startingMapping = (row) => ({ ...row.template, face: connectorFace(row.template.face, row.faces) });

// One chooser at a time. A second click on New board while the first is still
// fetching the types lands here too, and opening again would either stack two
// choosers or throw the first away without its close, which is what gives the
// page its scroll back. True from the click until the chooser is gone.
let pending = false;

export async function openNewBoard({ onSaved, templatesCard = true } = {}) {
  if (pending) return;
  pending = true;
  // The list first, so the chooser opens whole instead of growing cards under
  // the reader. If it doesn't load, Files still can be picked: it needs
  // nothing from it.
  let rows = null;
  try {
    const list = await api("GET", "/api/connectors");
    if (Array.isArray(list)) rows = list;
  } catch { /* said under the cards */ }

  let picked = false;
  let seed = null; // the picked type's starting point; null = Files
  const { overlay, body, footer, close } = createModal({
    id: "new-board-modal",
    title: "New board",
    // One after the other, never one on top of the other (D17): the board
    // modal opens once this one has finished fading out. The scroll lock is
    // counted and both happen in this one task, so the page doesn't move in
    // between.
    onClose: () => {
      pending = false;
      if (picked) openBoardModal(null, { canEditAI: true, seed, onSaved });
    },
  });
  footer.remove(); // picking a card is the action; × and Esc are the way out

  const lead = document.createElement("p");
  lead.className = "nb-lead";
  lead.textContent = "Pick the board's type. It can't be changed once the board is made.";
  const grid = document.createElement("div");
  grid.className = "nb-types";
  body.append(lead, grid);

  // A pickable type is a button. A blocked one is a card that isn't: its
  // reason, and a link to where it gets fixed if it can be, are what it has
  // to offer. The templates card is a link to another page.
  const card = ({ glyph, name, line, blocked, start, href }) => {
    const el = document.createElement(href ? "a" : blocked ? "div" : "button");
    el.className = blocked ? "nb-type blocked" : "nb-type";
    const nameEl = document.createElement("span");
    nameEl.className = "nb-name";
    nameEl.textContent = name;
    const lineEl = document.createElement("span");
    lineEl.className = "nb-line";
    lineEl.textContent = line;
    el.append(glyphEl(glyph, false), nameEl, lineEl);
    if (href) {
      el.href = href;
    } else if (blocked) {
      el.appendChild(blockedNote([blocked], () => close()));
    } else {
      el.type = "button";
      el.addEventListener("click", () => {
        picked = true;
        seed = start;
        close();
        // A closing modal lets clicks through to the page while it fades
        // (modal.css .is-closing), and a double click's second click lands
        // in that fade: on the boards page, on a board card, which is a
        // link. This one keeps them until it's gone.
        overlay.style.pointerEvents = "auto";
      });
    }
    grid.appendChild(el);
  };

  card({ glyph: "srcFile", name: "Files", line: "Cards from the files you add", start: null });
  for (const row of rows || []) {
    card({
      glyph: "srcGlobe",
      name: row.label,
      line: row.description || `Live data from ${row.label}`,
      blocked: blockedBy(row),
      start: { mapping: row.template && startingMapping(row) },
    });
  }
  // The same size as the types, not a text link: templates are the answer to
  // an empty first board (D17).
  if (templatesCard) {
    card({ glyph: "grid", name: "Start from a template", line: "A taxonomy someone already wrote, filled in for you", href: "/templates" });
  }
  if (!rows) {
    const note = document.createElement("p");
    note.className = "nb-note";
    note.textContent = "Couldn't load the other board types. Close this and try again.";
    body.appendChild(note);
  }

  grid.querySelector("button")?.focus();
}
