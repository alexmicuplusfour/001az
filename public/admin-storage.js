// Storage tab: how full the server is and why. Rendered on SELECT, not at
// boot (admin.js) — the GET measures the filesystem live, so opening the tab
// IS the sample and the figures are never yesterday's.
//
// Three answers, deliberately kept apart: the disk gauge (am I about to run
// out), the stores table (what's eating it, and which of it is prunable), and
// the boards table (who holds the originals). The stores are DISK TRUTH from
// a walk; the boards are ATTRIBUTION of the sizes upload stamped on file
// entries — thumbnails, sidecars and embeddings belong to no cheap per-board
// sum, so the two will not add up, and the boards section says so in words
// instead of massaging them into one figure (the Usage tab's deal-sentence
// move). Store labels arrive on the wire (storage.js STORE_DEFS): this module
// renders the vocabulary it is handed and invents none — an id the map
// doesn't know shows as itself, never dropped.
import { api } from "/api.js";
import { kpi, fmtSize, fmtQty } from "/utils.js";
import { sparkline } from "/sparkline.js";

const storageContent = document.getElementById("storage-content");

// One render at a time. Re-opening the tab SHOULD re-measure — that is the
// contract — but two overlapping opens would walk the filesystem twice and
// let whichever finished last paint, which can be the older measurement.
let inFlight = null;

// No /api/me guard, unlike the sibling tabs: they render once at boot, where
// the guard stops an admin request firing for a non-admin. This one renders
// on every tab select, and by then the shell has already proven admin (the
// members render is what unhides the tab rail at all) — so the guard would be
// a per-click round trip to re-answer a settled question. The route is
// requireAdmin regardless, and admin.js swallows the rejection.
export function renderStorage() {
  return inFlight ??= draw().finally(() => { inFlight = null; });
}

async function draw() {
  const { now, series, boards, stores } = await api("GET", "/api/admin/storage");

  const by = Object.fromEntries(now.map((r) => [r.store, r]));
  // Every classification below is the SERVER's (STORE_DEFS): which rows are
  // the disk pair rather than something held, what a store is called, and
  // which are safe to delete. This module knows no store ids.
  const held = now.filter((r) => !stores[r.store]?.disk);
  const total = by.disk_total?.bytes || 0;
  const free = by.disk_free?.bytes || 0;
  const used = total - free;

  const head = document.createElement("div");
  head.className = "section";
  head.innerHTML = `<h2>Storage</h2>
    <p class="sub">What the server holds and how much room is left — measured now, each time this tab opens.</p>
    <div class="kpi-row">
      ${kpi(fmtSize(used), "disk used", total ? `${Math.round((used / total) * 100)}% of ${fmtSize(total)}` : "")}
      ${kpi(fmtSize(free), "disk free")}
      ${kpi(fmtSize(held.reduce((t, r) => t + r.bytes, 0)), "app holdings", "everything in the stores table — the disk also carries the OS and whatever else lives on it")}
    </div>`;

  // --- the stores: disk truth, biggest eater first ---
  const spark = (id) => sparkline(series.filter((s) => s.store === id), {
    count: 30,
    value: (r) => r.bytes,
    title: (day, r) => (r ? `${day} — ${fmtSize(r.bytes)}` : `${day} — not sampled`),
  });
  const storeRows = held.sort((a, b) => b.bytes - a.bytes).map((r) => {
    const d = stores[r.store] || {};
    return `<tr>
      <td>${d.label ?? r.store}${d.prunable ? ` <span class="muted store-note">— prunable; ${d.prunable}</span>` : ""}</td>
      <td>${fmtSize(r.bytes)}</td>
      <td>${r.files == null ? '<span class="muted">—</span>' : fmtQty(r.files, "count")}</td>
      <td>${spark(r.store)}</td>
    </tr>`;
  }).join("");
  const storesSec = document.createElement("div");
  storesSec.className = "section";
  storesSec.innerHTML = `<h2>Stores</h2>
    <table><thead><tr><th>store</th><th>held</th><th>files</th><th>30 days</th></tr></thead>
    <tbody>${storeRows}</tbody></table>`;

  // --- the boards: attribution of originals, whale first (the route's order) ---
  const boardRows = boards.map((b) => `<tr>
    <td>${b.label}</td>
    <td>${fmtSize(b.bytes)}</td>
    <td>${fmtQty(b.files, "count")}${b.unsized ? ` <span class="muted">(${fmtQty(b.unsized, "count")} without recorded sizes)</span>` : ""}</td>
  </tr>`).join("");
  const boardsSec = document.createElement("div");
  boardsSec.className = "section";
  boardsSec.innerHTML = `<h2>Boards</h2>
    <p class="sub">Originals only, from the sizes recorded at upload — thumbnails, sidecars and
    embeddings live in the stores above and belong to no board, so these figures and the
    stores table don't add up, by design.</p>
    ${boards.length
      ? `<table><thead><tr><th>board</th><th>originals</th><th>files</th></tr></thead><tbody>${boardRows}</tbody></table>`
      : '<p class="muted">No files on any board yet.</p>'}`;

  storageContent.replaceChildren(head, storesSec, boardsSec);
}
