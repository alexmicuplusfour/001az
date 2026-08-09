// Per-plugin configuration modal, opened from the Plugins tab gear. Sections
// vary by kind: connectors get their schema-driven config form (key, rate
// limits) plus Test and the domain-default star; AI providers get their key
// registry (this provider's slice of ai_keys) plus the default-tagger /
// embeddings slots they can serve; media types are informational (core
// capabilities, nothing to configure). The last recorded health error surfaces
// at the top. All writes go through the plugins API + the existing
// ai-keys/ai-config routes — this file owns no state of its own.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { createModal, sectionHeading, sectionHeadingEl } from "/modal.js";
import { syncModelPicker, switchRow } from "/board-modal.js";
import { fillSelect, isUnset } from "/select.js";
import { fmtDuration } from "/utils.js";

const relTime = (ts) => `${fmtDuration(Date.now() - ts)} ago`;

const LABEL_CSS = "display:block;font-size:12px;color:#6b6b72;margin-bottom:4px;";
const MONO_CSS = "font-family:'SF Mono',Consolas,monospace;font-size:13px;";

function section(title, sub) {
  const box = document.createElement("div");
  box.style.cssText = "display:flex;flex-direction:column;gap:12px;";
  box.innerHTML = sectionHeading(title, sub);
  return box;
}

function labeled(label, el) {
  const row = document.createElement("div");
  row.innerHTML = `<label style="${LABEL_CSS}">${label}</label>`;
  row.appendChild(el);
  return row;
}

const busy = (btn, label, fn) => async () => {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = label;
  try { await fn(); } finally { btn.disabled = false; btn.textContent = prev; }
};

// A slot's promote button, always labelled "Make default {slot}" and always
// ghost — the same weight as the connector's "Make default for {domain}".
// Enabled when this provider isn't the default; when it already IS, it sits
// disabled as a status marker and re-enables only once you change the key or
// model, so you can still repoint the running default. `sels` are the selects
// to watch; `apply` runs the write.
//
// A picker still on its empty state is not an answer, so it holds the button
// down too — which is also what keeps `apply` from posting the placeholder's ""
// as a key id. Note the ordering this relies on: each section wires the key
// select's model-refill listener BEFORE building this button, so by the time
// `sync` runs the model picker has already been emptied for the new connection.
function slotButton(label, isDefault, sels, apply) {
  const btn = document.createElement("button");
  btn.className = "ghost";
  btn.textContent = label;
  const initial = sels.map((s) => s.value);
  const sync = () => {
    btn.disabled = sels.some(isUnset)
      || (isDefault && !sels.some((s, i) => s.value !== initial[i]));
  };
  sels.forEach((s) => s.addEventListener("change", sync));
  sync();
  btn.onclick = busy(btn, "Saving…", apply);
  return btn;
}

// What a slot's pickers say before they have been answered. The key one echoes
// the label above it — a keyless provider has connections, not keys — and both
// read as instructions, so an untouched slot section can't be mistaken for a
// configured one.
const pickKey = (p) => `Select a ${p.ai.keyless ? "connection" : "key"}`;
const PICK_MODEL = "Select a model";

// Beside an enabled promote button: what you'd be replacing. providerName is
// a slot's current holder (ctx.defaults.*) — resolved to its display label
// via ctx.plugins; an empty slot reads "none".
function currentDefaultNote(ctx, providerName, model) {
  const span = document.createElement("span");
  span.className = "muted";
  span.style.cssText = "font-size:12px;";
  const label = providerName ? (ctx.plugins?.find((x) => x.name === providerName)?.label || providerName) : "none";
  span.textContent = `Current default: ${label}${model ? ` · ${model}` : ""}`;
  return span;
}

// Live commit for a SETTINGS control — the plugin modals carry no Save
// buttons; each field commits itself on `change` (blur for typed input,
// instant for steppers/toggles). Success is QUIET — a toast per blur is
// noise; `commit` only speaks when it has something to say (a key landed, a
// value will be clamped). Failure toasts the error and puts the last-saved
// value back — except `revertOnError: false` (secrets), where wiping the
// field would mean re-pasting the key just to retry. An unchanged blur is a
// no-op, which also means an empty secret field can never blur-clear a
// stored key. Commits are serialized per field, NOT gated by disabling the
// control — a stepper/Enter `change` fires with focus still in the field,
// and disabling it would steal that focus and eat clicks mid-commit.
// Settings only: creation forms (keys, source connections) and the slot
// promotions stay explicit buttons — those change WHAT something is, not
// how it's tuned.
function autosave(el, commit, { revertOnError = true } = {}) {
  let saved = el.value;
  let chain = Promise.resolve();
  el.addEventListener("change", () => {
    if (el.value === saved) return;
    chain = chain.then(async () => {
      if (el.value === saved) return; // a queued change already settled here
      try {
        await commit();
        saved = el.value;
      } catch (err) {
        toast.error(err.message);
        if (revertOnError) el.value = saved;
      }
    });
  });
}

