import { state } from './state.js';
import { toItem } from './utils.js';
import { toast } from './toast.js';
import { openDropdown, ddRow, ddInput } from './dropdown.js';
import { ensurePolling } from './data.js';

// Search-as-ingestion for connector boards: the plus button opens this
// popover instead of the file picker. Composed from the shared dropdown
// parts (ddInput + ddRow); only the result-row content styling is ours.
export function openConnectorSearch(connectorName, anchorEl) {
  let debounceTimer = null;
  let searchSeq = 0; // stale-response guard

  openDropdown(anchorEl, {
    align: "end",
    minWidth: 280,
    maxItems: 0, // rows are capped by the search API (10), not the dropdown
    focus: ".dd-input",
    build(body, { close, reposition }) {
      const input = ddInput({
        placeholder: `Search ${connectorName}…`,
        onSubmit: (value) => runSearch(value), // Enter skips the debounce
      });
      body.appendChild(input);

      const results = document.createElement("div");
      results.className = "connector-results";
      body.appendChild(results);

      function note(text) {
        const el = document.createElement("div");
        el.className = "connector-searching";
        el.textContent = text;
        results.replaceChildren(el);
        reposition();
      }

      async function addEntity(hit, row) {
        row.style.pointerEvents = "none";
        row.style.opacity = "0.5";
        try {
          const res = await fetch(`/api/boards/${state.boardId}/entities`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ connector: connectorName, id: hit.id }),
          });
          if (res.status === 409) { toast(`${hit.label} is already on this board`); return; }
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            toast.error(body.error || "Failed to add entity");
            return;
          }
          state.items.unshift(toItem(await res.json()));
          document.dispatchEvent(new Event('app:render'));
          ensurePolling();
          toast(`${hit.label} added`);
          close();
        } catch {
          toast.error("Failed to add entity");
        } finally {
          row.style.pointerEvents = "";
          row.style.opacity = "";
        }
      }

      function resultRow(hit) {
        // Whole row is the label element so every pixel is clickable
        // (ddRow's `leading` slot excludes itself from onClick).
        const labelEl = document.createElement("span");
        labelEl.className = "connector-result";
        const sym = document.createElement("span");
        sym.className = "connector-result-sym";
        sym.textContent = (hit.symbol || "?").slice(0, 5);
        const info = document.createElement("span");
        info.className = "connector-result-info";
        const name = document.createElement("span");
        name.className = "connector-result-name";
        name.textContent = hit.label;
        const sub = document.createElement("span");
        sub.className = "connector-result-sub";
        sub.textContent = hit.symbol + (hit.rank ? ` · #${hit.rank}` : "");
        info.append(name, sub);
        labelEl.append(sym, info);
        const row = ddRow({ labelEl });
        row.addEventListener("click", () => addEntity(hit, row));
        return row;
      }

      async function runSearch(q) {
        const seq = ++searchSeq;
        note("Searching…");
        try {
          const r = await fetch(
            `/api/connectors/${encodeURIComponent(connectorName)}/search?q=${encodeURIComponent(q)}`,
            { cache: "no-store" }
          );
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
          const hits = await r.json();
          if (seq !== searchSeq) return; // a newer search superseded this one
          if (!hits.length) return note("No results");
          results.replaceChildren(...hits.map(resultRow));
          reposition();
        } catch (err) {
          if (seq === searchSeq) note(`Search failed: ${err.message}`);
        }
      }

      input.addEventListener("input", () => {
        const q = input.value.trim();
        clearTimeout(debounceTimer);
        if (!q) { searchSeq++; results.replaceChildren(); reposition(); return; }
        debounceTimer = setTimeout(() => runSearch(q), 300);
      });
    },
  });
}
