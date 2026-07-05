// Live server-log viewer (logs.html). Streams /api/logs/stream over SSE and
// renders each line; externalized from an inline <script> so the page works
// under a strict script-src 'self' CSP.
const elLog = document.getElementById("log");
const elStatus = document.getElementById("status");
const elDot = document.getElementById("dot");
const elFollow = document.getElementById("follow");
const MAX_ROWS = 2000;

document.getElementById("clear").addEventListener("click", () => elLog.replaceChildren());

function atBottom() {
  return elLog.scrollHeight - elLog.scrollTop - elLog.clientHeight < 40;
}

function append(line) {
  const sp = line.indexOf(" ");
  const ts = line.slice(0, sp);
  const rest = line.slice(sp + 1);
  const sp2 = rest.indexOf(" ");
  const lvl = rest.slice(0, sp2);
  const msg = rest.slice(sp2 + 1);

  const row = document.createElement("div");
  row.className = "row " + (lvl === "WARN" || lvl === "ERROR" ? lvl : "");
  const t = document.createElement("span");
  t.className = "ts";
  t.textContent = ts.replace("T", " ").replace("Z", "");
  const l = document.createElement("span");
  l.className = "lvl " + lvl;
  l.textContent = lvl;
  const m = document.createElement("span");
  m.textContent = msg;
  row.append(t, l, m);

  const stick = elFollow.checked && atBottom();
  elLog.appendChild(row);
  while (elLog.childElementCount > MAX_ROWS) elLog.removeChild(elLog.firstChild);
  if (stick) elLog.scrollTop = elLog.scrollHeight;
}

function connect() {
  const es = new EventSource("/api/logs/stream");
  es.onopen = () => {
    elStatus.textContent = "live";
    elDot.className = "dot on";
  };
  es.onmessage = (e) => {
    try {
      append(JSON.parse(e.data));
    } catch {}
  };
  es.onerror = () => {
    elStatus.textContent = "reconnecting…";
    elDot.className = "dot off";
    // EventSource auto-reconnects; no manual retry needed
  };
}
connect();
