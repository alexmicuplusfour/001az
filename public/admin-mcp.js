// Agents tab: the MCP endpoint's switch, its token, and the command that
// connects a client to it (planning/mcp-stage-1.md §6).
//
// The copy button is why this is a tab rather than three environment
// variables. Everything else here could have lived in a .env — a working
// `claude mcp add` line, with this instance's real address and real token
// already in it, could not.
//
// The tool list is SERVED, not written here: GET /api/admin/mcp returns the
// same specs tools/list hands a client, so a fourth tool appears in this pane
// with no edit to this file. Same stance admin-capabilities.js takes — the
// module renders the vocabulary it is handed and invents none.
import { api, copy } from "./api.js";
import { relTime } from "./utils.js";
import { toast } from "./toast.js";

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

// The line an operator pastes. Quoted for a POSIX shell; the token is the only
// part that varies, and a cleared token drops the header entirely because that
// is exactly the local-no-auth case.
const command = (d) =>
  [
    "claude mcp add --transport http boards \\",
    `  ${d.endpoint}` + (d.token ? " \\" : ""),
    ...(d.token ? [`  --header "Authorization: Bearer ${d.token}"`] : []),
  ].join("\n");

const mask = (t) => (t.length > 10 ? `${t.slice(0, 6)}${"·".repeat(12)}${t.slice(-4)}` : "·".repeat(12));

function paint(d) {
  content.innerHTML = `
    <h2>Agents</h2>
    <p class="sub">Let an AI client — Claude, ChatGPT, Cursor, anything that speaks
    <b>MCP</b> — search this instance's boards. It can read boards and their taxonomies
    and collect what it finds into crates; it cannot change a board, its facets or
    anyone's tags.</p>

    <div class="mcp-checks mcp-switch">
      <label><input type="checkbox" id="mcp-on" ${d.enabled ? "checked" : ""} />
        Accept connections from AI clients</label>
    </div>

    <div id="mcp-body" ${d.enabled ? "" : "hidden"}>
      <h3>Connect a client</h3>
      <pre class="mcp-cmd" id="mcp-cmd">${esc(command(d))}</pre>
      <div class="mcp-actions"><button id="mcp-copy" class="ghost">copy</button></div>

      <h3>Token</h3>
      <div class="mcp-token">
        <code id="mcp-tok">${d.token ? esc(shown ? d.token : mask(d.token)) : "<span class='muted'>none — loopback clients only</span>"}</code>
        ${d.token ? `<button id="mcp-show" class="ghost">${shown ? "hide" : "show"}</button>` : ""}
        <button id="mcp-rotate" class="ghost">${d.token ? "rotate" : "create"}</button>
        ${d.token ? `<button id="mcp-clear" class="ghost">clear</button>` : ""}
      </div>
      <p class="sub">${
        d.token
          ? "Every client needs this. Rotating disconnects all of them until each is given the new one. It is stored as written, so anyone who can read the database or a backup can read it too."
          : "With no token, only a client reaching the server over <b>loopback</b> can connect — which under Docker means nothing outside the container, since a published port arrives from the bridge network. Create one unless you are running the server directly on this machine."
      }</p>

      <p class="sub">Connections act as ${d.actingAs ? esc(d.actingAs) : "the admin account"}${
        d.lastUsed ? ` · last used ${esc(relTime(d.lastUsed))}` : " · never used yet"
      }.</p>

      <h3>Boards an agent can reach</h3>
      <div class="mcp-checks">${d.allBoards
        .map((b) => `<label><input type="checkbox" data-board="${esc(b.id)}" ${b.on ? "checked" : ""} /> ${esc(b.name)}</label>`)
        .join("")}</div>
      <p class="sub">Unticking every box means <b>all of them</b>, not none — an empty
      selection is the absence of a choice, not a rule that hides everything. A board
      added later is reachable by default.</p>

      <h3>Saving</h3>
      <div class="mcp-checks"><label><input type="checkbox" id="mcp-write" ${d.write ? "checked" : ""} />
        Let agents save cards to crates</label></div>
      <p class="sub">Saved sets appear in the <b>crates</b> menu in the gallery, under
      ${d.actingAs ? esc(d.actingAs) : "the admin"}'s account — and that menu only appears
      on a board once it has one. An agent can add to a crate and create new ones; it
      cannot take cards out, rename or delete.</p>

      <h3>What a connected agent can do</h3>
      <table class="mcp-tools">
        <tbody>${d.tools
          .map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.summary)}</td></tr>`)
          .join("")}</tbody>
      </table>
      <p class="sub">Searches also ship an <b>interactive grid</b> — pick cards and save them
      without leaving the conversation. Claude on the web and desktop, VS Code and Goose render
      it; <b>Claude Code does not</b>, and shows the results as text and preview images instead.
      Nothing is lost either way — the grid is an extra, not the answer.</p>

      <details class="mcp-adv">
        <summary>Advanced</summary>
        <label for="mcp-origins">Allowed browser origins</label>
        <input id="mcp-origins" value="${esc(d.origins)}" placeholder="same-origin only" />
        <p class="sub">Comma-separated. Real MCP clients send no origin and are unaffected —
        this only widens which <i>web pages</i> may call the endpoint, and the default (empty)
        is the safe one.</p>
      </details>
    </div>`;

  ensureStyles();

  document.getElementById("mcp-on").onchange = (e) => save({ enabled: e.target.checked });
  // No confirm(). Rotate and clear ask because they break working clients
  // irreversibly; this one changes what the NEXT call may do, and is as
  // reversible as the click that made it.
  const write = document.getElementById("mcp-write");
  if (write) write.onchange = () => save({ write: write.checked });
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
  for (const box of document.querySelectorAll("[data-board]")) {
    box.onchange = () =>
      save({ boards: [...document.querySelectorAll("[data-board]")].filter((b) => b.checked).map((b) => b.dataset.board) });
  }
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

function ensureStyles() {
  if (document.getElementById("mcp-styles")) return;
  const style = document.createElement("style");
  style.id = "mcp-styles";
  style.textContent = `
    .mcp-switch { margin-top: 16px; }
    /* the global input rule is flex:1 + min-width:140px — pin the box down */
    #mcp-body h3 { font-size: 13px; margin: 22px 0 8px; }
    .mcp-cmd { margin: 0; padding: 12px 14px; border: 1px solid #ececef; border-radius: 8px; background: #f7f7f9;
      font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
    .mcp-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
    .mcp-token { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .mcp-token code { font-size: 12px; padding: 6px 10px; border: 1px solid #ececef; border-radius: 8px; background: #f7f7f9; }
    .mcp-tools { font-size: 13px; }
    .mcp-tools td { padding: 5px 14px 5px 0; vertical-align: top; }
    .mcp-tools code { font-size: 12px; }
    /* A wrapped row of checkbox labels. Named for its SHAPE, not its content:
       the board scope list had it first and the saving switch adopted it, and
       a class called .mcp-boards holding a non-board checkbox is how the next
       person ends up writing a second copy of these three lines. */
    .mcp-checks { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; }
    .mcp-checks label { display: inline-flex; gap: 7px; align-items: center; cursor: pointer; }
    .mcp-checks input[type=checkbox] { flex: none; width: auto; min-width: 0; padding: 0; cursor: pointer; }
    .mcp-adv { margin-top: 22px; font-size: 13px; }
    .mcp-adv summary { cursor: pointer; color: #6b6b72; }
    .mcp-adv label { display: block; margin: 12px 0 6px; }
    .mcp-adv input { max-width: 420px; }`;
  document.head.appendChild(style);
}
