// The boards grid's shared pieces (boards.css): a card's chips, and its face.
// Two pages draw the grid, the boards page and the templates page
// (planning/templates-plan.md, Stage 3b close look, finding 6), and boards.js
// is a page that runs as it loads, so what they share lives here.
import { ICONS, sentence } from "./utils.js";

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

// ── The face ────────────────────────────────────────────────────────────────

const MAX_TILES = 4;

// A card's face: up to MAX_TILES previews piled on the card's gradient, the
// first on top, fanning out while the card is hovered (boards.css .bc-stack).
// A board's are its newest items, a template's its screenshots. `tiles` are
// what can be drawn, in order: `{ src }` an image, or `{ symbol, title }` a
// live-data entry's symbol tile. Those past the first MAX_TILES are the spare
// pool a tile that fails to load draws from, and a face with nothing to show
// gets the dashed placeholder, from the start or once its pile runs out.
export function cardFace(tiles) {
  const face = document.createElement("div");
  face.className = "bc-face";
  const spares = [...tiles];
  if (!spares.length) {
    face.classList.add("empty");
    return face;
  }
  const stack = document.createElement("div");
  stack.className = "bc-stack";
  for (let slot = 0; slot < MAX_TILES && spares.length; slot++) {
    stack.appendChild(tileFor(spares.shift(), slot, spares, face));
  }
  face.appendChild(stack);
  return face;
}

function tileFor(entry, slot, spares, face) {
  if (entry.symbol) {
    const el = document.createElement("div");
    el.className = `bc-thumb sym slot-${slot}`;
    el.title = entry.title || entry.symbol;
    const label = document.createElement("span");
    label.textContent = entry.symbol;
    el.appendChild(label);
    return el;
  }
  const img = document.createElement("img");
  img.className = `bc-thumb slot-${slot}`;
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = ""; // decorative: the card's own words carry the meaning
  // Images are natively draggable too, and the tile is decoration — grabbing
  // one must not start an image drag over a card whose own drag is the grip's.
  img.draggable = false;
  img.src = entry.src;
  // A preview can go missing (pruned file, lost render). Take over the slot
  // with the next spare so the pile keeps its shape; if the pile empties
  // entirely, fall back to the placeholder.
  img.addEventListener("error", () => {
    const next = spares.shift();
    if (next) img.replaceWith(tileFor(next, slot, spares, face));
    else {
      const stack = img.parentElement;
      img.remove();
      if (stack && !stack.children.length) {
        stack.remove();
        face.classList.add("empty");
      }
    }
  });
  return img;
}
