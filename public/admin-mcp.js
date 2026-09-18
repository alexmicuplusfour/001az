// MCP tab: the endpoint's switch, which boards any agent may reach, what it can
// do there, and which browser origins may call it
// (planning/mcp-stage-1.md §6, planning/mcp-members-plan.md §10.14).
//
// THE INSTANCE, and nothing personal. Tokens belong to people and live on the
// account page with everything else that is one member's — this tab links there
// rather than carrying a second copy of the same command. What it does carry is
// the oversight half: who has an agent pointed here, when it last ran, and the
// one button that takes a connection away (planning/mcp-members-plan.md §10.18).
//
// The tool list is SERVED, not written here: GET /api/admin/mcp returns the
// same specs tools/list hands a client, down to which of them write, so a
// sixth tool appears in this pane with no edit to this file. Same stance
// admin-capabilities.js takes — the module renders the vocabulary it is
// handed and invents none.
//
// NOTHING VISUAL HERE IS THIS TAB'S OWN. The switches are switch.js, the board
// scope is the .boards-chip + access popover the Members tab opens, the badges
// are .p-note, and the page's section rhythm is `.section > h2`. This module
// used to inject a <style> at runtime holding its own copies of most of that;
// admin CSS lives in admin.html, and the handful of rules that really are this
// tab's are stated there beside every other tab's.
import { api } from "./api.js";
import { ICONS, relTime, esc, memberCell } from "./utils.js";
import { toolGroups } from "./mcp-pane.js";
import { toast } from "./toast.js";
import { switchRow } from "./switch.js";
import { openDropdown, ddCheckRow, ddAction, ddEmpty } from "./dropdown.js";

const content = document.getElementById("mcp-content");
export async function renderMcp() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;
  await load();
}

async function load() {
  paint(await api("GET", "/api/admin/mcp"));
}

// How many boards the scope names, as the chip says it. Empty MEANS all, so
// there is no "0" state to render: the two ways of saying everything (every
// box ticked, no box ticked) have one readout, which is the whole reason this
// is a chip and not twelve checkboxes that looked different while agreeing.
const scopeLabel = (d) => {
  const on = d.allBoards.filter((b) => b.on).length;
  if (!d.allBoards.length) return "No boards yet";
  return on === d.allBoards.length ? "All boards" : `${on} of ${d.allBoards.length} boards`;
};

function paint(d) {
  const secs = document.createDocumentFragment();

  // --- what this is, and whether it is on -----------------------------------
  // The heading is the acronym; the sub is the one place it gets spelled out.
  const head = section(`<h2>MCP</h2>
    <p class="sub">Let an AI client — Claude, ChatGPT, Cursor, anything that speaks the
    Model Context Protocol — search this instance's boards. Each member connects with
    their own token and reaches only the boards they are a member of. It cannot change
    a board, its facets or anyone's tags.</p>`);
  const onRow = switchRow("Enable MCP", "", d.enabled, (on) => save({ enabled: on }));
  onRow.id = "mcp-on";
  head.appendChild(onRow);
  secs.appendChild(head);

  const body = document.createElement("div");
  body.id = "mcp-body";
  if (!d.enabled) body.hidden = true;
  secs.appendChild(body);

  // --- who is connected -----------------------------------------------------
  // No token controls: an admin's own is a PERSONAL thing and lives with
  // everyone else's on their account page (§10.14). The pointer stays because
  // an admin who just switched the feature on is the likeliest person to want
  // one next — it is this section's sub now rather than a heading of its own,
  // since the heading finally has a body under it.
  body.appendChild(connections(d));

  // --- access: the two questions an operator actually has -------------------
  // One section, because "which boards" and "may it write" are one decision
  // with two halves. They were two headings and four lines of prose.
  const access = section(`<h2>Access</h2>`);
  const rows = document.createElement("div");
  rows.className = "mcp-access";
  const boardsRow = document.createElement("div");
  boardsRow.className = "mcp-row";
  boardsRow.innerHTML = `<span class="k">Boards</span>`;
  const scopeCell = document.createElement("span");
  boardsRow.appendChild(scopeCell);
  renderScopeChip(d, scopeCell);

  const savingRow = document.createElement("div");
  savingRow.className = "mcp-row";
  savingRow.innerHTML = `<span class="k">Saving</span>`;
  const writeRow = switchRow("Let agents save cards to crates", "", d.write, (on) => save({ write: on }));
  writeRow.id = "mcp-write";
  savingRow.appendChild(writeRow);

  rows.append(boardsRow, savingRow);
  access.appendChild(rows);
  access.insertAdjacentHTML(
    "beforeend",
    `<p class="sub mcp-after-list">No board selected means all of them, including ones added later.
    A crate an agent saves belongs to the member whose token it used, and appears in their
    gallery; it can add to one, never take cards out.</p>`
  );
  body.appendChild(access);

  // --- what it can do -------------------------------------------------------
  const tools = section(`<h2>Tools</h2>
    <div class="mcp-tools">${toolGroups(d.tools)}</div>
    <p class="sub mcp-after-list"><b>grid</b> — results also render as a pickable grid in clients
    that support MCP Apps. Claude Code shows text and preview images instead.</p>

    <details class="mcp-adv">
      <summary>Advanced</summary>
      <label for="mcp-origins">Allowed browser origins</label>
      <input id="mcp-origins" value="${esc(d.origins)}" placeholder="same-origin only" />
      <p class="sub">Comma-separated. Real MCP clients send no origin and are unaffected —
      this only widens which <i>web pages</i> may call the endpoint.</p>
    </details>`);
  body.appendChild(tools);

  content.replaceChildren(secs);
  const origins = document.getElementById("mcp-origins");
  if (origins) origins.onchange = () => save({ origins: origins.value });
}