export function openPluginModal(p, ctx) {
  const { body, footer, close } = createModal({
    title: p.label,
    bodyStyle: "display:flex;flex-direction:column;gap:26px;",
  });

  // Every mutating action re-fetches state and rebuilds the modal in place
  // rather than closing it — only Close dismisses the modal. So a "Make default
  // …", a saved slot, or an added key reflects immediately (the button flips,
  // status text updates) and the cards behind stay in sync. Builders get this
  // `reload` where they used to get a `done` that closed.
  async function reload() {
    let state;
    try { state = await ctx.getState(); } catch { return; }
    p = state.plugins.find((x) => x.id === p.id) || p;
    ctx = { ...ctx, plugins: state.plugins, slots: state.slots, keys: state.keys, connections: state.connections, defaults: state.defaults };
    render();
    ctx.refresh(state); // repaint the cards behind, reusing the state we just fetched
  }

  // Builders return their section node; every action lives inside its
  // section — autosaving fields, slot buttons, per-row actions, add/edit
  // forms — so the footer holds just Close, for every plugin kind. There is
  // deliberately no footer-level commit: one once saved only the rate-limit
  // section while looking modal-wide, and the reload it triggered discarded
  // a model choice staged in the section above it.
  function render() {
    body.replaceChildren();
    footer.replaceChildren();

    // Health lives here now (the row has no status dot): surface the last
    // recorded error, if any, so a failing integration is legible where you'd fix it.
    const health = p.state.health;
    if (health?.lastError?.message) {
      const banner = document.createElement("div");
      banner.style.cssText = "background:#fdf0f0;border:1px solid #f3d3d3;color:#8a3535;border-radius:8px;padding:9px 12px;font-size:12px;line-height:1.4;";
      const when = health.lastFailAt ? ` · ${relTime(health.lastFailAt)}` : "";
      banner.textContent = `Last error${when}: ${health.lastError.message}`;
      body.appendChild(banner);
    }

    const built = [];
    if (p.kind === "connector") {
      built.push(connectorSection(p, ctx, reload));
    } else if (p.kind === "ai") {
      // On-device providers (local embedder, whisper sidecar) have no accounts
      // — nothing to register. Keyless-NETWORKED providers still get the
      // section: their rows are connections without a secret.
      if (!p.ai.onDevice) built.push(keysSection(p, ctx, reload));
      if (p.capabilities.tag) built.push(taggerSection(p, ctx, reload));
      if (p.capabilities.embed) built.push(embedSection(p, ctx, reload));
      if (p.capabilities.transcribe) built.push(transcribeSection(p, ctx, reload));
      if (p.capabilities.detect) built.push(detectSection(p, ctx, reload));
      if (p.configSchema.length) built.push(pacingSection(p)); // rpm/burst — networked providers only
    } else if (p.kind === "source") {
      built.push(sourceSection(p, ctx, reload));
    } else {
      built.push(mediaSection(p));
    }
    for (const b of built) body.appendChild(b);

    const closeBtn = document.createElement("button");
    closeBtn.className = "ghost";
    closeBtn.textContent = "Close";
    closeBtn.onclick = close;
    footer.appendChild(closeBtn);
  }

  render();
}

// --- connector: schema-driven config + test + domain default ---

function connectorSection(p, ctx, reload) {
  const d = ctx.slots.domains[p.connector.domain] || {};
  const isDefault = (d.setting || d.effective) === p.name;
  const sec = section(
    "Configuration",
    `${p.connector.domainLabel} data provider.` + (isDefault ? " Currently the default for new adds." : "")
  );

  // One input per schema field; the plugin declares them, we just render.
  // Every field autosaves itself (the PATCH merges per key) — no Save button.
  const saveField = (key, v) => api("PATCH", `/api/admin/plugins/${p.id}`, { config: { [key]: v } });
  let secretInput = null; // Test sends the typed key so it works pre-blur
  for (const f of p.configSchema) {
    if (f.type === "secret") {
      const input = document.createElement("input");
      input.type = "password";
      // "new-password", not "off": Chrome ignores "off" on password fields once
      // a login is saved for the site, and autofills credentials into key forms.
      input.autocomplete = "new-password";
      input.style.cssText = `width:100%;box-sizing:border-box;${MONO_CSS}`;
      input.placeholder = p.state.hasKey
        ? "•••• stored — leave blank to keep"
        : f.required ? "paste key" : f.help || "optional";
      const row = labeled(f.label, input);
      // Paste → blur = saved. autosave's unchanged-guard means an empty blur
      // can never write, so a stored key is cleared ONLY by the explicit
      // confirmed remove below. reload() after a key write: hasKey flips, and
      // blur already happened so the rebuild steals no focus. On failure the
      // typed key stays put (revertOnError: false) — wiping it would mean
      // re-pasting just to retry.
      autosave(input, async () => {
        const v = input.value.trim();
        if (!v) return;
        await saveField(f.key, v);
        toast(`${p.label} ${f.label.toLowerCase()} saved`);
        reload();
      }, { revertOnError: false });
      if (p.state.hasKey) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "danger";
        rm.style.cssText = "margin-top:6px;padding:4px 10px;font-size:12px;";
        rm.textContent = "remove stored key";
        rm.onclick = busy(rm, "Removing…", async () => {
          if (!confirm(`Remove the stored ${f.label}?`)) return;
          try {
            await saveField(f.key, ""); // "" clears the secret store
            toast(`${p.label} ${f.label.toLowerCase()} removed`);
            reload();
          } catch (err) { toast.error(err.message); }
        });
        row.appendChild(rm);
      }
      secretInput = input;
      sec.appendChild(row);
    } else if (f.type === "number") {
      const input = document.createElement("input");
      input.type = "number";
      if (f.min !== undefined) input.min = String(f.min);
      input.value = p.state.config[f.key] ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;";
      autosave(input, async () => {
        const v = input.value === "" ? null : Number(input.value); // empty = back to the plugin's default
        await saveField(f.key, v);
        p.state.config[f.key] = v;
      });
      sec.appendChild(labeled(f.label + (f.help ? ` <span style="color:#b6b6bd;font-weight:400;">· ${f.help}</span>` : ""), input));
    } else if (f.type === "toggle") {
      // switchRow owns its visual state; a failed write reloads to restore truth.
      sec.appendChild(switchRow(f.label, f.help || "", !!p.state.config[f.key], async (v) => {
        try {
          await saveField(f.key, v);
          p.state.config[f.key] = v;
        } catch (err) { toast.error(err.message); reload(); }
      }));
    } else {
      const input = document.createElement("input");
      input.value = p.state.config[f.key] ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;";
      autosave(input, async () => {
        const v = input.value.trim() || null;
        await saveField(f.key, v);
        p.state.config[f.key] = v;
      });
      sec.appendChild(labeled(f.label, input));
    }
  }

  // "Make default for {domain}" is a role toggle, separate from saving this
  // provider's config, so it sits at the bottom of the section (not the footer)
  // and never closes the modal. We flip it in place rather than reload() so any
  // unsaved edits in the fields above survive the click.
  if (!isDefault) {
    const star = document.createElement("button");
    star.className = "ghost";
    star.style.alignSelf = "flex-start";
    star.textContent = `Make default for ${p.connector.domainLabel}`;
    star.onclick = busy(star, "Saving…", async () => {
      try {
        await api("POST", `/api/admin/plugins/slots/${p.connector.domain}`, { provider: p.name });
        toast(`${p.label} is now the ${p.connector.domainLabel} default`);
        star.remove();
        sec.querySelector(".sub").textContent = `${p.connector.domainLabel} data provider. Currently the default for new adds.`;
        ctx.refresh(); // repaint the card's default badge behind the modal
      } catch (err) { toast.error(err.message); }
    });
    sec.appendChild(star);
  }

  // Test lives in the section like every other action (the footer holds just
  // Close). The typed key rides along when present, so Test works even before
  // the blur that saves it; otherwise it tests the stored one.
  const test = document.createElement("button");
  test.className = "ghost";
  test.style.alignSelf = "flex-start";
  test.textContent = "Test";
  test.onclick = busy(test, "Testing…", async () => {
    const typed = secretInput?.value.trim();
    try {
      const body = typed ? { api_key: typed } : undefined;
      const { provider } = await api("POST", `/api/admin/plugins/${p.id}/test`, body);
      toast(`✓ ${provider} reachable`);
    } catch (err) { toast.error(err.message); }
  });
  sec.appendChild(test);

  return sec;
}

