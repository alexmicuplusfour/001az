// The chip: a label, usually a count, dark when it's on. One definition for
// every surface that draws one (planning/ui-updates-plan.md, D6).
//
// `Pill` is the component, for surfaces Preact draws: the filter rail.
// `pill()` is the same chip for code that still builds its elements by hand
// (the job log's kind filter, the admin usage tab's window picker). It draws
// the component into a spare element and hands that element back, so there's
// one markup to keep right rather than two copies drifting apart.
import { html, render } from "./vendor/preact.mjs";

// The label rides its own element so it can be the ONE part that gives way:
// a value long enough to outrun the rail (the mobile drawer is the narrow
// case) ellipsises, while the count — the whole reason the chip carries a
// number — stays whole. The title is the only way back to the full string
// once the ellipsis eats it.
//
// The rest is the rail's: `neg` for an excluded value, `facet` and `value` as
// the address its right-click reads (filters.js wireExclusion), and the odds
// mark as children, after the count.
export function Pill({ label, count, active, muted, neg, title = label, facet, value, onClick, children }) {
  const cls = "pill" + (active ? " active" : "") + (muted ? " muted" : "") + (neg ? " neg" : "");
  return html`<button class=${cls} title=${title} data-facet=${facet} data-value=${value} onClick=${onClick}><span class="pill-label">${label}</span><${Count} n=${count} />${children}</button>`;
}

// The small trailing count, for a chip and for the one toolbar button with a
// trailing count (favorites): styles.css dresses `.pill .count` and
// `.tool-btn .count` as one. 0 is a count; none draws nothing.
export function Count({ n }) {
  return n != null ? html`<span class="count">${n}</span>` : null;
}

export function pill(label, count, active, muted, onClick) {
  const box = document.createElement("div");
  render(html`<${Pill} label=${label} count=${count} active=${active} muted=${muted} onClick=${onClick} />`, box);
  return box.firstChild;
}