// The oversight list: one row per token, and the only thing an admin can do to
// somebody else's connection. It answers the question the old instance-wide
// `mcp_last_used` could not once callers became distinguishable — who is
// connected, and is anything actually running.
//
// NO NEW CSS, and no new markup either: every cell is panel.css vocabulary the
// Members tab already renders (`table`, `.email`, `.muted`, `.row-actions`) and
// the person cell is that tab's, promoted to utils.js rather than copied.
// mcp.css stays out of it — that file is for the blocks the ACCOUNT page also
// draws, and this is not one of them.
function connections(d) {
  const el = section(`<h2>Connections</h2>
    <p class="sub">Every member connects with their own token, from
    <a href="/account.html#mcp">Account → MCP</a> — yours included.</p>`);

  if (!d.connections.length) {
    el.insertAdjacentHTML("beforeend", `<p class="sub">Nobody has created a token yet.</p>`);
    return el;
  }

  const table = document.createElement("table");
  table.id = "mcp-connections";
  table.innerHTML = `<thead><tr><th>Member</th><th>Created</th><th>Last used</th><th></th></tr></thead>
    <tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  for (const c of d.connections) {
    const tr = document.createElement("tr");
    // Created is a DATE and last used is RELATIVE, on purpose. "When was this
    // set up" is a calendar question; "is anything running" is not, and
    // `18/09/2026` answers it far worse than `3m ago`.
    tr.innerHTML = `
      <td>${memberCell(c)}</td>
      <td>${new Date(c.created).toLocaleDateString()}</td>
      <td>${c.lastUsed ? esc(relTime(c.lastUsed)) : '<span class="muted">never</span>'}</td>
      <td><div class="row-actions"></div></td>`;

    const btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "revoke";
    // Worded about the CONNECTION rather than its owner, so the admin's own row
    // — which is in this list, because hiding it would be the pane pretending
    // the admin is not a member — reads as true as anyone else's.
    btn.onclick = () => {
      if (!confirm(`Revoke ${c.email}'s token? Any client using it stops working on the next call. A new one can be created from Account → MCP.`)) return;
      revoke(c.id);
    };
    tr.querySelector(".row-actions").appendChild(btn);
    tbody.appendChild(tr);
  }

  el.appendChild(table);
  el.insertAdjacentHTML(
    "beforeend",
    `<p class="sub mcp-after-list">Revoking takes effect on the connection's next call and affects
    nobody else. Last used is accurate to the minute — a busy agent is not worth a write per call.</p>`
  );
  return el;
}

const section = (html) => {
  const el = document.createElement("div");
  el.className = "section";
  el.innerHTML = html;
  return el;
};

function renderScopeChip(d, cell) {
  const chip = document.createElement("button");
  chip.className = "boards-chip";
  chip.id = "mcp-scope";
  chip.innerHTML = ICONS.grid + `<span>${esc(scopeLabel(d))}</span>`;
  if (!d.allBoards.length) {
    chip.classList.add("empty");
    chip.disabled = true;
  } else {
    chip.setAttribute("aria-label", `Boards an agent can reach — ${scopeLabel(d)}`);
    chip.addEventListener("click", () => openScope(d, chip));
  }
  cell.replaceChildren(chip);
}

// The scope picker: the Members tab's access popover with one column instead of
// two. No fetch — unlike that one, the full board list already rode in with the
// pane — so the rows build synchronously and Save is live from the first frame.
//
// Batching behind Save is not only for consistency: a tick used to PATCH and
// repaint the entire pane, so scoping six boards rebuilt this tab six times.
function openScope(d, chip) {
  let rows = [];
  const ctx = openDropdown(chip, {
    variant: "light",
    align: "start",
    minWidth: 230,
    maxItems: 12,
    build: (body) => {
      if (!d.allBoards.length) return void body.appendChild(ddEmpty("No boards yet."));
      rows = d.allBoards.map((b) => {
        const row = ddCheckRow({ variant: "light", checked: b.on, label: b.name });
        body.appendChild(row.el);
        return { id: b.id, row };
      });
    },
    footer: (foot, { close }) => {
      foot.appendChild(ddAction({
        label: "Save",
        onClick: async () => {
          close();
          await save({ boards: rows.filter((r) => r.row.checked).map((r) => r.id) });
        },
      }));
    },
  });
  if (!ctx) return; // second click on the same chip: toggled closed
}

// EVERY write on this pane, in one place: each route answers the whole state, so
// the pane redraws from the answer rather than from a second fetch or a
// hand-spliced row — and a write that failed must leave nothing on screen
// claiming it worked, which is why the catch re-reads instead of just toasting.
async function apply(write) {
  try {
    paint(await write);
  } catch (err) {
    toast.error(err.message);
    load().catch(() => {});
  }
}

const save = (patch) => apply(api("PATCH", "/api/admin/mcp", patch));
const revoke = (id) => apply(api("DELETE", `/api/admin/mcp/connections/${id}`));
