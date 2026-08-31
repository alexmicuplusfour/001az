// Usage tab: where the spend goes — headline figures, a per-day chart, and a
// breakdown along every dimension the meter records, over a picked window.
//
// Everything named here arrived on the wire. /api/usage is self-describing
// (metering-plan.md Stage 4a): units come with labels and format kinds, the
// dimension list comes from the same table the server validates against, and
// every grouped id comes with its display name — so this module renders the
// vocabulary it is handed and invents none. Note the breakdown tables draw ONE
// COLUMN PER UNIT IN THE RESPONSE: a Stage 5 unit (audio seconds, bytes)
// lands as a labelled column with no edit here, instead of hiding inside the
// ≈$ the way a hand-picked column list would leave it.
//
// What the module DOES own is arithmetic the server never shipped: sums
// within a unit, cost across everything, and the strip's two ratios — client
// math on named buckets, the same contract the gallery's token chip
// established. Self-guards on /api/me, so it no-ops for non-admins.
import { api } from "/api.js";
import { toast } from "/toast.js";
import { busy } from "/plugin-modal.js";
import { fillSelect } from "/select.js";
import { pill, tokPair, fmtTok, fmtUsd, fmtCost, fmtUnpriced, fmtQty, relTime } from "/utils.js";
import { sparkline, dayKey } from "/sparkline.js";

const usageContent = document.getElementById("usage-content");

// `days: null` is all time, sent as an explicit epoch floor: the route's
// 30-day default is what an ABSENT from= means there (a default, not a law),
// so asking for everything is saying so, not saying nothing.
const WINDOWS = [
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "All time", days: null },
];
let winDays = 30; // the server's own default window, so the first paint matches it

// The Prices section is one element, filled by loadPrices and re-attached by
// every draw(): rates aren't windowed, so a window click must not refetch them.
const pricesSec = Object.assign(document.createElement("div"), { className: "section" });

export async function renderUsage() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;
  loadPrices();
  await draw();
}

