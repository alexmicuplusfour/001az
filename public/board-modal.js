// The board editor — the same Mapping|Tagging modal everywhere it opens:
// admin.html (edit + create) and the gallery toolbar (pencil + New board).
// Admins get the full editor; board-admins a content-only Tagging pane and a
// read-only Mapping view. Styling for .switch / .switch-row / .modal-section /
// .fe-* / .clip-* / .mm-* lives in modal.css, which both pages load (plus dropdown.css
// for the pane's menus). Caches the provider catalog module-side.
// Relative, not root-absolute, and the distinction is not stylistic. An ES
// module specifier resolves against the URL of the module doing the importing,
// never against the page's — so `./toast.js` here is `/toast.js` whether the
// document is `/`, `/boards` or `/admin.html`. The root-absolute form defends
// against a hazard modules do not have; it belongs on `<script src>` in HTML,
// which IS document-relative (hence boards.html's `/boards.js`).
//
// What it cost was testability. This file is the only module in the 38
// reachable from announce.js that used the root-absolute form, and Node cannot
// resolve it — so the module owning the header's whole notification rule could
// not be imported by a test at all. Five lines were the entire blocker.
import { toast } from "./toast.js";
import { createModal, sectionHeading } from "./modal.js";
import { api } from "./api.js";
import { buildMappingPane } from "./mapping-modal.js";
import { diagnosisBlock } from "./facet-diagnostics.js";
import { fillSelect, isUnset } from "./select.js";
import { planBoardPicker } from "./capability-present.js";

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

// A facet's key, derived from its label: lowercase, spaces to dashes, nothing
// else survives. Derived exactly twice — while a new facet's label is still
// being typed, and for a pasted facet that arrived without one.
export const facetKey = (label) =>
  String(label || "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

// `stats` is the roll-up rows keyed by facet, `gates` the thresholds the worker
// gates on — both from the board payload, both optional so the admin page's
// new-board path (which has neither) is unaffected.
//
// Returns a handle to the one thing an outside caller can do to a taxonomy it
// doesn't own: replace it wholesale (the guidance clipboard's paste). Reading
// goes the other way — through `textarea`, which every edit syncs and which the
// Save handler already treats as the source of truth.
export function buildFacetEditor(textarea, { stats = [], gates = {} } = {}) {
  const statsByKey = new Map((stats || []).map((r) => [r.key, r]));
  textarea.hidden = true;
  let facets = [];
  try { facets = JSON.parse(textarea.value) || []; } catch {}

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

  // Every edit that changes the shape of the list — remove a value, remove a
  // facet, paste JSON — rebuilds the whole editor. Emptying `root` momentarily
  // collapses the scroll container's content, and the browser clamps its
  // scrollTop to the (now zero) maximum; refilling it restores the height but
  // not the position, so deleting one value near the bottom threw the user back
  // to the top of the taxonomy. Capture the position before the rebuild and put
  // it back after. The content is at most one row shorter, so the restored
  // offset still lands on the facet being edited.
  //
  // Deliberately the nearest ancestor that actually scrolls rather than a
  // hardcoded `.modal-body`: the editor is only mounted in the board modal
  // today, but the fix shouldn't quietly stop working if it moves into a pane.
  function scrollHost() {
    for (let el = root.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    }
    return null;
  }

  function render() {
    const host = scrollHost();
    const savedTop = host?.scrollTop || 0;
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
          f.key = facetKey(f.label);
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

      // The facet's finding, as one line under the description it is about.
      //
      // The HEADLINE only, and no control of any kind. Two separate reasons,
      // and each would be enough on its own: this is a stack of 28px rows, so a
      // finding rendered here at any size worth reading is a panel taller than
      // the facet it belongs to; and the per-facet retag lives on the
      // boards-list row instead, because retagging against a gloss the user has
      // edited but not saved is impossible rather than merely guarded against.
      // The proposed wording, and the one control that hands it over, live in
      // the Tagging consistency modal — which is where the reader came from.
      //
      // Keyed on the STORED facet key, so a facet the user is still naming has
      // no stats to look up and renders nothing — right, since nothing has
      // measured it under that name.
      const row = statsByKey.get(f.key);
      if (row) {
        const block = diagnosisBlock(row, gates, { compact: true });
        if (block) facetEl.appendChild(block);
      }

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
      facets.push({ key: "", label: "", values: ["", ""], _new: true });
      render();
      sync();
      root.querySelectorAll(".fe-label").item(facets.length - 1)?.focus();
    };
    root.appendChild(addFacet);

    // After the content is back, so the assignment isn't clamped again. The
    // callers that focus a newly added input do so after render() returns —
    // their scroll-into-view still wins, which is what you want when the thing
    // you just created is off-screen.
    if (host) host.scrollTop = savedTop;
  }

  render();
  sync();

  return {
    setFacets(next) {
      facets = Array.isArray(next) ? next : [];
      render();
      sync();
    },
  };
}

