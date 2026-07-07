// The board editor, shared by admin.html (full: create/edit incl. the AI
// tagger key/model) and the gallery toolbar (content-only, for board-admins).
// Styling for .switch / .switch-row / .modal-section / .fe-* lives in modal.css,
// which both pages load. Self-contained: its own fetch + provider-catalog cache.
import { toast } from "/toast.js";
import { createModal } from "/modal.js";

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}

// Reusable toggle switch: a button that flips .on and reports the new state.
// opts.small for compact contexts (e.g. facet rows).
export function makeSwitch(checked, onChange, opts = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "switch" + (opts.small ? " sm" : "") + (checked ? " on" : "");
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", String(!!checked));
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const on = !btn.classList.contains("on");
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", String(on));
    if (onChange) onChange(on);
  });
  return btn;
}

// Labeled switch row — clicking anywhere on the row toggles.
export function switchRow(label, hint, checked, onChange, opts = {}) {
  const row = document.createElement("div");
  row.className = "switch-row";
  const sw = makeSwitch(checked, onChange, opts);
  const text = document.createElement("span");
  text.append(label);
  if (hint) {
    const h = document.createElement("span");
    h.style.cssText = "font-weight:400;color:#9aa0aa;";
    h.append(" " + hint);
    text.appendChild(h);
  }
  row.append(sw, text);
  row.addEventListener("click", (e) => { if (e.target === row || e.target === text) sw.click(); });
  return row;
}

export function buildFacetEditor(textarea) {
  textarea.hidden = true;
  let facets = [];
  try { facets = JSON.parse(textarea.value) || []; } catch {}

  const copyJsonBtn = document.createElement("button");
  copyJsonBtn.type = "button";
  copyJsonBtn.className = "fe-clip-btn";
  copyJsonBtn.textContent = "Copy JSON";
  copyJsonBtn.onclick = () => {
    navigator.clipboard.writeText(textarea.value).then(() => {
      const prev = copyJsonBtn.textContent;
      copyJsonBtn.textContent = "Copied!";
      setTimeout(() => (copyJsonBtn.textContent = prev), 1200);
    });
  };
  const pasteJsonBtn = document.createElement("button");
  pasteJsonBtn.type = "button";
  pasteJsonBtn.className = "fe-clip-btn";
  pasteJsonBtn.textContent = "Paste JSON";
  pasteJsonBtn.onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error();
      facets = parsed;
      render();
      sync();
    } catch { toast.warn("Clipboard doesn't contain valid facets JSON"); }
  };
  const prevLabel = textarea.previousElementSibling;
  if (prevLabel) {
    prevLabel.style.cssText += "; display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;";
    const btnGroup = document.createElement("div");
    btnGroup.className = "fe-toolbar";
    btnGroup.append(copyJsonBtn, pasteJsonBtn);
    prevLabel.appendChild(btnGroup);
  }

  const root = document.createElement("div");
  root.className = "fe-root";
  textarea.insertAdjacentElement("afterend", root);

  function sync() {
    textarea.value = JSON.stringify(facets.map((f) => {
      const out = { key: f.key, label: f.label, values: f.values };
      if (f.single) out.single = true;
      if (f.description && f.description.trim()) out.description = f.description.trim();
      return out;
    }));
  }

  function render() {
    root.replaceChildren();
    facets.forEach((f, fi) => {
      const facetEl = document.createElement("div");
      facetEl.className = "fe-facet";

      const head = document.createElement("div");
      head.className = "fe-head";

      const labelIn = document.createElement("input");
      labelIn.className = "fe-label";
      labelIn.placeholder = "Label";
      labelIn.value = f.label || "";
      labelIn.oninput = () => {
        f.label = labelIn.value;
        if (f._new) {
          f.key = f.label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
          keyHint.textContent = f.key;
        }
        sync();
      };

      const rmFacet = document.createElement("button");
      rmFacet.className = "fe-rm";
      rmFacet.type = "button";
      rmFacet.textContent = "×";
      rmFacet.onclick = () => { facets.splice(fi, 1); render(); sync(); };

      const keyHint = document.createElement("span");
      keyHint.className = "fe-key-hint";
      keyHint.textContent = f.key || "";

      const singleWrap = switchRow("single value", null, !!f.single, (on) => { f.single = on; sync(); }, { small: true });
      singleWrap.style.cssText = "margin-left:auto;font-size:11px;color:#6b6b72;white-space:nowrap;gap:5px;";

      head.append(labelIn, keyHint, rmFacet, singleWrap);
      facetEl.appendChild(head);

      const descIn = document.createElement("textarea");
      descIn.className = "fe-desc";
      descIn.rows = 2;
      descIn.placeholder = "AI guidance (optional) — what this facet means, how to judge it";
      descIn.value = f.description || "";
      descIn.oninput = () => { f.description = descIn.value; sync(); };
      facetEl.appendChild(descIn);

      const valuesEl = document.createElement("div");
      valuesEl.className = "fe-values";
      (f.values || []).forEach((v, vi) => {
        const row = document.createElement("div");
        row.className = "fe-val-row";
        const valIn = document.createElement("input");
        valIn.placeholder = "value";
        valIn.value = v;
        valIn.oninput = () => {
          const clean = valIn.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9+\-]/g, "");
          if (valIn.value !== clean) {
            const pos = valIn.selectionStart;
            valIn.value = clean;
            valIn.setSelectionRange(pos, pos);
          }
          f.values[vi] = clean;
          sync();
        };
        const rmVal = document.createElement("button");
        rmVal.className = "fe-rm";
        rmVal.type = "button";
        rmVal.textContent = "×";
        rmVal.onclick = () => { f.values.splice(vi, 1); render(); sync(); };
        row.append(valIn, rmVal);
        valuesEl.appendChild(row);
      });

      const addVal = document.createElement("button");
      addVal.className = "fe-add-val";
      addVal.type = "button";
      addVal.textContent = "+ value";
      addVal.onclick = () => {
        f.values = f.values || [];
        f.values.push("");
        render();
        sync();
        root.querySelectorAll(".fe-facet")[fi]?.querySelectorAll(".fe-val-row input").item(f.values.length - 1)?.focus();
      };
      valuesEl.appendChild(addVal);
      facetEl.appendChild(valuesEl);
      root.appendChild(facetEl);
    });

    const addFacet = document.createElement("button");
    addFacet.className = "fe-add-facet";
    addFacet.type = "button";
    addFacet.textContent = "+ facet";
    addFacet.onclick = () => {
      facets.push({ key: "", label: "", values: [], _new: true });
      render();
      sync();
      root.querySelectorAll(".fe-label").item(facets.length - 1)?.focus();
    };
    root.appendChild(addFacet);
  }

  render();
  sync();

  // Lets the modal prefill the starter facets after build.
  return {
    setFacets(next) {
      facets = Array.isArray(next) ? JSON.parse(JSON.stringify(next)) : [];
      render();
      sync();
    },
  };
}

