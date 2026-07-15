// The source-browse modal: navigate an ingestion source's directory tree
// (local folder, FTP, S3 prefixes) and pick a base folder for a board's feed.
// Source-agnostic — it renders whatever POST /ingest/source/browse returns
// ({ path, parent, entries:[{name,path,type,size,modified}] }); the server
// resolves the connection's credentials, so nothing secret is ever sent here.
// Sibling of connector-browse.js and the ingest preview, same table chrome.
import { createModal } from './modal.js';
import { pagedTableScaffold } from './paged-table.js';

const fmtBytes = (n) =>
  n == null ? "—"
  : n < 1024 ? `${n} B`
  : n < 1048576 ? `${(n / 1024).toFixed(0)} KB`
  : `${(n / 1048576).toFixed(1)} MB`;

export function openSourceBrowse({ boardId, source, start = "", onPick }) {
  const { body, footer, close } = createModal({
    title: "Browse source",
    id: "source-browse",
    bodyStyle: "display:flex;flex-direction:column;gap:10px;min-height:0;",
  });

  let current = start;

  const pathLine = document.createElement("div");
  pathLine.className = "cb-note";
  pathLine.style.cssText = "display:flex;align-items:center;gap:10px;margin:0;";
  body.appendChild(pathLine);

  const { scroll, thead, tbody, note, moreBtn } = pagedTableScaffold();
  moreBtn.style.display = "none"; // browse loads a whole level at once
  body.appendChild(scroll);
  {
    const tr = document.createElement("tr");
    for (const h of ["Name", "Size", "Modified"]) {
      const th = document.createElement("th");
      th.textContent = h;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  let seq = 0;
  async function load(path) {
    const my = ++seq;
    note.style.display = "";
    note.textContent = "Loading…";
    tbody.replaceChildren();
    try {
      const r = await fetch(`/api/boards/${boardId}/ingest/source/browse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, path }),
      });
      const data = await r.json().catch(() => ({}));
      if (my !== seq) return;
      if (!r.ok) { note.textContent = data.error || "Browse failed"; return; }
      current = data.path ?? path;
      renderPath(data.parent);
      const entries = data.entries || [];
      for (const e of entries) tbody.appendChild(row(e));
      if (!entries.length) { note.textContent = "Empty folder."; note.style.display = ""; }
      else if (data.truncated) { note.textContent = "Showing the first 1000 entries — narrow by typing a path."; note.style.display = ""; }
      else { note.style.display = "none"; }
    } catch {
      if (my === seq) note.textContent = "Browse failed";
    }
  }

  function renderPath(parent) {
    pathLine.replaceChildren();
    const label = document.createElement("span");
    label.style.fontFamily = "'SF Mono',Consolas,monospace";
    label.textContent = current ? `/${current}` : "/";
    pathLine.appendChild(label);
    if (parent !== null && parent !== undefined) {
      const up = document.createElement("button");
      up.type = "button";
      up.className = "ghost sm";
      up.textContent = "↑ Up";
      up.onclick = () => load(parent);
      pathLine.appendChild(up);
    }
  }

  function row(e) {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    if (e.type === "dir") {
      tr.classList.add("cb-selectable");
      const a = document.createElement("a");
      a.href = "#";
      a.textContent = "📁 " + e.name;
      a.onclick = (ev) => { ev.preventDefault(); load(e.path); };
      nameTd.appendChild(a);
    } else {
      nameTd.textContent = e.name;
    }
    const sizeTd = document.createElement("td");
    sizeTd.className = "cb-end";
    sizeTd.textContent = e.type === "dir" ? "—" : fmtBytes(e.size);
    const modTd = document.createElement("td");
    modTd.textContent = e.modified ? new Date(e.modified).toLocaleDateString() : "—";
    tr.append(nameTd, sizeTd, modTd);
    return tr;
  }

  const useBtn = document.createElement("button");
  useBtn.textContent = "Use this folder";
  useBtn.onclick = () => { onPick(current); close(); };
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.onclick = close;
  footer.append(useBtn, cancel);

  load(start);
}