async function draw() {
  const from = winDays ? dayKey(Date.now() - (winDays - 1) * 86400000) : "0001-01-01";
  const get = (group) => api("GET", `/api/usage?from=${from}&group=${group}`);
  // Four reads, one window: the chart's day series (the strip SUMS it — an
  // ungrouped fifth read would fetch the same numbers pre-folded) and one per
  // breakdown. Each answer carries the vocabulary its own table renders.
  let byDay, byModel, byBoard, byCap;
  try {
    [byDay, byModel, byBoard, byCap] = await Promise.all([
      get("day"), get("provider,model"), get("board"), get("capability"),
    ]);
  } catch { return; }

  const head = document.createElement("div");
  head.className = "section";
  head.innerHTML = `<h2>Usage</h2>
    <p class="sub">Every metered call across the app, priced at the rates known when each one ran.</p>`;

  const pills = document.createElement("div");
  pills.className = "pill-row";
  for (const w of WINDOWS) {
    pills.appendChild(pill(w.label, null, w.days === winDays, false, () => {
      if (w.days !== winDays) { winDays = w.days; draw(); }
    }));
  }
  head.appendChild(pills);

  if (!byDay.rows.length) {
    head.insertAdjacentHTML("beforeend", '<p class="muted" style="margin-top:22px">No metered usage in this window.</p>');
    // Rates still show on an empty window — seeding prices BEFORE spending is
    // exactly when the editor matters most.
    usageContent.replaceChildren(head, pricesSec);
    return;
  }

  // --- the headline strip, summed from the day series ---
  const defs = defsOf(byDay);
  const totals = foldUnits(byDay.rows);
  const cost = costOf(totals, defs);
  const qty = (unit) => totals[unit]?.quantity || 0;
  const inQ = qty("input_tokens"), outQ = qty("output_tokens"), cacheQ = qty("cache_read_tokens");

  const kpis = [];
  kpis.push(kpi(cost ? fmtCost(cost) : "—", "spend",
    cost?.unpriced?.length ? `not in the $ figure: ${fmtUnpriced(cost.unpriced)}`
    : cost ? "" : "no rate was known for any call in this window"));
  // The two call families, side by side and NEVER summed. They are separate
  // units for exactly that reason, so keeping them apart costs a second call
  // rather than a filter — nothing downstream has to remember the distinction.
  // Both names are the SERVED ones: any unit with a quantity is in `defs` by
  // construction (the response's `units` is built from the units its own rows
  // used), so a fallback string here could never render — and the one written
  // first said "requests" where the server says "calls". The titles carry the
  // distinction the two labels can't, since an AI call is an API call too.
  const countKpi = (unit, title) => {
    const q = totals[unit]?.quantity;
    if (q) kpis.push(kpi(fmtQty(q, defs[unit].format), defs[unit].label, title));
  };
  countKpi("requests", "calls to an AI model that answered");
  countKpi("api_requests", "requests sent to a data provider — retried and refused ones included, because a quota charges for those too");
  if (inQ || outQ) kpis.push(kpi(tokPair(inQ, outQ), "tokens"));
  // The two ratios show only when their inputs exist — absence, not 0%.
  if (cacheQ) {
    const d = defs.cache_read_tokens;
    kpis.push(kpi(`${Math.round((cacheQ / (inQ + cacheQ)) * 100)}%`, "cache hit rate",
      `${fmtQty(cacheQ, d?.format)} ${d?.label ?? "cache reads"} vs ${fmtTok(inQ)} billed input`));
  }
  if (cost && inQ + outQ > 0) {
    // micros ÷ tokens IS dollars per million tokens (micros-per-unit ≡ $/M).
    // Inherits the ≈ whenever the spend it divides wears one.
    kpis.push(kpi(`${cost.unpriced?.length ? "≈" : ""}${fmtUsd(cost.micros / (inQ + outQ))}`,
      "blended $ / M tokens", "total spend ÷ total input+output tokens"));
  }
  const strip = document.createElement("div");
  strip.className = "usage-kpis";
  strip.innerHTML = kpis.join("");
  head.appendChild(strip);

  // --- the day chart: the shared day-bars component, at chart size ---
  const chartCount = Math.min(winDays ?? 90, 90);
  const chart = sparkline(byDay.rows, {
    count: chartCount,
    value: (d) => d.units.input_tokens?.quantity || 0,
    title: (day, d) => {
      if (!d) return `${day} — no usage`;
      const c = costOf(d.units, defs);
      // Tokens get the compact pair; everything else the day actually spent
      // names itself. Recorded rather than restated — the three ids this used
      // to list by hand meant a day of pure transcription, detection or
      // connector traffic drew an empty bar (height is input_tokens) under a
      // tooltip that mentioned nothing at all. The breakdown table below
      // already loops the served units; this is the same rule.
      const said = new Set(["input_tokens", "output_tokens"]);
      const tokens = tokPair(d.units.input_tokens?.quantity || 0, d.units.output_tokens?.quantity || 0);
      const parts = [
        tokens,
        ...Object.keys(d.units).filter((u) => !said.has(u)).sort().map((u) => named(d.units, defs, u)),
        c ? fmtCost(c) : "",
      ].filter(Boolean);
      return `${day} — ${parts.join(", ")}`;
    },
    height: 48,
    barWidth: chartCount > 40 ? 4 : 9,
  });
  const chartSec = document.createElement("div");
  chartSec.className = "section";
  chartSec.innerHTML = `<h2>${byDay.dims.day.label}</h2>
    <p class="sub">Bar height is billable input tokens — hover a day for the rest.${winDays ? "" : " The chart shows the last 90 days; the tables below cover everything."}</p>
    ${chart || '<span class="muted">No token usage to chart in this window.</span>'}`;

  usageContent.replaceChildren(
    head,
    chartSec,
    breakdown(byModel, "model", (r, dims) =>
      [dims.provider.values[r.provider], dims.model.values[r.model]].filter(Boolean).join(" · ")
        || '<span class="muted">—</span>'),
    breakdown(byBoard, "board", (r, dims) => r.board
      // The admin boards table's link, so "which board is this" is one click —
      // and the drill-down: #jobs opens the board's own jobs modal (app.js),
      // where each row carries what it spent. No admin job viewer to keep.
      ? `<a href="/?board=${r.board}" target="_blank" style="color:inherit;text-decoration:none">${dims.board.values[r.board]}</a>`
        + `<a class="muted" href="/?board=${r.board}#jobs" target="_blank" style="margin-left:9px;font-size:12px">jobs</a>`
      // '' is the app scope — a value, named by the server, linking nowhere.
      : `<span class="muted">${dims.board.values[r.board]}</span>`),
    breakdown(byCap, "capability", (r, dims) => dims.capability.values[r.capability]),
    pricesSec,
  );
}