// The provider catalog (labels, model lists + notes, defaults, capabilities) is
// served from the server registry — single source of truth, no client mirror.
// Fetched once, cached for the page (admin-only: needs /api/admin/ai-providers).
let _catalog = null;
export const loadProviders = () => (_catalog ??= api("GET", "/api/admin/ai-providers"));
export const byName = (list) => Object.fromEntries(list.map((p) => [p.name, p]));

// (Re)populate a <select> from a provider's catalog entry ({ models,
// defaultModel }); keeps an unknown current model as an extra option instead of
// silently dropping it.
export function fillModelSelect(sel, entry, current) {
  sel.replaceChildren();
  const models = entry?.models || [];
  const selected = current || entry?.defaultModel;
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = `${m.id} — ${m.note}`;
    if (m.id === selected) opt.selected = true;
    sel.appendChild(opt);
  }
  if (selected && !models.find((m) => m.id === selected)) {
    const opt = document.createElement("option");
    opt.value = selected;
    opt.textContent = selected;
    opt.selected = true;
    sel.insertBefore(opt, sel.firstChild);
  }
}

// Starter facets prefilled into a new board's facet editor — just a suggestion;
// boards own their facets and edit freely.
const STARTER_FACETS = [
  {
    key: "category", label: "Category", single: true,
    values: ["tops", "bottoms", "footwear", "accessories", "outerwear"],
    description: "what kind of item this is",
  },
  {
    key: "season", label: "Season",
    values: ["summer", "winter", "spring-fall", "year-round"],
    description: "when you'd wear or use it",
  },
  {
    key: "formality", label: "Formality", single: true,
    values: ["casual", "workwear", "formal", "athletic"],
    description: "how dressed-up the item reads",
  },
];

