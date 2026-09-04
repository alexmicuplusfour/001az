// Boards tab: one row per board with item counts and per-row actions — edit (shared board
// modal), access (member/board-admin dropdown), retag, tag-held, stop, delete —
// plus "+ New board". Self-guards on /api/me, so it no-ops for non-admins.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { openBoardModal } from "/board-modal.js";
import { openDropdown, ddRow, ddCheckRow, ddChildCheckRow, ddSep, ddAction, ddEmpty } from "/dropdown.js";
import { ICONS } from "/utils.js";

const boardsContent = document.getElementById("boards-content");

function boardUrl(id) {
  return `${location.origin}/?board=${id}`;
}

export async function renderBoards() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;

  let boards;
  try {
    const r = await api("GET", "/api/admin/boards");
    boards = r.boards;
  } catch { return; }

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h2>Boards</h2><p class="sub">Each board has its own items, taxonomy, and URL. Share the URL to give access.</p>`;

  // Board table
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Name</th><th>Items</th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");

  for (const b of boards) {
    const url = boardUrl(b.id);

    const tr = document.createElement("tr");
    tr.id = `board-row-${b.id}`;
    const nextRun = b.auto_tag_next_run_at
      ? `next scheduled run: ${new Date(b.auto_tag_next_run_at).toLocaleString()}`
      : "";
    tr.innerHTML = `
      <td><span class="name-cell">${ICONS.grid}<a href="${url}" target="_blank" style="color:inherit;text-decoration:none;font-weight:600">${b.name}</a></span></td>
      <td>${b.item_count}${b.pending_count ? ` <span style="color:#9aa0aa">(${b.pending_count} queued)</span>` : ""}${b.held_count ? ` <span style="color:#9aa0aa" title="uploads waiting while auto-tagging is off">(${b.held_count} held)</span>` : ""}</td>
      <td></td>`;

    const actCell = tr.querySelector("td:last-child");
    const wrap = document.createElement("div");
    wrap.className = "row-actions-wrap";

    const editBtn = document.createElement("button");
    editBtn.className = "ghost";
    editBtn.textContent = "edit";
    editBtn.onclick = () => openBoardModal(b.id, { canEditAI: true, onSaved: renderBoards });
    wrap.appendChild(editBtn);

    const accessBtn = document.createElement("button");
    accessBtn.className = "ghost";
    // Label then caret, the way every other dropdown trigger in the app reads.
    accessBtn.innerHTML = "<span>access</span>" + ICONS.chevron;
    accessBtn.onclick = (e) => { e.stopPropagation(); openAccessPop(b, accessBtn); };
    wrap.appendChild(accessBtn);

    // A voting board bills once per PASS, not once per item, so the item count
    // stops being the cost. "Up to" is doing real work in both directions: the
    // retag route only re-queues tagged/failed/held rows (a subset of
    // item_count, which counts every status), and a vote round that loses a
    // pass merges fewer. Single-pass boards keep exactly today's wording.
    const votes = Number(b.ai_votes) || 1;
    const passNote = votes > 1 ? ` — ${votes} agreement passes per item` : "";
    // Retag, optionally on ONE facet. A facet retag re-rolls only that facet and
    // leaves every other one alone — which matters because a full pass re-rolls
    // all of them at 18-22% instability, so fixing one facet's gloss otherwise
    // shakes the rest for nothing (planning/facet-addressable-tagging-plan.md).
    const facets = Array.isArray(b.facets) ? b.facets : [];
    const retagBtn = document.createElement("button");
    retagBtn.className = "danger";
    // Action glyph, label, then the caret only when there is a menu behind it —
    // which is the same thing the two-branch label was saying with "▾".
    retagBtn.innerHTML = ICONS.redo + "<span>retag</span>" + (facets.length ? ICONS.chevron : "");
    retagBtn.title = "Re-queue this board for AI tagging" + passNote + (nextRun ? ` (${nextRun})` : "");

    const runRetag = async (facet) => {
      const scope = facet ? [facet.key] : null;
      const what = facet ? `on "${facet.label || facet.key}" only` : "on every facet";
      const keeps = facet ? "\n\nEvery other facet keeps its current tags." : "\n\nExisting tags will be cleared and reprocessed.";
      const cost = votes > 1
        ? ` This board runs ${votes} agreement passes per item, so that is up to ~${(b.item_count * votes).toLocaleString()} paid tagging calls.`
        : "";
      if (!confirm(`Re-tag all ${b.item_count} item(s) in "${b.name}" ${what}?${keeps}${cost}`)) return;
      // Markup, not text: the label to put back is a glyph plus a span now. The
      // in-flight states below stay plain words — they replace the whole button,
      // icon included, which is what they already did.
      const label = retagBtn.innerHTML;
      try {
        retagBtn.disabled = true;
        retagBtn.textContent = "queuing…";
        const { queued } = await api("POST", `/api/admin/boards/${b.id}/retag`, scope ? { facets: scope } : undefined);
        retagBtn.textContent = `queued ${queued}`;
        toast(`Queued ${queued} item(s) for retagging${facet ? ` on ${facet.label || facet.key}` : ""}`);
        setTimeout(renderBoards, 1500);
      } catch (err) {
        toast.error(err.message);
        retagBtn.innerHTML = label;
        retagBtn.disabled = false;
      }
    };

    // No facets: nothing to scope to, so the button stays a plain action.
    retagBtn.onclick = facets.length
      ? (e) => { e.stopPropagation(); openRetagPop(facets, retagBtn, runRetag); }
      : () => runRetag(null);
    wrap.appendChild(retagBtn);

    if (b.held_count > 0) {
      const tagHeldBtn = document.createElement("button");
      tagHeldBtn.className = "ghost";
      tagHeldBtn.innerHTML = ICONS.play + "<span>tag held</span>";
      // Informational only — this button deliberately has no confirm, so the
      // pass count rides the title rather than adding friction to it.
      tagHeldBtn.title = `Tag the ${b.held_count} held item(s) now, without turning auto-tagging back on`
        + (votes > 1 ? ` — ${votes} passes each, up to ~${(b.held_count * votes).toLocaleString()} paid calls` : "");
      tagHeldBtn.onclick = async () => {
        try {
          tagHeldBtn.disabled = true;
          tagHeldBtn.textContent = "queuing…";
          const { released } = await api("POST", `/api/admin/boards/${b.id}/tag-held`);
          toast(`Queued ${released} held item(s) for tagging`);
          renderBoards();
        } catch (err) {
          toast.error(err.message);
          renderBoards();
        }
      };
      wrap.appendChild(tagHeldBtn);
    }

    if (b.pending_count > 0) {
      const stopBtn = document.createElement("button");
      stopBtn.className = "danger";
      stopBtn.innerHTML = ICONS.stop + "<span>stop</span>";
      stopBtn.title = "Cancel queued AI tagging for this board";
      stopBtn.onclick = async () => {
        if (!confirm(`Stop the tagging queue for "${b.name}"? ${b.pending_count} queued item(s) will be pulled out — ones with previous tags keep them, the rest show as untagged for review.`)) return;
        try {
          stopBtn.disabled = true;
          stopBtn.textContent = "stopping…";
          await api("POST", `/api/admin/boards/${b.id}/retag/cancel`);
          toast("Tagging queue stopped");
          renderBoards();
        } catch (err) {
          toast.error(err.message);
          renderBoards();
        }
      };
      wrap.appendChild(stopBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "delete";
    delBtn.onclick = async () => {
      const msg = b.item_count > 0
        ? `Delete board "${b.name}" and its ${b.item_count} item(s)? This cannot be undone.`
        : `Delete board "${b.name}"?`;
      if (!confirm(msg)) return;
      try {
        await api("DELETE", `/api/admin/boards/${b.id}`);
        toast(`Board "${b.name}" deleted`);
        renderBoards();
      } catch (err) { toast.error(err.message); }
    };
    wrap.appendChild(delBtn);

    actCell.appendChild(wrap);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  sec.appendChild(table);

  // Create button — same modal as edit, in create mode
  const createSec = document.createElement("div");
  createSec.style.marginTop = "20px";
  const createBtn = document.createElement("button");
  createBtn.className = "ghost";
  createBtn.innerHTML = ICONS.plus + "<span>New board</span>"; // same button as the gallery's
  createBtn.onclick = () => openBoardModal(null, { canEditAI: true, onSaved: renderBoards });
  createSec.appendChild(createBtn);
  sec.appendChild(createSec);

  boardsContent.replaceChildren(sec);
}

// The retag scope picker. Purely local — the board row already carries `facets`
// (BOARD_COLS selects it and /api/admin/boards spreads the row), so opening this
// costs no fetch.
//
// The shell is the app's dropdown component in its light variant: it brings the
// viewport-aware placement this menu needs most, since the boards table runs
// long and a picker on the last row used to open straight off the bottom of the
// window. Scroll cap, Escape, re-click-to-close, one-open-at-a-time and arrow
// keys come with it.
function openRetagPop(facets, anchorEl, run) {
  openDropdown(anchorEl, {
    variant: "light",
    align: "end",
    minWidth: 220,
    build: (body, { close }) => {
      body.appendChild(ddRow({
        label: "Everything",
        onClick: () => { close(); run(null); },
      }));
      body.appendChild(ddSep());
      for (const f of facets) {
        if (!f?.key) continue;
        // label over key: a facet is picked by its human name, but the key is
        // what the retag call sends, and they are worth seeing together
        body.appendChild(ddRow({
          label: f.label || f.key,
          sublabel: f.key,
          onClick: () => { close(); run(f); },
        }));
      }
    },
  });
}

// The board access picker: who can see this board, and which of them may edit
// it from the gallery. Same shell as the retag picker.
//
// It opens BEFORE its data arrives, on purpose. The user list is a fetch, and
// awaiting it first would both delay the popover and hand openDropdown a stale
// view of what is open — its "click the same anchor again to close" check would
// run a round-trip after the click that should have closed it. So: open with a
// placeholder, fill the body when the list lands, then re-measure.
function openAccessPop(board, anchorEl) {
  let live = true; // the fetch can outlive the popover — closing it wins
  let saveBtn;    // assigned by the footer builder, which runs inside the call
  const ctx = openDropdown(anchorEl, {
    variant: "light",
    align: "end",
    minWidth: 240,
    // rows, not users: a member with a board-admin toggle contributes two, so
    // this is roughly six people before the list starts scrolling
    maxItems: 12,
    onClose: () => { live = false; },
    build: (body) => body.appendChild(ddEmpty("Loading…")),
    // Dead until the user list lands. `rows` is empty until then and an empty
    // save clears the board's whole membership, so a slow fetch would otherwise
    // leave "remove everyone" sitting exactly where the user expects "Save".
    footer: (foot) => {
      saveBtn = ddAction({ label: "Save", disabled: true, onClick: () => save() });
      foot.appendChild(saveBtn);
    },
  });
  if (!ctx) return; // second click on the same button: toggled closed

  const memberSet = new Set(board.memberIds || []);
  const adminSet = new Set(board.adminIds || []);
  let rows = []; // { id, member, admin } — the handles, not the DOM

  async function save() {
    const memberIds = rows.filter((r) => !r.member.disabled && r.member.checked).map((r) => r.id);
    const adminIds = rows.filter((r) => r.admin && !r.admin.disabled && r.admin.checked).map((r) => r.id);
    try {
      await api("PATCH", `/api/admin/boards/${board.id}`, { memberIds, adminIds });
      board.memberIds = memberIds;
      board.adminIds = adminIds;
      ctx.close();
      toast("Access updated");
    } catch (err) { toast.error(err.message); }
  }

  api("GET", "/api/admin/users").then((users) => {
    if (!live) return;
    const list = document.createDocumentFragment();
    rows = users.map((u) => {
      // A global admin is a member of every board and can't be removed from
      // one, so their box is checked and dead.
      const member = ddCheckRow({
        variant: ctx.variant,
        checked: u.is_admin || memberSet.has(u.id),
        disabled: !!u.is_admin,
        label: (u.name || u.email) + (u.is_admin ? " (admin)" : ""),
      });
      list.appendChild(member.el);

      // Board-admin lets a member edit this board's settings from the gallery.
      // Global admins already can, so they get no toggle; everyone else's is a
      // child of their membership, which ddChildCheckRow keeps it tied to.
      let admin = null;
      if (!u.is_admin) {
        admin = ddChildCheckRow(member, {
          variant: ctx.variant,
          checked: adminSet.has(u.id),
          label: "board admin",
          title: "Can edit this board's settings from the gallery",
        });
        list.appendChild(admin.el);
      }

      return { id: u.id, member, admin };
    });
    ctx.body.replaceChildren(list);
    saveBtn.disabled = false;
    ctx.reposition(); // the body just changed height
  }).catch(() => { if (live) ctx.close(); });
}
