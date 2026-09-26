// Icon (public/icon.js) draws an ICONS string as the <svg> it describes by
// letting htm read the string as a template (planning/ui-updates-plan.md,
// Stage 2). Pinned for every glyph: one htm reads differently (an entity, a
// comment) would fail here instead of drawing a quietly wrong icon.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./jsdom-stub.js";

const { ICONS } = await import("../public/utils.js");
const { Icon } = await import("../public/icon.js");
const { html, render } = await import("../public/vendor/preact.mjs");

const SVG = "http://www.w3.org/2000/svg";

test("every glyph draws the <svg> its string describes, made of real SVG elements", () => {
  for (const [name, svg] of Object.entries(ICONS)) {
    const drawn = document.createElement("div");
    render(html`<${Icon} svg=${svg} />`, drawn);
    const parsed = document.createElement("div");
    parsed.innerHTML = svg;
    assert.equal(drawn.innerHTML, parsed.innerHTML, name);
    // Markup alone can't tell: a <path> made in the HTML namespace prints the
    // same and draws nothing.
    for (const el of drawn.querySelectorAll("*")) assert.equal(el.namespaceURI, SVG, `${name}: <${el.localName}>`);
  }
});

test("a glyph beside a label lands where innerHTML put it, with no wrapper", () => {
  const drawn = document.createElement("div");
  render(html`<button class="tool-btn fav"><${Icon} svg=${ICONS.heart} /><span>Your favorites</span></button>`, drawn);
  const parsed = document.createElement("div");
  parsed.innerHTML = `<button class="tool-btn fav">${ICONS.heart}<span>Your favorites</span></button>`;
  assert.equal(drawn.innerHTML, parsed.innerHTML);
});
