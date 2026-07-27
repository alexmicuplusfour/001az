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
import { fillModelSelect, attachLiveModels, switchRow } from "/board-modal.js";
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

// A slot's primary button, always labelled "Make default {slot}". When this
// provider isn't the default it's the enabled, primary promote action. When it
// already IS the default the button goes disabled + secondary — a status marker,
// not a dead "Save" — and re-enables only once you change the key or model, so
// you can still repoint the running default. `sels` are the selects to watch;
// `apply` runs the write.
function slotButton(label, isDefault, sels, apply) {
  const btn = document.createElement("button");
  btn.textContent = label;
  const initial = sels.map((s) => s.value);
  const sync = () => {
    const dirty = sels.some((s, i) => s.value !== initial[i]);
    const on = !isDefault || dirty;
    btn.disabled = !on;
    btn.className = on ? "" : "ghost";
  };
  sels.forEach((s) => s.addEventListener("change", sync));
  sync();
  btn.onclick = busy(btn, "Saving…", apply);
  return btn;
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
    ctx = { ...ctx, slots: state.slots, keys: state.keys, connections: state.connections, defaults: state.defaults };
    render();
    ctx.refresh(state); // repaint the cards behind, reusing the state we just fetched
  }

  // Builders return { node, footerActions }. footerActions is the modal-level
  // commit that belongs in the footer — present only for the single-form modals
  // (connector: Save+Test; media: Save). AI providers are a container of
  // independent slots, so each slot keeps its own action in its section and the
  // footer holds just Close; source connections likewise carry their actions in
  // their own add/edit form.
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
      if (p.configSchema.length) built.push(pacingSection(p, reload)); // rpm/burst — networked providers only
    } else if (p.kind === "source") {
      built.push(sourceSection(p, ctx, reload));
    } else {
      built.push(mediaSection(p, reload));
    }
    for (const b of built) body.appendChild(b.node);

    for (const b of built) for (const btn of b.footerActions || []) footer.appendChild(btn);

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
  const fields = [];
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
      let clear = false;
      if (p.state.hasKey) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "danger";
        rm.style.cssText = "margin-top:6px;padding:4px 10px;font-size:12px;";
        rm.textContent = "remove stored key";
        rm.onclick = () => {
          clear = !clear;
          rm.textContent = clear ? "will remove on save" : "remove stored key";
          input.disabled = clear;
        };
        row.appendChild(rm);
      }
      fields.push({ f, value: () => (clear ? "" : input.value.trim() || undefined) });
      sec.appendChild(row);
    } else if (f.type === "number") {
      const input = document.createElement("input");
      input.type = "number";
      if (f.min !== undefined) input.min = String(f.min);
      input.value = p.state.config[f.key] ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;";
      // empty = back to the plugin's default
      fields.push({ f, value: () => (input.value === "" ? null : Number(input.value)) });
      sec.appendChild(labeled(f.label + (f.help ? ` <span style="color:#b6b6bd;font-weight:400;">· ${f.help}</span>` : ""), input));
    } else if (f.type === "toggle") {
      let on = !!p.state.config[f.key];
      fields.push({ f, value: () => on });
      sec.appendChild(switchRow(f.label, f.help || "", on, (v) => { on = v; }));
    } else {
      const input = document.createElement("input");
      input.value = p.state.config[f.key] ?? "";
      input.style.cssText = "width:100%;box-sizing:border-box;";
      fields.push({ f, value: () => input.value.trim() || null });
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

  // Footer actions. Save commits the config; Test pings the provider with the
  // typed key (or its stored one), so it reflects the form without a Save first.
  const save = document.createElement("button");
  save.textContent = "Save";
  save.onclick = busy(save, "Saving…", async () => {
    const config = {};
    for (const { f, value } of fields) {
      const v = value();
      if (v !== undefined) config[f.key] = v; // undefined = leave stored secret alone
    }
    try {
      await api("PATCH", `/api/admin/plugins/${p.id}`, { config });
      toast(`${p.label} saved`);
      reload();
    } catch (err) { toast.error(err.message); }
  });

  const test = document.createElement("button");
  test.className = "ghost";
  test.textContent = "Test";
  test.onclick = busy(test, "Testing…", async () => {
    const typed = fields.find(({ f }) => f.type === "secret")?.value();
    try {
      const body = typed !== undefined ? { api_key: typed } : undefined;
      const { provider } = await api("POST", `/api/admin/plugins/${p.id}/test`, body);
      toast(`✓ ${provider} reachable`);
    } catch (err) { toast.error(err.message); }
  });

  return { node: sec, footerActions: [save, test] };
}

