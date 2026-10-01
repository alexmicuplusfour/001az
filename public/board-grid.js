// The boards grid's shared pieces (boards.css): a card's count line and its
// chips, and the dashed card that starts a new board. Two pages draw the
// grid, the boards page and the templates page (planning/templates-plan.md,
// Stage 3b close look, finding 6), and boards.js is a page that runs as it
// loads, so what they share lives here.
import { ICONS, sentence } from "./utils.js";

// The empty board says it once, on the count line — the face's dashed
// placeholder carries the same message visually, so it stays wordless.
export const countLabel = (n) => (n === 0 ? "No items yet" : n === 1 ? "1 item" : `${n} items`);

// A chip on a card's meta row: an icon, a word where the icon needs one, and
// a title that spells it out.
export function cardChip(icon, text, title) {
  const el = document.createElement("span");
  el.className = "bc-chip";
  el.title = title;
  el.innerHTML = icon;
  if (text) {
    const label = document.createElement("span");
    label.textContent = text;
    el.appendChild(label);
  }
  return el;
}

// The chips for what a board is set up with, the same words on both grids: its
// type (a kind of live data, in the words the toolbar and the board editor
// use, or Files), its AI-extracted fields, and its taxonomy.
export const typeChip = (name) => (name
  ? cardChip(ICONS.srcGlobe, sentence(name), `Board type: ${sentence(name)}`)
  : cardChip(ICONS.srcFile, "Files", "Board type: Files"));
export const fieldsChip = () => cardChip(ICONS.srcSparkle, "", "AI-extracted fields");
export const facetsChip = (n) => cardChip(ICONS.tag, "", `Tagging — ${n} ${n === 1 ? "facet" : "facets"}`);

// The card that starts a board: the empty boards grid's New board, and the
// templates page's Start blank. A dashed outline where the board will appear,
// a plus with the words under it in the middle. Deliberately NOT dressed as a
// board card — it shipped for an hour wearing the real card's classes and
// read as an existing empty board, which is exactly what an empty board's own
// dashed face means. The outline sits on the button itself: the dashes ARE the
// affordance, not a note inside a card.
//
// Not a .bc-wrap either, and no data-board: the boards page's wraps() means
// "the boards on screen" and feeds the signals ticker's ready gate, the dots
// and the arrangement PATCH. A placeholder leaking into that set would arm a
// poll about nothing, and could save an arrangement containing undefined.
export function newBoardCard(words, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bc-new";

  // The size ghost: a real card's skeleton — face over body, in the card's
  // own classes, invisible — so this button is EXACTLY board-card-sized at
  // every width. The metrics come from the same rules the real cards read
  // (.bc-face's ratio, .bc-body's padding, the name and meta line heights),
  // so they cannot drift; a hand-copied height in the stylesheet could.
  const face = document.createElement("div");
  face.className = "bc-face";
  const name = document.createElement("div");
  name.className = "bc-name";
  name.textContent = words;
  const count = document.createElement("span");
  count.className = "bc-count";
  count.textContent = countLabel(0);
  const meta = document.createElement("div");
  meta.className = "bc-meta";
  meta.appendChild(count);
  const body = document.createElement("div");
  body.className = "bc-body";
  body.append(name, meta);
  const ghost = document.createElement("div");
  ghost.className = "bc-new-ghost";
  ghost.append(face, body);

  // What the reader sees, centered over the ghost.
  const plus = document.createElement("span");
  plus.className = "bc-new-plus";
  plus.innerHTML = ICONS.plus;
  const said = document.createElement("span");
  said.textContent = words;
  const label = document.createElement("span");
  label.className = "bc-new-label";
  label.append(plus, said);

  btn.append(ghost, label);
  btn.addEventListener("click", onClick);
  return btn;
}
