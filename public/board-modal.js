// The board editor — the same Mapping|Tagging modal everywhere it opens:
// admin.html (edit + create) and the gallery toolbar (pencil + New board).
// Admins get the full editor — including the AI-models strip (per-board
// capability pins) and the "Using …" provenance bands; board-admins a
// content-only Tagging pane and a read-only Mapping view. Styling for
// .switch / .switch-row / .modal-section / .modal-strip / .frow-* / .prov /
// .disclosure / .fe-* / .clip-* / .mm-* lives in modal.css, which both pages
// load (plus dropdown.css for the pane's menus). Caches the provider catalog
// module-side.
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
import { ICONS } from "./utils.js";
import { createModal, sectionHeading, provBand, keepPlace } from "./modal.js";
import { api } from "./api.js";
import { buildMappingPane } from "./mapping-modal.js";
import { diagnosisBlock } from "./facet-diagnostics.js";
import { fillSelect, isUnset } from "./select.js";
import { planBoardPicker, planBoardConfig } from "./capability-present.js";

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

// Labeled switch row — clicking anywhere on the row toggles. The row carries a
// `setSwitch(on)` for callers that need to move the knob from code (a mode
// change forcing the value, a mutual exclusion): it updates the visual state
// WITHOUT firing onChange, since the caller is already setting the model.
export function switchRow(label, hint, checked, onChange, opts = {}) {
  const row = document.createElement("div");
  row.className = "switch-row";
  const sw = makeSwitch(checked, onChange, opts);
  row.setSwitch = (on) => {
    sw.classList.toggle("on", on);
    sw.setAttribute("aria-checked", String(on));
  };
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
  // facet, paste JSON — rebuilds the whole editor, which would otherwise drop
  // the reader at the top of the taxonomy. keepPlace (modal.js) holds the
  // scroll offset across the rebuild; the content is at most one row shorter,
  // so the restored offset still lands on the facet being edited.
  const render = keepPlace(root, () => {
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
  });

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
    const before = sel.value;
    fillModelSelect(sel, { models: r.models }, keep, {
      absentNote: r.source === "live" ? "not listed by this connection" : null,
      placeholder,
    });
    // The answer OWNS the options, so landing can MOVE the selection — off a
    // guess it disproves, or onto the placeholder. Writing options raises no
    // event, so until this line nothing downstream ever heard about it: the
    // board editor's provenance bands went on naming the previous model at the
    // point of use while Save read the select itself, and the plugin modal's
    // apply button went on comparing against a selection that had changed
    // underneath it. A picker that moves on its own has to say so — what you
    // see and what you save are the same claim.
    if (sel.value !== before) sel.dispatchEvent(new Event("change"));
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

// Wire a fold (.modal-strip / .disclosure): the head's click toggles, and
// aria-expanded stays true to the state. Returns the setter, for callers that
// also open the fold themselves (the provenance bands' Change links).
function wireFold(el, headSel) {
  const head = el.querySelector(headSel);
  const set = (open) => {
    el.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
  };
  head.addEventListener("click", () => set(!el.classList.contains("open")));
  return set;
}

// Open the board editor — the ONE board modal, same shape everywhere (admin
// page, gallery pencil, and both "New board" buttons): a Mapping|Tagging pane
// toggle over a single Save.
//   boardId        — the board to edit, or null to create. Existing boards are
//                    always fetched fresh via /api/boards/:id/settings, which
//                    carries everything the modal needs (incl. mapping and
//                    has_items for the Mapping pane).
//   opts.canEditAI — show the AI-models strip (per-board capability pins) and
//                    the "Using …" bands, and allow mapping edits. false =
//                    content-only and the Mapping pane is read-only. A UI
//                    flag ONLY: every edit saves via PATCH /api/boards/:id,
//                    and the server layers the admin-only fields off the
//                    session's own role, not off anything this flag claims.
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

  // The AI-models strip's Esc folds the strip instead of the modal — capture
  // phase, so it runs before modal.js's own document-level close handler.
  // Removed on dismissal via createModal's onClose.
  function onStripKey(e) {
    if (e.key === "Escape" && stripEl?.classList.contains("open")) {
      e.stopPropagation();
      setStripOpen(false);
    }
  }

  const { body, footer, close, dialog } = createModal({
    id: "board-edit-modal",
    title: isNew ? "New board" : board.name,
    onClose: () => document.removeEventListener("keydown", onStripKey, true),
  });

  // ── The AI-models strip: a full-bleed fold between the modal header and the
  // scrolling body, shared by both panes. It holds every per-board capability
  // picker; the panes keep one-line "Using …" bands that point here. While
  // open, a scrim dims the body below (click it, or Esc, to fold). Admin-only:
  // the pickers read admin feeds, and pins are admin-written.
  let stripEl = null;
  let setStripOpen = () => {};
  if (canEditAI) {
    stripEl = document.createElement("div");
    stripEl.className = "modal-strip";
    stripEl.innerHTML = `
      <button type="button" class="strip-head" aria-expanded="false">
        <span class="chev">${ICONS.chevron}</span>AI models<span class="fold-summary" id="board-modal-models-summary"></span>
      </button>
      <div class="strip-body"><div id="board-modal-caps"></div></div>`;
    dialog.insertBefore(stripEl, body);
    // The scrim needs a positioned box that is exactly the body's, so the body
    // moves into a wrapper. (The dialog itself can't serve: its open-transition
    // transform makes it a containing block only while a transform stands —
    // reduced-motion drops it.)
    const wrap = document.createElement("div");
    wrap.className = "modal-body-wrap";
    dialog.insertBefore(wrap, body);
    wrap.appendChild(body);
    const scrim = document.createElement("div");
    scrim.className = "modal-body-scrim";
    scrim.setAttribute("aria-hidden", "true");
    wrap.appendChild(scrim);
    setStripOpen = wireFold(stripEl, ".strip-head");
    scrim.addEventListener("click", () => setStripOpen(false));
    document.addEventListener("keydown", onStripKey, true);
  }

  // Mapping|Tagging pane toggle. Tagging is the default — it's the
  // more-touched half — so it's the active (right) segment on open.
  const paneToggle = `
    <div class="pane-toggle" id="board-modal-panes">
      <button type="button" class="pane-toggle-btn" data-pane="mapping">Mapping</button>
      <button type="button" class="pane-toggle-btn active" data-pane="tagging">Tagging</button>
    </div>`;
  // The tagging provenance band: which model tags this board, in one line where
  // the behavior settings are — the pickers themselves live in the strip. Built
  // now, filled when the capability feed lands (hidden until then); its Change
  // reaches the strip through a closure the feed handler replaces, the same way
  // the Mapping pane's does. Admin-only, like the strip.
  let openTagRow = () => {};
  const tagBand = canEditAI ? provBand(() => openTagRow()) : null;
  body.innerHTML = `
    <label>Board name</label>
    <input id="board-modal-name" placeholder="e.g. Wardrobe Items" style="width:100%" />
    ${paneToggle}
    <div id="board-modal-tagging">
      <div class="modal-section" style="border-top:none;margin-top:0;padding-top:0;">
        <div id="board-modal-autotag" style="font-size:13px"></div>
        <div class="disclosure" id="board-modal-adv" style="margin-top:12px;">
          <button type="button" class="disc-head" aria-expanded="false">
            <span class="chev">${ICONS.chevron}</span>Advanced<span class="fold-summary" id="board-modal-adv-summary"></span>
          </button>
          <div class="disc-body">
            <div id="board-modal-reasoning" style="margin:10px 0;font-size:13px"></div>
            <div id="board-modal-votes" style="margin:0 0 10px;font-size:13px"></div>
            <div id="board-modal-research" style="margin:0 0 12px;font-size:13px"></div>
            <div id="board-modal-capconfig" style="margin:0 0 12px;font-size:13px"></div>
            <div id="board-modal-retag" style="font-size:13px"></div>
          </div>
        </div>
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
  if (tagBand) {
    tagBand.el.style.margin = "0 0 14px";
    document.getElementById("board-modal-tagging").prepend(tagBand.el);
  }

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
          onCapabilityChange: (capId) => openCapRow(capId),
        });
      }
      // A reveal re-pushes the bands' labels — one push here covers every way
      // the pickers moved while Mapping was hidden, including a provider's
      // live model list landing (which repaints a select without firing
      // `change`).
      if (showMapping) mappingPane?.setBands(mappingBands());
    });
  }

  // The Advanced fold: everything below auto-tagging is a tuning knob, folded
  // by default. The collapsed head summarizes what's on, so folding hides
  // controls, never state.
  wireFold(document.getElementById("board-modal-adv"), ".disc-head");
  // Board-scoped capability knobs (tagging's image detail). NOT admin-gated:
  // these are cost/quality dials like double-check above, and the manager save
  // route accepts them — so they ride the board settings payload rather than
  // the admin capabilities feed, and mount synchronously with the rest of this
  // fold. (A new board has no settings payload; its knobs mount from the feed
  // in the canEditAI block below, since creating a board is admin-only.)
  const capConfigs = []; // { plan, sel }
  const mountCapConfigs = (fields) => {
    const wrap = document.getElementById("board-modal-capconfig");
    for (const plan of planBoardConfig(fields, board)) {
      const row = document.createElement("div");
      row.style.cssText = "margin-bottom:6px;";
      // The label takes its own line: these labels are full sentences, and on
      // one flex line the note wrapped away from the control it describes,
      // reading as a caption for the whole fold rather than for this select.
      const lab = document.createElement("div");
      lab.style.cssText = "font-weight:500;margin-bottom:4px;";
      lab.textContent = plan.label;
      // Control + note on one line under it — the double-check sub-row's exact
      // shape (dcSub above), so the cost note sits beside the thing that sets
      // the cost.
      const line = document.createElement("div");
      line.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
      const sel = document.createElement("select");
      fillSelect(sel, plan.rows, { value: plan.preselect });
      // One fixed line for the field — the options are ordered cheapest-first,
      // so the note only has to say which way the bill moves. Nothing to
      // re-sync on change.
      const note = document.createElement("span");
      note.style.cssText = "font-weight:400;color:#9aa0aa;";
      note.textContent = plan.hint ? `— ${plan.hint}` : "";
      sel.onchange = syncAdvSummary;
      line.append(sel, note);
      row.append(lab, line);
      wrap.appendChild(row);
      capConfigs.push({ plan, sel });
    }
    syncAdvSummary();
  };
  const syncAdvSummary = () => {
    const bits = [];
    if (aiReasoning) bits.push("Explain tags");
    if (dc.on) bits.push(`double-check ×${dc.passes}`);
    if (aiResearch) bits.push("web research");
    // One chip per board-scoped knob that DEVIATES from the app default (an
    // inherited value is not state the fold is hiding). The planner decides
    // both whether to speak and what to call itself — this loop knows neither
    // the knob's name nor its vocabulary.
    bits.push(...capConfigs.map((c) => c.plan.chipFor(c.sel.value)).filter(Boolean));
    if (at.enabled && at.periodic) bits.push("scheduled retag");
    if (at.enabled && at.retagOnRefresh) bits.push("retag on data change");
    document.getElementById("board-modal-adv-summary").textContent = bits.length ? bits.join(" · ") : "all defaults";
  };

  let aiReasoning = isNew ? true : board.ai_reasoning !== false;
  document.getElementById("board-modal-reasoning").appendChild(
    switchRow("Explain tags", "(the tagger describes the item and justifies each facet; shown in the lightbox and powers semantic search)", aiReasoning, (on) => { aiReasoning = on; syncAdvSummary(); })
  );

  // Double-checking and web research are mutually exclusive (the server refuses
  // the pair): searches bill per pass, so N passes multiply a cost the token
  // figures never show. Turning one on turns the other off — a flip the user
  // sees happen, instead of a grayed switch to puzzle over.
  //
  // Web research additionally needs a tagging provider that advertises it, so
  // its switch disables live off the strip's tagging selection; the closures
  // below start permissive and are tightened once the capability feed lands.
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

  // A disabled <button class="switch"> ignores .click(), which also kills
  // switchRow's row-wide click handler — so disabling the button is enough.
  // (Moving a knob from code is switchRow's own setSwitch; this is only for
  // the disabled attribute, which no row-level API covers.)
  const swOf = (row) => row.querySelector("button.switch");

  const dcRow = switchRow(
    "Double-check tags",
    "(tags each item more than once and keeps only the answers the AI repeats)",
    dc.on,
    (on) => {
      dc.on = on;
      if (on && aiResearch) { aiResearch = false; researchRow.setSwitch(false); }
      syncAi();
    }
  );
  const researchRow = switchRow(
    "Web research",
    "(the tagger may search the web before judging — searches bill on top of tokens)",
    aiResearch,
    (on) => {
      aiResearch = on;
      if (on && dc.on) { dc.on = false; dcRow.setSwitch(false); }
      syncAi();
    }
  );
  const researchNote = document.createElement("div");
  researchNote.style.cssText = "margin:4px 0 0 42px;font-size:12px;color:#9aa0aa;display:none;";

  let researchAvailable = () => true;
  let researchNeeds = null;
  const syncAi = () => {
    // hidden loses to the inline display:flex, so toggle display directly
    dcSub.style.display = dc.on ? "flex" : "none";
    dcCost.textContent = `— roughly ${dc.passes}× the tagging cost`;
    const ok = researchAvailable();
    if (!ok && aiResearch) { aiResearch = false; researchRow.setSwitch(false); }
    swOf(researchRow)?.toggleAttribute("disabled", !ok);
    researchRow.style.opacity = ok ? "" : "0.5";
    researchNote.textContent = ok || !researchNeeds ? "" : `needs a tagging model from ${researchNeeds} — pick one under AI models`;
    researchNote.style.display = researchNote.textContent ? "" : "none";
    syncAdvSummary();
  };
  dcSel.onchange = () => { dc.passes = Number(dcSel.value); syncAi(); };

  document.getElementById("board-modal-votes").append(dcRow, dcSub);
  document.getElementById("board-modal-research").append(researchRow, researchNote);

  // Auto tagging is the pane's one primary switch; the schedule that re-tags
  // stale content lives under Advanced → Re-tagging, still gated on it.
  const at = {
    enabled: isNew ? true : board.auto_tag !== false,
    periodic: !isNew && !!board.auto_tag_periodic,
    everyMin: (!isNew && board.auto_tag_every_min) || 1440,
    skipWeekends: !isNew && !!board.auto_tag_skip_weekends,
    retagOnRefresh: !isNew && !!board.retag_on_refresh,
  };
  const atWrap = document.getElementById("board-modal-autotag");
  const retagWrap = document.getElementById("board-modal-retag");
  retagWrap.style.cssText = "font-size:13px;display:flex;flex-direction:column;gap:6px;";
  const retagTitle = document.createElement("div");
  retagTitle.className = "modal-section-title";
  retagTitle.style.cssText = "margin:0;";
  retagTitle.textContent = "Re-tagging";
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
    retagWrap.style.display = at.enabled ? "flex" : "none";
    atSched.style.display = at.periodic ? "flex" : "none";
    syncAdvSummary();
  };
  atSched.append(
    everySel,
    switchRow("exclude weekends", null, at.skipWeekends, (on) => { at.skipWeekends = on; }, { small: true })
  );
  retagWrap.append(
    retagTitle,
    switchRow("On a schedule", "(periodically re-tags everything in this board)", at.periodic, (on) => { at.periodic = on; syncAt(); }),
    atSched,
    switchRow("When connector data changes", "(re-tags an entity when a live connector field's value changes)", at.retagOnRefresh, (on) => { at.retagOnRefresh = on; syncAdvSummary(); })
  );
  atWrap.append(
    switchRow("Tag new uploads automatically", "(off: uploads wait untagged until this is back on)", at.enabled, (on) => { at.enabled = on; syncAt(); })
  );
  syncAi();
  syncAt();
  // Mounted here, after the state the fold summary reads exists. An existing
  // board carries its knobs and their vocabulary in the settings payload, so
  // this needs no feed and no admin rights.
  if (!isNew) mountCapConfigs(board.capability_config);

  // Per-board capability pins (admin only) — one strip row per capability the
  // capabilities feed says boards may pin, each planned by planBoardPicker
  // (capability-present.js, pure and node-tested: rows, preselect, model axis,
  // and the exact column-named save body) and mounted as a fold-out row in the
  // AI-models strip. Nothing in this loop names a capability — a new
  // board-scoped capability gets its row with no edit here.
  const capPickers = []; // { cap, plan, row, valEl, srcEl, keySel, modelSel }
  let aiLoaded = false;
  // The bands resolve through delegation (an unset extractor follows the
  // tagger), so they derive from closures set once the feed lands; until then
  // the bands stay hidden and the strip head says nothing.
  // Bands for the Mapping pane, keyed by capability id — one entry per
  // mappingBand capability in the feed (extract, detect, and whatever a future
  // source's capability declares). {} until the feed lands.
  let mappingBands = () => ({});
  let openCapRow = () => {};
  if (canEditAI) {
    const wrap = document.getElementById("board-modal-caps");
    Promise.all([
      api("GET", "/api/admin/ai-keys"),
      loadProviders(),
      api("GET", "/api/admin/capabilities"),
    ]).then(([keys, catalog, feed]) => {
      const catByName = byName(catalog);
      const caps = feed.capabilities || [];
      for (const cap of caps.filter((c) => c.boardBinding)) {
        const plan = planBoardPicker(cap, keys, board, catByName);
        const row = document.createElement("div");
        row.className = "frow";
        const head = document.createElement("div");
        head.className = "frow-head";
        const left = document.createElement("div");
        const name = document.createElement("div");
        name.className = "frow-name";
        name.textContent = cap.label;
        const desc = document.createElement("div");
        desc.className = "frow-desc";
        desc.textContent = cap.blurb || "";
        left.append(name, desc);
        const cur = document.createElement("div");
        cur.className = "frow-cur";
        const valEl = document.createElement("span");
        valEl.className = "frow-val";
        const srcEl = document.createElement("span");
        srcEl.className = "frow-src";
        cur.append(valEl, srcEl);
        head.append(left, cur);
        // One row open at a time — the strip is a status list first.
        head.addEventListener("click", () => {
          const open = !row.classList.contains("open");
          for (const p of capPickers) p.row.classList.remove("open");
          row.classList.toggle("open", open);
        });
        const edit = document.createElement("div");
        edit.className = "frow-edit";
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
        keySel.onchange = () => { syncModel(); updateAiPresentation(); };
        modelSel.onchange = () => updateAiPresentation();
        syncModel();
        edit.append(keySel, modelSel);
        row.append(head, edit);
        wrap.appendChild(row);
        capPickers.push({ cap, plan, row, valEl, srcEl, keySel, modelSel });
      }

      // A NEW board has no settings payload, so its knobs come off the feed
      // (creating a board is admin-only, so the feed is always available
      // here). Same field shape either way — see mountCapConfigs.
      if (isNew) mountCapConfigs(caps.flatMap((c) => c.config || []));

      // Which pickers feed which bands comes from data, not names: every
      // capability flagged mappingBand gets a band in the Mapping pane (keyed
      // by capability id — the pane joins them to sources via the source
      // table's `capability`). The one that delegates (extract → tag) also
      // names the Tagging pane's band, same as before.
      const bandCaps = caps.filter((c) => c.mappingBand);
      const bandPickers = bandCaps
        .map((c) => capPickers.find((p) => p.cap.id === c.id))
        .filter(Boolean);
      const delegatingCap = bandCaps.find((c) => c.delegatesTo);
      const tagPicker = capPickers.find((p) => p.cap.id === delegatingCap?.delegatesTo) || null;

      const chosen = (p) => p.plan.chosenLabel(p.keySel.value, p.modelSel.hidden ? null : p.modelSel.value || null);
      // WHICH picker actually decides a capability's model: itself, unless it is
      // delegating and unset, in which case its target's — resolved live, so
      // unsaved edits to that target count.
      // `plan.delegated`, never `cap.delegatesTo`: the feed ships the latter for
      // any delegate-floored capability, INCLUDING one that has an app-wide
      // default of its own and therefore isn't following anyone. Reading the
      // raw field made this walk to the tagger in exactly that case, so the
      // band named the tagger's model while extraction ran on its own binding.
      const decider = (p) =>
        (!p.keySel.value && p.plan.delegated && capPickers.find((x) => x.cap.id === p.cap.delegatesTo)) || p;
      const resolved = (p) => chosen(decider(p));
      // What a BAND should say: the model that will run, or null plus the copy
      // for having none. A band is a sentence, so it asks `configured` first —
      // "Using none configured" is the claim it exists not to make. The agent
      // noun comes from whichever capability actually decides, so an unset
      // extractor short of a tagger names the tagger.
      const bandState = (p) => {
        const d = decider(p);
        return {
          label: d.plan.configured(d.keySel.value) ? chosen(d) : null,
          empty: `No ${d.cap.agent} configured`,
        };
      };
      mappingBands = () =>
        Object.fromEntries(bandPickers.map((p) => [p.cap.id, bandState(p)]));

      const openStripAt = (p) => {
        if (!p) return;
        setStripOpen(true);
        for (const x of capPickers) x.row.classList.toggle("open", x === p);
        p.row.classList.remove("flash");
        void p.row.offsetWidth; // restart the highlight animation
        p.row.classList.add("flash");
        p.row.scrollIntoView({ block: "nearest" });
      };
      openCapRow = (capId) => openStripAt(capPickers.find((p) => p.cap.id === capId));
      openTagRow = () => openStripAt(tagPicker);

      // Web research is a modifier of the tagging capability: available only
      // while the tagging provider advertises it. Provider-level truth from
      // the catalog (provides.research); the who-could list for the disabled
      // hint from the feed's modifier roster. No provider names here.
      const researchMod = (tagPicker?.cap.modifiers || []).find((m) => m.id === "research");
      researchNeeds = researchMod?.supportedBy?.length ? researchMod.supportedBy.join(" / ") : null;
      if (tagPicker && researchMod) {
        researchAvailable = () => {
          const sel = tagPicker.keySel.value;
          const provider = /^\d+$/.test(sel)
            ? keys.find((k) => String(k.id) === sel)?.provider
            : (sel || tagPicker.cap.running?.provider || null);
          return !!(provider && catByName[provider]?.provides?.research);
        };
      }

      const summaryEl = document.getElementById("board-modal-models-summary");
      const updateAiPresentation = () => {
        for (const p of capPickers) {
          p.valEl.textContent = chosen(p);
          p.srcEl.textContent = p.keySel.value
            ? "chosen for this board"
            : p.plan.delegated ? resolved(p) : "app default";
        }
        const n = capPickers.filter((p) => p.keySel.value).length;
        summaryEl.textContent = tagPicker
          ? chosen(tagPicker) + (n ? ` · ${n} board choice${n === 1 ? "" : "s"}` : " · all app defaults")
          : "";
        tagBand?.set(tagPicker ? bandState(tagPicker) : null);
        mappingPane?.setBands(mappingBands());
        syncAi(); // research availability follows the tagging selection
      };
      updateAiPresentation();
      aiLoaded = true;
    }).catch(() => {});
  }

  // Autofocus the name only for a NEW board, where an empty name is the first
  // thing to fill in. Opening an EXISTING board is not a rename — the reader
  // came for the settings below — so a caret parked in a filled name field
  // misnames the modal's purpose and puts a stray keystroke into the board's
  // name. Esc still closes either way: modal.js listens on the document.
  if (isNew) document.getElementById("board-modal-name").focus();

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
    // Board-scoped knobs are NOT admin-gated (the manager route accepts them),
    // so they ride outside the pin block — same full-state rule: blank clears
    // the column and the board follows the app default again. The array is
    // empty until the rows mount, so an early save leaves the columns alone.
    for (const c of capConfigs) Object.assign(aiOverride, c.plan.payload(c.sel.value));
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
    // Fold a touched mapping into the same save. Only when the admin actually
    // edited it — an untouched pane omits `mapping` so an edit stays a light
    // tagging update (no server-side reschedule/backfill). The canEditAI gate
    // mirrors the server's own rule (mapping is an admin-layered field; a
    // non-admin body carrying one is ignored), so an editable pane and a
    // saveable mapping are the same population.
    if (mappingPane && canEditAI && mappingPane.isDirty()) {
      const res = mappingPane.collect();
      if (!res.ok) return; // collect() already toasted the reason
      Object.assign(payload, res.payload);
    }
    try {
      let saved = payload;
      // ONE save endpoint for every edit — the server layers admin fields
      // (pins, mapping) off the session's own role, so the client never has
      // to know which identity it holds to pick a URL. Creation stays the
      // admin route: it's a global-admin power, not a board-scoped one.
      if (isNew) saved = await api("POST", "/api/admin/boards", payload);
      else await api("PATCH", `/api/boards/${board.id}`, payload);
      close();
      onSaved?.(saved);
      toast(isNew ? `Board "${name}" created` : `Board "${name}" saved`);
    } catch (err) { toast.error(err.message); }
  };
}
