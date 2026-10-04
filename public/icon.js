// An ICONS glyph drawn as the <svg> it describes (planning/ui-updates-plan.md,
// D6). The glyphs are markup strings (utils.js glyph()), and a template can't
// set a string beside other children without wrapping it in an element of its
// own, which would change the markup every stylesheet already targets. So htm
// reads the string as a template: the <svg> lands exactly where innerHTML put
// it, beside a label or a dot.
//
// One strings array per string, kept here: htm caches what it has parsed by
// that array, so a fresh array on every draw would grow its cache without end.
// Which is also why only a fixed set of strings comes through here, never one
// built from what a person typed.
import { html } from "./vendor/preact.mjs";

const parsed = new Map();

// Any such string of the app's own markup, drawn the same way: the lightbox
// panel's section headings, from modal.js's sectionHeading(), which the
// hand-built modals set as HTML (planning/lightbox-panel-plan.md, D5).
export function Markup({ markup }) {
  let statics = parsed.get(markup);
  if (!statics) parsed.set(markup, (statics = [markup]));
  return html(statics);
}

export const Icon = ({ svg }) => Markup({ markup: svg });
