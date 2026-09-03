// The source chooser: everything that defines WHERE a board ingests from —
// server, path, subfolders — picked in one drawer task and committed by ONE
// click. Successor to the stacked source-browse modal, same jurisdiction
// (navigate POST /ingest/source/browse, pick a base) rendered into the
// ingest modal's bottom drawer (modal.js createDrawer, the `tall` variant).
// Source-agnostic the same way the modal was: the server resolves connection
// credentials so nothing secret is ever here, and the manifest entry (label,
// sourceSchema, capability flags) supplies every word shown — the primary's
// noun, the switch's label, the fallback input's hint.
//
// Draft/commit follow the drawer's contract: all state is local until the
// primary fires onCommit; Cancel, scrim and Esc discard the whole draft.
import { drawerHeadParts, dwGroup } from './modal.js';
import { pagedTableScaffold } from './paged-table.js';
import { switchRow } from './board-modal.js';
import { fillSelect } from './select.js';
import { fmtSize } from './utils.js';

// Where a source keeps its base path on cfg.source: the local folder kept
// its historical `folder` key; every remote source uses `path`. The ONE
// spelling of that rule — the ingest modal's add/remove state, save guard
// and commit all read this export.
export const pathKeyFor = (type) => ((type || "folder") === "folder" ? "folder" : "path");

// The kind's mark: the local folder is a folder, S3 is a cloud, anything
// else remote (FTP today, an installed source plugin tomorrow) is a globe.
// If a plugin kind ever wants its own mark, a manifest `glyph` key is the
// extension point.
export const sourceGlyph = (type) =>
  type === "folder" ? "srcFolder" : type === "s3" ? "srcCloud" : "srcGlobe";

// Where a path lives, spelled from its source's root — "ingest-root/pixel",
// "mplex/camera" — never a bare "/" that names nothing. The trailing
// separator on the root itself reads as "inside here"; a missing base (a
// dangling connection) leaves the bare path rather than inventing a server.
// ONE spelling: the chooser's location line and the ingest modal's source
// tile both read it.
const stripSlashes = (p) => (p || "").replace(/\/+$/, "");

export const fmtLocation = (base, rel) => {
  const b = (base || "").replace(/[\\/]+$/, "");
  const r = stripSlashes(rel);
  if (!b) return r || "/";
  return r ? `${b}/${r}` : `${b}/`;
};

// Which root a source's paths resolve against: the chosen connection's label
// for connection-backed kinds (a dangling id resolves to "" — no invented
// server), the resolved INGEST_ROOT otherwise. One spelling, like
// fmtLocation: the chooser's location line and the ingest tile both read it.
export const sourceRootLabel = (source, connectionId, rootPath) =>
  source.needsConnection
    ? (source.connections?.find((c) => String(c.id) === String(connectionId))?.label || "")
    : (rootPath || "");


