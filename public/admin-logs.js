// Logs tab: the live server-log stream embedded in the admin shell. The SSE
// connection follows tab visibility — connect when the tab is shown, close
// when it's left — which stays cheap and loses nothing: the server replays
// its in-memory backlog on every connect (same reason onopen clears the pane
// before the replay lands, so auto-reconnects don't duplicate rows). The
// expand button lifts the console over the whole page; Escape drops it back.
const content = document.getElementById("logs-content");
const MAX_ROWS = 2000;

let es = null;
let active = false; // tab selection state, set before or after build resolves
let viewer, lines, status, dot, follow, expandBtn;

const ICON_EXPAND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
const ICON_COLLAPSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;

export async function renderLogs() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;
  build();
  sync();
}

// Called by the tab switcher on every selection, possibly before renderLogs
// has built the DOM — sync() runs from both sides.
export function setLogsActive(on) {
  active = on;
  sync();
}

function sync() {
  if (!viewer) return;
  if (active && !es) connect();
  if (!active && es) {
    es.close();
    es = null;
    status.textContent = "paused";
    dot.className = "log-dot";
    setFullbleed(false);
  }
}

function build() {
  content.innerHTML = `
    <div class="log-viewer">
      <div class="log-head">
        <span class="log-dot" id="log-dot"></span>
        <span class="log-status" id="log-status">connecting…</span>
        <span class="log-spacer"></span>
        <label><input type="checkbox" id="log-follow" checked /> follow</label>
        <button id="log-clear">clear</button>
        <button id="log-expand" class="log-icon-btn" title="Expand">${ICON_EXPAND}</button>
      </div>
      <div class="log-lines" id="log-lines"></div>
    </div>`;
  viewer = content.querySelector(".log-viewer");
  lines = document.getElementById("log-lines");
  status = document.getElementById("log-status");
  dot = document.getElementById("log-dot");
  follow = document.getElementById("log-follow");
  expandBtn = document.getElementById("log-expand");

  document.getElementById("log-clear").onclick = () => lines.replaceChildren();
  expandBtn.onclick = () => setFullbleed(!viewer.classList.contains("fullbleed"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && viewer.classList.contains("fullbleed")) setFullbleed(false);
  });
}

function setFullbleed(on) {
  viewer.classList.toggle("fullbleed", on);
  expandBtn.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND;
  expandBtn.title = on ? "Collapse (Esc)" : "Expand";
  // The pane just changed height under the scroll position — re-stick.
  if (follow.checked) lines.scrollTop = lines.scrollHeight;
}

function atBottom() {
  return lines.scrollHeight - lines.scrollTop - lines.clientHeight < 40;
}

function append(line) {
  const sp = line.indexOf(" ");
  const ts = line.slice(0, sp);
  const rest = line.slice(sp + 1);
  const sp2 = rest.indexOf(" ");
  const lvl = rest.slice(0, sp2);
  const msg = rest.slice(sp2 + 1);

  const row = document.createElement("div");
  row.className = "log-row " + (lvl === "WARN" || lvl === "ERROR" ? lvl : "");
  const t = document.createElement("span");
  t.className = "log-ts";
  t.textContent = ts.replace("T", " ").replace("Z", "");
  const l = document.createElement("span");
  l.className = "log-lvl " + lvl;
  l.textContent = lvl;
  const m = document.createElement("span");
  m.textContent = msg;
  row.append(t, l, m);

  const stick = follow.checked && atBottom();
  lines.appendChild(row);
  while (lines.childElementCount > MAX_ROWS) lines.removeChild(lines.firstChild);
  if (stick) lines.scrollTop = lines.scrollHeight;
}

function connect() {
  es = new EventSource("/api/logs/stream");
  es.onopen = () => {
    lines.replaceChildren(); // the server replays its backlog on each connect
    status.textContent = "live";
    dot.className = "log-dot on";
  };
  es.onmessage = (e) => {
    try {
      append(JSON.parse(e.data));
    } catch {}
  };
  es.onerror = () => {
    status.textContent = "reconnecting…";
    dot.className = "log-dot off";
    // EventSource auto-reconnects; no manual retry needed
  };
}