// What "Paste JSON" accepts, and what it means. Exported for the test, and
// because the rule is the feature: this is the only place that decides what a
// pasted guidance document is allowed to be.
//
// A document replaces what it MENTIONS and leaves the rest alone. The two keys
// are independently useful — re-wording what a board is for shouldn't require
// carrying its taxonomy along, and a taxonomy shouldn't blank a context it
// says nothing about. A bare array is read as facets-only: that is the shape
// this button emitted before the guidance became one document, and the shape
// an AI hands back when asked for "the taxonomy".
//
// Two fields are filled in rather than demanded, because both are things a
// hand-written or AI-drafted document leaves out and neither is optional
// downstream. The editor supplies them as you type; paste never went through
// that path, which is why it could write shapes the editor cannot produce.
//   key    — every tag the worker writes and every filter the gallery builds is
//            keyed, so a keyless facet saves fine and then matches nothing,
//            forever. Derived from the label.
//   values — `for (const v of f.values)` runs unguarded in the tagging pass,
//            the manual-tag route and the gallery's filter build, so a facet
//            with no values list doesn't degrade, it throws — on a board the
//            user has already saved and walked away from.
//
// Throws on anything else; the caller turns that into the warn toast.
export function normalizeGuidance(parsed) {
  const doc = Array.isArray(parsed) ? { facets: parsed } : parsed;
  if (!doc || typeof doc !== "object") throw new Error("not a guidance document");
  const out = {};
  if ("context" in doc) {
    if (typeof doc.context !== "string") throw new Error("context must be a string");
    out.context = doc.context;
  }
  if ("facets" in doc) {
    if (!Array.isArray(doc.facets)) throw new Error("facets must be an array");
    out.facets = doc.facets.map((f) => {
      if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error("each facet must be an object");
      return { ...f, key: f.key || facetKey(f.label), values: Array.isArray(f.values) ? f.values : [] };
    });
  }
  if (out.context === undefined && out.facets === undefined) throw new Error("no context or facets");
  return out;
}

// The Tagging Guidance clipboard — ONE JSON document for the whole section: the
// AI context and the taxonomy together.
//
// It used to sit on the Taxonomy sub-title and carry the bare facets array,
// which split the guidance in half at exactly the wrong seam. The context is
// what tells a tagger what these items ARE; the facets are what it may say
// about them. Moving a board's tagging to another board, or handing it to an AI
// to extend, means moving both — and the old button silently moved one.
//
// Copy is pretty-printed. The compact form in the hidden textarea exists to be
// parsed by the Save handler; this one exists to be read, edited by hand, and
// pasted into a chat.
function buildGuidanceClipboard({ contextEl, facetsEl, editor }) {
  const bar = document.createElement("div");
  bar.className = "clip-toolbar";
  const chip = (label, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "clip-btn";
    b.textContent = label;
    b.onclick = () => onClick(b);
    bar.appendChild(b);
  };

  chip("Copy JSON", async (b) => {
    let facets = [];
    try { facets = JSON.parse(facetsEl.value) || []; } catch {}
    const doc = { context: contextEl.value.trim(), facets };
    try { await navigator.clipboard.writeText(JSON.stringify(doc, null, 2)); }
    catch { return toast.error("Couldn't write to the clipboard"); }
    b.textContent = "Copied!";
    setTimeout(() => (b.textContent = "Copy JSON"), 1200);
  });

  chip("Paste JSON", async () => {
    let doc;
    try { doc = normalizeGuidance(JSON.parse(await navigator.clipboard.readText())); }
    catch { return toast.warn('Clipboard doesn\'t contain tagging guidance JSON ({ "context", "facets" })'); }
    if (doc.context !== undefined) contextEl.value = doc.context;
    if (doc.facets !== undefined) editor.setFacets(doc.facets);
  });

  return bar;
}

