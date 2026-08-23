// The entity-mapping pane, rebuilt around the field-sources model
// (planning/field-sources-plan.md): every mapped value names its SOURCE —
// connector, file, extract, detect — and the pane draws all of them the same
// way. Identity and face are definition rows (glyph, small mono label, plain
// value line); fields are uniform tiles; everything is edited in a bottom
// drawer (modal.js createDrawer) that buffers a draft and commits on its one
// primary button. Adding a field goes through a dark source menu: catalog
// sources (connector, file) list their fields right in the menu and add on
// click; open sources (extract, detect) proceed to the drawer. Violet glyphs
// and tints mark the sources a model produces; grey is deterministic.
//
// Imports are relative on purpose: an ES module specifier resolves against the
// URL of the module doing the importing, never against the page's — so
// `./toast.js` is `/toast.js` whether the document is `/`, `/boards` or
// `/admin.html` (see board-modal.js for what the root-absolute form cost).
import { toast } from "./toast.js";
import { openDropdown, ddRow, ddSep, ddEmpty, ddChips, ddHead } from "./dropdown.js";
import { ICONS, sentence } from "./utils.js";
import { switchRow } from "./board-modal.js";
import { sectionHeadingEl, provBand, keepPlace, createDrawer } from "./modal.js";
import { fillSelect } from "./select.js";

// Refresh cadence choices (minutes) this pane OFFERS. 0 = once: the field is
// fetched when the entity is added and never re-pulled. The words are the
// pane's summary vocabulary too — a tile reads "Crypto · number · every 15 min"
// and the face row "a 1y price chart, once", so the labels have to survive
// being read mid-sentence.
const CADENCES = [
  [0, "once"], [1, "every minute"], [5, "every 5 min"], [15, "every 15 min"],
  [60, "hourly"], [360, "every 6 hours"], [1440, "daily"],
];
// The server accepts any 1–43200 minutes; a value this list doesn't carry
// still needs a name (see cadenceSelect for where that matters most).
const cadenceLabel = (n) => CADENCES.find(([m]) => m === n)?.[1] || `every ${n} min`;
const cadWord = (bearer) => cadenceLabel(bearer?.refresh?.every ?? 0);

// `url` keeps its wire id; the UI calls it "link" everywhere a kind is shown.
const kindWord = (k) => (k === "url" ? "link" : k);
const quote = (s) => `“${s}”`;
const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));

// ── The client source table ─────────────────────────────────────────────────
// Mirror of server/field-sources.js FIELD_SOURCE_DEFS — the client can't import
// server modules, so the structural facts are restated here next to the
// presentation the wire deliberately doesn't carry (labels, menu helpers,
// glyphs, tile summaries). KEEP THE TWO IN STEP. Everything below the glyph is
// read by generic code — the add menu, the field drawer and collect() ask this
// table what a source needs instead of branching on its id, so a new source is
// a row here (plus its server row) rather than another arm in three switches.
//
//   glyph       ICONS name; `ai` decides its ink (.mm-glyph.ai = violet).
//   capability  which capability runs it — drives the provenance bands; null =
//               deterministic, no model, no band.
//   catalog     bound to a closed vocabulary, named with the server's own
//               vocabulary ids ("connector" | "media"): the entry decides key,
//               kind AND fn together, so the menu lists entries and no drawer
//               asks. The pane's CATALOGS registry resolves the name to the
//               fetched list. Absent = the user names the field themselves.
//   kinds       the formats a user may pick, in display order. Absent with a
//               catalog = the catalog's kind; absent without one = no kind at
//               all (detect emits located hits, not a scalar).
//   ask         the server's `takesInstruction`, carrying the copy the wire
//               doesn't: the instruction editor's label, placeholder and hint.
//   refreshable the value can change under us — offer a re-pull cadence.
//   filesOnly   needs stored files to act on, so a connector board doesn't
//               offer it — there is nothing there to look at. (The server's
//               flag of the same name REJECTS such a field; here it only
//               withholds it, which is why detect carries it on this side
//               only: on a connector board it would collect nothing rather
//               than mean nothing.)
//   connectorOnly the value is pulled from the bound domain, so a files board
//               doesn't offer it — the dual of filesOnly, mirroring the
//               server's flag of the same name.
//   cap         per-board ceiling on fields of this source (extract fields feed
//               the extraction schema; detect fields add detector queries).
//   label       menu/drawer name — a function of ctx because the connector's
//               name is the domain's ("Live data · Crypto"), learned at runtime.
//   menuNote    the add-menu helper: what the AI does about it, or the useful
//               opposite ("no AI — …").
//   tile        the one-line summary a tile / def row shows for a binding.
const SOURCES = {
  connector: {
    id: "connector", glyph: "srcGlobe", ai: false, capability: null,
    catalog: "connector", connectorOnly: true, refreshable: true,
    label: (ctx) => (ctx.connectorLabel ? `Live data · ${ctx.connectorLabel}` : "Live data"),
    menuNote: "no AI — pulled on a schedule",
    tile: (f, ctx) => `${ctx.connectorLabel || "Live data"} · ${kindWord(f.kind)} · ${cadWord(f)}`,
  },
  file: {
    id: "file", glyph: "srcFile", ai: false, capability: null,
    catalog: "media", filesOnly: true,
    label: () => "File metadata",
    menuNote: "no AI — read from the file",
    tile: (f) => `From the file · ${kindWord(f.kind)}`,
  },
  extract: {
    id: "extract", glyph: "srcSparkle", ai: true, capability: "extract",
    kinds: ["text", "number", "date", "url"], cap: 12,
    ask: {
      label: "AI instruction",
      placeholder: "AI instruction — describe what to extract and from where (e.g. \"the candidate's full name\")",
      hint: "Sent to the model for every item.",
    },
    label: () => "AI extraction",
    menuNote: "AI answers from the item's content",
    tile: (f) => `AI extraction · ${kindWord(f.kind)}${f.instruction ? ` · ${quote(f.instruction)}` : ""}`,
  },
  detect: {
    id: "detect", glyph: "srcFrame", ai: true, capability: "detect",
    cap: 12, filesOnly: true,
    ask: {
      label: "Object to detect",
      placeholder: "the object to detect — e.g. \"cat\"; commas are synonyms for the same thing",
      hint: "The detection engine scans every image for it — one field, one kind of thing.",
    },
    label: () => "Object detection",
    menuNote: "AI finds them in each image",
    tile: (f) => `Object detection · ${quote(f.instruction || "…")}`,
  },
};

// User-named field keys: lowercase snake, must start with a letter. The key is
// written to the draft on EVERY keystroke and merely re-displayed on blur —
// writing only on blur loses the key when a rebuild replaces the focused input
// (removing a focused element does not reliably fire `blur` in any browser).
// Normalizing on input keeps the draft the same value blur would produce; the
// DISPLAY is left alone until blur — rewriting under a live caret is rude.
const normalizeKey = (v) =>
  v.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^[^a-z]+/, "") || "";