// Open the board editor.
//   board          — the board object to edit, or null to create / fetch
//   opts.canEditAI — show the AI key/model picker + save via /api/admin/boards
//                    (admin). false = content-only, saves via /api/boards/:id.
//   opts.boardId   — with board=null and canEditAI=false, fetch this board's
//                    editable settings first (the gallery's manage path).
//   opts.onSaved   — called with the saved body after a successful save.
export async function openBoardModal(board, opts = {}) {
  const { canEditAI = false, onSaved, boardId } = opts;
  if (!board && boardId) {
    try { board = await api("GET", `/api/boards/${boardId}/settings`); }
    catch { toast.error("Couldn't load board settings"); return; }
  }
  const isNew = !board;
  document.getElementById("board-edit-modal")?.remove();

  const { body, footer, close } = createModal({
    id: "board-edit-modal",
    title: isNew ? "New board" : board.name,
  });

  const aiKeyBlock = canEditAI
    ? `<label>AI tagger <span style="font-weight:400;color:#9aa0aa">(which API key and model tag this board)</span></label>
       <div id="board-modal-ai" style="display:flex;gap:8px;margin-bottom:14px;"></div>`
    : "";
  body.innerHTML = `
    <label>Board name</label>
    <input id="board-modal-name" placeholder="e.g. Wardrobe Items" style="width:100%" />
    <label>AI context <span style="font-weight:400;color:#9aa0aa">(what this board is for, what the items are, any guidance for tagging)</span></label>
    <textarea id="board-modal-context" rows="5" placeholder="e.g. Classify these clothing items and outfits. Identify what part of the body they are worn on, the most appropriate season, and how formal they are."></textarea>
    <div class="modal-section">
      <div class="modal-section-title">AI tagging</div>
      ${aiKeyBlock}
      <div id="board-modal-reasoning" style="margin:0 0 10px;font-size:13px"></div>
      <div id="board-modal-research" style="margin:0 0 10px;font-size:13px"></div>
      <div id="board-modal-autotag" style="font-size:13px"></div>
    </div>
    <div class="modal-section">
      <div class="modal-section-title">Facets</div>
      <textarea id="board-modal-facets" rows="12"></textarea>
    </div>`;
  body.querySelector("#board-modal-name").value = isNew ? "" : board.name;
  body.querySelector("#board-modal-context").value = isNew ? "" : board.context || "";
  body.querySelector("#board-modal-facets").value = isNew ? "[]" : JSON.stringify(board.facets, null, 2);

  footer.innerHTML = `<button id="board-modal-save">${isNew ? "Create board" : "Save"}</button><button class="ghost" id="board-modal-cancel">Cancel</button>`;

  const facetsTextarea = document.getElementById("board-modal-facets");
  const facetEditor = buildFacetEditor(facetsTextarea);

  // New boards start from the starter facets (the editor is empty at this
  // point, so nothing user-written is ever overwritten).
  if (isNew) facetEditor.setFacets(STARTER_FACETS);

  let aiReasoning = isNew ? true : board.ai_reasoning !== false;
  document.getElementById("board-modal-reasoning").appendChild(
    switchRow("AI reasoning", "(the tagger describes the item and justifies each facet; shown in the lightbox and powers semantic search)", aiReasoning, (on) => { aiReasoning = on; })
  );

  let aiResearch = isNew ? false : board.ai_research === true;
  document.getElementById("board-modal-research").appendChild(
    switchRow("Web research", "(the tagger may search the web before judging — works on Anthropic taggers; searches bill on top of tokens)", aiResearch, (on) => { aiResearch = on; })
  );

  // Auto tagging: on/off, plus an optional schedule that periodically re-tags
  // the whole board (for object types whose content goes stale).
  const at = {
    enabled: isNew ? true : board.auto_tag !== false,
    periodic: !isNew && !!board.auto_tag_periodic,
    everyMin: (!isNew && board.auto_tag_every_min) || 1440,
    skipWeekends: !isNew && !!board.auto_tag_skip_weekends,
  };
  const atWrap = document.getElementById("board-modal-autotag");
  const atSub = document.createElement("div");
  atSub.style.cssText = "margin:6px 0 0 30px;display:flex;flex-direction:column;gap:6px;";
  const atSched = document.createElement("div");
  atSched.style.cssText = "display:flex;align-items:center;gap:14px;margin-left:30px;flex-wrap:wrap;";
  const EVERY_OPTIONS = [
    [60, "every hour"], [180, "every 3 hours"], [360, "every 6 hours"], [720, "every 12 hours"],
    [1440, "every day"], [2880, "every 2 days"], [10080, "every week"],
  ];
  const everySel = document.createElement("select");
  for (const [min, label] of EVERY_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = String(min);
    opt.textContent = label;
    everySel.appendChild(opt);
  }
  if (!EVERY_OPTIONS.some(([min]) => min === at.everyMin)) {
    const opt = document.createElement("option");
    opt.value = String(at.everyMin);
    opt.textContent = `every ${at.everyMin} min`;
    everySel.insertBefore(opt, everySel.firstChild);
  }
  everySel.value = String(at.everyMin);
  everySel.onchange = () => { at.everyMin = Number(everySel.value); };
  // hidden loses to the inline display:flex, so toggle display directly.
  const syncAt = () => {
    atSub.style.display = at.enabled ? "flex" : "none";
    atSched.style.display = at.periodic ? "flex" : "none";
  };
  atSched.append(
    everySel,
    switchRow("exclude weekends", null, at.skipWeekends, (on) => { at.skipWeekends = on; }, { small: true })
  );
  atSub.append(
    switchRow("Retag on a schedule", "(periodically re-tags everything in this board)", at.periodic, (on) => { at.periodic = on; syncAt(); }),
    atSched
  );
  atWrap.append(
    switchRow("Auto tagging", "(new uploads are tagged by the AI; off = they wait untagged until this is back on)", at.enabled, (on) => { at.enabled = on; syncAt(); }),
    atSub
  );
  syncAt();

  // Per-board tagger override (admin only) — key registry is fetched async; the
  // selects stay disabled until it arrives.
  let aiKeySel, aiModelSel, aiLoaded = false;
  if (canEditAI) {
    const aiWrap = document.getElementById("board-modal-ai");
    aiKeySel = document.createElement("select");
    aiKeySel.style.cssText = "flex:1;min-width:0;";
    aiKeySel.disabled = true;
    aiModelSel = document.createElement("select");
    aiModelSel.style.cssText = "flex:1;min-width:0;";
    aiModelSel.hidden = true;
    aiWrap.append(aiKeySel, aiModelSel);
    let aiKeys = [];
    let aiCatalog = {}; // provider name -> catalog entry
    const syncAiModelSel = () => {
      const key = aiKeys.find((k) => String(k.id) === aiKeySel.value);
      aiModelSel.hidden = !key;
      if (key) {
        const current = board && board.ai_key_id === key.id ? board.ai_model : null;
        fillModelSelect(aiModelSel, aiCatalog[key.provider], current);
      }
    };
    Promise.all([api("GET", "/api/admin/ai-keys"), loadProviders()]).then(([keys, catalog]) => {
      aiKeys = keys;
      aiCatalog = byName(catalog);
      const defOpt = document.createElement("option");
      defOpt.value = "";
      defOpt.textContent = "App default";
      aiKeySel.appendChild(defOpt);
      for (const k of keys) {
        const opt = document.createElement("option");
        opt.value = String(k.id);
        opt.textContent = `${k.name} — ${k.provider}`;
        aiKeySel.appendChild(opt);
      }
      if (board && board.ai_key_id && keys.find((k) => k.id === board.ai_key_id)) {
        aiKeySel.value = String(board.ai_key_id);
      }
      aiKeySel.disabled = false;
      aiKeySel.onchange = syncAiModelSel;
      syncAiModelSel();
      aiLoaded = true;
    }).catch(() => {});
  }

  document.getElementById("board-modal-name").focus();

  document.getElementById("board-modal-cancel").onclick = close;
  document.getElementById("board-modal-save").onclick = async () => {
    const name = document.getElementById("board-modal-name").value.trim();
    if (!name) return toast.warn("Name required");
    const context = document.getElementById("board-modal-context").value.trim();
    let facets;
    try { facets = JSON.parse(document.getElementById("board-modal-facets").value); }
    catch { return toast.warn("Facets JSON is invalid"); }
    if (!Array.isArray(facets)) return toast.warn("Facets must be a JSON array");
    const aiOverride = canEditAI && aiLoaded
      ? {
          ai_key_id: aiKeySel.value ? Number(aiKeySel.value) : null,
          ai_model: aiKeySel.value && !aiModelSel.hidden ? aiModelSel.value : null,
        }
      : {};
    const payload = {
      name, context, facets,
      ai_reasoning: aiReasoning,
      ai_research: aiResearch,
      ...aiOverride,
      auto_tag: at.enabled,
      auto_tag_periodic: at.periodic,
      auto_tag_every_min: at.everyMin,
      auto_tag_skip_weekends: at.skipWeekends,
    };
    try {
      if (isNew) await api("POST", "/api/admin/boards", payload);
      else if (canEditAI) await api("PATCH", `/api/admin/boards/${board.id}`, payload);
      else await api("PATCH", `/api/boards/${board.id}`, payload);
      close();
      onSaved?.(payload);
      toast(isNew ? `Board "${name}" created` : `Board "${name}" saved`);
    } catch (err) { toast.error(err.message); }
  };
}
