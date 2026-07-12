// A small rolling counter. Renders a number-ish string (digits, thousands
// commas, a trailing "k") as a row of cells; when the value changes, each
// changed digit rolls up to its new glyph — an odometer tick. Non-digit
// characters render static. Used for the live per-board token chip.
//
// The element persists across toolbar re-renders (the toolbar rebuilds every
// poll), so it holds the previous value and can animate old -> new. Calling
// set() with an unchanged string is a no-op, so cosmetic re-renders don't flip.

const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const isDigit = (ch) => ch >= "0" && ch <= "9";

export class Odometer {
  constructor(initial = "") {
    this.el = document.createElement("span");
    this.el.className = "odo";
    this.chars = [];
    this.cells = []; // { node, char, isDigit } per index
    this.build(initial);
  }

  // Lay the string out from scratch. Used on first paint and whenever the
  // shape changes (a digit is gained/lost, e.g. 999k -> 1,001k) — those don't
  // roll, they just re-render.
  build(str) {
    this.chars = [...str];
    this.cells = this.chars.map((ch) => {
      const digit = isDigit(ch);
      const node = document.createElement("span");
      node.className = digit ? "odo-col" : "odo-sep";
      if (digit) node.appendChild(this.restRoll(ch));
      else node.textContent = ch;
      return { node, char: ch, isDigit: digit };
    });
    this.el.replaceChildren(...this.cells.map((c) => c.node));
  }

  set(str) {
    const next = [...str];
    const sameShape =
      next.length === this.chars.length &&
      next.every((c, i) => isDigit(c) === isDigit(this.chars[i]));
    if (!sameShape) return this.build(str);

    for (let i = 0; i < next.length; i++) {
      const cell = this.cells[i];
      if (cell.char === next[i]) continue;
      if (cell.isDigit) this.roll(cell, next[i]);
      else cell.node.textContent = next[i];
      cell.char = next[i];
    }
    this.chars = next;
  }

  // A ribbon showing a single digit at rest (translateY 0).
  restRoll(digit) {
    const roll = document.createElement("span");
    roll.className = "odo-roll";
    const s = document.createElement("span");
    s.textContent = digit;
    roll.appendChild(s);
    return roll;
  }

  // Roll one digit column: stack old-over-new, then slide up one row so the old
  // glyph exits the top and the new one rises into view. Collapse back to a
  // rest ribbon afterwards so the next roll starts clean.
  roll(cell, digit) {
    if (reduceMotion?.matches) {
      cell.node.replaceChildren(this.restRoll(digit));
      return;
    }
    const roll = document.createElement("span");
    roll.className = "odo-roll";
    const oldSpan = document.createElement("span");
    oldSpan.textContent = cell.char;
    const newSpan = document.createElement("span");
    newSpan.textContent = digit;
    roll.append(oldSpan, newSpan);
    cell.node.replaceChildren(roll);
    roll.addEventListener(
      "transitionend",
      () => cell.node.replaceChildren(this.restRoll(digit)),
      { once: true }
    );

    // renderToolbar builds its whole subtree detached and only attaches it at
    // the end, so we can't reflow now — offsetHeight is 0 while disconnected and
    // the transition would be skipped. Wait a frame: by then the toolbar is live
    // in the DOM, the reflow pins the ribbon at translateY(0), and adding
    // .rolling animates it up to the new glyph.
    requestAnimationFrame(() => {
      void roll.offsetHeight;
      roll.classList.add("rolling");
    });
  }
}