// --- ai: per-provider request pacing (rpm/burst) — mirrors the connector config ---
// Same number-field shape as connectorSection, scoped to the rate-limit
// fields the ai plugin declares. On-device providers declare none, so the
// dispatch above skips this section for them; keyless-networked ones pace like
// any other. Empty input = back to the descriptor default. No Save button:
// each field autosaves itself per key (the PATCH merges), and nothing
// rebuilds the modal — a rebuild here once discarded a model choice staged
// in the tagger section above.
function pacingSection(p) {
  const sec = section(
    "Rate limit",
    "How fast the worker calls this provider's API, per key. Raise it to match your account tier; blank uses the default. Saves as you edit."
  );
  for (const f of p.configSchema) {
    const input = document.createElement("input");
    input.type = "number";
    if (f.min !== undefined) input.min = String(f.min);
    input.value = p.state.config[f.key] ?? "";
    input.placeholder = `default ${f.default}`;
    input.style.cssText = "width:100%;box-sizing:border-box;";
    autosave(input, async () => {
      const v = input.value === "" ? null : Number(input.value); // null = clear the override, back to default
      await api("PATCH", `/api/admin/plugins/${p.id}`, { config: { [f.key]: v } });
      p.state.config[f.key] = v; // local truth without a rebuild
    });
    sec.appendChild(labeled(f.label + (f.help ? ` <span style="color:#b6b6bd;font-weight:400;">· ${f.help}</span>` : ""), input));
  }
  return sec;
}

// --- ai: this provider's keys (add / test / remove) ---

