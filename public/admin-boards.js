// Boards tab: one row per board with item counts, an AI-usage cell (all-time
// tokens + a 14-day sparkline), and per-row actions — edit (shared board
// modal), access (member/board-admin dropdown), retag, tag-held, stop, delete —
// plus "+ New board". Self-guards on /api/me, so it no-ops for non-admins.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { openBoardModal } from "/board-modal.js";
import { openDropdown, ddRow, ddCheckRow, ddSep, ddAction } from "/dropdown.js";

const boardsContent = document.getElementById("boards-content");

function boardUrl(id) {
  return `${location.origin}/?board=${id}`;
}

export async function renderBoards() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;

  let boards;
  try {
    boards = await api("GET", "/api/admin/boards");
  } catch { return; }

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h2>Boards</h2><p class="sub">Each board has its own items, taxonomy, and URL. Share the URL to give access.</p>`;

  // Board table
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Name</th><th>Items</th><th>AI tokens</th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");

  const fmtTok = (n) =>
    n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
    : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "K"
    : String(n);
  // Last 14 days as 2px bars, height = billable input tokens (cache
  // reads excluded), scaled to the board's busiest day in the window.
  // Idle days show a 1px baseline tick; bottom-aligned flex puts the
  // ticks exactly on the text baseline.
  function sparkline(days) {
    if (!days || !days.some((d) => d.input > 0)) return "";
    const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
    const max = Math.max(...days.map((d) => d.input));
    let bars = "";
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const d = byDay[day];
      const h = d && d.input ? Math.max(2, Math.round((d.input / max) * 12)) : 1;
      const tip = d
        ? `${day} — ${d.calls} call(s), ${fmtTok(d.input)} in / ${fmtTok(d.output)} out${d.searches ? `, ${d.searches} search(es)` : ""}`
        : `${day} — no tagging`;
      bars += `<span title="${tip}" style="width:2px;height:${h}px;background:#000"></span>`;
    }
    return `<span style="display:inline-flex;align-items:flex-end;gap:2px;margin-left:10px;cursor:default">${bars}</span>`;
  }
  function usageCell(u) {
    if (!u || !u.calls) return `<span style="color:#9aa0aa">—</span>`;
    const tip = [
      `${u.calls} call(s) all-time`,
      u.searches ? `${u.searches} web search(es)` : "",
      u.cacheRead ? `${fmtTok(u.cacheRead)} cached input reads` : "",
      u.today.calls ? `today: ${u.today.calls} call(s), ${fmtTok(u.today.input)} in / ${fmtTok(u.today.output)} out` : "",
    ].filter(Boolean).join(" · ");
    return `<span title="${tip}">${fmtTok(u.input)} in · ${fmtTok(u.output)} out</span>${sparkline(u.days)}`;
  }

  for (const b of boards) {
    const url = boardUrl(b.id);

    const tr = document.createElement("tr");
    tr.id = `board-row-${b.id}`;
    const nextRun = b.auto_tag_next_run_at
      ? `next scheduled run: ${new Date(b.auto_tag_next_run_at).toLocaleString()}`
      : "";
    tr.innerHTML = `
      <td><span class="name-cell"><svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><a href="${url}" target="_blank" style="color:inherit;text-decoration:none;font-weight:600">${b.name}</a></span></td>
      <td>${b.item_count}${b.pending_count ? ` <span style="color:#9aa0aa">(${b.pending_count} queued)</span>` : ""}${b.held_count ? ` <span style="color:#9aa0aa" title="uploads waiting while auto-tagging is off">(${b.held_count} held)</span>` : ""}</td>
      <td>${usageCell(b.ai_usage)}</td>
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
    accessBtn.textContent = "access ▾";
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
    retagBtn.textContent = facets.length ? "retag ↺ ▾" : "retag ↺";
    retagBtn.title = "Re-queue this board for AI tagging" + passNote + (nextRun ? ` (${nextRun})` : "");

    const runRetag = async (facet) => {
      const scope = facet ? [facet.key] : null;
      const what = facet ? `on "${facet.label || facet.key}" only` : "on every facet";
      const keeps = facet ? "\n\nEvery other facet keeps its current tags." : "\n\nExisting tags will be cleared and reprocessed.";
      const cost = votes > 1
        ? ` This board runs ${votes} agreement passes per item, so that is up to ~${(b.item_count * votes).toLocaleString()} paid tagging calls.`
        : "";
      if (!confirm(`Re-tag all ${b.item_count} item(s) in "${b.name}" ${what}?${keeps}${cost}`)) return;
      const label = retagBtn.textContent;
      try {
        retagBtn.disabled = true;
        retagBtn.textContent = "queuing…";
        const { queued } = await api("POST", `/api/admin/boards/${b.id}/retag`, scope ? { facets: scope } : undefined);
        retagBtn.textContent = `queued ${queued}`;
        toast(`Queued ${queued} item(s) for retagging${facet ? ` on ${facet.label || facet.key}` : ""}`);
        setTimeout(renderBoards, 1500);
      } catch (err) {
        toast.error(err.message);
        retagBtn.textContent = label;
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
      tagHeldBtn.textContent = "tag held ▸";
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
      stopBtn.textContent = "stop ■";
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
  createBtn.textContent = "+ New board";
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
  const ctx = openDropdown(anchorEl, {
    variant: "light",
    align: "end",
    minWidth: 240,
    // rows, not users: a member with a board-admin toggle contributes two, so
    // this is roughly six people before the list starts scrolling
    maxItems: 12,
    onClose: () => { live = false; },
    build: (body) => {
      const hint = document.createElement("div");
      hint.className = "dd-empty";
      hint.textContent = "Loading…";
      body.appendChild(hint);
    },
    footer: (foot) => {
      foot.appendChild(ddAction({ label: "Save", onClick: () => save() }));
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
      // child of their membership — live only while they are a member.
      let admin = null;
      if (!u.is_admin) {
        admin = ddCheckRow({
          variant: ctx.variant,
          child: true,
          checked: adminSet.has(u.id),
          disabled: !member.checked,
          label: "board admin",
        });
        admin.el.title = "Can edit this board's settings from the gallery";
        member.addEventListener("change", () => {
          admin.disabled = !member.checked;
          if (!member.checked) admin.checked = false;
        });
        list.appendChild(admin.el);
      }

      return { id: u.id, member, admin };
    });
    ctx.body.replaceChildren(list);
    ctx.reposition(); // the body just changed height
  }).catch(() => { if (live) ctx.close(); });
}