// The provider catalog (labels, model lists + notes, defaults, capabilities) is
// served from the server registry — single source of truth, no client mirror.
// Fetched once, cached for the page (admin-only: needs /api/admin/ai-providers).
let _catalog = null;
export const loadProviders = () => (_catalog ??= api("GET", "/api/admin/ai-providers"));
export const byName = (list) => Object.fromEntries(list.map((p) => [p.name, p]));

// (Re)populate a <select> from a provider's catalog entry ({ models,
// defaultModel }); keeps an unknown current model as an extra option instead
// of silently dropping it (a saved id the provider has since retired still
// shows — it just fails at call time with the provider's own error).
// `absentNote` labels that extra option — passed only by callers who KNOW
// the list is authoritative (a live listing); a curated render can't claim
// absence, its list is just the recommendations. Internal to the picker
// mechanism — modals go through syncModelPicker.
//
// `placeholder` asks for select.js's empty state, and the one thing it changes
// here is that `defaultModel` stops being a fallback selection: the provider's
// recommendation is a suggestion, and a picker that renders a suggestion as a
// selection is telling the caller a model was chosen when none was.
function fillModelSelect(sel, entry, current, { absentNote = null, placeholder = null } = {}) {
  const models = entry?.models || [];
  const selected = current || (placeholder ? null : entry?.defaultModel);
  const items = models.map((m) => ({ value: m.id, label: m.note ? `${m.id} — ${m.note}` : m.id }));
  if (selected && !models.find((m) => m.id === selected)) {
    items.unshift({ value: selected, label: absentNote ? `${selected} — ${absentNote}` : selected });
  }
  fillSelect(sel, items, { value: selected, placeholder });
}

// Swap the select's options for the connection's model list (GET
// /api/admin/ai-keys/:id/models — the server asks the provider itself and
// caches). The curated catalog entry already rendered instant options; when
// the answer lands it OWNS the options. What survives the swap: a selection
// that's in the answer, and `current` — the connection's PERSISTED model
// (kept even when absent, marked, so saved config never silently vanishes).
// What does NOT survive: the pre-answer render's default guess — preserving
// a disproved guess is how a never-pulled recommendation ended up selected
// on a fresh Ollama picker. keyId is an ai_keys row id or the literal "env"
// (the ANTHROPIC_API_KEY-backed row — the route lists it with the server's
// own key). _modelKey updates unconditionally, including for null (the
// App/Board-default rows), so a slow response for a previously-selected
// connection never overwrites the current one. The first fetch per
// select+connection sends refresh=1 — opening a picker is the "I just
// `ollama pull`ed, show me" moment — and revisits within the same picker
// ride the server's cache.
// A picker still on its placeholder survives the swap as one: the live answer
// settles WHICH models exist, never whether the user has picked one.
function attachLiveModels(sel, keyId, kind, current, placeholder) {
  sel._modelKey = keyId || null;
  if (!keyId) return;
  const fetched = (sel._modelFetched ??= new Set());
  const refresh = !fetched.has(`${keyId}:${kind || ""}`);
  fetched.add(`${keyId}:${kind || ""}`);
  const q = [kind && `kind=${kind}`, refresh && "refresh=1"].filter(Boolean).join("&");
  api("GET", `/api/admin/ai-keys/${keyId}/models${q ? `?${q}` : ""}`).then((r) => {
    if (sel._modelKey !== keyId || !r?.models?.length) return;
    const alive = !isUnset(sel) && r.models.some((m) => m.id === sel.value);
    const keep = alive ? sel.value : (current && sel.value === current ? current : null);
    // Absence is only claimable off a live answer; a fallback list is just
    // the recommendations and proves nothing about the saved id.
    fillModelSelect(sel, { models: r.models }, keep, {
      absentNote: r.source === "live" ? "not listed by this connection" : null,
      placeholder,
    });
  }).catch(() => {});
}

