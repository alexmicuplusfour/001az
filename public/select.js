// select.js — the shared <select> filler, which exists for one capability the
// element itself does not have: a select can be EMPTY.
//
// HTML gives a <select> no empty state. Hand it options and no selection and
// the browser picks the first one, so a picker nobody has answered renders
// exactly like one somebody has. On a settings form that is not a cosmetic
// difference — it is a claim. The plugin modal's slot sections showed a key and
// a model for a slot the provider did not hold, and the panel read as "this is
// already the default tagger", with a disabled button as the only thing quietly
// disagreeing.
//
// So "nothing chosen" gets rendered rather than left to the browser: a leading
// option that names what to pick, carrying `data-placeholder` so modal.css can
// dim it and `isUnset` can recognise it. The marker, not the empty value, is
// what identifies it — "" is a legitimate choice elsewhere (the board editor's
// "App default" / "Same as the tagger" rows).
//
// A placeholder only ever replaces the browser's arbitrary first-option pick,
// never a real saved value: pass `value` and, when the list still carries it,
// that wins and no placeholder is rendered at all.

// Options from `items` ({ value, label }), `value` selected if present.
export function fillSelect(sel, items, { value = null, placeholder = null } = {}) {
  sel.replaceChildren();
  let matched = false;
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it.value;
    opt.textContent = it.label;
    if (!matched && value != null && it.value === value) {
      opt.selected = true;
      matched = true;
    }
    sel.appendChild(opt);
  }
  if (!matched && placeholder) sel.insertBefore(placeholderOption(placeholder), sel.firstChild);
}

// `disabled` is what makes this an empty state rather than an option: it can be
// the selection you start with, and never one you can come back to.
function placeholderOption(text) {
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = text;
  opt.disabled = true;
  opt.selected = true;
  opt.dataset.placeholder = "";
  return opt;
}

// Has this picker been answered? Ask before reading `.value` — an unanswered
// one reads "", which arithmetic downstream will happily turn into key id 0.
export const isUnset = (sel) => sel.selectedOptions[0]?.dataset.placeholder != null;
