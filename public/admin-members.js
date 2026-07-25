// Members tab: invite-only user list — add a member (mints + copies a login
// link), copy/re-mint a link, remove. This render also gates the whole admin
// shell: it flips #admin-ui visible once /api/me confirms an admin, so it runs
// first from admin.js. The boards and AI tabs each re-check access themselves.
import { toast } from "/toast.js";
import { api, copy } from "/api.js";

const content = document.getElementById("content");
const gate = document.getElementById("gate");
const adminUi = document.getElementById("admin-ui");

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
      <thead><tr><th>Name</th><th>Last login</th><th>♥ given</th><th></th></tr></thead>
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
      <td><div class="name-cell"><svg class="row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><div><div>${u.name || "—"} ${u.is_admin ? '<span class="badge">admin</span>' : ""}</div><div class="email">${u.email}</div></div></div></td>
      <td>${last}</td>
      <td>${u.hearts_given}</td>
      <td><div class="row-actions"></div></td>`;
    const act = tr.querySelector(".row-actions");

    const copyBtn = document.createElement("button");
    copyBtn.className = "ghost";
    copyBtn.textContent = "copy link";
    copyBtn.title = "Copies a fresh single-use login link (valid 7 days — replaces any previous link)";
    copyBtn.onclick = async () => {
      copyBtn.disabled = true;
      try {
        if (!u.link) {
          const { link } = await api("POST", `/api/admin/users/${u.id}/link`);
          u.link = link;
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