// One breakdown table: a row per value of the dimension, a column per unit
// the window actually used, then the spend. Sorted by spend, then by calls —
// the two figures that mean the same thing in every row.
function breakdown(res, dim, labelOf) {
  const defs = defsOf(res);
  const rows = res.rows
    .map((r) => ({ r, cost: costOf(r.units, defs) }))
    .sort((a, b) => (b.cost?.micros || 0) - (a.cost?.micros || 0)
      || (b.r.units.requests?.quantity || 0) - (a.r.units.requests?.quantity || 0));
  const unitCells = ({ units }) => res.units.map((u) => {
    const q = units[u.unit]?.quantity;
    return `<td>${q ? fmtQty(q, u.format) : '<span class="muted">—</span>'}</td>`;
  }).join("");
  const costCell = (cost) => cost
    ? `<td${cost.unpriced.length ? ` title="not in the $ figure: ${fmtUnpriced(cost.unpriced)}"` : ""}>${fmtCost(cost)}</td>`
    : '<td><span class="muted">—</span></td>';
  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h2>${res.dims[dim].label}</h2>
    <table><thead><tr><th></th>${res.units.map((u) => `<th>${u.label}</th>`).join("")}<th>spend</th></tr></thead>
    <tbody>${rows.map(({ r, cost }) => `<tr><td>${labelOf(r, res.dims)}</td>${unitCells(r)}${costCell(cost)}</tr>`).join("")}</tbody></table>`;
  return sec;
}

// The response's unit vocabulary as a lookup — { unit: { label, format } }.
const defsOf = (res) => Object.fromEntries(res.units.map((u) => [u.unit, u]));

// Sum rows' units — quantities within a unit and nothing else (the meter's
// summing rule, applied client-side to rows the server already folded).
function foldUnits(rows) {
  const total = {};
  for (const r of rows) {
    for (const [unit, u] of Object.entries(r.units)) {
      const t = (total[unit] ??= { quantity: 0, priced_quantity: 0, cost_micros: 0 });
      t.quantity += u.quantity;
      t.priced_quantity += u.priced_quantity;
      t.cost_micros += u.cost_micros;
    }
  }
  return total;
}

// A row's spend in the shape fmtCost/fmtUnpriced already read — micros plus
// the per-unit unpriced remainder — or null when NOTHING was ever priced: a
// $ figure from ignorance would be a claim, and the server refuses the same
// one (db.js boardUsageSummary). Rate 0 is priced-at-zero and shows.
function costOf(units, defs) {
  let micros = 0, priced = false;
  const unpriced = [];
  for (const [unit, u] of Object.entries(units)) {
    micros += u.cost_micros;
    if (u.priced_quantity > 0) priced = true;
    if (u.quantity > u.priced_quantity) {
      unpriced.push({ ...(defs[unit] || { unit, label: unit, format: "count" }), quantity: u.quantity - u.priced_quantity });
    }
  }
  unpriced.sort((a, b) => a.unit.localeCompare(b.unit));
  return priced ? { micros, unpriced } : null;
}

// "N label" for one unit of a row, in the served vocabulary; "" when absent.
function named(units, defs, unit) {
  const q = units[unit]?.quantity;
  if (!q) return "";
  const d = defs[unit] || { label: unit, format: "count" };
  return `${fmtQty(q, d.format)} ${d.label}`;
}

// One stat on the strip: the figure, its name under it, detail on hover.
function kpi(value, label, title = "") {
  return `<div class="usage-kpi"${title ? ` title="${title}"` : ""}><div class="v">${value}</div><div class="k">${label}</div></div>`;
}

// ── Prices (metering-plan.md, Stage 4c) ─────────────────────────────────────
// The rate editor over /api/admin/prices — the RESOLVED map with per-unit
// provenance, straight from the same walk stamping reads, so what this table
// shows is exactly what a call would be stamped at.
//
// A rate is shown and typed in its unit's own frame, and the frame is SERVED:
// units.js declares what a price for each unit is quoted per (`rate.per`) and
// what to call it (`rate.label`). This module only does the arithmetic. That
// split is load-bearing rather than tidy — deriving the frame from the display
// kind, which is what the first cut did, is how a rate lands a factor of a
// million out, and validRate cannot catch it because 1e6 × a valid rate is
// still valid. The result would be a falsified billing record, the one thing
// the meter can never repair.

// Micro-dollars per unit ⇄ the number a person reads and types.
const toRate = (micros, rate) => (micros * rate.per) / 1e6;
// toPrecision sheds the float dust the scaling can mint (0.834 × 1e6 →
// 834000.0000000001), the same guard price-learner's dollarsToMicros holds.
const toMicros = (v, rate) => Number(((v * 1e6) / rate.per).toPrecision(12));

async function loadPrices() {
  let data;
  try { data = await api("GET", "/api/admin/prices"); } catch { return; }
  renderPrices(data);
}

// The ONE save path. Both entrances — a table cell and the form — route
// through it, so the rate rule and the two sentences a person reads are
// stated once. Answers false when nothing was written, so a caller can keep
// its editor open on the value that failed.
async function savePrice({ provider, model, unit, rate }, raw) {
  const v = Number(raw);
  if (!String(raw).trim() || !Number.isFinite(v) || v < 0) {
    toast.error("a rate is a non-negative number (0 = known-free)");
    return false;
  }
  try {
    await api("PUT", "/api/admin/prices", { provider, model, unit, microsPerUnit: toMicros(v, rate) });
    toast("Price saved — new calls stamp at it");
    loadPrices();
    return true;
  } catch (err) {
    toast.error(err.message);
    return false;
  }
}

function renderPrices({ models, wanted, freshness, units }) {
  pricesSec.innerHTML = `<h2>Prices</h2>
    <p class="sub">The rates stamping reads, best answer per unit — hover a rate for which rung said so.
    An edit inserts a new effective rate: new calls stamp at it, history keeps what it ran at.</p>`;

  // Freshness + Refresh: when each learner rung last heard from its source,
  // and the button that asks them all again right now.
  const controls = document.createElement("div");
  controls.className = "price-head";
  const fresh = [];
  // One community pull stamps a row per provider — fold them back into the
  // single fetch they were.
  const commAt = Math.max(0, ...freshness.filter((f) => f.source === "community").map((f) => f.at));
  if (commAt) fresh.push(`community table ${relTime(commAt)}`);
  for (const f of freshness.filter((f) => f.source === "provider")) fresh.push(`asked ${f.provider} ${relTime(f.at)}`);
  const freshEl = document.createElement("span");
  freshEl.className = "muted";
  freshEl.textContent = fresh.length ? `Fetched: ${fresh.join(" · ")}` : "No prices fetched yet.";
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "ghost sm";
  refreshBtn.textContent = "refresh prices";
  refreshBtn.title = "Pull the community table and ask connected providers now, skipping the weekly pacing";
  refreshBtn.onclick = busy(refreshBtn, "refreshing…", async () => {
    try {
      const { learned } = await api("POST", "/api/admin/prices/refresh");
      toast(`Learned ${learned} price(s)`);
      loadPrices(); // rebuilds this section, button included
    } catch (err) { toast.error(err.message); }
  });
  controls.append(freshEl, refreshBtn);
  pricesSec.appendChild(controls);

  // What the learners are still hunting — models seen by the meter, no rate yet.
  if (wanted.length) {
    const w = document.createElement("p");
    w.className = "muted price-note";
    const names = wanted.slice(0, 8).map((x) => `${x.provider}/${x.model}`).join(" · ");
    w.textContent = `Still hunting rates for: ${names}${wanted.length > 8 ? ` … and ${wanted.length - 8} more` : ""}`;
    pricesSec.appendChild(w);
  }

  // One vocabulary for the section: every unit the server serves gets a
  // column. Narrowing to the units something happens to have been priced in
  // would hide the empty cell that IS the way to price it — and width is set
  // by the registry (a handful) while the rows are what run to hundreds, so
  // there is nothing to save on this axis anyway.
  const rows = [...models].sort((a, b) =>
    a.provider.localeCompare(b.provider)
    || (b.model === "*") - (a.model === "*") // the provider-wide default leads its provider
    || a.model.localeCompare(b.model));

  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Provider</th><th>Model</th>${units.map((u) =>
    `<th>${u.label} <span class="muted">${u.rate.label}</span></th>`).join("")}</tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const [i, m] of rows.entries()) {
    const tr = document.createElement("tr");
    tr.dataset.row = i;
    const prov = document.createElement("td");
    prov.textContent = m.provider;
    const model = document.createElement("td");
    model.textContent = m.model;
    if (m.model === "*") model.title = "provider-wide default — a model's own rate overrides it, unit by unit";
    tr.append(prov, model);
    for (const [j, u] of units.entries()) {
      const td = document.createElement("td");
      td.className = "price-cell";
      td.dataset.unit = j;
      const cur = m.units[u.unit];
      showRate(td, cur, u);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  // ONE listener for the whole table rather than a closure per cell: a
  // provider-rung catalog is hundreds of rows wide by the unit columns, and
  // this section is never discarded (see pricesSec), so those closures would
  // be retained for the life of the admin session.
  table.addEventListener("click", (e) => {
    const td = e.target.closest("td.price-cell");
    if (!td || !table.contains(td)) return;
    editRate(td, rows[td.parentElement.dataset.row], units[td.dataset.unit]);
  });

  const empty = document.createElement("p");
  empty.className = "muted";
  empty.hidden = !!rows.length;
  empty.textContent = "No rates known yet — refresh, or type one in below.";

  // A provider-rung catalog is hundreds of rows, so it gets a filter rather
  // than pagination. Filtering hides rows instead of rebuilding the table:
  // the reason the filter exists is the size that makes a per-keystroke
  // rebuild expensive.
  if (rows.length > 12) {
    const hay = rows.map((m) => `${m.provider} ${m.model}`.toLowerCase());
    const trs = [...tbody.children];
    const filter = document.createElement("input");
    filter.className = "price-filter";
    filter.placeholder = "filter models…";
    filter.oninput = () => {
      const q = filter.value.trim().toLowerCase();
      let shown = 0;
      trs.forEach((tr, i) => {
        const hit = !q || hay[i].includes(q);
        tr.hidden = !hit;
        if (hit) shown++;
      });
      empty.hidden = shown > 0;
      empty.textContent = "No models match the filter.";
    };
    pricesSec.appendChild(filter);
  }
  pricesSec.append(table, empty);

  // Type a price in for ANY pair — including one nothing has metered yet;
  // seeding rates before spending is the point.
  const form = document.createElement("form");
  form.className = "price-form";
  const provIn = document.createElement("input");
  provIn.placeholder = "provider";
  const modelIn = document.createElement("input");
  modelIn.placeholder = "model (* = provider-wide)";
  const unitSel = document.createElement("select");
  // Through fillSelect for the capability the element lacks: a picker nobody
  // has answered must not render as one somebody has (select.js).
  fillSelect(unitSel, units.map((u) => ({ value: u.unit, label: u.label })), { placeholder: "unit…" });
  const rateIn = document.createElement("input");
  rateIn.type = "number";
  rateIn.step = "any";
  rateIn.min = "0";
  const chosen = () => units.find((u) => u.unit === unitSel.value);
  // The frame follows the unit, and says nothing until one is picked.
  const setFrame = () => { rateIn.placeholder = chosen()?.rate.label ?? "rate"; };
  unitSel.onchange = setFrame;
  setFrame();
  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.className = "ghost";
  addBtn.textContent = "set price";
  form.onsubmit = async (e) => {
    e.preventDefault();
    const unit = chosen();
    if (!provIn.value.trim() || !modelIn.value.trim()) return toast.error("provider and model are required");
    if (!unit) return toast.error("pick the unit this rate is for");
    await savePrice(
      { provider: provIn.value.trim(), model: modelIn.value.trim(), unit: unit.unit, rate: unit.rate },
      rateIn.value
    );
  };
  form.append(provIn, modelIn, unitSel, rateIn, addBtn);
  pricesSec.appendChild(form);
}

// A cell's resolved rate, or the dash that says nobody has priced this yet.
function showRate(td, cur, unitDef) {
  td.replaceChildren();
  if (cur) td.textContent = fmtUsd(toRate(cur.micros, unitDef.rate));
  else td.innerHTML = '<span class="muted">—</span>';
  td.title = cur ? `${cur.source} rate — click to edit` : "no rate — click to set";
}

// Click-to-edit on a rate cell: an input in the unit's own frame. Enter saves
// (a new effective admin row), Escape or leaving puts the cell back.
function editRate(cell, model, unitDef) {
  if (cell.querySelector("input")) return;
  const cur = model.units[unitDef.unit];
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.min = "0";
  input.className = "price-edit";
  input.placeholder = unitDef.rate.label;
  if (cur) input.value = toRate(cur.micros, unitDef.rate);
  const done = () => showRate(cell, cur, unitDef);
  input.onkeydown = async (e) => {
    if (e.key === "Escape") return done();
    if (e.key !== "Enter") return;
    e.preventDefault();
    const saved = await savePrice(
      { provider: model.provider, model: model.model, unit: unitDef.unit, rate: unitDef.rate },
      input.value
    );
    if (!saved && !input.isConnected) return; // the reload beat us to it
    if (!saved) input.focus(); // rejected: keep the value in front of the person who typed it
  };
  input.onblur = done;
  cell.replaceChildren(input);
  input.focus();
}
