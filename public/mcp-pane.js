// The two blocks the admin tab and the account page render IDENTICALLY: the
// connection — one command and the controls that mint, reveal and revoke it —
// and the tool table (planning/mcp-members-plan.md §10.10).
//
// Extracted rather than copied. The rest of each pane genuinely differs (the
// admin sets the instance; a member reads their own access), but these two are
// the same thing about the same token, and a second copy of either is the drift
// that makes one of them start lying.
//
// Nothing here looks anything up. admin-mcp.js used to hold `document
// .getElementById("mcp-content")` at module scope, which is exactly what made
// it unreusable — a component takes its container and its callbacks.
import { copy } from "./api.js";
import { relTime, esc } from "./utils.js";
import { toast } from "./toast.js";

// Masked until asked for, per page rather than per render — a repaint after a
// rotate must not re-hide a token the reader just revealed.
let shown = false;

const mask = (t) => (t.length > 10 ? `${t.slice(0, 6)}${"·".repeat(12)}${t.slice(-4)}` : "·".repeat(12));

// The line someone pastes. Quoted for a POSIX shell; the token is the only part
// that varies.
//
// With NO token there is no command to give. There used to be one — the
// endpoint by itself, for a client on the server's own machine — and that path
// is gone (§4), so a header-less line would hand over something that cannot
// connect. The pane says what to do instead, and the button beside it does it.
export const command = (d, masked = false) =>
  d.token
    ? [
        "claude mcp add --transport http boards \\",
        `  ${d.endpoint} \\`,
        `  --header "Authorization: Bearer ${masked ? mask(d.token) : d.token}"`,
      ].join("\n")
    : "Create a token to get the command that connects your client.";

// One line per tool, under a read/write header carrying a count.
//
// A tool's `summary` is NOT rendered, deliberately. It is the first line of the
// tool's `description`, which is written FOR THE MODEL — it teaches an LLM to
// compose a query. Printing that here cost half the page to say nothing the
// reader acts on. What they want is the name their client will log, and the
// title saying what it is for.
//
// Read and write are GROUPS rather than per-row badges so the saving switch has
// a structural readout: turning it off takes a whole labelled group away, which
// is visible at a glance in a way one row leaving a list of five is not.
export const toolGroups = (tools) =>
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

// The Connection section, wired. `onRotate` and `onClear` do the write and hand
// back the new state; `repaint` is how the page redraws itself around it, which
// is the same thing both callers already do after any other write.
//
// `trailer` is whatever that page wants under the command — the admin says the
// token is in its backups, the account page says what a member's reaches.
export function connectionSection(d, { onRotate, onClear, repaint, trailer = "" }) {
  const el = document.createElement("div");
  el.className = "section";
  el.innerHTML = `<h2>Connection</h2>
    <pre class="mcp-cmd" id="mcp-cmd">${esc(command(d, !shown))}</pre>
    <div class="mcp-cmd-actions">
      ${d.token ? `<button id="mcp-copy" class="sm">copy</button>` : ""}
      <span class="gap"></span>
      ${d.token ? `<button id="mcp-show" class="sm ghost">${shown ? "hide" : "show"} token</button>` : ""}
      <button id="mcp-rotate" class="sm ghost" title="${d.token ? "Disconnects every client until each is given the new token" : "Mint a token"}">${d.token ? "rotate" : "create token"}</button>
      ${d.token ? `<button id="mcp-clear" class="sm danger" title="Your clients stop working until you create a new one">clear</button>` : ""}
    </div>
    <p class="sub">Yours, acting as ${esc(d.actingAs)} · ${
      d.lastUsed ? `last used ${esc(relTime(d.lastUsed))}` : "never used yet"
    }${trailer}</p>`;

  el.querySelector("#mcp-copy")?.addEventListener("click", (e) => copy(command(d), e.target));
  el.querySelector("#mcp-show")?.addEventListener("click", () => { shown = !shown; repaint(d); });

  el.querySelector("#mcp-rotate")?.addEventListener("click", async () => {
    // A rotate is not undoable and takes every connected client down with it,
    // so it asks — the one destructive control on this pane.
    if (d.token && !confirm("Rotate the token? Every connected client stops working until it is given the new one.")) return;
    shown = true; // a token you cannot see is a token you cannot paste
    repaint(await onRotate());
    // Blue, not the default dark: a rotate is a consequence, not a
    // confirmation. Said here rather than loaded into the confirm above,
    // because a dialog that grows a paragraph is a dialog nobody reads.
    toast.info(d.token
      ? "New token — your connected clients stop working until each is given it"
      : "Token created — copy the command into your client");
  });

  el.querySelector("#mcp-clear")?.addEventListener("click", async () => {
    if (!confirm("Clear your token? Every client you have set up stops working until you create a new one. Nobody else's is affected.")) return;
    repaint(await onClear());
  });

  return el;
}
