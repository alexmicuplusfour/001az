import { state } from './state.js';
import { toItem, sentence, plural } from './utils.js';
import { toast } from './toast.js';
import { createModal } from './modal.js';
import { pagedTableScaffold, fmtUsd, fmtNumber, fmtPercent, ALIGN_END } from './paged-table.js';
import { fillSelect } from './select.js';
import { ensurePolling } from './data.js';

// Browse-and-add ingestion modal for connector boards. Completely connector-
// agnostic: the connector's manifest supplies the sort options and the display
// columns (fetched from /api/connectors), and the board-scoped /connector-list
// endpoint supplies the rows. Crypto today; stocks / businesses / movies drop in
// with zero changes here. Replaces the old search flyout.
// Cell formatting and column alignment by display kind live in paged-table.js,
// shared with the ingest preview so the same value never renders two ways.

export function openConnectorBrowse(connectorName) {
  let descriptor = null; // { label, browse: { columns, sorts, filters, defaultSort, pageSize } }
  const opts = { sort: null, order: "desc", page: 1, query: "", filters: {} };
  let hasMore = false;
  let seq = 0;               // stale-response guard
  let debounceTimer = null;
  const selected = new Set(); // ids checked for bulk add
  const rowCtx = new Map();   // id -> { data, tr, cb, addCell }

  const { body, footer, close, titleEl } = createModal({
    title: `Add ${connectorName}`,
    id: "connector-browse",
    bodyStyle: "display:flex; flex-direction:column; gap:12px;",
  });

  // Controls: search + sort + order — built once the descriptor loads.
  const controls = document.createElement("div");
  controls.className = "cb-controls";
  const searchInput = document.createElement("input");
  searchInput.className = "cb-search";
  searchInput.type = "search";
  searchInput.placeholder = `Search ${connectorName}…`;
  const sortSel = document.createElement("select");
  sortSel.className = "cb-sort";
  const orderBtn = document.createElement("button");
  orderBtn.type = "button";
  orderBtn.className = "cb-order";
  orderBtn.title = "Toggle ascending / descending";
  controls.append(searchInput, sortSel, orderBtn);

  // Scroll region holding the table + load-more.
  const { scroll, thead, tbody, note, moreBtn } = pagedTableScaffold();

  body.append(controls, scroll);

  // Footer: bulk-add action.
  const addSelectedBtn = document.createElement("button");
  addSelectedBtn.type = "button";
  addSelectedBtn.className = "cb-add-selected";
  footer.appendChild(addSelectedBtn);
  function syncFooter() {
    const n = selected.size;
    addSelectedBtn.textContent = n ? `Add selected (${n})` : "Add selected";
    addSelectedBtn.disabled = n === 0;
  }
  syncFooter();

  const renderOrder = () => { orderBtn.textContent = opts.order === "asc" ? "↑ Asc" : "↓ Desc"; };

  function updateSelectAll() {
    if (!selectAll) return;
    const addable = [...rowCtx.values()].filter((c) => !c.data.on_board);
    selectAll.checked = addable.length > 0 && addable.every((c) => selected.has(c.data.id));
    selectAll.indeterminate = !selectAll.checked && addable.some((c) => selected.has(c.data.id));
  }

  let selectAll = null;
  function buildHead() {
    const tr = document.createElement("tr");
    const selTh = document.createElement("th");
    selTh.className = "cb-col-sel";
    selectAll = document.createElement("input");
    selectAll.type = "checkbox";
    selectAll.title = "Select all loaded rows";
    selectAll.addEventListener("change", () => {
      for (const c of rowCtx.values()) {
        if (c.data.on_board) continue;
        c.cb.checked = selectAll.checked;
        if (selectAll.checked) selected.add(c.data.id); else selected.delete(c.data.id);
      }
      syncFooter();
    });
    selTh.appendChild(selectAll);
    tr.appendChild(selTh);
    for (const col of descriptor.browse.columns) {
      const th = document.createElement("th");
      th.textContent = col.label;
      if (ALIGN_END.has(col.kind)) th.className = "cb-end";
      if (col.width) th.style.width = `${col.width}px`;
      tr.appendChild(th);
    }
    tr.appendChild(document.createElement("th")); // add column
    thead.replaceChildren(tr);
  }

  function cellText(col, data) {
    const v = data.values?.[col.key];
    if (col.kind === "usd") return fmtUsd(v);
    if (col.kind === "number") return fmtNumber(v);
    if (col.kind === "text") return v == null ? "—" : String(v);
    return "";
  }

  function makeRow(data) {
    const tr = document.createElement("tr");
    const selTd = document.createElement("td");
    selTd.className = "cb-col-sel";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(data.id);
    cb.disabled = !!data.on_board;
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(data.id); else selected.delete(data.id);
      syncFooter();
      updateSelectAll();
    });
    selTd.appendChild(cb);
    tr.appendChild(selTd);

    for (const col of descriptor.browse.columns) {
      const td = document.createElement("td");
      if (ALIGN_END.has(col.kind)) td.className = "cb-end";
      if (col.primary) {
        const name = document.createElement("span");
        name.className = "cb-primary-name";
        name.textContent = cellText(col, data);
        const sym = document.createElement("span");
        sym.className = "cb-primary-sym";
        sym.textContent = data.symbol || "";
        td.append(name, sym);
      } else if (col.kind === "percent") {
        const v = data.values?.[col.key];
        td.textContent = fmtPercent(v);
        if (v != null && Number.isFinite(v)) td.classList.add(v >= 0 ? "cb-up" : "cb-down");
      } else {
        td.textContent = cellText(col, data);
      }
      tr.appendChild(td);
    }

    const addTd = document.createElement("td");
    addTd.className = "cb-col-add";
    const ctx = { data, tr, cb, addCell: addTd };
    renderAddCell(ctx);
    tr.appendChild(addTd);

    // Clicking anywhere on an addable row toggles its checkbox — except on the
    // interactive controls themselves (the checkbox toggles natively, the Add
    // button adds). Route through the checkbox's own change handler so selection
    // state stays single-sourced.
    if (!data.on_board) {
      tr.classList.add("cb-selectable");
      tr.addEventListener("click", (e) => {
        if (data.on_board || e.target.closest("input, button, a")) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      });
    }

    rowCtx.set(data.id, ctx);
    return tr;
  }

  function renderAddCell(ctx) {
    ctx.addCell.replaceChildren();
    if (ctx.data.on_board) {
      const span = document.createElement("span");
      span.className = "cb-on-board";
      span.textContent = "On board";
      ctx.addCell.appendChild(span);
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-add";
    btn.textContent = "Add";
    btn.addEventListener("click", () => addIds([ctx.data.id], btn));
    ctx.addCell.appendChild(btn);
  }

  // Move rows to the on-board state after a successful add (or a duplicate skip).
  function markOnBoard(id) {
    const ctx = rowCtx.get(id);
    if (!ctx) return;
    ctx.data.on_board = true;
    ctx.cb.checked = false;
    ctx.cb.disabled = true;
    ctx.tr.classList.remove("cb-selectable"); // no longer a click target
    selected.delete(id);
    renderAddCell(ctx);
  }

  // The server's bulk route admits at most 100 per request — a larger
  // selection goes in slices, each chunk's rows flipped as it lands so a long
  // add shows progress instead of a frozen button. A failed chunk stops the
  // run (don't hammer a failing endpoint); everything already added stays.
  const BULK_CHUNK = 100;
  async function addIds(ids, btn) {
    if (!ids.length) return;
    if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
    addSelectedBtn.disabled = true;
    let addedCount = 0;
    const skipped = [];
    try {
      for (let i = 0; i < ids.length; i += BULK_CHUNK) {
        if (ids.length > BULK_CHUNK)
          addSelectedBtn.textContent = `Adding ${i + 1}–${Math.min(i + BULK_CHUNK, ids.length)} of ${ids.length}…`;
        const res = await fetch(`/api/boards/${state.boardId}/entities/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connector: connectorName, ids: ids.slice(i, i + BULK_CHUNK) }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          toast.error(b.error || "Failed to add");
          break;
        }
        const { added = [], skipped: chunkSkipped = [] } = await res.json();
        for (const row of added) {
          state.items.unshift(toItem(row));
          markAddedRow(row); // flip its browse row to on-board (matched by symbol)
        }
        for (const s of chunkSkipped) if (s.reason === "duplicate") markOnBoard(s.id);
        addedCount += added.length;
        skipped.push(...chunkSkipped);
        if (added.length) document.dispatchEvent(new Event('app:render'));
      }
      if (addedCount) {
        ensurePolling();
        toast(`${addedCount} added`);
      }
      const errs = skipped.filter((s) => s.reason !== "duplicate");
      if (errs.length) toast.error(`${errs.length} couldn't be added`);
      syncFooter();
      updateSelectAll();
    } catch {
      toast.error("Failed to add");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Add"; }
      syncFooter();
    }
  }

  // The bulk response rows don't echo the connector id, so match the just-added
  // entity back to its browse row by symbol (identity) to flip it to on-board.
  function findIdBySymbol(symbol) {
    const want = (symbol || "").toUpperCase();
    for (const c of rowCtx.values()) if ((c.data.symbol || "").toUpperCase() === want) return c.data.id;
    return null;
  }
  function markAddedRow(row) {
    const id = findIdBySymbol(row.symbol);
    if (id) markOnBoard(id);
  }

  async function fetchPage(append) {
    const mySeq = ++seq;
    note.textContent = "Loading…";
    moreBtn.disabled = true;
    const params = new URLSearchParams({ sort: opts.sort, order: opts.order, page: String(opts.page) });
    if (opts.query) params.set("q", opts.query);
    for (const [key, value] of Object.entries(opts.filters)) params.set(key, value);
    try {
      const r = await fetch(`/api/boards/${state.boardId}/connector-list?${params}`, { cache: "no-store" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const data = await r.json();
      if (mySeq !== seq) return; // superseded
      hasMore = !!data.hasMore;
      if (!append) { tbody.replaceChildren(); rowCtx.clear(); }
      for (const row of data.rows) tbody.appendChild(makeRow(row));
      note.textContent = rowCtx.size === 0 ? "No results" : "";
      moreBtn.style.display = hasMore ? "" : "none";
      updateSelectAll();
    } catch (err) {
      if (mySeq === seq) note.textContent = `Failed: ${err.message}`;
    } finally {
      if (mySeq === seq) moreBtn.disabled = false;
    }
  }

  function reset() {
    opts.page = 1;
    selected.clear();
    syncFooter();
    fetchPage(false);
  }

  // One narrowing filter as a select: an "all" escape at the top, then the
  // provider's vocabulary ({value,label} — the label is what a category id
  // like "meme-token" is called).
  function filterSelect(f) {
    const sel = document.createElement("select");
    sel.className = "cb-sort cb-filter";
    // The "all" row is a real, selectable choice (come back to it to clear the
    // filter), not select.js's disabled placeholder — hence an option in the
    // list rather than the `placeholder` argument.
    fillSelect(sel, [
      { value: "", label: `All ${plural((f.label || f.key).toLowerCase())}` },
      ...(f.options || []),
    ]);
    sel.addEventListener("change", () => {
      if (sel.value) opts.filters[f.key] = sel.value;
      else delete opts.filters[f.key];
      reset();
    });
    return sel;
  }

  // Wire controls.
  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { opts.query = searchInput.value.trim(); reset(); }, 300);
  });
  sortSel.addEventListener("change", () => { opts.sort = sortSel.value; reset(); });
  orderBtn.addEventListener("click", () => { opts.order = opts.order === "asc" ? "desc" : "asc"; renderOrder(); reset(); });
  moreBtn.addEventListener("click", () => { opts.page += 1; fetchPage(true); });
  addSelectedBtn.addEventListener("click", () => addIds([...selected]));

  // Load the connector descriptor, then the first page.
  (async () => {
    try {
      const connectors = await fetch("/api/connectors").then((r) => r.json());
      descriptor = connectors.find((c) => c.name === connectorName);
    } catch { /* handled below */ }
    if (!descriptor || !descriptor.browse) {
      note.textContent = "Browsing isn't available for this connector.";
      controls.style.display = "none";
      footer.style.display = "none";
      return;
    }
    // Before the availability gate, not after: the modal opened on the bare
    // connector NAME (the caller has nothing else), and the refusal below is
    // still this connector's modal — "Add stocks / No Stocks provider is
    // installed" spells the same domain two ways in two lines.
    titleEl.textContent = `Add ${descriptor.label}`;
    // The domain has no provider that can serve. Say it here rather than let
    // the first page load say it: every control below would work, the request
    // would go out, and the answer would come back as "Failed: …" under an
    // otherwise-normal browser — the shape of a transient error, for a state
    // that is not going to change while this modal is open. Same reason the
    // mapping pane states it, at the other end of the same board's life.
    if (descriptor.available === false) {
      note.textContent = `${sentence(descriptor.reason) || `${descriptor.label} isn't available`} — nothing can be added until that's fixed.`;
      controls.style.display = "none";
      footer.style.display = "none";
      return;
    }
    // Provider credit — a license term for some backends (CoinGecko's demo
    // ToS requires visible attribution), rendered for whichever provider is
    // actually filling the rows.
    const active = (descriptor.providers || []).find((p) => p.name === descriptor.activeProvider);
    if (active?.attribution?.text) {
      const credit = document.createElement("a");
      credit.className = "cb-attribution";
      credit.textContent = active.attribution.text;
      if (active.attribution.url) {
        credit.href = active.attribution.url;
        credit.target = "_blank";
        credit.rel = "noopener";
      }
      footer.insertBefore(credit, addSelectedBtn);
    }
    opts.sort = descriptor.browse.defaultSort || descriptor.browse.sorts?.[0]?.key || null;
    for (const s of descriptor.browse.sorts || []) {
      const o = document.createElement("option");
      o.value = s.key; o.textContent = s.label;
      sortSel.appendChild(o);
    }
    sortSel.value = opts.sort;
    renderOrder();
    buildHead();
    fetchPage(false);
    // Narrowing filters come from their own route, because their vocabularies
    // are the active provider's to supply (CoinGecko's categories, FMP's
    // industries) — no declaration or a provider that can't serve one means no
    // control, so connectors without them keep today's three-control row.
    // Loaded alongside the first page rather than before it: rows are what the
    // modal is for, and a slow (or dead) vocabulary must not hold them up.
    try {
      const { filters } = await fetch(`/api/boards/${state.boardId}/connector-filters`).then((r) => r.json());
      for (const f of filters || []) controls.insertBefore(filterSelect(f), sortSel);
    } catch { /* no controls; browsing is unaffected */ }
  })();

  return { close };
}
