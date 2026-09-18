// MCP tab: the endpoint's switch, the one command that connects a client to it,
// which boards that client may reach, and what it can do there
// (planning/mcp-stage-1.md §6).
//
// The copy button is why this is a tab rather than three environment
// variables. Everything else here could have lived in a .env — a working
// `claude mcp add` line, with this instance's real address and real token
// already in it, could not.
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
import { api, copy } from "./api.js";
import { relTime, ICONS } from "./utils.js";
import { toast } from "./toast.js";
import { switchRow } from "./switch.js";
import { openDropdown, ddCheckRow, ddAction, ddEmpty } from "./dropdown.js";

const content = document.getElementById("mcp-content");
let shown = false; // the token is masked until asked for, per render

export async function renderMcp() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;
  await load();
}

async function load() {
  paint(await api("GET", "/api/admin/mcp"));
}

const mask = (t) => (t.length > 10 ? `${t.slice(0, 6)}${"·".repeat(12)}${t.slice(-4)}` : "·".repeat(12));

// The line an operator pastes. Quoted for a POSIX shell; the token is the only
// part that varies, and a cleared token drops the header entirely because that
// is exactly the local-no-auth case.
//
// `masked` exists because this is now the ONLY place the token is shown. It
// used to be printed here in full while a separate Token section below it
// rendered the same string behind dots — a mask guarding a door with no wall
// beside it. Hiding it here is what makes hiding it mean anything; copy still
// copies the real thing, since a masked command is not a command.
const command = (d, masked = false) =>
  [
    "claude mcp add --transport http boards \\",
    `  ${d.endpoint}` + (d.token ? " \\" : ""),
    ...(d.token ? [`  --header "Authorization: Bearer ${masked ? mask(d.token) : d.token}"`] : []),
  ].join("\n");

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
    Model Context Protocol — search this instance's boards. It cannot change a board,
    its facets or anyone's tags.</p>`);
  const onRow = switchRow("Enable MCP", "", d.enabled, (on) => save({ enabled: on }));
  onRow.id = "mcp-on";
  head.appendChild(onRow);
  secs.appendChild(head);

  const body = document.createElement("div");
  body.id = "mcp-body";
  if (!d.enabled) body.hidden = true;
  secs.appendChild(body);

  // --- the connection: one command, carrying the token ----------------------
  // The command needs no caption: it is a line of shell with a copy button.
  const conn = section(`<h2>Connection</h2>
    <pre class="mcp-cmd" id="mcp-cmd">${esc(command(d, !shown))}</pre>
    <div class="mcp-cmd-actions">
      <button id="mcp-copy" class="sm">copy</button>
      <span class="gap"></span>
      ${d.token ? `<button id="mcp-show" class="sm ghost">${shown ? "hide" : "show"} token</button>` : ""}
      <button id="mcp-rotate" class="sm ghost" title="${d.token ? "Disconnects every client until each is given the new token" : "Mint a token"}">${d.token ? "rotate" : "create token"}</button>
      ${d.token ? `<button id="mcp-clear" class="sm danger" title="Leaves only loopback clients able to connect">clear</button>` : ""}
    </div>
    <p class="sub">Acts as ${d.actingAs ? esc(d.actingAs) : "the admin account"} · ${
      d.lastUsed ? `last used ${esc(relTime(d.lastUsed))}` : "never used yet"
    }${
      d.token
        ? ". The token is stored as written — a database backup contains it."
        : ". With no token only a <b>loopback</b> client can connect, which under Docker is nothing outside the container."
    }</p>`);
  body.appendChild(conn);

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
    Crates appear in the gallery under ${d.actingAs ? esc(d.actingAs) : "the admin"}'s account; an agent
    can add to one, never take cards out.</p>`
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
  wire(d);
}

const section = (html) => {
  const el = document.createElement("div");
  el.className = "section";
  el.innerHTML = html;
  return el;
};

// The tool list: one line per tool, under a Read/Write header carrying a count.
//
// A tool's `summary` is NOT rendered, deliberately. It is the first line of the
// tool's `description`, which is written FOR THE MODEL — it teaches an LLM to
// compose a query ("Call this before search_board so your facet filters use the
// board's exact keys and values…"). Printing that in the operator's pane cost
// half the page to say nothing they act on. What an operator reads is the name
// they will see in their client's logs, and the title saying what it is for.
//
// Read and write are GROUPS rather than per-row badges so the saving switch has
// a structural readout: turning it off takes a whole labelled group away, which
// is visible at a glance in a way one row leaving a list of five is not.
const toolGroups = (tools) =>
  [["read", tools.filter((t) => !t.write)], ["write", tools.filter((t) => t.write)]]
    .filter(([, ts]) => ts.length)
    .map(([kind, ts]) => `
      <div class="mcp-group"><span>${kind}</span><span class="n">${ts.length}</span></div>
      ${ts.map((t) => `
        <div class="mcp-t">
          <code>${esc(t.name)}</code>
          <span class="t">${esc(t.title || "")}</span>
          ${t.ui ? `<span class="p-note">grid</span>` : ""}
        </div>`).join("")}`)
    .join("");

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

function wire(d) {
  document.getElementById("mcp-copy")?.addEventListener("click", (e) => copy(command(d), e.target));
  document.getElementById("mcp-show")?.addEventListener("click", () => { shown = !shown; paint(d); });
  document.getElementById("mcp-rotate")?.addEventListener("click", async () => {
    // A rotate is not undoable and takes every connected client down with it,
    // so it asks — the one destructive control on this pane.
    if (d.token && !confirm("Rotate the token? Every connected client stops working until it is given the new one.")) return;
    shown = true; // a token you cannot see is a token you cannot paste
    paint(await api("POST", "/api/admin/mcp/rotate"));
    toast("New token — copy the command again");
  });
  document.getElementById("mcp-clear")?.addEventListener("click", () => {
    if (!confirm("Clear the token? Only a client reaching the server over loopback will connect — under Docker that is nothing outside the container. Every client you have set up will stop working.")) return;
    save({ token: null });
  });
  const origins = document.getElementById("mcp-origins");
  if (origins) origins.onchange = () => save({ origins: origins.value });
}

async function save(patch) {
  try {
    paint(await api("PATCH", "/api/admin/mcp", patch));
  } catch (err) {
    toast.error(err.message);
    load().catch(() => {}); // the switch must not lie about a save that failed
  }
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
