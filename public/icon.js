// An ICONS glyph drawn as the <svg> it describes (planning/ui-updates-plan.md,
// D6). The glyphs are markup strings (utils.js glyph()), and a template can't
// set a string beside other children without wrapping it in an element of its
// own, which would change the markup every stylesheet already targets. So htm
// reads the string as a template: the <svg> lands exactly where innerHTML put
// it, beside a label or a dot.
//
// One strings array per glyph, kept here: htm caches what it has parsed by that
// array, so a fresh array on every draw would grow its cache without end.
import { html } from "./vendor/preact.mjs";

const parsed = new Map();

export function Icon({ svg }) {
  let statics = parsed.get(svg);
  if (!statics) parsed.set(svg, (statics = [svg]));
  return html(statics);
}
