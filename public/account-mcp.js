// Account → MCP: one member's own agent connection
// (planning/mcp-members-plan.md §10.13).
//
// The mirror of the admin tab, and deliberately the smaller half. The admin
// sets what the INSTANCE allows — whether the feature is on, which boards any
// agent may reach, whether saving is permitted. Everything here is one person's:
// their token, the boards their token reaches, and what their client will find.
//
// The two blocks that ARE the same on both pages — the command and the tool
// table — come from mcp-pane.js rather than being written twice.
import { api } from "./api.js";
import { connectionSection, toolGroups } from "./mcp-pane.js";
import { esc } from "./utils.js";

const content = document.getElementById("mcp-content");

export async function renderAccountMcp() {
  paint(await api("GET", "/api/account/mcp"));
}

const section = (html) => {
  const el = document.createElement("div");
  el.className = "section";
  el.innerHTML = html;
  return el;
};

function paint(d) {
  const secs = document.createDocumentFragment();

  secs.appendChild(section(`<h2>MCP</h2>
    <p class="sub">Connect an AI client — Claude, ChatGPT, Cursor, anything that speaks the
    Model Context Protocol — to the boards you can see. It searches and reads; it cannot
    change a board, its facets or anyone's tags.</p>`));

  // Switched off for the whole instance is not this page's to fix, so it says
  // so and stops. Showing a create-token button that mints something which
  // cannot connect would be the pane lying about what it can do for you.
  if (!d.enabled) {
    secs.appendChild(section(`<p class="sub">MCP is switched off on this instance.
      An admin can turn it on under <b>Admin → MCP</b>.</p>`));
    content.replaceChildren(secs);
    return;
  }

  secs.appendChild(
    connectionSection(d, {
      onRotate: () => api("POST", "/api/account/mcp/token"),
      onClear: () => api("DELETE", "/api/account/mcp/token"),
      repaint: paint,
      trailer: ". The token is stored as written — a database backup contains it.",
    })
  );

  // What this token actually reaches, from the same function the tools call, so
  // the page cannot promise access the agent is then refused. A member of
  // nothing is told BEFORE they paste anything anywhere.
  const boards = section(`<h2>Boards</h2>`);
  boards.insertAdjacentHTML(
    "beforeend",
    d.boards.length
      ? `<div class="mcp-boards">${d.boards.map((b) => `<span>${esc(b.name)}</span>`).join("")}</div>
         <p class="sub mcp-after-list">The boards you are a member of, minus any an admin has
         kept out of reach. Being added to a board is enough — your client sees it on its
         next call, with nothing to reconnect.</p>`
      : `<div class="mcp-boards none">You are not a member of any board an agent can reach.</div>
         <p class="sub mcp-after-list">A token would connect and find nothing. An admin adds
         members to boards under <b>Admin → Members</b>.</p>`
  );
  secs.appendChild(boards);

  secs.appendChild(section(`<h2>Tools</h2>
    <div class="mcp-tools">${toolGroups(d.tools)}</div>
    <p class="sub mcp-after-list">${
      d.write
        ? `Saving is on: your client can keep what it finds in a crate, which appears in
           your gallery under your own account. It can add to one, never take cards out.`
        : `Saving is off on this instance, so your client can search and read but not keep
           anything — an admin sets that under <b>Admin → MCP</b>.`
    }</p>`));

  content.replaceChildren(secs);
}