// --- ai: per-provider request pacing (rpm/burst) — mirrors the connector config ---
// Same number-field + Save shape as connectorSection, scoped to the rate-limit
// fields the ai plugin declares. On-device providers declare none, so the
// dispatch above skips this section for them; keyless-networked ones pace like
// any other. Empty input = back to the descriptor default.
function pacingSection(p, reload) {
  const sec = section(
    "Rate limit",
    "How fast the worker calls this provider's API, per key. Raise it to match your account tier; blank uses the default."
  );
  const fields = [];
  for (const f of p.configSchema) {
    const input = document.createElement("input");
    input.type = "number";
    if (f.min !== undefined) input.min = String(f.min);
    input.value = p.state.config[f.key] ?? "";
    input.placeholder = `default ${f.default}`;
    input.style.cssText = "width:100%;box-sizing:border-box;";
    fields.push({ f, value: () => (input.value === "" ? null : Number(input.value)) });
    sec.appendChild(labeled(f.label + (f.help ? ` <span style="color:#b6b6bd;font-weight:400;">· ${f.help}</span>` : ""), input));
  }
  const save = document.createElement("button");
  save.textContent = "Save";
  save.onclick = busy(save, "Saving…", async () => {
    const config = {};
    for (const { f, value } of fields) config[f.key] = value(); // null = clear the override, back to default
    try {
      await api("PATCH", `/api/admin/plugins/${p.id}`, { config });
      toast(`${p.label} rate limit saved`);
      reload();
    } catch (err) { toast.error(err.message); }
  });
  return { node: sec, footerActions: [save] };
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
  return { node: sec, footerActions: null };
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
    return { node: sec, footerActions: null };
  }

  const keySel = document.createElement("select");
  keySel.style.cssText = "width:100%;";
  for (const k of mine) {
    const opt = document.createElement("option");
    opt.value = String(k.id);
    opt.textContent = k.name;
    keySel.appendChild(opt);
  }
  if (envOption) {
    const opt = document.createElement("option");
    opt.value = "env";
    opt.textContent = "ANTHROPIC_API_KEY env var";
    keySel.appendChild(opt);
  }
  if (isDefault) keySel.value = ctx.slots.tagger.keyId ? String(ctx.slots.tagger.keyId) : "env";
  sec.appendChild(labeled(p.ai.keyless ? "Connection" : "Key", keySel));

  const modelSel = document.createElement("select");
  modelSel.style.cssText = "width:100%;";
  fillModelSelect(modelSel, p.ai, isDefault ? ctx.slots.tagger.model : null);
  // Live options follow the selected connection ("env" has no row to ask —
  // the curated list stands).
  const syncLive = () => attachLiveModels(modelSel, Number(keySel.value) || null);
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
  return { node: sec, footerActions: null };
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
    return { node: sec, footerActions: null };
  }

  let keySel = null;
  if (!p.ai.onDevice) {
    keySel = document.createElement("select");
    keySel.style.cssText = "width:100%;";
    for (const k of mine) {
      const opt = document.createElement("option");
      opt.value = String(k.id);
      opt.textContent = k.name;
      keySel.appendChild(opt);
    }
    if (active && em.keyId) keySel.value = String(em.keyId);
    if (mine.length > 1 || !active) sec.appendChild(labeled(p.ai.keyless ? "Connection" : "Key", keySel));
  }

  let modelSel = null;
  if (p.ai.embeds.models.length > 1 || !p.ai.onDevice) {
    modelSel = document.createElement("select");
    modelSel.style.cssText = "width:100%;";
    fillModelSelect(modelSel, { models: p.ai.embeds.models, defaultModel: p.ai.embeds.default }, active ? em.model : null);
    // Live options carved to embedders (descriptor embeds.filter) — on-device
    // providers have no connection row to ask.
    if (keySel) {
      const syncLive = () => attachLiveModels(modelSel, Number(keySel.value) || null, "embed");
      keySel.addEventListener("change", syncLive);
      syncLive();
    }
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
  return { node: sec, footerActions: null };
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
    return { node: sec, footerActions: null };
  }

  // Key picker (providers with connection rows — everything but on-device).
  let keySel = null;
  if (!p.ai.onDevice) {
    keySel = document.createElement("select");
    keySel.style.cssText = "width:100%;";
    for (const k of mine) {
      const opt = document.createElement("option");
      opt.value = String(k.id);
      opt.textContent = k.name;
      keySel.appendChild(opt);
    }
    if (active && tr.keyId) keySel.value = String(tr.keyId);
    if (mine.length > 1 || !active) sec.appendChild(labeled(p.ai.keyless ? "Connection" : "Key", keySel));
  }

  // Model picker — a provider gets a dropdown of its transcribes.models; the
  // on-device sidecar shows its single baked model as a note.
  let modelSel = null;
  if (!p.ai.onDevice && p.ai.transcribes.models.length > 1) {
    modelSel = document.createElement("select");
    modelSel.style.cssText = "width:100%;";
    fillModelSelect(modelSel, { models: p.ai.transcribes.models, defaultModel: p.ai.transcribes.default }, active ? tr.model : null);
    // Live options carved to transcription models (descriptor transcribes.filter).
    if (keySel) {
      const syncLive = () => attachLiveModels(modelSel, Number(keySel.value) || null, "transcribe");
      keySel.addEventListener("change", syncLive);
      syncLive();
    }
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

  if (actions.children.length) sec.appendChild(actions);
  return { node: sec, footerActions: null };
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
    return { node: sec, footerActions: null };
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
  return { node: sec, footerActions: null };
}

// --- media: accepted extensions + the adjustable per-type upload limit ---

function mediaSection(p, reload) {
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

  const save = document.createElement("button");
  save.textContent = "Save";
  save.onclick = busy(save, "Saving…", async () => {
    const raw = input.value.trim();
    let maxBytes = null; // blank → clear the override (back to the manifest default)
    if (raw !== "") {
      const mbVal = Number(raw);
      if (!Number.isFinite(mbVal) || mbVal < 1) return toast.error("Enter at least 1 MB, or leave blank for the default");
      maxBytes = Math.round(mbVal * MB);
    }
    try {
      await api("PATCH", `/api/admin/plugins/${p.id}`, { config: { maxBytes } });
      // An over-ceiling override stores as-is (it takes effect if the env
      // ceiling is later raised) but the server clamps it in mediaLimits —
      // say what actually applies rather than silently saving a bigger number.
      toast(ceilingMB && maxBytes > p.capabilities.ceilingBytes
        ? `${p.label} saved — uploads cap at the ${ceilingMB} MB server ceiling (UPLOAD_HARD_CEILING)`
        : `${p.label} saved`);
      reload();
    } catch (err) { toast.error(err.message); }
  });
  return { node: sec, footerActions: [save] };
}
