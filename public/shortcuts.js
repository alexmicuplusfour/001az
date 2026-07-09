import { state } from './state.js';
import { clearBulk, selectAllVisible } from './bulk.js';
import { visibleGridItems } from './grid.js';

function typingInField() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

function gridShortcutsBlocked() {
  if (!document.getElementById("lightbox").hidden) return true;
  if (document.querySelector(".te-overlay")) return true;
  if (typingInField()) return true;
  return false;
}

function inSelectionMode() {
  return state.me && state.bulkSelected.size > 0;
}

function handleSelectionShortcuts(e) {
  if (!inSelectionMode() || gridShortcutsBlocked()) return false;

  if (e.key === "Escape") {
    // An open dropdown consumes Escape before this handler sees it (dropdown.js).
    clearBulk();
    return true;
  }

  if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    selectAllVisible(visibleGridItems());
    return true;
  }

  return false;
}

const handlers = [handleSelectionShortcuts];

function onKeydown(e) {
  for (const handler of handlers) {
    if (handler(e)) return;
  }
}

export function initShortcuts() {
  document.addEventListener("keydown", onKeydown);
}
