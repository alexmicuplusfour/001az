// Boards tab: one row per board with item counts, an AI-usage cell (all-time
// tokens + a 14-day sparkline), and per-row actions — edit (shared board
// modal), access (member/board-admin dropdown), retag, tag-held, stop, delete —
// plus "+ New board". Self-guards on /api/me, so it no-ops for non-admins.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { openBoardModal } from "/board-modal.js";

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

    const accessWrap = document.createElement("div");
    accessWrap.className = "access-wrap";
    const accessBtn = document.createElement("button");
    accessBtn.className = "ghost";
    accessBtn.textContent = "access ▾";
    accessBtn.onclick = (e) => { e.stopPropagation(); toggleAccessDrop(b, accessWrap); };
    accessWrap.appendChild(accessBtn);
    wrap.appendChild(accessWrap);

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
    const retagWrap = document.createElement("div");
    retagWrap.className = "access-wrap";
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
      ? (e) => { e.stopPropagation(); toggleRetagDrop(b, facets, retagWrap, runRetag); }
      : () => runRetag(null);
    retagWrap.appendChild(retagBtn);
    wrap.appendChild(retagWrap);

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
function toggleRetagDrop(board, facets, container, run) {
  const id = `retag-drop-${board.id}`;
  const existing = document.getElementById(id);
  document.querySelectorAll(".retag-drop, .access-drop").forEach((d) => d.remove());
  if (existing) return; // second click closes

  const drop = document.createElement("div");
  drop.className = "access-drop retag-drop";
  drop.id = id;

  const opt = (label, key, onPick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "retag-opt";
    b.textContent = label;
    if (key) {
      const k = document.createElement("span");
      k.className = "retag-key";
      k.textContent = key;
      b.appendChild(k);
    }
    b.onclick = (e) => { e.stopPropagation(); drop.remove(); onPick(); };
    return b;
  };

  drop.appendChild(opt("Everything", null, () => run(null)));
  const sep = document.createElement("div");
  sep.className = "retag-sep";
  drop.appendChild(sep);
  for (const f of facets) {
    if (!f?.key) continue;
    drop.appendChild(opt(f.label || f.key, f.key, () => run(f)));
  }

  container.appendChild(drop);
  // Same dismiss contract as the access drop: the next click anywhere closes it.
  setTimeout(() => document.addEventListener("click", function away() {
    drop.remove();
    document.removeEventListener("click", away);
  }, { once: true }), 0);
}

async function toggleAccessDrop(board, container) {
  const existing = document.getElementById(`access-drop-${board.id}`);
  if (existing) { existing.remove(); return; }
  document.querySelectorAll(".access-drop").forEach((d) => d.remove());

  let users;
  try { users = await api("GET", "/api/admin/users"); }
  catch { return; }

  const drop = document.createElement("div");
  drop.className = "access-drop";
  drop.id = `access-drop-${board.id}`;

  const listEl = document.createElement("div");
  listEl.className = "access-drop-list";
  const memberSet = new Set(board.memberIds || []);
  const adminSet = new Set(board.adminIds || []);
  for (const u of users) {
    const row = document.createElement("div");
    row.className = "access-user";

    const lbl = document.createElement("label");
    lbl.className = "access-member-row" + (u.is_admin ? " is-admin" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "member-cb";
    cb.value = u.id;
    cb.checked = u.is_admin || memberSet.has(u.id);
    cb.disabled = !!u.is_admin;
    const nameEl = document.createElement("span");
    nameEl.textContent = (u.name || u.email) + (u.is_admin ? " (admin)" : "");
    lbl.append(cb, nameEl);
    row.appendChild(lbl);

    // Board-admin toggle: lets a member edit this board from the gallery.
    // Its own indented row + own <label> so it toggles natively; only for
    // non-global-admins (global admins already manage every board), and
    // only active once they're a member.
    if (!u.is_admin) {
      const adminLbl = document.createElement("label");
      adminLbl.className = "access-admin-row";
      adminLbl.title = "Can edit this board's settings from the gallery";
      const adminCb = document.createElement("input");
      adminCb.type = "checkbox";
      adminCb.className = "admin-cb";
      adminCb.value = u.id;
      adminCb.checked = adminSet.has(u.id);
      adminCb.disabled = !cb.checked;
      const adminTxt = document.createElement("span");
      adminTxt.textContent = "board admin";
      adminLbl.append(adminCb, adminTxt);
      cb.addEventListener("change", () => {
        adminCb.disabled = !cb.checked;
        if (!cb.checked) adminCb.checked = false;
      });
      row.appendChild(adminLbl);
    }
    listEl.appendChild(row);
  }
  drop.appendChild(listEl);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.onclick = async () => {
    const memberIds = [...listEl.querySelectorAll("input.member-cb:not(:disabled):checked")].map((cb) => Number(cb.value));
    const adminIds = [...listEl.querySelectorAll("input.admin-cb:not(:disabled):checked")].map((cb) => Number(cb.value));
    try {
      await api("PATCH", `/api/admin/boards/${board.id}`, { memberIds, adminIds });
      board.memberIds = memberIds;
      board.adminIds = adminIds;
      drop.remove();
      toast("Access updated");
    } catch (err) { toast.error(err.message); }
  };
  drop.appendChild(saveBtn);
  container.appendChild(drop);

  function onOutside(e) {
    if (!container.contains(e.target)) {
      drop.remove();
      document.removeEventListener("click", onOutside);
    }
  }
  setTimeout(() => document.addEventListener("click", onOutside), 0);
}
