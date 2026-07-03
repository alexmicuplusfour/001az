import { state } from './state.js';

export function isAdmin() {
  return !!(state.me && state.me.is_admin);
}

export function toImage(d) {
  const list = Array.isArray(d.tags) ? d.tags : [];
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    tags: list,
    tagSet: new Set(list),
    undecided: !!d.undecided,
    hearts: d.hearts || 0,
    favoritedByMe: !!d.favoritedByMe,
    crateIds: new Set(Array.isArray(d.crateIds) ? d.crateIds : []),
    w: d.w || 0,
    h: d.h || 0,
  };
}

export const tag = (facet, value) => `${facet}/${value}`;
export const thumbUrl = (name) => `thumbnails/${encodeURIComponent(name)}.webp`;
export const fullUrl = (name) => `gallery/${encodeURIComponent(name)}`;

export const ICONS = {
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2 2 0 0 0 2.8 0l6.6-6.6a2 2 0 0 0 0-2.8z"/><circle cx="7" cy="7" r="1.3" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="var(--hf, none)" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.7 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  crate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

export function actionBtn(icon, cls, title, onClick) {
  const b = document.createElement("button");
  b.className = "act " + cls;
  b.title = title;
  b.innerHTML = ICONS[icon];
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

export function toolBtn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = "tool-btn" + (cls ? " " + cls : "");
  b.innerHTML = label;
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

export function onOutsideClick(pop, anchorEl, onDismiss) {
  const handler = (e) => {
    if (!pop.contains(e.target) && !anchorEl.contains(e.target)) onDismiss();
  };
  setTimeout(() => document.addEventListener("click", handler, true), 0);
  return handler;
}

export function positionPop(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const rect = pop.getBoundingClientRect();
  let left = r.right - rect.width;
  let top = r.bottom + 6;
  if (left < 8) left = 8;
  if (top + rect.height > window.innerHeight - 8) top = r.top - rect.height - 6;
  pop.style.left = left + "px";
  pop.style.top = Math.max(8, top) + "px";
}

export function pill(label, count, active, muted, onClick) {
  const b = document.createElement("button");
  b.className = "pill" + (active ? " active" : "") + (muted ? " muted" : "");
  b.textContent = label;
  if (count != null) {
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = count;
    b.appendChild(c);
  }
  b.addEventListener("click", onClick);
  return b;
}

