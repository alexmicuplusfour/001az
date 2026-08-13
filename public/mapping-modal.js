import { toast } from './toast.js';
import { openDropdown, ddRow, ddSep } from './dropdown.js';
import { ICONS, sentence } from './utils.js';
import { switchRow } from './board-modal.js';
import { sectionHeadingEl, provBand, keepPlace } from './modal.js';
import { fillSelect } from './select.js';

const KINDS = ["text", "number", "url", "date", "object"];
// Liveness cadence choices (minutes). 0 = Off (the field is fetched once at add
// and never refreshed). "How often the field updates in the app" — the sweep
// re-fetches the whole entity but only rewrites fields whose cadence elapsed.
const CADENCES = [[0, "Off"], [1, "1 min"], [5, "5 min"], [15, "15 min"], [60, "1 hour"], [360, "6 hours"], [1440, "1 day"]];

// Builds the entity-mapping editor into `container` — a pane inside the board
// modal (board-modal.js), which owns the modal chrome + the single Save button.
// Returns { isDirty, collect, setExtractionBand }: the host folds collect()'s
// payload into its one PATCH/POST, and names the model behind the "Using …"
// band via setExtractionBand. Fully parameterized (no gallery-state reads), so
// it works on admin.html and for not-yet-created boards:
//   isAdmin  — editable pane; false = read-only view
//   mapping  — the board's current mapping (null for a new/unmapped board)
//   hasItems — locks the connector-template picker (templates rewire the whole
//              mapping, only sane while the board is empty)
//   onExtractionChange — the band's "Change" action: the host opens its
//              AI-models strip at the extraction row (admin only)
export function buildMappingPane({ container, isAdmin = false, mapping = null, hasItems = false, onExtractionChange = null }) {
  // Any user edit flips the pane dirty, so a pure-tagging save omits `mapping`
  // and doesn't needlessly re-run the server's reschedule/backfill.
  let dirty = false;
  const markDirty = () => { dirty = true; };
  // Clone current mapping so edits are buffered until Save.
  let fields = (mapping?.fields || []).map((f) => ({ ...f }));
  let identityFrom = mapping?.identity?.from || "raw";
  let identityHint = mapping?.identity?.hint || "";
  // Classify mode (Slice 3): a declared list of allowed answers. Its presence is
  // the mode; `classifyOn` just drives the reveal so an on-with-empty state is
  // distinguishable (and blocked at save) from off.
  let candidates = (mapping?.identity?.candidates || []).map((c) => ({ ...c }));
  let classifyOn = candidates.length > 0;
  let inputConnector = mapping?.input?.connector || null; // set when a connector template is loaded
  let connectorCatalog = null;   // the active connector's full field set (manifest.fields)
  let fileFieldCatalog = null;   // file-metadata field catalog (server/media) — file boards only
  let connectorFaces = [];       // the connector's face producers (with per-provider availability)
  let connectorLabel = null;
  let connectorProviders = [];   // [{ name, label, needsKey }] — for naming providers in hints
  let connectorActiveProvider = null; // the backend currently resolving this connector
  // Whether the BOUND domain can serve at all, and why not — straight off
  // /api/connectors (`available`/`reason`, the capabilities feed's own ladder).
  // Starts optimistic: until the catalog lands there is nothing to accuse it of,
  // and a banner that flashes on every open would be its own lie.
  let connectorAvailable = true;
  let connectorReason = null;
  let faceCfg = { ...(mapping?.face || { from: "raw" }) }; // the entity's card visual

  // The template picker's trigger (admin only) — it names the template the
  // board is currently on, so every path that changes that has to re-sync it:
  // the two switch handlers, and loadCatalog, which is where a bound board
  // learns its connector's display label ("Crypto", not "crypto").
  let templateBtn = null;
  let templateBtnValue = null;
  function syncTemplateBtn() {
    if (!templateBtnValue) return;
    templateBtnValue.textContent = inputConnector ? (connectorLabel || inputConnector) : "Files";
  }

  // The provenance band under "AI-extracted fields": which model fills the AI
  // fields. The picker itself lives in the host's AI-models strip; only the
  // host can name the model — the answer includes strip edits it hasn't saved
  // yet, and follows delegation — so it pushes via setExtractionBand on every
  // reveal of this pane and on every pin change. The band element is
  // re-appended by renderFields (which wipes fieldsList), so the pushed text
  // lives on the element and survives re-renders.
  //
  // The band itself is modal.js's, shared with the Tagging pane's: the copy is
  // pinned and the empty state is a rule, and neither survives being written
  // out twice — the two hand-built copies disagreed about when to hide and both
  // ended up printing "Using none configured".
  const extractBand = isAdmin ? provBand(() => onExtractionChange?.()) : null;
  if (extractBand) extractBand.el.style.margin = "2px 0 8px";
  // Straight through: the host decides what the band says (only it can see the
  // strip's unsaved edits, and follow delegation), the band decides how to look
  // — including whether to be there at all, for a null.
  const setExtractionBand = (state) => extractBand?.set(state);

  // The host (board-modal) provides a flex-column container and owns its
  // visibility via the Mapping/Tagging toggle — so we never set `display` here,
  // where an inline display:flex would defeat the host's display:none.
  // Real data edits (text/select/checkbox) fire input/change; button-driven
  // mutations (add/remove/apply-template) call markDirty() at their handlers.
  container.addEventListener("input", markDirty, true);
  container.addEventListener("change", markDirty, true);
  const body = container;

  // Template row — very top of the body, right-aligned, divider below.
  // It reads as a select, not a load action: the board is ALWAYS on a template
  // ("Files" is the one it starts on), so the control names the current one and
  // the menu switches between them. A "Load template…" button implied the
  // opposite — that nothing was loaded yet and the only move was forward.
  // Switching rewires the whole mapping (input, identity, fields) in one click,
  // which only makes sense while the board is empty: existing items were
  // ingested under the current input source, so once the first item lands the
  // picker locks.
  // Neither switch toasts. A pick is a pending edit like typing in a field —
  // nothing is saved until the host's Save — and the pane visibly redrawing
  // around it is the feedback. A toast here would announce a change that
  // hasn't happened yet.
  if (isAdmin) {
    const templateRow = document.createElement("div");
    templateRow.className = "mm-template-row";
    const templateLabel = document.createElement("span");
    templateLabel.className = "mm-template-label";
    templateLabel.textContent = "Template";
    templateBtn = document.createElement("button");
    templateBtn.type = "button";
    templateBtn.className = "dd-trigger";
    templateBtnValue = document.createElement("span");
    templateBtnValue.className = "dd-trigger-value";
    const chev = document.createElement("span");
    chev.className = "dd-caret";
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

  // The bound domain's outage, stated for as long as the board is on it.
  //
  // The menu row's dim sublabel is only seen by whoever opens the menu, and the
  // board that most needs this explanation is the one nobody is switching: an
  // existing board whose provider went away. Its picker is LOCKED by hasItems,
  // its connector fields render exactly as they always did, and the face row
  // deliberately makes no availability claim (the server ships faces
  // unannotated when nothing is resolving, rather than assert a gap it can't
  // attribute) — so without this line the pane's whole answer to "why has
  // nothing updated in a week" is a confident silence.
  //
  // Not admin-gated: a board-admin reading the pane read-only is owed an answer
  // too. Amber, borrowing the face row's hint box — the same class of statement
  // (a thing you configured cannot currently render), one step up in scope.
  const unavailBanner = document.createElement("div");
  unavailBanner.className = "mm-face-hint mm-unavail";
  unavailBanner.hidden = true;
  body.appendChild(unavailBanner);
  function syncUnavailable() {
    const show = !!inputConnector && !connectorAvailable;
    unavailBanner.hidden = !show;
    if (!show) return;
    // The diagnosis names a provider and its key state, so the server ships it
    // to admins only — and this reads the ABSENCE rather than a role flag, so
    // there is no second copy of that rule here to fall out of step with it.
    // Without the reason the banner still has to answer the question that
    // brought the reader here, so the cause degrades from the diagnosis to the
    // plain fact, and the remedy from an instruction to who owns it.
    const cause = sentence(connectorReason) || `${connectorLabel || "This board's data source"} isn't available`;
    const remedy = connectorReason ? "Fix this in Admin → Plugins." : "Ask an admin to check the Plugins page.";
    unavailBanner.textContent = `${cause}, so this board can't fetch or refresh its data. ${remedy}`;
  }

  // Explanation + identity anchor
  const intro = document.createElement("div");
  intro.className = "mm-intro";
  intro.innerHTML =
    "<p>Define structured fields for each item. Connector fields come from a live " +
    "data source; AI fields are extracted from the item's content.</p>";
  body.appendChild(intro);

  // ── The parts every row in this pane is built from ─────────────────────────
  // identity, face and the field rows all say the same three things in the same
  // three chips: what the slot is CALLED, where its value COMES FROM, and what
  // it IS. Each chip was being hand-built at four or five call sites, which is
  // how the field rows ended up with a redundant inline `font-family:monospace`
  // that .mm-key-locked was already applying and identity/face were already
  // relying on. Declared up here because renderIdentityRow — the first thing
  // that runs — needs them.
  const keyChip = (text) => {
    const el = document.createElement("span");
    el.className = "mm-key-locked";
    el.textContent = text;
    return el;
  };
  // Where the value comes from: `stocks:price`, `file:created`, `crypto:id`.
  const srcChip = (text) => {
    const el = document.createElement("span");
    el.className = "mm-connector-badge";
    el.textContent = text;
    return el;
  };
  // What it is, and can't be argued with: a kind, or the one face a board gets.
  const kindChip = (text) => {
    const el = document.createElement("span");
    el.className = "mm-locked-badge";
    el.textContent = text;
    return el;
  };
  // A select over [value, label] pairs, disabled on the read-only pane. The
  // title is optional — assigning an absent one writes the string "undefined"
  // into the tooltip, which is exactly the kind of thing a shared builder is
  // supposed to stop happening. The options themselves go through select.js's
  // fillSelect, the same filler the board editor and plugin modal use; pairs
  // are the terser shape for the short literal lists this pane declares, so the
  // conversion happens here rather than at seven call sites. No placeholder:
  // every list here is closed and always has a current value to sit on.
  const mkSel = (opts, val, title) => {
    const sel = document.createElement("select");
    sel.disabled = !isAdmin;
    if (title) sel.title = title;
    fillSelect(sel, opts.map(([value, label]) => ({ value, label })), { value: val });
    return sel;
  };

  // Identity row — always present. Raw/AI are hand-switchable; connector-bound
  // identity renders locked with a badge, matching the connector field rows.
  const identityRow = document.createElement("div");

  // Every render function in this pane rebuilds its subtree wholesale, so every
  // one of them is wrapped in keepPlace (modal.js) — the pane lives in a
  // scrolling modal body, and without it any structural edit dropped the reader
  // at the top. See the note there for what a rebuild costs and what is held.
  const renderIdentityRow = keepPlace(identityRow, () => {
    const isConnectorId = identityFrom === "connector";
    identityRow.className = "mm-row" + (isConnectorId ? " mm-row-connector" : "");
    identityRow.replaceChildren();

    const idControls = document.createElement("div");
    idControls.className = "fe-head";
    idControls.appendChild(keyChip("identity"));

    if (isConnectorId) {
      // Locked, badge-styled — same pattern as the connector field rows below.
      idControls.appendChild(srcChip(`${inputConnector}:id`));
      identityRow.appendChild(idControls);
      return;
    }

    const idSrcSel = mkSel(
      [["raw", "filename (raw)"], ["ai", "AI instruction"]],
      identityFrom, "What gives each item its title");
    idControls.appendChild(idSrcSel);

    const idHintWrap = document.createElement("div");
    idHintWrap.style.cssText = "margin-top:6px;display:" + (identityFrom === "ai" ? "block" : "none") + ";";
    const idHint = document.createElement("textarea");
    idHint.placeholder = "What to extract as the item's title — any format (e.g. \"the person's full name\", \"invoice month, as Month - YYYY\")";
    idHint.rows = 2;
    idHint.value = identityHint;
    idHint.disabled = !isAdmin;
    idHint.addEventListener("input", () => { identityHint = idHint.value; });
    idHintWrap.appendChild(idHint);

    // Classify mode: a "Match to a list" toggle that reveals a flat editor of
    // allowed options (value + optional per-option hint). Off = open extraction,
    // exactly as before. Reuses the tagging value-editor's fe-* styling so it
    // reads the same as the Tagging tab. Shown only under AI instruction.
    const classifyWrap = document.createElement("div");
    classifyWrap.style.cssText = "margin-top:8px;display:" + (identityFrom === "ai" ? "block" : "none") + ";";

    const candidatesBox = document.createElement("div");
    candidatesBox.className = "fe-root";
    candidatesBox.style.cssText = "margin-top:6px;display:" + (classifyOn ? "block" : "none") + ";";

    const renderCandidates = keepPlace(candidatesBox, () => {
      candidatesBox.replaceChildren();
      candidates.forEach((c, i) => {
        const rowEl = document.createElement("div");
        rowEl.className = "fe-val-row";
        rowEl.style.cssText = "gap:6px;";
        const valIn = document.createElement("input");
        valIn.placeholder = "option";
        valIn.value = c.value || "";
        valIn.disabled = !isAdmin;
        valIn.style.cssText = "flex:0 0 38%;";
        valIn.addEventListener("input", () => { c.value = valIn.value; });
        const hintIn = document.createElement("input");
        hintIn.placeholder = "hint (optional) — helps the AI tell options apart";
        hintIn.value = c.hint || "";
        hintIn.disabled = !isAdmin;
        hintIn.style.cssText = "flex:1;";
        hintIn.addEventListener("input", () => { c.hint = hintIn.value; });
        rowEl.append(valIn, hintIn);
        if (isAdmin) {
          const rm = document.createElement("button");
          rm.className = "fe-rm";
          rm.type = "button";
          rm.textContent = "×";
          rm.addEventListener("click", () => { candidates.splice(i, 1); markDirty(); renderCandidates(); });
          rowEl.appendChild(rm);
        }
        candidatesBox.appendChild(rowEl);
      });
      if (isAdmin) {
        const add = document.createElement("button");
        add.className = "fe-add-val";
        add.type = "button";
        add.textContent = "+ option";
        add.addEventListener("click", () => {
          candidates.push({ value: "", hint: "" });
          markDirty();
          renderCandidates();
          candidatesBox.querySelectorAll(".fe-val-row input").item((candidates.length - 1) * 2)?.focus();
        });
        candidatesBox.appendChild(add);
      }
    });
    renderCandidates();

    const classifyToggle = switchRow(
      "Match to a list",
      "constrain the answer to options you define — leave off to extract any value",
      classifyOn,
      (on) => {
        classifyOn = on;
        markDirty();
        candidatesBox.style.display = on ? "block" : "none";
        if (on && !candidates.length) { candidates.push({ value: "", hint: "" }); renderCandidates(); }
      },
      { small: true }
    );
    // Read-only pane: the switch has no disabled state of its own, so freeze it
    // to match the disabled inputs/selects elsewhere.
    if (!isAdmin) { classifyToggle.style.pointerEvents = "none"; classifyToggle.style.opacity = "0.6"; }
    classifyWrap.append(classifyToggle, candidatesBox);

    idSrcSel.addEventListener("change", () => {
      identityFrom = idSrcSel.value;
      const isAi = identityFrom === "ai";
      idHintWrap.style.display = isAi ? "block" : "none";
      classifyWrap.style.display = isAi ? "block" : "none";
      // A file board's face controls only make sense under derived identity
      // (several instances per entity), so they track this select — like the hint.
      renderFaceRow();
    });

    identityRow.append(idControls, idHintWrap, classifyWrap);
  });

  renderIdentityRow();
  body.appendChild(identityRow);

  // Face row — below identity on every board (the face is ~mandatory). File
  // boards show "File preview"; connector boards show the connector's own
  // producer (a price chart) with its range + re-render cadence under it.
  const faceRow = document.createElement("div");
  body.appendChild(faceRow);

  // The face row's own two pieces, so a file face and a connector face are built
  // from the same parts (they're deliberately the same shape as a field row: a
  // locked statement of WHAT the face is, then a line that refines it).
  const faceHead = () => {
    const head = document.createElement("div");
    head.className = "fe-head";
    head.appendChild(keyChip("face"));
    return head;
  };
  // The refinement line under the face: a muted label + its controls.
  const faceSubRow = (label, ...controls) => {
    const sub = document.createElement("div");
    sub.className = "mm-face-prefer";
    const lbl = document.createElement("span");
    lbl.className = "mm-face-prefer-label";
    lbl.textContent = label;
    sub.append(lbl, ...controls);
    return sub;
  };

  const renderFaceRow = keepPlace(faceRow, () => {
    faceRow.replaceChildren();
    // File boards get a face row too (normalized): a read-only "File preview"
    // label that expands to instance-pick controls under derived identity.
    if (!inputConnector) { faceRow.style.display = ""; renderFileFaceRow(); return; }
    renderConnectorFaceRow();
  });

  // A connector board's face row. The face is the connector's face producer —
  // the SYMBOL TILE IS NOT A CHOICE HERE. It isn't a producer at all (there's no
  // tile in server/faces); it's what a card draws when it has no rendered face,
  // which is exactly what happens when a producer is unavailable or its series
  // comes back empty. Offering it as a peer of "Price chart" dressed a fallback
  // up as a decision — and, being the default, made it the one most boards got.
  // So: one producer (every built-in) renders as a locked chip, mirroring the
  // file board's "File preview"; a domain declaring several gets a select over
  // THOSE, with no tile entry. A second line refines the render — chart range +
  // the same cadence widget the fields use.
  function renderConnectorFaceRow() {
    // The producer list arrives with the connector catalog (fetched for an
    // already-bound board); until then there's nothing truthful to show.
    if (!connectorCatalog && !connectorFaces.length) { faceRow.style.display = "none"; return; }
    faceRow.style.display = "";
    faceRow.className = "mm-row" + (connectorFaces.length ? " mm-row-connector" : "");
    const controls = faceHead();

    // A domain with no face producer at all (possible for a connector plugin):
    // the tile IS the face. Name it, in the one place where it's the whole
    // answer rather than a fallback, and serialize nothing (collect() writes a
    // face only for `from: "connector"`).
    if (!connectorFaces.length) {
      controls.appendChild(kindChip("Symbol tile"));
      faceRow.appendChild(controls);
      return;
    }

    // Normalize onto a real producer + a period it actually offers. This also
    // COERCES a legacy `{ from: "raw" }` mapping (a board saved back when the
    // tile was selectable) onto the chart, so the row never shows a chart the
    // save wouldn't write. Idempotent — it re-runs on every render.
    const producer = connectorFaces.find((p) => p.name === faceCfg.producer) || connectorFaces[0];
    const period = faceCfg.period && producer.periods.includes(faceCfg.period) ? faceCfg.period
      : producer.periods.includes("1y") ? "1y" : producer.periods[0];
    faceCfg = { from: "connector", producer: producer.name, period, ...(faceCfg.live ? { live: true, every: faceCfg.every } : {}) };

    if (connectorFaces.length === 1) {
      controls.appendChild(kindChip(producer.label));
    } else {
      const srcSel = mkSel(connectorFaces.map((p) => [p.name, p.label]), producer.name,
        "How this connector renders the card");
      srcSel.addEventListener("change", () => {
        // Drop the period — the normalizer above picks one the new producer offers.
        faceCfg = { from: "connector", producer: srcSel.value, ...(faceCfg.live ? { live: true, every: faceCfg.every } : {}) };
        renderFaceRow();
      });
      controls.appendChild(srcSel);
    }
    faceRow.appendChild(controls);

    const periodSel = mkSel(producer.periods.map((p) => [p, p]), faceCfg.period,
      "How much history the chart covers");
    periodSel.addEventListener("change", () => { faceCfg.period = periodSel.value; });
    faceRow.appendChild(faceSubRow("Range", periodSel, livenessSelect(faceCfg, true)));

    // Warn when the face can't be rendered by the connector's active provider —
    // cards silently fall back to the tile otherwise. Name the provider and, if
    // any others can render it, point the way to switch. This is where the tile
    // gets disclosed: as the consequence of a provider gap, not as an option.
    if (producer.available === false) {
      const activeLabel = connectorProviders.find((p) => p.name === connectorActiveProvider)?.label || connectorActiveProvider || "The active provider";
      const capable = (producer.supportedBy || [])
        .filter((n) => n !== connectorActiveProvider)
        .map((n) => connectorProviders.find((p) => p.name === n)?.label || n);
      const hint = document.createElement("div");
      hint.className = "mm-face-hint";
      hint.textContent =
        `${activeLabel} can’t render this face — cards will show the symbol tile instead.` +
        (capable.length ? ` Switch to ${capable.join(" or ")} in Admin → Plugins to enable it.` : "");
      faceRow.appendChild(hint);
    }
  }

  // A file board's face row. The face is always the "File preview" — the pretty
  // rendered face of one instance (mirroring identity's "filename (raw)"). Under
  // derived identity an entity can bundle several instances, so a second line
  // refines WHICH one supplies that preview: a preferred file type (image by
  // default) and, among those, first/latest added.
  function renderFileFaceRow() {
    faceRow.className = "mm-row";
    const controls = faceHead();
    controls.appendChild(kindChip("File preview"));
    faceRow.appendChild(controls);

    if (identityFrom !== "ai") return; // one instance per entity — nothing to pick

    const prefer = faceCfg.prefer && faceCfg.prefer !== "any" ? faceCfg.prefer : "image";
    const preferSel = mkSel(
      [["image", "Image"], ["document", "Document"], ["audio", "Audio"]],
      prefer, "Preferred file type for the preview");
    const pickSel = mkSel(
      [["first", "First added"], ["latest", "Latest added"]],
      faceCfg.pick || "first", "Which instance when several qualify");
    const sync = () => { faceCfg = { from: "file", prefer: preferSel.value, pick: pickSel.value }; };
    preferSel.addEventListener("change", sync);
    pickSel.addEventListener("change", sync);
    faceRow.appendChild(faceSubRow("Prefer (when available)", preferSel, pickSel));
  }

  const fieldsList = document.createElement("div");
  fieldsList.className = "mm-fields";

  // A liveness cadence select bound to a field object's live/every. Off (0)
  // clears them. Identity has no liveness (it's the stable key), so it never
  // gets one of these. The refresh glyph in front labels what the select does:
  // this is a re-fetch cadence, not just another dropdown.
  function livenessSelect(f, enabled) {
    const wrap = document.createElement("span");
    wrap.className = "mm-live-wrap";
    wrap.title = "How often this field refreshes in the app";

    const icon = document.createElement("span");
    icon.className = "mm-live-icon";
    icon.innerHTML = ICONS.redo;

    // Off (0) is the selected option for a field with no cadence, and for the
    // un-included field the row is offering — the select is disabled there, so
    // what it shows is a statement rather than a default anyone can act on.
    const current = String(f?.live ? f.every : 0);
    const opts = CADENCES.map(([min, label]) => [String(min), label]);
    // CADENCES is what this pane OFFERS; the server accepts any 1–43200 minutes
    // (server.js), so a mapping written by the API — or by a build whose list
    // included a value this one dropped — can hold a cadence with no option to
    // sit on. Name it rather than let the select answer for it: it used to
    // render blank, and a list of options with none selected reads as Off,
    // which is a live field claiming it never refreshes.
    if (!opts.some(([v]) => v === current)) {
      const at = opts.findIndex(([v]) => Number(v) > Number(current));
      opts.splice(at < 0 ? opts.length : at, 0, [current, `${f.every} min`]);
    }
    const sel = mkSel(opts, current);
    sel.className = "mm-live";
    if (!enabled) sel.disabled = true; // on top of mkSel's read-only rule
    if (sel.disabled) wrap.classList.add("disabled");
    sel.addEventListener("change", () => {
      if (!f) return;
      const every = Number(sel.value);
      if (every > 0) { f.live = true; f.every = every; }
      else { delete f.live; delete f.every; }
    });
    wrap.append(icon, sel);
    return wrap;
  }

  // ── One row shape for every locked field ──────────────────────────────────
  // A connector-catalog row, a file-field row and the saved-connector fallback
  // used to be three hand-written copies of the same six elements, and they had
  // already drifted apart in ways nobody chose: only one of them could carry a
  // note, and the fallback silently dropped the include checkbox. They are ONE
  // row — a locked statement of what the field IS (its key, where it comes
  // from, its kind), optionally preceded by whether this board takes it and
  // followed by how often it refreshes.
  //
  //   include — { checked, title, place, onToggle }. Omit for a row that can't
  //             be un-included: the fallback has no catalog behind it, so an
  //             un-tick there would be a one-way door. `place` is the focus key
  //             keepPlace restores through (see modal.js) — the field's own
  //             identity, so the checkbox you clicked is the one you get back.
  //             It rides in HERE rather than beside `key` because the checkbox
  //             is the only thing in the row that can hold focus; a place on a
  //             checkbox-less row would be a key nothing answers to.
  //   live    — { field, enabled }. Omit for a source with no cadence — files
  //             are immutable, so a file field is fetched once and never again.
  //   note    — a caveat the catalog carries (e.g. `created` is null for
  //             browser uploads).
  function lockedRow({ key, badge, kind, include, live, note }) {
    const row = document.createElement("div");
    row.className = "mm-row mm-row-connector";
    const controls = document.createElement("div");
    controls.className = "fe-head";

    if (include) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = include.checked;
      cb.disabled = !isAdmin;
      cb.title = include.title;
      cb.dataset.place = include.place;
      cb.addEventListener("change", () => include.onToggle(cb.checked));
      controls.appendChild(cb);
    }

    controls.append(keyChip(key), srcChip(badge), kindChip(kind));
    if (live) controls.appendChild(livenessSelect(live.field, live.enabled));
    row.appendChild(controls);

    if (note) {
      const noteEl = document.createElement("div");
      noteEl.className = "mm-face-hint";
      noteEl.textContent = note;
      row.appendChild(noteEl);
    }
    return row;
  }

  // Include or drop one catalog field on this board. The catalog is global to
  // the source; `fields` is this board's pick from it, which is the only thing
  // a tick changes.
  function toggleField(from, cat, on) {
    const idx = fields.findIndex((f) => f.from === from && f.key === cat.key);
    if (on) {
      if (idx < 0) fields.push({ key: cat.key, kind: cat.kind, from, fn: cat.fn });
    } else if (idx >= 0) fields.splice(idx, 1);
    renderFields();
  }

  // "+ Add file field" — opens a menu of the not-yet-included catalog fields,
  // grouped by applicability (All files / Images / Documents). Keeps the modal
  // compact: only chosen file fields render as rows above.
  function fileMenuLabel(cat) {
    const wrap = document.createElement("span");
    wrap.className = "dd-label";
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;";
    // NOT keyChip: this is the one place a field name is drawn outside the pane,
    // and openDropdown's default surface is dark. .mm-key-locked pins a near-
    // black color for the pane's white ground, which on a #15171c menu is an
    // invisible label. The kind pill has its own ground, so it travels.
    const key = document.createElement("span");
    key.style.fontFamily = "monospace";
    key.textContent = cat.key;
    wrap.append(key, kindChip(cat.kind));
    return wrap;
  }

  function openAddFileFieldMenu(anchor) {
    const included = new Set(fields.filter((f) => f.from === "file").map((f) => f.fn));
    const available = (fileFieldCatalog || []).filter((c) => !included.has(c.fn));
    if (!available.length) { toast.info("All file fields added"); return; }
    openDropdown(anchor, {
      align: "start",
      minWidth: 240,
      build: (menuBody, { close }) => {
        const groups = [];
        for (const c of available) {
          let g = groups.find((x) => x.name === c.group);
          if (!g) { g = { name: c.group, items: [] }; groups.push(g); }
          g.items.push(c);
        }
        groups.forEach((g, gi) => {
          if (gi > 0) menuBody.appendChild(ddSep());
          const h = document.createElement("div");
          h.style.cssText = "padding:6px 12px 2px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8a8a92;";
          h.textContent = g.name;
          menuBody.appendChild(h);
          for (const c of g.items) {
            menuBody.appendChild(ddRow({
              labelEl: fileMenuLabel(c),
              onClick: () => {
                fields.push({ key: c.key, kind: c.kind, from: "file", fn: c.fn });
                markDirty();
                close();
                renderFields();
              },
            }));
          }
        });
      },
    });
  }

  function makeAddFileFieldBtn() {
    const btn = document.createElement("button");
    btn.className = "fe-add-facet";
    btn.type = "button";
    btn.textContent = "+ Add file field";
    btn.addEventListener("click", () => openAddFileFieldMenu(btn));
    return btn;
  }

  function makeAddAiFieldBtn() {
    const btn = document.createElement("button");
    btn.className = "fe-add-facet";
    btn.type = "button";
    btn.textContent = "+ Add AI field";
    btn.addEventListener("click", () => {
      if (fields.filter((f) => f.from === "ai").length >= 12) { toast.info("Maximum 12 AI fields"); return; }
      fields.push({ key: "", kind: "text", from: "ai", hint: "" });
      markDirty();
      renderFields();
      // After the render, so the focus lands on the row that now exists — and
      // after keepPlace has restored the offset, so this scroll-into-view wins.
      // Right: the field you just asked for should be brought to you.
      const rows = fieldsList.querySelectorAll(".mm-key");
      rows[rows.length - 1]?.focus();
    });
    return btn;
  }

  // AI field row — editable key/kind/hint, removable.
  function makeAiRow(f) {
    const row = document.createElement("div");
    row.className = "mm-row";
    const controls = document.createElement("div");
    controls.className = "fe-head";

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "mm-key";
    keyInput.style.cssText = "flex:1;min-width:90px;font-family:monospace;";
    keyInput.placeholder = "field_key";
    keyInput.value = f.key || "";
    keyInput.disabled = !isAdmin;
    // The key is written to the model on EVERY keystroke, like the hint below,
    // and merely re-displayed on blur. It used to be written only on blur, and
    // a rebuild is how you lost a key you had typed: a render replaces this
    // input, and removing a focused element does not reliably fire `blur` in
    // any browser — so the typed text went with the node. Reachable without
    // trying: type a key, delete a different field, watch yours empty itself.
    // (The catalog fetches landing behind you did it too.)
    //
    // Normalizing on input rather than storing raw keeps `f.key` the same value
    // blur would have produced, so collect()'s validation still sees exactly
    // what the row is claiming. The DISPLAY is left alone until blur — rewriting
    // under a live caret is its own kind of rude.
    const normalizeKey = (v) =>
      v.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^[^a-z]+/, "") || "";
    keyInput.addEventListener("input", () => { f.key = normalizeKey(keyInput.value); });
    keyInput.addEventListener("blur", () => {
      f.key = normalizeKey(keyInput.value);
      keyInput.value = f.key;
    });

    const kindSel = mkSel(KINDS.map((k) => [k, k]), f.kind || "text", "What kind of value this field holds");
    kindSel.addEventListener("change", () => { f.kind = kindSel.value; });
    if (!f.kind) f.kind = "text";

    const removeBtn = document.createElement("button");
    removeBtn.className = "fe-rm";
    removeBtn.setAttribute("aria-label", "Remove field");
    removeBtn.textContent = "×";
    removeBtn.disabled = !isAdmin;
    removeBtn.addEventListener("click", () => {
      const idx = fields.indexOf(f);
      if (idx >= 0) fields.splice(idx, 1);
      markDirty();
      renderFields();
    });

    controls.append(keyInput, kindSel);
    if (isAdmin) controls.appendChild(removeBtn);

    const hint = document.createElement("textarea");
    hint.rows = 2;
    hint.value = f.hint || "";
    hint.disabled = !isAdmin;
    hint.addEventListener("input", () => { f.hint = hint.value; });
    // Object fields feed the detector a list of things to find; scalar fields are
    // an extraction instruction. The placeholder tracks the kind select. One
    // object field = one object type; commas are synonyms for the SAME thing.
    const syncHintPlaceholder = () => {
      hint.placeholder = kindSel.value === "object"
        ? "the object to detect (defaults to the field name) — e.g. \"car\"; commas = synonyms for the same thing"
        : "AI instruction — describe what to extract and from where (e.g. \"the candidate's full name\")";
    };
    kindSel.addEventListener("change", syncHintPlaceholder);
    syncHintPlaceholder();

    row.append(controls, hint);
    return row;
  }

  function sectionTitle(text) {
    const el = sectionHeadingEl(text); // textContent path — the connector label rides in here
    // Siblings in the mm-fields gap:12 column — extra top margin pulls the
    // heading away from the section above so it binds to its own group.
    el.style.marginTop = "10px";
    return el;
  }

  // ── The pane's field sections ─────────────────────────────────────────────
  // A board draws exactly two of them: the fields its INPUT supplies (connector
  // or file — never both, since the input is one or the other) and the
  // AI-extracted ones. All three sources are the same shape — a heading, an
  // optional band under it, the rows, the line that stands in when there are
  // none, and an optional footer control — so each one describes what fills
  // those slots and drawSection owns the drawing. They used to be three inlined
  // blocks that each decided for itself when a "nothing here" line was
  // warranted; the file one grew a third case the other two never got.
  function drawSection({ title, band, rows, empty, footer }) {
    fieldsList.appendChild(sectionTitle(title));
    if (band) fieldsList.appendChild(band);
    for (const row of rows) fieldsList.appendChild(row);
    if (!rows.length && empty) {
      const p = document.createElement("p");
      p.className = "mm-empty";
      p.textContent = empty;
      fieldsList.appendChild(p);
    }
    if (footer) fieldsList.appendChild(footer);
  }

  // Connector fields: the connector's WHOLE catalog, one row each, ticked for
  // the ones this board takes. Until the catalog lands (or if its fetch failed)
  // the board's saved connector fields stand in, so the pane is never blank
  // about fields it is actually collecting — without checkboxes, since there's
  // no catalog to re-add from, but with their cadence still editable.
  function connectorSection() {
    const rows = connectorCatalog
      ? connectorCatalog.map((cat) => {
          const inc = fields.find((f) => f.from === "connector" && f.key === cat.key);
          return lockedRow({
            key: cat.key,
            badge: `${inputConnector}:${cat.fn}`,
            kind: cat.kind,
            include: {
              checked: !!inc,
              title: "Include this field",
              place: `connector:${cat.key}`,
              onToggle: (on) => toggleField("connector", cat, on),
            },
            live: { field: inc, enabled: !!inc },
          });
        })
      : fields.filter((f) => f.from === "connector").map((f) => lockedRow({
          key: f.key,
          badge: `${inputConnector}:${f.fn}`,
          kind: f.kind,
          live: { field: f, enabled: true },
        }));
    return {
      title: connectorLabel ? `Connector fields · ${connectorLabel}` : "Connector fields",
      rows,
      empty: connectorCatalog ? "No connector fields." : "Loading connector fields…",
    };
  }

  // File fields (server/media). Only the INCLUDED ones render as rows;
  // "+ Add file field" reveals the rest, so the ~15-field catalog isn't a wall
  // of rows by default. The un-tick therefore REMOVES rather than un-includes,
  // which is what its title says.
  function fileSection() {
    const rows = fields.filter((f) => f.from === "file").map((f) => {
      // The catalog is what carries the kind and the note; a field saved under
      // a catalog entry that has since gone (or one that hasn't loaded yet)
      // falls back to what the mapping itself remembers.
      const cat = (fileFieldCatalog || []).find((c) => c.fn === f.fn) || { key: f.key, fn: f.fn, kind: f.kind };
      return lockedRow({
        key: cat.key,
        badge: `file:${cat.fn}`,
        kind: cat.kind,
        note: cat.note,
        include: {
          checked: true,
          title: "Remove this field",
          place: `file:${cat.key}`,
          onToggle: (on) => toggleField("file", cat, on),
        },
      });
    });
    return {
      title: "File fields",
      rows,
      // An admin gets the add button as the empty state: it says what to do
      // about the emptiness, which "No file fields." doesn't.
      empty: !fileFieldCatalog ? "Loading file fields…" : isAdmin ? null : "No file fields.",
      footer: fileFieldCatalog && isAdmin ? makeAddFileFieldBtn() : null,
    };
  }

  // AI fields: the only editable rows in the pane, and the only section with a
  // provenance band — the model that fills them is a thing worth naming here.
  function aiSection() {
    return {
      title: "AI-extracted fields",
      band: extractBand?.el,
      rows: fields.filter((f) => f.from === "ai").map(makeAiRow),
      empty: isAdmin ? "No AI fields — add one below." : "No AI fields defined.",
      footer: isAdmin ? makeAddAiFieldBtn() : null,
    };
  }

  const renderFields = keepPlace(fieldsList, () => {
    fieldsList.replaceChildren();
    drawSection(inputConnector ? connectorSection() : fileSection());
    drawSection(aiSection());
  });

  renderFaceRow();
  renderFields();
  body.appendChild(fieldsList);
  // For an already-bound board, fetch the connector's catalog so un-included
  // fields + face producers show too (template load fills them directly).
  if (inputConnector && !connectorCatalog) loadCatalog();
  // File boards: fetch the media field catalog so the "File fields" section can
  // offer every addable field (already-included ones render checked).
  if (!inputConnector) loadFileFields();

  // The host modal owns the Save button. Non-admins get a read-only pane, so
  // say why inline (the host's Save persists tagging only for them).
  if (!isAdmin) {
    const note = document.createElement("p");
    note.style.cssText = "font-size:12px;color:#8a8a92;margin:8px 0 0;";
    note.textContent = "Only admins can edit the entity mapping.";
    body.appendChild(note);
  }

  async function loadCatalog() {
    try {
      const connectors = await fetch("/api/connectors").then((r) => r.json());
      const c = connectors.find((x) => x.name === inputConnector);
      if (c) {
        connectorCatalog = c.fields || [];
        connectorFaces = c.faces || [];
        connectorLabel = c.label;
        connectorProviders = c.providers || [];
        connectorActiveProvider = c.activeProvider || null;
        connectorAvailable = c.available !== false;
        connectorReason = c.reason || null;
        syncTemplateBtn(); // the trigger was showing the bare connector name
        syncUnavailable();
        renderFields();
        renderFaceRow();
      }
    } catch { /* leave catalog null → the saved-fields fallback stands */ }
  }

  async function loadFileFields() {
    if (fileFieldCatalog) return;
    try {
      fileFieldCatalog = await fetch("/api/file-fields").then((r) => r.json());
      renderFields();
    } catch { /* leave null → the "Loading…" line stands, AI section still works */ }
  }

  function applyTemplate(connector) {
    const t = connector.template;
    inputConnector = t.input?.connector || null;
    identityFrom = t.identity?.from || "raw";
    identityHint = t.identity?.hint || "";
    candidates = (t.identity?.candidates || []).map((c) => ({ ...c }));
    classifyOn = candidates.length > 0;
    fields = (t.fields || []).map((f) => ({ ...f }));
    connectorCatalog = connector.fields || [];
    connectorFaces = connector.faces || [];
    connectorLabel = connector.label;
    connectorProviders = connector.providers || [];
    connectorActiveProvider = connector.activeProvider || null;
    connectorAvailable = connector.available !== false;
    connectorReason = connector.reason || null;
    faceCfg = t.face ? { ...t.face } : { from: "raw" };
    markDirty();
    syncTemplateBtn();
    syncUnavailable();
    renderIdentityRow();
    renderFaceRow();
    renderFields();
  }

  // The inverse of applyTemplate: back to the pristine file board. A template
  // rewires the whole mapping, so unloading one has to undo the whole thing —
  // the connector fields name a source that's gone, and the identity/face they
  // set only mean something under that source. That takes the template's AI
  // fields with it, which is the same wholesale swap applyTemplate already
  // does in the other direction.
  function clearTemplate() {
    if (!inputConnector) return;
    inputConnector = null;
    identityFrom = "raw";
    identityHint = "";
    candidates = [];
    classifyOn = false;
    fields = [];
    connectorCatalog = null;
    connectorFaces = [];
    connectorLabel = null;
    connectorProviders = [];
    connectorActiveProvider = null;
    connectorAvailable = true;
    connectorReason = null;
    faceCfg = { from: "raw" };
    markDirty();
    syncTemplateBtn();
    syncUnavailable();
    loadFileFields(); // the File fields section needs a catalog it never fetched
    renderIdentityRow();
    renderFaceRow();
    renderFields();
  }

  // Validate + assemble the mapping payload for the host modal's PATCH. Returns
  // { ok:false } after toasting on invalid input, else { ok:true, payload } —
  // the payload merges straight into the board PATCH body. Extraction's pin
  // rides the host's capability pickers, not this pane.
  function collect() {
    // Blur whatever is being edited so the key input re-displays its normalized
    // value. The MODEL is already current — every control in the pane writes on
    // input/change — so this is about what the reader sees: the messages below
    // name keys, and they have to name what's on screen.
    const activeKey = document.activeElement;
    if (activeKey && fieldsList.contains(activeKey)) activeKey.blur();

    // Separate AI fields (need validation) from connector + file fields (locked, pass through).
    const aiFields = fields.filter((f) => f.from === "ai" && f.key);
    const connectorFields = fields.filter((f) => f.from === "connector");
    const fileFields = fields.filter((f) => f.from === "file");
    const seen = new Set();
    for (const f of aiFields) {
      if (!/^[a-z][a-z0-9_]*$/.test(f.key)) { toast.error(`Invalid field key: "${f.key}"`); return { ok: false }; }
      if (seen.has(f.key)) { toast.error(`Duplicate field key: "${f.key}"`); return { ok: false }; }
      seen.add(f.key);
    }

    if (identityFrom === "ai" && !identityHint.trim()) {
      toast.error("Identity hint is required when using AI instruction");
      return { ok: false };
    }
    // Classify: keep only options that carry a value; trim hints. An on toggle
    // with nothing usable is a half-state — block it rather than save a listless
    // classifier (keeps "mode = has a list" true, mirroring the server).
    const cleanCandidates = candidates
      .map((c) => ({ value: (c.value || "").trim(), ...(c.hint && c.hint.trim() ? { hint: c.hint.trim() } : {}) }))
      .filter((c) => c.value);
    if (identityFrom === "ai" && classifyOn && !cleanCandidates.length) {
      toast.error("Add at least one option, or turn off “Match to a list”");
      return { ok: false };
    }
    const identitySlot = identityFrom === "ai"
      ? { from: "ai", hint: identityHint.trim(), ...(classifyOn && cleanCandidates.length ? { candidates: cleanCandidates } : {}) }
      : identityFrom === "connector"
        ? { from: "connector" }
        : { from: "raw" };

    const allFields = [
      ...connectorFields.map((f) => ({ key: f.key, kind: f.kind, from: "connector", fn: f.fn, ...(f.live ? { live: true, every: f.every } : {}) })),
      ...fileFields.map((f) => ({ key: f.key, kind: f.kind, from: "file", fn: f.fn })),
      ...aiFields.map((f) => ({ key: f.key, kind: f.kind, from: "ai", ...(f.hint ? { hint: f.hint } : {}) })),
    ];
    let face = null;
    if (faceCfg.from === "connector") {
      face = { from: "connector", producer: faceCfg.producer, period: faceCfg.period, ...(faceCfg.live ? { live: true, every: faceCfg.every } : {}) };
    } else if (!inputConnector && identityFrom === "ai") {
      // Derived file board: the preview follows an explicit preference — image by
      // default. There's no "no preference" option; prefer is soft (selectFace
      // falls back to any instance when the type is absent), so a default of image
      // just means "show the image if there is one". Raw identity is single-
      // instance, so flipping ai→raw and saving drops the face entirely.
      face = { from: "file", prefer: faceCfg.prefer && faceCfg.prefer !== "any" ? faceCfg.prefer : "image", pick: faceCfg.pick || "first" };
    }
    const hasContent = allFields.length > 0 || identityFrom !== "raw" || inputConnector || face;
    const mapping = hasContent
      ? {
          ...(inputConnector ? { input: { connector: inputConnector } } : {}),
          identity: identitySlot,
          ...(face ? { face } : {}),
          fields: allFields,
        }
      : null;

    return { ok: true, payload: { mapping } };
  }

  return { isDirty: () => dirty, collect, setExtractionBand };
}
