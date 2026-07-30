// The browse-style paged list shared by drill-in modals (connector browse,
// the ingest preview): a scroll region holding a table, a status note, and a
// Load more button that starts hidden until a page reports more. Only the
// chrome lives here — head rows, cell rendering, page loading and note
// visibility stay with the caller.

// --- agnostic cell formatting, keyed by a column's declared display kind ---
// Shared by both consumers so the same value never renders two ways.
export function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}
export function fmtNumber(v) {
  return v == null || !Number.isFinite(v) ? "—" : v.toLocaleString();
}
export function fmtPercent(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
// Numeric kinds sit flush right so magnitudes line up down a column. Shared
// like the formatters: a kind that right-aligns in one consumer right-aligns
// in all of them — headers included (.cb-end goes on the th and the td).
export const ALIGN_END = new Set(["usd", "percent", "number"]);
export function pagedTableScaffold() {
  const scroll = document.createElement("div");
  scroll.className = "cb-scroll";
  const table = document.createElement("table");
  table.className = "cb-table";
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);
  const note = document.createElement("div");
  note.className = "cb-note";
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "cb-more";
  moreBtn.textContent = "Load more";
  moreBtn.style.display = "none";
  scroll.append(table, note, moreBtn);
  return { scroll, thead, tbody, note, moreBtn };
}
