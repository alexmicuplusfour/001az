// Members tab: invite-only user list — add a member (mints + copies a login
// link), copy/re-mint a link, set board access, remove. This render also gates
// the whole admin shell: it flips #admin-ui visible once /api/me confirms an
// admin, so it runs first from admin.js. The boards and AI tabs each re-check
// access themselves.
import { toast } from "/toast.js";
import { api, copy } from "/api.js";
import { openDropdown, ddRow, ddCheckRow, ddChildCheckRow, ddAction, ddEmpty } from "/dropdown.js";
import { ICONS } from "/utils.js";

const content = document.getElementById("content");
const gate = document.getElementById("gate");
const adminUi = document.getElementById("admin-ui");

const badge = (text) =>
  Object.assign(document.createElement("span"), { className: "badge", textContent: text });

export async function renderMembers() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me) return location.replace("/login.html?next=" + encodeURIComponent("/admin.html"));
  if (!me.is_admin) {
    gate.innerHTML = 'Not authorized. <a href="/">Back to gallery</a>';
    return;
  }
  const users = await api("GET", "/api/admin/users");
  gate.hidden = true;
  adminUi.hidden = false;
  content.innerHTML = `
    <form id="add">
      <input id="name" placeholder="Name (optional)" />
      <input id="email" type="email" placeholder="member@email.com" required />
      <button type="submit">Add & make link</button>
    </form>
    <table>
      <thead><tr><th>Name</th><th>Last login</th><th>Boards</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>`;

  const rows = document.getElementById("rows");
  for (const u of users) {
    // The server stores only token hashes, so an existing link can't be
    // shown back. "copy link" mints a fresh single-use link on first use
    // (replacing the user's previous link) and copies from cache after that.
    // Links are the onboarding/password-reset path: they log in once, then
    // the user sets a password.
    u.link = null;

    const tr = document.createElement("tr");
    const last = u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : '<span class="muted">never</span>';
    tr.innerHTML = `
      <td><div class="name-cell">${ICONS.user}<div><div>${u.name || "—"} ${u.is_admin ? '<span class="badge">admin</span>' : ""}</div><div class="email">${u.email}</div></div></div></td>
      <td>${last}</td>
      <td class="boards-cell"></td>
      <td><div class="row-actions"></div></td>`;
    renderBoardsCell(u, tr.querySelector(".boards-cell"));
    const act = tr.querySelector(".row-actions");

    const copyBtn = document.createElement("button");
    copyBtn.className = "ghost";
    copyBtn.textContent = "copy link";
    copyBtn.title = "Copies a fresh single-use login link (valid 30 days — replaces any previous link)";
    copyBtn.onclick = async () => {
      copyBtn.disabled = true;
      try {
        if (!u.link) {
          const { link } = await api("POST", `/api/admin/users/${u.id}/link`);
          u.link = link;
          toast("New login link copied — the old one no longer works");
        }
        copy(u.link, copyBtn);
      } catch (err) {
        toast.error(err.message);
      } finally {
        copyBtn.disabled = false;
      }
    };
    act.appendChild(copyBtn);

    if (!u.is_admin) {
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "remove";
      del.onclick = async () => {
        if (!confirm(`Remove ${u.email}? They lose access immediately.`)) return;
        await api("DELETE", `/api/admin/users/${u.id}`);
        renderMembers();
      };
      act.appendChild(del);
    }
    rows.appendChild(tr);
  }

  document.getElementById("add").onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim();
    const name = document.getElementById("name").value.trim();
    try {
      const { user, link } = await api("POST", "/api/admin/users", { email, name });
      await navigator.clipboard.writeText(link).catch(() => {});
      toast.info(`${user.email} added — login link copied`);
      renderMembers();
    } catch (err) {
      toast.error(err.message);
    }
  };
}

// How many boards this member can see, expanding to which ones. Rendered on its
// own so a save can put the new count back without reloading the table.
function renderBoardsCell(u, cell) {
  // A global admin reaches every board from is_admin alone — there is no
  // board_members row to count and nothing here to edit — so their cell states
  // that instead of counting to zero. Same answer the Boards tab's access
  // picker gives when it checks their box and disables it.
  if (u.is_admin) {
    const all = document.createElement("span");
    all.className = "boards-chip";
    all.innerHTML = ICONS.grid + "<span>all</span>";
    all.title = "Global admin — every board, including ones added later";
    cell.replaceChildren(all);
    return;
  }

  const n = u.boards.length;
  const chip = document.createElement("button");
  if (n) {
    chip.className = "boards-chip";
    chip.innerHTML = ICONS.grid + `<span>${n}</span>`;
    // The glyph carries the meaning for sighted readers; a bare "3" doesn't
    // survive being read aloud.
    chip.setAttribute("aria-label", `Board access — ${n} ${n === 1 ? "board" : "boards"}`);
    chip.addEventListener("pointerenter", () => openPreview(u, chip));
  } else {
    chip.className = "boards-chip empty";
    chip.innerHTML = "<span>none</span>";
    // Nothing to preview when the list is empty, so this chip is click-only —
    // which also makes it the one that can carry a native tooltip without
    // racing a popover for the same corner of the screen.
    chip.title = "No boards yet — click to grant access";
  }
  // Hover previews what they have; click edits it. openDropdown handles the
  // rest: a click-open replaces the preview, and re-clicking the editor's own
  // chip toggles it shut.
  chip.addEventListener("click", () => openAccess(u, chip));
  cell.replaceChildren(chip);
}