// Builds the entity-mapping editor into `container` — a pane inside the board
// modal (board-modal.js), which owns the modal chrome + the single Save button.
// Returns { isDirty, collect, setBands }: the host folds collect()'s payload
// into its one PATCH/POST, and names the models behind the provenance bands
// via setBands. Fully parameterized (no gallery-state reads), so it works on
// admin.html and for not-yet-created boards:
//   isAdmin  — editable pane; false = read-only view
//   mapping  — the board's current mapping (null for a new/unmapped board)
//   hasItems — locks the connector-template picker (templates rewire the whole
//              mapping, only sane while the board is empty)
//   onCapabilityChange — a band's "Change" action, handed the capability id:
//              the host opens its AI-models strip at that capability's row
export function buildMappingPane({ container, isAdmin = false, mapping = null, hasItems = false, onCapabilityChange = null }) {
  // Any user edit flips the pane dirty, so a pure-tagging save omits `mapping`
  // and doesn't needlessly re-run the server's reschedule/backfill.
  let dirty = false;
  const markDirty = () => { dirty = true; };

  // Clone the current mapping so edits are buffered until Save. The state IS
  // the new wire shape — no per-slot from/hint/candidates translation layer.
  let fields = (mapping?.fields || []).map((f) => ({ ...f }));
  let identityCfg = clone(mapping?.identity) || null; // null = the filename
  let faceCfg = clone(mapping?.face) || null;         // null = the slot default
  let inputConnector = mapping?.input?.connector || null;

  // The bound domain's whole row from /api/connectors — label, field catalog,
  // face producers, its own words for the identity slot, providers, and whether
  // it can serve at all (`available`/`reason`, the capabilities feed's ladder).
  // ONE object, not eight parallel lets: every place that (re)binds a domain —
  // the catalog fetch, a template apply, a template clear — sets it in a single
  // assignment, so the pane can't half-agree with itself about which domain it
  // is describing. null = no connector, or its row hasn't landed yet.
  let conn = null;
  const faces = () => conn?.faces || [];
  // The domain's field catalog, with the two absences kept apart: null = the row
  // hasn't landed (the menu is right to say "loading"), [] = it landed and
  // declares no fields, which is a loaded catalog that happens to be empty.
  const connCatalog = () => (conn ? conn.fields || [] : null);
  // Availability starts optimistic by construction: until the row lands there
  // is nothing to accuse the domain of, and a banner that flashes on every open
  // would be its own lie.
  const unavailable = () => !!inputConnector && conn?.available === false;

  let fileFieldCatalog = null;   // file-metadata field catalog (server/media) — file boards only
  let catalogFailed = false;     // a catalog fetch LOST (vs still in flight) — the add menu says which

  // SOURCES[..].catalog names a vocabulary; this resolves the name to the
  // fetched list (behind getters — both land after the pane builds). The one
  // place a catalog NAME is enumerated: everywhere else asks catalogFor.
  const CATALOGS = { connector: connCatalog, media: () => fileFieldCatalog };
  const catalogFor = (def) => (def?.catalog ? CATALOGS[def.catalog]() : null);

  const ctx = { get connectorLabel() { return conn?.label || null; } };
  const srcLabel = (def) => def.label(ctx);
  const tileSum = (f) => (SOURCES[f.source] ? SOURCES[f.source].tile(f, ctx) : f.source);

  // ── Provenance bands, one per capability ──────────────────────────────────
  // Which capability runs a source comes from the table, never a name — a
  // future capability-backed source is covered by its row alone. The host
  // pushes the whole map via setBands (only it can see the strip's unsaved
  // edits and follow delegation); the pane decides which bands are VISIBLE:
  // one line per capability the current edited mapping actually uses. The
  // pushed map is stored and re-applied after every re-render — same problem
  // the old setExtractionBand pattern solved, same fix: the band elements are
  // stable, only their state is replayed.
  const bands = new Map(); // capability id → provBand
  if (isAdmin) {
    for (const def of Object.values(SOURCES)) {
      if (def.capability && !bands.has(def.capability)) {
        const capId = def.capability;
        const band = provBand(() => onCapabilityChange?.(capId));
        band.el.style.margin = "2px 0";
        bands.set(capId, band);
      }
    }
  }
  let lastBands = {};
  const usedCapabilities = () => {
    const used = new Set();
    // Slots and fields alike ask the table for their capability — never a name
    // check, so a future capability-backed source (the planned face/voice
    // matching) is covered by its SOURCES row alone.
    for (const slot of [identityCfg, faceCfg]) {
      const cap = SOURCES[slot?.source]?.capability;
      if (cap) used.add(cap);
    }
    for (const f of fields) {
      const cap = SOURCES[f.source]?.capability;
      if (cap) used.add(cap);
    }
    return used;
  };
  const applyBands = () => {
    const used = usedCapabilities();
    for (const [capId, band] of bands) band.set(used.has(capId) ? lastBands[capId] ?? null : null);
  };
  const setBands = (map) => { lastBands = map || {}; applyBands(); };

  // ── Small builders ────────────────────────────────────────────────────────
  const glyphEl = (name, ai) => {
    const el = document.createElement("span");
    el.className = "mm-glyph" + (ai ? " ai" : "");
    el.innerHTML = ICONS[name] || ICONS.srcDot;
    return el;
  };
  // A select over [value, label] pairs. Options go through select.js's
  // fillSelect, the same filler the board editor uses; pairs are the terser
  // shape for the short literal lists this pane declares. No placeholder:
  // every list here is closed and always has a current value to sit on. No
  // read-only handling either — every select now lives inside a drawer, and
  // drawers only open on the admin pane.
  const mkSel = (opts, val, title) => {
    const sel = document.createElement("select");
    if (title) sel.title = title;
    fillSelect(sel, opts.map(([value, label]) => ({ value, label })), { value: val });
    return sel;
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  // Drawer form group: uppercase label / control / quiet hint.
  const group = (label, control, hint) => {
    const g = el("div", "dw-group");
    if (label) g.appendChild(el("div", "dw-label", label));
    g.appendChild(control);
    if (hint) g.appendChild(el("div", "dw-hint", hint));
    return g;
  };
  // Horizontal source card (drawer slot pickers).
  const srcCard = ({ glyph, ai, lab, note, pressed, onPick }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mm-srcopt" + (ai ? " ai" : "");
    b.setAttribute("aria-pressed", String(!!pressed));
    b.appendChild(glyphEl(glyph, ai));
    b.appendChild(el("span", "lab", lab));
    if (note) b.appendChild(el("span", "note", note));
    if (onPick) b.addEventListener("click", onPick);
    return b;
  };

  // The drawer rises over the WHOLE modal dialog, not just this pane — built
  // lazily so a read-only view (which never opens one) doesn't hang a sheet
  // off the modal for nothing.
  let drawerInst = null;
  const drawer = () => (drawerInst ??= createDrawer(container.closest(".modal-dialog") || container));
  const drawerHeadParts = (glyphName, ai, title, src) => {
    const g = glyphEl(glyphName, ai);
    const t = el("span", "drawer-title", title);
    const s = el("span", "drawer-src", src);
    return { nodes: [g, t, s], g, t, s };
  };

  // The host (board-modal) provides a flex-column container and owns its
  // visibility via the Mapping/Tagging toggle — so we never set `display` here,
  // where an inline display:flex would defeat the host's display:none.
  // Real data edits fire input/change; the drawer commits and the structural
  // ops (add/remove/apply-template) call markDirty() at their handlers.
  container.addEventListener("input", markDirty, true);
  container.addEventListener("change", markDirty, true);
  const body = container;

  // ── Template row ──────────────────────────────────────────────────────────
  // Very top of the body, right-aligned, divider below. It reads as a select,
  // not a load action: the board is ALWAYS on a template ("Files" is the one it
  // starts on), so the control names the current one and the menu switches
  // between them. A "Load template…" button implied the opposite — that nothing
  // was loaded yet and the only move was forward. Switching rewires the whole
  // mapping (input, identity, face, fields) in one click, which only makes
  // sense while the board is empty: existing items were ingested under the
  // current input source, so once the first item lands the picker locks.
  // Neither switch toasts. A pick is a pending edit like typing in a field —
  // nothing is saved until the host's Save — and the pane visibly redrawing
  // around it is the feedback. A toast here would announce a change that
  // hasn't happened yet.
  let templateBtn = null;
  let templateBtnValue = null;
  function syncTemplateBtn() {
    if (!templateBtnValue) return;
    templateBtnValue.textContent = inputConnector ? (conn?.label || inputConnector) : "Files";
  }
  if (isAdmin) {
    const templateRow = document.createElement("div");
    templateRow.className = "mm-template-row";
    const templateLabel = el("span", "mm-template-label", "Template");
    templateBtn = document.createElement("button");
    templateBtn.type = "button";
    templateBtn.className = "dd-trigger";
    templateBtnValue = el("span", "dd-trigger-value");
    const chev = el("span", "dd-caret");
    chev.innerHTML = ICONS.chevron;
    templateBtn.append(templateBtnValue, chev);
    syncTemplateBtn();
    if (hasItems) {
      templateBtn.disabled = true;
      const why = inputConnector
        ? "This board already has items, so its connector template can't be changed or removed. Create a new board to use a different template."
        : "This board already has items, so a template can't be applied — its items came from file uploads. Create a new board to start from a template.";
      templateBtn.title = why;
      templateRow.title = why;
    } else templateBtn.addEventListener("click", async () => {
      templateBtn.disabled = true;
      let connectors;
      try {
        // Both checks earn their keep: fetch resolves on a 4xx/5xx just as
        // happily as on a 200, and the body then is `{ error }` — an object
        // whose `.length` is undefined and which `for…of` refuses. That threw
        // inside openDropdown's build() and left a half-drawn menu saying
        // nothing at all, which is how a 500'd catalog used to present.
        const r = await fetch("/api/connectors");
        if (!r.ok) throw new Error(String(r.status));
        connectors = await r.json();
        if (!Array.isArray(connectors)) throw new Error("not a list");
      } catch {
        toast.error("Failed to load connectors");
        return;
      } finally {
        templateBtn.disabled = false;
      }
      openDropdown(templateBtn, {
        align: "end",
        minWidth: 220,
        build: (menuBody, { close }) => {
          // "Files" is the no-connector template — the state a board starts in.
          // Listing it is what makes this a switch rather than a one-way door:
          // with only connectors on the menu there was nothing to pick to undo
          // one. It's first because it's where every board begins.
          menuBody.appendChild(ddRow({
            label: "Files",
            sublabel: "No connector — items come from uploads",
            active: !inputConnector,
            onClick: () => { clearTemplate(); close(); },
          }));
          if (connectors.length) menuBody.appendChild(ddSep());
          for (const c of connectors) {
            // A domain with nothing installed behind it is LISTED, dimmed, and
            // still pickable. Listed, because hiding it answers "where did
            // Stocks go" with silence — and the deployment that has no Stocks
            // provider is exactly the one whose admin needs to learn that
            // Stocks exists. Pickable, because a template is a mapping shape,
            // not a live connection: setting the board up now and adding the
            // provider after is a real order to do this in, and the board
            // stays empty either way until one lands. What isn't optional is
            // saying so — here at the point of choosing, and again in the pane
            // for as long as the board is on it.
            const row = ddRow({
              label: c.label,
              sublabel: c.available === false ? sentence(c.reason) || "No provider installed" : `Live data from ${c.label}`,
              active: inputConnector === c.name,
              onClick: () => { applyTemplate(c); close(); },
            });
            if (c.available === false) row.classList.add("dd-row--unavailable");
            menuBody.appendChild(row);
          }
        },
      });
    });
    templateRow.append(templateLabel, templateBtn);
    body.appendChild(templateRow);
  }

  // ── The bound domain's outage, stated for as long as the board is on it ───
  // The menu row's dim sublabel is only seen by whoever opens the menu, and the
  // board that most needs this explanation is the one nobody is switching: an
  // existing board whose provider went away. Its picker is LOCKED by hasItems
  // and its connector tiles render exactly as they always did — so without this
  // line the pane's whole answer to "why has nothing updated in a week" is a
  // confident silence.
  //
  // Not admin-gated: a board-admin reading the pane read-only is owed an answer
  // too. Amber, borrowing the face hint box — the same class of statement (a
  // thing you configured cannot currently render), one step up in scope.
  const unavailBanner = document.createElement("div");
  unavailBanner.className = "mm-face-hint mm-unavail";
  unavailBanner.hidden = true;
  body.appendChild(unavailBanner);
  function syncUnavailable() {
    const show = unavailable();
    unavailBanner.hidden = !show;
    if (!show) return;
    // The diagnosis names a provider and its key state, so the server ships it
    // to admins only — and this reads the ABSENCE rather than a role flag, so
    // there is no second copy of that rule here to fall out of step with it.
    // Without the reason the banner still has to answer the question that
    // brought the reader here, so the cause degrades from the diagnosis to the
    // plain fact, and the remedy from an instruction to who owns it.
    const cause = sentence(conn.reason) || `${conn.label || "This board's data source"} isn't available`;
    const remedy = conn.reason ? "Fix this in Admin → Plugins." : "Ask an admin to check the Plugins page.";
    unavailBanner.textContent = `${cause}, so this board can't fetch or refresh its data. ${remedy}`;
  }

  // ── The sheet: def rows, tiles, bands ─────────────────────────────────────
  // One render that is always right, rebuilt wholesale on every structural
  // edit and wrapped in keepPlace (modal.js) — the pane lives in a scrolling
  // modal body, and without it any edit dropped the reader at the top. Def
  // rows and tile buttons carry data-place so the control that opened a drawer
  // gets focus back after the commit's re-render.
  const sheet = document.createElement("div");
  body.appendChild(sheet);

  const render = keepPlace(sheet, () => {
    sheet.replaceChildren();

    const defs = el("div", "mm-def");
    defs.append(identityDefRow(), faceDefRow());
    sheet.appendChild(defs);

    const heading = sectionHeadingEl("Extract Fields");
    heading.style.margin = "10px 0 8px";
    sheet.appendChild(heading);

    const tiles = el("div", "mm-tiles");
    fields.forEach((f, i) => tiles.appendChild(fieldTile(f, i)));
    if (isAdmin) {
      const add = document.createElement("button");
      add.className = "fe-add-facet";
      add.type = "button";
      add.textContent = "+ Add field";
      add.dataset.place = "add-field";
      add.addEventListener("click", () => openAddFieldMenu(add));
      tiles.appendChild(add);
    } else if (!fields.length) {
      tiles.appendChild(el("p", "mm-empty", "No fields defined."));
    }
    sheet.appendChild(tiles);

    if (bands.size) {
      const prov = document.createElement("div");
      prov.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-top:12px;";
      for (const band of bands.values()) prov.appendChild(band.el);
      sheet.appendChild(prov);
    }
    applyBands();
  });

  // A definition row: glyph + small mono label + plain value line (+ options
  // preview). A LOCKED slot (connector identity: the domain supplies it,
  // nothing to configure; a file face under filename identity: one instance,
  // nothing to pick) renders as a statement, not a control — no chevron, no
  // hover, no drawer.
  function defRow({ glyph, ai, label, value, none, more, onOpen, place }) {
    const locked = !onOpen;
    const row = document.createElement(locked ? "div" : "button");
    if (!locked) {
      row.type = "button";
      if (place) row.dataset.place = place;
    }
    row.className = "mm-def-row" + (ai ? " ai" : "") + (locked ? " locked" : "");
    row.appendChild(glyphEl(glyph, ai));
    const bodyEl = el("div", "mm-def-body");
    bodyEl.appendChild(el("div", "mm-def-label", label));
    bodyEl.appendChild(el("div", "mm-def-val" + (none ? " none" : ""), value));
    if (more) bodyEl.appendChild(el("div", "mm-def-more", more));
    row.appendChild(bodyEl);
    if (!locked) row.addEventListener("click", onOpen);
    return row;
  }

  function identityDefRow() {
    if (inputConnector) {
      // Identity on a connector board is not a choice — the domain supplies
      // it, in the domain's own words (the manifest names the thing, never the
      // architecture: "each coin is its own card", not "connector id").
      return defRow({
        glyph: "srcGlobe", ai: false, label: "identity",
        value: conn?.identity?.blurb || "each entry is its own card",
      });
    }
    const bound = identityCfg?.source === "extract";
    return defRow({
      glyph: bound ? "srcSparkle" : "srcDot", ai: bound, label: "identity",
      value: bound ? (identityCfg.instruction || "not said yet") : "each file is its own card",
      none: !bound,
      more: bound && identityCfg.options?.length
        ? identityCfg.options.map((o) => o.value).filter(Boolean).join("  ·  ")
        : null,
      onOpen: isAdmin ? openIdentityDrawer : null,
      place: "def:identity",
    });
  }

  function faceDefRow() {
    if (inputConnector) {
      // The face is the connector's producer — THE SYMBOL TILE IS NOT A CHOICE
      // HERE. It isn't a producer at all (there's no tile in server/faces);
      // it's what a card draws when nothing renders, which is exactly what
      // happens when a producer is unavailable or its series comes back empty.
      // Offering it as a peer of "Price chart" dressed a fallback up as a
      // decision. A domain with no producer at all gets the tile named as the
      // whole answer, locked.
      const cfg = faceCfg?.source === "connector" ? faceCfg : null;
      const producer = faces().find((p) => p.name === cfg?.producer) || faces()[0] || null;
      return defRow({
        glyph: "srcGlobe", ai: false, label: "face",
        value: cfg ? `a ${cfg.period} ${(producer?.label || "chart").toLowerCase()}, ${cadWord(cfg)}` : "the symbol tile",
        none: !cfg,
        onOpen: isAdmin && faces().length ? openConnectorFaceDrawer : null,
        place: "def:face",
      });
    }
    // A file board's face is always the file preview. Under extract identity
    // an entity can bundle several instances, so WHICH file supplies the
    // preview is configurable; under filename identity there is one instance
    // per entity and nothing to pick — locked, like connector identity.
    if (identityCfg?.source !== "extract") {
      return defRow({ glyph: "srcFile", ai: false, label: "face", value: "the file's preview" });
    }
    const cfg = faceCfg?.source === "file" ? faceCfg : null;
    return defRow({
      glyph: "srcFile", ai: false, label: "face",
      value: `the ${cfg?.pick || "first"} ${cfg?.prefer || "image"} added`,
      onOpen: isAdmin ? openFileFaceDrawer : null,
      place: "def:face",
    });
  }

  function fieldTile(f, i) {
    const def = SOURCES[f.source];
    // A field whose source this build has no row for still renders and can
    // still be REMOVED — there's just no editor to open for it, because we
    // don't know what it would ask. (collect() passes such a field through
    // untouched for the same reason.)
    const editable = isAdmin && !!def;
    const tile = el("div", "mm-tile" + (def?.ai ? " ai" : ""));
    const main = document.createElement(editable ? "button" : "div");
    main.className = "mm-tile-main";
    if (editable) {
      main.type = "button";
      main.dataset.place = `tile:${f.source}:${f.key || i}`;
    } else {
      main.style.cursor = "default"; // the class assumes a button; this one isn't
    }
    main.appendChild(glyphEl(def?.glyph || "srcDot", !!def?.ai));
    const b = el("div", "mm-tile-body");
    b.appendChild(el("div", "mm-tile-name", f.key || "unnamed"));
    b.appendChild(el("div", "mm-tile-sum", tileSum(f)));
    main.appendChild(b);
    if (editable) main.addEventListener("click", () => openFieldDrawer({ mode: "edit", index: i }));
    tile.appendChild(main);
    if (isAdmin) {
      const rm = document.createElement("button");
      rm.className = "mm-tile-rm";
      rm.type = "button";
      rm.textContent = "×";
      rm.setAttribute("aria-label", `Remove ${f.key || "field"}`);
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        fields.splice(i, 1);
        markDirty();
        render();
      });
      tile.appendChild(rm);
    }
    return tile;
  }

  // ── "+ Add field": the source menu ────────────────────────────────────────
  // The open sources first — the ones that ask a question worth thinking about
  // — then the input's catalog, laid out as chips. Order and layout are the
  // same decision: as a column of one-line rows the ~15-entry file catalog ran
  // past the bottom of the menu and took AI extraction and Object detection
  // with it, so the two choices that shape a board were the two you couldn't
  // see. The menu also opens at the width of the button that summons it
  // (`width: "anchor"`), which is what gives the chips room to be a glance
  // rather than a list.
  //
  // Extract is offered everywhere; detect only where there are files to look
  // at — connector boards have no images. Media-kind gating beyond that is
  // deliberately skipped: the board's media mix isn't reliably known
  // client-side, and the server validates anyway.
  const menuNoteEl = (text) => {
    const s = el("span", null, text);
    // pointer-events off so a click on the helper still lands on the row —
    // ddRow treats trailing clicks as the trailing element's own.
    s.style.cssText = "margin-left:14px;font-size:11px;color:#79808c;text-align:right;pointer-events:none;";
    return s;
  };
  // A source's own row: glyph, name, and what it does about the field. With no
  // handler it's a HEADER — the catalog source, whose entries follow it and
  // which isn't itself pickable. With one it IS the pick: an open source has
  // nothing to list, so choosing it goes straight to a drawer.
  const sourceRow = (id, onClick) => {
    const def = SOURCES[id];
    const lead = glyphEl(def.glyph, def.ai);
    lead.style.pointerEvents = "none";
    return ddRow({ label: srcLabel(def), leading: lead, trailing: menuNoteEl(def.menuNote), onClick });
  };
  // A catalog entry adds IMMEDIATELY — its key, kind and fn are all decided by
  // the catalog, so there is nothing left for a drawer to ask. The chip's title
  // carries what the chip itself can't: the catalog's human name for the field,
  // its kind, and — for one already on the board — why it isn't pickable.
  const catalogChip = (sourceId, cat, added, close) => ({
    label: cat.key,
    mono: true,
    disabled: added,
    title: added
      ? `${cat.label || cat.key} — already a field on this board`
      : `${cat.label || cat.key} · ${kindWord(cat.kind)}${cat.note ? ` · ${cat.note}` : ""}`,
    onClick: () => {
      fields.push({ key: cat.key, kind: cat.kind, source: sourceId, fn: cat.fn });
      markDirty();
      close();
      render();
    },
  });

  function openAddFieldMenu(anchor) {
    // The board's input decides which catalog source it offers: the one whose
    // board-type flag fits. Never both — the input is one or the other.
    const catDef = Object.values(SOURCES).find((d) =>
      d.catalog && !(d.filesOnly && inputConnector) && !(d.connectorOnly && !inputConnector));
    const catalog = catalogFor(catDef);
    openDropdown(anchor, {
      align: "start",
      width: "anchor",
      // Row-counting is meaningless once a group of chips is one child; the
      // viewport-room cap inside the component still keeps it on screen.
      maxItems: 0,
      build: (menuBody, { close }) => {
        // Open sources, straight off the table — each needs a drawer (nothing
        // to list: the user names the field and says what it means).
        for (const def of Object.values(SOURCES)) {
          if (def.catalog || (def.filesOnly && inputConnector) || (def.connectorOnly && !inputConnector)) continue;
          menuBody.appendChild(sourceRow(def.id, () => {
            close();
            openFieldDrawer({ mode: "new", source: def.id });
          }));
        }
        menuBody.appendChild(ddSep());
        menuBody.appendChild(sourceRow(catDef.id));
        if (!catalog) {
          menuBody.appendChild(ddEmpty(catalogFailed
            ? "Couldn't load the field catalog — reopen the modal to retry"
            : "Loading fields…"));
          return;
        }
        const taken = new Set(fields.filter((f) => f.source === catDef.id).map((f) => f.fn));
        // Sectioned by the catalog's own `group` where it declares one (file
        // fields do: All files / Images / …). A catalog without groups, like
        // the connector manifests', is one unheaded set of chips.
        const groups = [];
        for (const c of catalog) {
          let g = groups.find((x) => x.name === (c.group || null));
          if (!g) groups.push((g = { name: c.group || null, items: [] }));
          g.items.push(c);
        }
        for (const g of groups) {
          if (g.name) menuBody.appendChild(ddHead(g.name));
          menuBody.appendChild(ddChips(g.items.map((c) => catalogChip(catDef.id, c, taken.has(c.fn), close))));
        }
      },
    });
  }

  // ── The drawers ───────────────────────────────────────────────────────────
  // Everything in a drawer edits a DRAFT; the primary button commits it and
  // triggers the full re-render. Cancel/scrim/Esc discard — the component owns
  // those paths (modal.js), so a dismissal can never half-apply.
  //
  // Every commit is the same four beats — write the draft into pane state, flag
  // the edit, close, redraw — and only the write differs, so it's the only part
  // a drawer supplies.
  const commit = (write) => {
    write();
    markDirty();
    drawer().close();
    render();
  };

  function openFieldDrawer({ mode, source, index }) {
    // The edit target is held by OBJECT, not index: the list can shift under
    // an open drawer (keyboard focus can reach a tile's × behind the scrim),
    // and a stale index would overwrite the wrong field on commit.
    const original = mode === "edit" ? fields[index] : null;
    const def = SOURCES[mode === "edit" ? original.source : source];
    const draft = mode === "edit"
      ? { ...original }
      : { key: "", source: def.id, ...(def.kinds ? { kind: def.kinds[0] } : {}), ...(def.ask ? { instruction: "" } : {}) };
    const head = drawerHeadParts(def.glyph, def.ai, draft.key || "new_field", srcLabel(def));
    // fns already used by OTHER fields of the same source — the edited field's
    // own binding stays pickable (it's the pressed chip).
    const takenFns = new Set(
      fields.filter((f, i2) => f.source === draft.source && i2 !== index).map((f) => f.fn)
    );
    drawer().open({
      head: head.nodes,
      build: (bodyEl) => {
        // The drawer asks exactly what the source declares it needs: a catalog
        // source has one question (WHICH entry — it decides key, kind and fn
        // together); an open source is named by the user, may offer a format,
        // and may need telling what to do.
        if (def.catalog) bodyEl.append(fnGroup(draft, head, takenFns));
        else {
          bodyEl.append(keyGroup(draft, head));
          if (def.kinds) bodyEl.append(formatGroup(draft, def));
          if (def.ask) bodyEl.append(askGroup(draft, def.ask));
        }
        if (def.refreshable) bodyEl.append(group("How often it re-pulls", cadenceSelect(draft), null));
      },
      primary: {
        label: mode === "new" ? "Add field" : "Done",
        onClick: () => {
          if (mode === "new" && def.cap && fields.filter((f) => f.source === def.id).length >= def.cap) {
            toast.info(`Maximum ${def.cap} ${srcLabel(def)} fields`);
            return;
          }
          commit(() => {
            if (mode === "new") fields.push(draft);
            else {
              const at = fields.indexOf(original);
              // Removed while the drawer was open → the removal wins; committing
              // a draft of a deleted field must not resurrect it elsewhere.
              if (at >= 0) fields[at] = draft;
            }
          });
        },
      },
    });
  }

  function keyGroup(draft, head) {
    const input = document.createElement("input");
    input.type = "text";
    input.style.fontFamily = "monospace";
    input.placeholder = "field_key";
    input.value = draft.key || "";
    input.addEventListener("input", () => {
      draft.key = normalizeKey(input.value);
      head.t.textContent = draft.key || "new_field"; // the title IS the key
    });
    input.addEventListener("blur", () => { input.value = draft.key || ""; });
    return group("Key", input, null);
  }

  function formatGroup(draft, def) {
    const row = el("div", "mm-chips");
    for (const k of def.kinds) {
      const c = document.createElement("button");
      c.type = "button";
      c.textContent = kindWord(k);
      c.setAttribute("aria-pressed", String((draft.kind || def.kinds[0]) === k));
      // Pressed state flips in place — a refresh would rebuild the body and
      // cost whoever is typing in the key input their focus.
      c.addEventListener("click", () => {
        draft.kind = k;
        for (const b of row.children) b.setAttribute("aria-pressed", String(b === c));
      });
      row.appendChild(c);
    }
    return group("Format", row, "How the app stores and displays the extracted value.");
  }

  // What the source needs told, in the source's own words (SOURCES[…].ask).
  // Extraction and detection ask different questions of the reader but hold the
  // same thing on the wire — one `instruction` string — so they get one editor.
  function askGroup(bearer, ask) {
    const t = document.createElement("textarea");
    t.rows = 2;
    t.value = bearer.instruction || "";
    t.placeholder = ask.placeholder;
    t.addEventListener("input", () => { bearer.instruction = t.value; });
    return group(ask.label, t, ask.hint);
  }

  // A catalog field's editor is one question: WHICH catalog entry. Picking a
  // chip rebinds key/kind/fn together — they are one fact in the catalog, so
  // the pane never lets them disagree.
  function fnGroup(draft, head, takenFns) {
    const catalog = catalogFor(SOURCES[draft.source]);
    const row = el("div", "mm-chips");
    const hint = el("div", "dw-hint");
    const currentNote = () =>
      (catalog || []).find((c) => c.fn === draft.fn)?.note || "";
    if (!catalog) {
      // Catalog fetch failed or hasn't landed: the saved binding still renders,
      // it just can't be re-pointed — a drawer that offered nothing to switch
      // to would be a one-way door pretending otherwise.
      const c = document.createElement("button");
      c.type = "button";
      c.textContent = draft.key;
      c.setAttribute("aria-pressed", "true");
      c.disabled = true;
      row.appendChild(c);
      hint.textContent = "The field catalog didn't load — this field keeps its saved binding.";
    } else {
      for (const cat of catalog) {
        const c = document.createElement("button");
        c.type = "button";
        c.textContent = cat.key;
        c.setAttribute("aria-pressed", String(cat.fn === draft.fn));
        c.disabled = takenFns.has(cat.fn);
        c.addEventListener("click", () => {
          draft.fn = cat.fn;
          draft.key = cat.key;
          draft.kind = cat.kind;
          head.t.textContent = cat.key;
          for (const b of row.children) b.setAttribute("aria-pressed", String(b === c));
          hint.textContent = currentNote();
        });
        row.appendChild(c);
      }
      hint.textContent = currentNote(); // the catalog's caveat, e.g. created is null for browser uploads
    }
    const g = group("Field", row, null);
    g.appendChild(hint);
    return g;
  }

  // A cadence select bound to `bearer.refresh.every`; "once" (0) clears it.
  // CADENCES is what this pane OFFERS; the server accepts any 1–43200 minutes,
  // so a mapping written by the API — or by a build whose list included a value
  // this one dropped — can hold a cadence with no option to sit on. Name it
  // rather than let the select answer for it: it used to render blank, and a
  // list of options with none selected reads as "once", which is a live field
  // claiming it never refreshes.
  function cadenceSelect(bearer) {
    const current = String(bearer.refresh?.every ?? 0);
    const opts = CADENCES.map(([min, label]) => [String(min), label]);
    if (!opts.some(([v]) => v === current)) {
      const at = opts.findIndex(([v]) => Number(v) > Number(current));
      opts.splice(at < 0 ? opts.length : at, 0, [current, `every ${current} min`]);
    }
    const sel = mkSel(opts, current, "How often this refreshes in the app");
    sel.addEventListener("change", () => {
      const every = Number(sel.value);
      if (every > 0) bearer.refresh = { every };
      else delete bearer.refresh;
    });
    return sel;
  }

  // ── The identity drawer (file boards) ─────────────────────────────────────
  // "Get identity from" over horizontal source cards; picking reshapes the
  // config below, draft-side. The Filename card sets the draft to null — the
  // slot's absence-of-configuration, not a source of its own.
  function openIdentityDrawer() {
    // `stash` is drawer-session scratch (see matchListBlock) and lives on the
    // EDITOR, never on the draft — the draft is written to the mapping verbatim,
    // and scratch on it would be config.
    const ed = { draft: identityCfg ? clone(identityCfg) : null, stash: null };
    const head = drawerHeadParts("srcDot", false, "identity", "");
    drawer().open({
      head: head.nodes,
      build: (bodyEl) => {
        const isAi = ed.draft?.source === "extract";
        // The head follows the current pick — it names what the slot would be
        // saved as, not what it was when the drawer opened.
        head.g.className = "mm-glyph" + (isAi ? " ai" : "");
        head.g.innerHTML = isAi ? ICONS.srcSparkle : ICONS.srcDot;
        head.s.textContent = isAi ? "AI extraction" : "Filename";

        const row = el("div", "mm-srcrow");
        row.append(
          srcCard({
            glyph: "srcDot", ai: false, lab: "Filename", note: "each file is its own card",
            pressed: !ed.draft,
            onPick: () => { ed.draft = null; drawer().refresh(); },
          }),
          srcCard({
            glyph: "srcSparkle", ai: true, lab: "AI extraction", note: "the AI derives it",
            pressed: isAi,
            onPick: () => {
              // Re-picking AI restores what was saved rather than a blank —
              // flipping to Filename and back should not cost the instruction.
              ed.draft = identityCfg?.source === "extract" ? clone(identityCfg) : { source: "extract", instruction: "" };
              drawer().refresh();
            },
          }),
        );
        bodyEl.appendChild(group("Get identity from", row, null));

        if (isAi) {
          // The identity slot asks the same question extraction fields do, in
          // its own words — what the AI should read out of each item.
          bodyEl.appendChild(askGroup(ed.draft, {
            label: "AI instruction",
            placeholder: "what to extract as the item's identity — e.g. \"the person's full name\"",
            hint: "Sent to the model for every item.",
          }));
          bodyEl.appendChild(matchListBlock(ed, bodyEl));
        }
      },
      primary: {
        label: "Done",
        onClick: () => commit(() => { identityCfg = ed.draft; }),
      },
    });
  }

  // "Match to a list": a declared list of allowed answers. Its presence on the
  // draft (`options` is an array) IS the mode — the switch adds or deletes the
  // array, and the option rows follow it with no second label.
  function matchListBlock(ed, bodyEl) {
    const wrap = el("div", "dw-group");
    const on = Array.isArray(ed.draft.options);
    wrap.appendChild(switchRow(
      "Match to a list",
      "constrain the answer to options you define — leave off to extract any value",
      on,
      (now) => {
        if (now) {
          // Prefer what was typed THIS drawer session (stashed on the flip
          // off) over the committed list — an off/on flip mid-edit must not
          // silently discard fresh options.
          ed.draft.options = ed.stash
            || (identityCfg?.options?.length ? clone(identityCfg.options) : [{ value: "", hint: "" }]);
          ed.stash = null;
        } else {
          ed.stash = ed.draft.options;
          delete ed.draft.options;
        }
        drawer().refresh();
      },
      { small: true }
    ));
    if (on) wrap.appendChild(optionRows(ed.draft, bodyEl));
    return wrap;
  }

  function optionRows(draft, bodyEl) {
    const wrap = document.createElement("div");
    draft.options.forEach((o, i) => {
      const rowEl = el("div", "fe-val-row");
      rowEl.style.cssText = "gap:6px;";
      const valIn = document.createElement("input");
      valIn.placeholder = "option";
      valIn.value = o.value || "";
      valIn.style.cssText = "flex:0 0 38%;";
      valIn.addEventListener("input", () => { o.value = valIn.value; });
      const hintIn = document.createElement("input");
      hintIn.placeholder = "hint (optional) — helps the AI tell options apart";
      hintIn.value = o.hint || "";
      hintIn.style.cssText = "flex:1;";
      hintIn.addEventListener("input", () => { o.hint = hintIn.value; });
      const rm = document.createElement("button");
      rm.className = "fe-rm";
      rm.type = "button";
      rm.textContent = "×";
      rm.setAttribute("aria-label", "Remove option");
      rm.addEventListener("click", () => { draft.options.splice(i, 1); drawer().refresh(); });
      rowEl.append(valIn, hintIn, rm);
      wrap.appendChild(rowEl);
    });
    const add = document.createElement("button");
    add.className = "fe-add-val";
    add.type = "button";
    add.textContent = draft.options.length ? "+ option" : "+ add the first option";
    add.addEventListener("click", () => {
      draft.options.push({ value: "", hint: "" });
      drawer().refresh();
      // refresh() rebuilds into the same body node, so the new row is queryable
      // — focus the option you just asked for.
      bodyEl.querySelectorAll(".fe-val-row input").item((draft.options.length - 1) * 2)?.focus();
    });
    wrap.appendChild(add);
    return wrap;
  }

  // ── The face drawers ──────────────────────────────────────────────────────
  // File board: only reachable under extract identity (several instances per
  // entity — WHICH one supplies the preview is a real question). The single
  // "File preview" card states what the face is; the preference below is soft.
  function openFileFaceDrawer() {
    const ed = {
      draft: faceCfg?.source === "file" ? clone(faceCfg) : { source: "file", prefer: "image", pick: "first" },
    };
    const head = drawerHeadParts("srcFile", false, "face", "File preview");
    drawer().open({
      head: head.nodes,
      build: (bodyEl) => {
        const row = el("div", "mm-srcrow");
        row.appendChild(srcCard({
          glyph: "srcFile", ai: false, lab: "File preview", note: "the stored file, rendered", pressed: true,
        }));
        bodyEl.appendChild(group("Get face from", row, null));

        const chips = el("div", "mm-chips");
        for (const [v, label] of [["image", "Image"], ["document", "Document"], ["audio", "Audio"]]) {
          const c = document.createElement("button");
          c.type = "button";
          c.textContent = label;
          c.setAttribute("aria-pressed", String(ed.draft.prefer === v));
          c.addEventListener("click", () => {
            ed.draft.prefer = v;
            for (const b of chips.children) b.setAttribute("aria-pressed", String(b === c));
          });
          chips.appendChild(c);
        }
        const pick = mkSel([["first", "First added"], ["latest", "Latest added"]], ed.draft.pick || "first",
          "Which instance when several qualify");
        pick.style.width = "auto";
        pick.addEventListener("change", () => { ed.draft.pick = pick.value; });
        const inline = el("div", "dw-inline");
        inline.append(chips, pick);
        bodyEl.appendChild(group("Prefer (when available)", inline,
          "Soft — falls back to any file when that type is absent."));
      },
      primary: {
        label: "Done",
        onClick: () => commit(() => { faceCfg = ed.draft; }),
      },
    });
  }

  // Connector board: one card per declared producer (usually just the chart),
  // then how much history it covers and how often it re-draws.
  function openConnectorFaceDrawer() {
    normalizeConnectorFace();
    const ed = { draft: clone(faceCfg) };
    const head = drawerHeadParts("srcGlobe", false, "face", srcLabel(SOURCES.connector));
    drawer().open({
      head: head.nodes,
      build: (bodyEl) => {
        const row = el("div", "mm-srcrow");
        for (const p of faces()) {
          row.appendChild(srcCard({
            glyph: "srcGlobe", ai: false, lab: p.label, note: "drawn from live history",
            pressed: ed.draft.producer === p.name,
            onPick: faces().length > 1 ? () => {
              ed.draft.producer = p.name;
              // Drop onto a period the new producer actually offers.
              if (!p.periods?.includes(ed.draft.period)) {
                ed.draft.period = p.periods?.includes("1y") ? "1y" : p.periods?.[0];
              }
              drawer().refresh();
            } : undefined,
          }));
        }
        bodyEl.appendChild(group("Get face from", row, null));

        const producer = faces().find((p) => p.name === ed.draft.producer) || faces()[0];
        const periodSel = mkSel((producer.periods || []).map((p) => [p, p]), ed.draft.period,
          "How much history the chart covers");
        periodSel.addEventListener("change", () => { ed.draft.period = periodSel.value; });
        bodyEl.appendChild(group("How much history the chart covers", periodSel, null));
        bodyEl.appendChild(group("How often it re-draws", cadenceSelect(ed.draft), null));

        // Warn when the face can't be rendered by the connector's active
        // provider — cards silently fall back to the tile otherwise. Name the
        // provider and, if any others can render it, point the way to switch.
        // This is where the tile gets disclosed: as the consequence of a
        // provider gap, not as an option.
        if (producer.available === false) {
          const active = conn?.activeProvider || null;
          const providerLabel = (n) => (conn?.providers || []).find((p) => p.name === n)?.label || n;
          const activeLabel = (active && providerLabel(active)) || "The active provider";
          const capable = (producer.supportedBy || [])
            .filter((n) => n !== active)
            .map(providerLabel);
          const hint = el("div", "dw-hint");
          hint.textContent =
            `${activeLabel} can’t render this face — cards will show the symbol tile instead.` +
            (capable.length ? ` Switch to ${capable.join(" or ")} in Admin → Plugins to enable it.` : "");
          bodyEl.appendChild(hint);
        }
      },
      primary: {
        label: "Done",
        onClick: () => commit(() => { faceCfg = ed.draft; }),
      },
    });
  }

  // Normalize the face onto a real producer + a period it actually offers.
  // This also COERCES a board saved without a face (or under a producer that's
  // gone) onto the first declared producer, so the def row never summarizes a
  // face the save wouldn't write. Idempotent — re-runs whenever faces land.
  function normalizeConnectorFace() {
    if (!inputConnector || !faces().length) return;
    const producer = faces().find((p) => p.name === faceCfg?.producer) || faces()[0];
    const period = faceCfg?.period && producer.periods?.includes(faceCfg.period) ? faceCfg.period
      : producer.periods?.includes("1y") ? "1y" : producer.periods?.[0];
    faceCfg = {
      source: "connector", producer: producer.name, period,
      ...(faceCfg?.refresh?.every ? { refresh: { every: faceCfg.refresh.every } } : {}),
    };
  }

  render();

  // For an already-bound board, fetch the connector's catalog so the add menu,
  // the identity blurb and the face producers show (a template load fills them
  // directly). File boards fetch the media catalog for the add menu.
  if (inputConnector) loadCatalog();
  else loadFileFields();

  // The host modal owns the Save button. Non-admins get a read-only pane, so
  // say why inline (the host's Save persists tagging only for them).
  if (!isAdmin) {
    const note = document.createElement("p");
    note.style.cssText = "font-size:12px;color:#8a8a92;margin:8px 0 0;";
    note.textContent = "Only admins can edit the entity mapping.";
    body.appendChild(note);
  }

  // Bind the pane to a domain row (or to none) and redraw around it. The three
  // callers below — the catalog fetch, a template apply, a template clear —
  // differ only in what they hand this and what they do to the MAPPING first.
  function bindConnector(row) {
    conn = row;
    normalizeConnectorFace(); // no-op off a connector board or before faces land
    syncTemplateBtn();        // the trigger may have been showing a bare name
    syncUnavailable();
    render();
  }

  async function loadCatalog() {
    try {
      const connectors = await fetch("/api/connectors").then((r) => r.json());
      const row = Array.isArray(connectors) ? connectors.find((x) => x.name === inputConnector) : null;
      // A board bound to a domain the server doesn't list any more (its plugin
      // was removed) is the same dead end as a failed fetch — the pane keeps
      // rendering what it saved, and the add menu must stop claiming a catalog
      // is on its way.
      if (row) bindConnector(row);
      else catalogFailed = true;
    } catch {
      // Saved tiles carry their own key/kind — the pane is never blank about
      // fields it collects. The flag stops the add menu claiming "Loading…"
      // for a fetch that already lost.
      catalogFailed = true;
    }
  }

  async function loadFileFields() {
    if (fileFieldCatalog) return;
    try {
      const cat = await fetch("/api/file-fields").then((r) => r.json());
      if (Array.isArray(cat)) fileFieldCatalog = cat;
    } catch {
      catalogFailed = true; // the open sources stay addable; the menu says why
    }
  }

  function applyTemplate(row) {
    // A domain with no template can't rewire the board — bail rather than
    // silently apply as a "Files" board with an unreachable catalog. Both
    // built-ins declare one; this guards a plugin domain that doesn't.
    if (!row.template) {
      toast.error(`${row.label} doesn't provide a board template`);
      return;
    }
    const t = row.template;
    inputConnector = t.input?.connector || null;
    identityCfg = t.identity ? clone(t.identity) : null;
    faceCfg = t.face ? clone(t.face) : null;
    fields = (t.fields || []).map((f) => ({ ...f }));
    markDirty();
    bindConnector(row);
  }

  // The inverse of applyTemplate: back to the pristine file board. A template
  // rewires the whole mapping, so unloading one has to undo the whole thing —
  // the connector fields name a source that's gone, and the identity/face it
  // set only mean something under that source. That takes the template's
  // extract fields with it, which is the same wholesale swap applyTemplate
  // already does in the other direction.
  function clearTemplate() {
    if (!inputConnector) return;
    inputConnector = null;
    identityCfg = null;
    faceCfg = null;
    fields = [];
    markDirty();
    loadFileFields(); // the file source's menu section needs a catalog it never fetched
    bindConnector(null);
  }

  // Validate + assemble the mapping payload for the host modal's PATCH. Returns
  // { ok:false } after toasting on invalid input, else { ok:true, payload } —
  // the payload merges straight into the board PATCH body. The capability pins
  // behind the bands ride the host's pickers, not this pane.
  function collect() {
    // Blur whatever is being edited — the MODEL is already current (every
    // control writes on input/change), this is about what the reader sees: the
    // messages below name keys, and they have to name what's on screen.
    const active = document.activeElement;
    if (active && container.contains(active)) active.blur();

    // A user-named field committed without a key is a half-thought, not an
    // error worth blocking the save over — drop it, as the old pane did.
    const kept = fields.filter((f) => SOURCES[f.source]?.catalog || f.key);
    const seen = new Set();
    for (const f of kept) {
      if (!SOURCES[f.source]?.catalog && !/^[a-z][a-z0-9_]*$/.test(f.key)) {
        toast.error(`Invalid field key: "${f.key}"`);
        return { ok: false };
      }
      // Mirrors the server (validateMapping): "identity" is the identity
      // slot's key in the record_fields schema; instructions cap at 500.
      if (f.key === "identity") {
        toast.error(`"identity" is reserved for the identity slot — pick another key`);
        return { ok: false };
      }
      if ((f.instruction || "").length > 500) {
        toast.error(`The instruction for "${f.key}" is too long (max 500 characters)`);
        return { ok: false };
      }
      if (seen.has(f.key)) {
        toast.error(`Duplicate field key: "${f.key}"`);
        return { ok: false };
      }
      seen.add(f.key);
    }

    // Identity: the domain's on connector boards; extract needs its
    // instruction; absent = the filename (no slot stores a word for that).
    let identity = null;
    if (inputConnector) identity = { source: "connector" };
    else if (identityCfg?.source === "extract") {
      const instruction = (identityCfg.instruction || "").trim();
      if (!instruction) {
        toast.error("An AI instruction is required when identity comes from AI extraction");
        return { ok: false };
      }
      if (instruction.length > 500) {
        toast.error("The identity instruction is too long (max 500 characters)");
        return { ok: false };
      }
      // Match-list: keep only options that carry a value; trim hints. An on
      // toggle with nothing usable is a half-state — block it rather than save
      // a listless matcher (keeps "mode = has a list" true, like the server).
      const cleanOptions = (identityCfg.options || [])
        .map((o) => ({ value: (o.value || "").trim(), ...(o.hint && o.hint.trim() ? { hint: o.hint.trim() } : {}) }))
        .filter((o) => o.value);
      if (Array.isArray(identityCfg.options) && !cleanOptions.length) {
        toast.error("Add at least one option, or turn off “Match to a list”");
        return { ok: false };
      }
      // The server dedups options on a NORMALIZED key (worker normaliseIdentity:
      // trim, collapse -_ and whitespace, lowercase) — "BTC" and "btc" collide.
      // Catch it here so a colliding pair doesn't 400 the whole save.
      const optKeys = new Set();
      for (const o of cleanOptions) {
        const k = o.value.trim().toLowerCase().replace(/[-_\s]+/g, " ");
        if (optKeys.has(k)) {
          toast.error(`Two options mean the same thing: "${o.value}"`);
          return { ok: false };
        }
        optKeys.add(k);
        if ((o.hint || "").length > 500) {
          toast.error(`The hint for option "${o.value}" is too long (max 500 characters)`);
          return { ok: false };
        }
      }
      identity = { source: "extract", instruction, ...(cleanOptions.length ? { options: cleanOptions } : {}) };
    }

    // Each field is emitted from what its source declares it carries, so the
    // wire shape of a new source is its table row rather than another arm here.
    // A catalog source's key/kind/fn are the catalog entry's; an open source
    // holds a kind only where the user picks one (detection outputs located
    // hits, not a scalar, so it carries none at all).
    const outFields = kept.map((f) => {
      const def = SOURCES[f.source];
      // A source this build has no row for (a plugin domain's template can put
      // one here) travels through untouched: dropping it would delete a field
      // the pane just showed, and re-shaping it from a row we don't have isn't
      // possible. The server names it if it's really unsupported — which is a
      // better answer than either.
      if (!def) return { ...f };
      const out = { key: f.key, source: f.source };
      if (def.catalog) { out.kind = f.kind; out.fn = f.fn; }
      else if (def.kinds) out.kind = def.kinds.includes(f.kind) ? f.kind : def.kinds[0];
      if (def.ask && f.instruction?.trim()) out.instruction = f.instruction.trim();
      if (def.refreshable && f.refresh?.every) out.refresh = { every: f.refresh.every };
      return out;
    });

    // The face is emitted only where it was really configured. Connector
    // boards: the normalized producer config. File boards: only under extract
    // identity (several instances per entity) — the preference is soft, image/
    // first by default, and flipping identity back to filename drops it.
    let face = null;
    if (inputConnector) {
      if (faceCfg?.source === "connector") {
        face = {
          source: "connector", producer: faceCfg.producer, period: faceCfg.period,
          ...(faceCfg.refresh?.every ? { refresh: { every: faceCfg.refresh.every } } : {}),
        };
      }
    } else if (identity?.source === "extract") {
      face = {
        source: "file",
        prefer: (faceCfg?.source === "file" && faceCfg.prefer) || "image",
        pick: (faceCfg?.source === "file" && faceCfg.pick) || "first",
      };
    }

    // Nothing configured at all collapses to null — an unmapped board, not an
    // empty mapping.
    const hasContent = outFields.length > 0 || identity || inputConnector || face;
    const out = hasContent
      ? {
          ...(inputConnector ? { input: { connector: inputConnector } } : {}),
          ...(identity ? { identity } : {}),
          ...(face ? { face } : {}),
          fields: outFields,
        }
      : null;

    return { ok: true, payload: { mapping: out } };
  }

  return { isDirty: () => dirty, collect, setBands };
}
