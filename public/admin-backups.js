// Backups tab: create/download/upload/delete backup archives, tune the daily
// auto-backup, and restore — which wipes the instance, replaces it with the
// archive, and reboots the server (the overlay walks the admin through it).
import { toast } from "/toast.js";
import { api } from "/api.js";

const content = document.getElementById("backups-content");
let pollTimer = null;
let jobWasRunning = false; // running→done transition = toast once, this page only

const fmtSize = (n) => {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(1) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
};
const fmtWhen = (ms) => new Date(ms).toLocaleString();

export async function renderBackups() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;
  await load();
}

async function load() {
  const data = await api("GET", "/api/admin/backups");
  const j = data.job;
  // Completion feedback is a one-shot toast on the transition we watched, so a
  // later page load doesn't re-announce an old job. Restores are announced by
  // the overlay flow, not here.
  if (jobWasRunning && j?.done && j.kind !== "restore") {
    if (j.error) toast.error(`Backup failed: ${j.error}`);
    else if (j.result?.name) toast(`Backup ${j.result.name} (${fmtSize(j.result.size)}) complete`);
  }
  jobWasRunning = !!(j && !j.done);
  paint(data);
  // While a job runs, keep the tab live; stop once it settles.
  clearTimeout(pollTimer);
  if (jobWasRunning) pollTimer = setTimeout(() => load().catch(() => {}), 1000);
}

