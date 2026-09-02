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
import { busy } from "/modal.js";
import { pill, tokPair, fmtTok, fmtUsd, fmtCost, fmtUnpriced, fmtQty, relTime } from "/utils.js";
import { sparkline, dayKey } from "/sparkline.js";
import { openPricesModal } from "/prices-modal.js";

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
    <p class="sub">Every metered call across the app, over the picked window.</p>`;

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

  // Row 1 — the counts, one equal-width column each (the CSS distributes).
  // The two call families stay side by side and NEVER summed: separate units,
  // so keeping them apart costs a second call rather than a filter. Input and
  // output tokens are their own columns for the same reason the meter keeps
  // them apart — they bill at different rates, and the old pair-in-one-cell
  // reading dressed two figures as one. Every name is the SERVED one: any
  // unit with a quantity is in `defs` by construction (the response's `units`
  // is built from the units its own rows used), so a fallback string here
  // could never render — and the one written first said "requests" where the
  // server says "calls". Titles carry what a short label can't.
  const kpis = [];
  const countKpi = (unit, title) => {
    const q = totals[unit]?.quantity;
    if (q) kpis.push(kpi(fmtQty(q, defs[unit].format), defs[unit].label, title));
  };
  countKpi("requests", "calls to an AI model that answered");
  countKpi("api_requests", "requests sent to a data provider — retried and refused ones included, because a quota charges for those too");
  countKpi("input_tokens");
  countKpi("output_tokens");
  // The ratio shows only when its inputs exist — absence, not 0%.
  if (cacheQ) {
    const d = defs.cache_read_tokens;
    kpis.push(kpi(`${Math.round((cacheQ / (inQ + cacheQ)) * 100)}%`, "cache hit rate",
      `${fmtQty(cacheQ, d?.format)} ${d?.label ?? "cache reads"} vs ${fmtTok(inQ)} billed input`));
  }
  const strip = document.createElement("div");
  strip.className = "usage-kpis";
  strip.innerHTML = kpis.join("");
  head.appendChild(strip);

  // Row 2 — the money, on its own line, with the deal stated in words instead
  // of a symbol. The ≈ used to carry "this figure excludes what nobody has
  // priced" on its back, which is a lot to ask of one glyph a reader has to
  // hover to unpack — the sentence beside the row now says it outright, and
  // NAMES the excluded quantities when there are any. Both figures drop the
  // symbol because the sentence qualifies the whole row at once.
  const money = [];
  money.push(kpi(cost ? fmtUsd(cost.micros / 1e6) : "—", "spend"));
  if (cost && inQ + outQ > 0) {
    // micros ÷ tokens IS dollars per million tokens (micros-per-unit ≡ $/M).
    money.push(kpi(fmtUsd(cost.micros / (inQ + outQ)), "blended $ / M tokens",
      "total spend ÷ total input+output tokens"));
  }
  const deal = !cost
    ? "No call in this window ran at a known rate — quantities are still metered, and a rate set in Prices applies to new calls."
    : cost.unpriced.length
      ? `Stamped when each call ran, at the rate known then — never re-priced. Not yet priced, so not in these figures: ${fmtUnpriced(cost.unpriced)}.`
      : "Stamped when each call ran, at the rate known then — never re-priced. Everything in this window ran at a known rate.";
  const moneyRow = document.createElement("div");
  moneyRow.className = "usage-kpis usage-money";
  moneyRow.innerHTML = money.join("") + `<p class="muted usage-deal">${deal}</p>`;
  head.appendChild(moneyRow);

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
    // The cells join two dimensions' VALUES, so the header joins the same two
    // LABELS the same way — a connector row has no model and reads as its
    // provider alone, which a column headed "Model" would have miscalled.
    breakdown(byModel, "model", (r, dims) =>
      [dims.provider.values[r.provider], dims.model.values[r.model]].filter(Boolean).join(" · ")
        || '<span class="muted">—</span>',
      [byModel.dims.provider.label, byModel.dims.model.label].join(" · ")),
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
//
// `head` names the first column when its cells carry more than the one
// dimension the section is titled by — the model table joins two. Default is
// the dimension's own served label, so the axis names its column the same way
// it names the section.
function breakdown(res, dim, labelOf, head = null) {
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
    <table><thead><tr><th>${head ?? res.dims[dim].label}</th>${res.units.map((u) => `<th>${u.label}</th>`).join("")}<th>spend</th></tr></thead>
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

// ── Prices: the status, not the editor ────────────────────────────
// What belongs beside the figures above is whether they can be TRUSTED: when
// each learner rung last heard from its source, and which models are spending
// with no rate at all. Both qualify the ≈$ the rest of this tab renders.
//
// The catalog itself — hundreds of rows by the unit columns — opens in a dialog
// (prices-modal.js). It is a table to work in, not one to scroll past on the
// way to the rest of the tab, and this endpoint is no longer fetched by a page
// load that never asked about prices.

async function loadPrices() {
  let data;
  try { data = await api("GET", "/api/admin/prices"); } catch { return; }
  renderPrices(data);
}

function renderPrices({ wanted, freshness }) {
  pricesSec.innerHTML = `<h2>Prices</h2>
    <p class="sub">The rates stamping reads, best answer per unit. What this section says is
    whether the figures above can be trusted — when each rung last heard from its source, and
    which models are still spending unpriced.</p>`;

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
  refreshBtn.onclick = busy(refreshBtn, async () => {
    try {
      const { learned } = await api("POST", "/api/admin/prices/refresh");
      toast(`Learned ${learned} price(s)`);
      loadPrices(); // rebuilds this section, button included
    } catch (err) { toast.error(err.message); }
  });
  // The editor itself is a dialog: a resolved catalog runs to hundreds of rows
  // by the unit columns, which is a table to work in rather than one to scroll
  // past on the way to the rest of the tab. `onChange` because a save can
  // retire a model from the hunting list below.
  const editBtn = document.createElement("button");
  editBtn.className = "ghost sm";
  editBtn.textContent = "edit prices";
  editBtn.title = "The resolved rate for every provider and model — and where to type one in";
  editBtn.onclick = () => openPricesModal({ onChange: loadPrices });
  controls.append(freshEl, refreshBtn, editBtn);
  pricesSec.appendChild(controls);

  // What the learners are still hunting — models seen by the meter, no rate yet.
  if (wanted.length) {
    const w = document.createElement("p");
    w.className = "muted price-note";
    const names = wanted.slice(0, 8).map((x) => `${x.provider}/${x.model}`).join(" · ");
    w.textContent = `Still hunting rates for: ${names}${wanted.length > 8 ? ` … and ${wanted.length - 8} more` : ""}`;
    pricesSec.appendChild(w);
  }

}
