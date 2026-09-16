// The switch control — a button that carries its own on/off state, and the
// labelled row that wraps one. Extracted from board-modal.js, where it had
// grown five importers outside that file (alerts-modal, ingest-modal,
// mapping-modal, plugin-modal, source-chooser): a control reachable only
// through a modal keeps that modal in every one of their graphs. Same shape
// as checkbox.js and select.js — one control, one module.
//
// Styling for .switch / .switch-row lives in modal.css, which every page that
// uses this already loads.
//
// NOTE: checkbox.js also has a switch — createToggle, a real <input> wearing
// .cb--toggle, used by dropdown.js. Two implementations of one control, with
// different sizes and different variants, so merging them is a visual change
// across every call site here and deliberately not part of this extraction.
// Reusable toggle switch: a button that flips .on and reports the new state.
// opts.small for compact contexts (e.g. facet rows).
function makeSwitch(checked, onChange, opts = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "switch" + (opts.small ? " sm" : "") + (checked ? " on" : "");
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", String(!!checked));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const on = !btn.classList.contains("on");
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", String(on));
    if (onChange) onChange(on);
  });
  return btn;
}

// Labeled switch row — clicking anywhere on the row toggles. The row carries a
// `setSwitch(on)` for callers that need to move the knob from code (a mode
// change forcing the value, a mutual exclusion): it updates the visual state
// WITHOUT firing onChange, since the caller is already setting the model.
export function switchRow(label, hint, checked, onChange, opts = {}) {
  const row = document.createElement("div");
  row.className = "switch-row";
  const sw = makeSwitch(checked, onChange, opts);
  row.setSwitch = (on) => {
    sw.classList.toggle("on", on);
    sw.setAttribute("aria-checked", String(on));
  };
  const text = document.createElement("span");
  text.append(label);
  if (hint) {
    const h = document.createElement("span");
    h.style.cssText = "font-weight:400;color:#9aa0aa;";
    h.append(" " + hint);
    text.appendChild(h);
  }
  row.append(sw, text);
  row.addEventListener("click", (e) => { if (e.target === row || e.target === text) sw.click(); });
  return row;
}