// THE model picker sync — the one entry point modals use. Callers hand over
// facts (the provider's catalog entry, the connection, the capability kind,
// the PERSISTED model for their context) and never touch the mechanics: the
// instant curated render, the live upgrade when the provider's answer lands,
// which selection survives it, and how absence is labeled all live behind
// this call. `entry` may be null (the App/Board-default rows — nothing to
// render, but the stale-response guard still updates); `keyId` may be an
// ai_keys row id, "env", or null. Persistence stays context-owned by design:
// one connection serves many boards/slots, so no provider-level layer can
// know which saved model matters to THIS picker — the caller says, once.
// `placeholder` is the text for select.js's empty state, for the callers whose
// picker starts unanswered (a slot this provider doesn't hold yet); omit it
// where a picker always stands for something (the board's own model, which
// falls back to the app default rather than to nothing).
export function syncModelPicker(sel, entry, keyId, { kind = null, saved = null, placeholder = null } = {}) {
  if (entry) fillModelSelect(sel, entry, saved, { placeholder });
  attachLiveModels(sel, keyId, kind, saved, placeholder);
}

// How every connection row names itself — plus the model where the row's whole
// point is which one runs (the default rows below).
export const keyLabel = (key, model = key.model) =>
  `${key.name} — ${key.provider}${model ? ` · ${model}` : ""}`;

// A default row inherits a key and a model, and neither is visible from the row
// itself — so it says: "App default (prod — openai · gpt-5.4-mini)". No note =
// nothing trustworthy to add, and the bare label stands.
export const withDefaultNote = (base, note) => (note ? `${base} (${note})` : base);

