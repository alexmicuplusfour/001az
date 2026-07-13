// The browse-style paged list shared by drill-in modals (connector browse,
// the ingest preview — and whatever phase-2 adapters need next): a scroll
// region holding a table, a status note, and a Load more button that starts
// hidden until a page reports more. Only the chrome lives here — head rows,
// cell rendering, page loading and note visibility stay with the caller.
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