function keysSection(p, ctx, reload) {
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  // A keyless provider (self-hosted — no account secret) registers the same
  // rows as connections: the row is what boards and the default slots point
  // at, it just carries no key. Same section, softened language + optional input.
  const keyless = p.ai.keyless;
  const noun = keyless ? "connection" : "key";
  const sec = section(
    keyless ? "Connections" : "API keys",
    `Named ${noun}s for this provider. Boards can pick any of them; one can be the app default below.`
  );

  // Self-hosted providers (needsBase): a connection IS a server, so show where
  // each row points — its own URL, or the plugin's default base.
  const needsBase = p.ai.needsBase;
  if (mine.length) {
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr><th>Name</th>${needsBase ? "<th>Server</th>" : ""}<th>Key</th><th></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const k of mine) {
      const isDefault = ctx.slots.tagger.keyId === k.id;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${k.name} ${isDefault ? '<span class="badge">default</span>' : ""}</td>
        ${needsBase ? `<td style="${MONO_CSS}color:#9aa0aa"></td>` : ""}
        <td style="${MONO_CSS}color:#9aa0aa">${k.hint}</td>
        <td><div class="row-actions"></div></td>`;
      if (needsBase) tr.children[1].textContent = k.base_url || `${p.ai.base || "?"} (default)`;
      const act = tr.querySelector(".row-actions");

      const testBtn = document.createElement("button");
      testBtn.className = "ghost";
      testBtn.textContent = "test";
      testBtn.onclick = busy(testBtn, "testing…", async () => {
        try {
          await api("POST", `/api/admin/ai-keys/${k.id}/test`);
          toast(`✓ "${k.name}" ${noun} works`);
        } catch (err) { toast.error(`"${k.name}": ${err.message}`); }
      });

      const editBtn = document.createElement("button");
      editBtn.className = "ghost";
      editBtn.textContent = "edit";
      editBtn.onclick = () => beginEdit(k);

      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "remove";
      delBtn.onclick = async () => {
        const uses = Number(k.boards_using) || 0;
        const extra = uses ? ` ${uses} board(s) use it and will fall back to the default.` : "";
        if (!confirm(`Remove ${noun} "${k.name}"?${extra}${isDefault ? " It is the current default — tagging falls back to the env var (or stops)." : ""}`)) return;
        try {
          await api("DELETE", `/api/admin/ai-keys/${k.id}`);
          toast(`${keyless ? "Connection" : "Key"} "${k.name}" removed`);
          reload();
        } catch (err) { toast.error(err.message); }
      };
      act.append(testBtn, editBtn, delBtn);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sec.appendChild(table);
  } else {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    none.textContent =
      p.name === "anthropic" && ctx.slots.tagger.envKey
        ? "No keys stored — tagging runs on the ANTHROPIC_API_KEY env var."
        : `No ${noun}s yet.`;
    sec.appendChild(none);
  }

  const addForm = document.createElement("form");
  addForm.style.cssText = "margin:0;";
  const nameIn = document.createElement("input");
  nameIn.placeholder = keyless ? "Name (e.g. Homelab)" : "Name (e.g. Personal)";
  nameIn.required = true;
  nameIn.autocomplete = "off";
  // Self-hosted: the server URL is the connection's identity. Blank keeps the
  // plugin's default base (shown as the placeholder).
  let baseIn = null;
  if (needsBase) {
    baseIn = document.createElement("input");
    baseIn.type = "text";
    baseIn.placeholder = p.ai.base || "http://host:port/v1";
    baseIn.autocomplete = "off";
    baseIn.spellcheck = false;
    baseIn.style.cssText = MONO_CSS;
  }
  const keyIn = document.createElement("input");
  keyIn.type = "password";
  // Keyless: the token is optional (e.g. a reverse proxy in front of the box).
  keyIn.placeholder = keyless ? "token (optional)" : "sk-…";
  // "new-password", not "off": Chrome ignores "off" on password fields once a
  // login is saved for the site, and autofills email+password into name+key.
  keyIn.autocomplete = "new-password";
  keyIn.required = !keyless;
  keyIn.style.cssText = MONO_CSS;
  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.textContent = `Add ${noun}`;
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost";
  cancelBtn.textContent = "Cancel";
  cancelBtn.hidden = true;
  addForm.append(nameIn, ...(baseIn ? [baseIn] : []), keyIn, addBtn, cancelBtn);

  // Edit-in-place reuses the add form (the sourceSection pattern): prefill,
  // flip the button to Save, PATCH on submit. The row id never changes, so
  // boards and the default slots ride through a rename / repoint / rotation.
  let editingId = null;
  function beginEdit(k) {
    editingId = k.id;
    nameIn.value = k.name;
    if (baseIn) baseIn.value = k.base_url || "";
    keyIn.value = "";
    keyIn.required = false;
    keyIn.placeholder = k.hint === "no key" ? "token (optional)" : "•••• stored — leave blank to keep";
    addBtn.textContent = "Save changes";
    cancelBtn.hidden = false;
    nameIn.focus();
  }
  cancelBtn.onclick = () => {
    editingId = null;
    addForm.reset();
    keyIn.required = !keyless;
    keyIn.placeholder = keyless ? "token (optional)" : "sk-…";
    addBtn.textContent = `Add ${noun}`;
    cancelBtn.hidden = true;
  };

  addForm.onsubmit = async (e) => {
    e.preventDefault();
    addBtn.disabled = true;
    try {
      if (editingId) {
        await api("PATCH", `/api/admin/ai-keys/${editingId}`, {
          name: nameIn.value.trim(),
          ...(keyIn.value.trim() ? { key: keyIn.value.trim() } : {}), // blank = keep the stored one
          ...(baseIn ? { base_url: baseIn.value.trim() } : {}), // blank = back to the default
        });
        toast(`${keyless ? "Connection" : "Key"} "${nameIn.value.trim()}" saved`);
      } else {
        await api("POST", "/api/admin/ai-keys", {
          name: nameIn.value.trim(),
          provider: p.name,
          key: keyIn.value.trim(),
          ...(baseIn?.value.trim() ? { base_url: baseIn.value.trim() } : {}),
        });
        toast(`${keyless ? "Connection" : "Key"} "${nameIn.value.trim()}" added`);
      }
      reload(); // rebuilds the section — form state resets with it
    } catch (err) {
      toast.error(err.message);
      addBtn.disabled = false;
    }
  };
  sec.appendChild(addForm);
  return sec;
}

// --- ai: the default-tagger slot ---

function taggerSection(p, ctx, reload) {
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  const isDefault = ctx.defaults.tagger === p.name;
  const sec = section("Default tagger", "Used by every board that doesn't set its own key.");

  const envOption = p.name === "anthropic" && ctx.slots.tagger.envKey;
  if (!mine.length && !envOption) {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    none.textContent = `Add a ${p.ai.keyless ? "connection" : "key"} above to make this provider the default tagger.`;
    sec.appendChild(none);
    return sec;
  }

  const keySel = document.createElement("select");
  keySel.style.cssText = "width:100%;";
  const conns = mine.map((k) => ({ value: String(k.id), label: k.name }));
  if (envOption) conns.push({ value: "env", label: "ANTHROPIC_API_KEY env var" });
  // Only the slot's own holder gets a selection to show. While the slot is
  // someone else's, this section is a proposal, and a proposal that arrives
  // pre-filled reads as a decision — so it starts empty.
  const slotConn = ctx.slots.tagger.keyId ? String(ctx.slots.tagger.keyId) : "env";
  fillSelect(keySel, conns, { value: isDefault ? slotConn : null, placeholder: pickKey(p) });
  sec.appendChild(labeled(p.ai.keyless ? "Connection" : "Key", keySel));

  const modelSel = document.createElement("select");
  modelSel.style.cssText = "width:100%;";
  // Options follow the selected connection ("env" has no ai_keys row, but
  // the server holds that key — the route's env branch lists with it). The
  // slot's persisted model rides as `saved` only when the selected
  // connection IS the slot's; anywhere else the picker is empty, including
  // after you repoint an already-default slot at a different connection.
  const syncLive = () => syncModelPicker(modelSel, p.ai, keySel.value === "env" ? "env" : Number(keySel.value) || null, {
    saved: isDefault && keySel.value === slotConn ? ctx.slots.tagger.model : null,
    placeholder: PICK_MODEL,
  });
  keySel.addEventListener("change", syncLive);
  syncLive();
  sec.appendChild(labeled("Model", modelSel));

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";
  const apply = async () => {
    try {
      await api("POST", "/api/admin/ai-config", {
        defaultKeyId: keySel.value === "env" ? null : Number(keySel.value),
        model: modelSel.value,
      });
      toast("Default tagger saved");
      reload();
    } catch (err) { toast.error(err.message); }
  };
  actions.appendChild(slotButton("Make default tagger", isDefault, [keySel, modelSel], apply));
  if (!isDefault) actions.appendChild(currentDefaultNote(ctx, ctx.defaults.tagger, ctx.slots.tagger.model));

  if (isDefault) {
    const test = document.createElement("button");
    test.className = "ghost";
    test.textContent = "Test";
    test.onclick = busy(test, "Testing…", async () => {
      try {
        const { model: m, provider: pr } = await api("POST", "/api/admin/ai-config/test");
        toast(`✓ ${pr}/${m} reachable`);
      } catch (err) { toast.error(err.message); }
    });
    actions.appendChild(test);
  }
  sec.appendChild(actions);
  return sec;
}

// --- ai: the embedder slot (semantic search) ---

function embedSection(p, ctx, reload) {
  const em = ctx.slots.embedder;
  const active = ctx.defaults.embedder === p.name;
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  const sec = section("Semantic search", "Free-text search that ranks a board's items by meaning. One embedder serves the whole app — vectors only compare within a model.");

  if (!p.ai.onDevice && !mine.length) {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    none.textContent = `Add a ${p.ai.keyless ? "connection" : "key"} above to embed with this provider.`;
    sec.appendChild(none);
    return sec;
  }

  let keySel = null;
  if (!p.ai.onDevice) {
    keySel = document.createElement("select");
    keySel.style.cssText = "width:100%;";
    // One key and already the slot's holder means there is no question to ask,
    // and the row stays hidden — so it gets no empty state either. An unanswered
    // picker nobody can see is just a button that never enables.
    const ask = mine.length > 1 || !active;
    fillSelect(keySel, mine.map((k) => ({ value: String(k.id), label: k.name })), {
      value: active && em.keyId ? String(em.keyId) : null,
      placeholder: ask ? pickKey(p) : null,
    });
    if (ask) sec.appendChild(labeled(p.ai.keyless ? "Connection" : "Key", keySel));
  }

  let modelSel = null;
  if (p.ai.embeds.models.length > 1 || !p.ai.onDevice) {
    modelSel = document.createElement("select");
    modelSel.style.cssText = "width:100%;";
    // Live options carved to embedders (descriptor embeds.filter) — an
    // on-device provider has no connection row to ask (null keyId: curated
    // render only). `saved` = the slot's persisted embed model, when the
    // selected connection is the slot's.
    const entry = { models: p.ai.embeds.models, defaultModel: p.ai.embeds.default };
    const syncLive = () => syncModelPicker(modelSel, entry, keySel ? Number(keySel.value) || null : null, {
      kind: "embed",
      saved: active && (keySel ? Number(keySel.value) === em.keyId : true) ? em.model : null,
      placeholder: PICK_MODEL,
    });
    if (keySel) keySel.addEventListener("change", syncLive);
    syncLive();
    sec.appendChild(labeled("Embedding model", modelSel));
  } else {
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = p.ai.embeds.models[0].id + " — " + p.ai.embeds.models[0].note;
    sec.appendChild(note);
  }

  if (active && em.enabled) {
    // the backfill status line, honest about skipped items (they don't retry
    // on their own — re-tagging does)
    const { embedded = 0, tagged = 0, failed = 0 } = em.stats || {};
    const remaining = tagged - embedded - failed;
    const status = document.createElement("p");
    status.className = "muted";
    status.style.margin = "0";
    status.textContent =
      tagged && embedded < tagged
        ? `${embedded} of ${tagged} tagged items embedded${remaining > 0 ? " — the rest backfill in the background" : ""}.`
        : `All ${tagged} tagged items embedded.`;
    if (failed) status.textContent += ` ${failed} skipped after embedding errors — re-tagging retries them.`;
    sec.appendChild(status);
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";

  const enabled = active && em.enabled;
  const apply = async () => {
    const model = modelSel?.value || p.ai.embeds.default;
    if (enabled && em.model && em.model !== model &&
        !confirm("Changing the embedding model re-embeds every item (costs cents, takes a while). Continue?")) return;
    try {
      // An on-device embedder is selected by name (no key row); everything else
      // — keyed or keyless-networked — goes through its connection row.
      await api("POST", "/api/admin/ai-config", p.ai.onDevice
        ? { embedProvider: p.name, embedEnabled: true }
        : { embedProvider: null, embedKeyId: Number(keySel.value), embedModel: model, embedEnabled: true });
      toast("Semantic search settings saved");
      reload();
    } catch (err) { toast.error(err.message); }
  };
  actions.appendChild(slotButton("Make default embedder", enabled, [keySel, modelSel].filter(Boolean), apply));
  if (!enabled) actions.appendChild(currentDefaultNote(ctx, ctx.defaults.embedder, ctx.slots.embedder.model));

  if (enabled) {
    const test = document.createElement("button");
    test.className = "ghost";
    test.textContent = "Test";
    test.onclick = busy(test, "Testing…", async () => {
      try {
        const { model: m, provider: pr } = await api("POST", "/api/admin/ai-config/embed-test");
        toast(`✓ ${pr}/${m} reachable`);
      } catch (err) { toast.error(err.message); }
    });
    const off = document.createElement("button");
    off.className = "danger";
    off.textContent = "Turn off";
    off.onclick = busy(off, "Saving…", async () => {
      try {
        await api("POST", "/api/admin/ai-config", { embedEnabled: false });
        toast("Semantic search turned off");
        reload();
      } catch (err) { toast.error(err.message); }
    });
    actions.append(test, off);
  }
  sec.appendChild(actions);
  return sec;
}

// Transcription slot — audio → text so recordings can be tagged. Mirrors
// embedSection, but transcription is always on (the whisper sidecar is the
// default), so there's no enable toggle: the provider choice IS the toggle.
// A provider advertises this via `transcribes`; the keyless whisper sidecar
// shows the model it reports live (via the server's /health probe) as a note —
// the model is baked into the sidecar image at deploy, not picked here.
function transcribeSection(p, ctx, reload) {
  const tr = ctx.slots.transcriber;
  const active = ctx.defaults.transcriber === p.name;
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  const sec = section("Transcription", "Audio → text so recordings can be tagged. One transcriber serves the whole app; the on-server whisper sidecar is the default.");

  if (!p.ai.onDevice && !mine.length) {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    none.textContent = `Add a ${p.ai.keyless ? "connection" : "key"} above to transcribe with this provider.`;
    sec.appendChild(none);
    return sec;
  }

  // Key picker (providers with connection rows — everything but on-device).
  let keySel = null;
  if (!p.ai.onDevice) {
    keySel = document.createElement("select");
    keySel.style.cssText = "width:100%;";
    const ask = mine.length > 1 || !active; // see embedSection: a hidden row asks nothing
    fillSelect(keySel, mine.map((k) => ({ value: String(k.id), label: k.name })), {
      value: active && tr.keyId ? String(tr.keyId) : null,
      placeholder: ask ? pickKey(p) : null,
    });
    if (ask) sec.appendChild(labeled(p.ai.keyless ? "Connection" : "Key", keySel));
  }

  // Model picker — a provider gets a dropdown of its transcribes.models; the
  // on-device sidecar shows its single baked model as a note.
  let modelSel = null;
  if (!p.ai.onDevice && p.ai.transcribes.models.length > 1) {
    modelSel = document.createElement("select");
    modelSel.style.cssText = "width:100%;";
    // Live options carved to transcription models (descriptor
    // transcribes.filter); `saved` = the slot's persisted model, when the
    // selected connection is the slot's.
    const entry = { models: p.ai.transcribes.models, defaultModel: p.ai.transcribes.default };
    const syncLive = () => syncModelPicker(modelSel, entry, Number(keySel.value) || null, {
      kind: "transcribe",
      saved: active && Number(keySel.value) === tr.keyId ? tr.model : null,
      placeholder: PICK_MODEL,
    });
    keySel.addEventListener("change", syncLive);
    syncLive();
    sec.appendChild(labeled("Transcription model", modelSel));
  } else {
    // `one` is whisper's live self-report (or a provider's single model); an
    // absent entry means the sidecar didn't answer — the baked model still serves.
    const one = p.ai.transcribes.models[0];
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = one ? one.id + " — " + one.note : "model baked at deploy (WHISPER_MODEL) — sidecar not reachable right now";
    sec.appendChild(note);
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";

  if (p.ai.onDevice) {
    // An on-device transcriber (the whisper sidecar, or a plugin with its own
    // wire) is picked by name — nothing to configure, so the button just makes
    // it the default, and sits disabled + secondary while it already is.
    const apply = async () => {
      try {
        await api("POST", "/api/admin/ai-config", { transcribeProvider: p.name });
        toast(`Transcription set to ${p.label}`);
        reload();
      } catch (err) { toast.error(err.message); }
    };
    actions.appendChild(slotButton("Make default transcriber", active, [], apply));
  } else {
    const apply = async () => {
      const model = modelSel?.value || p.ai.transcribes.default;
      try {
        await api("POST", "/api/admin/ai-config", {
          transcribeProvider: p.name,
          transcribeKeyId: Number(keySel.value),
          transcribeModel: model,
        });
        toast("Transcription settings saved");
        reload();
      } catch (err) { toast.error(err.message); }
    };
    actions.appendChild(slotButton("Make default transcriber", active, [keySel, modelSel].filter(Boolean), apply));

    if (active) {
      const test = document.createElement("button");
      test.className = "ghost";
      test.textContent = "Test";
      test.onclick = busy(test, "Testing…", async () => {
        try {
          const { model: m, provider: pr } = await api("POST", "/api/admin/ai-config/transcribe-test");
          toast(`✓ ${pr}/${m} reachable`);
        } catch (err) { toast.error(err.message); }
      });
      const off = document.createElement("button");
      off.className = "danger";
      off.textContent = "Use Whisper instead";
      off.onclick = busy(off, "Saving…", async () => {
        try {
          await api("POST", "/api/admin/ai-config", { transcribeProvider: "whisper" });
          toast("Transcription reverted to the on-device Whisper sidecar");
          reload();
        } catch (err) { toast.error(err.message); }
      });
      actions.append(test, off);
    }
  }
  if (!active) actions.appendChild(currentDefaultNote(ctx, ctx.defaults.transcriber, ctx.slots.transcriber.model));

  if (actions.children.length) sec.appendChild(actions);
  return sec;
}

// Object-detection slot — image → boxes from a text prompt. Mirrors
// transcribeSection: the engine is picked by name, the on-device LLMDet detector
// is the always-available default, so there's no enable toggle — the provider
// choice IS the toggle. A provider advertises this via `detects`; the keyless
// on-device detector shows its model as a note and offers a Test (which runs the
// LLMDet sidecar on a probe image).
function detectSection(p, ctx, reload) {
  const dt = ctx.slots.detector;
  const active = ctx.defaults.detector === p.name;
  const mine = ctx.keys.filter((k) => k.provider === p.name);
  const sec = section("Object detection", "Find objects in images from a text prompt. One detector serves the whole app; the on-device LLMDet model (object-detector sidecar) is the default.");

  if (!p.ai.onDevice && !mine.length) {
    const none = document.createElement("p");
    none.className = "muted";
    none.style.margin = "0";
    none.textContent = `Add a ${p.ai.keyless ? "connection" : "key"} above to detect with this provider.`;
    sec.appendChild(none);
    return sec;
  }

  // Key picker (providers with connection rows — everything but on-device).
  let keySel = null;
  if (!p.ai.onDevice) {
    keySel = document.createElement("select");
    keySel.style.cssText = "width:100%;";
    const ask = mine.length > 1 || !active; // see embedSection: a hidden row asks nothing
    fillSelect(keySel, mine.map((k) => ({ value: String(k.id), label: k.name })), {
      value: active && dt.keyId ? String(dt.keyId) : null,
      placeholder: ask ? pickKey(p) : null,
    });
    if (ask) sec.appendChild(labeled(p.ai.keyless ? "Connection" : "Key", keySel));
  }

  // Model picker — a provider gets a dropdown of its detects.models; the
  // on-device detector shows its single model as a note.
  let modelSel = null;
  if (!p.ai.onDevice && p.ai.detects.models.length > 1) {
    modelSel = document.createElement("select");
    modelSel.style.cssText = "width:100%;";
    const entry = { models: p.ai.detects.models, defaultModel: p.ai.detects.default };
    const syncLive = () => syncModelPicker(modelSel, entry, Number(keySel.value) || null, {
      kind: "detect",
      saved: active && Number(keySel.value) === dt.keyId ? dt.model : null,
      placeholder: PICK_MODEL,
    });
    keySel.addEventListener("change", syncLive);
    syncLive();
    sec.appendChild(labeled("Detection model", modelSel));
  } else {
    const one = p.ai.detects.models[0];
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = one ? one.id + " — " + one.note : "on-device model";
    sec.appendChild(note);
  }

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;align-items:center;";

  if (p.ai.onDevice) {
    // Picked by name — nothing to configure, so the button just makes it the
    // default (disabled + secondary while it already is). Test loads the model.
    const apply = async () => {
      try {
        await api("POST", "/api/admin/ai-config", { detectProvider: p.name });
        toast(`Object detection set to ${p.label}`);
        reload();
      } catch (err) { toast.error(err.message); }
    };
    actions.appendChild(slotButton("Make default detector", active, [], apply));
    if (active) {
      const test = document.createElement("button");
      test.className = "ghost";
      test.textContent = "Test";
      test.onclick = busy(test, "Loading model…", async () => {
        try {
          const { model: m, count } = await api("POST", "/api/admin/ai-config/detect-test");
          toast(`✓ ${m} ran (${count} found in probe)`);
        } catch (err) { toast.error(err.message); }
      });
      actions.appendChild(test);
    }
  } else {
    const apply = async () => {
      const model = modelSel?.value || p.ai.detects.default;
      try {
        await api("POST", "/api/admin/ai-config", {
          detectProvider: p.name,
          detectKeyId: Number(keySel.value),
          detectModel: model,
        });
        toast("Detection settings saved");
        reload();
      } catch (err) { toast.error(err.message); }
    };
    actions.appendChild(slotButton("Make default detector", active, [keySel, modelSel].filter(Boolean), apply));

    if (active) {
      const test = document.createElement("button");
      test.className = "ghost";
      test.textContent = "Test";
      test.onclick = busy(test, "Testing…", async () => {
        try {
          const { model: m, provider: pr, count } = await api("POST", "/api/admin/ai-config/detect-test");
          toast(`✓ ${pr}/${m} reachable (${count} found in probe)`);
        } catch (err) { toast.error(err.message); }
      });
      const off = document.createElement("button");
      off.className = "danger";
      off.textContent = "Use on-device detector instead";
      off.onclick = busy(off, "Saving…", async () => {
        try {
          await api("POST", "/api/admin/ai-config", { detectProvider: "localDetector" });
          toast("Detection reverted to the on-device object detector");
          reload();
        } catch (err) { toast.error(err.message); }
      });
      actions.append(test, off);
    }
  }
  if (!active) actions.appendChild(currentDefaultNote(ctx, ctx.defaults.detector, ctx.slots.detector.model));

  if (actions.children.length) sec.appendChild(actions);
  return sec;
}

// --- source: saved connections (add / edit / test / remove) ---

function sourceSection(p, ctx, reload) {
  // The local folder is a core capability — no saved connection, boards pick a
  // subfolder in their own ingestion settings.
  if (!p.capabilities.needsConnection) {
    const sec = section("Local folder", null);
    const note = document.createElement("p");
    note.className = "muted";
    note.style.margin = "0";
    note.textContent = "Core capability — files under the server's ingest root (INGEST_ROOT). Boards choose a subfolder in their own ingestion settings; there's nothing to configure here.";
    sec.appendChild(note);
    return sec;
  }

  const mine = (ctx.connections || []).filter((c) => c.type === p.name);
  const sec = section("Connections", `Saved ${p.label} servers. A board picks one plus a subpath — the credentials never leave here.`);

  if (mine.length) {
    const table = document.createElement("table");
    const head = document.createElement("thead");
    head.innerHTML = "<tr><th>Name</th><th>Server</th><th></th></tr>";
    table.appendChild(head);
    const tbody = document.createElement("tbody");
    for (const c of mine) {
      const tr = document.createElement("tr");

      const nameTd = document.createElement("td");
      nameTd.textContent = c.label;
      if (c.boards_using) {
        const b = document.createElement("span");
        b.className = "badge";
        b.style.marginLeft = "6px";
        b.textContent = `${c.boards_using} board${c.boards_using > 1 ? "s" : ""}`;
        nameTd.appendChild(b);
      }

      const hintTd = document.createElement("td");
      hintTd.style.cssText = `${MONO_CSS}color:#9aa0aa`;
      hintTd.textContent = p.connectionSchema.filter((f) => f.type === "text").map((f) => c.config?.[f.key]).filter(Boolean)[0] || "";

      const actTd = document.createElement("td");
      const act = document.createElement("div");
      act.className = "row-actions";
      const testBtn = document.createElement("button");
      testBtn.className = "ghost";
      testBtn.textContent = "test";
      testBtn.onclick = busy(testBtn, "testing…", async () => {
        try { await api("POST", "/api/admin/source-connections/test", { id: c.id }); toast(`✓ "${c.label}" reachable`); }
        catch (err) { toast.error(`"${c.label}": ${err.message}`); }
      });
      const editBtn = document.createElement("button");
      editBtn.className = "ghost";
      editBtn.textContent = "edit";
      editBtn.onclick = () => renderForm(c);
      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "remove";
      delBtn.onclick = async () => {
        const extra = c.boards_using ? ` ${c.boards_using} board(s) use it and will stop refreshing until re-pointed.` : "";
        if (!confirm(`Remove connection "${c.label}"?${extra}`)) return;
        try { await api("DELETE", `/api/admin/source-connections/${c.id}`); toast(`"${c.label}" removed`); reload(); }
        catch (err) { toast.error(err.message); }
      };
      act.append(testBtn, editBtn, delBtn);
      actTd.appendChild(act);

      tr.append(nameTd, hintTd, actTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sec.appendChild(table);
  }

  // Add / edit form. Rebuilt on mode switch so toggle rows get the right initial
  // state (switchRow captures its value at construction).
  const formHost = document.createElement("div");
  sec.appendChild(formHost);

  function renderForm(editing) {
    formHost.replaceChildren();
    const box = document.createElement("div");
    box.style.cssText = "display:flex;flex-direction:column;gap:10px;border-top:1px solid #eee;padding-top:12px;";
    box.appendChild(sectionHeadingEl(editing ? `Edit "${editing.label}"` : "Add a connection"));

    const labelIn = document.createElement("input");
    labelIn.placeholder = "Name (e.g. Client server)";
    labelIn.style.cssText = "width:100%;box-sizing:border-box;";
    labelIn.value = editing?.label || "";
    box.appendChild(labeled("Name", labelIn));

    const getters = [];
    for (const f of p.connectionSchema) {
      if (f.type === "toggle") {
        let on = editing ? !!editing.config?.[f.key] : !!f.default;
        box.appendChild(switchRow(f.label, f.help || "", on, (v) => { on = v; }));
        getters.push({ f, get: () => on });
        continue;
      }
      const input = document.createElement("input");
      input.style.cssText = `width:100%;box-sizing:border-box;${f.type === "secret" ? MONO_CSS : ""}`;
      if (f.type === "number") { input.type = "number"; if (f.min !== undefined) input.min = String(f.min); }
      if (f.type === "secret") {
        input.type = "password";
        input.autocomplete = "new-password"; // "off" is ignored for password fields
        input.placeholder = editing?.hasSecret?.[f.key] ? "•••• stored — leave blank to keep" : (f.required ? "required" : f.help || "");
      } else {
        input.value = editing?.config?.[f.key] ?? (f.default ?? "");
        input.placeholder = f.help || "";
      }
      box.appendChild(labeled(f.label, input));
      getters.push({ f, get: () => (f.type === "number" ? (input.value === "" ? undefined : Number(input.value)) : input.value.trim()) });
    }

    const collect = () => {
      const config = {};
      for (const { f, get } of getters) {
        const v = get();
        if (f.type === "secret") { if (v) config[f.key] = v; } // blank = keep the stored one
        else if (f.type === "toggle") config[f.key] = v;
        else if (v !== undefined && v !== "") config[f.key] = v;
      }
      return { label: labelIn.value.trim(), config };
    };

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;align-items:center;";
    const saveBtn = document.createElement("button");
    saveBtn.textContent = editing ? "Save changes" : "Add connection";
    saveBtn.onclick = busy(saveBtn, "Saving…", async () => {
      const { label, config } = collect();
      if (!label) { toast.error("Name required"); return; }
      try {
        if (editing) await api("PATCH", `/api/admin/source-connections/${editing.id}`, { label, config });
        else await api("POST", "/api/admin/source-connections", { type: p.name, label, config });
        toast(editing ? "Connection saved" : `"${label}" added`);
        reload();
      } catch (err) { toast.error(err.message); }
    });
    const testBtn = document.createElement("button");
    testBtn.className = "ghost";
    testBtn.textContent = "Test";
    testBtn.onclick = busy(testBtn, "Testing…", async () => {
      const { config } = collect();
      try {
        await api("POST", "/api/admin/source-connections/test", editing ? { id: editing.id, config } : { type: p.name, config });
        toast("✓ reachable");
      } catch (err) { toast.error(err.message); }
    });
    actions.append(saveBtn, testBtn);
    if (editing) {
      const cancel = document.createElement("button");
      cancel.className = "ghost";
      cancel.textContent = "Cancel";
      cancel.onclick = () => renderForm(null);
      actions.appendChild(cancel);
    }
    box.appendChild(actions);
    formHost.appendChild(box);
  }
  renderForm(null);

  // The add/edit form is rebuilt on demand and carries its own Save/Test/Cancel,
  // so there's nothing for the footer — it holds just Close.
  return sec;
}

// --- media: accepted extensions + the adjustable per-type upload limit ---

function mediaSection(p) {
  const sec = section("File types", null);
  const list = document.createElement("p");
  list.style.cssText = "margin:0;" + MONO_CSS;
  list.textContent = p.capabilities.extensions.map((e) => "." + e).join("  ");
  sec.appendChild(list);
  const note = document.createElement("p");
  note.className = "muted";
  note.style.margin = "0";
  note.textContent = "Core capability — always installed; it's how the app reads these file types.";
  sec.appendChild(note);

  // Per-type upload limit: the manifest default, overridable here. Shown in MB;
  // stored as bytes in the plugin config, which the server reads in mediaLimits.
  const MB = 1024 * 1024;
  const defaultMB = Math.round((p.capabilities.maxBytes || 0) / MB);
  const ceilingMB = Math.round((p.capabilities.ceilingBytes || 0) / MB);
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.style.cssText = "width:100%;box-sizing:border-box;";
  input.value = p.state.config.maxBytes != null ? String(Math.round(p.state.config.maxBytes / MB)) : "";
  input.placeholder = `${defaultMB} (default)`;
  sec.appendChild(labeled(
    `Max upload size (MB) <span style="color:#b6b6bd;font-weight:400;">· blank = default (${defaultMB} MB)${ceilingMB ? ` · server ceiling ${ceilingMB} MB` : ""}</span>`,
    input,
  ));

  // Autosaves on change; a bad value throws into the helper's revert path.
  autosave(input, async () => {
    const raw = input.value.trim();
    let maxBytes = null; // blank → clear the override (back to the manifest default)
    if (raw !== "") {
      const mbVal = Number(raw);
      if (!Number.isFinite(mbVal) || mbVal < 1) throw new Error("Enter at least 1 MB, or leave blank for the default");
      maxBytes = Math.round(mbVal * MB);
    }
    await api("PATCH", `/api/admin/plugins/${p.id}`, { config: { maxBytes } });
    p.state.config.maxBytes = maxBytes;
    // Quiet on success — except an over-ceiling override, which stores as-is
    // (it takes effect if the env ceiling is later raised) but is clamped by
    // the server in mediaLimits: say what actually applies rather than
    // silently accepting a bigger number.
    if (ceilingMB && maxBytes > p.capabilities.ceilingBytes)
      toast(`Uploads cap at the ${ceilingMB} MB server ceiling (UPLOAD_HARD_CEILING)`);
  });
  return sec;
}