// Open the board editor — the ONE board modal, same shape everywhere (admin
// page, gallery pencil, and both "New board" buttons): a Mapping|Tagging pane
// toggle over a single Save.
//   boardId        — the board to edit, or null to create. Existing boards are
//                    always fetched fresh via /api/boards/:id/settings, which
//                    carries everything the modal needs (incl. mapping and
//                    has_items for the Mapping pane).
//   opts.canEditAI — show the AI key/model picker + extraction provider, allow
//                    mapping edits, save via /api/admin/boards (admin).
//                    false = content-only, saves via /api/boards/:id and the
//                    Mapping pane is read-only.
//   opts.onSaved   — called with the saved body after a successful save (for
//                    edits that's the sent payload, incl. `mapping` when the
//                    pane was touched).
export async function openBoardModal(boardId, opts = {}) {
  const { canEditAI = false, onSaved } = opts;
  let board = null;
  if (boardId) {
    try { board = await api("GET", `/api/boards/${boardId}/settings`); }
    catch { toast.error("Couldn't load board settings"); return; }
  }
  const isNew = !board;
  document.getElementById("board-edit-modal")?.remove();

  const { body, footer, close } = createModal({
    id: "board-edit-modal",
    title: isNew ? "New board" : board.name,
  });

  // The per-board pin pickers' mount point — one labeled row per capability
  // the capabilities feed says boards may pin, built in the loop below.
  const aiKeyBlock = canEditAI ? `<div id="board-modal-caps"></div>` : "";
  // Mapping|Tagging pane toggle. Tagging is the default — it's the
  // more-touched half — so it's the active (right) segment on open.
  const paneToggle = `
    <div class="pane-toggle" id="board-modal-panes">
      <button type="button" class="pane-toggle-btn" data-pane="mapping">Mapping</button>
      <button type="button" class="pane-toggle-btn active" data-pane="tagging">Tagging</button>
    </div>`;
  body.innerHTML = `
    <label>Board name</label>
    <input id="board-modal-name" placeholder="e.g. Wardrobe Items" style="width:100%" />
    ${paneToggle}
    <div id="board-modal-tagging">
      <div class="modal-section" style="border-top:none;margin-top:0;padding-top:0;">
        ${sectionHeading("Tagging Settings", null, "margin-bottom:12px;")}
        ${aiKeyBlock}
        <div id="board-modal-reasoning" style="margin:0 0 10px;font-size:13px"></div>
        <div id="board-modal-votes" style="margin:0 0 10px;font-size:13px"></div>
        <div id="board-modal-research" style="margin:0 0 10px;font-size:13px"></div>
        <div id="board-modal-autotag" style="font-size:13px"></div>
      </div>
      <div class="modal-section">
        <div class="section-head-row" id="board-modal-guidance-head" style="margin-bottom:12px;">
          ${sectionHeading("Tagging Guidance")}
        </div>
        <label style="display:block;font-size:12px;color:#6b6b72;margin:0 0 4px;">AI context <span style="font-weight:400;color:#9aa0aa">(what this board is for, what the items are, any guidance for tagging)</span></label>
        <textarea id="board-modal-context" rows="5" placeholder="e.g. Classify these clothing items and outfits. Identify what part of the body they are worn on, the most appropriate season, and how formal they are."></textarea>
        <div class="modal-section-title" style="margin-top:18px;">Taxonomy</div>
        <textarea id="board-modal-facets" rows="12"></textarea>
      </div>
    </div>
    <div id="board-modal-mapping" style="display:none;flex-direction:column;gap:12px;"></div>`;
  body.querySelector("#board-modal-name").value = isNew ? "" : board.name;
  body.querySelector("#board-modal-context").value = isNew ? "" : board.context || "";
  body.querySelector("#board-modal-facets").value = isNew ? "[]" : JSON.stringify(board.facets, null, 2);

  footer.innerHTML = `<button id="board-modal-save">${isNew ? "Create board" : "Save"}</button><button class="ghost" id="board-modal-cancel">Cancel</button>`;

  const contextTextarea = document.getElementById("board-modal-context");
  const facetsTextarea = document.getElementById("board-modal-facets");
  // New boards open with an empty taxonomy (the "[]" prefilled above) — boards
  // own their facets, and an empty taxonomy is a valid, non-tagging board.
  const facetEditor = buildFacetEditor(facetsTextarea, { stats: board?.facet_stats, gates: board?.facet_gates });
  // Both halves of the section are built, so the clipboard that carries both
  // can be hung off its heading.
  document.getElementById("board-modal-guidance-head").appendChild(
    buildGuidanceClipboard({ contextEl: contextTextarea, facetsEl: facetsTextarea, editor: facetEditor })
  );

  // Mapping pane. Visibility is via `display` (not the `hidden` attribute) so
  // the pane's own flex layout can't override it.
  //
  // Built lazily on first reveal: Tagging is the default tab, so a save that
  // never opens Mapping shouldn't pay for the pane's fetches (connectors,
  // file-fields, ai-keys). A pane that was never built stays null, so its
  // mapping is never folded into Save. New boards open an empty pane — that's
  // where connector templates are most useful (they lock once items exist).
  let mappingPane = null;
  {
    const panes = document.getElementById("board-modal-panes");
    const taggingEl = document.getElementById("board-modal-tagging");
    const mappingEl = document.getElementById("board-modal-mapping");
    panes.addEventListener("click", (e) => {
      const btn = e.target.closest(".pane-toggle-btn");
      if (!btn) return;
      const showMapping = btn.dataset.pane === "mapping";
      panes.querySelectorAll(".pane-toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
      mappingEl.style.display = showMapping ? "flex" : "none";
      taggingEl.style.display = showMapping ? "none" : "";
      if (showMapping && !mappingPane) {
        mappingPane = buildMappingPane({
          container: mappingEl,
          isAdmin: canEditAI,
          mapping: board?.mapping || null,
          hasItems: !!board?.has_items,
          extract: canEditAI
            ? { keyId: board?.extract_key_id ?? null, model: board?.extract_model ?? null }
            : null,
        });
      }
      // The panes are mutually exclusive, so a reveal is the only moment the
      // extraction row can be read — one push here covers every way the tagger
      // moved while Mapping was hidden, including a provider's live model list
      // landing (which repaints the select without firing `change`).
      if (showMapping) mappingPane?.setBoardTagger(boardTaggerLabel());
    });
  }

  let aiReasoning = isNew ? true : board.ai_reasoning !== false;
  document.getElementById("board-modal-reasoning").appendChild(
    switchRow("AI reasoning", "(the tagger describes the item and justifies each facet; shown in the lightbox and powers semantic search)", aiReasoning, (on) => { aiReasoning = on; })
  );

  // Double-checking and web research are mutually exclusive (the server refuses
  // the pair): searches bill per pass, so N passes multiply a cost the token
  // figures never show. Each control disables the other rather than letting the
  // user discover it at save time.
  //
  // Shape mirrors Auto tagging below — a switch, with the count indented
  // underneath and revealed only once it's on. The count is a detail of the
  // feature, not a second decision to make before turning it on.
  let aiResearch = isNew ? false : board.ai_research === true;
  const dc = {
    on: !isNew && Number(board.ai_votes) > 1,
    passes: (!isNew && Number(board.ai_votes) > 1) ? Number(board.ai_votes) : 3,
  };

  const dcSub = document.createElement("div");
  dcSub.style.cssText = "margin:6px 0 0 30px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
  const dcSel = document.createElement("select");
  for (const n of [3, 5]) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = `${n} passes`;
    dcSel.appendChild(opt);
  }
  dcSel.value = String(dc.passes);
  const dcCost = document.createElement("span");
  dcCost.style.cssText = "font-weight:400;color:#9aa0aa;";
  dcSub.append(dcSel, dcCost);

  const dcRow = switchRow(
    "Double-check tags",
    "(tags each item more than once and keeps only the answers the AI repeats)",
    dc.on,
    (on) => { dc.on = on; syncAi(); }
  );
  const researchRow = switchRow("Web research", "(the tagger may search the web before judging — works on Anthropic taggers; searches bill on top of tokens)", aiResearch, (on) => { aiResearch = on; syncAi(); });

  // A disabled <button class="switch"> ignores .click(), which also kills
  // switchRow's row-wide click handler — so disabling the button is enough.
  const swOf = (row) => row.querySelector("button.switch");
  const syncAi = () => {
    // hidden loses to the inline display:flex, so toggle display directly
    dcSub.style.display = dc.on ? "flex" : "none";
    dcCost.textContent = `— roughly ${dc.passes}× the tagging cost`;
    swOf(dcRow)?.toggleAttribute("disabled", aiResearch);
    swOf(researchRow)?.toggleAttribute("disabled", dc.on);
    dcRow.style.opacity = aiResearch ? "0.5" : "";
    researchRow.style.opacity = dc.on ? "0.5" : "";
  };
  dcSel.onchange = () => { dc.passes = Number(dcSel.value); syncAi(); };

  document.getElementById("board-modal-votes").append(dcRow, dcSub);
  document.getElementById("board-modal-research").append(researchRow);
  syncAi();

  // Auto tagging: on/off, plus an optional schedule that periodically re-tags
  // the whole board (for object types whose content goes stale).
  const at = {
    enabled: isNew ? true : board.auto_tag !== false,
    periodic: !isNew && !!board.auto_tag_periodic,
    everyMin: (!isNew && board.auto_tag_every_min) || 1440,
    skipWeekends: !isNew && !!board.auto_tag_skip_weekends,
    retagOnRefresh: !isNew && !!board.retag_on_refresh,
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
    atSched,
    switchRow("Retag on new data", "(re-tag an entity when a live connector field's value changes)", at.retagOnRefresh, (on) => { at.retagOnRefresh = on; })
  );
  atWrap.append(
    switchRow("Auto tagging", "(new uploads are tagged by the AI; off = they wait untagged until this is back on)", at.enabled, (on) => { at.enabled = on; syncAt(); }),
    atSub
  );
  syncAt();

  // Per-board capability pins (admin only) — one picker per capability the
  // capabilities feed says boards may pin, each planned by planBoardPicker
  // (capability-present.js, pure and node-tested: rows, preselect, model axis,
  // and the exact column-named save body) and mounted here. Nothing in this
  // loop names a capability — a new board-scoped capability gets its picker
  // with no edit here. The hand-written tagger picker this replaces also
  // offered keys whose provider can't serve; the plan filters those, because
  // the write path now refuses them.
  let capPickers = []; // { cap, plan, keySel, modelSel }
  let aiLoaded = false;
  // Defined below only where there are pickers to read it off; a board-admin
  // has none, so their Mapping pane just says "Board default".
  let boardTaggerLabel = () => null;
  if (canEditAI) {
    const wrap = document.getElementById("board-modal-caps");
    Promise.all([
      api("GET", "/api/admin/ai-keys"),
      loadProviders(),
      api("GET", "/api/admin/capabilities"),
    ]).then(([keys, catalog, feed]) => {
      const catByName = byName(catalog);
      const pinnable = (feed.capabilities || []).filter((c) => c.boardBinding && c.boardPickerHome !== "mapping");
      for (const cap of pinnable) {
        const plan = planBoardPicker(cap, keys, board, catByName);
        const label = document.createElement("label");
        const hint = document.createElement("span");
        hint.style.cssText = "font-weight:400;color:#9aa0aa;";
        hint.textContent = " " + plan.hint;
        label.append(plan.title, hint);
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;margin-bottom:14px;";
        const keySel = document.createElement("select");
        keySel.style.cssText = "flex:1;min-width:0;";
        const modelSel = document.createElement("select");
        modelSel.style.cssText = "flex:1;min-width:0;";
        modelSel.hidden = true;
        fillSelect(keySel, plan.rows, { value: plan.preselect });
        const syncModel = () => {
          const axis = plan.modelAxis(keySel.value);
          modelSel.hidden = !axis;
          // Null entry/keyId on the default and built-in rows, so a slow model
          // response for a previously-selected connection can't refill the
          // now-hidden select.
          syncModelPicker(modelSel, axis?.entry ?? null, axis?.keyId ?? null, { kind: axis?.kind ?? null, saved: axis?.saved ?? null });
        };
        keySel.onchange = syncModel;
        syncModel();
        row.append(keySel, modelSel);
        wrap.append(label, row);
        capPickers.push({ cap, plan, keySel, modelSel });
      }
      // What the Mapping pane's "Board default" row inherits: the tagger THIS
      // modal currently shows — unsaved edits included, so the two panes can't
      // disagree. WHICH picker is the tagger's comes from data: the pane-owned
      // capability's delegatesTo.
      const bridgeId = (feed.capabilities || []).find((c) => c.boardPickerHome === "mapping")?.delegatesTo;
      const bridge = capPickers.find((p) => p.cap.id === bridgeId);
      if (bridge) {
        boardTaggerLabel = () =>
          bridge.plan.chosenLabel(bridge.keySel.value, bridge.modelSel.hidden ? null : bridge.modelSel.value || null);
      }
      aiLoaded = true;
    }).catch(() => {});
  }

  document.getElementById("board-modal-name").focus();

  document.getElementById("board-modal-cancel").onclick = close;
  document.getElementById("board-modal-save").onclick = async () => {
    const name = document.getElementById("board-modal-name").value.trim();
    if (!name) return toast.warn("Name required");
    const context = contextTextarea.value.trim();
    let facets;
    try { facets = JSON.parse(facetsTextarea.value); }
    catch { return toast.warn("Facets JSON is invalid"); }
    if (!Array.isArray(facets)) return toast.warn("Facets must be a JSON array");
    // Full-state per capability: every pin column rides every save (nulls
    // clear), in the column names the feed shipped. Gated on aiLoaded so a
    // quick Save before the registry lands can't wipe stored pins.
    const aiOverride = {};
    if (canEditAI && aiLoaded) {
      for (const p of capPickers) {
        Object.assign(aiOverride, p.plan.payload(p.keySel.value, p.modelSel.hidden ? null : p.modelSel.value || null));
      }
    }
    const payload = {
      name, context, facets,
      ai_reasoning: aiReasoning,
      ai_research: aiResearch,
      ai_votes: dc.on ? dc.passes : 1,
      ...aiOverride,
      auto_tag: at.enabled,
      auto_tag_periodic: at.periodic,
      auto_tag_every_min: at.everyMin,
      auto_tag_skip_weekends: at.skipWeekends,
      retag_on_refresh: at.retagOnRefresh,
    };
    // Fold a touched mapping into the same save (create POST or admin PATCH).
    // Only when the admin actually edited it — an untouched pane omits
    // `mapping` so an edit stays a light tagging update (no server-side
    // reschedule/backfill). Mapping only ever rides the admin endpoints,
    // which is exactly the canEditAI gate below.
    if (mappingPane && canEditAI && mappingPane.isDirty()) {
      const res = mappingPane.collect();
      if (!res.ok) return; // collect() already toasted the reason
      Object.assign(payload, res.payload);
    }
    try {
      let saved = payload;
      if (isNew) saved = await api("POST", "/api/admin/boards", payload);
      else if (canEditAI) await api("PATCH", `/api/admin/boards/${board.id}`, payload);
      else await api("PATCH", `/api/boards/${board.id}`, payload);
      close();
      onSaved?.(saved);
      toast(isNew ? `Board "${name}" created` : `Board "${name}" saved`);
    } catch (err) { toast.error(err.message); }
  };
}
