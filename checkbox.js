// checkbox.js — custom checkbox with light/dark surface variants.
//
// Returns a handle: { el, input, checked, indeterminate, disabled, addEventListener }.
// `el` is the root <label> (box only, or box + optional text). The native
// <input type="checkbox"> stays visually hidden but drives state, focus rings,
// and form semantics. Indeterminate is supported for partial-selection UIs.

const CHECK_SVG =
  '<svg class="cb-icon cb-check" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M3 8.5 6.5 12 13.5 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

const DASH_SVG =
  '<svg class="cb-icon cb-dash" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M3.5 8h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
  '</svg>';

function syncIndeterminate(input, value) {
  input.indeterminate = value;
}

export function createCheckbox({
  checked = false,
  indeterminate = false,
  disabled = false,
  variant = "dark", // "dark" | "light"
  label = "",
  name,
  value,
  id,
  onChange,
} = {}) {
  const root = document.createElement("label");
  root.className = `cb cb--${variant}` + (disabled ? " is-disabled" : "");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "cb-input";
  input.checked = checked;
  if (name != null) input.name = name;
  if (value != null) input.value = value;
  if (id != null) {
    input.id = id;
    root.htmlFor = id;
  }
  input.disabled = disabled;
  syncIndeterminate(input, indeterminate);

  const box = document.createElement("span");
  box.className = "cb-box";
  box.innerHTML = CHECK_SVG + DASH_SVG;

  root.append(input, box);
  if (label) {
    const text = document.createElement("span");
    text.className = "cb-text";
    text.textContent = label;
    root.appendChild(text);
  }

  if (onChange) input.addEventListener("change", onChange);

  const handle = {
    el: root,
    input,
    get checked() {
      return input.checked;
    },
    set checked(v) {
      input.checked = v;
      if (v) syncIndeterminate(input, false);
    },
    get indeterminate() {
      return input.indeterminate;
    },
    set indeterminate(v) {
      syncIndeterminate(input, v);
    },
    get disabled() {
      return input.disabled;
    },
    set disabled(v) {
      input.disabled = v;
      root.classList.toggle("is-disabled", v);
    },
    addEventListener: (...args) => input.addEventListener(...args),
    removeEventListener: (...args) => input.removeEventListener(...args),
  };

  return handle;
}
