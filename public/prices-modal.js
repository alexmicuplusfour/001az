// The rate editor (metering-plan.md, Stage 4c; moved out of the Usage tab
// afterwards): the RESOLVED price map with per-unit provenance, straight from
// the same walk stamping reads, so what this table shows is exactly what a call
// would be stamped at.
//
// It lives in a dialog rather than under the tab because it is a different job.
// The Usage tab answers "what did this cost"; this answers "what will it cost",
// and it is a hundreds-of-rows catalog either way. The tab keeps the STATUS
// that qualifies its own numbers — when each rung last fetched, and which models
// are still unpriced — and opens this to change anything.
//
// A rate is shown and typed in its unit's own frame, and the frame is SERVED:
// units.js declares what a price for each unit is quoted per (`rate.per`) and
// what to call it (`rate.label`), so this module holds arithmetic and no
// vocabulary. Getting that wrong is the one unfixable mistake in the whole
// arc — a rate a factor of a million out passes every validator and stamps into
// a cost_micros nothing recomputes.
import { api } from "/api.js";
import { toast } from "/toast.js";
import { fillSelect } from "/select.js";
import { fmtUsd } from "/utils.js";
import { createModal } from "/modal.js";

// Micro-dollars per unit ⇄ the number a person reads and types.
const toRate = (micros, rate) => (micros * rate.per) / 1e6;
// toPrecision sheds the float dust the scaling can mint (0.834 × 1e6 →
// 834000.0000000001), the same guard price-learner's dollarsToMicros holds.
const toMicros = (v, rate) => Number(((v * 1e6) / rate.per).toPrecision(12));

let openEl = null; // one dialog at a time, like every other modal here

// `onChange` is how the tab that opened this keeps up: an edit can retire a
// model from the "still hunting" list it renders, and that list is the one
// thing out here a save can invalidate. Fired per successful write rather than
// on close, so the two surfaces never disagree while both are on screen.
export async function openPricesModal({ onChange } = {}) {
  if (openEl) return;
  const { body, overlay } = createModal({
    title: "Prices",
    id: "prices-modal",
    onClose: () => { openEl = null; },
  });
  openEl = overlay;

  const reload = async () => {
    let data;
    try { data = await api("GET", "/api/admin/prices"); }
    catch (err) { body.textContent = err.message; return; }
    render(body, data, reload, onChange);
  };
  body.innerHTML = '<p class="muted">Loading…</p>';
  await reload();
}

// The ONE save path. Both entrances — a table cell and the form — route
// through it, so the rate rule and the two sentences a person reads are
// stated once. Answers false when nothing was written, so a caller can keep
// its editor open on the value that failed.
async function savePrice({ provider, model, unit, rate }, raw, reload, onChange) {
  const v = Number(raw);
  if (!String(raw).trim() || !Number.isFinite(v) || v < 0) {
    toast.error("a rate is a non-negative number (0 = known-free)");
    return false;
  }
  try {
    await api("PUT", "/api/admin/prices", { provider, model, unit, microsPerUnit: toMicros(v, rate) });
    toast("Price saved — new calls stamp at it");
    onChange?.();
    await reload();
    return true;
  } catch (err) {
    toast.error(err.message);
    return false;
  }
}

function render(body, { models, units }, reload, onChange) {
  body.innerHTML = `<p class="sub">Hover a rate for which rung said so. An edit inserts a new
    effective rate: new calls stamp at it, history keeps what it ran at.</p>`;

  // One vocabulary for the table: every unit the server serves gets a column.
  // Narrowing to the units something happens to have been priced in would hide
  // the empty cell that IS the way to price it — and width is set by the
  // registry (a handful) while the rows are what run to hundreds, so there is
  // nothing to save on this axis anyway.
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
      showRate(td, m.units[u.unit], u);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  // ONE listener for the whole table rather than a closure per cell: a
  // provider-rung catalog is hundreds of rows wide by the unit columns, so
  // that is hundreds of closures allocated per render — and this table
  // re-renders on every save.
  table.addEventListener("click", (e) => {
    const td = e.target.closest("td.price-cell");
    if (!td || !table.contains(td)) return;
    editRate(td, rows[td.parentElement.dataset.row], units[td.dataset.unit], reload, onChange);
  });

  const empty = document.createElement("p");
  empty.className = "muted";
  empty.hidden = !!rows.length;
  empty.textContent = "No rates known yet — refresh on the Usage tab, or type one in below.";

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
    body.appendChild(filter);
  }
  body.append(table, empty);

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
      rateIn.value, reload, onChange
    );
  };
  form.append(provIn, modelIn, unitSel, rateIn, addBtn);
  body.appendChild(form);
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
function editRate(cell, model, unitDef, reload, onChange) {
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
      input.value, reload, onChange
    );
    if (!saved && !input.isConnected) return; // the reload beat us to it
    if (!saved) input.focus(); // rejected: keep the value in front of the person who typed it
  };
  input.onblur = done;
  cell.replaceChildren(input);
  input.focus();
}