function paint({ backups, job, settings }) {
  content.innerHTML = `
    <h2>Backups</h2>
    <p class="sub">A <b>full backup</b> is one portable .tar — database, originals, thumbnails, and installed
    plugins — restorable here (or on a fresh instance) even after the app has been upgraded.
    A <b>database backup</b> skips the files; the nightly automatic backup uses it as a safety net.
    Archives contain your AI/provider keys and source credentials — treat downloads like the database itself.</p>

    <div class="bk-actions">
      <button id="bk-full">Back up now</button>
      <button id="bk-db" class="ghost">Database only</button>
      <label class="ghost bk-upload-btn" for="bk-upload">Upload archive…</label>
      <input id="bk-upload" type="file" accept=".tar" hidden />
    </div>

    <div class="bk-auto">
      <label><input type="checkbox" id="bk-auto" ${settings.auto ? "checked" : ""} />
        Automatic nightly database backup</label>
      at <input id="bk-at" type="time" value="${settings.at}" ${settings.auto ? "" : "disabled"} />
      keeping the last <input id="bk-keep" type="number" min="1" max="100" value="${settings.keep}" ${settings.auto ? "" : "disabled"} />
      <span class="sub-inline">Written into the backups folder on the data volume — back that volume up off-site.</span>
    </div>

    <div id="bk-job"></div>

    <table class="bk-table">
      <thead><tr><th>Archive</th><th>Kind</th><th>Created</th><th>Size</th><th></th></tr></thead>
      <tbody id="bk-rows"></tbody>
    </table>
    <p id="bk-empty" class="sub" hidden>No backups yet.</p>`;

  ensureStyles();
  paintJob(job);

  const rows = document.getElementById("bk-rows");
  document.getElementById("bk-empty").hidden = backups.length > 0;
  for (const b of backups) {
    const tr = document.createElement("tr");
    const kind = b.kind
      ? `<span class="badge">${b.kind}${b.auto ? " · auto" : ""}</span>`
      : "—"; // renamed archive — the manifest inside still knows, restore reads it
    tr.innerHTML = `
      <td class="bk-name">${b.name}</td>
      <td>${kind}</td>
      <td>${fmtWhen(b.mtime)}</td>
      <td>${fmtSize(b.size)}</td>
      <td><div class="row-actions-wrap"></div></td>`;
    const act = tr.querySelector(".row-actions-wrap");

    const dl = document.createElement("button");
    dl.className = "ghost";
    dl.textContent = "download";
    // A real button so it inherits the app's button metrics; navigation to a
    // Content-Disposition: attachment response downloads without unloading.
    dl.onclick = () => { location.href = `/api/admin/backups/${encodeURIComponent(b.name)}/download`; };
    act.appendChild(dl);

    const restore = document.createElement("button");
    restore.className = "danger";
    restore.textContent = "restore";
    restore.onclick = () => startRestore(b);
    act.appendChild(restore);

    const del = document.createElement("button");
    del.className = "ghost";
    del.textContent = "delete";
    del.onclick = async () => {
      if (!confirm(`Delete backup ${b.name}?`)) return;
      try {
        await api("DELETE", `/api/admin/backups/${encodeURIComponent(b.name)}`);
        load();
      } catch (err) {
        toast.error(err.message);
      }
    };
    act.appendChild(del);
    rows.appendChild(tr);
  }

  const busy = job && !job.done;
  const start = (kind) => async () => {
    try {
      await api("POST", "/api/admin/backups", { kind });
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };
  const fullBtn = document.getElementById("bk-full");
  const dbBtn = document.getElementById("bk-db");
  fullBtn.disabled = dbBtn.disabled = busy;
  fullBtn.onclick = start("full");
  dbBtn.onclick = start("db");

  document.getElementById("bk-upload").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    toast(`Uploading ${file.name}…`);
    try {
      const r = await fetch("/api/admin/backups/upload", { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      toast(`Uploaded — ready to restore`);
      load();
    } catch (err) {
      toast.error(String(err.message || err));
    }
    e.target.value = "";
  };

  const saveAuto = async () => {
    try {
      await api("POST", "/api/admin/backups/settings", {
        auto: document.getElementById("bk-auto").checked,
        at: document.getElementById("bk-at").value || "03:30",
        keep: Number(document.getElementById("bk-keep").value) || 7,
      });
      load();
    } catch (err) {
      toast.error(err.message);
    }
  };
  document.getElementById("bk-auto").onchange = saveAuto;
  document.getElementById("bk-at").onchange = saveAuto;
  document.getElementById("bk-keep").onchange = saveAuto;
}

// Only live progress belongs here — completions announce themselves as a
// toast (see load) rather than parking a banner on the page forever.
function paintJob(job) {
  const el = document.getElementById("bk-job");
  if (!el) return;
  el.innerHTML = job && !job.done
    ? `<div class="bk-banner">${job.kind === "restore" ? "Restoring" : "Backing up"}…
      <span class="bk-phase">${job.phase}${job.detail ? " — " + job.detail : ""}</span></div>`
    : "";
}

// --- restore -----------------------------------------------------------------

async function startRestore(b) {
  const typed = prompt(
    `Restore "${b.name}"?\n\nThis REPLACES the entire instance — every board, item, member, ` +
    `setting${b.kind === "full" ? ", and all files on disk" : ""} — with the archive's contents, ` +
    `then restarts the server.${b.kind !== "db"
      ? " Plugins inside the archive run as part of the app after the reboot — only restore archives you trust."
      : ""} Everyone (including you) is signed out; sign back in with your password, or with a ` +
    `minted login link (server/mintlink.js) if the archive is from another instance.\n\n` +
    `A database-only safety backup of the current state is taken first (prerestore-…).\n\n` +
    `Type RESTORE to continue.`
  );
  if (typed === null) return;
  if (typed !== "RESTORE") {
    toast.error('Restore cancelled — you must type "RESTORE" exactly');
    return;
  }
  try {
    await api("POST", `/api/admin/backups/${encodeURIComponent(b.name)}/restore`, { confirm: "RESTORE" });
  } catch (err) {
    toast.error(err.message);
    return;
  }
  watchRestore();
}

function watchRestore() {
  clearTimeout(pollTimer);
  const overlay = document.createElement("div");
  overlay.className = "bk-overlay";
  overlay.innerHTML = `<div class="bk-overlay-card">
    <h3>Restoring…</h3>
    <p id="bk-restore-phase">starting</p>
    <p class="sub">Do not close this page. The server restarts when the restore
    finishes; you'll be sent to the login page. (Running the server by hand,
    without a supervisor? Start it again yourself and this page will follow.)</p>
  </div>`;
  document.body.appendChild(overlay);
  const phaseEl = overlay.querySelector("#bk-restore-phase");

  let sawJob = false;
  const back = () => location.replace("/login.html?next=" + encodeURIComponent("/admin.html#backups"));

  const pollHealth = async () => {
    try {
      const r = await fetch("/api/health");
      if (r.ok) return back();
    } catch { /* still down */ }
    setTimeout(pollHealth, 2000);
  };

  const poll = async () => {
    try {
      const r = await fetch("/api/admin/backups/status");
      if (!r.ok) throw new Error(String(r.status));
      const { job } = await r.json();
      if (job) {
        sawJob = true;
        phaseEl.textContent = job.phase + (job.detail ? " — " + job.detail : "");
        if (job.done && job.error) {
          overlay.remove();
          toast.error(`Restore failed: ${job.error}`);
          load().catch(() => {});
          return;
        }
        if (job.done) {
          phaseEl.textContent = "restore complete — server restarting";
          setTimeout(pollHealth, 2000);
          return;
        }
      }
      setTimeout(poll, 1000);
    } catch {
      // The server is rebooting on the restored data (or the gate dropped us).
      phaseEl.textContent = sawJob ? "server restarting" : "waiting for the server";
      setTimeout(pollHealth, 2000);
    }
  };
  poll();
}

// Styles are scoped here (admin.html keeps per-tab styles inline; this tab
// injects its own once, same net effect).
function ensureStyles() {
  if (document.getElementById("bk-styles")) return;
  const style = document.createElement("style");
  style.id = "bk-styles";
  style.textContent = `
    .bk-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 16px; }
    .bk-upload-btn { display: inline-flex; align-items: center; border: 1px dashed #cfcfd6; border-radius: 8px;
      padding: 7px 14px; cursor: pointer; font-size: 13px; color: #444; background: #fff; }
    .bk-upload-btn:hover { border-color: #111; color: #111; }
    .bk-auto { margin-top: 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; }
    .bk-auto label { display: inline-flex; gap: 7px; align-items: center; cursor: pointer; }
    /* the global input rule is flex:1 + min-width:140px — pin these down */
    .bk-auto input[type=checkbox] { flex: none; width: auto; min-width: 0; padding: 0; cursor: pointer; }
    .bk-auto input[type=time] { flex: none; width: 140px; min-width: 0; }
    .bk-auto input[type=number] { flex: none; width: 70px; min-width: 0; }
    .bk-auto .sub-inline { color: #9aa0aa; font-size: 12px; flex-basis: 100%; }
    .bk-banner { margin-top: 14px; padding: 10px 12px; border: 1px solid #ececef; border-radius: 8px;
      font-size: 13px; background: #f7f7f9; }
    .bk-phase { color: #6b6b72; }
    .bk-table { margin-top: 14px; }
    .bk-name { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
    .bk-overlay { position: fixed; inset: 0; background: rgba(10,10,24,.55); z-index: 1000;
      display: flex; align-items: center; justify-content: center; }
    .bk-overlay-card { background: #fff; border-radius: 12px; padding: 26px 30px; max-width: 420px;
      box-shadow: 0 12px 40px rgba(0,0,0,.25); }
    .bk-overlay-card h3 { margin: 0 0 8px; }
    .bk-overlay-card p { margin: 6px 0; font-size: 14px; }`;
  document.head.appendChild(style);
}