// opts: { drawer, boardId, source, rootPath, draft, onCommit }
//   drawer    the ingest modal's createDrawer instance — one task opens here
//   source    the manifest entry verbatim (type/label/browsable/
//             needsConnection/connections/sourceSchema)
//   rootPath  resolved INGEST_ROOT label; read only when !needsConnection
//   draft     { connectionId?, path?, recursive? } — absent keys = fresh add
//   onCommit  ({ connectionId?, path, recursive? }) => void — the one exit
//             that writes; fired only by the primary
export function openSourceChooser({ drawer, boardId, source, rootPath = "", draft = {}, onCommit }) {
  const s = source;
  const pathField = s.sourceSchema?.find((f) => f.key === pathKeyFor(s.type));
  const recField = s.sourceSchema?.find((f) => f.key === "recursive");
  const fieldWord = (pathField?.label || "Folder").toLowerCase();
  const head = drawerHeadParts(sourceGlyph(s.type), false, "source", s.label || "");

  // The connection is chosen HERE, with the path. Nothing is presumed:
  // only a saved id that still exists preselects (the edit flow); the add
  // flow — and a dangling saved id, whose server is gone — opens on the
  // "Select connection…" placeholder with nothing loaded, and the explicit
  // pick is what starts browsing. A pre-picked first server would be an
  // implied choice AND an unasked connect against a host that may hold a
  // 30s timeout.
  let activeConn = s.needsConnection && s.connections?.some((c) => String(c.id) === String(draft.connectionId))
    ? draft.connectionId
    : null;
  // The subfolders intent rides the same commit; the schema names it (S3
  // says "Include sub-prefixes") and supplies the default. A kind whose
  // schema has no recursive field has no switch and commits none.
  let rec = recField ? (draft.recursive ?? recField.default !== false) : undefined;

  const commit = (path) => {
    onCommit({
      ...(s.needsConnection ? { connectionId: activeConn } : {}),
      // S3 dir prefixes carry a trailing slash ("sub/") while folder/FTP
      // paths don't; normalize so the saved base reads the same across
      // sources. enumerate re-adds the slash.
      path: stripSlashes(path),
      ...(recField ? { recursive: rec } : {}),
    });
  };

  const recSwitch = (onFlip) =>
    switchRow(recField.label || "Include subfolders", null, rec, (on) => { rec = on; onFlip?.(); }, { small: true });

  const connSelect = (onChange) => {
    if (!(s.needsConnection && s.connections?.length)) return null;
    // .im-row, not .cb-note: modal selects `color: inherit`, and the note
    // class's grey would dim a REAL selection like a prompt. The label row
    // is the ingest modal's own vocabulary; the placeholder state dims
    // itself via select.js's data-placeholder marker.
    const row = document.createElement("div");
    row.className = "im-row";
    const lbl = document.createElement("label");
    lbl.textContent = "Connection";
    const sel = document.createElement("select");
    fillSelect(sel, s.connections.map((c) => ({ value: String(c.id), label: c.label })), {
      value: activeConn == null ? null : String(activeConn),
      placeholder: "Select connection…",
    });
    sel.addEventListener("change", () => {
      activeConn = Number(sel.value);
      onChange?.();
    });
    row.append(lbl, sel);
    return row;
  };

  // ── Non-browsable kind: a typed path instead of a tree ────────────────────
  // No installed kind hits this; it replaces the old fallback that skipped
  // the chooser entirely. The same choice, still made inside the chooser,
  // still one commit. Blank stays meaningful — "the whole source" — and the
  // Use click is the explicit act that picks it.
  if (!s.browsable) {
    let typed = draft.path || "";
    drawer.open({
      head: head.nodes,
      build: (body) => {
        // A pick arms the commit — same no-presumed-connection rule as the
        // tree arm, minus the browsing.
        const cr = connSelect(() => drawer.setPrimaryDisabled(false));
        if (cr) body.appendChild(cr);
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "blank = the whole source";
        input.value = typed;
        input.addEventListener("input", () => { typed = input.value; });
        body.appendChild(dwGroup(pathField?.label || "Folder", input, pathField?.help));
        if (recField) body.appendChild(recSwitch());
      },
      primary: {
        label: `Use this ${fieldWord}`,
        disabled: s.needsConnection && activeConn == null,
        onClick: () => {
          commit(typed);
          drawer.close();
        },
      },
    });
    return;
  }

  // ── The tree ──────────────────────────────────────────────────────────────
  let current = draft.path || "";
  let seq = 0;
  // "Use this folder" stays dead until a level renders — and ALSO while the
  // tree stands exactly where the board already points (same path, same
  // server, same subfolders): committing would change nothing, and a live
  // button reads as if there were something to apply. Any delta — navigating
  // away, switching server, flipping the switch — re-arms it. `savedAt`
  // exists only for the edit flow (the add flow has no baseline).
  const savedAt = "path" in draft
    ? {
        path: stripSlashes(draft.path),
        connectionId: draft.connectionId,
        recursive: rec, // rec still holds the saved value here
      }
    : null;
  let levelLoaded = false;
  const atSaved = () =>
    !!savedAt
    && stripSlashes(current) === savedAt.path
    && (!s.needsConnection || String(activeConn) === String(savedAt.connectionId))
    && (!recField || rec === savedAt.recursive);
  const syncUse = () => drawer.setPrimaryDisabled(!levelLoaded || atSaved());
  // The drawer's primary is REUSED across tasks (unlike the old modal's
  // per-instance Use button), so a slow response from THIS task must never
  // touch a later one: `dead` flips on dismissal AND on commit, and every
  // async continuation bails on it.
  let dead = false;

  // One wrapper as the body's single child: the drawer-body's group gap is
  // for form drawers; the tree keeps the old modal body's tighter rhythm and
  // owns the flex column the scroll region grows in.
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:10px;min-height:0;flex:1;";

  const pathLine = document.createElement("div");
  pathLine.className = "cb-note";
  pathLine.style.cssText = "display:flex;align-items:center;gap:10px;margin:0;";

  // The relink notice: when the saved path turns out to be gone, this names
  // it while the tree lands somewhere real below. Persistent — it's the
  // context for why you're not where the board points.
  const goneNote = document.createElement("p");
  goneNote.className = "im-status error flush";
  goneNote.style.display = "none";

  const cr = connSelect(() => {
    goneNote.style.display = "none"; // the old server's missing-path story
    load(""); // fresh server, fresh root
  });
  if (cr) wrap.appendChild(cr);
  wrap.append(pathLine, goneNote);

  const { scroll, thead, tbody, note, moreBtn } = pagedTableScaffold();
  moreBtn.style.display = "none"; // browse loads a whole level at once
  {
    const tr = document.createElement("tr");
    for (const h of ["Name", "Size", "Modified"]) {
      const th = document.createElement("th");
      th.textContent = h;
      if (h === "Size") th.className = "cb-end"; // matches its cells below
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }
  wrap.appendChild(scroll);
  if (recField) wrap.appendChild(recSwitch(syncUse));

  const fmtLoc = (p) => fmtLocation(sourceRootLabel(s, activeConn, rootPath), p);

  // The server resolves credentials from the connection id; the client only
  // ever names which one.
  const reqSource = () => (s.needsConnection ? { type: s.type, connectionId: activeConn } : { type: s.type });

  // Client-side twin of the server's parentPath — a failed level has no
  // response to carry `parent`, and the fallback needs to ascend anyway.
  const parentOf = (p) => {
    const t = stripSlashes(p);
    const i = t.lastIndexOf("/");
    return i < 0 ? "" : t.slice(0, i);
  };

  // `missing` rides along while falling back: the ORIGINAL path that 404ed,
  // so the notice names what the user asked for, not the ancestor that
  // finally opened.
  async function load(path, missing = null) {
    const my = ++seq;
    note.style.display = "";
    note.textContent = "Loading…";
    tbody.replaceChildren();
    // Only a level that actually rendered may be committed — without this
    // gate, a failed first load leaves the primary armed with the dead
    // saved path.
    levelLoaded = false;
    drawer.setPrimaryDisabled(true);
    try {
      const r = await fetch(`/api/boards/${boardId}/ingest/source/browse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: reqSource(), path }),
      });
      const data = await r.json().catch(() => ({}));
      if (dead || my !== seq) return;
      if (!r.ok) {
        // 404 = this path itself is gone (renamed/removed) — fall back one
        // level so the tree lands somewhere real and the user can navigate
        // to the folder's new home: the relink flow. Every still-missing
        // ancestor 404s and ascends again; the root ("") is the floor.
        // Anything else (dead server, bad connection) would fail at every
        // level too — show it and stop.
        if (r.status === 404 && path) {
          load(parentOf(path), missing ?? path);
          return;
        }
        note.textContent = data.error || "Browse failed";
        return;
      }
      current = data.path ?? path;
      levelLoaded = true;
      syncUse();
      if (missing != null) {
        goneNote.textContent = `Couldn't open "${missing}" — it may have been renamed or removed. Showing "${fmtLoc(current)}".`;
        goneNote.style.display = "";
      }
      renderPath(data.parent);
      const entries = data.entries || [];
      for (const e of entries) tbody.appendChild(row(e));
      // An empty level is still pickable — an inbox-style source drains to
      // empty on purpose. The schema's own noun, like the primary's label.
      if (!entries.length) { note.textContent = `Empty ${fieldWord}.`; note.style.display = ""; }
      else if (data.truncated) { note.textContent = "Showing the first 1000 entries."; note.style.display = ""; }
      else { note.style.display = "none"; }
    } catch {
      if (!dead && my === seq) note.textContent = "Browse failed";
    }
  }

  function renderPath(parent) {
    pathLine.replaceChildren();
    const label = document.createElement("span");
    label.style.fontFamily = "'SF Mono',Consolas,monospace";
    label.textContent = fmtLoc(current);
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
    sizeTd.textContent = e.type === "dir" || e.size == null ? "—" : fmtSize(e.size);
    const modTd = document.createElement("td");
    modTd.textContent = e.modified ? new Date(e.modified).toLocaleDateString() : "—";
    tr.append(nameTd, sizeTd, modTd);
    return tr;
  }

  drawer.open({
    head: head.nodes,
    tall: true,
    onDismiss: () => { dead = true; },
    build: (body) => { body.appendChild(wrap); },
    primary: {
      label: `Use this ${fieldWord}`,
      disabled: true, // until a level renders — and never while at the saved spot (syncUse)
      onClick: () => {
        // The connection the path was picked ON rides along — path and
        // server are one choice, and this click is what commits both.
        commit(current);
        dead = true;
        drawer.close();
      },
    },
  });
  // A connection-backed kind with nothing picked yet browses nothing — the
  // note says why the tree is empty, and the first pick loads that server's
  // root (connSelect's onChange). Everything else opens browsing.
  if (s.needsConnection && activeConn == null) {
    note.textContent = "Select a connection to browse.";
    note.style.display = "";
  } else {
    load(current);
  }
}