// Read-only hover popover: the member's boards, the board-admin ones badged.
// Costs no fetch — the row already carries the list — which is why this can be
// a hover at all rather than something you have to click to find out.
function openPreview(u, chip) {
  openDropdown(chip, {
    hover: true,
    variant: "light",
    align: "start",
    minWidth: 190,
    // No onClick on these rows, so ddRow renders them static — a list, without
    // the pointer and hover lift of something you could press.
    build: (body) => {
      for (const b of u.boards) {
        body.appendChild(ddRow({
          label: b.name,
          trailing: b.role === "admin" ? badge("admin") : undefined,
        }));
      }
    },
    // The chip's own click does this too; the action is what says so out loud.
    footer: (foot, { close }) => {
      foot.appendChild(ddAction({
        label: "Edit access",
        icon: ICONS.pencil,
        onClick: () => { close(); openAccess(u, chip); },
      }));
    },
  });
}

// The per-member access editor: every board, with a board-admin toggle under
// each. The mirror image of the Boards tab's picker (openAccessPop in
// admin-boards.js) — same rows, same rules, pivoted to one member and every
// board instead of one board and every member. Onboarding reads far better this
// way round: a new member gets all their boards in one popover, instead of one
// visit to the Boards tab per board.
//
// The board list comes from /api/boards, which for a global admin IS every
// board, and is fetched per open rather than cached with the table — a board
// created on the Boards tab mid-session has to show up here.
//
// It opens BEFORE that fetch lands, for the reason the board-side picker does:
// awaiting first would both delay the popover and hand openDropdown a stale
// view of what is open.
function openAccess(u, chip) {
  let live = true; // the fetch can outlive the popover — closing it wins
  let saveBtn;    // assigned by the footer builder, which runs inside the call
  const ctx = openDropdown(chip, {
    variant: "light",
    align: "start",
    minWidth: 240,
    // rows, not boards: a board they're in contributes two, so this is roughly
    // six joined boards before the list starts scrolling
    maxItems: 12,
    onClose: () => { live = false; },
    build: (body) => body.appendChild(ddEmpty("Loading…")),
    // Save is dead until the list lands — see the same footer in
    // admin-boards.js: acting on rows that haven't arrived means acting on
    // none, and "none" is a full revoke.
    footer: (foot) => {
      saveBtn = ddAction({ label: "Save", disabled: true, onClick: () => save() });
      foot.appendChild(saveBtn);
    },
  });
  if (!ctx) return; // second click on the same chip: toggled closed

  const memberSet = new Set(u.boards.map((b) => b.id));
  const adminSet = new Set(u.boards.filter((b) => b.role === "admin").map((b) => b.id));
  let rows = [];    // { id, name, member, admin } — the handles, not the DOM

  async function save() {
    // Built once, in the shape the row carries, and the payload derived from
    // it — so what the table shows next and what the server was told are the
    // same list rather than two that have to agree.
    const boards = rows.filter((r) => r.member.checked).map((r) => ({
      id: r.id,
      name: r.name,
      role: r.admin.checked ? "admin" : "member",
    }));
    try {
      await api("PATCH", `/api/admin/users/${u.id}/boards`, {
        boardIds: boards.map((b) => b.id),
        adminBoardIds: boards.filter((b) => b.role === "admin").map((b) => b.id),
      });
      u.boards = boards;
      const cell = chip.parentElement;
      ctx.close();
      renderBoardsCell(u, cell); // the chip can re-render without a table reload
      toast("Board access updated");
    } catch (err) { toast.error(err.message); }
  }

  api("GET", "/api/boards").then((boards) => {
    if (!live) return;
    if (!boards.length) {
      ctx.body.replaceChildren(ddEmpty("No boards yet."));
      ctx.reposition();
      return;
    }
    const list = document.createDocumentFragment();
    rows = boards.map((b) => {
      const member = ddCheckRow({
        variant: ctx.variant,
        checked: memberSet.has(b.id),
        label: b.name,
      });
      // Board-admin lets a member edit that board's settings from the gallery,
      // and only while they're a member — which ddChildCheckRow enforces.
      const admin = ddChildCheckRow(member, {
        variant: ctx.variant,
        checked: adminSet.has(b.id),
        label: "board admin",
        title: "Can edit this board's settings from the gallery",
      });
      list.append(member.el, admin.el);
      return { id: b.id, name: b.name, member, admin };
    });
    ctx.body.replaceChildren(list);
    saveBtn.disabled = false;
    ctx.reposition(); // the body just changed height
  }).catch(() => { if (live) ctx.close(); });
}
